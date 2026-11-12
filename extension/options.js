const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const say = (text, cls = '') => {
  $('status').textContent = text;
  $('status').className = cls;
};

api.storage.local.get(['site', 'token']).then(({ site, token }) => {
  if (site) $('site').value = site;
  if (token) $('token').value = token;
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let origin;
  try {
    origin = new URL($('site').value.trim()).origin;
  } catch {
    return say('That address does not look right.', 'error');
  }
  const token = $('token').value.trim();
  // The browser asks you to let the extension talk to that one address.
  // (Crunchyroll is included because some Firefox versions do not grant it at install.)
  const allowed = await api.permissions.request({ origins: [`${origin}/*`, 'https://www.crunchyroll.com/*'] }).catch(() => false);
  if (!allowed) return say('Permission to contact that address was not given.', 'error');
  say('Testing…');
  try {
    const res = await fetch(`${origin}/api/ext/ping`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return say(body.error || `Your Show Tracker replied ${res.status}.`, 'error');
    await api.storage.local.set({ site: origin, token, last: {} });
    say(`Connected as ${body.username}. Open your Crunchyroll history page to sync.`, 'good');
  } catch {
    say('Could not reach that address.', 'error');
  }
});

$('forget').addEventListener('click', async () => {
  await api.storage.local.remove(['site', 'token', 'last']);
  $('site').value = $('token').value = '';
  say('Disconnected.');
});
