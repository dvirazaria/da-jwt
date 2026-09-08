-- =====================================================================
-- "סוגרים קופה" — Row Level Security
-- Run AFTER docs/backend/schema.sql.
-- =====================================================================
-- Rule of the repo: a table created without RLS, reachable with a
-- publishable client key, is public data. Every table below is enabled in
-- this file; adding a table to schema.sql without adding it here is a bug.
--
-- ---------------------------------------------------------------------
-- VENDOR SECTION — the ONLY Supabase-specific code in these artifacts.
-- Two things are Supabase-shaped and both are isolated here:
--   (a) app_current_profile_id() reads auth.uid();
--   (b) policies are granted TO the role `authenticated`.
-- The portable alternative is written next to each one.
-- ---------------------------------------------------------------------

-- SUPABASE ONLY. Ties profiles to the managed auth store. On a portable
-- deployment drop this statement and seed profiles.id from your own auth.
-- ALTER TABLE profiles
--   ADD CONSTRAINT profiles_auth_user_fk
--   FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION app_current_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  -- SUPABASE: the signed-in user id from the JWT.
  SELECT auth.uid()
  -- PORTABLE ALTERNATIVE (plain Postgres / PocketBase / own API layer):
  -- the connection sets the identity once per request with
  --   SET LOCAL app.user_id = '<uuid>';
  -- and this body becomes:
  --   SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
COMMENT ON FUNCTION app_current_profile_id() IS
  'Current signed-in profile id. The single vendor seam: auth.uid() on Supabase, current_setting(''app.user_id'') elsewhere.';

-- ---------------------------------------------------------------------
-- Predicate helpers
-- ---------------------------------------------------------------------
-- All SECURITY DEFINER. A policy on group_members that itself selects
-- from group_members recurses ("infinite recursion detected in policy");
-- a definer-rights function reads the base table without re-entering RLS.
-- Each pins search_path so it cannot be hijacked by a caller's path.

CREATE OR REPLACE FUNCTION app_is_active_group_member(p_group_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM group_members m
    WHERE m.group_id = p_group_id
      AND m.status = 'active'
      AND m.profile_id = app_current_profile_id()
  )
$$;

CREATE OR REPLACE FUNCTION app_is_group_admin(p_group_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM group_members m
    WHERE m.group_id = p_group_id
      AND m.status = 'active'
      AND m.role = 'admin'
      AND m.profile_id = app_current_profile_id()
  )
$$;

CREATE OR REPLACE FUNCTION app_is_game_participant(p_game_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM game_participants gp
    WHERE gp.game_id = p_game_id
      AND gp.profile_id = app_current_profile_id()
  )
$$;

-- A game is visible to the active members of its group; an ad-hoc game
-- (group_id NULL) is visible to its participants and its creator only.
CREATE OR REPLACE FUNCTION app_can_read_game(p_game_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM games g
    WHERE g.id = p_game_id
      AND (
        (g.group_id IS NOT NULL AND app_is_active_group_member(g.group_id))
        OR g.created_by = app_current_profile_id()
        OR app_is_game_participant(g.id)
      )
  )
$$;

-- Who may add players, add buy-ins and type cashouts: any active member of
-- the group (the app is cooperative by design — everyone at the table
-- edits the table), or a participant/creator of an ad-hoc game.
CREATE OR REPLACE FUNCTION app_can_write_game(p_game_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM games g
    WHERE g.id = p_game_id
      AND g.phase <> 'closed'
      AND (
        (g.group_id IS NOT NULL AND app_is_active_group_member(g.group_id))
        OR g.created_by = app_current_profile_id()
        OR app_is_game_participant(g.id)
      )
  )
$$;

CREATE OR REPLACE FUNCTION app_shares_group_with(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM group_members mine
    JOIN group_members theirs ON theirs.group_id = mine.group_id
    WHERE mine.profile_id   = app_current_profile_id() AND mine.status = 'active'
      AND theirs.profile_id = p_profile_id            AND theirs.status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION app_group_has_no_members(p_group_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = p_group_id)
$$;

CREATE OR REPLACE FUNCTION app_is_friend_of(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM friendships f
    WHERE f.status = 'accepted'
      AND ((f.requester_profile_id = app_current_profile_id() AND f.addressee_profile_id = p_profile_id)
        OR (f.addressee_profile_id = app_current_profile_id() AND f.requester_profile_id = p_profile_id))
  )
$$;

-- ---------------------------------------------------------------------
-- Enable RLS everywhere.
-- Deliberately ENABLE and not FORCE: the helpers above are SECURITY
-- DEFINER and owned by the table owner, so they rely on the owner's RLS
-- bypass to read a base table without re-entering its own policy. Turning
-- on FORCE ROW LEVEL SECURITY would make them recurse. The consequence is
-- that a direct owner connection (psql, a migration script, a service key)
-- is not filtered — which is exactly what the import in
-- migration-from-local-state.md needs, and exactly why that key must never
-- reach the client.
-- ---------------------------------------------------------------------
ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE guests            ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups            ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites           ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships       ENABLE ROW LEVEL SECURITY;
ALTER TABLE games             ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries           ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE debts             ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- profiles — readable by yourself, your friends and your group-mates
-- ---------------------------------------------------------------------
CREATE POLICY profiles_select_self ON profiles FOR SELECT TO authenticated
  USING (id = app_current_profile_id());
CREATE POLICY profiles_select_friends ON profiles FOR SELECT TO authenticated
  USING (app_is_friend_of(id));
CREATE POLICY profiles_select_group_mates ON profiles FOR SELECT TO authenticated
  USING (app_shares_group_with(id));
CREATE POLICY profiles_insert_self ON profiles FOR INSERT TO authenticated
  WITH CHECK (id = app_current_profile_id());
CREATE POLICY profiles_update_self ON profiles FOR UPDATE TO authenticated
  USING (id = app_current_profile_id())
  WITH CHECK (id = app_current_profile_id());
-- No DELETE policy: an account is removed through auth, and profiles rows
-- are referenced by games.created_by with ON DELETE RESTRICT.

-- ---------------------------------------------------------------------
-- guests — a guest is visible to whoever created them, to the members of
-- a group the guest belongs to, and to anyone who can read a game the
-- guest played in.
-- ---------------------------------------------------------------------
CREATE POLICY guests_select ON guests FOR SELECT TO authenticated
  USING (
    created_by = app_current_profile_id()
    OR linked_profile_id = app_current_profile_id()
    OR EXISTS (SELECT 1 FROM group_members m
               WHERE m.guest_id = guests.id AND app_is_active_group_member(m.group_id))
    OR EXISTS (SELECT 1 FROM game_participants gp
               WHERE gp.guest_id = guests.id AND app_can_read_game(gp.game_id))
  );
CREATE POLICY guests_insert ON guests FOR INSERT TO authenticated
  WITH CHECK (created_by = app_current_profile_id() AND linked_profile_id IS NULL);
CREATE POLICY guests_update_creator ON guests FOR UPDATE TO authenticated
  USING (created_by = app_current_profile_id())
  WITH CHECK (created_by = app_current_profile_id());
-- The guest -> account merge (setting linked_profile_id) must be a
-- SECURITY DEFINER RPC that verifies both sides consented; a plain UPDATE
-- would let a creator attach someone else's account to a guest row.

-- ---------------------------------------------------------------------
-- groups — read: active members. write: admins only. create: anyone.
-- ---------------------------------------------------------------------
CREATE POLICY groups_select_members ON groups FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND (app_is_active_group_member(id)
                                 OR created_by_profile_id = app_current_profile_id()));
CREATE POLICY groups_insert_self ON groups FOR INSERT TO authenticated
  WITH CHECK (created_by_profile_id = app_current_profile_id());
-- Metadata, archive and soft delete are all UPDATEs, all admin-only.
CREATE POLICY groups_update_admin ON groups FOR UPDATE TO authenticated
  USING (app_is_group_admin(id))
  WITH CHECK (app_is_group_admin(id));
-- No DELETE policy at all: deletion is deleted_at, so history keeps its group.

-- ---------------------------------------------------------------------
-- group_members
-- ---------------------------------------------------------------------
CREATE POLICY group_members_select ON group_members FOR SELECT TO authenticated
  USING (app_is_active_group_member(group_id) OR profile_id = app_current_profile_id());
-- Admins add members and guests. The very first row of a new group is the
-- creator making themselves admin, which no admin exists yet to approve —
-- hence the second clause.
CREATE POLICY group_members_insert_admin ON group_members FOR INSERT TO authenticated
  WITH CHECK (
    app_is_group_admin(group_id)
    OR (app_group_has_no_members(group_id)
        AND EXISTS (SELECT 1 FROM groups g
                    WHERE g.id = group_id AND g.created_by_profile_id = app_current_profile_id()))
  );
CREATE POLICY group_members_update_admin ON group_members FOR UPDATE TO authenticated
  USING (app_is_group_admin(group_id))
  WITH CHECK (app_is_group_admin(group_id));
-- Leaving is a self-update to status 'left'; role and group cannot move.
CREATE POLICY group_members_leave_self ON group_members FOR UPDATE TO authenticated
  USING (profile_id = app_current_profile_id() AND status = 'active')
  WITH CHECK (profile_id = app_current_profile_id() AND status = 'left' AND left_at IS NOT NULL);
-- No DELETE policy: removal is status 'removed', so the leaderboard keeps
-- counting the person's closed games as a former member.

-- Joining by invite: the joiner is not a member yet, so no SELECT policy
-- lets them read the group or the token. Redemption therefore goes through
--   CREATE FUNCTION redeem_invite(p_token text) RETURNS uuid
--     LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
-- which validates revoked_at/expires_at, inserts the group_members row for
-- app_current_profile_id() and returns the group id. Never expose invites
-- by token through a SELECT policy — that turns the token table into an
-- enumeration oracle.

-- ---------------------------------------------------------------------
-- invites — visible to members, created and revoked by admins
-- ---------------------------------------------------------------------
CREATE POLICY invites_select_members ON invites FOR SELECT TO authenticated
  USING (app_is_active_group_member(group_id));
CREATE POLICY invites_insert_admin ON invites FOR INSERT TO authenticated
  WITH CHECK (app_is_group_admin(group_id) AND created_by_profile_id = app_current_profile_id());
CREATE POLICY invites_update_admin ON invites FOR UPDATE TO authenticated
  USING (app_is_group_admin(group_id))
  WITH CHECK (app_is_group_admin(group_id));

-- ---------------------------------------------------------------------
-- friendships — only the two parties, ever
-- ---------------------------------------------------------------------
CREATE POLICY friendships_select_parties ON friendships FOR SELECT TO authenticated
  USING (requester_profile_id = app_current_profile_id()
      OR addressee_profile_id = app_current_profile_id());
CREATE POLICY friendships_insert_requester ON friendships FOR INSERT TO authenticated
  WITH CHECK (requester_profile_id = app_current_profile_id() AND status = 'pending');
-- Only the addressee answers a request.
CREATE POLICY friendships_update_addressee ON friendships FOR UPDATE TO authenticated
  USING (addressee_profile_id = app_current_profile_id() AND status = 'pending')
  WITH CHECK (addressee_profile_id = app_current_profile_id()
              AND status IN ('accepted', 'rejected') AND responded_at IS NOT NULL);
-- The requester may withdraw a request that is still pending.
CREATE POLICY friendships_delete_requester ON friendships FOR DELETE TO authenticated
  USING (requester_profile_id = app_current_profile_id() AND status = 'pending');

-- ---------------------------------------------------------------------
-- games — read by the group; created and edited by any active member;
-- frozen the moment phase = 'closed'.
-- ---------------------------------------------------------------------
CREATE POLICY games_select ON games FOR SELECT TO authenticated
  USING (app_can_read_game(id));
CREATE POLICY games_insert_member ON games FOR INSERT TO authenticated
  WITH CHECK (
    created_by = app_current_profile_id()
    AND phase <> 'closed'
    AND (group_id IS NULL OR app_is_active_group_member(group_id))
  );
-- USING sees the OLD row: a closed game can never be the target of an
-- UPDATE, which is what makes it immutable. WITH CHECK sees the NEW row
-- and deliberately allows phase -> 'closed' (that IS the close action).
CREATE POLICY games_update_member ON games FOR UPDATE TO authenticated
  USING (phase <> 'closed'
         AND (group_id IS NULL OR app_is_active_group_member(group_id))
         AND (app_can_read_game(id)))
  WITH CHECK (group_id IS NULL OR app_is_active_group_member(group_id));
-- Deleting an open game (abandoning a table) is the creator's call only.
CREATE POLICY games_delete_creator ON games FOR DELETE TO authenticated
  USING (phase <> 'closed' AND created_by = app_current_profile_id());

-- ---------------------------------------------------------------------
-- game_participants
-- ---------------------------------------------------------------------
CREATE POLICY game_participants_select ON game_participants FOR SELECT TO authenticated
  USING (app_can_read_game(game_id));
CREATE POLICY game_participants_insert ON game_participants FOR INSERT TO authenticated
  WITH CHECK (app_can_write_game(game_id));
CREATE POLICY game_participants_update ON game_participants FOR UPDATE TO authenticated
  USING (app_can_write_game(game_id))
  WITH CHECK (app_can_write_game(game_id));
CREATE POLICY game_participants_delete ON game_participants FOR DELETE TO authenticated
  USING (app_can_write_game(game_id));

-- ---------------------------------------------------------------------
-- entries — append while the game is open; never editable
-- ---------------------------------------------------------------------
CREATE POLICY entries_select ON entries FOR SELECT TO authenticated
  USING (app_can_read_game(game_id));
CREATE POLICY entries_insert ON entries FOR INSERT TO authenticated
  WITH CHECK (app_can_write_game(game_id));
-- Deliberately NO update policy: an amount is never corrected in place.
-- DELETE exists only because of the product's "בטל אחרונה" undo, and only
-- while the game is open. If that undo ever becomes a soft void, replace
-- this policy with a voided_at column and drop DELETE entirely.
CREATE POLICY entries_delete_open_game ON entries FOR DELETE TO authenticated
  USING (app_can_write_game(game_id));

-- ---------------------------------------------------------------------
-- transfers — written at settlement; after close only `status` moves
-- ---------------------------------------------------------------------
CREATE POLICY transfers_select ON transfers FOR SELECT TO authenticated
  USING (app_can_read_game(game_id));
CREATE POLICY transfers_insert ON transfers FOR INSERT TO authenticated
  WITH CHECK (app_can_write_game(game_id));
-- RLS cannot restrict WHICH columns an UPDATE touches, so the column-level
-- GRANT below is the real enforcement, backed by the schema.sql trigger
-- app_assert_transfer_editable(). This policy only says WHO may toggle.
CREATE POLICY transfers_update_status ON transfers FOR UPDATE TO authenticated
  USING (app_can_read_game(game_id))
  WITH CHECK (app_can_read_game(game_id));
CREATE POLICY transfers_delete_open ON transfers FOR DELETE TO authenticated
  USING (app_can_write_game(game_id));

-- ---------------------------------------------------------------------
-- debts — the strictest table. Only the two parties see a debt, and only
-- the creditor may mark it paid. Group admins get nothing.
-- ---------------------------------------------------------------------
CREATE POLICY debts_select_parties ON debts FOR SELECT TO authenticated
  USING (debtor_profile_id = app_current_profile_id()
      OR creditor_profile_id = app_current_profile_id());
CREATE POLICY debts_insert_on_close ON debts FOR INSERT TO authenticated
  WITH CHECK (
    status = 'open' AND paid_at IS NULL
    AND EXISTS (SELECT 1 FROM games g
                WHERE g.id = game_id
                  AND (g.created_by = app_current_profile_id()
                       OR (g.group_id IS NOT NULL AND app_is_active_group_member(g.group_id))))
  );
-- Only the creditor, only open -> paid. Payment never touches amount or
-- identities, so it can never change a poker result.
CREATE POLICY debts_update_creditor ON debts FOR UPDATE TO authenticated
  USING (creditor_profile_id = app_current_profile_id() AND status = 'open')
  WITH CHECK (creditor_profile_id = app_current_profile_id()
              AND status = 'paid' AND paid_at IS NOT NULL
              AND paid_by_profile_id = app_current_profile_id());
-- No DELETE policy: a debt is history.
--
-- KNOWN GAP, by design: a debt whose debtor or creditor is a *guest* has no
-- profile on that side, so only the account-holding side can see it. When
-- guests.linked_profile_id lands, widen the SELECT policy to resolve the
-- guest through its link.

-- ---------------------------------------------------------------------
-- Column-level grants — the part RLS cannot express
-- ---------------------------------------------------------------------
REVOKE ALL ON transfers FROM authenticated;
GRANT SELECT, INSERT, DELETE ON transfers TO authenticated;
GRANT UPDATE (status) ON transfers TO authenticated;

REVOKE ALL ON debts FROM authenticated;
GRANT SELECT, INSERT ON debts TO authenticated;
GRANT UPDATE (status, paid_at, paid_by_profile_id) ON debts TO authenticated;

-- ---------------------------------------------------------------------
-- Views: privacy of money
-- ---------------------------------------------------------------------
-- The views were created WITH (security_invoker = true), so they inherit
-- every policy above. What is left is who may see the `net` column.
REVOKE ALL ON group_leaderboard_v FROM authenticated;
GRANT SELECT ON group_leaderboard_public_v TO authenticated;
GRANT SELECT ON game_results_v TO authenticated;

-- Your own money, in every group you belong to. This is the only path by
-- which a member ever reads a cumulative net figure.
CREATE OR REPLACE VIEW my_group_stats_v
WITH (security_invoker = true) AS
SELECT l.group_id, l.display_name, l.games_played, l.wins, l.net, l.rank, l.display_order
FROM group_leaderboard_v l
WHERE l.identity_key = 'u:' || app_current_profile_id()::text;
COMMENT ON VIEW my_group_stats_v IS 'The signed-in member''s own leaderboard row, money included. Everyone else''s money is unreachable from the client.';
GRANT SELECT ON my_group_stats_v TO authenticated;

-- ---------------------------------------------------------------------
-- Realtime (Supabase) — same privacy rules on the wire
-- ---------------------------------------------------------------------
-- Postgres Changes respects RLS on the publication, so a member only
-- receives rows they could have selected. For a private Broadcast channel
-- named game:<gameId>, add a policy on realtime.messages:
--
--   CREATE POLICY realtime_game_channel ON realtime.messages
--     FOR SELECT TO authenticated
--     USING (app_can_read_game(split_part(realtime.topic(), ':', 2)::uuid));
--
-- On a non-Supabase deployment there is no realtime schema; the adapter
-- described in frontend-seam.md is the only place that changes.

-- ---------------------------------------------------------------------
-- Smoke checks to run after applying this file
-- ---------------------------------------------------------------------
-- 1. Every public table has RLS on:
--      SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
--    Expected: zero rows.
-- 2. Every view runs as the invoker:
--      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--      WHERE n.nspname = 'public' AND c.relkind = 'v'
--        AND NOT COALESCE((SELECT option_value = 'true' FROM pg_options_to_table(c.reloptions)
--                          WHERE option_name = 'security_invoker'), false);
--    Expected: zero rows.
-- 3. As a signed-in member of group A, SELECT on a group B game returns 0 rows.
-- 4. As a debtor, UPDATE debts SET status='paid' fails; as the creditor it succeeds.
-- 5. As any member, UPDATE entries of a closed game fails on the trigger.
