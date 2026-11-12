// Suggestions built from the tracked list: new seasons of shows you follow, and
// what viewers of those shows recommend.
import { normalizeAnilist } from '../app/js/core.js';

const MAX_RECS = 40;

/**
 * Returns { sequels: [show + { from, fresh }], recs: [show + { because }] }.
 * `sources.fetchRelated(ids, opts)` supplies raw AniList sequel / recommendation data.
 */
export async function computeDiscover({ shows, sources, now = Date.now() }) {
  const tracked = shows.filter((s) => s.source === 'anilist');
  const trackedIds = new Set(tracked.map((s) => s.id));
  if (!tracked.length) return { sequels: [], recs: [] };

  const related = await sources.fetchRelated([...trackedIds]);

  // Walk each sequel chain: season 1 -> 2 -> 3 ..., since the new season is often
  // several steps past the one that is tracked.
  const sequels = new Map();
  const visited = new Set(trackedIds);
  let frontier = tracked.flatMap((s) => (related.get(s.id)?.sequels || []).map((media) => ({ media, from: s.title })));
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const follow = [];
    for (const { media, from } of frontier) {
      if (visited.has(media.id)) continue;
      visited.add(media.id);
      sequels.set(media.id, { media, from });
      follow.push({ id: media.id, from });
    }
    if (!follow.length) break;
    const more = await sources.fetchRelated(follow.map((f) => f.id), { recommendations: false });
    frontier = follow.flatMap((f) => (more.get(f.id)?.sequels || []).map((media) => ({ media, from: f.from })));
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
    sequels: [...sequels.values()]
      .map(({ media, from }) => ({ ...normalizeAnilist(media, undefined, now), from, fresh: media.status === 'NOT_YET_RELEASED' || media.status === 'RELEASING' }))
      .sort((a, b) => b.fresh - a.fresh || (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title)),
    recs: [...votes.values()]
      .sort((a, b) => b.score - a.score || (b.media.averageScore || 0) - (a.media.averageScore || 0))
      .slice(0, MAX_RECS)
      .map(({ media, because }) => ({ ...normalizeAnilist(media, undefined, now), because: because.slice(0, 3) })),
  };
}
