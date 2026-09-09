# Bad-network resilience — durable outbox, backoff, honest sync dot — handoff

Branch: `worktree-agent-a300f4658a53087f8`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-a300f4658a53087f8`

## The bug this closes

`enterCloudMode()` (boot into cloud mode, on every cold boot with a restored session and on every
fresh sign-in) used to **pull before it pushed**. After a refresh mid-retry, every in-memory guard
that normally protects an unconfirmed write (`dirtyUntil`, `cloudPushTimer`, `cloudPushing`) is
gone — so that first pull could load the server's still-old copy of the open game right on top of
a buy-in that never reached it (`pickCloudOpenGame` sees the same `gameId` and "load"s the server's
row). No error, no retry, nothing to see: the push that followed just confirmed the now-corrupted
state, and the buy-in was gone from both devices. That is "the write never reaches the cloud" from
the brief, and it happens silently. Pushing first can never do that — it only ever sends what this
device already has.

## What was built

### 1. Durable outbox — `kupa-sgura.html`

- `state.cloudPendingIds` (new field, `normalize()` around line 1328) — the exact tracking added in
  commit `5903679` (the four group collections' unconfirmed row ids), moved off a module-level
  `let cloudPendingIds = new Set()` and into the one state document. `markCloudPending`/
  `clearCloudPending`/`cloudKeepLocalIds` now read and write `state.cloudPendingIds` directly —
  there is no second store to fall out of sync with `localStorage`. `save()` is still the only
  writer; `scheduleCloudPush()` (which `save()` already calls synchronously) does one extra
  `localStorage.setItem(KEY, JSON.stringify(state))` right after marking, so the outbox itself is
  on disk in the same tick as the edit that created it, not whenever the next unrelated `save()`
  happens to run.
- **Not covered by `cloudPendingIds`, by design, matching commit `5903679`'s own scope**: the open
  game / buy-ins. There is no per-entry pending-id list. Durability for the open game comes from a
  different, more general mechanism — see the boot-ordering fix below — plus the fact that
  `state.players`/`entryLog` were already being written to `localStorage` synchronously by `save()`
  before this change; that was never the missing piece. Only the *reconciliation* order was.
- `enterCloudMode()` now **always pushes before it pulls** (`pushCloud().then(() => pullCloud())`,
  unconditionally). This is the fix for the bug above and the literal "on boot, in cloud mode,
  anything unconfirmed is re-pushed first" requirement, applied broadly enough to actually cover
  buy-ins, not only the four group collections.

### 2. Smart retries — same file, `// ---------- cloud store (Supabase) ----------` and
`// ---------- cloud mapping (pure) ----------`

- `cloudBackoffDelay(attempt, randomUnit)` (pure) — full-jitter bounded exponential backoff:
  `random(0, min(15000, 1000 * 2^attempt))`. Ceilings: 1000 → 2000 → 4000 → 8000 → 15000 (held).
  Replaces the old one-shot `cloudPushRetried` boolean + fixed 900ms timeout entirely; retries are
  now unbounded in count (bounded in delay) — a buy-in typed on a flaky connection keeps trying on
  its own even if nobody reopens the app.
- `classifyCloudError(error)` (pure) → `"retry" | "surface"`. Network/timeout/5xx/429 → `"retry"`;
  RLS (`42501`), constraint violations (`23xxx`), and other 4xx → `"surface"` (payload was rejected
  on its merits — retrying it verbatim would just fail again). Unrecognized shapes default to
  `"retry"`, the same safe default the old code always used.
- `pushCloudRun()`'s catch: `"retry"` schedules the next attempt via `cloudBackoffDelay` and never
  gives up; `"surface"` stops looping, sets the error flag, and calls the pre-existing
  `scheduleCloudPull(1200)` — server wins, exactly as before.
- `cloudPushing` still guards "never two pushes in flight" (untouched); `pullCloud()`'s
  `if (cloudPushTimer || cloudPushing) { scheduleCloudPull(600); return; }` still guards "never a
  pull while a push is pending" (untouched — both regression-pinned by the existing
  `tests/cloud-race.test.cjs`).
- `window.addEventListener("online", cloudRetryNow)` and `visibilitychange → visible` (was a bare
  `pullCloud()`, now `cloudRetryNow()`) both retry immediately instead of waiting out the backoff.

### 3. Push before pull on reconnect

- `cloudRetryNow()` (new) — the conditional, cheaper version of the boot-time rule, for a session
  that is already live: `cloudReconnectOrder(cloudOutboxSignal())` decides push-then-pull only when
  there is something to protect (`state.cloudPendingIds` non-empty, or a push scheduled/in-flight);
  otherwise it just pulls, same as the code it replaced. Used by `online`, `visibilitychange`, and a
  tap on the dot.
- `cloudReconnectOrder(pendingCount)` (pure) → `"push-then-pull" | "pull-then-push"`.

### 4. Four honest sync-dot states

- `cloudSyncLabel(info)` (pure) → exactly `"מסונכרן"` / `"מסנכרן…"` / `"ממתין לרשת (N שינויים)"` /
  `"שגיאת שמירה"`, in that priority order (an in-flight push always wins the label).
- `refreshSyncDot()` computes `info` fresh every time from `cloudPushing`, `cloudSurfaceError`, and
  `cloudOutboxSignal()` (the pending-id count **plus** whether a push is scheduled/in-flight — the
  bare pending-id count alone would under-count a buy-in-only retry, since buy-ins don't touch
  `cloudPendingIds`, and the dot would falsely say "synced" mid-backoff). Called after every push
  attempt, every pull, `applyCloudGame`, `enterCloudMode`'s reset.
- `#syncDot` is now a `<button>` (was a `<span>`) with `aria-label` kept in sync with `title`, a
  `::before` pseudo-element giving it a 44×44 tap target without changing its visual 7px size or
  the surrounding `.eyebrow` layout, and a click handler wired to `cloudRetryNow` (a no-op outside
  cloud mode). Four CSS states (`.dot.on` unchanged / `.dot.syncing` / `.dot.waiting` / `.dot.error`)
  using only existing `--accent`/`--dim`/`--bad` tokens, so both themes work for free. `waiting` is
  a slow, muted pulse (`--dim`, no glow) — deliberately calmer than `syncing`'s fast turquoise pulse
  and nothing like `error`'s static red, so it never reads as a problem. All new `@keyframes` fall
  under the sheet's existing blanket `prefers-reduced-motion: reduce` rule.
- The legacy (non-cloud, Claude-document) `setSync(on, label)` path is untouched in behavior; it now
  also clears any stray cloud-state class and sets `aria-label`, so a sign-out can't leave the dot
  looking like it's still waiting/erroring.

### 5. Explicitly out of scope (per the brief)

No changes to `settle()`, `tableBalance()`, `buildHistoryEntry`, `buildDebtRecords`, the close-table
flow, `pickCloudOpenGame`, or `mergeCloudIntoState`'s game-merge branch. No new `localStorage` key.
No UI changes outside `#syncDot` and its four CSS states. Pull-error labels (`"שגיאת סנכרון — נשמר
מקומית"`) are untouched — that is a different, pre-existing signal for a different failure (the
read side, not the write/outbox side this task is about) and the brief's four states are explicitly
about the outbox.

## Tests

`tests/cloud-resilience.test.cjs` (new, 7 tests, pure functions + one structural pin):
`cloudBackoffDelay` bounded/monotonic-ceiling/jittered, `classifyCloudError` retry-vs-surface,
`cloudSyncLabel`'s four states, `cloudReconnectOrder`'s push-vs-pull-first decision, the
`cloudPendingIds` round trip through `normalize()` (junk dropped, missing/wrong-type defaults to
`[]`), `markPendingIds`/`clearPendingIds` now taking a plain array, and a structural check that the
retry catch actually calls the classifier/backoff (not the old flag) and that `enterCloudMode`
pushes before it pulls.

Four **existing** tests were updated, not weakened — each pinned the exact old mechanism this task
replaced on purpose:
- `tests/cloud-race.test.cjs` — the one-shot-retry test now asserts the classifier/backoff call
  shape instead of `cloudPushRetried`.
- `tests/cloud-mapping.test.cjs` — two tests: the push-error test now asserts classification +
  `refreshSyncDot`; the "pull runs on visibility" test now asserts `cloudRetryNow()`, not a bare
  `pullCloud()`.
- `tests/cloud-games.test.cjs` — the sync-dot label test now asserts `refreshSyncDot()`'s call sites
  and `cloudSyncLabel`'s four literal strings, instead of three hardcoded `setSync(...)` calls that
  no longer exist verbatim.
- `tests/design-round.test.cjs` — one regex updated for `<span>` → `<button>` on `#syncDot`.

`node --test tests/*.test.cjs` → **511 pass, 0 fail** (was 504 before this branch: +7 new). `git diff
--check` clean. The last `<script>` body parses with `new Function`.

## Manual verification plan (DevTools offline)

Needs a signed-in Supabase session with an open game (or a group to start one in). Chrome/Edge
DevTools → Network panel → the throttling dropdown.

1. **Buy-in while offline.** Set throttling to **Offline**. Add a buy-in. It appears immediately
   (optimistic local render, unchanged). Watch the sync dot: a brief "מסנכרן…" pulse, then it
   settles on the muted **"ממתין לרשת (N שינויים)"** — not red, not scary. Hover/long-press it (or
   read `aria-label` in the accessibility tree) to confirm the exact label text.
2. **Refresh while still offline.** Reload the page. The buy-in is still there (it was in
   `localStorage` from step 1, unrelated to this task). Within a moment the dot goes back to
   "ממתין לרשת" — `enterCloudMode()` tried to push first (per the fix), failed because still
   offline, and armed a backoff retry rather than pulling and losing the buy-in.
3. **Kill the tab, not just refresh.** Close the tab entirely while still offline, then reopen the
   app fresh. Same result as step 2 — nothing here depends on the tab having stayed alive.
4. **Go back online.** Flip throttling to **Online** (or **No throttling**). Expect the dot to react
   within about a second — the `online` listener calls `cloudRetryNow()` immediately rather than
   waiting out whatever backoff delay was in progress — cycling "מסנכרן…" → **"מסונכרן"**.
5. **Confirm on the server.** In the Supabase SQL editor:
   `select amount, recorded_at from entries where game_id = '<gameId>' order by recorded_at desc
   limit 5;` — the offline buy-in is there. (Or just open the same account/group on a second
   browser profile and watch the buy-in appear there.)
6. **Backoff shape, without waiting 15 seconds.** With DevTools open, throttle to Offline, make 2–3
   edits a few seconds apart to trigger a few failed attempts, and watch the Network panel's request
   timestamps for the retried `entries`/`games` calls — gaps should roughly double each time (≈1s,
   ≈2s, ≈4s…) rather than firing on a fixed interval, and never exceed ~15s apart once capped.
7. **Tap-to-retry.** While offline with a pending change, tap the dot. The Network panel should show
   an immediate (failed, since still offline) request attempt rather than waiting for the scheduled
   retry.
8. **A real 4xx, not just offline (optional, needs a second account or a revoked membership).**
   Force an RLS refusal (e.g. edit a group after being removed from it in another tab) and confirm
   the dot shows **"שגיאת שמירה"** (not "waiting"), and that the Network panel shows exactly one
   failed request for that edit, not a repeating retry loop — the next request should be a plain
   `GET` (the pull), not another attempt at the same write.

## Notes for whoever integrates this branch

- `build.py` was not run (no version bump, `index.html`/`sw.js` untouched) per the task's own
  instruction — that belongs to whoever lands this.
- `state.cloudPendingIds` is additive to the document shape; older clients reading a newer document
  (or vice versa) are unaffected — `normalize()` defaults a missing/malformed field to `[]`.
