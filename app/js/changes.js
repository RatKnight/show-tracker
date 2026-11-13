// What's new: shown once to each person after an update, newest first.
//
// Add an entry at the TOP for an update people would notice (a new feature, a
// changed screen). Skip bug fixes and internal work. `id` is the date, plus a
// letter if there are two in a day; ids must sort upwards over time, since
// "has this person seen it" is a comparison of ids. Write for someone using the
// app, not for someone reading the code.
export const CHANGES = [
  {
    id: '2026-11-13',
    title: 'Search everything, more to discover, notifications',
    items: [
      'Search now looks through anime, TV and films at once. Pick one category from the list beside the box if you want to narrow it.',
      'Discover has a new “TV & films” tab: suggestions based on the series and films you track, and what is popular this week.',
      'Tracking a show on Discover no longer jumps the page back to the top.',
      'Notifications on this device: turn them on under Settings → Alerts to get alerts on your phone or computer with nothing else to install.',
      'Add Show Tracker to your home screen from the account menu (“Install the app”). It also opens without a connection now, showing your last saved schedule.',
      'Not sure what something is for? “Take the tour” in the account menu walks through every part of the app.',
    ],
  },
];
