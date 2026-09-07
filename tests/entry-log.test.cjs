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
test('closing archives a detached log and starts a different game', () => {
  const closing=html.slice(html.indexOf('    const entry = {\n      gameId: state.gameId,'),html.indexOf('  // ---------- login (who'));
  const context=vm.createContext({crypto:require('node:crypto').webcrypto});
  vm.runInContext(normalizeSource + `
    let state={gameId:'first-game',players:[{id:'p',name:'א',buyins:[],entryLog:[],cashout:150}],history:[]};
    addEntry(state.players[0],50); addEntry(state.players[0],100);
    const oldPlayer=state.players[0], expandedEntries=new Set(['p']);
    const HISTORY_MAX=60, sum=a=>a.reduce((x,y)=>x+y,0), balanced=false;
    let openMenu='א', customOpen=null, mode='settle', animNext=null;
    function save(){} function render(){} function confetti(){}
    (() => {
  ` + closing.replace(/\}\);\s*$/, '})();'), context);
  const result=JSON.parse(vm.runInContext('JSON.stringify(state)',context));
  assert.notEqual(result.gameId,'first-game');
  assert.equal(result.players.length,0);
  assert.equal(result.history[0].gameId,'first-game');
  assert.equal(result.history[0].players[0].entryLog.length,2);
  assert.equal(result.history[0].players[0].net,0);
  vm.runInContext('oldPlayer.entryLog[0].amount=999',context);
  assert.equal(vm.runInContext('state.history[0].players[0].entryLog[0].amount',context),50);
});
test('a player with no entries remains empty on reload', () => {
  const result=normalize({gameId:'g',players:[{id:'p',name:'א',buyins:[],entryLog:[]}],history:[]});
  assert.equal(result.players[0].entryLog.length,0);
});
