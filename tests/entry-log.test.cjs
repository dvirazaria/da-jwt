const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('kupa-sgura.html', 'utf8');
const normalizeSource = html.slice(html.indexOf('  function normalizePhase'), html.indexOf('  function load()'));
// Task 3 hardening: normalize() now shapes groups/groupMembers/invites/friendships through
// their normalizers (same as debts through normalizeDebt), so any slice that calls normalize()
// needs that pure section too, plus a newId() stub for the normalizers that mint ids.
const groupsPureSource = html.slice(html.indexOf('  // ---------- groups domain (pure) ----------'), html.indexOf('  function el('));
const withGroupsPure = normalizeSource + '\n' + groupsPureSource;
function normalize(s) { return vm.runInNewContext(withGroupsPure + '\nnormalize(input)', {input:s, crypto:require('node:crypto').webcrypto, newId: () => 'stub-new-id'}); }
test('legacy amounts survive migration without invented times, with stable identities', () => {
  const old = {players:[{name:'א',buyins:[50,100],cashout:150}],history:[]};
  const s = normalize(old);
  assert.ok(s.gameId);
  assert.ok(s.players[0].id);
  assert.deepEqual(Array.from(s.players[0].entryLog, e=>e.amount), [50,100]);
  assert.ok(s.players[0].entryLog.every(e=>e.timestamp === null && e.gameId === s.gameId && e.playerId === s.players[0].id));
  assert.equal(JSON.stringify(normalize(old)), JSON.stringify(s));
  assert.equal(JSON.stringify(normalize(JSON.parse(JSON.stringify(s)))), JSON.stringify(s));
});
test('saved timestamps and entry identities survive loading', () => {
  const p = {id:'p1',name:'א',buyins:[50,100],entryLog:[
    {id:'e1',timestamp:'2026-09-07T18:14:00Z',amount:50,playerId:'p1',gameId:'g1'},
    {id:'e2',timestamp:'2026-09-07T19:37:00Z',amount:100,playerId:'p1',gameId:'g1'}]};
  const s=normalize({gameId:'g1',players:[p],history:[]});
  assert.equal(s.gameId,'g1');
  assert.equal(JSON.stringify(s.players[0].entryLog),JSON.stringify(p.entryLog));
});
test('each added amount has a distinct identity, timestamp, player and game; save and remote body retain them', () => {
  const saveSource=html.slice(html.indexOf('  function save()'),html.indexOf('  // --- server sync'));
  const remoteSource=html.slice(html.indexOf('  function remoteBody()'),html.indexOf('  function scheduleRemoteSave()'));
  // Multi-game round 1: save() now also reconciles state.games (syncCurrentGameMirror, in the
  // groups-domain pure section), so this slice needs that section too -- same reason the
  // normalize() tests above load groupsPureSource.
  const context=vm.createContext({crypto:require('node:crypto').webcrypto, newId: () => 'stub-new-id'});
  vm.runInContext(normalizeSource + groupsPureSource + saveSource + remoteSource + `
    let state = {gameId:'game-one', phase:'active', players:[], history:[], debts:[{id:'d1',status:'open'}], settlementStatuses:{payment:true}, groupId:'group-one', example:false};
    let pendingRemote = null;
    const CLIENT_ID='test', KEY='game';
    let stored, scheduled=0;
    const localStorage={setItem(k,v){ stored=v; }};
    function scheduleRemoteSave(){scheduled++;}
    function cloudMode(){return false;} // no Supabase session in this slice: the local path
    function scheduleCloudPush(){throw new Error('the cloud push must not run without a session');}
    const player={id:'player-one',name:'א',buyins:[],entryLog:[]};
    state.players.push(player);
    addEntry(player,50); addEntry(player,100); addEntry(player,100);
    save();
  `, context);
  const data=JSON.parse(vm.runInContext('stored', context));
  const entries=data.players[0].entryLog;
  assert.deepEqual(data.players[0].buyins,[50,100,100]);
  assert.equal(new Set(entries.map(e=>e.id)).size,3);
  assert.ok(entries.every(e=>Number.isFinite(Date.parse(e.timestamp)) && Math.abs(Date.now()-Date.parse(e.timestamp))<5000 && e.playerId==='player-one' && e.gameId==='game-one'));
  const remote=JSON.parse(vm.runInContext('JSON.stringify(remoteBody())',context));
  assert.equal(remote.gameId,data.gameId);
  assert.equal(remote.phase,data.phase);
  assert.deepEqual(remote.players,data.players);
  assert.deepEqual(remote.debts,data.debts);
  assert.deepEqual(remote.settlementStatuses,data.settlementStatuses);
  assert.equal(remote.groupId,data.groupId);
  assert.equal(vm.runInContext('scheduled',context),1);
});
test('frozen remote snapshots retain logs and allow subsequent additions', () => {
  const remoteSource=html.slice(html.indexOf('  function applyRemote(data)'),html.indexOf('  document.addEventListener("visibilitychange"'));
  const context=vm.createContext({crypto:require('node:crypto').webcrypto, newId: () => 'stub-new-id'});
  vm.runInContext(withGroupsPure + remoteSource + `
    let state={gameId:'old',players:[],history:[]}, pendingRemote=null;
    const KEY='game', document={activeElement:null};
    let stored, renders=0;
    const localStorage={setItem(k,v){stored=v;}};
    function render(){renders++;}
    const entry=Object.freeze({id:'entry1',timestamp:'2026-09-07T18:00:00Z',amount:50,playerId:'p',gameId:'g'});
    const snapshot=Object.freeze({gameId:'g',players:Object.freeze([Object.freeze({
      id:'p',name:'א',buyins:Object.freeze([50]),entryLog:Object.freeze([entry])
    })]),history:[]});
    applyRemote(snapshot);
    addEntry(state.players[0],100);
  `,context);
  const result=JSON.parse(vm.runInContext('JSON.stringify(state)',context));
  assert.equal(result.gameId,'g');
  assert.equal(result.players[0].entryLog.length,2);
  assert.equal(result.players[0].entryLog[0].timestamp,'2026-09-07T18:00:00Z');
});
test('table balance is an exact integer: buy-ins minus cashouts', () => {
  const start = html.indexOf('  const wholeMoney');
  const end = html.indexOf('  function totals', start);
  assert.ok(start >= 0, 'tableBalance helper exists');
  const context = vm.createContext({});
  vm.runInContext('const sum = values => values.reduce((x, y) => x + y, 0);', context);
  vm.runInContext(html.slice(start, end), context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(tableBalance([{buyins:[4500],cashout:4400}]))', context)), {buy:4500,out:4400,difference:100,isBalanced:false});
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(tableBalance([{buyins:[4500],cashout:4500}]))', context)), {buy:4500,out:4500,difference:0,isBalanced:true});
});
test('unbalanced close stays blocked until the long-press state is unlocked', () => {
  const start = html.indexOf('  function closeButtonLabel');
  const end = html.indexOf('  // Greedy settlement', start);
  assert.ok(start >= 0, 'closeButtonLabel helper exists');
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end), context);
  assert.equal(vm.runInContext('closeButtonLabel(false, false, false)', context), 'לחיצה ארוכה כדי לסגור למרות הפער');
  assert.equal(vm.runInContext('closeButtonLabel(false, true, false)', context), 'סגור בכל זאת');
  assert.equal(vm.runInContext('closeButtonLabel(true, false, false)', context), 'סגירת שולחן ורישום לרקורד');
});
test('long press unlock duration is 1 second', () => {
  assert.equal(html.match(/const HOLD_TO_FORCE_CLOSE_MS = (\d+);/)[1], '1000');
});
test('unpaid settlements become open debts while paid settlements do not', () => {
  const start = html.indexOf('  function settlementKey');
  const end = html.indexOf('  // Greedy settlement', start);
  assert.ok(start >= 0, 'debt helpers exist');
  const context = vm.createContext({});
  vm.runInContext('const wholeMoney = value => Math.round(Number(value) || 0);', context);
  vm.runInContext(html.slice(start, end), context);
  const snapshot = {gameId:'game-one', players:[
    {id:'debtor-id', name:'דביר'}, {id:'creditor-id', name:'עומר'},
  ]};
  const moves = [{from:'דביר',to:'עומר',amount:550},{from:'עומר',to:'דביר',amount:80}];
  const paid = {};
  paid[vm.runInContext(`settlementKey('game-one', ${JSON.stringify(moves[0])}, 0)`, context)] = true;
  const debts = JSON.parse(vm.runInContext(`JSON.stringify(buildDebtRecords(${JSON.stringify(snapshot)}, ${JSON.stringify(moves)}, ${JSON.stringify(paid)}, '2026-09-07T18:00:00.000Z'))`, context));
  assert.equal(debts.length, 1);
  assert.deepEqual(debts[0], {
    id: debts[0].id,
    gameId:'game-one', groupId:null, debtorUserId:'creditor-id', creditorUserId:'debtor-id',
    debtorName:'עומר', creditorName:'דביר', amount:80, status:'open',
    createdAt:'2026-09-07T18:00:00.000Z', gameDate:'2026-09-07T18:00:00.000Z', paidAt:null,
  });
  assert.equal(vm.runInContext(`buildDebtRecords(${JSON.stringify(snapshot)}, ${JSON.stringify(moves)}, ${JSON.stringify({})}, '2026-09-07T18:00:00.000Z').length`, context), 2);
  const allPaid = {};
  moves.forEach((move, index) => {
    allPaid[vm.runInContext(`settlementKey('game-one', ${JSON.stringify(move)}, ${index})`, context)] = true;
  });
  assert.equal(vm.runInContext(`buildDebtRecords(${JSON.stringify(snapshot)}, ${JSON.stringify(moves)}, ${JSON.stringify(allPaid)}, '2026-09-07T18:00:00.000Z').length`, context), 0);
});
test('only the creditor can mark an open debt paid', () => {
  const start = html.indexOf('  function updateDebtAsPaid');
  const end = html.indexOf('  // Greedy settlement', start);
  assert.ok(start >= 0, 'debt payment helper exists');
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end) + `
    const debt = {id:'d1', creditorName:'דביר', status:'open', paidAt:null};
    const wrongActor = updateDebtAsPaid([debt], 'd1', 'עומר', '2026-09-07T19:00:00.000Z');
    const correctActor = updateDebtAsPaid([debt], 'd1', 'דביר', '2026-09-07T19:00:00.000Z');
  `, context);
  assert.equal(vm.runInContext('wrongActor', context), false);
  assert.equal(vm.runInContext('correctActor', context), true);
  const debt = vm.runInContext('debt', context);
  assert.equal(debt.status, 'paid');
  assert.equal(debt.paidAt, '2026-09-07T19:00:00.000Z');
});
test('open and paid debts survive reload normalization', () => {
  const saved = {
    gameId:'next-game', players:[], history:[], debts:[
      {id:'d-open', gameId:'g1', debtorUserId:'a', creditorUserId:'b', debtorName:'א', creditorName:'ב', amount:550, status:'open', createdAt:'2026-09-07T18:00:00Z', gameDate:'2026-09-07T18:00:00Z'},
      {id:'d-paid', gameId:'g2', debtorUserId:'c', creditorUserId:'d', debtorName:'ג', creditorName:'ד', amount:80, status:'paid', createdAt:'2026-09-06T18:00:00Z', gameDate:'2026-09-06T18:00:00Z', paidAt:'2026-09-07T19:00:00Z'},
    ],
  };
  const result = normalize(saved);
  assert.equal(result.debts.length, 2);
  assert.equal(result.debts[0].status, 'open');
  assert.equal(result.debts[1].paidAt, '2026-09-07T19:00:00Z');
});
test('closed history records whether the table was balanced and the exact difference', () => {
  const start = html.indexOf('  function buildHistoryEntry');
  const end = html.indexOf('  // Greedy settlement', start);
  assert.ok(start >= 0, 'buildHistoryEntry helper exists');
  const context = vm.createContext({});
  vm.runInContext('const sum = values => values.reduce((x, y) => x + y, 0);', context);
  vm.runInContext(html.slice(start, end), context);
  const state = {gameId:'game-one', players:[{id:'p',name:'א',buyins:[4500],entryLog:[],cashout:4400}], history:[]};
  const entry = JSON.parse(vm.runInContext(`JSON.stringify(buildHistoryEntry(${JSON.stringify(state)}, {difference:100,isBalanced:false}, '2026-09-07T18:00:00.000Z'))`, context));
  assert.equal(entry.isBalanced, false);
  assert.equal(entry.balanceDifference, 100);
  assert.equal(entry.players[0].cashout, 4400);
});
test('closed history keeps a detached entry log snapshot', () => {
  const closing=html.slice(html.indexOf('  const wholeMoney'),html.indexOf('  // Greedy settlement'));
  const context=vm.createContext({crypto:require('node:crypto').webcrypto});
  vm.runInContext('const sum = values => values.reduce((x, y) => x + y, 0);' + closing, context);
  const snapshot = {gameId:'first-game',players:[{id:'p',name:'א',buyins:[50,100],entryLog:[{id:'e',amount:50}],cashout:150}],history:[]};
  const result=JSON.parse(vm.runInContext(`JSON.stringify(buildHistoryEntry(${JSON.stringify(snapshot)}, {difference:0,isBalanced:true}, '2026-09-07T18:00:00.000Z'))`,context));
  assert.equal(result.gameId,'first-game');
  assert.equal(result.isBalanced,true);
  assert.equal(result.players[0].entryLog.length,1);
  snapshot.players[0].entryLog[0].amount=999;
  assert.equal(result.players[0].entryLog[0].amount,50);
});
test('a player with no entries remains empty on reload', () => {
  const result=normalize({gameId:'g',players:[{id:'p',name:'א',buyins:[],entryLog:[]}],history:[]});
  assert.equal(result.players[0].entryLog.length,0);
});
test('adding a player records the first entry but leaves every rebuy menu closed', () => {
  const source = html.slice(html.indexOf('  function addPlayerToTable('), html.indexOf('  function addPlayer() {'));
  assert.ok(source.includes('function addPlayerToTable'), 'shared player-add tail exists');
  const context = vm.createContext({
    MIN_BUYIN: 50,
    state: { players: [], phase: 'settlement' },
    appView: 'settle', openMenu: 'שחקן אחר', customOpen: 'שחקן אחר', pendingAmount: 100,
    animNext: null, animName: null, saves: 0, renders: 0,
  });
  vm.runInContext(`
    function createPlayer({name, guestId, memberId}) { return {name, guestId, memberId, buyins: [], entryLog: []}; }
    function addEntry(player, amount) { player.buyins.push(amount); player.entryLog.push({amount}); }
    function save() { saves += 1; }
    function render() { renders += 1; }
    ${source}
    addPlayerToTable('רותם', {guestId: 'guest-rotem', memberId: 'member-rotem'});
  `, context);
  assert.equal(vm.runInContext('openMenu', context), null);
  assert.equal(vm.runInContext('customOpen', context), null);
  assert.equal(vm.runInContext('pendingAmount', context), null);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(state.players[0].buyins)', context)), [50]);
  assert.equal(vm.runInContext('state.phase', context), 'active');
  assert.equal(vm.runInContext('appView', context), 'game');
  assert.equal(vm.runInContext('animNext', context), 'one');
  assert.equal(vm.runInContext('saves', context), 1);
  assert.equal(vm.runInContext('renders', context), 1);
});
