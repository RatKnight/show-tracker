import {
  DAY,
  SERVICES,
  DEFAULT_SERVICES,
  nextEpisode,
  episodesBetween,
  collectAlerts,
  myStreams,
  dayKey,
  monthGrid,
  formatCountdown,
} from './core.js';
import { searchAnime, searchTv, fetchAnime, fetchTv } from './api.js';

const STORE_KEY = 'show-tracker:v1';
const REFRESH_EVERY = 30 * 60 * 1000;
const MAX_ALERTS = 100;

// ---------------------------------------------------------------- state

function loadState() {
  const base = {
    shows: {},
    alerts: [],
    alerted: [],
    lastRefresh: 0,
    settings: { services: [...DEFAULT_SERVICES], notify: true },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) return { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
  } catch {
    /* corrupt or unavailable storage: start fresh */
  }
  return base;
}

const state = loadState();
const ui = {
  tab: 'upcoming',
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDay: dayKey(Date.now()),
  refreshing: false,
  error: null,
};

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    ui.error = 'Could not save to browser storage — changes will be lost when this tab closes.';
  }
}

const shows = () => Object.values(state.shows);

// ---------------------------------------------------------------- dom helpers

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

/** Only ever link to http(s) URLs that came back from an API. */
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

function link(url, text, cls) {
  const href = safeUrl(url);
  return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text) : h('span', { class: cls }, text);
}

const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const fmtShortDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const fmtDow = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

const timeOf = (ep) => (ep.dateOnly ? 'All day' : fmtTime.format(ep.airsAt));

function dayLabel(key) {
  const now = Date.now();
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now + DAY)) return 'Tomorrow';
  if (key === dayKey(now - DAY)) return 'Yesterday';
  return null;
}

function weekStart() {
  try {
    const loc = new Intl.Locale(navigator.language);
    const info = loc.getWeekInfo?.() || loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    /* fall through */
  }
  return 0;
}

// ---------------------------------------------------------------- components

function badges(show, { kind = false } = {}) {
  const mine = state.settings.services;
  const out = [];
  if (kind) out.push(h('span', { class: 'badge kind' }, show.kind));
  const sorted = [...show.streams].sort((a, b) => mine.includes(b.id) - mine.includes(a.id));
  for (const s of sorted.slice(0, 4)) {
    const isMine = s.id && mine.includes(s.id);
    out.push(link(s.url, s.name, `badge${isMine ? ` mine ${s.id}` : ''}`));
  }
  if (show.streams.length && !myStreams(show, mine).length) {
    out.push(h('span', { class: 'badge warn', title: 'None of the listed streaming sites match your services' }, 'Not on your services'));
  }
  return h('div', { class: 'badges' }, out);
}

function thumb(show) {
  const src = safeUrl(show.image);
  return src ? h('img', { class: 'thumb', src, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb' });
}

function episodeRow({ show, ep }, { showDate = false, unread = false } = {}) {
  const now = Date.now();
  const sub = [ep.label, ep.name && ep.name !== ep.label ? `· ${ep.name}` : null].filter(Boolean).join(' ');
  return h(
    'div',
    { class: `row${unread ? ' unread' : ''}` },
    h('div', { class: 'when' }, showDate ? fmtShortDay.format(ep.airsAt) : timeOf(ep), h('small', {}, showDate ? timeOf(ep) : ep.airsAt > now ? formatCountdown(ep.airsAt - now) : 'aired')),
    thumb(show),
    h('div', { class: 'body' }, h('div', { class: 'title' }, link(show.url, show.title)), h('div', { class: 'sub' }, sub)),
    h('div', { class: 'side' }, badges(show)),
  );
}

function empty(title, text) {
  return h('div', { class: 'empty' }, h('strong', {}, title), text);
}

// ---------------------------------------------------------------- views

function viewUpcoming() {
  if (!shows().length) {
    return empty('Nothing tracked yet', 'Use the search box above to add anime or TV shows. New episodes will show up here.');
  }
  const now = Date.now();
  const startOfToday = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const upcoming = episodesBetween(shows(), startOfToday, now + 60 * DAY).filter((x) => x.ep.airsAt > now || dayKey(x.ep.airsAt) === dayKey(now));
  const recent = episodesBetween(shows(), now - 7 * DAY, startOfToday).reverse();

  const out = [];
  if (!upcoming.length) {
    out.push(empty('No episodes scheduled', 'None of your shows have an episode announced in the next 60 days.'));
  }
  const byDay = new Map();
  for (const item of upcoming) {
    const k = dayKey(item.ep.airsAt);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(item);
  }
  for (const [k, items] of byDay) {
    const label = dayLabel(k);
    const date = fmtDay.format(items[0].ep.airsAt);
    out.push(
      h('section', {}, h('h2', {}, label ? [h('span', { class: label === 'Today' ? 'today' : '' }, label), ` · ${date}`] : date), h('div', { class: 'list' }, items.map((i) => episodeRow(i)))),
    );
  }
  if (recent.length) {
    out.push(h('section', {}, h('h2', {}, 'Aired in the last 7 days'), h('div', { class: 'list' }, recent.map((i) => episodeRow(i, { showDate: true })))));
  }
  return out;
}

function viewCalendar() {
  const now = Date.now();
  const today = dayKey(now);
  const year = ui.month.getFullYear();
  const month = ui.month.getMonth();
  const ws = weekStart();
  const weeks = monthGrid(year, month, ws);
  const from = weeks[0][0].getTime();
  const to = weeks.at(-1)[6].getTime() + DAY + 2 * 3600 * 1000; // pad for DST days

  const byDay = new Map();
  for (const item of episodesBetween(shows(), from, to)) {
    const k = dayKey(item.ep.airsAt);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(item);
  }

  const move = (delta) => () => {
    ui.month = new Date(year, month + delta, 1);
    render();
  };
  const head = h(
    'div',
    { class: 'cal-head' },
    h('h3', {}, fmtMonth.format(ui.month)),
    h('button', { class: 'btn', type: 'button', onclick: move(-1), 'aria-label': 'Previous month' }, '‹'),
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          const d = new Date();
          ui.month = new Date(d.getFullYear(), d.getMonth(), 1);
          ui.selectedDay = dayKey(d);
          render();
        },
      },
      'Today',
    ),
    h('button', { class: 'btn', type: 'button', onclick: move(1), 'aria-label': 'Next month' }, '›'),
  );

  const grid = h('div', { class: 'cal' });
  for (const d of weeks[0]) grid.append(h('div', { class: 'dow' }, fmtDow.format(d)));
  for (const d of weeks.flat()) {
    const k = dayKey(d);
    const items = byDay.get(k) || [];
    const cls = ['cell', d.getMonth() !== month && 'other', k === today && 'today', k === ui.selectedDay && 'selected'].filter(Boolean).join(' ');
    grid.append(
      h(
        'button',
        {
          class: cls,
          type: 'button',
          'aria-label': `${fmtDay.format(d)}, ${items.length} episode${items.length === 1 ? '' : 's'}`,
          onclick: () => {
            ui.selectedDay = k;
            render();
          },
        },
        h('span', { class: 'num' }, d.getDate()),
        items.slice(0, 3).map(({ show, ep }) => {
          const svc = myStreams(show, state.settings.services)[0]?.id || (show.streams.length ? 'none' : '');
          return h('span', { class: `chip ${svc}${ep.airsAt <= now ? ' past' : ''}`, title: `${show.title} — ${ep.label} (${timeOf(ep)})` }, show.title);
        }),
        items.length > 3 && h('span', { class: 'more' }, `+${items.length - 3} more`),
      ),
    );
  }

  const selected = byDay.get(ui.selectedDay) || [];
  const [sy, sm, sd] = ui.selectedDay.split('-').map(Number);
  const detail = h(
    'section',
    { class: 'day-detail' },
    h('h2', {}, fmtDay.format(new Date(sy, sm - 1, sd))),
    selected.length ? h('div', { class: 'list' }, selected.map((i) => episodeRow(i))) : h('p', { class: 'muted' }, 'Nothing scheduled.'),
  );
  return [head, grid, detail];
}

function viewShows() {
  if (!shows().length) {
    return empty('Your list is empty', 'Search for a title above and press Add.');
  }
  const now = Date.now();
  const sorted = shows().sort((a, b) => {
    const na = nextEpisode(a, now)?.airsAt ?? Infinity;
    const nb = nextEpisode(b, now)?.airsAt ?? Infinity;
    return na - nb || a.title.localeCompare(b.title);
  });
  return h(
    'div',
    { class: 'list' },
    sorted.map((show) => {
      const next = nextEpisode(show, now);
      const nextText = next
        ? `Next: ${next.label} · ${fmtShortDay.format(next.airsAt)}${next.dateOnly ? '' : `, ${fmtTime.format(next.airsAt)}`} (${formatCountdown(next.airsAt - now)})`
        : show.note || 'No upcoming episode announced';
      return h(
        'div',
        { class: 'row' },
        thumb(show),
        h('div', { class: 'body' }, h('div', { class: 'title' }, link(show.url, show.title)), h('div', { class: 'sub' }, `${show.status} · ${nextText}`)),
        h(
          'div',
          { class: 'side' },
          badges(show, { kind: true }),
          h(
            'button',
            {
              class: 'btn quiet',
              type: 'button',
              'aria-label': `Remove ${show.title}`,
              onclick: () => {
                if (!confirm(`Stop tracking "${show.title}"?`)) return;
                delete state.shows[show.key];
                save();
                render();
              },
            },
            'Remove',
          ),
        ),
      );
    }),
  );
}

function viewAlerts() {
  const items = state.alerts;
  const out = [];
  const perm = notifyPermission();
  if (perm !== 'granted') {
    out.push(
      h(
        'section',
        {},
        h(
          'div',
          { class: 'card' },
          h('p', {}, perm === 'unsupported' ? 'This browser does not support desktop notifications. New episodes will still be listed here.' : perm === 'denied' ? 'Desktop notifications are blocked for this site. Allow them in your browser’s site settings to get a pop-up when an episode airs.' : 'Turn on desktop notifications to get a pop-up when a new episode airs.'),
          perm === 'default' && h('button', { class: 'btn primary', type: 'button', onclick: enableNotifications }, 'Enable notifications'),
        ),
      ),
    );
  }
  if (!items.length) {
    out.push(empty('No alerts yet', 'When a new episode of a tracked show airs, it will appear here.'));
    return out;
  }
  out.push(
    h(
      'section',
      {},
      h(
        'div',
        { class: 'section-head' },
        h('h2', {}, 'New episodes'),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              state.alerts = [];
              save();
              render();
            },
          },
          'Clear all',
        ),
      ),
      h(
        'div',
        { class: 'list' },
        items.map((a) => episodeRow({ show: state.shows[a.showKey] || a.show, ep: a.ep }, { showDate: true, unread: !a.read })),
      ),
    ),
  );
  return out;
}

function viewSettings() {
  const s = state.settings;
  const perm = notifyPermission();
  return [
    h(
      'section',
      {},
      h('h2', {}, 'My streaming services'),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted' }, 'Shows are tagged with where they stream. Services you tick here are highlighted, and shows that are not on any of them get a warning.'),
        h(
          'div',
          { class: 'checks' },
          Object.entries(SERVICES).map(([id, name]) =>
            h(
              'label',
              {},
              h('input', {
                type: 'checkbox',
                checked: s.services.includes(id),
                onchange: (e) => {
                  s.services = e.target.checked ? [...s.services, id] : s.services.filter((x) => x !== id);
                  save();
                  render();
                },
              }),
              name,
            ),
          ),
        ),
      ),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Notifications'),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'checks' },
          h(
            'label',
            {},
            h('input', {
              type: 'checkbox',
              checked: s.notify,
              onchange: (e) => {
                s.notify = e.target.checked;
                save();
                if (s.notify && notifyPermission() === 'default') enableNotifications();
                else render();
              },
            }),
            'Show a desktop notification when a new episode airs',
          ),
        ),
        h('p', { class: 'muted small' }, `Browser permission: ${perm}. Notifications only fire while this page is open (a pinned or background tab is fine); anything that aired while it was closed is listed under Alerts next time you open it.`),
        perm === 'granted' &&
          h(
            'button',
            { class: 'btn', type: 'button', onclick: () => new Notification('Show Tracker', { body: 'Notifications are working.' }) },
            'Send a test notification',
          ),
      ),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'About the data'),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted' }, 'Anime schedules come from AniList and TV schedules from TVmaze. Anime times are the Japanese broadcast time; the episode usually reaches Crunchyroll or HIDIVE within an hour or so, but some simulcasts are delayed. Streaming-site tags are not region-specific, so double-check availability in your country.'),
        h('p', { class: 'muted' }, 'Your list is stored in this browser only.'),
      ),
    ),
  ];
}

const TABS = [
  ['upcoming', 'Upcoming', viewUpcoming],
  ['calendar', 'Calendar', viewCalendar],
  ['shows', 'My shows', viewShows],
  ['alerts', 'Alerts', viewAlerts],
  ['settings', 'Settings', viewSettings],
];

// ---------------------------------------------------------------- render

const $ = (id) => document.getElementById(id);

function render() {
  const unread = state.alerts.filter((a) => !a.read).length;
  $('tabs').replaceChildren(
    ...TABS.map(([id, label]) =>
      h(
        'button',
        {
          class: 'tab',
          type: 'button',
          'aria-current': ui.tab === id ? 'page' : null,
          onclick: () => setTab(id),
        },
        label,
        id === 'shows' && shows().length > 0 && h('span', { class: 'muted' }, ` ${shows().length}`),
        id === 'alerts' && unread > 0 && h('span', { class: 'count' }, unread),
      ),
    ),
  );

  $('banner').hidden = !ui.error;
  $('banner').textContent = ui.error || '';

  $('refresh-btn').disabled = ui.refreshing || !shows().length;
  $('refresh-btn').textContent = ui.refreshing ? 'Refreshing…' : 'Refresh';
  $('refresh-status').textContent = state.lastRefresh && shows().length ? `Updated ${fmtTime.format(state.lastRefresh)}` : '';

  document.title = unread ? `(${unread}) Show Tracker` : 'Show Tracker';

  const view = TABS.find(([id]) => id === ui.tab)[2]();
  $('view').replaceChildren(...[view].flat());
}

function setTab(id) {
  // Leaving the alerts tab marks what you saw there as read.
  if (ui.tab === 'alerts' && id !== 'alerts') {
    for (const a of state.alerts) a.read = true;
    save();
  }
  ui.tab = id;
  render();
}

// ---------------------------------------------------------------- alerts

function notifyPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

async function enableNotifications() {
  try {
    await Notification.requestPermission();
  } catch {
    /* ignore */
  }
  render();
}

function notify(title, body, icon, tag) {
  if (!state.settings.notify || notifyPermission() !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: safeUrl(icon) || undefined, tag });
    n.onclick = () => {
      window.focus();
      setTab('alerts');
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

function checkAlerts() {
  const fresh = collectAlerts(shows(), new Set(state.alerted));
  if (!fresh.length) return false;
  for (const { show, ep } of fresh) {
    state.alerted.push(ep.id);
    state.alerts.unshift({
      showKey: show.key,
      // Snapshot so the alert still renders if the show is removed later.
      show: { key: show.key, title: show.title, image: show.image, url: show.url, streams: show.streams, kind: show.kind },
      ep,
      read: false,
    });
  }
  state.alerts.length = Math.min(state.alerts.length, MAX_ALERTS);
  state.alerted = state.alerted.slice(-2000);
  save();

  if (fresh.length <= 3) {
    for (const { show, ep } of fresh) {
      const where = myStreams(show, state.settings.services).map((s) => s.name).join(', ');
      notify(show.title, `${ep.label} is out${where ? ` on ${where}` : ''}`, show.image, ep.id);
    }
  } else {
    const names = [...new Set(fresh.map((f) => f.show.title))];
    notify(`${fresh.length} new episodes`, names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : ''), null, 'batch');
  }
  return true;
}

// ---------------------------------------------------------------- data refresh

function storeShow(fresh, addedAt) {
  state.shows[fresh.key] = { ...fresh, addedAt };
}

async function refreshAll() {
  if (ui.refreshing || !shows().length) return;
  ui.refreshing = true;
  ui.error = null;
  render();
  const failures = [];
  try {
    const current = shows();
    const animeIds = current.filter((s) => s.source === 'anilist').map((s) => s.id);
    if (animeIds.length) {
      try {
        for (const fresh of await fetchAnime(animeIds)) {
          if (state.shows[fresh.key]) storeShow(fresh, state.shows[fresh.key].addedAt);
        }
      } catch (e) {
        failures.push(e.message);
      }
    }
    for (const s of current.filter((x) => x.source === 'tvmaze')) {
      try {
        const fresh = await fetchTv(s.id);
        if (state.shows[fresh.key]) storeShow(fresh, state.shows[fresh.key].addedAt);
      } catch (e) {
        failures.push(e.message);
      }
    }
    if (failures.length) ui.error = `Could not update everything: ${[...new Set(failures)].join(' ')}`;
    else state.lastRefresh = Date.now();
  } finally {
    ui.refreshing = false;
    save();
    checkAlerts();
    render();
  }
}

// ---------------------------------------------------------------- search / add

const searchInput = $('search-input');
const searchSource = $('search-source');
const resultsEl = $('search-results');
let searchSeq = 0;
let searchTimer = null;

function closeResults() {
  resultsEl.hidden = true;
  resultsEl.replaceChildren();
}

function resultRow(show) {
  const tracked = Boolean(state.shows[show.key]);
  const btn = h('button', { class: `btn${tracked ? '' : ' primary'}`, type: 'button', disabled: tracked }, tracked ? 'Added' : 'Add');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const full = show.source === 'anilist' ? (await fetchAnime([show.id]))[0] : await fetchTv(show.id);
      if (!full) throw new Error('Show not found.');
      storeShow(full, Date.now());
      save();
      btn.textContent = 'Added';
      btn.classList.remove('primary');
      ui.error = null;
      render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      btn.title = e.message;
    }
  });
  const sub = [show.year, show.status, show.altTitle].filter(Boolean).join(' · ');
  return h('div', { class: 'row' }, thumb(show), h('div', { class: 'body' }, h('div', { class: 'title' }, show.title), h('div', { class: 'sub' }, sub), badges(show)), btn);
}

async function runSearch() {
  const q = searchInput.value.trim();
  const seq = ++searchSeq;
  if (q.length < 2) return closeResults();
  resultsEl.hidden = false;
  resultsEl.replaceChildren(h('div', { class: 'empty' }, 'Searching…'));
  try {
    const found = await (searchSource.value === 'anime' ? searchAnime(q) : searchTv(q));
    if (seq !== searchSeq) return;
    resultsEl.replaceChildren(...(found.length ? found.map(resultRow) : [h('div', { class: 'empty' }, `No ${searchSource.value === 'anime' ? 'anime' : 'TV shows'} found for “${q}”.`)]));
  } catch (e) {
    if (seq !== searchSeq) return;
    resultsEl.replaceChildren(h('div', { class: 'empty' }, `Search failed: ${e.message}`));
  }
}

function queueSearch(delay = 350) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, delay);
}

searchInput.addEventListener('input', () => queueSearch());
searchInput.addEventListener('focus', () => {
  if (resultsEl.hidden && searchInput.value.trim().length >= 2) queueSearch(0);
});
searchSource.addEventListener('change', () => queueSearch(0));
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  queueSearch(0);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeResults();
});
document.addEventListener('pointerdown', (e) => {
  if (!$('search-form').contains(e.target)) closeResults();
});

// ---------------------------------------------------------------- boot

$('refresh-btn').addEventListener('click', refreshAll);

checkAlerts();
render();
if (Date.now() - state.lastRefresh > REFRESH_EVERY) refreshAll();

// Every minute: fire alerts for anything that just aired, keep countdowns fresh,
// and re-pull schedules once they are stale.
setInterval(() => {
  checkAlerts();
  if (Date.now() - state.lastRefresh > REFRESH_EVERY) refreshAll();
  else if (ui.tab !== 'settings') render();
}, 60 * 1000);
