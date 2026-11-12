// Holds the connection to your Show Tracker: receives watched episodes from the
// Crunchyroll page and reports them with your personal access token.
const api = globalThis.browser ?? globalThis.chrome;

async function report(items) {
  const { site, token } = await api.storage.local.get(['site', 'token']);
  if (!site || !token) return { error: 'not-configured' };
  let res;
  try {
    res = await fetch(`${site}/api/ext/watched`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'crunchyroll', items }),
    });
  } catch {
    return { error: 'could not reach your Show Tracker. Check the address in the extension settings.' };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || `your Show Tracker replied ${res.status}.` };

  // Keep a running summary for the popup.
  const { last = {} } = await api.storage.local.get('last');
  const unmatched = new Map((last.unmatched || []).map((u) => [u.series, u.count]));
  for (const u of body.unmatched || []) unmatched.set(u.series, u.count);
  await api.storage.local.set({
    // `received` is the size of the latest batch (retries resend the same entries); `added` accumulates.
    last: { at: Date.now(), received: Math.max(body.received, last.at > Date.now() - 5 * 60 * 1000 ? last.received || 0 : 0), added: (last.added || 0) + body.added, unmatched: [...unmatched].map(([series, count]) => ({ series, count })).slice(0, 50), pending: body.pending },
  });
  return body;
}

/** Names of shows on a streaming site's watchlist, to be offered in Discover. */
async function reportSeen(series) {
  const { site, token } = await api.storage.local.get(['site', 'token']);
  if (!site || !token) return { error: 'not-configured' };
  try {
    const res = await fetch(`${site}/api/ext/seen`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'crunchyroll', series }),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok ? body : { error: body.error || `your Show Tracker replied ${res.status}.` };
  } catch {
    return { error: 'could not reach your Show Tracker. Check the address in the extension settings.' };
  }
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'seen' && Array.isArray(message.series)) {
    reportSeen(message.series).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message?.type !== 'watched' || !Array.isArray(message.items)) return false;
  report(message.items).then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true; // the reply comes later
});
