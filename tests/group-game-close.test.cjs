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

test('finishCloseTable captures the closing group, frees groupId/leaderRef, and routes to the group page', () => {
  const source = sourceBetween(
    '  function finishCloseTable() {',
    '  document.getElementById("closeTableBtn").addEventListener("click"'
  );
  // Captured before any mutation so buildDebtRecords/buildHistoryEntry still see the real groupId.
  assert.match(source, /const closedGroupId = state\.groupId;/);
  // The current-game slot is free for a new group game after close.
  assert.match(source, /state\.groupId = null;/);
  assert.match(source, /state\.leaderRef = null;/);
  // startedAt belongs to the closed game only — a fresh current-game slot must not inherit it.
  assert.match(source, /state\.startedAt = null;/);
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
  const source = sourceBetween('  function newCurrentGame', '  // Builds a new Group');
  const context = vm.createContext({ newId: () => 'stub-reset-id' });
  vm.runInContext(source, context);
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
