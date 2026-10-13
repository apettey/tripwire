const regionMap = {
	// Fork-owned: the Dotlan-style region map, pure logic (no DOM, testable in Node). The panel is region-map-view.js.
	// Layout data: public/region-map/<regionID>.json, generated from CCP's SDE `position2D` by
	// tools/fork/build-region-maps.mjs (units of 0.01 light years, y down).
	// Keep `const regionMap` on the first line: the test helper strips it to define a global.

	SCALE: 1.4,				// layout unit -> map pixel at zoom 1 (SDE spacing 0.65 ly = 65 units -> 91 px between systems)
	BOX_W: 74, BOX_H: 22,	// a system's box
	STUB_LEN: 54,			// length of a gate leaving the region, from the edge of the box
	MIN_ZOOM: 0.2, MAX_ZOOM: 6,
	OVERLAYS: ["exits", "pilots", "fight", "route", "constellations", "skyhooks", "targets"],	// toggles in the panel header; all on by default
	SIDE_LISTS: ["targets", "skyhooks"],	// collapsible lists in the side panel (options.regionMap.collapsed[name]; missing = open)
	HEAT: {
		none: { label: "No heat" },
		npc: { label: "NPC kills", key: "npcKills", floor: 60, colour: "#ff9a1f" },
		ships: { label: "Ship kills", key: "shipKills", floor: 6, colour: "#ff3b3b" },
		jumps: { label: "Jumps", key: "shipJumps", floor: 40, colour: "#3fa9ff" }
	},
	TARGET_RE: /^(s|r):(\d+)$/,

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	// ---- Settings (options.regionMap) ----

	/** {enabled, overlays: {exits, pilots, fight, route, constellations, skyhooks, targets}, heat, collapsed: {targets, skyhooks}}; a missing key
	means the default (on / none / open) */
	settings: function(opts) {
		const o = (opts && opts.regionMap && typeof opts.regionMap === "object") ? opts.regionMap : {};
		const overlays = {};
		regionMap.OVERLAYS.forEach(function(name) { overlays[name] = !(o.overlays && o.overlays[name] === false); });
		const collapsed = {};
		regionMap.SIDE_LISTS.forEach(function(name) { collapsed[name] = !!(o.collapsed && o.collapsed[name] === true); });
		return { enabled: o.enabled !== false, overlays: overlays, heat: regionMap.validHeat(o.heat) ? o.heat : "none", collapsed: collapsed };
	},

	validHeat: function(kind) { return typeof kind === "string" && Object.prototype.hasOwnProperty.call(regionMap.HEAT, kind); },

	/** options.regionMap after changing one part; the rest of the user's choices are kept */
	withSetting: function(opts, change) {
		const cur = regionMap.settings(opts), next = { enabled: cur.enabled, overlays: Object.assign({}, cur.overlays), heat: cur.heat, collapsed: Object.assign({}, cur.collapsed) };
		if (change.enabled !== undefined) { next.enabled = !!change.enabled; }
		if (change.heat !== undefined && regionMap.validHeat(change.heat)) { next.heat = change.heat; }
		// The jump overlay's ship, JDC level and origin (regionMapJumps.withJump builds it); kept as it is when something else changes
		const jump = change.jump !== undefined ? change.jump : (opts && opts.regionMap && opts.regionMap.jump);
		if (jump && typeof jump === "object") { next.jump = jump; }
		if (change.overlay && regionMap.OVERLAYS.indexOf(change.overlay.name) >= 0) { next.overlays[change.overlay.name] = !!change.overlay.on; }
		if (change.collapsed && regionMap.SIDE_LISTS.indexOf(change.collapsed.name) >= 0) { next.collapsed[change.collapsed.name] = !!change.collapsed.on; }
		return next;
	},

	// ---- Security colours (the in-game scale) ----

	/** Security as the game shows it: one decimal, never below 0.0, and above 0 never below 0.1 */
	secBucket: function(sec) {
		const s = Number(sec);
		if (!isFinite(s) || s <= 0) { return 0; }
		return Math.min(1, Math.max(0.1, Math.round(s * 10) / 10));
	},

	SEC_COLOURS: ["#f00000", "#d73000", "#f04800", "#f06000", "#d77700", "#efef00", "#8fef2f", "#00f000", "#00ef47", "#48f0c0", "#2fefef"],

	secColour: function(sec) { return regionMap.SEC_COLOURS[Math.round(regionMap.secBucket(sec) * 10)]; },
	secText: function(sec) { return regionMap.secBucket(sec).toFixed(1); },
	secClass: function(sec) { const b = regionMap.secBucket(sec); return b >= 0.5 ? "high" : b > 0 ? "low" : "null"; },

	// ---- Systems of the universe (appData.systems) ----

	/** K-space: a known system without a wormhole class, outside the wormhole regions (Pochven counts) */
	isKSpace: function(system) {
		return !!system && !system.class && (Number(system.regionID) || 0) > 0 && Number(system.regionID) < 11000000;
	},

	/** Whether a system gets the "Region map" entry in the chain map's menu and the system panel: any k-space system */
	canOpen: function(system) { return regionMap.isKSpace(system); },

	// ---- Layout files ----

	/** A region file (parsed JSON) as drawable geometry in map pixels, or null if it is not a region file */
	normaliseRegion: function(raw) {
		if (!raw || typeof raw !== "object" || !Array.isArray(raw.systems) || !raw.systems.length || !Number(raw.id)) { return null; }
		const K = regionMap.SCALE, systems = [], byId = {};
		const num = function(v) { return typeof v === "number" && isFinite(v); };
		raw.systems.forEach(function(row) {
			if (!Array.isArray(row) || !num(row[0]) || !num(row[2]) || !num(row[3])) { return; }
			const s = { id: row[0], name: String(row[1]), x: row[2] * K, y: row[3] * K, c: num(row[4]) ? row[4] : 0, sec: num(row[5]) ? row[5] : 0 };
			systems.push(s);
			byId[s.id] = s;
		});
		if (!systems.length) { return null; }
		const constellations = (Array.isArray(raw.constellations) ? raw.constellations : []).map(function(c, i) {
			return { index: i, id: c[0], name: String(c[1]), ids: [], points: [], cx: 0, cy: 0 };
		});
		systems.forEach(function(s) {
			const c = constellations[s.c];
			if (c) { c.ids.push(s.id); }
		});
		constellations.forEach(function(c) {
			const members = c.ids.map(function(id) { return byId[id]; });
			c.cx = members.reduce(function(n, s) { return n + s.x; }, 0) / Math.max(1, members.length);
			c.cy = members.reduce(function(n, s) { return n + s.y; }, 0) / Math.max(1, members.length);
			c.points = regionMap.hull(members.reduce(function(list, s) {
				const w = regionMap.BOX_W / 2, h = regionMap.BOX_H / 2;
				return list.concat([[s.x - w, s.y - h], [s.x + w, s.y - h], [s.x + w, s.y + h], [s.x - w, s.y + h]]);
			}, []));
		});
		const edges = [];
		(Array.isArray(raw.gates) ? raw.gates : []).forEach(function(g) {
			const a = byId[g[0]], b = byId[g[1]];
			if (a && b) { edges.push({ a: a.id, b: b.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y }); }
		});
		const stubs = [];
		(Array.isArray(raw.links) ? raw.links : []).forEach(function(l) {
			const a = byId[l[0]];
			if (!a || !num(l[4]) || !num(l[5])) { return; }
			stubs.push(regionMap.stub(a, { toSystemID: l[1], toRegionID: l[2], toName: String(l[3]), dx: l[4], dy: l[5] }));
		});
		let w = 0, h = 0;
		systems.forEach(function(s) { w = Math.max(w, s.x); h = Math.max(h, s.y); });
		return { id: raw.id, name: String(raw.name || raw.id), systems: systems, byId: byId, constellations: constellations, edges: edges, stubs: stubs,
			w: w + regionMap.STUB_LEN + 80, h: h + regionMap.STUB_LEN + 60 };
	},

	/** The stub of a gate leaving the region: from the box edge of system a in the direction of the neighbour */
	stub: function(a, link) {
		const len = Math.hypot(link.dx, link.dy) || 1, ux = link.dx / len, uy = link.dy / len;
		// distance from the box centre to its edge along (ux, uy)
		const edge = Math.min(ux ? (regionMap.BOX_W / 2) / Math.abs(ux) : Infinity, uy ? (regionMap.BOX_H / 2) / Math.abs(uy) : Infinity);
		return {
			from: a.id, toSystemID: link.toSystemID, toRegionID: link.toRegionID, toName: link.toName,
			x1: a.x + ux * edge, y1: a.y + uy * edge, x2: a.x + ux * (edge + regionMap.STUB_LEN), y2: a.y + uy * (edge + regionMap.STUB_LEN), ux: ux, uy: uy
		};
	},

	/** Convex hull of [[x, y]] (monotone chain), counter-clockwise; fewer than 3 distinct points are returned as they are */
	hull: function(points) {
		const pts = points.slice().sort(function(p, q) { return p[0] - q[0] || p[1] - q[1]; })
			.filter(function(p, i, all) { return !i || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]; });
		if (pts.length < 3) { return pts; }
		const cross = function(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
		const build = function(list) {
			const out = [];
			list.forEach(function(p) {
				while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) { out.pop(); }
				out.push(p);
			});
			out.pop();
			return out;
		};
		return build(pts).concat(build(pts.slice().reverse()));
	},

	// ---- View maths: transform {k, x, y} maps map pixels to screen pixels (screen = map * k + (x, y)) ----

	clampZoom: function(k) { return Math.min(regionMap.MAX_ZOOM, Math.max(regionMap.MIN_ZOOM, k)); },

	/** Zoom and offset that show the whole layout in a view of the given size (never magnified past 1) */
	fit: function(layout, viewW, viewH) {
		const pad = 16;
		const k = regionMap.clampZoom(Math.min(1, Math.max(1, viewW - 2 * pad) / layout.w, Math.max(1, viewH - 2 * pad) / layout.h));
		return { k: k, x: (viewW - layout.w * k) / 2, y: (viewH - layout.h * k) / 2 };
	},

	/** Transform that puts map point (px, py) in the middle of the view at zoom k */
	centreOn: function(px, py, k, viewW, viewH) {
		const z = regionMap.clampZoom(k);
		return { k: z, x: viewW / 2 - px * z, y: viewH / 2 - py * z };
	},

	/** Zoom factor of one wheel event: deltaMode 0 = pixels, 1 = lines (Firefox mice, x16), 2 = pages (x400); one event never
	zooms by more than about 1.6x either way */
	wheelFactor: function(deltaY, deltaMode) {
		const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
		const d = Math.max(-300, Math.min(300, (Number(deltaY) || 0) * unit));
		return Math.exp(-d * 0.0016);
	},

	/** Keep at least `margin` px of the map in view when panning: t = {k, x, y}, layout {w, h} */
	clampPan: function(t, layout, viewW, viewH, margin) {
		const m = margin === undefined ? 80 : margin;
		const clamp = function(v, size, view) { return Math.min(view - m, Math.max(m - size, v)); };
		return { k: t.k, x: clamp(t.x, layout.w * t.k, viewW), y: clamp(t.y, layout.h * t.k, viewH) };
	},

	/** Zoom by a factor keeping the map point under screen point (sx, sy) where it is */
	zoomAt: function(t, sx, sy, factor) {
		const k = regionMap.clampZoom(t.k * factor), r = k / t.k;
		return { k: k, x: sx - (sx - t.x) * r, y: sy - (sy - t.y) * r };
	},

	// ---- Overlays ----

	/** 0..1 heat of a value: logarithmic against the busiest system of the region, but never lighter than `floor` says
	(a quiet region must not look hot). max: the region's largest value, floor: the value that counts as full heat at least */
	heatLevel: function(value, max, floor) {
		const v = Number(value);
		if (!isFinite(v) || v <= 0) { return 0; }
		const top = Math.max(Number(max) || 0, Number(floor) || 1);
		return Math.min(1, Math.log(1 + v) / Math.log(1 + top));
	},

	/** Heat of every listed system for a kind (npc / ships / jumps). activity: {systemID: {npcKills, shipKills, shipJumps}}.
	@return {levels: {systemID: 0..1}, values: {systemID: n}, max} (only systems with a value above 0) */
	heatMap: function(kind, systemIDs, activity) {
		const def = regionMap.validHeat(kind) ? regionMap.HEAT[kind] : null;
		const out = { levels: {}, values: {}, max: 0 };
		if (!def || !def.key) { return out; }
		systemIDs.forEach(function(id) {
			const v = Number(activity && activity[id] && activity[id][def.key]) || 0;
			if (v > 0) { out.values[id] = v; out.max = Math.max(out.max, v); }
		});
		Object.keys(out.values).forEach(function(id) { out.levels[id] = regionMap.heatLevel(out.values[id], out.max, def.floor); });
		return out;
	},

	/** The hole name of a chain exit: the first word of the signature name the hole carries ("B2 - Drifter" -> "B2") */
	holeLabel: function(name) {
		const m = /^[A-Za-z0-9]+/.exec(String(name === undefined || name === null ? "" : name).trim());
		return m ? m[0].toUpperCase() : "";
	},

	/** The hole name as shown in the pill on the map: at most 6 characters (the full name goes in the tooltip) */
	pillText: function(hole) { return String(hole || "").substring(0, 6); },

	/** Chain exits that lie in this region. exitIDs: chain.data.exits (strings or numbers); chainSystems:
	chain.data.systemsInChainMap (row.pathHome ends with the exit's own node, whose name is the hole's name).
	@return [{systemID, hole}] in the order given */
	exitsIn: function(layout, exitIDs, chainSystems) {
		const out = [];
		(exitIDs || []).forEach(function(raw) {
			const id = Number(raw);
			if (!layout || !layout.byId[id]) { return; }
			out.push({ systemID: id, hole: regionMap.exitHole(id, chainSystems) });
		});
		return out;
	},

	/** The hole name of one chain exit ("" if it has none, e.g. the chain's home system) */
	exitHole: function(systemID, chainSystems) {
		const row = chainSystems && chainSystems[systemID];
		const path = row && Array.isArray(row.pathHome) ? row.pathHome : [];
		const last = path.length ? path[path.length - 1] : null;
		return last && last.name ? regionMap.holeLabel(last.name) : "";
	},

	/** Pilots per system for the overlay: occupied = [{systemID, count}] (everyone tracked on the mask), you = the active
	character's system (or null). @return {systemID: {count, you}} */
	pilots: function(occupied, you) {
		const out = {};
		(occupied || []).forEach(function(o) {
			const id = Number(o && o.systemID), n = Number(o && o.count) || 0;
			if (id && n > 0) { out[id] = { count: n, you: false }; }
		});
		if (you) {
			const id = Number(you);
			if (!out[id]) { out[id] = { count: 0, you: true }; } else { out[id].you = true; }
		}
		return out;
	},

	// ---- Routes ----

	/** A path from guidance (system ids minus 30000000 or real) as real ids, or null */
	realPath: function(path) {
		if (!Array.isArray(path) || !path.length) { return null; }
		const ids = path.map(function(n) { n = Number(n); return n > 0 && n < 30000000 ? n + 30000000 : n; });
		return ids.every(function(n) { return n >= 30000000 && n < 32000000; }) ? ids : null;
	},

	/** Gate route between two systems with the user's route preferences. findPath(map, start, end): guidance.findShortestPath.
	@return {path: [real ids from -> to], jumps} or null */
	route: function(findPath, map, fromID, toID) {
		if (!fromID || !toID) { return null; }
		if (Number(fromID) === Number(toID)) { return { path: [Number(fromID)], jumps: 0 }; }
		const path = regionMap.realPath(findPath(map, Number(fromID), Number(toID)));
		return path ? { path: path, jumps: path.length - 1 } : null;
	},

	/** Shortest route from any of several systems (chain exits) to a target. findPath is asked once: target -> all exits
	(guidance takes a list for either end, as offset ids), the answer is turned round.
	@return {path: [exit ... target], jumps, exit} or null */
	routeFromAny: function(findPath, map, exitIDs, toID) {
		const exits = (exitIDs || []).map(Number).filter(Boolean);
		if (!exits.length || !toID) { return null; }
		if (exits.indexOf(Number(toID)) >= 0) { return { path: [Number(toID)], jumps: 0, exit: Number(toID) }; }
		// guidance wants offset ids (id - 30000000) when a list is given
		const path = regionMap.realPath(findPath(map, Number(toID) - 30000000, exits.map(function(id) { return id - 30000000; })));
		if (!path) { return null; }
		path.reverse();
		return { path: path, jumps: path.length - 1, exit: path[0] };
	},

	/** What a route path means for a layout: gates drawn inside (as pairs) and the first system outside, if any. */
	routeInside: function(layout, path) {
		const inside = [], ids = {};
		(path || []).forEach(function(id, i) {
			if (!layout.byId[id]) { return; }
			ids[id] = true;
			const next = path[i + 1];
			if (next && layout.byId[next]) { inside.push([id, next]); }
		});
		return { edges: inside, ids: ids };
	},

	// ---- Where to go: command and search box ----

	/** Choices for the "Region map" command: every region with a map, then every k-space system. systems: appData.systems,
	regions: appData.regions ({id: {name}}). value "r:<regionID>" / "s:<systemID>". */
	choices: function(systems, regions) {
		const out = [];
		Object.keys(regions || {}).forEach(function(id) {
			if (Number(id) < 11000000 && regions[id] && regions[id].name) {
				out.push({ value: "r:" + id, title: String(regions[id].name), hint: "Region", keys: [] });
			}
		});
		out.sort(function(a, b) { return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; });
		const list = [];
		Object.keys(systems || {}).forEach(function(id) {
			const s = systems[id];
			if (regionMap.isKSpace(s) && s.name) {
				const region = regions && regions[s.regionID] ? regions[s.regionID].name : "";
				list.push({ value: "s:" + id, title: String(s.name), hint: regionMap.secText(s.security) + (region ? " · " + region : ""), keys: [] });
			}
		});
		list.sort(function(a, b) { return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; });
		return out.concat(list);
	},

	/** "s:30000142" -> {kind: "system", id}, "r:10000002" -> {kind: "region", id}; null for anything else */
	parseTarget: function(value) {
		const m = regionMap.TARGET_RE.exec(String(value === undefined || value === null ? "" : value).trim());
		return m ? { kind: m[1] === "s" ? "system" : "region", id: Number(m[2]) } : null;
	},

	/** Typed text (the panel's search box, or a one-line command) -> target. A system name or a region name; exact match
	first, then a single name that starts with the text (systems before regions); null if nothing or several match. */
	resolveText: function(text, systems, regions) {
		const t = String(text === undefined || text === null ? "" : text).trim().toLowerCase();
		if (!t) { return null; }
		const sys = [], reg = [];
		Object.keys(systems || {}).forEach(function(id) {
			const s = systems[id];
			if (regionMap.isKSpace(s) && s.name) { sys.push({ kind: "system", id: Number(id), name: String(s.name).toLowerCase() }); }
		});
		Object.keys(regions || {}).forEach(function(id) {
			if (Number(id) < 11000000 && regions[id] && regions[id].name) { reg.push({ kind: "region", id: Number(id), name: String(regions[id].name).toLowerCase() }); }
		});
		const exact = sys.concat(reg).filter(function(c) { return c.name === t; });
		if (exact.length) { return { kind: exact[0].kind, id: exact[0].id }; }
		const starts = sys.filter(function(c) { return c.name.indexOf(t) === 0; });
		if (starts.length === 1) { return { kind: "system", id: starts[0].id }; }
		if (starts.length > 1) { return null; }
		const regs = reg.filter(function(c) { return c.name.indexOf(t) === 0; });
		return regs.length === 1 ? { kind: "region", id: regs[0].id } : null;
	},

	/** The region a target opens, and the system to centre on (null for a region) */
	targetRegion: function(target, systems) {
		if (!target) { return null; }
		if (target.kind === "region") { return { regionID: target.id, systemID: null }; }
		const s = systems && systems[target.id];
		return regionMap.isKSpace(s) ? { regionID: Number(s.regionID), systemID: target.id } : null;
	}
};
