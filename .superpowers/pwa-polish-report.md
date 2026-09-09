# PWA install-experience polish — report

Branch: `worktree-agent-a83e0c2a7a5d05679`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-a83e0c2a7a5d05679`
Base: fast-forwarded onto local `main` @ `df35b02` (privacy/terms pages) before any work started.

`sw.js` was not touched at all. `kupa-sgura.html` picked up four small, purely-additive hunks
(77 insertions, 0 deletions), each dropped next to an existing low-churn anchor rather than near
the groups/friends/games code other agents are editing. `index.html` was not regenerated and
`python3 build.py` was never run, per the brief.

## 1. Maskable icon — regenerated, not just re-declared

Inspected `icon-512.png` with PIL first. It is a full-bleed rounded-square icon (poker table,
chip stacks at the four corners, cushions poking out top/bottom/left/right); measuring the
furthest non-background pixel from centre put the artwork at **108% of the canvas half-width** —
past the edge of a circle, let alone the maskable safe zone. The safe zone is a centred circle of
radius 40% of the canvas (204.8px at 512px), and the existing icon's chips/cushions/frame corners
all fall well outside it. A circular Android mask would crop all four chip stacks and most of the
cushions. So this needed a real regenerated maskable file, not just a manifest edit — the safe
icon test would have failed either way, but I confirmed it visually with a safe-zone overlay and a
simulated circular mask before deciding.

`icon-maskable-512.png` (new, 512×512 RGB PNG, 148KB): the *entire* existing `icon-512.png`
artwork, unmodified, scaled to 352×352 (factor ≈0.687) and centred on a 512×512 canvas filled with
`#05070A` (the manifest's `background_color` / the app's `--bg`). No new branding, nothing redrawn
— same script, same table, same cards. Re-measured after generation: furthest meaningful pixel is
now at 93.2% of the safe-zone radius, i.e. inside it with a ~7% margin. `icon-512.png` and
`icon-192.png` are untouched and still used for the `any` purpose.

`manifest.webmanifest` now declares the two purposes on separate entries instead of one file
claiming both:

```json
"icons": [
  { "src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
  { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
  { "src": "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```

Neither `icon-maskable-512.png` nor `manifest.webmanifest` is excluded by `.vercelignore` — this
lands live on the very next deploy, independent of any `build.py` run (the manifest and icon files
are served as-is; `index.html` only links to `manifest.webmanifest`, it doesn't inline it).

## 2. iOS install guidance

`apple-touch-icon` was **already wired** — `build.py`'s `HEAD` template has had
`<link rel="apple-touch-icon" sizes="180x180" href="./icon-180.png">` plus the full
`apple-mobile-web-app-*` / `mobile-web-app-capable` meta set all along. No change needed there.

New: a quiet, dismissible install hint, added as one self-contained block —

- **Markup**: `<aside id="iosInstallHint" class="ios-install-hint load-in" hidden>` sits as a
  top-level sibling right after `#rotateNotice` (same DOM level as `.corner`, `#settings`, `.wrap`
  — outside anything `render()` touches, so it survives every re-render untouched). Copy is two
  short lines: "אפשר להתקין את האפליקציה למסך הבית" then "לוחצים שיתוף, ואז הוסף למסך הבית", plus a
  44×44px close button with a line-icon X.
- **Styling**: reuses the existing floating-capsule language — same `--bar-bg` blur, `--line`
  hairline border, and box-shadow values as `.tabbar` — pinned above the tab bar
  (`bottom: calc(78px + safe-area)`) so it never fights the header/corner controls. Both themes via
  existing CSS custom properties only; RTL via `padding-inline`/`inset-inline` logical properties
  throughout (no hardcoded left/right).
- **Motion**: entrance reuses the existing `.load-in { animation: rise .5s ease both; }` (DESIGN.md's
  "row entrance" pattern — opacity + `translateY(6px)`) instead of inventing a new keyframe.
  Dismissal adds a `.closing` class driving a plain `opacity`/`transform` transition (.25s), then a
  `setTimeout` re-hides the element, mirroring the existing `menuClosing` pattern. Both are covered
  automatically by the file's one blanket rule `@media (prefers-reduced-motion: reduce) { * {
  animation: none !important; transition: none !important; } }` — no extra reduced-motion code
  needed.
- **Detection**: `isIosSafari()` (iPhone/iPad/iPod UA, plus the iPadOS-13+-reports-as-Mac heuristic
  via `maxTouchPoints`, excluding CriOS/FxiOS/EdgiOS/OPiOS/other in-app browsers) and
  `isStandaloneDisplay()` (`navigator.standalone === true` OR
  `matchMedia("(display-mode: standalone)").matches` — the same standalone check the file already
  used for the portrait-lock call). `initIosInstallHint()` combines both plus the dismissed flag and
  is called once from the boot section, right after the first `render()`.
- **Persistence — no new localStorage key**: `state.iosInstallHintDismissed` is a new field on the
  existing document, added to `normalize()` (`!!s.iosInstallHintDismissed`, defaults false for every
  existing/legacy snapshot) and set via the ordinary `save()` call the dismiss handler makes — the
  exact same `KEY = "poker-settle-v1"` localStorage entry everything else already uses. I did *not*
  thread the field through `remoteBody()`/`applyRemote()` (the shared-game-document sync path):
  it's a device-local UI preference, not game data, and touching that comparison-object literal is
  one of the highest-traffic, easiest-to-conflict regions in the file. Trade-off: if a remote sync
  update ever replaces the whole `state` object on a device where the hint was dismissed, the flag
  could reset to false and the hint could reappear once — dismissible again with one tap, no data
  loss. Worth revisiting if that turns out to matter in practice.

## 3. Splash / launch polish

**Chosen: manifest `background_color`/`theme_color` + meta tags, no generated
`apple-touch-startup-image` files.** Reasoning: `background_color`/`theme_color` were already
`#05070A` (coherent with `--bg`, no change needed) — Android already paints its manifest-driven
install/launch splash correctly. `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`
and `apple-mobile-web-app-title` were also already in `build.py`'s `HEAD`. iOS's static
`apple-touch-startup-image` mechanism needs a matrix of pixel-exact PNGs per device/orientation
that goes stale every time Apple ships a new screen size — high effort, fragile, and explicitly
discouraged by the brief unless it can be done cleanly.

What I added: one line in `build.py`'s `HEAD` template, `<meta name="color-scheme" content="dark">`,
right after the viewport meta. This is the standard fix for the actual symptom described ("blank
white flash"): before either the external Google Fonts stylesheet or the page's own inline
`<style>` (which sets `body { background: var(--bg) }`) has finished loading/parsing, the browser
has nothing to paint the canvas with — `color-scheme` is read straight from HTML during parsing, so
it lets the browser paint its own dark canvas immediately instead of defaulting to white. I used
`content="dark"` (not `"dark light"`) deliberately: this app does not follow system light/dark
preference at all — it has its own in-app toggle stored separately — so `dark` matches the app's
actual always-dark default, `"dark light"` would let a light-OS-theme device paint a light canvas
first and reproduce the exact flash we're fixing.

Note: this `build.py` edit only reaches `index.html` the next time someone runs `python3 build.py`
(not done here, per the brief) — same as the iOS-hint markup inside `kupa-sgura.html`. The
icon/manifest changes above are the only piece that's live immediately on push.

## 4. Manifest field audit (point 4)

Checked every field against what actually ships: `lang: "he"` / `dir: "rtl"` match
`<html lang="he" dir="rtl">` in `build.py`; `start_url: "./"` and `scope: "./"` are correct for a
root-level static Vercel deploy (no `vercel.json`, no subpath); `display: "standalone"` matches the
`apple-mobile-web-app-capable`/`mobile-web-app-capable` tags; `orientation: "portrait"` matches
`#rotateNotice` and the `screen.orientation.lock("portrait")` boot call, both already in the
source. Nothing needed changing beyond the icons array. `manifest.webmanifest`,
`icon-192.png`, `icon-512.png`, `icon-180.png` and the new `icon-maskable-512.png` are all absent
from `.vercelignore`.

## Tests

New: `tests/pwa-manifest.test.cjs`, 7 tests, offline (JSON parsing + regex over source + a
hand-rolled PNG IHDR reader, no image library, no network):

1. manifest declares `any`/`maskable` as separate icon entries (and rejects any entry combining both)
2. every manifest icon path exists on disk and is a real PNG matching its declared `sizes`
3. `build.py`'s generated head links the manifest + `apple-touch-icon`, plus the `color-scheme` fix
4. manifest fields (`lang`/`dir`/`start_url`/`scope`/`display`/`orientation`) match the shipped app
5. the iOS hint's `initIosInstallHint()` is gated on both the standalone check and the iOS Safari check
6. the four PWA asset files are not excluded by `.vercelignore`
7. `localStorage.setItem` key set is exactly `{CONTACT_KEY, KEY, ME_KEY, PROFILE_DEBT_SEEN_KEY, THEME_KEY}` — unchanged — and `iosInstallHintDismissed` exists in source (i.e. it rides inside the state document instead)

Full suite: `node --test tests/*.test.cjs` → **511 tests, 511 pass, 0 fail** (504 pre-existing + 7
new). Also ran and confirmed clean: `git diff --check` (no whitespace issues, staged files
included), the last inline `<script>` body parses via `new Function(...)`, and `build.py` parses
as valid Python (`ast.parse`).

## Manual verification plan

Prerequisite for the iOS-hint and splash pieces: someone runs `python3 build.py` (regenerates
`index.html` from the updated `kupa-sgura.html`/picks up the `color-scheme` meta) and pushes. The
icon/manifest fix needs no build step — it's live on the next deploy as-is.

### iPhone (iOS Safari)

1. Open the deployed URL in Safari (not already installed). Confirm the install hint appears
   pinned above the tab bar: two Hebrew lines, RTL, quiet/translucent capsule matching the tab
   bar's own material, with a close (X) button.
2. Tap close. Confirm it fades and drops slightly (not an abrupt cut), then is gone. Reload the
   page — confirm it does **not** reappear. Confirm no new key was added under Settings → Safari →
   Advanced → Website Data for this site beyond the existing ones (the flag lives inside the
   `poker-settle-v1` JSON blob).
3. On a fresh load (or after clearing site data), leave the hint up: tap Share → scroll to "הוסף
   למסך הבית" → confirm the preview shows the app name "סוגרים קופה" and a clean (non-cropped)
   icon-180 artwork → add it.
4. Launch from the new home-screen icon. Confirm: launch background is dark, not a white flash;
   `navigator.standalone` is now true and the hint does not show even if dismissal were somehow
   reset (the standalone guard alone suppresses it); status bar reads correctly
   (`black-translucent`) against the dark header.
5. Repeat step 1 in light theme (in-app toggle) — hint text, border and close icon should all stay
   legible.
6. Repeat step 1 with Settings → Accessibility → Motion → Reduce Motion on — hint should appear and
   dismiss instantly, no slide/fade.
7. Repeat step 1 in Chrome-for-iOS or Firefox-for-iOS if available — hint must **not** appear there
   (`isIosSafari()` excludes `CriOS`/`FxiOS`/etc.).
8. If an iPad is available: confirm the hint still triggers there too (the
   `navigator.platform === "MacIntel" && maxTouchPoints > 1` branch covers iPadOS 13+ reporting as
   desktop Safari).

### Android (Chrome)

1. Open the deployed URL in Chrome. Confirm the iOS hint never appears (Android UA fails
   `isIosSafari()` — Android has its own native install affordance, untouched by this change).
2. Install via Chrome's menu → "Install app" (or the address-bar install icon).
3. Watch the brief native install/launch splash: background should be dark (`#05070A`), not white,
   and the icon preview should not look awkwardly cropped.
4. From the home screen / app drawer, long-press the icon to preview it in a couple of the OS's
   available icon shapes (circle at minimum; squircle/rounded-square if the launcher offers a
   choice) — confirm the chips, cushions and table all survive every shape, unlike the old
   single `any maskable` file.
5. Launch the installed app — dark background on first frame, no white flash.
6. If DevTools remote debugging is available: Application → Manifest panel should resolve all
   three icons with no 404s and show the maskable icon inside its own masked-circle preview.
7. Repeat the icon-shape check on a second OEM launcher if available (e.g. Samsung One UI), since
   some launchers use a more aggressive mask than the spec's plain circle.

## Open items / notes for whoever picks this up

- The `iosInstallHintDismissed` flag is device-local only (not threaded through `remoteBody()` /
  `applyRemote()`), so it can theoretically be reset by an incoming remote sync update on a shared
  game document. Documented above; low-impact (re-dismissible), deliberately out of scope to keep
  the diff small.
- The new maskable canvas fill is exactly `#05070A`; the *existing* icon's own background is a
  hair off that (~`#0D0D0D`, sampled from its corners). The two are close enough that no seam is
  visible in the rendered overlay/mask previews I generated, but if anyone ever regenerates the
  base `icon-512.png` artwork, it's worth pointing its background at the exact manifest color too.
- `theme-color` is static (matches the app's default dark theme only) — it does not follow the
  in-app light/dark toggle at runtime. That's a standard PWA-manifest limitation (the manifest is
  fetched once, not reactive), not something this task's brief asked to fix.
