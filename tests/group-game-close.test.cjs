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

// ---------- finishCloseTable frees the group slot and routes back to the group page ----------

test('finishCloseTable captures the closing group, drops the closing game\'s own slot, and routes to the group page', () => {
  const source = sourceBetween(
    '  function finishCloseTable() {',
    '  document.getElementById("closeTableBtn").addEventListener("click"'
  );
  // Captured before any mutation so buildDebtRecords/buildHistoryEntry still see the real groupId.
  assert.match(source, /const closedGroupId = state\.groupId;/);
  // Round 1: state.games is authoritative -- the closing game's own slot (which carries its
  // groupId/leaderRef/startedAt) is dropped from the array before a fresh placeholder gameId is
  // minted; save()'s mirror then finds no slot for that id and resets groupId/leaderRef/startedAt
  // to null the same way this test always required, just derived instead of hand-assigned (proved
  // generically by the staleness guard in tests/multi-game-migration.test.cjs).
  assert.match(source, /state\.games = \(Array\.isArray\(state\.games\) \? state\.games : \[\]\)\.filter\(g => g\.gameId !== state\.gameId\);/);
  assert.match(source, /state\.gameId = newId\(\);/);
  // A group game returns to its group page; an ungrouped game still lands on Games.
  assert.match(source, /openGroup\(closedGroupId\)/);
  assert.match(source, /else setAppView\("games"\);/);
  // Balanced confetti is unconditional on which branch was taken.
  assert.match(source, /if \(balanced\) confetti\(\);/);
});

// ---------- buildHistoryEntry carries group linkage and per-player membership/exit fields ----------

test('buildHistoryEntry copies groupId, startedAt, leaderRef and per-player guestId/memberId/status/exitedAt', () => {
  const source = sourceBetween('  function buildHistoryEntry', '  function balanceDescription');
  const context = vm.createContext({
    settlementKey: (gameId, move, index) => [gameId, index, move.from, move.to, move.amount].join('::'),
    wholeMoney: n => Math.round(Number(n) || 0),
    sum: values => values.reduce((x, y) => x + y, 0),
  });
  vm.runInContext(source, context);
  const snapshot = {
    gameId: 'g1',
    groupId: 'grp-1',
    startedAt: '2026-09-07T18:00:00.000Z',
    leaderRef: { userId: null, guestId: 'u1', displayName: 'דביר' },
    players: [
      { id: 'p1', name: 'דביר', guestId: 'u1', memberId: 'm1', buyins: [100], entryLog: [], cashout: 150, status: 'exited', exitedAt: '2026-09-07T18:30:00.000Z' },
      { id: 'p2', name: 'רועי', guestId: 'u2', memberId: 'm2', buyins: [50], entryLog: [], cashout: 0, status: 'active', exitedAt: null },
    ],
  };
  const moves = [{ from: 'רועי', to: 'דביר', amount: 50 }];
  const entry = JSON.parse(vm.runInContext(
    `JSON.stringify(buildHistoryEntry(${JSON.stringify(snapshot)}, {difference: 0, isBalanced: true}, '2026-09-07T19:00:00.000Z', ${JSON.stringify(moves)}, {}))`,
    context
  ));
  assert.equal(entry.groupId, 'grp-1');
  assert.equal(entry.startedAt, '2026-09-07T18:00:00.000Z');
  assert.deepEqual(entry.leaderRef, { userId: null, guestId: 'u1', displayName: 'דביר' });
  assert.equal(entry.players[0].guestId, 'u1');
  assert.equal(entry.players[0].memberId, 'm1');
  assert.equal(entry.players[0].status, 'exited');
  assert.equal(entry.players[0].exitedAt, '2026-09-07T18:30:00.000Z');
  assert.equal(entry.players[1].guestId, 'u2');
  assert.equal(entry.players[1].memberId, 'm2');
  assert.equal(entry.players[1].status, 'active');
  assert.equal(entry.players[1].exitedAt, null);
});

// ---------- newCurrentGame frees groupId/leaderRef the way the reset button relies on ----------

test('newCurrentGame resets groupId and leaderRef to null even when the patch (like the reset button) omits them', () => {
  // Round 1: newCurrentGame now calls hasOpenPhase/syncCurrentGameMirror (it self-mirrors before
  // returning, so callers reading state.groupId/leaderRef right after it -- without an intervening
  // save() -- see correct values) -- load the whole groups-domain pure section, not just
  // newCurrentGame's own body, the same slice every sibling suite already uses for it.
  const groupsPureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');
  const context = vm.createContext({ newId: () => 'stub-reset-id' });
  vm.runInContext(groupsPureSource, context);
  Object.assign(context, {
    base: {
      groupId: 'grp-1',
      leaderRef: { userId: null, guestId: 'u1', displayName: 'דביר' },
      startedAt: '2026-09-07T18:00:00.000Z',
      history: [], debts: [], groups: [], groupMembers: [], invites: [], friendships: [], updatedAt: 't',
    },
  });
  // Mirrors the reset button's exact call: state = newCurrentGame(state, { phase: "closed" });
  assert.match(html, /state = newCurrentGame\(state, \{ phase: "closed" \}\);/);
  const result = JSON.parse(vm.runInContext('JSON.stringify(newCurrentGame(base, { phase: "closed" }))', context));
  assert.equal(result.groupId, null);
  assert.equal(result.leaderRef, null);
});
