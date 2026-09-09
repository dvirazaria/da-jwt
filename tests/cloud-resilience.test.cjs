// Bad-network resilience: a durable outbox for cloud pushes, bounded exponential backoff with
// full jitter in place of the old one-shot retry, and the four honest sync-dot states. See
// .superpowers/network-resilience-report.md for the manual (devtools-offline) test plan.
//
// Pure functions only here -- no network, no uncontrolled timers. The impure wiring (pushCloud,
// enterCloudMode, cloudRetryNow, the online/visibilitychange listeners) is pinned structurally at
// the bottom, the same style tests/cloud-race.test.cjs already uses for this file.
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
const pureSource = sourceBetween('  // ---------- cloud mapping (pure) ----------', '  function el(');
const storeSource = sourceBetween('  // ---------- cloud store (Supabase) ----------', '  // ---- realtime: the open table ----');

function load() {
  const context = vm.createContext({});
  vm.runInContext(pureSource, context);
  return context;
}
function call(context, code) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

// ---------- backoff ----------

test('cloudBackoffDelay is bounded, its ceiling is monotonic, and it is jittered within the band', (t) => {
  const ctx = load();
  const ceilings = [0, 1, 2, 3, 4, 5, 6].map(n => call(ctx, `cloudBackoffDelay(${n}, 1)`));
  assert.deepEqual(ceilings, [1000, 2000, 4000, 8000, 15000, 15000, 15000], 'doubles up to the 15s cap, then holds');
  // never negative, never past this attempt's own ceiling
  [0, 1, 2, 3, 4].forEach(n => {
    [0, 0.25, 0.5, 0.75, 1].forEach(r => {
      const delay = call(ctx, `cloudBackoffDelay(${n}, ${r})`);
      assert.ok(delay >= 0 && delay <= ceilings[n], `attempt ${n} r=${r}: ${delay} within [0, ${ceilings[n]}]`);
    });
  });
  // full jitter: two different random draws at the same attempt give different delays
  assert.notEqual(call(ctx, 'cloudBackoffDelay(3, 0.1)'), call(ctx, 'cloudBackoffDelay(3, 0.9)'));
});

// ---------- error classification ----------

test('classifyCloudError retries network/timeout/5xx and surfaces RLS/constraint/4xx', (t) => {
  const ctx = load();
  const classify = (e) => call(ctx, `classifyCloudError(${JSON.stringify(e)})`);
  assert.equal(classify({ status: 503 }), 'retry', '5xx');
  assert.equal(classify({ status: 429 }), 'retry', 'rate limit');
  assert.equal(classify({ message: 'Failed to fetch' }), 'retry', 'offline / no response reached the server');
  assert.equal(classify({ name: 'AbortError', message: 'The operation timed out' }), 'retry', 'timeout');
  assert.equal(classify({ status: 403, code: '42501' }), 'surface', 'RLS refusal');
  assert.equal(classify({ code: '23505' }), 'surface', 'unique constraint');
  assert.equal(classify({ status: 400 }), 'surface', 'bad request');
  assert.equal(classify({ status: 422 }), 'surface', 'unprocessable -- the payload itself is invalid');
});

// ---------- the four honest states ----------

test('cloudSyncLabel returns exactly one of the four honest states, syncing first', (t) => {
  const ctx = load();
  const label = (info) => call(ctx, `cloudSyncLabel(${JSON.stringify(info)})`);
  assert.equal(label({ syncing: false, error: false, pendingCount: 0 }), 'מסונכרן');
  assert.equal(label({ syncing: true, error: false, pendingCount: 3 }), 'מסנכרן…', 'an in-flight push always wins the label');
  assert.equal(label({ syncing: false, error: false, pendingCount: 2 }), 'ממתין לרשת (2 שינויים)');
  assert.equal(label({ syncing: false, error: true, pendingCount: 0 }), 'שגיאת שמירה');
  assert.equal(label({ syncing: true, error: true, pendingCount: 5 }), 'מסנכרן…', 'a fresh retry in flight outranks the stale error');
});

// ---------- reconnect ordering ----------

test('reconnect ordering picks push before pull when the outbox is non-empty', (t) => {
  const ctx = load();
  assert.equal(call(ctx, 'cloudReconnectOrder(0)'), 'pull-then-push', 'nothing to protect: the cheaper order is fine');
  assert.equal(call(ctx, 'cloudReconnectOrder(1)'), 'push-then-pull');
  assert.equal(call(ctx, 'cloudReconnectOrder(7)'), 'push-then-pull');
});

// ---------- outbox round-trip through the one state document ----------

const normalizeCoreSource = sourceBetween('  function normalizePhase', '  function load()');
const normalizeGroupsSource = sourceBetween('  // ---------- groups domain (pure) ----------', '  function el(');
function normalizeState(plainState) {
  return JSON.parse(vm.runInNewContext(
    normalizeCoreSource + '\n' + normalizeGroupsSource + '\nJSON.stringify(normalize(input))',
    { input: plainState, crypto: require('node:crypto').webcrypto, newId: () => 'stub-new-id' }
  ));
}

test('the pending-id outbox round-trips through normalize() intact, inside the one state document', (t) => {
  const withOutbox = normalizeState({ players: [], cloudPendingIds: ['a', 'b', 'b', 42, null, ''] });
  assert.deepEqual(withOutbox.cloudPendingIds, ['a', 'b', 'b', '42'], 'stringified; only null/empty junk is dropped');
  const missing = normalizeState({ players: [] });
  assert.deepEqual(missing.cloudPendingIds, [], 'no field at all defaults to an empty outbox');
  const wrongType = normalizeState({ players: [], cloudPendingIds: 'not-an-array' });
  assert.deepEqual(wrongType.cloudPendingIds, []);
});

test('markCloudPending/clearCloudPending operate on a plain array -- state is the only store', (t) => {
  const ctx = load();
  const collections = { groups: [{ id: 'g1' }], groupMembers: [{ id: 'm1' }], invites: [], friendships: [] };
  // markPendingIds/clearPendingIds are the exact functions scheduleCloudPush/pushCloudRun call on
  // state.cloudPendingIds now -- no separate in-memory Set to fall out of sync with localStorage.
  const afterMark = call(ctx, `[...markPendingIds(${JSON.stringify(['g1'])}, ${JSON.stringify(collections)})]`);
  assert.deepEqual(afterMark.sort(), ['g1', 'm1'].sort(), 'accepts a plain persisted array, not only a Set');
  const confirmed = { groups: [{ id: 'g1' }], groupMembers: [], invites: [], friendships: [] };
  const afterClear = call(ctx, `[...clearPendingIds(${JSON.stringify(afterMark)}, ${JSON.stringify(confirmed)})]`);
  assert.deepEqual(afterClear, ['m1'], 'only the confirmed collection is released');
});

// ---------- structure: the wiring lives in the store, not in a pure slice ----------

test('the store wires backoff and classification into the retry, and pushes before it pulls on boot', (t) => {
  assert.match(storeSource, /const delay = cloudBackoffDelay\(cloudPushAttempt, Math\.random\(\)\)/,
    'the retry delay comes from the bounded/jittered helper, not a fixed one-shot timeout');
  assert.match(storeSource, /classifyCloudError\(e\)/, 'the catch branches on the classified error');
  assert.ok(!/cloudPushRetried/.test(storeSource), 'the old one-shot flag is gone');
  // enterCloudMode lives after the realtime section, so it is checked against the full file.
  const enterStart = html.indexOf('  function enterCloudMode() {');
  assert.ok(enterStart >= 0, 'enterCloudMode not found');
  const enter = html.slice(enterStart, html.indexOf('  function exitCloudMode() {'));
  assert.match(enter, /pushCloud\(\)\.then\(\(\) => \{ if \(cloudMode\(\)\) return pullCloud\(\); \}\)/,
    'boot always flushes the outbox before a stale pull could overwrite an unconfirmed write');
  assert.ok(!/pullCloud\(\)\.then\(\(\) => \{ if \(cloudMode\(\)\) return pushCloud/.test(enter),
    'the old pull-before-push boot order is gone');
  assert.match(storeSource, /window\.addEventListener\("online", cloudRetryNow\)/,
    'connectivity coming back retries immediately instead of waiting out the backoff timer');
});
