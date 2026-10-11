#!/usr/bin/env node
// Fork-owned: builds the Jump planner's static data from CCP's Static Data Export (SDE, JSON Lines edition).
//
//   node jumprange/tools/generate-coords.js <sde-dir> [out-dir] [--zip <the downloaded SDE zip>]
//
// <sde-dir> holds the unzipped SDE files this reads: _sde.jsonl, mapSolarSystems.jsonl, mapStargates.jsonl,
// types.jsonl, groups.jsonl, typeDogma.jsonl (download: https://developers.eveonline.com/static-data, the
// "JSON Lines" zip). [out-dir] defaults to public/jumprange. --zip records the zip's file name and SHA-256 in meta. Writes:
//
// systems.json  Every k-space solar system that can be reached by stargates from Jita, plus Pochven (cut off
//               from the gate network, but you can jump out of it) and Zarzakh. Positions in light-years,
//               multiplied by 1000 and rounded (0.001 LY), columnar and delta-encoded by system ID order:
//               {meta, ids: [first, +d, +d, ...], x: [first, +d, ...], y: [...], z: [...]}
//               Decode: running sums. Systems that are not reachable at all (the Jove regions, which have no
//               gates in or out) are left out: they can be neither a jump origin nor a target.
//               Axes are the SDE's: x east, y up, z north (a top-down map draws x right and z up).
// ships.json    Every published ship (category 6) with a jump drive (dogma attribute 867 jumpDriveRange):
//               {meta, ships: [{typeID, name, groupID, group, baseLy, covert}]}. covert: the hull can jump to
//               a covert cynosural field, i.e. the Black Ops group (898); no dogma attribute says this.
//
// The output only changes when the SDE does, so re-run it after a game update and commit both files.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LY_M = 9.4607e15;			// metres per light-year, as EVE uses it
const SCALE = 1000;				// stored unit: 0.001 LY
const JITA = 30000142;
const POCHVEN_REGION = 10000070;
const ZARZAKH = 30100000;
const SHIP_CATEGORY = 6;
const ATTR_JUMP_RANGE = 867;
const BLACK_OPS_GROUP = 898;

async function eachLine(dir, file, fn) {
	const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, file)), crlfDelay: Infinity });
	for await (const line of rl) {
		if (line.trim()) { fn(JSON.parse(line)); }
	}
}

function deltas(values) {
	return values.map((v, i) => (i ? v - values[i - 1] : v));
}

function sha256(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
	});
}

async function main() {
	const args = process.argv.slice(2);
	const zipAt = args.indexOf('--zip');
	const zip = zipAt >= 0 ? args.splice(zipAt, 2)[1] : null;
	if (zipAt >= 0 && !zip) { console.error('--zip needs the SDE zip file'); process.exit(2); }
	const sde = args[0];
	const out = args[1] || path.join(__dirname, '..', '..', 'public', 'jumprange');
	if (!sde) { console.error('usage: generate-coords.js <sde-dir> [out-dir] [--zip <sde-zip>]'); process.exit(2); }

	const zipInfo = zip ? { sdeZip: path.basename(zip), sdeZipSha256: await sha256(zip) } : {};
	let build = null;
	await eachLine(sde, '_sde.jsonl', (r) => { if (r._key === 'sde') { build = r; } });
	if (!build) { throw new Error('_sde.jsonl has no build number'); }

	// ---- Systems ----
	const systems = {};
	await eachLine(sde, 'mapSolarSystems.jsonl', (s) => {
		if (s._key >= 30000000 && s._key < 31000000 || s._key === ZARZAKH) {
			systems[s._key] = { id: s._key, regionID: s.regionID, pos: s.position, name: s.name && s.name.en };
		}
	});
	const gates = {};
	await eachLine(sde, 'mapStargates.jsonl', (g) => {
		const from = g.solarSystemID, to = g.destination && g.destination.solarSystemID;
		if (!systems[from] || !systems[to]) { return; }
		(gates[from] = gates[from] || []).push(to);
	});
	// Reachable by gates from Jita
	const reached = { [JITA]: true };
	const queue = [JITA];
	for (let i = 0; i < queue.length; i++) {
		(gates[queue[i]] || []).forEach((n) => { if (!reached[n]) { reached[n] = true; queue.push(n); } });
	}
	const kept = Object.values(systems).filter((s) => reached[s.id] || s.regionID === POCHVEN_REGION || s.id === ZARZAKH)
		.sort((a, b) => a.id - b.id);
	const left = Object.values(systems).filter((s) => !kept.includes(s));
	const leftRegions = {};
	left.forEach((s) => { leftRegions[s.regionID] = (leftRegions[s.regionID] || 0) + 1; });

	const ly = (m) => Math.round(m / LY_M * SCALE);
	const ids = kept.map((s) => s.id);
	const data = {
		meta: {
			version: build.buildNumber,
			source: 'EVE Online Static Data Export (developers.eveonline.com), mapSolarSystems + mapStargates',
			sdeBuild: build.buildNumber,
			sdeReleaseDate: build.releaseDate,
			...zipInfo,
			unit: 'light-years x ' + SCALE + ' (LY = ' + LY_M + ' m), rounded',
			axes: 'x east, y up, z north (SDE axes); top-down map: x right, z up',
			encoding: 'ids, x, y, z: first value, then differences to the previous entry (decode with running sums)',
			count: kept.length,
			left_out: 'k-space systems not reachable by stargates from Jita, except Pochven and Zarzakh: regions '
				+ Object.keys(leftRegions).map((r) => r + ' (' + leftRegions[r] + ')').join(', ')
		},
		ids: deltas(ids),
		x: deltas(kept.map((s) => ly(s.pos.x))),
		y: deltas(kept.map((s) => ly(s.pos.y))),
		z: deltas(kept.map((s) => ly(s.pos.z)))
	};

	// ---- Ships ----
	const range = {};
	await eachLine(sde, 'typeDogma.jsonl', (t) => {
		(t.dogmaAttributes || []).forEach((a) => { if (a.attributeID === ATTR_JUMP_RANGE && a.value > 0) { range[t._key] = a.value; } });
	});
	const groups = {};
	await eachLine(sde, 'groups.jsonl', (g) => { groups[g._key] = g; });
	const ships = [];
	await eachLine(sde, 'types.jsonl', (t) => {
		const g = groups[t.groupID];
		if (!range[t._key] || !t.published || !g || g.categoryID !== SHIP_CATEGORY) { return; }
		ships.push({ typeID: t._key, name: t.name.en, groupID: t.groupID, group: g.name.en, baseLy: range[t._key], covert: t.groupID === BLACK_OPS_GROUP });
	});
	ships.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
	const shipData = {
		meta: {
			version: build.buildNumber,
			source: 'EVE Online Static Data Export (developers.eveonline.com), types + groups + typeDogma attribute 867 (jumpDriveRange)',
			sdeBuild: build.buildNumber,
			sdeReleaseDate: build.releaseDate,
			...zipInfo,
			covert: 'true for the Black Ops group (898): the only hulls that can jump to a covert cynosural field'
		},
		ships: ships
	};

	fs.mkdirSync(out, { recursive: true });
	fs.writeFileSync(path.join(out, 'systems.json'), JSON.stringify(data) + '\n');
	fs.writeFileSync(path.join(out, 'ships.json'), JSON.stringify(shipData, null, '\t') + '\n');
	console.log('systems:', kept.length, 'kept,', left.length, 'left out', JSON.stringify(leftRegions));
	console.log('ships:', ships.length);
	console.log('systems.json', fs.statSync(path.join(out, 'systems.json')).size, 'bytes');
}

main().catch((e) => { console.error(e); process.exit(1); });
