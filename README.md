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
- **Home** — time-of-day greeting + date, free/unallocated cash with a 6-month
  projection sparkline (dated x-axis, liquidity-floor line), the coach's
  attention card, and insights (category donut, budget pace).
- **Money** — live summary (liquid cash, free, cards owed, prepay), the month's
  Obligations and Sinking funds, the 6-month projection, and upcoming plans.
- **Ledger** — add expense (Amount, Category, then Card / cash beside Date, plus
  a note; quick sums like "40+35.5" work) and the full transaction list.
  Entries overlay the base numbers live; deletes confirm first, and the last
  add/delete is undoable from the toast.
- **Owed** — people and entries with a live = total.

## Coach (floating bot)
Plain language: status, debts, one-offs, sinking funds, cash in any month,
add/list/remove plans, urgent-expense advice.

- **Rule engine (always, offline)** — deterministic, no made-up numbers.
  **Story mode** parses casual updates ("my salary in october is 25k, water
  went up to 1800") locally into a draft of validated changes: drop a line,
  confirm or discard, undo in one tap. Name matching gets a semantic second
  chance scored locally against your stored names ("the gym one" → *Gym
  membership*); when a detail is missing the coach asks, so a bare follow-up
  ("24k") completes the draft.
- **Online (optional)** — see below. When it's off, you're offline, or the
  remote is down, the rule engine answers automatically.
- **First-time setup** — with no numbers yet, the coach walks you through them
  step by step (cash → cards → salary → debts → budgets → goals → one-offs)
  using the same confirm/undo cards; also startable from the Home empty-state
  ("Set up with the coach"). A green/amber **availability LED** in the chat
  header shows when the online coach is reachable.

## Online coach (optional)
Connect in **Settings → Coach (online)**, either way:

- **Cloudflare Worker URL** — deploy `worker/` with Wrangler (steps in
  `worker/README.md`); the provider key is a Worker *secret*, so the app only
  knows the Worker URL.
- **Bring-your-own key (direct)** — the phone calls the provider with your own
  key (**Groq** default, or any OpenAI-compatible base URL + model); the key
  stays in this device's localStorage and is sent only to that provider.

Worker first, direct second, with a 30-second circuit breaker so a dead remote
never hangs the chat. Change requests ("add 5,000 to GCash") come back as a
strict-JSON draft, validated against the same shapes the rule engine uses and
confirmed like a story draft. Parsing and every money action stay deterministic
and on-device — the LLM only drafts.

## Notes
- **Free / unallocated** = liquid cash − this month's committed outflows.
- The 6-month window derives from your **as of** date (first month = as-of
  month), not hardcoded; prepay day (default 14th) and budgets are editable in
  Settings.
- The **worst case** figure is the lowest the month-end could dip if an
  uncertain one-off lands.
- **Backup** (Settings → Backup): Export JSON (everything) / Export CSV (ledger
  only) / Import JSON to restore.
- Both footers show the shell version + when this build went live. Releases
  bump the SW cache (`finances-pwa-v51`) and the `SHELL_RELEASE` stamp in
  `app.js` together — the "New version ready" toast offers a one-tap reload.
  If the app ever looks stale: open the Pages URL once in Safari, then
  relaunch the home-screen icon.
