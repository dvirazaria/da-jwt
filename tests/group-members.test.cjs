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

// addGroupMember mints a fresh id via newId() for a brand-new member. The isolated pure-section
// slice does not define it (it lives elsewhere in the file), so tests supply a stub the same
// way tests/groups-domain.test.cjs does for resolveGuestId/newCurrentGame.
function load(newIdStub) {
  const context = vm.createContext({ newId: newIdStub || (() => 'stub-new-id') });
  vm.runInContext(pureSource, context);
  return context;
}

// vm.runInContext returns objects/arrays from the sandbox's own realm, so a plain deepEqual
// against a native literal fails on "same structure, not reference-equal". Round-tripping
// through JSON strips that -- same helper as tests/groups-domain.test.cjs.
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// Loads `members` as an in-sandbox variable so pure functions that mutate their array argument
// in place can be exercised and re-read across multiple vm.runInContext calls.
function loadMembers(members, newIdStub) {
  const context = load(newIdStub);
  vm.runInContext(`var members = ${JSON.stringify(members)};`, context);
  return context;
}

// ---------- addGroupMember ----------

test('addGroupMember adds a new active member, mutating the passed array, and returns the record', () => {
  const context = loadMembers([], () => 'new-member-id');
  const ref = { userId: null, guestId: 'guest-9', displayName: '  שרה  ' };
  const added = runJSON(
    `addGroupMember(members, {id:'g1'}, ${JSON.stringify(ref)}, 'member', '2026-09-08T10:00:00Z')`,
    context
  );
  assert.equal(added.id, 'new-member-id');
  assert.equal(added.groupId, 'g1');
  assert.equal(added.guestId, 'guest-9');
  assert.equal(added.displayName, 'שרה'); // trimmed
  assert.equal(added.role, 'member');
  assert.equal(added.status, 'active');
  assert.equal(added.joinedAt, '2026-09-08T10:00:00Z');
  const members = runJSON('members', context);
  assert.equal(members.length, 1);
  assert.equal(members[0].id, 'new-member-id');
});

test('addGroupMember refuses when the group has no id or the ref has no (trimmed) displayName', () => {
  const context = loadMembers([]);
  assert.equal(vm.runInContext(`addGroupMember(members, {}, {displayName:'x'}, 'member', 't')`, context), null);
  assert.equal(vm.runInContext(`addGroupMember(members, {id:'g1'}, {displayName:'   '}, 'member', 't')`, context), null);
  assert.equal(runJSON('members', context).length, 0); // no mutation on refusal
});

test('addGroupMember refuses an active duplicate by identity (guestId) even under a different typed name', () => {
  const existing = [
    { id: 'm1', groupId: 'g1', guestId: 'guest-1', displayName: 'דביר', role: 'member', status: 'active' },
  ];
  const context = loadMembers(existing);
  const result = vm.runInContext(
    `addGroupMember(members, {id:'g1'}, {userId:null, guestId:'guest-1', displayName:'שם אחר'}, 'member', 't')`,
    context
  );
  assert.equal(result, null);
  assert.equal(runJSON('members', context).length, 1);
});

test('addGroupMember refuses an active duplicate by trimmed displayName even under a different guestId', () => {
  const existing = [
    { id: 'm1', groupId: 'g1', guestId: 'guest-1', displayName: 'דביר', role: 'member', status: 'active' },
  ];
  const context = loadMembers(existing);
  const result = vm.runInContext(
    `addGroupMember(members, {id:'g1'}, {userId:null, guestId:'guest-2', displayName:'  דביר  '}, 'member', 't')`,
    context
  );
  assert.equal(result, null);
  assert.equal(runJSON('members', context).length, 1);
});

test('addGroupMember duplicate guard is scoped to the group: the same identity in another group is fine', () => {
  const existing = [
    { id: 'm1', groupId: 'g2', guestId: 'guest-1', displayName: 'דביר', role: 'member', status: 'active' },
  ];
  const context = loadMembers(existing, () => 'fresh-id');
  const added = runJSON(
    `addGroupMember(members, {id:'g1'}, {userId:null, guestId:'guest-1', displayName:'דביר'}, 'member', 't')`,
    context
  );
  assert.ok(added);
  assert.equal(added.groupId, 'g1');
  assert.equal(runJSON('members', context).length, 2);
});

test('addGroupMember re-activates a former member with the same identity instead of duplicating', () => {
  const existing = [
    {
      id: 'm1', groupId: 'g1', guestId: 'guest-1', displayName: 'דביר', role: 'member',
      status: 'removed', leftAt: '2026-01-01T00:00:00Z', joinedAt: '2025-01-01T00:00:00Z',
    },
  ];
  const context = loadMembers(existing, () => 'should-not-be-used');
  const added = runJSON(
    `addGroupMember(members, {id:'g1'}, {userId:null, guestId:'guest-1', displayName:'דביר'}, 'member', '2026-09-08T10:00:00Z')`,
    context
  );
  assert.equal(added.id, 'm1'); // same record reused, not a fresh id
  assert.equal(added.status, 'active');
  assert.equal(added.leftAt, null);
  assert.equal(added.joinedAt, '2026-09-08T10:00:00Z');
  assert.equal(runJSON('members', context).length, 1); // no second record pushed
});

// ---------- removeGroupMember ----------

test('removeGroupMember soft-removes an active member, keeping the record for history attribution', () => {
  const existing = [
    { id: 'm1', groupId: 'g1', role: 'admin', status: 'active' },
    { id: 'm2', groupId: 'g1', role: 'member', status: 'active' },
  ];
  const context = loadMembers(existing);
  assert.equal(vm.runInContext(`removeGroupMember(members, 'm2', '2026-09-08T10:00:00Z')`, context), true);
  const members = runJSON('members', context);
  assert.equal(members.length, 2); // record kept, not deleted
  assert.equal(members[1].status, 'removed');
  assert.equal(members[1].leftAt, '2026-09-08T10:00:00Z');
});

test('removeGroupMember refuses a missing member and an already-former member', () => {
  const existing = [
    { id: 'm1', groupId: 'g1', role: 'admin', status: 'active' },
    { id: 'm2', groupId: 'g1', role: 'member', status: 'left' },
  ];
  const context = loadMembers(existing);
  assert.equal(vm.runInContext(`removeGroupMember(members, 'missing', 't')`, context), false);
  assert.equal(vm.runInContext(`removeGroupMember(members, 'm2', 't')`, context), false);
  assert.equal(runJSON('members', context)[1].status, 'left'); // unchanged
});

test('removeGroupMember refuses removing the last active admin, but allows it when a co-admin remains', () => {
  const soleAdmin = [{ id: 'm1', groupId: 'g1', role: 'admin', status: 'active' }];
  const soleContext = loadMembers(soleAdmin);
  assert.equal(vm.runInContext(`removeGroupMember(members, 'm1', 't')`, soleContext), false);
  assert.equal(runJSON('members', soleContext)[0].status, 'active');

  const coAdmins = [
    { id: 'm1', groupId: 'g1', role: 'admin', status: 'active' },
    { id: 'm2', groupId: 'g1', role: 'admin', status: 'active' },
  ];
  const coContext = loadMembers(coAdmins);
  assert.equal(vm.runInContext(`removeGroupMember(members, 'm1', 't')`, coContext), true);
});

// ---------- leaveGroup ----------

test('leaveGroup sets status "left" for the caller\'s own active membership, matched by displayName', () => {
  const existing = [
    { id: 'm1', groupId: 'g1', displayName: 'דביר', role: 'admin', status: 'active' },
    { id: 'm2', groupId: 'g1', displayName: 'רותם', role: 'member', status: 'active' },
  ];
  const context = loadMembers(existing);
  assert.equal(vm.runInContext(`leaveGroup(members, 'g1', 'רותם', '2026-09-08T10:00:00Z')`, context), true);
  const members = runJSON('members', context);
  assert.equal(members[1].status, 'left');
  assert.equal(members[1].leftAt, '2026-09-08T10:00:00Z');
  assert.equal(members[0].status, 'active'); // untouched
});

test('leaveGroup refuses when the caller is not an active member, or is the group\'s last active admin', () => {
  const existing = [{ id: 'm1', groupId: 'g1', displayName: 'דביר', role: 'admin', status: 'active' }];
  const context = loadMembers(existing);
  assert.equal(vm.runInContext(`leaveGroup(members, 'g1', 'לא-חבר', 't')`, context), false);
  assert.equal(vm.runInContext(`leaveGroup(members, 'g1', 'דביר', 't')`, context), false);
  assert.equal(runJSON('members', context)[0].status, 'active');
});

// ---------- setMemberRole ----------

test('setMemberRole promotes/demotes a member and normalizes an unrecognized role to "member"', () => {
  const existing = [
    { id: 'm1', groupId: 'g1', role: 'admin', status: 'active' },
    { id: 'm2', groupId: 'g1', role: 'member', status: 'active' },
  ];
  const context = loadMembers(existing);
  assert.equal(vm.runInContext(`setMemberRole(members, 'm2', 'admin')`, context), true);
  assert.equal(vm.runInContext(`setMemberRole(members, 'm1', 'owner')`, context), true); // unknown -> "member"
  const members = runJSON('members', context);
  assert.equal(members[1].role, 'admin');
  assert.equal(members[0].role, 'member');
});

test('setMemberRole refuses a missing member and refuses demoting the last active admin', () => {
  const existing = [{ id: 'm1', groupId: 'g1', role: 'admin', status: 'active' }];
  const context = loadMembers(existing);
  assert.equal(vm.runInContext(`setMemberRole(members, 'missing', 'admin')`, context), false);
  assert.equal(vm.runInContext(`setMemberRole(members, 'm1', 'member')`, context), false);
  assert.equal(runJSON('members', context)[0].role, 'admin'); // unchanged
});

// ---------- isLastActiveAdmin ----------

test('isLastActiveAdmin is true only for the sole active admin of that member\'s group', () => {
  const members = [
    { id: 'm1', groupId: 'g1', role: 'admin', status: 'active' },
    { id: 'm2', groupId: 'g1', role: 'member', status: 'active' },
    { id: 'm3', groupId: 'g2', role: 'admin', status: 'active' }, // a different group
  ];
  const context = load();
  assert.equal(vm.runInContext(`isLastActiveAdmin(${JSON.stringify(members)}, 'm1')`, context), true);
  assert.equal(vm.runInContext(`isLastActiveAdmin(${JSON.stringify(members)}, 'm2')`, context), false); // not an admin
  assert.equal(vm.runInContext(`isLastActiveAdmin(${JSON.stringify(members)}, 'missing')`, context), false);
});

test('isLastActiveAdmin is false with a co-admin present, and false for a non-active admin', () => {
  const context = load();
  const withCoAdmin = [
    { id: 'm1', groupId: 'g1', role: 'admin', status: 'active' },
    { id: 'm2', groupId: 'g1', role: 'admin', status: 'active' },
  ];
  assert.equal(vm.runInContext(`isLastActiveAdmin(${JSON.stringify(withCoAdmin)}, 'm1')`, context), false);
  const removedAdmin = [{ id: 'm1', groupId: 'g1', role: 'admin', status: 'removed' }];
  assert.equal(vm.runInContext(`isLastActiveAdmin(${JSON.stringify(removedAdmin)}, 'm1')`, context), false);
});

// ---------- UI wiring (regex over the full source) ----------

test('addMemberByName is wired to resolveGuestId and addGroupMember, not a parallel ad-hoc implementation', () => {
  assert.match(html, /function addMemberByName\(groupId, name\)/);
  assert.match(html, /resolveGuestId\(collectionsOf\(state\), trimmed\)/);
  assert.match(html, /addGroupMember\(state\.groupMembers, group, ref, "member", at\)/);
});

test('removeMember is wired to removeGroupMember and the group page re-renders after save', () => {
  assert.match(html, /function removeMember\(groupId, memberId\)/);
  assert.match(html, /removeGroupMember\(state\.groupMembers, memberId, new Date\(\)\.toISOString\(\)\)/);
});

test('the remove control is a two-step armed confirm (like resetBtn/setClearBtn), not a single click', () => {
  assert.match(html, /removeMemberArmedId/);
  assert.match(html, /removeMemberArmedTimeout/);
  assert.match(html, /"בטוח\?"/);
  assert.match(html, /armed/);
});

// D1: renderGroupMembers keeps the active/former lists; "+ הוסף חבר" and its note moved into
// the group settings overlay (see tests/design-round.test.cjs for the overlay wiring).
test('renderGroupMembers takes active and former members and keeps the former-members toggle', () => {
  assert.match(html, /function renderGroupMembers\(members, former, isAdmin\)/);
  assert.match(html, /\+ הוסף חבר/);
  assert.match(html, /חברים לשעבר/);
  assert.match(html, /el\("p", "games-member-add-note", SERVER_NOTE\)/);
});

test('a duplicate add-member submission shakes the input instead of silently failing', () => {
  const addMemberSection = sourceBetween('function renderAddMemberPanel(', '  function toggleAddMemberPanel(');
  assert.match(addMemberSection, /shakeEl\(nameInput\)/);
});
