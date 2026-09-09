// F6 (docs/backend/security-fixes.sql) collides with fix-upsert-policies.sql: dropping the
// standing "OR I am the creator" branch from five UPDATE policies is exactly what caused the
// pre-9eafade 42501-on-first-write bug. The fix kept here is client-side (pushCloudRun already
// routes all five affected tables through splitCloudWrites, so their UPDATE policies only ever
// run against a row the server has already confirmed) rather than re-adding a standing privilege
// to the SQL. These tests pin both halves so neither drifts back without the other noticing:
//   - the SQL never re-grows a bare standing creator branch on the five policies,
//   - the client never merge-upserts one of those five tables outside the insert/update split.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sql = fs.readFileSync('docs/backend/security-fixes.sql', 'utf8');
const introspect = fs.readFileSync('tools/rls-introspect.sql', 'utf8');
const html = fs.readFileSync('kupa-sgura.html', 'utf8');

const FIVE_POLICIES = [
  'groups_update_admin',
  'group_members_update_admin',
  'invites_update_admin',
  'games_update_member',
  'game_participants_update',
];

// The exact statement text of one `CREATE POLICY <name> ... ;` block. None of the five bodies in
// this file contain a nested semicolon, so "up to the next ;" is the whole statement.
function policyStatement(name) {
  const marker = `CREATE POLICY ${name} `;
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, `${name}: CREATE POLICY not found in security-fixes.sql`);
  const end = sql.indexOf(';', start);
  assert.ok(end > start, `${name}: no terminating ; found`);
  return sql.slice(start, end + 1);
}

test('security-fixes.sql stays a single BEGIN/COMMIT-wrapped transaction', () => {
  const begins = sql.match(/^BEGIN;$/gm) || [];
  const commits = sql.match(/^COMMIT;$/gm) || [];
  assert.equal(begins.length, 1, 'expected exactly one top-level BEGIN;');
  assert.equal(commits.length, 1, 'expected exactly one top-level COMMIT;');
  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('COMMIT;'), 'BEGIN must precede COMMIT');
});

test('security-fixes.sql carries no service-role key or secret material', () => {
  assert.doesNotMatch(sql, /service_role/i);
  assert.doesNotMatch(sql, /sb_secret_/i);
});

test('none of the five upsert-collision policies keeps a bare standing creator branch', () => {
  const creatorBranch = /created_by(?:_profile_id)?\s*=\s*app_current_profile_id\(\)/;
  FIVE_POLICIES.forEach(name => {
    const stmt = policyStatement(name);
    assert.doesNotMatch(stmt, creatorBranch,
      `${name} must not test created_by[_profile_id] = app_current_profile_id() directly — ` +
      'that is the standing privilege F6 removes (a demoted admin/removed creator must lose it)');
  });
});

test('each of the five policies carries a comment explaining why the upsert path stays open', () => {
  FIVE_POLICIES.forEach(name => {
    const marker = `CREATE POLICY ${name} `;
    const at = sql.indexOf(marker);
    assert.ok(at >= 0, `${name}: not found`);
    const terminator = sql.indexOf(';', at);
    const window = sql.slice(Math.max(0, at - 1200), terminator + 600);
    assert.match(window, /Upsert-safe/,
      `${name}: expected an "Upsert-safe" rationale comment near its policy body`);
  });
});

test('F1, F2, F4, F5 and F7 fixes are still present (this task only touches F6 prose)', () => {
  assert.match(sql, /F1 \(CRITICAL\)/);
  assert.ok(sql.includes('identity_key(gp.profile_id, gp.guest_id)'), 'F1: participant-identity check');
  assert.match(sql, /F2 \(HIGH\)/);
  assert.ok(sql.includes('app_profile_is_active_group_member(g.group_id, game_participants.profile_id)'),
    'F2: subject-of-the-row check');
  assert.match(sql, /F4 \(MEDIUM\)/);
  assert.ok(sql.includes('GRANT EXECUTE ON FUNCTION app_is_friend_of(uuid) TO authenticated;'), 'F4: EXECUTE revocations');
  assert.match(sql, /F5 \(MEDIUM\), active half/);
  assert.ok(sql.includes('REVOKE SELECT (phone) ON profiles FROM authenticated;'), 'F5: phone column revoke');
  assert.match(sql, /F7 \(LOW\)/);
  assert.ok(sql.includes('SET search_path = public\nAS $$\n  SELECT auth.uid()'), 'F7: search_path pin');
});

test('tools/rls-introspect.sql is purely read-only', () => {
  // Strip -- line comments before scanning: the header prose freely discusses INSERT/UPDATE/
  // GRANT etc. in English; only real statement text must never contain a mutating verb.
  const withoutComments = introspect.replace(/--[^\n]*/g, '');
  const mutatingVerbs = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|MERGE)\b/i;
  assert.doesNotMatch(withoutComments, mutatingVerbs);
  const statements = withoutComments.split(';').map(s => s.trim()).filter(Boolean);
  assert.ok(statements.length >= 4, 'expected at least the four documented SELECT blocks');
  statements.forEach(stmt => assert.match(stmt, /^SELECT\b/i, `non-SELECT statement: ${stmt.slice(0, 60)}...`));
});

test('CLOUD_INSERT_ONLY excludes every table the F6 upsert-collision policies guard', () => {
  const match = html.match(/const CLOUD_INSERT_ONLY = (\{[^}]*\});/);
  assert.ok(match, 'CLOUD_INSERT_ONLY literal not found');
  const map = vm.runInNewContext('(' + match[1] + ')');
  // These five collections must keep going through splitCloudWrites (pushCloudRun's other
  // branch): a row this device has not seen confirmed must go up as INSERT ... DO NOTHING, never
  // as a plain merge upsert, now that their UPDATE policies carry no creator fallback.
  ['groups', 'groupMembers', 'invites', 'games', 'gameParticipants'].forEach(key => {
    assert.ok(!map[key], `${key} must not be in CLOUD_INSERT_ONLY — it would skip the insert/update split`);
  });
  // Sanity: the map itself still does what it always did for the append-only tables. (Round-trip
  // through JSON first: a vm-realm object literal has a different [[Prototype]] than one written
  // in this file, which deepEqual/deepStrictEqual treats as unequal even when every value matches
  // — the same reason tests/cloud-upsert.test.cjs does this for splitCloudWrites' vm output.)
  assert.deepEqual(JSON.parse(JSON.stringify(map)), { entries: true, transfers: true, debts: true });
});
