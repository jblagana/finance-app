# Fin.AI (iPhone)

A **local-first**, installable web app for your personal finances (iPhone Home
Screen, full-screen). All numbers (accounts, salary, debts, budgets, one-offs,
sinking funds) and all math live **on the phone** (IndexedDB) — no backend. The
GitHub repo holds app code only, **never balances or transactions**.

There is **no on-device model**. The coach is a deterministic **rule engine**
that runs fully offline, plus an **optional online LLM** for open questions.
Either way the coach only *drafts*: every money change is a card you confirm,
with one-tap undo — the rule engine stays the only writer.

## Tabs
- **Home** — time-of-day greeting with your name ("Good morning, Jan!" —
  "Hooman" until you set one) + date, free/unallocated cash with a 6-month
  projection sparkline (dated x-axis, liquidity-floor line), a short AI
  **Coach's note** (read-only; cached until your numbers change; hidden when
  the online coach is unavailable or you have no numbers yet — ↻ re-asks),
  the coach's attention card, and insights (category donut, budget pace).
- **Money** — live summary (liquid cash, free, cards owed, prepay), the month's
  Obligations and Sinking funds, the 6-month projection, and upcoming plans.
- **Ledger** — add expense (Amount — plain number or a quick sum like
  300-125+10 with a live = total; Category — the options are the monthly
  budgets from Your numbers, Unsorted by default; no budgets yet → Unsorted
  only — then Paid with beside Date — Cash by default, plus the card/debit
  accounts from Your numbers as bare names — plus a note) and the full
  transaction list with a category filter (All / Unsorted / per category).
  Entries overlay the base numbers live; deletes confirm first, and the last
  add/delete is undoable from the toast.
- **Owed** — people and entries with a live = total; amounts take plain
  numbers or quick sums.

## Coach (floating bot)
Plain language: status, debts, one-offs, sinking funds, cash in any month,
add/list/remove plans, urgent-expense advice.

- **Rules-first (v68, default)** — the local rule engine answers every
  command and story it owns, offline and instantly. Only an open question the
  rules don't own goes to the online coach — and only while "let the coach
  answer questions the rules don't own" is on (Settings → Coach (online),
  default ON); off, or the coach unavailable, gives a "needs the online
  coach" card. When the coach handles a money change it drafts it as a draft
  card — you confirm by tapping the card's Confirm button; a reply to an open
  draft **corrects that draft** instead of stacking a new one.
- **Extensible table (v56)** — the numbers table grows with you: ask the coach
  to record any other fact about an account or budget (a card's credit limit,
  APR, due day, penalty, anything) and it proposes a **detail** change — same
  confirm/undo cards, nothing written until you confirm. Details show as chips
  under the row in Settings → Your numbers (tap to remove), ride along in
  exports/imports, and land in the coach's context — so "util rate for my
  maribank cc" is answered from stored data (balance ÷ recorded limit).

- **Rule engine (always, offline — the only writer)** — deterministic, no
  made-up numbers, and the automatic fallback whenever the coach is off,
  offline or down. **Story mode** parses casual updates ("my salary in
  october is 25k, water went up to 1800") locally into a draft of validated
  changes: drop a line, confirm or discard, undo in one tap. Name matching
  gets a semantic second chance scored locally against your stored names
  ("the gym one" → *Gym membership*); when a detail is missing the coach asks,
  so a bare follow-up ("24k") completes the draft.
- **First-time setup** — with no numbers yet, the coach walks you through them
  step by step (debit → cards → salary → debts → budgets → goals → one-offs)
  using the same confirm/undo cards; also startable from the Home empty-state
  ("Set up with the coach"). A green/grey **availability LED** in the chat
  header shows when the online coach is reachable.

## Online coach (optional)
Connect in **Settings → Coach (online)**, either way:

- **Cloudflare Worker URL** — deploy `worker/` with Wrangler (steps in
  `worker/README.md`); the provider key is a Worker *secret*, so the app only
  knows the Worker URL.
- **Bring-your-own key (direct)** — the phone calls the provider with your own
  key (**Groq** default, or any OpenAI-compatible base URL + model); the key
  stays in this device's localStorage and is sent only to that provider.
- **Let the coach answer questions the rules don't own** (Settings → Coach
  (online), default ON) — the rule engine always answers first (v68); this
  only decides what happens to an open question it doesn't own: the online
  coach (on, while available) or the "needs the online coach" card (off).

Worker first, direct second, with a 30-second circuit breaker so a dead remote
never hangs the chat. Change requests come back as a strict-JSON draft,
validated against the same shapes the rule engine uses and confirmed like a
story draft — the coach never writes directly. Parsing and every money action
stay deterministic and on-device. (v55 raised the reply cap to 512 tokens so
a clarification + confirmed proposal fits; v56 raised the Worker's prompt cap
to 8000 chars so the snapshot can carry per-row balances + custom details —
the Worker enforces its own hard caps, so after changing `worker/` re-deploy
it: `npx wrangler deploy`.)

## Notes
- **Free / unallocated** = liquid cash − this month's committed outflows.
- **Quick sums** — amount inputs (Add sheet, Owed entries, plans) accept
  expressions like 300-125+10 with a live = total (where shown); they keep
  the phone's full keyboard (no numeric-only inputmode) so operators can
  actually be typed.
- The 6-month window derives from your **as of** date (first month = as-of
  month), not hardcoded; prepay day (default 14th) and budgets are editable in
  Settings.
- **Backup** (Settings → Backup): Export JSON (everything) / Export CSV (ledger
  only) / Import JSON to restore.
- Both footers show the shell version + when this build went live. Releases
  bump the SW cache (`finances-pwa-v72.2`) and the `SHELL_RELEASE` stamp in
  `app.js` together — the "New version ready" toast offers a one-tap reload.
  If the app ever looks stale: open the Pages URL once in Safari, then
  relaunch the home-screen icon.
