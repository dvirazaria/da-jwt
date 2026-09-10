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

// The friends (pure) section only depends on identityKey/sameIdentity (defined later, in the
// groups domain (pure) section) and newId (defined elsewhere in the file, stubbed here the same
// way tests/groups-domain.test.cjs stubs it for resolveGuestId/newCurrentGame).
const friendsSource = sourceBetween('  // ---------- friends (pure) ----------', '  // ---------- player exit (pure) ----------');
const identitySource = sourceBetween('  function identityKey(ref) {', '  function resolveGuestId(');

function load(newIdStub) {
  const context = vm.createContext({ newId: newIdStub || (() => 'stub-new-id') });
  vm.runInContext(friendsSource, context);
  vm.runInContext(identitySource, context);
  return context;
}

// vm.runInContext returns objects/arrays from the sandbox's own realm, so a plain deepEqual
// against a native literal fails on "same structure, not reference-equal". JSON round-trip fixes it.
function runJSON(code, context) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
}

function ref(guestId, displayName) {
  return { userId: null, guestId, displayName };
}

// ---------- friendRequestsFor ----------

test('friendRequestsFor partitions pending/accepted friendships relative to meRef', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  const other2 = ref('g-b', 'רותם');
  const other3 = ref('g-c', 'יובל');
  const friendships = [
    { id: 'f1', requester: me, addressee: other, status: 'pending', createdAt: 't1', respondedAt: null },      // outgoing (I'm requester)
    { id: 'f2', requester: other2, addressee: me, status: 'pending', createdAt: 't2', respondedAt: null },     // incoming (I'm addressee)
    { id: 'f3', requester: me, addressee: other3, status: 'accepted', createdAt: 't3', respondedAt: 't3b' },   // friend (I'm requester)
    { id: 'f4', requester: ref('g-d', 'נועה'), addressee: ref('g-e', 'אלון'), status: 'pending', createdAt: 't4', respondedAt: null }, // unrelated to me
  ];
  const result = runJSON(`friendRequestsFor(${JSON.stringify(friendships)}, ${JSON.stringify(me)})`, context);
  assert.deepEqual(result.outgoing.map(f => f.id), ['f1']);
  assert.deepEqual(result.incoming.map(f => f.id), ['f2']);
  assert.deepEqual(result.friends, [other3]);
});

test('friendRequestsFor maps an accepted friendship to the other party even when I am the addressee', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  const friendships = [
    { id: 'f1', requester: other, addressee: me, status: 'accepted', createdAt: 't1', respondedAt: 't1b' },
  ];
  const result = runJSON(`friendRequestsFor(${JSON.stringify(friendships)}, ${JSON.stringify(me)})`, context);
  assert.deepEqual(result.friends, [other]);
  assert.deepEqual(result.incoming, []);
  assert.deepEqual(result.outgoing, []);
});

test('friendRequestsFor returns empty lists for an empty or missing friendships array', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  assert.deepEqual(runJSON(`friendRequestsFor([], ${JSON.stringify(me)})`, context), { incoming: [], outgoing: [], friends: [] });
  assert.deepEqual(runJSON(`friendRequestsFor(undefined, ${JSON.stringify(me)})`, context), { incoming: [], outgoing: [], friends: [] });
});

// ---------- createFriendRequest ----------

test('createFriendRequest refuses a self-request and does not mutate the array', () => {
  const context = load(() => 'new-id-1');
  const me = ref('g-me', 'דביר');
  vm.runInContext(`var friendships = [];`, context);
  const result = vm.runInContext(`createFriendRequest(friendships, ${JSON.stringify(me)}, ${JSON.stringify(me)}, 't0')`, context);
  assert.equal(result, null);
  assert.equal(runJSON(`friendships.length`, context), 0);
});

test('createFriendRequest pushes a new pending friendship and blocks duplicates in either direction', () => {
  const context = load(() => 'new-id-1');
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  vm.runInContext(`
    var me = ${JSON.stringify(me)};
    var other = ${JSON.stringify(other)};
    var friendships = [];
  `, context);

  const created = runJSON(`createFriendRequest(friendships, me, other, 't1')`, context);
  assert.deepEqual(created, { id: 'new-id-1', requester: me, addressee: other, status: 'pending', createdAt: 't1', respondedAt: null });
  assert.equal(runJSON(`friendships.length`, context), 1);

  // same direction again -> blocked
  assert.equal(vm.runInContext(`createFriendRequest(friendships, me, other, 't2')`, context), null);
  // reverse direction -> also blocked (a pending request already links the two)
  assert.equal(vm.runInContext(`createFriendRequest(friendships, other, me, 't3')`, context), null);
  assert.equal(runJSON(`friendships.length`, context), 1);
});

test('createFriendRequest also blocks a duplicate once the existing friendship is accepted', () => {
  const context = load(() => 'new-id-2');
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  const third = ref('g-c', 'יובל');
  vm.runInContext(`
    var me = ${JSON.stringify(me)};
    var other = ${JSON.stringify(other)};
    var third = ${JSON.stringify(third)};
    var friendships = [{ id: 'f1', requester: me, addressee: other, status: 'accepted', createdAt: 't1', respondedAt: 't1b' }];
  `, context);
  assert.equal(vm.runInContext(`createFriendRequest(friendships, me, other, 't2')`, context), null);
  assert.equal(runJSON(`friendships.length`, context), 1);

  // a request to a different, unrelated person still succeeds
  const created = runJSON(`createFriendRequest(friendships, me, third, 't3')`, context);
  assert.equal(created.id, 'new-id-2');
  assert.equal(runJSON(`friendships.length`, context), 2);
});

// ---------- respondToFriendRequest ----------

test('respondToFriendRequest only lets the addressee of a pending request accept or reject it', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  vm.runInContext(`
    var me = ${JSON.stringify(me)};
    var other = ${JSON.stringify(other)};
    var friendships = [
      { id: 'f1', requester: other, addressee: me, status: 'pending', createdAt: 't1', respondedAt: null },
      { id: 'f2', requester: me, addressee: other, status: 'pending', createdAt: 't2', respondedAt: null },
    ];
  `, context);

  // the requester (not the addressee) may not respond to their own outgoing request
  assert.equal(vm.runInContext(`respondToFriendRequest(friendships, 'f2', me, true, 't3')`, context), false);
  assert.equal(runJSON(`friendships[1].status`, context), 'pending');

  // an unknown id fails
  assert.equal(vm.runInContext(`respondToFriendRequest(friendships, 'nope', me, true, 't3')`, context), false);

  // the addressee accepts
  assert.equal(vm.runInContext(`respondToFriendRequest(friendships, 'f1', me, true, 't4')`, context), true);
  assert.equal(runJSON(`friendships[0].status`, context), 'accepted');
  assert.equal(runJSON(`friendships[0].respondedAt`, context), 't4');

  // already resolved -> responding again fails
  assert.equal(vm.runInContext(`respondToFriendRequest(friendships, 'f1', me, false, 't5')`, context), false);
});

test('respondToFriendRequest can reject a pending request', () => {
  const context = load();
  const me = ref('g-me', 'דביר');
  const other = ref('g-a', 'עומר');
  vm.runInContext(`
    var friendships = [
      { id: 'f1', requester: ${JSON.stringify(other)}, addressee: ${JSON.stringify(me)}, status: 'pending', createdAt: 't1', respondedAt: null },
    ];
  `, context);
  assert.equal(vm.runInContext(`respondToFriendRequest(friendships, 'f1', ${JSON.stringify(me)}, false, 't2')`, context), true);
  assert.equal(runJSON(`friendships[0].status`, context), 'rejected');
  assert.equal(runJSON(`friendships[0].respondedAt`, context), 't2');
});

// ---------- UI wiring ----------

test('friends are a primary screen and are no longer rendered inside profile', () => {
  const nav = html.slice(html.indexOf('<nav class="tabbar'), html.indexOf('</nav>'));
  assert.ok(nav.indexOf('id="modeFriends"') < nav.indexOf('id="modeGames"'));
  assert.ok(nav.indexOf('id="modeGames"') < nav.indexOf('id="modeProfile"'));
  assert.match(html, /id="friendsPage"/);
  assert.match(html, /function renderFriendsPage\(\)/);
  assert.match(html, /box\.hidden = appView !== "friends";/);
  const profileSource = html.slice(html.indexOf('  function renderProfile()'), html.indexOf('  // Shared tail of "add a player'));
  assert.doesNotMatch(profileSource, /renderFriendGroup\(/);
  assert.doesNotMatch(profileSource, /friendRequestsFor\(/);
  // Design round (row 22): the empty state states the fact, and the single shared SERVER_NOTE
  // constant under the disabled button carries the "needs a backend" wording for all five places.
  assert.match(html, /עוד אין חברים/);
  assert.match(html, /"הוסף חבר"/);
  // The button is live with a session and disabled without one; the shared note is what the
  // signed-out screen still shows (see tests/friend-requests.test.cjs for the wiring).
  assert.match(html, /addFriendBtn\.disabled = !online;/);
  assert.match(html, /addFriendBtn\.setAttribute\("aria-disabled", online \? "false" : "true"\);/);
  assert.match(html, /el\("p", "friend-helper", SERVER_NOTE\)/);
});

test('render routes and controls the standalone friends screen', () => {
  assert.match(html, /document\.body\.classList\.toggle\("friends-view", appView === "friends"\)/);
  assert.match(html, /document\.getElementById\("modeFriends"\)\.classList\.toggle\("on", appView === "friends"\)/);
  assert.match(html, /document\.getElementById\("friendsPage"\)\.hidden = appView !== "friends"/);
  assert.match(html, /document\.getElementById\("settingsBtn"\)\.hidden = appView !== "profile" && appView !== "games" && appView !== "friends"/);
  assert.match(html, /document\.getElementById\("modeFriends"\)\.addEventListener\("click", \(\) => setAppView\("friends"\)\)/);
});

// The pure mutations are now wired to the friends screen, but through exactly one caller each:
// the id/validation rules must stay in the pure functions, not be re-implemented in a handler.
test('createFriendRequest and respondToFriendRequest each have exactly one UI caller', () => {
  const createCalls = html.split('createFriendRequest(').length - 1;
  const respondCalls = html.split('respondToFriendRequest(').length - 1;
  assert.equal(createCalls, 2, 'its definition plus submitFriendRequest');
  assert.equal(respondCalls, 2, 'its definition plus respondToFriend');
  assert.match(html, /if \(!createFriendRequest\(state\.friendships, meRef, toRef, new Date\(\)\.toISOString\(\)\)\)/);
  assert.match(html, /if \(!respondToFriendRequest\(state\.friendships \|\| \[\], id, myFriendRef\(\), accept, new Date\(\)\.toISOString\(\)\)\) return;/);
});

// ---------- empty-state redesign (researched empty state, one primary action) ----------

const friendsPageSource = sourceBetween('  function renderFriendsPage()', '  function renderProfile()');

test('the empty state (no friends, no pending requests) renders a headline, a benefit line, and promotes the share link to the page\'s one primary action', () => {
  const emptyBranch = friendsPageSource.slice(
    friendsPageSource.indexOf('if (!hasFriendData) {'),
    friendsPageSource.indexOf('} else {')
  );
  assert.match(emptyBranch, /el\("h2", "friends-hero-title", "עוד אין חברים\?"\)/);
  assert.match(emptyBranch, /el\("p", "friends-hero-benefit",/);
  // the share-link action is the page's real .btn-primary; add-by-name is the quieter .btn-quiet
  // secondary (same weighting the login screen already uses for its lead vs. skip action).
  assert.match(friendsPageSource, /el\("button", "btn-primary friends-share-btn", friendInviteSharing \? "יוצר קישור…" : "שתפו קישור חברות"\)/);
  assert.match(friendsPageSource, /el\("button", "btn-quiet friends-add-toggle", "הוסף חבר"\)/);
});

test('when there is data, incoming and outgoing requests are rendered before the accepted-friends list', () => {
  const populatedBranch = friendsPageSource.slice(
    friendsPageSource.indexOf('} else {'),
    friendsPageSource.indexOf('// Primary path')
  );
  const incomingIdx = populatedBranch.indexOf('renderFriendGroup(friendsSec, "בקשות שהתקבלו"');
  const outgoingIdx = populatedBranch.indexOf('renderFriendGroup(friendsSec, "בקשות שנשלחו"');
  const friendsIdx = populatedBranch.indexOf('renderFriendGroup(friendsSec, "חברים"');
  assert.ok(incomingIdx >= 0, 'incoming requests must render');
  assert.ok(outgoingIdx > incomingIdx, 'outgoing requests must follow incoming requests');
  assert.ok(friendsIdx > outgoingIdx, 'the friends list must follow both request groups, never lead them');
});

test('the share action is appended before the add-by-name action, keeping the primary path first in reading and tab order', () => {
  const shareAppendIdx = friendsPageSource.indexOf('friendsSec.appendChild(inviteMeBtn)');
  const addAppendIdx = friendsPageSource.indexOf('friendsSec.appendChild(addFriendBtn)');
  assert.ok(shareAppendIdx >= 0 && addAppendIdx > shareAppendIdx);
});

test('the empty-state redesign changes presentation only -- no localStorage access inside renderFriendsPage', () => {
  assert.doesNotMatch(friendsPageSource, /localStorage\./);
});
