# Claude handoff — סוגרים קופה

Read [`HANDOFF.md`](HANDOFF.md) and [`DESIGN.md`](DESIGN.md) before making changes. They are the source of truth for architecture, behavior, UX, persistence, and known pitfalls.

## Fast project map

- `kupa-sgura.html`: only runtime source. It contains CSS, HTML, and one vanilla-JS IIFE.
- `build.py`: release builder. It bumps the version in the source, updates the service-worker cache, and regenerates `index.html`.
- `index.html`: generated deployable PWA. Never edit by hand.
- `sw.js`: generated cache file. Never hand-edit the cache version.
- `manifest.webmanifest`, `icon-180.png`, `icon-192.png`, `icon-512.png`: PWA metadata/assets.
- `poker-settle.html`: frozen legacy artifact. Do not edit.
- `tests/*.test.cjs`: Node built-in tests run against source slices with `vm`.
- `docs/superpowers/`: historical design/spec/plan notes; useful context, not runtime code.
- `archive/all-in-cash/`: unrelated ignored prototype; do not use it as a source.

## Architecture contract

Keep one source of truth: the `state` object in `kupa-sgura.html`. The UI route is `appView` (`games | game | settle | profile`); persisted game phase is `state.phase` (`active | settlement | closed`). `games` is the home dashboard. `game` and `settle` are internal screens for the current game. Only final `סגור שולחן` closes the game, creates history/debts, and returns to Games.

The current app is local/demo storage with optional Claude artifact document sync. LocalStorage keys are intentionally legacy-named: `poker-settle-v1`, `poker-settle-me`, `poker-settle-theme`, `poker-settle-contact`, and `poker-settle-profile-debts-seen`. Do not add another state store or new localStorage keys for UI-only state.

For the Games dashboard, `getActiveGameSummaries(gameState)` is the only adapter the active-game UI consumes. `getGroupSummaries()` returns `[]` until a real groups data source exists. `startedAt` is created only for new games; missing legacy timestamps stay missing. `updatedAt` is shown only when valid. Expanded cards use in-memory Sets and never call `save()`.

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
