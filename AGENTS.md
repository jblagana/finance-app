# Fin.AI PWA — agent instruction log

Crash-recovery log for this project (see the workspace `AGENTS.md` rule).
Every instruction is logged here BEFORE work starts; status + notes are
updated as it progresses. Latest entry first.

## Instruction log

### 2026-09-10 ~11:45 — v53 batch (unsorted, quicksum cut, LED grey, greeting name, misc polish)
Status: **done — shipped as v53** (gate passed; committed + pushed to origin/main, this commit)

Instruction (user, near-verbatim):
1. Make it a habit: log every instruction first (rule added to workspace
   AGENTS.md; this file is the per-project log).
2. Rename the donut "Other" to **Unsorted** (user's choice in the decide-list).
3. Yes — add an **Unsorted** option to the ledger category filter.
4. **Cut quick-sum** — phone keyboard is numeric-only, operators can't be typed.
5. **Switch to Ledger after add** (revert the stay-on-sheet behavior).
6. Owed tab: revert — restore the **`e.g. Vhal`** placeholder on the name input.
7. Chat bot: user sees **no toggle to force the online coach** to respond —
   make it visible/working.
8. Chat input placeholder is **still large** — shorten it.
9. Settings "Your numbers": label `name` → **`your name`**, `prepay day` →
   **`cc prepay day`**; remove placeholders there except the `your name` one.
10. Coach LED: no online coach shows **yellow → make it grey** instead.
11. Home greeting (screenshot provided): `Good morning` →
    **`Good morning, Hooman!`** when no name is set, else
    **`Good morning, <name>!`**.

Notes:
- Shell release: bump `sw.js` cache, `SHELL_RELEASE`, `check_site.py`
  assertions + READMEs together → **v53**.
- Quick-sum cut requires gate updates (its checks + any element id it owns).
- `e.g. Vhal` comes back, so the gate's "only `e.g. Jan` example" check needs
  adjusting to allow both.

Outcome notes:
- **Unsorted**: blank-category bucket renamed everywhere — donut fallback
  (`renderDonut`), ledger rows (`mlParts`), chat spend breakdown (chat.js).
  The real "Other" category is untouched; the donut's >5 overflow segment
  still reads "Other".
- **Filter**: new Ledger category filter (`#mlFilter` select — All / Unsorted
  / per-category from the money log); `renderMlFilter()` + `mlFilterCat`;
  options rebuild on every txn change, selection auto-resets when the chosen
  category disappears.
- **Quick-sum cut**: `evalExpr` + `addAmtEq` deleted; add-sheet and owed-entry
  amounts are plain `parseFloat`; the chargeHint and the owed "= total" hint
  keep working on plain numbers; legacy owed entries still show their stored
  expr string. `check_owed.py` updated (evalExpr cases removed).
- **Post-add**: sheet closes AND switches to the Ledger tab; the
  "Added … + Undo" snackbar still shows on top of the ledger.
- **Owed**: `e.g. Vhal` placeholder restored; quick-sum note removed.
- **Force-online toggle**: it was wired in ai.js but the HTML element never
  existed — added `#aiForceOnline` checkbox under "Use remote coach when
  online" in Settings → Coach (online).
- **Chat input** placeholder shortened to "Ask the coach…".
- **Your numbers** editor: label `name` → "your name", `prepay day` →
  "cc prepay day"; every other placeholder in that sheet removed
  (name/value/limit/debt name/goal name/what/YYYY-MM), "e.g. Jan" kept.
- **Coach LED**: not-ready state is grey (`var(--mut)`) instead of amber.
- **Greeting**: "Good morning, <name>!" (all time-of-day variants carry the
  name); falls back to **Hooman** when `base.name` is unset.
- **Shell bump**: `sw.js` → `finances-pwa-v53`, `SHELL_RELEASE` → v: 53
  (Sep 10, 2026 12:12 PM), gate → v53 with a new v53 section (Unsorted,
  filter, quick-sum GONE, post-add tab, greeting, grey LED, labels, force
  toggle, placeholders), both READMEs updated.
- **Validation**: `python check_site.py` → all checks passed (incl. esprima
  parse of all 5 JS files); leftover sweep clean (no quick-sum/evalExpr/amtEq
  in the site files).
- **User follow-up**: on the iPhone accept "New version ready" (or relaunch
  the Home-screen icon) and confirm the footer reads "Fin.AI · shell v53".
