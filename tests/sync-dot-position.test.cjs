const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');

test('#syncDot is pinned into the top-right corner, ~25px above its old in-flow spot, with the 44px tap target kept', () => {
  const dotBlock = html.match(/\.dot \{[^}]*\}/s)[0];
  assert.match(dotBlock, /position:\s*absolute/, 'the dot must be taken out of the eyebrow flow to reach the true corner');
  assert.match(dotBlock, /top:\s*-25px/, 'pins the exact "~25px up from where it is now" offset the owner asked for');
  assert.match(dotBlock, /inset-inline-start:\s*18px/,
    'inline-start is the right edge in this RTL page -- same edge the dot already sat on, opposite .corner-btn\'s physical left');

  // The 44px hit target (::before, centred on the dot) must be untouched by the reposition.
  const beforeBlock = html.match(/\.dot::before \{[^}]*\}/s)[0];
  assert.match(beforeBlock, /width:\s*44px/);
  assert.match(beforeBlock, /height:\s*44px/);
});

test('the dot\'s corner anchor stays clear of the safe area and never collides with .corner-btn or the login eyebrow variant', () => {
  // header is the dot's new positioning context (deliberately, not by accident of the .load-in
  // entrance transform -- see the comment above the rule); its own top edge is still governed by
  // .wrap's safe-area-aware padding, so the dot inherits that clearance without repeating the calc.
  assert.match(html, /header \{ padding-inline-end: 96px; position: relative; \}/,
    'header must be an explicit positioning context, not rely on the transient .load-in transform');
  assert.match(html, /\.wrap \{[^}]*padding:\s*calc\(14px \+ env\(safe-area-inset-top,\s*0px\)\)[^}]*\}/s,
    'the safe-area guard the dot relies on (via header) must still be present on .wrap');

  // .corner-btn (#resetBtn/#themeBtn) sits on the opposite physical edge (a literal `left`, not a
  // logical property), so it can never share the dot's inset-inline-start edge.
  assert.match(html, /\.corner \{\s*position: absolute; top: calc\(6px \+ env\(safe-area-inset-top, 0px\)\); left: 18px;/);

  // The one other selector that could reposition the dot inside a .login overlay must stay inert
  // -- and there must be exactly one real <div class="eyebrow"> in the page, the one in <header>,
  // so ".login .eyebrow" has nothing to actually match today.
  assert.match(html, /\.login \.eyebrow \{ justify-content: flex-start; \}/);
  assert.equal((html.match(/class="eyebrow"/g) || []).length, 1);
});
