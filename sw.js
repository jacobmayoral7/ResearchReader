const CACHE_NAME = "read-aloud-v10";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App files (same origin): network first, so an update shows up on the very next
// open instead of one open later. The cached copy is only the offline fallback.
// "no-cache" makes the browser revalidate instead of trusting its own HTTP cache.
// The pdf.js files from the CDN are version-pinned and never change, so those are
// cache-first.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const sameOrigin = new URL(event.request.url).origin === self.location.origin;

  const remember = (res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    }
    return res;
  };

  if (sameOrigin) {
    event.respondWith(
      fetch(event.request, { cache: "no-cache" })
        .then(remember)
        .catch(() => caches.match(event.request).then((hit) => hit || caches.match("./index.html")))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request).then(remember))
    );
  }
});
