# Fin.AI — instruction log

The instruction log for this project (crash-recovery record).
**Newest entry first.** Format + rules: the workspace `AGENTS.md` →
"Instruction log rule". **Completion = pushed to the remote repo**
(`https://github.com/jblagana/finance-app.git`, branch `main`) — a local
commit is not done.

## 2026-09-10 ~19:05 — Process: catch interpretation edits + per-subtask log updates

Status: **done**
Progress: 100% — completed 2026-09-10 ~19:20 — pushed as `d42eeb0` → origin/main

### Instruction (verbatim)
> how can u prevent that oversight in my instructions edit in the future? also, i want u to update the instructions every subtask done

### Interpretation (agent — user may edit this section)
- Two asks: (1) a mechanism so a user edit to an Interpretation section can't be acted past again (the v56 slip: edited after I'd shipped, seen only when asked), (2) standing rule: update this log **on every subtask done**, not in a batch at the end.
- Mechanism (agent's proposal — edit me): make the existing rules into mechanical checkpoints — re-read the current entry's Instruction + Interpretation (a) when starting work on it, (b) immediately before **every** log update, (c) again right before `git push` (the point of no return). Compare against the text the agent last wrote: any difference = user edit = the new instruction — stop, log it as its own entry quoting the edit verbatim, follow it. Per-subtask updates double as heartbeats: each one forces a re-read, which is exactly where an edit surfaces.
- Where it lives: the workspace `AGENTS.md` → "Instruction log rule" (rules 2 & 3 tightened). They already said "re-read" / "keep current" — the v56 failure was compliance, not missing rules, so the fix is explicit checkpoints + a diff test.
- Limit (agent): an edit made mid-run is only visible at the next checkpoint; the pre-push re-read is the last gate because push is what makes work visible to the user. An interruption (as happened) always beats the schedule.

### Subtasks
- [x] Log the instruction verbatim (first action)
- [x] Amend workspace AGENTS.md: rule 2 (re-read checkpoints incl. pre-push + diff test), rule 3 (per-subtask updates)
- [x] Commit + push, log done with hash — `d42eeb0` (AGENTS.md lives outside the repo; the commit carries the log entry)

## 2026-09-10 ~18:20 — v56 follow-up (user edit): no hardcoded limit rule in the rule engine

Status: **done**
Progress: 100% — completed 2026-09-10 ~18:50 — pushed as `8dd9214` → origin/main

### Instruction (verbatim)
> (user edit appended to the ~17:35 entry's interpretation, bullet 4, after "(no freeform NL parsing)."):
> (user - try not to hard code this in rule engine to test if the ai coach can actually do this on its own.)

### Interpretation (agent — user may edit this section)
- The ~17:35 interpretation was edited **after** v56 shipped (`070b15b`) — this edit is the new instruction (log rule 2). It was not seen before the push; the hardcode ships in `070b15b` and now comes out.
- Remove the offline "<card> limit is N" hardcode from the chat.js rule engine. Offline, that phrase falls through to the generic coach-unavailable fallback, same as any other custom detail.
- Kept: the `field`/limit draft machinery (sanitizer, apply, chips, snapshot, undo, import) and the worker prompt line that teaches the coach how to record limits — that's guidance to the LLM, not a deterministic rule; the coach still has to parse the message itself (which is exactly what's being tested).
- Shell changed → bump to v57 (sw cache + SHELL_RELEASE + check_site version assertions).
- Post-push finding (agent): the v56 README bullet insertion (previous session) actually **replaced** the first line of the "- **Rule engine (always, offline…)" bullet, so `070b15b`'s README shipped missing that header line. This commit restores it (verified against `0ac7f63:README.md`).

### Subtasks
- [x] Log the user edit verbatim (first action)
- [x] Remove the limit block from chat.js
- [x] check_site.py: flip the offline check into a no-hardcode guard
- [x] test_chat_parser.py: drop the offline-rule checks
- [x] README: drop the offline sentence from the v56 bullet
- [x] v57: sw cache + SHELL_RELEASE + README + check_site version
- [x] Gates → commit + push, log done with hash — `8dd9214` (check_site.py "all checks passed" + parser tests "all parser checks passed"); README Rule-engine header line restored in the same commit

## 2026-09-10 ~17:35 — v56 scope revision: coach-extensible data table (custom "details" fields)

Status: **done**
Progress: 100% — completed 2026-09-10 ~18:05 — pushed as `070b15b` → origin/main

Supersedes the ~17:00 entry's scope ("record limit and other details" = just a `limit` column).
Agent note (2026-09-10): implemented as the `base.details` side-map keyed
`kind:name` (same semantics as a per-entity `fields` bag, but no schema
migration — the flat `budgets` map stays untouched).

### Instruction (verbatim)
> on second thought, can we make the ai coach be able to modify the data table so that even if it doesnt have ability to write or record something, it can modify the table to cater it and expand the data tables cpacity?

### Interpretation (agent — user may edit this section)
- Feasible, and it fits the existing architecture: the coach still never writes directly — it **proposes** a table change as a draft line (confirm-before-write stays intact), but the table itself becomes **extensible**: any entity row (card/cash account, debt, loan, budget) can grow new columns.
- Design (agent's scope call — edit me to change it):
  1. **Data:** optional `fields: {key: value}` bag per entity. Keys = short snake_case (≤24 chars), values = number or short string (≤80 chars), max 10 fields per entity, reserved column names (name, value, limit, month, amount, …) rejected so custom fields can't clobber real data.
  2. **New draft shape** for the coach: `{"type":"field","entity":"card|cash|debt|loan|budget","name":"<exact entity name>","key":"credit_limit","value":70000}` (value `null` deletes the field). Entity must already exist; the coach knows names from the snapshot.
  3. **Snapshot upgrade:** accounts get their balances + fields in the coach context (fixes the earlier gap too — "util rate for maribank cc" becomes answerable: 17,279.64 of 70,000 ≈ 25%).
  4. **Rule engine:** offline pattern for "…limit is N" on a card (writes the real `limit` column); other custom details offline → "the online coach can record that" (no freeform NL parsing).(user - try not to hard code this in rule engine to test if the ai coach can actually do this on its own.)
  5. **UI:** custom fields shown as small chips under the entity row in Your numbers; tap a chip to delete. Adding/changing is done through the coach (that's the point).
  6. Undo/export/import ride along via the existing base snapshot + JSON export; import sanitizes fields.
- Not doing: new entity types, one-off/sinking fields, freeform manual field editor, schema migration for old exports (fields are optional — old data reads fine).

### Subtasks
- [x] Log the instruction verbatim (first action)
- [x] Explore: storyNames shape, coachSanitizeChange/parseCoachDraft, applyBaseChanges/undo, base editor render + save, export/import validation
- [x] Data + sanitizer: `field` change shape, reserved keys, caps, entity lookup
- [x] applyBaseChanges + draft label + undo (undo = full base snapshot, rides along)
- [x] coachSnapshot: balances + fields in context; system prompt field guidance
- [x] Rule engine: card "limit is N" offline pattern
- [x] UI: field chips (+ tap-delete) in Your numbers
- [x] Import sanitize + tests (parser mirror + engine patterns)
- [x] check_site.py v56 assertions
- [x] v56: sw cache + SHELL_RELEASE + README (+ worker MAX_INPUT 4000→8000, snapshot cap 1300)
- [x] Gates pass → commit + push, log done with hash — `070b15b` (check_site.py "all checks passed" + parser tests "all parser checks passed")

## 2026-09-10 ~17:00 — v56: record the credit limit (+ other card details) so util rate is computable

Status: **in progress**
Progress: 5% — ETA ~60–90 min (log → explore account store / story engine / draft `limit` support → implement → tests → gates → v56 bump → push)

### Instruction (verbatim)
> make it record limit and other details

### Interpretation (agent — user may edit this section)
- Follow-up to the "util rate" screenshots: the app should **store** the card credit limit as first-class data (not just ask the coach in chat), so utilization rate can be computed from stored numbers. "Other details" = keep minimal: whatever already has a natural home in the account story shape (the draft protocol already carries a `limit` field on `account` changes) — no generic key-value schema, no interest-rate/due-date fields unless the user names them.
- Plan (agent's): store `limit` on card accounts → expose it in `coachSnapshot` (per-card balance + limit, and the computed util %) → chat coach can answer "util rate for maribank cc" directly → note card benefits automatically (same snapshot).
- If the user means more fields (due date, APR, min payment), that's a scope addition — waiting for the edit of this section.

### Subtasks
- [x] Log the instruction verbatim (first action)
- [ ] Explore: account store shape, story/draft application, existing `limit` handling
- [ ] Implement: persist limit on card accounts (draft + rule path), snapshot + util % in coach context
- [ ] Tests + gates (check_site.py, test_chat_parser.py)
- [ ] v56: sw cache + SHELL_RELEASE + README
- [ ] Commit + push, log done with hash

## 2026-09-10 ~16:40 — v55 field check: confirm-draft flow works; coach asks for the card limit on "util rate"

Status: **done** (review-only, no code change — see interpretation)
Progress: 100%

### Instruction (verbatim)
> look at that
> (screenshot 1: coach says "Got it, updating the limit." → draft card "Account - MariBank CC (card) — PHP 17,279.64" → ✓ done → "Story applied: 1 change written to Your numbers" + "Undo this story")
> (screenshot 2: "util rate" → coach: "I don't have your credit card utilization rate in my records. Please tell me the total credit limit for your cards so I can calculate it." → "util rate for maribank cc" → coach: "I don't have the credit limit for your MariBank CC in my records. Please tell me its limit so I can calculate the utilization rate.")

### Interpretation (agent — user may edit this section)
- The user is showing two live v55 runs and asking whether they work as designed.
- Screenshot 1 = the confirm-understanding protocol working end-to-end (paraphrase → draft card → confirm → story applied, with undo). The draft JSON came through complete, so the raised token cap is in effect on the path in use (worker redeployed, or BYO key).
- Screenshot 2 = the coach is behaving correctly: the app stores the card's *balance* (a "card" account) but has no credit-limit field anywhere (verified: no `limit` data in the code). The snapshot sent to the coach includes the balance but not the limit, so asking for the limit is the right move. Once the user replies with the limit, the coach can compute the utilization live in chat (read-only arithmetic; nothing gets stored).
- Optional v56 (only if the user asks): tune the remote prompt so the coach offers the known balance proactively — "I see MariBank CC at PHP 17,279.64 — tell me the limit and I'll compute the utilization." Prompt-only change, but chat.js is shell → version bump required.

### Subtasks
- [x] Log the instruction verbatim (first action)
- [x] Verify no credit-limit field exists in the app
- [x] Read `coachSnapshot` to confirm what context the coach receives
- [x] Answer the user with the assessment
- [ ] (optional) v56 prompt tweak — only if requested

## 2026-09-10 ~15:30 — v55: coach-first, online-driven app + confirm-understanding before drafts + Coach's note on Overview

Status: **done** (pushed: `0ac7f63` → origin/main, 2026-09-10 ~16:05)
Progress: 100% — ETA was ~15 min for the last step (commit + push + log)

### Instruction (verbatim)
> (message 1 of this thread — context summary, Goal + State, quoting the prior session's ask)
> Make the AI coach clarify and confirm the user's money narrative before generating any draft base/rule change.
> User clarified the real issue: the coach should talk to them first and confirm understanding before a draft is created.
>
> (message 2, plan mode)
> i want this app to be mostly online now, ai coach driven so everything is smart
>
> (message 3, plan mode)
> -include that ai summary card on overview, i like that

(The exact original failing-story sentence came in the prior session; the context summary above is the canonical record of it. The plan presented on messages 2–3 was approved by the switch to Act mode.)

### Interpretation (agent — user may edit this section)
- One release (v55), five parts:
  1. **Coach-first routing:** online coach becomes the default brain for every chat
     message when available (configured + enabled + online + not in cooldown);
     the local rule engine stays as the automatic offline fallback. The v49
     "Force online coach" toggle becomes "Coach answers everything", default ON.
  2. **Confirm-understanding protocol:** the LLM system prompt changes — for a
     money story the coach first paraphrases ("So you're telling me: …") and
     asks targeted questions; it may emit the {say, changes} JSON draft only
     after the user confirms/corrects. Local validation + the existing draft
     card (✕ / Confirm / Discard / undo) are unchanged; the rule engine stays
     the only writer.
  3. **Open-draft correction:** a reply to an unconfirmed draft card routes to
     the coach with the open draft + the user's words as context → revised
     proposal (supersedes the old card) or a follow-up question. Kills the
     "stack of wrong drafts" behavior.
  4. **Coach's note card on the home landing tab** (the overview screen with
     the greeting + hero + insights): a read-only AI paragraph (2–3 sentences,
     <50 words) built from a locally-computed month snapshot (F.coachSnapshot,
     shared with the chat prompts). Cached in localStorage keyed by the
     snapshot fingerprint → zero API calls while the numbers are unchanged;
     hidden when coach unavailable / no numbers yet. ↻ refresh button forces.
     (Agent scope call: "overview" = the home landing tab. If the user meant
     the Money tab, the card moves there — same code.)
  5. **Token caps:** ai.js 96 → 512 (both remote paths), sendLlm maxNew 48 →
     256, worker MAX_TOKENS 96 → 512 (user must redeploy the worker; BYO key
     unaffected).
- Deliberately unchanged: rule engine math, all writes, draft confirm/undo,
  storage, views' determinism, backup. ai.js still never calls a write action.

### Subtasks
- [x] Log this instruction verbatim (first action)
- [x] app.js: F.coachSnapshot(ctx) + #coachNote render / cache / refresh
- [x] ai.js: FAI.note(), caps 96→512, settings rework (default ON), offline copy
- [x] chat.js: system prompt + confirm protocol, coach-first gate, open-draft correction, richer aiContextText
- [x] worker/worker.js: MAX_TOKENS 96 → 512 (+ redeploy note to user)
- [x] index.html: #coachNote card + CSS
- [x] sw.js → finances-pwa-v55, app.js SHELL_RELEASE v55, README rewrite
- [x] test_chat_parser.py: new cases (protocol output, routing gate, snapshot/fingerprint)
- [x] check_site.py: v55 assertions
- [x] Gates: check_site.py + parser tests pass
- [x] Commit + push, record hash, log done — `0ac7f63`

## 2026-09-10 ~13:45 — Logging discipline: log verbatim FIRST, live progress %, never clobber user edits

Status: **done** (pushed in this commit; hash = top of `git log`)
Progress: 100% — ETA was ~10 min (verify file state, patch v54 entry, harden the AGENTS.md rule, push)

### Instruction (verbatim)
> -when i tell u something, log it first verbatim in the instruction.md before thinking or doing anything
> -i noticed ur not regularly updating the progres % i instructions.md
> -also, u did not check my edit in ur interpretation and just overwrote it

### Interpretation (agent — user may edit this section)
- My three slips in the v54 task, and the fixes (edit freely):
  1. **Log first.** "the greeting block is directly adjacent to the chart"
     was an instruction; I edited code before logging it. Fix: the
     INSTRUCTIONS.md edit is the **first tool call** on every user
     instruction — before analysis, reads, or code.
  2. **Live progress.** v54 jumped 10% → 90% with no updates between.
     Fix: bump Status/Progress/ETA at every milestone (each subtask, gate
     run, commit, push).
  3. **The interpretation is yours to edit.** I re-read the log only
     mid-task (after already making all the code edits) and I rewrote the
     "positioning" bullet as a block replacement instead of appending.
     Fix: re-read the file immediately before acting and before any edit
     to it; never replace a bullet the user may have touched — append new
     agent notes as separate, clearly agent-owned bullets; if an edit
     fails to match, stop and re-read instead of forcing it.
- Agent verification (done): git shows no pending user edits — the only
  uncommitted change was the new entry above, and the pushed file contains
  your answer ("add the full keyboard there too"), which WAS acted on (plan
  amount `p_amount` got the full keyboard + quick-sum parsing). I found no
  other user edit in the file or git history that I replaced; if you mean a
  specific edit that is now missing, tell me the words/spot and I will
  restore it. Process fix stands regardless: re-read before acting, and in
  the interpretation the agent only appends clearly agent-owned notes —
  never rewrites a block the user may have touched.

### Subtasks
- [x] Log this instruction verbatim as the first action
- [x] Re-read INSTRUCTIONS.md + git state; confirm which edit I clobbered (or that none was)
- [x] Add the unlogged verbatim ("greeting block … add some distance") to the v54 entry
- [x] Harden the workspace AGENTS.md log rule (first action, milestones, no clobber) — workspace AGENTS.md rules 6–8
- [x] Push the log update; record the hash

## 2026-09-10 ~13:05 — Quick-sum revert (operators on keyboard) + Home positioning fix
Status: **done**
Progress: 100% — v54 pushed as `083a734` → origin/main (2026-09-10 ~13:35)

### Instruction (verbatim)
> -revert back the quicksum, i never wanted it gone. my problem was that when i type in the phone, i cant do quicksum because the keyboard that appears is numeric so there are no operators. now make the keyboard add operators.
> -see img, positioning is awkward
>
> (follow-up during the task, ~13:10 — acted on before being logged; logged now)
> the greeting block is directly adjacent to the chart, add some distance between them

### Interpretation (agent — user may edit this section)
- Quick-sum is **reverted, not removed**: my v53 cut was based on a
  misreading — the user wants it back. The real problem was the **keyboard**:
  the amount inputs had `inputmode="decimal"` → phone shows a numeric-only
  pad with no operators. Fix: drop the numeric inputmode so the full
  keyboard (with operators) appears and quick-sum expressions can be typed.
  Agent scope: add-sheet amount + owed-entry inputs (the plan amount has no
  quick-sum button — tell me if you want the full keyboard there too) (user's answer: add the full keyboard there too.).
- "See img, positioning is awkward" — user clarified: the greeting block sits
  directly adjacent to the hero card. Fixed: `.greet` bottom padding 0 → 14px
  (the `.card` has no top margin, so the date was touching the card border).
- Restoring v52's evalExpr as-is exposed a precedence bug: v52's expr() added
  factor() (a single signed number), not term(), so 10-2*3 evaluated to 8,
  not 4. Restored with the fix (expr() → term()); all + - * / ( ) now honor
  standard precedence.
- Plan amount (p_amount): per the user's answer above, it gets the full
  keyboard too — and now parses via the same evalExpr, so expressions work
  there (label updated; the plan sheet has no live = hint, only on submit).
- Verified, no changes needed: chat.js (v52 chat.js has no quick-sum text)
  and check_owed.py (no quick-sum test cases — owedBal math only).
- v54 shell bump + gate + push when done.

### Subtasks
- [x] Log the instruction
- [x] Revert quick-sum from v52 (git `b156616`): evalExpr (+precedence fix), addAmtEq + live = hint, owed entry expr — app.js, index.html (chat.js / check_owed.py verified: nothing to revert)
- [x] Full keyboard on the amount inputs (f_amount, oent-amt, p_amount — numeric inputmode / type=number dropped)
- [x] Home positioning fix (.greet 14px bottom padding)
- [x] v54 bump: sw.js, SHELL_RELEASE, check_site.py (quick-sum checks back + keyboard check), READMEs
- [x] Gate: all checks passed (check_site.py + check_owed.py)
- [x] Commit + push — `083a734` → origin/main

## 2026-09-10 ~12:45 — Instruction log: verbatim + interpretation + status/percent/ETA
Status: **done** (pushed in this commit; hash = top of `git log`)
Progress: 100% — ETA was "minutes" (only commit + push left)

### Instruction (verbatim)
> about the logging in agents.md, write my instruction verbatiom, add ur own notes for ur own interpretation - i might edit ur interpretation so make it a habit to regularly check the md file. also add the task status, if ongoing, add ur progress and the subtasks that are already done and still to be done, add a percent progress and the estimated time of completion (completion=pushed to remote repo). if u think the progress clutters the agent.md file, just a create a separate log file

### Interpretation (agent — user may edit this section)
- The blockquote above is the user's exact words (typos included);
  everything below it is the agent's read and the user may edit it freely.
- The agent must **re-read this file before acting** on a logged
  instruction (and again mid-task on multi-step work). If the user edited
  the interpretation, the user's version is the new instruction — follow
  it, and note it if it changes the plan.
- Per-entry fields: Status (`not started` / `in progress` / `done` /
  `blocked`); Progress = percent + ETA; Subtasks = `[x]` done / `[ ]`
  still to do. In-progress entries must carry all three.
- Completion = **pushed to the remote repo** (record the commit hash).
- The detailed log lives in this separate file so the project `AGENTS.md`
  stays a short notes file; the workspace rule was updated to match and
  applies to all projects.

### Subtasks
- [x] Update the workspace rule (chat-root `AGENTS.md`) to the new format
- [x] Create `INSTRUCTIONS.md`; migrate the v53 entry with the true verbatim instruction
- [x] Trim `AGENTS.md` to project notes + rule pointer
- [x] Commit + push (this commit)

## 2026-09-10 11:45 — v53 batch (Unsorted, quick-sum cut, grey LED, named greeting, polish)
Status: **done**
Progress: 100% — completed 2026-09-10 ~12:25; commit `6078e54` pushed to origin/main

### Instruction (verbatim)
> 1 - Unsorted -> rename blank category to Unsorted
> 2 - Unsorted -> add filter
> 3 - Quick sum -> cut
> 4 - After adding an expense -> go to the Ledger
> 5 - Owed -> the e.g. Vhal placeholder is gone, put it back
> 6 - Force online coach -> not sure where this switch is
> 7 - Coach -> chat input placeholder -> shorten
> 8 - Your numbers -> the name placeholder should be: your name, cc prepay day
> 9 - Other placeholders in your numbers -> can be removed, except e.g. Jan (for the name)
> 10 - online coach LED -> not ready should be grey, not yellow
> 11 - Good morning, Hooman! -> good, if a name is set, it will be: Good morning, Hooman! (name)
>
> When you finish, do the v53 bump: sw.js, SHELL_RELEASE, the gate's assertion, the README, and the local helper's check_owed.py. After that, run the full gate and push. Also set up a new habit: log the instruction to the project's agents.md before doing anything else, and keep the status and notes updated. That way, even if I crash in the middle of a task, I can always resume. If the project doesn't have an AGENTS.md, create one. Every project folder must have its own AGENTS.md with an instruction log section.

### Interpretation (agent — user may edit this section)
- The items are terse; my read, one by one (edit freely):
  1+2. "Unsorted" = the bucket for expenses with **no category** (was
      "(no category)") in the donut, ledger rows, and the chat's spend
      breakdown; plus a **category filter** on the Ledger with an explicit
      Unsorted option. The real "Other" category is untouched.
  3. Delete the quick-sum expression parser (`evalExpr`) and the "= <sum>"
      hints from the Add sheet and Owed entries; amounts become plain
      numbers (phone keyboards are numeric-only — operators can't be typed).
  4. After "Add expense": close the sheet **and switch to the Ledger**.
  5. Restore the `e.g. Vhal` placeholder on the Owed name input.
  6. The force-online switch is wired in `ai.js` but not visible — make it
      visible/working. (Found: the HTML element never existed → added to
      Settings → Coach (online).)
  7. Shorten the chat input placeholder (→ "Ask the coach…").
  8. "Your numbers" editor labels: `name` → "your name", `prepay day` →
      "cc prepay day".
  9. Remove every other placeholder in that sheet except "e.g. Jan".
  10. Coach LED: not-ready state yellow → **grey**.
  11. Home greeting carries the name. Shipped behavior: no name set →
      "Good morning, Hooman!"; name set → "Good morning, <name>!".
      (Agent interpretation of an ambiguous line — user, edit if wrong.)
- Finish line: v53 shell bump (`sw.js` cache, `SHELL_RELEASE`,
  `check_site.py` assertions, READMEs, `check_owed.py`), full gate, push.
- Side request: establish the instruction-log habit (format refined in the
  newer entry above).

### Subtasks
- [x] Unsorted: donut / ledger rows / chat breakdown
- [x] Ledger category filter (All / Unsorted / per-category)
- [x] Quick-sum cut (evalExpr + hints + copy; parseFloat amounts; check_owed.py)
- [x] Post-add → close sheet + switch to Ledger
- [x] `e.g. Vhal` restored
- [x] Force-online toggle added (Settings → Coach (online))
- [x] Chat input placeholder → "Ask the coach…"
- [x] Your-numbers labels + placeholder cleanup (only "e.g. Jan" remains)
- [x] Coach LED not-ready → grey
- [x] Greeting with name (Hooman fallback)
- [x] v53 bump: sw.js, SHELL_RELEASE, check_site.py v53 section, READMEs
- [x] Gate: all checks passed (incl. esprima parse of all JS)
- [x] Pushed: `6078e54` → origin/main
