// Runs on crunchyroll.com. When the history page is open, reads the entries
// that are on screen and passes the finished ones to the background script.
/* global parseCrunchyrollHistory */
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const sent = new Set(); // entries already passed on during this page visit
  let timer = null;
  let retries = 0;
  let note = null;

  const onHistory = () => /\/history(\/|$)/.test(location.pathname);

  function say(message) {
    if (!note) {
      note = document.createElement('div');
      note.setAttribute('role', 'status');
      note.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:10px 14px;border-radius:8px;' +
        'background:#1a1d25;color:#e8eaf0;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);border:1px solid #2e3342';
      document.documentElement.append(note);
    }
    note.textContent = `Show Tracker: ${message}`;
    note.hidden = false;
    clearTimeout(note.timer);
    note.timer = setTimeout(() => (note.hidden = true), 8000);
  }

  async function sync() {
    if (!onHistory()) return;
    const fresh = parseCrunchyrollHistory(document).filter((i) => i.watched && !sent.has(i.id));
    if (!fresh.length) return;
    for (const i of fresh) sent.add(i.id);
    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: 'watched', items: fresh.map(({ series, season, episode }) => ({ series, season, episode })) });
    } catch (e) {
      reply = { error: e.message };
    }
    if (!reply || reply.error) {
      for (const i of fresh) sent.delete(i.id); // try these again on the next change
      if (reply?.error !== 'not-configured') say(reply?.error || 'could not reach the extension.');
      return;
    }
    if (reply.added) say(`${reply.added} episode${reply.added === 1 ? '' : 's'} marked as watched.`);
    if (reply.pending && retries < 6) {
      // The tracker is still working out how some shows' seasons line up. Offer
      // everything again shortly; what is already marked is simply skipped.
      retries++;
      if (!reply.added) say('looking up your shows’ seasons…');
      setTimeout(() => {
        sent.clear();
        sync();
      }, 20000);
    }
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(sync, 1500);
  };
  // The site loads more entries as you scroll and changes page without reloading.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
