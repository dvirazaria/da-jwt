const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');
const sourceBetween = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

test('a former member can remove only their local group row from the preview after a profile-name change', () => {
  const context = vm.createContext({
    newId: () => 'stub-id',
    authUser: { id: 'profile-dvir' },
    members: [
      { id: 'mine', groupId: 'g1', userId: 'profile-dvir', displayName: 'דביר הישן', status: 'removed', hiddenAt: null },
      { id: 'other', groupId: 'g1', userId: 'profile-other', displayName: 'רון', status: 'removed', hiddenAt: null },
    ],
  });
  vm.runInContext(pureSource, context);
  assert.equal(vm.runInContext(`hideGroupForMember(members, 'g1', 'דביר החדש', 'T1', 'profile-dvir')`, context), true);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(members.map(m => m.hiddenAt))', context)), ['T1', null]);

  const preview = sourceBetween('  function renderGroupPreview() {', '  function renderGroupSurface() {');
  const action = sourceBetween('  function renderHideGroupAction() {', '  function renderStartGamePanel() {');
  assert.match(preview, /renderGroupPrimaryAction\(summary,/);
  assert.match(action, /const profileId = authUser && authUser\.id/);
  assert.match(action, /findMyFormerMembership\(state\.groupMembers, currentGroupId, me, profileId\)/);
  assert.match(action, /hideGroupForMember\(state\.groupMembers, currentGroupId, me, new Date\(\)\.toISOString\(\), profileId\)/);
  assert.match(action, /hideGroupArmed/);
  assert.match(html, /\.games-hide-group-btn \{ font-size: 15px; min-height: 44px; \}/);
});
