// Offline support.
//
// The room this app is used in has twenty-five phones on one mandir wifi
// point, so it has to survive a network that comes and goes.
//
// Three rules, and the reasoning matters more than the code:
//
// 1. The page itself is fetched from the network first, and only falls back
//    to the cache when that fails. A service worker that serves a cached page
//    first is how people end up stranded on a version from last month with no
//    address bar to escape through.
// 2. Static files are served from the cache first, but only because every one
//    of them carries a ?v= stamp. A new deploy asks for a new URL, so a stale
//    file can never be served for a fresh page.
// 3. The API is never cached. An attendance count from ten minutes ago is
//    worse than admitting there is no connection.

const CACHE = 'bkst-v1';
const SHELL = './';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add(SHELL)).catch(() => {})
  );
  // Take over straight away rather than waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Rule 3: never the API.
  if (url.origin !== self.location.origin) return;

  // Rule 1: the page, network first.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(SHELL, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(SHELL).then((cached) => cached || Response.error()))
    );
    return;
  }

  // Rule 2: everything else, cache first, because it is version stamped.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
    })
  );
});
