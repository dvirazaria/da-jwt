// Owner bug: on a group page "מחק קבוצה" → "בטוח?" → nothing happens. Root cause: the page showed
// the left-group state (and its hide-from-device action) for ANY non-member — including a name
// with no membership row at all — while hideGroupForMember refuses exactly that case, so the
// confirm tap was a silent no-op. Same vm-slice/regex pattern as tests/design-round.test.cjs.
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
const reasonSource = sourceBetween('  function leftGroupReason() {', '  // D8, step two of leaving');

function membersFixture() {
  return [
    { id: 'm1', groupId: 'g1', displayName: 'דביר', role: 'admin', status: 'active', hiddenAt: null },
    { id: 'm2', groupId: 'g1', displayName: 'נועה', role: 'member', status: 'left', hiddenAt: null },
    { id: 'm3', groupId: 'g1', displayName: 'רון', role: 'member', status: 'removed', hiddenAt: null },
  ];
}
function loadPure(extraGlobals = {}) {
  const context = vm.createContext({ newId: () => 'stub-id', ...extraGlobals });
  vm.runInContext(pureSource, context);
  return context;
}

// ---------- pure: findMyFormerMembership agrees with hideGroupForMember ----------

test('findMyFormerMembership returns my left/removed row and null when I am active or was never a member', () => {
  const context = loadPure();
  vm.runInContext(`var members = ${JSON.stringify(membersFixture())};`, context);
  assert.equal(vm.runInContext(`findMyFormerMembership(members, 'g1', 'נועה').id`, context), 'm2');
  assert.equal(vm.runInContext(`findMyFormerMembership(members, 'g1', 'רון').id`, context), 'm3');
  assert.equal(vm.runInContext(`findMyFormerMembership(members, 'g1', 'דביר')`, context), null);
  assert.equal(vm.runInContext(`findMyFormerMembership(members, 'g1', 'יוסי')`, context), null);
  assert.equal(vm.runInContext(`findMyFormerMembership(members, 'g-missing', 'נועה')`, context), null);
  assert.equal(vm.runInContext(`findMyFormerMembership(null, 'g1', 'נועה')`, context), null);
});

test('hideGroupForMember succeeds exactly when findMyFormerMembership is non-null (the render gate and the mutation agree)', () => {
  const context = loadPure();
  vm.runInContext(`var members = ${JSON.stringify(membersFixture())};`, context);
  for (const name of ['דביר', 'נועה', 'רון', 'יוסי']) {
    const canHide = vm.runInContext(`!!findMyFormerMembership(members, 'g1', '${name}')`, context);
    const did = vm.runInContext(`hideGroupForMember(members, 'g1', '${name}', 'T1')`, context);
    assert.equal(did, canHide, name);
  }
  const stamped = JSON.parse(vm.runInContext(`JSON.stringify(members.map(m => m.hiddenAt))`, context));
  assert.deepEqual(stamped, [null, 'T1', 'T1']);
});

// ---------- behavior: the reason line is honest about a missing membership ----------

test('leftGroupReason says "עזבת"/"הוסרת" for my former row, and names my identity when no row of mine exists', () => {
  const reasonFor = (me) => {
    const context = loadPure({ me, currentGroupId: 'g1', state: { groupMembers: membersFixture() } });
    vm.runInContext(reasonSource, context);
    return vm.runInContext('leftGroupReason()', context);
  };
  assert.equal(reasonFor('נועה'), 'עזבת את הקבוצה');
  assert.equal(reasonFor('רון'), 'הוסרת מהקבוצה');
  // The owner's case: the device's name matches no membership row (e.g. the display name set by
  // sign-in differs from the name on the rows) — no false "עזבת", and the identity is visible.
  assert.equal(reasonFor('יוסי'), 'אתה לא חבר בקבוצה הזו — מחובר בשם יוסי');
  assert.doesNotMatch(reasonFor('יוסי'), /עזבת/);
});

// ---------- regex: the hide-group button exists only when the confirm can succeed ----------

test('renderHideGroupAction renders nothing unless a left/removed membership of mine exists, and a refused confirm re-renders instead of returning silently', () => {
  const source = sourceBetween('  function renderHideGroupAction() {', '  function renderStartGamePanel() {');
  assert.match(source, /^\s*if \(!findMyFormerMembership\(state\.groupMembers, currentGroupId, me\)\) return null;/m);
  assert.match(source, /if \(!hideGroupForMember\(state\.groupMembers, currentGroupId, me, new Date\(\)\.toISOString\(\)\)\) \{ renderGroupSurface\(\); return; \}/);
  assert.doesNotMatch(source, /hideGroupForMember\([^\n]*\)\) return;/);
});

test('both callers (primary action and the archived note) append the hide-group action only when it was rendered', () => {
  const primary = sourceBetween('  function renderGroupPrimaryAction(summary, gate) {', '  function leftGroupReason() {');
  const page = sourceBetween('  function renderGroupPage() {', '  function renderAddRowChips() {');
  for (const src of [primary, page]) {
    assert.match(src, /const hideAction = !summary\.isMember && renderHideGroupAction\(\);/);
    assert.match(src, /if \(hideAction\) \w+\.appendChild\(hideAction\);/);
    assert.doesNotMatch(src, /appendChild\(renderHideGroupAction\(\)\)/);
  }
});

test('the overlay "מחק קבוצה" confirm is never a silent no-op either', () => {
  const source = sourceBetween('  document.getElementById("groupSetDeleteBtn").addEventListener("click"', '  document.getElementById("groupSetLeaveBtn")');
  assert.match(source, /if \(!deleteGroup\(state\.groups, currentGroupId, new Date\(\)\.toISOString\(\)\)\) \{ closeGroupSettings\(\); renderGroupSurface\(\); return; \}/);
});
