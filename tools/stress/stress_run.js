const C = require('./stress_core');
const fs = require('fs'), path = require('path');
(async () => {
  const app = process.argv[2], groups = (process.argv[3] || 'a').split(',');
  await C.boot(app);
  const t0 = Date.now();
  for (const g of groups) {
    try { await require('./stress_' + g)(); }
    catch (e) { C.rec({ area: g.toUpperCase(), id: 'harness', title: 'group ' + g + ' crashed', expected: 'runs', observed: String(e && e.stack || e).slice(0, 400), pass: false, sev: 'harness' }); }
  }
  await C.shutdown();
  const out = path.join(C.OUT, 'results_' + groups.join('') + '.json');
  fs.writeFileSync(out, JSON.stringify(C.RESULTS, null, 1));
  const f = C.RESULTS.filter((r) => !r.pass);
  console.log('\n== ' + C.RESULTS.length + ' checks, ' + f.length + ' failed, ' + Math.round((Date.now() - t0) / 1000) + 's -> ' + out);
})();
