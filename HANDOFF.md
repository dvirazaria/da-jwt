# HANDOFF — "סוגרים קופה" (poker cash-game settlement PWA)

Context file for any coding agent picking up this project.

## What this is
A Hebrew, RTL, mobile-first PWA for settling home poker cash games:
the Games dashboard opens a contextual "שולחן" screen for players and buy-ins,
then a "חישוב" settlement screen with minimal transfers and a "פרופיל" record.
The dashboard also owns groups: create a group, add members, start a
group-linked game, see its history and leaderboard. Deployed on Vercel
(static, auto-deploys from `main`), installable to the home screen.
Current release version: 43.

## Files
- `kupa-sgura.html` — THE app. Single file: CSS + HTML + one IIFE of vanilla JS.
  Sections are commented: state, server sync, render, login, profile, settings, boot.
- `index.html` — GENERATED standalone PWA wrapper. Never edit by hand.
- `build.py` — release script. Single source of the version number: stamps it
  into the app + `sw.js` cache name and regenerates `index.html`. Run on every release.
- `sw.js` — service-worker cache list. Hand-maintained; `build.py` only regex-replaces the
  `CACHE = "kupa-vNN"` constant inside it on release, it does not regenerate the file.
- `manifest.webmanifest`, `icon-180/192/512.png` — PWA assets. The
  home-screen icons use the poker-table artwork supplied for this app.
- `poker-settle.html` — FROZEN legacy version for an old artifact URL. Do not edit.
- `tools/local-state-to-sql.js` — offline converter from a `poker-settle-v1` export to
  Postgres inserts matching `docs/backend/schema.sql`. Not part of the app; excluded from the
  Vercel deploy via `.vercelignore` (`tools/`). See `docs/backend/migration-from-local-state.md`.
- `docs/backend/` — portable backend artifacts written ahead of any account setup:
  `platform-research.md` (Supabase decision), `schema.sql` (DDL), `rls-policies.sql`,
  `migration-from-local-state.md`, `frontend-seam.md` (what changes in this file when the
  backend lands). `docs/backend-readiness.md` is the narrative summary that links all of them.

## Start here when continuing work

1. Read this file and `DESIGN.md` before touching the UI.
2. Work in `/Users/dvirazaria/פוקר` on branch `main`.
3. Edit only `kupa-sgura.html` for runtime behavior. Generated files are updated by `python3 build.py`.
4. Run `node --test tests/*.test.cjs` and `git diff --check` before committing.
5. After a verified change, commit and push `main`; Vercel deploys the push automatically.

Do not create a parallel React/Vite app or split the runtime into new files unless the owner explicitly changes the architecture. The current architecture is intentionally a single vanilla HTML file.

## Design system (deliberate, keep it)
Monochrome dark (default) + light theme via `:root[data-theme="light"]` tokens.
Single accent: turquoise `--accent`. Red `--bad` only for warnings/losses.
No boxes-in-boxes: flat rows with hairline separators, typography-led.
Floating capsule bottom tab bar (active tab = filled pill with label).
All animations respect `prefers-reduced-motion`.

## Data model (current, local/demo)
`state = { example, phase, gameId, players: [{id, name, buyins:[], entryLog:[], cashout, status,
exitedAt, guestId, memberId}], history: [...], debts: [...], settlementStatuses: {}, groupId,
startedAt, leaderRef, groups: [...], groupMembers: [...], invites: [...], friendships: [...],
updatedAt }`. Everything lives in this one document — one localStorage key, one sync target — per the
project's "keep one source of truth" rule; nothing here is a second store.
- `phase` is persisted as `active`, `settlement`, or `closed`. Legacy real snapshots
  that contain players migrate to `active`; legacy demo/empty snapshots migrate to
  `closed` and open the Games dashboard.
- `appView` is UI-only routing with `friends`, `games`, `game`, `settle`, `profile`, and `group` (a
  group's own page, `currentGroupId` selects which one). Friends, Games, and Profile are primary
  bottom-nav screens; `game`, `settle`, and `group` are contextual screens. Refresh resumes a real
  open game in its active/settlement phase and otherwise opens Profile — a group page is never the
  boot destination.
- Each entryLog item is {id, timestamp, amount, playerId, gameId}; timestamp is ISO UTC,
  displayed as local HH:mm. Legacy entries use null time (shown as —), never invented times.
  Numeric buyins stay unchanged for calculation compatibility. Add/undo must update both arrays.
  Both localStorage and the existing Claude document sync persist the log and gameId.
  Closing archives a detached entryLog per player and rotates gameId; reset also rotates it.
  Inline “פירוט כניסות” is current-game only; its expanded state is UI-only.
  Table balance is an integer `buy-ins - cashouts`. A normal close is enabled only at zero.
  Forced unbalanced closes require a one-second hold on the blocked main close button,
  then an inline confirmation, and archive `isBalanced: false` plus `balanceDifference`
  in the history record. Positive difference means money is missing; negative means there
  is an excess.
  Settlement rows have a reversible paid toggle while a game is open. Closing creates
  open debt records only for unpaid transfers; later payment changes the debt to `paid`
  with `paidAt` and never changes the poker result. The current app has name-based local
  identity, so profile filtering and creditor checks use the current player name until
  the planned authenticated backend supplies stable user IDs and RLS.
- A player can `exitPlayer()` mid-game (status `active`→`exited`, `exitedAt`, cashout stored on the
  existing `cashout` field). Exited players lose the buy-in plus button, show a quiet "יצא · ₪X" tag,
  and cannot rebuy; `activePlayers()`/`exitedPlayers()` partition the roster. Settlement/`tableBalance`/
  transfers are unchanged — they already count every player's cashout.
- Groups (`Group`), members (`GroupMember`), invites (`Invite`) and friend requests (`Friendship`)
  are pure data contracts documented as JSDoc typedefs at the top of the
  `// ---------- groups domain (pure) ----------` section. Pre-backend identity:
  `ParticipantRef = { userId: null, guestId, displayName }` — `userId` is always `null` until real
  accounts exist; `guestId` is the stable local identity (`resolveGuestId` reuses one guestId per
  displayName across groups/history on this device). "Who am I" inside a group is resolved by
  `userId === authUser.id` when both sides carry a profile id, with `displayName === me` retained as
  the offline/legacy fallback (`membershipMatchesUser` / `findMyMembership`).
  Nothing is ever computed and stored: `GroupSummary`, `LeaderboardEntry`, `GroupGameSummary`,
  `gameWinners` are all adapters over `groups`/`groupMembers`/`history`, never persisted fields.
  `getGroupSummaries(collections, meName)` is the real adapter the dashboard calls today (no longer
  a stub); `collectionsOf(state)` builds its input.
- The Games dashboard exposes active games, real groups (create/open/expand), and
  "משחק ללא קבוצה". There is intentionally no generic "התחל משחק" action outside a group's own page.
- **An empty table is not a game.** `isGameOpen(currentGame)` (pure section, next to
  `canStartGroupGame`) is the single "is there an open game" predicate: not example, phase
  active/settlement, **and at least one player**. `getActiveGameSummaries` returns `[]` for an
  empty slot, `canStartGroupGame` does not report `another-game-open` for it (a group start just
  replaces the empty slot), `getGroupSummary.hasActiveGame`, `continueCurrentGame` and the
  "סיים משחק" gates all go through it. Leaving the table (`setAppView` from game/settle to any
  other view) while `isEmptyOpenGame(state)` resets the slot via `newCurrentGame(state, { phase:
  "closed" })` + `save()` — no history entry, groups/history/debts untouched; the guard is strict
  (zero players, not example) so a real game is never wiped. While a game with players is open the
  "משחק ללא קבוצה" capsule renders `disabled` with the shared reason line ("יש משחק פעיל אחר — סגור
  אותו קודם") and `startUngroupedGame()` early-returns — it used to silently replace the open game.
- "סיים משחק" is a cancellable one-second pointer hold that changes only
  `phase` to `settlement`. "חזור לעריכת המשחק" changes it back to `active`.
  Only "סגור שולחן" finalizes the existing history/debt flow; for an ungrouped game it routes to
  Games, for a group game it routes back to that group's page (`setAppView("group")`) so the closer
  immediately sees the last game and the updated leaderboard.
- Regression checks: `node --test tests/*.test.cjs` (currently 228 tests across 20 files: entry
  logs, navigation/game phases, profile/debt tabs, player exit, the groups domain, group creation,
  the group page, group members, friends, invites, starting/closing a group game, the active-group
  game, group history/leaderboard, group privacy, group lifecycle (archive/delete/leave), dashboard
  integration, the local-state→SQL export tool, the Task 18 motion pass, and an end-to-end domain
  scenario driving create-group → members → start game → buy-ins → exit → close → history → leaderboard).
- localStorage key `poker-settle-v1` (legacy prefix kept for continuity;
  also `poker-settle-me`, `-theme`, `-contact`, `-profile-debts-seen`). No new keys were added for
  the groups work — everything flows through the same `normalize()`/`save()`/`remoteBody()` triple.
- Optional realtime sync via `window.claude.use("db")` (works only when
  served as a claude.ai artifact; on Vercel it's localStorage only).
  Whole-state doc, last-writer-wins, `updatedAt` guards stale overwrites,
  snapshot bodies are frozen (must deep-clone). This entire sync layer is
  meant to be REPLACED by a real backend — see "Next milestone" below for the concrete plan.

## New flows (groups, members, invites, friends)

- **Player exit** — "יציאה" next to "פירוט כניסות" on an active player's row opens an inline
  capsule (reuses `.pmenu`) for a cashout amount; confirming calls `exitPlayer()`. An exited row
  shows "יצא · ₪X" and "עריכה" to change the amount (`updateExitCashout()`), never re-adds the plus
  button.
- **Create a group** — dashboard "+ צור קבוצה" (now enabled) opens an inline panel: name + an avatar
  picker that resizes the image on canvas to 96×96 JPEG q0.8 and stores it as a data URL. `createGroup()`
  builds the group and an admin `GroupMember` for the creator, then navigates straight to the group page.
- **Group page** (`appView === "group"`) — header (avatar/name/member count), a primary action gated
  by `canStartGroupGame()` (open a table for this group, or a quiet reason it's blocked), leaders,
  last game, members, invite, and history — each section is its own `renderGroup*` function reading
  only from the adapters, composed by `renderGroupPage()`.
- **Members** — admins add a guest by name inline ("+ הוסף חבר"; duplicate active name shakes),
  remove a member with a two-step armed button (refused if it's the last admin), promote a member to
  admin. Former members collapse under "חברים לשעבר (N)". A registered member cannot be added yet —
  there are no accounts; the note under the input says so.
- **Invites** — any active member sees a single active invite per group: a large code, "העתק קישור",
  "שתף" (when `navigator.share` exists), and a QR tile that is a deliberate placeholder ("QR יופיע עם
  חיבור לשרת" — rendering is deferred, not broken). Admins can revoke/regenerate. Opening `?join=CODE`
  shows a full-screen notice and does **not** join anything yet; the query string is stripped.
- **Friends screen** (`appView === "friends"`) — a primary bottom-nav destination with three
  adapter-driven lists (friends, incoming, outgoing), always empty today because nothing in the UI
  calls `createFriendRequest()` — the pure functions exist and are tested, but there is deliberately
  no path to fabricate a local friendship. Profile now contains only Balance and Debts.
- **Group games** — a group's "התחל משחק" opens a participant picker (checkbox rows for active
  members + "+ הוסף אורח"); `startGroupGame()` builds the current-game slot via `newCurrentGame()`
  and reuses the existing table/settlement/close flow unchanged. Closing a group game writes
  `groupId`/`startedAt`/`leaderRef` into the history entry and frees the slot (`groupId`/`leaderRef`
  reset to `null`) so the group can start its next game.
- **Group history & leaderboard** — every closed game for a group is a derived `GroupGameSummary`
  (date, player count, winner names, pot, balance flag); tapping a row expands a by-place ranking
  (names only). `buildLeaderboard()` ranks by total net desc → games played desc → name, with tied
  net sharing a rank, and never exposes a money field to the renderer (enforced by
  `tests/group-privacy.test.cjs`).
- **Archive / delete / leave** — a group-page "הגדרות קבוצה" overlay (admin: rename, avatar,
  archive/unarchive, delete; any member: leave). Delete and archive are soft (`deletedAt`/
  `archivedAt`); history entries and debts are never touched. Deleting or leaving while the group's
  game is open, or leaving as the last admin, is refused with an inline reason instead of allowed.

## Documented limitations (intentional, not bugs)

- **Single active game slot** — the engine still has exactly one current-game slot per device
  (`state.players/phase/gameId`), so a group can have at most one open game **and** the whole device
  can only have one open game at a time, even across different groups. `canStartGroupGame()` reports
  `group-has-open-game` vs `another-game-open` accordingly. The backend removes the second
  limitation: `schema.sql`'s `games_one_open_per_group_uk` is a per-group unique index, not per-device.
  In cloud mode this shows up as `pickCloudOpenGame()`: a second open game on the server is kept
  waiting (and logged) rather than replacing the table somebody is standing at.
- **Hybrid identity** — Supabase phase 1 fills `me` from `profiles.display_name`, and since phase 2b
  a `ParticipantRef` keeps a `userId` when the server supplied one. Group membership and admin
  checks prefer that stable profile id, so a later display-name edit does not hide group settings.
  Local/legacy rows without a profile id still fall back to `displayName === me`;
  `resolveGuestId()` gives the same name the same `guestId` across groups/history on one device,
  so two different local-only people can still collide if they type the same name.
- **Leaderboard eligibility rule** — since nobody is a linked account yet, "eligible for the
  leaderboard" is defined as "matches a `GroupMember` record of this group, in any status" rather
  than the spec's `userId != null`. Ad-hoc game guests who never joined the group are excluded. This
  tightens to `userId != null` post-backend without touching the UI (`isLeaderboardEligible`).
- **QR placeholder** — the invite block always renders a QR-shaped tile with explanatory text
  instead of an actual QR code; encoding `inviteLink()` into a real QR is deferred, not missing by
  accident.
- **`HISTORY_MAX` is 400**, not the old 60 — the leaderboard and group history need the full group
  history, not just a recent slice. Anything beyond that cap on a given device is simply absent from
  a local-state export (see `docs/backend/migration-from-local-state.md`).
- **Avatar images are data URLs** (~12KB, 96×96 JPEG) inside `state`, not uploaded files — fine for
  one localStorage document, not meant to survive as-is once there's a backend with real file storage.

## Hard-won gotchas (do not regress)
- The claude.ai artifact iframe blocks `form submit`, `window.confirm`,
  `alert` — use click handlers and the existing two-step arm/confirm pattern.
- iOS PWA: keyboard drags fixed-bottom elements → the tab bar hides on
  input focus (`.kb-open`); safe-area insets are handled in `.wrap`/tab bar.
- Buy-in confirm is a two-tap flow with an animated close; re-entrant
  confirms are dropped via `menuClosing` (prevents double buy-ins).
- Editing example data wipes it (`markReal()` returns true = stop the action).
- Duplicate player names are rejected (name is the identity key everywhere).

## Backend (phase 1: client, public config, real sign-in)

**What is wired.** `kupa-sgura.html` loads `@supabase/supabase-js@2` (UMD) from jsDelivr in a
deferred `<script>` placed just before the app script, and builds one client in the
`// ---------- backend config ----------` block at the top of the IIFE. `defer` is ignored on inline
scripts, so the app script starts *first*: `bootBackend()` therefore builds the client again on
`DOMContentLoaded`, once the CDN file has actually executed. The `// ---------- auth (Supabase
session) ----------` section owns everything else: `initAuth()` (`getSession` +
`onAuthStateChange`), `applySession()`, `ensureProfile()` (upsert into `profiles`:
`id`/`display_name`/`email` only — the columns `profiles_insert_self`/`profiles_update_self` allow),
`signInWithGoogle()`, `sendEmailCode()` / `verifyEmailCode()` (email OTP), `signOutAccount()`, and
`stripAuthParamsFromUrl()` (tidies `?code=` / `#access_token=` after the session is set, and keeps
`?join=` intact). `me` is now fed from `profiles.display_name`; `poker-settle-me` stays as the
offline cache. `#settings` shows the signed-in address under the avatar and "התנתקות" signs the
session out before the existing local swap flow.

**What phase 1 left alone.** Game data stayed on the local/Claude-doc document sync and no table
besides `profiles` was read or written. Phase 2a (below) changed that for groups, members, invites
and friendships; games, history and debts are still local-only, and `ParticipantRef.userId` is still
always `null` (phase 3 links accounts to refs).

**Offline / CDN-blocked is a first-class path.** `supabase` is `null` whenever supabase-js is
missing, every call site early-returns on it (enforced by `tests/backend-config.test.cjs`), and the
login screen then shows only the existing local name flow plus the note
"כניסה עם חשבון לא זמינה כרגע". The service worker does not cache the CDN file; that is accepted
for this phase.

**The two constants are public on purpose.**
`SUPABASE_URL = https://aztfjlssjbjhxdqsflgn.supabase.co` and
`SUPABASE_PUBLISHABLE_KEY = sb_publishable_…` are meant to ship in the client: the publishable key
only grants what the RLS policies in `docs/backend/rls-policies.sql` grant the `authenticated` role.
The security boundary is RLS, not key secrecy. A service-role / secret key must never appear in the
source — `tests/backend-config.test.cjs` fails if one does.

**Testing locally.**
```sh
cd "/Users/dvirazaria/פוקר" && python3 -m http.server 8765
# then open http://localhost:8765/kupa-sgura.html
```
`http://localhost:8765/**` is an allowed redirect URL in the Supabase project, so the Google
round-trip returns to the page it left. Email OTP works out of the box but is rate-limited to
**2 mails/hour** until custom SMTP is configured; Google sign-in needs the provider enabled in the
Supabase dashboard with the OAuth client from Google Cloud. Opening `kupa-sgura.html` over `file://`
gives no session (no allowed origin) — the local name flow still works there.

## Backend (phase 2a: cloud persistence for groups, members, invites, friendships)

**Two modes, one UI.** `cloudMode()` is `!!(supabase && authUser)`. With a session Supabase owns
`groups` / `group_members` / `invites` / `friendships` and the local `state` document stays the
working copy every renderer and adapter already reads — so no renderer, adapter or pure domain
function changed. Without a session the app behaves exactly as before, including the Claude-document
sync. The two writers never run together: `initSync()` returns immediately in cloud mode and
`enterCloudMode()` drops `gameDoc` if a session arrives after it started.

**Still local-only after 2a:** the open game, `history`, `debts`, `settlementStatuses`, and the
`?join=` invite redemption. Everything but `?join=` landed in phase 2b (next section).

**Two new sections in `kupa-sgura.html`:**

- `// ---------- cloud mapping (pure) ----------` (right before `function el(`) — DOM-free,
  state-free row mappers, unit-tested from a vm slice by `tests/cloud-mapping.test.cjs`:
  `groupToRow`/`rowToGroup`, `groupMemberToRow`/`rowToGroupMember`, `inviteToRow`/`rowToInvite`,
  `friendshipToRow`/`rowToFriendship`, `guestToRow`, plus `refToIdentityRow`/`identityRowToRef`,
  `buildCloudRows`, `diffCollections` and `mergeCloudIntoState`.
- `// ---------- cloud store (Supabase) ----------` (right after the document-sync section) —
  `pullCloud()`, `pushCloud()`, `scheduleCloudPush()` (400ms debounce, same as before),
  `scheduleCloudPull()`, `applyCloudPull()`, `enterCloudMode()`, `exitCloudMode()`.

**Identity at the row boundary.** Local code never mints a `userId` — but since phase 2b a UUID that
came back from the server is kept on the ref (`keptUserId`), so an account holder is not demoted to a
guest on the next push. `guestId` still follows the 2a rule, and `sameIdentity()` matches on any id
both refs carry, so a member row that knows its `profile_id` and a closed game that only ever recorded
the `guestId` are still one person. A membership whose `displayName` is `me` (or whose `guestId` is the one this
device uses for me) becomes `profile_id = authUser.id`; everybody else becomes a `guests` row
(`id = guestId`, `created_by = me`) upserted before the members that reference it. `hiddenAt` (no
column) and a group's `avatarDataUrl` (`avatar_url` is object storage, not a data URL) are
device-local and are carried across a pull by `mergeCloudIntoState`.

**Push/pull rules.** `save()` calls `scheduleCloudPush()` in cloud mode and `scheduleRemoteSave()`
otherwise. A push upserts in FK order — guests → groups → group_members → invites → friendships —
with `{ onConflict: "id" }`, sending only rows `diffCollections` says changed since the last
confirmed baseline. A row the schema or RLS would refuse is dropped before the request: a non-UUID
legacy id, a member with no identity, a token under 8 characters, a friendship this device may not
write. `deletes` are never applied (none of these tables has a DELETE policy; removal is
`deleted_at` / `status`). A pull runs after sign-in, on `visibilitychange → visible`, and after a
push error; it defers while an `<input>` is focused or a local edit is still unpushed, exactly like
`applyRemote` always did. Sync dot: `"מסונכרן לחשבון"` on success, `"שגיאת שמירה — נשמר מקומית"` on a
push error, `"שגיאת סנכרון — נשמר מקומית"` on a pull error.

**First-device seeding.** `mergeCloudIntoState` keeps local records the server could not have
returned (a legacy id, or anything created since the last confirmed push), so the pull that follows
sign-in never eats an unsynced group; the push right after it sends them up.

## Backend (phase 2b: cloud persistence for games + realtime table sync)

**What syncs now.** With a session the server owns everything the poker record is made of:
`games`, `game_participants`, `entries`, and — written at the close — `transfers` and `debts`, on
top of the four collections phase 2a moved. Two phones signed into the same account (or two members
of the same group) see the same open table, the same buy-ins, the same closed-game history and the
same debts.

**One new local seam, no engine change.** `settle()`, `tableBalance()`, `buildHistoryEntry()`,
`buildDebtRecords()`, the `finishCloseTable()` flow and every hold/confirm pattern are untouched;
the cloud write is simply what `save()` does afterwards. New pure functions live in the same
`// ---------- cloud mapping (pure) ----------` section (all vm-tested by `tests/cloud-games.test.cjs`):
`gameToRow` / `cloudGameOpenShell`, `participantToRow` / `rowsToPlayers`, `entryToRow` / `rowToEntry`,
`transferToRow` / `rowToTransfer`, `debtToRow` / `debtPaymentRow` / `rowToDebt`, `cloudUuidFrom`,
`gameSnapshotFromState` / `gameSnapshotFromHistory`, `buildHistoryEntryFromCloud`,
`buildOpenGameFromCloud`, `pickCloudOpenGame` and `shouldApplyIncomingGame`.

**Write order is the close order.** RLS (`app_can_write_game`) and the `*_immutable_when_closed`
triggers refuse every child write once `phase = 'closed'`, and `games_insert_member` refuses to
INSERT an already-closed game at all. So a push goes: guests → groups → group_members → invites →
friendships → **games (open only)** → game_participants → entries → transfers → **games (the close)**
→ debts. A closed game that the server has never seen gets an open "shell" row first
(`cloudGameOpenShell`). Once the server confirms a game closed it is *frozen*: nothing about it or
its children is ever written again, except the creditor's `debts` status flip, which is a
column-limited `UPDATE (status, paid_at, paid_by_profile_id)`.

**Deletes.** `entries` and `game_participants` are the only real deletes — "בטל אחרונה" removes the
entry row, and undoing a player's last buy-in removes the participant — and only on the game that is
currently the open slot. A game that merely dropped out of the payload (a local reset, history
ageing out) never takes the server's rows with it.

**Realtime.** While the slot holds an open game, `supabase.channel("game:" + gameId)` subscribes to
`postgres_changes` on `games` (`id=eq.<id>`), `game_participants` and `entries` (`game_id=eq.<id>`).
Events are debounced 300ms into one targeted re-read of that game, and applied through the same
parking rule as the document sync: never while an `<input>` has focus, never while a local edit is
still unpushed (`tryApplyParked` retries on `focusout`). A close arriving over the channel falls back
to the full `pullCloud()`, because it moves history, debts and the slot together. The channel is torn
down when the game closes, when the slot changes, and on sign-out.

**Single-slot limitation (intentional).** The device has exactly one current-game slot. A pull loads
the server's open game when the slot is empty, closed or example, or when it is the same game;
when the slot holds a *different* open game the local one wins and the server's waits (with a
`console.warn`). A game already in this device's `history` is never reopened by a pull, so a close
whose push failed is retried rather than undone.

**What is still not there.** `?join=` invite redemption (needs an RPC — the joiner is not a member
yet, so no SELECT policy can see the invite), friend requests have no UI, more than one open game
slot per device, avatar object storage, and bulk-uploading a device's pre-existing local history (a
closed game can only reach the server by being opened there first). Guest→account linking is
covered next.

## Guest → account linking ("קישור אורח לחשבון"), v2 — no approval step

Closes the identity gap phase 2b left open: a guest played real games, owes/is owed real debts and
sits in a group's roster under `guest_id`, then signs in and gets an empty new `profiles` row with
none of it visible. An earlier design required a second, independent human (the guest's creator or
a group admin) to approve a "זה אני" request before anything merged — safe, but it put a human
approval in a brand-new user's first minute. That design was never run against the project and has
been replaced outright (not layered on top of); `docs/backend/link-guest.sql` (paste-ready) now
ships **zero approvals in the happy path**, with friction scaled to financial risk instead of
applied uniformly, in three paths tried in this order:

1. **Invite-bound linking (primary).** A member creates an invite and optionally binds it to one
   existing, unlinked guest of that group ("הזמן את דוד") —
   `renderInviteGuestBindPicker(groupId)`, a small chip picker shown only when the group actually
   has an eligible guest, right above "צור הזמנה" in the group-settings invite block. The chosen
   guest id travels only as `invites.bound_guest_id`, never in the shared link/QR/code
   (`inviteLink()` takes no such parameter). `app_redeem_invite(p_token)` (extended, same
   signature) links that guest to whoever redeems the token, silently, in the same transaction as
   joining — a refusal (already linked, double-seat) is swallowed on purpose, since the redeemer
   never asked to be linked to anyone, only to join a group.
2. **Verified contact match (automatic fast path) — not shipped.** `guests` carries no
   phone/email column and nothing in `kupa-sgura.html` captures one for a guest today (a guest is
   only ever added by typed display name). Building the capture UI would widen the
   `GroupMember`/`Player` pure data contracts and their whole cloud push/pull mapping — a
   materially separate feature, flagged as a follow-up rather than built half-way.
3. **Zero-exposure self-claim (fallback).** `app_self_claim_guest(p_guest_id)` — the signing-in
   user, acting only as their own `auth.uid()` — links a same-name guest to themselves **instantly**
   when doing so cannot move money: no open debt on either side, and no `game_participants` row in
   a game that is still open/in settlement or closed unbalanced
   (`app_guest_has_zero_exposure`, enforced inside the RPC, not just suggested by the UI). Any
   exposure raises `GUEST_LINK_HAS_EXPOSURE`, which the UI turns into "ask a member for a personal
   invite link instead" — friction scales with risk rather than gating every claim uniformly.

All three funnel through one internal, **ungranted** engine, `app_link_guest_to_profile(p_guest_id,
p_claimant)`: re-points `game_participants`, `debts` (`debtor_*`/`creditor_*` independently) and
`games.leader_*` from `guest_id` to `profile_id`, skips a `group_members` row only where the
claimant already holds an independent active membership in that same group, and sets
`guests.linked_profile_id`/`linked_at` as the idempotency marker (the same rule guards every path
against re-linking an already-linked guest). `transfers`/`entries` need no change — they reference
`game_participants.id`, not an identity column, so they follow automatically. Refuses
(`double-seat`, surfaced as `GUEST_LINK_DOUBLE_SEAT` from the self-claim path) if the link would
seat the same person twice in one game, in every path, with no partial effect. Being ungranted
(`REVOKE ALL` from every role, no `GRANT`) is the actual protection — it takes a caller-supplied
`p_claimant`, the opposite of every public RPC in this file, so it must never be directly reachable.

**Frontend, cloud mode only — everything below is a no-op when `cloudMode()` is false.** A pull
still reads `guests` (RLS-narrowed) into `cloudGuestRows` — in-memory only, same pattern as
`cloudProfileIds`/`cloudGameCreators`, no new localStorage key (the `guest_claims` pull and its
cache are gone with the table). `guestClaimCandidatesInGroup` (cloud mapping (pure)) and
`seatsGuestAndUser` / `applyGuestClaimLocally` / `guestHasZeroExposure` (groups domain (pure)) are
the pure helpers, tested in `tests/guest-claim.test.cjs`. `renderGroupGuestClaims()` still renders
on both the group page and the group-preview overlay: a calm "שיחקת כאן בעבר בשם X?" / "זה אני" /
"לא" row per same-name unlinked guest, reusing `renderFriendGroup` — tapping "זה אני" links
instantly or shows a short inline reason it could not. Nothing here touches `settle()`,
`tableBalance()`, `buildHistoryEntry()`, `buildDebtRecords()` or the close-table flow: the merge is
entirely server-side, and the next `pullCloud()` already shows it merged, because every reader (RLS
policies, the leaderboard views, `buildHistoryEntryFromCloud`) keys off `profile_id`/`guest_id`
exactly as it always did.

**Known gaps, documented rather than patched blind:** (1) `guests_update_creator` in
`rls-policies.sql` technically still lets a guest's creator `UPDATE` `linked_profile_id`/`linked_at`
directly — RLS cannot express "every column except these two"; the fix needs verifying against a
real `ON CONFLICT DO UPDATE` upsert's generated column list first, which this repo cannot run SQL
to check. (2) `invites_update_admin` deliberately does not re-validate `bound_guest_id` (only
`invites_insert_admin` does) — see the comment above that policy in `link-guest.sql` for why
re-checking "still unlinked" on every later UPDATE would start rejecting a bound invite's own
revoke the moment its binding resolves. Both are narrow, low-blast-radius gaps, not silently
ignored risks.

## Account deletion

A signed-in account can delete itself from Settings → "אזור מסוכן" → "מחיקת חשבון" (an inline
grid-collapse confirm panel, then the same cancellable one-second pointer hold as `סגור שולחן`/
`סיים משחק` — never `alert`/`confirm`). The client calls the `SECURITY DEFINER` RPC
`app_delete_my_account()` (`docs/backend/delete-account.sql`, paste-ready, never executed by this
repo or its tests). It scrubs `profiles` to a neutral "משתמש שנמחק" instead of deleting the row
(`groups.created_by_profile_id`/`games.created_by` are `NOT NULL` + `ON DELETE RESTRICT`, and
`guests.created_by` is `ON DELETE CASCADE` into a further `RESTRICT` — a hard delete would abort or
cascade-destroy other people's history), repoints every identity-bearing row it is allowed to touch
(`group_members`, an open game's `game_participants`/`entries`, `debts`) to one fresh `guests` row
while leaving a closed game's rows untouched (the schema's own immutability triggers block them —
schema.sql section 7 — so a closed game's balances cannot move by construction), hands a sole-admin
group to its longest-standing active member or archives it, revokes the caller's outstanding
invites, and finally deletes `auth.users`. `pickAccountDeletionSuccessor` and `scrubLocalIdentity`
in `kupa-sgura.html`'s groups-domain (pure) section mirror the succession and identity-scrub logic
respectively and must stay in sync with the SQL if either ever changes. On success the client
applies `scrubLocalIdentity` to the local document, signs out, and returns to the login screen with
a short confirmation line; on failure nothing local is touched and the panel shows an inline error.

## Next milestone (the reason for this handoff): real users

Goal: each player signs in, joins a shared table/group from their own phone, adds their own
buy-ins; closing the table writes an immutable per-player record. The groups/friends/invites data
model above was built specifically so this milestone is additive, not a rewrite — every collection
already flows through `normalize()`/`save()`/`remoteBody()`, and the pure domain functions
(`createGroup`, `addGroupMember`, `createInvite`, `createFriendRequest`, …) are already the exact
spec for the matching backend action.

Full research, schema, RLS policies, migration plan, and the seam where the sync layer gets replaced
are already written — read them before starting, don't re-derive them:
- `docs/backend-readiness.md` — narrative summary: entities, endpoints, auth, permissions, migration.
- `docs/backend/platform-research.md` — **decision: Supabase** (Postgres + RLS + Realtime + Auth),
  free tier, cost projection, and the exit path if it's ever outgrown.
- `docs/backend/schema.sql` / `docs/backend/rls-policies.sql` — the DDL and RLS to run, ready to paste.
- `docs/backend/migration-from-local-state.md` + `tools/local-state-to-sql.js` — one-time, one-device
  export of the current `poker-settle-v1` into the new schema.
- `docs/backend/frontend-seam.md` — exactly which functions in `kupa-sgura.html` change
  (`initSync`→`initBackend`, `remoteBody`/`applyRemote`/`scheduleRemoteSave` replaced by row-level
  mutations + realtime) and which stay untouched (`settle()`, `tableBalance()`, every renderer).

NEVER commit keys/secrets (this repo already had one leaked+rotated Google service-account key —
history still contains the dead key). Only the `sb_publishable_...` key is meant to reach the client;
`sb_secret_...` must never appear in source, commits, or Vercel static assets. The current "login"
screen (name only) becomes the real auth screen; `me`/contact fields in settings were built as
placeholders for this, and `ParticipantRef.userId` starts getting real values instead of `null`.

## Friend-invite backend — manual SQL order

The friend-link client now requires the secure server flow; it intentionally creates no offline
fallback token. In the Supabase SQL editor, run these files in this exact order, each as its own
successful transaction, and do not run them from the app:

1. `docs/backend/schema.sql`
2. `docs/backend/rls-policies.sql`
3. `docs/backend/join-invite.sql`
4. `docs/backend/link-guest.sql` (if guest-linking is enabled)
5. `docs/backend/friend-invites.sql`

`friend-invites.sql` creates the dedicated RLS-protected `friend_invites` table and grants only
authenticated callers access to `app_create_friend_invite()` and
`app_accept_friend_invite(text)`. It must follow the first two files because it depends on
`profiles`, `friendships`, `app_set_updated_at()`, and `app_current_profile_id()`. Never add the
token to `profiles` or a profile SELECT response: profile policies can expose a profile to an
existing friend or group-mate, while a friend-invite token remains secret by design.

## Release process
1. Edit `kupa-sgura.html` only.
2. Bump `VERSION` in `build.py`, run `python3 build.py`.
3. Commit + push `main` → Vercel auto-deploys. `.vercelignore` keeps
   non-app files out of the public deployment.
4. User preference: after a completed and verified work round, commit and push
   the intentional changes to `main`, then wait for and verify the Vercel deployment.

## Current release snapshot

- Git remote: `https://github.com/dvirazaria/da-jwt.git`.
- Current commit at handoff: `ca8b75c` (the groups/friends/invites foundation — plan
  `docs/superpowers/plans/2026-09-07-groups-foundation.md` — is complete through Task 19 and on
  `main`; see `docs/superpowers/plans/2026-09-08-pre-backend-gaps.md` for the Task 19 gap audit).
- Release builder version: `43`; generated service-worker cache is `kupa-v43`.
- Live deployment: `https://poker-tau-pink.vercel.app/`.
- `archive/all-in-cash/` is an unrelated old prototype, ignored by Git and excluded from Vercel. Do not use it as the source for this app.
- The current local identity is a typed name (`poker-settle-me`), not authentication. Do not treat it as secure identity or build authorization on it.

## Next work boundaries

The next major milestone is real multi-user persistence. Before implementing it, read
`docs/backend-readiness.md` and `docs/backend/frontend-seam.md` — they already inventory exactly
which functions change (`initSync`, `remoteBody`, `applyRemote`, `scheduleRemoteSave` on the sync
side) and which don't, so this isn't a cold start. Supabase is the agreed and researched direction
(`docs/backend/platform-research.md`), and `docs/backend/schema.sql`/`rls-policies.sql` are ready to
run — but no Supabase project exists yet; step 1 of the connection plan needs the owner's own
account. Never place keys in source, commits, `index.html`, or Vercel static assets.

The Games dashboard's group data is real (`getGroupSummaries(collectionsOf(state), me)`, `+ צור קבוצה`
enabled), but it is still entirely local/per-device: no remote membership, no real invite redemption,
no cross-device identity. `ActiveGameSummary` remains the only data shape the active-game dashboard
UI should consume; `GroupSummary`/`LeaderboardEntry`/`GroupGameSummary` are the equivalent contracts
for groups. Card/panel expansion stays in-memory UI state and must never call `save()`.
