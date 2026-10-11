const jumpRange = {
	// Jump range engine (fork-owned): pure functions for jump drive range in k-space, used by the Jump planner panel
	// (app/js/fork/jump-planner.js) and meant for reuse (e.g. JF / Black Ops bridge logistics). No DOM, no jQuery, no
	// globals: everything comes in as arguments. Keep `const jumpRange` on the first line: the test helper strips it
	// to define a global.
	//
	// Game rules relied on (checked 2026-10-11):
	// - Range is the straight-line distance between the two systems' positions in light-years, not gate jumps; each
	//   level of Jump Drive Calibration adds 20% of the hull's base range (V doubles it).
	//   https://wiki.eveuniversity.org/Jump_drives
	// - No cynosural field can be lit in high-sec, so high-sec is never a target; jump drives can't target
	//   wormhole space (Thera included). https://wiki.eveuniversity.org/Jump_drives
	// - Pochven: a region-wide cyno jammer stops anyone lighting a cyno, so it is never a target, but jump drives
	//   can be used to leave it. https://wiki.eveuniversity.org/Pochven
	// - Zarzakh: capitals can't take its gates (https://wiki.eveuniversity.org/Zarzakh); no source found that
	//   says a cyno can be lit there, so it is treated as neither a target nor an origin (conservative).
	// - A cyno-jammed system (Tenebrex Cyno Jammer, Sansha incursion) blocks normal cynos; covert cynos still work,
	//   and only Black Ops battleships can jump to them. https://wiki.eveuniversity.org/Jump_drives
	// - High-sec as the game rounds it: security >= 0.45 (like systemAnalysis.js).
	LY_M: 9.4607e15,
	SCALE: 1000,				// systems.json stores positions in 0.001 LY
	JDC_STEP: 0.2,
	POCHVEN_REGION: 10000070,
	POCHVEN_FACTION: 500026,
	ZARZAKH: 30100000,
	JITA: 30000142,
	AMARR: 30002187,
	DEFAULT_BANDS: [3.5, 5.0],		// then "up to the maximum range"
	DEFAULT_PRESET: "group-547",	// Carrier

	/**
	 * Decode systems.json (columnar, delta-encoded) into positions.
	 * @param data {meta, ids, x, y, z}
	 * @return {meta, ids: [systemID], pos: {systemID: {x, y, z}} in LY}
	 */
	decode: function(data) {
		const ids = [], pos = {};
		if (!data || !Array.isArray(data.ids)) { return { meta: data ? data.meta : null, ids: ids, pos: pos }; }
		let id = 0, x = 0, y = 0, z = 0;
		for (let i = 0; i < data.ids.length; i++) {
			id += data.ids[i]; x += data.x[i]; y += data.y[i]; z += data.z[i];
			ids.push(id);
			pos[id] = { x: x / jumpRange.SCALE, y: y / jumpRange.SCALE, z: z / jumpRange.SCALE };
		}
		return { meta: data.meta, ids: ids, pos: pos };
	},

	/** Straight-line distance in LY between two points {x, y, z} in LY (NaN if either is missing) */
	distanceLy: function(a, b) {
		if (!a || !b) { return NaN; }
		const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	},

	/** Jump Drive Calibration level as an integer 0-5 */
	jdcLevel: function(level) {
		const n = Math.round(Number(level));
		return isFinite(n) ? Math.max(0, Math.min(5, n)) : 5;
	},

	/**
	 * Maximum range: base * (1 + 0.2 * JDC), then at most cap (when cap is a positive number).
	 * @param baseLy the hull's base range (dogma attribute jumpDriveRange)
	 * @param jdcLevel 0-5 (clamped)
	 * @param cap optional upper limit in LY ("Range used" setting)
	 */
	maxRange: function(baseLy, jdcLevel, cap) {
		const base = Number(baseLy) || 0;
		const range = Math.round(base * (1 + jumpRange.JDC_STEP * jumpRange.jdcLevel(jdcLevel)) * 1000) / 1000;
		const c = Number(cap);
		return c > 0 && c < range ? c : range;
	},

	/** K-space system id (30000001-30999999, or Zarzakh) */
	isKSpaceID: function(systemID) {
		const id = Number(systemID);
		return (id >= 30000000 && id < 31000000) || id === jumpRange.ZARZAKH;
	},

	isPochven: function(system) {
		return !!system && (Number(system.regionID) === jumpRange.POCHVEN_REGION || Number(system.factionID) === jumpRange.POCHVEN_FACTION);
	},

	/** "hs", "ls", "ns", "pochven", "zarzakh", "wh" or null (unknown system). sys: appData.systems entry */
	kind: function(systemID, sys) {
		if (!sys) { return null; }
		if (Number(systemID) === jumpRange.ZARZAKH) { return "zarzakh"; }
		if (!jumpRange.isKSpaceID(systemID) || sys.class || Number(sys.regionID) >= 11000000) { return "wh"; }
		if (jumpRange.isPochven(sys)) { return "pochven"; }
		const sec = Number(sys.security);
		if (sec >= 0.45) { return "hs"; }
		return sec > 0 ? "ls" : "ns";
	},

	/**
	 * Whether a jump drive can jump to a system, i.e. a cyno can be lit there for this ship.
	 * @param systemID the system's id
	 * @param sys appData.systems entry ({security, regionID, factionID, class})
	 * @param opts {lowsec (default true), nullsec (default true), jammed: {systemID: truthy} (cyno-jammed),
	 *        covert: the ship can use covert cynos, which work in jammed systems}
	 */
	isValidCynoTarget: function(systemID, sys, opts) {
		const o = opts || {};
		const kind = jumpRange.kind(systemID, sys);
		if (kind === "ls") { if (o.lowsec === false) { return false; } }
		else if (kind === "ns") { if (o.nullsec === false) { return false; } }
		else { return false; }
		return !(o.jammed && o.jammed[systemID] && !o.covert);
	},

	/** Whether a jump drive can be used in a system: any k-space incl. high-sec and Pochven; not Zarzakh or W-space */
	canJumpFrom: function(systemID, sys) {
		const kind = jumpRange.kind(systemID, sys);
		return kind === "hs" || kind === "ls" || kind === "ns" || kind === "pochven";
	},

	/** Index of the distance band: 0 for <= bands[0], 1 for <= bands[1], ..., bands.length beyond the last */
	band: function(ly, bands) {
		const list = Array.isArray(bands) ? bands : jumpRange.DEFAULT_BANDS;
		for (let i = 0; i < list.length; i++) { if (ly <= list[i]) { return i; } }
		return list.length;
	},

	/** The ring radii to draw for a range: the default bands below it, then the range itself */
	rings: function(rangeLy, bands) {
		const list = (Array.isArray(bands) ? bands : jumpRange.DEFAULT_BANDS).filter(function(b) { return b < rangeLy - 1e-9; });
		return list.concat([rangeLy]);
	},

	/**
	 * Spatial grid over decoded positions, so "everything within R LY" doesn't scan every system.
	 * @param coords decode() output
	 * @param cellLy cell size (default 5 LY)
	 */
	buildIndex: function(coords, cellLy) {
		const cell = Number(cellLy) > 0 ? Number(cellLy) : 5;
		const cells = {};
		(coords.ids || []).forEach(function(id) {
			const p = coords.pos[id];
			const key = Math.floor(p.x / cell) + "," + Math.floor(p.y / cell) + "," + Math.floor(p.z / cell);
			(cells[key] = cells[key] || []).push(id);
		});
		return { cell: cell, cells: cells, pos: coords.pos, ids: coords.ids };
	},

	/** Every system within radius LY of a point: [{id, ly}] (unsorted) */
	within: function(index, point, radius) {
		const out = [];
		if (!index || !point || !(radius >= 0)) { return out; }
		const c = index.cell;
		const r2 = radius * radius;
		const x0 = Math.floor((point.x - radius) / c), x1 = Math.floor((point.x + radius) / c);
		const y0 = Math.floor((point.y - radius) / c), y1 = Math.floor((point.y + radius) / c);
		const z0 = Math.floor((point.z - radius) / c), z1 = Math.floor((point.z + radius) / c);
		for (let i = x0; i <= x1; i++) {
			for (let j = y0; j <= y1; j++) {
				for (let k = z0; k <= z1; k++) {
					const list = index.cells[i + "," + j + "," + k];
					if (!list) { continue; }
					for (let n = 0; n < list.length; n++) {
						const p = index.pos[list[n]];
						const dx = p.x - point.x, dy = p.y - point.y, dz = p.z - point.z;
						const d2 = dx * dx + dy * dy + dz * dz;
						if (d2 <= r2) { out.push({ id: list[n], ly: Math.sqrt(d2) }); }
					}
				}
			}
		}
		return out;
	},

	/**
	 * Valid jump targets within range of an origin, nearest first: [{id, ly, band, jammed}].
	 * Cyno-jammed systems a normal cyno can't use are left out, unless opts.showJammed: then they are listed with
	 * jammed: true (not a target). Valid targets that are jammed but reachable with a covert cyno get jammed: true too.
	 * @param systems appData.systems-like lookup; opts see isValidCynoTarget, plus bands, showJammed
	 */
	inRange: function(originID, index, rangeLy, systems, opts) {
		const o = opts || {};
		const origin = index && index.pos[originID];
		if (!origin) { return []; }
		const jammed = o.jammed || {};
		const out = [];
		jumpRange.within(index, origin, rangeLy).forEach(function(hit) {
			if (hit.id === Number(originID)) { return; }
			const sys = systems ? systems[hit.id] : null;
			const isJammed = !!jammed[hit.id];
			if (jumpRange.isValidCynoTarget(hit.id, sys, o)) {
				out.push({ id: hit.id, ly: hit.ly, band: jumpRange.band(hit.ly, o.bands), jammed: isJammed });
			} else if (isJammed && o.showJammed && jumpRange.isValidCynoTarget(hit.id, sys, Object.assign({}, o, { jammed: null }))) {
				out.push({ id: hit.id, ly: hit.ly, band: jumpRange.band(hit.ly, o.bands), jammed: true, blocked: true });
			}
		});
		out.sort(function(a, b) { return a.ly - b.ly || a.id - b.id; });
		return out;
	},

	/**
	 * How a jump ship gets from origin to dest with at most maxJumps (1 or 2) jumps.
	 * @return {jumps: 0 | 1 | 2 | null (not within maxJumps or not possible), direct: LY, via: [{id, ly1, ly2}]
	 *   (2 jumps: every midpoint, best first: shortest longer leg, then shortest total), reason (when null)}
	 */
	reach: function(originID, destID, rangeLy, index, systems, opts, maxJumps) {
		const max = maxJumps === undefined ? 2 : maxJumps;
		const o = Object.assign({}, opts || {});
		const origin = index && index.pos[originID];
		const dest = index && index.pos[destID];
		const result = { jumps: null, direct: jumpRange.distanceLy(origin, dest), via: [] };
		if (!origin || !dest) { result.reason = "unknown"; return result; }
		if (Number(originID) === Number(destID)) { result.jumps = 0; return result; }
		if (!jumpRange.canJumpFrom(originID, systems[originID])) { result.reason = "origin"; return result; }
		if (!jumpRange.isValidCynoTarget(destID, systems[destID], o)) { result.reason = "target"; return result; }
		if (result.direct <= rangeLy) { result.jumps = 1; return result; }
		if (max < 2 || result.direct > 2 * rangeLy) { result.reason = "range"; return result; }
		jumpRange.within(index, origin, rangeLy).forEach(function(hit) {
			if (hit.id === Number(originID) || hit.id === Number(destID)) { return; }
			if (!jumpRange.isValidCynoTarget(hit.id, systems[hit.id], o)) { return; }
			const ly2 = jumpRange.distanceLy(index.pos[hit.id], dest);
			if (ly2 <= rangeLy) { result.via.push({ id: hit.id, ly1: hit.ly, ly2: ly2 }); }
		});
		result.via.sort(function(a, b) {
			return Math.max(a.ly1, a.ly2) - Math.max(b.ly1, b.ly2) || (a.ly1 + a.ly2) - (b.ly1 + b.ly2) || a.id - b.id;
		});
		if (result.via.length) { result.jumps = 2; } else { result.reason = "range"; }
		return result;
	},

	/**
	 * Ship presets from ships.json: one per ship group (and base range, should a group ever have two), sorted by label.
	 * @return [{key ("group-<groupID>" or "group-<groupID>-<LY>"), label, group, baseLy, covert, ships: [names]}]
	 */
	presets: function(shipsData) {
		const ships = shipsData && Array.isArray(shipsData.ships) ? shipsData.ships : [];
		const byKey = {};
		const ranges = {};
		ships.forEach(function(s) { (ranges[s.groupID] = ranges[s.groupID] || {})[s.baseLy] = true; });
		ships.forEach(function(s) {
			if (!(s.baseLy > 0)) { return; }
			const split = Object.keys(ranges[s.groupID]).length > 1;
			const key = "group-" + s.groupID + (split ? "-" + s.baseLy : "");
			const p = byKey[key] = byKey[key] || { key: key, group: s.group, baseLy: s.baseLy, covert: false, ships: [] };
			p.covert = p.covert || !!s.covert;
			p.ships.push(s.name);
		});
		return Object.keys(byKey).map(function(k) {
			const p = byKey[k];
			p.ships.sort();
			// A group of one or two hulls is better known by them (Capital Industrial Ship = Rorqual)
			p.label = p.group + (p.ships.length <= 2 ? " (" + p.ships.join(", ") + ")" : "");
			return p;
		}).sort(function(a, b) { return a.label.localeCompare(b.label); });
	},

	/** The preset with this key, else the default (Carrier), else the first */
	preset: function(presets, key) {
		const list = presets || [];
		return list.filter(function(p) { return p.key === key; })[0]
			|| list.filter(function(p) { return p.key === jumpRange.DEFAULT_PRESET; })[0] || list[0] || null;
	},

	/** "7.0 LY" (one decimal; two when it isn't a multiple of 0.1, e.g. 7.5 / 3.75) */
	formatLy: function(ly) {
		const n = Number(ly);
		if (!isFinite(n)) { return ""; }
		const one = n.toFixed(1);
		return (Math.abs(Number(one) - n) > 1e-9 ? n.toFixed(2) : one) + " LY";
	},

	/** Gate jumps from a system to every system reachable by gates (BFS over appData.map.shortest, keyed by id - 30000000) */
	gateJumps: function(map, fromID, maxDepth) {
		const dist = {};
		const from = Number(fromID);
		if (!map || !from) { return dist; }
		const limit = maxDepth === undefined ? Infinity : maxDepth;
		dist[from] = 0;
		const queue = [from];
		for (let i = 0; i < queue.length; i++) {
			const current = queue[i];
			if (dist[current] >= limit) { continue; }
			const next = map[current - 30000000] || {};
			for (const key in next) {
				const id = 30000000 + Number(key);
				if (dist[id] === undefined) { dist[id] = dist[current] + 1; queue.push(id); }
			}
		}
		return dist;
	},

	/**
	 * From a system to near a trade hub: the hub is high-sec (no cyno), so the best valid target within maxGates gate
	 * jumps of the hub that the ship reaches in 1-2 jumps. Fewest jumps first, then fewest gates, then shortest jump.
	 * @return {systemID, gates, reach} or null
	 */
	nearHub: function(fromID, hubID, rangeLy, index, systems, map, opts, maxGates) {
		const gates = jumpRange.gateJumps(map, hubID, maxGates === undefined ? 5 : maxGates);
		let best = null;
		Object.keys(gates).forEach(function(key) {
			const id = Number(key);
			if (!jumpRange.isValidCynoTarget(id, systems[id], opts) || !index.pos[id]) { return; }
			const r = jumpRange.reach(fromID, id, rangeLy, index, systems, opts, 2);
			if (!r.jumps) { return; }
			const legs = r.jumps === 1 ? r.direct : Math.max(r.via[0].ly1, r.via[0].ly2);
			const c = { systemID: id, gates: gates[key], reach: r, legs: legs };
			if (!best || c.reach.jumps < best.reach.jumps || (c.reach.jumps === best.reach.jumps && (c.gates < best.gates
				|| (c.gates === best.gates && c.legs < best.legs)))) { best = c; }
		});
		return best;
	}
};
