// Account deletion — the client-side pure helpers plus regex checks that pin the shape of the
// two deliverables that aren't pure functions: docs/backend/delete-account.sql (a SECURITY
// DEFINER RPC, never executed by this suite) and the settings-overlay danger zone in
// kupa-sgura.html.
//
// pickAccountDeletionSuccessor mirrors the admin-succession loop in app_delete_my_account();
// scrubLocalIdentity mirrors its identity scrub (profile_id -> guest_id). Keep both pairs in
// sync — see the comments next to each function/loop.
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

// Same slice + stub as tests/groups-domain.test.cjs: both new pure functions live in this
// section (right after isLastActiveAdmin), which only needs newId() supplied from outside.
const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');
function load() {
  const context = vm.createContext({ newId: () => 'stub-fresh-guest' });
  vm.runInContext(pureSource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- pickAccountDeletionSuccessor ----------

test('sole admin: promotes the longest-standing OTHER active member (earliest joinedAt), not just any member', () => {
  const context = load();
  context.members = [
    { id: 'm1', groupId: 'g1', role: 'admin', status: 'active', joinedAt: '2026-01-01T00:00:00Z' }, // leaving
    { id: 'm2', groupId: 'g1', role: 'member', status: 'active', joinedAt: '2026-03-01T00:00:00Z' }, // newer
    { id: 'm3', groupId: 'g1', role: 'member', status: 'active', joinedAt: '2026-02-01T00:00:00Z' }, // longer-standing
    { id: 'm4', groupId: 'g1', role: 'member', status: 'left',   joinedAt: '2025-01-01T00:00:00Z' }, // inactive, ignored
  ];
  const decision = runJSON('pickAccountDeletionSuccessor(members, "m1")', context);
  assert.deepEqual(decision, { action: 'promote', memberId: 'm3' });
});

test('sole admin with nobody else active left in the group: archives instead of promoting', () => {
  const context = load();
  context.members = [
    { id: 'm1', groupId: 'g1', role: 'admin', status: 'active', joinedAt: '2026-01-01T00:00:00Z' },
    { id: 'm2', groupId: 'g1', role: 'member', status: 'left', joinedAt: '2026-01-05T00:00:00Z' },
  ];
  assert.deepEqual(runJSON('pickAccountDeletionSuccessor(members, "m1")', context), { action: 'archive', memberId: null });
});

test('multi-admin groups and non-admin memberships are untouched ("none")', () => {
  const context = load();
  context.members = [
    { id: 'm1', groupId: 'g1', role: 'admin', status: 'active', joinedAt: '2026-01-01T00:00:00Z' },
    { id: 'm2', groupId: 'g1', role: 'admin', status: 'active', joinedAt: '2026-01-02T00:00:00Z' },
    { id: 'm3', groupId: 'g2', role: 'member', status: 'active', joinedAt: '2026-01-01T00:00:00Z' },
  ];
  assert.deepEqual(runJSON('pickAccountDeletionSuccessor(members, "m1")', context), { action: 'none', memberId: null },
    'a second active admin means the group is unaffected');
  assert.deepEqual(runJSON('pickAccountDeletionSuccessor(members, "m3")', context), { action: 'none', memberId: null },
    'a plain member leaving never triggers succession');
});

// ---------- scrubLocalIdentity ----------

function fixtureState() {
  return {
    groupMembers: [
      { id: 'gm1', groupId: 'g1', userId: 'u-deleted', guestId: null, displayName: 'דביר', role: 'admin', status: 'active' },
      // "me" in cloud mode keeps a local guestId alongside userId (identityRowToRef) — the
      // existing guestId must win over the fresh fallback one.
      { id: 'gm2', groupId: 'g2', userId: 'u-deleted', guestId: 'own-device-guest', displayName: 'דביר', role: 'member', status: 'active' },
      { id: 'gm3', groupId: 'g1', userId: 'u-other', guestId: null, displayName: 'יוסי', role: 'member', status: 'active' },
    ],
    players: [
      { id: 'p1', name: 'דביר', userId: 'u-deleted', guestId: null, buyins: [50, 100], cashout: 60 },
      { id: 'p2', name: 'יוסי', userId: null, guestId: 'g-yosi', buyins: [50], cashout: 90 },
    ],
    leaderRef: { userId: 'u-deleted', guestId: null, displayName: 'דביר' },
    history: [{ gameId: 'closed-1', players: [{ name: 'דביר', buyin: 150, cashout: 60, net: -90 }] }],
    debts: [{ id: 'd1', debtorName: 'דביר', creditorName: 'יוסי', amount: 90, status: 'open' }],
  };
}

test('scrubLocalIdentity drops userId everywhere it matches, keeps every displayName, and never touches an unrelated identity', () => {
  const context = load();
  context.state = fixtureState();
  context.identity = { userId: 'u-deleted', guestId: 'fresh-fallback-guest' };
  const result = runJSON('scrubLocalIdentity(state, identity)', context);

  assert.equal(result.groupMembers[0].userId, null);
  assert.equal(result.groupMembers[0].guestId, 'fresh-fallback-guest'); // no guestId of its own -> fallback
  assert.equal(result.groupMembers[0].displayName, 'דביר'); // snapshot name kept, exactly like the SQL side
  assert.equal(result.groupMembers[1].guestId, 'own-device-guest'); // already had one -> kept, not overwritten
  assert.deepEqual(result.groupMembers[2], context.state.groupMembers[2]); // a different identity is untouched

  assert.equal(result.players[0].userId, null);
  assert.equal(result.players[0].guestId, 'fresh-fallback-guest');
  assert.deepEqual(result.players[1], context.state.players[1]); // untouched

  assert.equal(result.leaderRef.userId, null);
  assert.equal(result.leaderRef.guestId, 'fresh-fallback-guest');

  // history/debts carry no userId to begin with (see HANDOFF) — scrubLocalIdentity does not
  // even look at them, so they come back byte-identical.
  assert.deepEqual(result.history, context.state.history);
  assert.deepEqual(result.debts, context.state.debts);
});

test('scrubLocalIdentity never changes a money field — every balance total is identical before and after', () => {
  const context = load();
  const before = fixtureState();
  context.state = before;
  context.identity = { userId: 'u-deleted', guestId: null }; // no guestId supplied -> newId() stub fallback
  const after = runJSON('scrubLocalIdentity(state, identity)', context);

  const totals = (s) => s.players.reduce((t, p) => ({
    buyins: t.buyins + p.buyins.reduce((a, b) => a + b, 0),
    cashouts: t.cashouts + (Number(p.cashout) || 0),
  }), { buyins: 0, cashouts: 0 });
  assert.deepEqual(totals(after), totals(before));
  // Not just the sums — the per-player arrays themselves are byte-identical.
  assert.deepEqual(after.players[0].buyins, [50, 100]);
  assert.equal(after.players[0].cashout, 60);
  assert.deepEqual(after.players[1].buyins, [50]);
  assert.equal(after.players[1].cashout, 90);
  // Untouched by design (no userId field there at all — see the function's own comment).
  assert.deepEqual(after.debts, before.debts);
});

// ---------- docs/backend/delete-account.sql ----------

test('the SQL function is SECURITY DEFINER, resolves only the caller via auth.uid(), revokes public access, and never mentions service_role', () => {
  const sql = fs.readFileSync('docs/backend/delete-account.sql', 'utf8');
  // Empty parens: it can only ever act on the caller, never a passed-in target id.
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_delete_my_account\(\)/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = public/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_delete_my_account\(\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_delete_my_account\(\) TO authenticated/);
  assert.ok(!/service_role/i.test(sql), 'a client-reachable RPC must never reference service_role');
});

// ---------- kupa-sgura.html: the danger zone ----------

test('the danger zone (heading + entry point) is gated on authUser, and the markup starts hidden', () => {
  const start = html.indexOf('function refreshSettings()');
  const close = html.indexOf('\n  }', start);
  assert.ok(start >= 0 && close > start, 'missing refreshSettings()');
  const body = html.slice(start, close);
  assert.match(body, /setDangerTitle"\)\.hidden = !authUser/);
  assert.match(body, /setDeleteAccountToggle"\)\.hidden = !authUser/);
  assert.match(html, /<p class="settings-danger-title" id="setDangerTitle" hidden>אזור מסוכן<\/p>/);
  assert.match(html, /<button[^>]*id="setDeleteAccountToggle" hidden/);
});

test('confirmation is the one-second hold pattern (not a second click-to-arm), and failure never touches local state before the RPC confirms', () => {
  const deleteSection = sourceBetween(
    '  // ---------- account deletion (danger zone) ----------',
    '  // Hide the tab bar while the on-screen keyboard is open'
  );
  // Same shape as beginFinishGameHold/endFinishGameHold: a pointerdown timer that fires the
  // action, not an "armed" flag flipped by a plain click.
  assert.match(deleteSection, /getElementById\("deleteAccountHoldBtn"\)/);
  assert.match(deleteSection, /addEventListener\("pointerdown", beginDeleteAccountHold\)/);
  assert.match(deleteSection, /\}, DELETE_ACCOUNT_HOLD_MS\);/);
  assert.match(deleteSection, /supabase\.rpc\("app_delete_my_account"\)/);
  // No alert/confirm/form submit anywhere in the flow (Claude-artifact + product constraint).
  assert.ok(!/\balert\(|\bconfirm\(|\.submit\(\)/.test(deleteSection));
  // A rejected/failed RPC only sets the inline error — it must never reach scrubLocalIdentity,
  // signOutAccount() or save().
  const catchBlock = deleteSection.slice(deleteSection.indexOf('catch (e) {'));
  const catchBody = catchBlock.slice(0, catchBlock.indexOf('}'));
  assert.match(catchBody, /setDeleteAccountError\(/);
  assert.ok(!/scrubLocalIdentity|signOutAccount\(\)|\bsave\(\)/.test(catchBody), 'failure must not destroy anything local');
});
