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
              "addEmpty",
              # v73.75: "projection"/"projBody"/"projAdj" REMOVED — the Money
              # tab's Projection card (and the overlay reset bar inside it) is
              # gone (boss-approved mockup_compact_livenumbers.html)
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
              "coachNoteBlock", "coachNoteBody", "coachNoteSub", "coachNoteRefresh",
              "donut", "donutSvg", "donutLegend", "donutRange",
              # v73.75: "pace"/"paceBox"/"paceNote"/"paceRange" REMOVED — the
              # Ledger tab's Spend-pace card is gone (its slot is the compact
              # Live-numbers card, #reconcile)
              "reconcile", "reconBar",
              "p_repeat", "p_count", "p_countWrap", "expJson", "expCsv",
              "planSheet", "planAddBtn", "planAddClose",
              "planEditSheet", "pe_name", "pe_amount", "pe_date", "pe_scope", "peSave", "peSkip", "peDeleteAll", "peClose",
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
    check("sw.js cache is v73 (dot releases v73.x per subtask)",
          "finances-pwa-v73" in sw and "finances-pwa-v72" not in sw)
    check("sw.js handles SKIP_WAITING", "'SKIP_WAITING'" in sw)
    check("shell cache holds the app scripts + manifest + icons (no model files)",
          "'./app.js'" in sw and "'./chat.js'" in sw and "'./ai.js'" in sw
          and "'./manifest.webmanifest'" in sw and "'./favicon.png'" in sw)
    check("sw.js: non-GET and cross-origin (coach) calls stay network-only",
          "url.origin !== self.location.origin" in sw and "req.method !== 'GET'" in sw)
    check("footer stamp: brand + shell v73 + live date/time, one source for both footers",
          "var SHELL_RELEASE = { v: 73" in js and "function shellStamp" in js
          and "'Fin.AI · shell v'" in js and 'id="setFoot"' in html
          and "byId('setFoot')" in js)
    check("service worker registration wired (page or app.js)",
          "serviceWorker.register" in html or "serviceWorker.register" in js)

    print("\n== home welcome + chart dates (v51) ==")
    check("welcome header: time-of-day greeting + full date, refreshed on tab show",
          'id="homeGreet"' in html and "function renderGreet" in js
          and "if (name === 'home') renderGreet();" in js and "renderGreet();" in js)
    check("sparkline x-axis shows dates (v51; v73.57: every tick is a real event date - the monthShort month points are dead)",
          "function dayMonth" in js and 'label: dayMonth(' in js
          and 'monthShort(row.month)' not in js)

    print("\n== v52: optional category, no emergency cap, slim placeholders ==")
    check("add-expense: category is optional (no required prompt)",
          "or choose Custom" not in js)
    check("emergency_cap fully removed from app + chat math",
          "emergency_cap" not in js and "emergency_cap" not in chatjs)
    check("example placeholders: only 'e.g. Jan' (your name) + 'e.g. Vhal' (owed person) + the v73.2 lesson pin ('e.g. cut food delivery')",
          'placeholder="e.g. Rent"' not in js
          and 'placeholder="optional"' not in html
          and 'placeholder="e.g. Jan"' in js
          and 'placeholder="e.g. Vhal"' in html
          and 'placeholder="e.g. cut food delivery"' in html
          and js.count('placeholder="e.g.') == 1
          and html.count('placeholder="e.g.') == 2)

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
    check("coach rows + hero/spark/donut renders",
          "function coachRows" in js and "function renderHero" in js
          and "function renderSpark" in js and "function renderDonut" in js
          and "function renderPace" not in js)  # v73.75: the Spend-pace card is gone
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
    check("v72.48 (user: 'allow to export a statemtn of account in pdf for each of the owed person entry, one soa per person'): each owed person's card exports a STATEMENT OF ACCOUNT as a PDF — one per person: chronological entries (date, description, signed amount, running balance) + the closing direction (owes you / you owe / settled); a hand-rolled PDF 1.4 writer (base-14 Helvetica, NO external library — the app stays offline) with pure soaRows/soaPdf the smoke verifies",
          "function soaRows" in js and "function soaPdf" in js
          and "function exportOwedSoa" in js and "data-ow-soa=" in js
          and "application/pdf" in js and "%PDF-1.4" in js and "%%EOF" in js
          and "jspdf" not in (js + chatjs + html + aijs))
    check("v72.49 (user: 'in owed tab in \"i paid for them\" and \"they paid for me\", add field for \"mine\", \"theirs\", \"total\" ... follow the same logic for \"they paid for me\"' + '-remove \"no account\" default is cash always' + 'T = the total for both of us; with no split, theirs or mine is filled, not total alone'): the SPLIT — Total = the total for BOTH (an aid that fills a missing share; TOTAL ALONE is not an entry → alert in both directions); a no-split entry = the single share (ipf: theirs, tpf: yours — the old behavior, no migration). YOURS always files to the ledger (ipf on the picked account — Cash cash_out / card card_charge, the Add-sheet rule — under the picked Category, now shown for ipf; tpf on Cash as before); the owed entry carries the debt side: ipf = THEIRS, tpf = YOURS (user-confirmed: the debt is your share; theirs in tpf is reference-only, never recorded); all three require Total = yours + theirs (±0.01); tpf theirs-only → alert; the 'no account' option is GONE (Cash is always the default, so the ipf mine part always files); an edit that would zero the owed part is blocked; legacy payloads (amt only) keep the old reading",
          "function owedSplit(dir, T, M, Th)" in js
          and 'class="oent-mine"' in js and 'class="oent-theirs"' in js
          and "Mine (\\u20b1)" in js and "Theirs (\\u20b1)" in js and "Total (\\u20b1)" in js
          and "Fill in yours, theirs, or the total for both." in js
          and "The total alone is for both of you" in js
          and "Total must equal yours + theirs" in js
          and "A part cannot be bigger than the total." in js
          and "no account (note only)" not in js
          and "var ledger = isSplitDir ? ((dir === 'tpf') ? owed : mine) : 0;" in js
          and "tData.account = acc.split('::').pop() || 'Cash';" in js
          and "tData.kind = isCard ? 'card_charge' : 'cash_out';" in js
          and "ledger: (nextDir === 'tpf') ? r2(data.amt) : 0, err: ''" in js
          and "owedSplit: owedSplit" in js)
    check("v72.51 (user bug: 'when ipf, total of 1000 and theirs is 200, my part is not written in ledger'): the v72.49 T+Th gap — Total + Theirs filled, Mine left blank: owedSplit derived yours = total − theirs, but the writers re-read the RAW typed mine (0) and silently filed NOTHING (no txn, no money-log row, no account move); the form's raw-parts path was never smoke-driven (v72.49 exercised only the pure table + all-parts payloads). The derivation now lives in the writers: addOwedEntry derives the ipf mine before the ledger math (fixes the filed txn + the stored e.mine), updateOwedEntry files split.ledger (owedSplit's derived part, not the raw mine) and stores it as e.mine; the row hint + the edit prefill derive the part for PRE-FIX entries (total + amt(theirs), no mine stored) so old data reads right and an edit keeps the split",
          "if (dir === 'ipf' && !(mine > 0) && total > 0 && theirs > 0) mine = r2(total - theirs);" in js
          and "var ledger = isSplitDir ? split.ledger : 0;" in js
          and "if (nextDir === 'ipf' && ledger > 0) e.mine = ledger;" in js
          and "var ipfMine = Number(e.mine) || (e.dir === 'ipf' && e.total && Number(e.total) > (Number(e.amt) || 0) ? r2(e.total - (Number(e.amt) || 0)) : 0);" in js
          and "var preIpFMine = (preDir === 'ipf') ? (Number(ee.mine) || (ee.total && Number(ee.total) > (Number(ee.amt) || 0) ? r2(ee.total - (Number(ee.amt) || 0)) : 0)) : 0;" in js
          and "'72.51': [" in js)
    check("v72.52 (user: 'i want the stats in the ledger tab to consolidate records per cycle, not per month'): the Ledger tab's stat cards bucket by the CURRENT SALARY CYCLE (the v72.45 window anchored on the salary_day) instead of the calendar month — a record dated the 1st lands in the cycle that started on the 15th, and the cycle's own salary cash_in is excluded from the spend (the v72.45 rule, via cycleDataFor's received id). The donut filters txns by the cycle window (w.start..min(w.end, today)) and its heading carries the cycle's date range (cycleLabelFor). v73.75 retarget: the Spend-pace card (and its cycleDataFor-driven lines) is GONE — the donut is the Ledger tab's only stat card now",
          "function cycleLabelFor(w) {" in js
          and "if (d < w.start || d > hi) return; // v72.52: the cycle window, not the calendar month" in js
          and "if (cd.received && t.id && t.id === cd.received.id) return; // the cycle's salary is income, not spend (the v72.45 rule)" in js
          and "var cd = cycleDataFor(currentCycleMonth(b, todayISO()), b);" in js
          and 'id="donutRange"' in html and 'id="paceRange"' not in html
          and 'This cycle · by category' in html
          and "'72.52': [" in js)
    check("v72.53 (user: 'add a loading screen for fin.ai' — design C, coach + status ticker): the #boot overlay (Coach Fin's face via the #botFace symbol + name + cycling status line + INDETERMINATE bar — no fake percentages) is static HTML shown by default; hideBoot() fades it (.off class) when the first render lands on BOTH init() paths (IDB success + catch) and stops the ticker; a 4s safety timer in init() guarantees a stuck load can never trap the UI",
          'id="boot"' in html and 'id="bootStatus"' in html
          and ('<use href="#botFace"/>' in html.split('id="boot"', 1)[1].split('<div id="topbar"', 1)[0]
               or 'class="beyes"' in html.split('id="boot"', 1)[1].split('<div id="topbar"', 1)[0])  # v72.55: the face went inline so the pupils can dart
          and "waking up…" in html
          and "#boot.off{opacity:0;pointer-events:none}" in html
          and "animation:bootslide 1.1s ease-in-out infinite" in html
          and "function hideBoot() {" in js
          and "if (b) b.classList.add('off');" in js
          and "BOOT_MIN_MS - (Date.now() - bootT0)" in js  # the value itself is pinned by the v72.54/v72.55 checks
          and "function bootTicker() {" in js
          and "'waking up\\u2026', 'counting your numbers\\u2026', 'almost there\\u2026'" in js
          and "bootTicker();" in js and "setTimeout(hideBoot, 4000);" in js
          and "hideBoot(); // v72.53: the first render is in — the splash fades" in js
          and "hideBoot(); // v72.53: even a failed load must not trap the user on the splash" in js
          and "hideBoot: hideBoot" in js and "bootTicker: bootTicker" in js
          and "'72.53': [" in js)
    check("v72.54 (user: 'how bout 1sec' — the splash was a flicker on a warm boot): hideBoot holds the overlay for a minimum display time (BOOT_MIN_MS) before the fade, so a fast boot still shows the coach; slow boots are unaffected (the floor only extends, never shortens)",
          "var bootT0 = Date.now();" in js
          and "'72.54': [" in js
          and "bootNow: function () { return Date.now() - bootT0; }" in js)
    check("v72.55 (user: 'what if i make it 3 seconds, i only ever open it a few times a day tho? and can we make coach fins eyes move during boot'): the splash floor goes 1s -> 3s (BOOT_MIN_MS; v73.7 trimmed it to 2s — pinned there) and Coach Fin's pupils dart around during the splash — the splash face is an INLINE copy of #botFace (a <use> shadow tree can't be animated from here) with the two pupils in one .beyes group on a CSS keyframe loop that STOPS on the .off fade (and under prefers-reduced-motion)",
          "var BOOT_MIN_MS = 1500;" in js  # v73.8: 2000 -> 1500 (user: 'boot screen change to 1.5 now from 2')
          and "'72.55': [" in js
          and "class=\"beyes\"" in html
          and "#boot .bface svg .beyes{animation:bootlook 3.4s ease-in-out infinite}" in html
          and "#boot.off .bface svg .beyes{animation:none}" in html
          and "@keyframes bootlook{" in html
          and "#boot .bface svg .beyes{animation:none}" in html  # the reduced-motion kill
          and html.split('id="boot"', 1)[1].split('<div id="topbar"', 1)[0].count('cx="27.2"') == 1  # the inline face carries the real pupil geometry
          and html.split('id="boot"', 1)[1].split('<div id="topbar"', 1)[0].count('cx="39.2"') == 1)
    check("v72.56 (user: 'can we add that moving eyes in all icons of coach fin inside the app?'): the darting eyes live INSIDE the #botFace symbol (SMIL animateTransform — page CSS can't reach a <use> shadow tree, but SMIL is cloned into every instance), so the coach note avatar, chat avatar and FAB all dart on the same 3.4s cadence as the splash; SMIL can't honor prefers-reduced-motion natively, so init() strips the animateTransform from the symbol (the shadow trees live-sync, so all instances go still)",
          html.count('<use href="#botFace"/>') == 3  # the three in-app faces
          and "<g class=\"beyes\">" in html.split('id="botFace"', 1)[1].split('</symbol>', 1)[0]
          and "animateTransform" in html.split('id="botFace"', 1)[1].split('</symbol>', 1)[0]
          and 'dur="3.4s"' in html.split('id="botFace"', 1)[1].split('</symbol>', 1)[0]
          and "matchMedia('(prefers-reduced-motion: reduce)').matches" in js
          and "document.querySelector('#botFace animateTransform')" in js
          and "if (sym) sym.parentNode.removeChild(sym);" in js
          and "'72.56': [" in js)
    check("v73.0 (user: 'do all them' — the major upgrade, release 1 of 4): Coach Fin has a MOOD — worried brows + happy closed-eye arcs live inside the #botFace symbol (display:none by default); renderMood() flips display on the symbol's light-DOM children so the <use> shadow clones live-sync (all three in-app faces change together); the mood is decided by computeMood() (a card over 70% of its limit, or the current salary cycle projected to end negative -> worried; a good moment — salary logged / card prepaid — flashes happy for a beat); renderMood rides every RENDER_BY_KEY data key; the hero free-cash number counts up from its PREVIOUS value and the sparkline marks today with a halo",
          '<g class="mood-worried" style="display:none">' in html
          and '<g class="mood-happy" style="display:none">' in html
          and html.split('id="botFace"', 1)[1].split('</symbol>', 1)[0].count('mood-worried') == 1
          and html.split('id="botFace"', 1)[1].split('</symbol>', 1)[0].count('mood-happy') == 1
          and "function computeMood() {" in js
          and "function renderMood(force) {" in js
          and "function happyMoodFlash(ms) {" in js
          # v73.5: the flip is via style.display, NOT setAttribute('display') —
          # the groups carry an inline style="display:none" and inline styles
          # beat the SVG presentation attribute in the cascade, so the attr
          # flip (v73.0) was a no-op and the moods never rendered on a phone.
          and "w.style.display = m === 'worried' ? '' : 'none'" in js
          and "h.style.display = m === 'happy' ? '' : 'none'" in js
          and "if (readUtilMax() > 70) return 'worried';" in js
          and "if (c && c.projectedNet < 0) return 'worried';" in js
          # v73.33: renderRecap left every key, so the "renderMood, render*"
          # count is now 1 (txn: …renderMood, renderPlans]) — the plan key is
          # the only one still ending in bare "renderMood]".
          and js.count("renderMood, renderPlans, reconRender]") == 1  # v73.73: the txn key gains the Reconcile render
          and js.count("renderMood, reconRender]") == 3  # v73.74: snap/adj/ui ALSO end in reconRender — the boot path emits 'ui' (setTab emits nothing), so the Reconcile card must repaint on ui or it never appears at boot (the boss's phone: v73.73 shell, card invisible); a base save (snap) or a reconcile save (adj) must repaint it too
          and "if (!editId && (kind === 'cash_in' || kind === 'card_payment')) happyMoodFlash(1800);" in js
          and 'class="spark-today"' in js
          and "'73.0': [" in js)
    check("v73.1 (user: 'do all them' — the major upgrade, release 2 of 4): the RECURRING ENGINE — plans repeat monthly | weekly | annual (the form's checkbox became a select; addPlan's monthly-only guard became an allow-list; planOccurrences grows shiftWeek/shiftYear: weekly projects 8 ahead, annual 2, monthly keeps the v68 3); the detector is a PURE exported fn (detectRecurring — the smoke drives it with seeded ledgers) that keeps the v68 core (same merchant key + amount in >=2 months over the last 3, already-planned out) and grows a brain: category fallback for unlabeled txns, a +/-5% amount band (was +/-10%), and day-gap cadence (median 6-8d -> weekly); the coach row + make-plan action + the chat chip all carry the detector's repeat",
          "<select id=\"p_repeat\">" in html
          and "<option value=\"weekly\">Every week</option>" in html
          and "<option value=\"annual\">Every year</option>" in html
          and "function shiftWeek(iso, k) {" in js
          and "function shiftYear(iso, k) {" in js
          and "function detectRecurring(txns, plans, todayISOStr) {" in js
          and "var recurringGuess = detectRecurring(state.txns, state.plans, today);" in js
          and "var rep = ['daily', 'weekly', 'monthly', 'annual'].indexOf(data.repeat) >= 0 ? data.repeat : null;" in js  # v73.14: daily joined the allow-list
          and "if (med >= 6 && med <= 8) rep = 'weekly';" in js
          and "detectRecurring: detectRecurring" in js
          and "planOccurrences: planOccurrences" in js
          and "repeat: parts[2] || 'monthly'" in js
          and "'73.1': [" in js)
    check("v73.2 (user: 'do all them' — the major upgrade, release 3 of 4): the MONEY PULSE — Home opens with last month in one card (in vs out split bar, top-3 spends, the coach's deterministic one-liner, the pinned lesson) and tapping it opens the full recap sheet (#recapSheet) where a LESSON can be pinned for next month (localStorage, keyed by month — readLesson/pinLesson); the DUE-DAY RADAR: a 'coming due' strip on Home shows the next 14 days of plan occurrences + the card prepay (renderDueStrip), and a card between 30% and 70% of its limit gets a coach nudge (over 70% is the v73.0 worried face); recapData is a PURE exported fn (the smoke drives it with a seeded ledger — in = cash_in, out = spend per the v72.44 rule, card_payment is not spend)",
          # v73.33: the HOME recap card is GONE (boss: 'remove the recap card
          # on home') — the sheet + lesson pin stand alone, so the card's ids
          # are asserted absent now
          'id="recap"' not in html and 'id="recapBody"' not in html and 'id="recapOpen"' not in html
          and 'id="recapSheet"' in html and 'id="recapLesson"' in html and 'id="recapPin"' in html
          and "function recapData(txns, month, plans) {" in js
          and "function renderRecap() {" in js
          # v73.14: the due strip was REMOVED (Home slim) — the pin now asserts its absence
          and 'id="dueStrip"' not in html and "function renderDueStrip() {" not in js
          and "function pinLesson(month, text) {" in js
          and "function readLesson(month) {" in js
          and "recapData: recapData" in js and "pinLesson: pinLesson" in js and "readLesson: readLesson" in js
          # v73.23: the 30% nudge guard line was removed with the nudge block — the v73.23 check asserts its absence
          # v73.14: the strip's 14-day window string left with the strip — the recap sheet pin stands in
          and "function openRecap() {" in js
          and "'73.2': [" in js)
    check("v73.14 (user: 'rename it to just Coming up' + 'the home tab is so full of info?' + the Fin AI backlog 'repeatable entries'): (1) the Money tab's 'Plans · coming up' heading is now 'Coming up'; (2) Home slim — the due strip is GONE (it previewed the Coming-up list two taps away) and the two AI cards are MERGED: the coach's note is the opening block (#coachNoteBlock) INSIDE the #coach card, so Home reads as one coach voice; (3) REPEATABLE ENTRIES — the repeat select gains 'daily', the form gains a count field (visible only when a repeat is picked; blank = the old window), the plan row carries count + overrides, and the 3-scope model (boss-confirmed) lands in resolveOccurrence: 'just this one' = an exact-date fork, 'this one and after' = applyFrom, 'all' = applyFrom at the series' first occurrence, skip hides the occurrence; (4) the per-occurrence edit sheet (#planEditSheet) — name/amount/date pre-filled from the RESOLVED occurrence + the scope select + skip-this-occurrence + explicit delete-whole-plan; forked dates wear an 'edited' pill; (5) the coach's math (insightsData week items + month plans + the Plan-due rows) reads RESOLVED occurrences, so forks and skips change what the coach says",
          '<h2>Coming up</h2>' in html and 'Plans · coming up' not in html
          and 'id="coachNoteBlock"' in html and 'id="coachNote"' not in html
          and 'id="dueStrip"' not in html and 'id="dueBody"' not in html
          and '.coachnote-block{' in html
          and '<option value="daily">Every day</option>' in html and 'id="p_count"' in html and 'id="p_countWrap"' in html
          and "function resolveOccurrence(p, dateISO) {" in js
          and "var cnt = Math.floor(Number(p.count));" in js
          and 'id="planEditSheet"' in html and 'id="pe_scope"' in html and 'id="peSkip"' in html and 'id="peDeleteAll"' in html
          and "function openPlanEdit(planId, dateISO) {" in js
          and "function savePlanOccurrence() {" in js and "function skipPlanOccurrence() {" in js
          and "data-editp" in js and "edited</span>" in js
          and "overrides: {}" in js
          and "'73.14': [" in js)
    check("v73.15 (user: 'the ui for coming up and the entries is so cluttered' — the mockup he approved): the Coming-up list renders SERIES, not projections — a recurring plan is ONE tappable row (name · 'Every <cadence> · next <date>' · count badge · amount 'each') that expands into occurrence sub-rows capped at 5 with '+N more…'; one-offs are plain rows with their own ✕; the 'recurring' pill is gone (the row IS the series), 'edited' survives on the head (any fork) and on the specific sub-row; the ✕ foot-gun left the list for series (delete-whole-plan lives in the edit sheet); the add form collapsed to the one-line '＋ Add a plan' trigger and now lives in #planSheet (bottom-sheet family); the v73.14 rows' unstyled .txn classes are replaced by the .plrow/.occ styles (the v18 ledger rework had deleted the old .txn CSS); the form's Amount label drops the '— number or quick sum' tail",
          'id="planSheet"' in html and 'id="planAddBtn"' in html and 'id="planAddClose"' in html
          and '＋ Add a plan' in html and '<h2>Coming up</h2>' in html
          and 'id="planForm"' in html and 'id="p_amount"' in html
          and "number or quick sum" not in html
          and ".plrow{" in html and ".occwrap{" in html and ".chev{" in html
          and "function planHTML(p, opts) {" in js
          and "var OCC_CAP = 5;" in js and "'+N more'" not in js
          and "data-grp=" in js and "planOpen[" in js
          and "class=\"plrow grp" in js and "class=\"plrow oneoff\"" in js
          and "data-delp" in js and "data-editp" in js
          and "openSheet('planSheet')" in js
          and "planHTML: planHTML" in js
          and "'73.15': [" in js)
    check("v73.17 (the plan-link chip — boss-approved): paying a plan is no longer a guess — the add form's fuzzy match (planLinkSuggestion, the findPaidTxn plan-branch rules as a pure pre-save function) offers a SUGGESTION chip; the boss's tap is the only thing that links (txn.planRef rides the record, so it syncs + survives reboots); findPaidTxn's plan branch reads the explicit link FIRST (deterministic — a linked payment can never be wrong-matched or missed), the fuzzy match stays as the fallback for old txns; the per-occurrence edit sheet shows its proof ('✓ Linked' vs 'Matched (auto-match)') with an Unlink that only breaks an explicit link (unlinkPlanTxn — the txn keeps its money); the chip's ref is dropped when it points at a dead occurrence (planRefAlive) but a saved link survives the fuzzy match drifting off",
          'id="planLinkChip"' in html and 'button.plchip' in html
          and "function planLinkSuggestion(payload, plans) {" in js
          and "function planRefAlive(ref) {" in js
          and "function unlinkPlanTxn(planId, dateISO) {" in js
          and "function updatePlanLinkChip() {" in js
          and "if (data.planRef) t.planRef = data.planRef;" in js
          and "t.planRef &&" in js and "String(t.planRef.planId) === String(kind.planId)" in js
          and "planId: p.id, date: od, name: nm, amount: am, dd: dd" in js
          and "planLinkSuggestion: planLinkSuggestion" in js
          and "unlinkPlanTxn: unlinkPlanTxn" in js
          and 'id="pePaidBy"' in html and 'id="peUnlink"' in html
          and "'73.17': [" in js)
    check("v73.20 (user: 'for card prepays in coach card, i wanted the design to be like that of the plans' + 'the chips in the plans are not clickable still' + rev 2: 'salary should be green its a good thing hehe, drop the due in salary due'): the PLAN-DUE design for every coach action row — the row is a plain list row (a div with data-digto) and the PILL CHIP on the right is the only button (prepay = red, plan due = severity-colored, salary = green); the v73.19 full-row dig-chip look is gone; the TAP FIX is structural — the row handler bails on e.target.closest('.rowchip') so the chip's tap is the chip's and the row's tap is the row's (no stopPropagation, no button-in-button); the salary row is cls 'ok' with tag 'Salary' (no 'due') and 'lands' copy",
          # the prepay/salary rows: plain row + the pill chip button (v73.23 added the nextCls var for next-cycle dimming)
          ("var nextCls = rw.nextCycle ? ' next' : '';" in js)
          and """'<div class="dig' + nextCls + ' ' + rw.cls + '" data-digto="money">'""" in js
          and """class="rowchip ' + rw.cls + '" data-' + rw.act + '="' + chipAttr(rw)""" in js
          # the plan-due chip wears the shared pill class (the design it gave)
          and """class="rowchip ' + rw.cls + ' plchip-inline" data-payplan=""" in js
          # the tap fix: the row handler bails on a chip tap
          and "if (e && e.target && e.target.closest && e.target.closest('.rowchip')) return;" in js
          # the v73.19 full-row-chip look is gone
          and "dig-chip" not in js and "dig.dig-chip" not in html
          # the salary row: green, tag "Salary", "lands" copy
          and "rows.push({ cls: 'ok', tag: 'Salary'," in js
          # v73.32: the amount is the TARGET cycle's (salT — today's or the
          # next payday's), not the current cycle's cy0.expected
          and "'Salary ' + money(salT.amt) + ' lands on the '" in js
          and "tag: 'Salary due'" not in js
          # the pill styling (severity variants)
          and ".rowchip{" in html and ".rowchip.warn{" in html and ".rowchip.bad{" in html
          and ".dig.ok{border-left-color:var(--ok)}" in html
          and "'73.20': [" in js)
    check("v73.21 (user: 'bump the tint to 5%' — the rowchip's hazy fill is a low-opacity tint of its own severity color; 12% read as a visible haze, 5% is barely-there): the .rowchip pill fill drops from rgba(...,.12) to rgba(...,.05) on all three severity variants (ok base, warn, bad); the border + text keep full severity color so the chip still reads red/amber/green",
          # the three severity variants now carry the 5% tint
          "background:rgba(55,211,155,.05);border:1px solid var(--ok)" in html
          and ".rowchip.warn{background:rgba(255,196,92,.05)" in html
          and ".rowchip.bad{background:rgba(255,107,107,.05)" in html
          # the 12% rowchip fills are gone (other .12 tints in the sheet are untouched)
          and ".rowchip.warn{background:rgba(255,196,92,.12)" not in html
          and ".rowchip.bad{background:rgba(255,107,107,.12)" not in html
          and "'73.21': [" in js)
    check("v73.22 (user: 'the plan rows still have unclickable chips' — the prepay/salary chips worked, the plan chips did not): v73.18 shipped the plan-chip handler ONLY as the window.FinApp export property, but the renderCoach wiring loop calls a BARE payPlanChip(...) — unresolvable in IIFE scope, so every plan-chip tap threw ReferenceError (the chip looked dead). The body now lives in scope as a real function; the export references it (the smoke's F.payPlanChip path is unchanged)",
          # the in-scope definition (the bare call in the wiring loop resolves)
          "function payPlanChip(attr) {" in js
          # the export references the in-scope function (no second inline copy)
          and "payPlanChip: payPlanChip," in js
          and "payPlanChip: function (attr)" not in js
          # the wiring loop still calls the bare identifier
          and "payPlanChip(b.getAttribute('data-payplan'));" in js
          and "'73.22': [" in js)
    check("v73.23 (boss-approved mockup: the coach card row redesign): (1) the prepay rows are renamed 'Prepay · <card>' (the 'Card' is dropped) and only show within 10 days BEFORE the prepay date (prepayWindow); (2) once the prepay date has passed, 'Card payment · <card>' rows take over for the 10 days AFTER (cardPayWindow, the card's live balance — the boss's Q1 answer: balance, not statement); (3) the plan window widens 7 -> 10 days; (4) the 30% util nudge row, the Salary-cycle/cycle-burn rows, and the 'Partly handled' prepay row are GONE (the per-card chip carries the live remainder); (5) the clutter fix = GROUPED sections — rows carry a group field and render under a tappable header (data-coachgrp) that folds/unfolds (coachGroupOpen), the header total is this-cycle-only; (6) a plan row whose due date lands in the NEXT salary cycle is flagged nextCycle -> dimmed + badged + a divider; (7) the 'On repeat' line is cycle-scoped (only recurring plans with unpaid occurrences in the current cycle, 'owed this cycle')",
          # (1) the prepay window + the renamed tag
          "var prepayWindow = d.prepayAmt > 0 && d.prepayIn >= 0 && d.prepayIn <= 10;" in js
          and "tag: 'Prepay · ' + c.name" in js
          and "Card prepay · " not in js
          # (2) the card-payment tag (the window moved to the DUE date in v73.24)
          and "tag: 'Card payment · ' + c.name" in js
          and "prepayDaysAgo: prepayDaysAgo, prepayAmt: prepayAmt," in js
          # (3) the plan window (v73.23: 7 -> 10 days; v73.27: the overdue
          # branch added for dd < 0; v73.68: the forward window is now
          # today..cycEnd — the 10-day line is DEAD, retargeted to the
          # cycle-window line below)
          and "if (u2.dd >= 0 ? (cycEnd ? u2.date <= cycEnd : u2.dd <= 20) : true) urgent.push(u2);" in js
          # (4) the removed rows are GONE (assert on the row-TEXT markers, not
          # the words — the words still appear in a comment + the SHELL_NOTES
          # copy, which is fine; the ROW code is what must be gone).
          # v73.26: the "Partly handled — " assertion is REMOVED — the plan
          # partial row (v73.26) reintroduces that text for PLANS (the prepay
          # "Partly handled" row is still gone; only the plan one is back).
          and "the 30% nudge" not in js
          and "Cycle burn" not in js
          # (5) the grouped render (the clutter fix)
          and "var coachGroupOpen = {}" in js
          and "data-coachgrp=" in js
          and "data-coachgrpbody=" in js
          and ".grp{" in html and ".grp-body{" in html
          # (6) the next-cycle distinction (dim + badge + divider)
          and "nextCycle: uNext" in js
          and "cyc-badge" in html and "cyc-div" in html
          and "Next cycle · from " in js
          # (7) the cycle-scoped 'On repeat' line
          and "owed this cycle." in js
          and "'73.23': [" in js)
    check("v73.24 (boss: 'the card payment dues on the 5th arent showing in the coach card rows'): the card-payment rows were keyed off the PREPAY date (the 30th) — they only appeared 1-10 days AFTER it, so on the 5th (when the bill is actually due) the coach card showed nothing. Now they follow the DUE date: cardPayWindow = cc.dueIn in [0,10], the row text says 'due <today/tomorrow/in N days>', the chip is dated at the due date, and the row is red when the due date is within 2 days (matching the prepay rows' urgency)",
          "var cc = d.ccDue;" in js
          and "var cardPayWindow = !prepayWindow && cc && cc.dueIn >= 0 && cc.dueIn <= 10;" in js
          and "var dueTxt = cc.dueIn === 0 ? 'today' : (cc.dueIn === 1 ? 'tomorrow' : 'in ' + cc.dueIn + ' days');" in js
          # v73.29: the row amount is the card's manual "due this cycle"
          # (c.due) when set, else the live balance — the string moved to a
          # local `amt`; the roll-over text is the new hasNext branch.
          # v73.31: `amt` is the manual due MINUS the card's own payment
          # logged after the cutoff (the statement window) — paying the due
          # drops the row; the roll-over (balance − amt) is next cycle.
          and "var manualDue = (c.due != null) ? Number(c.due) : null;" in js
          and "var amt = (manualDue != null) ? Math.max(0, manualDue - paid) : c.balance;" in js
          and "c.name + ' is at ' + money(amt) + ' due ' + dueTxt + ' — ' + money(nextBal) + ' rolls to next cycle.'" in js
          and "c.name + ' is at ' + money(amt) + ' — the bill is due ' + dueTxt + '.'" in js
          and "act: 'prepay', payload: { amount: amt, date: cc.dueDate, day: cc.due_day, card: c.name }" in js
          and "rows.push({ cls: cc.dueIn <= 2 ? 'bad' : 'warn', group: 'cards', kind: 'cardpay'" in js
          and "'73.24': [" in js)
    check("v73.25 (boss: 'collapse the coach card rows by default'): the grouped coach-card sections (Cards, Plans) now render COLLAPSED by default — the header shows the group label + this-cycle total + count, the body is hidden until the boss taps the header to expand. The fold state still lives in coachGroupOpen (re-renders keep the boss's choice); the default flipped from open (coachGroupOpen[g] !== false) to closed (coachGroupOpen[g] === true).",
          "var open = coachGroupOpen[g] === true; // v73.25: default CLOSED (boss: collapse by default)" in js
          and "'73.25': [" in js)
    check("v73.26 (boss-approved mockup: 'partial payments in plans'): the 50% single-entry plan threshold is replaced by ACCUMULATION — all txns matching an occurrence (±2 day window + name word, or an explicit planRef link) sum toward the plan amount, any positive amount counts, 100% = done. Coach card: 0 < sum < 100% gets a 'Partly handled' row (warn, yellow chip = live remainder, tap → Add sheet prefilled with the REMAINDER + pre-linked); sum ≥ 100% renders NO row (the v73.18 'Handled' row is gone — the Coming-up pill + edit sheet carry the proof). The 'On repeat' sub-line and the cycle plan deduction both run on the LIVE REMAINDER (plan amount − logged), so a partial payment shrinks them. findPaidTxn returns { amount: sum, date: last, count, linked } for plans; the pill reads the linked flag (a linked txn is the proof even when fuzzy entries sum in with it)",
          # (1) accumulation replaces the 50% single-entry threshold
          "if (amt >= 0.5 * pa && amt <= 2.5 * pa) out = t;" not in js
          and "var out = null, pSum = 0, pLast = null, pCount = 0;" in js
          and "pSum += amt; pLast = t; pCount++;" in js
          # (2) the explicit link counts regardless of amount (deterministic truth)
          and "if (linked && !out) out = t;" in js
          # (3) the plan row's three states: partial row / no row when done
          and "text: 'Partly handled — ' + money(paidAmt) + ' logged on '" in js
          and "r: money(rem) + ' left'" in js
          and "amount: rem }" in js
          and "text: 'Handled — '" not in js
          # (4) 'On repeat' + the cycle deduction run on the live remainder
          and "var rem = r2(Number(am) - (Number(pp && pp.amount) || 0));" in js
          # (5) the pill reads the linked flag
          and "var linked = !!paid.linked;" in js
          and "'73.26': [" in js)
    check("v73.27 (boss: 'if the plan is still not paid past due date, keep it showing'): an UNPAID plan occurrence that has passed its due date no longer vanishes — it shows as a red 'Overdue' row ('N days past due') and stays until paid (then it drops out like any handled one). The forward 10-day window is unchanged (due today..+10); the new branch is the overdue one (dd < 0, nothing logged). planAllDates() exposes the whole series (past + future) so past occurrences are reachable — planOccurrences() is a forward window (first >= today) and would never yield them. A partially paid overdue occurrence still shows the 'Partly handled' row (the partial state wins over the overdue one); a fully paid one renders no row. The chip is the same pay_plan action (prefilled + pre-linked).",
          # (1) the whole-series helper (past + future; planOccurrences is forward-only)
          "function planAllDates(p) {" in js
          # (2) the overdue occurrences are pulled in (dd < 0 stays, no
          # horizon) — v73.68 retarget: the forward side of the same
          # condition is now today..cycEnd (the 10-day window is dead)
          and "if (u2.dd >= 0 ? (cycEnd ? u2.date <= cycEnd : u2.dd <= 20) : true) urgent.push(u2);" in js
          and "(p.repeat ? planAllDates(p) : [String(p.date)])" in js
          # (3) the Overdue row (bad, 'N days past due', pay_plan chip)
          and "tag: 'Overdue'" in js
          and "' day' + (odays === 1 ? '' : 's') + ' past due.'" in js
          # (3b) SUPERSEDED by v73.56: the fuzzy window (±2 day AND the
          # overdue [due-2, +inf) widening) is GONE — an occurrence is paid
          # only by an explicit planRef link (the chip's tap). The v73.56
          # check pins the kill; see it below.
          and "if (dd > 2) return;" not in js
          and "if (dd < -2 && String(kind.date) >= (d && d.today || todayISO())) return;" not in js
          # (3c) the cycle deduction + 'On repeat' run on the WHOLE series
          # (planAllDates), so an overdue occurrence in the cycle still counts
          and "planAllDates(p).forEach(function (od) {" in js
          # (4) the forward window is unchanged (due today..+10)
          and "var pw2 = u.dd === 0 ? 'today' : (u.dd === 1 ? 'tomorrow' : 'in ' + u.dd + ' days');" in js
          and "'73.27': [" in js)
    check("v73.28 (boss: 'add an option to skip the plan due'): a SKIP chip on every plan-due / partly-handled / overdue row — a ONE-OFF skip (boss-confirmed): it writes the same exact-date skip-override the edit sheet's 'Skip this occurrence' button writes, so every existing consumer agrees for free (the coach row vanishes, the cycle deduction + 'On repeat' line drop it, the Coming-up list hides it, the next occurrence is untouched). Undoable from the snack (the override is deleted, the row returns). The chip is a real <button> inside the row's .dg-r span (the row stays a DIV — a <button> inside a <button> is invalid HTML5, the v73.18 rule).",
          # (1) the in-scope handler (the wiring loop calls the bare identifier)
          "function skipPlanChip(attr) {" in js
          # (2) the export references the in-scope function (no second inline copy)
          and "skipPlanChip: skipPlanChip," in js
          and "skipPlanChip: function (attr)" not in js
          # (3) the wiring loop (v73.58: the chip opens the skip/move
          # chooser — the skip path INSIDE is skipPlanChip verbatim; the
          # v73.58 pin asserts the chooser wiring)
          and "openSkipChooser(parts[0], parts[1]);" in js
          # (4) the chip renders on the pay_plan row (next to the pay chip)
          and "data-skipplan=" in js
          and "class=\"rowchip skipchip\"" in js
          # (5) the skip writes the SAME override shape the edit sheet uses
          # (v73.54: + skippedAt — the by-when record the plans list shows;
          #  v73.63: + was — the fork the skip sits on, restored on undo)
          and "ov[pdate] = { skip: true, skippedAt: Date.now(), was: prev };" in js
          # (6) the CSS (the quiet neutral pill)
          and ".skipchip{" in html
          # (7) the .dg-r becomes a flex row (pay chip + skip chip side by side)
          and ".dig .dg-r{flex:0 0 auto;font-weight:700;font-size:12.5px;color:var(--mut);white-space:nowrap;display:flex;align-items:center;gap:8px}" in html
          and "'73.28': [" in js)
    check("v73.29 (boss: 'the maya cc due on oct 5 is fully paid but a partial 1,080.30 still shows — move that to the next cycle'; 'the aribank due is 6,122.29 but the row shows more'): the card-payment row's amount is now the card's OWN manual 'due this cycle' (base account field `due`, set in the Accounts editor — a 5th card-only column) when it is set, else the live balance. The ledger can't derive the due (a prepay can exceed the logged charges, so the auto ccDue math returns 0), so the manual amount is the source of truth. Whatever balance sits ABOVE the due is the NEXT CYCLE's bill: it rides nextAmt (the row is still DUE NOW — it counts in the Cards total), is named in the row text, and the header sub-line surfaces it (money + ' next cycle').",
          # (1) the manual due field rides the snapshot card (null = auto)
          "due: c.due != null ? Number(c.due) : null" in js
          # (2) the row amount = the manual due when set, else the balance;
          # the roll-over (balance − amt) is the next-cycle amount.
          # v73.31: amt nets the card's own payment after the cutoff, so the
          # roll-over is balance − amt (before any payment amt = manualDue).
          and "var manualDue = (c.due != null) ? Number(c.due) : null;" in js
          and "var amt = (manualDue != null) ? Math.max(0, manualDue - paid) : c.balance;" in js
          and "var nextBal = (manualDue != null) ? r2(Math.max(0, c.balance - amt)) : 0;" in js
          # (3) the roll-over rides nextAmt + the roll-over text
          and "nextAmt: nextBal" in js
          and "rolls to next cycle.'" in js
          # (4) the Cards header sub-line surfaces the next-cycle roll-over
          and "bits.push(money(nextAmt) + ' next cycle');" in js
          # (5) the editor: the 5th card-only column + its read-back
          and "data-r=\"due\"" in js
          and "due: (kind === 'card' && di && String(di.value || '').trim() !== '') ? numVal(di, true) : null" in js
          and "'73.29': [" in js)
    check("v73.31 (boss: 'when i pay for the due only, the remaining 4k+ shows immediately in the row as if its also due in oct 5'): the manual 'due this cycle' was a STATIC target — paying it did not move it, so the row kept showing the full due AND the roll-over (balance − due) jumped in as if it were due now. Fix: net the card's OWN payment logged after the cutoff (the statement window — a payment after the cutoff pays THIS cycle's bill; a payment before it is a prepay already reflected in the manual due) off the manual due. Paying the due drops the row (amt = 0); a partial payment shows only the remainder. The roll-over becomes balance − amt (before any payment amt = manualDue, so the old formula holds).",
          # (1) the payment window: after the cutoff (cc.windowEnd)
          "var payAfter = cc.windowEnd;" in js
          # (2) the per-card payment sum (card_payment only, after the cutoff)
          and "if (dd <= payAfter) return; // before the cutoff = prepay (in the manual due)" in js
          and "paidBy[nm] = r2((paidBy[nm] || 0) + a);" in js
          # (3) the row amount = the manual due MINUS the paid amount
          and "var paid = (manualDue != null) ? r2(paidBy[c.name] || 0) : 0;" in js
          and "var amt = (manualDue != null) ? Math.max(0, manualDue - paid) : c.balance;" in js
          # (4) the roll-over = balance − amt (NOT balance − manualDue)
          and "var nextBal = (manualDue != null) ? r2(Math.max(0, c.balance - amt)) : 0;" in js
          and "'73.31': [" in js)
    check("v73.32 (boss: 'the salary row in coach card is not showing even if its within 10 days already, it should show up as early as the 5th since the salary is every 15th'): the row now targets the NEXT upcoming payday — a cycle STARTS on its payday, so the current cycle's payday is always on/before today and the old sIn <= 2 window could only ever fire on payday itself — and shows from 10 days out (the 5th for a 15th payday); same green row + chip look, the amount comes from the target cycle (its overrides apply)",
          # the old 2-day window is gone (it could only ever fire on payday itself)
          "sIn >= 0 && sIn <= 2" not in js
          # payday-today (unreceived) still shows immediately
          and "if (sIn === 0 && !cy0.received) {" in js
          # the next payday is computed from the current one + 1 month
          and "var nd = new Date(sp.getFullYear(), sp.getMonth() + 1, cy0.sday);" in js
          # the widened window: 1..10 days out
          and "if (sInN >= 1 && sInN <= 10) {" in js
          # the target cycle's own data (expected salary + received check)
          and "var cyN = cycleDataFor(nextISO.slice(0, 7), state.base);" in js
          and "if (cyN && cyN.expected > 0 && !cyN.received) {" in js
          # the row itself is unchanged (green, tag Salary, lands copy)
          and "rows.push({ cls: 'ok', tag: 'Salary'," in js
          and "'73.32': [" in js)
    check("v73.37 (boss: 'remove the plan due row in hero card for this cycle. keep it for the next cycle peek, and expandable to the specific plan dues'): the hero's CYCLE BLOCK — THIS cycle is now just the window + net (the old hero number: the Plans row is NOT rendered, the math still nets it out); the NEXT cycle peek KEEPS the Plans row and it is now a TAP TARGET that expands the specific plan dues as sub-rows (resolved amounts: a fork shows its forked value, paid/skipped never appear), capped at 5 with '+N more…'. The v73.36 carry-over math + the With/Without salary survival toggle stand; v73.35's card-dues removal stands; the coach card's cardpay rows keep their own manual-due math (v73.29/30/31)",
          # the block still lives in the hero (index) + the pure math (app)
          'id="cycleBlock"' in html and "renderCycleBlock();" in js
          and "function cycleProjection(mode, salMode) {" in js
          # the v73.34 window-aware dues helper is GONE (double-count removed)
          and "function cardDuesInWindow(cd, mode) {" not in js
          # the defaults: This cycle, no peek content, no salary toggle,
          # the plans expansion closed
          and "cycleMode: 'this'" in js and "peekMode: 'with'" in js
          and "cbPlansOpen: false" in js
          and "mode === 'next' ? 'next' : 'this'" in js
          # This cycle is ALWAYS with-salary (the Without mode is next-only)
          and "var withSal = (mode === 'this') ? true : (salMode !== 'without');" in js
          # the v73.36 carry-over math: carry = this cycle's net (free − this
          # window's plans); this net = carry; next net = carry + salary
          # (with/without) − next window's plans
          and "var thisNet = r2(free - planWindowTotal(thisCd).total);" in js
          and "var carry = (mode === 'next') ? thisNet : 0;" in js
          and "var net = (mode === 'this') ? thisNet : r2(carry + salAdded - planTotal);" in js
          # ONE helper computes both windows' plan totals + the breakdown
          # (the carry, the peek's deduction, and the expanded sub-rows all
          # come from the same items — no drift)
          and "function planWindowTotal(cd) {" in js
          and "items.push({ name: nm, date: od, amount: rem, edited: !!(ro && ro.edited) });" in js
          and "planItems: pw.items," in js
          # the OLD v73.35 next-cycle math (free + salary − plans, no carry)
          # is gone
          and "var net = (mode === 'this') ? r2(free - planTotal) : r2(free + salAdded - planTotal);" not in js
          # the render: the carry-over row is peek-only; the salary row is
          # GONE from the this-cycle block (only rendered inside the
          # mode === 'next' branch)
          and "Carried over<small>from this cycle" in js
          and "if (mode === 'next') {" in js
          and "the ' + ordinal(p.sday) + ' — in your free cash" not in js
          # v73.37: the THIS-cycle Plans row is GONE from the render (the
          # old non-expandable row markup — plain cbrow + 'Plans<small' —
          # is no longer emitted anywhere; the peek's row is cbplans)
          and "<div class=\"cbrow\"><div class=\"lab\">Plans<small>" not in js
          # v73.37: the peek's Plans row is the expandable tap target
          and 'id="cbPlansRow" role="button"' in js
          and "state.cbPlansOpen = !state.cbPlansOpen;" in js
          # the dues line item is gone from the block render
          and "Card dues<small>due in window</small>" not in js
          # the peek's toggle renders only in next mode
          and "(mode === 'next' ? '<div class=\"cbsegwrap\" id=\"cbSegSalaryWrap\"><div class=\"cbseg small\" id=\"cbSegSalary\"" in js
          # the hero sub is clean (the deduction line moved to the block) —
          # the EXACT old line is gone (the Free tile's own note is a
          # different string and stays)
          and "sub.push('− ' + money(d.planDeduct) + ' plans this cycle');" not in js
          and "cycleProjection: cycleProjection" in js
          and "'73.37': [" in js)
    check("v73.39 (boss: 'for the expanded plan dues, make the +x more... also expandable'): the peek's expanded Plans list — the '+N more…' row is now a TAP TARGET (cbPlansMoreRow, div[role=button], its own in-memory flag state.cbPlansMore defaulting collapsed): collapsed = first 5 items + the more-row; tapped = the FULL list (no cap, no more-row); tapped again = back to the 5-cap. The 5-cap slice now runs off a shown var (moreOpen ? items : items.slice(0,5)) and the old non-expandable more-row markup is gone",
          'id="cbPlansMoreRow" role="button"' in js
          and "state.cbPlansMore = !state.cbPlansMore;" in js
          and "cbPlansMore: false" in js
          and "var shown = moreOpen ? items : items.slice(0, 5);" in js
          and "shown.forEach(function (it) {" in js
          # the old static more-row (no id, not a tap target) is gone —
          # the single-quoted pin avoids the escaped-quote soup
          and '<div class="cbsub mut"><span class="sl">+' not in js
          and "'73.39': [" in js)
    check("v73.40 (boss: 'added new entries in ledger, hero free cash updated but Free at end of this cycle stayed old'): the cycle block's projection now reads the EFFECTIVE free (effectiveSnap — snapshot + the logged-ledger overlay) instead of the raw snapshot's cash.free, so 'Free at end of this cycle' moves the moment a ledger entry lands (the hero already did via insightsData → effectiveSnap; the block was the one straggler reading the stale base)",
          "var es = effectiveSnap();" in js
          and "var free = (es && es.cash) ? Number(es.cash.free) || 0 : 0;" in js
          # the old raw-snapshot read is gone
          and "var free = (state.snapshot && state.snapshot.cash) ? Number(state.snapshot.cash.free) || 0 : 0;" not in js
          and "'73.40': [" in js)
    check("v73.41 (boss: 'the plans in the money tab: the dates are not editable'): the occurrence edit sheet's date field is now WIRed — savePlanOccurrence reads pe_date and the scope decides how far the change reaches (this = move only that occurrence, following = shift the tail by the same days, all = re-anchor the series); the series is split into a raw template GRID (planGridDates) + a date-override resolver (planDateAt: move / accumulating shiftFrom-shiftDays), so a moved date lands where it belongs in the deduped+sorted list; a collision onto another occurrence's date is refused; a COUNTED series is now finite (N dates from the anchor, not N future dates forever); resolveOccurrence maps resolved dates back to grid-keyed overrides",
          "function planGridDates(p) {" in js
          and "function planDateAt(p, gridDateISO) {" in js
          and "var newDate = byId('pe_date').value || dateISO;" in js
          and "entry.move = newDate;" in js
          and "entry.shiftFrom = gridDate;" in js
          and "if (others[newDate]) {" in js
          and "planGridDates: planGridDates" in js and "planDateAt: planDateAt" in js
          and "todayISO: todayISO" in js
          and "savePlanOccurrence: savePlanOccurrence" in js
          and "'73.41': [" in js)
    check("v73.42 (boss: 'in money tab, reorder to: projection then coming up, remove the rest'): the summary tiles, Obligations card, and Sinking card are GONE (renderSummary/tile/renderObligations/renderSinking/ringSVG deleted, .tiles CSS cut); the obligations/sinking DATA is intact (snapshot + coach still read it). v73.75 retarget: the Projection card (and the #projAdj reset bar that lived inside it) is ALSO gone — the Money tab is just Coming up",
          'id="projAdj"' not in html
          and 'id="projection"' not in html
          and 'id="summary"' not in html
          and 'id="obligations"' not in html
          and 'id="sinking"' not in html
          and "function renderSummary" not in js
          and "function renderObligations" not in js
          and "function renderSinking" not in js
          and "function tile(" not in js
          and "function ringSVG(" not in js
          and 'class="tiles"' not in js
          and "function adjBar" in js  # v73.75: adjBar/resetAdj stay (exported; the smoke drives resetAdj) — the #projAdj host is gone
          and "snap: [renderCoach, renderInsights, seedAccounts, renderAddEmpty" in js)
    check("v73.44 (boss: 'move the oct15->nov14 below the this cycle, the date is not hidden by the toggle'): the cycle block's window label now sits BELOW the This/Next tag — .cbtitle is a column (flex-direction:column, align-items:flex-start) and .win lost its ellipsis, so on a narrow hero the toggle can no longer squeeze the dates",
          ".cbtitle{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0}" in html
          and ".cbtitle .win{color:var(--mut);font-size:12px;white-space:nowrap}" in html
          and "text-overflow:ellipsis" not in html.split(".cbtitle .win")[1].split("}")[0]
          and '<span class="win">' in js and "win + '</span></div>" in js
          and "'73.43': [" in js)
    check("v73.44 (boss: 'add the cards owed row and plan dues in this cycle, informational only — liquid deducted by the plans due and cards owed, then finally the free cash which should display the same amount as the big hero card number'): the THIS-cycle block renders the bridge rows Liquid / Cards owed / Other outflows / Plan dues / Free cash — the Free cash row is the hero's number (net = free − planShare, planShare = cyclePlanDeduction, one source), and Other outflows is the EXACT RESIDUAL (liquid − cardOwed − free) so the rows sum to the hero by construction (the overlay shifts free and liquid differently — card_charge moves free not liquid); the separate 'Free at end of this cycle' net line renders only for the peek now",
          'class="cbrow cbfree"' in js
          and "same as the hero number" in js
          and "var otherOut = r2(liquid - cardOwed - free);" in js
          and "var planShare = r2(cyclePlanDeduction());" in js
          and "planShare: planShare," in js and "otherOut: r2(otherOut)," in js
          and "mode === 'next' ? '<div class=\"cbnet\"><span class=\"nl\">Free at end of next cycle</span>" in js
          and ".cbrow.cbfree{margin-top:6px;padding-top:8px;border-top:1px solid var(--line)}" in html
          and "'73.44': [" in js)
    check("v73.45 (boss: 'build v73.45 — reset undo + confirm + audit row'): 'Reset to my numbers' is no longer a one-way door — (1) it opens confirmAsk naming the MEASURED free-cash move (rises/drops by ₱X, direction-aware — the move is measured by previewing the zeroed effectiveSnap, not derived from adj.free, because the overlay's net effect on free is a formula); (2) the confirmed reset files audit rows (k='r', category Adjustment, note 'reset to my numbers') in the money log — one per moved dimension, signed actual delta; (3) the toast carries an Undo that restores the pre-reset overlay AND removes the audit rows; (4) the root 1k-phantom fix: deleteTxn/saveTxnEdit no-op their overlay reversal when adjEmpty() (a reset already wiped it → no phantom delta); (5) the 'r' flavor survives imports (normalizeTxn) and its ✕ just drops the record (no override behind it to revert)",
          "var resetUndoState = null;" in js
          and "function resetAdj() {" in js and "confirmAsk('This makes ' + freeTxt + cardTxt" in js
          and "your free cash <b>rise by ' + money(dFree)" in js
          and "var preview = effectiveSnap();" in js and "state.adj = prev; // restore — the reset only happens on confirm" in js
          and "k: 'r'" in js and "reset to my numbers" in js
          and "var isAdj = e.k === 'a' || e.k === 'r';" in js
          and "if (!e || (e.k !== 'a' && e.k !== 'r')) return;" in js
          and "snackUndo" in js and "resetUndoState.rows.indexOf(x) < 0" in js
          and "function adjEmpty() {" in js
          and "if (!adjEmpty()) addAdj(txnAdj(t), -1);" in js
          and "if (!adjEmpty()) { addAdj(txnAdj(t), 1); addAdj(txnAdj(o), -1); }" in js
          and "e.k === 'a' || e.k === 'r') m.k = e.k;" in js
          and "adjEmpty: adjEmpty," in js and "resetAdj: resetAdj," in js
          and "'73.45': [" in js)
    check("v73.47 (boss: 'clicking to edit a plan, the x button doesnt work'): the edit sheet's ✕ handler was bound to #planEditClose — an id that does not exist in index.html (the button is #peClose) — so since v73.14 only a scrim tap closed the sheet; the binding now targets #peClose and the dead id is gone from app.js",
          'id="peClose"' in html
          and 'id="planEditClose"' not in html
          and "var peClose = byId('peClose');" in js
          and "byId('planEditClose')" not in js
          and "'73.47': [" in js)
    check("v73.49 (boss: 'i tried resetting live numbers, confirm and toast are there. but it didnt write in ledger'): the reset files its k='r' audit rows into state.moneyLog, but the 'adj' emit key never repainted renderMoneyLog — the rows existed in state yet the Ledger card stayed stale until an unrelated emit. renderMoneyLog is now on the 'adj' repaint list, so the audit rows show immediately on confirm (the smoke gate's old 'renders in the ledger' assertion called F.renderMoneyLog() BY HAND, which is why this wiring hole passed every gate)",
          "adj: [renderCoach, renderInsights, updateChargeHint, renderHero, renderCcCards, renderMoneyLog, renderCoachNote, renderMood, reconRender]," in js  # v73.75 retarget: renderProjection left the key with the card; v73.74: the adj key gained reconRender (a reconcile save zeroes the overlay — the card must repaint on 'adj'); v73.69: it grew renderCcCards
          and "'73.49': [" in js)
    check("v73.50 (boss: 'make the toast persist until swiped'): the snack banner's 7s auto-hide is gone — snack() no longer schedules setTimeout(hideSnack, 7000); the banner lives until the swipe-up release (the pointerup path calls hideSnack), Undo, or a newer toast replaces it. The `ms` parameter stays for call-compat but is ignored",
          "snackTimer = null;" in js
          and "setTimeout(hideSnack, ms || 7000)" not in js
          and "if (released <= thr) { clearTimeout(snackTimer); hideSnack(); }" in js
          and "hideSnack: hideSnack, // v73.50: the swipe-dismiss path (smoke drives it)" in js
          and "'73.50': [" in js)
    check("v73.51 (boss: 'if theyre delete toast, swipe to hide. if theyre add toasts, hide after 10s (unless swiped)'): snack() takes a kind — kind === 'add' schedules exactly one 10s auto-hide (swipe/Undo still beat the clock: the pointerup path clears snackTimer, and Undo's onclick does too); the default kind (delete/nudge/error) schedules NO timer and persists until swiped. The add toasts tagged 'add': new ledger entry, new plan, new owed",
          "function snack(msg, undoFn, kind) {" in js
          and "if (kind === 'add') snackTimer = setTimeout(hideSnack, 10000);" in js
          and "b.onclick = function () { clearTimeout(snackTimer); hideSnack(); undoFn(); };" in js
          and "}, 'add');" in js
          and "'73.51': [" in js)
    check("v73.52 (boss: 'when i log money in entry, i should be able to choose my cc accounts and that subtracts from my owed in that cc'): Money in on a CARD account is a PAYOFF — addSheetKind('moneyin'|'salary', 'CARD') = card_payment (owed − amt, free untouched, raw liquid − amt); on a cash account it is still cash_in. The Paid-with list is the SAME values in every mode (the pick survives a mode switch) — only the LABEL is mode-specific: in Money in the cards wear '· CC' so the payoff is legible. setAddMode re-seeds the list on every switch; the old 'Money in lands in a cash account' submit guard is gone; the deficit hint hides for a Money-in card pick (free is untouched — the hint would be a lie)",
          "if (mode === 'salary' || mode === 'moneyin') return type === 'CARD' ? 'card_payment' : 'cash_in';" in js
          and "var moneyin = addMode === 'moneyin';" in js
          and "esc(a.name + (a.type === 'card' && moneyin ? ' · CC' : ''))" in js
          and "seedAccounts();" in js.split("function setAddMode")[1].split("function prefillAdd")[0]
          and "seedAccounts: seedAccounts, // v73.52" in js
          and "setAddMode: setAddMode, // v73.52" in js
          and "if (rawAcc.indexOf('CARD::') === 0) { el.style.display = 'none'; return; }" in js
          and "alert('Money in lands in a cash account" not in js
          and "'73.52': [" in js)
    check("v73.53 (boss: 'the cc payoff i make using the money in tab doesnt charge to my liquid because its from a cashback'): a Money-in CC payoff can be flagged 'From cashback' (t.cashback) — NEW money: owed − amt, free + amt (the debt it erased), raw liquid UNTOUCHED, card balance − amt (utilization follows). The plain payoff keeps the v72.42 rule (raw − amt, free untouched). The flag rides the ledger row (undo's record, e.cb), survives import, is set/kept/cleared on edit, and the row's visibility follows the Paid-with pick (Money in + card only)",
          "if (t.cashback) return { cash: 0, free: -amt, card: -amt, prepay: -amt, acc: t.account };" in js
          and "if (t.kind === 'card_payment') t.cashback = !!data.cashback;" in js
          and "if (t.kind === 'card_payment' && t.cashback) e.cb = true;" in js
          and "if (e.cb === true) m.cb = true; // v73.53" in js
          and "var cbRow = e.k === 'p' && e.cb;" in js
          and "function updateCashbackRow() {" in js
          and "updateCashbackRow: updateCashbackRow, // v73.53" in js
          and 'id="f_cashback"' in html
          and 'id="cashbackRow"' in html
          and "if (kind === 'card_payment' && cbk && cbk.checked) payload.cashback = true;" in js
          and "function freeEffect(t, amt) { if (t.kind === 'card_payment') return t.cashback ? amt : 0;" in js
          and "'73.53': [" in js)
    check("v73.54 (boss: 'a label in the plans list whenever i skip a due, so i can unskip it later'): a skipped occurrence no longer vanishes from the plans list — it renders a RECORD row (the 'skipped' pill label + the ↺ button, both data-unskip) with the date it was skipped (skippedAt rides the override, stamped by both the coach SKIP chip and the edit sheet's skip button); tapping either removes the exact-date skip-override so the due returns to the coach card's plan due rows, the free-cash deduction, and the 'On repeat' line (all existing ro.skip consumers flip back); the series header counts its skips even when collapsed",
          # v73.63: both writers carry the `was` fork under the skip (the
          # undo restores it exactly) — the v73.54 shape pins retargeted.
          "ov[pdate] = { skip: true, skippedAt: Date.now(), was: prev };" in js
          and "ov[dateISO] = { skip: true, skippedAt: Date.now(), was: prev };" in js
          and "function unskipPlanOccurrence(planId, dateISO) {" in js
          # v73.63: the guard reads the resolved-keyed skip first, with a
          # grid-date fallback for legacy pre-v73.63 skips
          and "var kdate = ov[dateISO] && ov[dateISO].skip ? dateISO : planGridDateFor(p, dateISO);" in js
          and "skipped.push({ d: od, ro: ro });" in js
          # v73.59: the record row became a strikethrough CHIP in the history
          # strip — the unskip path rides data-unskip on the chip (the header
          # ↺ button keeps the v73.54 shape)
          and "x.skip ? ' data-unskip=\"' + p.id + '|' + x.d +" in js
          # v73.64: the header ↺ targets `firstSkip` (the earliest future
          # skip, or the most recent past one — the boss's Rent case)
          and "data-unskip=\"' + p.id + '|' + firstSkip +" in js
          and "skipTotal + ' skipped</span>'" in js
          and "if (this.tagName === 'SPAN') {" in js.split("function renderPlans")[1].split("function addPlan")[0]
          and "unskipPlanOccurrence: unskipPlanOccurrence, // v73.54" in js
          and "renderPlans: renderPlans, // v73.54" in js
          and "'73.54': [" in js)
    check("v73.55 (boss: 'after a plan occurrence is SKIPPED, the plan record is no longer editable nor deletable in the plans list'): the skip-override blocks nothing — the ✎ was rendered only when shown.length (skipping the next due emptied it, and v73.54's record rows made that state persistent) and the recurring header had NO ✕ at all (one-offs only). Now: the ✎ renders when shown OR skipped (targeting the skipped occurrence), the recurring header gains the plans-list ✕ (deletePlan already carried the Undo + tombstone), and the date-collision guard counts SKIPPED dates too (a skipped due moved onto another skipped date would collide in the lists)",
          # v73.64: the ✎ renders on `skipTotal` (past + future skips) and
          # targets `firstSkip` (the v73.55 `skipped.length`/`skipped[0]`
          # shape retargeted — past-only skips now keep the button too)
          "(shown.length || skipTotal ? '<button class=\"mini\" data-editp=\"' + p.id + '\" data-editd=\"' + (shown.length ? shown[0].d : firstSkip) + '\" title=\"Edit this occurrence\">✎</button>' : '')" in js
          and "'<button class=\"mini\" data-delp=\"' + p.id + '\" title=\"Delete plan\">✕</button>' + '</div>';" in js
          and "var r = planDateAt(p, g);" in js.split("collision: another occurrence")[1].split("if (others[newDate])")[0]
          and "'73.55': [" in js)
    check("v73.56 (boss: 'do 1' — kill the fuzzy match window, plus 'make the hero card this-cycle plan dues expandable just like next cycle'): (1) a plan occurrence is PAID ONLY by an explicit planRef link (the chip's tap) — the v73.26 name-word ±2-day branch and the v73.27 overdue [due-2, +inf) widening are GONE (the unbounded window had no floor, so previous months' payments or a logged matching amount summed toward the current occurrence and zeroed it — the due row vanished and the hero's free jumped back up by the full amount, the boss's 12k-rent incident); a payment logged without the chip simply doesn't count, the due row stays until the chip is tapped or the entry is edited and linked (the v73.17 design truth, now the ONLY truth); (2) the hero's THIS-cycle 'Plan dues' row is expandable exactly like the peek's — the v73.37/v73.39 machinery (cbPlansRow / cbPlansOpen / cbPlansMore) is shared: same id, same sub-rows from p.planItems, same '+N more…' second level, and the peek's expansion state follows the this-cycle row",
          # (1) the kill: no fuzzy branch left in findPaidTxn's plan path
          "if (!linked) return;" in js
          and "if (dd > 2) return;" not in js
          and "if (dd < -2 && String(kind.date) >= (d && d.today || todayISO())) return;" not in js
          and "var words = String(kind.name || '').toLowerCase().split" not in js
          # (1b) the link is still the deterministic match (unchanged)
          and "String(t.planRef.planId) === String(kind.planId) &&" in js
          # (2) the this-cycle row reuses the peek's expandable machinery
          and "var openThis = !!state.cbPlansOpen;" in js
          and "var itemsT = p.planItems || [];" in js
          and "var moreOpenT = !!state.cbPlansMore;" in js
          and "'73.56': [" in js)
    check("v73.57 (boss: 'limit it to 2months projection, and the deductions from dues reflects on the day when theyre due'): the hero graph is a 2-month STEP CHART of the live numbers - start = RAW cash (effectiveSnap.cash.total), step down on EVERY plan due on its due date (this month's included - the start is raw, so no double count), per-card card owed drops ONCE at its first payment due date in the window (the card's due day-of-month, DEFAULT 15 when unset - the owed is a stock: paying it zeroes the balance and unlogged charges are never predicted, so a second drop of the same owed would double-count), step up on the next payday; the v72.37/72.45 base-matrix plot path (raw 6-month running, monthShort month points, salDelta proration) is GONE; card drops read the LIVE owed (effectiveSnap cards - a charge grows the drop, a payoff shrinks it, a chip-paid or skipped due removes its drop)",
          # the step chart is built from the events, not the matrix
          "function sparkData()" in js
          and "var events = {};" in js
          and "planAllDates(p).forEach(function (od) {" in js
          and "if (ro && ro.skip) return;" in js
          and "var day0 = (c.due != null && c.due >= 1 && c.due <= 28) ? Math.round(c.due) : 15;" in js
          and "ev(salISO, expectedSalaryFor(" in js
          and "pts.push({ label: dayMonth(dISO), v: r2(pts[pts.length - 1].v + events[dISO]), date: dISO });" in js
          # the 2-month window (today -> end of the next 2 months)
          and "var lastM = addM(ty, tm, 2);" in js
          # the old 6-month matrix plot is dead
          and "s.matrix.base.forEach(function (row) {" not in js
          and "monthShort(row.month)" not in js
          and "salDelta" not in js
          and "'73.57': [" in js)
    check("v73.58 (boss: 'clicking the skip allows me to skip it entirely or move it to a later date in the calendar'): the coach's SKIP chip opens a skip/move CHOOSER dialog instead of skipping on the spot - 'Skip this occurrence' is skipPlanChip verbatim (the v73.28 override + its own toast Undo), 'Move to a later date' reveals a date input (min = day after the due, default = next same-day-of-month) and movePlanChip writes the v73.41 move-override ({ move: newDate } at the GRID date - the same shape savePlanOccurrence writes for a 'this' scope move) with the same collision rule (v73.55: skipped dates occupy their slot too); the moved due reappears on its new date everywhere (lists dedupe, hero deduction, peek, v73.57 graph drop) and the toast carries an Undo that restores the exact prior override",
          # the chooser dialog (index.html, same surface as #confirmDlg)
          'id="skipChooserDlg"' in html
          and 'id="scDate"' in html
          and 'id="scMove"' in html
          and "#skipChooserDlg.show{opacity:1;pointer-events:auto}" in html
          # the handlers
          and "function openSkipChooser(planId, dateISO) {" in js
          and "function movePlanChip(planId, dateISO, newDate) {" in js
          and "var mvEntry = { move: newDate };" in js  # v73.63: the move MERGES into the entry (carries the fork), no longer a bare replace
          # the chip now opens the chooser (the skip path inside is verbatim)
          and "openSkipChooser(parts[0], parts[1]);" in js
          and "skipPlanChip(c.planId + '|' + c.dateISO);" in js
          # the past-date guard + the collision rule
          and "Pick a date after " in js
          and "Another occurrence of this plan already falls on " in js
          # the exports (the smoke drives the chooser without a DOM)
          and "openSkipChooser: openSkipChooser," in js
          and "movePlanChip: movePlanChip," in js
          and "'73.58': [" in js)
    check("v73.59 (boss: 'redesign the plans in money tab, it becomes so cluttered' + 'i want the plans paid and past occurrences to still exist there' + 'make one offs also editable'): the plans list splits into Recurring / One-offs sections, each sorted by NEXT occurrence (a moved due re-orders the list - the old anchor-date sort never did); a recurring series' collapsed sub-line answers directly (cadence - next due - 'N paid' chip); the expanded state is the NEXT DUE emphasis row + a history CHIP STRIP where every past occurrence stays visible at 1/5 the space of the old full rows (paid = green tick, skipped = strikethrough carrying the v73.54 unskip path, past-due = red) with a '+N older' second level; one-offs are EDITABLE - the !p.repeat guard in openPlanEdit is lifted (scope select + skip button hide), and a one-off save writes name/amount/date straight onto the record (no override machinery - there is nothing to fork)",
          # the sections + the sort key (recurring = next occurrence, one-off = its date)
          "function planSortKey(p) {" in js
          # v73.60: the sections became the tab bar — the labels render from
          # the tab data-pltab markup (the old >Recurring< / >One-offs<
          # section-header strings moved into the tab bar)
          and 'data-pltab="one"' in js and 'data-pltab="rec"' in js
          and 'One-offs' in js and 'Recurring' in js
          # the collapsed sub-line's paid count
          and "paidCount + ' paid</span>'" in js
          # the expanded shape: NEXT DUE row + the history chip strip
          and 'NEXT DUE' in js
          and "hchip " in js and "data-histmore=" in js
          # the history strip's unskip path (the v73.54 record, now a chip)
          and "x.skip ? ' data-unskip=\"' + p.id + '|' + x.d +" in js
          # the CSS (the strip + the emphasis row)
          and ".hist-chips{" in html and ".plrow.next{" in html and ".hchip.skip{" in html
          # one-offs editable: the guard is lifted + the straight-write path
          and "if (!p) return;" in js.split("function openPlanEdit")[1].split("planEditCtx = { plan: p")[0]
          and "p.name = name;" in js.split("function savePlanOccurrence")[1].split("var ov = p.overrides")[0]
          and "planSortKey: planSortKey," in js
          and "'73.59': [" in js)
    check("v73.60 (boss: 'lets separate them thru a tab, left tab is oneoffs, right is recurring' + 'Ship it as v73.60 (one-offs default default)'): the v73.59 stacked sections become a TAB BAR - One-offs LEFT, Recurring RIGHT, counts ride the tabs, ONE-OFFS is the default tab (planTab='one'); pure layout over the v73.59 renderer - both lists always exist, nothing hidden or filtered, the tab is in-memory view state",
          # the tab bar markup + the default tab
          "var planTab = 'one'" in js
          and 'data-pltab="one"' in js and 'data-pltab="rec"' in js
          and "planTab === 'one' ? ' on' : ''" in js
          # the tab click handler + the pane switch
          and "planTab = this.getAttribute('data-pltab');" in js
          and "planTab === 'one'" in js.split("function renderPlans")[1].split("function addPlan")[0]
          # the CSS
          and ".pltabs{" in html and ".pltab.on{" in html and ".plcnt{" in html
          # the export (the smoke drives the tab without a DOM)
          and "setPlanTab: function (t) { planTab = (t === 'rec') ? 'rec' : 'one'; }," in js
          and "'73.60': [" in js)
    check("v73.61 (boss: 'the recurring Rent stops showing as a plan due row once it is a day PAST its due date' + 'should we only fast forward when i actually skipped (not moved) or have already fully paid the current due?' + 'what if the move is on a date before the next occurence, why should the series fast forward if the count is still the same'): the blind fast-forward in planGridDates (advance a count-less series past EVERY date below today) is GONE - it dropped a past-due occurrence off the grid the day after its due, so the v73.27 overdue row, the hero deduction, the graph, and the peek all went blind (the boss's recurring Rent vanishing). The advance is now STATE-AWARE, one occurrence at a time: skipped -> advance; fully planRef-paid -> advance (a PARTIAL payment does NOT advance); moved to the future -> advance BUT the moved date is pushed into the window (a move is a relocation, not a resolution - the grid slot must not orphan the override); moved to the past or unpaid -> STAY (the overdue row keeps it)",
          # the state-aware advance (the blind loop is gone) — the inline
          # override read (eS = exact, bestS = latest applyFrom) is what
          # feeds skip/amount/name/move, NOT resolveOccurrence (its
          # grid-mapping fallback calls planGridDates -> recursion)
          "while (start < today && guard < 730) {" in js
          # v73.64: the skip branch now KEEPS the resolved date in the
          # window (a relocation, not a deletion) — the v73.61 single-line
          # advance retargeted to the new block
          and "if (eR && eR.skip) {\n          var sRes = planDateAt(p, start);" in js
          and "var fullyPaid = amv > 0 && (Number(pp && pp.amount) || 0) >= amv;" in js
          and "if (fullyPaid) { start = step(start, 1); guard++; continue; }" in js
          and "var mv = eS && eS.move ? eS.move : null;" in js
          and "if (String(mv) < today) break;" in js
          and "if (out.indexOf(mvRes) < 0) out.push(mvRes);" in js
          and "break; // unpaid (or partly paid) past due — the series stops here" in js
          # the v73.41 blind loop is GONE (the unconditional advance)
          and "while (start < today && guard < 730) { start = step(start, 1); guard++; }" not in js
          and "'73.61': [" in js)
    check("v73.62 (boss: 'Partial chips: tick + 7,364/13,394 vs amber partial style' — the v73.59 history chip marked ANY linked payment as fully paid on a truthiness check and printed the occurrence amount next to the tick; the boss's Rent showed '✓ 13,394' on a 7,364 partial): the chip (and the next-due pill) is now a COMPARISON — paid = the planRef sum covers the occurrence amount (the coach's >= 100% rule), and a partial renders AMBER with the paid sum over the due ('◐ 7,364/13,394'), never a green tick; the 'N paid' header count is full-pays only",
          # the comparison (the truthiness is gone)
          "var full = pAmt >= (ro ? ro.amount : p.amount) - 0.005;" in js
          and "partial: !full && pAmt > 0, paidAmt: pAmt, amount: ro ? ro.amount : p.amount" in js
          # the amber partial chip + the paid/due text
          and "x.partial ? ' ◐' : ''" in js
          and "amt(x.paidAmt) + '/' + amt(x.amount)" in js
          and "x.paid ? 'paid' : (x.partial ? 'partial' : 'late')" in js
          # the next-due pill's partial branch (same hole, same fix)
          and "if (pAmt < (Number(amount) || 0) - 0.005) {" in js
          and "pill occ-paid partial" in js
          # the CSS (both surfaces)
          and ".hchip.partial{" in html and ".occ-paid.partial{" in html
          # the v73.59 truthiness is GONE
          and "paid: !!paid, amount: ro ? ro.amount : p.amount" not in js
          and "'73.62': [" in js)
    check("v73.63 (boss: 'i skipped the 6,030 partly-handled Rent, undid the skip, it did NOT return to the due rows' + 'why didnt skipping the one-offs affect free cash' + the 10k one-off test): three fixes in one. (a) a skip CLOBBERED the fork it landed on — the undo's bare delete left the occurrence at its base amount (overpaid -> the row never returned); the skip now carries the prior entry under `was` and the undo restores it exactly (skipPlanChip/skipPlanOccurrence/unskipPlanOccurrence). (b) a skip on a MOVED due was orphaned (the slot is off the grid) — skips now key at the RESOLVED date, where the grid's advance loop and the consumers actually see it; the shared planGridDateFor helper (resolved->grid, one-off = its own date) is used by movePlanChip and by unskip's legacy fallback. (c) one-off skips never touched the cycle deduction (the p.repeat-ternary gate) — one-offs now resolve in cyclePlanDeduction/planWindowTotal/coachRows/planWhen/monthPlanTotal/planRefAlive, so a skipped one-off raises free on skip and drops it back on undo, and a skipped one-off renders the v73.54 record pill + unskip path in the plans list",
          # (a) the `was` carry (skip must not clobber the fork) — both writers
          "var prev = ov[pdate] || null; // the fork (name/amount) rides under the skip" in js
          and "ov[pdate] = { skip: true, skippedAt: Date.now(), was: prev };" in js
          and "if (prev) ov[pdate] = prev; else delete ov[pdate];" in js
          and "var prev = ov[dateISO] || null;" in js
          and "ov[dateISO] = { skip: true, skippedAt: Date.now(), was: prev };" in js
          and "if (prev) ov[dateISO] = prev; else delete ov[dateISO];" in js
          # (b) the shared resolved->grid map + its users (skips key at the
          # RESOLVED date — after a move the slot is off the grid, so a
          # grid-keyed skip would be orphaned; unskip keeps a grid-date
          # fallback for legacy pre-v73.63 skips)
          and "function planGridDateFor(p, dateISO) {" in js
          and "if (!p.repeat) return String(p.date); // one-off: the single date IS the grid" in js
          and "var gridDate = planGridDateFor(p, dateISO);" in js
          and "var kdate = ov[dateISO] && ov[dateISO].skip ? dateISO : planGridDateFor(p, dateISO);" in js
          and "var gdate = planGridDateFor(p, pdate);" not in js
          # (c) one-offs resolve (the p.repeat gate is gone from the deduction)
          and "var ro = resolveOccurrence(p, od); // v73.63: one-offs resolve too — a skipped one-off leaves the cycle deduction (the boss's 10k test: free must rise on skip, drop on undo)" in js
          and "var ro = resolveOccurrence(p, od); // v73.63: one-offs resolve too — a skipped one-off leaves the window total (free moves on skip/undo)" in js
          # the old gate is GONE from the deduction
          and "var ro = p.repeat ? resolveOccurrence(p, od) : null;" not in js
          # the skipped one-off's record pill + unskip path in the plans list
          and 'data-unskip="' + "' + p.id + '|' + String(p.date)" in js
          # the notes
          and "'73.63': [" in js)
    check("v73.64 (boss: 'the amber partial chip disappeared with no trace, i no longer have access to unskip'): a skip is a RELOCATION, not a deletion — the grid's advance loop keeps the skipped occurrence's resolved date in the window (same semantics as a moved-to-future due), so the history strip renders its 'skipped' chip with data-unskip and the header's ↺ + 'N skipped' count cover PAST skips too (they only saw future ones before — the boss's Rent was a past skip: count 0, no button, no chip). unskipPlanOccurrence's was-restore is untouched (never deletes a fork).",
          # (a) the grid keeps the skipped resolved date in the window
          "if (eR && eR.skip) {\n          var sRes = planDateAt(p, start);\n          if (out.indexOf(sRes) < 0) out.push(sRes);" in js
          # (b) the header count spans past + future skips
          and "var skipTotal = skipped.length + past.filter(function (x) { return x.skip; }).length;" in js
          # (c) the header ↺ falls back to the most recent PAST skip (the
          # boss's Rent case — before, a past-only skip left it buttonless)
          and "var firstSkip = skipped.length ? skipped[0].d : (pastSkips[0] || {}).d;" in js
          # (d) the strip chip's unskip path is unchanged (the record never vanishes)
          and "x.skip ? ' data-unskip=\"' + p.id + '|' + x.d + '\"" in js
          # the notes
          and "'73.64': [" in js)
    check("v73.65 (boss: 'the free-cash chart's x-axis date labels overlap' — 'Oct2 Oct29 Oct5 Nov8…' collided into each other): the x-axis is THROTTLED, not 1:1 — every tick is still a date (the v72.41 rule survives), but middle ticks are greedy-skip'd when they'd land closer than ~34px (a 'Nov15'-width label at font-size 8 + gutter) to the previous one; first + last points always keep their tick; the plotted line keeps EVERY point (thinning the axis never thins the data)",
          # (a) the throttle floor (label width + gutter)
          "var tickMinPx = Math.max(34, Math.round(4.6 * 5 + 6));" in js
          # (b) the greedy skip of middle ticks only (first/last forced)
          and "if (X(ti) - X(tickIdx[tickIdx.length - 1]) >= tickMinPx) tickIdx.push(ti);" in js
          and "tickIdx.push(pts.length - 1);" in js
          # (c) the render iterates the THINNED set, not every point
          and "tickIdx.forEach(function (i) {" in js
          # (d) the v72.41 date-label rule survives on the thinned ticks
          and "var lab = p.date ? dayMonth(p.date) : p.label;" in js
          # the notes
          and "'73.65': [" in js)
    check("v73.66 (boss: 'make coach fin and coachs note very funny and very roasty'): the coach card + the insights/recap one-liners got the roast treatment — every coach branch (negative free, prepay due, over-budget week, red-month pace, tight daily, on-track) now lands a roasty line, the 'On repeat' line and the coach-memory lines roast too, and the insights Today / Next-7-days / cycle / month + recap one-liners match. The NUMBERS are untouched — every line still quotes the same computed values (money(), d.daily, d.pace, remainders); only the words around them changed",
          # (a) the coach's six branches are roasty (one marker per branch)
          "your free cash is negative. Bold. Truly bold." in js
          and "It is not optional, no matter what your wallet keeps saying." in js
          and "The math is not your friend right now." in js
          and "That is a plan, apparently." in js
          and "We can do this, we just can\\'t do it today." in js  # the app string escapes the apostrophe (can\'t)
          and "spend it, you have earned the guilt." in js
          # (b) the 'On repeat' line + the coach memory roast
          and "They do not get less real just because you keep not looking at them." in js
          and "Progress is progress, I suppose." in js
          and "You have not changed, and that is its own kind of loyalty." in js
          # (c) the insights one-liners (Today / 7-days / cycle / month)
          and "the treats are now a memory" in js
          and "You win this round; do not celebrate yet." in js
          and "the paycheque is dying a young death" in js
          and "Suspiciously fine — do not log anything else." in js
          # (d) the recap one-liner
          and "worth a look, or worth a therapist?" in js
          # (e) the smoke can drive the real render
          and "renderCoach: renderCoach," in js
          # the notes
          and "'73.66': [" in js)
    check("v73.67 (boss: 'i used the due rows chip but it has no link chip'): paying a PAST-DUE plan due from its own chip could silently drop the link — planRefAlive checked the link against planOccurrences() (the FORWARD window, first date >= today), so an OVERDUE occurrence looked dead: updatePlanLinkChip nullified the ref the boss had just set, the chip rendered hidden, the saved txn carried no planRef, the due row stayed, and the hero deducted it AGAIN (the double-deduction). The membership check now uses planAllDates (the FULL series, past included) — an overdue occurrence is the MOST important link target, not a stale one; a truly dead link (plan deleted, re-anchored, skipped) still dies because none of those dates appear in planAllDates",
          # (a) the check walks the full series, not the forward window
          "var occs = planAllDates(p); // v73.67: full series, past included" in js
          # (b) the old forward-window membership is gone from planRefAlive
          and "var occs = planOccurrences(p);" not in js.split("function planRefAlive")[1].split("function mealBudget")[0]
          # (c) the skip-still-dead rule survives
          and "if (ro && ro.skip) return false;" in js
          # the notes
          and "'73.67': [" in js)
    check("v73.68 (boss: 'extend the plan due rows to show dues... on second thoughts, make it this cycle's dues, initially collapsed to 4 +x more rows'): the coach's plan-due window now spans the WHOLE current cycle (due today..cycEnd, the 10-day forward window is dead; fallback to +20 only if cycle data is ever missing) and overdue dues still stay forever (v73.27 untouched); coachRows builds EVERY due in the window into rows (the old shown<4 cap silently dropped the rest) and renderCoach collapses the plans group to its first 4 rows + a tappable '+N more…' (coachPlansMore, in-memory, defaults collapsed — the peek's cbPlansMoreRow pattern, div[role=button])",
          # (a) the window: today..cycEnd (fallback +20), overdue stays
          "if (u2.dd >= 0 ? (cycEnd ? u2.date <= cycEnd : u2.dd <= 20) : true) urgent.push(u2);" in js
          # (b) the old 10-day forward window is gone from coachRows
          and "u2.dd <= 10" not in js
          # (c) coachRows no longer caps at 4 (the collapse moved to renderCoach)
          and "i < urgent.length && shown < 4" not in js
          # (d) the collapse: slice to 4 + the more-row + the in-memory flag
          and "if (isPlans && !state.coachPlansMore && grow.length > 4) planRows = grow.slice(0, 4);" in js
          and 'id="coachPlansMoreRow" role="button"' in js
          and "state.coachPlansMore = true;" in js
          and "coachPlansMore: false" in js
          # the notes
          and "'73.68': [" in js)
    check("v73.46 (boss: 'the date field is invisible, i just click with faith that its there'): the plan-edit sheet's date input (opacity:0 by design) now has a visible .dlabel span (#pe_dateLabel) — the same pattern as every other date field — and the sheet fill + input binding call syncDateLabel so the label shows the real date, never the 'Pick a date' placeholder",
          'id="pe_dateLabel"' in html
          and 'class="dlabel"' in html.split('id="pe_dateLabel"')[0].split('<span')[-1]
          and "if (dt) { dt.value = dateISO; syncDateLabel(dt); }" in js
          and "var pedateEl = byId('pe_date');" in js
          and "pedateEl.addEventListener('input', function () { syncDateLabel(pedateEl); })" in js
          and "openPlanEdit: openPlanEdit," in js)
    check("v73.3 (user: 'do all them' — the major upgrade, release 4 of 4): GOAL PROGRESS + GIST SYNC — sinking funds get a progress RING (ringSVG) + a pace line (goalPace, pure: 'on pace' when the monthly plan clears the goal by the deadline, 'behind by ₱X/mo' otherwise); Settings gains a Sync section (gist URL + token + passphrase) — the data is encrypted ON THIS PHONE (AES-256-GCM, key = PBKDF2-SHA256/passphrase/150k) before it touches the network (syncEncrypt/syncDecrypt — GitHub only ever sees the ciphertext file); push uploads, pull downloads + syncMerge (pure: per record newest timestamp wins, a TIE keeps LOCAL, remote-only records are added, the other side's removedTxn/removedPlan tombstones drop records — deletions sync, nothing silently overwritten); deletions file tombstones (deleteTxn/deletePlan/removeTxnRow) that Undo clears; the passphrase is never stored (only url+token in localStorage)",
          "function goalPace(f, month) {" in js
          # v73.42: ringSVG + the sink-ring markup are GONE with the Sinking
          # card (Money tab cut) — goalPace (pure) is what v73.3 keeps.
          and "function ringSVG(pct) {" not in js
          and 'class="sink-ring"' not in js
          and "function syncEncrypt(obj, passphrase) {" in js
          and "function syncDecrypt(env, passphrase) {" in js
          and "function syncMerge(local, remote) {" in js
          and "function syncPush() {" in js and "function syncPull() {" in js
          and "iterations: 150000, hash: 'SHA-256'" in js
          and "goalPace: goalPace" in js and "syncMerge: syncMerge" in js
          and "syncEncrypt: syncEncrypt" in js and "syncDecrypt: syncDecrypt" in js
          and 'id="syncUrl"' in html and 'id="syncToken"' in html and 'id="syncPass"' in html
          and 'id="syncPush"' in html and 'id="syncPull"' in html
          and "syncTombAdd('t', id)" in js and "syncTombAdd('p', id)" in js
          and "SYNC_FILE" in js
          and "'73.3': [" in js)
    check("v73.6 (user: 'my cc due is on oct 5 and its based on my spending until the 15th minus the prepay i made'): the CC DUE — the base gains due_day (5 by default; older bases fall back to it) + the Settings form's 'cc due day' input; ccDueData (PURE: txns + base + today) computes the due as the charges since the previous cutoff minus the prepays in the window (prevCutoff, cutoffOnOrBeforeDue] — string/number date math, NO Date getters (the UTC+8 local-getter trap); the coming-due strip gets the CC due row (date + amount, red when <= 2d); the prepay tile reads 'cutoff 15 · due 5'; computeMood goes worried when the due is a week out and exceeds the free cash; the coach snapshot carries the due line (charges/prepays breakdown)",
          "due_day: 5, card_util_target: 0.099" in js
          and 'id="b_dday"' in js and "b.due_day = dd > 0 ? dd : 5;" in js
          and "function ccDueData(txns, b, todayStr) {" in js
          and "function ccDue() {" in js
          and "ccDueData: ccDueData" in js and "ccDue: ccDue" in js
          and "due_day: Number(b.due_day) || 5" in js
          # v73.14: the due-strip row ('CC due' label) was removed with the strip — the ccDue math + mood stay
          and "du.dueIn >= 0 && du.dueIn <= 7 && du.due > 0" in js
          and "du.due > f0) return 'worried';" in js
          and "cc due on the ' + ordinal(du6.due_day)" in chatjs
          # v73.42: the 'cutoff 15 · due 5' pin was the summary prepay tile's
          # note — that tile was cut from the Money tab, so the pin is gone
          # with it. The ccDue math + mood + chat line above still stand.
          and "'73.6': [" in js)
    check("v73.7 (user: 'fix that salary changing the month spent' + 'reduce its boot screen time from 3 to 2 seconds'): the money-log MONTH-SPENT line no longer swings by the full salary when the 'Salary in' check-in lands — the cycle's own salary cash_in (>= 90% of the month's expected salary, dated 1st..payday+2, the same identity rule as cycleDataFor's received) is income, not negative spend, so monthEffect returns 0 for it (logMoney's s sum + the edit rebase both route through it) while other inflows (refunds) still net; the boot floor is 2s (BOOT_MIN_MS 2000)",
          "function salaryTxnIdInMonth(month) {" in js
          and "function monthEffect(kind, amt, t) {" in js
          and "monthEffect: monthEffect" in js and "salaryTxnIdInMonth: salaryTxnIdInMonth" in js
          and "sp += monthEffect(x.kind, Number(x.amount) || 0, x);" in js
          and "var meOld = monthEffect(o.kind, oldAmt, o), meNew = monthEffect(t.kind, newAmt, t);" in js
          and "'73.7': [" in js)  # the boot-floor pin moved to v73.8 (1500)
    check("v73.8 (user: 'The bug for month-spent still there, also boot screen change to 1.5 now from 2' + 'add a third option to handle incoming fund/salary'): (1) the money-log s-line fix (v73.7) only covered the AUDIT line — every spend AGGREGATE still ran the raw v72.44 spendOf, which netted every cash_in down, so logging the salary swung 'App spend so far' (insights spentM/pace), spent-today, the donut, the recap and the chat snapshot by the full salary. Now spendOf returns 0 for cash_in (income is not negative spend — the v72.45 cycle/donut rule, generalized); monthEffect keeps the narrower rule (refunds still net the ledger line down) for the audit trail; (2) the Add sheet gains the VISIBLE third direction — Spend | Pay card | Money in (the v72.45 'salary' mode was hidden behind the coach chip; both now land on the same 'moneyin' tab: cash_in, CASH-only, first cash account preselected, title 'Money in' / submit 'Add money in'); (3) the boot floor goes 2s -> 1.5s (BOOT_MIN_MS 1500)",
          "function spendOf(t) {" in js
          and "if (t.kind === 'cash_in') return 0;" in js
          and "? 0 : -amt;" in js  # monthEffect: the salary returns 0, a non-salary cash_in (refund) still nets (the narrower audit rule)
          and "var BOOT_MIN_MS = 1500;" in js  # v73.8: 2000 -> 1500
          and 'id="addModeMoneyin"' in html and ">Money in</button>" in html
          and "if (mode === 'salary' || mode === 'moneyin') return type === 'CARD' ? 'card_payment' : 'cash_in';" in js  # v73.52: the pin moved — Money in on a CARD is a payoff
          and "addMode = m === 'prepay' ? 'prepay' : (m === 'salary' || m === 'moneyin' ? 'moneyin' : 'spend');" in js
          and "if (amM) amM.onclick = function () { setAddMode('moneyin'); };" in js
          and "'Money in' : 'Add expense'" in js
          and "'73.8': [" in js)
    check("v73.9 (user: 'the money spent bug is fixed, but still shows it on the ledger entries wrong (which should be correct already and hidden)'): the salary row's s VALUE was already right (v73.7 — the line does not move), and the 'month spent X → X' chip no longer renders on it. v73.75 retarget: the chip is GONE for EVERY row (the isSalRow guard dies with it)",
          "var isSalRow" not in js
          and "'month spent ' + money(sBefore) + ' → ' + money(e.s)" not in js
          and "'73.9': [" in js)
    check("v73.10 (user: 'i now have 73.9 in phone but still when i log money in entries, the month spent's still there and wrongly changing'): the v73.7 identity had a DATE window (1st..payday+2 - an early-payday allowance for cycleDataFor's RECEIVED display), but salaryTxnIdInMonth is ALSO the money-log's swing guard - and the Money in tab (v73.8) defaults the date to TODAY, so a salary logged on the 25th fell outside the window, was classified as a 'refund', and swung the line by the full salary (reproduced live in Chromium: 100 -> -44,900, chip rendered). The identity is now the AMOUNT: any cash_in of >= 90% of the month's expected salary is the salary, any date (a real refund is never 90% of the salary; earliest date wins on ties)",
          "function salaryIsTxn(t, amt) {" in js  # the amount-based identity (amt overrides t.amount — the rebase path passes the live amount)
          and "if (kind === 'cash_in') return salaryIsTxn(t, amt) ? 0 : -amt;" in js  # monthEffect routes through it
          and "salaryIsTxn: salaryIsTxn" in js  # exported (smoke drives it)
          # v73.75: the isSalRow chip-hide pin is gone with the chip (the chip never renders now)
          and "if (amt < 0.9 * expected) return;" in js  # salaryTxnIdInMonth keeps its amount gate (the v73.7 pins + row identity still use it)
          and "if (d < lo || d > hi) return;" in js  # cycleDataFor's received display still uses its own window
          and "'73.10': [" in js)
    check("v73.11 (user: 'In finance-app todays insights headroom, base it per cycle too'): the Today block's headroom ran the free cash across the CALENDAR month (dim - date + 1), but the money has to last until the NEXT salary (the 14th) - the cycle end. insightsData gains cycleDaysLeft (days to cycleData's window end, calendar fallback when there is no cycle) and the Today block divides by it, names the cycle end, and the treat check compares against the per-cycle daily",
          "cycleDaysLeft: (function () {" in js  # the per-cycle days left (calendar fallback when no cycle)
          and "return dl > 0 ? dl : 1;" in js  # the guard: never zero/negative (the cycle end is today at the latest)
          and "var hDays = d.cycleDaysLeft || daysLeft;" in js  # the render uses the cycle days (calendar when absent)
          and "var hDaily = hDays > 0 ? r2(Math.max(0, free) / hDays) : 0;" in js  # the per-cycle daily
          and "this cycle (to ' + dayMonth(d.cycle.end) + ')'" in js  # the line names the cycle end
          and "else if (hDaily >= meal) {" in js  # the treat check runs on the per-cycle daily
          and "'73.11': [" in js)
    check("v73.12 (user: 'the cards owed should be subtracted already from the liquid cash to know how much cash is free/unallocated'): the base snapshot commits the FULL card balance (free = liquid - owed - other outflows), not just the prepay-to-target slice. The v72.42 overlay rule (charge -a free, payoff 0) is unchanged - it is exactly what keeps the identity live (a charge commits free by the full amount; the payoff only drops raw liquid + owed)",
          "var cardOwed = (month === months[0]) ? baseCardTotal(b) : 0;" in js  # the base month commits the full owed
          and "var outflows = r2(budgetTotal + debtTotal + sinkTotal + oneOffTotal + cardOwed);" in js  # owed replaces the prepay slice in outflows
          and "card_prepay: cardOwed" in js  # the comp field carries the full owed (the tile/committed read it)
          and "return { cash: amt, free: 0, card: -amt, prepay: -amt, acc: t.account };" in js  # v72.42 plain-payoff rule intact (keeps free = liquid - owed live); v73.53: the cashback branch sits above it
          and "'73.12': [" in js)
    check("v73.13 (user: 'why did u change my numbers' - the v73.12 upgrade zeroed the phone's overlay, 41k free -> -6,664.88): the rebase trigger (snapSig) carried the DERIVED cash.free, so the owed-model formula change altered the sig without any base edit -> boot ran a FALSE REBASE and wiped the live overlay. The sig is now the RAW inputs only (liquid|owed|prepay slice) and old 4-component stored sigs normalize to the 3-component one at boot + import - a formula change can never trip the rebase again",
          "return [s.cash && s.cash.total, s.card_owed, s.total_prepay].join('|');" in js  # raw inputs only, no derived free
          and "function normalizeStoredSig(sig) {" in js  # old 4-comp -> 3-comp
          and "return p.length === 4 ? [p[0], p[2], p[3]].join('|') : sig;" in js  # drops the derived free (comp 2)
          and "state.adjSig = normalizeStoredSig(m.value || '');" in js  # boot normalizes the stored sig
          and "normalizeStoredSig(data.adjSig)" in js  # import normalizes too
          and "function snapSig(s) { return F.snapSig ? F.snapSig(s) : ''; }" in chatjs  # the coach reuses the app's sig (no drift)
          and "'73.13': [" in js)

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
    check("coach's note card on Home: read-only, cached, hidden without a coach (v73.14: the note is the block INSIDE the coach card — Home slim)",
          'id="coachNoteBlock"' in html and 'id="coachNoteBody"' in html
          and 'id="coachNoteRefresh"' in html and ".coachnote-t{" in html
          and "FAI.note(snap.text)" in js and "NOTE_KEY" in js
          and "var el = byId('coachNoteBlock');" in js)
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
    check("re-seeded automatically when the base changes (snap render list; v72.30: renderMoneyLog follows — a base save can file 'Adjustment' rows; v73.0: renderMood rides the same key; v73.2: the money pulse; v73.14: the due strip left the list; v73.33: renderRecap left — the Home recap card is gone; v73.74: reconRender rides the same key — a base save must repaint the Reconcile card)",
          "renderBaseStatus, renderCoachNote, seedCategories, renderMoneyLog, renderMood, reconRender]" in js)
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
          and "seedAccounts, renderAddEmpty" in js)
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
          # v73.50: the 7s auto-hide is gone (the toast persists until
          # swiped) — the swipe-wiring this check pins is what survives.
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
    check("import sanitizer keeps every row flavor (v72.14, v72.30, v73.45): the k allow-list covers c/x/p/i/a/r — the v72.8 list (c/x only) silently stripped the v72.10 card_payment/cash_in flavors on import, rendering them as spends with inverted before/after; v72.30 adds 'a' (the Adjustment override row); v73.45 adds 'r' (the reset audit row)",
          "if (e.k === 'c' || e.k === 'x' || e.k === 'p' || e.k === 'i' || e.k === 'a' || e.k === 'r') m.k = e.k" in js)
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
          "return { cash: amt, free: 0, card: -amt, prepay: -amt, acc: t.account };" in js  # v72.42 plain-payoff rule (the v73.53 cashback branch sits above it)
          and "if (t.kind === 'cash_in') return { cash: -amt, free: -amt, card: 0, prepay: 0 };" in js
          and "k: t.kind === 'card_charge' ? 'c' : t.kind === 'card_payment' ? 'p' : t.kind === 'cash_in' ? 'i' : 'x'" in js
          and '<select class="oent-acc">' in js and "owedAccOptions('CASH::Cash')" in js
          and "function owedTxnKind" not in js
          and "category: e.cat, amount: ledger, note: 'Owed \u00b7 ' + p.name" in js
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
    check("the owed form's sections + ledger filing follow 'What happened' (v72.28 + follow-ups, user: the 4 directions, then 'maybe we should remove the ledger entries for i paid for them and they paid me back' — the settle-by-purchase offset double-counted — an interpretation edit — 'dont drop it anymore' the Account section + the tpf 'Unsorted' fallback): the ledger records CONSUMPTION, not loans — ONLY tpf files a ledger txn (Cash implicitly, the picked category from Your numbers' budgets with 'Unsorted' fallback, negative cash_out); ipf = Account + Note, itb and tmb = Account only, all three NEVER touch the ledger (a pure loan cycle nets to zero in cash; an offset lands in the tpf entry's true category; their account pick is stored on the entry informationally); existing entries adopt the rule ONLY on edit — the linked txn is rewritten in place (id + position kept), removed, or created fresh, and undo reverses it; NO migration of old entries; the owed balance still comes from the entry records. v72.49 superseded the filing amount: YOURS files (the split part, ipf on the picked account, Category now shown for ipf too) — the v72.49 check pins the new rule; this check keeps the section mechanics + the current filing shape",
          "function owedFormSections(form, dir)" in js
          and '<div class="oent-accrow">' in js and '<label>Account</label>' in js
          and "a.style.display = dir === 'tpf' ? 'none' : ''" in js
          and "c.style.display = (dir === 'tpf' || dir === 'ipf') ? '' : 'none'" in js
          and "n.style.display = (dir === 'ipf' || dir === 'tpf') ? '' : 'none'" in js
          and "var ledger = isSplitDir ? ((dir === 'tpf') ? owed : mine) : 0;" in js
          and "var files = ledger > 0;" in js
          and "if (!cat) cat = 'Unsorted';" in js
          and "cat = e.cat || 'Unsorted';" in js
          and "date: e.d, account: 'Cash', kind: 'cash_out'," in js
          and "date: next.d, account: 'Cash', kind: 'cash_out'," in js
          and "category: e.cat, amount: ledger, note: 'Owed \u00b7 ' + p.name" in js
          and "category: next.cat, amount: ledger, note: 'Owed \u00b7 ' + p.name" in js
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
    # v73.47: the live stamp must be fresh — the release is ONE commit
    # (the "live re-stamp" second commit is dead), so `live` must be within
    # 30 min of the gate run (release.ps1 runs the gates right before
    # commit+push). A stale stamp means the release was stamped long ago
    # and sat unpushed — run release.ps1 again right before committing.
    _live = re.search(r"var SHELL_RELEASE = \{ v: [\d.]+, live: new Date\((\d+), (\d+), (\d+), (\d+), (\d+)\)", js)
    _fresh = False
    if _live:
        import datetime as _dt
        _stamp = _dt.datetime(int(_live.group(1)), int(_live.group(2)) + 1, int(_live.group(3)), int(_live.group(4)), int(_live.group(5)))
        _age = _dt.datetime.now() - _stamp
        _fresh = _age.total_seconds() <= 30 * 60
    check("live stamp is fresh (v73.47: one commit per release — `live` must be within 30 min of the gate run; re-run release.ps1 right before commit if this fails)",
          _fresh)
    check("v72.41 (user: 'write the x axis ticks as end of month, e.g. 30 Sep, 31 Oct, etc' + 'i wanna prepay maya cc and maribank cc separately'): (1) EVERY x-axis tick is a date — the month points sit on the last day of their month (the plotted value is that month-end projection), so the axis reads '6 Sep · 30 Sep · 31 Oct · … · 28 Feb'; the v72.37 start/middle/end special-case is gone (the compact month name stays only as the no-date fallback); (2) the Add sheet gains a direction — Spend (the old rules) vs Pay card (kind card_payment, the payoff that settles the owed balance — v72.42 corrected it to leave free untouched; a payoff must land on a CARD account, the first card is preselected, the title/button follow the mode, the deficit hint is off in payoff mode); (3) the coach's prepay action is ONE BUTTON PER card owed above its target (that card's live amount + account prefilled, Pay-card mode) — the combined button survives only as the no-per-card-breakdown fallback",
          "var lab = p.date ? dayMonth(p.date) : p.label;" in js
          and "function addSheetKind(mode, type, editingKind)" in js
          and "if (mode === 'prepay') return 'card_payment';" in js
          and "if (addMode === 'prepay' && type !== 'CARD')" in js
          and 'id="addModeSpend"' in html and 'id="addModePrepay"' in html and 'class="amrow"' in html
          # v73.19: the per-card chip moved UP into the coach rows; v73.20:
          # the chip is the PILL BUTTON on the right of a plain row (the
          # plan-due design — the v73.19 full-row dig-chip look is gone).
          # chipAttr builds the data-<act> payload (amount|date|day|card,
          # the card riding the payload) and the prefill rides
          # prepayRowChip's exported handler body (same v72.41 shape:
          # that card's live amount + its own account, Pay-card mode)
          and "rowchip" in js
          and "function chipAttr(rw) {" in js
          and "function prepayRowChip(attr) {" in js
          and "card ? 'CARD::' + card : null, 'prepay');" in js
          and "addSheetKind: addSheetKind" in js)
    check("v72.42 (the payoff bug, user: 'fix the payoff bug and keep both numbers — floor stays on raw bank cash'): a card_payment settles the debt — it is NOT the exact inverse of card_charge (the charge already spent the free cash; the credit limit isn't money). The payoff drops the RAW liquid (adj.cash +a → effective total −a) and the owed/prepay, and leaves free UNTOUCHED (tuple free: 0, freeEffect → 0): a charge+payoff cycle nets free −amt and liquid −amt with owed 0 (the expense is real, the debt is settled) instead of erasing the expense; the money-log 'p' row renders free unchanged (before = f) while its card sub-line still shows the owed dropping; cash.free and cash.total stay separate and the liquidity floor keeps running on the raw cash.total",
          "return { cash: amt, free: 0, card: -amt, prepay: -amt, acc: t.account };" in js  # the PLAIN payoff rule (v73.53: the cashback branch above it is the new-money variant)
          and "function freeEffect(t, amt) { if (t.kind === 'card_payment') return t.cashback ? amt : 0; return (t.kind === 'cash_in') ? amt : -amt; }" in js  # v73.53: a cashback payoff moves free by +amt; a plain one by 0
          and "var before = (e.k === 'p' && !cbRow) ? r2(e.f)" in js)
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
          # v73.23: the "Partly handled — … logged on …" row is GONE (the
          # per-card chip carries the live remainder) — the v72.44 regression
          # is the no-throw (coachRows survives a paid prepay), asserted in
          # the smoke; the row-text assertion is dropped with the row.
          and "function spendOf(t) {" in js
          and "if (t.kind === 'card_payment') return 0;" in js
          and "if (t.kind === 'cash_in') return 0;" in js  # v73.8: cash_in is income, not negative spend (was -a)
          and "todaySpend += spendOf(t)" in js
          and "spentM += spendOf(t)" in js
          and js.count("var a = spendOf(t);") >= 2
          and "spent += spendOf(t)" in js
          and "spendOf: spendOf" in js
          and "F.spendOf(tn)" in chatjs
          and "if (e.k === 'p' && !cbRow) freeTxt = ''" in js)  # (3) user edit: the prepay row shows only the card change, not the unchanged free line (v73.53: a cashback payoff is new money — its free line stays)
    check("v72.45 (user: 'the bot dont know my cc limits / i feel like coach fin cant read my current actual numbers / i prepay in maya cc partial only but the chip is still not showing for that in the hey jan card. i want it to still show the remaining / salary is expected every 15th and used in the projection / insights on my finances based on every salary cycle (15th) / i can confirm somewhere if the salary has already entered prior to 15'): (1) the coach snapshot's CARD rows carry the LIVE per-card balance (the effective overlay, not the sheet as-of) + the stored credit limit + utilization; (2) a PARTIAL prepay keeps its per-card chips + a 'Partly handled — … still owed' row + the live 'prepay' alert — keyed on the remaining, only the full settlement takes them down; (3) the salary lands on the salary_day (the 15th, a new Your-numbers field, cutoff-day fallback): the cycle is 15th -> 14th (pure cycleDataFor), the expected amount is the cycle month's override when > 0 else the base salary (the sheet's pre-payday zero is 'not in yet', not 'no salary'), the 'Salary in' chip is a real cash_in (a third Add-sheet direction, CASH-only) the cycle reads back — even an early 13th one, which is excluded from the cycle spend so it cannot sink the previous cycle; (4) the projection gains the explicit payday point (actual receipt date once logged), the hero carries due / in, Home gets a 'This cycle' block, and the cycle rides the shared snapshot as a deterministic finding",
          "function cardEff(name) {" in chatjs
          and "var bal = c ? (Number(c.balance) || 0) : (Number(a.value) || 0);" in chatjs
          and "' [limit ' + money(lim)" in chatjs
          and "if (F && typeof F.cycleData === 'function') {" in chatjs
          and "'- salary ' + money(cyc.expected)" in chatjs
          and "IN on ' + cyc.received.date" in chatjs
          and "function salaryDayOf(b) {" in js
          and "function expectedSalaryFor(month, b) {" in js
          and "function cycleDataFor(month, b) {" in js
          and "function cycleData() {" in js
          and "if (mode === 'salary' || mode === 'moneyin') return type === 'CARD' ? 'card_payment' : 'cash_in';" in js  # v73.52: the pin moved again — Money in on a CARD is a payoff (the v73.8 CASH-only guard is gone)
          and 'id="b_sday"' in js
          and "b.salary_day = sd > 0 ? sd : (b.cutoff_day || 15);" in js
          and "cycle: cycleData()," in js
          # v73.33: the hero-sub salary string left with the hero block — the
          # surviving 'Salary (the' is the salary row-chip's prefill note
          and "'Salary (the ' + ordinal(Number(parts[2]) || 15) + ')'" in js
          and "act: 'salary'" in js  # v73.19: the 'Salary in' chip moved up into the coach rows (the old coachActs button is gone)
          and "id=\"actSalary\"" not in js  # v73.19: the old coachActs salary chip is GONE (moved up into the rows)
          and "id=\"actPrepay\"" not in js  # v73.19: the old coachActs prepay chip is GONE (per-card rows replaced it)
          and "function prepayRowChip(attr) {" in js  # v73.19: the prepay row-chip's handler body
          and "function salaryRowChip(attr) {" in js  # v73.19: the salary row-chip's handler body
          and ".rowchip{" in html  # v73.20: the row-chip pill styling (the plan-due design for every action row)
          and "insBlock('This cycle'" in js
          # v73.57: the v72.45 salDelta/proration lines are GONE (the 2-month
          # step chart replaced the base-matrix plot) — the salary now lands
          # as a step event on the next payday (the v73.57 pin asserts it).
          and "var salDelta = 0, salDate = null;" not in js
          and "pts.splice(1, 0, { label: dayMonth(salDate), v: vAtSal, date: salDate });" not in js
          and "ev(salISO, expectedSalaryFor(" in js
          and "var prepayActive = info.prepayActive;" in js
          # v73.23: the 'Partly handled — … still owed' row is GONE (the
          # per-card chip carries the live remainder) — those two assertions
          # are dropped with the row; the live 'prepay' alert is kept.
          and "alerts.push('prepay'); // v72.45" in js
          # v73.26: the return line grew (count + linked for the plan
          # accumulation) — the v72.45 assertion is updated to the new shape.
          and "if (pLast) out = { amount: r2(pSum), date: pLast.date, count: pCount, linked: !!(out && out.planRef) };" in js
          and "if (receivedId && t.id && t.id === receivedId) return;" in js
          and "cycleData: cycleData" in js)
    check("v72.46 (user: 'after i prepay, i ask coach fin again for the cc util rate and it gave the old util rate, it did not update. how stupid can coach be? should i just offload that task to the rule engine'): the util question is answered by the DETERMINISTIC rule engine with LIVE numbers — (1) 'util rate' (not just 'utilization') hits the status intent, per-card, no API call; (2) the effective card is live end-to-end: balance + utilization are recomputed from the overlay-inclusive balance in BOTH app.js effectiveSnap() and chat.js loadCtx(), and the map runs over the CLONE — the v72.33 original mapped over the live state and only got away with it because prepay was idempotent (a non-idempotent write-back would have compounded the overlay into state on every render); (3) the LLM system prompt carries the precedence rule — the numbers list is current as of now and supersedes anything said in earlier turns; (4) the v72.46 stamps (SHELL_RELEASE, SHELL_NOTES, SW cache)",
          r"util: /\butiliz|\butil\b/.test(t)" in chatjs
          and "c.balance = r2(bal);" in js
          and "c.util_pct = lim ? r2(bal / lim * 100) : null;" in js
          and "e.cards = (e.cards || []).map(function (c) {" in js
          and "eff.cards = (eff.cards || []).map(function (c) {" in chatjs
          and "c.util_pct = lim ? r2(bal / lim * 100) : null;" in chatjs
          and "it supersedes anything said in earlier turns" in chatjs)
    check("v72.47 (user: 'u did not update this log as completed — rename the prepays and future cc payments from Unsorted to CC Payment'): the v72.44 reco's label half finally ships — (1) every card-payment money-log row (k 'p') reads 'CC Payment' in the ledger: a logged prepay AND a future-dated one (the chip prefills the 14th, so an early log lands in the future) — row label + the edit toast + the chat 'Logged …' confirmation; (2) the category filter gets its own CC Payment option and the Unsorted filter no longer swallows prepays; (3) a prepay contributes zero spend, so it can no longer leave a phantom 'Unsorted 0' slice in the by-category donut or a 'Unsorted 0.00' line in the coach-note breakdown; (4) the v72.47 SHELL_NOTES entry (its stamp pins are the generic gate's — they move with every release)",
          "lab = e.k === 'p' ? 'CC Payment' : (e.c || 'Unsorted');" in js
          and "if (mlFilterCat === '__ccpay__') return e.k === 'p';" in js
          and "if (mlFilterCat === '__unsorted__') return e.k !== 'p' && !e.c;" in js
          and 'value="__ccpay__">CC Payment' in js
          and "t.kind === 'card_payment' ? 'CC Payment'" in js
          and "pl.kind === 'card_payment' ? 'CC Payment'" in chatjs
          and "if (!a) return; // v72.47" in js
          and "if (!amt) continue; // v72.47" in chatjs
          and "'72.47': [" in js)  # v72.48: per-release stamp pins live in the generic gate (sw cache + footer + running-version note); only the SHELL_NOTES entry is permanent
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
          and "var isAdj = e.k === 'a' || e.k === 'r';" in js  # v73.45: 'r' (reset audit row) joins the Adjustment render family
          and "if (cardRow) freeTxt = ''" in js
          and "data-ow-edit-cancel=\"1\"" in js
          and "var lessE = t.getAttribute && t.getAttribute('data-ow-less');" in js
          and "owedShown[lessE] = Math.max(5, (owedShown[lessE] || 5) - 5);" in js
          and "ow-pag" in js and "ow-pag" in html
          and 'id="mlLess"' in js and "ml-pag" in js and "ml-pag" in html
          and "mlShownCount = Math.max(5, mlShownCount - 5);" in js
          and "names.push('Owed')" not in js
          and "prevTxn.category || 'Unsorted'" in js
          and "renderBaseStatus, renderCoachNote, seedCategories, renderMoneyLog, renderMood, reconRender]" in js  # v73.74: the snap key gained reconRender (a base save must repaint the Reconcile card); v73.0: renderMood + v73.2: the pulse ride the snap key; v73.14: the due strip left the list; v73.33: the pulse (renderRecap) left the list
          # v73.69 retarget: the snap key grew renderCcCards (the CC card repaints on a base save) — the ledger tail moved
          and "updateChargeHint, renderHero, renderCcCards, renderBaseStatus, renderCoachNote, seedCategories, renderMoneyLog, renderMood, reconRender]" in js)
    check("v73.69 (boss-approved 2-cell CC summary card, the parked mock's v73.68-shippable subset): one row per CC under the hero — name + limit + utilization pill, two cells (Balance = the card's LIVE balance; Due = the manual 'due this cycle' override when set, else the full balance — v73.68 has no next-cycle tagging, so the balance IS the bill), the due date is the GLOBAL due day (per-card dates + the Next-cycle cell are v73.70 data and stay off), and the provenance chip is AUTO DUE / MANUAL (warn-styled); repaints on txn/plan/snap/adj/ui (a card charge or a Settings override must move the card)",
          "function renderCcCards()" in js
          and 'id="ccCardsBody"' in html
          and 'id="ccCards"' in html
          and "var manualDue = (c.due != null) ? Number(c.due) : null;" in js
          and "var dueAmt = (manualDue != null) ? Math.max(0, manualDue) : bal;" in js
          and "'AUTO DUE'" in js and "'MANUAL'" in js
          and "src' + (manualDue != null ? ' manual' : '')" in js
          and "renderHero, renderCcCards, renderDonut" in js  # the ui key (the txn key shares the renderHero, renderCcCards adjacency)
          and "updateChargeHint, renderHero, renderCcCards, renderBaseStatus" in js  # the snap key
          and "updateChargeHint, renderHero, renderCcCards, renderMoneyLog" in js  # the adj key
          and "renderCcCards: renderCcCards" in js
          and "grid-template-columns:1fr 1fr" in html  # the 2-cell grid (the mock's 3-col next-cycle cell is gone)
          and "utilpill" in html and "ccrow" in html)
    check("v73.70 (boss: 'allow sorting of entries based on the payment method'): a SECOND ledger dropdown (#mlFilterM) filters by the row's payment method (the e.m account — 'Maya CC', 'MariBank CC', 'MariBank', 'Cash', …); a prepay row with no account falls back to 'CC Payment' (the v72.47 name); the value rides the '__m:' prefix so it can't collide with a same-named category; it ANDs with the category filter, and a filter change resets the See-more page",
          "var mlFilterM = ''" in js
          and "byId('mlFilterM')" in js
          and 'id="mlFilterM"' in html
          and '__m:' in js
          and "var mv = (e.k === 'p' && !e.m) ? 'CC Payment' : (e.m || '');" in js
          and "if (mv !== mlFilterM.slice(4)) return false;" in js
          and "mlfM.onchange = function () { mlFilterM = mlfM.value; mlShownCount = 5; renderMoneyLog(); };" in js
          and ".ml-fbar select+select" in html)
    check("v73.71 (the CC-card ≠ hero diagnosis — the boss's cards-owed 12,295.52 vs the CC card's 9,620.75): prepayBy is an INCREMENTAL accumulator (addAdj only writes it when the txn carries the `account` field), so card charges logged before the per-card field existed bumped the TOTAL adj.card but never the per-card split — the CC card rows (and chat) went stale under the authoritative hero total. Fix: migratePrepayBy rebuilds the split from the txns (the same txnAdj deltas) and reconciles it to adj.card (scaling the missing share in proportionally); it runs on boot (after migratePayoffModel) and on import (after the payoff migration), is idempotent (no write when the split already matches), and sanitizeAdj now keeps the per-card split through exports",
          "function migratePrepayBy()" in js
          and "migratePrepayBy(); // v73.71: one-shot rebuild of the stale per-card prepay split" in js
          and "if (hasSec('txns')) migratePrepayBy();" in js
          and "if (Math.abs(sum - a.card) > 0.004 && sum !== 0) {" in js
          and "migratePrepayBy: migratePrepayBy" in js
          and "prepayBy: pb" in js)
    check("v73.73 (boss-approved mockup_reconcile_money.html): the RECONCILE feature on the Money tab - match the app's running numbers to what the bank shows, SEPARATE from rebase (rebase keeps its 'Adjustment' rows; reconcile files 'Reconcile · <account>' = NEW - LIVE, the discrepancy found, not the delta from the anchor). Two cards: Cards (each CC, live balance, limit + due line) and Cash & Debit (Total cash -> Cash + the debit accounts, the boss's one-wallet hierarchy). Only the DIRECTLY-edited row files: edit Total cash -> the correction is absorbed by Cash (debits stay put) -> ONE Reconcile · Cash row; edit Cash or a debit -> its own row, the total mirrors; no zero rows. The save re-anchors the base to the live values and zeroes the overlay (like rebase), files the Reconcile row (k='a' family so the ✕ reverses the base move; label 'Reconcile' keeps it distinct from a rebase 'Adjustment'), and skips the Adjustment (skipAdjustment). A reconciled card balance flows straight into its due (the due derives from the live balance). The per-debit live display distributes the global cash overlay proportionally to the base values (exact when the overlay is zero); the total is always exact (base - adj.cash)",
          "function reconData()" in js
          and "function reconSetInput(id, v)" in js
          and "function reconChanged(d)" in js
          and "function reconSave()" in js
          and "function fileReconcileRow(name, kind, diff)" in js
          and "l: 'Reconcile', c: 'Reconcile', nt: 'reconciled to the bank'" in js
          and "saveBase(b, { skipAdjustment: true }); // the Reconcile row IS the audit" in js
          and "reconState.vals.cash = r2(v - other);" in js
          and "reconData: reconData" in js
          and "reconSave: reconSave" in js
          and "renderPlans, reconRender]" in js
          and 'id="reconcile"' in html
          and 'id="reconBar"' in html
          and ".reconbar.show{display:flex}" in html
          # v73.75: ".reconrow{display:flex" retargeted to ".lnrow{" — the compact
          # Live-numbers card rows (the reconrow markup died with the old UI)
          and ".lnrow{display:flex" in html)
    check("v73.75 (boss-approved mockup_compact_livenumbers.html): the Money tab's PROJECTION card (and the overlay reset bar that lived inside it) + the Ledger tab's SPEND-PACE card are GONE; the Reconcile UI is now ONE compact 'Live numbers' card in the pace card's old slot (Cards group + Cash & Debit group, tap-to-edit amounts, no LIVE chips, no audit-only note, Will-file box only while editing); the ledger entries lose the 'month spent X → X' chip and the row-tap edit — each entry gets its own ✎ (opens the edit sheet) beside the ✕",
          "function renderProjection" not in js
          and "function renderPace" not in js
          and "function reconStartEdit(id) {" in js
          and "reconStartEdit: reconStartEdit" in js
          and "Live numbers" in js
          and "class=\"lngrp\">Cards</div>" in js
          and "class=\"lngrp\">Cash &amp; Debit</div>" in js
          and "livchip" not in js
          and "Reconcile rows are audit-only" not in js
          and "Tap an entry to edit it" not in js
          and "data-ml-edit=\"" in js
          and "\\u270e</button>" in js  # the ✎ per entry
          and "'month spent ' + money(sBefore)" not in js
          and "data-ml-edit=\"' + esc(e.tid) + '\" title=\"Tap to edit\"" not in js
          and 'id="projection"' not in html
          and "paceBox" not in html
          and ".lnrow{display:flex" in html
          and ".lngrp{" in html)
    check("v73.72 (boss-approved: 'ipf: file theirs as a card charge' + 'increase free cash by the same amount' — the credit converted to cash, since the repayment lands as cash and tmb never files a ledger row): an 'I paid for them' on a CARD files the friend's share as its own card_charge (the bank charged the FULL bill) + a cash_in for the same amount (the advance); net on the boss's own free cash = mine commits, theirs neutralizes. The entry carries the pair handles (theirsTxnId/theirsBumpId) so add-undo / entry-delete / person-delete / edit all remove-and-restore BOTH legs. The one-shot backfill (migrateIpfTheirs, stamp-gated, idempotent) files past entries: post-base get charge + advance, pre-base get the advance ONLY (their card spend is already inside the sheet's base — filing the charge would double-count card owed); runs on boot (after migratePrepayBy) and on import",
          "function fileIpfTheirs(e, p, fileCharge, fileBump)" in js
          and "function migrateIpfTheirs()" in js
          and "migrateIpfTheirs(); // v73.72: one-shot backfill" in js
          and "if (hasSec('owed') && hasSec('txns')) migrateIpfTheirs();" in js
          and "e.theirsTxnId = linkedId;" in js
          and "e.theirsBumpId = bumpId;" in js
          and "function ipfTheirsTxnIds(e)" in js
          and "function removeTxnsQuiet(ids)" in js
          and "migrateIpfTheirs: migrateIpfTheirs" in js
          and "if (dir === 'ipf') {" in js
          and "step = step.then(function () { return fileIpfTheirs(e, p, true, true); });" in js)
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



