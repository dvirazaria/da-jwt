// Task 15 (games dashboard integration): regex-only checks against the raw source, matching the
// convention used by games-navigation.test.cjs and motion.test.cjs. These assert that the
// dashboard's group card reads the real GroupSummary shape (not the old stub's fields), that
// card expand/collapse and the archive toggle stay UI-only, that the "coming soon" leftovers are
// gone, and that the dashboard's card entrance stagger follows the same enterStagger pattern
// Task 18 established for the group page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + 1);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end >= 0, `missing ${endMarker}`);
  return html.slice(start, end);
}

const groupCardSource = sourceBetween('  function renderGroupCard(group, actions) {', '  function renderGroupsSection(');

// ---------- renderGroupCard reads the real GroupSummary shape ----------

test('renderGroupCard reads hasActiveGame/activeGamePhase/gameCount/lastGameAt/leaderNames from GroupSummary', () => {
  assert.match(groupCardSource, /group\.hasActiveGame/);
  assert.match(groupCardSource, /group\.activeGamePhase/);
  assert.match(groupCardSource, /group\.gameCount/);
  assert.match(groupCardSource, /group\.lastGameAt/);
  assert.match(groupCardSource, /group\.leaderNames/);
});

test('renderGroupCard no longer reads the old stub fields, or a raw group.id fallback (GroupSummary has no .id)', () => {
  assert.doesNotMatch(groupCardSource, /group\.lastGame\b/);
  assert.doesNotMatch(groupCardSource, /group\.leader\b/);
  assert.doesNotMatch(groupCardSource, /group\.topPlayers\b/);
  assert.doesNotMatch(groupCardSource, /group\.id\b/);
});

test('renderGroupsSection and renderArchivedGroupsSection key cards by group.groupId only', () => {
  const sectionsSource = sourceBetween('  function renderGroupsSection(', '  function closeArchivedGroups()');
  assert.doesNotMatch(sectionsSource, /group\.id\b/);
  assert.match(sectionsSource, /group\.groupId/);
});

// ---------- group card status: active vs. settlement, with the shared accent-dot class ----------

test('the group card status text distinguishes an active game from one in settlement, reusing the accent-dot class', () => {
  assert.match(groupCardSource, /group\.activeGamePhase === "settlement"/);
  assert.match(groupCardSource, /"games-card-status"/);
  assert.match(groupCardSource, /בסגירה/);
  assert.match(groupCardSource, /משחק פעיל/);
});

// ---------- expand snapshot: truncated members, gameCount, short date, first leader only ----------

test('the expand snapshot truncates members like formatPlayerNames, shows gameCount, a short last-game date, and only the first leader name', () => {
  assert.match(groupCardSource, /formatPlayerNames\(memberNames\)/);
  assert.match(groupCardSource, /"משחקים · " \+ group\.gameCount/);
  assert.match(groupCardSource, /formatShortGameDate\(group\.lastGameAt\)/);
  assert.match(groupCardSource, /"מוביל · " \+ leaderNames\[0\]/);
  assert.doesNotMatch(groupCardSource, /leaderNames\.join/);
  assert.doesNotMatch(groupCardSource, /group\.members\.join/);
});

// ---------- games-card-toggle label reflects open/closed state (C4) ----------

test('the active-game card toggle label is "כווץ" when expanded and "הרחב" when collapsed', () => {
  const activeCardSource = sourceBetween('  function renderActiveGameCard(summary, actions) {', '  function renderActiveGamesSection(');
  assert.match(activeCardSource, /actions\.expanded \? "כווץ" : "הרחב"/);
});

test('the group card toggle label is "כווץ" when expanded and "הרחב" when collapsed', () => {
  assert.match(groupCardSource, /actions\.expanded \? "כווץ" : "הרחב"/);
});

// ---------- quick actions: "+ צור קבוצה" leads as the primary capsule ----------

test('quick actions lead with the create-group action as the primary capsule; the ungrouped-game action is secondary', () => {
  const source = sourceBetween('  function renderQuickActions(parent) {', '  function renderCreateGroupPanel(');
  const createIdx = source.indexOf('+ צור קבוצה');
  const startIdx = source.indexOf('משחק ללא קבוצה');
  assert.ok(createIdx >= 0 && startIdx >= 0, 'both quick actions should be present');
  assert.ok(createIdx < startIdx, '"+ צור קבוצה" should be built (and appended) before "משחק ללא קבוצה"');
  assert.match(source, /"games-quick-action primary",\s*"\+ צור קבוצה"/);
  assert.doesNotMatch(source, /"games-quick-action primary",\s*"משחק ללא קבוצה"/);
  // both handlers stay wired regardless of order
  assert.match(source, /toggleCreateGroupPanel/);
  assert.match(source, /startUngroupedGame/);
});

// ---------- expandedGroupCards/expandedGameCards/archive toggle never call save() ----------

test('the dashboard region never calls save() from card expand/collapse or the archive toggle', () => {
  const dashboardSource = sourceBetween(
    '  function renderActiveGamesSection(parent, summaries, enterStagger) {',
    '  function renderGroupHeader(summary) {'
  );
  assert.doesNotMatch(dashboardSource, /\bsave\(\)/);
});

// ---------- dead code: the old "coming soon" placeholder is fully gone ----------

test('the dashboard has no leftover "coming soon" CSS or copy', () => {
  assert.doesNotMatch(html, /games-coming-soon/);
  assert.doesNotMatch(html, /בקרוב/);
});

// ---------- motion: dashboard cards stagger in only right after a navigation ----------

test('dashboard cards stagger in only right after a navigation, not on every in-place re-render (mirrors groupPageEnterNext)', () => {
  assert.match(html, /let gamesPageEnterNext = false;/);
  const setAppViewSource = sourceBetween('  function setAppView(nextView) {', '  function flashViewEnter');
  assert.match(setAppViewSource, /gamesPageEnterNext\s*=\s*nextView === "games"/);
  const dashboardSource = sourceBetween('  function renderGamesDashboard()', '  function renderGroupHeader(summary) {');
  assert.match(dashboardSource, /const enterStagger = gamesPageEnterNext;/);
  assert.match(dashboardSource, /gamesPageEnterNext = false;/);
  assert.match(dashboardSource, /renderActiveGamesSection\(inner, getActiveGameSummaries\(state, state\.groups\), enterStagger\)/);
  assert.match(dashboardSource, /renderGroupsSection\(inner, getGroupSummaries\(collectionsOf\(state\), me\), enterStagger\)/);
});

test('active-game and group cards accept an anim/animDelay pair to drive the entrance stagger', () => {
  const activeCardSource = sourceBetween('  function renderActiveGameCard(summary, actions) {', '  function renderActiveGamesSection(');
  assert.match(activeCardSource, /actions\.anim/);
  assert.match(activeCardSource, /actions\.animDelay/);
  assert.match(groupCardSource, /actions\.anim/);
  assert.match(groupCardSource, /actions\.animDelay/);
});
