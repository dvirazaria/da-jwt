# Multi-game Round 1 report (redo)

Spec: `docs/superpowers/plans/2026-09-10-multi-game.md`. Scope: Round 1 only ("storage
only, behavior unchanged") — state shape, non-destructive migration, mirror, repointed
mutators. Route/dashboard/cloud/realtime (Round 2) untouched.

This is a **redo** of Round 1. The first attempt (branch `worktree-agent-a7bf8247a0558b0aa`,
commits `0bdc31c`/`b6e5e04`/`5d587f4`) kept the singular fields authoritative and derived
`state.games` from them — scaffolding, not the plan's design. Per the owner's explicit
ruling, this redo flips the direction for real: **`state.games` is the authoritative
store; `syncCurrentGameMirror()` copies the current slot onto the singular fields, never
the other way around.**

## Branch history

`git merge main` (already up to date — this worktree started from `main`'s tip), then
`git merge worktree-agent-a7bf8247a0558b0aa` (fast-forward; kept its migration tests and
staleness guard as the starting point, replaced its mirror direction entirely).

Baseline after both merges: **643 passing** (`node --test tests/*.test.cjs`). This
redo's commit: **647 passing, 0 failing**. `git diff --check` clean. The final
`<script>` body parses with `new Function`.

Commit: `feat: flip state.games to the authoritative multi-game store (round 1, redo)`.

## Mirror direction = games → singular, and why it's inside `save()`

`syncCurrentGameMirror(state)` finds the slot matching `state.gameId` in `state.games`
and copies its `players`/`phase`/`groupId`/`startedAt`/`leaderRef`/`settlementStatuses`
onto the singular fields (or resets them to closed/empty defaults when no slot matches).
It is called from two places:

- **`save()`** — every mutator already ends by calling `save()` (this was already true
  before this round and is exactly what the staleness guard below verifies), so this is
  the one place that makes drift structurally impossible for anything that reaches
  persistence.
- **`normalize()`** (on load, and on every `normalize(mergeCloudIntoState(...))` cloud
  merge) — so a freshly loaded or merged document's singular fields are always derived
  from its `games`, never trusted verbatim off raw input.

**`newCurrentGame` also self-mirrors** before returning (calls `syncCurrentGameMirror`
on the object it just built). This was necessary, not optional: several callers read
`state.players`/`phase`/`groupId` for their own logic in the window between
`newCurrentGame()` and the next `save()` — `addPlayer()`'s duplicate-name guard
(`state.players.some(x => x.name === name)`) runs right after `markReal()` calls
`newCurrentGame`, and `startGroupGame`'s participant loop needs `currentGameSlot(state)`
to resolve immediately after `newCurrentGame` replaces the current slot. Centralizing the
mirror only in `save()` would have left those reads seeing stale data from the *replaced*
game for one tick. Putting it in `save()` *and* inside `newCurrentGame` closes that gap
without weakening the guard (`newCurrentGame` calls `syncCurrentGameMirror`, it does not
assign the singular fields itself).

## Repointed mutators

`newCurrentGame`, `finishGame`, `returnToGameEdit`, `finishCloseTable`,
`addPlayerToTable`, `confirmBuyin`, the inline undo handler, the inline settlement-toggle
handler, and `startGroupGame`'s participant loop all now write the **current slot**
(`currentGameSlot(state)`) instead of the singular fields. No mutator assigns
`state.players`/`phase`/`groupId`/`startedAt`/`leaderRef`/`settlementStatuses` directly
anymore — the only 6 such assignments left in the whole script are the 6 lines inside
`syncCurrentGameMirror` itself (proved by the staleness guard test, see below).

- `finishCloseTable` no longer hand-resets the 6 singular fields after minting the fresh
  placeholder `gameId` — it only drops the OLD slot from `state.games` and mints the new
  id; `save()`'s mirror finds no slot for that id and resets everything to closed/empty
  itself, which is the exact same output as before, just derived instead of assigned.
- `addPlayerToTable` builds a slot defensively if `currentGameSlot(state)` is somehow
  missing (it never should be in practice — see below — but this keeps the function's
  old "always ends in the right state" guarantee regardless).

### A genuinely new question the direction flip raised, and how it's resolved

`state.games` previously only ever held *real* open games (`isGameOpen`: at least one
player). Once mutators write into slots directly and nothing else holds "the current
table," a freshly-started, not-yet-peopled game (`startUngroupedGame` before the first
player lands) has nowhere else to live. **`newCurrentGame` now pushes a slot for any
open-phase patch regardless of player count** (gated on `hasOpenPhase`, not
`isGameOpen`), and **`normalizeGameSlot`** (re-validating an entry already in a
persisted/synced `games` array) was broadened the same way, so that draft survives a
reload/cloud-merge round trip.

The **one-time legacy migration** (a true pre-round-1 document with no `games` field at
all) stays conservative and keeps the old `isGameOpen` gate — never inventing a slot
from ambiguous historical data, per the plan's own §1 wording. This asymmetry is
deliberate and documented in `migrateGamesArray`'s comment.

## Tests I rewrote, before → after

**`tests/multi-game-migration.test.cjs`** (10 tests → 14 tests):

- *Migration test cases kept verbatim* (open active, open settlement w/
  `settlementStatuses`, closed, idempotent re-run, unrelated-slot-preserved): unchanged
  assertions — the migration output shape doesn't depend on mirror direction.
- **"an empty table (active phase, no players) migrates to an empty games array"** —
  before: asserted `result.phase === 'active'` (singular was authoritative, untouched by
  the mirror). After: asserts `result.phase === 'closed'`, matching the plan's own
  pseudocode default (`slot ? slot.phase : "closed"`) now that no slot exists for an
  empty legacy document and games is authoritative. Documented as unobservable through
  the UI: `initialAppView` already gates on `isGameOpen` (requires ≥1 player) before it
  ever reads `phase`, so this field's value is dead for routing purposes either way.
- **NEW** "an already-migrated document keeps a zero-player current slot... across a
  reload" — pins the broadened `normalizeGameSlot` gate (`hasOpenPhase`, not
  `isGameOpen`) that the direction flip required.
- **NEW** two `syncCurrentGameMirror` unit tests — copies the matching slot onto the
  singular fields; resets to closed/empty defaults when no slot matches; in both cases
  asserts `state.games` itself is byte-for-byte untouched (read-only on the store).
- **NEW** a full mutator-driven lifecycle test — runs the real `finishGame`/
  `returnToGameEdit` source against a seeded `state.games` (two slots, `save()` stubbed
  as a counter) and asserts the SLOT's phase changes while an unrelated slot is never
  touched.
- **"newCurrentGame drops the replaced game's own entry from games"** — before: loaded
  `newCurrentGame`'s own source in isolation. After: loads the full groups-domain pure
  slice (`newCurrentGame` now calls `hasOpenPhase`/`syncCurrentGameMirror`), and adds an
  assertion that the result already self-mirrored (`result.phase === 'closed'`,
  `result.players` empty) without a `save()` call.
- **NEW** "newCurrentGame with an open patch pushes a fresh slot... and mirrors it
  immediately" — pins the self-mirroring behavior `addPlayer()`'s duplicate-name guard
  and `startGroupGame`'s participant loop both depend on.
- **"finishCloseTable clears the closing game's own games-array entry..."** — before:
  regex required `state.games = (...).filter(...)` immediately followed by
  `state.players = [];` then `state.gameId = newId();`. After: requires the filter
  immediately followed by `state.gameId = newId();` (no singular-field assignment in
  between anymore), plus new `assert.doesNotMatch` checks that `finishCloseTable` never
  assigns `state.players`/`phase`/`settlementStatuses` itself.
- **"every direct write to the mirrored fields..." → "no direct assignment... except
  inside syncCurrentGameMirror"** — before: asserted every match sits inside *some*
  function that calls `save()` afterward (`checked >= 9`). After: asserts every match's
  enclosing function is **exactly** `syncCurrentGameMirror`, with an **exact** count of 6
  (not a floor) — the stronger invariant the task asked for, verified against the actual
  file (`grep`-counted: 6 matches, all on the 6 consecutive lines inside
  `syncCurrentGameMirror`).

**`tests/games-navigation.test.cjs`**:

- **"the persisted state carries an explicit phase"** — before: `phase:\s*normalizePhase\(`
  matched `normalize()`'s old object-literal property. After: `const phase =
  normalizePhase\(` — `normalize()` now computes `phase` as a scratch local used only to
  shape `state.games`, never written onto the document directly.
- **"active game finish is a one-second hold..."** — before: regex required the literal
  `state.phase = "settlement"` / `state.phase = "active"` anywhere in the file. After:
  requires `slot.phase = "settlement"` / `slot.phase = "active"` (the new target).
- **"finish and return actions preserve the current game data"** — before: hand-built
  `state` had no `games` array; asserted through `state.phase`/`state.players` after a
  *stubbed* `save()`. After: seeds a matching slot in `state.games` and asserts through
  `currentGameSlot(state)` instead, since the stubbed `save()` (a counter, unchanged)
  never runs the real mirror — this is "assert through the slot" exactly as instructed.
- **"final close archives the game and returns to the Games dashboard"** — before:
  required the literal `state.phase = "closed";` / `state.players = [];`. After:
  requires the `state.games` filter + `state.gameId = newId();` sequence, proving
  `finishCloseTable` delegates the reset to the mirror instead of hand-assigning it.

**`tests/group-game-close.test.cjs`**:

- **"finishCloseTable captures the closing group, frees groupId/leaderRef..."** →
  renamed **"...drops the closing game's own slot..."** — before: required literal
  `state.groupId = null;`/`state.leaderRef = null;`/`state.startedAt = null;`. After:
  requires the `state.games` filter + `state.gameId = newId();` sequence (same shape as
  the games-navigation.test.cjs rewrite above — both now pin the identical source
  pattern, since it's the same function).
- **"newCurrentGame resets groupId and leaderRef to null..."** — before: loaded only
  `newCurrentGame`'s own source (now missing `hasOpenPhase`/`syncCurrentGameMirror`, a
  `ReferenceError`). After: loads the full groups-domain pure slice, same fix pattern as
  the migration-test file's equivalent test. Assertions unchanged (still checks
  `result.groupId === null` / `result.leaderRef === null`) — this one didn't need a
  stronger assertion, only the missing dependency.

**`tests/entry-log.test.cjs`**:

- **"each added amount has a distinct identity..."** — before (already patched by the
  prior round): loaded `groupsPureSource` but pushed the player straight into a bare
  `state.players` with no `state.games` entry. Under the new direction, `save()`'s real
  mirror would have reset `state.players` back to `[]` (no matching slot), silently
  discarding the test's own setup. After: seeds an equivalent slot in `state.games`
  (same player object, by reference) so the real, unstubbed `save()` call now exercises
  the actual games → singular path instead of accidentally bypassing it.
- **"adding a player records the first entry but leaves every rebuy menu closed"** —
  before: hand-built `state` had no `gameId`/`games`, asserted through
  `state.players[0]`/`state.phase` after a stubbed `save()`. After: seeds
  `gameId`/`games: []`, loads only the slot-machinery slice (not the full groups-domain
  pure section, which would shadow the test's simplified `createPlayer` stub with the
  real one that needs `newId()`), and asserts through `currentGameSlot(state)` instead —
  proving `addPlayerToTable` actually writes the authoritative store, not just a
  singular field a stubbed `save()` happens to leave alone.

## What was NOT touched (per the "Round 1 only" instruction)

`appView`/`currentGameId`, the dashboard (`getActiveGameSummaries`, `canStartGroupGame`'s
`another-game-open` branch, `renderGroupPrimaryAction`'s `[0]` index), `pullCloud`/
`pushCloud`/`cloudCollections`/`pickCloudOpenGame`, and the realtime channel are all
exactly as before. Behavior stays observably single-slot: same screens, same flows,
same integer-settlement/zero-balance-close/unbalanced-hold/debt/payment-toggle
guarantees (all still covered by their existing, unmodified test files —
`entry-log.test.cjs`'s balance/debt tests, `player-exit.test.cjs`, the settlement tests
in `games-navigation.test.cjs`/`empty-table.test.cjs` — none of which needed changes,
since none of them mutate the singular fields directly).

## Proof that `games` is now authoritative

The staleness guard (`tests/multi-game-migration.test.cjs`, last test) greps the entire
script for every assignment to `state.players`/`phase`/`groupId`/`startedAt`/
`leaderRef`/`settlementStatuses` and asserts each of the exactly 6 matches found sits
inside `syncCurrentGameMirror` — no other function in the file is allowed to write these
fields at all, so the only way they can ever hold a value is by being copied off
`state.games`.

## Is this branch merge-safe?

**Yes.** 647/647 tests pass, `git diff --check` is clean, and the final `<script>` body
parses. Behavior is unchanged end-to-end: every existing regression-protection test
(settlement integer arithmetic, zero-balance-only normal close, the one-second
unbalanced-close hold with `isBalanced`/`balanceDifference`, reversible payment toggles,
creditor-only debt marking, buy-in/entryLog sync, boot-resume-at-phase) still passes
unmodified. `index.html`/`sw.js`/`build.py` were not touched; `python3 build.py` was not
run. Round 2 (route/dashboard/cloud/realtime) is unstarted, exactly as scoped.
