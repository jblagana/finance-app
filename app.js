/* Finance PWA client — offline-first, syncs to the Apps Script Web App. */
(function () {
  'use strict';

  var DB_NAME = 'finances-pwa';
  var DB_VERSION = 2;
  var STORE_TX = 'txns';
  var STORE_PLANS = 'plans';
  var STORE_META = 'meta';
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
    adjLoaded: false
  };

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
    saveAdj().then(render);
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
    if (!state.online || !getUrl()) { render(); return Promise.resolve(); }
    state.syncing = true;
    state.error = null;
    render();
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
    return Promise.all([idbPut(STORE_TX, t), saveAdj()]).then(function () {
      render();
      if (state.online && getUrl()) return doSync();
      return Promise.resolve();
    });
  }
  function deleteTxn(id) {
    var t = null;
    for (var i = 0; i < state.txns.length; i++) if (state.txns[i].id === id) t = state.txns[i];
    if (!t || t.synced) return Promise.resolve();
    state.txns = state.txns.filter(function (x) { return x.id !== id; });
    addAdj(txnAdj(t), -1);
    return Promise.all([idbDel(STORE_TX, id), saveAdj()]).then(render);
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
  }
  function renderConnect() {
    var el = byId('connect'); if (!el) return;
    el.style.display = getUrl() ? 'none' : '';
  }
  function renderSummary() {
    var el = byId('summary'); if (!el) return;
    var s = effectiveSnap();
    if (!s) {
      el.innerHTML = '<div class="card"><p class="note" style="margin:2px 0">' +
        (state.online ? 'Syncing…' : (getUrl() ? 'Waiting for a connection to sync.' : 'Add expenses below — they save offline. Connect your sheet above to sync.')) + '</p></div>';
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
    html += tile('Committed · ' + esc(monthLabel(s.month)), money(s.committed ? s.committed.base : 0), 'worst ' + money(s.committed ? s.committed.worst : 0));
    el.innerHTML = '<div class="tiles">' + html + '</div>' + adjBar();
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
      var dd = diffDays(today, p.date);
      if (dd >= 0 && dd <= 6) items.push({ d: dd, date: p.date, label: p.name || 'Plan', amt: Number(p.amount) || 0 });
      else if (dd > 6) { laterCount++; laterAmt += Number(p.amount) || 0; }
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
      if (String(p.date).slice(0, 7) === monthPrefix) { monthPlans += Number(p.amount) || 0; monthPlanCount++; }
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
      weekCost: weekCost, laterCount: laterCount, laterAmt: r2(laterAmt),
      monthPlans: r2(monthPlans), monthPlanCount: monthPlanCount,
      spentM: spentM, pace: pace,
      freeAfterPace: r2(free - r2(pace * Math.max(0, daysLeft - 1)))
    };
  }
  function renderCoach() {
    var el = byId('coach'); if (!el) return;
    var d = insightsData();
    if (!d) { el.style.display = 'none'; return; }
    el.style.display = '';
    var name = coachName(d.s);
    var hi = name ? 'Hey ' + name + ' — ' : 'Heads up — ';
    var cls, head, sub;
    if (d.free < 0) {
      cls = 'bad';
      head = hi + 'no room to breathe right now.';
      sub = 'Free cash is ' + money(d.free) + '.' + (d.prepayAmt > 0
        ? ' Skip the treats today and put it toward the ' + money(d.prepayAmt) + ' prepay due on the ' + ordinal(d.prepayDay) + '.'
        : ' Skip the treats today — back the cards first.');
    } else if (d.prepayIn <= 3 && d.prepayAmt > 0) {
      cls = 'warn';
      var due = d.prepayIn === 0 ? 'today' : 'in ' + d.prepayIn + ' day' + (d.prepayIn === 1 ? '' : 's');
      head = hi + money(d.prepayAmt) + ' card prepay is due ' + due + ' (the ' + ordinal(d.prepayDay) + ').';
      sub = 'Set aside ' + money(d.prepayIn > 0 ? r2(d.prepayAmt / d.prepayIn) : d.prepayAmt) + ' a day and keep today under ' + money(d.daily) + ' so it stays covered.';
    } else if (d.weekCost > d.free) {
      cls = 'bad';
      head = hi + 'this week is over budget by ' + money(r2(d.weekCost - d.free)) + '.';
      sub = 'The next 7 days have ' + money(d.weekCost) + ' coming up vs ' + money(d.free) + ' free. Keep today at zero extras, or trim a plan to make room.';
    } else if (d.freeAfterPace < 0) {
      cls = 'warn';
      head = hi + 'at ' + money(d.pace) + '/day you finish the month ' + money(r2(-d.freeAfterPace)) + ' in the red.';
      sub = 'Easing to about ' + money(d.daily) + '/day from here puts you back on track.';
    } else if (d.daily < d.meal) {
      cls = 'warn';
      head = hi + 'keep today around ' + money(d.daily) + '.';
      sub = 'That is your daily share of the free cash; a ' + money(d.meal) + ' treat would overshoot by ' + money(r2(d.meal - d.daily)) + '. I recommend not going over budget.';
    } else {
      cls = 'good';
      head = hi + 'you are on track. You can spend up to ' + money(d.daily) + ' today.';
      sub = 'It keeps the next 7 days covered, and an eat-out (about ' + money(d.meal) + ') is safe.';
    }
    el.className = 'card coach ' + cls;
    var h = byId('coachHead'), sb = byId('coachSub');
    if (h) h.textContent = head;
    if (sb) sb.textContent = sub;
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
  function renderList() {
    var el = byId('txns'); if (!el) return;
    var txns = state.txns.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (a.created || '') < (b.created || '') ? 1 : -1;
    });
    if (!txns.length) { el.innerHTML = '<p class="note" style="margin:2px 0">No entries yet — add your first expense above.</p>'; return; }
    var html = '';
    txns.forEach(function (t) {
      var badge = t.synced ? '<span class="pill ok">synced</span>' : '<span class="pill warn">pending</span>';
      var del = t.synced ? '' : '<button class="mini" data-del="' + t.id + '" title="Delete">✕</button>';
      var amt = money(t.amount).replace('PHP ', '');
      html += '<div class="txn"><div><div class="txn-cat">' + esc(t.category || '—') + '</div>' +
        '<div class="txn-meta">' + fmtDate(t.date) + ' · ' + esc(t.account) + '</div></div>' +
        '<div class="txn-r"><div class="txn-amt">− ' + amt + '</div><div class="badgedel">' + badge + del + '</div></div></div>';
    });
    el.innerHTML = html;
    var btns = el.querySelectorAll('[data-del]');
    for (var i = 0; i < btns.length; i++) btns[i].onclick = function () { deleteTxn(this.getAttribute('data-del')); };
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
      html += '<div class="txn"><div><div class="txn-cat">' + esc(p.name || 'Plan') + '</div>' +
        '<div class="txn-meta">' + esc(planWhen(p.date)) + ' · ' + fmtDate(p.date) + '</div></div>' +
        '<div class="txn-r"><div class="txn-amt">₱ ' + amt + '</div><div class="badgedel">' +
        '<button class="mini" data-delp="' + p.id + '" title="Delete">✕</button></div></div></div>';
    });
    el.innerHTML = html;
    var btns = el.querySelectorAll('[data-delp]');
    for (var i = 0; i < btns.length; i++) btns[i].onclick = function () { deletePlan(this.getAttribute('data-delp')); };
  }
  function addPlan(data) {
    var id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    var p = { id: id, name: data.name, amount: data.amount, date: data.date, created: new Date().toISOString() };
    state.plans.push(p);
    return idbPut(STORE_PLANS, p).then(function () { render(); });
  }
  function deletePlan(id) {
    state.plans = state.plans.filter(function (x) { return x.id !== id; });
    return idbDel(STORE_PLANS, id).then(render);
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
  function renderFooter() {
    var el = byId('foot'); if (!el) return;
    var parts = [];
    if (state.lastSync) parts.push('last synced ' + new Date(state.lastSync).toLocaleTimeString());
    if (state.error) parts.push('<span class="low">sync error: ' + esc(state.error) + '</span>');
    if (!getUrl()) parts.push('not connected');
    el.innerHTML = parts.join('<br>') || '&nbsp;';
  }
  function setTab(name) {
    var home = byId('tab-home'), over = byId('tab-overview');
    if (!home || !over) return;
    if (name === 'overview') { home.style.display = 'none'; over.style.display = ''; }
    else { home.style.display = ''; over.style.display = 'none'; }
    var btns = document.querySelectorAll('.tab');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = btns[i].getAttribute('data-tab') === name ? 'tab active' : 'tab';
    }
    try { localStorage.setItem(LS_TAB, name); } catch (e) {}
    window.scrollTo(0, 0);
  }
  function currentTab() {
    if (!state.snapshot) return 'overview';
    try { var t = localStorage.getItem(LS_TAB); if (t === 'home' || t === 'overview') return t; } catch (e) {}
    return 'home';
  }
  function render() {
    renderStatus(); renderConnect(); renderSummary(); seedAccounts(); renderList();
    renderCoach(); renderInsights(); renderProjection(); renderPlans(); renderFooter(); updateChargeHint();
  }

  // ---------- init ----------
  function init() {
    var dateEl = byId('f_date');
    if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
    var pdateEl = byId('p_date');
    if (pdateEl && !pdateEl.value) pdateEl.value = todayISO();

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
      addTxn({
        date: byId('f_date').value || new Date().toISOString().slice(0, 10),
        account: name,
        kind: type === 'CARD' ? 'card_charge' : 'cash_out',
        category: (byId('f_category').value || '').trim(),
        amount: amount,
        note: (byId('f_note').value || '').trim()
      }).then(function () {
        byId('f_amount').value = '';
        byId('f_note').value = '';
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
      addPlan({ name: name, amount: amount, date: byId('p_date').value || todayISO() }).then(function () {
        byId('p_name').value = '';
        byId('p_amount').value = '';
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

    window.addEventListener('online', function () { state.online = true; render(); doSync(); });
    window.addEventListener('offline', function () { state.online = false; render(); });
    window.addEventListener('focus', function () { if (state.online && getUrl() && pendingList().length) doSync(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && state.online && getUrl() && pendingList().length) doSync(); });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function (err) { console.warn('SW register failed', err); });
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



