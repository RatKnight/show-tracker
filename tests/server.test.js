import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { openStore, makeUser } from '../server/store.js';
import { createTracker } from '../server/tracker.js';
import { buildIcs } from '../server/ics.js';
import { computeDiscover, buildSeries, withFranchiseRoots } from '../server/discover.js';
import { localClock, inQuietHours, summarize } from '../server/timing.js';
import { buildBackup, readBackup, writeSnapshot } from '../server/backup.js';
import { createMailer, cleanEmail } from '../server/mail.js';
import { matchEpisode, normTitle } from '../server/extmatch.js';
import { generateKeyPairSync, createHash, sign as cryptoSign, randomBytes } from 'node:crypto';
import { validateChannels, parseNtfy, ntfyPayloads, discordPayloads, isPrivateAddress, sendAlerts } from '../server/notify.js';
import { hashPassword, checkPassword, cleanUsername, sessionCookie, sessionUser, tokenHash } from '../server/auth.js';
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
    year: 2020 + (id % 5),
    streams: [{ id: 'crunchyroll', name: 'Crunchyroll', url: 'https://crunchyroll.com/x' }],
    episodes: [
      { id: `anilist:${id}:1`, label: 'Episode 1', airsAt: clock.t - DAY },
      { id: `anilist:${id}:2`, label: 'Episode 2', airsAt: clock.t + 60_000 },
    ],
    ...extra,
  };
}

function fakeMovie(id, clock, extra = {}) {
  return {
    key: `tmdb:${id}`,
    source: 'tmdb',
    id,
    kind: 'Movie',
    title: `Film ${id}`,
    image: null,
    url: `https://www.themoviedb.org/movie/${id}`,
    status: 'Upcoming',
    tickets: 'https://www.fandango.com/search?q=x',
    streams: [],
    episodes: [{ id: `tmdb:${id}:cinema`, event: 'cinema', label: 'In US cinemas', airsAt: clock.t + 60_000, dateOnly: true }],
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
    movies: true,
    hasMovies() {
      return this.movies;
    },
    async searchMovies(q) {
      return [fakeMovie(300, clock, { title: q })];
    },
    async fetchMovie(id) {
      return fakeMovie(id, clock);
    },
    franchises: {},
    async fetchFranchise(id) {
      return this.franchises[id] || { root: `Show ${id}`, offset: 0, index: 1, count: 12 };
    },
    availability: {},
    async fetchAvailability(show, regions) {
      this.asked = [...(this.asked || []), show.title];
      const by = this.availability[show.title] || {};
      return { tmdbId: 1, byRegion: Object.fromEntries(regions.map((r) => [r, by[r] || []])), links: Object.fromEntries(regions.map((r) => [r, `https://tmdb.example/watch?locale=${r}`])) };
    },
    async fetchPremieres(region) {
      return [fakeShow(800, clock, { key: 'tvmaze:800', source: 'tvmaze', title: `Premiere in ${region}`, premiere: 'New series' })];
    },
    dubbed: true,
    hasDubs() {
      return this.dubbed;
    },
    dubList: [],
    async fetchDubs() {
      return this.dubList;
    },
    cinemaList: [],
    async fetchCinemaAnime() {
      return this.cinemaList;
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

test('channel validation and payloads', () => {
  assert.equal(validateChannels({ ntfyUrl: '', discordWebhook: '' }), null);
  assert.equal(validateChannels({ ntfyUrl: 'https://ntfy.sh/my-topic_1', discordWebhook: 'https://discord.com/api/webhooks/123/abc-DEF_1' }), null);
  assert.match(validateChannels({ ntfyUrl: 'http://ntfy.sh/topic' }), /ntfy/);
  assert.match(validateChannels({ ntfyUrl: 'https://ntfy.sh/' }), /ntfy/);
  assert.match(validateChannels({ discordWebhook: 'https://evil.example/api/webhooks/1/x' }), /Discord/);
  assert.deepEqual(parseNtfy('https://ntfy.example.com/shows/'), { server: 'https://ntfy.example.com', topic: 'shows' });

  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.ok(!isPrivateAddress(ip), ip);
  const msgs = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, body: 'b', url: 'https://x', image: null, at: 0 }));
  assert.equal(ntfyPayloads('https://ntfy.sh/t', msgs)[0].topic, 't');
  const d = discordPayloads(msgs);
  assert.deepEqual(d.map((p) => p.embeds.length), [10, 2]);
});

test('alerts are not delivered to an ntfy address on a private network', async () => {
  const message = [{ title: 'T', body: 'b', at: 0 }];
  for (const url of ['https://127.0.0.1/topic', 'https://10.0.0.5/topic', 'https://[::1]/topic', 'https://localhost/topic']) {
    assert.match((await sendAlerts({ ntfyUrl: url, discordWebhook: '' }, message))[0], /^ntfy: that address is on a private network/, url);
  }
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
  assert.deepEqual(await computeDiscover({ shows: [], sources, now: clock.t }), { sequels: [], recs: [], links: [] });

  // Series: 1 and 2 are joined directly; 1 and a tracked 11 are joined through the untracked 10.
  assert.deepEqual(buildSeries(shows, d.links), {
    'anilist:1': { id: 'anilist:1', title: 'One' },
    'anilist:2': { id: 'anilist:1', title: 'One' },
  });
  const withS3 = [...shows, fakeShow(11, clock, { title: 'One S3', year: 2027 }), fakeShow(77, clock, { title: 'Unrelated' })];
  const grouped = buildSeries(withS3, d.links);
  assert.deepEqual(Object.keys(grouped).sort(), ['anilist:1', 'anilist:11', 'anilist:2']);
  assert.equal(grouped['anilist:11'].id, grouped['anilist:1'].id);
  assert.deepEqual(buildSeries([shows[0]], d.links), {}, 'a single tracked season is not a series');
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


/** A store with one user in it, plus a tracker wired to fakes. */
const HALF_DAY = 12 * 60 * 60 * 1000;
function rig({ start = Date.UTC(2026, 10, 12), fixedEpisodes = true } = {}) {
  const clock = { t: start };
  const sent = [];
  const files = [];
  const dir = tmp();
  const store = openStore(dir);
  const sources = fakeSources(clock);
  // Episode times stay fixed even as the clock advances.
  if (fixedEpisodes) {
    sources.fetchAnime = async (ids) => {
      sources.calls++;
      if (sources.fail) throw new Error('AniList down');
      return ids.map((id) => fakeShow(id, { t: start }));
    };
  }
  const user = makeUser({ username: 'ann', auth: hashPassword('password-ann') });
  store.data.users[user.id] = user;
  const tracker = createTracker({ store, sources, send: async (_s, m) => (sent.push(m), []), sendFile: async (...a) => files.push(a), now: () => clock.t });
  return { clock, sent, files, dir, store, sources, user, tracker, start };
}

test('tracker alerts once per episode, only for episodes aired after adding', async () => {
  const { clock, sent, user, tracker } = rig();
  await tracker.addShow(user, 'anilist', 5);
  await tracker.tick();
  assert.equal(sent.length, 0, 'episode 1 aired before the show was added');

  clock.t += 2 * 60_000;
  await tracker.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].title, 'Show 5');
  assert.equal(sent[0][0].body, 'Episode 2 is out on Crunchyroll');
  assert.equal(user.alerts.length, 1);

  await tracker.tick();
  await tracker.refresh();
  assert.equal(sent.length, 1, 'no duplicate alert');
});

test('two users tracking the same show share one catalog entry but get their own alerts', async () => {
  const { clock, sent, store, sources, user: ann, tracker } = rig();
  const bob = makeUser({ username: 'bob' });
  store.data.users[bob.id] = bob;
  await tracker.addShow(ann, 'anilist', 5);
  sources.calls = 0;
  await tracker.addShow(bob, 'anilist', 5);
  assert.equal(sources.calls, 0, 'second user reuses the catalog entry');
  await tracker.addShow(bob, 'anilist', 6);
  bob.muted = ['anilist:6'];
  assert.deepEqual(Object.keys(store.data.catalog).sort(), ['anilist:5', 'anilist:6']);
  assert.deepEqual(tracker.showsOf(ann).map((s) => s.key), ['anilist:5']);

  clock.t += 2 * 60_000;
  await tracker.tick();
  assert.equal(sent.length, 2, 'one delivery per user');
  assert.equal(ann.alerts.length, 1);
  assert.equal(bob.alerts.length, 2, 'muted show is still listed for bob');

  tracker.removeShow(ann, 'anilist:5');
  assert.ok(store.data.catalog['anilist:5'], 'still tracked by bob');
  tracker.removeUser(bob.id);
  assert.deepEqual(store.data.catalog, {}, 'nothing left that anyone tracks');
});

test('tracker records refresh failures and backs off', async () => {
  const { clock, store, sources, user, tracker } = rig();
  await tracker.addShow(user, 'anilist', 5);
  sources.fail = true;
  sources.calls = 0;
  await tracker.tick();
  assert.match(store.data.lastError, /AniList down/);
  assert.equal(Object.keys(store.data.catalog).length, 1, 'existing data is kept');
  await tracker.tick();
  assert.equal(sources.calls, 1, 'does not retry every minute');
  clock.t += 6 * 60_000;
  sources.fail = false;
  await tracker.tick();
  assert.equal(sources.calls, 2);
  assert.equal(store.data.lastError, null);
});

test('new seasons: alert once, never on the first scan; followed series pick them up automatically', async () => {
  // With automatic tracking switched off: listed and announced, not added.
  {
    const { sent, sources, user, tracker, clock } = rig();
    user.settings.autoTrackSeasons = false;
    sources.related.set(1, { sequels: [media(10, 'One S2', 'NOT_YET_RELEASED')], recs: [{ rating: 5, media: media(50, 'Rec A') }] });
    await tracker.addShow(user, 'anilist', 1);
    await tracker.refreshDiscover(user);
    assert.equal(sent.length, 0, 'seasons that already existed are not announced');
    assert.deepEqual(user.discover.sequels.map((s) => s.key), ['anilist:10']);
    assert.deepEqual(Object.keys(user.shows), ['anilist:1']);

    sources.related.set(10, { sequels: [media(11, 'One S3', 'NOT_YET_RELEASED')], recs: [] });
    await tracker.refreshDiscover(user);
    assert.equal(sent.length, 0, 'answers are kept: nothing is asked again so soon');
    clock.t += HALF_DAY; // the next scheduled rebuild
    await tracker.refreshDiscover(user);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0].title, 'One S3');
    assert.equal(sent[0][0].body, 'New season of Show 1 announced — expected apr 2027');
    assert.equal(user.alerts[0].ep.label, 'New season of Show 1');
    await tracker.refreshDiscover(user);
    assert.equal(sent.length, 1, 'announced once');
    assert.equal(user.discover.links, undefined, 'working data is not stored');
  }

  // With it on (the default): upcoming seasons join the list and form one series.
  {
    const { sent, sources, user, tracker, clock } = rig();
    sources.related.set(1, { sequels: [media(10, 'One S2', 'FINISHED')], recs: [] });
    sources.related.set(10, { sequels: [media(11, 'One S3', 'NOT_YET_RELEASED')], recs: [] });
    await tracker.addShow(user, 'anilist', 1);
    await tracker.refreshDiscover(user);
    assert.deepEqual(Object.keys(user.shows).sort(), ['anilist:1', 'anilist:11'], 'the upcoming season is added, the finished one is not');
    assert.equal(sent.length, 0, 'silently on the first scan');
    assert.deepEqual(user.discover.series, { 'anilist:1': { id: 'anilist:1', title: 'Show 1' }, 'anilist:11': { id: 'anilist:1', title: 'Show 1' } });

    sources.related.set(11, { sequels: [media(12, 'One S4', 'RELEASING')], recs: [] });
    clock.t += HALF_DAY;
    await tracker.refreshDiscover(user);
    assert.ok(user.shows['anilist:12']);
    assert.equal(sent.flat().at(-1).body, 'New season of Show 1 is airing. Added to your list.');
    assert.equal(user.discover.series['anilist:12'].id, 'anilist:1');

    // A season the user removes stays removed, until they add it back by hand.
    tracker.removeShow(user, 'anilist:12');
    await tracker.refreshDiscover(user);
    await tracker.refreshDiscover(user);
    assert.equal(user.shows['anilist:12'], undefined);
    assert.equal(user.discover.series['anilist:12'], undefined);
    await tracker.addShow(user, 'anilist', 12);
    assert.ok(user.shows['anilist:12']);
    assert.ok(!user.dismissed.includes('anilist:12'));
  }
});

test('quiet hours hold alerts, the digest sends once a day, muted shows stay silent', async () => {
  const start = Date.UTC(2026, 10, 12, 2, 0);
  const { clock, sent, user, tracker } = rig({ start });
  Object.assign(user.settings, { timeZone: 'UTC', quietStart: 1, quietEnd: 6 });
  for (const id of [1, 2, 3]) await tracker.addShow(user, 'anilist', id);
  user.muted = ['anilist:3'];

  clock.t = start + 5 * 60_000;
  await tracker.tick();
  assert.equal(sent.length, 0, 'held during quiet hours');
  assert.equal(user.alerts.length, 3, 'but listed in the app, muted show included');
  assert.equal(user.outbox.length, 2, 'muted show is not queued');

  clock.t = Date.UTC(2026, 10, 12, 6, 1);
  await tracker.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((m) => m.title).sort(), ['Show 1', 'Show 2']);

  Object.assign(user.settings, { alertMode: 'digest', digestHour: 8, quietStart: null, quietEnd: null });
  user.outbox.push({ title: 'A', body: 'Episode 1 is out', at: 1 }, { title: 'B', body: 'Episode 2 is out', at: 2 });
  clock.t = Date.UTC(2026, 10, 12, 7, 30);
  await tracker.flush(user);
  assert.equal(sent.length, 1);
  clock.t = Date.UTC(2026, 10, 12, 8, 0);
  await tracker.flush(user);
  assert.equal(sent[1][0].title, '2 new on your list');
  user.outbox.push({ title: 'C', body: 'Episode 3 is out', at: 3 });
  clock.t = Date.UTC(2026, 10, 12, 15, 0);
  await tracker.flush(user);
  assert.equal(sent.length, 2, 'waits for tomorrow');
  clock.t = Date.UTC(2026, 10, 13, 8, 2);
  await tracker.flush(user);
  assert.equal(sent[2][0].title, 'C');
});

test('reminders fire once, shortly before airing', async () => {
  const start = Date.UTC(2026, 10, 12, 12, 0);
  const { clock, sent, sources, user, tracker } = rig({ start });
  sources.fetchAnime = async (ids) => ids.map((id) => fakeShow(id, { t: start }, { episodes: [{ id: `anilist:${id}:9`, label: 'Episode 9', airsAt: start + 45 * 60_000 }] }));
  user.settings.remindMinutes = 30;
  await tracker.addShow(user, 'anilist', 1);
  await tracker.tick();
  assert.equal(sent.length, 0, 'too early');
  clock.t = start + 16 * 60_000;
  await tracker.tick();
  assert.equal(sent.flat()[0].body, 'Episode 9 airs in 29 minutes');
  clock.t += 60_000;
  await tracker.tick();
  assert.equal(sent.length, 1, 'once only');
});

test('store: encryption at rest, wrong key, and migration from the single-user format', () => {
  const KEY = 'k'.repeat(40);
  // A version 1 file, as written before accounts existed.
  const dir = tmp();
  const v1 = {
    shows: { 'anilist:1': { key: 'anilist:1', source: 'anilist', id: 1, title: 'Secret Show', episodes: [], streams: [], addedAt: 123 } },
    alerts: [],
    alerted: ['anilist:1:1'],
    watched: ['anilist:1:1'],
    auth: hashPassword('old password'),
    secret: 's'.repeat(64),
    feedToken: 'feed-token-123',
    settings: { ntfyUrl: 'https://ntfy.sh/private-topic', services: ['hidive'] },
    lastRefresh: 5,
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(v1));

  const store = openStore(dir, { dataKey: KEY });
  const [admin] = Object.values(store.data.users);
  assert.deepEqual([admin.username, admin.admin, admin.feedToken, admin.watched, admin.settings.services], ['admin', true, 'feed-token-123', ['anilist:1:1'], ['hidive']]);
  assert.ok(checkPassword('old password', admin.auth), 'the old password still works');
  assert.deepEqual(admin.shows, { 'anilist:1': { addedAt: 123 } });
  assert.equal(store.data.catalog['anilist:1'].title, 'Secret Show');
  assert.equal(store.data.catalog['anilist:1'].addedAt, undefined);

  const onDisk = readFileSync(join(dir, 'state.json'), 'utf8');
  assert.equal(JSON.parse(onDisk).encrypted, true);
  for (const secret of ['Secret Show', 'admin', 'private-topic', admin.auth.hash, 'feed-token-123']) assert.ok(!onDisk.includes(secret), `"${secret}" must not be readable on disk`);
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);

  assert.equal(Object.values(openStore(dir, { dataKey: KEY }).data.users)[0].username, 'admin', 'reopens with the key');
  assert.throws(() => openStore(dir, { dataKey: 'x'.repeat(40) }), /does not match/);
  assert.throws(() => openStore(dir), /set DATA_KEY/);
  assert.throws(() => openStore(tmp(), { dataKey: 'short' }), /at least 32/);

  // Turning encryption on later removes readable snapshots left from before.
  const late = tmp();
  writeSnapshot(openStore(late), '2026-11-01');
  writeFileSync(join(late, 'backups', 'backup-2026-10-31.json'), '{"shows":[]}');
  const sealed = openStore(late, { dataKey: KEY });
  writeSnapshot(sealed, '2026-11-02');
  assert.deepEqual(readdirSync(join(late, 'backups')), ['state-2026-11-02.json']);
  assert.ok(readFileSync(join(late, 'backups', 'state-2026-11-02.json'), 'utf8').startsWith('{"encrypted":true'));

  // Without a key the file stays readable JSON, and a corrupt file is refused.
  const plain = tmp();
  openStore(plain);
  assert.equal(JSON.parse(readFileSync(join(plain, 'state.json'), 'utf8')).version, 2);
  writeFileSync(join(plain, 'state.json'), '{ nope');
  assert.throws(() => openStore(plain), /Cannot read/);
});

test('auth helpers', () => {
  const auth = hashPassword('correct horse');
  assert.ok(checkPassword('correct horse', auth));
  assert.ok(!checkPassword('wrong', auth));
  assert.ok(!checkPassword('anything', null));
  assert.equal(cleanUsername('  Ann_1 '), 'Ann_1');
  for (const bad of ['ab', 'has space', 'x'.repeat(25), '<b>', 42, null]) assert.equal(cleanUsername(bad), null);
  assert.equal(tokenHash('abc').length, 64);

  const ann = makeUser({ username: 'ann' });
  const bob = makeUser({ username: 'bob' });
  const data = { secret: 'secret', users: { [ann.id]: ann, [bob.id]: bob } };
  const cookie = sessionCookie('secret', ann, true, 1000).split(';')[0];
  assert.match(cookie, /^__Host-st_session=/);
  assert.equal(sessionUser(cookie, data, 2000, true), ann);
  assert.equal(sessionUser(cookie, data, 2000, false), null, 'the HTTPS cookie is not read on plain HTTP');
  assert.equal(sessionUser(cookie.replace('__Host-', ''), data, 2000, true), null, 'the plain name is not read over HTTPS');
  assert.equal(sessionUser(cookie, { ...data, secret: 'other' }, 2000, true), null);
  assert.equal(sessionUser(cookie, data, 1000 + 31 * DAY, true), null, 'expired');
  assert.equal(sessionUser(cookie.replace(ann.id, bob.id), data, 2000, true), null, 'cannot be re-pointed at another user');
  ann.sessionKey = 'rotated';
  assert.equal(sessionUser(cookie, data, 2000, true), null, 'revoked when the session key changes');
  assert.equal(sessionUser('st_session=__proto__.9999999999999.abc', data, 2000), null);
});

test('backup leaves out secrets; snapshots copy the data file and are pruned', async () => {
  const { store, user, tracker, dir } = rig();
  await tracker.addShow(user, 'anilist', 1);
  user.watched = ['anilist:1:1'];
  Object.assign(user.settings, { ntfyUrl: 'https://ntfy.sh/private-topic', discordWebhook: 'https://discord.com/api/webhooks/1/abc' });
  const text = JSON.stringify(buildBackup(user, store.data.catalog, 0));
  for (const secret of [user.auth.hash, store.data.secret, user.feedToken, user.sessionKey, 'private-topic', 'webhooks/1/abc']) assert.ok(!text.includes(secret), `backup must not contain ${secret}`);
  assert.deepEqual(readBackup(JSON.parse(text)).shows, [{ source: 'anilist', id: 1, addedAt: user.shows['anilist:1'].addedAt }]);
  assert.throws(() => readBackup({ shows: [] }), /not a Show Tracker backup/);
  assert.deepEqual(readBackup({ app: 'show-tracker', shows: [{ source: 'evil', id: 1 }, null], watched: [1, 'ok'] }), { shows: [], watched: ['ok'], progress: {}, muted: [], dismissed: [], settings: {} });

  for (let i = 1; i <= 16; i++) writeSnapshot(store, `2026-11-${String(i).padStart(2, '0')}`);
  const snaps = readdirSync(join(dir, 'backups')).sort();
  assert.equal(snaps.length, 14, 'old snapshots are pruned');
  assert.equal(snaps[0], 'state-2026-11-03.json');
});

test('tick writes a daily snapshot and posts a weekly Discord backup when enabled', async () => {
  const { clock, files, dir, user, tracker } = rig({ start: Date.UTC(2026, 10, 12, 12) });
  await tracker.addShow(user, 'anilist', 1);
  await tracker.tick();
  await tracker.tick();
  assert.deepEqual(readdirSync(join(dir, 'backups')), ['state-2026-11-12.json']);
  assert.equal(files.length, 0, 'Discord backup is opt-in');
  Object.assign(user.settings, { backupToDiscord: true, discordWebhook: 'https://discord.com/api/webhooks/1/abc' });
  await tracker.tick();
  await tracker.tick();
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(files[0][2]).shows.length, 1);
  clock.t += 8 * DAY;
  await tracker.tick();
  assert.equal(files.length, 2, 'again a week later');
});

// ---------------------------------------------------------------- HTTP

async function serve(t, opts = {}) {
  const clock = { t: Date.now() };
  const dir = tmp();
  const sent = [];
  const sources = fakeSources(clock);
  // As deployed: behind a reverse proxy that reports the visitor's address.
  const app = createApp({ dataDir: dir, sources, send: async (_s, m) => (sent.push(...m), []), sendFile: async () => {}, trustProxy: true, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  /** A browser-like client that keeps its own cookie. */
  const client = (ip = '198.51.100.1') => {
    const c = {
      cookie: '',
      admin: '',
      /** Confirm it is the admin, as the Admin tab does on first opening (password form; accounts with a passkey use that instead). */
      async unlockAdmin(password) {
        return c.req('POST', '/api/admin/unlock', { password });
      },
      async req(method, path, body, headers = {}) {
        const res = await fetch(base + path, {
          method,
          // Like a browser on the site's own pages: every request says where it comes from.
          headers: { 'X-Forwarded-For': ip, Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie || c.admin ? { Cookie: [c.cookie, c.admin].filter(Boolean).join('; ') } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
        });
        // The sign-in (or pending) cookie is kept as before; the admin-unlock cookie rides alongside.
        let main = false;
        for (const line of res.headers.getSetCookie()) {
          const pair = line.split(';')[0];
          if (pair.startsWith('st_admin=')) c.admin = pair === 'st_admin=' ? '' : pair;
          else if (!main) {
            c.cookie = pair;
            main = true;
          }
        }
        const text = await res.text();
        return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
      },
    };
    return c;
  };
  return { ...app, base, dir, sent, sources, client };
}

test('http: setup, sign-in and the single-user features', async (t) => {
  const { setupCode, tracker, store, sources, sent, dir, base, client } = await serve(t);
  const a = client();
  const req = a.req;

  assert.equal((await req('GET', '/healthz')).body, 'ok');
  assert.equal((await req('GET', '/')).status, 200);
  assert.equal((await req('GET', '/../server.js')).status, 404);
  assert.equal((await req('GET', '/%2e%2e/package.json')).status, 404);
  assert.deepEqual((await req('GET', '/api/session')).body, { setup: false, authed: false, mail: false, me: null });
  assert.equal((await req('GET', '/api/state')).status, 401);
  assert.equal((await req('POST', '/api/shows', { source: 'anilist', id: 5 })).status, 401);

  assert.match(setupCode, /^\d{6}$/);
  assert.equal((await req('POST', '/api/setup', { username: 'ann', password: 'long enough pw' })).status, 403, 'no setup code');
  assert.equal((await req('POST', '/api/setup', { username: 'ann', password: 'short', code: setupCode })).status, 400);
  assert.equal((await req('POST', '/api/setup', { username: 'a b', password: 'long enough pw', code: setupCode })).status, 400);
  assert.equal((await req('POST', '/api/setup', { username: 'ann', password: 'long enough pw', code: setupCode })).status, 200);
  assert.equal((await req('POST', '/api/setup', { username: 'eve', password: 'another password', code: setupCode })).status, 409);
  assert.deepEqual((await req('GET', '/api/session')).body.me.username, 'ann');
  assert.equal((await req('GET', '/api/session')).body.me.admin, true, 'the first account is the admin');

  a.cookie = '';
  assert.equal((await req('POST', '/api/login', { username: 'ann', password: 'nope' })).status, 401);
  assert.equal((await req('POST', '/api/login', { username: 'nobody', password: 'long enough pw' })).body.error, 'Wrong username or password.');
  assert.equal((await req('POST', '/api/login', { username: 'ANN', password: 'long enough pw' })).status, 200, 'usernames ignore case');

  assert.equal((await req('POST', '/api/shows', { source: 'anilist', id: 5 }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await req('POST', '/api/shows', { source: 'nope', id: 5 })).status, 400);
  const added = await req('POST', '/api/shows', { source: 'anilist', id: 5 });
  assert.deepEqual(Object.keys(added.body.shows), ['anilist:5']);
  for (const leak of ['auth', 'secret', 'sessionKey', 'users', 'catalog']) assert.equal(added.body[leak], undefined, `${leak} is never sent`);

  assert.equal((await req('GET', '/api/search?source=anime&q=frieren')).body[0].title, 'frieren');
  assert.equal((await req('GET', '/api/season?which=next')).body.list.length, 1);
  assert.equal((await req('PUT', '/api/settings', { autoTrackSeasons: false })).body.settings.autoTrackSeasons, false);
  sources.related.set(5, { sequels: [media(60, 'Five S2', 'RELEASING')], recs: [{ rating: 5, media: media(61, 'Rec') }] });
  store.data.related = {}; // as at the next scheduled rebuild, when kept answers have aged out
  await tracker.refreshDiscover(Object.values(store.data.users)[0], { silent: true });
  let disc = await req('GET', '/api/discover');
  assert.deepEqual([disc.body.sequels.map((x) => x.key), disc.body.recs.map((x) => x.key)], [['anilist:60'], ['anilist:61']]);
  assert.equal((await req('POST', '/api/discover/dismiss', { key: '../x' })).status, 400);
  assert.deepEqual((await req('POST', '/api/discover/dismiss', { key: 'anilist:61' })).body.recs, []);

  assert.equal((await req('PUT', '/api/settings', { discordWebhook: 'https://example.com/hook' })).status, 400);
  assert.equal((await req('POST', '/api/test-alert')).status, 400);
  const saved = await req('PUT', '/api/settings', { services: ['hidive', 'bogus'], ntfyUrl: 'https://ntfy.sh/topic-abc' });
  assert.deepEqual([saved.body.settings.services, saved.body.settings.ntfyUrl], [['hidive'], 'https://ntfy.sh/topic-abc']);
  const tuned = await req('PUT', '/api/settings', { alertMode: 'digest', digestHour: 7, quietStart: 22, quietEnd: 99, remindMinutes: 30, timeZone: 'America/Chicago' });
  assert.deepEqual(
    [tuned.body.settings.alertMode, tuned.body.settings.digestHour, tuned.body.settings.quietStart, tuned.body.settings.quietEnd, tuned.body.settings.remindMinutes, tuned.body.settings.timeZone],
    ['digest', 7, 22, null, 30, 'America/Chicago'],
  );
  assert.equal((await req('PUT', '/api/settings', { timeZone: 'Not/AZone' })).body.settings.timeZone, 'America/Chicago');
  assert.equal((await req('POST', '/api/test-alert')).status, 200);
  assert.equal(sent.length, 1);

  assert.deepEqual((await req('POST', '/api/watched', { ids: ['anilist:5:1', 'anilist:5:2'] })).body.watched, ['anilist:5:1', 'anilist:5:2']);
  assert.deepEqual((await req('POST', '/api/watched', { ids: ['anilist:5:1'], watched: false })).body.watched, ['anilist:5:2']);
  assert.equal((await req('POST', '/api/watched', { ids: 'nope' })).status, 400);
  // "Caught up" covers every episode up to a number and absorbs single marks below it.
  assert.equal((await req('POST', '/api/progress', { key: 'anilist:404', through: 3 })).status, 400);
  assert.equal((await req('POST', '/api/progress', { key: 'anilist:5', through: -1 })).status, 400);
  const caught = (await req('POST', '/api/progress', { key: 'anilist:5', through: 2 })).body;
  assert.deepEqual([caught.progress, caught.watched], [{ 'anilist:5': 2 }, []]);
  assert.deepEqual((await req('POST', '/api/progress', { key: 'anilist:5', through: 0 })).body.progress, {});
  await req('POST', '/api/progress', { key: 'anilist:5', through: 2 });
  assert.deepEqual((await req('POST', '/api/shows/mute', { key: 'anilist:5' })).body.muted, ['anilist:5']);
  assert.equal((await req('POST', '/api/shows/mute', { key: 'anilist:404' })).status, 400);

  assert.equal((await req('GET', '/calendar.ics')).status, 404);
  assert.equal((await req('GET', '/calendar.ics?token=wrong')).status, 404);
  assert.match((await req('GET', `/calendar.ics?token=${saved.body.feedToken}`)).body, /SUMMARY:Show 5 – Episode 2/);
  const rotated = await req('POST', '/api/feed/rotate');
  assert.equal((await req('GET', `/calendar.ics?token=${saved.body.feedToken}`)).status, 404, 'old feed address stops working');
  assert.equal((await req('GET', `/calendar.ics?token=${rotated.body.feedToken}`)).status, 200);

  // Import a profile's list, export, wipe, and restore from the export.
  assert.equal((await req('POST', '/api/import/anilist', { username: 'x' })).status, 400);
  assert.equal((await req('POST', '/api/import/anilist', { username: 'nobody' })).status, 502);
  const imported = await req('POST', '/api/import/anilist', { username: 'someone' });
  assert.deepEqual([imported.body.added, imported.body.skipped, Object.keys(imported.body.shows).length], [2, 1, 3]);
  const exported = await req('GET', '/api/export');
  assert.equal(exported.body.shows.length, 3);
  assert.ok(!JSON.stringify(exported.body).includes('topic-abc'), 'alert addresses are not exported');
  for (const k of ['anilist:5', 'anilist:6', 'anilist:7']) await req('DELETE', `/api/shows?key=${k}`);
  assert.deepEqual((await req('GET', '/api/state')).body.shows, {});
  assert.equal((await req('POST', '/api/import', { app: 'nope' })).status, 400);
  const restored = await req('POST', '/api/import', exported.body);
  assert.deepEqual([restored.body.added, Object.keys(restored.body.shows).sort()], [3, ['anilist:5', 'anilist:6', 'anilist:7']]);
  assert.equal(restored.body.shows['anilist:6'].addedAt, exported.body.shows.find((x) => x.id === 6).addedAt, 'original add time is kept');

  assert.match((await fetch(base + '/manifest.webmanifest')).headers.get('content-type'), /manifest\+json/);
  assert.equal((await fetch(base + '/icon-192.png')).headers.get('content-type'), 'image/png');

  // Changing the password signs other sessions out and the old password stops working.
  const other = client();
  await other.req('POST', '/api/login', { username: 'ann', password: 'long enough pw' });
  assert.equal((await req('POST', '/api/password', { current: 'nope', next: 'brand new password' })).status, 403);
  assert.equal((await req('POST', '/api/password', { current: 'long enough pw', next: 'short' })).status, 400);
  assert.equal((await req('POST', '/api/password', { current: 'long enough pw', next: 'brand new password' })).status, 200);
  assert.equal((await req('GET', '/api/state')).status, 200, 'this session continues');
  assert.equal((await other.req('GET', '/api/state')).status, 401, 'the other device is signed out');
  assert.equal((await other.req('POST', '/api/login', { username: 'ann', password: 'long enough pw' })).status, 401);

  assert.equal((await req('PUT', '/api/account', { username: 'x' })).status, 400);
  assert.equal((await req('PUT', '/api/account', { username: 'annette' })).body.me.username, 'annette');
  assert.ok(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).users, 'state persisted');
  await req('POST', '/api/logout');
  assert.equal((await req('GET', '/api/state')).status, 401);
});

test('http: accounts are isolated; invites, resets, sharing and admin limits', async (t) => {
  const { setupCode, store, client } = await serve(t);
  const ann = client('198.51.100.1');
  const bob = client('198.51.100.2');
  const anon = client('198.51.100.3');
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  await ann.req('POST', '/api/shows', { source: 'anilist', id: 5 });
  await ann.req('PUT', '/api/settings', { ntfyUrl: 'https://ntfy.sh/anns-private-topic' });

  // The admin pages stay shut until the admin confirms it is them, once per session.
  const locked = await ann.req('POST', '/api/admin/invites');
  assert.deepEqual([locked.status, locked.body.locked], [403, true]);
  assert.deepEqual((await ann.req('GET', '/api/admin/unlock')).body, { unlocked: false, method: 'password' });
  assert.equal((await ann.unlockAdmin('wrong')).status, 403);
  assert.equal((await ann.unlockAdmin('password-ann')).status, 200);
  assert.deepEqual((await ann.req('GET', '/api/admin/unlock')).body, { unlocked: true });
  // The confirmation belongs to that sign-in session: it does not carry to another one.
  const elsewhere = client('198.51.100.7');
  await elsewhere.req('POST', '/api/login', { username: 'ann', password: 'password-ann' });
  elsewhere.admin = ann.admin;
  assert.equal((await elsewhere.req('GET', '/api/admin/users')).status, 403);

  // Sign-up needs an invite; invites are single use.
  assert.equal((await anon.req('POST', '/api/signup', { token: 'made-up', username: 'bob', password: 'password-bob' })).status, 404);
  assert.equal((await anon.req('POST', '/api/admin/invites')).status, 401);
  const invite = (await ann.req('POST', '/api/admin/invites')).body;
  assert.equal(invite.invites.length, 1);
  assert.deepEqual(Object.keys(invite.invites[0]).sort(), ['createdAt', 'expiresAt', 'id', 'note']);
  assert.ok(!JSON.stringify(invite.invites).includes(invite.token), 'the link itself is not listed');
  // A second invite, with a note, can be revoked before anyone uses it.
  const spare = (await ann.req('POST', '/api/admin/invites', { note: '  for Kira  ' })).body;
  const spareRow = spare.invites.find((i) => i.note === 'for Kira');
  assert.equal(spare.invites.length, 2);
  assert.equal((await ann.req('DELETE', '/api/admin/invites?id=nope')).status, 400);
  assert.equal((await ann.req('DELETE', `/api/admin/invites?id=${spareRow.id}`)).body.invites.length, 1);
  assert.equal((await anon.req('POST', '/api/signup', { token: spare.token, username: 'kira', password: 'password-kira' })).status, 404, 'revoked invite no longer works');
  assert.equal((await anon.req('GET', `/api/link?kind=invite&token=${spare.token}`)).status, 404);
  assert.ok(!JSON.stringify(store.data.invites).includes(invite.token), 'only a hash of the invite is stored');
  assert.deepEqual((await anon.req('GET', `/api/link?kind=invite&token=${invite.token}`)).body, { kind: 'invite', username: null });
  assert.equal((await bob.req('POST', '/api/signup', { token: invite.token, username: 'ANN', password: 'password-bob' })).status, 409, 'username taken, any case');
  assert.equal((await bob.req('POST', '/api/signup', { token: invite.token, username: 'bob', password: 'password-bob' })).status, 200);
  assert.equal((await anon.req('POST', '/api/signup', { token: invite.token, username: 'eve', password: 'password-eve' })).status, 404, 'invite already used');

  // Bob starts empty and sees nothing of Ann's.
  const bobState = (await bob.req('GET', '/api/state')).body;
  assert.deepEqual([bobState.me.username, bobState.me.admin, bobState.shows, bobState.settings.ntfyUrl], ['bob', false, {}, '']);
  await bob.req('POST', '/api/shows', { source: 'anilist', id: 9 });
  await bob.req('POST', '/api/watched', { ids: ['anilist:9:1'] });
  const annState = (await ann.req('GET', '/api/state')).body;
  assert.deepEqual(Object.keys(annState.shows), ['anilist:5']);
  assert.deepEqual(annState.watched, []);
  assert.ok(!JSON.stringify((await bob.req('GET', '/api/state')).body).includes('anns-private-topic'));
  assert.notEqual(annState.feedToken, bobState.feedToken);
  assert.match((await anon.req('GET', `/calendar.ics?token=${bobState.feedToken}`)).body, /Show 9/);
  assert.doesNotMatch((await anon.req('GET', `/calendar.ics?token=${bobState.feedToken}`)).body, /Show 5/);
  assert.equal((await bob.req('GET', '/api/export')).body.shows.length, 1);
  // Bob cannot act on a show that only Ann tracks.
  assert.equal((await bob.req('POST', '/api/shows/mute', { key: 'anilist:5' })).status, 400);
  await bob.req('DELETE', '/api/shows?key=anilist:5');
  assert.deepEqual(Object.keys((await ann.req('GET', '/api/state')).body.shows), ['anilist:5'], "Ann's list is untouched");

  // Admin functions are closed to Bob, and show the admin names only.
  for (const [m, p, b] of [['GET', '/api/admin/users'], ['POST', '/api/admin/invites'], ['DELETE', '/api/admin/invites?id=0123456789abcdef'], ['POST', '/api/admin/reset', { id: 'u1' }], ['DELETE', '/api/admin/users?id=x']]) {
    assert.equal((await bob.req(m, p, b)).status, 403, `${m} ${p}`);
  }
  const roster = (await ann.req('GET', '/api/admin/users')).body;
  assert.deepEqual(roster.users.map((x) => [x.username, x.admin]), [['ann', true], ['bob', false]]);
  assert.deepEqual(Object.keys(roster.users[1]).sort(), ['admin', 'createdAt', 'id', 'mfa', 'username'], 'no list data in the admin view');
  assert.equal(roster.encrypted, false);

  // Sharing is off until switched on, shows titles only, and can be withdrawn.
  assert.equal((await anon.req('GET', '/api/shared?token=')).status, 404);
  const share = (await bob.req('POST', '/api/share', { enabled: true })).body.shareToken;
  const shared = (await anon.req('GET', `/api/shared?token=${share}`)).body;
  assert.deepEqual([shared.username, shared.list.map((x) => x.key)], ['bob', ['anilist:9']]);
  assert.deepEqual(Object.keys(shared).sort(), ['list', 'username']);
  assert.equal(shared.list[0].addedAt, undefined);
  await bob.req('POST', '/api/share', { enabled: false });
  assert.equal((await anon.req('GET', `/api/shared?token=${share}`)).status, 404);

  // Password reset by one-time link from the admin.
  const bobId = roster.users[1].id;
  const reset = (await ann.req('POST', '/api/admin/reset', { id: bobId })).body.token;
  assert.equal((await anon.req('GET', `/api/link?kind=reset&token=${reset}`)).body.username, 'bob');
  assert.equal((await anon.req('POST', '/api/reset', { token: reset, password: 'short' })).status, 400);
  const fresh = client('198.51.100.4');
  assert.equal((await fresh.req('POST', '/api/reset', { token: reset, password: 'new-password-bob' })).status, 200);
  assert.equal((await fresh.req('GET', '/api/state')).body.me.username, 'bob');
  assert.equal((await bob.req('GET', '/api/state')).status, 401, 'old sessions end on reset');
  assert.equal((await anon.req('POST', '/api/reset', { token: reset, password: 'again-password' })).status, 404, 'single use');
  assert.equal((await bob.req('POST', '/api/login', { username: 'bob', password: 'password-bob' })).status, 401);

  // Deleting an account removes its data and frees shows nobody else tracks.
  assert.equal((await ann.req('DELETE', `/api/admin/users?id=${roster.users[0].id}`)).status, 400, 'not your own');
  assert.deepEqual((await ann.req('DELETE', `/api/admin/users?id=${bobId}`)).body.users.map((x) => x.username), ['ann']);
  assert.equal((await fresh.req('GET', '/api/state')).status, 401);
  assert.deepEqual(Object.keys(store.data.catalog), ['anilist:5']);
});

test('http hardening: malformed requests do not crash, guesses are limited', async (t) => {
  const { setupCode, base, server, client } = await serve(t);
  const port = server.address().port;
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

  const guesser = client('203.0.113.1');
  for (let i = 0; i < 8; i++) assert.equal((await guesser.req('POST', '/api/setup', { username: 'ann', password: 'long enough pw', code: 'x' })).status, 403);
  assert.equal((await guesser.req('POST', '/api/setup', { username: 'ann', password: 'long enough pw', code: setupCode })).status, 429);
  assert.equal((await client('203.0.113.2').req('POST', '/api/setup', { username: 'ann', password: 'long enough pw', code: setupCode })).status, 200);

  const g2 = client('203.0.113.3');
  for (let i = 0; i < 8; i++) assert.equal((await g2.req('POST', '/api/login', { username: 'ann', password: 'wrong' })).status, 401);
  assert.equal((await g2.req('POST', '/api/login', { username: 'ann', password: 'long enough pw' })).status, 429);
  assert.equal((await client('203.0.113.4').req('POST', '/api/login', { username: 'ann', password: 'long enough pw' })).status, 200);

  // Invite, reset and share links cannot be guessed at speed either.
  const g3 = client('203.0.113.5');
  for (let i = 0; i < 8; i++) assert.equal((await g3.req('GET', `/api/shared?token=guess${i}`)).status, 404);
  assert.equal((await g3.req('GET', '/api/link?kind=invite&token=guess')).status, 429);
});

test('mailer: off unless fully configured, links use the configured address', () => {
  assert.equal(createMailer().enabled, false);
  assert.equal(createMailer({ apiKey: 'k', from: 'a@b.co' }).enabled, false, 'needs a public URL');
  assert.equal(createMailer({ apiKey: 'k', from: 'a@b.co', publicUrl: 'http://insecure.example' }).enabled, false, 'https only');
  const m = createMailer({ apiKey: 'k', from: 'a@b.co', publicUrl: 'https://shows.example/some/path' });
  assert.equal(m.enabled, true);
  assert.equal(m.link('reset', 'tok'), 'https://shows.example/#reset=tok');
  assert.equal(cleanEmail('  Ann@Example.com '), 'Ann@Example.com');
  for (const bad of ['', 'nope', 'a@b', 'a b@c.de', 'a@b.c\nBcc: x@y.zz', '<a@b.co>', 42]) assert.equal(cleanEmail(bad), null);
});

test('http: e-mail confirmation and forgot-password', async (t) => {
  const outbox = [];
  const mailer = { enabled: true, link: (kind, token) => `https://shows.example/#${kind}=${token}`, send: async (m) => void outbox.push(m) };
  const { setupCode, store, client } = await serve(t, { mailer });
  const ann = client('198.51.100.1');
  const anon = client('198.51.100.9');
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  assert.equal((await anon.req('GET', '/api/session')).body.mail, true);
  const tokenIn = (m) => /#\w+=([\w-]+)/.exec(m.text)[1];
  const settle = () => new Promise((r) => setTimeout(r, 20));

  // No address on file yet: asking for a reset sends nothing, and says nothing.
  assert.deepEqual((await anon.req('POST', '/api/forgot', { identifier: 'ann' })).body, { ok: true });
  assert.deepEqual((await anon.req('POST', '/api/forgot', { identifier: 'nobody' })).body, { ok: true });
  await settle();
  assert.equal(outbox.length, 0);

  // An address only counts once its link has been opened.
  assert.equal((await ann.req('PUT', '/api/account/email', { email: 'not an address', password: 'password-ann' })).status, 400);
  assert.equal((await ann.req('PUT', '/api/account/email', { email: 'ann@example.com' })).status, 403, 'needs the password');
  assert.equal((await ann.req('PUT', '/api/account/email', { email: 'ann@example.com', password: 'wrong' })).status, 403);
  const pending = (await ann.req('PUT', '/api/account/email', { email: 'ann@example.com', password: 'password-ann' })).body;
  assert.deepEqual([pending.me.email, pending.me.pendingEmail], ['', 'ann@example.com']);
  assert.equal(outbox.length, 1);
  assert.deepEqual([outbox[0].to, outbox[0].text.includes('https://shows.example/#confirm=')], ['ann@example.com', true]);
  assert.ok(!JSON.stringify(store.data.users).includes(tokenIn(outbox[0])), 'only a hash of the link is stored');
  await anon.req('POST', '/api/forgot', { identifier: 'ann@example.com' });
  await settle();
  assert.equal(outbox.length, 1, 'unconfirmed address is not used');
  assert.equal((await anon.req('POST', '/api/email/confirm', { token: 'wrong' })).status, 404);
  assert.equal((await anon.req('POST', '/api/email/confirm', { token: tokenIn(outbox[0]) })).body.email, 'ann@example.com');
  assert.equal((await anon.req('POST', '/api/email/confirm', { token: tokenIn(outbox[0]) })).status, 404, 'single use');
  assert.deepEqual((await ann.req('GET', '/api/state')).body.me.email, 'ann@example.com');

  // Forgot password, by username or by address, then reset with the mailed link.
  await client('198.51.100.10').req('POST', '/api/forgot', { identifier: 'ANN' });
  await client('198.51.100.11').req('POST', '/api/forgot', { identifier: 'Ann@Example.com' });
  await settle();
  assert.equal(outbox.length, 3);
  assert.equal(outbox[2].subject, 'Reset your Show Tracker password');
  const fresh = client('198.51.100.12');
  assert.equal((await fresh.req('POST', '/api/reset', { token: tokenIn(outbox[2]), password: 'brand-new-password' })).status, 200);
  assert.equal((await fresh.req('GET', '/api/state')).body.me.username, 'ann');
  assert.equal((await ann.req('GET', '/api/state')).status, 401, 'old sessions end');

  // No more than three reset mails an hour per account, whoever asks.
  for (let i = 0; i < 4; i++) await client(`198.51.100.${20 + i}`).req('POST', '/api/forgot', { identifier: 'ann' });
  await settle();
  assert.equal(outbox.length, 4, 'third and later requests this hour are dropped');
  // And one client cannot hammer the form.
  const pest = client('198.51.100.40');
  for (let i = 0; i < 8; i++) await pest.req('POST', '/api/forgot', { identifier: `x${i}` });
  assert.equal((await pest.req('POST', '/api/forgot', { identifier: 'ann' })).status, 429);

  // Removing the address switches recovery by mail off for the account.
  assert.equal((await fresh.req('PUT', '/api/account/email', { email: '', password: 'brand-new-password' })).body.me.email, '');
  // The admin roster never includes addresses.
  await fresh.unlockAdmin('brand-new-password');
  const rosterText = JSON.stringify((await fresh.req('GET', '/api/admin/users')).body);
  // No address of any kind in what the admin sees: checked by the "@" every address has.
  assert.ok(rosterText.includes('"ann"') && !rosterText.includes('@'));
});

test('http: e-mail features are closed when mail is not configured', async (t) => {
  const { setupCode, client } = await serve(t);
  const ann = client();
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  assert.equal((await ann.req('POST', '/api/forgot', { identifier: 'ann' })).status, 404);
  assert.equal((await ann.req('PUT', '/api/account/email', { email: 'ann@example.com', password: 'password-ann' })).status, 400);
  assert.equal((await ann.req('GET', '/api/state')).body.mail, false);
});

// ---------------------------------------------------------------- passkeys

/** A software authenticator: makes the same responses a browser would send. */
function fakeAuthenticator(origin, rpId, { rsa = false } = {}) {
  const { publicKey, privateKey } = rsa ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const id = randomBytes(16);
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const rpHash = createHash('sha256').update(rpId).digest();
  const authData = (flags, count, attested) => {
    const head = Buffer.concat([rpHash, Buffer.from([flags]), Buffer.from([0, 0, 0, count])]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(id.length);
    return attested ? Buffer.concat([head, Buffer.alloc(16), len, id, Buffer.from('a0', 'hex')]) : head;
  };
  const client = (type, challenge, over = {}) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...over }));
  let count = 0;
  return {
    id: b64u(id),
    create(options, over = {}) {
      return {
        id: b64u(id),
        clientDataJSON: b64u(client('webauthn.create', options.challenge, over)),
        authenticatorData: b64u(authData(0x45, 0, true)),
        publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' })),
        alg: rsa ? -257 : -7,
        transports: ['internal'],
      };
    },
    get(options, over = {}) {
      const cdj = client('webauthn.get', options.challenge, over);
      const ad = authData(0x05, ++count, false);
      const signature = cryptoSign('sha256', Buffer.concat([ad, createHash('sha256').update(cdj).digest()]), privateKey);
      return { id: b64u(id), clientDataJSON: b64u(cdj), authenticatorData: b64u(ad), signature: b64u(signature) };
    },
  };
}

test('http: passkeys as a second sign-in step, recovery codes, and no bypass by reset', async (t) => {
  const ORIGIN = 'https://shows.example';
  const outbox = [];
  const mailer = { enabled: true, link: (k, tok) => `${ORIGIN}/#${k}=${tok}`, send: async (m) => void outbox.push(m) };
  const { setupCode, store, client } = await serve(t, { publicUrl: ORIGIN, mailer });
  const ann = client('198.51.100.1');
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  assert.deepEqual((await ann.req('GET', '/api/state')).body.me.passkeys, []);

  // Registering: the challenge is single use and the origin must be ours.
  const key = fakeAuthenticator(ORIGIN, 'shows.example');
  let opts = (await ann.req('POST', '/api/passkeys/options')).body;
  assert.deepEqual([opts.rp.id, opts.user.name, opts.attestation], ['shows.example', 'ann', 'none']);
  assert.equal((await ann.req('POST', '/api/passkeys', { name: 'Laptop', response: key.create(opts, { origin: 'https://evil.example' }) })).status, 400);
  assert.equal((await ann.req('POST', '/api/passkeys', { name: 'Laptop', response: key.create(opts) })).status, 400, 'challenge was used up by the failed try');
  opts = (await ann.req('POST', '/api/passkeys/options')).body;
  const added = (await ann.req('POST', '/api/passkeys', { name: 'Laptop', response: key.create(opts) })).body;
  assert.deepEqual(added.me.passkeys.map((k) => k.name), ['Laptop']);
  assert.equal(added.recoveryCodes.length, 10);
  assert.match(added.recoveryCodes[0], /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal(added.me.recoveryCodesLeft, 10);
  assert.ok(!JSON.stringify(store.data.users).includes(added.recoveryCodes[0]), 'recovery codes are stored hashed');
  assert.ok(!JSON.stringify(added.me).includes('publicKey'));

  // A second passkey (RSA this time) does not reissue recovery codes.
  const phone = fakeAuthenticator(ORIGIN, 'shows.example', { rsa: true });
  opts = (await ann.req('POST', '/api/passkeys/options')).body;
  assert.deepEqual(opts.excludeCredentials.map((c) => c.id), [key.id]);
  const second = (await ann.req('POST', '/api/passkeys', { name: 'Phone', response: phone.create(opts) })).body;
  assert.equal(second.recoveryCodes, null);
  opts = (await ann.req('POST', '/api/passkeys/options')).body;
  assert.equal((await ann.req('POST', '/api/passkeys', { name: 'Again', response: phone.create(opts) })).status, 409, 'same passkey twice');

  // Signing in now takes two steps; the password alone gives no session.
  const dev = client('198.51.100.2');
  const step1 = (await dev.req('POST', '/api/login', { username: 'ann', password: 'password-ann' })).body;
  assert.equal(step1.mfa, true);
  assert.deepEqual(step1.options.allowCredentials.map((c) => c.id), [key.id, phone.id]);
  assert.equal((await dev.req('GET', '/api/state')).status, 401, 'not signed in after the password alone');
  assert.match(dev.cookie, /^st_pending=/);
  const pending = dev.cookie;

  // Wrong passkey, wrong site, tampered signature: all refused, each with a fresh challenge.
  const stranger = fakeAuthenticator(ORIGIN, 'shows.example');
  let bad = await dev.req('POST', '/api/login/passkey', { response: stranger.get(step1.options) });
  assert.equal(bad.status, 401);
  dev.cookie = pending;
  bad = await dev.req('POST', '/api/login/passkey', { response: fakeAuthenticator('https://evil.example', 'shows.example').get(bad.body.options) });
  assert.equal(bad.status, 401);
  dev.cookie = pending;
  const forged = key.get(bad.body.options);
  forged.signature = stranger.get(bad.body.options).signature;
  bad = await dev.req('POST', '/api/login/passkey', { response: forged });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'The passkey signature is not valid.');
  dev.cookie = pending;
  const replayOpts = bad.body.options;
  const good = key.get(replayOpts);
  assert.equal((await dev.req('POST', '/api/login/passkey', { response: good })).status, 200);
  assert.equal((await dev.req('GET', '/api/state')).body.me.username, 'ann');

  // The same signed response cannot be replayed, and the second step needs the first.
  const replay = client('198.51.100.3');
  replay.cookie = pending;
  assert.equal((await replay.req('POST', '/api/login/passkey', { response: good })).status, 401);
  assert.equal((await client('198.51.100.4').req('POST', '/api/login/passkey', { response: good })).status, 401);
  assert.equal((await client('198.51.100.4').req('POST', '/api/login/recovery', { code: added.recoveryCodes[0] })).status, 401);

  // The RSA passkey works too.
  const dev2 = client('198.51.100.5');
  const s2 = (await dev2.req('POST', '/api/login', { username: 'ann', password: 'password-ann' })).body;
  assert.equal((await dev2.req('POST', '/api/login/passkey', { response: phone.get(s2.options) })).status, 200);

  // Recovery codes: one use each, forgiving about formatting.
  const lost = client('198.51.100.6');
  await lost.req('POST', '/api/login', { username: 'ann', password: 'password-ann' });
  const lostPending = lost.cookie;
  assert.equal((await lost.req('POST', '/api/login/recovery', { code: 'aaaaa-aaaaa' })).status, 401);
  lost.cookie = lostPending;
  const code = added.recoveryCodes[3];
  const viaCode = await lost.req('POST', '/api/login/recovery', { code: ` ${code.toUpperCase().replace('-', ' ')} ` });
  assert.deepEqual([viaCode.status, viaCode.body.recoveryCodesLeft], [200, 9]);
  const again = client('198.51.100.7');
  await again.req('POST', '/api/login', { username: 'ann', password: 'password-ann' });
  assert.equal((await again.req('POST', '/api/login/recovery', { code })).status, 401, 'a code works once');
  const fresh = (await lost.req('POST', '/api/recovery-codes')).body;
  assert.equal(fresh.me.recoveryCodesLeft, 10);
  assert.notDeepEqual(fresh.recoveryCodes, added.recoveryCodes);

  // An e-mailed reset link changes the password but does not skip the passkey.
  store.data.users[added.me.id].email = 'ann@example.com';
  await client('198.51.100.8').req('POST', '/api/forgot', { identifier: 'ann' });
  await new Promise((r) => setTimeout(r, 20));
  const resetToken = /#reset=([\w-]+)/.exec(outbox.at(-1).text)[1];
  const thief = client('198.51.100.9');
  const afterReset = await thief.req('POST', '/api/reset', { token: resetToken, password: 'thief-password' });
  assert.deepEqual([afterReset.status, afterReset.body.mfa], [200, true]);
  assert.equal((await thief.req('GET', '/api/state')).status, 401, 'a reset link alone does not sign in');

  // The reset signed every device out; Ann gets back in with the new password plus her passkey.
  assert.equal((await lost.req('GET', '/api/state')).status, 401);
  const back = (await lost.req('POST', '/api/login', { username: 'ann', password: 'thief-password' })).body;
  assert.equal((await lost.req('POST', '/api/login/passkey', { response: key.get(back.options) })).status, 200);

  // Admin can clear another person's protection, not snoop on it; removing the last passkey turns it off.
  // Opening the admin pages takes the passkey for an account that has one: the password will not do.
  const gate = (await lost.req('GET', '/api/admin/unlock')).body;
  assert.deepEqual([gate.unlocked, gate.method, gate.options.allowCredentials.length], [false, 'passkey', 2]);
  assert.equal((await lost.req('POST', '/api/admin/unlock', { password: 'thief-password' })).status, 403);
  assert.equal((await lost.req('POST', '/api/admin/unlock', { response: stranger.get(gate.options) })).status, 403);
  assert.equal((await lost.req('POST', '/api/admin/invites')).status, 403);
  const gate2 = (await lost.req('GET', '/api/admin/unlock')).body;
  assert.equal((await lost.req('POST', '/api/admin/unlock', { response: key.get(gate2.options) })).status, 200);
  // A recovery code works too (for a device without the passkey), once.
  const spareSession = client('198.51.100.30');
  const sp = (await spareSession.req('POST', '/api/login', { username: 'ann', password: 'thief-password' })).body;
  await spareSession.req('POST', '/api/login/passkey', { response: phone.get(sp.options) });
  const freshCodes = (await spareSession.req('POST', '/api/recovery-codes')).body.recoveryCodes;
  assert.equal((await spareSession.req('POST', '/api/admin/unlock', { code: freshCodes[0] })).status, 200);
  assert.equal((await spareSession.req('GET', '/api/admin/users')).status, 200);
  // Logging out drops the confirmation with the session.
  await spareSession.req('POST', '/api/logout');
  assert.equal(spareSession.admin, '');

  const bobInvite = (await lost.req('POST', '/api/admin/invites')).body.token;
  const bob = client('198.51.100.10');
  await bob.req('POST', '/api/signup', { token: bobInvite, username: 'bob', password: 'password-bob' });
  const bobKey = fakeAuthenticator(ORIGIN, 'shows.example');
  await bob.req('POST', '/api/passkeys', { name: 'Bob key', response: bobKey.create((await bob.req('POST', '/api/passkeys/options')).body) });
  const roster = (await lost.req('GET', '/api/admin/users')).body.users;
  assert.deepEqual(roster.map((x) => [x.username, x.mfa]), [['ann', true], ['bob', true]]);
  assert.equal((await bob.req('POST', '/api/admin/mfa/clear', { id: roster[0].id })).status, 403);
  assert.equal((await lost.req('POST', '/api/admin/mfa/clear', { id: roster[1].id })).body.users[1].mfa, false);
  assert.equal((await bob.req('GET', '/api/state')).status, 401, 'cleared account is signed out');
  assert.equal((await bob.req('POST', '/api/login', { username: 'bob', password: 'password-bob' })).body.ok, true, 'and signs in with the password alone again');

  // Removing a passkey needs the password again, not just a signed-in browser.
  assert.equal((await lost.req('POST', '/api/passkeys/remove', { id: key.id })).status, 403);
  assert.equal((await lost.req('POST', '/api/passkeys/remove', { id: key.id, password: 'password-ann' })).status, 403, 'the old password');
  assert.equal((await lost.req('GET', '/api/state')).body.me.passkeys.length, 2);
  await lost.req('POST', '/api/passkeys/remove', { id: key.id, password: 'thief-password' });
  const off = (await lost.req('POST', '/api/passkeys/remove', { id: phone.id, password: 'thief-password' })).body;
  assert.deepEqual([off.me.passkeys, off.me.recoveryCodesLeft], [[], 0]);
});

test('movies: opening-day alert for tracked films, and a heads-up for new anime cinema dates', async () => {
  const { clock, sent, sources, store, user, tracker, start } = rig();
  sources.fetchMovie = async (id) => fakeMovie(id, { t: start });
  const upcoming = (id) => fakeMovie(id, { t: start + 30 * DAY }, { title: `Anime Film ${id}` });
  // Already listed when this account is first looked at (by the first tick).
  sources.cinemaList = [upcoming(1), fakeMovie(300, { t: start })];
  await tracker.addShow(user, 'tmdb', 300);
  assert.deepEqual(Object.keys(store.data.catalog), ['tmdb:300']);
  clock.t += 2 * 60_000;
  await tracker.tick();
  assert.equal(sent.flat().at(-1).body, 'Opens in US cinemas today');

  // Cinema watch: the first look is silent, later additions are announced once.
  const before = sent.length;
  await tracker.refreshCinema();
  assert.equal(sent.length, before, 'what was already listed is not announced');
  sources.cinemaList = [upcoming(1), upcoming(2), fakeMovie(300, { t: start })];
  await tracker.refreshCinema();
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1)[0].title, 'Anime Film 2');
  assert.match(sent.at(-1)[0].body, /^Anime film coming to US cinemas on \w{3} \d+$/);
  assert.equal(user.alerts[0].ep.label, 'Coming to US cinemas');
  await tracker.refreshCinema();
  assert.equal(sent.length, before + 1, 'once only');
  user.settings.cinemaAlerts = false;
  sources.cinemaList = [...sources.cinemaList, upcoming(3)];
  await tracker.refreshCinema();
  assert.equal(sent.length, before + 1, 'switched off');
  assert.equal(tracker.cinema().list.length, 4);
});

test('http: movie routes, and closed when no movie key is configured', async (t) => {
  const { setupCode, sources, client } = await serve(t);
  const ann = client();
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  assert.equal((await ann.req('GET', '/api/state')).body.movies, true);
  assert.equal((await ann.req('GET', '/api/search?source=movie&q=totoro')).body[0].title, 'totoro');
  const added = (await ann.req('POST', '/api/shows', { source: 'tmdb', id: 300 })).body;
  assert.deepEqual(Object.keys(added.shows), ['tmdb:300']);
  assert.match((await ann.req('GET', `/calendar.ics?token=${added.feedToken}`)).body, /SUMMARY:Film 300 – In US cinemas/);
  sources.cinemaList = [fakeMovie(1, { t: Date.now() + DAY })];
  assert.deepEqual((await ann.req('GET', '/api/cinema')).body.list.map((m) => m.key), ['tmdb:1']);
  assert.equal((await ann.req('PUT', '/api/settings', { cinemaAlerts: false })).body.settings.cinemaAlerts, false);
  const exported = (await ann.req('GET', '/api/export')).body;
  assert.deepEqual(exported.shows.map((x) => x.source), ['tmdb']);

  sources.movies = false;
  assert.equal((await ann.req('GET', '/api/state')).body.movies, false);
  for (const [m, p, b] of [['GET', '/api/search?source=movie&q=totoro'], ['GET', '/api/cinema'], ['POST', '/api/shows', { source: 'tmdb', id: 301 }]]) {
    assert.equal((await ann.req(m, p, b)).status, 400, `${m} ${p}`);
  }
});

// ---------------------------------------------------------------- browser extension

test('matchEpisode translates a streaming site\'s numbering to tracked episodes', () => {
  assert.equal(normTitle('SPY×FAMILY: Code – White!'), 'spyxfamilycodewhite');
  const show = (id, title, franchise, extra = {}) => ({ key: `anilist:${id}`, source: 'anilist', id, title, altTitle: null, franchise, ...extra });
  const spy = [
    show(1, 'SPY x FAMILY', { root: 'SPY x FAMILY', offset: 0, index: 1, count: 12 }),
    show(3, 'SPY x FAMILY Season 2', { root: 'SPY x FAMILY', offset: 25, index: 3, count: 12 }),
    show(4, 'SPY x FAMILY Season 3', { root: 'SPY x FAMILY', offset: 37, index: 4, count: 13 }),
  ];
  const at = (item, shows) => {
    const hit = matchEpisode(item, shows);
    return hit && [hit.show.id, hit.number];
  };
  // Counted straight through: E42 is the fifth episode of season 3, E5 the fifth of season 1.
  assert.deepEqual(at({ series: 'SPY x FAMILY', season: null, episode: 42 }, spy), [4, 5]);
  assert.deepEqual(at({ series: 'spy × family', season: null, episode: 5 }, spy), [1, 5]);
  assert.deepEqual(at({ series: 'SPY x FAMILY', season: null, episode: 30 }, spy), [3, 5]);
  // E20 belongs to a season that is not tracked (cour 2): no guess.
  assert.equal(at({ series: 'SPY x FAMILY', season: null, episode: 20 }, spy), null);
  assert.equal(at({ series: 'SPY x FAMILY', season: null, episode: 99 }, spy), null);

  // The site names the season and restarts numbering.
  const cuckoos = [show(10, 'A Couple of Cuckoos', { root: 'A Couple of Cuckoos', offset: 0, index: 1, count: 24 }), show(11, 'A Couple of Cuckoos Season 2', { root: 'A Couple of Cuckoos', offset: 24, index: 2, count: 12 })];
  assert.deepEqual(at({ series: 'A Couple of Cuckoos', season: 2, episode: 11 }, cuckoos), [11, 11]);
  assert.deepEqual(at({ series: 'A Couple of Cuckoos', season: null, episode: 24 }, cuckoos), [10, 24]);
  // Only season 2 tracked, and the site says "S2": still placed.
  assert.deepEqual(at({ series: 'A Couple of Cuckoos', season: 2, episode: 3 }, [cuckoos[1]]), [11, 3]);

  // A site that names the season but keeps counting: "Season 2, E25" of a 20 + 12 episode show.
  const eminence = [show(30, 'The Eminence in Shadow', { root: 'The Eminence in Shadow', offset: 0, index: 1, count: 20 }), show(31, 'The Eminence in Shadow Season 2', { root: 'The Eminence in Shadow', offset: 20, index: 2, count: 12 })];
  assert.deepEqual(at({ series: 'The Eminence in Shadow', season: 2, episode: 25 }, eminence), [31, 5]);
  assert.deepEqual(at({ series: 'The Eminence in Shadow', season: 2, episode: 5 }, eminence), [31, 5]);
  assert.deepEqual(at({ series: 'The Eminence In Shadow', season: 1, episode: 20 }, eminence), [30, 20]);
  assert.equal(at({ series: 'The Eminence in Shadow', season: 2, episode: 40 }, eminence), null);
  // Season 1's E18 must not land on a tracked 12-episode season 2.
  assert.equal(at({ series: 'A Couple of Cuckoos', season: null, episode: 18 }, [cuckoos[1]]), null);
  // The site splits seasons differently (its "S2" is our third entry): placed when only one fits.
  assert.deepEqual(at({ series: 'SPY x FAMILY', season: 2, episode: 3 }, [spy[1]]), [3, 3]);
  // Place among its seasons not looked up yet: no guessing.
  assert.equal(at({ series: 'Overgeared', season: null, episode: 7 }, [show(20, 'Overgeared', undefined)]), null);
  assert.deepEqual(at({ series: 'Overgeared', season: null, episode: 7 }, [show(20, 'Overgeared', { root: 'Overgeared', offset: 0, index: 1, count: null })]), [20, 7]);
  assert.equal(at({ series: 'Totally Different', season: null, episode: 1 }, spy), null);
  assert.equal(at({ series: 'Spy', season: null, episode: 1 }, spy), null, 'a short prefix is not enough');
  assert.equal(at({ series: 'SPY x FAMILY', season: null, episode: 0 }, spy), null);
  assert.equal(at({ series: 'SPY x FAMILY', season: null, episode: 1 }, [{ ...spy[0], source: 'tvmaze' }]), null);
});

test('http: access tokens and the extension endpoint', async (t) => {
  const { setupCode, sources, tracker, store, client, base } = await serve(t);
  const ann = client('198.51.100.1');
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  sources.franchises[4] = { root: 'Show 1', offset: 37, index: 4, count: 13 };
  // Tracked: "Show 4", which is season 4 of the "Show 1" franchise.
  await ann.req('POST', '/api/shows', { source: 'anilist', id: 4 });

  const made = (await ann.req('POST', '/api/tokens', { name: 'Firefox' })).body;
  assert.match(made.token, /^st_[\w-]{20,}$/);
  assert.deepEqual(made.me.apiTokens.map((x) => [x.name, x.lastUsedAt]), [['Firefox', null]]);
  assert.ok(!JSON.stringify(made.me).includes(made.token.slice(3)), 'the token is shown once, not listed');

  // The extension talks from another origin, with the token and no cookie.
  const ext = (method, path, body, token = made.token) =>
    fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, Origin: 'moz-extension://abc', 'X-Forwarded-For': '198.51.100.50', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.deepEqual((await ext('GET', '/api/ext/ping')).body, { ok: true, username: 'ann' });
  assert.equal((await ext('GET', '/api/ext/ping', null, 'st_' + 'x'.repeat(32))).status, 401);
  assert.equal((await ext('GET', '/api/state')).status, 401, 'a token opens only the extension routes');
  assert.equal((await ext('POST', '/api/shows', { source: 'anilist', id: 9 })).status, 403, 'and cannot act as the session');

  // What the tracker's own title search will answer when it looks suggestions up.
  sources.searchAnime = async (q) => (q === 'Unknown Thing' ? [fakeShow(70, { t: Date.now() }, { title: 'Unknown Thing' })] : q === 'Wishlisted' ? [fakeShow(71, { t: Date.now() }, { title: 'Wishlisted Season 2' }), fakeShow(72, { t: Date.now() }, { title: 'Wishlisted' })] : [fakeShow(73, { t: Date.now() }, { title: 'Something Else Entirely' })]);
  const items = [
    { series: 'Show 1', season: null, episode: 42 },
    { series: 'Show 1', season: null, episode: 39 },
    { series: 'Unknown Thing', season: null, episode: 1 },
    { series: 'Unknown Thing', season: null, episode: 2 },
  ];
  let res = await ext('POST', '/api/ext/watched', { items });
  assert.equal(res.body.pending, 1, 'season lookup has not run yet');
  await tracker.fillFranchises();
  res = await ext('POST', '/api/ext/watched', { items });
  assert.deepEqual(res.body, { received: 4, matched: 2, added: 2, unmatched: [{ series: 'Unknown Thing', count: 2 }], pending: 0, suggested: 1 });

  // The untracked series becomes a Discover suggestion once looked up; a tracked one never does.
  const user = Object.values(store.data.users)[0];
  await tracker.resolveSeen(user, 10);
  let disc = (await ann.req('GET', '/api/discover')).body;
  assert.deepEqual(disc.seen.map((x) => [x.key, x.from, x.provider]), [['anilist:70', 'history', 'crunchyroll']]);

  // Watchlist: tracked series are skipped, the rest are offered, and a title with no real match is dropped.
  const seen = await ext('POST', '/api/ext/seen', { provider: 'crunchyroll', series: ['Show 1', 'Wishlisted', 'No Such Anime', 'Unknown Thing'] });
  assert.deepEqual(seen.body, { received: 4, suggested: 2, alreadyTracked: 2 });
  assert.equal((await ext('POST', '/api/ext/seen', { provider: 'nope', series: [] })).status, 400);
  await tracker.resolveSeen(user, 10);
  disc = (await ann.req('GET', '/api/discover')).body;
  assert.deepEqual(disc.seen.map((x) => [x.key, x.from]), [['anilist:70', 'watchlist'], ['anilist:71', 'watchlist']], 'watchlist entries first; the history entry is upgraded');
  assert.equal(disc.seenPending, 0);
  // Tracking or dismissing a suggestion removes it.
  await ann.req('POST', '/api/shows', { source: 'anilist', id: 70 });
  await ann.req('POST', '/api/discover/dismiss', { key: 'anilist:71' });
  assert.deepEqual((await ann.req('GET', '/api/discover')).body.seen, []);
  assert.deepEqual((await ann.req('GET', '/api/state')).body.watched.sort(), ['anilist:4:2', 'anilist:4:5']);
  assert.equal((await ext('POST', '/api/ext/watched', { items })).body.added, 0, 'sending the same history again changes nothing');
  assert.equal((await ext('POST', '/api/ext/watched', { items: [{ series: 'x', episode: 'nope' }] })).status, 400);
  assert.ok((await ann.req('GET', '/api/state')).body.me.apiTokens[0].lastUsedAt > 0);

  // Removing the token cuts the extension off.
  assert.deepEqual((await ann.req('DELETE', `/api/tokens?id=${made.me.apiTokens[0].id}`)).body.me.apiTokens, []);
  assert.equal((await ext('GET', '/api/ext/ping')).status, 401);
});

// ---------------------------------------------------------------- operations

test('weekly backup e-mail: encrypted file to admins with an address, never unencrypted', async () => {
  const mk = (dataKey) => {
    const clock = { t: Date.UTC(2026, 10, 12, 12) };
    const outbox = [];
    const store = openStore(tmp(), dataKey ? { dataKey } : {});
    const admin = makeUser({ username: 'ann', admin: true, email: 'ann@example.com' });
    const friend = makeUser({ username: 'bob', email: 'bob@example.com' });
    store.data.users[admin.id] = admin;
    store.data.users[friend.id] = friend;
    const mailer = { enabled: true, send: async (m) => void outbox.push(m) };
    const tracker = createTracker({ store, sources: fakeSources(clock), send: async () => [], mailer, now: () => clock.t });
    return { clock, outbox, store, admin, tracker };
  };

  const { clock, outbox, store, admin, tracker } = mk('k'.repeat(40));
  await tracker.emailBackup();
  await tracker.emailBackup();
  assert.equal(outbox.length, 1, 'once, to the admin only');
  assert.equal(outbox[0].to, 'ann@example.com');
  assert.equal(outbox[0].attachments[0].filename, 'show-tracker-state-2026-11-12.json');
  const attached = outbox[0].attachments[0].content.toString();
  assert.ok(attached.startsWith('{"encrypted":true'));
  assert.ok(!attached.includes('ann@example.com') && !attached.includes('bob'), 'nothing readable in the attachment');
  clock.t += 8 * DAY;
  await tracker.emailBackup();
  assert.equal(outbox.length, 2, 'again a week later');
  store.data.site.backupEmail = false;
  clock.t += 8 * DAY;
  await tracker.emailBackup();
  assert.equal(outbox.length, 2, 'switched off');
  store.data.site.backupEmail = true;
  admin.email = '';
  await tracker.emailBackup();
  assert.equal(outbox.length, 2, 'no confirmed address, no mail');

  const plain = mk('');
  await plain.tracker.emailBackup();
  assert.equal(plain.outbox.length, 0, 'an unencrypted data file is never e-mailed');
});

test('admins are told when schedule updates fail for hours, and when they recover', async () => {
  const clock = { t: Date.UTC(2026, 10, 12, 12) };
  const pushes = [];
  const mails = [];
  const store = openStore(tmp());
  const sources = fakeSources(clock);
  const admin = makeUser({ username: 'ann', admin: true, email: 'ann@example.com' });
  const friend = makeUser({ username: 'bob' });
  store.data.users[admin.id] = admin;
  store.data.users[friend.id] = friend;
  const tracker = createTracker({ store, sources, send: async (settings, m) => {
      // Episode alerts go out too as the clock moves; only health messages are of interest here.
      if (m[0].title.startsWith('Show Tracker:')) pushes.push([settings === admin.settings ? 'admin' : 'other', m[0].title]);
      return [];
    },
    mailer: { enabled: true, send: async (m) => void mails.push(m.subject) },
    now: () => clock.t,
  });
  await tracker.addShow(friend, 'anilist', 5);
  await tracker.refresh();
  await tracker.checkHealth();
  assert.equal(pushes.length, 0, 'healthy: silence');

  sources.fail = true;
  clock.t += 4 * 60 * 60 * 1000;
  await tracker.refresh();
  await tracker.checkHealth();
  await tracker.checkHealth();
  assert.deepEqual(pushes, [['admin', 'Show Tracker: schedule updates are failing']], 'once, to the admin only');
  assert.deepEqual(mails, ['Show Tracker: schedule updates are failing']);

  sources.fail = false;
  await tracker.refresh();
  await tracker.checkHealth();
  assert.equal(pushes.at(-1)[1], 'Show Tracker: schedule updates are working again');
  store.data.site.healthAlerts = false;
  sources.fail = true;
  clock.t += 5 * 60 * 60 * 1000;
  await tracker.checkHealth();
  assert.equal(pushes.length, 2, 'switched off');
});

test('http: account owners are e-mailed when an admin acts on their account', async (t) => {
  const outbox = [];
  const mailer = { enabled: true, link: (k, tok) => `https://shows.example/#${k}=${tok}`, send: async (m) => void outbox.push(m) };
  const { setupCode, store, client } = await serve(t, { mailer });
  const ann = client('198.51.100.1');
  const bob = client('198.51.100.2');
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  await ann.unlockAdmin('password-ann');
  const invite = (await ann.req('POST', '/api/admin/invites', { note: 'bob' })).body.token;
  await bob.req('POST', '/api/signup', { token: invite, username: 'bob', password: 'password-bob' });
  const bobUser = Object.values(store.data.users).find((x) => x.username === 'bob');
  const settle = () => new Promise((r) => setTimeout(r, 20));

  await ann.req('POST', '/api/admin/reset', { id: bobUser.id });
  await settle();
  assert.equal(outbox.length, 0, 'no address on file: nothing to send');

  bobUser.email = 'bob@example.com';
  await ann.req('POST', '/api/admin/reset', { id: bobUser.id });
  await ann.req('POST', '/api/admin/mfa/clear', { id: bobUser.id });
  await settle();
  assert.deepEqual(outbox.map((m) => m.to), ['bob@example.com', 'bob@example.com']);
  assert.match(outbox[0].text, /admin \(ann\) created a password reset link for your account/);
  assert.match(outbox[1].text, /removed the passkeys and recovery codes/);
  assert.ok(!outbox[0].text.includes('#reset='), 'the reset link itself is not mailed');
  await ann.req('DELETE', `/api/admin/users?id=${bobUser.id}`);
  await settle();
  assert.match(outbox[2].text, /deleted your account/);

  // Site settings are admin-only and take only the known switches.
  const site = (await ann.req('PUT', '/api/admin/site', { backupEmail: false, healthAlerts: 'yes', other: 1 })).body.site;
  assert.deepEqual(site, { backupEmail: false, healthAlerts: true });
});

// ---------------------------------------------------------------- more sources, series folding

test('series: seasons are grouped by shared first season even without sequel links; recommendations list one season per series', async () => {
  const clock = { t: Date.UTC(2026, 10, 12) };
  const s = (id, title, year) => fakeShow(id, clock, { title, year });
  const shows = [s(1, 'Demon Slayer', 2019), s(2, 'Demon Slayer: Swordsmith Village Arc', 2023), s(3, 'Unrelated', 2020), s(4, 'Lonely Season 2', 2024)];
  const franchise = { 'anilist:1': { root: 'Demon Slayer' }, 'anilist:2': { root: 'Demon Slayer' }, 'anilist:3': { root: 'Unrelated' }, 'anilist:4': { root: 'Lonely' } };
  assert.deepEqual(withFranchiseRoots({}, shows, franchise), {
    'anilist:1': { id: 'anilist:1', title: 'Demon Slayer' },
    'anilist:2': { id: 'anilist:1', title: 'Demon Slayer' },
  });
  // An existing group gains the member its links missed, and keeps its name.
  const linked = { 'anilist:1': { id: 'anilist:1', title: 'Demon Slayer' }, 'anilist:9': { id: 'anilist:1', title: 'Demon Slayer' } };
  assert.equal(withFranchiseRoots(linked, shows, franchise)['anilist:2'].id, 'anilist:1');
  assert.deepEqual(withFranchiseRoots({}, [shows[2], shows[3]], franchise), {}, 'single seasons are not series');

  const sources = fakeSources(clock);
  sources.related.set(1, { sequels: [], recs: [{ rating: 9, media: media(51, 'Other Show Season 2') }, { rating: 8, media: media(50, 'Other Show') }, { rating: 7, media: media(52, 'Other Show Season 3') }, { rating: 6, media: media(60, 'Different') }] });
  const d = await computeDiscover({ shows: [shows[0]], sources, now: clock.t });
  assert.deepEqual(d.recs.map((r) => r.title), ['Other Show', 'Different'], 'one entry per series, shown as its first season');
});

test('streaming availability by country replaces the generic badges', async () => {
  const { store, sources, user, tracker } = rig();
  await tracker.addShow(user, 'anilist', 5);
  assert.deepEqual(tracker.showsOf(user)[0].streams.map((x) => x.name), ['Crunchyroll'], 'the source\'s own links until looked up');
  assert.equal(await tracker.fillAvailability(), 0, 'anime wait for their first-season title');

  sources.franchises[5] = { root: 'Show Five', offset: 0, index: 1, count: 12 };
  sources.availability['Show Five'] = { US: ['Netflix', 'Crunchyroll', 'Crunchyroll Amazon Channel', 'Netflix Standard with Ads', 'Obscure Stream'], GB: ['Disney Plus'] };
  await tracker.fillFranchises();
  assert.equal(await tracker.fillAvailability(), 1);
  assert.deepEqual(sources.asked, ['Show Five'], 'searched by the series name, not the season');
  const us = tracker.showsOf(user)[0];
  assert.deepEqual(us.streams.map((x) => [x.id, x.name]), [['netflix', 'Netflix'], ['crunchyroll', 'Crunchyroll'], [null, 'Obscure Stream']]);
  assert.equal(us.streams[1].url, 'https://crunchyroll.com/x', 'keeps the direct link where the source had one');
  assert.equal(us.streams[0].url, 'https://tmdb.example/watch?locale=US');
  assert.equal(us.streamsRegion, 'US');
  assert.equal(await tracker.fillAvailability(), 0, 'cached for a week');

  // Another country is looked up when a user moves there.
  user.settings.region = 'GB';
  assert.equal(await tracker.fillAvailability(), 1);
  assert.deepEqual(tracker.showsOf(user)[0].streams.map((x) => x.id), ['disney']);
  // Nothing listed for a country: the source's own links stay.
  user.settings.region = 'DE';
  await tracker.fillAvailability();
  assert.deepEqual(tracker.showsOf(user)[0].streams.map((x) => x.name), ['Crunchyroll']);
  tracker.removeShow(user, 'anilist:5');
  assert.deepEqual(store.data.availability, {});
});

test('http: region setting and premieres', async (t) => {
  const { setupCode, client } = await serve(t);
  const ann = client();
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  assert.equal((await ann.req('GET', '/api/state')).body.settings.region, 'US');
  assert.equal((await ann.req('PUT', '/api/settings', { region: 'gb' })).body.settings.region, 'US', 'must be a two-letter country code in capitals');
  assert.deepEqual((await ann.req('GET', '/api/premieres')).body.list.map((x) => x.title), ['Premiere in US']);
  assert.equal((await ann.req('PUT', '/api/settings', { region: 'GB' })).body.settings.region, 'GB');
  const p = (await ann.req('GET', '/api/premieres')).body;
  assert.deepEqual([p.region, p.list[0].title, p.list[0].premiere], ['GB', 'Premiere in GB', 'New series']);
});

test('English dubs: attached by exact title, chosen per user, alerted, and sharing the watched mark', async () => {
  const { clock, sent, store, sources, user, tracker, start } = rig();
  sources.fetchAnime = async (ids) => ids.map((id) => fakeShow(id, { t: start }, { title: id === 6 ? 'Show 5 Season 2' : `Show ${id}` }));
  const bob = makeUser({ username: 'bob' });
  store.data.users[bob.id] = bob;
  await tracker.addShow(user, 'anilist', 5);
  await tracker.addShow(user, 'anilist', 6);
  await tracker.addShow(bob, 'anilist', 5);
  user.settings.audio = 'dub';

  sources.dubList = [
    { names: ['Show 5', 'Shou Go'], episode: 3, airsAt: start + 60_000 },
    { names: ['SHOW 5!'], episode: 2, airsAt: start - 6 * DAY },
    { names: ['Unrelated'], episode: 1, airsAt: start },
  ];
  assert.equal(await tracker.refreshDubs(), 1, 'one tracked show has a dub; "Show 5 Season 2" is not confused with it');
  const five = tracker.showsOf(user).find((x) => x.key === 'anilist:5');
  assert.deepEqual(five.episodes.map((e) => [e.id, e.label, e.watchId]), [
    ['anilist:5:dub:2', 'Episode 2 (dub)', 'anilist:5:2'],
    ['anilist:5:dub:3', 'Episode 3 (dub)', 'anilist:5:3'],
  ]);
  assert.deepEqual(tracker.showsOf(user).find((x) => x.key === 'anilist:6').episodes.map((e) => e.label), ['Episode 1', 'Episode 2'], 'no dub listed: subtitled episodes stay');
  assert.deepEqual(tracker.showsOf(bob)[0].episodes.map((e) => e.label), ['Episode 1', 'Episode 2'], 'another user still follows the subtitled release');

  user.settings.audio = 'both';
  assert.deepEqual(tracker.showsOf(user).find((x) => x.key === 'anilist:5').episodes.map((e) => e.label), ['Episode 2 (dub)', 'Episode 1', 'Episode 2', 'Episode 3 (dub)']);

  // The dub airing raises its own alert, for the user who follows dubs only.
  clock.t = start + 2 * 60_000;
  await tracker.checkAlerts(user);
  await tracker.checkAlerts(bob);
  const bodies = sent.flat().map((m) => m.body);
  assert.ok(bodies.includes('Episode 3 (dub) is out on Crunchyroll'));
  assert.equal(bodies.filter((b) => b.includes('(dub)')).length, 1);

  // A show added later picks its dub dates up at the next minute's pass, not after the hourly retry delay.
  sources.dubList = [...sources.dubList, { names: ['Show 9'], episode: 1, airsAt: clock.t + DAY }];
  await tracker.tick();
  await tracker.addShow(bob, 'anilist', 9);
  await tracker.tick();
  assert.equal(store.data.dubs['anilist:9']?.length, 1);
  delete store.data.dubs['anilist:9'];
  tracker.removeShow(bob, 'anilist:9');

  // Older dub episodes are kept between refreshes, then dropped after a month.
  sources.dubList = [];
  await tracker.refreshDubs();
  assert.equal(store.data.dubs['anilist:5'].length, 2);
  clock.t = start + 40 * DAY;
  await tracker.refreshDubs();
  assert.equal(store.data.dubs['anilist:5'], undefined);
});

test('http: audio setting; a watched mark covers both the subtitled and the dubbed episode', async (t) => {
  const { setupCode, sources, tracker, client } = await serve(t);
  const ann = client();
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  let st = (await ann.req('GET', '/api/state')).body;
  assert.deepEqual([st.dubs, st.settings.audio], [true, 'sub']);
  assert.equal((await ann.req('PUT', '/api/settings', { audio: 'klingon' })).body.settings.audio, 'sub');
  await ann.req('POST', '/api/shows', { source: 'anilist', id: 5 });
  sources.dubList = [{ names: ['Show 5'], episode: 1, airsAt: Date.now() - DAY }];
  await tracker.refreshDubs();
  st = (await ann.req('PUT', '/api/settings', { audio: 'both' })).body;
  const eps = st.shows['anilist:5'].episodes;
  assert.ok(eps.some((e) => e.id === 'anilist:5:dub:1' && e.dub && e.watchId === 'anilist:5:1'));
  sources.dubbed = false;
  assert.equal((await ann.req('GET', '/api/state')).body.dubs, false);
});

// ---------------------------------------------------------------- audit follow-ups

test('http: writes must state a same-site origin; proxy headers are believed only when configured', async (t) => {
  const { setupCode, base, client } = await serve(t);
  const ann = client('198.51.100.1');
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  const send = (headers) => fetch(base + '/api/refresh', { method: 'POST', headers: { Cookie: ann.cookie, ...headers } }).then((r) => r.status);
  assert.equal(await send({}), 403, 'neither Origin nor Sec-Fetch-Site: refused');
  assert.equal(await send({ 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal(await send({ 'Sec-Fetch-Site': 'same-site' }), 403, 'a sibling subdomain is not this site');
  assert.equal(await send({ Origin: 'https://evil.example' }), 403);
  assert.equal(await send({ 'Sec-Fetch-Site': 'same-origin' }), 200);
  assert.equal(await send({ Origin: base }), 200);
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: ann.cookie } })).status, 200, 'reads are unaffected');

  // Without TRUST_PROXY the forwarded headers are ignored: no Secure cookie on a
  // forged "https", and a forged visitor address does not dodge the attempt limit.
  const direct = await serve(t, { trustProxy: false });
  const post = (path, body, headers = {}) => fetch(direct.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: direct.base, ...headers }, body: JSON.stringify(body) });
  const made = await post('/api/setup', { username: 'ann', password: 'password-ann', code: direct.setupCode }, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.example' });
  assert.equal(made.status, 200, 'the forged host did not change which origin is accepted');
  assert.ok(!made.headers.get('set-cookie').includes('Secure'));
  assert.equal((await fetch(direct.base + '/', { headers: { 'X-Forwarded-Proto': 'https' } })).headers.get('strict-transport-security'), null);
  for (let i = 0; i < 8; i++) await post('/api/login', { username: `nobody${i}`, password: 'wrong' }, { 'X-Forwarded-For': `203.0.113.${i}` });
  assert.equal((await post('/api/login', { username: 'ann', password: 'password-ann' }, { 'X-Forwarded-For': '203.0.113.99' })).status, 429, 'all counted as one visitor');
});

test('http: failed sign-ins cannot lock everyone out; one account is capped across addresses', async (t) => {
  const { setupCode, client } = await serve(t);
  const ann = client('198.51.100.1');
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  await ann.unlockAdmin('password-ann');
  const invite = (await ann.req('POST', '/api/admin/invites')).body.token;
  assert.equal((await client('198.51.100.2').req('POST', '/api/signup', { token: invite, username: 'bob', password: 'password-bob' })).status, 200);

  // 280 failures from 40 addresses against made-up names: nobody real is affected.
  for (let ip = 0; ip < 40; ip++) for (let n = 0; n < 7; n++) await client(`203.0.113.${ip}`).req('POST', '/api/login', { username: `ghost${ip}-${n}`, password: 'wrong' });
  assert.equal((await client('198.51.100.3').req('POST', '/api/login', { username: 'ann', password: 'password-ann' })).status, 200, 'no site-wide lockout');

  // 30 failures on Bob from many addresses lock password guessing on Bob only.
  for (let i = 0; i < 30; i++) assert.equal((await client(`192.0.2.${i}`).req('POST', '/api/login', { username: 'BOB', password: 'wrong' })).status, 401);
  assert.equal((await client('192.0.2.200').req('POST', '/api/login', { username: 'bob', password: 'password-bob' })).status, 429);
  assert.equal((await client('192.0.2.201').req('POST', '/api/login', { username: 'ann', password: 'password-ann' })).status, 200);
});

test('http: over HTTPS every cookie is host-locked, and one under the plain name is not accepted', async (t) => {
  const { base, setupCode } = await serve(t);
  const origin = base.replace('http:', 'https:');
  const jar = new Map();
  const req = async (method, path, body, cookie) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'X-Forwarded-Proto': 'https', Origin: origin, 'Content-Type': 'application/json', Cookie: cookie ?? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    const lines = res.headers.getSetCookie();
    for (const line of lines) {
      const [name, value] = line.split(';')[0].split('=');
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    return { status: res.status, lines, body: await res.json() };
  };

  const made = await req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  assert.equal(made.status, 200);
  // What the browser demands of a "__Host-" cookie: Secure, the whole site, no Domain.
  for (const line of [...made.lines, ...(await req('POST', '/api/admin/unlock', { password: 'password-ann' })).lines]) {
    assert.match(line, /^__Host-st_(session|admin)=/);
    assert.match(line, /; Path=\/;/);
    assert.match(line, /; Secure/);
    assert.match(line, /; HttpOnly/);
    assert.doesNotMatch(line, /Domain=/i);
  }
  assert.deepEqual([...jar.keys()], ['__Host-st_session', '__Host-st_admin']);
  assert.equal((await req('GET', '/api/state')).status, 200);
  assert.equal((await req('GET', '/api/admin/users')).status, 200);

  // The same valid values under the old names (which any sibling site could set) are ignored.
  const plain = `st_session=${jar.get('__Host-st_session')}; st_admin=${jar.get('__Host-st_admin')}`;
  assert.equal((await req('GET', '/api/state', null, plain)).status, 401);
  // A planted plain-name session next to the real one changes nothing.
  assert.equal((await req('GET', '/api/state', null, `st_session=u0.1.0; __Host-st_session=${jar.get('__Host-st_session')}`)).status, 200);

  // Signing out removes the cookies under both the new and the old names.
  const out = await req('POST', '/api/logout');
  const cleared = out.lines.map((l) => l.split('=')[0]);
  for (const name of ['__Host-st_session', 'st_session', '__Host-st_admin', 'st_admin', '__Host-st_pending', 'st_pending']) assert.ok(cleared.includes(name), name);
  assert.ok(out.lines.every((l) => l.includes('Max-Age=0')));
});

test('http: the guided tour is offered until it is finished, and that is remembered', async (t) => {
  const { setupCode, client } = await serve(t);
  const ann = client();
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  assert.equal((await ann.req('GET', '/api/state')).body.settings.tourDone, false);
  assert.equal((await ann.req('PUT', '/api/settings', { tourDone: true })).body.settings.tourDone, true);
  // Saving another setting does not bring it back.
  assert.equal((await ann.req('PUT', '/api/settings', { region: 'NO' })).body.settings.tourDone, true);
});

test('web push: the message is encrypted for the device and signed as this server', async () => {
  const { newVapidKeys, vapidHeader, encryptPayload, cleanSubscription } = await import('../server/push.js');
  const crypto = await import('node:crypto');
  // A browser's side of a subscription.
  const ua = crypto.createECDH('prime256v1');
  const uaPublic = ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = cleanSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') } });
  assert.ok(sub);

  // Decrypt as the browser would (RFC 8291).
  const body = encryptPayload(sub, 'hello there');
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const asPublic = body.subarray(21, 21 + body[20]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const key = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const sealed = body.subarray(21 + body[20]);
  const d = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  d.setAuthTag(sealed.subarray(-16));
  assert.equal(Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()]).toString(), 'hello there\x02');
  assert.notDeepEqual(encryptPayload(sub, 'hello there'), body, 'fresh keys every time');

  // The sender's proof verifies against the public key browsers subscribed with.
  const vapid = newVapidKeys();
  const header = vapidHeader(sub.endpoint, vapid, 'https://shows.example', 1_000_000);
  const [, jwt, k] = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(header);
  assert.equal(k, vapid.publicKey);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: 1000 + 43200, sub: 'https://shows.example' });
  const raw = Buffer.from(vapid.publicKey, 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));

  // Only real push services, over https, with well-formed keys.
  const keys = { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') };
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://169.254.169.254/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x', 'nonsense']) {
    assert.equal(cleanSubscription({ endpoint, keys }), null, endpoint);
  }
  assert.ok(cleanSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc', keys }));
  assert.equal(cleanSubscription({ endpoint: sub.endpoint, keys: { ...keys, auth: 'c2hvcnQ' } }), null);
  assert.equal(cleanSubscription({ endpoint: sub.endpoint }), null);
});

test('http: notifications go to the devices that asked, a device has one owner, dead ones are dropped', async (t) => {
  const crypto = await import('node:crypto');
  const pushed = [];
  const answers = {};
  const { setupCode, client } = await serve(t, { pushPost: async (endpoint, headers, body) => (pushed.push({ endpoint, headers, body }), answers[endpoint] || 201) });
  const device = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
  const ann = client('198.51.100.1');
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  await ann.unlockAdmin('password-ann');
  const bob = client('198.51.100.2');
  await bob.req('POST', '/api/signup', { token: (await ann.req('POST', '/api/admin/invites')).body.token, username: 'bob', password: 'password-bob' });

  assert.equal((await ann.req('POST', '/api/test-alert')).status, 400, 'nothing to send to yet');
  assert.equal((await ann.req('POST', '/api/push', { subscription: { endpoint: 'https://evil.example/x', keys: device(0).keys } })).status, 400);
  const phone = device('phone');
  const state = (await ann.req('POST', '/api/push', { subscription: phone, name: 'Chrome on Android' })).body;
  assert.match(state.pushKey, /^[\w-]{87}$/);
  assert.deepEqual(state.me.pushDevices.map((d) => d.name), ['Chrome on Android']);
  assert.ok(!JSON.stringify(state).includes(phone.endpoint), 'the address itself is never sent back');
  await ann.req('POST', '/api/push', { subscription: device('laptop'), name: 'Firefox on Windows' });

  assert.equal((await ann.req('POST', '/api/test-alert')).status, 200);
  assert.deepEqual(pushed.map((p) => p.endpoint.split('/').pop()), ['phone', 'laptop']);
  assert.equal(pushed[0].headers['Content-Encoding'], 'aes128gcm');
  assert.match(pushed[0].headers.Authorization, /^vapid t=/);
  assert.ok(!pushed[0].body.includes('Test alert'), 'not readable by the push service');

  // Bob signs in on Ann's phone browser and turns notifications on: the device is now his alone.
  await bob.req('POST', '/api/push', { subscription: phone, name: 'Chrome on Android' });
  assert.deepEqual((await ann.req('GET', '/api/state')).body.me.pushDevices.map((d) => d.name), ['Firefox on Windows']);
  assert.deepEqual((await bob.req('GET', '/api/state')).body.me.pushDevices.map((d) => d.name), ['Chrome on Android']);
  // Bob cannot remove Ann's device by its id.
  const laptopId = (await ann.req('GET', '/api/state')).body.me.pushDevices[0].id;
  await bob.req('DELETE', `/api/push?id=${laptopId}`);
  assert.equal((await ann.req('GET', '/api/state')).body.me.pushDevices.length, 1);

  // The browser says the subscription is gone: it is forgotten without an error.
  answers['https://fcm.googleapis.com/fcm/send/laptop'] = 410;
  assert.equal((await ann.req('POST', '/api/test-alert')).status, 200);
  assert.equal((await ann.req('GET', '/api/state')).body.me.pushDevices.length, 0);
  // A push service failure is reported.
  answers[phone.endpoint] = 500;
  const failed = await bob.req('POST', '/api/test-alert');
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /Chrome on Android.*500/);
});

test('the browser scripts parse', async () => {
  // They only run in a browser, so nothing else here would notice a syntax error in them.
  const { execFileSync } = await import('node:child_process');
  for (const file of ['app/js/app.js', 'app/js/core.js', 'app/sw.js']) execFileSync(process.execPath, ['--check', new URL(`../${file}`, import.meta.url).pathname]);
});

test('request limiter: stays inside the allowance, lets a waiting person go first, waits out a refusal', async () => {
  const { createLimiter } = await import('../server/sources.js');
  const clock = { t: 1_000_000 };
  const opts = { perMinute: 10, reserve: 4, patience: 20000, now: () => clock.t, sleep: async (ms) => void (clock.t += ms) };
  const ok = () => new Response('{}', { status: 200 });
  const sentAt = [];

  // Background work uses 6 of the 10 a minute; the 7th waits for the minute to turn.
  let limit = createLimiter(opts);
  for (let i = 0; i < 7; i++) await limit(async () => (sentAt.push(clock.t), ok()));
  assert.deepEqual(sentAt.slice(0, 6), Array(6).fill(1_000_000));
  assert.ok(sentAt[6] >= 1_060_000, 'held back until there is room');

  // The reserve is there for someone waiting: an urgent request goes straight out, and ahead of the queue.
  limit = createLimiter(opts);
  clock.t = 2_000_000;
  const order = [];
  const jobs = [];
  for (let i = 0; i < 8; i++) jobs.push(limit(async () => (order.push(`bg${i}`), ok())));
  jobs.push(limit(async () => (order.push(`urgent@${clock.t - 2_000_000}`), ok()), { urgent: true }));
  await Promise.all(jobs);
  assert.ok(order.indexOf('urgent@0') > 0 && order.indexOf('urgent@0') <= 6, `sent at once, before the held-back background work: ${order}`);

  // "Too many requests": wait as long as asked, then send the same request again.
  limit = createLimiter(opts);
  clock.t = 3_000_000;
  let calls = 0;
  const res = await limit(async () => (++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '30' } }) : ok()));
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.ok(clock.t >= 3_030_000);

  // Someone waiting is told rather than left hanging when the wait would be long.
  limit = createLimiter(opts);
  clock.t = 4_000_000;
  await assert.rejects(limit(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }), { urgent: true, busy: 'busy, try later' }), /busy, try later/);
  // A failure of the request itself is passed on, and the queue carries on.
  clock.t = 5_000_000;
  await assert.rejects(limit(async () => Promise.reject(new Error('network down'))), /network down/);
  assert.equal((await limit(async () => ok())).status, 200);
  // The allowance the source announces is respected when it is lower than assumed.
  limit = createLimiter({ ...opts, reserve: 0 });
  clock.t = 6_000_000;
  const stamps = [];
  for (let i = 0; i < 5; i++) await limit(async () => (stamps.push(clock.t), new Response('{}', { status: 200, headers: { 'X-RateLimit-Limit': '6' } })));
  assert.ok(stamps[4] >= 6_060_000, 'four a minute once the source says six');
});

test('suggestions: adding a show asks the source about that show only, and old answers cover an outage', async () => {
  const { sources, user, tracker, clock, store } = rig();
  const asked = [];
  const real = sources.fetchRelated.bind(sources);
  sources.fetchRelated = async (ids, opts) => (asked.push([...ids]), real(ids, opts));
  sources.related.set(1, { sequels: [], recs: [{ rating: 5, media: media(50, 'Rec A') }] });
  sources.related.set(2, { sequels: [], recs: [{ rating: 5, media: media(51, 'Rec B') }] });
  await tracker.addShow(user, 'anilist', 1);
  await tracker.refreshDiscover(user);
  await tracker.addShow(user, 'anilist', 2);
  await tracker.refreshDiscover(user);
  await new Promise((r) => setTimeout(r, 20)); // let the rebuilds triggered by adding finish
  await tracker.refreshDiscover(user);
  assert.deepEqual(asked, [[1], [2]], 'each show asked about once');
  assert.deepEqual(user.discover.recs.map((r) => r.key).sort(), ['anilist:50', 'anilist:51']);

  // Half a day on, everything is asked again; if the source is down the stored answers still serve.
  clock.t += HALF_DAY;
  sources.fetchRelated = async () => Promise.reject(new Error('AniList down'));
  await tracker.refreshDiscover(user);
  assert.equal(user.discover.recs.length, 2);
  // Answers nobody refreshed for a week are dropped.
  clock.t += 8 * DAY;
  tracker.removeShow(user, 'anilist:2');
  assert.deepEqual(Object.keys(store.data.related), []);
});
