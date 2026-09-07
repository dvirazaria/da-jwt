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

// The isolated pure-section slice does not define newId() (it lives elsewhere in the file), so
// tests supply a stub the same way tests/groups-domain.test.cjs and tests/group-members.test.cjs do.
function load(newIdStub) {
  const context = vm.createContext({ newId: newIdStub || (() => 'stub-new-id') });
  vm.runInContext(pureSource, context);
  return context;
}

// vm.runInContext returns objects/arrays from the sandbox's own realm, so a plain deepEqual
// against a native literal fails on "same structure, not reference-equal". Round-tripping
// through JSON strips that -- same helper as the other groups-domain test suites.
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

function loadGroups(groups, newIdStub) {
  const context = load(newIdStub);
  vm.runInContext(`var groups = ${JSON.stringify(groups)};`, context);
  return context;
}

// ---------- renameGroup ----------

test('renameGroup trims and applies a valid name, mutating the group in place', () => {
  const context = loadGroups([{ id: 'g1', name: 'ישן' }]);
  assert.equal(vm.runInContext(`renameGroup(groups, 'g1', '  שם חדש  ')`, context), true);
  assert.equal(runJSON('groups', context)[0].name, 'שם חדש');
});

test('renameGroup refuses an empty (or whitespace-only) name, a name over 40 chars, or a missing group', () => {
  const context = loadGroups([{ id: 'g1', name: 'ישן' }]);
  assert.equal(vm.runInContext(`renameGroup(groups, 'g1', '   ')`, context), false);
  assert.equal(vm.runInContext(`renameGroup(groups, 'g1', 'א'.repeat(41))`, context), false);
  assert.equal(vm.runInContext(`renameGroup(groups, 'missing', 'שם')`, context), false);
  assert.equal(runJSON('groups', context)[0].name, 'ישן'); // unchanged on every refusal
});

test('renameGroup accepts a name at exactly the 40-char cap', () => {
  const context = loadGroups([{ id: 'g1', name: 'ישן' }]);
  assert.equal(vm.runInContext(`renameGroup(groups, 'g1', 'א'.repeat(40))`, context), true);
  assert.equal(runJSON('groups', context)[0].name.length, 40);
});

// ---------- setGroupAvatar ----------

test('setGroupAvatar sets a data URL and clears it with null, refusing only a missing group', () => {
  const context = loadGroups([{ id: 'g1', avatarDataUrl: null }]);
  assert.equal(vm.runInContext(`setGroupAvatar(groups, 'g1', 'data:image/jpeg;base64,abc')`, context), true);
  assert.equal(runJSON('groups', context)[0].avatarDataUrl, 'data:image/jpeg;base64,abc');
  assert.equal(vm.runInContext(`setGroupAvatar(groups, 'g1', null)`, context), true);
  assert.equal(runJSON('groups', context)[0].avatarDataUrl, null);
  assert.equal(vm.runInContext(`setGroupAvatar(groups, 'missing', 'x')`, context), false);
});

// ---------- archiveGroup / unarchiveGroup ----------

test('archiveGroup sets archivedAt and refuses a missing, already-archived, or deleted group', () => {
  const context = loadGroups([
    { id: 'g1', archivedAt: null, deletedAt: null },
    { id: 'g2', archivedAt: '2026-01-01T00:00:00Z', deletedAt: null },
    { id: 'g3', archivedAt: null, deletedAt: '2026-01-01T00:00:00Z' },
  ]);
  assert.equal(vm.runInContext(`archiveGroup(groups, 'g1', '2026-09-08T10:00:00Z')`, context), true);
  assert.equal(runJSON('groups', context)[0].archivedAt, '2026-09-08T10:00:00Z');
  assert.equal(vm.runInContext(`archiveGroup(groups, 'g2', 't')`, context), false); // already archived
  assert.equal(vm.runInContext(`archiveGroup(groups, 'g3', 't')`, context), false); // deleted
  assert.equal(vm.runInContext(`archiveGroup(groups, 'missing', 't')`, context), false);
});

test('unarchiveGroup clears archivedAt and refuses a missing, not-archived, or deleted group', () => {
  const context = loadGroups([
    { id: 'g1', archivedAt: '2026-01-01T00:00:00Z', deletedAt: null },
    { id: 'g2', archivedAt: null, deletedAt: null },
    { id: 'g3', archivedAt: '2026-01-01T00:00:00Z', deletedAt: '2026-02-01T00:00:00Z' },
  ]);
  assert.equal(vm.runInContext(`unarchiveGroup(groups, 'g1')`, context), true);
  assert.equal(runJSON('groups', context)[0].archivedAt, null);
  assert.equal(vm.runInContext(`unarchiveGroup(groups, 'g2')`, context), false); // not archived
  assert.equal(vm.runInContext(`unarchiveGroup(groups, 'g3')`, context), false); // deleted
  assert.equal(vm.runInContext(`unarchiveGroup(groups, 'missing')`, context), false);
});

// ---------- deleteGroup ----------

test('deleteGroup soft-deletes (sets deletedAt) and refuses a missing or already-deleted group', () => {
  const context = loadGroups([
    { id: 'g1', deletedAt: null },
    { id: 'g2', deletedAt: '2026-01-01T00:00:00Z' },
  ]);
  assert.equal(vm.runInContext(`deleteGroup(groups, 'g1', '2026-09-08T10:00:00Z')`, context), true);
  assert.equal(runJSON('groups', context)[0].deletedAt, '2026-09-08T10:00:00Z');
  assert.equal(vm.runInContext(`deleteGroup(groups, 'g2', 't')`, context), false); // already deleted
  assert.equal(vm.runInContext(`deleteGroup(groups, 'missing', 't')`, context), false);
});

test('deleteGroup does not touch history or debts — a deleted group stays in personal records', () => {
  const context = load();
  const history = [{ gameId: 'h1', groupId: 'g1' }, { gameId: 'h2', groupId: 'g1' }];
  const debts = [{ id: 'd1', groupId: 'g1', status: 'open' }];
  Object.assign(context, {
    groups: [{ id: 'g1', deletedAt: null }],
    history: JSON.parse(JSON.stringify(history)),
    debts: JSON.parse(JSON.stringify(debts)),
  });
  vm.runInContext(`deleteGroup(groups, 'g1', '2026-09-08T10:00:00Z')`, context);
  assert.deepEqual(runJSON('history', context), history);
  assert.deepEqual(runJSON('debts', context), debts);
});

// ---------- getGroupSummaries / getArchivedGroupSummaries exclude archived+deleted correctly ----------

test('getGroupSummaries excludes both archived and deleted groups', () => {
  const context = load();
  const collections = {
    groups: [
      { id: 'g1', name: 'פעילה', archivedAt: null, deletedAt: null },
      { id: 'g2', name: 'בארכיון', archivedAt: '2026-01-01T00:00:00Z', deletedAt: null },
      { id: 'g3', name: 'נמחקה', archivedAt: null, deletedAt: '2026-01-01T00:00:00Z' },
    ],
    groupMembers: [], history: [], currentGame: { example: false, phase: 'closed', groupId: null },
  };
  const ids = runJSON(`getGroupSummaries(${JSON.stringify(collections)}, 'מישהו').map(s => s.groupId)`, context);
  assert.deepEqual(ids, ['g1']);
});

test('getArchivedGroupSummaries lists archived-not-deleted groups only, with the same summary shape', () => {
  const context = load();
  const collections = {
    groups: [
      { id: 'g1', name: 'פעילה', archivedAt: null, deletedAt: null },
      { id: 'g2', name: 'בארכיון', archivedAt: '2026-01-01T00:00:00Z', deletedAt: null },
      { id: 'g3', name: 'נמחקה', archivedAt: null, deletedAt: '2026-01-01T00:00:00Z' },
      { id: 'g4', name: 'גם בארכיון וגם נמחקה', archivedAt: '2026-01-01T00:00:00Z', deletedAt: '2026-02-01T00:00:00Z' },
    ],
    groupMembers: [
      { id: 'm1', groupId: 'g2', userId: null, guestId: 'p1', displayName: 'דביר', role: 'admin', status: 'active' },
    ],
    history: [], currentGame: { example: false, phase: 'closed', groupId: null },
  };
  const summaries = JSON.parse(vm.runInContext(`JSON.stringify(getArchivedGroupSummaries(${JSON.stringify(collections)}, 'דביר'))`, context));
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].groupId, 'g2');
  assert.equal(summaries[0].name, 'בארכיון');
  assert.equal(summaries[0].isAdmin, true);
});

// ---------- canStartGroupGame refuses archived and deleted ----------

test('canStartGroupGame reports group-archived for both an archived group and a deleted group', () => {
  const context = load();
  const groups = [
    { id: 'g1', archivedAt: null, deletedAt: null },
    { id: 'g2', archivedAt: '2026-01-01T00:00:00Z', deletedAt: null },
    { id: 'g3', archivedAt: null, deletedAt: '2026-01-01T00:00:00Z' },
  ];
  const collections = { groups, currentGame: { example: false, phase: 'closed', groupId: null } };
  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(collections)}, 'g1')`, context), { ok: true, reason: null });
  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(collections)}, 'g2')`, context), { ok: false, reason: 'group-archived' });
  assert.deepEqual(runJSON(`canStartGroupGame(${JSON.stringify(collections)}, 'g3')`, context), { ok: false, reason: 'group-archived' });
});

// ---------- last-admin guard for leave (regression, alongside tests/group-members.test.cjs) ----------

test('leaveGroup refuses the group\'s last active admin, but allows any other active member', () => {
  const context = load();
  const soleAdmin = [{ id: 'm1', groupId: 'g1', displayName: 'דביר', role: 'admin', status: 'active' }];
  assert.equal(vm.runInContext(`leaveGroup(${JSON.stringify(soleAdmin)}, 'g1', 'דביר', 't')`, context), false);

  const withCoAdmin = [
    { id: 'm1', groupId: 'g1', displayName: 'דביר', role: 'admin', status: 'active' },
    { id: 'm2', groupId: 'g1', displayName: 'רותם', role: 'member', status: 'active' },
  ];
  const memberContext = loadGroups([]);
  assert.equal(vm.runInContext(`leaveGroup(${JSON.stringify(withCoAdmin)}, 'g1', 'רותם', 't')`, memberContext), true);
});

// ---------- UI wiring (regex over the full source) ----------

test('the group settings overlay exists, reusing the .login/.set-in layout, next to #settings', () => {
  assert.match(html, /<div class="login" id="groupSettings" hidden>/);
  assert.match(html, /<div class="login-in set-in">/);
  assert.match(html, /id="groupSetName"/);
  assert.match(html, /id="groupSetAvatarBtn"/);
  assert.match(html, /id="groupSetArchiveBtn"/);
  assert.match(html, /id="groupSetDeleteBtn"/);
  assert.match(html, /id="groupSetLeaveBtn"/);
});

test('the group page header exposes a settings entry point wired to openGroupSettings', () => {
  assert.match(html, /function renderGroupHeader\(summary\)/);
  assert.match(html, /games-group-settings-btn/);
  assert.match(html, /הגדרות/);
  assert.match(html, /addEventListener\("click", openGroupSettings\)/);
});

test('delete UI is two-step armed, like resetBtn/setClearBtn, not a single click', () => {
  const source = sourceBetween('document.getElementById("groupSetDeleteBtn").addEventListener', 'document.getElementById("groupSetLeaveBtn").addEventListener');
  assert.match(source, /groupDeleteArmed/);
  assert.match(source, /groupDeleteArmedTimeout/);
  assert.match(source, /"בטוח\? ההיסטוריה הקבוצתית תוסתר"/);
  assert.match(source, /classList\.add\("armed"\)/);
  assert.match(source, /deleteGroup\(state\.groups, currentGroupId, new Date\(\)\.toISOString\(\)\)/);
});

test('leave UI is two-step armed and refused inline for the last admin', () => {
  const source = sourceBetween('document.getElementById("groupSetLeaveBtn").addEventListener', '  // ---------- settings overlay ----------');
  assert.match(source, /groupLeaveArmed/);
  assert.match(source, /groupLeaveArmedTimeout/);
  assert.match(source, /isLastActiveAdmin\(state\.groupMembers, membership\.id\)/);
  assert.match(source, /leaveGroup\(state\.groupMembers, currentGroupId, me, new Date\(\)\.toISOString\(\)\)/);
  assert.match(html, /"מנה מנהל אחר קודם"/);
});

test('deleting a group with an open game is refused with an inline reason, not silently', () => {
  assert.match(html, /summary\.hasActiveGame/);
  assert.match(html, /"סגור קודם את המשחק הפעיל"/);
});

test('archive (when archiving), delete and leave close the settings overlay and return to the dashboard', () => {
  const source = sourceBetween('  // ---------- group settings overlay ----------', '  // ---------- settings overlay ----------');
  const archiveHandler = source.slice(
    source.indexOf('document.getElementById("groupSetArchiveBtn").addEventListener'),
    source.indexOf('document.getElementById("groupSetDeleteBtn").addEventListener'));
  const deleteHandler = source.slice(
    source.indexOf('document.getElementById("groupSetDeleteBtn").addEventListener'),
    source.indexOf('document.getElementById("groupSetLeaveBtn").addEventListener'));
  const leaveHandler = source.slice(source.indexOf('document.getElementById("groupSetLeaveBtn").addEventListener'));
  assert.match(archiveHandler, /closeGroupSettings\(\);/);
  assert.match(archiveHandler, /setAppView\("games"\)/);
  assert.match(deleteHandler, /closeGroupSettings\(\);\s*setAppView\("games"\);/);
  assert.match(leaveHandler, /closeGroupSettings\(\);\s*setAppView\("games"\);/);
});

test('an archived group renders read-only: no primary action, a quiet "בארכיון" note', () => {
  const source = sourceBetween('  function renderGroupPage() {', '  function render() {');
  assert.match(source, /if \(isArchived\)/);
  assert.match(source, /"הקבוצה בארכיון"/);
});

test('a deleted group bounces the viewer back to the dashboard instead of rendering', () => {
  const source = sourceBetween('  function renderGroupPage() {', '  function render() {');
  assert.match(source, /rawGroup\.deletedAt\) \{ setAppView\("games"\); return; \}/);
});

test('promoting a member to admin is wired through setMemberRole, not a parallel implementation', () => {
  assert.match(html, /function promoteMember\(groupId, memberId\)/);
  assert.match(html, /setMemberRole\(state\.groupMembers, memberId, "admin"\)/);
  assert.match(html, /הפוך למנהל/);
});
