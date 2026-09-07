# Games Dashboard Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** להפוך את מסך ״משחקים״ ל־dashboard בן שלושה אזורים, עם כרטיסי משחק פעיל שמקבלים את כל נתוניהם דרך `ActiveGameSummary`, הרחבה מקומית וכרטיס קבוצה מוכן לנתוני אמת עתידיים.

**Architecture:** מקור האמת נשאר אובייקט `state` היחיד. פונקציית adapter טהורה ממירה אותו למערך `ActiveGameSummary`, וה־renderers מקבלים summaries ו־callbacks בלבד. מצבי הרחבה נשמרים ב־`Set` בזיכרון, ו־`getGroupSummaries()` מחזיר מערך ריק עד שיהיה מקור נתונים אמיתי.

**Tech Stack:** HTML/CSS/JavaScript בקובץ יחיד, Node.js built-in test runner, Python release builder, PWA service worker.

**Spec:** `docs/superpowers/specs/2026-09-07-games-dashboard-foundation-design.md`

## Global Constraints

- קוד המקור של הממשק נשאר ב־`kupa-sgura.html`; אין פיצול לקבצי runtime חדשים.
- `ActiveGameSummary` הוא חוזה הנתונים היחיד שה־UI של משחקים פעילים צורך.
- אין backend, נתוני דמה, localStorage חדש או game state מקביל.
- `startedAt` נוצר רק עבור משחק חדש; ערך legacy חסר נשאר חסר.
- `updatedAt` מוצג רק כאשר קיים timestamp תקין בפועל.
- `getGroupSummaries()` מחזיר `[]` בלבד.
- כפתור ״+ צור קבוצה״ מושבת ומסומן ״בקרוב״.
- פתיחת כרטיסים היא UI-only ואינה קוראת ל־`save()`.
- `index.html` ו־`sw.js` נוצרים באמצעות `python3 build.py` בלבד.

---

### Task 1: ActiveGameSummary and timestamps

**Files:**
- Modify: `tests/games-navigation.test.cjs`
- Modify: `kupa-sgura.html`

**Interfaces:**
- Consumes: `state` הקיים, `normalize(s)`, `remoteBody()`, `applyRemote(data)`, `startUngroupedGame()`.
- Produces: `getActiveGameSummaries(gameState) -> ActiveGameSummary[]`, ושדה `startedAt: string | null` בתוך snapshot קיים.

- [x] **Step 1: Write failing tests for the adapter and timestamp persistence**

הוסף בדיקות שמחלצות את `getActiveGameSummaries()` ומעבירות להן state מפורש:

```js
test('active game UI data is produced only through ActiveGameSummary', () => {
  const source = sourceBetween('  function getActiveGameSummaries', '  function getGroupSummaries');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const summary = vm.runInContext(`getActiveGameSummaries({
    example:false, phase:'active', gameId:'g1', groupId:null,
    startedAt:'2026-09-07T16:00:00.000Z', updatedAt:'2026-09-07T17:00:00.000Z',
    players:[
      {id:'p1', name:'דביר', buyins:[50,100]},
      {id:'p2', name:'רועי', buyins:[50]}
    ]
  })[0]`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    gameId:'g1', title:'משחק ללא קבוצה', phase:'active', playerCount:2,
    playerNames:['דביר','רועי'],
    players:[
      {id:'p1', name:'דביר', buyinTotal:150, entryCount:2},
      {id:'p2', name:'רועי', buyinTotal:50, entryCount:1}
    ],
    potSize:200, totalEntries:3,
    startedAt:'2026-09-07T16:00:00.000Z', updatedAt:'2026-09-07T17:00:00.000Z'
  });
});

test('active game adapter hides closed, demo, and invalid optional times', () => {
  const source = sourceBetween('  function getActiveGameSummaries', '  function getGroupSummaries');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(vm.runInContext(`getActiveGameSummaries({example:true, phase:'active', players:[]}).length`, context), 0);
  assert.equal(vm.runInContext(`getActiveGameSummaries({example:false, phase:'closed', players:[]}).length`, context), 0);
  assert.equal(vm.runInContext(`getActiveGameSummaries({example:false, phase:'active', gameId:'g1', players:[]})[0].startedAt`, context), null);
  assert.equal(vm.runInContext(`getActiveGameSummaries({example:false, phase:'active', gameId:'g1', updatedAt:'invalid', players:[]})[0].updatedAt`, context), null);
});

test('startedAt travels through normalization and remote persistence without legacy fabrication', () => {
  assert.match(html, /startedAt:\s*typeof s\.startedAt === "string" \? s\.startedAt : null/);
  assert.match(html, /startedAt:\s*state\.startedAt \|\| null/);
  assert.match(html, /startedAt:\s*typeof data\.startedAt === "string" \? data\.startedAt : null/);
  assert.match(html, /startedAt:\s*new Date\(\)\.toISOString\(\)/);
});
```

- [x] **Step 2: Run the focused tests and verify failure**

Run: `node --test tests/games-navigation.test.cjs`

Expected: FAIL because `getActiveGameSummaries` and persisted `startedAt` do not exist.

- [x] **Step 3: Implement timestamp transport and the pure adapter**

ב־`normalize()` הוסף:

```js
startedAt: typeof s.startedAt === "string" ? s.startedAt : null,
```

העבר `startedAt` דרך `remoteBody()` ו־`applyRemote()`, וכלול אותו בהשוואת snapshots כדי ששינוי בו לא ייבלע. ב־`startUngroupedGame()` ובכל נתיב שיוצר `gameId` חדש הוסף timestamp אמיתי:

```js
startedAt: new Date().toISOString(),
```

ממש את ה־adapter כפונקציה טהורה שאינה קוראת ל־`state`, `totals()` או DOM:

```js
function getActiveGameSummaries(gameState) {
  if (!gameState || gameState.example || (gameState.phase !== "active" && gameState.phase !== "settlement")) return [];
  const validTime = value => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
  const players = (Array.isArray(gameState.players) ? gameState.players : []).map(player => {
    const buyins = Array.isArray(player.buyins) ? player.buyins : [];
    return {
      id: String(player.id || ""),
      name: String(player.name || ""),
      buyinTotal: buyins.reduce((total, amount) => total + Math.round(Number(amount) || 0), 0),
      entryCount: buyins.length,
    };
  });
  return [{
    gameId: String(gameState.gameId || ""),
    title: gameState.groupId ? null : "משחק ללא קבוצה",
    phase: gameState.phase,
    playerCount: players.length,
    playerNames: players.map(player => player.name),
    players,
    potSize: players.reduce((total, player) => total + player.buyinTotal, 0),
    totalEntries: players.reduce((total, player) => total + player.entryCount, 0),
    startedAt: validTime(gameState.startedAt),
    updatedAt: validTime(gameState.updatedAt),
  }];
}
```

- [x] **Step 4: Run focused tests and verify pass**

Run: `node --test tests/games-navigation.test.cjs`

Expected: all Games tests PASS.

- [x] **Step 5: Commit the data layer**

```bash
git add kupa-sgura.html tests/games-navigation.test.cjs
git commit -m "feat: add active game summary adapter"
```

---

### Task 2: Modular Games dashboard UI

**Files:**
- Modify: `tests/games-navigation.test.cjs`
- Modify: `kupa-sgura.html`

**Interfaces:**
- Consumes: `getActiveGameSummaries(state)`, `startUngroupedGame()`, `continueCurrentGame()`.
- Produces: `getGroupSummaries()`, `renderQuickActions(parent)`, `renderActiveGamesSection(parent, summaries)`, `renderActiveGameCard(summary, actions)`, `renderGroupsSection(parent, groups)`, `renderGroupCard(group, actions)`, `enterActiveGame(gameId)`.

- [x] **Step 1: Write failing structure and isolation tests**

הוסף בדיקות שמוודאות את שלושת האזורים, נוסחי המצבים הריקים והפרדת ה־renderer מ־state:

```js
test('Games dashboard is composed from three modular sections', () => {
  assert.match(html, /function renderQuickActions\(parent\)/);
  assert.match(html, /function renderActiveGamesSection\(parent, summaries\)/);
  assert.match(html, /function renderActiveGameCard\(summary, actions\)/);
  assert.match(html, /function renderGroupsSection\(parent, groups\)/);
  assert.match(html, /function renderGroupCard\(group, actions\)/);
  assert.match(html, /אין משחקים פעילים כרגע/);
  assert.match(html, /אין לך קבוצות עדיין/);
  assert.match(html, /בקרוב/);
});

test('active game card renderer never reads game state directly', () => {
  const source = sourceBetween('  function renderActiveGameCard', '  function renderActiveGamesSection');
  assert.doesNotMatch(source, /\bstate\b/);
  assert.doesNotMatch(source, /\btotals\(/);
});

test('card expansion is UI-only and is not persisted', () => {
  assert.match(html, /const expandedGameCards = new Set\(\)/);
  assert.match(html, /const expandedGroupCards = new Set\(\)/);
  const dashboardSource = sourceBetween('  function getActiveGameSummaries', '  function render\(\)');
  assert.doesNotMatch(dashboardSource, /\bsave\(\)/);
});

test('groups adapter has no mock data', () => {
  const source = sourceBetween('  function getGroupSummaries', '  function formatGameTime');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.deepEqual(Array.from(vm.runInContext('getGroupSummaries()', context)), []);
});
```

- [x] **Step 2: Run the focused tests and verify failure**

Run: `node --test tests/games-navigation.test.cjs`

Expected: FAIL because the modular renderers, UI-only sets and new copy do not exist.

- [x] **Step 3: Add UI-only state and helpers**

ליד `expandedEntries` הוסף:

```js
const expandedGameCards = new Set();
const expandedGroupCards = new Set();
```

הוסף helpers להצגת עד ארבעה שמות עם `+N`, ולהצגת שעה מקומית רק עבור timestamp שה־adapter כבר אימת. הוסף:

```js
function getGroupSummaries() { return []; }
function enterActiveGame(gameId) {
  if (String(state.gameId || "") !== String(gameId || "")) return;
  continueCurrentGame();
}
```

- [x] **Step 4: Replace the monolithic dashboard renderer**

`renderGamesDashboard()` ירכיב בלבד:

```js
function renderGamesDashboard() {
  const box = document.getElementById("gamesHome");
  box.innerHTML = "";
  const inner = el("div", "games-home-in");
  inner.appendChild(el("h2", "games-home-title", "משחקים"));
  inner.appendChild(el("p", "games-home-lead", "המשחקים הפעילים והקבוצות שלך במקום אחד."));
  renderQuickActions(inner);
  renderActiveGamesSection(inner, getActiveGameSummaries(state));
  renderGroupsSection(inner, getGroupSummaries());
  box.appendChild(inner);
}
```

`renderQuickActions()` יציג באותה שורה ״משחק ללא קבוצה״ ו־״+ צור קבוצה״. הכפתור השני יהיה `disabled`, עם `aria-disabled="true"` ותווית ״בקרוב״, ללא handler.

`renderActiveGameCard(summary, actions)` יציג status לפי `summary.phase`, כותרת אם קיימת, שמות/מספר שחקנים, זמן התחלה אם קיים, ״כנס לשולחן״ ו־״הרחב״. במצב הפתוח הוא יציג מכל `summary.players` רק שם, `buyinTotal` ו־`entryCount`, ולאחריהם `potSize`, `totalEntries`, `startedAt` ו־`updatedAt` כאשר קיימים.

`renderGroupCard(group, actions)` יקבל summary חיצוני, יציג avatar URL או אות ראשונה, שם, מספר חברים ואינדיקציית משחק פעיל, וירנדר פרטים אופציונליים רק אם הם קיימים. `renderGroupsSection()` לא יקרא לו כאשר `getGroupSummaries()` ריק.

- [x] **Step 5: Add compact responsive styling**

החלף את CSS של Games dashboard במחלקות ייעודיות:

```css
.games-quick-actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.games-quick-action { min-height:46px; border:1px solid var(--line); border-radius:999px; }
.games-quick-action.primary { border-color:var(--accent); color:var(--accent); }
.games-quick-action.coming-soon { color:var(--dim); opacity:.72; cursor:default; }
.games-active-card, .games-group-card { border-bottom:1px solid var(--line); padding:14px 0; }
.games-card-actions { display:flex; justify-content:center; align-items:center; gap:18px; }
.games-card-details { margin-top:10px; }
.games-detail-row { display:flex; justify-content:center; align-items:baseline; gap:8px; }
```

שמור על רוחב `max-width: 380px`, מרכז אופקי, RTL, צבעים, typography ו־radius הקיימים. הוסף focus-visible, חץ שמסתובב לפי `aria-expanded`, והסתרת overflow בהרחבה.

- [x] **Step 6: Run focused and full tests**

Run:

```bash
node --test tests/games-navigation.test.cjs
node --test tests/*.test.cjs
```

Expected: all tests PASS.

- [x] **Step 7: Commit the modular UI**

```bash
git add kupa-sgura.html tests/games-navigation.test.cjs
git commit -m "feat: build modular Games dashboard"
```

---

### Task 3: Release build and browser QA

**Files:**
- Modify: `build.py`
- Generate: `index.html`
- Generate: `sw.js`

**Interfaces:**
- Consumes: completed source and tests from Tasks 1–2.
- Produces: version 38 deployable PWA artifacts.

- [x] **Step 1: Bump and build the release**

שנה ב־`build.py`:

```python
VERSION = 38
```

Run: `python3 build.py`

Expected: `built version 38: kupa-sgura.html, sw.js, index.html`.

- [x] **Step 2: Verify generated artifacts and regression tests**

Run:

```bash
rg -n 'גרסה 38' kupa-sgura.html index.html
rg -n 'const CACHE = "kupa-v38"' sw.js
node --test tests/*.test.cjs
git diff --check
```

Expected: commands exit 0 and all tests PASS. Inspect `git diff --stat` to confirm only the source, tests, builder and generated artifacts changed.

- [x] **Step 3: Perform manual browser QA**

Run a local HTTP server and inspect the app at mobile and desktop widths:

```bash
python3 -m http.server 8765
```

Verify:

- No active game: exact empty copy, both quick actions in one row, create-group visibly marked ״בקרוב״ and disabled.
- Start ungrouped game: table opens, `startedAt` exists in the existing snapshot, no new localStorage key is created.
- Return to Games: active card shows actual players, names, pot and time.
- Toggle expand twice: details open/close, refresh closes the card, game data remains unchanged.
- Settlement phase routes to the existing settlement screen.
- Light/dark themes, narrow mobile width and desktop width have no overflow.
- Browser console has no errors.

- [x] **Step 4: Commit release artifacts**

```bash
git add build.py kupa-sgura.html index.html sw.js tests/games-navigation.test.cjs
git commit -m "chore: build version 38"
```

- [x] **Step 5: Push and verify deployment**

Run:

```bash
git push origin main
```

Wait for Vercel, then verify `https://poker-tau-pink.vercel.app/` serves version 38 and the Games dashboard behavior matches the local QA.
