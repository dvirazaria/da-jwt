# WhatsApp invite sharing — handoff

Branch: `worktree-agent-a502475e07ca6eea8`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-a502475e07ca6eea8`
Commit: `20ba902432e88706d29389e53392431115f2d83b` — `feat: share group invites to WhatsApp`

## What was built

Change footprint is deliberately tiny and localized to the invite block: **35 inserted lines in
`kupa-sgura.html`, zero deletions, one new test file.** No CSS was added — the new button reuses the
existing `.games-invite-action` capsule class, so it inherits the same border/hover/press-state
(`button:active { transform: scale(.92) }`, global) as its "העתק קישור"/"שתף" siblings for free.

### 1. `buildInviteShareText(groupName, inviteCode, url)` — invites (pure) section

Inserted right after `formatInviteCode`, DOM-free and `state`-free, starting at column 2. Builds a
short, `\n`-joined Hebrew message:

1. one fixed line naming the app,
2. an invitation line that folds in the group name when known (same "base line, name appended only
   if present" shape as `joinNoticeMessage` right below it in the same section — no new idiom
   invented),
3. the join link on its own line (kept off any Hebrew line, which is also the simplest possible RTL
   safety measure — see "RTL notes" below),
4. the formatted invite code as a fallback line, only when there is a code to fall back to.

Each input degrades independently: a missing/blank group name swaps in a generic invitation line
instead of interpolating `"undefined"`; a missing/blank code simply drops its line instead of
leaving a dangling `"קוד: "` label.

### 2. Dedicated WhatsApp action — `renderGroupInvite()`

A new `whatsappBtn` (label "וואטסאפ") appended to the actions row right after the existing
conditional "שתף" button, before `card.appendChild(actions)`. Its handler:

```js
const link = inviteLink(invite.token, location.origin, location.pathname);
const message = buildInviteShareText(summary.name, formatInviteCode(invite.token), link);
if (typeof navigator.share === "function") {
  navigator.share({ title: summary.name, text: message }).catch(() => {});
} else {
  window.open("https://wa.me/?text=" + encodeURIComponent(message), "_blank", "noopener");
}
```

- **Native share first**: reuses the exact feature-detection idiom already used by the neighboring
  "שתף" button (`typeof navigator.share === "function"`) rather than inventing a second one. When
  available, this hands the OS share sheet the full message as `text` (no separate `url`, since the
  link is already embedded in the message — passing both risks some share targets appending the URL
  a second time).
- **wa.me fallback**: `https://wa.me/?text=<encoded>` is WhatsApp's own documented "click to chat"
  link *without* a phone number — it opens WhatsApp (desktop web or the app) with the message
  pre-filled and lets the user pick a recipient, on both mobile and desktop. Verified against
  WhatsApp's public click-to-chat documentation before wiring it in.
- No `alert`/`confirm`/form submit anywhere — `window.open(url, "_blank", "noopener")` is the same
  pattern already used by this file's legal-page links (`target="_blank" rel="noopener"`), so it is
  not new to the artifact-restricted environment.
- Existing "העתק קישור" and "שתף" buttons/handlers are untouched — this was a deliberate choice to
  keep the diff minimal and merge-safe while other agents edit the same file concurrently, not an
  oversight.

### Design notes (why no new CSS, why 40px not 44px)

The three invite actions ("העתק קישור" / "שתף" / "וואטסאפ") now share one row and one class. The
existing `.games-invite-action` capsule is documented in `DESIGN.md` at `min-height: 40px` (not the
usual 44px baseline) — giving the new button its own taller variant would make it visually
inconsistent with its two immediate siblings in the same row, which reads worse than being 4px under
the general touch-target guideline. Reused as-is: same border, same hover/press transition, same
`button:active { scale(.92) }` global press state, both themes, no new accent color, no icon (a
colored WhatsApp glyph would conflict with the app's single-accent / line-icon-only rule — the button
is plain text like its siblings).

### RTL notes

The message is plain text handed to `navigator.share`/WhatsApp, not rendered in this app's own DOM,
so there is no `dir="ltr"` attribute to set on it directly (the existing `.games-invite-code` element
that *is* rendered in our DOM already has one, untouched). The mitigation is structural instead: the
join link sits alone on its own line (a pure-LTR paragraph has no bidi ambiguity at all), and the
code is a strong-LTR run (`ABCD-1234`) following a short Hebrew label on one line — the same
plain-text shape as the app's own `"קוד: ABCD-EFGH"` displays elsewhere, with no adjacent sign
character (the specific thing that made `fmt`/`fmtSigned` need explicit FSI/PDI isolation for
`"-₪123"`). Manually verified reading order in the exact message below.

## The exact message text

For `buildInviteShareText("ערב פוקר של חמישי", "ABCD-1234", "https://poker-tau-pink.vercel.app/?join=ABCD1234")`:

```
סוגרים קופה — אפליקציה לניהול קופת פוקר
הצטרפו לקבוצת ערב פוקר של חמישי
https://poker-tau-pink.vercel.app/?join=ABCD1234
קוד: ABCD-1234
```

Without a group name (falls back instead of interpolating "undefined"):

```
סוגרים קופה — אפליקציה לניהול קופת פוקר
הצטרפו לקבוצת הפוקר שלנו
https://poker-tau-pink.vercel.app/?join=ABCD1234
קוד: ABCD-1234
```

Without a code (line dropped, not left dangling):

```
סוגרים קופה — אפליקציה לניהול קופת פוקר
הצטרפו לקבוצת ערב פוקר של חמישי
https://poker-tau-pink.vercel.app/?join=ABCD1234
```

## Tests

`tests/invite-share.test.cjs` (new, 6 tests, vm-slice + raw-source patterns from
`tests/invites.test.cjs` / `tests/motion.test.cjs`):

1. message contains the app line, the group name, the link (verbatim) and the code.
2. message stays short: ≤4 lines, <220 chars (chat-preview sized).
3. missing group name (undefined/null/empty/whitespace) never renders `"undefined"`, link+code intact.
4. missing code (undefined/null/empty/whitespace) never renders `"undefined"` or a dangling `"קוד:"` line.
5. `encodeURIComponent(message)` has no raw `?`/`&`/`=`/whitespace left (safe to embed in
   `wa.me/?text=`) and `decodeURIComponent` round-trips back to the exact original message.
6. raw-source regex on the handler: `navigator.share` is tried inside the `if`, `wa.me/?text=` only
   appears in the `else` branch, `encodeURIComponent(message)` and
   `window.open(..., "_blank", "noopener")` are both present.

Full suite: `node --test tests/*.test.cjs` → **510/510 pass** (504 pre-existing + 6 new), 0 failures.
`git diff --check` clean. The last `<script>` body (321,262 chars) parses via `new Function(...)`
with no error.

## Manual test plan

Run from the merged/integrated repo (not this worktree) once this branch lands, per HANDOFF.md's
documented local-serving flow:

```sh
cd "/Users/dvirazaria/פוקר" && python3 -m http.server 8765
# open http://localhost:8765/kupa-sgura.html
```

1. **Setup**: sign in (or local name flow) → open a group with at least one active membership →
   "הגדרות קבוצה" → "הזמנה לקבוצה". Create an invite if none exists yet.
2. **Layout**: confirm three capsules sit in the actions row — "העתק קישור", "שתף" (only where the
   test browser exposes `navigator.share`), "וואטסאפ" (always). Confirm `.games-invite-action`
   styling matches across all three: same border, same font-size/weight, same `min-height`, no visual
   outlier. Check both `data-theme="dark"` and `"light"`.
3. **Press state**: press-and-hold "וואטסאפ" — confirm the same `scale(.92)` shrink its siblings get.
4. **Native share path** (a browser/device that implements `navigator.share`, e.g. iOS Safari, Chrome
   Android, or a Chromium desktop build with the Web Share API flag on): tap "וואטסאפ" → OS share
   sheet opens with the message pre-filled as text → WhatsApp is one of the offered targets → picking
   it drops the exact message (verbatim, all 3–4 lines) into a new chat compose box.
5. **Fallback path** (a browser without `navigator.share`, e.g. desktop Firefox): click "וואטסאפ" →
   a new tab opens to `https://wa.me/?text=...` → WhatsApp Web/desktop shows the same message
   pre-filled in its compose box with no recipient chosen yet.
6. **RTL read-through**: in the opened WhatsApp compose box, confirm the Hebrew lines read
   right-to-left, the link reads left-to-right on its own line and is tappable/auto-linkified, and
   `קוד: ABCD-1234` shows the label on the right and the code reading left-to-right immediately to
   its left — no character reversal or scrambling anywhere.
7. **Regression**: confirm "העתק קישור" (clipboard + "הועתק ✓"), the existing "שתף" button (where
   present) and the QR tile all still work exactly as before — nothing about them changed.
8. **Revoke/recreate**: revoke the invite and create a new one → "וואטסאפ" button reappears wired to
   the new token/code (re-render is already handled by the existing `createGroupInvite`/
   `revokeGroupInvite` → `save()` → `renderGroupSurface()` flow, untouched by this change).
9. **Popup-blocker sanity**: confirm the fallback `window.open` is not blocked — it fires
   synchronously inside the click handler (a direct user gesture), same as any other same-turn
   `window.open` call.
