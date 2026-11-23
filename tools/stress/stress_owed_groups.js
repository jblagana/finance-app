// Group W scenarios (stress_owed.js). Ana logs "I paid for them" (ipf) entries for Ben unless a step says
// otherwise; Ben's book mirrors them as "They paid for me" (tpf), filed on his Cash under the picked category.
const fs = require('fs'), path = require('path');
const BASE = { d: '2026-11-20', dir: 'ipf', total: 300, mine: 100, theirs: 200, cat: 'Food', note: 'lunch' };
const ent = (s, cid) => s.ents.filter((e) => e.cid === cid || e.id === cid)[0] || null;
const inb = (s, cid) => s.inb.filter((x) => x.cid === cid);

// everything held goes through, both ways, until quiet
async function flush(X, opt) {
  for (let i = 0; i < 3; i++) {
    await X.T(X.a, 'sync', 1); await X.T(X.b, 'sync', 1);
    X.deliver('a', opt); X.deliver('b', opt);
    await X.T(X.a, 'sync', 1); await X.T(X.b, 'sync', 1);
  }
}
async function send(X, pg) { await X.T(pg, 'sync', 1); }
// a new entry Ben confirmed (both in sync)
async function agreed(X, d, cat) {
  const e = await X.T(X.a, 'add', Object.assign({}, BASE, d || {}));
  await flush(X);
  await X.T(X.b, 'confirm', e.cid, '', cat || 'Food');
  await flush(X);
  return e.cid;
}
async function reloadBoth(X) { await X.reload(X.a); await X.reload(X.b); }

module.exports = [
  // ---------------- 1: many edits on an entry Ben has not confirmed yet ----------------
  { id: 'W1', run: async (X) => {
    const { a, b, T, check } = X;
    const steps = [{ theirs: 250, total: 350 }, { theirs: 280, total: 380 }, { theirs: 220, total: 320 },
      { d: '2026-11-18' }, { d: '2026-11-19' }, { d: '2026-11-17' }, { note: 'lunch 2' }, { note: 'lunch 3' }, { note: 'team lunch' }];
    const final = Object.assign({}, BASE); steps.forEach((s) => Object.assign(final, s));
    for (const mode of [{ tag: 'fifo' }, { tag: 'reverse', order: 'reverse' }, { tag: 'dup', dup: true }, { tag: 'split' }]) {
      const e = await T(a, 'add', Object.assign({}, BASE));
      await send(X, a);
      const cur = Object.assign({}, BASE);
      for (const s of steps) { Object.assign(cur, s); await T(a, 'upd', e.cid, Object.assign({}, cur)); }
      await send(X, a);
      const held = X.heldN('b');
      if (mode.tag === 'split') { X.deliver('b', { pick: [0, 1, 2, 3] }); await T(b, 'sync'); X.deliver('b'); await T(b, 'sync'); }
      else { X.deliver('b', mode); await T(b, 'sync'); }
      const sb = await T(b, 'snap'), its = inb(sb, e.cid);
      check('W1.' + mode.tag + '.inbox', '1 (' + mode.tag + '): 9 edits on a pending entry (' + held + ' messages) leave Ben one inbox item with the latest values',
        its.length === 1 && its[0].amt === 220 && its[0].d === '2026-11-17' && its[0].note === 'team lunch' && its[0].dir === 'tpf',
        '1 item: 220 / 2026-11-17 / team lunch / tpf', its);
      await T(b, 'confirm', e.cid, '', 'Food');
      await flush(X);
      const sa = await T(a, 'snap'), ea = ent(sa, e.cid);
      check('W1.' + mode.tag + '.anaRow', '1 (' + mode.tag + '): Ana\'s entry and Ledger row carry the last edit',
        ea && ea.amt === 220 && ea.cst === 'ok' && ea.txn && ea.txn.amount === 100 && ea.txn.date === '2026-11-17' && /team lunch/.test(ea.txn.note),
        'amt 220 ok, row 100 on 2026-11-17 "team lunch"', ea);
    }
    // direction flip while pending: ipf -> tpf -> ipf -> tpf (they paid 150 for me)
    const f = await T(a, 'add', Object.assign({}, BASE));
    await send(X, a);
    await T(a, 'upd', f.cid, { d: '2026-11-20', dir: 'tpf', total: 150, mine: 150, cat: 'Food', note: 'flip' });
    await T(a, 'upd', f.cid, Object.assign({}, BASE, { note: 'flip' }));
    await T(a, 'upd', f.cid, { d: '2026-11-20', dir: 'tpf', total: 150, mine: 150, cat: 'Food', note: 'flip' });
    await send(X, a); X.deliver('b', { order: 'reverse' }); await T(b, 'sync');
    let sb = await T(b, 'snap');
    check('W1.flip.inbox', '1: direction flipped 3 times while pending (delivered reversed): Ben sees "I paid for them 150"',
      inb(sb, f.cid).length === 1 && inb(sb, f.cid)[0].dir === 'ipf' && inb(sb, f.cid)[0].amt === 150, '1 item ipf 150', inb(sb, f.cid));
    await T(b, 'confirm', f.cid, 'CASH::Cash', '');
    await flush(X);
    // split change while pending: Ana's share and Ben's both move
    const g = await T(a, 'add', Object.assign({}, BASE, { note: 'split' }));
    await send(X, a);
    await T(a, 'upd', g.cid, Object.assign({}, BASE, { note: 'split', total: 400, mine: 250, theirs: 150 }));
    await T(a, 'upd', g.cid, Object.assign({}, BASE, { note: 'split', total: 500, mine: 100, theirs: 400 }));
    await T(a, 'upd', g.cid, Object.assign({}, BASE, { note: 'split', total: 600, mine: 0, theirs: 600 }));
    await send(X, a); X.deliver('b'); await T(b, 'sync');
    sb = await T(b, 'snap');
    check('W1.split.inbox', '1: split edited 3 times while pending (last: total 600, all theirs): Ben sees 600',
      inb(sb, g.cid).length === 1 && inb(sb, g.cid)[0].amt === 600, '600', inb(sb, g.cid));
    await T(b, 'confirm', g.cid, '', 'Food');
    await flush(X);
    const sa = await T(a, 'snap'), ga = ent(sa, g.cid);
    check('W1.split.anaRow', '1: after "all theirs", Ana has no Ledger row for her share', ga && !ga.txn, 'no row', ga);
    await X.agree('W1.agree', a, b, { title: '1: after all of it, both books agree' });
    await reloadBoth(X);
    await X.agree('W1.reload', a, b, { title: '1: ...and still agree after both reopen' });
  } },

  // ---------------- 2: stacked proposed edits on a confirmed entry ----------------
  { id: 'W2', run: async (X) => {
    const { a, b, T, check } = X;
    const cid = await agreed(X);
    for (const th of [250, 300, 350]) await T(a, 'upd', cid, Object.assign({}, BASE, { theirs: th, total: 100 + th }));
    let sa = await T(a, 'snap'), ea = ent(sa, cid);
    check('W2.hold', '2: 3 stacked proposals keep the agreed 200 and its Ledger row until Ben answers',
      ea.amt === 200 && ea.draft && ea.draft.amt === 350 && ea.cst === 'wait' && ea.txn.amount === 100 && sa.bal === 200, 'amt 200, draft 350, row 100', ea);
    await send(X, a); X.deliver('b'); await T(b, 'sync');
    let sb = await T(b, 'snap');
    check('W2.inbox', '2: Ben gets one review "350, changed from 200"', inb(sb, cid).length === 1 && inb(sb, cid)[0].amt === 350 && inb(sb, cid)[0].old && inb(sb, cid)[0].old.amt === 200, '350 from 200', inb(sb, cid));
    await T(b, 'confirm', cid, '', 'Food'); await flush(X);
    await X.agree('W2.a', a, b, { title: '2: confirming the latest of 3 proposals: both at 350' });

    // Undo in the middle of the stack: 400, 450, Undo -> back to the 400 proposal
    await T(a, 'upd', cid, Object.assign({}, BASE, { theirs: 400, total: 500 }));
    await T(a, 'upd', cid, Object.assign({}, BASE, { theirs: 450, total: 550 }));
    const u = await T(a, 'undo');
    sa = await T(a, 'snap'); ea = ent(sa, cid);
    check('W2.undo', '2: Undo on the 2nd proposal goes back to the 1st (400), agreed 350 kept', u && ea.draft && ea.draft.amt === 400 && ea.amt === 350, 'undo shown, draft 400, amt 350', { undo: u, e: ea });
    await send(X, a); X.deliver('b', { order: 'reverse' }); await T(b, 'sync');
    sb = await T(b, 'snap');
    check('W2.undo.inbox', '2: Ben (messages reversed) sees 400', inb(sb, cid).length === 1 && inb(sb, cid)[0].amt === 400, '400', inb(sb, cid));
    await T(b, 'confirm', cid, '', 'Food'); await flush(X);
    await X.agree('W2.b', a, b, { title: '2: Undo mid-stack then confirm: both at 400' });

    // stale screen: Ben's screen shows 410, Ana changes to 420 meanwhile; Ben taps Confirm on the 410 card
    await T(a, 'upd', cid, Object.assign({}, BASE, { theirs: 410, total: 510 })); await send(X, a); X.deliver('b'); await T(b, 'sync');
    const stale = await T(b, 'inRev', cid);
    await T(a, 'upd', cid, Object.assign({}, BASE, { theirs: 420, total: 520 })); await send(X, a); X.deliver('b'); await T(b, 'sync');
    await T(b, 'confirmRev', cid, stale, '', 'Food'); await flush(X);
    sa = await T(a, 'snap'); sb = await T(b, 'snap');
    check('W2.staleOk', '2: Confirm tapped on a stale 410 card does nothing; 420 still waits on both sides',
      ent(sb, cid).amt === 400 && inb(sb, cid).length === 1 && inb(sb, cid)[0].amt === 420 && ent(sa, cid).amt === 400 && ent(sa, cid).draft && ent(sa, cid).draft.amt === 420,
      'Ben 400 + inbox 420; Ana 400 + draft 420', { ben: ent(sb, cid), inbox: inb(sb, cid), ana: ent(sa, cid) });
    await T(b, 'rejectRev', cid, stale, 'stale'); await flush(X);
    sa = await T(a, 'snap');
    check('W2.staleNo', '2: Reject tapped on the stale card does nothing either', ent(sa, cid).draft && ent(sa, cid).draft.amt === 420 && !ent(sa, cid).rejd, 'draft 420, not rejected', ent(sa, cid));
    // reject the current one
    await T(b, 'reject', cid, 'too much'); await flush(X);
    sa = await T(a, 'snap'); sb = await T(b, 'snap');
    check('W2.reject', '2: rejecting 420 keeps 400 on both, Ana sees "Edit rejected"',
      ent(sa, cid).amt === 400 && !ent(sa, cid).draft && /too much/.test(ent(sa, cid).rejd) && ent(sb, cid).amt === 400 && sa.bal === -sb.bal,
      'both 400, Ana rejd "too much"', { ana: ent(sa, cid), ben: ent(sb, cid), inbox: sb.inb });
    // edit after reject
    await T(a, 'upd', cid, Object.assign({}, BASE, { theirs: 380, total: 480 })); await flush(X);
    sb = await T(b, 'snap');
    check('W2.afterRej', '2: a new edit after a reject replaces the rejected card (one item, 380)', inb(sb, cid).length === 1 && inb(sb, cid)[0].amt === 380 && !inb(sb, cid)[0].rej, '1 item 380', inb(sb, cid));
    await T(b, 'confirm', cid, '', 'Food'); await flush(X);
    await X.agree('W2.c', a, b, { title: '2: edit after reject, confirmed: both at 380' });
    await reloadBoth(X);
    await X.agree('W2.reload', a, b, { title: '2: ...and after both reopen' });
  } },

  // ---------------- 3: both edit the same entry at once ----------------
  { id: 'W3', run: async (X) => {
    const { a, b, T, check } = X;
    const cid = await agreed(X);
    await T(a, 'upd', cid, Object.assign({}, BASE, { theirs: 240, total: 340 }));
    // Ben edits his mirror (tpf 200 -> 210) before Ana's proposal arrives
    await T(b, 'upd', cid, { d: '2026-11-20', dir: 'tpf', total: 210, mine: 210, cat: 'Food', note: 'lunch' });
    await flush(X);
    let sa = await T(a, 'snap'), sb = await T(b, 'snap');
    const ia = inb(sa, cid).filter((x) => !x.rej), ib = inb(sb, cid).filter((x) => !x.rej);
    const loser = ib.length && !ia.length ? 'Ben' : ia.length && !ib.length ? 'Ana' : null;
    const le = loser === 'Ben' ? ent(sb, cid) : loser === 'Ana' ? ent(sa, cid) : null;
    check('W3.seen', '3: simultaneous proposals (Ana 240, Ben 210): exactly one review is shown, on the side whose proposal lost',
      !!loser, 'one side has the other\'s card', { anaInbox: ia, benInbox: ib });
    check('W3.loser', '3: the side whose proposal lost is told ("You both changed it at once"), not left waiting',
      le && le.cst === 'ok' && !le.draft && /at once/.test(le.rejd), 'in sync + told', { loser, entry: le });
    if (ib.length) await T(b, 'confirm', cid, '', '');
    if (ia.length) await T(a, 'confirm', cid, '', '');
    await flush(X);
    await X.agree('W3.agree', a, b, { title: '3: after one confirmation both books agree' });
  } },

  // ---------------- 4: Ledger-side detail edits on the linked row ----------------
  { id: 'W4', run: async (X) => {
    const { a, b, T, check } = X;
    const cid = await agreed(X, { note: 'dinner' });
    // 4a: Ana changes her Ledger row's category, note, date and account (Cash -> Maya CC)
    await T(a, 'ledEdit', cid, { category: 'Transpo' });
    await T(a, 'ledEdit', cid, { note: 'dinner at Mesa · Owed · Ben' });
    await T(a, 'ledEdit', cid, { date: '2026-11-19' });
    await T(a, 'ledEdit', cid, { account: 'Maya CC', kind: 'card_charge' });
    await send(X, a);
    let sa = await T(a, 'snap'), ea = ent(sa, cid);
    check('W4.a.follow', '4: Ledger edits on Ana\'s linked row: category + account update her entry, date + note become a proposal to Ben',
      ea.cat === 'Transpo' && /Maya CC/.test(ea.acc) && ea.draft && ea.draft.d === '2026-11-19' && ea.draft.note === 'dinner at Mesa' && ea.amt === 200,
      'entry Transpo / Maya CC, draft 2026-11-19 "dinner at Mesa"', { entry: [ea.cat, ea.acc, ea.d, ea.note], draft: ea.draft, row: ea.txn });
    check('W4.a.friend', '4: the date / note change goes to Ben', X.heldN('b') > 0, 'a message to Ben', 'messages to Ben: ' + X.heldN('b'));
    await flush(X);
    let sb = await T(b, 'snap');
    check('W4.a.card', '4: Ben is asked to confirm Nov 19 "dinner at Mesa" at the same 200',
      inb(sb, cid).length === 1 && inb(sb, cid)[0].d === '2026-11-19' && inb(sb, cid)[0].note === 'dinner at Mesa' && inb(sb, cid)[0].amt === 200, '1 card', inb(sb, cid));
    await T(b, 'confirm', cid, '', ''); await flush(X);
    sa = await T(a, 'snap'); ea = ent(sa, cid);
    check('W4.a.kept', '4: after Ben confirms, Ana\'s row still reads Transpo / Maya CC / Nov 19 / ₱100',
      ea.d === '2026-11-19' && ea.txn && ea.txn.category === 'Transpo' && ea.txn.account === 'Maya CC' && ea.txn.date === '2026-11-19' && ea.txn.amount === 100,
      'row Transpo / Maya CC / 2026-11-19 / 100', { row: ea.txn, entry: [ea.cat, ea.d, ea.acc] });
    // 4b: Ana's own Owed edit (the form opens prefilled from the entry) -> Ben confirms -> the row keeps her details
    await T(a, 'upd', cid, Object.assign({}, BASE, { note: ea.note, cat: ea.cat, d: ea.d, acc: ea.acc, theirs: 250, total: 350 }));
    await flush(X); await T(b, 'confirm', cid, '', ''); await flush(X);
    sa = await T(a, 'snap'); ea = ent(sa, cid);
    check('W4.b.keep', '4: after her own Owed edit is confirmed, Ana\'s Ledger row keeps Transpo / Maya CC / Nov 19',
      ea.txn && ea.txn.category === 'Transpo' && ea.txn.account === 'Maya CC' && ea.txn.date === '2026-11-19',
      'row Transpo / Maya CC / 2026-11-19', { row: ea.txn, entry: [ea.cat, ea.d, ea.acc] });
    // 4c: Ben edits his row (category + note); Ana confirms the note; then Ana proposes a new amount and Ben confirms
    await T(b, 'ledEdit', cid, { category: 'Fam', note: 'Ben side note · Owed · Ana' });
    sb = await T(b, 'snap'); let eb = ent(sb, cid);
    check('W4.c.follow', '4: Ben\'s Ledger category edit shows on his Owed entry; his note goes to Ana', eb.cat === 'Fam' && eb.draft && eb.draft.note === 'Ben side note', 'Fam + draft note', { entryCat: eb.cat, draft: eb.draft });
    await flush(X); await T(a, 'confirm', cid, '', ''); await flush(X);
    sa = await T(a, 'snap'); ea = ent(sa, cid);
    check('W4.c.anaShare', '4: Ana confirming Ben\'s note keeps her own ₱100 share row (Transpo / Maya CC)',
      ea.note === 'Ben side note' && ea.txn && ea.txn.amount === 100 && ea.txn.category === 'Transpo' && ea.txn.account === 'Maya CC', 'row 100 Transpo Maya CC', { entry: [ea.note, ea.mine], row: ea.txn });
    await T(a, 'upd', cid, Object.assign({}, BASE, { note: ea.note, cat: ea.cat, d: ea.d, acc: ea.acc, theirs: 260, total: 360 }));
    await flush(X); await T(b, 'confirm', cid, '', ''); await flush(X);
    sb = await T(b, 'snap'); eb = ent(sb, cid);
    check('W4.c.keep', '4: Ana\'s later edit, once Ben confirms, leaves Ben\'s Ledger category (Fam) and the agreed note',
      eb.txn && eb.txn.category === 'Fam' && /Ben side note/.test(eb.txn.note) && eb.txn.amount === 260, 'row Fam / "Ben side note" / 260', eb.txn);
    // 4c2: a date change Ben rejects puts Ana's row back on the agreed date
    await T(a, 'ledEdit', cid, { date: '2026-11-17' });
    await flush(X); await T(b, 'reject', cid, 'wrong day'); await flush(X);
    sa = await T(a, 'snap'); ea = ent(sa, cid);
    check('W4.c.rej', '4: Ben rejects a Ledger date change: Ana\'s row goes back to Nov 19 and she is told',
      ea.d === '2026-11-19' && ea.txn.date === '2026-11-19' && /wrong day/.test(ea.rejd), 'row 2026-11-19, rejd', { entry: [ea.d, ea.rejd], row: ea.txn });
    // 4d: Undo of a Ledger edit + reopen
    const before = (await T(a, 'snap'));
    await T(a, 'ledEdit', cid, { category: 'Grocery' });
    const u = await T(a, 'undo');
    sa = await T(a, 'snap');
    check('W4.d.undo', '4: Undo right after a Ledger edit restores the row and the entry', u && ent(sa, cid).txn.category === ent(before, cid).txn.category && ent(sa, cid).cat === ent(before, cid).cat,
      ent(before, cid).txn.category, { undo: u, row: ent(sa, cid).txn, entryCat: ent(sa, cid).cat });
    await reloadBoth(X);
    sa = await T(a, 'snap');
    check('W4.d.reload', '4: rows survive reopening', JSON.stringify(ent(sa, cid).txn) === JSON.stringify(ent(before, cid).txn), JSON.stringify(ent(before, cid).txn), ent(sa, cid).txn);
    // 4e: Ledger date edit while the entry is still pending
    const p = await T(a, 'add', Object.assign({}, BASE, { note: 'pending dated' }));
    await T(a, 'ledEdit', p.cid, { date: '2026-11-18' });
    await flush(X);
    sb = await T(b, 'snap');
    check('W4.e.pending', '4: a Ledger date change on a still-pending entry: Ben is asked to confirm Nov 18, the date Ana\'s money moved',
      inb(sb, p.cid).length === 1 && inb(sb, p.cid)[0].d === '2026-11-18', 'inbox 2026-11-18', inb(sb, p.cid));
    await T(b, 'confirm', p.cid, '', 'Food'); await flush(X);
    // 4f: deleting the linked Ledger row, then a synced change, then a second row deleted + Undo
    const q = await agreed(X, { note: 'row deleted' });
    await T(a, 'ledDel', q);
    await send(X, a);
    sa = await T(a, 'snap'); let eq = ent(sa, q);
    check('W4.f.del', '4: deleting the linked Ledger row keeps the Owed entry, unlinked (no dangling link)', eq && eq.txn === null && eq.amt === 200 && eq.cst === 'ok', 'entry kept, no row', eq);
    await T(b, 'upd', q, { d: '2026-11-20', dir: 'tpf', total: 230, mine: 230, cat: 'Food', note: 'row deleted' });
    await flush(X); await T(a, 'confirm', q, '', ''); await flush(X);
    sa = await T(a, 'snap'); eq = ent(sa, q);
    check('W4.f.stays', '4: a change from Ben, confirmed, does not bring the deleted row back', eq && eq.amt === 230 && eq.txn === null, '230, no row', eq);
    const q2 = await agreed(X, { note: 'row undo' });
    await T(a, 'ledDel', q2); const u2 = await T(a, 'undo');
    sa = await T(a, 'snap');
    check('W4.f.undo', '4: Undo of the Ledger delete links the row again', u2 && ent(sa, q2).txn && ent(sa, q2).txn.amount === 100 && ent(sa, q2).mine === 100, 'row 100 linked', ent(sa, q2));
    await X.agree('W4.agree', a, b, { title: '4: after the Ledger edits both books agree (and each row matches its entry)' });
  } },

  // ---------------- 5: Confirm pickers on an edit to an entry already filed ----------------
  { id: 'W5', run: async (X) => {
    const { a, b, T, check } = X;
    const e = await T(a, 'add', Object.assign({}, BASE, { note: 'picks' }));
    await flush(X);
    const first = await T(b, 'uiConfirm', e.cid, { cat: 'Transpo' });
    await flush(X);
    let sb = await T(b, 'snap');
    check('W5.first', '5: Ben confirms with the real button, picking Transpo', ent(sb, e.cid) && ent(sb, e.cid).cat === 'Transpo' && !first.err, 'Transpo', { shown: first, entry: ent(sb, e.cid) });
    await T(a, 'upd', e.cid, Object.assign({}, BASE, { note: 'picks', theirs: 230, total: 330 }));
    await flush(X);
    const second = await T(b, 'uiConfirm', e.cid);
    await flush(X);
    sb = await T(b, 'snap'); const eb = ent(sb, e.cid);
    check('W5.cat', '5: confirming Ana\'s amount change with the button as shown keeps Ben\'s category (Transpo)',
      eb.cat === 'Transpo' && eb.txn && eb.txn.category === 'Transpo', 'Transpo', { pickerShowed: second, entry: eb.cat, row: eb.txn && eb.txn.category });
    // the account picker: Ana logs "They paid me back" (Ben: "I paid them back", From account)
    const r = await T(a, 'add', { d: '2026-11-20', dir: 'tmb', total: 50, note: 'payback' });
    await flush(X);
    const f1 = await T(b, 'uiConfirm', r.cid, { acc: 'CASH::LandBank' });
    await flush(X);
    sb = await T(b, 'snap');
    check('W5.acc1', '5: Ben confirms the payback from LandBank', ent(sb, r.cid) && /LandBank/.test(ent(sb, r.cid).acc), 'LandBank', { shown: f1, e: ent(sb, r.cid) });
    await T(a, 'upd', r.cid, { d: '2026-11-20', dir: 'tmb', total: 60, note: 'payback' });
    await flush(X);
    const f2 = await T(b, 'uiConfirm', r.cid);
    await flush(X);
    sb = await T(b, 'snap');
    check('W5.acc2', '5: confirming Ana\'s amount change keeps the account Ben paid from (LandBank)', /LandBank/.test(ent(sb, r.cid).acc), 'LandBank', { pickerShowed: f2, e: ent(sb, r.cid) });
    await X.agree('W5.agree', a, b, { title: '5: both books agree after the picker cases' });
  } },

  // ---------------- 6: deletes mixed with edits ----------------
  { id: 'W6', run: async (X) => {
    const { a, b, T, check } = X;
    for (const mode of [{ tag: 'fifo' }, { tag: 'reverse', order: 'reverse' }]) {
      const e = await T(a, 'add', Object.assign({}, BASE, { note: 'gone ' + mode.tag }));
      await send(X, a);
      await T(a, 'upd', e.cid, Object.assign({}, BASE, { note: 'gone ' + mode.tag, theirs: 210, total: 310 }));
      await T(a, 'upd', e.cid, Object.assign({}, BASE, { note: 'gone ' + mode.tag, theirs: 220, total: 320 }));
      const d = await T(a, 'del', e.cid);
      await send(X, a); X.deliver('b', mode); await T(b, 'sync');
      const sb = await T(b, 'snap');
      check('W6.pend.' + mode.tag, '6 (' + mode.tag + '): add, 2 edits, delete before Ben saw any: nothing lands in Ben\'s book or inbox',
        d === 'ok' && !ent(sb, e.cid) && inb(sb, e.cid).length === 0, 'nothing', { del: d, inbox: inb(sb, e.cid) });
    }
    for (const mode of [{ tag: 'fifo' }, { tag: 'reverse', order: 'reverse' }]) {
      const cid = await agreed(X, { note: 'undo del ' + mode.tag });
      await T(a, 'del', cid); const u = await T(a, 'undo');
      await send(X, a); X.deliver('b', mode); await T(b, 'sync'); await flush(X);
      const sa = await T(a, 'snap'), sb = await T(b, 'snap');
      check('W6.undo.' + mode.tag, '6 (' + mode.tag + '): delete + Undo on an agreed entry: both keep it, in sync, no removal card',
        u && ent(sa, cid) && ent(sb, cid) && ent(sa, cid).cst === 'ok' && inb(sb, cid).length === 0, 'kept, in sync', { undo: u, ana: ent(sa, cid), ben: ent(sb, cid), inbox: inb(sb, cid) });
    }
    // edit then delete an agreed entry; Ben answers the removal
    const c2 = await agreed(X, { note: 'edit then del' });
    await T(a, 'upd', c2, Object.assign({}, BASE, { note: 'edit then del', theirs: 330, total: 430 }));
    await T(a, 'del', c2);
    await flush(X);
    let sb = await T(b, 'snap');
    check('W6.editDel.card', '6: edit then delete: Ben sees one removal card for the 200 he agreed to', inb(sb, c2).length === 1 && inb(sb, c2)[0].k === 'del' && inb(sb, c2)[0].amt === 200, '1 del card 200', inb(sb, c2));
    await T(b, 'confirm', c2); await flush(X);
    sb = await T(b, 'snap');
    check('W6.editDel.gone', '6: Ben confirms the removal: gone from his book and Ledger', !ent(sb, c2), 'gone', ent(sb, c2));
    // an edit that arrives AFTER Ben confirmed the removal must not bring it back
    const c3 = await agreed(X, { note: 'late edit' });
    await T(a, 'upd', c3, Object.assign({}, BASE, { note: 'late edit', theirs: 260, total: 360 }));
    await send(X, a); const P = X.MB(); const edit = P.held.b.splice(0, P.held.b.length);
    await T(a, 'del', c3); await send(X, a); X.deliver('b'); await T(b, 'sync');
    await T(b, 'confirm', c3); await flush(X);
    P.box.b.push.apply(P.box.b, edit); await T(b, 'sync'); await flush(X);
    sb = await T(b, 'snap');
    check('W6.late', '6: an edit delivered after the removal was confirmed does not come back', !ent(sb, c3) && inb(sb, c3).length === 0, 'gone', { e: ent(sb, c3), inbox: inb(sb, c3) });
    await X.agree('W6.agree', a, b, { title: '6: both books agree after the delete cases' });
    await reloadBoth(X);
    await X.agree('W6.reload', a, b, { title: '6: ...and after both reopen' });
  } },

  // ---------------- 7: delivery trouble ----------------
  { id: 'W7', run: async (X) => {
    const { a, b, T, check } = X;
    const P = X.MB();
    // relay down: changes queue up, survive a reopen, go out when it is back
    P.down = true;
    const e1 = await T(a, 'add', Object.assign({}, BASE, { note: 'offline 1' }));
    const e2 = await T(a, 'add', Object.assign({}, BASE, { note: 'offline 2', theirs: 90, total: 190 }));
    await T(a, 'upd', e1.cid, Object.assign({}, BASE, { note: 'offline 1', theirs: 120, total: 220 }));
    await send(X, a);
    let sa = await T(a, 'snap');
    check('W7.down.queue', '7: relay down: 3 changes wait in Ana\'s outbox with an error noted', sa.out >= 3 && !!sa.err, '>=3 queued + err', { out: sa.out, err: sa.err });
    await X.reload(a);
    sa = await T(a, 'snap');
    check('W7.down.reopen', '7: the outbox survives Ana reopening the app', sa.out >= 3, '>=3', sa.out);
    P.down = false;
    await flush(X);
    let sb = await T(b, 'snap');
    check('W7.down.back', '7: back online: Ben gets both entries, the first at its edited 120',
      inb(sb, e1.cid).length === 1 && inb(sb, e1.cid)[0].amt === 120 && inb(sb, e2.cid).length === 1, 'two items, 120 + 90', sb.inb);
    // reopen between every step
    await X.reload(b);
    await T(b, 'confirm', e1.cid, '', 'Food'); await X.reload(b);
    await T(b, 'confirm', e2.cid, '', 'Food'); await X.reload(b);
    await flush(X); await X.reload(a);
    await X.agree('W7.reopen', a, b, { title: '7: confirming with a reopen between every step: both agree' });
    // a lost message: the relay accepts it and it never arrives
    const e3 = await T(a, 'add', Object.assign({}, BASE, { note: 'lost' }));
    await send(X, a); X.dropHeld('b');
    for (let i = 0; i < 2; i++) { await flush(X); await X.reload(a); }
    await a.clock.fastForward('16:00'); await flush(X); // v75.45: a change still waiting after 15 min goes again
    sa = await T(a, 'snap'); sb = await T(b, 'snap');
    check('W7.lost', '7: a message the relay lost: Ana\'s app resends, or the entry shows it never arrived',
      inb(sb, e3.cid).length === 1 || /resend|not delivered|never/i.test(ent(sa, e3.cid).why || ''), 'resent or flagged',
      { ana: ent(sa, e3.cid), benInbox: inb(sb, e3.cid) }, 'low');
    await T(b, 'confirm', e3.cid, '', 'Food'); await flush(X);
    // Ben offline for a long stretch while Ana makes 10 changes over 5 entries
    P.down = true;
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await T(a, 'add', Object.assign({}, BASE, { note: 'batch ' + i, theirs: 10 + i, total: 110 + i }))).cid);
    for (let i = 0; i < 5; i++) await T(a, 'upd', ids[i], Object.assign({}, BASE, { note: 'batch ' + i + ' edited', theirs: 20 + i, total: 120 + i }));
    await send(X, a); P.down = false; await flush(X);
    sb = await T(b, 'snap');
    const got = ids.map((c) => inb(sb, c)).filter((x) => x.length === 1 && /edited/.test(x[0].note)).length;
    check('W7.long', '7: after a long offline stretch Ben has 5 items, each at its edited version', got === 5, '5', got + ' of 5: ' + JSON.stringify(sb.inb.map((x) => [x.note, x.amt])));
    for (const c of ids) await T(b, 'confirm', c, '', 'Food');
    await flush(X);
    await X.agree('W7.agree', a, b, { title: '7: both books agree after the batch and the resent entry' });
  } },

  // ---------------- 8: Ana's second phone (restored from her backup) ----------------
  { id: 'W8', run: async (X) => {
    const { a, b, T, check } = X;
    const cid = await agreed(X, { note: 'two phones' });
    const bk = await a.evaluate(() => { const s = window.FinApp.state; return { app: 'finances-pwa', base: s.base, txns: s.txns, plans: s.plans, adj: s.adj, adjSig: s.adjSig, moneyLog: s.moneyLog, owed: s.owed.people, owedSort: s.owed.sort }; }); // the export's shape
    const C = require('./stress_core');
    const f = path.join(C.OUT, 'w8_ana_backup.json'); fs.writeFileSync(f, JSON.stringify(bk));
    const A2 = await C.fresh({ time: '2026-11-20T10:00:00+08:00', seedFile: f, onCtx: X.wireCtx });
    const a2 = A2.pg; a2.who = 'Ana2';
    try {
      let s2 = await T(a2, 'snap');
      check('W8.restore', '8: Ana\'s second phone restored from her backup keeps the link and the agreed entry', s2 && s2.st === 'linked' && ent(s2, cid) && ent(s2, cid).cst === 'ok', 'linked + entry ok', s2 && { st: s2.st, e: ent(s2, cid) });
      // sequential: Ana2 proposes 270, Ben confirms; the "ok" lands on whichever of Ana's phones reads the mailbox first
      await T(a2, 'upd', cid, Object.assign({}, BASE, { note: 'two phones', theirs: 270, total: 370 }));
      await T(a2, 'sync', 1); X.deliver('b'); await T(b, 'sync');
      await T(b, 'confirm', cid, '', 'Food'); await T(b, 'sync', 1); X.deliver('a');
      await T(a2, 'sync'); await T(a, 'sync');
      const sa = await T(a, 'snap'); s2 = await T(a2, 'snap'); const sb = await T(b, 'snap');
      check('W8.seq', '8: an edit from the second phone, confirmed by Ben: Ana\'s first phone learns it too (via cloud sync in real life; not simulated here)',
        ent(sa, cid).amt === 270 && ent(s2, cid).amt === 270 && ent(sb, cid).amt === 270, 'all three 270',
        { ana: ent(sa, cid).amt, ana2: ent(s2, cid).amt, ben: ent(sb, cid).amt }, 'info');
      // concurrent: both of Ana's phones propose different amounts from the same version
      await T(a, 'upd', cid, Object.assign({}, BASE, { note: 'two phones', theirs: 111, total: 211 }));
      await T(a2, 'upd', cid, Object.assign({}, BASE, { note: 'two phones', theirs: 122, total: 222 }));
      await T(a, 'sync', 1); await T(a2, 'sync', 1); X.deliver('b'); await T(b, 'sync');
      const ib = inb(await T(b, 'snap'), cid);
      await T(b, 'confirm', cid, '', 'Food'); await T(b, 'sync', 1); X.deliver('a');
      await T(a, 'sync'); await T(a2, 'sync'); await T(a, 'sync');
      const xa = ent(await T(a, 'snap'), cid), x2 = ent(await T(a2, 'snap'), cid), xb = ent(await T(b, 'snap'), cid);
      check('W8.conc', '8: both of Ana\'s phones propose at once (111 vs 122): no phone shows a value Ben did not confirm as in sync',
        [xa, x2].every((x) => x.cst !== 'ok' || x.amt === xb.amt), 'any "in sync" phone matches Ben',
        { benInbox: ib.map((x) => x.amt), ben: xb.amt, ana: [xa.amt, xa.cst, xa.draft && xa.draft.amt], ana2: [x2.amt, x2.cst, x2.draft && x2.draft.amt] });
    } finally { try { await A2.ctx.close(); } catch (e) {} try { fs.unlinkSync(f); } catch (e) {} }
  } }
];
