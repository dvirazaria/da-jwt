// "An empty table is not a game": a table opened from "משחק ללא קבוצה" with nobody seated is not
// an active game — the dashboard hides it, it does not block a group game, it is discarded when
// the user leaves it, and the ungrouped quick action is disabled while a real game is open (it
// would otherwise replace that game). Same vm-slice/regex pattern as the sibling suites.
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
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');
const adapterSource = sourceBetween('  function getActiveGameSummaries', '  function formatGameTime');
function loadPure(extra) {
  const context = vm.createContext({ newId: () => 'stub-id', ...(extra || {}) });
  vm.runInContext(pureSource + adapterSource, context);
  return context;
}
const onePlayer = [{ id: 'p1', name: 'דביר', buyins: [50] }];

// ---------- isGameOpen / isEmptyOpenGame truth table ----------

test('isGameOpen is true only for a real active/settlement game with at least one player', () => {
  const context = loadPure();
  const cases = [
    [{ example: false, phase: 'active', players: onePlayer }, true],
    [{ example: false, phase: 'settlement', players: onePlayer }, true],
    [{ example: false, phase: 'active', players: [] }, false], // empty table
    [{ example: false, phase: 'settlement', players: [] }, false],
    [{ example: false, phase: 'active' }, false], // no players array at all
    [{ example: false, phase: 'closed', players: onePlayer }, false],
    [{ example: true, phase: 'active', players: onePlayer }, false], // demo data
    [null, false],
    [undefined, false],
  ];
  cases.forEach(([game, expected]) => {
    assert.equal(vm.runInContext(`isGameOpen(${JSON.stringify(game)})`, context), expected, JSON.stringify(game));
  });
});

test('isEmptyOpenGame is the strict complement inside an open phase: zero players, not example', () => {
  const context = loadPure();
  assert.equal(vm.runInContext(`isEmptyOpenGame({example:false, phase:'active', players:[]})`, context), true);
  assert.equal(vm.runInContext(`isEmptyOpenGame({example:false, phase:'settlement', players:[]})`, context), true);
  assert.equal(vm.runInContext(`isEmptyOpenGame({example:false, phase:'active'})`, context), true);
  assert.equal(vm.runInContext(`isEmptyOpenGame({example:false, phase:'active', players:${JSON.stringify(onePlayer)}})`, context), false);
  assert.equal(vm.runInContext(`isEmptyOpenGame({example:false, phase:'closed', players:[]})`, context), false);
  assert.equal(vm.runInContext(`isEmptyOpenGame({example:true, phase:'active', players:[]})`, context), false);
  assert.equal(vm.runInContext(`isEmptyOpenGame(null)`, context), false);
});

// ---------- dashboard adapter ----------

test('getActiveGameSummaries returns [] for an active game with no players and one summary for one player', () => {
  const context = loadPure();
  assert.deepEqual(runJSON(`getActiveGameSummaries({example:false, phase:'active', gameId:'g1', groupId:null, players:[]})`, context), []);
  assert.deepEqual(runJSON(`getActiveGameSummaries({example:false, phase:'settlement', gameId:'g1', groupId:null, players:[]})`, context), []);
  const one = runJSON(`getActiveGameSummaries({example:false, phase:'active', gameId:'g1', groupId:null, players:${JSON.stringify(onePlayer)}})`, context);
  assert.equal(one.length, 1);
  assert.equal(one[0].playerCount, 1);
  assert.equal(one[0].potSize, 50);
  assert.equal(one[0].title, 'משחק ללא קבוצה');
});

// ---------- group start gate + group summary ----------

test('canStartGroupGame is ok when the only open game is empty (ungrouped or the same group)', () => {
  const context = loadPure();
  const groups = [{ id: 'g1', archivedAt: null, deletedAt: null }];
  const emptyUngrouped = { groups, currentGame: { example: false, phase: 'active', groupId: null, players: [] } };
  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(emptyUngrouped)}, 'g1')`, context), { ok: true, reason: null });
  const emptySameGroup = { groups, currentGame: { example: false, phase: 'active', groupId: 'g1', players: [] } };
  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(emptySameGroup)}, 'g1')`, context), { ok: true, reason: null });
  // a one-player table still blocks — it already holds buy-in money
  const oneUngrouped = { groups, currentGame: { example: false, phase: 'active', groupId: null, players: onePlayer } };
  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(oneUngrouped)}, 'g1')`, context), { ok: false, reason: 'another-game-open' });
});

test('getGroupSummary does not report an empty open slot as the group\'s active game', () => {
  const context = loadPure();
  const groups = [{ id: 'g1', name: 'ליל שישי', avatarDataUrl: null, archivedAt: null, deletedAt: null }];
  const members = [{ id: 'm1', groupId: 'g1', displayName: 'דביר', role: 'admin', status: 'active' }];
  const empty = { groups, groupMembers: members, history: [], currentGame: { example: false, phase: 'active', groupId: 'g1', players: [] } };
  assert.equal(runJSON(`getGroupSummary(${JSON.stringify(empty)}, 'g1', 'דביר').hasActiveGame`, context), false);
  const seated = { ...empty, currentGame: { example: false, phase: 'active', groupId: 'g1', players: onePlayer } };
  assert.equal(runJSON(`getGroupSummary(${JSON.stringify(seated)}, 'g1', 'דביר').hasActiveGame`, context), true);
});

// ---------- quick action: disabled while a game with players is open ----------

test('renderQuickActions disables "משחק ללא קבוצה" while a game with players is open, with the shared reason line', () => {
  const source = sourceBetween('  function renderQuickActions(parent) {', '  function renderCreateGroupPanel(');
  assert.match(source, /const gameOpen = isGameOpen\(state\);/);
  assert.match(source, /start\.disabled = true;/);
  assert.match(source, /start\.setAttribute\("aria-disabled", "true"\);/);
  // the click handler is wired only when the slot is free
  assert.match(source, /\} else start\.addEventListener\("click", startUngroupedGame\);/);
  // the same wording the group page's start gate already uses for another-game-open
  assert.match(source, /"games-primary-reason", "יש משחק פעיל אחר — סגור אותו קודם"/);
  const gate = sourceBetween('  function renderGroupPrimaryAction(summary, gate) {', '  function renderHideGroupAction(');
  assert.match(gate, /"another-game-open": "יש משחק פעיל אחר — סגור אותו קודם"/);
  // disabled capsule styling mirrors .btn-primary:disabled (faint text, no pointer)
  assert.match(html, /\.games-quick-action:disabled \{ opacity: \.45; cursor: default; color: var\(--faint\); \}/);
});

test('startUngroupedGame refuses to replace an open game with players (backstop behind the disabled capsule)', () => {
  const source = sourceBetween('  function startUngroupedGame() {', '  // Starts a game linked to a group');
  const context = vm.createContext({
    newId: () => 'new-id', saved: 0, view: null,
    expandedEntries: new Set(), openMenu: null, customOpen: null, pendingAmount: null, exitOpen: null, exitJustOpened: null,
    state: { example: false, phase: 'active', gameId: 'real', players: onePlayer, history: [], groups: [{ id: 'g1' }] },
  });
  vm.runInContext('function save() { saved += 1; } function setAppView(next) { view = next; }' + pureSource + source, context);
  vm.runInContext('startUngroupedGame()', context);
  assert.equal(vm.runInContext('state.gameId', context), 'real');
  assert.equal(vm.runInContext('state.players.length', context), 1);
  assert.equal(vm.runInContext('saved', context), 0);
  assert.equal(vm.runInContext('view', context), null);
  // an empty open slot, or a closed slot, is replaced as before
  vm.runInContext('state = { example: false, phase: "active", gameId: "empty", players: [], history: [], groups: [{ id: "g1" }] }; startUngroupedGame()', context);
  assert.equal(vm.runInContext('state.gameId', context), 'new-id');
  assert.equal(vm.runInContext('state.phase', context), 'active');
  assert.equal(vm.runInContext('state.groups.length', context), 1, 'groups survive newCurrentGame');
  assert.equal(vm.runInContext('view', context), 'game');
});

test('continueCurrentGame only enters a game that is actually open (players seated)', () => {
  const source = sourceBetween('  function continueCurrentGame() {', '  function openGroup(');
  const context = vm.createContext({ newId: () => 'x', view: null, state: { example: false, phase: 'active', players: [] } });
  vm.runInContext('function setAppView(next) { view = next; }' + pureSource + source, context);
  vm.runInContext('continueCurrentGame()', context);
  assert.equal(vm.runInContext('view', context), null);
  vm.runInContext(`state.players = ${JSON.stringify(onePlayer)}; continueCurrentGame()`, context);
  assert.equal(vm.runInContext('view', context), 'game');
  vm.runInContext(`state.phase = 'settlement'; continueCurrentGame()`, context);
  assert.equal(vm.runInContext('view', context), 'settle');
});

// ---------- discard on leaving the table ----------

function loadSetAppView(state) {
  const source = sourceBetween('  function setAppView(nextView) {', '  function flashViewEnter');
  const context = vm.createContext({
    newId: () => 'discarded-id', saved: 0, rendered: 0, state,
    appView: 'game', expandedEntries: new Set(), closeArmTimer: null, hideGroupArmedTimeout: null,
    document: { getElementById: () => null },
    clearTimeout: () => {}, matchMedia: () => ({ matches: true }),
    clearCloseHold() {}, setCloseButtonLabel() {}, resetStartGamePanel() {}, resetCreateGroupPanel() {},
    disarmRemoveMember() {}, flashViewEnter() {},
  });
  vm.runInContext('function save() { saved += 1; } function render() { rendered += 1; }' + pureSource + source, context);
  return context;
}

test('leaving the table with nobody seated discards the phantom: closed slot, no history, groups kept', () => {
  const context = loadSetAppView({
    example: false, phase: 'active', gameId: 'phantom', startedAt: '2026-09-08T20:00:00.000Z', groupId: null,
    players: [], history: [{ id: 'h1' }], debts: [{ id: 'd1' }], groups: [{ id: 'g1' }], groupMembers: [{ id: 'm1' }],
  });
  vm.runInContext('setAppView("games")', context);
  assert.equal(vm.runInContext('appView', context), 'games');
  assert.equal(vm.runInContext('state.phase', context), 'closed');
  assert.equal(vm.runInContext('state.gameId', context), 'discarded-id');
  assert.equal(vm.runInContext('state.startedAt', context), null);
  assert.equal(vm.runInContext('state.players.length', context), 0);
  assert.equal(vm.runInContext('state.history.length', context), 1, 'nothing goes to history');
  assert.equal(vm.runInContext('state.debts.length', context), 1);
  assert.equal(vm.runInContext('state.groups.length', context), 1);
  assert.equal(vm.runInContext('state.groupMembers.length', context), 1);
  assert.equal(vm.runInContext('saved', context), 1);
  assert.equal(vm.runInContext('rendered', context), 1);
});

test('leaving the table with players seated, or moving game <-> settle, never touches the game', () => {
  const seated = loadSetAppView({ example: false, phase: 'active', gameId: 'real', players: onePlayer, history: [] });
  vm.runInContext('setAppView("games")', seated);
  assert.equal(vm.runInContext('state.gameId', seated), 'real');
  assert.equal(vm.runInContext('state.phase', seated), 'active');
  assert.equal(vm.runInContext('saved', seated), 0);

  // game -> settle with an empty slot is not "leaving the table" (the discard only fires on exit)
  const between = loadSetAppView({ example: false, phase: 'active', gameId: 'empty', players: [], history: [] });
  vm.runInContext('setAppView("settle")', between);
  assert.equal(vm.runInContext('state.gameId', between), 'empty');
  assert.equal(vm.runInContext('saved', between), 0);

  // example data is never discarded (markReal() owns that transition)
  const demo = loadSetAppView({ example: true, phase: 'active', gameId: 'demo', players: [], history: [] });
  vm.runInContext('setAppView("profile")', demo);
  assert.equal(vm.runInContext('state.gameId', demo), 'demo');
  assert.equal(vm.runInContext('saved', demo), 0);

  // a closed slot on a non-table view is untouched (boot lands on "games" with appView already set)
  const closed = loadSetAppView({ example: false, phase: 'closed', gameId: 'closed', players: [], history: [] });
  vm.runInContext('appView = "games"; setAppView("profile")', closed);
  assert.equal(vm.runInContext('state.gameId', closed), 'closed');
  assert.equal(vm.runInContext('saved', closed), 0);
});

// ---------- "there is an active game" checks in the UI go through the predicate ----------

test('finish-game gates and the group summary use isGameOpen, not phase alone', () => {
  assert.match(html, /const canFinishGame = appView === "game" && state\.phase === "active" && isGameOpen\(state\);/);
  assert.match(html, /if \(appView !== "game" \|\| state\.phase !== "active" \|\| !isGameOpen\(state\)\) return;/);
  const finish = sourceBetween('  function finishGame() {', '  function returnToGameEdit() {');
  assert.match(finish, /!isGameOpen\(state\)/);
  const summary = sourceBetween('  function getGroupSummary(collections, groupId, meName) {', '  function getGroupSummaries(');
  assert.match(summary, /const hasActiveGame = isGameOpen\(currentGame\) && currentGame\.groupId === groupId;/);
});
