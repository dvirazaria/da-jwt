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

// resolveGuestId and newCurrentGame call newId() to mint a fresh id. The isolated pure-section
// slice does not define it (it lives elsewhere in the file), so tests supply a stub the same
// way other suites in this project supply `crypto` to a normalize() slice.
function load(newIdStub) {
  const context = vm.createContext({ newId: newIdStub || (() => 'stub-new-id') });
  vm.runInContext(pureSource, context);
  return context;
}

// vm.runInContext returns objects/arrays from the sandbox's own realm, so a plain
// deepEqual against a native literal fails on "same structure, not reference-equal"
// (different Array/Object prototypes). Round-tripping through JSON strips that.
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- normalize* contracts ----------

test('normalizeGroup fills optional fields with safe defaults and rejects non-objects / missing id', () => {
  const context = load();
  const group = runJSON(
    `normalizeGroup({id:'g1', name:'Poker Night', createdBy:{guestId:'u1', displayName:'דביר'}, createdAt:'2026-09-07T10:00:00Z'})`,
    context
  );
  assert.deepEqual(group, {
    id: 'g1', name: 'Poker Night', avatarDataUrl: null,
    createdBy: { userId: null, guestId: 'u1', displayName: 'דביר' },
    createdAt: '2026-09-07T10:00:00Z', archivedAt: null, deletedAt: null,
  });
  assert.equal(vm.runInContext(`normalizeGroup(null)`, context), null);
  assert.equal(vm.runInContext(`normalizeGroup({name:'no id'})`, context), null);
});

test('normalizeGroupMember forces userId null and falls back to safe defaults for unknown role/status', () => {
  const context = load();
  const member = vm.runInContext(
    `normalizeGroupMember({id:'m1', groupId:'g1', guestId:'u1', displayName:'דביר', role:'owner', status:'kicked', joinedAt:'2026-09-07T10:00:00Z'})`,
    context
  );
  assert.equal(member.userId, null);
  assert.equal(member.role, 'member');   // unknown role -> safe default
  assert.equal(member.status, 'active'); // unknown status -> safe default
  const known = vm.runInContext(`normalizeGroupMember({id:'m2', groupId:'g1', guestId:'u2', displayName:'ב', role:'admin', status:'removed', joinedAt:'t', leftAt:'t2'})`, context);
  assert.equal(known.role, 'admin');
  assert.equal(known.status, 'removed');
  assert.equal(known.leftAt, 't2');
});

test('normalizeInvite and normalizeFriendship default optional fields and enums safely', () => {
  const context = load();
  const invite = vm.runInContext(
    `normalizeInvite({id:'i1', groupId:'g1', token:'tok', createdBy:{guestId:'u1', displayName:'דביר'}, createdAt:'t'})`,
    context
  );
  assert.equal(invite.token, 'tok');
  assert.equal(invite.revokedAt, null);
  assert.equal(vm.runInContext(`normalizeInvite({})`, context), null);

  const friendship = vm.runInContext(
    `normalizeFriendship({id:'f1', requester:{guestId:'u1', displayName:'דביר'}, addressee:{guestId:'u2', displayName:'רותם'}, status:'blocked', createdAt:'t'})`,
    context
  );
  assert.equal(friendship.status, 'pending'); // unknown status -> safe default
  assert.equal(friendship.respondedAt, null);
  const accepted = vm.runInContext(`normalizeFriendship({id:'f2', requester:{displayName:'a'}, addressee:{displayName:'b'}, status:'accepted', createdAt:'t', respondedAt:'t2'})`, context);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.respondedAt, 't2');
});

// ---------- identity ----------

test('identityKey prefers userId, then guestId, then displayName; sameIdentity compares by identity only', () => {
  const context = load();
  assert.equal(vm.runInContext(`identityKey({userId:'u1', guestId:'g1', displayName:'x'})`, context), 'u:u1');
  assert.equal(vm.runInContext(`identityKey({guestId:'g1', displayName:'x'})`, context), 'g:g1');
  assert.equal(vm.runInContext(`identityKey({displayName:'x'})`, context), 'n:x');
  assert.equal(vm.runInContext(`sameIdentity({guestId:'g1', displayName:'a'}, {guestId:'g1', displayName:'b'})`, context), true);
  assert.equal(vm.runInContext(`sameIdentity({displayName:'a'}, {displayName:'b'})`, context), false);
});

test('resolveGuestId reuses a known guestId by displayName from members or history, else mints a new one', () => {
  const context = load(() => 'freshly-minted-id');
  const fromMember = { groupMembers: [{ displayName: 'דביר', guestId: 'guest-1' }], history: [] };
  assert.equal(vm.runInContext(`resolveGuestId(${JSON.stringify(fromMember)}, 'דביר')`, context), 'guest-1');

  const fromHistory = { groupMembers: [], history: [{ players: [{ name: 'רותם', guestId: 'guest-2' }] }] };
  assert.equal(vm.runInContext(`resolveGuestId(${JSON.stringify(fromHistory)}, 'רותם')`, context), 'guest-2');

  const unknown = { groupMembers: [], history: [] };
  assert.equal(vm.runInContext(`resolveGuestId(${JSON.stringify(unknown)}, 'חדש')`, context), 'freshly-minted-id');
});

test('findMyMembership and isGroupAdmin match the active member with the given displayName in the given group', () => {
  const context = load();
  const members = [
    { groupId: 'g1', displayName: 'דביר', role: 'admin', status: 'active' },
    { groupId: 'g1', displayName: 'רותם', role: 'member', status: 'active' },
    { groupId: 'g2', displayName: 'דביר', role: 'member', status: 'active' },
    { groupId: 'g1', displayName: 'עבר', role: 'admin', status: 'left' },
  ];
  assert.equal(vm.runInContext(`isGroupAdmin(${JSON.stringify(members)}, 'g1', 'דביר')`, context), true);
  assert.equal(vm.runInContext(`isGroupAdmin(${JSON.stringify(members)}, 'g2', 'דביר')`, context), false);
  assert.equal(vm.runInContext(`!!findMyMembership(${JSON.stringify(members)}, 'g1', 'לא-חבר')`, context), false);
  // a former (left/removed) member is not "my membership" even if the name matches
  assert.equal(vm.runInContext(`!!findMyMembership(${JSON.stringify(members)}, 'g1', 'עבר')`, context), false);
});

test('activeMembers/formerMembers partition by group and status', () => {
  const context = load();
  const members = [
    { groupId: 'g1', displayName: 'א', status: 'active' },
    { groupId: 'g1', displayName: 'ב', status: 'left' },
    { groupId: 'g1', displayName: 'ג', status: 'removed' },
    { groupId: 'g2', displayName: 'ד', status: 'active' },
  ];
  assert.deepEqual(runJSON(`activeMembers(${JSON.stringify(members)}, 'g1').map(m=>m.displayName)`, context), ['א']);
  assert.deepEqual(runJSON(`formerMembers(${JSON.stringify(members)}, 'g1').map(m=>m.displayName)`, context), ['ב', 'ג']);
});

test('visibleGroups/archivedGroups split on archivedAt/deletedAt, groupClosedGames filters history by groupId', () => {
  const context = load();
  const groups = [
    { id: 'g1', archivedAt: null, deletedAt: null },
    { id: 'g2', archivedAt: '2026-01-01T00:00:00Z', deletedAt: null },
    { id: 'g3', archivedAt: null, deletedAt: '2026-01-01T00:00:00Z' },
  ];
  assert.deepEqual(runJSON(`visibleGroups(${JSON.stringify(groups)}).map(g=>g.id)`, context), ['g1']);
  assert.deepEqual(runJSON(`archivedGroups(${JSON.stringify(groups)}).map(g=>g.id)`, context), ['g2']);

  const history = [{ gameId: 'h1', groupId: 'g1' }, { gameId: 'h2', groupId: 'g2' }, { gameId: 'h3', groupId: 'g1' }];
  assert.deepEqual(runJSON(`groupClosedGames(${JSON.stringify(history)}, 'g1').map(h=>h.gameId)`, context), ['h1', 'h3']);
});

// ---------- winners / eligibility / leaderboard ----------

test('gameWinners returns the single top net, all tied leaders, or [] when there are no players', () => {
  const context = load();
  assert.deepEqual(runJSON(`gameWinners({players:[{name:'a', net:100},{name:'b', net:-50}]}).map(p=>p.name)`, context), ['a']);
  assert.deepEqual(runJSON(`gameWinners({players:[{name:'a', net:50},{name:'b', net:50},{name:'c', net:-100}]}).map(p=>p.name)`, context), ['a', 'b']);
  assert.deepEqual(runJSON(`gameWinners({players:[]})`, context), []);
  assert.deepEqual(runJSON(`gameWinners(null)`, context), []);
});

// D5: a game where the max net is <= 0 (nobody actually profited) has no winner. A genuine tie
// at a positive net still returns every tied leader (kept as its own case, distinct from the
// no-winner rule above).
test('gameWinners returns [] when the max net is zero or negative (nobody profited), even on a tie', () => {
  const context = load();
  assert.deepEqual(runJSON(`gameWinners({players:[{name:'a', net:0},{name:'b', net:0}]})`, context), []);
  assert.deepEqual(runJSON(`gameWinners({players:[{name:'a', net:-10},{name:'b', net:-40}]})`, context), []);
  assert.deepEqual(runJSON(`gameWinners({players:[{name:'a', net:0},{name:'b', net:-20}]})`, context), []);
});

test('gameWinners still returns both leaders on a genuine tie at a positive net', () => {
  const context = load();
  assert.deepEqual(
    runJSON(`gameWinners({players:[{name:'a', net:40},{name:'b', net:40},{name:'c', net:-80}]}).map(p=>p.name)`, context),
    ['a', 'b']
  );
});

test('isLeaderboardEligible admits active and former members by identity, and excludes ad-hoc guests', () => {
  const context = load();
  const members = [
    { groupId: 'g1', userId: null, guestId: 'u1', displayName: 'דביר', status: 'active' },
    { groupId: 'g1', userId: null, guestId: 'u2', displayName: 'רותם', status: 'left' },
  ];
  assert.equal(vm.runInContext(`isLeaderboardEligible({userId:null, guestId:'u1', displayName:'דביר'}, ${JSON.stringify(members)})`, context), true);
  assert.equal(vm.runInContext(`isLeaderboardEligible({userId:null, guestId:'u2', displayName:'רותם'}, ${JSON.stringify(members)})`, context), true);
  assert.equal(vm.runInContext(`isLeaderboardEligible({userId:null, guestId:'u3', displayName:'אורח'}, ${JSON.stringify(members)})`, context), false);
});

test('buildLeaderboard orders by net desc, counts games/wins, flags former members, and exposes no money field', () => {
  const context = load();
  const members = [
    { id: 'm1', groupId: 'g1', userId: null, guestId: 'p1', displayName: 'א', status: 'active' },
    { id: 'm2', groupId: 'g1', userId: null, guestId: 'p2', displayName: 'ב', status: 'active' },
    { id: 'm3', groupId: 'g1', userId: null, guestId: 'p3', displayName: 'ג', status: 'left' },
  ];
  const history = [
    { groupId: 'g1', at: 't1', players: [{ name: 'א', guestId: 'p1', net: -50 }, { name: 'ב', guestId: 'p2', net: 20 }, { name: 'ג', guestId: 'p3', net: 30 }] },
    { groupId: 'g1', at: 't2', players: [{ name: 'א', guestId: 'p1', net: 100 }, { name: 'ב', guestId: 'p2', net: -100 }] },
  ];
  const board = JSON.parse(vm.runInContext(
    `JSON.stringify(buildLeaderboard(${JSON.stringify(history)}, ${JSON.stringify(members)}, 'g1'))`, context
  ));
  const byName = Object.fromEntries(board.map(e => [e.displayName, e]));
  assert.equal(byName['א'].rank, 1);   // net 50, 2 games, 1 win
  assert.equal(byName['א'].gamesPlayed, 2);
  assert.equal(byName['א'].wins, 1);
  assert.equal(byName['א'].isFormerMember, false);
  assert.equal(byName['ג'].rank, 2);   // net 30, 1 game, 1 win, former member
  assert.equal(byName['ג'].isFormerMember, true);
  assert.equal(byName['ב'].rank, 3);   // net -80, 2 games, 0 wins
  assert.equal(byName['ב'].wins, 0);
  const forbidden = ['net', 'total', 'profit', 'amount', 'balance'];
  board.forEach(entry => assert.deepEqual(Object.keys(entry).filter(k => forbidden.includes(k)), []));
});

test('buildLeaderboard gives tied net the same rank number, skipping ranks like 1,1,3', () => {
  const context = load();
  const members = [
    { id: 'm1', groupId: 'g1', userId: null, guestId: 'p1', displayName: 'א', status: 'active' },
    { id: 'm2', groupId: 'g1', userId: null, guestId: 'p2', displayName: 'ב', status: 'active' },
    { id: 'm3', groupId: 'g1', userId: null, guestId: 'p3', displayName: 'ג', status: 'active' },
  ];
  const history = [
    { groupId: 'g1', at: 't1', players: [{ name: 'א', guestId: 'p1', net: 30 }, { name: 'ג', guestId: 'p3', net: 10 }] },
    { groupId: 'g1', at: 't2', players: [{ name: 'א', guestId: 'p1', net: 20 }, { name: 'ב', guestId: 'p2', net: 50 }] },
  ];
  const board = JSON.parse(vm.runInContext(
    `JSON.stringify(buildLeaderboard(${JSON.stringify(history)}, ${JSON.stringify(members)}, 'g1'))`, context
  ));
  // א: 30+20=50 net over 2 games; ב: 50 net over 1 game -> tie at net 50, both rank 1
  // ג: 10 net over 1 game -> rank 3 (not 2), because two entries occupy rank 1
  assert.deepEqual(board.map(e => [e.displayName, e.rank]), [['א', 1], ['ב', 1], ['ג', 3]]);
});

// ---------- canStartGroupGame ----------

test('canStartGroupGame reports ok, group-archived, group-has-open-game, and another-game-open', () => {
  const context = load();
  const groups = [{ id: 'g1', archivedAt: null, deletedAt: null }, { id: 'g2', archivedAt: '2026-01-01T00:00:00Z', deletedAt: null }];

  const noOpenGame = { groups, currentGame: { example: false, phase: 'closed', groupId: null } };
  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(noOpenGame)}, 'g1')`, context), { ok: true, reason: null });

  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(noOpenGame)}, 'g2')`, context), { ok: false, reason: 'group-archived' });

  const sameGroupOpen = { groups, currentGame: { example: false, phase: 'active', groupId: 'g1' } };
  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(sameGroupOpen)}, 'g1')`, context), { ok: false, reason: 'group-has-open-game' });

  const otherGroupOpen = { groups, currentGame: { example: false, phase: 'settlement', groupId: 'g1' } };
  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(otherGroupOpen)}, 'other-group')`, context), { ok: false, reason: 'another-game-open' });
});

// ---------- getGroupSummary(ies) ----------

test('getGroupSummaries returns GroupSummary rows for visible groups only, with no money field', () => {
  const context = load();
  const collections = {
    groups: [
      { id: 'g1', name: 'ליל שישי', avatarDataUrl: null, archivedAt: null, deletedAt: null },
      { id: 'g2', name: 'ארכיון', avatarDataUrl: null, archivedAt: '2026-01-01T00:00:00Z', deletedAt: null },
    ],
    groupMembers: [
      { id: 'm1', groupId: 'g1', userId: null, guestId: 'p1', displayName: 'דביר', role: 'admin', status: 'active' },
      { id: 'm2', groupId: 'g1', userId: null, guestId: 'p2', displayName: 'רותם', role: 'member', status: 'active' },
    ],
    history: [{ gameId: 'h1', groupId: 'g1', at: '2026-09-01T20:00:00.000Z', players: [{ name: 'דביר', guestId: 'p1', net: 50 }, { name: 'רותם', guestId: 'p2', net: -50 }] }],
    currentGame: { example: false, phase: 'closed', groupId: null },
  };
  const summaries = JSON.parse(vm.runInContext(`JSON.stringify(getGroupSummaries(${JSON.stringify(collections)}, 'דביר'))`, context));
  assert.equal(summaries.length, 1); // archived group excluded
  const g1 = summaries[0];
  assert.equal(g1.groupId, 'g1');
  assert.equal(g1.memberCount, 2);
  assert.deepEqual(g1.members.sort(), ['דביר', 'רותם']);
  assert.equal(g1.hasActiveGame, false);
  assert.equal(g1.gameCount, 1);
  assert.equal(g1.lastGameAt, '2026-09-01T20:00:00.000Z');
  assert.deepEqual(g1.leaderNames, ['דביר']);
  assert.equal(g1.isAdmin, true);
  assert.equal(g1.isMember, true);
  assert.deepEqual(Object.keys(g1).filter(k => ['net', 'total', 'profit', 'amount', 'balance'].includes(k)), []);
});

// ---------- newCurrentGame ----------

test('newCurrentGame preserves history/debts/groups/groupMembers/invites/friendships/updatedAt and resets the current-game fields', () => {
  const context = load(() => 'stub-new-id');
  const base = {
    example: true, phase: 'active', gameId: 'old-game', players: [{ name: 'x' }], settlementStatuses: { k: true },
    groupId: 'g1', startedAt: '2026-01-01T00:00:00.000Z', leaderRef: { userId: null, guestId: 'u1', displayName: 'x' },
    history: [{ gameId: 'h1' }], debts: [{ id: 'd1' }], groups: [{ id: 'g1' }], groupMembers: [{ id: 'm1' }],
    invites: [{ id: 'i1' }], friendships: [{ id: 'f1' }], updatedAt: '2026-01-01T00:00:00.000Z',
  };
  Object.assign(context, { base });
  const result = runJSON(`newCurrentGame(base, {phase:'active', startedAt:'NOW'})`, context);
  assert.deepEqual(result.history, base.history);
  assert.deepEqual(result.debts, base.debts);
  assert.deepEqual(result.groups, base.groups);
  assert.deepEqual(result.groupMembers, base.groupMembers);
  assert.deepEqual(result.invites, base.invites);
  assert.deepEqual(result.friendships, base.friendships);
  assert.equal(result.updatedAt, base.updatedAt);
  assert.equal(result.example, false);
  assert.equal(result.phase, 'active');
  assert.equal(result.gameId, 'stub-new-id');
  assert.deepEqual(result.players, []);
  assert.deepEqual(result.settlementStatuses, {});
  assert.equal(result.groupId, null);
  assert.equal(result.startedAt, 'NOW');
  assert.equal(result.leaderRef, null);
});

test('newCurrentGame defaults phase to closed and groupId/startedAt/leaderRef to null when the patch omits them', () => {
  const context = load(() => 'stub-new-id-2');
  Object.assign(context, { base: { history: [], debts: [], groups: [], groupMembers: [], invites: [], friendships: [], updatedAt: 't' } });
  const result = vm.runInContext(`newCurrentGame(base, {})`, context);
  assert.equal(result.phase, 'closed');
  assert.equal(result.groupId, null);
  assert.equal(result.startedAt, null);
  assert.equal(result.leaderRef, null);
  assert.equal(result.gameId, 'stub-new-id-2');
});

// ---------- wiring: remoteBody / applyRemote mention the new collections ----------

test('remoteBody and applyRemote both mirror groups, groupMembers, invites and friendships', () => {
  const remoteSource = html.slice(html.indexOf('  function remoteBody()'), html.indexOf('  function scheduleRemoteSave()'));
  const applyRemoteSource = html.slice(html.indexOf('  function applyRemote(data)'), html.indexOf('  document.addEventListener("visibilitychange"'));
  ['groups', 'groupMembers', 'invites', 'friendships'].forEach(name => {
    assert.match(remoteSource, new RegExp(name), `remoteBody should mention ${name}`);
    assert.match(applyRemoteSource, new RegExp(name), `applyRemote should mention ${name}`);
  });
});

// ---------- buildHistoryEntry carries the new fields ----------

test('buildHistoryEntry copies groupId, startedAt, leaderRef, and per-player guestId/memberId', () => {
  const start = html.indexOf('  function buildHistoryEntry');
  const end = html.indexOf('  function balanceDescription', start);
  const context = vm.createContext({});
  vm.runInContext('const sum = values => values.reduce((x, y) => x + y, 0);', context);
  vm.runInContext(html.slice(start, end), context);
  const snapshot = {
    gameId: 'g1', groupId: 'grp-1', startedAt: '2026-09-07T18:00:00.000Z',
    leaderRef: { userId: null, guestId: 'u1', displayName: 'דביר' },
    players: [{ id: 'p1', name: 'דביר', guestId: 'u1', memberId: 'm1', buyins: [50], entryLog: [], cashout: 80 }],
  };
  const entry = JSON.parse(vm.runInContext(
    `JSON.stringify(buildHistoryEntry(${JSON.stringify(snapshot)}, {difference:0,isBalanced:true}, '2026-09-07T19:00:00.000Z'))`, context
  ));
  assert.equal(entry.groupId, 'grp-1');
  assert.equal(entry.startedAt, '2026-09-07T18:00:00.000Z');
  assert.deepEqual(entry.leaderRef, { userId: null, guestId: 'u1', displayName: 'דביר' });
  assert.equal(entry.players[0].guestId, 'u1');
  assert.equal(entry.players[0].memberId, 'm1');
});

// ---------- legacy normalize() migration ----------

test('normalize defaults groups/groupMembers/invites/friendships to [] and leaderRef to null for an old snapshot, and player guestId/memberId to null', () => {
  const normalizeSource = html.slice(html.indexOf('  function normalizePhase'), html.indexOf('  function load()'));
  // Task 3 hardening: normalize() now shapes groups/groupMembers/invites/friendships through
  // their normalizers (same as debts through normalizeDebt), so this slice needs them too.
  const groupsPureSource = html.slice(html.indexOf('  // ---------- groups domain (pure) ----------'), html.indexOf('  function el('));
  function normalize(s) {
    return JSON.parse(vm.runInNewContext(
      normalizeSource + '\n' + groupsPureSource + '\nJSON.stringify(normalize(input))',
      { input: s, crypto: require('node:crypto').webcrypto, newId: () => 'stub-new-id' }
    ));
  }
  const legacy = normalize({ gameId: 'legacy-1', players: [{ name: 'א', buyins: [50], cashout: 0 }], history: [] });
  assert.deepEqual(legacy.groups, []);
  assert.deepEqual(legacy.groupMembers, []);
  assert.deepEqual(legacy.invites, []);
  assert.deepEqual(legacy.friendships, []);
  assert.equal(legacy.leaderRef, null);
  assert.equal(legacy.players[0].guestId, null);
  assert.equal(legacy.players[0].memberId, null);

  const saved = normalize({
    gameId: 'g2', players: [{ id: 'p1', name: 'ב', buyins: [50], entryLog: [], cashout: 0, guestId: 'guest-9', memberId: 'member-9' }],
    history: [], groups: [{ id: 'g1' }], groupMembers: [{ id: 'm1' }], invites: [{ id: 'i1' }], friendships: [{ id: 'f1' }],
    leaderRef: { userId: null, guestId: 'u1', displayName: 'x' },
  });
  // Each collection is now shaped by its normalizer, same as debts through normalizeDebt —
  // ids survive, missing fields get safe defaults (see the normalizeGroup* contracts above).
  assert.deepEqual(saved.groups, [{
    id: 'g1', name: '', avatarDataUrl: null,
    createdBy: { userId: null, guestId: null, displayName: '' },
    createdAt: '', archivedAt: null, deletedAt: null,
  }]);
  assert.deepEqual(saved.groupMembers, [{
    id: 'm1', groupId: '', userId: null, guestId: null, displayName: '',
    role: 'member', status: 'active', joinedAt: '', leftAt: null,
  }]);
  assert.deepEqual(saved.invites, [{
    id: 'i1', groupId: '', token: '',
    createdBy: { userId: null, guestId: null, displayName: '' },
    createdAt: '', revokedAt: null,
  }]);
  assert.deepEqual(saved.friendships, [{
    id: 'f1',
    requester: { userId: null, guestId: null, displayName: '' },
    addressee: { userId: null, guestId: null, displayName: '' },
    status: 'pending', createdAt: '', respondedAt: null,
  }]);
  assert.deepEqual(saved.leaderRef, { userId: null, guestId: 'u1', displayName: 'x' });
  assert.equal(saved.players[0].guestId, 'guest-9');
  assert.equal(saved.players[0].memberId, 'member-9');
});
