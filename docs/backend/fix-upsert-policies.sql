-- =====================================================================
-- fix-upsert-policies.sql — make the RLS policies upsert-safe.
--
-- WHY
-- ---
-- PostgREST's `upsert(rows, { onConflict: "id" })` compiles to
--   INSERT ... ON CONFLICT (id) DO UPDATE ...
-- and PostgreSQL evaluates BOTH the INSERT policy and the UPDATE policy of
-- the target table for such a statement. Our UPDATE policies were written
-- on top of STABLE SECURITY DEFINER helpers (app_can_read_game(),
-- app_is_group_admin()) that re-query the SAME table the statement is
-- writing. Inside that statement the new row is not yet visible to them,
-- so the check fails and the client sees:
--   42501  new row violates row-level security policy
--
-- Observed live, with the owner's own session:
--   insert  a brand-new games row              -> ok
--   upsert  the same row while it did NOT exist -> 42501
--   upsert  the same row once it DID exist      -> ok
--   insert(...).select('id') on a new row       -> 42501 (the SELECT policy
--                                                  cannot see it on RETURNING)
-- Net effect in production: the FIRST write of any row into a merge-upsert
-- table always failed, which is why no game ever reached the server.
--
-- The app-side fix (kupa-sgura.html: splitCloudWrites) now sends new rows as
-- INSERT ... ON CONFLICT DO NOTHING and only merge-upserts rows the server is
-- known to hold. This file makes the database itself correct too, so a plain
-- upsert — or a future `.select()` after an insert — is no longer a landmine.
--
-- WHAT CHANGES
-- ------------
-- Each affected policy gains a direct-ownership branch that can be evaluated
-- from the NEW row's own columns, without re-reading the table:
--   games            -> created_by = app_current_profile_id()
--   groups           -> created_by_profile_id = app_current_profile_id()
--   group_members    -> the group's creator (read from `groups`, a DIFFERENT
--                       table, therefore visible during the statement)
--   invites          -> created_by_profile_id = app_current_profile_id()
-- Nothing else moves. Membership predicates are kept, ORed, never replaced.
--
-- PRIVACY
-- -------
-- Every new branch is "I am the creator of this very row / of its group".
-- The creator of a game or a group is already an active member of it and
-- already reads it through the existing membership branch; no policy here
-- lets anybody see a row belonging to a group they are not in, a game they
-- did not create and do not take part in, or another person's P&L. `debts`,
-- `entries`, `transfers` and `profiles` are untouched.
--
-- Idempotent: safe to run more than once.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- games
-- SELECT: the creator can read the row they just inserted, even before the
--   participants exist (app_can_read_game() needs a visible games row).
-- UPDATE: 'phase <> closed' still freezes a closed game — immutability is
--   unchanged. The re-read through app_can_read_game(id) becomes one of
--   three ORed branches instead of a hard requirement.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS games_select ON games;
CREATE POLICY games_select ON games FOR SELECT TO authenticated
  USING (
    created_by = app_current_profile_id()
    OR (group_id IS NOT NULL AND app_is_active_group_member(group_id))
    OR app_is_game_participant(id)
  );

DROP POLICY IF EXISTS games_update_member ON games;
CREATE POLICY games_update_member ON games FOR UPDATE TO authenticated
  USING (
    phase <> 'closed'
    AND (
      created_by = app_current_profile_id()
      OR (group_id IS NOT NULL AND app_is_active_group_member(group_id))
      OR app_is_game_participant(id)
    )
  )
  WITH CHECK (
    created_by = app_current_profile_id()
    OR group_id IS NULL
    OR app_is_active_group_member(group_id)
  );

-- ---------------------------------------------------------------------
-- game_participants
-- app_can_write_game(game_id) reads `games`, a different table, so it is
-- already upsert-safe. The creator branch is added only so the policy does
-- not depend on the participant rows it is itself inserting.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS game_participants_update ON game_participants;
CREATE POLICY game_participants_update ON game_participants FOR UPDATE TO authenticated
  USING (
    app_can_write_game(game_id)
    OR EXISTS (SELECT 1 FROM games g
               WHERE g.id = game_participants.game_id
                 AND g.phase <> 'closed'
                 AND g.created_by = app_current_profile_id())
  )
  WITH CHECK (
    app_can_write_game(game_id)
    OR EXISTS (SELECT 1 FROM games g
               WHERE g.id = game_participants.game_id
                 AND g.phase <> 'closed'
                 AND g.created_by = app_current_profile_id())
  );

-- ---------------------------------------------------------------------
-- groups
-- A brand-new group has no group_members row yet, so app_is_group_admin()
-- is false for its own creator during the creating statement.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS groups_update_admin ON groups;
CREATE POLICY groups_update_admin ON groups FOR UPDATE TO authenticated
  USING (created_by_profile_id = app_current_profile_id() OR app_is_group_admin(id))
  WITH CHECK (created_by_profile_id = app_current_profile_id() OR app_is_group_admin(id));

-- ---------------------------------------------------------------------
-- group_members
-- app_is_group_admin() re-reads group_members itself — the same-table trap.
-- The extra branch mirrors group_members_insert_admin's second clause: the
-- group's own creator may write its membership rows.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS group_members_update_admin ON group_members;
CREATE POLICY group_members_update_admin ON group_members FOR UPDATE TO authenticated
  USING (
    app_is_group_admin(group_id)
    OR EXISTS (SELECT 1 FROM groups g
               WHERE g.id = group_members.group_id
                 AND g.created_by_profile_id = app_current_profile_id())
  )
  WITH CHECK (
    app_is_group_admin(group_id)
    OR EXISTS (SELECT 1 FROM groups g
               WHERE g.id = group_members.group_id
                 AND g.created_by_profile_id = app_current_profile_id())
  );

DROP POLICY IF EXISTS group_members_select ON group_members;
CREATE POLICY group_members_select ON group_members FOR SELECT TO authenticated
  USING (
    app_is_active_group_member(group_id)
    OR profile_id = app_current_profile_id()
    OR EXISTS (SELECT 1 FROM groups g
               WHERE g.id = group_members.group_id
                 AND g.created_by_profile_id = app_current_profile_id())
  );

-- ---------------------------------------------------------------------
-- invites — the row carries its own author, so the branch is direct.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS invites_update_admin ON invites;
CREATE POLICY invites_update_admin ON invites FOR UPDATE TO authenticated
  USING (created_by_profile_id = app_current_profile_id() OR app_is_group_admin(group_id))
  WITH CHECK (created_by_profile_id = app_current_profile_id() OR app_is_group_admin(group_id));

COMMIT;

-- =====================================================================
-- HOW TO VERIFY
-- ---------------------------------------------------------------------
-- 1) The policies are in place:
--
--    SELECT tablename, policyname, cmd
--    FROM pg_policies
--    WHERE schemaname = 'public'
--      AND policyname IN ('games_select','games_update_member',
--                         'game_participants_update','groups_update_admin',
--                         'group_members_update_admin','group_members_select',
--                         'invites_update_admin')
--    ORDER BY tablename, policyname;
--
-- 2) The original 42501 is gone. As a signed-in user (anon key + that user's
--    JWT, NOT the service role — the service role bypasses RLS and proves
--    nothing), upsert a games row whose id does not exist yet:
--
--      supabase.from('games').upsert(
--        [{ id: crypto.randomUUID(), created_by: '<my profile id>',
--           group_id: null, phase: 'active', started_at: new Date().toISOString() }],
--        { onConflict: 'id' });
--
--    Before this file: 42501. After: no error. Repeat the same call to
--    confirm the update path still works, then delete the probe row.
--
-- 3) Nothing widened. As a user who is NOT a member of a group and NOT a
--    participant of its game:
--
--      SELECT count(*) FROM games         WHERE id = '<that game id>';   -- 0
--      SELECT count(*) FROM group_members WHERE group_id = '<that group>'; -- 0
--      SELECT count(*) FROM debts         WHERE game_id = '<that game id>'; -- 0
--
-- 4) A closed game is still frozen:
--
--      UPDATE games SET started_at = now() WHERE id = '<a closed game id>';
--    -- 0 rows updated (USING still requires phase <> 'closed').
-- =====================================================================
