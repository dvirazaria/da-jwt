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

const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

function loadPure() {
  const context = vm.createContext({ newId: () => 'stub-id' });
  vm.runInContext(pureSource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- toGroupGameSummary: ranking (Task 11) ----------

test('toGroupGameSummary ranks players by net desc, no ties', () => {
  const context = loadPure();
  const entry = {
    gameId: 'g1', at: '2026-09-07T22:00:00.000Z',
    players: [
      { name: 'A', net: 50 },
      { name: 'B', net: 100 },
      { name: 'C', net: -150 },
    ],
  };
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(entry)})`, context);
  assert.deepEqual(summary.ranking, ['B', 'A', 'C']);
});

test('toGroupGameSummary breaks a net tie by name (he locale), regardless of input order', () => {
  const context = loadPure();
  // יוסי and דביר both net +50, the max; input order deliberately reversed from alpha order to
  // prove the sort — not the original array order — decides the tie. ד (dalet) sorts before י (yod).
  const entry = {
    gameId: 'g1', at: '2026-09-07T22:00:00.000Z',
    players: [
      { name: 'יוסי', net: 50 },
      { name: 'דביר', net: 50 },
      { name: 'רותם', net: -100 },
    ],
  };
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(entry)})`, context);
  assert.deepEqual(summary.ranking, ['דביר', 'יוסי', 'רותם']);
});

test('toGroupGameSummary ranking carries names only, matching playerNames length', () => {
  const context = loadPure();
  const entry = {
    gameId: 'g1', at: '2026-09-07T22:00:00.000Z',
    players: [{ name: 'A', net: 10 }, { name: 'B', net: -10 }],
  };
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(entry)})`, context);
  assert.equal(summary.ranking.length, 2);
  summary.ranking.forEach(name => assert.equal(typeof name, 'string'));
});

// ---------- toGroupGameSummary: durationMinutes (Task 11) ----------

test('toGroupGameSummary computes durationMinutes from startedAt to at', () => {
  const context = loadPure();
  const entry = {
    gameId: 'g1',
    startedAt: '2026-09-07T20:00:00.000Z',
    at: '2026-09-07T21:30:00.000Z',
    players: [],
  };
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(entry)})`, context);
  assert.equal(summary.durationMinutes, 90);
});

test('toGroupGameSummary durationMinutes is null when startedAt is missing', () => {
  const context = loadPure();
  const entry = { gameId: 'g1', at: '2026-09-07T21:30:00.000Z', players: [] };
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(entry)})`, context);
  assert.equal(summary.durationMinutes, null);
});

test('toGroupGameSummary durationMinutes is null when startedAt is invalid', () => {
  const context = loadPure();
  const entry = { gameId: 'g1', startedAt: 'not-a-date', at: '2026-09-07T21:30:00.000Z', players: [] };
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(entry)})`, context);
  assert.equal(summary.durationMinutes, null);
});

// ---------- formatDuration (Task 11) ----------

test('formatDuration returns "" for null/invalid input', () => {
  const context = loadPure();
  assert.equal(vm.runInContext('formatDuration(null)', context), '');
  assert.equal(vm.runInContext('formatDuration(undefined)', context), '');
  assert.equal(vm.runInContext('formatDuration(NaN)', context), '');
});

test('formatDuration renders minutes-only under an hour', () => {
  const context = loadPure();
  assert.equal(vm.runInContext('formatDuration(5)', context), '5דק׳');
  assert.equal(vm.runInContext('formatDuration(45)', context), '45דק׳');
});

test('formatDuration renders hours and minutes, or bare hours when exact', () => {
  const context = loadPure();
  assert.equal(vm.runInContext('formatDuration(65)', context), '1שע׳ 5דק׳');
  assert.equal(vm.runInContext('formatDuration(120)', context), '2שע׳');
});

// ---------- buildLeaderboard: eligibility (Task 12) ----------

function leaderboardFixture() {
  const groupId = 'grp1';
  const members = [
    { id: 'm1', groupId, guestId: 'guest-alice', displayName: 'Alice', status: 'active' },
    { id: 'm2', groupId, guestId: 'guest-bob', displayName: 'Bob', status: 'left' },
  ];
  const history = [{
    gameId: 'g1', groupId, at: '2026-09-07T22:00:00.000Z', isBalanced: true,
    players: [
      { name: 'Alice', guestId: 'guest-alice', net: 100, buyin: 100, cashout: 200 },
      { name: 'Bob', guestId: 'guest-bob', net: -50, buyin: 100, cashout: 50 },
      // Carol never joined the group (no GroupMember record shares her guestId) — an ad-hoc
      // game guest, excluded from the leaderboard per the documented eligibility deviation.
      { name: 'Carol', guestId: 'guest-carol', net: -50, buyin: 100, cashout: 50 },
    ],
  }];
  return { history, members, groupId };
}

test('buildLeaderboard excludes a participant whose guestId matches no group member', () => {
  const context = loadPure();
  const { history, members, groupId } = leaderboardFixture();
  const rows = runJSON(`buildLeaderboard(${JSON.stringify(history)}, ${JSON.stringify(members)}, ${JSON.stringify(groupId)})`, context);
  const names = rows.map(r => r.displayName);
  assert.ok(names.includes('Alice'));
  assert.ok(names.includes('Bob'));
  assert.ok(!names.includes('Carol'));
});

test('buildLeaderboard marks a former member eligible but flagged, unlike an active member', () => {
  const context = loadPure();
  const { history, members, groupId } = leaderboardFixture();
  const rows = runJSON(`buildLeaderboard(${JSON.stringify(history)}, ${JSON.stringify(members)}, ${JSON.stringify(groupId)})`, context);
  const alice = rows.find(r => r.displayName === 'Alice');
  const bob = rows.find(r => r.displayName === 'Bob');
  assert.equal(alice.isFormerMember, false);
  assert.equal(bob.isFormerMember, true);
});

// ---------- privacy regex: history and leaderboard renderers show no per-player money ----------

test('renderGroupHistoryRow and renderGroupHistory never reference fmtSigned or a .net field', () => {
  const source = sourceBetween('  function renderGroupHistoryRow(game, expanded, onToggle) {', '  function renderGroupInvite(');
  assert.doesNotMatch(source, /fmtSigned/);
  assert.doesNotMatch(source, /\.net\b/);
});

test('the only fmt( call in the history renderers is on potSize', () => {
  const source = sourceBetween('  function renderGroupHistoryRow(game, expanded, onToggle) {', '  function renderGroupInvite(');
  const calls = source.match(/\bfmt\([^)]*\)/g) || [];
  assert.ok(calls.length >= 1, 'expected at least one fmt( call for the pot');
  calls.forEach(call => assert.match(call, /potSize/));
});

test('renderGroupLeaders never references fmtSigned, a .net field, or fmt( at all', () => {
  const source = sourceBetween('  function renderGroupLeaders(entries) {', '  function renderGroupMembers(');
  assert.doesNotMatch(source, /fmtSigned/);
  assert.doesNotMatch(source, /\.net\b/);
  assert.doesNotMatch(source, /\bfmt\(/);
});

// ---------- wiring: history rows expand via an in-memory Set, ranking rendered names-only ----------

test('renderGroupHistory toggles expandedGroupGames by gameId and re-renders the group page', () => {
  const source = sourceBetween('  function renderGroupHistory(gameSummaries) {', '  function renderGroupInvite(');
  assert.match(source, /expandedGroupGames\.has\(game\.gameId\)/);
  assert.match(source, /expandedGroupGames\.delete\(game\.gameId\)/);
  assert.match(source, /expandedGroupGames\.add\(game\.gameId\)/);
  assert.match(source, /renderGroupPage\(\)/);
});

test('renderGroupHistoryRow renders the ranking as numbered, names-only rows using game.ranking', () => {
  const source = sourceBetween('  function renderGroupHistoryRow(game, expanded, onToggle) {', '  function renderGroupHistory(');
  assert.match(source, /game\.ranking/);
  assert.match(source, /\(idx \+ 1\) \+ "\. " \+ name/);
});

test('renderGroupHistoryRow shows a "לא מאוזן" tag only when the game is not balanced', () => {
  const source = sourceBetween('  function renderGroupHistoryRow(game, expanded, onToggle) {', '  function renderGroupHistory(');
  assert.match(source, /if \(!game\.isBalanced\)/);
  assert.match(source, /לא מאוזן/);
});
