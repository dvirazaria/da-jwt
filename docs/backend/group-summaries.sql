-- =====================================================================
-- "סוגרים קופה" — group-summaries.sql
--
-- Prerequisite for docs/backend/player-boundary.sql (F3). That file narrows
-- entries_select/game_participants_select to "participant of this game or
-- its creator", but pullCloud() has always built the GROUP leaderboard and
-- the group's game history from those same raw rows, for every game in
-- every group the caller belongs to — not just games they played. Applying
-- player-boundary.sql alone would make a member who missed a night stop
-- seeing that night in the group's history, and shrink their leaderboard to
-- only the games they personally played. This file, plus the matching
-- kupa-sgura.html change (resolveGroupLeaderboard / resolveGroupGameSummaries),
-- removes that trade: the client reads a safe aggregate for group screens
-- instead of raw per-player rows, so the boundary fix can ship with nothing
-- lost. See player-boundary.sql's own header and .superpowers/player-boundary-report.md.
--
-- Run AFTER schema.sql, rls-policies.sql, join-invite.sql,
-- fix-upsert-policies.sql, security-fixes.sql — same position as
-- player-boundary.sql. Order relative to player-boundary.sql does not
-- matter (this file does not depend on it), but BOTH must ship in the same
-- release as the kupa-sgura.html change that stops rendering raw rows for
-- a game the viewer did not play.
--
-- WHAT ALREADY EXISTED, AND WHY IT WAS ENOUGH FOR THE LEADERBOARD
-- group_leaderboard_public_v (schema.sql, granted in rls-policies.sql) was
-- written and granted, but the client never queried it. It already
-- survives player-boundary.sql without changes: group_leaderboard_v is
-- declared `security_invoker = true`, but group_leaderboard_public_v (the
-- thin wrapper actually granted to `authenticated`) is NOT — a view without
-- security_invoker runs with the privileges of its OWNER for permission
-- and row-security purposes. So when a member queries
-- group_leaderboard_public_v, group_leaderboard_v underneath it evaluates
-- its own RLS-sensitive reads (game_results_v -> game_participants/entries)
-- as the view owner, not as the querying member — exactly the mechanism
-- the "SECURITY DEFINER view" alternative in player-boundary.sql's header
-- rejected for the OPEN-TABLE realtime screen (it costs realtime there),
-- but which is exactly right for a closed-game aggregate nobody subscribes
-- to over postgres_changes. No money crosses this boundary either way:
-- group_leaderboard_public_v never had a net/cashout column.
--
-- WHAT WAS MISSING: a per-game summary of the same shape as the client's
-- GroupGameSummary (date / player count / winner names / pot / balance
-- flag — no per-player net or cashout). That is what this file adds.
--
-- MECHANISM: same trick as group_leaderboard_public_v — no
-- `security_invoker`, so the view runs with the owner's rights and is not
-- narrowed by player-boundary.sql's per-participant policies. Because that
-- bypass is exactly the sensitive part, the view itself re-implements the
-- one check that matters — "is the caller an active member of this game's
-- group" — using the existing SECURITY DEFINER helper
-- app_is_active_group_member(group_id), the same helper rls-policies.sql
-- already uses for the group_members/games policies. A game with no
-- group_id (an ad-hoc table) is out of scope for group screens and is
-- excluded, same as group_leaderboard_v's own `group_id IS NOT NULL` filter.
-- =====================================================================

BEGIN;

CREATE OR REPLACE VIEW group_game_summaries_v AS
WITH closed AS (
  SELECT g.id AS game_id, g.group_id, g.closed_at AS at, g.started_at
  FROM games g
  WHERE g.phase = 'closed'
    AND g.group_id IS NOT NULL
    AND app_is_active_group_member(g.group_id)
),
per_game AS (
  SELECT
    c.game_id, c.group_id, c.at, c.started_at,
    r.display_name, r.buyin_total, r.cashout, r.net,
    max(r.net) OVER (PARTITION BY c.game_id) AS best_net
  FROM closed c
  JOIN game_results_v r ON r.game_id = c.game_id
  WHERE r.display_name IS NOT NULL
)
SELECT
  game_id,
  group_id,
  at,
  started_at,
  count(*)::integer                                                       AS player_count,
  array_agg(display_name ORDER BY display_name)                           AS player_names,
  -- No winner when nobody actually profited (best_net <= 0), matching gameWinners() in the
  -- frontend; ties at a positive net all count as winners.
  array_agg(display_name ORDER BY display_name)
    FILTER (WHERE net = best_net AND best_net > 0)                        AS winner_names,
  sum(buyin_total)::integer                                               AS pot_size,
  (sum(buyin_total) = sum(coalesce(cashout, 0)))                          AS is_balanced
FROM per_game
GROUP BY game_id, group_id, at, started_at;

COMMENT ON VIEW group_game_summaries_v IS
  'Safe per-game group summary — date/player-count/winner-names/pot/balance flag only, never a '
  'per-player net or cashout. Matches GroupGameSummary in kupa-sgura.html. Deliberately not '
  'security_invoker: computed for every closed game in a group the caller actively belongs to '
  '(app_is_active_group_member), independent of player-boundary.sql''s per-participant narrowing '
  'of entries/game_participants — the same bypass group_leaderboard_public_v already relies on.';

-- Views created without security_invoker run with the owner's privileges for permission checks,
-- but GRANT/REVOKE on the view object itself still applies normally, and Postgres does not grant
-- anything on a view to PUBLIC by default. Both REVOKEs below are therefore belt-and-suspenders,
-- matching the non-negotiable for any new view/function in this project.
REVOKE ALL ON group_game_summaries_v FROM public;
REVOKE ALL ON group_game_summaries_v FROM anon;
GRANT SELECT ON group_game_summaries_v TO authenticated;

COMMIT;
