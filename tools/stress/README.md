# Fin.AI stress suite

Drives the **real app** in headless Chromium, the way a person would use it. Each scenario gets a
fresh browser profile with the October export (`tools/smoke/smoke_seed.json`) imported through the
app's own file input, and the clock pinned to a chosen date. Nothing touches a phone or live data.

| Group | File | What it covers |
|---|---|---|
| R | `stress_a.js` | reconcile + rebase: one balance typed, Reconcile + Undo, Reset + Undo, deletes before/after a correction, as-of edits, limit/% edits, record-only receipts, backup → restore (twice) |
| D | `stress_a.js` | destructive actions: remove / rename accounts with entries, back-to-back removals + Undo, ledger delete + Undo, plan delete + Undo, category removal |
| S | `stress_a.js` | salary from the chip at 50–200 %, the account it pre-picks, logging it twice |
| A | `stress_a.js` | amounts and typing (quick sums, commas, junk, HTML in notes), double-tapping Add |
| T | `stress_b.js` | dates: payday, month ends, leap day, months away, midnight, another timezone, future-dated entries |
| C | `stress_b.js` | cards: over the limit, overpaid, ₱0 limit + 31st days, Credit → Debit |
| P / O | `stress_b.js` | plan and Owed edge cases |
| I | `stress_b.js` | data safety: broken / foreign / partial / poisoned backups, close right after saving, 10,000 entries |
| U | `stress_c.js` | every screen at 320 / 390 / 430 px in both themes (overflow, tap targets, names), 60 fast open/closes, keyboard-up Add sheet |
| M | `stress_c.js` | monkey test: 3 × 1,000 random taps / typing |
| Y | `stress_c.js` | a simulated year of daily use: liquid and owed must equal a plain sum of the ledger every day; 6 reopenings |

Every check also runs the shared invariants (`inv()` in `stress_core.js`): free = liquid − owed,
the cards add up to cards owed, no entry on an unknown account, no NaN / undefined on screen, no
sideways scrolling, no JavaScript errors.

## Run

```
cd tools/stress
npm i --no-save playwright-core
npx playwright install chromium
node stress_run.js ../.. a,b,c          # everything (~10 min)
node stress_run.js ../.. a              # one group file
ONLY=MY node stress_run.js ../.. c      # just the monkey + the simulated year
```

Results (and screenshots under `shots/`) go to `%TEMP%/fin-stress` (or `STRESS_OUT`).
Not a release gate (it takes minutes) — run it before a release that touches the money math.
