// Task 18 (motion pass): regex-only checks against the raw source. These don't execute any
// animation — they assert the CSS/JS wiring the motion pass requires stays in place:
// the reduced-motion guard remains the last rule, the new interactive classes declare a
// transition or :active press state, and the panels that are supposed to reuse the shared
// grid-collapse pattern (.games-create-panel / .games-card-details) actually do.
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

const styleStart = html.indexOf('<style>');
const styleEnd = html.indexOf('</style>') + '</style>'.length;
assert.ok(styleStart >= 0 && styleEnd > styleStart, 'missing <style> block');
const styleBlock = html.slice(styleStart, styleEnd);

test('the reduced-motion guard is the last rule in the stylesheet', () => {
  // Nothing but whitespace may sit between the guard's closing brace and </style>.
  assert.match(
    styleBlock,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\* \{ animation: none !important; transition: none !important; \}\s*\}\s*<\/style>/,
    'the @media (prefers-reduced-motion: reduce) block must be the final rule before </style>'
  );
});

test('no animation: declaration appears after the reduced-motion guard', () => {
  const guardIdx = styleBlock.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(guardIdx >= 0, 'reduced-motion guard not found');
  const guardClose = styleBlock.indexOf('}', styleBlock.indexOf('}', guardIdx) + 1); // the guard's own closing brace (media block's outer brace)
  const after = styleBlock.slice(guardClose + 1);
  assert.doesNotMatch(after, /animation\s*:/, 'an animation: declaration was found after the reduced-motion guard');
});

// Every new interactive class the motion pass touches must declare either a transition or an
// :active press state somewhere near its own rule (not merely inherited from the bare `button`
// element selector), so a reduced-motion audit or a future refactor can find it by class name.
const classesNeedingMotion = [
  '.games-quick-action',   // dashboard quick actions ("משחק ללא קבוצה" / "+ צור קבוצה")
  '.games-card-toggle',    // "הרחב" expand toggle on active-game/group cards
  '.exit-toggle',          // "יציאה" row action
  '.group-start-confirm',  // start-game participant panel's "פתח שולחן" confirm button
  '.games-invite-action',  // invite "העתק קישור" / "שתף" buttons
  '.games-member-remove',  // member row's armed "הסר" action
];
classesNeedingMotion.forEach(cls => {
  test(`${cls} declares a transition or :active rule`, () => {
    const idx = styleBlock.indexOf(`${cls} {`);
    assert.ok(idx >= 0, `${cls} not found in the stylesheet`);
    const nearby = styleBlock.slice(idx, idx + 400);
    assert.match(nearby, /transition|:active/, `${cls} should declare a transition or an :active press state near its rule`);
  });
});

test('.games-create-panel uses the shared grid-collapse pattern', () => {
  const idx = styleBlock.indexOf('.games-create-panel {');
  assert.ok(idx >= 0, '.games-create-panel base rule not found');
  const rule = styleBlock.slice(idx, styleBlock.indexOf('}', idx));
  assert.match(rule, /grid-template-rows/, '.games-create-panel should collapse via grid-template-rows');
});

test('exit controls use the destructive red treatment and keep 44px touch targets', () => {
  const toggleIdx = styleBlock.indexOf('.exit-toggle {');
  assert.ok(toggleIdx >= 0, '.exit-toggle base rule not found');
  const toggleRule = styleBlock.slice(toggleIdx, styleBlock.indexOf('}', toggleIdx));
  assert.match(toggleRule, /min-height:\s*44px/, 'exit toggle keeps a 44px touch target');
  assert.match(toggleRule, /color:\s*var\(--bad\)/, 'exit toggle is visibly destructive before hover');

  const confirmIdx = styleBlock.indexOf('.exit-confirm {');
  assert.ok(confirmIdx >= 0, '.exit-confirm base rule not found');
  const confirmRule = styleBlock.slice(confirmIdx, styleBlock.indexOf('}', confirmIdx));
  assert.match(confirmRule, /min-height:\s*44px/, 'exit confirmation keeps a 44px touch target');
  assert.match(confirmRule, /border-color:\s*var\(--bad\).*color:\s*var\(--bad\)/, 'exit confirmation matches the destructive action');
});

test('finish and force-close holds sweep from the RTL inline start and release quickly', () => {
  const fill = sourceBetween('  .btn-close-table::before {', '  .finish-game-hint {');
  assert.match(fill, /transform:\s*scaleX\(0\)/, 'the resting fill is collapsed with scaleX');
  assert.match(fill, /transform-origin:\s*right center/, 'the sweep starts at inline-start in RTL');
  assert.match(fill, /transition:\s*transform \.18s ease-out/, 'an early release retracts quickly');
  assert.match(fill, /\.btn-close-table\.hold-state\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*color:\s*var\(--accent\)/s, 'the active hold keeps the turquoise affordance');
  assert.match(fill, /\.btn-close-table\.hold-state::before\s*\{[^}]*transform:\s*scaleX\(1\)[^}]*transition:\s*transform 1s linear/s, 'a continuous hold fills for one second');
  assert.match(fill, /\.btn-close-table\.hold-state:active\s*\{[^}]*scale\(\.98\)/s, 'the long-press feedback avoids the generic deep button shrink');
});

test('background-changing hover rules are gated to real hover devices', () => {
  const hoverMedia = sourceBetween('  @media (hover: hover) {', '  /* iOS cannot be locked to portrait');
  [
    '.btn-close-table:hover',
    '.btn-close-table.warn-state:hover',
    '.btn-close-table.blocked-state:hover',
    '.btn-close-table.force-state:hover',
    '.btn-close-table.hold-state:hover',
    '.exit-confirm:hover',
    '.games-quick-action.primary:hover',
    '.games-card-enter:hover',
    '.games-create-submit:hover',
    '.btn-primary:hover',
    '.btn-primary:disabled:hover',
    '.games-invite-create:hover',
  ].forEach(selector => assert.ok(hoverMedia.includes(selector), `${selector} should be inside hover media`));
  const outsideHoverMedia = styleBlock.replace(hoverMedia, '');
  assert.doesNotMatch(outsideHoverMedia, /\.btn-close-table(?:\.[\w-]+)?:hover/, 'close-table hover must never apply to touch-only devices');
});

test('both one-second holds show the completed fill before acting', () => {
  const source = sourceBetween('  let closeHoldTimer = null;', '  function finishCloseTable() {');
  assert.match(source, /let finishGameCompletionTimer = null;/);
  assert.match(source, /let closeHoldCompletionTimer = null;/);
  assert.match(source, /let closeHoldAwaitingRelease = false;/);
  assert.match(source, /finishGameCompletionTimer = setTimeout\([\s\S]*?finishGame\(\);[\s\S]*?60\);/);
  assert.match(source, /closeHoldCompletionTimer = setTimeout\([\s\S]*?forceCloseUnlocked = true;[\s\S]*?60\);/);
  assert.match(source, /if \(finishGameHoldTimer\) clearFinishGameHold\(\);/, 'release only cancels before the threshold');
  assert.match(source, /if \(closeHoldTimer\) clearCloseHold\(\);/, 'release only cancels before the threshold');
  assert.match(source, /closeHoldTimer = null;\s*closeHoldAwaitingRelease = true;\s*closeHoldCompletionTimer = setTimeout/, 'the release guard is armed exactly when the hold threshold is reached');
  assert.match(source, /else if \(closeHoldAwaitingRelease\) \{\s*if \(e\.type === "pointerup"\) longPressJustUnlocked = true;\s*closeHoldAwaitingRelease = false;/, 'only the native click following the completed hold is swallowed');
});

test('the start-game participant panel reuses .games-create-panel for its collapse animation', () => {
  const source = sourceBetween('  function renderStartGamePanel', '  function renderStartGameMemberRow');
  assert.match(source, /"games-create-panel"/, 'renderStartGamePanel should build a .games-create-panel element');
});

test('group history rows expand their ranking via .games-card-details (grid collapse)', () => {
  const cssIdx = styleBlock.indexOf('.games-card-details {');
  assert.ok(cssIdx >= 0, '.games-card-details base rule not found');
  const rule = styleBlock.slice(cssIdx, styleBlock.indexOf('}', cssIdx));
  assert.match(rule, /grid-template-rows/, '.games-card-details should collapse via grid-template-rows');

  const source = sourceBetween('  function renderGroupHistoryRow', '  function renderGroupHistory(');
  assert.match(source, /"games-card-details"/, 'renderGroupHistoryRow should build its ranking details via .games-card-details');
});

test('group page sections stagger in only right after a navigation, not on every in-place re-render', () => {
  assert.match(html, /let groupPageEnterNext = false;/, 'a dedicated flag should gate the group page section stagger');
  const setAppViewSource = sourceBetween('  function setAppView(nextView) {', '  function flashViewEnter');
  assert.match(setAppViewSource, /groupPageEnterNext\s*=\s*nextView === "group"/, 'setAppView should arm the stagger only when navigating to the group view');
  const openGroupSource = sourceBetween('  function openGroup(', '  // Creates a group and its creator admin membership');
  assert.match(openGroupSource, /setAppView\("group"\)/, 'openGroup() should navigate through setAppView so the stagger gets armed');
  const renderGroupPageSource = sourceBetween('  function renderGroupPage()', '  function render() {');
  assert.match(renderGroupPageSource, /const enterStagger = groupPageEnterNext;/, 'renderGroupPage should consume the flag once per call');
  assert.match(renderGroupPageSource, /groupPageEnterNext = false;/, 'renderGroupPage should reset the flag so in-place re-renders do not replay the stagger');
});

test('view switches in setAppView flash the container that becomes visible', () => {
  const source = sourceBetween('  function setAppView(nextView) {', '  function startUngroupedGame() {');
  assert.match(source, /flashViewEnter/, 'setAppView should trigger the shared view-enter flash');
  const flashSource = sourceBetween('  function flashViewEnter', '  function startUngroupedGame() {');
  assert.match(flashSource, /"load-in"/, 'flashViewEnter should reuse the existing .load-in entrance class');
  assert.match(flashSource, /animationend/, 'flashViewEnter should remove the class again on animationend');
});
