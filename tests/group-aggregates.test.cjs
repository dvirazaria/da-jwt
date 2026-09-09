// Group leaderboard / group history read a safe aggregate instead of raw per-player rows
// (docs/backend/group-summaries.sql), so that docs/backend/player-boundary.sql's narrowing of
// entries_select/game_participants_select to "participant of this game" can ship without the
// regression flagged in its own header: a member who missed a night losing that night from the
// group's history, and their leaderboard covering only games they played. These tests pin, offline:
//   - the SQL: BEGIN/COMMIT-wrapped, no service_role/secret material, REVOKE ALL ... FROM public
//     and FROM anon before the GRANT on the new view, and no per-player money in its final
//     projection;
//   - the client: resolveGroupLeaderboard / resolveGroupGameSummaries prefer the aggregate when
//     it was actually fetched this pull, and fall back to the exact local computation
//     (buildLeaderboard / groupClosedGames+toGroupGameSummary) otherwise — so a game the viewer
//     did not play no longer needs its raw rows to still show up, and an unavailable aggregate
//     degrades to what local state already knows rather than a zero-player row or a wrong total.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sql = fs.readFileSync('docs/backend/group-summaries.sql', 'utf8');
const html = fs.readFileSync('kupa-sgura.html', 'utf8');

test('group-summaries.sql is a single BEGIN/COMMIT-wrapped transaction', () => {
  const begins = sql.match(/^BEGIN;$/gm) || [];
  const commits = sql.match(/^COMMIT;$/gm) || [];
  assert.equal(begins.length, 1, 'expected exactly one top-level BEGIN;');
  assert.equal(commits.length, 1, 'expected exactly one top-level COMMIT;');
  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('COMMIT;'), 'BEGIN must precede COMMIT');
});

test('group-summaries.sql carries no service-role key or secret material', () => {
  assert.doesNotMatch(sql, /service_role/i);
  assert.doesNotMatch(sql, /sb_secret_/i);
});

test('the new view is revoked from public and anon before being granted to authenticated', () => {
  const created = [...sql.matchAll(/CREATE (?:OR REPLACE )?VIEW\s+(\w+)/gi)].map(m => m[1]);
  assert.ok(created.includes('group_game_summaries_v'));
  created.forEach(name => {
    const revokeIdx = sql.search(new RegExp(`REVOKE\\s+ALL\\s+ON\\s+${name}\\s+FROM\\s+public`, 'i'));
    const revokeAnonIdx = sql.search(new RegExp(`REVOKE\\s+ALL\\s+ON\\s+${name}\\s+FROM\\s+anon`, 'i'));
    const grantIdx = sql.search(new RegExp(`GRANT\\s+SELECT\\s+ON\\s+${name}\\s+TO\\s+authenticated`, 'i'));
    assert.ok(revokeIdx >= 0, `${name}: missing REVOKE ALL ... FROM public`);
    assert.ok(revokeAnonIdx >= 0, `${name}: missing REVOKE ALL ... FROM anon`);
    assert.ok(grantIdx >= 0, `${name}: missing GRANT SELECT ... TO authenticated`);
    assert.ok(revokeIdx < grantIdx && revokeAnonIdx < grantIdx, `${name}: REVOKE must precede GRANT`);
  });
});

test('group_game_summaries_v never projects a per-player net or cashout column', () => {
  // The CTEs legitimately read r.net/r.cashout (to find the winner and the balance flag) — the
  // thing that must never happen is either one surviving into the view's own final column list.
  const selectStart = sql.indexOf('SELECT\n  game_id,');
  const selectEnd = sql.indexOf('FROM per_game', selectStart);
  const finalSelect = sql.slice(selectStart, selectEnd);
  assert.doesNotMatch(finalSelect, /\bAS\s+net\b/i);
  assert.doesNotMatch(finalSelect, /\bAS\s+cashout\b/i);
  assert.match(finalSelect, /pot_size/);
  assert.match(finalSelect, /winner_names/);
  assert.match(finalSelect, /is_balanced/);
});

test('the view re-checks group membership itself rather than trusting caller RLS', () => {
  assert.match(sql, /app_is_active_group_member\(g\.group_id\)/);
  assert.match(sql, /security_invoker/); // discussed in the header comment, deliberately not set on the view
});

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + 1);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end >= 0, `missing ${endMarker}`);
  return html.slice(start, end);
}

// The full adapters block: groupLeaderboardFromAggregate, groupGameSummariesFromAggregate,
// resolveGroupLeaderboard, resolveGroupGameSummaries.
const adaptersSrc = sourceBetween(
  '  // ---------- group aggregate adapters (pure) ----------',
  '  function getGroupSummary(collections, groupId, meName, aggregates) {'
);
// Local-fallback dependencies (unchanged existing helpers).
const buildLeaderboardSrc = sourceBetween('  function buildLeaderboard(history, members, groupId) {', '  // ---------- group aggregate adapters (pure) ----------');
const identityHelpersSrc = sourceBetween('  function isLeaderboardEligible(participant, members) {', '  // Ranking: total net desc');
const groupClosedGamesSrc = sourceBetween('  function groupClosedGames(history, groupId) {', '  // D5: a game where nobody');
const gameWinnersSrc = sourceBetween('  function gameWinners(historyEntry) {', '  // Builds a GroupGameSummary');
const toGroupGameSummarySrc = sourceBetween('  function toGroupGameSummary(historyEntry) {', '  // Short Hebrew duration');

function runInContext(expr) {
  const context = {
    console,
    identityKey: (ref) => 'u:' + (ref.userId || ref.guestId || ref.displayName),
    sameIdentity: (m, p) => m.displayName === p.displayName,
  };
  vm.createContext(context);
  vm.runInContext(groupClosedGamesSrc + gameWinnersSrc + identityHelpersSrc + buildLeaderboardSrc
    + toGroupGameSummarySrc + adaptersSrc, context);
  // Cross-realm vm arrays/objects fail node:assert/strict's deepEqual ("same structure but not
  // reference-equal") even when their contents match — round-trip through JSON so callers get a
  // plain object/array from THIS realm.
  return JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, context));
}

test('resolveGroupLeaderboard reads the safe aggregate, needing none of the viewer own raw rows', () => {
  const aggregates = {
    available: true,
    leaderboard: [
      { group_id: 'g1', identity_key: 'u:alice', display_name: 'Alice', games_played: 5, wins: 2, rank: 1, is_former_member: false },
      { group_id: 'g1', identity_key: 'u:bob', display_name: 'Bob', games_played: 1, wins: 0, rank: 2, is_former_member: false },
      { group_id: 'g2', identity_key: 'u:carl', display_name: 'Carl', games_played: 9, wins: 9, rank: 1, is_former_member: false },
    ],
    gameSummaries: [],
  };
  // The viewer's local history for g1 is empty (they never played a g1 game) — the aggregate
  // still returns complete stats for every OTHER member, because it did not compute over the
  // viewer's own raw entries/game_participants rows.
  const rows = runInContext(`resolveGroupLeaderboard({ history: [] }, 'g1', ${JSON.stringify(aggregates)})`);
  assert.deepEqual(rows.map(r => r.displayName), ['Alice', 'Bob']);
  assert.equal(rows[0].gamesPlayed, 5);
  assert.equal(rows[0].wins, 2);
  assert.ok(!('net' in rows[0]), 'aggregate-backed leaderboard row must carry no money field');
});

test('resolveGroupLeaderboard falls back to the local computation when the aggregate is unavailable', () => {
  const history = [{ groupId: 'g1', players: [{ name: 'Alice', net: 10 }, { name: 'Bob', net: -10 }] }];
  const members = [{ groupId: 'g1', displayName: 'Alice', status: 'active' }, { groupId: 'g1', displayName: 'Bob', status: 'active' }];
  const rows = runInContext(
    `resolveGroupLeaderboard({ history: ${JSON.stringify(history)}, groupMembers: ${JSON.stringify(members)} }, 'g1', { available: false, leaderboard: [], gameSummaries: [] })`
  );
  assert.deepEqual(rows.map(r => r.displayName), ['Alice', 'Bob']);
});

test('resolveGroupGameSummaries reads the safe aggregate with no zero-player row and no per-player money', () => {
  const aggregates = {
    available: true,
    leaderboard: [],
    gameSummaries: [
      { game_id: 'game-1', group_id: 'g1', at: '2026-09-01T20:00:00Z', started_at: '2026-09-01T18:00:00Z', player_count: 3, player_names: ['Alice', 'Bob', 'Carl'], winner_names: ['Alice'], pot_size: 300, is_balanced: true },
    ],
  };
  const rows = runInContext(`resolveGroupGameSummaries({ history: [] }, 'g1', ${JSON.stringify(aggregates)})`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].playerCount, 3);
  assert.ok(rows[0].playerCount > 0, 'an aggregate row must never render as a zero-player game');
  assert.equal(rows[0].potSize, 300);
  assert.deepEqual(rows[0].winnerNames, ['Alice']);
  assert.ok(!('net' in rows[0]) && !('cashout' in rows[0]));
});

test('resolveGroupGameSummaries falls back to groupClosedGames+toGroupGameSummary when the aggregate is unavailable', () => {
  const history = [{ gameId: 'game-2', groupId: 'g1', at: '2026-09-02T10:00:00Z', startedAt: null, isBalanced: true, players: [{ name: 'Alice', net: 5, buyin: 100 }] }];
  const rows = runInContext(
    `resolveGroupGameSummaries({ history: ${JSON.stringify(history)} }, 'g1', { available: false, leaderboard: [], gameSummaries: [] })`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gameId, 'game-2');
  assert.equal(rows[0].playerCount, 1);
});

test('the pull only trusts the aggregate cache when both aggregate queries came back without error', () => {
  const pullSrc = sourceBetween('  async function pullCloud(', '  // The three child tables of a set of games');
  assert.match(pullSrc, /group_leaderboard_public_v/);
  assert.match(pullSrc, /group_game_summaries_v/);
  assert.match(pullSrc, /groupAggregatesOk\s*=\s*!leaderboardResult\.error\s*&&\s*!gameSummariesResult\.error/);
  const applySrc = sourceBetween('  function applyCloudPull(payload, pullSeq, pullAccountId) {', '    const groupRows = payload.groups || [];');
  assert.match(applySrc, /available:\s*!!payload\.groupAggregatesOk/);
});

test('every group screen call site passes the aggregate cache through to the resolvers', () => {
  assert.match(html, /getGroupSummaries\(collectionsOf\(state\), me, cloudGroupAggregates\)/);
  assert.match(html, /getArchivedGroupSummaries\(collectionsOf\(state\), me, cloudGroupAggregates\)/);
  assert.match(html, /resolveGroupLeaderboard\(collections, currentGroupId, cloudGroupAggregates\)/);
  assert.match(html, /resolveGroupGameSummaries\(collections, currentGroupId, cloudGroupAggregates\)/);
});
