# Tab bar position drift — report

## Reproduction setup

- Served the repo with `python3 -m http.server 8935` and drove it with a browser at a 390x844
  viewport.
- `kupa-sgura.html` itself has no `<meta name="viewport">` (it is a fragment; `build.py` adds that
  when generating `index.html`), so loading it directly gives the browser's ~980px desktop-site
  default layout viewport, not the requested 390px. Confirmed via
  `window.innerWidth/innerHeight/visualViewport.scale` (980×2121, scale 0.398) before switching to
  serving the already-in-sync, untouched `index.html` (never edited — only read/served for this
  measurement; `git status` was clean before and after, so nothing needed reverting).
- Seeded `localStorage["poker-settle-v1"]` with 20 groups (`players: []`, real `groups` array) and
  `poker-settle-me`, so the games tab renders a long, scrollable list
  (`document.body.scrollHeight` 1726 vs `innerHeight` 844) while the friends tab stays short
  (`scrollHeight` 443, no scroll).
- Attempted to reproduce on real iOS Safari via the iOS Simulator tool; it requires a full Xcode
  install that is not present on this machine (`xcode-select` points at CLI tools only), so this
  stayed a desktop-viewport + static-analysis investigation, as the task's own reproduction method
  prescribes.

## Measurements (`.tabbar.getBoundingClientRect()`, 390×844 viewport)

| Tab | Scroll position | top | bottom |
|---|---|---|---|
| friends (no scroll possible) | top | 782 | 840 |
| games (scrollable, 1726px content) | scrolled to top | 782 | 840 |
| games (scrollable, 1726px content) | scrolled to bottom (`scrollY` 882) | 782 | 840 |

Identical in every case — in a standards desktop/Chromium engine, `position: fixed; bottom: 10px`
with no containing-block-creating ancestor is exactly as inert to content length as it looks. That
is expected and is itself evidence: it rules out the containing-block and mid-animation
hypotheses cleanly (see below), rather than failing to reproduce the bug.

## Root cause (by elimination + evidence, not by guessing)

Ruled out, with evidence:

- **Rise-animation caught mid-flight**: `grep` across the whole file shows `.load-in` is set once
  on `<nav class="tabbar load-in" ...>` in the static markup (line ~1385) and is never toggled by
  any script — the only `classList` calls on `.tabbar` are `kb-open` add/remove. The generic
  per-container `load-in` toggle helper (~line 5402) is only ever called with other containers
  (`#gamesHome`, `#rows`, ...), never `.tabbar`. So the bar cannot be reappearing mid rise-keyframe
  on a later render.
- **A transform/filter/contain/will-change ancestor changing the containing block**: `grep -n
  "will-change\|contain:\|backdrop-filter\|transform:"` over the whole file, cross-checked against
  `.tabbar`'s actual ancestor chain (`html` → `body` → `.wrap` → `<nav class="tabbar">`), shows none
  of `html`, `body`, or `.wrap` declare any of these properties in static CSS, and no script ever
  sets `.style.transform`/`.style.filter` on them (the only inline-style writes to `body` are the
  group-modal scroll lock's `position/top/left/right/width`, unrelated to tab switching). Also
  confirmed empirically above: the rects are byte-identical regardless of content length, which is
  exactly what "no containing-block ancestor" predicts and exactly what a stray transform ancestor
  would have broken.

Left standing, and consistent with the reported symptom (two screenshots on the same iPhone,
seconds apart, one screen short and static, one screen long and scrolled):

- **`.tabbar` used a bare `bottom: 10px`**, while `.wrap`'s own `padding-bottom` already folds in
  `env(safe-area-inset-bottom, 0px)`. `env(safe-area-inset-bottom)` is not a fixed device constant
  on iOS Safari — WebKit reports it as ~0 while the bottom toolbar is showing (the toolbar's own
  chrome already clears the home indicator) and raises it to the home-indicator height once the
  toolbar auto-hides on scroll (page content now reaches the true bottom edge, so the page itself
  must clear the indicator). A rule that ignores this swing lands 10px above a short, never-scrolled
  screen's toolbar-occupied edge (a visible gap — the friends tab) but only 10px above the *true*
  device edge once a tall screen is scrolled and the toolbar collapses (the games tab: "nearly
  touching the home indicator, overlapping the last row"). This is a real, well-documented iOS
  Safari behavior that a desktop/Chromium viewport cannot reproduce (`env()` always resolves to 0
  there) — hence the identical desktop measurements above are not a contradiction, they are exactly
  what's expected once the containing-block and animation causes are ruled out, leaving the
  toolbar-driven safe-area swing as the only remaining explanation for a real-device, scroll-linked
  drift.

## Fix

`kupa-sgura.html`, `.tabbar` rule:

```css
/* before */ bottom: 10px;
/* after  */ bottom: calc(10px + env(safe-area-inset-bottom, 0px));
```

Mirrors the exact idiom `.wrap`'s `padding-bottom` already uses, so the bar keeps a constant 10px
clearance from the true device edge in both toolbar states instead of 10px from whatever the
toolbar currently leaves visible.

## Regressions checked

- `.tabbar-in { height: 44px }` / `.tab { height: 100% }` (previous height fix) — untouched, still
  present, asserted by test.
- `.tabbar.kb-open { transform: translateY(120px); opacity: 0; ... }` — untouched, asserted by test.
- `.load-in` entrance animation and the active-tab `.tlabel` max-width animation — untouched (no
  edits outside the one `bottom` value and its comment).
- `node --test tests/*.test.cjs`: 684 passing (680 baseline + 4 new).
- `git diff --check`: clean.
- Last `<script>` body parses via `new Function(...)`.
- `index.html` / `sw.js`: never modified (only read/served, already in sync with `kupa-sgura.html`
  at the time); `git status` shows only `kupa-sgura.html` and the new test file.
