// Schedule data sources. Both APIs are free and need no key.
//   Anime: AniList   https://docs.anilist.co
//   TV:    TVmaze    https://www.tvmaze.com/api
import { normalizeAnilist, normalizeTvmaze, normalizeTmdb, PAST_WINDOW, FUTURE_WINDOW, DAY } from '../app/js/core.js';

const ANILIST = 'https://graphql.anilist.co';
const TVMAZE = 'https://api.tvmaze.com';

const MEDIA_FIELDS = `
  id format status siteUrl genres averageScore episodes
  title { romaji english }
  coverImage { medium }
  startDate { year month day }
  nextAiringEpisode { episode airingAt }
  externalLinks { site url type }
`;
// Formats worth suggesting as "a new season" (skips music videos, specials, OVAs).
const SERIES_FORMATS = ['TV', 'TV_SHORT', 'ONA', 'MOVIE'];

async function gql(query, variables) {
  const res = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) throw new Error('AniList is rate limiting requests — try again in a minute.');
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    throw new Error(json?.errors?.[0]?.message || `AniList request failed (${res.status})`);
  }
  return json.data;
}

async function tvmaze(path) {
  const res = await fetch(TVMAZE + path);
  if (res.status === 429) throw new Error('TVmaze is rate limiting requests — try again in a minute.');
  if (!res.ok) throw new Error(`TVmaze request failed (${res.status})`);
  return res.json();
}

export async function searchAnime(q) {
  const data = await gql(
    `query ($q: String) {
      Page(perPage: 12) {
        media(search: $q, type: ANIME, isAdult: false, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
      }
    }`,
    { q },
  );
  return data.Page.media.map((m) => normalizeAnilist(m, undefined));
}

export async function searchTv(q) {
  const results = await tvmaze(`/search/shows?q=${encodeURIComponent(q)}`);
  return results.map((r) => normalizeTvmaze(r.show));
}

/** Full details + airing schedule for a set of AniList ids. */
export async function fetchAnime(ids, now = Date.now()) {
  const shows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { Page } = await gql(
      `query ($ids: [Int]) {
        Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } }
      }`,
      { ids: chunk },
    );

    const schedule = new Map(chunk.map((id) => [id, []]));
    for (let page = 1; page <= 20; page++) {
      const data = await gql(
        `query ($ids: [Int], $from: Int, $to: Int, $page: Int) {
          Page(page: $page, perPage: 50) {
            pageInfo { hasNextPage }
            airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
              mediaId episode airingAt
            }
          }
        }`,
        {
          ids: chunk,
          from: Math.floor((now - PAST_WINDOW) / 1000),
          to: Math.floor((now + FUTURE_WINDOW) / 1000),
          page,
        },
      );
      for (const n of data.Page.airingSchedules) schedule.get(n.mediaId)?.push(n);
      if (!data.Page.pageInfo.hasNextPage) break;
    }

    for (const m of Page.media) shows.push(normalizeAnilist(m, schedule.get(m.id), now));
  }
  return shows;
}

/** Full details + episode list for one TVmaze show. */
export async function fetchTv(id, now = Date.now()) {
  return normalizeTvmaze(await tvmaze(`/shows/${id}?embed=episodes`), now);
}

/**
 * For each anime id: the sequels AniList links to it and what its viewers recommend.
 * Returns Map(id -> { sequels: [media], recs: [{ rating, media }] }) of raw AniList media.
 */
export async function fetchRelated(ids, { recommendations = true } = {}) {
  const out = new Map();
  // Small chunks: this query is heavy and AniList caps query complexity.
  for (let i = 0; i < ids.length; i += 10) {
    const data = await gql(
      `query ($ids: [Int]) {
        Page(perPage: 10) {
          media(id_in: $ids, type: ANIME) {
            id
            relations { edges { relationType node { type ${MEDIA_FIELDS} } } }
            ${recommendations ? `recommendations(sort: RATING_DESC, perPage: 8) { nodes { rating mediaRecommendation { type ${MEDIA_FIELDS} } } }` : ''}
          }
        }
      }`,
      { ids: ids.slice(i, i + 10) },
    );
    for (const m of data.Page.media) {
      out.set(m.id, {
        sequels: m.relations.edges
          .filter((e) => e.relationType === 'SEQUEL' && e.node?.type === 'ANIME' && SERIES_FORMATS.includes(e.node.format))
          .map((e) => e.node),
        recs: (m.recommendations?.nodes || [])
          .filter((n) => n.mediaRecommendation?.type === 'ANIME' && n.rating > 0)
          .map((n) => ({ rating: n.rating, media: n.mediaRecommendation })),
      });
    }
  }
  return out;
}

/** The most popular anime of one season, as normalised shows. */
export async function fetchSeason(season, year, now = Date.now()) {
  const shows = [];
  for (let page = 1; page <= 2; page++) {
    const data = await gql(
      `query ($season: MediaSeason, $year: Int, $page: Int) {
        Page(page: $page, perPage: 50) {
          pageInfo { hasNextPage }
          media(season: $season, seasonYear: $year, type: ANIME, isAdult: false, sort: POPULARITY_DESC, format_in: [${SERIES_FORMATS}]) { ${MEDIA_FIELDS} }
        }
      }`,
      { season, year, page },
    );
    for (const m of data.Page.media) shows.push(normalizeAnilist(m, undefined, now));
    if (!data.Page.pageInfo.hasNextPage) break;
  }
  return shows;
}

/** Anime ids on a public AniList profile's Watching and Planning lists. */
export async function fetchUserList(userName) {
  let data;
  try {
    data = await gql(
      `query ($name: String) {
        MediaListCollection(userName: $name, type: ANIME, status_in: [CURRENT, PLANNING]) {
          lists { entries { mediaId } }
        }
      }`,
      { name: userName },
    );
  } catch (e) {
    if (/not found|private/i.test(e.message)) throw new Error(`No public AniList profile called “${userName}” was found.`);
    throw e;
  }
  const ids = (data.MediaListCollection?.lists || []).flatMap((l) => l.entries.map((e) => e.mediaId));
  return [...new Set(ids)];
}

/**
 * Where an anime sits in its franchise: walk the prequel chain back to the first
 * season, counting episodes of the TV seasons on the way.
 * Returns { root, offset, index, count }.
 */
export async function fetchFranchise(id) {
  const COUNTED = ['TV', 'TV_SHORT', 'ONA'];
  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id episodes format
      title { romaji english }
      relations { edges { relationType node { id type } } }
    }
  }`;
  const first = (await gql(query, { id })).Media;
  let current = first;
  let offset = 0;
  let index = 1;
  const seen = new Set([id]);
  for (let depth = 0; depth < 15; depth++) {
    const prequel = current.relations.edges.find((e) => e.relationType === 'PREQUEL' && e.node?.type === 'ANIME' && !seen.has(e.node.id));
    if (!prequel) break;
    seen.add(prequel.node.id);
    current = (await gql(query, { id: prequel.node.id })).Media;
    // Films and specials between seasons are not part of a site's episode count.
    if (COUNTED.includes(current.format)) {
      offset += current.episodes || 0;
      index++;
    }
  }
  return { root: current.title?.english || current.title?.romaji || '', offset, index, count: first.episodes || null };
}

// ---------------------------------------------------------------- movies (TMDB)
//
// Needs a TMDB "API Read Access Token" in TMDB_API_KEY. Without one, movie
// features are simply switched off.

const TMDB = 'https://api.themoviedb.org/3';

export const hasMovies = () => Boolean(process.env.TMDB_API_KEY);

async function tmdb(path) {
  const res = await fetch(TMDB + path, {
    headers: { Authorization: `Bearer ${process.env.TMDB_API_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401) throw new Error('TMDB rejected the API key.');
  if (res.status === 429) throw new Error('TMDB is rate limiting requests — try again in a minute.');
  if (!res.ok) throw new Error(`TMDB request failed (${res.status})`);
  return res.json();
}

export async function searchMovies(q) {
  const data = await tmdb(`/search/movie?query=${encodeURIComponent(q)}&include_adult=false&region=US`);
  return data.results.slice(0, 12).map((m) => normalizeTmdb(m));
}

/** One movie with its US release dates and where it streams. */
export async function fetchMovie(id, now = Date.now()) {
  return normalizeTmdb(await tmdb(`/movie/${id}?append_to_response=release_dates,watch/providers`), now);
}

/** Japanese animated films in US cinemas now or with a US cinema date announced. */
export async function fetchCinemaAnime(now = Date.now()) {
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const ids = [];
  for (let page = 1; page <= 2; page++) {
    const data = await tmdb(
      `/discover/movie?region=US&with_release_type=2%7C3&release_date.gte=${iso(now - 30 * DAY)}&release_date.lte=${iso(now + 365 * DAY)}` +
        `&with_genres=16&with_original_language=ja&include_adult=false&sort_by=primary_release_date.asc&page=${page}`,
    );
    ids.push(...data.results.map((m) => m.id));
    if (page >= data.total_pages) break;
  }
  const movies = [];
  for (const id of ids) {
    const movie = await fetchMovie(id, now).catch(() => null);
    // Keep only those whose US cinema date falls in the window once looked up exactly.
    if (movie?.episodes.some((e) => e.event === 'cinema')) movies.push(movie);
  }
  const cinemaAt = (m) => m.episodes.find((e) => e.event === 'cinema').airsAt;
  return movies.sort((a, b) => cinemaAt(a) - cinemaAt(b));
}

// ---------------------------------------------------------------- where it streams
//
// Streaming availability by country comes from JustWatch through TMDB. AniList's
// own streaming links are not tied to a country, so this is what makes the
// service badges accurate for where the viewer lives.

/**
 * Subscription services a series is on, per country.
 * show: { title, altTitle, imdb, anime }. Returns { tmdbId, byRegion: { US: [names] }, links: { US: url } }
 * (empty when the series cannot be found), for the regions asked for.
 */
export async function fetchAvailability(show, regions) {
  let hit = null;
  if (show.imdb) hit = (await tmdb(`/find/${encodeURIComponent(show.imdb)}?external_source=imdb_id`)).tv_results?.[0] || null;
  for (const title of [show.title, show.altTitle]) {
    if (hit || !title) continue;
    const found = (await tmdb(`/search/tv?query=${encodeURIComponent(title)}&include_adult=false`)).results || [];
    // For anime, insist on a Japanese animated series so a live-action namesake is not picked.
    hit = (show.anime ? found.find((r) => r.origin_country?.includes('JP') && r.genre_ids?.includes(16)) : found[0]) || null;
  }
  if (!hit) return { tmdbId: null, byRegion: {}, links: {} };
  const data = (await tmdb(`/tv/${hit.id}/watch/providers`)).results || {};
  const byRegion = {};
  const links = {};
  for (const region of regions) {
    byRegion[region] = (data[region]?.flatrate || []).map((p) => p.provider_name);
    if (data[region]?.link) links[region] = data[region].link;
  }
  return { tmdbId: hit.id, byRegion, links };
}

/** Season premieres on streaming services in one country over the next two weeks. */
export async function fetchPremieres(region, now = Date.now()) {
  const SKIP = ['News', 'Talk Show', 'Sports', 'Game Show', 'Panel Show', 'Award Show'];
  const seen = new Map();
  for (let d = 0; d < 14; d++) {
    const date = new Date(now + d * DAY).toISOString().slice(0, 10);
    const day = await tvmaze(`/schedule/web?date=${date}&country=${encodeURIComponent(region)}`);
    for (const ep of day) {
      const show = ep._embedded?.show;
      if (!show || ep.number !== 1 || !ep.airstamp || SKIP.includes(show.type) || seen.has(show.id)) continue;
      seen.set(show.id, { ...normalizeTvmaze({ ...show, _embedded: { episodes: [ep] } }, now), premiere: ep.season === 1 ? 'New series' : `Season ${ep.season}` });
    }
  }
  return [...seen.values()].sort((a, b) => a.episodes[0].airsAt - b.episodes[0].airsAt);
}
