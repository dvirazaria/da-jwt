// Multi-game round 1 (docs/superpowers/plans/2026-09-10-multi-game.md, CLAUDE.md's "state.games"
// contract): state.games is the AUTHORITATIVE store for open-game slots. The singular
// state.gameId/phase/players/groupId/startedAt/leaderRef/settlementStatuses fields every renderer
// still reads (Round 2 migrates them) are a MIRROR, derived from the current slot by
// syncCurrentGameMirror -- games -> singular, never the other direction. Two things must hold for
// that to be safe: normalize() must migrate a pre-round-1 document into state.games without losing
// or duplicating its one implicit slot, and syncCurrentGameMirror must be the ONLY place in the
// whole script that ever assigns those singular fields directly (the staleness guard below proves
// that by construction, not by re-testing each mutator one at a time).
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
  // Round 1 direction flip: state.games is now authoritative, so the normalized document's `phase`
  // is DERIVED from whichever slot matches gameId (syncCurrentGameMirror), not trusted verbatim off
  // the raw input the way it was before this round. No slot exists here (never invent one from an
  // ambiguous legacy document -- see the migration test below), so phase defaults to "closed",
  // exactly the plan's own pseudocode (§1). This is unobservable through the UI: initialAppView
  // already requires isGameOpen (at least one player) before it ever reads phase to decide where to
  // resume, and isGameOpen is false here regardless of which phase string this field carries.
  assert.equal(result.phase, 'closed');
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

test('an already-migrated document keeps a zero-player current slot (a freshly opened table, not yet peopled) across a reload', () => {
  // Round 1 direction flip: unlike the legacy no-`games`-field branch above, an ALREADY-migrated
  // document's current slot is re-validated by hasOpenPhase alone (normalizeGameSlot), not
  // isGameOpen -- state.games is the live authoritative store now, so a table opened but not yet
  // peopled (newCurrentGame's own draft, see below) must survive normalize()/a cloud merge without
  // losing its in-progress groupId/startedAt/leaderRef.
  const doc = {
    gameId: 'draft', phase: 'active', players: [], history: [],
    games: [{ gameId: 'draft', phase: 'active', players: [], groupId: 'grp9', startedAt: 't0', leaderRef: null, settlementStatuses: {} }],
  };
  const result = normalize(doc);
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].gameId, 'draft');
  assert.deepEqual(result.games[0].players, []);
  assert.equal(result.groupId, 'grp9', 'the mirror carries the draft groupId even with zero players');
  assert.equal(result.phase, 'active');
});

// ---------- syncCurrentGameMirror: read-only on games, the sole writer of the singular fields ----------

test('syncCurrentGameMirror copies the matching slot onto the singular fields and never mutates games itself', () => {
  const context = loadPure();
  const state = {
    gameId: 'g1', games: [
      { gameId: 'other', phase: 'active', players: [{ id: 'p-other' }], groupId: 'grp-other', startedAt: 'a', leaderRef: null, settlementStatuses: { a: true } },
      { gameId: 'g1', phase: 'settlement', players: [{ id: 'p1' }], groupId: 'grp1', startedAt: 'b', leaderRef: { userId: null, guestId: 'u1', displayName: 'x' }, settlementStatuses: { k: true } },
    ],
  };
  Object.assign(context, { state });
  vm.runInContext('syncCurrentGameMirror(state)', context);
  assert.deepEqual(runJSON('state.players', context), [{ id: 'p1' }]);
  assert.equal(runJSON('state.phase', context), 'settlement');
  assert.equal(runJSON('state.groupId', context), 'grp1');
  assert.equal(runJSON('state.startedAt', context), 'b');
  assert.deepEqual(runJSON('state.leaderRef', context), { userId: null, guestId: 'u1', displayName: 'x' });
  assert.deepEqual(runJSON('state.settlementStatuses', context), { k: true });
  // games itself must be untouched -- same two entries, same order, same content.
  assert.deepEqual(runJSON('state.games.map(g => g.gameId)', context), ['other', 'g1']);
  assert.deepEqual(runJSON("state.games.find(g => g.gameId === 'other').players", context), [{ id: 'p-other' }]);
});

test('syncCurrentGameMirror resets the singular fields to closed/empty defaults when no slot matches gameId, without touching games', () => {
  const context = loadPure();
  const state = {
    gameId: 'not-in-games',
    games: [{ gameId: 'other', phase: 'active', players: [{ id: 'p-other' }], groupId: 'g', startedAt: 't', leaderRef: null, settlementStatuses: {} }],
  };
  Object.assign(context, { state });
  vm.runInContext('syncCurrentGameMirror(state)', context);
  assert.deepEqual(runJSON('state.players', context), []);
  assert.equal(runJSON('state.phase', context), 'closed');
  assert.equal(runJSON('state.groupId', context), null);
  assert.equal(runJSON('state.startedAt', context), null);
  assert.equal(runJSON('state.leaderRef', context), null);
  assert.deepEqual(runJSON('state.settlementStatuses', context), {});
  assert.deepEqual(runJSON('state.games.map(g => g.gameId)', context), ['other'], 'the unrelated slot must survive a mirror with no match');
});

// ---------- a full mutator-driven lifecycle, proving the slot -- not the mirror -- is the target ----------

test('finishGame/returnToGameEdit write the current slot; save() (stubbed) is what would mirror it -- an unrelated slot is never touched', () => {
  const finishSource = sourceBetween('  function finishGame() {', '  function clearCloseHold()');
  const context = loadPure();
  let saved = 0;
  Object.assign(context, {
    save() { saved += 1; },
    setAppView() {},
    state: {
      // The singular fields mirror the current slot, exactly as they would after the previous
      // save() -- finishGame()'s own top-of-function guard (isGameOpen(state)) still reads them.
      example: false, phase: 'active', gameId: 'g1', players: [{ id: 'p1' }],
      games: [
        { gameId: 'other', phase: 'active', players: [{ id: 'p-other' }], groupId: null, startedAt: null, leaderRef: null, settlementStatuses: {} },
        { gameId: 'g1', phase: 'active', players: [{ id: 'p1' }], groupId: null, startedAt: null, leaderRef: null, settlementStatuses: {} },
      ],
    },
  });
  vm.runInContext(finishSource, context);
  vm.runInContext('finishGame()', context);
  assert.equal(runJSON("state.games.find(g => g.gameId === 'g1').phase", context), 'settlement');
  assert.equal(runJSON("state.games.find(g => g.gameId === 'other').phase", context), 'active', 'the unrelated slot is never touched');
  assert.equal(saved, 1);
  vm.runInContext('returnToGameEdit()', context);
  assert.equal(runJSON("state.games.find(g => g.gameId === 'g1').phase", context), 'active');
  assert.equal(runJSON("state.games.find(g => g.gameId === 'other').phase", context), 'active');
  assert.equal(saved, 2);
});

// ---------- newCurrentGame ----------

test('newCurrentGame drops the replaced game\'s own entry from games (the reset button, and markReal, can fire on a real open game)', () => {
  const context = loadPure();
  const base = {
    gameId: 'real-game', phase: 'active', players: [{ name: 'א' }], history: [], debts: [],
    groups: [], groupMembers: [], invites: [], friendships: [], updatedAt: 't',
    games: [{
      gameId: 'real-game', phase: 'active', players: [{ name: 'א' }],
      groupId: null, startedAt: null, leaderRef: null, settlementStatuses: {},
    }],
  };
  Object.assign(context, { base });
  const result = runJSON(`newCurrentGame(base, { phase: "closed" })`, context);
  assert.deepEqual(result.games, [], 'the old slot must not linger once no gameId points to it any more');
  assert.equal(result.phase, 'closed', 'newCurrentGame self-mirrors before returning');
  assert.deepEqual(result.players, []);
});

test('newCurrentGame with an open patch pushes a fresh slot for the new gameId (possibly empty) and mirrors it immediately', () => {
  const context = loadPure();
  const base = { gameId: 'old', phase: 'closed', players: [], history: [], debts: [], groups: [], groupMembers: [], invites: [], friendships: [], updatedAt: 't' };
  Object.assign(context, { base });
  const result = runJSON(`newCurrentGame(base, { phase: "active", groupId: "grp1", startedAt: "NOW" })`, context);
  assert.equal(result.games.length, 1, 'a draft slot exists even with zero players');
  assert.equal(result.games[0].gameId, result.gameId);
  assert.deepEqual(result.games[0].players, []);
  // Self-mirrored: a caller reading state.players/phase/groupId right after newCurrentGame -- before
  // the next save() -- must already see this, not stale data from the replaced game (this is exactly
  // what addPlayer()'s duplicate-name guard, and startGroupGame's participant loop, rely on).
  assert.equal(result.phase, 'active');
  assert.equal(result.groupId, 'grp1');
  assert.equal(result.startedAt, 'NOW');
  assert.deepEqual(result.players, []);
});

test('finishCloseTable clears the closing game\'s own games-array entry before minting the new placeholder gameId, and never hand-assigns the singular fields itself', () => {
  const source = sourceBetween('  function finishCloseTable() {', '  document.getElementById("closeTableBtn")');
  assert.match(
    source,
    /state\.games = \(Array\.isArray\(state\.games\) \? state\.games : \[\]\)\.filter\(g => g\.gameId !== state\.gameId\);\s*\n\s*state\.gameId = newId\(\);/,
    'the games cleanup must run against the OLD gameId, strictly before state.gameId is reassigned -- with nothing else writing the singular fields directly in between'
  );
  // Round 1: state.games is authoritative -- finishCloseTable must never hand-assign the singular
  // fields itself (that would violate the staleness guard below); the reset to closed/empty is
  // entirely save()'s mirror finding no slot for the fresh gameId.
  assert.doesNotMatch(source, /state\.players\s*=/);
  assert.doesNotMatch(source, /state\.phase\s*=(?!=)/);
  assert.doesNotMatch(source, /state\.settlementStatuses\s*=/);
});

// ---------- the staleness guard ----------
//
// state.games is authoritative: every mutator writes the current slot, and syncCurrentGameMirror is
// the ONLY place allowed to assign the singular fields it derives from that slot. Rather than
// re-testing every mutator's business logic, this greps every direct assignment to those fields in
// the whole script and proves EVERY one sits inside syncCurrentGameMirror itself -- the exact "flip
// what the guard allows" the round asked for, kept as a test so a future edit can't reintroduce a
// mutator that bypasses the slot.

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

test('no direct assignment to state.players/phase/groupId/startedAt/leaderRef/settlementStatuses exists anywhere in the script except inside syncCurrentGameMirror', () => {
  const blocks = topLevelFunctionBlocks(html);
  const writeRe = new RegExp(`state\\.(${MIRRORED_FIELDS.join('|')})\\s*=(?!=)`, 'g');
  let match;
  let checked = 0;
  while ((match = writeRe.exec(html))) {
    const at = match.index;
    const block = blocks.find(b => at >= b.start && at < b.end);
    assert.ok(block, `state.${match[1]} = ... at offset ${at} is not inside any recognized top-level ` +
      'function -- state.games is authoritative, so a write outside syncCurrentGameMirror can only ' +
      'desync the mirror; review it by hand');
    assert.equal(block.name, 'syncCurrentGameMirror',
      `${block.name}() assigns state.${match[1]} directly -- only syncCurrentGameMirror may; every ` +
      'other mutator must write the current slot (currentGameSlot(state)) and let save()/' +
      'newCurrentGame\'s own mirror call project it onto the singular fields');
    checked += 1;
  }
  // Sanity floor so a regex typo can't make this pass vacuously: syncCurrentGameMirror assigns
  // exactly one of these fields per line, six total (players/phase/groupId/startedAt/leaderRef/
  // settlementStatuses) -- a future edit that adds or removes one should update this count too.
  assert.equal(checked, 6, `expected exactly 6 direct writes (all inside syncCurrentGameMirror), found ${checked}`);
});
