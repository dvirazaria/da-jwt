// Guest -> account linking, v2 (docs/backend/link-guest.sql) — no approval step in the happy path.
//
// Replaces the earlier consent-based "זה אני" design (request + a second person's approval) with
// three paths, tried in order: (1) invite-bound linking — a member binds an invite to a specific
// unlinked guest when creating it (app_redeem_invite links atomically on redemption, silently);
// (2) verified contact match — not shipped this pass, see the report; (3) zero-exposure
// self-claim — a signed-in user may claim a matching guest THEMSELVES, instantly, but only when
// doing so moves no money (app_self_claim_guest, enforced server-side). Every path shares the
// same re-pointing engine and double-seat guard (app_link_guest_to_profile).
//
// These tests pin the pure client half, vm-sliced exactly like tests/groups-domain.test.cjs:
//   * guestHasZeroExposure — the local mirror of app_guest_has_zero_exposure: an open debt, or a
//     seat in an open/unbalanced game, makes a guest unclaimable; a clean guest is claimable;
//   * seatsGuestAndUser — the local mirror of the SQL's double-seat guard, unchanged and shared by
//     every linking path;
//   * applyGuestClaimLocally — the optimistic local re-point, and that it is pure identity, never
//     money, and idempotent (also unchanged — every path re-points identity the same way);
//   * a structural regex check that link-guest.sql is SECURITY DEFINER, keyed off auth.uid() via
//     the vendor seam, revokes the public default, enforces zero exposure server-side (inside
//     app_self_claim_guest itself, not just suggested by the UI), and never mentions service_role.
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

// guestHasZeroExposure and seatsGuestAndUser/applyGuestClaimLocally live in "groups domain
// (pure)"; guestClaimCandidatesInGroup lives a bit further in "cloud mapping (pure)" — the same
// wide slice tests/groups-domain.test.cjs already loads (it runs up to the DOM boundary
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

// ---------- guestHasZeroExposure ----------

test('guestHasZeroExposure: an open debt on either side makes a guest unclaimable, a paid one does not', () => {
  const context = load();
  const asDebtor = runJSON(
    `guestHasZeroExposure('guest-1', [{status:'open', debtor_guest_id:'guest-1', creditor_guest_id:null}], [], [])`,
    context);
  const asCreditor = runJSON(
    `guestHasZeroExposure('guest-1', [{status:'open', debtor_guest_id:null, creditor_guest_id:'guest-1'}], [], [])`,
    context);
  const paidDoesNotCount = runJSON(
    `guestHasZeroExposure('guest-1', [{status:'paid', debtor_guest_id:'guest-1', creditor_guest_id:null}], [], [])`,
    context);
  const someoneElsesDebt = runJSON(
    `guestHasZeroExposure('guest-1', [{status:'open', debtor_guest_id:'guest-2', creditor_guest_id:null}], [], [])`,
    context);
  assert.equal(asDebtor, false, 'an open debt as debtor blocks the claim');
  assert.equal(asCreditor, false, 'an open debt as creditor blocks the claim');
  assert.equal(paidDoesNotCount, true, 'a paid debt is not exposure');
  assert.equal(someoneElsesDebt, true, 'a different guest\'s open debt is irrelevant');
});

test('guestHasZeroExposure: an open or unbalanced-closed game blocks the claim, a closed balanced one does not', () => {
  const context = load();
  const seated = (guestId, gameId) => JSON.stringify([{ guest_id: guestId, game_id: gameId }]);
  const openGame = runJSON(
    `guestHasZeroExposure('guest-1', [], ${seated('guest-1', 'g1')}, [{id:'g1', phase:'active', is_balanced:null}])`,
    context);
  const settlementGame = runJSON(
    `guestHasZeroExposure('guest-1', [], ${seated('guest-1', 'g1')}, [{id:'g1', phase:'settlement', is_balanced:null}])`,
    context);
  const unbalancedClosed = runJSON(
    `guestHasZeroExposure('guest-1', [], ${seated('guest-1', 'g1')}, [{id:'g1', phase:'closed', is_balanced:false}])`,
    context);
  const cleanGuest = runJSON(
    `guestHasZeroExposure('guest-1', [], ${seated('guest-1', 'g1')}, [{id:'g1', phase:'closed', is_balanced:true}])`,
    context);
  const noGuestId = runJSON(`guestHasZeroExposure('', [], [], [])`, context);
  assert.equal(openGame, false, 'a still-open game blocks the claim');
  assert.equal(settlementGame, false, 'a game in settlement blocks the claim');
  assert.equal(unbalancedClosed, false, 'a closed but unbalanced game blocks the claim');
  assert.equal(cleanGuest, true, 'closed + balanced, no open debts -> claimable');
  assert.equal(noGuestId, false, 'no guestId is never claimable');
});

// ---------- seatsGuestAndUser (double-seat guard, shared by every linking path) ----------

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

// ---------- applyGuestClaimLocally (the local re-point, shared by every linking path) ----------

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

// ---------- SQL: definer-rights, auth.uid()-derived, hardened, exposure enforced server-side ----------

test('link-guest.sql is SECURITY DEFINER, keyed off auth.uid() via the vendor seam, revokes the public default, enforces zero exposure server-side, and never mentions service_role', () => {
  const sql = fs.readFileSync('docs/backend/link-guest.sql', 'utf8');
  assert.match(sql, /security definer/i);
  // The seam is app_current_profile_id() (auth.uid() lives only in rls-policies.sql), documented
  // here exactly like join-invite.sql documents the same seam for app_redeem_invite.
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /app_current_profile_id\(\)/);
  assert.match(sql, /revoke/i);
  assert.doesNotMatch(sql, /service_role/i);
  // Neither public-facing RPC takes a spoofable target identity — both always resolve their own
  // caller via app_current_profile_id(), never a caller-supplied profile/user/target id.
  assert.doesNotMatch(sql, /app_redeem_invite\(p_(profile|user|target)_id/i);
  assert.doesNotMatch(sql, /app_self_claim_guest\(p_(profile|user|target)_id/i);
  // The zero-exposure gate is enforced INSIDE app_self_claim_guest itself — not left to the UI.
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION app_self_claim_guest');
  assert.ok(start >= 0, 'missing app_self_claim_guest');
  const end = sql.indexOf('CREATE OR REPLACE FUNCTION', start + 1);
  const body = sql.slice(start, end >= 0 ? end : undefined);
  assert.match(body, /app_guest_has_zero_exposure\(/);
  assert.match(body, /GUEST_LINK_HAS_EXPOSURE/);
});
