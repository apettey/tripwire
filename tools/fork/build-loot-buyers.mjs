// Fork-owned (loot-buyers): builds public/loot-buyers/stations.json, the static list of NPC stations that hold standing
// buy orders for blue loot (the four Sleeper components) and red loot (Triglavian Survey Database). Run by hand now and
// then; never at runtime.
//
// Why two sources: the SDE has the stations (owner corporation, system, orbit, operation) but not the market, and the
// buyers are not "all stations of corporation X": CCP seeds NPC buy orders (365-day duration, ~1,000,000 units) at the
// stations of 12 corporations (blue) and 2 (red), and one corporation (The Sanctuary) only at 1 of its 5 stations. So
// the stations come from the public, unauthenticated ESI regional market orders (one read-only pass), joined with the SDE.
//
//   1. download https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip and unzip
//      npcStations, npcCorporations, stationOperations, mapSolarSystems (.jsonl) into a directory
//   2. node tools/fork/build-loot-buyers.mjs fetch <sdeDir> <ordersFile>
//        queries ESI (public, no token) for the 5 item types in every k-space region, keeps the NPC-seeded orders
//   3. node tools/fork/build-loot-buyers.mjs build <sdeDir> <ordersFile> <sdeBuild> <YYYY-MM-DD> > public/loot-buyers/stations.json
//      (deterministic: the same inputs give the same file; <sdeBuild> is checked against _sde.jsonl when present)
//
// Output: {v, sde, date, ordersDate, source, blueTypes, redTypes, corps: {id: name}, blue: [S...], red: [S...]} with
// S = [stationID, systemID, corpID, station name]; sorted by stationID. A station is listed when it has an NPC buy order
// for every type of the class.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLUE_TYPES = { 30744: 'Neural Network Analyzer', 30745: 'Sleeper Data Library', 30746: 'Ancient Coordinates Database', 30747: 'Sleeper Drone AI Nexus' };
export const RED_TYPES = { 48121: 'Triglavian Survey Database' };
// CCP's seeded orders: 365 days, about a million units (999,999 or 1,000,000), at the station
export const MIN_DURATION = 365;
export const MIN_VOLUME = 999999;

const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function roman(n) {
	let out = '';
	ROMAN.forEach(([v, s]) => { while (n >= v) { out += s; n -= v; } });
	return out;
}

/** "<system> <planet> - Moon <n> - <corporation> <operation>" as EVE names NPC stations (a station that orbits a planet has no moon part) */
export function stationName(station, systemName, corpName, operationName) {
	const planet = systemName + ' ' + roman(station.celestialIndex);
	const moon = station.orbitIndex !== undefined ? ' - Moon ' + station.orbitIndex : '';
	return planet + moon + ' - ' + corpName + (station.useOperationName && operationName ? ' ' + operationName : '');
}

/** The NPC-seeded buy orders: [{type, loc}] from raw ESI orders (or the saved subset) that are buy orders for the wanted types */
export function seeded(orders, stationIDs) {
	const types = new Set([...Object.keys(BLUE_TYPES), ...Object.keys(RED_TYPES)].map(Number));
	const seen = new Set();
	const out = [];
	orders.forEach((o) => {
		if (!o.is_buy_order && o.is_buy_order !== undefined) return;
		if (!types.has(o.type_id) || o.duration < MIN_DURATION || o.volume_total < MIN_VOLUME) return;
		if (stationIDs && !stationIDs.has(o.location_id)) return;
		const key = o.type_id + ':' + o.location_id;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ type_id: o.type_id, location_id: o.location_id, duration: o.duration, volume_total: o.volume_total });
	});
	return out.sort((a, b) => a.type_id - b.type_id || a.location_id - b.location_id);
}

/** The output object. stations/systems/corps/operations are the SDE rows (arrays of {_key, ...}); orders are seeded() rows */
export function build({ stations, systems, corps, operations, orders, sde, date, ordersDate }) {
	const byID = (rows) => new Map(rows.map((r) => [r._key, r]));
	const stationMap = byID(stations), systemMap = byID(systems), corpMap = byID(corps), opMap = byID(operations);
	const has = {};   // locationID -> Set of type ids
	orders.forEach((o) => { (has[o.location_id] ||= new Set()).add(o.type_id); });
	const usedCorps = {};
	const list = (types) => Object.keys(has).map(Number).filter((loc) => Object.keys(types).every((t) => has[loc].has(Number(t))))
		.filter((loc) => stationMap.has(loc)).sort((a, b) => a - b).map((loc) => {
			const s = stationMap.get(loc);
			const sys = systemMap.get(s.solarSystemID);
			const corp = corpMap.get(s.ownerID);
			const op = opMap.get(s.operationID);
			const corpName = corp ? corp.name.en : String(s.ownerID);
			usedCorps[s.ownerID] = corpName;
			return [loc, s.solarSystemID, s.ownerID, stationName(s, sys ? sys.name.en : String(s.solarSystemID), corpName, op && op.operationName ? op.operationName.en : '')];
		});
	return { v: 1, sde: String(sde), date, ordersDate, source: 'CCP Static Data Export (stations) + public ESI regional market orders (NPC-seeded buy orders)',
		blueTypes: BLUE_TYPES, redTypes: RED_TYPES, corps: usedCorps, blue: list(BLUE_TYPES), red: list(RED_TYPES) };
}

const rows = (dir, name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function fetchOrders(dir, file) {
	const regions = rows(dir, 'mapRegions.jsonl').map((r) => r._key).filter((k) => k < 11000000);   // k-space regions have markets, wormhole space doesn't
	const stationIDs = new Set(rows(dir, 'npcStations.jsonl').map((s) => s._key));
	const all = [];
	for (const region of regions) {
		for (const type of [...Object.keys(BLUE_TYPES), ...Object.keys(RED_TYPES)]) {
			for (let page = 1; ; page++) {
				const res = await fetch('https://esi.evetech.net/latest/markets/' + region + '/orders/?datasource=tranquility&order_type=buy&type_id=' + type + '&page=' + page,
					{ headers: { 'User-Agent': 'tripwire-fork loot-buyers generator' } });
				if (!res.ok) { if (res.status !== 404) console.error('ESI', region, type, res.status); break; }
				all.push(...await res.json());
				if (page >= Number(res.headers.get('x-pages') || 1)) break;
			}
		}
	}
	const orders = seeded(all, stationIDs);
	writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString().slice(0, 10), orders }));
	console.error('regions: ' + regions.length + ', raw orders: ' + all.length + ', NPC-seeded orders kept: ' + orders.length);
}

function main(argv) {
	const [mode, dir, ordersFile, sde, date] = argv;
	if (mode === 'fetch' && dir && ordersFile) return fetchOrders(dir, ordersFile);
	if (mode === 'build' && dir && ordersFile && sde && /^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
		if (existsSync(join(dir, '_sde.jsonl'))) {
			const info = JSON.parse(readFileSync(join(dir, '_sde.jsonl'), 'utf8').split('\n')[0]);
			if (String(info.buildNumber) !== String(sde)) { console.error('SDE build mismatch: directory has ' + info.buildNumber + ', argument says ' + sde); process.exit(1); }
		}
		const saved = JSON.parse(readFileSync(ordersFile, 'utf8'));
		const out = build({ stations: rows(dir, 'npcStations.jsonl'), systems: rows(dir, 'mapSolarSystems.jsonl'), corps: rows(dir, 'npcCorporations.jsonl'),
			operations: rows(dir, 'stationOperations.jsonl'), orders: saved.orders, sde, date, ordersDate: saved.fetchedAt });
		console.error('blue stations: ' + out.blue.length + ', red stations: ' + out.red.length + ', corporations: ' + Object.keys(out.corps).length);
		console.log(JSON.stringify(out));
		return;
	}
	console.error('usage:\n  node build-loot-buyers.mjs fetch <sdeDir> <ordersFile>\n  node build-loot-buyers.mjs build <sdeDir> <ordersFile> <sdeBuild> <YYYY-MM-DD> > stations.json');
	process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
