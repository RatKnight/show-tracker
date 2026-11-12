# Show Tracker Sync (browser extension)

Marks episodes you finish on Crunchyroll as watched in your Show Tracker.

It reads your Crunchyroll **history page** while you have it open, and sends the
show name and episode number of finished episodes to your Show Tracker. It does
not read anything else and does not talk to anyone else.

## Set up

1. In Show Tracker, open **Profile → Browser extension** and create an access
   token. Copy it; it is shown once.
2. Install the extension (see below).
3. Open the extension's **Settings**, enter your Show Tracker address
   (for example `https://shows.example.com`) and the token, and press
   *Save and test*. Allow the permission prompt. It should say "Connected as …".
4. Open <https://www.crunchyroll.com/history> and scroll down as far as you want
   synced. A small note in the corner reports what was marked.

After that, visit the history page now and then to sync.

Two more things happen on those visits:

- Shows in your history that you do **not** track are offered under
  *Discover → For you → From your streaming sites* in Show Tracker, with a
  *Track* button each and *Track all*.
- Opening <https://www.crunchyroll.com/watchlist> sends the names of the shows
  on your watchlist, which are offered in the same place. Nothing is added to
  your list without you pressing *Track*.

## Install in Firefox

**For testing** (lasts until Firefox restarts): open `about:debugging` → *This
Firefox* → *Load Temporary Add-on…* and pick `manifest.json` in this folder.

**Permanently**: zip the *contents* of this folder (so `manifest.json` is at the
top of the zip), submit it at <https://addons.mozilla.org/developers/> choosing
*On your own* distribution, and install the signed `.xpi` you get back.

If the note never appears on the history page, open `about:addons`, select the
extension, and check under *Permissions* that access to crunchyroll.com is on.

## What gets matched

- Only shows on your Show Tracker list, and only the seasons you track.
- Crunchyroll often numbers episodes straight through all seasons ("E42"), while
  the tracker numbers each season from 1. The tracker translates between them
  using each show's season order, which it looks up the first time; the extension
  waits and retries by itself while that happens.
- An episode counts as finished when Crunchyroll shows it as watched, or with 3
  minutes or less remaining.
- The extension's popup lists what could not be matched.

Crunchyroll can change its pages at any time, which may stop this working until
`parse.js` is updated.
