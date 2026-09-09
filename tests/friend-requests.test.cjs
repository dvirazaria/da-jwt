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

const friendsSource = sourceBetween('  // ---------- friends (pure) ----------', '  // ---------- player exit (pure) ----------');
const identitySource = sourceBetween('  function identityKey(ref) {', '  function resolveGuestId(');

function load() {
  const context = vm.createContext({ newId: () => 'stub-new-id' });
  vm.runInContext(friendsSource, context);
  vm.runInContext(identitySource, context);
  return context;
}
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}
function call(context, fn, ...args) {
  return vm.runInContext(`${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`, context);
}
function ref(guestId, displayName, userId) {
  return { userId: userId || null, guestId, displayName };
}

// ---------- friendRequestError ----------

test('friendRequestError maps every inline error the add-friend panel can show', () => {
  const context = load();
  assert.equal(call(context, 'friendRequestError', 'notFound'), 'לא נמצא משתמש');
  assert.equal(call(context, 'friendRequestError', 'friends'), 'כבר חברים');
  assert.equal(call(context, 'friendRequestError', 'pending'), 'כבר נשלחה בקשה');
  assert.equal(call(context, 'friendRequestError', 'self'), 'אי אפשר לשלוח לעצמך');
  assert.equal(call(context, 'friendRequestError', 'empty'), 'יש להזין מייל או שם');
});

test('friendRequestError falls back to a generic message for an unknown kind', () => {
  const context = load();
  const fallback = call(context, 'friendRequestError', 'nope');
  assert.equal(fallback, 'לא הצלחנו לשלוח את הבקשה');
  assert.equal(call(context, 'friendRequestError', ''), fallback);
  assert.equal(vm.runInContext('friendRequestError()', context), fallback);
  assert.equal(vm.runInContext('friendRequestError(null)', context), fallback);
  // Object.prototype keys must not leak through the lookup table.
  assert.equal(call(context, 'friendRequestError', 'toString'), fallback);
});

// ---------- friendRequestBlockReason ----------

test('friendRequestBlockReason refuses a request to myself', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  assert.equal(call(context, 'friendRequestBlockReason', [], me, me), 'self');
  // same person, different ref shape (the display name differs, the guestId does not)
  assert.equal(call(context, 'friendRequestBlockReason', [], me, ref('g-me', 'דביר אחר')), 'self');
});

test('friendRequestBlockReason refuses a duplicate pending request in both directions', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  const outgoing = [{ id: 'f1', requester: me, addressee: other, status: 'pending', createdAt: 't', respondedAt: null }];
  const incoming = [{ id: 'f2', requester: other, addressee: me, status: 'pending', createdAt: 't', respondedAt: null }];
  assert.equal(call(context, 'friendRequestBlockReason', outgoing, me, other), 'pending');
  assert.equal(call(context, 'friendRequestBlockReason', incoming, me, other), 'pending');
});

test('friendRequestBlockReason refuses an existing friendship in both directions', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  const mine = [{ id: 'f1', requester: me, addressee: other, status: 'accepted', createdAt: 't', respondedAt: 't2' }];
  const theirs = [{ id: 'f2', requester: other, addressee: me, status: 'accepted', createdAt: 't', respondedAt: 't2' }];
  assert.equal(call(context, 'friendRequestBlockReason', mine, me, other), 'friends');
  assert.equal(call(context, 'friendRequestBlockReason', theirs, me, other), 'friends');
});

test('friendRequestBlockReason allows a fresh request, and one after a rejection', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  const third = ref('g-b', 'רותם');
  assert.equal(call(context, 'friendRequestBlockReason', [], me, other), null);
  const rejected = [{ id: 'f1', requester: me, addressee: other, status: 'rejected', createdAt: 't', respondedAt: 't2' }];
  assert.equal(call(context, 'friendRequestBlockReason', rejected, me, other), null);
  // somebody else's friendship never blocks mine
  const unrelated = [{ id: 'f2', requester: other, addressee: third, status: 'accepted', createdAt: 't', respondedAt: 't2' }];
  assert.equal(call(context, 'friendRequestBlockReason', unrelated, me, third), null);
  assert.equal(vm.runInContext(`friendRequestBlockReason(undefined, ${JSON.stringify(me)}, ${JSON.stringify(other)})`, context), null);
});

test('createFriendRequest still refuses exactly what friendRequestBlockReason reports', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  vm.runInContext(`var friendships = [];`, context);
  assert.equal(vm.runInContext(`createFriendRequest(friendships, ${JSON.stringify(me)}, ${JSON.stringify(me)}, 't') === null`, context), true);
  assert.equal(runJSON(`createFriendRequest(friendships, ${JSON.stringify(me)}, ${JSON.stringify(other)}, 't').status`, context), 'pending');
  assert.equal(vm.runInContext(`createFriendRequest(friendships, ${JSON.stringify(other)}, ${JSON.stringify(me)}, 't2') === null`, context), true);
  assert.equal(runJSON(`friendships.length`, context), 1);
});

// ---------- removeFriendRequest ----------

test('removeFriendRequest withdraws only my own pending outgoing request', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  vm.runInContext(`
    var friendships = [
      { id: 'f1', requester: ${JSON.stringify(me)}, addressee: ${JSON.stringify(other)}, status: 'pending', createdAt: 't', respondedAt: null },
      { id: 'f2', requester: ${JSON.stringify(other)}, addressee: ${JSON.stringify(me)}, status: 'pending', createdAt: 't', respondedAt: null },
      { id: 'f3', requester: ${JSON.stringify(me)}, addressee: ${JSON.stringify(other)}, status: 'accepted', createdAt: 't', respondedAt: 't2' }
    ];
    var me = ${JSON.stringify(me)};
  `, context);
  // incoming: not mine to withdraw
  assert.equal(vm.runInContext(`removeFriendRequest(friendships, 'f2', me) === null`, context), true);
  // accepted: withdrawal is only for a pending request
  assert.equal(vm.runInContext(`removeFriendRequest(friendships, 'f3', me) === null`, context), true);
  assert.equal(vm.runInContext(`removeFriendRequest(friendships, 'nope', me) === null`, context), true);
  assert.equal(runJSON(`removeFriendRequest(friendships, 'f1', me).id`, context), 'f1');
  assert.deepEqual(runJSON(`friendships.map(f => f.id)`, context), ['f2', 'f3']);
});

// ---------- normalizeFriendSearch ----------

test('normalizeFriendSearch trims, lowercases an email and keeps a name exact', () => {
  const context = load();
  assert.deepEqual(runJSON(`normalizeFriendSearch('  Dvir@Mail.COM ')`, context), { kind: 'email', value: 'dvir@mail.com' });
  assert.deepEqual(runJSON(`normalizeFriendSearch('  דביר אזריה  ')`, context), { kind: 'name', value: 'דביר אזריה' });
  assert.deepEqual(runJSON(`normalizeFriendSearch('Dvir')`, context), { kind: 'name', value: 'Dvir' });
  assert.deepEqual(runJSON(`normalizeFriendSearch('   ')`, context), { kind: 'empty', value: '' });
  assert.deepEqual(runJSON(`normalizeFriendSearch(null)`, context), { kind: 'empty', value: '' });
  assert.deepEqual(runJSON(`normalizeFriendSearch(undefined)`, context), { kind: 'empty', value: '' });
});

// ---------- structural: the wiring itself ----------

const friendsUiSource = sourceBetween('  function renderAddFriendPanel(parent)', '  function renderProfile()');

test('the send handler goes through createFriendRequest + save(), never a direct insert', () => {
  const send = sourceBetween('  async function submitFriendRequest()', '  function respondToFriend(');
  assert.match(send, /createFriendRequest\(state\.friendships, meRef, toRef,/);
  assert.match(send, /\bsave\(\);/);
  // save() is the single door to scheduleCloudPush; the UI must not open its own.
  assert.doesNotMatch(html, /from\("friendships"\)\.insert/);
  assert.doesNotMatch(html, /from\("friendships"\)\.upsert/);
  // The push writes friendships through the generic CLOUD_TABLES loop, so the only literal
  // uses of the table are the pull SELECT and the withdraw DELETE.
  assert.equal(html.split('.from("friendships")').length - 1, 2);
  assert.match(html, /if \(cloudMode\(\)\) scheduleCloudPush\(\);/);
});

test('respond and withdraw go through the pure functions and save()', () => {
  const respond = sourceBetween('  function respondToFriend(id, accept)', '  function resetAddFriendPanel()');
  assert.match(respond, /respondToFriendRequest\(state\.friendships \|\| \[\], id, myFriendRef\(\), accept,/);
  assert.match(respond, /removeFriendRequest\(state\.friendships \|\| \[\], id, myFriendRef\(\)\)/);
  assert.match(respond, /cloudDeleteFriendship\(/);
  assert.equal(respond.split('save();').length - 1, 2);
});

test('the whole feature is gated by cloudMode()', () => {
  assert.match(html, /async function submitFriendRequest\(\) \{\n    if \(!cloudMode\(\)\) return;/);
  assert.match(html, /function respondToFriend\(id, accept\) \{\n    if \(!cloudMode\(\)\) return;/);
  assert.match(html, /function withdrawFriendRequest\(id\) \{\n    if \(!cloudMode\(\)\) return;/);
  // lookupFriendProfile spells the same gate out as "!supabase || !authUser", the shape every
  // other supabase call site uses (tests/backend-config.test.cjs audits that).
  assert.match(html, /async function lookupFriendProfile\(parsed\) \{\n    if \(!supabase \|\| !authUser\) return null;/);
  // my own ref never invents a profile id: it validates the session's through keptUserId()
  assert.match(html, /const profileId = authUser && authUser\.id;\n    return \{\n      userId: keptUserId\(profileId\),/);
  // signed out keeps today's behaviour: disabled button + the shared server note
  const page = sourceBetween('  function renderFriendsPage()', '  function renderProfile()');
  assert.match(page, /const online = cloudMode\(\);/);
  assert.match(page, /addFriendBtn\.disabled = !online;/);
  assert.match(page, /if \(!online\) friendsSec\.appendChild\(el\("p", "friend-helper", SERVER_NOTE\)\);/);
  assert.match(page, /if \(online\) renderAddFriendPanel\(friendsSec\);/);
  // the row actions only exist online
  assert.match(page, /online \? \(i => \{/);
});

test('the add-friend panel uses the shared inline-panel pattern, an LTR email field and 44px actions', () => {
  assert.match(friendsUiSource, /games-create-panel/);
  assert.match(friendsUiSource, /addFriendJustOpened/);
  assert.match(html, /\.friend-action \{[^}]*min-height: 44px/);
  // an address reads LTR inside the RTL screen; a Hebrew name does not
  assert.equal(friendsUiSource.split('setAttribute("dir", addFriendQuery.indexOf("@") >= 0 ? "ltr" : "auto")').length - 1, 2);
  assert.match(html, /function setAddFriendError\(kind\) \{\n    addFriendError = friendRequestError\(kind\);/);
  assert.match(friendsUiSource, /addFriendBusy \? "שולח…" : "שלח בקשה"/);
  assert.match(friendsUiSource, /el\("p", "friend-error", addFriendError\)/);
  // list rows still enter with a stagger
  assert.match(html, /row\.style\.animationDelay = \(i \* 45\) \+ "ms";/);
});

test('the friends UI never renders money, debts or another person\'s email', () => {
  assert.doesNotMatch(friendsUiSource, /fmt\(/);
  assert.doesNotMatch(friendsUiSource, /debts/);
  assert.doesNotMatch(friendsUiSource, /\.email/);
});

test('the profile lookup is an exact single-column match on a readable profile', () => {
  const lookup = sourceBetween('  async function lookupFriendProfile(parsed)', '  function myFriendRef()');
  assert.match(lookup, /from\("profiles"\)/);
  assert.match(lookup, /\.eq\(column, parsed\.value\)/);
  assert.match(lookup, /parsed\.kind === "email" \? "email" : "display_name"/);
  assert.doesNotMatch(lookup, /\.or\(/);
  assert.doesNotMatch(lookup, /\.ilike\(/);
});
