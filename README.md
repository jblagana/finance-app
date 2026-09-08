# Finance PWA (iPhone)

A **fully local**, installable web app for your personal finances. All numbers
(accounts, salary, debts, budgets, one-offs, sinking funds) and all math live
**on the phone** — no Google Sheet, no Apps Script, no network needed at all.
The GitHub repo only ever holds this app code, **no balances or transactions**.

## What it does
- **Your numbers** (Settings ⚙ → Your numbers): edit accounts, salary (+
  per-month overrides), liquidity floor, emergency cap, prepay/cutoff days,
  monthly budgets (+ one-month overrides), debts (monthly + per-month payments),
  one-offs and sinking goals — everything recomputes instantly as you type.
- **Add expense** (date, paid-with = card or cash, category, amount, note) —
  entries overlay the base numbers live (cash-outs lower liquid cash, card
  charges raise cards owed / the prepay, both lower free cash).
- **View** a live summary (liquid cash, free/unallocated, cards owed, 14th
  prepay), the month's **Obligations** and **Sinking funds** cards, a 6-month
  projection, and a money log that sanity-checks every entry.
- Installs to the iPhone **Home Screen** and runs full-screen.
- **Coach** (Coach tab, inline card pane) — ask in plain language: status,
  debt/one-off/sinking details, cash in any month, add/list/remove plans,
  charge checks, and urgent-expense advice. Rule-based and fully local
  (no AI, no made-up numbers); see `repo/chat.js`.
- **Backup**: export/import a JSON file with your numbers + entries + plans.

## 1) Host this folder (GitHub Pages)
1. Go to **github.com → New repository**, name it e.g. `finance-app`, set it **Public**, Create.
2. In the empty repo: **Add file → Upload files** → drag in the **contents of this `site/` folder**
   (so `index.html` is at the top) → **Commit changes**.
3. **Settings → Pages → Build and deployment → Source: "Deploy from a branch"** →
   branch `main`, folder `/ (root)` → **Save**.
4. After ~1 minute your app is live at `https://<your-username>.github.io/finance-app/`.

> A **public** repo is fine (and needed for free GitHub Pages on a free account).
> It contains **no personal data** — your numbers live only on your phone.

## 2) Enter your numbers once
1. Open the app → **Settings (⚙ top right) → Your numbers**.
2. Add your accounts (cash, cards with limits, debts, loans), salary, budgets,
   debts, one-offs and sinking goals. The whole app (tiles, coach, projection,
   6-month matrix, bridge advisor) recomputes from this data **on the phone**.

> The app can also import a JSON backup (Settings → Backup → Import JSON) —
> e.g. one exported from an older build that synced to a Google Sheet.
> `google/Code.gs` is kept as the reference implementation of the same math
> (and still works standalone in the Sheet), but the PWA no longer calls it.

## 3) Install on your iPhone 11
1. On the iPhone, open your Pages URL in **Safari**.
2. **Share** button → **Add to Home Screen** → **Add**.
3. Open the app → **Settings (⚙) → Your numbers** → enter your numbers once.
4. Add your first expense — everything works with **no signal at all**.

## How the local data works
- A **service worker** caches the app shell, so the app opens with no connection.
- **IndexedDB** (on the phone) holds your base numbers, entries, plans and chat.
- The summary tiles show a **live view**: your base numbers plus anything you
  have recorded in the app (cash-outs lower Liquid cash, card charges raise Cards
  owed / the prepay, and both lower Free / unallocated). When you edit a balance
  in **Your numbers**, the app re-bases automatically (or tap **reset to my
  numbers** under the tiles).
- The 14th-prepay "email alert" from the sheet era is now the **in-app coach
  card**: it shows the prepay amount, the days left, the per-day savings and a
  one-tap **Log prepay** action, and it stays on the Home tab until handled.
- **Insights** (below the tiles) give daily / weekly / monthly advice, opened by a
  short **coach note** ("Hey Jan — keep today around ₱X" / "this week is over
  budget by ₱Y") with one concrete number to act on today or this week. The name
  is set in the **name** box in the Insights header (saved on this phone); if left
  blank it falls back to the **name** field in Settings → Your numbers. The treat
  amount is in the same header.
- **Plans** (bottom of the app) are things coming up — eat out, bills, gifts.
  They're stored only on the phone (not written to the Sheet) and drive the
  advice above.

## Notes
- **Free / unallocated** = liquid cash − this month's committed outflows
  (the same rule as the CLI and the sheet Dashboard — the math is ported 1:1
  from `google/Code.gs` into `repo/app.js`).
- The 6-month projection window is derived from your **as of** date (the first
  month is the as-of month), not hardcoded.
- Backups: **Export JSON** includes your numbers + entries + plans; **Import JSON**
  restores them (replaces what's on the phone).

## After redeploying
- Push `site/` to Pages; the service worker cache is bumped per release (v21),
  so the phone picks up the new app shell on its next load — the "New version
  ready" toast offers a one-tap reload. If the app ever looks stale: open the
  Pages URL once in Safari, then relaunch the home-screen icon.
