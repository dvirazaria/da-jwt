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

const SAMPLE_LINK = 'https://poker-tau-pink.vercel.app/?friend=ABCDEFGH';

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

test('parseFriendToken reads ?friend= with the same normalization and alphabet rules as parseJoinToken', () => {
  const context = freshContext();
  assert.equal(run('parseFriendToken("?friend=abcd-2345")', context), 'ABCD2345');
  assert.equal(run('parseFriendToken("?friend=abcd2345&x=1")', context), 'ABCD2345');
  assert.equal(run('parseFriendToken("?friend=short")', context), null);
  assert.equal(run('parseFriendToken("?nothing=1")', context), null);
  // 0/O/1/I are not in the alphabet, so a lookalike code is still refused (same rule as ?join=).
  assert.equal(run('parseFriendToken("?friend=ABCD2O45")', context), null);
});

test('?join= and ?friend= never shadow each other when both are present in the same URL', () => {
  const context = freshContext();
  const combined = '?join=ABCD2345&friend=WXYZ6789';
  assert.equal(run(`parseJoinToken(${JSON.stringify(combined)})`, context), 'ABCD2345');
  assert.equal(run(`parseFriendToken(${JSON.stringify(combined)})`, context), 'WXYZ6789');
  // Order in the query string must not matter either.
  const reversed = '?friend=WXYZ6789&join=ABCD2345';
  assert.equal(run(`parseJoinToken(${JSON.stringify(reversed)})`, context), 'ABCD2345');
  assert.equal(run(`parseFriendToken(${JSON.stringify(reversed)})`, context), 'WXYZ6789');
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

test("the friend-invite share handler prefers navigator.share and falls back to wa.me, like the group invite's", () => {
  const handler = sourceBetween('  function shareFriendInvite() {', '  function resetAddFriendPanel() {');
  assert.match(
    handler,
    /typeof navigator\.share === "function"[\s\S]*navigator\.share\([\s\S]*?\)[\s\S]*else[\s\S]*wa\.me\/\?text=/,
    'expected navigator.share to be tried first, with the wa.me link only in the else branch'
  );
  assert.match(handler, /encodeURIComponent\(message\)/);
  assert.match(handler, /window\.open\([\s\S]*?"_blank", "noopener"\)/);
});
