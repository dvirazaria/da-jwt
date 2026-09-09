// Joining a group by invite link (client half).
//
// The server half is docs/backend/join-invite.sql — a SECURITY DEFINER
// app_redeem_invite(p_token) function, because RLS deliberately hides the invite row from a
// prospective joiner and refuses a self-insert into group_members. These tests therefore pin:
//   * normalizeInviteToken — the client must normalize a pasted code exactly the way the SQL
//     does (uppercase, dashes and whitespace stripped), or a valid code is rejected;
//   * joinNoticeMessage — one Hebrew line per RPC status, including the unknown-status fallback;
//   * structurally, that the join goes through supabase.rpc('app_redeem_invite'), refreshes with
//     pullCloud(), is guarded by cloudMode(), and never inserts into group_members from the client.
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

const pureSource = sourceBetween('  // ---------- invites (pure) ----------', '  // ---------- qr (pure) ----------');

function load() {
  const context = vm.createContext({ newId: () => 'stub-invite-id' });
  vm.runInContext(pureSource, context);
  return context;
}
const run = (code) => vm.runInContext(code, load());

// ---------- normalizeInviteToken ----------

test('normalizeInviteToken uppercases and strips the display dash', () => {
  assert.equal(run('normalizeInviteToken("abcd-2345")'), 'ABCD2345');
});

test('normalizeInviteToken strips every kind of whitespace a paste can carry', () => {
  assert.equal(run('normalizeInviteToken(" ab cd - 23\\t45\\n ")'), 'ABCD2345');
});

test('normalizeInviteToken is total: null/undefined/number never throw', () => {
  assert.equal(run('normalizeInviteToken(null)'), '');
  assert.equal(run('normalizeInviteToken(undefined)'), '');
  assert.equal(run('normalizeInviteToken(0)'), '0');
});

test('normalizeInviteToken matches the SQL normalization in join-invite.sql', () => {
  const sql = fs.readFileSync('docs/backend/join-invite.sql', 'utf8');
  // upper(regexp_replace(..., '[[:space:]-]', '', 'g')) — same two operations, same order.
  assert.match(sql, /upper\(regexp_replace\(/);
  assert.match(sql, /\[\[:space:\]-\]/);
});

test('parseJoinToken goes through the same normalization', () => {
  assert.equal(run('parseJoinToken("?join=abcd-2345")'), 'ABCD2345');
  assert.equal(run('parseJoinToken("?join=abcd2345&x=1")'), 'ABCD2345');
  assert.equal(run('parseJoinToken("?join=short")'), null);
  assert.equal(run('parseJoinToken("?nothing=1")'), null);
  // 0/O/1/I are not in the alphabet, so a lookalike code is still refused.
  assert.equal(run('parseJoinToken("?join=ABCD2O45")'), null);
});

// ---------- joinNoticeMessage ----------

test('joinNoticeMessage names the group on every success status', () => {
  const context = load();
  const msg = (s, n) => vm.runInContext(`joinNoticeMessage(${JSON.stringify(s)}, ${JSON.stringify(n)})`, context);
  assert.equal(msg('joined', 'הנשרים'), 'הצטרפת לקבוצה הנשרים');
  assert.equal(msg('rejoined', 'הנשרים'), 'חזרת לקבוצה הנשרים');
  assert.equal(msg('already-member', 'הנשרים'), 'אתם כבר בקבוצה הנשרים');
});

test('joinNoticeMessage drops the trailing name when the group name is missing', () => {
  const context = load();
  const msg = (s, n) => vm.runInContext(`joinNoticeMessage(${JSON.stringify(s)}, ${JSON.stringify(n)})`, context);
  assert.equal(msg('joined', ''), 'הצטרפת לקבוצה');
  assert.equal(msg('joined', null), 'הצטרפת לקבוצה');
  assert.equal(msg('joined', '   '), 'הצטרפת לקבוצה');
});

test('joinNoticeMessage has a distinct Hebrew line for each failure status', () => {
  const context = load();
  const msg = (s) => vm.runInContext(`joinNoticeMessage(${JSON.stringify(s)}, "הנשרים")`, context);
  const lines = ['invalid', 'revoked', 'expired', 'group-gone'].map(msg);
  assert.equal(lines[0], 'הקוד לא נמצא');
  assert.equal(lines[1], 'ההזמנה בוטלה');
  assert.equal(lines[2], 'תוקף ההזמנה פג');
  assert.equal(lines[3], 'הקבוצה כבר לא קיימת');
  assert.equal(new Set(lines).size, 4, 'failure messages must not collide');
  // A failure line never leaks the group name of a group we are not in.
  lines.forEach(line => assert.ok(!line.includes('הנשרים')));
});

test('joinNoticeMessage falls back for an unknown status, an error, or nothing at all', () => {
  const context = load();
  const msg = (s) => vm.runInContext(`joinNoticeMessage(${JSON.stringify(s)}, "")`, context);
  assert.equal(msg('error'), 'ההצטרפות נכשלה, נסו שוב');
  assert.equal(msg('something-new-from-the-server'), 'ההצטרפות נכשלה, נסו שוב');
  assert.equal(msg(''), 'ההצטרפות נכשלה, נסו שוב');
  assert.equal(msg(null), 'ההצטרפות נכשלה, נסו שוב');
});

test('joinSucceeded accepts exactly the three success statuses', () => {
  const context = load();
  const ok = (s) => vm.runInContext(`joinSucceeded(${JSON.stringify(s)})`, context);
  assert.equal(ok('joined'), true);
  assert.equal(ok('rejoined'), true);
  assert.equal(ok('already-member'), true);
  ['invalid', 'revoked', 'expired', 'group-gone', 'error', '', null].forEach(s => assert.equal(ok(s), false));
});

// ---------- structure: the join goes through the RPC, never a direct write ----------

const joinSource = sourceBetween('  // ---------- join by invite ----------', '  // ---------- boot ----------');

test('redemption calls the SECURITY DEFINER RPC by name', () => {
  assert.match(joinSource, /supabase\.rpc\(\s*"app_redeem_invite"/);
});

test('the join section never writes group_members (or any table) from the client', () => {
  assert.ok(!/\.from\(\s*"group_members"/.test(joinSource), 'client must not touch group_members directly');
  assert.ok(!/\.insert\(/.test(joinSource), 'no direct inserts in the join flow');
});

test('redemption is guarded by cloudMode() and refreshes with pullCloud()', () => {
  assert.match(joinSource, /cloudMode\(\)/);
  assert.match(joinSource, /pullCloud\(/);
});

test('a successful join opens the joined group', () => {
  assert.match(joinSource, /openGroup\(/);
});

test('signed-out users are sent to showLogin and the token is remembered for one auto-retry', () => {
  assert.match(joinSource, /showLogin\(\)/);
  assert.match(joinSource, /pendingJoinToken/);
});

test('the ?join= query is stripped only by the resolve path, not at boot', () => {
  assert.match(joinSource, /history\.replaceState/);
  const bootSource = html.slice(html.indexOf('  // ---------- boot ----------'));
  assert.ok(!/history\.replaceState\(null, "", location\.pathname\);/.test(bootSource),
    'boot must not strip the URL before the join flow resolves');
});

test('the notice keeps the offline copy when supabase is missing', () => {
  assert.match(joinSource, /SERVER_NOTE/);
});

test('rpc failures are caught, never thrown at the console', () => {
  assert.match(joinSource, /catch/);
});

// ---------- markup ----------

test('#joinNotice has an actionable primary button and a live status line', () => {
  assert.match(html, /id="joinNoticeJoinBtn"/);
  assert.match(html, /id="joinNoticeStatus"[^>]*aria-live="polite"/);
});
