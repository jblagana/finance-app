// test_worker.mjs — v74.07: the coach Worker's gates, run against the REAL
// worker/worker.js with a fake env + a stubbed provider (no network, no keys).
// Usage: node tools/test_worker.mjs   (exit 0 = all pass)
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = (await import(pathToFileURL(path.join(here, '..', 'worker', 'worker.js')).href)).default;

let fails = 0;
function ok(cond, msg) { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) fails++; }

let upstreamCalls = 0;
globalThis.fetch = async () => { upstreamCalls++; return new Response(JSON.stringify({ choices: [{ message: { content: ' hi ' } }] }), { status: 200 }); };

function limiter(max) {
  const seen = {};
  return { limit: async ({ key }) => { seen[key] = (seen[key] || 0) + 1; return { success: seen[key] <= max }; } };
}
const APP = 'https://jblagana.github.io';
function req(url, opts = {}) {
  return new Request(url, { method: opts.method || 'POST',
    headers: Object.assign({ 'content-type': 'application/json', Origin: opts.origin === undefined ? APP : opts.origin, 'CF-Connecting-IP': opts.ip || '1.1.1.1' }, opts.headers || {}),
    body: (opts.method || 'POST') === 'POST' ? JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }) : undefined });
}
const W = 'https://finsmart-coach.example.workers.dev/';
const base = { LLM_API_KEY: 'k', ALLOWED_ORIGIN: APP };

// origin still gates browsers
let r = await worker.fetch(req(W, { origin: 'https://evil.example' }), base);
ok(r.status === 403, 'foreign Origin -> 403 (' + r.status + ')');
// no APP_TOKEN secret = the old open behaviour (a deploy never breaks the phone)
r = await worker.fetch(req(W), base);
ok(r.status === 200 && (await r.json()).text === 'hi', 'no APP_TOKEN set -> open as before (200)');
// APP_TOKEN set: the token is required, and a forged Origin alone no longer works
const tok = { ...base, APP_TOKEN: 's3cret-token-value' };
const before = upstreamCalls;
r = await worker.fetch(req(W), tok);
ok(r.status === 401, 'APP_TOKEN set, no ?t= -> 401 (' + r.status + ')');
r = await worker.fetch(req(W + '?t=wrong-token-value!'), tok);
ok(r.status === 401, 'APP_TOKEN set, wrong ?t= (same length) -> 401');
r = await worker.fetch(req(W + '?t=s3cret'), tok);
ok(r.status === 401, 'APP_TOKEN set, a prefix of the token -> 401');
ok(upstreamCalls === before, 'rejected calls never reach the provider (no quota spent)');
r = await worker.fetch(req(W + '?t=s3cret-token-value'), tok);
ok(r.status === 200, 'APP_TOKEN set, right ?t= -> 200');
// CORS preflight is unaffected by the token (the browser sends no query on it... and no body)
r = await worker.fetch(req(W, { method: 'OPTIONS' }), tok);
ok(r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === APP, 'preflight OPTIONS -> 204 with the allow-origin echo');
// rate limits: per IP, then the shared bucket
const rl = { ...base, RL_PER_IP: limiter(2), RL_GLOBAL: limiter(2) }; // a call refused per-IP never touches the shared bucket
const codes = [];
for (let i = 0; i < 3; i++) codes.push((await worker.fetch(req(W, { ip: '9.9.9.9' }), rl)).status);
ok(JSON.stringify(codes) === '[200,200,429]', 'per-IP limit: the 3rd call in the window -> 429 (' + JSON.stringify(codes) + ')');
r = await worker.fetch(req(W, { ip: '8.8.8.8' }), rl);
ok(r.status === 429, 'the shared bucket caps the whole Worker across IPs (' + r.status + ')');
// a limiter that throws must not take the coach down
r = await worker.fetch(req(W), { ...base, RL_PER_IP: { limit: async () => { throw new Error('down'); } } });
ok(r.status === 200, 'a failing limiter fails OPEN (the coach keeps working)');

console.log('');
console.log(fails === 0 ? 'ALL WORKER CHECKS PASS' : fails + ' WORKER FAILURES');
process.exit(fails === 0 ? 0 : 1);
