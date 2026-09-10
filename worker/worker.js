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
var MAX_INPUT = 4000;     // characters of prompt JSON we will forward
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

export default {
  async fetch(request, env) {
    var origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    if (request.method !== 'POST') {
      return fail(405, 'method not allowed', origin, env);
    }
    // CORS stops the browser from reading a cross-origin reply; this Origin check
    // (compared on scheme+host, not path) blocks direct / scripted calls from
    // anywhere but the app.
    if (!originAllowed(origin, env)) {
      return fail(403, 'forbidden origin', origin, env);
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
