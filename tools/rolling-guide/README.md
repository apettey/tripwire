# Rolling guide images

Offline scripts that made the fleet rolling flowcharts in `public/images/rolling-guide/` (one PNG per hole size,
`750m.png` `1b.png` `2b.png` `3b.png` `3-3b.png` `5b.png`, plus `poster.png` with all of them). The app only shows
those PNGs (Rolling guide panel, `app/js/fork/rolling-guide.js`); nothing here runs in Tripwire or the Docker image.

## The model

- Battleship 200,000 t cold / 300,000 t hot; HIC 15,000 t cold / 65,000 t hot (the masses each pass adds to the hole).
- The hole's real mass is anywhere in ±10% of its listed mass; the plans are checked for every value in that range.
- At most 6 characters, at most 2 of them HICs. The fleet moves in **waves**: an out wave (any of the ships, each hot
  or cold), then everyone who went out comes back, lightest first, so only the last (heaviest) return can close it.
  The hole is checked after every wave (from the far side after an out wave, from home after a back wave):
  stable, reduced (under 50% left) or critical (under 10% left) picks the next step.
- Goal, in order: nobody stranded (with a safety margin, `MARGIN` env var, default 10 kt), fewest waves, fewest
  characters, fewest jumps.

## Scripts

| File | What it does |
| --- | --- |
| `fleet2.js` | The solver: best wave plan for a hole of N kt and a fleet of nB battleships + nH HICs. `node fleet2.js <N>` prints every fleet size. |
| `pick.js` | `node pick.js <N>`: picks the best fleet for an N kt hole and writes `fleet-<N>.json` (the plan tree, and the fastest battleship-only plan). |
| `verify2.js` | Independent check: walks each `fleet-*.json` plan jump by jump for every hole mass in ±10% (0.1 kt steps). Every line must say all `home`, no `strand`. |
| `gen.js` | Turns the plans into Mermaid flowcharts, with the hole data (`HOLES`: types, max jump) from `battleship-rolling-card.html`; writes `build/cards.json`. |
| `build.mjs` | Renders the flowcharts once in headless Chrome and writes `build/fleet-rolling-card.html` (the poster with static inline SVGs). Page head and styles: `fleet-head.html`. |
| `shoot.mjs` | Screenshots that page with headless Chrome: `poster.png` and one image per hole size (1100 CSS px wide at 2x = 2200 px) into `public/images/rolling-guide/`. `node shoot.mjs <i>` redoes only hole number i (0 = 750M ... 5 = 5B). |

`fleet-*.json` are the solver's results (kept, so the images can be rebuilt without solving again).
`build/` holds temporary files and the Chrome profiles; it is git-ignored.

## Regenerate

Run from anywhere (paths are relative to this folder):

```bash
for n in 750 1000 2000 3000 3300 5000; do node pick.js $n; done   # only when the model changed (slow for 5000)
node verify2.js
node gen.js
node build.mjs
node shoot.mjs
```

Needs Node 22+ (global `fetch` and `WebSocket`) and Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`
(change the path at the top of `build.mjs` / `shoot.mjs` elsewhere). `build.mjs` loads Mermaid from cdn.jsdelivr.net
and both pages load Google Fonts, so building needs the network; the finished PNGs don't.
