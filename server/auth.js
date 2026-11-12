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
