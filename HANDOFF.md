# HANDOFF — "סוגרים קופה" (poker cash-game settlement PWA)

Context file for any coding agent picking up this project.

## What this is
A Hebrew, RTL, mobile-first PWA for settling home poker cash games:
players + buy-ins on a "שולחן" tab, chip counts and a minimal-transfers
who-pays-whom on a "חישוב" tab, per-player record on a "פרופיל" tab.
Deployed on Vercel (static, auto-deploys from `main`), installable to the
home screen. Version 25.

## Files
- `kupa-sgura.html` — THE app. Single file: CSS + HTML + one IIFE of vanilla JS.
  Sections are commented: state, server sync, render, login, profile, settings, boot.
- `index.html` — GENERATED standalone PWA wrapper. Never edit by hand.
- `build.py` — release script. Single source of the version number: stamps it
  into the app + `sw.js` cache name and regenerates `index.html`. Run on every release.
- `sw.js`, `manifest.webmanifest`, `icon-192/512.png` — PWA assets.
- `poker-settle.html` — FROZEN legacy version for an old artifact URL. Do not edit.

## Design system (deliberate, keep it)
Monochrome dark (default) + light theme via `:root[data-theme="light"]` tokens.
Single accent: turquoise `--accent`. Red `--bad` only for warnings/losses.
No boxes-in-boxes: flat rows with hairline separators, typography-led.
Floating capsule bottom tab bar (active tab = filled pill with label).
All animations respect `prefers-reduced-motion`.

## Data model (current, local/demo)
`state = { example, gameId, players: [{id, name, buyins:[], entryLog:[], cashout}], history: [...], updatedAt }`
- Each entryLog item is {id, timestamp, amount, playerId, gameId}; timestamp is ISO UTC,
  displayed as local HH:mm. Legacy entries use null time (shown as —), never invented times.
  Numeric buyins stay unchanged for calculation compatibility. Add/undo must update both arrays.
  Both localStorage and the existing Claude document sync persist the log and gameId.
  Closing archives a detached entryLog per player and rotates gameId; reset also rotates it.
  Inline “פירוט כניסות” is current-game only; its expanded state is UI-only.
  Table balance is an integer `buy-ins - cashouts`. A normal close is enabled only at zero.
  Forced unbalanced closes require a three-second hold on the blocked main close button,
  then an inline confirmation, and archive `isBalanced: false` plus `balanceDifference`
  in the history record. Positive difference means money is missing; negative means there
  is an excess.
- Regression checks: `node --test tests/entry-log.test.cjs`.
- localStorage key `poker-settle-v1` (legacy prefix kept for continuity;
  also `poker-settle-me`, `-theme`, `-contact`).
- Optional realtime sync via `window.claude.use("db")` (works only when
  served as a claude.ai artifact; on Vercel it's localStorage only).
  Whole-state doc, last-writer-wins, `updatedAt` guards stale overwrites,
  snapshot bodies are frozen (must deep-clone). This entire sync layer is
  meant to be REPLACED by a real backend.

## Hard-won gotchas (do not regress)
- The claude.ai artifact iframe blocks `form submit`, `window.confirm`,
  `alert` — use click handlers and the existing two-step arm/confirm pattern.
- iOS PWA: keyboard drags fixed-bottom elements → the tab bar hides on
  input focus (`.kb-open`); safe-area insets are handled in `.wrap`/tab bar.
- Buy-in confirm is a two-tap flow with an animated close; re-entrant
  confirms are dropped via `menuClosing` (prevents double buy-ins).
- Editing example data wipes it (`markReal()` returns true = stop the action).
- Duplicate player names are rejected (name is the identity key everywhere).

## Next milestone (the reason for this handoff): real users
Goal: each player signs in (phone/Google), joins a shared table from their
own phone, adds their own buy-ins; closing the table writes an immutable
per-player record; append-only audit log of every action (who/when).
Agreed plan: Supabase free tier (auth + Postgres + RLS + realtime):
- tables: profiles, tables, table_players, buyins (append-only), games (closed),
  game_results, audit_log (insert-only RLS, no update/delete policies).
- RLS: a player writes only their own buy-ins; only the table owner closes.
- Replace the localStorage/artifact-db sync layer with Supabase client calls;
  keep the UI and flows as-is.
- NEVER commit keys/secrets (this repo already had one leaked+rotated
  Google service-account key — history still contains the dead key).
- The current "login" screen (name only) becomes the real auth screen;
  `me`/contact fields in settings were built as placeholders for this.

## Release process
1. Edit `kupa-sgura.html` only.
2. Bump `VERSION` in `build.py`, run `python3 build.py`.
3. Commit + push `main` → Vercel auto-deploys. `.vercelignore` keeps
   non-app files out of the public deployment.
4. User preference: after a completed and verified work round, commit and push
   the intentional changes to `main`, then wait for and verify the Vercel deployment.
