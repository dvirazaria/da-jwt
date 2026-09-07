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

test('Games dashboard centers its visible content while preserving RTL text direction', () => {
  assert.match(html, /document\.body\.classList\.toggle\("games-view", appView === "games"\)/);
  assert.match(html, /\.games-view header \{ text-align: center; \}/);
  assert.match(html, /\.games-home \{[^}]*text-align: center;/s);
  assert.match(html, /\.games-card \{[^}]*align-items: center;[^}]*text-align: center;/s);
  assert.match(html, /direction: rtl;/);
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
  vm.runInContext('function save() { saved += 1; } function setAppView(next) { view = next; }' + html.slice(start, end), context);
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
  assert.match(html, /state = \{\s*\n\s*example: false, phase: "closed"/);
  assert.match(html, /save\(\);\s*\n\s*setAppView\("games"\);/);
});
