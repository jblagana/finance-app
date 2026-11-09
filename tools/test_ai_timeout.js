// test_ai_timeout.js — v74.08: the online-coach client (ai.js) cancels a timed-out call,
// a late reply can't flip the coach LED back on, and the Test message never shows the
// Worker URL's ?t=<app token>. Fake timers + a fake slow server; no network.
// Usage: node tools/test_ai_timeout.js   (exit 0 = all pass)
var fs = require('fs');
var store = { 'fin.ai.remote.v1': '1', 'fin.ai.remote.url.v1': 'https://w.example.workers.dev/?t=SECRET123' };
var led = { className: '', setAttribute: function () {} };
var noteEl = { textContent: '', style: {} };
global.window = global;
global.FinApp = {};
global.localStorage = { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = v; }, removeItem: function (k) { delete store[k]; } };
global.document = { readyState: 'complete', getElementById: function (id) { return id === 'coachLed' ? led : (id === 'aiRemoteNote' ? noteEl : null); }, addEventListener: function () {} };
global.addEventListener = function () {};
var realST = setTimeout;
global.setTimeout = function (fn, ms) { return realST(fn, ms >= 20000 ? 20 : ms); }; // the 20 s coach timeout fires in 20 ms
var aborted = 0, mode = 'late-ok';
global.fetch = function (url, opts) {
  return new Promise(function (resolve, reject) {
    if (opts.signal) opts.signal.addEventListener('abort', function () { aborted++; if (mode === 'late-ok-ignore-abort') return; reject(new Error('aborted')); });
    realST(function () { resolve({ ok: mode !== 'fail', status: 200, json: function () { return Promise.resolve({ text: 'late hi' }); } }); }, 80);
  });
};
eval(fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'ai.js'), 'utf8'));
var fails = 0;
function ok(c, m) { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fails++; }
(async function () {
  var r = await FinAI.generate([{ role: 'user', content: 'x' }]).then(function () { return 'resolved'; }, function (e) { return 'rejected: ' + e.message; });
  ok(r === 'rejected: remote coach timed out', 'a slow call times out (' + r + ')');
  ok(aborted === 1, 'the timed-out fetch is ABORTED (' + aborted + ')');
  mode = 'late-ok-ignore-abort'; // a server/browser that still delivers the reply after the abort
  await FinAI.generate([{ role: 'user', content: 'x' }]).catch(function () {});
  await new Promise(function (res) { realST(res, 150); });
  ok(led.className === 'coach-led', 'a reply arriving AFTER the timeout does not flip the LED back on (' + led.className + ')');
  // testRemote: the token never reaches the UI
  mode = 'neterr';
  global.fetch = function () { return Promise.reject(new Error('net')); };
  FinAI.testRemote();
  await new Promise(function (res) { realST(res, 30); });
  ok(noteEl.textContent.indexOf('SECRET123') < 0 && noteEl.textContent.indexOf('https://w.example.workers.dev/') >= 0, 'the Test message hides the ?t= token (' + noteEl.textContent.slice(0, 60) + ')');
  console.log(fails ? fails + ' AI CLIENT FAILURES' : 'ALL AI CLIENT CHECKS PASS');
  process.exit(fails ? 1 : 0);
})();
