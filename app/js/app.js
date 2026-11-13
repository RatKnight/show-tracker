import { DAY, SERVICES, nextEpisode, episodesBetween, myStreams, dayKey, monthGrid, formatCountdown, isWatched, watchState } from './core.js';

// ---------------------------------------------------------------- state

// Everything lives on the server; this is the copy last fetched from it.
let state = { shows: {}, alerts: [], settings: { services: [], ntfyUrl: '', discordWebhook: '' }, lastRefresh: 0, lastError: null, feedToken: '', shareToken: null, watched: [], progress: {}, muted: [], series: {}, me: { username: '', admin: false, email: '', pendingEmail: null, passkeys: [], recoveryCodesLeft: 0, apiTokens: [], pushDevices: [] }, pushKey: '', mail: false, movies: false, dubs: false };
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
  cinema: null, // { list, updatedAt } of anime films in US cinemas
  premieres: null, // { region, list } of streaming season premieres
  loading: {},
  link: null, // { kind: 'invite' | 'reset' | 'share', token, ... } from the page address
  admin: null, // { users, invites, encrypted, mail, movies }
  adminGate: null, // { unlocked, method, options }: whether this session may open the admin pages
  shared: null, // someone else's shared list
  forgot: false, // showing the forgot-password form
  info: null, // one-off good news shown above the page
  mfa: null, // { options } while the second sign-in step is pending
  offerPasskey: false, // showing the "add a passkey" prompt after sign-in
  codes: null, // recovery codes to show once
  newInvite: null, // an invite link just created, shown once
  newToken: null, // an access token just created, shown once
  openSeries: new Set(), // series expanded on the My shows tab
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
    throw new Error(ui.offline ? 'You are offline. This needs a connection.' : 'Cannot reach the server.');
  }
  // The service worker answers from its saved copy when the server cannot be reached.
  ui.offline = res.headers.get('X-Offline') === '1';
  const json = await res.json().catch(() => null);
  if (res.status === 401 && ui.session?.authed) {
    ui.session = { setup: true, authed: false };
    render();
  }
  if (res.status === 403 && json?.locked && ui.adminGate?.unlocked) {
    // The admin confirmation ran out (12 hours): ask again.
    ui.adminGate = null;
    delete ui.loading.adminGate;
  }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.body = json;
    throw err;
  }
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
    // Settings save as soon as they are changed; say so, since there is no Save button.
    if (SAVES.some((prefix) => path.startsWith(prefix))) toast('Saved');
  } catch (e) {
    ui.error = e.message;
  }
  render();
}

/** Requests that store a preference (as opposed to actions like marking an episode watched). */
const SAVES = ['/api/settings', '/api/share', '/api/shows/mute', '/api/admin/site'];

/** A brief note in the bottom-right corner. */
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  // Restart the fade when several changes come in a row.
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove('show');
  }, 2200);
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

// Every country the availability data covers. Names come from the browser, in
// the viewer's own language, so the list needs no translations of its own.
const REGION_CODES =
  'AD AE AG AL AO AR AT AU AZ BA BB BE BF BG BH BM BO BR BS BY BZ CA CD CH CI CL CM CO CR CU CV CY CZ DE DK DO DZ EC EE EG ES FI FJ FR GB GF GH GI GP GQ GR GT GY HK HN HR HU ID IE IL IN IQ IS IT JM JO JP KE KR KW LB LC LI LT LU LV LY MA MC MD ME MG MK ML MT MU MW MX MY MZ NE NG NI NL NO NZ OM PA PE PF PG PH PK PL PS PT PY QA RO RS RU SA SC SE SG SI SK SM SN SV TC TD TH TN TR TT TW TZ UA UG US UY VA VE XK YE ZA ZM ZW'.split(' ');
const REGIONS = (() => {
  let names = null;
  try {
    names = new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    /* very old browser: fall back to the codes */
  }
  const nameOf = (code) => {
    try {
      return names?.of(code) || code;
    } catch {
      return code;
    }
  };
  return REGION_CODES.map((code) => [code, nameOf(code)]).sort((x, y) => x[1].localeCompare(y[1]));
})();

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
  if (show.tickets) out.push(link(show.tickets, 'Showtimes', 'badge tickets'));
  return h('div', { class: 'badges' }, out);
}

function thumb(show) {
  const src = safeUrl(show.image);
  return src ? h('img', { class: 'thumb', src, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb' });
}

/** Has the signed-in user watched this episode (marked singly, or covered by "caught up")? */
const seenEp = (show, ep) => isWatched(show, ep, new Set(state.watched), state.progress[show.key] || 0);

function episodeRow({ show, ep }, { showDate = false, unread = false, watch = false } = {}) {
  const seen = watch && seenEp(show, ep);
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
            onclick: () => act('POST', '/api/watched', { ids: [ep.watchId || ep.id], watched: !seen }),
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
  const toWatch = recent.filter(({ show, ep }) => ep.airsAt > (show.addedAt || 0) && !seenEp(show, ep));

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
        toWatch.length > 1 && h('button', { class: 'btn', type: 'button', onclick: () => act('POST', '/api/watched', { ids: [...new Set(toWatch.map((x) => x.ep.watchId || x.ep.id))] }) }, 'Mark all watched'),
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
    ['premieres', 'New on streaming'],
    ...(state.movies ? [['cinema', 'In cinemas']] : []),
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
    // Shows the browser extension saw on a streaming site that are not on the list.
    const seen = d.seen || [];
    if (seen.length || d.seenPending) {
      const SITES = { crunchyroll: 'Crunchyroll', hidive: 'HIDIVE' };
      const trackAll = async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Adding…';
        try {
          for (const x of seen) await call('POST', '/api/shows', { source: x.source, id: x.id });
          ui.error = null;
        } catch (err) {
          ui.error = err.message;
        }
        render();
      };
      out.push(
        h(
          'section',
          {},
          h(
            'div',
            { class: 'section-head' },
            h('h2', {}, `From your streaming sites${seen.length ? ` · ${seen.length}` : ''}`),
            seen.length > 1 && h('button', { class: 'btn', type: 'button', onclick: trackAll }, `Track all ${seen.length}`),
          ),
          seen.length
            ? tiles(seen, (x) => ({ reason: x.from === 'watchlist' ? `On your ${SITES[x.provider] || 'streaming'} watchlist` : `Watched on ${SITES[x.provider] || 'a streaming site'}`, dismissable: true }))
            : h('p', { class: 'muted' }, 'Looking up the shows your extension reported…'),
          d.seenPending > 0 && seen.length > 0 && h('p', { class: 'muted small' }, `${d.seenPending} more still being looked up. Reload in a minute.`),
        ),
      );
    }
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

  if (which === 'premieres') {
    const region = state.settings.region || 'US';
    // Reload when the country changes.
    if (ui.premieres && ui.premieres.region !== region) {
      ui.premieres = null;
      delete ui.loading.premieres;
    }
    load('premieres', async () => (ui.premieres = await call('GET', '/api/premieres')));
    if (!ui.premieres) return [...out, empty(ui.loading.premieres === 'busy' ? 'Checking the next two weeks…' : 'Could not load', ui.loading.premieres === 'busy' ? '' : ui.loading.premieres || '')];
    const country = (REGIONS.find(([code]) => code === ui.premieres.region) || [])[1] || ui.premieres.region;
    out.push(
      h(
        'section',
        {},
        h('h2', {}, `Season premieres on streaming · next two weeks · ${country}`),
        ui.premieres.list.length ? tiles(ui.premieres.list, (x) => ({ reason: x.premiere })) : h('p', { class: 'muted' }, 'Nothing listed.'),
      ),
    );
    out.push(h('p', { class: 'muted small' }, 'From TVmaze’s streaming schedule: first episodes of new series and new seasons. Tick “Only on my services” above to narrow it down. Change the country in Settings.'));
    return out;
  }

  if (which === 'cinema') {
    load('cinema', async () => (ui.cinema = await call('GET', '/api/cinema')));
    if (!ui.cinema) return [...out, empty(ui.loading.cinema === 'busy' ? 'Checking cinema listings…' : 'Could not load', ui.loading.cinema === 'busy' ? '' : ui.loading.cinema || '')];
    const soon = ui.cinema.list.filter((m) => nextEpisode(m)?.event === 'cinema');
    const showing = ui.cinema.list.filter((m) => !soon.includes(m));
    const whole = ui.mineOnly;
    ui.mineOnly = false; // the services filter makes no sense for cinema releases
    out.push(
      h('section', {}, h('h2', {}, 'Anime films coming to US cinemas'), soon.length ? tiles(soon) : h('p', { class: 'muted' }, 'None announced right now. You will get an alert when one is, unless you switched that off in Settings.')),
    );
    if (showing.length) out.push(h('section', {}, h('h2', {}, 'Opened in the last month'), tiles(showing)));
    ui.mineOnly = whole;
    out.push(h('p', { class: 'muted small' }, 'Dates are US theatrical releases from TMDB. “Showtimes” searches Fandango for the title. Track a film to get an alert on opening day.'));
    return out;
  }

  load(`season-${which}`, async () => (ui.seasons[which] = await call('GET', `/api/season?which=${which}`)));
  const data = ui.seasons[which];
  const status = ui.loading[`season-${which}`];
  if (!data) return [...out, empty(status === 'busy' ? 'Loading the season…' : 'Could not load', status === 'busy' ? '' : status || '')];
  out.push(h('section', {}, h('h2', {}, `${SEASON_NAMES[data.season]} ${data.year} · most popular first`), tiles(data.list)));
  return out;
}

// ---- Watch next

function viewWatchNext() {
  const watched = new Set(state.watched);
  const now = Date.now();
  const each = shows()
    .map((show) => ({ show, st: watchState(show, watched, state.progress[show.key] || 0, now) }))
    .filter((x) => x.st && x.st.behind > 0);
  // Seasons of one series share a row: the earliest season with something left
  // is the one to watch next, and the count covers all of them.
  const grouped = new Map();
  for (const x of each) {
    const id = state.series[x.show.key]?.id || x.show.key;
    grouped.set(id, [...(grouped.get(id) || []), x]);
  }
  const rows = [...grouped.values()].map((parts) => {
    if (parts.length === 1) return parts[0];
    const ordered = [...parts].sort((a, b) => (a.show.year || 9999) - (b.show.year || 9999) || a.show.title.localeCompare(b.show.title));
    const lead = ordered[0];
    const started = parts.some((p) => p.st.started) || shows().some((sh) => state.series[sh.key]?.id === state.series[lead.show.key].id && (state.progress[sh.key] || 0) > 0);
    return { ...lead, st: { ...lead.st, started }, seriesTitle: state.series[lead.show.key].title, seasons: parts.length, totalBehind: parts.reduce((n, p) => n + p.st.behind, 0) };
  });
  if (!shows().length) return empty('Nothing tracked yet', 'Add shows with the search box above.');
  if (!rows.length) return empty('All caught up', 'Nothing you track has an episode waiting. Films are not listed here.');

  const caughtUp = (show, st) => {
    if (show.source === 'anilist') return act('POST', '/api/progress', { key: show.key, through: show.aired });
    // Other sources: mark each recent episode.
    return act('POST', '/api/watched', { ids: show.episodes.filter((e) => e.airsAt <= now).map((e) => e.id) });
  };
  const row = ({ show, st, seriesTitle, seasons, totalBehind }) => {
    const mine = myStreams(show, state.settings.services)[0];
    return h(
      'div',
      { class: 'row' },
      thumb(show),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'title' }, link(show.url, seriesTitle || show.title)),
        h(
          'div',
          { class: 'sub' },
          seriesTitle
            ? `Next: ${show.title} — ${st.next.label} · ${totalBehind} to watch across ${seasons} seasons`
            : `Next: ${st.next.label} · ${st.behind} to watch${show.source === 'anilist' && show.total ? ` of ${show.total}` : ''}`,
        ),
      ),
      h(
        'div',
        { class: 'side' },
        mine && link(mine.url, `Watch on ${mine.name}`, `badge mine ${mine.id}`),
        h('button', { class: 'btn', type: 'button', onclick: () => act('POST', '/api/watched', { ids: [st.next.id] }) }, `Watched ${st.next.label}`),
        st.behind > 1 &&
          h(
            'button',
            {
              class: 'btn quiet',
              type: 'button',
              title: 'Mark every episode that is out as watched',
              onclick: () => {
                if (confirm(`Mark all ${st.behind} episodes of "${show.title}" as watched?`)) caughtUp(show, st);
              },
            },
            'Caught up',
          ),
      ),
    );
  };
  // Fewest left first: the shows closest to being caught up lead.
  const byLeft = (a, b) => a.st.behind - b.st.behind || a.show.title.localeCompare(b.show.title);
  const going = rows.filter((x) => x.st.started).sort(byLeft);
  const fresh = rows.filter((x) => !x.st.started).sort(byLeft);
  const out = [];
  if (going.length) out.push(h('section', {}, h('h2', {}, `Continue watching · ${going.length}`), h('div', { class: 'list' }, going.map(row))));
  if (fresh.length) {
    out.push(
      h(
        'section',
        {},
        h('h2', {}, `Not started · ${fresh.length}`),
        going.length ? h('details', {}, h('summary', {}, 'Show these'), h('div', { class: 'list' }, fresh.map(row))) : h('div', { class: 'list' }, fresh.map(row)),
      ),
    );
  }
  out.push(h('p', { class: 'muted small' }, 'Counts cover episodes that have aired. For TV shows only the last 30 days are known. The browser extension fills in what you watch on Crunchyroll and HIDIVE.'));
  return out;
}

/** One tracked show (or one season inside a series) as a row. */
function showRow(show, now, nested = false) {
  const next = nextEpisode(show, now);
  const nextText = next
    ? `Next: ${next.label} · ${fmtShortDay.format(next.airsAt)}${next.dateOnly ? '' : `, ${fmtTime.format(next.airsAt)}`} (${formatCountdown(next.airsAt - now)})`
    : show.note || 'No upcoming episode announced';
  const muted = state.muted.includes(show.key);
  return h(
    'div',
    { class: `row${nested ? ' nested' : ''}` },
    thumb(show),
    h('div', { class: 'body' }, h('div', { class: 'title' }, link(show.url, show.title)), h('div', { class: 'sub' }, `${show.status} · ${nextText}`)),
    h(
      'div',
      { class: 'side' },
      badges(show, { kind: !nested }),
      h(
        'button',
        {
          class: 'btn quiet',
          type: 'button',
          'aria-pressed': String(muted),
          title: 'Muted shows still appear in the app but send no notifications',
          onclick: () => act('POST', '/api/shows/mute', { key: show.key, muted: !muted }),
        },
        muted ? 'Muted — unmute' : 'Mute',
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
}

/** Several seasons of one show, folded into a single row that opens to list them. */
function seriesRow(title, seasons, now) {
  const id = state.series[seasons[0].key].id;
  const open = ui.openSeries.has(id);
  // The season with the soonest episode speaks for the series.
  const lead = [...seasons].sort((a, b) => (nextEpisode(a, now)?.airsAt ?? Infinity) - (nextEpisode(b, now)?.airsAt ?? Infinity))[0];
  const next = nextEpisode(lead, now);
  const nextText = next
    ? `Next: ${lead.title} — ${next.label} · ${fmtShortDay.format(next.airsAt)}${next.dateOnly ? '' : `, ${fmtTime.format(next.airsAt)}`} (${formatCountdown(next.airsAt - now)})`
    : seasons.map((x) => x.note).find(Boolean) || 'No upcoming episode announced';
  const allMuted = seasons.every((x) => state.muted.includes(x.key));
  const each = async (fn) => {
    try {
      for (const x of seasons) await fn(x);
      ui.error = null;
    } catch (e) {
      ui.error = e.message;
    }
    render();
  };
  const head = h(
    'div',
    { class: 'row series' },
    thumb(lead),
    h('div', { class: 'body' }, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, `${seasons.length} seasons tracked · ${nextText}`)),
    h(
      'div',
      { class: 'side' },
      badges(lead, { kind: true }),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          'aria-expanded': String(open),
          onclick: () => {
            open ? ui.openSeries.delete(id) : ui.openSeries.add(id);
            render();
          },
        },
        open ? 'Hide seasons' : 'Show seasons',
      ),
      h(
        'button',
        {
          class: 'btn quiet',
          type: 'button',
          'aria-pressed': String(allMuted),
          onclick: () => each((x) => call('POST', '/api/shows/mute', { key: x.key, muted: !allMuted })),
        },
        allMuted ? 'Muted — unmute' : 'Mute',
      ),
      h(
        'button',
        {
          class: 'btn quiet',
          type: 'button',
          'aria-label': `Remove ${title}`,
          onclick: () => {
            if (confirm(`Stop tracking all ${seasons.length} seasons of "${title}"?`)) each((x) => call('DELETE', `/api/shows?key=${encodeURIComponent(x.key)}`));
          },
        },
        'Remove',
      ),
    ),
  );
  const byYear = [...seasons].sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.title.localeCompare(b.title));
  return open ? [head, ...byYear.map((x) => showRow(x, now, true))] : head;
}

function viewShows() {
  if (!shows().length) {
    return empty('Your list is empty', 'Search for a title above and press Add.');
  }
  const now = Date.now();
  // Seasons of the same series share one entry; everything else stands alone.
  const entries = new Map();
  for (const show of shows()) {
    const series = state.series[show.key];
    const id = series ? `series:${series.id}` : show.key;
    if (!entries.has(id)) entries.set(id, { title: series?.title || show.title, seasons: [] });
    entries.get(id).seasons.push(show);
  }
  const soonest = (e) => Math.min(...e.seasons.map((x) => nextEpisode(x, now)?.airsAt ?? Infinity));
  const sorted = [...entries.values()].sort((a, b) => soonest(a) - soonest(b) || a.title.localeCompare(b.title));
  return h(
    'div',
    { class: 'list' },
    sorted.map((e) => (e.seasons.length > 1 ? seriesRow(e.title, e.seasons, now) : showRow(e.seasons[0], now))),
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
          'label',
          { class: 'field', for: 'region' },
          'Country (for where shows stream and for premieres)',
          h(
            'select',
            { id: 'region', onchange: (e) => act('PUT', '/api/settings', { region: e.target.value }) },
            REGIONS.map(([code, name]) => h('option', { value: code, selected: (s.region || 'US') === code }, name)),
          ),
        ),
        h('p', { class: 'muted small' }, state.movies ? 'Badges on your tracked shows follow this country once looked up (a few minutes after adding a show).' : 'Country-specific badges need the movie data key on the server; until then badges are not tied to a country.'),
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
      h('h2', {}, 'Seasons and films'),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted' }, 'Anime seasons are separate entries at the source. Seasons of the same show that you track are folded into one entry on My shows.'),
        h(
          'div',
          { class: 'checks' },
          h('label', {}, h('input', { type: 'checkbox', checked: s.autoTrackSeasons, onchange: (e) => act('PUT', '/api/settings', { autoTrackSeasons: e.target.checked }) }), 'Track new seasons of my anime automatically when they are announced'),
        ),
        h('p', { class: 'muted small' }, 'A season you remove yourself is not added back.'),
        state.dubs &&
          h(
            'label',
            { class: 'field', for: 'audio' },
            'For anime, follow',
            h(
              'select',
              { id: 'audio', onchange: (e) => act('PUT', '/api/settings', { audio: e.target.value }) },
              [
                ['sub', 'Subtitled releases (the Japanese broadcast)'],
                ['dub', 'English dub releases'],
                ['both', 'Both subtitled and dubbed'],
              ].map(([value, label]) => h('option', { value, selected: (s.audio || 'sub') === value }, label)),
            ),
          ),
        state.dubs && h('p', { class: 'muted small' }, 'Dub dates come from AnimeSchedule and cover roughly the last week and the next two. A show with no dub listed keeps showing its subtitled episodes.'),
        state.movies &&
          h(
            'div',
            { class: 'checks' },
            h('label', {}, h('input', { type: 'checkbox', checked: s.cinemaAlerts, onchange: (e) => act('PUT', '/api/settings', { cinemaAlerts: e.target.checked }) }), 'Tell me when an anime film gets a US cinema date'),
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
        pushSection(say),
        h('h3', { class: 'sub-head' }, 'Other ways to get alerts'),
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
              onclick: () =>
                saveChannels().then(
                  () => {
                    say('Saved.');
                    toast('Saved');
                  },
                  (e) => say(e.message),
                ),
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
                  .then(() => say('Test alert sent — check your notifications, phone or Discord.'), (e) => say(e.message)),
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
      h('h2', {}, 'Backup and import'),
      (() => {
        const out = h('p', { class: 'muted small', role: 'status' });
        const report = (r, what) => {
          out.textContent = `${what}: ${r.added} added${r.skipped ? `, ${r.skipped} already on your list or unavailable` : ''}.`;
        };
        const file = h('input', {
          type: 'file',
          id: 'restore-file',
          accept: 'application/json,.json',
          onchange: async () => {
            if (!file.files[0]) return;
            out.textContent = 'Restoring…';
            try {
              report(await call('POST', '/api/import', JSON.parse(await file.files[0].text())), 'Restore finished');
            } catch (e) {
              out.textContent = e instanceof SyntaxError ? 'That file is not a Show Tracker backup.' : e.message;
            }
            file.value = '';
          },
        });
        const user = h('input', { type: 'text', id: 'anilist-user', placeholder: 'AniList username', autocomplete: 'off' });
        return h(
          'div',
          { class: 'card' },
          h('p', { class: 'muted' }, 'The server keeps a snapshot of your list for each of the last 14 days. A backup file holds your shows, watched marks and preferences — not your password or alert addresses.'),
          h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/api/export', download: '' }, 'Download a backup')),
          h('label', { class: 'field', for: 'restore-file' }, 'Restore from a backup file (adds to what is here)', file),
          h(
            'div',
            { class: 'checks' },
            h(
              'label',
              {},
              h('input', {
                type: 'checkbox',
                checked: s.backupToDiscord,
                disabled: !s.discordWebhook,
                onchange: (e) => act('PUT', '/api/settings', { backupToDiscord: e.target.checked }),
              }),
              s.discordWebhook ? 'Also post a backup file to my Discord channel every week' : 'Add a Discord webhook above to enable weekly backups to Discord',
            ),
          ),
          h('label', { class: 'field', for: 'anilist-user' }, 'Import the Watching and Planning lists of an AniList profile', user),
          h(
            'div',
            { class: 'actions' },
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: async () => {
                  out.textContent = 'Importing…';
                  try {
                    report(await call('POST', '/api/import/anilist', { username: user.value }), 'Import finished');
                  } catch (e) {
                    out.textContent = e.message;
                  }
                },
              },
              'Import from AniList',
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
        h('p', { class: 'muted' }, 'Anime schedules come from AniList, English dub dates from AnimeSchedule, and TV schedules from TVmaze. Films and country-specific streaming availability come from TMDB, with availability supplied by JustWatch. Anime times are the Japanese broadcast time; the episode usually reaches Crunchyroll or HIDIVE within an hour or so, but some simulcasts are delayed. Where a show has not been looked up yet, its streaming tags are not tied to a country.'),
      ),
    ),
  ];
}


/** Your own account: name, e-mail, sharing, passkeys, password. */
// ---------------------------------------------------------------- notifications on this device

const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** The same short id the server gives a subscription, so this device can be picked out of the list. */
async function pushId(endpoint) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(new URL(endpoint).href));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function currentPush() {
  if (!canPush()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? { sub, id: await pushId(sub.endpoint) } : null;
}

async function turnOnPush() {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed. You can change that in the browser’s settings for this site.');
  const reg = await navigator.serviceWorker.ready;
  // A subscription made for another server identity (after a restore, say) cannot be reused.
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: state.pushKey });
  try {
    await call('POST', '/api/push', { subscription: sub.toJSON(), name: deviceName() });
  } catch (e) {
    await sub.unsubscribe().catch(() => {});
    throw e;
  }
  ui.pushHere = await pushId(sub.endpoint);
}

/** Stop notifications on this device: at the browser and on the server. */
async function turnOffPush() {
  const here = await currentPush().catch(() => null);
  if (!here) return;
  await call('DELETE', `/api/push?id=${here.id}`).catch(() => {});
  await here.sub.unsubscribe().catch(() => {});
  ui.pushHere = null;
}

/** A signed-out device gets no more of this account's alerts and keeps no copy of its list. */
async function signOut() {
  await turnOffPush().catch(() => {});
  await caches?.delete('st-data-v1').catch(() => {});
  await call('POST', '/api/logout').catch(() => {});
  location.reload();
}

function pushSection(say) {
  load('pushHere', async () => (ui.pushHere = (await currentPush())?.id || null));
  const devices = state.me.pushDevices || [];
  // Only counts if the server still knows this device too.
  const here = devices.find((d) => d.id === ui.pushHere);
  const run = (job, done) => async (e) => {
    e.target.disabled = true;
    try {
      await job();
      say(done);
    } catch (err) {
      say(err.message);
    }
    render();
  };
  const blocked = canPush() && Notification.permission === 'denied';
  return h(
    'div',
    {},
    h('h3', { class: 'sub-head' }, 'Notifications on this device'),
    !canPush()
      ? h('p', { class: 'muted small' }, 'This browser cannot show notifications from the site. On an iPhone or iPad, add Show Tracker to the Home Screen first and open it from there.')
      : here
        ? h('p', { class: 'muted small' }, 'On. Alerts appear as notifications on this device, even when Show Tracker is closed.')
        : h('p', { class: 'muted small' }, blocked ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back here.' : 'Get alerts as ordinary notifications on this phone or computer. Nothing else to install.'),
    canPush() &&
      h(
        'div',
        { class: 'actions' },
        here
          ? h('button', { class: 'btn', type: 'button', onclick: run(turnOffPush, 'Notifications are off on this device.') }, 'Turn off on this device')
          : h('button', { class: 'btn primary', type: 'button', disabled: blocked || ui.loading.pushHere === 'busy', onclick: run(turnOnPush, 'Notifications are on for this device.') }, 'Turn on notifications on this device'),
      ),
    devices.length > 0 &&
      h(
        'div',
        { class: 'list' },
        devices.map((d) =>
          h(
            'div',
            { class: 'row' },
            h('div', { class: 'body' }, h('div', { class: 'title' }, d.id === ui.pushHere ? `${d.name} (this device)` : d.name), h('div', { class: 'sub' }, `Turned on ${fmtShortDay.format(d.createdAt)}`)),
            d.id !== ui.pushHere &&
              h(
                'div',
                { class: 'side' },
                h('button', { class: 'btn quiet', type: 'button', onclick: () => confirm(`Stop sending notifications to “${d.name}”?`) && act('DELETE', `/api/push?id=${encodeURIComponent(d.id)}`) }, 'Remove'),
              ),
          ),
        ),
      ),
  );
}

function viewProfile() {
  const s = state.settings;
  return [
    h(
      'section',
      {},
      h('h2', {}, 'Account and sharing'),
      (() => {
        const out = h('p', { class: 'muted small', role: 'status' });
        const name = h('input', { type: 'text', id: 'account-name', value: state.me.username, autocomplete: 'username', minlength: 3, maxlength: 24 });
        const shareUrl = state.shareToken ? `${location.origin}/#share=${state.shareToken}` : '';
        return h(
          'div',
          { class: 'card' },
          h('label', { class: 'field', for: 'account-name' }, 'Username', name),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn', type: 'button', onclick: () => call('PUT', '/api/account', { username: name.value }).then(() => (out.textContent = 'Username saved.'), (e) => (out.textContent = e.message)) }, 'Save username'),
          ),
          out,
          state.mail &&
            (() => {
              const mailOut = h('p', { class: 'muted small', role: 'status' });
              const email = h('input', { type: 'email', id: 'account-email', value: state.me.pendingEmail || state.me.email, autocomplete: 'email', placeholder: 'you@example.com' });
              const save = async (value) => {
                const password = await askPassword(value ? 'Enter your password to change the recovery e-mail.' : 'Enter your password to remove the recovery e-mail.');
                if (password === null) return;
                return call('PUT', '/api/account/email', { email: value, password }).then(
                  () => {
                    ui.notice = null;
                    render();
                  },
                  (e) => (mailOut.textContent = e.message),
                );
              };
              return [
                h('label', { class: 'field', for: 'account-email' }, 'E-mail for password recovery (optional)', email),
                h(
                  'p',
                  { class: 'muted small' },
                  state.me.pendingEmail
                    ? `A confirmation link was sent to ${state.me.pendingEmail}. Open it within 24 hours to finish.${state.me.email ? ` Until then ${state.me.email} stays in use.` : ''}`
                    : state.me.email
                      ? `${state.me.email} is confirmed. Used only to send you a password-reset link; nobody else on this site can see it.`
                      : 'Used only to send you a password-reset link. Nobody else on this site can see it, and without one you can still ask for a reset link.',
                ),
                h(
                  'div',
                  { class: 'actions' },
                  h('button', { class: 'btn', type: 'button', onclick: () => save(email.value) }, state.me.pendingEmail ? 'Send the link again' : 'Save e-mail'),
                  (state.me.email || state.me.pendingEmail) && h('button', { class: 'btn quiet', type: 'button', onclick: () => save('') }, 'Remove e-mail'),
                ),
                mailOut,
              ];
            })(),
          h('p', { class: 'muted' }, 'Your list is private. Nobody else on this site can see it — unless you switch on a share link, which lets anyone holding the link see your shows and their schedule (not your watched marks, alerts or settings).'),
          h(
            'div',
            { class: 'checks' },
            h('label', {}, h('input', { type: 'checkbox', checked: Boolean(state.shareToken), onchange: (e) => act('POST', '/api/share', { enabled: e.target.checked }) }), 'Share my list with a link'),
          ),
          state.shareToken && h('label', { class: 'field', for: 'share-url' }, 'Share link (switch off and on again to replace it)', h('input', { type: 'text', id: 'share-url', readonly: true, value: shareUrl, onfocus: (e) => e.target.select() })),
        );
      })(),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Passkeys and password'),
      (() => {
        const out = h('p', { class: 'muted small', role: 'status' });
        const keys = state.me.passkeys;
        const name = h('input', { type: 'text', id: 'passkey-name', value: deviceName(), maxlength: 40 });
        return h(
          'div',
          { class: 'card' },
          h('p', { class: keys.length ? 'muted' : 'error' }, keys.length ? 'Signing in needs your password and one of these passkeys.' : 'No passkey yet: your account is protected by its password alone.'),
          keys.length > 0 &&
            h(
              'div',
              { class: 'list' },
              keys.map((k) =>
                h(
                  'div',
                  { class: 'row' },
                  h('div', { class: 'body' }, h('div', { class: 'title' }, k.name), h('div', { class: 'sub' }, `Added ${fmtShortDay.format(k.createdAt)}`)),
                  h(
                    'div',
                    { class: 'side' },
                    h(
                      'button',
                      {
                        class: 'btn quiet',
                        type: 'button',
                        onclick: async () => {
                          const last = keys.length === 1;
                          const password = await askPassword(last ? `Enter your password to remove “${k.name}”. It is your only passkey, so your account will be protected by its password alone.` : `Enter your password to remove the passkey “${k.name}”.`);
                          if (password !== null) act('POST', '/api/passkeys/remove', { id: k.id, password });
                        },
                      },
                      'Remove',
                    ),
                  ),
                ),
              ),
            ),
          canPasskey()
            ? [
                h('label', { class: 'field', for: 'passkey-name' }, 'Add a passkey on this device, named', name),
                h(
                  'div',
                  { class: 'actions' },
                  h(
                    'button',
                    {
                      class: 'btn primary',
                      type: 'button',
                      onclick: async () => {
                        out.textContent = '';
                        try {
                          const r = await addPasskey(name.value);
                          ui.codes = r.recoveryCodes;
                          render();
                        } catch (e) {
                          out.textContent = e.body ? e.message : passkeyError(e);
                        }
                      },
                    },
                    'Add a passkey',
                  ),
                ),
              ]
            : h('p', { class: 'muted small' }, 'This browser does not support passkeys.'),
          keys.length > 0 && [
            h('p', { class: 'muted' }, `Recovery codes left: ${state.me.recoveryCodesLeft} of 10. Each one signs you in once without a passkey.`),
            h(
              'div',
              { class: 'actions' },
              h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onclick: async () => {
                    if (!confirm('Make 10 new recovery codes? The old ones stop working.')) return;
                    try {
                      ui.codes = (await call('POST', '/api/recovery-codes')).recoveryCodes;
                      render();
                    } catch (e) {
                      out.textContent = e.message;
                    }
                  },
                },
                'Make new recovery codes',
              ),
            ),
          ],
          out,
        );
      })(),
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
      h('h2', {}, 'Browser extension'),
      (() => {
        const out = h('div', { class: 'linkbox', role: 'status' });
        const name = h('input', { type: 'text', id: 'token-name', maxlength: 40, placeholder: 'e.g. Firefox on my PC', autocomplete: 'off' });
        const tokens = state.me.apiTokens || [];
        if (ui.newToken) {
          setTimeout(() => {
            out.replaceChildren(
              h('label', { class: 'field', for: 'new-token' }, 'New access token', h('input', { type: 'text', id: 'new-token', readonly: true, value: ui.newToken, onfocus: (e) => e.target.select() })),
              h('p', { class: 'muted small' }, `Paste it into the extension’s settings together with this site’s address (${location.origin}). It is shown only this once.`),
            );
            out.querySelector('input').select();
          });
        }
        return h(
          'div',
          { class: 'card' },
          h('p', { class: 'muted' }, 'The Show Tracker Sync extension marks episodes you finish on Crunchyroll as watched here. It signs in with an access token, which can report watched episodes and nothing else.'),
          tokens.length > 0 &&
            h(
              'div',
              { class: 'list' },
              tokens.map((t) =>
                h(
                  'div',
                  { class: 'row' },
                  h('div', { class: 'body' }, h('div', { class: 'title' }, t.name), h('div', { class: 'sub' }, `Created ${fmtShortDay.format(t.createdAt)} · ${t.lastUsedAt ? `last used ${fmtShortDay.format(t.lastUsedAt)}` : 'never used'}`)),
                  h(
                    'div',
                    { class: 'side' },
                    h(
                      'button',
                      {
                        class: 'btn quiet',
                        type: 'button',
                        onclick: () => {
                          if (!confirm(`Remove the access token “${t.name}”? The extension using it will stop syncing.`)) return;
                          ui.newToken = null;
                          act('DELETE', `/api/tokens?id=${encodeURIComponent(t.id)}`);
                        },
                      },
                      'Remove',
                    ),
                  ),
                ),
              ),
            ),
          h('label', { class: 'field', for: 'token-name' }, 'Create an access token, named', name),
          h(
            'div',
            { class: 'actions' },
            h(
              'button',
              {
                class: 'btn primary',
                type: 'button',
                onclick: () =>
                  call('POST', '/api/tokens', { name: name.value }).then(
                    (r) => {
                      ui.newToken = r.token;
                      render();
                    },
                    (e) => out.replaceChildren(h('p', { class: 'error small' }, e.message)),
                  ),
              },
              'Create access token',
            ),
          ),
          out,
        );
      })(),
    ),
    h(
      'section',
      {},
      h('h2', {}, 'Session'),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted' }, `Signed in as ${state.me.username}${state.me.admin ? ' (admin)' : ''}.`),
        h(
          'div',
          { class: 'actions' },
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: signOut,
              },
              'Sign out',
            ),
        ),
      ),
    ),
  ];
}

/** Site administration. Only reachable by admins; the server enforces it too. */
/** Shown in place of the admin pages until the admin has confirmed it is them. */
function viewAdminLocked() {
  const gate = ui.adminGate;
  const msg = h('p', { class: 'error small', role: 'alert' });
  const done = () => {
    ui.adminGate = { unlocked: true };
    ui.admin = null;
    delete ui.loading.admin;
    render();
  };
  const fail = (e) => {
    msg.textContent = e.body || !e.name ? e.message : passkeyError(e);
    // A passkey challenge works once: fetch a fresh one for the next try.
    if (gate.method === 'passkey') call('GET', '/api/admin/unlock').then((g) => (ui.adminGate = g), () => {});
  };
  if (gate.method === 'password') {
    const pw = h('input', { type: 'password', id: 'admin-password', autocomplete: 'current-password', required: true });
    return h(
      'form',
      {
        class: 'card auth',
        onsubmit: (e) => {
          e.preventDefault();
          call('POST', '/api/admin/unlock', { password: pw.value }).then(done, fail);
        },
      },
      h('h3', {}, 'Confirm it’s you'),
      h('p', { class: 'muted' }, 'The admin pages ask for this once each time you sign in. Your account has no passkey yet, so it is your password for now. Add a passkey under Profile and this step will use it instead.'),
      h('label', { class: 'field', for: 'admin-password' }, 'Password', pw),
      h('button', { class: 'btn primary', type: 'submit' }, 'Open admin pages'),
      msg,
    );
  }
  const code = h('input', { type: 'text', id: 'admin-code', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'xxxxx-xxxxx' });
  return h(
    'div',
    { class: 'card auth' },
    h('h3', {}, 'Confirm it’s you'),
    h('p', { class: 'muted' }, 'The admin pages ask for your passkey once each time you sign in, so a signed-in browser on its own cannot manage other people’s accounts.'),
    canPasskey()
      ? h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            id: 'admin-passkey',
            onclick: () =>
              signWithPasskey(ui.adminGate.options)
                .then((response) => call('POST', '/api/admin/unlock', { response }))
                .then(done, fail),
          },
          'Use my passkey',
        )
      : h('p', { class: 'error small' }, 'This browser does not support passkeys. Use a recovery code.'),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: (e) => {
          e.preventDefault();
          call('POST', '/api/admin/unlock', { code: code.value }).then(done, fail);
        },
      },
      h('label', { class: 'field', for: 'admin-code' }, 'No passkey on this device? Enter a recovery code', code),
      h('button', { class: 'btn', type: 'submit' }, 'Use recovery code'),
    ),
    msg,
  );
}

function viewAdmin() {
  // First find out whether this session has been confirmed for admin work.
  load('adminGate', async () => (ui.adminGate = await call('GET', '/api/admin/unlock')));
  if (!ui.adminGate) return empty(ui.loading.adminGate === 'busy' ? 'Loading…' : 'Could not load', ui.loading.adminGate === 'busy' ? '' : ui.loading.adminGate || '');
  if (!ui.adminGate.unlocked) return viewAdminLocked();
  const a = ui.admin;
  const site = a?.site || {};
  const toggle = (key, label) =>
    h(
      'label',
      {},
      h('input', {
        type: 'checkbox',
        checked: site[key] !== false,
        onchange: async (e) => {
          try {
            ui.admin = await call('PUT', '/api/admin/site', { [key]: e.target.checked });
            toast('Saved');
            ui.error = null;
          } catch (err) {
            ui.error = err.message;
          }
          render();
        },
      }),
      label,
    );
  const canMail = a?.mail && state.me.email;
  return [
    a &&
      h(
        'section',
        {},
        h('h2', {}, 'Site'),
        h(
          'div',
          { class: 'card' },
          h('p', { class: a.encrypted ? 'muted' : 'error' }, a.encrypted ? 'Data is encrypted at rest.' : 'Data is NOT encrypted at rest: no DATA_KEY is set on the server.'),
          h('p', { class: 'muted' }, `E-mail is ${a.mail ? 'on' : 'off'} · movies are ${a.movies ? 'on' : 'off'}.`),
          h('div', { class: 'checks' }, toggle('backupEmail', 'E-mail me the encrypted data file every week, as an off-site backup')),
          h(
            'p',
            { class: 'muted small' },
            !a.encrypted
              ? 'Not sent while data is unencrypted.'
              : !canMail
                ? 'Needs e-mail to be on and a confirmed address on your profile.'
                : a.lastBackupEmail
                  ? `Last sent ${fmtShortDay.format(a.lastBackupEmail)}. The file is useless without the DATA_KEY: keep that safe as well.`
                  : 'The first one goes out within a minute or two. The file is useless without the DATA_KEY: keep that safe as well.',
          ),
          h('div', { class: 'checks' }, toggle('healthAlerts', 'Alert me when schedule updates have been failing for 3 hours')),
          h('p', { class: 'muted small' }, 'Sent through your own alert channels, and by e-mail when you have an address on file.'),
        ),
      ),
    h(
      'section',
      {},
      h('h2', {}, 'People'),
      (() => {
        load('admin', async () => (ui.admin = await call('GET', '/api/admin/users')));
        const a = ui.admin;
        if (!a) return h('div', { class: 'card' }, h('p', { class: 'muted' }, ui.loading.admin === 'busy' ? 'Loading…' : ui.loading.admin || ''));
        const out = h('div', { class: 'linkbox', role: 'status' });
        const showLink = (label, url, note) => {
          out.replaceChildren(h('label', { class: 'field', for: 'one-time-link' }, label, h('input', { type: 'text', id: 'one-time-link', readonly: true, value: url, onfocus: (e) => e.target.select() })), h('p', { class: 'muted small' }, note));
          out.querySelector('input').select();
        };
        const fail = (e) => out.replaceChildren(h('p', { class: 'error small' }, e.message));
        const note = h('input', { type: 'text', id: 'invite-note', maxlength: 60, autocomplete: 'off', placeholder: 'e.g. Kira' });
        if (ui.newInvite) setTimeout(() => showLink('New invite link', ui.newInvite, 'Works once, for 7 days. Copy it now: it will not be shown again.'));
        return h(
          'div',
          { class: 'card' },
          h('p', { class: 'muted' }, a.mail ? 'E-mail recovery is on: people can add an address and reset their own password.' : 'E-mail recovery is off (the mail settings are missing on the server). You can still hand out reset links below.'),
          h('p', { class: 'muted' }, 'You can see who has an account, but not what is on their lists. New people join through a one-time invite link.'),
          h(
            'div',
            { class: 'list' },
            a.users.map((p) =>
              h(
                'div',
                { class: 'row' },
                h('div', { class: 'body' }, h('div', { class: 'title' }, p.username, p.admin ? ' (admin)' : ''), h('div', { class: 'sub' }, `Joined ${fmtShortDay.format(p.createdAt)} · ${p.mfa ? 'passkey on' : 'no passkey'}`)),
                h(
                  'div',
                  { class: 'side' },
                  h(
                    'button',
                    {
                      class: 'btn',
                      type: 'button',
                      onclick: () =>
                        call('POST', '/api/admin/reset', { id: p.id }).then((r) => showLink(`Password reset link for ${p.username}`, `${location.origin}/#reset=${r.token}`, 'Works once, for 24 hours. Send it to them privately.'), fail),
                    },
                    'Reset link',
                  ),
                  p.id !== state.me.id &&
                    p.mfa &&
                    h(
                      'button',
                      {
                        class: 'btn',
                        type: 'button',
                        title: 'For someone who lost their passkey and their recovery codes',
                        onclick: async () => {
                          if (!confirm(`Remove ${p.username}’s passkeys and recovery codes? They will sign in with their password alone until they add a new passkey.`)) return;
                          try {
                            ui.admin = await call('POST', '/api/admin/mfa/clear', { id: p.id });
                            render();
                          } catch (e) {
                            fail(e);
                          }
                        },
                      },
                      'Remove passkeys',
                    ),
                                      p.id !== state.me.id &&
                    h(
                      'button',
                      {
                        class: 'btn quiet',
                        type: 'button',
                        onclick: async () => {
                          if (!confirm(`Delete ${p.username}’s account and everything in it? This cannot be undone.`)) return;
                          try {
                            ui.admin = await call('DELETE', `/api/admin/users?id=${encodeURIComponent(p.id)}`);
                            render();
                          } catch (e) {
                            fail(e);
                          }
                        },
                      },
                      'Delete',
                    ),
                ),
              ),
            ),
          ),
          h('label', { class: 'field', for: 'invite-note' }, 'Invite someone (optional note, e.g. who it is for)', note),
          h(
            'div',
            { class: 'actions' },
            h(
              'button',
              {
                class: 'btn primary',
                type: 'button',
                onclick: () =>
                  call('POST', '/api/admin/invites', { note: note.value }).then((r) => {
                    const { token, ...view } = r;
                    ui.admin = view;
                    // Keep the new link on screen through the re-render.
                    ui.newInvite = `${location.origin}/#invite=${token}`;
                    render();
                  }, fail),
              },
              'Create an invite link',
            ),
          ),
          out,
          h('h3', { class: 'sub-head' }, `Unused invite links (${a.invites.length})`),
          a.invites.length
            ? h(
                'div',
                { class: 'list' },
                a.invites.map((inv) =>
                  h(
                    'div',
                    { class: 'row' },
                    h(
                      'div',
                      { class: 'body' },
                      h('div', { class: 'title' }, inv.note || 'Invite'),
                      h('div', { class: 'sub' }, `${inv.createdAt ? `Created ${fmtShortDay.format(inv.createdAt)} · ` : ''}expires ${fmtShortDay.format(inv.expiresAt)}`),
                    ),
                    h(
                      'div',
                      { class: 'side' },
                      h(
                        'button',
                        {
                          class: 'btn quiet',
                          type: 'button',
                          'aria-label': `Remove invite ${inv.note || ''}`,
                          onclick: async () => {
                            if (!confirm('Remove this invite? Its link will stop working.')) return;
                            try {
                              ui.admin = await call('DELETE', `/api/admin/invites?id=${inv.id}`);
                              ui.newInvite = null;
                              render();
                            } catch (e) {
                              fail(e);
                            }
                          },
                        },
                        'Remove',
                      ),
                    ),
                  ),
                ),
              )
            : h('p', { class: 'muted small' }, 'None. Invites disappear from this list once used or after 7 days.'),
          h('p', { class: 'muted small' }, 'For safety a link is shown only once, when it is created. If you lose one, remove it and create another.'),
        );
      })(),
    ),
  ];
}


/**
 * Ask for the account password before a change that weakens the account.
 * Resolves to the password, or null if cancelled.
 */
function askPassword(reason) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', id: 'confirm-password', autocomplete: 'current-password', required: true });
    const dialog = h(
      'dialog',
      { class: 'ask' },
      h(
        'form',
        { method: 'dialog' },
        h('h3', {}, 'Confirm it’s you'),
        h('p', { class: 'muted' }, reason),
        h('label', { class: 'field', for: 'confirm-password' }, 'Password', input),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', value: 'ok' }, 'Confirm'), h('button', { class: 'btn', type: 'button', onclick: () => dialog.close('cancel') }, 'Cancel')),
      ),
    );
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue === 'ok' && input.value ? input.value : null;
      dialog.remove();
      resolve(value);
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

// ---------------------------------------------------------------- passkeys

const canPasskey = () => Boolean(window.PublicKeyCredential && navigator.credentials);
const toBuf = (b64u) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A readable default name for the passkey being added on this device. */
function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'This device';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${browser} on ${os}` : os;
}

/** Turn a browser passkey error into something a person can act on. */
function passkeyError(e) {
  if (e?.name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out.';
  if (e?.name === 'InvalidStateError') return 'This device already has a passkey for this account.';
  if (e?.name === 'SecurityError') return 'Passkeys only work on the site’s real address over HTTPS.';
  return e?.message || 'The passkey could not be used.';
}

/** Create a passkey on this device and register it. Resolves to the server's reply. */
async function addPasskey(name) {
  const o = await call('POST', '/api/passkeys/options');
  const cred = await navigator.credentials.create({
    publicKey: { ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) }, excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: toBuf(c.id) })) },
  });
  const r = cred.response;
  if (!r.getPublicKey || !r.getPublicKey()) throw new Error('This browser cannot hand over the passkey’s public key. Try a current browser.');
  return call('POST', '/api/passkeys', {
    name,
    response: {
      id: cred.id,
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.getAuthenticatorData()),
      publicKey: toB64u(r.getPublicKey()),
      alg: r.getPublicKeyAlgorithm(),
      transports: r.getTransports?.() || [],
    },
  });
}

/** Ask this device for a passkey signature matching the server's challenge. */
async function signWithPasskey(o) {
  const cred = await navigator.credentials.get({
    publicKey: { ...o, challenge: toBuf(o.challenge), allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: toBuf(c.id) })) },
  });
  const r = cred.response;
  return { id: cred.id, clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature) };
}

/** After any successful sign-in: load the account and decide what to show first. */
async function enterApp() {
  ui.mfa = null;
  ui.session = { ...ui.session, setup: true, authed: true };
  await call('GET', '/api/state');
  await adoptTimeZone();
  let skipped = false;
  try {
    skipped = sessionStorage.getItem('passkey-later') === '1';
  } catch {
    /* storage unavailable: just ask */
  }
  ui.offerPasskey = canPasskey() && state.me.passkeys.length === 0 && !skipped;
  render();
}

/** Second sign-in step: passkey, or a recovery code when the passkey is not to hand. */
function viewMfa() {
  const msg = h('p', { class: 'error small', role: 'alert' });
  const code = h('input', { type: 'text', id: 'recovery-code', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'xxxxx-xxxxx' });
  const usePasskey = async () => {
    msg.textContent = '';
    try {
      const response = await signWithPasskey(ui.mfa.options);
      await call('POST', '/api/login/passkey', { response });
      await enterApp();
    } catch (e) {
      if (e.body?.options) ui.mfa.options = e.body.options;
      msg.textContent = e.body ? e.message : passkeyError(e);
    }
  };
  const view = h(
    'div',
    { class: 'card auth' },
    h('h3', {}, 'Confirm it’s you'),
    h('p', { class: 'muted' }, 'Your password was right. This account is also protected by a passkey.'),
    canPasskey() ? h('button', { class: 'btn primary', type: 'button', id: 'use-passkey', onclick: usePasskey }, 'Use my passkey') : h('p', { class: 'error small' }, 'This browser does not support passkeys. Use a recovery code.'),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          msg.textContent = '';
          try {
            const r = await call('POST', '/api/login/recovery', { code: code.value });
            await enterApp();
            ui.info = `Signed in with a recovery code. ${r.recoveryCodesLeft} left — add a passkey on this device under Profile → Passkeys and password.`;
            render();
          } catch (err) {
            msg.textContent = err.message;
          }
        },
      },
      h('label', { class: 'field', for: 'recovery-code' }, 'No passkey on this device? Enter a recovery code', code),
      h('button', { class: 'btn', type: 'submit' }, 'Use recovery code'),
    ),
    h(
      'button',
      {
        class: 'btn quiet',
        type: 'button',
        onclick: () => {
          ui.mfa = null;
          render();
        },
      },
      'Back to sign in',
    ),
    msg,
  );
  return view;
}

/** Shown once after sign-in while the account has no passkey. */
function viewOfferPasskey() {
  const msg = h('p', { class: 'error small', role: 'alert' });
  const later = () => {
    try {
      sessionStorage.setItem('passkey-later', '1');
    } catch {
      /* fine */
    }
    ui.offerPasskey = false;
    render();
  };
  return h(
    'div',
    { class: 'card auth' },
    h('h3', {}, 'Protect your account with a passkey'),
    h('p', { class: 'muted' }, 'A passkey lives on this device and is unlocked with your fingerprint, face or PIN. Once you add one, signing in needs your password and the passkey, so a stolen password is not enough.'),
    h(
      'button',
      {
        class: 'btn primary',
        type: 'button',
        id: 'add-passkey',
        onclick: async () => {
          msg.textContent = '';
          try {
            const r = await addPasskey(deviceName());
            ui.offerPasskey = false;
            ui.codes = r.recoveryCodes;
            render();
          } catch (e) {
            msg.textContent = e.body ? e.message : passkeyError(e);
          }
        },
      },
      'Set up a passkey',
    ),
    h('button', { class: 'btn quiet', type: 'button', onclick: later }, 'Not now'),
    msg,
  );
}

/** Recovery codes are shown exactly once, right after they are made. */
function viewCodes() {
  const text = ui.codes.join('\n');
  return h(
    'div',
    { class: 'card auth' },
    h('h3', {}, 'Save your recovery codes'),
    h('p', { class: 'muted' }, 'Each code signs you in once if you do not have your passkey to hand, for example on a new device. Keep them in your password manager. They will not be shown again.'),
    h('pre', { class: 'codes', id: 'recovery-codes' }, text),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: (e) => navigator.clipboard?.writeText(text).then(() => (e.target.textContent = 'Copied')) }, 'Copy'),
      h('a', { class: 'btn', href: `data:text/plain;charset=utf-8,${encodeURIComponent(`Show Tracker recovery codes for ${state.me.username}\n\n${text}\n`)}`, download: 'show-tracker-recovery-codes.txt' }, 'Download'),
    ),
    h(
      'button',
      {
        class: 'btn primary',
        type: 'button',
        id: 'codes-saved',
        onclick: () => {
          ui.codes = null;
          render();
        },
      },
      'I have saved them',
    ),
  );
}

/** Forget a one-time link once it has been used or turned out to be dead. */
function dropLink() {
  ui.link = null;
  history.replaceState(null, '', location.pathname);
}

function viewForgot() {
  const who = h('input', { type: 'text', id: 'forgot-id', autocomplete: 'username', autocapitalize: 'none', required: true });
  const msg = h('p', { class: 'small', role: 'status' });
  const back = () => {
    ui.forgot = false;
    render();
  };
  const form = h(
    'form',
    {
      class: 'card auth',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await call('POST', '/api/forgot', { identifier: who.value });
          msg.className = 'small';
          msg.textContent = 'If that account has a confirmed e-mail address, a reset link is on its way. It works for 30 minutes.';
        } catch (err) {
          msg.className = 'error small';
          msg.textContent = err.message;
        }
      },
    },
    h('h3', {}, 'Reset your password'),
    h('p', { class: 'muted' }, 'Enter your username or the e-mail address on your account. No address on file? Ask the person who runs this site for a reset link instead.'),
    h('label', { class: 'field', for: 'forgot-id' }, 'Username or e-mail', who),
    h('button', { class: 'btn primary', type: 'submit' }, 'Send reset link'),
    h('button', { class: 'btn quiet', type: 'button', onclick: back }, 'Back to sign in'),
    msg,
  );
  setTimeout(() => who.focus());
  return form;
}

function viewAuth() {
  if (ui.mfa) return viewMfa();
  if (ui.forgot && !ui.link) return viewForgot();
  const link = ui.link;
  // Which of the four forms this is.
  const mode = link?.kind === 'invite' ? 'invite' : link?.kind === 'reset' ? 'reset' : !ui.session.setup ? 'setup' : 'login';
  const creating = mode !== 'login';
  const name = h('input', { type: 'text', id: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, minlength: 3, maxlength: 24 });
  const pw = h('input', { type: 'password', id: 'password', autocomplete: creating ? 'new-password' : 'current-password', required: true, minlength: creating ? 8 : null });
  const code = h('input', { type: 'text', id: 'setup-code', inputmode: 'numeric', autocomplete: 'off', required: true });
  const msg = h('p', { class: 'error small', role: 'alert' });
  const send = {
    setup: () => call('POST', '/api/setup', { username: name.value, password: pw.value, code: code.value }),
    login: () => call('POST', '/api/login', { username: name.value, password: pw.value }),
    invite: () => call('POST', '/api/signup', { token: link.token, username: name.value, password: pw.value }),
    reset: () => call('POST', '/api/reset', { token: link.token, password: pw.value }),
  }[mode];
  const title = { setup: 'Set up Show Tracker', login: 'Sign in', invite: 'Create your account', reset: 'Choose a new password' }[mode];
  const intro = {
    setup: 'This is the first visit. Create the admin account that will look after this site.',
    invite: 'You have been invited. Pick a username and a password of at least 8 characters.',
    reset: `Setting a new password for ${link?.username || 'your account'}. Every device signed in to it will be signed out.`,
  }[mode];
  const form = h(
    'form',
    {
      class: 'card auth',
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = '';
        try {
          const r = await send();
          if (link) dropLink();
          if (r?.mfa) {
            // Password accepted; the passkey step comes next.
            ui.mfa = { options: r.options };
            return render();
          }
          await enterApp();
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    },
    h('h3', {}, title),
    intro && h('p', { class: 'muted' }, intro),
    mode === 'setup' && h('label', { class: 'field', for: 'setup-code' }, 'Setup code', code),
    mode === 'setup' && h('p', { class: 'muted small' }, 'The 6-digit code is printed in the server log when the app starts (in Coolify: the app’s Logs tab).'),
    mode !== 'reset' && h('label', { class: 'field', for: 'username' }, 'Username', name),
    h('label', { class: 'field', for: 'password' }, creating ? 'New password' : 'Password', pw),
    h('button', { class: 'btn primary', type: 'submit' }, { setup: 'Create admin account', login: 'Sign in', invite: 'Create account', reset: 'Save new password' }[mode]),
    mode === 'login' &&
      (ui.session.mail
        ? h(
            'button',
            {
              class: 'btn quiet',
              type: 'button',
              onclick: () => {
                ui.forgot = true;
                render();
              },
            },
            'Forgot your password?',
          )
        : h('p', { class: 'muted small' }, 'Forgot your password? Ask the person who runs this site for a reset link.')),
    msg,
  );
  setTimeout(() => (mode === 'setup' ? code : mode === 'reset' ? pw : name).focus());
  return form;
}

/** Read-only page for a list someone chose to share. */
function viewShared() {
  const { username, list } = ui.shared;
  const now = Date.now();
  const sorted = [...list].sort((a, b) => (nextEpisode(a, now)?.airsAt ?? Infinity) - (nextEpisode(b, now)?.airsAt ?? Infinity) || a.title.localeCompare(b.title));
  return [
    h('section', {}, h('h2', {}, `${username}’s list · ${list.length} show${list.length === 1 ? '' : 's'}`)),
    list.length
      ? h(
          'div',
          { class: 'list' },
          sorted.map((show) => {
            const next = nextEpisode(show, now);
            const when = next ? `Next: ${next.label} · ${fmtShortDay.format(next.airsAt)}${next.dateOnly ? '' : `, ${fmtTime.format(next.airsAt)}`}` : show.note || 'No upcoming episode announced';
            return h('div', { class: 'row' }, thumb(show), h('div', { class: 'body' }, h('div', { class: 'title' }, link(show.url, show.title)), h('div', { class: 'sub' }, `${show.status} · ${when}`)), h('div', { class: 'side' }, badges(show, { kind: true })));
          }),
        )
      : empty('Nothing on this list yet', ''),
    h('p', { class: 'muted small' }, h('a', { href: '/' }, 'Open Show Tracker')),
  ];
}

const TABS = [
  ['upcoming', 'Upcoming', viewUpcoming],
  ['next', 'Watch next', viewWatchNext],
  ['calendar', 'Calendar', viewCalendar],
  ['discover', 'Discover', viewDiscover],
  ['shows', 'My shows', viewShows],
  ['alerts', 'Alerts', viewAlerts],
  ['settings', 'Settings', viewSettings],
  ['admin', 'Admin', viewAdmin],
];
/** Pages reached another way than the tab bar. */
const PAGES = { profile: viewProfile };
const visibleTabs = () => TABS.filter(([id]) => id !== 'admin' || state.me.admin);

// ---------------------------------------------------------------- render

const $ = (id) => document.getElementById(id);

function render() {
  const authed = Boolean(ui.session?.authed);
  document.body.classList.toggle('signed-out', !authed);
  if (ui.shared) {
    document.body.classList.add('signed-out');
    $('banner').hidden = true;
    $('view').replaceChildren(...viewShared());
    return;
  }
  if (authed && !ui.link && (ui.codes || ui.offerPasskey)) {
    document.body.classList.add('signed-out');
    $('banner').hidden = true;
    $('view').replaceChildren(ui.codes ? viewCodes() : viewOfferPasskey());
    return;
  }
  if (!authed || ui.link) {
    document.body.classList.add('signed-out');
    $('banner').hidden = !ui.error && !ui.info;
    $('banner').classList.toggle('good', !ui.error && Boolean(ui.info));
    $('banner').textContent = ui.error || ui.info || '';
    $('view').replaceChildren(...(ui.session ? [viewAuth()] : [empty('Loading…', '')]));
    return;
  }
  const unread = state.alerts.filter((a) => !a.read).length;
  $('tabs').replaceChildren(
    ...visibleTabs().map(([id, label]) =>
      h(
        'button',
        {
          class: 'tab',
          type: 'button',
          'aria-current': ui.tab === id ? 'page' : null,
          'data-tab': id,
          onclick: () => setTab(id),
        },
        label,
        id === 'shows' && shows().length > 0 && h('span', { class: 'muted' }, ` ${new Set(shows().map((x) => state.series[x.key]?.id || x.key)).size}`),
        id === 'alerts' && unread > 0 && h('span', { class: 'count' }, unread),
      ),
    ),
  );

  const problem = ui.error || (ui.offline ? 'You are offline. This is the last saved copy of your schedule; changes need a connection.' : state.lastError);
  $('banner').hidden = !problem && !ui.info;
  $('banner').classList.toggle('good', !problem && Boolean(ui.info));
  $('banner').textContent = problem || ui.info || '';

  $('refresh-btn').disabled = ui.refreshing || !shows().length;
  $('refresh-btn').textContent = ui.refreshing ? 'Refreshing…' : 'Refresh';
  $('refresh-status').textContent = state.lastRefresh && shows().length ? `Updated ${fmtTime.format(state.lastRefresh)}` : '';

  document.title = unread ? `(${unread}) Show Tracker` : 'Show Tracker';

  syncSearchSources();
  const profileBtn = $('profile-btn');
  profileBtn.textContent = (state.me.username[0] || '?').toUpperCase();
  profileBtn.title = `Account: ${state.me.username}`;
  profileBtn.setAttribute('aria-label', `Account menu for ${state.me.username}`);
  profileBtn.setAttribute('aria-current', ui.tab === 'profile' ? 'page' : 'false');
  $('menu-who').textContent = `Signed in as ${state.me.username}`;

  // An admin page left open by someone who is no longer an admin falls back to the start.
  const build = PAGES[ui.tab] || visibleTabs().find(([id]) => id === ui.tab)?.[2] || viewUpcoming;
  $('view').replaceChildren(...[build()].flat());

  // New here: walk through the app once. Re-rendering replaces the tab buttons, so
  // a tour that is already running finds its target again.
  if (tour.at >= 0) placeTour();
  else if (!state.settings.tourDone && !tour.offered) startTour();
  syncInstall();
}

// ---------------------------------------------------------------- install offer
//
// Chrome, Edge and Samsung Internet hand the page an install prompt it can show
// from its own button. Safari and Firefox have no such thing, so there the offer
// says where the browser keeps "Add to Home Screen".

const install = { prompt: null, asked: false };
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
/** Where to find it by hand, for browsers that cannot be asked; '' where that is not known. */
function installHint() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'Tap the Share button, then “Add to Home Screen”.';
  if (/Android/.test(ua) && /Firefox\//.test(ua)) return 'Open the browser menu (⋮), then “Add to Home screen”.';
  return '';
}
const installDismissed = () => {
  try {
    // "Not now" holds for a month.
    return Date.now() - Number(localStorage.getItem('install-later') || 0) < 30 * 24 * 60 * 60 * 1000;
  } catch {
    return install.asked;
  }
};
function dismissInstall() {
  install.asked = true;
  try {
    localStorage.setItem('install-later', String(Date.now()));
  } catch {
    /* storage unavailable: it stays away for this visit */
  }
  syncInstall();
}

/** Show or hide the offer and the menu entry to match what this browser can do right now. */
function syncInstall() {
  const able = !installed() && Boolean(install.prompt || installHint());
  $('menu-install').hidden = !able;
  // Not on top of the sign-in screens or the tour, and not again after "Not now".
  const show = able && Boolean(ui.session?.authed) && !document.body.classList.contains('signed-out') && tour.at < 0 && state.settings.tourDone && !install.asked && !installDismissed();
  $('install').hidden = !show;
  $('install-how').textContent = install.prompt ? 'It opens like an app and can send you notifications.' : installHint();
  $('install-yes').hidden = !install.prompt;
  $('install-no').textContent = install.prompt ? 'Not now' : 'Got it';
}

async function runInstall() {
  if (!install.prompt) {
    // No prompt to show: bring the instructions back up.
    install.asked = false;
    try {
      localStorage.removeItem('install-later');
    } catch {
      /* nothing stored */
    }
    return syncInstall();
  }
  const offer = install.prompt;
  install.prompt = null; // a prompt can be shown once
  offer.prompt();
  const { outcome } = await offer.userChoice.catch(() => ({ outcome: 'dismissed' }));
  if (outcome === 'accepted') install.asked = true;
  else dismissInstall();
  syncInstall();
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // keep the browser's own mini-bar away; ours asks instead
  install.prompt = e;
  syncInstall();
});
window.addEventListener('appinstalled', () => {
  install.prompt = null;
  install.asked = true;
  syncInstall();
});
$('install-yes').addEventListener('click', runInstall);
$('install-no').addEventListener('click', dismissInstall);

// ---------------------------------------------------------------- guided tour

/** Each step: what to point at (a tab id, or an element id), and what to say about it. */
const TOUR = [
  { title: 'Welcome to Show Tracker', text: 'It watches the shows you follow and tells you when new episodes, seasons and films come out. This tour takes about a minute.' },
  { el: 'search-form', title: 'Add a show', text: 'Start here. Pick Anime, TV or Movies, type a title and choose it from the results. Everything else in the app is built from the shows you add.' },
  { tab: 'upcoming', title: 'Upcoming', text: 'Your home page: the next episodes of your shows in date order, with a countdown and where to watch them. Episodes that aired recently and are waiting for you sit at the top.' },
  { tab: 'next', title: 'Watch next', text: 'Where you are in each show. Tick off episodes as you watch them, or mark a whole show as caught up.' },
  { tab: 'calendar', title: 'Calendar', text: 'The same releases as a month view. Pick a day to see what airs on it.' },
  { tab: 'discover', title: 'Discover', text: 'Things to add: new seasons of shows you follow, suggestions based on your list, what is airing this season and next, new arrivals on streaming, and films coming to cinemas.' },
  { tab: 'shows', title: 'My shows', text: 'Everything you follow, with seasons of one series kept together. Mute a show to keep it listed without notifications, or remove it.' },
  { tab: 'alerts', title: 'Alerts', text: 'A note appears here whenever a new episode airs or a new season is announced. The number on the tab counts the ones you have not read.' },
  { tab: 'settings', title: 'Settings', text: 'Tell the app which streaming services you have and which country you are in, choose subtitled or dubbed releases, and send alerts to your phone or Discord. Changes save by themselves.' },
  { tab: 'admin', title: 'Admin', text: 'Only admins see this tab. Invite people, manage their accounts and check the site’s health. It asks you to confirm it is you once each time you sign in.' },
  { el: 'refresh-btn', title: 'Refresh', text: 'Schedules are checked for you around the clock. Use this when you want the latest right now.' },
  { el: 'profile-btn', title: 'Your account', text: 'Your profile has your password, passkeys, e-mail address and the browser extension. Your list is private: nobody else can see it unless you create a share link there. This tour can be replayed from this menu.' },
  { title: 'You are set', text: 'Add your first show with the search box at the top, and the rest fills in by itself.' },
];
const tour = { at: -1, steps: [], offered: false, returnTab: null, focusBack: null };

const tourTarget = (step) => (step.tab ? document.querySelector(`#tabs [data-tab="${step.tab}"]`) : step.el ? $(step.el) : null);

function startTour() {
  tour.offered = true;
  // Steps for things this person cannot see (the Admin tab) are left out.
  tour.steps = TOUR.filter((s) => !s.tab || visibleTabs().some(([id]) => id === s.tab));
  tour.returnTab = ui.tab;
  tour.focusBack = document.activeElement;
  $('tour').hidden = false;
  showTourStep(0);
}

function showTourStep(i) {
  tour.at = i;
  const step = tour.steps[i];
  $('tour-count').textContent = `Step ${i + 1} of ${tour.steps.length}`;
  $('tour-title').textContent = step.title;
  $('tour-text').textContent = step.text;
  $('tour-back').hidden = i === 0;
  $('tour-skip').hidden = i === tour.steps.length - 1;
  $('tour-next').textContent = i === tour.steps.length - 1 ? 'Done' : i === 0 ? 'Start' : 'Next';
  // Show the page being described behind the note. setTab renders, which places the tour.
  // Steps about the header show the home page behind them.
  const page = step.tab || 'upcoming';
  if (ui.tab !== page) setTab(page);
  else placeTour();
  $('tour-next').focus();
}

/** Put the highlight on the current step's target and the note next to it. */
function placeTour() {
  if (tour.at < 0) return;
  const target = tourTarget(tour.steps[tour.at]);
  const spot = $('tour-spot');
  const card = $('tour-card');
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const left = (x) => `${Math.max(12, Math.min(x, vw - card.offsetWidth - 12))}px`;
  if (!target) {
    // No target: dim everything and centre the note.
    Object.assign(spot.style, { top: `${vh / 2}px`, left: `${vw / 2}px`, width: '0px', height: '0px' });
    Object.assign(card.style, { top: `${Math.max(12, (vh - card.offsetHeight) / 2)}px`, left: left((vw - card.offsetWidth) / 2) });
    return;
  }
  target.scrollIntoView({ block: 'nearest', inline: 'center' });
  const r = target.getBoundingClientRect();
  const pad = 5;
  Object.assign(spot.style, { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  const below = r.bottom + pad + 12;
  const top = below + card.offsetHeight <= vh - 12 ? below : Math.max(12, r.top - pad - 12 - card.offsetHeight);
  Object.assign(card.style, { top: `${top}px`, left: left(r.left + r.width / 2 - card.offsetWidth / 2) });
}

function endTour() {
  if (tour.at < 0) return;
  tour.at = -1;
  $('tour').hidden = true;
  // (Rendering again once it is saved lets the install offer follow the tour.)
  if (!state.settings.tourDone) call('PUT', '/api/settings', { tourDone: true }).then(render, () => {});
  setTab(tour.returnTab === 'admin' ? 'upcoming' : tour.returnTab || 'upcoming');
  window.scrollTo(0, 0);
  tour.focusBack?.focus?.();
}

$('tour-next').addEventListener('click', () => (tour.at >= tour.steps.length - 1 ? endTour() : showTourStep(tour.at + 1)));
$('tour-back').addEventListener('click', () => tour.at > 0 && showTourStep(tour.at - 1));
$('tour-skip').addEventListener('click', endTour);
window.addEventListener('resize', placeTour);
window.addEventListener('scroll', placeTour, { passive: true });
document.addEventListener('keydown', (e) => {
  if (tour.at < 0) return;
  if (e.key === 'Escape') endTour();
  else if (e.key === 'ArrowRight' && tour.at < tour.steps.length - 1) showTourStep(tour.at + 1);
  else if (e.key === 'ArrowLeft' && tour.at > 0) showTourStep(tour.at - 1);
  else if (e.key === 'Tab') {
    // Keep the keyboard inside the note while it is open.
    const buttons = [...$('tour-card').querySelectorAll('button:not([hidden])')];
    const at = buttons.indexOf(document.activeElement);
    e.preventDefault();
    buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  }
});

function setTab(id) {
  // Leaving the alerts tab marks what you saw there as read.
  if (ui.tab === 'alerts' && id !== 'alerts' && state.alerts.some((a) => !a.read)) {
    for (const a of state.alerts) a.read = true;
    call('POST', '/api/alerts/read').catch(() => {});
  }
  ui.tab = id;
  ui.newInvite = null;
  ui.newToken = null;
  ui.notice = null;
  ui.info = null;
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
/** Offer movie search only where the server has a movie data key. */
function syncSearchSources() {
  const has = Boolean(searchSource.querySelector('option[value="movie"]'));
  if (state.movies && !has) searchSource.append(h('option', { value: 'movie' }, 'Movies'));
  if (!state.movies && has) searchSource.querySelector('option[value="movie"]').remove();
}
const resultsEl = $('search-results');
let searchSeq = 0;
let searchTimer = null;

function closeResults() {
  resultsEl.hidden = true;
  resultsEl.replaceChildren();
}

/** A title reduced to letters and digits, for spotting seasons of the same series. */
const plainTitle = (t) => String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/×/g, 'x').replace(/[^a-z0-9]+/g, '');

/**
 * Group search results so later seasons sit under the series they belong to:
 * "Show", "Show Season 2", "Show Season 3" become one entry with two seasons beneath.
 */
function foldSeasons(found) {
  const groups = [];
  // Shortest title first, so the base series becomes the head of its group.
  for (const show of [...found].sort((a, b) => plainTitle(a.title).length - plainTitle(b.title).length)) {
    const name = plainTitle(show.title);
    const head = show.source === 'anilist' ? groups.find((g) => g.show.source === 'anilist' && g.name.length >= 6 && name.startsWith(g.name)) : null;
    if (head) head.seasons.push(show);
    else groups.push({ show, name, seasons: [] });
  }
  // Keep the search's own order of the heads.
  return groups.sort((a, b) => found.indexOf(a.show) - found.indexOf(b.show)).map((g) => ({ ...g, seasons: g.seasons.sort((a, b) => (a.year || 9999) - (b.year || 9999)) }));
}

function resultRow(show, nested = false) {
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
  return h('div', { class: `row${nested ? ' nested' : ''}` }, thumb(show), h('div', { class: 'body' }, h('div', { class: 'title' }, show.title), h('div', { class: 'sub' }, sub), badges(show)), btn);
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
    resultsEl.replaceChildren(...(found.length ? foldSeasons(found).flatMap(({ show, seasons }) => [resultRow(show), ...seasons.map((x) => resultRow(x, true))]) : [h('div', { class: 'empty' }, `No ${{ anime: 'anime', tv: 'TV shows', movie: 'movies' }[searchSource.value]} found for “${q}”.`)]));
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
// Account menu behind the profile button.
const profileMenu = $('profile-menu');
function closeMenu() {
  profileMenu.hidden = true;
  $('profile-btn').setAttribute('aria-expanded', 'false');
}
$('profile-btn').addEventListener('click', () => {
  closeResults();
  const open = profileMenu.hidden;
  profileMenu.hidden = !open;
  $('profile-btn').setAttribute('aria-expanded', String(open));
  if (open) profileMenu.querySelector('button').focus();
});
profileMenu.addEventListener('click', async (e) => {
  const go = e.target.closest('button')?.dataset.go;
  if (!go) return;
  closeMenu();
  if (go === 'logout') {
    return signOut();
  }
  if (go === 'tour') return startTour();
  if (go === 'install') return runInstall();
  setTab(go);
  window.scrollTo(0, 0);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !profileMenu.hidden) {
    closeMenu();
    $('profile-btn').focus();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!profileMenu.hidden && !e.target.closest('.menu-wrap')) closeMenu();
});
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
  // Notifications and offline use. Not on plain http (other than localhost), where browsers do not allow it.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const hash = /^#(invite|reset|share|confirm)=([\w-]{8,})$/.exec(location.hash);
  try {
    if (hash?.[1] === 'share') {
      ui.shared = await call('GET', `/api/shared?token=${hash[2]}`);
      ui.session = { setup: true, authed: false };
      return render();
    }
    ui.session = await call('GET', '/api/session');
    if (hash?.[1] === 'confirm') {
      history.replaceState(null, '', location.pathname);
      const done = await call('POST', '/api/email/confirm', { token: hash[2] });
      ui.info = `${done.email} is confirmed. You can now use it to reset your password.`;
      if (ui.session.authed) await call('GET', '/api/state');
    } else if (hash) {
      const info = await call('GET', `/api/link?kind=${hash[1]}&token=${hash[2]}`);
      ui.link = { ...info, token: hash[2] };
    } else if (ui.session.authed) {
      return await enterApp();
    }
  } catch (e) {
    ui.session ||= { setup: true, authed: false };
    ui.error = e.message;
    if (hash) history.replaceState(null, '', location.pathname);
  }
  render();
}
boot();
// A one-time link opened in a tab where the app is already running only changes
// the part after "#", which does not reload the page by itself.
window.addEventListener('hashchange', () => {
  if (/^#(invite|reset|share|confirm)=/.test(location.hash)) location.reload();
});

// Every minute: pick up new alerts and schedule changes from the server and keep
// countdowns fresh. Skipped on Settings so typing is never interrupted.
setInterval(async () => {
  if (!ui.session?.authed || tour.at >= 0 || ['settings', 'discover', 'profile', 'admin'].includes(ui.tab)) return;
  await call('GET', '/api/state').catch(() => {});
  render();
}, 60 * 1000);
