"""Structural gate for the Fin.AI PWA (v68).

Local-first app shell + deterministic rule engine + optional online coach.
The on-device "offline brain" (model worker, embeddings, lexicon) was removed
in v50 — this gate asserts the app still holds together AND that nothing from
the local brain is left behind. Run:  python tools/check_site.py
(paths are file-relative — works from any cwd; the repo copy in tools/ is
canonical for every session, see AGENTS.md).
"""
import os
import sys
from html.parser import HTMLParser

# Console code pages (cp850/cp1252) can't render every label character (e.g. —);
# never let cosmetic printing crash the checks.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass

# tools/ sits INSIDE the repo (finance-app/tools/), so the site is the parent dir
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)


class Balance(HTMLParser):
    VOID = {"meta", "link", "input", "img", "br", "hr", "source", "area", "base",
            "col", "embed", "track", "wbr"}

    def __init__(self):
        super().__init__()
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in self.VOID:
            self.stack.append((tag, self.getpos()))

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        if not self.stack:
            self.errors.append("unmatched close </%s> at %s" % (tag, self.getpos()))
            return
        open_tag, pos = self.stack.pop()
        if open_tag != tag:
            self.errors.append("mismatch: <%s> from %s closed by </%s> at %s"
                               % (open_tag, pos, tag, self.getpos()))


def main():
    def rd(name, default=""):
        p = os.path.join(SITE, name)
        if not os.path.isfile(p):
            return default
        with open(p, encoding="utf-8") as f:
            return f.read()

    html = rd("index.html")
    js = rd("app.js")
    chatjs = rd("chat.js")
    aijs = rd("ai.js")
    sw = rd("sw.js")
    mf = rd("manifest.webmanifest")
    readme = rd("README.md")
    worker = rd(os.path.join("worker", "worker.js"))
    fails = []

    def check(label, ok):
        print("  %-64s %s" % (label, "OK" if ok else "FAIL"))
        if not ok:
            fails.append(label)

    print("== files ==")
    check("app shell files present (index.html, app.js, chat.js, ai.js, sw.js, manifest)",
          all([html, js, chatjs, aijs, sw, mf]))
    check("model-worker.js is GONE (local brain removed)",
          not os.path.isfile(os.path.join(SITE, "model-worker.js")))
    check("free-coach Worker source still present (optional)", worker != "")

    print("\n== JS syntax (real parse, catches broken strings from hand edits) ==")
    try:
        import esprima
        _bad = []
        for _n, _src, _parse in (("app.js", js, esprima.parseScript),
                                 ("chat.js", chatjs, esprima.parseScript),
                                 ("ai.js", aijs, esprima.parseScript),
                                 ("sw.js", sw, esprima.parseScript),
                                 ("worker/worker.js", worker,
                                  getattr(esprima, "parseModule", esprima.parseScript))):
            if not _src:
                continue
            try:
                _parse(_src, {"tolerant": False})
            except Exception as _e:
                _bad.append("%s: %s" % (_n, _e))
        for _b in _bad:
            check(_b, False)
        if not _bad:
            check("app.js, chat.js, ai.js, sw.js (+worker) parse as valid JavaScript", True)
    except ImportError:
        check("esprima JS parse skipped (pip install esprima)", True)

    print("\n== HTML tag balance ==")
    p = Balance()
    p.feed(html)
    for e in p.errors:
        print("  " + e)
    for t, pos in p.stack:
        print("  unclosed <%s> from %s" % (t, pos))
    check("html tags balanced (no errors, no leftovers)", not p.errors and not p.stack)

    print("\n== branding ==")
    for _n, _s in (("index.html", html), ("app.js", js), ("chat.js", chatjs),
                   ("ai.js", aijs), ("sw.js", sw), ("manifest", mf)):
        check("no FinSmart in %s" % _n, "FinSmart" not in _s)
    check("brand is Fin.AI (title, topbar, footer stamp) + the bot is Coach Fin (v69, in the coach prompts)",
          "<title>Fin.AI</title>" in html and "Fin<span>.AI</span>" in html
          and "'Fin.AI · shell v'" in js and "You are Coach Fin" in chatjs
          and "You are Coach Fin" in aijs)
    check("manifest is named Fin.AI",
          '"name": "Fin.AI"' in mf and '"short_name": "Fin.AI"' in mf)
    check("README is Fin.AI + local-first, no old brain copy",
          "FinSmart" not in readme and "Fin.AI" in readme
          and "model-worker" not in readme and "local-first" in readme)

    print("\n== required element ids ==")
    for i in ["tab-home", "tab-money", "tab-ledger", "tab-owed", "bottombar", "tabs",
              "homeGreet", "greetHello", "greetDate",
              "coachOv", "coachFab", "botFace",
              "obligations", "obBody", "sinking", "sinkBody", "addEmpty",
              "summary", "projection", "projBody",
              "addForm", "planForm", "plans", "coach", "insights", "foot", "setFoot",
              "f_amount", "f_dateLabel", "p_dateLabel",
              "f_category", "f_account", "f_date", "f_note", "chargeHint",
              "chatHead", "chatTitle", "chatFresh", "chatInfo",
              "chatMsgs", "chatChips", "chatInRow", "chatInput", "chatSend",
              "chatTip", "chatTipText", "chatInfoView", "chatInfoBody",
              "addSheet", "setSheet", "scrim", "addBtn", "setBtn", "addClose", "setClose",
              "baseStatus", "baseBody", "baseMigrated", "homeOpenSet", "homeCoach",
              "impBtn", "impFile", "snack", "swToast", "swReload",
              "hero", "heroFree", "heroSub", "sparkBox", "digBody", "coachActs",
              "coachNote", "coachNoteBody", "coachNoteSub", "coachNoteRefresh",
              "donut", "donutSvg", "donutLegend", "pace", "paceBox", "paceNote",
              "p_repeat", "expJson", "expCsv",
              "moneyLog", "mlBody", "mlFilter", "txnCard",
              "tab-owed", "owedForm", "owedName", "owedBody", "owedSum",
              "owedSumIn", "owedSumOut", "owedSumNet",
              "confirmDlg",
              "coachLed", "aiRemoteToggle", "aiForceOnline", "aiRemoteUrl", "aiRemoteTest", "aiRemoteNote",
              "numSheet", "numClose", "numCoachBtn", "setBaseSum", "setNumOpen", "setNumCoach",
              "aiByoProvider", "aiByoKey", "aiByoBase", "aiByoModel"]:
        check("id %s" % i, 'id="%s"' % i in html)
    check("scripts load in order: app.js, then chat.js, then ai.js",
          html.index("app.js") < html.index("chat.js") < html.index("ai.js"))

    print("\n== PWA shell (offline app, online coach) ==")
    check("sw.js cache is v72 (dot releases v72.x per subtask)",
          "finances-pwa-v72" in sw and "finances-pwa-v71" not in sw)
    check("sw.js handles SKIP_WAITING", "'SKIP_WAITING'" in sw)
    check("shell cache holds the app scripts + manifest + icons (no model files)",
          "'./app.js'" in sw and "'./chat.js'" in sw and "'./ai.js'" in sw
          and "'./manifest.webmanifest'" in sw and "'./favicon.png'" in sw)
    check("sw.js: non-GET and cross-origin (coach) calls stay network-only",
          "url.origin !== self.location.origin" in sw and "req.method !== 'GET'" in sw)
    check("footer stamp: brand + shell v72 + live date/time, one source for both footers",
          "var SHELL_RELEASE = { v: 72" in js and "function shellStamp" in js
          and "'Fin.AI · shell v'" in js and 'id="setFoot"' in html
          and "byId('setFoot')" in js)
    check("service worker registration wired (page or app.js)",
          "serviceWorker.register" in html or "serviceWorker.register" in js)

    print("\n== home welcome + chart dates (v51) ==")
    check("welcome header: time-of-day greeting + full date, refreshed on tab show",
          'id="homeGreet"' in html and "function renderGreet" in js
          and "if (name === 'home') renderGreet();" in js and "renderGreet();" in js)
    check("sparkline x-axis shows dates: as-of day/month start + 'Sep '26' months",
          "function dayMonth" in js and '{ label: dayMonth(' in js
          and 'monthShort(row.month)' in js)

    print("\n== v52: optional category, no emergency cap, slim placeholders ==")
    check("add-expense: category is optional (no required prompt)",
          "or choose Custom" not in js)
    check("emergency_cap fully removed from app + chat math",
          "emergency_cap" not in js and "emergency_cap" not in chatjs)
    check("example placeholders: only 'e.g. Jan' (your name) + 'e.g. Vhal' (owed person)",
          'placeholder="e.g. Rent"' not in js
          and 'placeholder="optional"' not in html
          and 'placeholder="e.g. Jan"' in js
          and 'placeholder="e.g. Vhal"' in html
          and js.count('placeholder="e.g.') == 1
          and html.count('placeholder="e.g.') == 1)

    print("\n== v53: Unsorted, grey LED, named greeting, coach toggle ==")
    check("blank category reads Unsorted (donut, ledger rows, chat breakdown)",
          "t.category || 'Unsorted'" in js and "e.c || 'Unsorted'" in js
          and "tn.category || 'Unsorted'" in chatjs)
    check("ledger has a category filter with an explicit Unsorted option",
          'id="mlFilter"' in html and "function renderMlFilter" in js
          and '"__unsorted__"' in js)
    check("v54: quick-sum restored — evaluator + live = hint on the Add sheet",
          "function evalExpr" in js and "function addAmtEq" in js
          and "addAmtEq(amtEl); updateChargeHint()" in js
          and 'id="amtEq" class="amtEq"' in html and ".amtEq{" in html)
    check("v54: amount keyboards are full (operators typeable) on the quick-sum inputs",
          'id="f_amount" type="text" placeholder="0.00, or a quick sum like 300-125+10"' in html
          and '<input type="text" class="oent-amt" maxlength="40" autocomplete="off">' in js
          and 'id="p_amount" type="text"' in html
          and "evalExpr(raw)" in js)
    check("v54: home greeting has breathing room before the hero card",
          ".greet{padding:12px 18px 14px}" in html)
    check("switches to the Ledger tab right after an add", "setTab('ledger')" in js)
    check("home greeting carries the name (Hooman when none is set)",
          "'Hooman'" in js and "greet + ', ' + who + '!'" in js)
    check("coach LED is grey, not amber, when the online coach is not ready",
          ".coach-led{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--mut)" in html)
    check("'Your numbers': your name + cc prepay day labels, no stray placeholders",
          'bnote">your name<' in js and 'bnote">cc prepay day<' in js
          and 'placeholder="YYYY-MM"' not in js and 'placeholder="name"' not in js
          and 'placeholder="debt name"' not in js and 'placeholder="goal name"' not in js
          and 'placeholder="value"' not in js and 'placeholder="limit"' not in js
          and 'placeholder="what"' not in js)
    check("open-question toggle in Settings (v68 repurposed: default ON, ai.js)",
          'id="aiForceOnline"' in html and "byId('aiForceOnline')" in aijs
          and "function forceOnline" in aijs
          and "localStorage.getItem(FORCE_KEY) !== '0'" in aijs)
    check("chat input placeholder is short; owed name placeholder is back",
          'placeholder="Ask the coach…"' in html and 'placeholder="e.g. Vhal"' in html)

    print("\n== Add expense sheet (v50 layout) ==")
    check("Amount, then Category, then the Paid with + Date row",
          html.index('id="f_amount"') < html.index('id="f_category"')
          < html.index('id="f_account"') < html.index('id="f_date"'))
    check("Paid with is a labeled account select",
          'for="f_account"' in html and "Paid with" in html)
    check("Date sits beside Paid with with its label overlay",
          'id="f_dateLabel"' in html and 'class="dfield"' in html)
    check("submit button says Add expense", ">Add expense<" in html)
    check("add-expense submit reads amount/category/account/date/note",
          "byId('f_amount')" in js and "byId('f_category')" in js
          and "byId('f_account')" in js and "byId('f_date')" in js
          and "byId('f_note')" in js)
    check("amount input math is the hand-rolled evalExpr (no eval/Function on input)",
          "function evalExpr" in js and "new Function" not in js)

    print("\n== local-first data ==")
    check("IndexedDB is v5", "var DB_VERSION = 5;" in js)
    check("stores: txns, plans, meta, chat (created on upgrade)",
          all(('db.createObjectStore(STORE_%s' % s) in js
               for s in ("TX, { keyPath: 'id' })", "PLANS, { keyPath: 'id' })",
               "META, { keyPath: 'key' })", "CHAT, { keyPath: 'id' })")))
    check("upgrade drops the orphaned 'lex' store from older builds",
          "db.deleteObjectStore('lex')" in js)
    check("no lex store / lex helpers in app.js",
          "STORE_LEX" not in js and "lexPut" not in js
          and "lexAll" not in js and "lexDel" not in js)
    check("name placeholder reads 'e.g. Jan'", 'placeholder="e.g. Jan"' in js)
    check("export: one-tap JSON + CSV in Settings",
          "function exportData" in js and "createObjectURL" in js
          and "text/csv;charset=utf-8" in js)

    print("\n== rule engine (deterministic, the only writer) ==")
    check("story mode: validate + apply + one-tap undo (base save path)",
          "function applyBaseChanges" in js and "function undoBaseStory" in js
          and "STORY_UNDO_KEY" in js)
    check("deletes confirm first (ledger rows + owed)",
          "function confirmAsk" in js and "function askDeleteTxn" in js)
    check("chat.js persists only chat history (no financial writes)",
          chatjs.count("idbPut") == 1 and "F.idbPut(F.STORE_CHAT" in chatjs)
    check("coach rows + hero/spark/donut/pace renders",
          "function coachRows" in js and "function renderHero" in js
          and "function renderSpark" in js and "function renderDonut" in js
          and "function renderPace" in js)
    check("recurring plans: monthly repeat + 3-month expansion",
          "function planOccurrences" in js and "function shiftMonth" in js)
    check("chat parses stories into validated changes (local scorer, no model)",
          "function storyParse" in chatjs and "function storyAsks" in chatjs
          and "function extractStory" in chatjs and "function intentStory" in chatjs
          and "function semClause" in chatjs and "function fuzzyNameIn" in chatjs)
    check("draft card: drop line / confirm / discard / undo",
          "act: 'story_drop_line'" in chatjs and "act: 'confirm_story'" in chatjs
          and "act: 'discard_story'" in chatjs and "act: 'undo_story'" in chatjs)
    check("confirm writes through FinApp, draft persists on the chat message",
          "F.applyBaseChanges" in chatjs and "F.undoBaseStory" in chatjs
          and "if (res.storyLines) bm.storyLines = res.storyLines;" in chatjs
          and "state.base" not in chatjs)
    check("owed tracker: people/entries/balance + live = total hint",
          "function owedBal" in js and "function owedExprHint" in js
          and "function delOwedPerson" in js and "function delOwedEntry" in js)

    print("\n== online coach (optional, remote-only) ==")
    check("coach prompt: system + short memory + stored account/budget names",
          "AI_REMOTE_SYSTEM" in chatjs and "function coachHist" in chatjs
          and "recentHist = coachHist" in chatjs and "storyNames(ctx)" in chatjs)
    check("remote drafts validated to story shapes, confirmed like a story",
          "function parseCoachDraft" in chatjs and "function coachSanitizeChange" in chatjs
          and "AI_SETUP_SYSTEM" in chatjs and "function aiSetup" in chatjs)
    check("replies carry no per-message source label (header LED does)",
          "function aiAnswerHtml" in chatjs and '<div class="c-src">' not in chatjs)
    check("ai.js: Worker URL or bring-your-own key (Groq default, OpenAI-compatible)",
          "function byoGenerate" in aijs and "GROQ_MODEL" in aijs
          and "GROQ_BASE" in aijs and "OPENAI_BASE" in aijs
          and "workerConfigured()" in aijs and "byoConfigured()" in aijs)
    check("ai.js exposes FinAI: availability, LED, test, force-online",
          "window.FinAI" in aijs and "function remoteAvailable" in aijs
          and "function refreshLed" in aijs and "function testRemote" in aijs
          and "function forceOnline" in aijs)
    check("ai.js never calls a write action (rule engine stays the writer)",
          all(w not in aijs for w in
              ("addTxn", "applyBaseChanges", "addPlan", "deletePlan", "saveBase",
               "idbPut", "idbDel")))
    check("shell can kick the coach into guided setup",
          "function startSetup" in js and "startSetup: function" in chatjs)
    check("availability LED wired (chat header + settings note)",
          'id="coachLed"' in html and ".coach-led" in html
          and "function refreshRemoteNote" in aijs)
    check("chat header (v68 Jan add-on → v69): the 'i' info button TOGGLES the full 'what I can do' details (tap 'i' again to close — the back button is gone; scrim / Esc also close); the rotating example strip is pinned below the header, DISPLAY-ONLY (tap does nothing), rendered as a quoted example in italics",
          'id="chatInfo"' in html and 'id="chatClose"' not in html
          and 'id="chatTip"' in html and 'id="chatTipText"' in html
          and 'id="chatInfoView"' in html and 'id="chatInfoBack"' not in html
          and "function openInfoView" in chatjs and "function closeInfoView" in chatjs
          and "function toggleInfoView" in chatjs
          and "intentHelp('help')" in chatjs
          and "TIPS[tipIdx]" in chatjs and "setInterval" in chatjs
          and "closeInfo" in chatjs and "closeInfo" in js
          and "tip.onclick" not in chatjs and "font-style:italic" in html
          and "<b>Try</b>" in html and "<b>Tip</b>" not in html)
    check("the bot is Coach Fin (v69): the header title + self-introductions + both LLM system prompts; the name is separate from the user's display name in Settings (the greeting still uses coachName())",
          'id="chatTitle">Coach Fin' in html and "You are Coach Fin" in chatjs
          and "I’m <b>Fin</b> — your money coach" in chatjs
          and "function coachName" in chatjs)
    check("account balance cue (v69): NEW accounts + the spoken kind word + debit default — 'i have landbank debit 600' drafts a debit account, 'landbank debit' = 'landbank' (kind word stripped from the name); casual logging gains 'ate' and a dropped subject ('ate at jollibee 250')",
          "function newAcctName" in chatjs and "function knownEntityIn" in chatjs
          and "kindHintA || 'debit'" in chatjs
          and "(?:paid|bought|spent|ate|charged|gave|sent|swiped|used)" in chatjs)
    check("chips derive from the stored numbers (v69): the standing four use the real prepay day + the biggest budget, so they change with the state even when no coach alert is active",
          "function standingChips" in chatjs and "function dynamicChips" in chatjs
          and "prepayDay: d.prepayDay" in js and "topCat: topCat" in js)
    check("'hm' = 'how much' (v70): a bare 'hm' (any trailing punctuation) — or a bare 'how much' — routes to the full status summary",
          "^(?:hm|how much)" in chatjs and "want.all = true" in chatjs)
    check("shadow mode (v68 item 11): every chat message logs its answering path (rule intent / llm / fallback) + what was drafted, capped at 200 in a meta key, included in the JSON export",
          "SHADOW_KEY = 'shadowLog'" in js and "SHADOW_CAP = 200" in js
          and "shadowLog: state.shadowLog || []" in js
          and "r.__path = 'rule:'" in chatjs and "aiRes.__path = 'llm'" in chatjs
          and "fbR.__path = 'fallback'" in chatjs and "F.shadowLog" in chatjs)
    check("coach findings in the note prompt (v68 item 12): the LLM phrases the top deterministic findings instead of raw numbers; the coach rows stay the offline default",
          "function coachFindings" in js and "coachFindings: coachFindings" in js
          and "F.coachFindings" in chatjs and "'- finding: '" in chatjs)

    print("\n== v55: coach-first, confirm protocol, coach's note ==")
    check("rules-first routing (v68): the v55 LLM first-pass is GONE — the rule engine always runs first; the repurposed toggle (default ON) gates only the open-question path",
          "var aiFirst = aiCoach(t, ctx);" not in chatjs
          and "FAI0.remoteAvailable() && FAI0.forceOnline()" not in chatjs
          and "(FAI0 && FAI0.forceOnline()) ? aiCoach(t, ctx) : null" in chatjs)
    check("draft-on-clear protocol (v61): a clear change is drafted immediately (the Confirm button is the confirmation, no 'shall I record that?'/yes step); a missing detail is asked and the next short message completes it; the draft holds ONLY that change",
          "reply with ONLY the JSON draft of that change" in chatjs
          and "shall I record that?" in chatjs and "never wait for a yes" in chatjs
          and "changes holds ONLY that change" in chatjs and "never pad it with current balances" in chatjs
          and "a single field change (entity card, key credit_limit) on that card" in chatjs
          and "completes that same request" in chatjs
          and "re telling me" not in chatjs and "STATE: your last message" not in chatjs)
    check("open-draft correction: a reply to an unconfirmed draft goes to the coach with the draft",
          "var openDraft = null;" in chatjs
          and "An UNCONFIRMED draft of base-data changes is on screen:" in chatjs
          and "if (rm.storyLines && rm.storyLines.length && !rm.done)" in chatjs)
    check("shared month snapshot (chat prompts + Home note) with a fingerprint for the note cache",
          "function coachSnapshot" in chatjs and "coachSnapshot: coachSnapshot" in chatjs
          and "function renderCoachNote" in js and "function readNoteCache" in js)
    check("coach's note card on Home: read-only, cached, hidden without a coach",
          'id="coachNote"' in html and 'id="coachNoteBody"' in html
          and 'id="coachNoteRefresh"' in html and ".coachnote-t{" in html
          and "FAI.note(snap.text)" in js and "NOTE_KEY" in js)
    check("token caps raised for the protocol: ai.js 512, sendLlm 256, worker 512",
          "Math.min(512, (opts && opts.maxNew) || 256)" in aijs
          and "{ maxNew: 256 }" in chatjs
          and "var MAX_TOKENS = 512" in worker)
    check("note path never writes (ai.js still write-free, chat store untouched)",
          "function note(snapshotText" in aijs and chatjs.count("idbPut") == 1)

    print("\n== v56: coach-extensible table (custom details) ==")
    check("field draft shape: sanitizer case + apply branch + label",
          "case 'field'" in chatjs and "ch.type === 'field'" in js
          and "'Detail · '" in chatjs)
    check("details live in base.details (side-map, no schema migration) incl. defaultBase",
          "b.details = b.details || {}" in js and "details: {}" in js)
    check("snapshot carries per-row balances + details (utilization from stored data)",
          "detTxt" in chatjs and "money(a.value || 0) + detTxt(a.kind + ':' + a.name)" in chatjs)
    check("reserved column names can't be clobbered by a detail key",
          "'balance', 'goal'" in chatjs and "var DET_RESV" in js)
    check("custom details show as chips in Your numbers; tap removes",
          '"bchip"' in js and "data-dk" in js and ".bchip{" in html)
    check("import sanitizes details; a form commit preserves them",
          "function sanitizeDetails" in js and "b.details = state.base.details" in js)
    check("no rule-engine hardcode for '<card> limit is N' (v57: the coach does it on its own)",
          "Card limit · " not in chatjs and "\\blimit\\b" not in chatjs)
    check("prompt stays under the Worker cap (snapshot capped, worker cap raised)",
          "snapTxt.length > 1300" in chatjs and "var MAX_INPUT = 8000" in worker)

    print("\n== v63: add-expense categories come from Your numbers ==")
    check("no fixed category list remains (defaults + custom field removed)",
          "CATEGORY_DEFAULTS" not in js and "CAT_CUSTOM" not in js
          and "f_categoryCustom" not in html)
    check("add-sheet options = base budget names; Unsorted default when none",
          "Object.keys((state.base && state.base.budgets) || {})" in js
          and "'>Unsorted</option>" in js and "selected>Unsorted</option>" in html)
    check("re-seeded automatically when the base changes (snap render list)",
          "renderBaseStatus, renderCoachNote, seedCategories]" in js)
    check("chat matches only stored budget names: no hint list, no 'Other' fallback",
          "function mentionedBudget(t, ctx)" in chatjs
          and "cat: mentionedBudget(t, ctx)" in chatjs
          and "CAT_HINTS" not in chatjs and "guessCategory" not in chatjs
          and "'Other'" not in chatjs)

    print("\n== v64: add-expense 'Paid with' comes from Your numbers ==")
    check("label renamed: Card / cash -> Paid with (old label gone)",
          'for="f_account"' in html and "Paid with" in html
          and "Card / cash" not in html)
    check("Cash is the always-present, pre-selected default (html + seed)",
          '<option value="CASH::Cash" selected>Cash</option>' in html
          and '<option value="CASH::Cash" selected>Cash</option>' in js)
    check("no hardcoded account list / Pick placeholder / pick alert remains",
          "DEFAULT_ACCOUNTS" not in js and "Pick an account" not in js
          and "Pick…" not in html and "Pick…" not in js)
    check("options = base card+debit accounts; re-seeded on base change (snap list)",
          "a.kind === 'card' || a.kind === 'debit'" in js
          and "renderSinking, seedAccounts, renderAddEmpty" in js)
    check("submit maps an empty pick to the Cash default",
          "byId('f_account').value || 'CASH::Cash'" in js)

    print("\n== v65: Paid-with names bare; account kind cash -> debit ==")
    check("paid-with option labels drop the (card)/(cash) kind suffix",
          "' (card)'" not in js and "' (cash)'" not in js
          and "+ esc(a.name) + '</option>'" in js)
    check("base editor: the kind select offers exactly Debit / Credit (v72.4; 'Credit' = internal 'card' kind)",
          "var kinds = ['debit', 'card']" in js
          and "var kinds = ['debit', 'card', 'debt', 'loan']" not in js)
    check("no stored-account path still writes the old 'cash' kind",
          "kind: 'cash'" not in js and "kind: 'debit'" in js)
    check("one-time migration rewrites old 'cash' kinds and detail keys",
          "function migrateBaseKinds" in js
          and "state.base = migrateBaseKinds(m.value)" in js
          and "'debit:' + k.slice(5)" in js)
    check("coach: debit kind, legacy 'cash' normalized, matcher + draft label retargeted",
          "COACH_KINDS = { debit: 1, cash: 1" in chatjs
          and "if (kind === 'cash') kind = 'debit'" in chatjs
          and "w.kind === 'debit'" in chatjs
          and "ch.kind !== 'debit'" in chatjs)

    print("\n== v71: your-numbers quicksum + drag-reorder + save button; ledger edit + AM/PM + unsorted title; snack; coach avatar (dot releases v71.1..v71.8) ==")
    check("'Your numbers' fields take quick sums (v71.1): text inputs (full keyboard, operators typeable) and numVal evaluates the expression first; commit stores the total (v72.6)",
          'type="number"' not in js and "evalExpr(el.value)" in js
          and "Math.round(numVal(byId('b_pday'), true))" in js)
    check("'Your numbers' live quick-sum hint (v71.1): qsBar on the sheet",
          'id="qsBar"' in html and "function qsHint" in js and ".qsbar{" in html)
    check("'Your numbers' rows are drag-reorderable (v71.2): handle + pointer drag; order saved on drop (Add-sheet categories follow the saved order)",
          "function dragH" in js and "data-drag" in js
          and "function baseDragStart" in js and "function baseDragMove" in js
          and "function baseDragEnd" in js and "insertBefore(dragSt.row" in js
          and "touch-action:none" in html and ".bdrag{" in html)
    snack_rule = ""
    if "#snack{" in html:
        snack_rule = html.split("#snack{", 1)[1].split("}", 1)[0]
    check("add snack centered bulletproof (v71.3, re-done in v72.20): left:50% with translateX(-50%) carried INSIDE the transform in BOTH the base and .show states (the #swToast pattern — the v71 left:0;right:0 + margin auto variant still floated left on the user's phone, so no state may be able to drop the X offset); the add toast has NO undo (ledger ✕ is the delete path)",
          "left:50%" in snack_rule and "transform:translate(-50%,10px)" in snack_rule
          and "#snack.show{opacity:1;transform:translate(-50%,0)" in html
          and "snack('Added ' + money(t.amount) + ' \u00b7 ' + esc(t.category || t.account));" in js
          and "undoAddTxn" not in js)
    check("ledger entries are editable (v71.4): tap a row -> the Add sheet opens pre-filled (title/button flip to Edit/Save); Save re-logs via saveTxnEdit (same id; Undo restores the ORIGINAL entry)",
          "function openTxnEdit" in js and "function saveTxnEdit" in js
          and "function removeTxnRow" in js and "function restoreTxnRow" in js
          and "data-ml-edit" in js and "ev.stopPropagation()" in js
          and 'id="addSheetTitle"' in html and 'id="addSubmit"' in html)
    check("'Your numbers' Save button appears only when dirty (v71.5); closing the sheet auto-commits (nothing typed is lost)",
          'id="baseSave"' in html and "function markBaseDirty" in js
          and "function setBaseClean" in js and "function commitIfDirtyBase" in js
          and "openSheetEl.id === 'numSheet'" in js)
    check("ledger adds with no category get a blank category: the row title is Unsorted, not the account name (v71.6)",
          "c: t.category || ''" in js)
    check("ledger rows show the 12-hour AM/PM time next to the date; mlDate exported to the chat parser (v71.7)",
          "h12 = h % 12 || 12" in js and "mlDate: mlDate," in js)
    check("the coach note header carries the bot's face (svg #botFace) left of the label; the avatar is untouched (v71.8)",
          'class="coachnote-av"' in html and ".coachnote-av{" in html
          and '<use href="#botFace"/>' in html)

    print("\n== v72: coach note offline-only sub line + gear glyph (dot releases v72.x) ==")
    check("the coach note sub line is offline-only (v72.1): stale shows 'Coach Fin is unavailable right now.'; a fresh note shows no sub line (both old variants gone)",
          "'Coach Fin is unavailable right now.'" in js
          and "sub.style.display = sub.textContent ? '' : 'none'" in js
          and "'the online coach reads your numbers" not in js
          and "'the online coach is not reachable right now" not in js)
    check("the settings gear glyph is enlarged to 20px (v72.2); the 44px tap target stays (a11y block)",
          "font-size:20px;flex:0 0 auto;line-height:1}" in html
          and "button.gear{width:44px;height:44px}" in html)
    check("Coach Fin gets a light, funny voice in the LLM paths only (v72.3): chat system prompt + note prompt + welcome line; accuracy and draft protocol still win",
          "Personality (v72.3): light and funny - dry wit, at most one short quip" in chatjs
          and "one dry, self-aware quip at most" in aijs
          and "I read the numbers; I do not judge the ramen" in chatjs
          and "the draft JSON below always win" in chatjs)
    check("account kind = credit or debit only (v72.4): the picker offers just the two; a legacy debt/loan row keeps its kind via a per-row '(legacy)' option",
          " (legacy)</option>" in js and "'Credit'" in js and "'Debit'" in js
          and "kinds.indexOf(a.kind) < 0" in js)
    check("Coach Fin has a 5-minute conversation memory (v72.5): session = rows since the last 5+ min gap, capped at 24 msgs x 160 chars; past the 3800-char guard the OLDEST lines are trimmed, not the whole memory",
          "COACH_MEM_GAP_MS = 5 * 60 * 1000" in chatjs and "COACH_MEM_MAX = 24" in chatjs
          and "mem = mem.slice(1)" in chatjs and "out.length < 6" not in chatjs)
    check("quicksum stores the computed total (v72.6): commit normalizes every Your-numbers amount field to the evaluated total (one-way; a plain number shows next open)",
          "function numVal(el, normalize)" in js and "if (normalize) el.value = v" in js
          and "numVal(byId('b_salary'), true)" in js and "numVal(vi, true)" in js
          and "numVal(ai, true)" in js)
    check("owed people: drag + sort, default recent (v72.7): az/recent/custom control persisted on state.owed; the ⠿ handle on each person card reorders and pins the sort to custom",
          "function owedSortedPeople" in js and "state.owed.sort || 'recent'" in js
          and 'id="owedSort"' in html and "data-ow-drag" in js
          and "state.owed.sort = 'custom'" in js and "p.updated = new Date().toISOString()" in js)
    check("export/import cover the whole app (v72.8): the JSON backup is async (reads the chat store) and carries the chat thread, the Ledger money log, the overlay (adj+sig) and the owed sort; the import restores all of them, recomputing adj from txns when a pre-72.8 backup lacks it",
          "idbAll(STORE_CHAT).then" in js and "chat: chat" in js
          and "moneyLog: (state.moneyLog || []).slice(-ML_CAP)" in js
          and "adj: state.adj, adjSig: state.adjSig || ''" in js
          and "owedSort: state.owed.sort || 'recent'" in js
          and "sanitizeChatRows(data.chat)" in js
          and "sanitizeMoneyLogRows(data.moneyLog)" in js
          and "if (!data.adj) computeAdjFromTxns()" in js)
    check("import sanitizer keeps every row flavor (v72.14): the k allow-list covers c/x/p/i — the v72.8 list (c/x only) silently stripped the v72.10 card_payment/cash_in flavors on import, rendering them as spends with inverted before/after",
          "if (e.k === 'c' || e.k === 'x' || e.k === 'p' || e.k === 'i') m.k = e.k" in js)
    check("ledger edits stay in place (v72.9): the edit rewrites the txn at its OWN index (no re-file at the end), keeps the money-log row's ORIGINAL timestamp, and rebases that row + every later row by the constant delta (month lines by each row's own txn month); Undo is the exact inverse (un-rebase + original row at its position, no delete+re-add)",
          "state.txns[oIdx] = t; // in place — position preserved" in js
          and "rebase(e0, dFree, dCard, 1)" in js
          and "for (var k = li + 1; k < log.length; k++) { if (log[k]) rebase(log[k], dFree, dCard, 1); }" in js
          and "function monthOfTxn(tid)" in js
          and "var origRow = li >= 0 ? Object.assign({}, log[li]) : null;" in js
          and "function removeTxnRow(tid, keepInStore)" in js
          and "return { t: t, removed: removed, txIdx: txIdx, logIdxs: logIdxs, persist: done };" in js
          and "state.txns.splice(ti, 0, r.t);" in js
          and "var r = removeTxnRow(tid, true); // keep the persistent row (see above)" in js)
    check("owed entries with an account are real ledger txns (v72.10): inflow kinds cash_in / card_payment are the exact inverse of their spend twins (txnAdj), the log row flavor i/p renders before→after correctly and nets month spend, the owed form carries the account dropdown (default Cash, '' = note only, hidden for tpf), subentries edit the linked txn in place (v72.9) and delete/undo cover entry + txn together; 'Owed' joins the add-sheet categories",
          "if (t.kind === 'card_payment') return { cash: 0, free: -amt, card: -amt, prepay: -amt };" in js
          and "if (t.kind === 'cash_in') return { cash: -amt, free: -amt, card: 0, prepay: 0 };" in js
          and "k: t.kind === 'card_charge' ? 'c' : t.kind === 'card_payment' ? 'p' : t.kind === 'cash_in' ? 'i' : 'x'" in js
          and "function owedTxnKind(dir, acc)" in js
          and '<select class="oent-acc">' in js and "owedAccOptions('CASH::Cash')" in js
          and "category: 'Owed', amount: e.amt, note: 'Owed \u00b7 ' + p.name" in js
          and "if (editId) updateOwedEntry(pid, editId, payload);" in js
          and "function updateOwedEntry(pid, eid, data)" in js
          and "if (names.indexOf('Owed') < 0) names.push('Owed');" in js)
    check("the floating bot owns the bubble (v72.15): pointer drag (>8px = drag, tap still toggles the coach), on release the bot settles to the NEAREST screen EDGE, sliding along it to the finger's spot, clamped into the SAFE area (status bar above, the 88px tab bar below, 16px sides — the v72.11 corner snaps + bubble-geometry math are gone); the open panel anchors to the bot's face (least-clamping side wins, above breaks ties, scale-in origin aimed at the bot) and the bot stays visible as the bubble's handle; the spot persists as fin.fabPos.v2 {edge,u} with a one-time fin.fabPos.v1 migration and re-derives on resize/orientation",
          "var FAB_POS_KEY = 'fin.fabPos.v2'" in js
          and "var FAB_POS_V1 = 'fin.fabPos.v1'" in js
          and "function fabSafe()" in js
          and "function fabEdgePos(edge, u, s)" in js
          and "function fabNearestEdge(cx, cy)" in js
          and "function fabEdgeFromPoint(cx, cy)" in js
          and "function fabPanelCandidates(fab, ov)" in js
          and "function fabPlacePanel()" in js
          and "fabPlacePanel(); // v72.15: anchor the panel to the bot BEFORE the scale-in" in js
          and "ov.style.right = 'auto';" in js
          and "fabPosSave(m);" in js
          and "fab.addEventListener('pointermove'" in js
          and "fabLastDragAt = Date.now(); // a click right after a drag must NOT open the coach" in js
          and "window.addEventListener('orientationchange', fabSettleAny);" in js
          and "touch-action:none" in html
          and "fabSnapPoints" not in js
          and "fabBubbleRect" not in js)
    check("the bot's drag feels smooth (v72.13, re-tuned v72.22): no left/top transition while dragging (fabHold on pointerdown) and only the transform animates — the scale(1.06) 'lift'; v72.22 the bot TRAILS the finger with a small follow-lag (rAF loop + fabLagEase exponential smoothing, ~50ms time constant, reduced-motion = instant 1:1) instead of 1:1 tracking; on release the bot GLEIDES to the edge over .28s ease-out (fabGlide) and the resize/orientation settle glides too",
          "var FAB_GLIDE = 'left .28s cubic-bezier(.2,.8,.25,1), top .28s cubic-bezier(.2,.8,.25,1)," in js
          and "function fabGlide()" in js
          and "function fabHold()" in js
          and "fabHold(); // v72.13: kill the left/top glide" in js
          and "var FAB_LAG_MS = 50" in js
          and "function fabLagStep()" in js
          and "requestAnimationFrame(fabLagStep)" in js
          and "transform:scale(1.06)" in html)
    check("the settle has feel polish (v72.16): the settle's transform runs a slight overshoot bezier (the lift scales down past 1 and catches — a small pop; left/top stay ease-out so the bot never crosses the screen edge), a guarded 8ms haptic tick fires the moment a drag starts, and prefers-reduced-motion falls back to an instant settle (no glide, no overshoot)",
          "transform .2s cubic-bezier(.3,1.4,.5,1)" in js
          and "if (navigator.vibrate) navigator.vibrate(8)" in js
          and "function fabReduceMotion()" in js
          and "matchMedia('(prefers-reduced-motion: reduce)')" in js
          and "fab.style.transition = 'none';" in js)
    check("the bot flicks (v72.17, travel increased in v72.22): the drag state tracks the last FINGER move sample's velocity; on release the lag stops, the bot snaps to the finger's clamped target, and a fast flick (speed > 0.5px/ms) projects the center forward by 320ms of that velocity BEFORE the edge settle — a flick carries the bot far to the aimed edge; a slow release settles by position alone",
          "var FAB_FLICK_MS = 320, FAB_FLICK_MIN = 0.5" in js
          and "st.vx = (ev.clientX - st.lastX) / dt" in js
          and "if (sp > FAB_FLICK_MIN) { cx += st.vx * FAB_FLICK_MS; cy += st.vy * FAB_FLICK_MS; }" in js)
    check("the drag has a follow-lag (v72.22, user: 'add a delay from finger like the bubble is following the finger'): pointermove only sets the finger TARGET (st.tx/st.ty); an rAF loop moves the bot partway toward it each frame (fabLagEase, ~50ms time constant, reduced-motion snaps instant); the flick velocity is sampled from the finger, and release stops the lag and starts the flick from the finger's clamped target",
          "st.tx = st.left + (ev.clientX - st.x)" in js
          and "st.curL = fabLagEase(st.curL, st.tx, Date.now() - st.lastFrame, fabReduceMotion() ? 0 : FAB_LAG_MS)" in js
          and "function fabLagEase(cur, target, dt, tc)" in js
          and "fabLagStart();" in js and "fabLagStop();" in js
          and "fabLagEase: fabLagEase" in js)
    check("the bot stays in front of the open chat box (v72.18): while the bubble is showing, #coachFab rides above the panel (z 30 > 25) — it is the bubble's handle, and the clamped panel can overlap the bot's spot; the face stays tappable (tap = close)",
          "#coachOv.show ~ #coachFab{z-index:30}" in html)
    _ow_btn = js.find('class="addrow" data-ow-toggle=')
    _ow_note = js.find("(rows || '<p class=\"note\"")
    check("the owed '+ entry' sits at the TOP of the person card (v72.19, user request): the addrow button + its hidden form render right after the card header, BEFORE the entry rows — an opened form expands next to its button and pushes the list down; the empty-card note points 'above' now",
          _ow_btn > -1 and _ow_note > -1 and _ow_btn < _ow_note
          and 'add the first one above.' in js
          and 'add the first one below.' not in js)
    check("the snack toast is smaller (v72.20, user: 'reduce its size'): the pill shrinks — padding 8px 12px, 12.5px type, 88vw/380px cap (was 10px 14px / 13px / 92vw/480px), radius 10",
          "padding:8px 12px" in snack_rule
          and "font-size:12.5px" in snack_rule
          and "max-width:min(88vw,380px)" in snack_rule
          and "border-radius:10px" in snack_rule)
    check("the panel never covers the bot (v72.21, user: 'the bot should not cover the chatbox' — with v72.18 keeping the bot on top as the safety net): fabPanelPick makes the chosen side's gap a hard constraint — a side that can't keep FAB_PANEL_GAP from the bot's face inside the safe bounds is infeasible and skipped (above/below/left/right, above wins ties); only the tiny-screen allowCover fallback may overlap",
          "function fabPanelPick(c, r, b, allowCover)" in js
          and "if (side === 'above' && py + c.H > r.top - FAB_PANEL_GAP) continue;" in js
          and "if (side === 'right' && px < r.right + FAB_PANEL_GAP) continue;" in js
          and "fabPanelPick(c, r, b, false) || fabPanelPick(c, r, b, true)" in js
          and "fabPanelPick: fabPanelPick" in js)
    check("emoji allowed, kept light, in the voice paths only (v72.12): the v72.3 'no emojis' flips to at most one where it fits (chat + note prompts); the setup prompt stays plain; the welcome carries one on its ramen line",
          "at most one emoji and only where it genuinely fits" in chatjs
          and "at most one emoji and only where it genuinely fits" in aijs
          and "no lists, no markdown, no emojis" not in chatjs
          and "no markdown, no emojis, no numbers" not in aijs
          and "no emojis. Ask for 1-2 things" in chatjs
          and "do not judge the ramen 🍜" in chatjs)

    print("\n== local brain is GONE (v50 final) ==")
    for _n, _s in (("app.js", js), ("chat.js", chatjs), ("ai.js", aijs), ("sw.js", sw)):
        check("%s: no model worker / transformers / embeddings" % _n,
              "model-worker" not in _s and "transformers" not in _s
              and "embedding" not in _s and "SmolLM" not in _s
              and "MiniLM" not in _s and "onnxruntime" not in _s
              and "WebGPU" not in _s)
    check("html: no brain UI (toggle, lex list, status chip) left",
          all(x not in html for x in ("aiToggle", "aiNote", "aiLex", "mlNote",
                                      "ai-chip", "chatAI", "aiModel135", "aiModel360")))
    check("no 'worse case' row anywhere",
          "worse case" not in js and "worse case" not in html)
    check("no b_ecap / runConcept leftovers in app or chat code",
          all(x not in js + chatjs for x in ("b_ecap", "runConcept")))

    print()
    if fails:
        print("RESULT: %d FAILURES: %s" % (len(fails), fails))
        raise SystemExit(1)
    print("RESULT: all checks passed")


if __name__ == "__main__":
    main()



