# Sign-in screen rebuild — report (משימה 5)

Branch: `worktree-agent-a24f4b6c31f264ee3`, commit `298ee57`.
Merged local `main` first (fast-forward, brought in friend-invite hardening — no conflicts).

## What changed

`kupa-sgura.html` only (plus tests and `DESIGN.md`). No `build.py` run, `index.html`/`sw.js`
untouched by me.

### Markup (`<div class="login" id="login">`)
- Heading `כניסה` (was `מי אתה?`) + one benefit line (`.login-benefit`).
- Google button unchanged structurally but wrapped its SVG in `.btn-google-mark` (white circle
  backdrop for the colored G, per Google's own guidelines).
- Code step: same single `#authCode` field (already matched spec — one field, not six boxes).
  Added `.auth-code-actions` row with two quiet buttons: `#authResendBtn` ("שליחה חוזרה", starts
  disabled) and `#authCodeBackBtn` renamed to "שינוי כתובת" (was "מייל אחר").
- Local/no-account section: title copy changed to "איך קוראים לך?" (was "בחר את השם שלך…"),
  added `#loginChipsHint` ("שמות מהמכשיר הזה", hidden when there are no known names). `#loginSkip`
  changed from `.btn-skip` text-link styling to a new `.btn-quiet` class, text "המשך בלי חשבון"
  (was "דלג בינתיים") — bordered, 44px min-height, a real reachable control.
- Added `#authLegalNote` / `#authAgeNote` placeholders, populated from the two JS constants.

### CSS
- New `.btn-quiet` (bordered, `--dim` text, 44px min-height).
- `.btn-google` rewritten to Google's fixed brand colors per theme (dark `#131314`/`#8E918F`/
  `#E3E3E3`; light `#FFFFFF`/`#747775`/`#1F1F1F` via `:root[data-theme="light"] .btn-google`).
  Removed the old `:hover { border-color: var(--accent) }` (that was the turquoise-border
  violation) — hover is now a plain opacity dip.
- `.login-legal` (small, `--faint`, 1.5 line-height — tolerates two lines).
- `prefers-reduced-motion` block confirmed still last in `<style>` (untouched).

### JS — new "auth errors (pure)" section (before "auth (Supabase session)")
- `mapAuthError(error, step)`: DOM-free, state-free, pure. Maps network/offline, 429/rate-limit,
  wrong vs. expired code, invalid email, and Google failures to short Hebrew strings.

### JS — `auth (Supabase session)` section, every line touched
This is the one section the task allowed touching "only as far as this screen's flow requires":
1. Added `authAutoVerifyTimer`, `authResendTimer`, `authResendUntil` state vars.
2. `setAuthStep`: fixed the "sent to" copy to "הקוד נשלח ל־…" (was "שלחנו קוד ל־…", matching the
   spec's exact wording); clears the resend countdown/auto-verify timer when leaving the code step.
3. Added `clearResendCountdown()` and `tickResendButton()` / `startResendCountdown()` (60s window).
4. `signInWithGoogle`: `redirectTo` now includes `location.search` (see "invite token" below);
   error message now goes through `mapAuthError(e, "google")`.
5. `sendEmailCode`: starts the resend countdown on success; error now via `mapAuthError(e, "email")`.
6. Added `resendEmailCode()` — re-sends `signInWithOtp` to `authEmailPending`, restarts countdown.
7. `verifyEmailCode`: clears the auto-verify timer on submit, clears the resend countdown on
   success; error now via `mapAuthError(e, "code")`.
8. Added an `input` listener on `#authCode` that auto-verifies ~250ms after the 6th digit; wired
   `#authResendBtn` to `resendEmailCode`; `#authCodeBackBtn`'s handler now also clears the resend
   countdown and auto-verify timer.
9. `showLogin()`: computes `loginChipsHint.hidden` from whether any known names exist; fills
   `#authLegalNote`/`#authAgeNote` from the two new constants.

Nothing in the `backend config` block or `fmt`/`fmtSigned` was touched.

## Invite token across sign-in

The email-code path never navigates away, so the existing in-memory `pendingJoinToken`/
`pendingFriendToken` already survive it untouched — no bug there.

The Google OAuth path *does* navigate away and back (`signInWithOAuth` → provider → redirect).
The bug: `redirectTo` was `location.origin + location.pathname` — it dropped `location.search`
entirely, so a `?join=…`/`?friend=…` token present when the user tapped "המשך עם Google" was lost
on the way back, and `applySession()`'s call to `maybeRunPendingJoin()`/`maybeRunPendingFriendInvite()`
would find nothing (in-memory `pendingJoinToken` is also gone after the full-page navigation).

Fix: `redirectTo: location.origin + location.pathname + location.search`. Google returns to the
exact same URL including `?join=…`; `stripAuthParamsFromUrl()` only deletes supabase's own
`code`/`state`/`error*` keys, so the join/friend param survives in the address bar, and
`maybeRunPendingJoin()`'s existing fallback (`pendingJoinToken || parseJoinToken(location.search)`)
picks it up from there. **No new storage key** — the fix is entirely URL-based, reusing the
fallback path that was already written for this exact case; it just wasn't reachable before
because the param never made the round trip.

## Visual description (no screenshots — described)

**Dark theme:** heading "כניסה" in bold white, one dim gray benefit line below. Google button:
near-black (#131314) pill, thin gray (#8E918F) border, light gray (#E3E3E3) label, white-circle
colored G on the left. Divider "או". Email input (LTR) + solid turquoise "שלחו לי קוד" pill below
it — the only fully-filled turquoise control on the screen. Below the divider line: "בלי חשבון"
label, a short prompt, a bordered quiet pill "המשך בלי חשבון" — visibly present but clearly not
competing with the turquoise button. Two small legal/age lines at the very bottom in faint gray.

**Light theme:** same layout; Google button flips to white background, mid-gray (#747775) border,
near-black (#1F1F1F) text — still no turquoise anywhere on it. Turquoise email button and quiet
bordered "המשך בלי חשבון" keep their same relative weight (accent vs. `--line`/`--dim`) since both
ride the app's existing CSS variables, which already swap per theme.

**Code step (either theme):** single LTR numeric field, "הקוד נשלח ל־name@mail.com" line above it,
"אישור" pill below, then a small two-item row: "שליחה חוזרה (58)" (counting down, disabled while
counting) and "שינוי כתובת" (enabled, returns to the email field).

## Tests

Baseline 588 → **600 passing** (12 new, within the 8–12 budget) in `tests/auth-login.test.cjs`:
error-mapping per failure class (4 tests), code field attributes, auto-verify wiring, 60s resend
constant, legal/age constants + markup wiring, Google brand colors both themes + no turquoise
border, and two invite-token-survival tests (redirectTo carries `location.search`; the existing
`pendingJoinToken || parseJoinToken(...)` fallback is intact).

Changed 2 existing assertions in `tests/backend-config.test.cjs` (both strengthened, not weakened):
- The "the title stays" check for `מי אתה?` now asserts the *new* title `כניסה` exists **and**
  asserts the old gendered title is gone (`assert.doesNotMatch`) — stronger than the old "one
  string is present" check, and correctly reflects the owner's decision to rename the heading.
- The Google redirect test now asserts `redirectTo` includes `+ location.search` — this is a
  behavior fix (the invite-token bug above), not a relaxation; the old assertion would have kept
  passing against the buggy code, so this is a stronger, more specific check.

`node --test tests/*.test.cjs`: 600/600 pass. `git diff --check`: clean. Last `<script>` body
parses via `new Function(...)`.
