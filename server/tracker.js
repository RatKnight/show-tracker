// The part that runs around the clock: keeps schedules fresh and raises alerts.
//
// Schedules live once in a shared catalog; each user holds only the keys of the
// shows they track plus their own alerts, watched marks and settings. Every
// function that touches personal data takes the user it acts for.
import { collectAlerts, myStreams, serviceId, PAST_WINDOW } from '../app/js/core.js';
import { computeDiscover, buildSeries, withFranchiseRoots } from './discover.js';
import { localClock, inQuietHours, summarize } from './timing.js';
import { readFileSync } from 'node:fs';
import { buildBackup, writeSnapshot } from './backup.js';
import { matchEpisode, normTitle, sameSeries } from './extmatch.js';

const MAX_ALERTS = 100;
const MAX_TRACKED = 1000;
export const REFRESH_EVERY = 30 * 60 * 1000;
export const DISCOVER_EVERY = 12 * 60 * 60 * 1000;

export function createTracker({ store, sources, send, sendFile = async () => {}, mailer = { enabled: false }, now = Date.now }) {
  const { data } = store;
  let refreshing = null;
  let lastAttempt = 0;
  const discovering = new Map(); // user id -> in-flight promise
  const discoverAttempt = new Map(); // user id -> time of last try

  const users = () => Object.values(data.users);
  const fetchSingle = (source, id) => (source === 'tmdb' ? sources.fetchMovie(id, now()) : sources.fetchTv(id, now()));
  // Anime films heading for US cinemas, shared by everyone: { list, updatedAt }.
  let cinema = { list: [], updatedAt: 0 };
  let cinemaAttempt = 0;
  let dubAttempt = 0;

  // Bundles and ad tiers of a service the list already names.
  const NOT_A_SERVICE = /Amazon Channel|Apple TV Channel|Roku Premium Channel|with Ads/i;

  /** Replace a show's streaming badges with what is actually offered in a country, when known. */
  function localStreams(show, region) {
    const known = data.availability[show.key];
    const names = known?.byRegion?.[region];
    if (!names?.length) return show;
    const seen = new Set();
    const streams = [];
    for (const name of names) {
      if (NOT_A_SERVICE.test(name)) continue;
      const id = serviceId(name);
      if (seen.has(id || name)) continue;
      seen.add(id || name);
      // Keep the source's direct link to the show where there is one.
      streams.push({ id, name, url: show.streams.find((x) => x.id && x.id === id)?.url || known.links?.[region] || null });
    }
    return streams.length ? { ...show, streams, streamsRegion: region } : show;
  }

  /**
   * Apply a user's choice of subtitled or dubbed releases to an anime's episodes.
   * A show with no dub schedule keeps its subtitled episodes whatever the choice,
   * so it never drops off the lists.
   */
  function withAudio(show, audio) {
    const dubbed = data.dubs[show.key];
    if (!dubbed?.length || !audio || audio === 'sub') return show;
    const episodes = audio === 'dub' ? dubbed : [...show.episodes, ...dubbed].sort((a, b) => a.airsAt - b.airsAt);
    return { ...show, episodes, audio };
  }

  /**
   * Refresh English dub dates and attach them to the tracked anime they belong
   * to, matching on title. Dub episodes already known are kept for a month,
   * since the source only lists a few weeks at a time.
   */
  async function refreshDubs() {
    if (!sources.hasDubs?.()) return 0;
    const listed = await sources.fetchDubs(now());
    data.dubsAt = now();
    const byName = new Map();
    for (const entry of listed) for (const name of entry.names) byName.set(normTitle(name), [...(byName.get(normTitle(name)) || []), entry]);
    let matched = 0;
    for (const show of Object.values(data.catalog)) {
      if (show.source !== 'anilist') continue;
      // Exact title match only: a dub of "Season 2" must not land on season 1.
      const entries = [show.title, show.altTitle].map((t) => byName.get(normTitle(t))).find((x) => x?.length) || [];
      const known = new Map((data.dubs[show.key] || []).filter((e) => e.airsAt >= now() - PAST_WINDOW).map((e) => [e.id, e]));
      for (const e of entries) {
        const id = `${show.key}:dub:${e.episode}`;
        known.set(id, { id, label: `Episode ${e.episode} (dub)`, airsAt: e.airsAt, dub: true, watchId: `${show.key}:${e.episode}` });
      }
      if (entries.length) matched++;
      if (known.size) data.dubs[show.key] = [...known.values()].sort((a, b) => a.airsAt - b.airsAt);
      else delete data.dubs[show.key];
    }
    store.save();
    return matched;
  }

  /** A user's tracked shows: catalog entries stamped with when they added them. */
  const showsOf = (u) =>
    Object.entries(u.shows)
      .filter(([key]) => data.catalog[key])
      .map(([key, { addedAt }]) => ({ ...withAudio(localStreams(data.catalog[key], u.settings.region || 'US'), u.settings.audio), addedAt }));

  /** Which of a user's tracked anime are seasons of the same series. */
  const seriesOf = (u) => withFranchiseRoots(u.discover?.series || {}, showsOf(u), data.franchise);

  /**
   * Look up where tracked series stream, for every country a user has chosen.
   * A few per call; refreshed weekly. Anime wait for their first-season title,
   * which is what the lookup searches for.
   */
  async function fillAvailability(limit = 3) {
    if (!sources.hasMovies?.() || !sources.fetchAvailability) return 0;
    const regions = [...new Set(users().map((u) => u.settings.region || 'US'))];
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const due = Object.values(data.catalog)
      .filter((s) => s.source === 'anilist' || s.source === 'tvmaze')
      .filter((s) => s.source !== 'anilist' || data.franchise[s.key])
      .filter((s) => {
        const a = data.availability[s.key];
        return !a || now() - a.at > WEEK_MS || regions.some((r) => !(r in (a.byRegion || {})));
      })
      .slice(0, limit);
    for (const s of due) {
      const anime = s.source === 'anilist';
      try {
        const found = await sources.fetchAvailability({ title: anime ? data.franchise[s.key].root || s.title : s.title, altTitle: s.altTitle, imdb: s.imdb, anime }, regions);
        data.availability[s.key] = { ...found, at: now() };
      } catch (e) {
        // Try again tomorrow rather than on every pass.
        data.availability[s.key] = { ...(data.availability[s.key] || { tmdbId: null, byRegion: Object.fromEntries(regions.map((r) => [r, []])), links: {} }), at: now() - WEEK_MS + 24 * 60 * 60 * 1000 };
        console.error(`Availability lookup failed for ${s.key}:`, e.message);
      }
    }
    if (due.length) store.save();
    return due.length;
  }

  /** Drop catalog entries nobody tracks any more. */
  function pruneCatalog() {
    const wanted = new Set(users().flatMap((u) => Object.keys(u.shows)));
    for (const key of Object.keys(data.catalog)) if (!wanted.has(key)) delete data.catalog[key];
    for (const key of Object.keys(data.franchise)) if (!wanted.has(key)) delete data.franchise[key];
    for (const key of Object.keys(data.availability)) if (!wanted.has(key)) delete data.availability[key];
    for (const key of Object.keys(data.dubs)) if (!wanted.has(key)) delete data.dubs[key];
  }

  /**
   * Work out where tracked anime sit among their seasons (needed to translate a
   * streaming site's episode numbers). A few per call, since each takes several
   * requests; refreshed monthly because episode counts of airing seasons change.
   */
  async function fillFranchises(limit = 3) {
    if (!sources.fetchFranchise) return 0;
    const MONTH = 30 * 24 * 60 * 60 * 1000;
    const due = Object.values(data.catalog)
      .filter((s) => s.source === 'anilist' && now() - (data.franchise[s.key]?.at || 0) > MONTH)
      .slice(0, limit);
    for (const s of due) {
      try {
        data.franchise[s.key] = { ...(await sources.fetchFranchise(s.id)), at: now() };
      } catch (e) {
        // Remember the attempt so one bad entry cannot block the queue for long.
        data.franchise[s.key] = { ...(data.franchise[s.key] || { root: s.title, offset: 0, index: 1, count: null }), at: now() - MONTH + 60 * 60 * 1000 };
        // (No title in the log: what people watch stays out of unencrypted logs.)
        console.error(`Franchise lookup failed for ${s.key}:`, e.message);
      }
    }
    if (due.length) store.save();
    return due.length;
  }

  /** How many of a user's anime still wait for that lookup. */
  const franchisePending = (u) => Object.keys(u.shows).filter((k) => data.catalog[k]?.source === 'anilist' && !data.franchise[k]).length;

  /**
   * Mark episodes reported by the browser extension as watched.
   * items: [{ series, season, episode }]. Returns counts and what could not be placed.
   */
  function reportWatched(u, items, provider = 'crunchyroll') {
    const mine = showsOf(u).map((s) => ({ ...s, franchise: data.franchise[s.key] }));
    const watched = new Set(u.watched);
    const unmatched = new Map();
    let matched = 0;
    let added = 0;
    for (const item of items) {
      const hit = matchEpisode(item, mine);
      if (!hit) {
        if (unmatched.size < 50) unmatched.set(item.series, (unmatched.get(item.series) || 0) + 1);
        continue;
      }
      matched++;
      const id = `${hit.show.key}:${hit.number}`;
      if (!watched.has(id)) {
        watched.add(id);
        added++;
      }
    }
    if (added) {
      u.watched = [...watched].slice(-5000);
      store.save();
    }
    // Series that are not on the list at all become suggestions in Discover.
    // (Not while season lookups are outstanding: a later season of a tracked show
    // would look like a different, untracked series.)
    const suggested = franchisePending(u) ? 0 : noteSeen(u, [...unmatched.keys()], provider, 'history');
    return { received: items.length, matched, added, unmatched: [...unmatched].map(([series, count]) => ({ series, count })), pending: franchisePending(u), suggested };
  }

  /** Does the user already track this series, in any season? */
  function tracksSeries(u, title) {
    const want = normTitle(title);
    return showsOf(u).some((s) => [s.title, s.altTitle, data.franchise[s.key]?.root, u.discover?.series?.[s.key]?.title].some((t) => sameSeries(normTitle(t), want)));
  }

  /**
   * Remember shows seen on a streaming site (watched, or on a watchlist) that are
   * not tracked, so Discover can offer them. Returns how many were new.
   */
  function noteSeen(u, titles, provider, from) {
    let fresh = 0;
    for (const title of titles) {
      const key = normTitle(title);
      if (!key || key.length > 120 || tracksSeries(u, title)) continue;
      const known = u.extSeen[key];
      // A watchlist entry outranks "watched once": it says the user wants it.
      if (known && (known.from === 'watchlist' || from === 'history')) continue;
      if (!known) fresh++;
      u.extSeen[key] = { ...(known || { tried: false, show: null }), title: String(title).slice(0, 200), provider, from, at: now() };
    }
    // Keep the newest 300.
    const keys = Object.keys(u.extSeen);
    if (keys.length > 300) for (const k of keys.sort((a, b) => u.extSeen[a].at - u.extSeen[b].at).slice(0, keys.length - 300)) delete u.extSeen[k];
    if (fresh) store.save();
    return fresh;
  }

  /** Find the anime each remembered title refers to. A few per call (one search each). */
  async function resolveSeen(u, limit = 2) {
    const todo = Object.entries(u.extSeen).filter(([, e]) => !e.tried).slice(0, limit);
    for (const [key, entry] of todo) {
      entry.tried = true;
      try {
        const found = await sources.searchAnime(entry.title);
        // Only an actual title match counts; a loosely related search hit would be a wrong suggestion.
        entry.show = found.find((s) => [s.title, s.altTitle].some((t) => sameSeries(normTitle(t), key))) || null;
      } catch (e) {
        entry.tried = false; // try again later
        console.error('Lookup of a streaming-site title failed:', e.message);
        break;
      }
    }
    if (todo.length) store.save();
    return todo.length;
  }

  /** Suggestions from streaming sites that are still worth showing. */
  function seenSuggestions(u) {
    const hidden = new Set([...Object.keys(u.shows), ...u.dismissed]);
    return Object.values(u.extSeen)
      .filter((e) => e.show && !hidden.has(e.show.key) && !tracksSeries(u, e.title))
      .sort((a, b) => (b.from === 'watchlist') - (a.from === 'watchlist') || b.at - a.at)
      .map((e) => ({ ...e.show, provider: e.provider, from: e.from }));
  }
  const seenPending = (u) => Object.values(u.extSeen).filter((e) => !e.tried).length;

  /** What to say when something comes out: an episode, or a movie's release event. */
  const releaseText = (ep, where) => {
    if (ep.event === 'cinema') return ep.label.includes('limited') ? 'Opens in select US cinemas today' : 'Opens in US cinemas today';
    if (ep.event === 'digital') return `Out digitally today${where ? ` — on ${where}` : ''}`;
    if (ep.event === 'release') return 'Released today';
    return `${ep.label}${ep.name && ep.name !== ep.label ? ` “${ep.name}”` : ''} is out${where ? ` on ${where}` : ''}`;
  };

  const snapshotOf = (show) => ({ key: show.key, title: show.title, image: show.image, url: show.url, streams: show.streams, kind: show.kind });

  function pushAlert(u, entry) {
    u.alerts.unshift(entry);
    u.alerts.length = Math.min(u.alerts.length, MAX_ALERTS);
  }

  async function sendNow(u, messages) {
    const errors = await send(u.settings, messages);
    if (errors.length) {
      u.lastError = `Alert delivery failed — ${errors.join('; ')}`;
      store.save();
    }
  }

  /** Hold messages for delivery; muted shows are dropped here. */
  function queue(u, messages) {
    const wanted = messages.filter((m) => !u.muted.includes(m.showKey));
    if (!wanted.length) return;
    u.outbox.push(...wanted.map(({ showKey, ...m }) => m));
    u.outbox = u.outbox.slice(-200);
    store.save();
  }

  /** Send what is waiting, unless quiet hours or the digest schedule say to hold it. */
  async function flush(u) {
    const s = u.settings;
    const { hour, day } = localClock(now(), s.timeZone);
    if (inQuietHours(hour, s.quietStart, s.quietEnd)) return;
    const digest = s.alertMode === 'digest';
    if (digest) {
      // One send per day, at the first check on or after the chosen hour.
      if (hour < s.digestHour || u.lastDigestDay === day) return;
      u.lastDigestDay = day;
      store.save();
    }
    if (!u.outbox.length) return;
    const batch = u.outbox.splice(0);
    store.save();
    await sendNow(u, batch.length > 1 && (digest || batch.length > 5) ? [summarize(batch)] : batch);
  }

  async function checkAlerts(u) {
    const fresh = collectAlerts(showsOf(u), new Set(u.alerted), now());
    if (!fresh.length) return [];
    for (const { show, ep } of fresh) {
      u.alerted.push(ep.id);
      // The show is snapshotted so the alert still renders if it is removed later.
      pushAlert(u, { showKey: show.key, show: snapshotOf(show), ep, read: false });
    }
    u.alerted = u.alerted.slice(-2000);
    store.save();

    queue(
      u,
      fresh.map(({ show, ep }) => {
        const mine = myStreams(show, u.settings.services);
        const where = mine.map((s) => s.name).join(', ');
        return {
          title: show.title,
          body: releaseText(ep, where),
          url: mine[0]?.url || show.url,
          image: show.image,
          at: ep.airsAt,
          showKey: show.key,
        };
      }),
    );
    await flush(u);
    return fresh;
  }

  /** Heads-up shortly before an episode airs, when the user asked for one. */
  async function checkReminders(u) {
    const lead = (u.settings.remindMinutes || 0) * 60 * 1000;
    if (!lead) return;
    const done = new Set(u.reminded);
    const due = [];
    for (const show of showsOf(u)) {
      for (const ep of show.episodes) {
        if (ep.dateOnly || done.has(ep.id) || ep.airsAt <= now() || ep.airsAt - lead > now()) continue;
        u.reminded.push(ep.id);
        if (!u.muted.includes(show.key)) due.push({ show, ep });
      }
    }
    if (!due.length) return;
    u.reminded = u.reminded.slice(-2000);
    store.save();
    // Reminders are only useful right now, so they skip the digest but respect quiet hours.
    const { hour } = localClock(now(), u.settings.timeZone);
    if (inQuietHours(hour, u.settings.quietStart, u.settings.quietEnd)) return;
    await sendNow(
      u,
      due.map(({ show, ep }) => ({
        title: show.title,
        body: `${ep.label} airs in ${Math.max(1, Math.round((ep.airsAt - now()) / 60000))} minutes`,
        url: show.url,
        image: show.image,
        at: ep.airsAt,
      })),
    );
  }

  /**
   * Rebuild one user's Discover suggestions. Unless `silent`, a new season that
   * was not known before raises an alert.
   */
  async function doDiscover(u, silent) {
    // The very first run only records what already exists, so a new account does
    // not get an alert for every season already announced.
    silent ||= !u.discover;
    const found = await computeDiscover({ shows: showsOf(u), sources, now: now() });
    const known = new Set(u.seenSequels);
    const news = found.sequels.filter((s) => s.fresh && !known.has(s.key));
    u.seenSequels = [...new Set([...u.seenSequels, ...found.sequels.map((s) => s.key)])].slice(-5000);
    // Following a series means its new seasons join the list by themselves —
    // except ones the user has removed or waved away.
    const adopted = new Set();
    if (u.settings.autoTrackSeasons) {
      const wanted = found.sequels.filter((s) => s.fresh && !u.dismissed.includes(s.key) && !u.shows[s.key]);
      if (wanted.length) {
        await addMany(u, wanted.map((s) => ({ source: 'anilist', id: s.id })), { discover: false });
        for (const s of wanted) if (u.shows[s.key]) adopted.add(s.key);
      }
    }
    u.discover = { ...found, series: buildSeries(showsOf(u), found.links), updatedAt: now() };
    delete u.discover.links;
    // Name a new season after the series it belongs to, not the season before it.
    for (const s of u.discover.sequels) s.from = u.discover.series[s.fromKey]?.title || s.from;
    if (!silent) {
      for (const s of news) {
        pushAlert(u, { showKey: s.key, show: snapshotOf(s), ep: { id: `season:${s.key}`, label: `New season of ${s.from}`, airsAt: now() }, read: false });
      }
    }
    store.save();
    if (!silent && news.length) {
      queue(
        u,
        news.map((s) => ({
          title: s.title,
          body: `New season of ${s.from} ${s.status === 'Airing' ? 'is airing' : 'announced'}${s.note ? ` — ${s.note.toLowerCase()}` : ''}${adopted.has(s.key) ? '. Added to your list.' : ''}`,
          url: s.url,
          image: s.image,
          at: now(),
        })),
      );
      await flush(u);
    }
  }

  function refreshDiscover(u, { silent = false } = {}) {
    if (!discovering.has(u.id)) {
      discovering.set(
        u.id,
        doDiscover(u, silent).finally(() => discovering.delete(u.id)),
      );
    }
    return discovering.get(u.id);
  }
  const discoverSoon = (u) => {
    refreshDiscover(u, { silent: true }).catch((e) => console.error('Discover refresh failed:', e.message));
  };

  /** Re-fetch every catalog entry, then check everyone's alerts. */
  async function doRefresh() {
    const failures = [];
    const keep = (fresh) => {
      if (fresh && data.catalog[fresh.key]) data.catalog[fresh.key] = fresh;
    };
    pruneCatalog();
    const current = Object.values(data.catalog);
    const animeIds = current.filter((s) => s.source === 'anilist').map((s) => s.id);
    if (animeIds.length) {
      try {
        (await sources.fetchAnime(animeIds, now())).forEach(keep);
      } catch (e) {
        failures.push(e.message);
      }
    }
    // TV shows and movies are fetched one at a time.
    for (const s of current.filter((x) => x.source !== 'anilist')) {
      try {
        keep(await fetchSingle(s.source, s.id));
      } catch (e) {
        failures.push(e.message);
      }
    }
    if (failures.length) {
      data.lastError = `Could not update everything: ${[...new Set(failures)].join(' ')}`;
    } else {
      data.lastError = null;
      data.lastRefresh = now();
    }
    store.save();
    for (const u of users()) await checkAlerts(u);
  }

  /**
   * Track several shows at once for a user. `wanted` is [{ source, id, addedAt? }];
   * returns how many were new to them. Shows someone else already tracks are
   * reused from the catalog without another fetch.
   */
  async function addMany(u, wanted, { discover = true } = {}) {
    const keyOf = (w) => `${w.source}:${w.id}`;
    // A ceiling per person keeps one account from swamping the schedule sources for everyone.
    const room = Math.max(0, MAX_TRACKED - Object.keys(u.shows).length);
    const missing = wanted.filter((w) => !u.shows[keyOf(w)]).slice(0, room);
    const toFetch = missing.filter((w) => !data.catalog[keyOf(w)]);
    const animeIds = toFetch.filter((w) => w.source === 'anilist').map((w) => w.id);
    const fetched = animeIds.length ? await sources.fetchAnime(animeIds, now()) : [];
    for (const w of toFetch.filter((x) => x.source !== 'anilist')) {
      const show = await fetchSingle(w.source, w.id).catch(() => null);
      if (show) fetched.push(show);
    }
    const asked = new Set(toFetch.map(keyOf));
    for (const show of fetched) if (show && asked.has(show.key)) data.catalog[show.key] = show;

    let added = 0;
    for (const w of missing) {
      const key = keyOf(w);
      if (!data.catalog[key] || u.shows[key]) continue;
      u.shows[key] = { addedAt: w.addedAt || now() };
      added++;
    }
    // Adding a show by hand overrides an earlier "not interested".
    const now_ = new Set(missing.map(keyOf).filter((k) => u.shows[k]));
    if (discover) u.dismissed = u.dismissed.filter((k) => !now_.has(k));
    if (added) {
      // Newly tracked anime get their dub dates at the next pass, not after the retry delay.
      data.dubsAt = 0;
      dubAttempt = 0;
      store.save();
      if (discover) discoverSoon(u);
    }
    return added;
  }

  const admins = () => users().filter((u) => u.admin);
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  /**
   * Off-site copy: once a week, e-mail the encrypted data file to every admin
   * with a confirmed address. Never sent unencrypted.
   */
  async function emailBackup() {
    if (!data.site.backupEmail || !mailer.enabled || !store.encrypted || now() - data.lastBackupEmail <= WEEK) return;
    const to = admins().filter((u) => u.email);
    if (!to.length) return;
    // Recorded first, so a failing mail service is retried next week rather than every minute.
    data.lastBackupEmail = now();
    store.save();
    const day = new Date(now()).toISOString().slice(0, 10);
    const file = readFileSync(store.file);
    for (const u of to) {
      await mailer
        .send({
          to: u.email,
          subject: `Show Tracker backup ${day}`,
          text: `Hi ${u.username},\n\nAttached is this week's copy of the Show Tracker data file (${Object.keys(data.users).length} accounts). It is encrypted: restoring it needs the DATA_KEY the site runs with, so keep that somewhere safe too.\n\nTo restore: stop the app, put this file in the data folder as state.json, and start the app with the same DATA_KEY.\n\nYou can switch these e-mails off in the Admin tab.`,
          attachments: [{ filename: `show-tracker-state-${day}.json`, content: file }],
        })
        .catch((e) => {
          u.lastError = `Weekly backup e-mail failed — ${e.message}`;
          store.save();
        });
    }
  }

  /**
   * Tell the admins when schedule updates have been failing for hours, and
   * again when they recover. Uses their own alert channels, plus e-mail.
   */
  async function checkHealth() {
    if (!data.site.healthAlerts || !Object.keys(data.catalog).length) return;
    const stale = now() - data.lastRefresh > 3 * 60 * 60 * 1000;
    if (stale === data.staleAlerted) return;
    data.staleAlerted = stale;
    store.save();
    const message = stale
      ? { title: 'Show Tracker: schedule updates are failing', body: `No successful update for over 3 hours. ${data.lastError || ''}`.trim() }
      : { title: 'Show Tracker: schedule updates are working again', body: 'Updates recovered.' };
    for (const u of admins()) {
      await send(u.settings, [{ ...message, at: now() }]).catch(() => {});
      if (mailer.enabled && u.email) await mailer.send({ to: u.email, subject: message.title, text: `Hi ${u.username},\n\n${message.body}\n\nYou can switch these alerts off in the Admin tab.` }).catch(() => {});
    }
  }

  /** Daily copy of the data file; weekly personal backup to Discord for those who opted in. */
  async function runBackups() {
    const { day } = localClock(now(), '');
    if (data.lastSnapshotDay !== day) {
      data.lastSnapshotDay = day;
      store.save();
      writeSnapshot(store, day);
    }
    for (const u of users()) {
      const s = u.settings;
      if (!s.backupToDiscord || !s.discordWebhook || now() - u.lastDiscordBackup <= 7 * 24 * 60 * 60 * 1000) continue;
      // Recorded first, so a failing webhook is retried next week rather than every minute.
      u.lastDiscordBackup = now();
      store.save();
      try {
        await sendFile(s.discordWebhook, `show-tracker-backup-${day}.json`, JSON.stringify(buildBackup(u, data.catalog, now()), null, 1), `Weekly Show Tracker backup (${Object.keys(u.shows).length} shows).`);
      } catch (e) {
        u.lastError = `Weekly backup to Discord failed — ${e.message}`;
        store.save();
      }
    }
  }

  /**
   * Refresh the shared list of anime films with a US cinema date, and tell each
   * user who wants to know about ones they have not been told of yet.
   */
  async function refreshCinema() {
    if (!sources.hasMovies?.()) return cinema;
    cinema = { list: await sources.fetchCinemaAnime(now()), updatedAt: now() };
    const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    for (const u of users()) {
      const known = new Set(u.seenCinema || []);
      const first = !u.seenCinema; // a new account is not told about everything already listed
      const fresh = cinema.list.filter((m) => !known.has(m.key) && !u.shows[m.key] && m.episodes.some((e) => e.event === 'cinema' && e.airsAt > now()));
      u.seenCinema = [...new Set([...known, ...cinema.list.map((m) => m.key)])].slice(-2000);
      if (first || !u.settings.cinemaAlerts || !fresh.length) continue;
      for (const m of fresh) {
        pushAlert(u, { showKey: m.key, show: snapshotOf(m), ep: { id: `cinema:${m.key}`, label: 'Coming to US cinemas', airsAt: now() }, read: false });
      }
      queue(
        u,
        fresh.map((m) => ({
          title: m.title,
          body: `Anime film coming to US cinemas on ${day.format(m.episodes.find((e) => e.event === 'cinema').airsAt)}`,
          url: m.tickets || m.url,
          image: m.image,
          at: now(),
        })),
      );
      await flush(u);
    }
    store.save();
    return cinema;
  }

  return {
    showsOf,
    refreshDubs,
    seriesOf,
    fillAvailability,
    emailBackup,
    checkHealth,
    reportWatched,
    noteSeen,
    resolveSeen,
    seenSuggestions,
    seenPending,
    fillFranchises,
    refreshCinema,
    cinema: () => cinema,
    checkAlerts,
    flush,
    refreshDiscover,
    addMany,
    runBackups,
    /** Concurrent callers share one refresh. */
    refresh() {
      refreshing ||= doRefresh().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    async addShow(u, source, id) {
      if (!['anilist', 'tvmaze', 'tmdb'].includes(source)) throw new Error('Show not found.');
      const key = `${source}:${id}`;
      if (!u.shows[key] && !(await addMany(u, [{ source, id }]))) throw new Error('Show not found.');
      return key;
    },
    removeShow(u, key) {
      const had = Object.hasOwn(u.shows, key);
      const wasAnime = data.catalog[key]?.source === 'anilist';
      delete u.shows[key];
      delete u.progress[key];
      u.muted = u.muted.filter((k) => k !== key);
      // Remembered, so a season that was removed is not added back automatically.
      if (had && !u.dismissed.includes(key)) u.dismissed = [...u.dismissed, key].slice(-2000);
      if (u.discover?.series) delete u.discover.series[key];
      pruneCatalog();
      store.save();
      if (had && wasAnime) discoverSoon(u);
    },
    /** Remove an account and everything only it was using. */
    removeUser(id) {
      delete data.users[id];
      for (const [hash, r] of Object.entries(data.resets)) if (r.userId === id) delete data.resets[hash];
      pruneCatalog();
      store.save();
    },
    /** Called every minute. */
    async tick() {
      const stale = Object.keys(data.catalog).length && now() - data.lastRefresh > REFRESH_EVERY;
      // After a failed refresh, wait a few minutes before trying again.
      if (stale && now() - lastAttempt > 5 * 60 * 1000) {
        lastAttempt = now();
        await this.refresh();
      } else {
        for (const u of users()) await checkAlerts(u);
      }
      for (const u of users()) {
        await checkReminders(u);
        // Releases anything held back by quiet hours or waiting for the digest.
        await flush(u);
        await resolveSeen(u).catch((e) => console.error('Lookup failed:', e.message));
        // Suggestions change slowly: rebuild twice a day, retrying hourly on failure.
        const discoverStale = now() - (u.discover?.updatedAt || 0) > DISCOVER_EVERY;
        if (discoverStale && now() - (discoverAttempt.get(u.id) || 0) > 60 * 60 * 1000) {
          discoverAttempt.set(u.id, now());
          await refreshDiscover(u).catch((e) => console.error('Discover refresh failed:', e.message));
        }
      }
      // Cinema listings change slowly: twice a day, retrying hourly on failure.
      if (sources.hasMovies?.() && now() - cinema.updatedAt > DISCOVER_EVERY && now() - cinemaAttempt > 60 * 60 * 1000) {
        cinemaAttempt = now();
        await refreshCinema().catch((e) => console.error('Cinema refresh failed:', e.message));
      }
      await fillFranchises().catch((e) => console.error('Franchise lookup failed:', e.message));
      await fillAvailability().catch((e) => console.error('Availability lookup failed:', e.message));
      // Dub dates: every six hours, retrying hourly on failure.
      if (sources.hasDubs?.() && now() - data.dubsAt > 6 * 60 * 60 * 1000 && now() - dubAttempt > 60 * 60 * 1000) {
        dubAttempt = now();
        await refreshDubs().catch((e) => console.error('Dub schedule refresh failed:', e.message));
        for (const u of users()) await checkAlerts(u);
      }
      await emailBackup().catch((e) => console.error('Backup e-mail failed:', e.message));
      await checkHealth().catch((e) => console.error('Health check failed:', e.message));
      await runBackups().catch((e) => console.error('Backup failed:', e.message));
      // Expired invite and reset links are of no further use.
      for (const bag of [data.invites, data.resets]) {
        for (const [hash, entry] of Object.entries(bag)) if (entry.expiresAt < now()) delete bag[hash];
      }
    },
  };
}
