// The part that runs around the clock: keeps schedules fresh and raises alerts.
//
// Schedules live once in a shared catalog; each user holds only the keys of the
// shows they track plus their own alerts, watched marks and settings. Every
// function that touches personal data takes the user it acts for.
import { collectAlerts, myStreams } from '../app/js/core.js';
import { computeDiscover } from './discover.js';
import { localClock, inQuietHours, summarize } from './timing.js';
import { buildBackup, writeSnapshot } from './backup.js';

const MAX_ALERTS = 100;
export const REFRESH_EVERY = 30 * 60 * 1000;
export const DISCOVER_EVERY = 12 * 60 * 60 * 1000;

export function createTracker({ store, sources, send, sendFile = async () => {}, now = Date.now }) {
  const { data } = store;
  let refreshing = null;
  let lastAttempt = 0;
  const discovering = new Map(); // user id -> in-flight promise
  const discoverAttempt = new Map(); // user id -> time of last try

  const users = () => Object.values(data.users);

  /** A user's tracked shows: catalog entries stamped with when they added them. */
  const showsOf = (u) =>
    Object.entries(u.shows)
      .filter(([key]) => data.catalog[key])
      .map(([key, { addedAt }]) => ({ ...data.catalog[key], addedAt }));

  /** Drop catalog entries nobody tracks any more. */
  function pruneCatalog() {
    const wanted = new Set(users().flatMap((u) => Object.keys(u.shows)));
    for (const key of Object.keys(data.catalog)) if (!wanted.has(key)) delete data.catalog[key];
  }

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
          body: `${ep.label}${ep.name && ep.name !== ep.label ? ` “${ep.name}”` : ''} is out${where ? ` on ${where}` : ''}`,
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
    u.discover = { ...found, updatedAt: now() };
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
          body: `New season of ${s.from} ${s.status === 'Airing' ? 'is airing' : 'announced'}${s.note ? ` — ${s.note.toLowerCase()}` : ''}`,
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
    for (const s of current.filter((x) => x.source === 'tvmaze')) {
      try {
        keep(await sources.fetchTv(s.id, now()));
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
  async function addMany(u, wanted) {
    const keyOf = (w) => `${w.source}:${w.id}`;
    const missing = wanted.filter((w) => !u.shows[keyOf(w)]);
    const toFetch = missing.filter((w) => !data.catalog[keyOf(w)]);
    const animeIds = toFetch.filter((w) => w.source === 'anilist').map((w) => w.id);
    const fetched = animeIds.length ? await sources.fetchAnime(animeIds, now()) : [];
    for (const w of toFetch.filter((x) => x.source === 'tvmaze')) {
      const show = await sources.fetchTv(w.id, now()).catch(() => null);
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
    if (added) {
      store.save();
      discoverSoon(u);
    }
    return added;
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

  return {
    showsOf,
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
      if (!['anilist', 'tvmaze'].includes(source)) throw new Error('Show not found.');
      const key = `${source}:${id}`;
      if (!u.shows[key] && !(await addMany(u, [{ source, id }]))) throw new Error('Show not found.');
      return key;
    },
    removeShow(u, key) {
      const had = Object.hasOwn(u.shows, key);
      const wasAnime = data.catalog[key]?.source === 'anilist';
      delete u.shows[key];
      u.muted = u.muted.filter((k) => k !== key);
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
        // Suggestions change slowly: rebuild twice a day, retrying hourly on failure.
        const discoverStale = now() - (u.discover?.updatedAt || 0) > DISCOVER_EVERY;
        if (discoverStale && now() - (discoverAttempt.get(u.id) || 0) > 60 * 60 * 1000) {
          discoverAttempt.set(u.id, now());
          await refreshDiscover(u).catch((e) => console.error('Discover refresh failed:', e.message));
        }
      }
      await runBackups().catch((e) => console.error('Backup failed:', e.message));
      // Expired invite and reset links are of no further use.
      for (const bag of [data.invites, data.resets]) {
        for (const [hash, entry] of Object.entries(bag)) if (entry.expiresAt < now()) delete bag[hash];
      }
    },
  };
}
