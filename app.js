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
    adj: { cash: 0, free: 0, card: 0, prepay: 0 },
    adjSig: '',
    adjLoaded: false,
    coachMem: null,
    moneyLog: [],
    owed: { people: [] }
  };

  // ---------- event bus: a state change re-renders only the views that depend on it ----------
  var RENDER_BY_KEY = {
    txn: [renderSummary, renderCoach, renderInsights, renderProjection, updateChargeHint, renderHero, renderDonut, renderPace, renderMoneyLog, renderCoachNote],
    plan: [renderPlans, renderInsights, renderCoach, renderProjection, renderHero, renderCoachNote],
    snap: [renderSummary, renderCoach, renderInsights, renderProjection, renderObligations, renderSinking, seedAccounts, renderAddEmpty, updateChargeHint, renderHero, renderBaseStatus, renderCoachNote, seedCategories],
    adj: [renderSummary, renderCoach, renderInsights, renderProjection, updateChargeHint, renderHero, renderCoachNote],
    owed: [renderOwed],
    ui: [renderSummary, seedAccounts, seedCategories, renderCoach, renderInsights, renderProjection, renderObligations, renderSinking, renderAddEmpty, renderPlans, renderFooter, updateChargeHint, renderHero, renderDonut, renderPace, renderMoneyLog, renderOwed, renderCoachNote]
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
  function shiftMonth(iso, k) {
    var p = String(iso).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1 + k, 1);
    var dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return localISO(new Date(d.getFullYear(), d.getMonth(), Math.min(Number(p[2]) || 1, dim)));
  }
  function planOccurrences(p) {
    if (!p || p.repeat !== 'monthly') return [String(p.date)];
    var today = todayISO();
    var d = String(p.date), guard = 0;
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

  // ---- live overlay: app entries adjust the sheet snapshot until the sheet catches up ----
  function txnAdj(t) {
    var amt = Number(t.amount) || 0;
    return t.kind === 'card_charge'
      ? { cash: 0, free: amt, card: amt, prepay: amt }
      : { cash: amt, free: amt, card: 0, prepay: 0 };
  }
  function addAdj(a, sign) {
    state.adj.cash = r2(state.adj.cash + a.cash * sign);
    state.adj.free = r2(state.adj.free + a.free * sign);
    state.adj.card = r2(state.adj.card + a.card * sign);
    state.adj.prepay = r2(state.adj.prepay + a.prepay * sign);
  }
  function computeAdjFromTxns() {
    state.adj = { cash: 0, free: 0, card: 0, prepay: 0 };
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
    if (state.adjSig && sig !== state.adjSig && adjActive()) state.adj = { cash: 0, free: 0, card: 0, prepay: 0 };
    state.adjSig = sig;
  }
  function resetAdj() {
    state.adj = { cash: 0, free: 0, card: 0, prepay: 0 };
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
    return e;
  }

  // ---------- local base data: the single source of truth on this phone ----------
  function defaultBase() {
    return {
      v: 1, name: '', as_of: todayISO(),
      salary: 0, salary_overrides: {},
      prepay_day: 14, cutoff_day: 15, card_util_target: 0.099,
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
      base.push({ comp: bi, running: bc });
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
      cards.push({ name: name, balance: d.balance, limit: d.limit, util_pct: d.util_pct, prepay: d.prepay });
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
    if (state.adjSig && sig !== state.adjSig && adjActive()) state.adj = { cash: 0, free: 0, card: 0, prepay: 0 };
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
  function saveBase(b) {
    b.edited = new Date().toISOString();
    state.base = migrateBaseKinds(b); // v65
    refreshLocalSnapshot();
    return Promise.all([
      idbPut(STORE_META, { key: 'base', value: b }).catch(function () {}),
      persistSnapshot(),
      saveAdj()
    ]);
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
  function addTxn(data) {
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
      // v71: no Undo on the add toast (user's call — the ledger's ✕ is the
      // deletion path); the snack just confirms.
      snack('Added ' + money(t.amount) + ' · ' + esc(t.category || t.account));
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
    return Promise.all([idbDel(STORE_TX, id), saveAdj()]).then(function () {
      emit('txn');
      snack('Deleted ' + money(t.amount) + ' · ' + esc(t.category || t.account), function () {
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
  function removeTxnRow(tid) {
    var t = null;
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === tid) t = state.txns[i];
    var removed = (state.moneyLog || []).filter(function (e) { return e && e.tid === tid; });
    if (!t && !removed.length) return null;
    if (t) {
      state.txns = state.txns.filter(function (x) { return x.id !== tid; });
      addAdj(txnAdj(t), -1);
    }
    state.moneyLog = (state.moneyLog || []).filter(function (e) { return !(e && e.tid === tid); });
    idbPut(STORE_META, { key: 'moneyLog', value: state.moneyLog }).catch(function () {});
    var done = t ? Promise.all([idbDel(STORE_TX, tid), saveAdj()]) : Promise.resolve();
    return { t: t, removed: removed, persist: done };
  }
  function restoreTxnRow(r) {
    if (r.t) {
      // an edited version (same id) may be there now — it goes, the original comes back
      state.txns = state.txns.filter(function (x) { return x.id !== r.t.id; });
      state.txns.push(r.t);
      addAdj(txnAdj(r.t), 1);
      idbPut(STORE_TX, r.t).catch(function () {});
    }
    if (r.removed.length) {
      state.moneyLog = (state.moneyLog || []).filter(function (e) { return !(e && r.t && e.tid === r.t.id); });
      r.removed.forEach(function (e) { state.moneyLog.push(e); });
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
        restoreTxnRow(r);
      });
    });
  }
  // v71: editable ledger entries — re-logs the txn (same id, same created
  // stamp) with the edited values. The old money-log row is replaced by the
  // new one, so the ledger shows one corrected entry; Undo restores the
  // ORIGINAL entry (values AND log rows), not the edited one.
  function saveTxnEdit(tid, data) {
    var r = removeTxnRow(tid);
    if (!r) return Promise.resolve();
    var t = {
      id: tid, date: data.date, account: data.account, kind: data.kind,
      category: data.category, amount: data.amount, note: data.note,
      created: (r.t && r.t.created) || new Date().toISOString()
    };
    state.txns.push(t);
    addAdj(txnAdj(t), 1);
    logMoney('add', t);
    return Promise.all([idbPut(STORE_TX, t), saveAdj()]).then(function () {
      emit('txn');
      snack('Updated ' + money(t.amount) + ' · ' + esc(t.category || 'Unsorted'), function () {
        restoreTxnRow(r);
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
      var av = (t.kind === 'card_charge' ? 'CARD' : 'CASH') + '::' + (t.account || 'Cash');
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
    updateChargeHint();
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
      n: amt, k: t.kind === 'card_charge' ? 'c' : 'x'
    };
    e.f = r2(s.cash ? s.cash.free : 0);
    if (t.kind === 'card_charge') e.o = r2(s.card_owed || 0);
    if (String(t.date).slice(0, 7) === mp) {
      var sp = 0;
      state.txns.forEach(function (x) { if (String(x.date).slice(0, 7) === mp) sp += Number(x.amount) || 0; });
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
      lab = e.c || 'Unsorted';
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
  function renderMlFilter() {
    var sel = byId('mlFilter');
    if (!sel) return;
    var log = state.moneyLog || [];
    var cats = [];
    var hasUnsorted = false;
    log.forEach(function (e) {
      if (!e) return;
      if (e.c) { if (cats.indexOf(e.c) < 0) cats.push(e.c); }
      else hasUnsorted = true;
    });
    cats.sort();
    var html = '<option value="">All</option>';
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
      if (mlFilterCat === '__unsorted__') return !e.c;
      return e.c === mlFilterCat;
    });
    if (!shown.length) {
      if (noteEl) noteEl.style.display = 'none';
      body.innerHTML = '<p class="note" style="margin:2px 0">No ' +
        (mlFilterCat === '__unsorted__' ? 'unsorted' : esc(mlFilterCat)) +
        ' entries — clear the filter to see the rest.</p>';
      return;
    }
    if (noteEl) noteEl.style.display = '';
    body.innerHTML = shown.map(function (e) {
        var add = e.a === 'add';
        var before = r2(e.f + (add ? e.n : -e.n));
        var extra = '';
        if (e.k === 'c') extra = '<span class="ml-x">card ' + money(r2(e.o + (add ? -e.n : e.n))) + ' → ' + money(e.o) + '</span>';
        if (e.s != null) extra += '<span class="ml-x">month spent ' + money(r2(e.s + (add ? -e.n : e.n))) + ' → ' + money(e.s) + '</span>';
        var p = mlParts(e);
        // v71: add rows with a live txn are editable — tap the row (not the ✕)
        var editAttr = (add && e.tid) ? ' data-ml-edit="' + esc(e.tid) + '" title="Tap to edit" style="cursor:pointer"' : '';
        var delBtn = (add && e.tid) ? '<button type="button" class="mini" data-ml-del="' + esc(e.tid) +
          '" aria-label="Delete this expense" title="Delete this expense">\u2715</button>' : '';
        return '<div class="ml-row' + (add ? '' : ' del') + '"' + editAttr + '>' +
          '<div class="ml-l"><div class="ml-cat">' + esc(p.lab) + '</div>' +
          (p.note ? '<div class="ml-note">' + esc(p.note) + '</div>' : '') +
          '<div class="ml-meta">' + mlDate(e.at) + (p.m ? ' · ' + esc(p.m) : '') + '</div></div>' +
          '<div class="ml-r"><b class="' + (add ? 'ml-down' : 'ml-up') + '">' + (add ? '−' : '+') + money(e.n) + '</b>' +
          '<span class="ml-f">free ' + money(before) + ' → ' + money(e.f) + '</span>' + extra + delBtn + '</div></div>';
      }).join('');
    var dl = body.querySelectorAll('[data-ml-del]');
    for (var di = 0; di < dl.length; di++) dl[di].onclick = function (ev) {
      ev.stopPropagation(); // v71: ✕ deletes — it must not also open the editor
      askDeleteTxn(this.getAttribute('data-ml-del'));
    };
    var ed = body.querySelectorAll('[data-ml-edit]');
    for (var ei = 0; ei < ed.length; ei++) ed[ei].onclick = function () { openTxnEdit(this.getAttribute('data-ml-edit')); };
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
    else if (id === 'setSheet') renderBaseStatus();
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

  // ---------- snackbar (with undo) ----------
  var snackTimer = null;
  function hideSnack() {
    var el = byId('snack'); if (el) el.classList.remove('show');
  }
  function snack(msg, undoFn, ms) {
    var el = byId('snack'); if (!el) return;
    el.innerHTML = '<span class="snack-msg">' + msg + '</span>' +
      (undoFn ? '<button type="button" id="snackUndo">Undo</button>' : '');
    if (undoFn) {
      var b = byId('snackUndo');
      if (b) b.onclick = function () { hideSnack(); undoFn(); };
    }
    el.classList.add('show');
    clearTimeout(snackTimer);
    snackTimer = setTimeout(hideSnack, ms || 5200);
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
  function numVal(el) {
    if (!el) return 0;
    var v = evalExpr(el.value);
    if (v != null) return v;
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
    var kinds = ['debit', 'card', 'debt', 'loan']; // v65: 'cash' renamed to 'debit'
    return brow(dragH() + '<input class="grow" data-r="name" value="' + esc(a.name || '') + '" autocomplete="off">' +
      '<select data-r="kind">' + kinds.map(function (k) {
        return '<option value="' + k + '"' + (a.kind === k ? ' selected' : '') + '>' + k + '</option>';
      }).join('') + '</select>' +
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
    h += brow('<span class="bnote">card target util</span><input class="grow" id="b_util" type="text" value="' + (b.card_util_target || '') + '" title="0.099 = just under 10%">');
    var salRows = '';
    Object.keys(b.salary_overrides || {}).forEach(function (m) { salRows += payRow(m, b.salary_overrides[m], true); });
    h += bsec('Salary overrides') + '<div id="rowsSal">' + salRows + '</div>' +
      '<button type="button" class="addrow" data-add="sal">+ override month</button>';
    var accRows = (b.accounts || []).map(accRow).join('');
    h += bsec('Accounts (debit, cards, debts, loans)') + '<div id="rowsAcc">' + accRows + '</div>' +
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
    b.salary = numVal(byId('b_salary'));
    b.liquidity_floor = numVal(byId('b_floor'));
    var pd = Math.round(numVal(byId('b_pday'))); // v71: quick sums here too (10+4 -> 14)
    var cd = Math.round(numVal(byId('b_cday')));
    b.prepay_day = pd > 0 ? pd : 14;
    b.cutoff_day = cd > 0 ? cd : 15;
    var ut = numVal(byId('b_util'));
    b.card_util_target = ut > 0 ? ut : 0.099;
    bb.querySelectorAll('#rowsSal .brow').forEach(function (row) {
      var m = row.querySelector('[data-r="m"]'); var a = row.querySelector('[data-r="a"]');
      if (m && a && isMonth(m.value)) b.salary_overrides[m.value] = numVal(a);
    });
    bb.querySelectorAll('#rowsAcc .brow').forEach(function (row) {
      var ni = row.querySelector('[data-r="name"]'); var ki = row.querySelector('[data-r="kind"]');
      var vi = row.querySelector('[data-r="value"]'); var li = row.querySelector('[data-r="limit"]');
      var name = ni ? ni.value.trim() : '';
      var kind = ki ? ki.value : 'debit'; // v65
      var value = numVal(vi);
      if (!name && !value) return;
      b.accounts.push({ name: name || '(unnamed)', kind: kind, value: value, limit: kind === 'card' ? numVal(li) : 0, note: '' });
    });
    bb.querySelectorAll('#rowsBud .brow').forEach(function (row) {
      var ni = row.querySelector('[data-r="name"]'); var ai = row.querySelector('[data-r="a"]');
      var name = ni ? ni.value.trim() : '';
      var amt = numVal(ai);
      if (!name && !amt) return;
      b.budgets[name || '(unnamed)'] = amt;
    });
    bb.querySelectorAll('#rowsBov .brow').forEach(function (row) {
      var m = row.querySelector('[data-r="m"]'); var c = row.querySelector('[data-r="cat"]'); var a = row.querySelector('[data-r="a"]');
      if (m && c && a && isMonth(m.value) && c.value) {
        b.budget_overrides[m.value] = b.budget_overrides[m.value] || {};
        b.budget_overrides[m.value][c.value] = numVal(a);
      }
    });
    bb.querySelectorAll('#rowsOne .brow').forEach(function (row) {
      var m = row.querySelector('[data-r="m"]'); var ni = row.querySelector('[data-r="name"]'); var a = row.querySelector('[data-r="a"]');
      var name = ni ? ni.value.trim() : '';
      if (m && isMonth(m.value) && (name || numVal(a) > 0)) {
        b.one_offs[m.value] = b.one_offs[m.value] || {};
        b.one_offs[m.value][name || '(unnamed)'] = numVal(a);
      }
    });
    bb.querySelectorAll('.bblk[data-sec="debt"]').forEach(function (blk) {
      var ni = blk.querySelector('[data-r="name"]');
      var name = ni ? ni.value.trim() : '';
      if (!name) return;
      var d = { monthly: numVal(blk.querySelector('[data-r="monthly"]')), active_months: [], payments: {} };
      var act = blk.querySelector('[data-r="active"]');
      if (act) act.value.split(',').forEach(function (s) { s = s.trim(); if (isMonth(s)) d.active_months.push(s); });
      blk.querySelectorAll('[data-r="pays"] .brow').forEach(function (row) {
        var m = row.querySelector('[data-r="m"]'); var a = row.querySelector('[data-r="a"]');
        if (m && a && isMonth(m.value) && numVal(a) > 0) d.payments[m.value] = numVal(a);
      });
      b.debts[name] = d;
    });
    bb.querySelectorAll('.bblk[data-sec="sink"]').forEach(function (blk) {
      var ni = blk.querySelector('[data-r="name"]');
      var name = ni ? ni.value.trim() : '';
      if (!name) return;
      var dl = blk.querySelector('[data-r="deadline"]');
      var s = { goal: numVal(blk.querySelector('[data-r="goal"]')), deadline: dl ? dl.value : '',
        funded: numVal(blk.querySelector('[data-r="funded"]')), payments: {} };
      blk.querySelectorAll('[data-r="pays"] .brow').forEach(function (row) {
        var m = row.querySelector('[data-r="m"]'); var a = row.querySelector('[data-r="a"]');
        if (m && a && isMonth(m.value) && numVal(a) > 0) s.payments[m.value] = numVal(a);
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
    html += tile(ordinal(s.prepay_day || 14) + ' prepay', money(s.total_prepay), 'due before the ' + (s.cutoff_day || 15) + liveMark, 'accent');
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
    state.txns.forEach(function (t) { if (t.date === today) todaySpend += Number(t.amount) || 0; });
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
    state.txns.forEach(function (t) { if (String(t.date).slice(0, 7) === monthPrefix) spentM += Number(t.amount) || 0; });
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
        var a = Number(t.amount) || 0;
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
    var recurringGuess = [];
    (function () {
      function pk(n) { return (n < 10 ? '0' : '') + n; }
      var mKeys = [];
      for (var q = 1; q <= 3; q++) {
        var dm3 = new Date(now.getFullYear(), now.getMonth() - q, 1);
        mKeys.push(dm3.getFullYear() + '-' + pk(dm3.getMonth() + 1));
      }
      var winFrom = mKeys[2];
      var byMer = {};
      state.txns.forEach(function (t) {
        var mk = String(t.date).slice(0, 7);
        if (mk < winFrom) return;
        var nm = String(t.note || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
        var a = Number(t.amount) || 0;
        if (nm.length < 3 || a <= 0) return;
        var e = (byMer[nm] = byMer[nm] || { months: {}, amts: [] });
        e.months[mk] = (e.months[mk] || 0) + 1;
        e.amts.push(a);
      });
      Object.keys(byMer).forEach(function (nm) {
        var e = byMer[nm];
        var months = Object.keys(e.months);
        if (months.length < 2) return;
        var avg = e.amts.reduce(function (s, a) { return s + a; }, 0) / e.amts.length;
        var close = e.amts.filter(function (a) { return a >= avg * 0.9 && a <= avg * 1.1; }).length;
        if (close * 2 < e.amts.length) return; // amounts too inconsistent
        var planned = false;
        state.plans.forEach(function (p) {
          var pa = Number(p.amount) || 0;
          if (pa < avg * 0.9 || pa > avg * 1.1) return;
          var pw = String(p.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 3; });
          var mw = nm.split(' ').filter(function (w) { return w.length >= 3; });
          if (pw.some(function (w) { return mw.indexOf(w) >= 0; })) planned = true;
        });
        if (planned) return;
        recurringGuess.push({ merchant: nm, amount: Math.round(avg), months: months.length });
      });
      recurringGuess.sort(function (a, b) { return b.months - a.months || b.amount - a.amount; });
    })();
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
      freeAfterPace: r2(free - r2(pace * Math.max(0, daysLeft - 1)))
    };
  }
  // ---------- Phase 5: unified coach card (narrative + attention rows + one-tap actions) ----------
  function prefillAdd(amt, dateISO, note) {
    var a = byId('f_amount'), dt = byId('f_date'), n = byId('f_note');
    if (a) a.value = amt != null ? String(amt) : '';
    if (dt && dateISO) dt.value = dateISO;
    if (n && note) n.value = note;
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
    var prepayActive = info.prepayActive && !info.prepayPaid;
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
    state.plans.forEach(function (p) { if (p.repeat === 'monthly') rec.push(p); });
    if (rec.length) {
      var recAmt = rec.reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0);
      sub += ' On repeat: ' + rec.map(function (p) { return p.name || 'plan'; }).join(', ') + ' — ' + money(recAmt) + ' a month.';
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
        // v68 item 5: the recurring row carries a one-tap "make it a monthly plan"
        if (rw.act === 'make_plan') {
          html += '<button type="button" class="dig warn" data-makeplan="' + esc(rw.payload.name) + '|' + rw.payload.amount + '">' +
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
            addPlan({ name: parts[0], amount: Number(parts[1]) || 0, date: todayISO(), repeat: 'monthly' });
          };
        })(mpb[j]);
      }
    }
    // ---- one-tap actions ----
    var acts = byId('coachActs');
    if (acts) {
      var ah = '';
      if (prepayActive) ah += '<button type="button" class="cbtn" id="actPrepay">Log prepay ' + money(d.prepayAmt) + '</button>';
      var hasPlanRow = rows.some(function (rw) { return rw.tag === 'Plan due'; });
      if (hasPlanRow) ah += '<button type="button" class="cbtn ghost" id="actPlans">See this week\'s plans</button>';
      acts.innerHTML = ah;
      var ap = byId('actPrepay');
      if (ap) ap.onclick = function () { prefillAdd(d.prepayAmt, d.prepayDate, 'Card prepay (the ' + ordinal(d.prepayDay) + ')'); };
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
    var todaySpend = d.todaySpend;
    var daily = d.daily;
    var tLines = ['Headroom: <b>' + money(daily) + '/day</b> left across the next ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '.'];
    if (todaySpend > 0) tLines.push('Spent in this app today: <b>' + money(todaySpend) + '</b>.');
    var tCls, tTxt;
    if (free < 0) { tCls = 'bad'; tTxt = 'No room for treats — free cash is negative. Back the cards first.'; }
    else if (daily >= meal) { tCls = 'good'; tTxt = 'Eat out OK: a ' + money(meal) + ' treat still leaves you on track (about ' + money(r2(daily - meal)) + ' under your daily headroom).'; }
    else if (daily > 0) { tCls = 'warn'; tTxt = 'Tight today: only ' + money(daily) + '/day left — a ' + money(meal) + ' treat would overshoot by ' + money(r2(meal - daily)) + '.'; }
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
  function renderSinking() {
    var wrap = byId('sinking'), body = byId('sinkBody');
    if (!wrap || !body) return;
    var s = state.snapshot;
    var funds = s && s.sinking;
    if (!funds || !funds.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var html = '<h2 style="margin-top:0">Sinking funds</h2>';
    funds.forEach(function (f) {
      var pct = Number(f.goal) > 0 ? Math.min(100, Math.round((Number(f.funded) || 0) / Number(f.goal) * 100)) : 0;
      html += '<div class="ins-block" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)"><div class="ins-t">' + esc(f.name) +
        ' <span style="color:var(--mut);font-weight:400">· by ' + esc(f.deadline ? fmtDate(f.deadline) : '—') + '</span></div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="kv" style="border-top:0"><span class="k">funded ' + pct + '%</span><b>' + money(f.funded || 0) + ' of ' + money(f.goal || 0) + '</b></div>';
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

  function renderHero() {
    var el = byId('hero'); if (!el) return;
    var s = effectiveSnap();
    if (!s) { el.style.display = 'none'; heroVal = null; return; }
    el.style.display = '';
    var free = s.cash ? s.cash.free : 0;
    var hv = byId('heroFree');
    if (hv) {
      hv.className = 'hero-v' + (free < 0 ? ' bad' : '');
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
    var hs = byId('heroSub');
    if (hs) hs.innerHTML = sub.join(' · ');
    renderSpark();
  }
  function sparkData() {
    var s = state.snapshot;
    if (!s || !s.matrix || !s.matrix.base || !s.matrix.base.length) return null;
    var pts = [{ label: dayMonth((state.base && state.base.as_of) || todayISO()), v: Number(s.matrix.start_cash) || 0 }];
    s.matrix.base.forEach(function (row) {
      pts.push({ label: monthShort(row.month), v: Number(row.running) || 0 });
    });
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
    pts.forEach(function (p, i) {
      var anch = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
      svg += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + anch + '" font-size="8" fill="#93a1bd">' + esc(p.label) + '</text>';
    });
    box.innerHTML = svg + '</svg>';
  }
  // ---------- Phase 5: attention rows for the unified coach card ----------
  function findPaidTxn(d, kind) {
    var out = null;
    state.txns.forEach(function (t) {
      var amt = Number(t.amount) || 0;
      var hay = ((t.category || '') + ' ' + (t.note || '')).toLowerCase();
      if (kind === 'prepay') {
        if (String(t.date).slice(0, 7) !== d.monthPrefix) return;
        if (!/prepay|card|amex|visa|master|credit/.test(hay)) return;
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
    return out;
  }
  function coachRows(d) {
    var s = d.s, rows = [], alerts = [];
    var prepayActive = d.prepayAmt > 0;
    var prepayPaid = prepayActive ? findPaidTxn(d, 'prepay') : null;
    if (prepayActive) {
      var pw = d.prepayIn === 0 ? 'today' : (d.prepayIn === 1 ? 'tomorrow' : 'in ' + d.prepayIn + ' days');
      if (prepayPaid) rows.push({ cls: 'done', tag: 'Card prepay',
        text: 'Handled — ' + money(Number(prepaid.amount) || 0) + ' logged on ' + planWhen(String(prepaid.date)) + '. Nice.',
        r: 'done' });
      else {
        rows.push({ cls: d.prepayIn <= 2 ? 'bad' : 'warn', tag: 'Card prepay',
          text: 'Set aside ' + money(d.prepayAmt) + ' for the ' + ordinal(d.prepayDay) + ' prepay — due ' + pw + '.',
          r: money(d.prepayAmt) });
        alerts.push('prepay');
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
      rows.push({ cls: 'warn', tag: 'Looks recurring',
        text: recG.merchant + ' · ' + money(recG.amount) + ' in ' + recG.months + ' recent months — make it a monthly plan?',
        r: 'make it a plan', act: 'make_plan', payload: { name: recG.merchant, amount: recG.amount } });
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
  function renderDonut() {
    var wrap = byId('donut'), svgBox = byId('donutSvg'), leg = byId('donutLegend');
    if (!wrap || !svgBox || !leg) return;
    var mp = todayISO().slice(0, 7);
    var totals = {}, grand = 0;
    state.txns.forEach(function (t) {
      if (String(t.date).slice(0, 7) !== mp) return;
      var a = Number(t.amount) || 0;
      var c = t.category || 'Unsorted';
      totals[c] = (totals[c] || 0) + a;
      grand += a;
    });
    var names = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    if (!names.length || grand <= 0) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var segs = names.slice(0, 5).map(function (n) { return { name: n, v: totals[n] }; });
    var rest = 0;
    names.slice(5).forEach(function (n) { rest += totals[n]; });
    if (rest > 0) segs.push({ name: 'Other', v: rest });
    var R = 40, C = 2 * Math.PI * R, off = 0;
    var svg = '<svg viewBox="0 0 100 100" role="img" aria-label="This month by category">' +
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
    var wrap = byId('pace'), box = byId('paceBox'), note = byId('paceNote');
    if (!wrap || !box) return;
    var now = new Date();
    var mp = todayISO().slice(0, 7);
    var dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var elapsed = now.getDate();
    var spent = 0;
    state.txns.forEach(function (t) { if (String(t.date).slice(0, 7) === mp) spent += Number(t.amount) || 0; });
    if (!spent && !state.txns.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var daily = elapsed > 0 ? r2(spent / elapsed) : 0;
    var projected = r2(daily * dim);
    box.innerHTML =
      '<div class="p"><div class="k">Spent · ' + esc(monthLabel(mp)) + '</div><div class="v">' + money(spent) + '</div></div>' +
      '<div class="p"><div class="k">Avg / day (' + elapsed + 'd)</div><div class="v">' + money(daily) + '</div></div>' +
      '<div class="p"><div class="k">Projected · ' + dim + 'd</div><div class="v">' + money(projected) + '</div></div>';
    if (note) {
      var s = effectiveSnap();
      if (!s) { note.style.display = 'none'; return; }
      var free = s.cash ? s.cash.free : 0;
      note.style.display = '';
      note.innerHTML = projected > free
        ? '<span class="low">At this pace, ' + esc(monthLabel(mp)) + ' spend (' + money(projected) + ') would exceed free cash (' + money(free) + ').</span>'
        : 'Leaves ' + money(r2(free - projected)) + ' of free cash unspent at this pace.';
      // v68 item 4: per-category pace anomalies, under the monthly pace
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
      var rec = p.repeat === 'monthly';
      var occ = planOccurrences(p);
      occ.forEach(function (od, i) {
        var meta = rec ? fmtDate(od) + ' · monthly' : esc(planWhen(p.date)) + ' · ' + fmtDate(p.date);
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
    var p = { id: id, name: data.name, amount: data.amount, date: data.date,
      repeat: data.repeat === 'monthly' ? 'monthly' : null, created: new Date().toISOString() };
    state.plans.push(p);
    return idbPut(STORE_PLANS, p).then(function () {
      emit('plan');
      snack('Planned ' + esc(p.name) + ' · ' + money(p.amount) + (p.repeat ? ' · every month' : ''), function () {
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
    return idbDel(STORE_PLANS, id).then(function () {
      emit('plan');
      snack('Removed plan ' + esc(p.name), function () {
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
  function owedBalHTML(b) {
    if (b > 0.004) return '<span class="ow-bal plus">owes you ' + money(b) + '</span>';
    if (b < -0.004) return '<span class="ow-bal minus">you owe ' + money(-b) + '</span>';
    return '<span class="ow-bal zero">settled up</span>';
  }
  function owedPersonHTML(p) {
    var b = owedBal(p);
    var ents = (p.entries || []).slice().sort(function (a, c) {
      if (a.d !== c.d) return a.d < c.d ? 1 : -1;
      return (a.created || '') < (c.created || '') ? 1 : -1;
    });
    var rows = '';
    ents.forEach(function (e) {
      var dir = OWED_DIRS[e.dir] || OWED_DIRS.ipf;
      var amt = Number(e.amt) || 0;
      rows += '<div class="ow-e">' +
        '<div class="ow-el"><b>' + esc(dir.label) + '</b>' +
        (e.note ? ' <span class="ow-x">' + esc(e.note) + '</span>' : '') +
        '<div class="ow-k">' + esc(fmtDate(e.d)) + (e.expr ? ' · ' + esc(e.expr) : '') + '</div></div>' +
        '<b class="ow-amt ' + (dir.sign > 0 ? 'plus' : 'minus') + '">' + (dir.sign > 0 ? '+' : '\u2212') + money(amt) + '</b>' +
        '<button type="button" class="ow-xbtn" data-ow-del-e="' + esc(e.id) + '" aria-label="Remove entry">\u2715</button>' +
        '</div>';
    });
    return '<section class="card ow-p" data-ow-pid="' + esc(p.id) + '">' +
      '<div class="ow-h"><b>' + esc(p.name) + '</b>' + owedBalHTML(b) +
      '<button type="button" class="sheet-x" data-ow-del="' + esc(p.id) + '" aria-label="Remove person">\u2715</button></div>' +
      (rows || '<p class="note" style="margin:8px 0 0">No entries yet — add the first one below.</p>') +
      '<button type="button" class="addrow" data-ow-toggle="' + esc(p.id) + '">+ entry</button>' +
      '<form class="oent" data-ow-for="' + esc(p.id) + '" style="display:none" autocomplete="off">' +
      '<div class="oent-grid">' +
      '<div><label>Date</label><div class="dfield"><input type="date" class="oent-date">' +
      '<span class="dlabel empty" aria-hidden="true">Pick a date</span></div></div>' +
      '<div><label>Amount (\u20b1) — number or quick sum</label>' +
      '<input type="text" class="oent-amt" maxlength="40" autocomplete="off">' +
      '<p class="oent-eq" aria-live="polite"></p></div>' +
      '</div>' +
      '<label>What happened</label>' +
      '<div class="seg">' +
      '<label class="sel"><input type="radio" name="owdir" value="ipf" checked><span>I paid for them</span></label>' +
      '<label><input type="radio" name="owdir" value="itb"><span>I paid them back</span></label>' +
      '<label><input type="radio" name="owdir" value="tpf"><span>They paid for me</span></label>' +
      '<label><input type="radio" name="owdir" value="tmb"><span>They paid me back</span></label>' +
      '</div>' +
      '<label>Note (optional)</label>' +
      '<input type="text" class="oent-note" maxlength="60" autocomplete="off">' +
      '<div style="margin-top:14px"><button class="act" type="submit">Add entry</button></div>' +
      '</form>' +
      '</section>';
  }
  function renderOwed() {
    var body = byId('owedBody'); if (!body) return;
    var sum = byId('owedSum');
    var people = (state.owed.people || []).slice().sort(function (a, b) {
      return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1;
    });
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
  }
  function addOwedPerson(name) {
    name = String(name || '').trim();
    if (!name) return;
    var dupe = (state.owed.people || []).some(function (p) {
      return p.name.toLowerCase() === name.toLowerCase();
    });
    if (dupe) { snack('Already in the book: ' + esc(name)); return; }
    state.owed.people.push({ id: owedUid('ow'), name: name, entries: [] });
    saveOwed().then(emitOwed);
  }
  function delOwedPerson(id) {
    var idx = -1;
    (state.owed.people || []).forEach(function (p, i) { if (p.id === id) idx = i; });
    if (idx < 0) return;
    var gone = state.owed.people.splice(idx, 1)[0];
    saveOwed().then(function () {
      emitOwed();
      snack('Removed ' + esc(gone.name), function () {
        state.owed.people.push(gone);
        saveOwed().then(emitOwed);
      });
    });
  }
  function addOwedEntry(pid, data) {
    var p = null;
    (state.owed.people || []).forEach(function (x) { if (x.id === pid) p = x; });
    if (!p) return;
    if (!p.entries) p.entries = [];
    var e = {
      id: owedUid('oe'), d: data.d || todayISO(), amt: r2(data.amt),
      dir: OWED_DIRS[data.dir] ? data.dir : 'ipf',
      note: String(data.note || '').trim(), created: new Date().toISOString()
    };
    if (data.expr) e.expr = data.expr;
    p.entries.push(e);
    saveOwed().then(function () {
      emitOwed();
      snack(OWED_DIRS[e.dir].label + ' ' + money(e.amt) + ' · ' + esc(p.name), function () {
        p.entries = p.entries.filter(function (x) { return x.id !== e.id; });
        saveOwed().then(emitOwed);
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
    saveOwed().then(function () {
      emitOwed();
      snack('Removed ' + money(gone.amt) + ' entry', function () {
        p.entries.push(gone);
        saveOwed().then(emitOwed);
      });
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
    body.addEventListener('submit', function (ev) {
      var f = ev.target;
      if (!f || typeof f.className !== 'string' || f.className.indexOf('oent') < 0) return;
      ev.preventDefault();
      var pid = f.getAttribute('data-ow-for');
      var amtEl = f.querySelector('.oent-amt');
      var raw = String(amtEl.value || '').trim();
      var amt = evalExpr(raw);
      if (amt === null || !(amt > 0)) {
        alert('Enter an amount greater than 0 — a plain number, or a quick sum like 300-125+10.');
        return;
      }
      var dirEl = f.querySelector('input[name="owdir"]:checked');
      var expr = (raw !== String(r2(amt))) ? raw : null;
      addOwedEntry(pid, {
        d: f.querySelector('.oent-date').value || todayISO(),
        amt: amt, dir: dirEl ? dirEl.value : 'ipf', expr: expr,
        note: (f.querySelector('.oent-note').value || '').trim()
      });
    });
    body.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== body) {
        var tog = t.getAttribute && t.getAttribute('data-ow-toggle');
        var delP = t.getAttribute && t.getAttribute('data-ow-del');
        var delE = t.getAttribute && t.getAttribute('data-ow-del-e');
        if (tog) {
          var f = body.querySelector('.oent[data-ow-for="' + tog + '"]');
          if (f) {
            f.style.display = f.style.display === 'none' ? '' : 'none';
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
        }
      }
    });
  }
  function csvQ(s) {
    s = String(s == null ? '' : s);
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportData(kind) {
    var txns = state.txns.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.created || '') < (b.created || '') ? -1 : 1;
    });
    var plans = state.plans.slice().sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; });
    var stamp = todayISO();
    var blob, name;
    if (kind === 'csv') {
      var lines = ['date,account,kind,category,amount,note'];
      txns.forEach(function (t) {
        lines.push([t.date, csvQ(t.account), csvQ(t.kind), csvQ(t.category), t.amount, csvQ(t.note || '')].join(','));
      });
      blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      name = 'finances-ledger-' + stamp + '.csv';
    } else {
      blob = new Blob([JSON.stringify({
        app: 'finances-pwa', exportedAt: new Date().toISOString(),
        base: state.base, txns: txns, plans: plans, owed: state.owed.people,
        shadowLog: state.shadowLog || [] // v68 item 11: the rule-coverage evidence
      }, null, 2)], { type: 'application/json' });
      name = 'finances-export-' + stamp + '.json';
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 600);
    snack('Exported ' + name);
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
  function importData(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var data = JSON.parse(String(fr.result || ''));
        if (!data || data.app !== 'finances-pwa') throw new Error('not a Fin.AI PWA backup');
        // v71: fold any unsaved "Your numbers" edits into state before the
        // import replaces it (readBaseForm is synchronous; no save race).
        if (baseDirty) { var _nb = readBaseForm(); if (_nb) state.base = migrateBaseKinds(_nb); baseDirty = false; }
        var nb = defaultBase();
        if (data.base && (data.base.accounts || data.base.salary)) {
          Object.keys(nb).forEach(function (k) { if (data.base[k] !== undefined) nb[k] = data.base[k]; });
          nb.details = sanitizeDetails(nb.details); // v56
          state.base = migrateBaseKinds(nb); // v65
        }
        var saves = [];
        state.txns.forEach(function (t) { saves.push(idbDel(STORE_TX, t.id)); });
        state.plans.forEach(function (p) { saves.push(idbDel(STORE_PLANS, p.id)); });
        Promise.all(saves).then(function () {
          var puts = [];
          (data.txns || []).forEach(function (t) { if (t && t.id && t.date) puts.push(idbPut(STORE_TX, t)); });
          (data.plans || []).forEach(function (p) { if (p && p.id) puts.push(idbPut(STORE_PLANS, p)); });
          return Promise.all(puts);
        }).then(function () {
          state.txns = data.txns || [];
          state.plans = data.plans || [];
          var owedPeople = (data.owed || []).filter(function (p) {
            return p && typeof p.name === 'string' && p.name.trim() &&
              (p.entries || []).every(function (e) {
                return e && e.id && OWED_DIRS[e.dir] && (Number(e.amt) || 0) > 0 && e.d;
              });
          }).map(function (p) {
            return { id: p.id || owedUid('ow'), name: p.name.trim(), entries: p.entries || [] };
          });
          state.owed = { people: owedPeople };
          saveOwed();
          state.adj = { cash: 0, free: 0, card: 0, prepay: 0 };
          state.adjLoaded = true;
          // v47: persist the base too. The old code re-derived the snapshot from
          // the imported base in memory (and saved the snapshot) but never wrote
          // the base back to IndexedDB, so on the next launch the stale stored
          // base won and the imported accounts / salary / debts disappeared.
          // saveBase() writes base + snapshot + adj through the same path the
          // Settings editor uses, so an import sticks.
          return saveBase(state.base).then(function () {
            renderBaseEditor();
            renderBaseStatus();
            render();
            snack('Imported ' + (data.txns || []).length + ' entries · ' + (data.plans || []).length + ' plans · ' + owedPeople.length + ' owed people' + (state.base.migrated_from_snapshot || (data.base && data.base.accounts) ? ' · numbers restored' : ''));
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
  var SHELL_RELEASE = { v: 72.3, live: new Date(2026, 8, 12, 1, 6) }; // live re-stamped at each push
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
    mlDate: mlDate,           // v71: ledger row date+time (AM/PM)
    applyBaseChanges: applyBaseChanges,
    undoBaseStory: undoBaseStory,
    merchantCatFor: merchantCatFor, // v68 item 1: learned merchant→category lookup for the coach
    effectiveMerchantMap: effectiveMerchantMap,
    coachAlerts: coachAlerts, // v68 item 9: alert-driven chat chips
    coachFindings: coachFindings, // v68 item 12: findings for the Coach's-note prompt
    shadowLog: shadowLog, // v68 item 11: shadow-mode answering-path log
    exportData: exportData, // v68 item 11: lets the smoke read what the JSON export contains
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
      var payload = {
        date: byId('f_date').value || todayISO(),
        account: name,
        kind: type === 'CARD' ? 'card_charge' : 'cash_out',
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
      addPlan({ name: name, amount: amount, date: byId('p_date').value || todayISO(),
        repeat: repEl && repEl.checked ? 'monthly' : null }).then(function () {
        byId('p_name').value = '';
        byId('p_amount').value = '';
        if (repEl) repEl.checked = false;
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
    if (mlf) mlf.onchange = function () { mlFilterCat = mlf.value; renderMoneyLog(); };

    window.addEventListener('online', function () { state.online = true; });
    window.addEventListener('offline', function () { state.online = false; });

    var ab = byId('addBtn');
    if (ab) ab.onclick = function () { openSheet('addSheet'); };
    var cfab = byId('coachFab');
    if (cfab) cfab.onclick = function () {
      var ov = byId('coachOv');
      if (ov && ov.classList.contains('show')) closeCoach(); else openCoach();
    };
    var sbtn2 = byId('setBtn');
    if (sbtn2) sbtn2.onclick = function () { openSheet('setSheet'); };
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
    var ej = byId('expJson');
    if (ej) ej.onclick = function () { exportData('json'); };
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

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').then(function (reg) {
          swReg = reg;
          if (reg.waiting) showSwToast();
          reg.addEventListener('updatefound', function () {
            var nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', function () {
              // installed while this page is already controlled = a new version is ready
              if (nw.state === 'installed' && navigator.serviceWorker.controller) showSwToast();
            });
          });
        }).catch(function (err) { console.warn('SW register failed', err); });
      });
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
      if (!state.adjSig) state.adjSig = snapSig(state.snapshot);
      state.adjLoaded = true;
      persistSnapshot();
      idbPut(STORE_META, { key: 'base', value: state.base }).catch(function () {});
      renderBaseEditor();
      render();
      setTab(currentTab());
    }).catch(function (err) {
      console.warn('IDB load failed', err);
      state.base = state.base || defaultBase();
      refreshLocalSnapshot();
      state.adjSig = snapSig(state.snapshot);
      render();
      setTab(currentTab());
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();



