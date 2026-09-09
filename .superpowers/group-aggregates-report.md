# Group leaderboard and history read safe aggregates, not raw rows

## What this closes

`docs/backend/player-boundary.sql` (F3) narrows `entries_select`/`game_participants_select` to
"participant of this game, or its creator", which stops a group member reading another player's
raw buy-ins/cashouts for a game they never played. Its own header says it must not ship alone:
`pullCloud()` has always built the group leaderboard and group history from those same raw rows
for every game in every group the caller belongs to, so applying it alone would make a member who
missed a night lose that night from the group's history, and shrink their leaderboard to only the
games they personally played. This change removes that trade so both can ship together.

## What each screen actually needs (established first)

- **Group leaderboard** (`LeaderboardEntry`): rank, identityKey, displayName, gamesPlayed, wins,
  isFormerMember — no money field, ever (Global Constraint 10; `buildLeaderboard`'s own comment).
- **Group history** (`GroupGameSummary`): gameId, at, startedAt, playerCount, playerNames,
  winnerNames, ranking (names only), durationMinutes, potSize, totalEntries, isBalanced — no
  per-player net or cashout (`toGroupGameSummary`'s own comment).
- A player's own detail, the table/settle screens, and `game_results_v`/`my_group_stats_v`
  (a member's own money) are untouched — they already read rows the viewer is a participant of,
  which player-boundary.sql's new policies still allow.

## Existing view vs. new view

`group_leaderboard_public_v` (schema.sql) was already written and granted, but the client never
queried it. It turns out to already survive player-boundary.sql with **no SQL change needed**:
`group_leaderboard_v` is `security_invoker = true`, but `group_leaderboard_public_v` — the thin
wrapper actually granted to `authenticated` — is not, so it runs with the view owner's privileges
for RLS purposes and is not narrowed by the new per-participant policies. No per-game summary of
that shape existed, so I added one: `docs/backend/group-summaries.sql` creates
`group_game_summaries_v` (date/player-count/winner-names/pot/balance-flag, no per-player net or
cashout — verified by a test that scans its final SELECT list), using the same "no
security_invoker" bypass, but re-checking group membership itself via the existing
`app_is_active_group_member(group_id)` SECURITY DEFINER helper rather than trusting caller RLS.
Both `REVOKE ALL ... FROM public` and `FROM anon` are applied before the `GRANT ... TO
authenticated`, and the file is a single `BEGIN`/`COMMIT` transaction. **Not run** — no SQL was
executed, per instructions.

## Client wiring

- `pullCloud()` fetches `group_leaderboard_public_v` and `group_game_summaries_v` alongside the
  existing queries; `groupAggregatesOk = !leaderboardResult.error && !gameSummariesResult.error`.
- `applyCloudPull` stores the result in a new module-level, in-memory-only cache
  `cloudGroupAggregates = { available, leaderboard, gameSummaries }` — same pattern as the
  existing `cloudGuestRows`: never part of `state`, never a new localStorage key, rebuilt every
  pull, reset on sign-in/sign-out.
- New pure adapters `groupLeaderboardFromAggregate`/`groupGameSummariesFromAggregate` map the
  snake_case aggregate rows onto the exact `LeaderboardEntry`/`GroupGameSummary` shapes.
  `resolveGroupLeaderboard(collections, groupId, aggregates)` and
  `resolveGroupGameSummaries(collections, groupId, aggregates)` pick the aggregate when
  `aggregates.available` is true, and otherwise fall back to the **unchanged**
  `buildLeaderboard`/`groupClosedGames(...).map(toGroupGameSummary)` local computation.
- `getGroupSummary` (and therefore `getGroupSummaries`/`getArchivedGroupSummaries`) now take an
  `aggregates` parameter and route `gameCount`/`lastGameAt`/`leaderNames` through the same two
  resolvers, so the dashboard's group cards get the same completeness as the group page.
- All five call sites (dashboard groups list, dashboard archived list, group preview overlay,
  full group page, and the group-page-leaders/history two lines) were updated to pass
  `cloudGroupAggregates` through.
- `buildLeaderboard` and `toGroupGameSummary` themselves are unchanged — they remain the exact
  fallback path and keep their own existing tests.

## Degraded-path behavior (aggregate unavailable — offline, or the migration not yet applied)

`cloudGroupAggregates.available` starts `false` and only ever flips `true` when a pull's *both*
aggregate queries return without error. Whenever it's `false`:
- **Group leaderboard** renders exactly what `buildLeaderboard` computes from local `history` —
  the same behavior as today, nothing new.
- **Group history** renders exactly what `groupClosedGames(...).map(toGroupGameSummary)` computes
  from local `history` — same as today.
- Once `player-boundary.sql` is live and the aggregates are *not* (a gap the task warns against
  shipping), a game the viewer did not play would be entirely missing from local `history` (per
  `cloudGameChildrenAreTrustworthy`, already shipped) and so would be silently omitted from both
  screens — never rendered as a zero-player row or a wrong pot, and never a false leaderboard
  entry. This is a real but disclosed reduction in completeness, identical in spirit to the one
  `player-boundary.sql`'s own header already accepts for the interval before this change ships —
  it is why the two files must ship in the same release (below).

## Tests

`tests/group-aggregates.test.cjs`, 11 offline tests (within the 8–12 budget): SQL structure
(BEGIN/COMMIT, no service_role/secret material, REVOKE-before-GRANT on `public` and `anon`, no
per-player money in the final projection, the view re-checking membership itself); the client
resolvers preferring the aggregate when available (including a case where the viewer's local
history is empty for that group, proving the aggregate needs none of the viewer's own raw rows)
and falling back to the exact local computation when not, with explicit assertions that an
aggregate-backed game summary never has `playerCount === 0` and never carries a `net`/`cashout`
field; the pull only trusting the cache when both queries succeeded; and every call site actually
wired to pass `cloudGroupAggregates` through.

Five existing tests were updated (not weakened) because the exact source strings they pinned
genuinely changed by this task's own design: `getGroupSummary`/`getGroupSummaries`/
`getArchivedGroupSummaries` gained the `aggregates`/`cloudGroupAggregates` argument, and
`renderGroupPage`/`renderGroupPreview` now call `resolveGroupLeaderboard`/
`resolveGroupGameSummaries` instead of `buildLeaderboard`/`toGroupGameSummary` directly. Each
updated assertion still pins the exact new wiring string, so a future accidental revert back to
the raw-row call would still fail the test.

## Verification

- `node --test tests/*.test.cjs` — 622 passing (611 baseline + 11 new), 0 failing.
- `git diff --check` — clean.
- Last `<script>` body in `kupa-sgura.html` parses with `new Function`.
- `build.py` was not run; `index.html`/`sw.js` untouched; `player-boundary.sql` untouched (its
  "DO NOT RUN THIS YET" header is intact).

## Is player-boundary.sql now safe to apply?

**Yes, together with this change, in this order:**

1. Apply `docs/backend/group-summaries.sql` (creates `group_game_summaries_v`, revoked from
   `public`/`anon`, granted to `authenticated`). Independent of `player-boundary.sql` — safe on
   its own; it only adds a new safe aggregate.
2. Apply `docs/backend/player-boundary.sql` (narrows `entries_select`/`game_participants_select`).
3. Deploy this `kupa-sgura.html` change (already routes group screens through the two safe
   aggregates, with the local fallback covering any window between steps 1–3, or a client that
   hasn't updated yet).

Deploying the SQL from steps 1–2 without this client change would still be safe from a leak
standpoint but would visibly shrink group history/leaderboard for members who miss games, exactly
as `player-boundary.sql`'s own header warns — so, as it already says, ship the SQL and this
frontend change in the same release.
