// Independent check: walk each fleet plan jump by jump for every hole mass T in [0.9N, 1.1N] (0.1 kt steps).
for (const N of [750, 1000, 2000, 3000, 3300, 5000]) {
  const d = require('./fleet-' + N + '.json'); const res = { home: 0, strand: 0, open: 0, bad: 0 }; let headOut = 1e9, headBack = 1e9, maxW = 0;
  for (let T = 0.9 * N; T <= 1.1 * N + 1e-9; T += 0.1) {
    let U = 0, r = null, w = 0;
    const state = () => { const f = (T - U) / T; return f < 0.1 ? 'critical' : f < 0.5 ? 'reduced' : 'stable'; };
    let n = d.best.tree;
    for (;;) {
      if (n.stuck) { r = 'open'; break; }
      const o = n.o; w++; if (U + o.m >= T) { r = 'strand'; break; } U += o.m; headOut = Math.min(headOut, T - U);
      const fk = n.kids.length === 1 ? n.kids[0] : n.kids.find(k => k.s === state()); if (!fk) { r = 'bad'; break; }
      const f = fk.f; w++;
      for (let i = 0; i < f.back.length && !r; i++) { U += f.back[i]; if (i === f.back.length - 2) headBack = Math.min(headBack, T - U); if (U >= T) r = i === f.back.length - 1 ? 'home' : 'strand'; }
      if (r) break;
      if (!f.kids.length) { r = 'open'; break; }
      const hk = f.kids.length === 1 ? f.kids[0] : f.kids.find(k => k.s === state()); if (!hk) { r = 'bad'; break; }
      n = hk.n;
    }
    res[r]++; maxW = Math.max(maxW, w);
  }
  console.log(N, d.best.nB + ' BS + ' + d.best.nH + ' HIC', res, 'waves', maxW, 'min headroom out', headOut.toFixed(1), 'back', headBack.toFixed(1));
}
