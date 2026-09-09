-- =====================================================================
-- "סוגרים קופה" — linking a guest identity to a real account, v2
-- Run AFTER docs/backend/schema.sql, docs/backend/rls-policies.sql and
-- docs/backend/join-invite.sql (fix-upsert-policies.sql / security-fixes.sql
-- too, if already applied — this file redefines two of their policies on
-- top of whatever they last left, the same layered pattern those two files
-- already use on rls-policies.sql). Idempotent: every statement is
-- ALTER ... ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF
-- EXISTS before each CREATE, safe to paste more than once.
--
-- THIS FILE REPLACES THE PREVIOUS link-guest.sql OUTRIGHT. Nothing from
-- the old version has ever been run against the project (no guest_claims
-- table exists in production, no migration to worry about), so the DROPs
-- near the top are pure cleanup for anyone who pasted the old draft into a
-- scratch/dev project — they are no-ops otherwise.
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
-- WHY THIS VERSION AND NOT A CONSENT/APPROVAL FLOW
-- The previous design (never run) required a second, independent human —
-- the guest's creator or a group admin — to approve a "זה אני" request
-- before anything merged. Safe, but it puts a human approval in the worst
-- possible place: a brand-new user's first minute in the app, staring at
-- an empty screen until someone else acts. The product rule for this
-- version is zero approvals in the happy path, with friction scaled to
-- financial risk instead of applied uniformly. Three paths, in the order
-- they are tried:
--
--   1. INVITE-BOUND LINKING (primary). A member creates an invite and
--      optionally binds it to one existing, unlinked guest of that group
--      ("הזמן את דוד") — kupa-sgura.html's renderInviteGuestBindPicker.
--      Whoever redeems that exact token is linked to that guest
--      automatically, in the same transaction as joining the group. No
--      prompt: the authorization already happened when the member picked
--      that specific person and sent them the link privately.
--   2. VERIFIED CONTACT MATCH (automatic fast path) — NOT SHIPPED THIS
--      PASS. guests carries no phone/email column, and nothing in
--      kupa-sgura.html captures one for a guest today (a guest is only
--      ever added by typed display name — addMemberByName /
--      renderStartGameAddGuest); building the capture UI would mean
--      widening the GroupMember/Player pure data contracts and their
--      whole cloud push/pull mapping, a materially separate feature. See
--      the report for the full reasoning; flagged as a follow-up.
--   3. ZERO-EXPOSURE SELF-CLAIM (fallback). Someone who signs up without
--      a bound invite may claim a matching guest themselves, INSTANTLY —
--      but only when the guest has no open debt and sits in no open or
--      unbalanced game, i.e. claiming it can move no money. If there is
--      any exposure, self-claim is refused (GUEST_LINK_HAS_EXPOSURE) and
--      the app tells the person to ask for a personal invite link
--      instead — friction scales with risk instead of being uniform.
--
-- Every path shares the same re-pointing engine and the same double-seat
-- guard (app_link_guest_to_profile, below) — balances stay identical no
-- matter which door a person came in through, exactly like the design it
-- replaces.
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
-- unchanged the instant the merge commits. guests.linked_profile_id /
-- linked_at are still set at the end of app_link_guest_to_profile: not for
-- query-time resolution, but as the idempotency marker and audit trail
-- schema.sql already shaped a column for.
--
-- THE TOKEN NEVER CARRIES THE GUEST ID
-- invites.bound_guest_id lives only on the invite ROW, set server-side and
-- validated server-side (app_guest_bindable_to_invite, below). The shared
-- link/QR/code is still exactly inviteLink(token, origin, pathname) — see
-- kupa-sgura.html's invites (pure) section — which never takes a guest id
-- and never has: the token is the only thing that travels, and it only
-- resolves to a group (and, internally, a binding) inside the SECURITY
-- DEFINER app_redeem_invite below. invites_select_members still refuses a
-- non-member (i.e. anyone who has not yet redeemed the link) any read of
-- the invites table at all, so bound_guest_id is never even reachable by
-- token — a guesser has nothing to guess against. See the report for the
-- full "why unguessable" writeup.
--
-- The vendor seam is unchanged: app_current_profile_id() (defined in
-- rls-policies.sql) is the only place that knows about auth.uid(); every
-- function below calls it, never auth.uid() directly.
-- =====================================================================

-- Everything below runs as ONE transaction. This file REPLACES app_redeem_invite,
-- which is already live and is the only way anyone joins a group -- a half-applied
-- run could leave that path broken with no obvious symptom. Postgres DDL is
-- transactional, so a failure anywhere rolls the whole file back untouched.
BEGIN;

-- ---------------------------------------------------------------------
-- 0. Remove what this file replaces (the old, never-executed consent flow)
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_decline_guest_claim(uuid);
DROP FUNCTION IF EXISTS app_approve_guest_claim(uuid);
DROP FUNCTION IF EXISTS app_request_guest_claim(uuid);
DROP FUNCTION IF EXISTS app_can_approve_guest_claim(uuid);
DROP TABLE IF EXISTS guest_claims CASCADE;

-- ---------------------------------------------------------------------
-- 1. invites.bound_guest_id — path 1's storage
-- ---------------------------------------------------------------------
ALTER TABLE invites ADD COLUMN IF NOT EXISTS bound_guest_id uuid REFERENCES guests(id) ON DELETE SET NULL;
COMMENT ON COLUMN invites.bound_guest_id IS
  'Set only when a member picked a specific unlinked guest of this group while creating the invite. Never derived from or exposed through the token/link/QR — see the file header. Resolved and cleared (via guests.linked_profile_id, not this column) the moment app_redeem_invite links it.';

CREATE INDEX IF NOT EXISTS invites_bound_guest_id_idx ON invites (bound_guest_id) WHERE bound_guest_id IS NOT NULL;

-- Insert-time-only guard: null is always fine (a general/unbound invite),
-- otherwise the guest must be an active member of THIS group and not yet
-- linked to anyone — the same "who may act on this guest" evidence
-- app_can_read_game/guests_select already require, checked once, at the
-- moment the member expresses the intent.
CREATE OR REPLACE FUNCTION app_guest_bindable_to_invite(p_guest_id uuid, p_group_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_guest_id IS NULL OR EXISTS (
    SELECT 1 FROM guests g
    JOIN group_members gm ON gm.guest_id = g.id AND gm.group_id = p_group_id AND gm.status = 'active'
    WHERE g.id = p_guest_id AND g.linked_profile_id IS NULL
  )
$$;
COMMENT ON FUNCTION app_guest_bindable_to_invite(uuid, uuid) IS
  'Insert-time guard for invites.bound_guest_id — see invites_insert_admin below for why this is deliberately NOT also applied on UPDATE.';

DROP POLICY IF EXISTS invites_insert_admin ON invites;
CREATE POLICY invites_insert_admin ON invites FOR INSERT TO authenticated
  WITH CHECK (
    app_is_group_admin(group_id) AND created_by_profile_id = app_current_profile_id()
    AND app_guest_bindable_to_invite(bound_guest_id, group_id)
  );

-- invites_update_admin is intentionally left exactly as security-fixes.sql last defined it
-- (USING (app_is_group_admin(group_id)) WITH CHECK (app_is_group_admin(group_id)); reproduced
-- below only so this file's own accumulated effect is self-contained, not because anything about
-- it changes). bound_guest_id is deliberately NOT re-validated here: the "still unlinked" half of
-- app_guest_bindable_to_invite is a point-in-time fact that a SUCCESSFUL link legitimately
-- invalidates (the guest's own group_members row moves to profile_id the instant
-- app_link_guest_to_profile runs) — re-checking it on every later UPDATE would start rejecting
-- that same row's own "בטל הזמנה" the moment its binding resolves, which is strictly worse than
-- not checking at all. KNOWN, ACCEPTED GAP (same spirit as guests_update_creator's documented gap
-- in rls-policies.sql): a group admin could in principle craft a raw UPDATE to rebind an EXISTING
-- invite row to an unrelated guest id after creation. Narrow blast radius — it requires already
-- being an admin of some group, grants no access to any row that admin's other standing does not
-- already reach, and only matters if someone then redeems that exact, admin-controlled token.
-- Closing it fully needs either a BEFORE UPDATE trigger (comparing OLD.bound_guest_id to NEW) or
-- moving invite creation off the generic upsert path onto a dedicated RPC; deferred rather than
-- shipped unverified — this repo cannot run SQL to check a trigger against the real upsert shape.
DROP POLICY IF EXISTS invites_update_admin ON invites;
CREATE POLICY invites_update_admin ON invites FOR UPDATE TO authenticated
  USING (app_is_group_admin(group_id))
  WITH CHECK (app_is_group_admin(group_id));

-- ---------------------------------------------------------------------
-- 2. app_guest_has_zero_exposure — path 3's gate, shared by client and server
-- ---------------------------------------------------------------------
-- STABLE, no side effects: safe to leave at the default PUBLIC execute grant, same as every other
-- read-only predicate in rls-policies.sql (app_is_group_admin, app_can_read_game, …). The
-- frontend may call it to decide what to render; app_self_claim_guest below calls the SAME
-- function to decide what to allow, so the two can never quietly disagree (identical pattern to
-- the old app_can_approve_guest_claim being shared by a policy and two RPCs).
CREATE OR REPLACE FUNCTION app_guest_has_zero_exposure(p_guest_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM debts d
    WHERE d.status = 'open' AND (d.debtor_guest_id = p_guest_id OR d.creditor_guest_id = p_guest_id)
  ) AND NOT EXISTS (
    SELECT 1 FROM game_participants gp
    JOIN games g ON g.id = gp.game_id
    WHERE gp.guest_id = p_guest_id AND (g.phase <> 'closed' OR g.is_balanced IS DISTINCT FROM true)
  )
$$;
COMMENT ON FUNCTION app_guest_has_zero_exposure(uuid) IS
  'True when claiming this guest would move no money: no open debt on either side, and no game_participants row in a game that is still open/in settlement or closed unbalanced. Mirrored in kupa-sgura.html as guestHasZeroExposure (groups domain (pure)) for tests; this function is the actual authority.';

-- ---------------------------------------------------------------------
-- 3. app_link_guest_to_profile — the shared, INTERNAL re-pointing engine
-- ---------------------------------------------------------------------
-- Every linking path (bound-invite redemption, self-claim) funnels through this one function so
-- the re-pointing logic and the double-seat guard can never drift apart between paths, exactly
-- like the merge block app_approve_guest_claim used to own alone.
--
-- NOT REACHABLE BY ANY CLIENT ROLE, ON PURPOSE — see the REVOKE block at the bottom of this
-- section. p_claimant is a caller-SUPPLIED identity, the opposite of every public-facing RPC in
-- this file (which always resolve app_current_profile_id() themselves): a client that could call
-- this directly would pick ANY claimant for ANY guest, skipping every authorization check both
-- wrappers below perform first (name match, group visibility, zero exposure, or "a member
-- deliberately bound this exact invite to this exact guest"). SECURITY DEFINER here is defense in
-- depth (matches the file's own convention of marking every function this way), not the actual
-- protection — the actual protection is that no role is ever granted EXECUTE on it.
CREATE OR REPLACE FUNCTION app_link_guest_to_profile(p_guest_id uuid, p_claimant uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_guest guests%ROWTYPE;
BEGIN
  SELECT * INTO v_guest FROM guests g WHERE g.id = p_guest_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not-found';
  END IF;

  -- Idempotent: a guest already linked to this exact claimant (a retried call, or two of this
  -- claimant's own devices racing) reports success without re-running the merge. Linked to a
  -- DIFFERENT profile refuses — this is the "must not be replayable to link a second account to
  -- the same guest" rule, for every path, for free: the very first successful link sets
  -- linked_profile_id, and every later attempt (bound-invite redeemed again by someone else,
  -- another self-claim tap) lands here instead of re-merging.
  IF v_guest.linked_profile_id IS NOT NULL THEN
    RETURN CASE WHEN v_guest.linked_profile_id = p_claimant THEN 'already-you' ELSE 'already-linked' END;
  END IF;

  -- The core safety rule, in every path: never seat the same person twice in one game. If the
  -- claimant already sits at any table the guest also sits at (as a separate participant row),
  -- refuse before anything below has run — nothing partially applied.
  IF EXISTS (
    SELECT 1
    FROM game_participants gp_guest
    JOIN game_participants gp_claimant
      ON gp_claimant.game_id = gp_guest.game_id
     AND gp_claimant.profile_id = p_claimant
    WHERE gp_guest.guest_id = p_guest_id
  ) THEN
    RETURN 'double-seat';
  END IF;

  -- game_participants: guarded above (game_participants_identity_chk, game_participants_profile_uk).
  UPDATE game_participants
     SET profile_id = p_claimant, guest_id = NULL
   WHERE guest_id = p_guest_id;

  -- debts: debtor and creditor move independently (debts_debtor_identity_chk /
  -- debts_creditor_identity_chk). debts_distinct_chk can never fire here: a debt only exists
  -- between two participants of the same game, and the double-seat guard above already refused
  -- any game where the claimant and this guest are both seated.
  UPDATE debts
     SET debtor_profile_id = p_claimant, debtor_guest_id = NULL
   WHERE debtor_guest_id = p_guest_id;
  UPDATE debts
     SET creditor_profile_id = p_claimant, creditor_guest_id = NULL
   WHERE creditor_guest_id = p_guest_id;

  -- games.leader_*: games_leader_identity_chk allows both null, never a uniqueness conflict.
  UPDATE games
     SET leader_profile_id = p_claimant, leader_guest_id = NULL
   WHERE leader_guest_id = p_guest_id;

  -- group_members: skip only the rows where the claimant already holds an INDEPENDENT active
  -- membership in that same group (group_members_active_profile_uk would otherwise reject the
  -- row) rather than aborting the whole link over one group. Every other row (a different group,
  -- or a former/removed guest membership) re-points normally.
  UPDATE group_members gm
     SET profile_id = p_claimant, guest_id = NULL
   WHERE gm.guest_id = p_guest_id
     AND NOT (
       gm.status = 'active'
       AND EXISTS (
         SELECT 1 FROM group_members other
         WHERE other.group_id = gm.group_id
           AND other.profile_id = p_claimant
           AND other.status = 'active'
       )
     );

  -- transfers/entries carry no guest_id/profile_id of their own — only participant_id /
  -- from_participant_id / to_participant_id, immutable references to game_participants.id — so
  -- they automatically follow the participant row the instant it moves above.
  -- display_name_snapshot / debtor_name / creditor_name are deliberately NOT rewritten: frozen
  -- history, the same "a rename never rewrites old screens" rule schema.sql documents.

  UPDATE guests
     SET linked_profile_id = p_claimant, linked_at = now()
   WHERE id = p_guest_id;

  RETURN 'linked';
END;
$$;
COMMENT ON FUNCTION app_link_guest_to_profile(uuid, uuid) IS
  'INTERNAL — never GRANTed to any role. Re-points game_participants/debts/games.leader_*/group_members from guest_id to profile_id, keeping every balance identical, and marks guests.linked_profile_id/linked_at. Returns linked | already-you | already-linked | double-seat | not-found. Callers (app_redeem_invite, app_self_claim_guest) perform their own authorization first and decide what each status means for them.';

REVOKE ALL ON FUNCTION app_link_guest_to_profile(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION app_link_guest_to_profile(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION app_link_guest_to_profile(uuid, uuid) FROM authenticated;
-- No GRANT to anyone. Called only from inside app_redeem_invite / app_self_claim_guest, which
-- already run with the table owner's rights (SECURITY DEFINER) by the time they call it.

-- ---------------------------------------------------------------------
-- 4. app_redeem_invite — extended: join + path-1 link, one transaction
-- ---------------------------------------------------------------------
-- Same signature and the exact same join logic as docs/backend/join-invite.sql (the "WHY A
-- FUNCTION AND NOT PLAIN INSERTS" reasoning there is unchanged and not repeated here). The only
-- addition is the very last step: if this invite was created bound to a guest
-- (renderInviteGuestBindPicker, kupa-sgura.html), link it to the caller now, in the same
-- transaction as the join. A refusal from app_link_guest_to_profile here is SILENT on purpose —
-- this caller asked to join a group, not to be linked to anyone, so whatever the link attempt
-- does, the join result above still stands.
CREATE OR REPLACE FUNCTION app_redeem_invite(p_token text)
RETURNS TABLE (group_id uuid, group_name text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_id uuid;
  v_token      text;
  v_invite     invites%ROWTYPE;
  v_group      groups%ROWTYPE;
  v_member     group_members%ROWTYPE;
  v_name       text;
  v_status     text;
BEGIN
  -- The caller must be a real signed-in profile. A definer-rights
  -- function with no identity would be an anonymous write primitive.
  v_profile_id := app_current_profile_id();
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'app_redeem_invite: no signed-in profile'
      USING ERRCODE = '28000';
  END IF;

  -- Token normalization must match the client exactly: the code is
  -- displayed as "ABCD-2345", may be pasted with spaces, and the stored
  -- token is the bare 8 uppercase characters.
  v_token := upper(regexp_replace(coalesce(p_token, ''), '[[:space:]-]', '', 'g'));
  IF v_token = '' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'invalid'::text;
    RETURN;
  END IF;

  SELECT * INTO v_invite FROM invites i WHERE i.token = v_token;

  -- Unknown token. Deliberately the same answer as a token for a group
  -- that no longer exists is NOT given here — see 'group-gone' below —
  -- but nothing about the group is leaked for a token that never was.
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'invalid'::text;
    RETURN;
  END IF;

  -- An admin pressed "בטל הזמנה".
  IF v_invite.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'revoked'::text;
    RETURN;
  END IF;

  -- expires_at is nullable; NULL means "no expiry".
  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at <= now() THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'expired'::text;
    RETURN;
  END IF;

  -- The group may have been soft-deleted after the link was shared.
  SELECT * INTO v_group FROM groups g WHERE g.id = v_invite.group_id;
  IF NOT FOUND OR v_group.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'group-gone'::text;
    RETURN;
  END IF;

  -- The caller's own membership row, if any. profile_id is the identity
  -- half of group_members_identity_chk; guest rows are never touched.
  SELECT * INTO v_member
  FROM group_members m
  WHERE m.group_id = v_group.id
    AND m.profile_id = v_profile_id
  ORDER BY (m.status = 'active') DESC, m.joined_at DESC
  LIMIT 1;

  -- Already in. Idempotent: opening the same link twice writes nothing to group_members, and the
  -- client simply opens the group. The link attempt below still runs — the FIRST time an already-
  -- member reopens a bound link is exactly how someone who joined earlier under their own account
  -- (see the group_members skip-rule in app_link_guest_to_profile) gets linked.
  IF FOUND AND v_member.status = 'active' THEN
    v_status := 'already-member';
  ELSIF FOUND THEN
    -- Someone who left or was removed and got a fresh link: reactivate the existing row rather
    -- than inserting a second one, so history that points at this membership stays attached.
    UPDATE group_members m
       SET status     = 'active',
           left_at    = NULL,       -- group_members_active_chk
           joined_at  = now(),
           updated_at = now()
     WHERE m.id = v_member.id;
    v_status := 'rejoined';
  ELSE
    -- First time in this group. role is always 'member' — an invite never grants admin.
    -- display_name_snapshot follows the schema's convention of freezing the name at join time.
    SELECT p.display_name INTO v_name FROM profiles p WHERE p.id = v_profile_id;
    IF v_name IS NULL OR btrim(v_name) = '' THEN
      v_name := 'שחקן';
    END IF;
    INSERT INTO group_members (group_id, profile_id, display_name_snapshot, role, status)
    VALUES (v_group.id, v_profile_id, v_name, 'member', 'active');
    v_status := 'joined';
  END IF;

  -- PATH 1 — invite-bound linking. Silent: see the header comment. app_link_guest_to_profile is
  -- itself the full guard (already-linked-elsewhere, double-seat) — its result is discarded here
  -- on purpose, not surfaced as an error, because this caller never asked to be linked to anyone.
  IF v_invite.bound_guest_id IS NOT NULL THEN
    PERFORM app_link_guest_to_profile(v_invite.bound_guest_id, v_profile_id);
  END IF;

  RETURN QUERY SELECT v_group.id, v_group.name, v_status;
END;
$$;

COMMENT ON FUNCTION app_redeem_invite(text) IS
  'Redeem an invite token for the current profile, and — when the invite was created bound to a guest — silently link that guest to the caller in the same transaction (see app_link_guest_to_profile). The only sanctioned way to insert a group_members row for yourself; returns (group_id, group_name, status) where status is joined | rejoined | already-member | invalid | revoked | expired | group-gone.';

-- Only a signed-in caller may redeem. anon/public get nothing.
REVOKE ALL ON FUNCTION app_redeem_invite(text) FROM public;
REVOKE ALL ON FUNCTION app_redeem_invite(text) FROM anon;
GRANT EXECUTE ON FUNCTION app_redeem_invite(text) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. app_self_claim_guest — path 3, "זה אני", instant when it is safe
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_self_claim_guest(p_guest_id uuid)
RETURNS TABLE (status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimant      uuid;
  v_guest         guests%ROWTYPE;
  v_claimant_name text;
  v_result        text;
BEGIN
  -- The caller always acts as themselves: there is no p_profile_id parameter to spoof, exactly
  -- like every other RPC in this file.
  v_claimant := app_current_profile_id();
  IF v_claimant IS NULL THEN
    RAISE EXCEPTION 'app_self_claim_guest: no signed-in profile' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_guest FROM guests g WHERE g.id = p_guest_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not-found'::text;
    RETURN;
  END IF;

  IF v_guest.linked_profile_id IS NOT NULL THEN
    RETURN QUERY SELECT (CASE WHEN v_guest.linked_profile_id = v_claimant THEN 'already-you' ELSE 'already-linked' END)::text;
    RETURN;
  END IF;

  -- Standing: the caller must share an active group with this guest — the same bar guests_select
  -- already uses for group-based visibility, so a self-claim is only ever offered for (and only
  -- ever succeeds on) a guest the caller could already legitimately see.
  IF NOT EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.guest_id = p_guest_id AND gm.status = 'active' AND app_is_active_group_member(gm.group_id)
  ) THEN
    RAISE EXCEPTION 'GUEST_LINK_NOT_VISIBLE: % may not claim guest %', v_claimant, p_guest_id
      USING ERRCODE = '42501';
  END IF;

  -- Name match: unlike a bound invite (authorized by the member who picked this exact guest when
  -- creating it) or a verified-contact match (authorized by real proof of identity), a bare
  -- self-claim has no other human in the loop — name equality is the only signal left, so it is
  -- enforced here, not just used as a client-side suggestion filter.
  SELECT p.display_name INTO v_claimant_name FROM profiles p WHERE p.id = v_claimant;
  IF btrim(coalesce(v_claimant_name, '')) = ''
     OR lower(btrim(v_claimant_name)) <> lower(btrim(v_guest.display_name)) THEN
    RAISE EXCEPTION 'GUEST_LINK_NAME_MISMATCH: claimant name does not match guest %', p_guest_id
      USING ERRCODE = '42501';
  END IF;

  -- THE gate: zero financial exposure, enforced HERE — server-side, not just in the UI (Task
  -- instruction). app_guest_has_zero_exposure is the exact same predicate the frontend may call
  -- to decide whether to offer the row at all; this is the authority, that is only ever a hint.
  IF NOT app_guest_has_zero_exposure(p_guest_id) THEN
    RAISE EXCEPTION 'GUEST_LINK_HAS_EXPOSURE: guest % has an open debt or sits in an open/unbalanced game', p_guest_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_result := app_link_guest_to_profile(p_guest_id, v_claimant);

  IF v_result = 'double-seat' THEN
    RAISE EXCEPTION 'GUEST_LINK_DOUBLE_SEAT: claimant already sits at a table alongside guest %', p_guest_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_result = 'already-linked' THEN
    RAISE EXCEPTION 'GUEST_LINK_ALREADY_LINKED: guest % got linked to someone else first', p_guest_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- v_result is 'linked' or 'already-you' here (a race resolved by app_link_guest_to_profile's
  -- own row lock landed on the same claimant) — either is success from this caller's point of view.
  RETURN QUERY SELECT v_result;
END;
$$;
COMMENT ON FUNCTION app_self_claim_guest(uuid) IS
  'Instant, no-approval self-claim: links guest p_guest_id to the caller when (a) the caller shares an active group with the guest, (b) the caller''s own display name matches it, and (c) app_guest_has_zero_exposure(p_guest_id) — no open debt, no open/unbalanced game. Returns linked | already-you; raises GUEST_LINK_NOT_VISIBLE | GUEST_LINK_NAME_MISMATCH | GUEST_LINK_HAS_EXPOSURE | GUEST_LINK_DOUBLE_SEAT | GUEST_LINK_ALREADY_LINKED otherwise, with no partial effect.';

REVOKE ALL ON FUNCTION app_self_claim_guest(uuid) FROM public;
REVOKE ALL ON FUNCTION app_self_claim_guest(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_self_claim_guest(uuid) TO authenticated;

COMMIT;

-- ---------------------------------------------------------------------
-- HOW TO VERIFY (SQL editor, two accounts + a helper — mirrors the report's manual test plan)
-- ---------------------------------------------------------------------
-- Setup: as account A (helper/admin), create a group, add a guest "אורי" to it (or play a game
-- with "אורי" as an ad-hoc guest — either way A is guests.created_by). Note the guest's id:
--   SELECT id FROM guests WHERE display_name = 'אורי';                       -- <GUEST>
--
-- PATH 1 — invite-bound linking:
-- 1. As A, in the app, open "צור הזמנה" on that group — with "אורי" still unlinked, a small
--    picker offers "כללי" / "אורי"; pick "אורי", then create the invite. Or directly:
--      INSERT INTO invites (group_id, token, created_by_profile_id, bound_guest_id)
--        VALUES ('<group id>', 'ZZZZTEST', '<A>', '<GUEST>');
-- 2. As account B (the real Uri, a second signed-in account, has never opened this group before):
--      SELECT * FROM app_redeem_invite('zzzz test');   -- lowercase + space, on purpose
--    Expect: (group id, group name, 'joined').
--      SELECT linked_profile_id FROM guests WHERE id = '<GUEST>';            -- now B's profile id
--      SELECT profile_id, guest_id FROM group_members WHERE group_id = '<group id>' AND (profile_id = '<B>' OR guest_id = '<GUEST>');
--        -- "אורי"'s old row now says profile_id = B, guest_id NULL (or B has an independent row
--        -- and "אורי"'s is left alone — see the skip-rule comment in app_link_guest_to_profile —
--        -- either way exactly one active row for B, none left for <GUEST>'s guest_id).
-- 3. Re-run step 2 as a THIRD account C, reusing the same token (simulate the link being shared
--    onward, or a second tap): 'already-member' or 'joined' as appropriate, but the guest stays
--    linked to B —
--      SELECT * FROM app_redeem_invite('zzzz test');   -- as C
--      SELECT linked_profile_id FROM guests WHERE id = '<GUEST>';            -- still B, unchanged
--    This is the "must not be replayable to link a second account to the same guest" guarantee.
--
-- PATH 3 — zero-exposure self-claim:
-- 4. As account D (display name exactly matches an unlinked guest <GUEST2> seated in a group D
--    just joined, that guest has NO open debts and sits only in closed+balanced games):
--      SELECT app_guest_has_zero_exposure('<GUEST2>');                       -- true
--      SELECT * FROM app_self_claim_guest('<GUEST2>');                       -- ('linked')
--    Expect the same balances-unchanged checks as step 2.
-- 5. Negative — exposure blocks it: pick a guest <GUEST3> with an open debt (or seated in a
--    currently open game):
--      SELECT app_guest_has_zero_exposure('<GUEST3>');                       -- false
--      SELECT * FROM app_self_claim_guest('<GUEST3>');
--    Expect an error starting with GUEST_LINK_HAS_EXPOSURE, and nothing changed:
--      SELECT linked_profile_id FROM guests WHERE id = '<GUEST3>';           -- still NULL
-- 6. Negative — name mismatch: as any account whose display name does NOT match a candidate
--    guest's display_name, call app_self_claim_guest on it — expect GUEST_LINK_NAME_MISMATCH.
-- 7. Negative — double seat: have D ALSO be seated (their own profile_id) in a game that
--    <GUEST2> played in (a second, still-open-or-just-closed-balanced game so zero-exposure still
--    passes), then self-claim. Expect GUEST_LINK_DOUBLE_SEAT, and:
--      SELECT guest_id FROM game_participants WHERE guest_id = '<GUEST2>';   -- still there
-- 8. Idempotent replay: re-run step 4 as D again → ('already-you'), no error, no second merge.
--
-- RLS is untouched throughout: as a fresh account with no relation to the group,
--   SELECT * FROM invites WHERE token = 'ZZZZTEST';                          -- 0 rows
--   SELECT * FROM guests WHERE id = '<GUEST>';                               -- 0 rows
