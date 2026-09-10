# Group modal polish — header, empty leaderboard, member rows, scroll lock

Six owner requests on the group modal (`#groupPreview` / `#groupSheet`, shared `.group-sheet`/
`.group-sheet-panel` markup and CSS). Baseline 668 tests passing → **677 passing, 0 failing**
(`node --test tests/*.test.cjs`).

## 1. Shrunk and lifted identity block

`.games-group-header-avatar` `64px`→`44px` (font-size `26px`→`18px` for the initial-letter
fallback), `.games-group-header-name` `24px`→`18px` (margin-top `6px`→`4px`), `.games-group-header-meta`
`13px`→`12px`, header `gap` `6px`→`4px`. `.group-sheet-panel .games-group-header`'s `padding-top`
dropped `56px`→`40px` — the same value the base (non-modal) `.games-group-header` rule already
uses, not a second invented number. `56px` paid for clearance the shrunk, centred block no longer
needs: the corner controls are a `44px` square starting at `top: 8px` (footprint ends at `y=52`),
but the header's content is centred and far narrower than the panel, so nothing runs under the
corner squares even at `40px` — confirmed live (`getComputedStyle`) at a 375×812 viewport. Header
stays `position: sticky` (unchanged) — it carries the only close control.

## 2. Empty leaderboard — no line, no heading

`renderGroupLeaders` now returns `null` when the entries list is empty (checked *before* any DOM
is built), instead of a `.games-section-empty`-classed section with a placeholder line. **Decision:
the "דירוג" heading also disappears** — a heading over nothing is still clutter, not information,
matching the owner's own hint. Both call sites (`renderGroupPreview`, `renderGroupPage`) now guard
the result: `const leaders = renderGroupLeaders(...); if (leaders) inner.appendChild(leaders);`.
The now-dead `.group-sheet-panel .games-section.games-section-empty { margin-top: 12px; }` CSS rule
was removed along with the class. Verified live: with a fresh group and no closed games, `leaderSectionPresent`
(searching for an `h3` containing "דירוג") is `false`; the whole leaderboard section appears the
moment a game closes, with its normal entrance animation, not a "reflow-in" of an existing empty box.

## 3. Modal +60px

`.group-sheet-panel`'s `max-height: min(640px, 84vh)` → `min(700px, 88vh)`. `700px` (was `640px`)
is the binding constraint on a typical phone (~800px+ viewport height), delivering the full +60px
there; `88vh` (was `84vh`) also grew so a smaller phone gets a proportional increase rather than
none, while staying safely under `100vh` — that's the actual backstop against a full-screen panel
(not the backdrop's own padding, which stayed `max(24px, safe-area) 20px` on every side since it
was never the limiting factor at any tested viewport). Confirmed live: `getComputedStyle(panel).maxHeight
=== "700px"` at 375×812.

## 4/5. Member rows: plain, admin gets a red X

`renderMemberRow` rewritten: no more `role="button"`/`tabindex`/`aria-expanded`/`aria-controls`/
chevron/click-to-expand/`memberActionsOpenId` for the row. A row is now just a name span, plus a
"מנהל" tag right after it for an admin subject. For an admin viewer, a row also gets
`renderRemoveMemberButton`'s icon-only red X (`.games-member-remove`, reused/modified in place —
no new removal path) at the inline-end (left), gated by
`isAdmin && !membershipMatchesUser(member, me) && !isLastActiveAdmin(activeList, member.id)` — the
exact same self-guard and last-admin guard the old expanded strip used. Two-step arm/disarm
(`armRemoveMember`/`disarmRemoveMember`/`removeMemberArmedId`, 4s auto-disarm) is untouched, just
triggered from the X. `.games-member-remove` is `color: var(--bad)` **at rest** (not hover-revealed
— a destructive control in a dense list should read as such immediately), 44×44px target, filled
`--bad` circle + bg-coloured icon on `.armed`. `aria-label` names the member in both states.

Verified live with a seeded 3-member group: my own row (admin) never gets an X; a co-admin (not
last) gets one; a demoted-to-sole-admin "me" loses the X on my own row (both guards independently
hold); a regular member always gets one. `document.body` and CSS colour confirmed
`rgb(255, 109, 109)` === `--bad`.

**Kept, not deleted:** `renderMemberActions`/`renderMakeAdminButton`/`renderRemoveAdminButton`
(the old promote/demote/text-remove strip) and their CSS stay defined, verbatim, but nothing calls
them from the row any more. `promoteMember`/`demoteMember` are real, independently tested
capabilities (`tests/group-lifecycle.test.cjs` pins `promoteMember` + the "הפוך למנהל" copy) that
the six owner asks never mentioned removing — deleting the render functions along with the strip's
chrome would have silently taken "promote to admin" out of the app with no replacement surface,
which is a bigger change than "tidy up the row" asked for. This is now documented in both
`DESIGN.md` and a code comment, not silently orphaned.

## 6. Body scroll lock (iOS Safari-safe)

`lockGroupModalScroll`/`unlockGroupModalScroll` (new, next to `openGroupPreview`): `body.style.position
= "fixed"` pinned at the captured `scrollY` (via `top: -Npx`), restored via `window.scrollTo(0, savedY)`
on unlock — `overflow: hidden` alone does not stop rubber-band scroll on iOS Safari, this does.
Reference-counted (`groupModalLockCount`, not a boolean) so `#groupPreview` and `#groupSheet`
closing independently can never unlock the body while the other is still open. Locked on a genuine
closed→open transition only (`wasHidden` in `openGroupPreview`, `!groupSheetOpen` in
`syncGroupSheet`) — not on every re-render. Unlocked **immediately** in `closeGroupPreview` and
`syncGroupSheet`'s close branch — not waiting on the ~300ms exit transition — so Escape and the
backdrop tap (both route through `dismissOpenGroupModal` → one of those two functions) restore
scroll exactly. `.group-sheet-panel` got `overscroll-behavior: contain` so its own internal scroll
never chains onto the locked body. Verified live: `document.body.style.position === "fixed"` while
open, `=== ""` immediately after clicking the close X (before the panel's own hide timeout fires).
Backdrop-tap-to-dismiss (pre-existing) is untouched.

## Tests

667 (baseline 668 − 1, see below) + **10 new** = 677 passing.

**`tests/design-round.test.cjs`** (rewrote the "D3: member row actions behind a tap" block, 4
tests → 4 tests, plus trimmed the motion-class list by one):
- *Before:* `'an admin member row is a button that expands an inline action strip'` asserted
  `role="button"`, `tabindex="0"`, `aria-expanded`, Enter/Space handling, `memberActionsOpenId` all
  **present**.
  *After:* `'a member row carries no role=button, no tabindex, no aria-expanded, no chevron, no
  memberActionsOpenId...'` asserts all of those **absent**, plus the new name/tag/X wiring present
  — the opposite assertion, strictly stronger (a regression back to the old mechanism would now fail).
- *Before:* `'the action strip carries promote/demote, the armed remove and the last-admin note'`
  described live UI.
  *After:* retitled `'the retired action strip ... still exists as unreachable code, not deleted,
  for promoteMember/demoteMember's sake'` — same assertions (nothing weakened), plus a new
  assertion that `renderMemberRow` no longer calls `renderMemberActions(` at all.
- *Before:* `'the open member row is UI-only state, reset on every view change'`.
  *After:* retitled `'memberActionsOpenId is declared and reset on view change only for the
  retired strip above — the live row never reads it'`, same two assertions plus a new
  `doesNotMatch` confirming the live row never references the variable.
- *Before:* `'member rows no longer show their actions unconditionally'` (a weak double-negative
  checking two `doesNotMatch`es).
  *After:* `'a member row shows the remove X only when it is legal: admin viewer, not self, not
  the group's last active admin'` — asserts the exact `canRemove` guard expression, strictly more
  specific than the old check.
- The `classesNeedingMotion` list dropped `'.games-member-row[role="button"]'` (the selector no
  longer exists — the row never carries `role="button"`); its successor (`.games-member-remove`'s
  press state) is already covered by `tests/motion.test.cjs`, so nothing was left unverified.

**`tests/group-page.test.cjs`** (2 tests rewritten):
- *Before:* `'renderGroupLeaders shows the pre-first-game empty state and renders the full list,
  uncapped'` asserted the placeholder copy **present**.
  *After:* same name reworked to `'... renders nothing before the first game ... and the full
  list uncapped once there is one'` — asserts the `if (!list.length) return null;` guard and the
  placeholder copy **absent**, keeping the uncapped-list half.
- *Before:* `'an empty leaderboard keeps its copy and position but is visually de-emphasised, not
  removed'` — the literal opposite of the new behaviour.
  *After:* `'an empty leaderboard is not removed-and-forgotten — it renders nothing, section and
  heading included, and both call sites guard the null'` — asserts the old weight-reduction class
  and copy are **gone entirely** (not just quieter) and that both call sites null-guard the result.

**`tests/group-members.test.cjs`** — reviewed, **not modified**. Nothing in it pins the removed
tap-to-expand mechanism or the old CSS classes; its one row-level test only checks
`renderGroupMembers`' function signature, which is unchanged.

**New file `tests/group-modal-polish.test.cjs`** (10 tests): empty-leaderboard bail-out ordering +
full copy removal; no chevron/`role="button"` selector anywhere in the source; the X's `--bad`
colour/44px target/aria-label; the full remove chain traced from the X through
`armRemoveMember`→`removeMember`→`removeGroupMember` with a **functional** (vm-executed, not just
regex) last-admin-guard fixture; the self-exclusion guard, also functionally exercised via
`membershipMatchesUser`; scroll-lock applied on open (both surfaces) and restored on close (both
surfaces, Escape/backdrop wiring traced); the reference-counting itself; `overscroll-behavior:
contain`; the new max-height numbers.

Net test count: one array entry removed from `design-round.test.cjs`'s motion list (668−1=667)
+ 10 new = **677**.

## Verification

- `node --test tests/*.test.cjs`: 677/677 passing.
- `git diff --check`: clean.
- Last `<script>` body parses via `new Function`.
- `git diff --name-only`: only `DESIGN.md`, `kupa-sgura.html`, `tests/design-round.test.cjs`,
  `tests/group-page.test.cjs` modified, plus the new `tests/group-modal-polish.test.cjs` —
  `index.html`/`sw.js` untouched, `python3 build.py` not run.
- Manually exercised the raw `kupa-sgura.html` in a browser (local static server, no build step)
  with a seeded 3-member/2-admin group at a 375×812 viewport: confirmed via
  `getComputedStyle`/DOM inspection every number above (`max-height: 700px`, header `padding-top:
  40px`, avatar `44×44px`, name `18px`, meta `12px`, `overscroll-behavior: contain`), the empty
  leaderboard's absence, the three member-row variants (self/no-X, co-admin/X, plain
  member/X), the last-admin guard (re-tested after demoting the co-admin — my own sole-admin row
  lost its X), the X's live colour (`rgb(255, 109, 109)` = `--bad`), and the scroll lock
  (`body.style.position === "fixed"` while open, `=== ""` immediately on close, before the exit
  transition's timeout fires).

## DESIGN.md

Updated: the modal-height paragraph (new numbers + why `vh` also moved, not just the px cap); a
new "כותרת הזהות של הקבוצה" paragraph (old→new avatar/name/meta/gap/padding-top numbers and the
horizontal-clearance reasoning); a new "דירוג ריק" paragraph replacing the old L2 (explicitly
marked as superseding it); the "כותרת הדיאלוג" section's avatar/name/meta numbers; a full rewrite
of "שורות חברים ותוויות" describing the retired tap-to-expand mechanism, the new plain row, the X
button, and why the promote/demote render functions were kept rather than deleted; a new "נעילת
גלילה מאחורי הדיאלוג" paragraph documenting the scroll-lock mechanism, the reference count, and the
`overscroll-behavior: contain` pairing.
