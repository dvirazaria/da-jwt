#!/usr/bin/env node
// tools/rls-probe.mjs — re-verify the findings of docs/backend/security-review-2026-09-09.md
// against the live Supabase project. Dependency-free (uses the global `fetch`/`crypto` that
// ship with Node 18+; nothing to `npm install`).
//
// USAGE
//   node tools/rls-probe.mjs                 # read-only probes only (safe, default)
//   node tools/rls-probe.mjs --destructive    # ALSO runs F1/F2 write-path demonstrations
//
// Env vars (all optional for the read-only run):
//   RLS_PROBE_URL        Supabase project URL.       Default: the project's own URL.
//   RLS_PROBE_ANON_KEY    Publishable/anon key.       Default: the key committed in kupa-sgura.html.
//   RLS_PROBE_TOKEN_A      Access token for throwaway account A. Required for --destructive.
//   RLS_PROBE_TOKEN_B      Access token for throwaway account B. Required for --destructive.
//
// WHAT "read-only" MEANS HERE
//   Every probe in runReadOnlyProbes() is a GET, or a POST to a STABLE SQL-only RPC function
//   that does nothing but SELECT/EXISTS (see docs/backend/rls-policies.sql — all nine helpers
//   are `LANGUAGE sql STABLE`). None of it writes a row, and it never needs a signed-in session:
//   every request below uses ONLY the public anon key, exactly as any internet stranger could.
//
// WHAT --destructive DOES, AND WHY IT NEEDS TWO ACCOUNTS YOU MUST CREATE YOURSELF
//   F1 and F2 in the review are write-path findings: they can only be demonstrated by actually
//   inserting rows as a signed-in user. This script will NOT sign up an account for you (this
//   project requires email confirmation — RLS_PROBE_TOKEN_A/B must already be valid access
//   tokens for two THROWAWAY accounts, never your real one).
//
//   How to get a token: sign in as the throwaway account through the deployed app (or via
//   supabase-js in a scratch page), then in the browser devtools console run
//     JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token')))).access_token
//   and copy the resulting string.
//
//   --destructive INSERTs real rows (an ad-hoc game, a game_participants row, a debts row) using
//   account A, naming account B as the non-consenting "victim". It attempts to clean up
//   afterwards (deleting the game cascades game_participants/entries/transfers/debts per
//   schema.sql's ON DELETE CASCADE), but `debts` has no DELETE policy of its own — if the
//   cascade path ever fails for any reason, a debts row naming two THROWAWAY accounts is left
//   behind. That is expected to be harmless (no real user/money involved) but is disclosed here
//   up front. Never point this at real accounts.
//
// Exit code is non-zero if any probe finds something the review did not already flag as a known,
// documented gap (i.e. a genuine regression from what this script expects today).

const SUPABASE_URL = (process.env.RLS_PROBE_URL || "https://aztfjlssjbjhxdqsflgn.supabase.co").replace(/\/+$/, "");
const ANON_KEY = process.env.RLS_PROBE_ANON_KEY || "sb_publishable_JsCuQh8iaszmRzjITbhOVA_vWqEXrUV";
const DESTRUCTIVE = process.argv.includes("--destructive");
const TOKEN_A = process.env.RLS_PROBE_TOKEN_A || "";
const TOKEN_B = process.env.RLS_PROBE_TOKEN_B || "";

if (typeof fetch !== "function" || typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
  console.error("This script needs Node 18+ (global fetch + crypto.randomUUID). Please upgrade Node.");
  process.exit(2);
}

let failures = 0;
let warnings = 0;
function ok(label, detail) { console.log(`  OK    ${label}${detail ? " — " + detail : ""}`); }
function warn(label, detail) { warnings++; console.log(`  WARN  ${label}${detail ? " — " + detail : ""}`); }
function bad(label, detail) { failures++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
function section(title) { console.log(`\n${title}`); console.log("-".repeat(title.length)); }

function decodeJwtSub(token) {
  try {
    const payload = token.split(".")[1];
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(payload.length + (4 - (payload.length % 4)) % 4, "=");
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return json.sub || null;
  } catch (e) { return null; }
}

async function rest(path, { method = "GET", token = null, body = null, prefer = null, extraHeaders = {} } = {}) {
  const headers = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token || ANON_KEY}`,
    ...extraHeaders,
  };
  if (body !== null) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data };
}

// ---------------------------------------------------------------------
// Read-only probes (default, no flag needed)
// ---------------------------------------------------------------------

const TABLES_AND_VIEWS = [
  "profiles", "guests", "groups", "group_members", "invites", "friendships",
  "games", "game_participants", "entries", "transfers", "debts",
  "game_results_v", "group_leaderboard_v", "group_leaderboard_public_v", "my_group_stats_v",
];

const HELPER_RPCS = [
  ["app_current_profile_id", {}],
  ["app_is_active_group_member", { p_group_id: "00000000-0000-0000-0000-000000000000" }],
  ["app_is_group_admin", { p_group_id: "00000000-0000-0000-0000-000000000000" }],
  ["app_is_game_participant", { p_game_id: "00000000-0000-0000-0000-000000000000" }],
  ["app_can_read_game", { p_game_id: "00000000-0000-0000-0000-000000000000" }],
  ["app_can_write_game", { p_game_id: "00000000-0000-0000-0000-000000000000" }],
  ["app_shares_group_with", { p_profile_id: "00000000-0000-0000-0000-000000000000" }],
  ["app_group_has_no_members", { p_group_id: "00000000-0000-0000-0000-000000000000" }],
  ["app_is_friend_of", { p_profile_id: "00000000-0000-0000-0000-000000000000" }],
];

async function runReadOnlyProbes() {
  section("1. Anonymous SELECT on every RLS-protected table/view (expect 200, empty array)");
  console.log("  (A 200 [] here means anon retrieved zero rows — the same result whether RLS is");
  console.log("   correctly blocking real data or the table happens to be empty. Any non-empty");
  console.log("   array, or any row shape leaking data, is a critical regression.)");
  for (const name of TABLES_AND_VIEWS) {
    const { status, data } = await rest(`/rest/v1/${name}?select=*`);
    if (status === 200 && Array.isArray(data) && data.length === 0) ok(name, "200, 0 rows");
    else if (status === 200 && Array.isArray(data)) bad(name, `200 but returned ${data.length} row(s) to an anonymous caller`);
    else warn(name, `unexpected response: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
  }

  section("2. Anonymous RPC on every RLS helper function (finding F4)");
  console.log("  Before docs/backend/security-fixes.sql §F4 is applied, every call below is");
  console.log("  expected to return HTTP 200 (proving the missing REVOKE ... FROM PUBLIC).");
  console.log("  After it is applied, every call should instead fail to execute (401/403), since");
  console.log("  only `authenticated` keeps EXECUTE.");
  for (const [name, args] of HELPER_RPCS) {
    const { status, data } = await rest(`/rest/v1/rpc/${name}`, { method: "POST", body: args });
    if (status === 200) warn(`${name}(...)`, `HTTP 200, returned ${JSON.stringify(data)} — callable by anon (F4, unpatched)`);
    else if (status === 401 || status === 403 || status === 404) ok(`${name}(...)`, `HTTP ${status} — anon execution correctly denied (F4 patched)`);
    else warn(`${name}(...)`, `unexpected response: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
  }

  section("3. Auth settings (informational only, no account touched)");
  const { status, data } = await rest("/auth/v1/settings");
  if (status === 200) ok("GET /auth/v1/settings", `signup_disabled=${data.disable_signup}, mailer_autoconfirm=${data.mailer_autoconfirm}`);
  else warn("GET /auth/v1/settings", `HTTP ${status}`);
}

// ---------------------------------------------------------------------
// Destructive probes (--destructive only): F1 and F2, on two throwaway accounts
// ---------------------------------------------------------------------

async function runDestructiveProbes() {
  section("4. Write-path demonstrations (--destructive) — F1 and F2");
  if (!TOKEN_A || !TOKEN_B) {
    bad("--destructive requires RLS_PROBE_TOKEN_A and RLS_PROBE_TOKEN_B", "see the header comment for how to obtain them from two THROWAWAY accounts");
    return;
  }
  const idA = decodeJwtSub(TOKEN_A);
  const idB = decodeJwtSub(TOKEN_B);
  if (!idA || !idB) { bad("could not decode a profile id from TOKEN_A/TOKEN_B", "are they real Supabase access tokens?"); return; }
  if (idA === idB) { bad("TOKEN_A and TOKEN_B resolve to the same profile", "they must be two DIFFERENT throwaway accounts"); return; }
  console.log(`  account A = ${idA}\n  account B = ${idB} ("victim", never consents to anything below)`);

  const gameId = crypto.randomUUID();
  const { status: gameStatus } = await rest("/rest/v1/games", {
    method: "POST", token: TOKEN_A, prefer: "return=minimal",
    body: { id: gameId, group_id: null, created_by: idA, phase: "active", started_at: new Date().toISOString() },
  });
  if (gameStatus !== 201 && gameStatus !== 200 && gameStatus !== 204) {
    bad("account A could not create an ad-hoc game to run the demo on", `HTTP ${gameStatus}`);
    return;
  }
  ok("account A created a throwaway ad-hoc game", gameId);

  // --- F1: fabricate a debt naming B as debtor, with no game_participants row at all ---
  const debtId = crypto.randomUUID();
  const { status: debtStatus, data: debtData } = await rest("/rest/v1/debts", {
    method: "POST", token: TOKEN_A, prefer: "return=minimal",
    body: {
      id: debtId, game_id: gameId, debtor_profile_id: idB, creditor_profile_id: idA,
      debtor_name: "victim (rls-probe)", creditor_name: "attacker (rls-probe)",
      amount: 1, status: "open",
    },
  });
  if (debtStatus === 201 || debtStatus === 200 || debtStatus === 204) {
    warn("F1: account A inserted a debts row naming B as debtor with zero shared game_participants", "VULNERABLE if unpatched");
    const { status: seenStatus, data: seenData } = await rest(`/rest/v1/debts?id=eq.${debtId}&select=id,amount,debtor_name`, { token: TOKEN_B });
    if (seenStatus === 200 && Array.isArray(seenData) && seenData.length === 1) {
      bad("F1 CONFIRMED", `account B can see the fabricated debt via debts_select_parties: ${JSON.stringify(seenData[0])}`);
    } else {
      warn("F1: the fabricated debt did not become visible to B as expected", `HTTP ${seenStatus}`);
    }
  } else {
    ok("F1: debts insert was rejected", `HTTP ${debtStatus} — security-fixes.sql §F1 appears to be applied`);
  }

  // --- F2: attribute a fabricated participant row to B, without B's involvement ---
  const participantId = crypto.randomUUID();
  const { status: partStatus } = await rest("/rest/v1/game_participants", {
    method: "POST", token: TOKEN_A, prefer: "return=minimal",
    body: { id: participantId, game_id: gameId, profile_id: idB, guest_id: null, display_name_snapshot: "victim (rls-probe)", status: "active" },
  });
  if (partStatus === 201 || partStatus === 200 || partStatus === 204) {
    warn("F2: account A attributed a game_participants row to B without B's consent", "VULNERABLE if unpatched");
    const { status: seenStatus, data: seenData } = await rest(`/rest/v1/games?id=eq.${gameId}&select=id`, { token: TOKEN_B });
    if (seenStatus === 200 && Array.isArray(seenData) && seenData.length === 1) {
      bad("F2 CONFIRMED", "account B can now read a game they were never invited to, purely because A named them as a participant");
    } else {
      warn("F2: B still cannot read the game (app_is_game_participant may not be wired the way this probe assumed)", `HTTP ${seenStatus}`);
    }
  } else {
    ok("F2: game_participants insert naming a non-consenting profile was rejected", `HTTP ${partStatus} — security-fixes.sql §F2 appears to be applied`);
  }

  // --- best-effort cleanup: deleting the game cascades game_participants/entries/transfers/debts ---
  const { status: cleanupStatus } = await rest(`/rest/v1/games?id=eq.${gameId}`, { method: "DELETE", token: TOKEN_A, prefer: "return=minimal" });
  if (cleanupStatus === 200 || cleanupStatus === 204) ok("cleanup", "throwaway game deleted (ON DELETE CASCADE removes its participants/debts too)");
  else warn("cleanup", `could not delete the throwaway game (HTTP ${cleanupStatus}) — it and any rows created above belong to the two throwaway accounts only`);
}

// ---------------------------------------------------------------------
// F3 demonstration (--destructive only): within-group per-player exposure.
//
// Account A creates a group and (as its admin) directly adds account B as an active member —
// group_members_insert_admin allows this with no consent from B, a separate, already-known gap,
// used here only as test scaffolding. A then plays a solo game INSIDE that group — B never sits
// at this table. Before docs/backend/player-boundary.sql: B, as an active group member, can still
// read A's game_participants/entries rows for that game via the old app_can_read_game(game_id)
// (group-wide) gate and compute A's exact net. After: B's read returns zero rows, because B is
// neither a participant of THIS game nor its creator.
// ---------------------------------------------------------------------
async function runF3Probe() {
  section("5. Within-group per-player exposure demonstration (--destructive) — F3");
  if (!TOKEN_A || !TOKEN_B) {
    bad("F3 probe requires RLS_PROBE_TOKEN_A and RLS_PROBE_TOKEN_B", "see the header comment for how to obtain them from two THROWAWAY accounts");
    return;
  }
  const idA = decodeJwtSub(TOKEN_A);
  const idB = decodeJwtSub(TOKEN_B);
  if (!idA || !idB) { bad("could not decode a profile id from TOKEN_A/TOKEN_B"); return; }

  const groupId = crypto.randomUUID();
  const { status: groupStatus } = await rest("/rest/v1/groups", {
    method: "POST", token: TOKEN_A, prefer: "return=minimal",
    body: { id: groupId, name: "rls-probe F3 scratch group", created_by_profile_id: idA },
  });
  if (groupStatus !== 201 && groupStatus !== 200 && groupStatus !== 204) {
    bad("account A could not create a throwaway group to run the F3 demo on", `HTTP ${groupStatus}`);
    return;
  }
  const { status: adminRowStatus } = await rest("/rest/v1/group_members", {
    method: "POST", token: TOKEN_A, prefer: "return=minimal",
    body: { id: crypto.randomUUID(), group_id: groupId, profile_id: idA, role: "admin", status: "active" },
  });
  const { status: memberBStatus } = await rest("/rest/v1/group_members", {
    method: "POST", token: TOKEN_A, prefer: "return=minimal",
    body: { id: crypto.randomUUID(), group_id: groupId, profile_id: idB, role: "member", status: "active" },
  });
  if (adminRowStatus >= 300 || memberBStatus >= 300) {
    bad("could not seed group membership for the F3 demo", `admin row HTTP ${adminRowStatus}, B's row HTTP ${memberBStatus}`);
    return;
  }
  ok("account A created a throwaway group and added B as an active member (unrelated known gap, used only as scaffolding)", groupId);

  const gameId = crypto.randomUUID();
  const participantId = crypto.randomUUID();
  const { status: gameStatus } = await rest("/rest/v1/games", {
    method: "POST", token: TOKEN_A, prefer: "return=minimal",
    body: { id: gameId, group_id: groupId, created_by: idA, phase: "active", started_at: new Date().toISOString() },
  });
  const { status: partStatus } = await rest("/rest/v1/game_participants", {
    method: "POST", token: TOKEN_A, prefer: "return=minimal",
    body: { id: participantId, game_id: gameId, profile_id: idA, guest_id: null, display_name_snapshot: "A (rls-probe)", status: "active" },
  });
  const { status: entryStatus } = await rest("/rest/v1/entries", {
    method: "POST", token: TOKEN_A, prefer: "return=minimal",
    body: { id: crypto.randomUUID(), game_id: gameId, participant_id: participantId, amount: 100 },
  });
  if (gameStatus >= 300 || partStatus >= 300 || entryStatus >= 300) {
    bad("could not seed A's solo game for the F3 demo", `game HTTP ${gameStatus}, participant HTTP ${partStatus}, entry HTTP ${entryStatus}`);
  } else {
    ok("account A played a solo game inside the group (B never sat at this table)", gameId);

    const { status: seenPartStatus, data: seenPart } = await rest(`/rest/v1/game_participants?game_id=eq.${gameId}&select=id,profile_id,cashout`, { token: TOKEN_B });
    const { status: seenEntryStatus, data: seenEntry } = await rest(`/rest/v1/entries?game_id=eq.${gameId}&select=id,amount`, { token: TOKEN_B });
    const leakedParticipants = seenPartStatus === 200 && Array.isArray(seenPart) && seenPart.length > 0;
    const leakedEntries = seenEntryStatus === 200 && Array.isArray(seenEntry) && seenEntry.length > 0;
    if (leakedParticipants || leakedEntries) {
      bad("F3 CONFIRMED", `B (a group member who never played this game) can read A's game_participants (${JSON.stringify(seenPart)}) and/or entries (${JSON.stringify(seenEntry)}) — player-boundary.sql not applied, or not effective`);
    } else {
      ok("F3: B's read of A's game_participants/entries for a game B never played in returned zero rows", `game_participants HTTP ${seenPartStatus}, entries HTTP ${seenEntryStatus} — player-boundary.sql appears to be applied`);
    }
  }

  // --- best-effort cleanup ---
  const { status: cleanupGameStatus } = await rest(`/rest/v1/games?id=eq.${gameId}`, { method: "DELETE", token: TOKEN_A, prefer: "return=minimal" });
  const { status: cleanupMemberStatus } = await rest(`/rest/v1/group_members?group_id=eq.${groupId}&profile_id=eq.${idB}`, { method: "DELETE", token: TOKEN_A, prefer: "return=minimal" });
  const { status: cleanupGroupStatus } = await rest(`/rest/v1/groups?id=eq.${groupId}`, { method: "DELETE", token: TOKEN_A, prefer: "return=minimal" });
  if ([cleanupGameStatus, cleanupMemberStatus, cleanupGroupStatus].every(s => s === 200 || s === 204)) {
    ok("cleanup", "throwaway game, B's membership row, and group deleted");
  } else {
    warn("cleanup", `game HTTP ${cleanupGameStatus}, B's membership HTTP ${cleanupMemberStatus}, group HTTP ${cleanupGroupStatus} — groups has no DELETE policy (soft-delete only); a leftover throwaway group/membership belongs to the two throwaway accounts only`);
  }
}

async function main() {
  console.log(`rls-probe.mjs — ${SUPABASE_URL}`);
  console.log(DESTRUCTIVE ? "mode: read-only + DESTRUCTIVE (write-path demos enabled)" : "mode: read-only (pass --destructive to also run F1/F2 write-path demos)");
  await runReadOnlyProbes();
  if (DESTRUCTIVE) {
    await runDestructiveProbes();
    await runF3Probe();
  } else {
    section("4. Write-path demonstrations (F1, F2)");
    console.log("  SKIPPED — re-run with --destructive (see header comment) to exercise these.");
    section("5. Within-group per-player exposure demonstration (F3)");
    console.log("  SKIPPED — re-run with --destructive (see header comment) to exercise this.");
  }

  console.log(`\n${failures} finding(s) confirmed live, ${warnings} warning(s)/vulnerable-and-expected result(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error("rls-probe.mjs crashed:", e); process.exit(2); });
