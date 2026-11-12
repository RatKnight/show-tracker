// Runs on crunchyroll.com and hidive.com. Reads what is on screen on the
// history, watchlist and show pages and passes it to the background script.
/* global parseCrunchyrollHistory, parseCrunchyrollWatchlist, parseHidiveSeason, parseHidiveHistory */
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const sent = new Set(); // entries already passed on during this page visit
  let timer = null;
  let retries = 0;
  let note = null;

  const HIDIVE = /(^|\.)hidive\.com$/.test(location.hostname);
  const onHistory = () => !HIDIVE && /\/history(\/|$)/.test(location.pathname);

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
    const extra = reply.suggested ? ` ${reply.suggested} show${reply.suggested === 1 ? '' : 's'} you watch but do not track are under Discover in Show Tracker.` : '';
    if (reply.added) say(`${reply.added} episode${reply.added === 1 ? '' : 's'} marked as watched.${extra}`);
    else if (extra) say(extra.trim());
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

  const onWatchlist = () => !HIDIVE && /\/watchlist(\/|$)/.test(location.pathname);
  const listed = new Set(); // watchlist names already passed on during this page visit

  async function syncWatchlist() {
    if (!onWatchlist()) return;
    const fresh = parseCrunchyrollWatchlist(document).filter((name) => !listed.has(name));
    if (!fresh.length) return;
    for (const name of fresh) listed.add(name);
    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: 'seen', series: fresh });
    } catch (e) {
      reply = { error: e.message };
    }
    if (!reply || reply.error) {
      for (const name of fresh) listed.delete(name);
      if (reply?.error !== 'not-configured') say(reply?.error || 'could not reach the extension.');
      return;
    }
    if (reply.suggested) say(`${reply.suggested} show${reply.suggested === 1 ? '' : 's'} from your watchlist are waiting under Discover in Show Tracker.`);
    else say('everything on your watchlist that was read is already tracked or suggested.');
  }

  // ---- HIDIVE
  const hdSent = new Set(); // "series|season|episode" already passed on during this page visit
  let hdRetries = 0;

  async function report(items, provider) {
    try {
      return await api.runtime.sendMessage({ type: 'watched', provider, items });
    } catch (e) {
      return { error: e.message };
    }
  }

  async function syncHidive() {
    if (!HIDIVE) return;
    const { hidive: known = {} } = await api.storage.local.get('hidive');
    const items = [];
    let unplaced = 0;

    // A show's page teaches which video is which episode, and shows what is finished.
    const season = parseHidiveSeason(document);
    if (season) {
      let learned = false;
      for (const ep of season.episodes) {
        const entry = `${season.series}|${season.season ?? ''}|${ep.episode}`;
        if (known[ep.videoId] !== entry) {
          known[ep.videoId] = entry;
          learned = true;
        }
        if (ep.watched) items.push({ series: season.series, season: season.season, episode: ep.episode });
      }
      if (learned) {
        const ids = Object.keys(known);
        for (const id of ids.slice(0, Math.max(0, ids.length - 20000))) delete known[id];
        await api.storage.local.set({ hidive: known });
      }
    }
    // The history page only has video numbers: place the ones learned so far.
    for (const ep of parseHidiveHistory(document)) {
      if (!ep.watched) continue;
      const entry = known[ep.videoId];
      if (!entry) {
        unplaced++;
        continue;
      }
      const [series, seasonNumber, episode] = entry.split('|');
      items.push({ series, season: seasonNumber ? Number(seasonNumber) : null, episode: Number(episode) });
    }

    const fresh = items.filter((i) => !hdSent.has(`${i.series}|${i.season}|${i.episode}`));
    if (!fresh.length) {
      if (unplaced && !hdSent.has('unplaced-note')) {
        hdSent.add('unplaced-note');
        say(`${unplaced} watched episode${unplaced === 1 ? ' is' : 's are'} from shows not seen yet. Open each show’s page on HIDIVE once and they will sync.`);
      }
      return;
    }
    for (const i of fresh) hdSent.add(`${i.series}|${i.season}|${i.episode}`);
    const reply = await report(fresh, 'hidive');
    if (!reply || reply.error) {
      for (const i of fresh) hdSent.delete(`${i.series}|${i.season}|${i.episode}`);
      if (reply?.error !== 'not-configured') say(reply?.error || 'could not reach the extension.');
      return;
    }
    const parts = [];
    if (reply.added) parts.push(`${reply.added} episode${reply.added === 1 ? '' : 's'} marked as watched.`);
    if (reply.suggested) parts.push(`${reply.suggested} show${reply.suggested === 1 ? '' : 's'} you watch but do not track are under Discover in Show Tracker.`);
    if (unplaced) parts.push(`${unplaced} more are from shows not seen yet: open each show’s page on HIDIVE once.`);
    if (parts.length) say(parts.join(' '));
    if (reply.pending && hdRetries < 6) {
      hdRetries++;
      if (!parts.length) say('looking up your shows’ seasons…');
      setTimeout(() => {
        hdSent.clear();
        syncHidive();
      }, 20000);
    }
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      sync();
      syncWatchlist();
      syncHidive().catch(() => {});
    }, 1500);
  };
  // The site loads more entries as you scroll and changes page without reloading.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
