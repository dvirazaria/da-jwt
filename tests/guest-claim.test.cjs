// Guest -> account linking ("זה אני"), consent-based (docs/backend/link-guest.sql).
//
// The server half is docs/backend/link-guest.sql: a SECURITY DEFINER app_request_guest_claim /
// app_approve_guest_claim / app_decline_guest_claim trio, because a guest can never be
// auto-merged by name and RLS deliberately refuses the direct writes a merge needs. These tests
// pin the pure client half, vm-sliced exactly like tests/groups-domain.test.cjs:
//   * guestClaimCandidatesInGroup — who this device offers "שיחקת כאן בעבר?" to, and who it does
//     not (already linked, a different group, a claim already in flight, local/offline mode);
//   * seatsGuestAndUser — the local mirror of the SQL's double-seat guard;
//   * applyGuestClaimLocally — the optimistic local re-point, and that it is pure identity, never
//     money, and idempotent;
//   * a structural regex check that link-guest.sql actually enforces auth.uid()-derived identity,
//     is SECURITY DEFINER, revokes the public default, and never mentions service_role.
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

// Both new helpers live between "groups domain (pure)" and "cloud mapping (pure)" ends, i.e. the
// same wide slice tests/groups-domain.test.cjs already loads (it runs up to the DOM boundary
// `function el(`, which happens to include every pure section in between).
const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

function load() {
  const context = vm.createContext({ newId: () => 'stub-new-id' });
  vm.runInContext(pureSource, context);
  return context;
}
// vm.runInContext hands back sandbox-realm objects; JSON round-tripping strips the prototype
// mismatch against a native literal (same helper as groups-domain.test.cjs / cloud-mapping.test.cjs).
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- guestClaimCandidatesInGroup ----------

test('guestClaimCandidatesInGroup offers an unlinked same-name guest seated in my group', () => {
  const context = load();
  const guestRows = [{ id: 'guest-1', display_name: 'דביר', created_by: 'admin-1', linked_profile_id: null }];
  const groupMembers = [
    { groupId: 'group-1', guestId: 'guest-1', userId: null, displayName: 'דביר', status: 'active' },
    { groupId: 'group-1', guestId: null, userId: 'user-dvir', displayName: 'דביר', status: 'active' },
  ];
  const result = runJSON(
    `guestClaimCandidatesInGroup(${JSON.stringify(guestRows)}, ${JSON.stringify(groupMembers)}, [], 'group-1', 'user-dvir', 'דביר')`,
    context);
  assert.deepEqual(result.map(g => g.id), ['guest-1']);
});

test('guestClaimCandidatesInGroup excludes a linked guest, another group, a name mismatch, an in-flight claim, and local mode', () => {
  const context = load();
  const guestRows = [
    { id: 'guest-linked', display_name: 'דביר', created_by: 'admin-1', linked_profile_id: 'someone-else' },
    { id: 'guest-other-group', display_name: 'דביר', created_by: 'admin-1', linked_profile_id: null },
    { id: 'guest-wrong-name', display_name: 'יוסי', created_by: 'admin-1', linked_profile_id: null },
    { id: 'guest-in-flight', display_name: 'דביר', created_by: 'admin-1', linked_profile_id: null },
  ];
  const groupMembers = [
    { groupId: 'group-1', guestId: 'guest-linked', displayName: 'דביר', status: 'active' },
    { groupId: 'group-2', guestId: 'guest-other-group', displayName: 'דביר', status: 'active' },
    { groupId: 'group-1', guestId: 'guest-wrong-name', displayName: 'יוסי', status: 'active' },
    { groupId: 'group-1', guestId: 'guest-in-flight', displayName: 'דביר', status: 'active' },
  ];
  const claims = [{ guest_id: 'guest-in-flight', claimant_profile_id: 'user-dvir', status: 'pending' }];
  const run = (meUserId, meName) => runJSON(
    `guestClaimCandidatesInGroup(${JSON.stringify(guestRows)}, ${JSON.stringify(groupMembers)}, ${JSON.stringify(claims)}, 'group-1', ${JSON.stringify(meUserId)}, ${JSON.stringify(meName)})`,
    context);
  assert.deepEqual(run('user-dvir', 'דביר'), [], 'linked/other-group/wrong-name/in-flight guests are never offered');
  // Local/offline mode: ParticipantRef.userId is always null pre-account, so this must be [] too.
  assert.deepEqual(run(null, 'דביר'), []);
});

// ---------- seatsGuestAndUser ----------

test('seatsGuestAndUser mirrors the SQL double-seat guard', () => {
  const context = load();
  const seats = (players, guestId, userId) => vm.runInContext(
    `seatsGuestAndUser(${JSON.stringify(players)}, ${JSON.stringify(guestId)}, ${JSON.stringify(userId)})`, context);
  const both = [{ name: 'אורח', guestId: 'guest-1' }, { name: 'דביר', userId: 'user-dvir' }];
  assert.equal(seats(both, 'guest-1', 'user-dvir'), true);
  assert.equal(seats([{ name: 'אורח', guestId: 'guest-1' }], 'guest-1', 'user-dvir'), false, 'claimant not at this table');
  assert.equal(seats([{ name: 'דביר', userId: 'user-dvir' }], 'guest-1', 'user-dvir'), false, 'guest not at this table');
  assert.equal(seats(both, '', 'user-dvir'), false, 'no guestId, no guard');
  assert.equal(seats(both, 'guest-1', ''), false, 'no userId, no guard');
});

// ---------- applyGuestClaimLocally ----------

function claimFixture() {
  return {
    groups: [{ id: 'g1', createdBy: { userId: null, guestId: 'guest-1', displayName: 'דביר' } }],
    groupMembers: [{ id: 'm1', groupId: 'g1', userId: null, guestId: 'guest-1', displayName: 'דביר' }],
    invites: [{ id: 'i1', createdBy: { userId: null, guestId: 'guest-1', displayName: 'דביר' } }],
    friendships: [{
      id: 'f1',
      requester: { userId: null, guestId: 'guest-1', displayName: 'דביר' },
      addressee: { userId: null, guestId: 'other', displayName: 'שרה' },
    }],
    players: [{ id: 'p1', name: 'דביר', guestId: 'guest-1', userId: null, buyins: [100, 50], cashout: 40 }],
  };
}

test('applyGuestClaimLocally rewrites every guestId reference to userId across all collections', () => {
  const context = load();
  const script = `
    const c = ${JSON.stringify(claimFixture())};
    applyGuestClaimLocally(c, 'guest-1', 'user-dvir');
    JSON.stringify(c);
  `;
  const c = JSON.parse(vm.runInContext(script, context));
  assert.equal(c.groups[0].createdBy.userId, 'user-dvir');
  assert.equal(c.groups[0].createdBy.guestId, null);
  assert.equal(c.groupMembers[0].userId, 'user-dvir');
  assert.equal(c.groupMembers[0].guestId, null);
  assert.equal(c.invites[0].createdBy.userId, 'user-dvir');
  assert.equal(c.friendships[0].requester.userId, 'user-dvir');
  assert.equal(c.friendships[0].requester.guestId, null);
  // The other party of the friendship (a different guestId) must be left alone.
  assert.equal(c.friendships[0].addressee.guestId, 'other');
  assert.equal(c.players[0].userId, 'user-dvir');
  assert.equal(c.players[0].guestId, null);
});

test('applyGuestClaimLocally only ever touches identity fields — every money total is unchanged', () => {
  const context = load();
  const before = claimFixture();
  const sumMoney = (c) => c.players.reduce((t, p) => t + p.buyins.reduce((x, y) => x + y, 0) + p.cashout, 0);
  const beforeTotal = sumMoney(before);
  const script = `
    const c = ${JSON.stringify(before)};
    applyGuestClaimLocally(c, 'guest-1', 'user-dvir');
    JSON.stringify(c);
  `;
  const after = JSON.parse(vm.runInContext(script, context));
  assert.equal(sumMoney(after), beforeTotal);
  assert.deepEqual(after.players[0].buyins, before.players[0].buyins);
  assert.equal(after.players[0].cashout, before.players[0].cashout);
});

test('applyGuestClaimLocally is idempotent — a second call changes nothing further', () => {
  const context = load();
  const script = `
    const c = ${JSON.stringify(claimFixture())};
    applyGuestClaimLocally(c, 'guest-1', 'user-dvir');
    const once = JSON.stringify(c);
    applyGuestClaimLocally(c, 'guest-1', 'user-dvir');
    const twice = JSON.stringify(c);
    JSON.stringify({ once, twice });
  `;
  const { once, twice } = JSON.parse(vm.runInContext(script, context));
  assert.equal(once, twice);
});

// ---------- SQL: authorization is auth.uid()-derived, definer-rights, hardened ----------

test('link-guest.sql is SECURITY DEFINER, keyed off auth.uid() via the vendor seam, revokes the public default, and never mentions service_role', () => {
  const sql = fs.readFileSync('docs/backend/link-guest.sql', 'utf8');
  assert.match(sql, /security definer/i);
  // The seam is app_current_profile_id() (auth.uid() lives only in rls-policies.sql), documented
  // here exactly like join-invite.sql documents the same seam for app_redeem_invite.
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /app_current_profile_id\(\)/);
  assert.match(sql, /revoke/i);
  assert.doesNotMatch(sql, /service_role/i);
  // The claimant is always the caller's own identity, never a spoofable parameter.
  assert.doesNotMatch(sql, /app_request_guest_claim\(p_(profile|user|target)_id/i);
});
