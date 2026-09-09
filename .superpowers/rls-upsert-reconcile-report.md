# F6 vs. the upsert bug — reconciliation report

Branch: `worktree-agent-aa81e2f1d4763113b`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-aa81e2f1d4763113b`

## The collision, restated

`docs/backend/security-fixes.sql` §F6 reverts five UPDATE policies
(`groups_update_admin`, `group_members_update_admin`, `invites_update_admin`,
`games_update_member`, `game_participants_update`) to their pre-
`fix-upsert-policies.sql` wording — i.e. it drops an unconditional "OR I am
the row's/group's creator" branch each one picked up as a workaround for a
real production bug (`commit 9eafade`: the first write of any new row via
`.upsert()` failed with `42501`). On its face, removing that branch looks
like it reopens the exact bug it was added to close. The task was to find
out whether it actually does, not to assume either side's document is
already right.

## The mechanism (step 2) — confidence: HIGH on the parts that matter here

**Claim A — `INSERT ... ON CONFLICT (id) DO UPDATE` is subject to the
table's UPDATE policy, not only its INSERT policy, and not only when a real
conflict occurs.** This is the load-bearing half of the mechanism, and I
did not re-derive it from first principles alone — it matches documented
PostgreSQL RLS behavior for `ON CONFLICT DO UPDATE` (the statement requires
both INSERT and UPDATE privilege because it may take either path, and the
UPDATE policy's WITH CHECK is evaluated as part of that statement shape),
and it is also the only explanation consistent with the empirical
observation already recorded in `fix-upsert-policies.sql` (written by an
earlier session against the live production project, not by me — I did not
run any SQL for this task): plain `INSERT` of a brand-new row succeeded,
but `.upsert()` of that same never-existed-before row failed `42501`, while
`.upsert()` of a row that already existed succeeded. If only genuinely-
conflicting rows touched the UPDATE policy, the brand-new-row case could
never have failed. Confidence: high, but secondhand — I did not execute
`EXPLAIN` or reproduce this myself (prohibited for this task); it rests on
matching documented Postgres behavior against an already-recorded live
reproduction.

**Claim B — a `STABLE SECURITY DEFINER` helper that re-queries the same
table the outer statement is writing cannot see the row that statement is
still inserting.** This part I am confident about independent of Claim A:
it is a well-known MVCC/snapshot corner of `ON CONFLICT DO UPDATE` (a
command does not see rows it is itself in the middle of writing via a
sub-select using the statement's own snapshot) and every helper in
`rls-policies.sql` that the five policies depend on
(`app_is_group_admin` → `group_members`, `app_is_active_group_member` →
`group_members`, `app_can_read_game`/`app_can_write_game` → `games`) fits
the pattern where the UPDATE policy's helper reads the exact table being
written, for four of the five policies. `game_participants_update` is the
exception, by construction: `app_can_write_game(game_id)` reads `games`, a
*different* table from `game_participants` — so it was never exposed to
Claim B at all, before or after `fix-upsert-policies.sql`. This is also
independently stated in `security-fixes.sql`'s own F2 comment, and I
confirmed it by reading `app_can_write_game`'s definition myself rather
than taking that comment on faith.

**Claim C — a predicate over the proposed row's own columns (e.g.
`created_by = app_current_profile_id()`) is immune to Claim B.** This is
core, uncontroversial RLS semantics (WITH CHECK always sees the row being
written directly, no sub-select, no snapshot question) and is *why* the
creator-branch workaround worked at all.

**What actually closes the collision is neither A, B, nor C directly — it
is that the branch these three explain is no longer reachable from the
real client.** I read `kupa-sgura.html`'s cloud-push code line by line
(`pushCloudRun`, `splitCloudWrites`, `CLOUD_INSERT_ONLY`, all four
`.upsert(` call sites in the whole file — there are only four, and I
accounted for each) rather than trusting `security-fixes.sql`'s own F6
comment, which already asserted this. It checks out:

- `CLOUD_INSERT_ONLY = { entries: true, transfers: true, debts: true }` —
  none of the five tables F6 touches is in it.
- Every other collection, including all five, goes through
  `splitCloudWrites(upserts, known, "id")` before any write. A row whose id
  is not in `known` goes up as `.upsert(rows, { onConflict: "id",
  ignoreDuplicates: true })`, which PostgREST compiles to
  `INSERT ... ON CONFLICT (id) DO NOTHING` — a form that requires only
  INSERT privilege and never touches the UPDATE policy, full stop,
  regardless of Claims A/B/C. Only a row already in `known` — provably
  server-side, because `known` is sourced only from a prior push's own
  success (`lastPushedRows`, set only after an upsert call did not throw)
  or a prior pull's own SELECT (`kupa-sgura.html:2171`, rows a SELECT
  returned, which by definition exist) — goes up as a real
  `.upsert(rows, { onConflict: "id" })`. By then it is a routine UPDATE of
  an already-committed row from an earlier, separate PostgREST
  request/transaction (`pushCloudRun` awaits each table's call in
  sequence, per `CLOUD_TABLES`' FK order), so Claim B's snapshot problem
  does not arise.
- I traced the retry/outbox path too (`classifyCloudError`,
  `cloudBackoffDelay`, `.superpowers/network-resilience-report.md`): a
  failed push updates `lastPushedRows`/`known` only for tables whose upsert
  call did not throw, so a retry recomputes the identical split from the
  same unconfirmed baseline — there is no path where an unconfirmed row
  drifts into `known` without the server actually having confirmed it.
- The one cross-table dependency the fix leans on — `group_members` must
  already be committed before `games`/`game_participants` reference it via
  `app_profile_is_active_group_member`/`app_is_active_group_member` — holds
  because `CLOUD_TABLES` orders `groupMembers` before `games` before
  `gameParticipants`, and each is its own awaited request. That specific
  ordering was previously *implied* but not directly pinned by
  `tests/cloud-upsert.test.cjs`'s FK-order test; I added the two missing
  assertions (`groupMembers` before `games` and before `gameParticipants`)
  rather than leaving it as an untested assumption.

Net: the F6 fix, as already written, does not reopen the bug — **provided**
this client invariant holds, which is now independently verified, commented
in three places (security-fixes.sql, kupa-sgura.html ×2), and pinned by
tests rather than left as an assertion in a comment.

**Point 3 — is `app_profile_is_active_group_member` (F2, declared
`STABLE`) the same trap in new clothing?** No. It queries `group_members`,
which is a different table from `game_participants` (the table the
INSERT/UPDATE policies that call it are guarding), so Claim B does not
apply to it regardless of its volatility marking — volatility controls
caching/inlining within a single query, not cross-table MVCC visibility.
The dependency it does have (the referenced `group_members` row must
already be committed) is satisfied by the same write-order argument above.
`STABLE` is the correct, non-wasteful choice here (same as every other
helper) — `VOLATILE` would not fix anything if the ordering were wrong, and
would just disable some query-plan caching for no benefit.

## Solution chosen, and what I rejected

**Chosen: keep the SQL as `security-fixes.sql` already had it (the creator
branch is dropped from all five, no standing privilege anywhere), and
harden the client invariant it depends on instead of touching the
policies.** Concretely: no functional change to `kupa-sgura.html` was
needed — I verified `splitCloudWrites`/`CLOUD_INSERT_ONLY` already
implement this correctly for all five tables — so what I added there is
two comments (at `CLOUD_INSERT_ONLY` and at `splitCloudWrites`) making the
dependency explicit for the next editor, plus a per-policy comment in the
SQL itself, plus tests that fail loudly if either side drifts
(`tests/rls-security-fixes.test.cjs`, and two new assertions in
`tests/cloud-upsert.test.cjs`'s existing FK-order test).

**Rejected — fix the helpers' visibility instead (e.g. mark them
`VOLATILE`, or rewrite them to inspect the proposed row via trigger-style
`NEW`).** RLS USING/WITH CHECK functions cannot see a `NEW` pseudo-row the
way a trigger can; there is no supported way to make a `STABLE` or
`VOLATILE` SQL function's sub-select observe a row the same statement is
still inserting into the same table — that is a hard Postgres MVCC
property, not a tuning knob. This path does not exist as a real option.

**Rejected — keep a bounded creator branch (e.g. only within N seconds of
row creation, or gated by an extra "still the sole member" check).** Any
such branch is still a standing, unconditional-on-current-role privilege
evaluated from the row alone; the task's own instruction is explicit
("reject anything that leaves a standing privilege a demoted admin keeps"),
and F6's `games_update_member` finding shows even a *narrow-looking* branch
(no destination-group scoping) becomes a cross-group DoS primitive. Since
the insert-only-for-new-rows approach already fully covers every write path
with zero standing privilege, a bounded escape hatch would be strictly
worse for no remaining benefit.

**Rejected — do nothing / ship `security-fixes.sql` unmodified.** The
policy bodies were already correct, but nothing recorded *why* they were
safe in a way a future reader (or another agent) could check without
redoing this whole investigation — which is exactly the scenario the task
warned about ("a future reader will otherwise 'restore' the creator branch
and reopen F6"). Comments-only felt too weak on its own, so I also added
`tools/rls-introspect.sql` (read-only, never executed by me) so the
concrete live state can be checked before anyone applies the file, and
tests that encode the invariant as an executable check, not just prose.

## Manual test plan (for the project owner, after applying `security-fixes.sql`)

Needs: two throwaway accounts (or one account across two tabs/devices) —
never real user accounts, per the project's own probe-tooling convention
(`tools/rls-probe.mjs`).

1. **Run `tools/rls-introspect.sql` first** (Supabase SQL editor). Confirm
   block 3 currently shows the creator branch on all four of
   `groups_update_admin`/`group_members_update_admin`/
   `invites_update_admin`/`games_update_member`, and does *not* show one on
   `game_participants_update` (it never had one that mattered — see Claim B
   above). This is the "what is actually live" baseline before touching
   anything.
2. **Apply `security-fixes.sql`.** Re-run `tools/rls-introspect.sql` block
   3: all five should now show no bare `created_by[_profile_id] =
   app_current_profile_id()` branch in their own USING/WITH CHECK text.
3. **Create a group while signed in** (fresh account, or an account with no
   groups yet). Watch the sync dot go syncing → synced with no error. This
   exercises `groups_insert_self` (new row, insert-only path) immediately
   followed by `group_members_insert_admin`'s bootstrap branch (new row,
   insert-only path) — neither one is an UPDATE, so this step alone does
   not yet exercise §F6, but a failure here means something upstream (F2's
   `app_profile_is_active_group_member`, or the write-order dependency
   this report leans on) is broken and nothing past this point will work
   either.
4. **Create a game inside that group while signed in** (`התחל משחק`,
   add at least one buy-in). Same expectation: dot reaches "מסונכרן" with
   no `42501`/"שגיאת שמירה". This is the scenario `fix-upsert-policies.sql`
   was originally written to fix — a brand-new `games` row plus a brand-new
   `game_participants` row in the same push, both now merge-upsert-shaped
   requests hitting `games_update_member`/`game_participants_update`'s
   *WITH CHECK* only through their INSERT-arm alter ego
   (`ON CONFLICT DO NOTHING`) rather than a real UPDATE. If this step
   fails with `42501` where step 3 succeeded, `tools/rls-introspect.sql`
   block 1 is the next stop — check whether `app_profile_is_active_group_
   member`/`app_can_write_game` actually exist and are STABLE as expected.
5. **Rename the group, then close the game**, both while still an active
   member/admin. These are genuine UPDATEs of already-confirmed rows —
   exactly the case §F6's fix is supposed to keep working without a
   creator branch. Expect success.
6. **The actual F6 regression test:** have the group's *other* admin demote
   the creator to a regular member (or remove them), then have the
   demoted/removed account try to rename the group again, or edit another
   member's role, or edit an invite they created. Expect all three to now
   fail (previously — under `fix-upsert-policies.sql` alone — the creator
   branch would have let them through). This is the actual privilege F6
   closes; steps 3-5 only confirm closing it did not also break legitimate
   creation.

## Verification run in this worktree

`node --test tests/*.test.cjs` → 570 pass, 0 fail (563 pre-existing +
7 new in `tests/rls-security-fixes.test.cjs`; `tests/cloud-upsert.test.cjs`
gained two assertions inside its existing FK-order test, not a new test).
`git diff --check` clean. The last `<script>` body in `kupa-sgura.html`
still parses with `new Function`. No SQL was executed against the project
at any point in this task.
