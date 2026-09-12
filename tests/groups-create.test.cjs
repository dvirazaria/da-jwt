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

// buildGroupCreation calls newId() twice (group id, member id); a stub keeps ids distinct
// and deterministic the same way other pure-section tests supply one.
function loadPure() {
  let n = 0;
  const context = vm.createContext({ newId: () => 'stub-id-' + (++n) });
  vm.runInContext(pureSource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- buildGroupCreation (pure) ----------

test('buildGroupCreation builds an admin, active GroupMember and a Group with a ParticipantRef creator', () => {
  const context = loadPure();
  const result = runJSON(
    `buildGroupCreation('דביר', 'ליל שישי', null, 'guest-1', '2026-09-07T20:00:00.000Z')`,
    context
  );
  assert.ok(result.group.id);
  assert.ok(result.member.id);
  assert.notEqual(result.group.id, result.member.id);
  assert.equal(result.group.name, 'ליל שישי');
  assert.equal(result.group.avatarDataUrl, null);
  assert.deepEqual(result.group.createdBy, { userId: null, guestId: 'guest-1', displayName: 'דביר' });
  assert.equal(result.group.createdAt, '2026-09-07T20:00:00.000Z');
  assert.equal(result.group.archivedAt, null);
  assert.equal(result.group.deletedAt, null);

  assert.equal(result.member.groupId, result.group.id);
  assert.equal(result.member.guestId, 'guest-1');
  assert.equal(result.member.displayName, 'דביר');
  assert.equal(result.member.role, 'admin');
  assert.equal(result.member.status, 'active');
  assert.equal(result.member.joinedAt, '2026-09-07T20:00:00.000Z');
  assert.equal(result.member.leftAt, null);
});

test('buildGroupCreation carries an avatar data URL when provided, and trims the name', () => {
  const context = loadPure();
  const withAvatar = runJSON(
    `buildGroupCreation('דביר', 'ליל שישי', 'data:image/jpeg;base64,AAAA', 'guest-1', 't')`,
    context
  );
  assert.equal(withAvatar.group.avatarDataUrl, 'data:image/jpeg;base64,AAAA');

  const untrimmed = runJSON(`buildGroupCreation('דביר', '  ליל שישי  ', null, 'guest-1', 't')`, context);
  assert.equal(untrimmed.group.name, 'ליל שישי');
});

// ---------- wiring: the create-group action is enabled beside the groups title ----------

test('the create-group action beside the groups title is enabled, not a coming-soon placeholder', () => {
  const source = sourceBetween('  function renderGroupsSection(', '  // Collapsed "ארכיון');
  assert.doesNotMatch(source, /coming-soon/);
  // only the ungrouped-game capsule is ever disabled (open-game guard); create-group never is
  assert.doesNotMatch(source, /createGroupBtn\.disabled/);
  assert.doesNotMatch(source, /createGroupBtn\.setAttribute\("aria-disabled"/);
  assert.doesNotMatch(source, /בקרוב/);
  assert.match(source, /\+ צור קבוצה/);
  assert.match(source, /toggleCreateGroupPanel/);
});

test('the create-group panel resizes an avatar file on canvas and offers a name field with a max length', () => {
  const source = sourceBetween('  function renderCreateGroupPanel(', '  function renderActiveGameCard(');
  assert.match(source, /accept = "image\/\*"/);
  assert.match(source, /resizeAvatarImage\(/);
  assert.match(source, /maxLength = 40/);
  assert.match(source, /shakeEl\(nameInput\)/);
});

test('resizeAvatarImage crops to a 96×96 JPEG at quality 0.8', () => {
  const source = sourceBetween('  function resizeAvatarImage(file) {', '  function collectionsOf(');
  assert.match(source, /size = 96/);
  assert.match(source, /image\/jpeg["'],\s*0\.8/);
});

// ---------- createGroup (non-pure handler) ----------

test('createGroup requires a signed-in name, otherwise it opens the login screen without creating anything', () => {
  const source = sourceBetween('  function createGroup(', '  function resetCreateGroupPanel(');
  assert.match(source, /if \(!me\) \{ showLogin\(\); return; \}/);
});

test('createGroup pushes a Group and an admin GroupMember, then saves and opens the group', () => {
  const source = sourceBetween('  function createGroup(', '  function resetCreateGroupPanel(');
  assert.match(source, /state\.groups\.push\(group\)/);
  assert.match(source, /state\.groupMembers\.push\(member\)/);
  assert.match(source, /save\(\);/);
  assert.match(source, /openGroup\(group\.id\)/);
  assert.match(source, /buildGroupCreation\(/);
});

// ---------- navigation: appView === "group" ----------

test('appView accepts "group" as a navigable view, opened via openGroup', () => {
  assert.match(html, /let appView = "games";\s*\/\/ "friends" \| "games" \| "game" \| "settle" \| "profile" \| "group"/);
  assert.match(html, /function openGroup\(groupId\) \{/);
  assert.match(html, /setAppView\("group"\)/);
  assert.match(html, /function renderGroupPage\(\)/);
  assert.match(html, /function renderGroupHeader\(summary, onBack, onSettings\)/);
  // Updated for the group-page-as-sheet change: "group" now renders the dashboard *and* the
  // group page (the sheet rises over the still-rendered, dimmed dashboard) instead of replacing
  // it outright — stronger than the old assertion, which only checked renderGroupPage() ran.
  assert.match(html, /else if \(appView === "group"\) \{ renderGamesDashboard\(\); renderGroupPage\(\); \}/);
});

test('the group view reuses the games dashboard shell and hides the game/settle rows', () => {
  const source = sourceBetween('  function render() {', '  function renderDerived() {');
  assert.match(source, /appView === "group"/);
  assert.match(source, /document\.getElementById\("gamesHome"\)\.hidden = appView !== "games" && appView !== "group";/);
});

// Was: head.addEventListener("click", actions.onOpen) directly. The press-then-open change
// (see the motion test below) routes both click and keydown through the same activate()
// closure so the card always shows its press state before actions.onOpen runs — strengthened
// here to also assert the keyboard path reuses that same closure, which the old direct-call
// assertion couldn't express.
test('the group card row opens its preview and is keyboard-accessible, without an expand control', () => {
  const source = sourceBetween('  function renderGroupCard(group, actions) {', '  function renderGroupsSection(');
  assert.match(source, /head\.setAttribute\("role", "button"\)/);
  assert.match(source, /head\.setAttribute\("tabindex", "0"\)/);
  assert.match(source, /const activate = \(\) => pressThenOpen\(card, actions\.onOpen\)/);
  assert.match(source, /head\.addEventListener\("click", activate\)/);
  assert.match(source, /if \(e\.key === "Enter" \|\| e\.key === " "\) \{ e\.preventDefault\(\); activate\(\); \}/);
  assert.doesNotMatch(source, /games-card-toggle/);
  assert.doesNotMatch(source, /הרחב/);
  const sectionSource = sourceBetween('  function renderGroupsSection(', '  function enterActiveGame(');
  assert.match(sectionSource, /onOpen: \(\) => openGroupPreview\(groupId\)/);
});

// ---------- group card press + layout (owner ask: animate on tap, count beside the name) ----------

test('pressThenOpen paints the press, then opens even when rAF is paused', () => {
  const source = sourceBetween('  function pressThenOpen(card, onOpen) {', '  function renderGroupsSection(');
  assert.match(source, /card\.classList\.add\("pressed"\)/);
  // Not a bare requestAnimationFrame: rAF is paused in a hidden/background tab, so gating the
  // navigation on it alone makes the tap silently do nothing there.
  assert.match(source, /afterNextFrame\(\(\) => \{/);
  assert.match(source, /card\.classList\.remove\("pressed"\)/);
  assert.match(source, /onOpen\(\);/);
});

test('the group card presses as one unit at DESIGN.md\'s standard scale(.92), replacing the old row-only scale(.97)', () => {
  const cssSource = sourceBetween('  .games-group-head { display: flex;', '  .games-empty {');
  assert.match(cssSource, /\.games-group-card \{ transition: transform \.12s ease; \}/);
  assert.match(cssSource, /\.games-group-card:active, \.games-group-card\.pressed \{ transform: scale\(\.92\); \}/);
  assert.doesNotMatch(cssSource, /scale\(\.97\)/);
});

test('the member count is a sibling of the group name in one row, not stacked underneath it', () => {
  const source = sourceBetween('  function renderGroupCard(group, actions) {', '  function pressThenOpen(');
  assert.match(source, /const titleRow = el\("div", "games-group-title-row"\);/);
  assert.match(source, /titleRow\.appendChild\(titleSpan\);/);
  assert.match(source, /titleRow\.appendChild\(el\("span", "games-card-meta", formatMemberCount\(Number\(group\.memberCount \|\| 0\)\)\)\);/);
  assert.match(source, /copy\.appendChild\(titleRow\);/);
  assert.match(html, /\.games-group-title-row \{ display: flex; align-items: center; justify-content: space-between; gap: 8px; \}/);
});

// ---------- placement: the create-group panel opens under its own button ----------
// The owner has 8+ groups; the panel used to be appended after the *whole* group list
// (renderCreateGroupPanel(section) as the last call in renderGroupsSection), so opening it
// scrolled nothing and the panel rendered far below the "+ צור קבוצה" button that opened it.
// It must now sit between the heading row and the list/empty-state, so it always opens right
// under the button regardless of how many group cards follow.

test('renderCreateGroupPanel is called right after the heading, before the group list or empty state -- not after the whole list', () => {
  const source = sourceBetween('  function renderGroupsSection(', '  // Collapsed "ארכיון');
  const headingIdx = source.indexOf('section.appendChild(heading)');
  const panelIdx = source.indexOf('renderCreateGroupPanel(section)');
  const listIdx = source.indexOf('games-group-list');
  const emptyIdx = source.indexOf('אין לך קבוצות עדיין');
  assert.ok(headingIdx >= 0 && panelIdx >= 0 && listIdx >= 0 && emptyIdx >= 0, 'expected markers not found');
  assert.ok(headingIdx < panelIdx, 'the panel must be requested after the heading is appended');
  assert.ok(panelIdx < listIdx, 'the panel must be appended before the group list, not after it');
  assert.ok(panelIdx < emptyIdx, 'the panel must be appended before the empty-state message too');
});

test('the create-group panel still opens via the shared grid-collapse transition, deferred a frame so it animates rather than appearing instantly', () => {
  const source = sourceBetween('  function renderCreateGroupPanel(', '  function renderActiveGameCard(');
  assert.match(source, /el\("div", "games-create-panel"\)/);
  assert.match(source, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{/);
  assert.match(source, /panel\.classList\.add\("open"\)/);
});

test('opening the panel focuses the name input, and only scrolls it into view when no other input already has focus', () => {
  const source = sourceBetween('  function renderCreateGroupPanel(', '  function renderActiveGameCard(');
  const openBlock = source.slice(source.indexOf('if (createGroupOpen && createGroupJustOpened)'));
  assert.match(openBlock, /nameInput\.focus\(\)/);
  assert.match(openBlock, /panel\.scrollIntoView\(\{ behavior: "smooth", block: "nearest" \}\)/);
  // Guarded: an input/textarea with focus elsewhere is left alone rather than yanked.
  assert.match(openBlock, /activeTag !== "INPUT" && activeTag !== "TEXTAREA"/);
  assert.match(openBlock, /document\.activeElement/);
});

test('closing the create-group panel still reverses the grid-collapse transition before clearing the draft', () => {
  const source = sourceBetween('  function closeCreateGroupPanel(', '  function addMemberByName(');
  assert.match(source, /panel\.classList\.remove\("open"\)/);
  assert.match(source, /setTimeout\(finish, 280\)/);
});

// ---------- normalize() hardening ----------

test('normalize shapes groups/groupMembers/invites/friendships through their normalizers, same as debts', () => {
  const source = sourceBetween('  function normalize(s) {', '  function newId(');
  assert.match(source, /s\.groups\.map\(normalizeGroup\)\.filter\(Boolean\)/);
  assert.match(source, /s\.groupMembers\.map\(normalizeGroupMember\)\.filter\(Boolean\)/);
  assert.match(source, /s\.invites\.map\(normalizeInvite\)\.filter\(Boolean\)/);
  assert.match(source, /s\.friendships\.map\(normalizeFriendship\)\.filter\(Boolean\)/);
});
