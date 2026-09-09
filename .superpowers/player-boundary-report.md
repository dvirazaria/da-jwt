# F3 closure — player boundary in RLS

## Plan (before implementation)

**Mechanism chosen:** narrow `entries_select` and `game_participants_select` from
"any active member of the game's group" (`app_can_read_game`, group-scoped) to
"a participant of THIS specific game, or its creator" (`app_is_game_participant(game_id)
OR created_by = app_current_profile_id()`) — the exact fix already sketched and
deliberately deferred at the bottom of `security-fixes.sql` §F3, now activated as its
own migration (`docs/backend/player-boundary.sql`) so it doesn't touch a file already
applied in production.

**Why this over the alternatives:**
- Column-level `REVOKE`/`GRANT` (e.g. on `entries.amount`, `game_participants.cashout`):
  rejected — the client always `SELECT *`s (`fetchCloudGameChildren`), so a column revoke
  breaks every read of that table, participant or not; indistinguishable from an outage.
- A `SECURITY DEFINER` view replacing the base tables for reads: rejected specifically here
  — these two tables are what the open-game screen subscribes to over `postgres_changes`
  for realtime buy-in updates at an actual table. Swapping the client onto a view for reads
  would cost realtime on exactly the screen that needs it, for zero privacy gain (people
  actually sitting at the table are allowed to see each other's money).
- Row-policy narrowing (chosen): same mechanism family as F1/F2/F6, no new moving parts,
  the live open-game screen is completely unaffected (a participant is always a participant
  of their own game), and it closes exactly the gap: a fellow group member who was never at
  this table.

**Cost:** `pullCloud()` has always pulled raw `entries`/`game_participants` for every game
in every group the caller belongs to (not just games they played in) to compute group
history/leaderboard locally. After this migration, a game the viewer did not play in comes
back with zero rows for those two tables (RLS denies it outright, not partially). Without a
client change this renders a corrupted zero-player history row, or lets a device silently
adopt a foreign empty-looking open table. The client change (below) makes the safe failure
mode "omit the game from local history/leaderboard", not "render it wrong" and not "leak
it". That is a real, disclosed regression in **completeness** — group history briefly omits
games the viewer did not personally play — traded for closing a real **privacy** leak. It is
not itself a further leak.

**Does the rule cover closed history, or only an open table — and why:** both, deliberately.
The original F3 finding demonstrated that `entries_select`/`game_participants_select` never
distinguished `phase`, and `pullCloud()` pulls raw children for closed games exactly like open
ones. Restricting the fix to open games only would have left the permanently-stored history —
the more consequential half of the finding — fully exposed.

**What is NOT fixed here, and why it's a separate round:** `getGroupSummaries` /
`buildLeaderboard` / `toGroupGameSummary` still compute names/pot/winners locally from raw
rows instead of the already-existing safe aggregates (`group_leaderboard_public_v`,
`my_group_stats_v`) or a new safe per-game summary view of the same shape as
`GroupGameSummary` (date/player-count/winner-names/pot/balance-flag, no per-player money).
Wiring the client onto those is what would restore the completeness this round trades away,
without reopening the leak — a coordinated frontend rewrite, not a same-round SQL patch.

## What shipped

1. `docs/backend/player-boundary.sql` — idempotent, `BEGIN`/`COMMIT`-wrapped, narrows the two
   policies above. Not run (per instructions) — paste-ready for the owner, after `schema.sql`,
   `rls-policies.sql`, `join-invite.sql`, `fix-upsert-policies.sql`, `security-fixes.sql`.
2. `kupa-sgura.html`:
   - new pure helper `cloudGameChildrenAreTrustworthy(gameRow, participantRows, viewerProfileId)`
     — distinguishes "RLS denied this game" from "this game genuinely has no participants yet"
     (a freshly created, still-empty table this device itself owns).
   - `applyCloudPull`'s `history` (from `closedGames`) and `openCandidates` (from `openGames`)
     both filter through this predicate before mapping, instead of rendering/adopting whatever
     came back.
3. `tools/rls-probe.mjs` — new §5 destructive-only probe: account A creates a scratch group,
   adds account B as an active member directly (unrelated known gap, used only as scaffolding),
   plays a solo game inside the group, then checks whether B (who never played it) can read
   its `game_participants`/`entries`. Expects zero rows once `player-boundary.sql` is applied.
4. `docs/backend/security-review-2026-09-09.md` — F3 closure section appended (Hebrew, matching
   the file's language), covering mechanism, alternatives, the history-vs-open-table scoping
   decision, the client change, and what remains deferred.
5. `tests/player-boundary.test.cjs` — 11 offline tests: SQL structure (BEGIN/COMMIT, no secret
   material, idempotent DROP+CREATE, the two policies actually narrowed to
   participant-or-creator with the old group-wide gate gone), and the client predicate's four
   cases (granted, genuinely empty, denied, no viewer id) plus a check that both pull-merge call
   sites route through it.

## Verification

- `node --test tests/*.test.cjs` — 611 passing (600 baseline + 11 new), 0 failing.
- `git diff --check` — clean.
- Last `<script>` body in `kupa-sgura.html` parses with `new Function` (checked via a small
  Node one-liner before committing).

## What the controller (project owner) must run

1. Review and paste `docs/backend/player-boundary.sql` into the Supabase SQL editor, after the
   five files already applied (`schema.sql`, `rls-policies.sql`, `join-invite.sql`,
   `fix-upsert-policies.sql`, `security-fixes.sql`).
2. Deploy the `kupa-sgura.html` change in the same release — running the SQL alone, before the
   client change ships, will visibly (though safely — omission, not corruption or leak) shrink
   group history for members who don't participate in every game.
3. Optionally re-run `node tools/rls-probe.mjs --destructive` with two throwaway account tokens
   to confirm §5 (F3) now returns zero rows to account B.
