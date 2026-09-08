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

// ---------- A1: deferred renders (setTimeout/async callbacks) must not resurrect a stale view ----------

test('renderGroupPage guards on appView !== "group" so a deferred panel-close/avatar callback fired after navigating away is a no-op', () => {
  const idx = html.indexOf('  function renderGroupPage() {');
  assert.ok(idx >= 0, 'renderGroupPage not found');
  assert.match(html.slice(idx, idx + 400), /if \(appView !== "group"\) return;/);
});

test('renderGamesDashboard guards on appView !== "games", the same way', () => {
  const idx = html.indexOf('  function renderGamesDashboard() {');
  assert.ok(idx >= 0, 'renderGamesDashboard not found');
  assert.match(html.slice(idx, idx + 400), /if \(appView !== "games"\) return;/);
});

test('setAppView disarms the armed "הסר" member row and resets the create-group panel, like it already does the start-game panel', () => {
  const source = sourceBetween('  function setAppView(nextView) {', '  function flashViewEnter');
  assert.match(source, /disarmRemoveMember\(\);/);
  assert.match(source, /resetCreateGroupPanel\(\);/);
  assert.match(source, /resetStartGamePanel\(\);/);
});

test('setAppView also resets the armed close-table state (closeArmed/closeArmTimer) and its button label when leaving settle', () => {
  const source = sourceBetween('  function setAppView(nextView) {', '  function flashViewEnter');
  assert.match(source, /clearTimeout\(closeArmTimer\);/);
  assert.match(source, /closeArmTimer = null;/);
  assert.match(source, /closeArmed = false;/);
  assert.match(source, /setCloseButtonLabel\(closeBtn, "סגירת שולחן ורישום לרקורד"\);/);
});

// ---------- B1: flashViewEnter must not leak an animationend listener under reduced-motion ----------

test('flashViewEnter skips the animationend listener under prefers-reduced-motion and always has a capped setTimeout fallback', () => {
  const source = sourceBetween('  function flashViewEnter', '  function startUngroupedGame() {');
  assert.match(source, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(source, /if \(!matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches\) \{\s*\n\s*container\.addEventListener\("animationend"/);
  assert.match(source, /setTimeout\(\(\) => container\.classList\.remove\("load-in"\), 600\);/);
});

// ---------- B5: render() keeps the open group-settings overlay in sync with remote/state changes ----------

test('render() refreshes the group-settings overlay when it is open (applyRemote -> render must not leave it stale)', () => {
  const source = sourceBetween('  function render() {', '  function renderDerived(');
  assert.match(source, /if \(!document\.getElementById\("groupSettings"\)\.hidden\) refreshGroupSettings\(\);/);
});

// ---------- C3: group history row head <-> details panel are wired by id/aria-controls ----------

test('renderGroupHistoryRow gives the details panel an id and points the head at it via aria-controls', () => {
  const source = sourceBetween('  function renderGroupHistoryRow(game, expanded, onToggle) {', '  function renderGroupHistory(');
  assert.match(source, /const detailsId = "group-history-details-" \+ game\.gameId;/);
  assert.match(source, /head\.setAttribute\("aria-controls", detailsId\);/);
  assert.match(source, /details\.id = detailsId;/);
});

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

test('the exit-edit ("עריכה") button also exposes aria-expanded and aria-controls, like exit-toggle', () => {
  const section = sourceBetween('function render() {', '  function renderDerived(');
  assert.match(section, /editBtn\.setAttribute\("aria-expanded", String\(exitOpen === p\.name\)\)/);
  assert.match(section, /editBtn\.setAttribute\("aria-controls", "exit-panel-" \+ idx\)/);
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

// ---------- C6: knownNames() must not throw on a malformed history entry (missing .players) ----------

// ---------- D3: fmt/fmtSigned isolate the money string in FSI/PDI (bidi fix) ----------

const FSI = '⁨', PDI = '⁩';
function loadFmt() {
  const source = html.slice(html.indexOf('  const fmt = '), html.indexOf('  const sum = '));
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context;
}

test('fmt wraps its output in FSI/PDI (U+2068/U+2069) so ₪ can not land on the wrong side of the digits under bidi', () => {
  const context = loadFmt();
  const out = vm.runInContext('fmt(100)', context);
  assert.equal(out[0], FSI);
  assert.equal(out[out.length - 1], PDI);
  // Otherwise identical: stripping the isolate marks reproduces the pre-existing "₪<amount>" text.
  assert.equal(out.slice(1, -1), '₪' + (100).toLocaleString('he-IL'));
});

test('fmtSigned also wraps its output in FSI/PDI and keeps the +/- sign logic', () => {
  const context = loadFmt();
  const pos = vm.runInContext('fmtSigned(100)', context);
  assert.equal(pos[0], FSI);
  assert.equal(pos[pos.length - 1], PDI);
  assert.ok(pos.includes('+'), 'a positive net keeps its leading "+"');
  assert.ok(pos.includes('100'));

  const neg = vm.runInContext('fmtSigned(-50)', context);
  assert.equal(neg[0], FSI);
  assert.equal(neg[neg.length - 1], PDI);
  assert.ok(neg.includes('50'));

  const zero = vm.runInContext('fmtSigned(0)', context);
  assert.equal(zero[0], FSI);
  assert.equal(zero[zero.length - 1], PDI);
  assert.ok(zero.includes('₪0'));
});

test('knownNames guards Array.isArray(g.players) so a malformed history entry is skipped, not thrown on', () => {
  const source = sourceBetween('  function knownNames() {', '  function debtDateLabel(');
  assert.match(source, /Array\.isArray\(g\.players\)/);
  const context = vm.createContext({
    state: {
      example: false,
      players: [{ name: 'חי' }],
      history: [
        { players: [{ name: 'א' }, { name: 'ב' }] },
        { at: 'no players field at all' }, // malformed legacy entry — must not throw
      ],
    },
  });
  vm.runInContext(source, context);
  const names = JSON.parse(vm.runInContext('JSON.stringify(knownNames())', context));
  assert.deepEqual(names, ['א', 'ב', 'חי']);
});

// ---------- D6: quiet/disabled text moves from --faint to --dim (contrast) ----------

// The QR placeholder tile this test used to cover was removed entirely by the design round (D6).
test('empty-note, btn-skip, joinNoticeCode and the blocked close-button state read --dim, not --faint', () => {
  const rule = (selector) => {
    // Anchored on a line start so a compound selector containing the same class as a suffix
    // (e.g. ".debt-group .empty-note {") can't shadow the standalone rule.
    const idx = html.indexOf('\n  ' + selector);
    assert.ok(idx >= 0, `${selector} not found`);
    return html.slice(idx, html.indexOf('}', idx) + 1);
  };
  assert.match(rule('.empty-note {'), /color: var\(--dim\)/);
  assert.match(rule('.btn-skip {'), /color: var\(--dim\)/);
  assert.match(rule('#joinNoticeCode {'), /color: var\(--dim\)/);
  assert.match(rule('.btn-close-table.blocked-state {'), /color: var\(--dim\)/);
  assert.match(rule('.btn-close-table.blocked-state:hover {'), /color: var\(--dim\)/);
});

// ---------- B2: archiving a group is blocked while it has an open game ----------

test('the group settings overlay disables "העבר לארכיון" and shows the same blocked reason as delete, while the group has an open game', () => {
  const source = sourceBetween('  function refreshGroupSettings() {', '  function openGroupSettings() {');
  assert.match(source, /archiveBtn\.disabled = archiveBlocked/);
  assert.match(source, /archiveReason\.textContent = archiveBlocked \? "סגור קודם את המשחק הפעיל" : ""/);
  // Restoring an already-archived group is never blocked by an active game.
  assert.match(source, /const archiveBlocked = !group\.archivedAt && summary\.hasActiveGame/);
});

test('the archive click handler also refuses to archive (not unarchive) while a game is active', () => {
  const source = sourceBetween('  document.getElementById("groupSetArchiveBtn").addEventListener("click"', '  document.getElementById("groupSetDeleteBtn").addEventListener("click"');
  assert.match(source, /if \(!wasArchived && summary && summary\.hasActiveGame\) return;/);
});

test('archiveGroup itself stays a pure, unconditional state transition (the active-game gate lives only in the UI handler)', () => {
  const source = sourceBetween('  function archiveGroup(groups, id, at) {', '  function unarchiveGroup(groups, id) {');
  assert.doesNotMatch(source, /hasActiveGame/);
});
