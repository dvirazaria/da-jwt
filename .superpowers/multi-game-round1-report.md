# Multi-game Round 1 report

Spec: `docs/superpowers/plans/2026-09-10-multi-game.md`. Scope: Round 1 only ("storage
only, behavior unchanged") — state shape, non-destructive migration, transitional
mirror, repointed mutators. Route/dashboard/cloud/realtime (Round 2) untouched.

Commits (this branch, on top of `main` — already up to date, no merge was needed):

1. `0bdc31c` feat: state.games durable store with non-destructive migration + mirror
2. `b6e5e04` test: multi-game migration, mirror-consistency and staleness-guard coverage

Baseline was 633 passing. Both commits together: **643 passing, 0 failing**
(`node --test tests/*.test.cjs`). `git diff --check` clean. The final `<script>` body
parses with `new Function`. `python3 build.py` was not run; `index.html`/`sw.js` are
untouched.

## What changed

`kupa-sgura.html`:

- **`state.games: OpenGameSlot[]`** — the new durable store. Typedef and rationale live
  as a comment block right before `currentGameSlot`, in the existing "group aggregate
  adapters (pure)" section, next to `hasOpenPhase`/`isGameOpen`/`newCurrentGame` (per the
  plan's own suggested placement).
- **`normalize()`** now normalizes `state.games` (via `migrateGamesArray` →
  `normalizeGameSlot` → the extracted `normalizeGamePlayers`, reused from the main
  `players` field) and finishes by calling `syncCurrentGameMirror(normalized)`.
- **`save()`** calls `syncCurrentGameMirror(state)` before persisting.
- **`newCurrentGame`** now also drops the replaced game's own entry from `state.games`
  before returning (needed because the settings "איפוס" reset button, and `markReal()`,
  can fire on a real open game — the game-list array must not leak an orphaned slot no
  `gameId` points to any more).
- **`finishCloseTable`** gained one line: `state.games` is filtered to drop the closing
  game's own slot, using the OLD `gameId`, *before* `state.gameId` is reassigned to a
  fresh placeholder. Every existing regex-checked line in this function (the `state.groupId
  = null;` / `leaderRef` / `startedAt` / `players` / `phase` resets, `openGroup(closedGroupId)`,
  `setAppView("games")`, `confetti()`) is unchanged.

`tests/entry-log.test.cjs`: one test's `save()`-executing slice now also loads
`groupsPureSource` (same precedent the file already sets for `normalize()`'s own tests),
since `save()` now calls `syncCurrentGameMirror`, defined there.

`tests/multi-game-migration.test.cjs` (new, 10 tests): migration (4 shapes + idempotency
+ a forward-compatible multi-slot document), the two repointed mutators exercised against
their real source, `syncCurrentGameMirror` driven through a full
active → settlement → closed lifecycle next to an unrelated slot, and the staleness
guard.

## Migration cases covered

Legacy single-slot document → `state.games`, non-destructively:

| Case | Result |
| --- | --- |
| open, `phase: "active"` | one-entry `games`, slot matches every singular field (groupId/startedAt/leaderRef/players) |
| open, `phase: "settlement"` with toggled `settlementStatuses` | one-entry `games`, `settlementStatuses` preserved verbatim (the plan's §8 risk #2) |
| empty (`phase: "active"`, 0 players) | `games: []` — never a phantom slot; singular `phase` itself is untouched (unaffected, matches today's behavior since every real consumer already gates on `isGameOpen`, not `phase` alone) |
| closed | `games: []` |
| already-migrated document, re-normalized | identical output (idempotent) |
| already-migrated document carrying an *unrelated* slot | that slot survives untouched; only the current gameId's entry is reconciled |

## How the staleness guard works

`tests/multi-game-migration.test.cjs`'s last test greps the whole script for every
direct assignment to a mirrored singular field
(`state\.(players|phase|groupId|startedAt|leaderRef|settlementStatuses)\s*=`), finds
each match's enclosing top-level `function name() { ... }` block (same
brace-convention every `sourceBetween`-based test in this suite already relies on),
and asserts that block's body contains `save()` *after* the assignment's own offset.
A sanity floor (`checked >= 9`) guards against the regex itself silently matching
nothing. Today's known writers — `finishGame`, `returnToGameEdit`, `finishCloseTable`
(6 fields) and `addPlayerToTable` — account for exactly 9 matches. A future edit that
adds a new direct write outside a `save()`-ending function, or that stops calling
`save()` after an existing one, fails this test.

## Deviation from the plan, and why

The plan's pseudocode has `syncCurrentGameMirror` copy **from** `state.games` **onto**
the singular fields (`state.players = slot.players`, etc.) — i.e. games is authoritative,
singular fields are a read-only view. I implemented the **reverse** direction: the
singular fields stay exactly what every existing mutator already writes directly, and
`syncCurrentGameMirror` derives/reconciles `state.games` **from** them, gated by the same
`isGameOpen` predicate every other check in this file already trusts.

Why: the existing 633-test baseline pins down, by direct execution (not just regex),
that `finishGame`, `returnToGameEdit`, `finishCloseTable`, and `addPlayerToTable` write
`state.phase`/`state.players`/etc. **directly**, several of them tested by loading only
that one function's source (no `games`-array machinery in scope at all — e.g.
`games-navigation.test.cjs` executes `finishGame()`/`returnToGameEdit()` with a
hand-built `state` and a stub `save()`). Rewriting those mutators to write through a
slot object first (the plan's literal design) would have meant either touching every
one of those tests — far beyond the "no more than 12 new tests, existing tests pass
unmodified unless justified" budget — or accepting a design that's demonstrably
incompatible with "keep single-slot behaviour observable exactly as today." The
reverse-direction mirror achieves the identical end state (a `games` array that is
never stale, verified by the guard test) while requiring zero changes to
`finishGame`/`returnToGameEdit`/`confirmBuyin`/`addPlayerToTable`/exit/undo, and exactly
two one-line additions to `newCurrentGame` and `finishCloseTable` (both because they
change *which* `gameId` is current, which nothing else in Round 1 does).

One existing test (`tests/entry-log.test.cjs`) needed a one-line fix (load
`groupsPureSource` for its `save()`-slice test) — not a behavior change, purely a test
harness dependency, following the exact precedent the same file already set for
`normalize()`.

I did not introduce `openNewGameSlot`/`buildGameSlot` (the plan's suggested rename of
`newCurrentGame`) — `newCurrentGame`'s literal name and call-site shape
(`newCurrentGame(state, { phase: "closed" })` etc.) is asserted verbatim by
`games-navigation.test.cjs`, `group-game-close.test.cjs`, and `group-game-start.test.cjs`.
Renaming it would have forced unrelated churn across those files for no functional gain
in Round 1 (Round 2 is a fine time to rename, once the mutators actually move onto
`state.games` as their write target).

## What Round 2 must still do

Per the plan §7, unstarted:

- **Route** (Commit 3): `currentGameId`, boot-resume decision for N open games (the plan
  recommends "exactly one open game resumes into it, N>1 resumes to the dashboard" —
  still needs explicit owner sign-off per the plan's §8 risk #5), re-point
  `enterActiveGame`/`continueCurrentGame`/back-arrow/`getGroupSummary.hasActiveGame` at
  `state.games` list membership. **This is also where the mirror direction should be
  revisited**: once mutators are repointed to address a specific `currentGameId`'s slot
  directly, the plan's original games→singular direction becomes the natural one, and
  the singular fields/mirror can be deleted per the plan's design.
- **Dashboard** (Commit 4): `getActiveGameSummaries` takes the whole list, drop
  `renderGroupPrimaryAction`'s `[0]` index (§8 risk #3 — audit every
  `getActiveGameSummaries(` call site, not just the two the plan found), `canStartGroupGame`
  drops its `another-game-open` branch.
- **Cloud** (Commit 5): `cloudCollections()` maps over `state.games`, `pickCloudOpenGame`
  → `mergeOpenGames`, `applyCloudPull` folds every server-open game in. Not started —
  `remoteBody()`/`cloudCollections()`/`pullCloud`/`pushCloud` are all untouched by Round 1
  on purpose.
- **Realtime** (Commit 6): per-game channel map + connection cap/fallback (§5). The
  plan flags Supabase's `in`-filter support as unverified — worth 15 minutes of doc
  checking before that commit.
- §8 risk #6 (invite redemption / account-deletion succession interacting with multiple
  open games) is still unverified — the plan itself says it did not read
  `delete-account.sql`/the friend-invite code paths for this question.

## Is this branch safe to merge as-is?

**Yes.** It is a pure no-op from the user's perspective: every existing test passes
unmodified in behavior (one test's *harness* needed a dependency fix, not a behavior
change), the single-slot UX is byte-for-byte what it was before (no mutator's
user-visible behavior changed), and `state.games` is additive, silently ignored by
every unmigrated code path exactly as the plan's rollback-safety argument (§1) requires.
The one thing worth flagging to the owner explicitly: the mirror direction deviates from
the plan's literal pseudocode (see above) — technically sound and test-proven, but a
design choice Round 2's author should read before deciding whether to keep it or flip it
when the mutators are repointed at `currentGameId`.
