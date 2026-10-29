# Fin.AI PWA — agent notes

Project: **Fin.AI** PWA — local-first finance app (see `README.md`).
Repo root; remote `https://github.com/jblagana/finance-app.git`, branch `main`.

## Instruction log

This project's instruction log lives in **INSTRUCTIONS.md** — the user's
instructions **verbatim**, the agent's interpretation (the user may edit
it), and status / subtasks / percent / ETA. **Completion = pushed to the
remote repo.**

- Log every new instruction there **before** working on it.
- **Re-read `INSTRUCTIONS.md` before acting** (and again mid-task on
  multi-step work) — the user may have edited the interpretation; that
  version then wins.
- Format + rules: the workspace `AGENTS.md` → "Instruction log rule".

## Parallel agents (two Cline sessions, one repo)

Two agents may work on this repo concurrently (Jan's local session + an HPC
session). Rules to keep them from clobbering each other:

- **One pusher to `main` at a time.** The agent the user names "on duty"
  owns `main`: it runs the structural gate, bumps the version counter, and
  writes the final log entry. The other agent works on a branch
  (`agent/<short-topic>`), pushes only that branch, and never pushes
  `main` until the user hands over duty.
- **The release counter is a critical section.** These four move together,
  **only at push time, never at edit time**:
  1. `SHELL_RELEASE` in `app.js` — v + `live` timestamp, set by
     `tools/release.ps1` immediately before `git push` (the live stamp is
     always the current time; `check_site.py` enforces freshness ≤30 min —
     v73.47 dropped the HH:MM parameter and the "live re-stamp" second
     commit: **one commit per release**);
  2. the `finances-pwa-vNN` cache in `sw.js`;
  3. the version assertions in the structural gate (`check_site.py`);
  4. the version reference in `README.md`.
  If a parallel release lands while yours is in flight: rebase onto
  `origin/main` and take the next free number (this is how v67 was
  renumbered above v65/v66 in September 2026).
- **`INSTRUCTIONS.md` is append-at-top.** New entries go above all others;
  if a rebase conflicts there, keep **both** sides, newest on top.
- **Structural gate (v68: now in the repo).** `tools/check_site.py` +
  `tools/test_chat_parser.py` are the SHARED gate — both sessions run the
  same checks (paths are file-relative, run from anywhere). Before ANY
  `main` push: `python tools/check_site.py` (must print "all checks passed")
  + `python tools/test_chat_parser.py` ("all parser checks passed"), plus
  `node --check` on the changed JS as a fast pre-check. The on-duty pusher
  bumps the gate's version assertions together with the release (item 3
  above).
- **Docs-only changes** (this file, `INSTRUCTIONS.md`, `README.md`) do not
  bump the version counter and need no shell gate.

## Push & ordering discipline (this project, always)

User mandate (2026-09-12): these apply to every batch in this repo.

1. **One push per subtask.** Each instruction line of a batch = one dot
   release (vN.M): implement → structural check → stamp → commit → push →
   log line. *Done = pushed to the remote.*
2. **Ordering:** fastest-estimated-first, *provided each subtask is
   independent* — independent = doing it never makes another subtask redo
   the previous subtask's work. If two subtasks are not independent, the
   foundational one (the one the other builds on / would rework) goes
   first, regardless of estimated time.
3. **Always via `tools/release.ps1`** — no manual stamp edits, no ad-hoc
   gate runs, ever:
   - `tools\release.ps1 vN.M` — sets `SHELL_RELEASE` (v + `live`, always
     the current time — v73.47 dropped the HH:MM parameter and the
     "live re-stamp" second commit: **one commit per release**), the
     `sw.js` cache, the `README.md` reference, and the `check_site.py`
     version assertions; re-syncs the root mirror (`../check_site.py`);
     runs a preflight (all gate dependencies present — v73.48), then the
     FULL gate suite in one pass (check_site repo + mirror,
     `test_chat_parser.py`, `node --check` on all JS, both smokes —
     `tools\smoke\smoke_app_v68.js`, a permanent 237-assertion gate
     rebuilt in v73.47 (237 as of v73.70; PART 7 = toast lifetime by
     kind; PART 8 = Money-in on a CC = payoff; PART 9 = the cashback
     payoff is NEW money; PART 10 = the skip record + unskip path;
     PART 11 = edit/delete survive a fully-skipped plan; PART 12 =
     link-only paid + expandable this-cycle dues; PART 13 = the
     2-month step chart; PART 14 = the skip/move chooser; PART 15 =
     the plans-list redesign (next-due sort, history strip, editable
     one-offs); PART 16 = the One-offs/Recurring tab bar; PART 17 =
     the state-aware fast-forward; PART 18 = the partial chip is a
     comparison; PART 19 = skip/undo integrity + one-off skips move
     free; PART 20 = a skipped past due keeps its unskip trace;
     PART 21 = x-axis tick throttling; PART 22 = the roasty coach;
     PART 23 = the overdue link is alive; PART 24 = the due rows span
     the cycle + collapse; PART 25 = the 2-cell CC summary card;
     PART 26 = the payment-method ledger filter),
     seeded by `tools\smoke\smoke_seed.json`).
     Invoke it as the
     final step right before commit; the live-stamp freshness check
     (≤30 min) fails if it sat unpushed — re-run it right before
     committing.
   - `tools\release.ps1 -GatesOnly` — re-run the gates without
     re-stamping.
   - Commit + push only on green; on red, fix and re-run — never push
     past a failing gate.
4. **The smoke harness is repo-tracked (v73.48, after the v73.42 incident
   destroyed the loose copy).** `tools\smoke\` holds `smoke_v68.js`,
   `smoke_app_v68.js`, and `smoke_seed.json` — the canonical, committed
   copies. The old loose files in `finances/` (root + `data\`) are DEAD;
   never create loose copies again. `release.ps1` runs a **preflight
   gate** before any gate: any missing gate dependency fails the run at
   the top, naming the file. If a smoke file is ever missing:
   `git checkout origin/main -- tools/smoke/` (or restore from the
   read-only mirror at `C:\Users\Jan\Muji\finance-app\tools\smoke\`).
