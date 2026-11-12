// Show Tracker server: serves the web app, stores the list, checks schedules
// around the clock and sends alerts. No dependencies beyond Node itself.
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES, animeSeason } from './app/js/core.js';
import { openStore, makeUser } from './server/store.js';
import { createTracker } from './server/tracker.js';
import { hashPassword, checkPassword, cleanUsername, newToken, tokenHash, sessionCookie, clearCookie, sessionUser, safeEqual } from './server/auth.js';
import { sendAlerts, sendDiscordFile, validateChannels } from './server/notify.js';
import { buildBackup, readBackup } from './server/backup.js';
import { buildIcs } from './server/ics.js';
import { validTimeZone } from './server/timing.js';
import { createMailer, cleanEmail } from './server/mail.js';
import * as liveSources from './server/sources.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'app');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const securityHeaders = (req) => ({
  ...SECURITY_HEADERS,
  ...(req.headers['x-forwarded-proto'] === 'https' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req, limit = 64 * 1024) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body && typeof body === 'object') return body;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, 'Invalid JSON.');
}

export function createApp({ dataDir, dataKey = '', sources = liveSources, send = sendAlerts, sendFile = sendDiscordFile, mailer = createMailer(), now = Date.now } = {}) {
  const store = openStore(dataDir, { dataKey });
  const { data } = store;
  const tracker = createTracker({ store, sources, send, sendFile, now });

  // Until the first account exists, creating it needs this code from the server
  // log, so a stranger who finds the site first cannot claim it.
  const setupCode = Object.keys(data.users).length ? null : String(randomInt(0, 1_000_000)).padStart(6, '0');

  // Failed password / code / link attempts, per client address and overall.
  const failures = new Map();
  const WINDOW = 15 * 60 * 1000;
  const recent = (key) => {
    const list = (failures.get(key) || []).filter((t) => t > now() - WINDOW);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  };
  const clientOf = (req) => {
    // Behind a reverse proxy the last X-Forwarded-For entry is the one it added.
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    return fwd || req.socket.remoteAddress || 'unknown';
  };
  /** Throws when this client (or everyone together) has guessed too often. */
  const guardAttempts = (req) => {
    if (recent(`ip:${clientOf(req)}`).length >= 8 || recent('all').length >= 200) {
      throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    }
  };
  const noteFailure = (req) => {
    for (const key of [`ip:${clientOf(req)}`, 'all']) failures.set(key, [...recent(key), now()]);
    if (failures.size > 5000) failures.clear();
  };

  // Mail sent per target (address or account), so nobody's inbox can be flooded.
  const mailLog = new Map();
  const mayMail = (key, max = 3) => {
    const list = (mailLog.get(key) || []).filter((t) => t > now() - 60 * 60 * 1000);
    if (list.length >= max) return false;
    mailLog.set(key, [...list, now()]);
    if (mailLog.size > 5000) mailLog.clear();
    return true;
  };
  const sendMail = (message) => mailer.send(message).catch((e) => console.error('Mail failed:', e.message));

  const DAY_MS = 24 * 60 * 60 * 1000;
  const users = () => Object.values(data.users);
  const findUser = (name) => users().find((u) => u.username.toLowerCase() === String(name).toLowerCase()) || null;
  const liveEntry = (bag, token) => {
    const entry = typeof token === 'string' && token ? bag[tokenHash(token)] : null;
    return entry && entry.expiresAt > now() ? entry : null;
  };
  const requirePassword = (password) => {
    if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
  };
  const requireUsername = (name, except) => {
    const clean = cleanUsername(name);
    if (!clean) throw new HttpError(400, 'Usernames are 3–24 letters, digits, “_” or “-”.');
    const taken = findUser(clean);
    if (taken && taken !== except) throw new HttpError(409, 'That username is taken.');
    return clean;
  };

  /** Everything the signed-in user's own browser may see. Never another user's data. */
  const publicState = (u) => ({
    me: { id: u.id, username: u.username, admin: u.admin, email: u.email, pendingEmail: u.pendingEmail?.expiresAt > now() ? u.pendingEmail.address : null },
    mail: mailer.enabled,
    shows: Object.fromEntries(tracker.showsOf(u).map((s) => [s.key, s])),
    alerts: u.alerts,
    settings: u.settings,
    lastRefresh: data.lastRefresh,
    lastError: u.lastError || data.lastError,
    feedToken: u.feedToken,
    shareToken: u.shareToken,
    watched: u.watched,
    muted: u.muted,
  });

  /** Suggestions, minus anything now tracked or waved away. */
  const publicDiscover = (u) => {
    const hidden = new Set([...Object.keys(u.shows), ...u.dismissed]);
    const d = u.discover || { sequels: [], recs: [], updatedAt: 0 };
    return {
      sequels: d.sequels.filter((s) => !hidden.has(s.key)),
      recs: d.recs.filter((s) => !hidden.has(s.key)),
      updatedAt: d.updatedAt,
    };
  };
  /** What an admin may know about the accounts: names and dates, never lists. */
  const adminView = () => ({
    encrypted: store.encrypted,
    mail: mailer.enabled,
    users: users()
      .map((x) => ({ id: x.id, username: x.username, admin: x.admin, createdAt: x.createdAt }))
      .sort((a, b) => a.createdAt - b.createdAt),
    pendingInvites: Object.values(data.invites).filter((i) => i.expiresAt > now()).length,
  });
  const seasonCache = new Map();

  async function api(req, res, url) {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...securityHeaders(req), ...headers });
      res.end(JSON.stringify(body));
    };
    const route = `${req.method} ${url.pathname}`;
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const u = sessionUser(req.headers.cookie, data, now());
    const signIn = (user) => ({ 'Set-Cookie': sessionCookie(data.secret, user, secure, now()) });

    // Browsers send Origin on cross-site writes; refuse any that are not ours.
    if (req.method !== 'GET' && req.headers.origin) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (new URL(req.headers.origin).host !== host) throw new HttpError(403, 'Cross-site request refused.');
    }

    // ---------------------------------------------------------- signed out

    if (route === 'GET /api/session') {
      return reply(200, { setup: users().length > 0, authed: Boolean(u), mail: mailer.enabled, me: u ? { id: u.id, username: u.username, admin: u.admin } : null });
    }

    if (route === 'POST /api/setup') {
      if (users().length) throw new HttpError(409, 'This site has already been set up.');
      guardAttempts(req);
      const { username, password, code } = await readJson(req);
      if (!safeEqual(String(code ?? '').trim(), setupCode)) {
        noteFailure(req);
        throw new HttpError(403, 'Wrong setup code. It is printed in the server log.');
      }
      requirePassword(password);
      const user = makeUser({ username: requireUsername(username), admin: true, auth: hashPassword(password), createdAt: now() });
      data.users[user.id] = user;
      store.save();
      return reply(200, { ok: true }, signIn(user));
    }

    if (route === 'POST /api/login') {
      guardAttempts(req);
      const { username, password } = await readJson(req);
      const user = findUser(username ?? '');
      if (!checkPassword(password, user?.auth)) {
        noteFailure(req);
        throw new HttpError(401, 'Wrong username or password.');
      }
      return reply(200, { ok: true }, signIn(user));
    }

    if (route === 'POST /api/logout') return reply(200, { ok: true }, { 'Set-Cookie': clearCookie() });

    // Invite and reset links: looking one up or using one counts against the
    // guess limit when it is wrong.
    if (route === 'GET /api/link') {
      guardAttempts(req);
      const token = url.searchParams.get('token');
      const kind = url.searchParams.get('kind');
      const entry = kind === 'invite' ? liveEntry(data.invites, token) : kind === 'reset' ? liveEntry(data.resets, token) : null;
      if (!entry) {
        noteFailure(req);
        throw new HttpError(404, 'This link is not valid any more. Ask for a new one.');
      }
      return reply(200, { kind, username: kind === 'reset' ? data.users[entry.userId]?.username : null });
    }

    if (route === 'POST /api/signup') {
      guardAttempts(req);
      const { token, username, password } = await readJson(req);
      if (!liveEntry(data.invites, token)) {
        noteFailure(req);
        throw new HttpError(404, 'This invite is not valid any more. Ask for a new one.');
      }
      requirePassword(password);
      const user = makeUser({ username: requireUsername(username), auth: hashPassword(password), createdAt: now() });
      data.users[user.id] = user;
      delete data.invites[tokenHash(token)];
      store.save();
      return reply(200, { ok: true }, signIn(user));
    }

    if (route === 'POST /api/reset') {
      guardAttempts(req);
      const { token, password } = await readJson(req);
      const entry = liveEntry(data.resets, token);
      const user = entry && data.users[entry.userId];
      if (!user) {
        noteFailure(req);
        throw new HttpError(404, 'This link is not valid any more. Ask for a new one.');
      }
      requirePassword(password);
      user.auth = hashPassword(password);
      user.sessionKey = randomBytes(16).toString('hex'); // signs every device out
      delete data.resets[tokenHash(token)];
      store.save();
      return reply(200, { ok: true }, signIn(user));
    }

    // "Forgot password": always the same answer, whether or not the account
    // exists or has an address on file. The mail goes out in the background so
    // the response time gives nothing away either.
    if (route === 'POST /api/forgot') {
      if (!mailer.enabled) throw new HttpError(404, 'Not found.');
      guardAttempts(req);
      noteFailure(req); // every request counts against this client's limit
      const { identifier } = await readJson(req);
      const wanted = String(identifier ?? '').trim().toLowerCase();
      const matches = wanted ? users().filter((x) => x.email && (x.username.toLowerCase() === wanted || x.email.toLowerCase() === wanted)) : [];
      for (const user of matches) {
        if (!mayMail(`reset:${user.id}`)) continue;
        const token = newToken();
        data.resets[tokenHash(token)] = { userId: user.id, expiresAt: now() + 30 * 60 * 1000 };
        sendMail({
          to: user.email,
          subject: 'Reset your Show Tracker password',
          text: `Hi ${user.username},\n\nSomeone asked to reset the password for your Show Tracker account. To choose a new one, open this link within 30 minutes:\n\n${mailer.link('reset', token)}\n\nIf that was not you, ignore this message; your password stays as it is.`,
        });
      }
      if (matches.length) store.save();
      return reply(200, { ok: true });
    }

    // Confirming an e-mail address from the link that was sent to it.
    if (route === 'POST /api/email/confirm') {
      guardAttempts(req);
      const { token } = await readJson(req);
      const hash = tokenHash(token ?? '');
      const owner = users().find((x) => x.pendingEmail && x.pendingEmail.expiresAt > now() && safeEqual(x.pendingEmail.hash, hash));
      if (!owner) {
        noteFailure(req);
        throw new HttpError(404, 'This confirmation link is not valid any more. Request a new one in Settings.');
      }
      owner.email = owner.pendingEmail.address;
      owner.pendingEmail = null;
      store.save();
      return reply(200, { ok: true, email: owner.email });
    }

    // A list its owner chose to share: titles and schedule only.
    if (route === 'GET /api/shared') {
      guardAttempts(req);
      const token = url.searchParams.get('token') || '';
      const owner = users().find((x) => x.shareToken && safeEqual(x.shareToken, token));
      if (!owner) {
        noteFailure(req);
        throw new HttpError(404, 'This shared list is not available.');
      }
      return reply(200, { username: owner.username, list: tracker.showsOf(owner).map(({ addedAt, ...show }) => show) });
    }

    if (!u) throw new HttpError(401, 'Not signed in.');

    // ---------------------------------------------------------- admin only

    if (url.pathname.startsWith('/api/admin/')) {
      if (!u.admin) throw new HttpError(403, 'Only an admin can do that.');
      switch (route) {
        case 'GET /api/admin/users':
          return reply(200, adminView());

        case 'POST /api/admin/invites': {
          const token = newToken();
          data.invites[tokenHash(token)] = { expiresAt: now() + 7 * DAY_MS };
          store.save();
          return reply(200, { token, ...adminView() });
        }

        case 'POST /api/admin/reset': {
          const { id } = await readJson(req);
          if (typeof id !== 'string' || !Object.hasOwn(data.users, id)) throw new HttpError(400, 'Unknown user.');
          const token = newToken();
          data.resets[tokenHash(token)] = { userId: id, expiresAt: now() + DAY_MS };
          store.save();
          return reply(200, { token });
        }

        case 'DELETE /api/admin/users': {
          const id = url.searchParams.get('id') || '';
          if (!Object.hasOwn(data.users, id)) throw new HttpError(400, 'Unknown user.');
          if (id === u.id) throw new HttpError(400, 'You cannot delete your own account here.');
          tracker.removeUser(id);
          return reply(200, adminView());
        }
      }
      throw new HttpError(404, 'Not found.');
    }

    // ---------------------------------------------------------- signed in

    switch (route) {
      case 'GET /api/state':
        return reply(200, publicState(u));

      case 'GET /api/search': {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
        if (q.length < 2) return reply(200, []);
        const found = await (url.searchParams.get('source') === 'tv' ? sources.searchTv(q) : sources.searchAnime(q));
        return reply(200, found);
      }

      case 'POST /api/shows': {
        const { source, id } = await readJson(req);
        if (!['anilist', 'tvmaze'].includes(source) || !Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Unknown show.');
        await tracker.addShow(u, source, id);
        return reply(200, publicState(u));
      }

      case 'DELETE /api/shows':
        tracker.removeShow(u, url.searchParams.get('key') || '');
        return reply(200, publicState(u));

      case 'PUT /api/settings': {
        const body = await readJson(req);
        const cur = u.settings;
        const hour = (v, fallback) => (v === null ? null : Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback);
        const next = {
          services: Array.isArray(body.services) ? body.services.filter((s) => Object.hasOwn(SERVICES, s)) : cur.services,
          ntfyUrl: typeof body.ntfyUrl === 'string' ? body.ntfyUrl.trim() : cur.ntfyUrl,
          discordWebhook: typeof body.discordWebhook === 'string' ? body.discordWebhook.trim() : cur.discordWebhook,
          alertMode: ['instant', 'digest'].includes(body.alertMode) ? body.alertMode : cur.alertMode,
          digestHour: hour(body.digestHour, cur.digestHour) ?? cur.digestHour,
          quietStart: 'quietStart' in body ? hour(body.quietStart, cur.quietStart) : cur.quietStart,
          quietEnd: 'quietEnd' in body ? hour(body.quietEnd, cur.quietEnd) : cur.quietEnd,
          remindMinutes: [0, 10, 30, 60].includes(body.remindMinutes) ? body.remindMinutes : cur.remindMinutes,
          timeZone: validTimeZone(body.timeZone) ? body.timeZone : cur.timeZone,
          backupToDiscord: typeof body.backupToDiscord === 'boolean' ? body.backupToDiscord : cur.backupToDiscord,
        };
        const problem = validateChannels(next);
        if (problem) throw new HttpError(400, problem);
        u.settings = next;
        u.lastError = null;
        store.save();
        return reply(200, publicState(u));
      }

      case 'POST /api/watched': {
        const { ids, watched } = await readJson(req);
        if (!Array.isArray(ids) || ids.length > 500 || !ids.every((i) => typeof i === 'string' && i.length <= 80)) throw new HttpError(400, 'Bad episode list.');
        const set = new Set(u.watched);
        for (const id of ids) watched === false ? set.delete(id) : set.add(id);
        u.watched = [...set].slice(-5000);
        store.save();
        return reply(200, publicState(u));
      }

      case 'POST /api/shows/mute': {
        const { key, muted } = await readJson(req);
        if (typeof key !== 'string' || !Object.hasOwn(u.shows, key)) throw new HttpError(400, 'Unknown show.');
        u.muted = muted === false ? u.muted.filter((k) => k !== key) : [...new Set([...u.muted, key])];
        store.save();
        return reply(200, publicState(u));
      }

      case 'GET /api/export': {
        const day = new Date(now()).toISOString().slice(0, 10);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="show-tracker-backup-${day}.json"`,
          'Cache-Control': 'no-store',
          ...securityHeaders(req),
        });
        return res.end(JSON.stringify(buildBackup(u, data.catalog, now()), null, 1));
      }

      case 'POST /api/import': {
        let backup;
        try {
          backup = readBackup(await readJson(req, 1024 * 1024));
        } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(400, e.message);
        }
        const added = await tracker.addMany(u, backup.shows);
        u.watched = [...new Set([...u.watched, ...backup.watched])].slice(-5000);
        u.muted = [...new Set([...u.muted, ...backup.muted])].filter((k) => Object.hasOwn(u.shows, k));
        u.dismissed = [...new Set([...u.dismissed, ...backup.dismissed])].slice(-2000);
        if (Array.isArray(backup.settings.services)) u.settings.services = backup.settings.services.filter((x) => Object.hasOwn(SERVICES, x));
        store.save();
        return reply(200, { ...publicState(u), added, skipped: backup.shows.length - added });
      }

      case 'POST /api/import/anilist': {
        const { username } = await readJson(req);
        if (typeof username !== 'string' || !/^[\w-]{2,30}$/.test(username.trim())) throw new HttpError(400, 'Enter an AniList username.');
        const ids = (await sources.fetchUserList(username.trim())).slice(0, 300);
        const added = await tracker.addMany(u, ids.map((id) => ({ source: 'anilist', id })));
        return reply(200, { ...publicState(u), added, skipped: ids.length - added });
      }

      case 'POST /api/refresh':
        await tracker.refresh();
        return reply(200, publicState(u));

      case 'POST /api/alerts/read':
        for (const a of u.alerts) a.read = true;
        store.save();
        return reply(200, publicState(u));

      case 'DELETE /api/alerts':
        u.alerts = [];
        store.save();
        return reply(200, publicState(u));

      case 'GET /api/discover':
        if (!u.discover) await tracker.refreshDiscover(u, { silent: true });
        return reply(200, publicDiscover(u));

      case 'POST /api/discover/dismiss': {
        const { key } = await readJson(req);
        if (typeof key !== 'string' || !/^anilist:\d+$/.test(key)) throw new HttpError(400, 'Unknown show.');
        if (!u.dismissed.includes(key)) u.dismissed = [...u.dismissed, key].slice(-2000);
        store.save();
        return reply(200, publicDiscover(u));
      }

      case 'GET /api/season': {
        const { season, year } = animeSeason(new Date(now()), url.searchParams.get('which') === 'next' ? 1 : 0);
        const id = `${season}-${year}`;
        let hit = seasonCache.get(id);
        if (!hit || now() - hit.at > 6 * 60 * 60 * 1000) {
          hit = { at: now(), shows: await sources.fetchSeason(season, year, now()) };
          seasonCache.set(id, hit);
        }
        return reply(200, { season, year, list: hit.shows });
      }

      case 'PUT /api/account': {
        const { username } = await readJson(req);
        u.username = requireUsername(username, u);
        store.save();
        return reply(200, publicState(u));
      }

      case 'PUT /api/account/email': {
        const { email } = await readJson(req);
        if (email === '' || email === null) {
          u.email = '';
          u.pendingEmail = null;
          store.save();
          return reply(200, publicState(u));
        }
        if (!mailer.enabled) throw new HttpError(400, 'E-mail is not set up on this site.');
        const address = cleanEmail(email);
        if (!address) throw new HttpError(400, 'That does not look like an e-mail address.');
        if (!mayMail(`confirm:${u.id}`, 5) || !mayMail(`to:${address.toLowerCase()}`)) throw new HttpError(429, 'Too many confirmation e-mails. Try again in an hour.');
        const token = newToken();
        u.pendingEmail = { address, hash: tokenHash(token), expiresAt: now() + DAY_MS };
        store.save();
        await mailer.send({
          to: address,
          subject: 'Confirm your e-mail for Show Tracker',
          text: `Hi ${u.username},\n\nTo use this address for password recovery on Show Tracker, open this link within 24 hours:\n\n${mailer.link('confirm', token)}\n\nIf you did not ask for this, ignore this message.`,
        }).catch((e) => {
          throw new HttpError(502, `Could not send the confirmation e-mail: ${e.message}`);
        });
        return reply(200, publicState(u));
      }

      case 'POST /api/password': {
        guardAttempts(req);
        const { current, next } = await readJson(req);
        if (!checkPassword(current, u.auth)) {
          noteFailure(req);
          throw new HttpError(403, 'The current password is wrong.');
        }
        requirePassword(next);
        u.auth = hashPassword(next);
        u.sessionKey = randomBytes(16).toString('hex'); // signs every other device out
        store.save();
        return reply(200, { ok: true }, signIn(u));
      }

      case 'POST /api/sessions/revoke':
        u.sessionKey = randomBytes(16).toString('hex');
        store.save();
        return reply(200, { ok: true }, signIn(u));

      case 'POST /api/feed/rotate':
        u.feedToken = randomBytes(18).toString('hex');
        store.save();
        return reply(200, publicState(u));

      case 'POST /api/share': {
        const { enabled } = await readJson(req);
        u.shareToken = enabled ? newToken() : null;
        store.save();
        return reply(200, publicState(u));
      }

      case 'POST /api/test-alert': {
        if (!u.settings.ntfyUrl && !u.settings.discordWebhook) throw new HttpError(400, 'Add an ntfy topic or Discord webhook first.');
        const errors = await send(u.settings, [{ title: 'Show Tracker', body: 'Test alert — delivery is working.', at: now() }]);
        if (errors.length) throw new HttpError(502, errors.join('; '));
        return reply(200, { ok: true });
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  async function handleRequest(req, res) {
    let url;
    try {
      // Parsed inside the try: a malformed request target must not take the server down.
      url = new URL(req.url, 'http://x');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      if (url.pathname === '/calendar.ics') {
        const token = url.searchParams.get('token') || '';
        const owner = Object.values(data.users).find((x) => safeEqual(x.feedToken, token));
        if (!owner) throw new HttpError(404, 'Not found.');
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(buildIcs(tracker.showsOf(owner), now()));
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT + sep)) throw new HttpError(404, 'Not found.');
      const body = await readFile(file).catch(() => {
        throw new HttpError(404, 'Not found.');
      });
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...securityHeaders(req) });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      const known = e instanceof HttpError;
      const status = known ? e.status : e instanceof URIError || e instanceof TypeError ? 400 : 502;
      if (!known) console.error(`${req.method} ${url?.pathname ?? '(unparseable)'}:`, e.message);
      // Upstream failures (502) carry a message worth showing; anything else unexpected stays generic.
      const message = known || status === 502 ? e.message : 'Bad request.';
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: message || 'Something went wrong.' }));
    }
  }

  // Last line of defence: whatever goes wrong in a request, the process stays up.
  const handle = (req, res) =>
    handleRequest(req, res).catch((e) => {
      console.error('Unhandled request error:', e.message);
      res.destroy();
    });

  return { server: createServer(handle), tracker, store, setupCode };
}

// Run directly: `node server.js`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const dataKey = process.env.DATA_KEY || '';
  const mailer = createMailer({ apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM, publicUrl: process.env.PUBLIC_URL });
  const { server, tracker, store, setupCode } = createApp({ dataDir: process.env.DATA_DIR || join(process.cwd(), 'data'), dataKey, mailer });
  console.log(mailer.enabled ? 'E-mail recovery is on.' : 'E-mail recovery is off (needs RESEND_API_KEY, MAIL_FROM and PUBLIC_URL).');
  console.log(store.encrypted ? 'Data is encrypted at rest.' : 'WARNING: DATA_KEY is not set, so data is stored unencrypted.');
  if (setupCode) console.log(`No account exists yet. Setup code for the first visit: ${setupCode}`);
  // Locked out as admin? Start once with RECOVER_ADMIN=yes to get a reset link.
  if (process.env.RECOVER_ADMIN === 'yes') {
    const admin = Object.values(store.data.users).find((u) => u.admin);
    if (admin) {
      const token = newToken();
      store.data.resets[tokenHash(token)] = { userId: admin.id, expiresAt: Date.now() + 60 * 60 * 1000 };
      store.save();
      console.log(`Admin password reset (valid 1 hour): open the site and add  /#reset=${token}  to its address. Then remove RECOVER_ADMIN.`);
    }
  }
  process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
  const tick = () => tracker.tick().catch((e) => console.error('Background check failed:', e.message));
  tick();
  setInterval(tick, 60 * 1000);
  // No host given: Node listens on IPv6 and IPv4 where IPv6 exists and on IPv4
  // alone otherwise, so health checks against `localhost` work either way.
  server.listen(port, () => console.log(`Show Tracker listening on port ${port}`));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
}
