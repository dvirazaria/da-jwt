-- =====================================================================
-- "סוגרים קופה" — guest linking, path 2: verified contact match
-- Run AFTER docs/backend/link-guest.sql. Idempotent, paste-ready, wrapped
-- in one transaction — but see the finding below: THIS FILE SHIPS NO NEW
-- LINKING FUNCTION. It documents a completed investigation and installs
-- one small, safe regression tripwire. Re-running it is a no-op beyond
-- re-checking that tripwire.
--
-- TASK: build an automatic guest->account link when a newly signed-in
-- user's contact address is one the identity provider has itself
-- confirmed (Google's `email_verified` claim), tried before path 3
-- (zero-exposure self-claim) in link-guest.sql. VERDICT: cannot be built
-- as specified, for a structural reason that has nothing to do with
-- whether the verified claim is reachable (it is — see part 1). Part 2
-- explains why matching still fails; part 3 is the recommended next step.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PART 1 — where the verified claim actually lives (confirmed, not assumed)
-- ---------------------------------------------------------------------
-- CONFIRMED (Supabase's own docs, docs.supabase.com/guides/auth/managing-user-data and
-- docs.supabase.com/guides/database/postgres/row-level-security, checked 2026-09-10):
--   * auth.jwt() exposes the session JWT's claims inside Postgres, including
--     `app_metadata` and `user_metadata`.
--   * Supabase's own guidance is explicit that `user_metadata` (backed by
--     `auth.users.raw_user_meta_data`) is writable by the end user via
--     `supabase.auth.updateUser()`, and warns against using it for anything
--     security-relevant in RLS/policies for exactly that reason.
--   * For an OAuth identity, the provider's own `email_verified` flag is what
--     Supabase copies into that same client-writable `user_metadata` bucket at
--     first sign-in. Nothing stops a later `updateUser({ data: { email_verified:
--     true } })` call from overwriting it just as convincingly for an address the
--     provider never confirmed. So `auth.jwt() -> 'user_metadata' ->> 'email_verified'`
--     is NOT the provider's claim by the time a client can influence it — it is,
--     at best, a same-as-signup-time copy of it.
--   * The field this project should trust instead is `auth.users.email_confirmed_at`
--     (checked directly, not through the JWT): Supabase's Auth service — not any
--     client call — sets this column, and it is set for a Google identity based on
--     the provider's own confirmation at first sign-in. It is reachable from any
--     `SECURITY DEFINER` function in this schema via a direct `SELECT ... FROM
--     auth.users WHERE id = auth.uid()` (the same `auth.users` table
--     app_current_profile_id()'s callers already sit behind — see
--     rls-policies.sql's own comment on why `profiles.id` couples to it).
--
-- ASSUMED, NOT CONFIRMED: this project cannot run SQL against the live Supabase
-- project (task instruction: "Do NOT run any SQL"), so nobody has actually queried
-- a real Google-signed-in row's `auth.users.email_confirmed_at` /
-- `auth.identities.identity_data->>'email_verified'` here to see the literal value.
-- The Supabase documentation cited above describes the general contract for every
-- project; a controller applying this file should spot-check
-- `SELECT email, email_confirmed_at FROM auth.users WHERE id = auth.uid()` once,
-- signed in with Google, before leaning on it for anything.
--
-- CONCLUSION OF PART 1: a reachable, provider-backed, non-spoofable verified claim
-- DOES exist (`auth.users.email_confirmed_at`, read directly, never through
-- `user_metadata`). The feature is not blocked by claim availability.

-- ---------------------------------------------------------------------
-- PART 2 — why the feature still cannot be built (the guest side, not the caller side)
-- ---------------------------------------------------------------------
-- The caller's own address can be trusted (Part 1). The problem is the OTHER side
-- of the match: WHAT ON THE GUEST does that address get compared against?
--
-- guests (schema.sql) carries `id, display_name, created_by, linked_profile_id,
-- linked_at, created_at, updated_at` — no email, no phone, no contact column of
-- any kind. Nothing in kupa-sgura.html captures one either: a guest is created only
-- by a typed display name (addMemberByName / renderStartGameAddGuest); there is no
-- `state.guests` collection, confirmed by grep. So a verified-contact match has
-- nothing on the guest row to compare the caller's verified email against, today.
--
-- The obvious fix — add `guests.contact_email`, filled in by whoever adds the guest
-- — reintroduces exactly the class of bug the two blocked branches
-- (codex/tier2-sql @ a7b8065, codex/tier2-client @ fa6f684) shipped, just moved to
-- the other side of the equals sign. Verifying the CALLER's half (Part 1) does not
-- fix it, because the vulnerability was never about the caller's half:
--
--   Alice adds a guest to a group Bob has never joined and privately types Bob's
--   real email address as that guest's `contact_email` (nothing stops her — she is
--   not required to prove she is Bob, and the app has no channel to ask Bob whether
--   he agreed). Months later Bob signs up for an unrelated reason, with his own,
--   genuinely provider-verified Gmail address. An automatic match now silently
--   attaches Alice's guest — and every debt and game history under it — to Bob's
--   brand-new account, in a group Bob may not even know exists, with no invite, no
--   tap, no visible standing check on Bob's side at all. Bob's email being real and
--   provider-verified does not help: the match still fires on a value Alice typed
--   about Bob, which the provider never confirmed Bob supplied. That is the same
--   "matched on an email/phone stored on the guest row that nobody had verified"
--   failure this task was told to avoid — verifying the SIGN-IN side cannot repair
--   a hole on the DATA side.
--
-- Path 1 (invite-bound linking) and path 3 (zero-exposure self-claim) both avoid
-- this because the guest side is never a bare data value: path 1's authorization is
-- a specific member deliberately picking a specific guest while holding admin
-- standing over that exact group; path 3's authorization is the claimant already
-- being a visible, active member of a group that guest also belongs to, plus a
-- financial-risk gate. Neither trusts typed contact info as a substitute for a
-- human, in-context decision. A bare `contact_email` column has no such anchor —
-- it is exactly the shape of data the two blocked branches leaned on.
--
-- CONCLUSION OF PART 2: this is not a missing-claim problem (Part 1 solved that) and
-- not a fixable-with-more-caution problem — it is a missing-authorization problem.
-- No amount of hardening the caller's own proof of identity substitutes for a human
-- decision on the guest's side, which paths 1 and 3 already supply and this path
-- would bypass entirely. Building `guests.contact_email` + an automatic matcher on
-- top of it ships the same defect the task named as already rejected, wearing a
-- more convincing caller-side credential. Not built.

-- ---------------------------------------------------------------------
-- PART 3 — duplicate address, zero-exposure override, silent-vs-shown (answered on the
-- hypothetical this file declines to ship, for the record, since the task asked)
-- ---------------------------------------------------------------------
-- * Two guests, same address: refuse rather than guess, in any future design. An
--   address is not a primary key here (nothing constrains guests.contact_email to
--   be unique, and it should not be — two different unrelated guests, added by two
--   different people in two different groups, may coincidentally share a typed
--   value that is wrong on one or both rows). A match against more than one
--   candidate must return an unresolved status a human then disambiguates through
--   an already-authorized channel (path 1 or path 3), never an automatic pick of
--   "the first one" or "the most recent one."
-- * Zero-exposure override: verification must NOT override it. Path 3's exposure
--   gate exists because an automatic, no-approval merge must never be allowed to
--   move money without a human in the loop; nothing about how well the CALLER's
--   own identity is verified changes whether the GUEST side's authorization is
--   real (Part 2). If this path existed, it would inherit path 3's
--   app_guest_has_zero_exposure gate unchanged, not bypass it.
-- * Silent vs. shown: shown, not silent — the opposite of path 1's silent link.
--   Path 1 is silent because the authorizing decision already happened, in the
--   open, when a specific member picked a specific guest. A verified-contact match
--   would be the first path where the "authorization" is an inference from data
--   rather than a witnessed action, so the person on the receiving end must see
--   what was proposed and would need to confirm it — which reintroduces exactly the
--   approval step v2's report already rejected as costing a new user's first
--   minute. That tension (inference needs confirmation; confirmation reintroduces
--   the friction this whole feature exists to remove) is the last nail: even with
--   a safe contact model, path 2 would not clear the same "zero approvals in the
--   happy path" bar paths 1 and 3 already clear.

-- ---------------------------------------------------------------------
-- PART 4 — recommended nearest safe alternative (not built here; a real follow-up)
-- ---------------------------------------------------------------------
-- Strengthen path 1 instead of building a new path: let the member creating an
-- invite optionally type the invitee's expected email alongside (or instead of)
-- picking an existing guest chip (renderInviteGuestBindPicker already exists for
-- the guest-chip half). app_redeem_invite would compare that typed value against
-- the redeemer's own Part-1-grade verified email (auth.users.email_confirmed_at)
-- as an EXTRA confirmation before silently linking bound_guest_id — never as the
-- sole authorization. The authorizing act stays a specific member's deliberate
-- choice (identical trust anchor to today's path 1); verification only adds a
-- machine-checkable safety net on top of an already-authorized action, instead of
-- trying to manufacture authorization out of data that was never confirmed by
-- anyone. This still needs an `invites.expected_email` column and RPC changes, so
-- it is left as a follow-up rather than folded into this pass.

-- ---------------------------------------------------------------------
-- PART 5 — the one thing this file actually installs: a regression tripwire
-- ---------------------------------------------------------------------
-- If a later change adds a contact column to `guests` without also updating this
-- file's reasoning, this DO block fails loudly instead of letting an automatic
-- matcher get built silently on top of it. Idempotent: safe to run every time this
-- file is pasted, including with no schema change since the last run.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'guests'
      AND column_name IN ('email', 'contact_email', 'phone', 'contact_phone')
  ) THEN
    RAISE EXCEPTION
      'verified-link.sql: guests gained a contact column. Re-read PART 2 above before building any matcher against it — never expose or ship an automatic link on a value nobody but its typist ever confirmed.';
  END IF;
END;
$$;

COMMIT;

-- ---------------------------------------------------------------------
-- HOW TO VERIFY
-- ---------------------------------------------------------------------
-- 1. Paste this file. Expect it to complete with no error (guests has no contact
--    column yet) and change nothing.
-- 2. Optional, once, signed in with Google, to close the ASSUMED gap in Part 1:
--      SELECT email, email_confirmed_at FROM auth.users WHERE id = auth.uid();
--    Expect email_confirmed_at to be non-null for the Google-verified address.
-- 3. `ALTER TABLE guests ADD COLUMN contact_email text;` then re-paste this file —
--    expect the DO block above to raise. `ALTER TABLE guests DROP COLUMN
--    contact_email;` to restore.
