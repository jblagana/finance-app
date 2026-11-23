// Fin.AI stress group W: two-phone Owed sync. Ana (inviter, side a) and Ben (side b) run the real app in
// separate headless profiles on the synthetic smoke seed. The relay is a mailbox in this process (page.route on
// <relay>/conn) that the test controls: hold, deliver in order / reversed, duplicate, drop, go offline. Firebase
// and every other outside host are blocked, so the live Firestore route stays off. No LLM calls.
const C = require('./stress_core');
const RELAY = 'https://finsmart-coach.jan-rhey-lagana.workers.dev';
const T0 = '2026-11-20T10:00:00+08:00';
const AREA = 'W';

// ---------------- the relay stand-in ----------------
const MB = {}; let seq = 0;
function P(pair) { return MB[pair] || (MB[pair] = { box: { a: [], b: [] }, held: { a: [], b: [] }, hold: { a: true, b: true }, down: false, sends: 0 }); }
function only() { const k = Object.keys(MB); return MB[k[k.length - 1]]; }
async function relay(route) {
  let j = {}; try { j = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
  const p = P(j.pair);
  const reply = (code, o) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(o) });
  if (p.down && j.op !== 'reg') return reply(503, { error: 'relay offline' });
  if (j.op === 'reg') return reply(200, { ok: true });
  if (j.op === 'send') {
    const row = { id: 'r' + (++seq), msg: j.msg };
    p.sends++;
    if (j.invite || !p.hold[j.to]) p.box[j.to].push(row); else p.held[j.to].push(row);
    return reply(200, { ok: true });
  }
  if (j.op === 'pull') { const b = p.box[j.me] || []; return reply(200, { msgs: b.slice(0, 20), more: b.length > 20 }); }
  if (j.op === 'ack') { const ids = new Set(j.ids || []); p.box[j.me] = (p.box[j.me] || []).filter((r) => !ids.has(r.id)); return reply(200, { ok: true }); }
  if (j.op === 'drop') { delete MB[j.pair]; return reply(200, { ok: true }); }
  return reply(400, { error: 'bad op' });
}
// release what is held for `to`: order 'fifo' | 'reverse', dup = deliver each twice, pick = indexes to release
function deliver(to, opt) {
  opt = opt || {}; const p = only();
  let rows = p.held[to].slice();
  if (opt.pick) rows = opt.pick.map((i) => p.held[to][i]).filter(Boolean);
  p.held[to] = p.held[to].filter((r) => rows.indexOf(r) < 0);
  if (opt.order === 'reverse') rows.reverse();
  rows.forEach((r) => { p.box[to].push(r); if (opt.dup) p.box[to].push({ id: 'r' + (++seq), msg: r.msg }); });
  return rows.length;
}
function dropHeld(to) { const p = only(); const n = p.held[to].length; p.held[to] = []; return n; }
function heldN(to) { return only().held[to].length; }

async function wire(ctx) {
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.indexOf(RELAY + '/conn') === 0) return relay(route);
    if (u.indexOf('http://localhost') === 0) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(HELPERS);
}

// ---------------- in-page helpers (window.__T) ----------------
const HELPERS = `(${function () {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const F = () => window.FinApp;
  const per = () => (F().state.owed.people || []).filter((p) => p.conn)[0] || null;
  const find = (q) => { const p = per(); return (p.entries || []).filter((e) => e.id === q || e.cid === q)[0] || null; };
  const txn = (id) => (F().state.txns || []).filter((t) => t.id === id)[0] || null;
  const sign = { ipf: 1, itb: 1, tpf: -1, tmb: -1 };
  // the Owed form's payload: total / mine / theirs as typed, amt = the owed part (owedSplit)
  const norm = (d) => { d = Object.assign({ acc: 'CASH::Cash', cat: 'Unsorted', note: '' }, d);
    const Tt = d.total || 0, M = d.mine || 0, Th = d.theirs || 0;
    if (d.amt == null) d.amt = (d.dir === 'ipf' || d.dir === 'tpf') ? F().owedSplit(d.dir, Tt, M, Th).owed : Tt;
    d.total = Tt; d.mine = M; d.theirs = Th; return d; };
  window.__T = {
    wait,
    per: () => { const p = per(); return p && p.id; },
    async sync(n) { for (let i = 0; i < (n || 2); i++) { const p = per(); if (p) await F().connSync(p.id); await wait(150); } },
    async add(d) {
      const p = per(); const before = new Set((p.entries || []).map((e) => e.id));
      await F().addOwedEntry(p.id, norm(d)); await wait(250);
      const e = (per().entries || []).filter((x) => !before.has(x.id))[0];
      return e ? { id: e.id, cid: e.cid } : null;
    },
    async upd(q, d) { const p = per(), e = find(q); if (!e) return 'no entry'; await F().updateOwedEntry(p.id, e.id, norm(d)); await wait(250); return 'ok'; },
    // the card's Remove control + the confirm dialog (the real handler path)
    async del(q) { const p = per(), e = find(q); if (!e) return 'no entry';
      const card = document.querySelector('#owedBody [data-ow-pid="' + p.id + '"]'); if (!card) return 'no card on screen';
      const b = document.createElement('button'); b.setAttribute('data-ow-del-e', e.id); card.appendChild(b); b.click(); b.remove(); await wait(200);
      const y = document.getElementById('confirmYes'); if (!y) return 'no confirm'; y.click(); await wait(500); return 'ok'; },
    async undo() { const b = document.getElementById('snackUndo'), s = document.getElementById('snack'); if (!b || !s || !s.classList.contains('show')) return false; b.click(); await wait(400); return true; },
    async confirm(cid, acc, cat) { const p = per(); const it = (p.conn.in || []).filter((x) => x.cid === cid && !x.rej)[0]; if (!it) return 'nothing to confirm';
      await F().connConfirm(p.id, cid, it.k, acc, cat, { cv: it.cv, cr: it.cr }); await wait(300); return 'ok'; },
    // a stale screen: the revision captured earlier is the one the button carries
    inRev(cid) { const p = per(); const it = (p.conn.in || []).filter((x) => x.cid === cid)[0]; return it ? { cv: it.cv, cr: it.cr, k: it.k, amt: it.amt } : null; },
    async confirmRev(cid, rev, acc, cat) { const p = per(); await F().connConfirm(p.id, cid, rev.k, acc, cat, { cv: rev.cv, cr: rev.cr }); await wait(300); },
    async rejectRev(cid, rev, why) { const p = per(); await F().connReject(p.id, cid, rev.k, why || 'no', { cv: rev.cv, cr: rev.cr }); await wait(300); },
    async reject(cid, why) { const p = per(); const it = (p.conn.in || []).filter((x) => x.cid === cid && !x.rej)[0]; if (!it) return 'nothing';
      await F().connReject(p.id, cid, it.k, why || 'not right', { cv: it.cv, cr: it.cr }); await wait(300); return 'ok'; },
    // the Ledger sheet's save on the linked row: same id, the changed fields only
    async ledEdit(q, ch) { const e = find(q); if (!e || !e.txnId) return 'no linked row'; const t = txn(e.txnId); if (!t) return 'row gone';
      const pay = { date: t.date, account: t.account, kind: t.kind, category: t.category, amount: t.amount, note: t.note };
      Object.assign(pay, ch); await F().saveTxnEdit(t.id, pay); await wait(300); return 'ok'; },
    // the inbox card's Confirm button (what a person taps): reports the pickers' shown defaults, optionally re-picks
    async uiConfirm(cid, pick) {
      const btn = Array.from(document.querySelectorAll('#owedBody [data-cn-ok]')).filter((x) => x.getAttribute('data-cn-ok').split('|')[1] === cid)[0];
      if (!btn) return { err: 'no Confirm button on screen' };
      const it = btn.closest('.cn-it'), c = it.querySelector('.cn-cat'), a = it.querySelector('.cn-acc');
      const shown = { cat: c ? c.value : null, acc: a ? a.value : null };
      if (pick && pick.cat && c) c.value = pick.cat;
      if (pick && pick.acc && a) a.value = pick.acc;
      btn.click(); await wait(700); return shown; },
    async ledDel(q) { const e = find(q); if (!e || !e.txnId) return 'no linked row'; await F().deleteTxn(e.txnId); await wait(300); return 'ok'; },
    snap() {
      const p = per(); if (!p) return null;
      let bal = 0;
      const ents = (p.entries || []).map((e) => {
        if (e.cst !== 'no' && sign[e.dir]) bal += sign[e.dir] * (Number(e.amt) || 0);
        const t = e.txnId ? txn(e.txnId) : null;
        return { id: e.id, cid: e.cid || null, cv: e.cv || null, cst: e.cst || null, dir: e.dir, amt: e.amt, d: e.d, note: e.note || '', cat: e.cat || '', acc: e.acc || '',
          mine: e.mine, theirs: e.theirs, total: e.total, draft: e.cdraft ? { amt: e.cdraft.amt, d: e.cdraft.d, note: e.cdraft.note || '', dir: e.cdraft.dir } : null,
          rejd: e.crejected || '', why: e.cwhy || '', txnId: e.txnId || null,
          txn: t ? { amount: t.amount, date: t.date, category: t.category, account: t.account, kind: t.kind, note: t.note } : (e.txnId ? 'MISSING' : null) };
      });
      return { bal: Math.round(bal * 100) / 100, ents, inb: (p.conn.in || []).map((x) => ({ k: x.k, cid: x.cid, cv: x.cv, amt: x.amt, d: x.d, note: x.note, dir: x.dir, rej: !!x.rej, old: x.old || null })),
        out: (p.conn.out || []).length, st: p.conn.st, err: p.conn.err || '', removed: Object.keys(p.conn.removed || {}).length };
    }
  };
}})();`;

// ---------------- node-side driving ----------------
const T = (pg, name, ...args) => pg.evaluate(([n, a]) => window.__T[n](...a), [name, args]);
async function both(A, B) { await T(A, 'sync'); await T(B, 'sync'); await T(A, 'sync'); await T(B, 'sync'); }
async function pairUp(tag) {
  for (const k of Object.keys(MB)) delete MB[k];
  const A = (await C.fresh({ time: T0, onCtx: wire })), B = (await C.fresh({ time: T0, onCtx: wire }));
  const a = A.pg, b = B.pg; a.ctx = A.ctx; b.ctx = B.ctx; a.who = 'Ana'; b.who = 'Ben';
  const r = await a.evaluate(async () => {
    const F = window.FinApp; F.addOwedPerson('Ben'); await window.__T.wait(400);
    const p = F.state.owed.people.filter((x) => x.name === 'Ben')[0];
    const c = await F.connCreateInvite(p.id, 'Ana');
    return F.connInviteLink(c, p.id);
  });
  const hash = r.slice(r.indexOf('#'));
  await b.evaluate(async (h) => { const F = window.FinApp; const j = F.connParseJoin(h); const inv = await F.connReadInvite(j); await F.connJoin(j, inv, null, true); }, hash);
  deliver('a'); await both(a, b);
  const sa = await T(a, 'snap'), sb = await T(b, 'snap');
  const ok = sa && sb && sa.st === 'linked' && sb.st === 'linked';
  C.rec({ area: AREA, id: tag + '.pair', title: tag + ': Ana and Ben pair through the real invite link', expected: 'both linked', observed: JSON.stringify([sa && sa.st, sb && sb.st]), pass: ok });
  return { a, b, A, B };
}
async function reload(pg) {
  await pg.reload();
  await pg.waitForFunction(() => window.FinApp && window.FinApp.state && window.__T && window.__T.per(), null, { timeout: 20000 });
  await pg.waitForTimeout(1500);
  await C.closeAll(pg);
}
// after everything is delivered and answered: the two books agree
async function agree(tag, a, b, opts) {
  opts = opts || {};
  const sa = await T(a, 'snap'), sb = await T(b, 'snap'), probs = [];
  const M = { ipf: 'tpf', tpf: 'ipf', itb: 'tmb', tmb: 'itb' };
  if (Math.abs(sa.bal + sb.bal) > 0.009) probs.push('Ana says Ben owes ' + sa.bal + ' but Ben says he owes ' + (-sb.bal));
  const byA = {}; sa.ents.forEach((e) => { if (e.cid) byA[e.cid] = e; });
  const byB = {}; sb.ents.forEach((e) => { if (e.cid) byB[e.cid] = e; });
  Object.keys(byA).concat(Object.keys(byB)).forEach((cid) => {
    const x = byA[cid], y = byB[cid];
    if (!x || !y) { probs.push('entry ' + cid + ' is only in ' + (x ? 'Ana' : 'Ben') + '\'s book (' + JSON.stringify(x || y).slice(0, 160) + ')'); return; }
    if (x.cst !== 'ok' || y.cst !== 'ok') probs.push(cid + ' status Ana=' + x.cst + ' Ben=' + y.cst);
    if (Math.abs(x.amt - y.amt) > 0.004 || M[x.dir] !== y.dir || x.d !== y.d || x.note !== y.note) probs.push(cid + ' differs: Ana ' + [x.dir, x.amt, x.d, x.note].join('/') + ' vs Ben ' + [y.dir, y.amt, y.d, y.note].join('/'));
    if (x.draft || y.draft) probs.push(cid + ' still has a proposed edit');
  });
  [['Ana', sa], ['Ben', sb]].forEach(([w, s]) => {
    if (s.inb.length) probs.push(w + ' inbox still has ' + JSON.stringify(s.inb).slice(0, 200));
    if (s.out) probs.push(w + ' still has ' + s.out + ' unsent message(s)');
    s.ents.forEach((e) => { probs.push.apply(probs, rowProbs(w, e)); });
  });
  for (const pg of [a, b]) { const v = await C.inv(pg); v.forEach((x) => probs.push(pg.who + ': ' + x)); }
  C.rec({ area: AREA, id: tag, title: opts.title || (tag + ': both books agree'), expected: opts.expected || 'mirror entries, all in sync, empty inboxes, Ledger rows match', observed: probs.join(' | ') || 'ok', pass: probs.length === 0, sev: opts.sev });
  return { sa, sb, probs };
}
// the entry's own Ledger row matches its filed share (ipf: mine on the picked account; tpf: amt on Cash)
function rowProbs(w, e) {
  const out = [];
  if (e.txn === 'MISSING') { out.push(w + ': ' + (e.cid || e.id) + ' points at a Ledger row that is gone'); return out; }
  const want = e.dir === 'tpf' ? e.amt : e.dir === 'ipf' ? (e.mine || 0) : 0;
  if (want > 0 && !e.txn) { out.push(w + ': ' + (e.cid || e.id) + ' should have a ' + want + ' Ledger row and has none'); return out; }
  if (!e.txn) return out;
  if (Math.abs(e.txn.amount - want) > 0.004) out.push(w + ': ' + (e.cid || e.id) + ' Ledger row is ' + e.txn.amount + ', the share is ' + want);
  if (e.txn.date !== e.d) out.push(w + ': ' + (e.cid || e.id) + ' Ledger date ' + e.txn.date + ' vs entry date ' + e.d);
  if ((e.txn.category || '') !== (e.cat || '')) out.push(w + ': ' + (e.cid || e.id) + ' Ledger category "' + e.txn.category + '" vs entry "' + e.cat + '"');
  return out;
}
function check(tag, title, pass, expected, observed, sev) { C.rec({ area: AREA, id: tag, title, expected, observed: typeof observed === 'string' ? observed : JSON.stringify(observed), pass, sev }); }
async function close(pr) { for (const x of [pr.A, pr.B]) { try { await x.ctx.close(); } catch (e) {} } }

module.exports = async function () {
  const pick = process.env.ONLY_W ? process.env.ONLY_W.split(',') : null;
  for (const g of require('./stress_owed_groups')) {
    if (pick && pick.indexOf(g.id) < 0) continue;
    const pr = await pairUp(g.id);
    try { await g.run(Object.assign({ T, both, deliver, dropHeld, heldN, reload, agree, check, wireCtx: wire, MB: () => only(), rowProbs, fresh: () => C.fresh({ time: T0, onCtx: wire }) }, pr)); }
    catch (e) { check(g.id + '.crash', g.id + ' crashed', false, 'runs', String(e && e.stack || e).slice(0, 500), 'harness'); }
    await close(pr);
  }
};
module.exports.lib = { T, deliver, MB, P };
