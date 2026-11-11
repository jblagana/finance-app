// Fin.AI stress harness — core. Real app in headless Chromium, fresh profile per scenario.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
function serve(root) {
  return new Promise((res) => {
    const srv = http.createServer((q, r) => {
      let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
      const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
    }).listen(0, () => res(srv));
  });
}

const RESULTS = [];
function rec(o) { // { area, id, title, expected, observed, pass, sev }
  o.pass = !!o.pass;
  RESULTS.push(o);
  console.log((o.pass ? 'PASS ' : 'FAIL ') + '[' + o.area + ' ' + o.id + '] ' + o.title + (o.pass ? '' : '\n      expected: ' + o.expected + '\n      observed: ' + o.observed));
}

let browser, srv, base;
async function boot(appDir) {
  srv = await serve(appDir);
  base = 'http://localhost:' + srv.address().port + '/';
  const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1248/chrome-win64/chrome.exe');
  browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined });
}
async function shutdown() { try { await browser.close(); } catch (e) {} try { srv.close(); } catch (e) {} }

const os = require('os');
const OUT = process.env.STRESS_OUT || path.join(os.tmpdir(), 'fin-stress'); fs.mkdirSync(OUT, { recursive: true });
// the seed: the repo's smoke export (your Oct data) + the app marker the import expects
const SEED = path.join(OUT, 'seed.json');
if (!fs.existsSync(SEED)) { const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'smoke', 'smoke_seed.json'), 'utf8')); s.app = 'finances-pwa'; fs.writeFileSync(SEED, JSON.stringify(s)); }
// a fresh app: new profile, optional pinned clock, the seed imported through the real file input
async function fresh(opts) {
  opts = opts || {};
  const ctx = await browser.newContext({
    viewport: opts.vp || { width: 390, height: 844 }, deviceScaleFactor: 1,
    colorScheme: opts.theme || 'dark', serviceWorkers: 'block',
    timezoneId: opts.tz || 'Asia/Manila', hasTouch: !!opts.touch, isMobile: !!opts.mobile
  });
  const pg = await ctx.newPage();
  pg.errs = []; pg.dialogs = [];
  pg.on('pageerror', (e) => pg.errs.push(String(e.message).slice(0, 200)));
  pg.on('dialog', (d) => { pg.dialogs.push(d.type() + ': ' + d.message().slice(0, 160)); (opts.dismiss ? d.dismiss() : d.accept()).catch(() => {}); });
  if (opts.time) await pg.clock.install({ time: new Date(opts.time) });
  await pg.goto(base);
  await pg.waitForFunction(() => window.FinApp && window.FinApp.state, null, { timeout: 20000 });
  await pg.waitForTimeout(2200);
  if (opts.seed !== false) {
    await pg.setInputFiles('#impFile', opts.seedFile || SEED);
    await pg.waitForTimeout(1200);
    await pg.waitForFunction(() => window.FinApp.state.txns.length > 0, null, { timeout: 10000 }).catch(() => {});
  }
  await closeAll(pg);
  await pg.evaluate(() => { if (window.FinApp.hideSnack) window.FinApp.hideSnack(); }).catch(() => {}); // the "Imported … Undo" toast is setup, not part of a test
  pg.dialogs = []; // import chatter is not a finding
  return { ctx, pg };
}
async function closeAll(pg) {
  await pg.evaluate(() => {
    const sc = document.getElementById('scrim'); if (sc && sc.classList.contains('show')) sc.click();
    const s = document.getElementById('snack'); if (s) { const b = s.querySelector('[data-x], .snack-x'); if (b) b.click(); }
  }).catch(() => {});
  await pg.waitForTimeout(300);
}
async function hideSnack(pg) { await pg.evaluate(() => { const s = document.getElementById('snack'); if (s) s.classList.remove('show'); }); }

// the invariants (what "correct" means everywhere)
async function inv(pg, tag) {
  const v = await pg.evaluate(() => {
    const F = window.FinApp, out = [];
    const e = F.effectiveSnap && F.effectiveSnap();
    if (!e) return ['no snapshot'];
    const fin = (x) => typeof x === 'number' && isFinite(x);
    if (![e.cash.total, e.cash.free, e.card_owed].every(fin)) out.push('a core number is not a number (liquid/free/owed)');
    const bc = e.budget_credit || 0;
    if (Math.abs(e.cash.free - (e.cash.total - e.card_owed + bc)) > 0.02) out.push('free ' + e.cash.free + ' != liquid ' + e.cash.total + ' − owed ' + e.card_owed + (bc ? ' + budget credit ' + bc : ''));
    const sc = (e.cards || []).reduce((s, c) => s + (Number(c.balance) || 0), 0);
    if (Math.abs(sc - e.card_owed) > 0.02) out.push('the cards add up to ' + sc.toFixed(2) + ' but cards owed says ' + e.card_owed);
    const st = F.state, names = new Set((st.base.accounts || []).map((a) => a.name)); names.add('Cash');
    Object.keys((st.adj && st.adj.rebaseBy) || {}).forEach((k) => names.add(k)); // a deliberately removed account: its entries are history (v74.52)
    const ids = new Set(); let orphan = {};
    st.txns.forEach((t) => {
      if (ids.has(t.id)) out.push('duplicate entry id ' + t.id); ids.add(t.id);
      if (!fin(Number(t.amount))) out.push('entry amount is not a number: ' + t.note);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) out.push('entry has a bad date: ' + t.date);
      if (t.account && !names.has(t.account)) orphan[t.account] = (orphan[t.account] || 0) + 1;
    });
    Object.keys(orphan).forEach((k) => out.push(orphan[k] + ' ledger entries point at an account that no longer exists: ' + k));
    const txt = document.body.innerText;
    const m = txt.match(/\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/);
    if (m) { const i = txt.indexOf(m[0]); out.push('the screen shows "' + m[0] + '": …' + txt.slice(Math.max(0, i - 50), i + 25).replace(/\n/g, ' ') + '…'); }
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push('the page scrolls sideways (' + document.documentElement.scrollWidth + 'px wide on a ' + window.innerWidth + 'px screen)');
    return out;
  });
  if (pg.errs.length) v.push('JavaScript errors: ' + Array.from(new Set(pg.errs)).slice(0, 3).join(' | '));
  return v;
}
async function heroCheck(pg) {
  await pg.waitForTimeout(1300); // the count-up
  return pg.evaluate(() => {
    const F = window.FinApp, d = F.insightsData(); const el = document.getElementById('heroFree');
    if (!d || !el) return null;
    const shown = Number(String(el.textContent).replace(/[^0-9.\-]/g, ''));
    return { shown, want: Math.round(d.freeNet * 100) / 100 };
  });
}
const S = (pg, fn, arg) => pg.evaluate(fn, arg); // shorthand
module.exports = { OUT, SEED, boot, shutdown, fresh, closeAll, hideSnack, inv, heroCheck, rec, RESULTS, S };
