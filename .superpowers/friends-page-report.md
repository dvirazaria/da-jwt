# Friends page — researched empty state with one clear primary action

## Research first: what makes a "no contacts yet" screen good

Grounded in Apple HIG (empty-state guidance for lists/collections), Material Design's
empty-states pattern, and how established contact/social apps (Splitwise, WhatsApp, Venmo)
handle "no contacts yet". Five to eight concrete recommendations, each mapped to this app:

1. **A one-line headline that names what's missing, not a generic "empty" label.**
   (HIG / Material) → this app already had the string "עוד אין חברים" pinned by an existing
   test; kept it verbatim but promoted it from a small `.empty-note` caption to a real `<h2>`
   headline (`.friends-hero-title`, 20px/800), matching the size class this app already uses
   for a name/identity headline (`.pname-big`), not the 34px login-screen scale (the nav tab
   already says "חברים", so the empty state doesn't need to re-announce the whole screen).

2. **One benefit sentence, not a feature list.** (HIG "explain why", Material "guidance text")
   → added `.friends-hero-benefit`, a single sentence ("חברים שמצטרפים דרך קישור זמינים מיד
   לבחירה בכל משחק וקבוצה"), styled like the dashboard's own lead line (`.games-home-lead`:
   `--dim`, 14px, 300).

3. **Exactly one primary action; everything else is visibly secondary.** (This is the core HIG/
   Material rule, and it's also how Splitwise/WhatsApp/Venmo "invite contacts" empty states are
   built — one big "invite" CTA, small/text-level fallbacks below.) → the share-link action
   (already implemented, `shareFriendInvite`/`app_create_friend_invite` RPC, WhatsApp/
   `navigator.share`) is the frictionless route: no name or email lookup needed. It was
   previously a small `.games-invite-action` pill sitting *last*, after a disabled "add by
   name" button. Flipped: share gets `.btn-primary` (this app's one "the leading action" style)
   and moved to lead; "הוסף חבר" (add by exact name/email — the higher-friction, lookup-based
   path) gets `.btn-quiet` and sits underneath, reusing the exact hierarchy the login screen
   already establishes between its primary "שלחו לי קוד" and its quiet-but-real "המשך בלי
   חשבון".

4. **The lowest-friction path leads.** (Splitwise/WhatsApp precedent: "invite via link" always
   outranks "search for a contact" when there's nothing to search yet.) → same change as #3;
   share-by-link needs nothing typed, add-by-name needs an exact email or display name.

5. **No new illustration/glyph unless the app's visual language already has one for this job.**
   (HIG: an icon should earn its place, not decorate.) → explicitly did *not* add a
   people/contacts icon. This app reserves its one illustration (the monochrome suits mark) for
   the app header, and no other empty state in the app (games dashboard's "אין משחקים פעילים
   כרגע", "אין לך קבוצות עדיין") uses an icon either — adding one here would be a new,
   inconsistent illustration style. DESIGN.md forbids that without an explicit design decision.

6. **A pending request always needs a decision, so it must never be buried under a static
   list.** (Standard "requests before contacts" ordering in every social app with a friends
   list.) → reordered `renderFriendGroup` calls: incoming requests → outgoing requests →
   accepted friends (previously friends came first).

7. **Section rhythm and spacing stay consistent with the rest of the app, not invented per
   screen.** → new `.friends-hero`/button spacing follows the documented 24px section rhythm
   (`.friends-share-btn { margin-top: 24px }`), same value the dashboard and profile already
   use between sections.

8. **Gender-neutral copy for anything newly written.** → the new benefit line and the
   re-labeled share button ("שתפו קישור חברות") use the plural/neutral form the task specified.
   The pre-existing "הוסף חבר" label was left as-is: it's pinned verbatim by
   `tests/friends.test.cjs`/`tests/friend-requests.test.cjs`, and DESIGN.md documents it as
   established app copy — relabeling it was out of scope for a presentation-only change and
   would have required touching test assertions unrelated to the empty-state problem.

## What changed (`kupa-sgura.html`, scope: `renderFriendsPage` + friends-page CSS only)

- **Empty state**: `.friends-hero` (headline `<h2 class="friends-hero-title">` + one
  `<p class="friends-hero-benefit">`), shown only when there are no friends and no pending
  requests in either direction. Centered, unlike the start-aligned list rows below it.
- **Action hierarchy flip**: the share-my-link button (`shareFriendInvite`, unchanged RPC/logic)
  is now `.btn-primary.friends-share-btn` and renders first; "הוסף חבר" (unchanged
  `submitFriendRequest`/`renderAddFriendPanel` logic) is now `.btn-quiet.friends-add-toggle` and
  renders second. Only label text on the share button changed ("שתפו קישור חברות" instead of
  "הוסף אותי כחבר" — that string was never asserted by any test, only referenced in a comment).
- **Request-before-friends ordering**: `renderFriendGroup` for "בקשות שהתקבלו" and "בקשות שנשלחו"
  now render before "חברים" (previously after).
- No change to the friendships data model, `myFriendRef`, RPC calls, `friendRequestsFor`,
  `createFriendRequest`, `respondToFriendRequest`, `removeFriendRequest`, or the add-by-name
  lookup (`lookupFriendProfile`/`submitFriendRequest`) — presentation and copy only, as required.
- `renderFriendGroup` itself (shared with the group-page guest-claim "זה אני?" section) is
  untouched, so that reuse is unaffected.

## Tests

Added 4 new tests to `tests/friends.test.cjs` (existing regex-over-source-slice style):
1. Empty state renders the headline + benefit line and promotes the share button to
   `.btn-primary`, with "הוסף חבר" demoted to `.btn-quiet`.
2. When data exists, incoming/outgoing requests render before the friends list.
3. The share action is appended to the DOM before the add-by-name action (primary leads in tab
   order too).
4. `renderFriendsPage` still touches no `localStorage` key (presentation-only change).

647 baseline → **651 passing**, 0 failing. No existing test was modified — all pre-existing
assertions (exact `addFriendBtn.disabled = !online;` lines, the shared `SERVER_NOTE` paragraph,
`"הוסף חבר"` label, `"עוד אין חברים"` substring, the `online ? (i => {` row-action wiring) still
match verbatim; only their surrounding class names, order, and copy moved.

## Verification run

- `node --test tests/*.test.cjs` → 651/651 passing.
- `git diff --check` → clean.
- Last `<script>` parses via `new Function(...)`.
- Diff scope: `DESIGN.md`, `kupa-sgura.html` (renderFriendsPage + friends CSS block only),
  `tests/friends.test.cjs`. No touch to `renderGroupPage`, group cards, or sync-dot code (the
  three areas the parallel agents own).
