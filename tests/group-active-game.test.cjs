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

// vm.runInContext returns objects/arrays from the sandbox's own realm, so a plain
// deepEqual against a native literal fails on "same structure, not reference-equal".
// Round-tripping through JSON strips that — same helper as the sibling groups suites.
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- getActiveGameSummaries(gameState, groups) title resolution ----------

const activeGameSource = sourceBetween('  function getActiveGameSummaries', '  function formatGameTime');

test('getActiveGameSummaries titles the summary with the matching group name, even when that group is archived', () => {
  const context = vm.createContext({});
  vm.runInContext(activeGameSource, context);
  const gameState = { example: false, phase: 'active', gameId: 'g1', groupId: 'grp-1', players: [] };

  const activeGroups = [{ id: 'grp-1', name: 'ליל שישי', archivedAt: null, deletedAt: null }];
  assert.equal(
    vm.runInContext(`getActiveGameSummaries(${JSON.stringify(gameState)}, ${JSON.stringify(activeGroups)})[0].title`, context),
    'ליל שישי'
  );

  const archivedGroups = [{ id: 'grp-1', name: 'קבוצה ישנה', archivedAt: '2026-01-01T00:00:00.000Z', deletedAt: null }];
  assert.equal(
    vm.runInContext(`getActiveGameSummaries(${JSON.stringify(gameState)}, ${JSON.stringify(archivedGroups)})[0].title`, context),
    'קבוצה ישנה'
  );
});

test('getActiveGameSummaries falls back to "משחק ללא קבוצה" without a groups argument, an empty list, or no match', () => {
  const context = vm.createContext({});
  vm.runInContext(activeGameSource, context);

  const ungrouped = { example: false, phase: 'active', gameId: 'g1', groupId: null, players: [] };
  assert.equal(vm.runInContext(`getActiveGameSummaries(${JSON.stringify(ungrouped)})[0].title`, context), 'משחק ללא קבוצה');

  // Existing one-argument callers/tests must keep seeing this exact fallback for a grouped game too.
  const grouped = { example: false, phase: 'active', gameId: 'g1', groupId: 'grp-1', players: [] };
  assert.equal(vm.runInContext(`getActiveGameSummaries(${JSON.stringify(grouped)})[0].title`, context), 'משחק ללא קבוצה');
  assert.equal(vm.runInContext(`getActiveGameSummaries(${JSON.stringify(grouped)}, [])[0].title`, context), 'משחק ללא קבוצה');

  const noMatch = { example: false, phase: 'active', gameId: 'g1', groupId: 'grp-missing', players: [] };
  const otherGroups = [{ id: 'grp-1', name: 'ליל שישי', archivedAt: null, deletedAt: null }];
  assert.equal(vm.runInContext(`getActiveGameSummaries(${JSON.stringify(noMatch)}, ${JSON.stringify(otherGroups)})[0].title`, context), 'משחק ללא קבוצה');
});

// ---------- canStartGroupGame: another-game-open vs group-has-open-game ----------

const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

test('canStartGroupGame reports another-game-open when an ungrouped game is open, and group-has-open-game for its own group', () => {
  const context = vm.createContext({ newId: () => 'stub-id' });
  vm.runInContext(pureSource, context);
  const groups = [{ id: 'g1', archivedAt: null, deletedAt: null }];

  const ungroupedActiveGame = { groups, currentGame: { example: false, phase: 'active', groupId: null } };
  assert.deepEqual(
    runJSON(`canStartGroupGame(${JSON.stringify(ungroupedActiveGame)}, 'g1')`, context),
    { ok: false, reason: 'another-game-open' }
  );

  const ownGroupSettlement = { groups, currentGame: { example: false, phase: 'settlement', groupId: 'g1' } };
  assert.deepEqual(
    runJSON(`canStartGroupGame(${JSON.stringify(ownGroupSettlement)}, 'g1')`, context),
    { ok: false, reason: 'group-has-open-game' }
  );
});

// ---------- add-row member chips wiring ----------

test('renderAddRowChips exists, is wired into render(), and addPlayer shares addPlayerToTable with the chips', () => {
  assert.match(html, /function renderAddRowChips\(\)/);
  assert.match(html, /function render\(\) \{[\s\S]*?renderAddRowChips\(\);/);
  assert.match(html, /<div class="who-row addrow-chips" id="addrowChips" hidden><\/div>/);

  const addPlayerSection = sourceBetween('function addPlayer(', '  document.getElementById("addBtn")');
  assert.match(addPlayerSection, /addPlayerToTable\(name, \{ guestId, memberId \}\)/);
  // guestId/memberId are still resolved inside addPlayer itself, exactly like before the extraction.
  assert.match(addPlayerSection, /if \(state\.groupId\) \{/);
  assert.match(addPlayerSection, /resolveGuestId\(collectionsOf\(state\), name\)/);

  const chipsSection = sourceBetween('function renderAddRowChips', '  function render() {');
  assert.match(chipsSection, /addPlayerToTable\(member\.displayName, \{ guestId: member\.guestId, memberId: member\.id \}\)/);

  assert.match(html, /function addPlayerToTable\(name, opts\)/);
  assert.match(html, /createPlayer\(\{ name, guestId: o\.guestId \|\| null, memberId: o\.memberId \|\| null \}\)/);
});
