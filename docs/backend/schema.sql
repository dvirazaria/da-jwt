-- =====================================================================
-- "סוגרים קופה" — backend schema (standard PostgreSQL 15+)
-- =====================================================================
-- Portability contract:
--   * Everything in this file is vendor-neutral Postgres. There is no
--     auth.uid(), no auth.users, no storage.*, no supabase_* role.
--   * Row-level-security policies, grants and the per-user money views
--     live in rls-policies.sql, which is the ONLY file with a marked
--     Supabase-specific section.
--   * Only profiles.id is meant to equal the auth provider's user id.
--     That single column is the whole coupling to the auth vendor
--     (see docs/backend/platform-research.md §5 "דרך היציאה").
--
-- Requires PostgreSQL 15 or newer: views are created WITH
-- (security_invoker = true) so RLS on the base tables also applies to
-- anyone selecting from the view. Without that flag a view runs with the
-- owner's rights and silently bypasses every policy.
--
-- Money is integer ILS everywhere (frontend `wholeMoney`). Never numeric,
-- never float: settlement is exact integer arithmetic by product rule.
-- =====================================================================

-- gen_random_uuid() is built in from PG 13. Kept for older servers.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- 0. Shared helpers
-- ---------------------------------------------------------------------

-- Mirrors identityKey(ref) in kupa-sgura.html: a registered person wins
-- over a guest row, so an identity has exactly one key. IMMUTABLE so it
-- can be used inside indexes and generated columns.
CREATE OR REPLACE FUNCTION identity_key(p_profile_id uuid, p_guest_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN p_profile_id IS NOT NULL THEN 'u:' || p_profile_id::text
           WHEN p_guest_id   IS NOT NULL THEN 'g:' || p_guest_id::text
           ELSE NULL
         END
$$;
COMMENT ON FUNCTION identity_key(uuid, uuid) IS
  'Canonical identity key for the (profile_id, guest_id) pair pattern; mirrors identityKey() in the frontend.';

CREATE OR REPLACE FUNCTION app_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 1. Identity: profiles + guests
-- ---------------------------------------------------------------------
-- THE IDENTITY PATTERN (used by group_members, game_participants, debts,
-- games.leader_*): every table that points at a *person* carries
--     profile_id uuid NULL REFERENCES profiles(id)
--     guest_id   uuid NULL REFERENCES guests(id)
--     CHECK (num_nonnulls(profile_id, guest_id) = 1)
-- so a row always names exactly one identity, and a guest can later be
-- merged into an account by setting guests.linked_profile_id without
-- rewriting a single historical row.

CREATE TABLE IF NOT EXISTS profiles (
  id           uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 40),
  phone        text UNIQUE,
  email        text UNIQUE,
  avatar_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE profiles IS 'One row per signed-in person; id equals the auth provider user id and is the only vendor coupling point.';
COMMENT ON COLUMN profiles.id IS 'Supabase adds REFERENCES auth.users(id) ON DELETE CASCADE here — see rls-policies.sql; portable deployments seed the same uuid from their own auth store.';

CREATE TABLE IF NOT EXISTS guests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name      text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 40),
  created_by        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  linked_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  linked_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guests_link_pair_chk CHECK ((linked_profile_id IS NULL) = (linked_at IS NULL))
);
COMMENT ON TABLE guests IS 'A person who plays but has no account yet; linked_profile_id is the guest-to-account merge, applied once and never rewriting history rows.';

CREATE INDEX IF NOT EXISTS guests_created_by_idx        ON guests (created_by);
CREATE INDEX IF NOT EXISTS guests_linked_profile_id_idx ON guests (linked_profile_id) WHERE linked_profile_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Groups, membership, invites, friends
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS groups (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  avatar_url            text,
  created_by_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  deleted_at            timestamptz
);
COMMENT ON TABLE groups IS 'A poker group; archived_at hides it from the dashboard and deleted_at is a soft delete — rows are never hard-deleted so history keeps its group.';
COMMENT ON COLUMN groups.avatar_url IS 'Object-storage URL; the local app stores a 96x96 data URL in avatarDataUrl, which the migration does NOT carry over.';

CREATE INDEX IF NOT EXISTS groups_created_by_idx ON groups (created_by_profile_id);
CREATE INDEX IF NOT EXISTS groups_visible_idx    ON groups (id) WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS group_members (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id              uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  profile_id            uuid REFERENCES profiles(id) ON DELETE CASCADE,
  guest_id              uuid REFERENCES guests(id) ON DELETE CASCADE,
  display_name_snapshot text NOT NULL,
  role                  text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left', 'removed')),
  joined_at             timestamptz NOT NULL DEFAULT now(),
  left_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_members_identity_chk CHECK (num_nonnulls(profile_id, guest_id) = 1),
  CONSTRAINT group_members_left_at_chk  CHECK (status = 'active' OR left_at IS NOT NULL),
  CONSTRAINT group_members_active_chk   CHECK (status <> 'active' OR left_at IS NULL)
);
COMMENT ON TABLE group_members IS 'Membership of one identity in one group; former members are kept (status left/removed) because the leaderboard still counts their closed games.';
COMMENT ON COLUMN group_members.display_name_snapshot IS 'Name as of joining, so a rename never rewrites old group screens.';

-- One ACTIVE membership per identity per group; leaving and re-joining
-- is allowed and produces a second, historical row.
CREATE UNIQUE INDEX IF NOT EXISTS group_members_active_profile_uk
  ON group_members (group_id, profile_id) WHERE status = 'active' AND profile_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS group_members_active_guest_uk
  ON group_members (group_id, guest_id)   WHERE status = 'active' AND guest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS group_members_group_idx   ON group_members (group_id);
CREATE INDEX IF NOT EXISTS group_members_profile_idx ON group_members (profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_members_guest_idx   ON group_members (guest_id)   WHERE guest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_members_identity_idx
  ON group_members (group_id, identity_key(profile_id, guest_id));

-- NOTE: "a group always has at least one admin" cannot be expressed
-- declaratively without a deferred constraint trigger. It is enforced in
-- the admin-only UPDATE path (rls-policies.sql) and in the app.

CREATE TABLE IF NOT EXISTS invites (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id              uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  token                 text NOT NULL UNIQUE CHECK (length(token) >= 8),
  created_by_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  expires_at            timestamptz
);
COMMENT ON TABLE invites IS 'Join link/QR/code for a group; expires_at NULL means it never expires, revoked_at kills it immediately.';
COMMENT ON COLUMN invites.token IS 'Opaque high-entropy string. Redemption goes through a SECURITY DEFINER function because the joiner is not yet a member and cannot read the group.';

CREATE INDEX IF NOT EXISTS invites_group_idx  ON invites (group_id);
CREATE INDEX IF NOT EXISTS invites_active_idx  ON invites (group_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS friendships (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  addressee_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  responded_at         timestamptz,
  CONSTRAINT friendships_not_self_chk   CHECK (requester_profile_id <> addressee_profile_id),
  CONSTRAINT friendships_responded_chk  CHECK ((status = 'pending') = (responded_at IS NULL))
);
COMMENT ON TABLE friendships IS 'Directed friend request between two accounts; the unique pair index makes the relation effectively undirected.';

-- One relation per unordered pair, whoever asked first.
CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_uk
  ON friendships (least(requester_profile_id, addressee_profile_id),
                  greatest(requester_profile_id, addressee_profile_id));
CREATE INDEX IF NOT EXISTS friendships_addressee_idx ON friendships (addressee_profile_id, status);
CREATE INDEX IF NOT EXISTS friendships_requester_idx ON friendships (requester_profile_id, status);

-- ---------------------------------------------------------------------
-- 3. Games
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS games (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id           uuid REFERENCES groups(id) ON DELETE SET NULL,
  leader_profile_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  leader_guest_id    uuid REFERENCES guests(id)   ON DELETE SET NULL,
  phase              text NOT NULL DEFAULT 'active' CHECK (phase IN ('active', 'settlement', 'closed')),
  started_at         timestamptz,
  closed_at          timestamptz,
  is_balanced        boolean,
  balance_difference integer,
  created_by         uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT games_leader_identity_chk CHECK (num_nonnulls(leader_profile_id, leader_guest_id) <= 1),
  CONSTRAINT games_closed_at_chk       CHECK ((phase = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT games_closed_balance_chk  CHECK (phase <> 'closed'
                                              OR (is_balanced IS NOT NULL AND balance_difference IS NOT NULL))
);
COMMENT ON TABLE games IS 'One poker table; group_id NULL is an ad-hoc game ("משחק ללא קבוצה"), and only a closed game is immutable and eligible for the leaderboard.';
COMMENT ON COLUMN games.balance_difference IS 'Integer buy-ins minus cashouts at close; positive means money is missing, negative means excess. 0 on a normal balanced close.';
COMMENT ON COLUMN games.phase IS 'active -> settlement -> closed. Only the closed transition writes transfers and debts.';

-- THE single-open-game rule, moved from the frontend limitation to the DB.
-- A group can have at most one game that is not closed; ad-hoc games
-- (group_id NULL) are unconstrained because they are per-device.
CREATE UNIQUE INDEX IF NOT EXISTS games_one_open_per_group_uk
  ON games (group_id) WHERE group_id IS NOT NULL AND phase <> 'closed';

CREATE INDEX IF NOT EXISTS games_group_closed_idx ON games (group_id, closed_at DESC) WHERE phase = 'closed';
CREATE INDEX IF NOT EXISTS games_open_idx         ON games (group_id) WHERE phase <> 'closed';
CREATE INDEX IF NOT EXISTS games_created_by_idx   ON games (created_by);

CREATE TABLE IF NOT EXISTS game_participants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id               uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  profile_id            uuid REFERENCES profiles(id) ON DELETE RESTRICT,
  guest_id              uuid REFERENCES guests(id)   ON DELETE RESTRICT,
  display_name_snapshot text NOT NULL CHECK (length(btrim(display_name_snapshot)) BETWEEN 1 AND 40),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exited')),
  exited_at             timestamptz,
  cashout               integer CHECK (cashout IS NULL OR cashout >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_participants_identity_chk CHECK (num_nonnulls(profile_id, guest_id) = 1),
  CONSTRAINT game_participants_exit_chk     CHECK ((status = 'exited') = (exited_at IS NOT NULL)),
  -- FK target for the composite keys on entries and transfers, so a child
  -- row can never point at a participant of a different game.
  CONSTRAINT game_participants_game_uk UNIQUE (id, game_id)
);
COMMENT ON TABLE game_participants IS 'A person seated at one game; cashout NULL means "not entered yet", 0 means "cashed out with nothing".';
COMMENT ON COLUMN game_participants.status IS 'exited = left mid-game with a cashout ("יציאה"); the row and its entries stay in the settlement math.';

CREATE UNIQUE INDEX IF NOT EXISTS game_participants_profile_uk
  ON game_participants (game_id, profile_id) WHERE profile_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS game_participants_guest_uk
  ON game_participants (game_id, guest_id)   WHERE guest_id IS NOT NULL;
-- The frontend rejects duplicate names at a table; keep that invariant here.
CREATE UNIQUE INDEX IF NOT EXISTS game_participants_name_uk
  ON game_participants (game_id, display_name_snapshot);

CREATE INDEX IF NOT EXISTS game_participants_game_idx     ON game_participants (game_id);
CREATE INDEX IF NOT EXISTS game_participants_profile_idx  ON game_participants (profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS game_participants_guest_idx    ON game_participants (guest_id)   WHERE guest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS game_participants_identity_idx ON game_participants (identity_key(profile_id, guest_id));

CREATE TABLE IF NOT EXISTS entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id        uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  amount         integer NOT NULL CHECK (amount > 0),
  created_at     timestamptz,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  CONSTRAINT entries_participant_fk FOREIGN KEY (participant_id, game_id)
    REFERENCES game_participants (id, game_id) ON DELETE CASCADE
);
COMMENT ON TABLE entries IS 'Append-only buy-in/rebuy log; the sum per participant is the single source of truth for buy-in totals (there is no denormalised buyin column anywhere).';
COMMENT ON COLUMN entries.created_at IS 'When the buy-in happened. NULL for legacy rows migrated from local state that never recorded a time — never invent one; the UI shows a dash.';
COMMENT ON COLUMN entries.recorded_at IS 'Server insert time, always present. Use this for ordering and realtime, created_at for display.';

CREATE INDEX IF NOT EXISTS entries_game_idx        ON entries (game_id, recorded_at);
CREATE INDEX IF NOT EXISTS entries_participant_idx ON entries (participant_id);

-- ---------------------------------------------------------------------
-- 4. Results — a VIEW, deliberately not a table
-- ---------------------------------------------------------------------
-- Why a view and not a materialised game_results table written on close:
--   1. One source of truth. buy-in total = SUM(entries.amount) and net =
--      cashout - buy-in total. A stored copy can drift from entries; the
--      product's whole correctness claim is that the settlement equals the
--      entry log.
--   2. Closed games are immutable (RLS + triggers below), so for the rows
--      that matter the view is effectively frozen anyway.
--   3. Cheap: entries per game are dozens of rows, not millions.
-- If a group ever grows past the point where this is slow, replace it with
-- a MATERIALIZED VIEW refreshed on close, or a table written by the same
-- transaction that sets phase='closed' — the shape stays identical.

CREATE OR REPLACE VIEW game_results_v
WITH (security_invoker = true) AS
SELECT
  gp.game_id,
  gp.id                                              AS participant_id,
  gp.profile_id,
  gp.guest_id,
  identity_key(gp.profile_id, gp.guest_id)           AS identity_key,
  gp.display_name_snapshot                           AS display_name,
  gp.status,
  COALESCE(e.buyin_total, 0)::integer                AS buyin_total,
  gp.cashout,
  (COALESCE(gp.cashout, 0) - COALESCE(e.buyin_total, 0))::integer AS net
FROM game_participants gp
LEFT JOIN (
  SELECT participant_id, SUM(amount)::integer AS buyin_total
  FROM entries
  GROUP BY participant_id
) e ON e.participant_id = gp.id;
COMMENT ON VIEW game_results_v IS 'Per-participant buy-in total, cashout and net, derived from entries — the only place net is computed.';

-- ---------------------------------------------------------------------
-- 5. Settlement output: transfers + debts
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  from_participant_id uuid NOT NULL,
  to_participant_id   uuid NOT NULL,
  amount              integer NOT NULL CHECK (amount > 0),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid')),
  settlement_key      text NOT NULL,
  sort_order          integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfers_distinct_chk CHECK (from_participant_id <> to_participant_id),
  CONSTRAINT transfers_key_uk       UNIQUE (game_id, settlement_key),
  CONSTRAINT transfers_from_fk FOREIGN KEY (from_participant_id, game_id)
    REFERENCES game_participants (id, game_id) ON DELETE CASCADE,
  CONSTRAINT transfers_to_fk   FOREIGN KEY (to_participant_id, game_id)
    REFERENCES game_participants (id, game_id) ON DELETE CASCADE
);
COMMENT ON TABLE transfers IS 'The minimal set of "who pays whom" moves for a game; status is a reversible paid toggle while the game is open and freezes on close.';
COMMENT ON COLUMN transfers.settlement_key IS 'Stable key mirroring settlementKey(gameId, move, index) = gameId::index::from::to::amount, so a re-computed settlement keeps the existing toggles.';

CREATE INDEX IF NOT EXISTS transfers_game_idx ON transfers (game_id, sort_order);

CREATE TABLE IF NOT EXISTS debts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id              uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  group_id             uuid REFERENCES groups(id) ON DELETE SET NULL,
  transfer_id          uuid UNIQUE REFERENCES transfers(id) ON DELETE SET NULL,
  debtor_profile_id    uuid REFERENCES profiles(id) ON DELETE CASCADE,
  debtor_guest_id      uuid REFERENCES guests(id)   ON DELETE CASCADE,
  creditor_profile_id  uuid REFERENCES profiles(id) ON DELETE CASCADE,
  creditor_guest_id    uuid REFERENCES guests(id)   ON DELETE CASCADE,
  debtor_name          text NOT NULL,
  creditor_name        text NOT NULL,
  amount               integer NOT NULL CHECK (amount > 0),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  game_date            timestamptz,
  paid_at              timestamptz,
  paid_by_profile_id   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  CONSTRAINT debts_debtor_identity_chk   CHECK (num_nonnulls(debtor_profile_id, debtor_guest_id) = 1),
  CONSTRAINT debts_creditor_identity_chk CHECK (num_nonnulls(creditor_profile_id, creditor_guest_id) = 1),
  CONSTRAINT debts_distinct_chk CHECK (identity_key(debtor_profile_id, debtor_guest_id)
                                    <> identity_key(creditor_profile_id, creditor_guest_id)),
  CONSTRAINT debts_paid_chk CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);
COMMENT ON TABLE debts IS 'Created at close for UNPAID transfers only; marking one paid never changes the poker result, and only the creditor may do it.';
COMMENT ON COLUMN debts.debtor_name IS 'Name snapshot at close — the profile screen matches on it today and keeps working after accounts arrive.';

CREATE INDEX IF NOT EXISTS debts_game_idx     ON debts (game_id);
CREATE INDEX IF NOT EXISTS debts_group_idx    ON debts (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS debts_debtor_idx   ON debts (debtor_profile_id)   WHERE debtor_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS debts_creditor_idx ON debts (creditor_profile_id) WHERE creditor_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS debts_open_idx     ON debts (status) WHERE status = 'open';

-- ---------------------------------------------------------------------
-- 6. Leaderboard views
-- ---------------------------------------------------------------------
-- Ranking rule (identical to buildLeaderboard in the frontend):
--   order by total net desc, then games_played desc, then display_name;
--   rank() is computed on net alone, so an exact net tie shares a rank.
-- Eligibility: the identity must have a group_members row for that group,
--   in ANY status — a former member keeps their history, an ad-hoc guest
--   who never joined is excluded.
--
-- PRIVACY: group_leaderboard_v exposes `net`. The API layer must NOT hand
-- that column to other members. rls-policies.sql revokes it from the
-- application role and grants only group_leaderboard_public_v (below,
-- no money columns) plus a per-user my_group_stats_v.

CREATE OR REPLACE VIEW group_leaderboard_v
WITH (security_invoker = true) AS
WITH closed_games AS (
  SELECT g.id AS game_id, g.group_id, g.closed_at
  FROM games g
  WHERE g.phase = 'closed' AND g.group_id IS NOT NULL
),
rows_per_game AS (
  SELECT c.group_id, c.game_id, c.closed_at,
         r.participant_id, r.identity_key, r.display_name, r.net
  FROM closed_games c
  JOIN game_results_v r ON r.game_id = c.game_id
  WHERE r.identity_key IS NOT NULL
),
winners AS (
  SELECT participant_id
  FROM (
    SELECT participant_id, net, max(net) OVER (PARTITION BY game_id) AS best_net
    FROM rows_per_game
  ) t
  WHERE t.net = t.best_net
),
members AS (
  SELECT m.group_id,
         identity_key(m.profile_id, m.guest_id) AS identity_key,
         bool_or(m.status = 'active')           AS is_active_member
  FROM group_members m
  GROUP BY 1, 2
),
aggregated AS (
  SELECT r.group_id,
         r.identity_key,
         (array_agg(r.display_name ORDER BY r.closed_at DESC NULLS LAST))[1] AS display_name,
         count(*)::integer                 AS games_played,
         count(w.participant_id)::integer  AS wins,
         sum(r.net)::integer               AS net
  FROM rows_per_game r
  LEFT JOIN winners w ON w.participant_id = r.participant_id
  GROUP BY r.group_id, r.identity_key
)
SELECT
  a.group_id,
  a.identity_key,
  a.display_name,
  a.games_played,
  a.wins,
  a.net,
  NOT m.is_active_member AS is_former_member,
  rank()       OVER (PARTITION BY a.group_id ORDER BY a.net DESC)                                            AS rank,
  row_number() OVER (PARTITION BY a.group_id ORDER BY a.net DESC, a.games_played DESC, a.display_name ASC)    AS display_order
FROM aggregated a
JOIN members m ON m.group_id = a.group_id AND m.identity_key = a.identity_key;
COMMENT ON VIEW group_leaderboard_v IS 'PRIVILEGED: cumulative net per identity per group over closed games. Never grant to the application role — use group_leaderboard_public_v.';

CREATE OR REPLACE VIEW group_leaderboard_public_v
WITH (security_invoker = true) AS
SELECT group_id, identity_key, display_name, games_played, wins, is_former_member, rank, display_order
FROM group_leaderboard_v;
COMMENT ON VIEW group_leaderboard_public_v IS 'Member-safe leaderboard: rank, games and wins with no money column — matches LeaderboardEntry in the frontend.';

-- ---------------------------------------------------------------------
-- 7. Immutability of a closed game (defence in depth)
-- ---------------------------------------------------------------------
-- RLS expresses the same rule, but RLS is bypassed by the table owner and
-- by a service role key. These triggers are not.

CREATE OR REPLACE FUNCTION app_assert_game_open()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_phase text;
  v_game  uuid;
BEGIN
  -- NEW is unassigned on DELETE and OLD on INSERT: never COALESCE them.
  IF TG_OP = 'DELETE' THEN v_game := OLD.game_id; ELSE v_game := NEW.game_id; END IF;
  SELECT g.phase INTO v_phase FROM games g WHERE g.id = v_game;
  IF v_phase = 'closed' THEN
    RAISE EXCEPTION 'game % is closed; % on % is not allowed', v_game, TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_assert_game_row_editable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.phase = 'closed' THEN
    RAISE EXCEPTION 'game % is closed and cannot be modified', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- The one documented exception: after close a transfer may still flip its
-- payment status (open <-> paid). Nothing else about it may move.
CREATE OR REPLACE FUNCTION app_assert_transfer_editable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_phase text;
BEGIN
  SELECT g.phase INTO v_phase FROM games g WHERE g.id = OLD.game_id;
  IF v_phase = 'closed' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'transfers of closed game % are immutable', OLD.game_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.id, NEW.game_id, NEW.from_participant_id, NEW.to_participant_id, NEW.amount,
        NEW.settlement_key, NEW.sort_order)
       IS DISTINCT FROM
       (OLD.id, OLD.game_id, OLD.from_participant_id, OLD.to_participant_id, OLD.amount,
        OLD.settlement_key, OLD.sort_order) THEN
      RAISE EXCEPTION 'only transfers.status may change after game % is closed', OLD.game_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entries_immutable_when_closed ON entries;
CREATE TRIGGER entries_immutable_when_closed
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION app_assert_game_open();

DROP TRIGGER IF EXISTS game_participants_immutable_when_closed ON game_participants;
CREATE TRIGGER game_participants_immutable_when_closed
  BEFORE UPDATE OR DELETE ON game_participants
  FOR EACH ROW EXECUTE FUNCTION app_assert_game_open();

DROP TRIGGER IF EXISTS games_immutable_when_closed ON games;
CREATE TRIGGER games_immutable_when_closed
  BEFORE UPDATE OR DELETE ON games
  FOR EACH ROW EXECUTE FUNCTION app_assert_game_row_editable();

DROP TRIGGER IF EXISTS transfers_immutable_when_closed ON transfers;
CREATE TRIGGER transfers_immutable_when_closed
  BEFORE UPDATE OR DELETE ON transfers
  FOR EACH ROW EXECUTE FUNCTION app_assert_transfer_editable();

-- ---------------------------------------------------------------------
-- 8. updated_at triggers
-- ---------------------------------------------------------------------
-- entries has no updated_at on purpose: it is append-only.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'guests', 'groups', 'group_members', 'invites',
                           'friendships', 'games', 'game_participants', 'transfers', 'debts']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_set_updated_at', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()',
      t || '_set_updated_at', t);
  END LOOP;
END;
$$;

-- =====================================================================
-- Next: run rls-policies.sql. A table with RLS disabled and a publishable
-- client key is public data — enable it in the same deploy as the table.
-- =====================================================================
