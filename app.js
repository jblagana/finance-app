/* Fin.AI PWA client — fully local-first: base data + all math live on this phone. */
(function () {
  'use strict';

  var DB_NAME = 'finances-pwa';
  var DB_VERSION = 5;
  var STORE_TX = 'txns';
  var STORE_PLANS = 'plans';
  var STORE_META = 'meta';
  var STORE_CHAT = 'chat';
  var LS_MEAL = 'fin.mealBudget';
  var LS_NAME = 'fin.name';
  var LS_TAB = 'fin.tab';
  var MEAL_DEFAULT = 400;

  // v63: no fixed category list — the add-expense options come from "Your
  // numbers" (the base monthly budgets). catSig guards redundant re-seeds.
  var catSig = '';

  var state = {
    online: navigator.onLine,
    txns: [],
    plans: [],
    base: null,
    snapshot: null,
    adj: { cash: 0, free: 0, card: 0, prepay: 0, prepayBy: {}, mv: 2 }, // mv = the txnAdj model version (v72.43)
    adjSig: '',
    adjLoaded: false,
    coachMem: null,
    moneyLog: [],
    owed: { people: [] }
  };

  // ---------- event bus: a state change re-renders only the views that depend on it ----------
  var RENDER_BY_KEY = {
    // v73.0: renderMood on every data key — the face is the status light
    txn: [renderSummary, renderCoach, renderInsights, renderProjection, updateChargeHint, renderHero, renderDonut, renderPace, renderMoneyLog, renderCoachNote, renderMood, renderRecap, renderDueStrip],
    plan: [renderPlans, renderInsights, renderCoach, renderProjection, renderHero, renderCoachNote, renderMood, renderDueStrip],
    // v72.30: a base save can file 'Adjustment' ledger rows — the Ledger tab follows
    snap: [renderSummary, renderCoach, renderInsights, renderProjection, renderObligations, renderSinking, seedAccounts, renderAddEmpty, updateChargeHint, renderHero, renderBaseStatus, renderCoachNote, seedCategories, renderMoneyLog, renderMood, renderRecap, renderDueStrip],
    adj: [renderSummary, renderCoach, renderInsights, renderProjection, updateChargeHint, renderHero, renderCoachNote, renderMood, renderRecap, renderDueStrip],
    owed: [renderOwed],
    ui: [renderSummary, seedAccounts, seedCategories, renderCoach, renderInsights, renderProjection, renderObligations, renderSinking, renderAddEmpty, renderPlans, renderFooter, updateChargeHint, renderHero, renderDonut, renderPace, renderMoneyLog, renderOwed, renderCoachNote, renderMood, renderRecap, renderDueStrip]
  };
  function emit(keys) {
    var list = (typeof keys === 'string' ? [keys] : keys) || ['ui'];
    var seen = {};
    list.forEach(function (k) {
      (RENDER_BY_KEY[k] || RENDER_BY_KEY.ui).forEach(function (fn) {
        if (seen[fn]) return;
        seen[fn] = true;
        try { fn(); } catch (e) { console.warn('render', e); }
      });
    });
  }

  // ---------- IndexedDB ----------
  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_TX)) db.createObjectStore(STORE_TX, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_PLANS)) db.createObjectStore(STORE_PLANS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORE_CHAT)) db.createObjectStore(STORE_CHAT, { keyPath: 'id' });
        // v5: drop the on-device lexicon store left by older builds (local brain removed)
        if (db.objectStoreNames.contains('lex')) db.deleteObjectStore('lex');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function idbAll(store) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction(store, 'readonly').objectStore(store).getAll();
        r.onsuccess = function () { resolve(r.result || []); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function idbPut(store, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbDel(store, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function byId(id) { return document.getElementById(id); }
  function money(v) {
    var n = Number(v) || 0;
    var sign = n < 0 ? '-' : '';
    return 'PHP ' + sign + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(d) {
    if (!d) return '';
    var p = String(d).split('-');
    if (p.length === 3) {
      var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(p[1]) - 1];
      return mo + ' ' + Number(p[2]) + ', ' + p[0];
    }
    return d;
  }
  function syncDateLabel(input) {
    var lab = byId(input.id + 'Label');
    if (!lab) return;
    if (!input.value) { lab.textContent = 'Pick a date'; lab.className = 'dlabel empty'; return; }
    lab.textContent = fmtDate(input.value);
    lab.className = 'dlabel';
  }
  function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  // Safe arithmetic for "quick sums" (Add sheet + Owed): 300-125+10 -> 185.
  // Hand-rolled recursive descent over numbers and + - * / ( ) — no eval,
  // no Function. Accepts x/× for multiply, ÷ for divide, −/–/— for minus.
  // Returns the result rounded to 2 decimals, or null when the input is not
  // a valid expression.
  function evalExpr(s) {
    var t = String(s == null ? '' : s)
      .replace(/[\u00d7xX]/g, '*').replace(/\u00f7/g, '/')
      .replace(/[\u2212\u2013\u2014]/g, '-');
    t = t.replace(/\s+/g, ' ');
    if (!t || !/^[0-9.+\-*/() ]+$/.test(t)) return null;
    var i = 0;
    function ws() { while (i < t.length && t.charAt(i) === ' ') i++; }
    function peek() { ws(); return t.charAt(i); }
    function num() {
      var start = i, dots = 0;
      while (i < t.length && /[0-9.]/.test(t.charAt(i))) {
        if (t.charAt(i) === '.') dots++;
        i++;
      }
      if (start === i || dots > 1) return NaN;
      return parseFloat(t.slice(start, i));
    }
    function factor() {
      var c = peek();
      if (c === '+') { i++; return factor(); }
      if (c === '-') { i++; return -factor(); }
      if (c === '(') {
        i++;
        var v = expr();
        ws();
        if (t.charAt(i) !== ')') return NaN;
        i++;
        return v;
      }
      return num();
    }
    function term() {
      var v = factor();
      for (;;) {
        var c = peek();
        if (c === '*') { i++; v = v * factor(); }
        else if (c === '/') { i++; v = v / factor(); }
        else return v;
      }
    }
    function expr() {
      var v = term();
      for (;;) {
        var c = peek();
        if (c === '+') { i++; v = v + term(); }
        else if (c === '-') { i++; v = v - term(); }
        else return v;
      }
    }
    var v = expr();
    if (!isFinite(v)) return null;
    ws();
    if (i !== t.length) return null;
    return r2(v);
  }
  function monthLabel(m) {
    var p = String(m || '').split('-');
    if (p.length === 2 && /^\d{4}$/.test(p[0]) && /^\d{2}$/.test(p[1])) {
      return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(p[1]) - 1] + ' ' + p[0];
    }
    return m || '';
  }
  function ordinal(n) {
    n = Number(n) || 0;
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function localISO(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function todayISO() { return localISO(new Date()); }
  function parseISO(s) {
    var p = String(s).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function diffDays(fromISO, toISO) {
    return Math.round((parseISO(toISO) - parseISO(fromISO)) / 86400000);
  }
  // ---------- shared visual helpers (Phase 3) ----------
  var REDUCED_MOTION = false;
  try { REDUCED_MOTION = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
  function monthShort(m) {
    var p = String(m || '').split('-');
    if (p.length === 2 && /^\d{4}$/.test(p[0]) && /^\d{2}$/.test(p[1])) {
      return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(p[1]) - 1] + " '" + p[0].slice(2);
    }
    return m || '';
  }
  // v51: compact "10 Sep" label for a full ISO date (sparkline start point)
  function dayMonth(iso) {
    var p = String(iso || '').split('-');
    if (p.length === 3 && /^\d{4}$/.test(p[0]) && /^\d{2}$/.test(p[1])) {
      var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(p[1]) - 1];
      return mo ? Number(p[2]) + ' ' + mo : 'now';
    }
    return 'now';
  }
  function countUp(el, from, to, fmt) {
    if (!el) return;
    if (REDUCED_MOTION || !isFinite(from) || from === to) { el.textContent = fmt(to); return; }
    if (el.__countRaf) cancelAnimationFrame(el.__countRaf);
    var t0 = null;
    function step(ts) {
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / 400);
      el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      el.__countRaf = k < 1 ? requestAnimationFrame(step) : null;
    }
    el.__countRaf = requestAnimationFrame(step);
  }
  // ---------- Phase 4: recurring plans ----------
  // v73.1: the repeat is no longer monthly-only — weekly and annual ride the
  // same plan row (p.repeat: 'monthly' | 'weekly' | 'annual'; absent = once).
  // Old data is untouched: a plan without repeat still yields exactly its
  // own date, and 'monthly' plans keep the v68 behavior verbatim.
  function shiftMonth(iso, k) {
    var p = String(iso).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1 + k, 1);
    var dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return localISO(new Date(d.getFullYear(), d.getMonth(), Math.min(Number(p[2]) || 1, dim)));
  }
  function shiftWeek(iso, k) {
    var d = parseISO(iso);
    d.setDate(d.getDate() + 7 * k);
    return localISO(d);
  }
  function shiftYear(iso, k) {
    var p = String(iso).split('-');
    var d = new Date(Number(p[0]) + k, Number(p[1]) - 1, 1);
    var dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return localISO(new Date(d.getFullYear(), d.getMonth(), Math.min(Number(p[2]) || 1, dim)));
  }
  function planOccurrences(p) {
    if (!p || !p.repeat) return [String(p.date)];
    var today = todayISO();
    var d = String(p.date), guard = 0;
    if (p.repeat === 'weekly') {
      var sh = function (x, k) { return shiftWeek(x, k); };
      while (d < today && guard < 104) { d = sh(d, 1); guard++; }
      var wo = [];
      for (var kw = 0; kw < 8; kw++) wo.push(sh(d, kw)); // ~2 months ahead
      return wo;
    }
    if (p.repeat === 'annual') {
      var sy = function (x, k) { return shiftYear(x, k); };
      while (d < today && guard < 12) { d = sy(d, 1); guard++; }
      var yo = [];
      for (var ky = 0; ky < 2; ky++) yo.push(sy(d, ky));
      return yo;
    }
    // monthly (the original path, unchanged)
    while (d < today && guard < 36) { d = shiftMonth(d, 1); guard++; }
    var out = [];
    for (var k = 0; k < 3; k++) out.push(shiftMonth(d, k));
    return out;
  }
  function mealBudget() {
    try { var v = parseFloat(localStorage.getItem(LS_MEAL)); return (v > 0) ? v : MEAL_DEFAULT; } catch (e) { return MEAL_DEFAULT; }
  }
  function coachName(s) {
    var n = '';
    if (s) n = String(s.display_name || '').trim();
    return n;
  }

  // ---- v72.43: one-shot re-derivation of the persisted overlay (payoff model) ----
  // The overlay (state.adj) is PERSISTED — boot uses the stored adj as-is and
  // only re-derives it when it was never stored (computeAdjFromTxns). A
  // card_payment logged before v72.42 therefore still carries its OLD-model
  // contribution after the update: { cash: 0, free: -a } instead of
  // { cash: +a, free: 0 } — free cash inflated by the prepay total, liquid
  // cash not reduced (card/prepay were identical in both models). One-shot
  // fix, gated on the model stamp (adj.mv) so it runs exactly once:
  //   - a balance-override (money-log 'a') row AFTER a prepay rebased
  //     (zeroed) the overlay — that prepay's effect is in the sheet's
  //     numbers, not the overlay, so its delta is NOT re-added;
  //   - zeroed / fresh adj (the boot initializer, a rebase,
  //     computeAdjFromTxns, the import sanitizer) carries the stamp.
  var ADJ_MODEL_V = 2; // bump when the txnAdj model changes again
  function payoffModelDelta(txns, lastOverrideAt) {
    var dc = 0;
    (txns || []).forEach(function (t) {
      if (t.kind !== 'card_payment') return;
      var created = Date.parse(t.created) || 0;
      if (created && lastOverrideAt && created < lastOverrideAt) return; // absorbed into the sheet by a later rebasing override
      dc += Number(t.amount) || 0;
    });
    return { cash: dc, free: dc }; // the old→new delta on both sides (card/prepay were identical)
  }
  function migratePayoffModel() {
    var a = state.adj;
    if (!a || a.mv === ADJ_MODEL_V) return;
    var lastO = 0;
    (state.moneyLog || []).forEach(function (e) { if (e.k === 'a' && e.at && e.at > lastO) lastO = e.at; });
    var d = payoffModelDelta(state.txns, lastO);
    if (d.cash) { a.cash = r2(a.cash + d.cash); a.free = r2(a.free + d.free); }
    a.mv = ADJ_MODEL_V;
    saveAdj().then(function () { emit('adj'); });
  }

  // ---- live overlay: app entries adjust the sheet snapshot until the sheet catches up ----
  // v72.10: the ledger learns INFLOWS — cash_in (money came to a cash pocket)
  // and card_payment (a payment landed on a card). cash_in is the exact inverse
  // of cash_out on the cash side: cash_out {+a, +a, 0, 0} <-> cash_in {-a, -a, 0, 0}.
  // v72.42: card_payment is NOT the inverse of card_charge — the charge already
  // spent the free cash (the credit limit isn't money), so the payoff only
  // settles the debt: raw liquid drops (cash +a → the money leaves the bank),
  // owed/prepay drop, and free stays UNTOUCHED (free: 0):
  // card_charge  {0, +a, +a, +a}  charge: free committed, raw still in the bank
  // card_payment {+a, 0,  -a, -a} payoff: free unchanged, raw leaves the bank
  // (overlay: effective free = snap.free − adj.free, raw = snap.total − adj.cash,
  // owed = snap + adj.card; the liquidity floor runs on the raw number.)
  function txnAdj(t) {
    var amt = Number(t.amount) || 0;
    // v72.33: the card rows carry the card name (acc) so the overlay tracks the
    // prepay delta PER CARD — a prepay question about one card answers with
    // that card's prepay, not the total
    if (t.kind === 'card_charge') return { cash: 0, free: amt, card: amt, prepay: amt, acc: t.account };
    if (t.kind === 'card_payment') return { cash: amt, free: 0, card: -amt, prepay: -amt, acc: t.account };
    if (t.kind === 'cash_in') return { cash: -amt, free: -amt, card: 0, prepay: 0 };
    return { cash: amt, free: amt, card: 0, prepay: 0 }; // cash_out (default, legacy rows)
  }
  function addAdj(a, sign) {
    state.adj.cash = r2(state.adj.cash + a.cash * sign);
    state.adj.free = r2(state.adj.free + a.free * sign);
    state.adj.card = r2(state.adj.card + a.card * sign);
    state.adj.prepay = r2(state.adj.prepay + a.prepay * sign);
    if (a.prepay && a.acc) {
      if (!state.adj.prepayBy) state.adj.prepayBy = {};
      state.adj.prepayBy[a.acc] = r2((state.adj.prepayBy[a.acc] || 0) + a.prepay * sign);
      if (!state.adj.prepayBy[a.acc]) delete state.adj.prepayBy[a.acc]; // nets to zero → tidy
    }
  }
  function computeAdjFromTxns() {
    state.adj = { cash: 0, free: 0, card: 0, prepay: 0, prepayBy: {}, mv: ADJ_MODEL_V };
    state.txns.forEach(function (t) { addAdj(txnAdj(t), 1); });
  }
  function saveAdj() {
    state.adjLoaded = true;
    return Promise.all([
      idbPut(STORE_META, { key: 'adj', value: state.adj }),
      idbPut(STORE_META, { key: 'adjSig', value: state.adjSig })
    ]);
  }
  function snapSig(s) {
    if (!s) return '';
    return [s.cash && s.cash.total, s.cash && s.cash.free, s.card_owed, s.total_prepay].join('|');
  }
  function adjActive() { return !!(state.adj.cash || state.adj.free || state.adj.card); }
  function setServerSnapshot(snap) {
    if (!snap) return;
    state.snapshot = snap;
    var sig = snapSig(snap);
    // Sheet numbers moved (Balances/Config edited in the sheet) -> rebase: the sheet is source of truth again.
    if (state.adjSig && sig !== state.adjSig && adjActive()) state.adj = { cash: 0, free: 0, card: 0, prepay: 0, prepayBy: {}, mv: ADJ_MODEL_V };
    state.adjSig = sig;
  }
  function resetAdj() {
    state.adj = { cash: 0, free: 0, card: 0, prepay: 0, prepayBy: {}, mv: ADJ_MODEL_V };
    state.adjSig = snapSig(state.snapshot);
    saveAdj().then(function () { emit('adj'); });
  }
  function effectiveSnap() {
    var s = state.snapshot;
    if (!s) return null;
    var e = JSON.parse(JSON.stringify(s));
    e.cash = {
      total: r2((s.cash ? s.cash.total : 0) - state.adj.cash),
      free: r2((s.cash ? s.cash.free : 0) - state.adj.free),
      accounts: s.cash ? s.cash.accounts : []
    };
    e.card_owed = r2((s.card_owed || 0) + state.adj.card);
    e.total_prepay = r2((s.total_prepay || 0) + state.adj.prepay);
    // v72.33: the per-card prepay goes live too (the card's own balance delta
    // from the overlay). Old snapshots without target_balance fall back to the
    // stored card_util_target.
    var byCard = state.adj.prepayBy || {};
    var utilT = state.base ? (Number(state.base.card_util_target) || 0) : 0;
    // v72.46: map over e.cards (the clone) — the v72.33 original mapped over
    // s.cards (the LIVE state) and only got away with it because prepay was
    // idempotent; the balance write-back must never touch state.
    e.cards = (e.cards || []).map(function (c) {
      var bal = (Number(c.balance) || 0) + (Number(byCard[c.name]) || 0);
      var tb = (c.target_balance != null) ? Number(c.target_balance) : r2((Number(c.limit) || 0) * utilT);
      c.prepay = r2(Math.max(0, bal - tb));
      // v72.46: the effective card is LIVE end-to-end — balance + utilization
      // included. The as-of row used to carry only prepay live, so after a
      // prepay the stored balance/util_pct (sheet as-of) kept feeding stale
      // numbers to the snapshot and the rule engine ("old util rate").
      // Same formula as baseCardPrepays, applied to the effective balance.
      c.balance = r2(bal);
      var lim = Number(c.limit) || 0;
      c.util_pct = lim ? r2(bal / lim * 100) : null;
      return c;
    });
    return e;
  }

  // ---------- local base data: the single source of truth on this phone ----------
  function defaultBase() {
    return {
      v: 1, name: '', as_of: todayISO(),
      salary: 0, salary_overrides: {},
      salary_day: 15, // v72.45: the day the salary lands — the salary cycle starts on it
      prepay_day: 14, cutoff_day: 15, due_day: 5, card_util_target: 0.099, // v73.6: the due day (the 5th) — the bill is due on it
      liquidity_floor: 0,
      accounts: [], budgets: {}, budget_overrides: {},
      one_offs: {}, debts: {}, sinking: {},
      details: {},
      migrated_from_snapshot: null, edited: null
    };
  }
  function baseIsEmpty(b) {
    if (!b) return true;
    if ((b.accounts || []).length || (Number(b.salary) || 0) > 0) return false;
    return !Object.keys(b.budgets || {}).length && !Object.keys(b.debts || {}).length
      && !Object.keys(b.one_offs || {}).length && !Object.keys(b.sinking || {}).length;
  }
  // One-time migration: the last cached sheet snapshot becomes the local base.
  function snapshotToBase(s) {
    if (!s) return null;
    var b = defaultBase();
    b.name = String(s.display_name || '').trim();
    b.as_of = String(s.as_of || todayISO());
    b.salary = Number(s.salary) || 0;
    b.prepay_day = Number(s.prepay_day) || 14;
    b.cutoff_day = Number(s.cutoff_day) || 15;
    b.liquidity_floor = Number(s.floor) || 0;
    b.migrated_from_snapshot = String(s.month || s.as_of || '');
    var target = 0;
    (s.cards || []).forEach(function (c) {
      b.accounts.push({ name: c.name, kind: 'card', value: Number(c.balance) || 0, limit: c.limit ? Number(c.limit) : 0, note: '' });
      if (!target && c.limit && (Number(c.prepay) || 0) > 0) target = (Number(c.balance) - Number(c.prepay)) / Number(c.limit);
    });
    if (target > 0) b.card_util_target = r2(target);
    ((s.cash && s.cash.accounts) || []).forEach(function (a) {
      b.accounts.push({ name: a.name, kind: 'debit', value: Number(a.value) || 0, limit: 0, note: '' }); // v65
    });
    var ob = s.obligations || {};
    var month = String(s.month || '');
    (ob.budget || []).forEach(function (l) {
      b.budgets[l.name] = Number(l.normal) || 0;
      if (l.overridden || Math.abs((Number(l.amount) || 0) - (Number(l.normal) || 0)) > 0.004) {
        b.budget_overrides[month] = b.budget_overrides[month] || {};
        b.budget_overrides[month][l.name] = Number(l.amount) || 0;
      }
    });
    (ob.debts || []).forEach(function (d) {
      var dd = { monthly: 0, active_months: [], payments: {} };
      var amts = (d.schedule || []).map(function (p) { return Number(p.amount) || 0; });
      if (amts.length && amts.every(function (a) { return Math.abs(a - amts[0]) <= 0.004; })) {
        // uniform rhythm: reconstruct as monthly + active months
        dd.monthly = amts[0];
        (d.schedule || []).forEach(function (p) { dd.active_months.push(p.month); });
      } else {
        (d.schedule || []).forEach(function (p) { dd.payments[p.month] = Number(p.amount) || 0; });
      }
      if (d.balance != null) b.accounts.push({ name: d.name, kind: 'debt', value: Number(d.balance) || 0, limit: 0, note: '' });
      b.debts[d.name] = dd;
    });
    (ob.one_offs || []).forEach(function (o) {
      b.one_offs[o.month] = b.one_offs[o.month] || {};
      b.one_offs[o.month][o.name] = Number(o.amount) || 0;
    });
    (ob.loans || []).forEach(function (l) {
      b.accounts.push({ name: l.name, kind: 'loan', value: Number(l.value) || 0, limit: 0, note: l.note || '' });
    });
    (s.sinking || []).forEach(function (f) {
      var payments = {};
      (f.payments || []).forEach(function (p) { payments[p.month] = Number(p.amount) || 0; });
      b.sinking[f.name] = { goal: Number(f.goal) || 0, deadline: f.deadline || '', funded: Number(f.funded) || 0, payments: payments };
    });
    ((s.matrix && s.matrix.base) || []).forEach(function (row) {
      var sal = Number(row.comp && row.comp.salary) || 0;
      if (Math.abs(sal - b.salary) > 0.004) b.salary_overrides[row.comp.month] = sal;
    });
    return b;
  }

  // ---------- local math (ported 1:1 from google/Code.gs — the sheet is no longer in the loop) ----------
  function baseCashTotal(b) {
    return r2((b.accounts || []).filter(function (a) { return a.kind === 'debit'; }) // v65
      .reduce(function (s, a) { return s + (Number(a.value) || 0); }, 0));
  }
  function baseCardTotal(b) {
    return r2((b.accounts || []).filter(function (a) { return a.kind === 'card'; })
      .reduce(function (s, a) { return s + (Number(a.value) || 0); }, 0));
  }
  function prepayAmount(balance, limit, target) {
    if (!limit || limit <= 0) return 0;
    return r2(Math.max(0, balance - limit * target));
  }
  function baseCardPrepays(b) {
    var target = Number(b.card_util_target) || 0;
    var per = {}, total = 0;
    (b.accounts || []).filter(function (a) { return a.kind === 'card'; }).forEach(function (c) {
      var balance = Number(c.value) || 0, limit = Number(c.limit) || 0;
      var d = {
        balance: balance, limit: limit,
        util_pct: limit ? r2(balance / limit * 100) : null,
        prepay: prepayAmount(balance, limit, target),
        target_balance: r2(limit * target)
      };
      per[c.name] = d;
      total += d.prepay;
    });
    return { per: per, total: r2(total) };
  }
  function localMonths(startMonth, n) {
    var p = String(startMonth || todayISO().slice(0, 7)).split('-');
    var y = Number(p[0]), m = Number(p[1]), out = [];
    for (var i = 0; i < (n || 6); i++) {
      var d = new Date(y, m - 1 + i, 1);
      out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    return out;
  }
  function baseMonthComponents(month, months, b, applyOverrides) {
    var salary = (b.salary_overrides[month] !== undefined) ? Number(b.salary_overrides[month]) : Number(b.salary) || 0;
    var budget = {};
    Object.keys(b.budgets || {}).forEach(function (k) { budget[k] = Number(b.budgets[k]) || 0; });
    if (applyOverrides && b.budget_overrides[month]) {
      Object.keys(b.budget_overrides[month]).forEach(function (k) { budget[k] = Number(b.budget_overrides[month][k]) || 0; });
    }
    var budgetTotal = 0;
    Object.keys(budget).forEach(function (k) { if (budget[k]) budgetTotal += budget[k]; });
    budgetTotal = r2(budgetTotal);
    var debtTotal = 0;
    Object.keys(b.debts || {}).forEach(function (name) {
      var d = b.debts[name];
      if (d.payments && d.payments[month] !== undefined) debtTotal += Number(d.payments[month]) || 0;
      else if ((d.active_months || []).indexOf(month) >= 0 && d.monthly) debtTotal += Number(d.monthly) || 0;
    });
    debtTotal = r2(debtTotal);
    var sinkTotal = 0;
    Object.keys(b.sinking || {}).forEach(function (name) {
      var s = b.sinking[name];
      if (s.payments && s.payments[month] !== undefined) sinkTotal += Number(s.payments[month]) || 0;
    });
    sinkTotal = r2(sinkTotal);
    var oneOffs = (b.one_offs || {})[month] || {}, oneOffTotal = 0;
    Object.keys(oneOffs).forEach(function (k) { oneOffTotal += Number(oneOffs[k]) || 0; });
    oneOffTotal = r2(oneOffTotal);
    var cardPrepay = (month === months[0]) ? baseCardPrepays(b).total : 0;
    var outflows = r2(budgetTotal + debtTotal + sinkTotal + oneOffTotal + cardPrepay);
    return { month: month, salary: salary, budget_total: budgetTotal, debt_total: debtTotal,
      sinking_total: sinkTotal, one_off_total: oneOffTotal, card_prepay: cardPrepay,
      partner_repay: 0, outflows: outflows, net: r2(salary - outflows) };
  }
  function baseMatrix(b, months) {
    var start = baseCashTotal(b);
    var base = [], bc = start;
    months.forEach(function (m) {
      var bi = baseMonthComponents(m, months, b, true);
      bc = r2(bc + bi.net);
      // v72.39: carry the month on the row itself — the sparkline ticks and
      // the coach's lowest-month lines read row.month, and without it every
      // month label on the x axis (and the dip line's month) rendered blank
      // since Phase 3 (the month only lived in row.comp.month, which nothing
      // on the axis side read).
      base.push({ month: m, comp: bi, running: bc });
    });
    return { start_cash: start, base: base };
  }
  function baseBridge(b, months) {
    var cash = baseCashTotal(b);
    var floor = Number(b.liquidity_floor) || 0;
    function advice(outflows) {
      var toZero = Math.max(0, r2(outflows - cash));
      return { outflows: outflows, end_cash_no_borrow: r2(cash - outflows),
        borrow_to_avoid_negative: toZero, borrow_to_keep_floor: Math.max(0, r2(outflows - cash + floor)),
        need_borrow: toZero > 0 };
    }
    var mand = baseMonthComponents(months[0], months, b, true);
    var full = baseMonthComponents(months[0], months, b, false);
    return { cash: cash, floor: floor, mandatory_only: advice(mand.outflows), full_living: advice(full.outflows) };
  }

  function baseToSnapshot(b) {
    var month = String(b.as_of || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) month = todayISO().slice(0, 7);
    var months = localMonths(month, 6);
    var pp = baseCardPrepays(b);
    var comp0 = baseMonthComponents(month, months, b, true);
    var cards = [];
    Object.keys(pp.per).forEach(function (name) {
      var d = pp.per[name];
      cards.push({ name: name, balance: d.balance, limit: d.limit, util_pct: d.util_pct, prepay: d.prepay, target_balance: d.target_balance });
    });
    var cashAccounts = (b.accounts || []).filter(function (a) { return a.kind === 'debit'; }) // v65
      .map(function (a) { return { name: a.name, value: Number(a.value) || 0 }; });
    var ovM = (b.budget_overrides || {})[month] || {};
    var budget = {}, bkeys = {};
    Object.keys(b.budgets || {}).forEach(function (k) { budget[k] = Number(b.budgets[k]) || 0; bkeys[k] = true; });
    Object.keys(ovM).forEach(function (k) { bkeys[k] = true; });
    var budgetLines = [];
    Object.keys(bkeys).forEach(function (k) {
      var amt = ovM[k] !== undefined ? Number(ovM[k]) : budget[k];
      budgetLines.push({ name: k, amount: r2(amt), normal: r2(Number(b.budgets[k]) || 0), overridden: ovM[k] !== undefined });
    });
    var budgetTotal = 0;
    budgetLines.forEach(function (l) { if (l.amount) budgetTotal += l.amount; });
    budgetTotal = r2(budgetTotal);
    var debtLines = [];
    Object.keys(b.debts || {}).forEach(function (name) {
      var d = b.debts[name];
      var thisMonth = 0;
      if (d.payments && d.payments[month] !== undefined) thisMonth = Number(d.payments[month]) || 0;
      else if ((d.active_months || []).indexOf(month) >= 0 && d.monthly) thisMonth = Number(d.monthly) || 0;
      var schedule = [];
      months.forEach(function (m) {
        var amt = 0;
        if (d.payments && d.payments[m] !== undefined) amt = Number(d.payments[m]) || 0;
        else if ((d.active_months || []).indexOf(m) >= 0) amt = Number(d.monthly) || 0;
        if (amt > 0) schedule.push({ month: m, amount: r2(amt) });
      });
      var bal = null;
      (b.accounts || []).forEach(function (a) { if (a.kind === 'debt' && a.name === name) bal = r2(Number(a.value) || 0); });
      debtLines.push({ name: name, this_month: r2(thisMonth), balance: bal, schedule: schedule });
    });
    var oneOffLines = [];
    months.forEach(function (m) {
      var o = (b.one_offs || {})[m] || {};
      Object.keys(o).forEach(function (k) { oneOffLines.push({ month: m, name: k, amount: r2(Number(o[k]) || 0) }); });
    });
    var loanLines = (b.accounts || []).filter(function (a) { return a.kind === 'loan'; })
      .map(function (a) { return { name: a.name, value: r2(Number(a.value) || 0), note: a.note || '' }; });
    var sinkLines = [];
    Object.keys(b.sinking || {}).forEach(function (name) {
      var s = b.sinking[name];
      var payments = [];
      months.forEach(function (m) {
        if (s.payments && s.payments[m] !== undefined) payments.push({ month: m, amount: r2(Number(s.payments[m]) || 0) });
      });
      sinkLines.push({ name: name, goal: Number(s.goal) || 0, deadline: s.deadline || '',
        funded: r2(Number(s.funded) || 0), this_month: r2((s.payments && s.payments[month]) ? Number(s.payments[month]) : 0),
        payments: payments });
    });
    return {
      ok: true,
      as_of: b.as_of || '',
      currency: 'PHP',
      month: month,
      months: months,
      prepay_day: Number(b.prepay_day) || 14,
      cutoff_day: Number(b.cutoff_day) || 15,
      due_day: Number(b.due_day) || 5, // v73.6: the card bill is due on this day
      display_name: String(b.name || '').trim(),
      salary: Number(b.salary) || 0,
      floor: Number(b.liquidity_floor) || 0,
      card_owed: baseCardTotal(b),
      total_prepay: pp.total,
      cash: { total: baseCashTotal(b), free: r2(baseCashTotal(b) - comp0.outflows), accounts: cashAccounts },
      cards: cards,
      committed: comp0.outflows,
      obligations: { month: month, budget: budgetLines, budget_total: budgetTotal, debts: debtLines, one_offs: oneOffLines, loans: loanLines },
      sinking: sinkLines,
      matrix: baseMatrix(b, months),
      bridge: baseBridge(b, months)
    };
  }
  function refreshLocalSnapshot() {
    state.snapshot = state.base && !baseIsEmpty(state.base) ? baseToSnapshot(state.base) : null;
    var sig = snapSig(state.snapshot);
    // The base numbers moved (edited in Settings) -> rebase: the base is source of truth again.
    if (state.adjSig && sig !== state.adjSig && adjActive()) state.adj = { cash: 0, free: 0, card: 0, prepay: 0, prepayBy: {}, mv: ADJ_MODEL_V };
    state.adjSig = sig;
  }
  function persistSnapshot() {
    return idbPut(STORE_META, { key: 'snapshot', value: state.snapshot, at: (state.base && state.base.edited) || null }).catch(function () {});
  }
  // v65: the account kind 'cash' is now 'debit'. A one-time, idempotent rewrite
  // applied at every data-in path (IDB load, import, every save) so data stored
  // before v65 never shows the old kind — and detail keys "cash:Name" follow
  // their account to "debit:Name". The boot path re-persists state.base right
  // after loading, so it lands in IndexedDB on the next save.
  function migrateBaseKinds(b) {
    if (!b) return b;
    (b.accounts || []).forEach(function (a) { if (a.kind === 'cash') a.kind = 'debit'; });
    var d = b.details;
    if (d) Object.keys(d).forEach(function (k) {
      if (k.indexOf('cash:') === 0) {
        var nk = 'debit:' + k.slice(5);
        if (!d[nk]) { d[nk] = d[k]; delete d[k]; }
      }
    });
    return b;
  }
  function saveBase(b, opts) {
    var prevBase = state.base; // v72.30: a balance override files the diff
    b.edited = new Date().toISOString();
    state.base = migrateBaseKinds(b); // v65
    refreshLocalSnapshot();
    // v72.31: the ✕ on an Adjustment row reverses a filed diff through this
    // same path — that reversal must not file a NEW Adjustment (no audit of
    // the audit), so the undo passes skipAdjustment.
    if (!(opts && opts.skipAdjustment)) {
      accountBalanceDiffs(prevBase, state.base).forEach(function (d) {
        fileBalanceAdjustment(d.name, d.kind, d.diff);
      });
    }
    return Promise.all([
      idbPut(STORE_META, { key: 'base', value: b }).catch(function () {}),
      persistSnapshot(),
      saveAdj()
    ]);
  }
  // v72.30 (user: 'add a way to override the current accounts' amount/balances.
  // add the difference in the ledger tab with category Adjustment'): the
  // accounts present in BOTH the previous and the new base (matched by name,
  // case-insensitive) whose value moved. New or removed accounts file nothing
  // (a new one has no old tracked value; a removed one isn't necessarily
  // emptied). Only the money accounts (debit / card) feed the tiles, so only
  // they file. The base is the source of truth — refreshLocalSnapshot already
  // rebased the live overlay to zero, so the filed row is an audit record,
  // not a second move: it's a moneyLog row ONLY (no txn), which is also why
  // the spend insights (pace / donut / per-category — all txn-based) can
  // never be skewed by an override.
  function accountBalanceDiffs(oldB, newB) {
    var out = [];
    var olds = (oldB && oldB.accounts) || [];
    ((newB && newB.accounts) || []).forEach(function (a) {
      if (!a || (a.kind !== 'debit' && a.kind !== 'card')) return;
      var nm = String(a.name || '').trim().toLowerCase();
      if (!nm) return;
      var old = null;
      olds.forEach(function (o) {
        if (!o) return;
        if (!old && String(o.name || '').trim().toLowerCase() === nm) old = o;
      });
      if (!old) return;
      var diff = r2((Number(a.value) || 0) - (Number(old.value) || 0));
      if (Math.abs(diff) > 0.004) out.push({ name: a.name, kind: a.kind, diff: diff });
    });
    return out;
  }
  // The audit row: category 'Adjustment', the SIGNED diff as n, k='a'. f = the
  // effective free AFTER the base moved (a debit row's free chain derives from
  // it: before = f − n); a card row carries o = the card owed after (the card
  // chain, before = o − n — free never moves). No s line: an override is not
  // spend. The row has no tid — it's the record (a wrong override is
  // corrected by the next one, which files its own row).
  function fileBalanceAdjustment(name, kind, diff) {
    var s = effectiveSnap();
    if (!s) return;
    var e = {
      at: Date.now(), a: 'add',
      l: 'Adjustment', c: 'Adjustment', nt: 'balance override', m: name || '',
      n: r2(diff), k: 'a'
    };
    e.f = r2(s.cash ? s.cash.free : 0);
    if (kind === 'card') e.o = r2(s.card_owed || 0);
    state.moneyLog.push(e);
    if (state.moneyLog.length > ML_CAP) state.moneyLog = state.moneyLog.slice(-ML_CAP);
    idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog }).catch(function () {});
  }

  // v72.31 (user: 'add x button in ledger for adjustment, it undoes the
  // record in settings'): the ✕ on an Adjustment row (k==='a') confirms, then
  // deletes the audit record AND reverses the balance change it filed — the
  // account's value in Settings → Your numbers moves by the NEGATIVE of the
  // row's signed diff (single override: back to the pre-override value; a
  // chain of overrides: this record's contribution is removed). The reversal
  // is a base save with Adjustment-filing suppressed, and the toast Undo
  // restores row + value. Account gone from Settings (removed/renamed since)
  // → the row is simply deleted (nothing to reverse against).
  function findAdjAccount(name) {
    var nm = String(name || '').trim().toLowerCase();
    if (!nm) return null;
    var acc = null;
    ((state.base && state.base.accounts) || []).forEach(function (a) {
      if (!a || (a.kind !== 'debit' && a.kind !== 'card')) return;
      if (!acc && String(a.name || '').trim().toLowerCase() === nm) acc = a;
    });
    return acc;
  }
  function askDeleteAdjustment(idx) {
    var e = (state.moneyLog || [])[idx];
    if (!e || e.k !== 'a') return;
    var acc = findAdjAccount(e.m);
    var amt = money(Math.abs(Number(e.n) || 0));
    confirmAsk(acc
      ? 'Undo this balance override? The <b>Adjustment</b> record is removed and <b>' + esc(e.m || 'the account') + '</b> goes back by <b>' + amt + '</b> — you can undo right after.'
      : 'Remove this <b>Adjustment</b> record? ' + esc(e.m || 'The account') + ' is no longer in Your numbers, so only the ledger row is removed — you can undo right after.',
      'Remove', function () { deleteAdjustment(idx); });
  }
  function deleteAdjustment(idx) {
    var log = state.moneyLog || [];
    var e = log[idx];
    if (!e || e.k !== 'a') return;
    var acc = findAdjAccount(e.m);
    var oldVal = acc ? r2(Number(acc.value) || 0) : null;
    state.moneyLog = log.filter(function (x) { return x !== e; });
    idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog }).catch(function () {});
    if (acc) {
      acc.value = r2((Number(acc.value) || 0) - Number(e.n));
      saveBase(state.base, { skipAdjustment: true });
    }
    emit('txn');
    snack('Removed the ' + money(Math.abs(Number(e.n) || 0)) + ' adjustment' +
      (acc ? ' — ' + esc(acc.name) + ' is back to ' + money(oldVal) : ''), function () {
      // the toast Undo: the row back at its index, the account value back
      var mlog = state.moneyLog || [];
      mlog.splice(Math.min(idx, mlog.length), 0, e);
      state.moneyLog = mlog;
      idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog }).catch(function () {});
      if (acc) {
        acc.value = oldVal;
        saveBase(state.base, { skipAdjustment: true });
      }
      emit('txn');
    });
  }

  // ---------- v35: story mode — the coach chat writes base changes through this path ----------
  // Chat never touches state.base directly: it hands over validated change objects, we clone
  // the current base, apply them one by one, and save through the same saveBase() path the
  // Settings editor uses (same recompute, same stores, same live overlay rebase). The
  // previous base is kept in meta under its own key so "undo this story" is one tap.
  var STORY_UNDO_KEY = 'baseStoryUndo';
  function cloneObj(o) { return JSON.parse(JSON.stringify(o)); }
  function applyBaseChange(b, ch) {
    var month = String(ch.month || ''), name = String(ch.name || '').trim();
    function needMonth() { if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('bad month: ' + month); }
    if (ch.type === 'salary') {
      needMonth();
      b.salary_overrides[month] = Number(ch.amount) || 0;
    } else if (ch.type === 'salary_base') {
      b.salary = Number(ch.amount) || 0;
    } else if (ch.type === 'one_off') {
      needMonth(); if (!name) throw new Error('one-off needs a name');
      b.one_offs[month] = b.one_offs[month] || {};
      b.one_offs[month][name] = Number(ch.amount) || 0;
    } else if (ch.type === 'budget') {
      if (!name) throw new Error('budget needs a name');
      b.budgets[name] = Number(ch.amount) || 0;
    } else if (ch.type === 'budget_override') {
      needMonth(); if (!name) throw new Error('budget override needs a name');
      b.budget_overrides[month] = b.budget_overrides[month] || {};
      b.budget_overrides[month][name] = Number(ch.amount) || 0;
    } else if (ch.type === 'recurring') {
      if (!name) throw new Error('recurring payment needs a name');
      var months = (ch.months || []).filter(function (x) { return /^\d{4}-\d{2}$/.test(x); });
      if (!months.length) throw new Error('recurring payment needs months');
      var amt = Number(ch.amount) || 0;
      b.debts[name] = { monthly: 0, active_months: [], payments: {} };
      months.forEach(function (x) { b.debts[name].payments[x] = amt; });
    } else if (ch.type === 'debt_payment') {
      needMonth(); if (!name) throw new Error('debt payment needs a name');
      if (!b.debts[name]) b.debts[name] = { monthly: 0, active_months: [], payments: {} };
      b.debts[name].payments[month] = Number(ch.amount) || 0;
    } else if (ch.type === 'account') {
      if (!name) throw new Error('account needs a name');
      // v65: 'cash' kind renamed to 'debit' — a legacy 'cash' is still
      // accepted and normalized.
      var kind = ['debit', 'cash', 'card', 'debt', 'loan'].indexOf(ch.kind) >= 0 ? ch.kind : 'debit';
      if (kind === 'cash') kind = 'debit';
      var hit = null;
      (b.accounts || []).forEach(function (a) { if (a.name === name && a.kind === kind) hit = a; });
      if (hit) {
        hit.value = Number(ch.value) || 0;
        if (kind === 'card' && ch.limit != null) hit.limit = Number(ch.limit) || 0;
      } else {
        b.accounts.push({ name: name, kind: kind, value: Number(ch.value) || 0, limit: kind === 'card' ? (Number(ch.limit) || 0) : 0, note: '' });
      }
    } else if (ch.type === 'field') {
      // v56: a custom detail on an existing row — base.details side-map keyed
      // "kind:name", so no per-entity schema change (budgets stay a flat map).
      // v65: fEnt is the entity string (mirrors chat.js + the parser test);
      // 'cash' renamed 'debit', a legacy 'cash' normalized.
      var fEnt = ['cash', 'debit', 'card', 'debt', 'loan', 'budget'].indexOf(ch.entity) >= 0 ? ch.entity : null;
      if (!fEnt || !name || !ch.key) throw new Error('field change needs entity, name and key');
      if (fEnt === 'cash') fEnt = 'debit';
      b.details = b.details || {};
      var dk = fEnt + ':' + name;
      if (ch.value === null) {
        if (b.details[dk]) {
          delete b.details[dk][ch.key];
          if (!Object.keys(b.details[dk]).length) delete b.details[dk];
        }
      } else {
        b.details[dk] = b.details[dk] || {};
        b.details[dk][ch.key] = ch.value;
      }
    } else {
      throw new Error('unknown story change: ' + ch.type);
    }
  }
  function applyBaseChanges(changes) {
    if (!changes || !changes.length) return Promise.reject(new Error('nothing to apply'));
    var nb = cloneObj(state.base || defaultBase());
    changes.forEach(function (ch) { applyBaseChange(nb, ch); });
    var prev = cloneObj(state.base || defaultBase());
    return saveBase(nb).then(function () {
      idbPut(STORE_META, { key: STORY_UNDO_KEY, value: { base: prev, at: Date.now() } }).catch(function () {});
      emit('snap');
      renderFooter();
      renderBaseStatus();
      return nb;
    });
  }
  function undoBaseStory() {
    return idbAll(STORE_META).then(function (rows) {
      var prev = null;
      (rows || []).forEach(function (m) { if (m.key === STORY_UNDO_KEY) prev = m.value; });
      if (!prev || !prev.base) return null;
      var nb = cloneObj(prev.base);
      return saveBase(nb).then(function () {
        idbDel(STORE_META, STORY_UNDO_KEY).catch(function () {});
        emit('snap');
        renderFooter();
        renderBaseStatus();
        return nb;
      });
    });
  }

  // ---------- actions ----------
  // v72.10: opts.quiet — the caller shows its own snack (the owed flow wraps
  // the add in an entry+txn undo, two toasts would collide).
  function addTxn(data, opts) {
    var id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    var t = {
      id: id, date: data.date, account: data.account, kind: data.kind,
      category: data.category, amount: data.amount, note: data.note,
      created: new Date().toISOString()
    };
    state.txns.push(t);
    addAdj(txnAdj(t), 1);
    logMoney('add', t);
    return Promise.all([idbPut(STORE_TX, t), saveAdj()]).then(function () {
      emit('txn');
      if (!(opts && opts.quiet)) {
        // v72.36 (user: 'return the undo button for all toasts'): v71's
        // "no Undo on the add toast" call is REVERSED — Undo quietly removes
        // the just-added entry (removeTxnQuiet: no second toast, and the
        // money-log row + account adjustment go with it — the exact inverse
        // of add).
        snack('Added ' + money(t.amount) + ' · ' + esc(t.category || t.account), function () {
          removeTxnQuiet(t.id);
        });
      }
      return Promise.resolve();
    }).then(function () { return id; });
  }
  function deleteTxn(id) {
    var t = null;
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === id) t = state.txns[i];
    if (!t) return Promise.resolve();
    state.txns = state.txns.filter(function (x) { return x.id !== id; });
    addAdj(txnAdj(t), -1);
    logMoney('del', t);
    syncTombAdd('t', id); // v73.3: the deletion syncs (tombstone; Undo clears it)
    return Promise.all([idbDel(STORE_TX, id), saveAdj()]).then(function () {
      emit('txn');
      snack('Deleted ' + money(t.amount) + ' · ' + esc(t.category || t.account), function () {
        syncTombRemove('t', id); // the record is back — the tombstone goes
        state.txns.push(t);
        addAdj(txnAdj(t), 1);
        logMoney('add', t);
        Promise.all([idbPut(STORE_TX, t), saveAdj()]).then(function () { emit('txn'); });
      });
    });
  }
  // v34: ledger rows are deletable — confirms first, then removes the txn AND its
  // money-log row; the undo snack restores both.
  function askDeleteTxn(tid) {
    var t = null;
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === tid) t = state.txns[i];
    var what = t ? money(t.amount) + ' · ' + esc(t.category || t.account || 'entry') : 'this entry';
    confirmAsk('Delete <b>' + what + '</b> from the ledger? Free cash goes back up and you can undo right after.',
      'Delete', function () { deleteTxnFromLog(tid); });
  }
  // v71: the delete + edit paths share one remove/restore pair, so an edit is
  // "delete the row, re-log it with the new values, keep the same id".
  // v72.9: the pair also carries the ORIGINAL positions (txn index, log-row
  // indices), so Undo puts the original row back where it was, not at the end.
  // keepInStore: for Undo — leave the persistent row in place (the edited row,
  // at its position); restoreTxnRow's put then REPLACES it by id instead of
  // delete+re-add filing the original at the end of the store.
  function removeTxnRow(tid, keepInStore) {
    var t = null, txIdx = -1;
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === tid) { t = state.txns[i]; txIdx = i; }
    var log = state.moneyLog || [];
    var removed = [], logIdxs = [];
    for (var j = 0; j < log.length; j++) if (log[j] && log[j].tid === tid) { removed.push(log[j]); logIdxs.push(j); }
    if (!t && !removed.length) return null;
    if (t) {
      state.txns = state.txns.filter(function (x) { return x.id !== tid; });
      addAdj(txnAdj(t), -1);
      // v73.3: the deletion syncs (Undo clears the tombstone). keepInStore =
      // the EDIT path (the row is re-logged under the same id) — not a delete.
      if (!keepInStore) syncTombAdd('t', tid);
    }
    state.moneyLog = log.filter(function (e) { return !(e && e.tid === tid); });
    idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog }).catch(function () {});
    var done = t
      ? (keepInStore ? Promise.resolve() : Promise.all([idbDel(STORE_TX, tid), saveAdj()]))
      : Promise.resolve();
    return { t: t, removed: removed, txIdx: txIdx, logIdxs: logIdxs, persist: done };
  }
  function restoreTxnRow(r) {
    if (r.t) {
      // an edited version (same id) may be there now — it goes, the original comes back
      state.txns = state.txns.filter(function (x) { return x.id !== r.t.id; });
      // v72.9: back at the original index (clamped — the list may have shrunk)
      var ti = (typeof r.txIdx === 'number' && r.txIdx >= 0) ? Math.min(r.txIdx, state.txns.length) : state.txns.length;
      state.txns.splice(ti, 0, r.t);
      addAdj(txnAdj(r.t), 1);
      idbPut(STORE_TX, r.t).catch(function () {});
    }
    if (r.removed.length) {
      state.moneyLog = (state.moneyLog || []).filter(function (e) { return !(e && r.t && e.tid === r.t.id); });
      // v72.9: each log row back at its original index (1-row-per-tid in practice)
      var idxs = r.logIdxs || [];
      r.removed.forEach(function (e, k) {
        var li = (typeof idxs[k] === 'number' && idxs[k] >= 0) ? Math.min(idxs[k], state.moneyLog.length) : state.moneyLog.length;
        state.moneyLog.splice(li, 0, e);
      });
      if (state.moneyLog.length > ML_CAP) state.moneyLog = state.moneyLog.slice(-ML_CAP);
      idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog }).catch(function () {});
    }
    if (r.t) saveAdj();
    emit('txn');
  }
  function deleteTxnFromLog(tid) {
    var r = removeTxnRow(tid);
    if (!r) return;
    r.persist.then(function () {
      emit('txn');
      snack('Deleted ' + (r.t ? money(r.t.amount) + ' · ' + esc(r.t.category || r.t.account) : 'entry'), function () {
        syncTombRemove('t', tid); // the row is back — the tombstone goes
        restoreTxnRow(r);
      });
    });
  }
  // the month a money-log row's s (month-spent) line belongs to: the row's OWN
  // txn's date-month — logMoney stamps s from the txn date, not the log time.
  function monthOfTxn(tid) {
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === tid) return String(state.txns[i].date || '').slice(0, 7);
    return '';
  }
  // v71: editable ledger entries — same id, same created stamp.
  // v72.9: the edit is IN PLACE — the txn keeps its index in state.txns and the
  // money-log row keeps its index AND its ORIGINAL timestamp; the row's values
  // are rewritten in place. The audit chain stays honest because every row's
  // running f/o/s was snapshotted WITH the original entry's effect, so the
  // edit's constant delta (Δfree / Δcard) is added to the edited row AND every
  // row recorded after it. Month-spent: a row's s line belongs to its own txn's
  // date-month, so same-month edits add (new−old) to that month's lines, and a
  // month change pulls oldAmt out of the old month's lines and newAmt into the
  // new month's; the edited row's own month line is dropped when the entry
  // crosses months (the new month's running spend isn't derivable from the log
  // alone — totals come from txns via monthSpendSum, so only the row's line
  // goes). Undo is the exact inverse: un-rebase the tail, then swap the
  // ORIGINAL row (values + timestamp) back where the edited row sits.
  // v72.10: per-kind effects — spend pulls free down, cash inflows push it back
  // up; v72.42: a card payment moves free by ZERO (the charge already spent it
  // — the payoff only settles the debt); card owed moves only for the two card
  // kinds; month spend counts spend, nets inflows, ignores card payments.
  function freeEffect(kind, amt) { if (kind === 'card_payment') return 0; return (kind === 'cash_in') ? amt : -amt; }
  function cardEffect(kind, amt) { return kind === 'card_charge' ? amt : kind === 'card_payment' ? -amt : 0; }
  // v73.7: the cycle's OWN SALARY is income, not negative spend — the money-log
  // month-spent line must not swing by the full salary when the "Salary in"
  // check-in lands (v72.10 netted every cash_in down, so logging ₱46,615 took
  // the line from 12,340 to −34,275). v73.10: the identity is the AMOUNT — a
  // cash_in of at least 90% of the month's expected salary IS the salary no
  // matter its date: the v73.7 date window (1st..payday+2, an early-payday
  // allowance) was for cycleDataFor's RECEIVED display, but this function is
  // also the money-log's swing guard, and the Money in tab (v73.8) defaults
  // the date to TODAY — a salary logged on the 25th fell outside the window,
  // was classified as a "refund", and swung the line by the full salary
  // (reproduced live in Chromium: 100 → −44,900). A real refund is never
  // 90% of the salary, so the amount rule is safe; the earliest date still
  // wins when two candidates exist (a double-salary month).
  function salaryTxnIdInMonth(month) {
    var b = state.base || {};
    var expected = expectedSalaryFor(month, b);
    if (!(expected > 0)) return null;
    var best = null;
    state.txns.forEach(function (t) {
      if (t.kind !== 'cash_in') return;
      var amt = Number(t.amount) || 0;
      if (amt < 0.9 * expected) return;
      if (!best || String(t.date || '') < String(best.date || '')) best = t;
    });
    return best ? best.id : null;
  }
  // v73.10: is THIS txn a salary? The identity is the AMOUNT, per month — a
  // cash_in of at least 90% of the month's expected salary is salary on ANY
  // date, and a second one (a double-salary month) is salary too. The
  // v73.7/v73.10-earliest rules keyed off the month's ONE identified salary
  // (salaryTxnIdInMonth's earliest-date tie-break), so a salary logged LATE
  // in the month — the Money in tab defaults the date to today — was
  // classified as a "refund" and swung the line by the full salary
  // (reproduced live in Chromium: 100 → −44,900). A real refund is never
  // 90% of the salary, so the amount rule is safe. salaryTxnIdInMonth stays
  // for the row-identity checks (the chip hide, the v73.7 pins).
  // the kind guard lives at the call sites (monthEffect checks kind ===
  // 'cash_in'; the chip hide checks e.k === 'i') — this is the AMOUNT rule
  // only, so it also works on the rebase path's plain {id, date}. `amt`
  // overrides t.amount: monthEffect's amt is the LIVE amount (t may be the
  // pre-edit original on the rebase path).
  function salaryIsTxn(t, amt) {
    if (!t) return false;
    var a = (amt !== undefined) ? Number(amt) : (Number(t.amount) || 0);
    var exp = expectedSalaryFor(String(t.date || '').slice(0, 7), state.base || {});
    return a >= 0.9 * exp;
  }
  function monthEffect(kind, amt, t) {
    if (kind === 'card_payment') return 0;
    if (kind === 'cash_in') return salaryIsTxn(t, amt) ? 0 : -amt;
    return amt;
  }
  function saveTxnEdit(tid, data, opts) {
    var o = null, oIdx = -1;
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === tid) { o = state.txns[i]; oIdx = i; }
    if (!o) return Promise.resolve();
    var t = {
      id: tid, date: data.date, account: data.account, kind: data.kind,
      category: data.category, amount: data.amount, note: data.note,
      created: o.created || new Date().toISOString()
    };
    state.txns[oIdx] = t; // in place — position preserved
    addAdj(txnAdj(t), 1);
    addAdj(txnAdj(o), -1);
    var oldAmt = Number(o.amount) || 0, newAmt = Number(t.amount) || 0;
    // effect delta (new − old) across free / card / month-spent
    var dFree = freeEffect(t.kind, newAmt) - freeEffect(o.kind, oldAmt);
    var dCard = cardEffect(t.kind, newAmt) - cardEffect(o.kind, oldAmt);
    var meOld = monthEffect(o.kind, oldAmt, o), meNew = monthEffect(t.kind, newAmt, t); // v73.7: salary-aware
    var M_old = String(o.date || '').slice(0, 7), M_new = String(t.date || '').slice(0, 7);
    function rebase(e, dF, dC, sMode) {
      if (e.f != null) e.f = r2(e.f + dF);
      if (e.o != null) e.o = r2(e.o + dC);
      if (e.s != null && sMode) {
        var m = monthOfTxn(e.tid);
        if (M_old === M_new) { if (m === M_old) e.s = r2(e.s + (meNew - meOld) * sMode); }
        else if (m === M_old) e.s = r2(e.s - meOld * sMode);
        else if (m === M_new) e.s = r2(e.s + meNew * sMode);
      }
    }
    var log = state.moneyLog || [];
    var li = -1;
    for (var j = 0; j < log.length; j++) if (log[j] && log[j].tid === tid) { li = j; break; }
    var origRow = li >= 0 ? Object.assign({}, log[li]) : null; // BEFORE the rewrite — Undo's payload
    if (li >= 0) {
      var e0 = log[li];
      e0.n = newAmt;
      e0.k = t.kind === 'card_charge' ? 'c' : t.kind === 'card_payment' ? 'p' : t.kind === 'cash_in' ? 'i' : 'x';
      e0.c = t.category || '';
      e0.nt = t.note || '';
      e0.m = t.account || '';
      e0.l = (t.category || t.account || 'entry') + (t.note ? ' · ' + t.note : '');
      // e.at is UNTOUCHED — the original date/time stays on the row
      rebase(e0, dFree, dCard, 1);
      // v72.10: the edit flipped the row to a card flavor — backfill the card
      // line from the (post-edit) snapshot so the row renders complete
      if (e0.o == null && (t.kind === 'card_charge' || t.kind === 'card_payment')) {
        var sNow = effectiveSnap();
        if (sNow) e0.o = r2(sNow.card_owed || 0);
      }
      if (M_old !== M_new) delete e0.s; // month line no longer fits (see the note above)
      for (var k = li + 1; k < log.length; k++) { if (log[k]) rebase(log[k], dFree, dCard, 1); }
      idbPut(STORE_META, { key: 'moneyLog', value: log }).catch(function () {});
    }
    return Promise.all([idbPut(STORE_TX, t), saveAdj()]).then(function () {
      emit('txn');
      // v72.10: opts.quiet — the owed flow wraps the edit in its own
      // entry+txn undo toast (two snacks would collide).
      if (!(opts && opts.quiet))
      snack('Updated ' + money(t.amount) + ' · ' + esc(t.kind === 'card_payment' ? 'CC Payment' : (t.category || 'Unsorted')), function () {
        // undo: the exact inverse — un-rebase everything after the edited row
        // (a row logged AFTER the edit already reflects the NEW values; it is
        // left as-is — undoing an edit after interleaved new entries is a
        // sub-second edge the 5.2 s snack window makes unlikely), then swap the
        // ORIGINAL row back where the edited row sits now.
        var lg = state.moneyLog || [];
        var liE = -1;
        for (var x = 0; x < lg.length; x++) if (lg[x] && lg[x].tid === tid) { liE = x; break; }
        if (liE >= 0) {
          for (var y = liE + 1; y < lg.length; y++) { if (lg[y]) rebase(lg[y], -dFree, -dCard, -1); }
          idbPut(STORE_META, { key: 'moneyLog', value: lg }).catch(function () {});
        }
        var r = removeTxnRow(tid, true); // keep the persistent row (see above)
        if (!r) {
          restoreTxnRow({ t: o, txIdx: oIdx, removed: origRow ? [origRow] : [], logIdxs: li >= 0 ? [li] : [] });
          return;
        }
        r.t = o; // original values; r.txIdx/logIdxs = the edited row's CURRENT positions
        r.removed = origRow ? [origRow] : [];
        r.persist.then(function () { restoreTxnRow(r); }); // restore re-puts in place by id (+ saveAdj)
      });
      return tid;
    });
  }
  // v71: opening the Add sheet in EDIT mode — the entry's values prefill the
  // same fields (amount / category / paid-with / date / note), the sheet title
  // and button switch to "Edit entry" / "Save changes". Values that are no
  // longer in the seeded options (old custom names) get a one-off option.
  var editingTxn = null;
  function openTxnEdit(tid) {
    var t = null;
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === tid) t = state.txns[i];
    if (!t) return;
    editingTxn = t;
    seedCategories();
    var cs = byId('f_category');
    if (cs) {
      var hasC = false;
      for (var ci = 0; ci < cs.options.length; ci++) if (cs.options[ci].value === (t.category || '')) hasC = true;
      if (!hasC && t.category) {
        var oc = document.createElement('option');
        oc.value = t.category; oc.textContent = t.category;
        cs.appendChild(oc);
      }
      cs.value = t.category || '';
    }
    seedAccounts();
    var as = byId('f_account');
    if (as) {
      // v72.10: a card payment belongs to a CARD account, like its charge twin
      var av = (t.kind === 'card_charge' || t.kind === 'card_payment' ? 'CARD' : 'CASH') + '::' + (t.account || 'Cash');
      var hasA = false;
      for (var ai = 0; ai < as.options.length; ai++) if (as.options[ai].value === av) hasA = true;
      if (!hasA) {
        var oa = document.createElement('option');
        oa.value = av; oa.textContent = t.account || 'Cash';
        as.appendChild(oa);
      }
      as.value = av;
    }
    var amtEl = byId('f_amount');
    if (amtEl) amtEl.value = String(t.amount);
    var ntEl = byId('f_note');
    if (ntEl) ntEl.value = t.note || '';
    var dtEl = byId('f_date');
    if (dtEl) { dtEl.value = t.date || todayISO(); syncDateLabel(dtEl); }
    addAmtEq(amtEl); // refresh the quick-sum hint for the prefilled value
    setAddMode('spend'); // v72.41: editing an entry re-opens the sheet in Spend mode (the kind follows the entry)
    var ttl = byId('addSheetTitle');
    if (ttl) ttl.textContent = 'Edit entry';
    var sub = byId('addSubmit');
    if (sub) sub.textContent = 'Save changes';
    openSheet('addSheet');
  }
  function exitTxnEdit() {
    if (!editingTxn) return;
    editingTxn = null;
    var ttl = byId('addSheetTitle');
    if (ttl) ttl.textContent = 'Add expense';
    var sub = byId('addSubmit');
    if (sub) sub.textContent = 'Add expense';
  }

  // ---------- Phase 6: money log — per-change audit trail so the overview math can be sanity-checked ----------
  var ML_CAP = 30;   // entries kept in the meta store (the card shows all of them)
  function logMoney(action, t) {
    var s = effectiveSnap();
    if (!s) return;
    var amt = Number(t.amount) || 0;
    var mp = todayISO().slice(0, 7);
    var e = {
      at: Date.now(), a: action, tid: t.id,
      l: (t.category || t.account || 'entry') + (t.note ? ' · ' + t.note : ''),
      // v71: the row title is the CATEGORY — blank stays blank, so a no-category
      // (Unsorted) add is titled "Unsorted", not the account (e.g. "Cash").
      // The account name lives in m (shown under the date) exactly as before.
      c: t.category || '', nt: t.note || '', m: t.account || '',
      n: amt,
      // v72.10: k = the row's FLAVOR — c charge / p card payment / x cash
      // spend / i cash in. Render derives every before→after from it.
      k: t.kind === 'card_charge' ? 'c' : t.kind === 'card_payment' ? 'p' : t.kind === 'cash_in' ? 'i' : 'x'
    };
    e.f = r2(s.cash ? s.cash.free : 0);
    if (t.kind === 'card_charge' || t.kind === 'card_payment') e.o = r2(s.card_owed || 0);
    if (String(t.date).slice(0, 7) === mp && t.kind !== 'card_payment') {
      // v72.10: month spend nets inflows down; a card payment isn't spend
      // (the charge that created the debt already counted).
      // v73.7: the cycle's own SALARY is income, not negative spend — it does
      // not move the month-spent line (monthEffect carries the same rule).
      var sp = 0;
      state.txns.forEach(function (x) {
        if (String(x.date).slice(0, 7) !== mp) return;
        sp += monthEffect(x.kind, Number(x.amount) || 0, x);
      });
      e.s = r2(sp);
    }
    state.moneyLog.push(e);
    if (state.moneyLog.length > ML_CAP) state.moneyLog = state.moneyLog.slice(-ML_CAP);
    idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog }).catch(function () {});
  }
  function mlDate(ts) {
    var d = new Date(ts);
    var MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    // v71: the time (12-hour AM/PM) sits next to the date on every ledger row.
    var h = d.getHours(), h12 = h % 12 || 12, ap = h >= 12 ? 'PM' : 'AM';
    return MO[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() +
      ' \u00b7 ' + h12 + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes() + ' ' + ap;
  }
  function mlParts(e) {
    var lab, note = '';
    if (e.c != null) {
      // v72.47: a card prepay (k 'p') is filed under its own label — the
      // v72.44 reco's "clearly labelled as prepays rather than 'Unsorted'
      // spend" (the aggregates were excluded, the label never shipped). A
      // prepay logged early for the 14th is future-dated but the same flavor
      // → the same label.
      lab = e.k === 'p' ? 'CC Payment' : (e.c || 'Unsorted');
      note = e.nt || '';
    } else {
      // legacy entry (pre-v17): only the merged "Category · note" label was stored
      lab = e.l || 'entry';
      var dot = lab.indexOf(' · ');
      if (dot > 0) { note = lab.slice(dot + 3); lab = lab.slice(0, dot); }
    }
    var m = e.m || (e.k === 'c' ? 'Card' : '');
    if (m && lab === m) m = '';
    return { lab: lab, note: note, m: m };
  }
  // v53: ledger category filter. '' = all; '__unsorted__' = entries with no
  // category (shown as Unsorted); anything else matches the category exactly.
  var mlFilterCat = '';
  // v72.29 (user edit): "See more" paging for the money log — the first 5
  // rows (newest first) show; the button reveals 5 older ones per tap; a
  // filter change starts the page over. In-memory — resets on reload.
  var mlShownCount = 5;
  function renderMlFilter() {
    var sel = byId('mlFilter');
    if (!sel) return;
    var log = state.moneyLog || [];
    var cats = [];
    var hasUnsorted = false, hasCcpay = false;
    log.forEach(function (e) {
      if (!e) return;
      if (e.k === 'p') { hasCcpay = true; return; } // v72.47: a prepay is "CC Payment", never Unsorted
      if (e.c) { if (cats.indexOf(e.c) < 0) cats.push(e.c); }
      else hasUnsorted = true;
    });
    cats.sort();
    var html = '<option value="">All</option>';
    if (hasCcpay) html += '<option value="__ccpay__">CC Payment</option>'; // v72.47
    if (hasUnsorted) html += '<option value="__unsorted__">Unsorted</option>';
    cats.forEach(function (c) { html += '<option value="' + esc(c) + '">' + esc(c) + '</option>'; });
    sel.innerHTML = html;
    sel.value = mlFilterCat;
    if (sel.value !== mlFilterCat) mlFilterCat = sel.value; // filtered category no longer present
  }
  function renderMoneyLog() {
    var el = byId('moneyLog');
    if (!el) return;
    var noteEl = byId('mlNote');
    var body = byId('mlBody');
    var log = state.moneyLog || [];
    renderMlFilter();
    if (!log.length) {
      if (noteEl) noteEl.style.display = 'none';
      body.innerHTML = '<p class="note" style="margin:2px 0">' + (state.txns.length
        ? 'Nothing logged yet — add or remove an entry to see how it moves your free cash.'
        : 'No entries yet — tap + to add your first expense.') + '</p>';
      return;
    }
    var shown = log.slice().reverse().filter(function (e) {
      if (!mlFilterCat) return true;
      if (mlFilterCat === '__ccpay__') return e.k === 'p'; // v72.47: the CC Payment filter
      if (mlFilterCat === '__unsorted__') return e.k !== 'p' && !e.c;
      return e.c === mlFilterCat;
    });
    if (!shown.length) {
      if (noteEl) noteEl.style.display = 'none';
      body.innerHTML = '<p class="note" style="margin:2px 0">No ' +
        (mlFilterCat === '__unsorted__' ? 'unsorted' : mlFilterCat === '__ccpay__' ? 'cc payment' : esc(mlFilterCat)) +
        ' entries — clear the filter to see the rest.</p>';
      return;
    }
    if (noteEl) noteEl.style.display = '';
    // v72.29 (user edit): "See more" — 5 rows at a time, the old ones hidden
    var limited = shown.slice(0, mlShownCount);
    body.innerHTML = limited.map(function (e) {
        var add = e.a === 'add';
        // v72.10: inflow rows (i cash in) move free the OTHER way — a row's
        // before→after follows its flavor, not its add/del side.
        // v72.30: 'a' = a balance override — n is SIGNED and there is no txn
        // behind the row; a debit row's free moved by exactly the diff
        // (before = f − n), a card row (o set) never moves free — only the
        // card balance does (before = o − n).
        // v72.42: 'p' (card payment) moves free by ZERO — the charge already
        // spent it; the payoff only settles the debt (raw cash + owed drop),
        // so free before == after (the card sub-line still shows owed drop).
        var isAdj = e.k === 'a';
        var inflow = e.k === 'i' || e.k === 'p';
        var before = (e.k === 'p') ? r2(e.f)
          : r2(e.f + (add ? (inflow ? -e.n : e.n) : (inflow ? e.n : -e.n)));
        if (isAdj) before = r2(e.f - e.n);
        var extra = '';
        if (e.k === 'c' || e.k === 'p') {
          var oBefore = r2(e.o + (add ? (e.k === 'c' ? -e.n : e.n) : (e.k === 'c' ? e.n : -e.n)));
          extra = '<span class="ml-x">card ' + money(oBefore) + ' → ' + money(e.o) + '</span>';
        } else if (isAdj && e.o != null) {
          extra = '<span class="ml-x">card ' + money(r2(e.o - e.n)) + ' → ' + money(e.o) + '</span>';
        }
        if (e.s != null) {
          // v73.9 (user: 'still shows it on the ledger entries wrong (which
          // should be correct already and hidden)'): the salary row's s value
          // is correct now (v73.7 — the line doesn't move), but the flat
          // "month spent X → X" chip still rendered on it. Income is not
          // spend — the cycle's own salary row shows NO month-spent line;
          // refunds still net the audit line, so their chip stays.
          // v73.10: the chip hide follows the SAME amount rule as monthEffect
          // (salaryIsTxn) — the v73.9 identity (salaryTxnIdInMonth) only
          // covered the month's earliest salary-sized txn, so a late-logged
          // salary still got its chip.
          var isSalRow = add && e.k === 'i' && salaryIsTxn(
            (function () { for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === e.tid) return state.txns[i]; return null; })()
          );
          if (!isSalRow) {
            var sBefore = r2(e.s + (add ? (e.k === 'i' ? e.n : -e.n) : (e.k === 'i' ? -e.n : e.n)));
            extra += '<span class="ml-x">month spent ' + money(sBefore) + ' → ' + money(e.s) + '</span>';
          }
        }
        var p = mlParts(e);
        // v71: add rows with a live txn are editable — tap the row (not the ✕).
        // Adjustment rows carry no txn: they are the audit record (a wrong
        // override is corrected by the next one).
        var editAttr = (add && e.tid) ? ' data-ml-edit="' + esc(e.tid) + '" title="Tap to edit" style="cursor:pointer"' : '';
        var delBtn = (add && e.tid) ? '<button type="button" class="mini" data-ml-del="' + esc(e.tid) +
          '" aria-label="Delete this expense" title="Delete this expense">\u2715</button>' : '';
        // v72.31: Adjustment rows (no txn behind them) get their own ✕ — it
        // removes the record and reverses the override in Settings. The key is
        // the row's index in state.moneyLog (true at render time; every change
        // re-renders the list before another click can land).
        var adjDel = isAdj ? '<button type="button" class="mini" data-adj-del="' + log.indexOf(e) +
          '" aria-label="Remove this adjustment" title="Remove the record — it takes the override back">\u2715</button>' : '';
        var down = add ? !inflow : inflow; // spend down / come-back up vs inflow up / take-back down
        var amtTxt = (down ? '−' : '+') + money(e.n);
        var freeTxt = '<span class="ml-f">free ' + money(before) + ' → ' + money(e.f) + '</span>';
        if (isAdj) {
          var cardRow = e.o != null;
          down = cardRow ? e.n > 0 : e.n < 0; // more owed (card) / less cash (debit) = the red side
          amtTxt = (e.n > 0 ? '+' : '−') + money(Math.abs(e.n));
          if (cardRow) freeTxt = ''; // a card override never moves free
        }
        if (e.k === 'p') freeTxt = ''; // v72.44 (user edit): a payoff never moves free — show only the card balance change
        return '<div class="ml-row' + (add ? '' : ' del') + '"' + editAttr + '>' +
          '<div class="ml-l"><div class="ml-cat">' + esc(p.lab) + '</div>' +
          (p.note ? '<div class="ml-note">' + esc(p.note) + '</div>' : '') +
          '<div class="ml-meta">' + mlDate(e.at) + (p.m ? ' · ' + esc(p.m) : '') + '</div></div>' +
          '<div class="ml-r"><b class="' + (down ? 'ml-down' : 'ml-up') + '">' + amtTxt + '</b>' +
          freeTxt + extra + delBtn + adjDel + '</div></div>';
      }).join('') +
      // v72.30 (user edit: 'see less beside see more'): the buttons share one
      // row — See less re-hides 5 per tap down to the first page (hidden there)
      ((shown.length > limited.length || mlShownCount > 5) ? '<div class="ml-pag">' +
      (shown.length > limited.length ? '<button type="button" class="addrow" id="mlMore">See more</button>' : '') +
      (mlShownCount > 5 ? '<button type="button" class="addrow" id="mlLess">See less</button>' : '') +
      '</div>' : '');
    var dl = body.querySelectorAll('[data-ml-del]');
    for (var di = 0; di < dl.length; di++) dl[di].onclick = function (ev) {
      ev.stopPropagation(); // v71: ✕ deletes — it must not also open the editor
      askDeleteTxn(this.getAttribute('data-ml-del'));
    };
    var adj = body.querySelectorAll('[data-adj-del]'); // v72.31: ✕ on Adjustment rows
    for (var aj = 0; aj < adj.length; aj++) adj[aj].onclick = function (ev) {
      ev.stopPropagation();
      askDeleteAdjustment(Number(this.getAttribute('data-adj-del')));
    };
    var ed = body.querySelectorAll('[data-ml-edit]');
    for (var ei = 0; ei < ed.length; ei++) ed[ei].onclick = function () { openTxnEdit(this.getAttribute('data-ml-edit')); };
    var more = byId('mlMore');
    if (more) more.onclick = function () { mlShownCount += 5; renderMoneyLog(); };
    var less = byId('mlLess'); // v72.30: re-hide 5 per tap (floor: the first page)
    if (less) less.onclick = function () { mlShownCount = Math.max(5, mlShownCount - 5); renderMoneyLog(); };
  }

  // ---------- bottom sheets (Add, Settings) ----------
  var openSheetEl = null;
  var lastFocus = null;
  function closeSheets() {
    var sc = byId('scrim');
    var wasOpen = !!openSheetEl;
    if (sc) sc.classList.remove('show');
    // v71: closing "Your numbers" with unsaved changes commits them — the
    // Save button is the fast path, but nothing typed is ever dropped.
    if (openSheetEl && openSheetEl.id === 'numSheet' && baseDirty) commitBaseForm();
    // v71: closing the Add sheet leaves edit mode (title/button back to add).
    if (openSheetEl && openSheetEl.id === 'addSheet') exitTxnEdit();
    if (openSheetEl) { openSheetEl.classList.remove('show'); openSheetEl = null; }
    if (wasOpen && lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }
  function openSheet(id) {
    var sh = byId(id), sc = byId('scrim');
    if (!sh || !sc) return;
    closeSheets();
    lastFocus = document.activeElement;
    sc.classList.add('show');
    sh.classList.add('show');
    openSheetEl = sh;
    if (id === 'numSheet') renderBaseEditor();
    else if (id === 'setSheet') { renderBaseStatus(); backupSelSync(); } // v72.23: show the stored "what to include"
    // a11y: move focus into the sheet (first field, else first control).
    // The Settings and Your-numbers sheets are skipped: they hold many text
    // inputs and an auto-focus would pop the keyboard on open.
    try {
      if (id === 'setSheet' || id === 'numSheet') return;
      var f = sh.querySelectorAll('input,select,textarea');
      if (!f.length) f = sh.querySelectorAll('button');
      if (f && f.length) f[0].focus();
    } catch (e) {}
  }

  // ---------- snack banner (v72.32: top banner, 7s, swipe up to dismiss) ----------
  // v72.32 (user: 'for the toasts, remake them into a banner on the top of
  // screen which stays for 7 seconds but can be swiped up to remove
  // immediately. kinda similar to the new version toast.'): the snack moved to
  // the top (the #swToast family, same hidden-state discipline) and lives 7s;
  // dragging the banner UP follows the finger (a little resistance + fade),
  // and releasing past the threshold (-60px or 40% of the banner height,
  // whichever is the larger pull) dismisses it immediately — anything less
  // springs back. The Undo button is not a drag handle. touch-action:none on
  // the banner keeps the page from stealing the swipe (no preventDefault, so
  // the button's click still fires).
  var snackTimer = null;
  var snackDragStart = null;
  var snackDragY = 0;
  function snackDragReset() {
    snackDragStart = null;
    snackDragY = 0;
    var el = byId('snack');
    if (el) {
      el.style.transform = '';
      el.style.opacity = '';
      el.classList.remove('dragging');
    }
  }
  function hideSnack() {
    var el = byId('snack');
    if (el) { el.classList.remove('show'); snackDragReset(); }
  }
  function wireSnackSwipe() {
    var el = byId('snack');
    if (!el || typeof el.addEventListener !== 'function' || el.__snackSwipe) return;
    el.__snackSwipe = true;
    el.addEventListener('pointerdown', function (ev) {
      if (!el.classList.contains('show')) return;
      if (ev.target && ev.target.id === 'snackUndo') return; // the button is not a drag handle
      if (ev.button !== undefined && ev.button !== 0) return;
      snackDragStart = ev.clientY;
      snackDragY = 0;
      el.classList.add('dragging'); // no transition while the finger is on it
      if (el.setPointerCapture && ev.pointerId !== undefined) { try { el.setPointerCapture(ev.pointerId); } catch (e) {} }
    });
    el.addEventListener('pointermove', function (ev) {
      if (snackDragStart === null) return;
      var dy = ev.clientY - snackDragStart;
      if (dy > 0) dy = 0; // the banner sits at the top — only up swipes dismiss
      snackDragY = dy;
      el.style.transform = 'translate(-50%,' + (dy * 0.85) + 'px)'; // a little resistance
      el.style.opacity = String(Math.max(0.25, 1 + dy / 220));
    });
    function snackDragEnd() {
      if (snackDragStart === null) return;
      var released = snackDragY;
      snackDragStart = null;
      var thr = -Math.max(60, (el.offsetHeight || 44) * 0.4); // -60px or 40% of the banner
      el.classList.remove('dragging');
      el.style.transform = '';
      el.style.opacity = '';
      if (released <= thr) { clearTimeout(snackTimer); hideSnack(); }
      // else: clearing the inline styles springs it back to the shown state
    }
    el.addEventListener('pointerup', snackDragEnd);
    el.addEventListener('pointercancel', snackDragEnd);
  }
  function snack(msg, undoFn, ms) {
    var el = byId('snack'); if (!el) return;
    snackDragReset(); // v72.32: a fresh show starts un-dragged
    el.innerHTML = '<span class="snack-msg">' + msg + '</span>' +
      (undoFn ? '<button type="button" id="snackUndo">Undo</button>' : '');
    if (undoFn) {
      var b = byId('snackUndo');
      if (b) b.onclick = function () { hideSnack(); undoFn(); };
    }
    el.classList.add('show');
    clearTimeout(snackTimer);
    snackTimer = setTimeout(hideSnack, ms || 7000); // v72.32: the banner lives 7s
  }

  // ---------- v34: confirm dialog (destructive deletes ask first) ----------
  var confirmCb = null;
  function confirmAsk(msg, yesLabel, onYes) {
    var dlg = byId('confirmDlg');
    if (!dlg) { if (onYes) onYes(); return; }
    var m = byId('confirmMsg');
    if (m) m.innerHTML = msg;
    var yes = byId('confirmYes');
    if (yes) yes.textContent = yesLabel || 'Delete';
    confirmCb = onYes || null;
    dlg.classList.add('show');
    var no = byId('confirmNo');
    if (no && no.focus) { try { no.focus(); } catch (e) {} }
  }
  function closeConfirm() {
    var dlg = byId('confirmDlg');
    if (dlg) dlg.classList.remove('show');
    confirmCb = null;
  }
  function confirmYes() {
    var cb = confirmCb;
    closeConfirm();
    if (cb) cb();
  }
  function bindConfirm() {
    var dlg = byId('confirmDlg');
    if (!dlg) return;
    var no = byId('confirmNo'), yes = byId('confirmYes');
    if (no) no.onclick = closeConfirm;
    if (yes) yes.onclick = confirmYes;
    dlg.onclick = function (ev) { if (ev.target === dlg) closeConfirm(); };
    // capture phase + stopImmediatePropagation so Esc closes the dialog, not e.g. the coach bubble
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && dlg.classList.contains('show')) {
        ev.stopImmediatePropagation();
        closeConfirm();
      }
    }, true);
  }

  // ---------- "Your numbers" editor (Settings sheet) ----------
  // v71: quick sums in "Your numbers" — the amount fields are text inputs
  // (operators typeable, like the Add sheet) and numVal evaluates an
  // expression first (300-125+10 -> 185), falling back to parseFloat.
  // v72.6: with normalize=true the computed total is written back into the
  // field on commit (spreadsheet-style: the stored value is the total, so a
  // re-opened field shows the plain number). One-way: the original expression
  // is not kept.
  function numVal(el, normalize) {
    if (!el) return 0;
    var v = evalExpr(el.value);
    if (v != null) {
      if (normalize) el.value = v;
      return v;
    }
    v = parseFloat(el.value);
    return isFinite(v) ? r2(v) : 0;
  }
  function bsec(title) {
    return '<div class="bhead"><span class="ins-t">' + esc(title) + '</span></div>';
  }
  function brow(inner) { return '<div class="brow">' + inner + '</div>'; }
  function delBtn(label, blk) { return '<button type="button" class="mini" data-rm="' + (blk ? 'blk' : '1') + '" aria-label="' + esc(label || 'Remove') + '">✕</button>'; }
  // v71: drag handle — rows/blocks carrying it are reorderable in "Your numbers".
  function dragH() {
    return '<span class="bdrag" data-drag="1" aria-label="Drag to reorder" title="Drag to reorder">\u287F</span>';
  }
  function payRow(m, a, dr) {
    // v71: the amount is a text input with the FULL keyboard (no inputmode) —
    // a numeric keypad has no operators, which is exactly why quick sums died
    // in v52. Same treatment as the Add sheet's f_amount.
    return brow((dr ? dragH() : '') + '<input data-r="m" type="month" value="' + esc(m || '') + '">' +
      '<input data-r="a" type="text" value="' + (a != null ? a : '') + '">' +
      delBtn('Remove payment'));
  }
  // v56: custom details recorded by the coach — shown as chips under the row.
  // Tap a chip to remove it; the coach adds and updates details in chat.
  function detChips(dk) {
    var d = (state.base && state.base.details || {})[dk];
    if (!d) return '';
    var ks = Object.keys(d);
    if (!ks.length) return '';
    return '<div class="bchips">' + ks.map(function (k) {
      var v = (typeof d[k] === 'number') ? money(d[k]) : esc(String(d[k]));
      return '<button type="button" class="bchip" data-dk="' + esc(dk) + '" data-dk-key="' + esc(k) + '">' + esc(k) + ' ' + v + ' ✕</button>';
    }).join('') + '</div>';
  }
  function accRow(a) {
    a = a || {};
    // v72.4: the picker offers exactly Debit / Credit ("Credit" = the internal
    // 'card' kind). A legacy row with another stored kind (debt/loan from
    // older versions) keeps it via a per-row option, so a save can never
    // silently rewrite the kind; the user can still move it to Debit/Credit.
    var kinds = ['debit', 'card'];
    var legacy = a.kind && kinds.indexOf(a.kind) < 0;
    var kindOpts = (legacy
      ? '<option value="' + esc(a.kind) + '" selected>' + esc(a.kind) + ' (legacy)</option>'
      : '') + kinds.map(function (k) {
      return '<option value="' + k + '"' + (a.kind === k ? ' selected' : '') + '>' + (k === 'card' ? 'Credit' : 'Debit') + '</option>';
    }).join('');
    return brow(dragH() + '<input class="grow" data-r="name" value="' + esc(a.name || '') + '" autocomplete="off">' +
      '<select data-r="kind">' + kindOpts + '</select>' +
      '<input data-r="value" type="text" value="' + (a.value != null ? a.value : '') + '">' +
      '<input data-r="limit" type="text" value="' + (a.limit ? a.limit : '') + '"' + (a.kind === 'card' ? '' : ' disabled') + '>' +
      delBtn('Remove account')) + detChips(a.kind + ':' + a.name);
  }
  function debtBlock(d) {
    d = d || {};
    var pays = d.payments ? Object.keys(d.payments).map(function (m) { return payRow(m, d.payments[m]); }).join('') : '';
    return '<div class="bblk" data-sec="debt">' +
      brow(dragH() + '<input class="grow" data-r="name" value="' + esc(d.name || '') + '" autocomplete="off">' + delBtn('Remove debt', true)) +
      brow('<span class="bnote">monthly</span><input data-r="monthly" type="text" value="' + (d.monthly != null ? d.monthly : '') + '">' +
        '<span class="bnote">active</span><input class="grow" data-r="active" value="' + esc((d.active_months || []).join(', ')) + '" autocomplete="off">') +
      '<div data-r="pays">' + pays + '</div>' +
      '<button type="button" class="addrow" data-add="dpay">+ payment by month</button>' +
      '</div>';
  }
  // v68 item 6: goal math note — required ₱/mo to hit the deadline vs the
  // planned pace, and the boost that gets there on time.
  function sinkNote(s) {
    var goal = Number(s.goal) || 0, funded = Number(s.funded) || 0;
    var dl = String(s.deadline || '').slice(0, 7);
    if (goal <= 0 || funded >= goal || !/^\d{4}-\d{2}$/.test(dl)) return '';
    var nowM = todayISO().slice(0, 7);
    if (dl < nowM) return '';
    var pp = dl.split('-'), qq = nowM.split('-');
    var monthsLeft = (Number(pp[0]) - Number(qq[0])) * 12 + (Number(pp[1]) - Number(qq[1]));
    if (monthsLeft < 1) monthsLeft = 1;
    var needed = r2((goal - funded) / monthsLeft);
    var planned = 0;
    Object.keys(s.payments || {}).forEach(function (m) {
      if (m >= nowM) planned = Math.max(planned, Number(s.payments[m]) || 0);
    });
    if (planned + 0.004 < needed) {
      return '<div class="bchips"><span class="note" style="margin:2px 0">needs ' + money(needed) + '/mo by ' + monthLabel(dl) +
        ' — on ' + money(planned) + '/mo, add ' + money(r2(needed - planned)) + ' to hit it</span></div>';
    }
    var ma = planned > 0 ? Math.ceil((goal - funded) / planned) : 0;
    if (ma > 0) {
      return '<div class="bchips"><span class="note" style="margin:2px 0">on pace — ' + money(planned) + '/mo clears it in ' +
        ma + ' month' + (ma === 1 ? '' : 's') + '</span></div>';
    }
    return '<div class="bchips"><span class="note" style="margin:2px 0">no payments yet — needs ' + money(needed) + '/mo by ' + monthLabel(dl) + '</span></div>';
  }
  function sinkBlock(s) {
    s = s || {};
    var pays = s.payments ? Object.keys(s.payments).map(function (m) { return payRow(m, s.payments[m]); }).join('') : '';
    return '<div class="bblk" data-sec="sink">' +
      brow(dragH() + '<input class="grow" data-r="name" value="' + esc(s.name || '') + '" autocomplete="off">' + delBtn('Remove goal', true)) +
      brow('<span class="bnote">goal</span><input data-r="goal" type="text" value="' + (s.goal != null ? s.goal : '') + '">' +
        '<span class="bnote">funded</span><input data-r="funded" type="text" value="' + (s.funded != null ? s.funded : '') + '>') +
      brow('<span class="bnote">by</span><input data-r="deadline" type="date" value="' + esc(s.deadline || '') + '">') +
      sinkNote(s) +
      '<div data-r="pays">' + pays + '</div>' +
      '<button type="button" class="addrow" data-add="spay">+ payment by month</button>' +
      '</div>';
  }
  function renderBaseEditor() {
    var bb = byId('baseBody');
    if (!bb) return;
    // v71: a fresh render reads straight from state — nothing is dirty anymore.
    baseDirty = false;
    var qs0 = byId('qsBar'); if (qs0) qs0.style.display = 'none';
    var sb0 = byId('baseSaveBar'); if (sb0) sb0.style.display = 'none';
    var b = state.base || defaultBase();
    var h = '';
    h += brow('<span class="bnote">your name</span><input class="grow" id="b_name" type="text" placeholder="e.g. Jan" value="' + esc(b.name || '') + '" autocomplete="off">');
    h += brow('<span class="bnote">as of</span><input class="grow" id="b_asof" type="date" value="' + esc(b.as_of || '') + '">');
    // v71: amount fields are text inputs (full keyboard, operators typeable)
    // and numVal() evaluates quick sums like 300-125+10 on save.
    h += brow('<span class="bnote">salary / month</span><input class="grow" id="b_salary" type="text" placeholder="0.00, or a quick sum like 300-125+10" value="' + (b.salary || '') + '">');
    h += brow('<span class="bnote">liquidity floor</span><input class="grow" id="b_floor" type="text" value="' + (b.liquidity_floor || '') + '">');
    h += brow('<span class="bnote">cc prepay day</span><input class="grow" id="b_pday" type="text" value="' + (b.prepay_day || 14) + '">' +
      '<span class="bnote">cutoff</span><input class="grow" id="b_cday" type="text" value="' + (b.cutoff_day || 15) + '">');
    h += brow('<span class="bnote">cc due day</span><input class="grow" id="b_dday" type="text" value="' + (b.due_day || 5) + '" title="the day of the month the card bill is due — the due amount is the charges since the last cutoff minus the prepays logged in that window">');
    h += brow('<span class="bnote">salary day</span><input class="grow" id="b_sday" type="text" value="' + (b.salary_day || b.cutoff_day || 15) + '" title="the day of the month your salary lands — the salary cycle starts on it">');
    h += brow('<span class="bnote">card target util</span><input class="grow" id="b_util" type="text" value="' + (b.card_util_target || '') + '" title="0.099 = just under 10%">');
    var salRows = '';
    Object.keys(b.salary_overrides || {}).forEach(function (m) { salRows += payRow(m, b.salary_overrides[m], true); });
    h += bsec('Salary overrides') + '<div id="rowsSal">' + salRows + '</div>' +
      '<button type="button" class="addrow" data-add="sal">+ override month</button>';
    var accRows = (b.accounts || []).map(accRow).join('');
    // v72.30 (user: 'add a way to override the current accounts'
    // amount/balances'): the third column is the account's CURRENT balance —
    // a save that moves it files the difference in the Ledger under
    // 'Adjustment' (saveBase → accountBalanceDiffs)
    h += bsec('Accounts (debit, credit)') +
      '<p class="note" style="margin:0 0 6px">name · kind · <b>current balance</b> · limit — set a balance to what it really is; the difference is filed in the Ledger under <b>Adjustment</b></p>' +
      '<div id="rowsAcc">' + accRows + '</div>' +
      '<button type="button" class="addrow" data-add="acc">+ account</button>';
    var budRows = '';
    Object.keys(b.budgets || {}).forEach(function (k) {
      budRows += brow(dragH() + '<input class="grow" data-r="name" value="' + esc(k) + '" autocomplete="off">' +
        '<input data-r="a" type="text" value="' + (Number(b.budgets[k]) || '') + '">' + delBtn('Remove budget')) + detChips('budget:' + k);
    });
    h += bsec('Monthly budgets') + '<div id="rowsBud">' + budRows + '</div>' +
      '<button type="button" class="addrow" data-add="bud">+ budget</button>';
    var bovRows = '';
    Object.keys(b.budget_overrides || {}).forEach(function (m) {
      Object.keys(b.budget_overrides[m] || {}).forEach(function (k) {
        var opts = Object.keys(b.budgets || {}).map(function (bk) {
          return '<option value="' + esc(bk) + '"' + (bk === k ? ' selected' : '') + '>' + esc(bk) + '</option>';
        }).join('') || '<option value="">—</option>';
        bovRows += brow(dragH() + '<input data-r="m" type="month" value="' + esc(m) + '">' +
          '<select data-r="cat">' + opts + '</select>' +
          '<input data-r="a" type="text" value="' + (Number(b.budget_overrides[m][k]) || '') + '">' + delBtn('Remove override'));
      });
    });
    h += bsec('Budget overrides (one month)') + '<div id="rowsBov">' + bovRows + '</div>' +
      '<button type="button" class="addrow" data-add="bov">+ override</button>';
    var debtBlocks = '';
    Object.keys(b.debts || {}).forEach(function (k) {
      var d = Object.assign({ name: k }, b.debts[k]);
      debtBlocks += debtBlock(d);
    });
    h += bsec('Debts') + '<div id="rowsDebt">' + debtBlocks + '</div>' +
      '<button type="button" class="addrow" data-add="debt">+ debt</button>';
    var oneRows = '';
    Object.keys(b.one_offs || {}).forEach(function (m) {
      Object.keys(b.one_offs[m] || {}).forEach(function (k) {
        oneRows += brow(dragH() + '<input data-r="m" type="month" value="' + esc(m) + '">' +
          '<input class="grow" data-r="name" value="' + esc(k) + '" autocomplete="off">' +
          '<input data-r="a" type="text" value="' + (Number(b.one_offs[m][k]) || '') + '">' + delBtn('Remove one-off'));
      });
    });
    h += bsec('One-offs') + '<div id="rowsOne">' + oneRows + '</div>' +
      '<button type="button" class="addrow" data-add="one">+ one-off</button>';
    var sinkBlocks = '';
    Object.keys(b.sinking || {}).forEach(function (k) {
      var s = Object.assign({ name: k }, b.sinking[k]);
      sinkBlocks += sinkBlock(s);
    });
    h += bsec('Sinking funds') + '<div id="rowsSink">' + sinkBlocks + '</div>' +
      '<button type="button" class="addrow" data-add="sink">+ goal</button>';
    // v68 item 1: learned merchant→category map — learned automatically from
    // the ledger; the user can hide (✕) or block (⊘) any entry, both reversible.
    var learned = learnedMerchantCat();
    var mmov = merchantOv();
    var mmNames = Object.keys(learned).sort();
    var mmRows = '';
    mmNames.forEach(function (nm) {
      var e = learned[nm];
      var cls = mmov.blocked[nm] ? ' mm-b' : (mmov.deleted[nm] ? ' mm-d' : '');
      var pill = mmov.blocked[nm] ? ' <span class="pill warn">blocked</span>'
        : (mmov.deleted[nm] ? ' <span class="pill">hidden</span>' : '');
      mmRows += '<div class="brow mmrow' + cls + '">' +
        '<span class="grow bnote mmname" title="' + esc(nm) + '">' + esc(nm) + '</span>' +
        '<b class="mmc">' + esc(e.cat) + '</b>' +
        '<span class="bnote">' + e.n + '×' + pill + '</span>' +
        '<button type="button" class="mini" data-mm="' + esc(nm) + '" data-mmact="block" aria-label="' + (mmov.blocked[nm] ? 'Unblock' : 'Block') + ' auto-category for ' + esc(nm) + '">' + (mmov.blocked[nm] ? '⊘' : '⊘') + '</button>' +
        '<button type="button" class="mini" data-mm="' + esc(nm) + '" data-mmact="delete" aria-label="' + (mmov.deleted[nm] ? 'Show again' : 'Hide') + ' ' + esc(nm) + '">' + (mmov.deleted[nm] ? '↺' : '✕') + '</button>' +
        '</div>';
    });
    h += bsec('Merchant categories (learned from your log)') +
      (mmNames.length
        ? '<div id="rowsMm">' + mmRows + '</div>' +
          '<div class="note">Learned automatically — log <b>jollibee</b> under Food a couple of times and “log 200 jollibee” is filed under Food. ✕ hides an entry, ⊘ blocks it (both come back if you tap again).</div>'
        : '<div class="note">Log a few expenses with a note and a category and I’ll start filing similar ones for you.</div>');
    bb.innerHTML = h;
    renderBaseStatus();
  }
  function readBaseForm() {
    var bb = byId('baseBody');
    if (!bb) return null;
    var b = defaultBase();
    if (state.base) b.migrated_from_snapshot = state.base.migrated_from_snapshot || null;
    if (state.base && state.base.details) b.details = state.base.details; // v56: coach-recorded details survive a form commit
    var gv = function (id) { var el = byId(id); return el ? String(el.value || '') : ''; };
    var isMonth = function (s) { return /^\d{4}-\d{2}$/.test(String(s || '')); };
    b.name = gv('b_name').trim();
    b.as_of = gv('b_asof').trim() || todayISO();
    b.salary = numVal(byId('b_salary'), true);
    b.liquidity_floor = numVal(byId('b_floor'), true);
    var pd = Math.round(numVal(byId('b_pday'), true)); // v71: quick sums here too (10+4 -> 14)
    var cd = Math.round(numVal(byId('b_cday'), true));
    var sd = Math.round(numVal(byId('b_sday'), true)); // v72.45: the salary day (the cycle anchor)
    var dd = Math.round(numVal(byId('b_dday'), true)); // v73.6: the cc due day (the 5th)
    b.prepay_day = pd > 0 ? pd : 14;
    b.cutoff_day = cd > 0 ? cd : 15;
    b.due_day = dd > 0 ? dd : 5;
    b.salary_day = sd > 0 ? sd : (b.cutoff_day || 15);
    var ut = numVal(byId('b_util'), true);
    b.card_util_target = ut > 0 ? ut : 0.099;
    bb.querySelectorAll('#rowsSal .brow').forEach(function (row) {
      var m = row.querySelector('[data-r="m"]'); var a = row.querySelector('[data-r="a"]');
      if (m && a && isMonth(m.value)) b.salary_overrides[m.value] = numVal(a, true);
    });
    bb.querySelectorAll('#rowsAcc .brow').forEach(function (row) {
      var ni = row.querySelector('[data-r="name"]'); var ki = row.querySelector('[data-r="kind"]');
      var vi = row.querySelector('[data-r="value"]'); var li = row.querySelector('[data-r="limit"]');
      var name = ni ? ni.value.trim() : '';
      var kind = ki ? ki.value : 'debit'; // v65
      var value = numVal(vi, true);
      if (!name && !value) return;
      b.accounts.push({ name: name || '(unnamed)', kind: kind, value: value, limit: kind === 'card' ? numVal(li, true) : 0, note: '' });
    });
    bb.querySelectorAll('#rowsBud .brow').forEach(function (row) {
      var ni = row.querySelector('[data-r="name"]'); var ai = row.querySelector('[data-r="a"]');
      var name = ni ? ni.value.trim() : '';
      var amt = numVal(ai, true);
      if (!name && !amt) return;
      b.budgets[name || '(unnamed)'] = amt;
    });
    bb.querySelectorAll('#rowsBov .brow').forEach(function (row) {
      var m = row.querySelector('[data-r="m"]'); var c = row.querySelector('[data-r="cat"]'); var a = row.querySelector('[data-r="a"]');
      if (m && c && a && isMonth(m.value) && c.value) {
        b.budget_overrides[m.value] = b.budget_overrides[m.value] || {};
        b.budget_overrides[m.value][c.value] = numVal(a, true);
      }
    });
    bb.querySelectorAll('#rowsOne .brow').forEach(function (row) {
      var m = row.querySelector('[data-r="m"]'); var ni = row.querySelector('[data-r="name"]'); var a = row.querySelector('[data-r="a"]');
      var name = ni ? ni.value.trim() : '';
      if (m && isMonth(m.value) && (name || numVal(a, true) > 0)) {
        b.one_offs[m.value] = b.one_offs[m.value] || {};
        b.one_offs[m.value][name || '(unnamed)'] = numVal(a, true);
      }
    });
    bb.querySelectorAll('.bblk[data-sec="debt"]').forEach(function (blk) {
      var ni = blk.querySelector('[data-r="name"]');
      var name = ni ? ni.value.trim() : '';
      if (!name) return;
      var d = { monthly: numVal(blk.querySelector('[data-r="monthly"]'), true), active_months: [], payments: {} };
      var act = blk.querySelector('[data-r="active"]');
      if (act) act.value.split(',').forEach(function (s) { s = s.trim(); if (isMonth(s)) d.active_months.push(s); });
      blk.querySelectorAll('[data-r="pays"] .brow').forEach(function (row) {
        var m = row.querySelector('[data-r="m"]'); var a = row.querySelector('[data-r="a"]');
        if (m && a && isMonth(m.value) && numVal(a, true) > 0) d.payments[m.value] = numVal(a, true);
      });
      b.debts[name] = d;
    });
    bb.querySelectorAll('.bblk[data-sec="sink"]').forEach(function (blk) {
      var ni = blk.querySelector('[data-r="name"]');
      var name = ni ? ni.value.trim() : '';
      if (!name) return;
      var dl = blk.querySelector('[data-r="deadline"]');
      var s = { goal: numVal(blk.querySelector('[data-r="goal"]'), true), deadline: dl ? dl.value : '',
        funded: numVal(blk.querySelector('[data-r="funded"]'), true), payments: {} };
      blk.querySelectorAll('[data-r="pays"] .brow').forEach(function (row) {
        var m = row.querySelector('[data-r="m"]'); var a = row.querySelector('[data-r="a"]');
        if (m && a && isMonth(m.value) && numVal(a, true) > 0) s.payments[m.value] = numVal(a, true);
      });
      b.sinking[name] = s;
    });
    return b;
  }
  function addBaseRow(kind) {
    var bb = byId('baseBody');
    if (!bb) return;
    var host = null, html = '';
    if (kind === 'sal') { host = byId('rowsSal'); html = payRow('', ''); }
    else if (kind === 'acc') { host = byId('rowsAcc'); html = accRow({}); }
    else if (kind === 'bud') {
      host = byId('rowsBud');
      html = brow(dragH() + '<input class="grow" data-r="name" autocomplete="off">' +
        '<input data-r="a" type="text">' + delBtn('Remove budget'));
    } else if (kind === 'bov') {
      host = byId('rowsBov');
      var opts = Object.keys((state.base && state.base.budgets) || {}).map(function (k) {
        return '<option value="' + esc(k) + '">' + esc(k) + '</option>';
      }).join('') || '<option value="">—</option>';
      html = brow(dragH() + '<input data-r="m" type="month"><select data-r="cat">' + opts + '</select>' +
        '<input data-r="a" type="text">' + delBtn('Remove override'));
    } else if (kind === 'one') {
      host = byId('rowsOne');
      html = brow(dragH() + '<input data-r="m" type="month"><input class="grow" data-r="name" autocomplete="off">' +
        '<input data-r="a" type="text">' + delBtn('Remove one-off'));
    } else if (kind === 'debt') { host = byId('rowsDebt'); html = debtBlock({}); }
    else if (kind === 'sink') { host = byId('rowsSink'); html = sinkBlock({}); }
    else if (kind === 'dpay') {
      var db = bb.querySelectorAll('.bblk[data-sec="debt"]');
      host = db.length ? db[db.length - 1].querySelector('[data-r="pays"]') : null;
      html = payRow('', '');
    } else if (kind === 'spay') {
      var sb = bb.querySelectorAll('.bblk[data-sec="sink"]');
      host = sb.length ? sb[sb.length - 1].querySelector('[data-r="pays"]') : null;
      html = payRow('', '');
    }
    if (!host) return;
    host.insertAdjacentHTML('beforeend', html);
    markBaseDirty(); // v71: a new row is a change until saved
    var last = host.lastElementChild;
    if (last && last.querySelector) {
      var f = last.querySelector('input');
      if (f) f.focus();
    }
  }
  function commitBaseForm() {
    var nb = readBaseForm();
    if (!nb) return;
    saveBase(nb).then(function () {
      emit('snap');
      renderFooter();
      renderBaseStatus();
      setBaseClean(); // v71: saved -> the Save button goes away again
      var bb = byId('baseBody');
      if (bb) bb.querySelectorAll('#rowsAcc .brow').forEach(function (row) {
        var ki = row.querySelector('[data-r="kind"]'); var li = row.querySelector('[data-r="limit"]');
        if (ki && li) li.disabled = ki.value !== 'card';
      });
    });
  }
  // v71: explicit "Save" for "Your numbers" — no more silent auto-save on every
  // keystroke: edits mark the sheet dirty, a Save button appears, and closing
  // the sheet commits whatever is dirty (no silent loss). Dragging a row
  // (⠿ handle) is a change too, so it lights the same button.
  var baseDirty = false;
  function markBaseDirty() {
    baseDirty = true;
    var bar = byId('baseSaveBar');
    if (bar) bar.style.display = '';
  }
  function setBaseClean() {
    baseDirty = false;
    var bar = byId('baseSaveBar');
    if (bar) bar.style.display = 'none';
    var q = byId('qsBar');
    if (q) q.style.display = 'none';
  }
  function commitIfDirtyBase() {
    if (baseDirty) commitBaseForm();
  }
  // v71: the live quick-sum hint for "Your numbers" (the Add sheet's amtEq,
  // generalized): shows while an amount field holds an expression.
  function qsHint(el) {
    var bar = byId('qsBar');
    if (!bar) return;
    var show = false, txt = '', bad = false;
    if (el && el.tagName === 'INPUT' && el.type === 'text' && el.closest && el.closest('#baseBody')) {
      var raw = String(el.value || '').trim();
      var hasOp = raw.replace(/^[+-]/, '').search(/[+\-*/()×÷]/) >= 0;
      if (raw && hasOp) {
        var v = evalExpr(raw);
        if (v != null) { txt = '= ' + money(v) + '  ·  quick sum'; show = true; }
        else { txt = 'not a valid sum — try 300-125+10'; bad = true; show = true; }
      }
    }
    bar.style.display = show ? '' : 'none';
    if (show) { bar.textContent = txt; bar.className = 'qsbar' + (bad ? ' bad' : ''); }
  }
  // v71: drag-to-reorder in "Your numbers". Pointer-based (touch + mouse) and
  // handle-driven (⠿) so the inputs keep working. The row follows the finger,
  // siblings reflow live, and the drop just marks the sheet dirty — the new
  // order is stored through the normal Save path (readBaseForm reads DOM
  // order, so what you see is what gets saved). Identity and values are
  // untouched: only the node order changes.
  var dragSt = null;
  function layoutTop(el) {
    var t = el.style.transform;
    el.style.transform = 'none';
    var top = el.getBoundingClientRect().top;
    el.style.transform = t;
    return top;
  }
  function baseDragStart(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute || t.getAttribute('data-drag') !== '1') return;
    var row = t.closest ? (t.closest('.bblk') || t.parentElement) : null;
    var container = row && row.parentElement;
    if (!row || !container) return;
    if (ev.cancelable) ev.preventDefault();
    var rect = row.getBoundingClientRect();
    dragSt = { row: row, container: container, offY: ev.clientY - rect.top, h: rect.height, y0: ev.clientY, moved: false };
    row.classList.add('dragging');
    try { t.setPointerCapture(ev.pointerId); } catch (e) {}
  }
  function baseDragMove(ev) {
    if (!dragSt) return;
    ev.preventDefault();
    if (Math.abs(ev.clientY - dragSt.y0) > 3) dragSt.moved = true;
    var top = ev.clientY - dragSt.offY;
    dragSt.row.style.transform = 'translateY(' + (top - layoutTop(dragSt.row)) + 'px)';
    var center = top + dragSt.h / 2;
    var before = null, kids = dragSt.container.children;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c === dragSt.row) continue;
      var cr = c.getBoundingClientRect();
      if (cr.top + cr.height / 2 < center) before = c;
    }
    var next = before ? before.nextSibling : dragSt.container.firstElementChild;
    if (next !== dragSt.row) {
      var oldTop = dragSt.row.getBoundingClientRect().top;
      dragSt.container.insertBefore(dragSt.row, next);
      dragSt.row.style.transform = 'translateY(' + (oldTop - layoutTop(dragSt.row)) + 'px)';
      dragSt.offY = ev.clientY - oldTop;
    }
  }
  function baseDragEnd(ev) {
    if (!dragSt) return;
    var row = dragSt.row, moved = dragSt.moved;
    row.classList.remove('dragging');
    row.style.transform = '';
    try { if (ev.target && ev.target.releasePointerCapture) ev.target.releasePointerCapture(ev.pointerId); } catch (e) {}
    dragSt = null;
    if (moved) markBaseDirty();
  }
  function renderBaseStatus() {
    var el = byId('baseStatus');
    var b = state.base;
    var mg = byId('baseMigrated');
    if (el) {
      if (!b || baseIsEmpty(b)) {
        el.innerHTML = '<span class="pill warn">no numbers yet</span>&nbsp; · everything is stored on this phone';
      } else {
        el.innerHTML = '<span class="pill ok">local</span>&nbsp; · as of ' + esc(fmtDate(b.as_of)) +
          (b.edited ? '&nbsp; · saved ' + new Date(b.edited).toLocaleTimeString() : '');
      }
    }
    if (mg) {
      if (b && b.migrated_from_snapshot) {
        mg.innerHTML = 'Imported from your last sheet snapshot (' + esc(b.migrated_from_snapshot) + ') — review the numbers below; from now on they live only in this app.';
        mg.style.display = '';
      } else mg.style.display = 'none';
    }
    renderSetBaseSum();
  }
  // v47: compact "Your numbers" summary in Settings (the editor is its own sheet now)
  function renderSetBaseSum() {
    var el = byId('setBaseSum');
    if (!el) return;
    var b = state.base;
    if (!b || baseIsEmpty(b)) {
      el.innerHTML = 'Nothing set up yet. Add your accounts, salary, debts and budgets — or build them with the coach.';
      return;
    }
    var nAcc = (b.accounts || []).length;
    var bits = ['As of ' + esc(fmtDate(b.as_of)), nAcc + ' account' + (nAcc === 1 ? '' : 's')];
    if ((Number(b.salary) || 0) > 0) bits.push('salary ' + money(b.salary));
    var nBud = Object.keys(b.budgets || {}).length;
    if (nBud) bits.push(nBud + ' budget' + (nBud === 1 ? '' : 's'));
    var nDebt = Object.keys(b.debts || {}).length;
    if (nDebt) bits.push(nDebt + ' debt' + (nDebt === 1 ? '' : 's'));
    el.innerHTML = bits.join(' · ');
  }
  // ---- render ----
  function tile(k, v, n, cls) {
    return '<div class="tile ' + (cls || '') + '"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div><div class="n">' + esc(n) + '</div></div>';
  }
  function renderSummary() {
    var el = byId('summary'); if (!el) return;
    var s = effectiveSnap();
    if (!s) {
      el.innerHTML = '<div class="card"><p class="note" style="margin:2px 0">' +
        'No numbers yet — add your accounts, salary and debts in <b>Settings (⚙) → Your numbers</b>. You can already log expenses with the + button; they save on this phone.' +
        '</p></div>';
      return;
    }
    var free = s.cash ? s.cash.free : 0;
    var belowFloor = !!(s.cash && s.floor && s.cash.total < s.floor);
    var html = '';
    html += tile('Liquid cash', money(s.cash ? s.cash.total : 0), 'floor ' + money(s.floor || 0), belowFloor ? 'bad' : '');
    var liveMark = adjActive() ? ' · live' : '';
    html += tile('Free / unallocated', money(free), 'card backing' + liveMark, free < 0 ? 'bad' : 'good');
    html += tile('Cards owed', money(s.card_owed), (s.cards || []).length + ' card(s)' + liveMark);
    html += tile(ordinal(s.prepay_day || 14) + ' prepay', money(s.total_prepay), 'cutoff ' + (s.cutoff_day || 15) + ' · due ' + (s.due_day || 5) + liveMark, 'accent');
    el.innerHTML = '<div class="tiles">' + html + '</div>' + adjBar();
    var rb = byId('resetAdj');
    if (rb) rb.onclick = resetAdj;
  }
  function adjBar() {
    if (!adjActive()) return '';
    return '<div class="adjbar"><span class="note">live view: includes ' + money(state.adj.free) + ' recorded in this app</span>' +
      '<button class="mini" id="resetAdj" type="button" title="Stop adjusting and trust the numbers in Settings">reset to my numbers</button></div>';
  }
  function insBlock(title, lines, cls, text) {
    var l = '';
    (lines || []).forEach(function (x) { l += '<div class="ins-line">' + x + '</div>'; });
    var v = text ? '<div class="verdict ' + cls + '">' + esc(text) + '</div>' : '';
    return '<div class="ins-block"><div class="ins-t">' + esc(title) + '</div>' + l + v + '</div>';
  }
  function planWhen(ds) {
    var d = diffDays(todayISO(), ds);
    if (d === 0) return 'Today';
    if (d === 1) return 'Tomorrow';
    if (d > 1 && d < 7) return 'in ' + d + ' days';
    if (d === -1) return 'Yesterday';
    if (d < 0) return 'was ' + (-d) + ' days ago';
    return fmtDate(ds);
  }
  // v72.44 (user: 'should we include the prepay in the ledger summary'): ONE
  // spend rule for every aggregate — the same rule the money-log 's' line has
  // used since v72.10: a card payment is NOT spend (the charge that created
  // the debt already counted; the payoff only settles it — v72.42), a cash
  // inflow nets spend back down. The donut / pace / spent-today / coach note
  // each summed raw amounts, so a prepay showed up as "Unsorted" spend.
  function spendOf(t) {
    var a = Number(t.amount) || 0;
    if (t.kind === 'card_payment') return 0;
    // v73.8: a cash_in is INCOME, not negative spend — it contributes zero to
    // EVERY spend aggregate (the v72.44 rule netted it down, so logging the
    // salary swung "App spend so far" / spent-today / the donut / the chat
    // snapshot by the full salary — the v73.7 fix only covered the money-log
    // s line). monthEffect keeps the narrower rule (refunds still net the
    // ledger line down) for the audit trail.
    if (t.kind === 'cash_in') return 0;
    return a;
  }
  // ---------- v72.45: the salary cycle (the 15th) ----------
  // The salary lands on the salary_day (the 15th by default; older bases
  // without the field fall back to the cutoff day); the cycle runs from that
  // day to the day before the next one. Expected amount = the cycle month's
  // override when it is set above zero (a double-salary month), else the base
  // salary — the sheet's pre-payday zero (its as-of predates the 15th) is NOT
  // "no salary", it is "not received yet as of as-of".
  function salaryDayOf(b) {
    b = b || state.base || {};
    var sd = Math.round(Number(b.salary_day) || 0);
    if (sd >= 1 && sd <= 28) return sd;
    var cd = Math.round(Number(b.cutoff_day) || 0);
    if (cd >= 1 && cd <= 28) return cd;
    return 15;
  }
  function expectedSalaryFor(month, b) {
    b = b || state.base || {};
    var ov = (b.salary_overrides || {})[month];
    if (ov !== undefined && Number(ov) > 0) return r2(Number(ov));
    return r2(Number(b.salary) || 0);
  }
  function cycleWindow(month, sday) {
    var p = String(month).split('-');
    var start = new Date(Number(p[0]), Number(p[1]) - 1, sday);
    var end = new Date(Number(p[0]), Number(p[1]), sday - 1); // next month, sday-1 (sday 1 = the calendar month)
    return {
      month: month,
      start: localISO(start),
      end: localISO(end),
      days: Math.round((end - start) / 86400000) + 1
    };
  }
  function currentCycleMonth(b, todayStr) {
    b = b || state.base || {};
    var sd = salaryDayOf(b);
    var p = parseISO(todayStr || todayISO());
    var startD = new Date(p.getFullYear(), p.getMonth(), sd);
    if (startD > p) startD = new Date(p.getFullYear(), p.getMonth() - 1, sd); // sd <= 28, so no day overflow
    return startD.getFullYear() + '-' + (startD.getMonth() < 9 ? '0' : '') + (startD.getMonth() + 1);
  }
  function cycleDataFor(month, b) {
    b = b || state.base || {};
    var today = todayISO();
    var sd = salaryDayOf(b);
    var w = cycleWindow(month, sd);
    var expected = expectedSalaryFor(month, b);
    // The cycle's salary = a cash_in of at least 90% of the expected amount,
    // dated from the 1st of the cycle month to 2 days past payday: an early
    // payday (landing on the 13th, prior to the 15th) still belongs to the
    // cycle that STARTS on the 15th — and deleting the entry reverts it.
    var lo = month + '-01';
    var mp = String(month).split('-');
    var mDim = new Date(Number(mp[0]), Number(mp[1]), 0).getDate();
    var hiDay = Math.min(sd + 2, mDim);
    var hi = month + '-' + (hiDay < 10 ? '0' : '') + hiDay;
    var received = null;
    state.txns.forEach(function (t) {
      if (t.kind !== 'cash_in') return;
      var amt = Number(t.amount) || 0;
      if (amt <= 0) return;
      if (expected > 0 && amt < 0.9 * expected) return;
      var d = String(t.date || '');
      if (d < lo || d > hi) return;
      if (!received || d < received.date) received = { date: d, amount: r2(amt), id: t.id || null };
    });
    var receivedId = received ? received.id : null;
    // spend this cycle (the one spend rule, v72.44 — prepays are not spend).
    // The cycle's own salary cash_in is excluded from the spend: it is income
    // shown on the Salary line, not negative spend — an early payday (the
    // 13th) sits in the PREVIOUS cycle's window and would sink its spend.
    var spent = 0;
    state.txns.forEach(function (t) {
      if (receivedId && t.id && t.id === receivedId) return;
      var d = String(t.date || '');
      if (d < w.start || d > today) return;
      spent += spendOf(t);
    });
    var startP = parseISO(w.start);
    var todayP = parseISO(today);
    var elapsed = Math.max(1, Math.round((todayP - startP) / 86400000) + 1);
    if (elapsed > w.days) elapsed = w.days;
    var pace = r2(spent / elapsed);
    var projectedNet = r2(expected - pace * w.days);
    // the previous cycle, for the comparison line
    var prevStartD = new Date(startP.getFullYear(), startP.getMonth() - 1, sd);
    var prevM = prevStartD.getFullYear() + '-' + (prevStartD.getMonth() < 9 ? '0' : '') + (prevStartD.getMonth() + 1);
    var prevW = cycleWindow(prevM, sd);
    var prevSpent = 0;
    state.txns.forEach(function (t) {
      if (receivedId && t.id && t.id === receivedId) return; // the salary belongs to THIS cycle
      var d = String(t.date || '');
      if (d < prevW.start || d > prevW.end) return;
      prevSpent += spendOf(t);
    });
    var prevExpected = expectedSalaryFor(prevM, b);
    return {
      month: month, sday: sd, start: w.start, end: w.end, days: w.days,
      expected: expected, received: received,
      spent: r2(spent), elapsed: elapsed, pace: pace, projectedNet: projectedNet,
      prev: { month: prevM, start: prevW.start, end: prevW.end, expected: prevExpected, spent: r2(prevSpent), net: r2(prevExpected - prevSpent) }
    };
  }
  function cycleData() {
    if (!state.base) return null;
    return cycleDataFor(currentCycleMonth(state.base, todayISO()), state.base);
  }
  // ---------- v73.6: the CC due day (the 5th) ----------
  // Boss's model: the bill is DUE on the due_day (the 5th) and equals the
  // spending until the cutoff (the 15th) MINUS the prepays made in that
  // window. So the statement window for the due date on day D of month M is
  // (prevCutoff, cutoffOnOrBeforeD] — charges logged after the previous
  // cutoff up to the cutoff that falls on or before the due date, minus the
  // card_payment (prepay) entries in the same window. Ledger-derived, no new
  // manual fields: the due amount is only as good as the logged charges.
  // Pure (txns + base + today as args) so the smoke drives it with a seeded
  // ledger; absent due_day = 5 (the default), older exports stay valid.
  function ccDueData(txns, b, todayStr) {
    var dd = Math.round(Number(b && b.due_day) || 5);
    if (dd < 1 || dd > 28) dd = 5;
    var cd = Math.round(Number(b && b.cutoff_day) || 15);
    if (cd < 1 || cd > 28) cd = 15;
    var today = String(todayStr || todayISO());
    // Pure string/number date math — NO Date getters: parseISO yields UTC
    // dates and this machine is UTC+8, so local getters would be off by a
    // day (the v73.1 smoke failures are the same trap; the window math must
    // be timezone-proof because it is the due AMOUNT).
    function iso(y, m, day) { return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day; }
    function dim(y, m) { return new Date(y, m, 0).getDate(); } // m = 1..12 (calendar month)
    function addM(y, m, k) { var t = (m - 1 + k) % 12; if (t < 0) t += 12; return { y: y + Math.floor((m - 1 + k) / 12), m: t + 1 }; }
    var tp = today.split('-'), ty = Number(tp[0]), tm = Number(tp[1]), tday = Number(tp[2]);
    // next due date on/after today
    var dueDate = iso(ty, tm, dd);
    if (dueDate < today) { var dn = addM(ty, tm, 1); dueDate = iso(dn.y, dn.m, dd); }
    var dp = dueDate.split('-'), dy = Number(dp[0]), dm = Number(dp[1]), dday = Number(dp[2]);
    var dueIn = Math.round((parseISO(dueDate) - parseISO(today)) / 86400000);
    // the cutoff that falls on or before the due date (the 15th > the 5th,
    // so that is the PREVIOUS month's cutoff; if the due day were after the
    // cutoff it would be the due month's own cutoff)
    var cutoffDate = dday >= cd ? iso(dy, dm, cd) : iso(addM(dy, dm, -1).y, addM(dy, dm, -1).m, cd);
    // the previous cutoff (the window opens just after it): the cutoff month
    // is the due month when dday >= cd, else the previous month — so the
    // previous cutoff is one month before THAT.
    var pc = dday >= cd ? addM(dy, dm, -1) : addM(dy, dm, -2);
    var prevCutoffDate = iso(pc.y, pc.m, cd);
    var charges = 0, prepays = 0, chargeCount = 0, prepayCount = 0;
    (txns || []).forEach(function (t) {
      var d = String(t.date || '');
      if (d <= prevCutoffDate || d > cutoffDate) return;
      var a = Number(t.amount) || 0;
      if (a <= 0) return;
      if (t.kind === 'card_charge') { charges += a; chargeCount++; }
      else if (t.kind === 'card_payment') { prepays += a; prepayCount++; }
    });
    return {
      due_day: dd, cutoff_day: cd,
      dueDate: dueDate, dueIn: dueIn,
      windowStart: prevCutoffDate, windowEnd: cutoffDate,
      charges: r2(charges), prepays: r2(prepays),
      due: r2(Math.max(0, charges - prepays)),
      chargeCount: chargeCount, prepayCount: prepayCount
    };
  }
  function ccDue() {
    if (!state.base) return null;
    return ccDueData(state.txns, state.base, todayISO());
  }
  // v73.2: the MONEY PULSE — last calendar month in deterministic numbers
  // (pure fn: the smoke drives it with a seeded ledger). In = cash_in,
  // out = spend (the v72.44 rule: card_payment is not spend), by-category
  // for the top 3, and a pinned-lesson note (localStorage, keyed by month —
  // "you said you'd cut food delivery" resurfaces next month).
  var LESSON_KEY = 'fin.ai.lesson.v1';
  function readLesson(month) {
    try {
      var all = JSON.parse(localStorage.getItem(LESSON_KEY) || 'null');
      return (all && all[month]) ? String(all[month]) : '';
    } catch (e) { return ''; }
  }
  function pinLesson(month, text) {
    var t = String(text || '').trim().slice(0, 120);
    var all = {};
    try { all = JSON.parse(localStorage.getItem(LESSON_KEY) || '{}') || {}; } catch (e) {}
    if (t) all[month] = t; else delete all[month];
    try { localStorage.setItem(LESSON_KEY, JSON.stringify(all)); } catch (e) {}
    return t;
  }
  function recapData(txns, month, plans) {
    // month = the month being summarized (YYYY-MM); the Home card passes
    // LAST month, the sheet can pass any
    var mp = String(month || '').split('-');
    if (!/^\d{4}$/.test(mp[0]) || !/^\d{2}$/.test(mp[1])) return null;
    var dim = new Date(Number(mp[0]), Number(mp[1]), 0).getDate();
    var from = month + '-01', to = month + '-' + (dim < 10 ? '0' : '') + dim;
    var income = 0, spent = 0, byCat = {};
    (txns || []).forEach(function (t) {
      var d = String(t.date || '');
      if (d < from || d > to) return;
      var a = Number(t.amount) || 0;
      if (t.kind === 'cash_in') { income += a; return; }
      var s = spendOf(t);
      if (s <= 0) return;
      spent += s;
      var c = String(t.category || '').trim() || 'Unsorted';
      byCat[c] = r2((byCat[c] || 0) + s);
    });
    var cats = Object.keys(byCat).map(function (c) { return { cat: c, amt: byCat[c] }; })
      .sort(function (a, b) { return b.amt - a.amt; });
    var top = cats.slice(0, 3);
    var net = r2(income - spent);
    // the coach's one-liner — deterministic, no API
    var line = '';
    if (!income && !spent) line = 'A quiet month — nothing logged.';
    else if (net >= 0) line = 'You kept ' + money(net) + ' this month. ' + (top[0] ? top[0].cat + ' led the spend at ' + money(top[0].amt) + '.' : '');
    else line = 'You spent ' + money(Math.abs(net)) + ' more than you took in. ' + (top[0] ? top[0].cat + ' was the biggest at ' + money(top[0].amt) + ' — worth a look?' : '');
    return { month: month, income: r2(income), spent: r2(spent), net: net, cats: cats, top: top, line: line,
      lesson: readLesson(month) };
  }
  function renderRecap() {
    var el = byId('recap'); if (!el) return;
    var now = new Date();
    var pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var prevM = pm.getFullYear() + '-' + (pm.getMonth() + 1 < 10 ? '0' : '') + (pm.getMonth() + 1);
    var d = recapData(state.txns, prevM);
    if (!d || (!d.income && !d.spent)) { el.style.display = 'none'; return; }
    el.style.display = '';
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var t = byId('recapTitle');
    if (t) t.textContent = M[pm.getMonth()] + ' · recap';
    var tot = Math.max(1, d.income + d.spent);
    var pctIn = Math.round(d.income / tot * 100);
    var html = '<div class="recap-split"><i class="in" style="width:' + pctIn + '%"></i><i class="out" style="width:' + (100 - pctIn) + '%"></i></div>' +
      '<div class="recap-nums"><span>In <b>' + money(d.income) + '</b></span><span>Out <b>' + money(d.spent) + '</b></span><span>Net <b>' + money(d.net) + '</b></span></div>';
    d.top.forEach(function (c) {
      html += '<div class="recap-cat"><span>' + esc(c.cat) + '</span><b>' + money(c.amt) + '</b></div>';
    });
    html += '<p class="recap-line">' + esc(d.line) + '</p>';
    if (d.lesson) html += '<p class="recap-lesson">Last month you said: ' + esc(d.lesson) + '</p>';
    var body = byId('recapBody');
    if (body) body.innerHTML = html;
  }
  function renderDueStrip() {
    var el = byId('dueStrip'); if (!el) return;
    var d = insightsData();
    if (!d) { el.style.display = 'none'; return; }
    var today = d.today;
    var rows = [];
    state.plans.forEach(function (p) {
      planOccurrences(p).forEach(function (od) {
        var dd = diffDays(today, od);
        if (dd >= 0 && dd <= 14) rows.push({ date: od, dd: dd, label: p.name || 'Plan', amt: Number(p.amount) || 0, kind: 'plan' });
      });
    });
    if (d.prepayAmt > 0 && d.prepayIn >= 0 && d.prepayIn <= 14) {
      rows.push({ date: null, dd: d.prepayIn, label: 'Card prepay', amt: d.prepayAmt, kind: 'prepay' });
    }
    // v73.6: the CC DUE (the 5th) — the statement window's charges minus the
    // prepays in it; the due amount is ledger-derived (only as good as the
    // logged charges), so it shows whenever there is a due day and a window
    if (d.ccDue) {
      rows.push({ date: d.ccDue.dueDate, dd: d.ccDue.dueIn, label: 'CC due', amt: d.ccDue.due, kind: 'ccdue' });
    }
    rows.sort(function (a, b) { return a.dd - b.dd; });
    rows = rows.slice(0, 5);
    if (!rows.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    var html = '';
    rows.forEach(function (r) {
      var when = r.dd === 0 ? 'today' : (r.dd === 1 ? 'tomorrow' : 'in ' + r.dd + 'd');
      var whenFull = r.date ? (when + ' · ' + fmtDate(r.date)) : (d.prepayIn === 0 ? 'today' : 'in ' + d.prepayIn + 'd');
      html += '<div class="due-row' + (r.dd <= 2 ? ' soon' : '') + '"><span>' + esc(r.label) +
        ' <span class="due-d">' + whenFull + '</span></span><b>' + money(r.amt) + '</b></div>';
    });
    var body = byId('dueBody');
    if (body) body.innerHTML = html;
  }
  // v73.2: the full recap sheet
  function openRecap() {
    var now = new Date();
    var pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var prevM = pm.getFullYear() + '-' + (pm.getMonth() + 1 < 10 ? '0' : '') + (pm.getMonth() + 1);
    var d = recapData(state.txns, prevM);
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var st = byId('recapSheetTitle');
    if (st) st.textContent = M[pm.getMonth()] + ' · the whole story';
    var body = byId('recapSheetBody');
    if (body) {
      if (!d || (!d.income && !d.spent)) {
        body.innerHTML = '<p class="note" style="margin:2px 0">Nothing was logged in ' + M[pm.getMonth()] + ' — the recap appears once there is a month to tell.</p>';
      } else {
        var tot = Math.max(1, d.income + d.spent);
        var pctIn = Math.round(d.income / tot * 100);
        var html = '<div class="recap-split"><i class="in" style="width:' + pctIn + '%"></i><i class="out" style="width:' + (100 - pctIn) + '%"></i></div>' +
          '<div class="recap-nums"><span>In <b>' + money(d.income) + '</b></span><span>Out <b>' + money(d.spent) + '</b></span><span>Net <b>' + money(d.net) + '</b></span></div>';
        (d.cats.length ? d.cats : d.top).forEach(function (c) {
          html += '<div class="recap-cat"><span>' + esc(c.cat) + '</span><b>' + money(c.amt) + '</b></div>';
        });
        html += '<p class="recap-line">' + esc(d.line) + '</p>';
        if (d.lesson) html += '<p class="recap-lesson">Your pinned lesson: ' + esc(d.lesson) + '</p>';
        body.innerHTML = html;
      }
    }
    var pin = byId('recapPinned');
    if (pin) pin.textContent = d && d.lesson ? ('Pinned for next month: ' + d.lesson) : 'No lesson pinned yet.';
    openSheet('recapSheet');
  }
  // v73.1: the recurring-payment detector, as a PURE fn (the smoke drives it
  // with seeded ledgers). Core (v68): same merchant key + amount (±5% now,
  // was ±10%) in ≥2 different months over the last 3; already-planned is
  // out. New: (1) a txn with no note falls back to its CATEGORY as the
  // merchant key (the note-only rule missed every unlabeled charge); (2)
  // the occurrences' day-gaps decide the suggested cadence — a median gap
  // of 6–8 days reads as WEEKLY, otherwise MONTHLY (the coach row offers
  // the matching plan and the make-plan action carries the repeat).
  function detectRecurring(txns, plans, todayISOStr) {
    var out = [];
    if (!txns || !txns.length) return out;
    var today = String(todayISOStr || todayISO());
    var now = new Date();
    function pk(n) { return (n < 10 ? '0' : '') + n; }
    var mKeys = [];
    for (var q = 1; q <= 3; q++) {
      var dm = new Date(now.getFullYear(), now.getMonth() - q, 1);
      mKeys.push(dm.getFullYear() + '-' + pk(dm.getMonth() + 1));
    }
    var winFrom = mKeys[2];
    var byMer = {};
    txns.forEach(function (t) {
      var mk = String(t.date).slice(0, 7);
      if (mk < winFrom) return;
      var raw = String(t.note || '').trim();
      var nm = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!nm) nm = String(t.category || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); // v73.1: category fallback
      var a = Number(t.amount) || 0;
      if (nm.length < 3 || a <= 0) return;
      var e = (byMer[nm] = byMer[nm] || { months: {}, amts: [], dates: [] });
      e.months[mk] = (e.months[mk] || 0) + 1;
      e.amts.push(a);
      e.dates.push(String(t.date));
    });
    Object.keys(byMer).forEach(function (nm) {
      var e = byMer[nm];
      var months = Object.keys(e.months);
      if (months.length < 2) return;
      var avg = e.amts.reduce(function (s, a) { return s + a; }, 0) / e.amts.length;
      var close = e.amts.filter(function (a) { return a >= avg * 0.95 && a <= avg * 1.05; }).length;
      if (close * 2 < e.amts.length) return; // amounts too inconsistent
      var planned = false;
      (plans || []).forEach(function (p) {
        var pa = Number(p.amount) || 0;
        if (pa < avg * 0.9 || pa > avg * 1.1) return;
        var pw = String(p.name || '').toLowerCase().split(/[^a-z0-9]+/g).filter(function (w) { return w.length >= 3; });
        var mw = nm.split(' ').filter(function (w) { return w.length >= 3; });
        if (pw.some(function (w) { return mw.indexOf(w) >= 0; })) planned = true;
      });
      if (planned) return;
      // v73.1: cadence from the day-gaps (median; weekly when 6–8 days)
      var rep = 'monthly';
      var ds = e.dates.slice().sort();
      if (ds.length >= 3) {
        var gaps = [];
        for (var i = 1; i < ds.length; i++) gaps.push(Math.round((parseISO(ds[i]) - parseISO(ds[i - 1])) / 86400000));
        gaps.sort(function (a, b) { return a - b; });
        var med = gaps[Math.floor(gaps.length / 2)];
        if (med >= 6 && med <= 8) rep = 'weekly';
      }
      out.push({ merchant: nm, amount: Math.round(avg), months: months.length, repeat: rep });
    });
    out.sort(function (a, b) { return b.months - a.months || b.amount - a.amount; });
    return out;
  }
  function insightsData() {
    var s = effectiveSnap();
    if (!s) return null;
    var now = new Date();
    var today = todayISO();
    var monthPrefix = today.slice(0, 7);
    var dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var daysLeft = dim - now.getDate() + 1;
    var meal = mealBudget();
    var free = s.cash ? s.cash.free : 0;
    var todaySpend = 0;
    state.txns.forEach(function (t) { if (t.date === today) todaySpend += spendOf(t); }); // v72.44: prepays are not spend
    var items = [];
    var laterCount = 0, laterAmt = 0;
    state.plans.forEach(function (p) {
      var countedLater = false;
      planOccurrences(p).forEach(function (od) {
        var dd = diffDays(today, od);
        if (dd >= 0 && dd <= 6) items.push({ d: dd, date: od, label: p.name || 'Plan', amt: Number(p.amount) || 0 });
        else if (dd > 6 && !countedLater) { laterCount++; laterAmt += Number(p.amount) || 0; countedLater = true; }
      });
    });
    var prepayDay = Number(s.prepay_day) || 14;
    var pDay = parseISO(today);
    pDay.setDate(prepayDay);
    if (pDay < parseISO(today)) pDay = new Date(now.getFullYear(), now.getMonth() + 1, prepayDay);
    var prepayIn = Math.round((pDay - parseISO(today)) / 86400000);
    var prepayAmt = r2(s.total_prepay || 0);
    if (prepayIn >= 0 && prepayIn <= 6 && prepayAmt > 0) {
      items.push({ d: prepayIn, date: localISO(pDay), label: 'Card prepay (the ' + ordinal(prepayDay) + ')', amt: prepayAmt });
    }
    items.sort(function (a, b) { return a.d - b.d; });
    var weekCost = r2(items.reduce(function (sum, it) { return sum + it.amt; }, 0));
    var monthPlans = 0, monthPlanCount = 0;
    state.plans.forEach(function (p) {
      var occ = planOccurrences(p);
      for (var i = 0; i < occ.length; i++) {
        if (String(occ[i]).slice(0, 7) === monthPrefix) { monthPlans += Number(p.amount) || 0; monthPlanCount++; break; }
      }
    });
    var spentM = 0;
    state.txns.forEach(function (t) { if (String(t.date).slice(0, 7) === monthPrefix) spentM += spendOf(t); }); // v72.44
    var pace = now.getDate() > 0 ? r2(spentM / now.getDate()) : 0;
    // v68 item 4: per-category pace — this month's daily run-rate vs the
    // trailing-3-month daily average; flag >25% above (₱500 noise floor).
    var catPace = [];
    (function () {
      function pk(n) { return (n < 10 ? '0' : '') + n; }
      var mKeys = [], trDays = 0;
      for (var q = 1; q <= 3; q++) {
        var dm2 = new Date(now.getFullYear(), now.getMonth() - q, 1);
        mKeys.push(dm2.getFullYear() + '-' + pk(dm2.getMonth() + 1));
        trDays += new Date(dm2.getFullYear(), dm2.getMonth() + 1, 0).getDate();
      }
      var byNow = {}, byTr = {};
      state.txns.forEach(function (t) {
        var mk = String(t.date).slice(0, 7);
        var a = spendOf(t); // v72.44: the same spend rule as every other aggregate
        var c = String(t.category || '').trim() || 'Unsorted';
        if (mk === monthPrefix) byNow[c] = (byNow[c] || 0) + a;
        else if (mKeys.indexOf(mk) >= 0) byTr[c] = (byTr[c] || 0) + a;
      });
      var elapsed = now.getDate();
      Object.keys(byNow).forEach(function (c) {
        var nowT = byNow[c];
        if (nowT < 500 || elapsed < 3) return;
        var dailyNow = nowT / elapsed;
        var dailyTr = trDays > 0 ? (byTr[c] || 0) / trDays : 0;
        if (dailyTr > 0 && dailyNow > dailyTr * 1.25) {
          catPace.push({ cat: c, now: r2(nowT), dailyNow: r2(dailyNow), dailyTr: r2(dailyTr), over: Math.round((dailyNow / dailyTr - 1) * 100) });
        }
      });
      catPace.sort(function (a, b) { return b.over - a.over; });
    })();
    // v68 item 5: recurring-payment detection — same merchant note + amount
    // (±10%) in ≥2 different months over the last 3; already-planned is out.
    // v73.1: the detector is a PURE exported fn (detectRecurring) — the
    // smoke drives it with seeded ledgers. It keeps the v68 core (same
    // merchant key + amount in ≥2 different months over the last 3,
    // already-planned is out) and grows a brain: (1) a txn with no note
    // falls back to its CATEGORY as the merchant key (the note-only rule
    // missed every unlabeled charge); (2) the amount band tightened to ±5%;
    // (3) the occurrences' day-gaps decide the suggested cadence — a median
    // gap of 6–8 days reads as WEEKLY (the coach row then offers a weekly
    // plan, and the make-plan action carries repeat:'weekly').
    var recurringGuess = detectRecurring(state.txns, state.plans, today);
    // v68 item 6: goal math — sinking funds (required ₱/mo vs planned, months
    // at pace) and debts (months to payoff at the current pace).
    var goals = [];
    Object.keys((state.base && state.base.sinking) || {}).forEach(function (nm) {
      var f = state.base.sinking[nm] || {};
      var goal = Number(f.goal) || 0, funded = Number(f.funded) || 0;
      var dl = String(f.deadline || '').slice(0, 7);
      if (goal <= 0 || funded >= goal || !/^\d{4}-\d{2}$/.test(dl) || dl < monthPrefix) return;
      var pp = dl.split('-'), qq = monthPrefix.split('-');
      var monthsLeft = (Number(pp[0]) - Number(qq[0])) * 12 + (Number(pp[1]) - Number(qq[1]));
      if (monthsLeft < 1) monthsLeft = 1;
      var needed = r2((goal - funded) / monthsLeft);
      var planned = 0;
      var ndg = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      var nextMg = ndg.getFullYear() + '-' + ((ndg.getMonth() + 1) < 10 ? '0' : '') + (ndg.getMonth() + 1);
      Object.keys(f.payments || {}).forEach(function (mk) {
        if (mk >= monthPrefix && mk <= nextMg) planned = Math.max(planned, Number(f.payments[mk]) || 0);
      });
      goals.push({ kind: 'sink', name: nm, goal: goal, funded: funded, deadline: dl, monthsLeft: monthsLeft, needed: needed, planned: planned,
        shortfall: r2(Math.max(0, needed - planned)), monthsAtPace: planned > 0 ? Math.ceil((goal - funded) / planned) : null });
    });
    ((s.obligations && s.obligations.debts) || []).forEach(function (dd) {
      var bal = Number(dd.balance);
      if (bal == null || bal <= 0) return;
      var pay = Number(dd.this_month) || Number(dd.monthly) || 0;
      if (pay <= 0) {
        var lastP = 0;
        (dd.schedule || []).forEach(function (x) { if (String(x.month) <= monthPrefix) lastP = Math.max(lastP, Number(x.amount) || 0); });
        pay = lastP;
      }
      if (pay > 0) goals.push({ kind: 'debt', name: dd.name, balance: bal, pay: pay, monthsToPayoff: Math.ceil(bal / pay) });
    });
    // v68 item 7: the LOWEST projected month of the 6-month matrix
    var lowestDip = null;
    if (state.snapshot && state.snapshot.matrix && state.snapshot.matrix.base) {
      state.snapshot.matrix.base.forEach(function (row) {
        var rv = Number(row.running) || 0;
        if (!lowestDip || rv < lowestDip.v) lowestDip = { v: rv, m: row.month };
      });
    }
    return {
      s: s, now: now, today: today, monthPrefix: monthPrefix, daysLeft: daysLeft,
      meal: meal, free: free,
      daily: daysLeft > 0 ? r2(Math.max(0, free) / daysLeft) : 0,
      todaySpend: r2(todaySpend), items: items,
      prepayDay: prepayDay, prepayIn: prepayIn, prepayAmt: prepayAmt,
      prepayDate: localISO(new Date(now.getFullYear(), now.getMonth(), prepayDay)),
      weekCost: weekCost, laterCount: laterCount, laterAmt: r2(laterAmt),
      monthPlans: r2(monthPlans), monthPlanCount: monthPlanCount,
      spentM: spentM, pace: pace,
      catPace: catPace.slice(0, 5), recurringGuess: recurringGuess.slice(0, 2), // v68 items 4–5
      goals: goals, lowestDip: lowestDip, // v68 items 6–7
      cycle: cycleData(), // v72.45: the salary cycle (the 15th) — hero + insights + coach + snapshot
      ccDue: ccDue(), // v73.6: the cc due (the 5th) — charges since the last cutoff minus the prepays in that window
      freeAfterPace: r2(free - r2(pace * Math.max(0, daysLeft - 1))),
      // v73.11 (user: 'base it per cycle too'): the headroom runs to the CYCLE
      // end (the 14th), not the calendar month end — the money lasts until the
      // next salary, not until the 30th. Falls back to the calendar days when
      // there is no cycle (no base / no salary day).
      cycleDaysLeft: (function () {
        var cd = cycleData();
        if (!cd) return daysLeft;
        var dl = Math.round((parseISO(cd.end) - parseISO(today)) / 86400000) + 1;
        return dl > 0 ? dl : 1;
      })()
    };
  }
  // ---------- Phase 5: unified coach card (narrative + attention rows + one-tap actions) ----------
  // v72.41 (user: 'i wanna prepay maya cc and maribank cc separately'): the Add
  // sheet gains a direction — Spend (the old rules) and Pay card (the payoff).
  // v72.42: a card payment settles the debt — it drops the raw liquid cash and
  // the card owed but leaves free UNTOUCHED (the charge already spent it). It
  // lands on the card's OWN account, so each card can be prepaid separately.
  // The kind decision is a pure exported fn (addSheetKind) so the smoke can
  // drive it — the submit handler itself is DOM-bound in init.
  var addMode = 'spend';
  function addSheetKind(mode, type, editingKind) {
    if (mode === 'prepay') return 'card_payment';
    // v72.45: the "Salary in" check-in is a real cash inflow — v73.8: the
    // visible "Money in" tab (salary / refunds / any inflow) uses the same
    // direction
    if (mode === 'salary' || mode === 'moneyin') return 'cash_in';
    return type === 'CARD'
      ? (editingKind === 'card_payment' ? 'card_payment' : 'card_charge')
      : (editingKind === 'cash_in' ? 'cash_in' : 'cash_out');
  }
  function setAddMode(m) {
    addMode = m === 'prepay' ? 'prepay' : (m === 'salary' || m === 'moneyin' ? 'moneyin' : 'spend'); // v73.8: the visible third direction (the v72.45 'salary' mode is its hidden coach-chip entry — both land on the same tab)
    var sb = byId('addModeSpend'), pb = byId('addModePrepay'), mb = byId('addModeMoneyin');
    if (sb) sb.className = 'amb' + (addMode === 'spend' ? ' on' : '');
    if (pb) pb.className = 'amb' + (addMode === 'prepay' ? ' on' : '');
    if (mb) mb.className = 'amb' + (addMode === 'moneyin' ? ' on' : '');
    var ttl = byId('addSheetTitle'), sub = byId('addSubmit');
    if (ttl) ttl.textContent = addMode === 'prepay' ? 'Card prepay' : (addMode === 'moneyin' ? 'Money in' : 'Add expense');
    if (sub) sub.textContent = addMode === 'prepay' ? 'Add payment' : (addMode === 'moneyin' ? 'Add money in' : 'Add expense');
    var as = byId('f_account');
    if (addMode === 'prepay' && as) {
      // the payoff has to land on a CARD account — preselect the first one
      for (var i = 0; i < as.options.length; i++) {
        if (as.options[i].value.indexOf('CARD::') === 0) { as.value = as.options[i].value; break; }
      }
    } else if (addMode === 'moneyin' && as) {
      // v72.45 / v73.8: money in lands in a CASH account — preselect the first one
      for (var j2 = 0; j2 < as.options.length; j2++) {
        if (as.options[j2].value.indexOf('CASH::') === 0) { as.value = as.options[j2].value; break; }
      }
    }
    updateChargeHint();
  }
  function prefillAdd(amt, dateISO, note, accValue, mode) {
    setAddMode(mode || 'spend');
    var a = byId('f_amount'), dt = byId('f_date'), n = byId('f_note'), as = byId('f_account');
    if (a) a.value = amt != null ? String(amt) : '';
    if (dt && dateISO) dt.value = dateISO;
    if (n && note) n.value = note;
    if (as && accValue) {
      for (var j = 0; j < as.options.length; j++) {
        if (as.options[j].value === accValue) { as.value = accValue; break; }
      }
    }
    openSheet('addSheet');
  }
  function renderCoach() {
    var el = byId('coach'); if (!el) return;
    var d = insightsData();
    if (!d) { el.style.display = 'none'; return; }
    el.style.display = '';
    var name = coachName(d.s);
    var hi = name ? 'Hey ' + name + ' — ' : 'Heads up — ';
    var info = coachRows(d);
    var rows = info.rows;
    // v72.45: the chips key off the REMAINING (info.prepayActive =
    // d.prepayAmt > 0), not "no payment yet" — a partial prepay keeps its
    // per-card buttons, each showing the live amount still owed on that card.
    var prepayActive = info.prepayActive;
    var cls, head, sub;
    var shortfall = r2(d.weekCost - d.free);
    var afterWeek = r2(d.free - d.weekCost);
    var floor = info.floor;
    var due = d.prepayIn === 0 ? 'today' : 'in ' + d.prepayIn + ' day' + (d.prepayIn === 1 ? '' : 's');
    var trim = null;
    d.items.forEach(function (it) {
      if (/card prepay/i.test(it.label)) return;
      if (!trim || it.amt > trim.amt) trim = it;
    });
    if (d.free < 0) {
      cls = 'bad';
      head = hi + 'no room to breathe right now.';
      sub = 'Free cash is ' + money(d.free) + '.' + (prepayActive
        ? ' Skip the treats today and put it toward the ' + money(d.prepayAmt) + ' prepay due on the ' + ordinal(d.prepayDay) + ' (below).'
        : ' Skip the treats today — back the cards first.');
    } else if (prepayActive && d.prepayIn <= 3) {
      cls = d.prepayIn <= 1 ? 'bad' : 'warn';
      head = hi + money(d.prepayAmt) + ' card prepay is due ' + due + ' (the ' + ordinal(d.prepayDay) + ').';
      sub = 'Set aside ' + money(d.prepayIn > 0 ? r2(d.prepayAmt / d.prepayIn) : d.prepayAmt) + '/day to cover it.';
      if (afterWeek < floor) sub += ' Paying it takes cash to ' + money(afterWeek) + ' — under your ' + money(floor) + ' floor' +
        (trim ? '. Biggest lever if you need room: ' + trim.label + ' (' + money(trim.amt) + ').' : '.');
      else sub += ' After it, about ' + money(afterWeek) + ' stays free — safe.';
    } else if (shortfall > 0) {
      cls = 'bad';
      head = hi + 'this week is over budget by ' + money(shortfall) + '.';
      sub = (prepayActive ? 'The card prepay below is the reason: ' : 'This week\'s plans total ') + money(d.weekCost) + ' vs ' + money(d.free) + ' free.';
      if (trim) sub += ' Biggest lever: ' + trim.label + ' (' + money(trim.amt) + ').';
      if (afterWeek < floor) sub += ' As is, cash dips to ' + money(afterWeek) + ' — under your ' + money(floor) + ' floor.';
      else sub += ' Keep today at zero extras and it stays above the floor.';
    } else if (d.freeAfterPace < 0) {
      cls = 'warn';
      head = hi + 'at ' + money(d.pace) + '/day you finish the month ' + money(r2(-d.freeAfterPace)) + ' in the red.';
      sub = 'Easing to about ' + money(d.daily) + '/day from here puts you back on track.';
    } else if (d.daily < d.meal) {
      cls = 'warn';
      head = hi + 'keep today around ' + money(d.daily) + '.';
      sub = 'That is your daily share of the free cash; a ' + money(d.meal) + ' treat would overshoot by ' + money(r2(d.meal - d.daily)) + '.';
    } else {
      cls = 'good';
      head = hi + 'you are on track. You can spend up to ' + money(d.daily) + ' today.';
      sub = 'Next 7 days stay covered; an eat-out (about ' + money(d.meal) + ') is safe.';
    }
    var rec = [];
    state.plans.forEach(function (p) { if (p.repeat) rec.push(p); }); // v73.1: weekly + annual ride the same line
    if (rec.length) {
      var recAmt = rec.reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0);
      var per = rec.every(function (p) { return p.repeat === 'monthly'; }) ? 'a month'
        : rec.every(function (p) { return p.repeat === 'weekly'; }) ? 'a week' : 'each';
      sub += ' On repeat: ' + rec.map(function (p) { return p.name || 'plan'; }).join(', ') + ' — ' + money(recAmt) + ' ' + per + '.';
    }
    // ---- coach memory: compare with the last visit, notice what got handled ----
    var mem = state.coachMem;
    if (mem && mem.d && mem.d !== d.today) {
      var bits = [];
      var dFree = r2(d.free - (Number(mem.free) || 0));
      if (Math.abs(dFree) >= 1) bits.push('free cash ' + (dFree < 0 ? 'fell' : 'rose') + ' ' + money(Math.abs(dFree)));
      var dSpent = r2(d.spentM - (Number(mem.spentM) || 0));
      if (dSpent > 1) bits.push('you logged ' + money(dSpent) + ' in new spending');
      (mem.alerts || []).forEach(function (k) {
        if (info.alerts.indexOf(k) >= 0) return;
        if (k === 'prepay') bits.push(info.prepayPaid ? 'the prepay you handled is off the list' : 'the prepay is past its window');
        else if (k === 'floor') bits.push('the cash floor alert cleared');
        else if (k === 'dip') bits.push('the tight-month flag cleared'); // v68 item 7
        else if (k === 'sink') bits.push('a goal alert cleared'); // v68 item 6
        else if (k.indexOf('recurring:') === 0) bits.push('the recurring suggestion cleared'); // v68 item 5
        else if (k.indexOf('pace:') === 0) bits.push('the ' + k.slice(5) + ' pace flag cleared'); // v68 item 4
      });
      if (bits.length) sub = 'Since your last check: ' + bits.slice(0, 2).join('; ') + '. ' + sub;
      else if (info.alerts.length && (mem.alerts || []).join() === info.alerts.join()) {
        sub = 'Same story as your last check — ' + (info.alerts.indexOf('prepay') >= 0 ? 'the prepay is still the priority. ' : 'the items below are still the priority. ') + sub;
      }
    }
    el.className = 'card coach ' + cls;
    var h = byId('coachHead'), sb = byId('coachSub');
    if (h) h.textContent = head;
    if (sb) sb.textContent = sub;
    // ---- attention rows (same card, no duplicate card) ----
    var body = byId('digBody');
    if (body) {
      var html = '';
      rows.forEach(function (rw) {
        // v68 item 5: the recurring row carries a one-tap "make it a plan"
        // (v73.1: the repeat rides the payload — the detector's cadence)
        if (rw.act === 'make_plan') {
          html += '<button type="button" class="dig warn" data-makeplan="' + esc(rw.payload.name) + '|' + rw.payload.amount + '|' + (rw.payload.repeat || 'monthly') + '">' +
            '<span class="dg-l"><span class="dg-tag">' + esc(rw.tag) + '</span>' + esc(rw.text) + '</span>' +
            '<span class="dg-r">' + esc(rw.r) + '</span></button>';
          return;
        }
        html += '<button type="button" class="dig ' + rw.cls + '" data-digto="money">' +
          '<span class="dg-l"><span class="dg-tag">' + esc(rw.tag) + '</span>' + esc(rw.text) + '</span>' +
          '<span class="dg-r">' + esc(rw.r) + '</span></button>';
      });
      body.innerHTML = html;
      var btns = body.querySelectorAll('[data-digto]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].onclick = function () { setTab(this.getAttribute('data-digto')); };
      }
      var mpb = body.querySelectorAll('[data-makeplan]');
      for (var j = 0; j < mpb.length; j++) {
        mpb[j].onclick = (function (b) {
          return function () {
            var parts = b.getAttribute('data-makeplan').split('|');
            // v73.1: parts[2] is the detector's cadence (monthly | weekly)
            addPlan({ name: parts[0], amount: Number(parts[1]) || 0, date: todayISO(), repeat: parts[2] || 'monthly' });
          };
        })(mpb[j]);
      }
    }
    // ---- one-tap actions ----
    // v72.41 (user: 'i wanna prepay maya cc and maribank cc separately'): one
    // Log-prepay button PER card that is owed above its target — each opens the
    // sheet prefilled with THAT card's amount / date / note / account, in
    // Pay-card mode (kind card_payment, the payoff). The combined button stays
    // only as the no-per-card-breakdown fallback (an old sheet).
    var acts = byId('coachActs');
    if (acts) {
      var ah = '';
      if (prepayActive) {
        var pcards = ((d.s && d.s.cards) || []).filter(function (c) { return (Number(c.prepay) || 0) > 0; });
        pcards.sort(function (a, b) { return (Number(b.prepay) || 0) - (Number(a.prepay) || 0); });
        if (pcards.length) {
          pcards.slice(0, 4).forEach(function (c) {
            ah += '<button type="button" class="cbtn" data-prepaycard="' + esc(c.name) + '">Log prepay · ' + esc(c.name) + ' · ' + money(c.prepay) + '</button>';
          });
        } else {
          ah += '<button type="button" class="cbtn" id="actPrepay">Log prepay ' + money(d.prepayAmt) + '</button>';
        }
      }
      // v72.45: the "Salary in" check-in — the cycle's salary is expected on
      // the salary_day (the 15th); from two days before payday, and while it
      // is still missing, one tap opens the Add sheet prefilled (amount = the
      // expected salary, date = today and editable — backdate it if the money
      // landed early, a CASH account preselected). Logging it is the
      // confirmation: a real cash_in entry the cycle reads back.
      var cy = d.cycle;
      if (cy && cy.expected > 0 && !cy.received) {
        var sdayISO = cy.month + '-' + (cy.sday < 10 ? '0' : '') + cy.sday;
        var sIn = Math.round((parseISO(sdayISO) - parseISO(d.today)) / 86400000);
        if (sIn <= 2) {
          ah += '<button type="button" class="cbtn" id="actSalary">Salary in · ' + money(cy.expected) + '</button>';
        }
      }
      var hasPlanRow = rows.some(function (rw) { return rw.tag === 'Plan due'; });
      if (hasPlanRow) ah += '<button type="button" class="cbtn ghost" id="actPlans">See this week\'s plans</button>';
      acts.innerHTML = ah;
      var pbtns = acts.querySelectorAll ? acts.querySelectorAll('[data-prepaycard]') : [];
      for (var pi = 0; pi < pbtns.length; pi++) {
        pbtns[pi].onclick = (function (b) {
          return function () {
            var nm = b.getAttribute('data-prepaycard');
            var cc = null;
            ((d.s && d.s.cards) || []).forEach(function (c) { if (c.name === nm) cc = c; });
            if (!cc) return;
            prefillAdd(cc.prepay, d.prepayDate, 'Card prepay (the ' + ordinal(d.prepayDay) + ') — ' + cc.name, 'CARD::' + cc.name, 'prepay');
          };
        })(pbtns[pi]);
      }
      var ap = byId('actPrepay');
      if (ap) ap.onclick = function () { prefillAdd(d.prepayAmt, d.prepayDate, 'Card prepay (the ' + ordinal(d.prepayDay) + ')', null, 'prepay'); };
      var asb = byId('actSalary'); // v72.45: the "Salary in" check-in
      if (asb) asb.onclick = function () {
        var cashAcc = 'CASH::Cash';
        ((state.base && state.base.accounts) || []).forEach(function (a) {
          if (a.kind === 'debit' && a.name && cashAcc === 'CASH::Cash') cashAcc = 'CASH::' + a.name;
        });
        prefillAdd(cy.expected, d.today, 'Salary (the ' + ordinal(cy.sday) + ')', cashAcc, 'salary');
      };
      var aa = byId('actPlans');
      if (aa) aa.onclick = function () { setTab('money'); };
    }
    // ---- persist coach memory (only when it changed) ----
    var newMem = { d: d.today, free: r2(d.free), spentM: r2(d.spentM), alerts: info.alerts.slice(0, 5) };
    if (!mem || JSON.stringify(mem) !== JSON.stringify(newMem)) {
      state.coachMem = newMem;
      idbPut(STORE_META, { key: 'coachMem', value: newMem }).catch(function () {});
    }
  }
  function renderInsights() {
    var wrap = byId('insights'), body = byId('insBody');
    if (!wrap || !body) return;
    var mealEl = byId('mealEdit');
    if (mealEl && !mealEl.value) mealEl.value = mealBudget();
    var d = insightsData();
    var he = byId('homeEmpty');
    if (he) he.style.display = d ? 'none' : '';
    if (!d) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var s = d.s, free = d.free, daysLeft = d.daysLeft, meal = d.meal;
    var blocks = '';

    // ---- Today: daily headroom + treat check
    // v73.11 (user: 'base it per cycle too'): the headroom is per CYCLE — the
    // free cash has to last until the NEXT salary (the 14th), not the calendar
    // month end. cycleDaysLeft falls back to the calendar days when there is
    // no cycle, so the old text is the no-cycle case.
    var todaySpend = d.todaySpend;
    var daily = d.daily;
    var hDays = d.cycleDaysLeft || daysLeft;
    var hDaily = hDays > 0 ? r2(Math.max(0, free) / hDays) : 0;
    var cycLbl = d.cycle && d.cycle.end ? ' this cycle (to ' + dayMonth(d.cycle.end) + ')' : '';
    var tLines = ['Headroom: <b>' + money(hDaily) + '/day</b> left across the next ' + hDays + ' day' + (hDays === 1 ? '' : 's') + '.' + cycLbl];
    if (todaySpend > 0) tLines.push('Spent in this app today: <b>' + money(todaySpend) + '</b>.');
    var tCls, tTxt;
    if (free < 0) { tCls = 'bad'; tTxt = 'No room for treats — free cash is negative. Back the cards first.'; }
    else if (hDaily >= meal) { tCls = 'good'; tTxt = 'Eat out OK: a ' + money(meal) + ' treat still leaves you on track (about ' + money(r2(hDaily - meal)) + ' under your daily headroom).'; }
    else if (hDaily > 0) { tCls = 'warn'; tTxt = 'Tight today: only ' + money(hDaily) + '/day left — a ' + money(meal) + ' treat would overshoot by ' + money(r2(meal - hDaily)) + '.'; }
    else { tCls = 'warn'; tTxt = 'Nothing left after this month\'s commitments.'; }
    blocks += insBlock('Today', tLines, tCls, tTxt);

    // ---- Next 7 days: plans + card prepay
    var items = d.items;
    var laterCount = d.laterCount, laterAmt = d.laterAmt;
    var prepayDay = d.prepayDay, prepayIn = d.prepayIn, prepayAmt = d.prepayAmt;
    var weekTotal = d.weekCost;
    var wLines = items.length
      ? items.map(function (it) { return esc(planWhen(it.date)) + ' · ' + esc(it.label) + ' — <b>' + money(it.amt) + '</b>'; })
      : ['Nothing planned for the next 7 days — a quiet stretch.'];
    if (laterCount) wLines.push('Later in the month: ' + laterCount + ' more plan' + (laterCount === 1 ? '' : 's') + ', ' + money(r2(laterAmt)) + ' total.');
    if (prepayIn === 0 && prepayAmt > 0) wLines.push('<b>Prepay day is today</b> — ' + money(prepayAmt) + ' is due before the ' + (s.cutoff_day || 15) + '.');
    else if (prepayIn > 0 && prepayIn <= 7 && prepayAmt > 0) wLines.push('Set aside <b>' + money(r2(prepayAmt / prepayIn)) + '/day</b> until the ' + ordinal(prepayDay) + ' prepay.');
    var wCls, wTxt;
    if (!weekTotal) { wCls = 'good'; wTxt = 'No cost coming up — free cash stays where it is.'; }
    else if (weekTotal <= free) { wCls = 'good'; wTxt = 'Covered: ' + money(r2(free - weekTotal)) + ' left after the next 7 days.'; }
    else { wCls = 'bad'; wTxt = 'Over free cash by ' + money(r2(weekTotal - free)) + ' — trim a plan, or know this dips into the floor.'; }
    blocks += insBlock('Next 7 days', wLines, wCls, wTxt);
    // ---- This salary cycle (the 15th) — v72.45 ----
    var cyc = d.cycle;
    if (cyc && cyc.expected > 0) {
      var cLines = [];
      cLines.push('Cycle: <b>' + dayMonth(cyc.start) + ' – ' + dayMonth(cyc.end) + '</b> — ' + cyc.elapsed + ' of ' + cyc.days + ' days.');
      cLines.push(cyc.received
        ? 'Salary <b>' + money(cyc.received.amount) + '</b> — in on ' + dayMonth(cyc.received.date) + '.'
        : 'Salary <b>' + money(cyc.expected) + '</b> — due on the ' + ordinal(cyc.sday) + '.');
      cLines.push('Spent this cycle: <b>' + money(cyc.spent) + '</b> (' + Math.round((cyc.spent / cyc.expected) * 100) + '% of the salary).');
      if (cyc.elapsed >= 7) cLines.push('At this pace the cycle ends with <b>' + money(cyc.projectedNet) + '</b> of the salary.');
      if (cyc.prev && (cyc.prev.spent > 0 || cyc.prev.expected > 0)) {
        cLines.push('Last cycle (' + dayMonth(cyc.prev.start) + ' – ' + dayMonth(cyc.prev.end) + '): spent <b>' + money(cyc.prev.spent) + '</b>, kept ' + money(cyc.prev.net) + '.');
      }
      var cCls, cTxt;
      if (cyc.elapsed >= 7 && cyc.projectedNet < 0) { cCls = 'bad'; cTxt = 'This pace burns the salary before the cycle ends — slow down or cut a plan.'; }
      else if (cyc.spent > 0.6 * cyc.expected && cyc.elapsed < 0.6 * cyc.days) { cCls = 'warn'; cTxt = 'You are past 60% of the salary with 60% of the cycle still to go — keep the rest lean.'; }
      else { cCls = 'good'; cTxt = 'On pace — the salary covers this cycle at the current spend.'; }
      blocks += insBlock('This cycle', cLines, cCls, cTxt);
    }

    body.innerHTML = blocks;
  }
  function monthBlock(d) {
    var s = d.s;
    var mLines = [];
    mLines.push('Committed on the sheet: <b>' + money(s.committed || 0) + '</b>.');
    var monthPlans = d.monthPlans, monthPlanCount = d.monthPlanCount;
    if (monthPlanCount) mLines.push('Planned here this month: <b>' + money(monthPlans) + '</b> (' + monthPlanCount + ' item' + (monthPlanCount === 1 ? '' : 's') + ').');
    if (s.salary) mLines.push('Salary this cycle: <b>' + money(s.salary) + '</b>.');
    var spentM = d.spentM, pace = d.pace;
    mLines.push('App spend so far: <b>' + money(spentM) + '</b> (about ' + money(pace) + '/day).');
    var freeAfterPace = d.freeAfterPace;
    var mCls, mTxt;
    if (freeAfterPace < 0) { mCls = 'warn'; mTxt = 'At this pace you\'d need ' + money(r2(-freeAfterPace)) + ' more than your free cash — slow down or cut plans.'; }
    else if (monthPlanCount && monthPlans > freeAfterPace) { mCls = 'warn'; mTxt = 'Careful: doing all ' + monthPlanCount + ' planned item' + (monthPlanCount === 1 ? '' : 's') + ' would leave ' + money(r2(freeAfterPace - monthPlans)) + ' free — that\'s under your headroom.'; }
    else { mCls = 'good'; mTxt = 'On track: at this pace about ' + money(freeAfterPace) + ' stays free at month end' + (monthPlanCount ? ', before your ' + monthPlanCount + ' plan' + (monthPlanCount === 1 ? '' : 's') : '') + '.'; }
    return insBlock('This month', mLines, mCls, mTxt);
  }
  function renderProjection() {
    var wrap = byId('projection'), body = byId('projBody');
    if (!wrap || !body) return;
    var d = insightsData();
    if (!d) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    body.innerHTML = '<h2 style="margin-top:0">Projection · ' + esc(monthLabel(d.s.month)) + '</h2>' + monthBlock(d);
  }
  function fmtNum(v) { return Math.round(Number(v) || 0).toLocaleString('en-US'); }
  function renderObligations() {
    var wrap = byId('obligations'), body = byId('obBody');
    if (!wrap || !body) return;
    var s = state.snapshot;
    var ob = s && s.obligations;
    if (!ob) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var month = ob.month || s.month || '';
    var html = '<h2 style="margin-top:0">Obligations · ' + esc(monthLabel(month)) + '</h2>';
    var lines = ob.budget || [];
    if (lines.length) {
      html += '<div class="ins-t" style="margin-top:10px">Monthly fixed</div>';
      lines.forEach(function (l) {
        var amt = Number(l.amount) || 0;
        var tag = l.overridden ? ' · adjusted' : (amt === 0 ? ' · off' : '');
        var norm = Number(l.normal) || 0;
        if (norm > 0 && Math.abs(norm - amt) > 0.004) tag += ' <span style="font-weight:400">(normally ' + money(norm) + ')</span>';
        html += '<div class="kv"><span class="k">' + esc(l.name) + tag + '</span><b>' + money(amt) + '</b></div>';
      });
      html += '<div class="kv" style="font-weight:700"><span class="k">Total · ' + esc(monthLabel(month)) + '</span><b>' + money(ob.budget_total || 0) + '</b></div>';
    }
    var debts = ob.debts || [];
    if (debts.length) {
      html += '<div class="ins-t" style="margin-top:12px">Debt</div>';
      debts.forEach(function (d) {
        var bal = d.balance != null ? ' · ' + fmtNum(d.balance) + ' left' : '';
        var val = Number(d.this_month) > 0 ? money(d.this_month) : '—';
        html += '<div class="kv"><span class="k">' + esc(d.name) + bal + '</span><b>' + val + '</b></div>';
        var parts = [];
        (d.schedule || []).forEach(function (p) { if (p.month > month) parts.push(monthLabel(p.month) + ' ' + fmtNum(p.amount)); });
        if (parts.length) html += '<div class="note" style="margin:0 0 6px;font-size:11.5px">then ' + esc(parts.join(' · ')) + '</div>';
      });
    }
    var oneOffs = (ob.one_offs || []).slice().sort(function (a, b) { return String(a.month) < String(b.month) ? -1 : 1; });
    if (oneOffs.length) {
      html += '<div class="ins-t" style="margin-top:12px">One-offs coming up</div>';
      oneOffs.forEach(function (o) {
        html += '<div class="kv"><span class="k">' + esc(monthLabel(o.month)) + ' · ' + esc(o.name) + '</span><b>' + money(o.amount || 0) + '</b></div>';
      });
    }
    var loans = ob.loans || [];
    if (loans.length) {
      html += '<div class="ins-t" style="margin-top:12px">Loans</div>';
      loans.forEach(function (l) {
        html += '<div class="kv"><span class="k">' + esc(l.name) + (l.note ? ' · ' + esc(l.note) : '') + '</span><b>' + (Number(l.value) > 0 ? money(l.value) : 'cleared') + '</b></div>';
      });
    }
    body.innerHTML = html;
  }
  // ---------- v73.3: gist sync — the crypto + merge, as PURE exported fns ----------
  // The data is encrypted ON THIS PHONE (AES-256-GCM, key = PBKDF2-SHA256
  // (passphrase, random salt, 150k iters)) before it touches the network;
  // GitHub only ever sees the ciphertext file. The envelope:
  //   { v: 1, salt: b64, iv: b64, data: b64 }
  // Merge rule (pull): per record, newest timestamp wins (txn.created,
  // plan.created, owed entry.d, base.edited) — a tie keeps the LOCAL record
  // (the phone in your hand is the source of truth); records only the other
  // side has are added; nothing is silently overwritten.
  var SYNC_KEY = 'fin.sync.v1'; // gist url + token (the passphrase is NEVER stored)
  var SYNC_TOMB_KEY = 'fin.sync.tomb.v1'; // recent deletions { id, at } — so a delete syncs
  var TOMB_CAP = 500;
  function syncTombRead() {
    try { return JSON.parse(localStorage.getItem(SYNC_TOMB_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function syncTombAdd(kind, id) {
    if (!id) return;
    var t = syncTombRead().filter(function (x) { return !(x.k === kind && x.id === id); });
    t.push({ k: kind, id: id, at: new Date().toISOString() });
    try { localStorage.setItem(SYNC_TOMB_KEY, JSON.stringify(t.slice(-TOMB_CAP))); } catch (e) {}
  }
  function syncTombRemove(kind, id) {
    if (!id) return;
    var t = syncTombRead().filter(function (x) { return !(x.k === kind && x.id === id); });
    try { localStorage.setItem(SYNC_TOMB_KEY, JSON.stringify(t)); } catch (e) {}
  }
  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(s) {
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function syncDeriveKey(passphrase, saltBuf) {
    // Node (the smoke) has no WebCrypto — reject cleanly; the real page
    // (secure context) always has it. (window === global in the smoke.)
    if (!window.crypto || !window.crypto.subtle) return Promise.reject(new Error('no WebCrypto'));
    return window.crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
      .then(function (km) {
        return window.crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: saltBuf, iterations: 150000, hash: 'SHA-256' },
          km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }
  function syncEncrypt(obj, passphrase) {
    var salt = window.crypto.getRandomValues(new Uint8Array(16));
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    return syncDeriveKey(passphrase, salt.buffer)
      .then(function (key) {
        return window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key,
          new TextEncoder().encode(JSON.stringify(obj)));
      })
      .then(function (ct) {
        return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(ct) };
      });
  }
  function syncDecrypt(env, passphrase) {
    var salt = new Uint8Array(unb64(env.salt));
    var iv = new Uint8Array(unb64(env.iv));
    return syncDeriveKey(passphrase, salt.buffer)
      .then(function (key) {
        return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, unb64(env.data));
      })
      .then(function (pt) {
        return JSON.parse(new TextDecoder().decode(pt));
      });
  }
  // the merge — pure (the smoke drives it). local/remote = the synced shapes
  // { base, txns, plans, owed, moneyLog, removedTxn, removedPlan }; returns
  // the merged shape. Rule: per record, newest timestamp wins; a TIE keeps
  // LOCAL (the phone in your hand is the source of truth); records only the
  // other side has are added; a record in the other side's removed* tombstone
  // list is dropped (deletions sync, nothing is silently overwritten).
  function syncMerge(local, remote) {
    function ts(v, f) { return (v && v[f]) ? String(v[f]) : ''; }
    function inList(list, id) {
      return (list || []).some(function (x) { return (x && x.id === id) || x === id; });
    }
    function mergeById(arrA, arrB, removedB, field) {
      var out = [];
      (arrA || []).forEach(function (r) {
        if (r && r.id && !inList(removedB, r.id)) out.push(r);
      });
      (arrB || []).forEach(function (r) {
        if (!r || !r.id) return;
        var i = -1;
        for (var j = 0; j < out.length; j++) if (out[j].id === r.id) { i = j; break; }
        if (i < 0) out.push(r); // only the remote has it -> add
        else if (ts(r, field) > ts(out[i], field)) out[i] = r; // remote is newer -> replace
        // tie / local newer -> keep local (the phone in your hand wins)
      });
      return out;
    }
    // moneyLog is the audit trail — rows have no id, so it merges as a whole
    // by its newest row's `at` (the newest-wins rule at the collection level;
    // the trail is append-only, so the newer phone holds the longer one).
    function newestAt(arr) {
      var m = 0;
      (arr || []).forEach(function (r) { if (r && (r.at || 0) > m) m = r.at || 0; });
      return m;
    }
    var lAt = newestAt(local && local.moneyLog), rAt = newestAt(remote && remote.moneyLog);
    var b = (remote && remote.base && ts(remote.base, 'edited') > ts(local && local.base, 'edited'))
      ? remote.base : (local && local.base);
    return {
      base: b,
      txns: mergeById(local && local.txns, remote && remote.txns, remote && remote.removedTxn, 'created'),
      plans: mergeById(local && local.plans, remote && remote.plans, remote && remote.removedPlan, 'created'),
      owed: (remote && remote.owed && ts(remote.owed, 'edited') > ts(local && local.owed, 'edited'))
        ? remote.owed : (local && local.owed || { people: [] }),
      moneyLog: rAt >= lAt ? (remote && remote.moneyLog || []) : (local && local.moneyLog || [])
    };
  }
  // the goal's PACE, as a pure fn (the smoke drives it). The required
  // ₱/month is (goal − funded) / months-left; the current rate is the fund's
  // this-month plan. On pace when the rate covers the requirement; behind
  // by the monthly shortfall. No deadline / already funded = no pace.
  function goalPace(f, month) {
    var goal = Number(f.goal) || 0, funded = Number(f.funded) || 0;
    var dl = String(f.deadline || '').slice(0, 7);
    if (goal <= 0 || funded >= goal || !/^\d{4}-\d{2}$/.test(dl) || !month) return { status: 'none' };
    var pp = dl.split('-'), qq = String(month).split('-');
    var monthsLeft = (Number(pp[0]) - Number(qq[0])) * 12 + (Number(pp[1]) - Number(qq[1]));
    if (monthsLeft < 1) monthsLeft = 1;
    var needed = r2((goal - funded) / monthsLeft);
    var rate = Number(f.this_month) || 0;
    if (rate >= needed - 0.004) return { status: 'on pace', needed: needed, rate: rate, monthsLeft: monthsLeft };
    return { status: 'behind', needed: needed, rate: rate, monthsLeft: monthsLeft, shortfall: r2(needed - rate) };
  }
  function ringSVG(pct) {
    // v73.3: the progress RING (replaces the flat bar) — 44px, 4px stroke
    var R = 16, C = 2 * Math.PI * R;
    var off = C * (1 - Math.min(100, Math.max(0, pct)) / 100);
    return '<svg class="sink-ring" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">' +
      '<circle cx="22" cy="22" r="' + R + '" fill="none" stroke="var(--line)" stroke-width="4"/>' +
      '<circle cx="22" cy="22" r="' + R + '" fill="none" stroke="#37d39b" stroke-width="4" stroke-linecap="round" ' +
      'stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 22 22)"/>' +
      '<text x="22" y="26" text-anchor="middle" font-size="10" font-weight="700" fill="var(--ink)">' + pct + '%</text></svg>';
  }
  function renderSinking() {
    var wrap = byId('sinking'), body = byId('sinkBody');
    if (!wrap || !body) return;
    var s = state.snapshot;
    var funds = s && s.sinking;
    if (!funds || !funds.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var month = s.month || '';
    var html = '<h2 style="margin-top:0">Sinking funds</h2>';
    funds.forEach(function (f) {
      var pct = Number(f.goal) > 0 ? Math.min(100, Math.round((Number(f.funded) || 0) / Number(f.goal) * 100)) : 0;
      var pace = goalPace(f, month); // v73.3: on pace / behind by ₱X
      var paceLine = '';
      if (pace.status === 'on pace') paceLine = '<div class="kv"><span class="k">on pace</span><b style="color:#37d39b">' + money(pace.rate) + '/mo clears it in ' + pace.monthsLeft + ' mo</b></div>';
      else if (pace.status === 'behind') paceLine = '<div class="kv"><span class="k">behind</span><b style="color:var(--bad)">' + money(pace.shortfall) + '/mo short of ' + money(pace.needed) + '</b></div>';
      html += '<div class="ins-block sink-row" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)"><div class="sink-flex">' +
        ringSVG(pct) +
        '<div style="flex:1;min-width:0"><div class="ins-t">' + esc(f.name) +
        ' <span style="color:var(--mut);font-weight:400">· by ' + esc(f.deadline ? fmtDate(f.deadline) : '—') + '</span></div>' +
        '<div class="kv" style="border-top:0"><span class="k">funded ' + pct + '%</span><b>' + money(f.funded || 0) + ' of ' + money(f.goal || 0) + '</b></div>' +
        paceLine + '</div></div>';
      if (Number(f.this_month) > 0) html += '<div class="kv"><span class="k">this month</span><b>' + money(f.this_month) + '</b></div>';
      var parts = [];
      (f.payments || []).forEach(function (p) { parts.push(monthLabel(p.month) + ' ' + fmtNum(p.amount)); });
      if (parts.length) html += '<div class="kv"><span class="k">plan</span><b style="font-weight:600">' + esc(parts.join(' · ')) + '</b></div>';
      html += '</div>';
    });
    body.innerHTML = html;
  }
  // ---------- Phase 3: hero free-cash card + SVG cash sparkline ----------
  var heroVal = null;
  // ---------- v55: the Coach's note (Home Overview) ----------
  // A short read-only AI paragraph about the user's money right now, built
  // from the SAME locally-computed snapshot that feeds the chat coach (chat.js
  // coachSnapshot, via the __financeChat hooks) — one source of numbers. The
  // reply is cached in localStorage keyed by the snapshot fingerprint: zero
  // API calls while the numbers are unchanged. Hidden when there are no
  // numbers yet; when the coach is unreachable the last note is kept with a
  // note, or the card hides. The coach only writes chat text — never data.
  var NOTE_KEY = 'fin.ai.coachnote.v1';
  var noteInFlight = false;
  function readNoteCache() {
    try { return JSON.parse(localStorage.getItem(NOTE_KEY) || 'null'); } catch (e) { return null; }
  }
  function paintCoachNote(el, txt, stale) {
    if (!txt) { el.style.display = 'none'; return; }
    el.style.display = '';
    var body = byId('coachNoteBody');
    if (body) body.textContent = txt;
    // v72.1: the sub line is offline-ONLY — a fresh note shows no sub line at
    // all; when the coach can't be reached, exactly this line:
    var sub = byId('coachNoteSub');
    if (sub) {
      sub.textContent = stale ? 'Coach Fin is unavailable right now.' : '';
      sub.style.display = sub.textContent ? '' : 'none';
    }
  }
  function renderCoachNote() {
    var el = byId('coachNote');
    if (!el) return;
    var FAI = typeof window !== 'undefined' ? window.FinAI : null;
    var chat = typeof window !== 'undefined' ? window.__financeChat : null;
    if (!FAI || typeof FAI.note !== 'function' || !chat || typeof chat.ctx !== 'function' || typeof chat.coachSnapshot !== 'function') {
      el.style.display = 'none';
      return;
    }
    chat.ctx().then(function (ctx) {
      var snap = chat.coachSnapshot(ctx);
      if (!snap.text) { el.style.display = 'none'; return; } // no numbers yet
      var cache = readNoteCache();
      if (cache && cache.fp === snap.fp && cache.txt) { paintCoachNote(el, cache.txt, false); return; }
      if (!FAI.remoteAvailable()) {
        if (cache && cache.txt) paintCoachNote(el, cache.txt, true); // keep the last note
        else el.style.display = 'none';
        return;
      }
      if (noteInFlight) return;
      noteInFlight = true;
      FAI.note(snap.text).then(function (txt) {
        var t = String(txt || '').replace(/^\s+|\s+$/g, '').slice(0, 400);
        if (t) {
          try { localStorage.setItem(NOTE_KEY, JSON.stringify({ fp: snap.fp, txt: t, at: Date.now() })); } catch (e) {}
          paintCoachNote(el, t, false);
        } else if (cache && cache.txt) {
          paintCoachNote(el, cache.txt, true);
        } else {
          el.style.display = 'none';
        }
      })['catch'](function () {
        if (cache && cache.txt) paintCoachNote(el, cache.txt, true);
        else el.style.display = 'none';
      })['then'](function () { noteInFlight = false; });
    })['catch'](function () { el.style.display = 'none'; });
  }

  // ---------- v73.0: Coach Fin's mood — the face IS the status ----------
  // neutral (default) / worried (a card over 70% of its limit, or the
  // current salary cycle projected to end negative) / happy (a brief flash
  // on a good moment — salary logged, card prepaid). The mood groups live
  // INSIDE the #botFace symbol (like the v72.56 SMIL dart): JS flips
  // display on the symbol's light-DOM children and the <use> shadow clones
  // live-sync, so the coach note, chat avatar and FAB all change together.
  var MOOD = 'neutral';
  var moodFlashUntil = 0, moodFlashTimer = null;
  function readUtilMax() {
    var s = effectiveSnap();
    var m = 0;
    (s && s.cards || []).forEach(function (c) {
      var u = Number(c.util_pct);
      if (isFinite(u) && u > m) m = u;
    });
    return m;
  }
  function computeMood() {
    if (Date.now() < moodFlashUntil) return 'happy';
    if (readUtilMax() > 70) return 'worried';
    var c = cycleData();
    if (c && c.projectedNet < 0) return 'worried';
    // v73.6: the cc due is a week out (or closer) and the remaining due
    // (charges minus the prepays already logged) exceeds the free cash
    var du = ccDue();
    if (du && du.dueIn >= 0 && du.dueIn <= 7 && du.due > 0) {
      var s0 = effectiveSnap();
      var f0 = s0 && s0.cash ? s0.cash.free : 0;
      if (du.due > f0) return 'worried';
    }
    return 'neutral';
  }
  function renderMood(force) {
    var m = force || computeMood();
    if (m !== MOOD) {
      MOOD = m;
      var sym = document.querySelector('#botFace');
      if (sym) {
        var w = sym.querySelector('.mood-worried');
        var h = sym.querySelector('.mood-happy');
        // v73.5: flip via style.display, NOT setAttribute('display', ...) —
        // the groups carry an inline style="display:none" and inline styles
        // beat the SVG presentation attribute in the cascade, so the attr
        // flip was a no-op and the moods never rendered (v73.0 bug, caught
        // on the phone: the face stayed neutral forever).
        if (w) w.style.display = m === 'worried' ? '' : 'none';
        if (h) h.style.display = m === 'happy' ? '' : 'none';
      }
    }
    // re-arm the happy reversion: when the flash expires, recompute so the
    // face drops back to its real state without waiting for the next render
    if (m === 'happy') {
      if (moodFlashTimer) clearTimeout(moodFlashTimer);
      moodFlashTimer = setTimeout(function () { moodFlashTimer = null; renderMood(); },
        Math.max(0, moodFlashUntil - Date.now()) + 50);
    }
  }
  function setMood(m) { // smoke-driven: force a mood (no flash expiry)
    renderMood(m === 'worried' ? 'worried' : (m === 'happy' ? 'happy' : 'neutral'));
  }
  function happyMoodFlash(ms) {
    moodFlashUntil = Date.now() + (ms || 1800);
    renderMood();
  }
  function renderHero() {
    var el = byId('hero'); if (!el) return;
    var s = effectiveSnap();
    if (!s) { el.style.display = 'none'; heroVal = null; return; }
    el.style.display = '';
    var free = s.cash ? s.cash.free : 0;
    var hv = byId('heroFree');
    if (hv) {
      hv.className = 'hero-v' + (free < 0 ? ' bad' : '');
      // v73.0: count up from the PREVIOUS value (the hero's own last number,
      // not a fresh-from-zero on every render) — the number moves, it doesn't reload
      countUp(hv, heroVal == null ? free : heroVal, free, function (v) { return money(v); });
    }
    heroVal = free;
    var d = insightsData();
    var sub = [];
    sub.push('Liquid <b>' + money(s.cash ? s.cash.total : 0) + '</b>');
    sub.push('Cards owed <b>' + money(s.card_owed) + '</b>');
    if (d && d.prepayAmt > 0) {
      var pw = d.prepayIn <= 0 ? 'Prepay due today' : 'Prepay in ' + d.prepayIn + ' day' + (d.prepayIn === 1 ? '' : 's');
      sub.push(pw + ' <b>' + money(d.prepayAmt) + '</b>');
    }
    // v72.45: the salary (the 15th) — due / in, on the same line as the rest
    if (d && d.cycle && d.cycle.expected > 0) {
      var cy0 = d.cycle;
      if (cy0.received) {
        sub.push('Salary in · ' + dayMonth(cy0.received.date) + ' <b>' + money(cy0.received.amount) + '</b>');
      } else {
        var payday0 = cy0.month + '-' + (cy0.sday < 10 ? '0' : '') + cy0.sday;
        var dt0 = Math.round((parseISO(payday0) - parseISO(d.today)) / 86400000);
        sub.push('Salary (the ' + ordinal(cy0.sday) + ') <b>' + money(cy0.expected) + '</b> · ' +
          (dt0 === 0 ? 'due today' : dt0 > 0 ? 'in ' + dt0 + ' day' + (dt0 === 1 ? '' : 's') : Math.abs(dt0) + ' day' + (Math.abs(dt0) === 1 ? '' : 's') + ' late'));
      }
    }
    var hs = byId('heroSub');
    if (hs) hs.innerHTML = sub.join(' · ');
    renderSpark();
  }
  function sparkData() {
    var s = state.snapshot;
    if (!s || !s.matrix || !s.matrix.base || !s.matrix.base.length) return null;
    // v72.37: each point carries the real date its value corresponds to
    // (start = as-of date, month points = last day of that month), so the
    // x axis can show real dates at the start / middle / end ticks.
    var monthEnd = function (m) {
      var p = String(m || '').split('-');
      if (p.length === 2 && /^\d{4}$/.test(p[0]) && /^\d{2}$/.test(p[1])) {
        return localISO(new Date(Number(p[0]), Number(p[1]), 0)); // day 0 = last day of the month
      }
      return null;
    };
    var asOf = (state.base && state.base.as_of) || todayISO();
    // v72.45: the current month's EXPECTED salary (the salary_day, the 15th by
    // default) belongs in the projection even when the sheet's model hasn't
    // booked it yet — the as-of predates payday, so the month's salary sits at
    // the pre-payday zero. The month-end / later running values carry the
    // delta (computed locally — the stored matrix is never mutated) and the
    // graph gains one explicit point on the payday, or the actual receipt
    // date once the "Salary in" entry is logged. Other months untouched.
    var bBase = state.base;
    var nowMk = todayISO().slice(0, 7);
    var row0 = s.matrix.base[0];
    var comp0 = (row0 && row0.comp) ? row0.comp : {};
    var salDelta = 0, salDate = null;
    if (bBase && row0 && row0.month === nowMk) {
      salDelta = r2(expectedSalaryFor(nowMk, bBase) - (Number(comp0.salary) || 0));
      if (salDelta > 0.004) {
        var sday0 = salaryDayOf(bBase);
        var paydayISO = nowMk + '-' + (sday0 < 10 ? '0' : '') + sday0;
        var cdat0 = cycleDataFor(nowMk, bBase);
        salDate = (cdat0 && cdat0.received && String(cdat0.received.date).slice(0, 7) === nowMk) ? cdat0.received.date : paydayISO;
        if (salDate < asOf) salDate = null; // the start point already stands after it
      }
    }
    var pts = [{ label: dayMonth(asOf), v: Number(s.matrix.start_cash) || 0, date: asOf }];
    s.matrix.base.forEach(function (row) {
      var rv = Number(row.running) || 0;
      if (salDelta > 0.004 && String(row.month) >= nowMk) rv = r2(rv + salDelta);
      pts.push({ label: monthShort(row.month), v: rv, date: monthEnd(row.month) });
    });
    if (salDate) {
      var mpp = nowMk.split('-');
      var dim0 = new Date(Number(mpp[0]), Number(mpp[1]), 0).getDate();
      var dayNum = Number(salDate.slice(8, 10));
      // even-spend proration (the same assumption as the sheet's month-end
      // roll): the month's outflows so far, then the salary lands
      var vAtSal = r2((Number(s.matrix.start_cash) || 0) - r2(((Number(comp0.outflows) || 0) * (dayNum - 1)) / dim0) + salDelta);
      pts.splice(1, 0, { label: dayMonth(salDate), v: vAtSal, date: salDate });
    }
    var floorLine = Number(s.floor) || 0;
    return { pts: pts, floor: floorLine };
  }
  function renderSpark() {
    var box = byId('sparkBox'); if (!box) return;
    var data = sparkData();
    if (!data) { box.innerHTML = ''; return; }
    var pts = data.pts, floor = data.floor;
    var W = 320, H = 108, PL = 8, PR = 8, PT = 10, PB = 16;
    var vals = pts.map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vals.concat(floor > 0 ? [floor] : []));
    var hi = Math.max.apply(null, vals);
    var pad = Math.max(1, (hi - lo) * 0.1);
    lo -= pad; hi += pad;
    var iw = W - PL - PR, ih = H - PT - PB;
    var X = function (i) { return PL + iw * (i / (pts.length - 1)); };
    var Y = function (v) { return PT + ih * (1 - (v - lo) / (hi - lo)); };
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1); }).join(' ');
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Projected cash for the next six months">' +
      '<path d="' + line + ' L' + X(pts.length - 1).toFixed(1) + ' ' + (H - PB) + ' L' + X(0).toFixed(1) + ' ' + (H - PB) + ' Z" fill="rgba(55,211,155,.13)" stroke="none"/>' +
      '<path d="' + line + '" fill="none" stroke="#37d39b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    if (floor > 0) {
      var fy = Y(floor).toFixed(1);
      svg += '<line x1="' + PL + '" y1="' + fy + '" x2="' + (W - PR) + '" y2="' + fy + '" stroke="#ffc45c" stroke-width="1" stroke-dasharray="4 4" opacity=".8"/>' +
        '<text x="' + (W - PR - 2) + '" y="' + (fy - 3).toFixed(1) + '" text-anchor="end" font-size="8" fill="#ffc45c">floor ' + fmtNum(floor) + '</text>';
    }
    svg += '<circle cx="' + X(0).toFixed(1) + '" cy="' + Y(pts[0].v).toFixed(1) + '" r="3.2" fill="#37d39b" stroke="#0f1420" stroke-width="1.5"/>';
    // v73.0: the TODAY marker — the start point is "now" (asOf) and the rest
    // are month-ends, so today sits ON the first point; mark it with a halo
    // so "where am I" is readable at a glance. (When the as-of predates
    // today, the point IS today's live number — same spot.)
    var t0x = X(0).toFixed(1), t0y = Y(pts[0].v).toFixed(1);
    svg += '<circle class="spark-today" cx="' + t0x + '" cy="' + t0y + '" r="6.5" fill="rgba(55,211,155,.28)" stroke="none"/>';
    // v72.41 (user: 'write the x axis ticks as end of month, e.g. 30 Sep, 31 Oct, etc'):
    // EVERY tick is a date — the month points sit on the last day of their month
    // (the plotted value is that month-end projection), so the axis reads
    // "6 Sep · 30 Sep · 31 Oct · 30 Nov · 31 Dec · 31 Jan · 28 Feb"; p.label
    // (the compact month name) is only the no-date fallback now.
    pts.forEach(function (p, i) {
      var anch = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
      var lab = p.date ? dayMonth(p.date) : p.label;
      svg += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + anch + '" font-size="8" fill="#93a1bd">' + esc(lab) + '</text>';
    });
    box.innerHTML = svg + '</svg>';
  }
  // ---------- Phase 5: attention rows for the unified coach card ----------
  function findPaidTxn(d, kind) {
    var out = null, pSum = 0, pLast = null;
    state.txns.forEach(function (t) {
      var amt = Number(t.amount) || 0;
      var hay = ((t.category || '') + ' ' + (t.note || '')).toLowerCase();
      if (kind === 'prepay') {
        if (String(t.date).slice(0, 7) !== d.monthPrefix) return;
        if (!/prepay|card|amex|visa|master|credit/.test(hay)) return;
        if (amt <= 0) return;
        pSum += amt; pLast = t; // v72.45: PARTIAL prepays count toward "handled so far"
        if (amt >= 0.5 * d.prepayAmt) out = t;
      } else {
        var dd = diffDays(String(t.date), kind.date);
        if (dd < -2 || dd > 2) return;
        var words = String(kind.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 4; });
        if (!words.length || !words.some(function (w) { return hay.indexOf(w) >= 0; })) return;
        var pa = Number(kind.amount) || 0;
        if (amt >= 0.5 * pa && amt <= 2.5 * pa) out = t;
      }
    });
    if (pLast) out = { amount: r2(pSum), date: pLast.date }; // v72.45: the TOTAL logged this month — a partial payment is still a payment
    return out;
  }
  function coachRows(d) {
    var s = d.s, rows = [], alerts = [];
    var prepayActive = d.prepayAmt > 0;
    var prepayPaid = prepayActive ? findPaidTxn(d, 'prepay') : null;
    if (prepayActive) {
      var pw = d.prepayIn === 0 ? 'today' : (d.prepayIn === 1 ? 'tomorrow' : 'in ' + d.prepayIn + ' days');
      if (prepayPaid) {
        // v72.45: a PARTIAL prepay is not "handled" — the per-card chips
        // below stay up with the live remainder, and the 'prepay' alert stays
        // live until the remainder is truly settled (zero).
        rows.push({ cls: 'done', tag: 'Card prepay',
          text: 'Partly handled — ' + money(Number(prepayPaid.amount) || 0) + ' logged on ' + planWhen(String(prepayPaid.date)) + ' — ' + money(d.prepayAmt) + ' still owed.',
          r: money(d.prepayAmt) + ' left' });
      } else {
        rows.push({ cls: d.prepayIn <= 2 ? 'bad' : 'warn', tag: 'Card prepay',
          text: 'Set aside ' + money(d.prepayAmt) + ' for the ' + ordinal(d.prepayDay) + ' prepay — due ' + pw + '.',
          r: money(d.prepayAmt) });
      }
      alerts.push('prepay'); // v72.45: the remainder is still owed, whatever was logged
    }
    // v72.45: the salary-cycle burn — one deterministic finding that rides the
    // shared snapshot (coachFindings -> the coach phrases it). The pace call
    // starts once the cycle has a few days of data (day one is never a pace).
    var cyd = d.cycle;
    if (cyd && cyd.expected > 0 && cyd.spent > 0 && cyd.elapsed >= 7) {
      var cPct = Math.round((cyd.spent / cyd.expected) * 100);
      if (cyd.projectedNet < 0) {
        rows.push({ cls: 'bad', tag: 'Salary cycle',
          text: 'Cycle burn: ' + cPct + '% of the ' + money(cyd.expected) + ' salary after ' + cyd.elapsed + ' of ' + cyd.days + ' days — at this pace the cycle ends ' + money(-cyd.projectedNet) + ' short.',
          r: money(-cyd.projectedNet) + ' short' });
        alerts.push('cycle');
      } else if ((cPct / 100) > (cyd.elapsed / cyd.days) * 1.2) {
        rows.push({ cls: 'warn', tag: 'Salary cycle',
          text: 'Cycle burn: ' + cPct + '% of the salary after ' + cyd.elapsed + ' of ' + cyd.days + ' days — ahead of the pace that keeps the cycle whole.',
          r: cPct + '%' });
      }
    }
    var floor = Number(s.floor) || 0;
    if (floor > 0 && state.snapshot && state.snapshot.matrix && state.snapshot.matrix.base) {
      // v68 item 7: surface the LOWEST projected month — below the floor as a
      // bad row, within 25% above it as a "tightest month" warning.
      var baseDip = null, lowest = null;
      state.snapshot.matrix.base.forEach(function (row) {
        var rv = Number(row.running) || 0;
        if (rv < floor && (!baseDip || rv < baseDip.v)) baseDip = { v: rv, m: row.month };
        if (!lowest || rv < lowest.v) lowest = { v: rv, m: row.month };
      });
      if (baseDip) { rows.push({ cls: 'bad', tag: 'Cash floor',
        text: 'Cash dips to ' + money(baseDip.v) + ' in ' + monthLabel(baseDip.m) + ' — floor is ' + money(floor) + '.',
        r: 'below floor' }); alerts.push('floor'); }
      else if (lowest && lowest.v < floor * 1.25) { rows.push({ cls: 'warn', tag: 'Tightest month',
        text: 'Lowest cash is ' + money(lowest.v) + ' in ' + monthLabel(lowest.m) + ' — close to the ' + money(floor) + ' floor.',
        r: money(lowest.v) }); alerts.push('dip'); }
    }
    var sink = state.snapshot && state.snapshot.sinking;
    var nowM = d.monthPrefix;
    var nd = new Date(d.now.getFullYear(), d.now.getMonth() + 1, 1);
    var nextM = localISO(nd).slice(0, 7);
    if (sink && sink.length) {
      sink.forEach(function (f) {
        var goal = Number(f.goal) || 0, funded = Number(f.funded) || 0;
        if (goal <= 0 || funded >= goal || !f.deadline) return;
        var dl = String(f.deadline).slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(dl) || dl < nowM) return;
        var pp = dl.split('-'), qq = nowM.split('-');
        var monthsLeft = (Number(pp[0]) - Number(qq[0])) * 12 + (Number(pp[1]) - Number(qq[1]));
        if (monthsLeft < 1) monthsLeft = 1;
        var needed = (goal - funded) / monthsLeft;
        var planned = Number(f.this_month) || 0;
        (f.payments || []).forEach(function (x) {
          var pm = String(x.month);
          if (pm >= nowM && pm <= nextM) planned = Math.max(planned, Number(x.amount) || 0);
        });
        if (planned + 0.004 < needed) {
          // v68 item 6: months-to-clear at the current pace + the boost that hits the deadline
          var maS = planned > 0 ? Math.ceil((goal - funded) / planned) : null;
          rows.push({ cls: planned > 0 ? 'warn' : 'bad', tag: 'Sinking behind',
            text: f.name + ' needs about ' + money(needed) + '/month to reach ' + money(goal) + ' by ' + monthLabel(dl) + '; it is on ' + money(planned) + '/month' +
              (maS ? ' — that clears it in ' + maS + ' months, past the deadline' : '') + '. Add ' + money(needed - planned) + ' and it is on time.',
            r: money(needed - planned) + ' short' });
          alerts.push('sink');
        } else if (planned > 0) {
          var maS2 = Math.ceil((goal - funded) / planned);
          if (maS2 <= monthsLeft) {
            rows.push({ cls: 'done', tag: 'Sinking on pace',
              text: f.name + ' is on pace — ' + money(planned) + '/month clears ' + money(goal) + ' in ' + maS2 + ' months.',
              r: 'on pace' });
          }
        }
      });
    }
    // v73.2: the due-day radar's util alert — a card between 30% and 70% of
    // its limit gets a note (over 70% is the coach's WORRIED face, v73.0)
    (d.s.cards || []).forEach(function (c) {
      var u = Number(c.util_pct);
      if (!isFinite(u) || u < 30) return;
      if (u > 70) return; // the mood carries it
      rows.push({ cls: 'warn', tag: 'Card · ' + c.name,
        text: c.name + ' is at ' + Math.round(u) + '% of its limit — the 30% nudge.',
        r: Math.round(u) + '%' });
      alerts.push('util:' + c.name.toLowerCase());
    });
    // v68 item 4: per-category pace anomaly (worst one; the pace section shows up to 3)
    var pcTop = (d.catPace || [])[0];
    if (pcTop && pcTop.over >= 25) {
      rows.push({ cls: 'warn', tag: 'Pace · ' + pcTop.cat,
        text: pcTop.cat + ' is ' + pcTop.over + '% over its usual pace — ' + money(pcTop.dailyNow) + '/day vs ' + money(pcTop.dailyTr) + '.',
        r: money(pcTop.now) });
      alerts.push('pace:' + pcTop.cat.toLowerCase());
    }
    // v68 item 5: recurring-payment suggestion — one-tap "make it a monthly plan"
    var recG = (d.recurringGuess || [])[0];
    if (recG) {
      var recRep = recG.repeat === 'weekly' ? 'weekly' : 'monthly'; // v73.1: the cadence the detector read
      rows.push({ cls: 'warn', tag: 'Looks recurring',
        text: recG.merchant + ' · ' + money(recG.amount) + ' in ' + recG.months + ' recent months — make it a ' + recRep + ' plan?',
        r: 'make it a plan', act: 'make_plan', payload: { name: recG.merchant, amount: recG.amount, repeat: recRep } });
      alerts.push('recurring:' + recG.merchant);
    }
    // v68 item 6: debt payoff at the current pace
    (d.goals || []).forEach(function (g) {
      if (g.kind !== 'debt') return;
      if (g.monthsToPayoff > 12) rows.push({ cls: 'warn', tag: 'Debt · ' + g.name,
        text: g.monthsToPayoff + ' months to clear ' + money(g.balance) + ' at ' + money(g.pay) + '/month.',
        r: g.monthsToPayoff + ' mo' });
    });
    var urgent = [];
    state.plans.forEach(function (p) {
      planOccurrences(p).forEach(function (od) {
        var dd = diffDays(d.today, od);
        if (dd >= 0 && dd <= 7) urgent.push({ p: p, date: od, dd: dd });
      });
    });
    urgent.sort(function (a, b) { return a.dd - b.dd; });
    var shown = 0;
    for (var i = 0; i < urgent.length && shown < 2; i++) {
      var u = urgent[i];
      var paid = findPaidTxn(d, { date: u.date, name: u.p.name, amount: u.p.amount });
      var pw2 = u.dd === 0 ? 'today' : (u.dd === 1 ? 'tomorrow' : 'in ' + u.dd + ' days');
      if (paid) rows.push({ cls: 'done', tag: 'Plan · ' + (u.p.name || 'Plan'),
        text: 'Handled — ' + money(Number(paid.amount) || 0) + ' logged on ' + planWhen(paid.date) + '.',
        r: 'done' });
      else {
        rows.push({ cls: u.dd <= 2 ? 'bad' : 'warn', tag: 'Plan due',
          text: (u.p.name || 'Plan') + ' is due ' + pw2 + '.',
          r: money(u.p.amount) });
        alerts.push('plan:' + (u.p.name || 'Plan'));
        shown++;
      }
    }
    var done = rows.filter(function (r) { return r.cls === 'done'; });
    var act = rows.filter(function (r) { return r.cls !== 'done'; });
    rows = done.slice(0, 2).concat(act.slice(0, 5 - done.slice(0, 2).length));
    return { rows: rows, alerts: alerts, prepayActive: prepayActive, prepayPaid: !!prepayPaid, floor: floor };
  }
  // ---------- Phase 3: category donut + spend pace (Ledger) ----------
  var DONUT_COLORS = ['#37d39b', '#a0d1b4', '#ffc45c', '#ff6b6b', '#b48cff', '#64748b'];
  // v72.52: the cycle window's compact date range ("Sep 15 – Oct 14") under the
  // cycle-based Ledger stats (the donut heading note).
  function cycleLabelFor(w) {
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function lab(iso) { var p = String(iso).split('-'); return M[Number(p[1]) - 1] + ' ' + Number(p[2]); }
    return lab(w.start) + ' – ' + lab(w.end);
  }
  // v72.52 (user: 'the stats in the ledger tab should consolidate records per
  // cycle, not per month'): the bucket is the CURRENT SALARY CYCLE — the v72.45
  // window anchored on the salary_day — not the calendar month. A record dated
  // the 1st lands in the cycle that started on the 15th, and the cycle's own
  // salary cash_in is excluded (it is income, not spend — the v72.45 rule).
  function renderDonut() {
    var wrap = byId('donut'), svgBox = byId('donutSvg'), leg = byId('donutLegend'), rng = byId('donutRange');
    if (!wrap || !svgBox || !leg) return;
    var b = state.base || {};
    var cd = cycleDataFor(currentCycleMonth(b, todayISO()), b);
    var w = { start: cd.start, end: cd.end, month: cd.month };
    var hi = todayISO();
    if (w.end < hi) hi = w.end;
    var totals = {}, grand = 0;
    state.txns.forEach(function (t) {
      var d = String(t.date || '');
      if (d < w.start || d > hi) return; // v72.52: the cycle window, not the calendar month
      if (cd.received && t.id && t.id === cd.received.id) return; // the cycle's salary is income, not spend (the v72.45 rule)
      var a = spendOf(t); // v72.44: prepays are not spend (see the helper)
      if (!a) return; // v72.47: a prepay contributes zero — no phantom "Unsorted ₱0" slice
      var c = t.category || 'Unsorted';
      totals[c] = (totals[c] || 0) + a;
      grand += a;
    });
    if (rng) rng.textContent = cycleLabelFor(w);
    var names = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    if (!names.length || grand <= 0) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var segs = names.slice(0, 5).map(function (n) { return { name: n, v: totals[n] }; });
    var rest = 0;
    names.slice(5).forEach(function (n) { rest += totals[n]; });
    if (rest > 0) segs.push({ name: 'Other', v: rest });
    var R = 40, C = 2 * Math.PI * R, off = 0;
    var svg = '<svg viewBox="0 0 100 100" role="img" aria-label="This cycle by category">' +
      '<circle cx="50" cy="50" r="' + R + '" fill="none" stroke="#2c3a56" stroke-width="12" opacity=".5"/>';
    segs.forEach(function (sg, i) {
      var len = C * (sg.v / grand);
      svg += '<circle cx="50" cy="50" r="' + R + '" fill="none" stroke="' + DONUT_COLORS[i % DONUT_COLORS.length] + '" stroke-width="12" ' +
        'stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" ' +
        'transform="rotate(-90 50 50)" stroke-linecap="butt"/>';
      off += len;
    });
    svg += '<text x="50" y="46" text-anchor="middle" font-size="8" fill="#93a1bd">spent</text>' +
      '<text x="50" y="58" text-anchor="middle" font-size="10.5" font-weight="700" fill="#e8edf7">' + fmtNum(grand) + '</text></svg>';
    svgBox.innerHTML = svg;
    var html = '';
    segs.forEach(function (sg, i) {
      html += '<div class="drow"><span class="sw" style="background:' + DONUT_COLORS[i % DONUT_COLORS.length] + '"></span>' +
        '<span class="nm">' + esc(sg.name) + '</span><b>' + fmtNum(sg.v) + '</b>' +
        '<span class="pc">' + Math.round(sg.v / grand * 100) + '%</span></div>';
    });
    leg.innerHTML = html;
  }
  function renderPace() {
    var wrap = byId('pace'), box = byId('paceBox'), note = byId('paceNote'), rng = byId('paceRange');
    if (!wrap || !box) return;
    // v72.52 (user: 'consolidate records per cycle, not per month'): the bucket is the
    // CURRENT SALARY CYCLE — cycleDataFor already computes spent/elapsed/pace with the
    // cycle's salary cash_in excluded from spend (the v72.45 rule).
    var b = state.base || {};
    var cd = cycleDataFor(currentCycleMonth(b, todayISO()), b);
    var spent = cd.spent, elapsed = cd.elapsed, daily = cd.pace, dim = cd.days;
    var projected = r2(daily * dim);
    if (!spent && !state.txns.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    if (rng) rng.textContent = cycleLabelFor(cd);
    box.innerHTML =
      '<div class="p"><div class="k">Spent · this cycle</div><div class="v">' + money(spent) + '</div></div>' +
      '<div class="p"><div class="k">Avg / day (' + elapsed + ' of ' + dim + 'd)</div><div class="v">' + money(daily) + '</div></div>' +
      '<div class="p"><div class="k">Projected · ' + dim + 'd</div><div class="v">' + money(projected) + '</div></div>';
    if (note) {
      var s = effectiveSnap();
      if (!s) { note.style.display = 'none'; return; }
      var free = s.cash ? s.cash.free : 0;
      note.style.display = '';
      note.innerHTML = projected > free
        ? '<span class="low">At this pace, this cycle\'s spend (' + money(projected) + ') would exceed free cash (' + money(free) + ').</span>'
        : 'Leaves ' + money(r2(free - projected)) + ' of free cash unspent at this pace.';
      // v72.52: the previous-cycle comparison (cycleDataFor already computes it)
      if (cd.prev && cd.prev.spent > 0) {
        var diff = r2(spent - cd.prev.spent);
        note.innerHTML += '<div class="pace-anom"><span' + (diff > 0 ? ' class="low"' : '') + '>' +
          (diff > 0 ? 'Up ' + money(diff) : (diff < 0 ? 'Down ' + money(-diff) : 'Level')) +
          ' vs last cycle (' + money(cd.prev.spent) + ' · ' + esc(cycleLabelFor(cd.prev)) + ').</span></div>';
      }
      // v68 item 4: per-category pace anomalies (still calendar-month — a Home insight)
      var dP = insightsData();
      var anoms = (dP && dP.catPace || []).slice(0, 3);
      if (anoms.length) {
        note.innerHTML += '<div class="pace-anom">' + anoms.map(function (c) {
          return '<span class="low">' + esc(c.cat) + ' is ' + c.over + '% over its usual pace (' + money(c.dailyNow) + '/day vs ' + money(c.dailyTr) + ').</span>';
        }).join(' ') + '</div>';
      }
    }
  }
  function renderAddEmpty() {
    var el = byId('addEmpty');
    if (el) el.style.display = (state.base && !baseIsEmpty(state.base)) ? 'none' : '';
  }
  // v64: same treatment as the v63 categories — the Paid-with options come
  // from "Your numbers" (the card + debit accounts). A plain Cash default is
  // always present and pre-selected; no hardcoded account list, so an empty
  // base shows Cash only. Re-seeds on base change via the snap render list.
  // v65: option labels are the bare account names (no kind suffix).
  function seedAccounts() {
    var sel = byId('f_account');
    if (!sel) return;
    var b = state.base;
    var accounts = (b && b.accounts || [])
      .filter(function (a) { return a.kind === 'card' || a.kind === 'debit'; })
      .map(function (a) { return { name: a.name, type: a.kind === 'card' ? 'card' : 'debit' }; });
    var prev = sel.value;
    var html = '<option value="CASH::Cash" selected>Cash</option>';
    accounts.forEach(function (a) {
      if (a.type === 'debit' && a.name === 'Cash') return; // the default option is already it
      var v = (a.type === 'card' ? 'CARD' : 'CASH') + '::' + a.name;
      html += '<option value="' + esc(v) + '">' + esc(a.name) + '</option>';
    });
    sel.innerHTML = html;
    if (prev) sel.value = prev;
  }
  function renderPlans() {
    var el = byId('plans'); if (!el) return;
    var plans = state.plans.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.created || '') < (b.created || '') ? -1 : 1;
    });
    if (!plans.length) {
      el.innerHTML = '<p class="note" style="margin:2px 0">No plans yet — add one above to see what\'s coming and whether you can afford it.</p>';
      return;
    }
    var html = '';
    plans.forEach(function (p) {
      var amt = money(p.amount).replace('PHP ', '');
      var rec = !!p.repeat; // v73.1: monthly | weekly | annual
      var per = p.repeat === 'weekly' ? 'weekly' : (p.repeat === 'annual' ? 'yearly' : 'monthly');
      var occ = planOccurrences(p);
      occ.forEach(function (od, i) {
        var meta = rec ? fmtDate(od) + ' · ' + per : esc(planWhen(p.date)) + ' · ' + fmtDate(p.date);
        var tag = rec && i === 0 ? ' <span class="pill ok" style="font-size:10px">recurring</span>' : '';
        html += '<div class="txn"><div><div class="txn-cat">' + esc(p.name || 'Plan') + tag + '</div>' +
          '<div class="txn-meta">' + meta + '</div></div>' +
          '<div class="txn-r"><div class="txn-amt">₱ ' + amt + '</div><div class="badgedel">' +
          '<button class="mini" data-delp="' + p.id + '" title="Delete' + (rec ? ' recurring plan' : ' plan') + '">✕</button></div></div></div>';
      });
    });
    el.innerHTML = html;
    var btns = el.querySelectorAll('[data-delp]');
    for (var i = 0; i < btns.length; i++) btns[i].onclick = function () { deletePlan(this.getAttribute('data-delp')); };
  }
  function addPlan(data) {
    var id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    // v73.1: weekly + annual ride the same row (the v68 monthly-only guard
    // dropped in favor of an allow-list — anything else is a one-off)
    var rep = ['monthly', 'weekly', 'annual'].indexOf(data.repeat) >= 0 ? data.repeat : null;
    var p = { id: id, name: data.name, amount: data.amount, date: data.date,
      repeat: rep, created: new Date().toISOString() };
    state.plans.push(p);
    return idbPut(STORE_PLANS, p).then(function () {
      emit('plan');
      snack('Planned ' + esc(p.name) + ' · ' + money(p.amount) + (p.repeat ? ' · every ' + (p.repeat === 'weekly' ? 'week' : (p.repeat === 'annual' ? 'year' : 'month')) : ''), function () {
        state.plans = state.plans.filter(function (x) { return x.id !== id; });
        idbDel(STORE_PLANS, id).then(function () { emit('plan'); });
      });
      return id;
    });
  }
  function deletePlan(id) {
    var p = null;
    for (var i = 0; i < state.plans.length; i++) if (state.plans[i].id === id) p = state.plans[i];
    if (!p) return Promise.resolve();
    state.plans = state.plans.filter(function (x) { return x.id !== id; });
    syncTombAdd('p', id); // v73.3: the deletion syncs (Undo clears the tombstone)
    return idbDel(STORE_PLANS, id).then(function () {
      emit('plan');
      snack('Removed plan ' + esc(p.name), function () {
        syncTombRemove('p', id); // the plan is back — the tombstone goes
        state.plans.push(p);
        idbPut(STORE_PLANS, p).then(function () { emit('plan'); });
      });
    });
  }
  // v23: quick-sums in the Add sheet (the prepay path) - live = total hint
  function addAmtEq(input) {
    var eq = byId('amtEq'); if (!eq) return;
    var raw = String(input.value || '').trim();
    if (!raw) { eq.style.display = 'none'; eq.className = 'amtEq'; return; }
    var v = evalExpr(raw);
    eq.style.display = '';
    if (v === null) { eq.textContent = 'plain number, or a quick sum like 300-125+10'; eq.className = 'amtEq bad'; }
    else if (v <= 0) { eq.textContent = '= ' + money(v) + ' · must be more than 0'; eq.className = 'amtEq bad'; }
    else { eq.textContent = '= ' + money(v); eq.className = 'amtEq'; }
  }
  function updateChargeHint() {
    var el = byId('chargeHint'); if (!el) return;
    // v72.41: the deficit hint is for spends — in Pay-card mode the prepay was
    // already priced into the projection (free − amt would double-count it)
    if (addMode === 'prepay') { el.style.display = 'none'; return; }
    var amtEl = byId('f_amount');
    var amt = amtEl ? evalExpr(amtEl.value) : null;
    if (amt === null) amt = NaN;
    var s = effectiveSnap();
    if (!s || !(amt > 0)) { el.style.display = 'none'; return; }
    var free = s.cash ? s.cash.free : 0;
    var after = r2(free - amt);
    el.style.display = '';
    if (after >= 0) {
      el.className = 'note ok';
      el.innerHTML = 'Backed — about <b>' + money(after) + '</b> stays free after this.';
    } else {
      el.className = 'note low';
      el.innerHTML = '<b>Deficit warning</b> — free cash would drop to ' + money(after) + ' (over by ' + money(r2(-after)) + ').';
    }
  }
  // ---------- Phase 4: export (JSON / CSV) ----------
  // ---------- Owed tracker (v22) — standalone note-keeper, never touches Money math ----------
  // Per person: balance B = sum over entries of sign(dir) * amt.
  // B > 0 → the person owes you; B < 0 → you owe them.
  // "I paid for them" and "I paid them back" both move money out of your
  // pocket (+); "they paid for me" and "they paid me back" both move money
  // to you (−). Settlements therefore reduce the balance automatically.
  var OWED_DIRS = {
    ipf: { label: 'I paid for them', sign: 1 },
    itb: { label: 'I paid them back', sign: 1 },
    tpf: { label: 'They paid for me', sign: -1 },
    tmb: { label: 'They paid me back', sign: -1 }
  };
  function owedSign(dir) { return OWED_DIRS[dir] ? OWED_DIRS[dir].sign : -1; }
  function owedBal(p) {
    var b = 0;
    (p && p.entries || []).forEach(function (e) {
      if (e && e.dir && OWED_DIRS[e.dir]) b += owedSign(e.dir) * (Number(e.amt) || 0);
    });
    return r2(b);
  }
  function saveOwed() { return idbPut(STORE_META, { key: 'owed', value: state.owed }); }
  function emitOwed() { emit('owed'); }
  function owedUid(pref) { return pref + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  // v72.29 (user edit: 'when enrties are more than 5, hide the old ones in a
  // see more'): each card shows the first 5 rows (newest first); the button
  // reveals 5 older ones per tap. In-memory UI state — resets on reload,
  // survives re-renders.
  var owedShown = {};
  function owedBalHTML(b) {
    if (b > 0.004) return '<span class="ow-bal plus">owes you ' + money(b) + '</span>';
    if (b < -0.004) return '<span class="ow-bal minus">you owe ' + money(-b) + '</span>';
    return '<span class="ow-bal zero">settled up</span>';
  }
  // v72.29: the entry form's INNER html — shared by the card-top "+ entry"
  // form and the in-place edit form (user edit: 'i want the edit to expand in
  // position'). edit=true swaps the button row to Save changes + Cancel. The
  // sections follow "What happened" (owedFormSections): ipf = Account + Note;
  // tpf = Category + Note (the ONLY direction that files a txn); itb / tmb =
  // Account only — those three never touch the ledger (their account pick is
  // an informational record). v72.29: Category + Account share one row (the
  // oent-pair grid).
  function oentFormHTML(edit) {
    return '<div class="oent-grid">' +
      '<div><label>Date</label><div class="dfield"><input type="date" class="oent-date">' +
      '<span class="dlabel empty" aria-hidden="true">Pick a date</span></div></div>' +
      // v72.49: on ipf/tpf this label reads Total (the total for both —
      // owedFormSections swaps it at runtime); itb/tmb keep the single Amount
      '<div><label>Amount (\u20b1)</label>' +
      '<input type="text" class="oent-amt" maxlength="40" autocomplete="off">' +
      '<p class="oent-eq" aria-live="polite"></p></div>' +
      '</div>' +
      // v72.49: the mine/theirs split (ipf + tpf only — itb/tmb are single
      // amounts and the row hides). Total is the total for BOTH; a part alone
      // (theirs for ipf, yours for tpf) is the no-split entry — as before.
      '<div class="oent-grid oent-split" style="display:none">' +
      '<div><label>Mine (\u20b1)</label>' +
      '<input type="text" class="oent-mine" maxlength="40" autocomplete="off"></div>' +
      '<div><label>Theirs (\u20b1)</label>' +
      '<input type="text" class="oent-theirs" maxlength="40" autocomplete="off"></div>' +
      '</div>' +
      '<label>What happened</label>' +
      '<div class="seg">' +
      '<label class="sel"><input type="radio" name="owdir" value="ipf" checked><span>I paid for them</span></label>' +
      '<label><input type="radio" name="owdir" value="itb"><span>I paid them back</span></label>' +
      '<label><input type="radio" name="owdir" value="tpf"><span>They paid for me</span></label>' +
      '<label><input type="radio" name="owdir" value="tmb"><span>They paid me back</span></label>' +
      '</div>' +
      '<div class="oent-pair">' +
      '<div class="oent-accrow">' +
      '<label>Account</label>' +
      '<select class="oent-acc">' + owedAccOptions('CASH::Cash') + '</select>' +
      '</div>' +
      '<div class="oent-catrow" style="display:none">' +
      '<label>Category</label>' +
      '<select class="oent-cat">' + owedCatOptions('') + '</select>' +
      '</div>' +
      '</div>' +
      '<div class="oent-noterow">' +
      '<label>Note</label>' +
      '<input type="text" class="oent-note" maxlength="60" autocomplete="off">' +
      '</div>' +
      (edit
        ? '<div class="oent-btns"><button class="act" type="submit">Save changes</button>' +
          // v72.30 (user: 'the cancel button is not working'): the flag carries
          // a value — a valueless attribute reads back as '' (falsy), so the
          // click handler's branch never fired
          '<button class="act ghost" type="button" data-ow-edit-cancel="1">Cancel</button></div>'
        : '<div style="margin-top:14px"><button class="act" type="submit">Add entry</button></div>');
  }
  function owedPersonHTML(p) {
    var b = owedBal(p);
    var ents = (p.entries || []).slice().sort(function (a, c) {
      if (a.d !== c.d) return a.d < c.d ? 1 : -1;
      return (a.created || '') < (c.created || '') ? 1 : -1;
    });
    // v72.29 (user edit): the first 5 rows show — the older ones wait behind
    // "See more" (5 per tap)
    var limit = owedShown[p.id] || 5;
    var shownEnts = ents.slice(0, limit);
    var rows = '';
    shownEnts.forEach(function (e) {
      var dir = OWED_DIRS[e.dir] || OWED_DIRS.ipf;
      var amt = Number(e.amt) || 0;
      // v72.49: the split hint — the filed part (ipf) / theirs (tpf) + the
      // total for both, when the entry was split
      var hint = '';
      // v72.51: a PRE-FIX T+Th entry stored total + amt(theirs) with no mine
      // - derive yours = total - amt so the hint reads right (edits keep it)
      var ipfMine = Number(e.mine) || (e.dir === 'ipf' && e.total && Number(e.total) > (Number(e.amt) || 0) ? r2(e.total - (Number(e.amt) || 0)) : 0);
      if (e.dir === 'ipf' && ipfMine > 0) hint = ' · ' + money(ipfMine) + ' mine';
      if (e.dir === 'tpf' && e.theirs) hint = ' · ' + money(e.theirs) + ' theirs';
      if (e.total) hint += ' · ' + money(e.total) + ' total';
      rows += '<div class="ow-e">' +
        '<div class="ow-el"><b>' + esc(dir.label) + '</b>' +
        (e.note ? ' <span class="ow-x">' + esc(e.note) + '</span>' : '') +
        // v72.10: a ledger-filed entry wears the chip (v72.29: the edit
        // button is on EVERY entry — the legacy ones included)
        (e.txnId ? ' <span class="ow-led" title="Filed in the ledger — the entry moves your numbers">· ledger</span>' : '') +
        '<div class="ow-k">' + esc(fmtDate(e.d)) + (e.expr ? ' · ' + esc(e.expr) : '') + hint + '</div></div>' +
        '<b class="ow-amt ' + (dir.sign > 0 ? 'plus' : 'minus') + '">' + (dir.sign > 0 ? '+' : '\u2212') + money(amt) + '</b>' +
        '<button type="button" class="ow-xbtn wide" data-ow-edit-e="' + esc(e.id) + '" aria-label="Edit entry">edit</button>' +
        '<button type="button" class="ow-xbtn" data-ow-del-e="' + esc(e.id) + '" aria-label="Remove entry">\u2715</button>' +
        '</div>';
    });
    // v72.30 (user edit: 'see less beside see more'): the buttons share one
    // row — See more reveals 5 older, See less re-hides 5 per tap down to the
    // first page of 5 (it hides itself there)
    if (ents.length > shownEnts.length || limit > 5) {
      rows += '<div class="ow-pag">' +
        (ents.length > shownEnts.length ? '<button type="button" class="addrow" data-ow-more="' + esc(p.id) + '">See more</button>' : '') +
        (limit > 5 ? '<button type="button" class="addrow" data-ow-less="' + esc(p.id) + '">See less</button>' : '') +
        '</div>';
    }
    return '<section class="card ow-p" data-ow-pid="' + esc(p.id) + '">' +
      '<div class="ow-h"><span class="bdrag" data-ow-drag="1" aria-label="Drag to reorder" title="Drag to reorder">\u287F</span><b class="ow-name" data-ow-name="' + esc(p.id) + '" title="Rename">' + esc(p.name) + '</b>' + owedBalHTML(b) +
      // v72.48: one statement of account per person — the SOA (PDF) button
      // exports this person's full account (every entry, running balance,
      // closing direction) as a PDF file
      '<button type="button" class="ow-xbtn wide" data-ow-soa="' + esc(p.id) + '" title="Statement of account (PDF)">SOA (PDF)</button>' +
      '<button type="button" class="sheet-x" data-ow-del="' + esc(p.id) + '" aria-label="Remove person">\u2715</button></div>' +
      // v72.19: "+ entry" (and its hidden form) sits at the TOP of the card —
      // right under the header, above the entry list (user request); an opened
      // form expands next to its button and pushes the list down
      '<button type="button" class="addrow" data-ow-toggle="' + esc(p.id) + '">+ entry</button>' +
      '<form class="oent" data-ow-for="' + esc(p.id) + '" style="display:none" autocomplete="off">' +
      oentFormHTML() +
      '</form>' +
      (rows || '<p class="note" style="margin:8px 0 0">No entries yet — add the first one above.</p>') +
      '</section>';
  }
  // v72.7: person order — A–Z / recent / custom (drag). Default = recent:
  // the last time anything on the card changed (p.updated; a person's newest
  // entry as fallback).
  function owedRecent(p) {
    var t = p && p.updated ? Date.parse(p.updated) || 0 : 0;
    (p && p.entries || []).forEach(function (e) {
      if (e && e.created) { var c = Date.parse(e.created) || 0; if (c > t) t = c; }
    });
    return t;
  }
  function owedSortedPeople() {
    var people = (state.owed.people || []).slice();
    var sort = state.owed.sort || 'recent';
    if (sort === 'az') {
      people.sort(function (a, b) {
        return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1;
      });
    } else if (sort === 'recent') {
      people.sort(function (a, b) { return owedRecent(b) - owedRecent(a); });
    }
    return people; // 'custom' = the stored (dragged) order
  }
  function renderOwed() {
    var body = byId('owedBody'); if (!body) return;
    var sum = byId('owedSum');
    var people = owedSortedPeople();
    var ssel = byId('owedSort'); // v72.7: keep the control in sync (drag -> custom)
    if (ssel && ssel.value !== (state.owed.sort || 'recent')) ssel.value = state.owed.sort || 'recent';
    if (sum) {
      if (!people.length) {
        sum.style.display = 'none';
      } else {
        sum.style.display = '';
        var inT = 0, outT = 0;
        people.forEach(function (p) {
          var b = owedBal(p);
          if (b > 0) inT += b; else if (b < 0) outT -= b;
        });
        var net = r2(inT - outT);
        byId('owedSumIn').textContent = money(r2(inT));
        byId('owedSumOut').textContent = money(r2(outT));
        var netEl = byId('owedSumNet');
        netEl.textContent = (net > 0.004 ? '+' : net < -0.004 ? '\u2212' : '') + money(Math.abs(net));
        netEl.className = net > 0.004 ? 'pos' : net < -0.004 ? 'neg' : '';
      }
    }
    if (!people.length) {
      body.innerHTML = '<div class="card"><p class="note" style="margin:2px 0">No one in the book yet. Add a person above, then tap <b>+ entry</b> on their card each time you pay for them — or they pay for you.</p></div>';
      return;
    }
    var html = '';
    people.forEach(function (p) { html += owedPersonHTML(p); });
    body.innerHTML = html;
    // v72.49: the card-top forms start on the default direction (ipf) — the
    // Total label, the split row and the Category section follow the pick
    var oentFs = body.querySelectorAll('.oent');
    for (var ofi = 0; ofi < oentFs.length; ofi++) owedFormSections(oentFs[ofi], 'ipf');
  }
  // ---------- v72.10→v72.28→v72.49: the owed ledger rule ----------
  // The ledger records CONSUMPTION, not loans. v72.28: only tpf filed (the
  // whole entry: Cash, the picked category). v72.49 (the split): YOURS is
  // what files — ipf on the picked account (Cash by default; a card files
  // as card_charge, the Add-sheet rule), tpf on Cash as before — while the
  // owed entry records the debt side (ipf = theirs, tpf = yours). The
  // Account section (user edit 21:2x: "dont drop it anymore") stays on
  // ipf/itb/tmb; for ipf it is now the account the filed part leaves. The
  // owed BALANCE always comes from the entry records.
  function owedAccOptions(sel) {
    var accounts = ((state.base && state.base.accounts) || [])
      .filter(function (a) { return a.kind === 'card' || a.kind === 'debit'; });
    // v72.49: the "no account" option is GONE — Cash is always the default,
    // so the ipf "mine" part always has an account to file on.
    var html = '<option value="CASH::Cash"' + (sel === 'CASH::Cash' ? ' selected' : '') + '>Cash</option>';
    accounts.forEach(function (a) {
      if (a.kind === 'debit' && a.name === 'Cash') return; // the default option is already it
      var v = (a.kind === 'card' ? 'CARD' : 'CASH') + '::' + a.name;
      html += '<option value="' + esc(v) + '"' + (sel === v ? ' selected' : '') + '>' + esc(a.name) + '</option>';
    });
    return html;
  }
  // v72.25→v72.29: the entry's CATEGORY options — Your numbers' budgets
  // (the same list the add sheet uses) plus 'Unsorted', which is ALWAYS in
  // the list (v72.29 user edit: it must not disappear when the budgets
  // change). A saved category that has left Your numbers is appended so it
  // stays selectable when the entry is re-opened for editing. The owed
  // BALANCE never depends on this — it always comes from the entry records;
  // only the ledger txn's filing category changes.
  function owedCatOptions(sel) {
    var d = String(sel || '').trim();
    var names = Object.keys((state.base && state.base.budgets) || {})
      .filter(function (n) { return String(n).trim() && n !== 'Unsorted'; });
    var list = names.slice();
    if (list.indexOf('Unsorted') < 0) list.push('Unsorted'); // v72.29: always present
    if (d && list.indexOf(d) < 0) list.push(d); // a stale saved category stays selectable
    if (!d || list.indexOf(d) < 0) d = list[0];
    var html = '';
    list.forEach(function (c) {
      html += '<option value="' + esc(c) + '"' + (c === d ? ' selected' : '') + '>' + esc(c) + '</option>';
    });
    return html;
  }
  // v72.28 (follow-ups + user edit): which form sections "What happened"
  // shows: ipf = Account + Note; tpf = Category + Note (Cash-implicit);
  // itb / tmb = Account only. v72.49: the split row (Mine + Theirs) shows
  // for ipf/tpf, the amount label reads Total (the total for both) there,
  // and Category shows for ipf too (the filed "mine" part lands in it).
  function owedFormSections(form, dir) {
    if (!form || !form.querySelector) return;
    var a = form.querySelector('.oent-accrow');
    if (a) a.style.display = dir === 'tpf' ? 'none' : '';
    var c = form.querySelector('.oent-catrow');
    if (c) c.style.display = (dir === 'tpf' || dir === 'ipf') ? '' : 'none';
    var n = form.querySelector('.oent-noterow');
    if (n) n.style.display = (dir === 'ipf' || dir === 'tpf') ? '' : 'none';
    var s = form.querySelector('.oent-split'); // v72.49: the mine/theirs split row
    if (s) {
      s.style.display = (dir === 'ipf' || dir === 'tpf') ? '' : 'none';
      if (s.style.display === 'none') { // itb/tmb: no split — stale parts would be silent
        var sm = form.querySelector('.oent-mine'); if (sm) sm.value = '';
        var st = form.querySelector('.oent-theirs'); if (st) st.value = '';
      }
    }
    var amtEl = form.querySelector('.oent-amt'); // v72.49: Total (both) vs Amount
    amtEl = amtEl && amtEl.parentElement ? amtEl.parentElement.querySelector('label') : null;
    if (amtEl) amtEl.textContent = (dir === 'ipf' || dir === 'tpf') ? 'Total (\u20b1)' : 'Amount (\u20b1)';
  }
  // v72.10: back to a fresh, hidden add form (after a submit or edit save).
  function resetOentForm(f) {
    if (!f) return;
    f.removeAttribute('data-ow-edit');
    var d = f.querySelector('.oent-date');
    if (d) { d.value = ''; owedSyncDate(d); }
    var a = f.querySelector('.oent-amt');
    if (a) a.value = '';
    var m2 = f.querySelector('.oent-mine'); // v72.49: the split parts go too
    if (m2) m2.value = '';
    var th2 = f.querySelector('.oent-theirs');
    if (th2) th2.value = '';
    var eq = f.querySelector('.oent-eq');
    if (eq) { eq.textContent = ''; eq.className = 'oent-eq'; }
    var n = f.querySelector('.oent-note');
    if (n) n.value = '';
    var s = f.querySelector('.oent-acc');
    if (s) s.value = 'CASH::Cash';
    var c = f.querySelector('.oent-cat'); // v72.28: back to the budget default
    if (c) c.innerHTML = owedCatOptions('');
    var radios = f.querySelectorAll('input[name="owdir"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === 'ipf';
    var seg = f.querySelector('.seg');
    if (seg) {
      var labs = seg.getElementsByTagName('label');
      for (var j = 0; j < labs.length; j++) {
        var inp = labs[j].getElementsByTagName('input')[0];
        labs[j].className = inp && inp.checked ? 'sel' : '';
      }
    }
    owedFormSections(f, 'ipf');
    var sb = f.querySelector('[type="submit"]');
    if (sb) sb.textContent = 'Add entry';
    f.style.display = 'none';
  }
  // no-snack txn removal / restore — the owed flow shows ONE toast that covers
  // both the entry and its ledger row.
  function removeTxnQuiet(tid) {
    var r = removeTxnRow(tid);
    if (!r) return Promise.resolve();
    return r.persist.then(function () { emit('txn'); });
  }
  function restoreTxnQuiet(t) {
    state.txns.push(t);
    addAdj(txnAdj(t), 1);
    logMoney('add', t);
    return Promise.all([idbPut(STORE_TX, t), saveAdj()]).then(function () { emit('txn'); });
  }
  function addOwedPerson(name) {
    name = String(name || '').trim();
    if (!name) return;
    var dupe = (state.owed.people || []).some(function (p) {
      return p.name.toLowerCase() === name.toLowerCase();
    });
    if (dupe) { snack('Already in the book: ' + esc(name)); return; }
    state.owed.people.push({ id: owedUid('ow'), name: name, entries: [], updated: new Date().toISOString() }); // v72.7: updated = recent-sort key
    saveOwed().then(emitOwed);
  }
  function delOwedPerson(id) {
    var idx = -1;
    (state.owed.people || []).forEach(function (p, i) { if (p.id === id) idx = i; });
    if (idx < 0) return;
    var gone = state.owed.people.splice(idx, 1)[0];
    // v72.10: every ledger-filed entry goes with the person — undo brings them back
    var goneTxns = [];
    (gone.entries || []).forEach(function (e) {
      if (e && e.txnId) {
        for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === e.txnId) { goneTxns.push(Object.assign({}, state.txns[i])); break; }
      }
    });
    saveOwed().then(function () {
      emitOwed();
      goneTxns.forEach(function (t) { removeTxnQuiet(t.id); });
      snack('Removed ' + esc(gone.name), function () {
        state.owed.people.push(gone);
        var u = Promise.resolve();
        goneTxns.forEach(function (t) { u = u.then(function () { return restoreTxnQuiet(t); }); });
        u.then(function () { saveOwed().then(emitOwed); });
      });
    });
  }
  // ---------- v72.49: the mine / theirs / total split (ipf + tpf) ----------
  // T (total) = the total for BOTH = yours + theirs — an input aid that
  // fills in a missing share; on its own it is NOT an entry (a no-split
  // entry is the single share: ipf = theirs, tpf = yours — the old
  // behavior). Yours ALWAYS lands in the ledger (your consumption); the
  // owed entry records the debt side: ipf = theirs (they owe you), tpf =
  // yours (you owe them) — theirs in tpf is reference only, never recorded
  // (user-confirmed: the debt is your share). Pure, so the smoke drives
  // the whole table.
  function owedSplit(dir, T, M, Th) {
    T = r2(T); M = r2(M); Th = r2(Th);
    var hasT = T > 0, hasM = M > 0, hasTh = Th > 0;
    function bad(msg) { return { owed: 0, ledger: 0, err: msg }; }
    if (!hasT && !hasM && !hasTh) return bad('Fill in yours, theirs, or the total for both.');
    if (hasT && hasM && hasTh && Math.abs(T - (M + Th)) > 0.005) {
      return bad('Total must equal yours + theirs (' + money(M + Th) + ').');
    }
    if (dir === 'tpf') {
      if (hasT && !hasM && !hasTh) return bad('The total alone is for both of you — fill in yours (what you owe them), or theirs + the total.');
      if (hasTh && !hasM && !hasT) return bad('Fill in yours (what you owe them) — theirs alone does not say that.');
      if (hasM && hasT && M > T + 0.005) return bad('A part cannot be bigger than the total.');
      var owedY = hasM ? M : r2(T - Th);
      if (owedY < 0) return bad('A part cannot be bigger than the total.');
      return { owed: owedY, ledger: owedY, err: '' };
    }
    // ipf
    if (hasT && !hasM && !hasTh) return bad('The total alone is for both of you — fill in theirs (what they owe you), or yours + the total.');
    var owedT = hasTh ? Th : (hasT ? r2(T - M) : 0);
    var ledg = hasM ? M : (hasT ? r2(T - Th) : 0);
    if (owedT < 0 || ledg < 0) return bad('A part cannot be bigger than the total.');
    return { owed: owedT, ledger: ledg, err: '' };
  }
  function addOwedEntry(pid, data) {
    var p = null;
    (state.owed.people || []).forEach(function (x) { if (x.id === pid) p = x; });
    if (!p) return;
    if (!p.entries) p.entries = [];
    var dir = OWED_DIRS[data.dir] ? data.dir : 'ipf';
    var e = {
      id: owedUid('oe'), d: data.d || todayISO(),
      dir: dir,
      note: String(data.note || '').trim(), created: new Date().toISOString()
    };
    if (data.expr) e.expr = data.expr;
    // v72.49 (the split): the form hands over total / mine / theirs (the
    // submit handler already ran them through owedSplit — errors alert
    // there). The owed entry records the debt side (ipf = theirs, tpf =
    // yours); YOURS always files to the ledger — ipf on the picked account
    // (Cash by default; a card files as card_charge, the Add-sheet rule),
    // tpf on Cash as before, both under the picked category. A no-split
    // entry is the old behavior exactly (legacy payloads: amt only).
    var owed = r2(data.amt);
    var mine = r2(data.mine), theirs = r2(data.theirs), total = r2(data.total);
    // v72.51: the form passes the RAW parts — on the Total + Theirs line
    // Mine comes through as 0 (blank), so derive yours = total − theirs here.
    // v72.49 bug: the ledger was read from the raw typed mine, so the filed
    // part silently never left the ledger (total 1000 + theirs 200 → my 800
    // was lost).
    if (dir === 'ipf' && !(mine > 0) && total > 0 && theirs > 0) mine = r2(total - theirs);
    var hasSplitFields = (data.total !== undefined || data.mine !== undefined || data.theirs !== undefined);
    var acc = String(data.acc || '').trim();
    if (hasSplitFields && !acc) acc = 'CASH::Cash'; // v72.49: Cash is always the default (the new form path); legacy payloads (amt only) keep the old storage
    var cat = String(data.cat || '').trim();
    if (!cat) cat = 'Unsorted'; // the no-budgets fallback
    e.cat = cat;
    e.amt = owed;
    var isSplitDir = (dir === 'ipf' || dir === 'tpf');
    var ledger = isSplitDir ? ((dir === 'tpf') ? owed : mine) : 0;
    if (isSplitDir) { // v72.49: store only the parts that are not e.amt itself
      if (dir === 'ipf' && mine > 0) e.mine = mine; // tpf: yours = e.amt
      if (dir === 'tpf' && theirs > 0) e.theirs = theirs; // ipf: theirs = e.amt
      if (total > 0) e.total = total;
    }
    if (dir !== 'tpf' && acc) e.acc = acc; // ipf/itb/tmb: the pick rides on the entry (tpf files on Cash)
    p.updated = new Date().toISOString(); // v72.7: recent-sort key
    var step = Promise.resolve();
    if (ledger > 0) {
      var tData = {
        date: e.d, account: 'Cash', kind: 'cash_out',
        category: e.cat, amount: ledger, note: 'Owed · ' + p.name
      };
      if (dir === 'ipf') { // the filed part leaves the picked account
        var isCard = acc.indexOf('CARD::') === 0;
        tData.account = acc.split('::').pop() || 'Cash';
        tData.kind = isCard ? 'card_charge' : 'cash_out';
      }
      step = addTxn(tData, { quiet: true }).then(function (id) {
        e.txnId = id; // the link persists with the entry (export/import carries it)
        return saveOwed();
      });
    }
    if (owed > 0) p.entries.push(e); // v72.49: an ipf add with ONLY yours = a ledger txn, no owed entry
    saveOwed().then(function () { return step; }).then(function () {
      emitOwed();
      var msg;
      if (ledger > 0 && owed > 0) msg = OWED_DIRS[e.dir].label + ' ' + money(owed) + ' · ' + money(ledger) + ' in the ledger · ' + esc(p.name);
      else if (ledger > 0) msg = 'Added ' + money(ledger) + ' to the ledger · ' + esc(p.name);
      else msg = OWED_DIRS[e.dir].label + ' ' + money(owed) + ' · ' + esc(p.name);
      snack(msg, function () {
        p.entries = p.entries.filter(function (x) { return x.id !== e.id; });
        var u = e.txnId ? removeTxnQuiet(e.txnId) : Promise.resolve();
        e.txnId = null;
        u.then(function () { saveOwed().then(emitOwed); });
      });
    });
  }
  function delOwedEntry(pid, eid) {
    var p = null;
    (state.owed.people || []).forEach(function (x) { if (x.id === pid) p = x; });
    if (!p) return;
    var idx = -1;
    (p.entries || []).forEach(function (e, i) { if (e.id === eid) idx = i; });
    if (idx < 0) return;
    var gone = p.entries.splice(idx, 1)[0];
    // v72.10: the linked ledger txn (if any) is snapshotted for the undo
    var goneTxn = null;
    if (gone.txnId) {
      for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === gone.txnId) goneTxn = Object.assign({}, state.txns[i]);
    }
    p.updated = new Date().toISOString(); // v72.7: recent-sort key
    saveOwed().then(function () {
      emitOwed();
      if (goneTxn) removeTxnQuiet(goneTxn.id);
      snack('Removed ' + money(gone.amt) + ' entry', function () {
        p.entries.push(gone);
        var u = goneTxn ? restoreTxnQuiet(goneTxn) : Promise.resolve();
        u.then(function () { saveOwed().then(emitOwed); });
      });
    });
  }
  // ---------- v72.48: statement-of-account PDF export (Owed, one per person) ----------
  // Hand-rolled PDF 1.4 writer — base-14 Helvetica (built into every PDF
  // reader, no font files, no external library: the app is local-first and
  // the SW precaches only local files, so no CDN; it works fully offline).
  // Everything is pure and
  // smoke-testable: soaRows(p) is the running-balance table, soaPdf(p)
  // renders the whole PDF as ASCII text (a pure-ASCII Blob encodes UTF-8
  // byte-exact), and exportOwedSoa(pid) downloads it on the same one-tap
  // path as the Settings exports.
  function soaRows(p) {
    var ents = ((p && p.entries) || []).slice().sort(function (a, c) {
      if (a.d !== c.d) return a.d < c.d ? -1 : 1; // the SOA runs chronological (the card shows newest first)
      return (a.created || '') < (c.created || '') ? -1 : 1;
    });
    var bal = 0;
    var rows = [];
    ents.forEach(function (e) {
      var dir = OWED_DIRS[e.dir] || OWED_DIRS.ipf;
      var amt = r2((Number(e.amt) || 0) * dir.sign); // + = they owe you more, - = they owe you less
      bal = r2(bal + amt);
      rows.push({ d: e.d || '', label: dir.label, note: String(e.note || ''), amt: amt, bal: bal });
    });
    return { name: String((p && p.name) || ''), rows: rows, bal: bal };
  }
  // PDF text stays ASCII only (base-14 fonts + an ASCII content stream):
  // tidy the common Unicode the app writes, then turn the rest into '?'.
  function soaAscii(s) {
    return String(s == null ? '' : s)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014\u2212]/g, '-')
      .replace(/\u00B7/g, '-')
      .replace(/[^\x20-\x7E]/g, '?');
  }
  function soaPdfStr(s) { // a PDF literal string: escape \ ( )
    return '(' + soaAscii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
  }
  // Helvetica glyph widths (units per 1000) — right-alignment + truncation
  var SOA_FONT_W = {
    ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333,
    '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
    ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
    'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778, 'H': 722, 'I': 278, 'J': 500,
    'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778, 'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611,
    'U': 722, 'V': 667, 'W': 944, 'X': 667, 'Y': 667, 'Z': 611,
    '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333,
    'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556, 'h': 556, 'i': 222, 'j': 222,
    'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556, 'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278,
    'u': 556, 'v': 500, 'w': 722, 'x': 500, 'y': 500, 'z': 500,
    '{': 334, '|': 260, '}': 334, '~': 584
  };
  function soaWidth(s, size) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += SOA_FONT_W[s.charAt(i)] || 556;
    return w / 1000 * size;
  }
  function soaMoney2(v) {
    return (Math.abs(Number(v) || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function soaPdf(p, asOf) {
    var data = soaRows(p);
    var name = soaAscii(data.name || 'Person');
    var asOfD = soaAscii(fmtDate(asOf || todayISO()));
    var ML = 56, MR = 539.28; // A4 595.28 x 841.89, 56pt margins
    var COL_DESC = 120, COL_AMT = 462; // description starts; Amount right-edge (Balance right-edge = MR)
    var INK = '0.13 0.16 0.24 rg', MUT = '0.55 0.59 0.66 rg', LGRAY = '0.80 0.83 0.88 RG';
    function txt(pg, x, y, size, font, text, mut) {
      pg.push((mut ? MUT : INK) + ' BT /' + font + ' ' + size + ' Tf 1 0 0 1 ' +
        (Math.round(x * 100) / 100) + ' ' + (Math.round(y * 100) / 100) + ' Tm ' + soaPdfStr(text) + ' Tj ET');
    }
    function rtxt(pg, right, y, size, text, font, mut) {
      txt(pg, right - soaWidth(text, size), y, size, font || 'F1', text, mut);
    }
    function hline(pg, y, w, mut) {
      var yy = Math.round(y * 100) / 100;
      pg.push((mut ? LGRAY : '0.55 0.59 0.66 RG') + ' ' + w + ' w ' + ML + ' ' + yy + ' m ' + MR + ' ' + yy + ' l S');
    }
    function tableHead(pg, y) {
      hline(pg, y + 12, 1);
      txt(pg, ML, y, 9, 'F2', 'Date', true);
      txt(pg, COL_DESC, y, 9, 'F2', 'Description', true);
      rtxt(pg, COL_AMT, y, 9, 'Amount', 'F2', true);
      rtxt(pg, MR, y, 9, 'Balance', 'F2', true);
      hline(pg, y - 8, 1);
    }
    var pages = [];
    var first = []; // page 1: the full title block
    txt(first, ML, 786, 16, 'F2', 'Statement of Account');
    txt(first, ML, 762, 11, 'F1', 'Account: ' + name);
    txt(first, ML, 746, 9, 'F1', 'As of ' + asOfD + ' - Currency: PHP - Positive balance = owed to you', true);
    tableHead(first, 714);
    pages.push({ pg: first, y0: 688 });
    var rows = data.rows;
    // 34 / 35 rows per page — the closing block's room is kept on EVERY page,
    // so it can never run into the footer
    var chunks = [];
    if (!rows.length) chunks.push([]);
    else {
      var i0 = 0;
      while (i0 < rows.length) {
        var cap = chunks.length === 0 ? 34 : 35;
        chunks.push(rows.slice(i0, i0 + cap));
        i0 += cap;
      }
    }
    for (var pgI = 1; pgI < chunks.length; pgI++) { // continuation pages
      var cont = [];
      txt(cont, ML, 786, 12, 'F2', 'Statement of Account - ' + name);
      txt(cont, ML, 768, 9, 'F1', 'As of ' + asOfD + ' - continued', true);
      tableHead(cont, 744);
      pages.push({ pg: cont, y0: 716 });
    }
    chunks.forEach(function (chunk, idx) {
      var pg = pages[idx].pg;
      var y = pages[idx].y0;
      if (!chunk.length) {
        txt(pg, ML, y, 9, 'F1', 'No entries yet - the account is empty.', true);
      } else {
        chunk.forEach(function (r) {
          txt(pg, ML, y, 9, 'F1', soaAscii(fmtDate(r.d) || r.d || '-'));
          var desc = soaAscii(r.label + (r.note ? ' \u00B7 ' + r.note : ''));
          var maxW = COL_AMT - 12 - COL_DESC;
          var cut = false;
          while (desc.length > 6 && soaWidth(desc, 9) > maxW) { desc = desc.slice(0, -1); cut = true; }
          if (cut) desc = desc.slice(0, Math.max(1, desc.length - 4)) + '...';
          txt(pg, COL_DESC, y, 9, 'F1', desc);
          rtxt(pg, COL_AMT, y, 9, (r.amt >= 0 ? '+' : '-') + soaMoney2(r.amt));
          rtxt(pg, MR, y, 9, soaMoney2(r.bal));
          y -= 16;
        });
      }
      // the closing block (always on the LAST page, with the direction)
      if (idx === chunks.length - 1) {
        var lastY = pages[idx].y0 - 16 * Math.max(0, chunk.length - 1);
        hline(pg, lastY - 24, 1);
        txt(pg, ML, lastY - 44, 11, 'F2', 'Closing balance: PHP ' + soaMoney2(data.bal));
        var line;
        if (data.bal > 0.004) line = name + ' owes you PHP ' + soaMoney2(data.bal);
        else if (data.bal < -0.004) line = 'You owe ' + name + ' PHP ' + soaMoney2(data.bal);
        else line = 'Settled - the balance is zero';
        txt(pg, ML, lastY - 62, 10, 'F1', line);
      }
    });
    // footers (need the total page count first)
    pages.forEach(function (pgObj, i) {
      hline(pgObj.pg, 52, 0.75, true);
      txt(pgObj.pg, ML, 38, 8, 'F1', 'Fin.AI - ' + asOfD, true);
      rtxt(pgObj.pg, MR, 38, 8, 'Page ' + (i + 1) + ' of ' + pages.length, 'F1', true);
    });
    // ---------- assemble the PDF objects (1 catalog, 2 pages-tree, 3-4 fonts) ----------
    var n = 4 + 2 * pages.length;
    var objs = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    var kids = [];
    for (var k = 0; k < pages.length; k++) kids.push((5 + 2 * k) + ' 0 R');
    objs[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>';
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    pages.forEach(function (pgObj, i) {
      objs[5 + 2 * i] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (6 + 2 * i) + ' 0 R >>';
      var stream = pgObj.pg.join('\n');
      objs[6 + 2 * i] = '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream';
    });
    var out = '%PDF-1.4\n';
    var offsets = [0];
    for (var id = 1; id <= n; id++) { // ASCII-only => string index == byte offset
      offsets[id] = out.length;
      out += id + ' 0 obj\n' + objs[id] + '\nendobj\n';
    }
    var xrefAt = out.length;
    out += 'xref\n0 ' + (n + 1) + '\n0000000000 65535 f \n';
    for (var j = 1; j <= n; j++) out += ('0000000000' + offsets[j]).slice(-10) + ' 00000 n \n';
    out += 'trailer\n<< /Size ' + (n + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n';
    return out;
  }
  function exportOwedSoa(pid) {
    var p = null;
    (state.owed.people || []).forEach(function (x) { if (x.id === pid) p = x; });
    if (!p) return;
    var pdf = soaPdf(p);
    var safe = soaAscii(p.name).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'person';
    var fname = 'soa-' + safe + '-' + todayISO() + '.pdf';
    var url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    var a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 600);
    snack('Statement saved: ' + esc(fname));
  }
  // v72.10: editable subentries. The linked ledger txn follows the entry:
  // linked+linked → v72.9's in-place edit (position + original timestamp stay);
  // linked→none → the txn is removed; none→linked (or a dangling link) → a
  // fresh txn is filed. ONE toast covers entry + txn; Undo reverses both.
  function updateOwedEntry(pid, eid, data) {
    var p = null, e = null;
    (state.owed.people || []).forEach(function (x) {
      if (x.id === pid) {
        p = x;
        (x.entries || []).forEach(function (y) { if (y.id === eid) e = y; });
      }
    });
    if (!p || !e) return Promise.resolve();
    var prev = Object.assign({}, e); // undo payload — the entry side, BEFORE
    var prevTxn = null;
    if (e.txnId) {
      for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === e.txnId) prevTxn = Object.assign({}, state.txns[i]);
    }
    // v72.49 (the split): the same rule as addOwedEntry — yours files (ipf
    // on the picked account, tpf on Cash), the owed entry carries the debt
    // side. Editing is where OLD entries adopt it: the linked ledger txn is
    // rewritten in place (id + position kept), removed, or created fresh.
    var nextDir = OWED_DIRS[data.dir] ? data.dir : e.dir;
    var hasSplitFields = (data.total !== undefined || data.mine !== undefined || data.theirs !== undefined);
    var acc = String(data.acc || '').trim();
    if (hasSplitFields && !acc) acc = 'CASH::Cash'; // v72.49: Cash is always the default (the new form path); legacy payloads keep the old storage
    var cat = String(data.cat || '').trim();
    if (!cat) cat = e.cat || 'Unsorted';
    var isSplitDir = (nextDir === 'ipf' || nextDir === 'tpf');
    var split;
    if (!isSplitDir) {
      split = { owed: r2(data.total != null ? data.total : data.amt), ledger: 0, err: '' };
    } else if (!hasSplitFields) {
      // legacy payload (pre-v72.49 callers, amt only): the single amount is
      // the no-split reading of that direction (ipf: theirs, tpf: yours)
      split = { owed: r2(data.amt), ledger: (nextDir === 'tpf') ? r2(data.amt) : 0, err: '' };
    } else {
      split = owedSplit(nextDir, r2(data.total), r2(data.mine), r2(data.theirs));
    }
    if (split.err) { alert(split.err); return Promise.resolve(); }
    if (isSplitDir && split.owed <= 0) {
      alert('That would leave no owed part — keep the part that is owed, or remove the entry.');
      return Promise.resolve();
    }
    var next = {
      d: data.d || e.d, amt: split.owed,
      dir: nextDir,
      note: String(data.note || '').trim(),
      cat: cat
    };
    // v72.51: split.ledger — owedSplit already derived the missing part
    // (Total + Theirs, Mine left blank => yours = total − theirs); the raw
    // r2(data.mine) read 0 there, so a T+Th edit silently un-filed the txn
    var ledger = isSplitDir ? split.ledger : 0;
    var files = ledger > 0;
    var tData = {
      date: next.d, account: 'Cash', kind: 'cash_out',
      category: next.cat, amount: ledger, note: 'Owed · ' + p.name
    };
    if (nextDir === 'ipf') { // the filed part leaves the picked account
      var isCard = acc.indexOf('CARD::') === 0;
      tData.account = acc.split('::').pop() || 'Cash';
      tData.kind = isCard ? 'card_charge' : 'cash_out';
    }
    var step = Promise.resolve();
    if (prevTxn && files) {
      step = saveTxnEdit(e.txnId, tData, { quiet: true });
    } else if (prevTxn && !files) {
      step = removeTxnQuiet(e.txnId);
    } else if (!prevTxn && files) {
      step = addTxn(tData, { quiet: true }).then(function (id) {
        e.txnId = id;
        return saveOwed();
      });
    }
    return step.then(function () {
      e.d = next.d; e.amt = next.amt; e.dir = next.dir; e.note = next.note;
      e.cat = next.cat; // v72.25→v72.28
      if (data.expr) e.expr = data.expr; else delete e.expr;
      // v72.49: the split parts — only the ones that are there (ipf: mine +
      // total; tpf: theirs + total; e.amt IS the debt side)
      delete e.mine; delete e.theirs; delete e.total;
      if (isSplitDir) {
        if (nextDir === 'ipf' && ledger > 0) e.mine = ledger; // v72.51: yours = the filed part (derived when T+Th)
        if (nextDir === 'tpf' && r2(data.theirs) > 0) e.theirs = r2(data.theirs);
        if (r2(data.total) > 0) e.total = r2(data.total);
      }
      // v72.49: the pick rides on the entry (never on tpf, which files on
      // Cash implicitly); a legacy empty pick still means "no account"
      if (nextDir === 'tpf' || !acc) delete e.acc; else e.acc = acc;
      if (!files) e.txnId = null;
      p.updated = new Date().toISOString(); // v72.7: recent-sort key
      return saveOwed();
    }).then(function () {
      emitOwed();
      var undoNewId = !prevTxn && files ? e.txnId : null; // the just-created link
      snack('Updated ' + money(e.amt) + ' · ' + esc(p.name), function () {
        Object.keys(prev).forEach(function (k) { e[k] = prev[k]; });
        if (prev.acc) e.acc = prev.acc; else delete e.acc;
        if (prev.txnId) e.txnId = prev.txnId; else delete e.txnId;
        if (prev.mine) e.mine = prev.mine; else delete e.mine; // v72.49: the split parts
        if (prev.theirs) e.theirs = prev.theirs; else delete e.theirs;
        if (prev.total) e.total = prev.total; else delete e.total;
        var u = Promise.resolve();
        if (prevTxn && files) {
          // re-run the in-place edit with the ORIGINAL values — the exact
          // inverse rebase; position + timestamp stay put
          u = saveTxnEdit(prevTxn.id, {
            date: prevTxn.date, account: prevTxn.account, kind: prevTxn.kind,
            category: prevTxn.category || 'Unsorted', amount: prevTxn.amount, note: prevTxn.note || ''
          }, { quiet: true });
        } else if (prevTxn && !files) {
          u = restoreTxnQuiet(prevTxn);
        } else if (undoNewId) {
          u = removeTxnQuiet(undoNewId);
        }
        u.then(function () { saveOwed().then(emitOwed); });
      });
      return Promise.resolve();
    });
  }
  function owedExprHint(input) {
    var eq = input && input.parentElement ? input.parentElement.querySelector('.oent-eq') : null;
    if (!eq) return;
    var raw = String(input.value || '').trim();
    if (!raw) { eq.textContent = ''; eq.className = 'oent-eq'; return; }
    var v = evalExpr(raw);
    if (v === null) {
      eq.textContent = 'plain numbers, or quick sums like 300-125+10';
      eq.className = 'oent-eq bad';
    } else if (v <= 0) {
      eq.textContent = '= ' + money(v) + ' · must be more than 0';
      eq.className = 'oent-eq bad';
    } else {
      eq.textContent = '= ' + money(v);
      eq.className = 'oent-eq';
    }
  }
  function owedSyncDate(input) {
    var lab = input && input.parentElement ? input.parentElement.querySelector('.dlabel') : null;
    if (!lab) return;
    if (!input.value) { lab.textContent = 'Pick a date'; lab.className = 'dlabel empty'; }
    else { lab.textContent = fmtDate(input.value); lab.className = 'dlabel'; }
  }
  // v72.7: drag-to-reorder the person cards (⠿ handle, the same pointer
  // pattern as "Your numbers"). The drop rewrites state.owed.people in DOM
  // order and pins the sort to custom (stored order), persisted via saveOwed.
  var owedDragSt = null;
  function owedDragStart(ev) {
    var h = ev.target && ev.target.closest ? ev.target.closest('[data-ow-drag]') : null;
    if (!h) return;
    var card = h.closest('.ow-p');
    if (!card) return;
    ev.preventDefault();
    owedDragSt = { card: card };
    card.classList.add('dragging');
    document.addEventListener('pointermove', owedDragMove);
    document.addEventListener('pointerup', owedDragEnd);
    document.addEventListener('pointercancel', owedDragEnd);
  }
  function owedDragMove(ev) {
    if (!owedDragSt) return;
    var body = byId('owedBody');
    if (!body) return;
    var y = ev.clientY;
    var sibs = Array.prototype.slice.call(body.querySelectorAll('.ow-p:not(.dragging)'));
    for (var i = 0; i < sibs.length; i++) {
      var r = sibs[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { body.insertBefore(owedDragSt.card, sibs[i]); break; }
      if (i === sibs.length - 1) body.appendChild(owedDragSt.card);
    }
  }
  function owedDragEnd() {
    document.removeEventListener('pointermove', owedDragMove);
    document.removeEventListener('pointerup', owedDragEnd);
    document.removeEventListener('pointercancel', owedDragEnd);
    if (!owedDragSt) return;
    var st = owedDragSt;
    owedDragSt = null;
    st.card.classList.remove('dragging');
    var body = byId('owedBody');
    if (!body) return;
    var order = [];
    Array.prototype.forEach.call(body.querySelectorAll('.ow-p'), function (c) {
      order.push(c.getAttribute('data-ow-pid'));
    });
    var map = {};
    (state.owed.people || []).forEach(function (p) { map[p.id] = p; });
    var np = order.map(function (id) { return map[id]; }).filter(function (p) { return p; });
    (state.owed.people || []).forEach(function (p) {
      if (order.indexOf(p.id) < 0) np.push(p);
    });
    if (np.length !== (state.owed.people || []).length) return;
    state.owed.people = np;
    state.owed.sort = 'custom';
    saveOwed().then(emitOwed);
  }
  function owedBindEvents() {
    var form = byId('owedForm');
    if (form) form.onsubmit = function (ev) {
      ev.preventDefault();
      var nameEl = byId('owedName');
      var name = (nameEl.value || '').trim();
      if (!name) { alert('Give the person a name.'); return; }
      addOwedPerson(name);
      nameEl.value = '';
    };
    var body = byId('owedBody');
    if (!body) return;
    var ssel = byId('owedSort'); // v72.7: sort control (az / recent / custom)
    if (ssel) ssel.onchange = function () {
      state.owed.sort = ssel.value;
      saveOwed().then(emitOwed);
    };
    body.addEventListener('pointerdown', owedDragStart); // v72.7: drag-to-reorder
    body.addEventListener('submit', function (ev) {
      var f = ev.target;
      if (!f || typeof f.className !== 'string' || f.className.indexOf('oent') < 0) return;
      ev.preventDefault();
      var pid = f.getAttribute('data-ow-for');
      var dirEl = f.querySelector('input[name="owdir"]:checked');
      var dir = dirEl ? dirEl.value : 'ipf';
      var amtEl = f.querySelector('.oent-amt');
      var raw = String(amtEl.value || '').trim();
      // v72.49: ipf/tpf read the split — Total (the total for both) + the
      // Mine / Theirs parts; owedSplit decides the owed/ledger sides (the
      // alerts live in there). itb/tmb keep the single amount.
      var T = evalExpr(raw);
      if (T === null) T = 0;
      var mineEl = f.querySelector('.oent-mine');
      var theirsEl = f.querySelector('.oent-theirs');
      var M = evalExpr(mineEl ? String(mineEl.value || '').trim() : '');
      if (M === null) M = 0;
      var Th = evalExpr(theirsEl ? String(theirsEl.value || '').trim() : '');
      if (Th === null) Th = 0;
      var owed;
      if (dir === 'ipf' || dir === 'tpf') {
        var split = owedSplit(dir, T, M, Th);
        if (split.err) { alert(split.err); return; }
        owed = split.owed;
      } else {
        if (!(T > 0)) {
          alert('Enter an amount greater than 0 — a plain number, or a quick sum like 300-125+10.');
          return;
        }
        owed = T;
      }
      var editId = f.getAttribute('data-ow-edit'); // v72.10: edit mode
      if (editId && owed <= 0) { // v72.49: an edit cannot zero the owed part
        alert('That would leave no owed part — keep the part that is owed, or remove the entry.');
        return;
      }
      var expr = (raw !== String(r2(T))) ? raw : null;
      var payload = {
        d: f.querySelector('.oent-date').value || todayISO(),
        amt: owed, dir: dir, expr: expr,
        total: r2(T), mine: r2(M), theirs: r2(Th), // v72.49: the split parts
        note: (f.querySelector('.oent-note').value || '').trim(),
        // v72.28→v72.49: the account pick — on ipf it is the account the
        // filed "mine" part leaves (Cash is always an option), itb/tmb
        // informational, tpf ignored (Cash implicit)
        acc: (f.querySelector('.oent-acc') || { value: 'CASH::Cash' }).value || 'CASH::Cash',
        // v72.25→v72.49: the category pick (shown for ipf + tpf; 'Unsorted' fallback)
        cat: (f.querySelector('.oent-cat') || { value: 'Unsorted' }).value || 'Unsorted'
      };
      if (editId) updateOwedEntry(pid, editId, payload);
      else addOwedEntry(pid, payload);
      resetOentForm(f);
    });
    body.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== body) {
        var tog = t.getAttribute && t.getAttribute('data-ow-toggle');
        var delP = t.getAttribute && t.getAttribute('data-ow-del');
        var delE = t.getAttribute && t.getAttribute('data-ow-del-e');
        var edE = t.getAttribute && t.getAttribute('data-ow-edit-e');
        var cancelE = t.getAttribute && t.getAttribute('data-ow-edit-cancel');
        var nmE = t.getAttribute && t.getAttribute('data-ow-name');
        var moreE = t.getAttribute && t.getAttribute('data-ow-more');
        var lessE = t.getAttribute && t.getAttribute('data-ow-less'); // v72.30: re-hide 5
        var soaE = t.getAttribute && t.getAttribute('data-ow-soa'); // v72.48: SOA (PDF)
        if (moreE) {
          owedShown[moreE] = (owedShown[moreE] || 5) + 5;
          renderOwed();
          return;
        }
        if (lessE) {
          owedShown[lessE] = Math.max(5, (owedShown[lessE] || 5) - 5);
          renderOwed();
          return;
        }
        if (soaE) {
          exportOwedSoa(soaE); // v72.48: the per-person statement of account
          return;
        }
        if (edE) {
          // v72.29 (user edit: 'i want the edit to expand in position'): the
          // prefilled form expands at THIS entry's row (Save + Cancel) — the
          // card-top form is for "+ entry" adds only
          var row = t;
          while (row && row !== body && !(row.getAttribute && row.getAttribute('class') && String(row.getAttribute('class')).indexOf('ow-e') >= 0)) row = row.parentNode;
          var card = t;
          while (card && card !== body && !(card.getAttribute && card.getAttribute('data-ow-pid'))) card = card.parentNode;
          if (row && card && card.getAttribute) {
            var pid3 = card.getAttribute('data-ow-pid');
            var ee = null;
            (state.owed.people || []).forEach(function (x) {
              if (x.id === pid3) (x.entries || []).forEach(function (y) { if (y.id === edE) ee = y; });
            });
            if (ee) {
              var stale = body.querySelectorAll('.oent-inline');
              for (var si = 0; si < stale.length; si++) {
                if (stale[si].parentNode) stale[si].parentNode.removeChild(stale[si]);
              }
              row.insertAdjacentHTML('afterend',
                '<form class="oent oent-inline" data-ow-for="' + esc(pid3) + '" data-ow-edit="' + esc(edE) + '" autocomplete="off">' +
                oentFormHTML(true) + '</form>');
              var f3 = row.nextElementSibling;
              if (f3) {
                var d3 = f3.querySelector('.oent-date');
                d3.value = ee.d || todayISO(); owedSyncDate(d3);
                // v72.49: the amount field reads TOTAL for ipf/tpf — the
                // parts prefill from the stored split. Legacy entries read as
                // the no-split shape: ipf amount = theirs, tpf amount = yours.
                var preDir = ee.dir || 'ipf';
                var preT = (preDir === 'ipf' || preDir === 'tpf') ? (ee.total ? String(ee.total) : '') : String(ee.amt);
                // v72.51: a PRE-FIX T+Th entry has no stored mine — prefill
                // the derived part (total − amt) so the edit keeps the split
                var preIpFMine = (preDir === 'ipf') ? (Number(ee.mine) || (ee.total && Number(ee.total) > (Number(ee.amt) || 0) ? r2(ee.total - (Number(ee.amt) || 0)) : 0)) : 0;
                var preM = (preDir === 'tpf') ? String(ee.amt) : (preIpFMine ? String(preIpFMine) : '');
                var preTh = (preDir === 'ipf') ? String(ee.amt) : (preDir === 'tpf' && ee.theirs ? String(ee.theirs) : '');
                var a3 = f3.querySelector('.oent-amt');
                a3.value = preT; owedExprHint(a3);
                var m3 = f3.querySelector('.oent-mine');
                if (m3) m3.value = preM;
                var th3 = f3.querySelector('.oent-theirs');
                if (th3) th3.value = preTh;
                var radios3 = f3.querySelectorAll('input[name="owdir"]');
                for (var r3 = 0; r3 < radios3.length; r3++) radios3[r3].checked = radios3[r3].value === (ee.dir || 'ipf');
                var seg3 = f3.querySelector('.seg');
                if (seg3) {
                  var labs3 = seg3.getElementsByTagName('label');
                  for (var l3 = 0; l3 < labs3.length; l3++) {
                    var i3 = labs3[l3].getElementsByTagName('input')[0];
                    labs3[l3].className = i3 && i3.checked ? 'sel' : '';
                  }
                }
                var s3 = f3.querySelector('.oent-acc');
                if (s3) {
                  // v72.49: no "no account" option anymore — a legacy empty
                  // pick (or a gone account) lands back on Cash
                  var av3 = ee.acc || 'CASH::Cash';
                  var okA3 = false;
                  for (var oi3 = 0; oi3 < s3.options.length; oi3++) if (s3.options[oi3].value === av3) okA3 = true;
                  s3.value = okA3 ? av3 : 'CASH::Cash';
                }
                var c3 = f3.querySelector('.oent-cat'); // v72.28: rebuild options (a stale saved category stays selectable)
                if (c3) c3.innerHTML = owedCatOptions(ee.cat || '');
                owedFormSections(f3, ee.dir || 'ipf');
                var n3 = f3.querySelector('.oent-note');
                if (n3) n3.value = ee.note || '';
              }
            }
          }
          return;
        }
        if (cancelE) {
          var cf = t;
          while (cf && cf !== body && cf.tagName !== 'FORM') cf = cf.parentNode;
          if (cf && cf.parentNode) cf.parentNode.removeChild(cf);
          return;
        }
        if (nmE) {
          // v72.29 (user edit: 'name of person owed is also editable'): the
          // card name becomes an inline input — Enter/blur commits (empty
          // keeps the old name), Escape cancels
          var pin = null;
          (state.owed.people || []).forEach(function (x) { if (x.id === nmE) pin = x; });
          if (pin && t.parentNode) {
            var inp = document.createElement('input');
            inp.className = 'ow-name-in';
            inp.value = pin.name;
            inp.maxLength = 40;
            inp.setAttribute('autocomplete', 'off');
            var nmDone = false;
            var nmCommit = function () {
              if (nmDone) return;
              nmDone = true;
              var v = (inp.value || '').trim();
              if (v && v !== pin.name) { pin.name = v; saveOwed().then(emitOwed); }
              else renderOwed();
            };
            inp.onkeydown = function (ev) {
              if (ev.key === 'Enter') { ev.preventDefault(); nmCommit(); }
              else if (ev.key === 'Escape') { nmDone = true; renderOwed(); }
            };
            inp.onblur = nmCommit;
            t.parentNode.replaceChild(inp, t);
            inp.focus();
            if (inp.select) inp.select();
          }
          return;
        }
        if (tog) {
          var f = body.querySelector('.oent[data-ow-for="' + tog + '"]');
          if (f) {
            // v72.29: an open in-place edit form closes when the add form opens
            var staleT = body.querySelectorAll('.oent-inline');
            for (var si2 = 0; si2 < staleT.length; si2++) {
              if (staleT[si2].parentNode) staleT[si2].parentNode.removeChild(staleT[si2]);
            }
            // v72.10: "+ entry" is always a fresh add — clear any edit mode
            f.removeAttribute('data-ow-edit');
            var sb = f.querySelector('[type="submit"]');
            if (sb) sb.textContent = 'Add entry';
            f.style.display = f.style.display === 'none' ? '' : 'none';
            var dirT = f.querySelector('input[name="owdir"]:checked'); // v72.28: sections follow the current choice
            owedFormSections(f, dirT ? dirT.value : 'ipf');
            var d = f.querySelector('.oent-date');
            if (d && !d.value) { d.value = todayISO(); owedSyncDate(d); }
          }
          return;
        }
        if (delP) {
          var pp = null;
          (state.owed.people || []).forEach(function (x) { if (x.id === delP) pp = x; });
          var pn = pp ? pp.name : 'this person';
          var pe = pp ? (pp.entries || []).length : 0;
          var pm = pe === 0
            ? 'Remove <b>' + esc(pn) + '</b> from the book? You can undo right after.'
            : 'Remove <b>' + esc(pn) + '</b> and their ' + pe + ' ' + (pe === 1 ? 'entry' : 'entries') +
              '? You can undo right after.';
          confirmAsk(pm, 'Remove', function () { delOwedPerson(delP); });
          return;
        }
        if (delE) {
          var card = t;
          while (card && card !== body && !(card.getAttribute && card.getAttribute('data-ow-pid'))) card = card.parentNode;
          if (card && card.getAttribute) {
            var pid2 = card.getAttribute('data-ow-pid');
            var pp2 = null, ee2 = null;
            (state.owed.people || []).forEach(function (x) {
              if (x.id === pid2) {
                pp2 = x;
                (x.entries || []).forEach(function (y) { if (y.id === delE) ee2 = y; });
              }
            });
            var em = ee2
              ? (OWED_DIRS[ee2.dir] ? OWED_DIRS[ee2.dir].label : 'entry') + ' ' + money(Number(ee2.amt) || 0) +
                (ee2.d ? ' · ' + esc(fmtDate(ee2.d)) : '')
              : 'this entry';
            confirmAsk('Remove ' + em + ' for <b>' + esc(pp2 ? pp2.name : 'this person') + '</b>? You can undo right after.',
              'Remove', function () { delOwedEntry(pid2, delE); });
          }
          return;
        }
        t = t.parentNode;
      }
    });
    body.addEventListener('input', function (ev) {
      var t = ev.target;
      if (!t || typeof t.className !== 'string') return;
      if (t.className.indexOf('oent-amt') >= 0) owedExprHint(t);
      else if (t.className.indexOf('oent-date') >= 0) owedSyncDate(t);
    });
    body.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.type === 'radio' && t.name === 'owdir' && t.parentElement && t.parentElement.parentElement) {
        var seg = t.parentElement.parentElement;
        if (typeof seg.className === 'string' && seg.className.indexOf('seg') >= 0) {
          var labs = seg.getElementsByTagName('label');
          for (var i = 0; i < labs.length; i++) {
            var inp = labs[i].getElementsByTagName('input')[0];
            labs[i].className = inp && inp.checked ? 'sel' : '';
          }
          // v72.28 (user edit): the sections follow the choice (account / category / note)
          var formEl = seg.closest ? seg.closest('.oent') : null;
          owedFormSections(formEl, t.value);
        }
      }
    });
  }
  function csvQ(s) {
    s = String(s == null ? '' : s);
    return '"' + s.replace(/"/g, '""') + '"';
  }
  // v72.8: the data-loss fix — import sanitizers. A backup is trusted data,
  // but a hand-edited one must not inject junk: keep only the shapes the app
  // itself writes, capped like the live stores.
  var CHAT_CAP = 200;
  function sanitizeChatRows(rows) {
    var out = [];
    (rows || []).forEach(function (r) {
      if (!r || typeof r.id !== 'string' || !r.id) return;
      if (r.who !== 'user' && r.who !== 'bot') return;
      if (typeof r.at !== 'string') return;
      var m = { id: r.id, who: r.who, at: r.at };
      if (typeof r.text === 'string') m.text = r.text.slice(0, 2000);
      if (typeof r.html === 'string') m.html = r.html.slice(0, 4000);
      if (!m.text && !m.html) return;
      if (Array.isArray(r.storyLines)) m.storyLines = r.storyLines.slice(0, 20);
      if (r.done) m.done = true;
      out.push(m);
    });
    return out.slice(-CHAT_CAP);
  }
  function sanitizeMoneyLogRows(rows) {
    var out = [];
    (rows || []).forEach(function (e) {
      if (!e || typeof e.at !== 'number' || typeof e.a !== 'string') return;
      var m = { at: e.at, a: e.a.slice(0, 40) };
      if (typeof e.tid === 'string') m.tid = e.tid;
      if (typeof e.l === 'string') m.l = e.l.slice(0, 120);
      if (typeof e.c === 'string') m.c = e.c.slice(0, 60);
      if (typeof e.nt === 'string') m.nt = e.nt.slice(0, 120);
      if (typeof e.m === 'string') m.m = e.m.slice(0, 60);
      if (typeof e.n === 'number' && isFinite(e.n)) m.n = e.n;
      if (e.k === 'c' || e.k === 'x' || e.k === 'p' || e.k === 'i' || e.k === 'a') m.k = e.k; // v72.14: the v72.10 p/i flavors must survive an import too; v72.30: 'a' (the Adjustment override row)
      if (typeof e.f === 'number' && isFinite(e.f)) m.f = e.f;
      if (typeof e.o === 'number' && isFinite(e.o)) m.o = e.o;
      if (typeof e.s === 'number' && isFinite(e.s)) m.s = e.s;
      out.push(m);
    });
    return out.slice(-ML_CAP);
  }
  function sanitizeAdj(a) {
    return {
      cash: Number(a && a.cash) || 0, free: Number(a && a.free) || 0,
      card: Number(a && a.card) || 0, prepay: Number(a && a.prepay) || 0,
      mv: Number(a && a.mv) || 0 // v72.43: the model stamp rides the import (0 = pre-migration, migrate on boot)
    };
  }
  function owedImportSort(v) {
    return v === 'az' || v === 'custom' || v === 'recent' ? v : 'recent';
  }
  // v72.23: the Backup section — the user picks which data goes into the
  // JSON export (e.g. "owed tab entries only"). The choice persists;
  // default = everything (old behaviour).
  var BK_SELS = [['base', 'bkBase'], ['txns', 'bkTxns'], ['plans', 'bkPlans'],
    ['owed', 'bkOwed'], ['log', 'bkLog'], ['chat', 'bkChat']];
  function backupSelRead() {
    var out = {};
    try {
      var raw = JSON.parse(localStorage.getItem('fin.bkSel.v1') || 'null');
      BK_SELS.forEach(function (s) { out[s[0]] = raw && typeof raw === 'object' ? !!raw[s[0]] : true; });
    } catch (e) { BK_SELS.forEach(function (s) { out[s[0]] = true; }); }
    return out;
  }
  function backupSelWrite() {
    var out = {};
    BK_SELS.forEach(function (s) { var el = byId(s[1]); out[s[0]] = el ? el.checked : true; });
    try { localStorage.setItem('fin.bkSel.v1', JSON.stringify(out)); } catch (e) {}
    return out;
  }
  // sync the Settings checkboxes to the stored choice (on sheet open)
  function backupSelSync() {
    var sel = backupSelRead();
    BK_SELS.forEach(function (s) { var el = byId(s[1]); if (el) el.checked = !!sel[s[0]]; });
  }
  function exportData(kind) {
    var txns = state.txns.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.created || '') < (b.created || '') ? -1 : 1;
    });
    var plans = state.plans.slice().sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; });
    var stamp = todayISO();
    function download(blob, name) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 600);
      snack('Exported ' + name);
    }
    if (kind === 'csv') {
      var lines = ['date,account,kind,category,amount,note'];
      txns.forEach(function (t) {
        lines.push([t.date, csvQ(t.account), csvQ(t.kind), csvQ(t.category), t.amount, csvQ(t.note || '')].join(','));
      });
      download(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
        'finances-ledger-' + stamp + '.csv');
      return;
    }
    // v72.8 (async): the JSON backup covers everything the app holds — base,
    // txns, plans, owed (+ its sort), shadowLog, the Ledger tab's money log,
    // the live overlay (adj + its sig), and the coach chat thread (an IDB
    // store, read here) — so a reinstall + import loses nothing.
    function jsonBlob(chat) {
      // v72.23: only what the user ticked under Settings → Backup
      // ("what to include"); the default is everything (the v72.8 file).
      // `sections` lists what the file holds, so the import can tell a
      // user-deselected section from an empty one.
      var sel = backupSelRead();
      var inc = [];
      var obj = { app: 'finances-pwa', exportedAt: new Date().toISOString() };
      if (sel.base) { obj.base = state.base; inc.push('base'); }
      if (sel.txns) { obj.txns = txns; inc.push('txns'); }
      if (sel.plans) { obj.plans = plans; inc.push('plans'); }
      if (sel.owed) { obj.owed = state.owed.people; obj.owedSort = state.owed.sort || 'recent'; inc.push('owed'); }
      if (sel.log) {
        obj.shadowLog = state.shadowLog || []; // v68 item 11: the rule-coverage evidence
        obj.moneyLog = (state.moneyLog || []).slice(-ML_CAP); // v72.8: the Ledger tab's audit
        obj.adj = state.adj; obj.adjSig = state.adjSig || ''; // v72.8: the live overlay (exact numbers)
        inc.push('log');
      }
      if (sel.chat) { obj.chat = chat; inc.push('chat'); }
      obj.sections = inc; // v72.23: what this backup holds (partial import)
      return new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    }
    idbAll(STORE_CHAT).then(function (chatRows) {
      download(jsonBlob(sanitizeChatRows(chatRows)), 'finances-export-' + stamp + '.json');
    })['catch'](function () {
      download(jsonBlob([]), 'finances-export-' + stamp + '.json');
    });
  }
  // v56: imported custom details — keep only the safe shape (the same rules
  // the coach's field changes are validated to), so a bad backup can't inject junk.
  var DET_RESV = ['name', 'kind', 'value', 'limit', 'note', 'amount', 'monthly', 'balance', 'goal', 'funded', 'deadline', 'month', 'id'];
  function sanitizeDetails(raw) {
    var out = {};
    Object.keys(raw || {}).slice(0, 40).forEach(function (dk) {
      var m = dk.match(/^(cash|card|debt|loan|budget):(.+)$/);
      if (!m) return;
      var src = (raw || {})[dk];
      if (!src || typeof src !== 'object') return;
      var bag = {};
      Object.keys(src).slice(0, 10).forEach(function (k) {
        var key = String(k).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
        if (!key || DET_RESV.indexOf(key) >= 0) return;
        var v = src[k];
        if (typeof v === 'number' && isFinite(v) && Math.abs(v) <= 1e9) bag[key] = v;
        else if (typeof v === 'string') { var s = v.trim().slice(0, 80); if (s) bag[key] = s; }
      });
      if (Object.keys(bag).length) out[dk] = bag;
    });
    return out;
  }
  // v72.36 (user: 'return the undo button for all toasts'): the Imported
  // toast's Undo — re-file the pre-import snapshot. Mirrors the load path:
  // the imported rows out, the snapshot's rows in, state restored, the
  // snapshot RE-DERIVED from the restored base (refreshLocalSnapshot — the
  // same deterministic step load runs), then everything persisted.
  function restoreImportSnapshot(prev) {
    var dels = [];
    state.txns.forEach(function (t) { dels.push(idbDel(STORE_TX, t.id)); });
    state.plans.forEach(function (p) { dels.push(idbDel(STORE_PLANS, p.id)); });
    idbAll(STORE_CHAT).then(function (chatRows) {
      (chatRows || []).forEach(function (r) { if (r && r.id) dels.push(idbDel(STORE_CHAT, r.id)); });
      return Promise.all(dels);
    }).then(function () {
      var puts = [];
      (prev.txns || []).forEach(function (t) { puts.push(idbPut(STORE_TX, t)); });
      (prev.plans || []).forEach(function (p) { puts.push(idbPut(STORE_PLANS, p)); });
      (prev.chat || []).forEach(function (r) { if (r && r.id) puts.push(idbPut(STORE_CHAT, r)); });
      return Promise.all(puts);
    }).then(function () {
      state.txns = prev.txns;
      state.plans = prev.plans;
      state.owed = prev.owed;
      state.moneyLog = prev.moneyLog;
      state.adj = prev.adj;
      state.base = prev.base;
      baseDirty = false; // the form re-renders from the restored base
      refreshLocalSnapshot();
      return Promise.all([
        persistSnapshot(),
        idbPut(STORE_META, { key: 'base', value: state.base }).catch(function () {}),
        saveAdj(),
        saveOwed(),
        idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog })
      ]);
    }).then(function () {
      renderBaseEditor();
      renderBaseStatus();
      render();
    });
  }
  // ---------- v73.3: gist sync — the network side (DOM-bound, in init) ----------
  // The gist API: GET /gists/:id returns { files: { <name>: { raw_url } } };
  // POST /gists (new) or POST /gists/:id (update) with { description, files }.
  // The file holds ONLY the encrypted envelope — GitHub never sees the data.
  var SYNC_FILE = 'finances-sync.enc.json';
  function syncReadCreds() {
    try {
      var c = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null') || {};
      return { url: String(c.url || ''), token: String(c.token || '') };
    } catch (e) { return { url: '', token: '' }; }
  }
  function syncSetCreds(url, token) {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify({ url: url, token: token })); } catch (e) {}
  }
  function syncGistId(url) {
    var m = String(url || '').match(/gist\.github\.com\/(?:[^/]+\/)?([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }
  function syncNote(msg, bad) {
    var el = byId('syncNote');
    if (el) { el.textContent = msg; el.style.color = bad ? 'var(--bad)' : 'var(--mut)'; }
  }
  function syncPush() {
    var url = (byId('syncUrl').value || '').trim();
    var token = (byId('syncToken').value || '').trim();
    var pass = byId('syncPass').value || '';
    if (!url || !token || !pass) { syncNote('Fill the gist URL, token and passphrase first.', true); return; }
    if (!window.crypto || !crypto.subtle) { syncNote('Encryption needs a secure context (https or localhost).', true); return; }
    var gid = syncGistId(url);
    if (!gid) { syncNote('That does not look like a gist URL (gist.github.com/…).', true); return; }
    syncNote('Encrypting…');
    // v73.3: deletions sync as tombstones — the ids deleted on THIS phone
    // (and no longer present) ride the push, so a pull on the other side
    // drops them too. A record restored by Undo is back in state, so it is
    // excluded here (and its tombstone was removed).
    var tombs = syncTombRead();
    var liveT = {}, liveP = {};
    state.txns.forEach(function (t) { liveT[t.id] = true; });
    state.plans.forEach(function (p) { liveP[p.id] = true; });
    var removedTxn = tombs.filter(function (x) { return x.k === 't' && !liveT[x.id]; }).map(function (x) { return x.id; });
    var removedPlan = tombs.filter(function (x) { return x.k === 'p' && !liveP[x.id]; }).map(function (x) { return x.id; });
    var obj = { app: 'finances-pwa', syncedAt: new Date().toISOString(),
      base: state.base, txns: state.txns, plans: state.plans,
      owed: state.owed, moneyLog: state.moneyLog,
      removedTxn: removedTxn, removedPlan: removedPlan };
    syncEncrypt(obj, pass).then(function (env) {
      var body = { description: 'Fin.AI encrypted sync (v1)', files: {} };
      body.files[SYNC_FILE] = { content: JSON.stringify(env) };
      var req = { method: 'POST', headers: {
        'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json'
      }, body: JSON.stringify(body) };
      return fetch(gid ? 'https://api.github.com/gists/' + gid : 'https://api.github.com/gists', req)
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error('GitHub ' + r.status + ': ' + t.slice(0, 140)); });
          return r.json();
        });
    }).then(function (g) {
      syncSetCreds(url, token);
      var newUrl = (g && g.html_url) ? g.html_url : url;
      if (byId('syncUrl')) byId('syncUrl').value = newUrl;
      syncNote('Pushed — ' + state.txns.length + ' entries, ' + state.plans.length + ' plans. Ciphertext only; the passphrase never left this phone.');
    })['catch'](function (e) {
      syncNote('Push failed: ' + (e && e.message ? e.message : e), true);
    });
  }
  function syncPull() {
    var url = (byId('syncUrl').value || '').trim();
    var token = (byId('syncToken').value || '').trim();
    var pass = byId('syncPass').value || '';
    if (!url || !token || !pass) { syncNote('Fill the gist URL, token and passphrase first.', true); return; }
    var gid = syncGistId(url);
    if (!gid) { syncNote('That does not look like a gist URL (gist.github.com/…).', true); return; }
    syncNote('Fetching…');
    fetch('https://api.github.com/gists/' + gid, {
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('GitHub ' + r.status + ': ' + t.slice(0, 140)); });
      return r.json();
    }).then(function (g) {
      var f = g && g.files && g.files[SYNC_FILE];
      if (!f) { throw new Error('no ' + SYNC_FILE + ' in that gist — push from this phone first'); }
      var rawUrl = f.raw_url;
      return fetch(rawUrl, { headers: { 'Authorization': 'token ' + token } })
        .then(function (r) { return r.json(); });
    }).then(function (env) {
      syncNote('Decrypting…');
      // the decrypt stage is the only failure left after a successful fetch —
      // WebCrypto's rejection is a generic "Operation error", so name it
      return syncDecrypt(env, pass).then(null, function (e) {
        throw new Error('could not decrypt — wrong passphrase?');
      }).then(function (remote) {
        // v73.3: the merge — per record, newest wins; a tie keeps LOCAL.
        // (The design wall the plan warned about: the rule is timestamp
        //  comparison per record, and it is what the smoke pins below.)
        var local = { base: state.base, txns: state.txns, plans: state.plans,
          owed: state.owed, moneyLog: state.moneyLog };
        var merged = syncMerge(local, remote);
        var prev = { base: cloneObj(state.base || defaultBase()), txns: cloneObj(state.txns || []),
          plans: cloneObj(state.plans || []), owed: cloneObj(state.owed || { people: [], sort: 'recent' }),
          moneyLog: cloneObj(state.moneyLog || []) };
        var puts = [];
        // delete what the merge dropped (tombstoned on the other side)
        var keepT = {}, keepP = {};
        (merged.txns || []).forEach(function (t) { keepT[t.id] = true; });
        (merged.plans || []).forEach(function (p) { keepP[p.id] = true; });
        state.txns.forEach(function (t) { if (!keepT[t.id]) puts.push(idbDel(STORE_TX, t.id)); });
        state.plans.forEach(function (p) { if (!keepP[p.id]) puts.push(idbDel(STORE_PLANS, p.id)); });
        (merged.txns || []).forEach(function (t) { puts.push(idbPut(STORE_TX, t)); });
        (merged.plans || []).forEach(function (p) { puts.push(idbPut(STORE_PLANS, p)); });
        state.txns = merged.txns || [];
        state.plans = merged.plans || [];
        state.owed = merged.owed || { people: [] };
        state.moneyLog = merged.moneyLog || [];
        if (merged.base) state.base = migrateBaseKinds(merged.base);
        return Promise.all(puts).then(function () {
          refreshLocalSnapshot();
          return Promise.all([persistSnapshot(), saveAdj(), saveOwed(),
            idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog }).catch(function () {})]);
        }).then(function () {
          render();
          syncNote('Pulled + merged — ' + state.txns.length + ' entries, ' + state.plans.length + ' plans now on this phone. Newest record won every conflict; ties kept this phone.');
        });
      });
    })['catch'](function (e) {
      syncNote('Pull failed: ' + (e && e.message ? e.message : e), true);
    });
  }
  function importData(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var data = JSON.parse(String(fr.result || ''));
        if (!data || data.app !== 'finances-pwa') throw new Error('not a Fin.AI PWA backup');
        // v72.36 (user: 'return the undo button for all toasts'): import is
        // the one big hammer — it can replace whole books — so its toast gets
        // the strongest Undo: a snapshot of everything this file could touch,
        // taken BEFORE the first write (the baseDirty fold below included).
        // Undo re-files the snapshot.
        var impPrev = {
          base: cloneObj(state.base || defaultBase()),
          txns: cloneObj(state.txns || []),
          plans: cloneObj(state.plans || []),
          owed: cloneObj(state.owed || { people: [], sort: 'recent' }),
          moneyLog: cloneObj(state.moneyLog || []),
          adj: cloneObj(state.adj),
          chat: null // captured where the chat rows are read (before the deletes)
        };
        // v72.23: a PARTIAL backup — `sections` lists what the file holds;
        // restore only those, leave the rest untouched. No `sections`
        // (a pre-72.23 file) = the full v72.8 restore, exactly as before.
        var secs = Array.isArray(data.sections) ? data.sections : null;
        function hasSec(n) { return !secs || secs.indexOf(n) >= 0; }
        // v71: fold any unsaved "Your numbers" edits into state before the
        // import replaces it (readBaseForm is synchronous; no save race).
        if (baseDirty) { var _nb = readBaseForm(); if (_nb) state.base = migrateBaseKinds(_nb); baseDirty = false; }
        var nb = defaultBase();
        if (hasSec('base') && data.base && (data.base.accounts || data.base.salary)) {
          Object.keys(nb).forEach(function (k) { if (data.base[k] !== undefined) nb[k] = data.base[k]; });
          nb.details = sanitizeDetails(nb.details); // v56
          state.base = migrateBaseKinds(nb); // v65
        }
        // v72.8: the full restore. Import now covers everything the export
        // holds — txns, plans, base, owed (+ its sort), the money log, the
        // live overlay, the coach chat thread, and shadowLog (already
        // restored on the first path below) — so a fresh install + import
        // loses nothing, and a mid-lifespan import keeps every tab consistent.
        var saves = [];
        if (hasSec('txns')) state.txns.forEach(function (t) { saves.push(idbDel(STORE_TX, t.id)); });
        if (hasSec('plans')) state.plans.forEach(function (p) { saves.push(idbDel(STORE_PLANS, p.id)); });
        idbAll(STORE_CHAT).then(function (chatRows) {
          impPrev.chat = cloneObj(chatRows || []); // v72.36: the pre-import thread
          if (hasSec('chat')) (chatRows || []).forEach(function (r) { if (r && r.id) saves.push(idbDel(STORE_CHAT, r.id)); });
          return Promise.all(saves);
        }).then(function () {
          var puts = [];
          if (hasSec('txns')) (data.txns || []).forEach(function (t) { if (t && t.id && t.date) puts.push(idbPut(STORE_TX, t)); });
          if (hasSec('plans')) (data.plans || []).forEach(function (p) { if (p && p.id) puts.push(idbPut(STORE_PLANS, p)); });
          if (hasSec('chat')) sanitizeChatRows(data.chat).forEach(function (r) { puts.push(idbPut(STORE_CHAT, r)); });
          return Promise.all(puts);
        }).then(function () {
          // v72.23: restore ONLY the sections this file holds — the others
          // (the phone's own data) stay exactly as they were
          if (hasSec('txns')) state.txns = data.txns || [];
          if (hasSec('plans')) state.plans = data.plans || [];
          var owedPeople = [];
          if (hasSec('owed')) {
            owedPeople = (data.owed || []).filter(function (p) {
              return p && typeof p.name === 'string' && p.name.trim() &&
                (p.entries || []).every(function (e) {
                  return e && e.id && OWED_DIRS[e.dir] && (Number(e.amt) || 0) > 0 && e.d;
                });
            }).map(function (p) {
              return { id: p.id || owedUid('ow'), name: p.name.trim(), entries: p.entries || [],
                updated: typeof p.updated === 'string' ? p.updated : '' }; // v72.7: recent-sort key
            });
            state.owed = { people: owedPeople, sort: owedImportSort(data.owedSort) };
          }
          if (hasSec('log')) {
            var mlRows = sanitizeMoneyLogRows(data.moneyLog);
            state.moneyLog = mlRows;
            state.adj = sanitizeAdj(data.adj);
            state.adjSig = typeof data.adjSig === 'string' ? data.adjSig : snapSig(state.snapshot);
            state.adjLoaded = true;
            if (!data.adj) computeAdjFromTxns(); // v72.8: a pre-72.8 backup has no adj — recompute from the imported txns
            if (hasSec('txns')) migratePayoffModel(); // v72.43: a pre-v72.42 backup's adj still carries the old payoff model (adj + txns come from the same file)
          }
          // v47: persist the base too. The old code re-derived the snapshot from
          // the imported base in memory (and saved the snapshot) but never wrote
          // the base back to IndexedDB, so on the next launch the stale stored
          // base won and the imported accounts / salary / debts disappeared.
          // saveBase() writes base + snapshot + adj through the same path the
          // Settings editor uses, so an import sticks.
          return saveBase(state.base).then(function () {
            if (hasSec('owed')) saveOwed();
            var metaPuts = [];
            if (hasSec('log')) metaPuts = [
              idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog }),
              idbPut(STORE_META, { key: 'adj', value: state.adj }),
              idbPut(STORE_META, { key: 'adjSig', value: state.adjSig })
            ];
            return Promise.all(metaPuts);
          }).then(function () {
            renderBaseEditor();
            renderBaseStatus();
            render();
            // v72.23: the snack names only what this file restored; v72.36:
            // and its Undo re-files the pre-import snapshot (only when the
            // file actually restored something)
            var parts = [];
            if (hasSec('txns')) parts.push((data.txns || []).length + ' entries');
            if (hasSec('plans')) parts.push((data.plans || []).length + ' plans');
            if (hasSec('owed')) parts.push(owedPeople.length + ' owed people');
            if (hasSec('base') && (state.base.migrated_from_snapshot || (data.base && data.base.accounts))) parts.push('numbers restored');
            snack('Imported ' + (parts.length ? parts.join(' \u00b7 ') : 'nothing \u2014 this backup had no sections selected'),
              parts.length ? function () { restoreImportSnapshot(impPrev); } : null);
          });
        });
      } catch (err) {
        snack('Import failed: ' + esc(String((err && err.message) || err)));
      }
    };
    fr.onerror = function () { snack('Import failed: could not read the file.'); };
    fr.readAsText(file);
  }
  // v51: single footer stamp — brand, shell version, and the moment this
  // build went live. Rendered into both footers (page + Settings sheet) from
  // this one source so they can never drift. Bump SHELL_RELEASE together with
  // the sw.js cache on each release.
  var SHELL_RELEASE = { v: 73.11, live: new Date(2026, 8, 25, 22, 2) }; // live re-stamped at each push
  // v72.29 (user edit: 'add a section in settings on What's new with
  // <version> containing plain word changes'): the plain-wording changes per
  // shell version, shown in Settings for the RUNNING version (the closest
  // older known version as fallback). Add a note for every shell release.
  var SHELL_NOTES = {
    '73.11': [
      'The Today headroom is now per CYCLE, not per calendar month — it divides your free cash by the days left until the next salary (the 14th), and the line says where the cycle ends. The eat-out check follows the same per-cycle number'
    ],
    '73.10': [
      'The "month spent" line is finally honest for ANY money-in: a salary-sized inflow (90%+ of your expected salary) no longer swings it, no matter what date you log it — the old check only recognized a salary dated around payday, so logging it later in the month was treated like a refund and the line dropped by the full salary. The salary row still shows no month-spent line; refunds do'
    ],
    '73.9': [
      'The salary row in the ledger no longer shows a "month spent" line at all — the number was already right (it does not move), but the flat "month spent X → X" chip still rendered on it; income is not spend. Refunds still show their line'
    ],
    '73.8': [
      'Logging your salary no longer swings ANY spend number — the "App spend so far" line, spent-today, the donut and the coach note all treat a cash-in as income, not negative spend (v73.7 only fixed the money-log line; refunds still net it down)',
      'The Add sheet gains its third direction — Spend | Pay card | Money in: salary, refunds and any other inflow now have a visible tab (a cash account is preselected; the coach\'s "Salary in" chip lands here too)',
      'The boot screen now holds for 1.5 seconds instead of 2 — Coach Fin still says hi, just faster'
    ],
    '73.7': [
      'Logging your salary no longer swings the "month spent" line — the salary is income, not negative spend (refunds still net it down)',
      'The boot screen now holds for 2 seconds instead of 3 — Coach Fin still says hi, just faster'
    ],
    '73.6': [
      'The app now knows your CC DUE (the 5th): the coming-due strip shows the due date with the amount — charges since the last cutoff minus the prepays you logged in that window — and the coach warns when it is a week out and more than your free cash (that is when his face goes worried)',
      'Settings → Your numbers has a "cc due day" field (5 by default), and the prepay tile now reads cutoff 15 · due 5'
    ],
    '73.5': [
      'Fixed the mood: Coach Fin actually shows it now (worried brows and the smile were coded but never rendered on a phone — the flip was writing to the wrong place)'
    ],
    '73.4': [
      'The Add expense sheet now fits your thumb: Amount and Category share one row, and Paid with and Date share the other — even on a small phone, they no longer stack'
    ],
    '73.3': [
      'Sinking funds now show a progress RING and a pace line — "on pace" when your monthly plan clears the goal by the deadline, "behind by ₱X/mo" when it does not',
      'SYNC through your own GitHub gist: your numbers are encrypted on this phone (AES-GCM, key from your passphrase) before they leave — GitHub only ever sees ciphertext. Push uploads, pull downloads + merges (per record, newest wins; a tie keeps the phone in your hand; deletions sync too). The passphrase is never stored and never sent'
    ],
    '73.2': [
      'Home now opens with your MONEY PULSE — last month in one card (in vs out, your top 3 spends, one line from the coach), and tapping it opens the full recap',
      'The recap lets you PIN A LESSON ("cut food delivery") and it resurfaces in next month\'s recap — you will hear yourself say it',
      'A "coming due" strip on Home shows the next 14 days of plans and prepays at a glance, and a card between 30% and 70% of its limit gets a nudge from the coach (over 70% is when his face goes worried)'
    ],
    '73.1': [
      'Plans can now repeat weekly or yearly too, not just monthly — pick the rhythm when you add one, and the coming-up list shows each repeat on its own date',
      'The coach\'s "looks recurring" read got sharper: it now spots repeats you never wrote a note for (it falls back to the category), only trusts amounts that stay within 5%, and it tells you when something is really WEEKLY — so the one-tap "make it a plan" builds the right kind of plan'
    ],
    '73.0': [
      'Coach Fin now has a mood — his face (the note, the chat, the corner button) goes worried when a card is over 70% of its limit or your month is projected to end in the red, and he flashes a smile when you log your salary or prepay a card',
      'Your free-cash number now counts up from where it was instead of reloading from zero, and the cash graph marks today with a little halo'
    ],
    '72.56': [
      'Coach Fin now looks around everywhere, not just on the loading screen — the little face in your coach note, the chat, and the button in the corner all have moving eyes (and he goes still if your phone asks for reduced motion)'
    ],
    '72.55': [
      'The loading screen now lingers for 3 seconds and Coach Fin looks around while you wait — his eyes dart about during the splash (and he opens the app rarely enough that 3 seconds of coach is worth it)'
    ],
    '72.54': [
      'The loading screen now stays for a full second before fading — a warm boot finishes so fast the splash used to be a flicker, now Coach Fin actually gets to say hi'
    ],
    '72.53': [
      'Fin.AI now wakes up with a loading screen — Coach Fin appears with a short status ("waking up…") while your numbers load, and it fades away the moment the app is ready'
    ],
    '72.52': [
      'The Ledger tab\'s stats now follow your SALARY CYCLE (the 15th to the 14th) instead of the calendar month — the by-category donut and the spend pace both consolidate the current cycle, and the pace compares you against last cycle'
    ],
    '72.51': [
      'Owed split fix: when you filled "I paid for them" with the Total and Theirs only (Mine left blank), your part now lands in the ledger as your spend — it was being quietly dropped'
    ],
    '72.49': [
      'Owed entries can now be split — "I paid for them" and "They paid for me" take Total (the total for both), Mine and Theirs: yours always lands in the ledger as your spend (on the account you pick), and the owed entry keeps the part that is owed (theirs when you paid, yours when they did). Fill in just one part and it is the entry, as before',
      'The "no account" option is gone from the owed form — Cash is the default, so a split "mine" part always lands in the ledger'
    ],
    '72.48': [
      'Each person in the Owed book now has a statement of account — tap "SOA (PDF)" on their card and the full account is saved as a PDF file: every entry in date order with the running balance, and at the end who owes what (or that you are settled)'
    ],
    '72.47': [
      'Card prepays in the ledger now read "CC Payment" instead of "Unsorted" — including the ones you log early for the 14th — and the category filter has its own CC Payment option',
      'The empty "Unsorted" slice is gone from this-month-by-category — a prepay settles the debt, it does not add a spend slice'
    ],
    '72.46': [
      'Your card-utilization question now gets the number in front of the coach — a prepay moves your card balance the moment you log it, so the utilization you are told is the current one, not the old one',
      '"util rate" and "utilization" now hit the built-in rules directly — the answer is instant and works with no signal',
      'When your numbers move, the coach follows the new numbers: the numbers list is current as of now and takes precedence over anything it said earlier in the chat'
    ],
    '72.45': [
      'The coach now reads your real numbers — every card shows its current balance, its credit limit, and how full it is',
      'A partial card prepay keeps its log button on the home card — it shows what is still left to pay',
      'Your salary (on the 15th) is in the projection: the graph shows it landing on payday, the top card says when it is due, and a "Salary in" button logs it the moment it lands — even early',
      'A new "This cycle" block reads your money per salary cycle (the 15th to the 14th): the salary, what went out, what the pace leaves — and the last cycle for comparison'
    ],
    '72.44': [
      'The home card no longer goes blank after you log a card prepay — a typo in the “prepay handled” line stopped the card from drawing its text',
      'A card prepay no longer counts as spending in the summaries (this month by category, spend pace, spent today, the coach note) — it settles the debt, it is not a purchase. A cash-in still nets the spend back down, exactly like the ledger detail already did',
      'The prepay rows in your ledger no longer repeat your free cash (it never moves) — they show the amount and the card balance change only'
    ],
    '72.43': [
      'Your card prepay now counts the same as a new one \u2014 the prepay you logged before the payoff fix comes off your free cash and your liquid cash (the old version had counted it as extra free cash). Your card owed is unchanged'
    ],
    '72.42': [
      'Paying a card no longer adds back to your free cash \u2014 the spend already counted when the card was charged. A card payment now only drops your liquid (bank) cash and your card owed; your free / spendable cash stays exactly where it was',
      'Both numbers stay as before \u2014 the liquidity floor still watches your raw bank cash under the hood'
    ],
    '72.41': [
      'The home card graph\u2019s bottom line is dates all the way now \u2014 the month ticks land on the last day of the month (30 Sep, 31 Oct, \u2026) instead of month names',
      'The Add sheet has a direction: Spend (as before) or Pay card. Pay card logs a card payment \u2014 the payoff that unwinds the card charges \u2014 and the coach\u2019s prepay action is now one button per card, so Maya cc and Maribank cc can each be prepaid separately with that card\u2019s own amount'
    ],
    '72.39': [
      'The home card graph\u2019s bottom line shows its dates now \u2014 start, middle and end as day + month, the months in between by name. The previous releases built this line from a field that was empty, so every label after the first one came out blank and the fix from before never actually appeared',
      'A new test renders the graph itself, so a blank axis can never ship silently again'
    ],
    '72.38': [
      'This What\u2019s new section was missing the last release\u2019s note \u2014 the v72.37 line is here now, and a release check will catch it if a version ever ships without its note'
    ],
    '72.37': [
      'The graph on the home card shows the start, middle and end dates on its bottom line now \u2014 before, only the first one was a date'
    ],
    '72.36': [
      'Every banner that changes something now has an Undo button — including the "Added" one',
      'Importing a backup: Undo on its banner brings back exactly what you had before the import'
    ],
    '72.35': [
      'The little banners are finally where they belong — centered at the top of the screen (an old style fragment had been hiding their positioning in every previous build)'
    ],
    '72.34': [
      'New versions land faster: the app reloads itself the moment an update is ready \u2014 one refresh is all it takes'
    ],
    '72.33': [
      'Ask the coach about one card\u2019s prepay and it answers that card\u2019s number \u2014 not the total across all cards'
    ],
    '72.32': [
      'The little pop-ups are now banners at the top of the screen — like the “new version” one',
      'They stay for 7 seconds, and swiping one up makes it go away right away',
      'Undo is still there, on the banner'
    ],
    '72.31': [
      'Ledger: an Adjustment row has a \u2715 now \u2014 it removes the record and takes the balance override in Your numbers back',
      'Card overrides work the same way \u2014 the card balance goes back, your free cash never moves',
      'The undo is on the toast, as always'
    ],
    '72.30': [
      'Your numbers: set an account\u2019s balance to what it really is \u2014 the difference is filed in the Ledger under \u201CAdjustment\u201D',
      'Owed: the edit form\u2019s Cancel now actually closes the form',
      '\u201CSee less\u201D sits beside \u201CSee more\u201D in Owed and Ledger \u2014 it re-hides 5 at a time',
      '\u201COwed\u201D left the category options (older ledger entries keep it)'
    ],
    '72.29': [
      'Every Owed entry has an Edit button now — including entries added in older versions',
      'Editing an entry opens the form right at that entry, with Save and Cancel',
      'Tap a person\u2019s name on their card to rename them',
      'On the entry form, Category and Account share one row',
      'The category options always include Unsorted, and old categories are kept when your budgets change',
      'Owed and Ledger now show the newest 5 entries first \u2014 \u201CSee more\u201D reveals 5 older ones at a time',
      'New here: this What\u2019s new section in Settings'
    ],
    '72.28': [
      'Owed entries now follow \u201CWhat happened\u201D: only \u201CThey paid for me\u201D adds a ledger entry, under the category you picked',
      '\u201CI paid for them\u201D, \u201CI paid them back\u201D and \u201CThey paid me back\u201D no longer add ledger entries \u2014 the ledger records what was spent, not who owes what',
      'The account you pick on those three is kept on the entry as a note'
    ],
    '72.27': [
      'The Owed entry form shows the short labels only'
    ],
    '72.26': [
      'The coach bot no longer feels bouncy when thrown \u2014 it lands clean'
    ],
    '72.25': [
      'Owed entries can pick which ledger category they land in'
    ],
    '72.24': [
      'The coach bot now really throws \u2014 a fast flick sends it flying to the nearest edge'
    ]
  };
  function shellNotesFor(v) {
    var cur = String(v);
    if (SHELL_NOTES[cur]) return { v: cur, notes: SHELL_NOTES[cur] };
    var best = null;
    Object.keys(SHELL_NOTES).forEach(function (k) {
      if (parseFloat(k) <= parseFloat(cur) && (best === null || parseFloat(k) > parseFloat(best))) best = k;
    });
    return best ? { v: best, notes: SHELL_NOTES[best] } : null;
  }
  function renderWhatNew() {
    var sec = byId('wnSec');
    if (!sec) return;
    var info = shellNotesFor(SHELL_RELEASE.v);
    if (!info) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    var t = byId('wnTitle');
    if (t) t.textContent = 'What\u2019s new in v' + info.v;
    var ul = byId('wnList');
    if (ul) ul.innerHTML = info.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
  }
  function shellStamp() {
    var d = SHELL_RELEASE.live;
    var MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return 'Fin.AI · shell v' + SHELL_RELEASE.v + ' (' + MO[d.getMonth()] + ' ' + d.getDate() +
      ', ' + d.getFullYear() + ' | ' + h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ap + ')';
  }
  function renderFooter() {
    var stamp = shellStamp();
    var el = byId('foot'); if (el) el.innerHTML = stamp;
    var sf = byId('setFoot'); if (sf) sf.innerHTML = stamp;
  }
  var TABS = ['home', 'money', 'ledger', 'owed'];
  var TAB_MIGRATE = { overview: 'money', add: 'ledger', coach: 'home' };
  var shownTab = null;        // pane currently on screen
  // v51: home welcome — time-of-day greeting + today's full date.
  // Re-rendered every time the Home tab is shown, so a midnight crossing (or
  // the next day's open) always lands on a fresh greeting.
  function renderGreet() {
    var el = byId('homeGreet'); if (!el) return;
    var h = byId('greetHello'), d = byId('greetDate');
    var now = new Date();
    var hr = now.getHours();
    var who = (state.base && state.base.name && String(state.base.name).trim()) || 'Hooman';
    var greet = hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' :
      hr < 17 ? 'Good afternoon' : hr < 21 ? 'Good evening' : 'Good night';
    if (h) h.textContent = greet + ', ' + who + '!';
    if (d) d.textContent =
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()] + ', ' +
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()] + ' ' +
      now.getDate() + ', ' + now.getFullYear();
  }
  function setTab(name) {
    if (TAB_MIGRATE[name]) name = TAB_MIGRATE[name];
    if (TABS.indexOf(name) < 0) name = 'home';
    shownTab = name;
    var panes = { home: byId('tab-home'), money: byId('tab-money'), ledger: byId('tab-ledger'), owed: byId('tab-owed') };
    Object.keys(panes).forEach(function (k) {
      if (panes[k]) panes[k].style.display = k === name ? '' : 'none';
    });
    var btns = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = btns[i].getAttribute('data-tab') === name ? 'tab active' : 'tab';
    }
    try { localStorage.setItem(LS_TAB, name); } catch (e) {}
    window.scrollTo(0, 0);
    if (name === 'home') renderGreet();
  }
  // v23: Coach is the floating bot; v24: floating bubble above the FAB;
  // v25: clicking the bot toggles the bubble (open, or close if already open);
  // v26: a tap outside the bubble (the scrim, incl. over the tabs) closes it
  function openCoach() {
    var ov = byId('coachOv');
    if (!ov) return;
    fabPlacePanel(); // v72.15: anchor the panel to the bot BEFORE the scale-in
    ov.classList.add('show');
    var sc = byId('scrim');
    if (sc) sc.classList.add('show');
    if (window.__financeChat && window.__financeChat.open) window.__financeChat.open();
  }
  function closeCoach() {
    var ov = byId('coachOv');
    if (ov) ov.classList.remove('show');
    var sc = byId('scrim');
    if (sc && !openSheetEl) sc.classList.remove('show');
  }
  // ---------- v72.15: the floating bot is draggable AND owns the bubble ----------
  // The chat panel no longer lives at a fixed screen corner. On open it is
  // anchored to the bot's CURRENT position: the side (above / below / left /
  // right) that needs the least clamping wins (above breaks ties — the
  // classic spot), the panel is clamped into the safe area and its scale-in
  // transform-origin aims at the bot. The bot is never hidden while the
  // bubble is open: it docks beside it as the handle — tap the face to close.
  // The gesture is the v72.13 one (pointer drag, >8px = drag, a plain tap
  // still toggles the coach, 1:1 tracking, the scale lift); on release the
  // bot settles to the NEAREST screen EDGE, sliding along it to the finger's
  // spot — the v72.11 four corner snaps + bubble-geometry math are gone.
  // Persistence: fin.fabPos.v2 = { v:2, edge, u } — the edge name plus the
  // normalized 0..1 position along it (resolution-independent, re-derived on
  // resize / orientation). A fin.fabPos.v1 pixel spot migrates once.
  var FAB_POS_KEY = 'fin.fabPos.v2';
  var FAB_POS_V1 = 'fin.fabPos.v1'; // read once for the migration, then orphaned
  var FAB_SIZE = 58, FAB_DRAG_THRESH = 8, FAB_PANEL_GAP = 10, FAB_PANEL_M = 12;
  // v72.17: flick momentum — a fast release projects the bot's center forward
  // this long into the finger's velocity before the edge settle; below
  // FAB_FLICK_MIN (px/ms) a release is a slow drop and settles by position.
  // v72.22: 150 -> 320. v72.24: 320 -> 420 and a fast THROW flight: FAB_FLY_MS
  // is the SHORT projection the fast launch ends at; FAB_FLICK_STALE_MS — a
  // release this long after the last finger move has no momentum (a held
  // pause, not a flick). v72.26: the bounce (squash/overshoot) is gone — the
  // flight is a clean two-segment ease-out that lands exactly on the settle.
  var FAB_FLICK_MS = 420, FAB_FLICK_MIN = 0.4, FAB_FLY_MS = 170, FAB_FLICK_STALE_MS = 80;
  // v72.22: the follow-lag — while dragging the bot trails the finger with a
  // small exponential smoothing (rAF, ~50ms time constant) instead of 1:1
  // tracking, so it reads as following, not welded to the finger
  var FAB_LAG_MS = 50;
  var fabLagRaf = 0;
  // v72.22: one step of the follow-lag — move `cur` partway toward `target`
  // (exponential smoothing, tc = time constant in ms). dt >= tc or tc <= 0
  // snaps all the way (instant = the reduced-motion path)
  function fabLagEase(cur, target, dt, tc) {
    var k = tc <= 0 ? 1 : Math.min(1, dt / tc);
    return cur + (target - cur) * k;
  }
  var FAB_EDGES = ['left', 'right', 'top', 'bottom'];
  // v72.13: the smoothness pass — while dragging, left/top track the finger
  // 1:1 (NO left/top transition; only the transform animates, so the
  // scale-up reads as a "lift"). On release, and on the resize/orientation
  // settle, left/top GLEIDE to the edge over ~.28s ease-out instead of the
  // v72.11 teleport (transition:'none' + jump = the "stiff" feel).
  // v72.16: the settle overshoot — the transform (lift scale-down) runs a
  // slight overshoot bezier so the bot settles past scale 1 and catches, a
  // small pop. left/top stay ease-out: the bot must never cross the edge.
  var FAB_GLIDE = 'left .28s cubic-bezier(.2,.8,.25,1), top .28s cubic-bezier(.2,.8,.25,1), transform .2s cubic-bezier(.3,1.4,.5,1)';
  // v72.16: the reduced-motion fallback — instant settle, no glide, no overshoot
  function fabReduceMotion() {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function fabGlide() { var f = byId('coachFab'); if (f) f.style.transition = FAB_GLIDE; }
  function fabHold() { var f = byId('coachFab'); if (f) f.style.transition = 'transform .15s ease'; }
  // v72.24: the THROW animation (WAAPI keyframes on left/top/transform) —
  // the running one, so a grab / resize can cancel it mid-flight
  var fabFlightAnim = null;
  function fabFlightCancel() {
    if (fabFlightAnim) { try { fabFlightAnim.cancel(); } catch (e) {} fabFlightAnim = null; }
  }
  // v72.26: the bouncy feel is GONE (user: 'remove the bouncy feel of the
  // bubble') — no scale squash/stretch, no along-edge overshoot. The flight
  // is a clean two-segment ease-out: a fast launch to the fly point, then a
  // decelerating run into the settle point, landing exactly there. Duration
  // scales with the travel so a hard flick reads fast and a soft one doesn't
  // crawl.
  function fabFlightStart(fab, g, fromL, fromT) {
    var d = Math.sqrt(Math.pow(g.settle.x - fromL, 2) + Math.pow(g.settle.y - fromT, 2));
    var dur = Math.max(300, Math.min(750, 300 + d * 0.45));
    var px = function (p) { return p + 'px'; };
    var kf = [
      { left: px(fromL), top: px(fromT), offset: 0, easing: 'cubic-bezier(.14,.86,.24,1)' },
      { left: px(g.fly.x), top: px(g.fly.y), offset: 0.38, easing: 'cubic-bezier(.22,.61,.36,1)' },
      { left: px(g.settle.x), top: px(g.settle.y), offset: 1 }
    ];
    var land = function () {
      fabFlightAnim = null;
      fab.style.left = px(g.settle.x);
      fab.style.top = px(g.settle.y);
      fabHold();
    };
    try {
      fabFlightAnim = fab.animate(kf, { duration: dur });
      fabFlightAnim.onfinish = land;
    } catch (e) { fabFlightAnim = null; fabGlide(); land(); } // no WAAPI: plain glide
  }
  // the safe area — env() insets aren't readable from JS, so measure them
  // with a 0-width sentinel (status bar top, home inset bottom); the 88px
  // tab bar + 16px side gutters keep the bot off the controls
  function fabSafe() {
    var top = 0, bottom = 0;
    try {
      var el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:0;top:0;width:0;visibility:hidden;';
      document.body.appendChild(el);
      el.style.height = 'env(safe-area-inset-top)';
      top = Math.max(0, el.getBoundingClientRect().height);
      el.style.height = 'env(safe-area-inset-bottom)';
      bottom = Math.max(0, el.getBoundingClientRect().height);
      if (el.parentNode) el.parentNode.removeChild(el);
    } catch (e) {}
    return { left: 16, right: 16, top: top + 12, bottom: 88 + bottom };
  }
  // edge + u (0..1 along the edge) -> the bot's top-left px
  function fabEdgePos(edge, u, s) {
    s = s || fabSafe();
    var vw = window.innerWidth, vh = window.innerHeight;
    var tv = Math.max(0, vh - s.top - s.bottom - FAB_SIZE);
    var th = Math.max(0, vw - s.left - s.right - FAB_SIZE);
    var x, y;
    if (edge === 'left') { x = s.left; y = s.top + u * tv; }
    else if (edge === 'right') { x = vw - s.right - FAB_SIZE; y = s.top + u * tv; }
    else if (edge === 'top') { y = s.top; x = s.left + u * th; }
    else { y = vh - s.bottom - FAB_SIZE; x = s.left + u * th; }
    return { x: Math.round(x), y: Math.round(y) };
  }
  // the screen edge nearest a point (distances to the viewport borders)
  function fabNearestEdge(cx, cy) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var d = [['left', cx], ['right', vw - cx], ['top', cy], ['bottom', vh - cy]];
    d.sort(function (a, b) { return a[1] - b[1]; });
    return d[0][0];
  }
  // a point (the bot's center at release) -> { edge, u }
  function fabEdgeFromPoint(cx, cy) {
    var s = fabSafe();
    var e = fabNearestEdge(cx, cy);
    var tv = Math.max(0, window.innerHeight - s.top - s.bottom - FAB_SIZE);
    var th = Math.max(0, window.innerWidth - s.left - s.right - FAB_SIZE);
    var u = (e === 'left' || e === 'right')
      ? (tv ? (cy - s.top) / tv : 0)
      : (th ? (cx - s.left) / th : 0);
    return { edge: e, u: Math.max(0, Math.min(1, u)) };
  }
  function fabPosSave(pos) {
    try {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify({ v: 2, edge: pos.edge, u: Math.round(pos.u * 1000) / 1000 }));
    } catch (e) {}
  }
  // v72.24: the flick THROW geometry (pure — the smoke drives it). The bot's
  // top-left is (fromL, fromT), already clamped into the safe area s of a
  // vw x vh viewport; the finger's release velocity is (vx, vy) px/ms:
  //  fly    = from + v*FAB_FLY_MS, clamped — where the fast launch ends
  //  settle = the edge + u from the LONGER projection (v*FAB_FLICK_MS) — the
  //           spot the momentum carries the bot to. v72.26: the bounce point
  //           is gone (the bouncy feel was removed) — the flight lands
  //           exactly on the settle.
  function fabFlickGeo(s, vw, vh, fromL, fromT, vx, vy) {
    var fx = Math.max(s.left, Math.min(fromL + vx * FAB_FLY_MS, vw - s.right - FAB_SIZE));
    var fy = Math.max(s.top, Math.min(fromT + vy * FAB_FLY_MS, vh - s.bottom - FAB_SIZE));
    var m = fabEdgeFromPoint(fromL + FAB_SIZE / 2 + vx * FAB_FLICK_MS, fromT + FAB_SIZE / 2 + vy * FAB_FLICK_MS);
    var sp = fabEdgePos(m.edge, m.u, s);
    return { edge: m.edge, u: m.u, settle: sp, fly: { x: fx, y: fy } };
  }
  function fabPosLoad() {
    try {
      var v = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
      if (v && v.v === 2 && FAB_EDGES.indexOf(v.edge) >= 0 && isFinite(v.u)) {
        return { edge: v.edge, u: Math.max(0, Math.min(1, v.u)) };
      }
    } catch (e) {}
    // one-time migration: a v1 spot was raw px at whatever viewport it was
    // saved on — re-home it to the nearest edge + along-edge position
    try {
      var o = JSON.parse(localStorage.getItem(FAB_POS_V1) || 'null');
      if (o && isFinite(o.x) && isFinite(o.y)) {
        var m = fabEdgeFromPoint(o.x + FAB_SIZE / 2, o.y + FAB_SIZE / 2);
        fabPosSave(m);
        return m;
      }
    } catch (e) {}
    return null;
  }
  // place the bot on its persisted edge+u (default = the old bottom-right
  // spot: bottom edge, u=1 = right side). instant = land without a glide.
  function fabSettle(instant) {
    var fab = byId('coachFab');
    if (!fab) return null;
    var pos = fabPosLoad() || { edge: 'bottom', u: 1 };
    var p = fabEdgePos(pos.edge, pos.u);
    // v72.16: prefers-reduced-motion -> instant settle (no glide, no overshoot)
    if (fabReduceMotion()) { fab.style.transition = 'none'; }
    else if (instant) { fabHold(); } else { fabGlide(); } // v72.13: the settle glides
    fab.style.right = 'auto';
    fab.style.left = p.x + 'px';
    fab.style.top = p.y + 'px';
    return p;
  }
  function fabSettleAny() {
    fabFlightCancel(); // a running throw must not fight the resize settle
    var ov = byId('coachOv');
    var open = ov && ov.classList.contains('show');
    fabSettle(open); // glides when closed; instant + re-anchor while the bubble is open
    if (open) fabPlacePanel();
  }
  // the open panel's ideal slot on each side, anchored to the bot's face
  function fabPanelCandidates(fab, ov) {
    if (!fab || !ov) return null;
    var W = ov.offsetWidth, H = ov.offsetHeight;
    var r = fab.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return {
      W: W, H: H,
      above: { x: cx - W / 2, y: r.top - FAB_PANEL_GAP - H },
      below: { x: cx - W / 2, y: r.bottom + FAB_PANEL_GAP },
      left: { x: r.left - FAB_PANEL_GAP - W, y: cy - H / 2 },
      right: { x: r.right + FAB_PANEL_GAP, y: cy - H / 2 }
    };
  }
  // v72.21: pick the panel's side — the chosen side keeps a HARD gap
  // (FAB_PANEL_GAP) between the panel and the bot's face on that axis: the
  // panel must never cover the bot (a clamped panel used to intrude onto it).
  // A side that can't respect the gap inside the safe bounds b is infeasible
  // and skipped (order above/below/left/right — above wins ties).
  // allowCover = the tiny-screen fallback, where the v72.18 z-order (bot in
  // front) is the safety net instead.
  function fabPanelPick(c, r, b, allowCover) {
    var order = ['above', 'below', 'left', 'right'];
    var best = null;
    for (var i = 0; i < order.length; i++) {
      var side = order[i];
      var p = c[side];
      var px = Math.max(b.minX, Math.min(p.x, b.maxX));
      var py = Math.max(b.minY, Math.min(p.y, b.maxY));
      if (!allowCover) {
        if (side === 'above' && py + c.H > r.top - FAB_PANEL_GAP) continue;
        if (side === 'below' && py < r.bottom + FAB_PANEL_GAP) continue;
        if (side === 'left' && px + c.W > r.left - FAB_PANEL_GAP) continue;
        if (side === 'right' && px < r.right + FAB_PANEL_GAP) continue;
      }
      var d = Math.abs(p.x - px) + Math.abs(p.y - py);
      if (!best || d < best.d) best = { side: side, x: px, y: py, d: d };
    }
    return best;
  }
  // anchor the open panel to the bot: the side needing the least clamping
  // wins (above first on a tie), clamp into the safe area, aim the scale-in
  // origin at the bot
  function fabPlacePanel() {
    var fab = byId('coachFab'), ov = byId('coachOv');
    if (!fab || !ov) return null;
    var c = fabPanelCandidates(fab, ov);
    if (!c) return null;
    var s = fabSafe();
    var b = {
      minX: s.left + FAB_PANEL_M, minY: s.top + FAB_PANEL_M,
      maxX: Math.max(s.left + FAB_PANEL_M, window.innerWidth - s.right - FAB_PANEL_M - c.W),
      maxY: Math.max(s.top + FAB_PANEL_M, window.innerHeight - s.bottom - FAB_PANEL_M - c.H)
    };
    var r = fab.getBoundingClientRect();
    // v72.21: never cover the bot; only if no side can keep the gap (tiny
    // screen) fall back to plain least-clamping — the z-order covers that
    var best = fabPanelPick(c, r, b, false) || fabPanelPick(c, r, b, true);
    if (!best) return null;
    ov.style.right = 'auto';
    ov.style.bottom = 'auto';
    ov.style.left = Math.round(best.x) + 'px';
    ov.style.top = Math.round(best.y) + 'px';
    var origin = { above: '50% 100%', below: '50% 0%', left: '100% 50%', right: '0% 50%' };
    ov.style.transformOrigin = origin[best.side];
    return best;
  }
  function fabInitDrag() {
    var fab = byId('coachFab');
    if (!fab || fabInitDrag.wired) return;
    fabInitDrag.wired = true;
    fabSettle(true); // first paint: land on the persisted edge, no glide
    window.addEventListener('resize', fabSettleAny);
    window.addEventListener('orientationchange', fabSettleAny);
    var st = null;
    // v72.22: the follow-lag loop — each frame the bot moves partway toward
    // the finger's (safe-area clamped) target via fabLagEase, so it TRAILS
    // the finger instead of being welded to it. The flick velocity is sampled
    // from the FINGER in pointermove, never from the lagged position.
    function fabLagStep() {
      fabLagRaf = 0;
      if (!st || !st.drag) return;
      var f = byId('coachFab');
      if (!f) return;
      var s = fabSafe();
      st.tx = Math.max(s.left, Math.min(st.tx, window.innerWidth - s.right - FAB_SIZE));
      st.ty = Math.max(s.top, Math.min(st.ty, window.innerHeight - s.bottom - FAB_SIZE));
      st.curL = fabLagEase(st.curL, st.tx, Date.now() - st.lastFrame, fabReduceMotion() ? 0 : FAB_LAG_MS);
      st.curT = fabLagEase(st.curT, st.ty, Date.now() - st.lastFrame, fabReduceMotion() ? 0 : FAB_LAG_MS);
      f.style.left = st.curL + 'px';
      f.style.top = st.curT + 'px';
      st.lastFrame = Date.now();
      fabLagRaf = requestAnimationFrame(fabLagStep);
    }
    function fabLagStart() { if (!fabLagRaf) fabLagRaf = requestAnimationFrame(fabLagStep); }
    function fabLagStop() { if (fabLagRaf) { cancelAnimationFrame(fabLagRaf); fabLagRaf = 0; } }
    fab.addEventListener('pointerdown', function (ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      fabFlightCancel(); // v72.24: grabbing mid-flight stops the throw
      fabHold(); // v72.13: kill the left/top glide — the lag loop writes left/top raw
      var r = fab.getBoundingClientRect();
      st = { x: ev.clientX, y: ev.clientY, left: r.left, top: r.top, drag: false,
             tx: r.left, ty: r.top, curL: r.left, curT: r.top,
             vx: 0, vy: 0, lastX: ev.clientX, lastY: ev.clientY, lastT: Date.now(),
             lastFrame: Date.now() };
      if (fab.setPointerCapture) { try { fab.setPointerCapture(ev.pointerId); } catch (e) {} }
    });
    fab.addEventListener('pointermove', function (ev) {
      if (!st) return;
      var dx = ev.clientX - st.x, dy = ev.clientY - st.y;
      if (!st.drag && Math.sqrt(dx * dx + dy * dy) > FAB_DRAG_THRESH) {
        st.drag = true;
        // v72.16: a barely-there tick the moment the drag starts (guarded —
        // navigator.vibrate is absent on iOS Safari and in the smoke stub)
        try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
      }
      if (!st.drag) return; // under the threshold this is still a tap
      // v72.17: keep the last move sample — the release flicks with velocity
      var now = Date.now();
      var dt = now - st.lastT;
      if (dt > 0 && dt < 100) { st.vx = (ev.clientX - st.lastX) / dt; st.vy = (ev.clientY - st.lastY) / dt; }
      st.lastX = ev.clientX; st.lastY = ev.clientY; st.lastT = now;
      ev.preventDefault();
      fab.classList.add('dragging');
      // v72.22: the finger only sets the TARGET — the lag loop (rAF) trails
      // it with the ~50ms exponential smoothing; safe-area clamping happens
      // inside the loop, so the bot can never reach the status/tab bars
      st.tx = st.left + (ev.clientX - st.x);
      st.ty = st.top + (ev.clientY - st.y);
      fabLagStart();
    });
    function release(ev) {
      if (!st) return;
      var wasDrag = st.drag;
      var rel = st;
      st = null;
      if (wasDrag) {
        fabLastDragAt = Date.now(); // a click right after a drag must NOT open the coach
        fabLagStop();
        fabFlightCancel(); // a grab interrupts a running throw
        // v72.22: the flick starts from where the FINGER is (the bot was
        // trailing it); the projection uses the FINGER velocity (v72.17)
        var s = fabSafe();
        var vw = window.innerWidth, vh = window.innerHeight;
        var tx = Math.max(s.left, Math.min(rel.tx, vw - s.right - FAB_SIZE));
        var ty = Math.max(s.top, Math.min(rel.ty, vh - s.bottom - FAB_SIZE));
        // v72.24: momentum must be FRESH — if the finger sat still before
        // the lift, it's a held drop, not a flick
        var vx = rel.vx, vy = rel.vy;
        if (Date.now() - rel.lastT > FAB_FLICK_STALE_MS) { vx = 0; vy = 0; }
        var sp = Math.sqrt(vx * vx + vy * vy);
        var ov = byId('coachOv');
        var open = ov && ov.classList.contains('show');
        if (sp > FAB_FLICK_MIN && !open && !fabReduceMotion() && fab.animate) {
          // v72.24: the THROW — fly fast to the short projection, then ease
          // out to the edge settle. v72.26: no bounce — it lands exactly.
          // The animation starts from the bot's RENDERED spot (it trailed
          // the finger).
          var g = fabFlickGeo(s, vw, vh, tx, ty, vx, vy);
          fabPosSave(g);
          var r0 = fab.getBoundingClientRect();
          fabFlightStart(fab, g, r0.left, r0.top);
        } else {
          // open bubble (instant + re-anchor), reduced motion (instant) or a
          // slow drop: snap to the finger, project by velocity, glide settle
          fab.style.left = tx + 'px';
          fab.style.top = ty + 'px';
          var cx = tx + FAB_SIZE / 2, cy = ty + FAB_SIZE / 2;
          if (sp > FAB_FLICK_MIN) { cx += vx * FAB_FLICK_MS; cy += vy * FAB_FLICK_MS; }
          var m = fabEdgeFromPoint(cx, cy);
          fabPosSave(m);
          fabSettle(!!open); // v72.13 glide when closed; instant while the bubble is open…
          if (open) fabPlacePanel(); // …so the bubble tracks the bot it was just moved
        }
      }
      fab.classList.remove('dragging');
    }
    fab.addEventListener('pointerup', release);
    fab.addEventListener('pointercancel', release);
  }
  var fabLastDragAt = 0;
  // v47: open the coach and kick off the guided "set up my numbers" conversation.
  // Used by the empty-state "Set up with the coach" buttons (Home, Your numbers,
  // Settings). The chat itself owns the prompt; here we just bring the coach up.
  function startSetup() {
    closeSheets();
    openCoach();
    if (window.__financeChat && typeof window.__financeChat.startSetup === 'function') {
      window.__financeChat.startSetup();
    }
  }
  function currentTab() {
    if (!state.snapshot) return 'home';
    try {
      var t = localStorage.getItem(LS_TAB);
      if (TAB_MIGRATE[t]) t = TAB_MIGRATE[t];
      if (TABS.indexOf(t) >= 0) return t;
    } catch (e) {}
    return 'home';
  }
  // v63: the category options come from "Your numbers" — the base monthly
  // budgets, in the order they are listed there. No budgets yet → the options
  // are empty and "Unsorted" (value '' = no category) is the default choice.
  function seedCategories() {
    var sel = byId('f_category');
    if (!sel) return;
    var names = Object.keys((state.base && state.base.budgets) || {})
      .filter(function (n) { return String(n).trim(); });
    // v72.30 (user: 'remove the Owed from the category'): 'Owed' is out of the
    // options — tpf files under the picked category ('Unsorted' fallback)
    // since v72.28; old 'Owed' ledger rows keep their data (no migration)
    var sig = names.join('|');
    if (sig === catSig) return;
    catSig = sig;
    var cur = sel.value;
    var html = '<option value=""' + (cur ? '' : ' selected') + '>Unsorted</option>';
    names.forEach(function (c) {
      html += '<option value="' + esc(c) + '"' + (cur === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    });
    sel.innerHTML = html;
  }
  // ---------- v68 item 1: learned merchant→category map ----------
  // The map is ALWAYS recomputed from the logged txns (note words → the
  // category the txn was actually filed under). Meta stores only the
  // user's overrides from Your numbers: 'deleted' hides an entry from
  // auto-categorization, 'blocked' hard-blocks it (e.g. a note word that
  // collides with something else). Neither flag writes anything — they only
  // change how the coach files future entries.
  var MERCHANT_MAP_KEY = 'merchantMap';
  function normMerchant(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function merchantOv() {
    var v = state.merchantMap;
    return { deleted: (v && v.deleted) || {}, blocked: (v && v.blocked) || {} };
  }
  function learnedMerchantCat() {
    var counts = {};
    (state.txns || []).forEach(function (t) {
      var nm = normMerchant(t.note);
      var cat = String(t.category || '').trim();
      if (!nm || !cat) return;
      var c = (counts[nm] = counts[nm] || {});
      c[cat] = (c[cat] || 0) + 1;
    });
    var out = {};
    Object.keys(counts).forEach(function (nm) {
      var total = 0, best = null, bestN = 0;
      Object.keys(counts[nm]).forEach(function (cat) {
        total += counts[nm][cat];
        if (counts[nm][cat] > bestN) { bestN = counts[nm][cat]; best = cat; }
      });
      // only learn what is certain: at least 2 logs and a clear majority
      if (best && bestN >= 2 && bestN * 2 >= total) out[nm] = { cat: best, n: bestN };
    });
    return out;
  }
  function effectiveMerchantMap() {
    var learned = learnedMerchantCat(), ov = merchantOv(), out = {};
    Object.keys(learned).forEach(function (nm) {
      if (!ov.deleted[nm] && !ov.blocked[nm]) out[nm] = learned[nm];
    });
    return out;
  }
  function merchantCatFor(note) {
    var nm = normMerchant(note);
    if (!nm) return null;
    var e = effectiveMerchantMap()[nm];
    return e ? e.cat : null;
  }
  function toggleMerchantFlag(nm, flag) {
    commitIfDirtyBase(); // v71: renderBaseEditor below wipes the form — commit first
    var ov = merchantOv();
    if (ov[flag][nm]) delete ov[flag][nm]; else ov[flag][nm] = 1;
    state.merchantMap = ov;
    idbPut(STORE_META, { key: MERCHANT_MAP_KEY, value: ov }).catch(function () {});
    renderBaseEditor();
  }
  // v68 item 11: shadow mode — every chat message logs its answering path
  // (rule intent / llm / fallback) + what was drafted; capped at 200 in a meta
  // key and included in the JSON export — the rule-coverage evidence.
  var SHADOW_KEY = 'shadowLog';
  var SHADOW_CAP = 200;
  function shadowLog(entry) {
    if (!entry || !entry.path) return;
    state.shadowLog = state.shadowLog || [];
    state.shadowLog.push({ at: entry.at || Date.now(), t: String(entry.t || '').slice(0, 120), path: entry.path, a: String(entry.a || '').slice(0, 200) });
    if (state.shadowLog.length > SHADOW_CAP) state.shadowLog = state.shadowLog.slice(-SHADOW_CAP);
    idbPut(STORE_META, { key: SHADOW_KEY, value: state.shadowLog }).catch(function () {});
  }
  // Add-sheet prefill: only when nothing is selected yet (Unsorted) and the
  // learned category is still one of the real budget options.
  function autoCatFromNote(noteEl) {
    var sel = byId('f_category');
    if (!sel || sel.value) return;
    var cat = merchantCatFor(noteEl.value);
    if (!cat) return;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === cat) { sel.value = cat; return; }
    }
  }
  // v68 item 9: the active coach alerts, for the chat's dynamic chips
  // v69: + prepayDay / topCat so the standing chips derive from the stored
  // numbers (real prepay day, biggest budget) instead of a fixed string
  function coachAlerts() {
    var d = insightsData();
    if (!d) return null;
    var info = coachRows(d);
    var tb = (state.base && state.base.budgets) || {};
    var topCat = null, tbv = 0;
    Object.keys(tb).forEach(function (k) { if (Number(tb[k]) > tbv) { tbv = Number(tb[k]); topCat = k; } });
    return {
      alerts: info.alerts, recurring: (d.recurringGuess || [])[0] || null,
      prepayIn: d.prepayIn, prepayAmt: d.prepayAmt,
      prepayDay: d.prepayDay, topCat: topCat
    };
  }
  // v68 item 12: the top deterministic findings, for the Coach's-note prompt —
  // the LLM phrases findings instead of re-deriving them from raw numbers;
  // the deterministic coach rows stay the offline default (they render on
  // Home regardless of whether the coach is available).
  function coachFindings() {
    try {
      var d = insightsData();
      if (!d) return [];
      var info = coachRows(d);
      return ((info && info.rows) || []).slice(0, 3).map(function (r) { return r.tag + ': ' + r.text; });
    } catch (e) { return []; }
  }
  function render() { emit('ui'); if (window.__financeChat && window.__financeChat.refreshChips) window.__financeChat.refreshChips(); }

  // ---------- bridge for chat.js (the chat writes through the app's own actions) ----------
  window.FinApp = {
    addPlan: addPlan,
    deletePlan: deletePlan,
    addTxn: addTxn,
    deleteTxn: deleteTxn,
    saveTxnEdit: saveTxnEdit, // v71: editable ledger entries
    // v72.10: the owed flow (smoke drives the real paths) + the effective
    // numbers (the free-cash / card-owed math the owed entries recompute)
    addOwedPerson: addOwedPerson,
    addOwedEntry: addOwedEntry,
    updateOwedEntry: updateOwedEntry,
    owedCatOptions: owedCatOptions, // v72.25: the entry's category options (smoke drives it)
    owedPersonHTML: owedPersonHTML, // v72.29: the person card render (smoke drives it — the edit button on every row)
    oentFormHTML: oentFormHTML, // v72.29: the entry form's inner html (smoke drives it — the in-place edit form)
    soaRows: soaRows, // v72.48: the SOA running-balance table (smoke drives the math)
    soaPdf: soaPdf, // v72.48: the rendered statement PDF text (smoke verifies structure: xref, pages, amounts)
    exportOwedSoa: exportOwedSoa, // v72.48: the per-person SOA download (smoke drives it)
    owedSplit: owedSplit, // v72.49: the mine/theirs/total split (smoke drives the table)
    shellNotesFor: shellNotesFor, // v72.29: the What's-new notes for a version (smoke drives it)
    addSheetKind: addSheetKind, // v72.41: the Add-sheet kind decision (smoke drives it — the submit is DOM-bound)
    // v72.38: the running shell dot (smoke drives the What's-new fallback
    // check). v73.0: the dot SURVIVES — 73.0 is a whole number, so String()
    // prints "73" while the SHELL_NOTES key is "73.0"; re-append a dropped
    // ".0" (72.56-style dots are untouched).
    shellVersion: (function () { var s = String(SHELL_RELEASE.v); return s.indexOf('.') < 0 ? s + '.0' : s; })(),
    hideBoot: hideBoot, // v72.53: the boot-splash fade (smoke drives the real path)
    bootTicker: bootTicker, // v72.53: the status-line cycle (smoke drives it)
    renderMood: renderMood, // v73.0: the coach's mood (smoke drives it)
    setMood: setMood, // v73.0: force a mood (smoke drives it)
    computeMood: computeMood, // v73.0: the mood decision (smoke drives it)
    happyMoodFlash: happyMoodFlash, // v73.0: the good-moment smile (smoke drives it)
    render: render, // v73.0: the full re-render (the smoke reads the sparkline after)
    detectRecurring: detectRecurring, // v73.1: the recurring detector (pure — the smoke drives it)
    planOccurrences: planOccurrences, // v73.1: the occurrence math (weekly/annual)
    coachRows: coachRows, // v73.2: the coach card's raw rows (the smoke reads the util nudge before the top-5 cut)
    insightsData: insightsData, // v73.2: the insight math (coachRows' input)
    goalPace: goalPace, // v73.3: the goal pace (pure — the smoke drives it)
    syncEncrypt: syncEncrypt, // v73.3: the envelope (the smoke round-trips it)
    syncDecrypt: syncDecrypt, // v73.3: decrypt the envelope (the smoke round-trips it)
    syncMerge: syncMerge, // v73.3: the merge rule (pure — the smoke drives it)
    recapData: recapData, // v73.2: the money-pulse math (pure — the smoke drives it)
    pinLesson: pinLesson, // v73.2: the pinned lesson (the smoke drives it)
    readLesson: readLesson, // v73.2: read the pinned lesson (the smoke drives it)
    bootNow: function () { return Date.now() - bootT0; }, // v72.54: ms since boot (smoke pins the clock)
    owedShown: owedShown, // v72.30: the per-person See more/less page (smoke drives the paging render)
    getBase: function () { return state.base; }, // v72.30: the current base (smoke reads account values for the override test)
    askDeleteAdjustment: askDeleteAdjustment, // v72.31: the ✕ on an Adjustment row (smoke drives it; the stub has no confirm dialog → auto-yes)
    deleteAdjustment: deleteAdjustment, // v72.31: the undo itself (row out + the Settings value reversed, no new filing)
    saveBase: saveBase, // v72.31: a base save (smoke: remove the account for the gone-account path)
    renderBaseEditor: renderBaseEditor, // v73.6: the base editor render (smoke: the cc due day input)
    delOwedEntry: delOwedEntry,
    delOwedPerson: delOwedPerson,
    effectiveSnap: effectiveSnap,
    payoffModelDelta: payoffModelDelta, // v72.43: the pure old→new overlay delta (smoke drives it)
    migratePayoffModel: migratePayoffModel, // v72.43: the one-shot persisted-overlay migration (smoke drives it)
    getAdj: function () { return state.adj; }, // v72.43: the live overlay (smoke simulates a pre-v72.42 phone)
    setAdj: function (a) { state.adj = a; }, // v72.43: test hook (smoke)
    getTxns: function () { return state.txns; }, // v72.43: the ledger txns (smoke sums the old prepays)
    // v72.15: the FAB edge-settle + bubble-anchor geometry (smoke drives the pure math)
    fabSafe: fabSafe,
    fabEdgePos: fabEdgePos,
    fabNearestEdge: fabNearestEdge,
    fabEdgeFromPoint: fabEdgeFromPoint,
    fabPanelCandidates: fabPanelCandidates,
    fabPanelPick: fabPanelPick,
    fabLagEase: fabLagEase,
    fabFlickGeo: fabFlickGeo, // v72.24: the throw geometry (smoke drives it)
    fabPlacePanel: fabPlacePanel,
    fabPosSave: fabPosSave,
    fabPosLoad: fabPosLoad,
    fabSettle: fabSettle,
    mlDate: mlDate,           // v71: ledger row date+time (AM/PM)
    applyBaseChanges: applyBaseChanges,
    undoBaseStory: undoBaseStory,
    spendOf: spendOf, // v72.44: the one spend rule for aggregates (chat.js coach snapshot + smoke)
    salaryDayOf: salaryDayOf, // v72.45: the payday (the 15th) with the cutoff fallback
    monthEffect: monthEffect, // v73.7: the month-spent effect (salary-aware — smoke drives it)
    salaryTxnIdInMonth: salaryTxnIdInMonth, // v73.7: the cycle's own salary cash_in id (smoke drives it)
    salaryIsTxn: salaryIsTxn, // v73.10: the amount-based salary identity (smoke drives it)
    expectedSalaryFor: expectedSalaryFor, // v72.45: the cycle's expected salary (override or base)
    cycleDataFor: cycleDataFor, // v72.45: the cycle math for a given cycle month (smoke drives it)
    cycleData: cycleData, // v72.45: the current cycle (chat.js snapshot + smoke)
    ccDueData: ccDueData, // v73.6: the cc-due math (pure — the smoke drives it with a seeded ledger)
    ccDue: ccDue, // v73.6: the current cc due (chat.js snapshot + smoke)
    merchantCatFor: merchantCatFor, // v68 item 1: learned merchant→category lookup for the coach
    effectiveMerchantMap: effectiveMerchantMap,
    coachAlerts: coachAlerts, // v68 item 9: alert-driven chat chips
    coachFindings: coachFindings, // v68 item 12: findings for the Coach's-note prompt
    shadowLog: shadowLog, // v68 item 11: shadow-mode answering-path log
    exportData: exportData, // v68 item 11: lets the smoke read what the JSON export contains
    backupSelRead: backupSelRead, // v72.23: the Backup "what to include" choice (smoke)
    importData: importData, // v72.8: the full-restore path (smoke)
    snack: snack,
    render: render,
    setTab: setTab,
    closeCoach: closeCoach,
    openSettings: function () { openSheet('setSheet'); },
    openNumbers: function () { openSheet('numSheet'); },
    startSetup: startSetup,
    idbAll: idbAll,
    idbPut: idbPut,
    idbDel: idbDel,
    STORE_CHAT: STORE_CHAT,
    STORE_PLANS: STORE_PLANS,
    STORE_TX: STORE_TX,
    STORE_META: STORE_META
  };

  // ---------- v72.53: the boot splash (design C — Coach Fin + status ticker) ----------
  // The overlay is static HTML in index.html (shown by default); init() fades
  // it out when the first render lands. The status line cycles on a timer and
  // the bar is INDETERMINATE — init() reports no progress, so the words are
  // flavor and the bar never claims a percentage. hideBoot is idempotent
  // (success + catch both call it) and stops the ticker.
  var bootGone = false;
  var bootTimer = null;
  var bootT0 = Date.now();
  var BOOT_MIN_MS = 1500; // v73.8: the coach gets 1.5s to say hi (user: 'boot screen change to 1.5 now from 2' — the floor only extends, never shortens, so slow boots are still unaffected)
  function hideBoot() {
    if (bootGone) return;
    bootGone = true;
    if (bootTimer) { clearInterval(bootTimer); bootTimer = null; }
    // v72.54 (v72.55: floor raised to 3s): minimum display time — the fade
    // waits out the BOOT_MIN_MS floor (the face + darting eyes + bar keep
    // animating via CSS during it; the status line freezes on its current
    // word, which reads as "settling", not "stuck").
    var wait = Math.max(0, BOOT_MIN_MS - (Date.now() - bootT0));
    setTimeout(function () {
      var b = byId('boot');
      if (b) b.classList.add('off');
    }, wait);
  }
  function bootTicker() {
    var st = byId('bootStatus');
    if (!st) return;
    var msgs = ['waking up\u2026', 'counting your numbers\u2026', 'almost there\u2026'];
    var i = 0;
    bootTimer = setInterval(function () {
      st.classList.add('out');
      setTimeout(function () {
        i = (i + 1) % msgs.length;
        st.textContent = msgs[i];
        st.classList.remove('out');
      }, 300);
    }, 1600);
  }

  // ---------- service worker: update toast ----------
  var swReg = null;
  function showSwToast() {
    var el = byId('swToast'); if (!el) return;
    el.classList.add('show');
    var b = byId('swReload');
    if (b) b.onclick = function () {
      if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
      setTimeout(function () { location.reload(); }, 350);
    };
  }
  function init() {
    // v72.53: the splash starts cycling now (it is already visible from the
    // HTML) and a safety timer guarantees a stuck load can never trap the UI.
    // v72.56: prefers-reduced-motion — SMIL (the #botFace darting eyes) can't
    // honor the media query natively, so strip the animateTransform from the
    // symbol; the <use> shadow trees live-sync with their source, so all
    // instances (coach note, chat avatar, FAB) go still. The splash's CSS
    // animation is already gated by a @media rule in index.html.
    try {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        var sym = document.querySelector('#botFace animateTransform');
        if (sym) sym.parentNode.removeChild(sym);
      }
    } catch (e) {}
    bootTicker();
    setTimeout(hideBoot, 4000);
    renderGreet();
    var dateEl = byId('f_date');
    if (dateEl && !dateEl.value) dateEl.value = todayISO();
    if (dateEl) { dateEl.addEventListener('input', function () { syncDateLabel(dateEl); }); syncDateLabel(dateEl); }
    var pdateEl = byId('p_date');
    if (pdateEl && !pdateEl.value) pdateEl.value = todayISO();
    if (pdateEl) { pdateEl.addEventListener('input', function () { syncDateLabel(pdateEl); }); syncDateLabel(pdateEl); }

    var tabBtns = document.querySelectorAll('.tab');
    for (var i = 0; i < tabBtns.length; i++) {
      (function (b) { b.onclick = function () { setTab(b.getAttribute('data-tab')); }; })(tabBtns[i]);
    }

    var form = byId('addForm');
    if (form) form.onsubmit = function (e) {
      e.preventDefault();
      // v64: Cash is the default pick — if the select ever comes back empty
      // (it can't: the Cash option is always present), map it to the same value.
      var raw = byId('f_account').value || 'CASH::Cash';
      var sep = raw.indexOf('::');
      var type = raw.slice(0, sep), name = raw.slice(sep + 2);
      var amtRaw = String(byId('f_amount').value || '').trim();
      var amount = evalExpr(amtRaw);
      if (amount === null || !(amount > 0)) { alert('Enter an amount greater than 0 — a plain number, or a quick sum like 300-125+10.'); return; }
      var category = (byId('f_category').value || '').trim();
      // v72.10: editing an INFLOW entry keeps its flow direction (cash_in stays
      // cash_in, card_payment stays card_payment); a fresh add is a spend —
      // v72.41: unless the sheet is in Pay-card mode, which logs the payoff
      // (card_payment, the exact inverse of the card_charge spends) — it must
      // land on a CARD account: the card the money was paid to.
      if (addMode === 'prepay' && type !== 'CARD') {
        alert('Pick the card you paid — Pay card logs a payment to a credit card.');
        return;
      }
      if (addMode === 'moneyin' && type === 'CARD') {
        alert('Money in lands in a cash account — pick the account it entered.'); // v72.45 / v73.8
        return;
      }
      var kind = addSheetKind(addMode, type, editingTxn ? editingTxn.kind : null);
      var payload = {
        date: byId('f_date').value || todayISO(),
        account: name,
        kind: kind,
        category: category,
        amount: amount,
        note: (byId('f_note').value || '').trim()
      };
      // v71: the same sheet doubles as the ledger editor — when an entry is
      // being edited, its values re-log through saveTxnEdit (same id, Undo
      // restores the ORIGINAL entry); otherwise a plain add.
      var editId = editingTxn ? editingTxn.id : null;
      var done = editId ? saveTxnEdit(editId, payload) : addTxn(payload);
      done.then(function () {
        // v73.0: the good moments — salary in, card prepaid — Coach Fin
        // smiles for a beat (the flash reverts to the real mood on its own)
        if (!editId && (kind === 'cash_in' || kind === 'card_payment')) happyMoodFlash(1800);
        if (editId) exitTxnEdit();
        byId('f_amount').value = '';
        byId('f_category').value = '';
        byId('f_note').value = '';
        seedCategories();
        // v53: close the sheet and land on the Ledger — the new entry is at the
        // top of the list; the "Added …" snackbar (with Undo) confirms the add.
        closeSheets();
        setTab('ledger');
      });
    };

    var pform = byId('planForm');
    if (pform) pform.onsubmit = function (e) {
      e.preventDefault();
      var name = (byId('p_name').value || '').trim();
      var amount = evalExpr(byId('p_amount').value);
      if (amount === null) amount = NaN;
      if (!name) { alert('Give the plan a name.'); return; }
      if (!(amount > 0)) { alert('Enter an amount greater than 0.'); return; }
      var repEl = byId('p_repeat');
      // v73.1: the repeat is a select now (once / monthly / weekly / annual)
      var repVal = repEl ? String(repEl.value || 'once') : 'once';
      addPlan({ name: name, amount: amount, date: byId('p_date').value || todayISO(),
        repeat: repVal === 'once' ? null : repVal }).then(function () {
        byId('p_name').value = '';
        byId('p_amount').value = '';
        if (repEl) repEl.value = 'once';
        byId('p_name').focus();
      });
    };
    owedBindEvents();
    bindConfirm();

    var mealEl = byId('mealEdit');
    if (mealEl) mealEl.onchange = function () {
      var v = parseFloat(mealEl.value);
      if (v > 0) { try { localStorage.setItem(LS_MEAL, String(v)); } catch (e2) {} }
      else mealEl.value = mealBudget();
      render();
    };
    var amtEl = byId('f_amount');
    if (amtEl) amtEl.addEventListener('input', function () { addAmtEq(amtEl); updateChargeHint(); });
    var noteEl = byId('f_note'); // v68 item 1: learned merchant→category prefill
    if (noteEl) noteEl.addEventListener('input', function () { autoCatFromNote(noteEl); });
    var mlf = byId('mlFilter');
    if (mlf) mlf.onchange = function () { mlFilterCat = mlf.value; mlShownCount = 5; renderMoneyLog(); };
    wireSnackSwipe(); // v72.32: the top banner swipes up to dismiss

    window.addEventListener('online', function () { state.online = true; });
    window.addEventListener('offline', function () { state.online = false; });

    var ab = byId('addBtn');
    if (ab) ab.onclick = function () { setAddMode('spend'); openSheet('addSheet'); }; // v72.41: a fresh Add opens in Spend mode
    // v72.41: the Add sheet's direction toggle (Spend / Pay card) — v73.8: + Money in
    var amS = byId('addModeSpend'), amP = byId('addModePrepay'), amM = byId('addModeMoneyin');
    if (amS) amS.onclick = function () { setAddMode('spend'); };
    if (amP) amP.onclick = function () { setAddMode('prepay'); };
    if (amM) amM.onclick = function () { setAddMode('moneyin'); };
    var cfab = byId('coachFab');
    if (cfab) {
      fabInitDrag(); // v72.15: draggable bot — settles to the nearest edge, the bubble anchors to it
      cfab.onclick = function () {
        // v72.11: a click that just finished a DRAG must not open the coach
        if (Date.now() - fabLastDragAt < 400) return;
        var ov = byId('coachOv');
        if (ov && ov.classList.contains('show')) closeCoach(); else openCoach();
      };
    }
    var sbtn2 = byId('setBtn');
    if (sbtn2) sbtn2.onclick = function () { openSheet('setSheet'); };
    // v73.2: the money pulse — the Home card opens the full recap sheet;
    // "Pin a lesson" stores the note for next month's recap
    var ro = byId('recapOpen');
    if (ro) ro.onclick = openRecap;
    var rc = byId('recapClose');
    if (rc) rc.onclick = closeSheets;
    var rp = byId('recapPin');
    if (rp) rp.onclick = function () {
      var now = new Date();
      var pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      var prevM = pm.getFullYear() + '-' + (pm.getMonth() + 1 < 10 ? '0' : '') + (pm.getMonth() + 1);
      var t = pinLesson(prevM, byId('recapLesson').value);
      byId('recapLesson').value = '';
      var pin = byId('recapPinned');
      if (pin) pin.textContent = t ? ('Pinned for next month: ' + t) : 'Lesson unpinned.';
      renderRecap();
      snack(t ? 'Lesson pinned — it shows in next month\'s recap' : 'Lesson unpinned', function () { renderRecap(); });
    };
    // v73.3: gist sync — the creds prefill from the stored url+token (the
    // passphrase is never stored); push/pull are the two buttons
    var sc0 = syncReadCreds();
    var su = byId('syncUrl'); if (su && sc0.url) su.value = sc0.url;
    var st = byId('syncToken'); if (st && sc0.token) st.value = sc0.token;
    var sp = byId('syncPush'); if (sp) sp.onclick = syncPush;
    var sl = byId('syncPull'); if (sl) sl.onclick = syncPull;
    var ac = byId('addClose');
    if (ac) ac.onclick = closeSheets;
    var scb = byId('setClose');
    if (scb) scb.onclick = closeSheets;
    var ncb = byId('numClose');
    if (ncb) ncb.onclick = closeSheets;
    var sno = byId('setNumOpen');
    if (sno) sno.onclick = function () { openSheet('numSheet'); };
    var snc = byId('setNumCoach');
    if (snc) snc.onclick = function () { startSetup(); };
    var nco = byId('numCoachBtn');
    if (nco) nco.onclick = function () { startSetup(); };
    var scrim = byId('scrim');
    if (scrim) scrim.onclick = function () { closeCoach(); closeSheets(); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { if (window.__financeChat && window.__financeChat.closeInfo && window.__financeChat.closeInfo()) return; closeCoach(); closeSheets(); } }); // v68 Jan add-on: Esc closes the info panel first
    // a11y: trap Tab focus inside the open sheet
    document.addEventListener('keydown', function (e) {
      if (!openSheetEl || e.key !== 'Tab') return;
      var f = openSheetEl.querySelectorAll('input,select,button,textarea');
      var list = [];
      for (var j = 0; j < f.length; j++) if (!f[j].disabled) list.push(f[j]);
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    renderWhatNew(); // v72.29: the Settings "What's new in <version>" section
    var ej = byId('expJson');
    if (ej) ej.onclick = function () { exportData('json'); };
    // v72.23: the Backup section's "what to include" — persist on change
    BK_SELS.forEach(function (s) {
      var el = byId(s[1]);
      if (el) el.onchange = function () { backupSelWrite(); };
    });
    backupSelSync();
    var ec = byId('expCsv');
    if (ec) ec.onclick = function () { exportData('csv'); };
    var ib = byId('impBtn');
    if (ib) ib.onclick = function () { var f = byId('impFile'); if (f) f.click(); };
    var ifile = byId('impFile');
    if (ifile) ifile.onchange = function () {
      var f = ifile.files && ifile.files[0];
      if (f) importData(f);
      ifile.value = '';
    };
    var bb = byId('baseBody');
    if (bb) {
      // v71: no more silent auto-save — edits (and drags, and row adds/removes)
      // mark the sheet dirty; the Save button commits. Closing the sheet
      // commits too (closeSheets), so nothing typed is ever lost.
      bb.addEventListener('input', function (ev) { markBaseDirty(); qsHint(ev.target); });
      bb.addEventListener('change', function () { markBaseDirty(); });
      bb.addEventListener('pointerdown', baseDragStart);
      bb.addEventListener('pointermove', baseDragMove);
      bb.addEventListener('pointerup', baseDragEnd);
      bb.addEventListener('pointercancel', baseDragEnd);
      bb.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute) return;
        var add = t.getAttribute('data-add');
        if (add) { addBaseRow(add); return; }
        var mmact = t.getAttribute('data-mmact'); // v68 item 1: hide/block a learned merchant→category entry
        if (mmact) { toggleMerchantFlag(t.getAttribute('data-mm'), mmact === 'block' ? 'blocked' : 'deleted'); return; }
        var dk = t.getAttribute('data-dk'); // v56: remove a coach-recorded detail
        if (dk) {
          commitIfDirtyBase(); // v71: the re-render below wipes the form — commit first
          if (window.confirm('Remove this detail?')) {
            var db = state.base && state.base.details;
            if (db && db[dk]) {
              delete db[dk][t.getAttribute('data-dk-key') || ''];
              if (!Object.keys(db[dk]).length) delete db[dk];
              saveBase(state.base).then(function () { emit('snap'); renderBaseEditor(); renderBaseStatus(); });
            }
          }
          return;
        }
        var rm = t.getAttribute('data-rm');
        if (rm) {
          var holder = rm === 'blk' ? t.closest('.bblk') : t.closest('.brow');
          if (holder) holder.parentNode.removeChild(holder);
          markBaseDirty(); // v71: removal is a change — Save button appears
        }
      });
    }
    var bsv = byId('baseSave'); // v71: the explicit "Your numbers" save button
    if (bsv) bsv.onclick = function () { commitBaseForm(); };
    var hob = byId('homeOpenSet');
    if (hob) hob.onclick = function () { openSheet('numSheet'); };
    var hcb = byId('homeCoach');
    if (hcb) hcb.onclick = function () { startSetup(); };
    var cnr = byId('coachNoteRefresh'); // v55: re-ask the coach for a fresh note
    if (cnr) cnr.onclick = function () { try { localStorage.removeItem(NOTE_KEY); } catch (e) {} renderCoachNote(); };

    // v72.34: an update must LAND on one refresh. The worker registers at
    // script time (was: after 'load') so a byte-diff is found as early as
    // possible, the banner shows the moment updatefound fires, and the page
    // reloads ITSELF the instant the new worker takes control (sw.js does
    // skipWaiting + claim). Guard: only when there WAS a previous controller
    // and it actually changed — a fresh install never auto-reloads.
    if ('serviceWorker' in navigator) {
      var swInitialController = navigator.serviceWorker.controller;
      var swAutoReloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (swAutoReloaded) return;
        if (swInitialController && navigator.serviceWorker.controller &&
            navigator.serviceWorker.controller !== swInitialController) {
          swAutoReloaded = true;
          var stc = byId('swToast'); if (stc) stc.classList.remove('show');
          location.reload();
        }
      });
      navigator.serviceWorker.register('./sw.js').then(function (reg) {
        swReg = reg;
        if (reg.waiting) showSwToast();
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          showSwToast(); // v72.34: as early as possible (the precache still runs)
          nw.addEventListener('statechange', function () {
            // installed while this page is already controlled = a new version is ready
            if (nw.state === 'installed' && navigator.serviceWorker.controller) showSwToast();
            // the update died (e.g. offline mid-precache) → the banner is stale
            if (nw.state === 'redundant') { var str = byId('swToast'); if (str) str.classList.remove('show'); }
          });
        });
      }).catch(function (err) { console.warn('SW register failed', err); });
    }

    Promise.all([idbAll(STORE_TX), idbAll(STORE_META), idbAll(STORE_PLANS)]).then(function (res) {
      state.txns = res[0] || [];
      state.plans = res[2] || [];
      var cachedSnap = null, hasAdj = false;
      (res[1] || []).forEach(function (m) {
        if (m.key === 'base') { state.base = migrateBaseKinds(m.value); } // v65
        else if (m.key === 'snapshot') { cachedSnap = m.value; }
        else if (m.key === 'adj') { state.adj = m.value; hasAdj = true; }
        else if (m.key === 'adjSig') { state.adjSig = m.value || ''; }
        else if (m.key === 'coachMem') { state.coachMem = m.value; }
        else if (m.key === MERCHANT_MAP_KEY) { state.merchantMap = (m.value && typeof m.value === 'object') ? m.value : {}; } // v68 item 1
        else if (m.key === SHADOW_KEY) { state.shadowLog = (m.value && m.value.length) ? m.value.slice(-SHADOW_CAP) : []; } // v68 item 11
        else if (m.key === 'moneyLog') { state.moneyLog = m.value || []; }
        else if (m.key === 'owed') {
          state.owed = (m.value && Array.isArray(m.value.people)) ? m.value : { people: [] };
        }
      });
      if (!state.base) {
        // First launch: one-time migration from the last cached sheet snapshot (if any).
        state.base = snapshotToBase(cachedSnap) || defaultBase();
      }
      refreshLocalSnapshot();
      if (!hasAdj && !state.adjSig) computeAdjFromTxns();
      migratePayoffModel(); // v72.43: one-shot re-derivation of a pre-v72.42 persisted overlay
      if (!state.adjSig) state.adjSig = snapSig(state.snapshot);
      state.adjLoaded = true;
      persistSnapshot();
      idbPut(STORE_META, { key: 'base', value: state.base }).catch(function () {});
      renderBaseEditor();
      render();
      setTab(currentTab());
      hideBoot(); // v72.53: the first render is in — the splash fades
    }).catch(function (err) {
      console.warn('IDB load failed', err);
      state.base = state.base || defaultBase();
      refreshLocalSnapshot();
      state.adjSig = snapSig(state.snapshot);
      render();
      setTab(currentTab());
      hideBoot(); // v72.53: even a failed load must not trap the user on the splash
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();



