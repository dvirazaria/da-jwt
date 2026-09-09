# Supabase keepalive workflow — handoff

Branch: `worktree-agent-a5f8187e57dd08843`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-a5f8187e57dd08843`
Commit: `4b10b2c2b19efe60cf39a8259d17588366dc1e4e` — "ci: keep the Supabase project awake"

## What was built

1. **`.github/workflows/keepalive.yml`** — cron `17 4 */3 * *` (UTC, every 3rd day-of-month)
   plus `workflow_dispatch`. One `curl` step, `permissions: contents: read`,
   `timeout-minutes: 2`, no checkout needed (URL/key are inlined). Uses
   `${{ secrets.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_...' }}` — zero setup required,
   optional secret documented as an override.
2. **`docs/backend/keepalive.md`** — Hebrew doc: why the project pauses, why app traffic
   alone isn't reliable, what the workflow checks and why, how to verify a run, how to
   un-pause (dashboard → Resume project, 1-year restore window per Supabase docs), and the
   Pro-plan upgrade path (ties back into `docs/backend/platform-research.md` §4/§6, which
   already flagged this exact gap).
3. **`tests/keepalive.test.cjs`** — 9 tests: file exists, `schedule`+cron+`workflow_dispatch`
   structurally present, cron steps by 3 days, no `sb_secret_`/`service_role`/
   `SUPABASE_SERVICE`, falls back to the same publishable key `kupa-sgura.html` ships,
   targets project ref `aztfjlssjbjhxdqsflgn`, fails loud (`set -euo pipefail` + `exit 1`),
   checks for Supabase's documented paused-project code `540`, doc exists and is Hebrew.

## Endpoint choice — corrected mid-task by live verification

The task's premise ("a REST read of a table anon can reach, or `/auth/v1/health`") turned
out to need checking, not assuming, on both sides:

- **`/auth/v1/health` was ruled out.** Read GoTrue's actual source
  (`github.com/supabase/auth/internal/api/api.go`, `HealthCheck()`): it returns a hardcoded
  `{version, name, description}` struct and **never queries Postgres**. Supabase's own docs
  say pausing is decided by database activity, so this endpoint is a weak signal for the one
  thing this workflow exists to do — even though it's the officially documented "is the
  service up" endpoint.
- **My first read of `docs/backend/rls-policies.sql`** (every policy scoped `TO
  authenticated`, nothing granted `TO anon`) suggested no table would give anon a clean 200.
  I tested this against the **live** production project (read-only `GET`, anon key only, no
  writes) rather than ship that assumption: `GET /rest/v1/profiles?select=id&limit=1` with
  the real publishable key returned **HTTP 200, body `[]`** — Supabase grants base
  table-level SELECT to `anon` by default project-wide, and it's RLS (no policy matches
  `anon`) that filters the result to zero rows, not a grant-level rejection. That 200 is a
  real query Postgres planned/authorized/executed, which is exactly the deliverable's "genuinely
  registers activity" bar — more clearly so than the health endpoint.
- Also verified live: a bad key → `401` `{"message":"Invalid API key"}` (no `42501`) → the
  workflow's catch-all correctly fails; a bogus host → `curl` DNS failure → also correctly
  fails. The workflow still accepts a `401`/`403` with Postgres `42501` as a secondary
  healthy branch (defense in depth if grants are ever tightened later), on top of the 200
  that's the actual current behavior. HTTP `540` (Supabase's documented paused-project code)
  and anything else is treated as failure.

## Verification

- `node --test tests/keepalive.test.cjs` — 9/9 pass.
- `node --test tests/*.test.cjs` — 499/499 pass (490 pre-existing + 9 new), no regressions.
- `git diff --check` — clean, no whitespace errors.
- YAML structurally validated with Ruby's `YAML.load_file` (no PyYAML available); the `run:`
  block extracted and checked with `bash -n` (syntax only); then **actually executed** against
  the live project (read-only GET, publishable key only) for both the healthy and two
  unhealthy paths above — this is the same class of request the scheduled job performs, so it
  doubles as a live smoke test of the workflow's logic before merge.
- No SQL was run, `index.html`/`sw.js`/`build.py` were not touched, main repo untouched.

## Does normal app traffic alone prevent pausing?

**No — the workflow is the only reliable guard.** Real Supabase traffic (sign-in, cloud
sync) does count and does reset the 7-day timer when it happens, but three things make it
unsafe to depend on alone: poker groups don't play on a fixed weekly cadence (already noted
in `docs/backend/platform-research.md`); the app still supports a fully local/demo mode with
no Supabase session, so active play doesn't guarantee server activity; and current adoption
is small enough that multi-day gaps are the norm, not the exception. This is written up in
the "האם תעבורה רגילה מספיקה?" section of `docs/backend/keepalive.md`.
