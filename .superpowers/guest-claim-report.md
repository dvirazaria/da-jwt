# Guest → account linking ("זה אני") — handoff

Branch: `worktree-agent-aafcfa23bba5cf595`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-aafcfa23bba5cf595`

## The authorization rule, and why

**Requested by the signing-in user (acting only as their own `auth.uid()`), approved only by
someone with standing over the *guest* side — the guest's creator, or an active admin of a group
the guest belongs to — and never by the claimant themselves, even if they happen to also hold one
of those roles.**

Why this shape:

- **Never by name alone.** Names collide; a wrong merge hands one person another person's debts.
  Candidate detection (`guestClaimCandidatesInGroup`) only ever produces a *suggestion* — it has no
  write path. The merge only happens inside `app_approve_guest_claim`, gated on the check below.
- **The claimant cannot self-authorize.** `app_request_guest_claim` takes no target-profile
  parameter — it can only ever act on `app_current_profile_id()` — so nobody can request a claim
  *for* someone else. And `app_approve_guest_claim` explicitly refuses when
  `v_approver = v_claim.claimant_profile_id`, even if that same person also happens to be the
  guest's creator or an admin of a shared group. The second, independent human is mandatory on
  every code path, not just the common one.
- **Standing lives with the guest, not the claimant.** The approver must be able to vouch for who
  the guest actually is: the person who typed the guest's name into a roster in the first place
  (`guests.created_by`), or whoever is responsible for that table's membership list (an active
  admin, not just any active member — the same bar the app already uses for removing/promoting a
  member). A plain member cannot approve.
- **This mirrors an existing decision, not an invented one.** `rls-policies.sql`'s own comment on
  `guests_update_creator` already anticipated this: *"The guest -> account merge (setting
  linked_profile_id) must be a SECURITY DEFINER RPC that verifies both sides consented; a plain
  UPDATE would let a creator attach someone else's account to a guest row."* This SQL is that RPC.

## What was built

### 1. Server — `docs/backend/link-guest.sql` (new, controller must run it)

One idempotent, paste-ready script (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
`DROP POLICY IF EXISTS` before each `CREATE POLICY`):

- **`guest_claims` table** — `guest_id`, `claimant_profile_id`,
  `claimant_display_name_snapshot` (frozen at request time — the approver may share no group and
  no friendship with the claimant yet, so a live `profiles` SELECT could legitimately return
  nothing; the request function reads it with definer rights instead), `status` (`pending` /
  `approved` / `rejected`), `requested_at`/`responded_at`/`responded_by_profile_id`. A partial
  unique index allows at most one **pending** claim per guest at a time. RLS: `SELECT` only, to the
  claimant or to `app_can_approve_guest_claim(guest_id)` — there is **no INSERT/UPDATE/DELETE
  policy at all**, so every write is forced through the three functions below (same pattern as
  `join-invite.sql`: `group_members_insert_admin` still refuses a joiner's self-insert even though
  the redemption RPC exists).
- **`app_can_approve_guest_claim(p_guest_id)`** — the shared standing predicate (creator OR active
  group admin), `SECURITY DEFINER STABLE`, used by both the RLS policy and the two functions below
  so they can never disagree about who qualifies.
- **`app_request_guest_claim(p_guest_id)`** — "זה אני". Returns
  `(claim_id, status)`, status ∈ `pending | already-you | already-linked | claim-in-progress |
  not-found`. Idempotent (re-tapping while my own request is pending returns the same row).
- **`app_approve_guest_claim(p_claim_id)`** — the actual merge. Locks `guests` **before**
  `guest_claims` (matching the lock order `app_request_guest_claim` uses, so a request racing an
  approval serializes instead of risking a deadlock on opposite lock orders — caught and fixed
  during review, not present in the first draft). Re-points, **only after the double-seat guard
  passes**:
  - `game_participants.{profile_id,guest_id}` — guarded by the double-seat check.
  - `debts.{debtor,creditor}_{profile_id,guest_id}` — both sides independently; `debts_distinct_chk`
    can never fire because a debt only exists between two participants of the *same* game, and the
    double-seat guard already refused any game where the claimant and this guest are both seated.
  - `games.leader_profile_id`/`leader_guest_id` — not in the task's literal list, but
    `games_leader_identity_chk` makes it exactly the same identity-pattern column as the others, so
    reading the CHECK constraints first (as instructed) turned this up.
  - `group_members.{profile_id,guest_id}` — **skipped per-row** (not aborted) when the claimant
    already holds an independent *active* membership in that same group
    (`group_members_active_profile_uk` would otherwise reject it). This is the realistic common
    path: `guests_select` requires being an active member of a group before you can even see the
    old guest there, so a claimant who joined fresh under their own account before discovering the
    guest is the expected case, not an edge case. The merge stays correct regardless — the
    leaderboard/history joins key off `game_participants`' identity, which already moved.
  - `transfers` / `entries` — **verified to need no change at all.** They reference
    `game_participants.id` / `from_participant_id` / `to_participant_id`, not a `guest_id`/
    `profile_id` column, so they automatically follow the participant row the instant it moves.
    (`entries.created_by` is who *recorded* the buy-in — always a profile, since a guest never has
    a session — not whose buy-in it was; correctly left alone.)
  - `display_name_snapshot` / `debtor_name` / `creditor_name` — deliberately **not** rewritten:
    frozen history, the same rule `schema.sql` already documents for name snapshots.
  - Refuses and rolls back with `GUEST_CLAIM_DOUBLE_SEAT` if the claimant already sits at any game
    the guest also sits at (checked once, protects `game_participants`, `debts` and transitively
    `games.leader_*`); `GUEST_CLAIM_ALREADY_LINKED` if the guest got linked to someone else first
    (e.g. two approvals raced); `GUEST_CLAIM_NOT_AUTHORIZED` for the authorization rule above.
    Idempotent replay on an already-`approved` claim.
- **`app_decline_guest_claim(p_claim_id)`** — "דחה" (the approver) or "ביטול" (the claimant
  withdrawing, mirroring `friendships_delete_requester`). Idempotent on an already-resolved claim.
- Standard hardening on all three: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`,
  `REVOKE ALL ... FROM public/anon`, `GRANT EXECUTE ... TO authenticated`.
- **A documented, deliberately-not-applied gap**: `guests_update_creator` in `rls-policies.sql`
  technically still lets a guest's creator `UPDATE` `linked_profile_id`/`linked_at` directly (RLS
  cannot express "every column except these two"). The fix is a column-level
  `GRANT UPDATE (display_name, created_by) ON guests` — `created_by` has to stay grantable because
  `guestToRow`'s push payload always re-sends it, even unchanged, and PostgREST's
  `ON CONFLICT DO UPDATE` needs every payload column to be writable. I traced `guestToRow` and
  `pushCloudRun` far enough to be confident that specific grant is *safe*, but I cannot execute SQL
  in this task to confirm what the actual generated `DO UPDATE SET` column list looks like (in
  particular whether it also touches the conflict-key column `id`), and breaking the existing,
  tested, working guest-push sync would be far worse than leaving this gap open one more round. Did
  not ship it. The blast radius meanwhile is narrow: a direct `UPDATE` alone moves no
  `game_participants`/`debts`/`group_members` row — only `app_approve_guest_claim` does that — so
  the worst case today is a privacy leak of a guest row's `display_name` to an unintended
  `linked_profile_id`, or grief-blocking a future legitimate claim.

**Exact SQL to paste** (Supabase SQL editor, once, after `schema.sql` → `rls-policies.sql` →
`join-invite.sql` are already applied):

```
-- paste the whole of docs/backend/link-guest.sql
```

Safe to re-run (every statement is `IF NOT EXISTS` / `OR REPLACE` / `DROP ... IF EXISTS` first).

### 2. Frontend — `kupa-sgura.html`

- **`// ---------- groups domain (pure) ----------`** (after `dedupeParticipants`):
  `seatsGuestAndUser(players, guestId, userId)` — local mirror of the SQL double-seat guard, scoped
  to what a device can actually check (the current open table; closed-game history never records a
  `userId`, so the RPC stays authoritative there). `applyGuestClaimLocally(collections, guestId,
  userId)` — rewrites every `{guestId, userId}`-shaped ref (`groups.createdBy`, `groupMembers`,
  `invites.createdBy`, `friendships.requester`/`addressee`, `players`) from the old guestId to the
  new userId, touching nothing else (no money field).
- **`// ---------- cloud mapping (pure) ----------`** (after `guestToRow`):
  `guestClaimCandidatesInGroup(guestRows, groupMembers, claims, groupId, meUserId, meName)` and
  `guestClaimsForGroup(claims, groupMembers, groupId, meUserId)` — pure filters over the raw pulled
  rows; RLS already narrowed `guestRows`/`claims` to what this device may see, so nothing here
  re-derives a visibility or authorization decision.
- **Cloud store**: `pullCloud()` now also selects `guests`/`guest_claims` (best-effort — a query
  error degrades to "no candidates offered", never fails the rest of the pull) into two new
  in-memory-only variables, `cloudGuestRows`/`cloudGuestClaims` — same pattern as
  `cloudProfileIds`/`cloudGameCreators`: never `state`, never a new localStorage key, reset in
  `enterCloudMode()`/`exitCloudMode()`.
- **New `// ---------- guest claim ----------` section** (before boot, next to "join by invite"):
  `requestGuestClaim`, `resolveGuestClaim` (shared by `cancelGuestClaim`/`declineGuestClaim`),
  `approveGuestClaim` — each `supabase.rpc(...)`, guarded `if (!supabase) return;` /
  `!cloudMode()` (the literal two-line pattern `tests/backend-config.test.cjs` enforces across the
  file), busy-locked per guest/claim id, inline errors only (`guestClaimErrorMessage` maps each
  `GUEST_CLAIM_*` to a short Hebrew line), and a `pullCloud()` refresh on success. `approveGuestClaim`
  also applies `applyGuestClaimLocally` to the approver's own `state` optimistically before the
  pull lands, then `save()`s — not the source of truth, just skips the approver a wait.
  `dismissGuestClaimCandidate` ("לא") is purely local — an in-memory `Set`, never `save()`d, same
  spirit as the existing `hiddenAt` "quiet and local" precedent, so a future pull may re-offer it.
- **`renderGroupGuestClaims(groupId)`** — wired into both `renderGroupPage()` and
  `renderGroupPreview()` (the dashboard's group overlay), so the same identity work is visible from
  either surface. No-op (`return null`) outside cloud mode or when there is nothing to show.
  Reuses `renderFriendGroup` — the exact `.debt-row`/`.friend-action` rows the friend-request UI
  already uses — rather than a new component: zero new CSS, `.friend-action` already has
  `min-height: 44px`, `.debt-row` already animates in (`animation: rise .3s ease both`, staggered),
  both themes already flow through the same CSS variables. Three rows, all inline, no modal:
  "שיחקת כאן בעבר בשם X?" / "זה אני" / "לא"; "הבקשה שלך" / "ממתין לאישור" / "ביטול"; "בקשות קישור"
  ("[claimant] מבקש/ת להיות [guest]") / "אשר" / "דחה".

## Tests

`tests/guest-claim.test.cjs` — 7 tests, vm-sliced exactly like `tests/groups-domain.test.cjs`
(same wide slice, `groups domain (pure)` through `function el(`, since both new pure sections sit
inside it):

1. `guestClaimCandidatesInGroup` offers an unlinked same-name guest seated in my group.
2. …excludes a linked guest, a different group, a name mismatch, an in-flight claim, and returns
   `[]` in local/offline mode (`meUserId` null — `ParticipantRef.userId` is always null pre-account).
3. `seatsGuestAndUser` mirrors the SQL double-seat guard (both seated → true; either alone, or
   empty ids → false).
4. `applyGuestClaimLocally` rewrites every `guestId` reference to `userId` across
   groups/groupMembers/invites/friendships/players, leaving an unrelated identity untouched.
5. …only ever touches identity fields — buyins/cashout totals identical before/after.
6. …is idempotent — a second call changes nothing further.
7. `link-guest.sql` is `security definer`, keyed off `auth.uid()` via the documented vendor seam
   (`app_current_profile_id()`, since the codebase's own convention — confirmed by
   `join-invite.sql`'s identical comment — is that `auth.uid()` lives *only* in
   `rls-policies.sql`; I matched that instead of inlining `auth.uid()` directly, and the SQL file's
   own header comment says so, which is what the regex actually finds), `revoke`s the public
   default, never mentions `service_role`, and never takes a spoofable target-profile parameter.

`node --test tests/*.test.cjs` → **511 pass, 0 fail** (including the pre-existing
`tests/backend-config.test.cjs` guard that every `supabase.*` call site has an explicit
`if (!supabase) return` — my first draft combined that check with a busy-id check on one line and
failed it; fixed by splitting into the same two-line shape `redeemInviteToken` already uses).

`git diff --check` clean. The last `<script>` body parses with `new Function`.

## Manual verification plan (two accounts + a helper)

1. Run `docs/backend/link-guest.sql` in the Supabase SQL editor (after schema/RLS/join-invite).
2. **Setup**, account A: create a group, add a guest "אורי" to it (or play an ad-hoc game with
   "אורי" as a guest — either way A is `guests.created_by`). In the SQL editor:
   `SELECT id FROM guests WHERE display_name = 'אורי';` → note it as `<GUEST>`.
3. **Account B** (the real Uri, a second signed-in account): join A's group (an invite link is the
   realistic path — this is also what makes the guest visible to B via `guests_select` in the first
   place). Open the group page — the "שיחקת כאן בעבר בשם אורי?" row should appear. Tap "זה אני" →
   the row should switch to "הבקשה שלך" / "ממתין לאישור" (no alert, no modal, animated in).
4. **Account A**: open the same group — a "בקשות קישור" row should show "[B's name] מבקש/ת להיות
   אורי" with "אשר"/"דחה". Tap "אשר".
5. Both accounts: reload / let the next pull land. B's group page should now show B, not "אורי", in
   the member list; any of "אורי"'s old debts should now appear under B's own profile "אני
   חייב"/"חייבים לי", with the amounts unchanged; any closed game "אורי" played should now count
   toward B on the group leaderboard.
6. **Negative — double seat**: before approving, have B *also* buy into a currently-open game that
   "אורי" is already seated in (as themselves, a separate seat), then have A tap "אשר". Expect an
   inline error ("אי אפשר לקשר — שניכם כבר יושבים באותו משחק"), and "אורי"'s row must still be
   there, unmerged — nothing partially applied.
7. **Negative — no self-approval**: as B, if B is also (independently) an admin of the shared
   group, confirm B does **not** see an "אשר" button on their own pending request — only "ביטול".
8. **Local/offline mode**: sign out (or open with no Supabase session) — the group page must show
   nothing guest-claim-related at all, and no `supabase.*` calls should fire (Network tab / no
   console errors) even if a candidate would otherwise match.
9. The SQL file's own "HOW TO VERIFY" block at the bottom covers the same scenarios purely from the
   SQL editor (including `already-you`/`already-linked`/`claim-in-progress`/idempotent-replay),
   which is faster to drive than the UI for the less common branches.

## Open questions / follow-ups

- The `guests_update_creator` column-grant gap above — needs a staging-project check of the actual
  generated upsert SQL before shipping the tightened grant.
- `build.py` was deliberately not run (no version bump, `index.html`/`sw.js` untouched) and no SQL
  was executed — both per the task's explicit instructions; that's for whoever integrates this
  branch.
- Two account-visible surfaces show `renderGroupGuestClaims` (the group page and the dashboard's
  group-preview overlay) for consistency; the group *settings* overlay does not duplicate it —
  seemed like enough surface area without adding a third.
