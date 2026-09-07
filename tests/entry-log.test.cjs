const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('kupa-sgura.html', 'utf8');
const normalizeSource = html.slice(html.indexOf('  function normalize(s)'), html.indexOf('  function load()'));
function normalize(s) { return vm.runInNewContext(normalizeSource + '\nnormalize(input)', {input:s, crypto:require('node:crypto').webcrypto}); }
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
  const context=vm.createContext({crypto:require('node:crypto').webcrypto});
  vm.runInContext(normalizeSource + saveSource + remoteSource + `
    let state = {gameId:'game-one', players:[], history:[], example:false};
    let pendingRemote = null;
    const CLIENT_ID='test', KEY='game';
    let stored, scheduled=0;
    const localStorage={setItem(k,v){ stored=v; }};
    function scheduleRemoteSave(){scheduled++;}
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
  assert.deepEqual(remote.players,data.players);
  assert.equal(vm.runInContext('scheduled',context),1);
});
test('frozen remote snapshots retain logs and allow subsequent additions', () => {
  const remoteSource=html.slice(html.indexOf('  function applyRemote(data)'),html.indexOf('  document.addEventListener("visibilitychange"'));
  const context=vm.createContext({crypto:require('node:crypto').webcrypto});
  vm.runInContext(normalizeSource + remoteSource + `
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
  assert.equal(vm.runInContext('closeButtonLabel(false, false, false)', context), 'הסכום לא מאוזן, לא ניתן לסגור');
  assert.equal(vm.runInContext('closeButtonLabel(false, true, false)', context), 'סגור בכל זאת');
  assert.equal(vm.runInContext('closeButtonLabel(true, false, false)', context), 'סגירת שולחן ורישום לרקורד');
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
