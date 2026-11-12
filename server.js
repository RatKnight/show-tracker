// Show Tracker server: serves the web app, stores the list, checks schedules
// around the clock and sends alerts. No dependencies beyond Node itself.
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES, animeSeason } from './app/js/core.js';
import { openStore } from './server/store.js';
import { createTracker } from './server/tracker.js';
import { hashPassword, checkPassword, sessionCookie, clearCookie, hasSession, safeEqual } from './server/auth.js';
import { sendAlerts, validateChannels } from './server/notify.js';
import { buildIcs } from './server/ics.js';
import { validTimeZone } from './server/timing.js';
import * as liveSources from './server/sources.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'app');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
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

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Request too large.');
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

export function createApp({ dataDir, sources = liveSources, send = sendAlerts, now = Date.now } = {}) {
  const store = openStore(dataDir);
  const { data } = store;
  const tracker = createTracker({ store, sources, send, now });
  // Until a password exists, creating one needs this code from the server log,
  // so a stranger who finds the site first cannot claim it.
  const setupCode = data.auth ? null : String(randomInt(0, 1_000_000)).padStart(6, '0');

  // Failed password attempts, per client address and overall.
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

  const publicState = () => ({
    shows: data.shows,
    alerts: data.alerts,
    settings: data.settings,
    lastRefresh: data.lastRefresh,
    lastError: data.lastError,
    feedToken: data.feedToken,
    watched: data.watched,
    muted: data.muted,
  });

  /** Suggestions, minus anything now tracked or waved away. */
  const publicDiscover = () => {
    const hidden = new Set([...Object.keys(data.shows), ...data.dismissed]);
    const d = data.discover || { sequels: [], recs: [], updatedAt: 0 };
    return {
      sequels: d.sequels.filter((s) => !hidden.has(s.key)),
      recs: d.recs.filter((s) => !hidden.has(s.key)),
      updatedAt: d.updatedAt,
    };
  };
  const seasonCache = new Map();

  async function api(req, res, url) {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...securityHeaders(req), ...headers });
      res.end(JSON.stringify(body));
    };
    const route = `${req.method} ${url.pathname}`;
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const authed = hasSession(req.headers.cookie, data.secret, now());

    // Browsers send Origin on cross-site writes; refuse any that are not ours.
    if (req.method !== 'GET' && req.headers.origin) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (new URL(req.headers.origin).host !== host) throw new HttpError(403, 'Cross-site request refused.');
    }

    if (route === 'GET /api/session') return reply(200, { setup: Boolean(data.auth), authed });

    if (route === 'POST /api/setup') {
      if (data.auth) throw new HttpError(409, 'A password has already been set.');
      guardAttempts(req);
      const { password, code } = await readJson(req);
      if (!safeEqual(String(code ?? '').trim(), setupCode)) {
        noteFailure(req);
        throw new HttpError(403, 'Wrong setup code. It is printed in the server log.');
      }
      if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
      data.auth = hashPassword(password);
      store.save();
      return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie(data.secret, secure, now()) });
    }

    if (route === 'POST /api/login') {
      guardAttempts(req);
      const { password } = await readJson(req);
      if (!checkPassword(password, data.auth)) {
        noteFailure(req);
        throw new HttpError(401, 'Wrong password.');
      }
      return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie(data.secret, secure, now()) });
    }

    if (route === 'POST /api/logout') return reply(200, { ok: true }, { 'Set-Cookie': clearCookie() });

    if (!authed) throw new HttpError(401, 'Not signed in.');

    switch (route) {
      case 'GET /api/state':
        return reply(200, publicState());

      case 'GET /api/search': {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
        if (q.length < 2) return reply(200, []);
        const found = await (url.searchParams.get('source') === 'tv' ? sources.searchTv(q) : sources.searchAnime(q));
        return reply(200, found);
      }

      case 'POST /api/shows': {
        const { source, id } = await readJson(req);
        if (!['anilist', 'tvmaze'].includes(source) || !Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Unknown show.');
        await tracker.addShow(source, id);
        return reply(200, publicState());
      }

      case 'DELETE /api/shows':
        tracker.removeShow(url.searchParams.get('key'));
        return reply(200, publicState());

      case 'PUT /api/settings': {
        const body = await readJson(req);
        const cur = data.settings;
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
        };
        const problem = validateChannels(next);
        if (problem) throw new HttpError(400, problem);
        data.settings = next;
        store.save();
        return reply(200, publicState());
      }

      case 'POST /api/watched': {
        const { ids, watched } = await readJson(req);
        if (!Array.isArray(ids) || ids.length > 500 || !ids.every((i) => typeof i === 'string' && i.length <= 80)) throw new HttpError(400, 'Bad episode list.');
        const set = new Set(data.watched);
        for (const id of ids) watched === false ? set.delete(id) : set.add(id);
        data.watched = [...set].slice(-5000);
        store.save();
        return reply(200, publicState());
      }

      case 'POST /api/shows/mute': {
        const { key, muted } = await readJson(req);
        if (typeof key !== 'string' || !Object.hasOwn(data.shows, key)) throw new HttpError(400, 'Unknown show.');
        data.muted = muted === false ? data.muted.filter((k) => k !== key) : [...new Set([...data.muted, key])];
        store.save();
        return reply(200, publicState());
      }

      case 'POST /api/refresh':
        await tracker.refresh();
        return reply(200, publicState());

      case 'POST /api/alerts/read':
        for (const a of data.alerts) a.read = true;
        store.save();
        return reply(200, publicState());

      case 'DELETE /api/alerts':
        data.alerts = [];
        store.save();
        return reply(200, publicState());

      case 'GET /api/discover':
        if (!data.discover) await tracker.refreshDiscover({ silent: true });
        return reply(200, publicDiscover());

      case 'POST /api/discover/dismiss': {
        const { key } = await readJson(req);
        if (typeof key !== 'string' || !/^anilist:\d+$/.test(key)) throw new HttpError(400, 'Unknown show.');
        if (!data.dismissed.includes(key)) data.dismissed = [...data.dismissed, key].slice(-2000);
        store.save();
        return reply(200, publicDiscover());
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

      case 'POST /api/password': {
        guardAttempts(req);
        const { current, next } = await readJson(req);
        if (!checkPassword(current, data.auth)) {
          noteFailure(req);
          throw new HttpError(403, 'The current password is wrong.');
        }
        if (typeof next !== 'string' || next.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
        data.auth = hashPassword(next);
        // A new signing secret signs every other device out.
        data.secret = randomBytes(32).toString('hex');
        store.save();
        return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie(data.secret, secure, now()) });
      }

      case 'POST /api/sessions/revoke':
        data.secret = randomBytes(32).toString('hex');
        store.save();
        return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie(data.secret, secure, now()) });

      case 'POST /api/feed/rotate':
        data.feedToken = randomBytes(18).toString('hex');
        store.save();
        return reply(200, publicState());

      case 'POST /api/test-alert': {
        if (!data.settings.ntfyUrl && !data.settings.discordWebhook) throw new HttpError(400, 'Add an ntfy topic or Discord webhook first.');
        const errors = await send(data.settings, [{ title: 'Show Tracker', body: 'Test alert — delivery is working.', at: now() }]);
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
        if (!safeEqual(url.searchParams.get('token') || '', data.feedToken)) throw new HttpError(404, 'Not found.');
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(buildIcs(Object.values(data.shows), now()));
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
  const { server, tracker, setupCode } = createApp({ dataDir: process.env.DATA_DIR || join(process.cwd(), 'data') });
  if (setupCode) console.log(`No password set yet. Setup code for the first visit: ${setupCode}`);
  process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
  const tick = () => tracker.tick().catch((e) => console.error('Background check failed:', e.message));
  tick();
  setInterval(tick, 60 * 1000);
  // No host given: Node listens on IPv6 and IPv4 where IPv6 exists and on IPv4
  // alone otherwise, so health checks against `localhost` work either way.
  server.listen(port, () => console.log(`Show Tracker listening on port ${port}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
