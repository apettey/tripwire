// Renders the Mermaid flowcharts once in headless Chrome and writes fleet-rolling-card.html with static inline SVGs.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
// Inputs next to this script; temp files (cards.json, build.html, fleet-rolling-card.html, Chrome profile) in build/
const DIR = path.dirname(fileURLToPath(import.meta.url)), OUT = path.join(DIR, 'build');
const cards = JSON.parse(readFileSync(path.join(OUT, 'cards.json'), 'utf8'));
const head = readFileSync(path.join(DIR, 'fleet-head.html'), 'utf8');
const e = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const card = (c, i) => `
  <article class="hole${c.N >= 3000 ? ' wide' : ''}" data-i="${i}" aria-label="${c.mass}${c.unit} hole">
    <div class="hole-head">
      <div><div class="mass">${c.mass}<small>${c.unit} kg</small></div><div class="sub">Max jump ${e(c.jump)}</div></div>
      <div class="stats">
        <span class="stat fleet">Fleet <b>${c.nB} BS${c.nH ? ' + ' + c.nH + ' HIC' : ''}</b></span>
        <span class="stat">Waves <b>${c.waves}</b></span>
        <span class="stat">Jumps <b>${c.jumps}</b></span>
      </div>
    </div>
    <p class="codes-note">${e(c.sub)}</p>
    <div class="codes">${c.codes.map(x => `<span class="code">${x[0]} <span>${e(x[1])}</span></span>`).join('')}</div>
    <div class="flow"><pre class="mermaid">${e(c.mermaid)}</pre></div>
    ${c.alt ? `<p class="alt"><b>Short on time?</b> ${e(c.alt)}</p>` : ''}
  </article>`;
const poster = `<div id="poster">
  <header>
    <div>
      <div class="eyebrow">Wormhole rolling · Fleets of up to 6</div>
      <h1>Fleet <span class="hot">Rolling</span> <span class="cold">Card</span></h1>
      <p class="lede">The fastest safe way to roll each battleship-sized hole with up to six characters. Each plan ends with everyone home for any real hole mass in the ±10% range, with at least 10,000 t to spare on every jump.</p>
    </div>
    <div class="ships" role="table" aria-label="Ships">
      <span class="hd">Ship</span><span class="hd" style="text-align:right">Cold</span><span class="hd" style="text-align:right">Hot</span>
      <span class="nm">Battleship</span><span class="c">200,000 t</span><span class="h">300,000 t</span>
      <span class="nm">HIC <span style="color:var(--muted);font-weight:500;font-size:12px">100MN MWD</span></span><span class="c">15,000 t</span><span class="h">65,000 t</span>
    </div>
  </header>
  <section class="rules" aria-label="How to read the card">
    <div class="rule key">
      <h2>Key</h2>
      <div class="row"><span class="sw out"></span>Out wave: the ships listed jump out, the rest stay home</div>
      <div class="row"><span class="sw back"></span>Back wave: everyone on the far side comes home</div>
      <div class="row"><span class="sw check"></span>Check: Show Info on the hole, follow the matching arrow</div>
      <div class="row"><span class="sw done"></span>Done: the hole closed behind the last ship</div>
    </div>
    <div class="rule">
      <h2>Rules</h2>
      <ul>
        <li>Start on a <b>fresh hole</b>: stable, nothing through it yet.</li>
        <li>A <b>wave</b> is one jump per ship. Wait out polarisation before the next one.</li>
        <li>In a back wave, jump <b>in the order shown</b>, lightest first. Only the last ship can close the hole.</li>
        <li><b>Hot</b>: prop mod running as you jump. <b>Cold</b>: prop mod off.</li>
      </ul>
    </div>
    <div class="rule">
      <h2>Hole states</h2>
      <ul>
        <li><b style="color:var(--ok)">Stable</b>: half or more of its mass left</li>
        <li><b style="color:var(--warn)">Reduced</b>: under half left, not critical</li>
        <li><b style="color:#ff5c7a">Critical</b>: under 10% left</li>
        <li><b>Closed</b>: it collapsed on the last jump home. You're done.</li>
      </ul>
    </div>
  </section>
  <section class="holes" aria-label="Plans by hole size">${cards.map(card).join('')}
  </section>
  <footer>
    <p><b>Check your ship masses.</b> The plans assume 200,000 t / 300,000 t battleships and a 15,000 t / 65,000 t HIC. A heavier fit eats the safety margin, so weigh it before rolling.</p>
    <p><b>Hole already used?</b> Once anything has gone through, these numbers no longer apply. Log the jumps and open the hole's mass dialog in Tripwire: <b>How to roll this hole</b> plans from the logged mass and the current state.</p>
    <p>K162s take the type of the hole's other side. Hole masses come from Tripwire's wormhole table. Every plan was checked jump by jump against every hole mass in its range.</p>
  </footer>
</div>`;
const only = `<script>
// ?only=N shows one hole (used to export one image per hole size)
(function () {
  var only = null; try { only = new URLSearchParams(location.search).get("only"); } catch (e) {}
  if (only === null) return;
  document.body.classList.add("single");
  document.querySelectorAll(".hole").forEach(function (h) { if (h.getAttribute("data-i") !== only) h.hidden = true; });
  var card = document.querySelector('.hole[data-i="' + only + '"]');
  var m = card.querySelector(".mass").childNodes[0].textContent + card.querySelector(".mass small").textContent.split(" ")[0];
  document.querySelector("h1").innerHTML = "Rolling a <span class='hot'>" + m + "</span> <span class='cold'>hole</span>";
})();
</script>`;
const mermaidInit = `<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script>
mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'loose',
  themeVariables: { background: '#111a2e', primaryColor: '#172340', primaryTextColor: '#e7ecf7', primaryBorderColor: '#93a0bf',
    lineColor: '#93a0bf', textColor: '#e7ecf7', edgeLabelBackground: '#172340', fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif', fontSize: '15px' },
  flowchart: { curve: 'basis', htmlLabels: true, nodeSpacing: 28, rankSpacing: 38, padding: 12, useMaxWidth: true } });
document.fonts.ready.then(() => mermaid.run({ querySelector: '.mermaid' })).then(() => { window.__done = true; }, err => { window.__err = String(err); });
</script>`;
writeFileSync(path.join(OUT, 'build.html'), '<!doctype html><html><head><meta charset="utf-8">' + head + '</head><body>' + poster + mermaidInit + '</body></html>');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(OUT, 'chrome-prof2'), 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target; for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch('http://127.0.0.1:9334/json')).json()).find(t => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result.result.value;
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(path.join(OUT, 'build.html')).href });
for (let i = 0; i < 100; i++) { await sleep(300); if (await ev('window.__done || window.__err')) break; }
const err = await ev('window.__err'); if (err) { console.error(err); process.exit(1); }
// keep the rendered SVGs, drop the Mermaid source wrappers
const html = await ev(`document.querySelectorAll('pre.mermaid').forEach(p => { const svg = p.querySelector('svg'); svg.setAttribute('width', '100%'); p.replaceWith(svg); }); document.getElementById('poster').outerHTML`);
writeFileSync(path.join(OUT, 'fleet-rolling-card.html'), head + '\n' + html + '\n' + only + '\n');
console.log('svgs', (html.match(/<svg/g) || []).length, 'bytes', html.length);
ws.close(); proc.kill();
