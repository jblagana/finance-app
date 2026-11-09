# FinSmart remote coach (Cloudflare Worker)

A free, hosted coach that sits **between the app and a free LLM** (default:
Groq). The app never talks to the provider directly and never holds an API key:

```
 app (your phone)  --POST {messages,max_tokens}-->  THIS WORKER  --key-->  Groq
 app <-------------------------------------------  { text }
```

When you are online and the remote is configured, open questions go to the
remote coach. When you are offline, or the remote is down/over-budget, the app
**falls back to the on-device coach** (or rules-only). Transaction parsing and
every money action stay 100% deterministic and on-device — the LLM only writes
chat text.

## What the Worker does

- **Holds the provider key** as a Cloudflare secret (never in this repo/app).
- **CORS + origin allowlist** — only a browser on your app's origin can read the
  reply. This does NOT stop scripts: anyone can send a fake `Origin` header with
  curl. That's what the next two are for (v74.07).
- **App token** — set the `APP_TOKEN` secret and every call must carry it as
  `?t=<token>` in the Worker URL. Without it, the Worker refuses the call before
  it ever reaches the provider (no quota spent). See "Lock it with a token" below.
- **Rate limits** — 10 calls/minute per IP and 30/minute for the whole Worker
  (`ratelimits` in `wrangler.jsonc`), so even a leaked URL can't drain a free key.
- **Caps the cost** — `max_tokens` is hard-capped at 512 and the prompt at 8000
  characters.
- **Non-streaming (v1)** — one `POST`, one `{ text }` back.
- **Graceful** — errors come back as JSON `{ error }`; the app catches them and
  falls back to local.

## 1. Get a free provider key

Groq (default, free, no card):

1. Create an account at https://console.groq.com
2. **API Keys → Create API Key** → copy it.

(Other OpenAI-compatible providers work too — see "Switch providers" below.)

## 2. Deploy the Worker

From **this** folder, with Node 18+:

```bash
# log in (opens a browser)
npx wrangler login

# set the secret (paste the Groq key when prompted). NOT committed.
npx wrangler secret put LLM_API_KEY

# deploy
npx wrangler deploy
```

Wrangler prints a URL like `https://finsmart-coach.<your-subdomain>.workers.dev`.

### Set your app's origin (important)

Edit `"vars"` → `"ALLOWED_ORIGIN"` in `wrangler.jsonc` to the origin of your
deployed app, then redeploy. Browsers send the origin WITHOUT a path, so for the
GitHub Pages project site this is `https://jblagana.github.io` (a path such as
`/finance-app` is ignored either way). You can list several, comma-separated. If
the origin doesn't match, the Worker returns `403 forbidden origin`.

### Lock it with a token (recommended)

```bash
# any long random string — keep it to yourself; it is NOT committed
npx wrangler secret put APP_TOKEN
```

Then in the app, set the Worker URL to `https://finsmart-coach.<your-subdomain>.workers.dev/?t=<that token>`.
Calls without the right token get `401` and never reach the provider. Until the
secret is set, the Worker stays open as before, so deploying never breaks a phone
that hasn't been updated yet.

## 3. Point the app at it

In the app: **Settings → Remote coach (online)**
- toggle **Use remote coach when online**
- paste the Worker URL from step 2 into the field
- press **Test** — it should say "Remote coach is working".

Then open the coach and ask an open question; the reply is labelled
`Coach · remote`. Turn your phone's network off (or wait for the remote to fail)
and the next question is labelled `Coach · local` — that's the fallback working.

## Switch providers

All handled via non-secret `vars` (or a secret) in `wrangler.jsonc`; no code
changes:

| var             | meaning                                   | default                 |
|-----------------|-------------------------------------------|-------------------------|
| `LLM_MODEL`     | model name for `/chat/completions`        | `llama-3.1-8b-instant`  |
| `OPENAI_BASE_URL` | base of any OpenAI-compatible endpoint  | `https://api.groq.com/openai/v1` |

For **Groq**: keep the defaults, set `LLM_API_KEY`.
For **OpenAI**: set `OPENAI_BASE_URL=https://api.openai.com/v1`,
`LLM_MODEL=gpt-4o-mini`, `LLM_API_KEY=<sk-...>` (OpenAI is not free).
For **OpenRouter / others**: set `OPENAI_BASE_URL` to their compatible base and
`LLM_MODEL` to a free model id.

## Free-tier notes

- **Groq**: free tier is rate-limited (roughly a few thousand requests/day and a
  per-minute cap). The Worker's own 60 req/min rate limit + 96-token cap keep you
  far under budget. If you hit a provider 429, the app just falls back to local.
- **Cloudflare Workers free plan**: 100,000 requests/day, plenty. Rate limiting
  may be plan-gated; if `wrangler deploy` rejects the `rate_limit` block, delete
  it — everything else still works.

## Privacy

- The provider key is a **Cloudflare secret** — it is not in this repo, not in
  the app bundle, and never sent to your phone.
- Only the **question prompt** (your coach message + the numbers already on the
  phone) leaves the device, and only to the Worker, only when online and enabled.
- You can turn the remote coach off in Settings at any time; the app is fully
  local again. Transaction parsing and all money writes remain on-device.

## Local test (optional)

```bash
npx wrangler dev
# then in another terminal (adjust the origin header to your ALLOWED_ORIGIN):
curl -i -X POST http://127.0.0.1:8787/ \
  -H "content-type: application/json" \
  -H "Origin: https://jblagana.github.io/finance-app" \
  -d '{"messages":[{"role":"user","content":"how are my finances?"}],"max_tokens":48}'
```
