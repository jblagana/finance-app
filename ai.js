/* Fin.AI online coach — the remote-coach client.
 *
 * The coach is online-only: a hosted LLM the user connects in Settings,
 * either as a Cloudflare Worker URL (the Worker holds the provider key) or
 * bring-your-own key (the phone calls the provider directly). What remains:
 *  - the rule engine stays the only writer; the coach produces chat text
 *  - rules-first (v68): the rule engine answers EVERY message it owns first
 *    — the v55 "coach answers everything first" pass is removed
 *  - "Let the coach answer questions the rules don't own" (Settings, default
 *    ON): open questions that slip past the rules go to the online coach, or
 *    to a "needs the online coach" card when off / offline / not configured
 *  - all remote settings persist in this device's localStorage; a BYO key is
 *    sent only to its own provider
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.FinApp) return;

  function byId(id) { return document.getElementById(id); }

  // --- the online coach: a Cloudflare Worker URL, or bring-your-own key ----
  var REMOTE_KEY = 'fin.ai.remote.v1';
  var REMOTE_URL_KEY = 'fin.ai.remote.url.v1';
  var FORCE_KEY = 'fin.ai.forceonline.v1'; // v68: "let the coach answer questions the rules don't own" — ON unless explicitly '0'
  var lastSource = 'remote';        // always 'remote' — the coach is online-only
  var remoteFailAt = 0;             // circuit breaker: skip remote right after a failure
  var REMOTE_COOL_MS = 30000;
  var REMOTE_TIMEOUT_MS = 20000;
  // v47: bring-your-own key — the coach calls the provider straight from this
  // phone. The key + settings live only in this device's localStorage and are
  // sent only to that provider (never to a Worker). Default: Groq, which allows
  // browser calls; the Worker URL stays as an option for providers that block it.
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
    refreshRemoteNote();
  }
  function remoteUrl() { var u = null; try { u = localStorage.getItem(REMOTE_URL_KEY); } catch (e) {} return String(u || '').trim(); }
  function setRemoteUrl(u) {
    u = String(u || '').trim();
    try { if (u) localStorage.setItem(REMOTE_URL_KEY, u); else localStorage.removeItem(REMOTE_URL_KEY); } catch (e) {}
    refreshRemoteNote();
  }
  function workerConfigured() { var u = remoteUrl(); return !!u && /^https:\/\//i.test(u); }

  // v68 (was v55 "Coach answers everything"): "let the coach answer questions
  // the rules don't own" — DEFAULT ON. Gates only the open-question path:
  // on → the online coach answers what the rule engine doesn't own (when
  // available); off → the fallback card. The rule engine runs first either
  // way and stays the only writer. Only an explicit '0' turns it off; the
  // value is always written so a cleared key can't flip the default.
  function forceOnline() { try { return localStorage.getItem(FORCE_KEY) !== '0'; } catch (e) { return true; } }
  function setForceOnline(v) {
    try { localStorage.setItem(FORCE_KEY, v ? '1' : '0'); } catch (e) {}
    refreshRemoteNote();
  }

  function byoProvider() { var p = null; try { p = localStorage.getItem(BYO_PROVIDER_KEY); } catch (e) {} return p === 'openai' ? 'openai' : 'groq'; }
  function setByoProvider(p) {
    try { localStorage.setItem(BYO_PROVIDER_KEY, p === 'openai' ? 'openai' : 'groq'); } catch (e) {}
    refreshRemoteNote();
  }
  function byoKey() { var k = null; try { k = localStorage.getItem(BYO_KEY); } catch (e) {} return String(k || '').trim(); }
  function setByoKey(k) {
    k = String(k || '').trim();
    try { if (k) localStorage.setItem(BYO_KEY, k); else localStorage.removeItem(BYO_KEY); } catch (e) {}
    refreshRemoteNote();
  }
  function byoBase() { var b = null; try { b = localStorage.getItem(BYO_BASE_KEY); } catch (e) {} return String(b || '').trim(); }
  function setByoBase(b) {
    b = String(b || '').trim();
    try { if (b) localStorage.setItem(BYO_BASE_KEY, b); else localStorage.removeItem(BYO_BASE_KEY); } catch (e) {}
    refreshRemoteNote();
  }
  function byoModel() { var m = null; try { m = localStorage.getItem(BYO_MODEL_KEY); } catch (e) {} return String(m || '').trim(); }
  function setByoModel(m) {
    m = String(m || '').trim();
    try { if (m) localStorage.setItem(BYO_MODEL_KEY, m); else localStorage.removeItem(BYO_MODEL_KEY); } catch (e) {}
    refreshRemoteNote();
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
        body: JSON.stringify({ messages: messages, max_tokens: Math.min(512, (opts && opts.maxNew) || 256) })
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
        body: JSON.stringify({ model: byoModel() || GROQ_MODEL, messages: messages, max_tokens: Math.min(512, (opts && opts.maxNew) || 256), temperature: 0.2 })
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

  // Is the online coach usable right now? (drives the header LED)
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

  // Generation is a remote call to the online coach, nothing more. If it's
  // down, the rule engine stands in.
  function generate(messages, opts, onToken) {
    lastSource = 'remote';
    return remoteGenerate(messages, opts, onToken);
  }

  // v55: the read-only "Coach's note" for the Home Overview card. The app sends
  // the locally-computed snapshot (chat.js coachSnapshot) and gets back a short
  // plain paragraph. Same availability rules as chat; it never writes anything.
  function note(snapshotText, opts, onToken) {
    if (!remoteAvailable()) return Promise.reject(new Error('coach unavailable'));
    var pr = [
      { role: 'system', content: 'You are Coach Fin, the personal money coach of the Fin.AI app. Below are the user\'s current numbers, computed on their phone. Write ONE short, warm, plain note (2-3 sentences, under 50 words) about their money right now: what looks healthy, what needs attention, and one concrete next step. Use only the numbers given. No questions, no lists, no markdown, at most one emoji and only where it genuinely fits, no numbers that are not in the list. Personality (v72.3): light and funny - one dry, self-aware quip at most; the coaching content (healthy / attention / next step) must stay clear and exact.' },
      { role: 'user', content: String(snapshotText || '').slice(0, 3300) }
    ];
    return remoteGenerate(pr, { maxNew: 128 }, onToken);
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
        ? 'On — the coach answers from your numbers via ' + backend + ' (online only).'
        : 'Off — the on-device rule engine answers. Connect a Worker URL or your own key below for the online coach.';
    }
    refreshLed();
  }

  function bindSettings() {
    var rc = byId('aiRemoteToggle');
    if (rc) rc.addEventListener('change', function () { setRemoteEnabled(rc.checked); });
    var ru = byId('aiRemoteUrl');
    if (ru) { if (!ru.value) ru.value = remoteUrl(); ru.addEventListener('change', function () { setRemoteUrl(ru.value); }); }
    var rt = byId('aiRemoteTest');
    if (rt) rt.addEventListener('click', testRemote);
    var fo = byId('aiForceOnline');
    if (fo) { fo.checked = forceOnline(); fo.addEventListener('change', function () { setForceOnline(fo.checked); }); }
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
    refreshRemoteNote();
  }

  window.FinAI = {
    generate: generate,
    lastSource: function () { return lastSource; },
    remoteEnabled: remoteEnabled,
    setRemoteEnabled: setRemoteEnabled,
    remoteUrl: remoteUrl,
    setRemoteUrl: setRemoteUrl,
    remoteConfigured: remoteConfigured,
    remoteAvailable: remoteAvailable,
    refreshLed: refreshLed,
    forceOnline: forceOnline,
    setForceOnline: setForceOnline,
    byoProvider: byoProvider,
    setByoProvider: setByoProvider,
    byoKey: byoKey,
    setByoKey: setByoKey,
    byoBase: byoBase,
    setByoBase: setByoBase,
    byoModel: byoModel,
    setByoModel: setByoModel,
    byoConfigured: byoConfigured,
    testRemote: testRemote,
    note: note
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindSettings);
    else bindSettings();
  }
})();