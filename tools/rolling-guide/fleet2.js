// Fleet rolling by waves. Out wave: any subset of the fleet jumps out (each hot or cold). Back wave: everyone who went
// out comes home, lightest first, so only the last (heaviest) return can close the hole. The hole is checked after
// every wave (from the far side after an out wave, from home after a back wave).
// Objective: stranding risk (T uniform over the +-10% range, with a safety margin M), then waves, then jumps.
const B = [200, 300], H = [15, 65], M = +(process.env.MARGIN || 10);
function solve(N, nB, nH) {
  const LO = Math.round(0.9 * N), HI = Math.round(1.1 * N), W = HI - LO;
  const split = (lo, hi, U) => { const p = []; const cut = (a, b, s) => { const l = Math.max(lo, a), h = Math.min(hi, b); if (h > l + 1e-9) p.push([l, h, s]); };
    cut(-1e9, U / 0.9, 'critical'); cut(U / 0.9, 2 * U, 'reduced'); cut(2 * U, 1e9, 'stable'); return p; };
  const better = (a, b) => !b || a.p < b.p - 1e-6 || (Math.abs(a.p - b.p) < 1e-6 && (a.w < b.w || (a.w == b.w && (a.j < b.j || (a.j == b.j && a.ships < b.ships)))));
  // out-wave options
  const outs = [];
  for (let bh = 0; bh <= nB; bh++) for (let bc = 0; bh + bc <= nB; bc++) for (let hh = 0; hh <= nH; hh++) for (let hc = 0; hh + hc <= nH; hc++) {
    if (bh + bc + hh + hc === 0) continue; outs.push({ bh, bc, hh, hc, m: bh * B[1] + bc * B[0] + hh * H[1] + hc * H[0] }); }
  const mh = new Map(), mf = new Map();
  function home(lo, hi, U) { // all home, hole open
    const k = lo.toFixed(2) + ',' + hi.toFixed(2) + ',' + U; if (mh.has(k)) return mh.get(k);
    let best = null;
    for (const o of outs) {
      const V = U + o.m, strand = Math.max(0, Math.min(hi, V + M) - lo); if (strand >= hi - lo - 1e-9) continue;
      if (strand > 0 && best && best.p === 0) continue;
      let p = strand, w = 0, j = 0, kids = [];
      for (const [l, h, s] of split(Math.max(lo, V), hi, V)) { const f = far(l, h, V, o); kids.push({ s, l, h, f }); p += f.p; w = Math.max(w, f.w); j = Math.max(j, f.j); }
      const c = { p, w: w + 1, j: j + o.bh + o.bc + o.hh + o.hc, ships: o.bh + o.bc + o.hh + o.hc, o, kids, strand };
      if (better(c, best)) best = c;
    }
    if (!best) best = { p: hi - lo, w: 0, j: 0, ships: 0, stuck: true };
    mh.set(k, best); return best;
  }
  function far(lo, hi, U, o) { // the out-wave ships are on the far side
    const k = lo.toFixed(2) + ',' + hi.toFixed(2) + ',' + U + ',' + [o.bh, o.bc, o.hh, o.hc]; if (mf.has(k)) return mf.get(k);
    const nb = o.bh + o.bc, nh = o.hh + o.hc; let best = null;
    for (let rbh = 0; rbh <= nb; rbh++) for (let rhh = 0; rhh <= nh; rhh++) {
      const list = []; for (let i = 0; i < nb; i++) list.push(i < rbh ? B[1] : B[0]); for (let i = 0; i < nh; i++) list.push(i < rhh ? H[1] : H[0]);
      list.sort((a, b) => a - b); const total = list.reduce((a, b) => a + b, 0), prefix = total - list[list.length - 1];
      // a collapse before the last ship is home strands the ones still out
      const strand = list.length > 1 ? Math.max(0, Math.min(hi, U + prefix + M) - lo) : 0;
      if (strand >= hi - lo - 1e-9) continue;
      const V = U + total; let p = strand, w = 1, j = list.length, kids = [];
      if (V < hi) for (const [l, h, s] of split(Math.max(lo, V), hi, V)) { const n = home(l, h, V); kids.push({ s, l, h, n }); p += n.p; w = Math.max(w, 1 + n.w); j = Math.max(j, list.length + n.j); }
      const c = { p, w, j, ships: 0, back: list, rbh, rhh, nb, nh, kids, strand, closesAll: V >= hi, mayClose: V > lo };
      if (better(c, best)) best = c;
    }
    if (!best) best = { p: hi - lo, w: 0, j: 0, ships: 0, stuck: true };
    mf.set(k, best); return best;
  }
  const r = home(LO, HI, 0);
  return { risk: r.p / W, waves: r.w, jumps: r.j, tree: r, W, LO, HI };
}
module.exports = { solve };
if (require.main === module) {
  const N = +process.argv[2];
  for (let nH = 0; nH <= 2; nH++) for (let nB = 1; nB + nH <= 6; nB++) { const t0 = Date.now(); const r = solve(N, nB, nH);
    console.log(`${N} B${nB} H${nH}: risk ${(100 * r.risk).toFixed(2)}% waves ${r.waves} jumps ${r.jumps} (${Date.now() - t0}ms)`); }
}
