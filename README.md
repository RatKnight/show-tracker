# Show Tracker

Track upcoming episode releases for anime and TV shows: add titles, see what is
coming up, browse a calendar, and get a desktop notification when a new episode airs.

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```
npm start
```

Then open <http://localhost:4173>. (Set `PORT` to use a different port.)

## What it does

- **Add shows** – search anime (via [AniList](https://anilist.co)) or TV shows
  (via [TVmaze](https://www.tvmaze.com)) from the box at the top and press *Add*.
- **Upcoming** – every scheduled episode for the next 60 days, grouped by day, in
  your local time, plus what aired in the last week.
- **Calendar** – a month view; click a day to see its episodes.
- **Alerts** – when an episode of a tracked show airs you get a desktop notification
  (once you allow them) and an entry in the Alerts tab. Episodes that aired while
  the app was closed are picked up the next time you open it.
- **Streaming services** – each show is tagged with where it streams. Your services
  (Crunchyroll, HIDIVE and Prime Video by default; change them under *Settings*) are
  highlighted, and shows that are on none of them are flagged.

Schedules refresh automatically every 30 minutes while the page is open.

## Good to know

- Your list lives in the browser's local storage – it is per browser, and clearing
  site data clears it.
- Notifications only fire while the page is open (a background or pinned tab is fine).
- Anime air times are the Japanese broadcast time. Simulcasts usually appear on
  Crunchyroll / HIDIVE shortly after, but some are delayed.
- Streaming tags are not region-specific.
- Movies outside of anime are not covered (TVmaze only lists series).

## Development

```
npm test
```

- `app/js/core.js` – pure logic (normalising API data, alert detection, calendar grid); unit-tested in `tests/`.
- `app/js/api.js` – AniList and TVmaze requests.
- `app/js/app.js` – UI and state.
- `server.js` – zero-dependency static server for `app/`.

The app is plain static files with no build step, so it can later be wrapped in a
desktop shell (tray icon, start with Windows) without changes to the core.
