// Throwaway v68 smoke test — runs the REAL chat.js parser in Node.
// Usage: node smoke_v68.js
var path = require('path');
global.window = global;
global.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
global.window.FinApp = {
  merchantCatFor: function () { return null; },
  idbAll: function () { return Promise.resolve([]); },
  idbPut: function () { return Promise.resolve(); },
  idbDel: function () { return Promise.resolve(); },
  STORE_CHAT: 'chat', STORE_PLANS: 'plans', STORE_TX: 'tx', STORE_META: 'meta'
};
require(path.join(__dirname, '..', '..', 'chat.js'));
var fc = window.__financeChat;
if (!fc) { console.error('FAIL: __financeChat missing'); process.exit(1); }

// today is 2026-09-11 → cur = 2026-09, prev = 2026-08
var base = {
  salary: 25000,
  salary_overrides: { '2026-09': 24000 },
  budgets: { Food: 8000, Water: 1500 },
  budget_overrides: { '2026-08': { Water: 1600 } },
  one_offs: { '2026-09': { 'Power bill': 2200 } },
  debts: { 'Ave loan': { payments: { '2026-09': 3000 } } },
  accounts: []
};
function run(label, text) {
  var r = fc.extractStory(fc.norm(text), { base: base });
  console.log('--- ' + label);
  console.log(JSON.stringify(r, null, 1));
}
// item 2a: percent of a stored value
run('pct: base budget', 'bump food budget by 10%');
run('pct: month override', 'food up 15% in october');
run('pct: down', 'cut food budget by 5%');
// item 2b: delta vs last month
run('delta: budget same+plus (override month wins)', 'water in october same as last month +500');
run('delta: bare number same clause', 'water same as last month 200');
run('delta: one-off next month', 'power bill in october same as last month');
run('delta: salary', 'salary in october same as last month');
run('delta: debt', 'ave loan in october same as last month -200');
// item 2c: payday-anchored timing
run('payday: one-off', 'one-off: car insurance 5000 after payday');
// item 2 regression: % is not an amount
console.log('--- findAmounts("bump food budget by 10%") = ' + JSON.stringify(fc.findAmounts('bump food budget by 10%')));
console.log('--- findAmounts("log 2,500 car") = ' + JSON.stringify(fc.findAmounts('log 2,500 car')));

// item 3: kind-disambiguation ask
var ctx3 = {
  eff: {
    cards: [{ name: 'Maya', balance: 1200, limit: 30000 }],
    cash: { accounts: [{ name: 'Maya E-Wallet', value: 500 }], total: 500, free: 500 },
    floor: 0, prepay_day: 14, month: '2026-09',
    obligations: { debts: [], one_offs: [] }
  },
  base: { budgets: { Food: 8000 }, salary: 25000, salary_overrides: {}, budget_overrides: {}, one_offs: {}, debts: {}, accounts: [] },
  txns: [],
  at: new Date().toISOString()
};
function say(label, text, ctx) {
  var r = fc.handle(text, ctx || ctx3);
  console.log('--- ' + label + '  →  ' + (r.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160));
  if (r.actions && r.actions.length) {
    var a = r.actions[r.actions.length - 1];
    console.log('    last action: ' + a.label + '  payload=' + JSON.stringify(a.payload || {}));
  }
}
say('ask: bare name is two kinds', 'log expense 500 maya');
say('answer: card', 'card');
say('hint in text: no ask', 'log expense 200 maya wallet');
say('unrelated names: no ask', 'log expense 300 gcash');

// items 5/9: the dynamic chip text drafts a monthly plan
say('plan monthly draft (chip text)', 'Add plan: Jollibee 350 monthly');
// item 7: "when does cash dip?" routes to the projection
var ctx4 = {
  eff: ctx3.eff,
  base: ctx3.base,
  txns: [],
  at: new Date().toISOString(),
  snap: {
    matrix: { base: [
      { comp: { month: '2026-09', salary: 25000, outflows: 24000 }, running: 900 },
      { comp: { month: '2026-10', salary: 25000, outflows: 27000 }, running: -1100 },
      { comp: { month: '2026-11', salary: 25000, outflows: 23000 }, running: 900 }
    ] },
    months: ['2026-09', '2026-10', '2026-11']
  }
};
say('dip question', 'when does cash dip?', ctx4);

// v70: "hm" = "how much" — the bare shorthand routes to the full "Where you
// stand" summary through the rule engine (intentStatus), not the LLM/fallback.
function v70hm(label, text) {
  var r = fc.handle(text, ctx3);
  var ok = !!(r && r.__path === 'rule:intentStatus' && /Where you stand/.test(r.html));
  console.log('--- v70 ' + label + (ok ? '  OK' : '  FAIL → path=' + (r && r.__path) + ' html=' + (r && (r.html || '').replace(/<[^>]+/g, ' ').slice(0, 80))));
  if (!ok) process.exitCode = 1;
}
v70hm('hm → status', 'hm');
v70hm('hm? → status', 'hm?');
v70hm('hm. → status', 'hm.');
v70hm('how much → status', 'how much');

// v72.5: 5-minute conversation memory — coachHist keeps only the current
// session (rows since the last 5+ min gap of silence), capped at 24 messages
// x 160 chars.
(function v725mem() {
  var t0 = new Date('2026-09-12T01:00:00Z').getTime();
  function row(min, who, text) {
    var r = { id: 'r' + min + who, who: who, at: new Date(t0 + min * 60000).toISOString() };
    if (who === 'user') r.text = text; else r.html = text;
    return r;
  }
  // prior session at 00:50/00:55 (15 min before the 01:10 start) + a fresh
  // session 01:10..01:14
  var rows = [
    row(-10, 'user', 'old a'), row(-5, 'bot', 'old b'),
    row(10, 'user', 'new 1'), row(12, 'bot', 'new 2'), row(14, 'user', 'new 3')
  ];
  var h = fc.coachHist(rows, null);
  var ok = h.length === 3 && h[0].txt === 'new 1' && h[1].txt === 'new 2' && h[2].txt === 'new 3';
  console.log('--- v72.5 session window (5-min gap) ' + (ok ? 'OK' : 'FAIL got=' + JSON.stringify(h)));
  if (!ok) process.exitCode = 1;
  // a 4-minute gap is NOT a break (rows 0..29, 1 min apart = one session)
  var rows2 = [row(0, 'user', 'a'), row(4, 'bot', 'b'), row(8, 'user', 'c')];
  var h2 = fc.coachHist(rows2, null);
  var ok2 = h2.length === 3 && h2[0].txt === 'a' && h2[2].txt === 'c';
  console.log('--- v72.5 sub-5-min gap stays one session ' + (ok2 ? 'OK' : 'FAIL got=' + JSON.stringify(h2)));
  if (!ok2) process.exitCode = 1;
  // 30 back-to-back rows -> only the newest 24 (m6..m29)
  var big = [];
  for (var k = 0; k < 30; k++) big.push(row(k, k % 2 ? 'bot' : 'user', 'm' + k));
  var h3 = fc.coachHist(big, null);
  var ok3 = h3.length === 24 && h3[0].txt === 'm6' && h3[23].txt === 'm29';
  console.log('--- v72.5 24-message cap ' + (ok3 ? 'OK' : 'FAIL got=' + JSON.stringify(h3.length)));
  if (!ok3) process.exitCode = 1;
})();

// v72.33: a prepay question about ONE card answers with THAT card's prepay,
// not the total; no card mentioned = the total; the coach numbers carry the
// per-card breakdown.
(function v7233prepay() {
  var ctx = {
    eff: {
      cards: [
        { name: 'MariBank CC', balance: 7000, limit: 50000, util_pct: 14, prepay: 2050, target_balance: 4950 },
        { name: 'Maya CC', balance: 1000, limit: 10000, util_pct: 10, prepay: 10, target_balance: 990 }
      ],
      total_prepay: 2060, card_owed: 8000,
      cash: { total: 5000, free: 4000, accounts: [] },
      floor: 0, prepay_day: 14, cutoff_day: 15, month: '2026-09'
    },
    base: {
      budgets: { Food: 8000 }, salary: 25000, salary_overrides: {}, budget_overrides: {},
      one_offs: {}, debts: {},
      accounts: [
        { name: 'MariBank CC', kind: 'card', value: 7000, limit: 50000, note: '' },
        { name: 'Maya CC', kind: 'card', value: 1000, limit: 10000, note: '' },
        { name: 'Cash', kind: 'debit', value: 5000, limit: 0, note: '' }
      ]
    },
    txns: [], at: new Date().toISOString()
  };
  var one = fc.handle('how much should i prepay on my maribank cc', ctx);
  var oneOk = !!one && one.html.indexOf('MariBank CC prepay') >= 0 && one.html.indexOf('2,050') >= 0 && one.html.indexOf('2,060') < 0;
  console.log('--- v72.33 one-card prepay question answers with that card (not the total) ' + (oneOk ? 'OK' : 'FAIL got=' + (one ? one.html.slice(0, 240) : 'null')));
  if (!oneOk) process.exitCode = 1;
  var tot = fc.handle('how much is my 14th prepay', ctx);
  var totOk = !!tot && tot.html.indexOf('2,060') >= 0 && tot.html.indexOf('2,050') < 0;
  console.log('--- v72.33 no card mentioned = the total ' + (totOk ? 'OK' : 'FAIL got=' + (tot ? tot.html.slice(0, 240) : 'null')));
  if (!totOk) process.exitCode = 1;
  var snap = fc.coachSnapshot(ctx).text;
  var snapOk = snap.indexOf('2,060') >= 0 && snap.indexOf('MariBank CC PHP 2,050') >= 0 && snap.indexOf('Maya CC PHP 10') >= 0;
  console.log('--- v72.33 the coach numbers carry the per-card breakdown ' + (snapOk ? 'OK' : 'FAIL got=' + snap.slice(0, 240)));
  if (!snapOk) process.exitCode = 1;
})();

// v75.13 (boss: 'assess the bot' -> 'fix 1-3'): shorthand expenses log (never a balance set), spend answers count
// spending only and know 'yesterday'
(function v7513() {
  function iso(d) { return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate(); }
  var y = new Date(); y.setDate(y.getDate() - 1);
  var ctx = {
    eff: {
      cards: [{ name: 'Maya CC', balance: 900, limit: 10000, util_pct: 9, prepay: 0 }],
      total_prepay: 0, card_owed: 900,
      cash: { total: 5000, free: 4000, accounts: [{ name: 'LandBank', value: 5000 }] },
      floor: 0, prepay_day: 14, cutoff_day: 15, month: iso(new Date()).slice(0, 7), obligations: { debts: [], one_offs: [] }
    },
    base: { budgets: { Food: 0 }, salary: 25000, salary_overrides: {}, budget_overrides: {}, one_offs: {}, debts: {},
      accounts: [{ name: 'Maya CC', kind: 'card', value: 900, limit: 10000 }, { name: 'LandBank', kind: 'debit', value: 5000 }] },
    txns: [
      { date: iso(y), kind: 'cash_out', amount: 150, category: 'Food', account: 'LandBank' },
      { date: iso(y), kind: 'cash_in', amount: 46615, category: 'Salary', account: 'LandBank' }
    ],
    at: new Date().toISOString()
  };
  var a = fc.handle('lunch 180 maya cc', ctx);
  var act = a && a.actions && a.actions[0];
  var aOk = !!a && a.__path === 'rule:intentLog' && act && act.payload && act.payload.account === 'Maya CC' && act.payload.amount === 180 && act.payload.kind === 'card_charge';
  console.log('--- v75.13 "lunch 180 maya cc" logs a card charge (not a balance) ' + (aOk ? 'OK' : 'FAIL path=' + (a && a.__path)));
  if (!aOk) process.exitCode = 1;
  var b = fc.handle('maya cc 180', ctx);
  var bOk = !!b && b.__path !== 'rule:intentLog';
  console.log('--- v75.13 "maya cc 180" (account first) stays a balance update ' + (bOk ? 'OK' : 'FAIL path=' + (b && b.__path)));
  if (!bOk) process.exitCode = 1;
  var c = fc.handle('how much did i spend yesterday', ctx);
  var cOk = !!c && c.html.indexOf('150.00') >= 0 && c.html.indexOf('46,615') < 0 && c.html.indexOf('yesterday') >= 0;
  console.log('--- v75.13 "yesterday" = yesterday, spending only (no salary) ' + (cOk ? 'OK' : 'FAIL got=' + (c ? c.html.replace(/<[^>]+>/g, ' ').slice(0, 200) : 'null')));
  if (!cOk) process.exitCode = 1;
})();

// v75.14 (bot item 4): the everyday questions get rule answers (this harness has no app numbers, so the ones that
// read Home's figures step aside; the ones that read the context answer)
(function v7514() {
  function iso(d) { return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate(); }
  var today = iso(new Date());
  var ctx = {
    eff: { cards: [], total_prepay: 0, card_owed: 0, cash: { total: 5000, free: 4000, accounts: [{ name: 'LandBank', value: 5000 }] }, floor: 0, prepay_day: 14, month: today.slice(0, 7), obligations: { debts: [], one_offs: [] } },
    base: { budgets: { Food: 0 }, salary: 25000, salary_overrides: {}, budget_overrides: {}, one_offs: {}, debts: {}, accounts: [{ name: 'LandBank', kind: 'debit', value: 5000 }] },
    txns: [
      { id: 't1', date: today, kind: 'cash_out', amount: 300, category: 'Food', account: 'LandBank', created: '2026-01-01T00:00:00Z' },
      { id: 't2', date: today, kind: 'cash_out', amount: 120, category: 'Transpo', account: 'LandBank', created: '2026-01-02T00:00:00Z' },
      { id: 't3', date: today, kind: 'cash_out', amount: 50, category: 'Food', account: 'Cash', note: 'Owed · Ana', created: '2026-01-03T00:00:00Z' }
    ],
    plans: [], at: new Date().toISOString()
  };
  var a = fc.handle('add netflix 549 monthly on the 10th', ctx);
  var aOk = !!a && a.__path === 'rule:intentPlanAdd' && a.actions && a.actions[0].payload.repeat === 'monthly' && a.actions[0].payload.amount === 549;
  console.log('--- v75.14 "add netflix 549 monthly on the 10th" drafts a monthly plan ' + (aOk ? 'OK' : 'FAIL path=' + (a && a.__path)));
  if (!aOk) process.exitCode = 1;
  var b = fc.handle('what did i spend the most on this month', ctx);
  var bOk = !!b && b.__path === 'rule:intentTopSpend' && b.html.indexOf('Food') >= 0 && b.html.indexOf('350.00') >= 0;
  console.log('--- v75.14 top spending this month ' + (bOk ? 'OK' : 'FAIL got=' + (b ? b.html.replace(/<[^>]+>/g, ' ').slice(0, 160) : 'null')));
  if (!bOk) process.exitCode = 1;
  var c = fc.handle('undo', ctx);
  var cOk = !!c && c.__path === 'rule:intentUndoLast' && c.actions && c.actions[0].payload.id === 't2';
  console.log('--- v75.14 "undo" offers the last entry, never an Owed leg ' + (cOk ? 'OK' : 'FAIL got=' + JSON.stringify(c && c.actions)));
  if (!cOk) process.exitCode = 1;
})();

// v75.16: the meaning router - the coach only picks; the app answers; a new number is refused
(function v7516() {
  function iso(d) { return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate(); }
  var today = iso(new Date());
  var ctx = {
    eff: { cards: [], total_prepay: 0, card_owed: 0, cash: { total: 5000, free: 4000, accounts: [{ name: 'LandBank', value: 5000 }] }, floor: 0, prepay_day: 14, month: today.slice(0, 7), obligations: { debts: [], one_offs: [] } },
    base: { budgets: { Food: 0 }, salary: 25000, salary_overrides: {}, budget_overrides: {}, one_offs: {}, debts: {}, accounts: [{ name: 'LandBank', kind: 'debit', value: 5000 }] },
    txns: [
      { id: 'r1', date: today, kind: 'cash_out', amount: 300, category: 'Food', account: 'LandBank', created: '2026-01-01T00:00:00Z' },
      { id: 'r2', date: today, kind: 'cash_out', amount: 120, category: 'Transpo', account: 'LandBank', created: '2026-01-02T00:00:00Z' }
    ],
    plans: [], at: new Date().toISOString()
  };
  var a = fc.routeAnswer('ano pinakamalaki kong gastos ngayong buwan', ctx, '<think>hmm</think> {"tool":"top_spend","q":"top spending this month"}');
  var aOk = !!a && a.__path === 'rule:intentTopSpend' && a.__route === 'top_spend' && a.html.indexOf('Food') >= 0 && a.html.indexOf('read as') >= 0;
  console.log('--- v75.16 Taglish question -> the router picks top_spend, the app answers ' + (aOk ? 'OK' : 'FAIL path=' + (a && a.__path)));
  if (!aOk) process.exitCode = 1;
  var b = fc.parseRoute('{"tool":"afford","q":"can i afford 99999 next cycle"}', 'can i buy the phone', []);
  var b2 = fc.parseRoute('{"tool":"afford","q":"can i afford 15000 next cycle"}', 'kaya ko ba 15k na phone next month', []);
  var bOk = b === null && !!b2 && b2.tool === 'afford';
  console.log('--- v75.16 a rewrite with a number the user never said is refused (15k = 15000 kept) ' + (bOk ? 'OK' : 'FAIL'));
  if (!bOk) process.exitCode = 1;
  var c = fc.parseRoute('sure! here you go', 'x', []) === null && fc.parseRoute('{"tool":"rm_rf","q":"x"}', 'x', []) === null;
  console.log('--- v75.16 a broken or unknown router reply keeps the rules\' answer ' + (c ? 'OK' : 'FAIL'));
  if (!c) process.exitCode = 1;
  var saved = window.FinAI;
  window.FinAI = { remoteAvailable: function () { return true; }, forceOnline: function () { return true; } };
  var cmd = fc.handle('lunch 180 landbank', ctx), q = fc.handle('how much is free', ctx);
  var st = fc.handle('kaya ko ba yung 15k na phone next month', ctx);
  var dOk = !fc.routeWanted(cmd, ctx) && fc.routeWanted(q, ctx) && fc.routeWanted(st, ctx);
  window.FinAI = { remoteAvailable: function () { return false; }, forceOnline: function () { return true; } };
  dOk = dOk && !fc.routeWanted(q, ctx);
  window.FinAI = saved;
  console.log('--- v75.16 commands stay instant; questions route only while the coach is online ' + (dOk ? 'OK' : 'FAIL'));
  if (!dOk) process.exitCode = 1;
})();
