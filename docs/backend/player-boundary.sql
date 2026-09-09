-- #####################################################################
-- ##  DO NOT RUN THIS YET.  ###########################################
-- #####################################################################
--
-- Verified by the controller on 2026-09-10. This file is correct, but it
-- must NOT be applied on its own: it narrows entries_select and
-- game_participants_select to "participant of this game", while the client
-- still builds the group leaderboard and the group history from those raw
-- rows for EVERY game in the group. Applying it alone makes a member who
-- missed a night stop seeing that night in the group's history, and
-- computes their leaderboard over only the games they played.
--
-- That trades an obscure leak (a group member opening devtools) for a
-- visible, everyday regression. Wrong way round.
--
-- The prerequisite already exists in schema.sql and the client simply
-- never uses it: group_leaderboard_public_v, plus a per-game summary of
-- the same shape as GroupGameSummary (date / player count / winner names /
-- pot / balance flag, no per-player money). Wire the client onto those
-- FIRST; then this file closes F3 with nothing lost.
--
-- Apply order once that lands: this SQL and the client change ship in the
-- SAME release. Either one alone is broken.
-- #####################################################################

-- =====================================================================
-- "סוגרים קופה" — player-boundary.sql
-- Closes F3 (docs/backend/security-review-2026-09-09.md §F3): RLS enforced
-- only the GROUP boundary on entries/game_participants — any active member
-- of a group could read every OTHER game's raw buy-ins/cashouts, including
-- games they never played in, and compute any other player's net. The
-- product promise (HANDOFF.md, kupa-sgura.html) is that a group member
-- only ever sees "בקופה" (their own money) — never another player's net,
-- for a game they were not part of.
--
-- Run AFTER, in this order: schema.sql, rls-policies.sql, join-invite.sql,
-- fix-upsert-policies.sql, security-fixes.sql — i.e. paste this file last.
-- Idempotent: DROP POLICY IF EXISTS / CREATE OR REPLACE / REVOKE+GRANT.
--
-- DO NOT RUN THIS FILE. It is reviewed and executed by the project owner,
-- and MUST ship together with the matching kupa-sgura.html change in this
-- same commit (pullCloud() drops a closed/open game whose participant
-- rows come back empty under the tightened policy, rather than rendering
-- a corrupted zero-player entry — see the diff and its comments).
--
-- MECHANISM CHOSEN, AND WHY
--   Candidate 1 — column-level REVOKE/GRANT on entries.amount / game_
--   participants.cashout. Rejected: the client always SELECTs "*" (see
--   fetchCloudGameChildren), so a bare column revoke breaks every read
--   for every game, participant or not — indistinguishable from a total
--   outage from the client's point of view, and it would also block the
--   WITH CHECK / trigger paths that legitimately read the column while
--   writing (entries_insert_open_game, the balance trigger).
--   Candidate 2 — a SECURITY DEFINER view replacing the base tables.
--   Rejected for THIS finding specifically: the two tables are the ones
--   the live game screen streams over postgres_changes for the ACTUAL
--   participants of an open game (buy-in ticking up in real time at the
--   table) — swapping the client to a view means giving up realtime on
--   exactly the screen that most needs it, for no privacy gain (the
--   people at that table are already allowed to see each other's money).
--   Candidate 3 (chosen) — narrow the existing row-level policies from
--   "any active member of the game's group" to "a participant of THIS
--   game, or its creator". Same mechanism family as F1/F2/F6, no new
--   moving parts, keeps realtime working unchanged for the people the
--   product says may see the data (the people at that table), and closes
--   exactly the gap: a group member who was never at this table.
--
-- WHAT THIS DOES NOT FIX (see the plan in .superpowers/player-boundary-report.md)
--   Group-wide history/leaderboard rendering (getGroupSummaries,
--   buildLeaderboard, toGroupGameSummary) still needs RAW entries/game_
--   participants rows for every closed game in a group to compute names,
--   pot size and winners locally — pullCloud() has always pulled those
--   for every game in every group the caller belongs to, not just games
--   they played in. After this file is applied, a closed/open game the
--   caller did not play in comes back with EMPTY participant/entry rows
--   (RLS correctly denies it) instead of leaking them — the accompanying
--   client change drops that game from local history/leaderboard entirely
--   rather than rendering a corrupted zero-player ghost row. That is a
--   real, disclosed regression in COMPLETENESS (a group's history list
--   temporarily omits games the viewer did not play in) traded for
--   closing a real privacy leak; it is not a further leak. Removing that
--   gap requires wiring getGroupSummaries/buildLeaderboard onto the
--   already-existing safe, server-aggregated views (group_leaderboard_
--   public_v, my_group_stats_v) or a new safe group-game-summary view of
--   the same shape as GroupGameSummary (date/player-count/winner-names/
--   pot/balance-flag, no per-player money) — a coordinated frontend
--   rewrite, scoped as its own follow-up, not a same-round SQL patch.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- F3 (HIGH) — entries_select / game_participants_select narrowed from
-- "any active member of the game's group" to "a participant of THIS
-- game, or its creator". This is the exact fix sketched (and deliberately
-- deferred) at the bottom of security-fixes.sql §F3 — activated here, on
-- its own migration, together with the client change it requires.
--
-- Reading this does NOT regress the live open-game screen: everyone who
-- can currently watch buy-ins tick up in real time at a table is, by
-- definition, a participant of that same game (app_is_game_participant)
-- or its creator — nobody loses access to a game they are actually
-- playing. It only removes a group member's ability to read a DIFFERENT
-- game in the same group that they never sat down at.
--
-- game_results_v (schema.sql) is declared WITH (security_invoker = true)
-- and is built directly from game_participants + entries with no
-- independent RLS of its own — it inherits this same restriction for
-- free, so its GRANT SELECT ... TO authenticated (rls-policies.sql) does
-- not need to change.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS entries_select ON entries;
CREATE POLICY entries_select ON entries FOR SELECT TO authenticated
  USING (
    app_is_game_participant(game_id)
    OR EXISTS (SELECT 1 FROM games g WHERE g.id = entries.game_id AND g.created_by = app_current_profile_id())
  );

DROP POLICY IF EXISTS game_participants_select ON game_participants;
CREATE POLICY game_participants_select ON game_participants FOR SELECT TO authenticated
  USING (
    app_is_game_participant(game_id)
    OR EXISTS (SELECT 1 FROM games g WHERE g.id = game_participants.game_id AND g.created_by = app_current_profile_id())
  );
-- Upsert-safe, same reasoning as F6's four policies in security-fixes.sql:
-- these are SELECT policies, not the UPDATE/INSERT ones splitCloudWrites
-- routes around — no interaction with the insert-then-update upsert bug.

COMMIT;
