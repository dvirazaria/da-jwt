const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');
const helperSource = html.slice(
  html.indexOf('  function profileDebtIds'),
  html.indexOf('  function normalizeDebt')
);

function helperContext() {
  const context = vm.createContext({});
  vm.runInContext(helperSource, context);
  return context;
}

test('profile tabs default to balance and place balance before debts', () => {
  assert.match(html, /let profileTab = "balance";/);
  assert.match(html, /\[\s*\["balance", "מאזן"\],\s*\["debts", "חובות"\]/s);
});

test('open debts expose unseen notifications only for the signed-in user', () => {
  const context = helperContext();
  const debts = [
    { id: 'd1', status: 'open', debtorName: 'דביר', creditorName: 'עומר' },
    { id: 'd2', status: 'paid', debtorName: 'דביר', creditorName: 'רותם' },
    { id: 'd3', status: 'open', debtorName: 'יובל', creditorName: 'רותם' },
  ];
  assert.deepEqual(
    JSON.parse(vm.runInContext(`JSON.stringify(profileDebtIds(${JSON.stringify(debts)}, 'דביר'))`, context)),
    ['d1']
  );
  assert.equal(vm.runInContext(`hasUnseenProfileDebt(${JSON.stringify(debts)}, 'דביר', [])`, context), true);
  assert.equal(vm.runInContext(`hasUnseenProfileDebt(${JSON.stringify(debts)}, 'דביר', ['d1'])`, context), false);
  assert.equal(vm.runInContext(`hasUnseenProfileDebt(${JSON.stringify(debts)}, 'עומר', ['d1'])`, context), false);
});

test('marking the debts tab seen keeps existing ids and adds current open debts', () => {
  const context = helperContext();
  const debts = [
    { id: 'd1', status: 'open', debtorName: 'דביר', creditorName: 'עומר' },
    { id: 'd2', status: 'open', debtorName: 'יובל', creditorName: 'דביר' },
  ];
  assert.deepEqual(
    JSON.parse(vm.runInContext(`JSON.stringify(markProfileDebtsSeen(${JSON.stringify(debts)}, 'דביר', ['old']))`, context)),
    ['old', 'd1', 'd2']
  );
});

test('debt notification is cleared by entering the tab and survives reload storage', () => {
  const storage = new Map();
  const context = vm.createContext({
    PROFILE_DEBT_SEEN_KEY: 'poker-settle-profile-debts-seen',
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, value); },
    },
  });
  vm.runInContext(helperSource, context);
  const debts = [{ id: 'd1', status: 'open', debtorName: 'דביר', creditorName: 'עומר' }];
  assert.equal(vm.runInContext(`hasUnseenProfileDebt(${JSON.stringify(debts)}, 'דביר', loadProfileDebtSeen('דביר'))`, context), true);
  vm.runInContext(`markProfileDebtsSeenForUser(${JSON.stringify(debts)}, 'דביר')`, context);
  assert.equal(vm.runInContext(`hasUnseenProfileDebt(${JSON.stringify(debts)}, 'דביר', loadProfileDebtSeen('דביר'))`, context), false);
  assert.deepEqual(JSON.parse(storage.get('poker-settle-profile-debts-seen')), { 'דביר': ['d1'] });
});

test('debts tab has nested owed and owed-to-me tabs with owed selected first', () => {
  assert.match(html, /let debtTab = "owed";/);
  assert.match(html, /\[\s*\["owed", "אני חייב",[\s\S]*\["owedToMe", "חייבים לי",/);
  assert.match(html, /const debtTabs = el\("div", "debt-tabs"\)/);
  assert.match(html, /debtTab === key/);
});
