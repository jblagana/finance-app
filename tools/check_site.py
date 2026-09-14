"""Structural gate for the Fin.AI PWA (v68).

Local-first app shell + deterministic rule engine + optional online coach.
The on-device "offline brain" (model worker, embeddings, lexicon) was removed
in v50 — this gate asserts the app still holds together AND that nothing from
the local brain is left behind. Run:  python tools/check_site.py
(paths are file-relative — works from any cwd; the repo copy in tools/ is
canonical for every session, see AGENTS.md).
"""
import os
import re
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


def css_no_comments(html_doc):
    """v72.35: the <style> block without comments/quoted strings — what the
    CSS parser actually sees (a stray '}' inside a comment is harmless; the
    same characters at top level swallow the next rule)."""
    try:
        css = html_doc.split('<style>', 1)[1].split('</style>', 1)[0]
    except IndexError:
        return ''
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    return re.sub(r'"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'', '', css)


def css_brace_ok(html_doc):
    """v72.35: <style> brace balance. A stray top-level '}' (or an unclosed
    '{') makes Chromium swallow the NEXT rule as an invalid qualified rule
    (the Phase-1 snack bug: the #snack base rule was silently dropped, so the
    toast rendered as plain flow text above the footer in every version).
    Depth must never go negative and must end at 0."""
    depth = 0
    for ch in css_no_comments(html_doc):
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


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
          and "obj.shadowLog = state.shadowLog || [];" in js
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
    check("re-seeded automatically when the base changes (snap render list; v72.30: renderMoneyLog follows — a base save can file 'Adjustment' rows)",
          "renderBaseStatus, renderCoachNote, seedCategories, renderMoneyLog]" in js)
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
    check("snack centered bulletproof (v71.3, re-done in v72.20, TOP banner in v72.32): left:50% with the X offset carried INSIDE the transform in BOTH the base (hidden above the screen) and .show states (the #swToast pattern — no state may be able to drop the X offset); v72.32 the banner anchors to the top like the new-version toast and hides with visibility too (the Android-recents ghost-pill rule); the add toast's v71 'no undo' was REVERSED in v72.36 (undo on every action toast — see the v72.36 check)",
          "left:50%" in snack_rule and "transform:translate(-50%,-160%)" in snack_rule
          and "visibility:hidden" in snack_rule
          and "#snack.show{opacity:1;visibility:visible;transform:translate(-50%,0)" in html
          and "snack('Added ' + money(t.amount) + ' \u00b7 ' + esc(t.category || t.account), function () {" in js
          and "undoAddTxn" not in js)
    check("v72.32 (user: 'for the toasts, remake them into a banner on the top of screen which stays for 7 seconds but can be swiped up to remove immediately. kinda similar to the new version toast.'): the snack is a TOP banner in the #swToast family (safe-area top, touch-action:none so the page can't steal the swipe) with a 7s default lifetime; the swipe-up follows the finger (pointermove, .dragging kills the transition, 0.85 resistance + fade) and a release past the threshold (-60px or 40% of the banner height) dismisses it immediately, anything less springs back; the Undo button is not a drag handle",
          "top:calc(10px + env(safe-area-inset-top))" in snack_rule
          and "touch-action:none" in snack_rule
          and "#snack.dragging{transition:none}" in html
          and "snackTimer = setTimeout(hideSnack, ms || 7000)" in js
          and "function wireSnackSwipe()" in js
          and "snackDragStart = ev.clientY" in js
          and "ev.target.id === 'snackUndo'" in js
          and "wireSnackSwipe();" in js)
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
    check("export/import cover the whole app (v72.8, selectable in v72.23): the JSON backup is async (reads the chat store) and, by default, carries the chat thread, the Ledger money log, the overlay (adj+sig) and the owed sort; the import restores all of them, recomputing adj from txns when a pre-72.8 backup lacks it",
          "idbAll(STORE_CHAT).then" in js and "obj.chat = chat" in js
          and "obj.moneyLog = (state.moneyLog || []).slice(-ML_CAP)" in js
          and "obj.adj = state.adj; obj.adjSig = state.adjSig || ''" in js
          and "obj.owedSort = state.owed.sort || 'recent'" in js
          and "sanitizeChatRows(data.chat)" in js
          and "sanitizeMoneyLogRows(data.moneyLog)" in js
          and "if (!data.adj) computeAdjFromTxns()" in js)
    check("import sanitizer keeps every row flavor (v72.14, v72.30): the k allow-list covers c/x/p/i/a — the v72.8 list (c/x only) silently stripped the v72.10 card_payment/cash_in flavors on import, rendering them as spends with inverted before/after; v72.30 adds 'a' (the Adjustment override row)",
          "if (e.k === 'c' || e.k === 'x' || e.k === 'p' || e.k === 'i' || e.k === 'a') m.k = e.k" in js)
    check("the Backup section lets the user choose what goes into the JSON export (v72.23, user: 'a backup section in settings where u can choose which data u wanna export etc e.g. owed tab entries only'): six checkboxes in Settings (base/txns/plans/owed/log/chat), the choice persists (fin.bkSel.v1, default = everything), the export holds ONLY the ticked sections and lists them in `sections`, and the import restores only what the file holds (hasSec) — unlisted sections stay as the phone's own data",
          'id="bkBase"' in html and 'id="bkTxns"' in html and 'id="bkPlans"' in html
          and 'id="bkOwed"' in html and 'id="bkLog"' in html and 'id="bkChat"' in html
          and "function backupSelRead()" in js and "function backupSelWrite()" in js
          and "localStorage.getItem('fin.bkSel.v1')" in js
          and "obj.sections = inc" in js
          and "function hasSec(n) { return !secs || secs.indexOf(n) >= 0; }" in js
          and "if (hasSec('txns')) state.txns = data.txns || [];" in js
          and "if (hasSec('owed')) saveOwed();" in js
          and "if (id === 'setSheet') { renderBaseStatus(); backupSelSync(); }" in js
          and "backupSelRead: backupSelRead" in js)
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
    check("owed entries: only 'they paid for me' is a real ledger txn (v72.10, the filing rule was finalized in the v72.28 follow-ups — the ledger records CONSUMPTION, not loans: ipf/itb/tmb are ledger-silent, tpf always files a Cash cash_out): cash_in remains the exact inverse of cash_out (txnAdj, manual ledger use); v72.42: card_payment settles the debt instead of inverting the charge (raw liquid + owed drop, free untouched — the v72.42 check pins it), the log row flavor i/p renders before→after correctly and nets month spend, the Account section stays on ipf/itb/tmb as an informational record (user edit: 'dont drop it anymore' — never a txn), subentries edit the linked txn in place (v72.9) and delete/undo cover entry + txn together; 'Owed' joined the add-sheet categories (out again in v72.30); the v72.28 sections + filing rules are the NEXT check",
          "if (t.kind === 'card_payment') return { cash: amt, free: 0, card: -amt, prepay: -amt, acc: t.account };" in js
          and "if (t.kind === 'cash_in') return { cash: -amt, free: -amt, card: 0, prepay: 0 };" in js
          and "k: t.kind === 'card_charge' ? 'c' : t.kind === 'card_payment' ? 'p' : t.kind === 'cash_in' ? 'i' : 'x'" in js
          and '<select class="oent-acc">' in js and "owedAccOptions('CASH::Cash')" in js
          and "function owedTxnKind" not in js
          and "category: e.cat, amount: e.amt, note: 'Owed \u00b7 ' + p.name" in js
          and "if (editId) updateOwedEntry(pid, editId, payload);" in js
          and "function updateOwedEntry(pid, eid, data)" in js
          and "if (names.indexOf('Owed') < 0) names.push('Owed');" not in js)
    check("v72.33 (user: 'when i ask the bot how much i should prepay in just my maribank cc, it shows the total amount i should prepay (maribank cc and maya cc combined), i want it to show only the prepay amount for the card asked'): a prepay question about ONE card answers with that card's LIVE prepay — the overlay tracks the prepay delta per card (the card txn's account name rides in txnAdj, adj.prepayBy, a delta netting to zero is dropped), the effective snapshot recomputes each card's prepay as max(0, live balance − target balance) (target_balance rides in the snapshot cards; the stored card_util_target is the fallback for old snapshots), the local status rule shows the mentioned card's prepay line (no card mentioned = the total, as before), and the coach prompt carries the per-card breakdown plus the never-quote-the-total guidance",
          "if (t.kind === 'card_charge') return { cash: 0, free: amt, card: amt, prepay: amt, acc: t.account };" in js
          and "state.adj.prepayBy[a.acc] = r2((state.adj.prepayBy[a.acc] || 0) + a.prepay * sign);" in js
          and "target_balance: d.target_balance" in js
          and "var tb = (c.target_balance != null) ? Number(c.target_balance) : r2((Number(c.limit) || 0) * utilT);" in js
          and "var tb = (c.target_balance != null) ? Number(c.target_balance) : r2((Number(c.limit) || 0) * utilT);" in chatjs
          and "var ppCards = (e.cards || []).filter(function (c) { return mentionOf(c.name, t); });" in chatjs
          and "ppCards.forEach(function (c) { lines += kv(c.name + ' prepay', money(c.prepay || 0)); });" in chatjs
          and "quote that card" in chatjs and "never the total" in chatjs)
    check("v72.34 (user: 'v72.32 has no banners, still the old toast, with delayed appearance' — the phone was still serving a PRE-v72.32 cached shell: a refresh under the old worker's cache-first control loads the old shell while the new worker activates in the background, and the 'new version' banner only arrived after 'load' + the full precache): the update now LANDS on one refresh — the worker registers at script time (no more window 'load' wrapper) and the banner shows the moment updatefound fires (hiding itself if the worker turns redundant), and the page auto-reloads the instant the new worker takes control (controllerchange, guarded: only when there WAS a previous controller that changed — a fresh install never auto-reloads)",
          "var swInitialController = navigator.serviceWorker.controller;" in js
          and "navigator.serviceWorker.addEventListener('controllerchange'" in js
          and "showSwToast(); // v72.34: as early as possible (the precache still runs)" in js
          and "nw.state === 'redundant'" in js
          and "window.addEventListener('load'" not in js)
    check("v72.35 (user: 'look at the image, ive done what u said, fyi, since the version i told u to center that toast, it never happened in in newer versions'): the <style> block is BRACE-BALANCED (no stray top-level '}' / unclosed '{') — a dangling 'cursor:pointer;text-align:center}' tail left by the v21 sync-strip removal made the CSS parser swallow the NEXT rule (the #snack base rule) as an invalid qualified rule, so the snack never had its position/left/top/pill and rendered as plain flow text above the footer in EVERY version since Phase 1, no matter what the top-banner CSS said in the source (verified in a real Chromium CSSOM: the base #snack rule was absent while #snack.show survived)",
          "cursor:pointer;text-align:center}" not in css_no_comments(html)
          and css_brace_ok(html))
    check("v72.36 (user: 'return the undo button for all toasts'): every ACTION toast offers Undo — the add toast got its v71-removed Undo back (a QUIET remove: the entry, its money-log row and the account adjustment go together, no second toast) and the Imported toast snapshots everything the file could touch (base / txns / plans / owed / money-log / overlay / chat) BEFORE the first write, its Undo re-files that snapshot (imported rows out, snapshot rows in, state restored, snapshot re-derived from the base, persisted — the load path's own steps); the informational toasts ('Already in the book', 'Exported', 'Import failed') change nothing and carry no button",
          "esc(t.category || t.account), function () {" in js
          and "removeTxnQuiet(t.id);" in js
          and "var impPrev = {" in js
          and "impPrev.chat = cloneObj(chatRows || []);" in js
          and "function restoreImportSnapshot(prev) {" in js
          and "parts.length ? function () { restoreImportSnapshot(impPrev); } : null);" in js)
    check("the owed form's sections + ledger filing follow 'What happened' (v72.28 + follow-ups, user: the 4 directions, then 'maybe we should remove the ledger entries for i paid for them and they paid me back' — the settle-by-purchase offset double-counted — an interpretation edit — 'dont drop it anymore' the Account section + the tpf 'Unsorted' fallback): the ledger records CONSUMPTION, not loans — ONLY tpf files a ledger txn (Cash implicitly, the picked category from Your numbers' budgets with 'Unsorted' fallback, negative cash_out); ipf = Account + Note, itb and tmb = Account only, all three NEVER touch the ledger (a pure loan cycle nets to zero in cash; an offset lands in the tpf entry's true category; their account pick is stored on the entry informationally); existing entries adopt the rule ONLY on edit — the linked txn is rewritten in place (id + position kept), removed, or created fresh, and undo reverses it; NO migration of old entries; the owed balance still comes from the entry records",
          "function owedFormSections(form, dir)" in js
          and '<div class="oent-accrow">' in js and '<label>Account</label>' in js
          and "a.style.display = dir === 'tpf' ? 'none' : ''" in js
          and "c.style.display = dir === 'tpf' ? '' : 'none'" in js
          and "n.style.display = (dir === 'ipf' || dir === 'tpf') ? '' : 'none'" in js
          and "var doTxn = e.dir === 'tpf';" in js
          and "var doTxn = next.dir === 'tpf';" in js
          and "if (!cat) cat = 'Unsorted';" in js
          and "cat = e.cat || 'Unsorted';" in js
          and "date: e.d, account: 'Cash', kind: 'cash_out'," in js
          and "date: next.d, account: 'Cash', kind: 'cash_out'," in js
          and "category: e.cat, amount: e.amt, note: 'Owed \u00b7 ' + p.name" in js
          and "category: next.cat, amount: next.amt, note: 'Owed \u00b7 ' + p.name" in js
          and "owedFormSections(f, 'ipf')" in js
          and "owedFormSections(formEl, t.value)" in js
          and "owedFormSections(f3, ee.dir || 'ipf')" in js
          and "owedCatOptions: owedCatOptions" in js
          and '<select class="oent-cat">' in js
          and 'owedAccRowState' not in js)
    check("every owed entry row carries the edit button (v72.29, user: 'add edit button for all owed entries, including the old ones from old versions'): the v72.10 e.txnId condition is gone — legacy entries (no dir/cat/acc/txnId) edit through the same form, which falls back to ipf + today + empty acc/cat and files per the v72.28 rules on save (adopt on edit, no migration); the '· ledger' chip stays the filed-entries marker",
          "'<button type=\"button\" class=\"ow-xbtn wide\" data-ow-edit-e=\"' + esc(e.id) + '\" aria-label=\"Edit entry\">edit</button>'" in js
          and "(e.txnId ? '<button" not in js
          and "(e.txnId ? ' <span class=\"ow-led\"" in js
          and "owedPersonHTML: owedPersonHTML" in js)
    check("the owed edit expands in place (v72.29, user edit: 'when i edit an owed entry, i want the edit to expand in position'): the edit button inserts a prefilled oent-inline form right below that entry's row (Save changes + Cancel); the card-top form stays for '+ entry' adds; the person's name is tappable (data-ow-name → inline input; Enter/blur commits, empty keeps the old name, Escape cancels); Category + Account share one two-column row (oent-pair); the category options always carry 'Unsorted' (never lost when the budgets change) and a stale saved category is still appended",
          "function oentFormHTML(edit)" in js
          and "'<div class=\"oent-pair\">'" in js
          and "data-ow-edit-cancel=\"1\"" in js  # v72.30: the flag carries a value (valueless read '' = falsy → dead branch, Cancel looked broken)
          and "Save changes</button>" in js
          and "row.insertAdjacentHTML('afterend'" in js
          and "class=\"oent oent-inline\"" in js
          and "data-ow-name" in js
          and "'ow-name-in'" in js
          and "var list = names.slice();" in js
          and "if (list.indexOf('Unsorted') < 0) list.push('Unsorted');" in js
          and "if (d && list.indexOf(d) < 0) list.push(d);" in js)
    check("settings has the 'What's new in <version>' section (v72.29, user edit: 'add a section in settings on What's new with <version> containing plain word changes or updates of that version'): SHELL_NOTES holds the plain-wording changes per shell version; Settings shows the notes for the RUNNING version (SHELL_RELEASE.v), falling back to the closest older known version and hiding when nothing matches",
          "var SHELL_NOTES = {" in js
          and "function shellNotesFor(v)" in js
          and "function renderWhatNew()" in js
          and "renderWhatNew();" in js
          and 'id="wnSec"' in html and 'id="wnTitle"' in html and 'id="wnList"' in html)
    # v72.38: a release must ship its "What's new" note — v72.37 slipped and
    # Settings silently showed the previous version's notes. The running dot is
    # read from app.js itself, so the check self-updates (nothing to stamp).
    _rel = re.search(r"var SHELL_RELEASE = \{ v: (\d+\.\d+)", js)
    _run_v = _rel.group(1) if _rel else None
    check("SHELL_NOTES has a note for the RUNNING version (v72.38 gate: every release must ship its What's-new note — the running dot is read from app.js, so no stamp can drift)",
          _run_v is not None and ("'" + _run_v + "':") in js)
    check("v72.41 (user: 'write the x axis ticks as end of month, e.g. 30 Sep, 31 Oct, etc' + 'i wanna prepay maya cc and maribank cc separately'): (1) EVERY x-axis tick is a date — the month points sit on the last day of their month (the plotted value is that month-end projection), so the axis reads '6 Sep · 30 Sep · 31 Oct · … · 28 Feb'; the v72.37 start/middle/end special-case is gone (the compact month name stays only as the no-date fallback); (2) the Add sheet gains a direction — Spend (the old rules) vs Pay card (kind card_payment, the payoff that settles the owed balance — v72.42 corrected it to leave free untouched; a payoff must land on a CARD account, the first card is preselected, the title/button follow the mode, the deficit hint is off in payoff mode); (3) the coach's prepay action is ONE BUTTON PER card owed above its target (that card's live amount + account prefilled, Pay-card mode) — the combined button survives only as the no-per-card-breakdown fallback",
          "var lab = p.date ? dayMonth(p.date) : p.label;" in js
          and "function addSheetKind(mode, type, editingKind)" in js
          and "if (mode === 'prepay') return 'card_payment';" in js
          and "if (addMode === 'prepay' && type !== 'CARD')" in js
          and 'id="addModeSpend"' in html and 'id="addModePrepay"' in html and 'class="amrow"' in html
          and "data-prepaycard=\"" in js
          and "prefillAdd(cc.prepay, d.prepayDate" in js
          and "'CARD::' + cc.name, 'prepay');" in js
          and "addSheetKind: addSheetKind" in js)
    check("v72.42 (the payoff bug, user: 'fix the payoff bug and keep both numbers — floor stays on raw bank cash'): a card_payment settles the debt — it is NOT the exact inverse of card_charge (the charge already spent the free cash; the credit limit isn't money). The payoff drops the RAW liquid (adj.cash +a → effective total −a) and the owed/prepay, and leaves free UNTOUCHED (tuple free: 0, freeEffect → 0): a charge+payoff cycle nets free −amt and liquid −amt with owed 0 (the expense is real, the debt is settled) instead of erasing the expense; the money-log 'p' row renders free unchanged (before = f) while its card sub-line still shows the owed dropping; cash.free and cash.total stay separate and the liquidity floor keeps running on the raw cash.total",
          "if (t.kind === 'card_payment') return { cash: amt, free: 0, card: -amt, prepay: -amt, acc: t.account };" in js
          and "function freeEffect(kind, amt) { if (kind === 'card_payment') return 0; return (kind === 'cash_in') ? amt : -amt; }" in js
          and "var before = (e.k === 'p') ? r2(e.f)" in js)
    check("v72.43 (prepaid cards under the old model, user: 'ive already prepaid the cards prior to this version, as such, card balance and free cash and liquid cash all changed, fix that'): the persisted overlay is NOT re-derived from txns on boot, so a pre-v72.42 phone's stored adj still carries each old prepay's old-model contribution (free inflated by the prepay total, liquid not reduced); the one-shot migration (the adj.mv model stamp) adds the {cash: +a, free: +a} delta per card_payment on boot + import — but NOT for a prepay after which a balance-override (money-log 'a') row rebased the overlay (that prepay's effect is in the sheet's numbers, not the overlay); every zeroed/fresh adj (boot initializer, both rebases, computeAdjFromTxns, the import sanitizer) carries the stamp so it fires exactly once; card owed is untouched (identical in both models)",
          "var ADJ_MODEL_V = 2" in js
          and "function payoffModelDelta(txns, lastOverrideAt)" in js
          and "function migratePayoffModel()" in js
          and "migratePayoffModel(); // v72.43: one-shot re-derivation of a pre-v72.42 persisted overlay" in js
          and "if (hasSec('txns')) migratePayoffModel();" in js
          and "prepayBy: {}, mv: ADJ_MODEL_V" in js
          and "prepayBy: {}, mv: 2 }, // mv = the txnAdj model version (v72.43)" in js)
    check("v72.44 (user: 'the hey jan card disappered after i logged the prepay. also should we include the prepay in the ledger summary'): (1) the paid-prepay 'Handled' row of the home coach card read an undefined variable (prepaid instead of prepayPaid) — the ReferenceError was swallowed by emit's per-render try/catch AFTER the card was made visible, so the card rendered BLANK after a prepay was logged; (2) the spend aggregates (donut, pace, spent-today, pace anomalies, the coach-note snapshot) now use ONE rule — the same one the money-log 's' line has used since v72.10: card_payment is not spend (the charge already counted), cash_in nets spend down",
          "prepaid.amount" not in js
          and "money(Number(prepayPaid.amount) || 0) + ' logged on ' + planWhen(String(prepayPaid.date))" in js
          and "function spendOf(t) {" in js
          and "if (t.kind === 'card_payment') return 0;" in js
          and "if (t.kind === 'cash_in') return -a;" in js
          and "todaySpend += spendOf(t)" in js
          and "spentM += spendOf(t)" in js
          and js.count("var a = spendOf(t);") >= 2
          and "spent += spendOf(t)" in js
          and "spendOf: spendOf" in js
          and "F.spendOf(tn)" in chatjs
          and "if (e.k === 'p') freeTxt = ''" in js)  # (3) user edit: the prepay row shows only the card change, not the unchanged free line
    check("Owed + Ledger hide the old entries behind 'See more' (v72.29, user edit: 'in owed and ledger, when enrties are more than 5, hide the old ones in a see more which when clicked shows the next 5 old entries and another see more'): each person card renders only the first 5 rows (newest first) and a data-ow-more button reveals 5 older per tap (in-memory owedShown, resets on reload); the money log does the same (mlShownCount, resets on a filter change)",
          "var owedShown = {};" in js
          and "var limit = owedShown[p.id] || 5;" in js
          and "data-ow-more" in js
          and "owedShown[moreE] = (owedShown[moreE] || 5) + 5;" in js
          and "var mlShownCount = 5;" in js
          and "var limited = shown.slice(0, mlShownCount);" in js
          and 'id="mlMore"' in js
          and "mlShownCount += 5; renderMoneyLog();" in js
          and "mlFilterCat = mlf.value; mlShownCount = 5; renderMoneyLog();" in js)
    check("v72.30 (user, four items): (1) 'Owed' is out of the add-sheet categories (old ledger rows keep their data — no migration); (2) the owed in-place edit Cancel closes the form — the valueless flag attribute read '' (falsy) so the handler branch never fired, it carries a value now; (3) 'See less' beside 'See more' in Owed (data-ow-less; re-hides 5 per tap, floor = the first page of 5; hides itself there) and the Ledger (mlLess, same floor); (4) the account balance override: the account row's third column is labeled the current balance, and a saveBase that moves a debit/card account's value files the SIGNED diff as a moneyLog-ONLY row (no txn — the base rebase already zeroed the overlay, and the spend insights sum txns, so they can never be skewed) under category 'Adjustment' (k='a', f = the new effective free, o = the card owed after on card rows, no tid = an audit record corrected by the next override); 'snap' re-renders the ledger for this; the import sanitizer keeps the 'a' flavor",
          "function accountBalanceDiffs(oldB, newB)" in js
          and "function fileBalanceAdjustment(name, kind, diff)" in js
          and "accountBalanceDiffs(prevBase, state.base).forEach" in js
          and "l: 'Adjustment', c: 'Adjustment'" in js
          and "n: r2(diff), k: 'a'" in js
          and "set a balance to what it really is" in js
          and "var isAdj = e.k === 'a';" in js
          and "if (cardRow) freeTxt = ''" in js
          and "data-ow-edit-cancel=\"1\"" in js
          and "var lessE = t.getAttribute && t.getAttribute('data-ow-less');" in js
          and "owedShown[lessE] = Math.max(5, (owedShown[lessE] || 5) - 5);" in js
          and "ow-pag" in js and "ow-pag" in html
          and 'id="mlLess"' in js and "ml-pag" in js and "ml-pag" in html
          and "mlShownCount = Math.max(5, mlShownCount - 5);" in js
          and "names.push('Owed')" not in js
          and "prevTxn.category || 'Unsorted'" in js
          and "renderBaseStatus, renderCoachNote, seedCategories, renderMoneyLog]" in js)
    check("v72.31 (user: 'add x button in ledger for adjustment, it undoes the record in settings'): an Adjustment row (k='a') carries its own ✕ (data-adj-del = the row's moneyLog index) — it confirms, removes the audit record, and reverses the balance change it filed: the account's Settings value moves by the NEGATIVE of the row's signed diff through the base save with Adjustment-filing SUPPRESSED (deleting an audit record must not file a new one); the account gone from Settings → the row is simply deleted; the toast Undo restores row + value",
          "function findAdjAccount(name)" in js
          and "function askDeleteAdjustment(idx)" in js
          and "function deleteAdjustment(idx)" in js
          and "data-adj-del" in js
          and "var adjDel = isAdj ? " in js
          and "saveBase(state.base, { skipAdjustment: true })" in js
          and "if (!(opts && opts.skipAdjustment))" in js)
    check("the owed entry form shows only the trimmed labels (v72.27, user scratched the sub-texts out of a screenshot — 'remove the details i scratched'): 'Amount (₱)' without the 'number or quick sum' tail, 'Category' without 'where it lands in the ledger', no 'Filed in the ledger…' hint line, 'Note' without '(optional)'; the quick-sum input itself is unchanged (oent-amt + evalExpr); the v72.28 user edit kept the Account section (ipf/itb/tmb only)",
          '<label>Amount (\\u20b1)</label>' in js
          and '<label>Category</label>' in js
          and '<label>Note</label>' in js
          and '<label>Account</label>' in js
          and "number or quick sum" not in js
          and "how the money moved" not in js
          and '"note oent-acchint"' not in js
          and '<input type="text" class="oent-amt" maxlength="40" autocomplete="off">' in js)
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
    check("the bot flicks (v72.17, throw rebuilt in v72.24, bouncy feel removed in v72.26, user: 'remove the bouncy feel of the bubble'): the drag state tracks the last FINGER move sample's velocity; a fresh fast release (speed > 0.4px/ms, last move <80ms ago) launches a WAAPI THROW — fast launch to the 170ms-projection fly point, then a clean ease-out to the edge settle from the 420ms projection, landing EXACTLY there (v72.26: no squash, no stretch, no along-edge overshoot); duration scales with travel. Stale velocity, a slow drop, an open bubble or reduced motion keep the old snap+project+glide path (instant + panel re-anchor while open); grabbing the bot or a resize cancels the flight",
          "var FAB_FLICK_MS = 420, FAB_FLICK_MIN = 0.4, FAB_FLY_MS = 170, FAB_FLICK_STALE_MS = 80" in js
          and "st.vx = (ev.clientX - st.lastX) / dt" in js
          and "if (Date.now() - rel.lastT > FAB_FLICK_STALE_MS) { vx = 0; vy = 0; }" in js
          and "function fabFlickGeo(s, vw, vh, fromL, fromT, vx, vy)" in js
          and "sp > FAB_FLICK_MIN && !open && !fabReduceMotion() && fab.animate" in js
          and "fab.animate(kf, { duration: dur })" in js
          and "fabFlightCancel();" in js
          and "if (sp > FAB_FLICK_MIN) { cx += vx * FAB_FLICK_MS; cy += vy * FAB_FLICK_MS; }" in js
          and "fabFlickGeo: fabFlickGeo" in js
          and "'scale(0.93)'" not in js
          and "g.bounce" not in js)
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



