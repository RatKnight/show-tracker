import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { openStore, makeUser } from '../server/store.js';
import { createTracker } from '../server/tracker.js';
import { buildIcs } from '../server/ics.js';
import { computeDiscover, buildSeries } from '../server/discover.js';
import { localClock, inQuietHours, summarize } from '../server/timing.js';
import { buildBackup, readBackup, writeSnapshot } from '../server/backup.js';
import { createMailer, cleanEmail } from '../server/mail.js';
import { generateKeyPairSync, createHash, sign as cryptoSign, randomBytes } from 'node:crypto';
import { validateChannels, parseNtfy, ntfyPayloads, discordPayloads } from '../server/notify.js';
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
    const { sent, sources, user, tracker } = rig();
    user.settings.autoTrackSeasons = false;
    sources.related.set(1, { sequels: [media(10, 'One S2', 'NOT_YET_RELEASED')], recs: [{ rating: 5, media: media(50, 'Rec A') }] });
    await tracker.addShow(user, 'anilist', 1);
    await tracker.refreshDiscover(user);
    assert.equal(sent.length, 0, 'seasons that already existed are not announced');
    assert.deepEqual(user.discover.sequels.map((s) => s.key), ['anilist:10']);
    assert.deepEqual(Object.keys(user.shows), ['anilist:1']);

    sources.related.set(10, { sequels: [media(11, 'One S3', 'NOT_YET_RELEASED')], recs: [] });
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
    const { sent, sources, user, tracker } = rig();
    sources.related.set(1, { sequels: [media(10, 'One S2', 'FINISHED')], recs: [] });
    sources.related.set(10, { sequels: [media(11, 'One S3', 'NOT_YET_RELEASED')], recs: [] });
    await tracker.addShow(user, 'anilist', 1);
    await tracker.refreshDiscover(user);
    assert.deepEqual(Object.keys(user.shows).sort(), ['anilist:1', 'anilist:11'], 'the upcoming season is added, the finished one is not');
    assert.equal(sent.length, 0, 'silently on the first scan');
    assert.deepEqual(user.discover.series, { 'anilist:1': { id: 'anilist:1', title: 'Show 1' }, 'anilist:11': { id: 'anilist:1', title: 'Show 1' } });

    sources.related.set(11, { sequels: [media(12, 'One S4', 'RELEASING')], recs: [] });
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
  assert.equal(sessionUser(cookie, data, 2000), ann);
  assert.equal(sessionUser(cookie, { ...data, secret: 'other' }, 2000), null);
  assert.equal(sessionUser(cookie, data, 1000 + 31 * DAY), null, 'expired');
  assert.equal(sessionUser(cookie.replace(ann.id, bob.id), data, 2000), null, 'cannot be re-pointed at another user');
  ann.sessionKey = 'rotated';
  assert.equal(sessionUser(cookie, data, 2000), null, 'revoked when the session key changes');
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
  assert.deepEqual(readBackup({ app: 'show-tracker', shows: [{ source: 'evil', id: 1 }, null], watched: [1, 'ok'] }), { shows: [], watched: ['ok'], muted: [], dismissed: [], settings: {} });

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
  const app = createApp({ dataDir: dir, sources, send: async (_s, m) => (sent.push(...m), []), sendFile: async () => {}, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  /** A browser-like client that keeps its own cookie. */
  const client = (ip = '198.51.100.1') => {
    const c = {
      cookie: '',
      async req(method, path, body, headers = {}) {
        const res = await fetch(base + path, {
          method,
          headers: { 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
        });
        const set = res.headers.get('set-cookie');
        if (set) c.cookie = set.split(';')[0];
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

  // Sign-up needs an invite; invites are single use.
  assert.equal((await anon.req('POST', '/api/signup', { token: 'made-up', username: 'bob', password: 'password-bob' })).status, 404);
  assert.equal((await anon.req('POST', '/api/admin/invites')).status, 401);
  const invite = (await ann.req('POST', '/api/admin/invites')).body;
  assert.equal(invite.pendingInvites, 1);
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
  for (const [m, p, b] of [['GET', '/api/admin/users'], ['POST', '/api/admin/invites'], ['POST', '/api/admin/reset', { id: 'u1' }], ['DELETE', '/api/admin/users?id=x']]) {
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
  assert.equal((await ann.req('PUT', '/api/account/email', { email: 'not an address' })).status, 400);
  const pending = (await ann.req('PUT', '/api/account/email', { email: 'ann@example.com' })).body;
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
  assert.equal((await fresh.req('PUT', '/api/account/email', { email: '' })).body.me.email, '');
  // The admin roster never includes addresses.
  assert.ok(!JSON.stringify((await fresh.req('GET', '/api/admin/users')).body).includes('example.com'));
});

test('http: e-mail features are closed when mail is not configured', async (t) => {
  const { setupCode, client } = await serve(t);
  const ann = client();
  await ann.req('POST', '/api/setup', { username: 'ann', password: 'password-ann', code: setupCode });
  assert.equal((await ann.req('POST', '/api/forgot', { identifier: 'ann' })).status, 404);
  assert.equal((await ann.req('PUT', '/api/account/email', { email: 'ann@example.com' })).status, 400);
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

  await lost.req('DELETE', `/api/passkeys?id=${key.id}`);
  const off = (await lost.req('DELETE', `/api/passkeys?id=${phone.id}`)).body;
  assert.deepEqual([off.me.passkeys, off.me.recoveryCodesLeft], [[], 0]);
});
