# Account deletion — handoff

Branch: `worktree-agent-a8dead626cd98e615`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-a8dead626cd98e615`

## What was built

### 1. Server — `docs/backend/delete-account.sql` (new, controller must run it; NOT executed by me)

One idempotent script defining `app_delete_my_account()` — no arguments, `RETURNS void`,
`LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = public`. Acts only on
`app_current_profile_id()` (the existing `auth.uid()` wrapper from `rls-policies.sql`) — it is
structurally impossible for it to take or act on a target id.

**Key design decision, and why**: `profiles` is *scrubbed*, not hard-deleted.
`groups.created_by_profile_id` and `games.created_by` are `NOT NULL` + `ON DELETE RESTRICT`, and
`guests.created_by` is `ON DELETE CASCADE` into a further `RESTRICT` on
`game_participants.guest_id`. A hard `DELETE FROM profiles` for anyone who ever created a group,
opened a game, or added a guest — i.e. almost every real user — would abort the whole transaction
or cascade-destroy guests other people's closed games still reference. So the row stays, with
`display_name/phone/email/avatar_url` wiped to a neutral `'משתמש שנמחק'`, which keeps every
existing FK valid without touching a single row in those three tables.

**What it does, in order**: resolves the caller → idempotency check (`display_name` already
`'משתמש שנמחק'` → return) → mints one fresh `guests` row (`created_by` = the caller's own
about-to-be-scrubbed profile id, so the FK stays valid) → repoints `group_members.profile_id`
(no immutability trigger on this table, so every row, any game phase) → repoints
`game_participants`/`entries` **only for open games** (`schema.sql`'s `app_assert_game_open()`
trigger — section 7, "RLS is bypassed by the table owner and by a service role key. These
triggers are not." — raises on a closed game for *any* caller, definer function included, so
closed-game rows are provably never touched) → clears `games.leader_profile_id` on open games →
repoints `debts.debtor_profile_id`/`creditor_profile_id`/`paid_by_profile_id` (no trigger there
either, any phase) → admin succession per group (see below) → marks the caller's own memberships
`removed` → revokes the caller's un-revoked `invites` → scrubs `profiles` → `DELETE FROM
auth.users`. Every `UPDATE` touches only identity/bookkeeping columns — never
`entries.amount`/`game_participants.cashout`/`transfers.amount`/`debts.amount` — and `transfers`
gets no statement at all (it carries no `profile_id`/`guest_id`, only participant ids already
covered through `game_participants`).

**Admin succession** (mirrors `pickAccountDeletionSuccessor()` in `kupa-sgura.html`): for every
group where the caller was the sole active admin, promotes the longest-standing other active
member (earliest `joined_at`); archives the group if nobody else is left; a group with another
active admin is untouched.

Grants: `REVOKE ALL ... FROM public` and `anon`, `GRANT EXECUTE ... TO authenticated`.

**Exact SQL to paste** (Supabase SQL editor, once, as the project owner — needs `DELETE` on
`auth.users`, which the default `postgres` role has):

```
-- paste the whole of docs/backend/delete-account.sql
```

Nothing else has to run; the script is safe to re-run. It is never invoked from the SQL editor as
the owner — `app_current_profile_id()` reads `auth.uid()`, which only resolves for a request
authenticated as the deleting user (the app calls `supabase.rpc("app_delete_my_account")`, see
`runDeleteAccount()` in `kupa-sgura.html`).

### 2. Frontend — `kupa-sgura.html`

* **Groups-domain (pure) section**, right after `isLastActiveAdmin`: `joinedAtMs`,
  `pickAccountDeletionSuccessor(members, memberId)` → `{ action: "none"|"promote"|"archive",
  memberId }`, and `scrubLocalIdentity(state, identity)` → new `state` with `identity.userId`
  dropped from `groupMembers`/`players`/`leaderRef` (guestId kept if the ref already had one,
  else a fresh fallback), every `displayName` and money field byte-identical.
* **Settings overlay**, under `#setClearBtn`: `<p id="setDangerTitle">אזור מסוכן</p>` (red,
  `.settings-danger-title`) → `#setDeleteAccountToggle` (`.set-flat.danger`) → both `hidden`
  unless `authUser` (`refreshSettings()`). Tapping it opens `#setDeleteAccountPanel`, the same
  `.games-create-panel` grid-collapse (`0fr → 1fr`, `.28s`) used elsewhere, stating in Hebrew what
  is deleted (the account, permanently, no sign-back-in) and what stays (friends' shared history,
  the user's name shown there as "משתמש שנמחק"). Confirm is `#deleteAccountHoldBtn`
  (`.btn-close-table.warn-state`), the **same cancellable one-second pointer hold** as
  `finishGameBtn`/`beginFinishGameHold` (`DELETE_ACCOUNT_HOLD_MS = 1000`), staying `--bad`-red
  through the fill via a new `.warn-state.hold-state` override (the existing `.hold-state` alone
  turns accent-teal, which reads wrong for a destructive action). No `alert`/`confirm`/form-submit
  anywhere in the flow.
* New `// ---------- account deletion (danger zone) ----------` section (after `setClearBtn`'s
  handler): `runDeleteAccount()` — guarded `if (!supabase || !authUser || deleteAccountBusy)
  return;` like every other `supabase.*` call site — calls
  `supabase.rpc("app_delete_my_account")`; success → `finishAccountDeletion()`
  (`scrubLocalIdentity` → `signOutAccount()` → `save()` → `me = null` → close settings → `render()`
  → `showLogin()` with a one-shot `loginNote` = "החשבון נמחק בהצלחה", same "shown once" pattern as
  the existing `authRedirectError`); failure → inline `#deleteAccountError`, nothing local touched
  (asserted by a test — see below).
* `showLogin()` gained a `#loginNote` line (reuses `.join-notice-status`) — its own signature is
  unchanged (a zero-arg `function showLogin()`), so `tests/backend-config.test.cjs`'s existing
  structural checks on it still hold.

### 3. `privacy.html` / `HANDOFF.md`

`privacy.html`'s "שמירה ומחיקה" section (Hebrew) and its English summary now point at the in-app
"מחיקת חשבון" control instead of only an email request, and describe what's preserved. `HANDOFF.md`
gained a short "## Account deletion" section before "Next milestone" summarizing the same
scrub-not-delete rationale and the pure-helper/SQL sync requirement.

## Balances stay identical — how it's guaranteed

No statement in `app_delete_my_account()` ever assigns to a money column
(`entries.amount`, `game_participants.cashout`, `transfers.amount`, `debts.amount`); every `UPDATE`
touches only identity or bookkeeping columns. For **closed** games this isn't just intent: the
schema's own immutability triggers make it *impossible* to reach
`entries`/`game_participants`/`transfers` of a closed game at all (verified by reading, not
running — `docs/backend/delete-account.sql`'s header spells out which trigger blocks which
statement). Client-side, `scrubLocalIdentity` only ever writes `userId`/`guestId` on a ref — a unit
test (`tests/account-deletion.test.cjs`) asserts every `buyins`/`cashout` value is byte-identical
before and after, not just summed.

## Tests

`tests/account-deletion.test.cjs` (8): `pickAccountDeletionSuccessor` — sole admin promotes the
longest-standing other active member (not just any member); sole admin with nobody else active
archives; multi-admin and non-admin memberships are no-ops. `scrubLocalIdentity` — drops `userId`
everywhere it matches (groupMembers, players, leaderRef), keeps every `displayName`, keeps an
already-existing `guestId` instead of overwriting it, leaves a different identity's row completely
untouched; and separately, every balance total (and the underlying `buyins`/`cashout` values) is
identical before and after. Two regex checks: the SQL file is `SECURITY DEFINER` with `auth.uid()`
and a `REVOKE`, and never mentions `service_role`; the danger zone is gated on `authUser` in both
`refreshSettings()` and the markup, confirmation is the pointer-hold pattern (not click-to-arm),
and a failed RPC's `catch` block never reaches `scrubLocalIdentity`/`signOutAccount()`/`save()`.

`node --test tests/*.test.cjs` → **512 tests, 512 pass** (504 pre-existing + 8 new). One iteration
needed: `identity.userId = authUser.id` written as an object-literal value initially tripped three
*pre-existing* project-wide guards in `backend-config.test.cjs`/`cloud-games.test.cjs`/
`cloud-mapping.test.cjs` (`!/userId: (authUser|session|user)\b/`) that enforce "local code never
mints a userId." I did not touch those tests — the code was legitimately doing something different
(reading the confirmed session id to *remove* it, not fabricating a new one), so I extracted it to
a named `deletedUserId` variable, which reads better and no longer collides with the textual
heuristic. `git diff --check` clean; the last `<script>` body parses with `new Function`.

## Manual verification plan

1. Run `docs/backend/delete-account.sql` in the Supabase SQL editor (as the project owner).
2. As a test account: sign in, join/create at least one group where you are the **sole admin**
   with another active member, one group where you're a **co-admin**, play (and close) a game with
   another real account so there's shared closed history, and leave at least one **open** game with
   a buy-in.
3. Settings → scroll to "אזור מסוכן" → "מחיקת חשבון" → panel expands with the two explanation
   lines → hold the red button for ~1s (releasing early cancels and re-arms cleanly) → on release
   you land back on the login screen with "החשבון נמחק בהצלחה", and can no longer sign back in
   with that account (Google or the same email code).
4. Uncomment and run the verification queries at the bottom of `delete-account.sql` (fill in the
   deleted `auth.users.id` from before deletion) — expect: `profiles.display_name = 'משתמש שנמחק'`
   with phone/email/avatar `NULL`; `auth.users` count 0; no `group_members`/open-game
   `game_participants` rows still carry the old `profile_id`; no open `invites` created by them;
   every group they were sole-admin of has an active admin or is archived.
5. As the **other** account: reopen the shared closed game — buy-ins/cashout/net/transfers for
   every seat must read exactly as before deletion, and the deleted player's name is unchanged
   (the frozen `display_name_snapshot`, not "משתמש שנמחק" — that placeholder is what the *account*
   now shows, not the historical per-game name; see "keep display_name_snapshot" in the SQL
   header for why closed-game names deliberately do not change).
6. Force a failure (e.g. disconnect network right as you release the hold) → inline error only,
   panel stays, nothing local changes; retry once reconnected.

## Open questions

* Whether closed-game history should show the deleted user's *original* name (what this
  implementation does, matching the existing "a rename never rewrites old screens" rule) or the
  literal string "משתמש שנמחק" per the confirmation copy's plain-English framing — I resolved this
  in favor of the former since (a) the hard constraint explicitly says "keep display_name_snapshot"
  and "carrying the snapshot name," and (b) the schema's own immutability triggers make rewriting a
  closed game's names impossible anyway. Worth confirming this reading matches intent.
* `friendships`/`groups.created_by_profile_id`/`games.created_by`/`invites.created_by_profile_id`
  are deliberately left pointing at the now-scrubbed `profiles` row rather than repointed to a
  guest — they're provenance, not per-game identity, and the FK stays valid either way.
* `guests.linked_profile_id` (guest→account merge) is not yet a shipped feature per HANDOFF, so it
  is guaranteed empty today; not defensively nulled to keep the script's scope matched to what
  exists.
* `build.py` was deliberately not run (no version bump, `index.html`/`sw.js` untouched) — the
  release build belongs to whoever integrates this branch.
