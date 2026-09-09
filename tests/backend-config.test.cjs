// Backend config + sign-in wiring (Supabase phase 1).
//
// This suite is the security net around the only secret-adjacent thing in the repo: the
// publishable key that ships in the client. It asserts (a) the public constants are present and
// exactly the public ones, (b) supabase-js is loaded from the pinned CDN path before the app
// script, (c) every `supabase.` call site sits inside a function that early-returns when the
// client is null, so the app keeps working offline / when the CDN is blocked, and (d) the login
// screen actually offers the two real sign-in paths.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');

// There are two <script> tags now: the CDN one and the app one. The app script is the last.
const appScript = (() => {
  const open = html.lastIndexOf('<script>');
  const close = html.indexOf('</script>', open);
  assert.ok(open >= 0 && close > open, 'missing the app <script> block');
  return html.slice(open + '<script>'.length, close);
})();

// ---------- public config ----------

test('the public Supabase constants are in the source, in a marked backend-config block', () => {
  assert.match(appScript, /\/\/ -+ backend config \(public values; RLS is the security boundary\) -+/);
  assert.match(appScript, /const SUPABASE_URL = "https:\/\/aztfjlssjbjhxdqsflgn\.supabase\.co";/);
  assert.match(appScript, /const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_JsCuQh8iaszmRzjITbhOVA_vWqEXrUV";/);
});

test('no service-role or secret key ever reaches the client bundle', () => {
  assert.ok(!html.includes('sb_secret_'), 'sb_secret_ must never appear in the HTML');
  assert.ok(!html.includes('service_role'), 'service_role must never appear in the HTML');
  // A JWT-shaped anon/service key would also be a mistake here: the project uses the new
  // publishable-key format only.
  assert.ok(!/eyJhbGciOiJIUzI1NiIs/.test(html), 'no JWT-shaped Supabase key in the HTML');
});

// ---------- CDN script ----------

test('supabase-js v2 UMD is loaded from jsDelivr, before the app script', () => {
  const cdn = html.indexOf('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
  assert.ok(cdn >= 0, 'missing the pinned supabase-js v2 UMD CDN url');
  assert.match(html, /<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\/dist\/umd\/supabase\.min\.js"><\/script>/);
  assert.ok(cdn < html.lastIndexOf('<script>'), 'the CDN script must come before the app script');
});

test('the client is created with a persisted, self-refreshing, url-detecting session', () => {
  assert.match(appScript, /window\.supabase\.createClient\(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, \{/);
  assert.match(appScript, /persistSession: true/);
  assert.match(appScript, /autoRefreshToken: true/);
  assert.match(appScript, /detectSessionInUrl: true/);
});

test('a failed/blocked CDN leaves the client null instead of throwing', () => {
  assert.match(appScript, /function createBackendClient\(\) \{[\s\S]*?catch \(e\) \{ return null; \}/);
  // The deferred CDN script executes after this inline script starts, so the boot path must be
  // able to build the client again once the document finishes parsing.
  assert.match(appScript, /document\.addEventListener\("DOMContentLoaded", bootBackend, \{ once: true \}\)/);
});

// ---------- every supabase.* call is guarded ----------

test('every supabase.<api> call site sits in a function that early-returns without a client', () => {
  // `window.supabase.createClient` is excluded by the lookbehind: only the app-level client
  // variable is checked.
  const uses = [...appScript.matchAll(/(?<![\w.])supabase\s*\.\s*(auth|from|rpc|channel|storage|realtime)\b/g)];
  assert.ok(uses.length >= 4, `expected real Supabase usage, found ${uses.length}`);
  for (const use of uses) {
    const before = appScript.slice(0, use.index);
    // Top-level functions inside the IIFE are declared at two-space indentation.
    const fnStart = Math.max(
      before.lastIndexOf('\n  function '),
      before.lastIndexOf('\n  async function '),
    );
    assert.ok(fnStart >= 0, `unguarded top-level use of ${use[0]}`);
    const body = appScript.slice(fnStart, use.index);
    const name = body.slice(0, body.indexOf('(')).trim();
    assert.match(body, /if \(!supabase[^)]*\) return/, `${name} uses ${use[0]} without an "if (!supabase) return" guard`);
  }
});

test('nothing calls supabase directly at the top level of the IIFE', () => {
  // Every line that touches the client must be indented inside a function body (4+ spaces),
  // never at the IIFE's own two-space level.
  const offenders = appScript.split('\n').filter(line =>
    /^ {0,3}\S/.test(line) && /(?<![\w.])supabase\s*\.\s*(auth|from|rpc|channel)\b/.test(line));
  assert.deepEqual(offenders, []);
});

// ---------- the login screen ----------

test('the login screen offers Google, a divider, and an email code, plus the local fallback', () => {
  const login = html.slice(html.indexOf('<div class="login" id="login"'), html.indexOf('<div class="login" id="joinNotice"'));
  // "כניסה" replaced "מי אתה?" — see docs/superpowers/plans/2026-09-08-design-round-2-handoff.md
  // משימה 5 (gender-neutral heading, decided by the owner) — assert the new title exactly, and
  // that the old gendered phrasing is gone rather than merely absent from this one string.
  assert.ok(login.includes('<h2>כניסה</h2>'), 'the new gender-neutral title is used');
  assert.doesNotMatch(login, /מי אתה\?/, 'the old gendered title must not remain');
  assert.ok(login.includes('המשך עם Google'), 'Google sign-in button');
  assert.ok(login.includes('שלחו לי קוד'), 'email OTP button');
  assert.ok(login.includes('אישור'), 'code verification button');
  assert.ok(login.includes('בלי חשבון'), 'the local (no account) section is labelled');
  assert.ok(login.includes('כניסה עם חשבון לא זמינה כרגע'), 'offline note when the client is null');
  // The local name flow keeps its ids: the whole existing name-based UI still runs on it.
  ['loginChips', 'loginName', 'loginGo', 'loginSkip'].forEach(id =>
    assert.ok(login.includes(`id="${id}"`), `missing #${id}`));
  // Latin-only fields opt out of the RTL paragraph direction.
  assert.match(login, /id="authEmail"[^>]*dir="ltr"/);
  assert.match(login, /id="authCode"[^>]*dir="ltr"/);
});

test('the Google button asks for a redirect back to this exact page, search included', () => {
  assert.match(appScript, /provider: "google"/);
  // location.search must ride along so a `?join=`/`?friend=` invite token opened before sign-in
  // survives the OAuth round trip (see tests/auth-login.test.cjs for the behavioural check).
  assert.match(appScript, /redirectTo: location\.origin \+ location\.pathname \+ location\.search/);
});

test('the email path is send-code then verify-code, with inline Hebrew errors', () => {
  assert.match(appScript, /signInWithOtp\(\{ email, options: \{ shouldCreateUser: true \} \}\)/);
  assert.match(appScript, /verifyOtp\(\{ email: authEmailPending, token, type: "email" \}\)/);
  assert.ok(appScript.includes('לא הצלחנו לשלוח מייל'));
  assert.ok(appScript.includes('הקוד לא נכון'));
  assert.ok(appScript.includes('שולח…'));
  // No alert/confirm in the new auth code — the sandbox blocks them and the app never used them.
  const authSection = appScript.slice(
    appScript.indexOf('// ---------- auth (Supabase session) ----------'),
    appScript.indexOf('// ---------- login (who are you'));
  assert.ok(authSection.length > 1000, 'the auth section slice is missing');
  assert.ok(!/\balert\(|\bconfirm\(/.test(authSection));
});

// ---------- session -> me -> profiles ----------

test('a session upserts the profiles row with the schema column names and drives `me`', () => {
  assert.match(appScript, /\/\/ -+ auth \(Supabase session\) -+/);
  assert.match(appScript, /let authUser = null;/);
  assert.match(appScript, /\.from\("profiles"\)/);
  // Exactly the columns profiles has (docs/backend/schema.sql); RLS only lets a user write its own row.
  assert.match(appScript, /\{ id: user\.id, display_name: displayName, email: user\.email \|\| null \}/);
  assert.match(appScript, /upsert\(row, \{ onConflict: "id" \}\)/);
  assert.match(appScript, /me = authUser\.displayName; saveMe\(\);/);
});

test('signing out clears authUser but leaves the local name flow intact', () => {
  assert.match(appScript, /function signOutAccount\(\) \{[\s\S]*?supabase\.auth\.signOut\(\)/);
  assert.match(appScript, /onAuthStateChange/);
});

test('the document sync survives as the no-session path, and no ref invents a userId', () => {
  // Phase 2a added a second writer, so the rule is now "exactly one of them owns the data":
  // initSync()/remoteBody()/scheduleRemoteSave() still run verbatim without a session, and are
  // skipped entirely with one (asserted in detail by tests/cloud-mapping.test.cjs).
  assert.match(appScript, /function initSync\(\) \{\n    if \(cloudMode\(\)\) return;[^\n]*\n    if \(!window\.claude/);
  assert.match(appScript, /else scheduleRemoteSave\(\);\n  \}/);
  assert.match(appScript, /function remoteBody\(\) \{/);
  assert.ok(!/userId: (authUser|session|user)\b/.test(appScript), 'phase 3 owns userId on refs, not this one');
});

test('the settings overlay shows the signed-in address and no new localStorage key appears', () => {
  assert.match(html, /id="setAccount"/);
  assert.match(appScript, /authUser && authUser\.email/);
  const keys = [...appScript.matchAll(/localStorage\.(?:get|set|remove)Item\("([^"]+)"\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(keys)], []); // all keys go through the KEY/ME_KEY/... constants
  const declared = [...appScript.matchAll(/const (?!SUPABASE_)[A-Z_]*KEY[A-Z_]* = "([^"]+)";/g)].map(m => m[1]).sort();
  assert.deepEqual(declared, [
    'poker-settle-contact',
    'poker-settle-me',
    'poker-settle-profile-debts-seen',
    'poker-settle-theme',
    'poker-settle-v1',
  ]);
});

// ---------- signing in from settings while a local name is already set ----------
//
// Gap: with `me` set (local mode) and no Supabase session — including a dropped/expired one —
// the settings overlay used to offer only "התנתקות", which wipes the local name. There was no
// way back into an account without losing local play. #setSignInBtn reopens the login overlay
// without touching `me`.

test('the settings overlay has a sign-in control, hidden by default, above the sign-out button', () => {
  const settings = html.slice(html.indexOf('<div class="login" id="settings"'), html.indexOf('<div class="login" id="groupSettings"'));
  assert.match(settings, /<p class="games-primary-reason" id="setSignInNote" hidden>[^<]*<\/p>/);
  assert.match(settings, /<button type="button" class="set-flat" id="setSignInBtn" hidden>התחבר עם חשבון<\/button>/);
  // The note and the sign-in button must both come before #setSwapBtn in source order.
  const noteIdx = settings.indexOf('id="setSignInNote"');
  const btnIdx = settings.indexOf('id="setSignInBtn"');
  const swapIdx = settings.indexOf('id="setSwapBtn"');
  assert.ok(noteIdx >= 0 && btnIdx > noteIdx && swapIdx > btnIdx, 'sign-in note + button must sit above התנתקות/החלף שם');
});

test('the sign-in button opens the login overlay and never clears `me`', () => {
  const start = appScript.indexOf('document.getElementById("setSignInBtn").addEventListener("click"');
  assert.ok(start >= 0, 'missing #setSignInBtn click handler');
  const close = appScript.indexOf('});', start);
  const handler = appScript.slice(start, close);
  assert.match(handler, /showLogin\(\)/);
  assert.ok(!/\bme\s*=\s*null\b/.test(handler), 'must not clear the local name');
  assert.ok(!/signOutAccount\(\)/.test(handler), 'must not sign out of Supabase');
  assert.match(handler, /document\.getElementById\("settings"\)\.hidden = true;/);
});

test('refreshSettings branches sign-in visibility and reserves the swap button for signed-in accounts', () => {
  const start = appScript.indexOf('function refreshSettings()');
  const close = appScript.indexOf('\n  }', start);
  const body = appScript.slice(start, close);
  assert.match(body, /!authUser && !!supabase/, 'no-session-but-available branch must check both authUser and supabase');
  assert.match(body, /setSignInNote"\)\.hidden = !canSignIn/);
  assert.match(body, /setSignInBtn"\)\.hidden = !canSignIn/);
  assert.match(body, /setSwapBtn"\)\.hidden = !authUser/);
  assert.match(body, /setSwapBtn"\)\.textContent = "התנתקות"/);
});

test('showLogin never requires `me` to be null, and skip only hides the overlay', () => {
  const start = appScript.indexOf('function showLogin()');
  const close = appScript.indexOf('\n  }', start);
  const body = appScript.slice(start, close);
  assert.ok(!/if \(me\)|if \(!me\)/.test(body), 'showLogin must not gate its body on `me`');
  const skipStart = appScript.indexOf('document.getElementById("loginSkip").addEventListener("click"');
  const skipClose = appScript.indexOf('});', skipStart);
  const skipHandler = appScript.slice(skipStart, skipClose);
  assert.match(skipHandler, /document\.getElementById\("login"\)\.hidden = true;/);
  assert.ok(!/\bme\s*=/.test(skipHandler), 'דלג בינתיים must not touch `me`');
});
