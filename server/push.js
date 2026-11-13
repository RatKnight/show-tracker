// Web Push: notifications delivered to an installed app or browser by the
// browser maker's push service (Google for Chrome on Android, Mozilla for
// Firefox, ...). No library: VAPID (RFC 8292) identifies this server, and the
// message itself is encrypted for the one device (RFC 8291), so the push
// service relays it without being able to read it.
import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import { request } from 'node:https';
import { publicLookup } from './notify.js';
import { tokenHash } from './auth.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// Subscriptions come from the browser, but the address inside one is still
// something a user hands us, so only the real push services are ever contacted.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /\.push\.apple\.com$/];

/** A subscription as sent by the browser, checked and reduced to what is stored; null if unusable. */
export function cleanSubscription(sub) {
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== 'https:' || url.port || url.username || !PUSH_HOSTS.some((h) => h.test(url.hostname)) || sub.endpoint.length > 1000) return null;
    const p256dh = fromB64u(sub.keys.p256dh);
    const auth = fromB64u(sub.keys.auth);
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null;
    return { id: tokenHash(url.href).slice(0, 16), endpoint: url.href, p256dh: b64u(p256dh), auth: b64u(auth) };
  } catch {
    return null;
  }
}

/** A fresh identity for this server: { publicKey (what browsers subscribe with), privateKey }. */
export function newVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** The Authorization header that proves to the push service who is sending. */
export function vapidHeader(endpoint, vapid, subject, now = Date.now()) {
  const part = (o) => b64u(JSON.stringify(o));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject })}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(vapid.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** Encrypt a message for one subscription ("aes128gcm" content encoding, a single record). */
export function encryptPayload(sub, plaintext) {
  const uaPublic = fromB64u(sub.p256dh);
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const ikm = Buffer.from(hkdfSync('sha256', shared, fromB64u(sub.auth), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // 0x02 marks the end of the last (here: only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** POST to a push service. Resolves with the HTTP status; never connects to a private address. */
function postPush(endpoint, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request(endpoint, { method: 'POST', lookup: publicLookup, timeout: 15000, headers: { ...headers, 'Content-Length': body.length } }, (res) => {
      res.resume();
      res.on('error', reject);
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('the push service did not answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}

/** What the notification shows. Kept well under the 4 KB a push message may carry. */
const notification = (m) => JSON.stringify({ title: String(m.title || 'Show Tracker').slice(0, 120), body: String(m.body || '').slice(0, 600), at: m.at || Date.now() });

/**
 * Sends alerts to the devices a user switched notifications on for.
 * `post` is replaceable for tests.
 */
export function createPusher({ store, subject, post = postPush, now = Date.now }) {
  const { data } = store;
  const keys = () => {
    if (!data.vapid) {
      data.vapid = newVapidKeys();
      store.save();
    }
    return data.vapid;
  };
  return {
    publicKey: () => keys().publicKey,
    /** Returns a list of error strings (empty when everything was delivered). */
    async send(u, messages) {
      const errors = [];
      if (!u.pushSubs.length || !messages.length) return errors;
      const gone = new Set();
      for (const sub of [...u.pushSubs]) {
        try {
          for (const m of messages) {
            const status = await post(sub.endpoint, { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Authorization: vapidHeader(sub.endpoint, keys(), subject, now()) }, encryptPayload(sub, notification(m)));
            // The browser dropped this subscription (app removed, permission withdrawn): forget it.
            if (status === 404 || status === 410) {
              gone.add(sub.id);
              break;
            }
            if (status < 200 || status >= 300) throw new Error(`the push service replied ${status}`);
          }
        } catch (e) {
          errors.push(`notifications on ${sub.name}: ${e.message}`);
        }
      }
      if (gone.size) {
        u.pushSubs = u.pushSubs.filter((s) => !gone.has(s.id));
        store.save();
      }
      return errors;
    },
  };
}
