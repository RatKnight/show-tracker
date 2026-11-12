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
- **Alerts** – when an episode of a tracked show airs, the server sends a push
  through [ntfy](https://ntfy.sh) and/or a Discord webhook, and lists it in the
  Alerts tab. Set the channels up under *Settings*.
- **Calendar feed** – a private `.ics` address (under *Settings*) you can subscribe
  to from Google Calendar, Outlook or Apple Calendar.
- **Streaming services** – each show is tagged with where it streams. Your services
  (Crunchyroll, HIDIVE and Prime Video by default) are highlighted, and shows that
  are on none of them are flagged.
- **One password** – the first visit asks you to create it, using a one-time setup
  code printed in the server log. After that the list is only reachable when signed
  in. You can change the password, sign other devices out, and replace the calendar
  feed address under *Settings*.

## Run it

### Docker (Coolify, or any Docker host)

The repo has a `Dockerfile`. The container listens on port **3000** and stores
everything in **`/data`** – mount a persistent volume there or the list is lost on
every redeploy. There are no required environment variables.

```
docker build -t show-tracker .
docker run -d -p 3000:3000 -v show-tracker-data:/data show-tracker
```

Put it behind HTTPS (Coolify's proxy does this). On the first visit you are asked
for the 6-digit setup code from the server log (`No password set yet. Setup code
for the first visit: …`), so nobody else can claim a fresh install.

### Locally

Requires [Node.js](https://nodejs.org) 22 or newer. There is nothing to install.

```
npm start
```

Then open <http://localhost:3000>. `PORT` and `DATA_DIR` (default `./data`) can be
set as environment variables.

## Good to know

- Anime air times are the Japanese broadcast time. Simulcasts usually appear on
  Crunchyroll / HIDIVE shortly after, but some are delayed.
- Streaming tags are not region-specific.
- Movies outside of anime are not covered (TVmaze only lists series).
- On the public ntfy.sh server, anyone who knows a topic name can read it – use a
  long random topic.
- Forgot the password? Stop the app, remove the `"auth"` entry from
  `/data/state.json`, start it again and create a new one. Your list is kept.

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
