// GitHub Actions keepalive workflow for the Supabase free-tier project.
//
// Supabase pauses a free project after 7 consecutive days with no database activity, which
// silently breaks sign-in/sync for everyone with no warning. .github/workflows/keepalive.yml is
// the guard: a scheduled, zero-setup job that pings the project every 3 days using only the
// public publishable/anon key. This suite checks the workflow's structure (schedule +
// workflow_dispatch), that it can never need a service-role/secret key, that it degrades to the
// same public key already committed in kupa-sgura.html when no repo secret is configured, and
// that it targets the same project ref the app itself talks to. See docs/backend/keepalive.md
// for the full write-up (why the project pauses, how to verify a run, how to un-pause).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const WORKFLOW_PATH = '.github/workflows/keepalive.yml';
const DOC_PATH = 'docs/backend/keepalive.md';

test('the keepalive workflow file exists', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), `${WORKFLOW_PATH} is missing`);
});

// Every other test needs the file's contents; read it once, tolerating absence so the single
// existence assertion above is the one that fails first and clearly.
const workflow = fs.existsSync(WORKFLOW_PATH) ? fs.readFileSync(WORKFLOW_PATH, 'utf8') : '';

// ---------- triggers ----------

test('runs on a schedule and can also be triggered manually', () => {
  assert.match(workflow, /^on:/m, 'missing a top-level `on:` trigger block');
  assert.match(workflow, /^\s*schedule:/m, 'missing `schedule:`');
  assert.match(workflow, /cron:\s*["'][^"']+["']/, 'missing a quoted cron expression');
  assert.match(workflow, /^\s*workflow_dispatch:/m, 'missing `workflow_dispatch:` for manual runs');
});

test('the cron expression is well-formed and fires every 3 days', () => {
  const m = workflow.match(/cron:\s*["']([^"']+)["']/);
  assert.ok(m, 'no cron expression found');
  const fields = m[1].trim().split(/\s+/);
  assert.equal(fields.length, 5, `cron expression must have exactly 5 fields, got "${m[1]}"`);
  const [minute, hour, dayOfMonth] = fields;
  assert.doesNotMatch(minute, /\*/, 'minute should be a fixed value, not a wildcard, to avoid an hourly run');
  assert.doesNotMatch(hour, /\*/, 'hour should be a fixed value, not a wildcard, to avoid a daily run');
  assert.equal(dayOfMonth, '*/3', `day-of-month field should step every 3 days, got "${dayOfMonth}"`);
});

// ---------- key hygiene ----------

test('never requires a service-role/secret key — only the public anon/publishable key', () => {
  assert.ok(!workflow.includes('sb_secret_'), 'sb_secret_ must never appear in the workflow');
  assert.ok(!/service_role/i.test(workflow), 'service_role must never appear in the workflow');
  assert.ok(!/SUPABASE_SERVICE/.test(workflow), 'SUPABASE_SERVICE must never appear in the workflow');
});

test('falls back to the publishable key already public in kupa-sgura.html when no repo secret is set', () => {
  const html = fs.readFileSync('kupa-sgura.html', 'utf8');
  const keyMatch = html.match(/const SUPABASE_PUBLISHABLE_KEY = "([^"]+)";/);
  assert.ok(keyMatch, 'could not find the publishable key in kupa-sgura.html');
  assert.ok(workflow.includes(keyMatch[1]), 'the workflow must fall back to the same publishable key the app ships');
  // Zero setup: an unset optional secret must fall through to the hardcoded key, e.g.
  // `${{ secrets.SOME_NAME || 'sb_publishable_...' }}`, not a hard dependency on the secret.
  assert.match(workflow, /secrets\.[A-Z_]*SUPABASE[A-Z_]*\s*\|\|/, 'must fall back when the optional secret is unset');
});

test('targets the same Supabase project ref the app uses', () => {
  const html = fs.readFileSync('kupa-sgura.html', 'utf8');
  const urlMatch = html.match(/const SUPABASE_URL = "https:\/\/([a-z0-9]+)\.supabase\.co";/);
  assert.ok(urlMatch, 'could not find SUPABASE_URL in kupa-sgura.html');
  const ref = urlMatch[1];
  assert.equal(ref, 'aztfjlssjbjhxdqsflgn', 'sanity check: the app project ref moved — update this test deliberately');
  assert.ok(workflow.includes(ref), `workflow must reference the project ref ${ref}`);
});

// ---------- loud failure ----------

test('the run step fails fast and exits non-zero on an unhealthy response', () => {
  assert.match(workflow, /set -euo pipefail/, 'the run step should fail fast on any unhandled error');
  assert.match(workflow, /exit 1\b/, 'must have an explicit non-zero exit for the unhealthy branch(es)');
});

test('explicitly treats HTTP 540 (Supabase "project paused") as a failure', () => {
  assert.match(workflow, /540/, 'the documented Supabase paused-project status code (540) should be checked for');
});

// ---------- companion doc ----------

test('the keepalive doc exists and is written in Hebrew', () => {
  assert.ok(fs.existsSync(DOC_PATH), `${DOC_PATH} is missing`);
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  assert.ok(/[\u0590-\u05FF]/.test(doc), 'the doc should be written in Hebrew');
  // The doc is allowed \u2014 expected, even \u2014 to name `sb_secret_`/service_role in prose as the
  // thing to never paste in; it must simply never contain an actual key value for one.
  assert.ok(!/service_role[A-Za-z0-9._-]{10,}/.test(doc), 'no actual service-role key value in the doc');
});
