-- =====================================================================
-- "סוגרים קופה" — linking a guest identity to a real account
-- Run AFTER docs/backend/schema.sql, docs/backend/rls-policies.sql and
-- docs/backend/join-invite.sql. Idempotent: re-running only replaces the
-- functions, the table and its policies/grants (CREATE TABLE IF NOT EXISTS,
-- CREATE OR REPLACE, DROP POLICY IF EXISTS before each CREATE POLICY).
-- =====================================================================
--
-- THE PROBLEM
-- Someone who never signed in exists only as a `guests` row created by
-- whoever first added them to a table, yet they accumulate real history:
-- game_participants, debts, group_members, even a game's leader_guest_id.
-- The moment they sign in with Google they get a fresh, empty `profiles`
-- row and see nothing — their history sits under a guest id they have no
-- link to, and their friends still see the old guest name. One human now
-- appears twice.
--
-- WHY NOT JUST SET guests.linked_profile_id AND JOIN THROUGH IT
-- schema.sql's own comment on guests.linked_profile_id says the merge is
-- "applied once and never rewriting history rows" — i.e. resolve the link
-- at query time. That would require every reader of game_participants,
-- group_members, debts and the leaderboard views to know how to chase a
-- guest's link, which the frontend adapters (getGroupSummaries,
-- buildLeaderboard, the debts screens) do not do and are not asked to
-- learn here (HANDOFF.md: no changes to settle()/tableBalance()/
-- buildHistoryEntry()/buildDebtRecords()/the close-table flow). Physically
-- re-pointing the FK columns instead means every existing RLS policy
-- (debts_select_parties, group_members_select, app_is_group_admin, …) and
-- every existing view (game_results_v, group_leaderboard_v) keeps working
-- unchanged the instant the merge commits — "the next pull shows merged
-- history" is then just the ordinary pull doing what it already does, not
-- new merge logic. guests.linked_profile_id / linked_at are still set at
-- the end of app_approve_guest_claim below: not for query-time resolution,
-- but as the idempotency marker and audit trail schema.sql already shaped
-- a column for.
--
-- AUTHORIZATION RULE — why this shape and no other
-- Never auto-merge by name: names collide, and a wrong merge hands one
-- person another person's debts. So the claim is a two-party consent flow,
-- exactly like guests_update_creator's own comment in rls-policies.sql
-- anticipates ("must be a SECURITY DEFINER RPC that verifies both sides
-- consented"):
--   * REQUESTED by the signing-in user, acting only as app_current_profile_id()
--     — app_request_guest_claim never takes a target profile id parameter,
--     so a caller can request a claim only for themselves. A request is
--     cheap and not itself a trust decision (mirrors app_redeem_invite:
--     any signed-in user may attempt it), because nothing it does is
--     visible to anyone but the claimant and whoever below can approve it.
--   * APPROVED only by someone with standing over the GUEST side of the
--     merge: the guest's own creator (created_by — the one person who
--     definitely knows who they added), or an active admin of a group the
--     guest belongs to (the person responsible for that table's roster).
--     A plain active member (not admin) does NOT qualify — the bar is the
--     same "who may act on this guest" bar the app already uses for
--     removing/promoting a member. The claimant is explicitly never their
--     own approver (checked in app_approve_guest_claim even if they somehow
--     also hold one of those roles), so a user can never unilaterally
--     absorb an arbitrary guest — the second, independent human is
--     mandatory in every code path, not just the common one.
-- This mirrors join-invite.sql's own reasoning: RLS on group_members and
-- guests already refuses the direct writes this needs (group_members_
-- update_admin is admin-only; a plain UPDATE of guests cannot safely
-- re-point four other tables in one transaction), so a SECURITY DEFINER
-- function is the only legitimate door in, and it is written to enforce
-- exactly the rule above and nothing looser.
--
-- The vendor seam is unchanged: app_current_profile_id() (defined in
-- rls-policies.sql) is the only place that knows about auth.uid(); every
-- function below calls it, never auth.uid() directly.

-- ---------------------------------------------------------------------
-- 1. The pending-claim table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guest_claims (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id                        uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  claimant_profile_id             uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Frozen at request time (same idea as group_members.display_name_snapshot): the approver may
  -- share no group and no friendship with the claimant yet, so a live profiles SELECT could
  -- legitimately return nothing. The function that inserts this row reads profiles with definer
  -- rights, so the name is always available to render "X מבקש/ת לקשר" regardless of RLS.
  claimant_display_name_snapshot  text NOT NULL,
  status                          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at                    timestamptz NOT NULL DEFAULT now(),
  responded_at                    timestamptz,
  responded_by_profile_id         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  CONSTRAINT guest_claims_responded_chk CHECK ((status = 'pending') = (responded_at IS NULL))
);
COMMENT ON TABLE guest_claims IS
  'A request to re-point one guest''s history onto a real account. requested by claimant_profile_id (app_request_guest_claim), approved/declined only by the guest''s creator or an admin of a group the guest belongs to (app_approve_guest_claim / app_decline_guest_claim) — never by the claimant themselves.';

-- One claim in flight per guest at a time — a second person requesting the same guest while a
-- claim is pending gets a clear "claim-in-progress" answer instead of a second competing row.
-- A guest that was declined, or whose earlier claimant gave up, can be requested again (the
-- previous row simply is not 'pending' any more).
CREATE UNIQUE INDEX IF NOT EXISTS guest_claims_pending_guest_uk
  ON guest_claims (guest_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS guest_claims_guest_idx    ON guest_claims (guest_id);
CREATE INDEX IF NOT EXISTS guest_claims_claimant_idx ON guest_claims (claimant_profile_id);

-- ---------------------------------------------------------------------
-- 2. Standing to approve/decline a claim on one guest
-- ---------------------------------------------------------------------
-- SECURITY DEFINER, same reason as app_is_group_admin etc. in rls-policies.sql: a policy on
-- guest_claims must not itself read group_members/guests through RLS (recursion), and this one
-- predicate is shared by the SELECT policy below and by app_approve_guest_claim /
-- app_decline_guest_claim, so the two can never disagree about who qualifies.
CREATE OR REPLACE FUNCTION app_can_approve_guest_claim(p_guest_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM guests g WHERE g.id = p_guest_id AND g.created_by = app_current_profile_id()
  ) OR EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.guest_id = p_guest_id
      AND gm.status = 'active'
      AND app_is_group_admin(gm.group_id)
  )
$$;
COMMENT ON FUNCTION app_can_approve_guest_claim(uuid) IS
  'Standing to approve/decline a claim on this guest: the guest''s own creator, or an active admin of a group the guest is an active member of. Never the claimant — that is checked separately.';

-- ---------------------------------------------------------------------
-- 3. RLS — guest_claims is entirely RPC-mediated
-- ---------------------------------------------------------------------
-- No INSERT/UPDATE/DELETE policy at all, on purpose (same pattern as invites redemption in
-- join-invite.sql: group_members_insert_admin still refuses a joiner's self-insert, so the RPC
-- stays the only door in). Every write to this table happens inside a SECURITY DEFINER function
-- below, which runs with the table owner's rights and so bypasses RLS for its own writes. A plain
-- client .insert()/.update() against guest_claims is refused outright, not just narrowed.
ALTER TABLE guest_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS guest_claims_select ON guest_claims;
CREATE POLICY guest_claims_select ON guest_claims FOR SELECT TO authenticated
  USING (
    claimant_profile_id = app_current_profile_id()
    OR app_can_approve_guest_claim(guest_id)
  );

-- ---------------------------------------------------------------------
-- 4. app_request_guest_claim — "זה אני"
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_request_guest_claim(p_guest_id uuid)
RETURNS TABLE (claim_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimant uuid;
  v_name     text;
  v_guest    guests%ROWTYPE;
  v_existing guest_claims%ROWTYPE;
  v_new_id   uuid;
BEGIN
  -- The caller must be a real signed-in profile, and always acts as themselves: there is no
  -- p_profile_id parameter to spoof, exactly like app_redeem_invite's own v_profile_id := ...
  v_claimant := app_current_profile_id();
  IF v_claimant IS NULL THEN
    RAISE EXCEPTION 'app_request_guest_claim: no signed-in profile' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_guest FROM guests g WHERE g.id = p_guest_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'not-found'::text;
    RETURN;
  END IF;

  IF v_guest.linked_profile_id IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid,
      (CASE WHEN v_guest.linked_profile_id = v_claimant THEN 'already-you' ELSE 'already-linked' END)::text;
    RETURN;
  END IF;

  -- Idempotent: tapping "זה אני" again while my own request is still pending returns the same
  -- row instead of erroring on guest_claims_pending_guest_uk.
  SELECT * INTO v_existing FROM guest_claims c
   WHERE c.guest_id = p_guest_id AND c.status = 'pending' FOR UPDATE;
  IF FOUND THEN
    IF v_existing.claimant_profile_id = v_claimant THEN
      RETURN QUERY SELECT v_existing.id, 'pending'::text;
    ELSE
      RETURN QUERY SELECT NULL::uuid, 'claim-in-progress'::text;
    END IF;
    RETURN;
  END IF;

  SELECT p.display_name INTO v_name FROM profiles p WHERE p.id = v_claimant;
  IF v_name IS NULL OR btrim(v_name) = '' THEN v_name := 'שחקן'; END IF;

  INSERT INTO guest_claims (guest_id, claimant_profile_id, claimant_display_name_snapshot)
  VALUES (p_guest_id, v_claimant, v_name)
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, 'pending'::text;
END;
$$;
COMMENT ON FUNCTION app_request_guest_claim(uuid) IS
  'Request to claim guest p_guest_id as the signed-in caller. Status: pending | already-you | already-linked | claim-in-progress | not-found. Never merges anything by itself — see app_approve_guest_claim.';

REVOKE ALL ON FUNCTION app_request_guest_claim(uuid) FROM public;
REVOKE ALL ON FUNCTION app_request_guest_claim(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_request_guest_claim(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. app_approve_guest_claim — the actual merge
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_approve_guest_claim(p_claim_id uuid)
RETURNS TABLE (status text, guest_id uuid, claimant_profile_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_approver uuid;
  v_guest_id uuid;
  v_claim    guest_claims%ROWTYPE;
  v_guest    guests%ROWTYPE;
BEGIN
  v_approver := app_current_profile_id();
  IF v_approver IS NULL THEN
    RAISE EXCEPTION 'app_approve_guest_claim: no signed-in profile' USING ERRCODE = '28000';
  END IF;

  -- Unlocked peek, only to learn which guest this claim is about.
  SELECT guest_id INTO v_guest_id FROM guest_claims WHERE id = p_claim_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not-found'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- Lock guests BEFORE guest_claims — the same order app_request_guest_claim locks them in, so
  -- two concurrent calls (a request racing an approval, or two approvals) serialize instead of
  -- deadlocking on opposite lock orders.
  SELECT * INTO v_guest FROM guests g WHERE g.id = v_guest_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_approve_guest_claim: guest % no longer exists', v_guest_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT * INTO v_claim FROM guest_claims c WHERE c.id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not-found'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- Idempotent replay: a retried call (or a double tap that lands after the first one already
  -- committed) returns the same success without re-running the merge or the authorization check.
  IF v_claim.status = 'approved' THEN
    RETURN QUERY SELECT 'approved'::text, v_claim.guest_id, v_claim.claimant_profile_id;
    RETURN;
  END IF;
  IF v_claim.status = 'rejected' THEN
    RETURN QUERY SELECT 'already-rejected'::text, v_claim.guest_id, v_claim.claimant_profile_id;
    RETURN;
  END IF;

  -- Authorization: standing over the GUEST side is mandatory, and the claimant is never their own
  -- approver even if they also happen to hold that standing — a user must never unilaterally
  -- absorb an arbitrary guest via any code path.
  IF v_approver = v_claim.claimant_profile_id OR NOT app_can_approve_guest_claim(v_claim.guest_id) THEN
    RAISE EXCEPTION 'GUEST_CLAIM_NOT_AUTHORIZED: % is not the guest''s creator or a group admin', v_approver
      USING ERRCODE = '42501';
  END IF;

  IF v_guest.linked_profile_id IS NOT NULL AND v_guest.linked_profile_id <> v_claim.claimant_profile_id THEN
    -- Someone else's claim on this guest was approved first (e.g. two admins raced). Refuse
    -- rather than silently re-link over an existing merge.
    RAISE EXCEPTION 'GUEST_CLAIM_ALREADY_LINKED: guest % is already linked to a different account', v_claim.guest_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The core safety rule: never seat the same person twice in one game. If the claimant already
  -- sits at any table the guest also sits at (as a separate participant row), the whole claim is
  -- refused — nothing below has run yet, so there is nothing to undo.
  IF EXISTS (
    SELECT 1
    FROM game_participants gp_guest
    JOIN game_participants gp_claimant
      ON gp_claimant.game_id = gp_guest.game_id
     AND gp_claimant.profile_id = v_claim.claimant_profile_id
    WHERE gp_guest.guest_id = v_claim.guest_id
  ) THEN
    RAISE EXCEPTION 'GUEST_CLAIM_DOUBLE_SEAT: claimant already sits at a table alongside guest %', v_claim.guest_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- game_participants: guarded above (game_participants_identity_chk, game_participants_profile_uk).
  UPDATE game_participants
     SET profile_id = v_claim.claimant_profile_id, guest_id = NULL
   WHERE guest_id = v_claim.guest_id;

  -- debts: debtor and creditor move independently (debts_debtor_identity_chk /
  -- debts_creditor_identity_chk). debts_distinct_chk can never fire here: a debt only exists
  -- between two participants of the same game, and the double-seat guard above already refused
  -- any game where the claimant and this guest are both seated.
  UPDATE debts
     SET debtor_profile_id = v_claim.claimant_profile_id, debtor_guest_id = NULL
   WHERE debtor_guest_id = v_claim.guest_id;
  UPDATE debts
     SET creditor_profile_id = v_claim.claimant_profile_id, creditor_guest_id = NULL
   WHERE creditor_guest_id = v_claim.guest_id;

  -- games.leader_*: games_leader_identity_chk allows both null, never a uniqueness conflict.
  UPDATE games
     SET leader_profile_id = v_claim.claimant_profile_id, leader_guest_id = NULL
   WHERE leader_guest_id = v_claim.guest_id;

  -- group_members: skip only the rows where the claimant already holds an INDEPENDENT active
  -- membership in that same group (group_members_active_profile_uk would otherwise reject the
  -- row) rather than aborting the whole claim over one group. This is the common real path: the
  -- claimant often has to join a group under their own account before they can even see the old
  -- guest there to claim it (guests_select requires being an active member of a group the guest
  -- belongs to). Skipping still leaves the merge correct: game_participants/debts above already
  -- carry that group's history onto the claimant's OWN membership row via identity_key(), so the
  -- leaderboard and history are complete even when the guest's own row is left alone. Every other
  -- row (a different group, or a former/removed guest membership) re-points normally.
  UPDATE group_members gm
     SET profile_id = v_claim.claimant_profile_id, guest_id = NULL
   WHERE gm.guest_id = v_claim.guest_id
     AND NOT (
       gm.status = 'active'
       AND EXISTS (
         SELECT 1 FROM group_members other
         WHERE other.group_id = gm.group_id
           AND other.profile_id = v_claim.claimant_profile_id
           AND other.status = 'active'
       )
     );

  -- transfers and entries carry no guest_id/profile_id of their own — only participant_id /
  -- from_participant_id / to_participant_id, immutable references to game_participants.id — so
  -- they automatically point at the right identity the moment game_participants moves above.
  -- entries.created_by is who RECORDED the buy-in (always a profile — a guest has no session to
  -- record one with), not whose buy-in it was; it is left untouched, same as every other name
  -- snapshot below.
  --
  -- display_name_snapshot (group_members, game_participants) and debtor_name/creditor_name
  -- (debts) are deliberately NOT rewritten: they are frozen history, the same "a rename never
  -- rewrites old screens" rule schema.sql already documents for display_name_snapshot.

  UPDATE guests
     SET linked_profile_id = v_claim.claimant_profile_id, linked_at = now()
   WHERE id = v_claim.guest_id;

  UPDATE guest_claims
     SET status = 'approved', responded_at = now(), responded_by_profile_id = v_approver
   WHERE id = p_claim_id;

  RETURN QUERY SELECT 'approved'::text, v_claim.guest_id, v_claim.claimant_profile_id;
END;
$$;
COMMENT ON FUNCTION app_approve_guest_claim(uuid) IS
  'Approve a pending guest claim: re-points game_participants/debts/games.leader_*/group_members from guest_id to profile_id, keeping every balance identical. Only the guest''s creator or an active admin of one of the guest''s groups may call this, and never the claimant. Idempotent; refuses (no partial effect) on GUEST_CLAIM_DOUBLE_SEAT, GUEST_CLAIM_ALREADY_LINKED or GUEST_CLAIM_NOT_AUTHORIZED.';

REVOKE ALL ON FUNCTION app_approve_guest_claim(uuid) FROM public;
REVOKE ALL ON FUNCTION app_approve_guest_claim(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_approve_guest_claim(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 6. app_decline_guest_claim — "דחה" (the approver), or withdrawing my own request
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_decline_guest_claim(p_claim_id uuid)
RETURNS TABLE (status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
  v_claim  guest_claims%ROWTYPE;
BEGIN
  v_caller := app_current_profile_id();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'app_decline_guest_claim: no signed-in profile' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_claim FROM guest_claims c WHERE c.id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not-found'::text;
    RETURN;
  END IF;

  -- Idempotent: declining an already-resolved claim just reports what it already is.
  IF v_claim.status <> 'pending' THEN
    RETURN QUERY SELECT v_claim.status;
    RETURN;
  END IF;

  -- Either party may end a pending claim: the claimant withdrawing "זה אני" (mirrors
  -- friendships_delete_requester), or whoever has approval standing saying "לא".
  IF v_caller <> v_claim.claimant_profile_id AND NOT app_can_approve_guest_claim(v_claim.guest_id) THEN
    RAISE EXCEPTION 'GUEST_CLAIM_NOT_AUTHORIZED: % may not decline claim %', v_caller, p_claim_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE guest_claims
     SET status = 'rejected', responded_at = now(), responded_by_profile_id = v_caller
   WHERE id = p_claim_id;

  RETURN QUERY SELECT 'rejected'::text;
END;
$$;
COMMENT ON FUNCTION app_decline_guest_claim(uuid) IS
  'Decline or withdraw a pending guest claim. Callable by the claimant (withdraw) or by whoever has app_can_approve_guest_claim standing (decline). Idempotent on an already-resolved claim.';

REVOKE ALL ON FUNCTION app_decline_guest_claim(uuid) FROM public;
REVOKE ALL ON FUNCTION app_decline_guest_claim(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_decline_guest_claim(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- KNOWN GAP, documented rather than patched blind (see report for why):
-- guests_update_creator in rls-policies.sql grants the guest's creator UPDATE on the whole row,
-- which technically also covers linked_profile_id/linked_at — RLS cannot express "every column
-- except these two". Column-level GRANT UPDATE (display_name, created_by) ON guests would close
-- it (created_by must stay grantable: guestToRow's push payload always includes it, even unchanged,
-- and a column absent from the grant fails PostgREST's upsert on any re-send of an existing guest
-- row), but that needs verifying against the actual generated UPDATE column list of a real
-- ON CONFLICT DO UPDATE upsert before shipping — this file changes no SQL that was not asked for
-- and cannot be run to verify here. Until applied, a guest's own creator could in principle set
-- linked_profile_id directly, bypassing the checks above; the blast radius is narrow (it requires
-- being that specific guest's creator already, and a direct UPDATE alone moves no game_participants/
-- debts/group_members row — app_approve_guest_claim is still the only path that does) but real
-- enough to fix in a follow-up once verified in a staging project.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- HOW TO VERIFY (SQL editor or the app, two accounts + a helper)
-- ---------------------------------------------------------------------
-- Setup: as account A (helper/admin), create a group, add a guest "אורי" to it
-- (or play a game with "אורי" as an ad-hoc guest — either way A is guests.created_by).
-- Note the guest's id:
--   SELECT id FROM guests WHERE display_name = 'אורי';               -- <GUEST>
--
-- 1. As account B (the real Uri, a second signed-in account, sharing the group with A —
--    e.g. via an invite link), request the claim:
--      SELECT * FROM app_request_guest_claim('<GUEST>');
--    Expect: (some claim id, 'pending').
--
-- 2. Re-run the same call as B → ('<same claim id>', 'pending') — idempotent, no second row:
--      SELECT count(*) FROM guest_claims WHERE guest_id = '<GUEST>';   -- must stay 1
--
-- 3. As account A (the creator — or any active admin of the shared group), approve it:
--      SELECT * FROM app_approve_guest_claim('<claim id from step 1>');
--    Expect: ('approved', '<GUEST>', '<B's profile id>').
--    Check the merge landed and nothing moved money-wise:
--      SELECT profile_id, guest_id FROM game_participants WHERE profile_id = '<B>' OR guest_id = '<GUEST>';
--      SELECT debtor_profile_id, creditor_profile_id FROM debts
--       WHERE debtor_profile_id = '<B>' OR creditor_profile_id = '<B>';
--      -- every row that used to say guest_id = <GUEST> now says profile_id = <B>, amounts unchanged.
--
-- 4. Re-run step 3 as A → ('approved', …) again, same values, no error — idempotent replay.
--
-- 5. Negative — a stranger may not approve:
--    As account C (some third signed-in account, not the creator and not an admin of any group
--    the guest belongs to), on a FRESH guest/claim pair:
--      SELECT * FROM app_approve_guest_claim('<a pending claim id>');
--    Expect: an error starting with GUEST_CLAIM_NOT_AUTHORIZED.
--
-- 6. Negative — a user may never approve their own claim, even if they somehow also have
--    standing (e.g. B is themselves an admin of the shared group):
--      -- as B: SELECT * FROM app_approve_guest_claim('<B's own pending claim id>');
--    Expect: GUEST_CLAIM_NOT_AUTHORIZED.
--
-- 7. Negative — double seat: have B ALSO be seated (their own profile_id) in a game that guest
--    <GUEST> played in, then approve the pending claim on <GUEST>.
--    Expect: GUEST_CLAIM_DOUBLE_SEAT, and nothing changed —
--      SELECT guest_id FROM game_participants WHERE guest_id = '<GUEST>';   -- still there
--
-- 8. RLS is untouched: as a fourth account D with no relation to the guest or its groups,
--      SELECT * FROM guest_claims WHERE guest_id = '<GUEST>';   -- must return 0 rows
