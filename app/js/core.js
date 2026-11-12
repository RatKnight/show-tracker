// Pure logic: no DOM, no network. Everything here is unit-tested.

export const DAY = 24 * 60 * 60 * 1000;
/** How far back we keep already-aired episodes. */
export const PAST_WINDOW = 30 * DAY;
/** How far ahead we ask the schedule APIs for. */
export const FUTURE_WINDOW = 180 * DAY;

export const SERVICES = {
  crunchyroll: 'Crunchyroll',
  hidive: 'HIDIVE',
  prime: 'Prime Video',
  netflix: 'Netflix',
  hulu: 'Hulu',
  disney: 'Disney+',
  max: 'Max',
  apple: 'Apple TV+',
};
export const DEFAULT_SERVICES = ['crunchyroll', 'hidive', 'prime'];

/** Map a streaming site / channel name from an API onto one of our service ids. */
export function serviceId(name) {
  const n = (name || '').toLowerCase().trim();
  if (n.includes('crunchyroll')) return 'crunchyroll';
  if (n.includes('hidive')) return 'hidive';
  if (n.includes('amazon') || n.includes('prime video')) return 'prime';
  if (n.includes('netflix')) return 'netflix';
  if (n.includes('hulu')) return 'hulu';
  if (n.includes('disney')) return 'disney';
  if (n === 'max' || n.includes('hbo')) return 'max';
  if (n.includes('apple tv')) return 'apple';
  return null;
}

function dedupeStreams(streams) {
  const seen = new Set();
  return streams.filter((s) => {
    const k = s.id || s.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Timestamp for an event known only by its date. Noon UTC keeps it on the same
 * calendar day for the server and for viewers across the Americas and Europe.
 */
export const dateOnlyTime = (year, month, day) => Date.UTC(year, month - 1, day, 12);

const ANILIST_STATUS = {
  RELEASING: 'Airing',
  NOT_YET_RELEASED: 'Upcoming',
  FINISHED: 'Finished',
  CANCELLED: 'Cancelled',
  HIATUS: 'On hiatus',
};
const ANILIST_FORMAT = { TV: 'TV', TV_SHORT: 'TV short', MOVIE: 'Movie', ONA: 'Web series', OVA: 'OVA', SPECIAL: 'Special' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Turn an AniList Media object plus its airing-schedule nodes into our show shape.
 * `schedule` is a list of { episode, airingAt (unix seconds) }.
 */
export function normalizeAnilist(media, schedule, now = Date.now()) {
  // Without a full schedule, the next episode (when the API sent it) is still worth showing.
  schedule ??= media.nextAiringEpisode ? [{ episode: media.nextAiringEpisode.episode, airingAt: media.nextAiringEpisode.airingAt }] : [];
  const key = `anilist:${media.id}`;
  const isMovie = media.format === 'MOVIE';
  const episodes = schedule
    .map((n) => ({
      id: `${key}:${n.episode}`,
      label: isMovie ? 'Release' : `Episode ${n.episode}`,
      airsAt: n.airingAt * 1000,
    }))
    .filter((e) => e.airsAt >= now - PAST_WINDOW)
    .sort((a, b) => a.airsAt - b.airsAt);

  // Shows announced with a start date but no episode schedule yet.
  const sd = media.startDate || {};
  let note = null;
  if (!episodes.length && sd.year) {
    if (sd.month && sd.day) {
      const at = dateOnlyTime(sd.year, sd.month, sd.day);
      if (at >= now - PAST_WINDOW && media.status !== 'FINISHED') {
        episodes.push({
          id: `${key}:1`,
          label: isMovie ? 'Release' : 'Premiere',
          airsAt: at,
          dateOnly: true,
        });
      }
    } else if (media.status === 'NOT_YET_RELEASED') {
      note = `Expected ${sd.month ? MONTHS[sd.month - 1] + ' ' : ''}${sd.year}`;
    }
  }

  const streams = dedupeStreams(
    (media.externalLinks || [])
      .filter((l) => l.type === 'STREAMING')
      .map((l) => ({ id: serviceId(l.site), name: l.site, url: l.url })),
  );

  return {
    key,
    source: 'anilist',
    id: media.id,
    kind: 'Anime',
    title: media.title?.english || media.title?.romaji || `Anime #${media.id}`,
    altTitle: media.title?.english && media.title?.romaji !== media.title?.english ? media.title.romaji : null,
    image: media.coverImage?.medium || null,
    url: media.siteUrl || null,
    status: ANILIST_STATUS[media.status] || 'Unknown',
    year: sd.year || null,
    format: ANILIST_FORMAT[media.format] || null,
    genres: (media.genres || []).slice(0, 4),
    score: media.averageScore || null,
    note,
    streams,
    episodes,
  };
}

/** Which anime season a date falls in, and the one after it. */
export function animeSeason(date = new Date(), offset = 0) {
  const names = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const index = Math.floor(date.getMonth() / 3) + offset;
  return { season: names[((index % 4) + 4) % 4], year: date.getFullYear() + Math.floor(index / 4) };
}

const TVMAZE_STATUS = {
  Running: 'Airing',
  Ended: 'Finished',
  'To Be Determined': 'To be determined',
  'In Development': 'Upcoming',
};

/** Turn a TVmaze show (optionally with _embedded.episodes) into our show shape. */
export function normalizeTvmaze(s, now = Date.now()) {
  const key = `tvmaze:${s.id}`;
  const episodes = (s._embedded?.episodes || [])
    .filter((e) => e.airstamp)
    .map((e) => ({
      id: `${key}:${e.season}x${e.number ?? 'sp' + e.id}`,
      label: e.number != null ? `S${e.season}E${e.number}` : 'Special',
      name: e.name || null,
      airsAt: Date.parse(e.airstamp),
    }))
    .filter((e) => Number.isFinite(e.airsAt) && e.airsAt >= now - PAST_WINDOW)
    .sort((a, b) => a.airsAt - b.airsAt);

  const streams = dedupeStreams(
    [s.webChannel, s.network]
      .filter((c) => c?.name)
      .map((c) => ({ id: serviceId(c.name), name: c.name, url: s.officialSite || null })),
  );

  return {
    key,
    source: 'tvmaze',
    id: s.id,
    kind: 'TV',
    title: s.name || `Show #${s.id}`,
    altTitle: null,
    image: s.image?.medium || null,
    url: s.url || null,
    status: TVMAZE_STATUS[s.status] || s.status || 'Unknown',
    year: s.premiered ? Number(s.premiered.slice(0, 4)) : null,
    note: null,
    streams,
    episodes,
  };
}

const TMDB_IMAGES = 'https://image.tmdb.org/t/p/w185';
// TMDB release types: 1 premiere, 2 limited theatrical, 3 theatrical, 4 digital, 5 physical, 6 TV.
const CINEMA_TYPES = [3, 2];

/**
 * Turn a TMDB movie (with release_dates and watch/providers appended) into our
 * show shape. A movie's "episodes" are its US release events: cinemas, digital.
 */
export function normalizeTmdb(m, now = Date.now()) {
  const key = `tmdb:${m.id}`;
  const day = (iso) => {
    const [y, mo, d] = String(iso).slice(0, 10).split('-').map(Number);
    return y && mo && d ? dateOnlyTime(y, mo, d) : null;
  };
  const us = (m.release_dates?.results || []).find((r) => r.iso_3166_1 === 'US')?.release_dates || [];
  const earliest = (types) => {
    const hits = us.filter((r) => types.includes(r.type) && day(r.release_date)).sort((a, b) => day(a.release_date) - day(b.release_date));
    return hits[0] || null;
  };
  const cinema = earliest(CINEMA_TYPES);
  const digital = earliest([4]);
  const events = [];
  if (cinema) events.push({ id: `${key}:cinema`, event: 'cinema', label: cinema.type === 2 ? 'In US cinemas (limited)' : 'In US cinemas', airsAt: day(cinema.release_date), dateOnly: true });
  if (digital) events.push({ id: `${key}:digital`, event: 'digital', label: 'Digital release', airsAt: day(digital.release_date), dateOnly: true });
  if (!events.length && day(m.release_date)) events.push({ id: `${key}:release`, event: 'release', label: 'Release', airsAt: day(m.release_date), dateOnly: true });
  const episodes = events.filter((e) => e.airsAt >= now - PAST_WINDOW).sort((a, b) => a.airsAt - b.airsAt);

  const providers = m['watch/providers']?.results?.US;
  const streams = dedupeStreams((providers?.flatrate || []).map((p) => ({ id: serviceId(p.provider_name), name: p.provider_name, url: providers.link || null })));
  // While it is in (or heading for) cinemas, offer a way to find showtimes.
  const inCinemas = cinema && day(cinema.release_date) >= now - 60 * DAY;

  return {
    key,
    source: 'tmdb',
    id: m.id,
    kind: 'Movie',
    title: m.title || `Movie #${m.id}`,
    altTitle: m.original_title && m.original_title !== m.title ? m.original_title : null,
    image: m.poster_path ? TMDB_IMAGES + m.poster_path : null,
    url: `https://www.themoviedb.org/movie/${m.id}`,
    status: episodes.some((e) => e.airsAt > now) ? 'Upcoming' : m.status === 'Released' ? 'Released' : m.status || 'Unknown',
    year: m.release_date ? Number(m.release_date.slice(0, 4)) || null : null,
    format: 'Movie',
    genres: (m.genres || []).map((g) => g.name).slice(0, 4),
    score: m.vote_count ? Math.round(m.vote_average * 10) : null,
    note: episodes.length || m.release_date ? null : 'No release date announced',
    tickets: inCinemas ? `https://www.fandango.com/search?q=${encodeURIComponent(m.title || '')}` : null,
    streams,
    episodes,
  };
}

/** First episode that has not aired yet, or null. */
export function nextEpisode(show, now = Date.now()) {
  return show.episodes.find((e) => e.airsAt > now) || null;
}

/** All episodes across shows with from <= airsAt < to, soonest first. */
export function episodesBetween(shows, from, to) {
  const out = [];
  for (const show of shows) {
    for (const ep of show.episodes) {
      if (ep.airsAt >= from && ep.airsAt < to) out.push({ show, ep });
    }
  }
  return out.sort((a, b) => a.ep.airsAt - b.ep.airsAt || a.show.title.localeCompare(b.show.title));
}

/**
 * Episodes that have aired since the show was added and have not been alerted yet.
 * `alerted` is a Set of episode ids.
 */
export function collectAlerts(shows, alerted, now = Date.now()) {
  const out = [];
  for (const show of shows) {
    for (const ep of show.episodes) {
      if (ep.airsAt <= now && ep.airsAt > (show.addedAt || 0) && !alerted.has(ep.id)) {
        out.push({ show, ep });
      }
    }
  }
  return out.sort((a, b) => a.ep.airsAt - b.ep.airsAt);
}

/** Which of the user's services carry this show. */
export function myStreams(show, myServices) {
  return show.streams.filter((s) => s.id && myServices.includes(s.id));
}

/** Local-time YYYY-MM-DD key for a timestamp or Date. */
export function dayKey(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Weeks (arrays of 7 Dates) covering the given month.
 * weekStart: 0 = Sunday, 1 = Monday.
 */
export function monthGrid(year, month, weekStart = 0) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const weeks = [];
  let day = 1 - offset;
  do {
    const week = [];
    for (let i = 0; i < 7; i++) week.push(new Date(year, month, day++));
    weeks.push(week);
  } while (new Date(year, month, day).getMonth() === month);
  return weeks;
}

/** "in 3d 4h", "in 5h 12m", "in 42m", "now". */
export function formatCountdown(ms) {
  if (ms < 60 * 1000) return 'now';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `in ${d}d${h ? ` ${h}h` : ''}`;
  if (h > 0) return `in ${h}h${m ? ` ${m}m` : ''}`;
  return `in ${m}m`;
}
