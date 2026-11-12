// Reads Crunchyroll's history page. Kept free of extension APIs so it can be
// tested against a saved copy of the page.
//
// Each history entry is a card with: the show's name, a title such as
// "E6 - Some Title" or "S2 E11 - Some Title", and either a replay icon / the
// word "Watched" (finished) or "23m left" (not finished).

/* exported parseCrunchyrollHistory */
function parseCrunchyrollHistory(root) {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const items = [];
  for (const card of root.querySelectorAll('[class*="history-playable-card--"]')) {
    const series = text(card.querySelector('[class*="history-playable-card__show-title"]'));
    const title = text(card.querySelector('[class*="history-playable-card__title-link"]')) || text(card.querySelector('[class*="history-playable-card__title--"]'));
    const numbers = /^(?:S(\d+)\s+)?E(\d+)\b/.exec(title);
    if (!series || !numbers) continue; // films and extras carry no episode number

    const status = text(card.querySelector('[class*="playable-thumbnail__duration"]'));
    const left = /^(\d+)m left$/i.exec(status);
    // Finished: the replay icon (in any language), or only the credits remaining.
    const watched = Boolean(card.querySelector('[data-t="replay-svg"]')) || /^watched$/i.test(status) || (left !== null && Number(left[1]) <= 3);

    const link = card.querySelector('a[href*="/watch/"]');
    const id = link ? (/\/watch\/([^/?#]+)/.exec(link.getAttribute('href')) || [])[1] : null;
    items.push({
      id: id || `${series}|${title}`,
      series,
      season: numbers[1] ? Number(numbers[1]) : null,
      episode: Number(numbers[2]),
      watched,
    });
  }
  return items;
}

// Reads Crunchyroll's watchlist page: just the names of the shows on it.
//
// Written without a saved copy of the page to check against, so it tries the
// card layout first and then falls back to any link to a series page.
/* exported parseCrunchyrollWatchlist */
function parseCrunchyrollWatchlist(root) {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const names = new Set();
  for (const card of root.querySelectorAll('[class*="watchlist-card--"], [class*="watchlist-card "]')) {
    const name = text(card.querySelector('[class*="watchlist-card-title"]')) || text(card.querySelector('h4, h3'));
    if (name) names.add(name);
  }
  if (!names.size) {
    const scope = root.querySelector('main, [class*="watchlist"], [class*="erc-my-lists"]') || root;
    for (const a of scope.querySelectorAll('a[href*="/series/"]')) {
      const name = a.getAttribute('title') || text(a);
      if (name && name.length <= 200) names.add(name);
    }
  }
  return [...names];
}

// ---------------------------------------------------------------- HIDIVE
//
// HIDIVE's history page does not say which show an episode belongs to; only a
// show's own page does. So a show page is read for two things at once: which
// video is which episode (remembered, so history entries can be placed later),
// and which of its episodes are finished.

/** Is this episode card finished? `bare` is what a card without a progress bar means. */
function hidiveFinished(card, bare) {
  const bar = card.querySelector('.card-progress__bar');
  if (!bar) return bare;
  const width = parseFloat((/width:\s*([\d.]+)%/.exec(bar.getAttribute('style') || '') || [])[1]);
  if (width >= 90) return true;
  // "2 minutes 49 seconds remaining": only the credits are left.
  const left = /^(\d+) minutes? /.exec(card.querySelector('.card-progress')?.getAttribute('aria-label') || '');
  return left !== null && Number(left[1]) <= 3;
}

function hidiveCards(root, type) {
  const out = [];
  for (const link of root.querySelectorAll(`a[data-content-type="${type}"][href*="/video/"]`)) {
    const videoId = (/\/video\/(\d+)/.exec(link.getAttribute('href')) || [])[1];
    const title = (link.querySelector('.card-title__title')?.textContent || link.getAttribute('aria-label') || '').trim();
    const number = /^E(\d+)\b/.exec(title);
    if (videoId && number) out.push({ link, videoId, episode: Number(number[1]) });
  }
  return out;
}

/**
 * A show's page: { series, season, episodes: [{ videoId, episode, watched }] },
 * or null when this is not one.
 */
/* exported parseHidiveSeason */
function parseHidiveSeason(root) {
  const cards = hidiveCards(root, 'SEASON_VOD');
  if (!cards.length) return null;
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const series = text(root.querySelector('[data-testid*="hero-heading-container"]')) || text(root.querySelector('h1')).replace(/\s*-\s*HIDIVE$/i, '');
  if (!series) return null;
  const picked = /^Season (\d+) selected$/i.exec(root.querySelector('button[aria-label$=" selected"]')?.getAttribute('aria-label') || '');
  // On a show page, a card without a bar has not been started.
  return { series, season: picked ? Number(picked[1]) : null, episodes: cards.map((c) => ({ videoId: c.videoId, episode: c.episode, watched: hidiveFinished(c.link, false) })) };
}

/** The history page: [{ videoId, episode, watched }]. The show is not named here. */
/* exported parseHidiveHistory */
function parseHidiveHistory(root) {
  if (!root.querySelector('.history-group')) return [];
  // In history, a card without a bar is one that was watched to the end.
  return hidiveCards(root.querySelector('.history-group').parentElement || root, 'VOD').map((c) => ({ videoId: c.videoId, episode: c.episode, watched: hidiveFinished(c.link, true) }));
}
