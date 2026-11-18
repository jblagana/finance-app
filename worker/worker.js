/* FinSmart remote coach — a thin Cloudflare Worker in front of a free,
 * OpenAI-compatible LLM (default: Groq). It is the ONLY place a provider key
 * exists. The app POSTs to this Worker, never to the provider.
 *
 * What it does:
 *   * injects the provider API key (a Worker SECRET — never in this repo/app)
 *   * allows only the app's origin (CORS echo + Origin allowlist)
 *   * hard-caps the token budget and prompt size so a free key can't be drained
 *   * returns a single { text } body (non-streaming, v1)
 *
 * The app treats this as best-effort: when it is down, or the user is offline,
 * the app falls back to the on-device coach (or rules-only). The SW never
 * intercepts these POSTs (sw.js lets non-GETs hit the network).
 *
 * Non-secret config (ALLOWED_ORIGIN, LLM_MODEL) lives in wrangler.jsonc;
 * the key is set with:   wrangler secret put LLM_API_KEY
 */

var MAX_TOKENS = 512;     // hard cap regardless of what the client requests (v55: raised for the confirm-first coach protocol)
var MIN_TOKENS = 16;      // floor: a 1-token reply can be empty/whitespace (the in-app Test pings with max_tokens:1)
var MAX_INPUT = 8000;     // characters of prompt JSON we will forward (v56: the shared snapshot now carries per-row balances + custom details)
var DEFAULT_ORIGIN = 'https://jblagana.github.io/finance-app';

function providerBase(env) {
  return env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1';
}
function providerKey(env) {
  return env.LLM_API_KEY || env.GROQ_API_KEY || env.OPENAI_API_KEY || '';
}
function providerModel(env) {
  return env.LLM_MODEL || 'qwen/qwen3.8-27b';
}
// Reduce a URL/origin to its serialized origin (scheme + host [+ port]). Browsers
// send the Origin header WITHOUT any path (Origin: https://jblagana.github.io), so
// matching a full "/finance-app" URL would never work -- compare on origin only.
function originOf(value) {
  try { return new URL(value).origin; } catch (e) { return String(value || '').trim(); }
}
function allowedOrigins(env) {
  var raw = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  return String(raw).split(',').map(originOf).filter(Boolean);
}
function originAllowed(origin, env) {
  return Boolean(origin) && allowedOrigins(env).indexOf(originOf(origin)) >= 0;
}
// v74.07: compare the token without stopping at the first differing character
function sameSecret(a, b) {
  a = String(a); b = String(b);
  if (!a || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// v74.07: true when the call fits the limit (or the binding is absent)
async function underLimit(binding, key) {
  if (!binding || typeof binding.limit !== 'function') return true;
  try { var r = await binding.limit({ key: key }); return !r || r.success !== false; }
  catch (e) { return true; } // a limiter hiccup must not take the coach down
}
function corsHeaders(origin, env) {
  var h = new Headers();
  // Echo the request's own origin back, but only when it is on the allow-list. A
  // matching Access-Control-Allow-Origin is what lets the browser read the reply;
  // an unmatched (or missing) origin keeps the cross-origin read blocked.
  if (originAllowed(origin, env)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
    h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'content-type');
  }
  return h;
}
function jsonHeaders(origin, env) {
  var h = corsHeaders(origin, env);
  h.set('content-type', 'application/json');
  return h;
}
function ok(body, origin, env) {
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders(origin, env) });
}
function fail(status, message, origin, env) {
  return new Response(JSON.stringify({ error: String(message) }), { status: status, headers: jsonHeaders(origin, env) });
}


// ---------- v75.02: Owed connections relay ----------
// Two phones share one Owed record. The relay only stores sealed mailbox
// messages: the app encrypts every message (AES-256-GCM) with a pair key that
// never leaves the two phones (it rides in the invite link's #fragment), so
// the Worker sees ciphertext, a random pair id and a token hash, nothing else.
// KV layout (binding CONN):
//   p:<pair>                 sha256(token) — set by the inviter's first call
//   m:<pair>:<a|b>:<ts>-<r>  one sealed message for side a / b (TTL 30 days;
//                            the invite 24 hours)
// The coach's APP_TOKEN does not apply here (the friend's phone never has it);
// the pair token is the gate, with its own rate limit (RL_CONN).
var CONN_MAX_MSG = 6000;      // characters of sealed message
var CONN_PULL_MAX = 50;       // messages per pull
var CONN_TTL = 30 * 86400;    // a message waits up to 30 days
var CONN_INVITE_TTL = 86400;  // the invite link works for 24 hours
function hexOk(v, n) { return typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v); }
async function sha256hex(s) {
  var d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.prototype.map.call(new Uint8Array(d), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}
async function handleConn(request, env, origin) {
  if (!env.CONN) return fail(503, 'connections are not set up on this Worker (KV binding CONN missing)', origin, env);
  var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await underLimit(env.RL_CONN, 'c:' + ip))) return fail(429, 'too many requests — try again in a minute', origin, env);
  var b;
  try { b = await request.json(); } catch (e) { return fail(400, 'invalid JSON', origin, env); }
  b = b || {};
  var op = String(b.op || ''), pair = b.pair, tok = b.tok;
  if (!hexOk(pair, 32) || !hexOk(tok, 64)) return fail(400, 'bad pair or token', origin, env);
  var th = await sha256hex(tok);
  var rec = await env.CONN.get('p:' + pair);
  if (op === 'reg') {
    if (!rec) { await env.CONN.put('p:' + pair, th); return ok({ ok: true, created: true }, origin, env); }
    return sameSecret(rec, th) ? ok({ ok: true }, origin, env) : fail(403, 'pair taken', origin, env);
  }
  if (!rec) return fail(404, 'no such connection (it was removed or never set up)', origin, env);
  if (!sameSecret(rec, th)) return fail(403, 'wrong pair token', origin, env);
  var side = function (v) { return v === 'a' || v === 'b' ? v : ''; };
  if (op === 'send') {
    var to = side(b.to), msg = b.msg;
    if (!to || typeof msg !== 'string' || !msg || msg.length > CONN_MAX_MSG) return fail(400, 'bad message', origin, env);
    var ts = Date.now().toString(36);
    while (ts.length < 10) ts = '0' + ts;
    var id = 'm:' + pair + ':' + to + ':' + ts + '-' + Math.random().toString(36).slice(2, 8);
    await env.CONN.put(id, msg, { expirationTtl: b.invite ? CONN_INVITE_TTL : CONN_TTL });
    return ok({ ok: true, id: id }, origin, env);
  }
  if (op === 'pull') {
    var me = side(b.me);
    if (!me) return fail(400, 'bad side', origin, env);
    var ls = await env.CONN.list({ prefix: 'm:' + pair + ':' + me + ':', limit: CONN_PULL_MAX });
    var out = [];
    for (var i = 0; i < ls.keys.length; i++) {
      var v = await env.CONN.get(ls.keys[i].name);
      if (v) out.push({ id: ls.keys[i].name, msg: v });
    }
    return ok({ ok: true, msgs: out, more: !ls.list_complete }, origin, env);
  }
  if (op === 'ack') {
    var me2 = side(b.me), ids = Array.isArray(b.ids) ? b.ids.slice(0, CONN_PULL_MAX) : [];
    if (!me2) return fail(400, 'bad side', origin, env);
    var pre = 'm:' + pair + ':' + me2 + ':';
    for (var j = 0; j < ids.length; j++) if (typeof ids[j] === 'string' && ids[j].indexOf(pre) === 0) await env.CONN.delete(ids[j]);
    return ok({ ok: true }, origin, env);
  }
  if (op === 'drop') {
    var ls2 = await env.CONN.list({ prefix: 'm:' + pair + ':', limit: 1000 });
    for (var k = 0; k < ls2.keys.length; k++) await env.CONN.delete(ls2.keys[k].name);
    await env.CONN.delete('p:' + pair);
    return ok({ ok: true }, origin, env);
  }
  return fail(400, 'unknown op', origin, env);
}

export default {
  async fetch(request, env) {
    var origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    if (request.method !== 'POST') {
      return fail(405, 'method not allowed', origin, env);
    }
    // CORS stops a BROWSER on another site from reading the reply. It does NOT
    // stop a script: curl can send any Origin header it likes. (v74.07: the old
    // comment said this check "blocks direct / scripted calls" — it never did.)
    // The real gates are the app token and the rate limits below.
    if (!originAllowed(origin, env)) {
      return fail(403, 'forbidden origin', origin, env);
    }
    // v75.02: the Owed connections relay (its own gate: the pair token)
    if (new URL(request.url).pathname.replace(/\/+$/, '') === '/conn') {
      return handleConn(request, env, origin);
    }
    // v74.07: the app token. When the APP_TOKEN secret is set
    // (wrangler secret put APP_TOKEN), every call must carry it as ?t=<token>
    // in the Worker URL the app is configured with (Settings -> Worker URL:
    // https://<worker>.workers.dev/?t=<token>). The token lives only in the
    // Worker's secrets and on your phone — never in this repo. No secret set =
    // the old open behaviour (so a deploy never breaks a phone mid-update).
    if (env.APP_TOKEN) {
      var given = new URL(request.url).searchParams.get('t') || '';
      if (!sameSecret(given, String(env.APP_TOKEN))) {
        return fail(401, 'missing or wrong app token (?t=...)', origin, env);
      }
    }
    // v74.07: rate limits (Cloudflare rate-limit bindings, see wrangler.jsonc):
    // per caller IP, and one shared bucket for the whole Worker — a personal
    // app makes a few calls a minute, so either limit only bites on abuse.
    // A missing binding (older deploy / local dev) skips the check.
    var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await underLimit(env.RL_PER_IP, 'ip:' + ip)) || !(await underLimit(env.RL_GLOBAL, 'all'))) {
      return fail(429, 'too many requests — try again in a minute', origin, env);
    }

    var body;
    try { body = await request.json(); }
    catch (e) { return fail(400, 'invalid JSON', origin, env); }

    var messages = (body && Array.isArray(body.messages)) ? body.messages : null;
    if (!messages || !messages.length) {
      return fail(400, 'messages[] is required', origin, env);
    }
    var promptJson = JSON.stringify(messages);
    if (promptJson.length > MAX_INPUT) {
      return fail(413, 'prompt too large', origin, env);
    }
    var maxTokens = Number(body.max_tokens) || 48;
    if (maxTokens < MIN_TOKENS) maxTokens = MIN_TOKENS;
    if (maxTokens > MAX_TOKENS) maxTokens = MAX_TOKENS;

    var key = providerKey(env);
    if (!key) {
      return fail(500, 'provider key not configured (run: wrangler secret put LLM_API_KEY)', origin, env);
    }

    try {
      var upstream = await fetch(providerBase(env) + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + key
        },
        body: JSON.stringify({
          model: providerModel(env),
          messages: messages,
          max_tokens: maxTokens,
          temperature: 0.4,
          stream: false
        })
      });
      var data = {};
      try { data = await upstream.json(); } catch (e) { data = {}; }
      if (!upstream.ok) {
        var emsg = (data && data.error) ? (data.error.message || data.error) : ('upstream ' + upstream.status);
        return fail(502, 'provider error: ' + String(emsg).slice(0, 300), origin, env);
      }
      var text = '';
      if (data.choices && data.choices[0] && data.choices[0].message) {
        text = data.choices[0].message.content || '';
      }
      return ok({ text: text.replace(/^\s+|\s+$/g, '') }, origin, env);
    } catch (e) {
      return fail(502, 'provider unreachable: ' + String((e && e.message) || e).slice(0, 300), origin, env);
    }
  }
};
