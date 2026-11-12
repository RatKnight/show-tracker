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
