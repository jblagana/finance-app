/* FinSmart v39 — main-thread client for the offline brain (model-worker.js).
 *
 * The worker does all the model math; this file only moves messages and keeps
 * the chat UI honest:
 *  - lazy: the worker starts on first need (a question or the download card),
 *    never on app open
 *  - consent: the ~400 MB first download only starts from the chat offer card
 *    or the Settings toggle — both say the size out loud
 *  - FinAI.prepare(text) embeds the message the coach is about to parse, so
 *    chat.js can read the vector synchronously while its rules run
 *  - stored names are embedded once and cached in localStorage (hash-keyed),
 *    so the semantic layer's cosine lookups cost nothing at parse time
 *  - the rule engine stays the only writer: nothing in this file calls a
 *    FinApp write action; the LLM path only produces chat text
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.FinApp) return;

  var WORKER_URL = './model-worker.js';
  var AI_KEY = 'fin.ai.v1';        // '1' = user opted in to the offline brain
  var OFFER_KEY = 'fin.ai.offer.v1'; // the download card was shown/dismissed once
  var VEC_KEY = 'fin.ai.vecs.v1';  // cached embeddings of the stored names
  var NAME_LIMIT = 48;             // cap on how many names we embed
  var FLOAT_DP = 1e4;              // rounding keeps the localStorage blob small

  var worker = null;
  var seq = 0;
  var pending = {};                // id -> {resolve, reject} (embed round-trips)
  var genCbs = {};                 // id -> {resolve, reject, onToken}
  var statusCbs = [];
  var state = {
    state: 'idle', device: 'wasm', embedReady: false, llmReady: false,
    llm: null, progress: null, err: null
  };
  var vecCache = {};               // message text -> embedding (page life only)
  var nameVecs = { hash: '', names: {} };

  function byId(id) { return document.getElementById(id); }

  function enabled() { try { return localStorage.getItem(AI_KEY) === '1'; } catch (e) { return false; } }
  function setEnabled(v) {
    try { if (v) localStorage.setItem(AI_KEY, '1'); else localStorage.removeItem(AI_KEY); } catch (e) {}
    refreshNote();
  }
  function offered() { try { return localStorage.getItem(OFFER_KEY) === '1'; } catch (e) { return false; } }
  function markOffered() { try { localStorage.setItem(OFFER_KEY, '1'); } catch (e) {} }

  function emitStatus() {
    for (var i = 0; i < statusCbs.length; i++) { try { statusCbs[i](state); } catch (e) {} }
    refreshNote();
  }
  function onStatus(cb) {
    statusCbs.push(cb);
    try { cb(state); } catch (e) {}
    return cb;
  }

  function getWorker() {
    if (worker) return worker;
    try { worker = new Worker(WORKER_URL, { type: 'module' }); }
    catch (e) { worker = false; return null; }
    worker.onmessage = onMsg;
    worker.onerror = function (e) {
      state.state = 'error';
      state.err = String((e && e.message) || 'model worker failed to start');
      emitStatus();
    };
    return worker;
  }

  function onMsg(e) {
    var m = e.data || {};
    var p, g;
    if (m.type === 'status') {
      state.state = m.state;
      state.device = m.device || state.device;
      state.embedReady = !!m.embedReady;
      state.llmReady = !!m.llmReady;
      state.llm = m.llm || null;
      if (m.err) state.err = m.err;
      if (m.state !== 'loading') state.progress = null;
      emitStatus();
    } else if (m.type === 'progress') {
      state.progress = m;
      emitStatus();
    } else if (m.type === 'llm-fallback') {
      state.progress = { stage: 'llm-fallback', model: m.model };
      emitStatus();
    } else if (m.type === 'embed-result') {
      p = pending[m.id]; delete pending[m.id];
      if (p) p.resolve(m.vecs);
    } else if (m.type === 'embed-error') {
      p = pending[m.id]; delete pending[m.id];
      if (p) p.reject(new Error(m.err));
    } else if (m.type === 'token') {
      g = genCbs[m.id];
      if (g && g.onToken) { try { g.onToken(m.text); } catch (e) {} }
    } else if (m.type === 'gen-done') {
      g = genCbs[m.id]; delete genCbs[m.id];
      if (g) g.resolve(m.text);
    } else if (m.type === 'gen-error') {
      g = genCbs[m.id]; delete genCbs[m.id];
      if (g) g.reject(new Error(m.err));
    }
  }

  function callEmbed(payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var w = getWorker();
      if (!w) { reject(new Error('no model worker')); return; }
      var id = 'r' + (++seq);
      var to = setTimeout(function () { delete pending[id]; reject(new Error('timed out')); }, timeoutMs || 8000);
      pending[id] = {
        resolve: function (v) { clearTimeout(to); resolve(v); },
        reject: function (err) { clearTimeout(to); reject(err); }
      };
      w.postMessage(Object.assign({ type: 'embed', id: id }, payload));
    });
  }

  // --- loading -------------------------------------------------------------
  function ensureLoaded() {
    var w = getWorker();
    if (!w) return Promise.reject(new Error('no model worker'));
    w.postMessage({ type: 'load' }); // the worker ignores it when already loaded
    if (state.state !== 'idle' && state.state !== 'loading') return Promise.resolve(state);
    return new Promise(function (resolve) {
      var done = function (s) {
        if (s.state !== 'idle' && s.state !== 'loading') {
          statusCbs.splice(statusCbs.indexOf(done), 1);
          clearTimeout(to);
          resolve(s);
        }
      };
      statusCbs.push(done);
      var to = setTimeout(function () {
        statusCbs.splice(statusCbs.indexOf(done), 1);
        resolve(state);
      }, 600000);
      done(state);
    });
  }

  // --- message embedding (read synchronously by the rule engine) -----------
  function keyOf(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''); }

  function prepare(text) {
    var k = keyOf(text);
    if (!k || !enabled() || !state.embedReady) return Promise.resolve(null);
    if (vecCache[k]) return Promise.resolve(vecCache[k]);
    return callEmbed({ texts: [k] }, 6000).then(function (vecs) {
      var v = vecs && vecs[0];
      if (v && v.length) vecCache[k] = v;
      return v || null;
    })['catch'](function () { return null; });
  }
  function vecFor(text) { return vecCache[keyOf(text)] || null; }

  // --- stored-name embeddings (cosine candidates for the semantic layer) ---
  function nameHash(names) {
    var s = names.slice().sort().join('|');
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(16) + ':' + names.length;
  }

  function loadNameVecs() {
    try {
      var j = JSON.parse(localStorage.getItem(VEC_KEY) || 'null');
      if (j && j.hash && j.names) nameVecs = j;
    } catch (e) {}
  }

  function ensureNameVecs(names) {
    if (!enabled() || !state.embedReady || !names || !names.length) return Promise.resolve(false);
    var uniq = [];
    for (var i = 0; i < names.length; i++) {
      var n = String(names[i] || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      if (n && uniq.indexOf(n) < 0) uniq.push(n);
    }
    if (!uniq.length) return Promise.resolve(false);
    if (uniq.length > NAME_LIMIT) uniq = uniq.slice(0, NAME_LIMIT);
    var h = nameHash(uniq);
    if (nameVecs.hash === h) return Promise.resolve(true);
    return callEmbed({ texts: uniq }, 20000).then(function (vecs) {
      var nv = { hash: h, names: {} };
      for (var i = 0; i < uniq.length; i++) {
        if (!vecs[i] || !vecs[i].length) continue;
        var r = new Array(vecs[i].length);
        for (var k = 0; k < vecs[i].length; k++) r[k] = Math.round(vecs[i][k] * FLOAT_DP) / FLOAT_DP;
        nv.names[uniq[i].toLowerCase()] = r;
      }
      nameVecs = nv;
      try { localStorage.setItem(VEC_KEY, JSON.stringify(nv)); } catch (e) {}
      return true;
    })['catch'](function () { return false; });
  }
  function nameVec(name) { return nameVecs.names[String(name || '').toLowerCase()] || null; }

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // --- coach generation (streamed text only — never an action) -------------
  function generate(messages, opts, onToken) {
    return new Promise(function (resolve, reject) {
      var w = getWorker();
      if (!w) { reject(new Error('no model worker')); return; }
      var id = 'g' + (++seq);
      var to = setTimeout(function () {
        if (genCbs[id]) { delete genCbs[id]; reject(new Error('the coach timed out')); }
      }, (opts && opts.timeout) || 65000);
      genCbs[id] = {
        onToken: onToken,
        resolve: function (t) { clearTimeout(to); resolve(t); },
        reject: function (e) { clearTimeout(to); reject(e); }
      };
      w.postMessage({ type: 'generate', id: id, messages: messages, opts: opts || {} });
    });
  }

  // --- settings UI (the toggle lives in index.html's Settings sheet) -------
  function refreshNote() {
    var cb = byId('aiToggle'), note = byId('aiNote');
    if (!cb && !note) return;
    var on = enabled();
    if (cb) { try { cb.checked = on; } catch (e) {} }
    if (!note) return;
    if (!on) { note.textContent = 'Off — the coach answers from the rule engine only.'; return; }
    var s = state;
    if (s.state === 'loading') {
      var p = s.progress || null;
      note.textContent = 'Downloading… ' + (p && p.pct != null ? p.pct + '%' : 'starting') +
        (p && p.stage === 'llm' ? ' (the big coach model)' : '');
    } else if (s.state === 'ready') {
      note.textContent = 'Ready on this phone · ' + (s.device === 'webgpu' ? 'WebGPU' : 'WASM') +
        (s.llm ? ' · ' + s.llm.split('/')[1] : '') + ' · works offline';
    } else if (s.state === 'partial') {
      note.textContent = 'Name-matching is ready; the coach model didn’t fit on this phone.';
    } else if (s.state === 'error') {
      note.textContent = 'Couldn’t load (' + (s.err || 'unknown error') + '). Flip this off and on to retry.';
    } else {
      note.textContent = 'On — downloads about 400 MB the first time you use it, then works without signal.';
    }
  }
  function bindSettings() {
    var cb = byId('aiToggle');
    if (!cb) return;
    cb.addEventListener('change', function () {
      setEnabled(cb.checked);
      if (cb.checked) ensureLoaded(); // starting it here is consent — the size is stated above
    });
    refreshNote();
    // the flag persists across sessions: an opted-in phone re-loads the brain
    // on page load (after the first download the weights are cached, so this
    // is free and works offline)
    if (enabled()) ensureLoaded();
  }

  window.FinAI = {
    enabled: enabled,
    setEnabled: setEnabled,
    offered: offered,
    markOffered: markOffered,
    state: function () { return state; },
    onStatus: onStatus,
    ensureLoaded: ensureLoaded,
    prepare: prepare,
    vecFor: vecFor,
    ensureNameVecs: ensureNameVecs,
    nameVec: nameVec,
    cosine: cosine,
    generate: generate
  };

  loadNameVecs();
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindSettings);
    else bindSettings();
  }
})();

