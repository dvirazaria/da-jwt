# Create-group panel placement fix

## What changed

`kupa-sgura.html`, `renderGroupsSection` (~line 5984): `renderCreateGroupPanel(section)` is now
called right after the heading row is appended, before the group list / empty-state paragraph is
built — not after the whole list as before. The panel's own markup/CSS (`.games-create-panel`,
grid-collapse `0fr → 1fr`, `.28s`) is untouched; only where it gets inserted in the DOM changed.

`renderCreateGroupPanel` (~line 5833): the `createGroupJustOpened` branch now, after adding the
`open` class on the double-`requestAnimationFrame`:
- calls `nameInput.focus()` unconditionally, so typing can start immediately;
- calls `panel.scrollIntoView({ behavior: "smooth", block: "nearest" })`, but only when
  `document.activeElement` is not an `INPUT`/`TEXTAREA` — so it never yanks the page out from
  under someone typing in an unrelated field. `block: "nearest"` also means it does nothing when
  the panel is already fully visible.

`createGroup` and its data path are untouched — presentation/placement only.

## Kept the inline panel (not a modal)

The in-place `.games-create-panel` grid-collapse pattern already existed and is reused by
add-member (`renderAddMemberPanel`) and add-friend (`renderAddFriendPanel`) — the latter already
had the exact focus-on-open idiom (`requestAnimationFrame` x2 → add `.open` → `.focus()`) this fix
extends with the guarded `scrollIntoView`. Moving the call site three lines earlier in
`renderGroupsSection` was sufficient to put the panel where the button is; nothing about the
panel's shape made it unable to work there, so no modal was needed.

## Tests

`tests/groups-create.test.cjs` gained 4 tests (source-level, regex/`indexOf` against the raw
`kupa-sgura.html` text, consistent with this file's existing style):

1. `renderCreateGroupPanel(section)` is called after `section.appendChild(heading)` but before
   both the `games-group-list` build and the `אין לך קבוצות עדיין` empty-state string.
2. The panel still builds via `el("div", "games-create-panel")` and defers `classList.add("open")`
   inside a double `requestAnimationFrame`, so it animates rather than appearing instantly.
3. The `createGroupJustOpened` open block calls `nameInput.focus()` and
   `panel.scrollIntoView({ behavior: "smooth", block: "nearest" })`, guarded by
   `activeTag !== "INPUT" && activeTag !== "TEXTAREA"` against `document.activeElement`.
4. `closeCreateGroupPanel` still does `panel.classList.remove("open")` then
   `setTimeout(finish, 280)` before clearing the draft — the reversal is unchanged.

No existing test asserted the old (post-list) ordering by DOM position — the closest candidate,
`tests/group-preview.test.cjs`'s "create group moved from the quick actions..." test, only checks
that `renderCreateGroupPanel(section)` appears somewhere inside `renderGroupsSection`'s source, not
where — so nothing needed to be weakened or rewritten, only the four new tests above added.

Baseline was 680 passing; suite is now 684 passing, 0 failing.

## Verification

- `node --test tests/*.test.cjs` → 684/684 pass.
- `git diff --check` → clean (no whitespace errors).
- Last `<script>` body extracted and run through `new Function(...)` → parses.
- `index.html` / `sw.js` untouched (`git status --short` shows only `kupa-sgura.html`,
  `tests/groups-create.test.cjs`, `DESIGN.md`); `build.py` was never run.

## DESIGN.md

Added one bullet under "התנהגות שהיא חלק מהעיצוב" establishing the placement rule for
`.games-create-panel`-style inline panels generally: open adjacent to the control that summoned
them (not appended after a growing list), and scroll into view only when no other input already
has focus.
