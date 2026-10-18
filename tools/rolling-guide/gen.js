// Builds build/cards.json (read by build.mjs): one card per hole size with its Mermaid flowchart, generated from the fleet plans.
const fs = require('fs'), path = require('path');
// Inputs next to this script; cards.json goes to the git-ignored build/ folder (build.mjs reads it)
const DIR = __dirname, OUT = path.join(DIR, 'build');
fs.mkdirSync(OUT, { recursive: true });
const old = fs.readFileSync(path.join(DIR, 'battleship-rolling-card.html'), 'utf8');
const HOLES = eval(old.slice(old.indexOf('const HOLES =') + 13, old.indexOf('const STATE_NOTE')).trim().replace(/;$/, ''));
const NS = [750, 1000, 2000, 3000, 3300, 5000];
const ship = m => ({ 15: 'HIC cold', 65: 'HIC hot', 200: 'BS cold', 300: 'BS hot' })[m];
const groupList = arr => { const out = []; for (const x of arr) { const l = out[out.length - 1]; if (l && l.x === x) l.n++; else out.push({ x, n: 1 }); } return out; };
const esc = s => s.replace(/"/g, '#quot;');
function chart(d) {
  let id = 0; const lines = ['flowchart TD'], nid = () => 'n' + (++id);
  const start = nid(), done = 'done';
  const fleet = [d.best.nB && d.best.nB + ' battleship' + (d.best.nB > 1 ? 's' : ''), d.best.nH && d.best.nH + ' HIC'].filter(Boolean).join(' + ');
  lines.push(`${start}(["Fleet home<br/>${fleet}"]):::start`);
  lines.push(`${done}(["Hole closed<br/>everyone home"]):::done`);
  const stateLabel = { stable: 'Stable', reduced: 'Reduced', critical: 'Critical' };
  function home(n, wave, from, label) {
    const o = n.o, me = nid();
    const parts = [o.bh && o.bh + ' × BS hot', o.bc && o.bc + ' × BS cold', o.hh && o.hh + ' × HIC hot', o.hc && o.hc + ' × HIC cold'].filter(Boolean);
    lines.push(`${me}["<b>Wave ${wave} · OUT</b><br/>${parts.join('<br/>')}"]:::out`);
    lines.push(`${from} -->${label ? '|' + label + '|' : ''} ${me}`);
    if (n.kids.length === 1) far(n.kids[0].f, wave + 1, me, '');
    else { const q = nid(); lines.push(`${q}{"Hole state?<br/>check from far side"}:::check`); lines.push(`${me} --> ${q}`);
      n.kids.forEach(k => far(k.f, wave + 1, q, stateLabel[k.s])); }
  }
  function far(f, wave, from, label) {
    const me = nid(), g = groupList(f.back);
    const order = g.map((x, i) => (x.n > 1 ? x.n + ' × ' : '') + ship(x.x) + (i === g.length - 1 && g.length > 1 ? ' (last)' : '')).join('<br/>then ');
    lines.push(`${me}["<b>Wave ${wave} · BACK</b>${g.length > 1 ? ' · in this order' : ''}<br/>${order}"]:::back`);
    lines.push(`${from} -->${label ? '|' + label + '|' : ''} ${me}`);
    if (f.closesAll || !f.kids.length) { lines.push(`${me} --> ${done}`); return; }
    if (f.kids.length === 1 && !f.mayClose) { home(f.kids[0].n, wave + 1, me, ''); return; }
    const q = nid(); lines.push(`${q}{"Hole state?<br/>check from home"}:::check`); lines.push(`${me} --> ${q}`);
    if (f.mayClose) lines.push(`${q} -->|Closed| ${done}`);
    f.kids.forEach(k => home(k.n, wave + 1, q, f.kids.length > 1 ? stateLabel[k.s] : 'Still open'));
  }
  home(d.best.tree, 1, start, '');
  lines.push('classDef start fill:#172340,stroke:#93a0bf,color:#e7ecf7');
  lines.push('classDef done fill:#12352a,stroke:#6fe3a5,color:#e7ecf7,stroke-width:2px');
  lines.push('classDef out fill:#2a1a10,stroke:#ff8b3d,color:#e7ecf7,stroke-width:2px');
  lines.push('classDef back fill:#0f2638,stroke:#6fcbff,color:#e7ecf7,stroke-width:2px');
  lines.push('classDef check fill:#231a3d,stroke:#c3a5ff,color:#e7ecf7,stroke-width:2px');
  return lines.join('\n');
}
const cards = NS.map((N, i) => {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, 'fleet-' + N + '.json'), 'utf8')), h = HOLES[i];
  const chars = d.best.nB + d.best.nH;
  const alt = d.fast.risk > 0 && d.fast.waves < d.best.waves ? `Fastest with battleships only: ${d.fast.nB} BS in ${d.fast.waves} waves, but with no spare margin (it can strand a ship if the hole spawned at the edge of its range). The HIC removes that risk.` : '';
  return { N, h, d, chars, mermaid: chart(d), alt };
});
fs.writeFileSync(path.join(OUT, 'cards.json'), JSON.stringify(cards.map(c => ({ N: c.N, mass: c.h.mass, unit: c.h.unit, jump: c.h.jump, sub: c.h.sub, codes: c.h.codes, nB: c.d.best.nB, nH: c.d.best.nH, waves: c.d.best.waves, jumps: c.d.best.jumps, alt: c.alt, mermaid: c.mermaid }))));
console.log(cards.map(c => c.N + ': ' + c.mermaid.split('\n').length + ' lines').join(', '));
console.log(cards[3].mermaid);
