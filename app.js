/* Finance PWA client — offline-first, syncs to the Apps Script Web App. */
(function () {
  'use strict';

  var DB_NAME = 'finances-pwa';
  var DB_VERSION = 1;
  var STORE_TX = 'txns';
  var STORE_META = 'meta';
  var LS_URL = 'fin.syncUrl';

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
    snapshot: null,
    lastSync: null,
    syncing: false,
    error: null
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
        if (res.snapshot) state.snapshot = res.snapshot;
        return toSave;
      });
    } else {
      chain = apiGet().then(function (snap) { state.snapshot = snap; return []; });
    }
    return chain
      .then(function (toSave) {
        state.lastSync = new Date().toISOString();
        return Promise.all(toSave.map(function (t) { return idbPut(STORE_TX, t); }));
      })
      .then(function () { return idbPut(STORE_META, { key: 'snapshot', value: state.snapshot, at: state.lastSync }); })
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
    return idbPut(STORE_TX, t).then(function () {
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
    return idbDel(STORE_TX, id).then(render);
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
    var s = state.snapshot;
    if (!s) {
      el.innerHTML = '<div class="card"><p class="note" style="margin:2px 0">' +
        (state.online ? 'Syncing…' : (getUrl() ? 'Waiting for a connection to sync.' : 'Add expenses below — they save offline. Connect your sheet above to sync.')) + '</p></div>';
      return;
    }
    var free = s.cash ? s.cash.free : 0;
    var belowFloor = !!(s.cash && s.floor && s.cash.total < s.floor);
    var html = '';
    html += tile('Liquid cash', money(s.cash ? s.cash.total : 0), 'floor ' + money(s.floor || 0), belowFloor ? 'bad' : '');
    html += tile('Free / unallocated', money(free), 'card backing', free < 0 ? 'bad' : 'good');
    html += tile('Cards owed', money(s.card_owed), (s.cards || []).length + ' card(s)');
    html += tile('14th prepay', money(s.total_prepay), 'due before the 15th', 'accent');
    html += tile('Committed · ' + (s.month || ''), money(s.committed ? s.committed.base : 0), 'worst ' + money(s.committed ? s.committed.worst : 0));
    el.innerHTML = '<div class="tiles">' + html + '</div>';
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
  function renderFooter() {
    var el = byId('foot'); if (!el) return;
    var parts = [];
    if (state.lastSync) parts.push('last synced ' + new Date(state.lastSync).toLocaleTimeString());
    if (state.error) parts.push('<span class="low">sync error: ' + esc(state.error) + '</span>');
    if (!getUrl()) parts.push('not connected');
    el.innerHTML = parts.join('<br>') || '&nbsp;';
  }
  function render() {
    renderStatus(); renderConnect(); renderSummary(); seedAccounts(); renderList(); renderFooter();
  }

  // ---------- init ----------
  function init() {
    var dateEl = byId('f_date');
    if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);

    var cbtn = byId('connectBtn');
    if (cbtn) cbtn.onclick = function () {
      var u = (byId('syncUrl').value || '').trim();
      if (!u) return;
      setUrl(u); render(); doSync();
    };
    var sbtn = byId('syncBtn');
    if (sbtn) sbtn.onclick = function () { doSync(); };

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

    window.addEventListener('online', function () { state.online = true; render(); doSync(); });
    window.addEventListener('offline', function () { state.online = false; render(); });
    window.addEventListener('focus', function () { if (state.online && getUrl() && pendingList().length) doSync(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && state.online && getUrl() && pendingList().length) doSync(); });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function (err) { console.warn('SW register failed', err); });
      });
    }

    Promise.all([idbAll(STORE_TX), idbAll(STORE_META)]).then(function (res) {
      state.txns = res[0] || [];
      (res[1] || []).forEach(function (m) { if (m.key === 'snapshot') { state.snapshot = m.value; state.lastSync = m.at; } });
      render();
      if (state.online && getUrl()) doSync();
    }).catch(function (err) {
      console.warn('IDB load failed', err);
      render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();



