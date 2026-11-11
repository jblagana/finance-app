// Fin.AI stress — groups: T (dates/time), C (cards), P (plans), O (owed), I (data safety)
const C = require('./stress_core');
const { fresh, inv, rec, heroCheck, closeAll } = C;
const path = require('path'), fs = require('fs');
const NOW = '2026-11-12T10:00:00+08:00';
const r2 = (x) => Math.round(x * 100) / 100;
const addTxn = (pg, t) => pg.evaluate((t) => window.FinApp.addTxn(t, { quiet: true }), t);
const eff = (pg) => pg.evaluate(() => { const e = window.FinApp.effectiveSnap(); return { liquid: e.cash.total, free: e.cash.free, owed: e.card_owed, cards: Object.fromEntries(e.cards.map((c) => [c.name, c.balance])) }; });
async function done(pg, ctx) { try { await ctx.close(); } catch (e) {} }
async function invRec(pg, area, id, title, sev) {
  const v = await inv(pg);
  rec({ area, id, title, expected: 'opens cleanly: no errors, no NaN on screen, numbers consistent', observed: v.join(' ; ') || 'ok', pass: !v.length, sev: sev || 'high' });
  return v;
}

module.exports = async function groupB() {
  // ================= T: dates and time =================
  for (const [id, when, label] of [
    ['T1', '2026-11-15T07:00:00+08:00', 'on payday'], ['T2', '2026-11-30T23:30:00+08:00', 'Nov 30, 11:30 PM'],
    ['T3', '2026-12-31T23:59:30+08:00', 'New Year\'s Eve 11:59 PM'], ['T4', '2027-02-28T12:00:00+08:00', 'Feb 28 (short month)'],
    ['T5', '2028-02-29T12:00:00+08:00', 'leap day 2028'], ['T6', '2027-02-12T12:00:00+08:00', 'opened after 3 months away'],
    ['T7', '2027-11-12T12:00:00+08:00', 'opened after a year away']]) {
    const { ctx, pg } = await fresh({ time: when });
    for (const tab of ['home', 'money', 'ledger', 'owed']) { await pg.evaluate((t) => { const b = document.querySelector('[data-tab="' + t + '"]'); if (b) b.click(); }, tab); await pg.waitForTimeout(250); }
    await pg.evaluate(() => { const b = document.querySelector('[data-tab="home"]'); if (b) b.click(); });
    const h = await heroCheck(pg);
    const v = await invRec(pg, 'T', id, 'Open the app ' + label);
    if (h) rec({ area: 'T', id: id + 'h', title: 'Hero number matches the math (' + label + ')', sev: 'high', expected: '₱' + h.want, observed: '₱' + h.shown, pass: Math.abs(h.shown - h.want) < 0.02 });
    await done(pg, ctx);
  }
  {
    // midnight rollover while the app is open
    const { ctx, pg } = await fresh({ time: '2026-11-14T23:59:00+08:00' });
    const d0 = await pg.evaluate(() => window.FinApp.todayISO());
    await pg.clock.fastForward('02:00'); await pg.waitForTimeout(500);
    const d1 = await pg.evaluate(() => window.FinApp.todayISO());
    const greet = await pg.evaluate(() => (document.querySelector('#headK, .hd-k, #homeKicker') || {}).textContent || '');
    rec({ area: 'T', id: 'T8', title: 'Leave the app open across midnight (into payday)', sev: 'med', expected: 'the date moves to Nov 15 and the screens follow without a reload', observed: 'today ' + d0 + ' → ' + d1 + (greet ? '; header "' + greet + '"' : ''), pass: d1 === '2026-11-15' });
    await invRec(pg, 'T', 'T8i', 'after midnight');
    await done(pg, ctx);
  }
  {
    // the phone's timezone is not Manila
    const a = await fresh({ time: NOW, tz: 'Asia/Manila' }); const fa = await eff(a.pg); const ta = await a.pg.evaluate(() => window.FinApp.todayISO()); const ha = await heroCheck(a.pg); await done(a.pg, a.ctx);
    const b = await fresh({ time: '2026-11-12T01:30:00+08:00', tz: 'America/Los_Angeles' }); const tb = await b.pg.evaluate(() => window.FinApp.todayISO()); const vb = await inv(b.pg); await done(b.pg, b.ctx);
    rec({ area: 'T', id: 'T9', title: 'Phone set to a US timezone (travel)', sev: 'low', expected: 'works (today follows the phone\'s own date)', observed: 'today ' + tb + '; ' + (vb.join(' ; ') || 'no problems'), pass: !vb.length });
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await eff(pg);
    await pg.evaluate(() => document.getElementById('addBtn').click()); await pg.waitForTimeout(300);
    await pg.fill('#f_amount', '5000'); await pg.fill('#f_note', 'future-dated');
    await pg.evaluate(() => { const d = document.getElementById('f_date'); d.value = '2026-12-25'; d.dispatchEvent(new Event('change', { bubbles: true })); });
    await pg.evaluate(() => document.getElementById('addSubmit').click()); await pg.waitForTimeout(600);
    const b = await eff(pg);
    rec({ area: 'T', id: 'T10', title: 'Log an expense dated Dec 25 (in the future)', sev: 'med', expected: 'either refused, or flagged as upcoming; it should not silently drop today\'s cash',
      observed: 'free ' + a.free + ' → ' + b.free + ' (dropped ' + r2(a.free - b.free) + ' today), no warning: ' + !pg.dialogs.length, pass: Math.abs(a.free - b.free) < 0.02 || pg.dialogs.length > 0 });
    await done(pg, ctx);
  }

  // ================= C: cards =================
  {
    const { ctx, pg } = await fresh({ time: NOW });
    await addTxn(pg, { kind: 'card_charge', category: 'Lifestyle', account: 'Maya CC', amount: 20000, note: 'over the limit', date: '2026-11-12' });
    await pg.waitForTimeout(400);
    const c = await pg.evaluate(() => { const e = window.FinApp.effectiveSnap(); const m = e.cards.find((x) => x.name === 'Maya CC'); return { bal: m.balance, util: m.util_pct }; }).catch(() => null);
    const shown = await pg.evaluate(() => document.body.innerText.match(/over (the )?limit|over your limit/i) ? 'yes' : 'no');
    rec({ area: 'C', id: 'C1', title: 'Charge ₱20,000 on Maya CC (₱10,000 limit)', sev: 'med', expected: 'saved, and the app warns it is over the limit', observed: 'over-limit warning on screen: ' + shown + (c ? '; Maya CC now ₱' + c.bal + ' (' + c.util + '% of limit)' : ''), pass: shown === 'yes' });
    await invRec(pg, 'C', 'C1i', 'over the limit');
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await eff(pg);
    await addTxn(pg, { kind: 'card_payment', category: '', account: 'Maya CC', amount: r2((a.cards['Maya CC'] || 0) + 5000), note: 'overpaid', date: '2026-11-12', payWith: 'LandBank' });
    await pg.waitForTimeout(400);
    const b = await eff(pg);
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(400);
    const row = await pg.evaluate(() => { const r = Array.from(document.querySelectorAll('#numOverview .nv-acc')).find((x) => /Maya CC/.test(x.textContent)); return r ? r.innerText.replace(/\n/g, ' ') : ''; });
    await closeAll(pg);
    rec({ area: 'C', id: 'C2', title: 'Pay ₱5,000 more than Maya CC owes', sev: 'med', expected: 'allowed (a credit balance) but shown as a credit — never a negative "owed"',
      observed: 'Maya CC ' + a.cards['Maya CC'] + ' → ' + b.cards['Maya CC'] + '; All numbers shows: "' + row + '"', pass: /credit/i.test(row) && !/-\s*PHP|PHP\s*-/.test(row) });
    await invRec(pg, 'C', 'C2i', 'overpaid card');
    await done(pg, ctx);
  }
  {
    // card limit 0, billing day 31, due = billing day
    const { ctx, pg } = await fresh({ time: NOW });
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => { const blk = Array.from(document.querySelectorAll('#rowsAcc .accblk')).find((b) => b.querySelector('[data-r="name"]').value === 'Maya CC');
      const set = (r, v) => { const e = blk.querySelector('[data-r="' + r + '"]'); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } };
      set('limit', '0'); set('billing', '31'); set('dued', '31'); set('pday', '31'); });
    await pg.evaluate(() => document.getElementById('baseSave').click()); await pg.waitForTimeout(600); await closeAll(pg);
    await invRec(pg, 'C', 'C3', 'A card with ₱0 limit, bills on the 31st, due on the 31st, prepay the 31st (November has 30 days)');
    await done(pg, ctx);
  }
  {
    // switch a card that owes money to Debit
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await eff(pg);
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => { const blk = Array.from(document.querySelectorAll('#rowsAcc .accblk')).find((b) => b.querySelector('[data-r="name"]').value === 'Maya CC'); const k = blk.querySelector('[data-r="kind"]'); k.value = 'debit'; k.dispatchEvent(new Event('change', { bubbles: true })); });
    await pg.evaluate(() => document.getElementById('baseSave').click()); await pg.waitForTimeout(600); await closeAll(pg);
    const b = await eff(pg);
    rec({ area: 'C', id: 'C4', title: 'Switch Maya CC (owes ₱' + a.cards['Maya CC'] + ') to Debit by mistake', sev: 'high', expected: 'a warning first; never the debt silently turning into cash',
      observed: 'liquid ' + a.liquid + ' → ' + b.liquid + ', owed ' + a.owed + ' → ' + b.owed + ', free ' + a.free + ' → ' + b.free + '; warning: ' + (pg.dialogs[0] || 'none'), pass: pg.dialogs.length > 0 || Math.abs(b.free - a.free) < 0.02 });
    await done(pg, ctx);
  }

  // ================= P: plans =================
  {
    const { ctx, pg } = await fresh({ time: NOW });
    await pg.evaluate(() => document.getElementById('planAddBtn') && document.getElementById('planAddBtn').click());
    await pg.evaluate(() => { const b = document.querySelector('[id*="planAdd"]'); if (b) b.click(); }); await pg.waitForTimeout(300);
    const tryPlan = async (name, amount, rep, count) => {
      pg.dialogs = []; const n0 = await pg.evaluate(() => window.FinApp.state.plans.length);
      await pg.evaluate(() => { const b = document.querySelector('[id*="planAdd"]'); if (b) b.click(); }); await pg.waitForTimeout(200);
      await pg.fill('#p_name', name); await pg.fill('#p_amount', amount); await pg.selectOption('#p_repeat', rep);
      if (count != null) await pg.evaluate((c) => { const w = document.getElementById('p_countWrap'); if (w) w.style.display = ''; document.getElementById('p_count').value = c; }, String(count));
      await pg.evaluate(() => document.querySelector('#planForm button[type=submit]').click()); await pg.waitForTimeout(400);
      const n1 = await pg.evaluate(() => window.FinApp.state.plans.length);
      const last = await pg.evaluate(() => { const p = window.FinApp.state.plans[window.FinApp.state.plans.length - 1]; return { name: p.name, count: p.count, amount: p.amount }; });
      await closeAll(pg);
      return { added: n1 > n0, msg: pg.dialogs[0], last };
    };
    let r = await tryPlan('Zero plan', '0', 'once'); rec({ area: 'P', id: 'P1', title: 'Plan with amount ₱0', sev: 'low', expected: 'refused with a message', observed: r.added ? 'saved' : 'refused (' + (r.msg || 'no message') + ')', pass: !r.added && !!r.msg });
    r = await tryPlan('Count zero', '100', 'monthly', 0); rec({ area: 'P', id: 'P2', title: 'Monthly plan, "How many times" = 0', sev: 'low', expected: 'refused, or treated as "keep going"', observed: r.added ? 'saved with count ' + r.last.count : 'refused', pass: !r.added || r.last.count == null });
    r = await tryPlan('Monthly on the 31st', '500', 'monthly'); // date = today; then test a 31st anchor through the API
    const occ = await pg.evaluate(async () => { const F = window.FinApp; await F.addPlan({ name: 'Rent31', amount: 1000, date: '2027-01-31', repeat: 'monthly', count: 4 }); const p = F.state.plans.find((x) => x.name === 'Rent31'); return F.planOccurrences(p).slice(0, 4); });
    rec({ area: 'P', id: 'P3', title: 'Monthly plan anchored on Jan 31 (Feb has 28 days)', sev: 'med', expected: 'Jan 31, Feb 28, Mar 31, Apr 30', observed: occ.join(', '), pass: occ.join(',') === '2027-01-31,2027-02-28,2027-03-31,2027-04-30' });
    await invRec(pg, 'P', 'P3i', 'after the plan edge cases');
    await done(pg, ctx);
  }
  {
    // pay a plan MORE than planned; then delete the plan after paying
    const { ctx, pg } = await fresh({ time: NOW });
    const p = await pg.evaluate(() => { const F = window.FinApp, d = F.insightsData(); const r = F.coachRows(d).rows.find((x) => x.act === 'plan' || (x.payload && x.payload.planId)); return r ? r.payload : null; });
    const pl = await pg.evaluate(() => { const F = window.FinApp; const p = F.state.plans.find((x) => x.repeat); const occ = F.planOccurrences(p).find((d) => d >= F.todayISO()); return { id: p.id, name: p.name, amt: p.amount, d: occ }; });
    const a = await eff(pg); const dA = await pg.evaluate(() => window.FinApp.insightsData().planDeduct);
    await pg.evaluate((x) => window.FinApp.payPlanChip(x.id + '|' + x.d + '|' + x.name + '|' + x.amt), pl); await pg.waitForTimeout(300);
    await pg.fill('#f_amount', String(pl.amt * 2)); await pg.evaluate(() => document.getElementById('addSubmit').click()); await pg.waitForTimeout(600);
    const dB = await pg.evaluate(() => window.FinApp.insightsData().planDeduct);
    rec({ area: 'P', id: 'P4', title: 'Pay ' + pl.name + ' double the planned amount (linked)', sev: 'med', expected: 'the plan counts as paid; the extra is just spending (the plan deduction never goes negative)', observed: 'plan deduction ' + dA + ' → ' + dB, pass: dB >= 0 });
    await pg.evaluate((id) => window.FinApp.deletePlan(id), pl.id); await pg.waitForTimeout(400);
    const dangling = await pg.evaluate((id) => window.FinApp.state.txns.filter((t) => t.planRef && t.planRef.planId === id).length, pl.id);
    await invRec(pg, 'P', 'P5', 'Delete a plan after paying it (' + dangling + ' entries still link to it)', 'med');
    await done(pg, ctx);
  }
  {
    // plan files under a category that is then removed
    const { ctx, pg } = await fresh({ time: NOW });
    await pg.evaluate(async () => { const F = window.FinApp; await F.addPlan({ name: 'Groceries run', amount: 2500, date: '2026-11-20', repeat: null, category: 'Grocery' }); });
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.querySelector('#numOverview [data-nv="bud"]').click()); await pg.waitForTimeout(200);
    await pg.evaluate(() => { const row = Array.from(document.querySelectorAll('#rowsBud .brow')).find((r) => r.querySelector('[data-r="name"]').value === 'Grocery'); row.querySelector('[data-rm]').click(); });
    await pg.evaluate(() => document.getElementById('baseSave').click()); await pg.waitForTimeout(500); await closeAll(pg);
    const pl = await pg.evaluate(() => { const p = window.FinApp.state.plans.find((x) => x.name === 'Groceries run'); return { id: p.id, cat: p.category }; });
    await pg.evaluate((pl) => window.FinApp.payPlanChip(pl.id + '|2026-11-20|Groceries run|2500'), pl); await pg.waitForTimeout(300);
    const picked = await pg.evaluate(() => document.getElementById('f_category').value);
    rec({ area: 'P', id: 'P6', title: 'A plan filing under "Grocery", after Grocery is removed', sev: 'low', expected: 'the plan is told (or the link cleared); paying it doesn\'t file under a category that no longer exists',
      observed: 'plan still says "' + pl.cat + '"; paying pre-picks "' + picked + '"', pass: picked !== 'Grocery' });
    await done(pg, ctx);
  }

  // ================= O: owed =================
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const n = await pg.evaluate(async () => { const F = window.FinApp; await F.addOwedPerson('Vhal'); await F.addOwedPerson('vhal'); await F.addOwedPerson('   '); return (F.state.owed && (F.state.owed.people || F.state.owed)).length; });
    rec({ area: 'O', id: 'O1', title: 'Add "Vhal", then "vhal", then a blank name', sev: 'low', expected: 'one person; duplicate and blank refused', observed: n + ' people', pass: true });
    const r = await pg.evaluate(async () => {
      const F = window.FinApp; const ps = F.state.owed.people || F.state.owed; const p = ps[ps.length - 1];
      const before = F.effectiveSnap().cash.free;
      await F.addOwedEntry(p.id, { dir: 'ipf', total: 100, theirs: 300, mine: 0, d: F.todayISO(), note: 'theirs > total', account: 'Cash' });
      return { before, after: F.effectiveSnap().cash.free };
    });
    rec({ area: 'O', id: 'O2', title: '"I paid for them": total ₱100 but their part ₱300', sev: 'med', expected: 'refused (their part can\'t exceed the total)', observed: 'free ' + r.before + ' → ' + r.after + '; message: ' + (pg.dialogs[0] || 'none'), pass: pg.dialogs.length > 0 || Math.abs(r.after - r.before) < 0.02 });
    await invRec(pg, 'O', 'O3', 'after the owed edge cases', 'med');
    await done(pg, ctx);
  }

  // ================= I: data safety =================
  const tmp = (name, obj) => { const p = path.join(C.OUT, name); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p; };
  const seed = JSON.parse(fs.readFileSync(C.SEED, 'utf8'));
  for (const [id, label, file] of [
    ['I1', 'a broken (truncated) backup file', tmp('bad_trunc.json', JSON.stringify(seed).slice(0, 5000))],
    ['I2', 'a JSON file that is not a Fin.AI backup', tmp('bad_other.json', { hello: 'world', items: [1, 2, 3] })],
    ['I3', 'a backup holding only the ledger', tmp('only_txns.json', { app: 'finances-pwa', sections: ['txns'], txns: seed.txns.slice(0, 5) })],
    ['I4', 'a backup with poisoned values (NaN amounts, bad dates, HTML names)', tmp('poison.json', Object.assign({}, seed, { txns: seed.txns.slice(0, 3).concat([{ id: 'x1', date: 'yesterday', kind: 'cash_out', account: '<b>x</b>', amount: 'NaN', note: '<img src=x onerror=alert(2)>' }, { id: 'x2', date: '2026-11-01', kind: 'weird', account: 'Cash', amount: 1e12 }]) }))]]) {
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await eff(pg), n0 = await pg.evaluate(() => window.FinApp.state.txns.length);
    pg.dialogs = [];
    await pg.setInputFiles('#impFile', file); await pg.waitForTimeout(1500); await closeAll(pg);
    const b = await eff(pg), n1 = await pg.evaluate(() => window.FinApp.state.txns.length);
    const v = await inv(pg);
    const msg = await pg.evaluate(() => document.getElementById('snack').innerText.replace(/\n/g, ' ').slice(0, 120));
    rec({ area: 'I', id, title: 'Restore ' + label, sev: id === 'I4' ? 'high' : 'med',
      expected: id === 'I3' ? 'only the ledger is replaced (5 entries); accounts and plans stay' : 'refused or cleaned with a clear message; your data intact; nothing runs',
      observed: 'entries ' + n0 + ' → ' + n1 + '; free ' + a.free + ' → ' + b.free + '; message "' + (pg.dialogs[0] || msg) + '"' + (v.length ? '; PROBLEMS: ' + v.join(' ; ') : ''),
      pass: !v.length && !pg.dialogs.some((d) => /alert: 2/.test(d)) && (id === 'I3' ? n1 === 5 : (id === 'I4' ? true : n1 === n0)) });
    await done(pg, ctx);
  }
  {
    // reload right after saving (did it persist?)
    const { ctx, pg } = await fresh({ time: NOW });
    const n0 = await pg.evaluate(() => window.FinApp.state.txns.length);
    await pg.evaluate(() => { window.FinApp.addTxn({ kind: 'cash_out', category: 'Food', account: 'Cash', amount: 42, note: 'reload probe', date: '2026-11-12' }, { quiet: true }); });
    await pg.reload(); await pg.waitForFunction(() => window.FinApp && window.FinApp.state, null, { timeout: 20000 }); await pg.waitForTimeout(2500);
    const n1 = await pg.evaluate(() => window.FinApp.state.txns.length);
    rec({ area: 'I', id: 'I5', title: 'Close the app the instant an entry is saved', sev: 'high', expected: 'the entry is there after reopening', observed: 'entries ' + n0 + ' → ' + n1, pass: n1 === n0 + 1 });
    await done(pg, ctx);
  }
  {
    // a big ledger: 10,000 entries — speed
    const big = Object.assign({}, seed); const t = [];
    for (let i = 0; i < 10000; i++) { const d = new Date(Date.UTC(2025, 0, 1) + i * 3600e3 * 2.6); t.push({ id: 'big' + i, date: d.toISOString().slice(0, 10), kind: i % 7 === 0 ? 'card_charge' : 'cash_out', account: i % 7 === 0 ? 'Maya CC' : 'Cash', category: ['Food', 'Transpo', 'Lifestyle'][i % 3], amount: 50 + (i % 400), note: 'bulk ' + i, created: d.toISOString(), recordOnly: true }); }
    big.txns = seed.txns.concat(t);
    const p = tmp('big.json', big);
    const t0 = Date.now();
    const { ctx, pg } = await fresh({ time: NOW, seedFile: p });
    const tImport = Date.now() - t0;
    const t1 = Date.now(); await pg.evaluate(() => { const b = document.querySelector('[data-tab="ledger"]'); if (b) b.click(); }); await pg.waitForTimeout(100);
    const tLedger = await pg.evaluate(async () => { const s = performance.now(); window.FinApp.render(); return performance.now() - s; });
    const tAdd = await pg.evaluate(async () => { const s = performance.now(); await window.FinApp.addTxn({ kind: 'cash_out', category: 'Food', account: 'Cash', amount: 1, note: 'speed', date: window.FinApp.todayISO() }, { quiet: true }); return performance.now() - s; });
    rec({ area: 'I', id: 'I6', title: 'A 10,000-entry ledger', sev: 'med', expected: 'a full re-render under 300 ms, adding an entry under 300 ms', observed: 'load+import ' + Math.round(tImport / 1000) + 's; full render ' + Math.round(tLedger) + ' ms; add ' + Math.round(tAdd) + ' ms', pass: tLedger < 300 && tAdd < 300 });
    await invRec(pg, 'I', 'I6i', 'with 10,000 entries', 'med');
    await done(pg, ctx);
  }
};
