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
- **Backup**: export/import a JSON file with your numbers + entries + plans
  + owed notes.

## Owed tab — who owes whom

The **Owed** tab is a private book for money with people — **completely
separate from your numbers**: it never changes free cash, the tiles, the
projection or the coach.

- Add a person (top form), then tap **+ entry** on their card.
- Each entry: date, amount, what happened — *I paid for them*, *I paid them
  back*, *They paid for me* or *They paid me back* — and an optional note.
- The pill under their name does the math: green **owes you** ₱X, amber
  **you owe** ₱X, or **settled up** at zero. The card at the top totals it
  all (owed to you / you owe / net).
- Removing a person or an entry keeps an **Undo** button in the snackbar for
  a few seconds.

**Quick-sum amounts** — the amount box accepts operators, so you can write
the math the way you think it: `300-125+10` shows `= PHP 185.00` as you type
and saves `185`. Works with `+ - * /` (or `× ÷`), parentheses and plain
numbers; the original sum stays shown on the entry so you can check it later.

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

## What each input means (Settings ⚙ → Your numbers)

Everything on this sheet **saves to the phone automatically** — there is no
Save button. The form commits about half a second after you stop typing and the
status line under the title shows `local · as of <date> · saved <time>` once it
is stored (it says `no numbers yet` until the first save). All amounts are
**plain numbers in your own currency**: no symbols, no thousand separators
(`15000` or `15000.50` — never `₱15,000`).

| Field | What to put | How the app uses it |
| --- | --- | --- |
| `name` | Your first name | Personalizes the coach notes and insights. |
| `as of` | The date the balances you enter are correct (usually today) | Anchors the **6-month projection** (it starts at this month) and the countdown to the prepay day. Bump it whenever you refresh your balances. |
| `salary / month` | Your normal take-home pay in a normal month | Income for every projected month **unless** that month has a salary override. |
| `liquidity floor` | Cash you don't want to drop below (e.g. `5000`) | The Liquid-cash tile turns bad under it, and the bridge card shows how much a month's outflows would have to be borrowed to keep you above it. |
| `emergency cap` | Extra cost of a bad month (e.g. `5000`) | Only used for the **worst-case** column of the 6-month projection (the base case ignores it). |
| `prepay day` / `cutoff` | Day of the month you pay the cards / when the charge window closes (e.g. `14` / `15`) | Drives the in-app prepay card ("due in N days", per-day savings, one-tap **Log prepay**). |
| `card target util` | A **fraction, not a percent** — `0.099` means 9.9 % | Per card: `prepay = amount owed − limit × target`. `0.099` keeps just under 10 % of each limit as headroom. Empty → defaults to `0.099`. |

**Salary overrides** — one row per month where you don't get the normal
salary: month (`YYYY-MM`, from the month picker) + the amount you actually get
that month. `0` = no salary that month; a double payout = the full doubled
amount. Any month without a row uses `salary / month`.

**Accounts (cash, cards, debts, loans)** — name · kind · value · limit (the
limit box only exists for cards):

| Kind | `value` is | Effect |
| --- | --- | --- |
| `cash` | what you have in that account **right now** | Added to **Liquid cash** (one row per bank / e-wallet / cash stash). |
| `card` | the **amount you owe** — not the limit! | Added to **Cards owed** and to the **prepay** = `value − limit × target util` (per card, never below 0). The **limit** is the card's credit limit; without it the card's prepay is `0`. |
| `debt` | the **remaining balance** still owed | Shown in the Obligations liabilities list. The *payments* that reduce your monthly free cash are set in **Debts** below — this row is just the balance. |
| `loan` | money bridged from someone (partner, family) | Listed as a loan, **not** part of liquid cash. Set it to `0` once repaid. |

**Monthly budgets** — one row per recurring monthly expense (Rent, Wi-Fi,
food…). These are the assumed amounts for **every** month unless a budget
override says otherwise for one month.

**Budget overrides (one month)** — change one budget line for one month. The
value you type **replaces** the normal amount for that month (it is not added
to it): use `0` to drop the line for that month (e.g. rent paid later, or all
discretionary lines set to `0` in a no-salary "mandatory only" month). Pick the
month and the budget from the dropdown, then enter the amount. Remove the row
once the month has passed.

**One-offs** — a one-time amount in a specific month (back rent, a December
power bill, a gift): month + short name + positive amount. It counts as an
outflow in that month only.

**Debts** — the payment schedule for each debt. Two ways to fill it:
- `monthly` + `active months` — a fixed payment repeated in the listed months,
  e.g. `2020` monthly in `2026-09, 2026-10, … 2027-03` (comma-separated
  `YYYY-MM`).
- **+ payment by month** — specific amounts in specific months; a per-month
  payment **wins over** `monthly` for its month (e.g. `10000` in Oct/Nov/Dec
  and `14000` in Jan instead of a flat monthly).

A debt with neither a monthly nor any per-month payments costs nothing in the
projection — every debt you are actually paying needs a schedule here.

**Sinking funds** — save-up targets with a deadline (e.g. Christmas):
- `goal` — total needed by the deadline; `funded` — how much you've already
  set aside (keep that money **out** of your cash accounts — it is tracked
  here separately); `by` — the deadline date.
- **+ payment by month** — what you plan to add each month. These count as
  outflows in the projection, and if the plan is too slow to reach the goal in
  time the app raises a "Sinking behind" alert with the amount you'd actually
  need per month.

**Sanity check after saving** — the Home tiles should satisfy:
- **Liquid cash** = sum of all `cash` values.
- **Prepay** = Σ over cards of `value − limit × target util` (each card ≥ 0).
- **Free / unallocated** (as-of month) = Liquid cash − that month's committed
  outflows (budgets after overrides + debt payments + sinking payments +
  one-offs + the first month's card prepay).

If a tile looks wrong it is almost always one of: a card **limit** missing
(that card's prepay shows `0`), a debt with **no payment schedule**, or a month
typed outside the `YYYY-MM` format (such rows are silently ignored — use the
month picker).

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
- Backups: **Export JSON** includes your numbers + entries + plans + owed
  notes; **Import JSON** restores them (replaces what's on the phone).

## After redeploying
- Push `site/` to Pages; the service worker cache is bumped per release (v22),
  so the phone picks up the new app shell on its next load — the "New version
  ready" toast offers a one-tap reload. If the app ever looks stale: open the
  Pages URL once in Safari, then relaunch the home-screen icon.
