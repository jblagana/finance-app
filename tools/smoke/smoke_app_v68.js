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
  // the record row renders in the plans list (label + ↺, both data-unskip)
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

  console.log('');
  console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
  process.exit(fails === 0 ? 0 : 1);
}).catch(function (e) {
  console.error('PROBE ERROR:', e && e.stack || e);
  process.exit(2);
});
