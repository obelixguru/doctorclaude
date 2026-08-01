// Service worker: makes the app installable and keeps the SHELL available offline.
//
// THE ONE RULE THAT MATTERS HERE: no glucose data is ever cached.
//
// A service worker's normal job is to serve a stored copy when the network is slow or gone. For
// this app that behaviour is dangerous — a cached reading replayed an hour later looks exactly like
// a live one, and the whole app is built so that a stale number can never pass for the current
// glucose (FRESHNESS_WINDOW_MS on the client, STALE_MIN on the server). So every request to the
// edge functions goes straight to the network and is never stored, never replayed. If the network
// is down the call fails, the UI says so, and nothing is invented.
//
// Only the static shell — HTML, CSS, JS, icons — is cached, so the app opens instantly and still
// starts up on a bad connection to tell the user it cannot reach the sensor.

const CACHE = "drclaude-shell-v2";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/api.js",
  "./js/config.js",
  "./js/graph.js",
  "./js/i18n.js",
  "./js/store.js",
  "./js/util.js",
  "./js/voice.js",
  "./js/screens/login.js",
  "./js/screens/dashboard.js",
  "./js/screens/food.js",
  "./js/screens/insulin.js",
  "./js/screens/history.js",
  "./js/screens/profile.js",
  "./js/screens/notifications.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    // Individually, so one missing file cannot fail the whole install and leave the app uninstallable.
    caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                       // writes never touch the cache

  const url = new URL(req.url);
  // Anything that is not our own origin is data (the edge functions, and Abbott through them):
  // straight to the network, no cache read, no cache write.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/functions/v1/")) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // Serve the cached shell immediately, but refresh it in the background so a deploy is
        // picked up on the next launch rather than being pinned forever.
        e.waitUntil(
          fetch(req).then((res) => {
            if (res && res.ok) return caches.open(CACHE).then((c) => c.put(req, res.clone()));
          }).catch(() => {}),
        );
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
