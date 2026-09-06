# Finance PWA (iPhone)

An offline-first, installable web app to add and view your expenses on the go.
It stores entries locally (works with **no signal**) and syncs them to your
**Google Sheet** when you're back online. Your data stays in your own Sheet —
the GitHub repo only ever holds this app code, **no balances or transactions**.

## What it does
- **Add expense** offline (date, paid-with = card or cash, category, amount, note).
- **View** a live summary (liquid cash, free/unallocated, cards owed, 14th prepay,
  committed this month) + your entries with **Pending / Synced** badges.
- **Syncs automatically** on reconnect (and on demand) into your Sheet's Ledger.
- Installs to the iPhone **Home Screen** and runs full-screen.

## 1) Host this folder (GitHub Pages)
1. Go to **github.com → New repository**, name it e.g. `finance-app`, set it **Public**, Create.
2. In the empty repo: **Add file → Upload files** → drag in the **contents of this `site/` folder**
   (so `index.html` is at the top) → **Commit changes**.
3. **Settings → Pages → Build and deployment → Source: "Deploy from a branch"** →
   branch `main`, folder `/ (root)` → **Save**.
4. After ~1 minute your app is live at `https://<your-username>.github.io/finance-app/`.

> A **public** repo is fine (and needed for free GitHub Pages on a free account).
> It contains **no personal data** — your numbers live in your private Sheet.

## 2) Deploy the Apps Script Web App
1. Open your Sheet → **Extensions → Apps Script**.
2. Make sure the whole `google/Code.gs` (including `doGet` / `doPost`) is pasted in.
3. **Deploy → New deployment → gear: Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - **Deploy** → copy the **Web app URL** (it ends in `/exec`).

> To update `Code.gs` later **without changing the URL**: **Deploy → Manage
> deployments → edit (pencil) → Version: "New version" → Deploy**. (Creating a
> brand-new deployment issues a new URL.)

## 3) Install on your iPhone 11
1. On the iPhone, open your Pages URL in **Safari**.
2. **Share** button → **Add to Home Screen** → **Add**.
3. Open the app → paste the **Web App URL** (`…/exec`) in **Connect your sheet** →
   **Connect & sync** (saved on the phone only — you do this once).
4. Add your first expense — it works **offline**. Go back online and it syncs.

## How offline / online works
- A **service worker** caches the app shell, so the app opens with no connection.
- **IndexedDB** (on the phone) holds your entries + the last snapshot.
- When online, pending entries are **POST**ed to the Web App (as `text/plain`, to
  avoid a CORS preflight) and appended to the **Ledger**; the app marks them synced.
- The summary tiles show a **live view**: the server snapshot plus anything you
  have recorded in the app (cash-outs lower Liquid cash, card charges raise Cards
  owed / the prepay, and both lower Free / unallocated). When you next update
  **Balances** in the Sheet, the app detects the changed numbers and re-bases
  itself automatically (or tap **reset to sheet** under the tiles).
- **Insights** (below the tiles) give daily / weekly / monthly advice, opened by a
  short **coach note** ("Hey Jan — keep today around ₱X" / "this week is over
  budget by ₱Y") with one concrete number to act on today or this week. Your name
  comes from the **email** in the Config tab (the part before the @); edit it there
  to change it. The treat amount is editable in the Insights header.
- **Plans** (bottom of the app) are things coming up — eat out, bills, gifts.
  They're stored only on the phone (not written to the Sheet) and drive the
  advice above.

## Notes
- App-added Ledger rows carry a hidden **`id`** (7th column) so a re-send never duplicates.
- **Free / unallocated** = liquid cash − this month's committed outflows
  (the same rule as the CLI and the Dashboard).
- Delete only removes **pending** entries in v1. Synced entries live in your Sheet —
  edit them there if you need to change one.

## After redeploying the Insights build
- Push `site/` to Pages, and for the Web App do **Deploy → Manage deployments →
  edit → Version: "New version" → Deploy** (the `prepay_day` / `cutoff_day`
  snapshot fields and the `as_of` date normalization live in `Code.gs`).
- The service worker cache is now **v2**, so the phone picks up the new app
  shell on its next load. If the app ever looks stale: open the Pages URL once
  in Safari, then relaunch the home-screen icon.
