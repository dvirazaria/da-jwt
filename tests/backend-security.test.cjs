// Structural invariants behind docs/backend/security-review-2026-09-09.md.
//
// These parse the .sql files as text (no network, no live database) and check the properties the
// review's live probes and static reasoning both depend on: every SECURITY DEFINER helper pins
// search_path and has EXECUTE revoked from PUBLIC, every RLS-enabled table has a policy, no real
// secret ever lands in a committed file, and identity inside a definer-rights function always
// comes from auth.uid() (via app_current_profile_id()), never from a caller-supplied parameter.
//
// The corpus is every docs/backend/*.sql file concatenated IN APPLY ORDER (schema, rls-policies,
// join-invite, fix-upsert-policies, security-fixes — the same order the project README's Commands
// section and the review both describe pasting them), with `--` line comments stripped first, so
// a later CREATE OR REPLACE wins over an earlier one exactly like it would in Postgres, and the
// deferred (commented-out, not-yet-safe-to-run) blocks in security-fixes.sql count for nothing —
// same as actually running the files would produce.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const SQL_FILES = ['schema.sql', 'rls-policies.sql', 'join-invite.sql', 'fix-upsert-policies.sql', 'security-fixes.sql'];
const stripComments = text => text.split('\n').map(line => line.replace(/--.*$/, '')).join('\n');
const corpus = SQL_FILES
  .map(name => stripComments(fs.readFileSync(path.join('docs/backend', name), 'utf8')))
  .join('\n');

// name -> { params, header } ; a later CREATE OR REPLACE overwrites an earlier one, matching how
// Postgres itself would apply these files in order.
function extractFunctions(text) {
  const fns = new Map();
  const re = /CREATE OR REPLACE FUNCTION\s+(\w+)\s*\(([^)]*)\)([\s\S]*?)AS \$\$/g;
  let m;
  while ((m = re.exec(text))) {
    fns.set(m[1], { params: m[2].trim(), header: m[3] });
  }
  return fns;
}
const functions = extractFunctions(corpus);
assert.ok(functions.size >= 9, `expected at least the 9 known helpers, found ${functions.size}`);

test('every SECURITY DEFINER function pins search_path', () => {
  const offenders = [];
  for (const [name, { header }] of functions) {
    if (/SECURITY DEFINER/.test(header) && !/SET search_path/.test(header)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'SECURITY DEFINER function(s) missing SET search_path');
});

test('every SECURITY DEFINER function has EXECUTE revoked from PUBLIC', () => {
  const offenders = [];
  for (const [name, { header }] of functions) {
    if (!/SECURITY DEFINER/.test(header)) continue;
    // Match REVOKE ... ON FUNCTION <name>(...) FROM PUBLIC — the exact param types don't matter
    // here, just that this specific function name was revoked from PUBLIC somewhere in the corpus.
    const revoked = new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${name}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC`, 'i').test(corpus);
    if (!revoked) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'SECURITY DEFINER function(s) never revoked from PUBLIC (F4)');
});

test('every table with RLS enabled has at least one policy', () => {
  const enabled = [...corpus.matchAll(/ALTER TABLE (\w+)\s+ENABLE ROW LEVEL SECURITY/g)].map(m => m[1]);
  assert.ok(enabled.length >= 11, `expected at least the 11 known tables, found ${enabled.length}`);
  const missing = enabled.filter(table => !new RegExp(`CREATE POLICY \\w+ ON ${table}\\b`).test(corpus));
  assert.deepEqual(missing, [], 'RLS-enabled table(s) with zero policies');
});

test('no real secret-shaped token appears in any git-tracked file', () => {
  // The bare words "service_role" / "sb_secret_" legitimately appear in prose docs warning
  // against using them (docs/HANDOFF-TO-CODEX.md, HANDOFF.md, docs/backend/*.md) — a blanket
  // substring ban would fail on those. What must never appear is an actual secret-SHAPED value:
  // a real sb_secret_ token (prefix + a real random tail) or a JWT-shaped legacy service key
  // (three base64url segments joined by dots, starting "eyJ").
  const secretPatterns = [
    /sb_secret_[A-Za-z0-9_-]{10,}/,
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  ];
  const binaryExt = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|pdf|mp4)$/i;
  const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean).filter(f => !binaryExt.test(f));
  const offenders = [];
  for (const file of tracked) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    if (secretPatterns.some(re => re.test(text))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('app_redeem_invite derives the actor from auth, never from a parameter', () => {
  // The one SECURITY DEFINER function in this codebase that performs a write tied to "who is
  // making this request" (join-invite.sql). If it ever grew an id-shaped parameter and started
  // trusting it as the caller, that would be an instant impersonation hole — assert its signature
  // stays exactly p_token, and that it still reads the caller from app_current_profile_id().
  const invite = functions.get('app_redeem_invite');
  assert.ok(invite, 'app_redeem_invite not found');
  assert.equal(invite.params.replace(/\s+/g, ' '), 'p_token text');
  const body = corpus.slice(corpus.indexOf('CREATE OR REPLACE FUNCTION app_redeem_invite'));
  assert.match(body.slice(0, body.indexOf('$$;', body.indexOf('AS $$'))), /app_current_profile_id\(\)/);

  // Generic guard: no function anywhere in the corpus should take a parameter that reads as
  // "trust me, this is the current user" instead of deriving it from auth.uid().
  const suspicious = ['p_caller_id', 'p_current_profile_id', 'p_my_profile_id', 'p_actor_profile_id', 'p_auth_id'];
  const offenders = [];
  for (const [name, { params }] of functions) {
    const lower = params.toLowerCase();
    if (suspicious.some(bad => lower.includes(bad))) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
