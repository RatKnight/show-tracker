// Matching what a streaming site says was watched to episodes in the tracker.
//
// Streaming sites and AniList number episodes differently: a site may count
// straight through every season ("E42"), while AniList restarts at 1 for each
// season entry. `franchise` info per tracked anime bridges the two:
//   { root, offset, index, count }
// root: title of the first season; offset: episodes in all earlier seasons;
// index: 1-based position among the TV seasons; count: episodes in this one.

/** Lower-case, accents and punctuation removed: "SPY×FAMILY" ~ "spy x family". */
export function normTitle(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/×/g, 'x') // SPY×FAMILY is written both ways
    .replace(/[^a-z0-9]+/g, '');
}

/** Are two normalised titles the same series (one may carry a season suffix)? */
export function sameSeries(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // "Frieren: Beyond Journey's End" vs "Frieren: Beyond Journey's End Season 2"
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 6 && long.startsWith(short);
}

/**
 * Find the tracked episode an item refers to.
 * item: { series, season (number|null), episode (number) }
 * shows: the user's tracked anime, each with `franchise` when known.
 * Returns { show, number } or null when nothing fits with confidence.
 */
export function matchEpisode(item, shows) {
  const want = normTitle(item.series);
  const e = item.episode;
  if (!want || !Number.isInteger(e) || e < 1) return null;
  // A show whose place among its seasons is not known yet cannot be matched
  // safely: episode 18 could be season 1's or, wrongly, a 12-episode season 2's.
  const cands = shows.filter((s) => s.source === 'anilist' && s.franchise && [s.title, s.altTitle, s.franchise.root].some((t) => sameSeries(normTitle(t), want)));
  if (!cands.length) return null;
  const fits = (s, n) => n >= 1 && n <= (s.franchise.count || 2000);

  // The site names the season: trust that when it lines up with a season we know.
  if (item.season != null) {
    const bySeason = cands.filter((s) => s.franchise.index === item.season && fits(s, e));
    if (bySeason.length === 1) return { show: bySeason[0], number: e };
    // Some sites name the season but keep counting ("Season 2, E21"): take the
    // earlier seasons' episodes off.
    const counted = cands.filter((s) => s.franchise.index === item.season && s.franchise.offset > 0 && fits(s, e - s.franchise.offset));
    if (!bySeason.length && counted.length === 1) return { show: counted[0], number: e - counted[0].franchise.offset };
  } else {
    // No season named: the number counts through every earlier season.
    const straight = cands.filter((s) => fits(s, e - s.franchise.offset));
    if (straight.length === 1) return { show: straight[0], number: e - straight[0].franchise.offset };
  }
  // The site names a season we cannot line up (it splits seasons differently):
  // accept the number as-is only when exactly one tracked later season could hold it.
  if (item.season != null) {
    const direct = cands.filter((s) => fits(s, e) && s.franchise.index >= item.season);
    if (direct.length === 1) return { show: direct[0], number: e };
  }
  return null;
}
