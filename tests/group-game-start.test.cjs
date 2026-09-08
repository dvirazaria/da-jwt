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

// Same pure-section slice as tests/groups-domain.test.cjs and tests/group-members.test.cjs:
// this range holds createPlayer (Task 8) alongside the rest of the groups/invites pure domain.
const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

// createPlayer calls newId() to mint a fresh id. The isolated pure-section slice does not
// define it (it lives elsewhere in the file), so tests supply a stub, same as sibling suites.
function load(newIdStub) {
  const context = vm.createContext({ newId: newIdStub || (() => 'stub-new-id') });
  vm.runInContext(pureSource, context);
  return context;
}

// vm.runInContext returns objects from the sandbox's own realm, so a plain deepEqual against a
// native literal fails on "same structure, not reference-equal". Round-tripping through JSON
// strips that — same helper as the sibling groups suites.
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- createPlayer (pure) ----------

test('createPlayer builds a fresh, active Player record with the given ids threaded through', () => {
  const context = load(() => 'new-player-id');
  const player = runJSON(`createPlayer({name:'דן', guestId:'guest-1', memberId:'m1'})`, context);
  assert.deepEqual(player, {
    id: 'new-player-id', name: 'דן', buyins: [], entryLog: [], cashout: '', status: 'active',
    exitedAt: null, guestId: 'guest-1', memberId: 'm1', userId: null,
  });
});

test('createPlayer defaults guestId/memberId to null (ungrouped game) when omitted or falsy', () => {
  const context = load(() => 'id-2');
  const player = runJSON(`createPlayer({name:'רותם'})`, context);
  assert.equal(player.guestId, null);
  assert.equal(player.memberId, null);
  assert.equal(player.userId, null);
  assert.equal(player.status, 'active');
  assert.equal(player.cashout, '');
  assert.deepEqual(player.buyins, []);
  assert.deepEqual(player.entryLog, []);
});

// ---------- UI wiring (regex over the full source) ----------

test('startGroupGame is wired to canStartGroupGame, newCurrentGame, createPlayer, addEntry and save', () => {
  const section = sourceBetween('function startGroupGame(', '  function continueCurrentGame(');
  assert.match(section, /canStartGroupGame\(collectionsOf\(state\), groupId\)\.ok/);
  assert.match(section, /newCurrentGame\(state, \{/);
  assert.match(section, /createPlayer\(participant\)/);
  assert.match(section, /addEntry\(player, MIN_BUYIN\)/);
  assert.match(section, /save\(\)/);
  assert.match(section, /setAppView\("game"\)/);
});

test('startGroupGame builds leaderRef from resolveGuestId(collectionsOf(state), me) and refuses with fewer than one participant', () => {
  const section = sourceBetween('function startGroupGame(', '  function continueCurrentGame(');
  assert.match(section, /leaderRef: \{ userId: null, guestId: resolveGuestId\(collectionsOf\(state\), me\), displayName: me \}/);
  assert.match(section, /list\.length < 1/);
  assert.match(section, /return false/);
});

// Task 9 extracts addPlayer's shared tail (createPlayer/addEntry/open-menu/save/render) into
// addPlayerToTable so the group member chips can reuse it; addPlayer itself still resolves
// guestId/memberId (only inside a group game, exactly like startGroupGame's ids) and delegates.
test('addPlayer resolves guestId/memberId then delegates to the shared addPlayerToTable, which builds the player via createPlayer', () => {
  const section = sourceBetween('function addPlayer(', '  document.getElementById("addBtn")');
  assert.match(section, /if \(state\.groupId\) \{/);
  assert.match(section, /resolveGuestId\(collectionsOf\(state\), name\)/);
  assert.match(section, /addPlayerToTable\(name, \{ guestId, memberId \}\)/);

  const tailSection = sourceBetween('function addPlayerToTable(', '  function addPlayer() {');
  assert.match(tailSection, /createPlayer\(\{ name, guestId: o\.guestId \|\| null, memberId: o\.memberId \|\| null \}\)/);
});

test('the game view stat line shows the group name ("קבוצה: ") built via DOM nodes, not raw innerHTML', () => {
  const section = sourceBetween('function renderDerived(', '    const warn = document.getElementById("warnbox");');
  assert.match(section, /קבוצה: /);
  assert.match(section, /document\.createTextNode\("קבוצה: "\)/);
  assert.match(section, /statGroup\.name/);
});

test('the group page primary action opens an inline start-game panel gated by canStartGroupGame.ok', () => {
  assert.match(html, /function toggleStartGamePanel\(/);
  assert.match(html, /function renderStartGamePanel\(/);
  assert.match(html, /startGroupGame\(currentGroupId, participants\)/);
  assert.match(html, /role", "checkbox"/);
});
