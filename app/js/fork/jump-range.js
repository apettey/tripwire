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
	// - Jump fuel: isotopes used per jump = distance in LY x the hull's base amount per LY (SDE attribute
	//   jumpDriveConsumptionAmount, 868; the isotope is attribute 866) x (1 - 10% x Jump Fuel Conservation level)
	//   x (1 - 10% x Jump Freighters level, Jump Freighters only) x the hull's role bonus (none today), the factors
	//   multiplied; it depends on the straight-line distance, not on the number of jumps, and a route's fuel is
	//   the sum of its jumps. Jump Drive Economizer rigs (Jump Freighters / Rorqual) are not counted. The skill
	//   amounts are read from the SDE (dogma effects that modify 868: skill 21610 JFC attribute 1296 = -10 per
	//   level; Jump Freighters effect eliteBonusJumpFreighterJumpDriveConsumptionAmount2, attribute 1312 = -10 per
	//   level) and stored in ships.json by jumprange/tools/generate-coords.js. Formula:
	//   https://wiki.eveuniversity.org/Jump_drives (section on fuel). The source gives no rounding rule: the
	//   total of each jump is rounded up to whole units (assumed, so the estimate is never short).
	// - Incursions (checked 2026-10-12): a Sansha incursion puts a system-wide cynosural field jammer on the affected
	//   constellation's systems ("System-wide cynosural field jammers are in effect"); it stops normal cynos, not
	//   covert ones ("does not stop you from lighting a covert cynosural field"), and has no effect in high-sec.
	//   https://wiki.eveuniversity.org/Incursions . ESI /incursions/ lists the systems as infested_solar_systems.
	// - Jump fatigue (checked 2026-10-12, https://wiki.eveuniversity.org/Jump_fatigue): with D = the light-years just
	//   jumped after the ship's reduction, and F the fatigue before the jump (minutes):
	//     new fatigue          = min(300, max(10 x (1 + D), F x (1 + D)))       cap 5 hours
	//     jump activation wait = min(30, max(1 + D, F / 10))                    cap 30 minutes, uses F BEFORE this jump
	//   Fatigue also "decays in real time, whether logged in or not" (1 minute per minute), so a route that waits out each
	//   cooldown has F - wait left before its next jump.
	//   (the wiki: the cooldown is "one tenth of the pilot's Jump Fatigue value (before the jump fatigue is recalculated
	//   for this jump)"). Reductions of the distance: 90% for Jump Freighters and Capital Industrial Ships (Rorqual) and
	//   75% for Black Ops battleships; none for carriers, dreadnoughts, FAX, supers, titans and Lancers. CCP's
	//   change that introduced it: https://www.eveonline.com/news/view/phoebe-travel-change-update
	LY_M: 9.4607e15,
	SCALE: 1000,				// systems.json stores positions in 0.001 LY
	JDC_STEP: 0.2,
	JFC_ID: 21610,				// Jump Fuel Conservation: -10% jump fuel per level, every hull (SDE: ships.json meta.fuelSkill)
	JFC_STEP: 0.1,
	SKILL_MAX: 5,
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
	 *        covert: the ship can use covert cynos, which work in jammed systems,
	 *        avoidIncursions + incursion: {systemID: truthy}: systems in a Sansha incursion are jammed too (see "Game rules")}
	 */
	isValidCynoTarget: function(systemID, sys, opts) {
		const o = opts || {};
		const kind = jumpRange.kind(systemID, sys);
		if (kind === "ls") { if (o.lowsec === false) { return false; } }
		else if (kind === "ns") { if (o.nullsec === false) { return false; } }
		else { return false; }
		if (o.jammed && o.jammed[systemID] && !o.covert) { return false; }
		// An incursion's cyno jammer: not for normal cynos (covert still works), only when asked to avoid them
		return !(o.avoidIncursions && o.incursion && o.incursion[systemID] && !o.covert);
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
	 * @param opts see isValidCynoTarget; with scoring data (see isScoring) the midpoints are ranked like routePlan does
	 * @return {jumps: 0 | 1 | 2 | null (not within maxJumps or not possible), direct: LY, via: [{id, ly1, ly2}]
	 *   (2 jumps: every midpoint, best first: shortest longer leg, then shortest total; with scoring data also
	 *   {station, kills, avoided, cost}, best cost first), reason (when null), cause (reason "target": "jammed" | "incursion" | "target")}
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
		if (!jumpRange.isValidCynoTarget(destID, systems[destID], o)) { result.reason = "target"; result.cause = jumpRange.invalidCause(destID, systems[destID], o); return result; }
		if (result.direct <= rangeLy) { result.jumps = 1; return result; }
		if (max < 2 || result.direct > 2 * rangeLy) { result.reason = "range"; return result; }
		jumpRange.within(index, origin, rangeLy).forEach(function(hit) {
			if (hit.id === Number(originID) || hit.id === Number(destID)) { return; }
			if (!jumpRange.isValidCynoTarget(hit.id, systems[hit.id], o)) { return; }
			const ly2 = jumpRange.distanceLy(index.pos[hit.id], dest);
			if (ly2 <= rangeLy) { result.via.push({ id: hit.id, ly1: hit.ly, ly2: ly2 }); }
		});
		if (jumpRange.isScoring(o)) {
			// Scored like routePlan: legs plus the midpoint penalties (stations, kills, avoided systems), then the shorter longer leg
			result.via.forEach(function(v) { Object.assign(v, jumpRange.midpointFacts(v.id, o)); v.cost = v.ly1 + v.ly2 + jumpRange.midpointPenalty(v.id, o); });
			result.via.sort(function(a, b) {
				return a.cost - b.cost || Math.max(a.ly1, a.ly2) - Math.max(b.ly1, b.ly2) || a.id - b.id;
			});
		} else {
			result.via.sort(function(a, b) {
				return Math.max(a.ly1, a.ly2) - Math.max(b.ly1, b.ly2) || (a.ly1 + a.ly2) - (b.ly1 + b.ly2) || a.id - b.id;
			});
		}
		if (result.via.length) { result.jumps = 2; } else { result.reason = "range"; }
		return result;
	},

	/**
	 * Ship presets from ships.json: one per ship group (and base range, should a group ever have two), sorted by label.
	 * @return [{key ("group-<groupID>" or "group-<groupID>-<LY>"), label, group, baseLy, covert, ships: [names],
	 *   hulls: [{typeID, name, fuelTypeID, fuelName, fuelPerLy, fuelBonuses, fuelRole}] (the hulls with jump fuel data, by name)}]
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
			const p = byKey[key] = byKey[key] || { key: key, group: s.group, baseLy: s.baseLy, covert: false, ships: [], hulls: [] };
			p.covert = p.covert || !!s.covert;
			p.ships.push(s.name);
			if (s.fuelPerLy > 0) {
				p.hulls.push({
					typeID: s.typeID, name: s.name, fuelTypeID: s.fuelTypeID, fuelName: s.fuelName || "", fuelPerLy: s.fuelPerLy,
					fuelBonuses: Array.isArray(s.fuelBonuses) ? s.fuelBonuses : [], fuelRole: Number(s.fuelRole) || 0
				});
			}
		});
		return Object.keys(byKey).map(function(k) {
			const p = byKey[k];
			p.ships.sort();
			p.hulls.sort(function(a, b) { return a.name.localeCompare(b.name); });
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

	// ---- Jump fuel ----

	/** A skill level as an integer 0-5; a missing or invalid level counts as 5 (the default) */
	skillLevel: function(level) {
		if (level === undefined || level === null || level === "") { return jumpRange.SKILL_MAX; }
		const n = Math.round(Number(level));
		return isFinite(n) ? Math.max(0, Math.min(jumpRange.SKILL_MAX, n)) : jumpRange.SKILL_MAX;
	},

	/**
	 * Isotopes one jump of ly light-years takes: ceil(fuelPerLy x ly x (1 - 0.1 x JFC) x (1 - perLevel x level for each
	 * of the hull's skill bonuses) x (1 - fuelRole)); see "Game rules relied on".
	 * @param ship a ships.json entry (or a preset's hull): {fuelPerLy, fuelBonuses: [{skillID, perLevel}], fuelRole}
	 * @param levels {<skillID>: 0-5}; a skill that is missing counts as 5
	 * @return whole units, or null when the ship has no fuel data or ly isn't a number
	 */
	fuelPerJump: function(ly, ship, levels) {
		const n = Number(ly);
		if (!ship || !(Number(ship.fuelPerLy) > 0) || ly === null || ly === undefined || !isFinite(n) || n < 0) { return null; }
		const lv = levels || {};
		let amount = Number(ship.fuelPerLy) * n * (1 - jumpRange.JFC_STEP * jumpRange.skillLevel(lv[jumpRange.JFC_ID]));
		(Array.isArray(ship.fuelBonuses) ? ship.fuelBonuses : []).forEach(function(b) {
			amount *= 1 - (Number(b.perLevel) || 0) * jumpRange.skillLevel(lv[b.skillID]);
		});
		amount *= 1 - (Number(ship.fuelRole) || 0);
		return Math.max(0, Math.ceil(amount - 1e-6));		// the epsilon keeps 10500.000000001 from becoming 10501
	},

	/** Isotopes for a route: the sum of its jumps' fuel (legs: LY per jump); null when there is no fuel data */
	routeFuel: function(legs, ship, levels) {
		if (!Array.isArray(legs)) { return null; }
		let sum = 0;
		for (let i = 0; i < legs.length; i++) {
			const f = jumpRange.fuelPerJump(legs[i], ship, levels);
			if (f === null) { return null; }
			sum += f;
		}
		return sum;
	},

	/** "Helium" from "Helium Isotopes" */
	fuelShortName: function(name) {
		return String(name === undefined || name === null ? "" : name).replace(/\s+Isotopes$/i, "");
	},

	/** "12,340 Helium" (or "12,340" without a ship / isotope name); "–" when the amount is unknown */
	formatFuel: function(amount, ship) {
		if (amount === null || amount === undefined || !isFinite(Number(amount))) { return "\u2013"; }
		const text = String(Math.round(Number(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		const name = ship ? jumpRange.fuelShortName(ship.fuelName) : "";
		return name ? text + " " + name : text;
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
	},

	/**
	 * Why a jump drive can't be used to leave a system (null when it can): "wh" (W-space, Thera), "zarzakh",
	 * "unknown" (no such system) or "nopos" (no position known). High-sec and Pochven are valid starts.
	 */
	startProblem: function(systemID, sys, index) {
		const kind = jumpRange.kind(systemID, sys);
		if (!kind) { return "unknown"; }
		if (!jumpRange.canJumpFrom(systemID, sys)) { return kind === "zarzakh" ? "zarzakh" : "wh"; }
		return index && index.pos[systemID] ? null : "nopos";
	},

	/**
	 * Routes from one start to each of several destinations (e.g. the chain's exits), at most 2 jumps each (routesFrom
	 * does any number of jumps; the panel's Get home uses it), ranked:
	 * reachable first (fewer jumps first, then shorter total LY, then id), then the rest by id. For 2 jumps the total is
	 * that of the midpoint shown (reach()'s first: the shortest longer leg, then the shortest total), not the shortest
	 * total over every midpoint.
	 * @param opts see isValidCynoTarget (jammed, covert, lowsec, nullsec)
	 * @return [{id, reach (reach() output), jumps (0-2 or null), legs ([LY] per jump), total (LY), via (midpoint id or null),
	 *   reason (null, or when not reachable: "range" | "jammed" | "target" | "origin" | "nopos")}]
	 */
	routesTo: function(startID, destIDs, rangeLy, index, systems, opts) {
		const o = opts || {};
		const out = (destIDs || []).map(function(destID) {
			const id = Number(destID);
			const r = jumpRange.reach(startID, id, rangeLy, index, systems, o, 2);
			const row = { id: id, reach: r, jumps: r.jumps, legs: [], total: Infinity, via: null, reason: null };
			if (r.jumps === 0) { row.total = 0; }
			else if (r.jumps === 1) { row.legs = [r.direct]; row.total = r.direct; }
			else if (r.jumps === 2) { row.via = r.via[0].id; row.legs = [r.via[0].ly1, r.via[0].ly2]; row.total = r.via[0].ly1 + r.via[0].ly2; }
			else if (r.reason === "target") {
				// Only the jam in the way: a valid target without it
				row.reason = jumpRange.isValidCynoTarget(id, systems[id], Object.assign({}, o, { jammed: null })) ? "jammed" : "target";
			} else { row.reason = r.reason === "unknown" ? "nopos" : r.reason; }
			return row;
		});
		out.sort(function(a, b) {
			const ra = a.jumps === null ? 1 : 0, rb = b.jumps === null ? 1 : 0;
			if (ra !== rb) { return ra - rb; }
			if (ra) { return a.id - b.id; }
			return a.jumps - b.jumps || a.total - b.total || a.id - b.id;
		});
		return out;
	},

	/**
	 * Routes from one start to each of several destinations with at most maxJumps jumps (generic: any start, any
	 * destinations, any limit; used for Get home today, meant for JF / Black Ops logistics too). One search per start,
	 * hop-limited and layered: layer k holds the systems first reached in exactly k jumps, each with its least total LY.
	 * That is exact for "fewest jumps, then least total LY": the cheapest k-jump route to a system first reached in k
	 * jumps only passes through systems first reached in their own layer (it could be shortened otherwise), so every
	 * system is expanded once. Midpoints and destinations must pass isValidCynoTarget; the start must pass canJumpFrom.
	 * Total LY stands for fuel (it is linear in the distance).
	 * @param opts see isValidCynoTarget (jammed, covert, lowsec, nullsec)
	 * @param maxJumps default 5
	 * @return [{id, jumps (0..maxJumps, or null), legs ([LY] per jump), path ([midpoint ids]), via (first midpoint id or null),
	 *   total (LY), direct (straight-line LY, NaN when a position is missing), reason (null, or when not reachable:
	 *   "range" | "jammed" | "target" | "origin" | "nopos")}], reachable first (fewer jumps, then shorter total LY, then id),
	 *   then the rest by id
	 */
	routesFrom: function(startID, destIDs, rangeLy, index, systems, opts, maxJumps) {
		const o = opts || {};
		const max = maxJumps === undefined ? 5 : Math.max(0, Math.floor(Number(maxJumps)) || 0);
		const start = Number(startID);
		const pos = index ? index.pos : {};
		const sys = systems || {};
		const valid = {};
		const isValid = function(id) {
			if (valid[id] === undefined) { valid[id] = jumpRange.isValidCynoTarget(id, sys[id], o); }
			return valid[id];
		};
		const ids = (destIDs || []).map(Number);
		const startOk = !!pos[start] && jumpRange.canJumpFrom(start, sys[start]);
		// The layered search, only when something can be reached
		const first = {};		// id -> {jumps, total, from}: the layer a system is first reached in, its least total LY, the system before it
		const want = {};
		let wanted = 0;
		ids.forEach(function(id) {
			if (id !== start && pos[id] && isValid(id) && !want[id]) { want[id] = true; wanted++; }
		});
		if (startOk && wanted && max > 0) {
			first[start] = { jumps: 0, total: 0, from: null };
			let frontier = [start];
			let left = wanted;
			for (let k = 1; k <= max && frontier.length && left > 0; k++) {
				const layer = {};
				frontier.forEach(function(u) {
					const base = first[u].total;
					jumpRange.within(index, pos[u], rangeLy).forEach(function(hit) {
						const v = hit.id;
						if (first[v] !== undefined || !isValid(v)) { return; }
						const total = base + hit.ly;
						const cur = layer[v];
						if (!cur || total < cur.total - 1e-9) {		// the frontier is in id order: the lowest id wins a tie
							layer[v] = { jumps: k, total: total, from: u };
						}
					});
				});
				frontier = Object.keys(layer).map(Number).sort(function(a, b) { return a - b; });
				frontier.forEach(function(v) { first[v] = layer[v]; if (want[v]) { left--; } });
			}
		}
		const out = ids.map(function(id) {
			const row = { id: id, jumps: null, legs: [], path: [], via: null, total: Infinity, direct: jumpRange.distanceLy(pos[start], pos[id]), reason: null };
			if (!pos[start] || !pos[id]) { row.reason = "nopos"; return row; }
			if (id === start) { row.jumps = 0; row.total = 0; return row; }
			if (!jumpRange.canJumpFrom(start, sys[start])) { row.reason = "origin"; return row; }
			if (!isValid(id)) {
				// Only the jam in the way: a valid target without it
				row.reason = jumpRange.isValidCynoTarget(id, sys[id], Object.assign({}, o, { jammed: null })) ? "jammed" : "target";
				return row;
			}
			if (first[id] === undefined) { row.reason = "range"; return row; }
			const chain = [id];
			for (let cur = first[id]; cur && cur.from !== null; cur = first[cur.from]) { chain.unshift(cur.from); }		// ends with the start
			row.jumps = first[id].jumps;
			row.path = chain.slice(1, -1);
			row.via = row.path.length ? row.path[0] : null;
			for (let i = 1; i < chain.length; i++) { row.legs.push(jumpRange.distanceLy(pos[chain[i - 1]], pos[chain[i]])); }
			row.total = row.legs.reduce(function(sum, ly) { return sum + ly; }, 0);
			return row;
		});
		out.sort(function(a, b) {
			const ra = a.jumps === null ? 1 : 0, rb = b.jumps === null ? 1 : 0;
			if (ra !== rb) { return ra - rb; }
			if (ra) { return a.id - b.id; }
			return a.jumps - b.jumps || a.total - b.total || a.id - b.id;
		});
		return out;
	},

	// ---- Midpoint scoring (which system to jump to) ----
	//
	// Like Dotlan's jump planner (https://evemaps.dotlan.net/jump: "Prefer Station Systems", "Avoid Incursions", avoided
	// systems, "Select Alternative Jump System"; its blog, post 1490, says routes are weighted by jumps, distance
	// travelled and distance to the destination, with some midpoints made more or less expensive: preferred ones cheaper,
	// avoided ones penalised rather than forbidden) and EVE Eye (https://eveeye.readthedocs.io/en/latest/navigation/jump-planning/:
	// "prefer less midpoints or fuel", "prefer station systems", "alternate midpoint"). Our model:
	//   cost of a route = sum of its legs in LY + the penalty of each midpoint (the start and the destination are
	//   fixed and never penalised); the penalty is in LY, so it trades off against distance.
	// Defaults (LY): a midpoint without an NPC station +3 (so a station or a quiet system wins over a slightly shorter
	// leg, but not over a clearly shorter one); each kill in the last hour +0.5, at most +5 (ten kills = camped); a
	// system the user avoids +50 (more than any detour a ship can make, so it is used only when nothing else gets
	// there, like Dotlan penalising rather than forbidding). In "jumps" mode the penalties never add a jump: fewest
	// jumps is the first key, the cost only picks among routes with that many.
	MIDPOINT_WEIGHTS: { noStation: 3, killEach: 0.5, killCap: 5, avoid: 50 },
	FATIGUE_CAP_MIN: 300,		// jump fatigue: 5 hours
	COOLDOWN_CAP_MIN: 30,		// jump activation wait: 30 minutes
	// Distance reduction of jump fatigue by ship group (Jump_fatigue wiki): Black Ops 75%, Jump Freighter and Capital
	// Industrial Ship (Rorqual) 90%; everything else (carriers, dreadnoughts, FAX, supers, titans, Lancers) 0.
	FATIGUE_REDUCTION: { 898: 0.75, 902: 0.9, 883: 0.9 },

	/** Fatigue distance reduction (0-0.9) for a ship group id */
	fatigueReduction: function(groupID) {
		return jumpRange.FATIGUE_REDUCTION[Number(groupID)] || 0;
	},

	/**
	 * Jump fatigue along a route (formulas in "Game rules relied on").
	 * @param legs LY per jump; reduction 0-1 (fatigueReduction); startFatigue minutes already on the pilot (default 0)
	 * @return {cooldowns: [minutes to wait after each jump but the last, before the next], waitTotal (their sum),
	 *   fatigueEnd (minutes of fatigue right after the last jump, i.e. on arrival), cooldownEnd (the wait after the last jump)}
	 *   The pilot waits out each cooldown before the next jump and fatigue decays 1 minute per minute meanwhile (the wiki's
	 *   example, 5 LY carrier jumps: 60 -> 54 after a 6 min wait -> 300 (cap) -> 294 after 6 min; third wait 29.4 min).
	 */
	fatigue: function(legs, reduction, startFatigue) {
		const red = Math.max(0, Math.min(1, Number(reduction) || 0));
		let f = Math.max(0, Number(startFatigue) || 0);
		const cooldowns = [];
		let cooldownEnd = 0;
		(Array.isArray(legs) ? legs : []).forEach(function(ly, i, all) {
			const d = Math.max(0, Number(ly) || 0) * (1 - red);
			const wait = Math.min(jumpRange.COOLDOWN_CAP_MIN, Math.max(1 + d, f / 10));		// uses the fatigue before this jump
			f = Math.min(jumpRange.FATIGUE_CAP_MIN, Math.max(10 * (1 + d), f * (1 + d)));
			if (i < all.length - 1) {
				cooldowns.push(wait);
				f = Math.max(0, f - wait);		// fatigue decays in real time (1 minute per minute), also while waiting out the cooldown
			} else { cooldownEnd = wait; }
		});
		return { cooldowns: cooldowns, waitTotal: cooldowns.reduce(function(a, b) { return a + b; }, 0), fatigueEnd: f, cooldownEnd: cooldownEnd };
	},

	/** "7 min", "1 h 12 min", "5 h" (minutes rounded up) */
	formatMinutes: function(minutes) {
		const m = Math.max(0, Math.ceil(Number(minutes) - 1e-9)) || 0;
		if (m < 60) { return m + " min"; }
		return Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
	},

	/** Whether options carry scoring data (stations, kills, avoided systems, incursions, a "prefer" mode) */
	isScoring: function(o) {
		return !!o && (o.prefer !== undefined || !!o.stations || !!o.kills || !!o.avoid || !!o.incursion);
	},

	/** Why a system is not a valid cyno target: "target" (security / switches / not k-space), "jammed" or "incursion" */
	invalidCause: function(systemID, sys, o) {
		const opts = o || {};
		if (!jumpRange.isValidCynoTarget(systemID, sys, Object.assign({}, opts, { jammed: null, avoidIncursions: false }))) { return "target"; }
		if (opts.jammed && opts.jammed[systemID] && !opts.covert) { return "jammed"; }
		return "incursion";
	},

	/**
	 * What the panel shows about a midpoint: {station (true / false, null when the station data is not there), kills
	 * (last hour, null when not loaded), avoided}
	 * @param o {stations: {systemID: count}, kills: {systemID: n}, avoid: {systemID: truthy}}
	 */
	midpointFacts: function(id, o) {
		const opts = o || {};
		return {
			station: opts.stations ? Number(opts.stations[id]) > 0 : null,
			kills: opts.kills ? Number(opts.kills[id]) || 0 : null,
			avoided: !!(opts.avoid && opts.avoid[id])
		};
	},

	/**
	 * Extra cost of using a system as a midpoint, in LY (see MIDPOINT_WEIGHTS).
	 * @param o {preferStations + stations, avoidKills + kills, avoid, weights (overrides MIDPOINT_WEIGHTS)}; data that
	 *   is not there (not loaded, fetch failed) adds nothing
	 */
	midpointPenalty: function(id, o) {
		const opts = o || {};
		const w = opts.weights ? Object.assign({}, jumpRange.MIDPOINT_WEIGHTS, opts.weights) : jumpRange.MIDPOINT_WEIGHTS;
		let p = 0;
		if (opts.preferStations && opts.stations && !(Number(opts.stations[id]) > 0)) { p += w.noStation; }
		if (opts.avoidKills && opts.kills) { p += Math.min(w.killCap, w.killEach * (Number(opts.kills[id]) || 0)); }
		if (opts.avoid && opts.avoid[id]) { p += w.avoid; }
		return p;
	},

	/**
	 * A route row from a chain of system ids [start, midpoints..., destination].
	 * @return {id, jumps, legs, path (midpoints), via (first midpoint or null), total (LY), cost (LY + midpoint penalties),
	 *   direct, mids: [{id, station, kills, avoided, penalty}], fuel (opts.ship + opts.levels: whole route, null without),
	 *   legFuel ([per jump]), fatigue (opts.reduction: jumpRange.fatigue of the legs), reason: null}
	 */
	describeRoute: function(chain, index, opts) {
		const o = opts || {};
		const pos = index.pos;
		const id = chain[chain.length - 1];
		const legs = [];
		for (let i = 1; i < chain.length; i++) { legs.push(jumpRange.distanceLy(pos[chain[i - 1]], pos[chain[i]])); }
		const path = chain.slice(1, -1);
		const mids = path.map(function(m) {
			return Object.assign({ id: m }, jumpRange.midpointFacts(m, o), { penalty: jumpRange.midpointPenalty(m, o) });
		});
		const total = legs.reduce(function(sum, ly) { return sum + ly; }, 0);
		return {
			id: id, jumps: legs.length, legs: legs, path: path, via: path.length ? path[0] : null, total: total,
			cost: total + mids.reduce(function(sum, m) { return sum + m.penalty; }, 0),
			direct: jumpRange.distanceLy(pos[chain[0]], pos[id]), mids: mids,
			fuel: o.ship && legs.length ? jumpRange.routeFuel(legs, o.ship, o.levels) : null,
			legFuel: o.ship ? legs.map(function(ly) { return jumpRange.fuelPerJump(ly, o.ship, o.levels); }) : [],
			fatigue: jumpRange.fatigue(legs, o.reduction), reason: null
		};
	},

	/**
	 * Routes from one start to each of several destinations with at most maxJumps jumps, choosing the midpoints by
	 * weighted cost (see "Midpoint scoring"). One hop-limited layered search per start: best[k][v] = the least cost of
	 * reaching v in exactly k jumps, relaxed from every system of layer k-1 (a system can be in several layers; the
	 * penalty of a midpoint is added when it is left, so the destination and the start are not penalised). A state that
	 * costs no less than the same system reached in fewer jumps is dropped (every continuation from it is available
	 * from the earlier one, cheaper), which keeps the layers small. Then per destination:
	 *   opts.prefer "jumps" (default): fewest jumps, then least cost at that jump count (never adds a jump for a penalty);
	 *   opts.prefer "fuel": least cost over all jump counts up to maxJumps (an extra midpoint when it saves distance;
	 *   ties: fewer jumps). Fuel is linear in LY, so the cost stands for it.
	 * Midpoints and destinations must be valid cyno targets (isValidCynoTarget: low/null-sec switches, jammed,
	 * incursions), the start must pass canJumpFrom.
	 * @param opts isValidCynoTarget options, plus prefer, preferStations + stations, avoidKills + kills, avoid, weights,
	 *   and for the rows: ship + levels (fuel), reduction (fatigue)
	 * @param maxJumps default 5
	 * @return rows like routesFrom's, plus describeRoute's fields, reason also "incursion"; reachable first (jumps
	 *   mode: fewer jumps, then shorter total LY; fuel mode: shorter total LY, then fewer jumps; then id), then the rest by id
	 */
	routePlan: function(startID, destIDs, rangeLy, index, systems, opts, maxJumps) {
		const o = opts || {};
		const fuelMode = o.prefer === "fuel";
		const max = maxJumps === undefined ? 5 : Math.max(0, Math.floor(Number(maxJumps)) || 0);
		const start = Number(startID);
		const pos = index ? index.pos : {};
		const sys = systems || {};
		const valid = {};
		const isValid = function(id) {
			if (valid[id] === undefined) { valid[id] = jumpRange.isValidCynoTarget(id, sys[id], o); }
			return valid[id];
		};
		const penalties = {};
		const penalty = function(id) {
			if (penalties[id] === undefined) { penalties[id] = jumpRange.midpointPenalty(id, o); }
			return penalties[id];
		};
		const neighbours = {};		// id -> [{id, ly}]: valid targets within range, computed once per system
		const near = function(u) {
			if (!neighbours[u]) {
				neighbours[u] = jumpRange.within(index, pos[u], rangeLy).filter(function(hit) { return hit.id !== u && isValid(hit.id); });
			}
			return neighbours[u];
		};
		const ids = (destIDs || []).map(Number);
		const startOk = !!pos[start] && jumpRange.canJumpFrom(start, sys[start]);
		const want = {};
		let left = 0;
		ids.forEach(function(id) {
			if (id !== start && pos[id] && isValid(id) && !want[id]) { want[id] = true; left++; }
		});
		const layers = [{}];		// layers[k][v] = {cost, from}: cost excludes v's own penalty
		if (startOk && left && max > 0) {
			layers[0][start] = { cost: 0, from: null };
			const best = {};		// the least cost any earlier layer reached a system with
			best[start] = 0;
			const reached = {};
			for (let k = 1; k <= max; k++) {
				const prev = layers[k - 1];
				const frontier = Object.keys(prev).map(Number).sort(function(a, b) { return a - b; });		// id order: the lowest id wins a tie
				if (!frontier.length) { break; }
				const layer = {};
				frontier.forEach(function(u) {
					const base = prev[u].cost + (k > 1 ? penalty(u) : 0);
					near(u).forEach(function(hit) {
						const v = hit.id;
						const total = base + hit.ly;
						if (best[v] !== undefined && total >= best[v] - 1e-9) { return; }		// dominated by an earlier layer
						const cur = layer[v];
						if (!cur || total < cur.cost - 1e-9) { layer[v] = { cost: total, from: u }; }
					});
				});
				Object.keys(layer).forEach(function(key) {
					const v = Number(key);
					best[v] = layer[v].cost;
					if (want[v] && !reached[v]) { reached[v] = true; left--; }
				});
				layers.push(layer);
				if (!fuelMode && left <= 0) { break; }		// jumps mode: every wanted system has its fewest-jump route
			}
		}
		const out = ids.map(function(id) {
			const blank = { id: id, jumps: null, legs: [], path: [], via: null, total: Infinity, cost: Infinity, mids: [], fuel: null, legFuel: [], fatigue: null,
				direct: jumpRange.distanceLy(pos[start], pos[id]), reason: null };
			if (!pos[start] || !pos[id]) { blank.reason = "nopos"; return blank; }
			if (id === start) { return Object.assign(jumpRange.describeRoute([start], index, o), { id: id, jumps: 0, direct: 0 }); }
			if (!jumpRange.canJumpFrom(start, sys[start])) { blank.reason = "origin"; return blank; }
			if (!isValid(id)) { blank.reason = jumpRange.invalidCause(id, sys[id], o); return blank; }
			let kBest = 0;
			for (let k = 1; k < layers.length; k++) {
				if (!layers[k][id]) { continue; }
				if (!kBest) { kBest = k; if (!fuelMode) { break; } }
				else if (layers[k][id].cost < layers[kBest][id].cost - 1e-9) { kBest = k; }		// a later layer only holds a strictly cheaper state
			}
			if (!kBest) { blank.reason = "range"; return blank; }
			const chain = [id];
			for (let k = kBest, cur = id; k >= 1; k--) { cur = layers[k][cur].from; chain.unshift(cur); }
			return jumpRange.describeRoute(chain, index, o);
		});
		out.sort(function(a, b) {
			const ra = a.jumps === null ? 1 : 0, rb = b.jumps === null ? 1 : 0;
			if (ra !== rb) { return ra - rb; }
			if (ra) { return a.id - b.id; }
			return fuelMode ? a.total - b.total || a.jumps - b.jumps || a.id - b.id : a.jumps - b.jumps || a.total - b.total || a.id - b.id;
		});
		return out;
	},

	/**
	 * A route that starts with chosen jumps (a pinned midpoint): prefix = [start, m1, ..., mk], then the best way on to
	 * the destination within maxJumps minus the jumps already made. A pin whose systems are not valid cyno targets any more
	 * (a new incursion, a jam, a switched-off security) is dropped: the planned route comes back with pinDropped: true.
	 * @return a routePlan row for the destination; jumps null (reason "range" etc.) when the rest cannot get there
	 */
	routeVia: function(prefix, destID, rangeLy, index, systems, opts, maxJumps) {
		const max = maxJumps === undefined ? 5 : Math.max(0, Math.floor(Number(maxJumps)) || 0);
		const chain = prefix.map(Number);
		const made = chain.length - 1;
		const last = chain[chain.length - 1];
		const sys = systems || {};
		if (chain.slice(1).some(function(id) { return !jumpRange.isValidCynoTarget(id, sys[id], opts); })) {
			return Object.assign(jumpRange.routePlan(chain[0], [destID], rangeLy, index, systems, opts, max)[0], { pinDropped: true });
		}
		if (made > max) { return jumpRange.routePlan(chain[0], [destID], rangeLy, index, systems, opts, 0)[0]; }
		if (last === Number(destID)) { return jumpRange.describeRoute(chain, index, opts); }
		const rest = jumpRange.routePlan(last, [destID], rangeLy, index, systems, opts, max - made)[0];
		if (rest.jumps === null) { return rest; }
		return jumpRange.describeRoute(chain.concat(rest.path, [Number(destID)]), index, opts);
	},

	/**
	 * "Select alternative jump system": every valid system within range of both ends of one jump pair (so the number of
	 * jumps stays the same), best first.
	 * @param opts isValidCynoTarget + scoring options
	 * @return [{id, ly1 (prev -> id), ly2 (id -> next), station, kills, avoided, penalty, cost (ly1 + ly2 + penalty)}], by cost, then id
	 */
	alternatives: function(prevID, nextID, rangeLy, index, systems, opts) {
		const o = opts || {};
		const prev = index && index.pos[prevID], next = index && index.pos[nextID];
		const out = [];
		if (!prev || !next) { return out; }
		jumpRange.within(index, prev, rangeLy).forEach(function(hit) {
			if (hit.id === Number(prevID) || hit.id === Number(nextID) || !jumpRange.isValidCynoTarget(hit.id, systems[hit.id], o)) { return; }
			const ly2 = jumpRange.distanceLy(index.pos[hit.id], next);
			if (!(ly2 <= rangeLy)) { return; }
			const penalty = jumpRange.midpointPenalty(hit.id, o);
			out.push(Object.assign({ id: hit.id, ly1: hit.ly, ly2: ly2 }, jumpRange.midpointFacts(hit.id, o), { penalty: penalty, cost: hit.ly + ly2 + penalty }));
		});
		out.sort(function(a, b) { return a.cost - b.cost || a.id - b.id; });
		return out;
	},

	// Wormhole size a jump ship needs, by ship group (hull mass, appData.mass / SDE, against the hole size classes
	// of size-tags.js: L up to 375-410 kt, VL up to 1,000 kt, XL 2,000 kt). Checked 2026-10-11:
	// - Black Ops 106-113 kt: battleship holes (L) and up.
	// - Jump Freighter 820-960 kt and Rorqual 800 kt: too heavy for L, need a freighter hole (VL) or bigger.
	// - Carrier, Dreadnought, FAX, Lancer, Command Carrier 1,100-1,310 kt: capital holes (XL) only.
	// - Supercarrier and Titan: "Supercapitals don't fit through wormholes" (https://wiki.eveuniversity.org/Wormhole_space).
	// Mass categories: https://wiki.eveuniversity.org/Wormhole_attributes. Hull mass only (plates, rigs and
	// propulsion modules add to it), so a warning, never a block.
	SIZE_ORDER: ["S", "M", "L", "VL", "XL"],
	SHIP_NEEDS: { 898: "L", 902: "VL", 883: "VL", 547: "XL", 485: "XL", 1538: "XL", 4594: "XL", 5120: "XL", 659: "none", 30: "none" },

	/** The smallest hole size class a ship group needs ("L" | "VL" | "XL"), "none" (can't use wormholes), or null (unknown) */
	shipNeeds: function(groupID) {
		return jumpRange.SHIP_NEEDS[Number(groupID)] || null;
	},

	/** Whether a ship that needs `need` (shipNeeds) fits through a hole of size class `size` (sizeTags.sizeOf):
	 * true, false, or null when either is unknown. A ship that can't use wormholes never fits. */
	holeFits: function(need, size) {
		if (need === "none") { return false; }
		const n = jumpRange.SIZE_ORDER.indexOf(need), s = jumpRange.SIZE_ORDER.indexOf(size);
		if (n < 0 || s < 0) { return null; }
		return s >= n;
	}
};
