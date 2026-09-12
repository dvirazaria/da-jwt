// Tab bar vertical drift on iOS Safari (docs/superpowers/tabbar-position-report.md).
//
// Symptom: `.tabbar` sat at a different height on a short screen (friends, never scrolls) than
// on a long/scrollable one (games) on the same iPhone, seconds apart. `.tabbar-in { height: 44px }`
// / `.tab { height: 100% }` (an earlier fix) pin the bar's HEIGHT and are not the bug here; what
// moved was its POSITION.
//
// Measuring at a 390x844 mobile viewport (see the report for the exact rects) ruled out the two
// classic causes: the `.load-in` rise animation is set once in the static <nav> markup and never
// re-toggled by any script (so the bar cannot be caught mid-animation on a later render), and none
// of `.tabbar`'s ancestors (`html`, `body`, `.wrap`) declare a transform/filter/backdrop-filter/
// contain/will-change that would give `position: fixed` a containing block other than the
// viewport. Both are pinned below as regression guards.
//
// The actual cause: `env(safe-area-inset-bottom)` is not a fixed constant on iOS Safari -- WebKit
// reports it as ~0 while the bottom toolbar is showing and jumps it to the home-indicator height
// once the toolbar auto-hides on scroll. `.tabbar` used a bare `bottom: 10px`, so the same rule
// landed 10px above a short screen's toolbar-occupied edge (a visible gap, matching the friends
// tab) but only 10px above the true device edge once a tall screen was scrolled and the toolbar
// collapsed (matching the games tab, "nearly touching the home indicator"). `.wrap`'s
// padding-bottom already folds this same inset in; the fix mirrors that idiom onto `.tabbar`'s own
// `bottom`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');

function ruleBody(selectorLine) {
  const start = html.indexOf(selectorLine);
  assert.ok(start >= 0, `missing selector ${selectorLine}`);
  const braceOpen = html.indexOf('{', start);
  const braceClose = html.indexOf('}', braceOpen);
  assert.ok(braceOpen >= 0 && braceClose > braceOpen, `unterminated rule for ${selectorLine}`);
  return html.slice(braceOpen + 1, braceClose);
}

const CONTAINING_BLOCK_PROPS = /\btransform\s*:|(?<!backdrop-)\bfilter\s*:|backdrop-filter\s*:|\bcontain\s*:|\bwill-change\s*:/;

test('the tab bar\'s own bottom offset folds in env(safe-area-inset-bottom), like .wrap\'s padding-bottom already does', () => {
  const body = ruleBody('  .tabbar {');
  // The inset alone was not enough: it is constant while Safari's toolbar collapses, so the bar
  // still slid on a scrollable tab. --vv-offset carries that difference (see initTabbarViewportPin).
  assert.match(body, /bottom:\s*calc\(10px \+ env\(safe-area-inset-bottom,\s*0px\) \+ var\(--vv-offset,\s*0px\)\)/,
    '.tabbar must anchor off the safe-area inset AND the visual-viewport gap, not a bare px');
  // the sibling rule this idiom is mirrored from, so a future edit to one is caught if it drifts
  // from the other
  const wrapBody = ruleBody('  .wrap {');
  assert.match(wrapBody, /env\(safe-area-inset-bottom,\s*0px\)/);
});

test('none of .tabbar\'s ancestors (html, body, .wrap) declare a transform/filter/contain/will-change that would give position:fixed a containing block other than the viewport', () => {
  for (const selector of ['  html {', '  body {', '  .wrap {']) {
    const body = ruleBody(selector);
    assert.doesNotMatch(body, CONTAINING_BLOCK_PROPS,
      `${selector.trim()} must stay free of containing-block-creating properties -- introducing ` +
      'one here would make the bar track that ancestor\'s box instead of the viewport');
  }
});

test('the tabbar <nav>\'s .load-in entrance class is set once in the static markup and never added/removed by script, so the bar cannot be caught mid rise-animation on a later render', () => {
  const navIdx = html.indexOf('<nav class="tabbar load-in"');
  assert.ok(navIdx >= 0, 'tabbar nav markup not found');
  // the generic per-container helper (flashViewEnter-style) toggles "load-in" on OTHER containers
  // (#gamesHome, #rows, ...) on every render; .tabbar must never be one of them
  const scripts = html.slice(html.indexOf('<script>', navIdx));
  assert.doesNotMatch(scripts, /querySelector\(["']\.tabbar["']\)\.classList\.(add|remove)\(["']load-in["']\)/);
  assert.doesNotMatch(scripts, /getElementById\(["']tabbar["']\)\.classList\.(add|remove)\(["']load-in["']\)/);
});

test('the bar\'s height stays pinned (the earlier fix) and .kb-open still slides it fully off-screen while an input is focused', () => {
  const inBody = ruleBody('  .tabbar-in {');
  assert.match(inBody, /height:\s*44px/);
  const tabBody = ruleBody('  .tab {');
  assert.match(tabBody, /height:\s*100%/);
  const kbOpenIdx = html.indexOf('.tabbar.kb-open {');
  assert.ok(kbOpenIdx >= 0, '.tabbar.kb-open rule not found');
  const kbOpenBody = html.slice(kbOpenIdx, html.indexOf('}', kbOpenIdx));
  assert.match(kbOpenBody, /transform:\s*translateY\(120px\)/);
  assert.match(kbOpenBody, /opacity:\s*0/);
});

// ---------- the remaining movement was iOS Safari's collapsing toolbar ----------

test('the bar is pinned to the VISUAL viewport, not just the layout one', () => {
  // Measured in Chromium the bar never moved (top 750 / bottom 808 on every tab, scrolled or
  // not) and nothing in its ancestor chain creates a containing block — so `position: fixed`
  // was already correct. What still moved it on the owner's iPhone is Safari collapsing its
  // toolbar on a scrollable tab, which grows the visual viewport under a layout-fixed element.
  assert.match(html, /function initTabbarViewportPin\(\)/);
  assert.match(html, /window\.visualViewport/);
  assert.match(html, /vv\.addEventListener\("resize", apply\)/);
  assert.match(html, /vv\.addEventListener\("scroll", apply\)/);
  assert.match(html, /setProperty\("--vv-offset"/);
  // Absent visualViewport must leave the old behaviour untouched, not throw.
  assert.match(html, /if \(!vv \|\| !bar\) return;/);
  // The keyboard shrinks the same viewport; .kb-open already handles that, so a keyboard-sized
  // gap must not launch the bar up the screen.
  assert.match(html, /hidden > 160 \? 0 : hidden/);
  assert.match(html, /initTabbarViewportPin\(\);/);
});
