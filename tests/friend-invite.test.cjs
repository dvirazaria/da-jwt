// Share-links: a direct invite entry point on the group page (Problem 1), and a personal
// "הוסף אותי כחבר" friend-invite link (Problem 2). Same vm-slice + raw-source patterns as
// tests/invite-share.test.cjs and tests/join-invite.test.cjs — no DOM, no navigator, no
// window.open executed; pure functions run in a bare vm context, wiring is asserted with regexes
// over named source slices.
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

// Same slice tests/join-invite.test.cjs uses — friendInviteLink, buildFriendShareText and
// parseFriendToken all live inside "invites (pure)", right beside their group-invite analogs
// (the task's own placement rule: beside buildInviteShareText, in the existing invites section).
const pureSource = sourceBetween('  // ---------- invites (pure) ----------', '  // ---------- qr (pure) ----------');

function freshContext() {
  const context = vm.createContext({ newId: () => 'stub-id' });
  vm.runInContext(pureSource, context);
  return context;
}
const run = (code, context) => vm.runInContext(code, context || freshContext());

const SAMPLE_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SAMPLE_LINK = 'https://poker-tau-pink.vercel.app/?friend=' + SAMPLE_TOKEN;

function buildFriendText(context, myName, url) {
  Object.assign(context, { myName, url });
  return vm.runInContext('buildFriendShareText(myName, url)', context);
}

// ---------- buildFriendShareText ----------

test('buildFriendShareText names the app, the inviter and the link', () => {
  const context = freshContext();
  const message = buildFriendText(context, 'דביר', SAMPLE_LINK);
  assert.match(message, /סוגרים קופה/); // what the app is
  assert.match(message, /דביר/); // who is inviting
  assert.ok(message.includes(SAMPLE_LINK)); // the link, verbatim
});

test('a missing name degrades gracefully: no "undefined", still a full invite with the link', () => {
  const context = freshContext();
  for (const missing of [undefined, null, '', '   ']) {
    const message = buildFriendText(context, missing, SAMPLE_LINK);
    assert.doesNotMatch(message, /undefined/);
    assert.ok(message.includes(SAMPLE_LINK));
  }
});

test('buildFriendShareText stays short — a handful of lines, chat-preview sized', () => {
  const context = freshContext();
  const message = buildFriendText(context, 'ערב פוקר של יום חמישי', SAMPLE_LINK);
  const lines = message.split('\n');
  assert.ok(lines.length <= 3, `expected at most 3 lines, got ${lines.length}`);
  assert.ok(message.length < 220, `expected a short message, got ${message.length} chars`);
});

test('the message survives encodeURIComponent for wa.me/?text= and decodes back exactly', () => {
  const context = freshContext();
  const message = buildFriendText(context, 'דביר', SAMPLE_LINK);
  const encoded = encodeURIComponent(message);
  // The friend link's own "?" and "=" must not survive raw, or wa.me would see a second query string.
  assert.doesNotMatch(encoded, /[?&=]/);
  assert.doesNotMatch(encoded, /\s/); // no literal spaces or raw newlines
  assert.equal(decodeURIComponent(encoded), message);
});

// ---------- parseFriendToken / non-shadowing with parseJoinToken ----------

test('parseFriendToken accepts the server-issued 256-bit hex token and rejects short or malformed values', () => {
  const context = freshContext();
  assert.equal(run(`parseFriendToken('?friend=${SAMPLE_TOKEN.toUpperCase()}')`, context), SAMPLE_TOKEN);
  assert.equal(run(`parseFriendToken('?friend=${SAMPLE_TOKEN}&x=1')`, context), SAMPLE_TOKEN);
  assert.equal(run('parseFriendToken("?friend=abcd2345")', context), null);
  assert.equal(run('parseFriendToken("?friend=short")', context), null);
  assert.equal(run('parseFriendToken("?nothing=1")', context), null);
  assert.equal(run(`parseFriendToken('?friend=${'g'.repeat(64)}')`, context), null);
});

test('normalizeFriendToken also accepts the raw token returned by the create RPC', () => {
  const context = freshContext();
  assert.equal(run(`normalizeFriendToken('${SAMPLE_TOKEN.toUpperCase()}')`, context), SAMPLE_TOKEN);
  assert.equal(run(`normalizeFriendToken('${SAMPLE_TOKEN.slice(0, 8)}-${SAMPLE_TOKEN.slice(8)}')`, context), SAMPLE_TOKEN);
  assert.equal(run("normalizeFriendToken('not-a-token')", context), null);
});

test('?join= and ?friend= never shadow each other when both are present in the same URL', () => {
  const context = freshContext();
  const combined = '?join=ABCD2345&friend=' + SAMPLE_TOKEN;
  assert.equal(run(`parseJoinToken(${JSON.stringify(combined)})`, context), 'ABCD2345');
  assert.equal(run(`parseFriendToken(${JSON.stringify(combined)})`, context), SAMPLE_TOKEN);
  // Order in the query string must not matter either.
  const reversed = '?friend=' + SAMPLE_TOKEN + '&join=ABCD2345';
  assert.equal(run(`parseJoinToken(${JSON.stringify(reversed)})`, context), 'ABCD2345');
  assert.equal(run(`parseFriendToken(${JSON.stringify(reversed)})`, context), SAMPLE_TOKEN);
});

// ---------- structure: entry points and share handlers ----------

test('the group page carries a direct invite entry point beside "חברים", not just inside the settings overlay', () => {
  const membersSource = sourceBetween(
    '  function renderGroupMembers(summary, members, former, isAdmin) {',
    '  function renderMemberRow('
  );
  assert.match(membersSource, /renderGroupInviteButton\(summary\)/);
  const btnSource = sourceBetween('  function renderGroupInviteButton(summary) {', '  function renderMemberRow(');
  // One tap: reuse the active invite, or create one on demand via the existing createGroupInvite
  // (owned by another lane — called here, not reimplemented), then share immediately.
  assert.match(btnSource, /activeInvite\(state\.invites, summary\.groupId\)/);
  assert.match(btnSource, /createGroupInvite\(summary\.groupId\)/);
  assert.match(btnSource, /buildInviteShareText\(/);
});

test('the friend-invite share handler requires a cloud session and gets its token from the create RPC', () => {
  const handler = sourceBetween('  async function shareFriendInvite() {', '  function resetAddFriendPanel() {');
  assert.match(handler, /if \(!cloudMode\(\) \|\| friendInviteSharing\) return;/);
  assert.match(handler, /supabase\.rpc\("app_create_friend_invite"\)/);
  assert.doesNotMatch(handler, /generateInviteToken\(/);
  assert.match(
    handler,
    /typeof navigator\.share === "function"[\s\S]*navigator\.share\([\s\S]*?\)[\s\S]*else[\s\S]*wa\.me\/\?text=/,
    'expected navigator.share to be tried first, with the wa.me link only in the else branch'
  );
  assert.match(handler, /encodeURIComponent\(message\)/);
  assert.match(handler, /window\.open\([\s\S]*?"_blank", "noopener"\)/);
  assert.match(handler, /normalizeFriendToken\(row\.token\)/);
});

test('the friend notice redeems only through the accept RPC, has busy state, pulls cloud data and cleans the URL', () => {
  const notice = sourceBetween('  // ---------- friend invite ----------', '  // ---------- iOS Safari install hint ----------');
  assert.match(notice, /supabase\.rpc\("app_accept_friend_invite", \{ p_token: token \}\)/);
  assert.match(notice, /friendNoticeRedeeming/);
  assert.match(notice, /await pullCloud\(\)/);
  assert.match(notice, /stripFriendFromUrl\(\)/);
  assert.match(notice, /parseJoinToken\(location\.search\)/,
    'closing a friend notice must continue a second ?join= flow from the same URL');
  assert.doesNotMatch(notice, /\.from\("friend_invites"\)/);
});

test('friend URL cleanup preserves an existing hash fragment', () => {
  const notice = sourceBetween('  function stripFriendFromUrl() {', '  function friendNoticeParts() {');
  assert.match(notice, /location\.hash/);
});

test('friend-invites SQL keeps tokens out of profile reads and confines both RPCs to authenticated callers', () => {
  const sql = fs.readFileSync('docs/backend/friend-invites.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS friend_invites/);
  assert.doesNotMatch(sql, /ALTER TABLE profiles[\s\S]*friend_invite/);
  assert.match(sql, /ALTER TABLE friend_invites ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_create_friend_invite\(\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_accept_friend_invite\(p_token text\)/);
  assert.match(sql, /gen_random_bytes\(32\)/);
  assert.match(sql, /ON CONFLICT DO NOTHING/);
  assert.match(sql, /token collision/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_create_friend_invite\(\) FROM public/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_accept_friend_invite\(text\) TO authenticated/);
});
