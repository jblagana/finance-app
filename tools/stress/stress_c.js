// Fin.AI stress — groups: U (UI), M (monkey), Y (a simulated year)
const C = require('./stress_core');
const { fresh, inv, rec, heroCheck, closeAll } = C;
const path = require('path');
const NOW = '2026-11-12T10:00:00+08:00';
const r2 = (x) => Math.round(x * 100) / 100;
async function done(pg, ctx) { try { await ctx.close(); } catch (e) {} }
const SHOTS = path.join(C.OUT, 'shots'); require('fs').mkdirSync(SHOTS, { recursive: true });

// the screens a person reaches: tabs + every sheet/page
const SCREENS = [
  ['home', async (pg) => pg.evaluate(() => document.querySelector('[data-tab="home"]').click())],
  ['committed', async (pg) => pg.evaluate(() => document.querySelector('[data-tab="money"]').click())],
  ['ledger', async (pg) => pg.evaluate(() => document.querySelector('[data-tab="ledger"]').click())],
  ['owed', async (pg) => pg.evaluate(() => document.querySelector('[data-tab="owed"]').click())],
  ['add', async (pg) => pg.evaluate(() => document.getElementById('addBtn').click())],
  ['settings', async (pg) => pg.evaluate(() => document.getElementById('setBtn').click())],
  ['allnumbers', async (pg) => { await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(200); await pg.evaluate(() => document.getElementById('setNumAll').click()); }],
  ['account', async (pg) => { await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(200); await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(200); await pg.evaluate(() => document.querySelector('#numOverview .nv-acc').click()); }],
  ['plan-add', async (pg) => { await pg.evaluate(() => document.querySelector('[data-tab="money"]').click()); await pg.waitForTimeout(200); await pg.evaluate(() => { const b = document.querySelector('[id*="planAdd"]'); if (b) b.click(); }); }],
  ['coach', async (pg) => pg.evaluate(() => { const b = document.getElementById('coachFab') || document.querySelector('[aria-label*="oach"]'); if (b) b.click(); })]
];
// layout problems on the visible screen
const LAYOUT = () => {
  const out = { overflow: [], tiny: [], noname: [], clipped: [] };
  const vw = window.innerWidth;
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < window.innerHeight; };
  document.querySelectorAll('body *').forEach((el) => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    const clipped = (() => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'clip') return true; } return false; })();
    if (r.right > vw + 1 && getComputedStyle(el).position !== 'fixed' && !clipped) out.overflow.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) + ' ' + Math.round(r.right) + 'px');
    if (el.matches('button, a, input, select, [role=button]')) {
      if ((r.height < 32 || r.width < 32) && !el.matches('input[type=checkbox], input[type=radio]')) out.tiny.push((el.getAttribute('aria-label') || el.textContent || el.id || el.className).toString().trim().slice(0, 24) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('placeholder') || '').trim();
      if (!name && el.type !== 'hidden') out.noname.push(el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
    }
    const cs = getComputedStyle(el);
    if (el.children.length === 0 && el.textContent.trim() && el.scrollWidth > el.clientWidth + 2 && cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis' && cs.whiteSpace === 'nowrap') out.clipped.push(el.textContent.trim().slice(0, 30));
  });
  const uniq = (a) => Array.from(new Set(a)).slice(0, 6);
  return { overflow: uniq(out.overflow), tiny: uniq(out.tiny), noname: uniq(out.noname), clipped: uniq(out.clipped), sideways: document.documentElement.scrollWidth > vw + 1 };
};

module.exports = async function groupC() {
  // ================= U: every screen at 3 phone sizes × 2 themes =================
  if (!process.env.ONLY || process.env.ONLY.includes('U')) {
  const agg = { overflow: {}, tiny: {}, noname: {}, clipped: {}, sideways: {} };
  for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
    for (const theme of ['dark', 'light']) {
      const { ctx, pg } = await fresh({ time: NOW, vp, theme });
      // make one account name very long — real people do this
      await pg.evaluate(async () => { const F = window.FinApp; const b = JSON.parse(JSON.stringify(F.state.base)); b.accounts[0].name = 'BDO Unibank Savings Account (payroll) 2026'; });
      for (const [nm, go] of SCREENS) {
        await closeAll(pg);
        try { await go(pg); } catch (e) {}
        await pg.waitForTimeout(450);
        const L = await pg.evaluate(LAYOUT);
        const key = vp.width + ' ' + theme + ' ' + nm;
        for (const k of ['overflow', 'tiny', 'noname', 'clipped']) if (L[k].length) agg[k][key] = L[k];
        if (L.sideways) agg.sideways[key] = true;
        if (theme === 'dark' || vp.width === 320) await pg.screenshot({ path: path.join(SHOTS, vp.width + '_' + theme + '_' + nm + '.png') });
      }
      const v = await inv(pg);
      if (v.length) rec({ area: 'U', id: 'U0-' + vp.width + theme, title: 'Visit every screen at ' + vp.width + 'px ' + theme, expected: 'no errors', observed: v.join(' ; '), pass: false, sev: 'high' });
      await done(pg, ctx);
    }
  }
  const sum = (o) => Object.keys(o).map((k) => k + ': ' + [].concat(o[k]).join(', ')).slice(0, 12).join(' || ');
  rec({ area: 'U', id: 'U1', title: 'Nothing sticks out past the screen edge (3 sizes × 2 themes × 10 screens)', sev: 'med', expected: 'none', observed: sum(agg.overflow) || 'none', pass: !Object.keys(agg.overflow).length });
  rec({ area: 'U', id: 'U2', title: 'The page never scrolls sideways', sev: 'med', expected: 'never', observed: Object.keys(agg.sideways).join(', ') || 'never', pass: !Object.keys(agg.sideways).length });
  rec({ area: 'U', id: 'U3', title: 'Tap targets at least 32px (Apple/Google ask for 44)', sev: 'low', expected: 'none smaller', observed: sum(agg.tiny) || 'none', pass: !Object.keys(agg.tiny).length });
  rec({ area: 'U', id: 'U4', title: 'Every button has a name (screen readers)', sev: 'low', expected: 'all named', observed: sum(agg.noname) || 'all named', pass: !Object.keys(agg.noname).length });
  rec({ area: 'U', id: 'U5', title: 'No one-line text cut off without "…"', sev: 'low', expected: 'none', observed: sum(agg.clipped) || 'none', pass: !Object.keys(agg.clipped).length });

  {
    // rapid open/close of every sheet + Esc + scrim, 60 times, in random order
    const { ctx, pg } = await fresh({ time: NOW });
    let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 60; i++) {
      const [nm, go] = SCREENS[Math.floor(rnd() * SCREENS.length)];
      try { await go(pg); } catch (e) {}
      await pg.waitForTimeout(Math.floor(rnd() * 120));
      const how = rnd();
      if (how < 0.33) await pg.keyboard.press('Escape');
      else if (how < 0.66) await pg.evaluate(() => { const s = document.getElementById('scrim'); if (s) s.click(); });
      else await pg.evaluate(() => { const x = document.querySelector('.sheet.show .sheet-x'); if (x) x.click(); });
    }
    await closeAll(pg); await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape'); await pg.waitForTimeout(500);
    const st = await pg.evaluate(() => ({ open: Array.from(document.querySelectorAll('.sheet.show')).map((s) => s.id), scrim: document.getElementById('scrim').classList.contains('show'), canTap: (() => { const r = document.getElementById('addBtn').getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(el && el.closest('#addBtn')); })() }));
    const v = await inv(pg);
    rec({ area: 'U', id: 'U6', title: 'Open/close sheets 60 times fast (✕, Esc, tap outside)', sev: 'high', expected: 'ends cleanly: nothing stuck open, the + button tappable, no errors',
      observed: 'still open: ' + (st.open.join(',') || 'none') + '; dim layer stuck: ' + st.scrim + '; + tappable: ' + st.canTap + (v.length ? '; ' + v.join(' ; ') : ''), pass: !st.open.length && !st.scrim && st.canTap && !v.length });
    await done(pg, ctx);
  }
  {
    // the keyboard is up (a focused field) and the sheet scrolls — the frozen Add top stays
    const { ctx, pg } = await fresh({ time: NOW, vp: { width: 390, height: 500 } }); // ~ a phone with the keyboard open
    await pg.evaluate(() => document.getElementById('addBtn').click()); await pg.waitForTimeout(400);
    await pg.focus('#f_amount'); await pg.keyboard.type('250');
    await pg.evaluate(() => { const sb = document.querySelector('#addSheet .sheet-b'); sb.scrollTop = sb.scrollHeight; }); await pg.waitForTimeout(200);
    const r = await pg.evaluate(() => { const a = document.getElementById('f_amount').getBoundingClientRect(); const s = document.getElementById('addSubmit').getBoundingClientRect(); return { amtVisible: a.top >= 0 && a.bottom <= window.innerHeight, submitReach: s.top < window.innerHeight }; });
    rec({ area: 'U', id: 'U7', title: 'Add sheet with the keyboard up (500px tall): scroll to the bottom', sev: 'med', expected: 'the amount stays visible (frozen top) and Add expense is reachable', observed: 'amount visible: ' + r.amtVisible + '; Add reachable: ' + r.submitReach, pass: r.amtVisible && r.submitReach });
    await pg.screenshot({ path: path.join(SHOTS, 'keyboard_add.png') });
    await done(pg, ctx);
  }

  {
    // v74.59: scroll bleed — swiping a sheet must never scroll the page behind
    const { ctx, pg } = await fresh({ vp: { width: 390, height: 844 }, touch: true, mobile: true });
    const cdp = await ctx.newCDPSession(pg);
    const swipe = async (x, y, dy, dx) => { dx = dx || 0; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 12, y: y + dy * i / 12 }] }); await pg.waitForTimeout(16); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pg.waitForTimeout(350); };
    const pageAt = () => pg.evaluate(() => document.body.style.position === 'fixed' ? -parseInt(document.body.style.top || '0', 10) : Math.round(window.scrollY));
    await swipe(195, 600, -400); const y0 = await pageAt();
    await pg.evaluate(() => document.getElementById('addBtn').click()); await pg.waitForTimeout(450);
    await swipe(195, 180, -300); await swipe(195, 700, -300); await swipe(195, 700, 300);
    const y1 = await pageAt(); await closeAll(pg); await pg.waitForTimeout(300); const y2 = await pageAt();
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(450);
    await swipe(195, 600, -500); const own = await pg.evaluate(() => document.querySelector('#setSheet .sheet-b').scrollTop);
    await swipe(195, 600, -2500); const y3 = await pageAt(); await closeAll(pg);
    rec({ area: 'U', id: 'U8', title: 'Swiping on an open sheet never scrolls the page behind', sev: 'med',
      expected: 'the page stays at ' + y0 + ' while the Add sheet / Settings are swiped, Settings scrolls itself, the page is back at ' + y0 + ' after closing',
      observed: 'page ' + y0 + ' → ' + y1 + ' (Add swiped) → ' + y2 + ' (closed) → ' + y3 + ' (Settings swiped past its end); Settings scrolled itself to ' + own,
      pass: y0 > 0 && y1 === y0 && y2 === y0 && y3 === y0 && own > 0 });
    await done(pg, ctx);
  }
  }
  // ================= M: the monkey (random real taps + typing) =================
  if (!process.env.ONLY || process.env.ONLY.includes('M')) {
  for (const seedN of [11, 23, 37]) {
    const { ctx, pg } = await fresh({ time: NOW });
    let seed = seedN; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const words = ['250', '0', '-5', '1e9', '300-125+10', 'abc', '', '99999999', '<b>x</b>', 'Jollibee', '15', '31', '0.5', '12.345'];
    const log = []; const breaks = [];
    const st0 = await pg.evaluate(() => ({ t: window.FinApp.state.txns.length, p: window.FinApp.state.plans.length }));
    for (let i = 0; i < 1000; i++) {
      const act = await pg.evaluate((r) => {
        const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && getComputedStyle(el).visibility !== 'hidden'; };
        const els = Array.from(document.querySelectorAll('button, [role=button], input:not([type=file]), select, .nv-row, .achip')).filter((e) => vis(e) && !e.disabled && !e.closest('#setRestart') && e.id !== 'setRestart' && e.id !== 'impBtn');
        if (!els.length) return null;
        const el = els[Math.floor(r * els.length)];
        el.setAttribute('data-monkey', '1');
        return { tag: el.tagName, type: el.type || '', label: ((el.getAttribute('aria-label') || el.textContent || el.id || el.name || '') + '').trim().slice(0, 30), id: el.id };
      }, rnd());
      if (!act) { await pg.keyboard.press('Escape'); continue; }
      try {
        if (act.tag === 'INPUT' && !/checkbox|radio|date|month/.test(act.type)) await pg.fill('[data-monkey="1"]', words[Math.floor(rnd() * words.length)], { timeout: 800 });
        else if (act.tag === 'SELECT') await pg.evaluate(() => { const s = document.querySelector('[data-monkey="1"]'); if (s.options.length) { s.selectedIndex = Math.floor(Math.random() * s.options.length); s.dispatchEvent(new Event('change', { bubbles: true })); } });
        else await pg.click('[data-monkey="1"]', { timeout: 800, force: true });
      } catch (e) {}
      await pg.evaluate(() => { const e = document.querySelector('[data-monkey="1"]'); if (e) e.removeAttribute('data-monkey'); }).catch(() => {});
      log.push(act.tag + ' "' + act.label + '"');
      if (rnd() < 0.08) await pg.keyboard.press('Escape');
      if (i % 40 === 39) {
        const v = await inv(pg);
        if (v.length) { breaks.push('after step ' + (i + 1) + ' (last: ' + log.slice(-3).join(' → ') + '): ' + v.join(' ; ')); pg.errs = []; }
      }
    }
    rec({ area: 'M', id: 'M' + seedN, title: 'Monkey test: 1,000 random taps/typing (run ' + seedN + ')', sev: 'high', expected: 'no errors, numbers stay consistent the whole way',
      observed: (breaks.length ? breaks.slice(0, 4).join(' || ') : 'clean') + ' [' + (await pg.evaluate((s) => 'entries ' + s.t + ' → ' + window.FinApp.state.txns.length + ', plans ' + s.p + ' → ' + window.FinApp.state.plans.length + ', distinct things tapped ' , st0)) + new Set(log).size + ']', pass: !breaks.length });
    await done(pg, ctx);
  }

  }
  // ================= Y: a simulated year of use =================
  if (!process.env.ONLY || process.env.ONLY.includes('Y')) {
  {
    const { ctx, pg } = await fresh({ time: NOW });
    let seed = 99; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const start = await pg.evaluate(() => { const e = window.FinApp.effectiveSnap(); return { liquid: e.cash.total, owed: e.card_owed, cards: Object.fromEntries(e.cards.map((c) => [c.name, c.balance])) }; });
    const exp = { liquid: start.liquid, owed: start.owed };
    const issues = []; let slowest = 0, reloads = 0;
    const day0 = new Date(NOW).getTime();
    for (let day = 1; day <= 365; day++) {
      const now = new Date(day0 + day * 86400000);
      await pg.clock.setSystemTime(now);
      const today = await pg.evaluate(() => window.FinApp.todayISO());
      const dom = Number(today.slice(8, 10));
      const txs = [];
      const nSp = Math.floor(rnd() * 4);
      for (let k = 0; k < nSp; k++) {
        const card = rnd() < 0.35, amt = r2(40 + rnd() * 900);
        txs.push(card ? { kind: 'card_charge', account: rnd() < 0.5 ? 'Maya CC' : 'MariBank CC', amount: amt, category: 'Food', note: 'sim', date: today }
                      : { kind: 'cash_out', account: ['LandBank', 'MariBank', 'Cash'][Math.floor(rnd() * 3)], amount: amt, category: 'Transpo', note: 'sim', date: today });
      }
      if (dom === 15) txs.push({ kind: 'cash_in', account: 'LandBank', amount: 46615, category: '', note: 'Salary (sim)', date: today });
      if (dom === 5) {
        const owedNow = await pg.evaluate(() => Object.fromEntries(window.FinApp.effectiveSnap().cards.map((c) => [c.name, c.balance])));
        for (const k of Object.keys(owedNow)) if (owedNow[k] > 0) txs.push({ kind: 'card_payment', account: k, amount: r2(owedNow[k]), category: '', note: 'pay off (sim)', date: today, payWith: 'LandBank' });
      }
      if (rnd() < 0.03) txs.push({ kind: 'cash_in', account: 'MariBank', amount: r2(100 + rnd() * 2000), category: '', note: 'refund (sim)', date: today });
      for (const t of txs) {
        const t0 = Date.now();
        await pg.evaluate((t) => window.FinApp.addTxn(t, { quiet: true }), t);
        slowest = Math.max(slowest, Date.now() - t0);
        if (t.kind === 'cash_out') exp.liquid -= t.amount; else if (t.kind === 'cash_in') exp.liquid += t.amount;
        else if (t.kind === 'card_charge') exp.owed += t.amount; else if (t.kind === 'card_payment') { exp.owed -= t.amount; exp.liquid -= t.amount; }
      }
      // sometimes delete + undo the newest entry (the Undo path under load)
      if (rnd() < 0.05) {
        const id = await pg.evaluate(() => { const T = window.FinApp.state.txns; return T.length ? T[T.length - 1].id : null; });
        if (id) { await pg.evaluate((id) => window.FinApp.deleteTxn(id), id); await pg.waitForTimeout(80); await pg.evaluate(() => { const b = document.querySelector('#snack button'); if (b) b.click(); }); await pg.waitForTimeout(150); }
      }
      const got = await pg.evaluate(() => { const e = window.FinApp.effectiveSnap(); return { liquid: e.cash.total, owed: e.card_owed }; });
      if (Math.abs(got.liquid - r2(exp.liquid)) > 0.05 || Math.abs(got.owed - r2(exp.owed)) > 0.05)
        { issues.push(today + ': app liquid ' + got.liquid + ' vs ledger math ' + r2(exp.liquid) + '; owed ' + got.owed + ' vs ' + r2(exp.owed)); exp.liquid = got.liquid; exp.owed = got.owed; }
      if (day % 7 === 0) {
        await pg.evaluate(() => window.FinApp.render());
        const v = await inv(pg); if (v.length) { issues.push(today + ': ' + v.join(' ; ')); pg.errs = []; }
        const h = await heroCheck(pg); if (h && Math.abs(h.shown - h.want) > 0.02) issues.push(today + ': hero shows ' + h.shown + ' but the math says ' + h.want);
      }
      if (day % 60 === 0) {
        const a = await pg.evaluate(() => window.FinApp.effectiveSnap().cash.free);
        await pg.reload(); await pg.waitForFunction(() => window.FinApp && window.FinApp.state && window.FinApp.state.snapshot, null, { timeout: 30000 }); await pg.waitForTimeout(2500);
        const b = await pg.evaluate(() => window.FinApp.effectiveSnap().cash.free); reloads++;
        if (Math.abs(a - b) > 0.02) issues.push(today + ': reopening the app changed free ' + a + ' → ' + b);
      }
      if (issues.length > 12) break;
    }
    const n = await pg.evaluate(() => window.FinApp.state.txns.length);
    rec({ area: 'Y', id: 'Y1', title: 'A simulated year (≈' + n + ' entries, salaries, card payoffs, deletes+undos, ' + reloads + ' reopenings)', sev: 'critical',
      expected: 'every day the app\'s liquid and owed equal a plain sum of the ledger; no errors; reopening never changes a number',
      observed: issues.length ? issues.slice(0, 6).join(' || ') + (issues.length > 6 ? ' || +' + (issues.length - 6) + ' more' : '') : 'clean all year', pass: !issues.length });
    rec({ area: 'Y', id: 'Y2', title: 'Speed after a year of entries', sev: 'med', expected: 'logging an entry stays under 500 ms', observed: 'slowest add: ' + slowest + ' ms', pass: slowest < 500 });
    await done(pg, ctx);
  }
  }
};
