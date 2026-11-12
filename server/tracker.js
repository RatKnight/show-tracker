// The part that runs around the clock: keeps schedules fresh and raises alerts.
import { collectAlerts, myStreams } from '../app/js/core.js';

const MAX_ALERTS = 100;
export const REFRESH_EVERY = 30 * 60 * 1000;

export function createTracker({ store, sources, send, now = Date.now }) {
  const { data } = store;
  let refreshing = null;
  let lastAttempt = 0;

  const fetchOne = async (source, id) => {
    if (source === 'anilist') return (await sources.fetchAnime([id], now()))[0] || null;
    if (source === 'tvmaze') return sources.fetchTv(id, now());
    return null;
  };

  async function checkAlerts() {
    const fresh = collectAlerts(Object.values(data.shows), new Set(data.alerted), now());
    if (!fresh.length) return [];
    for (const { show, ep } of fresh) {
      data.alerted.push(ep.id);
      data.alerts.unshift({
        showKey: show.key,
        // Snapshot so the alert still renders if the show is removed later.
        show: { key: show.key, title: show.title, image: show.image, url: show.url, streams: show.streams, kind: show.kind },
        ep,
        read: false,
      });
    }
    data.alerts.length = Math.min(data.alerts.length, MAX_ALERTS);
    data.alerted = data.alerted.slice(-2000);
    store.save();

    const messages = fresh.map(({ show, ep }) => {
      const mine = myStreams(show, data.settings.services);
      const where = mine.map((s) => s.name).join(', ');
      return {
        title: show.title,
        body: `${ep.label}${ep.name && ep.name !== ep.label ? ` “${ep.name}”` : ''} is out${where ? ` on ${where}` : ''}`,
        url: mine[0]?.url || show.url,
        image: show.image,
        at: ep.airsAt,
      };
    });
    const errors = await send(data.settings, messages);
    if (errors.length) {
      data.lastError = `Alert delivery failed — ${errors.join('; ')}`;
      store.save();
    }
    return fresh;
  }

  async function doRefresh() {
    const failures = [];
    const keep = (fresh) => {
      const old = fresh && data.shows[fresh.key];
      if (old) data.shows[fresh.key] = { ...fresh, addedAt: old.addedAt };
    };
    const current = Object.values(data.shows);
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
    await checkAlerts();
  }

  return {
    checkAlerts,
    /** Concurrent callers share one refresh. */
    refresh() {
      refreshing ||= doRefresh().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    async addShow(source, id) {
      const show = await fetchOne(source, id);
      if (!show) throw new Error('Show not found.');
      if (!data.shows[show.key]) {
        data.shows[show.key] = { ...show, addedAt: now() };
        store.save();
      }
      return data.shows[show.key];
    },
    removeShow(key) {
      delete data.shows[key];
      store.save();
    },
    /** Called every minute. */
    async tick() {
      const stale = Object.keys(data.shows).length && now() - data.lastRefresh > REFRESH_EVERY;
      // After a failed refresh, wait a few minutes before trying again.
      if (stale && now() - lastAttempt > 5 * 60 * 1000) {
        lastAttempt = now();
        await this.refresh();
      } else {
        await checkAlerts();
      }
    },
  };
}
