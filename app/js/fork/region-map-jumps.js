const regionMapJumps = {
	// Fork-owned: the region map's "Jump range" overlay, pure logic (no DOM, testable in Node). Which systems of a region a
	// jump ship (Black Ops by default) can reach in one jump from an origin, and how far each one is. It reuses the Jump
	// planner's engine READ-ONLY (jumpRange in jump-range.js: decode, buildIndex, within, isValidCynoTarget, canJumpFrom,
	// reach, maxRange, presets, distanceLy) and its data (public/jumprange/systems.json, ships.json); none of that is
	// changed here. The rules (no cyno in high-sec, Pochven or Zarzakh; covert cynos for Black Ops; range = base x
	// (1 + 0.2 x JDC)) live in jump-range.js. The panel is region-map-view.js.
	// Keep `const regionMapJumps` on the first line: the test helper strips it to define a global.

	// The ship groups of ships.json, in the order of the overlay's list (key = jumpRange.presets key)
	SHIPS: [
		["group-898", "Black Ops"], ["group-902", "Jump Freighter"], ["group-883", "Rorqual"], ["group-547", "Carrier"],
		["group-5120", "Command Carrier"], ["group-485", "Dreadnought"], ["group-4594", "Lancer Dreadnought"],
		["group-1538", "Force Auxiliary"], ["group-659", "Supercarrier"], ["group-30", "Titan"]
	],
	SHIP_KEYS: { "group-898": ["blops", "bo", "covert"], "group-902": ["jf"], "group-1538": ["fax"], "group-485": ["dread"], "group-883": ["industrial"] },	// words the palette also matches
	DEFAULT_SHIP: "group-898",
	DEFAULT_JDC: 5,
	ROMAN: ["0", "I", "II", "III", "IV", "V"],
	CELL_LY: 7,		// spatial grid cell, as the Jump planner uses

	validShip: function(key) {
		return typeof key === "string" && regionMapJumps.SHIPS.some(function(s) { return s[0] === key; });
	},

	/** JDC level 0-5 (a missing or invalid level is 5) */
	jdc: function(level) {
		if (level === undefined || level === null || level === "") { return regionMapJumps.DEFAULT_JDC; }
		const n = Math.round(Number(level));
		return isFinite(n) ? Math.max(0, Math.min(5, n)) : regionMapJumps.DEFAULT_JDC;
	},

	/** A ship key from a typed word: the key itself, or a unique start of the name ("bl", "black ops", "jf"->Jump Freighter) */
	shipFromText: function(text) {
		const t = String(text === undefined || text === null ? "" : text).trim().toLowerCase();
		if (!t) { return null; }
		const alias = { blops: "group-898", bo: "group-898", jf: "group-902", fax: "group-1538", dread: "group-485", "dread.": "group-485" };
		if (alias[t]) { return alias[t]; }
		const exact = regionMapJumps.SHIPS.filter(function(s) { return s[0] === t || s[1].toLowerCase() === t; })[0];
		if (exact) { return exact[0]; }
		const starts = regionMapJumps.SHIPS.filter(function(s) { return s[1].toLowerCase().indexOf(t) === 0; });
		return starts.length === 1 ? starts[0][0] : null;
	},

	shipLabel: function(key) {
		const s = regionMapJumps.SHIPS.filter(function(x) { return x[0] === key; })[0];
		return s ? s[1] : "";
	},

	/** {ship, jdc, origin} from options.regionMap.jump; origin is "selected" (default), "you" or "exit:<systemID>" */
	settings: function(opts) {
		const j = opts && opts.regionMap && opts.regionMap.jump && typeof opts.regionMap.jump === "object" ? opts.regionMap.jump : {};
		const origin = typeof j.origin === "string" && /^(selected|you|exit:\d+)$/.test(j.origin) ? j.origin : "selected";
		return { ship: regionMapJumps.validShip(j.ship) ? j.ship : regionMapJumps.DEFAULT_SHIP, jdc: regionMapJumps.jdc(j.jdc), origin: origin };
	},

	/** The jump part of options.regionMap after a change ({ship, jdc, origin}); invalid values are ignored */
	withJump: function(opts, change) {
		const cur = regionMapJumps.settings(opts), c = change || {};
		return {
			ship: c.ship !== undefined && regionMapJumps.validShip(c.ship) ? c.ship : cur.ship,
			jdc: c.jdc !== undefined ? regionMapJumps.jdc(c.jdc) : cur.jdc,
			origin: c.origin !== undefined && /^(selected|you|exit:\d+)$/.test(String(c.origin)) ? c.origin : cur.origin
		};
	},

	/**
	 * The origins the dropdown offers and which one is used. env: {selected: systemID|null, me: systemID|null,
	 * exits: [systemID], systems: appData.systems, choice: the remembered value}.
	 * An origin must be somewhere a jump drive works (jumpRange.canJumpFrom). Falls back selected -> you -> first exit.
	 * @return {options: [{value, label, id}], value (the one used), id (its system, or null)}
	 */
	origins: function(env) {
		const systems = env.systems || {}, name = function(id) { return systems[id] && systems[id].name ? systems[id].name : String(id); };
		const ok = function(id) { return !!id && jumpRange.canJumpFrom(id, systems[id]); };
		const list = [];
		if (ok(env.selected)) { list.push({ value: "selected", label: "Selected: " + name(env.selected), id: Number(env.selected) }); }
		if (ok(env.me)) { list.push({ value: "you", label: "You: " + name(env.me), id: Number(env.me) }); }
		(env.exits || []).forEach(function(x) {
			if (ok(x)) { list.push({ value: "exit:" + x, label: "Exit: " + name(x), id: Number(x) }); }
		});
		// A chosen origin where no jump drive works is reported, not quietly replaced by another one
		const m = /^exit:(\d+)$/.exec(String(env.choice));
		const wanted = env.choice === "selected" ? env.selected : env.choice === "you" ? env.me : m ? Number(m[1]) : null;
		const problem = wanted && !ok(wanted) ? regionMapJumps.noDrive(wanted, systems[wanted]) : "";
		if (problem) { return { options: list, value: env.choice, id: null, problem: problem }; }
		const used = list.filter(function(o) { return o.value === env.choice; })[0]
			|| list.filter(function(o) { return o.value === "selected"; })[0] || list.filter(function(o) { return o.value === "you"; })[0] || list[0] || null;
		return { options: list, value: used ? used.value : "", id: used ? used.id : null };
	},

	/** Why no jump drive can be used from a system ("" if one can): wormhole space and Zarzakh. (High-sec is fine: the drive works
	there, it is only the target that cannot be in high-sec.) */
	noDrive: function(systemID, system) {
		if (!system || jumpRange.canJumpFrom(systemID, system)) { return ""; }
		const kind = jumpRange.kind(systemID, system), name = system.name || String(systemID);
		if (kind === "wh") { return name + " is wormhole space: no jump drive from there"; }
		if (kind === "zarzakh") { return name + ": no jump drive can be used from there"; }
		return "No jump drive can be used from " + name;
	},

	/** The cyno rules for a ship preset: Black Ops light covert cynos; everyone is kept out of high-sec by the engine */
	engineOptions: function(preset) {
		return { lowsec: true, nullsec: true, covert: !!(preset && preset.covert), jammed: {} };
	},

	ly: function(n) { return (Math.round(n * 10) / 10).toFixed(1) + " LY"; },

	/**
	 * What the overlay shows for a set of systems. env: {originID, preset (jumpRange.presets entry), jdc, index
	 * (jumpRange.buildIndex), systems (appData.systems), ids: the systems to classify}.
	 * @return {error: "" | "origin" | "nodata", range (LY), label ("Black Ops (JDC V)"), originKind,
	 *   rows: {systemID: {ly, state}}, inRange: number} where state is "origin", "in" (a valid jump target within range),
	 *   "out" (valid target, too far) or "bad" (no cyno possible there: high-sec, Pochven, Zarzakh, wormhole space)
	 */
	compute: function(env) {
		const out = { error: "", range: 0, label: "", originKind: null, rows: {}, inRange: 0 };
		const preset = env.preset, jdc = regionMapJumps.jdc(env.jdc);
		if (!preset || !env.index) { out.error = "nodata"; return out; }
		out.range = jumpRange.maxRange(preset.baseLy, jdc);
		out.label = regionMapJumps.shipLabel(preset.key) || preset.group || preset.label;
		out.label += " (JDC " + regionMapJumps.ROMAN[jdc] + ")";
		const origin = env.index.pos[env.originID];
		out.originKind = jumpRange.kind(env.originID, env.systems[env.originID]);
		if (!origin) { out.error = "nodata"; return out; }
		if (!jumpRange.canJumpFrom(env.originID, env.systems[env.originID])) { out.error = "origin"; return out; }
		const opts = regionMapJumps.engineOptions(preset);
		(env.ids || []).forEach(function(id) {
			const p = env.index.pos[id];
			if (!p) { return; }
			const ly = jumpRange.distanceLy(origin, p);
			let state;
			if (Number(id) === Number(env.originID)) { state = "origin"; }
			else if (!jumpRange.isValidCynoTarget(id, env.systems[id], opts)) { state = "bad"; }
			else { state = ly <= out.range ? "in" : "out"; }
			if (state === "in") { out.inRange++; }
			out.rows[id] = { ly: ly, state: state };
		});
		return out;
	},

	/** Why a system cannot be a jump target, in words ("" if it can) */
	badReason: function(systemID, system) {
		const kind = jumpRange.kind(systemID, system);
		return { hs: "High-sec: no cyno can be lit", pochven: "Pochven: cynos are jammed", zarzakh: "Zarzakh: no cyno", wh: "Wormhole space: no jump drive target" }[kind] || "No cyno target";
	},

	/**
	 * The card/tooltip line for one system. res = compute() output, row = res.rows[id], plus (for a system that is out of one
	 * jump) the two-jump answer jumpRange.reach(...): {jumps, via: [{id, ly1, ly2}]}; name(id) -> system name.
	 */
	describe: function(res, row, reach, name, system, systemID) {
		if (!row) { return ""; }
		if (row.state === "origin") { return "Jump origin · range " + regionMapJumps.ly(res.range) + " · " + res.inRange + " in range here"; }
		const d = regionMapJumps.ly(row.ly);
		if (row.state === "in") { return d + " · in range for " + res.label; }
		if (row.state === "bad") { return d + " · " + regionMapJumps.badReason(systemID, system); }
		if (reach && reach.jumps === 2 && reach.via && reach.via.length) {
			const v = reach.via[0];
			return d + " · 2 jumps via " + name(v.id) + " (" + regionMapJumps.ly(v.ly1) + " + " + regionMapJumps.ly(v.ly2) + ")";
		}
		return d + " · out of range (max " + regionMapJumps.ly(res.range) + ")" + (reach && reach.jumps === null && reach.reason === "range" ? ", not even in 2 jumps" : "");
	}
};
