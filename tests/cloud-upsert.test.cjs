// Cloud push: new rows must be INSERTed, not merge-upserted.
//
// Production bug: `upsert(rows, { onConflict: "id" })` compiles to INSERT ... ON CONFLICT DO
// UPDATE, so PostgreSQL evaluates the UPDATE policy too. Those policies re-read the target row
// through STABLE SECURITY DEFINER helpers (app_can_read_game / app_is_group_admin) which cannot
// see the row being inserted -> 42501, and no game ever reached the server.
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
const storeSource = sourceBetween('  // ---------- cloud store (Supabase) ----------', '  // ---------- cloud mapping (pure) ----------');

function load() {
  const context = vm.createContext({});
  vm.runInContext(pureSource, context);
  return context;
}

test('splitCloudWrites sends unknown rows as inserts and changed known rows as updates', () => {
  const ctx = load();
  const out = ctx.splitCloudWrites(
    [{ id: 'a', v: 2 }, { id: 'b', v: 1 }],
    ['a'],
    'id'
  );
  assert.deepEqual(JSON.parse(JSON.stringify(out.inserts)), [{ id: 'b', v: 1 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(out.updates)), [{ id: 'a', v: 2 }]);
});

test('an unchanged row never reaches either pass (diffCollections already dropped it)', () => {
  const ctx = load();
  const previous = [{ id: 'a', v: 1 }];
  const next = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  const diff = ctx.diffCollections(previous, next, 'id');
  const split = ctx.splitCloudWrites(diff.upserts, previous.map(r => r.id), 'id');
  assert.deepEqual(JSON.parse(JSON.stringify(split.updates)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(split.inserts)), [{ id: 'b', v: 1 }]);
});

test('splitCloudWrites ignores rows with no id and tolerates a missing baseline', () => {
  const ctx = load();
  const out = ctx.splitCloudWrites([{ id: 'a' }, { v: 1 }, null], null, 'id');
  assert.equal(out.inserts.length, 1);
  assert.equal(out.updates.length, 0);
});

test('the push plan keeps FK order as data: parents before children', () => {
  const match = storeSource.match(/const CLOUD_TABLES = \[([\s\S]*?)\];/);
  assert.ok(match, 'CLOUD_TABLES literal not found');
  const plan = vm.runInNewContext('[' + match[1] + ']');
  const order = plan.map(pair => pair[0]);
  const at = key => order.indexOf(key);
  assert.ok(at('guests') < at('groupMembers'));
  assert.ok(at('guests') < at('gameParticipants'));
  assert.ok(at('groups') < at('groupMembers'));
  assert.ok(at('groups') < at('invites'));
  assert.ok(at('games') < at('gameParticipants'));
  assert.ok(at('gameParticipants') < at('entries'));
  assert.ok(at('gameParticipants') < at('transfers'));
  assert.ok(at('transfers') < at('gamesClosed'));
  assert.ok(at('gamesClosed') < at('debts'));
});

test('no cloud write ever asks for representation', () => {
  const writes = storeSource.match(/\.(?:insert|upsert|update)\([\s\S]{0,200}?\)\s*\.select\(/g);
  assert.equal(writes, null, 'a write chains .select(), which the SELECT policy refuses on a new row');
});

test('the games branch no longer merge-upserts a row the server may not hold', () => {
  assert.ok(storeSource.includes('splitCloudWrites(upserts, known, "id")'),
    'the push must split its rows into inserts and updates');
  assert.ok(storeSource.includes('.upsert(split.inserts, { onConflict: "id", ignoreDuplicates: true })'),
    'new rows must go up as INSERT ... ON CONFLICT DO NOTHING');
  assert.ok(storeSource.includes('.upsert(split.updates, { onConflict: "id" })'),
    'known rows keep the merge upsert');
  assert.ok(!/upsert\(upserts, \{ onConflict: "id" \}\)/.test(storeSource),
    'no collection may merge-upsert its whole diff any more');
});

test('every participant carries exactly one identity', () => {
  const ctx = load();
  const check = vm.runInContext('CLOUD_PUSHABLE.gameParticipants', ctx);
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    game_id: '22222222-2222-4222-8222-222222222222',
    display_name_snapshot: 'דביר',
    status: 'active', exited_at: null, cashout: null,
  };
  const uuid = '33333333-3333-4333-8333-333333333333';
  assert.equal(check({ ...base, profile_id: uuid, guest_id: null }), true);
  assert.equal(check({ ...base, profile_id: null, guest_id: uuid }), true);
  assert.equal(check({ ...base, profile_id: uuid, guest_id: uuid }), false);
  assert.equal(check({ ...base, profile_id: null, guest_id: null }), false);
});
