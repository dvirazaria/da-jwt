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
    const idx = styleBlock.indexOf(cls);
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
