const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + 1);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end >= 0, `missing ${endMarker}`);
  return html.slice(start, end);
}

test('legacy and explicit game phases normalize to active, settlement, or closed', () => {
  const source = sourceBetween('  function normalizePhase', '  function normalizeDebt');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(vm.runInContext(`normalizePhase('active', {players: []})`, context), 'active');
  assert.equal(vm.runInContext(`normalizePhase('settlement', {players: []})`, context), 'settlement');
  assert.equal(vm.runInContext(`normalizePhase('closed', {players: [{name: 'א'}]})`, context), 'closed');
  assert.equal(vm.runInContext(`normalizePhase('', {example: false, players: [{name: 'א'}]})`, context), 'active');
  assert.equal(vm.runInContext(`normalizePhase('', {example: false, players: []})`, context), 'closed');
  assert.equal(vm.runInContext(`normalizePhase('', {example: true, players: [{name: 'א'}]})`, context), 'closed');
});

test('initial app view follows the persisted phase and does not open an empty table', () => {
  const source = sourceBetween('  function initialAppView', '  function normalizeDebt');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(vm.runInContext(`initialAppView({phase:'active', example:false, players:[]})`, context), 'game');
  assert.equal(vm.runInContext(`initialAppView({phase:'settlement', example:false, players:[{}]})`, context), 'settle');
  assert.equal(vm.runInContext(`initialAppView({phase:'closed', example:false, players:[]})`, context), 'games');
  assert.equal(vm.runInContext(`initialAppView({phase:'active', example:true, players:[{}]})`, context), 'games');
});

test('the persisted state carries an explicit phase', () => {
  assert.match(html, /phase:\s*normalizePhase\(/);
  assert.match(html, /phase:\s*state\.phase/);
  assert.match(html, /phase:\s*data\.phase/);
});

test('primary navigation exposes Games and Profile, while table and settlement remain internal screens', () => {
  assert.match(html, /id="gamesHome"/);
  assert.match(html, /id="modeGames"/);
  assert.doesNotMatch(html, /id="modeGame"/);
  assert.doesNotMatch(html, /id="modeSettle"/);
  assert.match(html, /משחקים/);
  assert.match(html, /משחק ללא קבוצה/);
  assert.match(html, /צור קבוצה/);
  assert.match(html, /כנס לשולחן/);
});

test('dashboard creation and resume actions have dedicated handlers', () => {
  assert.match(html, /function renderGamesDashboard\(\)/);
  assert.match(html, /function startUngroupedGame\(\)/);
  assert.match(html, /function continueCurrentGame\(\)/);
  assert.match(html, /setAppView\("game"\)/);
});

// getActiveGameSummaries delegates "is there an open game" to isGameOpen (pure section):
// an empty table is not a game, so the adapter's slice is loaded together with that predicate.
const openGameSource = sourceBetween('  function hasOpenPhase(currentGame) {', '  // The engine has one current-game slot');

test('active game UI data is produced through ActiveGameSummary', () => {
  const source = sourceBetween('  function getActiveGameSummaries', '  function formatGameTime');
  const context = vm.createContext({});
  vm.runInContext(openGameSource + source, context);
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

test('active game adapter hides demo, closed, empty, and invalid optional times', () => {
  const source = sourceBetween('  function getActiveGameSummaries', '  function formatGameTime');
  const context = vm.createContext({});
  vm.runInContext(openGameSource + source, context);
  assert.equal(vm.runInContext(`getActiveGameSummaries({example:true, phase:'active', players:[{id:'p1', name:'א', buyins:[50]}]}).length`, context), 0);
  assert.equal(vm.runInContext(`getActiveGameSummaries({example:false, phase:'closed', players:[{id:'p1', name:'א', buyins:[50]}]}).length`, context), 0);
  // an empty table is not a game — the dashboard must not show it
  assert.equal(vm.runInContext(`getActiveGameSummaries({example:false, phase:'active', gameId:'g1', players:[]}).length`, context), 0);
  assert.equal(vm.runInContext(`getActiveGameSummaries({example:false, phase:'active', gameId:'g1', players:[{id:'p1', name:'א', buyins:[50]}]})[0].startedAt`, context), null);
  assert.equal(vm.runInContext(`getActiveGameSummaries({example:false, phase:'active', gameId:'g1', updatedAt:'invalid', players:[{id:'p1', name:'א', buyins:[50]}]})[0].updatedAt`, context), null);
});

test('startedAt travels through normalization and remote persistence without legacy fabrication', () => {
  assert.match(html, /startedAt:\s*typeof s\.startedAt === "string" \? s\.startedAt : null/);
  assert.match(html, /startedAt:\s*state\.startedAt \|\| null/);
  assert.match(html, /startedAt:\s*typeof data\.startedAt === "string" \? data\.startedAt : null/);
  const creation = sourceBetween('  function startUngroupedGame', '  function continueCurrentGame');
  assert.match(creation, /startedAt:\s*new Date\(\)\.toISOString\(\)/);
});

test('Games dashboard is composed from three modular sections', () => {
  assert.match(html, /function renderQuickActions\(parent\)/);
  // Task 15: renderActiveGamesSection/renderGroupsSection gain an `enterStagger` argument that
  // gates the dashboard's card entrance animation (see the dedicated motion test below).
  assert.match(html, /function renderActiveGamesSection\(parent, summaries, enterStagger\)/);
  assert.match(html, /function renderActiveGameCard\(summary, actions\)/);
  assert.match(html, /function renderGroupsSection\(parent, groups, enterStagger\)/);
  assert.match(html, /function renderGroupCard\(group, actions\)/);
  assert.match(html, /renderQuickActions\(inner\)/);
  // Task 9: getActiveGameSummaries gains an optional `groups` argument for title resolution;
  // the dashboard call site passes state.groups.
  assert.match(html, /renderActiveGamesSection\(inner, getActiveGameSummaries\(state, state\.groups\), enterStagger\)/);
  assert.match(html, /renderGroupsSection\(inner, getGroupSummaries\(collectionsOf\(state\), me\), enterStagger\)/);
  assert.match(html, /אין משחקים פעילים כרגע/);
  assert.match(html, /אין לך קבוצות עדיין/);
  // Task 3 enables the create-group quick action; it's no longer a "coming soon" placeholder.
  assert.doesNotMatch(html, /בקרוב/);
  assert.match(html, /toggleCreateGroupPanel/);
});

test('active game card renderer never reads game state directly', () => {
  const source = sourceBetween('  function renderActiveGameCard', '  function renderActiveGamesSection');
  assert.doesNotMatch(source, /\bstate\b/);
  assert.doesNotMatch(source, /\btotals\(/);
});

test('card expansion is UI-only and is not persisted', () => {
  assert.match(html, /const expandedGameCards = new Set\(\)/);
  assert.match(html, /const expandedGroupCards = new Set\(\)/);
  // Scoped to the dashboard card renderers: the group page below them legitimately saves
  // (D8's "remove a group I left from this device"), but no card expand/collapse does.
  const dashboardSource = sourceBetween('  function renderActiveGameCard', '  function renderGroupHeader(summary) {');
  assert.doesNotMatch(dashboardSource, /\bsave\(\)/);
});

test('groups adapter has no mock data', () => {
  const source = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');
  const context = vm.createContext({ newId: () => 'stub-id' });
  vm.runInContext(source, context);
  assert.deepEqual(Array.from(vm.runInContext('getGroupSummaries({groups:[]}, null)', context)), []);
});

test('player names are capped at four with a remaining count', () => {
  const source = sourceBetween('  function formatPlayerNames', '  function renderQuickActions');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(vm.runInContext(`formatPlayerNames(['א','ב','ג','ד'])`, context), 'א, ב, ג, ד');
  assert.equal(vm.runInContext(`formatPlayerNames(['א','ב','ג','ד','ה','ו'])`, context), 'א, ב, ג, ד +2');
  assert.equal(vm.runInContext(`formatPlayerNames([])`, context), 'אין שחקנים עדיין');
});

test('Games dashboard centers its visible content while preserving RTL text direction', () => {
  assert.match(html, /document\.body\.classList\.toggle\("games-view", appView === "games"\)/);
  assert.match(html, /\.games-view header \{ text-align: center; \}/);
  assert.match(html, /\.games-home \{[^}]*text-align: center;/s);
  assert.match(html, /\.games-active-card, \.games-group-card \{[^}]*text-align: center;/s);
  assert.match(html, /\.games-card-actions \{[^}]*justify-content: center;/s);
  assert.match(html, /direction: rtl;/);
});

test('the settlement view also clears the header corner controls, like the game view (D1)', () => {
  assert.match(html, /document\.body\.classList\.toggle\("settle-view", appView === "settle"\)/);
  assert.match(html, /\.game-view \.wrap > header, \.settle-view \.wrap > header \{ min-height: 64px; \}/);
});

test('.player-heading is a wrapping flex row so "יציאה" sits beside "פירוט כניסות" instead of under it (D2)', () => {
  const idx = html.indexOf('.player-heading {');
  assert.ok(idx >= 0, '.player-heading base rule not found');
  const rule = html.slice(idx, html.indexOf('}', idx));
  assert.match(rule, /display:\s*flex/);
  assert.match(rule, /flex-wrap:\s*wrap/);
  assert.match(html, /\.player-heading \.pname \{ flex-basis: 100%; \}/);
});

test('active game finish is a one-second hold and settlement can return to editing', () => {
  assert.match(html, /const FINISH_GAME_HOLD_MS = 1000;/);
  assert.match(html, /id="finishGameBtn"/);
  assert.match(html, /סיים משחק/);
  assert.match(html, /function finishGame\(\)/);
  assert.match(html, /state\.phase = "settlement"/);
  assert.match(html, /id="returnToGameBtn"/);
  assert.match(html, /חזור לעריכת המשחק/);
  assert.match(html, /function returnToGameEdit\(\)/);
  assert.match(html, /state\.phase = "active"/);
});

test('finish and return actions preserve the current game data', () => {
  const start = html.indexOf('  function finishGame()');
  const end = html.indexOf('  function clearCloseHold()', start);
  const context = vm.createContext({
    state: { example: false, phase: 'active', gameId: 'g1', players: [{id: 'p1', buyins: [50]}], history: [] },
    saved: 0,
    view: null,
  });
  vm.runInContext('function save() { saved += 1; } function setAppView(next) { view = next; }' + openGameSource + html.slice(start, end), context);
  vm.runInContext('finishGame()', context);
  assert.equal(vm.runInContext('state.phase', context), 'settlement');
  assert.equal(vm.runInContext('view', context), 'settle');
  assert.equal(vm.runInContext('saved', context), 1);
  assert.equal(vm.runInContext('state.players[0].buyins[0]', context), 50);
  vm.runInContext('returnToGameEdit()', context);
  assert.equal(vm.runInContext('state.phase', context), 'active');
  assert.equal(vm.runInContext('view', context), 'game');
  assert.equal(vm.runInContext('saved', context), 2);
});

test('final close archives the game and returns to the Games dashboard', () => {
  assert.match(html, /state\.phase = "closed";/);
  assert.match(html, /state\.players = \[\];/);
  assert.match(html, /setAppView\("games"\);/);
});

test('resetting a game also returns to the Games dashboard', () => {
  assert.match(html, /state = newCurrentGame\(state, \{ phase: "closed" \}\);/);
  assert.match(html, /save\(\);\s*\n\s*setAppView\("games"\);/);
});
