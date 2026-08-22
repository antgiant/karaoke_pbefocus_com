// App-shell service worker (AI_TODO.md item 7): caches this app's own
// static files (HTML/CSS/JS/icons) as they're fetched, so a reload works
// offline even without a network connection -- e.g. Sleep Mode running
// overnight, or a club meeting on unreliable wifi. Lives at the repo root
// (not under assets/js/) so its default scope is "/", covering the whole
// app -- a service worker can't be registered with a scope broader than
// its own script's location without server cooperation this static site
// doesn't have.
//
// Deliberately does NOT intercept the separately-hosted recording audio or
// the library manifest -- those are cross-origin, streamed with
// Range-request seeking for scrubbing, and already handled at a higher
// level by assets/js/offline/audio-cache.js and manifest-cache.js (see
// AGENTS.md's "no bundled content" model) using the Cache Storage API
// directly from page script, not a service worker fetch handler --
// reimplementing partial-content handling here would duplicate that for no
// benefit.
const SHELL_CACHE = "pbe-app-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("pbe-app-shell-") && name !== SHELL_CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only this app's own same-origin static files -- audio/manifest requests
  // are cross-origin and handled elsewhere, see the file-top comment.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event.request));
});

/** Network-first (so an online reload always gets the latest app code), falling back to whatever's cached when the network's unavailable -- caching every successful same-origin response as it goes, so the app shell fills in on its own without needing a hand-maintained precache list. */
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("Offline and this file hasn't been cached yet.");
  }
}
