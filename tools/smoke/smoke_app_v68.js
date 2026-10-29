// smoke_app_v68.js — the permanent app.js smoke gate (rebuilt 2026-10-14,
// v73.47: the original was lost in the v73.42 incident and left 0-byte;
// this rebuild carries the v73.45 1k-reset scenario end-to-end, the
// v73.46 date-label check, and the v73.47 peClose binding).
// Runs the REAL app.js (IIFE) in Node with the boss's Oct 13 export seeded
// (data/smoke_seed.json: base + 94 txns + 9 plans + the recovered overlay).
// Baseline (the seed's own numbers, verified 2026-10-14): effective free
// 58,631.36 = base free 60,561.36 with the overlay (adj.free −1,930 /
// adj.card −8,402.43) applied.
// Usage: node tools\smoke\smoke_app_v68.js   (paths are __dirname-relative,
// so it runs from any cwd — repo-tracked since v73.48, was a loose file in
// finances/ that the v73.42 incident destroyed once already)
var fs = require('fs');
var path = require('path');
// v73.49: dual-layout paths — the harness is repo-tracked (tools\smoke\,
// seed beside it, app.js two levels up) AND mirrored at
// C:\Users\Jan\Muji\finance-app\tools\smoke\ (same shape). The v73.48
// re-root left the repo copy pointing at the OLD loose finances/ layout
// (seed at ROOT, app at ROOT/../../app.js), so it MODULE_NOT_FOUND'd from
// the repo. Try the repo layout first, fall back to the old one.
var ROOT = __dirname;
var seedPath = fs.existsSync(path.join(ROOT, 'smoke_seed.json'))
  ? path.join(ROOT, 'smoke_seed.json')
  : path.join(ROOT, '..', '..', 'smoke_seed.json');
var seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
var APP = fs.existsSync(path.join(ROOT, '..', '..', 'app.js'))
  ? path.join(ROOT, '..', '..', 'app.js')
  : path.join(ROOT, 'app.js');

// ---- forgiving DOM stubs (harness from the v73.45 probe, which ran green) --
function makeStub() {
  var real = {
    style: {}, dataset: {}, children: [],
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    value: '', textContent: '', innerHTML: '', className: '',
    setAttribute: function () {}, getAttribute: function () { return null; },
    appendChild: function () {}, removeChild: function () {},
    addEventListener: function () {}, removeEventListener: function () {},
    querySelector: function () { return makeStub(); },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { top: 0, left: 0, width: 100, height: 100 }; },
    getContext: function () { return new Proxy({}, { get: function (t, k) { return (typeof k === 'string') ? function () { return {}; } : t[k]; } }); },
    focus: function () {}, blur: function () {}, click: function () {},
    closest: function () { return null; }
  };
  return new Proxy(real, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (k === Symbol.toPrimitive || k === 'toString') return function () { return ''; };
      return function () { return makeStub(); };
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
// pre-seed the elements the probe reads back (confirm dialog + date label +
// ledger body). syncDateLabel finds the label via `input.id + 'Label'` — the
// stub needs a real `id` string or the Proxy returns a function for the key.
var elMap = {
  confirmMsg: makeStub(),
  plans: makeStub(), // v73.54: the plans-list target (renderPlans writes its HTML here)
  pe_date: makeStub(),
  pe_dateLabel: makeStub(),
  mlBody: makeStub(),
  planEditClose: makeStub() // the v73.47 dead id — must stay UNBOUND
};
elMap['pe_date'].id = 'pe_date';
// v73.49: byIdStub must return the SAME instance every time (the app's
// byId('mlBody').innerHTML write and the probe's read of elMap['mlBody']
// must hit one object). The pre-v73.49 version created a fresh stub per
// call, so the app wrote to a throwaway element and the "renders in the
// ledger" assertion tested an empty string — green gates, broken UI.
function byIdStub(id) {
  if (!elMap[id]) elMap[id] = makeStub();
  return elMap[id];
}
global.window = global;
global.addEventListener = function () {};
global.removeEventListener = function () {};
global.navigator = { onLine: true };
global.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
global.document = {
  readyState: 'complete',
  body: makeStub(),
  documentElement: makeStub(),
  getElementById: byIdStub,
  querySelector: function () { return makeStub(); },
  querySelectorAll: function () { return []; },
  addEventListener: function () {},
  createElement: function () { return makeStub(); },
  createTextNode: function () { return makeStub(); }
};
global.location = { protocol: 'https:', host: 'x', href: 'https://x/', search: '' };
global.requestAnimationFrame = function (f) { return setTimeout(f, 0); };
global.cancelAnimationFrame = function (id) { clearTimeout(id); };
global.matchMedia = function () { return { matches: false, addListener: function () {}, removeListener: function () {} }; };
global.scrollTo = function () {};
// v73.55: the plan-edit collision guard + name/amount guards call alert() —
// undefined in Node. Record the messages so the smoke can assert the
// rejection (and so a real guard that fires doesn't crash the harness).
global.__alerts = [];
global.alert = function (m) { global.__alerts.push(String(m)); };

var META = [
  { key: 'base', value: seed.base },
  { key: 'plans', value: seed.plans },
  { key: 'adj', value: seed.adj },
  { key: 'adjSig', value: seed.adjSig },
  { key: 'moneyLog', value: seed.moneyLog || [] }
];
global.indexedDB = {
  open: function () {
    var req = {};
    var dbObj = {
      objectStoreNames: { contains: function () { return true; } },
      createObjectStore: function () {},
      transaction: function (storeName) {
        var tx = { oncomplete: null, onerror: null };
        tx.objectStore = function () {
          return {
            getAll: function () {
              var r2 = {};
              setTimeout(function () {
                var out = (storeName === 'meta') ? META : (storeName === 'plans') ? seed.plans : (storeName === 'txns') ? (seed.txns || []) : [];
                r2.result = out;
                if (r2.onsuccess) r2.onsuccess();
                if (tx.oncomplete) tx.oncomplete();
              }, 0);
              return r2;
            },
            put: function () { setTimeout(function () { if (tx.oncomplete) tx.oncomplete(); }, 0); return {}; },
            delete: function () { setTimeout(function () { if (tx.oncomplete) tx.oncomplete(); }, 0); return {}; },
            get: function () { var p = {}; setTimeout(function () { p.result = null; if (p.onsuccess) p.onsuccess(); if (tx.oncomplete) tx.oncomplete(); }, 0); return p; }
          };
        };
        return tx;
      },
      close: function () {}
    };
    setTimeout(function () { req.result = dbObj; if (req.onsuccess) req.onsuccess(); }, 0);
    return req;
  }
};

var src = fs.readFileSync(APP, 'utf8');
eval(src);

function waitReady() {
  return new Promise(function (res, rej) {
    var n = 0;
    (function poll() {
      var F = global.window.FinApp;
      if (F && F.state && F.state.adjLoaded && F.state.snapshot) return res(F);
      if (++n > 400) return rej(new Error('state never reached adjLoaded+snapshot'));
      setTimeout(poll, 25);
    })();
  });
}

function close(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 0.01 : tol); }
var fails = 0;
function ok(cond, msg) { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg); if (!cond) fails++; }
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

waitReady().then(async function (F) {
  var st = F.state;
  // TRUE baseline — before any probe txn
  var trueFree = F.effectiveSnap().cash.free;
  var snapFree = st.snapshot.cash.free; // the raw base free (overlay-zero view)
  ok(!!st.base && !!st.plans, 'boot: state loaded from the seeded export');
  ok(st.plans.length === 9, 'boot: 9 plans in the seed (got ' + st.plans.length + ')');
  ok(close(trueFree, 58631.36), "boot: effective free = the seed's live number 58,631.36 (got " + trueFree.toFixed(2) + ')');
  ok(close(snapFree, 60561.36), 'boot: base free (overlay-zero view) = 60,561.36 (got ' + snapFree.toFixed(2) + ')');

  // ============ PART 1: the boss's exact 1k scenario ============
  var id1 = await F.addTxn({ kind: 'cash_out', category: 'Food', account: 'Cash', amount: 1000, note: 'probe meal', date: '2026-10-13' }, { quiet: true });
  await sleep(60);
  var freeAfterLog = F.effectiveSnap().cash.free;
  ok(close(trueFree - freeAfterLog, 1000), 'log 1k: free drops by exactly 1,000 (' + freeAfterLog.toFixed(2) + ')');

  // reset #1 — the confirm dialog must open, NOT auto-reset. The dialog names
  // the MEASURED move of the whole overlay (this seed's overlay nets +1,930 on
  // free — base 60,561.36 vs effective 58,631.36 — and +8,402.43 on cards
  // owed; the 1k logged above is inside that, so the move is +2,930.00).
  F.resetAdj();
  await sleep(30);
  var dlgMsg = String(elMap['confirmMsg'].innerHTML);
  ok(close(F.effectiveSnap().cash.free, freeAfterLog), 'reset: nothing happens before confirm (free unchanged)');
  ok(dlgMsg.indexOf('2,930.00') >= 0, 'reset: confirm names the exact free-cash move (2,930.00 = 1,930 overlay net + 1,000 probe) — got: ' + dlgMsg.slice(0, 160));
  ok(/rise by/.test(dlgMsg), 'reset: wording names the free-cash move ("rise by")');
  ok(dlgMsg.indexOf('8,402.43') >= 0, 'reset: confirm names the cards-owed move (8,402.43)');

  // confirm
  F.confirmYes();
  await sleep(80);
  var freeAfterReset = F.effectiveSnap().cash.free;
  ok(close(freeAfterReset, snapFree), 'reset: free jumps to the base view (' + freeAfterReset.toFixed(2) + ' == ' + snapFree.toFixed(2) + ')');
  ok(st.adj.free === 0 && st.adj.card === 0 && st.adj.cash === 0, 'reset: overlay zeroed');

  // audit rows — one for the free move, one for the cards-owed move
  var audit = st.moneyLog.filter(function (e) { return e.k === 'r'; });
  ok(audit.length === 2, 'audit: two audit rows filed (free + cards) (got ' + audit.length + ')');
  var aFree = audit.filter(function (e) { return e.f != null; })[0];
  var aCard = audit.filter(function (e) { return e.o != null; })[0];
  if (aFree) {
    ok(close(aFree.n, 2930), 'audit: free row n = +2,930 (got ' + aFree.n + ')');
    ok(close(aFree.f, snapFree), 'audit: free row f = base free after (got ' + aFree.f + ')');
  }
  if (aCard) {
    ok(close(aCard.n, 8402.43), 'audit: cards row n = +8,402.43 (got ' + aCard.n + ')');
  }

  // v73.49: the ledger repaint must be AUTOMATIC — the reset's emit('adj')
  // is the only repaint path. (The old gate called F.renderMoneyLog() by
  // hand, so it would pass even with the wiring broken — that's how the
  // boss's "rows never appear" slipped through.)
  await sleep(30);
  ok(/reset to my numbers/i.test(String(elMap['mlBody'].innerHTML)), 'audit: renders in the ledger WITHOUT a manual render call');

  // delete the 1k txn — the OLD code created a phantom −1,000 here
  await F.deleteTxn(id1);
  await sleep(80);
  var freeAfterDelete = F.effectiveSnap().cash.free;
  ok(close(freeAfterDelete, snapFree), 'delete after reset: NO phantom (free unchanged ' + freeAfterDelete.toFixed(2) + ')');
  ok(st.adj.free === 0, 'delete after reset: overlay still empty');

  // ============ PART 2: undo restores the overlay ============
  var id2 = await F.addTxn({ kind: 'cash_out', category: 'Food', account: 'Cash', amount: 1000, note: 'probe meal 2', date: '2026-10-13' }, { quiet: true });
  await sleep(60);
  var freeBeforeReset2 = F.effectiveSnap().cash.free; // snapFree − 1000
  F.resetAdj();
  await sleep(30);
  F.confirmYes();
  await sleep(80);
  ok(F.getResetUndoState() !== null, 'undo: pending state captured');
  var undoBtn = elMap['snackUndo'];
  ok(!!undoBtn && typeof undoBtn.onclick === 'function', 'undo: the toast carries a working Undo button');
  if (undoBtn && typeof undoBtn.onclick === 'function') {
    undoBtn.onclick();
    await sleep(80);
    var freeAfterUndo = F.effectiveSnap().cash.free;
    ok(close(freeAfterUndo, freeBeforeReset2), 'undo: overlay restored (free back to pre-reset ' + freeAfterUndo.toFixed(2) + ')');
    ok(F.getResetUndoState() === null, 'undo: pending state cleared');
    var auditAfter = st.moneyLog.filter(function (e) { return e.k === 'r'; });
    ok(auditAfter.length === 2, "undo: THIS reset's audit row removed (PART 1's 2 remain) (got " + auditAfter.length + ')');
    ok(auditAfter.every(function (e) { return Math.abs(e.n - 1000) > 0.01; }), "undo: the removed row was THIS reset's n=+1,000 (PART 1's rows untouched)");
  }

  // ============ PART 3: direction-aware wording ============
  st.adj = { cash: 0, free: 500, card: 0, prepay: 0, prepayBy: {}, mv: 3 };
  await sleep(20);
  F.resetAdj();
  await sleep(30);
  var dlg2 = String(elMap['confirmMsg'].innerHTML);
  ok(/rise by/.test(dlg2), 'wording: positive overlay says "rise by" — got: ' + dlg2.slice(0, 120));
  ok(dlg2.indexOf('500.00') >= 0, 'wording: amount 500.00 named');
  var noBtn = elMap['confirmNo'];
  if (noBtn && typeof noBtn.onclick === 'function') noBtn.onclick();
  await sleep(20);

  // ============ PART 4: edit-txn no-op on an empty overlay ============
  st.adj = { cash: 0, free: 0, card: 0, prepay: 0, prepayBy: {}, mv: 3 };
  await sleep(20);
  var id3 = await F.addTxn({ kind: 'cash_out', category: 'Food', account: 'Cash', amount: 200, note: 'probe edit', date: '2026-10-13' }, { quiet: true });
  await sleep(60);
  st.adj = { cash: 0, free: 0, card: 0, prepay: 0, prepayBy: {}, mv: 3 }; // simulate a reset wipe
  await sleep(20);
  var freeBeforeEdit = F.effectiveSnap().cash.free;
  await F.saveTxnEdit(id3, { kind: 'cash_out', category: 'Food', account: 'Cash', amount: 900, note: 'probe edit big', date: '2026-10-13' });
  await sleep(80);
  var freeAfterEdit = F.effectiveSnap().cash.free;
  ok(close(freeAfterEdit, freeBeforeEdit), 'edit after reset: no phantom (free unchanged ' + freeAfterEdit.toFixed(2) + ')');

  // ============ PART 5: the v73.46 date label ============
  var pe = elMap['pe_date'], pel = elMap['pe_dateLabel'];
  ok(!!pe && !!pel, 'v73.46: pe_date + pe_dateLabel exist');
  var rp = null;
  for (var i = 0; i < st.plans.length; i++) if (st.plans[i].repeat) { rp = st.plans[i]; break; }
  ok(!!rp, 'v73.46: a recurring plan exists in the seed');
  if (rp) {
    var occs = F.planOccurrences(rp);
    ok(occs && occs.length > 0, 'v73.46: occurrences resolve for the seed plan');
    if (occs && occs.length) {
      var d0 = Array.isArray(occs[0]) ? occs[0][0] : occs[0];
      F.openPlanEdit(rp.id, d0);
      await sleep(20);
      ok(pe.value === d0, 'v73.46: sheet date pre-filled with the occurrence date (' + pe.value + ')');
      ok(String(pel.textContent) !== 'Pick a date' && String(pel.textContent).length > 0, 'v73.46: label shows the REAL date, not "Pick a date" (got: ' + pel.textContent + ')');
      ok(String(pel.className).indexOf('empty') < 0, 'v73.46: label not in the empty style');
    }
  }

  // ============ PART 6: v73.47 — the edit sheet's ✕ ============
  ok(typeof elMap['peClose'].onclick === 'function', 'v73.47: the edit sheet\'s ✕ (#peClose) has a handler bound');
  // the stub Proxy fabricates functions for unknown keys — read the raw
  // target so an unbound onclick stays undefined
  ok(!('onclick' in elMap['planEditClose']), 'v73.47: the dead id #planEditClose is no longer the binding target');
  if (typeof elMap['peClose'].onclick === 'function') {
    elMap['peClose'].onclick();
    await sleep(20);
    ok(F.planEditCtx() === null, 'v73.47: tapping ✕ clears the edit context (sheet closed)');
  }

  // ============ PART 7: v73.50/v73.51 — toast lifetime by kind ============
  // v73.50: the 7s auto-hide is gone. v73.51 (user: 'delete toasts swipe to
  // hide, add toasts hide after 10s unless swiped'): kind === 'add' → a
  // 10s hide timer IS scheduled; default (delete/nudge/error) → NO timer,
  // it lives until swiped. Spy on global.setTimeout for the duration of
  // each call; the swipe-dismiss path (hideSnack — what the pointerup
  // release calls) still closes the banner.
  var snEl = byIdStub('snack');
  // Patch classList.add on the classList OBJECT itself (the Proxy's set trap
  // would store `snEl.classList.add = ...` as a property of the element,
  // not of the classList the app calls).
  var snAdds = [];
  var origAdd = snEl.classList.add;
  snEl.classList.add = function (c) { snAdds.push(c); return origAdd(c); };
  var scheduled = [];
  var realSetTimeout = global.setTimeout;
  function snackWithSpy(msg, kind) {
    scheduled = [];
    global.setTimeout = function (fn, ms) { scheduled.push({ fn: fn, ms: ms }); return realSetTimeout(function () {}, 0); };
    F.snack(msg, null, kind);
    global.setTimeout = realSetTimeout;
  }
  snackWithSpy('probe: delete toast — I stay until swiped');
  ok(snAdds.indexOf('show') >= 0, 'v73.51: snack shows');
  ok(scheduled.length === 0, 'v73.51: default (delete) toast schedules NO auto-hide — got ' + scheduled.length + ' timer(s)');
  F.hideSnack(); // the swipe-up release path
  snAdds = [];
  snackWithSpy('probe: add toast — I hide after 10s', 'add');
  ok(snAdds.indexOf('show') >= 0, 'v73.51: an add toast shows');
  ok(scheduled.length === 1 && scheduled[0].ms === 10000,
    'v73.51: add toast schedules exactly one 10s auto-hide — got ' + JSON.stringify(scheduled.map(function (s) { return s.ms; })));
  F.hideSnack();
  snEl.classList.add = origAdd;

  // ============ PART 8: v73.52 — Money in on a CC = a payoff ============
  // (user: 'when i log money in entry, i should be able to choose my cc
  // accounts and that subtracts from my owed in that cc'). The kind decision
  // is pure (addSheetKind); the payoff math is the existing card_payment
  // overlay rule (owed − amt, free untouched, raw liquid − amt).
  ok(F.addSheetKind('moneyin', 'CASH', null) === 'cash_in', 'v73.52: Money in on a cash account is still cash_in');
  ok(F.addSheetKind('salary', 'CASH', null) === 'cash_in', 'v73.52: the salary chip (salary mode) on cash is still cash_in');
  ok(F.addSheetKind('moneyin', 'CARD', null) === 'card_payment', 'v73.52: Money in on a CARD account is a payoff (card_payment)');
  ok(F.addSheetKind('salary', 'CARD', null) === 'card_payment', 'v73.52: the salary chip on a card is a payoff too');
  ok(F.addSheetKind('spend', 'CARD', null) === 'card_charge', 'v73.52: Spend on a card is still a charge (untouched)');
  ok(F.addSheetKind('prepay', 'CARD', null) === 'card_payment', 'v73.52: Pay card mode is still a payoff (untouched)');
  // the Paid-with list in Money in offers the cards, labeled "· CC"
  var accSel = byIdStub('f_account');
  F.setAddMode('moneyin');
  await sleep(20);
  var miOpts = (accSel.innerHTML || '').split('<option');
  ok(miOpts.some(function (o) { return o.indexOf('CARD::Maya CC') >= 0 && o.indexOf('· CC') >= 0; }),
    'v73.52: Money in offers Maya CC in Paid with, labeled "· CC"');
  ok(miOpts.some(function (o) { return o.indexOf('CARD::MariBank CC') >= 0 && o.indexOf('· CC') >= 0; }),
    'v73.52: Money in offers MariBank CC in Paid with, labeled "· CC"');
  ok(miOpts.some(function (o) { return o.indexOf('value="CASH::Cash"') >= 0; }),
    'v73.52: Money in keeps Cash as the default option');
  F.setAddMode('spend');
  await sleep(20);
  var spOpts = (accSel.innerHTML || '').split('<option');
  ok(spOpts.some(function (o) { return o.indexOf('CARD::Maya CC') >= 0 && o.indexOf('· CC') < 0; }),
    'v73.52: Spend still lists the cards (unlabeled) for charges');
  // the payoff itself: owed drops, free untouched, raw liquid drops
  var owedBefore = F.effectiveSnap().card_owed;
  var freeBeforePay = F.effectiveSnap().cash.free;
  var rawBeforePay = F.effectiveSnap().cash.total;
  var id4 = await F.addTxn({ kind: 'card_payment', category: '', account: 'Maya CC', amount: 500, note: 'probe moneyin-cc payoff', date: '2026-10-14' }, { quiet: true });
  await sleep(60);
  ok(close(F.effectiveSnap().card_owed, owedBefore - 500), 'v73.52: the payoff drops owed by 500 (' + F.effectiveSnap().card_owed.toFixed(2) + ')');
  ok(close(F.effectiveSnap().cash.free, freeBeforePay), 'v73.52: the payoff leaves free UNTOUCHED (' + F.effectiveSnap().cash.free.toFixed(2) + ')');
  ok(close(F.effectiveSnap().cash.total, rawBeforePay - 500), 'v73.52: the payoff drops raw liquid by 500');
  await F.deleteTxn(id4);
  await sleep(40);

  // ============ PART 9: v73.53 — cashback payoff = NEW money ============
  // (user: 'the cc payoff i make using the money in tab doesnt charge to my
  // liquid because its from a cashback'). A cashback payoff (t.cashback)
  // drops owed and the card balance, RISES free by the full amount, and
  // leaves raw liquid untouched. The plain payoff (PART 8) keeps its rule.
  var owedCb = F.effectiveSnap().card_owed;
  var freeCb = F.effectiveSnap().cash.free;
  var rawCb = F.effectiveSnap().cash.total;
  var mayaBal = null;
  F.effectiveSnap().cards.forEach(function (c) { if (c.name === 'Maya CC') mayaBal = c.balance; });
  var id5 = await F.addTxn({ kind: 'card_payment', category: '', account: 'Maya CC', amount: 500, note: 'probe cashback', date: '2026-10-14', cashback: true }, { quiet: true });
  await sleep(60);
  var es5 = F.effectiveSnap();
  ok(close(es5.card_owed, owedCb - 500), 'v73.53: the cashback payoff drops owed by 500 (' + es5.card_owed.toFixed(2) + ')');
  ok(close(es5.cash.free, freeCb + 500), 'v73.53: the cashback payoff RAISES free by 500 (' + es5.cash.free.toFixed(2) + ')');
  ok(close(es5.cash.total, rawCb), 'v73.53: the cashback payoff leaves raw liquid UNTOUCHED (' + es5.cash.total.toFixed(2) + ')');
  ok(close(es5.cards.filter(function (c) { return c.name === 'Maya CC'; })[0].balance, mayaBal - 500), 'v73.53: the cashback payoff drops Maya CC balance by 500 (utilization follows)');
  // the flag rides the ledger row (undo's record) and the row renders its
  // free line (a plain payoff hides it — v72.44)
  var row5 = null;
  F.state.moneyLog.forEach(function (e) { if (e.tid === id5) row5 = e; });
  ok(!!row5 && row5.cb === true, 'v73.53: the cashback flag rides the ledger row');
  var seg5 = (byIdStub('mlBody').innerHTML || '').slice((byIdStub('mlBody').innerHTML || '').indexOf('probe cashback'));
  ok(seg5.indexOf('ml-f') >= 0, 'v73.53: the cashback row shows its free line (new money)');
  // delete + undo restore the exact pre-payoff state (no phantom, no stuck flag)
  await F.deleteTxn(id5);
  await sleep(40);
  var es6 = F.effectiveSnap();
  ok(close(es6.cash.free, freeCb) && close(es6.card_owed, owedCb) && close(es6.cash.total, rawCb),
    'v73.53: deleting the cashback payoff restores free/owed/liquid exactly');
  // editing: the flag can be set, kept, and CLEARED on a card_payment
  var id6 = await F.addTxn({ kind: 'card_payment', category: '', account: 'Maya CC', amount: 200, note: 'probe edit flag', date: '2026-10-14' }, { quiet: true });
  await sleep(40);
  var freeE0 = F.effectiveSnap().cash.free;
  await F.saveTxnEdit(id6, { kind: 'card_payment', category: '', account: 'Maya CC', amount: 200, note: 'probe edit flag', date: '2026-10-14', cashback: true });
  await sleep(40);
  ok(close(F.effectiveSnap().cash.free, freeE0 + 200), 'v73.53: editing a payoff TO cashback raises free by the amount');
  await F.saveTxnEdit(id6, { kind: 'card_payment', category: '', account: 'Maya CC', amount: 200, note: 'probe edit flag', date: '2026-10-14' });
  await sleep(40);
  ok(close(F.effectiveSnap().cash.free, freeE0), 'v73.53: editing a cashback payoff back to plain restores free');
  await F.deleteTxn(id6);
  await sleep(40);
  // the cashback row's visibility: Money in + card = visible, anything else hidden
  var cbRow = byIdStub('cashbackRow');
  F.setAddMode('moneyin');
  await sleep(20);
  var accSel2 = byIdStub('f_account');
  accSel2.value = 'CARD::Maya CC';
  F.updateCashbackRow();
  ok(cbRow.style.display !== 'none', 'v73.53: the cashback row shows for Money in + a card pick');
  F.setAddMode('spend');
  await sleep(20);
  accSel2.value = 'CARD::Maya CC';
  F.updateCashbackRow();
  ok(cbRow.style.display === 'none', 'v73.53: the cashback row hides in Spend mode (a charge is never a cashback payoff)');
  F.setAddMode('moneyin');
  await sleep(20);
  accSel2.value = 'CASH::Cash';
  F.updateCashbackRow();
  ok(cbRow.style.display === 'none', 'v73.53: the cashback row hides for a cash pick');

  // ============ PART 10: v73.54 — the skip record + unskip path ============
  // (boss: 'a label in the plans list whenever i skip a due, so i can unskip
  // it later'). The seed's Gym (pmuimaif9irt, monthly, 1,200) has its next
  // due 2026-11-04 — in-cycle and UNPAID, so skipping it via the coach chip
  // (the v73.28 path) drops the cycle deduction by exactly the due, and
  // unskipping must return it. (Rent's next due is already logged-paid, so
  // its deduction is 0 — the delta test needs an unpaid due.)
  console.log('\n== PART 10: v73.54 — skip record + unskip ============');
  var gym = null;
  F.state.plans.forEach(function (p) { if (p.id === 'pmuimaif9irt') gym = p; });
  ok(!!gym && gym.repeat === 'monthly', 'v73.54: seed precondition — Gym is the monthly plan');
  var nextGym = F.planOccurrences(gym)[0];
  ok(nextGym === '2026-11-04', 'v73.54: Gym\'s next due is 2026-11-04 (in-cycle) (got ' + nextGym + ')');
  var ded0 = F.cyclePlanDeduction();
  ok(ded0 > 0, 'v73.54: baseline cycle deduction is non-zero (' + ded0.toFixed(2) + ')');
  // skip the next due via the coach chip (the v73.28 handler)
  F.skipPlanChip('pmuimaif9irt|' + nextGym);
  await sleep(40);
  ok(gym.overrides[nextGym] && gym.overrides[nextGym].skip,
    'v73.54: the coach chip writes the skip-override');
  ok(typeof gym.overrides[nextGym].skippedAt === 'number',
    'v73.54: the skip carries a skippedAt stamp (by-when record)');
  var dedSkip = F.cyclePlanDeduction();
  ok(close(ded0 - dedSkip, gym.amount), 'v73.54: skipping the in-cycle due drops the deduction by exactly the due (' + (ded0 - dedSkip).toFixed(2) + ')');
  // the record row renders in the plans list (label + ↺, both data-unskip).
  // v73.60: recurring series live on the Recurring tab — switch to it.
  F.setPlanTab('rec');
  F.renderPlans();
  var plansHtml = String(byIdStub('plans').innerHTML || '');
  ok(plansHtml.indexOf('data-unskip="pmuimaif9irt|' + nextGym + '"') >= 0,
    'v73.54: the plans list renders the skipped occurrence as a record row (data-unskip present)');
  ok(plansHtml.indexOf('skipped') >= 0, 'v73.54: the record row wears the "skipped" label');
  ok(plansHtml.indexOf('1 skipped') >= 0, 'v73.54: the series header counts its skips ("1 skipped")');
  // the unskip path: the due returns to the cycle deduction and the override
  // (and its stamp) is gone
  await F.unskipPlanOccurrence('pmuimaif9irt', nextGym);
  await sleep(40);
  ok(!gym.overrides[nextGym] || !gym.overrides[nextGym].skip,
    'v73.54: unskip removes the skip-override');
  ok(close(F.cyclePlanDeduction(), ded0), 'v73.54: unskip returns the due to the cycle deduction (back to ' + ded0.toFixed(2) + ')');
  F.renderPlans();
  ok(String(byIdStub('plans').innerHTML || '').indexOf('data-unskip="pmuimaif9irt|' + nextGym + '"') < 0,
    'v73.54: after unskip the record row is gone');
  // unskip is a no-op on a date that isn't skipped (the guard)
  await F.unskipPlanOccurrence('pmuimaif9irt', nextGym);
  await sleep(20);
  ok(!gym.overrides[nextGym], 'v73.54: unskip on an unskipped date is a no-op');

  // ============ PART 11: v73.55 — the ✎/✕ must not vanish on a skipped plan ============
  // (boss: 'after a plan occurrence is SKIPPED, the plan record is no longer
  // editable nor deletable in the plans list'). The skip-override blocks
  // nothing — the ✎ was rendered only when `shown.length` (skipping the
  // next due emptied it) and the recurring header had NO ✕ at all.
  console.log('\n== PART 11: v73.55 — edit/delete survive a skip ============');
  var gym2 = null;
  F.state.plans.forEach(function (p) { if (p.id === 'pmuimaif9irt') gym2 = p; });
  var occ2 = F.planOccurrences(gym2);
  ok(occ2.length >= 2, 'v73.55: seed precondition — Gym has >= 2 future occurrences (got ' + occ2.length + ')');
  occ2.forEach(function (d) {
    F.skipPlanChip('pmuimaif9irt|' + d); // skip EVERY due -> shown = []
  });
  await sleep(60);
  F.setPlanTab('rec'); // v73.60: the series lives on the Recurring tab
  F.renderPlans();
  var plansHtml2 = String(byIdStub('plans').innerHTML || '');
  ok(plansHtml2.indexOf('data-editp="pmuimaif9irt"') >= 0 &&
     plansHtml2.indexOf('data-editd="' + occ2[0] + '"') >= 0,
    'v73.55: the ✎ stays on a fully-skipped plan (targeting the skipped occurrence)');
  ok(plansHtml2.indexOf('data-delp="pmuimaif9irt"') >= 0,
    'v73.55: the recurring header has a ✕ (plans-list delete)');
  // the edit sheet opens on the skipped occurrence (openPlanEdit guards only
  // on !p || !p.repeat — the override is inert to it)
  F.openPlanEdit('pmuimaif9irt', occ2[0]);
  await sleep(20);
  // (planEditCtx is exported as a GETTER — the v73.47 pin calls it too)
  ok(F.planEditCtx() && F.planEditCtx().dateISO === occ2[0],
    'v73.55: openPlanEdit opens on a skipped occurrence');
  // the date-collision guard counts SKIPPED dates too (v73.55: the old
  // guard skipped them, so a move could land on another skipped date)
  byIdStub('pe_date').value = occ2[1];
  global.__alerts.length = 0;
  F.savePlanOccurrence();
  await sleep(40);
  ok(!gym2.overrides[occ2[0]] || !gym2.overrides[occ2[0]].move,
    'v73.55: moving a skipped due onto another skipped date is rejected (collision)');
  ok(global.__alerts.some(function (m) { return m.indexOf('already falls on') >= 0; }),
    'v73.55: the collision alert fired (the guard named the skipped date)');
  byIdStub('pe_date').value = '2026-12-05';
  F.savePlanOccurrence();
  await sleep(40);
  ok(gym2.overrides[occ2[0]] && gym2.overrides[occ2[0]].move === '2026-12-05',
    'v73.55: moving a skipped due to a free date is allowed');
  // clean up: restore the pristine plan (the tests above mutated it)
  delete gym2.overrides[occ2[0]];
  delete gym2.overrides[occ2[1]];
  await F.idbPut('plans', gym2);
  await sleep(20);

  // ============ PART 12: v73.56 — link-only paid + expandable this-cycle dues ============
  // (1) the boss's 12k-rent incident, reproduced: a fuzzy-matched payment
  // from a PREVIOUS month (name word "rent" within the old [due-2, ∞)
  // window) must NOT count toward the current occurrence. Only the
  // explicit planRef link (the chip's tap) marks an occurrence paid.
  // (2) the hero's THIS-cycle "Plan dues" row is expandable like the peek.
  console.log('\n== PART 12: v73.56 — link-only paid + expandable this-cycle dues ============');
  // findPaidTxn is pure over (d, kind) + state.txns — drive it directly.
  // A fuzzy "Rent payment" logged 20 days before the due (name word +
  // inside the old overdue window) must be ignored.
  var probeRent = { planId: 'pmuk0wjffffx', date: '2026-10-15', name: 'Rent', amount: 12030 };
  var fuzzyTxn = { kind: 'cash_out', category: 'Housing', note: 'Rent payment', amount: 12030, date: '2026-09-25' };
  var baseTxns = F.state.txns.slice();
  F.state.txns = baseTxns.concat([fuzzyTxn]);
  var fuzzyPaid = F.findPaidTxn({ monthPrefix: '2026-10', today: '2026-10-13' }, probeRent);
  ok(!(fuzzyPaid && Number(fuzzyPaid.amount) > 0),
    'v73.56: a fuzzy name-word payment (no chip link) does NOT count as paid — the 12k-rent leak is dead (got ' + (fuzzyPaid && fuzzyPaid.amount) + ')');
  // The explicit planRef link (the chip's tap) DOES count, regardless of
  // amount — even 1 peso (the deterministic truth, unchanged).
  var linkTxn = { kind: 'cash_out', category: 'Housing', note: 'Rent payment', amount: 1, date: '2026-10-13',
    planRef: { planId: 'pmuk0wjffffx', date: '2026-10-15', name: 'Rent', amount: 12030 } };
  F.state.txns = baseTxns.concat([linkTxn]);
  var linkPaid = F.findPaidTxn({ monthPrefix: '2026-10', today: '2026-10-13' }, probeRent);
  ok(!!(linkPaid && Number(linkPaid.amount) === 1 && linkPaid.linked),
    'v73.56: the explicit planRef link counts as paid (even 1 peso, linked=true)');
  F.state.txns = baseTxns; // restore
  // (2) the THIS-cycle Plan dues row is expandable like the peek — the
  // render writes cbPlansRow into the hero block; toggle the shared
  // cbPlansOpen flag and the sub-rows (from planItems) appear.
  F.state.cycleMode = 'this';
  F.state.cbPlansOpen = false;
  F.renderCycleBlock();
  var cbClosed = String(byIdStub('cycleBlock').innerHTML || '');
  ok(cbClosed.indexOf('id="cbPlansRow"') >= 0, 'v73.56: the this-cycle Plan dues row renders (cbPlansRow present)');
  ok(cbClosed.indexOf('class="chev"') >= 0 && cbClosed.indexOf('chev open') < 0,
    'v73.56: the this-cycle Plan dues row is collapsed by default (chevron, not open)');
  F.state.cbPlansOpen = true;
  F.renderCycleBlock();
  var cbOpen = String(byIdStub('cycleBlock').innerHTML || '');
  ok(cbOpen.indexOf('class="chev open"') >= 0, 'v73.56: tapping the this-cycle Plan dues row expands it (chevron open)');
  // the sub-rows come from the same window walk as the peek (planItems)
  var pw = F.planWindowTotal(F.cycleData());
  ok(pw.items.length > 0, 'v73.56: the this-cycle window has plan items to expand (got ' + pw.items.length + ')');
  ok(cbOpen.indexOf('class="cbsub"') >= 0, 'v73.56: the this-cycle expansion renders the sub-rows (cbsub present)');
  F.state.cbPlansOpen = false; // leave the default state for any later render
  F.renderCycleBlock();

  // ============ PART 13: v73.57 — the 2-month step chart ============
  // Boss-approved spec (parked 2026-10-20): window today -> end of the next
  // 2 months; start = RAW cash (effectiveSnap.cash.total); step down on
  // EVERY plan due on its due date (this month's included — no double count,
  // the start is raw); step down per card on its payment due day (due=null
  // -> the 15th default); step up on payday; LIVE owed (a charge grows the
  // drop, a payoff shrinks it, a chip-paid/skipped due removes its drop).
  console.log('\n== PART 13: v73.57 — the 2-month step chart ============');
  var g0 = F.sparkData();
  var g0pts = g0.pts;
  // (1) start = RAW cash (the overlay-aware effective total, not the base
  // matrix's start_cash — the seed's overlay moved the raw by −10,332.43).
  var rawStart = F.effectiveSnap().cash.total;
  ok(close(g0pts[0].v, rawStart), 'v73.57: the graph starts at RAW cash (effective ' + rawStart.toFixed(2) + ', got ' + g0pts[0].v.toFixed(2) + ')');
  // (2) the 2-month window: the last point is on/before the end of the next
  // 2 months and after today (the 6-month tail is gone).
  var tToday = F.todayISO();
  var tEnd = g0pts[g0pts.length - 1].date;
  ok(tEnd > tToday, 'v73.57: the window ends after today (' + tEnd + ')');
  var tp2 = tToday.split('-');
  var tY = Number(tp2[0]), tM = Number(tp2[1]);
  var tM2 = (tM + 2 - 1) % 12 + 1, tY2 = tY + Math.floor((tM + 2 - 1) / 12);
  var tDim2 = new Date(tY2, tM2, 0).getDate();
  var tWindowEnd = tY2 + '-' + (tM2 < 10 ? '0' : '') + tM2 + '-' + (tDim2 < 10 ? '0' : '') + tDim2;
  ok(tEnd <= tWindowEnd, 'v73.57: the window ends on/before the end of the next 2 months (' + tEnd + ' <= ' + tWindowEnd + ')');
  // (3) every plan due in the window drops on ITS due date: build the
  // expected event map (planAllDates + resolveOccurrence + findPaidTxn, the
  // same rules the app uses) and assert each one is a point.
  var expPlanDates = {};
  F.state.plans.forEach(function (p) {
    F.planAllDates(p).forEach(function (od) {
      if (od < tToday || od > tWindowEnd) return;
      var ro = p.repeat ? F.resolveOccurrence(p, od) : null;
      if (ro && ro.skip) return;
      var nm = ro ? ro.name : p.name, am = ro ? ro.amount : p.amount;
      var pp = F.findPaidTxn({ monthPrefix: tToday.slice(0, 7), today: tToday }, { planId: p.id, date: od, name: nm, amount: am });
      var rem = Math.round((Number(am) - (Number(pp && pp.amount) || 0)) * 100) / 100;
      if (rem > 0.004) expPlanDates[od] = true;
    });
  });
  var gDates = {};
  g0pts.forEach(function (p) { gDates[p.date] = true; });
  var planDrops = 0;
  Object.keys(expPlanDates).forEach(function (d) { if (gDates[d]) planDrops++; });
  ok(planDrops === Object.keys(expPlanDates).length && planDrops >= 5,
    'v73.57: every unpaid plan due drops on its due date (' + planDrops + '/' + Object.keys(expPlanDates).length + ' — ' + Object.keys(expPlanDates).join(', ') + ')');
  // (4) the FULL expected event map (plan dues + card drops + payday) —
  // built with the same rules the app uses — must match the actual point
  // deltas one-for-one. The payday (salary_day 15) and the card default
  // (the 15th) MERGE on the same date, so the net step there is a drop —
  // the salary is asserted inside the map, not as a standalone rise.
  var tExp = {};
  Object.keys(expPlanDates).forEach(function (d) { tExp[d] = 0; });
  F.state.plans.forEach(function (p) {
    F.planAllDates(p).forEach(function (od) {
      if (od < tToday || od > tWindowEnd || !(tExp[od] !== undefined)) return;
      var ro = p.repeat ? F.resolveOccurrence(p, od) : null;
      if (ro && ro.skip) return;
      var nm = ro ? ro.name : p.name, am = ro ? ro.amount : p.amount;
      var pp = F.findPaidTxn({ monthPrefix: tToday.slice(0, 7), today: tToday }, { planId: p.id, date: od, name: nm, amount: am });
      tExp[od] -= Math.round((Number(am) - (Number(pp && pp.amount) || 0)) * 100) / 100; // a DROP
    });
  });
  var cardDates = [];
  F.effectiveSnap().cards.forEach(function (c) {
    var owed = Number(c.balance) || 0;
    if (!(owed > 0.004)) return;
    var day0 = (c.due != null && c.due >= 1 && c.due <= 28) ? Math.round(c.due) : 15;
    for (var k = 0; k < 3; k++) {
      var m = (tM + k - 1) % 12 + 1, yy = tY + Math.floor((tM + k - 1) / 12);
      var dim = new Date(yy, m, 0).getDate();
      var day = Math.min(day0, dim);
      var dISO = yy + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
      if (dISO < tToday) continue;
      if (dISO <= tWindowEnd) {
        tExp[dISO] = (tExp[dISO] || 0) - owed; // a DROP, once (the owed is a stock)
        if (cardDates.indexOf(dISO) < 0) cardDates.push(dISO);
      }
      break; // first due date only
    }
  });
  var sdT = F.salaryDayOf(F.state.base);
  for (var k2 = 0; k2 < 3; k2++) {
    var m2 = (tM + k2 - 1) % 12 + 1, yy2 = tY + Math.floor((tM + k2 - 1) / 12);
    var dim2b = new Date(yy2, m2, 0).getDate();
    var dISO2 = yy2 + '-' + (m2 < 10 ? '0' : '') + m2 + '-' + (Math.min(sdT, dim2b) < 10 ? '0' : '') + Math.min(sdT, dim2b);
    if (dISO2 < tToday) continue;
    tExp[dISO2] = (tExp[dISO2] || 0) + F.expectedSalaryFor(dISO2.slice(0, 7), F.state.base); // a RISE
    break;
  }
  var tExpKeys = Object.keys(tExp).sort();
  ok(tExpKeys.length >= 8, 'v73.57: the expected event map has the dues + card drops + payday (' + tExpKeys.length + ' dates)');
  var deltaOK = true, deltaBad = '';
  for (var gi4 = 1; gi4 < g0pts.length; gi4++) {
    var dISO4 = g0pts[gi4].date;
    var want = tExp[dISO4];
    if (want === undefined) { deltaOK = false; deltaBad = 'unexpected point ' + dISO4; break; }
    var got = Math.round((g0pts[gi4].v - g0pts[gi4 - 1].v) * 100) / 100;
    if (Math.abs(got - want) > 0.02) { deltaOK = false; deltaBad = dISO4 + ': got ' + got + ' want ' + want; break; }
  }
  ok(deltaOK && g0pts.length === tExpKeys.length + 1, 'v73.57: every point delta matches the expected event map (' + (deltaBad || g0pts.length - 1 + '/' + tExpKeys.length + ' dates') + ')');
  // the card default-15th is in the map (both seeded cards are due=null)
  var first15 = (Number(tp2[2]) >= 15)
    ? (tM === 12 ? tY + 1 + '-01-15' : tY + '-' + ((tM % 12) + 1 < 10 ? '0' : '') + ((tM % 12) + 1) + '-15')
    : tY + '-' + (tM < 10 ? '0' : '') + tM + '-15';
  ok(tExp[first15] !== undefined, 'v73.57: the card owed drops on the default 15th (' + first15 + ')');
  // (6) LIVE owed reactivity — a new card charge grows the card drop.
  var before = g0pts.map(function (p) { return p.v; });
  var chargeId = await F.addTxn({ kind: 'card_charge', category: 'Food', account: 'MariBank CC', amount: 2000, note: 'probe charge', date: tToday }, { quiet: true });
  await sleep(60);
  var g1 = F.sparkData();
  var vAt = function (pts, d) { for (var i = 0; i < pts.length; i++) if (pts[i].date === d) return pts[i].v; return null; };
  var cardDelta = 0;
  cardDates.forEach(function (d) {
    var a = vAt(g0pts, d), b = vAt(g1.pts, d);
    if (a !== null && b !== null) cardDelta += (a - b); // before − after = how much DEEPER the drop got
  });
  ok(close(cardDelta, 2000), 'v73.57: a new card charge grows the card drop by exactly 2,000 (got ' + cardDelta.toFixed(2) + ')');
  // (7) a chip-paid due REMOVES its drop — link a payment to the first
  // unpaid plan due in the window and its step disappears. STRICTLY AFTER
  // today: a due ON the run date merges with the chart's start point (the
  // start is always at today), so its point can never disappear — the
  // 2026-10-29 run hit exactly that (the seed's first unpaid due was the
  // run date, and the assertion tested the start point, not the drop).
  var targetDue = Object.keys(expPlanDates).filter(function (d) { return d > tToday; }).sort()[0];
  var targetPlan = null;
  F.state.plans.forEach(function (p) { if (F.planAllDates(p).indexOf(targetDue) >= 0) targetPlan = p; });
  var roT = F.resolveOccurrence(targetPlan, targetDue);
  var ppT = F.findPaidTxn({ monthPrefix: tToday.slice(0, 7), today: tToday }, { planId: targetPlan.id, date: targetDue, name: roT.name, amount: roT.amount });
  var payId = await F.addTxn({ kind: 'cash_out', category: 'Housing', account: 'Cash', amount: roT.amount, note: 'probe pay', date: tToday,
    planRef: { planId: targetPlan.id, date: targetDue, name: roT.name, amount: roT.amount } }, { quiet: true });
  await sleep(60);
  var g2 = F.sparkData();
  var g2Dates = {};
  g2.pts.forEach(function (p) { g2Dates[p.date] = true; });
  ok(!g2Dates[targetDue], 'v73.57: a chip-paid due removes its drop (' + targetDue + ' gone)');
  // (8) a skipped due REMOVES its drop too.
  var skipPlan = null, skipDue = null;
  Object.keys(expPlanDates).filter(function (d) { return d > tToday; }).sort().forEach(function (d) {
    if (d === targetDue) return;
    F.state.plans.forEach(function (p) { if (!skipPlan && F.planAllDates(p).indexOf(d) >= 0 && p.id !== targetPlan.id) { skipPlan = p; skipDue = d; } });
  });
  skipPlan.overrides = skipPlan.overrides || {};
  skipPlan.overrides[skipDue] = { skip: true, skippedAt: tToday };
  await F.idbPut('plans', skipPlan);
  await sleep(20);
  var g3 = F.sparkData();
  var g3Dates = {};
  g3.pts.forEach(function (p) { g3Dates[p.date] = true; });
  ok(!g3Dates[skipDue], 'v73.57: a skipped due removes its drop (' + skipDue + ' gone)');
  // cleanup: delete the probe txns + restore the skipped plan.
  await F.deleteTxn(chargeId); await sleep(20);
  await F.deleteTxn(payId); await sleep(20);
  delete skipPlan.overrides[skipDue];
  await F.idbPut('plans', skipPlan);
  await sleep(20);
  var g4 = F.sparkData();
  // the probe txns are deleted (the overlay is back to baseline) — recompute
  // the raw start from the effective snap (it may differ from g0's if any
  // earlier part left a txn in the ledger).
  ok(close(g4.pts[0].v, F.effectiveSnap().cash.total) && g4.pts.length === g0pts.length, 'v73.57: after cleanup the chart is back to baseline');

  // ============ PART 14: v73.58 — the skip/move chooser ============
  // (boss: 'clicking the skip allows me to skip it entirely or move it to a
  // later date in the calendar'). The coach's SKIP chip opens a chooser:
  // "Skip this occurrence" = skipPlanChip verbatim (the v73.28 override),
  // "Move to a later date" = the v73.41 move-override with the
  // savePlanOccurrence collision rule. Driven without a DOM via the
  // exported chooser fns (scDate is a byId stub the harness pre-seeds).
  console.log('\n== PART 14: v73.58 — the skip/move chooser ============');
  var gym3 = null;
  F.state.plans.forEach(function (p) { if (p.id === 'pmuimaif9irt') gym3 = p; });
  ok(!!gym3 && gym3.repeat === 'monthly', 'v73.58: seed precondition — Gym is the monthly plan');
  var occ3 = F.planOccurrences(gym3);
  ok(occ3.length >= 2, 'v73.58: Gym has >= 2 future occurrences (got ' + occ3.length + ')');
  var occA = occ3[0], occB = occ3[1];
  // clean slate on the target
  gym3.overrides = gym3.overrides || {};
  delete gym3.overrides[occA];
  await F.idbPut('plans', gym3);
  await sleep(20);
  // (1) the SKIP path inside the chooser is skipPlanChip verbatim
  F.openSkipChooser(gym3.id, occA);
  F.skipChooserSkip();
  await sleep(40);
  ok(gym3.overrides[occA] && gym3.overrides[occA].skip, 'v73.58: the chooser Skip button writes the v73.28 skip-override');
  ok(typeof gym3.overrides[occA].skippedAt === 'number', 'v73.58: the chooser skip carries the skippedAt stamp');
  delete gym3.overrides[occA];
  await F.idbPut('plans', gym3);
  await sleep(20);
  // (2) the MOVE path: writes the v73.41 move-override at the grid date,
  // the occurrence resolves to the new date, and the lists follow
  F.openSkipChooser(gym3.id, occA);
  byIdStub('scDate').value = '2026-12-05'; // a free date
  F.skipChooserMove();
  await sleep(40);
  ok(gym3.overrides[occA] && gym3.overrides[occA].move === '2026-12-05',
    'v73.58: the chooser Move writes the v73.41 move-override (move=2026-12-05)');
  ok(F.planDateAt(gym3, occA) === '2026-12-05', 'v73.58: the occurrence resolves to the new date');
  var occAfterMove = F.planOccurrences(gym3);
  ok(occAfterMove.indexOf('2026-12-05') >= 0 && occAfterMove.indexOf(occA) < 0,
    'v73.58: the moved due reappears on its new date and leaves the old one');
  // cleanup the move
  delete gym3.overrides[occA];
  await F.idbPut('plans', gym3);
  await sleep(20);
  // (3) the collision rule: a move onto ANOTHER occurrence's date is rejected
  F.openSkipChooser(gym3.id, occA);
  byIdStub('scDate').value = occB;
  global.__alerts.length = 0;
  F.skipChooserMove();
  await sleep(40);
  ok(!gym3.overrides[occA] || !gym3.overrides[occA].move, 'v73.58: moving onto another occurrence date is rejected (no move written)');
  ok(global.__alerts.some(function (m) { return m.indexOf('already falls on') >= 0; }),
    'v73.58: the collision alert fired (the savePlanOccurrence rule)');
  // (4) the past-date guard: a move to the due date (or earlier) is rejected
  F.openSkipChooser(gym3.id, occA);
  byIdStub('scDate').value = occA;
  global.__alerts.length = 0;
  F.skipChooserMove();
  await sleep(40);
  ok(!gym3.overrides[occA] || !gym3.overrides[occA].move, 'v73.58: a move to the due date itself is rejected (past guard)');
  ok(global.__alerts.some(function (m) { return m.indexOf('Pick a date after') >= 0; }),
    'v73.58: the past-date alert fired');
  // (5) the date input is constrained: min = day after the due, default = next same-day-of-month
  F.openSkipChooser(gym3.id, occA);
  var scInp = byIdStub('scDate');
  ok(scInp.min === '2026-11-05', 'v73.58: the date input min is the day after the due (got ' + scInp.min + ')');
  ok(/^2026-\d{2}-04$/.test(scInp.value) && scInp.value > '2026-11-04',
    'v73.58: the date input defaults to the next same-day-of-month (got ' + scInp.value + ')');
  F.closeSkipChooser();
  // cleanup: pristine plan
  delete gym3.overrides[occA];
  await F.idbPut('plans', gym3);
  await sleep(20);

  // ============ PART 15: v73.59 — the plans-list redesign ============
  // (boss: 'redesign the plans in money tab, it becomes so cluttered' +
  // 'i want the plans paid and past occurrences to still exist there' +
  // 'make one offs also editable'). The list splits Recurring / One-offs,
  // recurring sorts by NEXT occurrence (a moved due re-orders), the
  // expanded series shows the NEXT DUE row + the history chip strip
  // (paid ✓ / skipped strikethrough / past-due red — nothing deleted),
  // and a one-off's ✎ opens the edit sheet (name/amount/date straight).
  console.log('\n== PART 15: v73.59 — the plans-list redesign ============');
  var rent = null, calc = null;
  F.state.plans.forEach(function (p) {
    if (p.id === 'pmuk0wjffffx') rent = p;
    if (p.id === 'pmup5dq4iunh') calc = p;
  });
  ok(!!rent && rent.repeat === 'monthly', 'v73.59: seed precondition — Rent is the monthly plan');
  ok(!!calc && !calc.repeat, 'v73.59: seed precondition — Calculator is the one-off');
  // (1) the sections render, and recurring sorts by NEXT occurrence, not
  // anchor. v73.60 note: the list is now a TAB bar (One-offs default) —
  // the recurring assertions run on the Recurring tab.
  F.setPlanTab('rec');
  F.renderPlans();
  var listHtml = String(byIdStub('plans').innerHTML || '');
  ok(listHtml.indexOf('One-offs') >= 0 && listHtml.indexOf('Recurring') >= 0,
    'v73.59: the list splits into Recurring and One-offs (v73.60: as the tab bar)');
  var iGym = listHtml.indexOf('data-grp="pmuimaif9irt"');   // next due 2026-11-04
  var iCalc = listHtml.indexOf('data-editd="2026-10-09"');  // one-off date
  ok(iGym >= 0 && iCalc < 0,
    'v73.59: the Recurring pane holds the series; the one-off (Oct 9) is on its own tab — sections, not one flat list');
  var iRent = listHtml.indexOf('data-grp="pmuk0wjffffx"');
  var iGymFirst = listHtml.indexOf('data-grp="pmuimaif9irt"');
  ok(iRent >= 0 && iGymFirst >= 0 && iGymFirst < iRent,
    'v73.59: recurring sorts by NEXT occurrence — Gym (next 2026-11-04) before Rent (next 2026-11-15)');
  // (2) the expanded series: the NEXT DUE row + the history chip strip
  // (the harness can't click — setPlanOpen is the exported toggle)
  F.setPlanOpen('pmuk0wjffffx', true);
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  ok(listHtml.indexOf('NEXT DUE') >= 0, 'v73.59: the expanded series renders the NEXT DUE emphasis row');
  // a LINKED payment on Rent's past due (2026-09-15) makes it a green paid
  // chip. The SEED skips that occurrence (Rent's overrides carry a
  // 2026-09-15 skip), so clear it for this test and restore it after —
  // a skipped past due renders as a strikethrough chip, not a paid one.
  var baseTxns2 = F.state.txns.slice();
  var rentOvBackup = JSON.stringify(rent.overrides);
  delete rent.overrides['2026-09-15'];
  F.state.txns = baseTxns2.concat([{ kind: 'cash_out', category: 'Housing', note: 'Rent', amount: 3000, date: '2026-09-15',
    planRef: { planId: 'pmuk0wjffffx', date: '2026-09-15', name: 'Rent', amount: 3000 } }]);
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  // scope to Rent's HEAD row (the sub-line carries the "N paid" chip) —
  // other series (Spaylater/AC, their past dues chip-linked in the seed)
  // also carry "1 paid", so the whole-list match would be a fluke
  var rentHead = listHtml.slice(listHtml.indexOf('data-grp="pmuk0wjffffx"'));
  rentHead = rentHead.slice(0, rentHead.indexOf('<div class="plrow'));
  ok(rentHead.indexOf('1 paid') >= 0, 'v73.59: Rent\'s collapsed sub-line counts its paid history ("1 paid")');
  ok(listHtml.indexOf('hchip paid') >= 0 && listHtml.indexOf('Sep 15, 2026') >= 0,
    'v73.59: the paid past occurrence stays in the list as a green chip (hchip paid + its fmtDate date)');
  F.state.txns = baseTxns2; // restore
  rent.overrides = JSON.parse(rentOvBackup);
  // (3) a skipped FUTURE due stays visible as a strikethrough chip (the v73.54 unskip path)
  F.setPlanOpen('pmuimaif9irt', true); // expand Gym so its chip strip renders
  F.skipPlanChip('pmuimaif9irt|2026-11-04');
  await sleep(40);
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  ok(listHtml.indexOf('hchip skip') >= 0 && listHtml.indexOf('data-unskip="pmuimaif9irt|2026-11-04"') >= 0,
    'v73.59: a skipped due stays visible as a strikethrough chip carrying the unskip path');
  ok(listHtml.indexOf('1 skipped') >= 0, 'v73.59: the header still counts its skips ("1 skipped")');
  await F.unskipPlanOccurrence('pmuimaif9irt', '2026-11-04');
  await sleep(40);
  F.setPlanOpen('pmuimaif9irt', false);
  // (4) a moved due RE-ORDERS the list (the old anchor sort never did)
  var gymM = null;
  F.state.plans.forEach(function (p) { if (p.id === 'pmuimaif9irt') gymM = p; });
  gymM.overrides = gymM.overrides || {};
  gymM.overrides['2026-11-04'] = { move: '2026-12-05' };
  await F.idbPut('plans', gymM);
  await sleep(20);
  F.setPlanTab('rec'); // v73.60: the re-order assertion needs the Recurring pane
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  var iGymMoved = listHtml.indexOf('data-grp="pmuimaif9irt"');
  var iAve = listHtml.indexOf('data-grp="pmv502ftnhy2"'); // Ave next 2026-11-18
  ok(iGymMoved >= 0 && iAve >= 0 && iAve < iGymMoved,
    'v73.59: moving Gym to 2026-12-05 re-orders it AFTER Ave (next 2026-11-18) — sort by next occurrence');
  delete gymM.overrides['2026-11-04'];
  await F.idbPut('plans', gymM);
  await sleep(20);
  // (5) one-offs are EDITABLE — the ✎ opens the sheet, save writes name/amount/date straight.
  // v73.60: the one-off lives on the One-offs tab — switch back to it first
  // (this part opened on the Recurring tab for the sort assertions).
  F.setPlanTab('one');
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  ok(listHtml.indexOf('data-editp="pmup5dq4iunh" data-editd="2026-10-09"') >= 0,
    'v73.59: the one-off row carries a ✎ targeting its own date');
  F.openPlanEdit('pmup5dq4iunh', '2026-10-09');
  ok(F.planEditCtx() && F.planEditCtx().dateISO === '2026-10-09',
    'v73.59: openPlanEdit opens on a ONE-OFF (the !p.repeat guard is lifted)');
  byIdStub('pe_name').value = 'Calculator (new)';
  byIdStub('pe_amount').value = '2500';
  byIdStub('pe_date').value = '2026-10-20';
  F.savePlanOccurrence();
  await sleep(40);
  ok(calc.name === 'Calculator (new)' && calc.amount === 2500 && calc.date === '2026-10-20',
    'v73.59: saving a one-off edit writes name/amount/date straight onto the record (got ' + calc.name + ' / ' + calc.amount + ' / ' + calc.date + ')');
  // restore the pristine one-off + collapse the series (leave the default state)
  calc.name = 'Calculator'; calc.amount = 2000; calc.date = '2026-10-09';
  await F.idbPut('plans', calc);
  F.setPlanOpen('pmuk0wjffffx', false);
  await sleep(20);

  // ============ PART 16: v73.60 — the plans tab bar ============
  // (boss: 'lets separate them thru a tab, left tab is oneoffs, right is
  // recurring' + 'Ship it as v73.60 (one-offs default default)'). The
  // v73.59 stacked sections become a tab bar — One-offs LEFT, Recurring
  // RIGHT, counts ride the tabs, ONE-OFFS is the default. Pure layout:
  // both lists always exist, the tab is in-memory view state.
  console.log('\n== PART 16: v73.60 — the plans tab bar ============');
  F.setPlanTab('one'); // the default — also proves the exported setter
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  ok(listHtml.indexOf('class="pltabs"') >= 0, 'v73.60: the plans list renders the tab bar');
  ok(listHtml.indexOf('data-pltab="one"') >= 0 && listHtml.indexOf('data-pltab="rec"') >= 0,
    'v73.60: both tabs render (One-offs + Recurring)');
  var iTabOne = listHtml.indexOf('data-pltab="one"');
  var iTabRec = listHtml.indexOf('data-pltab="rec"');
  ok(iTabOne >= 0 && iTabRec >= 0 && iTabOne < iTabRec,
    'v73.60: One-offs is the LEFT tab, Recurring the RIGHT (tab order)');
  ok(listHtml.indexOf('class="pltab on"') >= 0 && listHtml.indexOf('class="pltab on"') < iTabRec,
    'v73.60: the active (on) tab is One-offs by default');
  // counts ride the tabs: seed = 1 one-off (Calculator), 8 recurring
  var cntOne = listHtml.slice(iTabOne, listHtml.indexOf('</div>', iTabOne));
  var cntRec = listHtml.slice(iTabRec, listHtml.indexOf('</div>', iTabRec));
  ok(/plcnt">1</.test(cntOne), 'v73.60: the One-offs tab carries its count (1)');
  ok(/plcnt">8</.test(cntRec), 'v73.60: the Recurring tab carries its count (8)');
  // the DEFAULT pane shows the one-off, NOT a recurring series
  ok(listHtml.indexOf('data-editp="pmup5dq4iunh"') >= 0,
    'v73.60: the default (One-offs) pane shows the one-off row');
  ok(listHtml.indexOf('data-grp="pmuk0wjffffx"') < 0,
    'v73.60: the default pane does NOT show a recurring series (Rent) — that lives on the Recurring tab');
  // switch to Recurring: the series appear, the one-off leaves the pane
  F.setPlanTab('rec');
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  ok(listHtml.indexOf('data-grp="pmuk0wjffffx"') >= 0 && listHtml.indexOf('data-grp="pmuimaif9irt"') >= 0,
    'v73.60: switching to Recurring shows the recurring series (Rent, Gym)');
  ok(listHtml.indexOf('data-editp="pmup5dq4iunh"') < 0,
    'v73.60: the one-off leaves the pane on the Recurring tab (view state only — nothing deleted)');
  // the on class precedes its own data-pltab attr — the active tab's class
  // must sit AFTER the one tab and BEFORE the rec tab's data attr
  ok(listHtml.indexOf('data-pltab="one"') < listHtml.indexOf('pltab on') &&
     listHtml.indexOf('pltab on') < listHtml.indexOf('data-pltab="rec"'),
    'v73.60: after switching, the active (on) tab is Recurring');
  // back to the default
  F.setPlanTab('one');
  await sleep(20);

  // ============ PART 17: v73.61 — the state-aware fast-forward ============
  // (boss: the recurring Rent VANISHED a day past due — planGridDates' blind
  // fast-forward dropped the past occurrence off the grid, so the v73.27
  // overdue row, the hero deduction, the graph, and the peek all went blind).
  // The advance is now one-occurrence-at-a-time and state-aware:
  //   skipped / fully planRef-paid -> advance
  //   moved to the future          -> advance, moved date pushed into window
  //   moved to the past            -> STAY (overdue at the moved date)
  //   unpaid / partly paid         -> STAY (the v73.27 overdue row keeps it)
  console.log('\n== PART 17: v73.61 — the state-aware fast-forward ============');
  var T17 = F.todayISO();
  var d17 = function (iso, days) { var dd = new Date(iso + 'T00:00:00'); dd.setDate(dd.getDate() + days); return dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0') + '-' + String(dd.getDate()).padStart(2, '0'); };
  var anchor = d17(T17, -1); // due YESTERDAY — one day past due
  var nextM = F.shiftMonth(anchor, 1); // the next grid date is +1 MONTH, not +30 days
  var mkPlan17 = function (id, over) {
    var p = { id: id, name: 'P17 ' + id, amount: 1000, date: anchor, repeat: 'monthly', count: null, created: '2026-01-01T00:00:00.000Z' };
    if (over) p.overrides = over;
    return p;
  };
  var run17 = function (label, p, expectHas, expectNotHas) {
    F.state.plans.push(p);
    var all = F.planAllDates(p);
    var has = expectHas.every(function (d) { return all.indexOf(d) >= 0; });
    var notHas = expectNotHas.every(function (d) { return all.indexOf(d) < 0; });
    ok(has && notHas, 'v73.61: ' + label + ' — planAllDates ' + JSON.stringify(all) +
      (has ? '' : ' (missing ' + expectHas.join(',') + ')') + (notHas ? '' : ' (should not have ' + expectNotHas.join(',') + ')'));
    F.state.plans.pop();
  };
  // 1. unpaid, 1 day past due -> the due STAYS (the boss's Rent bug)
  run17('unpaid past-due stays (the Rent bug)', mkPlan17('p17a'), [anchor], [nextM === anchor ? '' : '']);
  // 2. skipped -> the grid advances (v73.28 preserved) AND the skipped date
  // stays in the window as its trace (v73.64: a skip is a relocation, not a
  // deletion — the plans list needs it to render the unskip chip).
  run17('skipped advances + keeps its trace', mkPlan17('p17b', { [anchor]: { skip: true, skippedAt: T17 } }), [anchor, nextM], []);
  // 3. fully planRef-paid -> advances (the chip is the truth)
  var baseTxns17 = F.state.txns;
  F.state.txns = baseTxns17.concat([{ id: 't17paid', date: anchor, amount: 1000, note: 'p17 paid', planRef: { planId: 'p17c', date: anchor } }]);
  run17('fully paid advances', mkPlan17('p17c'), [nextM], [anchor]);
  // 4. PARTIALLY paid -> STAYS (the remainder is still owed)
  F.state.txns = baseTxns17.concat([{ id: 't17part', date: anchor, amount: 400, note: 'p17 part', planRef: { planId: 'p17d', date: anchor } }]);
  run17('partially paid stays', mkPlan17('p17d'), [anchor], []);
  // 5. moved to the FUTURE -> advances, the moved date lands in the window
  var moveFut = d17(T17, 5);
  run17('moved-future advances + moved date in window', mkPlan17('p17e', { [anchor]: { move: moveFut } }), [moveFut], [anchor]);
  // 6. moved to the PAST -> STAYS, overdue at the moved date
  var movePast = d17(T17, -4);
  run17('moved-past stays at the moved date', mkPlan17('p17f', { [anchor]: { move: movePast } }), [movePast], [anchor]);
  F.state.txns = baseTxns17; // restore
  // 7. the boss's REAL Rent shape: forked amount on the past anchor, partial
  // link -> the forked occurrence stays reachable with its forked amount
  var rentLike = mkPlan17('p17g', { [anchor]: { amount: 13394 } });
  F.state.txns = baseTxns17.concat([{ id: 't17rent', date: anchor, amount: 7364, note: 'Rent (plan payment)', planRef: { planId: 'p17g', date: anchor } }]);
  F.state.plans.push(rentLike);
  var allG = F.planAllDates(rentLike);
  var roG = F.resolveOccurrence(rentLike, anchor);
  ok(allG.indexOf(anchor) >= 0 && Number(roG.amount) === 13394,
    'v73.61: the forked past due (13,394) stays reachable with its forked amount — remainder ' + (13394 - 7364) + ' still owed');
  F.state.plans.pop();
  F.state.txns = baseTxns17; // restore

  // ============ PART 18: v73.62 — the partial chip is a COMPARISON ============
  // (boss: the Rent history chip showed "✓ 13,394" on a 7,364 partial — the
  // v73.59 `paid: !!paid` truthiness marked ANY linked payment as fully paid
  // and printed the occurrence amount next to the tick). Now: paid = the
  // planRef sum covers the amount (the coach's >= 100% rule); a partial is
  // AMBER with the paid sum over the due ("◐ 7,364/13,394"), never a green
  // tick; the "N paid" header counts full pays only.
  console.log('\n== PART 18: v73.62 — the partial chip is a comparison =====');
  F.setPlanTab('rec');
  // (a) the boss's real shape: forked 13,394 on a past anchor, 7,364 linked
  var rent18 = { id: 'p18rent', name: 'Rent18', amount: 3000, date: anchor, repeat: 'monthly', count: null,
    overrides: { [anchor]: { amount: 13394 } }, created: '2026-01-01T00:00:00.000Z' };
  F.state.plans.push(rent18);
  F.state.txns = baseTxns17.concat([{ id: 't18rent', date: anchor, amount: 7364, note: 'Rent (plan payment)', planRef: { planId: 'p18rent', date: anchor } }]);
  // the plan SET changed -> renderPlans resets planOpen (planSig wipe), so
  // render ONCE to update the signature, THEN open the series, THEN render.
  F.renderPlans();
  F.setPlanOpen('p18rent', true);
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  // the WHOLE series block: from this series' data-grp to the NEXT series'
  // HEAD row (the only `plrow grp` / `plrow oneoff` divs are series heads —
  // the NEXT DUE row is `plrow next`, the strip is spans). A data-grp
  // boundary is a trap: the head's own "N paid" pill is a NESTED
  // [data-grp] with the same id, so slicing there cuts the strip off.
  var block18 = function (id) {
    var s = listHtml.indexOf('data-grp="' + id + '"');
    if (s < 0) return '';
    var rest = listHtml.slice(s);
    var i1 = rest.indexOf('<div class="plrow grp');
    var i2 = i1 >= 0 ? rest.indexOf('<div class="plrow grp', i1 + 10) : -1;
    var j1 = rest.indexOf('<div class="plrow oneoff');
    var cands = [i2, j1].filter(function (x) { return x >= 0; });
    var e = cands.length ? Math.min.apply(null, cands) : -1;
    return e >= 0 ? rest.slice(0, e) : rest;
  };
  var rent18Head = block18('p18rent');
  ok(rent18Head.indexOf('hchip partial') >= 0 && rent18Head.indexOf('7,364.00/13,394.00') >= 0,
    'v73.62: a partial pay renders the AMBER chip with the paid sum over the due (◐ 7,364.00/13,394.00 — amt() keeps cents)');
  ok(rent18Head.indexOf('hchip paid') < 0,
    'v73.62: a partial pay is NEVER a green tick — the v73.59 truthiness is gone');
  ok(rent18Head.indexOf('1 paid') < 0,
    'v73.62: the header "N paid" count is full-pays only (a partial does not count)');
  F.setPlanOpen('p18rent', false);
  F.state.plans.pop();
  // (b) the FULL case still ticks green (the comparison, not the absence of
  // one, is what changed). COUNTED (3x) on purpose: a count-less fully-paid
  // past due advances OFF the grid (v73.61) and never renders a chip — the
  // green tick case is a paid occurrence that stays on its grid (counted
  // series, or a paid due within the window).
  var rent18f = { id: 'p18full', name: 'RentFull', amount: 3000, date: anchor, repeat: 'monthly', count: 3,
    overrides: {}, created: '2026-01-01T00:00:00.000Z' };
  F.state.plans.push(rent18f);
  F.state.txns = baseTxns17.concat([{ id: 't18full', date: anchor, amount: 3000, note: 'Rent full', planRef: { planId: 'p18full', date: anchor } }]);
  F.renderPlans(); // planSig wipe (the push) — see (a)
  F.setPlanOpen('p18full', true);
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  var rent18fHead = block18('p18full');
  ok(rent18fHead.indexOf('hchip paid') >= 0 && rent18fHead.indexOf('✓') >= 0 && rent18fHead.indexOf('hchip partial') < 0,
    'v73.62: a full pay still renders the green tick (the comparison passes at 100%)');
  F.setPlanOpen('p18full', false);
  F.state.plans.pop();
  // (c) the NEXT-DUE pill has the same hole, same fix: a partial pay on a
  // FUTURE due shows the sum over the due, never "✓ paid"
  var dueFut = F.shiftMonth(anchor, 1);
  var rent18n = { id: 'p18next', name: 'RentNext', amount: 3000, date: dueFut, repeat: 'monthly', count: null,
    overrides: {}, created: '2026-01-01T00:00:00.000Z' };
  F.state.plans.push(rent18n);
  F.state.txns = baseTxns17.concat([{ id: 't18next', date: dueFut, amount: 1500, note: 'Rent next part', planRef: { planId: 'p18next', date: dueFut } }]);
  F.renderPlans(); // planSig wipe (the push) — see (a)
  F.setPlanOpen('p18next', true);
  F.renderPlans();
  listHtml = String(byIdStub('plans').innerHTML || '');
  var rent18nRow = block18('p18next');
  ok(rent18nRow.indexOf('occ-paid partial') >= 0 && rent18nRow.indexOf('1,500.00/3,000.00') >= 0,
    'v73.62: the next-due pill is a comparison too — a partial pay shows 1,500.00/3,000.00 (amt() keeps cents), never "✓ paid"');
  ok(rent18nRow.indexOf('✓ paid') < 0, 'v73.62: the next-due pill never ticks a partial pay as paid');
  F.setPlanOpen('p18next', false);
  F.state.plans.pop();
  F.state.txns = baseTxns17; // restore
  F.setPlanTab('one'); // back to the default

  // ============ PART 19: v73.63 — one-off skips move free; skips never orphan ============
  // (boss's Rent incident, three parts: (1) a skip CLOBBERED the 13,394 fork
  // so the undo restored a 3,000 base that was already overpaid — the row
  // never returned; (2) the skip was keyed at the RESOLVED date, not the
  // grid date — orphaned after a move; (3) one-off skips never touched the
  // cycle deduction (the boss's 10k test).)
  console.log('\n== PART 19: v73.63 — skip/undo integrity + one-off free =====');
  // (a) the boss's exact Rent shape: 13,394 fork, 7,364 linked, skip, UNDO.
  // Anchor = the 20th of the CURRENT month (past due, INSIDE the cycle
  // window — last month's 20th would be out of cycle and the deduction
  // test would lie).
  var _t19 = F.parseISO(F.todayISO());
  var anchor19 = F.localISO(new Date(_t19.getFullYear(), _t19.getMonth(), 20, 12));
  if (anchor19 > F.todayISO()) anchor19 = F.todayISO();
  var rent19 = { id: 'p19rent', name: 'Rent19', amount: 3000, date: anchor19, repeat: 'monthly', count: null,
    overrides: { [anchor19]: { amount: 13394 } }, created: '2026-01-01T00:00:00.000Z' };
  F.state.plans.push(rent19);
  F.state.txns = baseTxns17.concat([{ id: 't19rent', date: anchor19, amount: 7364, note: 'Rent (plan payment)', planRef: { planId: 'p19rent', date: anchor19 } }]);
  // the fork must be in the cycle deduction (6,030 remainder) BEFORE the skip
  var ded19a = F.cyclePlanDeduction();
  ok(ded19a >= 6030 - 0.005, 'v73.63: the forked 13,394 with 7,364 linked deducts its 6,030 remainder (got ' + ded19a.toFixed(2) + ')');
  // skip the due via the coach chip (resolved date = anchor, it is unmoved)
  F.skipPlanChip('p19rent|' + anchor19);
  await sleep(40);
  ok(rent19.overrides[anchor19] && rent19.overrides[anchor19].skip, 'v73.63: the skip wrote at the grid date');
  ok(rent19.overrides[anchor19].was && rent19.overrides[anchor19].was.amount === 13394,
    'v73.63: the skip CARRIES the fork under it (`was.amount` = 13,394) — it no longer clobbers it');
  ok(close(F.cyclePlanDeduction(), ded19a - 6030), 'v73.63: skipping the forked due drops the deduction by the 6,030 remainder (free rises)');
  // UNDO — the fork must come back EXACTLY (the boss's 'it did not return').
  // The undo lives on the snackUndo button's onclick (the snack's undoFn).
  var undo19Btn = elMap['snackUndo'];
  ok(!!undo19Btn && typeof undo19Btn.onclick === 'function', 'v73.63: the skip toast carries a working Undo button');
  if (undo19Btn && typeof undo19Btn.onclick === 'function') { undo19Btn.onclick(); await sleep(40); }
  ok(rent19.overrides[anchor19] && !rent19.overrides[anchor19].skip && rent19.overrides[anchor19].amount === 13394,
    'v73.63: the undo restores the FORK (amount 13,394), not a bare delete (the boss\'s row-never-returned fix)');
  ok(close(F.cyclePlanDeduction(), ded19a), 'v73.63: the undo returns the 6,030 remainder to the deduction (free drops back)');
  // (b) the orphaned-key fix: MOVE the due, then SKIP it — the skip must
  // land at the GRID date, and unskip (resolved date) must find it.
  // +5 days on purpose: a same-month shift would land on ANOTHER
  // occurrence (the count-less window is 3 same-day-of-month dates — the
  // v73.55 collision guard would reject it).
  var _nd = F.parseISO(anchor19); _nd.setDate(_nd.getDate() + 5);
  var newDate19 = F.localISO(_nd);
  await F.movePlanChip('p19rent', anchor19, newDate19);
  await sleep(40);
  ok(rent19.overrides[anchor19] && rent19.overrides[anchor19].move === newDate19,
    'v73.63 precondition: the move-override sits at the grid date (move: newDate)');
  ok(F.planGridDateFor(rent19, newDate19) === anchor19,
    'v73.63 (retargeted v73.64): after a move the slot is ON the grid (relocation) — the resolved date maps back to its grid date (which is why skips key at the RESOLVED date, not this)');
  F.skipPlanChip('p19rent|' + newDate19); // the chip passes the RESOLVED date
  await sleep(40);
  ok(rent19.overrides[newDate19] && rent19.overrides[newDate19].skip,
    'v73.63: skipping a MOVED due keys the skip at the RESOLVED date (where the grid + consumers see it — no orphan)');
  await F.unskipPlanOccurrence('p19rent', newDate19); // the label passes the RESOLVED date
  await sleep(40);
  ok(rent19.overrides[anchor19] && !rent19.overrides[anchor19].skip && rent19.overrides[anchor19].move === newDate19,
    'v73.63: unskip (resolved date) finds the resolved-keyed skip and the move entry survives exactly');
  ok(!rent19.overrides[newDate19], 'v73.63: the unskip removed the resolved-keyed skip entry');
  // (c) the boss's 10k one-off test: skip moves free, undo drops it back.
  // Date = TODAY: a one-off is only deducted inside the cycle window, so a
  // next-month date would never be in the deduction (the test would lie).
  var one19 = { id: 'p19one', name: 'OneOff19', amount: 10000, date: F.todayISO(), repeat: null, count: null,
    overrides: {}, created: '2026-01-01T00:00:00.000Z' };
  F.state.plans.push(one19);
  var ded19c = F.cyclePlanDeduction();
  ok(ded19c >= 10000 - 0.005, 'v73.63: the one-off 10k is in the cycle deduction (got ' + ded19c.toFixed(2) + ')');
  F.skipPlanChip('p19one|' + one19.date);
  await sleep(40);
  ok(one19.overrides[one19.date] && one19.overrides[one19.date].skip, 'v73.63: the one-off skip wrote at its date');
  ok(close(F.cyclePlanDeduction(), ded19c - 10000), 'v73.63: skipping the one-off drops the deduction by 10k (free RISES — the boss\'s test, now passing)');
  var undo19bBtn = elMap['snackUndo'];
  if (undo19bBtn && typeof undo19bBtn.onclick === 'function') { undo19bBtn.onclick(); await sleep(40); }
  ok(!one19.overrides[one19.date], 'v73.63: the one-off undo removed the skip (nothing to restore)');
  ok(close(F.cyclePlanDeduction(), ded19c), 'v73.63: the one-off undo returns the 10k to the deduction (free drops back)');
  // (d) the skipped one-off wears the record pill + ↺ in the plans list
  F.skipPlanChip('p19one|' + one19.date);
  await sleep(40);
  F.setPlanTab('one');
  F.renderPlans();
  var one19Html = String(byIdStub('plans').innerHTML || '');
  ok(one19Html.indexOf('data-unskip="p19one|' + one19.date + '"') >= 0,
    'v73.63: a skipped one-off renders the ↺ unskip path in the plans list (the access the boss lost)');
  ok(/skipped/.test(one19Html.slice(one19Html.indexOf('p19one') - 400, one19Html.indexOf('p19one') + 400)),
    'v73.63: the skipped one-off row wears the "skipped" pill');
  // restore
  await F.unskipPlanOccurrence('p19one', one19.date);
  await sleep(30);
  F.state.plans.pop(); // one19
  F.state.plans.pop(); // rent19
  F.state.txns = baseTxns17;
  F.renderPlans();

  // ============ PART 20: v73.64 — a skipped past due keeps its trace ======
  // (boss: 'the amber partial chip disappeared with NO trace, the only way
  // back was the undo toast, and i no longer have access to unskip'. The
  // grid's advance loop must keep the skipped occurrence's resolved date in
  // the window — same semantics as a moved-to-future due — so the history
  // strip renders its 'skipped' chip (data-unskip) and the header's ↺ +
  // 'N skipped' count cover PAST skips, not just future ones.)
  console.log('\n== PART 20: v73.64 — skipped past due keeps its unskip trace =');
  var _t20 = F.parseISO(F.todayISO());
  var anchor20 = F.localISO(new Date(_t20.getFullYear(), _t20.getMonth(), 20, 12));
  if (anchor20 > F.todayISO()) anchor20 = F.todayISO();
  var rent20 = { id: 'p20rent', name: 'Rent20', amount: 3000, date: anchor20, repeat: 'monthly', count: null,
    overrides: { [anchor20]: { amount: 13394 } }, created: '2026-01-01T00:00:00.000Z' };
  F.state.plans.push(rent20);
  F.state.txns = baseTxns17.concat([{ id: 't20rent', date: anchor20, amount: 7364, note: 'Rent (plan payment)', planRef: { planId: 'p20rent', date: anchor20 } }]);
  // precondition: the partly-handled due is in the series BEFORE the skip
  ok(F.planAllDates(rent20).indexOf(anchor20) >= 0, 'v73.64 precondition: the partly-handled past due is in the series (got ' + F.planAllDates(rent20).join(',') + ')');
  var ded20a = F.cyclePlanDeduction();
  ok(ded20a >= 6030 - 0.005, 'v73.64 precondition: the 6,030 remainder is in the deduction (got ' + ded20a.toFixed(2) + ')');
  // skip it (the grid advances past it — the v73.61 path)
  F.skipPlanChip('p20rent|' + anchor20);
  await sleep(40);
  ok(rent20.overrides[anchor20] && rent20.overrides[anchor20].skip && rent20.overrides[anchor20].was.amount === 13394,
    'v73.64: the skip wrote with the fork carried under it');
  // THE FIX: the skipped date must STAY in the window (the grid advanced past
  // it, but the resolved date was pushed into the window like a moved due)
  ok(F.planAllDates(rent20).indexOf(anchor20) >= 0,
    'v73.64: the SKIPPED past due stays in the series (the trace the boss lost — got ' + F.planAllDates(rent20).join(',') + ')');
  ok(F.cyclePlanDeduction() < ded20a - 6000, 'v73.64: the skip still drops the deduction (free rises — the skip works)');
  // the plans list: the 'skipped' chip with data-unskip + the header count
  F.setPlanTab('rec');
  F.setPlanOpen('p20rent', true);
  F.renderPlans();
  var rent20Html = String(byIdStub('plans').innerHTML || '');
  ok(rent20Html.indexOf('data-unskip="p20rent|' + anchor20 + '"') >= 0,
    'v73.64: the plans list renders the skipped past due as a tappable unskip chip (the persistent access)');
  ok(rent20Html.indexOf('1 skipped') >= 0,
    'v73.64: the header counts the PAST skip (skipTotal spans past + future)');
  // unskip via the persistent path — the fork must come back exactly
  await F.unskipPlanOccurrence('p20rent', anchor20);
  await sleep(40);
  ok(rent20.overrides[anchor20] && !rent20.overrides[anchor20].skip && rent20.overrides[anchor20].amount === 13394,
    'v73.64: the persistent unskip restores the FORK (13,394), not the base (the never-delete-a-fork guard)');
  ok(close(F.cyclePlanDeduction(), ded20a), 'v73.64: the unskip returns the 6,030 remainder to the deduction');
  F.renderPlans();
  ok(String(byIdStub('plans').innerHTML || '').indexOf('data-unskip="p20rent|' + anchor20 + '"') < 0,
    'v73.64: after the unskip the skip chip is gone (the due is back to normal)');
  // restore
  F.state.plans.pop(); // rent20
  F.state.txns = baseTxns17;
  F.renderPlans();

  // ============ PART 21: v73.65 — the x-axis ticks don't collide ==========
  // (boss: 'Oct2 Oct29 Oct5 Nov8…' overlap into each other on the free-cash
  // graph. renderSpark now thins the axis to a minimum pixel distance —
  // first/last always labeled — while the plotted line keeps EVERY point.)
  console.log('\n== PART 21: v73.65 — x-axis tick throttling =');
  var sd21 = F.sparkData();
  ok(sd21 && sd21.pts.length >= 2, 'v73.65 precondition: sparkData has points (got ' + (sd21 && sd21.pts.length) + ')');
  var sparkBefore = String(byIdStub('sparkBox').innerHTML || '');
  F.renderSpark();
  var sparkAfter = String(byIdStub('sparkBox').innerHTML || '');
  var tickCount = sparkAfter.split('<text').length - 1; // the axis <text>s (floor label only if floor>0 — the seed has none)
  ok(tickCount >= 2, 'v73.65: at least the first + last tick render (got ' + tickCount + ')');
  // the throttle floor: W=320, PL=PR=8 → iw=304; a "Nov15"-width label at
  // font-size 8 ≈ 5 chars × 4.6px + 6px gutter = 34px minimum spacing.
  var maxTicks = Math.floor(304 / 34) + 1; // greedy worst case + the forced last
  ok(tickCount <= maxTicks, 'v73.65: the tick count is throttled to the pixel floor (got ' + tickCount + ', max ' + maxTicks + ' for ' + sd21.pts.length + ' points)');
  ok(tickCount < sd21.pts.length, 'v73.65: fewer ticks than points — the axis is thinned, not 1:1 (ticks ' + tickCount + ' vs points ' + sd21.pts.length + ')');
  // the line keeps EVERY point (thinning the axis must never thin the data)
  var pathSegs = (sparkAfter.match(/L\d+/g) || []).length;
  ok(pathSegs >= sd21.pts.length - 1, 'v73.65: the line still has a segment per point (got ' + pathSegs + ' L-segments for ' + sd21.pts.length + ' points)');
  ok(sparkBefore !== sparkAfter, 'v73.65: renderSpark actually wrote the svg (the stub instance is the real target)');
  // a dense synthetic series (12 events in 60 days) must thin to ≤ the floor
  var _t21 = F.parseISO(F.todayISO());
  function iso21(off) { var d = new Date(_t21.getTime() + off * 86400000); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  var dense21 = [];
  for (var k21 = 0; k21 < 12; k21++) dense21.push({ label: 'd' + k21, v: 1000 - k21 * 50, date: iso21(k21 * 5) });
  dense21.unshift({ label: 'now', v: 1000, date: F.todayISO() });
  var W21 = 320, iw21 = 320 - 16, minPx21 = 34;
  var expectMax21 = Math.floor(iw21 / minPx21) + 1;
  var X21 = function (i) { return 8 + iw21 * (i / (dense21.length - 1)); };
  var greedy21 = [0];
  for (var g21 = 1; g21 < dense21.length - 1; g21++) if (X21(g21) - X21(greedy21[greedy21.length - 1]) >= minPx21) greedy21.push(g21);
  greedy21.push(dense21.length - 1);
  ok(greedy21.length <= expectMax21, 'v73.65: the greedy thinning bound holds for a dense 13-point series (got ' + greedy21.length + ', max ' + expectMax21 + ')');
  ok(greedy21[0] === 0 && greedy21[greedy21.length - 1] === dense21.length - 1, 'v73.65: the first + last points always keep their tick');

  // ============ PART 22: v73.66 — the coach + notes are roasty ==========
  // (boss: 'make coach fin and coachs note very funny and very roasty'). The
  // smoke drives the REAL renderCoach: the seed state (free 58,631.36, no
  // prepay window, no shortfall) lands the GOOD branch — the roasty marker
  // must render, the old flat copy must be gone, and the numbers must still
  // be quoted (money(d.daily) in the head, the meal in the sub).
  console.log('\n== PART 22: v73.66 — the roasty coach =');
  function money22(v) { return 'PHP ' + (Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } // the app's money() format
  F.renderCoach();
  var coachHead22 = String(byIdStub('coachHead').textContent || '');
  var coachSub22 = String(byIdStub('coachSub').textContent || '');
  ok(coachHead22.indexOf('you are on track') >= 0 && coachHead22.indexOf('earned the guilt') >= 0,
    'v73.66: the coach head is roasty (good branch: "on track … earned the guilt") — got: ' + JSON.stringify(coachHead22));
  ok(coachHead22.indexOf('PHP ') >= 0, 'v73.66: the roast still quotes the NUMBER (money(d.daily) in the head)');
  ok(coachSub22.indexOf('the app is watching') >= 0,
    'v73.66: the coach sub is roasty ("the app is watching") — got: ' + JSON.stringify(coachSub22));
  ok(coachHead22.indexOf('You can spend up to ' + money22(F.insightsData().daily)) >= 0,
    'v73.66: the head quotes the exact daily headroom (the math is untouched, only the words changed)');
  ok(coachHead22.indexOf('no room to breathe right now') < 0 && coachSub22.indexOf('Skip the treats today — back the cards first.') < 0,
    'v73.66: the old flat copy is gone (the roast replaced it, not joined it)');

  // ============ PART 23: v73.67 — the overdue link is alive ==========
  // (boss: 'i used the due rows chip but it has no link chip'). The link
  // liveness check walked planOccurrences() — the FORWARD window — so an
  // OVERDUE occurrence looked dead and updatePlanLinkChip nullified the
  // ref the boss had just set from the due row's own chip: the chip
  // vanished, the txn saved unlinked, the due stayed, the hero deducted
  // it AGAIN. planRefAlive now walks planAllDates (full series, past
  // included) — an overdue occurrence is the MOST important link target.
  console.log('\n== PART 23: v73.67 — the overdue link is alive =');
  // dates are RELATIVE to the run's today — the premise (an overdue occurrence
  // that is NOT in the forward window) must hold whenever the gate runs.
  var past23 = F.localISO((function () { var d = new Date(); d.setDate(d.getDate() - 8); return d; })());
  var fut23d = F.localISO((function () { var d = new Date(); d.setDate(d.getDate() + 7); return d; })());
  var rent23 = {
    id: 'smoke23-rent', name: 'Rent', amount: 13394,
    date: past23, repeat: 'monthly', count: null, overrides: {}
  };
  var fut23 = { id: 'smoke23-gym', name: 'Gym', amount: 1200, date: fut23d, repeat: 'monthly', count: null, overrides: {} };
  // planRefAlive walks state.plans — seed the two test series in (setPlans hook, v73.67);
  // PART 23 is the last part, so no restore is needed.
  F.setPlans([rent23, fut23]);
  var fwd23 = F.planOccurrences(rent23);
  ok(fwd23.indexOf(past23) < 0, 'v73.67: the overdue occurrence is NOT in the forward window (the old bug\'s premise) — got: ' + JSON.stringify(fwd23));
  ok(F.planAllDates(rent23).indexOf(past23) >= 0, 'v73.67: the overdue occurrence IS in the full series (planAllDates)');
  ok(F.planRefAlive({ planId: 'smoke23-rent', date: past23, name: 'Rent', amount: 13394 }),
    'v73.67: a link to the OVERDUE occurrence is ALIVE (the boss\'s chip must survive)');
  rent23.overrides = { [past23]: { skip: true, skippedAt: 1 } };
  ok(!F.planRefAlive({ planId: 'smoke23-rent', date: past23, name: 'Rent', amount: 13394 }),
    'v73.67: a link to a SKIPPED occurrence is still dead (the v73.63 rule survives)');
  ok(!F.planRefAlive({ planId: 'smoke23-gone', date: past23, name: 'Rent', amount: 13394 }),
    'v73.67: a link to a DELETED plan is still dead');
  ok(F.planRefAlive({ planId: 'smoke23-gym', date: fut23d, name: 'Gym', amount: 1200 }),
    'v73.67: a link to a FUTURE occurrence is still alive (the normal case, unchanged)');

  // ============ PART 24: v73.68 — the due rows span the cycle ==========
  // (boss: 'extend the plan due rows... on second thoughts, make it
  // "this cycle"'s dues, initially collapsed to 4 +x more rows'). The
  // coach's window is today..cycEnd (the 10-day forward window is dead),
  // overdue stays forever (v73.27), coachRows builds EVERY due in the
  // window (the old shown<4 cap dropped the rest), and renderCoach
  // collapses the plans group to 4 rows + a tappable "+N more…".
  console.log('\n== PART 24: v73.68 — cycle-spanning due rows + 4-row collapse =');
  (async function () {
    var origPlans = F.state.plans;
    var iso = function (off) { var d = new Date(); d.setDate(d.getDate() + off); return F.localISO(d); };
    var d24 = F.insightsData();
    var cycEnd24 = d24.cycle && d24.cycle.end;
    // dates are anchored on cycEnd (not fixed offsets) so the premise holds
    // on ANY run date: today is always inside the cycle (cycEnd >= today).
    ok(cycEnd24 && cycEnd24 >= F.todayISO(), 'v73.68: premise — the cycle end is today or later (cycEnd ' + cycEnd24 + ')');
    var pIn = { id: 'smoke24-in', name: 'InCyc', amount: 2222, date: cycEnd24, repeat: 'monthly', count: null, overrides: {} };
    var pPast = { id: 'smoke24-past', name: 'PastCyc', amount: 4444, date: F.localISO((function () { var d = F.parseISO(cycEnd24); d.setDate(d.getDate() + 1); return d; })()), repeat: 'monthly', count: null, overrides: {} };
    var pO1 = { id: 'smoke24-o1', name: 'OverDue1', amount: 1111, date: iso(-10), repeat: 'monthly', count: null, overrides: {} };
    var pO2 = { id: 'smoke24-o2', name: 'OverDue2', amount: 5555, date: iso(-20), repeat: 'monthly', count: null, overrides: {} };
    var pO3 = { id: 'smoke24-o3', name: 'OverDue3', amount: 6666, date: iso(-30), repeat: 'monthly', count: null, overrides: {} };
    var pO4 = { id: 'smoke24-o4', name: 'OverDue4', amount: 7777, date: iso(-40), repeat: 'monthly', count: null, overrides: {} };
    var pO5 = { id: 'smoke24-o5', name: 'OverDue5', amount: 8888, date: iso(-50), repeat: 'monthly', count: null, overrides: {} };
    F.setPlans([pIn, pPast, pO1, pO2, pO3, pO4, pO5]);
    d24 = F.insightsData();
    var rows24 = F.coachRows(d24).rows;
    var planRows24 = rows24.filter(function (r) { return r.group === 'plans'; });
    ok(planRows24.some(function (r) { return r.tag === 'Overdue'; }), 'v73.68: the OVERDUE dues are in the window (v73.27 no-horizon survives)');
    ok(planRows24.some(function (r) { return r.tag === 'Plan due'; }), 'v73.68: the in-cycle due (today..cycEnd) is in the window');
    ok(planRows24.every(function (r) { return String(r.text).indexOf('PastCyc') < 0; }),
      'v73.68: a due PAST the cycle end (cycEnd+1) is OUT of the due rows (it lives in the peek) — the window ends at cycEnd');
    ok(planRows24.length > 4, 'v73.68: coachRows builds EVERY due in the window — the old shown<4 cap is gone (got ' + planRows24.length + ')');
    // the render collapse: >4 plan rows → 4 rows + a tappable "+N more…"
    F.state.coachPlansMore = false;
    F.renderCoach();
    var body24 = byIdStub('digBody');
    var collapsedPlan = (String(body24.innerHTML).match(/data-payplan=/g) || []).length;
    ok(collapsedPlan === 4, 'v73.68: the plans group COLLAPSES to its first 4 rows (got ' + collapsedPlan + ')');
    var bodyHtml24 = String(byIdStub('digBody').innerHTML);
    ok(bodyHtml24.indexOf('coachPlansMoreRow') >= 0 && bodyHtml24.indexOf('more…') >= 0,
      'v73.68: the "+N more…" row renders with the hidden count (body has it: ' + (bodyHtml24.indexOf('coachPlansMoreRow') >= 0) + ')');
    F.state.coachPlansMore = true;
    F.renderCoach();
    var expandedPlan = (String(byIdStub('digBody').innerHTML).match(/data-payplan=/g) || []).length;
    ok(expandedPlan >= 5, 'v73.68: tapping "+N more…" (coachPlansMore) expands to the full list (got ' + expandedPlan + ')');
    ok(String(byIdStub('digBody').innerHTML).indexOf('coachPlansMoreRow') < 0,
      'v73.68: the more-row is gone once expanded');
    F.state.coachPlansMore = false;
    F.setPlans(origPlans);
    F.renderCoach();
  })().then(function () {
    // ============ PART 25: v73.69 — the CC summary card (2-cell) ==========
    // (boss: 'ship the 2-cell CC card on main (v73.68)'): one row per CC —
    // name + limit + util pill, Balance | Due cells, AUTO DUE / MANUAL chip.
    // v73.68 has no next-cycle tagging, so the auto due IS the full balance;
    // a manual c.due override wins with the MANUAL chip.
    console.log('\n== PART 25: v73.69 — the CC summary card (2-cell) =');
    (async function () {
      var cards25 = F.state.base.accounts.filter(function (a) { return a.kind === 'card'; });
      ok(cards25.length >= 2, 'v73.69: premise — the seed has >= 2 CCs (got ' + cards25.length + ')');
      F.renderCcCards();
      var ccBody = String(byIdStub('ccCardsBody').innerHTML);
      ok(ccBody.indexOf('ccrow') >= 0, 'v73.69: the card rows render (ccrow present)');
      var live = F.effectiveSnap().cards;
      var maya = live.filter(function (c) { return c.name === 'Maya CC'; })[0];
      var money25 = function (v) { return 'PHP ' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
      ok(ccBody.indexOf(money25(maya.balance)) >= 0, 'v73.69: the Balance cell is the LIVE balance (overlay applied, ' + money25(maya.balance) + ')');
      ok(ccBody.indexOf('limit ' + money25(10000)) >= 0, 'v73.69: the name row carries the stored limit (Maya 10,000)');
      ok(ccBody.indexOf('utilpill') >= 0, 'v73.69: the utilization pill renders');
      ok(ccBody.indexOf('AUTO DUE') >= 0, 'v73.69: the AUTO DUE provenance chip renders (no manual due set)');
      ok(ccBody.indexOf('MANUAL') < 0, 'v73.69: no MANUAL chip while the overrides are all null');
      // the due date label is the GLOBAL due day (the 5th) — the 2-cell
      // variant drops per-card dates (v73.70 data that v73.68 lacks).
      // dayMonth renders "5 Nov" (day + short month).
      var cc25 = F.ccDue();
      var moName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var dueLbl = cc25 ? Number(cc25.dueDate.slice(8, 10)) + ' ' + moName[Number(cc25.dueDate.slice(5, 7)) - 1] : '';
      ok(cc25 && dueLbl && ccBody.indexOf('due ' + dueLbl) >= 0,
        'v73.69: the due date label is present (global due day, next on/after today: ' + dueLbl + ')');
      // the manual override wins: set Maya's due, re-render, MANUAL chip +
      // the override amount in the Due cell
      var mayaBase = F.state.base.accounts.filter(function (a) { return a.name === 'Maya CC'; })[0];
      var origDue = mayaBase.due;
      mayaBase.due = 777.77;
      F.renderCcCards();
      var ccBody2 = String(byIdStub('ccCardsBody').innerHTML);
      ok(ccBody2.indexOf('MANUAL') >= 0, 'v73.69: a manual "due this cycle" override flips the chip to MANUAL');
      ok(ccBody2.indexOf(money25(777.77)) >= 0, 'v73.69: the Due cell shows the OVERRIDE amount, not the balance');
      ok(ccBody2.indexOf('src manual') >= 0, 'v73.69: the MANUAL chip wears the warn styling (src manual)');
      mayaBase.due = origDue;
      F.renderCcCards();
      ok(String(byIdStub('ccCardsBody').innerHTML).indexOf('MANUAL') < 0,
        'v73.69: clearing the override returns the card to AUTO DUE');
    })().then(function () {
      // ============ PART 26: v73.70 — the payment-method ledger filter ======
      // (boss: 'allow sorting of entries based on the payment method'): a
      // second dropdown (#mlFilterM) filters by the row's e.m account
      // ('Maya CC', 'MariBank CC', 'MariBank', 'Cash', …); a prepay row with
      // no account falls back to 'CC Payment'; the '__m:' value prefix
      // can't collide with a same-named category; it ANDs with the category
      // filter; a filter change resets the See-more page.
      console.log('\n== PART 26: v73.70 — the payment-method ledger filter =');
      (async function () {
        var log26 = F.state.moneyLog || [];
        var countM = function (mv) {
          return log26.filter(function (e) {
            var m = (e.k === 'p' && !e.m) ? 'CC Payment' : (e.m || '');
            return m === mv;
          }).length;
        };
        var mSel = byIdStub('mlFilterM');
        var rowsOf = function (mv) { // exact method match in the rendered body (the ' · ' meta delimiter)
          return (String(byIdStub('mlBody').innerHTML).match(new RegExp('· ' + mv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'g')) || []).length;
        };
        F.renderMoneyLog(); // renderMlFilter runs inside
        var mOpts = String(mSel.innerHTML);
        ['Maya CC', 'MariBank CC', 'MariBank', 'Cash'].forEach(function (nm) {
          ok(mOpts.indexOf('__m:' + nm) >= 0, 'v73.70: the method dropdown lists ' + nm + ' (from the ledger)');
        });
        ok(mOpts.indexOf('<option value="">All</option>') === 0, 'v73.70: the dropdown defaults to All');
        // the account-less prepay falls back to 'CC Payment' (inject one,
        // then restore — the earlier parts' prepays all carry an account)
        var synth26 = { at: Date.now(), a: 'add', tid: 'smoke26-prepay', l: 'CC Payment', c: '', nt: 'v73.70 probe prepay', m: '', n: 1, k: 'p', f: 0, o: 1 };
        log26.push(synth26);
        F.renderMoneyLog();
        mOpts = String(mSel.innerHTML);
        ok(mOpts.indexOf('__m:CC Payment') >= 0, 'v73.70: the account-less prepay falls back to the CC Payment option');
        F.setMlFilters('', '__m:CC Payment');
        F.renderMoneyLog();
        // the row's label IS 'CC Payment' (no account to show in the meta),
        // so assert on its note text instead of the ' · ' delimiter
        ok(String(byIdStub('mlBody').innerHTML).indexOf('v73.70 probe prepay') >= 0,
          'v73.70: the CC Payment method filter shows the account-less prepay');
        log26.pop(); // restore
        // the method filter shows ONLY that method's rows
        var mayaN = countM('Maya CC');
        ok(mayaN >= 1, 'v73.70: premise — the ledger has Maya CC rows (got ' + mayaN + ')');
        F.setMlFilters('', '__m:Maya CC');
        F.renderMoneyLog();
        var mayaRows = rowsOf('Maya CC');
        ok(mayaRows === Math.min(5, mayaN), 'v73.70: filtering by Maya CC shows ONLY its rows (got ' + mayaRows + ')');
        ok(rowsOf('MariBank CC') === 0 && rowsOf('Cash') === 0, 'v73.70: the filter hides the other methods (no MariBank CC / Cash row)');
        // the AND with the category filter narrows further
        var mayaFood = log26.filter(function (e) {
          return e.k !== 'p' && e.c === 'Food' && (e.m || '') === 'Maya CC';
        }).length;
        F.setMlFilters('Food', '__m:Maya CC');
        F.renderMoneyLog();
        var mayaFoodRows = rowsOf('Maya CC');
        ok(mayaFoodRows === Math.min(5, mayaFood), 'v73.70: the method filter ANDs with the category (Maya CC + Food = ' + mayaFood + ' rows, got ' + mayaFoodRows + ')');
        // the empty state names BOTH active filters (Food + LandBank)
        var landFood = log26.filter(function (e) {
          return e.k !== 'p' && e.c === 'Food' && (e.m || '') === 'LandBank';
        }).length;
        F.setMlFilters('Food', '__m:LandBank');
        F.renderMoneyLog();
        var body26c = String(byIdStub('mlBody').innerHTML);
        if (landFood === 0) {
          ok(body26c.indexOf('Food + LandBank') >= 0, 'v73.70: the empty state names both active filters (Food + LandBank)');
        } else {
          ok(true, 'v73.70: (Food + LandBank has ' + landFood + ' rows — the empty-state branch is skipped)');
        }
        // a filter change resets the See-more page
        F.setMlFilters('', '__m:MariBank CC');
        F.renderMoneyLog();
        var mbRows = rowsOf('MariBank CC');
        ok(mbRows === Math.min(5, countM('MariBank CC')), 'v73.70: a method filter change restarts the See-more page at 5 rows (got ' + mbRows + ')');
        // clearing the method filter returns to the full log
        F.setMlFilters('', '');
        F.renderMoneyLog();
        ok(rowsOf('Maya CC') > 0, 'v73.70: clearing the method filter shows the full log again');
      })().then(function () {
      // ============ PART 27: v73.71 — the per-card prepay split rebuild =====
      // (the boss's diagnosis: hero 'cards owed' 12,295.52 vs the CC card's
      // 9,620.75). prepayBy is an INCREMENTAL accumulator — card charges
      // logged before the per-card `account` field existed bumped the TOTAL
      // adj.card but never the per-card map, so the CC card rows went stale
      // under the authoritative hero total. migratePrepayBy rebuilds the split
      // from the txns and reconciles it to adj.card; idempotent on re-run.
      console.log('\n== PART 27: v73.71 — the per-card prepay split rebuild =');
      (async function () {
        var txns0 = F.getTxns();
        F.resetAdj();
        // a KNOWN txn list: charges of 500 (Maya) + 2300 (MariBank) = 2800,
        // while the stored total is 4946.52 — the pre-field gap the boss's
        // phone had (total right, per-card split short).
        F.setTxns([
          { id: 't27a', date: '2026-10-18', account: 'Maya CC', kind: 'card_charge', category: 'Food', amount: 500 },
          { id: 't27b', date: '2026-10-20', account: 'MariBank CC', kind: 'card_charge', category: 'Transport', amount: 2300 }
        ]);
        F.setAdj({ cash: 0, free: 0, card: 4946.52, prepay: 4946.52,
          prepayBy: { 'Maya CC': 500, 'MariBank CC': 2300 }, mv: 3 });
        F.migratePrepayBy();
        var a27 = F.getAdj();
        var sum27 = 0;
        Object.keys(a27.prepayBy).forEach(function (k) { sum27 += a27.prepayBy[k]; });
        ok(Math.abs(sum27 - 4946.52) < 0.01,
          'v73.71: the rebuilt split sums to the authoritative adj.card total (got ' + sum27.toFixed(2) + ')');
        // the missing share lands proportionally (Maya: 500 * 4946.52/2800 = 883.31)
        ok(Math.abs(a27.prepayBy['Maya CC'] - 883.31) < 0.01 &&
           Math.abs(a27.prepayBy['MariBank CC'] - 4063.21) < 0.01,
          'v73.71: the missing share scales in proportionally (Maya got ' + a27.prepayBy['Maya CC'] + ')');
        // idempotent: a second run rebuilds the same split and writes nothing
        F.migratePrepayBy();
        var a27b = F.getAdj();
        ok(Math.abs(a27b.prepayBy['Maya CC'] - 883.31) < 0.01 &&
           Math.abs(Object.keys(a27b.prepayBy).reduce(function (s, k) { return s + a27b.prepayBy[k]; }, 0) - 4946.52) < 0.01,
          'v73.71: the rebuild is idempotent (second run leaves the split untouched)');
        // the no-op path: a split that already matches the total is left alone
        F.setTxns([
          { id: 't27c', date: '2026-10-18', account: 'Maya CC', kind: 'card_charge', category: 'Food', amount: 300 },
          { id: 't27d', date: '2026-10-20', account: 'MariBank CC', kind: 'card_charge', category: 'Food', amount: 200 }
        ]);
        F.setAdj({ cash: 0, free: 0, card: 500, prepay: 500,
          prepayBy: { 'Maya CC': 300, 'MariBank CC': 200 }, mv: 3 });
        F.migratePrepayBy();
        ok(F.getAdj().prepayBy['Maya CC'] === 300 && F.getAdj().prepayBy['MariBank CC'] === 200,
          'v73.71: a consistent split is a no-op (no write)');
        // the split rides the import (sanitizeAdj keeps it — pre-v73.71 imports dropped it)
        var imp27 = F.sanitizeAdj({ cash: 0, free: 0, card: 500, prepay: 500, prepayBy: { 'Maya CC': 300 }, mv: 3 });
        ok(imp27.prepayBy && imp27.prepayBy['Maya CC'] === 300,
          'v73.71: sanitizeAdj keeps the per-card split through the import');
        F.setTxns(txns0); // restore the smoke's ledger
        F.resetAdj();
        // ============ PART 28: v73.72 — ipf-theirs pair + backfill ==========
        // (boss-approved: 'ipf: file theirs as a card charge' + 'increase free
        // cash by the same amount' — the credit converted to cash, since the
        // repayment lands as cash and tmb never files a ledger row. Net on
        // the boss's own free cash: zero; card owed grows by theirs.)
        console.log('\n== PART 28: v73.72 — ipf-theirs pair + backfill =');
        var owed0 = F.getOwed();
        var txns0b = F.getTxns();
        var adj0b = F.getAdj();
          // ---- PART 28's async legs (the awaited owed flow) ----
          await (async function () {
            var owed0b = F.getOwed();
            var txns0c = F.getTxns();
            var adj0c = F.getAdj();
            await F.addOwedPerson('Smoke Friend');
            var pid = F.getOwed().people[F.getOwed().people.length - 1].id;
            var freeA = F.effectiveSnap().cash.free;
            var owedA = F.effectiveSnap().card_owed;
            await F.addOwedEntry(pid, { dir: 'ipf', amt: 100, total: 200, mine: 100, theirs: 100,
              acc: 'CARD::Maya CC', cat: 'Food', note: 'smoke ipf', d: '2026-10-25' });
            await new Promise(function (r) { setTimeout(r, 15); });
            var t28 = F.getTxns();
            var ch28 = t28.filter(function (t) { return t.kind === 'card_charge' && t.note === 'Owed · Smoke Friend · theirs'; });
            var ci28 = t28.filter(function (t) { return t.kind === 'cash_in' && t.note === 'Owed · Smoke Friend · theirs'; });
            var co28 = t28.filter(function (t) { return t.kind === 'card_charge' && t.note === 'Owed · Smoke Friend'; });
            ok(ch28.length === 1 && ch28[0].amount === 100 && ch28[0].account === 'Maya CC',
              'v73.72: ipf on a card files THEIRS as a card_charge (got ' + ch28.length + ' x ' + (ch28[0] && ch28[0].amount) + ')');
            ok(ci28.length === 1 && ci28[0].amount === 100 && ci28[0].account === 'Cash',
              'v73.72: the cash advance files as a cash_in for the same amount (got ' + ci28.length + ' x ' + (ci28[0] && ci28[0].amount) + ')');
            ok(co28.length === 1 && co28[0].amount === 100,
              'v73.72: MINE still files as before (100 card charge for the boss\'s own part)');
            var es28 = F.effectiveSnap();
            ok(close(es28.cash.free, freeA - 100),
              'v73.72: only MINE commits free cash — theirs is neutralized (charge −100, advance +100; got ' + es28.cash.free.toFixed(2) + ' vs ' + (freeA - 100).toFixed(2) + ')');
            ok(close(es28.card_owed, owedA + 200),
              'v73.72: card owed grew by the FULL bill (mine + theirs; got ' + es28.card_owed.toFixed(2) + ')');
            var e28 = F.getOwed().people.filter(function (p) { return p.id === pid; })[0].entries[0];
            ok(!!e28.theirsTxnId && !!e28.theirsBumpId && e28.theirsTxnId !== e28.theirsBumpId,
              'v73.72: the entry carries both pair handles (charge + advance)');
            // ---- the backfill: pre-base entries get the advance only (their
            // card spend is already in the sheet's base), post-base get both ----
            F.setOwed({ people: [{ id: 'p28b', name: 'Backfill Buddy', entries: [
              { id: 'e28pre', d: '2026-09-20', dir: 'ipf', amt: 85, acc: 'CARD::MariBank CC', cat: 'Food', note: 'pre-base' },
              { id: 'e28post', d: '2026-10-24', dir: 'ipf', amt: 225, acc: 'CARD::Maya CC', cat: 'Food', note: 'post-base' }
            ], updated: '' }], sort: [] });
            var freeB = F.effectiveSnap().cash.free;
            var owedB = F.effectiveSnap().card_owed;
            F.migrateIpfTheirs();
            await new Promise(function (r) { setTimeout(r, 25); });
            var pre28 = F.getOwed().people[0].entries[0];
            var post28 = F.getOwed().people[0].entries[1];
            ok(!!pre28.theirsTxnId && !pre28.theirsBumpId,
              'v73.72: a pre-base ipf gets the advance handle only (no charge — the spend is in the base)');
            ok(!!post28.theirsTxnId && !!post28.theirsBumpId,
              'v73.72: a post-base ipf gets both handles (charge + advance)');
            var es28b = F.effectiveSnap();
            ok(close(es28b.card_owed, owedB + 225),
              'v73.72: the backfill grew card owed by the post-base theirs only (got ' + es28b.card_owed.toFixed(2) + ' vs ' + owedB.toFixed(2) + ')');
            // pre-base: +85 advance only (no charge); post-base: +225 advance
            // − 225 charge = 0 net → free moves by the PRE-BASE advance only
            ok(close(es28b.cash.free, freeB + 85),
              'v73.72: free cash moved by the pre-base advance only (the post-base charge and advance cancel; got ' + es28b.cash.free.toFixed(2) + ' vs ' + (freeB + 85).toFixed(2) + ')');
            // idempotent: a second run files nothing new
            var n28 = F.getTxns().length;
            F.migrateIpfTheirs();
            await new Promise(function (r) { setTimeout(r, 25); });
            ok(F.getTxns().length === n28, 'v73.72: the backfill is idempotent (stamp-gated — no second filing)');
            // ---- editing re-files the pair on the new values ----
            await F.updateOwedEntry('p28b', 'e28post', { dir: 'ipf', total: 300, mine: 100, theirs: 200,
              acc: 'CARD::Maya CC', cat: 'Food', note: 'post-base', d: '2026-10-24' });
            await new Promise(function (r) { setTimeout(r, 25); });
            var t28d = F.getTxns();
            var ch28d = t28d.filter(function (t) { return t.kind === 'card_charge' && t.note === 'Owed · Backfill Buddy · theirs' && t.amount === 200; });
            var ci28d = t28d.filter(function (t) { return t.kind === 'cash_in' && t.note === 'Owed · Backfill Buddy · theirs' && t.amount === 200; }); // the pre-base 85 advance shares the note — amount disambiguates
            ok(ch28d.length === 1 && ch28d[0].amount === 200,
              'v73.72: editing re-files the theirs charge on the NEW amount (got ' + ch28d.length + ' x ' + (ch28d[0] && ch28d[0].amount) + ')');
            ok(ci28d.length === 1 && ci28d[0].amount === 200,
              'v73.72: editing re-files the advance on the NEW amount (got ' + ci28d.length + ' x ' + (ci28d[0] && ci28d[0].amount) + ')');
            // after the edit: backfill charge 225 (post) + mine charge 100 (newly
            // filed — the entry adopted the split) + new theirs charge 200 − old
            // theirs charge 225 = owedB + 300; free = +85 (pre advance) − 100
            // (mine) ± 0 (the theirs pairs net out) = freeB − 15
            var es28c = F.effectiveSnap();
            ok(close(es28c.card_owed, owedB + 300),
              'v73.72: card owed reflects the EDITED entry (old pair removed, new filed + mine; got ' + es28c.card_owed.toFixed(2) + ' vs ' + (owedB + 300).toFixed(2) + ')');
            ok(close(es28c.cash.free, freeB - 15),
              'v73.72: free cash reflects the edit (pre advance +85, mine −100, theirs pairs net out; got ' + es28c.cash.free.toFixed(2) + ' vs ' + (freeB - 15).toFixed(2) + ')');
            F.setOwed(owed0b);
            F.setTxns(txns0c);
            F.setAdj(adj0c);
          })();
        })().then(function () {
      console.log('');
      console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
      process.exit(fails === 0 ? 0 : 1);
    }).catch(function (e) {
      console.error('PROBE ERROR:', e && e.stack || e);
      process.exit(2);
    });
    }).catch(function (e) {
      console.error('PROBE ERROR:', e && e.stack || e);
      process.exit(2);
    });
  }).catch(function (e) {
    console.error('PROBE ERROR:', e && e.stack || e);
    process.exit(2);
  });
}).catch(function (e) {
  console.error('PROBE ERROR:', e && e.stack || e);
  process.exit(2);
});
}).catch(function (e) {
  console.error('PROBE ERROR:', e && e.stack || e);
  process.exit(2);
});
