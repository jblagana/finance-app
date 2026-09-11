"""Parser smoke test for the coach chat (finance-app/chat.js).

Ports the exact regexes/pipelines from chat.js to Python (the patterns used are
cross-compatible) and checks them against representative inputs, so intent
routing / date / amount parsing regressions are caught locally without a browser.

Run:  python test_chat_parser.py
"""
import calendar
import math
import re
import sys
from datetime import date, timedelta

# Console code pages (cp850/cp1252) can't render every label character (e.g. ₱);
# never let cosmetic printing crash the checks.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass

TODAY = date(2026, 9, 7)  # keep in sync with the test date you run on

MOKEY = {k: i + 1 for i, k in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
MONAME = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:uary|ruary|ch|il|ust|tember|ober|ember)?"
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MONFULL = ["january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december"]


def norm(text):
    """Mirror of chat.js norm() — lowercase + casual-spelling expansion."""
    t = re.sub(r"[\u2019\u2018]", "'", text.lower())
    t = re.sub(r"\bu\b", "you", t)
    t = re.sub(r"\bur\b", "your", t)
    t = re.sub(r"\bwhats\b", "what's", t)
    t = re.sub(r"\bwhos\b", "who's", t)
    t = re.sub(r"\bim\b", "i'm", t)
    t = re.sub(r"\bdont\b", "don't", t)
    t = re.sub(r"\bcant\b", "can't", t)
    t = re.sub(r"\bwont\b", "won't", t)
    t = re.sub(r"\bthx\b", "thanks", t)
    t = re.sub(r"\bty\b", "thanks", t)
    t = re.sub(r"\b(pls|plz)\b", "please", t)
    return re.sub(r"\s+", " ", t).strip()


def iso_of(yy, mm, dd):
    return date(yy, mm, dd).isoformat()


def add_days(iso, n):
    return (date.fromisoformat(iso) + timedelta(days=n)).isoformat()


# ---------- findDateSpan (mirror of chat.js) ----------
def find_date_span(text):
    t = " " + text + " "
    y, m = TODAY.year, TODAY.month
    today = TODAY.isoformat()

    def month_day(mm):
        mo, dd, yy = MOKEY[mm.group(1)[:3]], int(mm.group(2)), y
        if iso_of(yy, mo, dd) < today:
            yy += 1
        return iso_of(yy, mo, dd)

    def day_month(mm):
        dd, mo, yy = int(mm.group(1)), MOKEY[mm.group(2)[:3]], y
        if iso_of(yy, mo, dd) < today:
            yy += 1
        return iso_of(yy, mo, dd)

    def the_n(mm):
        nonlocal y, m
        dd = int(mm.group(1))
        if not (1 <= dd <= 31):
            return None
        s = iso_of(y, m, dd)
        if s < today:
            m += 1
            if m > 12:
                m, y = 1, y + 1
            s = iso_of(y, m, dd)
        return s

    rules = [
        (re.compile(r"(\d{4})-(\d{2})-(\d{2})"), lambda mm: mm.group(0)),
        (re.compile(r"\b" + MONAME + r"\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b"), month_day),
        (re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+" + MONAME + r"\.?\b"), day_month),
        (re.compile(r"\bthe\s+(\d{1,2})(?:st|nd|rd|th)?\b"), the_n),
        (re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)\b"), the_n),
        (re.compile(r"\btoday\b"), lambda mm: today),
        (re.compile(r"\btomorrow\b|\btmr\b"), lambda mm: add_days(today, 1)),
        (re.compile(r"\bnext week\b"), lambda mm: add_days(today, 7)),
        (re.compile(r"\bthis week\b|\bsoon\b"), lambda mm: add_days(today, 1)),
        (re.compile(r"\bnext month\b"), lambda mm: iso_of(y, m + 1, 1) if m < 12 else iso_of(y + 1, 1, 1)),
        (re.compile(r"\bend of (?:the )?month\b|\beom\b"),
         lambda mm: iso_of(y, m, calendar.monthrange(y, m)[1])),
    ]
    best = None
    for rx, fn in rules:
        mm = rx.search(t)
        if mm and (best is None or mm.start() < best[0]):
            best = (mm.start(), mm.group(0), fn(mm))
    return None if not best else {"raw": best[1], "iso": best[2]}


# ---------- findAmount (mirror of chat.js) ----------
def find_amount(text):
    t = text
    m = re.search(r"(?:php|\u20b1|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(k\b)", t, re.I)
    if m:
        return float(m.group(1).replace(",", "")) * 1000
    m = re.search(r"(?:php|\u20b1|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)", t, re.I)
    if m:
        return float(m.group(1).replace(",", ""))
    m = re.search(r"([\d][\d,]*\.\d{1,2})", t)
    if m:
        return float(m.group(1).replace(",", ""))
    m = re.search(r"([\d][\d,]*)\s*(k\b)", t, re.I)
    if m:
        return float(m.group(1).replace(",", "")) * 1000
    m = re.search(r"([\d][\d,]*)", t)
    if m:
        return float(m.group(1).replace(",", ""))
    return None


# ---------- mentionOf (mirror of chat.js) ----------
def mention_of(name, text):
    n = name.lower().strip()
    if not n:
        return False
    t = " " + text.strip() + " "

    def wb(s):
        return re.search(r"\b" + re.escape(s) + r"\b", t) is not None

    if wb(n):
        return True
    for w in n.split():
        if len(w) >= 4 and wb(w):
            return True
    return False

# ---------- v68 item 3: account kind disambiguation (mirrors of chat.js) ----------
# A kind word in the text breaks a name tie ("maya card" vs "maya wallet"), so
# the match resolves without asking. A bare kind word answers the "which one?"
# ask (pendingAsk kind 'kind').
RX_KIND_ANS = re.compile(
    r"^(?:a|the|my|its|it'?s|on)?\s*(?:credit\s+)?(?:card|cc|debit|cash|e-?wallet|wallet|gcash)\b\s*[?.!]*$",
    re.I)


def kind_hint_in(t):
    if re.search(r"\b(?:credit\s+)?card\b|\bcc\b", t):
        return "card"
    if re.search(r"\b(?:debit|cash|e-?wallet|wallet|gcash)\b", t):
        return "debit"
    return None


def find_accounts(text, accounts):
    """Mirror of chat.js findAccounts (v68 item 3).

    Exact-name matches win (longest first); a single exact match also pulls in
    co-candidates that contain the matched name ('maya' -> 'maya e-wallet').
    Several candidates of several kinds: a kind word picks the longest of that
    kind; without one, candidates that share the shortest name -> ambiguous
    (the 'Which maya?' ask); otherwise the first exact match.
    """
    t = " " + (text or "").lower().strip() + " "
    exacts = [a for a in accounts if a["name"].lower() in t]
    exacts.sort(key=lambda a: -len(a["name"]))
    pool = list(exacts)
    if len(exacts) == 1:
        base_n = exacts[0]["name"].lower()
        for a in accounts:
            if a is not exacts[0] and base_n in a["name"].lower() and a not in pool:
                pool.append(a)
    if not exacts:
        for a in accounts:
            wds = re.split(r"[\s/]+", a["name"].lower())
            for w in wds:
                if len(w) >= 4 and w in t:
                    if a not in pool:
                        pool.append(a)
                    break
    if not pool:
        return {"exact": None, "words": []}
    if len(pool) > 1:
        kinds = []
        for a in pool:
            if a["kind"] not in kinds:
                kinds.append(a["kind"])
        if len(kinds) > 1:
            hint = kind_hint_in(t)
            if hint:
                best = None
                for a in pool:
                    if a["kind"] == hint and (best is None or len(a["name"]) > len(best["name"])):
                        best = a
                if best:
                    return {"exact": best, "words": []}
            else:
                by_len = sorted(pool, key=lambda a: len(a["name"]))
                short_n = by_len[0]["name"].lower()
                shared = all(short_n in a["name"].lower() for a in by_len[1:])
                if shared:
                    return {"exact": None, "words": [],
                            "ambiguous": {"word": by_len[0]["name"], "cands": pool}}
    if exacts:
        return {"exact": exacts[0], "words": []}
    return {"exact": None, "words": pool}


# ---------- v35 story mode (mirrors of chat.js helpers) ----------
def lev(a, b):
    m, n = len(a), len(b)
    if abs(m - n) > 3:
        return 99
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                           dp[i - 1][j - 1] + (0 if a[i - 1] == b[j - 1] else 1))
    return dp[m][n]


def clean_tok(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def fuzzy_tok_in(word, toks):
    w = clean_tok(word)
    if len(w) < 3:
        return False
    for tk in toks:
        t = clean_tok(tk)
        if not t:
            continue
        if t == w:
            return True
        mx = 2 if len(w) >= 6 else 1
        if len(t) >= 3 and abs(len(t) - len(w)) <= mx and lev(t, w) <= mx:
            return True
    return False


def cur_month_key():
    return "%04d-%02d" % (TODAY.year, TODAY.month)


def add_months_key(offset):
    y, m = TODAY.year, TODAY.month + offset
    while m < 1:
        m += 12
        y -= 1
    while m > 12:
        m -= 12
        y += 1
    return "%04d-%02d" % (y, m)


def month_key_for(k):
    mk = k + 1
    y = TODAY.year + (1 if mk < TODAY.month else 0)
    return "%04d-%02d" % (y, mk)


def month_prev(k):
    y, m = int(k[:4]), int(k[5:7])
    m -= 1
    if m < 1:
        m, y = 12, y - 1
    return "%04d-%02d" % (y, m)


def month_label(m):
    p = str(m or "").split("-")
    if len(p) == 2:
        return MON[int(p[1]) - 1] + " " + p[0]
    return m or ""


def js_round(x):
    """Mirror of JS Math.round (half up) — floor(x + 0.5)."""
    return int(math.floor(x + 0.5))


def js_round2(x):
    return js_round(x * 100) / 100


def story_month(t):
    for tk in (t or "").split():
        tkc = clean_tok(tk)
        if not tkc:
            continue
        for k in range(len(MON)):
            full, ab = MONFULL[k], MONFULL[k][:3]
            if tkc == full or tkc == ab:
                return month_key_for(k)
            if len(tkc) >= 4 and abs(len(tkc) - len(full)) <= 1 and lev(tkc, full) <= 1:
                return month_key_for(k)
            if len(tkc) >= 4 and abs(len(tkc) - 3) <= 1 and lev(tkc, ab) <= 1:
                return month_key_for(k)
    if re.search(r"\bnext month\b", t):
        return add_months_key(1)
    return None


def is_month_word(s):
    tk = clean_tok(s)
    if not tk:
        return False
    if tk in ("payday", "paydays"):
        return True  # v68 item 2: payday is a timing word, never a name
    for k in range(len(MON)):
        full = MONFULL[k]
        if tk == full or tk == full[:3]:
            return True
        if len(tk) >= 4 and abs(len(tk) - len(full)) <= 1 and lev(tk, full) <= 1:
            return True
    return False


# v68 item 2: a number immediately followed by "%" is a percent, never an
# amount — the guard spans digit/comma/dot continuations so greedy
# backtracking can't peel "10%" down to a "1" (mirror of chat.js findAmounts).
AMT_ALL = re.compile(
    r"(?:php|\u20b1|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)(?![\d,.]*\s*%)\s*(k\b)"
    r"|(?:php|\u20b1|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)(?![\d,.]*\s*%)"
    r"|([\d][\d,]*\.\d{1,2})(?![\d,.]*\s*%)"
    r"|([\d][\d,]*)(?![\d,.]*\s*%)(\s*k\b)?")


def _grp(m, i):
    """Mirror of the chat.js grp() guard — non-participating groups can be ''."""
    v = m.group(i)
    return v if (isinstance(v, str) and v != "") else None


def find_amounts(text):
    out = []
    for m in AMT_ALL.finditer(text):
        n = _grp(m, 1) or _grp(m, 3) or _grp(m, 4) or _grp(m, 5)
        if n is None:
            continue
        amt = float(n.replace(",", ""))
        if _grp(m, 1) is not None and _grp(m, 2) is not None:
            amt *= 1000
        elif _grp(m, 5) is not None and _grp(m, 6) is not None:
            amt *= 1000
        out.append({"raw": m.group(0), "amt": amt, "idx": m.start()})
    return out


def clause_ranges(t):
    rs, s = [], 0
    for m in re.finditer(r"\s*[;,]\s*|\s+and\s+", t):
        if m.start() > s:
            rs.append({"s": s, "e": m.start()})
        s = m.end()
    if s < len(t):
        rs.append({"s": s, "e": len(t)})
    return rs


def is_question(cl):
    return re.match(
        r"^(?:what|whats|who|how|when|where|why|can|could|should|do|does|did|are|am|tell|show|check)\b",
        cl) is not None


def story_names(base):
    b = base or {}
    oneoffs = []
    for mo in (b.get("one_offs") or {}):
        for nm in (b.get("one_offs") or {}).get(mo, {}):
            if nm not in oneoffs:
                oneoffs.append(nm)
    return {
        "budgets": list((b.get("budgets") or {}).keys()),
        "debts": list((b.get("debts") or {}).keys()),
        "oneoffs": oneoffs,
        "sinks": list((b.get("sinking") or {}).keys()),
        "accounts": [{"name": a["name"], "kind": a["kind"]} for a in (b.get("accounts") or [])],
    }


def _name_words(name):
    return [w for w in re.split(r"[\s/]+", (name or "").lower())
            if len(w) >= 3 and w not in ("the", "for", "and")]


def name_score(name, toks):
    wds = _name_words(name)
    if not wds:
        return 0
    hits = sum(1 for w in wds if fuzzy_tok_in(w, toks))
    if not hits:
        return 0
    return 2 if len(wds) == 1 else (2 if hits >= 2 else 1)


def fuzzy_name_in(pool, cl):
    toks = cl.split()
    best, best_score, best_words = None, 0, 0
    for nm in pool:
        wds = _name_words(nm)
        sc = name_score(nm, toks)
        # tie-break: the more specific (fewer words) name wins
        if sc > best_score or (sc == best_score and sc > 0 and len(wds) < best_words):
            best, best_score, best_words = nm, sc, len(wds)
    return best if best_score >= 1 else None


# v69: does the clause name a known entity by an EXACT word? (Fuzzy matching
# would false-positive: "ave" is within one edit of "have".)
def known_entity_in(pool, toks):
    ct = [re.sub(r"[^a-z0-9]", "", str(x).lower()) for x in (toks or [])]
    for nm in (pool or []):
        for w in re.split(r"[\s/]+", str(nm).lower()):
            if len(w) >= 3 and w in ct:
                return nm
    return None


# v69: NEW-account name extraction (mirror of chat.js newAcctName) — the cue
# words, the kind words, the amount and month words are stripped; the rest is
# title-cased. "i have landbank debit 600" -> "Landbank".
ACCT_STOP = {"i", "we", "my", "your", "the", "a", "an", "in", "of", "on", "at",
             "is", "are", "was", "am", "now", "current", "account", "accounts",
             "balance", "balances", "holding", "holds", "have", "has", "got",
             "showing", "available", "left", "remaining", "up", "down", "to",
             "from", "with", "php", "peso", "pesos", "e"}
ACCT_KIND_WDS = {"debit", "credit", "card", "cc", "cash", "wallet", "e-wallet"}


def new_acct_name(cl, amt):
    raws = (amt.get("raw") or "").split() if isinstance(amt, dict) else []
    out = []
    for w in str(cl).split():
        w = re.sub(r"[^a-z0-9\-]", "", w)
        if len(w) < 2:
            continue
        if w in ACCT_STOP or w in ACCT_KIND_WDS:
            continue
        if w[0].isdigit():
            continue
        if w in raws:
            continue
        if is_month_word(w):
            continue
        if len(out) < 3 and w not in out:
            out.append(w)
    if not out:
        return ""
    return " ".join(x[0].upper() + x[1:] for x in out)


BARE_NUM = re.compile(r"^[\d][\d,\.]*\s*(k|php|pesos?)?\.?$")

# ---------- v37 semantic story layer (mirrors of chat.js SEM + semClause) ----------
# Hand-tuned affinity vocabulary. Each candidate type has a "topic" signal (a word
# bucket or a known entity) plus optional action words. Everything is scored, and
# only clauses the v35 regex cues left alone ever reach the scorer.
SEM = {
    "salary": ["salary", "paycheck", "payslip", "take home", "takehome", "take-home",
               "net pay", "netpay", "income"],
    "budget": ["budget", "budgeting", "allowance", "cap", "capped", "limit", "limited",
               "provision", "set aside", "set-aside", "allocation", "allocated"],
    "pay": ["paid", "paying", "pay", "pays", "payment", "payments", "due",
            "remitted", "remittance", "settled", "cleared", "took care of", "handled"],
    "oneoff": ["one-off", "one off", "oneoff", "unexpected", "surprise", "extra",
               "special", "just once", "this once"],
    "recurring": ["monthly", "every month", "each month", "a month", "per month",
                  "subscription", "sub", "installment", "installments", "recurring"],
    "acct": ["balance", "balances", "left", "available", "showing", "holds", "has",
             "have", "got", "up to", "down to", "went up", "went down", "remaining"],
    "change": ["went up", "up to", "down to", "raised", "raise", "hiked", "increased",
               "bumped", "cut", "lowered", "new", "changed", "became", "adjusted"],
    "weak": ["is", "was", "low", "running low", "running high", "high", "bit high"],
}
SEM_HI = 3.0   # at or above: build a draft line (only when required slots are present)
SEM_ASK = 2.0  # at or above, with a required slot missing: ask for the number


def _sem_has(cl, words):
    for w in words:
        if re.search(r"\b" + re.escape(w) + r"\b", cl):
            return True
    return False


SEM_RE_BUDGET_NAME = re.compile(r"\bfor\s+([a-z'&\- ]{2,40}?)(?:\s+(?:is|was|in|this|on)\b|[,;]|\s(?=[\d,])|$)")
SEM_RE_RECURRING_NAME = re.compile(r"\b(?:pay|paying|pays|for|to)\s+([a-z'&\- ]{2,40}?)(?:\s+(?:every|each|monthly|a|per|in|is|for|on)\b|[,;]|\s(?=[\d,])|$)")
SEM_RE_ONEOFF_NAME = re.compile(r"(?:for|called|named)?\s*[:\-]?\s*([a-z][a-z'&\- ]{1,40}?)(?:\s+(?:is|was|in|this|on|for)\b|[,;]|\s(?=[\d,])|$)")


def _sem_amt_in(cl_range, rs, all_amt, t):
    """Same two-pass rule as the v35 amt_in: amount in this clause, else a bare
    number in the immediately following clause. (No after-idx / consumed needed:
    the cues ran first, so no amounts were consumed in this clause.)"""
    for pass_ in (0, 1):
        rr = None
        for x, seg in enumerate(rs):
            if seg["s"] == cl_range["s"] and seg["e"] == cl_range["e"]:
                rr = seg if pass_ == 0 else (rs[x + 1] if x + 1 < len(rs) else None)
                break
        if not rr:
            break
        for i, a in enumerate(all_amt):
            if a["idx"] < rr["s"] or a["idx"] >= rr["e"]:
                continue
            if pass_ == 1 and not BARE_NUM.match(t[rr["s"]:rr["e"]].strip()):
                continue
            return i
    return None


def sem_clause(cl, r, rs, all_amt, names, t, cur):
    """Mirror of chat.js semClause() — semantic candidate for one clause.
    Returns {"line": {label, change}} or {"ask": "..."} or None."""
    if is_question(cl):
        return None
    toks = cl.split()
    month_here = story_month(cl)
    this_month = re.search(r"\bthis month\b", cl) is not None
    month = month_here or (cur if this_month else None)

    sal = _sem_has(cl, SEM["salary"])
    budw = _sem_has(cl, SEM["budget"])
    payw = _sem_has(cl, SEM["pay"])
    oow = _sem_has(cl, SEM["oneoff"])
    recw = _sem_has(cl, SEM["recurring"])
    acctw = _sem_has(cl, SEM["acct"])
    chg = _sem_has(cl, SEM["change"])
    weak = _sem_has(cl, SEM["weak"])

    ent_budget = fuzzy_name_in(names["budgets"], cl)
    ent_debt = fuzzy_name_in(names["debts"], cl)
    ent_account = None
    kind_hint = kind_hint_in(cl)  # v68 item 3: "maya card" resolves a name tie
    for acc in names["accounts"]:
        if kind_hint and acc["kind"] == kind_hint and name_score(acc["name"], toks) >= 1:
            ent_account = acc
            break
    if ent_account is None:
        for acc in names["accounts"]:
            if name_score(acc["name"], toks) >= 1:
                ent_account = acc
                break

    ai = _sem_amt_in(r, rs, all_amt, t)
    has_amt = ai is not None
    amt = all_amt[ai]["amt"] if has_amt else None

    # 1) salary — topic word + amount (month -> override, none -> base salary)
    if sal:
        score = 2.0 + (1.0 if has_amt else 0.0) + (0.5 if month else 0.0)
        if has_amt and score >= SEM_HI:
            ch = ({"type": "salary", "month": month, "amount": amt} if month
                  else {"type": "salary_base", "amount": amt})
            return {"line": {"label": "Salary", "change": ch}}
        if score >= SEM_ASK:
            return {"ask": "What's the new salary?"}
        return None

    # 2) account — known account + balance-ish word + amount
    if ent_account:
        epts = 2.0 if name_score(ent_account["name"], toks) >= 2 else 1.0
        score = epts + (1.5 if (acctw or chg) else (1.0 if weak else 0.0)) + (1.0 if has_amt else 0.0)
        if has_amt and score >= SEM_HI:
            return {"line": {"label": "Account", "change": {"type": "account", "name": ent_account["name"],
                                                            "kind": ent_account["kind"], "value": amt}}}
        if score >= SEM_ASK:
            return {"ask": "What's the current balance for %s?" % ent_account["name"]}
        return None

    # 3) debt payment — known debt + pay/change word + amount + month
    if ent_debt and (payw or chg):
        epts = 2.0 if name_score(ent_debt, toks) >= 2 else 1.0
        score = epts + 1.5 + (1.0 if has_amt else 0.0) + (0.5 if month else 0.0)
        if has_amt and month and score >= SEM_HI:
            return {"line": {"label": "Debt payment", "change": {"type": "debt_payment", "name": ent_debt,
                                                                 "month": month, "amount": amt}}}
        if score >= SEM_ASK:
            if has_amt:
                return {"ask": "Which month is the %s payment for?" % ent_debt}
            return {"ask": "What's the new payment for %s?" % ent_debt}
        return None

    # 4) budget — known budget (or budget word + extracted name) + amount
    nm_b = ent_budget
    if not nm_b and budw:
        m = SEM_RE_BUDGET_NAME.search(cl)
        if m and len(m.group(1).strip()) >= 3 and not is_month_word(m.group(1).strip()):
            nm_b = m.group(1).strip()
    if nm_b and not recw:  # recurring-cadence phrases belong to the recurring candidate
        score = 1.0 + (1.5 if (chg or budw) else (1.0 if weak else 0.0)) + (1.0 if has_amt else 0.0) + (0.5 if month else 0.0)
        if has_amt and score >= SEM_HI:
            ch = ({"type": "budget_override", "month": month, "name": nm_b, "amount": amt} if month
                  else {"type": "budget", "name": nm_b, "amount": amt})
            return {"line": {"label": "Budget", "change": ch}}
        if ent_budget and score >= SEM_ASK:
            return {"ask": "What's the new number for %s?" % nm_b}
        return None

    # 5) recurring — recurring word + amount + name (known or extracted)
    if recw:
        nm_r = fuzzy_name_in(names["debts"] + names["budgets"], cl)
        known = nm_r is not None
        if not nm_r:
            m = SEM_RE_RECURRING_NAME.search(cl)
            if m and len(m.group(1).strip()) >= 3 and not is_month_word(m.group(1).strip()):
                nm_r = m.group(1).strip()
        if nm_r and has_amt:
            score = 2.0 + 1.0 + (2.0 if known else 1.0)
            if score >= SEM_HI:
                months_r = [add_months_key(k) for k in range(6)]
                return {"line": {"label": "Recurring", "change": {"type": "recurring", "name": nm_r,
                                                                  "amount": amt, "months": months_r}}}
        return None

    # 6) one-off — oneoff word + amount + name (known or extracted)
    if oow:
        nm_o = fuzzy_name_in(names["oneoffs"], cl)
        if not nm_o:
            m = SEM_RE_ONEOFF_NAME.search(cl)
            if m and len(m.group(1).strip()) >= 3 and not is_month_word(m.group(1).strip()):
                nm_o = m.group(1).strip()
        if nm_o and has_amt:
            pd_o2 = re.search(r"\b(?:after|before|around|right after|just after|by|on)\s+payday\b", cl) is not None  # v68 item 2
            mo = month_here or (cur if pd_o2 else None) or story_month(t) or cur
            return {"line": {"label": "One-off", "change": {"type": "one_off", "month": mo,
                                                            "name": nm_o, "amount": amt}}}
        return None

    return None


def extract_story(t, base, with_asks=False):
    """Mirror of chat.js extractStory() — list of {label, change}, [] when nothing."""
    lines = []
    asks = []
    if not t:
        return (lines, asks) if with_asks else lines
    names = story_names(base)
    cur = cur_month_key()
    rs = clause_ranges(t)
    all_amt = find_amounts(t)

    def amt_in(r, after_idx, consumed):
        for pass_ in (0, 1):
            rr = None
            for x, seg in enumerate(rs):
                if seg["s"] == r["s"] and seg["e"] == r["e"]:
                    rr = seg if pass_ == 0 else (rs[x + 1] if x + 1 < len(rs) else None)
                    break
            if not rr:
                break
            for i, a in enumerate(all_amt):
                if a["idx"] < rr["s"] or a["idx"] >= rr["e"]:
                    continue
                if pass_ == 0 and after_idx is not None and a["idx"] < after_idx:
                    continue
                if i in consumed:
                    continue
                if pass_ == 1 and not BARE_NUM.match(t[rr["s"]:rr["e"]].strip()):
                    continue
                return i
        return None

    for r in rs:
        cl = t[r["s"]:r["e"]].strip()
        if not cl or len(cl) < 4:
            continue
        consumed = []
        cl_toks = cl.split()
        month_here = story_month(cl)
        n_before = len(lines)  # v37: semantic fallback runs only when the cues left this clause alone

        # 1) salary — month -> override; none -> base salary
        sal_m = re.search(r"\b(?:my\s+|our\s+)?(?:new\s+|base\s+)?salary\b|\bpaycheck\b|\bpayslip\b", cl)
        if sal_m:
            ai = amt_in(r, sal_m.start(), consumed)
            if ai is not None:
                consumed.append(ai)
                a = all_amt[ai]
                if month_here:
                    lines.append({"label": "Salary", "change": {"type": "salary", "month": month_here, "amount": a["amt"]}})
                elif re.search(r"\bthis month\b", cl):
                    lines.append({"label": "Salary", "change": {"type": "salary", "month": cur, "amount": a["amt"]}})
                else:
                    lines.append({"label": "Base salary", "change": {"type": "salary_base", "amount": a["amt"]}})
                continue

        # 1b) v68 item 2: percent of a stored value — "bump food budget by 10%".
        #     The % guard in find_amounts keeps "10" from being read as an amount.
        pct_m = re.search(r"\b(\d+(?:\.\d+)?)\s*%", cl)
        nm_p = fuzzy_name_in(names["budgets"], cl) if pct_m else None
        if pct_m and not sal_m and not is_question(cl) and (re.search(r"\bbudget(?:ing)?\b", cl) or nm_p):
            if not nm_p:
                f_p = re.search(r"\bfor\s+([a-z'&\- ]{2,40}?)(?:\s+(?:is|was|in|this|on|by|to)\b|[,;]|$)", cl)
                if f_p and len(f_p.group(1).strip()) >= 3 and not is_month_word(f_p.group(1).strip()):
                    nm_p = f_p.group(1).strip()
            if nm_p:
                base_p = float((base.get("budgets") or {}).get(nm_p) or 0)
                if base_p > 0:
                    dir_p = -1 if re.search(r"\b(?:down|lower|cut|decrease|reduce|less)\b", cl) else 1
                    new_p = max(0, js_round(base_p * (1 + dir_p * float(pct_m.group(1)) / 100)))
                    mo_p = month_here or (cur if re.search(r"\bthis month\b", cl) else None)
                    lines.append({"label": "Budget",
                                  "change": ({"type": "budget_override", "month": mo_p, "name": nm_p, "amount": new_p}
                                             if mo_p else {"type": "budget", "name": nm_p, "amount": new_p})})
                    continue
                asks.append("What should the %s budget be? I don't have a stored number for it yet." % nm_p)
                continue
            asks.append("Which budget is the %s%% change for?" % pct_m.group(1))
            continue

        # 1c) v68 item 2: "same as last month (, +500)" — last month's stored
        #     value for the named item plus an optional signed delta.
        if re.search(r"\bsame as (?:last|previous) month\b", cl) and not is_question(cl):
            mo_t = month_here or (cur if re.search(r"\bthis month\b", cl) else None) or cur
            prev_m = month_prev(mo_t)
            d_amt, d_signed = 0.0, False
            for dp2 in (0, 1):
                if d_signed:
                    break
                rr2 = None
                for x2, seg in enumerate(rs):
                    if seg["s"] == r["s"] and seg["e"] == r["e"]:
                        rr2 = seg if dp2 == 0 else (rs[x2 + 1] if x2 + 1 < len(rs) else None)
                        break
                if not rr2:
                    break
                for a2 in all_amt:
                    if a2["idx"] < rr2["s"] or a2["idx"] >= rr2["e"]:
                        continue
                    pre2 = t[max(0, a2["idx"] - 9):a2["idx"]]
                    sgn2 = 1
                    if re.search(r"[+-]$", pre2):
                        sgn2 = -1 if pre2.endswith("-") else 1
                    elif re.search(r"\bminus\s*$", pre2):
                        sgn2 = -1
                    elif re.search(r"\b(?:plus|more|higher|above)\s*$", pre2):
                        sgn2 = 1
                    elif dp2 == 0:
                        sgn2 = 1  # bare number in the same clause: "… same as last month 500" = +500
                    elif not re.search(r"[+-]|\b(?:plus|minus)\b", t[rr2["s"]:rr2["e"]]):
                        continue  # a bare number in the NEXT clause is not a delta
                    d_amt = js_round2(a2["amt"] * sgn2)
                    d_signed = True
                    break
            kind_s, nm_s, val_s = None, None, None
            if sal_m:
                so_s = (base.get("salary_overrides") or {}).get(prev_m)
                val_s = float(so_s) if so_s is not None else float(base.get("salary") or float("nan"))
                kind_s, nm_s = "salary", ""
            else:
                nm_bd = fuzzy_name_in(names["budgets"], cl) or fuzzy_name_in(names["budgets"], t)
                nm_oo = fuzzy_name_in(names["oneoffs"], cl) or fuzzy_name_in(names["oneoffs"], t)
                nm_db = fuzzy_name_in(names["debts"], cl) or fuzzy_name_in(names["debts"], t)
                if nm_bd:
                    bo_s = (base.get("budget_overrides") or {}).get(prev_m) or {}
                    val_s = (float(bo_s[nm_bd]) if bo_s.get(nm_bd) is not None
                             else float((base.get("budgets") or {}).get(nm_bd) or float("nan")))
                    kind_s, nm_s = "budget", nm_bd
                elif nm_oo:
                    oo_s = (base.get("one_offs") or {}).get(prev_m) or {}
                    val_s = float(oo_s[nm_oo]) if oo_s.get(nm_oo) is not None else None
                    kind_s, nm_s = "one_off", nm_oo
                elif nm_db:
                    db_s = (base.get("debts") or {}).get(nm_db)
                    val_s = (float(db_s["payments"][prev_m])
                             if db_s and db_s.get("payments") and db_s["payments"].get(prev_m) is not None
                             else None)
                    kind_s, nm_s = "debt", nm_db
            if kind_s and val_s is not None and val_s > 0:
                new_s = max(0, js_round2(val_s + d_amt))
                if kind_s == "salary":
                    ch = {"type": "salary", "month": mo_t, "amount": new_s}
                elif kind_s == "budget":
                    ch = {"type": "budget_override", "month": mo_t, "name": nm_s, "amount": new_s}
                elif kind_s == "one_off":
                    ch = {"type": "one_off", "month": mo_t, "name": nm_s, "amount": new_s}
                else:
                    ch = {"type": "debt_payment", "name": nm_s, "month": mo_t, "amount": new_s}
                lines.append({"label": "Story", "change": ch})
                continue
            if kind_s:
                asks.append("What was the salary in %s?" % month_label(prev_m) if kind_s == "salary"
                            else "I don\u2019t have %s for %s \u2014 what was the amount?" % (nm_s, month_label(prev_m)))
                continue
            if lines and not d_signed:
                continue  # a bare "same as last month" after an already-drafted line is a restatement
            asks.append("Which one should be the same as last month? Name it \u2014 e.g. \u201cwater, same as last month +500\u201d")
            continue

        # 2) budget with an explicit cue — "budget for food is 8k"
        bud_m = re.search(r"\bbudget(?:ing)?(?:\s+for)?\b", cl)
        if bud_m:
            ai_b = amt_in(r, bud_m.start(), consumed)
            if ai_b is not None:
                consumed.append(ai_b)
                a_b = all_amt[ai_b]
                nm_b = fuzzy_name_in(names["budgets"], cl)
                if not nm_b:
                    f_b = re.search(r"\bfor\s+([a-z'&\- ]{2,40}?)(?:\s+(?:is|was|in|this|on)\b|[,;]|\s(?=[\d,])|$)", cl[bud_m.start():])
                    if f_b and len(f_b.group(1).strip()) >= 3 and not is_month_word(f_b.group(1).strip()):
                        nm_b = f_b.group(1).strip()
                if nm_b:
                    mo_b = month_here or (cur if re.search(r"\bthis month\b", cl) else None)
                    if mo_b:
                        lines.append({"label": "Budget", "change": {"type": "budget_override", "month": mo_b, "name": nm_b, "amount": a_b["amt"]}})
                    else:
                        lines.append({"label": "Budget", "change": {"type": "budget", "name": nm_b, "amount": a_b["amt"]}})
                    continue

        # 3) one-off — "one-off: december power bill 1500"
        oo_m = re.search(r"\bone[- ]?offs?\b", cl)
        if oo_m:
            ai_o = amt_in(r, oo_m.start(), consumed)
            if ai_o is not None:
                consumed.append(ai_o)
                a_o = all_amt[ai_o]
                nm_o = fuzzy_name_in(names["oneoffs"], cl)
                if not nm_o:
                    f_o = re.match(r"^\s*(?:for|called|named)?\s*[:\-]?\s*([a-z'&\- ]{2,40}?)(?:\s+(?:in|for|on)\s+[a-z]{3,}\b|[,;]|\s(?=[\d,])|\s*$)", cl[oo_m.end():])
                    if f_o and len(f_o.group(1).strip()) >= 3 and not is_month_word(f_o.group(1).strip()):
                        nm_o = f_o.group(1).strip()
                if nm_o:
                    pd_o = re.search(r"\b(?:after|before|around|right after|just after|by|on)\s+payday\b", cl) is not None  # v68 item 2
                    mo_o = month_here or (cur if pd_o else None) or story_month(t) or cur
                    lines.append({"label": "One-off", "change": {"type": "one_off", "month": mo_o, "name": nm_o, "amount": a_o["amt"]}})
                    continue

        # 4) recurring — "gym is 2000 every month"
        rec_m = re.search(r"\b(?:every|each)\s+month\b|\bmonthly\b", cl)
        if rec_m:
            ai_r = amt_in(r, None, consumed)
            if ai_r is not None:
                consumed.append(ai_r)
                a_r = all_amt[ai_r]
                nm_r = fuzzy_name_in(names["debts"] + names["budgets"], cl)
                if not nm_r:
                    f_r = re.search(r"\b(?:pay|paying|pays|for|to)\s+([a-z'&\- ]{2,40}?)(?:\s+(?:every|each|monthly|in|is|for|on)\b|[,;]|\s(?=[\d,])|$)", cl)
                    if f_r and len(f_r.group(1).strip()) >= 3 and not is_month_word(f_r.group(1).strip()):
                        nm_r = f_r.group(1).strip()
                if nm_r:
                    months_r = [add_months_key(k) for k in range(6)]
                    lines.append({"label": "Recurring", "change": {"type": "recurring", "name": nm_r, "amount": a_r["amt"], "months": months_r}})
                    continue

        # 5) debt payment for a known debt — "ave payment in october is 2200"
        if re.search(r"\b(?:pay|pays|paying|payment|payments|due)\b", cl):
            nm_d = fuzzy_name_in(names["debts"], cl)
            if nm_d:
                ai_d = amt_in(r, None, consumed)
                if ai_d is not None:
                    consumed.append(ai_d)
                    a_d = all_amt[ai_d]
                    pd_d = re.search(r"\b(?:after|before|around|right after|just after|by|on)\s+payday\b", cl) is not None  # v68 item 2
                    mo_d = month_here or (cur if pd_d else None) or story_month(t)
                    if mo_d:
                        lines.append({"label": "Debt payment", "change": {"type": "debt_payment", "name": nm_d, "month": mo_d, "amount": a_d["amt"]}})
                        continue

        # 6) casual budget update for a known budget — "water went up to 1800"
        if not is_question(cl) and not re.search(r"\b(?:every|each)\s+month\b|\bmonthly\b|\ba month\b|\bper month\b", cl):
            nm_c = fuzzy_name_in(names["budgets"], cl)
            if nm_c:
                ai_c = amt_in(r, None, consumed)
                if ai_c is not None:
                    consumed.append(ai_c)
                    a_c = all_amt[ai_c]
                    mo_c = month_here or (cur if re.search(r"\bthis month\b", cl) else None)
                    if mo_c:
                        lines.append({"label": "Budget", "change": {"type": "budget_override", "month": mo_c, "name": nm_c, "amount": a_c["amt"]}})
                    else:
                        lines.append({"label": "Budget", "change": {"type": "budget", "name": nm_c, "amount": a_c["amt"]}})
                    continue

        # 7) account balance update — "gcash balance is 50k"
        # v69: also NEW accounts ("i have landbank debit 600" drafts a debit
        # account "Landbank"); the spoken kind word beats the stored kind;
        # debit is the DEFAULT kind; known budgets/debts/one-offs/sinks never
        # become new accounts.
        nm_a = None
        kind_hint_a = kind_hint_in(cl)  # v68 item 3: "maya card" resolves a name tie
        for acc in names["accounts"]:
            if kind_hint_a and acc["kind"] == kind_hint_a and name_score(acc["name"], cl_toks) >= 1:
                nm_a = acc
                break
        if nm_a is None:
            for acc in names["accounts"]:
                if name_score(acc["name"], cl_toks) >= 1:
                    nm_a = acc
                    break
        if not is_question(cl) and re.search(r"\b(?:balance|left|has|have|got|showing|available)\b", cl):
            ai_a = amt_in(r, None, consumed)
            if ai_a is not None:
                consumed.append(ai_a)
                a_a = all_amt[ai_a]
                if nm_a:
                    kind_a = kind_hint_a or nm_a["kind"]  # v69: the spoken kind word wins
                    lines.append({"label": "Account", "change": {"type": "account", "name": nm_a["name"], "kind": kind_a, "value": a_a["amt"]}})
                elif not (known_entity_in(names["budgets"], cl_toks) or known_entity_in(names["debts"], cl_toks)
                          or known_entity_in(names["oneoffs"], cl_toks) or known_entity_in(names["sinks"], cl_toks)):
                    nm_n = new_acct_name(cl, a_a)  # v69: new account, title-cased
                    if nm_n:
                        kind_n = kind_hint_a or "debit"  # v69: debit is the default kind
                        lines.append({"label": "Account", "change": {"type": "account", "name": nm_n, "kind": kind_n, "value": a_a["amt"]}})

        # v37: semantic fallback for clauses the v35 cues left alone
        if len(lines) == n_before:
            s = sem_clause(cl, r, rs, all_amt, names, t, cur)
            if s:
                if s.get("line"):
                    lines.append(s["line"])
                elif s.get("ask"):
                    asks.append(s["ask"])

    if with_asks:
        asks = list(dict.fromkeys(asks))[:2]
        return lines, asks
    return lines


def story_parse(t, base):
    """Mirror of chat.js storyParse() — {"lines": [...], "asks": [...]}."""
    lines, asks = extract_story(t, base, with_asks=True)
    return {"lines": lines, "asks": asks}


def story_asks(t, base):
    return story_parse(t, base)["asks"]


# ---------- plan-name extraction (mirror of chat.js intentPlanAdd) ----------
def plan_add_parse(text):
    lead = re.search(r"^(?:add|make|log|new)\s+(?:a\s+|an\s+)?plan\b\s*", text) \
        or re.search(r"^plan\b\s*:?\s*", text) \
        or re.search(r"^\bplanning\b\s*", text)
    if not lead:
        return None
    rest = text[lead.end():]
    dm = find_date_span(rest)
    rest2 = rest.replace(dm["raw"], " ") if dm else rest
    m_amt = None
    for rx in [re.compile(r"(?:php|\u20b1|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(k\b)", re.I),
               re.compile(r"(?:php|\u20b1|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)", re.I),
               re.compile(r"([\d][\d,]*\.\d{1,2})"),
               re.compile(r"([\d][\d,]*)\s*(k\b)", re.I),
               re.compile(r"([\d][\d,]*)")]:
        m_amt = rx.search(rest2)
        if m_amt:
            break
    if not m_amt:
        return None
    amt = float(m_amt.group(1).replace(",", ""))
    if m_amt.lastindex and m_amt.lastindex >= 2 and m_amt.group(2):
        amt *= 1000
    name = re.sub(r"\s+", " ", rest2.replace(m_amt.group(0), " ")).strip(" :,-").strip()
    name = re.sub(r"^(?:for|of|about|on)\s+", "", name)
    name = re.sub(r"\s+(?:for|of|about|on)$", "", name)
    return {"name": name.strip(), "amt": amt, "date": dm["iso"] if dm else TODAY.isoformat()}


# ---------- intent routing (mirror of dispatch order + triggers) ----------
URGENT = re.compile(
    r"\b(urgent|emergency|emergencies|unexpected|unplanned|unforeseen|unbudgeted|came up|"
    r"just (?:got|received|found out|found|hit|been told)|oops|ugh|yikes)\b"
    r"|\bneed(?:s|ed)? (?:to )?pay\b")
DEBTS = ["Ave", "EEEI", "Home Credit"]
ONE_OFFS = ["Back rent for July", "December power bill"]
SINKING = ["Christmas & Holiday"]
PLANS_SAMPLE = ["shoes", "gym", "car repair"]

# v35: the stored base the story parser matches names against (mirror fixture)
SAMPLE_BASE = {
    "budgets": {"Water": 1500, "Food / Gym Nutrition": 8000, "Gym Membership": 2000},
    "debts": {"Ave": {"monthly": 2200}, "EEEI": {"monthly": 900}},
    "one_offs": {"2026-07": {"Back rent for July": 5000}},
    "sinking": {"Christmas & Holiday": {"goal": 15000}},
    "accounts": [
        {"name": "GCash", "kind": "debit", "value": 12000},  # v65: cash kind renamed to debit
        {"name": "Maya", "kind": "card", "value": 0, "limit": 50000},
    ],
}


# v43: personal lexicon — your phrasings map to a known concept (a canonical
# question the rule engine already answers). Mirrors chat.js CONCEPTS/AMBIG/learn.
CONCEPTS = {
    "spend:month": {"q": "what did i spend this month"},
    "spend:week": {"q": "what did i spend this week"},
    "plans": {"q": "show my plans"},
    "status": {"q": "status"},
}
AMBIG = [
    (re.compile(r"\b(?:log|logs|logging|ledger|entries?|receipts?)\b"),
     ["spend:month", "spend:week", "plans", "status"]),
]
LEX = {}  # normalized phrase -> concept id (learn() adds to this)


def learn(phrase, cid):
    LEX[norm(phrase)] = cid


def route(text):
    t = norm(text)
    if re.match(r"^(help|\?+|what can you do|what do you do|what can i ask|how do you work|commands|abilities)\b", t):
        return "help"
    if (re.match(r"^(hi|hiya|hey|hello|yo|um|sup)([!.? ,]*)$", t)
            or re.match(r"^good (morning|afternoon|evening)\b", t)
            or re.match(r"^(what'?s up|how'?s it going|how are you(?: doing)?|hey there)\b", t)):
        return "greet"
    if re.search(r"\b(remove|delete|drop|cancel|kill|forget|unplan)\b", t):
        if any(mention_of(p, t) for p in PLANS_SAMPLE) or re.search(r"\bplan\b", t):
            return "plan_remove"
    if (re.search(r"^(?:add|make|log|new)\s+(?:a\s+|an\s+)?plan\b\s*", t)
            or re.search(r"^plan\b\s*:?\s*", t) or re.search(r"^\bplanning\b\s*", t)):
        return "plan_add"
    if re.search(r"\bplans?\b|\bwhat'?s (?:planned|coming up|coming)\b|\bupcoming\b", t):
        if not (re.search(r"\b" + MONAME + r"\b", t) and not re.search(r"\bplans?\b", t)):
            return "plan_list"
    if URGENT.search(t):
        return "urgent"
    cmd = re.match(r"^(log|record|add|note)\b", t)
    # v69: the subject can be dropped ("ate at jollibee 250") and "ate" counts
    casual = re.match(r"^(?:(?:i|we)\s+(?:(?:just|already|did)\s+)?)?(?:paid|bought|spent|ate|charged|gave|sent|swiped|used)\b", t)
    if (cmd or casual) and (casual or re.search(r"\b(expense|spend|spent|charge|paid|payment|bought)\b", t)):
        return "log"
    if re.search(r"charge|swipe|cash[- ]back", t) or re.search(r"\bcan\b.*\bbuy\b", t):
        return "deficit"
    if re.search(r"\b(spend|spent|spending)\b", t) and (
            re.search(r"\b(today|yesterday|week|month)\b", t) or any(mention_of(c, t) for c in ["food", "gym", "rent"])):
        return "spend"
    if extract_story(t, SAMPLE_BASE) or story_asks(t, SAMPLE_BASE):
        return "story"
    for d in DEBTS:
        if mention_of(d, t):
            return "debt"
    if any(mention_of(o, t) for o in ONE_OFFS) or re.search(r"one[- ]?off", t):
        return "oneoff"
    if any(mention_of(s, t) for s in SINKING) or re.search(r"sinking|savings goal|holiday", t):
        return "sinking"
    if (re.search(r"\bborrow\b|\bpartner\b|\bridge\b", t) or re.search(r"\bworst[- ]?case\b|\bemergenc", t)
            or re.search(r"\b" + MONAME + r"\b", t) or re.search(r"\bnext month\b", t)
            or re.search(r"\b(project|projection|forecast|runway|trajectory|next (?:few )?months|how (?:far|long) (?:will|does)|will i (?:make it|be ok|be fine)|break even|through february|the plan)\b", t)):
        return "future"
    if (re.search(r"\bfree\b|\bunallocated\b|\bheadroom\b|\bhow much (?:can i |do i )?spend\b|\bcan i spend\b", t)
            or re.search(r"\b(?:liquid )?cash\b|\bbalances?\b|\bhow much (?:money|cash)(?: do i | i )?have\b", t)
            or (re.search(r"\bcards?\b", t) and re.search(r"\b(owe|owed|balance|total|due)\b", t))
            or re.search(r"\bpre-?pay\b|\b14th\b|\bcard (?:payment|due|reset)\b", t)
            or re.search(r"\butiliz", t)
            or re.search(r"\b(status|summary|overview|big picture|how am i doing|where do i stand|recap)\b", t)):
        return "status"
    # v43: the rules didn't own it. A learned phrasing routes to its concept
    # (deterministic, mirroring chat.js runConcept -> runRules); a seeded
    # known-ambiguous phrasing asks once. Neither writes.
    if t in LEX:
        return route(CONCEPTS[LEX[t]]["q"])
    for rx, _concepts in AMBIG:
        if rx.search(t):
            return "clarify"
    return "fallback"


FAILS = []


def check(label, got, want):
    ok = got == want
    status = "OK" if ok else ("FAIL want: %s" % (want,))
    print("  %-52s %s  (got: %s)" % (label, status, got))
    if not ok:
        FAILS.append(label)


def main():
    print("== dates (today = %s) ==" % TODAY)
    dates = [
        ("the 20th", "2026-09-20"),
        ("on the 20th", "2026-09-20"),
        ("20th", "2026-09-20"),
        ("oct 5", "2026-10-05"),
        ("5 oct", "2026-10-05"),
        ("october 3", "2026-10-03"),
        ("september 2", "2027-09-02"),
        ("today", TODAY.isoformat()),
        ("tomorrow", "2026-09-08"),
        ("next week", "2026-09-14"),
        ("this week", "2026-09-08"),
        ("next month", "2026-10-01"),
        ("end of month", "2026-09-30"),
        ("the 3rd", "2026-10-03"),
        ("2026-10-05", "2026-10-05"),
        ("15th", "2026-09-15"),
    ]
    for text, want in dates:
        r = find_date_span(text)
        check("date: %r" % text, r["iso"] if r else None, want)

    print("\n== amounts ==")
    amts = [
        ("shoes 1500", 1500),
        ("php 8,000", 8000),
        ("\u20b18000", 8000),
        ("8k", 8000),
        ("2,000", 2000),
        ("1,500.50", 1500.5),
        ("charge 2500 on maya", 2500),
        ("plan 1500", 1500),
        ("1828 pesos", 1828),
        ("25k", 25000),
    ]
    for text, want in amts:
        check("amount: %r" % text, find_amount(text), float(want))

    print("\n== plan parsing ==")
    plans = [
        ("plan: shoes 1500 on the 20th", ("shoes", 1500, "2026-09-20")),
        ("add plan car repair 8,000 this week", ("car repair", 8000, "2026-09-08")),
        ("plan: eat out, 2,000, october 3", ("eat out", 2000, "2026-10-03")),
        ("planning gym renewal 1200", ("gym renewal", 1200, TODAY.isoformat())),
        ("plan: shoes on the 20th 1500", ("shoes", 1500, "2026-09-20")),
    ]
    for text, want in plans:
        r = plan_add_parse(text)
        got = (r["name"], int(r["amt"]) if r and r["amt"] == int(r["amt"]) else r["amt"], r["date"]) if r else None
        check("plan: %r" % text, got, want)

    print("\n== mention (word-boundary) ==")
    checks = [
        (mention_of("Ave", "what is above my limit"), False),
        (mention_of("Ave", "how is my ave doing"), True),
        (mention_of("EEEI", "when do i finish eeei"), True),
        (mention_of("Home Credit", "what's my home credit balance"), True),
        (mention_of("Christmas & Holiday", "how is my christmas fund doing"), True),
        (mention_of("Back rent for July", "what's the back rent one-off"), True),
        (mention_of("Food / Gym Nutrition", "how much did I spend on food"), True),
    ]
    for got, want in checks:
        check("mention -> %s" % want, got, want)

    print("\n== intent routing ==")
    routes = [
        ("help", "help"),
        ("hi", "greet"),
        ("remove the shoes plan", "plan_remove"),
        ("plan: shoes 1500 on the 20th", "plan_add"),
        ("show my plans", "plan_list"),
        ("urgent: car repair 8,000 this week", "urgent"),
        ("Urgent expense", "urgent"),
        ("log expense 500 food maya", "log"),
        ("can I charge 2,500 on Maya?", "deficit"),
        ("check a charge", "deficit"),
        ("is 2500 cash backed", "deficit"),
        ("how much did I spend this month", "spend"),
        ("how much did I spend on food", "spend"),  # category cue, no time word
        ("what's my home credit balance", "debt"),
        ("when do I finish eeei", "debt"),
        ("what's above my free cash", "status"),  # 'above' must NOT hit the Ave debt
        ("what's coming up", "plan_list"),
        ("what's coming up in december", "oneoff"),  # December one-offs are the right sheet-side answer
        ("what's my cash in feb", "future"),
        ("borrow from partner", "future"),
        ("worst case", "future"),
        ("how much is free?", "status"),
        ("my 14th prepay", "status"),
        ("where do i stand", "status"),
        ("how much can i spend", "status"),
        ("how is my christmas fund doing", "sinking"),
        ("what's the back rent one-off", "oneoff"),
        ("how is the weather", "fallback"),
        ("i paid for spaylater today 1828 pesos", "log"),  # v35 casual past tense
        ("i just bought shoes 1500", "log"),
        ("what can u do", "help"),  # v35 norm: u -> you
        ("whats up", "greet"),  # v35 norm: whats -> what's
        ("my salary in october is 25k", "story"),
        ("water went up to 1800", "story"),
        ("my salary in october is 25k, water went up to 1800", "story"),
        ("one-off: december power bill 1500", "story"),
        ("gym is 2000 every month", "story"),
        ("ave payment in october is 2200", "story"),
        ("gcash balance is 50k", "story"),
        # v37 semantic (cues miss, scorer catches)
        ("my take home was 23k", "story"),
        ("gcash is down to 4k now", "story"),
        ("i already remitted the ave for october, 2200", "story"),
        ("ave got a raise", "story"),  # ask, not a line
        ("gcash is low", "story"),
        ("i'm now paying 499 a month for netflix", "story"),
    ]
    for text, want in routes:
        check("route: %r" % text, route(text), want)

    print("\n== v43 personal lexicon + clarification ==")
    # first time: a known-ambiguous phrasing asks (and never writes)
    check("ambiguous 'whats my log' -> clarify (no write)", route("whats my log"), "clarify")
    check("ambiguous 'what i log' -> clarify", route("what i log"), "clarify")
    check("ambiguous 'show me my ledger' -> clarify", route("show me my ledger"), "clarify")
    # after the pick, the phrasing routes deterministically to its concept
    learn("whats my log", "spend:month")
    check("learned 'whats my log' -> spend (deterministic)", route("whats my log"), "spend")
    learn("my stuff", "plans")
    check("learned 'my stuff' -> plan_list", route("my stuff"), "plan_list")
    # rules ALWAYS win over the lexicon (a bad mapping can't override a real rule)
    learn("how much did i spend this month", "plans")
    check("rules beat lexicon (spend still wins)", route("how much did i spend this month"), "spend")
    # a low-confidence, non-ambiguous open question still falls through to the coach
    check("unknown open question -> coach fallback", route("hmm my money is a mess"), "fallback")
    # the clarification path never produces a write intent
    LEX.clear()
    for phrase in ["whats my log", "what i log", "my receipts"]:
        check("clarify for %r is not a write" % phrase,
              route(phrase) not in ("log", "plan_add", "story", "deficit"), True)
    LEX.clear()

    print("\n== story extraction (v35) ==")

    def sig(lines):
        out = []
        for l in lines:
            ch = l["change"]
            val = ch.get("amount", ch.get("value"))
            out.append((ch["type"], ch.get("month"), round(val), (ch.get("name") or "").lower()))
        return out

    story_cases = [
        ("my salary in october is 25k", [("salary", "2026-10", 25000, "")]),
        ("my salary is 25k", [("salary_base", None, 25000, "")]),
        ("water went up to 1800", [("budget", None, 1800, "water")]),
        ("my salary in october is 25k, water went up to 1800",
         [("salary", "2026-10", 25000, ""), ("budget", None, 1800, "water")]),
        ("one-off: december power bill 1500", [("one_off", "2026-12", 1500, "december power bill")]),
        ("gym is 2000 every month", [("recurring", None, 2000, "gym membership")]),
        ("ave payment in october is 2200", [("debt_payment", "2026-10", 2200, "ave")]),
        ("gcash balance is 50k", [("account", None, 50000, "gcash")]),
        ("how much is in gcash", []),  # question: no amount, no write
        ("the sky is blue", []),
        # v69: new-account grammar (debit default; kind word stripped from the name)
        ("i have landbank debit 600", [("account", None, 600, "landbank")]),
        ("i have landbank 600", [("account", None, 600, "landbank")]),
    ]
    for text, want in story_cases:
        got = sig(extract_story(norm(text), SAMPLE_BASE))
        check("story: %r" % text, got, want)

    print("\n== fuzzy months (v35) ==")
    month_cases = [
        ("in septmber", "2026-09"),  # typo of september == current month
        ("jane 20", "2027-01"),  # typo of jan, already passed -> next year
        ("october", "2026-10"),
        ("next month", "2026-10"),
        ("no month here", None),
        # v37: 3-letter tokens must NOT fuzzy-match month abbreviations
        ("pay", None),
        ("day", None),
        ("set", None),
    ]
    for text, want in month_cases:
        check("storyMonth: %r" % text, story_month(text), want)

    print("\n== semantic story (v37) ==")
    sem_cases = [
        # semantic-only positives (v35 cues miss these)
        ("my take home was 23k", [("salary_base", None, 23000, "")], []),
        ("my take home in october was 23k", [("salary", "2026-10", 23000, "")], []),
        ("i already remitted the ave for october, 2200", [("debt_payment", "2026-10", 2200, "ave")], []),
        ("gcash is down to 4k now", [("account", None, 4000, "gcash")], []),
        ("gcash is 50k", [("account", None, 50000, "gcash")], []),
        ("i'm now paying 499 a month for netflix", [("recurring", None, 499, "netflix")], []),
        ("i pay 2000 a month for the gym", [("recurring", None, 2000, "gym membership")], []),
        ("unexpected: dentist 3000", [("one_off", "2026-09", 3000, "dentist")], []),
        # ask-card cases (known topic, missing number)
        ("ave got a raise", [], ["ave"]),
        ("gcash is low", [], ["gcash"]),
        ("food's running high", [], ["food"]),
        ("my salary was great", [], ["salary"]),
        # regression shield: v35 cue phrases must be byte-identical
        ("my salary in october is 25k", [("salary", "2026-10", 25000, "")], []),
        ("my salary is 25k", [("salary_base", None, 25000, "")], []),
        ("water went up to 1800", [("budget", None, 1800, "water")], []),
        ("one-off: december power bill 1500", [("one_off", "2026-12", 1500, "december power bill")], []),
        ("gym is 2000 every month", [("recurring", None, 2000, "gym membership")], []),
        ("ave payment in october is 2200", [("debt_payment", "2026-10", 2200, "ave")], []),
        ("gcash balance is 50k", [("account", None, 50000, "gcash")], []),
        # negatives: no line, no ask
        ("how much is in gcash", [], []),
        ("the sky is blue", [], []),
        ("when do i finish ave", [], []),
        ("i paid for spaylater today 1828 pesos", [], []),
        ("borrow from partner", [], []),
        ("a month ago i paid 5000", [], []),  # recurring word, no name -> nothing
    ]
    for text, want_lines, want_asks in sem_cases:
        parsed = story_parse(norm(text), SAMPLE_BASE)
        check("sem lines: %r" % text, sig(parsed["lines"]), want_lines)
        got_asks = parsed["asks"]
        ok = len(got_asks) == len(want_asks)
        if ok:
            for got, want in zip(got_asks, want_asks):
                if want.lower() not in got.lower():
                    ok = False
                    break
        if ok:
            print("PASS  sem asks: %r -> %s" % (text, got_asks))
        else:
            print("FAIL  sem asks: %r got=%s want~= %s" % (text, got_asks, want_asks))
            FAILS.append("sem asks: %r" % text)

    print("\n== v68 item 2: story grammar (percent / delta / payday) ==")
    # The findAmounts % guard: a number followed by "%" is a percent, never an
    # amount (the regexes are mirrored verbatim from chat.js).
    check("amounts: '10%' is not an amount", find_amounts("bump food budget by 10%"), [])
    check("amounts: '1,500.50' still parses", [a["amt"] for a in find_amounts("bill 1,500.50")], [1500.5])
    check("amounts: '25k' still parses", [a["amt"] for a in find_amounts("salary 25k")], [25000])
    check("month-word: 'payday' is a timing word, never a name", is_month_word("payday"), True)
    check("month-word: 'paydays' is a timing word, never a name", is_month_word("paydays"), True)

    v68_story_cases = [
        # percent of a stored value (cue 1b)
        ("bump food budget by 10%", SAMPLE_BASE,
         [("budget", None, 8800, "food / gym nutrition")], []),
        ("cut food budget by 5%", SAMPLE_BASE,
         [("budget", None, 7600, "food / gym nutrition")], []),
        ("bump food budget by 10% in october", SAMPLE_BASE,
         [("budget_override", "2026-10", 8800, "food / gym nutrition")], []),
        ("bump budget by 10%", SAMPLE_BASE, [], ["which budget"]),
        ("bump gym budget by 10%", {"budgets": {"Gym": 0}}, [], ["stored number"]),
        # delta vs last month (cue 1c) — prev-month override -> base -> missing ask
        ("water in october same as last month +500", SAMPLE_BASE,
         [("budget_override", "2026-10", 2000, "water")], []),
        ("water same as last month 200", SAMPLE_BASE,
         [("budget_override", "2026-09", 1700, "water")], []),
        ("water in october same as last month",
         {"budgets": {"Water": 1500}, "budget_overrides": {"2026-09": {"Water": 1800}}},
         [("budget_override", "2026-10", 1800, "water")], []),  # sept override wins
        ("salary in october same as last month", {"salary": 25000},
         [("salary", "2026-10", 25000, "")], []),
        # the delta in its own clause (a clause with salary + amount is cue 1's: the amount IS the salary)
        ("my salary same as last month, +1000", {"salary": 25000},
         [("salary", "2026-09", 26000, "")], []),
        ("salary in october same as last month", SAMPLE_BASE, [], ["what was the salary"]),
        ("power bill in october same as last month",
         {"one_offs": {"2026-09": {"Power bill": 1500}}},
         [("one_off", "2026-10", 1500, "power bill")], []),
        ("ave in october same as last month -200",
         {"debts": {"Ave": {"payments": {"2026-09": 2200}}}},
         [("debt_payment", "2026-10", 2000, "ave")], []),
        ("same as last month +500", SAMPLE_BASE, [], ["which one"]),
        # payday-anchored timing (cues 3 + 5)
        ("one-off: car insurance 5000 after payday", SAMPLE_BASE,
         [("one_off", "2026-09", 5000, "car insurance")], []),
        ("ave payment after payday is 2200", SAMPLE_BASE,
         [("debt_payment", "2026-09", 2200, "ave")], []),
        ("one-off: payday 500", SAMPLE_BASE, [], []),  # payday is never a name
    ]
    for text, base, want_lines, want_asks in v68_story_cases:
        parsed = story_parse(norm(text), base)
        check("v68 story lines: %r" % text, sig(parsed["lines"]), want_lines)
        got_asks = parsed["asks"]
        ok = len(got_asks) == len(want_asks)
        if ok:
            for got, want in zip(got_asks, want_asks):
                if want.lower() not in got.lower():
                    ok = False
                    break
        if ok:
            print("PASS  v68 story asks: %r -> %s" % (text, got_asks))
        else:
            print("FAIL  v68 story asks: %r got=%s want~= %s" % (text, got_asks, want_asks))
            FAILS.append("v68 story asks: %r" % text)

    print("\n== v68 item 3: account kind disambiguation ==")
    KIND_BASE = {
        "budgets": {"Water": 1500},
        "accounts": [
            {"name": "Maya", "kind": "card", "value": 0, "limit": 50000},
            {"name": "Maya e-wallet", "kind": "debit", "value": 3000},
            {"name": "GCash", "kind": "debit", "value": 12000},
        ],
    }
    kind_accts = [{"name": a["name"], "kind": a["kind"]} for a in KIND_BASE["accounts"]]

    # findAccounts: a shared word across kinds with no kind word -> the "which
    # one?" ask; a kind word breaks the tie.
    amb = find_accounts("can i charge 2500 on maya", kind_accts)
    check("kind: shared word, no kind word -> ambiguous",
          (amb.get("ambiguous") or {}).get("word"), "Maya")
    check("kind: the ambiguous match keeps both candidates",
          [c["name"] for c in (amb.get("ambiguous") or {}).get("cands", [])],
          ["Maya", "Maya e-wallet"])
    check("kind: 'maya card' resolves to the card",
          (find_accounts("maya card limit is 70k", kind_accts).get("exact") or {}).get("name"), "Maya")
    check("kind: 'maya wallet' resolves to the e-wallet",
          (find_accounts("maya wallet balance is 3k", kind_accts).get("exact") or {}).get("name"), "Maya e-wallet")
    check("kind: a single-kind match is never ambiguous",
          (find_accounts("gcash balance is 5k", kind_accts).get("exact") or {}).get("name"), "GCash")
    # RX_KIND_ANS: a bare kind word is the answer to the "which one?" ask.
    for ans, want in [("card", True), ("the card", True), ("e-wallet", True),
                      ("gcash", True), ("the card please", False), ("cards", False)]:
        check("kind answer: %r" % ans, RX_KIND_ANS.match(norm(ans)) is not None, want)

    # The ask -> answer round-trip: handleCore asks BEFORE any intent runs, so
    # the joined "message + kind" is re-parsed through exactly the same cues.
    def kind_roundtrip(t):
        fa = find_accounts(t, kind_accts)
        if fa.get("ambiguous"):
            return {"lines": [], "ask": "Which %s?" % fa["ambiguous"]["word"]}
        return story_parse(t, KIND_BASE)

    rt1 = kind_roundtrip(norm("maya balance is 9k"))
    check("kind: bare 'maya balance' asks 'Which Maya?' (no draft)", rt1.get("ask"), "Which Maya?")
    check("kind: answer 'card' joined -> drafts the card",
          sig(kind_roundtrip(norm("maya balance is 9k card"))["lines"]),
          [("account", None, 9000, "maya")])
    check("kind: answer 'wallet' joined -> drafts the e-wallet",
          sig(kind_roundtrip(norm("maya balance is 3k wallet"))["lines"]),
          [("account", None, 3000, "maya e-wallet")])

    print("\n== v69: account balance for NEW accounts + debit default ==")
    # "i have landbank debit 600" must draft a debit account "Landbank" even
    # though LandBank is not stored; the kind word is how he says the name,
    # not part of it; debit is the default kind.
    p1 = story_parse(norm("i have landbank debit 600"), SAMPLE_BASE)
    check("new acct: 'i have landbank debit 600' drafts an account", sig(p1["lines"]),
          [("account", None, 600, "landbank")])
    check("new acct: kind is debit", p1["lines"][0]["change"].get("kind") if p1["lines"] else None, "debit")
    p2 = story_parse(norm("i have landbank 600"), SAMPLE_BASE)
    check("new acct: bare 'i have landbank 600' drafts an account", sig(p2["lines"]),
          [("account", None, 600, "landbank")])
    check("new acct: debit is the default kind", p2["lines"][0]["change"].get("kind") if p2["lines"] else None, "debit")
    p3 = story_parse(norm("i have bpi savings balance is 12,000"), SAMPLE_BASE)
    check("new acct: multi-word name", sig(p3["lines"]), [("account", None, 12000, "bpi savings")])
    check("new acct: title-cased", p3["lines"][0]["change"].get("name") if p3["lines"] else None, "Bpi Savings")
    p4 = story_parse(norm("my bdo card balance is 8k"), SAMPLE_BASE)
    check("new acct: 'card' hint -> kind card", p4["lines"][0]["change"].get("kind") if p4["lines"] else None, "card")
    check("new acct: 'my bdo card balance is 8k' name (kind word stripped)", sig(p4["lines"]),
          [("account", None, 8000, "bdo")])
    p5 = story_parse(norm("i have 600"), SAMPLE_BASE)
    check("new acct: no name -> nothing", (sig(p5["lines"]), p5["asks"]), ([], []))
    p6 = story_parse(norm("i have water 500"), SAMPLE_BASE)
    check("new acct: a known budget stays a budget", sig(p6["lines"]), [("budget", None, 500, "water")])
    # a KNOWN account: the spoken kind word wins over the stored kind
    # ("landbank debit" = "landbank", saved under debit)
    lb_base = {"budgets": {}, "debts": {}, "one_offs": {}, "sinking": {},
               "accounts": [{"name": "LandBank", "kind": "card", "value": 12000}]}
    p7 = story_parse(norm("i have landbank debit 600"), lb_base)
    check("known acct: 'landbank debit' -> debit kind",
          (sig(p7["lines"]), p7["lines"][0]["change"].get("kind")) if p7["lines"] else (None, None),
          ([("account", None, 600, "landbank")], "debit"))
    p8 = story_parse(norm("i have landbank 600"), lb_base)
    check("known acct: no kind word -> stored kind (card)",
          (sig(p8["lines"]), p8["lines"][0]["change"].get("kind")) if p8["lines"] else (None, None),
          ([("account", None, 600, "landbank")], "card"))

    print("\n== v68 Jan add-on: the rotating tips are rule-owned ==")
    # The tip strip under the chat header cycles these example phrases — each
    # must route to a RULE (never the open-question fallback), so a tap always
    # gets a local answer. Mirrors chat.js TIPS.
    # v69: the strip is display-only (tap does nothing) — it cycles these
    # example phrases for TYPING; each must still route to a rule.
    tips = [
        "how much is free?",
        "my 14th prepay",
        "what's coming up?",
        "ate at jollibee 250",
        "log expense 500 food on maya",
        "can i charge 2,500 on Maya?",
        "urgent: car repair 8,000 this week",
        "i have landbank 600",
        "my salary in october is 25k",
        "water in october same as last month +500",
        "one-off: power bill 1,500 after payday",
        "plan: shoes 1,500 on the 20th",
    ]
    for tip in tips:
        r = route(tip)
        check("tip routes to a rule: %r" % tip, r not in ("fallback", "clarify"), True)

    print("\n== ask-loop completion (v38) ==")
    # v38 re-parses "<question> <bare answer>" through story_parse; these joined
    # strings are exactly what the JS loop feeds it, so they must complete.
    complete_cases = [
        ("my salary was great 24k", [("salary_base", None, 24000, "")], []),
        ("ave got a raise 2500", [], ["which month"]),
        ("ave got a raise 2500 october", [("debt_payment", "2026-10", 2500, "ave")], []),
        ("gcash is low 4k", [("account", None, 4000, "gcash")], []),
        ("food's running high 3k", [("budget", None, 3000, "food / gym nutrition")], []),
    ]
    for text, want_lines, want_asks in complete_cases:
        parsed = story_parse(norm(text), SAMPLE_BASE)
        check("complete lines: %r" % text, sig(parsed["lines"]), want_lines)
        got_asks = parsed["asks"]
        okk = len(got_asks) == len(want_asks)
        if okk:
            for got, want in zip(got_asks, want_asks):
                if want.lower() not in got.lower():
                    okk = False
                    break
        if okk:
            print("PASS  complete asks: %r -> %s" % (text, got_asks))
        else:
            print("FAIL  complete asks: %r got=%s want~= %s" % (text, got_asks, want_asks))
            FAILS.append("complete asks: %r" % text)

    print("\n== offline brain contract (v39) ==")
    # Mirror of chat.js embNameIn / send() routing. The model itself can't run
    # here, so the contract is what's mirrored: an embedding only fills in when
    # the word-overlap rules found nothing, only above a confident cosine, and
    # a rule hit always wins. Routing: the coach answers only messages that
    # slipped past every rule (a pendingAsk answer is consumed by the v38 loop
    # first), with the brain opted in and loaded.
    import math

    def cosine(a, b):
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(x * x for x in b))
        if not na or not nb:
            return 0.0
        return dot / (na * nb)

    def emb_name_in(pool, vec, name_vecs, min_c=0.75):
        best, best_c = None, min_c
        for n in pool:
            nv = name_vecs.get(n)
            if not nv:
                continue
            c = cosine(vec, nv)
            if c > best_c:
                best, best_c = n, c
        return best

    def resolve_name(pool, rule_hit, vec, name_vecs, min_c=0.75):
        # chat.js: fuzzyNameIn(...) || embNameIn(...)
        return rule_hit or emb_name_in(pool, vec, name_vecs, min_c)

    POOL = ["gym membership", "power bill", "ave"]
    NVEC = {
        "gym membership": [0.95, 0.30],
        "power bill": [0.10, 0.99],
        "ave": [0.60, 0.60],
    }
    check("emb: paraphrase picks the right stored name",
          resolve_name(POOL, None, [0.93, 0.35], NVEC), "gym membership")
    check("emb: unrelated message picks nothing",
          resolve_name(POOL, None, [-0.9, 0.436], NVEC) is None, True)
    check("emb: a cosine under the 0.75 threshold picks nothing",
          resolve_name(POOL, None, [-0.6, 0.8], NVEC) is None, True)
    check("emb: a rule hit always wins over the embedding",
          resolve_name(POOL, "power bill", [0.95, 0.30], NVEC), "power bill")
    check("emb: no vector (brain off) -> rules only",
          resolve_name(POOL, None, None, NVEC) is None, True)

    def ai_route(rule_matched, pending_answer, ai_enabled, llm_ready, state, offered):
        if rule_matched:
            return "rules"
        if pending_answer:
            return "ask-loop"  # the v38 loop consumes it before dispatch
        if not ai_enabled:
            return "fallback"
        if llm_ready:
            return "llm"
        if state != "idle" or offered:
            return "fallback"
        return "offer"

    check("route: a rule match never reaches the coach",
          ai_route(True, False, True, True, "ready", True), "rules")
    check("route: a pendingAsk answer never reaches the coach",
          ai_route(False, True, True, True, "ready", True), "ask-loop")
    check("route: brain off -> plain fallback",
          ai_route(False, False, False, True, "ready", True), "fallback")
    check("route: brain not loaded, never offered -> one-time offer",
          ai_route(False, False, True, False, "idle", False), "offer")
    check("route: brain not loaded, already offered -> plain fallback",
          ai_route(False, False, True, False, "idle", True), "fallback")
    check("route: brain still loading -> plain fallback (chip shows progress)",
          ai_route(False, False, True, False, "loading", True), "fallback")
    check("route: brain ready + open question -> coach",
          ai_route(False, False, True, True, "ready", True), "llm")

    print("\n== v55: confirm protocol + coach-first gate + note fingerprint ==")
    # Mirror of chat.js parseCoachDraft: strict JSON {say, changes} whose first
    # char is '{'; plain text (the coach's answers / missing-detail asks) must
    # NOT parse as a draft. v61: a clear change is drafted immediately — there
    # is no pre-confirm paraphrase step to test for anymore.
    import json as _json

    def parse_coach_draft(txt):
        s = (txt or "").strip()
        if not s or s[0] != "{":
            return None
        try:
            d = _json.loads(s)
        except Exception:
            return None
        if not isinstance(d, dict):
            return None
        say = d.get("say") if isinstance(d.get("say"), str) else ""
        changes = [c for c in (d.get("changes") if isinstance(d.get("changes"), list) else [])
                   if isinstance(c, dict)][:4]
        if not say and not changes:
            return None
        return {"say": say[:300], "changes": changes}

    check("protocol: a plain-text answer (missing-detail ask) is not a draft",
          parse_coach_draft("Which card, and what is the new limit amount?") is None, True)
    check("protocol: a JSON draft parses (say + 2 changes)",
          parse_coach_draft('{"say":"Here is your change.","changes":[{"type":"salary","month":"2026-10","amount":25000},{"type":"budget","name":"water","amount":1800}]}'),
          {"say": "Here is your change.",
           "changes": [{"type": "salary", "month": "2026-10", "amount": 25000},
                       {"type": "budget", "name": "water", "amount": 1800}]})
    check("protocol: ask-for-missing-detail has a say but no changes",
          (parse_coach_draft('{"say":"Which account should I move it to?"}') or {}).get("changes") == [], True)
    check("protocol: broken JSON degrades to a text answer",
          parse_coach_draft('{"say":"ok", "changes": [oops') is None, True)
    check("protocol: JSON wrapped in prose is not a draft (first-char rule)",
          parse_coach_draft('Sure: {"say":"x","changes":[]}') is None, True)

    # Mirror of the v68 rules-first routing in chat.js handle(): the v55 LLM
    # first-pass is removed — the rule engine ALWAYS runs first. The
    # repurposed toggle (default ON; '0' disables) gates ONLY the
    # open-question path: (FAI0 && FAI0.forceOnline()) ? aiCoach(...) : null.
    def force_online(stored):
        return True if stored is None else (stored != "0")

    def open_question_to_coach(stored_force, remote_available):
        return bool(remote_available) and force_online(stored_force)

    check("gate: fresh profile (never toggled) -> open questions go to the coach",
          open_question_to_coach(None, True), True)
    check("gate: explicitly turned off -> open questions get the fallback card",
          open_question_to_coach("0", True), False)
    check("gate: on but the coach offline/down -> fallback card",
          open_question_to_coach("1", False), False)

    # Mirror of the note-cache fingerprint rule (chat.js coachSnapshot fp):
    # same numbers -> same fp -> cached note, zero API calls; any changed
    # number -> new fp -> exactly one fresh call.
    def snap_fp(at, cash, free, spent):
        return "%s|liquid %s, free %s, spent %s" % (at or "", cash, free, spent)

    fp1 = snap_fp("2026-09-10", "50000", "12000", "3000")
    check("note: identical numbers give the same fingerprint (cache hit)",
          snap_fp("2026-09-10", "50000", "12000", "3000") == fp1, True)
    check("note: one changed number gives a new fingerprint (one fresh call)",
          snap_fp("2026-09-10", "50000", "11500", "3000") != fp1, True)

    print("\n== v56: coach-extensible table (custom details) ==")
    # Mirror of the v56 'field' case in chat.js coachSanitizeChange: a custom
    # detail on an existing row, validated to a safe shape (snake key, number
    # or short string, max 10 per row, reserved column names rejected, the
    # entity must already exist; value null removes a recorded detail).
    import re as _re
    DET_ENTS = ("cash", "debit", "card", "debt", "loan", "budget")  # v65: 'cash' legacy-normalized
    DET_RESV = ("name", "kind", "value", "limit", "note", "amount", "monthly",
                "balance", "goal", "funded", "deadline", "month", "id")

    def _slug_key(k):
        s = _re.sub(r"[^a-z0-9]+", "_", str(k or "").lower()).strip("_")[:24]
        return s

    def coach_field(c, base):
        if not isinstance(c, dict) or not isinstance(c.get("type"), str):
            return None
        ent = c.get("entity") if c.get("entity") in DET_ENTS else None
        name = str(c.get("name") or "").strip()[:40]
        if not ent or not name:
            return None
        if ent == "cash":
            ent = "debit"  # v65: legacy 'cash' entity normalized (mirror of chat.js)
        key = _slug_key(c.get("key"))
        if not key or key in DET_RESV:
            return None
        base = base or {}
        if ent == "budget":
            found = name in (base.get("budgets") or {})
        else:
            found = any(a.get("name") == name and a.get("kind") == ent
                        for a in (base.get("accounts") or []))
        if not found:
            return None
        bag = ((base.get("details") or {}).get("%s:%s" % (ent, name))) or {}
        if c.get("value") is None:
            return ({"type": "field", "entity": ent, "name": name, "key": key,
                     "value": None} if key in bag else None)
        fs = str(c.get("value")).strip()
        if not fs:
            return None
        fn = None
        if _re.match(r"^-?[\d,]+(\.\d+)?$", fs):
            try:
                fn = float(fs.replace(",", ""))
                if abs(fn) > 1e9 or fn != fn:
                    fn = None
            except Exception:
                fn = None
        val = fn if fn is not None else fs[:80]
        if key not in bag and len(bag) >= 10:
            return None
        return {"type": "field", "entity": ent, "name": name, "key": key, "value": val}

    V56_BASE = {
        "accounts": [{"name": "MariBank CC", "kind": "card", "value": 17279.64, "limit": 0}],
        "budgets": {"Food": 8000},
        "details": {"card:MariBank CC": {"credit_limit": 70000}},
    }
    check("field: a valid detail on an existing card is kept",
          coach_field({"type": "field", "entity": "card", "name": "MariBank CC",
                       "key": "due_day", "value": 5}, V56_BASE),
          {"type": "field", "entity": "card", "name": "MariBank CC", "key": "due_day", "value": 5})
    check("field: a string detail is kept as text",
          coach_field({"type": "field", "entity": "budget", "name": "Food",
                       "key": "provider", "value": "eatsy app"}, V56_BASE),
          {"type": "field", "entity": "budget", "name": "Food", "key": "provider", "value": "eatsy app"})
    check("field: a friendly key is slugified and '70,000' becomes a number",
          (coach_field({"type": "field", "entity": "card", "name": "MariBank CC",
                        "key": "Credit Limit (PHP)", "value": "70,000"}, V56_BASE) or {}).get("value") == 70000, True)
    check("field: a reserved column name is rejected",
          coach_field({"type": "field", "entity": "card", "name": "MariBank CC",
                       "key": "value", "value": 1}, V56_BASE) is None, True)
    check("field: a detail for a name that isn't stored is rejected",
          coach_field({"type": "field", "entity": "card", "name": "Other CC",
                       "key": "apr", "value": 3.5}, V56_BASE) is None, True)
    check("field: value null removes a recorded detail…",
          coach_field({"type": "field", "entity": "card", "name": "MariBank CC",
                       "key": "credit_limit", "value": None}, V56_BASE),
          {"type": "field", "entity": "card", "name": "MariBank CC", "key": "credit_limit", "value": None})
    check("field: …but null for an unrecorded key is dropped",
          coach_field({"type": "field", "entity": "card", "name": "MariBank CC",
                       "key": "nope", "value": None}, V56_BASE) is None, True)
    check("field: ten details per row is the cap",
          coach_field({"type": "field", "entity": "card", "name": "MariBank CC",
                       "key": "new_one", "value": 1},
                      {"accounts": [{"name": "MariBank CC", "kind": "card", "value": 0}],
                       "details": {"card:MariBank CC": {("k%d" % i): i for i in range(10)}}}) is None, True)

    # v65: the account kind 'cash' is 'debit' now — a legacy 'cash' entity from
    # the coach is accepted and normalized, and the details key follows.
    check("field: v65 a legacy 'cash' entity normalizes to 'debit' on a debit account",
          coach_field({"type": "field", "entity": "cash", "name": "MariBank",
                       "key": "sort_code", "value": "ma"},
                      {"accounts": [{"name": "MariBank", "kind": "debit", "value": 0}],
                       "details": {}}),
          {"type": "field", "entity": "debit", "name": "MariBank", "key": "sort_code", "value": "ma"})

    # Mirror of the v56 coachSnapshot account row: name (kind) balance [details]
    # — with the limit recorded, utilization is plain arithmetic for the coach.
    def snap_row(a, details):
        d = (details or {}).get("%s:%s" % (a.get("kind"), a.get("name")))
        t = "%s (%s) %s" % (a.get("name"), a.get("kind"), a.get("value"))
        if d:
            t += " [" + ", ".join("%s %s" % (k, d[k]) for k in d) + "]"
        return t

    row = snap_row({"name": "MariBank CC", "kind": "card", "value": "17,279.64"},
                   {"card:MariBank CC": {"credit_limit": "70,000"}})
    check("snapshot: an account row carries balance + details for utilization math",
          "MariBank CC (card) 17,279.64 [credit_limit 70,000]" in row, True)

    # v57: the rule engine no longer hardcodes '<card> limit is N' offline
    # (user: let the online coach do it on its own) — nothing to mirror here.

    print()
    if FAILS:
        print("RESULT: %d FAILURES: %s" % (len(FAILS), FAILS))
        raise SystemExit(1)
    print("RESULT: all parser checks passed")


if __name__ == "__main__":
    main()