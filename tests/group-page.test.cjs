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

// ---------- toGroupGameSummary (pure) ----------

function historyEntryFixture() {
  return {
    gameId: 'g1',
    at: '2026-09-07T22:00:00.000Z',
    startedAt: '2026-09-07T20:00:00.000Z',
    isBalanced: true,
    players: [
      { id: 'p1', name: 'דביר', entryLog: [{ id: 'e1' }, { id: 'e2' }], buyin: 100, cashout: 150, net: 50 },
      { id: 'p2', name: 'יוסי', entryLog: [{ id: 'e3' }], buyin: 100, cashout: 150, net: 50 },
      { id: 'p3', name: 'רותם', entryLog: [{ id: 'e4' }], buyin: 100, cashout: 0, net: -100 },
    ],
  };
}

test('toGroupGameSummary carries gameId/at/startedAt/isBalanced and derives playerCount/playerNames', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(historyEntryFixture())})`, context);
  assert.equal(summary.gameId, 'g1');
  assert.equal(summary.at, '2026-09-07T22:00:00.000Z');
  assert.equal(summary.startedAt, '2026-09-07T20:00:00.000Z');
  assert.equal(summary.isBalanced, true);
  assert.equal(summary.playerCount, 3);
  assert.deepEqual(summary.playerNames, ['דביר', 'יוסי', 'רותם']);
});

test('toGroupGameSummary winnerNames includes every tied top-net player', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(historyEntryFixture())})`, context);
  // דביר and יוסי both net +50, the max — both are winners; רותם (net -100) is not.
  assert.deepEqual(summary.winnerNames, ['דביר', 'יוסי']);
});

test('toGroupGameSummary potSize sums player buyin, totalEntries sums entryLog lengths', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(historyEntryFixture())})`, context);
  assert.equal(summary.potSize, 300); // 100 + 100 + 100
  assert.equal(summary.totalEntries, 4); // 2 + 1 + 1
});

test('toGroupGameSummary never exposes a per-player net or cashout field', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(historyEntryFixture())})`, context);
  const forbidden = ['net', 'cashout', 'players'];
  assert.deepEqual(Object.keys(summary).filter(k => forbidden.includes(k)), []);
});

test('toGroupGameSummary handles a missing/empty entry safely', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(null)`, context);
  assert.equal(summary.playerCount, 0);
  assert.deepEqual(summary.playerNames, []);
  assert.deepEqual(summary.winnerNames, []);
  assert.equal(summary.potSize, 0);
  assert.equal(summary.totalEntries, 0);
  assert.equal(summary.isBalanced, false);
});

// ---------- formatMemberCount (pure) ----------

const formatSource = sourceBetween('  function formatPlayerCount(count) {', '  function renderQuickActions(parent) {');

function loadFormat() {
  const context = vm.createContext({});
  vm.runInContext(formatSource, context);
  return context;
}

test('formatMemberCount uses the singular for exactly one member', () => {
  const context = loadFormat();
  assert.equal(vm.runInContext('formatMemberCount(1)', context), 'חבר אחד');
});

test('formatMemberCount uses the plural with a count for zero or many members', () => {
  const context = loadFormat();
  assert.equal(vm.runInContext('formatMemberCount(0)', context), '0 חברים');
  assert.equal(vm.runInContext('formatMemberCount(3)', context), '3 חברים');
});

// ---------- wiring: renderGroupPage composes the five sub-renderers ----------
// (Task 11 removed the separate "last game" section: it was fully redundant with the first
// row of the now-unlimited history list, which shows the same date/players/winner line.)

test('renderGroupPage calls each of the five sub-renderers', () => {
  const source = sourceBetween('  function renderGroupPage() {', '  function render() {');
  assert.match(source, /renderGroupHeader\(summary\)/);
  assert.match(source, /renderGroupPrimaryAction\(summary, canStartGroupGame\(/);
  // Group leaderboard/history now read the safe server aggregate (group_leaderboard_public_v /
  // group_game_summaries_v) when this pull fetched one, falling back to buildLeaderboard /
  // groupClosedGames+toGroupGameSummary exactly as before when it did not (offline, or the
  // aggregate SQL not yet applied) — see resolveGroupLeaderboard/resolveGroupGameSummaries.
  assert.match(source, /renderGroupLeaders\(resolveGroupLeaderboard\(/);
  assert.match(source, /renderGroupMembers\(summary, activeMembers\(/);
  assert.match(source, /renderGroupHistory\(gameSummaries\)/);
  assert.doesNotMatch(source, /renderGroupLastGame/);
  // bails out to the dashboard rather than stranding the user on a deleted group
  assert.match(source, /if \(!summary\) \{ setAppView\("games"\); return; \}/);
});

test('renderGroupPage builds game summaries through resolveGroupGameSummaries (aggregate-or-local)', () => {
  const source = sourceBetween('  function renderGroupPage() {', '  function render() {');
  assert.match(source, /resolveGroupGameSummaries\(collections, currentGroupId, cloudGroupAggregates\)/);
});

// ---------- wiring: renderGroupPrimaryAction ----------

test('the primary action reads summary.hasActiveGame and summary.activeGamePhase to choose its label', () => {
  const source = sourceBetween('  function renderGroupPrimaryAction(summary, gate) {', '  function renderGroupLeaders(');
  assert.match(source, /summary\.hasActiveGame/);
  assert.match(source, /summary\.activeGamePhase === "settlement"/);
  assert.match(source, /כנס לשולחן/);
  assert.match(source, /המשך סגירה/);
  assert.match(source, /continueCurrentGame/);
});

test('the primary action renders "התחל משחק" disabled with the right quiet reason per gate.reason', () => {
  const source = sourceBetween('  function renderGroupPrimaryAction(summary, gate) {', '  function renderGroupLeaders(');
  assert.match(source, /התחל משחק/);
  assert.match(source, /btn\.disabled = true/);
  assert.match(source, /aria-disabled/);
  assert.match(source, /יש כבר משחק פתוח בקבוצה/);
  assert.match(source, /יש משחק פעיל אחר/);
  assert.match(source, /הקבוצה בארכיון/);
});

// ---------- wiring: history owns the empty state, shows every game ----------

test('renderGroupHistory owns the "no games yet" empty state and does not cap the list', () => {
  const source = sourceBetween('  function renderGroupHistory(gameSummaries) {', '  function renderGroupInvite(');
  assert.match(source, /עוד אין משחקים/);
  assert.doesNotMatch(source, /\.slice\(0, 5\)/);
});

test('renderGroupLeaders shows the pre-first-game empty state and renders the full list, uncapped', () => {
  const source = sourceBetween('  function renderGroupLeaders(entries) {', '  function renderGroupMembers(');
  assert.match(source, /הדירוג יופיע אחרי המשחק הראשון/);
  assert.doesNotMatch(source, /\.slice\(0, 3\)/);
});

// ---------- the group card also uses formatMemberCount (fixes "1 חברים") ----------

test('renderGroupCard formats its member count with formatMemberCount, not a raw concatenation', () => {
  const source = sourceBetween('  function renderGroupCard(group, actions) {', '  function renderGroupsSection(');
  assert.match(source, /formatMemberCount\(Number\(group\.memberCount \|\| 0\)\)/);
  assert.doesNotMatch(source, /\+ " חברים"/);
});
