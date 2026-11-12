const api = globalThis.browser ?? globalThis.chrome;
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};

api.storage.local.get(['site', 'token', 'last']).then(({ site, token, last }) => {
  const body = document.getElementById('body');
  if (!site || !token) {
    body.append(el('p', 'Not connected yet. Open Settings and enter your Show Tracker address and access token.', 'error'));
    return;
  }
  body.append(el('p', `Connected to ${new URL(site).host}.`, 'muted'));
  if (!last?.at) {
    body.append(el('p', 'Nothing synced yet. Open your Crunchyroll history page and scroll through it.'));
    return;
  }
  body.append(el('p', `Last sync ${new Date(last.at).toLocaleString()}: ${last.added} newly marked as watched, out of ${last.received} finished episodes seen.`));
  if (last.pending) body.append(el('p', 'Some of your shows are still being looked up. Reload the history page in a minute.', 'muted'));
  if (last.unmatched?.length) {
    body.append(el('p', 'Not matched (not on your Show Tracker list, or numbered differently):', 'muted'));
    const list = el('ul');
    for (const u of last.unmatched.slice(0, 12)) list.append(el('li', `${u.series} (${u.count})`));
    body.append(list);
  }
});

document.getElementById('history').addEventListener('click', () => api.tabs.create({ url: 'https://www.crunchyroll.com/history' }));
document.getElementById('watchlist').addEventListener('click', () => api.tabs.create({ url: 'https://www.crunchyroll.com/watchlist' }));
document.getElementById('settings').addEventListener('click', () => api.runtime.openOptionsPage());
