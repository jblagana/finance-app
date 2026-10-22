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
  // unpaid plan due in the window and its step disappears.
  var targetDue = Object.keys(expPlanDates).sort()[0];
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
  Object.keys(expPlanDates).sort().forEach(function (d) {
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
  // 2. skipped -> advances (v73.28 preserved)
  run17('skipped advances', mkPlan17('p17b', { [anchor]: { skip: true, skippedAt: T17 } }), [nextM], [anchor]);
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

  console.log('');
  console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
  process.exit(fails === 0 ? 0 : 1);
}).catch(function (e) {
  console.error('PROBE ERROR:', e && e.stack || e);
  process.exit(2);
});
