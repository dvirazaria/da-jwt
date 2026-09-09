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

test('the dashboard group preview is a full in-app overlay with one injected close control', () => {
  assert.match(html, /<div class="login group-preview" id="groupPreview" hidden>/);
  assert.match(html, /id="groupPreviewContent"/);
  assert.doesNotMatch(html, /id="groupPreviewBackBtn"/);
  const renderer = sourceBetween('  function renderGroupPreview() {', '  function renderGroupSurface() {');
  assert.match(renderer, /renderGroupHeader\(summary, closeGroupPreview,/);
});

test('opening a preview reuses the existing group adapters and renderers', () => {
  const source = sourceBetween('  function openGroupPreview(groupId) {', '  function renderGroupPreview() {');
  assert.match(source, /repairMyGroupMembership\(currentGroupId\)/);
  assert.match(source, /renderGroupPreview\(\)/);
  const renderer = sourceBetween('  function renderGroupPreview() {', '  // Back arrow, 64px avatar');
  assert.match(renderer, /getGroupSummary\(collections, currentGroupId, me\)/);
  assert.match(renderer, /renderGroupHeader\(summary, closeGroupPreview, openGroupSettings\)/);
  assert.match(renderer, /renderGroupPrimaryAction\(summary, canStartGroupGame\(collections, currentGroupId\)\)/);
  assert.match(renderer, /renderGroupMembers\(summary, activeMembers\(/);
  assert.match(renderer, /renderGroupHistory\(gameSummaries\)/);
});

test('member and history interactions rerender whichever group surface is open', () => {
  const sharedRenderers = sourceBetween('  function renderMemberRow(', '  function renderGroupInvite(');
  assert.match(sharedRenderers, /renderGroupSurface\(\)/);
  assert.doesNotMatch(sharedRenderers, /renderGroupPage\(\);/);
  assert.match(html, /#groupSettings \{[^}]*z-index: 42;/s);
});

test('create group moved from the quick actions into the groups section header', () => {
  const quickActions = sourceBetween('  function renderQuickActions(parent) {', '  function renderCreateGroupPanel(');
  assert.doesNotMatch(quickActions, /\+ צור קבוצה/);
  const groups = sourceBetween('  function renderGroupsSection(', '  // Collapsed "ארכיון');
  assert.match(groups, /games-groups-heading/);
  assert.match(groups, /games-create-group-inline/);
  assert.match(groups, /toggleCreateGroupPanel/);
  assert.match(groups, /renderCreateGroupPanel\(section\)/);
});
