# Reachable group invites and shareable friend links — handoff

Branch: `worktree-agent-a4d4c01874541f450`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-a4d4c01874541f450`
Commit: `a6752210f15d87fec538350dc3bba1b6bd7e6646` — `feat: reachable group invites and shareable friend links`

## What was built

Two independent additions to `kupa-sgura.html`, both reusing existing patterns rather than
inventing new ones (no new CSS classes beyond two tiny header-row rules that mirror an existing
one exactly): **189 inserted lines / 5 deleted in the app source, plus one new test file and four
one-line test updates for a call-site signature change.**

### 1. Direct group-invite entry point (Problem 1)

**Where:** the group page's (and the dashboard's group-preview overlay's) "חברים" section header
now carries a "+ הזמן לקבוצה" text-accent button, next to the section title — `renderGroupMembers`
gained a leading `summary` parameter and a new sibling `renderGroupInviteButton(summary)`.

**Why there, and not the primary-action row:** I considered both homes the task named.
- The primary-action row (`renderGroupPrimaryAction`) already has a job — start/resume the
  group's game — and DESIGN.md's own comment on it (Row 15: "while the picker is open the panel
  owns the screen's one turquoise capsule... the CTA steps aside instead of competing with it")
  is explicit that this app deliberately avoids two competing turquoise CTAs on screen at once. A
  second prominent button there would either dilute that rule or need to hide/show contextually,
  adding real complexity for a screen that is not "start a game."
- The members-section header already has an established idiom for exactly this shape: the
  dashboard's "הקבוצות שלי" heading carries "+ צור קבוצה" as a trailing accent-text action in a
  `space-between` row (`.games-groups-heading` / `.games-create-group-inline`, 44px touch target,
  13px/600 accent text, no border). I mirrored it byte-for-byte under honest new names
  (`.games-members-heading` / `.games-member-invite-btn`) instead of reusing the group-list names
  on an unrelated section. This makes "invite people" exactly as reachable as "create a group" —
  both are one tap from a screen you're already on, no overlay, no scrolling to find it — which
  is the actual fix for "four levels deep." Visual weight is not what was hiding the old flow;
  location was, and DESIGN.md already treats this weight as sufficiently prominent for an
  equally-important action (creating a group).
- It's also **shared for free**: `renderGroupMembers` is called from both `renderGroupPage` (the
  dedicated group screen) and `renderGroupPreview` (the dashboard's tap-to-preview overlay), so
  the entry point appears in both places without duplicating any logic — one edit, two surfaces.

**Behavior:** click → reuse `activeInvite(state.invites, groupId)` if one exists, otherwise call
the existing `createGroupInvite(groupId)` verbatim (Lane: I call it, I never changed it or
`revokeGroupInvite`/`activeInvite`/`createInvite`/token generation) → build the link/message with
the existing `inviteLink`/`buildInviteShareText`/`formatInviteCode` → share with the exact
`navigator.share`-first / `wa.me` fallback pattern the "וואטסאפ" button in `renderGroupInvite`
already uses. The settings overlay (`renderGroupInvite`, inside `openGroupSettings`) is completely
untouched — it stays the only place to see the code, revoke, or see the QR.

Gated on `summary.isMember` (any active member, not just admins — same reach as the existing
overlay block), so a former member never sees it. Works for an archived group too, because the
existing `createGroupInvite`/`renderGroupInvite` already allow that (I did not add or remove that
restriction — matching current behavior exactly, not expanding scope).

### 2. Personal friend-invite link (Problem 2)

**Where:** the friends screen (`renderFriendsPage`), a new "הוסף אותי כחבר" button below the
existing "הוסף חבר" (search-by-name/email) button and its panel/note. Shown whenever `me` is set,
**regardless of `cloudMode()`** — unlike "הוסף חבר" (which needs a server round-trip to look
someone up), sharing my own link never calls the server, so there's nothing to gate on being
online.

**New pure functions**, all placed in the "invites (pure)" section right after
`buildInviteShareText`, as asked (DOM-free, `state`-free, column-2 `function name(`):

- `friendInviteLink(token, origin, pathname)` — `origin + pathname + "?friend=" + token`, the
  personal-link counterpart of `inviteLink`.
- `buildFriendShareText(myName, url)` — see exact text below.
- `parseFriendToken(search)` — reads `?friend=` with the same normalization
  (`normalizeInviteToken`, reused) and 8-char alphabet check (`INVITE_TOKEN_ALPHABET`, reused) as
  `parseJoinToken`, on the **distinct** `friend` param. `?join=` and `?friend=` are read
  independently at boot (`const friendToken = parseFriendToken(...); const joinToken =
  parseJoinToken(...);`) so a URL carrying either — or, in the pure parsers, even both at once —
  never has one shadow the other; `tests/friend-invite.test.cjs` pins this directly.

**Share handler** (`shareFriendInvite()`, friends-screen wiring section): mints a token with the
existing `generateInviteToken(randomInviteBytes())` (reused, not modified), builds the link and
message, then the identical `navigator.share` → `wa.me` fallback pattern used everywhere else in
this feature.

**Boot-time notice** (`#friendNotice`, mirrors `#joinNotice`'s `.login`/`.login-in` markup and
reuses its existing classes — `.games-invite-code`, `.join-notice-status`, `.join-notice-actions`,
`.btn-primary`, `.btn-skip` — so no new CSS was needed for the screen itself): shows the formatted
code, "אשר בקשה" and "לא עכשיו". **"אשר בקשה" is a real, tappable action** — it does not fake a
result. There is no redemption RPC at all yet (see below), so tapping it reveals the shared
`SERVER_NOTE` constant inline (`role="status" aria-live="polite"`, inherits the existing
`fadeIn` on `.join-notice-status`) instead of claiming success. "לא עכשיו" always closes the
notice and strips `?friend=` from the URL (`stripFriendFromUrl`, mirrors `stripJoinFromUrl`).

**Why no persisted "friend invite" token/collection:** I deliberately did not add a
`state.friendInvites` collection, a `normalize()` default, or any `remoteBody()`/`collectionsOf()`
change. The identifying context ("who is inviting") travels in the **share text**, not the token —
`buildFriendShareText(myName, url)` takes the name directly, so the recipient already sees who
sent it in the WhatsApp message itself before they ever open the link, exactly like a real personal
invite. The token in the URL only has to exist and round-trip through parsing today; a fresh one is
minted per tap rather than reused, because there is nothing server-side yet that would make a
stable, revocable, persisted token meaningfully different from an ephemeral one — and inventing
that persistence now would mean guessing at a schema shape instead of designing it deliberately (a
`profiles`-scoped token vs. a dedicated table has real tradeoffs). This keeps the change 100%
additive/UI-layer, touches none of the shared collection-shaping functions the other agent's
guest-linking work is also likely touching, and hands the follow-up a clean slate rather than a
shape they'd have to migrate away from. See "Backend follow-up" below for exactly what to add.

## The exact friend share message

For `buildFriendShareText("דביר", "https://poker-tau-pink.vercel.app/?friend=ABCD1234")`:

```
סוגרים קופה — אפליקציה לניהול קופת פוקר
דביר מזמין/ה אותך להצטרף כחבר/ה
https://poker-tau-pink.vercel.app/?friend=ABCD1234
```

Without a name (degrades, never renders "undefined"):

```
סוגרים קופה — אפליקציה לניהול קופת פוקר
מישהו מזמין אותך להצטרף כחבר/ה
https://poker-tau-pink.vercel.app/?friend=ABCD1234
```

Same opening line as the group invite message (`buildInviteShareText`) on purpose — one
recognizable message family from this app. "מזמין/ה" and "כחבר/ה" use the same gender-neutral
slash notation already in the source (`"מבקש/ת להיות"` in the guest-claim section), since the app
never tracks gender. Short by construction: 3 lines, well under the existing `buildInviteShareText`
test's 220-char/4-line budget (mirrored, not reused, by my own "stays short" test).

## Backend follow-up: exactly what SQL/RPC is missing

**Nothing here writes or assumes any schema.** I did not touch `docs/backend/*.sql` and did not
run or write any SQL, per the task's constraint. For the next backend round (explicitly *not* this
one — Lane), modeled directly on the existing `docs/backend/join-invite.sql` /
`app_redeem_invite()` shape so it reads as one family with the group flow:

1. **A place to mint and persist a personal token.** Simplest shape: a nullable
   `friend_invite_token text unique` (+ `friend_invite_token_created_at`) column on `profiles`,
   generated server-side (RPC, not client-chosen) the first time it's requested and reused after
   that — mirrors "one active invite per group" but scoped to one profile instead of one group.
   A dedicated `friend_invites` table (id/token/profile_id/created_at/revoked_at) is the
   alternative if revocation/rotation ever matters; a single column is enough for "accept becomes
   a friendship" and nothing else.
2. **`app_create_friend_invite()`** (SECURITY DEFINER, like `app_redeem_invite`) — returns the
   caller's existing token or mints+stores a new one. Client would call this instead of the
   ephemeral `generateInviteToken(randomInviteBytes())` in `shareFriendInvite()` today, and cache
   the result the same way `activeInvite` is reused for group invites.
3. **`app_accept_friend_invite(p_token)`** (SECURITY DEFINER) — resolves `p_token` to the
   inviter's `profile_id` (RLS should hide the mapping from a general `SELECT`, exactly like
   `invites_select_members` hides group invites from non-members), and creates a `friendships`
   row the same way `createFriendRequest`'s shape already expects (see `friendship`'s pure
   contract in `kupa-sgura.html`) — most likely **pre-accepted** (both sides already consented: the
   sender by sharing the link, the receiver by tapping "אשר בקשה"), not a pending request the
   sender must additionally approve, since that round-trip already happened out-of-band over
   WhatsApp. Needs the same self-request / already-friends / already-pending guards
   `friendRequestBlockReason` already encodes client-side for the search flow.
4. **Frontend wiring, once 2–3 exist:** `shareFriendInvite()` calls `app_create_friend_invite()`
   (cloud mode only; local/offline keeps today's ephemeral-token behavior as the fallback, same
   spirit as the group invite's `!supabase` branches elsewhere in this file) instead of minting
   locally. `showFriendNotice()`'s "אשר בקשה" handler calls `app_accept_friend_invite(p_token)`
   instead of showing `SERVER_NOTE`, following `runJoin()`'s exact shape (busy state → call → map
   result to one Hebrew line → `pullCloud()` → close). Everything else — the URL, the parsing, the
   notice screen, the share message — is already correct and would not need to change.

## Tests

`tests/friend-invite.test.cjs` (new, 8 tests, vm-slice + raw-source pattern from
`tests/invite-share.test.cjs` / `tests/join-invite.test.cjs`):

1. `buildFriendShareText` includes the app name, the inviter's name and the link verbatim.
2. missing/blank name (undefined/null/empty/whitespace) never renders `"undefined"`, link intact.
3. stays short: ≤3 lines, <220 chars.
4. `encodeURIComponent(message)` has no raw `?`/`&`/`=`/whitespace left and decodes back exactly.
5. `parseFriendToken` matches `parseJoinToken`'s normalization/alphabet rules (dash/whitespace
   stripped, uppercased, rejects a short or lookalike-character token).
6. `?join=` and `?friend=` never shadow each other — both present (either order) → each pure
   parser resolves its own token correctly.
7. raw-source regex: `renderGroupMembers` calls `renderGroupInviteButton(summary)`, whose body
   calls `activeInvite`/`createGroupInvite`/`buildInviteShareText` (the direct entry point is
   real, not just a settings-overlay reference).
8. raw-source regex: `shareFriendInvite`'s handler tries `navigator.share` first, falls back to
   `wa.me/?text=` with `encodeURIComponent(message)`, opens with `"_blank", "noopener"`.

Four existing tests pinned the old 3-argument `renderGroupMembers(members, former, isAdmin)`
signature/call sites as literal strings and needed a one-line update each to the new leading
`summary` argument (no behavior asserted by these tests changed, only the literal text they match):
`tests/design-round.test.cjs`, `tests/group-members.test.cjs`, `tests/group-page.test.cjs`,
`tests/group-preview.test.cjs`.

Full suite: `node --test tests/*.test.cjs` → **571/571 pass** (563 pre-existing + 8 new), 0
failures. `git diff --check` clean. The last `<script>` body (367,433 chars) parses via
`new Function(...)` with no error.

## Manual test plan

Run from the merged/integrated repo (not this worktree), per HANDOFF.md's documented local-serving
flow:

```sh
cd "/Users/dvirazaria/פוקר" && python3 -m http.server 8765
# open http://localhost:8765/kupa-sgura.html
```

**Group invite entry point**
1. Open any group you're an active member of. Confirm "+ הזמן לקבוצה" sits beside "חברים",
   visible without opening "הגדרות קבוצה" — both on the dedicated group page and on the
   dashboard's tap-to-preview overlay.
2. With no active invite yet: tap it → confirm a share sheet (or, without `navigator.share`, a new
   tab to `wa.me`) opens immediately with the group's message/link. Then open "הגדרות קבוצה" →
   confirm an invite now shows there too (same token/code) — proving it was actually created, not
   faked.
3. With an active invite already: tap it again → confirm the **same** code/link is shared (reused,
   not regenerated) and no duplicate invite appears in the settings overlay.
4. As a former/removed member (or logged out of that group): confirm the button does not appear.
5. Both themes; confirm the button's touch target and press state (`scale(.92)`) feel consistent
   with "+ צור קבוצה" on the dashboard.

**Friend invite link**
6. On the friends screen, confirm "הוסף אותי כחבר" appears below "הוסף חבר" whenever a name is
   set — including in local/offline mode (no account), where "הוסף חבר" itself stays disabled.
7. Tap it → confirm the share sheet/`wa.me` tab opens with the exact message shape above, name
   filled in from the current profile.
8. Copy the resulting link, open it in a fresh tab (simulating the recipient) → confirm
   `#friendNotice` appears with the formatted code, strips `?friend=` only on dismiss/accept.
9. Tap "אשר בקשה" → confirm the shared "יעבוד כשהאפליקציה תתחבר לשרת" note fades in inline, no
   `alert`, nothing claims you are now friends.
10. Tap "לא עכשיו" → notice closes, URL is clean, app resumes to its normal boot destination.
11. Confirm a URL with both `?join=` and `?friend=` present is not a real flow the UI offers, but
    if hand-constructed, does not crash and does not mix the two notices — the friend notice takes
    the boot-time slot per the resolution order documented in the boot section.
12. RTL read-through in the opened WhatsApp compose box: Hebrew lines right-to-left, link
    left-to-right and tappable on its own line, no character reversal.
