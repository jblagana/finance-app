/* Fin.AI PWA coach chat — the Coach tab.
 *
 * Rule-based and fully local: it answers from the same data the app's tiles
 * use — the local base snapshot (accounts, salary, debts, budgets, one-offs,
 * sinking) computed on this phone, plus this phone's plans and entries — so it
 * works with no signal and no sheet.
 *
 * It never writes on its own: every change (plan, expense, story-mode base edit)
 * is confirmed with a button and goes through the app's own actions
 * (window.FinApp), so chat-made plans/entries/base changes behave exactly like
 * the forms (same stores, same deficit math, same saveBase recompute).
 *
 * v35 story mode: a casual update ("my salary in october is 25k, water went up
 * to 1800") is parsed into validated change objects, shown as a draft card you
 * can edit line by line, and only on confirm is it applied through
 * FinApp.applyBaseChanges — with a one-tap undo (FinApp.undoBaseStory) that the
 * app keeps in its own meta store. Chat never mutates the app's base directly.
 *
 * v38 ask loop: a "One number short" card remembers its question (pendingAsk).
 * If the very next message is a bare number ("24k"), a named amount
 * ("gcash is 4k"), or a bare month ("october"), it is re-parsed as
 * question + answer through the same story flow and completes the draft;
 * anything else closes the question and routes normally. Nothing is ever
 * written without a confirmed draft.
 *
 * The rule engine owns every command and stays the only writer. v55: while
 * the ONLINE coach (a hosted LLM the user connects in Settings) is available
 * and "Coach answers everything" is on (default), it answers first — talking
 * and confirming understanding before proposing any change; a reply to an
 * open draft corrects it instead of stacking a new one. When the coach is
 * off / offline / not configured, the rule engine answers (with the fallback
 * card when even it can't). The deterministic story/semantic scorer (v37)
 * stays — it's part of the rule engine.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || !window.FinApp) return;

  var F = window.FinApp;

  // v38: the last "One number short" card remembers its question so the very
  // next bare answer can complete it. kind: 'amt' (a number) or 'month'.
  // Cleared on a non-answer, on any action, and on page reload.
  var pendingAsk = null; // { t: <normalized question text>, kind: 'amt' | 'month' }
  // v55: the latest UNCONFIRMED change draft (local story or coach JSON). While
  // it's open, the user's next words are a reply to that draft — the coach
  // corrects or confirms it instead of the engine stacking a new draft.
  // Cleared on confirm / discard / last line dropped; restored on open.
  var openDraft = null; // { say: <coach line>, lines: [<draft row label>, ...] }
  // v46: short coach memory — the last few turns (user text + tag-stripped bot
  // text), rebuilt on every send and folded into the coach prompt so the coach
  // follows the conversation instead of answering each message in isolation.
  var recentHist = [];
  var RX_ANS_AMT = /^(?:it'?s|its|is|about|around|roughly|like|maybe|just|now|total|new)?\s*(?:php|\u20b1|pesos?)?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:k\b|thousand)?\s*(?:php|\u20b1|pesos?)?[?.!]*$/;
  var RX_ANS_NAMED = /^[a-z][a-z'&\- ]{0,39}?\s+(?:is|was|at|of|to|equals|running|sits)(?:\s+(?:at|around|about|roughly))?\s+(?:php|\u20b1|pesos?)?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:k\b|thousand)?\s*(?:php|\u20b1|pesos?)?[?.!]*$/;
  var RX_ANS_MONTH = /^(?:in|for|of|say|its|it'?s|that'?s|the)?\s*(?:next month|last month|this month|january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b\s*[?.!]*$/;
  // v38: what the remembered question is about (stored name or 'salary'). A
  // named answer like "gcash is 4k" only counts if the name fits this entity,
  // so an off-topic sentence never fills a draft for something else.
  function askEntity(a) {
    var m = / for ([a-z0-9'&\-/ ]+?)\?$/i.exec(a || '');
    if (m) return m[1].trim();
    m = / the ([a-z0-9'&\-/ ]+?) payment for/i.exec(a || '');
    if (m) return m[1].trim();
    return (a || '').indexOf('salary') !== -1 ? 'salary' : null;
  }

  // ---------- small helpers (self-contained; mirror app.js conventions) ----------
  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) {
    var t = String(s == null ? '' : s).toLowerCase().replace(/[’‘]/g, "'");
    t = t
      .replace(/\bu\b/g, 'you')
      .replace(/\bur\b/g, 'your')
      .replace(/\bwhats\b/g, "what's")
      .replace(/\bwhos\b/g, "who's")
      .replace(/\bim\b/g, "i'm")
      .replace(/\bdont\b/g, "don't")
      .replace(/\bcant\b/g, "can't")
      .replace(/\bwont\b/g, "won't")
      .replace(/\bthx\b/g, 'thanks')
      .replace(/\bty\b/g, 'thanks')
      .replace(/\b(pls|plz)\b/g, 'please');
    return t.replace(/\s+/g, ' ').trim();
  }
  function num(s) { return Number(String(s).replace(/,/g, '')) || 0; }
  function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function money(v) {
    var n = Number(v) || 0;
    var sign = n < 0 ? '-' : '';
    return 'PHP ' + sign + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtNum(v) { return Math.round(Number(v) || 0).toLocaleString('en-US'); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONFULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var MOKEY = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  var MONAME = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:uary|ruary|ch|il|ust|tember|ober|ember)?';
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseISO(s) { var p = String(s).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function addDaysISO(iso, n) { var d = parseISO(iso); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function monthPrev(m) {
    var p = String(m).split('-'); var mm = Number(p[1]) - 1, yy = Number(p[0]);
    if (mm < 1) { mm = 12; yy -= 1; }
    return yy + '-' + pad2(mm);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var p = String(iso).split('-');
    if (p.length === 3) return MON[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
    return iso;
  }
  function monthLabel(m) {
    var p = String(m || '').split('-');
    if (p.length === 2) return MON[Number(p[1]) - 1] + ' ' + p[0];
    return m || '';
  }
  function ordinal(n) {
    n = Number(n) || 0;
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function whenLabel(iso) {
    var d = Math.round((parseISO(iso) - parseISO(todayISO())) / 86400000);
    if (d === 0) return 'Today';
    if (d === 1) return 'Tomorrow';
    if (d > 1 && d < 7) return 'in ' + d + ' days';
    if (d === -1) return 'Yesterday';
    return fmtDate(iso);
  }

  // ---------- v35: fuzzy matching + month tokens (story mode) ----------
  // Levenshtein distance (capped: longer-than-3 diffs can never match).
  function lev(a, b) {
    var m = a.length, n = b.length;
    if (Math.abs(m - n) > 3) return 99;
    var dp = [], i, j;
    for (i = 0; i <= m; i++) { dp[i] = [i]; }
    for (j = 0; j <= n; j++) dp[0][j] = j;
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        // charAt (not a[i-1]): bracket indexing on strings is not portable (JScript)
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
    }
    return dp[m][n];
  }
  function cleanTok(s) { return String(s == null ? '' : s).replace(/[^a-z0-9]/g, ''); }
  // true if any token in toks is word-equal or a close typo of word (word is a name word, >= 3 chars)
  function fuzzyTokIn(word, toks) {
    var w = cleanTok(String(word || '').toLowerCase());
    if (w.length < 3) return false;
    for (var i = 0; i < toks.length; i++) {
      var tk = cleanTok(toks[i]);
      if (!tk) continue;
      if (tk === w) return true;
      var max = w.length >= 6 ? 2 : 1;
      if (tk.length >= 3 && Math.abs(tk.length - w.length) <= max && lev(tk, w) <= max) return true;
    }
    return false;
  }
  function curMonthKey() { return todayISO().slice(0, 7); }
  function addMonthsKey(offset) {
    var c = todayISO().split('-');
    var m = Number(c[1]) + offset, y = Number(c[0]);
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    return y + '-' + pad2(m);
  }
  // "next occurrence" month key: october in September 2026 -> 2026-10, october in November -> 2027-10
  function monthKeyFor(k) {
    var now = todayISO().split('-');
    var y = Number(now[0]), nm = Number(now[1]);
    if (k + 1 < nm) y += 1;
    return y + '-' + pad2(k + 1);
  }
  // first month token in text, exact or a 1-keystroke typo ("septmber", "jane"); null when absent
  function storyMonth(t) {
    var toks = String(t || '').split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      var tk = cleanTok(toks[i]);
      if (!tk) continue;
      for (var k = 0; k < MON.length; k++) {
        var full = MONFULL[k];
        var ab = full.slice(0, 3);
        if (tk === full || tk === ab) return monthKeyFor(k);
        if (tk.length >= 4 && Math.abs(tk.length - full.length) <= 1 && lev(tk, full) <= 1) return monthKeyFor(k);
        // v37: 3-letter tokens must match an abbreviation exactly ("pay" must NOT read as "may")
        if (tk.length >= 4 && Math.abs(tk.length - 3) <= 1 && lev(tk, ab) <= 1) return monthKeyFor(k);
      }
    }
    if (/\bnext month\b/.test(t)) return addMonthsKey(1);
    return null;
  }
  function isMonthWord(s) {
    var tk = cleanTok(s);
    if (!tk) return false;
    for (var k = 0; k < MON.length; k++) {
      var full = MONFULL[k];
      if (tk === full || tk === full.slice(0, 3)) return true;
      if (tk.length >= 4 && Math.abs(tk.length - full.length) <= 1 && lev(tk, full) <= 1) return true;
    }
    return false;
  }

  // ---------- data: read our own copies from IndexedDB (race-free) ----------
  function snapSig(s) {
    if (!s) return '';
    return [s.cash && s.cash.total, s.cash && s.cash.free, s.card_owed, s.total_prepay].join('|');
  }
  function loadCtx() {
    return Promise.all([F.idbAll(F.STORE_META), F.idbAll(F.STORE_PLANS), F.idbAll(F.STORE_TX)]).then(function (res) {
      var snap = null, adj = { cash: 0, free: 0, card: 0, prepay: 0 }, adjSig = '', at = null, base = null;
      (res[0] || []).forEach(function (m) {
        if (m.key === 'snapshot') { snap = m.value; at = m.at; }
        else if (m.key === 'adj') adj = m.value || adj;
        else if (m.key === 'adjSig') adjSig = m.value || '';
        else if (m.key === 'base') base = m.value; // v35: story mode matches names against the stored base
      });
      var eff = null;
      if (snap) {
        // same live-overlay rule as the app: sheet numbers +/- this phone's entries
        var a = (adjSig && adjSig !== snapSig(snap)) ? { cash: 0, free: 0, card: 0, prepay: 0 } : adj;
        eff = JSON.parse(JSON.stringify(snap));
        eff.cash = {
          total: r2((snap.cash ? snap.cash.total : 0) - a.cash),
          free: r2((snap.cash ? snap.cash.free : 0) - a.free),
          accounts: snap.cash ? snap.cash.accounts : []
        };
        eff.card_owed = r2((snap.card_owed || 0) + a.card);
        eff.total_prepay = r2((snap.total_prepay || 0) + a.prepay);
      }
      return { snap: snap, eff: eff, base: base, plans: res[1] || [], txns: res[2] || [], at: at };
    });
  }

  // ---------- date parsing ----------
  function findDateSpan(text) {
    var t = ' ' + String(text || '') + ' ';
    var today = todayISO();
    var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    function isoOf(yy, mm, dd) { return yy + '-' + pad2(mm) + '-' + pad2(dd); }
    var rules = [
      [new RegExp('(\\d{4})-(\\d{2})-(\\d{2})'), function (mm) { return mm[1] + '-' + mm[2] + '-' + mm[3]; }],
      [new RegExp('\\b' + MONAME + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b'), function (mm) {
        var mo = MOKEY[mm[1].slice(0, 3)], dd = Number(mm[2]), yy = y;
        if (isoOf(yy, mo, dd) < today) yy += 1;
        return isoOf(yy, mo, dd);
      }],
      [new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONAME + '\\.?\\b'), function (mm) {
        var dd = Number(mm[1]), mo = MOKEY[mm[2].slice(0, 3)], yy = y;
        if (isoOf(yy, mo, dd) < today) yy += 1;
        return isoOf(yy, mo, dd);
      }],
      [new RegExp('\\bthe\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b'), function (mm) {
        var dd = Number(mm[1]); if (dd < 1 || dd > 31) return null;
        var s = isoOf(y, m, dd);
        if (s < today) { m += 1; if (m > 12) { m = 1; y += 1; } s = isoOf(y, m, dd); }
        return s;
      }],
      [new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)\\b'), function (mm) {
        var dd = Number(mm[1]); if (dd < 1 || dd > 31) return null;
        var s = isoOf(y, m, dd);
        if (s < today) { m += 1; if (m > 12) { m = 1; y += 1; } s = isoOf(y, m, dd); }
        return s;
      }],
      [/\btoday\b/, function () { return today; }],
      [/\btomorrow\b|\btmr\b/, function () { return addDaysISO(today, 1); }],
      [/\bnext week\b/, function () { return addDaysISO(today, 7); }],
      [/\bthis week\b|\bsoon\b/, function () { return addDaysISO(today, 1); }],
      [/\bnext month\b/, function () {
        var mm2 = m + 1, yy2 = y; if (mm2 > 12) { mm2 = 1; yy2 += 1; }
        return isoOf(yy2, mm2, 1);
      }],
      [/\bend of (?:the )?month\b|\beom\b/, function () {
        return isoOf(y, m, new Date(y, m, 0).getDate());
      }]
    ];
    var best = null;
    for (var i = 0; i < rules.length; i++) {
      var mm = t.match(rules[i][0]);
      if (mm && mm.index != null && (!best || mm.index < best.index)) {
        best = { index: mm.index, raw: mm[0], iso: rules[i][1](mm) };
      }
    }
    return best && best.iso ? { raw: best.raw, iso: best.iso } : null;
  }

  // ---------- amount parsing ----------
  function findAmount(text) {
    var t = String(text || '');
    var m = t.match(/(?:php|₱|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(k\b)/i);
    if (m) return { raw: m[0], amt: num(m[1]) * 1000 };
    m = t.match(/(?:php|₱|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)/i);
    if (m) return { raw: m[0], amt: num(m[1]) };
    m = t.match(/([\d][\d,]*\.\d{1,2})/);
    if (m) return { raw: m[1], amt: num(m[1]) };
    m = t.match(/([\d][\d,]*)\s*(k\b)/i);
    if (m) return { raw: m[0], amt: num(m[1]) * 1000 };
    m = t.match(/([\d][\d,]*)/);
    if (m) return { raw: m[1], amt: num(m[1]) };
    return null;
  }

  // ---------- account / name / category matching ----------
  function findAccounts(text, ctx) {
    var e = ctx.eff;
    var list = [];
    (e.cards || []).forEach(function (c) { list.push({ name: c.name, kind: 'card', balance: c.balance, limit: c.limit }); });
    (e.cash.accounts || []).forEach(function (a) { list.push({ name: a.name, kind: 'cash', balance: a.value, limit: null }); });
    var t = ' ' + String(text || '') + ' ';
    var exact = null, words = [];
    for (var i = 0; i < list.length; i++) {
      if (t.indexOf(list[i].name.toLowerCase()) >= 0) {
        if (!exact || list[i].name.length > exact.name.length) exact = list[i];
        continue;
      }
    }
    if (!exact) {
      for (var j = 0; j < list.length; j++) {
        var wds = list[j].name.toLowerCase().split(/[\s/]+/);
        for (var w = 0; w < wds.length; w++) {
          if (wds[w].length >= 4 && t.indexOf(wds[w]) >= 0) {
            if (words.indexOf(list[j]) < 0) words.push(list[j]);
            break;
          }
        }
      }
    }
    return { exact: exact, words: words };
  }
  function mentionOf(name, text) {
    var n = String(name || '').toLowerCase().trim();
    if (!n) return false;
    var t = ' ' + String(text || '').trim() + ' ';
    function wb(s) {
      var re = new RegExp('\\b' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      return re.test(t);
    }
    if (wb(n)) return true;
    var wds = n.split(/[\s/]+/);
    for (var i = 0; i < wds.length; i++) {
      if (wds[i].length >= 4 && wb(wds[i])) return true;
    }
    return false;
  }
  var CAT_HINTS = [
    [/food|meal|eat|lunch|dinner|brunch|grocer|nutrition|makan/, 'Food / Gym Nutrition'],
    [/\bgym\b|workout/, 'Gym Membership'],
    [/\brent\b/, 'Rent'],
    [/\bwater\b/, 'Water'],
    [/wifi|wi-fi|internet/, 'Wi-Fi'],
    [/spotify|music/, 'Spotify'],
    [/parent|inay|tatay/, 'Parents\u2019 Utilities Support'],
    [/laundry|laundromat/, 'Laundry'],
    [/treat|gear|\bshoe|\bgift|birthday/, 'Personal Treats / Gear'],
    [/transport|jeep|tricycle|uber|grab|\bgas\b|fuel/, 'Transport'],
    [/spaylater|paylater|pay[- ]?late|installment|in[- ]house/, 'Debt payment'],
    [/\bdebt\b|\bloan\b/, 'Debt payment'],
    [/savings|sinking|christmas|\bsave/, 'Savings / Sinking'],
    [/repair|fix|doctor|meds|pharm|hospital/, 'Other']
  ];
  function guessCategory(text) {
    var t = ' ' + String(text || '') + ' ';
    for (var i = 0; i < CAT_HINTS.length; i++) if (CAT_HINTS[i][0].test(t)) return CAT_HINTS[i][1];
    return 'Other';
  }
  function mentionedCategory(t, txns) {
    var seen = {};
    (txns || []).forEach(function (x) { if (x.category) seen[x.category] = true; });
    var names = Object.keys(seen);
    for (var i = 0; i < names.length; i++) if (mentionOf(names[i], t)) return names[i];
    return null;
  }
  function biggestCash(ctx) {
    var best = null;
    (ctx.eff.cash.accounts || []).forEach(function (a) { if (!best || a.value > best.value) best = a; });
    return best ? { name: best.name, kind: 'cash' } : null;
  }
  function extractWhat(text, am) {
    var t = String(text || '');
    var m = t.match(/\bfor\s+([a-z0-9'\- ]{2,40}?)(?:\s+(?:this|next|on|in|by|today|tomorrow|the)\b|$)/);
    if (m) return m[1].replace(/[\s,;]+$/, '');
    if (am) {
      var idx = t.indexOf(am.raw);
      if (idx >= 0) {
        var tail = t.slice(idx + am.raw.length).replace(/^[^a-z]+/, '').replace(/[,;.]+$/, '').slice(0, 40).trim();
        if (tail && /^[a-z]{2}/.test(tail)) return tail;
        var head = t.slice(0, idx).replace(/^(?:urgent|emergency|unexpected|unplanned)\s*:?\s*/, '').trim();
        if (head && head.length <= 40) return head.replace(/[,;.]+$/, '');
      }
    }
    return '';
  }

  // ---------- reply building blocks (reuse the app's tile styling) ----------
  function block(title, inner, verdict, cls) {
    var h = '<div class="c-block"><div class="c-t">' + esc(title) + '</div>';
    if (inner) h += inner;
    if (verdict) h += '<div class="verdict ' + cls + '">' + esc(verdict) + '</div>';
    return h + '</div>';
  }
  function line(html) { return '<div class="ins-line">' + html + '</div>'; }
  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><b>' + v + '</b></div>'; }
  function coachName() {
    try { var n = (localStorage.getItem('fin.name') || '').trim(); if (n) return n; } catch (e) {}
    return '';
  }
  // v47: the per-message "numbers as of …" note is gone — the main chat header
  // (chatFresh) shows the data's as-of time for the whole conversation instead.
  function freshness(ctx) { return ''; }

  // ---------- intents ----------
  function intentHelp(t) {
    if (!/^(help|\?+|what can you do|what do you do|what can i ask|how do you work|commands|abilities)\b/.test(t)) return null;
    var h = block('What I can do',
      line('• <b>Status</b> — free cash, liquid cash, cards owed, the 14th prepay') +
      line('• <b>Details</b> — debt schedules, one-offs, sinking funds, “what’s my cash in Feb?”') +
      line('• <b>Plans</b> — add / list / remove plans, exactly like the form on the Money tab') +
      line('• <b>Charge check</b> — “can I charge 2,500 on Maya?”') +
      line('• <b>Urgent expense</b> — tell me something unplanned and I’ll map the options') +
      line('• <b>Spending</b> — what you’ve logged in this app this week / month') +
      line('• <b>Story mode</b> — tell me changes in plain words: “my salary in october is 25k, water went up to 1,800” — I draft them and you confirm before anything is written') +
      line('• <b>Open questions</b> — when I’m connected to the online coach (Settings), I can reason about your numbers in my own words; it needs signal'),
      'Try: “urgent: car repair 8,000 this week”', 'good');
    return { html: h };
  }

  function intentGreet(t, ctx) {
    if (!/^(hi|hiya|hey|hello|yo|um|sup)([!.? ,]*)$/.test(t)
      && !/^good (morning|afternoon|evening)\b/.test(t)
      && !/^(what'?s up|how'?s it going|how are you(?: doing)?|hey there)\b/.test(t)) return null;
    var n = coachName();
    var h = block(n ? 'Hey ' + esc(n) : 'Hey',
      line('I’m your money coach. Ask for <b>status</b>, <b>plans</b>, <b>debt</b> details, a <b>charge check</b>, or tell me about an <b>urgent expense</b> — it works offline.') +
      line('Type <b>help</b> for the full list.'),
      'I answer from your numbers on this phone.', 'good');
    return { html: h + freshness(ctx) };
  }

  function intentStatus(t, ctx) {
    var e = ctx.eff;
    var want = {
      free: /\bfree\b|\bunallocated\b|\bheadroom\b|\bhow much (?:can i |do i )?spend\b|\bcan i spend\b/.test(t),
      cash: /\b(?:liquid )?cash\b|\bbalances?\b|\bhow much (?:money|cash)(?: do i | i )?have\b/.test(t),
      card: /\bcards?\b/.test(t) && /\b(owe|owed|balance|total|due)\b/.test(t),
      prepay: /\bpre-?pay\b|\b14th\b|\bcard (?:payment|due|reset)\b/.test(t),
      util: /\butiliz/.test(t),
      all: /\b(status|summary|overview|big picture|how am i doing|where do i stand|recap)\b/.test(t)
    };
    if (!want.free && !want.cash && !want.card && !want.prepay && !want.util && !want.all) return null;
    var floor = e.floor || 0;
    if (want.all) {
      var h = block('Where you stand',
        kv('Liquid cash', money(e.cash.total) + ' <span class="note" style="font-size:11px">floor ' + money(floor) + '</span>') +
        kv('Free / unallocated', money(e.cash.free)) +
        kv('Cards owed', money(e.card_owed)) +
        kv(ordinal(e.prepay_day || 14) + ' prepay', money(e.total_prepay) + ' <span class="note" style="font-size:11px">before the ' + (e.cutoff_day || 15) + '</span>'),
        e.cash.free < 0 ? 'Free cash is negative — back the cards before anything new.'
          : (e.cash.total < floor ? 'You’re under the liquidity floor.' : 'On track — free cash is positive.'),
        e.cash.free < 0 ? 'bad' : (e.cash.total < floor ? 'warn' : 'good'));
      return { html: h + freshness(ctx) };
    }
    var lines = '';
    if (want.free) lines += kv('Free / unallocated', money(e.cash.free));
    if (want.cash) lines += kv('Liquid cash', money(e.cash.total));
    if (want.card) lines += kv('Cards owed', money(e.card_owed));
    if (want.prepay) lines += kv(ordinal(e.prepay_day || 14) + ' prepay', money(e.total_prepay));
    if (want.util) (e.cards || []).forEach(function (c) {
      if (c.util_pct != null) lines += kv(c.name + ' utilization', c.util_pct + '% of ' + money(c.limit));
    });
    var vcls = 'good', vtxt = '';
    if (want.free) {
      if (e.cash.free < 0) { vcls = 'bad'; vtxt = 'Free cash is negative — back the cards before new charges.'; }
      else vtxt = money(e.cash.free) + ' available for new charges this month.';
    } else if (want.cash) {
      if (e.cash.total < floor) { vcls = 'warn'; vtxt = 'Under your ' + money(floor) + ' floor — protect the buffer.'; }
      else vtxt = 'Floor is ' + money(floor) + '.';
    } else if (want.prepay) {
      vtxt = 'Due on the ' + ordinal(e.prepay_day || 14) + ', before the ' + (e.cutoff_day || 15) + ' cutoff — keeps reported utilization just under 10%.';
    } else if (want.card) {
      vtxt = 'Prepay due on the ' + ordinal(e.prepay_day || 14) + ': ' + money(e.total_prepay) + '.';
    }
    return { html: block('Status', lines, vtxt, vcls) + freshness(ctx) };
  }

  function intentDebt(t, ctx) {
    var debts = (ctx.eff.obligations && ctx.eff.obligations.debts) || [];
    var hit = null;
    for (var i = 0; i < debts.length; i++) if (mentionOf(debts[i].name, t)) { hit = debts[i]; break; }
    if (!hit) return null;
    var month = ctx.eff.month || '';
    var upcoming = (hit.schedule || []).filter(function (s) { return s.month >= month; }).slice(0, 6);
    var h = block(hit.name,
      kv('This month (' + monthLabel(month) + ')', Number(hit.this_month) > 0 ? money(hit.this_month) : '—') +
      (hit.balance != null ? kv('Balance left', money(hit.balance)) : '') +
      kv('Next payments', upcoming.length ? upcoming.map(function (s) { return monthLabel(s.month) + ' ' + fmtNum(s.amount); }).join(' · ') : 'none in the plan window'),
      hit.balance != null && hit.balance > 0 ? 'Keep the automatic payment on — the schedule clears it.' : 'On schedule.', 'good');
    return { html: h + freshness(ctx) };
  }

  function intentOneOff(t, ctx) {
    var obs = (ctx.eff.obligations && ctx.eff.obligations.one_offs) || [];
    var hit = null;
    for (var i = 0; i < obs.length; i++) if (mentionOf(obs[i].name, t)) { hit = obs[i]; break; }
    if (!hit && !/one[- ]?off/.test(t)) return null;
    var month = ctx.eff.month || '';
    var rows = obs.filter(function (o) { return o.month >= month; }).sort(function (a, b) { return a.month < b.month ? -1 : 1; });
    var h = block('One-offs coming up',
      rows.length ? rows.map(function (o) { return kv(monthLabel(o.month) + ' · ' + esc(o.name), money(o.amount)); }).join('')
        : line('Nothing beyond this month in the plan.'),
      null, null);
    return { html: h + freshness(ctx) };
  }

  function intentSinking(t, ctx) {
    var funds = ctx.eff.sinking || [];
    var hit = null;
    for (var i = 0; i < funds.length; i++) if (mentionOf(funds[i].name, t)) { hit = funds[i]; break; }
    if (!hit && !/sinking|savings goal|holiday/.test(t)) return null;
    var f = hit || funds[0];
    if (!f) return null;
    var pct = Number(f.goal) > 0 ? Math.min(100, Math.round((Number(f.funded) || 0) / Number(f.goal) * 100)) : 0;
    var h = block(f.name + ' · by ' + (f.deadline ? fmtDate(f.deadline) : '—'),
      kv('Funded', money(f.funded || 0) + ' of ' + money(f.goal || 0) + ' (' + pct + '%)') +
      (Number(f.this_month) > 0 ? kv('This month', money(f.this_month)) : '') +
      ((f.payments || []).length ? kv('Plan', f.payments.map(function (p) { return monthLabel(p.month) + ' ' + fmtNum(p.amount); }).join(' · ')) : ''),
      null, null);
    return { html: h + freshness(ctx) };
  }

  function intentFuture(t, ctx) {
    var m = ctx.snap && ctx.snap.matrix;
    var borrow = /\bborrow\b|\bpartner\b|\bridge\b/.test(t);
    var worst = /\bworst[- ]?case\b|\bemergenc/.test(t);
    var monthWord = t.match(new RegExp('\\b' + MONAME + '\\b'));
    var nextM = /\bnext month\b/.test(t);
    var general = /\b(project|projection|forecast|runway|trajectory|next (?:few )?months|how (?:far|long) (?:will|does)|will i (?:make it|be ok|be fine)|break even|through february|the plan)\b/.test(t);
    if (!borrow && !worst && !monthWord && !nextM && !general) return null;
    if (borrow && ctx.snap && ctx.snap.bridge) {
      var b = ctx.snap.bridge;
      var h = block('Partner bridge (' + monthLabel(ctx.eff.month) + ')',
        kv('Liquid cash', money(b.cash) + ' <span class="note" style="font-size:11px">floor ' + money(b.floor) + '</span>') +
        kv('Mandatory-only month', money(b.mandatory_only.outflows) + ' out → ends ' + money(b.mandatory_only.end_cash_no_borrow)) +
        kv('Full-living month', money(b.full_living.outflows) + ' out → ends ' + money(b.full_living.end_cash_no_borrow)) +
        (b.full_living.need_borrow ? kv('Borrow to avoid negative', money(b.full_living.borrow_to_avoid_negative)) : '') +
        (b.full_living.borrow_to_keep_floor > 0 ? kv('Borrow to keep the floor', money(b.full_living.borrow_to_keep_floor)) : ''),
        b.mandatory_only.need_borrow
          ? 'Even mandatory-only needs a bridge of ' + money(b.mandatory_only.borrow_to_avoid_negative) + '.'
          : 'Mandatory-only needs no borrowing. Any full-living borrow should be repaid as soon as cash allows.',
        b.mandatory_only.need_borrow ? 'warn' : 'good');
      return { html: h + freshness(ctx) };
    }
    if (!m) {
      return { html: block('Projection', line('I don’t have your numbers yet — add them in Settings → Your numbers and I can project.'), null, null) + freshness(ctx) };
    }
    var target = null;
    if (monthWord) {
      var mo = MOKEY[monthWord[0].slice(0, 3)];
      target = (mo >= 9 ? 2026 : 2027) + '-' + pad2(mo);
    } else if (nextM) {
      var cur = String(ctx.eff.month || todayISO().slice(0, 7)).split('-');
      var cm = Number(cur[1]) + 1, cy = Number(cur[0]);
      if (cm > 12) { cm = 1; cy += 1; }
      target = cy + '-' + pad2(cm);
    }
    var rowB = null;
    if (target) {
      (m.base || []).forEach(function (r) { if (r.comp.month === target) rowB = r; });
    }
    if (target && rowB) {
      var comp = rowB.comp;
      var below = rowB.running < (ctx.eff.floor || 0);
      var h2 = block(monthLabel(target),
        kv('Salary', money(comp.salary)) +
        kv('Committed outflows', money(comp.outflows)) +
        kv('Cash at month end', money(rowB.running)),
        below
          ? 'Base case dips below your ' + money(ctx.eff.floor || 0) + ' floor in ' + monthLabel(target) + ' — that’s the month to protect.'
          : 'Stays above the ' + money(ctx.eff.floor || 0) + ' floor in ' + monthLabel(target) + '.',
        below ? 'warn' : 'good');
      return { html: h2 + freshness(ctx) };
    }
    if (worst || general) {
      var lines = kv('Starting liquid cash', money(m.start_cash));
      (m.base || []).forEach(function (r) {
        lines += kv(monthLabel(r.comp.month), money(r.running));
      });
      var ms = (ctx.snap && ctx.snap.months) || [];
      var winTitle = ms.length >= 2 ? monthLabel(ms[0]) + ' → ' + monthLabel(ms[ms.length - 1]) : '6 months';
      var h3 = block(winTitle + ' · running cash', lines,
        'Liquid cash at the end of each month.', 'good');
      return { html: h3 + freshness(ctx) };
    }
    return null;
  }

  function intentSpend(t, ctx) {
    if (!/\b(spend|spent|spending)\b/.test(t)) return null;
    // “how much can I spend” is a status question — the ledger needs a time or category cue
    var hasTime = /\b(today|yesterday|week|month)\b/.test(t);
    var hasCat = mentionedCategory(t, ctx.txns);
    if (!hasTime && !hasCat) return null;
    var txns = (ctx.txns || []).filter(function (x) { return (Number(x.amount) || 0) > 0; });
    var today = todayISO();
    var monthP = today.slice(0, 7);
    var sel = txns, scope = 'all entries';
    if (/\btoday\b/.test(t)) { sel = txns.filter(function (x) { return x.date === today; }); scope = 'today'; }
    else if (/\bthis week\b|\bweek\b/.test(t)) {
      var d7 = addDaysISO(today, -6);
      sel = txns.filter(function (x) { return x.date >= d7 && x.date <= today; });
      scope = 'the last 7 days';
    }
    else if (/\blast month\b/.test(t)) {
      var lp = monthPrev(monthP);
      sel = txns.filter(function (x) { return String(x.date).slice(0, 7) === lp; });
      scope = 'last month';
    }
    else if (/\bthis month\b|\bmonth\b/.test(t)) {
      sel = txns.filter(function (x) { return String(x.date).slice(0, 7) === monthP; });
      scope = 'this month';
    }
    var cat = mentionedCategory(t, txns);
    if (cat) {
      var cl = cat.toLowerCase();
      sel = sel.filter(function (x) {
        var xc = (x.category || '').toLowerCase();
        return xc === cl || xc.indexOf(cl) >= 0 || cl.indexOf(xc) >= 0;
      });
      scope += ' · ' + cat;
    }
    var total = sel.reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
    var h = block('Logged in this app',
      sel.length
        ? kv(scope, money(total) + ' <span class="note" style="font-size:11px">(' + sel.length + ' entr' + (sel.length === 1 ? 'y' : 'ies') + ')</span>')
        : line('Nothing logged ' + scope + ' yet.'),
      'This counts entries logged in this app — everything is stored on this phone.', 'good');
    return { html: h + freshness(ctx) };
  }

  function intentPlanRemove(t, ctx) {
    if (!/\b(remove|delete|drop|cancel|kill|forget|unplan)\b/.test(t)) return null;
    var plans = ctx.plans || [];
    var hit = null;
    for (var i = 0; i < plans.length; i++) if (mentionOf(plans[i].name, t)) { hit = plans[i]; break; }
    if (!hit) {
      if (plans.length && /\bplan\b/.test(t)) {
        return {
          html: block('Which plan?',
            line('I don’t see it among your plans: ' + plans.map(function (p) { return esc(p.name); }).join(', ')),
            null, null) + freshness(ctx),
          actions: []
        };
      }
      return null;
    }
    return {
      html: block('Remove plan?',
        kv(whenLabel(hit.date) + ' · ' + esc(hit.name), money(hit.amount)),
        'Tap to remove it — its amount comes back to your free cash on Home.', 'warn'),
      actions: [{ label: 'Remove ' + esc(hit.name), act: 'remove_plan', payload: { id: hit.id, name: hit.name, amount: hit.amount, date: hit.date } }]
    };
  }

  function intentPlanAdd(t, ctx) {
    var lead = t.match(/^(?:add|make|log|new)\s+(?:a\s+|an\s+)?plan\b\s*/) || t.match(/^plan\b\s*:?\s*/) || t.match(/^\bplanning\b\s*/);
    if (!lead) return null;
    var rest = t.slice(lead[0].length);
    var dm = findDateSpan(rest);
    var rest2 = dm ? rest.replace(dm.raw, ' ') : rest;
    var am = findAmount(rest2);
    if (!am || !(am.amt > 0)) {
      return { html: block('Add a plan', line('Give me the amount.'), 'e.g. “plan: shoes 1,500 on the 20th” — date optional, defaults to today.', 'good') + freshness(ctx) };
    }
    var name = rest2.replace(am.raw, ' ').replace(/\s+/g, ' ').replace(/^[\s:,-]+|[\s:,-]+$/g, '')
      .replace(/^(?:for|of|about|on)\s+/, '').replace(/\s+(?:for|of|about|on)$/, '').trim();
    if (!name) {
      return { html: block('Add a plan', line('What is it for?'), 'e.g. “plan: car repair 8,000 this week”', 'good') + freshness(ctx) };
    }
    var date = dm ? dm.iso : todayISO();
    return {
      html: block('New plan',
        kv(whenLabel(date) + ' · ' + esc(name), money(am.amt)),
        'It goes to your plans (Money tab) and feeds the Home insights.', 'good'),
      actions: [{ label: 'Add plan: ' + esc(name), act: 'add_plan', payload: { name: name, amount: am.amt, date: date } }]
    };
  }

  function intentPlanList(t, ctx) {
    if (!/\bplans?\b|\bwhat'?s (?:planned|coming up|coming)\b|\bupcoming\b/.test(t)) return null;
    var monthWord = t.match(new RegExp('\\b' + MONAME + '\\b'));
    if (monthWord && !/\bplans?\b/.test(t)) return null; // “what's coming up in dec” → one-offs
    var plans = (ctx.plans || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (!plans.length) {
      return { html: block('Plans', line('Nothing planned yet.'), 'Try: “plan: shoes 1,500 on the 20th”', 'good') + freshness(ctx) };
    }
    var total = plans.reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0);
    var monthP = (ctx.eff && ctx.eff.month) || todayISO().slice(0, 7);
    var thisM = plans.filter(function (p) { return String(p.date).slice(0, 7) === monthP; })
      .reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0);
    var h = block('Your plans',
      plans.map(function (p) { return kv(whenLabel(p.date) + ' · ' + esc(p.name), money(p.amount)); }).join('') +
      kv('Total', money(total) + ' <span class="note" style="font-size:11px">' + money(thisM) + ' in ' + monthLabel(monthP) + '</span>'),
      null, null);
    return { html: h + freshness(ctx) };
  }

  var URGENT_RX = /\b(urgent|emergency|emergencies|unexpected|unplanned|unforeseen|unbudgeted|came up|just (?:got|received|found out|found|hit|been told)|oops|ugh|yikes)\b|\bneed(?:s|ed)? (?:to )?pay\b/;

  function intentUrgent(t, ctx, p) {
    if (!URGENT_RX.test(t)) return null;
    var A = p.amt;
    if (!A || A <= 0) {
      return { html: block('Urgent expense', line('Ouch. How much is it — and what’s it for?'), 'e.g. “urgent: car repair 8,000 this week”', 'warn') + freshness(ctx) };
    }
    var e = ctx.eff;
    var free = e.cash.free, total = e.cash.total, floor = e.floor || 0;
    var card = p.cardAcct || ((e.cards || [])[0] || null);
    var afterCash = r2(total - A);
    var h = '';
    h += line('<b>' + money(A) + '</b> unplanned' + (p.what ? ' · ' + esc(p.what) : '') + ' — the lay of the land:');
    h += kv('Free cash right now', money(free));
    h += kv('If paid in cash', money(afterCash) + ' <span class="note" style="font-size:11px">floor ' + money(floor) + '</span>');
    if (card) h += kv('If carded on ' + esc(card.name), 'prepay rises to ' + money(r2(e.total_prepay + A)) + ' on the ' + ordinal(e.prepay_day || 14));
    var gap = r2(A - Math.max(0, free));
    var frees = [];
    if (gap > 0) {
      var mp = (ctx.plans || []).filter(function (pl) { return pl.date >= todayISO().slice(0, 7) + '-01'; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var cum = 0;
      for (var i = 0; i < mp.length && cum < gap; i++) { cum = r2(cum + (Number(mp[i].amount) || 0)); frees.push(mp[i]); }
    }
    var actions = [];
    if (A <= free && afterCash >= floor) {
      h += '<div class="verdict good">Coverable: pay it in cash and you stay above the floor with ' + money(afterCash) + '. ' +
        (card ? 'Or card it on ' + esc(card.name) + ' if you’d rather keep the cash — the ' + ordinal(e.prepay_day || 14) + ' prepay absorbs it.' : '') + '</div>';
      actions.push({ label: 'Log expense · cash', act: 'log_expense', payload: { amount: A, kind: 'cash_out', category: p.cat, note: 'urgent: ' + (p.what || 'unplanned') } });
      if (card) actions.push({ label: 'Log expense · ' + esc(card.name), act: 'log_expense', payload: { amount: A, kind: 'card_charge', account: card.name, category: p.cat, note: 'urgent: ' + (p.what || 'unplanned') } });
    } else if (afterCash >= floor) {
      h += '<div class="verdict warn">Tight: it’s over free cash by ' + money(r2(A - free)) + ', but paying cash still keeps you at ' + money(afterCash) + ' (above the ' + money(floor) + ' floor).</div>';
      if (frees.length) h += line('Or free it up from plans: ' + frees.map(function (f2) { return esc(f2.name) + ' (' + money(f2.amount) + ')'; }).join(', '));
      actions.push({ label: 'Log expense · cash', act: 'log_expense', payload: { amount: A, kind: 'cash_out', category: p.cat, note: 'urgent: ' + (p.what || 'unplanned') } });
    } else {
      var borrow = r2(floor - afterCash);
      h += '<div class="verdict bad">This breaks the ' + money(floor) + ' floor: paying cash drops you to ' + money(afterCash) + '.</div>';
      h += line('Options: (1) trim plans — ' + (frees.length ? frees.map(function (f2) { return esc(f2.name) + ' ' + money(f2.amount); }).join(', ') + ' frees ' + money(cum) : 'nothing big enough') +
        '; (2) card it' + (card ? ' on ' + esc(card.name) + ' (prepay → ' + money(r2(e.total_prepay + A)) + ')' : '') +
        '; (3) bridge ' + money(borrow) + ' from a partner and repay it when cash allows.');
      if (card) actions.push({ label: 'Log expense · ' + esc(card.name), act: 'log_expense', payload: { amount: A, kind: 'card_charge', account: card.name, category: p.cat, note: 'urgent: ' + (p.what || 'unplanned') } });
      actions.push({ label: 'Add as plan instead', act: 'add_plan', payload: { name: p.what || 'Urgent expense', amount: A, date: todayISO() } });
    }
    actions.push({ label: 'Dismiss', act: 'noop' });
    return { html: '<div class="c-block">' + h + '</div>' + freshness(ctx), actions: actions };
  }

  function intentDeficit(t, ctx, p) {
    if (!/charge|swipe|cash[- ]back/.test(t) && !/\bcan\b.*\bbuy\b/.test(t)) return null;
    var A = p.amt;
    if (!A || A <= 0) {
      return { html: block('Charge check', line('How much would you charge?'), 'e.g. “can I charge 2,500 on Maya?”', 'good') + freshness(ctx) };
    }
    var e = ctx.eff;
    var free = e.cash.free;
    var card = p.cardAcct;
    var okv = A <= free;
    var h = block('Charge check',
      kv('Proposed charge', money(A) + (card ? ' <span class="note" style="font-size:11px">on ' + esc(card.name) + '</span>' : '')) +
      kv('Free / unallocated', money(free)) +
      kv('Cards owed after', money(r2(e.card_owed + A))) +
      (card && card.limit ? kv(card.name + ' utilization after', r2((card.balance + A) / card.limit * 100) + '% of ' + money(card.limit)) : ''),
      okv
        ? 'OK — cash backed. ' + money(r2(free - A)) + ' stays free.'
        : 'DEFICIT — short by ' + money(r2(A - free)) + '. Back it in cash first, or cut a plan.',
      okv ? 'good' : 'bad');
    var actions = [{ label: 'Log it · cash', act: 'log_expense', payload: { amount: A, kind: 'cash_out', category: p.cat || 'Other', note: 'charge check' } }];
    if (card) actions.push({ label: 'Log it · ' + esc(card.name), act: 'log_expense', payload: { amount: A, kind: 'card_charge', account: card.name, category: p.cat || 'Other', note: 'charge check' } });
    else actions.push({ label: 'Log it · card', act: 'log_expense', payload: { amount: A, kind: 'card_charge', category: p.cat || 'Other', note: 'charge check' } });
    return { html: h + freshness(ctx), actions: actions };
  }

  function intentLog(t, ctx, p) {
    // v35: casual past tense ("i paid for spaylater today 1828 pesos") logs like a command does
    var cmd = /^(log|record|add|note)\b/.test(t);
    var casual = /^(?:i|we)\s+(?:just\s+|already\s+|did\s+)?(?:paid|bought|spent|charged|gave|sent|swiped|used)\b/.test(t);
    if ((!cmd && !casual) || (!casual && !/\b(expense|spend|spent|charge|paid|payment|bought)\b/.test(t))) return null;
    var A = p.amt;
    if (!A || A <= 0) {
      return { html: block('Log an expense', line('How much, paid with what?'), 'e.g. “log expense 500 food maya” or “log 8,000 car repair cash”', 'good') + freshness(ctx) };
    }
    var acct = p.exactAcct || p.cashAcct || p.cardAcct || biggestCash(ctx) || { name: '', kind: 'cash' };
    var cat = p.cat || 'Other';
    var date = p.date || todayISO();
    var h = block('Log expense',
      kv(esc(acct.name || 'Cash'), money(A)) +
      kv('Category', esc(cat)) +
      kv('Date', esc(fmtDate(date))),
      'Tap to log it — it lands in the Ledger on this phone.', 'good');
    return {
      html: h + freshness(ctx),
      actions: [{
        label: 'Log ' + esc(money(A)) + (acct.name ? ' · ' + esc(acct.name) : ''),
        act: 'log_expense',
        payload: { amount: A, kind: acct.kind === 'card' ? 'card_charge' : 'cash_out', account: acct.name || '', category: cat, note: '' }
      }]
    };
  }

  function intentFallback(t) {
    return {
      html: block('Not sure about that one',
        line('I only answer from the numbers on this phone — that question is outside them.') +
        line('I can: <b>status</b> (free cash, prepay, cards), <b>details</b> (debt schedules, one-offs, sinking, cash in any month), <b>plans</b>, <b>charge checks</b>, <b>urgent-expense options</b>, and <b>what you’ve logged</b>.') +
        line('For anything else, the <b>Money</b> tab has the full numbers view.'),
        'Type “help” to see examples.', 'warn')
    };
  }

  // ---------- v35: story mode — casual updates -> validated base changes ----------
  // Everything here only BUILDS change objects + a draft. Writing happens solely
  // through F.applyBaseChanges on confirm; the app validates and saves the base.
  function findAmounts(text) {
    var out = [];
    var rx = /(?:php|₱|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(k\b)|(?:php|₱|pesos?)\s*([\d][\d,]*(?:\.\d{1,2})?)|([\d][\d,]*\.\d{1,2})|([\d][\d,]*)(\s*k\b)?/g;
    // v37: non-participating groups are '' under JScript (undefined in browsers) —
    // accept only a non-empty group string, like lev() uses charAt, not bracket indexing.
    function grp(m, i) { var v = m[i]; return (typeof v === 'string' && v !== '') ? v : null; }
    var m;
    while ((m = rx.exec(text)) !== null) {
      var n = grp(m, 1) || grp(m, 3) || grp(m, 4) || grp(m, 5);
      if (n == null) continue;
      var amt = Number(String(n).replace(/,/g, ''));
      if (grp(m, 1) != null && grp(m, 2) != null) amt *= 1000;
      else if (grp(m, 5) != null && grp(m, 6) != null) amt *= 1000;
      out.push({ raw: m[0], amt: amt, idx: m.index });
    }
    return out;
  }
  // one update can hold several facts; clauses split on ";", "," and " and "
  function clauseRanges(t) {
    var rs = [], s = 0, rx = /\s*[;,]\s*|\s+and\s+/g, m;
    while ((m = rx.exec(t)) !== null) {
      if (m.index > s) rs.push({ s: s, e: m.index });
      s = m.index + m[0].length;
    }
    if (s < t.length) rs.push({ s: s, e: t.length });
    return rs;
  }
  function isQuestion(cl) {
    return /^(?:what|whats|who|how|when|where|why|can|could|should|do|does|did|are|am|tell|show|check)\b/.test(cl);
  }
  function storyNames(ctx) {
    var b = (ctx && ctx.base) || {};
    var oneoffs = [];
    Object.keys(b.one_offs || {}).forEach(function (mo) {
      Object.keys(b.one_offs[mo] || {}).forEach(function (nm) { if (oneoffs.indexOf(nm) < 0) oneoffs.push(nm); });
    });
    return {
      budgets: Object.keys(b.budgets || {}),
      debts: Object.keys(b.debts || {}),
      oneoffs: oneoffs,
      sinks: Object.keys(b.sinking || {}),
      accounts: (b.accounts || []).map(function (a) { return { name: a.name, kind: a.kind }; })
    };
  }
  // score how well a stored name fits the clause tokens: 2 = strong, 1 = weak (one shared word), 0 = none
  function nameScore(name, toks) {
    var wds = String(name || '').toLowerCase().split(/[\s/]+/).filter(function (w) {
      return w.length >= 3 && w !== 'the' && w !== 'for' && w !== 'and';
    });
    if (!wds.length) return 0;
    var hits = 0;
    for (var i = 0; i < wds.length; i++) if (fuzzyTokIn(wds[i], toks)) hits += 1;
    if (!hits) return 0;
    return wds.length === 1 ? 2 : (hits >= 2 ? 2 : 1);
  }
  function fuzzyNameIn(pool, cl) {
    var toks = cl.split(/\s+/);
    var best = null, bestScore = 0, bestWords = 0;
    for (var i = 0; i < pool.length; i++) {
      var wds = String(pool[i]).toLowerCase().split(/[\s/]+/).filter(function (w) {
        return w.length >= 3 && w !== 'the' && w !== 'for' && w !== 'and';
      });
      var sc = nameScore(pool[i], toks);
      // tie-break: the more specific (fewer words) name wins
      if (sc > bestScore || (sc === bestScore && sc > 0 && wds.length < bestWords)) {
        best = pool[i]; bestScore = sc; bestWords = wds.length;
      }
    }
    return bestScore >= 1 ? best : null;
  }

  // ---------- v37: semantic story layer (local scorer, no cloud) ----------
  // Hand-tuned affinity vocabulary: a "topic" (word bucket or known entity) plus
  // optional action words, scored per clause. Only clauses the v35 regex cues
  // left alone ever reach the scorer — the cues always win.
  var SEM = {
    salary: ['salary', 'paycheck', 'payslip', 'take home', 'takehome', 'take-home', 'net pay', 'netpay', 'income'],
    budget: ['budget', 'budgeting', 'allowance', 'cap', 'capped', 'limit', 'limited', 'provision', 'set aside', 'set-aside', 'allocation', 'allocated'],
    pay: ['paid', 'paying', 'pay', 'pays', 'payment', 'payments', 'due', 'remitted', 'remittance', 'settled', 'cleared', 'took care of', 'handled'],
    oneoff: ['one-off', 'one off', 'oneoff', 'unexpected', 'surprise', 'extra', 'special', 'just once', 'this once'],
    recurring: ['monthly', 'every month', 'each month', 'a month', 'per month', 'subscription', 'sub', 'installment', 'installments', 'recurring'],
    acct: ['balance', 'balances', 'left', 'available', 'showing', 'holds', 'has', 'have', 'got', 'up to', 'down to', 'went up', 'went down', 'remaining'],
    change: ['went up', 'up to', 'down to', 'raised', 'raise', 'hiked', 'increased', 'bumped', 'cut', 'lowered', 'new', 'changed', 'became', 'adjusted'],
    weak: ['is', 'was', 'low', 'running low', 'running high', 'high', 'bit high']
  };
  var SEM_HI = 3.0;   // at/above: draft line (only when the required slots are present)
  var SEM_ASK = 2.0;  // at/above with a required slot missing: ask for the number
  var SEM_RE_BUDGET_NAME = /\bfor\s+([a-z'&\- ]{2,40}?)(?:\s+(?:is|was|in|this|on)\b|[,;]|\s(?=[\d,])|$)/;
  var SEM_RE_RECURRING_NAME = /\b(?:pay|paying|pays|for|to)\s+([a-z'&\- ]{2,40}?)(?:\s+(?:every|each|monthly|a|per|in|is|for|on)\b|[,;]|\s(?=[\d,])|$)/;
  var SEM_RE_ONEOFF_NAME = /(?:for|called|named)?\s*[:\-]?\s*([a-z][a-z'&\- ]{1,40}?)(?:\s+(?:is|was|in|this|on|for)\b|[,;]|\s(?=[\d,])|$)/;

  function semHas(cl, words) {
    for (var i = 0; i < words.length; i++) {
      if (new RegExp('\\b' + words[i] + '\\b').test(cl)) return true;
    }
    return false;
  }
  // Same two-pass rule as amtIn: amount in this clause, else a bare number in the
  // immediately following clause. (No after-idx / consumed needed — the cues ran
  // first, so no amounts were consumed in a clause that reaches the scorer.)
  function semAmtIn(r, rs, allAmt, t) {
    for (var pass = 0; pass < 2; pass++) {
      var rr = null;
      for (var x = 0; x < rs.length; x++) {
        if (rs[x].s === r.s && rs[x].e === r.e) { rr = pass === 0 ? rs[x] : (rs[x + 1] || null); break; }
      }
      if (!rr) break;
      for (var i = 0; i < allAmt.length; i++) {
        var a = allAmt[i];
        if (a.idx < rr.s || a.idx >= rr.e) continue;
        if (pass === 1 && !/^[\d][\d,\.]*\s*(k|php|pesos?)?\.?$/.test(t.slice(rr.s, rr.e).trim())) continue;
        return i;
      }
    }
    return null;
  }

  // Semantic candidate for one clause. Returns {line: {label, change}} or {ask: '...'} or null.
  function semClause(cl, r, rs, allAmt, names, t, cur) {
    if (isQuestion(cl)) return null;
    var toks = cl.split(/\s+/);
    var monthHere = storyMonth(cl);
    var month = monthHere || (/\bthis month\b/.test(cl) ? cur : null);

    var sal = semHas(cl, SEM.salary);
    var budw = semHas(cl, SEM.budget);
    var payw = semHas(cl, SEM.pay);
    var oow = semHas(cl, SEM.oneoff);
    var recw = semHas(cl, SEM.recurring);
    var acctw = semHas(cl, SEM.acct);
    var chg = semHas(cl, SEM.change);
    var weak = semHas(cl, SEM.weak);

    var entBudget = fuzzyNameIn(names.budgets, cl);
    var entDebt = fuzzyNameIn(names.debts, cl);
    var entAccount = null;
    for (var iA = 0; iA < names.accounts.length; iA++) {
      if (nameScore(names.accounts[iA].name, toks) >= 1) { entAccount = names.accounts[iA]; break; }
    }

    var ai = semAmtIn(r, rs, allAmt, t);
    var hasAmt = ai != null;
    var amt = hasAmt ? allAmt[ai].amt : null;

    // 1. salary — topic word + amount (month -> override, none -> base salary)
    if (sal) {
      var sc1 = 2.0 + (hasAmt ? 1.0 : 0.0) + (month ? 0.5 : 0.0);
      if (hasAmt && sc1 >= SEM_HI) {
        var ch1 = month ? { type: 'salary', month: month, amount: amt } : { type: 'salary_base', amount: amt };
        return { line: { label: month ? 'Salary · ' + monthLabel(month) : 'Base salary', change: ch1 } };
      }
      if (sc1 >= SEM_ASK) return { ask: "What's the new salary?" };
      return null;
    }
    // 2. account — known account + balance-ish word + amount
    if (entAccount) {
      var sc2 = (nameScore(entAccount.name, toks) >= 2 ? 2.0 : 1.0)
        + ((acctw || chg) ? 1.5 : (weak ? 1.0 : 0.0)) + (hasAmt ? 1.0 : 0.0);
      if (hasAmt && sc2 >= SEM_HI) {
        return { line: { label: 'Account · ' + entAccount.name, change: { type: 'account', name: entAccount.name, kind: entAccount.kind, value: amt } } };
      }
      if (sc2 >= SEM_ASK) return { ask: "What's the current balance for " + entAccount.name + "?" };
      return null;
    }
    // 3. debt payment — known debt + pay/change word + amount + month
    if (entDebt && (payw || chg)) {
      var sc3 = (nameScore(entDebt, toks) >= 2 ? 2.0 : 1.0)
        + 1.5 + (hasAmt ? 1.0 : 0.0) + (month ? 0.5 : 0.0);
      if (hasAmt && month && sc3 >= SEM_HI) {
        return { line: { label: 'Debt payment · ' + entDebt + ' · ' + monthLabel(month), change: { type: 'debt_payment', name: entDebt, month: month, amount: amt } } };
      }
      if (sc3 >= SEM_ASK) {
        return { ask: hasAmt ? "Which month is the " + entDebt + " payment for?" : "What's the new payment for " + entDebt + "?" };
      }
      return null;
    }
    // 4. budget — known budget (or budget word + extracted name) + amount
    var nmB2 = entBudget;
    if (!nmB2 && budw) {
      var fB2 = cl.match(SEM_RE_BUDGET_NAME);
      if (fB2 && fB2[1].trim().length >= 3 && !isMonthWord(fB2[1].trim())) nmB2 = fB2[1].trim();
    }
    if (nmB2 && !recw) { // recurring-cadence phrases belong to the recurring candidate
      var sc4 = 1.0 + ((chg || budw) ? 1.5 : (weak ? 1.0 : 0.0)) + (hasAmt ? 1.0 : 0.0) + (month ? 0.5 : 0.0);
      if (hasAmt && sc4 >= SEM_HI) {
        var ch4 = month
          ? { type: 'budget_override', month: month, name: nmB2, amount: amt }
          : { type: 'budget', name: nmB2, amount: amt };
        return { line: { label: month ? 'Budget · ' + nmB2 + ' · ' + monthLabel(month) : 'Budget · ' + nmB2, change: ch4 } };
      }
      if (entBudget && sc4 >= SEM_ASK) return { ask: "What's the new number for " + nmB2 + "?" };
      return null;
    }
    // 5. recurring — recurring word + amount + name (known or extracted)
    if (recw) {
      var nmR2 = fuzzyNameIn(names.debts.concat(names.budgets), cl);
      var known = !!nmR2;
      if (!nmR2) {
        var fR2 = cl.match(SEM_RE_RECURRING_NAME);
        if (fR2 && fR2[1].trim().length >= 3 && !isMonthWord(fR2[1].trim())) nmR2 = fR2[1].trim();
      }
      if (nmR2 && hasAmt) {
        var sc5 = 2.0 + 1.0 + (known ? 2.0 : 1.0);
        if (sc5 >= SEM_HI) {
          var monthsR2 = [];
          for (var kR2 = 0; kR2 < 6; kR2++) monthsR2.push(addMonthsKey(kR2));
          return { line: { label: 'Recurring · ' + nmR2 + ' · 6 months', change: { type: 'recurring', name: nmR2, amount: amt, months: monthsR2 } } };
        }
      }
      return null;
    }
    // 6. one-off — oneoff word + amount + name (known or extracted)
    if (oow) {
      var nmO2 = fuzzyNameIn(names.oneoffs, cl);
      if (!nmO2) {
        var fO2 = cl.match(SEM_RE_ONEOFF_NAME);
        if (fO2 && fO2[1].trim().length >= 3 && !isMonthWord(fO2[1].trim())) nmO2 = fO2[1].trim();
      }
      if (nmO2 && hasAmt) {
        var moO2 = monthHere || storyMonth(t) || cur;
        return { line: { label: 'One-off · ' + nmO2 + ' · ' + monthLabel(moO2), change: { type: 'one_off', month: moO2, name: nmO2, amount: amt } } };
      }
      return null;
    }
    return null;
  }

  // Parse a normalized update into change objects app.js can validate & apply.
  // v37: v35 regex cues first; clauses they leave alone go to the semantic scorer,
  // which may add a line or a targeted question (asks).
  function storyParse(t, ctx) {
    var lines = [];
    var asks = [];
    if (!t) return { lines: lines, asks: asks };
    var names = storyNames(ctx);
    var cur = curMonthKey();
    var rs = clauseRanges(t);
    var allAmt = findAmounts(t);

    function amtIn(r, afterIdx, consumed) {
      for (var pass = 0; pass < 2; pass++) {
        var rr = null;
        for (var x = 0; x < rs.length; x++) {
          if (rs[x].s === r.s && rs[x].e === r.e) { rr = pass === 0 ? rs[x] : (rs[x + 1] || null); break; }
        }
        if (!rr) break;
        for (var i = 0; i < allAmt.length; i++) {
          var a = allAmt[i];
          if (a.idx < rr.s || a.idx >= rr.e) continue;
          if (pass === 0 && afterIdx != null && a.idx < afterIdx) continue;
          if (consumed.indexOf(i) >= 0) continue;
          if (pass === 1 && !/^[\d][\d,\.]*\s*(k|php|pesos?)?\.?$/.test(t.slice(rr.s, rr.e).trim())) continue; // bare-number clause only
          return i;
        }
      }
      return null;
    }

    rs.forEach(function (r) {
      var cl = t.slice(r.s, r.e).trim();
      if (!cl || cl.length < 4) return;
      var consumed = [];
      var clToks = cl.split(/\s+/);
      var monthHere = storyMonth(cl);
      var nBefore = lines.length; // v37: semantic fallback only for clauses the cues left alone

      // 1. salary — "my salary in october is 25k" (a month -> override; none -> base salary)
      var salM = cl.match(/\b(?:my\s+|our\s+)?(?:new\s+|base\s+)?salary\b|\bpaycheck\b|\bpayslip\b/);
      if (salM) {
        var ai = amtIn(r, salM.index, consumed);
        if (ai != null) {
          consumed.push(ai);
          var a = allAmt[ai];
          if (monthHere) lines.push({ label: 'Salary · ' + monthLabel(monthHere), change: { type: 'salary', month: monthHere, amount: a.amt } });
          else if (/\bthis month\b/.test(cl)) lines.push({ label: 'Salary · ' + monthLabel(cur), change: { type: 'salary', month: cur, amount: a.amt } });
          else lines.push({ label: 'Base salary', change: { type: 'salary_base', amount: a.amt } });
          return;
        }
      }

      // 2. budget with an explicit cue — "budget for food is 8k"
      var budM = cl.match(/\bbudget(?:ing)?(?:\s+for)?\b/);
      if (budM) {
        var aiB = amtIn(r, budM.index, consumed);
        if (aiB != null) {
          consumed.push(aiB);
          var aB = allAmt[aiB];
          var nmB = fuzzyNameIn(names.budgets, cl);
          if (!nmB) {
            var fB = cl.slice(budM.index).match(/\bfor\s+([a-z'&\- ]{2,40}?)(?:\s+(?:is|was|in|this|on)\b|[,;]|\s(?=[\d,])|$)/);
            if (fB && fB[1].trim().length >= 3 && !isMonthWord(fB[1].trim())) nmB = fB[1].trim();
          }
          if (nmB) {
            var moB = monthHere || (/\bthis month\b/.test(cl) ? cur : null);
            lines.push(moB
              ? { label: 'Budget · ' + nmB + ' · ' + monthLabel(moB), change: { type: 'budget_override', month: moB, name: nmB, amount: aB.amt } }
              : { label: 'Budget · ' + nmB, change: { type: 'budget', name: nmB, amount: aB.amt } });
            return;
          }
        }
      }

      // 3. one-off — "one-off: december power bill 1500"
      var ooM = cl.match(/\bone[- ]?offs?\b/);
      if (ooM) {
        var aiO = amtIn(r, ooM.index, consumed);
        if (aiO != null) {
          consumed.push(aiO);
          var aO = allAmt[aiO];
          var nmO = fuzzyNameIn(names.oneoffs, cl);
          if (!nmO) {
            var fO = cl.slice(ooM.index + ooM[0].length).match(/^\s*(?:for|called|named)?\s*[:\-]?\s*([a-z'&\- ]{2,40}?)(?:\s+(?:in|for|on)\s+[a-z]{3,}\b|[,;]|\s(?=[\d,])|\s*$)/);
            if (fO && fO[1].trim().length >= 3 && !isMonthWord(fO[1].trim())) nmO = fO[1].trim();
          }
          if (nmO) {
            var moO = monthHere || storyMonth(t) || cur;
            lines.push({ label: 'One-off · ' + nmO + ' · ' + monthLabel(moO), change: { type: 'one_off', month: moO, name: nmO, amount: aO.amt } });
            return;
          }
        }
      }
      // 4. recurring — "gym is 2000 every month"
      var recM = cl.match(/\b(?:every|each)\s+month\b|\bmonthly\b/);
      if (recM) {
        var aiR = amtIn(r, null, consumed);
        if (aiR != null) {
          consumed.push(aiR);
          var aR = allAmt[aiR];
          var nmR = fuzzyNameIn(names.debts.concat(names.budgets), cl);
          if (!nmR) {
            var fR = cl.match(/\b(?:pay|paying|pays|for|to)\s+([a-z'&\- ]{2,40}?)(?:\s+(?:every|each|monthly|in|is|for|on)\b|[,;]|\s(?=[\d,])|$)/);
            if (fR && fR[1].trim().length >= 3 && !isMonthWord(fR[1].trim())) nmR = fR[1].trim();
          }
          if (nmR) {
            var monthsR = [];
            for (var kR = 0; kR < 6; kR++) monthsR.push(addMonthsKey(kR));
            lines.push({ label: 'Recurring · ' + nmR + ' · 6 months', change: { type: 'recurring', name: nmR, amount: aR.amt, months: monthsR } });
            return;
          }
        }
      }

      // 5. debt payment for a known debt — "ave payment in october is 2200" (needs a month)
      if (/\b(?:pay|pays|paying|payment|payments|due)\b/.test(cl)) {
        var nmD = fuzzyNameIn(names.debts, cl);
        if (nmD) {
          var aiD = amtIn(r, null, consumed);
          if (aiD != null) {
            consumed.push(aiD);
            var aD = allAmt[aiD];
            var moD = monthHere || storyMonth(t);
            if (moD) {
              lines.push({ label: 'Debt payment · ' + nmD + ' · ' + monthLabel(moD), change: { type: 'debt_payment', name: nmD, month: moD, amount: aD.amt } });
              return;
            }
          }
        }
      }

      // 6. casual budget update for a known budget — "water went up to 1800"
      //    (v37: recurring-cadence phrases defer to the semantic recurring candidate)
      if (!isQuestion(cl) && !/\b(?:every|each)\s+month\b|\bmonthly\b|\ba month\b|\bper month\b/.test(cl)) {
        var nmC = fuzzyNameIn(names.budgets, cl);
        if (nmC) {
          var aiC = amtIn(r, null, consumed);
          if (aiC != null) {
            consumed.push(aiC);
            var aC = allAmt[aiC];
            var moC = monthHere || (/\bthis month\b/.test(cl) ? cur : null);
            lines.push(moC
              ? { label: 'Budget · ' + nmC + ' · ' + monthLabel(moC), change: { type: 'budget_override', month: moC, name: nmC, amount: aC.amt } }
              : { label: 'Budget · ' + nmC, change: { type: 'budget', name: nmC, amount: aC.amt } });
            return;
          }
        }
      }

      // 7. account balance update — "gcash balance is 50k"
      var nmA = null;
      for (var iA = 0; iA < names.accounts.length; iA++) {
        if (nameScore(names.accounts[iA].name, clToks) >= 1) { nmA = names.accounts[iA]; break; }
      }
      if (nmA && /\b(?:balance|left|has|have|got|showing|available)\b/.test(cl)) {
        var aiA = amtIn(r, null, consumed);
        if (aiA != null) {
          consumed.push(aiA);
          var aA = allAmt[aiA];
          lines.push({ label: 'Account · ' + nmA.name, change: { type: 'account', name: nmA.name, kind: nmA.kind, value: aA.amt } });
        }
      }

      // v37: semantic fallback for clauses the v35 cues left alone
      if (lines.length === nBefore) {
        var sem = semClause(cl, r, rs, allAmt, names, t, cur);
        if (sem) {
          if (sem.line) lines.push(sem.line);
          else if (sem.ask) asks.push(sem.ask);
        }
      }
    });

    var uniq = [];
    for (var iu = 0; iu < asks.length; iu++) if (uniq.indexOf(asks[iu]) < 0) uniq.push(asks[iu]);
    return { lines: lines, asks: uniq.slice(0, 2) };
  }
  // v35 API kept for callers/gates: lines only
  function extractStory(t, ctx) { return storyParse(t, ctx).lines; }
  function storyAsks(t, ctx) { return storyParse(t, ctx).asks; }

  function intentStory(t, ctx, p) {
    var parsed = storyParse(t, ctx);
    var changes = parsed.lines;
    var asks = parsed.asks;
    if (!changes.length && !asks.length) return null;
    if (!changes.length) {
      // v37: the scorer recognized the topic but a number is missing — ask for it
      var qRows = asks.map(function (q) { return line(esc(q)); }).join('');
      var hq = block('One number short',
        qRows + line('<span class="note">tell me the number and I\'ll draft the change for you</span>'),
        'Nothing is written yet — just answer the question above.', 'good');
      // v38: remember this question so the next bare answer can complete it.
      pendingAsk = (asks.length === 1)
        ? { t: t, kind: asks[0].indexOf('Which month') === 0 ? 'month' : 'amt', ent: askEntity(asks[0]) }
        : null;
      return { html: hq + freshness(ctx), actions: [], storyLines: [], storyRaw: t, storyAsk: asks.join(' · ') };
    }
    var rows = changes.map(function (l, i) {
      var v = l.change.amount != null ? l.change.amount : l.change.value;
      return '<div class="ins-line"><b>' + (i + 1) + '.</b> ' + esc(l.label) + ' — ' + esc(money(v)) + '</div>';
    }).join('');
    var actions = changes.map(function (l, i) {
      return { label: '✕ ' + l.label, act: 'story_drop_line', payload: { i: i } };
    });
    actions.push({ label: 'Confirm ' + changes.length + ' change' + (changes.length > 1 ? 's' : ''), act: 'confirm_story', payload: { lines: changes } });
    actions.push({ label: 'Discard', act: 'discard_story' });
    var askNote = asks.length ? line('<span class="note">also missing: ' + esc(asks.join(' — ')) + '</span>') : '';
    var h = block('Draft: base-data changes',
      rows + askNote + line('<span class="note">nothing is written yet — tap ✕ to drop a line, or confirm to apply</span>'),
      null);
    return { html: h + freshness(ctx), actions: actions, storyLines: changes, storyRaw: t, storyAsk: asks.join(' · ') };
  }

  // ---------- the online coach ----------
  // The rule engine above owns every command; only an open question that slips
  // past it reaches the coach. The coach is the ONLINE LLM (Worker or bring-
  // your-own key) — text only, no actions of its own, no writes. When it's off,
  // offline or not configured, the fallback card stands in its place.
  function aiCoach(t, ctx) {
    var FAI = typeof window !== 'undefined' ? window.FinAI : null;
    if (!FAI || !ctx.eff) return null;
    if (!FAI.remoteAvailable()) return null;
    var pr = aiPrompt(t, ctx, true, recentHist);
    // the Worker caps prompt JSON at 4000 chars — if the numbers + memory push
    // it over, send the same prompt without the conversation memory
    if (JSON.stringify(pr).length > 3800) pr = aiPrompt(t, ctx, true, []);
    return { llm: true, prompt: pr };
  }
  // v55: the shared, locally-computed month snapshot. ONE source of the
  // coach's numbers: it feeds the chat prompts (aiContextText) AND the Home
  // "Coach's note" card (app.js renderCoachNote, via the __financeChat hooks).
  // fp is a cheap fingerprint of the numbers for the note cache: same numbers
  // → same fp, so the card only calls the coach when something changed.
  function coachSnapshot(ctx) {
    var e = ctx && ctx.eff;
    if (!e) return { text: '', fp: '' };
    var L = [];
    L.push('My numbers on this phone (as of ' + (ctx.at ? new Date(ctx.at).toLocaleDateString() : 'today') + '):');
    L.push('- liquid cash ' + money(e.cash.total) + ', free ' + money(e.cash.free) + ', floor ' + money(e.floor || 0));
    L.push('- cards owed ' + money(e.card_owed || 0) + ', prepay on the ' + ordinal(e.prepay_day || 14) + ': ' + money(e.total_prepay || 0));
    // exact stored names, so a remote draft can name an existing
    // account/budget instead of inventing one.
    var sn = storyNames(ctx);
    var accs = sn.accounts.map(function (a) { return a.name + ' (' + a.kind + ')'; });
    if (accs.length) L.push('- accounts: ' + accs.slice(0, 8).join(', '));
    if (sn.budgets.length) L.push('- budgets: ' + sn.budgets.slice(0, 6).join(', '));
    var debts = (e.obligations && e.obligations.debts) || [];
    for (var i = 0; i < Math.min(4, debts.length); i++) {
      var d = debts[i];
      L.push('- ' + d.name + ': this month ' + money(d.this_month || 0) + (d.balance != null ? ', left ' + money(d.balance) : ''));
    }
    var oo = (e.obligations && e.obligations.one_offs) || [];
    for (var j = 0; j < Math.min(3, oo.length); j++) L.push('- one-off ' + oo[j].name + ' in ' + (oo[j].month || '') + ': ' + money(oo[j].amount || 0));
    var sk = e.sinking || [];
    for (var k = 0; k < Math.min(3, sk.length); k++) L.push('- goal ' + sk[k].name + ': ' + money(sk[k].funded || 0) + ' of ' + money(sk[k].goal || 0));
    var spend = {}, total = 0;
    for (var x = 0; x < (ctx.txns || []).length; x++) {
      var tn = ctx.txns[x];
      if (e.month && String(tn.date || '').slice(0, 7) !== e.month) continue;
      var c = tn.category || 'Unsorted';
      spend[c] = (spend[c] || 0) + (Number(tn.amount) || 0);
      total += Number(tn.amount) || 0;
    }
    var top = [];
    Object.keys(spend).forEach(function (c2) { top.push([c2, spend[c2]]); });
    top.sort(function (a, b) { return b[1] - a[1]; });
    if (top.length) L.push('- logged this month ' + money(total) + ': ' + top.slice(0, 4).map(function (z) { return z[0] + ' ' + money(z[1]); }).join(', '));
    var text = L.join('\n');
    return { text: text, fp: (ctx.at || '') + '|' + text };
  }
  function aiContextText(t, ctx, hist) {
    var L = [];
    // v55: the shared snapshot above, not a second hand-built numbers list
    L.push(coachSnapshot(ctx).text || 'My numbers on this phone: nothing stored yet.');
    L.push('');
    // the last few turns, so "and next month?" knows what we just talked about
    var hLines = (hist || []).map(function (h) { return (h.who === 'user' ? 'You: ' : 'Coach: ') + h.txt; });
    if (hLines.length) { L.push('Recent conversation (short, for context):'); L.push(hLines.join('\n')); L.push(''); }
    // v55: an open (unconfirmed) draft — the user's next words are a reply to it
    if (openDraft && openDraft.lines && openDraft.lines.length) {
      L.push('An UNCONFIRMED draft of base-data changes is on screen:');
      for (var od = 0; od < openDraft.lines.length; od++) L.push('- ' + openDraft.lines[od]);
      if (openDraft.say) L.push('You said: ' + openDraft.say);
      L.push('');
    }
    L.push('Question: ' + t);
    return L.join('\n');
  }
  // v46: the remote coach can also DRAFT a number change as strict JSON when the
  // user asks to add/change something. The app validates the JSON against the
  // story-mode shapes and the existing confirm/undo flow — the model itself
  // still writes nothing.
  var AI_REMOTE_SYSTEM = 'You are Fin.AI, a personal money coach. Answer only from the numbers given, in 1-3 short plain sentences (under 60 words), no lists, no markdown, no emojis. Never invent numbers. ' +
    'When the user tells you a change to their money (a new or updated number, or a story of several changes), FIRST make sure you understand it: reply with a one-line paraphrase ("So you\'re telling me: ...") and ask only for the details you truly need (amount, month, which account). Do NOT output any JSON until the user confirms (yes / exactly / right / go ahead) or supplies the last missing detail. ' +
    'If an UNCONFIRMED draft of changes is provided as context, the user\'s message is a reply to that draft: if they correct it, reply with the corrected JSON draft; if they confirm it, reply with the same JSON draft; if they switch topics, answer the new topic. ' +
    'Once confirmed, reply with ONLY a JSON object and nothing else: {"say":"one short line","changes":[...]} where each change is exactly one of: {"type":"account","name":"N","kind":"cash|card|debt|loan","value":123,"limit":123} | {"type":"salary_base","amount":123} | {"type":"salary","month":"YYYY-MM","amount":123} | {"type":"budget","name":"N","amount":123} | {"type":"budget_override","month":"YYYY-MM","name":"N","amount":123} | {"type":"debt_payment","name":"N","month":"YYYY-MM","amount":123} | {"type":"one_off","name":"N","month":"YYYY-MM","amount":123} | {"type":"recurring","name":"N","amount":123}. Use only names from the numbers list or a new name the user stated. If a needed detail (which account, amount, month) is missing, reply {"say":"ask for the missing detail"} with no changes. If the user is not asking to change anything, reply plain text only, never JSON.';
  function aiPrompt(t, ctx, remote, hist) {
    return [
      { role: 'system', content: AI_REMOTE_SYSTEM },
      { role: 'user', content: aiContextText(t, ctx, hist) }
    ];
  }

  // v47: guided first-time setup. With an empty base the normal number intents
  // can't answer, so (when the online coach is available) we route to a setup
  // prompt: the coach walks the user through a generic checklist and drafts the
  // numbers as strict JSON — the same confirm/undo flow as a story. Setup
  // needs a remote path (Worker or bring-your-own).
  var AI_SETUP_SYSTEM = 'You are Finance, a personal money coach helping a user set up their numbers for the first time. Their phone has NO numbers stored yet. Be warm and brief (under 35 words), no markdown, no emojis. Ask for 1-2 things at a time, in this order: (1) cash accounts, (2) cards (name, balance and limit), (3) monthly salary, (4) debts / monthly payments, (5) monthly budgets, (6) goals / sinking funds, (7) one-offs this month. Use ONLY the exact names and amounts the user gives — never invent or assume a number. When the user has given you specific numbers, reply with ONLY a JSON object and nothing else: {"say":"one short line","changes":[...]} where each change is exactly one of: {"type":"account","name":"N","kind":"cash|card","value":123,"limit":123} (limit only for cards) | {"type":"salary_base","amount":123} | {"type":"salary","month":"YYYY-MM","amount":123} | {"type":"budget","name":"N","amount":123} | {"type":"debt_payment","name":"N","month":"YYYY-MM","amount":123} | {"type":"one_off","name":"N","month":"YYYY-MM","amount":123} | {"type":"recurring","name":"N","amount":123}. If the user has not given a specific number yet, reply plain text asking for the next thing — never JSON.';
  function setupPrompt(t, ctx, hist) {
    var L = [];
    L.push('Setup mode: the user is building their numbers from scratch on this phone. Nothing is stored yet.');
    L.push('Suggested order: cash accounts → cards (balance + limit) → monthly salary → debts / monthly payments → budgets → goals → one-offs this month.');
    L.push('Ask 1-2 things at a time. Use only the user\'s own names and amounts; never invent a number.');
    var hLines = (hist || []).map(function (h) { return (h.who === 'user' ? 'You: ' : 'Coach: ') + h.txt; });
    if (hLines.length) { L.push('Recent conversation (short, for context):'); L.push(hLines.join('\n')); L.push(''); }
    L.push('Question: ' + t);
    return [{ role: 'system', content: AI_SETUP_SYSTEM }, { role: 'user', content: L.join('\n') }];
  }
  function aiSetup(t, ctx) {
    var FAI = typeof window !== 'undefined' ? window.FinAI : null;
    if (!FAI) return null;
    if (!(FAI.remoteEnabled() && FAI.remoteConfigured() && (typeof navigator === 'undefined' || navigator.onLine !== false))) return null;
    var pr = setupPrompt(t, ctx, recentHist);
    if (JSON.stringify(pr).length > 3800) pr = setupPrompt(t, ctx, []);
    return { llm: true, prompt: pr };
  }
  // v46: the coach's short memory — the last few turns, tag-stripped and capped,
  // so the prompt stays under the Worker's input cap even on a busy phone.
  function coachHist(rows, skipId) {
    var out = [];
    var rs = (rows || []).slice().sort(function (a, b) { return a.at < b.at ? -1 : 1; });
    for (var i = rs.length - 1; i >= 0 && out.length < 6; i--) {
      var m = rs[i];
      if (!m || m.id === skipId) continue;
      var txt = m.who === 'user' ? String(m.text || '') : String(m.html || '').replace(/<[^>]+>/g, ' ');
      txt = txt.replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      out.unshift({ who: m.who, txt: txt.slice(0, 160) });
    }
    return out;
  }
  // v46: parse + validate a remote reply that should be a change draft.
  // Returns null for plain-text answers (or broken JSON), so a bad model reply
  // degrades to a normal text answer instead of a broken card.
  var COACH_KINDS = { cash: 1, card: 1, debt: 1, loan: 1 };
  function coachChangeLabel(ch) {
    if (ch.type === 'account') return 'Account · ' + ch.name + (ch.kind && ch.kind !== 'cash' ? ' (' + ch.kind + ')' : '');
    if (ch.type === 'salary_base') return 'Base salary';
    if (ch.type === 'salary') return 'Salary · ' + (ch.month || '');
    if (ch.type === 'budget' || ch.type === 'budget_override') return 'Budget · ' + ch.name + (ch.month ? ' · ' + ch.month : '');
    if (ch.type === 'debt_payment') return 'Debt payment · ' + ch.name + ' · ' + (ch.month || '');
    if (ch.type === 'one_off') return 'One-off · ' + ch.name + ' · ' + (ch.month || '');
    if (ch.type === 'recurring') return 'Recurring · ' + ch.name + ' · 6 months';
    return ch.type;
  }
  // Sanitize one model-emitted change into the exact shape applyBaseChange
  // validates (mirrors the story-mode rules: same types, same required fields).
  function coachSanitizeChange(c) {
    if (!c || typeof c !== 'object' || typeof c.type !== 'string') return null;
    function num(x) { var n = Number(x); return isFinite(n) && Math.abs(n) <= 1e9 ? n : null; }
    function mon(x) { return /^\d{4}-\d{2}$/.test(String(x || '')) ? String(x) : null; }
    function nm(x) { var s = String(x || '').trim().slice(0, 40); return s || null; }
    switch (c.type) {
      case 'account': {
        var name = nm(c.name), kind = COACH_KINDS[c.kind] ? c.kind : 'cash', value = num(c.value);
        if (!name || value == null || value < 0) return null;
        var limit = (kind === 'card') ? num(c.limit) : null;
        return (limit != null && limit > 0)
          ? { type: 'account', name: name, kind: kind, value: value, limit: limit }
          : { type: 'account', name: name, kind: kind, value: value };
      }
      case 'salary_base': {
        var a0 = num(c.amount);
        return a0 != null && a0 >= 0 ? { type: 'salary_base', amount: a0 } : null;
      }
      case 'salary': {
        var m1 = mon(c.month), a1 = num(c.amount);
        return m1 && a1 != null && a1 >= 0 ? { type: 'salary', month: m1, amount: a1 } : null;
      }
      case 'budget': {
        var n2 = nm(c.name), a2 = num(c.amount);
        return n2 && a2 != null && a2 >= 0 ? { type: 'budget', name: n2, amount: a2 } : null;
      }
      case 'budget_override': {
        var m2 = mon(c.month), n3 = nm(c.name), a3 = num(c.amount);
        return m2 && n3 && a3 != null && a3 >= 0 ? { type: 'budget_override', month: m2, name: n3, amount: a3 } : null;
      }
      case 'debt_payment': {
        var m3 = mon(c.month), n4 = nm(c.name), a4 = num(c.amount);
        return m3 && n4 && a4 != null && a4 >= 0 ? { type: 'debt_payment', month: m3, name: n4, amount: a4 } : null;
      }
      case 'one_off': {
        var m4 = mon(c.month), n5 = nm(c.name), a5 = num(c.amount);
        return m4 && n5 && a5 != null && a5 >= 0 ? { type: 'one_off', month: m4, name: n5, amount: a5 } : null;
      }
      case 'recurring': {
        var n6 = nm(c.name), a6 = num(c.amount);
        if (!n6 || a6 == null || a6 <= 0) return null;
        var months = [];
        for (var k = 0; k < 6; k++) months.push(addMonthsKey(k));
        return { type: 'recurring', name: n6, amount: a6, months: months };
      }
      default:
        return null;
    }
  }
  function parseCoachDraft(txt) {
    var s = String(txt || '').replace(/^\s+|\s+$/g, '');
    if (!s || s.charCodeAt(0) !== 123) return null; // 123 = opening brace
    var d = null;
    try { d = JSON.parse(s); } catch (e) { return null; }
    if (!d || typeof d !== 'object') return null;
    var say = typeof d.say === 'string' ? d.say.slice(0, 300) : '';
    var raw = Array.isArray(d.changes) ? d.changes : [];
    var changes = [];
    for (var i = 0; i < raw.length && changes.length < 4; i++) {
      var ch = coachSanitizeChange(raw[i]);
      if (ch) changes.push(ch);
    }
    if (!say && !changes.length) return null;
    return { say: say, changes: changes };
  }
  // v47: plain answer — no "Coach"/source line in the reply (the availability LED
  // in the main header now carries that), and the per-message as-of note is gone.
  function aiAnswerHtml(txt, ctx, err, src) {
    var inner = txt
      ? esc(txt).replace(/\n/g, '<br>')
      : (err ? 'I couldn’t answer that (' + esc(err) + ').' : 'I had nothing to add.') +
        ' I still know your numbers — try <b>status</b>, <b>plans</b> or <b>help</b>.';
    return '<div class="c-block"><div class="ins-line">' + inner + '</div></div>';
  }

  // ---------- dispatch ----------
  function handle(raw, ctx) {
    var t = norm(raw);
    if (!t) return intentFallback('');
    if (!ctx.eff) {
      // v47: a few intents work with no numbers yet (greet, help, plans) — those
      // run first. Anything else is setup: it goes to the online coach when one is
      // available, otherwise the "No numbers yet" card with the setup entry points.
      var emptySafe = [intentGreet, intentHelp, intentPlanRemove, intentPlanAdd, intentPlanList];
      for (var ei = 0; ei < emptySafe.length; ei++) {
        var er = emptySafe[ei](t, ctx);
        if (er) return er;
      }
      var setup = aiSetup(t, ctx);
      if (setup) return setup;
      var setupWanted = /set ?up|build (my )?(the )?numbers|start (from|over|setting)/.test(t);
      return {
        html: block(setupWanted ? 'Online coach needed' : 'No numbers yet',
          line(setupWanted
            ? 'I build your numbers with you using the online coach. Turn it on in Settings → Remote coach (a Worker URL or your own key), then ask me again.'
            : 'Tell me your accounts, salary, debts and budgets and I’ll set them up with you — or add them yourself.'),
          'Everything is stored on this phone — no sheet needed.', 'warn'),
        actions: [
          { label: 'Set up with the coach', act: 'start_setup' },
          { label: 'Open Settings', act: 'open_settings' }
        ]
      };
    }
    // v55: coach-first. While the online coach is available and "Coach answers
    // everything" is on (default), it handles the message BEFORE the rule
    // engine — including the confirm-understanding protocol for change stories
    // and correcting an open draft. The rule engine stays the offline fallback
    // (and the only writer either way).
    var FAI0 = typeof window !== 'undefined' ? window.FinAI : null;
    if (FAI0 && FAI0.remoteAvailable() && FAI0.forceOnline()) {
      var aiFirst = aiCoach(t, ctx);
      if (aiFirst) return aiFirst;
    }
    var dm = findDateSpan(t);
    var amtText = dm ? t.replace(dm.raw, ' ') : t;
    var am = findAmount(amtText);
    var fa = findAccounts(t, ctx);
    var p = {
      date: dm ? dm.iso : null,
      amt: am ? am.amt : null,
      cat: guessCategory(t),
      what: extractWhat(amtText, am),
      exactAcct: fa.exact,
      cardAcct: fa.exact && fa.exact.kind === 'card' ? fa.exact : (fa.words.filter(function (w) { return w.kind === 'card'; })[0] || null),
      cashAcct: fa.exact && fa.exact.kind === 'cash' ? fa.exact : (fa.words.filter(function (w) { return w.kind === 'cash'; })[0] || null)
    };
    // v38: a pending "One number short" ask is completed by the very next bare
    // number, named amount, or bare month — re-parsed as question + answer
    // through the same validated story flow. Anything else closes the
    // question and routes normally.
    if (pendingAsk) {
      var namedOk = RX_ANS_NAMED.test(t) && pendingAsk.ent && nameScore(pendingAsk.ent, t.split(' ')) >= 1;
      var ansOk = pendingAsk.kind === 'month'
        ? RX_ANS_MONTH.test(t)
        : (RX_ANS_AMT.test(t) || namedOk);
      if (ansOk) {
        var joined = pendingAsk.t + ' ' + t;
        pendingAsk = null;
        var rj = intentStory(joined, ctx, p);
        if (rj && rj.storyLines && rj.storyLines.length) return rj; // completed draft
        if (rj && rj.storyAsk) return rj; // still short — new ask, pendingAsk re-set
        return {
          html: block('Didn’t connect that',
            line('Try one full sentence — e.g. <b>“my salary in october is 24k”</b>. The question is closed.'),
            null, 'warn'),
          actions: []
        };
      }
      pendingAsk = null;
    }
    var order = [intentHelp, intentGreet, intentPlanRemove, intentPlanAdd, intentPlanList,
      intentUrgent, intentLog, intentDeficit, intentSpend, intentStory,
      intentDebt, intentOneOff, intentSinking, intentFuture, intentStatus];
    for (var i = 0; i < order.length; i++) {
      var r = order[i](t, ctx, p);
      if (r) return r;
    }
    // v49: nothing the rules own matched — this is an open question. It goes to
    // the online coach (when available); otherwise the plain fallback card.
    var aiRes = aiCoach(t, ctx);
    if (aiRes) return aiRes;
    return intentFallback(t);
  }

  // ---------- chat store + message UI ----------
  var inputEl = null, msgsEl = null;
  var CHIPS = ['How much is free?', 'My cc prepay', 'What’s coming up?', 'Urgent expense'];

  function chatId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function loadChat() {
    return F.idbAll(F.STORE_CHAT).then(function (rows) {
      return (rows || []).sort(function (a, b) { return a.at < b.at ? -1 : 1; });
    });
  }
  function saveMsg(m) { return F.idbPut(F.STORE_CHAT, m); }
  function actionsHtml(m) {
    if (m.who !== 'bot' || !m.actions || !m.actions.length) return '';
    if (m.done) return '<div class="a-row"><span class="c-done">✓ done</span></div>';
    var h = '<div class="a-row">';
    m.actions.forEach(function (a, i) { h += '<button type="button" class="c-act" data-ai="' + i + '">' + a.label + '</button>'; });
    return h + '</div>';
  }
  function msgEl(m) {
    var d = document.createElement('div');
    d.className = 'msg ' + (m.who === 'user' ? 'user' : 'bot');
    d.setAttribute('data-cid', m.id);
    d.innerHTML = (m.who === 'user' ? '<div class="c-tx">' + esc(m.text) + '</div>' : m.html) + actionsHtml(m);
    return d;
  }
  function scrollBottom() { if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight; }
  function bindActions(el, m) {
    var btns = el.querySelectorAll('[data-ai]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = (function (idx) {
        return function () { runAction(m, m.actions[idx]); };
      })(Number(btns[i].getAttribute('data-ai')));
    }
  }
  function appendMsg(m) {
    var el = msgEl(m);
    bindActions(el, m);
    msgsEl.appendChild(el);
    scrollBottom();
  }
  function renderMsgs(rows) {
    msgsEl.innerHTML = '';
    rows.slice(-100).forEach(function (m) { appendMsg(m); });
  }
  function markDone(m) {
    m.done = true;
    saveMsg(m);
    var el = msgsEl ? msgsEl.querySelector('[data-cid="' + m.id + '"]') : null;
    if (el) {
      var a = el.querySelector('.a-row');
      if (a) a.innerHTML = '<span class="c-done">✓ done</span>';
    }
  }
  function pushBot(textHtml) {
    var m = { id: chatId(), who: 'bot', html: '<div class="c-block"><div class="ins-line">' + textHtml + '</div></div>', actions: [], at: new Date().toISOString() };
    return saveMsg(m).then(function () { appendMsg(m); });
  }

  function runAction(m, a) {
    pendingAsk = null; // v38: any explicit action closes a pending question
    if (!a || a.act === 'noop') { markDone(m); return; }
    var pl = a.payload || {};
    if (a.act === 'open_tab') {
      F.setTab(pl.tab);
      markDone(m);
      return;
    }
    if (a.act === 'open_settings') {
      if (F.openSettings) F.openSettings(); else F.setTab('home');
      markDone(m);
      return;
    }
    if (a.act === 'start_setup') {
      markDone(m);
      send('Let’s set up my numbers');
      return;
    }
    if (a.act === 'add_plan') {
      F.addPlan({ name: pl.name, amount: pl.amount, date: pl.date }).then(function () {
        markDone(m);
        pushBot('Added to your plans: <b>' + esc(pl.name) + '</b> · ' + esc(fmtDate(pl.date)) + ' · ' + esc(money(pl.amount)) + '. It shows on Home and the Money tab.');
      });
      return;
    }
    if (a.act === 'remove_plan') {
      F.deletePlan(pl.id).then(function () {
        markDone(m);
        pushBot('Removed <b>' + esc(pl.name) + '</b> from your plans — ' + esc(money(pl.amount)) + ' is free again on Home.');
      });
      return;
    }
    if (a.act === 'log_expense') {
      F.addTxn({
        date: pl.date || todayISO(),
        account: pl.account || '',
        kind: pl.kind,
        category: pl.category || 'Other',
        amount: pl.amount,
        note: pl.note || ''
      }).then(function () {
        markDone(m);
        pushBot('Logged <b>' + esc(money(pl.amount)) + '</b> · ' + esc(pl.category || 'Other') + ' · ' + esc(pl.account || 'cash') +
          '. It’s in the Ledger on this phone.');
      });
      return;
    }
    if (a.act === 'story_drop_line') {
      var sl = m.storyLines;
      var si = Number(a.payload.i);
      if (!sl || !sl.length || !sl[si]) { markDone(m); return; }
      sl.splice(si, 1);
      m.storyLines = sl;
      saveMsg(m);
      openDraft = sl && sl.length // v55: keep the open-draft tracker in sync
        ? { say: '', lines: sl.map(function (l) { return l.label; }) }
        : null;
      var el = msgsEl ? msgsEl.querySelector('[data-cid="' + m.id + '"]') : null;
      if (!sl.length) {
        if (el) { var ar0 = el.querySelector('.a-row'); if (ar0) ar0.innerHTML = '<span class="c-done">✓ discarded</span>'; }
        pushBot('Nothing left in the draft — discarded, nothing was changed.');
      } else {
        var na = [];
        sl.forEach(function (l2, i2) { na.push({ label: '✕ ' + l2.label, act: 'story_drop_line', payload: { i: i2 } }); });
        na.push({ label: 'Confirm ' + sl.length + ' change' + (sl.length > 1 ? 's' : ''), act: 'confirm_story', payload: { lines: sl } });
        na.push({ label: 'Discard', act: 'discard_story' });
        m.actions = na;
        saveMsg(m);
        if (el) { var ar2 = el.querySelector('.a-row'); if (ar2) { ar2.innerHTML = actionsHtml(m); bindActions(el, m); } }
      }
      return;
    }
    if (a.act === 'confirm_story') {
      var cl2 = (a.payload && a.payload.lines) || m.storyLines || [];
      if (typeof F.applyBaseChanges !== 'function') {
        markDone(m);
        pushBot('This phone needs the latest app version to apply a story — pull to refresh.');
        return;
      }
      if (!cl2.length) { markDone(m); openDraft = null; return; }
      var nCh = cl2.length;
      F.applyBaseChanges(cl2.map(function (l3) { return l3.change; })).then(function () {
        m.storyLines = [];
        markDone(m);
        openDraft = null; // v55: the draft was confirmed — nothing open
        var um = {
          id: chatId(), who: 'bot',
          html: '<div class="c-block"><div class="c-t">Story applied</div>' +
            '<div class="ins-line">' + nCh + ' change' + (nCh > 1 ? 's' : '') + ' written to Your numbers — tiles, projection and the coach all recomputed on this phone.</div></div>',
          actions: [{ label: 'Undo this story', act: 'undo_story' }],
          at: new Date().toISOString()
        };
        saveMsg(um).then(function () { appendMsg(um); });
      }).catch(function (err) {
        pushBot('Could not apply that: ' + esc(String((err && err.message) || err)));
      });
      return;
    }
    if (a.act === 'discard_story') {
      m.storyLines = [];
      markDone(m);
      openDraft = null; // v55: the draft was discarded — nothing open
      pushBot('Discarded — nothing was changed.');
      return;
    }
    if (a.act === 'undo_story') {
      if (typeof F.undoBaseStory !== 'function') {
        pushBot('This phone needs the latest app version to undo — pull to refresh.');
        return;
      }
      F.undoBaseStory().then(function (nb) {
        markDone(m);
        pushBot(nb ? 'Undone — your numbers are back to exactly how they were before the story.' : 'Nothing to undo — those changes were already reverted.');
      }).catch(function (err) {
        pushBot('Undo failed: ' + esc(String((err && err.message) || err)));
      });
      return;
    }
  }
  // v49: stream the online coach's answer. The rules already rejected this
  // message first, so this is strictly open-ended chat: plain text, no
  // actions, nothing written. The bubble appears immediately and fills in as
  // text arrives; the final text is what gets persisted.
  function sendLlm(res, ctx, typing) {
    var FAI = window.FinAI;
    var sm = {
      id: chatId(), who: 'bot',
      html: '<div class="c-block"><div class="ins-line"><span class="spin"></span> coaching…</div></div>',
      actions: [], at: new Date().toISOString(), ai: true, streaming: true
    };
    return saveMsg(sm).then(function () {
      if (typing.parentNode) typing.parentNode.removeChild(typing);
      appendMsg(sm);
      return FAI.generate(res.prompt, { maxNew: 256 }, function (txt) {
        var el = msgsEl && msgsEl.querySelector('[data-cid="' + sm.id + '"] .ins-line');
        if (el) { el.textContent = txt || '…'; scrollBottom(); }
      }).then(function (txt) {
        sm.streaming = false;
        // v46: the remote coach may answer a change request with a validated JSON
        // draft — render it through the same story-mode card (confirm/undo).
        var draft = FAI.lastSource() === 'remote' ? parseCoachDraft(txt) : null;
        if (draft && draft.changes.length) {
          var lines = draft.changes.map(function (ch) { return { label: coachChangeLabel(ch), change: ch }; });
          var rowsHtml = lines.map(function (l, i) {
            var v = l.change.amount != null ? l.change.amount : l.change.value;
            return '<div class="ins-line"><b>' + (i + 1) + '.</b> ' + esc(l.label) + ' — ' + esc(money(v)) + '</div>';
          }).join('');
          sm.storyLines = lines;
          openDraft = { say: draft.say || '', lines: lines.map(function (l) { return l.label; }) }; // v55: open draft for correction
          sm.actions = lines.map(function (l, i) { return { label: '✕ ' + l.label, act: 'story_drop_line', payload: { i: i } }; });
          sm.actions.push({ label: 'Confirm ' + lines.length + ' change' + (lines.length > 1 ? 's' : ''), act: 'confirm_story', payload: { lines: lines } });
          sm.actions.push({ label: 'Discard', act: 'discard_story' });
          sm.html = (draft.say ? '<div class="c-block"><div class="ins-line">' + esc(draft.say) + '</div></div>' : '') +
            block('Draft: base-data changes',
              rowsHtml + line('<span class="note">nothing is written yet — tap ✕ to drop a line, or confirm to apply</span>'),
              null);
        } else {
          sm.html = aiAnswerHtml(draft && draft.say ? draft.say : (txt || ''), ctx, null, FAI.lastSource());
        }
        return saveMsg(sm).then(function () {
          var el2 = msgsEl && msgsEl.querySelector('[data-cid="' + sm.id + '"]');
          if (el2) { el2.innerHTML = sm.html + actionsHtml(sm); bindActions(el2, sm); }
          scrollBottom();
        });
      })['catch'](function (err) {
        sm.streaming = false;
        sm.html = aiAnswerHtml('', ctx, String((err && err.message) || err), FAI.lastSource());
        return saveMsg(sm).then(function () {
          var el3 = msgsEl && msgsEl.querySelector('[data-cid="' + sm.id + '"]');
          if (el3) el3.innerHTML = sm.html;
        });
      });
    });
  }
  function send(text) {
    var v = String(text || '').trim();
    if (!v || !msgsEl) return;
    var um = { id: chatId(), who: 'user', text: v, at: new Date().toISOString() };
    saveMsg(um).then(function () { appendMsg(um); });
    var typing = document.createElement('div');
    typing.className = 'msg bot typing';
    typing.innerHTML = '<span class="spin"></span> thinking…';
    msgsEl.appendChild(typing);
    scrollBottom();
    loadCtx().then(function (ctx) {
      var pre = Promise.resolve(null);
      // v46: rebuild the coach's short memory (the last few turns, excluding the
      // message just sent) so the LLM prompt can carry the conversation.
      pre = pre.then(function (vec) {
        return loadChat().then(function (rows) { recentHist = coachHist(rows, um.id); return vec; })['catch'](function () { return vec; });
      });
      return pre.then(function (vec) {
        var res = handle(v, ctx);
        if (res.llm) return sendLlm(res, ctx, typing);
        var bm = { id: chatId(), who: 'bot', html: res.html, actions: res.actions || [], at: new Date().toISOString() };
        if (res.storyLines) bm.storyLines = res.storyLines; // v35: the draft lives on the message (persisted in the chat store)
        if (res.storyRaw) bm.storyRaw = res.storyRaw;
        if (res.storyLines && res.storyLines.length) {
          openDraft = { say: '', lines: res.storyLines.map(function (l) { return l.label; }) }; // v55: open draft for correction
        }
        return saveMsg(bm).then(function () {
          if (typing.parentNode) typing.parentNode.removeChild(typing);
          appendMsg(bm);
          updateFresh(ctx);
        });
      });
    }).catch(function (err) {
      if (typing.parentNode) typing.parentNode.removeChild(typing);
      pushBot('Something went wrong: ' + esc(String((err && err.message) || err)));
    });
  }
  function updateFresh(ctx) {
    var el = byId('chatFresh');
    if (!el || !ctx) return;
    var when = ctx.at ? new Date(ctx.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'today';
    el.textContent = 'as of ' + when;
  }
  function welcomeHtml() {
    var n = coachName();
    return '<div class="c-block"><div class="c-t">' + (n ? 'Hey ' + esc(n) : 'Hey') + '</div>' +
      '<div class="ins-line">I’m your money coach — ask me anything about your plan, or tell me when something unexpected comes up. Everything is stored on this phone.</div>' +
      '<div class="ins-line">Try: <b>“how much is free?”</b> · <b>“plan: shoes 1,500 on the 20th”</b> · <b>“urgent: car repair 8,000 this week”</b> · <b>“my salary in october is 25k, water went up to 1,800”</b></div></div>';
  }
  function openChat() {
    if (window.FinAI && window.FinAI.refreshLed) window.FinAI.refreshLed();
    loadChat().then(function (rows) {
      if (!rows.length) {
        var m = { id: chatId(), who: 'bot', html: welcomeHtml(), at: new Date().toISOString() };
        saveMsg(m).then(function () { rows.push(m); renderMsgs(rows); });
      } else {
        renderMsgs(rows);
      }
      // v55: restore the open draft after a reload so a follow-up reply still
      // corrects it instead of stacking a new draft
      openDraft = null;
      for (var ri = rows.length - 1; ri >= 0; ri--) {
        var rm = rows[ri];
        if (!rm || rm.who !== 'bot') continue;
        if (rm.storyLines && rm.storyLines.length && !rm.done) {
          openDraft = { say: '', lines: rm.storyLines.map(function (l) { return l.label; }) };
        }
        break;
      }
    });
    loadCtx().then(function (c) { updateFresh(c); }).catch(function () {});
    // no auto-focus: the keyboard should only appear when the user taps the input.
    // If a stale focus survived a tab switch, drop it defensively.
    setTimeout(function () {
      try { if (inputEl && document.activeElement === inputEl) inputEl.blur(); } catch (e) {}
    }, 60);
  }
  function closeChat() {
    if (F.closeCoach) {
      F.closeCoach();
    } else if (F.setTab) {
      F.setTab('home');
    }
  }
  function renderChips() {
    var el = byId('chatChips');
    if (!el) return;
    el.innerHTML = '';
    CHIPS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = c;
      b.onclick = function () { send(c); };
      el.appendChild(b);
    });
  }
  function init() {
    inputEl = byId('chatInput');
    msgsEl = byId('chatMsgs');
    if (!inputEl || !msgsEl) return;
    renderChips();
    var c = byId('chatClose');
    if (c) c.onclick = closeChat;
    var s = byId('chatSend');
    if (s) s.onclick = function () { send(inputEl.value); inputEl.value = ''; };
    if (inputEl) inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(inputEl.value); inputEl.value = ''; }
    });
  }

  // test/dev hook (used by the local check scripts)
  window.__financeChat = {
    handle: handle,
    findDateSpan: findDateSpan,
    findAmount: findAmount,
    findAmounts: findAmounts,
    norm: norm,
    URGENT_RX: URGENT_RX,
    extractStory: extractStory,
    storyMonth: storyMonth,
    fuzzyNameIn: fuzzyNameIn,
    open: openChat,
    close: closeChat,
    // v47: kick off the guided "set up my numbers" conversation (used by the
    // empty-state buttons in the app shell)
    startSetup: function () { send('Let’s set up my numbers'); },
    // v55: the shared month snapshot + ctx loader — the Home "Coach's note"
    // card (app.js) uses these instead of a second numbers computation
    coachSnapshot: coachSnapshot,
    ctx: loadCtx
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();