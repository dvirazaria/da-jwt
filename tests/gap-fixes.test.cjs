// Tests for the "fix-now" findings in docs/superpowers/plans/2026-09-08-pre-backend-gaps.md
// section 3 (items #1, #3, #5, #6, #7, #8, #9, #10, #11). Follows the vm-slice pattern used by
// the sibling group suites (tests/group-game-start.test.cjs, tests/groups-domain.test.cjs,
// tests/player-exit.test.cjs).
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

const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

function loadPure(newIdStub) {
  const context = vm.createContext({ newId: newIdStub || (() => 'stub-new-id') });
  vm.runInContext(pureSource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- #1: dedupeParticipants (pure) ----------

test('dedupeParticipants keeps the first occurrence by trimmed name and drops later duplicates', () => {
  const context = loadPure();
  const participants = [
    { name: 'דן', guestId: 'g1', memberId: null },
    { name: '  דן  ', guestId: 'g2', memberId: null },
    { name: 'רותם', guestId: 'g3', memberId: null },
  ];
  const result = runJSON(`dedupeParticipants(${JSON.stringify(participants)})`, context);
  assert.deepEqual(result.map(p => p.name), ['דן', 'רותם']);
  assert.equal(result[0].guestId, 'g1'); // first occurrence wins
});

test('dedupeParticipants: a member entry wins over a guest entry with the same name when the member is listed first', () => {
  const context = loadPure();
  const participants = [
    { name: 'דן', guestId: 'guest-1', memberId: 'member-1' }, // member, listed first
    { name: 'דן', guestId: 'guest-2', memberId: null },        // guest, same name, listed second
  ];
  const result = runJSON(`dedupeParticipants(${JSON.stringify(participants)})`, context);
  assert.equal(result.length, 1);
  assert.equal(result[0].memberId, 'member-1');
});

test('dedupeParticipants handles a non-array input safely', () => {
  const context = loadPure();
  assert.deepEqual(runJSON(`dedupeParticipants(null)`, context), []);
});

// ---------- #1: startGroupGame wiring ----------

test('startGroupGame de-duplicates participants via dedupeParticipants before building players', () => {
  const section = sourceBetween('function startGroupGame(', '  function continueCurrentGame(');
  assert.match(section, /const list = dedupeParticipants\(participants\)/);
});

// ---------- #1: renderStartGameAddGuest checks against ALL active members, not just selected ----------

test('renderStartGameAddGuest rejects a guest name matching any active member (selected or not), not only the selected ones', () => {
  const section = sourceBetween('function renderStartGameAddGuest(', '  function toggleStartGamePanel(');
  assert.match(section, /const memberNames = members\.map\(m => m\.displayName\)/);
  assert.match(section, /memberNames\.includes\(name\)/);
  assert.doesNotMatch(section, /selectedNames/);
});

// ---------- #3: left-member guard ----------

test('startGroupGame refuses when the current user has no active membership in the group', () => {
  const section = sourceBetween('function startGroupGame(', '  function continueCurrentGame(');
  assert.match(section, /if \(!findMyMembership\(state\.groupMembers, groupId, me\)\) return false;/);
});

test('renderGroupPrimaryAction gates the start action on summary.isMember and shows "עזבת את הקבוצה" for a left member', () => {
  const section = sourceBetween('function renderGroupPrimaryAction(', '  function renderStartGamePanel(');
  assert.match(section, /const canStart = !summary\.hasActiveGame && summary\.isMember && gate && gate\.ok;/);
  assert.match(section, /if \(!summary\.isMember\) \{\s*\n\s*reason = "עזבת את הקבוצה";/);
});

test('getGroupSummary sets isMember=false for a user who left the group (findMyMembership finds no active row)', () => {
  const context = loadPure();
  const collections = {
    groups: [{ id: 'g1', name: 'ליל שישי', avatarDataUrl: null, archivedAt: null, deletedAt: null }],
    groupMembers: [
      { id: 'm1', groupId: 'g1', userId: null, guestId: 'p1', displayName: 'דביר', role: 'admin', status: 'active' },
      { id: 'm2', groupId: 'g1', userId: null, guestId: 'p2', displayName: 'עזב', role: 'member', status: 'left' },
    ],
    history: [],
    currentGame: { example: false, phase: 'closed', groupId: null },
  };
  const summary = JSON.parse(vm.runInContext(`JSON.stringify(getGroupSummary(${JSON.stringify(collections)}, 'g1', 'עזב'))`, context));
  assert.equal(summary.isMember, false);
  const stillIn = JSON.parse(vm.runInContext(`JSON.stringify(getGroupSummary(${JSON.stringify(collections)}, 'g1', 'דביר'))`, context));
  assert.equal(stillIn.isMember, true);
});

// ---------- #5: profile empty-state copy no longer points at the removed "חישוב" tab ----------

test('the recent-nights empty state describes the current navigation, not the removed "חישוב" tab', () => {
  assert.match(html, /עוד אין ערבים ברקורד\. אחרי סגירת שולחן הערב יופיע כאן\./);
  assert.doesNotMatch(html, /בטאב\s*[""]חישוב[""]/);
});

// ---------- #6: "מנה מנהל אחר קודם" reworded ----------

test('the last-admin leave-block reason reads as an instruction ("העבר ניהול...") everywhere', () => {
  assert.doesNotMatch(html, /מנה מנהל אחר קודם/);
  assert.match(html, /"העבר ניהול לחבר אחר קודם"/);
});

// ---------- #7: applyRemote compares groupId and leaderRef too ----------

test('applyRemote\'s equality check includes groupId and leaderRef on both sides', () => {
  const applyRemoteSource = html.slice(html.indexOf('  function applyRemote(data)'), html.indexOf('  document.addEventListener("visibilitychange"'));
  assert.match(applyRemoteSource, /gi: incoming\.groupId, lr: incoming\.leaderRef/);
  assert.match(applyRemoteSource, /gi: state\.groupId, lr: state\.leaderRef/);
});

// ---------- #8: leaderRef is normalized on load ----------

test('normalize() runs leaderRef through normalizeParticipantRef, stripping unknown keys and forcing userId null', () => {
  const normalizeSource = html.slice(html.indexOf('  function normalizePhase'), html.indexOf('  function load()'));
  const groupsPureSource = html.slice(html.indexOf('  // ---------- groups domain (pure) ----------'), html.indexOf('  function el('));
  function normalize(s) {
    return JSON.parse(vm.runInNewContext(
      normalizeSource + '\n' + groupsPureSource + '\nJSON.stringify(normalize(input))',
      { input: s, crypto: require('node:crypto').webcrypto, newId: () => 'stub-new-id' }
    ));
  }
  const result = normalize({
    gameId: 'g1', history: [],
    players: [{ name: 'א', buyins: [], cashout: 0 }],
    leaderRef: { userId: 'bogus-user-id', guestId: 'u1', displayName: 'דביר', evil: 'inject-me' },
  });
  assert.deepEqual(result.leaderRef, { userId: null, guestId: 'u1', displayName: 'דביר' });
  assert.equal(Object.prototype.hasOwnProperty.call(result.leaderRef, 'evil'), false);
});

// ---------- #9: accessibility — invite copied announcement, exit-toggle expanded state ----------

test('the invite "copied" note is an announced live region', () => {
  const section = sourceBetween('function renderGroupInvite(', '  function renderGroupPage(');
  assert.match(section, /copiedNote\.setAttribute\("role", "status"\)/);
  assert.match(section, /copiedNote\.setAttribute\("aria-live", "polite"\)/);
});

test('the exit-toggle button exposes aria-expanded and aria-controls pointing at the exit panel', () => {
  const section = sourceBetween('function render() {', '  function renderDerived(');
  assert.match(section, /exitToggle\.setAttribute\("aria-expanded", String\(exitOpen === p\.name\)\)/);
  assert.match(section, /exitToggle\.setAttribute\("aria-controls", "exit-panel-" \+ idx\)/);
  assert.match(section, /exitPanel\.id = "exit-panel-" \+ idx/);
});

// ---------- #10: stale comment above renderGroupPrimaryAction ----------

test('the renderGroupPrimaryAction comment no longer references the removed Task 8 placeholder wording', () => {
  const section = html.slice(html.indexOf('renderGroupPrimaryAction(summary, gate)') - 700, html.indexOf('renderGroupPrimaryAction(summary, gate)'));
  assert.doesNotMatch(section, /Task 8 wires the actual start-game handler here/);
  assert.doesNotMatch(section, /when it IS\s*\n?\s*ok the button is still disabled for this task/);
});

// ---------- #11: table stat line uses formatPlayerCount ----------

test('the table stat line formats the player count with formatPlayerCount, not a raw concatenation', () => {
  const section = sourceBetween('function renderDerived() {', '  function confetti(');
  assert.match(section, /formatPlayerCount\(state\.players\.length\) \+ exitedLabel/);
  assert.doesNotMatch(section, /state\.players\.length \+ " שחקנים"/);
});
