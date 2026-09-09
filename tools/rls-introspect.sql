-- =====================================================================
-- tools/rls-introspect.sql — read-only snapshot of what is ACTUALLY live.
--
-- WHY THIS EXISTS
-- ----------------
-- docs/backend/rls-policies.sql, docs/backend/fix-upsert-policies.sql and
-- docs/backend/security-fixes.sql are the *intended* history of the RLS
-- surface, applied by hand, in order, by pasting each file into the
-- Supabase SQL editor. Nothing in this repo can prove that history was
-- actually applied in full, in order, with no manual edits along the way —
-- the file on disk describes intent, not the live database. Before trusting
-- any reasoning about "what fix-upsert-policies.sql changed" or "what
-- security-fixes.sql is about to change", read what is really there.
--
-- WHAT THIS FILE IS
-- ------------------
-- Four SELECT-only queries. No INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/
-- GRANT/REVOKE anywhere below. It reads only catalog metadata
-- (pg_proc/pg_namespace/pg_policies/pg_class) — never an application table
-- (games, groups, profiles, …) — so it is safe to run at any time, against
-- production, as any role that can read the catalogs (the project owner /
-- SQL editor connection is enough; no service key needed). Running it
-- twice, or a hundred times, changes nothing.
--
-- HOW TO USE IT
-- -------------
-- Paste the whole file into the Supabase SQL editor and run it (most SQL
-- editors, including Supabase's, run one statement at a time when there are
-- several — run all four blocks, in order, and keep all four result sets).
-- Paste every column of every row back verbatim — especially
-- `using_expression`/`with_check_expression` in blocks 2 and 3. Do not
-- summarize or truncate them: the entire point is to see the literal
-- boolean expression Postgres is enforcing right now, not a description of
-- it. A NULL in `with_check_expression` is a real, meaningful value (some
-- commands only ever get a USING clause) — paste it back as NULL, not as an
-- empty cell.
--
-- HOW TO READ THE OUTPUT
-- -----------------------
-- Block 1 (helper functions): every `app_*` predicate helper, its
-- volatility, whether it runs SECURITY DEFINER or INVOKER, and whether it
-- has a pinned `search_path`. All nine helpers in rls-policies.sql are
-- declared STABLE; app_profile_is_active_group_member (added by
-- security-fixes.sql §F2) is declared STABLE too. If security-fixes.sql
-- has not been run yet, that tenth row simply will not appear — that
-- absence is itself informative (F2 not applied yet).
--
-- Block 2 (every policy on the five tables this collision touches):
-- groups, group_members, invites, games, game_participants — every
-- SELECT/INSERT/UPDATE/DELETE policy on each, not just the five in
-- question, so you can see the whole surface at once. `mentions_created_by`
-- is a cheap grep-in-SQL over the two expression columns — TRUE does not by
-- itself mean "insecure" (game_participants_insert legitimately mentions
-- `created_by` through app_can_write_game's own definition being quoted
-- nowhere in pg_policies — the column only flags literal text in the
-- POLICY's own qual/with_check, so a TRUE here means the creator check is
-- written directly into *this* policy, not hidden inside a helper call).
--
-- Block 3 (the five contested policies, isolated): exactly
--   groups_update_admin, group_members_update_admin, invites_update_admin,
--   games_update_member, game_participants_update
-- with nothing else in the way. This is the fast path to answering "does
-- any of these five still carry a bare, unconditional
-- `created_by[_profile_id] = app_current_profile_id()` branch in its own
-- USING or WITH CHECK text right now" — read every
-- using_expression/with_check_expression cell for that literal pattern.
-- Before applying security-fixes.sql's §F6 block: expect to find it in all
-- four of groups_update_admin / group_members_update_admin /
-- invites_update_admin / games_update_member (that is the bug being
-- fixed), and NOT find it in game_participants_update (that branch was
-- already dropped by §F2's rewrite — see security-fixes.sql's own comment
-- at that policy). After applying §F6: expect it gone from all five.
--
-- Block 4 (RLS enable/force flag, same five tables): every helper above is
-- SECURITY DEFINER and relies on the table owner's RLS bypass to read a
-- base table without recursing into its own policy (rls-policies.sql's own
-- comment above `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`). If any of
-- these five ever shows force_rls = true, every helper function stops
-- working (infinite recursion) and this whole investigation is moot —
-- expect false on all five, always.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Block 1 — every app_* helper: volatility, DEFINER/INVOKER, search_path.
-- ---------------------------------------------------------------------
SELECT
  p.proname                                                          AS function_name,
  pg_get_function_identity_arguments(p.oid)                          AS arguments,
  CASE p.provolatile
    WHEN 'i' THEN 'IMMUTABLE'
    WHEN 's' THEN 'STABLE'
    WHEN 'v' THEN 'VOLATILE'
    ELSE p.provolatile::text
  END                                                                 AS volatility,
  CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END AS security,
  COALESCE(
    (SELECT string_agg(cfg, ', ') FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
     WHERE cfg LIKE 'search_path=%'),
    '(not pinned — defaults to the caller''s search_path)'
  )                                                                   AS search_path_setting,
  pg_get_functiondef(p.oid)                                          AS full_definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname LIKE 'app\_%' ESCAPE '\'
ORDER BY p.proname, arguments;

-- ---------------------------------------------------------------------
-- Block 2 — every policy on the five tables this collision touches.
-- ---------------------------------------------------------------------
SELECT
  tablename                                                          AS table_name,
  policyname                                                         AS policy_name,
  cmd                                                                AS command,
  permissive,
  roles,
  qual                                                                AS using_expression,
  with_check                                                          AS with_check_expression,
  (COALESCE(qual, '') ~* 'created_by' OR COALESCE(with_check, '') ~* 'created_by') AS mentions_created_by
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('groups', 'group_members', 'invites', 'games', 'game_participants')
ORDER BY tablename, cmd, policy_name;

-- ---------------------------------------------------------------------
-- Block 3 — exactly the five contested policies, isolated.
-- ---------------------------------------------------------------------
SELECT
  tablename                                                          AS table_name,
  policyname                                                         AS policy_name,
  cmd                                                                AS command,
  qual                                                                AS using_expression,
  with_check                                                          AS with_check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname IN (
    'groups_update_admin', 'group_members_update_admin', 'invites_update_admin',
    'games_update_member', 'game_participants_update'
  )
ORDER BY table_name, policy_name;

-- ---------------------------------------------------------------------
-- Block 4 — RLS enable/force flag on the same five tables (sanity check
-- only; see the "how to read" note above for why FORCE would be a red flag).
-- ---------------------------------------------------------------------
SELECT
  c.relname                                                          AS table_name,
  c.relrowsecurity                                                   AS rls_enabled,
  c.relforcerowsecurity                                              AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('groups', 'group_members', 'invites', 'games', 'game_participants')
ORDER BY c.relname;
