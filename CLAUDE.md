# Show Tracker: handover notes

Read this first. It is written for an assistant picking the project up cold.
Keep it current when something here stops being true.

## What this is

A self-hosted, multi-user web app: people add anime, TV series and films, and
get a schedule, a calendar and alerts for new releases. The owner runs it for
themself and a few friends. It is live and in use; treat it as production.

- No dependencies and no build step. Node 22, ES modules. `node server.js` runs it.
- `server.js` holds every HTTP route. `server/*.js` are its parts.
- `app/` is the browser side: plain JavaScript, served as files.
- Tests: `node --test` (one file, `tests/server.test.js`, plus `tests/core.test.js`).
  All must pass before any push. They use fake sources; nothing calls the network.

## Working agreement with the owner

These were stated by the owner and still stand.

- **Merge your own work.** Open a draft PR, wait for the `test` and CodeQL checks,
  then squash-merge without asking. Merging to `main` deploys automatically.
- **Verify every deploy** (see below) and report plainly what was and was not tested.
- **Privacy is the hard rule.** Nobody may see anyone else's list. The admin sees
  names and dates only, never lists. Data is encrypted at rest. Do not weaken this.
- **Secrets never go in chat or in the repo.** The owner adds them as environment
  variables in their hosting panel. This repository is public.
- The owner has spare server capacity and is glad to spend it. The real limits are
  how often the outside sources may be asked.
- The owner watches token use. Prefer a fresh session per piece of work, and keep
  reports short.
- If the owner says the server is being rebooted, do not merge until they say it is
  back. A healthy status reading is not their confirmation.

## Deployment

- Hosted with Coolify on the owner's VPS; the public site is `shows.ratknight.com`.
- A push to `main` triggers a deploy through a GitHub webhook. It takes about a minute.
- To verify: ask the Coolify API (`/api/v1` on the owner's panel host) for the
  application's status (`running:healthy`), its latest deployment's commit, and its
  logs. The application is the only one there; list `/applications` to find it.
  Requests from the working session are authorised by the session's network proxy.
- Never query the panel's `/security/keys` endpoint. It returns private keys.
- Environment variables set on the server: `DATA_KEY`, `PUBLIC_URL`, `TRUST_PROXY=1`,
  `TMDB_API_KEY`, `ANIMESCHEDULE_TOKEN`, `RESEND_API_KEY`, `MAIL_FROM`.
- The log is quiet when things work. Failures are logged; successes mostly are not.
- The panel's API token expired around 2026-11-25 (it was issued for 30 days), so
  panel requests now get 401. Until the owner issues a new one, a deploy can only be
  checked from outside: `https://shows.ratknight.com/healthz` and the served files.
- When the panel's image scan reports "fix available upstream", set `PATCHED_ON` in
  the `Dockerfile` to today's date and ship it. The build reuses its cached
  `apk upgrade` step otherwise, so an ordinary deploy does not pick up the fix.

## How the pieces fit

**Data** (`server/store.js`): one JSON file in the data directory, AES-256-GCM with
a key derived from `DATA_KEY`. Shape: `users` (each with their list, settings,
alerts, passkeys), a shared `catalog` of shows, and caches (`related`, `lists`,
`shelf`, `tvIds`, `availability`, `franchise`, `dubs`). `makeUser` supplies defaults,
so adding a field there is enough for existing accounts. Daily encrypted snapshots.

**Sources** (`server/sources.js`): AniList (anime), TVmaze (TV schedules), TMDB
(films, popularity, where things stream), AnimeSchedule (dub dates).
- AniList allows about 30 requests a minute. Every AniList request goes through
  `createLimiter`: background work stays under the allowance, a request a person is
  waiting for goes first, and a 429 is waited out and retried.
- Answers are stored, not refetched: related shows per anime, season line-ups,
  premieres, trending, similar-title lists. Searches are cached in memory only, on
  purpose, so nothing records what people looked for.
- `warm()` in `server.js` runs every ten minutes and fetches ahead for the Discover
  pages, including full schedules kept on a "shelf" so tracking a listed show needs
  no request.
- A TMDB series (`tmdbtv:` key) is tracked through TVmaze; the match is looked up
  and remembered in `tvIds`.

**Tracker** (`server/tracker.js`): the once-a-minute tick. Refreshes schedules,
works out alerts per person, honours quiet hours and the daily digest, sends
through ntfy, Discord and Web Push.

**Accounts and security** (`server/auth.js`, `server/webauthn.js`):
- scrypt passwords; stateless signed session cookie; passkeys as a second step;
  recovery codes; invite links; e-mail recovery.
- Cookies carry the `__Host-` prefix over HTTPS. Plain HTTP (local runs) uses the
  unprefixed names.
- Signing out records a hash of the cookie in `endedSessions`, so a copy stops working.
- Every `/api/admin/*` route needs an admin who has confirmed it is them this
  session (`/api/admin/unlock`: passkey, or password when they have none).
- Non-GET requests must state a same-site origin. Attempt limits are per address and
  per account. Proxy headers are believed only when `TRUST_PROXY=1`.
- Permissions: `admin`, and `canInvite` (may create invite links, up to five people
  each, and sees only their own). Nobody can remove their own admin rights.
- Invites can be for one person or a group; they count down and expire in 7 days.

**Web Push** (`server/push.js`): VAPID and payload encryption written with
`node:crypto`. Only known push services are contacted. A device belongs to the
account that turned it on last.

**Browser side** (`app/js/app.js`): one file, a small `h()` helper that builds
elements, a `ui` object for view state, `state` for what the server sent, and
`render()` which rebuilds the current view. `app/js/core.js` is shared with the
server (normalisers, time helpers). `app/sw.js` shows notifications and keeps a
copy for offline use.

## Languages

English is the source text. The interface exists in French, German, Norwegian,
Spanish, Portuguese and Italian.

- `app/js/i18n.js` picks the language before the app starts. `app/js/lang/<code>.js`
  maps each English sentence to its translation; a missing one shows in English.
- Text is translated where it reaches the page: `h()` translates string children and
  spoken attributes. So **a plain string passed to `h()` needs nothing special**.
- A sentence with values in it must be a tagged template: ``T`Signed in as ${name}` ``.
  Its key is `Signed in as {0}`. Counts use `tn(n, '{0} show', '{0} shows')`.
- When you add or change user-facing English, add the same sentence to all six
  language files, or it appears in English there. The tests check the files agree
  with each other and keep their `{0}` places, but cannot tell you a sentence is missing
  from all six.
- Text the server writes (alerts, e-mails) is in `server/i18n.js`, by the same idea.
- Admin and first-time setup screens are deliberately left in English.
- The translations were machine-written and have not been reviewed by native speakers.

## What's new notes

`app/js/changes.js`: add an entry at the top for anything a person would notice, and
translate its title and items in the six language files. The owner asked for this
after "major updates".

## Shelved, not removed

The Firefox extension (`extension/`) and its server routes (`/api/ext/*`, access
tokens) still exist. The owner set the idea aside; `EXTENSION = false` in `app.js`
hides its Profile section. Do not delete it, and do not extend it unless asked.

## Never verified in real conditions

Built and tested in simulation only. If the owner reports a problem, start here.

- A real Web Push delivery to a phone.
- A real passkey on the owner's devices, including the admin unlock.
- The browser's real "install app" prompt.
- Discover's "TV & films" tab against live TMDB data.
- The digest, reminders, new-season alerts and weekly backup e-mail arriving.
- Any alert or e-mail delivered in a language other than English.

## Open items

- The owner still needs to rotate the server's SSH key. It was exposed in an earlier
  session's transcript. Remind them if it comes up; it is theirs to do.
- The hosting panel's API token (broad scope) has expired. A new one, if the owner
  wants deploy checks again, should be read-only if the panel allows it.
- Three BusyBox findings in the image scan have no upstream fix and are not reachable.
- Ideas raised and not built: an agent on the server that looks for related shows
  using the owner's local model; Prime Video in the extension; a native Android shell
  for a Play Store listing.

## Habits that have paid off here

- Check a change in a real browser as well as in tests. Playwright with Chromium is
  available in cloud sessions. Several bugs were only visible there.
- When a test fixes an exact list of fields a route returns, a new field means
  updating that list on purpose. That is the test doing its job.
- Read the server log after a deploy that adds background work.
- Say what was not tested. The owner relies on that to know what to try themself.
