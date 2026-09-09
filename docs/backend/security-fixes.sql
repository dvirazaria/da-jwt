-- =====================================================================
-- "סוגרים קופה" — security-fixes.sql
-- Adversarial RLS review, 2026-09-09. See docs/backend/security-review-2026-09-09.md
-- for the full writeup (attack, evidence, severity) behind every block below.
--
-- Run AFTER, in this order: schema.sql, rls-policies.sql, join-invite.sql,
-- fix-upsert-policies.sql — i.e. paste this file last, on top of the current
-- production state. Idempotent: every statement is CREATE OR REPLACE / DROP
-- POLICY IF EXISTS / REVOKE+GRANT, safe to run more than once.
--
-- DO NOT RUN THIS FILE. It is reviewed and executed by the project owner.
--
-- Sections F3 and (part of) F5 are DEFERRED on purpose — see their banners.
-- Applying them before the matching kupa-sgura.html change ships would
-- visibly break a currently-working screen. Everything else is safe to run
-- immediately: each fix only removes access the legitimate client never
-- uses (verified against kupa-sgura.html's actual query shapes), so no
-- product behaviour changes for a non-attacker.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- F4 (MEDIUM) — every RLS helper function is missing EXECUTE revocation.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. None of
-- the nine helpers below (app_current_profile_id + the eight SECURITY
-- DEFINER predicates in rls-policies.sql) ever revoked it, so they are
-- callable via PostgREST RPC by literally anyone — proven live: every one
-- of the nine returned HTTP 200 to a fully anonymous request carrying only
-- the public anon key (docs/backend/security-review-2026-09-09.md §F4).
-- app_redeem_invite (join-invite.sql) already does this correctly; these
-- never got the same treatment. `authenticated` keeps EXECUTE — every RLS
-- policy in rls-policies.sql calls one of these, so revoking authenticated
-- too would break every policy check for real signed-in users.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION app_current_profile_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_current_profile_id() FROM anon;
GRANT EXECUTE ON FUNCTION app_current_profile_id() TO authenticated;

REVOKE ALL ON FUNCTION app_is_active_group_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_active_group_member(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_is_active_group_member(uuid) TO authenticated;

REVOKE ALL ON FUNCTION app_is_group_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_group_admin(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_is_group_admin(uuid) TO authenticated;

REVOKE ALL ON FUNCTION app_is_game_participant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_game_participant(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_is_game_participant(uuid) TO authenticated;

REVOKE ALL ON FUNCTION app_can_read_game(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_can_read_game(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_can_read_game(uuid) TO authenticated;

REVOKE ALL ON FUNCTION app_can_write_game(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_can_write_game(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_can_write_game(uuid) TO authenticated;

REVOKE ALL ON FUNCTION app_shares_group_with(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shares_group_with(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_shares_group_with(uuid) TO authenticated;

REVOKE ALL ON FUNCTION app_group_has_no_members(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_group_has_no_members(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_group_has_no_members(uuid) TO authenticated;

REVOKE ALL ON FUNCTION app_is_friend_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_friend_of(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_is_friend_of(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- F7 (LOW) — app_current_profile_id() is the one helper with no pinned
-- search_path. Practically inert (its only identifier, auth.uid(), is
-- already schema-qualified, and the function is SECURITY INVOKER, not
-- DEFINER), but a CREATE OR REPLACE that only adds the pin cannot change
-- its behaviour, so there is no reason not to match the other eight.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT auth.uid()
$$;

-- ---------------------------------------------------------------------
-- F1 (CRITICAL) — fabricated debts against an arbitrary victim.
--
-- debts_insert_on_close checked only that the CALLER may write the
-- referenced game; it never checked that debtor_profile_id /
-- creditor_profile_id actually played in it. Unlike transfers (FK-anchored
-- to game_participants via from_participant_id/to_participant_id, so it
-- cannot name a non-participant), debts stores bare profile/guest uuids
-- with no such tie. Any authenticated user who creates or belongs to a
-- game's group can INSERT a debts row naming any known profile_id as
-- debtor or creditor, for any amount — and the victim sees it on their own
-- Profile > Debts screen via the correctly-scoped debts_select_parties
-- policy, which only checks "am I one of the two named parties". Reasoned
-- and demonstrated on paper / via the --destructive probe script
-- (tools/rls-probe.mjs); NOT executed against production by this review.
--
-- Fix: both parties of a new debt must already be real game_participants
-- of that game (matched by identity_key, so it works for profile or guest
-- identities alike). This is exactly the set of identities the legitimate
-- settlement-close flow ever names, so no product behaviour changes.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS debts_insert_on_close ON debts;
CREATE POLICY debts_insert_on_close ON debts FOR INSERT TO authenticated
  WITH CHECK (
    status = 'open' AND paid_at IS NULL
    AND EXISTS (SELECT 1 FROM games g
                WHERE g.id = game_id
                  AND (g.created_by = app_current_profile_id()
                       OR (g.group_id IS NOT NULL AND app_is_active_group_member(g.group_id))))
    AND EXISTS (SELECT 1 FROM game_participants gp
                WHERE gp.game_id = debts.game_id
                  AND identity_key(gp.profile_id, gp.guest_id)
                    = identity_key(debts.debtor_profile_id, debts.debtor_guest_id))
    AND EXISTS (SELECT 1 FROM game_participants gp
                WHERE gp.game_id = debts.game_id
                  AND identity_key(gp.profile_id, gp.guest_id)
                    = identity_key(debts.creditor_profile_id, debts.creditor_guest_id))
  );

-- ---------------------------------------------------------------------
-- F2 (HIGH) — forged game participation.
--
-- game_participants_insert / _update only ever checked app_can_write_game
-- (game_id) — whether the CALLER may write the game — never that the
-- profile_id being named is the caller themselves or has any relationship
-- to the game's group. Any writer of a game (any active member of its
-- group, or its creator) could attribute buy-ins/cashouts, and via F1 a
-- fabricated debt, to an arbitrary real profile_id who never sat at that
-- table and may not even share a group with the attacker.
--
-- Fix: a profile_id participant row may only be inserted/retargeted to
-- (a) the caller themselves, or (b) an existing ACTIVE member of the same
-- group the game belongs to — exactly the set HANDOFF.md describes the
-- "התחל משחק" participant picker drawing from (checkbox rows over active
-- members). Guest rows are untouched: a guest has no account of its own,
-- so "someone else adds them" is the correct, intended cooperative model.
-- Ad-hoc games (group_id IS NULL) have no membership roster to check
-- against, so they fall back to self-or-guest only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_profile_is_active_group_member(p_group_id uuid, p_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM group_members m
    WHERE m.group_id = p_group_id
      AND m.status = 'active'
      AND m.profile_id = p_profile_id
  )
$$;
REVOKE ALL ON FUNCTION app_profile_is_active_group_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_profile_is_active_group_member(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_profile_is_active_group_member(uuid, uuid) TO authenticated;
COMMENT ON FUNCTION app_profile_is_active_group_member(uuid, uuid) IS
  'Like app_is_active_group_member(), but checks an arbitrary target profile instead of the caller — used to verify the SUBJECT of a game_participants row, not the writer of it.';

DROP POLICY IF EXISTS game_participants_insert ON game_participants;
CREATE POLICY game_participants_insert ON game_participants FOR INSERT TO authenticated
  WITH CHECK (
    app_can_write_game(game_id)
    AND (
      guest_id IS NOT NULL
      OR profile_id = app_current_profile_id()
      OR EXISTS (SELECT 1 FROM games g
                 WHERE g.id = game_participants.game_id
                   AND g.group_id IS NOT NULL
                   AND app_profile_is_active_group_member(g.group_id, game_participants.profile_id))
    )
  );

DROP POLICY IF EXISTS game_participants_update ON game_participants;
CREATE POLICY game_participants_update ON game_participants FOR UPDATE TO authenticated
  USING (app_can_write_game(game_id))
  WITH CHECK (
    app_can_write_game(game_id)
    AND (
      guest_id IS NOT NULL
      OR profile_id = app_current_profile_id()
      OR EXISTS (SELECT 1 FROM games g
                 WHERE g.id = game_participants.game_id
                   AND g.group_id IS NOT NULL
                   AND app_profile_is_active_group_member(g.group_id, game_participants.profile_id))
    )
  );
-- Note: fix-upsert-policies.sql's extra "OR EXISTS (... g.created_by = ...)"
-- branch on this policy was already pure redundancy, not a widening — both
-- USING and WITH CHECK went through app_can_write_game(game_id), which has
-- always had its own "g.created_by = app_current_profile_id()" branch built
-- in (rls-policies.sql). Dropped here for clarity; nothing was relying on
-- the duplicate.

-- ---------------------------------------------------------------------
-- F6 (MEDIUM) — permanent creator/founder power surviving demotion, plus
-- a cross-group games.group_id hijack. All four policies below are
-- fix-upsert-policies.sql's replacements; all four added an unconditional
-- "OR I am the row's/group's original creator" branch to a policy that
-- used to require the CURRENT admin/membership state. That branch was
-- meant to fix the same INSERT-then-UPDATE upsert-visibility problem that
-- commit 9eafade fixed client-side (STABLE SECURITY DEFINER helpers can't
-- see a row the same statement is still inserting) — but 9eafade's actual
-- fix was in kupa-sgura.html's splitCloudWrites(): a brand-new row now
-- always goes up as INSERT ... ON CONFLICT DO NOTHING, so it never reaches
-- the UPDATE arm at all. groups / group_members / invites / games are all
-- outside CLOUD_INSERT_ONLY (kupa-sgura.html), i.e. all four already go
-- through splitCloudWrites — so the UPDATE-arm-only scenario these
-- branches compensate for no longer happens from the real client, and the
-- branches are pure liability:
--
--   * games_update_member — the creator branch sat in WITH CHECK with no
--     scoping to the game's OWN group, so a game's creator could UPDATE
--     games SET group_id = <any other group> at any time before close,
--     regardless of membership in the destination group. Since
--     games_one_open_per_group_uk allows at most one non-closed game per
--     group, this is a griefing/DoS primitive against a group the
--     attacker was never even a member of: park a throwaway game on its
--     group_id and its real members can no longer start a table until
--     the phantom is dealt with. Reasoned statically; not run against
--     production (would create a real row).
--   * groups_update_admin / group_members_update_admin — a group's
--     original creator keeps the power to rename/archive/soft-delete the
--     group, or to change ANY member's role (including re-promoting
--     themselves to admin), forever — even after being legitimately
--     demoted or removed by the group's current admins.
--   * invites_update_admin — narrower: the creator of one specific invite
--     keeps the power to revoke/edit that invite after losing admin.
--
-- Fix: revert all four to their pre-fix-upsert-policies.sql wording (drop
-- the creator branch). The SELECT-side additions from fix-upsert-
-- policies.sql (games_select, group_members_select) are NOT touched here
-- — those only grant read access to your own past creation, which is
-- benign and does not need reverting.
--
-- Verify after applying: repeat steps 2-4 of fix-upsert-policies.sql's own
-- "HOW TO VERIFY" section (a fresh game/group upsert must still succeed
-- with no 42501). If it does not, STOP and re-open this finding instead of
-- forcing these branches back — see docs/backend/security-review-2026-09-09.md §F6.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS games_update_member ON games;
CREATE POLICY games_update_member ON games FOR UPDATE TO authenticated
  USING (phase <> 'closed'
         AND (group_id IS NULL OR app_is_active_group_member(group_id))
         AND (app_can_read_game(id)))
  WITH CHECK (group_id IS NULL OR app_is_active_group_member(group_id));

DROP POLICY IF EXISTS groups_update_admin ON groups;
CREATE POLICY groups_update_admin ON groups FOR UPDATE TO authenticated
  USING (app_is_group_admin(id))
  WITH CHECK (app_is_group_admin(id));

DROP POLICY IF EXISTS group_members_update_admin ON group_members;
CREATE POLICY group_members_update_admin ON group_members FOR UPDATE TO authenticated
  USING (app_is_group_admin(group_id))
  WITH CHECK (app_is_group_admin(group_id));

DROP POLICY IF EXISTS invites_update_admin ON invites;
CREATE POLICY invites_update_admin ON invites FOR UPDATE TO authenticated
  USING (app_is_group_admin(group_id))
  WITH CHECK (app_is_group_admin(group_id));

-- ---------------------------------------------------------------------
-- F5 (MEDIUM), active half — profiles.phone is schema-provisioned but
-- confirmed unused anywhere in kupa-sgura.html today (no auth path
-- populates it, no query filters on it), so narrowing it away from
-- `authenticated` is a zero-risk hardening step: nothing legitimate
-- reads, writes or filters on it. profiles.email is NOT touched here —
-- see the deferred block below for why.
-- ---------------------------------------------------------------------
REVOKE SELECT (phone) ON profiles FROM authenticated;

COMMIT;

-- =====================================================================
-- DEFERRED — do not run the two sections below without the matching
-- kupa-sgura.html change described in each banner. Applying either one on
-- its own will visibly break a currently-working screen for real users.
-- They are included, ready to paste, for when that follow-up ships.
-- =====================================================================

-- ---------------------------------------------------------------------
-- F5 (MEDIUM), deferred half — profiles.email.
--
-- profiles.email is populated with the real sign-in address on every
-- login (kupa-sgura.html: ensureProfile() upserts { id, display_name,
-- email }) and is fully readable — the whole row, not just id/display_name
-- — by any accepted friend or fellow group member via the row-level
-- profiles_select_friends / profiles_select_group_mates policies, even
-- though the app's own UI never requests another user's email (lookupFriendProfile
-- only ever selects "id,display_name"). Direct REST access is not bound by
-- what the app's JS chooses to ask for.
--
-- This is NOT applied above because lookupFriendProfile's email branch
-- currently does a raw `.from("profiles").select("id,display_name").eq
-- ("email", value)`, and Postgres requires SELECT on a column to filter by
-- it even when the column is not in the returned list — revoking SELECT
-- (email) would break that lookup immediately (tests/friend-requests.test.cjs
-- pins its current shape). The fix needs BOTH sides:
--
--   1. Run the block below (adds a narrow SECURITY DEFINER lookup that
--      returns id/display_name only, gated by the exact same self/friend/
--      group-mate visibility the row policies already encode — so a
--      stranger's email still resolves nothing, same as today).
--   2. Change kupa-sgura.html's lookupFriendProfile so the "email" branch
--      calls `supabase.rpc("app_lookup_profile_by_email", { p_email:
--      parsed.value })` instead of the raw table select, and update
--      tests/friend-requests.test.cjs's "the profile lookup is an exact
--      single-column match" test to match. The "name" branch is untouched.
--   3. Only then run: REVOKE SELECT (email) ON profiles FROM authenticated;
--
-- /*
-- CREATE OR REPLACE FUNCTION app_lookup_profile_by_email(p_email text)
-- RETURNS TABLE (id uuid, display_name text)
-- LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
-- AS $$
--   SELECT p.id, p.display_name
--   FROM profiles p
--   WHERE p.email = p_email
--     AND (p.id = app_current_profile_id()
--          OR app_is_friend_of(p.id)
--          OR app_shares_group_with(p.id))
--   LIMIT 1
-- $$;
-- REVOKE ALL ON FUNCTION app_lookup_profile_by_email(text) FROM PUBLIC;
-- REVOKE ALL ON FUNCTION app_lookup_profile_by_email(text) FROM anon;
-- GRANT EXECUTE ON FUNCTION app_lookup_profile_by_email(text) TO authenticated;
--
-- REVOKE SELECT (email) ON profiles FROM authenticated;
-- */

-- ---------------------------------------------------------------------
-- F3 (HIGH), deferred — within-group per-player P&L exposure.
--
-- entries_select / game_participants_select (which includes `cashout`)
-- and the GRANT SELECT ON game_results_v are all gated only by
-- app_can_read_game(game_id) = "active member of the game's group" — with
-- no requirement that the caller actually played in THIS game. Any active
-- group member can read every other member's individual buy-ins, cashout
-- and net for every game in the group, open or closed, participant or
-- not. HANDOFF.md documents the product rule as the opposite: group
-- history exposes only date/player-count/winner-names/pot/balance-flag
-- (GroupGameSummary) and buildLeaderboard() "never exposes a money field
-- to the renderer" for anyone but yourself. RLS enforces the CROSS-GROUP
-- boundary correctly; it does not enforce this WITHIN-group, per-player
-- one — only the client's rendering choices do. Confirmed the raw data is
-- not just theoretically reachable: kupa-sgura.html's own pullCloud() /
-- fetchCloudGameChildren() already download entries + game_participants
-- for every game across every group the signed-in user belongs to, on
-- every sync, and compute the leaderboard/history LOCALLY on the device —
-- meaning the numbers are already sitting in local storage / IndexedDB on
-- every member's device, inspectable with the browser's own devtools, no
-- crafted request required.
--
-- NOT fixed here: my_group_stats_v and group_leaderboard_public_v already
-- exist as the safe, server-aggregated alternative for the cross-game
-- leaderboard, but pullCloud() does not use them — it still pulls raw
-- entries/game_participants and derives everything client-side. Tightening
-- entries_select / game_participants_select / the game_results_v grant to
-- "participant of THIS game, or its creator" (a one-line change, sketched
-- below) is the correct backend half of the fix, but running it alone,
-- before kupa-sgura.html stops requesting raw entries/game_participants
-- for games the viewer did not play in, will make the group history /
-- leaderboard screen go blank for every closed game the viewer did not
-- personally play. This needs a coordinated frontend change (consume the
-- existing safe views, or a new safe group_game_summaries_v of the same
-- shape as GroupGameSummary) before it can ship — scoping that is a
-- product/engineering decision for the owner, not a same-day SQL patch.
--
-- /*
-- DROP POLICY IF EXISTS entries_select ON entries;
-- CREATE POLICY entries_select ON entries FOR SELECT TO authenticated
--   USING (app_is_game_participant(game_id)
--          OR EXISTS (SELECT 1 FROM games g WHERE g.id = entries.game_id AND g.created_by = app_current_profile_id()));
--
-- DROP POLICY IF EXISTS game_participants_select ON game_participants;
-- CREATE POLICY game_participants_select ON game_participants FOR SELECT TO authenticated
--   USING (app_is_game_participant(game_id)
--          OR EXISTS (SELECT 1 FROM games g WHERE g.id = game_participants.game_id AND g.created_by = app_current_profile_id()));
-- */
-- =====================================================================
