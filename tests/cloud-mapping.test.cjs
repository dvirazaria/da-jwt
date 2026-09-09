// Cloud mapping + cloud store wiring (Supabase phase 2a).
//
// The pure half of phase 2a is the row <-> local-model mapping for groups, group_members,
// invites, friendships and guests. It is DOM-free and state-free on purpose, so the whole
// section runs inside a vm slice exactly like the groups-domain suite does.
//
// The contract this suite pins down:
//   * every entity round-trips local -> row -> local unchanged, nulls included;
//   * the identity pattern from docs/backend/schema.sql holds — exactly one of profile_id /
//     guest_id is non-null, mine is the profile, everybody else is a guest;
//   * a row the schema or RLS would refuse (legacy non-uuid id, no identity, a friendship this
//     device may not write) never leaves the device;
//   * diffCollections only reports what actually changed, so a push is idempotent;
//   * mergeCloudIntoState replaces the four cloud-backed collections and nothing else.
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

function load() {
  const context = vm.createContext({});
  vm.runInContext(pureSource, context);
  return context;
}
// vm.runInContext hands back objects from the sandbox realm, so deepEqual against a native
// literal fails on prototypes alone. JSON round-tripping strips that (same helper as the
// groups-domain suite).
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// Ids have to look like real uuids: anything else is deliberately unpushable.
const P1 = '11111111-1111-4111-8111-111111111111'; // my profile (auth user id)
const P2 = '88888888-8888-4888-8888-888888888888'; // somebody else's profile
const G1 = '22222222-2222-4222-8222-222222222222'; // the local guestId this device uses for me
const GU2 = '55555555-5555-4555-8555-555555555555'; // a real guest
const GR1 = '33333333-3333-4333-8333-333333333333';
const M1 = '44444444-4444-4444-8444-444444444444';
const M2 = '66666666-6666-4666-8666-666666666666';
const IV1 = '77777777-7777-4777-8777-777777777777';
const F1 = '99999999-9999-4999-8999-999999999999';

const CTX = { profileId: P1, guestId: G1, displayName: 'דביר', profileIds: [P1, P2] };
const ctxLiteral = JSON.stringify(CTX);

// ---------- round trips ----------
// Phase 2b note: a ROW that carries a profile_id comes back with that id on the ref (`userId`),
// because losing it would demote an account holder to a guest on the next push. `guestId` still
// follows the phase 2a rule, so identityKey() and every closed game on this device keep pointing
// at the same person. The fixtures below are therefore written the way a pulled record looks.

test('a group round-trips local -> row -> local, nulls included', () => {
  const context = load();
  const group = {
    id: GR1, name: 'ערב פוקר', avatarDataUrl: null,
    createdBy: { userId: P1, guestId: G1, displayName: 'דביר' },
    createdAt: '2026-09-01T20:00:00.000Z', archivedAt: null, deletedAt: null,
  };
  const row = runJSON(`groupToRow(${JSON.stringify(group)}, ${ctxLiteral})`, context);
  assert.deepEqual(row, {
    id: GR1, name: 'ערב פוקר', created_by_profile_id: P1,
    created_at: '2026-09-01T20:00:00.000Z', archived_at: null, deleted_at: null,
  });
  assert.deepEqual(runJSON(`rowToGroup(${JSON.stringify(row)}, ${ctxLiteral})`, context), group);
});

test('an archived + soft-deleted group keeps both timestamps through the round trip', () => {
  const context = load();
  const group = {
    id: GR1, name: 'ישן', avatarDataUrl: null,
    createdBy: { userId: P1, guestId: G1, displayName: 'דביר' },
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: '2026-02-01T00:00:00.000Z', deletedAt: '2026-03-01T00:00:00.000Z',
  };
  const row = runJSON(`groupToRow(${JSON.stringify(group)}, ${ctxLiteral})`, context);
  assert.equal(row.archived_at, '2026-02-01T00:00:00.000Z');
  assert.equal(row.deleted_at, '2026-03-01T00:00:00.000Z');
  assert.deepEqual(runJSON(`rowToGroup(${JSON.stringify(row)}, ${ctxLiteral})`, context), group);
});

test('the group avatar never leaves the device (avatar_url is object storage, not a data URL)', () => {
  const context = load();
  const group = {
    id: GR1, name: 'ערב פוקר', avatarDataUrl: 'data:image/jpeg;base64,AAA',
    createdBy: { userId: null, guestId: G1, displayName: 'דביר' },
    createdAt: '2026-09-01T20:00:00.000Z', archivedAt: null, deletedAt: null,
  };
  const row = runJSON(`groupToRow(${JSON.stringify(group)}, ${ctxLiteral})`, context);
  assert.ok(!('avatar_url' in row), 'avatar_url must not be written from the local data URL');
  assert.equal(JSON.stringify(row).includes('data:image'), false);
  assert.equal(runJSON(`rowToGroup(${JSON.stringify(row)}, ${ctxLiteral})`, context).avatarDataUrl, null);
});

test('a guest membership round-trips and carries guest_id, never profile_id', () => {
  const context = load();
  const member = {
    id: M2, groupId: GR1, userId: null, guestId: GU2, displayName: 'יוסי',
    role: 'member', status: 'active', joinedAt: '2026-09-02T18:00:00.000Z',
    leftAt: null, hiddenAt: null,
  };
  const row = runJSON(`groupMemberToRow(${JSON.stringify(member)}, ${ctxLiteral})`, context);
  assert.deepEqual(row, {
    id: M2, group_id: GR1, profile_id: null, guest_id: GU2,
    display_name_snapshot: 'יוסי', role: 'member', status: 'active',
    joined_at: '2026-09-02T18:00:00.000Z', left_at: null,
  });
  assert.deepEqual(runJSON(`rowToGroupMember(${JSON.stringify(row)}, ${ctxLiteral})`, context), member);
});

test('my own membership becomes a profile row and comes back as the same local record', () => {
  const context = load();
  const member = {
    id: M1, groupId: GR1, userId: null, guestId: G1, displayName: 'דביר',
    role: 'admin', status: 'active', joinedAt: '2026-09-01T20:00:00.000Z',
    leftAt: null, hiddenAt: null,
  };
  const row = runJSON(`groupMemberToRow(${JSON.stringify(member)}, ${ctxLiteral})`, context);
  assert.equal(row.profile_id, P1);
  assert.equal(row.guest_id, null);
  // Phase 2b: the record comes back with the profile id it earned; everything else is untouched,
  // and the next push maps it to exactly the same row.
  const back = runJSON(`rowToGroupMember(${JSON.stringify(row)}, ${ctxLiteral})`, context);
  assert.deepEqual(back, Object.assign({}, member, { userId: P1 }));
  assert.deepEqual(runJSON(`groupMemberToRow(${JSON.stringify(back)}, ${ctxLiteral})`, context), row);
});

test('an invite round-trips, and its creator is the signed-in profile', () => {
  const context = load();
  const invite = {
    id: IV1, groupId: GR1, token: 'ABCD2345',
    createdBy: { userId: P1, guestId: G1, displayName: 'דביר' },
    createdAt: '2026-09-03T09:00:00.000Z', revokedAt: null,
  };
  const row = runJSON(`inviteToRow(${JSON.stringify(invite)}, ${ctxLiteral})`, context);
  assert.deepEqual(row, {
    id: IV1, group_id: GR1, token: 'ABCD2345', created_by_profile_id: P1,
    created_at: '2026-09-03T09:00:00.000Z', revoked_at: null,
  });
  assert.deepEqual(runJSON(`rowToInvite(${JSON.stringify(row)}, ${ctxLiteral})`, context), invite);
});

test('a friendship round-trips between two profiles and keeps respondedAt null while pending', () => {
  const context = load();
  const friendship = {
    id: F1,
    requester: { userId: P1, guestId: G1, displayName: 'דביר' },
    addressee: { userId: P2, guestId: P2, displayName: '' },
    status: 'pending', createdAt: '2026-09-04T12:00:00.000Z', respondedAt: null,
  };
  const row = runJSON(`friendshipToRow(${JSON.stringify(friendship)}, ${ctxLiteral})`, context);
  assert.deepEqual(row, {
    id: F1, requester_profile_id: P1, addressee_profile_id: P2, status: 'pending',
    created_at: '2026-09-04T12:00:00.000Z', responded_at: null,
  });
  assert.deepEqual(runJSON(`rowToFriendship(${JSON.stringify(row)}, ${ctxLiteral})`, context), friendship);
});

// ---------- identity precedence ----------

test('exactly one of profile_id / guest_id is ever non-null', () => {
  const context = load();
  const cases = [
    { userId: null, guestId: G1, displayName: 'דביר' },   // me, by my local guestId
    { userId: null, guestId: null, displayName: 'דביר' }, // me, by name only
    { userId: null, guestId: GU2, displayName: 'יוסי' },  // a guest
    { userId: null, guestId: P2, displayName: '' },       // another account this device has seen
  ];
  for (const ref of cases) {
    const row = runJSON(`refToIdentityRow(${JSON.stringify(ref)}, ${ctxLiteral})`, context);
    const nonNulls = [row.profile_id, row.guest_id].filter(v => v !== null && v !== undefined);
    assert.equal(nonNulls.length, 1, `${JSON.stringify(ref)} -> ${JSON.stringify(row)}`);
  }
  assert.equal(runJSON(`refToIdentityRow(${JSON.stringify(cases[0])}, ${ctxLiteral})`, context).profile_id, P1);
  assert.equal(runJSON(`refToIdentityRow(${JSON.stringify(cases[1])}, ${ctxLiteral})`, context).profile_id, P1);
  assert.equal(runJSON(`refToIdentityRow(${JSON.stringify(cases[2])}, ${ctxLiteral})`, context).guest_id, GU2);
  assert.equal(runJSON(`refToIdentityRow(${JSON.stringify(cases[3])}, ${ctxLiteral})`, context).profile_id, P2);
});

test('a namesake with a different guestId is not me once this device knows my own guestId', () => {
  const context = load();
  const other = { userId: null, guestId: GU2, displayName: 'דביר' };
  const row = runJSON(`refToIdentityRow(${JSON.stringify(other)}, ${ctxLiteral})`, context);
  assert.equal(row.profile_id, null);
  assert.equal(row.guest_id, GU2);
});

test('without a session there is no identity at all, so nothing is pushable', () => {
  const context = load();
  const row = runJSON(`refToIdentityRow({userId:null,guestId:null,displayName:'דביר'}, {profileId:null})`, context);
  assert.deepEqual(row, { profile_id: null, guest_id: null });
});

// ---------- schema repairs ----------

test('a former member always gets a left_at and an active one never does', () => {
  const context = load();
  const removed = {
    id: M2, groupId: GR1, userId: null, guestId: GU2, displayName: 'יוסי',
    role: 'member', status: 'removed', joinedAt: '2026-09-02T18:00:00.000Z',
    leftAt: null, hiddenAt: null,
  };
  const row = runJSON(`groupMemberToRow(${JSON.stringify(removed)}, ${ctxLiteral})`, context);
  // group_members_left_at_chk: status <> 'active' requires a left_at. Fall back to joined_at
  // rather than inventing "now" (the mapper is pure) or dropping the row.
  assert.equal(row.left_at, '2026-09-02T18:00:00.000Z');

  const active = { ...removed, status: 'active', leftAt: '2026-09-05T00:00:00.000Z' };
  const activeRow = runJSON(`groupMemberToRow(${JSON.stringify(active)}, ${ctxLiteral})`, context);
  assert.equal(activeRow.left_at, null, 'group_members_active_chk: an active member has no left_at');
});

test('an answered friendship always carries responded_at (friendships_responded_chk)', () => {
  const context = load();
  const accepted = {
    id: F1,
    requester: { userId: null, guestId: P2, displayName: '' },
    addressee: { userId: null, guestId: G1, displayName: 'דביר' },
    status: 'accepted', createdAt: '2026-09-04T12:00:00.000Z', respondedAt: null,
  };
  const row = runJSON(`friendshipToRow(${JSON.stringify(accepted)}, ${ctxLiteral})`, context);
  assert.equal(row.responded_at, '2026-09-04T12:00:00.000Z');
});

test('guestToRow carries the creator and never sends a blank display_name', () => {
  const context = load();
  assert.deepEqual(runJSON(`guestToRow('${GU2}', '  יוסי  ', '${P1}')`, context),
    { id: GU2, display_name: 'יוסי', created_by: P1 });
  assert.equal(runJSON(`guestToRow('${GU2}', '', '${P1}')`, context).display_name, 'אורח');
  // guests.display_name is CHECK (length(btrim(display_name)) BETWEEN 1 AND 40)
  assert.equal(runJSON(`guestToRow('${GU2}', '${'x'.repeat(80)}', '${P1}')`, context).display_name.length, 40);
});

// ---------- buildCloudRows: what actually leaves the device ----------

const COLLECTIONS = {
  groups: [
    { id: GR1, name: 'ערב פוקר', avatarDataUrl: null,
      createdBy: { userId: null, guestId: G1, displayName: 'דביר' },
      createdAt: '2026-09-01T20:00:00.000Z', archivedAt: null, deletedAt: null },
    { id: 'legacy-group', name: 'ישן', avatarDataUrl: null,
      createdBy: { userId: null, guestId: null, displayName: 'דביר' },
      createdAt: '2025-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null },
  ],
  groupMembers: [
    { id: M1, groupId: GR1, userId: null, guestId: G1, displayName: 'דביר',
      role: 'admin', status: 'active', joinedAt: '2026-09-01T20:00:00.000Z', leftAt: null, hiddenAt: null },
    { id: M2, groupId: GR1, userId: null, guestId: GU2, displayName: 'יוסי',
      role: 'member', status: 'active', joinedAt: '2026-09-02T18:00:00.000Z', leftAt: null, hiddenAt: null },
    // no identity at all -> unpushable (group_members_identity_chk)
    { id: '11111111-2222-4333-8444-555555555555', groupId: GR1, userId: null, guestId: null, displayName: '',
      role: 'member', status: 'active', joinedAt: '2026-09-02T18:00:00.000Z', leftAt: null, hiddenAt: null },
    // belongs to a group that is not pushable -> dropped with it (FK order)
    { id: '22222222-3333-4444-8555-666666666666', groupId: 'legacy-group', userId: null, guestId: GU2,
      displayName: 'יוסי', role: 'member', status: 'active', joinedAt: '2025-01-01T00:00:00.000Z',
      leftAt: null, hiddenAt: null },
  ],
  invites: [
    { id: IV1, groupId: GR1, token: 'ABCD2345',
      createdBy: { userId: null, guestId: G1, displayName: 'דביר' },
      createdAt: '2026-09-03T09:00:00.000Z', revokedAt: null },
    { id: 'legacy-invite', groupId: GR1, token: 'ZZZZ9999',
      createdBy: { userId: null, guestId: G1, displayName: 'דביר' },
      createdAt: '2026-09-03T09:00:00.000Z', revokedAt: null },
  ],
  friendships: [],
};

test('buildCloudRows returns every table in FK order and drops legacy non-uuid ids', () => {
  const context = load();
  const rows = runJSON(`buildCloudRows(${JSON.stringify(COLLECTIONS)}, ${ctxLiteral})`, context);
  // The game tables (phase 2b) come after the group tables they depend on; see
  // tests/cloud-games.test.cjs for what goes into them.
  assert.deepEqual(Object.keys(rows), ['guests', 'groups', 'groupMembers', 'invites', 'friendships',
    'games', 'gameParticipants', 'entries', 'transfers', 'gamesClosed', 'debts', 'debtPayments']);
  assert.deepEqual(rows.groups.map(g => g.id), [GR1]);
  assert.deepEqual(rows.invites.map(i => i.id), [IV1]);
  assert.equal(JSON.stringify(rows).includes('legacy-'), false, 'a non-uuid id must never be sent');
});

test('buildCloudRows drops a member with no identity and one whose group is not pushable', () => {
  const context = load();
  const rows = runJSON(`buildCloudRows(${JSON.stringify(COLLECTIONS)}, ${ctxLiteral})`, context);
  assert.deepEqual(rows.groupMembers.map(m => m.id), [M1, M2]);
  assert.equal(rows.groupMembers[0].profile_id, P1);
  assert.equal(rows.groupMembers[1].guest_id, GU2);
});

test('buildCloudRows mints one guests row per guest identity, created_by the signed-in profile', () => {
  const context = load();
  const rows = runJSON(`buildCloudRows(${JSON.stringify(COLLECTIONS)}, ${ctxLiteral})`, context);
  assert.deepEqual(rows.guests, [{ id: GU2, display_name: 'יוסי', created_by: P1 }]);
});

test('buildCloudRows sends only friendships RLS would accept from this device', () => {
  const context = load();
  const mineToSend = {
    id: F1, requester: { userId: null, guestId: G1, displayName: 'דביר' },
    addressee: { userId: null, guestId: P2, displayName: '' },
    status: 'pending', createdAt: '2026-09-04T12:00:00.000Z', respondedAt: null,
  };
  // friendships_insert_requester: only the requester creates a pending row.
  const theirsPending = { ...mineToSend, id: '10101010-1010-4010-8010-101010101010',
    requester: { userId: null, guestId: P2, displayName: '' },
    addressee: { userId: null, guestId: G1, displayName: 'דביר' } };
  // friendships_update_addressee: only the addressee answers one.
  const theirsAnswered = { ...theirsPending, id: '20202020-2020-4020-8020-202020202020',
    status: 'accepted', respondedAt: '2026-09-05T12:00:00.000Z' };
  const mineAnswered = { ...mineToSend, id: '30303030-3030-4030-8030-303030303030',
    status: 'accepted', respondedAt: '2026-09-05T12:00:00.000Z' };
  const collections = { ...COLLECTIONS, friendships: [mineToSend, theirsPending, theirsAnswered, mineAnswered] };
  const rows = runJSON(`buildCloudRows(${JSON.stringify(collections)}, ${ctxLiteral})`, context);
  assert.deepEqual(rows.friendships.map(f => f.id), [mineToSend.id, theirsAnswered.id]);
});

test('buildCloudRows sends nothing at all without a session', () => {
  const context = load();
  const rows = runJSON(`buildCloudRows(${JSON.stringify(COLLECTIONS)}, {profileId:null,guestId:null,displayName:'דביר',profileIds:[]})`, context);
  Object.keys(rows).forEach(key => assert.deepEqual(rows[key], [], `${key} must be empty without a session`));
});

// ---------- diffCollections ----------

test('diffCollections reports added, changed and removed rows and stays quiet on unchanged ones', () => {
  const context = load();
  const prev = [{ id: 'a', name: 'one' }, { id: 'b', name: 'two' }, { id: 'c', name: 'three' }];
  const next = [{ id: 'a', name: 'one' }, { id: 'b', name: 'TWO' }, { id: 'd', name: 'four' }];
  const diff = runJSON(`diffCollections(${JSON.stringify(prev)}, ${JSON.stringify(next)}, 'id')`, context);
  assert.deepEqual(diff.upserts, [{ id: 'b', name: 'TWO' }, { id: 'd', name: 'four' }]);
  assert.deepEqual(diff.deletes, [{ id: 'c', name: 'three' }]);
});

test('diffCollections against an empty baseline pushes everything, and re-pushes nothing after', () => {
  const context = load();
  const rows = JSON.stringify([{ id: 'a', name: 'one' }, { id: 'b', name: 'two' }]);
  assert.equal(runJSON(`diffCollections([], ${rows}, 'id')`, context).upserts.length, 2);
  const second = runJSON(`diffCollections(${rows}, ${rows}, 'id')`, context);
  assert.deepEqual(second.upserts, []);
  assert.deepEqual(second.deletes, []);
});

test('a pulled row maps back to a row identical to the one on the server (idempotent pushes)', () => {
  const context = load();
  const serverRows = runJSON(`buildCloudRows(${JSON.stringify(COLLECTIONS)}, ${ctxLiteral})`, context);
  const pulled = {
    groups: serverRows.groups.map(r => runJSON(`rowToGroup(${JSON.stringify(r)}, ${ctxLiteral})`, context)),
    groupMembers: serverRows.groupMembers.map(r => runJSON(`rowToGroupMember(${JSON.stringify(r)}, ${ctxLiteral})`, context)),
    invites: serverRows.invites.map(r => runJSON(`rowToInvite(${JSON.stringify(r)}, ${ctxLiteral})`, context)),
    friendships: [],
  };
  const again = runJSON(`buildCloudRows(${JSON.stringify(pulled)}, ${ctxLiteral})`, context);
  assert.deepEqual(again, serverRows);
  const diff = runJSON(`diffCollections(${JSON.stringify(serverRows.groups)}, ${JSON.stringify(again.groups)}, 'id')`, context);
  assert.deepEqual(diff.upserts, []);
});

// ---------- mergeCloudIntoState ----------

const STATE = {
  gameId: 'g-1', phase: 'active', example: false,
  players: [{ id: 'p1', name: 'דביר', buyins: [50], entryLog: [] }],
  history: [{ gameId: 'h1', groupId: GR1, players: [] }],
  debts: [{ id: 'd1', status: 'open' }],
  settlementStatuses: { 'k': true },
  groups: [
    { id: GR1, name: 'ערב פוקר', avatarDataUrl: 'data:image/jpeg;base64,AAA',
      createdBy: { userId: null, guestId: G1, displayName: 'דביר' },
      createdAt: '2026-09-01T20:00:00.000Z', archivedAt: null, deletedAt: null },
  ],
  groupMembers: [
    { id: M1, groupId: GR1, userId: null, guestId: G1, displayName: 'דביר', role: 'admin',
      status: 'left', joinedAt: '2026-09-01T20:00:00.000Z', leftAt: '2026-09-06T00:00:00.000Z',
      hiddenAt: '2026-09-06T00:01:00.000Z' },
  ],
  invites: [], friendships: [], updatedAt: '2026-09-06T00:00:00.000Z',
};

const PULLED = {
  groups: [
    { id: GR1, name: 'ערב פוקר בשם חדש', avatarDataUrl: null,
      createdBy: { userId: null, guestId: G1, displayName: 'דביר' },
      createdAt: '2026-09-01T20:00:00.000Z', archivedAt: null, deletedAt: null },
  ],
  groupMembers: [
    { id: M1, groupId: GR1, userId: null, guestId: G1, displayName: 'דביר', role: 'admin',
      status: 'left', joinedAt: '2026-09-01T20:00:00.000Z', leftAt: '2026-09-06T00:00:00.000Z',
      hiddenAt: null },
    { id: M2, groupId: GR1, userId: null, guestId: GU2, displayName: 'יוסי', role: 'member',
      status: 'active', joinedAt: '2026-09-02T18:00:00.000Z', leftAt: null, hiddenAt: null },
  ],
  invites: [
    { id: IV1, groupId: GR1, token: 'ABCD2345',
      createdBy: { userId: null, guestId: G1, displayName: 'דביר' },
      createdAt: '2026-09-03T09:00:00.000Z', revokedAt: null },
  ],
  friendships: [],
};

test('mergeCloudIntoState replaces the four cloud collections and touches nothing else', () => {
  const context = load();
  const merged = runJSON(`mergeCloudIntoState(${JSON.stringify(STATE)}, ${JSON.stringify(PULLED)})`, context);
  assert.deepEqual(merged.players, STATE.players);
  assert.deepEqual(merged.history, STATE.history);
  assert.deepEqual(merged.debts, STATE.debts);
  assert.deepEqual(merged.settlementStatuses, STATE.settlementStatuses);
  assert.equal(merged.gameId, STATE.gameId);
  assert.equal(merged.phase, STATE.phase);
  assert.equal(merged.groups[0].name, 'ערב פוקר בשם חדש');
  assert.deepEqual(merged.groupMembers.map(m => m.id), [M1, M2]);
  assert.deepEqual(merged.invites.map(i => i.id), [IV1]);
});

test('mergeCloudIntoState keeps the two fields the schema has no column for', () => {
  const context = load();
  const merged = runJSON(`mergeCloudIntoState(${JSON.stringify(STATE)}, ${JSON.stringify(PULLED)})`, context);
  assert.equal(merged.groups[0].avatarDataUrl, 'data:image/jpeg;base64,AAA', 'the local avatar survives a pull');
  assert.equal(merged.groupMembers[0].hiddenAt, '2026-09-06T00:01:00.000Z', 'hiddenAt is device-local');
  assert.equal(merged.groupMembers[1].hiddenAt, null);
});

test('mergeCloudIntoState keeps records the server could not have returned yet', () => {
  const context = load();
  const local = {
    ...STATE,
    groups: STATE.groups.concat([{ id: 'legacy-group', name: 'ישן', avatarDataUrl: null,
      createdBy: { userId: null, guestId: null, displayName: 'דביר' },
      createdAt: '2025-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null }]),
  };
  const empty = { groups: [], groupMembers: [], invites: [], friendships: [] };
  const dropped = runJSON(`mergeCloudIntoState(${JSON.stringify(local)}, ${JSON.stringify(empty)})`, context);
  assert.deepEqual(dropped.groups, []);
  const kept = runJSON(
    `mergeCloudIntoState(${JSON.stringify(local)}, ${JSON.stringify(empty)}, {keepLocalIds:['legacy-group','${GR1}','${M1}']})`,
    context);
  assert.deepEqual(kept.groups.map(g => g.id), [GR1, 'legacy-group']); // kept rows keep local order
  assert.deepEqual(kept.groupMembers.map(m => m.id), [M1]);
});

test('mergeCloudIntoState keeps a soft-deleted group RLS hides from the pull, and its rows', () => {
  const context = load();
  const local = {
    ...STATE,
    groups: [{ ...STATE.groups[0], deletedAt: '2026-09-07T00:00:00.000Z' }],
    invites: PULLED.invites,
  };
  const empty = { groups: [], groupMembers: [], invites: [], friendships: [] };
  const merged = runJSON(`mergeCloudIntoState(${JSON.stringify(local)}, ${JSON.stringify(empty)})`, context);
  assert.deepEqual(merged.groups.map(g => g.id), [GR1]);
  assert.deepEqual(merged.groupMembers.map(m => m.id), [M1]);
  assert.deepEqual(merged.invites.map(i => i.id), [IV1]);
});

// ---------- wiring (the non-pure half) ----------

const appScript = (() => {
  const open = html.lastIndexOf('<script>');
  const close = html.indexOf('</script>', open);
  assert.ok(open >= 0 && close > open, 'missing the app <script> block');
  return html.slice(open + '<script>'.length, close);
})();

test('save() routes to the cloud push with a session and to the document sync without one', () => {
  const save = appScript.slice(appScript.indexOf('  function save()'), appScript.indexOf('  // --- server sync'));
  assert.match(save, /if \(cloudMode\(\)\) scheduleCloudPush\(\);/);
  assert.match(save, /else scheduleRemoteSave\(\);/);
  assert.match(appScript, /function cloudMode\(\) \{ return !!\(supabase && authUser\); \}/);
});

test('the Claude-document sync is skipped entirely in cloud mode', () => {
  assert.match(appScript, /function initSync\(\) \{\n    if \(cloudMode\(\)\) return;/);
  // ... and torn down when a session arrives mid-life, so the two never both own the data.
  assert.match(appScript, /function enterCloudMode\(\) \{[\s\S]*?gameDoc = null;/);
  assert.match(appScript, /enterCloudMode\(\);/);
  assert.match(appScript, /exitCloudMode\(\);/);
});

test('the push writes the five tables in FK order, upserting on the primary key', () => {
  const store = appScript.slice(
    appScript.indexOf('  // ---------- cloud store (Supabase) ----------'),
    appScript.indexOf('  // Example data promises'));
  assert.match(store, /\["guests", "guests"\][\s\S]*?\["groups", "groups"\][\s\S]*?\["groupMembers", "group_members"\][\s\S]*?\["invites", "invites"\][\s\S]*?\["friendships", "friendships"\]/);
  // A row the baseline confirms the server holds is merge-upserted; a row it has never seen
  // must be an INSERT ... ON CONFLICT DO NOTHING (see tests/cloud-upsert.test.cjs).
  assert.match(store, /\.upsert\(split\.updates, \{ onConflict: "id" \}\)/);
  assert.match(store, /\.upsert\(split\.inserts, \{ onConflict: "id", ignoreDuplicates: true \}\)/);
  // entries/transfers/debts are insert-only (no UPDATE policy / column-limited grants).
  assert.match(store, /ignoreDuplicates: true/);
});

test('a push error shows the sync dot in its error state and re-reads from the server', () => {
  const store = appScript.slice(
    appScript.indexOf('  // ---------- cloud store (Supabase) ----------'),
    appScript.indexOf('  // Example data promises'));
  assert.ok(store.includes('setSync(false, "שגיאת שמירה — נשמר מקומית")'));
  assert.ok(store.includes('setSync(true, "מסונכרן לחשבון")'));
  assert.match(store, /scheduleCloudPull\(/);
  // No alert/confirm anywhere in the new code — the sandbox blocks them.
  assert.ok(!/\balert\(|\bconfirm\(/.test(store));
});

test('every cloud call sits behind a session guard and the pull runs on visibility', () => {
  assert.match(appScript, /async function pushCloud\(\) \{\n    if \(!supabase \|\| !authUser\) return;/);
  assert.match(appScript, /async function pullCloud\(\) \{\n    if \(!supabase \|\| !authUser\) return;/);
  assert.match(appScript, /function scheduleCloudPush\(\) \{\n    if \(!supabase \|\| !authUser\) return;/);
  assert.match(appScript, /if \(cloudMode\(\)\) pullCloud\(\);/);
});

test('phase 2a still ships no secret key and invents no userId on a local ref', () => {
  assert.ok(!html.includes('sb_secret_'), 'sb_secret_ must never appear in the HTML');
  assert.ok(!html.includes('service_role'), 'service_role must never appear in the HTML');
  assert.ok(!/userId: (authUser|session|user)\b/.test(appScript), 'accounts land on refs in phase 3');
});
