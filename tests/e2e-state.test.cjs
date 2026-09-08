// Task 16: end-to-end domain scenarios. One vm engine loads the settlement pure functions,
// all four contiguous pure sections (friends / player exit / groups domain / invites), and
// addEntry, then a scenario drives them as ordinary function calls -- create a group, add
// members, start a game, buy in, rebuy, exit early, settle, close, check the leaderboard,
// leave, archive/delete -- asserting invariants after every mutating step. This proves the
// same story the browser scenarios (A-E) exercise, without a browser.
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

// ---------- engine loader ----------

// sum/wholeMoney/tableBalance/buildHistoryEntry/settlementKey/buildDebtRecords/
// updateDebtAsPaid/settle. settle() reads the free variable `state`, same as the app.
const settlementSource = sourceBetween(
  '  const sum = (a) => a.reduce((x, y) => x + y, 0);',
  '  // ---------- friends (pure) ----------'
);
// The four contiguous pure sections named in the brief: friends, player exit, groups
// domain, invites -- everything from the first marker through (not including) el().
const pureSource = sourceBetween('  // ---------- friends (pure) ----------', '  function el(');
// addEntry lives earlier in the file, next to newId/load. It also reads free `state`.
const addEntrySource = sourceBetween('  function addEntry(player, amount) {', '  function load() {');

// newId is stubbed as a deterministic counter (the app uses crypto.randomUUID) so every id
// minted in this suite is reproducible and easy to read in a failing assertion.
function newEngine() {
  const context = vm.createContext({});
  vm.runInContext(
    'var __idCounter = 0; function newId() { __idCounter += 1; return "id-" + __idCounter; }',
    context
  );
  vm.runInContext(settlementSource, context);
  vm.runInContext(pureSource, context);
  vm.runInContext(addEntrySource, context);
  return context;
}

// Runs a statement/expression in the sandbox; use for driving calls (assignments, pushes).
function run(context, code) {
  return vm.runInContext(code, context);
}
// vm.runInContext returns objects from the sandbox's own realm, so a plain deepEqual against
// a native literal fails on "same structure, not reference-equal". Round-tripping through
// JSON strips that -- same helper used by tests/groups-domain.test.cjs and siblings.
function runJSON(context, code) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- normalize() round-trip (persistence contract) ----------

// Same slice pattern as tests/groups-domain.test.cjs's legacy-migration test: normalize()
// plus the normalizers it calls (normalizeDebt is in the normalizePhase..load() slice;
// normalizeGroup/normalizeGroupMember/normalizeInvite/normalizeFriendship are in the groups
// domain (pure) section).
const normalizeCoreSource = sourceBetween('  function normalizePhase', '  function load()');
const normalizeGroupsSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');
function normalizeState(plainState) {
  return JSON.parse(vm.runInNewContext(
    normalizeCoreSource + '\n' + normalizeGroupsSource + '\nJSON.stringify(normalize(input))',
    { input: plainState, crypto: require('node:crypto').webcrypto, newId: () => 'stub-new-id' }
  ));
}

// ---------- shared invariant helpers ----------

function assertNoDuplicateIds(list, label) {
  const ids = list.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${label}: ${JSON.stringify(ids)}`);
}

function assertPlayerShapeInvariants(players, label) {
  players.forEach(p => {
    assert.equal(p.buyins.length, p.entryLog.length, `${label}: ${p.name} buyins/entryLog length mismatch`);
    p.buyins.forEach(amount => assert.ok(Number.isInteger(amount), `${label}: ${p.name} has a non-integer buyin ${amount}`));
  });
}

// Checks the invariants that must hold after every mutating step: no duplicate ids across
// players/groups/members/invites, and every player's buyins/entryLog stay in sync.
function assertInvariants(context, label) {
  const state = runJSON(context, 'state');
  assertNoDuplicateIds(state.players, `${label}: players`);
  assertNoDuplicateIds(state.groups, `${label}: groups`);
  assertNoDuplicateIds(state.groupMembers, `${label}: groupMembers`);
  assertNoDuplicateIds(state.invites, `${label}: invites`);
  assertPlayerShapeInvariants(state.players, label);
}

// A fresh current-game slot with every collection empty, the shape `newCurrentGame` expects
// as its `base` argument.
function seedState(context) {
  run(context, `
    var state = {
      example: false, gameId: 'seed-game', phase: 'closed',
      players: [], settlementStatuses: {},
      groupId: null, startedAt: null, leaderRef: null,
      history: [], debts: [],
      groups: [], groupMembers: [], invites: [], friendships: [],
      updatedAt: '2026-09-08T09:00:00.000Z',
    };
  `);
}

// ---------- Scenario A: a full group game, start to delete ----------

test('Scenario A: group creation through delete keeps ids unique, sums integer, history/debts intact', () => {
  const context = newEngine();
  seedState(context);

  // create group (buildGroupCreation) -- admin membership is created alongside the group.
  run(context, `
    var meRef = { userId: null, guestId: 'guest-me', displayName: 'דביר' };
    var created = buildGroupCreation('דביר', 'ליל שישי', null, 'guest-me', '2026-09-08T10:00:00.000Z');
    var group = created.group;
    var adminMember = created.member;
    state.groups.push(group);
    state.groupMembers.push(adminMember);
  `);
  assert.equal(run(context, 'group.name'), 'ליל שישי');
  assert.equal(run(context, 'adminMember.role'), 'admin');
  assert.equal(run(context, 'adminMember.status'), 'active');
  assertInvariants(context, 'after buildGroupCreation');

  // addGroupMember x2, then a duplicate that must be refused.
  run(context, `
    var rotemRef = { userId: null, guestId: 'guest-rotem', displayName: 'רותם' };
    var yossiRef = { userId: null, guestId: 'guest-yossi', displayName: 'יוסי' };
    var rotemMember = addGroupMember(state.groupMembers, group, rotemRef, 'member', '2026-09-08T10:05:00.000Z');
    var yossiMember = addGroupMember(state.groupMembers, group, yossiRef, 'member', '2026-09-08T10:06:00.000Z');
    var dupResult = addGroupMember(state.groupMembers, group, rotemRef, 'member', '2026-09-08T10:07:00.000Z');
  `);
  assert.ok(run(context, 'rotemMember'), 'רותם should be added');
  assert.ok(run(context, 'yossiMember'), 'יוסי should be added');
  assert.equal(run(context, 'dupResult'), null, 'a second addGroupMember for the same identity must be refused');
  assert.equal(run(context, 'state.groupMembers.length'), 3);
  assertInvariants(context, 'after addGroupMember x2 + duplicate');

  // createInvite
  run(context, `
    var invite = createInvite(state.invites, group.id, meRef, 'ABCD1234', '2026-09-08T10:08:00.000Z');
  `);
  assert.equal(run(context, 'invite.token'), 'ABCD1234');
  assert.equal(run(context, 'state.invites.length'), 1);
  assert.equal(run(context, 'activeInvite(state.invites, group.id).id'), run(context, 'invite.id'));

  // canStartGroupGame ok (no open game anywhere yet)
  assert.deepEqual(
    runJSON(context, `canStartGroupGame({ groups: state.groups, currentGame: state }, group.id)`),
    { ok: true, reason: null }
  );

  // newCurrentGame starts the group's game, preserving every other collection.
  run(context, `
    state = newCurrentGame(state, {
      phase: 'active', startedAt: '2026-09-08T20:00:00.000Z', groupId: group.id, leaderRef: meRef,
    });
  `);
  assert.equal(run(context, 'state.phase'), 'active');
  assert.equal(run(context, 'state.groupId'), run(context, 'group.id'));
  assert.equal(run(context, 'state.groups.length'), 1, 'groups must survive newCurrentGame');
  assert.equal(run(context, 'state.groupMembers.length'), 3, 'members must survive newCurrentGame');
  assert.equal(run(context, 'state.invites.length'), 1, 'invites must survive newCurrentGame');
  assert.equal(run(context, 'state.players.length'), 0);

  // createPlayer for the two members plus one ad-hoc guest (guestId not a member's).
  run(context, `
    var pDvir = createPlayer({ name: adminMember.displayName, guestId: adminMember.guestId, memberId: adminMember.id });
    var pRotem = createPlayer({ name: rotemMember.displayName, guestId: rotemMember.guestId, memberId: rotemMember.id });
    var pGuest = createPlayer({ name: 'אורח', guestId: 'guest-ad-hoc', memberId: null });
    state.players.push(pDvir, pRotem, pGuest);
  `);
  const memberGuestIds = runJSON(context, 'state.groupMembers.map(m => m.guestId)');
  assert.ok(!memberGuestIds.includes(run(context, 'pGuest.guestId')), 'the ad-hoc guest must not be a group member');
  assertInvariants(context, 'after createPlayer x3');

  // buy-ins, then a rebuy for one player.
  run(context, `
    addEntry(pDvir, 100);
    addEntry(pRotem, 100);
    addEntry(pGuest, 100);
    addEntry(pDvir, 50); // rebuy
  `);
  assertInvariants(context, 'after buy-ins + rebuy');
  const entryFields = runJSON(context, 'pDvir.entryLog.map(e => Object.keys(e).sort())');
  entryFields.forEach(keys => assert.deepEqual(keys, ['amount', 'gameId', 'id', 'playerId', 'timestamp']));
  assert.equal(run(context, 'pDvir.entryLog.every(e => typeof e.timestamp === "string" && !Number.isNaN(Date.parse(e.timestamp)))'), true);

  // exitPlayer: the guest cashes out early. A second exit attempt is refused.
  assert.equal(run(context, `exitPlayer(pGuest, 80, '2026-09-08T21:00:00.000Z')`), true);
  assert.equal(run(context, 'pGuest.status'), 'exited');
  assert.equal(run(context, 'pGuest.cashout'), 80);
  assert.equal(run(context, `exitPlayer(pGuest, 999, '2026-09-08T21:05:00.000Z')`), false, 'an already-exited player cannot exit again');

  // tableBalance before the rest cash out: not yet balanced.
  const midBalance = runJSON(context, 'tableBalance(state.players)');
  assert.equal(midBalance.isBalanced, false);
  assert.ok(Number.isInteger(midBalance.buy) && Number.isInteger(midBalance.out));

  // Cash out the rest so the difference lands on exactly 0 (buy 350 == out 350).
  run(context, `
    pDvir.cashout = 160;  // buyin 150, net +10
    pRotem.cashout = 110; // buyin 100, net +10
  `);
  const finalBalance = runJSON(context, 'tableBalance(state.players)');
  assert.equal(finalBalance.isBalanced, true);
  assert.equal(finalBalance.difference, 0);
  assert.ok(Number.isInteger(finalBalance.buy) && Number.isInteger(finalBalance.out), 'settlement sums must be integers');

  // settle(): the guest (-20) pays both winners (+10 each).
  run(context, 'var moves = settle();');
  assert.equal(run(context, 'moves.length'), 2);
  assert.equal(run(context, 'moves.every(m => m.from === pGuest.name)'), true);
  assert.equal(run(context, 'moves.every(m => m.amount === 10)'), true);
  assert.deepEqual(runJSON(context, 'moves.map(m => m.to).sort()'), runJSON(context, '[pDvir.name, pRotem.name].sort()'));

  // buildHistoryEntry + buildDebtRecords: mark the first transfer paid via settlementStatuses
  // -- it must show up as "paid" in history but must NOT become an open debt.
  run(context, `
    var paidStatuses = {};
    var firstKey = settlementKey(state.gameId, moves[0], 0);
    paidStatuses[firstKey] = true;
    var closeBalance = tableBalance(state.players);
    var historyEntry = buildHistoryEntry(state, closeBalance, '2026-09-08T22:00:00.000Z', moves, paidStatuses);
    var debtRecords = buildDebtRecords(state, moves, paidStatuses, '2026-09-08T22:00:00.000Z');
  `);
  assert.equal(run(context, 'historyEntry.transfers.length'), 2);
  assert.equal(run(context, 'historyEntry.transfers.find(t => t.id === firstKey).status'), 'paid');
  assert.equal(run(context, 'historyEntry.transfers.find(t => t.id !== firstKey).status'), 'open');
  assert.equal(run(context, 'debtRecords.length'), 1, 'the pre-paid transfer must not become a debt');
  assert.equal(run(context, 'debtRecords[0].debtorName'), run(context, 'pGuest.name'));
  assert.equal(run(context, 'debtRecords[0].amount'), 10);

  // push to history + debts, then updateDebtAsPaid: only the creditor name may mark it paid.
  run(context, `
    state.history.unshift(historyEntry);
    state.debts.push.apply(state.debts, debtRecords);
  `);
  assertInvariants(context, 'after pushing history + debts');
  assert.equal(run(context, 'state.history.length'), 1);
  assert.equal(run(context, 'state.debts.length'), 1);
  assert.equal(
    run(context, `updateDebtAsPaid(state.debts, state.debts[0].id, 'מישהו-אחר', '2026-09-08T22:30:00.000Z')`),
    false, 'a non-creditor must not be able to mark the debt paid'
  );
  assert.equal(
    run(context, `updateDebtAsPaid(state.debts, state.debts[0].id, state.debts[0].creditorName, '2026-09-08T22:30:00.000Z')`),
    true
  );
  assert.equal(run(context, 'state.debts[0].status'), 'paid');
  assert.equal(run(context, 'state.debts[0].paidAt'), '2026-09-08T22:30:00.000Z');

  // toGroupGameSummary: winners, ranking, pot size -- no per-player net exposed.
  const gameSummary = runJSON(context, 'toGroupGameSummary(historyEntry)');
  assert.deepEqual(gameSummary.winnerNames.sort(), runJSON(context, '[pDvir.name, pRotem.name].sort()'));
  assert.equal(gameSummary.potSize, 350);
  assert.equal(gameSummary.ranking[gameSummary.ranking.length - 1], run(context, 'pGuest.name'), 'the guest lost, so ranks last');
  assert.ok(!('net' in gameSummary) && !('cashout' in gameSummary));

  // buildLeaderboard: the ad-hoc guest is excluded (not a group member); members are ranked.
  const leaderboard = runJSON(context, 'buildLeaderboard(state.history, state.groupMembers, group.id)');
  const leaderboardNames = leaderboard.map(e => e.displayName);
  assert.ok(!leaderboardNames.includes('אורח'), 'a non-member guest must not appear on the leaderboard');
  assert.deepEqual(leaderboardNames.sort(), runJSON(context, '[pDvir.name, pRotem.name].sort()'));
  const forbiddenMoneyKeys = ['net', 'total', 'profit', 'amount', 'balance'];
  leaderboard.forEach(entry => assert.deepEqual(Object.keys(entry).filter(k => forbiddenMoneyKeys.includes(k)), []));

  // Close the table (mirrors finishCloseTable): reset the current-game slot.
  run(context, `state = newCurrentGame(state, { phase: 'closed' });`);
  assert.equal(run(context, 'state.groups.length'), 1);
  assert.equal(run(context, 'state.groupMembers.length'), 3);
  assert.equal(run(context, 'state.history.length'), 1);
  assert.equal(run(context, 'state.debts.length'), 1);

  // getGroupSummary: one closed game, lastGameAt set, no active game.
  const groupSummary = runJSON(
    context,
    `getGroupSummary({ groups: state.groups, groupMembers: state.groupMembers, history: state.history, currentGame: state }, group.id, 'דביר')`
  );
  assert.equal(groupSummary.gameCount, 1);
  assert.equal(groupSummary.lastGameAt, run(context, 'historyEntry.at'));
  assert.equal(groupSummary.hasActiveGame, false);
  assert.equal(groupSummary.isAdmin, true);
  assert.equal(groupSummary.memberCount, 3);

  // leaveGroup for the non-admin -- still counted on the leaderboard, but flagged former.
  assert.equal(run(context, `leaveGroup(state.groupMembers, group.id, 'רותם', '2026-09-08T23:00:00.000Z')`), true);
  const afterLeaveLeaderboard = runJSON(context, 'buildLeaderboard(state.history, state.groupMembers, group.id)');
  const rotemEntry = afterLeaveLeaderboard.find(e => e.displayName === 'רותם');
  assert.ok(rotemEntry, 'a former member keeps their leaderboard history');
  assert.equal(rotemEntry.isFormerMember, true);
  const dvirEntry = afterLeaveLeaderboard.find(e => e.displayName === 'דביר');
  assert.equal(dvirEntry.isFormerMember, false);

  // archive -> unarchive -> delete.
  assert.equal(run(context, `archiveGroup(state.groups, group.id, '2026-09-09T00:00:00.000Z')`), true);
  assert.equal(run(context, `unarchiveGroup(state.groups, group.id)`), true);
  assert.equal(run(context, `deleteGroup(state.groups, group.id, '2026-09-09T00:05:00.000Z')`), true);

  // visibleGroups is now empty, but personal records (history/debts) are untouched.
  assert.deepEqual(runJSON(context, 'visibleGroups(state.groups)'), []);
  assert.equal(run(context, 'state.history.length'), 1, 'deleting a group must not touch history');
  assert.equal(run(context, 'state.debts.length'), 1, 'deleting a group must not touch debts');
  assertInvariants(context, 'end of Scenario A');

  // normalize() round-trip: the shape must survive a save/reload cycle unchanged.
  const finalState = runJSON(context, 'state');
  const reloaded = normalizeState(JSON.parse(JSON.stringify(finalState)));
  assert.deepEqual(reloaded.groups, finalState.groups);
  assert.deepEqual(reloaded.groupMembers, finalState.groupMembers);
  assert.deepEqual(reloaded.invites, finalState.invites);
  assert.deepEqual(reloaded.friendships, finalState.friendships);
  assert.deepEqual(reloaded.debts, finalState.debts);
  assert.equal(reloaded.history.length, finalState.history.length);
  assert.equal(reloaded.phase, finalState.phase);
  assert.equal(reloaded.groupId, finalState.groupId);
  assert.deepEqual(
    reloaded.players.map(p => ({ guestId: p.guestId, memberId: p.memberId })),
    finalState.players.map(p => ({ guestId: p.guestId, memberId: p.memberId }))
  );
});

// ---------- Scenario B: an ungrouped game ----------

test('Scenario B: an ungrouped game (groupId null) settles the same way and never touches a group summary', () => {
  const context = newEngine();
  seedState(context);

  // A group exists on the side, purely to prove the ungrouped game does not affect it.
  run(context, `
    var created = buildGroupCreation('דביר', 'קבוצה אחרת', null, 'guest-me', '2026-09-08T10:00:00.000Z');
    state.groups.push(created.group);
    state.groupMembers.push(created.member);
  `);

  // newCurrentGame with an explicit groupId: null (an ungrouped game).
  run(context, `
    state = newCurrentGame(state, { phase: 'active', startedAt: '2026-09-08T18:00:00.000Z', groupId: null });
  `);
  assert.equal(run(context, 'state.groupId'), null);

  run(context, `
    var pA = createPlayer({ name: 'א', guestId: null, memberId: null });
    var pB = createPlayer({ name: 'ב', guestId: null, memberId: null });
    state.players.push(pA, pB);
    addEntry(pA, 100);
    addEntry(pB, 100);
  `);
  assertInvariants(context, 'Scenario B after buy-ins');

  // pA exits early; pB's cashout is set so the table balances at 0.
  assert.equal(run(context, `exitPlayer(pA, 60, '2026-09-08T19:00:00.000Z')`), true);
  run(context, `pB.cashout = 140;`); // buyin 100, net +40, matching pA's -40
  const balance = runJSON(context, 'tableBalance(state.players)');
  assert.equal(balance.isBalanced, true);

  run(context, `
    var moves = settle();
    var historyEntry = buildHistoryEntry(state, tableBalance(state.players), '2026-09-08T19:30:00.000Z', moves, {});
    var debtRecords = buildDebtRecords(state, moves, {}, '2026-09-08T19:30:00.000Z');
    state.history.unshift(historyEntry);
    state.debts.push.apply(state.debts, debtRecords);
    state = newCurrentGame(state, { phase: 'closed' });
  `);
  assert.equal(run(context, 'historyEntry.groupId'), null, 'an ungrouped game must record groupId: null in history');
  assertInvariants(context, 'end of Scenario B');

  // getGroupSummaries for the side group is unaffected by the ungrouped game.
  const summaries = runJSON(
    context,
    `getGroupSummaries({ groups: state.groups, groupMembers: state.groupMembers, history: state.history, currentGame: state }, 'דביר')`
  );
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].gameCount, 0, 'the ungrouped game must not count toward the group');
  assert.equal(summaries[0].lastGameAt, null);
});

// ---------- Scenario C/D: initial view routing follows the persisted phase ----------

test('Scenario C/D: initialAppView routes open games to their phase and otherwise opens profile', () => {
  const source = sourceBetween('  function normalizePhase', '  function normalizeDebt');
  const openGameSource = sourceBetween('  function hasOpenPhase(currentGame) {', '  // The engine has one current-game slot');
  const context = vm.createContext({});
  vm.runInContext(openGameSource + source, context);
  assert.equal(vm.runInContext(`initialAppView({ phase: 'active', example: false, players: [{}] })`, context), 'game');
  assert.equal(vm.runInContext(`initialAppView({ phase: 'settlement', example: false, players: [{}] })`, context), 'settle');
  assert.equal(vm.runInContext(`initialAppView({ phase: 'active', example: false, players: [] })`, context), 'profile');
  assert.equal(vm.runInContext(`initialAppView({ phase: 'closed', example: false, players: [] })`, context), 'profile');
});
