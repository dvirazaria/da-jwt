#!/usr/bin/env node
'use strict';

/**
 * local-state-to-sql.js — convert a `poker-settle-v1` export into SQL inserts
 * that match docs/backend/schema.sql.
 *
 *   node tools/local-state-to-sql.js export.json --owner <profile-uuid> \
 *        [--group-owner-name "דביר"] > import.sql
 *
 * Design rules:
 *   - No dependencies. Node's crypto only.
 *   - Every id is a deterministic UUIDv5 derived from the source id, so the
 *     script can be re-run on the same export (or on a later export of the
 *     same device) and produce the same rows. Combined with
 *     ON CONFLICT DO NOTHING, importing twice is a no-op.
 *   - Statements are emitted in foreign-key order inside one transaction.
 *   - Output is byte-for-byte deterministic: no timestamps, no randomness.
 *   - A summary goes to stderr so stdout stays pure SQL.
 *
 * This tool never runs in the browser and is excluded from the deploy
 * (see .vercelignore).
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

// Fixed namespace for this application. Changing it changes every id.
const NAMESPACE = '2f1c8b64-9a3d-5e17-b8d2-4c6a0f9e7b31';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 40;

// ---------------------------------------------------------------- uuid v5

function uuid5(name, namespace = NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(String(name), 'utf8')]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ------------------------------------------------------------ sql literals

// Doubles every apostrophe and drops NUL and newlines, so a value can never
// escape its literal or split a statement across lines.
function sqlText(value) {
  if (value === null || value === undefined) return 'NULL';
  const text = String(value).replace(/\u0000/g, '').replace(/[\r\n]+/g, ' ');
  return `'${text.replace(/'/g, "''")}'`;
}

function sqlName(value, fallback) {
  const text = String(value === null || value === undefined ? '' : value).trim().slice(0, MAX_NAME);
  return sqlText(text || fallback);
}

function sqlUuid(value) {
  if (!UUID_RE.test(String(value || ''))) throw new Error(`not a uuid: ${value}`);
  return `'${String(value).toLowerCase()}'`;
}

function sqlUuidOrNull(value) {
  return value ? sqlUuid(value) : 'NULL';
}

function sqlTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return 'NULL';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'NULL';
  return `'${date.toISOString()}'::timestamptz`;
}

function sqlInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'NULL';
  return String(Math.round(n));
}

function sqlBool(value) {
  if (value === null || value === undefined) return 'NULL';
  return value ? 'TRUE' : 'FALSE';
}

// --------------------------------------------------------------- cli args

function parseArgs(argv) {
  const options = { file: null, owner: null, ownerName: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--owner') { options.owner = argv[++i]; continue; }
    if (arg === '--group-owner-name') { options.ownerName = argv[++i]; continue; }
    if (arg.startsWith('--owner=')) { options.owner = arg.slice('--owner='.length); continue; }
    if (arg.startsWith('--group-owner-name=')) {
      options.ownerName = arg.slice('--group-owner-name='.length);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    if (options.file) throw new Error('only one input file is supported');
    options.file = arg;
  }
  if (!options.file) throw new Error('missing input file');
  if (!options.owner || !UUID_RE.test(options.owner)) {
    throw new Error('--owner <profile-uuid> is required and must be a uuid');
  }
  options.owner = options.owner.toLowerCase();
  options.ownerName = options.ownerName ? String(options.ownerName).trim() : null;
  return options;
}

// ------------------------------------------------------------- conversion

const TABLE_ORDER = [
  'profiles', 'guests', 'groups', 'group_members', 'invites', 'friendships',
  'games', 'game_participants', 'entries', 'transfers', 'debts',
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function convert(state, options) {
  const rows = new Map(TABLE_ORDER.map(table => [table, new Map()]));
  const notes = [];
  const warnings = [];
  const guestsByKey = new Map();
  const ownerName = options.ownerName;

  function add(table, id, sql) {
    const bucket = rows.get(table);
    if (!bucket.has(id)) bucket.set(id, sql);
  }

  // Keyed by display name first, exactly like resolveGuestId() in the app:
  // "one guestId per displayName on this device". That is also what makes a
  // debt (whose debtorUserId is a per-game player id, useless as a person id)
  // resolve to the same guest as the player row it came from.
  function personKey(guestId, displayName) {
    const name = String(displayName || '').trim();
    if (name) return `n:${name}`;
    return `g:${guestId || 'unknown'}`;
  }

  // Resolves one person to the schema's (profile_id, guest_id) identity pair.
  // The exporting owner becomes the profile; everyone else becomes a guest.
  function identityOf(guestId, displayName) {
    const name = String(displayName || '').trim();
    if (ownerName && name && name === ownerName) {
      return { profileId: options.owner, guestId: null, displayName: name };
    }
    const key = personKey(guestId, name);
    let guest = guestsByKey.get(key);
    if (!guest) {
      guest = { id: uuid5(`guest:${key}`), displayName: name };
      guestsByKey.set(key, guest);
      add('guests', guest.id,
        `INSERT INTO guests (id, display_name, created_by) VALUES (${sqlUuid(guest.id)}, ${sqlName(name, 'אורח')}, ${sqlUuid(options.owner)}) ON CONFLICT DO NOTHING;`);
    }
    return { profileId: null, guestId: guest.id, displayName: name || guest.displayName };
  }

  function identityOfRef(ref) {
    if (!ref || typeof ref !== 'object') return null;
    return identityOf(ref.guestId, ref.displayName);
  }

  // 1. the exporting owner's profile
  add('profiles', options.owner,
    `INSERT INTO profiles (id, display_name) VALUES (${sqlUuid(options.owner)}, ${sqlName(ownerName, 'Owner')}) ON CONFLICT DO NOTHING;`);

  // 2. groups
  const groupIds = new Set();
  for (const group of asArray(state.groups)) {
    if (!group || !group.id) continue;
    const id = uuid5(`group:${group.id}`);
    groupIds.add(String(group.id));
    add('groups', id,
      `INSERT INTO groups (id, name, created_by_profile_id, created_at, archived_at, deleted_at) VALUES (${sqlUuid(id)}, ${sqlName(group.name, 'קבוצה')}, ${sqlUuid(options.owner)}, COALESCE(${sqlTimestamp(group.createdAt)}, now()), ${sqlTimestamp(group.archivedAt)}, ${sqlTimestamp(group.deletedAt)}) ON CONFLICT DO NOTHING;`);
  }

  function groupUuid(sourceGroupId) {
    if (!sourceGroupId) return null;
    if (!groupIds.has(String(sourceGroupId))) {
      warnings.push(`group ${sourceGroupId} is referenced but missing from the export - the reference is dropped`);
      return null;
    }
    return uuid5(`group:${sourceGroupId}`);
  }

  // 3. group members
  for (const member of asArray(state.groupMembers)) {
    if (!member || !member.id) continue;
    const group = groupUuid(member.groupId);
    if (!group) continue;
    const id = uuid5(`member:${member.id}`);
    const identity = identityOf(member.guestId, member.displayName);
    const status = ['active', 'left', 'removed'].includes(member.status) ? member.status : 'active';
    const leftAt = status === 'active' ? 'NULL' : `COALESCE(${sqlTimestamp(member.leftAt)}, now())`;
    add('group_members', id,
      `INSERT INTO group_members (id, group_id, profile_id, guest_id, display_name_snapshot, role, status, joined_at, left_at) VALUES (${sqlUuid(id)}, ${sqlUuid(group)}, ${sqlUuidOrNull(identity.profileId)}, ${sqlUuidOrNull(identity.guestId)}, ${sqlName(identity.displayName, 'אורח')}, ${sqlText(member.role === 'admin' ? 'admin' : 'member')}, ${sqlText(status)}, COALESCE(${sqlTimestamp(member.joinedAt)}, now()), ${leftAt}) ON CONFLICT DO NOTHING;`);
  }

  // 4. invites
  for (const invite of asArray(state.invites)) {
    if (!invite || !invite.id || !invite.token) continue;
    const group = groupUuid(invite.groupId);
    if (!group) continue;
    const id = uuid5(`invite:${invite.id}`);
    add('invites', id,
      `INSERT INTO invites (id, group_id, token, created_by_profile_id, created_at, revoked_at, expires_at) VALUES (${sqlUuid(id)}, ${sqlUuid(group)}, ${sqlText(invite.token)}, ${sqlUuid(options.owner)}, COALESCE(${sqlTimestamp(invite.createdAt)}, now()), ${sqlTimestamp(invite.revokedAt)}, NULL) ON CONFLICT DO NOTHING;`);
  }

  // 5. friendships — both sides must be real accounts, which pre-backend
  //    only the owner is. Unmigratable rows are listed as SQL comments.
  for (const friendship of asArray(state.friendships)) {
    if (!friendship || !friendship.id) continue;
    const requester = identityOfRef(friendship.requester);
    const addressee = identityOfRef(friendship.addressee);
    if (!requester || !addressee || !requester.profileId || !addressee.profileId
        || requester.profileId === addressee.profileId) {
      notes.push(`friendship ${sqlText(friendship.id)} between ${sqlText(requester ? requester.displayName : '?')} and ${sqlText(addressee ? addressee.displayName : '?')} needs two accounts - recreate it after both sign in`);
      continue;
    }
    const id = uuid5(`friendship:${friendship.id}`);
    const status = ['pending', 'accepted', 'rejected'].includes(friendship.status) ? friendship.status : 'pending';
    const respondedAt = status === 'pending' ? 'NULL' : `COALESCE(${sqlTimestamp(friendship.respondedAt)}, now())`;
    add('friendships', id,
      `INSERT INTO friendships (id, requester_profile_id, addressee_profile_id, status, created_at, responded_at) VALUES (${sqlUuid(id)}, ${sqlUuid(requester.profileId)}, ${sqlUuid(addressee.profileId)}, ${sqlText(status)}, COALESCE(${sqlTimestamp(friendship.createdAt)}, now()), ${respondedAt}) ON CONFLICT DO NOTHING;`);
  }

  // 6. games — every closed history entry, plus the open game if there is one
  const participantsByGame = new Map();

  function addGame(source) {
    const gameId = uuid5(`game:${source.sourceGameId}`);
    const leader = identityOfRef(source.leaderRef);
    // schema.sql: a closed game must have closed_at, an open one must not.
    const closedAt = source.phase === 'closed'
      ? `COALESCE(${sqlTimestamp(source.closedAt)}, now())`
      : 'NULL';
    add('games', gameId,
      `INSERT INTO games (id, group_id, leader_profile_id, leader_guest_id, phase, started_at, closed_at, is_balanced, balance_difference, created_by) VALUES (${sqlUuid(gameId)}, ${sqlUuidOrNull(source.groupUuid)}, ${sqlUuidOrNull(leader && leader.profileId)}, ${sqlUuidOrNull(leader && leader.guestId)}, ${sqlText(source.phase)}, ${sqlTimestamp(source.startedAt)}, ${closedAt}, ${source.isBalanced}, ${source.balanceDifference}, ${sqlUuid(options.owner)}) ON CONFLICT DO NOTHING;`);
    participantsByGame.set(source.sourceGameId, new Map());
    return gameId;
  }

  function addParticipant(sourceGameId, gameId, player, cashoutSql) {
    const participantId = uuid5(`participant:${sourceGameId}:${player.id}`);
    const identity = identityOf(player.guestId, player.name);
    const status = player.status === 'exited' ? 'exited' : 'active';
    const exitedAt = status === 'exited' ? `COALESCE(${sqlTimestamp(player.exitedAt)}, now())` : 'NULL';
    add('game_participants', participantId,
      `INSERT INTO game_participants (id, game_id, profile_id, guest_id, display_name_snapshot, status, exited_at, cashout) VALUES (${sqlUuid(participantId)}, ${sqlUuid(gameId)}, ${sqlUuidOrNull(identity.profileId)}, ${sqlUuidOrNull(identity.guestId)}, ${sqlName(identity.displayName, 'שחקן')}, ${sqlText(status)}, ${exitedAt}, ${cashoutSql}) ON CONFLICT DO NOTHING;`);
    participantsByGame.get(sourceGameId).set(String(player.name || '').trim(), participantId);
    return participantId;
  }

  function addEntries(sourceGameId, gameId, participantId, player, fallbackTotal) {
    const log = asArray(player.entryLog);
    if (log.length) {
      for (const entry of log) {
        if (!entry) continue;
        const amount = Math.round(Number(entry.amount) || 0);
        if (amount <= 0) continue;
        const id = uuid5(`entry:${entry.id || `${sourceGameId}:${player.id}:${amount}`}`);
        add('entries', id,
          `INSERT INTO entries (id, game_id, participant_id, amount, created_at) VALUES (${sqlUuid(id)}, ${sqlUuid(gameId)}, ${sqlUuid(participantId)}, ${amount}, ${sqlTimestamp(entry.timestamp)}) ON CONFLICT DO NOTHING;`);
      }
      return;
    }
    const total = Math.round(Number(fallbackTotal) || 0);
    if (total <= 0) return;
    // Legacy history row with a buy-in sum but no log: one synthetic,
    // timeless entry so the totals still add up. Documented as lossy.
    const id = uuid5(`entry:synthetic:${sourceGameId}:${player.id}`);
    warnings.push(`game ${sourceGameId}: player ${String(player.name || '')} had no entry log - collapsed ${total} into one timeless entry`);
    add('entries', id,
      `INSERT INTO entries (id, game_id, participant_id, amount, created_at) VALUES (${sqlUuid(id)}, ${sqlUuid(gameId)}, ${sqlUuid(participantId)}, ${total}, NULL) ON CONFLICT DO NOTHING;`);
  }

  const closedGameIds = new Set();
  for (const historyEntry of asArray(state.history)) {
    if (!historyEntry || !historyEntry.gameId) continue;
    const sourceGameId = String(historyEntry.gameId);
    if (closedGameIds.has(sourceGameId)) continue;
    closedGameIds.add(sourceGameId);
    const gameId = addGame({
      sourceGameId,
      groupUuid: groupUuid(historyEntry.groupId),
      phase: 'closed',
      startedAt: historyEntry.startedAt,
      closedAt: historyEntry.at,
      isBalanced: sqlBool(historyEntry.isBalanced !== false),
      balanceDifference: sqlInt(historyEntry.balanceDifference || 0),
      leaderRef: historyEntry.leaderRef,
    });
    for (const player of asArray(historyEntry.players)) {
      if (!player || !player.id) continue;
      const participantId = addParticipant(sourceGameId, gameId, player, sqlInt(player.cashout || 0));
      addEntries(sourceGameId, gameId, participantId, player, player.buyin);
    }
    const byName = participantsByGame.get(sourceGameId);
    asArray(historyEntry.transfers).forEach((transfer, index) => {
      if (!transfer || !transfer.id) return;
      const from = byName.get(String(transfer.from || '').trim());
      const to = byName.get(String(transfer.to || '').trim());
      if (Math.round(Number(transfer.amount) || 0) <= 0) {
        warnings.push(`game ${sourceGameId}: a transfer has a non-positive amount - skipped`);
        return;
      }
      if (!from || !to || from === to) {
        warnings.push(`game ${sourceGameId}: a transfer has no matching participants - skipped`);
        return;
      }
      const id = uuid5(`transfer:${transfer.id}`);
      add('transfers', id,
        `INSERT INTO transfers (id, game_id, from_participant_id, to_participant_id, amount, status, settlement_key, sort_order) VALUES (${sqlUuid(id)}, ${sqlUuid(gameId)}, ${sqlUuid(from)}, ${sqlUuid(to)}, ${sqlInt(transfer.amount)}, ${sqlText(transfer.status === 'paid' ? 'paid' : 'open')}, ${sqlText(transfer.id)}, ${index}) ON CONFLICT DO NOTHING;`);
    });
  }

  // the one open game, if the export has a real (non-demo) one
  const openPlayers = asArray(state.players);
  if (!state.example && state.phase !== 'closed' && openPlayers.length && state.gameId) {
    const sourceGameId = String(state.gameId);
    if (!closedGameIds.has(sourceGameId)) {
      const gameId = addGame({
        sourceGameId,
        groupUuid: groupUuid(state.groupId),
        phase: state.phase === 'settlement' ? 'settlement' : 'active',
        startedAt: state.startedAt,
        closedAt: null,
        isBalanced: 'NULL',
        balanceDifference: 'NULL',
        leaderRef: state.leaderRef,
      });
      for (const player of openPlayers) {
        if (!player || !player.id) continue;
        const cashout = player.cashout === '' || player.cashout === null || player.cashout === undefined
          ? 'NULL' : sqlInt(player.cashout);
        const participantId = addParticipant(sourceGameId, gameId, player, cashout);
        const buyinTotal = asArray(player.buyins).reduce((a, b) => a + (Number(b) || 0), 0);
        addEntries(sourceGameId, gameId, participantId, player, buyinTotal);
      }
      if (state.settlementStatuses && Object.keys(state.settlementStatuses).length) {
        notes.push('the open game has paid toggles (settlementStatuses); transfers only exist once the table is closed, so those toggles are not migrated');
      }
    }
  }

  // 7. debts
  for (const debt of asArray(state.debts)) {
    if (!debt || !debt.id) continue;
    const sourceGameId = String(debt.gameId || '');
    if (!closedGameIds.has(sourceGameId)) {
      warnings.push(`debt ${debt.id} points at a game that is not in this export - skipped`);
      continue;
    }
    if (!debt.debtorName || !debt.creditorName || debt.debtorName === debt.creditorName) {
      warnings.push(`debt ${debt.id} has no usable debtor/creditor names - skipped`);
      continue;
    }
    if (Math.round(Number(debt.amount) || 0) <= 0) {
      warnings.push(`debt ${debt.id} has a non-positive amount - skipped`);
      continue;
    }
    // debtorUserId/creditorUserId are per-game player ids, not stable person
    // ids, so identity is resolved by name — the same rule the app uses today.
    const debtor = identityOf(null, debt.debtorName);
    const creditor = identityOf(null, debt.creditorName);
    const id = uuid5(`debt:${debt.id}`);
    const paid = debt.status === 'paid';
    add('debts', id,
      `INSERT INTO debts (id, game_id, group_id, debtor_profile_id, debtor_guest_id, creditor_profile_id, creditor_guest_id, debtor_name, creditor_name, amount, status, created_at, game_date, paid_at) VALUES (${sqlUuid(id)}, ${sqlUuid(uuid5(`game:${sourceGameId}`))}, ${sqlUuidOrNull(groupUuid(debt.groupId))}, ${sqlUuidOrNull(debtor.profileId)}, ${sqlUuidOrNull(debtor.guestId)}, ${sqlUuidOrNull(creditor.profileId)}, ${sqlUuidOrNull(creditor.guestId)}, ${sqlName(debt.debtorName, 'שחקן')}, ${sqlName(debt.creditorName, 'שחקן')}, ${sqlInt(debt.amount)}, ${sqlText(paid ? 'paid' : 'open')}, COALESCE(${sqlTimestamp(debt.createdAt)}, now()), ${sqlTimestamp(debt.gameDate)}, ${paid ? `COALESCE(${sqlTimestamp(debt.paidAt)}, now())` : 'NULL'}) ON CONFLICT DO NOTHING;`);
  }

  return { rows, notes, warnings };
}

// ----------------------------------------------------------------- output

function render(result) {
  const lines = [];
  lines.push('-- Generated by tools/local-state-to-sql.js from a poker-settle-v1 export.');
  lines.push('-- Apply docs/backend/schema.sql first. Re-running this file is a no-op.');
  lines.push('BEGIN;');
  lines.push('SET standard_conforming_strings = on;');
  for (const table of TABLE_ORDER) {
    const bucket = result.rows.get(table);
    if (!bucket || bucket.size === 0) continue;
    lines.push('');
    lines.push(`-- ${table} (${bucket.size})`);
    for (const sql of bucket.values()) lines.push(sql);
  }
  if (result.notes.length) {
    lines.push('');
    lines.push('-- Not migrated, needs a human:');
    for (const note of result.notes) lines.push(`--   ${note}`);
  }
  lines.push('');
  lines.push('COMMIT;');
  lines.push('');
  return lines.join('\n');
}

function summarize(result) {
  const lines = ['local-state-to-sql summary:'];
  for (const table of TABLE_ORDER) {
    const bucket = result.rows.get(table);
    lines.push(`  ${table}: ${bucket ? bucket.size : 0}`);
  }
  if (result.warnings.length) {
    lines.push(`  warnings: ${result.warnings.length}`);
    for (const warning of result.warnings) lines.push(`    ! ${warning}`);
  }
  if (result.notes.length) lines.push(`  manual follow-ups: ${result.notes.length}`);
  return lines.join('\n');
}

function run(argv) {
  const options = parseArgs(argv);
  const raw = JSON.parse(fs.readFileSync(options.file, 'utf8'));
  const state = raw && !Array.isArray(raw.players) && raw.state ? raw.state : raw;
  if (!state || typeof state !== 'object') {
    throw new Error('the export does not look like a poker-settle-v1 state object');
  }
  const result = convert(state, options);
  return { sql: render(result), summary: summarize(result), result };
}

if (require.main === module) {
  try {
    const { sql, summary } = run(process.argv.slice(2));
    process.stdout.write(sql);
    process.stderr.write(`${summary}\n`);
  } catch (error) {
    process.stderr.write(`local-state-to-sql: ${error.message}\n`);
    process.stderr.write('usage: node tools/local-state-to-sql.js <export.json> --owner <profile-uuid> [--group-owner-name "שם"]\n');
    process.exit(1);
  }
}

module.exports = { run, convert, render, uuid5, sqlText, TABLE_ORDER };
