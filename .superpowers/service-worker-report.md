# Service worker — full app-shell precache — handoff

Branch: `worktree-agent-a383f8d82bd956fae`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-a383f8d82bd956fae`

## Problem

`sw.js` precached only `["./"]` and served everything else network-first with runtime caching.
`privacy.html`, `terms.html`, `manifest.webmanifest`, and the three icons had shipped since but
were never added to the precache, so a cold install or an offline session couldn't load them.
The app also loads `@supabase/supabase-js` from `cdn.jsdelivr.net` (cross-origin), and talks to
the Supabase API/auth origin — neither was ever excluded from the SW's caching logic.

## What was built — `sw.js`

**Precache** (`PRECACHE_URLS`, cached in `install`): `./`, `index.html`, `manifest.webmanifest`,
`icon-180.png`, `icon-192.png`, `icon-512.png`, `privacy.html`, `terms.html`.

**Resilient install**: each entry is added independently via
`Promise.allSettled(PRECACHE_URLS.map((url) => c.add(url)))` instead of `c.addAll([...])`.
`addAll` is all-or-nothing — one 404 would have aborted the entire install and left the app with
zero offline cache; now a single bad entry is only a single miss.

**Fetch strategy, one comment per decision in the code**:
- Non-`GET` requests: skipped immediately (`e.request.method !== "GET"`) — never intercepted or
  cached (mutations must always hit the network).
- Non-`http(s)` schemes (e.g. `chrome-extension:`): skipped.
- Any cross-origin request (`url.origin !== self.location.origin`): skipped entirely — this
  covers the Supabase API/auth origin (`*.supabase.co`), the jsDelivr `supabase-js` CDN script,
  and the Google Fonts stylesheet/font files in one check. Nothing cross-origin is ever cached by
  this service worker, so stale auth/game-data is not a way this can fail, and opaque
  (non-inspectable) cross-origin responses never get stored. This matches the standing decision
  in `HANDOFF.md` ("the service worker does not cache the CDN file").
- `manifest.webmanifest` + the three icons (`STATIC_ASSETS`): cache-first with a background
  refresh — instant response, cache quietly updated in the background for next time. Safe because
  a version bump gets a brand-new `CACHE` name, so there's no risk of serving a permanently stale
  icon across versions.
- Everything else same-origin (`./`, `index.html`, `privacy.html`, `terms.html`): unchanged
  network-first-with-cache-fallback, exactly as before — this is deliberate so app/legal-copy
  updates land immediately; offline (or on a fetch failure) falls back to the cached response for
  that exact request, or to `./` as a last resort.

**Activation**: unchanged shape — still deletes every cache key that isn't the current `CACHE`,
still `skipWaiting()` + `clients.claim()`. Because `CACHE` is renamed every release (`kupa-vNN`,
stamped by `build.py`), the old precache (including a previous version's full app shell) cannot
survive a version bump — it gets deleted here.

`const CACHE = "kupa-v60";` on line 1 is **untouched** — same exact string build.py's regex
replaces.

## `.vercelignore` check

Checked every precached path against `.vercelignore`'s exclusion list
(`dvir.new.js`, `package.json`, `package-lock.json`, `poker-settle.html`, `kupa-sgura.html`,
`README.md`, `tests/`, `archive/`, `tools/`, `docs/`, `.superpowers/`). **No mismatch**: all eight
precached files/paths exist on disk and none are excluded — they all ship in the Vercel static
deploy. This check is now also automated (see tests, below), so a future precache addition that
isn't deployed will fail CI instead of breaking `install` in production silently.

## Tests — `tests/service-worker.test.cjs` (6, offline static analysis of `sw.js` as text)

1. The `CACHE` constant matches the exact regex `build.py` uses to bump the version (derived
   straight from `build.py`'s source, not copied by hand), and appears exactly once.
2. The precache list includes the full shell: `./`, `index.html`, `manifest.webmanifest`, the
   three icons, `privacy.html`, `terms.html`.
3. Every precached path exists on disk and is not excluded by `.vercelignore` (the check above,
   automated).
4. The fetch handler ignores non-`GET` requests.
5. The fetch handler explicitly excludes the Supabase origin (and, structurally, every
   cross-origin request) from caching.
6. `install` adds precache entries individually (`Promise.allSettled`, not `addAll`), so one
   missing file can't wipe out the whole precache.

`node --test tests/*.test.cjs`: **510 pass, 0 fail** (504 pre-existing + 6 new, across 38 files).
`node --check sw.js`: syntax OK. `git diff --check`: clean.

Live in-browser verification (actual SW install/activate/offline behavior in a real browser) was
not run in this session — a browser-preview server for this same project was already occupied by
another chat session on the port this tool would use, so I could not attach one. The manual plan
below covers it.

## Manual offline test plan

Run from the worktree root once merged/deployed (or locally: `python3 -m http.server 8765`, then
open `http://localhost:8765/index.html` — note `kupa-sgura.html` has no SW registration script;
only the generated `index.html` does):

1. **Cold install**
   - Open DevTools → Application → Service Workers. Load the page once with no SW registered yet.
   - Confirm a new `kupa-vNN` service worker installs and activates (`skipWaiting` means it takes
     over immediately, no "waiting" state).
   - Application → Cache Storage → `kupa-vNN`: confirm all 8 entries are present — `./`,
     `index.html`, `manifest.webmanifest`, `icon-180.png`, `icon-192.png`, `icon-512.png`,
     `privacy.html`, `terms.html`.

2. **Go offline**
   - DevTools → Network → set throttling to "Offline".
   - Reload `/`. The app shell must still load (served from cache; network-first falls back to
     the cached match).
   - Navigate to `/privacy.html` and `/terms.html` directly (e.g. type the URL, or open the links
     from the app's settings screen, which open in a new tab). Both must load fully offline —
     this is the actual bug being fixed; previously neither was cached at all.
   - Confirm the manifest and all three icons still resolve while offline (Application → Manifest
     panel should show no errors; icons render in the tab/installed-app UI).

3. **Supabase/API is never served from cache**
   - Still offline: any in-app action that calls Supabase (sign-in, cloud sync) should fail
     cleanly (existing offline-first handling — `supabase` calls already early-return / the UI
     shows the existing "not available" copy) rather than silently returning stale cached data.
   - Back online: open DevTools → Network, confirm requests to `aztfjlssjbjhxdqsflgn.supabase.co`
     and `cdn.jsdelivr.net` never show `(ServiceWorker)` as the size/source column — they must go
     straight to network, not through the SW cache.

4. **Update / version bump hygiene**
   - Bump `VERSION` in `build.py`, run the real release build (`python3 build.py`) in a normal
     (non-worktree) checkout, reload the page.
   - Application → Service Workers: the new `kupa-vNN+1` worker installs, and on the next load
     (or after `skipWaiting`/`clients.claim` kick in) Cache Storage shows only the new `kupa-vNN+1`
     cache — the old version's cache (and its full precached shell) must be gone.

5. **Resilience check (optional, needs a local edit)**
   - Temporarily rename one precached file on the static server (e.g. `terms.html` → 404) and
     reload with "update on reload" enabled. Confirm `install` still succeeds and the *other*
     seven entries are cached (Cache Storage shows 7/8) instead of the whole install failing —
     this is the `Promise.allSettled` behavior replacing `addAll`. Revert the rename afterward.
