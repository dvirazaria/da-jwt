# Removing the single-active-game limit

Status: planning only. No application code changed by this document. Written against
`kupa-sgura.html` at the commit this worktree branched from (`HANDOFF.md` release 43,
`docs/superpowers/plans/2026-09-08-*` already landed).

## 0. The constraint, precisely

`state` holds exactly one game slot inline: `gameId`, `phase`, `players`, `groupId`,
`startedAt`, `leaderRef`, `settlementStatuses`. Every reader of "the current game" —
`isGameOpen(currentGame)` (line 3034), `getActiveGameSummaries(gameState, groups)` (line 5233),
`collectionsOf(state).currentGame` (line 5214), `cloudCollections()`'s
`gameSnapshotFromState(state)` (line 1823), `syncCloudGameChannel()` (line 2345) — takes that
inline shape as its single game, not an id into a collection.

Cloud already stores many open games (one per group; `games_one_open_per_group_uk` in
`docs/backend/schema.sql:217-218` is a **per-group**, not per-device, unique index). The
device-side ceiling is `pickCloudOpenGame` (line 4239): given several `openGames` from the
server, if the local slot is already a different open game it returns `{action: "keep"}` and
`applyCloudPull` (line 2281-2286) just `console.warn`s that a second table is waiting. That is
the whole limitation, in one function.

## 1. The state shape

### Proposal: keep `state.games: OpenGameSlot[]`, drop nothing yet

```js
/**
 * @typedef {Object} OpenGameSlot
 * @property {string} gameId
 * @property {"active"|"settlement"} phase   // closed games never live here — they move to history
 * @property {Player[]} players
 * @property {string|null} groupId
 * @property {string|null} startedAt
 * @property {ParticipantRef|null} leaderRef
 * @property {Object} settlementStatuses
 */
```

`state.games` is an array of `OpenGameSlot`. The top-level singular fields
(`state.gameId/phase/players/groupId/startedAt/leaderRef/settlementStatuses`) are **not removed
in this round** (see §7, Round 1 vs Round 2) — they become a *derived mirror* of
`state.games[currentIndex]`, kept in sync by a single new helper, so that every existing reader
that has not been migrated yet keeps working unmodified during the transition. This is the same
technique the codebase already uses for `collectionsOf(state)`: a thin adapter in front of the
real storage, not a second store forbidden by
`CLAUDE.md`'s "keep one source of truth" rule — `state.games` *is* the store; the singular
fields become a view over it for one release.

```js
// New pure helper, next to newCurrentGame (line 3058).
function currentGameSlot(state) {
  return (state.games || []).find(g => g.gameId === state.gameId) || null;
}
// Mirrors currentGameSlot back onto the flat fields old code reads. Called once at the end of
// every mutator that used to hand-edit state.players/phase/etc — same place `save()` is called,
// since every mutator already calls save() before returning.
function syncCurrentGameMirror(state) {
  const slot = currentGameSlot(state);
  state.players = slot ? slot.players : [];
  state.phase = slot ? slot.phase : "closed";
  state.groupId = slot ? slot.groupId : null;
  state.startedAt = slot ? slot.startedAt : null;
  state.leaderRef = slot ? slot.leaderRef : null;
  state.settlementStatuses = slot ? slot.settlementStatuses : {};
}
```

This buys Round 1 (§7) the ability to land `state.games` and the migration without touching
every renderer/mutator in the same commit — high-risk, low-value coupling avoided. Round 2
deletes the flat fields and the mirror, and switches every reader to `currentGameSlot`/
`state.games`. **I am not fully sure the mirror is cheaper than just doing the rename in one
pass** — `kupa-sgura.html` is 9144 lines and grep shows `state.players` alone is used in >80
places (buy-in, settlement, render, cloud mapping). The mirror avoids touching all 80 in Round 1,
but means Round 1 code must remember to call `syncCurrentGameMirror` after every `state.games`
mutation or the mirror silently goes stale. Flag this trade-off to whoever executes: if grep
shows most of those 80 sites are read-only (render functions), a single global "call
`syncCurrentGameMirror` at the very top of every render pass" is safe; if any mutate
`state.players` directly (not through `addEntry`/`exitPlayer`), the mirror breaks. **Audit this
before writing Round-1 code — do not assume.**

`normalize()` (line 1468) changes to normalize `state.games` (an array, each entry run through
something like the existing per-player mapping) instead of the singular fields, then calls
`syncCurrentGameMirror`. `save()` (line 1540) is otherwise untouched — it still just
`JSON.stringify(state)`s and schedules a push/remote-save.

`newCurrentGame(base, patch)` (line 3058) becomes `openNewGameSlot(base, patch)`: builds one
`OpenGameSlot`, pushes it onto `base.games`, and sets `base.gameId` to its id (so the mirror
picks it up). `finishCloseTable()` (line 7243) removes the closed slot from `state.games` by id
instead of zeroing the singular fields, and — this is the important behavior change — **does
not necessarily clear `state.gameId`**; it must pick a *different* remaining open slot (if any)
to become "current" for the mirror/route, or fall back to none.

### Migration (must be non-destructive, must never lose or double-count an open table)

```js
// Pseudocode: runs inside normalize(), replacing the old singular-field pass-through.
function migrateToGamesArray(s) {
  if (Array.isArray(s.games)) {
    // Already migrated (or synced from a device that already has this build). Trust it, but
    // still fold in a stray singular slot if one somehow differs (defensive — should not happen
    // once every write path is migrated, but a mid-rollout pull from an unmigrated device could
    // send both shapes in the same push if the frontend-seam is not updated first — see §4).
    if (s.gameId && !s.games.some(g => g.gameId === s.gameId) && hasOpenPhase(s)) {
      s.games = [...s.games, extractSingularSlot(s)];
    }
    return s.games;
  }
  // Old document: exactly one implicit slot. It is either open (active/settlement, non-example)
  // or it is not a game at all (isGameOpen's own rule) — never invent a slot for a closed/empty/
  // example document.
  if (isGameOpen(s)) return [extractSingularSlot(s)];
  return [];
}
function extractSingularSlot(s) {
  return {
    gameId: s.gameId, phase: s.phase, players: s.players || [], groupId: s.groupId || null,
    startedAt: s.startedAt || null, leaderRef: s.leaderRef || null,
    settlementStatuses: s.settlementStatuses || {},
  };
}
```

Why this is safe:
- **Never loses an in-progress table**: the only source of a slot pre-migration is the singular
  fields, and `isGameOpen` is the exact same predicate the rest of the app already uses to decide
  "is this a real game" — so a migrated document contains a slot if and only if the pre-migration
  app would have shown one.
- **Never double-counts**: a document is migrated once, on first `normalize()` after the update;
  from then on `Array.isArray(s.games)` is true and the old branch never runs again. The "fold in
  a stray singular slot" defensive branch only fires if `gameId` names a slot *not already in*
  `s.games` — it cannot duplicate an existing entry because it keys on `gameId`.
- **Cloud is authoritative for shape, but this migration is local-only.** A signed-in device's
  next `pullCloud()` after this ships will receive multiple `openGames` rows (line 2169) instead
  of the single one `pickCloudOpenGame` used to pick from — see §4 for how the merge changes. The
  local migration above only has to get a *pre-cloud, single-document* user (or an offline user)
  from the old shape to the new one without loss; cloud users get their multi-game state from the
  next pull regardless of what the local migration produced, because `mergeCloudIntoState`
  already treats the server as authoritative for anything it can see (line 2330,
  `keepLocalIds: cloudKeepLocalIds()`).

Rollback safety: this is additive (a new array field), so a document written by the new code and
read by the *old* code before every device is upgraded would show only whatever the mirror last
wrote to the singular fields, i.e. one game — degraded, not corrupted. That is an acceptable
mid-rollout state given this is a single-file client-side app deployed by pushing to `main`
(no staged rollout mechanism exists) — flag this as a real but small risk in §8.

## 2. The route

`appView` stays `friends | games | game | settle | profile | group` — DESIGN.md's contract that
"game/settle/group are contextual screens, not nav destinations" does not need to change; multiple
open games do not need multiple nav destinations, they need the *existing* contextual screens to
know *which* game.

Add a UI-only `currentGameId` (module-level `let`, next to the existing `currentGroupId` at
line ~5040 — same pattern, same rule: never persisted, reset on navigation away). Every place
that currently reads `state.gameId`/`state.phase` *for rendering the table/settle screen* switches
to reading `currentGameSlot(state, currentGameId)` (a small overload, or a second helper
`gameSlotById(state, id)`).

- **Selecting the current game**: `enterActiveGame(gameId)` (line 5587) already takes a
  `gameId` argument and currently asserts it against the single `state.gameId` — change its body
  to `currentGameId = gameId; setAppView(gameSlotPhase === "settlement" ? "settle" : "game")`.
  `continueCurrentGame()` (line 5032) and `openGroup`'s "יש משחק פתוח" affordances
  (`renderGroupPrimaryAction`, line 5704) both resolve "the group's open game" via
  `getGroupSummary.hasActiveGame`/`activeGamePhase` (line 2988-2999) — those already filter by
  `currentGame.groupId === groupId`; once `currentGame` in `collectionsOf` (line 5214) is *a list*
  instead of one object, that check becomes `state.games.find(g => g.groupId === groupId)` and
  the rest of `getGroupSummary` is unchanged (it only reads `hasActiveGame`/`activeGamePhase` off
  the result, both of which stay booleans/strings per group).
- **Boot resume with two-plus open games**: `initialAppView(gameState)` (line 1407) currently
  picks `game` or `settle` if the *one* slot is open. With N open slots there is no longer a
  single "the" open game to resume into. Proposal: boot always resumes to `games` (the dashboard)
  when `state.games.length > 0`, never straight into a table — the dashboard already lists every
  open game via `getActiveGameSummaries` (see §3) with an enter action per card. This is a
  **user-visible behavior change** from today's "refresh drops you straight into your one open
  table" — flag it explicitly to the owner, it is the most defensible default (no game is
  arbitrarily privileged) but it is a real UX change, not a pure implementation detail. If exactly
  one game is open, resuming straight into it (today's behavior) is arguably still correct and
  removes the regression entirely for the common case — recommend: `state.games.length === 1 ?
  resume into it : "games"`. State this choice explicitly in the commit description (§7 Commit 3)
  so it is a decision, not an accident.
- **Back arrow**: `.table-header`'s back arrow (DESIGN.md "כותרת חזרה") already routes to the
  game's own group (`openGroup(state.groupId)`) or to `games` for an ad-hoc game — that logic is
  per-game already (it reads the *current* game's `groupId`), so once "the current game" is
  `currentGameId`-addressed instead of singular, the back arrow needs no behavior change, only to
  read `groupId` off the addressed slot instead of `state.groupId`.

## 3. The dashboard

`getActiveGameSummaries(gameState, groups)` (line 5233) today: guards on `isGameOpen(gameState)`
(singular), then returns a one-element array built from that single slot — it is already
list-*shaped* (`return [{...}]`), just fed a single game. Every caller (`renderGamesDashboard`
line 5607, `renderGroupPrimaryAction` line 5711) already iterates/indexes it as a list.

Change: `getActiveGameSummaries(gamesList, groups)` takes `state.games` (the whole array) and maps
each open slot to one summary object — same per-summary shape (`gameId, title, phase,
playerCount, playerNames, players, potSize, totalEntries, startedAt, updatedAt`), just N of them
instead of 0-or-1. `isGameOpen` is applied per-slot inside the `.map`/`.filter` instead of once at
the top. No new component language: `renderActiveGamesSection` (line 5451) already renders
`summaries.map(renderActiveGameCard)` — with N summaries it now renders N cards, stacked, exactly
per DESIGN.md's "בלוח המשחקים, כרטיס קבוצה... שורת ראש לחיצה" pattern already used for the group
list. This is the one place where "what does several open tables look like" is *already* answered
by the existing empty-state-aside behavior of that section — nothing to invent.

`renderGroupPrimaryAction`'s `getActiveGameSummaries(state, state.groups)[0]` (line 5711) must
become `getActiveGameSummaries(state.games, state.groups).find(s => s.gameId ===
group'sOpenGameId)` — a single-index lookup is no longer correct once there can be more than one
summary in the array, even though today, with one group open at a time by construction, `[0]`
happened to be right.

`canStartGroupGame(collections, groupId)` (line 3045): the "another-game-open" branch
(`isOpen && currentGame.groupId !== groupId` → refuse) is the *device-level* single-slot rule and
is the one behavior this whole plan removes. Once removed, starting a group's game only needs to
check "does *this* group already have an open game" (`group-has-open-game`) — the
`another-game-open` reason and its whole branch, and the DESIGN.md line "משחק ללא קבוצה" being
`disabled` while *any other* game is open, both go away. `startUngroupedGame()` (line 4996-5003)
drops its `if (isGameOpen(state)) return;` guard the same way.

## 4. Cloud sync

### Pull (`pullCloud` / `applyCloudPull`, lines 2138-2340)

`pullCloud` already fetches **every** open game the RLS policy lets this account see
(`openGames = allGames.filter(phase !== "closed")`, line 2169) and their children in bulk — no
query changes needed here at all; the limitation is entirely in what `applyCloudPull` *does* with
`openCandidates` after mapping them (line 4204's `buildOpenGameFromCloud`, one call per candidate,
already works per-game).

Replace `pickCloudOpenGame(localGame, openGames)` (single winner) with a merge that keeps every
server-open game that is not already closed-here, plus every local-only game (unsynced or with a
`legacy-` id) that the server does not know about yet:

```js
// Pseudocode replacing pickCloudOpenGame + the single "picked.game" branch in applyCloudPull.
function mergeOpenGames(localGames, serverOpenGames, closedHereIds) {
  const serverById = new Map(serverOpenGames.map(g => [g.gameId, g]));
  const merged = [];
  // Server truth wins for any game both sides know: the mapped-from-cloud shape replaces the
  // stale local one (same "server wins once confirmed" rule pullCloud already uses elsewhere).
  for (const g of serverOpenGames) if (!closedHereIds.has(g.gameId)) merged.push(g);
  // Local-only games: not on the server's open list, not one we already closed and are waiting to
  // confirm — i.e. this device has not pushed it yet (legacy id, or created since the last push).
  for (const g of localGames) {
    if (serverById.has(g.gameId)) continue;
    if (closedHereIds.has(g.gameId)) continue;
    merged.push(g);
  }
  return merged;
}
```

This is the direct multi-game generalization of the existing rule at line 4239's comment ("An
empty, closed or example slot takes the server's game, the same game replaces itself, and a
DIFFERENT open game on this device wins") — except now there is no "different game wins and the
other waits"; both simply coexist, because both *can* coexist in `state.games`. The
`console.warn` at line 2285 and its whole justification disappear — that is the point of this
plan.

The realtime/local-edit parking guard (line 2256, `active.tagName === "INPUT" || cloudPushTimer
|| ... `) is unaffected — it already parks the *whole* pull, and re-scheduling it 800ms later
(line 2257) is correct regardless of how many games are in the payload.

### Push (`pushCloud` / `pushCloudRun`, lines 1959-2106) — **do not disturb the insert/update
split**

`cloudCollections()` (line 1821) is the only function that needs to change on the push side, and
only in how it gathers "the open game(s)":

```js
// Before: one open game from the singular slot.
//   const open = gameSnapshotFromState(state); if (open) games.push(open);
// After: one snapshot per entry in state.games.
function cloudCollections() {
  const games = [];
  (state.games || []).forEach(slot => {
    const snap = gameSnapshotFromState(slot); // gameSnapshotFromState already takes a game-shaped
    if (snap) games.push(snap);                // object (line 4111) — no signature change needed
  });
  const known = cloudKnownGameIds();
  (state.history || []).forEach(entry => {
    if (entry && known.has(String(entry.gameId))) games.push(gameSnapshotFromHistory(entry));
  });
  return { /* groups/groupMembers/invites/friendships/games/debts, unchanged shape */ };
}
```

Everything downstream of `cloudCollections()` — `buildCloudRows` (line 4471), the whole
`CLOUD_TABLES` loop in `pushCloudRun` (lines 1986-2056), the `CLOUD_INSERT_ONLY` set, the
`splitCloudWrites`/insert-vs-update branch (lines 2012-2045) — is **already per-row, keyed by
row id, with no assumption of "exactly one games row in flight."** `diffCollections(previous,
next, "id")` (line 4560, called at 1991) diffs whatever rows `buildCloudRows` produced against
`lastPushedRows`; it does not care whether those rows came from one game or five. This is exactly
why the plan does **not** touch that split: the comment at line 1743-1747 explicitly warns that
moving `games`/`gameParticipants` into `CLOUD_INSERT_ONLY` "reopen[s] the exact 42501-on-first-
write bug commit 9eafade fixed" (documented in `.superpowers/rls-upsert-reconcile-report.md`) —
nothing in this plan asks for that; the only change is upstream, in how many game snapshots
`cloudCollections()` hands to the unchanged pipeline.

`games_one_open_per_group_uk` (schema.sql:217-218) already enforces "one open game per group" at
the DB level — pushing two open games for the *same* group would already fail with a unique
violation today if it somehow happened, and nothing in this plan tries to allow that (§3's
`canStartGroupGame` still refuses `group-has-open-game`). Two open games for *different* groups,
or one ad-hoc (`group_id NULL`, unconstrained) plus any number of group games, both push cleanly
under the existing constraint with no schema change required.

### A second device opens a third table

No special-casing needed: device A has games X (group 1) and Y (group 2) open; device B, signed
into the same account but not currently showing either, opens Z (group 3, or ad-hoc). B's push
inserts Z as an open game row (same shell/insert-only-until-confirmed path already handles a brand
new row). A's next pull (`visibilitychange`, or the realtime channel below) sees Z in
`openGames` and, by the `mergeOpenGames` rule above, adds it to `state.games` alongside X and Y —
A now shows three open games on its dashboard. Nothing but the merge function change from this
section makes that happen.

### The outbox (`state.cloudPendingIds`) — unchanged

`markPendingIds`/`clearPendingIds`/`cloudOutboxSignal` (referenced around lines 1868-1884) already
operate over the flattened row-id set across every collection in `cloudCollections()` — they do
not know or care how many `games` rows are in that set at any moment. No change.

## 5. Realtime

**Recommendation: keep one channel per open game, but cap concurrent channels and fall back to
polling/pull-on-visibility beyond the cap — do not multiplex into one channel.**

Reasoning:
- `syncCloudGameChannel()` (line 2345) already subscribes to three `postgres_changes` filters
  (`games`, `game_participants`, `entries`, each `id`/`game_id = eq.<id>`) on one channel per
  game. Generalizing to N games is mechanically "one `supabase.channel("game:" + id)` per entry in
  `state.games`, torn down when that entry's game closes or leaves `state.games`" — a
  `Map<gameId, RealtimeChannel>` instead of the two module-level `cloudGameChannel`/
  `cloudGameChannelId` variables, with a matching `leaveCloudGameChannel(id)` per entry instead of
  the current all-or-nothing teardown.
- **Supabase free tier**: 200 concurrent Realtime connections *per project*, shared across every
  user of the app, not per-user. A single user with 3 open games already opens 3 channels *from
  one browser tab* under the naive per-game design — multiply by concurrent users and this is the
  actual scaling risk, not the per-game vs. multiplexed question. A single multiplexed channel
  (`supabase.channel("games:" + userId)` filtering, if the provider supports it, on an `in`-style
  filter across the games this account cares about) reduces per-user connection count from N to 1,
  which is the right lever if 200 connections is ever the binding constraint — but Supabase
  Realtime's `postgres_changes` filter is a single `column=eq.value` expression (confirmed by
  every existing filter in this file being `id=eq.<id>` or `game_id=eq.<id>`); there is no
  documented `in (...)` filter as of this codebase's pinned `@supabase/supabase-js@2` client, so a
  true single multiplexed channel per user would need either (a) one channel per game anyway
  (functionally the same connection count, no savings) or (b) subscribing to the whole `games`
  table with client-side filtering, which defeats RLS-scoped realtime and pulls every other
  group's game events into every client. **I could not verify Supabase's current `in` filter
  support from this repo alone** — worth 15 minutes of doc-checking before Round 3 (§7) rather
  than assuming either way.
- Given that uncertainty, the cheap, safe default for this app's actual scale (a home-game app,
  not a platform with thousands of concurrent players) is: keep the existing one-channel-per-game
  pattern, but add a small hard cap (e.g. 4 concurrent game channels per device) — past the cap,
  additional open games fall back to the existing `visibilitychange`-triggered `pullCloud()` (line
  2138 is already called there) instead of a live channel. A user with 3 open groups' games at
  once is a realistic edge case for this app (documented in the task: "two groups playing on the
  same night"); a user with 20 is not, and does not deserve engineering effort here.

## 6. What must not regress

| Rule | Where it lives today | Why this plan does not touch it |
| --- | --- | --- |
| Settlement is integer arithmetic; normal close only at zero | `totals()`/`settle()`, read by `finishCloseTable()` (line 7243-7278) | Operates on `state.players` at close time, which after §1 is still whatever `syncCurrentGameMirror` (Round 1) or `currentGameSlot(state, currentGameId).players` (Round 2) resolves to for *the game being closed* — the function body never changes, only which slot feeds it. |
| Unbalanced close keeps the 1s hold, records `isBalanced`/`balanceDifference` | `closeTableBtn` pointer handlers (lines 7281-7326), `buildHistoryEntry` | Per-game already (`t.diff` is computed from the addressed game's players); untouched. `state.games` removing the closed slot happens *after* `buildHistoryEntry` runs, same order as today. |
| Payment toggles reversible while open | `state.settlementStatuses` on the current slot | Moves from `state.settlementStatuses` (singular) to `slot.settlementStatuses` (per-game) — same reversibility, same object shape, just one per open game instead of one per device. This is required anyway: two open games must not share one settlement-status map. |
| Debts created only for unpaid transfers at close; only creditor marks paid | `buildDebtRecords`, `debts_update_creditor` RLS, both game-id-scoped already | `debts.game_id` (schema.sql:340) already scopes every debt to the game that produced it — no change; multiple simultaneously-open games producing debts on separate closes is exactly what the schema already models (`games_one_open_per_group_uk` is per-group, debts have no analogous per-device constraint to begin with). |
| `סיים משחק` / `חזור לעריכת המשחק` — hold gesture, phase-only transition | `beginFinishGameHold`/`returnToGameEdit` handlers | Must be re-pointed at `currentGameId`'s slot instead of the singular `state.phase` — this is a real code change (§7 Round 2), but the *gesture and guarantee* ("changes only phase") do not change; the risk is purely "did every handler get re-pointed," covered by existing tests re-run per-slot (§7 test list). |
| Claimed-only-creditor / immutable-closed-game invariants server-side | `docs/backend/schema.sql` §7 triggers, RLS | Entirely untouched — this plan does not modify schema.sql or rls-policies.sql, and does not need to: those triggers are already keyed by `game_id`, not by "the one open game." |

The one genuinely new regression surface: **cross-game bleed if `currentGameId`/mirror sync is
wrong** — e.g. a buy-in typed while `currentGameId` is stale writes to the wrong slot's
`players`. This is the reason §1 flags the mirror-staleness risk explicitly and §8 lists it as
the top risk.

## 7. Staging — this should not be one round

Recommend **three commits across two rounds**, each shippable to `main` on its own (per
`CLAUDE.md`'s release process — build + test + commit + push after each verified round):

**Round 1 — storage only, behavior unchanged**
- *Commit 1*: Add `state.games`, `migrateToGamesArray`, `currentGameSlot`,
  `syncCurrentGameMirror`. `normalize()` calls the migration and the mirror. No mutator, renderer,
  or cloud function changes yet — `state.games` is written and kept in sync but nothing reads it
  except the migration's own defensive fold-in check. Ships a no-op from the user's perspective.
  - Tests to add: `tests/multi-game-migration.test.cjs` —
    `"legacy document with one open active game migrates to a one-entry games array"`,
    `"legacy document with an empty/example slot migrates to an empty games array"`,
    `"a document already carrying state.games is left alone"`,
    `"the mirror keeps state.players/phase in sync with the current slot after normalize"`,
    `"migrating twice (idempotency) does not duplicate the slot"`.

**Round 1 — commit 2**: Point every *mutator* that currently hand-edits `state.players` /
`state.phase` / etc. (buy-in, rebuy, exit, undo, `startUngroupedGame`, `startGroupGame`,
`finishCloseTable`, the hold/settlement handlers) at `state.games` directly, calling
`syncCurrentGameMirror` at the end of each (or centralizing that call inside `save()`, which is
simpler and touches one place instead of a dozen — **recommend doing it inside `save()`** since
every mutator already ends by calling `save()`). Renderers still read the singular mirror fields,
unchanged. This is the commit that actually needs the "audit whether any code writes
`state.players` outside the known mutators" pass flagged in §1.
  - Tests: re-run every existing test file that touches buy-ins/exit/settlement/close
    (`entry-log.test.cjs`, `group-game-close.test.cjs`, `group-game-start.test.cjs`,
    `dashboard-integration.test.cjs`, `e2e-state.test.cjs`) unmodified — they must still pass
    exactly as today, because behavior has not changed, only storage. Any failure here means the
    mirror is wrong, not that a test needs updating.

**Round 2 — the actual feature (route + dashboard + cloud + realtime), one commit per concern
so a bad one can be reverted independently:**
- *Commit 3*: Route — `currentGameId`, `initialAppView` boot-resume rule (the one-open-game vs.
  N-open-games decision from §2 — **state the decision in the commit message explicitly**),
  re-point `enterActiveGame`/`continueCurrentGame`/back-arrow/`getGroupSummary.hasActiveGame` at
  `state.games` list membership instead of the singular slot. Delete the mirror and singular
  fields from `normalize()`/`save()`/every renderer in this same commit (Round 2 is where the
  mirror gets removed, per §1).
  - Tests: `tests/multi-game-route.test.cjs` — `"boot with two open games resumes to the
    dashboard, not either table"` (or the single-game exception, per the decision made),
    `"enterActiveGame switches currentGameId to the tapped game"`, `"the back arrow from a game
    returns to that game's own group, not the other open game's group"`, `"a group with an open
    game reports hasActiveGame even when a different group's game is also open"`.
- *Commit 4*: Dashboard — `getActiveGameSummaries` takes the list, `renderActiveGamesSection`
  renders N cards (already list-capable, per §3 — mostly a signature change plus removing the
  `[0]` index in `renderGroupPrimaryAction`), `canStartGroupGame` drops `another-game-open`.
  - Tests: extend `dashboard-integration.test.cjs` and `group-game-start.test.cjs` —
    `"two different groups can each have an open game at once"`,
    `"starting group B's game while group A's game is open no longer blocks on another-game-open"`,
    `"an ungrouped game and a group game can be open simultaneously"`,
    `"the dashboard lists every open game, not just one"`.
- *Commit 5*: Cloud push/pull — `cloudCollections()` maps over `state.games`, `pickCloudOpenGame`
  replaced by `mergeOpenGames`, `applyCloudPull` folds every server-open game in instead of
  picking one.
  - Tests: extend `tests/cloud-games.test.cjs` — `"pullCloud merges two server-open games into
    state.games instead of keeping only the local one"`, `"a game this device closed locally is
    never resurrected by a pull even when other games are also open"`, `"pushCloud sends every
    open game's rows, not just the first"`. Also re-run `tests/cloud-upsert.test.cjs` and
    `tests/cloud-race.test.cjs` unmodified — the insert/update split under test there must still
    pass with zero changes, confirming Commit 5 did not touch it.
- *Commit 6*: Realtime — per-game channel map + the connection cap/fallback from §5.
  - Tests: this is the one area hard to unit-test meaningfully without a live Supabase socket
    (existing realtime code has no dedicated test file today either — `cloud-games.test.cjs`
    tests the pure mapping functions, not the channel lifecycle). Recommend a light
    `tests/multi-game-realtime.test.cjs` covering only the pure parts: the channel-map add/remove
    bookkeeping (given a games list, which channel ids should exist) and the cap/fallback
    decision function, stubbing `supabase.channel` the same way other tests stub `supabase`
    (see `tests/backend-config.test.cjs` for the existing stubbing pattern) — **manual QA against
    a real Supabase project for the actual subscribe/unsubscribe behavior remains necessary**,
    same as it presumably was for the original single-game realtime code.

Between Round 1 and Round 2, and between each Round-2 commit, `main` is shippable: Round 1 is a
pure no-op from the user's perspective (safe to ship and sit on), and each Round-2 commit adds one
slice of the new behavior without depending on unshipped later commits (Commit 3 works with
`state.games` capped at effectively one entry by the UI until Commit 4 removes the cap; Commit 5
works whether or not Commit 6's realtime cap exists, since `pullCloud`-on-visibility already
covers the gap).

## 8. The honest risk list

1. **Mirror staleness (§1, §6) — highest risk.** If any code path mutates `state.players`/
   `state.phase` directly without going through a mutator that calls `save()` (which is where
   `syncCurrentGameMirror` is recommended to live), the mirror silently diverges from
   `state.games`, and a render could show stale data for one game while writing to another.
   **Cheapest way to find out early**: before writing Round 1 Commit 2, `grep -n
   "state\.players\s*=" kupa-sgura.html` and `grep -n "state\.phase\s*="` and manually check every
   hit is inside a function that ends in `save()`. This is a 10-minute check that either confirms
   the plan is safe or surfaces the exact sites that need special handling — do it before writing
   code, not after a bug report.
2. **`state.settlementStatuses` per-slot migration losing an in-flight toggle.** A game
   mid-settlement at the moment of the Round 1 migration has its `settlementStatuses` moved from
   the singular field into its slot — if the migration pseudocode in §1 has an off-by-one (reads
   `s.settlementStatuses` after some other normalize step already reset it), a user's already-
   toggled "paid" marks could reset. Mitigation: the migration test list in §7 Commit 1 explicitly
   includes a settlement-phase-with-toggled-payments fixture, not just an active-phase one — make
   sure whoever writes the tests does not only test the active-phase case, since that is the
   "obvious" one and the settlement-phase case is where the actual risk is.
3. **`renderGroupPrimaryAction`'s `[0]` index (§3) is a landmine already living in the code, not
   introduced by this plan** — it works today only because there is never more than one summary.
   The moment `getActiveGameSummaries` returns more than one entry (Commit 4), any *other* caller
   that was quietly relying on "there's only ever one" the same way will break silently instead of
   throwing. **Cheapest way to find out early**: `grep -n "getActiveGameSummaries("` before
   Commit 4 and check every call site's use of the result, not just the two already found in this
   plan (line 5607, 5711) — there may be a third the initial read missed, since this plan's own
   read was not exhaustive.
4. **Supabase Realtime connection cost at scale is genuinely unverified (§5).** Low likelihood of
   mattering for this app's real user count, but if the owner ever opens this to more concurrent
   groups than expected, the per-game-channel design could hit the 200-connection ceiling faster
   than a multiplexed design would. Cheapest way to find out early: instrument
   (`console.debug`/a dev-only counter) how many channels a single active user's session actually
   opens in practice once Commit 6 ships, rather than trying to model it in advance.
5. **Boot-resume UX decision (§2) is a product call disguised as an implementation detail.**
   Whoever executes Commit 3 must not silently pick "always resume to dashboard" or "resume into
   the sole open game if there's exactly one" without the owner explicitly signing off — it is a
   visible behavior change either way. Flag it as a question in the PR description, do not bury
   it in a code comment.
6. **This plan does not cover `?join=` invite redemption, friend-invite flows, or account
   deletion's succession logic (`pickAccountDeletionSuccessor`) interacting with multiple
   simultaneously-open games** — a brief check suggests none of them read the singular game slot
   at all (account deletion touches `group_members`/`entries`/`debts` per-game already, per
   HANDOFF.md's description), but this plan has **not verified that claim by reading
   `delete-account.sql` or the friend-invite code paths**, since they were out of scope for the
   files the task asked to read. Flag this explicitly rather than asserting it is fine.

## Sources read

`CLAUDE.md`, `HANDOFF.md` (full), `DESIGN.md` (full), `docs/backend/schema.sql` (full),
`kupa-sgura.html`: `normalize`/`save`/`load` (1402-1548), the document-sync section (1550-1660),
`CLOUD_TABLES`/cloud constants (1730-1849), `pushCloud`/`pushCloudRun`/`pushCloudGameDeletes`
(1959-2136), `pullCloud`/`applyCloudPull`/realtime channel setup (2138-2360), the groups-domain
pure section including `isGameOpen`/`isEmptyOpenGame`/`canStartGroupGame`/`newCurrentGame`
(3020-3090), `getGroupSummary` (2978-3010), `cloudGameOpenShell`/`gameSnapshotFromState`/
`buildOpenGameFromCloud`/`pickCloudOpenGame`/`shouldApplyIncomingGame`/`buildCloudRows`
(3937-4560ish), `setAppView`/`startUngroupedGame`/`startGroupGame`/`continueCurrentGame`/
`openGroup`/`collectionsOf`/`getActiveGameSummaries` (4933-5260), the dashboard renderers
(5400-5720), `finishCloseTable` and its button handlers (7243-7326).
