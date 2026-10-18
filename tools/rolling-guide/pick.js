// Best fleet (<= 6 characters, <= 2 HICs) for one hole: zero stranding risk first, then fewest waves, characters, jumps.
// Writes fleet-<N>.json with the plan tree, plus the fastest battleship-only alternative.
const { solve } = require('./fleet2.js');
const N = +process.argv[2], rows = [];
for (let nH = 0; nH <= +(process.env.MAXH || 2); nH++) for (let nB = 1; nB + nH <= 6; nB++) { const r = solve(N, nB, nH); rows.push({ nB, nH, risk: r.risk, waves: r.waves, jumps: r.jumps, r }); }
const key = x => [x.risk > 1e-6 ? 1 : 0, x.waves, x.nB + x.nH, x.jumps];
const cmp = (a, b) => { const A = key(a), B = key(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return A[i] - B[i]; return 0; };
rows.sort(cmp);
const best = rows[0];
const bsOnly = rows.filter(x => x.nH === 0).sort((a, b) => a.waves - b.waves || a.nB - b.nB || a.risk - b.risk)[0];
const strip = n => JSON.parse(JSON.stringify(n, (k, v) => k === 'l' || k === 'h' ? Math.round(v) : v));
require('fs').writeFileSync(require('path').join(__dirname, 'fleet-' + N + '.json'), JSON.stringify({ N, LO: best.r.LO, HI: best.r.HI,
  best: { nB: best.nB, nH: best.nH, waves: best.waves, jumps: best.jumps, risk: best.risk, tree: strip(best.r.tree) },
  fast: { nB: bsOnly.nB, nH: 0, waves: bsOnly.waves, risk: bsOnly.risk, tree: strip(bsOnly.r.tree) } }));
console.log(N, 'best', best.nB + 'BS+' + best.nH + 'HIC', 'waves', best.waves, 'jumps', best.jumps, 'risk', best.risk.toFixed(4), '| BS-only fastest', bsOnly.nB + 'BS waves', bsOnly.waves, 'risk', (100 * bsOnly.risk).toFixed(2) + '%');
