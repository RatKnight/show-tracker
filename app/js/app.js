import { DAY, SERVICES, nextEpisode, episodesBetween, myStreams, dayKey, monthGrid, formatCountdown } from './core.js';

// ---------------------------------------------------------------- state

// Everything lives on the server; this is the copy last fetched from it.
let state = { shows: {}, alerts: [], settings: { services: [], ntfyUrl: '', discordWebhook: '' }, lastRefresh: 0, lastError: null, feedToken: '', watched: [], muted: [] };
const ui = {
  tab: 'upcoming',
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDay: dayKey(Date.now()),
  refreshing: false,
  error: null,
  session: null, // { setup, authed } once known
  notice: null,
  discoverTab: 'foryou',
  mineOnly: false,
  discover: null, // { sequels, recs, updatedAt }
  seasons: {}, // which -> { season, year, list }
  loading: {},
};

const shows = () => Object.values(state.shows);

/** Call the server. On success with a state payload, adopt it. */
async function call(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server.');
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401 && ui.session?.authed) {
    ui.session = { setup: true, authed: false };
    render();
  }
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  if (json && json.shows) {
    // The list changed, so suggestions built from it are stale.
    if (Object.keys(json.shows).length !== Object.keys(state.shows).length) {
      ui.discover = null;
      delete ui.loading.discover;
    }
    state = json;
  }
  return json;
}

/** Run a server action from a button/handler, surfacing failures in the banner. */
async function act(method, path, body) {
  try {
    await call(method, path, body);
    ui.error = null;
  } catch (e) {
    ui.error = e.message;
  }
  render();
}

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

function episodeRow({ show, ep }, { showDate = false, unread = false, watch = false } = {}) {
  const seen = watch && state.watched.includes(ep.id);
  const now = Date.now();
  const sub = [ep.label, ep.name && ep.name !== ep.label ? `· ${ep.name}` : null].filter(Boolean).join(' ');
  return h(
    'div',
    { class: `row${unread ? ' unread' : ''}` },
    h('div', { class: 'when' }, showDate ? fmtShortDay.format(ep.airsAt) : timeOf(ep), h('small', {}, showDate ? timeOf(ep) : ep.airsAt > now ? formatCountdown(ep.airsAt - now) : 'aired')),
    thumb(show),
    h('div', { class: 'body' }, h('div', { class: 'title' }, link(show.url, show.title)), h('div', { class: 'sub' }, sub)),
    h(
      'div',
      { class: 'side' },
      badges(show),
      watch &&
        h(
          'button',
          {
            class: `btn${seen ? ' done' : ''}`,
            type: 'button',
            'aria-pressed': String(seen),
            title: seen ? 'Mark as not watched' : 'Mark as watched',
            onclick: () => act('POST', '/api/watched', { ids: [ep.id], watched: !seen }),
          },
          seen ? '✓ Watched' : 'Mark watched',
        ),
    ),
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
  const upcoming = episodesBetween(shows(), now, now + 60 * DAY);
  const recent = episodesBetween(shows(), now - 14 * DAY, now).reverse();
  // "To watch" counts what aired since you started tracking the show.
  const toWatch = recent.filter(({ show, ep }) => ep.airsAt > (show.addedAt || 0) && !state.watched.includes(ep.id));

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
    const section = h(
      'section',
      {},
      h(
        'div',
        { class: 'section-head' },
        h('h2', {}, toWatch.length ? `Aired recently · ${toWatch.length} to watch` : 'Aired recently'),
        toWatch.length > 1 && h('button', { class: 'btn', type: 'button', onclick: () => act('POST', '/api/watched', { ids: toWatch.map((x) => x.ep.id) }) }, 'Mark all watched'),
      ),
      h('div', { class: 'list' }, recent.map((i) => episodeRow(i, { showDate: true, watch: true, unread: toWatch.includes(i) }))),
    );
    // What is waiting to be watched matters more than what is still to come.
    if (toWatch.length) out.unshift(section);
    else out.push(section);
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

// ---- Discover

const SEASON_NAMES = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' };

/** Fetch a Discover dataset once; re-renders when it arrives. */
function load(name, fetcher) {
  if (ui.loading[name]) return;
  ui.loading[name] = 'busy';
  fetcher().then(
    () => (ui.loading[name] = 'done'),
    (e) => (ui.loading[name] = `Could not load this: ${e.message}`),
  ).then(render);
}

function showCard(show, { reason, dismissable } = {}) {
  const tracked = Boolean(state.shows[show.key]);
  const next = nextEpisode(show);
  const when = next ? `${next.label} · ${fmtShortDay.format(next.airsAt)}` : show.note || show.status;
  const meta = [show.format, show.year, show.score && `${show.score}%`].filter(Boolean).join(' · ');
  const add = h('button', { class: `btn${tracked ? '' : ' primary'}`, type: 'button', disabled: tracked }, tracked ? 'Tracking' : 'Track');
  add.addEventListener('click', async () => {
    add.disabled = true;
    add.textContent = 'Adding…';
    try {
      await call('POST', '/api/shows', { source: show.source, id: show.id });
      ui.error = null;
      render();
    } catch (e) {
      add.disabled = false;
      add.textContent = 'Retry';
      add.title = e.message;
    }
  });
  return h(
    'article',
    { class: 'tile' },
    thumb(show),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'title' }, link(show.url, show.title)),
      reason && h('div', { class: 'reason' }, reason),
      h('div', { class: 'sub' }, when),
      h('div', { class: 'sub' }, [meta, (show.genres || []).slice(0, 3).join(', ')].filter(Boolean).join(' · ')),
      badges(show),
      h(
        'div',
        { class: 'actions' },
        add,
        dismissable &&
          h(
            'button',
            {
              class: 'btn quiet',
              type: 'button',
              onclick: async () => {
                try {
                  ui.discover = await call('POST', '/api/discover/dismiss', { key: show.key });
                } catch (e) {
                  ui.error = e.message;
                }
                render();
              },
            },
            'Not interested',
          ),
      ),
    ),
  );
}

function tiles(list, opts) {
  const mine = state.settings.services;
  const shown = ui.mineOnly ? list.filter((s) => myStreams(s, mine).length) : list;
  if (!shown.length) return h('p', { class: 'muted' }, list.length ? 'Nothing here is on your services yet. Untick the filter to see everything.' : 'Nothing to show.');
  return h('div', { class: 'tiles' }, shown.map((s) => showCard(s, typeof opts === 'function' ? opts(s) : opts)));
}

function viewDiscover() {
  const tabs = [
    ['foryou', 'For you'],
    ['current', 'This season'],
    ['next', 'Next season'],
  ];
  const bar = h(
    'div',
    { class: 'subnav' },
    tabs.map(([id, label]) =>
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          'aria-pressed': String(ui.discoverTab === id),
          onclick: () => {
            ui.discoverTab = id;
            render();
          },
        },
        label,
      ),
    ),
    h(
      'label',
      { class: 'filter' },
      h('input', {
        type: 'checkbox',
        checked: ui.mineOnly,
        onchange: (e) => {
          ui.mineOnly = e.target.checked;
          render();
        },
      }),
      'Only on my services',
    ),
  );
  const out = [bar];
  const which = ui.discoverTab;

  if (which === 'foryou') {
    load('discover', async () => (ui.discover = await call('GET', '/api/discover')));
    const d = ui.discover;
    if (!d) return [...out, empty(ui.loading.discover === 'busy' ? 'Finding suggestions…' : 'No suggestions', ui.loading.discover === 'busy' ? '' : ui.loading.discover || '')];
    if (!shows().some((s) => s.source === 'anilist')) {
      return [...out, empty('Track some anime first', 'New seasons and recommendations are worked out from the anime on your list.')];
    }
    const fresh = d.sequels.filter((s) => s.fresh);
    const older = d.sequels.filter((s) => !s.fresh);
    out.push(
      h('section', {}, h('h2', {}, 'New seasons of shows you track'), fresh.length ? tiles(fresh, (s) => ({ reason: `New season of ${s.from}` })) : h('p', { class: 'muted' }, 'No new seasons announced right now. You will get an alert when one is.')),
    );
    if (older.length) out.push(h('section', {}, h('h2', {}, 'Later seasons already out'), tiles(older, (s) => ({ reason: `Follows ${s.from}`, dismissable: true }))));
    out.push(
      h('section', {}, h('h2', {}, 'You might like'), d.recs.length ? tiles(d.recs, (s) => ({ reason: `Because you track ${s.because.join(', ')}`, dismissable: true })) : h('p', { class: 'muted' }, 'No recommendations yet.')),
    );
    return out;
  }

  load(`season-${which}`, async () => (ui.seasons[which] = await call('GET', `/api/season?which=${which}`)));
  const data = ui.seasons[which];
  const status = ui.loading[`season-${which}`];
  if (!data) return [...out, empty(status === 'busy' ? 'Loading the season…' : 'Could not load', status === 'busy' ? '' : status || '')];
  out.push(h('section', {}, h('h2', {}, `${SEASON_NAMES[data.season]} ${data.year} · most popular first`), tiles(data.list)));
  return out;
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
              'aria-pressed': String(state.muted.includes(show.key)),
              title: 'Muted shows still appear in the app but send no notifications',
              onclick: () => act('POST', '/api/shows/mute', { key: show.key, muted: !state.muted.includes(show.key) }),
            },
            state.muted.includes(show.key) ? 'Muted — unmute' : 'Mute',
          ),
          h(
            'button',
            {
              class: 'btn quiet',
              type: 'button',
              'aria-label': `Remove ${show.title}`,
              onclick: () => {
                if (!confirm(`Stop tracking "${show.title}"?`)) return;
                act('DELETE', `/api/shows?key=${encodeURIComponent(show.key)}`);
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
  if (!state.settings.ntfyUrl && !state.settings.discordWebhook) {
    out.push(
      h(
        'section',
        {},
        h(
          'div',
          { class: 'card' },
          h('p', {}, 'No alert channel is set up yet, so new episodes are only listed here. Add an ntfy topic or a Discord webhook to get notified.'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => setTab('settings') }, 'Set up alerts'),
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
      h('div', { class: 'section-head' }, h('h2', {}, 'New episodes'), h('button', { class: 'btn', type: 'button', onclick: () => act('DELETE', '/api/alerts') }, 'Clear all')),
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
  const ntfy = h('input', { type: 'url', id: 'ntfy-url', value: s.ntfyUrl, placeholder: 'https://ntfy.sh/your-secret-topic-name', autocomplete: 'off' });
  const discord = h('input', { type: 'url', id: 'discord-url', value: s.discordWebhook, placeholder: 'https://discord.com/api/webhooks/…', autocomplete: 'off' });
  const notice = h('p', { class: 'muted small', role: 'status' }, ui.notice || '');
  const say = (text) => {
    ui.notice = text;
    notice.textContent = text;
  };
  const saveChannels = async () => {
    await call('PUT', '/api/settings', { ntfyUrl: ntfy.value, discordWebhook: discord.value });
  };
  const feedUrl = `${location.origin}/calendar.ics?token=${state.feedToken}`;

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
                onchange: (e) => act('PUT', '/api/settings', { services: e.target.checked ? [...s.services, id] : s.services.filter((x) => x !== id) }),
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
      h('h2', {}, 'Alerts'),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted' }, 'The server checks schedules around the clock and sends an alert when an episode airs — nothing needs to be open.'),
        h('label', { class: 'field', for: 'ntfy-url' }, 'ntfy topic address', ntfy),
        h('p', { class: 'muted small' }, 'Install the ntfy app, subscribe to a topic, and paste its address here. On ntfy.sh anyone who knows the topic name can read it, so pick a long random one.'),
        h('label', { class: 'field', for: 'discord-url' }, 'Discord webhook URL', discord),
        h('p', { class: 'muted small' }, 'In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.'),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              onclick: () => saveChannels().then(() => say('Saved.'), (e) => say(e.message)),
            },
            'Save',
          ),
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () =>
                saveChannels()
                  .then(() => call('POST', '/api/test-alert'))
                  .then(() => say('Test alert sent — check your phone / Discord.'), (e) => say(e.message)),
            },
            'Save and send a test alert',
          ),
        ),
        notice,
      ),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Alert timing'),
      (() => {
        const hours = (id, value, allowOff) =>
          h(
            'select',
            { id, onchange: () => saveTiming() },
            allowOff && h('option', { value: '', selected: value == null }, 'Off'),
            Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: value === i }, new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2020, 0, 1, i)))),
          );
        const pick = (id, value, options) => h('select', { id, onchange: () => saveTiming() }, options.map(([v, label]) => h('option', { value: v, selected: value === v }, label)));
        const mode = pick('alert-mode', s.alertMode, [['instant', 'As each episode airs'], ['digest', 'Once a day, as a summary']]);
        const digest = hours('digest-hour', s.digestHour);
        const qStart = hours('quiet-start', s.quietStart, true);
        const qEnd = hours('quiet-end', s.quietEnd, true);
        const remind = pick('remind', s.remindMinutes, [[0, 'No reminder'], [10, '10 minutes before'], [30, '30 minutes before'], [60, '1 hour before']]);
        const num = (el) => (el.value === '' ? null : Number(el.value));
        const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        function saveTiming(extra = {}) {
          act('PUT', '/api/settings', { alertMode: mode.value, digestHour: num(digest), quietStart: num(qStart), quietEnd: num(qEnd), remindMinutes: Number(remind.value), ...extra });
        }
        return h(
          'div',
          { class: 'card' },
          h('label', { class: 'field', for: 'alert-mode' }, 'Send alerts', mode),
          s.alertMode === 'digest' && h('label', { class: 'field', for: 'digest-hour' }, 'Daily summary at', digest),
          h('div', { class: 'pair' }, h('label', { class: 'field', for: 'quiet-start' }, 'Quiet hours from', qStart), h('label', { class: 'field', for: 'quiet-end' }, 'until', qEnd)),
          h('p', { class: 'muted small' }, 'During quiet hours nothing is sent; alerts that built up arrive when they end. Set both to use them.'),
          h('label', { class: 'field', for: 'remind' }, 'Heads-up before an episode airs', remind),
          h(
            'p',
            { class: 'muted small' },
            `Times use the time zone ${s.timeZone || 'UTC (not set)'}. `,
            s.timeZone !== deviceZone && h('button', { class: 'btn', type: 'button', onclick: () => saveTiming({ timeZone: deviceZone }) }, `Use this device’s (${deviceZone})`),
          ),
          h('p', { class: 'muted small' }, 'To silence a single show, use Mute on the My shows tab.'),
        );
      })(),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Calendar feed'),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted' }, 'Subscribe to this address from Google Calendar (“From URL”), Outlook or Apple Calendar to see releases alongside everything else. Treat it like a password: anyone with the link can see your list.'),
        h('label', { class: 'field', for: 'feed-url' }, 'Feed address', h('input', { type: 'text', id: 'feed-url', readonly: true, value: feedUrl, onfocus: (e) => e.target.select() })),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                if (confirm('Create a new feed address? The old one stops working, so calendars subscribed to it must be re-added.')) act('POST', '/api/feed/rotate');
              },
            },
            'Replace with a new address',
          ),
        ),
      ),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Security'),
      (() => {
        const cur = h('input', { type: 'password', id: 'pw-current', autocomplete: 'current-password', required: true });
        const next = h('input', { type: 'password', id: 'pw-next', autocomplete: 'new-password', required: true, minlength: 8 });
        const out = h('p', { class: 'muted small', role: 'status' });
        return h(
          'form',
          {
            class: 'card',
            onsubmit: async (e) => {
              e.preventDefault();
              try {
                await call('POST', '/api/password', { current: cur.value, next: next.value });
                cur.value = next.value = '';
                out.textContent = 'Password changed. Other devices have been signed out.';
              } catch (err) {
                out.textContent = err.message;
              }
            },
          },
          h('label', { class: 'field', for: 'pw-current' }, 'Current password', cur),
          h('label', { class: 'field', for: 'pw-next' }, 'New password', next),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn primary', type: 'submit' }, 'Change password'),
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () => call('POST', '/api/sessions/revoke').then(() => (out.textContent = 'Every other device has been signed out.'), (err) => (out.textContent = err.message)),
              },
              'Sign out other devices',
            ),
          ),
          out,
        );
      })(),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'About'),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted' }, 'Anime schedules come from AniList and TV schedules from TVmaze. Anime times are the Japanese broadcast time; the episode usually reaches Crunchyroll or HIDIVE within an hour or so, but some simulcasts are delayed. Streaming-site tags are not region-specific, so double-check availability in your country.'),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              await call('POST', '/api/logout').catch(() => {});
              ui.session = { setup: true, authed: false };
              render();
            },
          },
          'Sign out',
        ),
      ),
    ),
  ];
}

function viewAuth() {
  const first = !ui.session.setup;
  const pw = h('input', { type: 'password', id: 'password', autocomplete: first ? 'new-password' : 'current-password', required: true, minlength: first ? 8 : null });
  const code = h('input', { type: 'text', id: 'setup-code', inputmode: 'numeric', autocomplete: 'off', required: true });
  const msg = h('p', { class: 'error small', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'card auth',
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = '';
        try {
          await call('POST', first ? '/api/setup' : '/api/login', first ? { password: pw.value, code: code.value } : { password: pw.value });
          ui.session = { setup: true, authed: true };
          await call('GET', '/api/state');
          await adoptTimeZone();
          render();
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    },
    h('h3', {}, first ? 'Create a password' : 'Sign in'),
    first && h('p', { class: 'muted' }, 'This is the first visit. Choose the password that will protect your list (at least 8 characters).'),
    first && h('label', { class: 'field', for: 'setup-code' }, 'Setup code', code),
    first && h('p', { class: 'muted small' }, 'The 6-digit code is printed in the server log when the app starts (in Coolify: the app’s Logs tab).'),
    h('label', { class: 'field', for: 'password' }, 'Password', pw),
    h('button', { class: 'btn primary', type: 'submit' }, first ? 'Create password' : 'Sign in'),
    msg,
  );
  setTimeout(() => (first ? code : pw).focus());
  return form;
}

const TABS = [
  ['upcoming', 'Upcoming', viewUpcoming],
  ['calendar', 'Calendar', viewCalendar],
  ['discover', 'Discover', viewDiscover],
  ['shows', 'My shows', viewShows],
  ['alerts', 'Alerts', viewAlerts],
  ['settings', 'Settings', viewSettings],
];

// ---------------------------------------------------------------- render

const $ = (id) => document.getElementById(id);

function render() {
  const authed = Boolean(ui.session?.authed);
  document.body.classList.toggle('signed-out', !authed);
  if (!authed) {
    $('banner').hidden = true;
    $('view').replaceChildren(...(ui.session ? [viewAuth()] : [empty('Loading…', '')]));
    return;
  }
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

  const problem = ui.error || state.lastError;
  $('banner').hidden = !problem;
  $('banner').textContent = problem || '';

  $('refresh-btn').disabled = ui.refreshing || !shows().length;
  $('refresh-btn').textContent = ui.refreshing ? 'Refreshing…' : 'Refresh';
  $('refresh-status').textContent = state.lastRefresh && shows().length ? `Updated ${fmtTime.format(state.lastRefresh)}` : '';

  document.title = unread ? `(${unread}) Show Tracker` : 'Show Tracker';

  const view = TABS.find(([id]) => id === ui.tab)[2]();
  $('view').replaceChildren(...[view].flat());
}

function setTab(id) {
  // Leaving the alerts tab marks what you saw there as read.
  if (ui.tab === 'alerts' && id !== 'alerts' && state.alerts.some((a) => !a.read)) {
    for (const a of state.alerts) a.read = true;
    call('POST', '/api/alerts/read').catch(() => {});
  }
  ui.tab = id;
  ui.notice = null;
  render();
}

// ---------------------------------------------------------------- data refresh

async function refreshAll() {
  if (ui.refreshing) return;
  ui.refreshing = true;
  render();
  try {
    await call('POST', '/api/refresh');
    ui.error = null;
  } catch (e) {
    ui.error = e.message;
  }
  ui.refreshing = false;
  render();
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
      await call('POST', '/api/shows', { source: show.source, id: show.id });
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
    const found = await call('GET', `/api/search?source=${searchSource.value}&q=${encodeURIComponent(q)}`);
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
$('home').addEventListener('click', () => {
  if (!ui.session?.authed) return;
  closeResults();
  setTab('upcoming');
  window.scrollTo(0, 0);
});

/** Quiet hours and the digest need a time zone; take this device's until told otherwise. */
async function adoptTimeZone() {
  if (ui.session?.authed && !state.settings.timeZone) {
    await call('PUT', '/api/settings', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => {});
  }
}

async function boot() {
  render();
  try {
    ui.session = await call('GET', '/api/session');
    if (ui.session.authed) await call('GET', '/api/state');
    await adoptTimeZone();
  } catch (e) {
    ui.session = { setup: true, authed: false };
    ui.error = e.message;
  }
  render();
}
boot();

// Every minute: pick up new alerts and schedule changes from the server and keep
// countdowns fresh. Skipped on Settings so typing is never interrupted.
setInterval(async () => {
  if (!ui.session?.authed || ui.tab === 'settings' || ui.tab === 'discover') return;
  await call('GET', '/api/state').catch(() => {});
  render();
}, 60 * 1000);
