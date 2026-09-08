/* FinSmart v42 — offline brain, dedicated worker.
 *
 * Every model computation happens here so the UI thread never does math:
 *   - all-MiniLM-L6-v2 (q8, ~23 MB)  -> sentence embeddings, which chat.js
 *     uses to match stored names when the word-overlap rules find nothing
 *   - SmolLM2-135M-Instruct (q4, ~182 MB) -> answers open-ended questions in
 *     the coach chat, streamed token by token (the smaller model is the
 *     default: far faster on phones); falls back to
 *     SmolLM2-360M-Instruct (~370 MB) if the 135M won't load
 *
 * Where the bytes come from:
 *   - the runtime (transformers.js + onnxruntime) is pinned to jsDelivr URLs
 *     and cached by the service worker -> offline after first load
 *   - the model weights download from the Hugging Face hub on first load and
 *     are then kept by transformers.js itself in Cache Storage
 *     (useBrowserCache, true in workers) -> offline after first download
 *
 * Device: WebGPU when navigator.gpu exists, WASM otherwise — except on
 * WebKit (iOS/iPadOS/macOS Safari), which always runs the standard
 * (non-jsep) WASM kernel: WebKit 26.2+'s new JIT makes the jsep kernel
 * spin at 400%+ CPU and grow past 14 GB until the OS kills the page
 * ("A problem repeatedly occurred on ..."). See the isWebKit() note.
 *
 * Message protocol (postMessage):
 *   main -> worker:  {type:'load'}   {type:'status'}
 *                    {type:'embed', id, texts:[...]}
 *                    {type:'generate', id, messages:[{role,content}], opts}
 *   worker -> main:  {type:'status', state, device, embedReady, llmReady, llm, err?}
 *                    {type:'progress', stage:'embed'|'llm', pct, loadedMB, totalMB}
 *                    {type:'llm-fallback', model}
 *                    {type:'embed-result', id, vecs}   {type:'embed-error', id, err}
 *                    {type:'token', id, text}
 *                    {type:'gen-done', id, text}       {type:'gen-error', id, err}
 *
 * Safety: hard timeouts on every call, short context / capped output, and no
 * app access at all — this worker only produces comprehension signals and
 * text. The rule engine in chat.js remains the only writer.
 */
'use strict';

// The BUNDLED build: onnxruntime 1.22.0-dev (wasm/jsep kernels + the WebGPU
// EP) is inlined, so no bare package imports are left for the browser to
// resolve. The "externals" build (transformers.web.min.js) fails in a
// browser worker with: Failed to resolve module specifier
// "onnxruntime-common".
var TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
// The jsep wasm kernel binaries the bundle fetches at runtime
// (ort-wasm-simd-threaded.jsep.mjs/.wasm, ~21 MB) come from this one pinned
// folder — the exact onnxruntime version the bundle inlines — so the
// service worker only ever has to cache a single CDN origin. WebKit (see
// isWebKit below) instead fetches the STANDARD kernel from the same folder
// (ort-wasm-simd-threaded.mjs/.wasm, ~11 MB): WebKit 26.2+'s new JIT makes
// the jsep kernel spin at 400%+ CPU and grow to 14 GB+ until iOS kills the
// whole page ("A problem repeatedly occurred on ..."). The plain kernel is
// the confirmed WebKit-safe path (onnxruntime#26827: "Standard WASM backend
// (non-JSEP) works correctly in all configurations"; the transformers.js
// #1242 workaround recipe).
var ORT_WASM_PATHS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/';
var EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
var LLM_MODELS = [
  { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', tag: 'SmolLM2-135M' }, // default: fast on phones
  { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', tag: 'SmolLM2-360M' }  // fallback
];
var LOAD_TIMEOUT = 600000; // 10 min: the one-time ~250 MB download on slow networks
var EMBED_TIMEOUT = 5000;  // a warm embed takes ~10-50 ms; anything more is broken
var GEN_TIMEOUT = 60000;   // 128 tokens must stream in under a minute

var T = null;       // the transformers module, once imported
var fe = null;      // feature-extraction pipeline (embeddings)
var gen = null;     // text-generation pipeline (coach)
var llmId = null;   // which coach model is loaded
var state = 'idle'; // idle | loading | partial | ready | error
var loadErr = null; // last load failure message, kept for the final status
var device = 'wasm';
var loading = null; // in-flight load promise

function post(o) { self.postMessage(o); }

// Is this WebKit? iPhone/iPad Safari, Chrome-on-iOS (still WebKit under the
// hood), iPadOS masquerading as a Mac, and macOS Safari all hit the jsep
// kernel / WebKit-JIT bug above. Chrome on Android and desktop browsers
// (Blink/Gecko) run the jsep kernel fine.
function isWebKit() {
  var ua = '';
  try { ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || ''); } catch (e) {}
  if (/(iPhone|iPad|iPod)/.test(ua)) return true;
  if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome\//.test(ua) && !/Chromium\//.test(ua)) return true;
  try {
    var d = (typeof navigator !== 'undefined' && navigator.userAgentData && navigator.userAgentData.brands) || [];
    for (var i = 0; i < d.length; i++) {
      var b = d[i] && d[i].brand || '';
      if (b === 'AppleWebKit' || b === 'Safari') return true;
    }
  } catch (e) {}
  return false;
}

function pickDevice() {
  if (isWebKit()) { device = 'wasm'; return; } // WebKit: standard kernel only (see isWebKit)
  try { device = (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm'; }
  catch (e) { device = 'wasm'; }
}

function withTimeout(p, ms, what) {
  return new Promise(function (resolve, reject) {
    var to = setTimeout(function () {
      reject(new Error(what + ' timed out after ' + Math.round(ms / 1000) + 's'));
    }, ms);
    p.then(
      function (v) { clearTimeout(to); resolve(v); },
      function (e) { clearTimeout(to); reject(e); }
    );
  });
}

// Dynamic import that also *parses* under the JScript smoke harness (where
// "import" is a reserved word): the Function constructor keeps the syntax
// out of the outer parser. In the browser it returns the usual import()
// promise; in JScript construction throws and we get a clean null instead.
var __import = null;
try { __import = new Function('u', 'return import(u);'); } catch (e) {}

function ensureModule() {
  if (T) return Promise.resolve(T);
  var p = __import
    ? __import(TF_URL)
    : Promise.reject(new Error('no module loader in this runtime'));
  return p.then(function (mod) {
    mod.env.allowLocalModels = false;  // always the hub (or its cache), never /models/
    mod.env.allowRemoteModels = true;
    mod.env.useBrowserCache = true;    // weights -> Cache Storage -> offline later
    if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) {
      var w = mod.env.backends.onnx.wasm;
      if (isWebKit()) {
        // Object form: ORT imports exactly this mjs and loads exactly this
        // wasm — the bundled jsep file names are only its defaults when
        // wasmPaths is unset. numThreads=1: GitHub Pages ships no COOP/COEP,
        // so the threaded (SharedArrayBuffer) path can never activate anyway.
        w.wasmPaths = {
          mjs: ORT_WASM_PATHS + 'ort-wasm-simd-threaded.mjs',
          wasm: ORT_WASM_PATHS + 'ort-wasm-simd-threaded.wasm'
        };
        w.numThreads = 1;
      } else {
        w.wasmPaths = ORT_WASM_PATHS;
      }
    }
    T = mod;
    return T;
  });
}

function mb(n) { return Math.round(((n || 0) / 1048576) * 10) / 10; }

function progress(stage) {
  return function (p) {
    if (p && p.status === 'progress') {
      post({
        type: 'progress', stage: stage,
        pct: Math.round(p.progress || 0),
        loadedMB: mb(p.loaded), totalMB: mb(p.total)
      });
    }
  };
}

function load() {
  if (loading) return loading;
  if (state === 'ready' || state === 'partial') return Promise.resolve(state);
  pickDevice();
  state = 'loading';
  post({ type: 'status', state: 'loading', device: device, embedReady: false, llmReady: false, llm: null });
  loading = ensureModule()
    .then(function () {
      // 1) embeddings — always: they back the semantic name scoring
      return withTimeout(
        T.pipeline('feature-extraction', EMBED_MODEL, {
          device: device, dtype: 'q8', progress_callback: progress('embed')
        }),
        LOAD_TIMEOUT, 'embedding model load'
      ).then(function (pipe) { fe = pipe; });
    })
    ['catch'](function (e) {
      fe = null;
      state = 'error';
      loadErr = String((e && e.message) || e);
      post({ type: 'status', state: 'error', device: device, embedReady: false, llmReady: false, llm: null, err: loadErr });
      return null;
    })
    .then(function () {
      if (!fe) return null;
      // 2) the coach LLM — try the 135M first (the fast default), then the 360M
      var i = 0;
      function tryNext() {
        if (gen || i >= LLM_MODELS.length) return Promise.resolve();
        var m = LLM_MODELS[i++];
        return withTimeout(
          T.pipeline('text-generation', m.id, {
            device: device, dtype: 'q4', progress_callback: progress('llm')
          }),
          LOAD_TIMEOUT, 'coach model load'
        ).then(function (pipe) {
          gen = pipe;
          llmId = m.id;
        })['catch'](function (e2) {
          gen = null;
          llmId = null;
          post({ type: 'llm-fallback', model: m.tag, err: String((e2 && e2.message) || e2) });
          return tryNext();
        });
      }
      return tryNext();
    })
    .then(function () {
      state = fe ? (gen ? 'ready' : 'partial') : 'error';
      var fin = { type: 'status', state: state, device: device, embedReady: !!fe, llmReady: !!gen, llm: llmId };
      if (state === 'error' && loadErr) fin.err = loadErr;
      post(fin);
      return state;
    });
  loading['catch'](function () { /* keep load() re-callable after a failure */ });
  return loading;
}

function embed(texts) {
  if (!fe) return Promise.reject(new Error('embedding model not ready'));
  return withTimeout(
    fe(texts, { pooling: 'mean', normalize: true }),
    EMBED_TIMEOUT, 'embedding inference'
  ).then(function (out) {
    var arr = Array.isArray(out) ? out : [out];
    var vecs = [];
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] && arr[i].data;
      if (!d) continue;
      var v = new Array(d.length);
      for (var k = 0; k < d.length; k++) v[k] = d[k];
      vecs.push(v);
    }
    return vecs;
  });
}


function generate(id, messages, opts) {
  if (!gen) { post({ type: 'gen-error', id: id, err: 'coach model not ready' }); return; }
  var maxNew = Math.min(128, Math.max(16, Number(opts && opts.maxNew) || 128));
  var stopped = false;
  var to = setTimeout(function () { stopped = true; }, GEN_TIMEOUT);
  gen(messages, {
    max_new_tokens: maxNew,
    do_sample: true,
    temperature: 0.6,
    top_p: 0.9,
    min_new_tokens: 4,
    repetition_penalty: 1.05,
    callback_function: function (x) {
      if (stopped || !x || !x.text_outputs) return;
      post({ type: 'token', id: id, text: x.text_outputs[0] || '' });
    }
  }).then(function (out) {
    clearTimeout(to);
    if (stopped) { post({ type: 'gen-error', id: id, err: 'timed out' }); return; }
    var txt = '';
    if (typeof out === 'string') txt = out;
    else if (out && typeof out.generated_text === 'string') txt = out.generated_text;
    else if (out && out[0] && typeof out[0].generated_text === 'string') txt = out[0].generated_text;
    post({ type: 'gen-done', id: id, text: txt });
  })['catch'](function (e) {
    clearTimeout(to);
    if (!stopped) post({ type: 'gen-error', id: id, err: String((e && e.message) || e) });
  });
}

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'load') {
    load()['catch'](function (e2) {
      state = 'error';
      loadErr = String((e2 && e2.message) || e2);
      post({ type: 'status', state: 'error', device: device, embedReady: !!fe, llmReady: !!gen, llm: llmId, err: loadErr });
    });
  } else if (m.type === 'status') {
    post({ type: 'status', state: state, device: device, embedReady: !!fe, llmReady: !!gen, llm: llmId });
  } else if (m.type === 'embed') {
    embed(m.texts || []).then(
      function (vecs) { post({ type: 'embed-result', id: m.id, vecs: vecs }); },
      function (e2) { post({ type: 'embed-error', id: m.id, err: String((e2 && e2.message) || e2) }); }
    );
  } else if (m.type === 'generate') {
    generate(m.id, m.messages || [], m.opts || {});
  }
};

