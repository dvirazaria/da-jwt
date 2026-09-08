// Cloud persistence for games (Supabase phase 2b).
//
// Phase 2a moved groups/members/invites/friendships to the server. Phase 2b moves the thing the
// product is actually about: the table itself — participants, buy-in entries, the close (transfers
// + debts) — plus a realtime channel so two phones at the same table stay in sync.
//
// The contract this suite pins down:
//   * a game, a participant, an entry, a transfer and a debt each map to exactly the columns and
//     CHECK constraints in docs/backend/schema.sql, and come back unchanged;
//   * money stays integer and a cashout that was never typed ("") is NULL, not 0;
//   * a legacy row the schema would refuse (non-uuid id, a participant with no identity) takes its
//     whole game out of the payload rather than sending a half game;
//   * buildHistoryEntryFromCloud rebuilds the SAME HistoryEntry the local close would have built;
//   * the single-slot rule: an empty/closed slot loads the server's open game, the same id
//     replaces, a different open game is kept locally (documented limitation, not a bug);
//   * the realtime apply is parked, never yanked out from under an active <input>.
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

const pureSource = sourceBetween('  // ---------- cloud mapping (pure) ----------', '  function el(');
// buildHistoryEntry + settlementKey + sum/wholeMoney live in the settlement block; the
// equivalence test below runs the local builder and the cloud builder side by side.
const settlementSource = sourceBetween(
  '  const sum = (a) => a.reduce((x, y) => x + y, 0);',
  '  // ---------- friends (pure) ----------'
);

function load() {
  const context = vm.createContext({ console: { warn() {} } });
  vm.runInContext(pureSource, context);
  return context;
}
function loadWithSettlement() {
  const context = vm.createContext({ console: { warn() {} } });
  vm.runInContext(settlementSource, context);
  vm.runInContext(pureSource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}
const lit = value => JSON.stringify(value);

// Same id vocabulary as tests/cloud-mapping.test.cjs.
const P1 = '11111111-1111-4111-8111-111111111111';  // me
const P2 = '88888888-8888-4888-8888-888888888888';  // another account
const G1 = '22222222-2222-4222-8222-222222222222';  // my local guestId
const GU2 = '55555555-5555-4555-8555-555555555555'; // a real guest
const GR1 = '33333333-3333-4333-8333-333333333333'; // a group
const M1 = '44444444-4444-4444-8444-444444444444';  // my membership
const M2 = '66666666-6666-4666-8666-666666666666';  // the guest's membership
const GAME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GAME2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PL1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // my player row
const PL2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // the guest's player row
const EN1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EN2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const MEMBERS = [
  { id: M1, groupId: GR1, userId: null, guestId: G1, displayName: 'דביר', role: 'admin', status: 'active', joinedAt: 't', leftAt: null, hiddenAt: null },
  { id: M2, groupId: GR1, userId: null, guestId: GU2, displayName: 'יוסי', role: 'member', status: 'active', joinedAt: 't', leftAt: null, hiddenAt: null },
];
const CTX = { profileId: P1, guestId: G1, displayName: 'דביר', profileIds: [P1, P2], groupMembers: MEMBERS, gameCreators: {} };
const ctxLiteral = lit(CTX);

// An open table: me (a profile) and a guest, one rebuy, one cashout typed, one not.
function openSnapshot() {
  return {
    gameId: GAME,
    groupId: GR1,
    phase: 'active',
    startedAt: '2026-09-06T19:00:00.000Z',
    closedAt: null,
    isBalanced: null,
    balanceDifference: null,
    leaderRef: { userId: null, guestId: G1, displayName: 'דביר' },
    players: [
      { id: PL1, name: 'דביר', buyins: [50, 100], cashout: 220, status: 'active', exitedAt: null,
        guestId: G1, memberId: M1, userId: null,
        entryLog: [
          { id: EN1, timestamp: '2026-09-06T19:01:00.000Z', amount: 50, playerId: PL1, gameId: GAME },
          { id: EN2, timestamp: null, amount: 100, playerId: PL1, gameId: GAME },
        ] },
      { id: PL2, name: 'יוסי', buyins: [50], cashout: '', status: 'active', exitedAt: null,
        guestId: GU2, memberId: M2, userId: null,
        entryLog: [{ id: '99999999-9999-4999-8999-999999999999', timestamp: '2026-09-06T19:02:00.000Z', amount: 50, playerId: PL2, gameId: GAME }] },
    ],
    transfers: [],
  };
}

// ---------- games ----------

test('an open game maps to the games columns and back, with no closing columns set', () => {
  const context = load();
  const row = runJSON(`gameToRow(${lit(openSnapshot())}, ${ctxLiteral})`, context);
  assert.deepEqual(row, {
    id: GAME,
    group_id: GR1,
    leader_profile_id: P1,
    leader_guest_id: null,
    phase: 'active',
    started_at: '2026-09-06T19:00:00.000Z',
    closed_at: null,
    is_balanced: null,
    balance_difference: null,
    created_by: P1,
    created_at: '2026-09-06T19:00:00.000Z',
  });
  // games_closed_at_chk: (phase = 'closed') = (closed_at IS NOT NULL)
  assert.equal(runJSON(`CLOUD_PUSHABLE.games(${lit(row)})`, context), true);
});

test('a closed game carries closed_at, is_balanced and balance_difference (games_closed_balance_chk)', () => {
  const context = load();
  const snapshot = { ...openSnapshot(), phase: 'closed', closedAt: '2026-09-06T23:30:00.000Z', isBalanced: false, balanceDifference: -20 };
  const row = runJSON(`gameToRow(${lit(snapshot)}, ${ctxLiteral})`, context);
  assert.equal(row.phase, 'closed');
  assert.equal(row.closed_at, '2026-09-06T23:30:00.000Z');
  assert.equal(row.is_balanced, false);
  assert.equal(row.balance_difference, -20);
  assert.equal(runJSON(`CLOUD_PUSHABLE.games(${lit(row)})`, context), true);
  // A closed row with no balance would violate games_closed_balance_chk: never send it.
  const broken = { ...row, is_balanced: null, balance_difference: null };
  assert.equal(runJSON(`CLOUD_PUSHABLE.games(${lit(broken)})`, context), false);
});

test('a guest leader lands in leader_guest_id, and games_leader_identity_chk is never violated', () => {
  const context = load();
  const snapshot = { ...openSnapshot(), leaderRef: { userId: null, guestId: GU2, displayName: 'יוסי' } };
  const row = runJSON(`gameToRow(${lit(snapshot)}, ${ctxLiteral})`, context);
  assert.equal(row.leader_profile_id, null);
  assert.equal(row.leader_guest_id, GU2);
  const noLeader = runJSON(`gameToRow(${lit({ ...openSnapshot(), leaderRef: null, groupId: null })}, ${ctxLiteral})`, context);
  assert.equal(noLeader.leader_profile_id, null);
  assert.equal(noLeader.leader_guest_id, null);
  assert.equal(noLeader.group_id, null, 'an ungrouped game keeps group_id NULL');
});

test('games.created_by keeps whoever actually created the game, so two devices never fight over it', () => {
  const context = load();
  const ctx = { ...CTX, gameCreators: { [GAME]: P2 } };
  assert.equal(runJSON(`gameToRow(${lit(openSnapshot())}, ${lit(ctx)})`, context).created_by, P2);
});

test('a closed game row is opened back up into a shell so it can be inserted before it is closed', () => {
  const context = load();
  const snapshot = { ...openSnapshot(), phase: 'closed', closedAt: '2026-09-06T23:30:00.000Z', isBalanced: true, balanceDifference: 0 };
  const closedRow = runJSON(`gameToRow(${lit(snapshot)}, ${ctxLiteral})`, context);
  const shell = runJSON(`cloudGameOpenShell(${lit(closedRow)})`, context);
  // games_insert_member has WITH CHECK (... phase <> 'closed' ...): a closed game can only ever
  // be reached by UPDATE, so the insert goes in open and the close is the second write.
  assert.equal(shell.phase, 'settlement');
  assert.equal(shell.closed_at, null);
  assert.equal(shell.is_balanced, null);
  assert.equal(shell.balance_difference, null);
  assert.equal(shell.id, GAME);
});

// ---------- participants ----------

test('a participant maps to game_participants and back; my player is the profile, everyone else a guest', () => {
  const context = load();
  const snapshot = openSnapshot();
  const mine = runJSON(`participantToRow(${lit(snapshot.players[0])}, '${GAME}', ${ctxLiteral})`, context);
  assert.deepEqual(mine, {
    id: PL1, game_id: GAME, profile_id: P1, guest_id: null,
    display_name_snapshot: 'דביר', status: 'active', exited_at: null, cashout: 220,
  });
  const guest = runJSON(`participantToRow(${lit(snapshot.players[1])}, '${GAME}', ${ctxLiteral})`, context);
  assert.equal(guest.profile_id, null);
  assert.equal(guest.guest_id, GU2);
  // game_participants.cashout is "not entered yet" as NULL, never 0.
  assert.equal(guest.cashout, null);
});

test('an exited player carries exited_at (game_participants_exit_chk) and an integer cashout', () => {
  const context = load();
  const player = { ...openSnapshot().players[1], status: 'exited', exitedAt: '2026-09-06T21:00:00.000Z', cashout: '75.4' };
  const row = runJSON(`participantToRow(${lit(player)}, '${GAME}', ${ctxLiteral})`, context);
  assert.equal(row.status, 'exited');
  assert.equal(row.exited_at, '2026-09-06T21:00:00.000Z');
  assert.equal(row.cashout, 75, 'money is integer everywhere');
  assert.equal(runJSON(`CLOUD_PUSHABLE.gameParticipants(${lit(row)})`, context), true);
  const noExitTime = { ...row, exited_at: null };
  assert.equal(runJSON(`CLOUD_PUSHABLE.gameParticipants(${lit(noExitTime)})`, context), false);
});

test('participant rows rebuild players with their buy-ins, entry log, cashout "" and memberId', () => {
  const context = load();
  const snapshot = openSnapshot();
  const rows = snapshot.players.map(p => runJSON(`participantToRow(${lit(p)}, '${GAME}', ${ctxLiteral})`, context));
  const entryRows = [];
  snapshot.players.forEach(p => p.entryLog.forEach(entry => {
    entryRows.push(runJSON(`entryToRow(${lit(entry)}, '${GAME}', '${p.id}')`, context));
  }));
  const players = runJSON(`rowsToPlayers(${lit(rows)}, ${lit(entryRows)}, '${GR1}', ${ctxLiteral})`, context);
  assert.equal(players.length, 2);
  assert.deepEqual(players[0].buyins, [50, 100]);
  assert.equal(players[0].cashout, 220);
  assert.equal(players[0].guestId, G1);
  assert.equal(players[0].memberId, M1, 'memberId is resolved locally against the group members');
  assert.equal(players[0].userId, P1, 'a profile-backed participant keeps its profile id');
  assert.deepEqual(players[0].entryLog.map(e => e.id), [EN1, EN2]);
  assert.equal(players[0].entryLog[1].timestamp, null, 'a legacy entry never gains an invented time');
  assert.equal(players[1].cashout, '', 'a cashout that was never typed comes back as "", not 0');
  assert.equal(players[1].memberId, M2);
});

// ---------- entries ----------

test('an entry maps to the entries columns and back, legacy null timestamp included', () => {
  const context = load();
  const entry = { id: EN1, timestamp: '2026-09-06T19:01:00.000Z', amount: 50, playerId: PL1, gameId: GAME };
  const row = runJSON(`entryToRow(${lit(entry)}, '${GAME}', '${PL1}')`, context);
  assert.deepEqual(row, { id: EN1, game_id: GAME, participant_id: PL1, amount: 50, created_at: '2026-09-06T19:01:00.000Z' });
  assert.deepEqual(runJSON(`rowToEntry(${lit(row)})`, context), entry);

  // entries.created_at COMMENT: "NULL for legacy rows ... never invent one".
  const legacy = { ...entry, timestamp: null };
  const legacyRow = runJSON(`entryToRow(${lit(legacy)}, '${GAME}', '${PL1}')`, context);
  assert.equal(legacyRow.created_at, null);
  assert.deepEqual(runJSON(`rowToEntry(${lit(legacyRow)})`, context), legacy);
  assert.equal(runJSON(`CLOUD_PUSHABLE.entries(${lit(legacyRow)})`, context), true);
  assert.equal(runJSON(`CLOUD_PUSHABLE.entries(${lit({ ...legacyRow, amount: 0 })})`, context), false);
});

// ---------- transfers + debts ----------

test('a transfer maps to the transfers columns, keeping the settlement key and the paid status', () => {
  const context = load();
  const transfer = { id: GAME + '::0::יוסי::דביר::120', from: 'יוסי', to: 'דביר', amount: 120, status: 'paid' };
  const byName = { יוסי: PL2, דביר: PL1 };
  const row = runJSON(`transferToRow(${lit(transfer)}, '${GAME}', 0, ${lit(byName)})`, context);
  assert.equal(row.game_id, GAME);
  assert.equal(row.from_participant_id, PL2);
  assert.equal(row.to_participant_id, PL1);
  assert.equal(row.amount, 120);
  assert.equal(row.status, 'paid');
  assert.equal(row.settlement_key, transfer.id, 'transfers.settlement_key IS the local transfer id');
  assert.equal(row.sort_order, 0);
  // transfers.id is a uuid column, so the settlement key gets a deterministic uuid of its own.
  assert.equal(runJSON(`CLOUD_PUSHABLE.transfers(${lit(row)})`, context), true);
  assert.equal(row.id, runJSON(`cloudUuidFrom(${lit(transfer.id)})`, context));
  const nameById = { [PL1]: 'דביר', [PL2]: 'יוסי' };
  assert.deepEqual(runJSON(`rowToTransfer(${lit(row)}, ${lit(nameById)})`, context), transfer);
});

test('cloudUuidFrom is deterministic, uuid-shaped and different for different keys', () => {
  const context = load();
  const a = runJSON(`cloudUuidFrom('debt-x::0::א::ב::10')`, context);
  const b = runJSON(`cloudUuidFrom('debt-x::0::א::ב::10')`, context);
  const c = runJSON(`cloudUuidFrom('debt-x::1::א::ב::10')`, context);
  assert.equal(a, b, 'two devices computing the same settlement must reach the same row');
  assert.notEqual(a, c);
  assert.equal(runJSON(`isCloudId('${a}')`, context), true);
});

test('a debt maps to the debts columns with one identity per side and back again', () => {
  const context = load();
  const key = GAME + '::0::יוסי::דביר::120';
  const debt = {
    id: 'debt-' + key, gameId: GAME, groupId: GR1,
    debtorUserId: PL2, creditorUserId: PL1, debtorName: 'יוסי', creditorName: 'דביר',
    amount: 120, status: 'open', createdAt: '2026-09-06T23:30:00.000Z',
    gameDate: '2026-09-06T23:30:00.000Z', paidAt: null,
  };
  const identityByName = { יוסי: { profile_id: null, guest_id: GU2 }, דביר: { profile_id: P1, guest_id: null } };
  const row = runJSON(`debtToRow(${lit(debt)}, ${ctxLiteral}, ${lit(identityByName)})`, context);
  assert.equal(row.game_id, GAME);
  assert.equal(row.group_id, GR1);
  assert.equal(row.debtor_guest_id, GU2);
  assert.equal(row.debtor_profile_id, null);
  assert.equal(row.creditor_profile_id, P1);
  assert.equal(row.creditor_guest_id, null);
  assert.equal(row.amount, 120);
  // debts_insert_on_close: WITH CHECK (status = 'open' AND paid_at IS NULL). The paid flip is a
  // separate column-limited UPDATE, never part of the insert payload.
  assert.equal(row.status, 'open');
  assert.equal(row.paid_at, null);
  assert.equal(row.transfer_id, runJSON(`cloudUuidFrom(${lit(key)})`, context));
  assert.equal(runJSON(`CLOUD_PUSHABLE.debts(${lit(row)})`, context), true);

  const keyByTransferId = { [row.transfer_id]: key };
  const back = runJSON(`rowToDebt(${lit(row)}, ${ctxLiteral}, ${lit(keyByTransferId)})`, context);
  assert.equal(back.id, debt.id, 'the local debt id is rebuilt from the transfer settlement key');
  assert.equal(back.gameId, GAME);
  assert.equal(back.debtorName, 'יוסי');
  assert.equal(back.creditorName, 'דביר');
  assert.equal(back.amount, 120);
  assert.equal(back.status, 'open');
});

test('a paid debt is pushed as a column-limited status update, not as an insert', () => {
  const context = load();
  const debt = {
    id: 'debt-' + GAME + '::0::יוסי::דביר::120', gameId: GAME, groupId: GR1,
    debtorUserId: PL2, creditorUserId: PL1, debtorName: 'יוסי', creditorName: 'דביר',
    amount: 120, status: 'paid', createdAt: 't', gameDate: 't', paidAt: '2026-09-07T08:00:00.000Z',
  };
  const identityByName = { יוסי: { profile_id: null, guest_id: GU2 }, דביר: { profile_id: P1, guest_id: null } };
  const insertRow = runJSON(`debtToRow(${lit(debt)}, ${ctxLiteral}, ${lit(identityByName)})`, context);
  assert.equal(insertRow.status, 'open');
  const payment = runJSON(`debtPaymentRow(${lit(debt)}, ${ctxLiteral}, ${lit(identityByName)})`, context);
  // GRANT UPDATE (status, paid_at, paid_by_profile_id) ON debts — exactly those three columns.
  assert.deepEqual(Object.keys(payment).sort(), ['id', 'paid_at', 'paid_by_profile_id', 'status'].sort());
  assert.equal(payment.status, 'paid');
  assert.equal(payment.paid_at, '2026-09-07T08:00:00.000Z');
  assert.equal(payment.paid_by_profile_id, P1);
  // Only the creditor may flip it (debts_update_creditor), so a debt I do not own is not sent.
  const notMine = { ...debt, creditorName: 'יוסי', debtorName: 'דביר' };
  assert.equal(runJSON(`debtPaymentRow(${lit(notMine)}, ${ctxLiteral}, ${lit({ 'יוסי': { profile_id: null, guest_id: GU2 }, 'דביר': { profile_id: P1, guest_id: null } })})`, context), null);
});

// ---------- buildCloudRows ----------

function collectionsWithGame(snapshot) {
  return {
    groups: [{ id: GR1, name: 'ערב פוקר', avatarDataUrl: null, createdBy: { userId: null, guestId: G1, displayName: 'דביר' }, createdAt: 't', archivedAt: null, deletedAt: null }],
    groupMembers: MEMBERS,
    invites: [],
    friendships: [],
    games: snapshot ? [snapshot] : [],
    debts: [],
  };
}

test('buildCloudRows emits the game payload in FK order and mints a guest row for every guest player', () => {
  const context = load();
  const rows = runJSON(`buildCloudRows(${lit(collectionsWithGame(openSnapshot()))}, ${ctxLiteral})`, context);
  assert.deepEqual(Object.keys(rows), [
    'guests', 'groups', 'groupMembers', 'invites', 'friendships',
    'games', 'gameParticipants', 'entries', 'transfers', 'gamesClosed', 'debts', 'debtPayments',
  ]);
  assert.deepEqual(rows.games.map(r => r.id), [GAME]);
  assert.deepEqual(rows.gamesClosed, []);
  assert.deepEqual(rows.gameParticipants.map(r => r.id).sort(), [PL1, PL2].sort());
  assert.equal(rows.entries.length, 3);
  assert.ok(rows.guests.some(g => g.id === GU2), 'the guest player needs a guests row before the participant');
});

test('a closed game leaves through gamesClosed, with its transfers and debts', () => {
  const context = load();
  const key = GAME + '::0::יוסי::דביר::100';
  const snapshot = {
    ...openSnapshot(),
    phase: 'closed', closedAt: '2026-09-06T23:30:00.000Z', isBalanced: true, balanceDifference: 0,
    players: openSnapshot().players.map(p => (p.id === PL2 ? { ...p, cashout: 0 } : { ...p, cashout: 200 })),
    transfers: [{ id: key, from: 'יוסי', to: 'דביר', amount: 100, status: 'open' }],
  };
  const collections = collectionsWithGame(snapshot);
  collections.debts = [{
    id: 'debt-' + key, gameId: GAME, groupId: GR1, debtorUserId: PL2, creditorUserId: PL1,
    debtorName: 'יוסי', creditorName: 'דביר', amount: 100, status: 'open',
    createdAt: '2026-09-06T23:30:00.000Z', gameDate: '2026-09-06T23:30:00.000Z', paidAt: null,
  }];
  const rows = runJSON(`buildCloudRows(${lit(collections)}, ${ctxLiteral})`, context);
  assert.deepEqual(rows.games, [], 'a closed game is never in the open-game payload');
  assert.deepEqual(rows.gamesClosed.map(r => r.id), [GAME]);
  assert.equal(rows.gamesClosed[0].phase, 'closed');
  assert.equal(rows.transfers.length, 1);
  assert.equal(rows.debts.length, 1);
  assert.equal(rows.debts[0].game_id, GAME);
});

test('a game with a participant the schema would refuse is dropped whole, never half-sent', () => {
  const context = load();
  const snapshot = openSnapshot();
  // An ad-hoc player with no guestId has no identity at all: game_participants_identity_chk.
  snapshot.players[1] = { ...snapshot.players[1], guestId: null, memberId: null };
  const rows = runJSON(`buildCloudRows(${lit(collectionsWithGame(snapshot))}, ${ctxLiteral})`, context);
  assert.deepEqual(rows.games, []);
  assert.deepEqual(rows.gameParticipants, []);
  assert.deepEqual(rows.entries, []);
});

test('a legacy game (non-uuid ids) never leaves the device', () => {
  const context = load();
  const snapshot = { ...openSnapshot(), gameId: 'legacy-abc' };
  snapshot.players = snapshot.players.map(p => ({ ...p, id: 'legacy-abc-player-0' }));
  const rows = runJSON(`buildCloudRows(${lit(collectionsWithGame(snapshot))}, ${ctxLiteral})`, context);
  assert.deepEqual(rows.games, []);
  assert.deepEqual(rows.entries, []);
});

// ---------- buildHistoryEntryFromCloud ----------

test('buildHistoryEntryFromCloud rebuilds the very HistoryEntry the local close would have written', () => {
  const context = loadWithSettlement();
  const closingAt = '2026-09-06T23:30:00.000Z';
  const snapshot = {
    gameId: GAME, groupId: GR1, startedAt: '2026-09-06T19:00:00.000Z',
    leaderRef: { userId: null, guestId: G1, displayName: 'דביר' },
    players: [
      { id: PL1, name: 'דביר', buyins: [50, 100], cashout: 250, status: 'active', exitedAt: null,
        guestId: G1, memberId: M1,
        entryLog: [
          { id: EN1, timestamp: '2026-09-06T19:01:00.000Z', amount: 50, playerId: PL1, gameId: GAME },
          { id: EN2, timestamp: null, amount: 100, playerId: PL1, gameId: GAME },
        ] },
      { id: PL2, name: 'יוסי', buyins: [100], cashout: 0, status: 'exited', exitedAt: '2026-09-06T22:00:00.000Z',
        guestId: GU2, memberId: M2,
        entryLog: [{ id: '99999999-9999-4999-8999-999999999999', timestamp: '2026-09-06T19:02:00.000Z', amount: 100, playerId: PL2, gameId: GAME }] },
    ],
  };
  const moves = [{ from: 'יוסי', to: 'דביר', amount: 100 }];
  const local = runJSON(`buildHistoryEntry(${lit(snapshot)}, { isBalanced: true, difference: 0 }, '${closingAt}', ${lit(moves)}, {})`, context);

  // Now the same game, as the server holds it.
  const cloudSnapshot = { ...snapshot, phase: 'closed', closedAt: closingAt, isBalanced: true, balanceDifference: 0, transfers: local.transfers };
  const gameRow = runJSON(`gameToRow(${lit(cloudSnapshot)}, ${ctxLiteral})`, context);
  const participantRows = snapshot.players.map(p => runJSON(`participantToRow(${lit(p)}, '${GAME}', ${ctxLiteral})`, context));
  const entryRows = [];
  snapshot.players.forEach(p => p.entryLog.forEach(entry => {
    entryRows.push(runJSON(`entryToRow(${lit(entry)}, '${GAME}', '${p.id}')`, context));
  }));
  const byName = { דביר: PL1, יוסי: PL2 };
  const transferRows = local.transfers.map((t, i) => runJSON(`transferToRow(${lit(t)}, '${GAME}', ${i}, ${lit(byName)})`, context));

  const rebuilt = runJSON(
    `buildHistoryEntryFromCloud(${lit(gameRow)}, ${lit(participantRows)}, ${lit(entryRows)}, ${lit(transferRows)}, ${ctxLiteral})`,
    context);

  assert.equal(rebuilt.gameId, local.gameId);
  assert.equal(rebuilt.at, local.at);
  assert.equal(rebuilt.groupId, local.groupId);
  assert.equal(rebuilt.startedAt, local.startedAt);
  assert.equal(rebuilt.isBalanced, local.isBalanced);
  assert.equal(rebuilt.balanceDifference, local.balanceDifference);
  assert.deepEqual(rebuilt.transfers, local.transfers);
  assert.deepEqual(rebuilt.players.map(p => ({ ...p, entryLog: p.entryLog })),
    local.players.map(p => ({ ...p, entryLog: p.entryLog })));
  // leaderRef keeps the same person; the profile id it gained is the whole point of phase 2b.
  assert.equal(rebuilt.leaderRef.displayName, 'דביר');
  assert.equal(rebuilt.leaderRef.guestId, G1);
  assert.equal(rebuilt.leaderRef.userId, P1);
});

// ---------- the single open slot ----------

test('the open-game slot rule: empty or closed loads, same id replaces, a different open game is kept', () => {
  const context = load();
  const incoming = { gameId: GAME };
  const other = { gameId: GAME2 };
  const pick = (local, games) => runJSON(`pickCloudOpenGame(${lit(local)}, ${lit(games)})`, context);

  assert.deepEqual(pick({ gameId: '', phase: 'closed', players: [] }, [incoming]), { action: 'load', game: incoming });
  assert.deepEqual(pick({ gameId: GAME2, phase: 'closed', players: [] }, [incoming]), { action: 'load', game: incoming });
  assert.deepEqual(pick({ gameId: GAME2, phase: 'active', example: true, players: [] }, [incoming]), { action: 'load', game: incoming });
  assert.deepEqual(pick({ gameId: GAME, phase: 'active', players: [] }, [incoming]), { action: 'load', game: incoming });
  // Single-slot limitation, documented on purpose: local wins and the server game waits.
  assert.deepEqual(pick({ gameId: GAME2, phase: 'active', players: [] }, [incoming]), { action: 'keep', game: null });
  assert.deepEqual(pick({ gameId: GAME2, phase: 'active', players: [] }, [other]), { action: 'load', game: other });
  assert.deepEqual(pick({ gameId: '', phase: 'closed', players: [] }, []), { action: 'keep', game: null });
});

test('shouldApplyIncomingGame never yanks the screen out from under an active input', () => {
  const context = load();
  const call = (local, incoming, hasActiveInput) =>
    vm.runInContext(`shouldApplyIncomingGame(${lit(local)}, ${lit(incoming)}, ${lit(hasActiveInput)})`, context);
  const local = { gameId: GAME, phase: 'active', example: false };
  assert.equal(call(local, { gameId: GAME }, false), true);
  assert.equal(call(local, { gameId: GAME }, true), false, 'park it for focusout instead');
  assert.equal(call(local, null, false), false);
  assert.equal(call(local, { gameId: GAME2 }, false), false, 'a different table never overwrites this one');
  assert.equal(call({ gameId: GAME2, phase: 'closed', example: false }, { gameId: GAME }, false), true);
  assert.equal(call({ gameId: GAME2, phase: 'active', example: true }, { gameId: GAME }, false), true);
});

// ---------- merge ----------

test('mergeCloudIntoState replaces history and debts by id but keeps local-only legacy records', () => {
  const context = load();
  const state = {
    gameId: 'x', phase: 'closed', players: [], settlementStatuses: {},
    groups: [], groupMembers: [], invites: [], friendships: [],
    history: [
      { gameId: GAME, at: 'old', players: [] },
      { gameId: 'legacy-1', at: 'legacy', players: [] },
    ],
    debts: [
      { id: 'debt-a', gameId: GAME, status: 'open' },
      { id: 'debt-legacy', gameId: 'legacy-1', status: 'open' },
    ],
  };
  const pulled = {
    groups: [], groupMembers: [], invites: [], friendships: [],
    history: [{ gameId: GAME, at: 'new', players: [] }],
    debts: [{ id: 'debt-a', gameId: GAME, status: 'paid' }],
    game: null,
  };
  const merged = runJSON(`mergeCloudIntoState(${lit(state)}, ${lit(pulled)}, {})`, context);
  assert.equal(merged.history.length, 2);
  assert.equal(merged.history.find(h => h.gameId === GAME).at, 'new', 'the server owns a closed game');
  assert.ok(merged.history.some(h => h.gameId === 'legacy-1'), 'a local-only legacy game survives the pull');
  assert.equal(merged.debts.find(d => d.id === 'debt-a').status, 'paid');
  assert.ok(merged.debts.some(d => d.id === 'debt-legacy'));
});

test('mergeCloudIntoState without any game keys is exactly the phase 2a merge', () => {
  const context = load();
  const state = {
    gameId: GAME, phase: 'active', players: [{ id: PL1, name: 'דביר' }],
    history: [{ gameId: 'h1' }], debts: [{ id: 'd1' }], settlementStatuses: { a: true },
    groups: [], groupMembers: [], invites: [], friendships: [],
  };
  const merged = runJSON(`mergeCloudIntoState(${lit(state)}, { groups: [], groupMembers: [], invites: [], friendships: [] }, {})`, context);
  assert.equal(merged.gameId, GAME);
  assert.deepEqual(merged.players, state.players);
  assert.deepEqual(merged.history, state.history);
  assert.deepEqual(merged.debts, state.debts);
  assert.deepEqual(merged.settlementStatuses, state.settlementStatuses);
});

test('a pulled open game replaces the slot, players, settlementStatuses and all', () => {
  const context = load();
  const state = {
    gameId: GAME, phase: 'active', players: [], settlementStatuses: {}, groupId: null, startedAt: null,
    leaderRef: null, history: [], debts: [], groups: [], groupMembers: [], invites: [], friendships: [],
  };
  const incoming = {
    gameId: GAME, phase: 'settlement', groupId: GR1, startedAt: '2026-09-06T19:00:00.000Z',
    leaderRef: { userId: P1, guestId: G1, displayName: 'דביר' },
    players: [{ id: PL1, name: 'דביר', buyins: [50], entryLog: [], cashout: 50, status: 'active', exitedAt: null, guestId: G1, memberId: M1, userId: P1 }],
    settlementStatuses: { k: true },
  };
  const merged = runJSON(`mergeCloudIntoState(${lit(state)}, { groups: [], groupMembers: [], invites: [], friendships: [], game: ${lit(incoming)} }, {})`, context);
  assert.equal(merged.phase, 'settlement');
  assert.equal(merged.groupId, GR1);
  assert.equal(merged.players.length, 1);
  assert.deepEqual(merged.settlementStatuses, { k: true });
  assert.equal(merged.example, false);
});

// ---------- the normalizer rule (2a follow-up) ----------

const normalizeCoreSource = sourceBetween('  function normalizePhase', '  function load()');
const normalizeGroupsSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');
function normalizeState(plainState) {
  return JSON.parse(vm.runInNewContext(
    normalizeCoreSource + '\n' + normalizeGroupsSource + '\nJSON.stringify(normalize(input))',
    { input: plainState, crypto: require('node:crypto').webcrypto, newId: () => 'stub-new-id' }
  ));
}

test('the normalizers keep a uuid userId that came from the server and drop anything else', () => {
  const result = normalizeState({
    gameId: GAME,
    players: [
      { id: PL1, name: 'דביר', buyins: [50], cashout: 0, userId: P1, guestId: G1 },
      { id: PL2, name: 'יוסי', buyins: [50], cashout: 0, userId: 'bogus-user-id' },
    ],
    history: [],
    leaderRef: { userId: P1, guestId: G1, displayName: 'דביר' },
    groupMembers: [
      { id: M1, groupId: GR1, userId: P1, guestId: G1, displayName: 'דביר' },
      { id: M2, groupId: GR1, userId: 'not-a-uuid', guestId: GU2, displayName: 'יוסי' },
    ],
  });
  assert.equal(result.players[0].userId, P1, 'a profile id pulled from the server survives a reload');
  assert.equal(result.players[1].userId, null, 'local code still never mints a userId');
  assert.equal(result.leaderRef.userId, P1);
  assert.equal(result.groupMembers[0].userId, P1);
  assert.equal(result.groupMembers[1].userId, null);
});

test('sameIdentity still recognises one person whether or not their profile id is known yet', () => {
  const context = vm.createContext({});
  vm.runInContext(normalizeGroupsSource, context);
  const same = (a, b) => vm.runInContext(`sameIdentity(${lit(a)}, ${lit(b)})`, context);
  // The member row came back from the server with a profile id; the closed-game player on this
  // device only ever had the guestId. They are the same person and the leaderboard must say so.
  assert.equal(same({ userId: P1, guestId: G1, displayName: 'דביר' }, { userId: null, guestId: G1, displayName: 'דביר' }), true);
  assert.equal(same({ userId: P1, guestId: G1 }, { userId: P2, guestId: G1 }), false, 'two accounts are two people');
  assert.equal(same({ guestId: G1 }, { guestId: GU2 }), false);
  assert.equal(same({ displayName: 'א' }, { displayName: 'א' }), true);
});

// ---------- wiring (source-level) ----------

const appScript = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
const storeSource = appScript.slice(
  appScript.indexOf('  // ---------- cloud store (Supabase) ----------'),
  appScript.indexOf('  // Example data promises'));

test('closing the table pushes the closed game, and every cloud call still sits behind the session guard', () => {
  const closeSource = appScript.slice(
    appScript.indexOf('  function finishCloseTable() {'),
    appScript.indexOf('  document.getElementById("closeTableBtn").addEventListener'));
  // finishCloseTable() keeps its local flow and simply calls save(), which is what pushes.
  assert.match(closeSource, /save\(\);/);
  assert.match(storeSource, /function save\(\)|scheduleCloudPush\(\)/);
  assert.match(appScript, /if \(cloudMode\(\)\) scheduleCloudPush\(\);/);
  assert.match(storeSource, /async function pushCloudGames\(|gamesClosed/);
  assert.ok(!/\balert\(|\bconfirm\(/.test(storeSource));
});

test('the open table gets a realtime channel named game:<id> that is torn down when it closes', () => {
  assert.match(storeSource, /supabase\.channel\("game:" \+ /);
  assert.match(storeSource, /"postgres_changes"[\s\S]*?table: "entries"[\s\S]*?filter: "game_id=eq\." \+ /);
  assert.match(storeSource, /table: "game_participants"/);
  assert.match(storeSource, /table: "games"[\s\S]*?filter: "id=eq\." \+ /);
  assert.match(storeSource, /supabase\.removeChannel\(/);
  assert.match(storeSource, /\.subscribe\(\)/);
  // Debounced, and never applied while an input has focus.
  assert.match(storeSource, /300/);
  assert.match(storeSource, /shouldApplyIncomingGame\(/);
});

test('a game this device already closed is never reopened by a pull or a realtime event', () => {
  // The close may simply not have reached the server yet — a failed push retries it — so the
  // local history entry, not the server's still-open row, is the truth.
  assert.match(storeSource, /closedHere\.has\(String\(row\.id\)\)/);
  assert.match(storeSource, /state\.history \|\| \[\]\)\.some\(entry => entry && String\(entry\.gameId\) === String\(gameRow\.id\)\)/);
});

test('a DELETE only ever reaches the current open table, never a game that left the payload', () => {
  // entries_delete_open_game / game_participants_delete exist for "בטל אחרונה" and for undoing a
  // player's last buy-in. A local reset, or history ageing out, must not wipe the server's rows.
  assert.match(storeSource, /const editable = new Set\(\(next\.games \|\| \[\]\)/);
  assert.match(storeSource, /pushCloudGameDeletes\(pair\[1\], diff\.deletes\.filter\(row => notFrozen\(row\) && isEditable\(row\)\)\)/);
  assert.match(storeSource, /\.delete\(\)\.in\("id", ids\)/);
});

test('the sync dot says it is syncing during a push and never leaks a secret key', () => {
  assert.ok(storeSource.includes('setSync(true, "מסנכרן…")'));
  assert.ok(storeSource.includes('setSync(true, "מסונכרן לחשבון")'));
  assert.ok(storeSource.includes('setSync(false, "שגיאת שמירה — נשמר מקומית")'));
  assert.ok(!html.includes('sb_secret_'));
  assert.ok(!html.includes('service_role'));
  assert.ok(!/userId: (authUser|session|user)\b/.test(appScript), 'a userId only ever arrives as profile_id');
});
