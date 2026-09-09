// WhatsApp invite sharing: buildInviteShareText() (pure, invites section) and the dedicated
// WhatsApp action wired into renderGroupInvite(). Same vm-slice + raw-source patterns as
// tests/invites.test.cjs and tests/motion.test.cjs — no DOM, no navigator, no window.open executed.
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

// Same slice tests/invites.test.cjs uses: groups domain (pure) through the invites (pure)
// section, which is where buildInviteShareText lives, right after formatInviteCode.
const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

function freshContext() {
  const context = vm.createContext({});
  vm.runInContext(pureSource, context);
  return context;
}

const SAMPLE_LINK = 'https://poker-tau-pink.vercel.app/?join=ABCDEFGH';

function buildText(context, groupName, inviteCode, url) {
  Object.assign(context, { groupName, inviteCode, url });
  return vm.runInContext('buildInviteShareText(groupName, inviteCode, url)', context);
}

test('buildInviteShareText includes what the app is, the group name, the link and the code', () => {
  const context = freshContext();
  const message = buildText(context, 'חברים של דביר', 'ABCD-1234', SAMPLE_LINK);
  assert.match(message, /סוגרים קופה/); // one line naming the app
  assert.match(message, /חברים של דביר/); // the group name
  assert.ok(message.includes(SAMPLE_LINK)); // the join link, verbatim
  assert.match(message, /ABCD-1234/); // the code, as a fallback
});

test('buildInviteShareText stays short — a handful of lines, chat-preview sized', () => {
  const context = freshContext();
  const message = buildText(context, 'ערב פוקר של יום חמישי', 'ABCD-1234', SAMPLE_LINK);
  const lines = message.split('\n');
  assert.ok(lines.length <= 4, `expected at most 4 lines, got ${lines.length}`);
  assert.ok(message.length < 220, `expected a short message, got ${message.length} chars`);
});

test('a missing group name degrades gracefully: no "undefined", still a full invite', () => {
  const context = freshContext();
  for (const missing of [undefined, null, '', '   ']) {
    const message = buildText(context, missing, 'ABCD-1234', SAMPLE_LINK);
    assert.doesNotMatch(message, /undefined/);
    assert.match(message, /ABCD-1234/);
    assert.ok(message.includes(SAMPLE_LINK));
  }
});

test('a missing code degrades gracefully: no "undefined", no dangling "קוד:" line', () => {
  const context = freshContext();
  for (const missing of [undefined, null, '', '  ']) {
    const message = buildText(context, 'חברים של דביר', missing, SAMPLE_LINK);
    assert.doesNotMatch(message, /undefined/);
    assert.doesNotMatch(message, /קוד:/); // nothing to fall back to, so no stray label
    assert.match(message, /חברים של דביר/);
  }
});

test('the message survives encodeURIComponent for wa.me/?text= and decodes back exactly', () => {
  const context = freshContext();
  const message = buildText(context, 'חברים של דביר', 'ABCD-1234', SAMPLE_LINK);
  const encoded = encodeURIComponent(message);
  // The join link's own "?" and "=" must not survive raw, or wa.me would see a second query string.
  assert.doesNotMatch(encoded, /[?&=]/);
  assert.doesNotMatch(encoded, /\s/); // no literal spaces or raw newlines
  assert.equal(decodeURIComponent(encoded), message);
});

test('the WhatsApp share handler prefers navigator.share and falls back to wa.me', () => {
  const handler = sourceBetween(
    '    const whatsappBtn = el("button", "games-invite-action", "וואטסאפ");',
    '    actions.appendChild(whatsappBtn);'
  );
  assert.match(
    handler,
    /typeof navigator\.share === "function"[\s\S]*navigator\.share\([\s\S]*?\)[\s\S]*else[\s\S]*wa\.me\/\?text=/,
    'expected navigator.share to be tried first, with the wa.me link only in the else branch'
  );
  assert.match(handler, /encodeURIComponent\(message\)/);
  assert.match(handler, /window\.open\([\s\S]*?"_blank", "noopener"\)/);
});
