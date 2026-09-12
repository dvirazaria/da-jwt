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

// One contiguous slice from the groups-domain marker through "function el(" — it covers both
// the groups domain section (normalizeInvite, normalizeParticipantRef) and the invites (pure)
// section right after it, same pattern groups-domain.test.cjs / group-page.test.cjs already use.
const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

// createInvite calls newId() to mint the invite id; the isolated slice does not define it.
function load(newIdStub) {
  const context = vm.createContext({ newId: newIdStub || (() => 'stub-invite-id') });
  vm.runInContext(pureSource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- generateInviteToken ----------

test('generateInviteToken maps 8 random bytes onto the 32-char no-ambiguous-chars alphabet', () => {
  const context = load();
  // bytes 0..7 map straight onto the first 8 alphabet letters (index i % 32 === i for i < 32).
  const token = vm.runInContext('generateInviteToken([0,1,2,3,4,5,6,7])', context);
  assert.equal(token, 'ABCDEFGH');
  assert.equal(token.length, 8);
});

test('generateInviteToken wraps bytes >= alphabet length with modulo, and never emits 0/O/1/I', () => {
  const context = load();
  const token = vm.runInContext('generateInviteToken([32,33,34,35,36,37,38,39])', context); // +32 wraps to same as 0..7
  assert.equal(token, 'ABCDEFGH');
  const allChars = vm.runInContext(
    'Array.from({length:256}, (_,i)=>i).map(b => generateInviteToken([b,b,b,b,b,b,b,b])).join("")',
    context
  );
  assert.doesNotMatch(allChars, /[0O1I]/);
});

// ---------- createInvite / activeInvite / revokeInvite ----------

test('createInvite pushes a normalized invite (createdAt = at, revokedAt = null) and returns it', () => {
  const context = load(() => 'invite-1');
  const invites = [];
  Object.assign(context, { invites });
  const invite = runJSON(
    `createInvite(invites, 'g1', {guestId:'u1', displayName:'דביר'}, 'ABCDEFGH', '2026-09-08T10:00:00.000Z')`,
    context
  );
  assert.deepEqual(invite, {
    id: 'invite-1', groupId: 'g1', token: 'ABCDEFGH',
    createdBy: { userId: null, guestId: 'u1', displayName: 'דביר' },
    createdAt: '2026-09-08T10:00:00.000Z', revokedAt: null, boundGuestId: null,
  });
  assert.equal(vm.runInContext('invites.length', context), 1);
});

// boundGuestId (docs/backend/link-guest.sql path 1 — the invite-bound linking picker) is an
// optional 6th argument; omitting it (the test above) and passing '' both mean "no binding".
test('createInvite accepts an optional boundGuestId — the local mirror of invites.bound_guest_id', () => {
  const context = load(() => 'invite-2');
  const invites = [];
  Object.assign(context, { invites });
  const invite = runJSON(
    `createInvite(invites, 'g1', {guestId:'u1', displayName:'דביר'}, 'ABCDEFGH', '2026-09-08T10:00:00.000Z', 'guest-david')`,
    context
  );
  assert.equal(invite.boundGuestId, 'guest-david');
});

test('activeInvite returns the latest non-revoked invite for the group, or null', () => {
  const context = load();
  const invites = [
    { id: 'i1', groupId: 'g1', token: 'AAAAAAAA', createdAt: '2026-09-01T00:00:00.000Z', revokedAt: null },
    { id: 'i2', groupId: 'g1', token: 'BBBBBBBB', createdAt: '2026-09-05T00:00:00.000Z', revokedAt: null },
    { id: 'i3', groupId: 'g1', token: 'CCCCCCCC', createdAt: '2026-09-08T00:00:00.000Z', revokedAt: '2026-09-08T01:00:00.000Z' },
    { id: 'i4', groupId: 'g2', token: 'DDDDDDDD', createdAt: '2026-09-09T00:00:00.000Z', revokedAt: null },
  ];
  Object.assign(context, { invites });
  // i3 is newest but revoked, so the latest still-active one for g1 is i2.
  assert.equal(vm.runInContext(`activeInvite(invites, 'g1').id`, context), 'i2');
  assert.equal(vm.runInContext(`activeInvite(invites, 'g3')`, context), null);
  assert.equal(vm.runInContext(`activeInvite([], 'g1')`, context), null);
});

test('revokeInvite sets revokedAt and returns true; false when missing or already revoked', () => {
  const context = load();
  const invites = [
    { id: 'i1', groupId: 'g1', token: 'AAAAAAAA', createdAt: 't1', revokedAt: null },
    { id: 'i2', groupId: 'g1', token: 'BBBBBBBB', createdAt: 't2', revokedAt: 't3' },
  ];
  Object.assign(context, { invites });
  assert.equal(vm.runInContext(`revokeInvite(invites, 'i1', '2026-09-08T12:00:00.000Z')`, context), true);
  assert.equal(vm.runInContext(`invites[0].revokedAt`, context), '2026-09-08T12:00:00.000Z');
  assert.equal(vm.runInContext(`revokeInvite(invites, 'i2', 'now')`, context), false); // already revoked
  assert.equal(vm.runInContext(`revokeInvite(invites, 'missing', 'now')`, context), false);
});

// ---------- inviteLink / formatInviteCode ----------

test('inviteLink joins origin + pathname + ?join=token', () => {
  const context = load();
  assert.equal(
    vm.runInContext(`inviteLink('ABCDEFGH', 'https://poker-tau-pink.vercel.app', '/')`, context),
    'https://poker-tau-pink.vercel.app/?join=ABCDEFGH'
  );
});

test('inviteLink never sends another phone to this device loopback address', () => {
  const context = load();
  assert.equal(
    vm.runInContext(`inviteLink('ABCDEFGH', 'http://127.0.0.1:8765', '/')`, context),
    'https://poker-tau-pink.vercel.app/?join=ABCDEFGH'
  );
  assert.equal(
    vm.runInContext(`inviteLink('ABCDEFGH', 'http://localhost:8765', '/')`, context),
    'https://poker-tau-pink.vercel.app/?join=ABCDEFGH'
  );
  assert.equal(
    vm.runInContext(`inviteLink('ABCDEFGH', 'https://preview.example.com', '/')`, context),
    'https://preview.example.com/?join=ABCDEFGH'
  );
});

test('formatInviteCode splits the 8-char token into XXXX-XXXX', () => {
  const context = load();
  assert.equal(vm.runInContext(`formatInviteCode('ABCDEFGH')`, context), 'ABCD-EFGH');
});

// ---------- parseJoinToken ----------

test('parseJoinToken accepts a valid ?join= token and uppercases a lowercase one', () => {
  const context = load();
  assert.equal(vm.runInContext(`parseJoinToken('?join=ABCDEFGH')`, context), 'ABCDEFGH');
  assert.equal(vm.runInContext(`parseJoinToken('?join=abcdefgh')`, context), 'ABCDEFGH');
  assert.equal(vm.runInContext(`parseJoinToken('?other=x&join=ABCDEFGH')`, context), 'ABCDEFGH');
});

test('parseJoinToken strips a dash the way the formatted code displays it', () => {
  const context = load();
  assert.equal(vm.runInContext(`parseJoinToken('?join=ABCD-EFGH')`, context), 'ABCDEFGH');
});

test('parseJoinToken rejects a missing param, wrong length, or disallowed characters (0/O/1/I)', () => {
  const context = load();
  assert.equal(vm.runInContext(`parseJoinToken('')`, context), null);
  assert.equal(vm.runInContext(`parseJoinToken('?foo=bar')`, context), null);
  assert.equal(vm.runInContext(`parseJoinToken('?join=SHORT')`, context), null);
  assert.equal(vm.runInContext(`parseJoinToken('?join=ABCDEFG0')`, context), null); // 0 not in alphabet
  assert.equal(vm.runInContext(`parseJoinToken('?join=ABCDEFGI')`, context), null); // I not in alphabet
});

// ---------- wiring: renderGroupPage renders the invite section ----------

// D1 moved the invite block off the (long) group page and into the group settings overlay,
// where every active member can still reach it through the header's "הגדרות".
test('the group settings overlay renders the group invite, and the group page no longer does', () => {
  const page = sourceBetween('  function renderGroupPage() {', '  function renderAddRowChips() {');
  assert.doesNotMatch(page, /renderGroupInvite/);
  const overlay = sourceBetween('  function refreshGroupSettings() {', '  function openGroupSettings() {');
  assert.match(overlay, /renderGroupInvite\(summary, activeInvite\(state\.invites, currentGroupId\), summary\.isAdmin\)/);
});

test('renderGroupInvite is defined right after renderGroupHistory', () => {
  const source = sourceBetween('  function renderGroupHistory(gameSummaries) {', '  function renderGroupPage(');
  assert.match(source, /function renderGroupInvite\(summary, invite, isAdmin\) \{/);
  assert.match(source, /if \(!summary \|\| !summary\.isMember\) return null;/);
});

// ---------- wiring: no fake join / no state mutation from the URL ----------

test('the join-notice flow never pushes to state.groupMembers or state.groups', () => {
  // Boot still reads the token; the notice and its redemption live in the join-by-invite
  // section, which reaches the server through app_redeem_invite and never writes locally —
  // membership arrives on the next pullCloud() like any other row.
  const bootSource = html.slice(html.indexOf('  // ---------- boot ----------'));
  assert.match(bootSource, /parseJoinToken\(location\.search\)/);
  const joinSource = html.slice(
    html.indexOf('  // ---------- join by invite ----------'),
    html.indexOf('  // ---------- boot ----------'));
  assert.match(joinSource, /history\.replaceState\(/);
  [bootSource, joinSource].forEach(source => {
    assert.doesNotMatch(source, /state\.groupMembers\.push/);
    assert.doesNotMatch(source, /state\.groups\.push/);
  });
});

test('createGroupInvite and revokeGroupInvite save() and re-render the active group surface, using no alert/confirm', () => {
  const source = sourceBetween('  function createGroupInvite(groupId, boundGuestId) {', '  function resetCreateGroupPanel(');
  assert.match(source, /save\(\);/);
  assert.match(source, /renderGroupSurface\(\);/);
  assert.doesNotMatch(source, /\balert\(/);
  assert.doesNotMatch(source, /\bconfirm\(/);
});

// ---------- incident: invite creation must not be offered to a non-admin ----------
//
// docs/backend/link-guest.sql's invites_insert_admin requires app_is_group_admin(group_id); a
// regular (non-admin) member's INSERT is refused server-side no matter what the client renders.
// Before this guard, renderGroupInvite's "no invite yet" branch showed "צור הזמנה" to any active
// member (only the *revoke* button was ever isAdmin-gated) -- a non-admin could create a fully
// rendered local invite (code/link/QR, all optimistic), which the next push then had rejected by
// invites_insert_admin (42501): classifyCloudError surfaces that as the red sync dot, and the
// invite was never actually written server-side, so every friend who opened that link or scanned
// that QR got app_redeem_invite's 'invalid' -- one client/server authorization mismatch behind
// three separate-looking symptoms.
test('renderGroupInvite gates invite CREATION on isAdmin, not just revocation', () => {
  const source = sourceBetween('  function renderGroupHistory(gameSummaries) {', '  function renderGroupPage(');
  // The "no invite yet" branch checks isAdmin before ever building the create button, and bails
  // out with a plain note instead -- matching invites_insert_admin's server-side requirement.
  assert.match(
    source,
    /if \(!invite\) \{\s*if \(!isAdmin\) \{\s*section\.appendChild\(el\("p", "games-invite-note", "רק מנהל הקבוצה יכול ליצור הזמנה"\)\);\s*return section;\s*\}/,
    'a non-admin with no invite yet must see a note, not "צור הזמנה"'
  );
  // Exactly two isAdmin checks: the new creation gate, and the pre-existing revoke-button gate.
  // Nothing else in this function (copy/share/WhatsApp/QR for an EXISTING invite) may become
  // admin-only -- invites_select_members already allows every active member to read/share it.
  assert.equal((source.match(/if \(isAdmin\)|if \(!isAdmin\)/g) || []).length, 2);
});

test('an admin still gets the create-invite button and bind picker, unchanged', () => {
  const source = sourceBetween('  function renderGroupHistory(gameSummaries) {', '  function renderGroupPage(');
  const createBranch = source.slice(source.indexOf('if (!invite) {'), source.indexOf('const card = el("div", "games-invite-card")'));
  assert.match(createBranch, /renderInviteGuestBindPicker\(summary\.groupId\)/);
  assert.match(createBranch, /el\("button", "games-invite-create", "צור הזמנה"\)/);
  assert.match(createBranch, /createGroupInvite\(summary\.groupId, inviteBindGuestId\)/);
});

test('an existing invite is still fully visible/copyable/shareable to a non-admin member', () => {
  const source = sourceBetween('  function renderGroupHistory(gameSummaries) {', '  function renderGroupPage(');
  const existingBranch = source.slice(source.indexOf('const card = el("div", "games-invite-card")'));
  // None of copy/share/WhatsApp/QR sit behind an isAdmin check -- only "בטל הזמנה" does.
  const beforeRevoke = existingBranch.slice(0, existingBranch.indexOf('if (isAdmin)'));
  assert.match(beforeRevoke, /games-invite-action.*העתק קישור/s);
  assert.match(beforeRevoke, /qrSvgElement\(/);
  assert.doesNotMatch(beforeRevoke, /isAdmin/);
});
