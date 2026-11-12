// Suggestions built from the tracked list: new seasons of shows you follow, and
// what viewers of those shows recommend.
import { normalizeAnilist } from '../app/js/core.js';
import { normTitle, sameSeries } from './extmatch.js';

const MAX_RECS = 40;

/**
 * Returns { sequels: [show + { from, fresh }], recs: [show + { because }] }.
 * `sources.fetchRelated(ids, opts)` supplies raw AniList sequel / recommendation data.
 */
export async function computeDiscover({ shows, sources, now = Date.now() }) {
  const tracked = shows.filter((s) => s.source === 'anilist');
  const trackedIds = new Set(tracked.map((s) => s.id));
  if (!tracked.length) return { sequels: [], recs: [], links: [] };

  const related = await sources.fetchRelated([...trackedIds]);

  // Walk each sequel chain: season 1 -> 2 -> 3 ..., since the new season is often
  // several steps past the one that is tracked.
  const sequels = new Map();
  const visited = new Set(trackedIds);
  // Every "season A is followed by season B" pair seen, used to group seasons into series.
  const links = [];
  for (const s of tracked) for (const media of related.get(s.id)?.sequels || []) links.push([s.id, media.id]);
  let frontier = tracked.flatMap((s) => (related.get(s.id)?.sequels || []).map((media) => ({ media, from: s.title, fromKey: s.key })));
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const follow = [];
    for (const { media, from, fromKey } of frontier) {
      if (visited.has(media.id)) continue;
      visited.add(media.id);
      sequels.set(media.id, { media, from, fromKey });
      follow.push({ id: media.id, from, fromKey });
    }
    if (!follow.length) break;
    const more = await sources.fetchRelated(follow.map((f) => f.id), { recommendations: false });
    for (const f of follow) for (const media of more.get(f.id)?.sequels || []) links.push([f.id, media.id]);
    frontier = follow.flatMap((f) => (more.get(f.id)?.sequels || []).map((media) => ({ media, from: f.from, fromKey: f.fromKey })));
  }

  // Recommendations: each tracked show votes for its top picks, best pick weighted
  // most, so titles recommended by several of your shows rise to the top.
  const votes = new Map();
  for (const s of tracked) {
    (related.get(s.id)?.recs || []).forEach(({ media }, i) => {
      if (visited.has(media.id)) return;
      const v = votes.get(media.id) || { media, score: 0, because: [] };
      v.score += Math.max(1, 8 - i);
      v.because.push(s.title);
      votes.set(media.id, v);
    });
  }

  return {
    links,
    sequels: [...sequels.values()]
      .map(({ media, from, fromKey }) => ({ ...normalizeAnilist(media, undefined, now), from, fromKey, fresh: media.status === 'NOT_YET_RELEASED' || media.status === 'RELEASING' }))
      .sort((a, b) => b.fresh - a.fresh || (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title)),
    recs: oneSeasonEach([...votes.values()].sort((a, b) => b.score - a.score || (b.media.averageScore || 0) - (a.media.averageScore || 0)))
      .slice(0, MAX_RECS)
      .map(({ media, because }) => ({ ...normalizeAnilist(media, undefined, now), because: because.slice(0, 3) })),
  };
}

/**
 * Group a user's tracked anime into series: seasons joined by sequel links
 * (directly, or through seasons that are not tracked) belong together.
 * Returns { [showKey]: { id, title } } for shows in a series of two or more;
 * the series takes the name of its earliest season.
 */
export function buildSeries(shows, links) {
  const parent = new Map();
  const find = (x) => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  for (const [a, b] of links) {
    const ra = find(a);
    const rb = find(b);
    parent.set(ra, ra);
    parent.set(rb, ra);
  }
  const groups = new Map();
  for (const s of shows) {
    if (s.source !== 'anilist' || !parent.has(s.id)) continue;
    const root = find(s.id);
    groups.set(root, [...(groups.get(root) || []), s]);
  }
  const series = {};
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const first = [...members].sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.id - b.id)[0];
    for (const s of members) series[s.key] = { id: first.key, title: first.title };
  }
  return series;
}

/** Keep one entry per series: later seasons of something already listed are dropped. */
function oneSeasonEach(ranked) {
  const kept = [];
  for (const v of ranked) {
    const name = normTitle(v.media.title?.english || v.media.title?.romaji);
    const twin = kept.find((k) => sameSeries(k.name, name));
    if (!twin) kept.push({ ...v, name });
    // Prefer the first season (the shorter title) as the one shown.
    else if (name.length < twin.name.length) Object.assign(twin, { ...v, name, score: twin.score, because: twin.because });
  }
  return kept;
}

/**
 * Extend a series map with what the prequel lookups know: tracked anime that
 * share a first season belong together even when their sequel links did not
 * connect them (a film or special in between, or suggestions not built yet).
 * franchise: { [showKey]: { root } }.
 */
export function withFranchiseRoots(series, shows, franchise) {
  const out = { ...series };
  const byRoot = new Map();
  for (const s of shows) {
    const root = s.source === 'anilist' ? normTitle(franchise[s.key]?.root) : '';
    if (root) byRoot.set(root, [...(byRoot.get(root) || []), s]);
  }
  for (const members of byRoot.values()) {
    const known = members.map((s) => out[s.key]).find(Boolean);
    if (members.length < 2 && !known) continue;
    const first = [...members].sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.id - b.id)[0];
    const label = known || { id: first.key, title: franchise[first.key].root || first.title };
    for (const s of members) out[s.key] ||= label;
  }
  // A "series" of one is not a series.
  const sizes = new Map();
  for (const v of Object.values(out)) sizes.set(v.id, (sizes.get(v.id) || 0) + 1);
  for (const [k, v] of Object.entries(out)) if (sizes.get(v.id) < 2) delete out[k];
  return out;
}
