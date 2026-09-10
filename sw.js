const CACHE = "kupa-v70";

// The full app shell: everything needed for a cold install / offline first load. Every entry here
// must exist on disk and actually ship in the Vercel deploy (see .vercelignore) — this file is not
// build-generated, so keeping the two in sync is a manual, tested contract (tests/service-worker.test.cjs).
const PRECACHE_URLS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "privacy.html",
  "terms.html",
];

// Manifest + icons are immutable per version (a version bump gets a brand-new CACHE name below), so
// they're safe to serve cache-first; everything else in PRECACHE_URLS is a page and stays network-first.
const STATIC_ASSETS = new Set(["manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]);

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // addAll() is all-or-nothing: one missing/404 entry aborts the whole install and leaves the
      // app with zero offline cache. Add each entry independently so a single miss stays a single miss.
      Promise.allSettled(PRECACHE_URLS.map((url) => c.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      // CACHE gets a new name every version (build.py), so any other cache — including a stale
      // precache from a previous version — is dropped here and can't survive the bump.
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; // never intercept/cache mutations
  const url = new URL(e.request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return; // skip chrome-extension: and other non-http schemes
  // Cross-origin: the Supabase API/auth calls (*.supabase.co), the jsDelivr supabase-js CDN
  // script, and Google Fonts. Never cache any of it here — stale auth or stale game data would be
  // a correctness bug at a live table, and opaque cross-origin responses can't be inspected anyway.
  if (url.origin !== self.location.origin) return;

  const isStaticAsset = STATIC_ASSETS.has(url.pathname.replace(/^\//, ""));
  if (isStaticAsset) {
    // Cache-first with a background refresh: instant response, cache quietly updated for next time.
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const network = fetch(e.request)
          .then((res) => {
            caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Network-first for pages/navigations (so updates land as soon as they're deployed — deliberate),
  // with a cache fallback offline; "./" is the last-resort shell if this exact request was never cached.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./")))
  );
});
