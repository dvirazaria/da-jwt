// The pull/push ordering hazard that lost a fresh group_members row (2026-09-08).
//
// The shape of the bug: a pull's SELECTs go out, the user creates a group, the push writes both
// rows and marks them "confirmed" in the diff baseline, and only THEN does the older pull payload
// land. mergeCloudIntoState replaces the four cloud-backed collections wholesale, and its only
// protection used to be `cloudUnconfirmedIds()` — an inference from that same baseline — so a row
// the push had just confirmed was unprotected and the merge deleted it locally. The baseline was
// then rebuilt from the (row-less) server snapshot, so nothing ever re-sent it.
//
// The fix is an explicit pending-id set plus a write sequence, both exercised here through the
// real functions: markPendingIds / clearPendingIds / keepLocalIdsFor / mergeCloudIntoState, plus
// buildAdminMembershipRepair for the self-heal. The wiring itself (which cannot run in a vm slice
// — it is all supabase and DOM) is pinned structurally at the bottom.
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
const storeSource = sourceBetween('  // ---------- cloud store (Supabase) ----------', '  // ---- realtime: the open table ----');

function load() {
  const context = vm.createContext({});
  vm.runInContext(pureSource, context);
  return context;
}
function call(context, code) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

const P1 = '11111111-1111-4111-8111-111111111111';
const G1 = '22222222-2222-4222-8222-222222222222';
const GR1 = '33333333-3333-4333-8333-333333333333';
const M1 = '44444444-4444-4444-8444-444444444444';
const NEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const group = {
  id: GR1, name: 'אצל אפק', avatarDataUrl: null, deletedAt: null,
  createdBy: { userId: null, guestId: G1, displayName: 'דביר' }, createdAt: '2026-09-08T10:00:00.000Z',
};
const member = {
  id: M1, groupId: GR1, userId: null, guestId: G1, displayName: 'דביר',
  role: 'admin', status: 'active', joinedAt: '2026-09-08T10:00:00.000Z', leftAt: null, hiddenAt: null,
};
const localState = { groups: [group], groupMembers: [member], invites: [], friendships: [] };
const EMPTY_PULL = { groups: [], groupMembers: [], invites: [], friendships: [] };

// ---------- the regression ----------

test('a stale pull cannot delete rows a push only just confirmed', (t) => {
  const ctx = load();
  // 1. The pull's SELECTs go out. 2. The user creates the group: every local id becomes pending.
  const pending = call(ctx, `[...markPendingIds(new Set(), ${JSON.stringify(localState)})]`);
  assert.deepEqual(pending.sort(), [GR1, M1].sort());
  // 3. The push confirms nothing yet (still in flight), so the baseline says the server is empty
  //    and cloudUnconfirmedIds() would report both ids. Even if it reported NOTHING — which is
  //    exactly what happens once the push lands and the baseline holds both rows — the pending set
  //    is what keeps them.
  const keep = call(ctx, `keepLocalIdsFor(new Set(${JSON.stringify(pending)}), [])`);
  assert.deepEqual(keep.sort(), [GR1, M1].sort());
  // 4. The older payload lands: the server, as it looked before the insert, holds nothing.
  const merged = call(ctx,
    `mergeCloudIntoState(${JSON.stringify(localState)}, ${JSON.stringify(EMPTY_PULL)}, { keepLocalIds: ${JSON.stringify(keep)} })`);
  assert.equal(merged.groups.length, 1, 'the group survives the stale pull');
  assert.equal(merged.groupMembers.length, 1, 'the membership row survives the stale pull');
  assert.equal(merged.groupMembers[0].id, M1);
  // Without the pending set (the old behaviour) the very same merge wipes both.
  const unprotected = call(ctx,
    `mergeCloudIntoState(${JSON.stringify(localState)}, ${JSON.stringify(EMPTY_PULL)}, { keepLocalIds: [] })`);
  assert.equal(unprotected.groups.length, 0);
  assert.equal(unprotected.groupMembers.length, 0);
});

test('the member row survives a pull that returns the group but not the membership', (t) => {
  const ctx = load();
  const pending = call(ctx, `[...markPendingIds(new Set(), ${JSON.stringify(localState)})]`);
  const keep = call(ctx, `keepLocalIdsFor(new Set(${JSON.stringify(pending)}), [])`);
  const pulled = { ...EMPTY_PULL, groups: [group] };
  const merged = call(ctx,
    `mergeCloudIntoState(${JSON.stringify(localState)}, ${JSON.stringify(pulled)}, { keepLocalIds: ${JSON.stringify(keep)} })`);
  assert.equal(merged.groups.length, 1);
  assert.deepEqual(merged.groupMembers.map(m => m.id), [M1], 'exactly the production symptom, prevented');
});

test('a confirmed push releases the ids, and the server may then drop the row', (t) => {
  const ctx = load();
  const confirmedRows = { groups: [{ id: GR1 }], groupMembers: [{ id: M1 }], invites: [], friendships: [] };
  const pending = call(ctx,
    `[...clearPendingIds(markPendingIds(new Set(), ${JSON.stringify(localState)}), ${JSON.stringify(confirmedRows)})]`);
  assert.deepEqual(pending, [], 'nothing is protected once the push confirmed it');
  // Now — and only now — a pull that no longer holds the rows is authoritative: the group was
  // removed elsewhere, so it goes here too.
  const merged = call(ctx,
    `mergeCloudIntoState(${JSON.stringify(localState)}, ${JSON.stringify(EMPTY_PULL)}, { keepLocalIds: keepLocalIdsFor(new Set(), []) })`);
  assert.deepEqual(merged.groups, []);
  assert.deepEqual(merged.groupMembers, []);
});

test('a partial push only releases the collections it actually wrote', (t) => {
  const ctx = load();
  // groups landed, group_members threw: the member id stays protected.
  const confirmedRows = { groups: [{ id: GR1 }], groupMembers: [], invites: [], friendships: [] };
  const pending = call(ctx,
    `[...clearPendingIds(markPendingIds(new Set(), ${JSON.stringify(localState)}), ${JSON.stringify(confirmedRows)})]`);
  assert.deepEqual(pending, [M1]);
  const merged = call(ctx,
    `mergeCloudIntoState(${JSON.stringify(localState)}, ${JSON.stringify({ ...EMPTY_PULL, groups: [group] })}, { keepLocalIds: ${JSON.stringify(pending)} })`);
  assert.deepEqual(merged.groupMembers.map(m => m.id), [M1]);
});

// ---------- self-heal ----------

const identity = { newId: NEW, userId: P1, guestId: G1, displayName: 'דביר' };
const AT = '2026-09-08T12:00:00.000Z';

test('a group I created with no active members regains exactly one admin row', (t) => {
  const ctx = load();
  const collections = { groups: [group], groupMembers: [] };
  const repair = call(ctx,
    `buildAdminMembershipRepair(${JSON.stringify(collections)}, ${JSON.stringify(GR1)}, ${JSON.stringify(identity)}, ${JSON.stringify(AT)})`);
  assert.equal(repair.mode, 'create');
  assert.deepEqual(repair.member, {
    id: NEW, groupId: GR1, userId: P1, guestId: G1, displayName: 'דביר',
    role: 'admin', status: 'active', joinedAt: AT, leftAt: null, hiddenAt: null,
  });
  // Idempotent: with that row in place there is nothing left to repair.
  const after = { groups: [group], groupMembers: [repair.member] };
  assert.equal(call(ctx,
    `buildAdminMembershipRepair(${JSON.stringify(after)}, ${JSON.stringify(GR1)}, ${JSON.stringify(identity)}, ${JSON.stringify(AT)})`), null);
});

test('my own left row is revived in place rather than duplicated', (t) => {
  const ctx = load();
  const left = { ...member, status: 'left', leftAt: AT };
  const collections = { groups: [group], groupMembers: [left] };
  const repair = call(ctx,
    `buildAdminMembershipRepair(${JSON.stringify(collections)}, ${JSON.stringify(GR1)}, ${JSON.stringify(identity)}, ${JSON.stringify(AT)})`);
  assert.equal(repair.mode, 'reactivate');
  assert.equal(repair.member.id, M1, 'same id: game history is attributed through it');
  assert.equal(repair.member.status, 'active');
  assert.equal(repair.member.leftAt, null);
  assert.equal(repair.member.guestId, G1);
});

test('the repair refuses every case that is not my own memberless group', (t) => {
  const ctx = load();
  const other = { ...group, createdBy: { userId: null, guestId: 'x', displayName: 'אפק' } };
  const q = (collections, gid) => call(ctx,
    `buildAdminMembershipRepair(${JSON.stringify(collections)}, ${JSON.stringify(gid)}, ${JSON.stringify(identity)}, ${JSON.stringify(AT)})`);
  assert.equal(q({ groups: [other], groupMembers: [] }, GR1), null, 'somebody else created it');
  assert.equal(q({ groups: [group], groupMembers: [member] }, GR1), null, 'it already has an active member');
  assert.equal(q({ groups: [{ ...group, deletedAt: AT }], groupMembers: [] }, GR1), null, 'deleted group');
  assert.equal(q({ groups: [group], groupMembers: [] }, 'nope'), null, 'unknown group');
});

// ---------- structure: the ordering rules live in the store, not in a pure slice ----------

test('a pull never starts while a push is pending or in flight', (t) => {
  assert.match(storeSource, /if \(cloudPushTimer \|\| cloudPushing\) \{ scheduleCloudPull\(600\); return; \}/,
    'pullCloud defers instead of reading a server our writes have not reached');
  assert.match(storeSource, /cloudPushTimer \|\| cloudPushing \|\| Date\.now\(\) < dirtyUntil/,
    'applyCloudPull still refuses to land on top of a pending push');
  assert.match(storeSource, /if \(pullSeq !== undefined && pullSeq !== cloudWriteSeq\) \{ scheduleCloudPull\(800\); return; \}/,
    'a payload older than the last local write is dropped, not merged');
  assert.match(storeSource, /if \(cloudPushing\) \{[\s\S]*?pushCloud\(\)/, 'two pushes never run at once');
});

test('a push failure stays visible and retries the payload once before falling back to a pull', (t) => {
  const catchBlock = storeSource.slice(storeSource.indexOf('    } catch (e) {'));
  assert.match(catchBlock, /setSync\(false, "שגיאת שמירה — נשמר מקומית"\)/);
  assert.match(catchBlock, /if \(!cloudPushRetried\) \{[\s\S]*?cloudPushRetried = true;[\s\S]*?pushCloud\(\)/);
  assert.match(catchBlock, /cloudPushRetried = false;\n      scheduleCloudPull\(1200\)/);
  assert.match(storeSource, /clearCloudPending\(confirmed\)/, 'only the rows that landed stop being pending');
});

test('every local write marks its rows pending and bumps the write sequence', (t) => {
  const schedule = storeSource.slice(storeSource.indexOf('  function scheduleCloudPush()'));
  assert.match(schedule, /cloudWriteSeq\+\+;\n    markCloudPending\(\);/);
  assert.match(storeSource, /keepLocalIds: cloudKeepLocalIds\(\)/, 'the merge uses pending ids, not only the baseline');
});

test('the whole mechanism is inert without a session', (t) => {
  assert.match(storeSource, /function scheduleCloudPush\(\) \{\n    if \(!supabase \|\| !authUser\) return;/);
  assert.match(storeSource, /function pushCloud\(\) \{\n    if \(!supabase \|\| !authUser\) return;/);
  assert.match(storeSource, /function pullCloud\(\) \{\n    if \(!supabase \|\| !authUser\) return;/);
  assert.match(html, /function repairMyGroupMembership\(groupId\) \{\n    if \(!cloudMode\(\) \|\| !me\) return;/);
});
