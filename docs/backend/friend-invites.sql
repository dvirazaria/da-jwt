-- =====================================================================
-- "סוגרים קופה" — secure personal friend invites
-- Run AFTER docs/backend/schema.sql and docs/backend/rls-policies.sql.
-- Idempotent: safe to re-run after the base schema is installed.
-- =====================================================================
BEGIN;

-- Keep opaque tokens in their own table. In particular, do not add one to
-- profiles: profiles SELECT policies intentionally expose a profile to friends
-- and group-mates, neither of whom should ever receive an invite secret.
CREATE TABLE IF NOT EXISTS friend_invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE CHECK (length(token) >= 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE friend_invites IS
  'One stable opaque personal invite per profile. Tokens are resolved only by SECURITY DEFINER RPCs.';

CREATE INDEX IF NOT EXISTS friend_invites_profile_idx ON friend_invites (profile_id);

DROP TRIGGER IF EXISTS friend_invites_set_updated_at ON friend_invites;
CREATE TRIGGER friend_invites_set_updated_at
  BEFORE UPDATE ON friend_invites
  FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

ALTER TABLE friend_invites ENABLE ROW LEVEL SECURITY;
-- There are intentionally no table policies. Even authenticated users must
-- not SELECT by token; the functions below are the only public surface.
REVOKE ALL ON TABLE friend_invites FROM public;
REVOKE ALL ON TABLE friend_invites FROM anon;
REVOKE ALL ON TABLE friend_invites FROM authenticated;

CREATE OR REPLACE FUNCTION app_create_friend_invite()
RETURNS TABLE (token text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_id uuid;
  v_token text;
BEGIN
  v_profile_id := app_current_profile_id();
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'app_create_friend_invite: no signed-in profile' USING ERRCODE = '28000';
  END IF;

  SELECT fi.token INTO v_token
  FROM friend_invites fi
  WHERE fi.profile_id = v_profile_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_token, 'existing'::text;
    RETURN;
  END IF;

  -- 32 random bytes = 256 bits. Hex is URL-safe without client-side encoding.
  v_token := encode(gen_random_bytes(32), 'hex');
  BEGIN
    INSERT INTO friend_invites (profile_id, token) VALUES (v_profile_id, v_token);
    RETURN QUERY SELECT v_token, 'created'::text;
  EXCEPTION WHEN unique_violation THEN
    -- A second tab raced the first. Reuse that stable token instead of minting
    -- a second invitation or exposing a transient conflict to the client.
    SELECT fi.token INTO v_token FROM friend_invites fi WHERE fi.profile_id = v_profile_id;
    RETURN QUERY SELECT v_token, 'existing'::text;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION app_accept_friend_invite(p_token text)
RETURNS TABLE (status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receiver_id uuid;
  v_inviter_id uuid;
  v_friend friendships%ROWTYPE;
BEGIN
  v_receiver_id := app_current_profile_id();
  IF v_receiver_id IS NULL THEN
    RAISE EXCEPTION 'app_accept_friend_invite: no signed-in profile' USING ERRCODE = '28000';
  END IF;

  -- The token is opaque lowercase hex. btrim only makes pasted links benign;
  -- it does not loosen the token grammar or make token lookup selectable.
  SELECT fi.profile_id INTO v_inviter_id
  FROM friend_invites fi
  WHERE fi.token = lower(btrim(coalesce(p_token, '')));
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text;
    RETURN;
  END IF;
  IF v_inviter_id = v_receiver_id THEN
    RETURN QUERY SELECT 'self'::text;
    RETURN;
  END IF;

  SELECT f.* INTO v_friend
  FROM friendships f
  WHERE least(f.requester_profile_id, f.addressee_profile_id) = least(v_inviter_id, v_receiver_id)
    AND greatest(f.requester_profile_id, f.addressee_profile_id) = greatest(v_inviter_id, v_receiver_id)
  FOR UPDATE;

  IF FOUND THEN
    IF v_friend.status = 'accepted' THEN
      RETURN QUERY SELECT 'already-friends'::text;
      RETURN;
    END IF;
    UPDATE friendships
       SET status = 'accepted', responded_at = now(), updated_at = now()
     WHERE id = v_friend.id;
    RETURN QUERY SELECT 'accepted'::text;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO friendships (requester_profile_id, addressee_profile_id, status, responded_at)
    VALUES (v_inviter_id, v_receiver_id, 'accepted', now());
    RETURN QUERY SELECT 'accepted'::text;
  EXCEPTION WHEN unique_violation THEN
    -- The unordered unique index is the final concurrency guard. A concurrent
    -- accept has now committed, so turn a non-accepted row into accepted or
    -- report the relation as already accepted.
    SELECT f.* INTO v_friend
    FROM friendships f
    WHERE least(f.requester_profile_id, f.addressee_profile_id) = least(v_inviter_id, v_receiver_id)
      AND greatest(f.requester_profile_id, f.addressee_profile_id) = greatest(v_inviter_id, v_receiver_id)
    FOR UPDATE;
    IF v_friend.status = 'accepted' THEN
      RETURN QUERY SELECT 'already-friends'::text;
    ELSE
      UPDATE friendships
         SET status = 'accepted', responded_at = now(), updated_at = now()
       WHERE id = v_friend.id;
      RETURN QUERY SELECT 'accepted'::text;
    END IF;
  END;
END;
$$;

COMMENT ON FUNCTION app_create_friend_invite() IS
  'Returns the current profile''s stable 256-bit friend invite token; token values are never profile fields.';
COMMENT ON FUNCTION app_accept_friend_invite(text) IS
  'Accepts a personal friend token for the current profile and creates or accepts the unordered friendship.';

REVOKE ALL ON FUNCTION app_create_friend_invite() FROM public;
REVOKE ALL ON FUNCTION app_create_friend_invite() FROM anon;
GRANT EXECUTE ON FUNCTION app_create_friend_invite() TO authenticated;
REVOKE ALL ON FUNCTION app_accept_friend_invite(text) FROM public;
REVOKE ALL ON FUNCTION app_accept_friend_invite(text) FROM anon;
GRANT EXECUTE ON FUNCTION app_accept_friend_invite(text) TO authenticated;

COMMIT;
