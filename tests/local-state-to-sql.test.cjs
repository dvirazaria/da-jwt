const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const converter = require(path.join(__dirname, '..', 'tools', 'local-state-to-sql.js'));

const OWNER = '11111111-2222-4333-8444-555555555555';
const OWNER_NAME = 'דביר';

// A poker-settle-v1 snapshot that exercises every migrated shape:
// one group with two members, an invite, a friendship that cannot migrate,
// one closed game (with a legacy player that has no entry log and a
// transfer), an open game with a null-timestamp entry and an empty cashout,
// one debt on the closed game and one orphan debt.
const FIXTURE = {
  example: false,
  gameId: 'g-open',
  phase: 'active',
  groupId: 'grp-1',
  startedAt: '2026-09-01T18:00:00.000Z',
  updatedAt: '2026-09-01T21:30:00.000Z',
  leaderRef: { userId: null, guestId: 'guest-dvir', displayName: 'דביר' },
  players: [
    {
      id: 'p-open-1', name: 'דביר', guestId: 'guest-dvir', memberId: 'm-1',
      buyins: [50, 100], cashout: 220, status: 'active', exitedAt: null,
      entryLog: [
        { id: 'e-o-1', timestamp: '2026-09-01T18:05:00.000Z', amount: 50, playerId: 'p-open-1', gameId: 'g-open' },
        { id: 'e-o-2', timestamp: null, amount: 100, playerId: 'p-open-1', gameId: 'g-open' },
      ],
    },
    {
      id: 'p-open-2', name: "או'מר", guestId: 'guest-omer', memberId: 'm-2',
      buyins: [50], cashout: '', status: 'active', exitedAt: null,
      entryLog: [
        { id: 'e-o-3', timestamp: '2026-09-01T18:07:00.000Z', amount: 50, playerId: 'p-open-2', gameId: 'g-open' },
      ],
    },
    {
      id: 'p-open-3', name: 'יובל', guestId: null, memberId: null,
      buyins: [50], cashout: 0, status: 'exited', exitedAt: '2026-09-01T20:00:00.000Z',
      entryLog: [
        { id: 'e-o-4', timestamp: '2026-09-01T18:09:00.000Z', amount: 50, playerId: 'p-open-3', gameId: 'g-open' },
      ],
    },
  ],
  settlementStatuses: {},
  history: [
    {
      gameId: 'g-1',
      at: '2026-08-20T22:00:00.000Z',
      startedAt: '2026-08-20T19:00:00.000Z',
      groupId: 'grp-1',
      isBalanced: true,
      balanceDifference: 0,
      leaderRef: { userId: null, guestId: 'guest-dvir', displayName: 'דביר' },
      transfers: [
        { id: 'g-1::0::או\'מר::דביר::80', from: "או'מר", to: 'דביר', amount: 80, status: 'open' },
      ],
      players: [
        {
          id: 'p-1', name: 'דביר', guestId: 'guest-dvir', memberId: 'm-1',
          buyin: 100, cashout: 180, net: 80, status: 'active', exitedAt: null,
          entryLog: [
            { id: 'e-1', timestamp: '2026-08-20T19:10:00.000Z', amount: 100, playerId: 'p-1', gameId: 'g-1' },
          ],
        },
        {
          // legacy shape: a buy-in total with no entry log at all
          id: 'p-2', name: "או'מר", guestId: 'guest-omer', memberId: 'm-2',
          buyin: 100, cashout: 20, net: -80, status: 'active', exitedAt: null,
          entryLog: [],
        },
        {
          id: 'p-3', name: 'רותם', guestId: 'guest-rotem', memberId: null,
          buyin: 100, cashout: 100, net: 0, status: 'active', exitedAt: null,
          entryLog: [
            { id: 'e-3a', timestamp: null, amount: 50, playerId: 'p-3', gameId: 'g-1' },
            { id: 'e-3b', timestamp: '2026-08-20T20:00:00.000Z', amount: 50, playerId: 'p-3', gameId: 'g-1' },
          ],
        },
      ],
    },
  ],
  debts: [
    {
      id: 'debt-g-1::0', gameId: 'g-1', groupId: 'grp-1',
      debtorUserId: 'p-2', creditorUserId: 'p-1',
      debtorName: "או'מר", creditorName: 'דביר',
      amount: 80, status: 'open',
      createdAt: '2026-08-20T22:00:00.000Z', gameDate: '2026-08-20T22:00:00.000Z', paidAt: null,
    },
    {
      // points at a game that fell out of the capped history
      id: 'debt-gone::0', gameId: 'g-old', groupId: 'grp-1',
      debtorUserId: 'x', creditorUserId: 'y',
      debtorName: 'רותם', creditorName: 'דביר',
      amount: 40, status: 'open',
      createdAt: '2026-01-01T22:00:00.000Z', gameDate: '2026-01-01T22:00:00.000Z', paidAt: null,
    },
  ],
  groups: [
    {
      id: 'grp-1', name: 'הקבוצה של דביר', avatarDataUrl: 'data:image/jpeg;base64,AAAA',
      createdBy: { userId: null, guestId: 'guest-dvir', displayName: 'דביר' },
      createdAt: '2026-08-01T10:00:00.000Z', archivedAt: null, deletedAt: null,
    },
  ],
  groupMembers: [
    {
      id: 'm-1', groupId: 'grp-1', userId: null, guestId: 'guest-dvir', displayName: 'דביר',
      role: 'admin', status: 'active', joinedAt: '2026-08-01T10:00:00.000Z', leftAt: null,
    },
    {
      id: 'm-2', groupId: 'grp-1', userId: null, guestId: 'guest-omer', displayName: "או'מר",
      role: 'member', status: 'active', joinedAt: '2026-08-02T10:00:00.000Z', leftAt: null,
    },
  ],
  invites: [
    {
      id: 'inv-1', groupId: 'grp-1', token: 'abcdefgh12345678',
      createdBy: { userId: null, guestId: 'guest-dvir', displayName: 'דביר' },
      createdAt: '2026-08-03T10:00:00.000Z', revokedAt: null,
    },
  ],
  friendships: [
    {
      id: 'fr-1',
      requester: { userId: null, guestId: 'guest-dvir', displayName: 'דביר' },
      addressee: { userId: null, guestId: 'guest-omer', displayName: "או'מר" },
      status: 'pending', createdAt: '2026-08-04T10:00:00.000Z', respondedAt: null,
    },
  ],
};

function writeFixture(state = FIXTURE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kupa-migration-'));
  const file = path.join(dir, 'export.json');
  fs.writeFileSync(file, JSON.stringify(state));
  return file;
}

function convertFixture(state = FIXTURE) {
  return converter.run([writeFixture(state), '--owner', OWNER, '--group-owner-name', OWNER_NAME]);
}

function countInserts(sql, table) {
  return (sql.match(new RegExp(`^INSERT INTO ${table} `, 'gm')) || []).length;
}

test('statements are emitted in foreign-key order', () => {
  const { sql } = convertFixture();
  const emitted = converter.TABLE_ORDER
    .map(table => ({ table, at: sql.indexOf(`INSERT INTO ${table} `) }))
    .filter(item => item.at !== -1);
  assert.deepEqual(
    emitted.map(item => item.table),
    ['profiles', 'guests', 'groups', 'group_members', 'invites',
     'games', 'game_participants', 'entries', 'transfers', 'debts'],
    'friendships must be absent (both sides are guests) and the rest must stay in FK order',
  );
  for (let i = 1; i < emitted.length; i += 1) {
    assert.ok(emitted[i].at > emitted[i - 1].at,
      `${emitted[i].table} must come after ${emitted[i - 1].table}`);
  }
  assert.ok(sql.startsWith('-- Generated by tools/local-state-to-sql.js'));
  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('INSERT INTO profiles'));
  assert.ok(sql.trimEnd().endsWith('COMMIT;'));
});

test('row counts match the fixture, with the owner as the only profile', () => {
  const { sql } = convertFixture();
  assert.equal(countInserts(sql, 'profiles'), 1);
  // דביר is the owner profile; או'מר, יובל and רותם become guests.
  assert.equal(countInserts(sql, 'guests'), 3);
  assert.equal(countInserts(sql, 'groups'), 1);
  assert.equal(countInserts(sql, 'group_members'), 2);
  assert.equal(countInserts(sql, 'invites'), 1);
  assert.equal(countInserts(sql, 'friendships'), 0);
  assert.equal(countInserts(sql, 'games'), 2);            // one closed + one open
  assert.equal(countInserts(sql, 'game_participants'), 6); // 3 + 3
  assert.equal(countInserts(sql, 'entries'), 8);           // 1 + 1 synthetic + 2, then 2 + 1 + 1
  assert.equal(countInserts(sql, 'transfers'), 1);
  assert.equal(countInserts(sql, 'debts'), 1);             // the orphan debt is skipped
});

test('identities are deduplicated by display name across games, groups and debts', () => {
  const { sql } = convertFixture();
  const guestIds = (sql.match(/^INSERT INTO guests \(id, display_name, created_by\) VALUES \('([0-9a-f-]+)'/gm) || []);
  assert.equal(new Set(guestIds).size, 3);
  // The owner never becomes a guest.
  assert.ok(!/INSERT INTO guests .*'דביר'/.test(sql));
  // The debt reuses או'מר's guest row instead of inventing a second one.
  const omerGuest = converter.uuid5("guest:n:או'מר");
  assert.ok(sql.includes(`INSERT INTO guests (id, display_name, created_by) VALUES ('${omerGuest}'`));
  const debtLine = sql.split('\n').find(line => line.startsWith('INSERT INTO debts '));
  assert.ok(debtLine.includes(omerGuest), 'the debtor must point at the existing guest');
  assert.ok(debtLine.includes(OWNER), 'the creditor is the owner profile');
});

test('ids are deterministic UUIDv5 values, so re-running is idempotent', () => {
  const first = convertFixture().sql;
  const second = convertFixture().sql;
  assert.equal(first, second, 'two runs over the same export must be byte-identical');

  const gameId = converter.uuid5('game:g-1');
  assert.match(gameId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(first.includes(gameId), 'the closed game keeps its derived id');
  assert.ok(first.includes(converter.uuid5('participant:g-1:p-1')));
  assert.ok(first.includes(converter.uuid5('entry:e-1')));
  assert.ok(first.includes(converter.uuid5('group:grp-1')));

  // Every insert is conflict-safe, which is what makes a re-import a no-op.
  for (const line of first.split('\n').filter(l => l.startsWith('INSERT INTO '))) {
    assert.ok(line.endsWith('ON CONFLICT DO NOTHING;'), line);
  }
});

test('every string literal is escaped and no statement spans lines', () => {
  const { sql } = convertFixture();
  sql.split('\n').forEach((line, index) => {
    const quotes = (line.match(/'/g) || []).length;
    assert.equal(quotes % 2, 0, `line ${index + 1} has an unbalanced quote: ${line}`);
  });
  // The apostrophe in או'מר must be doubled, never left bare.
  assert.ok(sql.includes("או''מר"), 'apostrophes must be doubled');
  // Strip every well-formed literal ('...' with '' escapes); nothing may remain.
  const leftovers = sql.split('\n')
    .filter(line => line.startsWith('INSERT INTO '))
    .filter(line => line.replace(/'(?:[^']|'')*'/g, '').includes("'"));
  assert.deepEqual(leftovers, [], 'an apostrophe escaped its string literal');
});

test('lossy conversions are reported instead of invented', () => {
  const { sql, summary, result } = convertFixture();
  // A legacy player with no entry log becomes one timeless entry.
  const synthetic = converter.uuid5('entry:synthetic:g-1:p-2');
  const syntheticLine = sql.split('\n').find(line => line.includes(synthetic));
  assert.ok(syntheticLine.endsWith('100, NULL) ON CONFLICT DO NOTHING;'),
    'a synthesised entry carries the buy-in total and a NULL time');
  assert.ok(result.warnings.some(w => w.includes('no entry log')));
  // A legacy entry with timestamp null keeps a NULL created_at.
  const legacyEntry = converter.uuid5('entry:e-3a');
  assert.ok(sql.split('\n').find(line => line.includes(legacyEntry)).includes(', 50, NULL)'));
  // The orphan debt is dropped loudly.
  assert.ok(result.warnings.some(w => w.includes('not in this export')));
  // The friendship cannot migrate: it needs two accounts.
  assert.equal(result.notes.length, 1);
  assert.ok(sql.includes('-- Not migrated, needs a human:'));
  assert.ok(summary.includes('local-state-to-sql summary:'));
  assert.ok(summary.includes('entries: 8'));
});

test('the open game and the closed game are shaped per schema.sql', () => {
  const { sql } = convertFixture();
  const lines = sql.split('\n');
  const closed = lines.find(line => line.includes(converter.uuid5('game:g-1')) && line.startsWith('INSERT INTO games '));
  assert.ok(closed.includes("'closed'"));
  assert.ok(closed.includes("'2026-08-20T22:00:00.000Z'::timestamptz"), 'closed_at is required for a closed game');
  assert.ok(closed.includes('TRUE, 0,'), 'is_balanced and balance_difference are required for a closed game');
  const open = lines.find(line => line.includes(converter.uuid5('game:g-open')) && line.startsWith('INSERT INTO games '));
  assert.ok(open.includes("'active', '2026-09-01T18:00:00.000Z'::timestamptz, NULL, NULL, NULL,"),
    'an open game has no closed_at and no balance columns');
  // An empty cashout stays NULL ("not entered yet"), never 0.
  const omerOpen = lines.find(line => line.includes(converter.uuid5('participant:g-open:p-open-2')));
  assert.ok(omerOpen.endsWith('NULL) ON CONFLICT DO NOTHING;'));
  // An exited player carries its exit time.
  const yuval = lines.find(line => line.includes(converter.uuid5('participant:g-open:p-open-3')));
  assert.ok(yuval.includes("'exited', COALESCE('2026-09-01T20:00:00.000Z'::timestamptz, now()), 0)"));
});

test('demo state and a missing owner produce nothing dangerous', () => {
  const demo = convertFixture({ ...FIXTURE, example: true, history: [], debts: [], groups: [], groupMembers: [], invites: [], friendships: [] });
  assert.equal(countInserts(demo.sql, 'games'), 0, 'example data is never migrated');
  assert.equal(countInserts(demo.sql, 'profiles'), 1);

  assert.throws(() => converter.run([writeFixture(), '--owner', 'not-a-uuid']), /must be a uuid/);
  assert.throws(() => converter.run([writeFixture()]), /--owner/);
});
