# Friend requests — wiring report

Branch: `worktree-agent-a250ba622816486d6`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-a250ba622816486d6`

## Which lookup path shipped: **B — people you can already see**

`docs/backend/rls-policies.sql` gives `profiles` exactly three SELECT policies:

```
profiles_select_self        USING (id = app_current_profile_id())
profiles_select_friends     USING (app_is_friend_of(id))          -- status = 'accepted' only
profiles_select_group_mates USING (app_shares_group_with(id))
```

There is no policy under which a signed-in user can read a stranger's profile row, by email or by
any other column. So a stranger lookup is impossible today without either weakening RLS or adding a
`SECURITY DEFINER` RPC — both SQL, both out of scope for this agent. **I did not touch RLS and did
not invent an RPC.**

What shipped instead is the full flow, restricted to people the signed-in user can already see:
`lookupFriendProfile()` does a server-side exact match on one column —
`from("profiles").select("id,display_name").eq(column, value).limit(1)` where `column` is `email`
when the typed text contains `@` and `display_name` otherwise. RLS is the filter: a group-mate or an
existing friend resolves; anyone else comes back empty and the panel says "לא נמצא משתמש". No
wildcard, no `.or()`, no `.ilike()`, no listing — one column, one exact value, one row.

Practical consequence: today you can friend somebody you already share a group with. That is a real,
useful step (a group-mate becomes a friend, and friendship then survives leaving the group), and it
is honest about what the server permits.

### SQL proposal for the controller (NOT run, NOT committed to `docs/backend/`)

To allow inviting a stranger by exact email or exact display name, add a `SECURITY DEFINER` RPC that
returns nothing but the id and the display name — never the email, never a list, never a prefix
match. Suggested wording, to be reviewed before running:

```sql
-- Exact-match lookup for the add-friend panel. SECURITY DEFINER so it can see a profile the
-- caller's RLS hides, but it returns at most ONE row and only (id, display_name): no email
-- ever leaves this function, and there is no way to enumerate or prefix-scan with it.
CREATE OR REPLACE FUNCTION app_find_profile_for_friend_request(p_query text)
RETURNS TABLE (id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.id, p.display_name
  FROM profiles p
  WHERE app_current_profile_id() IS NOT NULL
    AND p.id <> app_current_profile_id()
    AND (
      (position('@' in p_query) > 0 AND lower(p.email) = lower(btrim(p_query)))
      OR (position('@' in p_query) = 0 AND p.display_name = btrim(p_query))
    )
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app_find_profile_for_friend_request(text) FROM public;
GRANT EXECUTE ON FUNCTION app_find_profile_for_friend_request(text) TO authenticated;
```

Notes for whoever runs it:

* It is an enumeration surface by construction (a display name is guessable). Rate-limit it, or
  restrict the name path to people who share a group and keep the email path global.
* `profiles.email` has no case-folding index; `lower(p.email) = lower(...)` will seq-scan without
  `CREATE INDEX profiles_email_lower_idx ON profiles (lower(email));`. The same applies to the
  client-side lowercasing the app already does (see "Open questions").
* The frontend change once it exists is one function: `lookupFriendProfile()` swaps its
  `from("profiles").select(...).eq(...)` for `supabase.rpc("app_find_profile_for_friend_request",
  { p_query: parsed.value })`. Nothing else in the feature moves; the tests that pin the lookup
  shape are in `tests/friend-requests.test.cjs` ("the profile lookup is an exact single-column
  match on a readable profile").

## What was built

Pure (in the `// ---------- friends (pure) ----------` section, all vm-tested):

* `removeFriendRequest(friendships, id, meRef)` — withdraws only a *pending* request whose requester
  is me: the same rule as `friendships_delete_requester`.
* `friendRequestBlockReason(friendships, fromRef, toRef)` → `"self" | "friends" | "pending" | null`.
  Says *which* of `createFriendRequest`'s three null cases applies; a rejected friendship is not a
  block (people change their minds).
* `friendRequestError(kind)` over `FRIEND_REQUEST_ERRORS` (built with `Object.create(null)` so a
  kind like `"toString"` falls through) with the generic fallback "לא הצלחנו לשלוח את הבקשה".
* `normalizeFriendSearch(raw)` → `{ kind: "empty" | "email" | "name", value }`; trims, lowercases an
  address, keeps a name character-exact (Hebrew has no case to fold).

Wiring:

* `submitFriendRequest()` — normalize → `lookupFriendProfile` → `friendRequestBlockReason` →
  `createFriendRequest(state.friendships, …)` → `save()`. `save()` is the only door to
  `scheduleCloudPush()`, and the push writes friendships through the existing generic
  `CLOUD_TABLES` loop. **No `supabase.from("friendships").insert` anywhere.**
* `respondToFriend(id, accept)` — `respondToFriendRequest(...)` + `save()`. Accept/reject is an
  UPDATE by the addressee: exactly `friendships_update_addressee`.
* `withdrawFriendRequest(id)` — `removeFriendRequest(...)` + `save()` + `cloudDeleteFriendship(id)`.
  This is the one real DELETE among the group tables (the push only upserts them), so it needed its
  own cloud-layer call, modelled on `pushCloudGameDeletes`. On success the row is dropped from the
  `lastPushedRows` diff baseline; on failure it schedules a pull so the server wins.
* `myFriendRef()` — my ParticipantRef. It carries the profile id, but does not mint one: the value
  comes from the session and goes through `keptUserId()`, the same validator every pulled uuid
  passes. Without it, `sameIdentity()` cannot match the friendship rows a pull builds for me (they
  are keyed on `profiles.id` and may know no guestId at all). This is the same precedent as the
  `profileId` that `renderHideGroupAction` hands the hide-group helpers.
* UI: `renderAddFriendPanel()` (the `games-create-panel` grid-collapse, `dir="ltr"` the moment an
  `@` is typed, "שולח…" busy label, inline `.friend-error`) and `renderFriendGroup(..., actionsFor)`
  — "אשר"/"דחה" on incoming rows, "בטל" on outgoing, nothing on the friends list. `.friend-action`
  is a 44px target with `scale(.96)` press feedback, in tokens only, so both themes follow.
* Everything is gated on `cloudMode()`. Signed out or `supabase === null`, the screen is byte-for-byte
  today's: disabled button, `SERVER_NOTE` helper, no action buttons.

Two fixes the feature exposed, both in the cloud layer:

* `cloudFriendName(profileId, ctx)` — a `friendships` row carries no name and RLS hides a
  not-yet-friend's profile, so a pulled row used to come back with an empty `displayName` for the
  other party. It now falls back to the group membership that made them visible. (`renderFriendGroup`
  renders "משתמש" if even that is missing.)
* `mergeCloudIntoState` now preserves a locally-known `displayName` on a pulled friendship ref, the
  same way it preserves a group's `avatarDataUrl`.

Privacy: the panel is the only place an email appears, and it is the one the user just typed. No P&L,
debts or `fmt()` anywhere in the friends UI — asserted by a test.

## Tests

`node --test tests/*.test.cjs` → **449 tests, 448 pass, 1 fail**.

The single failure, `a former member can remove only their local group row from the preview after a
profile-name change` (`tests/hide-group-profile-id.test.cjs`), **fails identically on
`origin/main` with my changes stashed** — that commit (`267396d`) landed a test ahead of its source
change. It is not mine and I did not touch it.

New: `tests/friend-requests.test.cjs` (15 tests) — the error mapper incl. the unknown fallback and
the `Object.prototype` case; the self / duplicate-pending / duplicate-accepted guards in both
directions plus the rejected-is-not-a-block case; `removeFriendRequest`'s three refusals; the search
normalizer; and the structural assertions (send goes through `createFriendRequest` + `save()`, no
direct `friendships` insert/upsert, the respond/withdraw handlers, the `cloudMode()` gate, the panel
pattern, the 44px CSS, and the exact-match single-column lookup).

Updated in `tests/friends.test.cjs`: the two assertions that pinned the feature as unwired
("addFriendBtn.disabled = true", "no UI handler calls createFriendRequest…") now pin the wiring —
each pure mutation still has exactly one caller.

`DESIGN.md` gained a "בקשות חברות בחשבון מחובר" subsection under the friends screen.

I did not run `python3 build.py`; `index.html` and `sw.js` are untouched.

## Manual verification plan (two accounts)

Prerequisites: two email addresses, both signed in through the existing OTP login, on the built app
(the controller runs `python3 build.py` first). Call them A and B.

1. **Make them visible to each other.** On A: create a group, open its settings, and add B — today
   that means B joins through the invite link/code with their own account (the parallel
   invite-joining work), or B is already an active member from an earlier session. Confirm on B's
   Games dashboard that the group appears; that is what makes A's profile readable to B and back.
2. **Stranger is refused.** On A, friends tab → "הוסף חבר" → type an address of nobody (or of an
   account that shares no group) → "שלח בקשה" → expect "לא נמצא משתמש" and no row anywhere.
3. **Self is refused.** On A, type A's own email → expect "אי אפשר לשלוח לעצמך".
4. **Empty is refused.** Press "שלח בקשה" with an empty field → "יש להזין מייל או שם".
5. **Send.** On A, type B's email (mixed case, with a trailing space — the normalizer should not
   care) → "שלח בקשה". Expect: the panel collapses, "בקשות שנשלחו" shows B with "ממתין לאישור" and a
   "בטל" button, and the sync dot goes "מסנכרן…" → "מסונכרן לחשבון".
6. **Duplicate.** On A, send to B again → "כבר נשלחה בקשה", no second row.
7. **Arrival.** On B, open the friends tab (pull, or reload). Expect A under "בקשות שהתקבלו" with
   A's name (not blank), "ממתין לאישור שלך", and "אשר"/"דחה".
8. **Reverse duplicate.** On B, try to send a request back to A → "כבר נשלחה בקשה".
9. **Reject.** On B press "דחה". The row disappears on B; on A the outgoing row disappears too after
   a pull. Then on A send again — it must be allowed (a rejection is not a permanent block).
10. **Accept.** On B press "אשר". Both devices should end up showing the other under "חברים", with
    no action buttons on those rows.
11. **Already friends.** On A, try to send to B once more → "כבר חברים".
12. **Withdraw.** From a fresh pending request (A → a second visible account, or re-run 5 after
    unfriending in the DB), press "בטל" on A. The row goes on A, and — this is the one worth
    watching — it must NOT come back on the next pull (that is the real DELETE working). Check the
    `friendships` table: the row is gone, not left pending.
13. **Offline / signed out.** Sign out on A. The friends tab shows the read-only lists (or "עוד אין
    חברים"), the "הוסף חבר" button is disabled with "יעבוד כשהאפליקציה תתחבר לשרת", and no
    אשר/דחה/בטל buttons appear. Kill the network with a session live and press "אשר": the change
    should stay on screen, the dot should show a save error, and the answer should land after
    reconnecting.
14. **Design.** Repeat 5–10 in light theme and dark, and on a narrow phone: the panel expands and
    collapses (no hard cut), rows enter staggered, the email field flips to LTR as soon as `@` is
    typed, and every button is comfortably tappable.
15. **Privacy sweep.** Nowhere in the friends tab should an email of another person, a balance, a
    P&L or a debt be visible.

## Open questions

1. **Email case.** The client lowercases the address, but `profiles.email` stores whatever the auth
   provider gave and the query is `.eq("email", value)`. If any row was stored with capitals the
   exact match will miss. Either normalize on write (`lower(email)` at profile upsert) or switch the
   lookup to `.ilike()` on the email path only — I deliberately did not, since `ilike` opens a
   pattern surface and the tests pin it shut. The RPC above solves it properly.
2. **Duplicate display names.** The name path takes `.limit(1)`. Two visible people with the same
   display name means the first row wins, silently. Worth a "יותר מאדם אחד בשם הזה" error once the
   lookup can return more than one row.
3. **`friendships_pair_uk`.** One row per unordered pair, forever. So after a rejection, sending
   again creates a *new local row* whose INSERT will collide with the rejected row still on the
   server, and the push will fail with a duplicate-key error (it retries once, then pulls, and the
   local row loses). Handling this properly is either "reuse the rejected row" (an UPDATE the
   requester is not allowed to make under `friendships_update_addressee`) or "delete the rejected row
   first" (not allowed either — the DELETE policy is pending-only). **This needs a product decision
   plus, most likely, SQL.** `friendRequestBlockReason` currently treats a rejection as re-sendable,
   which is the right product answer; the server cannot honour it yet.
4. **Unfriending.** There is no "הסר חבר" — an accepted friendship has no destructive action, per the
   brief. There is also no server policy for it (no DELETE on accepted, no UPDATE by the requester),
   so adding it is another SQL decision.
5. **Names of not-yet-friends.** `cloudFriendName` resolves the other party from group membership.
   If the person is visible only as a friend-of-a-group I have since left, a pulled row can still
   render as "משתמש" until the friendship is accepted. Acceptable now; a `display_name` returned by
   the lookup RPC and cached locally would close it.
6. **Realtime.** Friend requests arrive on the next pull, not instantly — there is no
   `postgres_changes` channel on `friendships` (only the open game has one). Probably fine; worth
   deciding before this ships to more than a few people.
