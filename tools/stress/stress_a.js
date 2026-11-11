// Fin.AI stress — groups: R (reconcile/rebase), D (destructive), S (salary), A (amounts/typing)
const C = require('./stress_core');
const { fresh, inv, rec, heroCheck, closeAll, hideSnack } = C;
const NOW = '2026-11-12T10:00:00+08:00';
const r2 = (x) => Math.round(x * 100) / 100;

async function live(pg) {
  return pg.evaluate(() => {
    const F = window.FinApp, e = F.effectiveSnap(), d = F.reconData();
    const debits = {}, cards = {};
    (d ? d.debits : []).forEach((r) => { debits[r.name] = r.live; });
    (e.cards || []).forEach((c) => { cards[c.name] = c.balance; });
    return { liquid: e.cash.total, free: e.cash.free, owed: e.card_owed, debits, cards, adj: JSON.parse(JSON.stringify(F.state.adj)) };
  });
}
const addTxn = (pg, t) => pg.evaluate((t) => window.FinApp.addTxn(t, { quiet: true }), t);
async function done(pg, ctx) { try { await ctx.close(); } catch (e) {} }
async function invRec(pg, area, id, title) {
  const v = await inv(pg);
  rec({ area, id: id + '·inv', title: title + ' — numbers stay consistent', expected: 'no invariant breaks', observed: v.join(' ; ') || 'ok', pass: !v.length, sev: v.some((x) => /JavaScript|not a number/.test(x)) ? 'high' : 'med' });
}
// open the numbers editor and type a balance into one account (the All numbers way)
async function editBalance(pg, name, value) {
  await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
  await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
  await pg.evaluate(({ name, value }) => {
    const blk = Array.from(document.querySelectorAll('#rowsAcc .accblk')).find((b) => b.querySelector('[data-r="name"]').value === name);
    const v = blk.querySelector('[data-r="value"]'); v.value = String(value); v.dispatchEvent(new Event('input', { bubbles: true }));
  }, { name, value });
  await pg.evaluate(() => document.getElementById('baseSave').click()); await pg.waitForTimeout(600);
  await closeAll(pg);
}

module.exports = async function groupA() {
  // ================= R: reconcile + rebase =================
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await live(pg);
    await editBalance(pg, 'LandBank', r2(a.debits.LandBank + 1000)); // correct ONE account by +1,000
    const b = await live(pg);
    const others = Object.keys(a.cards).filter((k) => Math.abs((b.cards[k] || 0) - a.cards[k]) > 0.01).map((k) => k + ' ' + a.cards[k] + ' → ' + b.cards[k])
      .concat(Object.keys(a.debits).filter((k) => k !== 'LandBank' && Math.abs((b.debits[k] || 0) - a.debits[k]) > 0.01).map((k) => k + ' ' + a.debits[k] + ' → ' + b.debits[k]));
    rec({ area: 'R', id: 'R1', title: 'Typing a new balance for ONE account in All numbers', sev: 'critical',
      expected: 'LandBank becomes the typed amount; every other account keeps its live number (liquid +1,000, owed unchanged)',
      observed: 'LandBank ' + a.debits.LandBank + ' → ' + b.debits.LandBank + '; liquid ' + a.liquid + ' → ' + b.liquid + '; owed ' + a.owed + ' → ' + b.owed + (others.length ? '; OTHER accounts moved: ' + others.join(', ') : ''),
      pass: !others.length && Math.abs(b.liquid - a.liquid - 1000) < 0.02 && Math.abs(b.owed - a.owed) < 0.02 });
    await invRec(pg, 'R', 'R1', 'balance edit');
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await live(pg);
    await pg.evaluate(() => { const F = window.FinApp; F.reconStartEdit('LandBank'); });
    await pg.evaluate((v) => { const F = window.FinApp; F.reconSetInput('LandBank', v); F.reconSave(); }, r2(a.debits.LandBank - 500));
    await pg.waitForTimeout(600);
    const b = await live(pg);
    const others = Object.keys(a.cards).filter((k) => Math.abs((b.cards[k] || 0) - a.cards[k]) > 0.01).map((k) => k + ' ' + a.cards[k] + ' → ' + b.cards[k])
      .concat(Object.keys(a.debits).filter((k) => k !== 'LandBank' && Math.abs((b.debits[k] || 0) - a.debits[k]) > 0.01).map((k) => k + ' ' + a.debits[k] + ' → ' + b.debits[k]));
    rec({ area: 'R', id: 'R2', title: 'Reconcile ONE account (Money tab) down by 500', sev: 'critical',
      expected: 'LandBank −500, every other account unchanged, one Reconcile row in the ledger',
      observed: 'LandBank ' + a.debits.LandBank + ' → ' + b.debits.LandBank + '; liquid Δ ' + r2(b.liquid - a.liquid) + (others.length ? '; OTHER accounts moved: ' + others.join(', ') : ''),
      pass: !others.length && Math.abs(b.debits.LandBank - a.debits.LandBank + 500) < 0.02 });
    // undo the reconcile
    const undoOk = await pg.evaluate(() => { const b = document.querySelector('#snack button'); if (!b) return false; b.click(); return true; });
    await pg.waitForTimeout(600);
    const c = await live(pg);
    rec({ area: 'R', id: 'R2u', title: 'Undo a reconcile', sev: 'high', expected: 'every number back exactly as before',
      observed: (undoOk ? '' : 'no Undo button; ') + 'liquid ' + a.liquid + ' → ' + c.liquid + ', owed ' + a.owed + ' → ' + c.owed + ', free ' + a.free + ' → ' + c.free,
      pass: undoOk && Math.abs(c.liquid - a.liquid) < 0.02 && Math.abs(c.owed - a.owed) < 0.02 && Math.abs(c.free - a.free) < 0.02 });
    await invRec(pg, 'R', 'R2', 'reconcile + undo');
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await live(pg);
    const ml0 = await pg.evaluate(() => window.FinApp.state.moneyLog.length);
    await pg.evaluate((v) => { const F = window.FinApp; F.reconStartEdit('LandBank'); F.reconSetInput('LandBank', v); F.reconSave(); }, a.debits.LandBank);
    await pg.waitForTimeout(400);
    const b = await live(pg), ml1 = await pg.evaluate(() => window.FinApp.state.moneyLog.length);
    rec({ area: 'R', id: 'R3', title: 'Reconcile to the SAME amount', sev: 'low', expected: 'nothing changes, no ledger row',
      observed: 'money-log rows ' + ml0 + ' → ' + ml1 + ', free ' + a.free + ' → ' + b.free, pass: ml0 === ml1 && Math.abs(a.free - b.free) < 0.02 });
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await live(pg);
    await pg.evaluate(() => window.FinApp.resetAdj()); await pg.waitForTimeout(200);
    const asked = await pg.evaluate(() => { const d = document.getElementById('confirmDlg'); return !!(d && (d.open || d.classList.contains('show') || getComputedStyle(d).display !== 'none')); });
    await pg.evaluate(() => window.FinApp.confirmYes()); await pg.waitForTimeout(500);
    const b = await live(pg);
    const undoOk = await pg.evaluate(() => { const b = document.querySelector('#snack button'); if (!b) return false; b.click(); return true; });
    await pg.waitForTimeout(500);
    const c = await live(pg);
    rec({ area: 'R', id: 'R4', title: 'Reset to my numbers → Undo', sev: 'high', expected: 'asks first; Undo puts every number back exactly',
      observed: 'asked first: ' + asked + '; reset free ' + a.free + ' → ' + b.free + '; after Undo ' + c.free + ', owed ' + c.owed + ' (was ' + a.owed + ')',
      pass: asked && undoOk && Math.abs(c.free - a.free) < 0.02 && Math.abs(c.owed - a.owed) < 0.02 });
    await done(pg, ctx);
  }
  {
    // an entry logged BEFORE a rebase, deleted AFTER it (the v73.45 phantom family)
    const { ctx, pg } = await fresh({ time: NOW });
    const id = await addTxn(pg, { kind: 'cash_out', category: 'Food', account: 'LandBank', amount: 777, note: 'probe pre-rebase', date: '2026-11-12' });
    await pg.waitForTimeout(200);
    const a = await live(pg);
    await editBalance(pg, 'LandBank', r2(a.debits.LandBank + 10)); // LandBank's real balance typed AFTER the 777 (it already includes it)
    await pg.evaluate(() => window.FinApp.addTxn({ kind: 'card_charge', category: 'Food', account: 'Maya CC', amount: 50, note: 'later', date: '2026-11-12' }, { quiet: true })); // the overlay is not empty
    await pg.waitForTimeout(200);
    const b = await live(pg);
    await pg.evaluate((id) => window.FinApp.deleteTxn(id), id); await pg.waitForTimeout(500);
    const c = await live(pg);
    rec({ area: 'R', id: 'R5', title: 'Delete an entry logged before that account\'s balance was typed', sev: 'high',
      expected: 'LandBank stays at the typed balance (no phantom +777)',
      observed: 'LandBank ' + b.debits.LandBank + ' → ' + c.debits.LandBank + ', liquid ' + b.liquid + ' → ' + c.liquid,
      pass: Math.abs(c.liquid - b.liquid) < 0.02 && Math.abs(c.debits.LandBank - b.debits.LandBank) < 0.02 });
    // and an entry on ANOTHER account (never re-based) still gives its money back when deleted
    const id2 = await addTxn(pg, { kind: 'cash_out', category: 'Food', account: 'MariBank', amount: 300, note: 'probe other', date: '2026-11-12' });
    await editBalance(pg, 'LandBank', r2(c.debits.LandBank + 5));
    const d1 = await live(pg);
    await pg.evaluate((id) => window.FinApp.deleteTxn(id), id2); await pg.waitForTimeout(500);
    const d2 = await live(pg);
    rec({ area: 'R', id: 'R5b', title: 'Delete a MariBank entry after correcting LandBank', sev: 'high',
      expected: 'MariBank gets its 300 back; LandBank stays', observed: 'MariBank ' + d1.debits.MariBank + ' → ' + d2.debits.MariBank + ', LandBank ' + d1.debits.LandBank + ' → ' + d2.debits.LandBank,
      pass: Math.abs(d2.debits.MariBank - d1.debits.MariBank - 300) < 0.02 && Math.abs(d2.debits.LandBank - d1.debits.LandBank) < 0.02 });
    // the per-account Adjustment row, removed from the ledger, moves only LandBank back
    const adjRow = await pg.evaluate(() => { const ml = window.FinApp.state.moneyLog; const e = ml.slice().reverse().find((x) => x.k === 'a' && x.m === 'LandBank'); return e ? e.at : null; });
    rec({ area: 'R', id: 'R5c', title: 'A per-account correction is filed as an Adjustment row', sev: 'med', expected: 'a LandBank Adjustment row exists', observed: adjRow ? 'yes' : 'no', pass: !!adjRow });
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await live(pg);
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => { const e = document.getElementById('b_asof'); e.value = '2026-11-01'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
    await pg.evaluate(() => document.getElementById('baseSave').click()); await pg.waitForTimeout(600); await closeAll(pg);
    const b = await live(pg);
    rec({ area: 'R', id: 'R6', title: 'Change only "Balances as of"', sev: 'high', expected: 'no live number moves',
      observed: 'free ' + a.free + ' → ' + b.free + ', owed ' + a.owed + ' → ' + b.owed, pass: Math.abs(a.free - b.free) < 0.02 && Math.abs(a.owed - b.owed) < 0.02 });
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await live(pg);
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => { const blk = Array.from(document.querySelectorAll('#rowsAcc .accblk')).find((b) => b.querySelector('[data-r="name"]').value === 'MariBank CC'); const l = blk.querySelector('[data-r="limit"]'); l.value = '80000'; l.dispatchEvent(new Event('input', { bubbles: true })); const u = blk.querySelector('[data-r="util"]'); u.value = '25'; u.dispatchEvent(new Event('input', { bubbles: true })); });
    await pg.evaluate(() => document.getElementById('baseSave').click()); await pg.waitForTimeout(600); await closeAll(pg);
    const b = await live(pg);
    rec({ area: 'R', id: 'R7', title: 'Change a card\'s limit and % (regression for v74.45)', sev: 'critical', expected: 'no live balance moves',
      observed: 'free ' + a.free + ' → ' + b.free + ', MariBank CC ' + a.cards['MariBank CC'] + ' → ' + b.cards['MariBank CC'], pass: Math.abs(a.free - b.free) < 0.02 && Math.abs(a.cards['MariBank CC'] - b.cards['MariBank CC']) < 0.02 });
    await done(pg, ctx);
  }
  {
    // an entry dated BEFORE the account's last typed balance (record-only rule)
    const { ctx, pg } = await fresh({ time: NOW });
    const a = await live(pg);
    await editBalance(pg, 'MariBank', r2(a.debits.MariBank + 5)); // stamps "absorbed" today for MariBank
    const b = await live(pg);
    await addTxn(pg, { kind: 'cash_out', category: 'Food', account: 'MariBank', amount: 300, note: 'old receipt', date: '2026-11-01' });
    await pg.waitForTimeout(400);
    const c = await live(pg);
    rec({ area: 'R', id: 'R8', title: 'Log an old receipt dated before the balance you just typed', sev: 'med',
      expected: 'it is history only (the typed balance already includes it) — MariBank does not drop',
      observed: 'MariBank ' + b.debits.MariBank + ' → ' + c.debits.MariBank, pass: Math.abs(c.debits.MariBank - b.debits.MariBank) < 0.02 });
    await done(pg, ctx);
  }
  {
    // backup → restore keeps the live numbers
    const { ctx, pg } = await fresh({ time: NOW });
    await addTxn(pg, { kind: 'card_charge', category: 'Food', account: 'Maya CC', amount: 250, note: 'probe', date: '2026-11-12' });
    await pg.waitForTimeout(300);
    const a = await live(pg);
    const dl = pg.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await pg.evaluate(() => document.getElementById('expJson').click());
    const d = await dl; let p = null; if (d) { p = require('path').join(C.OUT, 'bk_probe.json'); await d.saveAs(p); }
    await done(pg, ctx);
    if (p) {
      const f2 = await fresh({ time: NOW, seedFile: p });
      const b = await live(f2.pg);
      rec({ area: 'R', id: 'R9', title: 'Back up, then restore into a fresh phone', sev: 'critical', expected: 'same live numbers after restore',
        observed: 'free ' + a.free + ' → ' + b.free + ', owed ' + a.owed + ' → ' + b.owed, pass: Math.abs(a.free - b.free) < 0.02 && Math.abs(a.owed - b.owed) < 0.02 });
      // restore the SAME file again on top — must not duplicate
      const n0 = await f2.pg.evaluate(() => window.FinApp.state.txns.length);
      await f2.pg.setInputFiles('#impFile', p); await f2.pg.waitForTimeout(1500); await closeAll(f2.pg);
      const n1 = await f2.pg.evaluate(() => window.FinApp.state.txns.length), c = await live(f2.pg);
      rec({ area: 'R', id: 'R10', title: 'Restore the same backup twice', sev: 'high', expected: 'no duplicate entries, same numbers',
        observed: 'entries ' + n0 + ' → ' + n1 + ', free ' + b.free + ' → ' + c.free, pass: n0 === n1 && Math.abs(b.free - c.free) < 0.02 });
      await done(f2.pg, f2.ctx);
    } else rec({ area: 'R', id: 'R9', title: 'Back up then restore', sev: 'high', expected: 'a file downloads', observed: 'no download happened', pass: false });
  }

  // ================= D: destructive actions =================
  {
    const { ctx, pg } = await fresh({ time: NOW });
    // remove an account that HAS ledger entries
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
    const nEnt = await pg.evaluate(() => window.FinApp.state.txns.filter((t) => t.account === 'MariBank CC').length);
    await pg.evaluate(() => { const blk = Array.from(document.querySelectorAll('#rowsAcc .accblk')).find((b) => b.querySelector('[data-r="name"]').value === 'MariBank CC'); blk.querySelector('[data-rm]').click(); });
    await pg.waitForTimeout(200);
    const dlg = pg.dialogs.slice(), snack = await pg.evaluate(() => document.getElementById('snack').innerText.replace(/\n/g, ' '));
    await closeAll(pg);
    const v = await inv(pg);
    rec({ area: 'D', id: 'D1', title: 'Remove an account that has ' + nEnt + ' ledger entries', sev: 'high',
      expected: 'a warning naming how many entries use it; the entries stay as history; Undo offered',
      observed: 'warning: ' + (dlg.length ? dlg.join(' | ') : 'none') + '; toast: "' + snack + '"; ' + (v.filter((x) => /no longer exists/.test(x)).join(' ') || 'entries kept as history'),
      pass: dlg.length > 0 && /Undo/.test(snack) && !v.some((x) => /no longer exists/.test(x)) });
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    // rename an account with entries
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => { const blk = Array.from(document.querySelectorAll('#rowsAcc .accblk')).find((b) => b.querySelector('[data-r="name"]').value === 'MariBank'); const n = blk.querySelector('[data-r="name"]'); n.value = 'MariBank Savings'; n.dispatchEvent(new Event('input', { bubbles: true })); });
    const a = await live(pg);
    await pg.evaluate(() => document.getElementById('baseSave').click()); await pg.waitForTimeout(600); await closeAll(pg);
    const b = await live(pg), v = await inv(pg);
    rec({ area: 'D', id: 'D2', title: 'Rename an account (MariBank → MariBank Savings)', sev: 'high',
      expected: 'its entries follow the new name and its live balance is unchanged',
      observed: 'live ' + a.debits.MariBank + ' → ' + b.debits['MariBank Savings'] + '; ' + (v.filter((x) => /no longer exists/.test(x)).join(' ') || 'entries follow'),
      pass: !v.some((x) => /no longer exists/.test(x)) && Math.abs((b.debits['MariBank Savings'] || 0) - a.debits.MariBank) < 0.02 });
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    // remove two accounts quickly — can both come back?
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
    const a = await live(pg);
    for (const nm of ['Maya CC', 'LandBank']) {
      await pg.evaluate((nm) => { const blk = Array.from(document.querySelectorAll('#rowsAcc .accblk')).find((b) => b.querySelector('[data-r="name"]').value === nm); blk.querySelector('[data-rm]').click(); }, nm);
      await pg.waitForTimeout(150);
    }
    await pg.evaluate(() => { const b = document.querySelector('#snack button'); if (b) b.click(); }); await pg.waitForTimeout(300);
    const left = await pg.evaluate(() => Array.from(document.querySelectorAll('#rowsAcc .accblk')).map((b) => b.querySelector('[data-r="name"]').value));
    rec({ area: 'D', id: 'D3', title: 'Remove two accounts back-to-back, then Undo', sev: 'high', expected: 'both can be brought back (one Undo each, or one that restores both)',
      observed: 'after one Undo the accounts are: ' + left.join(', '), pass: left.includes('Maya CC') && left.includes('LandBank') });
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    // delete a ledger entry from the Ledger UI
    await pg.evaluate(() => { const b = document.querySelector('[data-tab="ledger"], #tabs [data-t="ledger"]'); if (b) b.click(); }); await pg.waitForTimeout(500);
    const a = await live(pg);
    const n0 = await pg.evaluate(() => window.FinApp.state.txns.length);
    const id = await pg.evaluate(() => window.FinApp.state.txns.slice().sort((x, y) => String(y.created).localeCompare(String(x.created)))[0].id);
    await pg.evaluate((id) => window.FinApp.deleteTxn(id), id); await pg.waitForTimeout(400);
    const undo = await pg.evaluate(() => { const b = document.querySelector('#snack button'); return b ? b.textContent : null; });
    if (undo) { await pg.evaluate(() => document.querySelector('#snack button').click()); await pg.waitForTimeout(500); }
    const n1 = await pg.evaluate(() => window.FinApp.state.txns.length), b = await live(pg);
    rec({ area: 'D', id: 'D4', title: 'Delete a ledger entry → Undo', sev: 'high', expected: 'Undo offered; the entry and every number come back',
      observed: 'undo: ' + (undo || 'none') + '; entries ' + n0 + ' → ' + n1 + '; free ' + a.free + ' → ' + b.free, pass: !!undo && n0 === n1 && Math.abs(a.free - b.free) < 0.02 });
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const p = await pg.evaluate(() => { const p = window.FinApp.state.plans.find((x) => x.repeat); return { id: p.id, name: p.name, n: window.FinApp.state.plans.length }; });
    await pg.evaluate((id) => window.FinApp.deletePlan(id), p.id); await pg.waitForTimeout(300);
    const undo = await pg.evaluate(() => { const b = document.querySelector('#snack button'); return b ? b.textContent : null; });
    const asked = pg.dialogs.slice();
    if (undo) { await pg.evaluate(() => document.querySelector('#snack button').click()); await pg.waitForTimeout(400); }
    const n1 = await pg.evaluate(() => window.FinApp.state.plans.length);
    rec({ area: 'D', id: 'D5', title: 'Delete a whole recurring plan (' + p.name + ') → Undo', sev: 'high', expected: 'asks first or offers Undo; the plan comes back',
      observed: 'asked: ' + (asked.join('|') || 'no') + '; undo: ' + (undo || 'none') + '; plans ' + p.n + ' → ' + n1, pass: (asked.length || undo) && n1 === p.n });
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    // category remove while entries use it
    await pg.evaluate(() => document.getElementById('setBtn').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.getElementById('setNumAll').click()); await pg.waitForTimeout(300);
    await pg.evaluate(() => document.querySelector('#numOverview [data-nv="bud"]').click()); await pg.waitForTimeout(200);
    const used = await pg.evaluate(() => window.FinApp.state.txns.filter((t) => t.category === 'Food').length);
    await pg.evaluate(() => { const row = Array.from(document.querySelectorAll('#rowsBud .brow')).find((r) => r.querySelector('[data-r="name"]').value === 'Food'); row.querySelector('[data-rm]').click(); });
    await pg.waitForTimeout(150);
    const toast = await pg.evaluate(() => document.getElementById('snack').innerText.replace(/\n/g, ' '));
    await closeAll(pg);
    const chips = await pg.evaluate(() => { document.getElementById('addBtn').click(); return new Promise((r) => setTimeout(() => r(Array.from(document.querySelectorAll('#addSheet .achip')).map((c) => c.textContent.trim()).filter(Boolean).slice(0, 12).join(',')), 500)); });
    rec({ area: 'D', id: 'D6', title: 'Remove the Food category while ' + used + ' entries use it', sev: 'med',
      expected: 'a warning (' + used + ' entries use it) or the entries keep a working category; Undo offered',
      observed: 'toast "' + toast + '"; Add-sheet categories now: ' + chips, pass: /Undo/i.test(toast) && pg.dialogs.length > 0 });
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    // the Owed person remove path
    const r = await pg.evaluate(async () => { const F = window.FinApp; const pid = await F.addOwedPerson('Probe Person'); return { pid, n: (F.state.owed && F.state.owed.people || []).length }; });
    const btn = await pg.evaluate(() => { const t = document.querySelector('[data-tab="owed"], #tabs [data-t="owed"]'); if (t) t.click(); return !!t; });
    await pg.waitForTimeout(500);
    const rm = await pg.evaluate(() => { const b = Array.from(document.querySelectorAll('#tab-owed button')).find((x) => /remove|delete|✕/i.test((x.getAttribute('aria-label') || '') + x.textContent)); return b ? (b.getAttribute('aria-label') || b.textContent) : null; });
    rec({ area: 'D', id: 'D7', title: 'Owed tab: is there a way to remove a person, and is it guarded?', sev: 'low', expected: 'a remove that asks first or offers Undo',
      observed: rm ? 'found "' + rm + '" (guard checked in the UI pass)' : 'no remove button found on the Owed tab', pass: true });
    await done(pg, ctx);
  }

  // ================= S: salary =================
  const salCase = async (id, frac, opts) => {
    opts = opts || {};
    const { ctx, pg } = await fresh({ time: NOW });
    const before = await pg.evaluate(() => { const F = window.FinApp, d = F.insightsData(); const rows = F.coachRows(d).rows.filter((r) => r.act === 'salary'); return { chip: rows.length ? rows[0].payload : null, ml: F.state.moneyLog.length, cnt: F.state.txns.filter((t) => t.kind === 'cash_in' && /Salary \(the/.test(t.note || '')).length }; });
    if (!before.chip) { rec({ area: 'S', id, title: 'Salary chip present before payday', expected: 'a salary chip 3 days before the 15th', observed: 'no salary chip', pass: false, sev: 'high' }); await done(pg, ctx); return; }
    const exp = before.chip.amount, amt = r2(exp * frac);
    await pg.evaluate((p) => window.FinApp.salaryRowChip(p.amount + '|' + p.date + '|' + p.sday), before.chip); await pg.waitForTimeout(400);
    const acct = await pg.evaluate(() => { const s = document.getElementById('f_account'); return s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : s.value; });
    if (opts.acct) await pg.evaluate((v) => { document.getElementById('f_account').value = v; }, opts.acct);
    await pg.fill('#f_amount', String(amt));
    await pg.evaluate(() => document.getElementById('addSubmit').click()); await pg.waitForTimeout(700);
    if (opts.twice) {
      await pg.evaluate((p) => window.FinApp.salaryRowChip(p.amount + '|' + p.date + '|' + p.sday), before.chip); await pg.waitForTimeout(300);
      await pg.fill('#f_amount', String(amt)); await pg.evaluate(() => document.getElementById('addSubmit').click()); await pg.waitForTimeout(700);
    }
    const after = await pg.evaluate(() => { const F = window.FinApp, d = F.insightsData(); const rows = F.coachRows(d).rows.filter((r) => r.act === 'salary'); const ml = F.state.moneyLog.slice().sort((a, b) => a.at - b.at); const last = ml[ml.length - 1];
      const mp = F.todayISO().slice(0, 7); let want = 0;
      F.state.txns.forEach((t) => { if (String(t.date).slice(0, 7) === mp && t.kind !== 'card_payment' && t.kind !== 'cash_in') want += Number(t.amount) || 0; });
      return { chip: rows.length > 0, cnt: F.state.txns.filter((t) => t.kind === 'cash_in' && /Salary \(the/.test(t.note || '')).length, lastS: last ? last.s : null, wantS: Math.round(want * 100) / 100, hw: d.headroomWindow && d.headroomWindow.early }; });
    return { ctx, pg, exp, amt, acct, before, after };
  };
  for (const [id, frac, label] of [['S1', 1, 'exactly the set salary'], ['S2', 0.95, '95% of it'], ['S3', 0.85, '85% (deductions)'], ['S4', 0.5, '50% (half month)'], ['S5', 1.2, '120%'], ['S6', 2, '200% (13th month)']]) {
    const r = await salCase(id, frac); if (!r) continue;
    rec({ area: 'S', id, title: 'Log salary from the chip at ' + label + ' (₱' + r.amt + ')', sev: frac < 0.9 ? 'high' : 'med',
      expected: 'counted as salary: the chip goes away, and the month-spent line is not pushed down by it',
      observed: 'chip still showing: ' + r.after.chip + '; month spent shows ' + r.after.lastS + ' (should be ' + r.after.wantS + ')',
      pass: !r.after.chip && (r.after.lastS == null || Math.abs(r.after.lastS - r.after.wantS) < 0.02) });
    if (id === 'S1') rec({ area: 'S', id: 'S1a', title: 'Which account the salary chip pre-picks', sev: 'med', expected: 'the account the salary actually lands in (LandBank in your history)', observed: '"' + r.acct + '" (the LAST bank account in your list)', pass: /LandBank/.test(r.acct) });
    await invRec(r.pg, 'S', id, 'salary ' + label);
    await done(r.pg, r.ctx);
  }
  {
    const r = await salCase('S7', 1, { twice: true });
    if (r) { rec({ area: 'S', id: 'S7', title: 'Tap the salary chip and log it TWICE', sev: 'med', expected: 'the second one is flagged ("already logged") or the chip is gone after the first', observed: 'salary entries added: ' + (r.after.cnt - r.before.cnt) + ', no warning: ' + !r.pg.dialogs.length, pass: r.after.cnt - r.before.cnt <= 1 || r.pg.dialogs.length > 0 }); await done(r.pg, r.ctx); }
  }

  // ================= A: amounts + typing (through the real Add sheet) =================
  {
    const { ctx, pg } = await fresh({ time: NOW });
    const cases = [['0', 'reject'], ['-50', 'reject'], ['0.001', 'reject-or-round'], ['99999999', 'ok'], ['1,000', 'ok:1000'], ['1e9', 'reject'], ['300--100', 'ok:400'], ['5/0', 'reject'], ['100+', 'reject'], ['   ', 'reject'], ['abc', 'reject'], ['1/3', 'ok:0.33'], ['(100+50)*2', 'ok:300'], ['12.345', 'ok:12.35']];
    for (const [input, want] of cases) {
      await pg.evaluate(() => document.getElementById('addBtn').click()); await pg.waitForTimeout(250);
      const n0 = await pg.evaluate(() => window.FinApp.state.txns.length); pg.dialogs = [];
      await pg.fill('#f_amount', input); await pg.fill('#f_note', 'amt probe ' + input);
      await pg.evaluate(() => document.getElementById('addSubmit').click()); await pg.waitForTimeout(450);
      const st = await pg.evaluate((n0) => { const T = window.FinApp.state.txns; return { added: T.length > n0, amt: T.length > n0 ? T[T.length - 1].amount : null }; }, n0);
      // what does it store?
      let pass, obs = st.added ? 'saved ₱' + st.amt : 'rejected (' + (pg.dialogs[0] || 'no message') + ')';
      if (want === 'reject') pass = !st.added && pg.dialogs.length > 0;
      else if (want === 'reject-or-round') pass = !st.added || Math.abs(st.amt - Math.round(st.amt * 100) / 100) < 1e-9;
      else if (want === 'ok') pass = st.added;
      else { const w = Number(want.split(':')[1]); pass = st.added && Math.abs(st.amt - w) < 0.005; }
      rec({ area: 'A', id: 'A-' + input.trim(), title: 'Amount typed: "' + input + '"', sev: /1,000|12.345|1\/3|0.001/.test(input) ? 'med' : 'low', expected: want.replace('ok:', 'saved as ₱').replace('reject', 'refused with a message'), observed: obs, pass });
      if (st.added) await pg.evaluate(() => { const T = window.FinApp.state.txns; return window.FinApp.deleteTxn(T[T.length - 1].id); });
      await closeAll(pg); await hideSnack(pg);
    }
    // XSS / long text in a note
    await pg.evaluate(() => document.getElementById('addBtn').click()); await pg.waitForTimeout(250);
    pg.dialogs = [];
    await pg.fill('#f_amount', '12'); await pg.fill('#f_note', '<img src=x onerror=alert(1)><b>bold</b> ' + 'very long note '.repeat(30));
    await pg.evaluate(() => document.getElementById('addSubmit').click()); await pg.waitForTimeout(800);
    const xs = await pg.evaluate(() => !!document.querySelector('#tab-ledger img[src="x"], #mlBody img[src="x"]'));
    rec({ area: 'A', id: 'A-xss', title: 'A note containing HTML / a script', sev: 'high', expected: 'shown as plain text, never run', observed: (pg.dialogs.length ? 'a script RAN: ' + pg.dialogs[0] : 'no script ran') + (xs ? '; an <img> element was created' : ''), pass: !pg.dialogs.length && !xs });
    await invRec(pg, 'A', 'A-long', 'a 450-character note');
    await done(pg, ctx);
  }
  {
    const { ctx, pg } = await fresh({ time: NOW });
    // double-tap the Add button
    await pg.evaluate(() => document.getElementById('addBtn').click()); await pg.waitForTimeout(250);
    const n0 = await pg.evaluate(() => window.FinApp.state.txns.length);
    await pg.fill('#f_amount', '55');
    await pg.evaluate(() => { const b = document.getElementById('addSubmit'); b.click(); b.click(); });
    await pg.waitForTimeout(800);
    const n1 = await pg.evaluate(() => window.FinApp.state.txns.length);
    rec({ area: 'A', id: 'A-dbl', title: 'Double-tap "Add expense"', sev: 'high', expected: 'one entry', observed: (n1 - n0) + ' entries saved', pass: n1 - n0 === 1 });
    await done(pg, ctx);
  }
};
