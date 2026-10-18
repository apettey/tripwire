// Screenshots the poster with headless Chrome over the DevTools protocol: full poster + one image per hole.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
// Reads build/fleet-rolling-card.html (build.mjs); writes public/images/rolling-guide/<size>.png and poster.png
const DIR = path.dirname(fileURLToPath(import.meta.url)), OUT = path.join(DIR, 'build');
const IMG = path.join(DIR, '..', '..', 'public', 'images', 'rolling-guide');
mkdirSync(IMG, { recursive: true });
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const page = pathToFileURL(path.join(OUT, 'fleet-rolling-card.html')).href;
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + path.join(OUT, 'chrome-prof'), '--hide-scrollbars', 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(t => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
async function shot(url, file, width) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url }); await sleep(2500);
  const h = (await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true })).result.result.value;
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } });
  writeFileSync(path.join(IMG, file), Buffer.from(r.result.data, 'base64')); console.log(file, width + 'x' + h);
}
const names = ['750m', '1b', '2b', '3b', '3-3b', '5b'];
const pick = process.argv[2];
if (pick === undefined) await shot(page, 'poster.png', 1280);
for (let i = 0; i < names.length; i++) if (pick === undefined || String(i) === pick) await shot(page + '?only=' + i, names[i] + '.png', 1100);
ws.close(); proc.kill();
