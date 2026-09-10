# Group surface — centred modal, researched layout

## Research first: what makes a good "group detail" screen

Grounded in Apple HIG (Modality: sheets vs alerts vs modal dialogs; dialog sizing and
dismissal), Material Design's Dialog guidance, Splitwise's group screen (balances summary →
primary action → member list → activity), and WhatsApp's Group Info screen. Seven concrete
recommendations, each mapped to this app:

1. **A centred dialog is right for self-contained, dismissible content; a sheet implies a
   multi-step flow or an edge it travels from.** (Apple HIG, Modality) → this screen is a
   bounded look-up/action surface (check standing, start a game, manage members) opened from a
   dashboard card or a direct link — not a navigation destination or a multi-step task — so it
   moved from an edge-anchored bottom sheet to a centred dialog.

2. **A dialog sizes to its content with a capped max-height and internal scroll, instead of
   growing past the viewport.** (Material Dialog guidance) → `.group-sheet-panel` got
   `max-width: 440px`, `max-height: min(640px, 84vh)`, `overflow-y: auto`. Long history/member
   lists scroll inside the dialog; the dialog itself never fills the screen.

3. **Dismissal in a dialog sits in a fixed, predictable corner; the surrounding scrim stays
   visible on every side so the context (what you're returning to) is never fully hidden.**
   (Apple HIG / Material) → `.group-sheet` became a centred flexbox with padding on all sides
   (`max(24px, safe-area) 20px`), so the dimmed games dashboard is visible all the way around
   the dialog, not just above it like the old sheet.

4. **Splitwise's group screen order (balances → primary action → member list → activity) is
   the closest analogue for a money-adjacent group screen; this app's leaderboard is the
   money-free stand-in for "balances" (the app never shows per-member amounts in a shared
   view).** → the existing section order (header → primary action → דירוג → חברים → היסטוריה)
   already matches this shape and was kept. The one deliberate deviation: primary action stays
   immediately after the header rather than before a "balances" section, because this app
   already establishes "the single highest-value action leads, right after the header" as its
   own convention elsewhere (games dashboard, profile) — that consistency won over an exact
   Splitwise mirror.

5. **An empty/pre-data section shouldn't claim the same visual weight as a populated one, but
   shouldn't disappear either — a stable placeholder position avoids reflow once data
   arrives.** (Material empty-states; Splitwise and WhatsApp both keep a placeholder rather than
   hiding the section) → applied to the pre-first-game leaderboard: same copy, same position,
   quieter spacing (`.games-section-empty`, 12px top margin vs. 18px for populated sections).

6. **WhatsApp's Group Info keeps a full member list (not a "+N more" summary) for the group
   sizes this kind of app actually has, because each row carries real controls (promote/
   remove).** → the full member list was kept as-is. Summarising it would need new UI state
   (an expand/collapse or a "view all" screen) that doesn't exist today — out of scope per "do
   not add features" — and the dialog's own internal scroll already bounds how much of it shows
   without extra chrome.

7. **A history/activity list doesn't need its own destination screen to be de-prioritised —
   position and scroll order alone communicate priority.** → history stays inline as the last
   section rather than becoming a link to a separate route (there isn't one, and adding one is a
   new feature). Being last inside a capped, scrolling dialog already demotes it below the
   primary action and standings without any structural change.

## What changed

**Container (owner ask #1).** `.group-sheet` (the shared backdrop for both `#groupPreview`, the
dashboard's card-tap surface, and `#groupSheet`, the `appView === "group"` route) is now a
centred flexbox (`display:flex; align-items:center; justify-content:center`) with padding on
every side instead of a bottom-anchored panel. `.group-sheet-panel` dropped `position:absolute;
inset-inline:0; bottom:0; top:max(...)` and the one-sided `border-radius: 20px 20px 0 0` for a
plain, centred box: `max-width:440px`, `max-height:min(640px,84vh)`, `border-radius:20px` (all
four corners), `overflow-y:auto` for internal scroll. The sticky grabber (`.group-sheet-panel
::before`) is gone — it signalled "this is a draggable sheet," which no longer applies.

**Motion.** The old panel travelled `translateY(100%) → translateY(0)` over `.3s
cubic-bezier(.32,.72,0,1)` (an iOS sheet easing). The new one **scales and fades in place**:
`scale(.96)`/`opacity:0` closed → `scale(1)`/`opacity:1` open, `transition: transform .28s ease,
opacity .28s ease` — the same `.28s` duration the backdrop's own opacity fade and every other
grid-open transition in the app already use (DESIGN.md's `rise`/grid-open reference point); only
the animated property changed, matching Material's scale+fade dialog-enter convention instead of
an edge-slide that implies an edge that no longer exists.

**Corner controls (owner ask #2).** `renderGroupHeader`'s back button is now an X
(`<path d="M6 6l12 12M18 6L6 18">`, `aria-label="סגור"`) instead of the old back chevron; `onBack`
itself (`closeGroupPreview` / `setAppView("games")`) is unchanged. In this RTL app,
`inset-inline-start` is the physical **right** edge and `inset-inline-end` is the physical
**left** — so the existing logical-property positions already put the X at top-right and
settings at top-left; nothing needed to flip, only the glyph and a size/position touch-up scoped
to `.games-group-header .back-arrow` / `.games-group-header .games-group-settings-btn` (not the
base `.back-arrow` class, which `.table-header`, `#setBackBtn` and `#groupSetBackBtn` still use
unchanged with their chevron and safe-area offset). Both corner controls are explicit `44×44px`
targets (`min-width`/`min-height`, not padding-derived) pinned `8px` from the header's own top
edge — no `env(safe-area-inset-top)` here, since the dialog itself already sits well clear of the
real screen edge. The settings button **dropped its "הגדרות" text label** at this size: paired
with the X as two matched 44px icon targets, the label made it read heavier than its
counterpart and broke the corner symmetry; `aria-label="הגדרות קבוצה"` still names it for
assistive tech.

**Layout re-weighting (owner ask #3, recommendations L1–L3 above).**
- **L1** — inter-section spacing inside the dialog tightened from the dashboard's 24px to 18px
  (`.group-sheet-panel .games-section`), so more of דירוג/חברים sits above the fold before
  internal scroll takes over.
- **L2** — the pre-first-game leaderboard (`renderGroupLeaders`'s empty branch) gets a
  `games-section-empty` class, tightening its own top margin to 12px — same copy
  ("הדירוג יופיע אחרי המשחק הראשון"), same position, less visual weight.
- **L3** — described above (corner controls).

**Dead CSS removed.** `#groupPreview { z-index:41; align-items:flex-start; overflow-y:auto;
padding-block:... }` and its `.games-group-header`/`.games-section` overrides were an ID-scoped
leftover from before `#groupPreview` shared `.group-sheet-panel` with `#groupSheet` — ID
specificity meant they silently overrode the shared class rules for that one surface only. They
were duplicates of the (correct, already-shared) `.group-sheet-panel` rules and would have kept
`#groupPreview` top-anchored while `#groupSheet` went centred. Deleted; both surfaces are now
driven purely by `.group-sheet`/`.group-sheet-panel`.

## Deliberately left alone

- **Member list stays full, not summarised** (see recommendation 6) — no "+N more," no new
  expand state. Groups in this app are small and every row carries real admin controls; the
  dialog's own scroll already bounds it.
- **History stays inline, not a link** (recommendation 7) — there's no separate history route to
  link to, and adding one is a new feature. Its position (last, inside a scrolling, capped
  dialog) already demotes it.
- **Section order (header → primary action → דירוג → חברים → היסטוריה) is unchanged** — it
  already matches the Splitwise-derived shape (recommendation 4); only spacing/weight changed,
  not order.
- **`openGroup`, `currentGroupId`, `appView` semantics, `settle()`, `tableBalance`,
  `buildHistoryEntry`, `buildDebtRecords`, `finishCloseTable`, cloud sync, and the group-settings
  overlay's own behaviour** — untouched, per the task's non-negotiables. `#groupSettings`
  (z-index 42) still opens above the modal (z-index 41) and closes back to it.
- **No backdrop-tap-to-close was added.** Considered it (the grabber's removal takes away the
  sheet's own "this is dismissible" affordance), but no overlay in this app currently closes on
  a scrim tap — introducing one only here would be a new interaction pattern, which the task
  asked not to add. The X remains the sole explicit dismissal control, same as every other
  overlay in the app.

## Tests

Baseline 662 passing → **666 passing**, 0 failing (`node --test tests/*.test.cjs`).

`tests/group-page.test.cjs` — two tests pinned the old bottom sheet and were rewritten in place,
plus new ones added for the specific owner asks:
- *Before:* `'the group sheet CSS reuses existing tokens (...) instead of inventing new
  spacing/motion values'` asserted `padding: 8px 18px calc(28px + safe-area)`, `border-radius:
  20px 20px 0 0`, and `transition: transform .3s cubic-bezier(.32,.72,0,1)`.
  *After:* replaced by `'the group modal is centred and capped, not edge-anchored to the bottom
  of the viewport'` (flex-center backdrop, no `position:absolute`/`bottom:0`/one-sided radius/
  `translateY(100%)`, has `max-width`/`max-height`/`overflow-y:auto`/4-corner radius, no grabber)
  and `'the modal scales+fades in on the app's existing .28s timing, not the old iOS-sheet
  slide'` (scale/opacity transition, no `cubic-bezier`).
- *Before:* `'both group surfaces open as an animated sheet, not a full-screen swap'` asserted
  `top: max(...)`, `translateY(100%)`, and the grabber's `position: sticky`.
  *After:* split into `'both group surfaces still open through afterNextFrame, and close by
  reversing the transition before hiding'` (keeps the `afterNextFrame`/rAF-fallback/close-then-
  hide assertions, stronger name, sheet-specific claims removed) plus two new tests: `'the close
  control is an X pinned to the top-right (inline-start) of the modal, settings to the top-left
  (inline-end), both 44px targets with aria-labels'` and `'the settings corner control drops its
  text label at this size — icon-only, matching the X as a pair'`.
- New: `'an empty leaderboard keeps its copy and position but is visually de-emphasised, not
  removed'` (L2).
- `'the reduced-motion rule stays the very last rule in the stylesheet, after the new group modal
  CSS'` — assertion logic unchanged (it checks relative position via `indexOf`, not literal old
  CSS text), only the description/comment updated.

`tests/group-preview.test.cjs` — one `sourceBetween` end-marker
(`'  // Back arrow, 64px avatar'`) pointed at a comment that no longer exists verbatim (the
comment above `renderGroupHeader` was rewritten to describe the X/settings corner controls);
changed the marker to `'  function renderGroupHeader('` (a stable code-level marker). No
assertions changed — this file didn't pin any bottom-sheet-specific CSS or motion, only the
shared markup/adapter wiring, which is unchanged.

`tests/groups-create.test.cjs` — reviewed, not touched. It doesn't assert anything about
`.group-sheet` CSS, the grabber, or the corner-button glyphs; its `appView === "group"` /
`renderGamesDashboard(); renderGroupPage();` composition test is about routing, not presentation,
and still passes unchanged.

`tests/design-round.test.cjs` — one incidental fix: a `sourceBetween` end-marker also used the
now-gone `'  // Back arrow, 64px avatar'` comment (unrelated test, about the dashboard's lack of
a big title). Changed the marker to `'  function renderGroupHeader('` for the same reason as
above; the test's own assertions are untouched.

## Verification

- `node --test tests/*.test.cjs`: 666/666 passing.
- `git diff --check`: clean.
- Last `<script>` body parses with `new Function`.
- Manually exercised both `#groupPreview` (dashboard card tap) and `#groupSheet` (`appView ===
  "group"`) in a browser against the raw `kupa-sgura.html` (no build step): confirmed via
  `getComputedStyle`/`getBoundingClientRect` that the panel is centred with symmetric margins,
  capped at `max-height: min(640px, 84vh)`, rounded on all corners, and that the X (`aria-label`
  "סגור") sits at the physical right at 44×44px while the settings gear (`aria-label` "הגדרות
  קבוצה", no text) sits at the physical left at 44×44px. Confirmed in both dark and light theme,
  and at a 375×812 mobile viewport. Confirmed the empty-leaderboard section carries
  `games-section-empty` with `margin-top: 12px` versus `18px` for populated sections. Confirmed
  closing (`.back-arrow` click) removes `.open` immediately and only sets `hidden` after the
  `.28s` exit transition.
- Did not run `python3 build.py`; `index.html`/`sw.js` untouched (`git status` confirms only
  `kupa-sgura.html`, `DESIGN.md`, and three test files changed).
