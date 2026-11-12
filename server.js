// Show Tracker server: serves the web app, stores the list, checks schedules
// around the clock and sends alerts. No dependencies beyond Node itself.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES } from './app/js/core.js';
import { openStore } from './server/store.js';
import { createTracker } from './server/tracker.js';
import { hashPassword, checkPassword, sessionCookie, clearCookie, hasSession, safeEqual } from './server/auth.js';
import { sendAlerts, validateChannels } from './server/notify.js';
import { buildIcs } from './server/ics.js';
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
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

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
  const failedLogins = [];

  const publicState = () => ({
    shows: data.shows,
    alerts: data.alerts,
    settings: data.settings,
    lastRefresh: data.lastRefresh,
    lastError: data.lastError,
    feedToken: data.feedToken,
  });

  async function api(req, res, url) {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
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
      const { password } = await readJson(req);
      if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
      data.auth = hashPassword(password);
      store.save();
      return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie(data.secret, secure, now()) });
    }

    if (route === 'POST /api/login') {
      const cutoff = now() - 15 * 60 * 1000;
      while (failedLogins.length && failedLogins[0] < cutoff) failedLogins.shift();
      if (failedLogins.length >= 10) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
      const { password } = await readJson(req);
      if (!checkPassword(password, data.auth)) {
        failedLogins.push(now());
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
        const next = {
          services: Array.isArray(body.services) ? body.services.filter((s) => Object.hasOwn(SERVICES, s)) : data.settings.services,
          ntfyUrl: typeof body.ntfyUrl === 'string' ? body.ntfyUrl.trim() : data.settings.ntfyUrl,
          discordWebhook: typeof body.discordWebhook === 'string' ? body.discordWebhook.trim() : data.settings.discordWebhook,
        };
        const problem = validateChannels(next);
        if (problem) throw new HttpError(400, problem);
        data.settings = next;
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

      case 'POST /api/test-alert': {
        if (!data.settings.ntfyUrl && !data.settings.discordWebhook) throw new HttpError(400, 'Add an ntfy topic or Discord webhook first.');
        const errors = await send(data.settings, [{ title: 'Show Tracker', body: 'Test alert — delivery is working.', at: now() }]);
        if (errors.length) throw new HttpError(502, errors.join('; '));
        return reply(200, { ok: true });
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
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
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof URIError || e instanceof TypeError ? 400 : 502;
      if (!(e instanceof HttpError)) console.error(`${req.method} ${url.pathname}:`, e.message);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: e.message || 'Something went wrong.' }));
    }
  }

  return { server: createServer(handle), tracker, store };
}

// Run directly: `node server.js`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { server, tracker } = createApp({ dataDir: process.env.DATA_DIR || join(process.cwd(), 'data') });
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
