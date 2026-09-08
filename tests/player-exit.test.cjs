const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('kupa-sgura.html', 'utf8');

const exitSource = html.slice(
  html.indexOf('  // ---------- player exit (pure) ----------'),
  html.indexOf('  function el(')
);
function loadExit() {
  const context = vm.createContext({});
  vm.runInContext(exitSource, context);
  return context;
}

const normalizeSource = html.slice(html.indexOf('  function normalizePhase'), html.indexOf('  function load()'));
function normalize(s) {
  return vm.runInNewContext(normalizeSource + '\nnormalize(input)', {input: s, crypto: require('node:crypto').webcrypto});
}

test('exitPlayer sets status, exitedAt and cashout on a first call', () => {
  const context = loadExit();
  const player = {status: 'active', cashout: ''};
  const ok = vm.runInContext(`exitPlayer(player, 220, 'T1')`, Object.assign(context, {player}));
  assert.equal(ok, true);
  assert.equal(player.status, 'exited');
  assert.equal(player.exitedAt, 'T1');
  assert.equal(player.cashout, 220);
});

test('exitPlayer refuses a player who already exited, without touching their cashout', () => {
  const context = loadExit();
  const player = {status: 'exited', exitedAt: 'T0', cashout: 100};
  const ok = vm.runInContext(`exitPlayer(player, 500, 'T1')`, Object.assign(context, {player}));
  assert.equal(ok, false);
  assert.equal(player.cashout, 100);
  assert.equal(player.exitedAt, 'T0');
});

test('exitPlayer rejects negative and NaN cashouts and leaves the player untouched', () => {
  const context = loadExit();
  const player = {status: 'active'};
  assert.equal(vm.runInContext(`exitPlayer(player, -5, 'T1')`, Object.assign(context, {player})), false);
  assert.equal(vm.runInContext(`exitPlayer(player, NaN, 'T1')`, Object.assign(context, {player})), false);
  assert.equal(player.status, 'active');
  assert.equal(player.exitedAt, undefined);
});

test('updateExitCashout only changes the amount for an already-exited player', () => {
  const context = loadExit();
  const active = {status: 'active', cashout: 0};
  assert.equal(vm.runInContext(`updateExitCashout(player, 50)`, Object.assign(context, {player: active})), false);
  assert.equal(active.cashout, 0);

  const exited = {status: 'exited', cashout: 100};
  assert.equal(vm.runInContext(`updateExitCashout(player, 150)`, Object.assign(context, {player: exited})), true);
  assert.equal(exited.cashout, 150);
  assert.equal(vm.runInContext(`updateExitCashout(player, -10)`, Object.assign(context, {player: exited})), false);
  assert.equal(exited.cashout, 150); // rejected update leaves the previous value in place
});

test('activePlayers and exitedPlayers partition the roster, isExited matches', () => {
  const context = loadExit();
  const players = [{name: 'א', status: 'active'}, {name: 'ב', status: 'exited'}, {name: 'ג'}];
  const active = vm.runInContext(`JSON.stringify(activePlayers(players).map(p => p.name))`, Object.assign(context, {players}));
  const exited = vm.runInContext(`JSON.stringify(exitedPlayers(players).map(p => p.name))`, context);
  assert.deepEqual(JSON.parse(active), ['א', 'ג']); // legacy players without a status count as active
  assert.deepEqual(JSON.parse(exited), ['ב']);
  assert.equal(vm.runInContext(`isExited(players[1])`, context), true);
  assert.equal(vm.runInContext(`isExited(players[0])`, context), false);
});

test('normalize defaults status to active and exitedAt to null for legacy players', () => {
  const result = normalize({gameId: 'g1', players: [{name: 'א', buyins: [50], cashout: 0}], history: []});
  assert.equal(result.players[0].status, 'active');
  assert.equal(result.players[0].exitedAt, null);
});

test('normalize forces userId null on every player (pre-backend, same as the other normalizers)', () => {
  const result = normalize({
    gameId: 'g3',
    players: [{ name: 'א', buyins: [50], cashout: 0, userId: 'bogus-user-id' }],
    history: [],
  });
  assert.equal(result.players[0].userId, null);
  assert.equal(result.players[0].guestId, null);
  assert.equal(result.players[0].memberId, null);
});

test('normalize preserves a saved exited status and exitedAt across reload', () => {
  const result = normalize({
    gameId: 'g2',
    players: [{id: 'p1', name: 'ב', buyins: [50], entryLog: [], cashout: 80, status: 'exited', exitedAt: '2026-09-07T18:00:00Z'}],
    history: [],
  });
  assert.equal(result.players[0].status, 'exited');
  assert.equal(result.players[0].exitedAt, '2026-09-07T18:00:00Z');
});

test('buildHistoryEntry copies status and exitedAt onto the history player records', () => {
  const start = html.indexOf('  function buildHistoryEntry');
  const end = html.indexOf('  // Greedy settlement', start);
  assert.ok(start >= 0, 'buildHistoryEntry helper exists');
  const context = vm.createContext({});
  vm.runInContext('const sum = values => values.reduce((x, y) => x + y, 0);', context);
  vm.runInContext(html.slice(start, end), context);
  const state = {
    gameId: 'g', players: [
      {id: 'p1', name: 'א', buyins: [100], entryLog: [], cashout: 150, status: 'exited', exitedAt: '2026-09-07T18:00:00Z'},
      {id: 'p2', name: 'ב', buyins: [50], entryLog: [], cashout: 0, status: 'active', exitedAt: null},
    ],
  };
  const entry = JSON.parse(vm.runInContext(
    `JSON.stringify(buildHistoryEntry(${JSON.stringify(state)}, {difference: 0, isBalanced: true}, '2026-09-07T19:00:00.000Z'))`,
    context
  ));
  assert.equal(entry.players[0].status, 'exited');
  assert.equal(entry.players[0].exitedAt, '2026-09-07T18:00:00Z');
  assert.equal(entry.players[1].status, 'active');
  assert.equal(entry.players[1].exitedAt, null);
});

test('tableBalance counts an exited player cashout toward out, same as active players', () => {
  const start = html.indexOf('  const wholeMoney');
  const end = html.indexOf('  function totals', start);
  assert.ok(start >= 0, 'tableBalance helper exists');
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end), context);
  const result = JSON.parse(vm.runInContext(
    `JSON.stringify(tableBalance(${JSON.stringify([
      {buyins: [100], cashout: 100, status: 'exited'},
      {buyins: [50], cashout: 0, status: 'active'},
    ])}))`,
    context
  ));
  assert.deepEqual(result, {buy: 150, out: 100, difference: 50, isBalanced: false});
});

test('exit UI is actually wired into the source, not just the pure helpers', () => {
  assert.match(html, /exit-toggle/);
  assert.match(html, /exit-tag/);
  assert.match(html, /exitOpen/);
  assert.match(html, /exitPlayer\(/);
  assert.match(html, /updateExitCashout\(/);
});
