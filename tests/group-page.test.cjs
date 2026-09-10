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

// ---------- toGroupGameSummary (pure) ----------

function historyEntryFixture() {
  return {
    gameId: 'g1',
    at: '2026-09-07T22:00:00.000Z',
    startedAt: '2026-09-07T20:00:00.000Z',
    isBalanced: true,
    players: [
      { id: 'p1', name: 'דביר', entryLog: [{ id: 'e1' }, { id: 'e2' }], buyin: 100, cashout: 150, net: 50 },
      { id: 'p2', name: 'יוסי', entryLog: [{ id: 'e3' }], buyin: 100, cashout: 150, net: 50 },
      { id: 'p3', name: 'רותם', entryLog: [{ id: 'e4' }], buyin: 100, cashout: 0, net: -100 },
    ],
  };
}

test('toGroupGameSummary carries gameId/at/startedAt/isBalanced and derives playerCount/playerNames', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(historyEntryFixture())})`, context);
  assert.equal(summary.gameId, 'g1');
  assert.equal(summary.at, '2026-09-07T22:00:00.000Z');
  assert.equal(summary.startedAt, '2026-09-07T20:00:00.000Z');
  assert.equal(summary.isBalanced, true);
  assert.equal(summary.playerCount, 3);
  assert.deepEqual(summary.playerNames, ['דביר', 'יוסי', 'רותם']);
});

test('toGroupGameSummary winnerNames includes every tied top-net player', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(historyEntryFixture())})`, context);
  // דביר and יוסי both net +50, the max — both are winners; רותם (net -100) is not.
  assert.deepEqual(summary.winnerNames, ['דביר', 'יוסי']);
});

test('toGroupGameSummary potSize sums player buyin, totalEntries sums entryLog lengths', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(historyEntryFixture())})`, context);
  assert.equal(summary.potSize, 300); // 100 + 100 + 100
  assert.equal(summary.totalEntries, 4); // 2 + 1 + 1
});

test('toGroupGameSummary never exposes a per-player net or cashout field', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(historyEntryFixture())})`, context);
  const forbidden = ['net', 'cashout', 'players'];
  assert.deepEqual(Object.keys(summary).filter(k => forbidden.includes(k)), []);
});

test('toGroupGameSummary handles a missing/empty entry safely', () => {
  const context = loadPure();
  const summary = runJSON(`toGroupGameSummary(null)`, context);
  assert.equal(summary.playerCount, 0);
  assert.deepEqual(summary.playerNames, []);
  assert.deepEqual(summary.winnerNames, []);
  assert.equal(summary.potSize, 0);
  assert.equal(summary.totalEntries, 0);
  assert.equal(summary.isBalanced, false);
});

// ---------- formatMemberCount (pure) ----------

const formatSource = sourceBetween('  function formatPlayerCount(count) {', '  function renderQuickActions(parent) {');

function loadFormat() {
  const context = vm.createContext({});
  vm.runInContext(formatSource, context);
  return context;
}

test('formatMemberCount uses the singular for exactly one member', () => {
  const context = loadFormat();
  assert.equal(vm.runInContext('formatMemberCount(1)', context), 'חבר אחד');
});

test('formatMemberCount uses the plural with a count for zero or many members', () => {
  const context = loadFormat();
  assert.equal(vm.runInContext('formatMemberCount(0)', context), '0 חברים');
  assert.equal(vm.runInContext('formatMemberCount(3)', context), '3 חברים');
});

// ---------- wiring: renderGroupPage composes the five sub-renderers ----------
// (Task 11 removed the separate "last game" section: it was fully redundant with the first
// row of the now-unlimited history list, which shows the same date/players/winner line.)

test('renderGroupPage calls each of the five sub-renderers', () => {
  const source = sourceBetween('  function renderGroupPage() {', '  function render() {');
  assert.match(source, /renderGroupHeader\(summary\)/);
  assert.match(source, /renderGroupPrimaryAction\(summary, canStartGroupGame\(/);
  // Group leaderboard/history now read the safe server aggregate (group_leaderboard_public_v /
  // group_game_summaries_v) when this pull fetched one, falling back to buildLeaderboard /
  // groupClosedGames+toGroupGameSummary exactly as before when it did not (offline, or the
  // aggregate SQL not yet applied) — see resolveGroupLeaderboard/resolveGroupGameSummaries.
  assert.match(source, /renderGroupLeaders\(resolveGroupLeaderboard\(/);
  assert.match(source, /renderGroupMembers\(summary, activeMembers\(/);
  assert.match(source, /renderGroupHistory\(gameSummaries\)/);
  assert.doesNotMatch(source, /renderGroupLastGame/);
  // bails out to the dashboard rather than stranding the user on a deleted group
  assert.match(source, /if \(!summary\) \{ setAppView\("games"\); return; \}/);
});

test('renderGroupPage builds game summaries through resolveGroupGameSummaries (aggregate-or-local)', () => {
  const source = sourceBetween('  function renderGroupPage() {', '  function render() {');
  assert.match(source, /resolveGroupGameSummaries\(collections, currentGroupId, cloudGroupAggregates\)/);
});

// ---------- wiring: renderGroupPrimaryAction ----------

test('the primary action reads summary.hasActiveGame and summary.activeGamePhase to choose its label', () => {
  const source = sourceBetween('  function renderGroupPrimaryAction(summary, gate) {', '  function renderGroupLeaders(');
  assert.match(source, /summary\.hasActiveGame/);
  assert.match(source, /summary\.activeGamePhase === "settlement"/);
  assert.match(source, /כנס לשולחן/);
  assert.match(source, /המשך סגירה/);
  assert.match(source, /continueCurrentGame/);
});

test('the primary action renders "התחל משחק" disabled with the right quiet reason per gate.reason', () => {
  const source = sourceBetween('  function renderGroupPrimaryAction(summary, gate) {', '  function renderGroupLeaders(');
  assert.match(source, /התחל משחק/);
  assert.match(source, /btn\.disabled = true/);
  assert.match(source, /aria-disabled/);
  assert.match(source, /יש כבר משחק פתוח בקבוצה/);
  assert.match(source, /יש משחק פעיל אחר/);
  assert.match(source, /הקבוצה בארכיון/);
});

// ---------- wiring: history owns the empty state, shows every game ----------

test('renderGroupHistory owns the "no games yet" empty state and does not cap the list', () => {
  const source = sourceBetween('  function renderGroupHistory(gameSummaries) {', '  function renderGroupInvite(');
  assert.match(source, /עוד אין משחקים/);
  assert.doesNotMatch(source, /\.slice\(0, 5\)/);
});

// group-modal-polish (owner ask #2): a pre-first-game leaderboard used to show a placeholder
// line ("הדירוג יופיע אחרי המשחק הראשון") in a de-emphasised section. The owner asked for no
// explanatory line at all while it's empty — rewritten to assert the copy is gone (stronger than
// the old "assert it's there"), while still keeping the "full list, uncapped" half of this test.
test('renderGroupLeaders renders nothing before the first game (no heading, no placeholder line) and the full list uncapped once there is one', () => {
  const source = sourceBetween('  function renderGroupLeaders(entries) {', '  function renderGroupMembers(');
  assert.match(source, /if \(!list\.length\) return null;/);
  assert.doesNotMatch(source, /הדירוג יופיע אחרי המשחק הראשון/, 'the placeholder copy must be gone entirely, not just quieter');
  assert.doesNotMatch(source, /\.slice\(0, 3\)/);
});

// ---------- the group card also uses formatMemberCount (fixes "1 חברים") ----------

test('renderGroupCard formats its member count with formatMemberCount, not a raw concatenation', () => {
  const source = sourceBetween('  function renderGroupCard(group, actions) {', '  function renderGroupsSection(');
  assert.match(source, /formatMemberCount\(Number\(group\.memberCount \|\| 0\)\)/);
  assert.doesNotMatch(source, /\+ " חברים"/);
});

// ---------- group page as a sheet over the dashboard ----------

test('renderGroupPage renders into the #groupSheet overlay, not into #gamesHome (which it used to replace)', () => {
  const source = sourceBetween('  function renderGroupPage() {', '  function syncGroupSheet() {');
  assert.match(source, /document\.getElementById\("groupSheetContent"\)/);
  assert.doesNotMatch(source, /document\.getElementById\("gamesHome"\)/);
  // the currentGroupId/appView route contract itself is untouched by the presentation change
  assert.match(source, /if \(appView !== "group"\) return;/);
});

test('openGroup keeps setting currentGroupId and calling setAppView("group") unchanged by the sheet presentation', () => {
  const source = sourceBetween('  function openGroup(groupId) {', '  function repairMyGroupMembership(');
  assert.match(source, /currentGroupId = String\(groupId \|\| ""\);/);
  assert.match(source, /repairMyGroupMembership\(currentGroupId\);/);
  assert.match(source, /setAppView\("group"\);/);
});

test('the group route is a real overlay (#groupSheet/#groupSheetContent markup) that syncGroupSheet opens/closes off appView, reversing the transition before hiding', () => {
  assert.match(html, /<div class="group-sheet" id="groupSheet" role="dialog" aria-modal="true" aria-label="[^"]*" hidden>/);
  assert.match(html, /<div class="group-sheet-panel">/);
  assert.match(html, /<div class="group-sheet-in" id="groupSheetContent"><\/div>/);
  const source = sourceBetween('  function syncGroupSheet() {', '  function renderAddRowChips() {');
  assert.match(source, /if \(appView === "group"\)/);
  assert.match(source, /backdrop\.classList\.add\("open"\)/);
  // closing (any navigation away from "group", including the default back-arrow's setAppView("games")
  // in renderGroupHeader) removes .open first and only hides the sheet after the reverse transition
  assert.match(source, /backdrop\.classList\.remove\("open"\)/);
  assert.match(source, /backdrop\.hidden = true/);
});

test('the group modal is centred and capped, not edge-anchored to the bottom of the viewport', () => {
  const backdrop = html.match(/\.group-sheet \{[^}]*\}/)[0];
  const panel = html.match(/\.group-sheet-panel \{[^}]*\}/)[0];
  // Centred flex layout with padding on every side, so the dimmed dashboard stays visible all
  // the way around the dialog instead of it filling the screen edge-to-edge.
  assert.match(backdrop, /display: flex; align-items: center; justify-content: center;/);
  assert.match(backdrop, /padding: max\(24px,/, 'margin on every side of the backdrop');
  // No bottom-sheet leftovers: not absolutely anchored to an edge, no "starts N vh down" rule,
  // no one-sided radius, no off-screen starting transform.
  assert.doesNotMatch(panel, /position: absolute/);
  assert.doesNotMatch(panel, /bottom: 0/);
  assert.doesNotMatch(panel, /top: max\(/);
  assert.doesNotMatch(panel, /border-radius: \d+px \d+px 0 0/);
  assert.doesNotMatch(panel, /translateY\(100%\)/);
  // Bounded on both axes with internal scroll for anything that doesn't fit.
  assert.match(panel, /max-width: 440px/);
  assert.match(panel, /max-height: min\(/);
  assert.match(panel, /overflow-y: auto/);
  assert.match(panel, /border-radius: 20px;/, 'rounded on all four corners, not just the top');
  // The grabber was a sheet-only affordance — gone along with the sheet.
  assert.doesNotMatch(html, /\.group-sheet-panel::before/);
});

test('the modal scales+fades in on the app\'s existing .28s timing, not the old iOS-sheet slide', () => {
  const panel = html.match(/\.group-sheet-panel \{[^}]*\}/)[0];
  assert.match(panel, /transform: scale\(\.96\)/);
  assert.match(panel, /opacity: 0;/);
  assert.match(panel, /transition: transform \.28s ease, opacity \.28s ease;/);
  assert.doesNotMatch(panel, /cubic-bezier/, 'the iOS sheet easing is retired with the sheet');
  assert.match(html, /\.group-sheet\.open \.group-sheet-panel \{ transform: scale\(1\); opacity: 1; \}/);
});

test('the close control is an X pinned to the top-right (inline-start) of the modal, settings to the top-left (inline-end), both 44px targets with aria-labels', () => {
  const header = sourceBetween('  function renderGroupHeader(summary, onBack, onSettings) {', '  // The group\'s own game has an active table');
  // RTL: inset-inline-start is the physical right edge, inset-inline-end is the physical left —
  // "top-right"/"top-left" as the owner sees them, not a directional guess.
  assert.match(header, /back\.setAttribute\("aria-label", "סגור"\)/);
  assert.match(header, /<path d="M6 6l12 12M18 6L6 18">/, 'an X glyph, not the old back chevron');
  assert.doesNotMatch(header, /M9 5l7 7-7 7/, 'the chevron path must be gone from this header');
  assert.match(header, /settingsBtn\.setAttribute\("aria-label", "הגדרות קבוצה"\)/);
  const cornerCss = html.match(/\.games-group-header \.back-arrow, \.games-group-header \.games-group-settings-btn \{[^}]*\}/)[0];
  assert.match(cornerCss, /min-width: 44px; min-height: 44px;/);
  assert.match(html, /\.games-group-header \.back-arrow \{ inset-inline-start: 8px; \}/);
  assert.match(html, /\.games-group-header \.games-group-settings-btn \{ inset-inline-end: 8px; \}/);
});

test('the settings corner control drops its text label at this size — icon-only, matching the X as a pair', () => {
  const header = sourceBetween('  function renderGroupHeader(summary, onBack, onSettings) {', '  // The group\'s own game has an active table');
  assert.doesNotMatch(header, /appendChild\(el\("span", "", "הגדרות"\)\)/);
});

// Superseded by group-modal-polish: the owner asked for *no* explanatory line while the
// leaderboard is empty, which meant dropping the de-emphasised placeholder section itself, not
// just its weight — including the "דירוג" heading (a heading over nothing is still clutter). This
// is deliberately the opposite assertion of what stood here before ("keeps its copy... not
// removed"); the old .games-section-empty weight class is retired with the section it modified,
// so both call sites (renderGroupPreview, renderGroupPage) now guard a possibly-null result.
test('an empty leaderboard is not removed-and-forgotten — it renders nothing, section and heading included, and both call sites guard the null', () => {
  const source = sourceBetween('  function renderGroupLeaders(entries) {', '  function renderGroupMembers(');
  assert.doesNotMatch(source, /games-section-empty/);
  assert.doesNotMatch(source, /הדירוג יופיע אחרי המשחק הראשון/);
  assert.doesNotMatch(html, /games-section\.games-section-empty/, 'the now-unused weight-reduction rule must not linger as dead CSS');
  assert.match(html, /const leaders = renderGroupLeaders\(resolveGroupLeaderboard\(collections, currentGroupId, cloudGroupAggregates\)\);\s*\n\s*if \(leaders\) inner\.appendChild\(leaders\);/);
});

test('the reduced-motion rule stays the very last rule in the stylesheet, after the new group modal CSS', () => {
  const groupSheetIdx = html.indexOf('.group-sheet {');
  const reducedMotionIdx = html.indexOf('@media (prefers-reduced-motion: reduce)');
  const styleCloseIdx = html.indexOf('</style>');
  assert.ok(groupSheetIdx > 0, 'group-sheet CSS should exist');
  assert.ok(reducedMotionIdx > groupSheetIdx, 'reduced-motion rule should come after the group modal CSS');
  const tail = html.slice(html.indexOf('{', reducedMotionIdx), styleCloseIdx);
  assert.match(tail, /\* \{ animation: none !important; transition: none !important; \}\s*\}\s*$/);
});

// ---------- the modal must still animate open/closed through the existing safe pattern ----------

test('both group surfaces still open through afterNextFrame, and close by reversing the transition before hiding', () => {
  // Adding .open in the same frame as the unhide gives the transition no start value, so the
  // modal would just appear. Both surfaces must wait two frames.
  for (const fn of ['openGroupPreview', 'syncGroupSheet', 'pressThenOpen']) {
    const body = html.slice(html.indexOf('function ' + fn));
    assert.match(body.slice(0, 900), /afterNextFrame\(/, fn + ' must defer through afterNextFrame');
  }
  // rAF is paused in a hidden tab: gating a tap on it alone means the tap does nothing there.
  const helper = html.slice(html.indexOf('function afterNextFrame'), html.indexOf('function afterNextFrame') + 400);
  assert.match(helper, /requestAnimationFrame\(\(\) => requestAnimationFrame\(/);
  assert.match(helper, /setTimeout\(run, 60\)/, 'a timer must back up rAF so the action always lands');
  // Closing plays the exit before hiding.
  const close = html.slice(html.indexOf('function closeGroupPreview'), html.indexOf('function closeGroupPreview') + 700);
  assert.match(close, /classList\.remove\("open"\)/);
  assert.match(close, /setTimeout/);
});

// ---------- a modal must have more than one way out, and it must keep it reachable ----------

test('the group modal cannot trap the reader: pinned corner controls, Escape, backdrop, focus', () => {
  // The X is absolutely positioned inside .games-group-header. Left in the panel's scroll flow it
  // rides away with the content, and it is the only dismissal control in the header.
  const header = html.match(/\.group-sheet-panel \.games-group-header \{[^}]*\}/)[0];
  assert.match(header, /position: sticky/, 'the header carrying the X must not scroll out of reach');
  assert.match(header, /background: var\(--bg\)/, 'a pinned header needs an opaque backing');

  // Two more exits, because one control can always be missed.
  assert.match(html, /function dismissOpenGroupModal\(\)/);
  assert.match(html, /if \(e\.key === "Escape"\) dismissOpenGroupModal\(\)/);
  assert.match(html, /if \(e\.target === backdrop\) dismissOpenGroupModal\(\)/,
    'only a click on the backdrop itself may dismiss — never one that started inside the panel');
  // The settings overlay sits above the modal and must consume Escape first.
  assert.match(html, /groupSettings[\s\S]{0,200}if \(e\.key === "Escape"\)/);

  // Focus has to enter the dialog, or a keyboard user is left on the dimmed page behind it.
  assert.match(html, /const close = overlay\.querySelector\("\.back-arrow"\)/);
  for (const id of ['groupPreview', 'groupSheet']) {
    assert.match(html, new RegExp(`id="${id}" role="dialog" aria-modal="true"`), `${id} needs dialog semantics`);
  }
});

test('the modal reads as a distinct surface in the dark theme, where panel and scrim share a colour', () => {
  // --bg is #05070A and the scrim used to be rgba(5,7,10,.6) — the identical colour, so the only
  // separation was a black shadow on a near-black ground, i.e. none.
  const backdrop = html.match(/\.group-sheet \{[^}]*\}/)[0];
  const scrim = backdrop.match(/background: (rgba\([^)]*\))/)[1];
  assert.doesNotMatch(scrim, /5\s*,\s*7\s*,\s*10/, 'the scrim must not be the panel colour');
  const panel = html.match(/\.group-sheet-panel \{[^}]*\}/)[0];
  assert.match(panel, /border: 1px solid var\(--line\)/, 'a hairline carries the edge a shadow cannot');
});
