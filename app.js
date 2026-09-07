/* Finance PWA client — offline-first, syncs to the Apps Script Web App. */
(function () {
  'use strict';

  var DB_NAME = 'finances-pwa';
  var DB_VERSION = 3;
  var STORE_TX = 'txns';
  var STORE_PLANS = 'plans';
  var STORE_META = 'meta';
  var STORE_CHAT = 'chat';
  var LS_URL = 'fin.syncUrl';
  var LS_MEAL = 'fin.mealBudget';
  var LS_NAME = 'fin.name';
  var LS_TAB = 'fin.tab';
  var MEAL_DEFAULT = 400;

  var DEFAULT_ACCOUNTS = [
    { name: 'MariBank CC', type: 'card' },
    { name: 'Maya CC', type: 'card' },
    { name: 'MariBank', type: 'cash' },
    { name: 'Maya Savings', type: 'cash' },
    { name: 'LandBank', type: 'cash' }
  ];

  var CATEGORY_DEFAULTS = [
    'Food / Gym Nutrition', 'Gym Membership', 'Rent', 'Water', 'Wi-Fi', 'Spotify',
    "Parents' Utilities Support", 'Laundry', 'Personal Treats / Gear', 'Transport',
    'Debt payment', 'Savings / Sinking', 'Other'
  ];
  var CAT_CUSTOM = '__custom__';
  var catSig = '';

  var state = {
    online: navigator.onLine,
    txns: [],
    plans: [],
    snapshot: null,
    lastSync: null,
    syncing: false,
    error: null,
    adj: { cash: 0, free: 0, card: 0, prepay: 0 },
    adjSig: '',
    adjLoaded: false,
    coachMem: null,
    moneyLog: []
  };

  // ---------- event bus: a state change re-renders only the views that depend on it ----------
  var RENDER_BY_KEY = {
    txn: [renderStatus, renderSummary, renderCoach, renderInsights, renderProjection, updateChargeHint, renderHero, renderDonut, renderPace, renderMoneyLog],
    plan: [renderPlans, renderInsights, renderCoach, renderProjection, renderHero],
    snap: [renderSummary, renderCoach, renderInsights, renderProjection, renderObligations, renderSinking, seedAccounts, updateChargeHint, renderHero],
    sync: [renderStatus, renderSyncErr, renderFooter, renderConnect],
    online: [renderStatus, renderSyncErr, renderFooter, renderConnect],
    adj: [renderSummary, renderCoach, renderInsights, renderProjection, updateChargeHint, renderHero],
    ui: [renderStatus, renderSyncErr, renderConnect, renderSummary, seedAccounts, seedCategories, renderCoach, renderInsights, renderProjection, renderObligations, renderSinking, renderAddEmpty, renderPlans, renderFooter, updateChargeHint, renderHero, renderDonut, renderPace, renderMoneyLog]
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

  var seededAccounts = false;

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

  // ---------- helpers ----------
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
  function getUrl() { try { return localStorage.getItem(LS_URL) || ''; } catch (e) { return ''; } }
  function setUrl(u) { try { localStorage.setItem(LS_URL, u); } catch (e) {} }
  function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
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
      return ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'][Number(p[1]) - 1] + " '" + p[0].slice(2);
    }
    return m || '';
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
    try { n = (localStorage.getItem(LS_NAME) || '').trim(); } catch (e) {}
    if (!n && s) n = String(s.display_name || '').trim();
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

  // ---------- API ----------
  function apiGet() {
    return fetch(getUrl(), { method: 'GET', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function apiPost(txns) {
    return fetch(getUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ txns: txns })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---------- sync ----------
  function pendingList() { return state.txns.filter(function (t) { return !t.synced; }); }
  function pendingSum() { return pendingList().reduce(function (s, t) { return s + (Number(t.amount) || 0); }, 0); }

  function doSync() {
    if (state.syncing) return Promise.resolve();
    if (!state.online || !getUrl()) { emit('sync'); return Promise.resolve(); }
    state.syncing = true;
    state.error = null;
    emit('sync');
    var pending = pendingList();
    var chain;
    if (pending.length) {
      var payload = pending.map(function (t) {
        return { id: t.id, date: t.date, account: t.account, kind: t.kind, category: t.category, amount: t.amount, note: t.note };
      });
      chain = apiPost(payload).then(function (res) {
        if (!res.ok) throw new Error(res.error || 'sync failed');
        var done = {};
        (res.appended || []).concat(res.skipped || []).forEach(function (id) { done[id] = true; });
        var toSave = [];
        state.txns.forEach(function (t) { if (!t.synced && done[t.id]) { t.synced = true; toSave.push(t); } });
        if (res.snapshot) setServerSnapshot(res.snapshot);
        return toSave;
      });
    } else {
      chain = apiGet().then(function (snap) { setServerSnapshot(snap); return []; });
    }
    return chain
      .then(function (toSave) {
        state.lastSync = new Date().toISOString();
        return Promise.all(toSave.map(function (t) { return idbPut(STORE_TX, t); }));
      })
      .then(function () {
        var saves = [idbPut(STORE_META, { key: 'snapshot', value: state.snapshot, at: state.lastSync })];
        if (state.adjLoaded) {
          saves.push(idbPut(STORE_META, { key: 'adj', value: state.adj }));
          saves.push(idbPut(STORE_META, { key: 'adjSig', value: state.adjSig }));
        }
        return Promise.all(saves);
      })
      .catch(function (err) { state.error = String(err && err.message || err); })
      .then(function () { state.syncing = false; render(); });
  }

  // ---------- actions ----------
  function addTxn(data) {
    var id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    var t = {
      id: id, date: data.date, account: data.account, kind: data.kind,
      category: data.category, amount: data.amount, note: data.note,
      synced: false, created: new Date().toISOString()
    };
    state.txns.push(t);
    addAdj(txnAdj(t), 1);
    logMoney('add', t);
    return Promise.all([idbPut(STORE_TX, t), saveAdj()]).then(function () {
      emit('txn');
      snack('Added ' + money(t.amount) + ' · ' + esc(t.category || t.account), function () { undoAddTxn(id); });
      if (state.online && getUrl()) return doSync();
      return Promise.resolve();
    }).then(function () { return id; });
  }
  function undoAddTxn(id) {
    var t = null;
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === id) t = state.txns[i];
    if (!t) return;
    if (t.synced) { snack('Already synced to the sheet — remove it there.'); return; }
    state.txns = state.txns.filter(function (x) { return x.id !== id; });
    addAdj(txnAdj(t), -1);
    logMoney('del', t);
    Promise.all([idbDel(STORE_TX, id), saveAdj()]).then(function () { emit('txn'); });
  }
  function deleteTxn(id) {
    var t = null;
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === id) t = state.txns[i];
    if (!t || t.synced) return Promise.resolve();
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

  // ---------- Phase 6: money log — per-change audit trail so the overview math can be sanity-checked ----------
  var ML_CAP = 30;   // entries kept in the meta store (the card shows all of them)
  function logMoney(action, t) {
    var s = effectiveSnap();
    if (!s) return;
    var amt = Number(t.amount) || 0;
    var mp = todayISO().slice(0, 7);
    var e = {
      at: Date.now(), a: action,
      l: (t.category || t.account || 'entry') + (t.note ? ' · ' + t.note : ''),
      c: t.category || t.account || 'entry', nt: t.note || '', m: t.account || '',
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
    return MO[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function mlParts(e) {
    var lab, note = '';
    if (e.c != null) {
      lab = e.c;
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
  function renderMoneyLog() {
    var el = byId('moneyLog');
    if (!el) return;
    var noteEl = byId('mlNote');
    var body = byId('mlBody');
    var log = state.moneyLog || [];
    if (!log.length) {
      if (noteEl) noteEl.style.display = 'none';
      body.innerHTML = '<p class="note" style="margin:2px 0">' + (state.txns.length
        ? 'Nothing logged yet — add or remove an entry to see how it moves your free cash.'
        : 'No entries yet — tap + to add your first expense.') + '</p>';
      return;
    }
    if (noteEl) noteEl.style.display = '';
    body.innerHTML = log.slice().reverse().map(function (e) {
        var add = e.a === 'add';
        var before = r2(e.f + (add ? e.n : -e.n));
        var extra = '';
        if (e.k === 'c') extra = '<span class="ml-x">card ' + money(r2(e.o + (add ? -e.n : e.n))) + ' → ' + money(e.o) + '</span>';
        if (e.s != null) extra += '<span class="ml-x">month spent ' + money(r2(e.s + (add ? -e.n : e.n))) + ' → ' + money(e.s) + '</span>';
        var p = mlParts(e);
        return '<div class="ml-row' + (add ? '' : ' del') + '">' +
          '<div class="ml-l"><div class="ml-cat">' + esc(p.lab) + '</div>' +
          (p.note ? '<div class="ml-note">' + esc(p.note) + '</div>' : '') +
          '<div class="ml-meta">' + mlDate(e.at) + (p.m ? ' · ' + esc(p.m) : '') + '</div></div>' +
          '<div class="ml-r"><b class="' + (add ? 'ml-down' : 'ml-up') + '">' + (add ? '−' : '+') + money(e.n) + '</b>' +
          '<span class="ml-f">free ' + money(before) + ' → ' + money(e.f) + '</span>' + extra + '</div></div>';
      }).join('');
  }

  // ---------- bottom sheets (Add, Settings) ----------
  var openSheetEl = null;
  var lastFocus = null;
  function closeSheets() {
    var sc = byId('scrim');
    var wasOpen = !!openSheetEl;
    if (sc) sc.classList.remove('show');
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
    // a11y: move focus into the sheet (first field, else first control)
    try {
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

  // ---------- render ----------
  function tile(k, v, n, cls) {
    return '<div class="tile ' + (cls || '') + '"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div><div class="n">' + esc(n) + '</div></div>';
  }
  function renderStatus() {
    var el = byId('status'); if (!el) return;
    var pill = state.online ? '<span class="pill ok">online</span>' : '<span class="pill warn">offline</span>';
    var p = pendingList();
    var pend = p.length ? '&nbsp;·&nbsp;<b>' + p.length + '</b> pending ' + money(pendingSum()) : '';
    var spin = state.syncing ? '&nbsp;&nbsp;<span class="spin"></span> syncing…' : '';
    el.innerHTML = pill + pend + spin;
    var sb = byId('syncBtn');
    if (sb) { sb.disabled = !!state.syncing; sb.textContent = state.syncing ? 'Syncing…' : 'Sync'; }
  }
  function renderSyncErr() {
    var el = byId('syncErr'); if (!el) return;
    if (state.error && !state.syncing) {
      el.style.display = '';
      el.textContent = 'Sync failed — ' + state.error + ' · tap to retry';
    } else {
      el.style.display = 'none';
    }
  }
  function renderConnect() {
    var el = byId('connect');
    if (el) el.style.display = getUrl() ? 'none' : '';
    var st = byId('connStatus');
    if (st) st.innerHTML = getUrl()
      ? '<span class="pill ok">connected</span>&nbsp; · last synced ' + (state.lastSync ? new Date(state.lastSync).toLocaleTimeString() : '—')
      : '<span class="pill warn">not connected</span>&nbsp; · entries save on this phone only';
  }
  function renderSummary() {
    var el = byId('summary'); if (!el) return;
    var s = effectiveSnap();
    if (!s) {
      el.innerHTML = '<div class="card"><p class="note" style="margin:2px 0">' +
        (state.online ? 'Syncing…' : (getUrl() ? 'Waiting for a connection to sync.' : 'Add expenses with the + button — they save offline. Connect your sheet in Settings to sync.')) + '</p></div>';
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
    el.innerHTML = '<div class="tiles' + (state.syncing ? ' busy' : '') + '">' + html + '</div>' + adjBar();
    var rb = byId('resetAdj');
    if (rb) rb.onclick = resetAdj;
  }
  function adjBar() {
    if (!adjActive()) return '';
    return '<div class="adjbar"><span class="note">live view: includes ' + money(state.adj.free) + ' recorded in this app</span>' +
      '<button class="mini" id="resetAdj" type="button" title="Stop adjusting and trust the sheet numbers">reset to sheet</button></div>';
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
      if (prepayActive && d.prepayIn > 0) sub += ' Or set aside ' + money(r2(shortfall / d.prepayIn)) + '/day until the ' + ordinal(d.prepayDay) + ' and it\'s covered.';
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
      sub = 'It keeps the next 7 days covered, and an eat-out (about ' + money(d.meal) + ') is safe.';
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
        html += '<button type="button" class="dig ' + rw.cls + '" data-digto="money">' +
          '<span class="dg-l"><span class="dg-tag">' + esc(rw.tag) + '</span>' + esc(rw.text) + '</span>' +
          '<span class="dg-r">' + esc(rw.r) + '</span></button>';
      });
      body.innerHTML = html;
      var btns = body.querySelectorAll('[data-digto]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].onclick = function () { setTab(this.getAttribute('data-digto')); };
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
    var nameEl = byId('nameEdit');
    if (nameEl && !nameEl.value) nameEl.value = coachName(d.s);
    var blocks = '';

    // ---- Today: daily headroom + treat check
    var todaySpend = d.todaySpend;
    var daily = d.daily;
    var tLines = ['Headroom: <b>' + money(daily) + '/day</b> left across the next ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' (free cash ÷ days left).'];
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
    mLines.push('Committed on the sheet: <b>' + money(s.committed ? s.committed.base : 0) + '</b> (worst case ' + money(s.committed ? s.committed.worst : 0) + ').');
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
    var pts = [{ label: 'now', v: Number(s.matrix.start_cash) || 0 }];
    s.matrix.base.forEach(function (row) {
      pts.push({ label: monthShort(row.month), v: Number(row.running) || 0 });
    });
    var floorLine = Number(s.floor) > 0 ? Number(s.floor) : (Number(s.emergency_cap) || 0);
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
      '<path d="' + line + ' L' + X(pts.length - 1).toFixed(1) + ' ' + (H - PB) + ' L' + X(0).toFixed(1) + ' ' + (H - PB) + ' Z" fill="rgba(91,140,255,.13)" stroke="none"/>' +
      '<path d="' + line + '" fill="none" stroke="#5b8cff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
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
    var floor = Number(s.floor) > 0 ? Number(s.floor) : (Number(s.emergency_cap) || 0);
    if (floor > 0 && state.snapshot && state.snapshot.matrix && state.snapshot.matrix.base) {
      var base = state.snapshot.matrix.base, worst = state.snapshot.matrix.worst || [];
      var baseDip = null, worstDip = null;
      base.forEach(function (row, i) {
        var rv = Number(row.running) || 0;
        if (!baseDip && rv < floor) baseDip = { v: rv, m: row.month };
        var w = worst[i];
        if (w) {
          var wv = Number(w.running) || 0;
          if (wv < floor && (!worstDip || wv < worstDip.v)) worstDip = { v: wv, m: w.month };
        }
      });
      if (baseDip) { rows.push({ cls: 'bad', tag: 'Cash floor',
        text: 'Cash dips to ' + money(baseDip.v) + ' in ' + monthLabel(baseDip.m) + ' — floor is ' + money(floor) + '.',
        r: 'below floor' }); alerts.push('floor'); }
      else if (worstDip) { rows.push({ cls: 'warn', tag: 'Worst case',
        text: 'With the full emergency budgeted each month, cash dips to ' + money(worstDip.v) + ' in ' + monthLabel(worstDip.m) + '.',
        r: 'floor ' + fmtNum(floor) }); alerts.push('floor'); }
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
          rows.push({ cls: planned > 0 ? 'warn' : 'bad', tag: 'Sinking behind',
            text: f.name + ' needs about ' + money(needed) + '/month to reach ' + money(goal) + ' by ' + monthLabel(dl) + '; it is on ' + money(planned) + '/month.',
            r: money(needed - planned) + ' short' });
          alerts.push('sink');
        }
      });
    }
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
  var DONUT_COLORS = ['#5b8cff', '#37d39b', '#ffc45c', '#ff6b6b', '#b48cff', '#64748b'];
  function renderDonut() {
    var wrap = byId('donut'), svgBox = byId('donutSvg'), leg = byId('donutLegend');
    if (!wrap || !svgBox || !leg) return;
    var mp = todayISO().slice(0, 7);
    var totals = {}, grand = 0;
    state.txns.forEach(function (t) {
      if (String(t.date).slice(0, 7) !== mp) return;
      var a = Number(t.amount) || 0;
      var c = t.category || 'Other';
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
    }
  }
  function renderAddEmpty() {
    var el = byId('addEmpty');
    if (el) el.style.display = getUrl() ? 'none' : '';
  }
  function seedAccounts() {
    var sel = byId('f_account');
    if (!sel || seededAccounts) return;
    var s = state.snapshot;
    var accounts;
    if (s && ((s.cards && s.cards.length) || (s.cash && s.cash.accounts && s.cash.accounts.length))) {
      accounts = [];
      (s.cards || []).forEach(function (c) { accounts.push({ name: c.name, type: 'card' }); });
      (s.cash.accounts || []).forEach(function (a) { accounts.push({ name: a.name, type: 'cash' }); });
    } else {
      accounts = DEFAULT_ACCOUNTS;
    }
    if (!accounts.length) return;
    var prev = sel.value;
    var html = '<option value="" disabled selected>Pick…</option>';
    accounts.forEach(function (a) {
      var v = (a.type === 'card' ? 'CARD' : 'CASH') + '::' + a.name;
      html += '<option value="' + esc(v) + '">' + esc(a.name) + (a.type === 'card' ? ' (card)' : ' (cash)') + '</option>';
    });
    sel.innerHTML = html;
    if (prev) sel.value = prev;
    seededAccounts = true;
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
  function updateChargeHint() {
    var el = byId('chargeHint'); if (!el) return;
    var amtEl = byId('f_amount');
    var amt = amtEl ? parseFloat(amtEl.value) : NaN;
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
      var lines = ['date,account,kind,category,amount,note,synced'];
      txns.forEach(function (t) {
        lines.push([t.date, csvQ(t.account), csvQ(t.kind), csvQ(t.category), t.amount, csvQ(t.note || ''), t.synced ? 'yes' : 'no'].join(','));
      });
      blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      name = 'finances-ledger-' + stamp + '.csv';
    } else {
      blob = new Blob([JSON.stringify({ app: 'finances-pwa', exportedAt: new Date().toISOString(), txns: txns, plans: plans }, null, 2)], { type: 'application/json' });
      name = 'finances-export-' + stamp + '.json';
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 600);
    snack('Exported ' + name);
  }
  function renderFooter() {
    var el = byId('foot'); if (!el) return;
    var parts = [];
    if (state.lastSync) parts.push('last synced ' + new Date(state.lastSync).toLocaleTimeString());
    if (state.error) parts.push('<span class="low">sync error: ' + esc(state.error) + '</span>');
    if (!getUrl()) parts.push('not connected');
    el.innerHTML = parts.join('<br>') || '&nbsp;';
  }
  var TABS = ['home', 'money', 'ledger', 'coach'];
  var TAB_MIGRATE = { overview: 'money', add: 'ledger' };
  var shownTab = null;        // pane currently on screen
  var lastCoachTab = 'home';  // where Coach returns to when the tab is tapped again
  function setTab(name) {
    if (TAB_MIGRATE[name]) name = TAB_MIGRATE[name];
    if (TABS.indexOf(name) < 0) name = 'home';
    if (name === 'coach' && shownTab === 'coach') name = lastCoachTab;  // tapping the Coach tab again closes it
    else if (name !== 'coach') lastCoachTab = name;
    shownTab = name;
    var panes = { home: byId('tab-home'), money: byId('tab-money'), ledger: byId('tab-ledger'), coach: byId('tab-coach') };
    Object.keys(panes).forEach(function (k) {
      if (panes[k]) panes[k].style.display = k === name ? '' : 'none';
    });
    var btns = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = btns[i].getAttribute('data-tab') === name ? 'tab active' : 'tab';
    }
    try { localStorage.setItem(LS_TAB, name); } catch (e) {}
    window.scrollTo(0, 0);
    if (name === 'coach' && window.__financeChat && window.__financeChat.open) window.__financeChat.open();
  }
  function closeCoach() {
    if (shownTab === 'coach') setTab(lastCoachTab || 'home');
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
  function seedCategories() {
    var sel = byId('f_category');
    if (!sel) return;
    var seen = {};
    CATEGORY_DEFAULTS.forEach(function (c) { seen[c] = true; });
    (state.txns || []).forEach(function (t) { if (t && t.category) seen[t.category] = true; });
    var extra = Object.keys(seen).filter(function (c) { return CATEGORY_DEFAULTS.indexOf(c) < 0; }).sort();
    var names = CATEGORY_DEFAULTS.concat(extra);
    var sig = names.join('|');
    if (sig === catSig) return;
    catSig = sig;
    var cur = sel.value;
    var html = '<option value="" disabled' + (cur ? '' : ' selected') + '>Pick a category…</option>';
    names.forEach(function (c) {
      html += '<option value="' + esc(c) + '"' + (cur === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    });
    html += '<option value="' + CAT_CUSTOM + '"' + (cur === CAT_CUSTOM ? ' selected' : '') + '>Custom…</option>';
    sel.innerHTML = html;
    var c = byId('f_categoryCustom');
    if (c) c.style.display = sel.value === CAT_CUSTOM ? '' : 'none';
  }
  function render() { emit('ui'); }

  // ---------- bridge for chat.js (the chat writes through the app's own actions) ----------
  window.FinApp = {
    addPlan: addPlan,
    deletePlan: deletePlan,
    addTxn: addTxn,
    deleteTxn: deleteTxn,
    snack: snack,
    sync: doSync,
    render: render,
    setTab: setTab,
    closeCoach: closeCoach,
    openSettings: function () { openSheet('setSheet'); },
    online: function () { return state.online; },
    lastSync: function () { return state.lastSync; },
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

  // ---------- init ----------
  function init() {
    var dateEl = byId('f_date');
    if (dateEl && !dateEl.value) dateEl.value = todayISO();
    if (dateEl) { dateEl.addEventListener('input', function () { syncDateLabel(dateEl); }); syncDateLabel(dateEl); }
    var pdateEl = byId('p_date');
    if (pdateEl && !pdateEl.value) pdateEl.value = todayISO();
    if (pdateEl) { pdateEl.addEventListener('input', function () { syncDateLabel(pdateEl); }); syncDateLabel(pdateEl); }

    var cbtn = byId('connectBtn');
    if (cbtn) cbtn.onclick = function () {
      var u = (byId('syncUrl').value || '').trim();
      if (!u) return;
      setUrl(u); render(); doSync();
    };
    var sbtn = byId('syncBtn');
    if (sbtn) sbtn.onclick = function () { doSync(); };

    var tabBtns = document.querySelectorAll('.tab');
    for (var i = 0; i < tabBtns.length; i++) {
      (function (b) { b.onclick = function () { setTab(b.getAttribute('data-tab')); }; })(tabBtns[i]);
    }

    var form = byId('addForm');
    if (form) form.onsubmit = function (e) {
      e.preventDefault();
      var raw = byId('f_account').value;
      if (!raw) { alert('Pick an account (card or cash).'); return; }
      var sep = raw.indexOf('::');
      var type = raw.slice(0, sep), name = raw.slice(sep + 2);
      var amount = parseFloat(byId('f_amount').value);
      if (!(amount > 0)) { alert('Enter an amount greater than 0.'); return; }
      var catVal = byId('f_category').value;
      var category = (catVal === CAT_CUSTOM ? byId('f_categoryCustom').value : catVal) || '';
      category = category.trim();
      if (!category) { alert('Pick a category — or choose Custom… and type one.'); return; }
      addTxn({
        date: byId('f_date').value || todayISO(),
        account: name,
        kind: type === 'CARD' ? 'card_charge' : 'cash_out',
        category: category,
        amount: amount,
        note: (byId('f_note').value || '').trim()
      }).then(function () {
        byId('f_amount').value = '';
        byId('f_category').value = '';
        byId('f_categoryCustom').value = '';
        byId('f_categoryCustom').style.display = 'none';
        byId('f_note').value = '';
        seedCategories();
        byId('f_amount').focus();
      });
    };

    var pform = byId('planForm');
    if (pform) pform.onsubmit = function (e) {
      e.preventDefault();
      var name = (byId('p_name').value || '').trim();
      var amount = parseFloat(byId('p_amount').value);
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
    var mealEl = byId('mealEdit');
    if (mealEl) mealEl.onchange = function () {
      var v = parseFloat(mealEl.value);
      if (v > 0) { try { localStorage.setItem(LS_MEAL, String(v)); } catch (e2) {} }
      else mealEl.value = mealBudget();
      render();
    };
    var nameEl = byId('nameEdit');
    if (nameEl) nameEl.onchange = function () {
      var v = nameEl.value.trim();
      try { if (v) localStorage.setItem(LS_NAME, v); else localStorage.removeItem(LS_NAME); } catch (e2) {}
      render();
    };
    var amtEl = byId('f_amount');
    if (amtEl) amtEl.addEventListener('input', updateChargeHint);
    var catEl = byId('f_category');
    if (catEl) catEl.onchange = function () {
      var c = byId('f_categoryCustom');
      if (c) { c.style.display = catEl.value === CAT_CUSTOM ? '' : 'none'; if (catEl.value === CAT_CUSTOM) c.focus(); }
    };

    window.addEventListener('online', function () { state.online = true; emit('online'); doSync(); });
    window.addEventListener('offline', function () { state.online = false; emit('online'); });
    window.addEventListener('focus', function () { if (state.online && getUrl() && pendingList().length) doSync(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && state.online && getUrl() && pendingList().length) doSync(); });

    var se = byId('syncErr');
    if (se) se.onclick = function () { doSync(); };

    var ab = byId('addBtn');
    if (ab) ab.onclick = function () { openSheet('addSheet'); };
    var sbtn2 = byId('setBtn');
    if (sbtn2) sbtn2.onclick = function () { openSheet('setSheet'); };
    var ac = byId('addClose');
    if (ac) ac.onclick = closeSheets;
    var scb = byId('setClose');
    if (scb) scb.onclick = closeSheets;
    var scrim = byId('scrim');
    if (scrim) scrim.onclick = closeSheets;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheets(); });
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
    var snb = byId('syncNowBtn');
    if (snb) snb.onclick = function () { doSync(); };
    var hob = byId('homeOpenSet');
    if (hob) hob.onclick = function () { openSheet('setSheet'); };

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
      var hasAdj = false;
      (res[1] || []).forEach(function (m) {
        if (m.key === 'snapshot') { state.snapshot = m.value; state.lastSync = m.at; }
        else if (m.key === 'adj') { state.adj = m.value; hasAdj = true; }
        else if (m.key === 'adjSig') { state.adjSig = m.value || ''; }
        else if (m.key === 'coachMem') { state.coachMem = m.value; }
        else if (m.key === 'moneyLog') { state.moneyLog = m.value || []; }
      });
      if (!hasAdj) computeAdjFromTxns();
      if (!state.adjSig && state.snapshot) state.adjSig = snapSig(state.snapshot);
      state.adjLoaded = true;
      render();
      setTab(currentTab());
      if (state.online && getUrl()) doSync();
    }).catch(function (err) {
      console.warn('IDB load failed', err);
      render();
      setTab(currentTab());
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();



