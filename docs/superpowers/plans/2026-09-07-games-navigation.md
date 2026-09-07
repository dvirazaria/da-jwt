# Games Navigation and Active Game Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Games dashboard and active-game phase flow while preserving the existing table, settlement, profile, balance, transfer, payment, and debt logic.

**Architecture:** Keep the single-file app and existing renderers. Rename the current UI route variable to `appView` with `games | game | settle | profile`, add persisted `state.phase` with `active | settlement | closed`, and route between the existing table/settlement DOM through small navigation helpers. The main bottom navigation will expose Games and Profile; table and settlement become contextual screens inside Games.

**Tech Stack:** Vanilla HTML/CSS/JavaScript in `kupa-sgura.html`, generated `index.html`/`sw.js` via `build.py`, Node built-in tests using `node:test` and `vm`.

**Spec:** `docs/superpowers/specs/2026-09-07-games-navigation-design.md`

## Global Constraints

- Preserve the existing Hebrew RTL visual system, CSS variables, typography, spacing, and flat-row components.
- Do not duplicate cashout, settlement, transfer, balance, payment-status, or debt-record logic.
- Do not make a general “התחל משחק” action on the Games dashboard; the supported creation action is “משחק ללא קבוצה”.
- A normal click on “סיים משחק” must not change the game phase; only a continuous one-second hold may enter settlement.
- “סגור שולחן” remains the only final close and must keep its existing balanced/forced-close behavior.
- Edit `kupa-sgura.html` only; regenerate `index.html` and `sw.js` with `build.py`.

## Files and responsibilities

- Modify `kupa-sgura.html`: persisted phase normalization, app navigation, Games dashboard markup/rendering, finish-game long press, return-to-edit action, and existing render visibility wiring.
- Modify `tests/entry-log.test.cjs`: extend normalization, persistence, close, and legacy migration assertions for `phase`.
- Create `tests/games-navigation.test.cjs`: pure route/phase helpers and long-press state tests.
- Modify `DESIGN.md`: document Games dashboard, contextual table/settlement screens, and phase behavior.
- Modify `HANDOFF.md`: update current architecture and version.
- Modify `build.py`: bump the release version.
- Generate `index.html` and `sw.js` with `python3 build.py`.

### Task 1: Add phase normalization and route helpers

**Files:** `kupa-sgura.html`, `tests/games-navigation.test.cjs`, `tests/entry-log.test.cjs`

**Interfaces:**

- `normalizePhase(value, source)` returns `active`, `settlement`, or `closed`.
- `initialAppView(gameState)` returns `games`, `game`, or `settle` based on `gameState.phase` and treats example/legacy empty states as Games.
- `setAppView(view)` updates `appView`, clears transient table/close UI when leaving the corresponding screen, and calls `render()`.

- [x] **Step 1: Write failing tests** for legacy phase migration, explicit phase persistence, initial view selection, and the invariant that a closed state routes to Games.
- [x] **Step 2: Run `node --test tests/games-navigation.test.cjs tests/entry-log.test.cjs`** and confirm the new assertions fail because phase and helpers do not exist.
- [x] **Step 3: Rename the route variable from `mode` to `appView`, add `normalizePhase`, and include `phase` in `normalize` without changing the player/history/debt shape. Use `active` for legacy real states with players, `closed` for demo/empty legacy states, and preserve explicit `settlement`.
  ```js
  function normalizePhase(value, source) {
    if (value === "active" || value === "settlement" || value === "closed") return value;
    if (source && !source.example && Array.isArray(source.players) && source.players.length) return "active";
    return "closed";
  }
  ```
- [x] **Step 4: Initialize `appView = initialAppView(state)` and add `setAppView`; replace direct route assignments in existing handlers with this helper while leaving the existing table and settlement render branches intact.
- [x] **Step 5: Run the focused tests and then the complete existing suite; expected result is all existing tests plus the new phase tests passing.
- [x] **Step 6: Commit `feat: add persisted game phases and app views`**.

### Task 2: Replace primary table/settlement tabs with the Games dashboard

**Files:** `kupa-sgura.html`, `tests/games-navigation.test.cjs`

**Interfaces:**

- `renderGamesDashboard()` renders active-game actions, group placeholder, “צור קבוצה”, and “משחק ללא קבוצה”.
- `startUngroupedGame()` creates a new game with `phase: "active"`, preserves `history`/`debts`, saves, and routes to `game`.
- `continueCurrentGame()` routes active games to `game` and settlement games to `settle`.

- [x] **Step 1: Write failing DOM/string tests** for a Games section, the absence of primary “שולחן”/“חישוב” navigation controls, dashboard labels, and the fact that no active game does not render table rows.
- [x] **Step 2: Run the focused tests and confirm they fail against the current three-tab markup.
- [x] **Step 3: Replace the primary nav buttons with Games and Profile buttons; add a hidden `gamesHome` section and render its dashboard from the persisted phase. Keep table rows/results/profile DOM in place for reuse.
- [x] **Step 4: Implement `startUngroupedGame` and `continueCurrentGame`; render a disabled/subdued group creation placeholder because group creation is explicitly out of scope, and make “משחק ללא קבוצה” the only active creation CTA.
  ```js
  function startUngroupedGame() {
    state = { example: false, phase: "active", gameId: newId(), players: [],
      history: state.history, debts: state.debts, settlementStatuses: {},
      groupId: null, updatedAt: state.updatedAt };
    save();
    setAppView("game");
  }
  ```
- [x] **Step 5: Update `render`/`renderDerived` visibility so Games hides add-player rows, table rows, warnings, and settlement results, while game/settle keep their current behavior.
- [x] **Step 6: Run focused and full tests and inspect the dashboard at a no-game state and an active-game state.
- [x] **Step 7: Commit `feat: add Games dashboard navigation`.

### Task 3: Add active-game finish hold and settlement return flow

**Files:** `kupa-sgura.html`, `tests/games-navigation.test.cjs`

**Interfaces:**

- `FINISH_GAME_HOLD_MS` is `1000`.
- `beginFinishGameHold(event)`, `endFinishGameHold(event)`, and `clearFinishGameHold()` manage a cancellable pointer hold with progress class.
- `finishGame()` sets `state.phase = "settlement"`, saves, and routes to `settle` without changing history, players, debts, or settlement statuses.
- `returnToGameEdit()` sets `state.phase = "active"`, saves, and routes to `game`.

- [x] **Step 1: Write failing helper tests** for one-second duration, cancellation before completion, and `finishGame` preserving the current game data while changing only phase/view.
- [x] **Step 2: Run the focused tests and confirm the expected failures.**
- [x] **Step 3: Add the “סיים משחק” button to the existing table view with fixed-width progress feedback using the established close-button motion language. Attach pointer down/up/cancel/lost-capture handlers; normal click has no completion path.
- [x] **Step 4: Implement `finishGame` and add a quiet secondary “חזור לעריכת המשחק” action to the existing settlement view. Keep all cashout and settlement calculations in `renderDerived`.
  ```js
  function finishGame() {
    state.phase = "settlement";
    save();
    setAppView("settle");
  }
  function returnToGameEdit() {
    state.phase = "active";
    save();
    setAppView("game");
  }
  ```
- [x] **Step 5: Ensure edits in active mode call `save()` as before and that returning to settlement recomputes `settle()` and transfer payment toggles from current state.
- [x] **Step 6: Run focused/full tests and manually verify short press, successful hold, return-to-edit, rebuy, and second finish.
- [x] **Step 7: Commit `feat: add active game finish and settlement return flow`.

### Task 4: Final close, refresh routing, and sync integration

**Files:** `kupa-sgura.html`, `tests/entry-log.test.cjs`, `tests/games-navigation.test.cjs`

- [x] **Step 1: Write failing tests** for `phase` in local normalization, remote body, remote application, final close setting `closed`, and refresh route selection for active/settlement/closed.
- [x] **Step 2: Run the tests and verify failure before changing final-close code.
- [x] **Step 3: Include `phase` in `remoteBody` and `applyRemote`; update `markReal`, reset, and new-game initialization to set explicit phase values.
- [x] **Step 4: Update `finishCloseTable` only at its existing finalization point: build history/debts exactly as before, set `state.phase = "closed"`, clear current players/settlement statuses, save, and route to Games. Do not alter balance or forced-close calculations.
  ```js
  state.phase = "closed";
  state.players = [];
  state.gameId = newId();
  state.settlementStatuses = {};
  save();
  setAppView("games");
  ```
- [x] **Step 5: Add guards so closed/demo dashboard states cannot expose ordinary table editing controls until “משחק ללא קבוצה” creates a new active state.
- [x] **Step 6: Run all tests and verify localStorage/remote payload snapshots include phase without dropping existing fields.
- [x] **Step 7: Commit `feat: persist game phase through close and sync`.

### Task 5: Documentation, generated build, QA, and deployment

**Files:** `DESIGN.md`, `HANDOFF.md`, `build.py`, generated `index.html`, `sw.js`

- [x] **Step 1: Update DESIGN.md with the Games dashboard and contextual active/settlement navigation, including the one-second hold behavior.
- [x] **Step 2: Update HANDOFF.md with `state.phase`, `appView`, dashboard scope, and the new release version.
- [x] **Step 3: Bump `VERSION` in `build.py` and run `python3 build.py`.
- [x] **Step 4: Run `git diff --check`, JavaScript syntax checks, and `node --test tests/entry-log.test.cjs tests/profile-tabs.test.cjs tests/games-navigation.test.cjs`.
- [x] **Step 5: Run the local app and manually verify: no-game dashboard, ungrouped start, normal/long press finish, settlement return, rebuy recalculation, final balanced close, forced unbalanced close, closed dashboard, and refresh in active/settlement.
- [x] **Step 6: Commit the docs/build QA changes, push `main`, wait for Vercel success, and verify the live version and route behavior.
