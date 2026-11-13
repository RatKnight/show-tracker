// Service worker: shows notifications sent by the server, and keeps a copy of
// the app and of your last schedule so it still opens without a connection.
const SHELL = 'st-shell-v1';
const DATA = 'st-data-v1';
const FILES = ['/', '/styles.css', '/js/app.js', '/js/core.js', '/icon.svg', '/icon-192.png', '/manifest.webmanifest'];
// Signed-in answers worth keeping for offline use. Everything else under /api/ is live only.
const KEPT = ['/api/session', '/api/state'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL && n !== DATA).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** The saved copy, marked so the app can say it is not live. */
async function saved(cacheName, request) {
  const hit = await (await caches.open(cacheName)).match(request, { ignoreSearch: false });
  if (!hit) return null;
  const headers = new Headers(hit.headers);
  headers.set('X-Offline', '1');
  return new Response(hit.body, { status: hit.status, headers });
}

/** Always try the network first; the saved copy is only for when it cannot be reached. */
async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(cacheName);
    if (res.ok) await cache.put(request, res.clone());
    // Signed out (or no longer allowed): nothing of that account stays on the device.
    else if (cacheName === DATA && (res.status === 401 || res.status === 403)) await caches.delete(DATA);
    return res;
  } catch (e) {
    const copy = await saved(cacheName, request);
    if (copy) return copy;
    throw e;
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (KEPT.includes(url.pathname) && !url.search) e.respondWith(networkFirst(e.request, DATA));
    return;
  }
  e.respondWith(networkFirst(e.request, SHELL));
});

// The app asks for this at sign-out.
self.addEventListener('message', (e) => {
  if (e.data === 'forget') e.waitUntil(caches.delete(DATA));
});

self.addEventListener('push', (e) => {
  let m = {};
  try {
    m = e.data.json();
  } catch {
    /* an empty or unreadable push still has to show something */
  }
  e.waitUntil(
    self.registration.showNotification(m.title || 'Show Tracker', {
      body: m.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      timestamp: m.at || Date.now(),
      data: { url: '/' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => {
      const tab = open.find((c) => new URL(c.url).origin === self.location.origin);
      return tab ? tab.focus() : self.clients.openWindow('/');
    }),
  );
});
