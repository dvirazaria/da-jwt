// Multi-game round 1 (docs/superpowers/plans/2026-09-10-multi-game.md, CLAUDE.md's "state.games"
// contract): state.games is now the durable store for open-game slots, kept in sync with the
// singular state.gameId/phase/players/groupId/startedAt/leaderRef/settlementStatuses fields every
// mutator/renderer still reads and writes (Round 2 removes them). Two things must hold for that to
// be safe: normalize() must migrate a pre-round-1 document without losing or duplicating its one
// implicit slot, and syncCurrentGameMirror must be the ONLY place state.games ever changes, reached
// from every mutator that writes those singular fields (the staleness guard below proves that by
// construction, not by re-testing each mutator one at a time).
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

// normalize() plus every normalizer it calls -- same slice pattern as tests/entry-log.test.cjs and
// tests/groups-domain.test.cjs's legacy-migration test.
const normalizeSource = sourceBetween('  function normalizePhase', '  function load()');
const groupsPureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

function normalize(s) {
  return JSON.parse(vm.runInNewContext(
    normalizeSource + '\n' + groupsPureSource + '\nJSON.stringify(normalize(input))',
    { input: s, crypto: require('node:crypto').webcrypto, newId: () => 'stub-new-id' }
  ));
}
function loadPure() {
  const context = vm.createContext({ newId: () => 'stub-new-id' });
  vm.runInContext(groupsPureSource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- migration: a legacy single-slot document folds into state.games ----------

test('an open active legacy document migrates to a one-entry games array matching the slot', () => {
  const legacy = {
    gameId: 'g1', phase: 'active', groupId: 'grp1', startedAt: '2026-09-08T20:00:00.000Z',
    leaderRef: { userId: null, guestId: 'u1', displayName: 'דביר' },
    players: [{ name: 'דביר', buyins: [50] }], history: [],
  };
  const result = normalize(legacy);
  assert.equal(result.games.length, 1, 'exactly one slot -- no loss, no double-count');
  const slot = result.games[0];
  assert.equal(slot.gameId, result.gameId);
  assert.equal(slot.phase, 'active');
  assert.equal(slot.groupId, 'grp1');
  assert.equal(slot.startedAt, '2026-09-08T20:00:00.000Z');
  assert.deepEqual(slot.leaderRef, { userId: null, guestId: 'u1', displayName: 'דביר' });
  assert.deepEqual(slot.players, result.players, 'the slot and the mirror agree on the same players');
});

test('an open settlement document with toggled payments migrates the slot with settlementStatuses intact', () => {
  const legacy = {
    gameId: 'g2', phase: 'settlement',
    players: [{ name: 'א', buyins: [100] }, { name: 'ב', buyins: [50] }],
    settlementStatuses: { 'g2::0::א::ב::50': true }, history: [],
  };
  const result = normalize(legacy);
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].phase, 'settlement');
  // The risk the plan calls out explicitly (§8.2): a mid-settlement game's already-toggled "paid"
  // marks must not reset on migration.
  assert.deepEqual(result.games[0].settlementStatuses, { 'g2::0::א::ב::50': true });
  assert.deepEqual(result.settlementStatuses, { 'g2::0::א::ב::50': true });
});

test('an empty table (active phase, no players) migrates to an empty games array -- never a phantom slot', () => {
  const legacy = { gameId: 'g3', phase: 'active', players: [], history: [] };
  const result = normalize(legacy);
  assert.deepEqual(result.games, [], 'isGameOpen requires at least one player -- "an empty table is not a game"');
  // The singular phase itself is untouched by the mirror (normalizePhase already decided it, same
  // as before this round) -- only games is gated on isGameOpen, exactly like every existing
  // isGameOpen check elsewhere (initialAppView, canStartGroupGame, ...) already gates on it too.
  assert.equal(result.phase, 'active');
});

test('a closed document migrates to an empty games array', () => {
  const legacy = { gameId: 'g4', phase: 'closed', players: [{ name: 'א', buyins: [50], cashout: 50 }], history: [] };
  const result = normalize(legacy);
  assert.deepEqual(result.games, []);
});

test('migrating twice is idempotent: re-normalizing the already-migrated output produces an identical document', () => {
  const legacy = { gameId: 'g5', phase: 'active', players: [{ name: 'א', buyins: [50] }], history: [] };
  const once = normalize(legacy);
  const twice = normalize(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.equal(twice.games.length, 1, 'no duplication on the second pass');
});

test('a document that already carries a games array for a different game keeps it untouched while the current slot is reconciled', () => {
  const doc = {
    gameId: 'current', phase: 'active', players: [{ name: 'א', buyins: [50] }], history: [],
    games: [{
      gameId: 'other-game', phase: 'active',
      players: [{ id: 'p1', name: 'ב', buyins: [20], entryLog: [] }],
      groupId: 'grp2', startedAt: null, leaderRef: null, settlementStatuses: {},
    }],
  };
  const result = normalize(doc);
  assert.equal(result.games.length, 2, 'the other open game survives alongside the current one');
  const other = result.games.find(g => g.gameId === 'other-game');
  assert.ok(other);
  assert.equal(other.groupId, 'grp2');
  assert.ok(result.games.find(g => g.gameId === 'current'), 'the current game also gets its own slot');
});

// ---------- the mirror stays consistent after mutators ----------

test('newCurrentGame drops the replaced game\'s own entry from games (the reset button, and markReal, can fire on a real open game)', () => {
  const source = sourceBetween('  function newCurrentGame', '  // Builds a new Group');
  const base = {
    gameId: 'real-game', phase: 'active', players: [{ name: 'א' }], history: [], debts: [],
    groups: [], groupMembers: [], invites: [], friendships: [], updatedAt: 't',
    games: [{
      gameId: 'real-game', phase: 'active', players: [{ name: 'א' }],
      groupId: null, startedAt: null, leaderRef: null, settlementStatuses: {},
    }],
  };
  const context = vm.createContext({ newId: () => 'fresh-id', base });
  vm.runInContext(source, context);
  const result = JSON.parse(vm.runInContext('JSON.stringify(newCurrentGame(base, { phase: "closed" }))', context));
  assert.deepEqual(result.games, [], 'the old slot must not linger once no gameId points to it any more');
});

test('syncCurrentGameMirror adds the slot once the game becomes real, updates it in place on phase/settlement changes, and removes it on close -- without ever touching an unrelated slot', () => {
  const context = loadPure();
  const state = {
    example: false, gameId: 'g1', phase: 'active', players: [], groupId: null, startedAt: null,
    leaderRef: null, settlementStatuses: {},
    games: [{
      gameId: 'other', phase: 'active', players: [{ id: 'p' }],
      groupId: null, startedAt: null, leaderRef: null, settlementStatuses: {},
    }],
  };
  Object.assign(context, { state });

  // 1. an empty active table is not yet a real game -- no slot for it, the unrelated one is untouched.
  vm.runInContext('syncCurrentGameMirror(state)', context);
  assert.deepEqual(runJSON('state.games.map(g => g.gameId)', context), ['other']);

  // 2. the first player lands -- the slot appears.
  vm.runInContext(`state.players.push({id:'p1', name:'א', buyins:[50]})`, context);
  vm.runInContext('syncCurrentGameMirror(state)', context);
  assert.deepEqual(runJSON('state.games.map(g => g.gameId).sort()', context), ['g1', 'other']);

  // 3. moving to settlement and toggling a payment replaces the slot in place -- one entry, not two.
  vm.runInContext(`state.phase = 'settlement'; state.settlementStatuses = { k: true };`, context);
  vm.runInContext('syncCurrentGameMirror(state)', context);
  assert.equal(runJSON('state.games.length', context), 2);
  assert.equal(runJSON(`state.games.find(g => g.gameId === 'g1').phase`, context), 'settlement');
  assert.deepEqual(runJSON(`state.games.find(g => g.gameId === 'g1').settlementStatuses`, context), { k: true });

  // 4. close: mirrors finishCloseTable's own order (drop the OLD gameId's slot, then mint a fresh
  // placeholder id) -- syncCurrentGameMirror alone only ever reconciles whichever gameId state has
  // *at the moment it runs*, so the drop has to happen before gameId changes, not after.
  vm.runInContext(`state.games = state.games.filter(g => g.gameId !== state.gameId);
    state.phase = 'closed'; state.players = []; state.gameId = 'g1-closed';`, context);
  vm.runInContext('syncCurrentGameMirror(state)', context);
  assert.deepEqual(runJSON('state.games.map(g => g.gameId)', context), ['other']);
});

test('finishCloseTable clears the closing game\'s own games-array entry before minting the new placeholder gameId', () => {
  const source = sourceBetween('  function finishCloseTable() {', '  document.getElementById("closeTableBtn")');
  assert.match(
    source,
    /state\.games = \(Array\.isArray\(state\.games\) \? state\.games : \[\]\)\.filter\(g => g\.gameId !== state\.gameId\);\s*\n\s*state\.players = \[\];\s*\n\s*state\.gameId = newId\(\);/,
    'the games cleanup must run against the OLD gameId, strictly before state.gameId is reassigned'
  );
});

// ---------- the staleness guard ----------
//
// The plan's own §8 risk #1: a direct write to a mirrored singular field outside a save()-ending
// mutator would silently desync state.games from what the app is showing. Rather than re-testing
// every mutator's business logic, this greps every such write in the whole script and proves each
// one sits inside a top-level function whose body also calls save() after it -- the exact 10-minute
// audit the plan recommends doing by hand, kept as a test so a future edit can't reintroduce it.

const MIRRORED_FIELDS = ['players', 'phase', 'groupId', 'startedAt', 'leaderRef', 'settlementStatuses'];

// Every top-level "  function name(...) {" ... "  }" block in the script, using the same
// convention every sourceBetween() call in this test suite already relies on.
function topLevelFunctionBlocks(source) {
  const blocks = [];
  const re = /^ {2}function (\w+)\(/gm;
  let m;
  while ((m = re.exec(source))) {
    const start = m.index;
    const rest = source.slice(start);
    const closeMatch = rest.match(/\n {2}\}\r?\n/);
    if (!closeMatch) continue;
    blocks.push({ name: m[1], start, end: start + closeMatch.index + closeMatch[0].length });
  }
  return blocks;
}

test('every direct write to state.players/phase/groupId/startedAt/leaderRef/settlementStatuses sits inside a function that also calls save() after it', () => {
  const blocks = topLevelFunctionBlocks(html);
  const writeRe = new RegExp(`state\\.(${MIRRORED_FIELDS.join('|')})\\s*=(?!=)`, 'g');
  let match;
  let checked = 0;
  while ((match = writeRe.exec(html))) {
    const at = match.index;
    const block = blocks.find(b => at >= b.start && at < b.end);
    assert.ok(block, `state.${match[1]} = ... at offset ${at} is not inside any recognized top-level ` +
      'function -- a write outside a save()-ending mutator can silently desync state.games; review it by hand');
    const bodyAfter = html.slice(at, block.end);
    assert.ok(bodyAfter.includes('save()'),
      `${block.name}() writes state.${match[1]} but never calls save() again afterwards -- ` +
      'the games mirror would go stale for that field');
    checked += 1;
  }
  // Sanity floor so a regex typo can't make this pass vacuously: today's known writers are
  // finishGame, returnToGameEdit, finishCloseTable (6 fields) and addPlayerToTable.
  assert.ok(checked >= 9, `expected to find at least 9 direct writes, found ${checked}`);
});
