-- =====================================================================
-- "סוגרים קופה" — joining a group by invite token
-- Run AFTER docs/backend/schema.sql and docs/backend/rls-policies.sql.
-- Idempotent: re-running only replaces the function and its grants.
-- =====================================================================
--
-- WHY A FUNCTION AND NOT PLAIN INSERTS
-- RLS makes the client-side version of this flow impossible on purpose:
--   * invites_select_members  — only members of the group may read the
--     invite row, so a prospective joiner cannot even resolve a token
--     into a group id;
--   * group_members_insert_admin — only a group admin may insert a
--     membership row, so a stranger cannot add themselves.
-- Both policies stay exactly as they are. The single legitimate way in
-- is this SECURITY DEFINER function: it validates the token with
-- definer rights, and writes at most one group_members row for the
-- caller. Nothing else about the caller's authority changes.
--
-- The vendor seam is unchanged too: app_current_profile_id() (defined in
-- rls-policies.sql) is the only place that knows about auth.uid().

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

  -- Already in. Idempotent: opening the same link twice writes nothing,
  -- and the client simply opens the group.
  IF FOUND AND v_member.status = 'active' THEN
    RETURN QUERY SELECT v_group.id, v_group.name, 'already-member'::text;
    RETURN;
  END IF;

  -- Someone who left or was removed and got a fresh link: reactivate the
  -- existing row rather than inserting a second one, so history that
  -- points at this membership stays attached.
  IF FOUND THEN
    UPDATE group_members m
       SET status     = 'active',
           left_at    = NULL,       -- group_members_active_chk
           joined_at  = now(),
           updated_at = now()
     WHERE m.id = v_member.id;
    RETURN QUERY SELECT v_group.id, v_group.name, 'rejoined'::text;
    RETURN;
  END IF;

  -- First time in this group. role is always 'member' — an invite never
  -- grants admin. display_name_snapshot follows the schema's convention
  -- of freezing the name at join time.
  SELECT p.display_name INTO v_name FROM profiles p WHERE p.id = v_profile_id;
  IF v_name IS NULL OR btrim(v_name) = '' THEN
    v_name := 'שחקן';
  END IF;

  INSERT INTO group_members (group_id, profile_id, display_name_snapshot, role, status)
  VALUES (v_group.id, v_profile_id, v_name, 'member', 'active');

  RETURN QUERY SELECT v_group.id, v_group.name, 'joined'::text;
END;
$$;

COMMENT ON FUNCTION app_redeem_invite(text) IS
  'Redeem an invite token for the current profile. The only sanctioned way to insert a group_members row for yourself; returns (group_id, group_name, status) where status is joined | rejoined | already-member | invalid | revoked | expired | group-gone.';

-- Only a signed-in caller may redeem. anon/public get nothing.
REVOKE ALL ON FUNCTION app_redeem_invite(text) FROM public;
REVOKE ALL ON FUNCTION app_redeem_invite(text) FROM anon;
GRANT EXECUTE ON FUNCTION app_redeem_invite(text) TO authenticated;

-- ---------------------------------------------------------------------
-- HOW TO VERIFY (SQL editor, two accounts)
-- ---------------------------------------------------------------------
-- 1. As account A, create a group in the app and open a group invite.
--    Note the 8-character code (shown as ABCD-2345).
--
-- 2. As account B (a second browser profile / incognito, signed in),
--    run in the SQL editor *as that user* — or simply tap "הצטרף לקבוצה"
--    in the app, which calls exactly this:
--      SELECT * FROM app_redeem_invite('abcd 2345');   -- lowercase + space on purpose
--    Expect: (group id, group name, 'joined').
--
-- 3. Run it again → ('already-member'), and
--      SELECT count(*) FROM group_members
--       WHERE group_id = '<id>' AND profile_id = '<B>';   -- must stay 1
--
-- 4. Negative branches:
--      SELECT * FROM app_redeem_invite('ZZZZZZZZ');                  -- invalid
--      UPDATE invites SET revoked_at = now() WHERE token = '<T>';    -- then: revoked
--      UPDATE invites SET revoked_at = NULL,
--             expires_at = now() - interval '1 day' WHERE token='<T>'; -- then: expired
--      UPDATE groups SET deleted_at = now() WHERE id = '<id>';       -- then: group-gone
--    (undo the UPDATEs afterwards)
--
-- 5. Rejoin path:
--      UPDATE group_members SET status='left', left_at=now()
--       WHERE group_id='<id>' AND profile_id='<B>';
--      SELECT * FROM app_redeem_invite('<T>');   -- 'rejoined', row count still 1
--
-- 6. RLS is untouched: as B, before redeeming,
--      SELECT * FROM invites WHERE token = '<T>';   -- must return 0 rows
