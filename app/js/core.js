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

const ANILIST_STATUS = {
  RELEASING: 'Airing',
  NOT_YET_RELEASED: 'Upcoming',
  FINISHED: 'Finished',
  CANCELLED: 'Cancelled',
  HIATUS: 'On hiatus',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Turn an AniList Media object plus its airing-schedule nodes into our show shape.
 * `schedule` is a list of { episode, airingAt (unix seconds) }.
 */
export function normalizeAnilist(media, schedule = [], now = Date.now()) {
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
      const at = new Date(sd.year, sd.month - 1, sd.day).getTime();
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
    note,
    streams,
    episodes,
  };
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
