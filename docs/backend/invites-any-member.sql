-- =====================================================================
-- "סוגרים קופה" — invites-any-member.sql
--
-- DECISION PENDING — do not run until the owner chooses. See below.
--
-- WHAT THIS IS
-- The app and the database disagree about who may create a group invite,
-- and the disagreement is what broke joining for the owner's friends:
--
--   DESIGN.md, group-settings overlay:
--     "(1) 'הזמנה לקבוצה' — גלוי לכל חבר פעיל; (2) 'הוספת חבר' — למנהלים בלבד"
--   docs/superpowers/plans/2026-09-08-pre-backend-gaps.md line 33:
--     "כל חבר יכול לשתף הזמנה ... ביטול = admin בלבד"
--
--   docs/backend/rls-policies.sql, as applied:
--     CREATE POLICY invites_insert_admin ON invites FOR INSERT TO authenticated
--       WITH CHECK (app_is_group_admin(group_id) AND created_by_profile_id = app_current_profile_id());
--
-- So a non-admin member tapped "צור הזמנה", the app created the invite
-- locally and rendered a code, a link and a QR for it — and the push was
-- refused 42501. The invite never existed on the server, so the link and
-- the QR pointed at a token nobody could redeem, and the sync dot went red.
-- One cause, all three symptoms.
--
-- SHIPPED RIGHT NOW (v73): the client no longer offers invite creation to a
-- non-admin, so nobody is handed a dead link any more. That stops the
-- bleeding but it also takes away a capability the design deliberately gave
-- every active member.
--
-- THE CHOICE
--   A. Run this file. Any ACTIVE member may create an invite, matching
--      DESIGN.md. Revoking stays admin-only, unchanged. The client guard
--      added in v73 should then be removed (tests/invites.test.cjs pins it).
--      Consequence: any member can bring someone new into the group.
--   B. Do not run it. Invites stay admin-only, and DESIGN.md plus the
--      gap-analysis line above should be corrected to say so, since they
--      currently promise otherwise.
--
-- This file implements A. It is idempotent and transactional.
-- =====================================================================

BEGIN;

-- Same shape as before, with app_is_group_admin widened to active membership.
-- created_by_profile_id = app_current_profile_id() is kept: an invite still
-- records who really made it, and nobody can forge another member's name onto
-- one. Revoking remains invites_update_admin, untouched.
DROP POLICY IF EXISTS invites_insert_admin ON invites;
CREATE POLICY invites_insert_member ON invites FOR INSERT TO authenticated
  WITH CHECK (
    app_is_active_group_member(group_id)
    AND created_by_profile_id = app_current_profile_id()
  );

COMMIT;

-- Verify afterwards (read-only):
--   SELECT polname, pg_get_expr(polwithcheck, polrelid)
--     FROM pg_policy WHERE polrelid = 'invites'::regclass AND polcmd = 'a';
--   -- expect invites_insert_member, and app_is_active_group_member in the expression
