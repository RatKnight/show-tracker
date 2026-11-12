// Schedule data sources. Both APIs are free and need no key.
//   Anime: AniList   https://docs.anilist.co
//   TV:    TVmaze    https://www.tvmaze.com/api
import { normalizeAnilist, normalizeTvmaze, PAST_WINDOW, FUTURE_WINDOW } from '../app/js/core.js';

const ANILIST = 'https://graphql.anilist.co';
const TVMAZE = 'https://api.tvmaze.com';

const MEDIA_FIELDS = `
  id format status siteUrl genres averageScore
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
