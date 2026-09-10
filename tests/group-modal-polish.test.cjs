// group-modal-polish: owner's six asks on the group modal (#groupPreview / #groupSheet).
// Regex-over-source style, same convention as the rest of tests/*.test.cjs — this file has no
// DOM, so behaviour is verified the same way tests/group-page.test.cjs and
// tests/design-round.test.cjs already do for this surface. See those two files (plus
// tests/group-members.test.cjs, reviewed but left untouched) for the tests this task rewrote in
// place; this file holds only the new coverage.
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
function loadPure() {
  const context = vm.createContext({ newId: () => 'stub-id' });
  vm.runInContext(pureSource, context);
  return context;
}

// ---------- #2: the empty leaderboard says nothing at all ----------

test('renderGroupLeaders bails out before building any DOM — the null return is the first statement, not an afterthought', () => {
  const source = sourceBetween('  function renderGroupLeaders(entries) {', '  function renderGroupMembers(');
  const guardIdx = source.indexOf('if (!list.length) return null;');
  const firstElIdx = source.indexOf('el(');
  assert.ok(guardIdx >= 0, 'the empty guard must exist');
  assert.ok(firstElIdx >= 0, 'the populated branch must still build DOM');
  assert.ok(guardIdx < firstElIdx, 'the empty check must run before any section/heading/row is created');
  // and the placeholder copy is gone from the whole file, not just quieted in this function
  assert.doesNotMatch(html, /הדירוג יופיע אחרי המשחק הראשון/);
});

// ---------- #4: member rows have no chevron, no aria-expanded, anywhere in the file ----------

test('no element anywhere in the source still carries games-member-chevron or a role="button" member row', () => {
  assert.doesNotMatch(html, /games-member-chevron/);
  assert.doesNotMatch(html, /games-member-row\[role="button"\]/);
  assert.doesNotMatch(html, /games-member-row\.with-actions/);
});

// ---------- #5: the admin remove X — style, and the two-step arm/disarm chain ----------

test('the remove X is --bad at rest (not hover-revealed), a 44px target, with an aria-label naming the member', () => {
  const rule = html.match(/\.games-member-remove \{[^}]*\}/)[0];
  assert.match(rule, /color: var\(--bad\)/);
  assert.match(rule, /min-width: 44px; min-height: 44px/);
  const js = sourceBetween('  function renderRemoveMemberButton(member) {', '  // Inline "+ הוסף חבר"');
  assert.match(js, /setAttribute\("aria-label", armed/);
  assert.match(js, /member\.displayName \+ " מהקבוצה"/);
});

test('the whole remove chain still runs through the same two-step arm and the last-admin guard: X → armRemoveMember → removeMember → removeGroupMember (pure)', () => {
  // X button: first tap arms, second tap (while already armed) actually removes — no single-tap path.
  const btn = sourceBetween('  function renderRemoveMemberButton(member) {', '  // Inline "+ הוסף חבר"');
  assert.match(btn, /if \(removeMemberArmedId === member\.id\) \{\s*\n\s*disarmRemoveMember\(\);\s*\n\s*removeMember\(member\.groupId, member\.id\);/);
  assert.match(btn, /armRemoveMember\(member\.id\);/);
  // removeMember (UI) hands off to removeGroupMember (pure) unchanged.
  assert.match(html, /function removeMember\(groupId, memberId\) \{[\s\S]{0,200}removeGroupMember\(state\.groupMembers, memberId, new Date\(\)\.toISOString\(\)\)/);
  // removeGroupMember (pure) still refuses the group's last active admin — verified functionally,
  // not just by grep, with the exact fixture tests/group-members.test.cjs uses for this guard.
  const context = loadPure();
  const soleAdmin = [{ id: 'm1', groupId: 'g1', role: 'admin', status: 'active' }];
  const ctx = vm.createContext({ newId: () => 'x' });
  vm.runInContext(pureSource, ctx);
  vm.runInContext(`var members = ${JSON.stringify(soleAdmin)};`, ctx);
  assert.equal(vm.runInContext(`removeGroupMember(members, 'm1', 't')`, ctx), false);
});

test('a viewer can never X out their own row, admin or not — the row computes canRemove with membershipMatchesUser excluding self', () => {
  const row = sourceBetween('  function renderMemberRow(member, activeList, isAdmin) {', '  function renderMemberActions(');
  assert.match(row, /!membershipMatchesUser\(member, me\)/);
  // membershipMatchesUser itself, exercised directly: the offline/local fallback matches by
  // displayName (no authUser in this sandbox), so a row rendered for "me" is excluded from the X.
  const context = loadPure();
  assert.equal(vm.runInContext(`membershipMatchesUser({displayName:'דביר'}, 'דביר')`, context), true);
  assert.equal(vm.runInContext(`membershipMatchesUser({displayName:'יוסי'}, 'דביר')`, context), false);
});

// ---------- #6: body scroll lock, applied on open and fully restored on close ----------

test('opening either group surface locks body scroll exactly once per genuine open transition', () => {
  const preview = sourceBetween('  function openGroupPreview(groupId) {', '  // A modal needs more than one way out');
  assert.match(preview, /const wasHidden = overlay\.hidden;/);
  assert.match(preview, /overlay\.hidden = false;/);
  assert.match(preview, /if \(wasHidden\) lockGroupModalScroll\(\);/);
  const sheet = sourceBetween('  function syncGroupSheet() {', '  // Member chips above');
  assert.match(sheet, /if \(!groupSheetOpen\) \{\s*\n\s*groupSheetOpen = true;\s*\n\s*lockGroupModalScroll\(\);/);
});

test('closing either surface restores scroll immediately — via the X/close call, Escape, or the backdrop, which all funnel through the same close functions', () => {
  const closePreview = sourceBetween('  function closeGroupPreview() {', '  function renderGroupPreview() {');
  assert.match(closePreview, /unlockGroupModalScroll\(\);/);
  const sheet = sourceBetween('  function syncGroupSheet() {', '  // Member chips above');
  assert.match(sheet, /\} else if \(groupSheetOpen\) \{\s*\n\s*groupSheetOpen = false;\s*\n\s*backdrop\.classList\.remove\("open"\);\s*\n\s*unlockGroupModalScroll\(\);/);
  // Escape and the backdrop tap both go through dismissOpenGroupModal → closeGroupPreview /
  // setAppView("games") → syncGroupSheet's close branch above, not a separate exit path.
  assert.match(html, /function dismissOpenGroupModal\(\) \{[\s\S]*?closeGroupPreview\(\); return true; \}[\s\S]*?setAppView\("games"\); return true; \}/);
  // the unlock helper itself restores the exact captured offset via window.scrollTo, and clears
  // every inline style position: fixed set — nothing is left pinned.
  const unlock = sourceBetween('  function unlockGroupModalScroll() {', '\n  // The dashboard keeps group rows compact');
  assert.match(unlock, /document\.body\.style\.position = "";/);
  assert.match(unlock, /window\.scrollTo\(0, groupModalScrollY\);/);
});

test('the scroll lock is reference-counted, not a bare boolean — one surface closing cannot unlock the body while the other is still open', () => {
  const lock = sourceBetween('  function lockGroupModalScroll() {', '  function unlockGroupModalScroll() {');
  assert.match(lock, /groupModalLockCount\+\+;/);
  const unlock = sourceBetween('  function unlockGroupModalScroll() {', '\n  // The dashboard keeps group rows compact');
  assert.match(unlock, /groupModalLockCount--;/);
  assert.match(unlock, /if \(groupModalLockCount === 0\) \{/);
});

test('.group-sheet-panel keeps its own overflow from chaining onto the locked body (overscroll-behavior: contain)', () => {
  const panel = html.match(/\.group-sheet-panel \{[^}]*\}/)[0];
  assert.match(panel, /overscroll-behavior: contain;/);
});

// ---------- #3: the modal is ~60px taller, still capped ----------

test('the modal max-height grew from min(640px, 84vh) to min(700px, 88vh) — +60px on a typical phone, still capped well under 100vh on a small one', () => {
  const panel = html.match(/\.group-sheet-panel \{[^}]*\}/)[0];
  assert.match(panel, /max-height: min\(700px, 88vh\);/);
  assert.doesNotMatch(html, /min\(640px, 84vh\)/);
});

// ---------- role management must remain reachable after the strip was retired ----------

test('promoting and demoting survived the member-row simplification, in the settings overlay', () => {
  // Retiring the tap-to-expand strip left renderMemberActions (which held "הפוך למנהל" /
  // "הסר ניהול") with no caller at all: no way to appoint an admin, and "העבר ניהול לחבר אחר
  // קודם" advising a handover the UI could not perform.
  assert.match(html, /id="groupSetRoles"/, 'the overlay needs a home for role management');
  assert.match(html, /rolesBox\.appendChild\(renderMemberRolesPanel\(currentGroupId\)\)/);
  assert.match(html, /rolesBox\.hidden = !summary\.isAdmin/, 'admin-only, like the other overlay controls');

  const panel = html.slice(html.indexOf('function renderMemberRolesPanel'));
  const body = panel.slice(0, panel.indexOf('\n  }'));
  assert.match(body, /renderMakeAdminButton\(member\)/, 'promote must be reachable');
  assert.match(body, /renderRemoveAdminButton\(member\)/, 'demote must be reachable');
  assert.match(body, /isLastActiveAdmin\(activeList, member\.id\)/, 'the last admin keeps their role');
  // Removal stays on the member row's red X — this panel must not grow a second delete path.
  assert.doesNotMatch(body, /renderRemoveMemberButton/, 'removal belongs to the row, not here');
});
