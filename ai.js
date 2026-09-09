/* FinSmart v39 — main-thread client for the offline brain (model-worker.js).
 *
 * The worker does all the model math; this file only moves messages and keeps
 * the chat UI honest:
 *  - lazy: the worker starts on first need (a question or the download card),
 *    never on app open
 *  - consent: the ~250 MB first download only starts from the chat offer card
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
  var MODEL_KEY = 'fin.ai.model.v1'; // '135' (fast, default) or '360' (smarter)

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

  // --- coach model preference (135M fast vs 360M smarter) -------------------
  function modelPref() { try { return localStorage.getItem(MODEL_KEY) === '360' ? '360' : '135'; } catch (e) { return '135'; } }
  function modelName() {
    var s = String(state.llm || '');
    if (s.indexOf('360M') >= 0) return '360M';
    if (s.indexOf('135M') >= 0) return '135M';
    return modelPref() === '360' ? '360M' : '135M';
  }
  // Switching the model tears down the current worker and re-loads with the new
  // preference so exactly one coach model is resident. The weights stay cached,
  // so a repeat switch is a local load, not a re-download. WebKit still runs the
  // non-JSEP single-threaded kernel — only the model choice changes.
  function setModel(which) {
    var pick = (which === '360') ? '360' : '135';
    try { localStorage.setItem(MODEL_KEY, pick); } catch (e) {}
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    pending = {}; genCbs = {}; vecCache = {};
    state = { state: 'idle', device: 'wasm', embedReady: false, llmReady: false, llm: null, progress: null, err: null };
    refreshNote();
    refreshModelSel();
    if (enabled()) ensureLoaded();
  }

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
    w.postMessage({ type: 'load', model: modelPref() }); // the worker ignores it when already loaded
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
  // --- v45: remote coach (a free hosted LLM behind the user's Cloudflare Worker).
  // The Worker holds the provider API key + CORS; the app only knows the Worker
  // URL (stored on this phone, never a secret). Online + configured -> remote;
  // offline / unconfigured / failed -> the local brain; both down -> rules-only.
  var REMOTE_KEY = 'fin.ai.remote.v1';
  var REMOTE_URL_KEY = 'fin.ai.remote.url.v1';
  var lastSource = 'local';        // 'remote' | 'local' -- the UI labels by this
  var remoteFailAt = 0;            // circuit breaker: skip remote right after a failure
  var REMOTE_COOL_MS = 30000;      // ...for 30 s so a dead endpoint can't hang every reply
  var REMOTE_TIMEOUT_MS = 20000;   // a free API is fast; longer than this is a failure
  // v47: bring-your-own key — the coach calls the provider straight from this
  // phone. The key + settings live only in this device's localStorage and are
  // sent only to that provider (never to a Worker). Default: Groq, which allows
  // browser calls. The Worker URL above stays as the fallback for providers
  // that block the browser.
  var BYO_PROVIDER_KEY = 'fin.ai.by.provider.v1';
  var BYO_KEY = 'fin.ai.by.key.v1';
  var BYO_BASE_KEY = 'fin.ai.by.base.v1';
  var BYO_MODEL_KEY = 'fin.ai.by.model.v1';
  var GROQ_BASE = 'https://api.groq.com/openai/v1';
  var GROQ_MODEL = 'qwen/qwen3.8-27b';
  var OPENAI_BASE = 'https://api.openai.com/v1';

  function remoteEnabled() { var k = null; try { k = localStorage.getItem(REMOTE_KEY); } catch (e) {} return k === '1'; }
  function setRemoteEnabled(v) {
    try { if (v) localStorage.setItem(REMOTE_KEY, '1'); else localStorage.removeItem(REMOTE_KEY); } catch (e) {}
    refreshNote();
  }
  function remoteUrl() { var u = null; try { u = localStorage.getItem(REMOTE_URL_KEY); } catch (e) {} return String(u || '').trim(); }
  function setRemoteUrl(u) {
    u = String(u || '').trim();
    try { if (u) localStorage.setItem(REMOTE_URL_KEY, u); else localStorage.removeItem(REMOTE_URL_KEY); } catch (e) {}
    refreshNote();
  }
  function workerConfigured() { var u = remoteUrl(); return !!u && /^https:\/\//i.test(u); }
  // v47: bring-your-own key (direct provider calls). The key + settings live
  // only in this device's localStorage and are sent only to that provider.
  function byoProvider() { var p = null; try { p = localStorage.getItem(BYO_PROVIDER_KEY); } catch (e) {} return p === 'openai' ? 'openai' : 'groq'; }
  function setByoProvider(p) {
    try { localStorage.setItem(BYO_PROVIDER_KEY, p === 'openai' ? 'openai' : 'groq'); } catch (e) {}
    refreshNote();
  }
  function byoKey() { var k = null; try { k = localStorage.getItem(BYO_KEY); } catch (e) {} return String(k || '').trim(); }
  function setByoKey(k) {
    k = String(k || '').trim();
    try { if (k) localStorage.setItem(BYO_KEY, k); else localStorage.removeItem(BYO_KEY); } catch (e) {}
    refreshNote();
  }
  function byoBase() { var b = null; try { b = localStorage.getItem(BYO_BASE_KEY); } catch (e) {} return String(b || '').trim(); }
  function setByoBase(b) {
    b = String(b || '').trim();
    try { if (b) localStorage.setItem(BYO_BASE_KEY, b); else localStorage.removeItem(BYO_BASE_KEY); } catch (e) {}
    refreshNote();
  }
  function byoModel() { var m = null; try { m = localStorage.getItem(BYO_MODEL_KEY); } catch (e) {} return String(m || '').trim(); }
  function setByoModel(m) {
    m = String(m || '').trim();
    try { if (m) localStorage.setItem(BYO_MODEL_KEY, m); else localStorage.removeItem(BYO_MODEL_KEY); } catch (e) {}
    refreshNote();
  }
  function byoConfigured() { return !!byoKey() && !!byoBase(); }
  // A remote backend is configured if either path has what it needs.
  function remoteConfigured() { return workerConfigured() || byoConfigured(); }
  // v47: a remote failure/fix updates the cooldown AND the header LED.
  function noteRemote(ok) { remoteFailAt = ok ? 0 : Date.now(); refreshLed(); }
  // The Worker path (v45): the app only ever knows the Worker URL.
  function workerGenerate(messages, opts, onToken) {
    return new Promise(function (resolve, reject) {
      var url = remoteUrl();
      if (!workerConfigured()) { reject(new Error('remote coach not configured')); return; }
      if (typeof fetch !== 'function') { reject(new Error('fetch unavailable')); return; }
      var done = false, timer = null;
      function finish(fn, val) { if (done) return; done = true; if (timer) clearTimeout(timer); fn(val); }
      timer = setTimeout(function () { noteRemote(false); finish(reject, new Error('remote coach timed out')); }, REMOTE_TIMEOUT_MS);
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: messages, max_tokens: Math.min(96, (opts && opts.maxNew) || 48) })
      }).then(function (res) {
        if (!res || !res.ok) { noteRemote(false); finish(reject, new Error('remote coach error ' + (res ? res.status : 'net'))); return; }
        return res.json().then(function (data) {
          var text = (data && typeof data.text === 'string') ? data.text : '';
          if (!text) { noteRemote(false); finish(reject, new Error('remote coach returned no text')); return; }
          noteRemote(true); lastSource = 'remote';
          if (onToken) { try { onToken(text); } catch (e) {} }
          finish(resolve, text);
        });
      })['catch'](function (err) { noteRemote(false); finish(reject, err || new Error('remote coach network error')); });
    });
  }
  // v47: bring-your-own key — the same request, but the browser calls the
  // provider directly with the user's own key (OpenAI chat/completions shape).
  function byoGenerate(messages, opts, onToken) {
    return new Promise(function (resolve, reject) {
      var key = byoKey();
      if (!key) { reject(new Error('bring-your-own key not set')); return; }
      var base = byoBase().replace(/\/+$/, '');
      if (!base) { reject(new Error('bring-your-own base URL not set')); return; }
      if (typeof fetch !== 'function') { reject(new Error('fetch unavailable')); return; }
      var done = false, timer = null;
      function finish(fn, val) { if (done) return; done = true; if (timer) clearTimeout(timer); fn(val); }
      timer = setTimeout(function () { noteRemote(false); finish(reject, new Error('coach timed out')); }, REMOTE_TIMEOUT_MS);
      fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: byoModel() || GROQ_MODEL, messages: messages, max_tokens: Math.min(96, (opts && opts.maxNew) || 48), temperature: 0.2 })
      }).then(function (res) {
        if (!res || !res.ok) { noteRemote(false); finish(reject, new Error('coach error ' + (res ? res.status : 'net'))); return; }
        return res.json().then(function (data) {
          var text = (data && data.choices && data.choices[0] && data.choices[0].message && typeof data.choices[0].message.content === 'string') ? data.choices[0].message.content : '';
          if (!text) { noteRemote(false); finish(reject, new Error('coach returned no text')); return; }
          noteRemote(true); lastSource = 'remote';
          if (onToken) { try { onToken(text); } catch (e) {} }
          finish(resolve, text);
        });
      })['catch'](function (err) { noteRemote(false); finish(reject, err || new Error('coach network error')); });
    });
  }
  // Dispatch: Worker first, then bring-your-own, else not configured.
  function remoteGenerate(messages, opts, onToken) {
    if (workerConfigured()) return workerGenerate(messages, opts, onToken);
    if (byoConfigured()) return byoGenerate(messages, opts, onToken);
    return Promise.reject(new Error('remote coach not configured'));
  }
  // v47: is the online coach usable right now? (the header LED)
  function remoteAvailable() {
    var online = typeof navigator === 'undefined' || navigator.onLine !== false;
    var inCooldown = remoteFailAt !== 0 && (Date.now() - remoteFailAt < REMOTE_COOL_MS);
    return remoteEnabled() && remoteConfigured() && online && !inCooldown;
  }
  function refreshLed() {
    var led = byId('coachLed');
    if (!led) return;
    var on = remoteAvailable();
    led.className = 'coach-led' + (on ? ' on' : '');
    led.setAttribute('title', on ? 'Online coach: available' : 'Online coach: not available');
  }

  function testRemote() {
    var note = byId('aiRemoteNote');
    function show(msg, ok) { if (note) { note.textContent = msg; note.style.color = ok === null ? '' : (ok ? 'var(--ok)' : 'var(--bad)'); } }
    if (!workerConfigured() && !byoConfigured()) { show('Set a Worker URL or a bring-your-own key first.', false); return; }
    if (typeof fetch !== 'function') { show('fetch is unavailable in this browser.', false); return; }
    var useWorker = workerConfigured();
    var url, headers = { 'content-type': 'application/json' }, body;
    if (useWorker) {
      url = remoteUrl();
      body = JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
    } else {
      url = byoBase().replace(/\/+$/, '') + '/chat/completions';
      headers['authorization'] = 'Bearer ' + byoKey();
      body = JSON.stringify({ model: byoModel() || GROQ_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
    }
    show('Testing...', null);
    var timer = setTimeout(function () { show('Timed out -- check the ' + (useWorker ? 'Worker deploy' : 'key / URL / network') + '.', false); }, REMOTE_TIMEOUT_MS);
    fetch(url, { method: 'POST', headers: headers, body: body }).then(function (res) {
      clearTimeout(timer);
      if (!res || !res.ok) { show('Replied ' + (res ? res.status : 'net') + ' -- check ' + (useWorker ? 'deploy + secret' : 'key + model') + '.', false); return; }
      return res.json().then(function (d) {
        var ok = useWorker ? !!(d && d.text) : !!(d && d.choices && d.choices[0]);
        show(ok ? 'Online coach is working' : 'No reply -- check the ' + (useWorker ? 'provider API key' : 'model name') + '.', ok);
      });
    })['catch'](function () { clearTimeout(timer); show('Could not reach ' + url + ' -- check the URL + network (browser calls need a CORS-enabled provider, e.g. Groq).', false); });
  }
  function refreshRemoteNote() {
    var rc = byId('aiRemoteToggle'), rn = byId('aiRemoteNote');
    if (rc) { try { rc.checked = remoteEnabled(); } catch (e) {} }
    var backend = workerConfigured() ? 'your Worker' : (byoConfigured() ? 'your own key (direct)' : 'not configured yet');
    if (rn) {
      rn.style.color = '';
      rn.textContent = remoteEnabled()
        ? 'On -- when online, open questions go to the online coach via ' + backend + '; offline or on failure the local coach takes over.'
        : 'Off -- open questions use the local coach (or the rule engine) on this phone.';
    }
    refreshLed();
  }

  // The on-device brain, unchanged. Extracted so the dispatcher can fall back.
  function localGenerate(messages, opts, onToken) {
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
  function localReady() {
    return enabled() && state.llmReady === true;
  }
  // v45: remote first (online + configured + out of cooldown), local fallback.
  // v46: fail fast (with a readable message) when the remote is unavailable and
  // the local brain isn't ready either — otherwise the local path would hang
  // for its 65 s timeout on a phone that never downloaded the model.
  function generate(messages, opts, onToken) {
    lastSource = 'local';
    var online = typeof navigator === 'undefined' || navigator.onLine !== false;
    var inCooldown = remoteFailAt !== 0 && (Date.now() - remoteFailAt < REMOTE_COOL_MS);
    if (!(remoteEnabled() && remoteConfigured() && online && !inCooldown)) {
      if (!localReady()) {
        return Promise.reject(new Error('the offline brain isn’t ready (Settings → Offline brain) and the remote coach is unavailable right now'));
      }
      return localGenerate(messages, opts, onToken);
    }
    return remoteGenerate(messages, opts, onToken)['catch'](function (err) {
      if (localReady()) { lastSource = 'local'; return localGenerate(messages, opts, onToken); }
      lastSource = 'remote'; // we did call the remote; the error is about it
      throw err;
    });
  }

  // --- settings UI (the toggle lives in index.html's Settings sheet) -------
  function refreshNote() {
    refreshRemoteNote();
    var cb = byId('aiToggle'), note = byId('aiNote');
    if (!cb && !note) return;
    var on = enabled();
    if (cb) { try { cb.checked = on; } catch (e) {} }
    if (!note) return;
    if (!on) { note.textContent = 'Off — the coach answers from the rule engine only.'; return; }
    var s = state;
    var mm = modelName(); // '135M' | '360M'
    var mMB = mm === '360M' ? '180 MB' : '130 MB';
    if (s.state === 'loading') {
      var p = s.progress || null;
      note.textContent = 'Downloading… ' + (p && p.pct != null ? p.pct + '%' : 'starting') +
        (p && p.stage === 'llm' ? ' (the ' + mm + ' coach)' : '');
    } else if (s.state === 'ready') {
      note.textContent = 'Ready on this phone · ' + (s.device === 'webgpu' ? 'WebGPU' : 'WASM') +
        ' · ' + mm + ' coach · works offline';
    } else if (s.state === 'partial') {
      note.textContent = 'Name-matching is ready; the coach model didn’t fit on this phone.';
    } else if (s.state === 'error') {
      note.textContent = 'Couldn’t load (' + (s.err || 'unknown error') + '). Flip this off and on to retry.';
    } else {
      note.textContent = 'On — downloads about ' + mMB + ' for the ' + mm + ' coach the first time, then works without signal.';
    }
  }
  function bindSettings() {
    // v45: remote coach (independent of the local brain)
    var rc = byId('aiRemoteToggle');
    if (rc) rc.addEventListener('change', function () { setRemoteEnabled(rc.checked); });
    var ru = byId('aiRemoteUrl');
    if (ru) {
      if (!ru.value) ru.value = remoteUrl();
      ru.addEventListener('change', function () { setRemoteUrl(ru.value); });
    }
    var rt = byId('aiRemoteTest');
    if (rt) rt.addEventListener('click', testRemote);
    // v47: bring-your-own key (direct provider calls)
    var bp = byId('aiByoProvider');
    if (bp) {
      bp.value = byoProvider();
      bp.addEventListener('change', function () {
        setByoProvider(bp.value);
        var bb = byId('aiByoBase'), bm = byId('aiByoModel');
        if (bp.value === 'groq') { if (bb) bb.value = GROQ_BASE; if (bm) bm.value = GROQ_MODEL; }
        else if (bb) bb.value = OPENAI_BASE;
      });
    }
    var bk = byId('aiByoKey');
    if (bk) bk.addEventListener('change', function () { setByoKey(bk.value); });
    var bb2 = byId('aiByoBase');
    if (bb2) { bb2.value = byoBase() || (byoProvider() === 'openai' ? OPENAI_BASE : GROQ_BASE); bb2.addEventListener('change', function () { setByoBase(bb2.value); }); }
    var bm2 = byId('aiByoModel');
    if (bm2) { bm2.value = byoModel(); bm2.addEventListener('change', function () { setByoModel(bm2.value); }); }
    // the online-coach LED reacts to connectivity whenever the page is up
    if (typeof window !== 'undefined') {
      window.addEventListener('online', refreshLed);
      window.addEventListener('offline', refreshLed);
    }
    var cb = byId('aiToggle');
    if (!cb) return;
    cb.addEventListener('change', function () {
      setEnabled(cb.checked);
      if (cb.checked) ensureLoaded(); // starting it here is consent — the size is stated above
    });
    var m135 = byId('aiModel135'), m360 = byId('aiModel360');
    if (m135) m135.addEventListener('click', function () { setModel('135'); });
    if (m360) m360.addEventListener('click', function () { setModel('360'); });
    refreshNote();
    refreshModelSel();
    var lexClr = byId('aiLexClear');
    if (lexClr) lexClr.addEventListener('click', function () {
      if (typeof window.FinApp !== 'undefined' && typeof window.FinApp.lexClear === 'function') window.FinApp.lexClear().then(renderLex);
    });
    // re-render the learned list each time the Settings sheet opens
    var sh = byId('setSheet');
    if (sh && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) { if (muts[i].target === sh && sh.classList.contains('show')) renderLex(); }
      }).observe(sh, { attributes: true, attributeFilter: ['class'] });
    }
    renderLex();
    // the flag persists across sessions: an opted-in phone re-loads the brain
    // on page load (after the first download the weights are cached, so this
    // is free and works offline)
    if (enabled()) ensureLoaded();
  }
  function refreshModelSel() {
    var pick = modelPref(), m135 = byId('aiModel135'), m360 = byId('aiModel360');
    if (m135) m135.className = 'ai-model' + (pick === '135' ? ' on' : '');
    if (m360) m360.className = 'ai-model' + (pick === '360' ? ' on' : '');
  }
  function hexc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // "What I've learned" — the coach's stored phrasings, editable in Settings.
  // Reads/writes the app's lex store only; never touches money.
  function renderLex() {
    var list = byId('aiLexList'), empty = byId('aiLexEmpty'), clr = byId('aiLexClear');
    if (!list || typeof window.FinApp === 'undefined' || typeof window.FinApp.lexAll !== 'function') return;
    window.FinApp.lexAll().then(function (rows) {
      rows = rows || [];
      if (!rows.length) {
        list.innerHTML = '';
        if (empty) empty.style.display = '';
        if (clr) clr.style.display = 'none';
        return;
      }
      if (empty) empty.style.display = 'none';
      if (clr) clr.style.display = '';
      rows.sort(function (a, b) { return (a.lastAt || '') < (b.lastAt || '') ? 1 : -1; });
      var h = '';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        h += '<div class="lex-row"><span>“' + hexc(r.phrase || r.norm) + '” → ' + hexc(r.label || r.mapsTo) + '</span>' +
          '<button class="lex-x" type="button" data-norm="' + hexc(r.norm) + '" aria-label="Forget this">✕</button></div>';
      }
      list.innerHTML = h;
      var xs = list.querySelectorAll('.lex-x');
      for (var j = 0; j < xs.length; j++) {
        (function (b) {
          b.addEventListener('click', function () {
            if (typeof window.FinApp.lexDel === 'function') window.FinApp.lexDel(b.getAttribute('data-norm')).then(renderLex);
          });
        })(xs[j]);
      }
    })['catch'](function () {});
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
    generate: generate,
    modelName: modelName,
    modelPref: modelPref,
    setModel: setModel,
    remoteEnabled: remoteEnabled,
    setRemoteEnabled: setRemoteEnabled,
    remoteUrl: remoteUrl,
    setRemoteUrl: setRemoteUrl,
    remoteConfigured: remoteConfigured,
    remoteAvailable: remoteAvailable,
    refreshLed: refreshLed,
    byoProvider: byoProvider,
    setByoProvider: setByoProvider,
    byoKey: byoKey,
    setByoKey: setByoKey,
    byoBase: byoBase,
    setByoBase: setByoBase,
    byoModel: byoModel,
    setByoModel: setByoModel,
    byoConfigured: byoConfigured,
    lastSource: function () { return lastSource; },
    testRemote: testRemote
  };

  loadNameVecs();
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindSettings);
    else bindSettings();
  }
})();

