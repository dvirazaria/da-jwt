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

// The full group-page renderer region: every renderGroup*/renderMember*/renderStartGame*
// helper, from the first sub-renderer right after renderGamesDashboard through the end of
// renderGroupPage() itself (which composes them). renderAddRowChips is the next function in
// the file and is unrelated to the group page (it renders member chips on the game screen).
const groupRenderersSource = sourceBetween(
  '  function renderGroupHeader(summary) {',
  '  function renderAddRowChips() {'
);

// The #groupSettings overlay: admin controls (rename, avatar, archive, delete) and "עזוב קבוצה".
const groupSettingsSource = sourceBetween(
  '  // ---------- group settings overlay: UI-only state ----------',
  '  // ---------- settings overlay ----------'
);

const pureSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');

function loadPure() {
  const context = vm.createContext({ newId: () => 'stub-id' });
  vm.runInContext(pureSource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- renderers: no identifier that could expose per-player money or debts ----------

// Case-sensitive identifier/substring checks (matches task-13 brief). `potSize` and
// `totalEntries` are the only money-shaped fields the group UI is allowed to show (aggregate
// pot size and entry count on a history row) and neither one contains any of these substrings,
// so a plain substring check needs no special-casing for them.
const forbiddenTokens = ['fmtSigned', '.net', 'state.debts', 'debt', 'cashout', 'buyin', 'transfers', 'settle('];

test('group page renderers never reference net/debt/cashout/buyin/transfer identifiers', () => {
  forbiddenTokens.forEach(token => {
    assert.ok(
      !groupRenderersSource.includes(token),
      `group renderers unexpectedly reference "${token}"`
    );
  });
});

test('#groupSettings overlay never references net/debt/cashout/buyin/transfer identifiers', () => {
  forbiddenTokens.forEach(token => {
    assert.ok(
      !groupSettingsSource.includes(token),
      `#groupSettings overlay unexpectedly reference "${token}"`
    );
  });
});

test('group renderers still render the allowed potSize aggregate (sanity check on the slice)', () => {
  // Confirms the slice boundaries are right and the substring check above isn't vacuous — the
  // region really does render an aggregate pot size, just nothing per-player. totalEntries is
  // part of GroupGameSummary but not currently rendered anywhere in the group page itself.
  assert.match(groupRenderersSource, /game\.potSize/);
});

// ---------- pure builders: returned objects carry no money key besides potSize/totalEntries ----------

const forbiddenKeys = ['net', 'total', 'profit', 'amount', 'balance', 'cashout', 'buyin', 'buyinTotal', 'debts', 'transfers'];

function collectKeys(value, acc) {
  if (Array.isArray(value)) {
    value.forEach(v => collectKeys(v, acc));
  } else if (value && typeof value === 'object') {
    Object.keys(value).forEach(k => {
      acc.add(k);
      collectKeys(value[k], acc);
    });
  }
  return acc;
}

function assertNoMoneyLeak(value, label) {
  const keys = collectKeys(value, new Set());
  forbiddenKeys.forEach(bad => {
    assert.ok(!keys.has(bad), `${label} leaks forbidden key "${bad}" (keys: ${[...keys].join(', ')})`);
  });
}

// Fixture: a closed group game with 3 players whose nets are +80 / -30 / -50 (deliberately not
// summing to 0, since these are per-player nets, not a balance check). potSize/entryLog counts
// are chosen so their numeric values never collide with 80/-30/-50, so the "no standalone
// leaked number" check below can't produce a false positive from a legitimate aggregate field.
function privacyFixture() {
  const groupId = 'grp-priv';
  const members = [
    { id: 'm1', groupId, guestId: 'guest-alice', displayName: 'Alice', status: 'active', role: 'admin' },
    { id: 'm2', groupId, guestId: 'guest-bob', displayName: 'Bob', status: 'active', role: 'member' },
    { id: 'm3', groupId, guestId: 'guest-carol', displayName: 'Carol', status: 'active', role: 'member' },
  ];
  const history = [{
    gameId: 'gpriv1', groupId,
    startedAt: '2026-09-07T20:00:00.000Z',
    at: '2026-09-07T22:00:00.000Z',
    isBalanced: true,
    players: [
      { name: 'Alice', guestId: 'guest-alice', net: 80, buyin: 100, cashout: 180, entryLog: [{ id: 'e1' }] },
      { name: 'Bob', guestId: 'guest-bob', net: -30, buyin: 100, cashout: 70, entryLog: [{ id: 'e2' }] },
      { name: 'Carol', guestId: 'guest-carol', net: -50, buyin: 100, cashout: 50, entryLog: [{ id: 'e3' }] },
    ],
  }];
  return { groupId, members, history };
}

test('toGroupGameSummary returns no key other than potSize/totalEntries that carries money', () => {
  const context = loadPure();
  const { history } = privacyFixture();
  const summary = runJSON(`toGroupGameSummary(${JSON.stringify(history[0])})`, context);
  assertNoMoneyLeak(summary, 'toGroupGameSummary result');
});

test('buildLeaderboard entries carry no money key at all (not even potSize)', () => {
  const context = loadPure();
  const { history, members, groupId } = privacyFixture();
  const rows = runJSON(`buildLeaderboard(${JSON.stringify(history)}, ${JSON.stringify(members)}, ${JSON.stringify(groupId)})`, context);
  assertNoMoneyLeak(rows, 'buildLeaderboard result');
  const expectedKeys = new Set(['rank', 'identityKey', 'displayName', 'gamesPlayed', 'wins', 'isFormerMember']);
  rows.forEach(row => {
    Object.keys(row).forEach(k => assert.ok(expectedKeys.has(k), `unexpected key "${k}" on a LeaderboardEntry`));
  });
});

test('getGroupSummary returns no key other than potSize/totalEntries that carries money', () => {
  const context = loadPure();
  const { history, members, groupId } = privacyFixture();
  const collections = { groups: [{ id: groupId, name: 'Group', avatarDataUrl: null }], groupMembers: members, history, currentGame: { example: false } };
  const summary = runJSON(`getGroupSummary(${JSON.stringify(collections)}, ${JSON.stringify(groupId)}, ${JSON.stringify('Alice')})`, context);
  assertNoMoneyLeak(summary, 'getGroupSummary result');
});

// ---------- pure builders: no standalone leaked net number in the serialized output ----------

test('toGroupGameSummary + buildLeaderboard output never contains a per-player net as a bare number', () => {
  const context = loadPure();
  const { history, members, groupId } = privacyFixture();
  const summary = vm.runInContext(`JSON.stringify(toGroupGameSummary(${JSON.stringify(history[0])}))`, context);
  const leaderboard = vm.runInContext(`JSON.stringify(buildLeaderboard(${JSON.stringify(history)}, ${JSON.stringify(members)}, ${JSON.stringify(groupId)}))`, context);
  const combined = summary + leaderboard;
  // Each net value as a JSON number token: no digit immediately before/after (so a legitimate
  // aggregate like potSize:300 or an id/timestamp can never accidentally satisfy the check).
  [/(?<!\d)80(?!\d)/, /(?<!\d)-30(?!\d)/, /(?<!\d)-50(?!\d)/].forEach(re => {
    assert.doesNotMatch(combined, re, `leaked a per-player net in: ${combined}`);
  });
});
