// Fork-owned (region-map): builds public/region-map/<regionID>.json (one schematic per k-space region) and
// public/region-map/index.json, from CCP's public Static Data Export (SDE, JSON Lines). Run by hand when CCP
// publishes a new SDE (the map layout rarely changes); never at runtime. No third-party map site is read.
//   1. download https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip and unzip
//      mapSolarSystems.jsonl, mapRegions.jsonl, mapConstellations.jsonl and mapStargates.jsonl into a directory
//   2. node tools/fork/build-region-maps.mjs <dir> <sdeBuild> <YYYY-MM-DD> <outDir, e.g. public/region-map>
//
// Layout: the SDE gives every system a `position2D` (the schematic of the in-game universe map, one plane for all of
// New Eden, uniform spacing of about 0.61 LY). It is used as is: a region keeps the shape players know from the game.
// Units: 0.01 light years, rounded to integers, x to the right, y DOWN (the SDE's y points north, so it is flipped),
// moved so the region's top left system is at (PAD, PAD).
//
// Region file: {v, sde, date, id, name, w, h, constellations: [[id, name, factionID?]],
//   systems: [[id, name, x, y, constellationIndex, security]], gates: [[idA, idB]] (inside the region, idA < idB),
//   links: [[systemID, toSystemID, toRegionID, toSystemName, dx, dy]]} (gates leaving the region; dx/dy = direction
//   to the system behind it in the universe plane, integers, so the viewer can draw a stub pointing that way).
// Index file: {v, sde, date, regions: [[id, name, systemCount]]}.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LY = 9460730472580800;	// metres in a light year
export const UNIT = LY / 100;		// layout unit: 0.01 ly
export const PAD = 40;				// margin around the systems, in layout units
export const K_SPACE_MAX_REGION = 11000000;	// regionID below this = k-space (J-space regions start at 11000000)

const round = (n) => Math.round(n);
const name = (o) => (o && o.name && (o.name.en || Object.values(o.name)[0])) || String(o && o._key);

/** Pure: SDE rows -> {index, regions: {regionID: file object}}. Rows are the parsed JSONL objects. */
export function buildRegionMaps({ systems, regions, constellations, stargates }, sde, date) {
	const ksystems = systems.filter((s) => s.regionID < K_SPACE_MAX_REGION && s.position2D);
	const byId = new Map(ksystems.map((s) => [s._key, s]));
	const regionName = new Map(regions.map((r) => [r._key, name(r)]));
	const constName = new Map(constellations.map((c) => [c._key, { name: name(c), faction: c.factionID }]));
	const out = {};
	const index = [];
	const group = new Map();
	ksystems.forEach((s) => { if (!group.has(s.regionID)) group.set(s.regionID, []); group.get(s.regionID).push(s); });
	for (const [regionID, list] of [...group.entries()].sort((a, b) => a[0] - b[0])) {
		list.sort((a, b) => a._key - b._key);
		const xs = list.map((s) => s.position2D.x / UNIT), ys = list.map((s) => -s.position2D.y / UNIT);
		const minX = Math.min(...xs), minY = Math.min(...ys);
		const cIds = [...new Set(list.map((s) => s.constellationID))].sort((a, b) => a - b);
		const cIndex = new Map(cIds.map((id, i) => [id, i]));
		const placed = list.map((s, i) => [
			s._key, name(s), round(xs[i] - minX) + PAD, round(ys[i] - minY) + PAD, cIndex.get(s.constellationID),
			Math.round(s.securityStatus * 100) / 100
		]);
		const gates = [];
		const links = [];
		const seen = new Set();
		for (const g of stargates) {
			const a = byId.get(g.solarSystemID), b = byId.get(g.destination.solarSystemID);
			if (!a || a.regionID !== regionID || !b) continue;
			if (b.regionID === regionID) {
				const lo = Math.min(a._key, b._key), hi = Math.max(a._key, b._key);
				const key = lo + '-' + hi;
				if (!seen.has(key)) { seen.add(key); gates.push([lo, hi]); }
			} else {
				const dx = round((b.position2D.x - a.position2D.x) / UNIT), dy = round(-(b.position2D.y - a.position2D.y) / UNIT);
				links.push([a._key, b._key, b.regionID, name(b), dx, dy]);
			}
		}
		gates.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
		links.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
		out[regionID] = {
			v: 1, sde: String(sde), date, id: regionID, name: regionName.get(regionID) || String(regionID),
			w: Math.max(...placed.map((p) => p[2])) + PAD, h: Math.max(...placed.map((p) => p[3])) + PAD,
			constellations: cIds.map((id) => {
				const c = constName.get(id) || { name: String(id) };
				return c.faction ? [id, c.name, c.faction] : [id, c.name];
			}),
			systems: placed, gates, links
		};
		index.push([regionID, out[regionID].name, placed.length]);
	}
	return { index: { v: 1, sde: String(sde), date, regions: index }, regions: out };
}

function main() {
	const [dir, sde, date, outDir] = process.argv.slice(2);
	if (!dir || !sde || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !outDir) {
		console.error('usage: node build-region-maps.mjs <dir with the four .jsonl files> <SDE build number> <YYYY-MM-DD> <output dir>');
		process.exit(1);
	}
	const lines = (file) => readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const result = buildRegionMaps({
		systems: lines('mapSolarSystems.jsonl'), regions: lines('mapRegions.jsonl'),
		constellations: lines('mapConstellations.jsonl'), stargates: lines('mapStargates.jsonl')
	}, sde, date);
	mkdirSync(outDir, { recursive: true });
	let bytes = 0;
	for (const [id, file] of Object.entries(result.regions)) {
		const text = JSON.stringify(file);
		bytes += text.length;
		writeFileSync(join(outDir, id + '.json'), text + '\n');
	}
	writeFileSync(join(outDir, 'index.json'), JSON.stringify(result.index) + '\n');
	console.error('regions: ' + result.index.regions.length + ', systems: ' + result.index.regions.reduce((n, r) => n + r[2], 0) + ', bytes: ' + bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
