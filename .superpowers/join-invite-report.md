# Join a group by invite link — handoff

Branch: `worktree-agent-ac140fe50349c4ad9`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-ac140fe50349c4ad9`

## What was built

### 1. Server — `docs/backend/join-invite.sql` (new, controller must run it)

One idempotent script defining `app_redeem_invite(p_token text)` —
`RETURNS TABLE (group_id uuid, group_name text, status text)`, `LANGUAGE plpgsql`,
`SECURITY DEFINER`, `SET search_path = public`.

Why it must exist: `invites_select_members` hides the invite row from a prospective joiner (so the
client cannot even resolve a token to a group) and `group_members_insert_admin` refuses a
self-insert. No existing policy was touched or weakened.

Branches, in order: NULL profile → exception (`28000`); token normalized with
`upper(regexp_replace(..., '[[:space:]-]', '', 'g'))`; unknown token → `invalid`; `revoked_at` set →
`revoked`; `expires_at <= now()` → `expired`; group missing or `deleted_at` → `group-gone`; active
membership → `already-member` (no write, idempotent); `left`/`removed` membership → reactivated
(`status='active'`, `left_at=NULL`, `joined_at=now()`) → `rejoined`; otherwise a fresh
`group_members` row with `role='member'`, `status='active'`,
`display_name_snapshot = profiles.display_name` → `joined`. Success paths return the group id and
name. Grants: `REVOKE ALL ... FROM public` and `anon`, `GRANT EXECUTE ... TO authenticated`.

**Exact command for the controller** (Supabase SQL editor, once):

```
-- paste the whole of docs/backend/join-invite.sql
```

Nothing else has to run; the script is safe to re-run.

### 2. Frontend — `kupa-sgura.html`

* Invites (pure) section: `normalizeInviteToken()` (the single normalization, deliberately
  mirroring the SQL), `parseJoinToken()` now goes through it, plus `joinSucceeded()` and
  `joinNoticeMessage(status, groupName)` — one Hebrew line per status, group name only on success.
* New `// ---------- join by invite ----------` section (before boot):
  `redeemInviteToken()` (the only server call: `supabase.rpc("app_redeem_invite", { p_token })`,
  never throws), `showJoinNotice(token, autoRun)`, `runJoin()`, `closeJoinNotice()`,
  `stripJoinFromUrl()`, `maybeRunPendingJoin()`.
  * signed in → primary "הצטרף לקבוצה", busy label "מצטרף…", success line, `pullCloud()`, then the
    group page opens after a 700 ms beat;
  * signed out → primary "התחבר כדי להצטרף" → `showLogin()`; the token is kept **in memory only**
    (`pendingJoinToken`, no new storage key) and `applySession()` calls `maybeRunPendingJoin()`
    once, which also falls back to re-reading `location.search`;
  * no `supabase` at all → today's `SERVER_NOTE` copy and only "המשך"/"לא עכשיו".
  * `?join=` is stripped with `history.replaceState` only when the flow resolves, so a reload
    during sign-in keeps the token.
* Motion per DESIGN.md: the status line uses `fadeIn .25s`, `.is-error` recolours to `--bad`;
  the overlay and button press states are the existing shared ones.

### 3. QR — shipped

A self-contained encoder (`// ---------- qr (pure) ----------`): byte mode, level M, versions 1–10,
GF(256) with 0x11d, generator polynomial, block interleaving, function patterns, zigzag placement,
all eight masks with the four standard penalty rules, BCH(15,5) format info. `qrSvgElement()` renders
a ~160px SVG, dark-on-white regardless of theme, `role="img"`,
`aria-label="קוד QR להזמנה"`, from `inviteLink(...)`. Payloads that would need a version above 10
return `null` and no QR is drawn. The old placeholder wording and its `SERVER_NOTE` line are gone
(the note now only shows when there is no backend at all).

## Tests

`tests/join-invite.test.cjs` (17) — token normalization on both sides, every `joinNoticeMessage`
status incl. the unknown fallback, `joinSucceeded`, and structural checks: the RPC is called by
name, `pullCloud()` runs on success, no `.from("group_members")` / `.insert(` anywhere in the join
section, `cloudMode()` guard, `openGroup()`, `showLogin()` + `pendingJoinToken`, no URL strip at boot,
errors caught, markup present.

`tests/qr.test.cjs` (15) — GF tables and `qrMul` laws, generator degree, **Reed-Solomon
divisibility** (re-dividing data+EC leaves a zero remainder), block-table consistency, version
selection, function patterns, format info decoded back to level M + the chosen mask and re-verified
through BCH, and an **independent decoder in the test** that unmasks, walks the placement in reverse,
de-interleaves and reads the original string back — for ASCII, a long multi-block payload and UTF-8.

Two existing assertions were updated (not weakened) because the feature they described is gone:
`design-round.test.cjs` "the QR placeholder tile is gone" now asserts a real QR is wired, and the
row-21 / invites join-notice tests read the new join section instead of boot.

`node --test tests/*.test.cjs` → **468 tests, 467 pass, 1 fail**. The single failure,
`tests/hide-group-profile-id.test.cjs` "a former member can remove only their local group row …",
**already fails on `origin/main` (267396d)** — verified by stashing this branch's changes. It expects
`const profileId = authUser && authUser.id` inside `renderHideGroupAction`, which the source does not
have; presumably the matching source change is on the parallel friends branch.

`git diff --check` clean; the last `<script>` body parses with `new Function`.

## Manual verification plan (two accounts)

1. Run `docs/backend/join-invite.sql` in the Supabase SQL editor.
2. Account A (normal browser): sign in, create a group, open group settings → the invite card now
   shows the code, copy/share, **and a QR**. Scan the QR with a phone camera — it must open
   `.../?join=ABCD2345`.
3. Account B (second browser profile / incognito, not signed in): open the same link. The notice
   shows the code and "התחבר כדי להצטרף". Tap it → login screen. Sign in with a different account.
   The join should fire by itself: "הצטרפת לקבוצה <שם>", then the group page opens. Check the address
   bar no longer has `?join=`.
4. Reopen the same link as B → "אתם כבר בקבוצה <שם>", and `select count(*) from group_members where
   group_id=... and profile_id=<B>` stays 1.
5. As A, "בטל הזמנה", then open the old link as a third account → "ההזמנה בוטלה", only "המשך" left.
6. Garbage link `?join=ZZZZZZZZ` → refused by `parseJoinToken` (no notice at all);
   a well-formed but unknown code, redeemed → "הקוד לא נמצא".
7. Reload the page while the login screen is open — `?join=` must still be in the URL.
8. Airplane mode / block the CDN → the notice falls back to "יעבוד כשהאפליקציה תתחבר לשרת".
9. The SQL file's own "how to verify" block covers `expired`, `group-gone` and `rejoined`, which are
   easier to force from the SQL editor than from the UI.

## Open questions

* `expires_at` is never written by the client — invites are effectively permanent. Should the app
  set an expiry (e.g. 7 days) when creating one? The server branch is already there.
* After a join, `display_name_snapshot` freezes the joiner's current profile name. The parallel
  friends/profile-rename work may want a rename to propagate; out of scope here.
* A joined member's local `me`/guest identity mapping comes from the normal `pullCloud()` path; worth
  one live check that a joined group's member list shows the newcomer under the right identity.
* Nothing rate-limits redemption attempts. A guessed 8-character code from a 32-symbol alphabet is
  ~10^12 tries, so this is a "later" item, but a per-profile attempt counter would be cheap.
* `build.py` was deliberately not run (no version bump, `index.html`/`sw.js` untouched) — the release
  build belongs to whoever integrates this branch.
