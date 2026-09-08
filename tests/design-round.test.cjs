// Design round (owner decisions D1-D8 + design-review P2/P3 rows). Same vm-slice/regex pattern
// as the other suites: pure functions run in a bare vm context, wiring is asserted with regexes
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

const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');
function loadPure() {
  const context = vm.createContext({ newId: () => 'stub-id' });
  vm.runInContext(pureSource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- D8: hiddenAt on GroupMember + hideGroupForMember (pure) ----------

test('normalizeGroupMember defaults hiddenAt to null and keeps a stored ISO string', () => {
  const context = loadPure();
  const fresh = runJSON(`normalizeGroupMember({id:'m1', groupId:'g1', displayName:'דביר'})`, context);
  assert.equal(fresh.hiddenAt, null);
  const hidden = runJSON(
    `normalizeGroupMember({id:'m1', groupId:'g1', displayName:'דביר', status:'left', hiddenAt:'2026-09-08T10:00:00Z'})`,
    context
  );
  assert.equal(hidden.hiddenAt, '2026-09-08T10:00:00Z');
});

test('hideGroupForMember stamps hiddenAt on my own left/removed membership', () => {
  const context = loadPure();
  vm.runInContext(`var members = [
    {id:'m1', groupId:'g1', displayName:'דביר', role:'member', status:'left', leftAt:'t0', hiddenAt:null},
    {id:'m2', groupId:'g1', displayName:'יוסי', role:'admin', status:'active', hiddenAt:null}
  ];`, context);
  assert.equal(vm.runInContext(`hideGroupForMember(members, 'g1', 'דביר', 'T1')`, context), true);
  const members = runJSON('members', context);
  assert.equal(members[0].hiddenAt, 'T1');
  assert.equal(members[1].hiddenAt, null); // never touches anybody else's membership
});

test('hideGroupForMember refuses while I am still an active member, and when I was never one', () => {
  const context = loadPure();
  vm.runInContext(`var members = [{id:'m1', groupId:'g1', displayName:'דביר', role:'member', status:'active', hiddenAt:null}];`, context);
  assert.equal(vm.runInContext(`hideGroupForMember(members, 'g1', 'דביר', 'T1')`, context), false);
  assert.equal(runJSON('members', context)[0].hiddenAt, null);
  assert.equal(vm.runInContext(`hideGroupForMember(members, 'g1', 'מישהו אחר', 'T1')`, context), false);
  assert.equal(vm.runInContext(`hideGroupForMember(members, 'g-missing', 'דביר', 'T1')`, context), false);
});

test('a removed member can hide the group too (status "removed", not just "left")', () => {
  const context = loadPure();
  vm.runInContext(`var members = [{id:'m1', groupId:'g1', displayName:'דביר', role:'member', status:'removed', hiddenAt:null}];`, context);
  assert.equal(vm.runInContext(`hideGroupForMember(members, 'g1', 'דביר', 'T1')`, context), true);
  assert.equal(runJSON('members', context)[0].hiddenAt, 'T1');
});

function hiddenCollections() {
  return {
    groups: [
      { id: 'g1', name: 'הוסתרה', archivedAt: null, deletedAt: null },
      { id: 'g2', name: 'נשארת', archivedAt: null, deletedAt: null },
    ],
    groupMembers: [
      { id: 'm1', groupId: 'g1', guestId: 'u1', displayName: 'דביר', role: 'member', status: 'left', hiddenAt: '2026-09-08T10:00:00Z' },
      { id: 'm2', groupId: 'g2', guestId: 'u1', displayName: 'דביר', role: 'member', status: 'left', hiddenAt: null },
    ],
    history: [],
    currentGame: {},
  };
}

test('getGroupSummaries hides a group I left and then deleted from this device', () => {
  const context = loadPure();
  const ids = runJSON(`getGroupSummaries(${JSON.stringify(hiddenCollections())}, 'דביר').map(s => s.groupId)`, context);
  assert.deepEqual(ids, ['g2']);
});

test('getGroupSummary still resolves a hidden group when it is opened directly', () => {
  const context = loadPure();
  const summary = runJSON(`getGroupSummary(${JSON.stringify(hiddenCollections())}, 'g1', 'דביר')`, context);
  assert.equal(summary.groupId, 'g1');
  assert.equal(summary.isMember, false);
});

test('a hidden group stays hidden in the dashboard archive list as well', () => {
  const context = loadPure();
  const collections = hiddenCollections();
  collections.groups[0].archivedAt = '2026-09-08T09:00:00Z';
  collections.groups[1].archivedAt = '2026-09-08T09:00:00Z';
  const ids = runJSON(`getArchivedGroupSummaries(${JSON.stringify(collections)}, 'דביר').map(s => s.groupId)`, context);
  assert.deepEqual(ids, ['g2']);
});

test('the group page of a group I left offers the two-step "מחק קבוצה" that calls hideGroupForMember', () => {
  const source = sourceBetween('  function renderGroupPrimaryAction(summary, gate) {', '  function renderStartGamePanel() {');
  assert.match(source, /עזבת את הקבוצה/);
  assert.match(source, /hideGroupForMember\(state\.groupMembers, currentGroupId, me, new Date\(\)\.toISOString\(\)\)/);
  assert.match(source, /הקבוצה תוסר מהמכשיר שלך/);
  assert.match(source, /set-flat danger/);
  assert.match(source, /hideGroupArmed/);
  assert.match(source, /setAppView\("games"\)/);
});

// ---------- D2: back-from-the-table header ----------

test('the table header renders a back arrow to the group and the group name, with a quiet phase label', () => {
  const source = sourceBetween('  function renderTableHeader() {', '  function render() {');
  assert.match(source, /"back-arrow"/);
  assert.match(source, /openGroup\(state\.groupId\)/);
  assert.match(source, /setAppView\("games"\)/);
  assert.match(source, /משחק ללא קבוצה/);
  assert.match(source, /סגירה/);
  assert.match(source, /שולחן/);
  assert.match(source, /table-header-name/);
});

test('render() shows the table header only in the game and settle views', () => {
  assert.match(html, /<div class="table-header" id="tableHeader" hidden>/);
  const source = sourceBetween('  function render() {', '  function renderDerived() {');
  assert.match(source, /renderTableHeader\(\)/);
  const headerSource = sourceBetween('  function renderTableHeader() {', '  function render() {');
  assert.match(headerSource, /appView !== "game" && appView !== "settle"/);
});

test('the bottom stat line no longer carries the group name', () => {
  const source = sourceBetween('  function renderDerived() {', '  // ---------- confetti');
  assert.doesNotMatch(source, /קבוצה: /);
  assert.doesNotMatch(source, /statGroup/);
});

// ---------- D7: the "פעולות מהירות" section title is gone ----------

test('the quick-actions section keeps both buttons but drops its generic title', () => {
  const source = sourceBetween('  function renderQuickActions(parent) {', '  function renderCreateGroupPanel(');
  assert.doesNotMatch(source, /פעולות מהירות/);
  assert.match(source, /\+ צור קבוצה/);
  assert.match(source, /משחק ללא קבוצה/);
});

// ---------- D1 + D6: invite and add-member move into the group settings overlay ----------

test('renderGroupPage no longer renders the invite block or the add-member panel', () => {
  const source = sourceBetween('  function renderGroupPage() {', '  function renderAddRowChips() {');
  assert.doesNotMatch(source, /renderGroupInvite/);
  assert.doesNotMatch(source, /renderAddMemberPanel/);
  const membersSource = sourceBetween('  function renderGroupMembers(members, former, isAdmin) {', '  function renderMemberRow(');
  assert.doesNotMatch(membersSource, /renderAddMemberPanel/);
});

test('the group settings overlay hosts the invite section (all members) and the add-member panel (admins)', () => {
  assert.match(html, /id="groupSetInvite"/);
  assert.match(html, /id="groupSetAddMember"/);
  const source = sourceBetween('  function refreshGroupSettings() {', '  function openGroupSettings() {');
  assert.match(source, /renderGroupInvite\(summary, activeInvite\(state\.invites, currentGroupId\), summary\.isAdmin\)/);
  assert.match(source, /renderAddMemberPanel\(\)/);
  assert.match(source, /addMemberBox\.hidden = !summary\.isAdmin/);
});

test('the group settings overlay scrolls now that it holds the invite and add-member sections', () => {
  const idx = html.indexOf('\n  #groupSettings {');
  assert.ok(idx >= 0, '#groupSettings overlay rule not found');
  const rule = html.slice(idx, html.indexOf('}', idx) + 1);
  assert.match(rule, /overflow-y:\s*auto/);
  assert.match(rule, /safe-area-inset-bottom/);
});

test('one shared "יעבוד כשהאפליקציה תתחבר לשרת" constant replaces the four separate wordings', () => {
  assert.match(html, /const SERVER_NOTE = "יעבוד כשהאפליקציה תתחבר לשרת";/);
  assert.doesNotMatch(html, /חיבור חשבונות יגיע עם השרת/);
  assert.doesNotMatch(html, /הצטרפות דרך הזמנה תעבוד כשהאפליקציה תתחבר לשרת/);
  assert.doesNotMatch(html, /הצטרפות תעבוד כשהשרת יחובר/);
  assert.doesNotMatch(html, /דורש חיבור לשרת/);
  // used by the invite note, the add-member note, the friends helper and the join notice
  assert.ok((html.match(/SERVER_NOTE/g) || []).length >= 5);
});

test('the QR placeholder tile is gone, code and CSS alike', () => {
  assert.doesNotMatch(html, /games-invite-qr/);
  assert.doesNotMatch(html, /QR יופיע עם חיבור לשרת/);
});

// ---------- D3: member row actions behind a tap ----------

test('an admin member row is a button that expands an inline action strip', () => {
  const source = sourceBetween('  function renderMemberRow(member, activeList, isAdmin) {', '  function renderMemberActions(');
  assert.match(source, /setAttribute\("role", "button"\)/);
  assert.match(source, /setAttribute\("tabindex", "0"\)/);
  assert.match(source, /aria-expanded/);
  assert.match(source, /e\.key === "Enter" \|\| e\.key === " "/);
  assert.match(source, /memberActionsOpenId/);
});

test('the action strip carries promote/demote, the armed remove and the last-admin note', () => {
  const source = sourceBetween('  function renderMemberActions(', '  function renderMakeAdminButton(');
  assert.match(source, /games-card-details/); // shared grid-collapse pattern
  assert.match(source, /renderMakeAdminButton/);
  assert.match(source, /renderRemoveMemberButton/);
  assert.match(source, /renderRemoveAdminButton/);
  assert.match(source, /העבר ניהול לחבר אחר קודם/);
  assert.match(source, /isLastActiveAdmin/);
  assert.match(html, /function renderRemoveAdminButton\(member\) \{[\s\S]*?הסר ניהול/);
  assert.match(html, /demoteMember\(member\.groupId, member\.id\)/);
});

test('the open member row is UI-only state, reset on every view change', () => {
  assert.match(html, /let memberActionsOpenId = null;/);
  const source = sourceBetween('  function setAppView(nextView) {', '  function flashViewEnter');
  assert.match(source, /memberActionsOpenId = null;/);
});

test('member rows no longer show their actions unconditionally', () => {
  const source = sourceBetween('  function renderMemberRow(member, activeList, isAdmin) {', '  function renderMemberActions(');
  assert.doesNotMatch(source, /row\.appendChild\(renderMakeAdminButton/);
  assert.doesNotMatch(source, /row\.appendChild\(renderRemoveMemberButton/);
});

// ---------- D4: debt direction colour + one "ממתין לתשלום" wording ----------

test('debt amounts are coloured by direction and both lists read "ממתין לתשלום"', () => {
  const source = sourceBetween('  function renderDebtGroup(parent, title, debts, creditorView, showTitle = true) {', '  // Flat .debt-row-style rows');
  assert.match(source, /debt-amount" \+ \(creditorView \? " pos" : " neg"\)/);
  assert.match(source, /ממתין לתשלום/);
  assert.doesNotMatch(source, /"ממתין"/);
  const idx = html.indexOf('\n  .debt-amount.pos');
  assert.ok(idx >= 0, '.debt-amount.pos rule not found');
  assert.match(html.slice(idx, idx + 200), /var\(--accent\)/);
  assert.match(html.slice(idx, idx + 200), /var\(--bad\)/);
});

// ---------- mechanical design-review rows ----------

test('row 9: formatDuration puts a space between the number and its unit', () => {
  const context = loadPure();
  assert.equal(vm.runInContext('formatDuration(17)', context), '17 דק׳');
  assert.equal(vm.runInContext('formatDuration(125)', context), '2 שע׳ 5 דק׳');
  assert.equal(vm.runInContext('formatDuration(120)', context), '2 שע׳');
  assert.equal(vm.runInContext('formatDuration(0)', context), 'פחות מדקה');
});

test('rows 8 + 10: the profile uses formatPlayerCount and colours the best/worst night', () => {
  const source = sourceBetween('  function renderProfile() {', '  // Shared tail of "add a player to the open table"');
  assert.match(source, /formatPlayerCount\(g\.players\.length\)/);
  assert.doesNotMatch(source, /g\.players\.length \+ " שחקנים"/);
  assert.match(source, /"pval" \+ cls/);
  const idx = html.indexOf('\n  .pval.pos');
  assert.ok(idx >= 0, '.pval.pos rule not found');
});

test('row 11: debt dates use the same day + short month format as the rest of the app', () => {
  const source = sourceBetween('  function debtDateLabel(debt) {', '  function markDebtPaid(');
  assert.match(source, /\{ day: "numeric", month: "short" \}/);
  assert.doesNotMatch(source, /year: "2-digit"/);
});

test('row 12: the debts and friends tabs no longer repeat their tab name as a section title', () => {
  const source = sourceBetween('  function renderProfile() {', '  // Shared tail of "add a player to the open table"');
  assert.doesNotMatch(source, /el\("h2", "ptitle", "חובות"\)/);
  assert.doesNotMatch(source, /el\("h2", "ptitle", "חברים"\)/);
});

test('row 14: one section-title rule serves the dashboard, group page, profile and results', () => {
  assert.match(html, /\.games-section-title,\s*\.ptitle,\s*\.results h2,\s*\.debt-group h3 \{/);
  const idx = html.indexOf('.games-section-title,');
  const rule = html.slice(idx, html.indexOf('}', idx) + 1);
  assert.match(rule, /font-size: 13px/);
  assert.match(rule, /font-weight: 500/);
  assert.match(rule, /color: var\(--dim\)/);
  assert.match(rule, /margin: 0 0 10px/);
  assert.match(html, /\.games-section \{ margin-top: 24px;/);
  assert.match(html, /\.psection \{ margin-top: 24px;/);
});

test('row 15: the participant panel has a title, a live counter, and hides the primary CTA', () => {
  const source = sourceBetween('  function renderStartGamePanel() {', '  function renderStartGameMemberRow(');
  assert.match(source, /מי משחק\?/);
  assert.match(source, /group-start-counter/);
  const counter = sourceBetween('  function startGameCounterLabel(', '  function updateStartGameConfirmState() {');
  assert.match(counter, /נבחרו/);
  assert.match(counter, /מתוך/);
  const update = sourceBetween('  function updateStartGameConfirmState() {', '  function renderStartGameGuestsList(');
  assert.match(update, /group-start-counter/);
  const primary = sourceBetween('  function renderGroupPrimaryAction(summary, gate) {', '  function renderStartGamePanel() {');
  assert.match(primary, /btn\.hidden = startGameOpen/);
});

test('row 16: the exit panel labels its amount field, prefixes ₪ and offers a cancel action', () => {
  const source = sourceBetween('  function render() {', '  function renderDerived() {');
  assert.match(source, /כמה יצא איתו/);
  assert.match(source, /exit-currency/);
  assert.match(source, /exit-cancel/);
});

test('rows 19 + 20: neutral flat actions read --text, disabled ones --faint, and the balance stat is neutral', () => {
  const flat = html.indexOf('\n  .set-flat {');
  assert.ok(flat >= 0, '.set-flat rule not found');
  assert.match(html.slice(flat, html.indexOf('}', flat) + 1), /color: var\(--text\)/);
  const disabled = html.indexOf('\n  .set-flat:disabled {');
  assert.ok(disabled >= 0, '.set-flat:disabled rule not found');
  const disabledRule = html.slice(disabled, html.indexOf('}', disabled) + 1);
  assert.match(disabledRule, /color: var\(--faint\)/);
  assert.doesNotMatch(disabledRule, /opacity/);
  const derived = sourceBetween('  function renderDerived() {', '  // ---------- confetti');
  assert.match(derived, /statline .neutral|"neutral"/);
});

test('row 21: the join notice names the group, and offers "לא עכשיו" beside "המשך"', () => {
  assert.match(html, /id="joinNoticeGroup"/);
  assert.match(html, /לא עכשיו/);
  const boot = html.slice(html.indexOf('  // ---------- boot ----------'));
  assert.match(boot, /joinNoticeGroup/);
  assert.match(boot, /state\.invites/);
});

test('rows 25 + 27 + 30 + 34: nested ranking, anchored card head, plus-button touch area, settings icon', () => {
  const rank = html.indexOf('\n  .games-history-rank {');
  assert.ok(rank >= 0, '.games-history-rank rule not found');
  const rankRule = html.slice(rank, html.indexOf('}', rank) + 1);
  assert.match(rankRule, /padding-inline-start: 14px/);
  assert.match(rankRule, /color: var\(--dim\)/);

  const head = html.indexOf('\n  .games-group-head {');
  assert.ok(head >= 0, '.games-group-head rule not found');
  assert.match(html.slice(head, html.indexOf('}', head) + 1), /justify-content: flex-start/);

  assert.match(html, /\.btn-plus::before \{[^}]*inset: -3px/s);

  const settingsBtn = sourceBetween('  function renderGroupHeader(summary) {', '  // The group\'s own game has an active table');
  assert.match(settingsBtn, /<svg viewBox="0 0 24 24"/);
});

test('row 32: both inline panels share the title + full-width field + confirm/cancel pattern', () => {
  const create = sourceBetween('  function renderCreateGroupPanel(parent) {', '  function renderActiveGameCard(');
  assert.match(create, /קבוצה חדשה/);
  assert.match(create, /games-create-cancel/);
  const add = sourceBetween('  function renderAddMemberPanel() {', '  function toggleAddMemberPanel() {');
  assert.match(add, /חבר חדש/);
  assert.match(add, /games-create-cancel/);
  assert.match(html, /\.games-create-panel-content input\[type="text"\]/);
});

// ---------- motion: every new interactive element animates (Global Constraint 13) ----------

['.table-header', '.games-member-row[role="button"]', '.games-member-action', '.exit-cancel', '.group-start-counter']
  .forEach(cls => {
    test(`${cls} declares a transition, animation or :active press state`, () => {
      const idx = html.indexOf(cls);
      assert.ok(idx >= 0, `${cls} not found in the stylesheet`);
      assert.match(html.slice(idx, idx + 420), /transition|animation|:active/);
    });
  });

// ---------- round 2, batch 1: dashboard header (sync dot in the corner, settings gear, no title) ----------

test('the sync dot is never centered on the dashboard/group shell — same corner as on the profile', () => {
  assert.doesNotMatch(html, /\.games-view header \.eyebrow \{[^}]*justify-content: center/s);
  // the base eyebrow rule has no justify-content, so flex-start (inline start) is the only position
  const idx = html.indexOf('\n  .eyebrow {');
  assert.ok(idx >= 0, '.eyebrow base rule not found');
  assert.doesNotMatch(html.slice(idx, html.indexOf('}', idx)), /justify-content/);
  assert.match(html, /<div class="eyebrow"><span class="dot" id="syncDot"/);
});

test('the settings gear shows on primary non-game views, not on the group page or the table', () => {
  assert.match(html, /document\.getElementById\("settingsBtn"\)\.hidden = appView !== "profile" && appView !== "games" && appView !== "friends";/);
  assert.match(html, /document\.getElementById\("resetBtn"\)\.hidden = appView === "profile" \|\| appView === "friends" \|\| appView === "games" \|\| appView === "group";/);
  assert.match(html, /document\.getElementById\("settingsBtn"\)\.addEventListener\("click"/);
  // the group page keeps its own group-settings control in the page header
  const groupHeader = sourceBetween('  function renderGroupHeader(summary) {', '  // The group\'s own game has an active table');
  assert.match(groupHeader, /games-group-settings-btn/);
});

test('the isolated suit mark sits first in the safe-area-padded app shell and adapts to both themes', () => {
  const wrapStart = html.indexOf('<div class="wrap">');
  const markStart = html.indexOf('<div class="suits-mark" aria-hidden="true">', wrapStart);
  const headerStart = html.indexOf('<header class="load-in">', wrapStart);
  assert.ok(wrapStart >= 0 && markStart > wrapStart && headerStart > markStart, 'the mark should sit above the app header inside .wrap');
  const mark = html.slice(markStart, headerStart);
  assert.match(mark, /class="base-suit suit-spade"[\s\S]*class="accent-suit suit-diamond"[\s\S]*class="base-suit suit-club"[\s\S]*class="accent-suit suit-heart"/);
  assert.match(html, /\.suits-mark \{[^}]*justify-content: center[^}]*margin: 0 auto/s);
  assert.match(html, /\.suits-mark \.base-suit \{ color: var\(--text\); \}/);
  assert.match(html, /\.suits-mark \.accent-suit \{ color: var\(--accent\); \}/);
});

test('renderGamesDashboard has no big title: the lead line is first and the column clears the corner stack', () => {
  const source = sourceBetween('  function renderGamesDashboard() {', '  // Back arrow, 64px avatar');
  assert.doesNotMatch(source, /games-home-title/);
  assert.doesNotMatch(source, /"h2"/);
  assert.match(source, /el\("div", "games-home-in games-home-dash"\)/);
  assert.match(source, /inner\.appendChild\(el\("p", "games-home-lead", "המשחקים הפעילים והקבוצות שלך במקום אחד\."\)\);\s*renderQuickActions\(inner\);/);
  assert.doesNotMatch(html, /\.games-home-title/);
  // 52px: corner stack (theme 23px + 16px gap + gear 41px, from top 6px) ends at ~86px; the lead starts ~99px
  assert.match(html, /\.games-home-dash \{ padding-top: 52px; \}/);
  assert.match(html, /\.games-home-lead \{[^}]*margin: 0 0 26px;/);
  // the group page reuses .games-home-in but not the dashboard padding
  const group = sourceBetween('  function renderGroupPage() {', '  function renderAddRowChips() {');
  assert.match(group, /el\("div", "games-home-in"\)/);
  assert.doesNotMatch(group, /games-home-dash/);
});
