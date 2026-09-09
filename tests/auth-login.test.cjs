// Sign-in screen rebuild (משימה 5): email code as the primary route, a quiet-but-real local
// mode, Hebrew auth error mapping, and an invite token that survives the OAuth round trip.
// Same vm-slice + raw-source patterns as tests/friend-invite.test.cjs: pure functions run in a
// bare vm context, everything else is asserted with regexes/substrings over the raw source.
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

const errorsPure = sourceBetween('  // ---------- auth errors (pure) ----------', '  // ---------- auth (Supabase session) ----------');

function mapAuthError(error, step) {
  const context = vm.createContext({});
  vm.runInContext(errorsPure, context);
  return vm.runInContext('mapAuthError(error, step)', Object.assign(context, { error, step }));
}

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const appScript = scripts[scripts.length - 1][1];
const login = html.slice(html.indexOf('<div class="login" id="login"'), html.indexOf('<div class="login" id="joinNotice"'));

// ---------- mapAuthError: each failure class a real user will hit ----------

test('mapAuthError: network failure reads as a connectivity problem, in Hebrew', () => {
  assert.match(mapAuthError({ message: 'Failed to fetch' }, 'email'), /אינטרנט/);
  assert.match(mapAuthError({ status: 0 }, 'code'), /אינטרנט/);
});

test('mapAuthError: a 429 / rate-limit reads as "too many attempts", not a generic failure', () => {
  assert.match(mapAuthError({ status: 429, message: 'Too many requests' }, 'email'), /יותר מדי/);
});

test('mapAuthError: wrong or expired code are distinguished, both short and in Hebrew', () => {
  const wrong = mapAuthError({ message: 'Invalid otp' }, 'code');
  const expired = mapAuthError({ message: 'Token has expired' }, 'code');
  assert.match(wrong, /הקוד לא נכון/);
  assert.match(expired, /פג תוקף/);
  assert.ok(wrong.length < 40 && expired.length < 40, 'inline errors stay short');
});

test('mapAuthError: an invalid email address is called out specifically', () => {
  assert.match(mapAuthError({ message: 'Unable to validate email address: invalid format' }, 'email'), /כתובת מייל לא תקינה/);
});

test('mapAuthError: a Google failure never blames the code or the address', () => {
  const msg = mapAuthError({ message: 'oauth error' }, 'google');
  assert.match(msg, /Google/);
});

// ---------- code field: one field, not six boxes ----------

test('the code field is a single input with the right autofill/keyboard/length contract', () => {
  const codeStep = login.slice(login.indexOf('id="authCodeStep"'), login.indexOf('id="authLocal"'));
  assert.match(codeStep, /id="authCode"[^>]*autocomplete="one-time-code"/);
  assert.match(codeStep, /id="authCode"[^>]*inputmode="numeric"/);
  assert.match(codeStep, /id="authCode"[^>]*maxlength="6"/);
  assert.match(codeStep, /id="authCode"[^>]*dir="ltr"/);
  // only one code input in the whole step — not six digit boxes
  assert.equal((codeStep.match(/id="authCode"/g) || []).length, 1);
});

test('the code auto-verifies ~250ms after the 6th digit, with "אישור" kept as a manual fallback', () => {
  assert.match(appScript, /digits\.length === 6\) authAutoVerifyTimer = setTimeout\(verifyEmailCode, 250\)/);
  assert.ok(login.includes('>אישור<'), 'the manual confirm button text stays');
});

// ---------- 60-second resend countdown (Supabase's own OTP rate window) ----------

test('the resend countdown is exactly Supabase\'s 60-second rate window', () => {
  assert.match(appScript, /authResendUntil = Date\.now\(\) \+ 60000/);
  assert.match(login, /id="authResendBtn"/);
});

// ---------- legal / age copy: one placeholder pair, text-only swap ----------

test('LOGIN_LEGAL_NOTE and LOGIN_AGE_NOTE exist as one marked constant pair and are wired to the markup', () => {
  assert.match(appScript, /const LOGIN_LEGAL_NOTE = ".*docs\/legal-copy\.md/);
  assert.match(appScript, /const LOGIN_AGE_NOTE = ".*docs\/legal-copy\.md/);
  assert.match(appScript, /authLegalNote"\)\.textContent = LOGIN_LEGAL_NOTE/);
  assert.match(appScript, /authAgeNote"\)\.textContent = LOGIN_AGE_NOTE/);
  assert.match(login, /id="authLegalNote"/);
  assert.match(login, /id="authAgeNote"/);
});

// ---------- Google branding: exact colours per theme, no turquoise border ----------

test('the Google button uses Google\'s own brand colours in both themes, never the app accent', () => {
  const cssStart = html.indexOf('.btn-google {');
  const cssBlock = html.slice(cssStart, html.indexOf('.auth-divider {', cssStart));
  assert.match(cssBlock, /border: 1px solid #8E918F/);
  assert.match(cssBlock, /background: #131314/);
  assert.match(cssBlock, /color: #E3E3E3/);
  const lightBlock = html.slice(html.indexOf(':root[data-theme="light"] .btn-google'), html.indexOf(':root[data-theme="light"] .btn-google') + 200);
  assert.match(lightBlock, /#FFFFFF/);
  assert.match(lightBlock, /#747775/);
  assert.match(lightBlock, /#1F1F1F/);
  assert.doesNotMatch(cssBlock, /var\(--accent\)/, 'no turquoise (accent) border on the Google button');
});

// ---------- invite token survives a simulated sign-in ----------

test('the invite token in the URL rides along on the Google OAuth redirect', () => {
  // signInWithOAuth's redirectTo carries location.search, so ?join=/?friend= comes back with the
  // provider redirect intact; stripAuthParamsFromUrl only removes supabase's own code/state params.
  assert.match(appScript, /redirectTo: location\.origin \+ location\.pathname \+ location\.search/);
  const strip = appScript.slice(appScript.indexOf('function stripAuthParamsFromUrl'), appScript.indexOf('function stripAuthParamsFromUrl') + 600);
  assert.doesNotMatch(strip, /params\.delete\("join"\)/);
  assert.doesNotMatch(strip, /params\.delete\("friend"\)/);
});

test('a simulated redirect return keeps ?join= resolvable via the existing fallback path', () => {
  // The email-code path never navigates away, so pendingJoinToken (in-memory) survives untouched.
  // The Google path does navigate away and back, so applySession() must be able to recover the
  // token from the URL alone; maybeRunPendingJoin's fallback is exactly that recovery path.
  assert.match(appScript, /const token = pendingJoinToken \|\| parseJoinToken\(location\.search\);/);
  assert.match(appScript, /maybeRunPendingJoin\(\); \/\/ an invite link opened before signing in redeems itself now, once/);
});
