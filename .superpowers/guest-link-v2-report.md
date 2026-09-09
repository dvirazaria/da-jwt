# Guest → account linking, v2 — no approval step — handoff

Branch: `worktree-agent-a5e3f8f407f3246bb`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-a5e3f8f407f3246bb`

## What changed, and why

The previous design (`.superpowers/guest-claim-report.md`, never executed against the project) put
a human approval — the guest's creator or a group admin saying "אשר" — in a brand-new user's first
minute. Safe, but it delays their own history behind someone else's availability. This version
ships **zero approvals in the happy path**, with friction scaled to financial risk instead of
applied uniformly, in three paths tried in this order:

1. **Invite-bound linking (primary).** A member creates an invite and optionally binds it to one
   existing, unlinked guest of that group. Redeeming that exact token links the guest to whoever
   signs in, silently, in the same transaction as joining.
2. **Verified contact match (automatic fast path) — not shipped.** See "What was skipped" below.
3. **Zero-exposure self-claim (fallback).** Someone who joined without a bound link may claim a
   matching guest themselves, instantly, but only when doing so cannot move money.

All three funnel through one shared, **ungranted** re-pointing engine
(`app_link_guest_to_profile`) and the same double-seat guard, so balances stay identical no matter
which door a person came in through — exactly the invariant the design it replaces protected.

**Deleted, not layered on top of:** the `guest_claims` table, `app_request_guest_claim`,
`app_approve_guest_claim`, `app_decline_guest_claim`, `app_can_approve_guest_claim`, and the
group-page approval UI (`requestGuestClaim`, `resolveGuestClaim`/`cancelGuestClaim`/
`declineGuestClaim`, `approveGuestClaim`, `guestDisplayName`, the "הבקשה שלך"/"בקשות קישור" rows).
`guestClaimCandidatesInGroup` and `renderGroupGuestClaims` were kept and rewritten (same names, new
bodies); `seatsGuestAndUser` and `applyGuestClaimLocally` were kept unchanged (still shared by
every path). Confirmed zero remaining references to `guest_claims`, `GUEST_CLAIM_*`,
`app_request_guest_claim`, `app_approve_guest_claim`, or `app_decline_guest_claim` anywhere in
`kupa-sgura.html` or `docs/backend/`.

## The exact SQL to paste

```
-- paste the whole of docs/backend/link-guest.sql
```

Run once, in the Supabase SQL editor, after `schema.sql` → `rls-policies.sql` → `join-invite.sql`
(and `fix-upsert-policies.sql` / `security-fixes.sql`, if already applied — this file redefines two
of their policies on top of whatever they last left, the same layered pattern those two files
already use on top of `rls-policies.sql`). Safe to re-run: every statement is `ALTER ... ADD COLUMN
IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP ... IF EXISTS` before each `CREATE`. The file opens
with `DROP FUNCTION`/`DROP TABLE IF EXISTS` for the old consent flow's objects — pure cleanup, since
nothing from that design was ever run against the project (confirmed by the task brief).

What it adds: `invites.bound_guest_id` (nullable FK to `guests`, insert-time-validated by a new
`app_guest_bindable_to_invite` predicate folded into a redefined `invites_insert_admin`);
`app_guest_has_zero_exposure` (the path-3 gate, shared by client and server); `app_link_guest_to_profile`
(internal, `REVOKE ALL` from every role, no `GRANT` — the shared merge engine); `app_redeem_invite`
(same signature as `join-invite.sql`, extended with the silent path-1 link, one extra step at the
end); `app_self_claim_guest` (new, the path-3 RPC).

## Why the token binding is unguessable

The shared link/QR/code is exactly `inviteLink(token, origin, pathname)` — a bare 8-character
opaque token, the same shape it always was. `bound_guest_id` never touches that function (it takes
no such parameter and never has), never appears in a query string, and is stored only as a column
on the `invites` **row**, not derived from or embeddable in the token itself. Two independent walls
keep it from leaking:

- **RLS.** `invites_select_members` requires active membership in the group before any row of
  `invites` — bound_guest_id included — becomes readable at all. The person about to redeem a
  bound invite is, by definition, not yet a member, so they cannot `SELECT` the invites table by
  token, by group, or any other way; the only door in is the `SECURITY DEFINER`
  `app_redeem_invite`, which reads the row with definer rights and never returns `bound_guest_id`
  in its result set (`RETURNS TABLE (group_id, group_name, status)` — unchanged shape, no new
  column).
- **No enumeration surface.** Even a member who *can* see `bound_guest_id` learns only a `guests.id`
  uuid (122 bits of randomness) they could already see anyway via `guests_select` (they're an
  active member of that same group) — it names a person already visible on the group's own roster,
  not a secret.

So the only way to ever discover which guest an invite is bound to is to already be a member of
that exact group — the same trust boundary every other guest-visibility rule in this schema already
uses, not a new one invented for this feature.

## What each path costs the user, in taps

| Path | Who acts | Taps |
|---|---|---|
| 1. Invite-bound | Member creating the invite | +1 tap only if they want to bind it (tap the guest's name chip, shown only when the group has an eligible unlinked guest — otherwise **zero** extra taps, identical to today's "צור הזמנה"). The **redeemer** does nothing extra at all — the same "הצטרף לקבוצה" tap they'd do anyway now also links them, invisibly. |
| 2. Verified contact | Nobody | **Zero** — not shipped this pass (see below); would have been silent on first pull if it were. |
| 3. Self-claim | The signing-in user | **1 tap** ("זה אני") when safe — links instantly, no confirmation step, no second tap. On refusal (exposure), the tap becomes a **0-tap** dead end: no claim, just an inline line pointing them at path 1 instead. |

Compare to the design this replaces: every claim cost the claimant 1 tap *and* a second person a
separate 1-tap approval, plus an indefinite wait between the two. Paths 1 and 3 both collapse that
to at most 1 tap, by exactly one person, with no wait.

## Path 2 — verified contact match: investigated, not built (docs/backend/verified-link.sql)

A later pass (2026-09-10) was asked to actually build path 2, on the explicit condition that
"verified" means only a contact address the identity provider itself confirmed — the `email_verified`
claim for a Google identity — never anything typed by a user (the two blocked branches,
`codex/tier2-sql` @ `a7b8065` and `codex/tier2-client` @ `fa6f684`, matched on an email/phone stored
on the guest row that nobody had verified, and were correctly blocked in security review for it).
Full reasoning lives in `docs/backend/verified-link.sql`; summary:

- **Where the verified claim lives — confirmed, not assumed.** `auth.jwt() -> 'user_metadata'`
  (backed by `auth.users.raw_user_meta_data`) is what a Google sign-in's `email_verified` flag lands
  in at first sign-in, but Supabase's own docs state plainly that `user_metadata` is writable by the
  end user via `supabase.auth.updateUser()` — by the time a client can influence it, it is a
  same-as-signup-time copy of the provider's claim, not the claim itself. The trustworthy field is
  `auth.users.email_confirmed_at`, set only by the Auth service (never by a client call), reachable
  from any `SECURITY DEFINER` function via `SELECT ... FROM auth.users WHERE id = auth.uid()` — the
  same table `app_current_profile_id()`'s callers already sit behind. **Assumed, not confirmed:** no
  SQL was run against the live project (task instruction), so nobody has spot-checked a real
  Google-signed-in row's literal value here — `verified-link.sql`'s own verify block says to check it
  once.
- **Why the feature still cannot be built.** The caller's half can be trusted; the guest side cannot.
  `guests` carries no email/phone column (confirmed again this pass — same finding as below), and the
  obvious fix, a `guests.contact_email` typed by whoever adds the guest, reintroduces the exact bug
  class the blocked branches shipped, just moved to the other side of the equals sign: anyone can add
  a guest to a group the real person has never joined and type that person's real email as its
  contact; when that person later signs up for any unrelated reason with their own, genuinely
  verified address, an automatic matcher would silently attach someone else's group history and debts
  to their new account, with no invite, no tap, and no standing check the person receiving the merge
  ever sees. Verifying the sign-in side does not repair a hole on the data side — this is a missing-
  authorization problem, not a missing-claim problem, and paths 1 and 3 both already solve it by
  anchoring the guest side to a human's in-context decision (a member picking a specific guest; a
  claimant already visible in a shared group) rather than to typed data.
- **Duplicate address / zero-exposure / silent-vs-shown, answered on the hypothetical anyway** (the
  task asked for a ruling even if the path doesn't ship): two guests sharing an address must refuse
  rather than guess — a `contact_email` was never going to be unique, so two independently-wrong
  matches are exactly as likely as one right one. Zero-exposure must NOT be overridden by
  verification — the caller's own identity being well-proven says nothing about whether the guest
  side was ever authorized, so any hypothetical path-2 would inherit `app_guest_has_zero_exposure`
  unchanged. It would have to be shown, not silent — unlike path 1, its "authorization" would be an
  inference from data rather than a witnessed action, so confirming it needs a person to see the
  proposal, which reintroduces the very approval step this whole v2 design exists to remove. That
  last point is why a safe contact model still would not clear the "zero approvals in the happy path"
  bar paths 1 and 3 already clear.
- **Recommended alternative, not built:** strengthen path 1 instead of adding a new path — let the
  inviter optionally type the invitee's expected email next to the existing guest-chip picker, and
  have `app_redeem_invite` require it to match the redeemer's own `email_confirmed_at`-backed address
  as an *extra* check before the existing silent link, never as the sole authorization. The
  authorizing act stays the same deliberate member choice path 1 already uses; verification only adds
  a safety net on top of it. Left as a follow-up (needs `invites.expected_email` + RPC changes) rather
  than folded into this pass.
- **What shipped instead:** `docs/backend/verified-link.sql` — no new linking function (there is
  nothing safe to link against), just the documented finding above and one regression tripwire: a
  `DO` block that raises if `guests` ever gains an `email`/`contact_email`/`phone`/`contact_phone`
  column, so a future automatic matcher cannot get built on top of it without first re-reading why
  that was rejected twice. No client changes were needed in `kupa-sgura.html` for this path — no
  feature ships, so the existing path-1/path-3 UI is untouched.

**Original (pre-investigation) finding, kept for history:** `guests` stores no phone/email column,
and — more importantly — **no local data model carries one either**: a guest is not a stored local
collection at all (`kupa-sgura.html` has no `state.guests`; `grep` for it returns nothing). A guest's
identity is derived implicitly from `displayName` + `guestId` wherever it appears in
`groupMembers`/`players`, and the only creation path (`addMemberByName`, `renderStartGameAddGuest`)
takes a typed name and nothing else. Adding contact capture would mean widening the
`GroupMember`/`Player` pure data contracts (typedefs, `normalize*`, `*ToRow`/`rowTo*`,
`CLOUD_PUSHABLE`) — the exact "single source of truth" surfaces `CLAUDE.md`'s architecture contract
calls out as high-risk. The later investigation above found the deeper, structural reason this stays
unbuilt even setting that risk aside.

One relevant, adjacent fact found while reading `docs/backend/security-fixes.sql`: `profiles.email`
is currently fully readable by any friend/group-mate via `profiles_select_friends`/
`profiles_select_group_mates`, with a **documented, deferred** plan to lock it behind a narrow
`app_lookup_profile_by_email` RPC. Anyone building path 2's recommended alternative later should
route any email-matching logic through a similarly narrow `SECURITY DEFINER` function (never a raw
`guests`/`profiles` join exposed to the client) — the caution that review already establishes for
`profiles.email` applies equally to matching against it.

## What the controller must run, and in what order

1. `docs/backend/link-guest.sql` — already applied to production (paths 1 and 3; unchanged by this
   investigation).
2. `docs/backend/verified-link.sql` — safe to paste any time after `link-guest.sql`; order relative to
   anything else does not matter, since it defines no function that touches `guests`/`invites`/
   `debts` and only adds the tripwire `DO` block. Re-running it is a no-op unless `guests` has since
   gained a contact column, in which case it raises on purpose.

## Tests

`tests/guest-claim.test.cjs` — fully rewritten, **7 tests**:

1. `guestHasZeroExposure` — an open debt (debtor or creditor side) blocks the claim; a paid debt,
   or another guest's debt, does not.
2. `guestHasZeroExposure` — an open game, a game in settlement, or a closed-but-unbalanced game
   blocks the claim; closed + balanced + no open debts is claimable; no `guestId` is never
   claimable.
3. `seatsGuestAndUser` mirrors the SQL double-seat guard (unchanged function, still shared by every
   path — re-verified rather than dropped).
4. `applyGuestClaimLocally` rewrites every `guestId` reference to `userId` across
   groups/groupMembers/invites/friendships/players (unchanged function).
5. …only ever touches identity fields — buyin/cashout totals identical before/after.
6. …is idempotent — a second call changes nothing further.
7. `link-guest.sql` is `security definer`, keyed off `auth.uid()` via the documented vendor seam,
   `revoke`s the public default, never mentions `service_role`, neither public RPC takes a
   spoofable target-identity parameter, and — the new part — `app_self_claim_guest`'s own body
   (sliced from its `CREATE OR REPLACE` to the next one) contains both
   `app_guest_has_zero_exposure(` and `GUEST_LINK_HAS_EXPOSURE`, i.e. the zero-exposure rule is
   enforced *inside the RPC*, not left to the UI.

**Also touched, minimally, to keep them passing** (not part of the ~7-10 budget above — these are
one-line shape fixes forced by `invites` gaining a `boundGuestId`/`bound_guest_id` field, not
redesigns):
- `tests/invites.test.cjs` — the `createInvite` exact-shape assertion gained `boundGuestId: null`;
  added one small test for the new optional 6th argument; fixed a `sourceBetween` marker string
  that pinned `createGroupInvite`'s old single-argument signature.
- `tests/cloud-mapping.test.cjs` — the invite round-trip test gained `boundGuestId: null` /
  `bound_guest_id: null`; added one small test for a *bound* invite round-tripping
  `bound_guest_id`.
- `tests/groups-domain.test.cjs` — the `normalize()` defaults test's expected invite shape gained
  `boundGuestId: null`.

`node --test tests/*.test.cjs` → **565 pass, 0 fail** (563 baseline − 7 old guest-claim tests + 7
new + 2 small additions above = 565). `git diff --check` clean. The last `<script>` body parses
with `new Function` (360,696 chars).

### Tests added for the path-2 investigation (2026-09-10)

`tests/verified-link.test.cjs` — **10 tests**, none touching `kupa-sgura.html` (no client code
shipped for this path):

1. `guests` (schema.sql) still carries no `email`/`phone`/`contact` column — a duplicate verified
   address is structurally impossible to match against, never guessed.
2. `kupa-sgura.html`'s pure section defines no client-side email/contact-matching function — an
   unverified address can never link because nothing attempts the match.
3. `verified-link.sql`'s regression tripwire (`information_schema.columns` + `RAISE EXCEPTION`) is
   present and names all four candidate column shapes.
4. `verified-link.sql` is one idempotent, `BEGIN`/`COMMIT`-wrapped file with no bare `CREATE TABLE`.
5. `verified-link.sql` grants nothing new and carries no `service_role`/`sb_secret_`.
6. `verified-link.sql` defines no new `SECURITY DEFINER` linking function.
7. `verified-link.sql` does not `CREATE OR REPLACE`/`ALTER` `app_link_guest_to_profile` or
   `app_guest_has_zero_exposure` — the double-seat guard and the zero-exposure gate are untouched.
8. `link-guest.sql` itself (re-verified, unchanged) still enforces
   `app_guest_has_zero_exposure`/`GUEST_LINK_HAS_EXPOSURE` inside `app_self_claim_guest`, and the
   `'double-seat'` guard inside `app_link_guest_to_profile`.
9. `verified-link.sql` documents `auth.users.email_confirmed_at` (not the client-writable
   `auth.jwt()` `user_metadata` copy) as the trustworthy source, and states explicitly what was
   confirmed versus assumed.
10. `verified-link.sql` states the zero-exposure-must-not-be-overridden and
    duplicate-address-refused-not-guessed rulings in text.

`node --test tests/*.test.cjs` (full suite, this pass) → **621 pass, 0 fail** (611 baseline + 10
new). `git diff --check` clean. The last `<script>` body still parses with `new Function`
(386,965 chars — unchanged from before this pass, since no client code was added for path 2).

## Manual verification plan (two accounts)

1. Run `docs/backend/link-guest.sql` in the Supabase SQL editor (after schema/RLS/join-invite).
2. **Path 1 — setup, account A:** create a group, add a guest "אורי" by name (A is
   `guests.created_by`). Open the group's settings → invite block → "צור הזמנה": with "אורי" still
   unlinked, a small row appears above the button — "אפשר לקשר את ההזמנה לאורח קיים בקבוצה:" with
   chips "כללי" / "אורי". Tap "אורי" (it highlights), then "צור הזמנה".
3. **Account B** (the real Uri, a second signed-in account, has never opened this group): open the
   invite link and tap "הצטרף לקבוצה" — the ordinary join flow, nothing new on screen. Reload / let
   the pull land: the group's member list should show B by their own name, not "אורי"; any of
   "אורי"'s old debts should appear under B's own "אני חייב"/"חייבים לי" with amounts unchanged;
   any closed game "אורי" played should count toward B on the group leaderboard. No prompt, no
   second person acted.
4. **Path 1, negative — replay:** have a **third** account C redeem the same token (reuse the
   link). C joins the group normally; the guest stays linked to B —
   `SELECT linked_profile_id FROM guests WHERE id = '<GUEST>';` is unchanged.
5. **Path 3 — self-claim:** as a **fourth** account D whose display name exactly matches an
   unlinked guest in some group D just joined via a plain (unbound) invite, and that guest has no
   open debts and only appears in closed, balanced games: open the group page — "שיחקת כאן בעבר
   בשם X?" appears. Tap "זה אני" — linked immediately, row disappears, no wait, no second person.
6. **Path 3, negative — exposure:** repeat step 5 for a guest with an open debt (or seated in a
   currently open game). Tap "זה אני" — expect the inline line "יש היסטוריה כספית פתוחה על השם
   הזה — בקשו מחבר בקבוצה קישור הזמנה אישי", and the guest must stay unlinked:
   `SELECT linked_profile_id FROM guests WHERE id = '<GUEST3>';` — still `NULL`.
7. **Negative — double seat (either path):** before the link resolves, have the claimant *also* be
   seated (as themselves) in a game the target guest is already seated in. Expect an inline error
   ("אי אפשר לקשר — אתם כבר יושבים באותו משחק" for self-claim; a silent no-link, join-still-succeeds
   outcome for the bound-invite path — see the SQL header for why that one path is deliberately
   silent), and the guest's row must still show its old `guest_id` in `game_participants` —
   nothing partially applied.
8. **Local/offline mode:** sign out (or open with no Supabase session) — the group page must show
   nothing guest-linking-related at all, and no `supabase.*` calls fire.
9. `docs/backend/link-guest.sql`'s own "HOW TO VERIFY" block at the bottom covers the same
   scenarios purely from the SQL editor, plus the idempotent-replay and name-mismatch branches,
   which are faster to drive there than through the UI.

## Known, accepted gaps (documented, not silently ignored)

- `guests_update_creator` in `rls-policies.sql` still technically lets a guest's creator `UPDATE`
  `linked_profile_id`/`linked_at` directly (RLS cannot express "every column except these two") —
  inherited from the design this replaces, still unverified against a real upsert's generated
  column list, still not applied.
- `invites_update_admin` deliberately does **not** re-validate `bound_guest_id` (only
  `invites_insert_admin` does) — re-checking "still unlinked" on every later `UPDATE` would start
  rejecting a bound invite's own `revoke` the moment its binding resolves. A group admin could in
  principle craft a raw `UPDATE` to rebind an existing invite to an unrelated guest after creation;
  narrow blast radius (admin-only, grants no access beyond that admin's existing standing, only
  matters if someone then redeems that exact admin-controlled token). See the comment above that
  policy in `link-guest.sql` for the full reasoning and what closing it fully would need.

## Process notes

`python3 build.py` was not run, `index.html`/`sw.js` were not touched, no SQL was executed, no
browser tools were used — all per the task's explicit instructions. `git merge main` (local) was
run first, fast-forwarding cleanly before any of the above.

**2026-09-10 addendum (path-2 investigation):** same constraints held — `python3 build.py` not
run, `index.html`/`sw.js` untouched, no SQL executed against any project, `git merge main` (local)
run first (fast-forward, no conflicts). `kupa-sgura.html` was read but not modified: no client
change was needed because no new linking path ships. Deliverable was
`docs/backend/verified-link.sql` (documentation + one regression tripwire, no new
`SECURITY DEFINER` function), this report's "Path 2" section, and `tests/verified-link.test.cjs`.
