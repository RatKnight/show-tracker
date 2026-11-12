// Single-user password login with a signed, stateless session cookie.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

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

export function checkPassword(password, auth) {
  return Boolean(auth) && typeof password === 'string' && safeEqual(hashPassword(password, auth.salt).hash, auth.hash);
}

const sign = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');

export function sessionCookie(secret, secure, now = Date.now()) {
  const expires = String(now + SESSION_MS);
  return `${COOKIE}=${expires}.${sign(secret, expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function hasSession(cookieHeader, secret, now = Date.now()) {
  const match = /(?:^|;\s*)st_session=(\d+)\.([0-9a-f]+)/.exec(cookieHeader || '');
  if (!match) return false;
  return Number(match[1]) > now && safeEqual(match[2], sign(secret, match[1]));
}
