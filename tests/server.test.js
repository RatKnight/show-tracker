import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { openStore } from '../server/store.js';
import { createTracker } from '../server/tracker.js';
import { buildIcs } from '../server/ics.js';
import { computeDiscover } from '../server/discover.js';
import { localClock, inQuietHours, summarize } from '../server/timing.js';
import { buildBackup, readBackup, writeSnapshot } from '../server/backup.js';
import { validateChannels, parseNtfy, ntfyPayloads, discordPayloads } from '../server/notify.js';
import { hashPassword, checkPassword, sessionCookie, hasSession } from '../server/auth.js';
import { DAY } from '../app/js/core.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'show-tracker-'));

function fakeShow(id, clock, extra = {}) {
  return {
    key: `anilist:${id}`,
    source: 'anilist',
    id,
    kind: 'Anime',
    title: `Show ${id}`,
    image: null,
    url: `https://anilist.co/anime/${id}`,
    status: 'Airing',
    streams: [{ id: 'crunchyroll', name: 'Crunchyroll', url: 'https://crunchyroll.com/x' }],
    episodes: [
      { id: `anilist:${id}:1`, label: 'Episode 1', airsAt: clock.t - DAY },
      { id: `anilist:${id}:2`, label: 'Episode 2', airsAt: clock.t + 60_000 },
    ],
    ...extra,
  };
}

function fakeSources(clock) {
  return {
    calls: 0,
    fail: false,
    async fetchAnime(ids) {
      this.calls++;
      if (this.fail) throw new Error('AniList down');
      return ids.map((id) => fakeShow(id, clock));
    },
    async fetchTv() {
      return null;
    },
    async searchAnime(q) {
      return [fakeShow(7, clock, { title: q })];
    },
    async searchTv() {
      return [];
    },
    related: new Map(),
    async fetchRelated(ids) {
      return new Map(ids.map((id) => [id, this.related.get(id) || { sequels: [], recs: [] }]));
    },
    lists: { someone: [5, 6, 7] },
    async fetchUserList(name) {
      if (!this.lists[name]) throw new Error(`No public AniList profile called “${name}” was found.`);
      return this.lists[name];
    },
    async fetchSeason(season, year) {
      return [fakeShow(900, clock, { title: `${season} ${year}` })];
    },
  };
}

const media = (id, title, status = 'FINISHED', extra = {}) => ({
  id,
  type: 'ANIME',
  format: 'TV',
  status,
  title: { english: title, romaji: title },
  startDate: { year: 2027, month: 4, day: null },
  externalLinks: [],
  ...extra,
});

test('tracker alerts once per episode, only for episodes aired after adding', async () => {
  const clock = { t: Date.UTC(2026, 10, 12) };
  const start = clock.t;
  const sent = [];
  const store = openStore(tmp());
  const sources = fakeSources(clock);
  // Episode times stay fixed even as the clock advances.
  sources.fetchAnime = async (ids) => ids.map((id) => fakeShow(id, { t: start }));
  const tracker = createTracker({ store, sources, send: async (_s, m) => (sent.push(...m), []), now: () => clock.t });

  await tracker.addShow('anilist', 5);
  await tracker.tick();
  assert.equal(sent.length, 0, 'episode 1 aired before the show was added');

  clock.t += 2 * 60_000;
  await tracker.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Show 5');
  assert.equal(sent[0].body, 'Episode 2 is out on Crunchyroll');
  assert.equal(store.data.alerts.length, 1);
  assert.equal(store.data.alerts[0].read, false);

  await tracker.tick();
  await tracker.refresh();
  assert.equal(sent.length, 1, 'no duplicate alert');
});

test('tracker records refresh failures and backs off', async () => {
  const clock = { t: Date.UTC(2026, 10, 12) };
  const store = openStore(tmp());
  const sources = fakeSources(clock);
  const start = clock.t;
  const live = async (ids) => {
    sources.calls++;
    if (sources.fail) throw new Error('AniList down');
    return ids.map((id) => fakeShow(id, { t: start }));
  };
  sources.fetchAnime = live;
  const tracker = createTracker({ store, sources, send: async () => ['ntfy: replied 500'], now: () => clock.t });
  await tracker.addShow('anilist', 5);
  sources.fail = true;
  sources.calls = 0;
  await tracker.tick();
  assert.match(store.data.lastError, /AniList down/);
  assert.equal(Object.keys(store.data.shows).length, 1, 'existing data is kept');
  await tracker.tick();
  assert.equal(sources.calls, 1, 'does not retry every minute');
  clock.t += 6 * 60_000;
  sources.fail = false;
  await tracker.tick();
  assert.equal(sources.calls, 2);
  assert.match(store.data.lastError, /Alert delivery failed/, 'delivery failure is surfaced');
});

test('store persists to disk and refuses a corrupt file', () => {
  const dir = tmp();
  const a = openStore(dir);
  a.data.shows.x = { key: 'x' };
  a.save();
  const b = openStore(dir);
  assert.deepEqual(b.data.shows, { x: { key: 'x' } });
  assert.equal(b.data.secret, a.data.secret);
  assert.throws(() => openStore(join(dir, 'state.json')), /Cannot read|ENOTDIR|EEXIST/);
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600, 'state file is owner-only');
});

test('auth helpers', () => {
  const auth = hashPassword('correct horse');
  assert.ok(checkPassword('correct horse', auth));
  assert.ok(!checkPassword('wrong', auth));
  assert.ok(!checkPassword('anything', null));
  const cookie = sessionCookie('secret', true, 1000).split(';')[0];
  assert.ok(hasSession(cookie, 'secret', 2000));
  assert.ok(!hasSession(cookie, 'other-secret', 2000));
  assert.ok(!hasSession(cookie, 'secret', 1000 + 31 * DAY), 'expired');
  assert.ok(!hasSession(cookie.replace(/\d+\./, '99999999999999.'), 'secret', 2000), 'tampered expiry');
});

test('channel validation and payloads', () => {
  assert.equal(validateChannels({ ntfyUrl: '', discordWebhook: '' }), null);
  assert.equal(validateChannels({ ntfyUrl: 'https://ntfy.sh/my-topic_1', discordWebhook: 'https://discord.com/api/webhooks/123/abc-DEF_1' }), null);
  assert.match(validateChannels({ ntfyUrl: 'http://ntfy.sh/topic' }), /ntfy/);
  assert.match(validateChannels({ ntfyUrl: 'https://ntfy.sh/' }), /ntfy/);
  assert.match(validateChannels({ discordWebhook: 'https://evil.example/api/webhooks/1/x' }), /Discord/);
  assert.deepEqual(parseNtfy('https://ntfy.example.com/shows/'), { server: 'https://ntfy.example.com', topic: 'shows' });

  const msgs = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, body: 'b', url: 'https://x', image: null, at: 0 }));
  assert.equal(ntfyPayloads('https://ntfy.sh/t', msgs)[0].topic, 't');
  const d = discordPayloads(msgs);
  assert.deepEqual(d.map((p) => p.embeds.length), [10, 2]);
});

test('ics feed', () => {
  const clock = { t: Date.UTC(2026, 10, 12, 15, 0) };
  const show = fakeShow(1, clock, { title: 'A, very; long title '.repeat(6) });
  show.episodes.push({ id: 'anilist:1:9', label: 'Premiere', airsAt: new Date(2027, 0, 9).getTime(), dateOnly: true });
  const ics = buildIcs([show], clock.t);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 3);
  assert.ok(ics.includes('DTSTART:20261111T150000Z'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20270109'));
  assert.ok(ics.includes(String.raw`SUMMARY:A\, very\; long`));
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
});

test('http api: setup, login, add, settings, feed', async (t) => {
  const clock = { t: Date.now() };
  const dir = tmp();
  const sent = [];
  const fake = fakeSources(clock);
  const { related } = fake;
  const { server, setupCode, tracker } = createApp({ dataDir: dir, sources: fake, send: async (_s, m) => (sent.push(...m), []) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };

  assert.equal((await req('GET', '/healthz')).body, 'ok');
  assert.equal((await req('GET', '/')).status, 200);
  assert.equal((await req('GET', '/../server.js')).status, 404);
  assert.equal((await req('GET', '/%2e%2e/package.json')).status, 404);
  assert.deepEqual((await req('GET', '/api/session')).body, { setup: false, authed: false });
  assert.equal((await req('GET', '/api/state')).status, 401);
  assert.equal((await req('POST', '/api/shows', { source: 'anilist', id: 5 })).status, 401);

  assert.match(setupCode, /^\d{6}$/);
  assert.equal((await req('POST', '/api/setup', { password: 'long enough pw' })).status, 403, 'no setup code');
  assert.equal((await req('POST', '/api/setup', { password: 'long enough pw', code: '' })).status, 403);
  assert.equal((await req('POST', '/api/setup', { password: 'short', code: setupCode })).status, 400);
  assert.equal((await req('POST', '/api/setup', { password: 'long enough pw', code: setupCode })).status, 200);
  assert.equal((await req('POST', '/api/setup', { password: 'another password', code: setupCode })).status, 409);
  assert.deepEqual((await req('GET', '/api/session')).body, { setup: true, authed: true });

  cookie = '';
  assert.equal((await req('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await req('GET', '/api/state')).status, 401);
  assert.equal((await req('POST', '/api/login', { password: 'long enough pw' })).status, 200);

  assert.equal((await req('POST', '/api/shows', { source: 'anilist', id: 5 }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await req('POST', '/api/shows', { source: 'nope', id: 5 })).status, 400);
  const added = await req('POST', '/api/shows', { source: 'anilist', id: 5 });
  assert.equal(added.status, 200);
  assert.deepEqual(Object.keys(added.body.shows), ['anilist:5']);
  assert.equal(added.body.auth, undefined, 'password hash is never sent');
  assert.equal(added.body.secret, undefined);

  assert.equal((await req('GET', '/api/search?source=anime&q=frieren')).body[0].title, 'frieren');

  const season = await req('GET', '/api/season?which=next');
  assert.match(season.body.season, /^(WINTER|SPRING|SUMMER|FALL)$/);
  assert.equal(season.body.list.length, 1);
  related.set(5, { sequels: [media(60, 'Five S2', 'RELEASING')], recs: [{ rating: 5, media: media(61, 'Rec') }] });
  await tracker.refreshDiscover({ silent: true });
  let disc = await req('GET', '/api/discover');
  assert.deepEqual([disc.body.sequels.map((x) => x.key), disc.body.recs.map((x) => x.key)], [['anilist:60'], ['anilist:61']]);
  assert.equal((await req('POST', '/api/discover/dismiss', { key: '../x' })).status, 400);
  disc = await req('POST', '/api/discover/dismiss', { key: 'anilist:61' });
  assert.deepEqual(disc.body.recs, []);

  assert.equal((await req('PUT', '/api/settings', { discordWebhook: 'https://example.com/hook' })).status, 400);
  assert.equal((await req('POST', '/api/test-alert')).status, 400);
  const saved = await req('PUT', '/api/settings', { services: ['hidive', 'bogus'], ntfyUrl: 'https://ntfy.sh/topic-abc' });
  assert.deepEqual(
    [saved.body.settings.services, saved.body.settings.ntfyUrl, saved.body.settings.discordWebhook],
    [['hidive'], 'https://ntfy.sh/topic-abc', ''],
  );
  const tuned = await req('PUT', '/api/settings', { alertMode: 'digest', digestHour: 7, quietStart: 22, quietEnd: 99, remindMinutes: 30, timeZone: 'America/Chicago' });
  assert.deepEqual(
    [tuned.body.settings.alertMode, tuned.body.settings.digestHour, tuned.body.settings.quietStart, tuned.body.settings.quietEnd, tuned.body.settings.remindMinutes, tuned.body.settings.timeZone],
    ['digest', 7, 22, null, 30, 'America/Chicago'],
  );
  assert.equal((await req('PUT', '/api/settings', { timeZone: 'Not/AZone', remindMinutes: 7, alertMode: 'x' })).body.settings.timeZone, 'America/Chicago');
  await req('PUT', '/api/settings', { alertMode: 'instant', quietStart: null, quietEnd: null });

  let st = await req('POST', '/api/watched', { ids: ['anilist:5:1', 'anilist:5:2'] });
  assert.deepEqual(st.body.watched, ['anilist:5:1', 'anilist:5:2']);
  st = await req('POST', '/api/watched', { ids: ['anilist:5:1'], watched: false });
  assert.deepEqual(st.body.watched, ['anilist:5:2']);
  assert.equal((await req('POST', '/api/watched', { ids: 'nope' })).status, 400);
  assert.deepEqual((await req('POST', '/api/shows/mute', { key: 'anilist:5' })).body.muted, ['anilist:5']);
  assert.equal((await req('POST', '/api/shows/mute', { key: 'anilist:404' })).status, 400);
  assert.deepEqual((await req('POST', '/api/shows/mute', { key: 'anilist:5', muted: false })).body.muted, []);
  assert.equal((await req('POST', '/api/test-alert')).status, 200);
  assert.equal(sent.length, 1);

  assert.equal((await req('GET', '/calendar.ics')).status, 404);
  assert.equal((await req('GET', '/calendar.ics?token=wrong')).status, 404);
  const feed = await req('GET', `/calendar.ics?token=${saved.body.feedToken}`);
  assert.equal(feed.status, 200);
  assert.match(feed.body, /SUMMARY:Show 5 – Episode 2/);

  assert.deepEqual((await req('DELETE', '/api/shows?key=anilist:5')).body.shows, {});
  assert.ok(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).auth.hash, 'state persisted');

  // Import a profile's list, export, wipe, and restore from the export.
  assert.equal((await req('POST', '/api/import/anilist', { username: 'x' })).status, 400);
  assert.equal((await req('POST', '/api/import/anilist', { username: 'nobody' })).status, 502);
  const imported = await req('POST', '/api/import/anilist', { username: 'someone' });
  assert.deepEqual([imported.body.added, imported.body.skipped, Object.keys(imported.body.shows).length], [3, 0, 3]);
  assert.equal((await req('POST', '/api/import/anilist', { username: 'someone' })).body.added, 0);
  await req('POST', '/api/watched', { ids: ['anilist:6:1'] });
  const exported = await req('GET', '/api/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.shows.length, 3);
  assert.ok(!JSON.stringify(exported.body).includes('topic-abc'), 'alert addresses are not exported');
  for (const k of ['anilist:5', 'anilist:6', 'anilist:7']) await req('DELETE', `/api/shows?key=${k}`);
  assert.equal((await req('POST', '/api/import', { app: 'nope' })).status, 400);
  const restored = await req('POST', '/api/import', exported.body);
  assert.deepEqual([restored.body.added, Object.keys(restored.body.shows).sort()], [3, ['anilist:5', 'anilist:6', 'anilist:7']]);
  assert.equal(restored.body.shows['anilist:6'].addedAt, exported.body.shows.find((x) => x.id === 6).addedAt, 'original add time is kept');
  for (const k of ['anilist:5', 'anilist:6', 'anilist:7']) await req('DELETE', `/api/shows?key=${k}`);

  assert.match((await fetch(base + '/manifest.webmanifest')).headers.get('content-type'), /manifest\+json/);
  assert.equal((await fetch(base + '/icon-192.png')).headers.get('content-type'), 'image/png');

  // Rotating the feed address kills the old one.
  const rotated = await req('POST', '/api/feed/rotate');
  assert.notEqual(rotated.body.feedToken, saved.body.feedToken);
  assert.equal((await req('GET', `/calendar.ics?token=${saved.body.feedToken}`)).status, 404);

  // Changing the password signs other sessions out and the old password stops working.
  const oldCookie = cookie;
  assert.equal((await req('POST', '/api/password', { current: 'nope', next: 'brand new password' })).status, 403);
  assert.equal((await req('POST', '/api/password', { current: 'long enough pw', next: 'short' })).status, 400);
  assert.equal((await req('POST', '/api/password', { current: 'long enough pw', next: 'brand new password' })).status, 200);
  assert.equal((await req('GET', '/api/state')).status, 200, 'this session continues');
  const kept = cookie;
  cookie = oldCookie;
  assert.equal((await req('GET', '/api/state')).status, 401, 'old session is revoked');
  cookie = '';
  assert.equal((await req('POST', '/api/login', { password: 'long enough pw' })).status, 401);
  cookie = kept;

  await req('POST', '/api/logout');
  assert.equal((await req('GET', '/api/state')).status, 401);
});

test('http hardening: malformed requests do not crash, guesses are limited', async (t) => {
  const dir = tmp();
  const { server, setupCode } = createApp({ dataDir: dir, sources: fakeSources({ t: Date.now() }), send: async () => [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // A raw request target that the URL parser rejects used to kill the process.
  const { connect } = await import('node:net');
  const raw = (line) =>
    new Promise((resolve) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`));
      let out = '';
      sock.on('data', (d) => (out += d));
      sock.on('close', () => resolve(out));
      sock.on('error', () => resolve(out));
    });
  assert.match(await raw('GET // HTTP/1.1'), /^HTTP\/1\.1 400/);
  assert.match(await raw('GET /%E0%A4%A HTTP/1.1'), /^HTTP\/1\.1 400/);
  assert.equal((await fetch(`${base}/healthz`)).status, 200, 'still alive');

  const page = await fetch(base + '/', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');

  const post = (path, body, ip) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) });

  // Setup-code guessing is limited per client address.
  for (let i = 0; i < 8; i++) assert.equal((await post('/api/setup', { password: 'long enough pw', code: 'x' }, '203.0.113.1')).status, 403);
  assert.equal((await post('/api/setup', { password: 'long enough pw', code: setupCode }, '203.0.113.1')).status, 429);
  assert.equal((await post('/api/setup', { password: 'long enough pw', code: setupCode }, '203.0.113.2')).status, 200);

  // So is password guessing, without locking out other addresses.
  for (let i = 0; i < 8; i++) assert.equal((await post('/api/login', { password: 'wrong' }, '203.0.113.3')).status, 401);
  assert.equal((await post('/api/login', { password: 'long enough pw' }, '203.0.113.3')).status, 429);
  assert.equal((await post('/api/login', { password: 'long enough pw' }, '203.0.113.4')).status, 200);
});

test('discover follows sequel chains and ranks recommendations', async () => {
  const clock = { t: Date.UTC(2026, 10, 12) };
  const sources = fakeSources(clock);
  // Tracked: 1 and 2. Chain: 1 -> 10 (finished) -> 11 (upcoming). 2 -> 1 (tracked, ignored).
  sources.related.set(1, { sequels: [media(10, 'One S2')], recs: [{ rating: 9, media: media(50, 'Rec A') }, { rating: 5, media: media(51, 'Rec B') }, { rating: 4, media: media(10, 'One S2') }] });
  sources.related.set(2, { sequels: [media(1, 'One')], recs: [{ rating: 3, media: media(51, 'Rec B') }, { rating: 2, media: media(1, 'One') }] });
  sources.related.set(10, { sequels: [media(11, 'One S3', 'NOT_YET_RELEASED')], recs: [] });
  sources.related.set(11, { sequels: [media(10, 'One S2')], recs: [] }); // a loop must not hang
  const shows = [fakeShow(1, clock, { title: 'One' }), fakeShow(2, clock, { title: 'Two' }), { ...fakeShow(3, clock), source: 'tvmaze' }];

  const d = await computeDiscover({ shows, sources, now: clock.t });
  assert.deepEqual(d.sequels.map((s) => [s.key, s.from, s.fresh]), [
    ['anilist:11', 'One', true],
    ['anilist:10', 'One', false],
  ]);
  assert.equal(d.sequels[0].note, 'Expected Apr 2027');
  // Rec B is recommended by both tracked shows, so it outranks Rec A; tracked shows and sequels are excluded.
  assert.deepEqual(d.recs.map((r) => [r.key, r.because]), [
    ['anilist:51', ['One', 'Two']],
    ['anilist:50', ['One']],
  ]);
  assert.deepEqual(await computeDiscover({ shows: [], sources, now: clock.t }), { sequels: [], recs: [] });
});

test('tracker alerts for a newly announced season, but not on the first scan', async () => {
  const clock = { t: Date.UTC(2026, 10, 12) };
  const sent = [];
  const store = openStore(tmp());
  const sources = fakeSources(clock);
  sources.related.set(1, { sequels: [media(10, 'One S2', 'NOT_YET_RELEASED')], recs: [{ rating: 5, media: media(50, 'Rec A') }] });
  const tracker = createTracker({ store, sources, send: async (_s, m) => (sent.push(...m), []), now: () => clock.t });
  await tracker.addShow('anilist', 1);
  await tracker.refreshDiscover();
  assert.equal(sent.length, 0, 'seasons that already existed are not announced');
  assert.deepEqual(store.data.discover.sequels.map((s) => s.key), ['anilist:10']);

  sources.related.set(10, { sequels: [media(11, 'One S3', 'NOT_YET_RELEASED')], recs: [] });
  await tracker.refreshDiscover();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'One S3');
  assert.match(sent[0].body, /^New season of Show 1 announced — expected apr 2027$/);
  assert.equal(store.data.alerts[0].ep.label, 'New season of Show 1');

  await tracker.refreshDiscover();
  assert.equal(sent.length, 1, 'announced once');
});

test('timing helpers', () => {
  const t = Date.UTC(2026, 10, 12, 3, 30); // 03:30 UTC = 21:30 the previous day in Chicago
  assert.deepEqual(localClock(t, 'America/Chicago'), { hour: 21, day: '2026-11-11' });
  assert.deepEqual(localClock(t, ''), { hour: 3, day: '2026-11-12' });
  assert.deepEqual(localClock(t, 'Nope/Nope'), { hour: 3, day: '2026-11-12' });
  assert.ok(inQuietHours(23, 22, 7) && inQuietHours(3, 22, 7) && !inQuietHours(7, 22, 7) && !inQuietHours(12, 22, 7));
  assert.ok(inQuietHours(13, 12, 14) && !inQuietHours(14, 12, 14));
  assert.ok(!inQuietHours(3, null, null) && !inQuietHours(3, 5, 5));
  const sum = summarize(Array.from({ length: 17 }, (_, i) => ({ title: `T${i}`, body: 'Episode 1 is out', at: i })));
  assert.equal(sum.title, '17 new on your list');
  assert.equal(sum.body.split('\n').length, 16);
});

test('quiet hours hold alerts, the digest sends once a day, muted shows stay silent', async () => {
  const start = Date.UTC(2026, 10, 12, 2, 0); // 02:00 UTC
  const clock = { t: start };
  const sent = [];
  const store = openStore(tmp());
  const sources = fakeSources(clock);
  // Episode 2 of every show airs one minute after `start`.
  sources.fetchAnime = async (ids) => ids.map((id) => fakeShow(id, { t: start }));
  const tracker = createTracker({ store, sources, send: async (_s, m) => (sent.push(m), []), now: () => clock.t });
  Object.assign(store.data.settings, { timeZone: 'UTC', quietStart: 1, quietEnd: 6 });
  await tracker.addShow('anilist', 1);
  await tracker.addShow('anilist', 2);
  await tracker.addShow('anilist', 3);
  store.data.muted = ['anilist:3'];

  clock.t = start + 5 * 60_000; // 02:05, inside quiet hours
  await tracker.tick();
  assert.equal(sent.length, 0, 'held during quiet hours');
  assert.equal(store.data.alerts.length, 3, 'but listed in the app, muted show included');
  assert.equal(store.data.outbox.length, 2, 'muted show is not queued');

  clock.t = Date.UTC(2026, 10, 12, 6, 1); // quiet hours over
  await tracker.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((m) => m.title).sort(), ['Show 1', 'Show 2']);
  assert.equal(sent[0][0].showKey, undefined);

  // Digest mode: nothing until the digest hour, then one combined message.
  Object.assign(store.data.settings, { alertMode: 'digest', digestHour: 8, quietStart: null, quietEnd: null });
  store.data.outbox.push({ title: 'A', body: 'Episode 1 is out', at: 1 }, { title: 'B', body: 'Episode 2 is out', at: 2 });
  clock.t = Date.UTC(2026, 10, 12, 7, 30);
  await tracker.flush();
  assert.equal(sent.length, 1);
  clock.t = Date.UTC(2026, 10, 12, 8, 0);
  await tracker.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].length, 1);
  assert.equal(sent[1][0].title, '2 new on your list');
  store.data.outbox.push({ title: 'C', body: 'Episode 3 is out', at: 3 });
  clock.t = Date.UTC(2026, 10, 12, 15, 0);
  await tracker.flush();
  assert.equal(sent.length, 2, 'waits for tomorrow');
  clock.t = Date.UTC(2026, 10, 13, 8, 2);
  await tracker.flush();
  assert.equal(sent.length, 3);
  assert.equal(sent[2][0].title, 'C', 'a single item is sent as itself');
});

test('reminders fire once, shortly before airing', async () => {
  const start = Date.UTC(2026, 10, 12, 12, 0);
  const clock = { t: start };
  const sent = [];
  const store = openStore(tmp());
  const sources = fakeSources(clock);
  sources.fetchAnime = async (ids) => ids.map((id) => fakeShow(id, { t: start }, { episodes: [{ id: `anilist:${id}:9`, label: 'Episode 9', airsAt: start + 45 * 60_000 }] }));
  const tracker = createTracker({ store, sources, send: async (_s, m) => (sent.push(...m), []), now: () => clock.t });
  store.data.settings.remindMinutes = 30;
  await tracker.addShow('anilist', 1);
  await tracker.tick();
  assert.equal(sent.length, 0, 'too early');
  clock.t = start + 16 * 60_000;
  await tracker.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, 'Episode 9 airs in 29 minutes');
  clock.t += 60_000;
  await tracker.tick();
  assert.equal(sent.length, 1, 'once only');
});

test('backup leaves out secrets and survives a round trip', () => {
  const dir = tmp();
  const store = openStore(dir);
  const d = store.data;
  d.shows = { 'anilist:1': { key: 'anilist:1', source: 'anilist', id: 1, title: 'One', addedAt: 123 } };
  d.watched = ['anilist:1:1'];
  d.auth = hashPassword('correct horse');
  Object.assign(d.settings, { ntfyUrl: 'https://ntfy.sh/private-topic', discordWebhook: 'https://discord.com/api/webhooks/1/abc' });
  const backup = buildBackup(d, 0);
  const text = JSON.stringify(backup);
  for (const secret of [d.auth.hash, d.secret, d.feedToken, 'private-topic', 'webhooks/1/abc']) assert.ok(!text.includes(secret), `backup must not contain ${secret}`);
  assert.deepEqual(readBackup(JSON.parse(text)).shows, [{ source: 'anilist', id: 1, addedAt: 123 }]);
  assert.deepEqual(readBackup(JSON.parse(text)).watched, ['anilist:1:1']);
  assert.throws(() => readBackup({ shows: [] }), /not a Show Tracker backup/);
  assert.throws(() => readBackup(null), /not a Show Tracker backup/);
  assert.deepEqual(readBackup({ app: 'show-tracker', shows: [{ source: 'evil', id: 1 }, { source: 'tvmaze', id: -2 }, null], watched: [1, 'ok'] }), { shows: [], watched: ['ok'], muted: [], dismissed: [], settings: {} });

  for (let i = 1; i <= 16; i++) writeSnapshot(dir, d, `2026-11-${String(i).padStart(2, '0')}`);
  const files = readdirSync(join(dir, 'backups')).sort();
  assert.equal(files.length, 14, 'old snapshots are pruned');
  assert.equal(files[0], 'backup-2026-11-03.json');
});

test('tick writes a daily snapshot and posts a weekly Discord backup when enabled', async () => {
  const clock = { t: Date.UTC(2026, 10, 12, 12) };
  const dir = tmp();
  const store = openStore(dir);
  const files = [];
  const tracker = createTracker({ store, sources: fakeSources(clock), send: async () => [], sendFile: async (...a) => files.push(a), now: () => clock.t });
  await tracker.addShow('anilist', 1);
  await tracker.tick();
  await tracker.tick();
  assert.deepEqual(readdirSync(join(dir, 'backups')), ['backup-2026-11-12.json']);
  assert.equal(files.length, 0, 'Discord backup is opt-in');

  Object.assign(store.data.settings, { backupToDiscord: true, discordWebhook: 'https://discord.com/api/webhooks/1/abc' });
  await tracker.tick();
  await tracker.tick();
  assert.equal(files.length, 1);
  assert.equal(files[0][1], 'show-tracker-backup-2026-11-12.json');
  assert.equal(JSON.parse(files[0][2]).shows.length, 1);
  clock.t += 8 * DAY;
  await tracker.tick();
  assert.equal(files.length, 2, 'again a week later');
});
