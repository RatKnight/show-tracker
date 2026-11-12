import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { openStore } from '../server/store.js';
import { createTracker } from '../server/tracker.js';
import { buildIcs } from '../server/ics.js';
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
  };
}

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
  const { server } = createApp({ dataDir: dir, sources: fakeSources(clock), send: async (_s, m) => (sent.push(...m), []) });
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

  assert.equal((await req('POST', '/api/setup', { password: 'short' })).status, 400);
  assert.equal((await req('POST', '/api/setup', { password: 'long enough pw' })).status, 200);
  assert.equal((await req('POST', '/api/setup', { password: 'another password' })).status, 409);
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

  assert.equal((await req('PUT', '/api/settings', { discordWebhook: 'https://example.com/hook' })).status, 400);
  assert.equal((await req('POST', '/api/test-alert')).status, 400);
  const saved = await req('PUT', '/api/settings', { services: ['hidive', 'bogus'], ntfyUrl: 'https://ntfy.sh/topic-abc' });
  assert.deepEqual(saved.body.settings, { services: ['hidive'], ntfyUrl: 'https://ntfy.sh/topic-abc', discordWebhook: '' });
  assert.equal((await req('POST', '/api/test-alert')).status, 200);
  assert.equal(sent.length, 1);

  assert.equal((await req('GET', '/calendar.ics')).status, 404);
  assert.equal((await req('GET', '/calendar.ics?token=wrong')).status, 404);
  const feed = await req('GET', `/calendar.ics?token=${saved.body.feedToken}`);
  assert.equal(feed.status, 200);
  assert.match(feed.body, /SUMMARY:Show 5 – Episode 2/);

  assert.deepEqual((await req('DELETE', '/api/shows?key=anilist:5')).body.shows, {});
  assert.ok(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).auth.hash, 'state persisted');

  await req('POST', '/api/logout');
  assert.equal((await req('GET', '/api/state')).status, 401);
});
