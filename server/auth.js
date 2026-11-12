// Passwords, sessions and one-time links.
import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';

const COOKIE = 'st_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Checked against when the username does not exist, so a wrong username takes as
// long to reject as a wrong password.
const DUMMY = hashPassword('not a real account');

export function checkPassword(password, auth) {
  const target = auth || DUMMY;
  const ok = typeof password === 'string' && safeEqual(hashPassword(password, target.salt).hash, target.hash);
  return ok && Boolean(auth);
}

/** Usernames: 3-24 letters, digits, _ or -. Returns the trimmed name or null. */
export function cleanUsername(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  return /^[A-Za-z0-9_-]{3,24}$/.test(n) ? n : null;
}

/** A random one-time token for invite, reset and share links. */
export const newToken = () => randomBytes(24).toString('base64url');
/** Only the hash of a one-time token is stored. */
export const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');

const sign = (secret, user, value) => createHmac('sha256', `${secret}:${user.sessionKey}`).update(value).digest('hex');

export function sessionCookie(secret, user, secure, now = Date.now()) {
  const value = `${user.id}.${now + SESSION_MS}`;
  return `${COOKIE}=${value}.${sign(secret, user, value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** The signed-in user for a Cookie header, or null. */
export function sessionUser(cookieHeader, data, now = Date.now()) {
  const match = /(?:^|;\s*)st_session=(u[0-9a-f]+)\.(\d+)\.([0-9a-f]+)/.exec(cookieHeader || '');
  if (!match) return null;
  const [, id, expires, mac] = match;
  const user = Object.hasOwn(data.users, id) ? data.users[id] : null;
  if (!user || Number(expires) <= now) return null;
  return safeEqual(mac, sign(data.secret, user, `${id}.${expires}`)) ? user : null;
}

// ---- second step of sign-in
//
// After a correct password, an account with passkeys gets this short-lived
// cookie instead of a session. It only proves "the password was right" and is
// accepted solely by the routes that complete the second step.

const PENDING = 'st_pending';
const PENDING_MS = 5 * 60 * 1000;

export function pendingCookie(secret, user, secure, now = Date.now()) {
  const value = `${user.id}.${now + PENDING_MS}`;
  const mac = createHmac('sha256', `${secret}:pending:${user.sessionKey}`).update(value).digest('hex');
  return `${PENDING}=${value}.${mac}; Path=/api/login; HttpOnly; SameSite=Strict; Max-Age=${PENDING_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearPendingCookie() {
  return `${PENDING}=; Path=/api/login; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function pendingUser(cookieHeader, data, now = Date.now()) {
  const match = /(?:^|;\s*)st_pending=(u[0-9a-f]+)\.(\d+)\.([0-9a-f]+)/.exec(cookieHeader || '');
  if (!match) return null;
  const [, id, expires, mac] = match;
  const user = Object.hasOwn(data.users, id) ? data.users[id] : null;
  if (!user || Number(expires) <= now) return null;
  const want = createHmac('sha256', `${data.secret}:pending:${user.sessionKey}`).update(`${id}.${expires}`).digest('hex');
  return safeEqual(mac, want) ? user : null;
}

/** Ten one-time recovery codes, as shown to the user: xxxxx-xxxxx. */
export function newRecoveryCodes() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes
  return Array.from({ length: 10 }, () => {
    const chars = Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}
/** Codes are compared without regard to case, spaces or the dash. */
export const recoveryHash = (code) => tokenHash(String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''));

// ---- admin unlock
//
// Being signed in is not enough to open the admin pages: the admin confirms
// with their passkey once per browser session. That confirmation is this
// cookie, tied to the sign-in session it was given to, and gone when the
// browser closes (or after 12 hours).

const ADMIN = 'st_admin';
const ADMIN_MS = 12 * 60 * 60 * 1000;
const sessionValue = (cookieHeader) => (/(?:^|;\s*)st_session=([\w.]+)/.exec(cookieHeader || '') || [])[1] || '';
const adminMac = (secret, user, session, expires) => createHmac('sha256', `${secret}:admin:${user.sessionKey}`).update(`${session}|${expires}`).digest('hex');

export function adminCookie(secret, user, cookieHeader, secure, now = Date.now()) {
  const expires = now + ADMIN_MS;
  return `${ADMIN}=${expires}.${adminMac(secret, user, sessionValue(cookieHeader), expires)}; Path=/api/admin; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearAdminCookie() {
  return `${ADMIN}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Has this sign-in session been confirmed for admin work? */
export function adminUnlocked(cookieHeader, secret, user, now = Date.now()) {
  const match = /(?:^|;\s*)st_admin=(\d+)\.([0-9a-f]+)/.exec(cookieHeader || '');
  const session = sessionValue(cookieHeader);
  if (!match || !session || Number(match[1]) <= now) return false;
  return safeEqual(match[2], adminMac(secret, user, session, match[1]));
}
