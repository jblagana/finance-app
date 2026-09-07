/* Finance PWA coach chat — the Coach tab.
 *
 * Rule-based and offline-first: it answers from the same data the app's tiles
 * use — the last sheet snapshot cached in IndexedDB plus this phone's plans and
 * entries — so it works with no signal. When online it refreshes the snapshot
 * first (the same sync path as the rest of the app).
 *
 * It never writes on its own: every change (plan, expense) is confirmed with a
 * button and goes through the app's own actions (window.FinApp), so chat-made
 * plans/entries behave exactly like the forms (same stores, same sync, same
 * deficit math).
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || !window.FinApp) return;

  var F = window.FinApp;

  // ---------- small helpers (self-contained; mirror app.js conventions) ----------
  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
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

  // ---------- data: read our own copies from IndexedDB (race-free) ----------
  function snapSig(s) {
    if (!s) return '';
    return [s.cash && s.cash.total, s.cash && s.cash.free, s.card_owed, s.total_prepay].join('|');
  }
  function loadCtx() {
    return Promise.all([F.idbAll(F.STORE_META), F.idbAll(F.STORE_PLANS), F.idbAll(F.STORE_TX)]).then(function (res) {
      var snap = null, adj = { cash: 0, free: 0, card: 0, prepay: 0 }, adjSig = '', at = null;
      (res[0] || []).forEach(function (m) {
        if (m.key === 'snapshot') { snap = m.value; at = m.at; }
        else if (m.key === 'adj') adj = m.value || adj;
        else if (m.key === 'adjSig') adjSig = m.value || '';
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
      return { snap: snap, eff: eff, plans: res[1] || [], txns: res[2] || [], at: at, online: !!F.online() };
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
  function freshness(ctx) {
    if (!ctx) return '';
    var when = ctx.at ? new Date(ctx.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'not synced yet';
    return '<div class="note">numbers as of ' + esc(when) + (ctx.online ? '' : ' · offline') + '</div>';
  }

  // ---------- intents ----------
  function intentHelp(t) {
    if (!/^(help|\?+|what can you do|what do you do|how do you work|commands|abilities)\b/.test(t)) return null;
    var h = block('What I can do',
      line('• <b>Status</b> — free cash, liquid cash, cards owed, the 14th prepay') +
      line('• <b>Details</b> — debt schedules, one-offs, sinking funds, “what’s my cash in Feb?”') +
      line('• <b>Plans</b> — add / list / remove plans, exactly like the form on the Money tab') +
      line('• <b>Charge check</b> — “can I charge 2,500 on Maya?”') +
      line('• <b>Urgent expense</b> — tell me something unplanned and I’ll map the options') +
      line('• <b>Spending</b> — what you’ve logged in this app this week / month'),
      'Try: “urgent: car repair 8,000 this week”', 'good');
    return { html: h };
  }

  function intentGreet(t, ctx) {
    if (!/^(hi|hiya|hey|hello|yo|um)([!.? ,]*)$/.test(t) && !/^good (morning|afternoon|evening)\b/.test(t)) return null;
    var n = coachName();
    var h = block(n ? 'Hey ' + esc(n) : 'Hey',
      line('I’m your money coach. Ask for <b>status</b>, <b>plans</b>, <b>debt</b> details, a <b>charge check</b>, or tell me about an <b>urgent expense</b> — it works offline.') +
      line('Type <b>help</b> for the full list.'),
      'I answer from your last synced numbers.', 'good');
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
          : 'Mandatory-only needs no borrowing. Any full-living borrow is repaid with the Oct double salary.',
        b.mandatory_only.need_borrow ? 'warn' : 'good');
      return { html: h + freshness(ctx) };
    }
    if (!m) {
      return { html: block('Projection', line('I don’t have the 6-month projection cached yet — sync once while online and I can project.'), null, null) + freshness(ctx) };
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
    var rowB = null, rowW = null;
    if (target) {
      (m.base || []).forEach(function (r) { if (r.comp.month === target) rowB = r; });
      (m.worst || []).forEach(function (r) { if (r.comp.month === target) rowW = r; });
    }
    if (target && (rowB || rowW)) {
      var comp = rowB ? rowB.comp : rowW.comp;
      var below = rowB && rowB.running < (ctx.eff.floor || 0);
      var h2 = block(monthLabel(target),
        kv('Salary', money(comp.salary)) +
        kv('Committed outflows', money(comp.outflows) + ' <span class="note" style="font-size:11px">worst-case ' + money(rowW ? rowW.comp.outflows : 0) + '</span>') +
        kv('Cash at month end (base)', money(rowB ? rowB.running : 0)) +
        kv('Cash at month end (worst)', money(rowW ? rowW.running : 0)),
        below
          ? 'Base case dips below your ' + money(ctx.eff.floor || 0) + ' floor in ' + monthLabel(target) + ' — that’s the month to protect.'
          : 'Stays above the ' + money(ctx.eff.floor || 0) + ' floor in ' + monthLabel(target) + '.',
        below ? 'warn' : 'good');
      return { html: h2 + freshness(ctx) };
    }
    if (worst || general) {
      var lines = kv('Starting liquid cash', money(m.start_cash));
      (m.base || []).forEach(function (r, i) {
        var w = (m.worst || [])[i];
        lines += kv(monthLabel(r.comp.month), money(r.running) + ' <span class="note" style="font-size:11px">worst ' + money(w ? w.running : '—') + '</span>');
      });
      var h3 = block('Sept 2026 → Feb 2027 · running cash', lines,
        'Worst case also eats the ' + money(ctx.snap.emergency_cap || 0) + ' emergency every month.', 'good');
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
      'This counts entries added in the app; the full ledger lives in your Sheet.', 'good');
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
    var monthP = ctx.eff.month || todayISO().slice(0, 7);
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
        '; (3) bridge ' + money(borrow) + ' from your partner, repaid with the Oct double salary.');
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
    if (!/^(log|record|add|note)\b/.test(t) || !/\b(expense|spend|spent|charge|paid|payment|bought)\b/.test(t)) return null;
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
      'Tap to log it — it lands in the Ledger and syncs to the Sheet.', 'good');
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
        line('For anything else, the <b>Money</b> tab has the full sheet view.'),
        'Type “help” to see examples.', 'warn')
    };
  }

  // ---------- dispatch ----------
  function handle(raw, ctx) {
    var t = norm(raw);
    if (!t) return intentFallback('');
    if (!ctx.eff) {
      return {
        html: block('No numbers yet',
          line('I need one sync to your sheet before I can answer money questions. Until then you can still add and view plans.'),
          'Open Settings (the ⚙ in the top right) → paste your Web App URL → Connect & sync.', 'warn'),
        actions: [{ label: 'Open Settings', act: 'open_settings' }]
      };
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
    var order = [intentHelp, intentGreet, intentPlanRemove, intentPlanAdd, intentPlanList,
      intentUrgent, intentLog, intentDeficit, intentSpend,
      intentDebt, intentOneOff, intentSinking, intentFuture, intentStatus];
    for (var i = 0; i < order.length; i++) {
      var r = order[i](t, ctx, p);
      if (r) return r;
    }
    return intentFallback(t);
  }

  // ---------- chat store + message UI ----------
  var fabEl = null, panelEl = null, inputEl = null, msgsEl = null;
  var CHIPS = ['How much is free?', 'My 14th prepay', 'Show my plans', 'What’s coming up?', 'Check a charge', 'Urgent expense'];

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
          '. It’s in the Ledger' + (F.online() ? ' and syncing to the Sheet.' : ' — it syncs when you’re back online.'));
      });
      return;
    }
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
    var p0 = F.online() ? Promise.resolve(F.sync()).catch(function () {}) : Promise.resolve();
    p0.then(loadCtx).then(function (ctx) {
      var res = handle(v, ctx);
      var bm = { id: chatId(), who: 'bot', html: res.html, actions: res.actions || [], at: new Date().toISOString() };
      return saveMsg(bm).then(function () {
        if (typing.parentNode) typing.parentNode.removeChild(typing);
        appendMsg(bm);
        updateFresh(ctx);
      });
    }).catch(function (err) {
      if (typing.parentNode) typing.parentNode.removeChild(typing);
      pushBot('Something went wrong: ' + esc(String((err && err.message) || err)));
    });
  }
  function updateFresh(ctx) {
    var el = byId('chatFresh');
    if (!el || !ctx) return;
    var when = ctx.at ? new Date(ctx.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'not synced yet';
    el.textContent = 'as of ' + when + (ctx.online ? '' : ' · offline');
  }
  function welcomeHtml() {
    var n = coachName();
    return '<div class="c-block"><div class="c-t">' + (n ? 'Hey ' + esc(n) : 'Hey') + '</div>' +
      '<div class="ins-line">I’m your money coach — ask me anything about your plan, or tell me when something unexpected comes up. Works offline; numbers refresh when you’re online.</div>' +
      '<div class="ins-line">Try: <b>“how much is free?”</b> · <b>“plan: shoes 1,500 on the 20th”</b> · <b>“urgent: car repair 8,000 this week”</b></div></div>';
  }
  function openChat() {
    if (panelEl) panelEl.style.display = 'flex';
    if (fabEl) fabEl.style.display = 'none';
    loadChat().then(function (rows) {
      if (!rows.length) {
        var m = { id: chatId(), who: 'bot', html: welcomeHtml(), at: new Date().toISOString() };
        saveMsg(m).then(function () { rows.push(m); renderMsgs(rows); });
      } else {
        renderMsgs(rows);
      }
    });
    if (F.online()) F.sync().catch(function () {});
    updateFresh({ at: null, online: F.online() });
    inputEl.focus();
  }
  function closeChat() {
    if (panelEl) {
      panelEl.style.display = 'none';
      if (fabEl) fabEl.style.display = '';
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
    fabEl = byId('chatFab');
    panelEl = byId('chatPanel');
    inputEl = byId('chatInput');
    msgsEl = byId('chatMsgs');
    if (!inputEl || !msgsEl) return;
    renderChips();
    if (fabEl) fabEl.onclick = openChat;
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
    norm: norm,
    URGENT_RX: URGENT_RX,
    open: openChat,
    close: closeChat
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();