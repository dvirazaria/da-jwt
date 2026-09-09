-- =====================================================================
-- "סוגרים קופה" — self-service account deletion
-- Run AFTER schema.sql, rls-policies.sql and join-invite.sql.
-- Idempotent: safe to run twice, and safe if the caller retries the RPC after a dropped
-- response — see IDEMPOTENCY below. Runs as one implicit transaction (a single top-level
-- `select app_delete_my_account();` is atomic: either every statement below lands or none do).
-- =====================================================================
--
-- WHAT THIS REMOVES
--   * auth.users row for the caller (Supabase Auth) — they can never sign back in, and nothing
--     keeps their email/phone reachable for re-identification.
--   * profiles row: NOT hard-deleted (see WHY, below) — scrubbed in place to a neutral
--     "משתמש שנמחק" with phone/email/avatar_url cleared. The row's id is kept, so every FK that
--     already points at it (groups.created_by_profile_id, games.created_by, guests.created_by —
--     all ON DELETE RESTRICT or NOT NULL) stays valid without touching a single row in those
--     tables.
--   * Every invite this user created that was still redeemable (revoked_at stamped, never
--     deleted — an outstanding link simply stops working; a group that used it keeps its members).
--
-- WHAT THIS PRESERVES (the hard constraint: shared, balanced history)
--   * Every CLOSED game's game_participants / entries / transfers rows. schema.sql's own
--     immutability triggers (entries_immutable_when_closed, game_participants_immutable_when_closed,
--     games_immutable_when_closed — section 7, "defence in depth: RLS is bypassed by the table
--     owner and by a service role key. These triggers are not.") RAISE EXCEPTION on UPDATE/DELETE
--     the moment games.phase = 'closed', for EVERY caller — including this SECURITY DEFINER
--     function, which runs with the table owner's rights. So closed history is not merely
--     "preserved by choice": it is unreachable by construction. Its identity is erased at the
--     source instead — the profiles row those rows still point at now carries no name, email,
--     phone or avatar.
--   * game_participants / entries of an OPEN (active/settlement) game, and every group_members
--     and debts row regardless of the game's phase (neither table has an immutability trigger),
--     ARE reachable and ARE repointed: profile_id -> NULL, guest_id -> one fresh `guests` row
--     created for this caller, carrying the display_name_snapshot / debtor_name / creditor_name
--     the row already had — read from, never written by, this function. See "the identity
--     pattern" in schema.sql: num_nonnulls(profile_id, guest_id) = 1 is satisfied either way;
--     this function always takes the guest_id branch so a row keeps exactly one identity, never
--     zero, and the CHECK constraint is never touched, let alone weakened.
--   * guests this user created (guests.created_by): left exactly as they are. created_by still
--     points at the caller's own (now-scrubbed) profiles row — valid, because that row still
--     exists — so nobody else's guest players move.
--   * transfers: carries no profile_id/guest_id column at all (only *_participant_id, already
--     covered through game_participants above), so there is nothing to change here by
--     construction — money movement between two participants is untouched either way.
--
-- WHY profiles IS SCRUBBED, NOT DELETED
--   groups.created_by_profile_id and games.created_by are NOT NULL with ON DELETE RESTRICT;
--   guests.created_by is ON DELETE CASCADE with its own downstream ON DELETE RESTRICT
--   (game_participants.guest_id). A hard `DELETE FROM profiles` for anyone who ever created a
--   group, opened a game, or added a guest — i.e. almost every real user — would either abort
--   the whole transaction (RESTRICT) or cascade-delete guests that OTHER people's closed games
--   still reference (CASCADE into a RESTRICT further down, which also aborts). Keeping the row
--   with every personal field wiped satisfies "erase identity, not records" without weakening or
--   routing around a single constraint.
--
-- BALANCES STAY IDENTICAL — how this is guaranteed
--   No statement below ever assigns to entries.amount, game_participants.cashout, transfers.amount
--   or debts.amount — every UPDATE here touches only identity columns (profile_id / guest_id /
--   debtor_* / creditor_* / leader_* / created_by) or bookkeeping (revoked_at / status / left_at /
--   archived_at). A game's buy-in total (SUM(entries.amount), see game_results_v), its cashouts,
--   and every transfer/debt amount are therefore read from rows this function never writes to —
--   they cannot move. For every CLOSED game this is not just intent: the immutability triggers
--   make it impossible to touch entries/game_participants/transfers of a closed game at all, so
--   the sums behind that game's settlement are provably byte-for-byte the same before and after.
--
-- ADMIN SUCCESSION (mirrors pickAccountDeletionSuccessor() in kupa-sgura.html — keep both in
-- sync if this logic ever changes)
--   For every group where the caller is the LAST active admin: promotes the longest-standing
--   OTHER active member (earliest joined_at); if no other active member remains, archives the
--   group (archived_at). A group that still has another active admin is left untouched
--   (multi-admin unchanged). A group is never left without an admin.
--
-- IDEMPOTENCY
--   Supabase's auth.uid() is read from the request's JWT claims, not a live lookup, so a retried
--   call can still resolve app_current_profile_id() for a short window even after this function
--   already deleted auth.users on an earlier, successful call whose response the client never
--   received. The very first thing this function does after resolving the caller is check
--   whether that profile is already scrubbed (display_name = 'משתמש שנמחק') and return
--   immediately if so — every statement after that point targets rows keyed off the *original*
--   profile id or the *first* deletion's fresh guest id, so a genuine second run would otherwise
--   be a same-result no-op anyway (its own guest_id would simply match nothing), but the early
--   return keeps it from minting a second, unused guests row.
--
-- HOW TO RUN (Supabase SQL editor)
--   1. Paste and run this whole file once, as the project owner, to install the function. It
--      must be created by a role with DELETE on auth.users — the default "postgres" role used by
--      the Supabase SQL editor has it; a narrower custom role may not.
--   2. It is NEVER invoked from the SQL editor as the owner: app_current_profile_id() (defined in
--      rls-policies.sql) reads auth.uid(), which is only set for a request authenticated as the
--      deleting user. The client calls it the same way app_redeem_invite() is called in
--      join-invite.sql — over a normal authenticated Supabase client session:
--        const { error } = await supabase.rpc("app_delete_my_account");
--      (see runDeleteAccount() in kupa-sgura.html).
--   3. To exercise it manually from the SQL editor instead, impersonate the target user's JWT
--      (Supabase's "Run as user" in the SQL editor, or a request signed with that user's access
--      token) — do not test by disabling RLS or calling as the table owner, since
--      app_current_profile_id() would then read NULL and the function would just raise.
--
-- Fill in a deleted auth.users.id and uncomment to verify after a manual test deletion:
-- SELECT id, display_name, phone, email, avatar_url FROM profiles WHERE id = '<id>';
--   -- expect: display_name = 'משתמש שנמחק', phone/email/avatar_url all NULL
-- SELECT count(*) FROM auth.users WHERE id = '<id>';                                  -- expect: 0
-- SELECT count(*) FROM group_members WHERE profile_id = '<id>';                       -- expect: 0
-- SELECT count(*) FROM game_participants WHERE profile_id = '<id>'
--   AND game_id IN (SELECT id FROM games WHERE phase <> 'closed');                    -- expect: 0
-- SELECT count(*) FROM debts WHERE debtor_profile_id = '<id>' OR creditor_profile_id = '<id>'; -- expect: 0
-- SELECT count(*) FROM invites WHERE created_by_profile_id = '<id>' AND revoked_at IS NULL; -- expect: 0
-- -- Every group the deleted user was an active admin of still has an admin, or is archived:
-- SELECT g.id, g.name, g.archived_at,
--        (SELECT count(*) FROM group_members m
--           WHERE m.group_id = g.id AND m.status = 'active' AND m.role = 'admin') AS active_admins
--   FROM groups g WHERE g.id IN (<group ids the deleted user belonged to>);
--   -- expect: active_admins >= 1, OR archived_at IS NOT NULL when active_admins = 0
-- -- A closed game the deleted user played in is byte-for-byte unchanged (compare against a
-- -- snapshot taken before deletion — this function never writes rows matched by this query):
-- SELECT * FROM game_participants gp JOIN games g ON g.id = gp.game_id
--   WHERE g.phase = 'closed' AND gp.profile_id = '<id>';
-- =====================================================================

CREATE OR REPLACE FUNCTION app_delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid;
  v_guest_id  uuid;
  v_name      text;
  v_group     RECORD;
  v_successor uuid;
BEGIN
  -- Only the signed-in caller, never a target id — this function takes no arguments on purpose.
  v_uid := app_current_profile_id();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'app_delete_my_account: no signed-in profile' USING ERRCODE = '28000';
  END IF;

  SELECT display_name INTO v_name FROM profiles WHERE id = v_uid;
  IF NOT FOUND THEN
    RETURN; -- no profile row at all; nothing this function owns is left to touch
  END IF;
  IF v_name = 'משתמש שנמחק' THEN
    RETURN; -- IDEMPOTENCY: already scrubbed by an earlier, successful call
  END IF;
  IF v_name IS NULL OR btrim(v_name) = '' THEN v_name := 'שחקן'; END IF;

  -- One fresh guest stands in for this person everywhere the identity link is dropped below.
  -- created_by references the caller's OWN profiles row, which is scrubbed further down but
  -- never removed, so this FK stays valid without touching anyone else's data.
  INSERT INTO guests (display_name, created_by)
  VALUES (v_name, v_uid)
  RETURNING id INTO v_guest_id;

  -- ---- group_members: no immutability trigger on this table, so every row — active or
  -- historical, in an open or a closed game's group — can be repointed. display_name_snapshot
  -- (what every member actually sees) is never touched.
  UPDATE group_members
     SET profile_id = NULL, guest_id = v_guest_id
   WHERE profile_id = v_uid;

  -- ---- game_participants / entries: BLOCKED by app_assert_game_open() the instant the game is
  -- closed (schema.sql section 7 — RLS is bypassed by a definer function, that trigger is not).
  -- Restricting to open games means the statement never even attempts a closed one; its
  -- profile_id link is left exactly as it was and now resolves to the scrubbed profiles row.
  UPDATE game_participants gp
     SET profile_id = NULL, guest_id = v_guest_id
    FROM games g
   WHERE gp.game_id = g.id AND gp.profile_id = v_uid AND g.phase <> 'closed';

  UPDATE entries e
     SET created_by = NULL
    FROM games g
   WHERE e.game_id = g.id AND e.created_by = v_uid AND g.phase <> 'closed';

  -- ---- games.leader_profile_id: same immutability trigger (games_immutable_when_closed).
  -- games_leader_identity_chk allows num_nonnulls(leader_profile_id, leader_guest_id) <= 1, so
  -- "no leader" is a legal state — no guest stand-in needed for this bookkeeping-only field.
  UPDATE games
     SET leader_profile_id = NULL
   WHERE leader_profile_id = v_uid AND phase <> 'closed';

  -- ---- debts: no immutability trigger at all (open or closed game, it doesn't matter here),
  -- and debtor_name/creditor_name — the values every screen actually renders — are untouched;
  -- only the FK side moves. debts_distinct_chk can never fire from this: a debtor and creditor
  -- are always two different identities already, so at most one side of any single row is ever
  -- this caller.
  UPDATE debts SET debtor_profile_id   = NULL, debtor_guest_id   = v_guest_id WHERE debtor_profile_id   = v_uid;
  UPDATE debts SET creditor_profile_id = NULL, creditor_guest_id = v_guest_id WHERE creditor_profile_id = v_uid;
  -- Who clicked "paid" is not part of the settlement (status/paid_at/amount are untouched here).
  UPDATE debts SET paid_by_profile_id = NULL WHERE paid_by_profile_id = v_uid;

  -- ---- transfers: intentionally no statement. The table has no profile_id/guest_id column —
  -- only from/to_participant_id, already covered above through game_participants.

  -- ---- admin succession, before this caller's own membership rows are marked "removed" below
  -- (they must still read as "active" while we decide who succeeds them). The bulk UPDATE above
  -- already moved every one of this user's group_members rows onto v_guest_id, so "this caller,
  -- in this group" is now found by guest_id = v_guest_id, not profile_id.
  FOR v_group IN
    SELECT DISTINCT group_id FROM group_members WHERE guest_id = v_guest_id AND role = 'admin'
  LOOP
    -- Not actually an active admin here (was a former admin, or a historical row) — nothing to do.
    IF NOT EXISTS (
      SELECT 1 FROM group_members
       WHERE group_id = v_group.group_id AND guest_id = v_guest_id AND role = 'admin' AND status = 'active'
    ) THEN
      CONTINUE;
    END IF;
    -- Another active admin already covers this group -> multi-admin, left unchanged.
    IF EXISTS (
      SELECT 1 FROM group_members
       WHERE group_id = v_group.group_id AND role = 'admin' AND status = 'active'
         AND guest_id IS DISTINCT FROM v_guest_id
    ) THEN
      CONTINUE;
    END IF;
    -- Sole admin. Promote the longest-standing other active member (earliest joined_at first).
    SELECT id INTO v_successor
      FROM group_members
     WHERE group_id = v_group.group_id AND status = 'active' AND guest_id IS DISTINCT FROM v_guest_id
     ORDER BY joined_at ASC
     LIMIT 1;
    IF v_successor IS NULL THEN
      -- Nobody left at all: never leave the group admin-less, archive it instead.
      UPDATE groups SET archived_at = COALESCE(archived_at, now()) WHERE id = v_group.group_id;
    ELSE
      UPDATE group_members SET role = 'admin' WHERE id = v_successor;
    END IF;
  END LOOP;

  -- The deleted identity itself never comes back as this guest — mark every membership it holds
  -- as removed (not left: this is not a voluntary departure) rather than a ghost "active" row
  -- nobody can ever use again. Runs after succession, which still needed to see it as active.
  UPDATE group_members
     SET status = 'removed', left_at = now()
   WHERE guest_id = v_guest_id AND status = 'active';

  -- ---- invites created by this user: revoke, never delete — a redeemed invite's history (who
  -- invited whom into a still-existing group) is harmless, and the row has no other
  -- identity-bearing column to scrub.
  UPDATE invites
     SET revoked_at = COALESCE(revoked_at, now())
   WHERE created_by_profile_id = v_uid AND revoked_at IS NULL;

  -- ---- profiles: scrubbed in place (see WHY, above) — deliberately last among the UPDATEs, so
  -- every lookup above that reads v_uid's row (e.g. picking a display name for the fresh guest)
  -- still saw the real name.
  UPDATE profiles
     SET display_name = 'משתמש שנמחק', phone = NULL, email = NULL, avatar_url = NULL
   WHERE id = v_uid;

  -- ---- friendships: intentionally no statement. requester/addressee_profile_id keep pointing
  -- at the now-scrubbed profiles row (same reasoning as guests.created_by above) — the only
  -- thing the other party ever sees there is a name, and that name is now "משתמש שנמחק".

  -- ---- auth.users: the only statement in this function outside the portable `public` schema.
  -- Deleting it signs the user out everywhere and makes the account permanently unreachable —
  -- no re-identification by email/phone, no signing back in. Must run last: app_current_profile_id()
  -- depends on this row existing for every check earlier in this function.
  DELETE FROM auth.users WHERE id = v_uid;
END;
$$;

COMMENT ON FUNCTION app_delete_my_account() IS
  'Self-service account deletion for the caller (auth.uid()) only — never takes a target id. Scrubs profiles to a neutral placeholder instead of deleting it (RESTRICT/CASCADE foreign keys from groups/games/guests would otherwise abort the transaction or cascade-destroy rows other people''s history still needs), repoints every identity-bearing row it is allowed to touch to a fresh guests row while leaving closed-game rows alone (the schema''s own immutability triggers refuse them), hands sole-admin groups to their longest-standing member or archives them, revokes the caller''s outstanding invites, and deletes auth.users so the account can never sign back in.';

-- Nobody may call this as anyone else, and it must never be reachable without a session.
REVOKE ALL ON FUNCTION app_delete_my_account() FROM public;
REVOKE ALL ON FUNCTION app_delete_my_account() FROM anon;
GRANT EXECUTE ON FUNCTION app_delete_my_account() TO authenticated;
