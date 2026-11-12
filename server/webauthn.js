// Passkeys (WebAuthn), verified with Node's own crypto.
//
// Registration takes the public key in the SPKI form the browser hands over
// (AuthenticatorAttestationResponse.getPublicKey()), so no CBOR decoding is
// needed. No attestation is requested: the person adding a passkey is already
// signed in, and we only need to recognise that same key again later.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const from64 = (s) => Buffer.from(String(s ?? ''), 'base64url');
const sha256 = (data) => createHash('sha256').update(data).digest();

const ALGS = { '-7': 'ec', '-257': 'rsa' }; // ES256, RS256
const FLAG_USER_PRESENT = 0x01;
const FLAG_ATTESTED_DATA = 0x40;

export const newChallenge = () => b64u(randomBytes(32));

export function creationOptions({ rpId, rpName, user, challenge, exclude = [] }) {
  return {
    rp: { id: rpId, name: rpName },
    user: { id: b64u(Buffer.from(user.id)), name: user.username, displayName: user.username },
    challenge,
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    attestation: 'none',
    excludeCredentials: exclude.map((id) => ({ type: 'public-key', id })),
    timeout: 120000,
  };
}

export function requestOptions({ rpId, challenge, allow }) {
  return {
    rpId,
    challenge,
    allowCredentials: allow.map((c) => ({ type: 'public-key', id: c.id, ...(c.transports?.length ? { transports: c.transports } : {}) })),
    userVerification: 'preferred',
    timeout: 120000,
  };
}

/** Checks shared by registration and sign-in. Returns the parsed authenticator data. */
function checkCommon({ type, clientDataJSON, authenticatorData, challenge, origin, rpId }) {
  let client;
  try {
    client = JSON.parse(from64(clientDataJSON).toString('utf8'));
  } catch {
    throw new Error('Unreadable passkey response.');
  }
  if (client.type !== type) throw new Error('Wrong kind of passkey response.');
  if (typeof challenge !== 'string' || !challenge || client.challenge !== challenge) throw new Error('This passkey request has expired. Try again.');
  if (client.origin !== origin) throw new Error('The passkey was used on a different site address.');
  if (client.crossOrigin) throw new Error('Cross-site passkey use is not allowed.');

  const auth = from64(authenticatorData);
  if (auth.length < 37) throw new Error('Unreadable passkey response.');
  if (!auth.subarray(0, 32).equals(sha256(rpId))) throw new Error('The passkey belongs to a different site.');
  const flags = auth[32];
  if (!(flags & FLAG_USER_PRESENT)) throw new Error('The passkey did not confirm you were present.');
  return { auth, flags, signCount: auth.readUInt32BE(33) };
}

/**
 * Verify a new passkey. `response` carries base64url strings:
 * { id, clientDataJSON, authenticatorData, publicKey (SPKI), alg, transports }.
 * Returns the credential record to store.
 */
export function verifyRegistration({ response, challenge, origin, rpId }) {
  const r = response || {};
  const { auth, flags, signCount } = checkCommon({ type: 'webauthn.create', clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, challenge, origin, rpId });
  if (!(flags & FLAG_ATTESTED_DATA) || auth.length < 55) throw new Error('The passkey response has no credential in it.');
  const idLength = auth.readUInt16BE(53);
  const id = auth.subarray(55, 55 + idLength);
  if (!idLength || id.length !== idLength || typeof r.id !== 'string' || b64u(id) !== r.id) throw new Error('The passkey response does not match its credential.');

  const kind = ALGS[String(r.alg)];
  if (!kind) throw new Error('This passkey uses a signature type that is not supported.');
  let key;
  try {
    key = createPublicKey({ key: from64(r.publicKey), format: 'der', type: 'spki' });
  } catch {
    throw new Error('Unreadable passkey public key.');
  }
  if (key.asymmetricKeyType !== kind || (kind === 'ec' && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')) throw new Error('The passkey public key does not match its signature type.');

  return {
    id: r.id,
    publicKey: b64u(key.export({ format: 'der', type: 'spki' })),
    alg: Number(r.alg),
    signCount,
    transports: Array.isArray(r.transports) ? r.transports.filter((t) => typeof t === 'string' && t.length <= 20).slice(0, 6) : [],
  };
}

/**
 * Verify a sign-in with a stored passkey. `response` carries base64url strings:
 * { id, clientDataJSON, authenticatorData, signature }. Returns the new counter.
 */
export function verifyAssertion({ response, challenge, origin, rpId, credential }) {
  const r = response || {};
  const { auth, signCount } = checkCommon({ type: 'webauthn.get', clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, challenge, origin, rpId });
  const signed = Buffer.concat([auth, sha256(from64(r.clientDataJSON))]);
  const key = createPublicKey({ key: from64(credential.publicKey), format: 'der', type: 'spki' });
  let ok = false;
  try {
    ok = verify('sha256', signed, key, from64(r.signature));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('The passkey signature is not valid.');
  // A counter that goes backwards means the passkey may have been copied.
  if ((signCount || credential.signCount) && signCount <= credential.signCount) throw new Error('This passkey looks like a copy and was refused.');
  return { signCount };
}
