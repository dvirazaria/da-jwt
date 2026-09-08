# Claude handoff — סוגרים קופה

Read [`HANDOFF.md`](HANDOFF.md) and [`DESIGN.md`](DESIGN.md) before making changes. They are the source of truth for architecture, behavior, UX, persistence, and known pitfalls.

## Fast project map

- `kupa-sgura.html`: only runtime source. It contains CSS, HTML, and one vanilla-JS IIFE.
- `build.py`: release builder. It bumps the version in the source, replaces the `CACHE = "kupa-vNN"` name inside `sw.js`, and regenerates `index.html`.
- `index.html`: generated deployable PWA. Never edit by hand.
- `sw.js`: hand-maintained service-worker cache list. `build.py` only regex-replaces the cache-name constant inside it; the file itself is not regenerated. Never hand-edit the cache version string.
- `manifest.webmanifest`, `icon-180.png`, `icon-192.png`, `icon-512.png`: PWA metadata/assets.
- `poker-settle.html`: frozen legacy artifact. Do not edit.
- `tests/*.test.cjs`: Node built-in tests run against source slices with `vm` (228 tests across 20 files).
- `tools/local-state-to-sql.js`: offline converter, `poker-settle-v1` export → Postgres inserts. Not part of the app; excluded from the Vercel deploy via `.vercelignore`.
- `docs/backend/`: portable backend artifacts (platform decision, schema, RLS, migration plan, frontend seam) — see `docs/backend-readiness.md` for the narrative summary.
- `docs/superpowers/`: historical design/spec/plan notes; useful context, not runtime code.
- `archive/all-in-cash/`: unrelated ignored prototype; do not use it as a source.

## Architecture contract

Keep one source of truth: the `state` object in `kupa-sgura.html`. The UI route is `appView` (`games | game | settle | profile | group`); persisted game phase is `state.phase` (`active | settlement | closed`). `games` is the home dashboard. `game`, `settle`, and `group` (a single group's own page, selected by the UI-only `currentGroupId`) are contextual screens. Only final `סגור שולחן` closes the game, creates history/debts, and returns to Games (or, for a group game, to that group's page).

The current app is local/demo storage with optional Claude artifact document sync. LocalStorage keys are intentionally legacy-named: `poker-settle-v1`, `poker-settle-me`, `poker-settle-theme`, `poker-settle-contact`, and `poker-settle-profile-debts-seen`. Do not add another state store or new localStorage keys for UI-only state. `state` also carries `groups`, `groupMembers`, `invites`, and `friendships` — all pure data contracts (JSDoc typedefs at the top of `// ---------- groups domain (pure) ----------`), normalized/saved/synced through the same `normalize()`/`save()`/`remoteBody()` path as everything else.

For the Games dashboard, `getActiveGameSummaries(gameState, groups)` is the only adapter the active-game UI consumes. `getGroupSummaries(collectionsOf(state), me)` is the real groups adapter (no longer a stub) and is the only shape the group UI consumes; derived data (leaderboards, winners, per-group game summaries) is computed by adapters and never stored. `startedAt` is created only for new games; missing legacy timestamps stay missing. `updatedAt` is shown only when valid. Expanded cards/panels use in-memory Sets and never call `save()`.

## Behavior that must not regress

- Buy-in/rebuy keeps `buyins` and `entryLog` in sync; entry logs contain `id`, ISO `timestamp`, `amount`, `playerId`, and `gameId`.
- Settlement is integer arithmetic: total buy-ins minus cashouts. A normal close is available only at zero. An unbalanced close uses the existing one-second hold/confirmation flow and records `isBalanced` and `balanceDifference` in history.
- Settlement payment toggles remain reversible while the game is open. Final close creates debts only for unpaid transfers; only the creditor name can mark a debt paid. Paid debts stay in data with `paidAt` and must not affect poker balance.
- `סיים משחק` is a cancellable one-second pointer hold and changes only `phase` to `settlement`. `חזור לעריכת המשחק` returns to `active` without losing data.
- The current name-based “login” is not authentication. Do not treat it as a security boundary.
- Claude artifact restrictions mean no `alert`, `confirm`, or form-submit flow; use the existing inline two-step patterns.
- iOS keyboard handling hides the fixed bottom nav while an input is focused.

## Commands

```sh
cd "/Users/dvirazaria/פוקר"
python3 build.py
node --test tests/*.test.cjs
git diff --check
git status --short --branch
```

Release: edit `kupa-sgura.html`, bump `VERSION` in `build.py`, run the build and tests, commit, then `git push origin main`. Vercel URL: <https://poker-tau-pink.vercel.app/>.

Do not commit credentials. The static deploy must contain only the generated app and public assets; `.vercelignore` excludes source-only files, tests, the archive, and the frozen legacy artifact.
