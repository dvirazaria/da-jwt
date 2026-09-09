// F3 (docs/backend/security-review-2026-09-09.md §F3, closed by docs/backend/player-boundary.sql):
// RLS enforced only the group boundary on entries/game_participants, so any active group member
// could read another player's exact buy-ins/cashout for a game they never played in and compute
// their net. The fix narrows entries_select / game_participants_select to "a participant of THIS
// game, or its creator". These tests pin, offline, the two halves of that fix:
//   - the SQL: idempotent, BEGIN/COMMIT-wrapped, no service_role/sb_secret_ material, and the two
//     policies actually narrowed to the participant-or-creator predicate;
//   - the client: cloudGameChildrenAreTrustworthy(), the pure predicate both pull-merge call
//     sites (closed history, open-game adoption) share to tell "RLS denied this game" apart from
//     "this game genuinely has no participants yet" — so a denial degrades to "omit", never to a
//     corrupted zero-player render, and never to silently adopting a game the viewer never played.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sql = fs.readFileSync('docs/backend/player-boundary.sql', 'utf8');
const html = fs.readFileSync('kupa-sgura.html', 'utf8');

test('player-boundary.sql is a single BEGIN/COMMIT-wrapped transaction', () => {
  const begins = sql.match(/^BEGIN;$/gm) || [];
  const commits = sql.match(/^COMMIT;$/gm) || [];
  assert.equal(begins.length, 1, 'expected exactly one top-level BEGIN;');
  assert.equal(commits.length, 1, 'expected exactly one top-level COMMIT;');
  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('COMMIT;'), 'BEGIN must precede COMMIT');
});

test('player-boundary.sql carries no service-role key or secret material', () => {
  assert.doesNotMatch(sql, /service_role/i);
  assert.doesNotMatch(sql, /sb_secret_/i);
});

test('player-boundary.sql defines no new function or view without REVOKE ALL ... FROM public and FROM anon', () => {
  // This migration happens to add zero new functions/views (it only narrows two existing row
  // policies) — this test still runs so it fails loudly if a future edit adds one without the
  // revoke pair the task's non-negotiables require.
  const created = [...sql.matchAll(/CREATE (?:OR REPLACE )?(?:FUNCTION|VIEW)\s+(\w+)/gi)].map(m => m[1]);
  created.forEach(name => {
    const revokedPublic = new RegExp(`REVOKE\\s+ALL[\\s\\S]{0,60}${name}[\\s\\S]{0,60}FROM\\s+PUBLIC`, 'i').test(sql);
    const revokedAnon = new RegExp(`REVOKE\\s+ALL[\\s\\S]{0,60}${name}[\\s\\S]{0,60}FROM\\s+anon`, 'i').test(sql);
    assert.ok(revokedPublic && revokedAnon, `${name}: missing REVOKE ALL ... FROM public/anon`);
  });
});

function policyStatement(name) {
  const marker = `CREATE POLICY ${name} `;
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, `${name}: CREATE POLICY not found in player-boundary.sql`);
  const end = sql.indexOf(';', start);
  return sql.slice(start, end + 1);
}

test('entries_select is narrowed to participant-of-this-game or its creator', () => {
  const stmt = policyStatement('entries_select');
  assert.match(stmt, /app_is_game_participant\(game_id\)/);
  assert.match(stmt, /g\.created_by\s*=\s*app_current_profile_id\(\)/);
  // The old group-wide gate must be gone from this policy specifically.
  assert.doesNotMatch(stmt, /app_can_read_game/);
  assert.doesNotMatch(stmt, /app_is_active_group_member/);
});

test('game_participants_select is narrowed to participant-of-this-game or its creator', () => {
  const stmt = policyStatement('game_participants_select');
  assert.match(stmt, /app_is_game_participant\(game_id\)/);
  assert.match(stmt, /g\.created_by\s*=\s*app_current_profile_id\(\)/);
  assert.doesNotMatch(stmt, /app_can_read_game/);
  assert.doesNotMatch(stmt, /app_is_active_group_member/);
});

test('both narrowed policies are DROP POLICY IF EXISTS + CREATE POLICY (idempotent, paste-ready)', () => {
  ['entries_select', 'game_participants_select'].forEach(name => {
    assert.match(sql, new RegExp(`DROP POLICY IF EXISTS ${name} ON `));
  });
});

// ----- client half: cloudGameChildrenAreTrustworthy() -----

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  // Balance braces from the first '{' after the signature to its matching close.
  const braceStart = html.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

function load() {
  const context = vm.createContext({});
  vm.runInContext(extractFunction('cloudGameChildrenAreTrustworthy'), context);
  return context;
}

test('cloudGameChildrenAreTrustworthy: non-empty participant rows are always trustworthy (viewer was granted read)', () => {
  const ctx = load();
  assert.equal(ctx.cloudGameChildrenAreTrustworthy({ created_by: 'someone-else' }, [{ id: 'p1' }], 'me'), true);
});

test('cloudGameChildrenAreTrustworthy: empty rows + viewer is the creator is a genuine empty-shell game', () => {
  const ctx = load();
  assert.equal(ctx.cloudGameChildrenAreTrustworthy({ created_by: 'me' }, [], 'me'), true);
});

test('cloudGameChildrenAreTrustworthy: empty rows + viewer is NOT the creator is a denial, not an empty game', () => {
  const ctx = load();
  assert.equal(ctx.cloudGameChildrenAreTrustworthy({ created_by: 'someone-else' }, [], 'me'), false);
  assert.equal(ctx.cloudGameChildrenAreTrustworthy({ created_by: null }, [], 'me'), false);
});

test('cloudGameChildrenAreTrustworthy: no viewer profile id never counts as the creator', () => {
  const ctx = load();
  assert.equal(ctx.cloudGameChildrenAreTrustworthy({ created_by: null }, [], null), false);
  assert.equal(ctx.cloudGameChildrenAreTrustworthy({ created_by: '' }, [], ''), false);
});

test('applyCloudPull filters closed history and open-game candidates through the same predicate', () => {
  assert.match(html, /const history = \(payload\.closedGames \|\| \[\]\)\s*\n\s*\.filter\(row => cloudGameChildrenAreTrustworthy/);
  assert.match(html, /const openCandidates = \(payload\.openGames \|\| \[\]\)[\s\S]{0,200}cloudGameChildrenAreTrustworthy/);
});
