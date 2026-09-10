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
  1. `SHELL_RELEASE` in `app.js` — v + `live` timestamp, set immediately
     before `git push` so `live` is the actual release time;
  2. the `finances-pwa-vNN` cache in `sw.js`;
  3. the version assertions in the structural gate (`check_site.py`);
  4. the version reference in `README.md`.
  If a parallel release lands while yours is in flight: rebase onto
  `origin/main` and take the next free number (this is how v67 was
  renumbered above v65/v66 in September 2026).
- **`INSTRUCTIONS.md` is append-at-top.** New entries go above all others;
  if a rebase conflicts there, keep **both** sides, newest on top.
- **Structural gate.** `check_site.py` (and `test_chat_parser.py`) live in
  the local session's workspace, *outside* the repo — the HPC session
  cannot run them yet. Until they move into `tools/` (next release), the
  HPC-side gates are `node --check` on changed JS plus a targeted
  geometry/visual read-back, and the local side runs the full structural
  gate before any `main` push.
- **Docs-only changes** (this file, `INSTRUCTIONS.md`, `README.md`) do not
  bump the version counter and need no shell gate.
