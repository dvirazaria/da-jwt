// Guest -> account linking, path 2: verified contact match (docs/backend/verified-link.sql).
//
// This path was investigated, not built: the caller's own address can be trusted
// (auth.users.email_confirmed_at, read directly, never through the client-writable
// auth.jwt() user_metadata copy), but the GUEST side has no verified contact to match it
// against, and adding one (guests.contact_email, typed by whoever adds the guest) reintroduces
// the exact bug class the two blocked branches shipped (matching on an address nobody but its
// typist ever confirmed), just moved to the other side of the equals sign. See
// docs/backend/verified-link.sql PART 1-4 and .superpowers/guest-link-v2-report.md for the full
// reasoning. These tests pin the structural guarantees that make "not built" a safe, verifiable
// answer rather than an assertion:
//   * guests still carries no email/phone/contact column (schema.sql) -- a duplicate-address
//     match is structurally impossible, not silently resolved by picking one candidate;
//   * kupa-sgura.html defines no client-side contact-matching function -- an unverified address
//     can never link, because nothing tries to match one;
//   * verified-link.sql's own regression tripwire fires the moment that column reappears;
//   * link-guest.sql's double-seat guard and app_guest_has_zero_exposure gate are untouched by
//     this file -- zero-exposure is not overridden by verification, in code as well as in prose;
//   * verified-link.sql is transaction-wrapped, grants nothing new, and carries no
//     service_role/sb_secret_ credential.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');
const verifiedSql = fs.readFileSync('docs/backend/verified-link.sql', 'utf8');
const linkSql = fs.readFileSync('docs/backend/link-guest.sql', 'utf8');
const schemaSql = fs.readFileSync('docs/backend/schema.sql', 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end >= 0, `missing ${endMarker}`);
  return source.slice(start, end);
}

test('guests still carries no email/phone/contact column -- a duplicate verified address is structurally impossible to match against, never guessed', () => {
  const guestsTable = sourceBetween(schemaSql, 'CREATE TABLE IF NOT EXISTS guests', ');');
  assert.doesNotMatch(guestsTable, /\bemail\b/i);
  assert.doesNotMatch(guestsTable, /\bphone\b/i);
  assert.doesNotMatch(guestsTable, /contact/i);
});

test('kupa-sgura.html defines no client-side email/contact matching function for guest linking -- an unverified address can never link because nothing attempts the match', () => {
  const pureSource = sourceBetween(html, '  // ---------- groups domain (pure) ----------', '  function el(');
  assert.doesNotMatch(pureSource, /contactEmail/i);
  assert.doesNotMatch(pureSource, /emailVerified/i);
  assert.doesNotMatch(pureSource, /verifiedContact/i);
  assert.doesNotMatch(pureSource, /matchGuestByEmail/i);
});

test('verified-link.sql installs a regression tripwire that fires the moment guests gains a contact column, rather than letting a matcher get built on top of it silently', () => {
  assert.match(verifiedSql, /information_schema\.columns/);
  assert.match(verifiedSql, /'guests'/);
  assert.match(verifiedSql, /'email',\s*'contact_email',\s*'phone',\s*'contact_phone'/);
  assert.match(verifiedSql, /RAISE EXCEPTION/);
});

test('verified-link.sql is one idempotent, transaction-wrapped, paste-ready file', () => {
  assert.match(verifiedSql, /^\s*BEGIN;/m);
  assert.match(verifiedSql, /^\s*COMMIT;/m);
  // The DO block is safe to run twice: it only SELECTs and conditionally RAISEs, no DDL that
  // would fail on a second paste.
  assert.doesNotMatch(verifiedSql, /^\s*CREATE TABLE(?!.*IF NOT EXISTS)/im);
});

test('verified-link.sql grants nothing new and carries no service_role or Supabase secret-key credential', () => {
  assert.doesNotMatch(verifiedSql, /\bGRANT\b/i);
  assert.doesNotMatch(verifiedSql, /service_role/i);
  assert.doesNotMatch(verifiedSql, /sb_secret_/i);
});

test('verified-link.sql defines no new SECURITY DEFINER linking function -- there is nothing safe to link a caller-supplied identity against yet', () => {
  assert.doesNotMatch(verifiedSql, /CREATE (OR REPLACE )?FUNCTION/i);
});

test('verified-link.sql does not redefine app_link_guest_to_profile or app_guest_has_zero_exposure -- the double-seat guard and the zero-exposure gate are untouched, not overridden by verification', () => {
  assert.doesNotMatch(verifiedSql, /CREATE (OR REPLACE )?FUNCTION app_link_guest_to_profile/i);
  assert.doesNotMatch(verifiedSql, /CREATE (OR REPLACE )?FUNCTION app_guest_has_zero_exposure/i);
  assert.doesNotMatch(verifiedSql, /ALTER FUNCTION app_link_guest_to_profile/i);
  assert.doesNotMatch(verifiedSql, /ALTER FUNCTION app_guest_has_zero_exposure/i);
});

test('link-guest.sql itself still enforces the zero-exposure gate inside app_self_claim_guest and the double-seat guard inside app_link_guest_to_profile, unchanged by the path-2 investigation', () => {
  const claimBody = sourceBetween(linkSql, 'CREATE OR REPLACE FUNCTION app_self_claim_guest', 'REVOKE ALL ON FUNCTION app_self_claim_guest');
  assert.match(claimBody, /app_guest_has_zero_exposure\(/);
  assert.match(claimBody, /GUEST_LINK_HAS_EXPOSURE/);

  const engineBody = sourceBetween(linkSql, 'CREATE OR REPLACE FUNCTION app_link_guest_to_profile', 'REVOKE ALL ON FUNCTION app_link_guest_to_profile');
  assert.match(engineBody, /'double-seat'/);
});

test('verified-link.sql documents auth.users.email_confirmed_at (not the client-writable auth.jwt() user_metadata copy) as the trustworthy verified-email source, and says explicitly what was confirmed versus assumed', () => {
  assert.match(verifiedSql, /email_confirmed_at/);
  assert.match(verifiedSql, /user_metadata/);
  assert.match(verifiedSql, /CONFIRMED/);
  assert.match(verifiedSql, /ASSUMED, NOT CONFIRMED/);
});

test('verified-link.sql rules that zero-exposure must not be overridden by a verified match, and that a duplicate address must be refused rather than guessed', () => {
  assert.match(verifiedSql, /must NOT override it/i);
  assert.match(verifiedSql, /refuse rather than guess/i);
});
