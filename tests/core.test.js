import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY,
  serviceId,
  normalizeAnilist,
  normalizeTvmaze,
  nextEpisode,
  episodesBetween,
  collectAlerts,
  myStreams,
  dayKey,
  monthGrid,
  formatCountdown,
  animeSeason,
  normalizeTmdb,
  dateOnlyTime,
} from '../app/js/core.js';

const NOW = new Date(2026, 10, 12, 12, 0).getTime();
const sec = (ms) => Math.floor(ms / 1000);

const media = {
  id: 7,
  format: 'TV',
  status: 'RELEASING',
  siteUrl: 'https://anilist.co/anime/7',
  title: { romaji: 'Sousou no Frieren', english: 'Frieren' },
  coverImage: { medium: 'https://img/7.jpg' },
  startDate: { year: 2026, month: 10, day: 3 },
  externalLinks: [
    { site: 'Crunchyroll', url: 'https://crunchyroll.com/x', type: 'STREAMING' },
    { site: 'Amazon Prime Video', url: 'https://amazon.com/x', type: 'STREAMING' },
    { site: 'Twitter', url: 'https://twitter.com/x', type: 'SOCIAL' },
    { site: 'Bilibili TV', url: 'https://bilibili.tv/x', type: 'STREAMING' },
  ],
};

test('serviceId recognises the common services', () => {
  assert.equal(serviceId('Crunchyroll'), 'crunchyroll');
  assert.equal(serviceId('HIDIVE'), 'hidive');
  assert.equal(serviceId('Amazon Prime Video'), 'prime');
  assert.equal(serviceId('Prime Video'), 'prime');
  assert.equal(serviceId('HBO Max'), 'max');
  assert.equal(serviceId('Bilibili TV'), null);
  assert.equal(serviceId(undefined), null);
});

test('normalizeAnilist builds episodes, streams and drops old episodes', () => {
  const show = normalizeAnilist(
    media,
    [
      { episode: 1, airingAt: sec(NOW - 40 * DAY) },
      { episode: 6, airingAt: sec(NOW - DAY) },
      { episode: 7, airingAt: sec(NOW + 6 * DAY) },
    ],
    NOW,
  );
  assert.equal(show.key, 'anilist:7');
  assert.equal(show.title, 'Frieren');
  assert.equal(show.altTitle, 'Sousou no Frieren');
  assert.equal(show.status, 'Airing');
  assert.deepEqual(show.episodes.map((e) => e.label), ['Episode 6', 'Episode 7']);
  assert.deepEqual(show.streams.map((s) => s.id), ['crunchyroll', 'prime', null]);
  assert.deepEqual(myStreams(show, ['crunchyroll', 'hidive']).map((s) => s.name), ['Crunchyroll']);
  assert.equal(nextEpisode(show, NOW).id, 'anilist:7:7');
});

test('normalizeAnilist synthesises a premiere when only a start date is known', () => {
  const upcoming = { ...media, status: 'NOT_YET_RELEASED', startDate: { year: 2027, month: 1, day: 9 } };
  const show = normalizeAnilist(upcoming, [], NOW);
  assert.equal(show.episodes.length, 1);
  assert.equal(show.episodes[0].label, 'Premiere');
  assert.equal(show.episodes[0].dateOnly, true);
  assert.equal(show.episodes[0].id, 'anilist:7:1');
  assert.equal(dayKey(show.episodes[0].airsAt), '2027-01-09');

  const vague = normalizeAnilist({ ...upcoming, startDate: { year: 2027, month: 4, day: null } }, [], NOW);
  assert.equal(vague.episodes.length, 0);
  assert.equal(vague.note, 'Expected Apr 2027');

  const finished = normalizeAnilist({ ...media, status: 'FINISHED' }, [], NOW);
  assert.equal(finished.episodes.length, 0);
});

test('normalizeTvmaze builds episodes and streams', () => {
  const show = normalizeTvmaze(
    {
      id: 3,
      name: 'The Boys',
      status: 'Running',
      premiered: '2019-07-26',
      url: 'https://tvmaze.com/shows/3',
      officialSite: 'https://amazon.com/theboys',
      image: { medium: 'https://img/3.jpg' },
      webChannel: { name: 'Prime Video' },
      network: null,
      _embedded: {
        episodes: [
          { id: 1, season: 1, number: 1, name: 'Old', airstamp: '2019-07-26T12:00:00+00:00' },
          { id: 2, season: 5, number: 3, name: 'New', airstamp: new Date(NOW + DAY).toISOString() },
          { id: 3, season: 5, number: null, name: 'Recap', airstamp: new Date(NOW + 2 * DAY).toISOString() },
          { id: 4, season: 5, number: 4, name: 'TBA', airstamp: null },
        ],
      },
    },
    NOW,
  );
  assert.equal(show.kind, 'TV');
  assert.equal(show.year, 2019);
  assert.deepEqual(show.episodes.map((e) => e.label), ['S5E3', 'Special']);
  assert.deepEqual(show.episodes.map((e) => e.id), ['tvmaze:3:5x3', 'tvmaze:3:5xsp3']);
  assert.deepEqual(show.streams, [{ id: 'prime', name: 'Prime Video', url: 'https://amazon.com/theboys' }]);
});

test('normalizeTvmaze copes with a bare search result', () => {
  const show = normalizeTvmaze({ id: 9, name: 'X', status: 'Ended' }, NOW);
  assert.deepEqual(show.episodes, []);
  assert.deepEqual(show.streams, []);
  assert.equal(show.status, 'Finished');
});

test('episodesBetween merges and sorts across shows', () => {
  const a = { title: 'A', episodes: [{ id: 'a1', airsAt: NOW + 3 * DAY }, { id: 'a2', airsAt: NOW + 10 * DAY }] };
  const b = { title: 'B', episodes: [{ id: 'b1', airsAt: NOW + DAY }] };
  const got = episodesBetween([a, b], NOW, NOW + 7 * DAY);
  assert.deepEqual(got.map((x) => x.ep.id), ['b1', 'a1']);
});

test('collectAlerts only returns unseen episodes aired after the show was added', () => {
  const show = {
    title: 'A',
    addedAt: NOW - 2 * DAY,
    episodes: [
      { id: 'before-add', airsAt: NOW - 3 * DAY },
      { id: 'seen', airsAt: NOW - DAY },
      { id: 'fresh', airsAt: NOW - 1000 },
      { id: 'future', airsAt: NOW + DAY },
    ],
  };
  const got = collectAlerts([show], new Set(['seen']), NOW);
  assert.deepEqual(got.map((x) => x.ep.id), ['fresh']);
});

test('monthGrid covers the month in whole weeks', () => {
  const nov = monthGrid(2026, 10, 0); // Nov 2026 starts on a Sunday
  assert.equal(nov.length, 5);
  assert.equal(dayKey(nov[0][0]), '2026-11-01');
  assert.equal(dayKey(nov[4][6]), '2026-12-05');

  const novMon = monthGrid(2026, 10, 1);
  assert.equal(dayKey(novMon[0][0]), '2026-10-26');
  assert.equal(novMon.length, 6);
  assert.ok(novMon.every((w) => w.length === 7));

  const feb = monthGrid(2026, 1, 0); // Feb 2026: exactly four Sunday-start weeks
  assert.equal(feb.length, 4);
});

test('formatCountdown', () => {
  assert.equal(formatCountdown(10 * 1000), 'now');
  assert.equal(formatCountdown(42 * 60000), 'in 42m');
  assert.equal(formatCountdown((5 * 60 + 12) * 60000), 'in 5h 12m');
  assert.equal(formatCountdown(3 * DAY + 4 * 3600000 + 60000), 'in 3d 4h');
  assert.equal(formatCountdown(2 * DAY), 'in 2d');
});

test('animeSeason', () => {
  assert.deepEqual(animeSeason(new Date(2026, 10, 12)), { season: 'FALL', year: 2026 });
  assert.deepEqual(animeSeason(new Date(2026, 10, 12), 1), { season: 'WINTER', year: 2027 });
  assert.deepEqual(animeSeason(new Date(2026, 0, 1)), { season: 'WINTER', year: 2026 });
  assert.deepEqual(animeSeason(new Date(2026, 5, 30), 1), { season: 'SUMMER', year: 2026 });
});

test('normalizeAnilist falls back to the next airing episode and keeps genres/score', () => {
  const show = normalizeAnilist({ ...media, genres: ['Adventure', 'Drama'], averageScore: 91, nextAiringEpisode: { episode: 9, airingAt: sec(NOW + DAY) } }, undefined, NOW);
  assert.deepEqual(show.episodes.map((e) => e.label), ['Episode 9']);
  assert.deepEqual([show.genres, show.score, show.format], [['Adventure', 'Drama'], 91, 'TV']);
});

test('normalizeTmdb turns US release dates into events', () => {
  const movie = {
    id: 99,
    title: 'Big Film',
    original_title: 'Ōkina Eiga',
    status: 'Post Production',
    release_date: '2026-12-01',
    poster_path: '/p.jpg',
    vote_average: 7.84,
    vote_count: 10,
    genres: [{ name: 'Animation' }, { name: 'Drama' }],
    release_dates: {
      results: [
        { iso_3166_1: 'JP', release_dates: [{ type: 3, release_date: '2026-08-01T00:00:00.000Z' }] },
        {
          iso_3166_1: 'US',
          release_dates: [
            { type: 1, release_date: '2026-12-10T00:00:00.000Z' }, // premiere: ignored
            { type: 3, release_date: '2026-12-18T00:00:00.000Z' },
            { type: 2, release_date: '2026-12-11T00:00:00.000Z' },
            { type: 4, release_date: '2027-02-02T00:00:00.000Z' },
          ],
        },
      ],
    },
    'watch/providers': { results: { US: { link: 'https://www.themoviedb.org/movie/99/watch', flatrate: [{ provider_name: 'Amazon Prime Video' }, { provider_name: 'Crunchyroll' }], rent: [{ provider_name: 'Apple TV' }] } } },
  };
  const m = normalizeTmdb(movie, NOW);
  assert.deepEqual([m.key, m.kind, m.title, m.altTitle, m.status, m.year, m.score], ['tmdb:99', 'Movie', 'Big Film', 'Ōkina Eiga', 'Upcoming', 2026, 78]);
  assert.equal(m.image, 'https://image.tmdb.org/t/p/w185/p.jpg');
  assert.deepEqual(m.episodes.map((e) => [e.id, e.event, e.label, e.dateOnly]), [
    ['tmdb:99:cinema', 'cinema', 'In US cinemas (limited)', true],
    ['tmdb:99:digital', 'digital', 'Digital release', true],
  ]);
  // The earliest cinema date wins, and stays on its calendar day in US time zones.
  assert.equal(m.episodes[0].airsAt, dateOnlyTime(2026, 12, 11));
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(m.episodes[0].airsAt), '2026-12-11');
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(m.episodes[0].airsAt), '2026-12-11');
  assert.deepEqual(m.streams.map((s) => s.id), ['prime', 'crunchyroll'], 'subscription providers only, not rentals');
  assert.match(m.tickets, /^https:\/\/www\.fandango\.com\/search\?q=Big%20Film$/);

  // No US dates: fall back to the general release date. Long past: no events, no tickets.
  const plain = normalizeTmdb({ id: 5, title: 'Plain', status: 'Released', release_date: '2026-12-25' }, NOW);
  assert.deepEqual(plain.episodes.map((e) => [e.event, e.label]), [['release', 'Release']]);
  const old = normalizeTmdb({ ...movie, id: 6, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2020-01-01T00:00:00.000Z' }] }] }, status: 'Released' }, NOW);
  assert.deepEqual([old.episodes, old.tickets, old.status], [[], null, 'Released']);
  const bare = normalizeTmdb({ id: 7, title: 'Search hit' }, NOW);
  assert.deepEqual([bare.episodes, bare.streams, bare.note], [[], [], 'No release date announced']);
});
