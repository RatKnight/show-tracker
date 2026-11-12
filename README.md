# Show Tracker

Track upcoming episode releases for anime and TV shows: add titles, see what is
coming up, browse a calendar, and get an alert on your phone or in Discord when a
new episode airs.

It is a small self-hosted web app. The server keeps your list, checks schedules
around the clock, and sends the alerts, so nothing has to be open on your PC.

## What it does

- **Add shows** – search anime (via [AniList](https://anilist.co)) or TV shows
  (via [TVmaze](https://www.tvmaze.com)) from the box at the top and press *Add*.
- **Upcoming** – every scheduled episode for the next 60 days, grouped by day, in
  your local time, plus what aired in the last week.
- **Calendar** – a month view; click a day to see its episodes.
- **Discover** – new seasons of anime you track (followed along the whole sequel
  chain, with an alert when one is announced), recommendations based on your list,
  and the most popular shows of this season and next, filterable to your services.
- **Movies** (optional, needs a free [TMDB](https://www.themoviedb.org) key) – search
  and track films; their US cinema and digital release dates appear on the calendar
  with an alert on the day. *Discover → In cinemas* lists anime films with a US
  cinema date, and you are told when a new one is announced.
- **English dubs** (optional, needs a free [AnimeSchedule](https://animeschedule.net)
  token) – dub release dates for tracked anime; each person chooses to follow the
  subtitled release, the dub, or both.
- **Series** – anime seasons are separate entries at the source; seasons of the same
  show are folded into one entry on *My shows* and *Watch next* and grouped in
  search results, and new seasons of anime you track
  are added automatically when announced (switchable in *Settings*).
- **Alerts** – when an episode of a tracked show airs, the server sends a push
  through [ntfy](https://ntfy.sh) and/or a Discord webhook, and lists it in the
  Alerts tab. Set the channels up under *Settings*.
- **Watch next** – for each show, how many aired episodes you have left and which
  is next, with a link to your streaming service, *Watched* and *Caught up*.
- **Watched tracking** – recently aired episodes show a *Mark watched* button, and
  anything you have not watched yet is listed first.
- **Browser extension** (optional) – `extension/` holds a Firefox extension that
  marks episodes you finish on Crunchyroll as watched here. See
  [extension/README.md](extension/README.md).
- **Alert timing** – send alerts as episodes air or as one daily summary, set quiet
  hours, get a heads-up before an episode airs, and mute individual shows.
- **Backups** – a daily copy of the (encrypted) data file on the server
  (`/data/backups`, last 14 days); a weekly e-mail of that file to the admin as an
  off-site copy (when e-mail is set up and data is encrypted); a per-person
  downloadable backup with restore; and an optional weekly personal copy posted to
  your Discord channel.
- **Admin alerts** – the admin is told when schedule updates have been failing for
  three hours, and account owners are e-mailed when an admin resets their password,
  removes their passkeys or deletes their account.
- **Import** – pull in the Watching and Planning lists of a public AniList profile.
- **Installable** – add it to your phone's home screen or install it from the
  browser on desktop.
- **Calendar feed** – a private `.ics` address (under *Settings*) you can subscribe
  to from Google Calendar, Outlook or Apple Calendar.
- **Streaming services** – each show is tagged with where it streams. With a TMDB
  key the tags follow your country (availability supplied by JustWatch); your
  services (Crunchyroll, HIDIVE and Prime Video by default) are highlighted, and
  shows on none of them are flagged. *Discover → New on streaming* lists season
  premieres on streaming services in your country for the next two weeks.
- **Accounts** – each person has their own private list, alerts and settings.
  Nobody can see anyone else's list; an admin sees usernames only. People join
  through one-time invite links, and can share their list read-only by link if they
  choose to.

## Run it

### Docker (Coolify, or any Docker host)

The repo has a `Dockerfile`. The container listens on port **3000** and stores
everything in **`/data`** – mount a persistent volume there or the data is lost on
every redeploy.

```
docker build -t show-tracker .
docker run -d -p 3000:3000 -v show-tracker-data:/data -e DATA_KEY="$(openssl rand -hex 32)" -e TRUST_PROXY=1 show-tracker
```

Environment variables:

| Variable | Purpose |
|---|---|
| `DATA_KEY` | Encrypts the data file at rest (AES-256-GCM). At least 32 characters. **Keep a copy somewhere safe: without it the data cannot be read.** If unset, data is stored unencrypted and the admin sees a warning. |
| `TRUST_PROXY` | Set to `1` when the app runs behind a reverse proxy (Coolify, Traefik, nginx…). Only then are the proxy's headers believed for the visitor's address, the public host name and HTTPS. Without it behind a proxy, sign-in cookies are not marked Secure and every visitor shares one attempt limit. |
| `PUBLIC_URL` | The site's public `https://` address. Passkeys are bound to it, and links in e-mails point to it. |
| `RESEND_API_KEY`, `MAIL_FROM` | Optional e-mail password recovery through [Resend](https://resend.com). Needs `PUBLIC_URL` too. An API key with sending access, and a sender on a verified domain (e.g. `Show Tracker <noreply@example.com>`). |
| `TMDB_API_KEY` | Optional. A TMDB “API Read Access Token”; switches on movie search, US release dates and the cinema list. |
| `ANIMESCHEDULE_TOKEN` | Optional. An AnimeSchedule API token; switches on English dub release dates. |
| `RECOVER_ADMIN` | Set to `yes` for one start to remove the admin's passkeys and print an admin password-reset link in the log. |
| `PORT`, `DATA_DIR` | Default `3000` and `/data`. |

Put it behind HTTPS (Coolify's proxy does this). On the first visit you create the
admin account, using the 6-digit setup code from the server log (`No account exists
yet. Setup code for the first visit: …`), so nobody else can claim a fresh install.

#### How the data is protected

- Passwords are never stored, only salted scrypt hashes.
- With `DATA_KEY` set, the whole data file – usernames, lists, alert addresses –
  and its daily snapshots are encrypted on disk. The key lives in the environment,
  not in the data volume, so a copied volume or backup is unreadable on its own.
- This protects stored data. It does not hide data from someone who controls the
  running server, because the server must read lists to check schedules and send
  alerts.
- **Passkeys** add a second sign-in step. After signing in without one, people are
  prompted to add a passkey; from then on a sign-in needs the password and the
  passkey. Ten one-time recovery codes cover a lost or missing device. A password
  reset (by e-mail or admin link) does not skip the passkey; an admin can remove
  someone's passkeys if they lose both their device and their codes. Passkeys are
  tied to the site's address, so set `PUBLIC_URL`.
- Forgotten passwords are reset with a one-time link: created by an admin
  (*Admin* tab), or, when e-mail is configured, sent to the address a
  person has added and confirmed. Addresses are optional, used for nothing else,
  encrypted with the rest of the data, and not visible to other users or admins.

### Locally

Requires [Node.js](https://nodejs.org) 22 or newer. There is nothing to install.

```
npm start
```

Then open <http://localhost:3000>. Data goes to `./data` unless `DATA_DIR` is set.

## Good to know

- Anime air times are the Japanese broadcast time. Simulcasts usually appear on
  Crunchyroll / HIDIVE shortly after, but some are delayed.
- Streaming tags follow your country only once a show has been looked up, and only
  with a TMDB key; otherwise they are not tied to a country.
- Movie data comes from TMDB and release dates are for the US. This product uses the
  TMDB API but is not endorsed or certified by TMDB.
- On the public ntfy.sh server, anyone who knows a topic name can read it – use a
  long random topic.

## Development

```
npm test
```

- `app/` – the browser app (plain static files, no build step).
  `app/js/core.js` holds the pure logic shared with the server.
- `server.js` – HTTP server, login and API routes.
- `server/` – storage, schedule sources, background tracker, alert delivery and the
  calendar feed.

## License

[MIT](LICENSE)
