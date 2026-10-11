const jumpPlanner = {
	// Jump planner (fork-owned): a small range-ring icon on the chain's low-sec / null-sec exits opens a layout panel
	// with a top-down mini-map of the systems around that exit, the ones a jump ship can reach with one jump (by
	// distance band), gate jumps, trade-hub reach and a destination button. The range maths is in jumpRange
	// (app/js/fork/jump-range.js); static data in public/jumprange/ (jumprange/tools/generate-coords.js); cyno-jammed
	// marks per mask in public/jump_jammed.php. Settings: options.jumpRange (a missing key means the default).
	// Pure HTML builders and helpers first (tested), browser code at the bottom.
	// Keep `const jumpPlanner` on the first line: the test helper strips it to define a global.
	WIDGET_ID: "jumpPlannerWidget",
	SIZE: { x: 8, y: 12 },
	MIN_SIZE: { x: 6, y: 8 },
	COL_PX: 60,				// gridster widget_base_dimensions 50 + 2 * margin 5
	DATA_VERSION: 3586130,	// meta.version of public/jumprange/*.json (SDE build): busts the browser cache
	DATA_URL: "jumprange/",
	JAMMED_URL: "jump_jammed.php",
	JAMMED_REFRESH_MS: 60000,
	HUBS: [30000142, 30002187],	// Jita, Amarr
	HUB_GATES: 5,			// "near the hub": within this many gate jumps
	MAP_W: 466,
	MAP_H: 330,
	LABELS: 8,				// nearest in-range systems labelled on the mini-map
	BAND_COLORS: ["#5cc8f5", "#3d9cc8", "#4f7f99"],
	ROMAN: ["0", "I", "II", "III", "IV", "V"],
	DEFAULTS: {
		enabled: true, ship: "group-547", jdc: 5, cap: null, lowsec: true, nullsec: true, exits: "all", jammed: "mark",
		dock: "right", clickOpen: true, mapRadius: 10, showOut: true, showHs: false, hubs: true, search: true
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	// ---- Settings (pure) ----

	/** options.jumpRange with defaults filled in and values checked. Never mutates opts. */
	settings: function(opts) {
		const raw = opts && opts.jumpRange && typeof opts.jumpRange === "object" ? opts.jumpRange : {};
		const d = jumpPlanner.DEFAULTS;
		const pick = function(value, allowed, fallback) { return allowed.indexOf(value) >= 0 ? value : fallback; };
		const num = function(value, min, max, fallback) {
			const n = Number(value);
			return value === null || value === undefined || value === "" || !isFinite(n) ? fallback : Math.max(min, Math.min(max, n));
		};
		const s = {
			enabled: raw.enabled !== false,
			ship: typeof raw.ship === "string" && /^group-\d+(-[\d.]+)?$/.test(raw.ship) ? raw.ship : d.ship,
			jdc: Math.round(num(raw.jdc, 0, 5, d.jdc)),
			cap: raw.cap === null || raw.cap === undefined ? null : num(raw.cap, 1, 50, null),
			lowsec: raw.lowsec !== false,
			nullsec: raw.nullsec !== false,
			exits: pick(raw.exits, ["all", "viewing"], d.exits),
			jammed: pick(raw.jammed, ["mark", "hide", "ignore"], d.jammed),
			dock: pick(raw.dock, ["right", "left"], d.dock),
			clickOpen: raw.clickOpen !== false,
			mapRadius: Math.round(num(raw.mapRadius, 7, 15, d.mapRadius)),
			showOut: raw.showOut !== false,
			showHs: raw.showHs === true,
			hubs: raw.hubs !== false,
			search: raw.search !== false,
			open: raw.open === true,
			mode: pick(raw.mode, ["exit", "home"], "exit"),
			origin: Number(raw.origin) > 0 && Number.isInteger(Number(raw.origin)) ? Number(raw.origin) : null
		};
		if (raw.position && typeof raw.position === "object") { s.position = raw.position; }
		return s;
	},

	/** Whether the feature is on (options.jumpRange.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.jumpRange && opts.jumpRange.enabled === false);
	},

	/** The range used for settings and a preset list: {preset, max (ship at JDC), range (with the cap)} */
	range: function(settings, presets) {
		const preset = jumpRange.preset(presets, settings.ship);
		const max = preset ? jumpRange.maxRange(preset.baseLy, settings.jdc) : 0;
		return { preset: preset, max: max, range: jumpRange.maxRange(max, 0, settings.cap) };
	},

	/** Security as the game shows it: one decimal, and a positive value below 0.05 shows as 0.1 */
	secText: function(security) {
		const s = Number(security);
		if (!isFinite(s)) { return ""; }
		if (s > 0 && s < 0.05) { return "0.1"; }
		return (Math.round(s * 10) / 10).toFixed(1);
	},

	/** CSS class for a security */
	secClass: function(security) {
		const s = Number(security);
		return s >= 0.45 ? "jp-hs" : s > 0 ? "jp-ls" : "jp-ns";
	},

	/** "now", "12 min", "3 h", "2 d" */
	ageText: function(seconds) {
		const s = Math.max(0, Number(seconds) || 0);
		if (s < 60) { return "now"; }
		if (s < 3600) { return Math.floor(s / 60) + " min"; }
		if (s < 86400) { return Math.floor(s / 3600) + " h"; }
		return Math.floor(s / 86400) + " d";
	},

	// ---- Chain map (pure) ----

	/** Whether an exit gets a range icon: a low-sec or null-sec k-space system (not high-sec, W-space, Pochven, Zarzakh) */
	isRangeExit: function(systemID, sys) {
		const kind = jumpRange.kind(systemID, sys);
		return kind === "ls" || kind === "ns";
	},

	/** A synthetic or calculated chain row (route destinations, favourites' gate routes): not a system on the chain */
	isExtraRow: function(row) {
		const node = row && row.c && row.c[0];
		if (!node) { return true; }
		const html = typeof node.f === "string" ? node.f : "";
		const pathHome = Array.isArray(row.pathHome) ? row.pathHome : [];
		const last = pathHome[pathHome.length - 1];
		return !!row.destination || String(node.v).indexOf("dest-") === 0 || html.indexOf("destination-node") >= 0 || !!(last && last.path);
	},

	/**
	 * The chain's exits that get a range, in chain order, each once.
	 * @param result chain.nodes() output; systems appData.systems-like; mode "all" | "viewing"; viewingID the viewed system
	 */
	chainExits: function(result, systems, mode, viewingID) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		const seen = {}, out = [];
		rows.forEach(function(row) {
			if (jumpPlanner.isExtraRow(row)) { return; }
			const id = parseInt(row.c[0].systemID, 10);
			if (!id || seen[id] || !jumpPlanner.isRangeExit(id, systems ? systems[id] : null)) { return; }
			if (mode === "viewing" && id !== Number(viewingID)) { return; }
			seen[id] = true;
			out.push(id);
		});
		return out;
	},

	/** The ring icon for a node */
	ringHtml: function(systemID, name) {
		return "<span class='jp-ring' data-jp-exit='" + (parseInt(systemID, 10) || 0) + "' title='"
			+ jumpPlanner.escape("Jump range from " + (name || "this system") + ": open the Jump planner") + "'>"
			+ "<svg width='10' height='10' viewBox='0 0 10 10' aria-hidden='true'><circle cx='5' cy='5' r='4' fill='none' stroke='currentColor' stroke-width='1.3' stroke-dasharray='1.6 1.2'></circle>"
			+ "<circle cx='5' cy='5' r='1.2' fill='currentColor'></circle></svg></span>";
	},

	/** Insert the icon into a chain node's HTML (before its icon row, like the other corner marks) */
	insertRing: function(nodeHtml, ring) {
		if (!ring || typeof nodeHtml !== "string" || nodeHtml.indexOf("jp-ring") >= 0) { return nodeHtml; }
		const at = nodeHtml.indexOf("<div class='nodeIcons'>");
		if (at < 0) { return nodeHtml; }
		return nodeHtml.substring(0, at) + ring + nodeHtml.substring(at);
	},

	/** Add icons to chain.nodes() output in place for the given exits */
	decorate: function(result, exits, systems) {
		const want = {};
		(exits || []).forEach(function(id) { want[id] = true; });
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		rows.forEach(function(row) {
			if (jumpPlanner.isExtraRow(row)) { return; }
			const node = row.c[0];
			const id = parseInt(node.systemID, 10);
			if (!want[id] || typeof node.f !== "string") { return; }
			node.f = jumpPlanner.insertRing(node.f, jumpPlanner.ringHtml(id, systems && systems[id] ? systems[id].name : ""));
		});
		return result;
	},

	// ---- Panel model (pure) ----

	/**
	 * Everything the panel shows for one exit.
	 * @param ctx {exitID, index, systems, regions, map (gate map), settings, presets, jammed: {id: {setBy, age}}, gates: {id: jumps}}
	 * @return {range, preset, rows: [{id, name, sec, secText, region, ly, band, gates, jammed, blocked, jam}], counts}
	 */
	model: function(ctx) {
		const s = ctx.settings;
		const r = jumpPlanner.range(s, ctx.presets);
		const covert = !!(r.preset && r.preset.covert);
		const jammedIDs = {};
		Object.keys(ctx.jammed || {}).forEach(function(id) { jammedIDs[id] = true; });
		const opts = {
			lowsec: s.lowsec, nullsec: s.nullsec, covert: covert,
			jammed: s.jammed === "ignore" ? {} : jammedIDs, showJammed: s.jammed === "mark"
		};
		const list = jumpRange.inRange(ctx.exitID, ctx.index, r.range, ctx.systems, opts);
		const rows = list.map(function(hit) {
			const sys = ctx.systems[hit.id] || {};
			const region = ctx.regions && ctx.regions[sys.regionID] ? ctx.regions[sys.regionID].name : "";
			const gates = ctx.gates ? ctx.gates[hit.id] : undefined;
			return {
				id: hit.id, name: sys.name || String(hit.id), sec: Number(sys.security), secText: jumpPlanner.secText(sys.security),
				region: region, ly: hit.ly, band: Math.min(hit.band, jumpPlanner.BAND_COLORS.length - 1), gates: gates === undefined ? null : gates,
				jammed: !!jammedIDs[hit.id], blocked: !!hit.blocked, jam: (ctx.jammed || {})[hit.id] || null
			};
		});
		return {
			range: r.range, max: r.max, preset: r.preset, covert: covert, opts: opts, rows: rows,
			counts: { inRange: rows.filter(function(x) { return !x.blocked; }).length, jammed: rows.filter(function(x) { return x.jammed; }).length }
		};
	},

	/** Rows sorted by a column ("name", "sec", "region", "ly", "gates"); dir 1 or -1. Ties: by LY, then name. */
	sortRows: function(rows, key, dir) {
		const d = dir === -1 ? -1 : 1;
		const val = function(r) {
			if (key === "name" || key === "region") { return String(r[key] || "").toLowerCase(); }
			if (key === "gates") { return r.gates === null ? Infinity : r.gates; }
			if (key === "sec") { return r.sec; }
			return r.ly;
		};
		return rows.slice().sort(function(a, b) {
			const va = val(a), vb = val(b);
			const c = va < vb ? -1 : va > vb ? 1 : 0;
			return c * d || a.ly - b.ly || String(a.name).localeCompare(String(b.name));
		});
	},

	/**
	 * The mini-map: projection, rings and points (no HTML).
	 * @param ctx as model(), plus coords (decoded positions); model model() output; extras {hoverID, pinnedID}
	 * @return {scale, cx, cy, rings: [{r, ly, color}], points: [{id, x, y, kind: "exit"|"in"|"jammed"|"hs"|"out", band, name, ly}], lines: [[x1, y1, x2, y2]]}
	 */
	mapModel: function(ctx, model) {
		const W = jumpPlanner.MAP_W, H = jumpPlanner.MAP_H;
		const s = ctx.settings;
		const origin = ctx.index.pos[ctx.exitID];
		// The whole range must fit (it can be larger than the "Mini-map shows" radius), with a little margin; ctx.fitLy
		// (Get home: the farthest reachable exit) widens it
		const radius = Math.max(s.mapRadius, model.range, Number(ctx.fitLy) || 0);
		const scale = (H / 2 - 6) / (radius * 1.04);
		const cx = W / 2, cy = H / 2;
		const project = function(p) { return { x: cx + (p.x - origin.x) * scale, y: cy - (p.z - origin.z) * scale }; };
		const rings = jumpRange.rings(model.range).map(function(ly, i, all) {
			return { ly: ly, r: ly * scale, color: jumpPlanner.BAND_COLORS[Math.min(i, jumpPlanner.BAND_COLORS.length - 1)], max: i === all.length - 1 };
		});
		const rowByID = {};
		model.rows.forEach(function(r) { rowByID[r.id] = r; });
		const points = [];
		const shown = {};
		// Systems out to the "Mini-map shows" radius (3-D distance, like the range), not the whole rectangle
		jumpRange.within(ctx.index, origin, radius).forEach(function(hit) {
			const p = project(ctx.index.pos[hit.id]);
			if (p.x < -4 || p.x > W + 4 || p.y < -4 || p.y > H + 4) { return; }
			const sys = ctx.systems[hit.id] || {};
			const row = rowByID[hit.id];
			let kind;
			if (hit.id === Number(ctx.exitID)) { kind = "exit"; }
			else if (row) { kind = row.blocked ? "jammed" : "in"; }
			// "Cyno-jammed systems: Hide": not on the map at all (not even as out of range)
			else if (s.jammed === "hide" && model.opts.jammed && model.opts.jammed[hit.id] && hit.ly <= model.range) { return; }
			// High-sec (no cyno there): only with its own setting (off by default), faint, inside the range ring
			else if (jumpRange.kind(hit.id, sys) === "hs") {
				if (!s.showHs || hit.ly > model.range) { return; }
				kind = "hs";
			}
			else if (s.showOut) { kind = "out"; }
			else { return; }
			shown[hit.id] = true;
			points.push({ id: hit.id, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, kind: kind, band: row ? row.band : null,
				name: sys.name || String(hit.id), ly: hit.ly, jammed: row ? row.jammed : false });
		});
		const byID = {};
		points.forEach(function(p) { byID[p.id] = p; });
		const lines = [];
		points.forEach(function(p) {
			const next = ctx.map ? ctx.map[p.id - 30000000] : null;
			for (const key in (next || {})) {
				const id = 30000000 + Number(key);
				// No gate lines to high-sec dots: they would draw the whole high-sec network
				if (id > p.id && byID[id] && p.kind !== "hs" && byID[id].kind !== "hs") { lines.push([p.x, p.y, byID[id].x, byID[id].y]); }
			}
		});
		const out = points.filter(function(p) { return p.kind === "out"; }).length;
		return { scale: scale, cx: cx, cy: cy, origin: origin, rings: rings, points: points, lines: lines, outShown: out };
	},

	/**
	 * Which points get a label, and where: the exit, the hovered / pinned system, jammed ones, then the nearest
	 * in-range systems (up to LABELS); a label that would overlap a placed one tries the other sides, else is skipped.
	 * @return [{id, x, y, anchor, text, cls}]
	 */
	placeLabels: function(mapModel, focusIDs) {
		const W = jumpPlanner.MAP_W, H = jumpPlanner.MAP_H;
		const focus = (focusIDs || []).filter(function(id) { return id; }).map(Number);
		const byID = {};
		mapModel.points.forEach(function(p) { byID[p.id] = p; });
		const order = [];
		const add = function(p, cls) { if (p && !order.some(function(o) { return o.p.id === p.id; })) { order.push({ p: p, cls: cls }); } };
		mapModel.points.filter(function(p) { return p.kind === "exit"; }).forEach(function(p) { add(p, "jp-l-exit"); });
		focus.forEach(function(id) { add(byID[id], "jp-l-focus"); });
		mapModel.points.filter(function(p) { return p.kind === "jammed"; }).forEach(function(p) { add(p, "jp-l-jammed"); });
		mapModel.points.filter(function(p) { return p.kind === "in"; }).sort(function(a, b) { return a.ly - b.ly; })
			.slice(0, jumpPlanner.LABELS).forEach(function(p) { add(p, "jp-l-in"); });
		const boxes = [];
		const overlaps = function(b) {
			return b.x0 < 0 || b.x1 > W || b.y0 < 0 || b.y1 > H || boxes.some(function(o) {
				return b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0;
			});
		};
		const out = [];
		order.forEach(function(item, i) {
			const p = item.p;
			const text = p.name + (p.kind === "jammed" || (p.jammed && item.cls !== "jp-l-exit") ? " (jammed)" : "");
			const w = text.length * 6.2 + 2, h = 11;
			const options = [
				{ x: p.x + 8, y: p.y + 4, anchor: "start", box: { x0: p.x + 7, x1: p.x + 8 + w, y0: p.y - 6, y1: p.y - 6 + h } },
				{ x: p.x - 8, y: p.y + 4, anchor: "end", box: { x0: p.x - 8 - w, x1: p.x - 7, y0: p.y - 6, y1: p.y - 6 + h } },
				{ x: p.x, y: p.y - 9, anchor: "middle", box: { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - 19, y1: p.y - 8 } },
				{ x: p.x, y: p.y + 17, anchor: "middle", box: { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y + 7, y1: p.y + 18 } }
			];
			const pick = options.filter(function(o) { return !overlaps(o.box); })[0] || (i === 0 || item.cls === "jp-l-focus" ? options[0] : null);
			if (!pick) { return; }
			boxes.push(pick.box);
			out.push({ id: p.id, x: Math.round(pick.x * 10) / 10, y: Math.round(pick.y * 10) / 10, anchor: pick.anchor, text: text, cls: item.cls });
		});
		return out;
	},

	/** SVG markup of the mini-map; foundID (the system search's pick) gets a pulsing ring when it is on the map */
	mapSvg: function(mapModel, labels, focusIDs, foundID, overlay) {
		const esc = jumpPlanner.escape;
		const focus = {};
		(focusIDs || []).forEach(function(id) { if (id) { focus[id] = true; } });
		let svg = "<svg class='jp-svg' viewBox='0 0 " + jumpPlanner.MAP_W + " " + jumpPlanner.MAP_H + "' preserveAspectRatio='xMidYMid meet' role='img' aria-label='Top-down map of the systems around the exit, with jump range rings'>";
		mapModel.rings.slice().reverse().forEach(function(r) {
			svg += "<circle cx='" + mapModel.cx + "' cy='" + mapModel.cy + "' r='" + r.r.toFixed(1) + "' fill='" + r.color + "' fill-opacity='0.10' stroke='" + r.color + "' stroke-width='1' stroke-dasharray='4 3'></circle>";
		});
		mapModel.rings.forEach(function(r) {
			const a = Math.PI / 4;
			svg += "<text class='jp-ring-label' x='" + (mapModel.cx + r.r * Math.cos(a) + 3).toFixed(1) + "' y='" + (mapModel.cy - r.r * Math.sin(a) - 3).toFixed(1) + "' fill='" + r.color + "'>" + esc(r.ly.toFixed(r.ly * 10 % 1 ? 2 : 1)) + "</text>";
		});
		svg += "<g class='jp-gates'>" + mapModel.lines.map(function(l) {
			return "<line x1='" + l[0] + "' y1='" + l[1] + "' x2='" + l[2] + "' y2='" + l[3] + "'></line>";
		}).join("") + "</g><g class='jp-points'>";
		const order = { out: 0, hs: 1, in: 2, jammed: 3, exit: 4 };
		mapModel.points.slice().sort(function(a, b) { return order[a.kind] - order[b.kind]; }).forEach(function(p) {
			const attrs = " data-jp-id='" + p.id + "' class='jp-pt jp-pt-" + p.kind + (focus[p.id] ? " jp-focus" : "") + "'";
			if (p.kind === "exit") {
				svg += "<circle" + attrs + " cx='" + p.x + "' cy='" + p.y + "' r='6'></circle>";
			} else if (p.kind === "in") {
				svg += "<circle" + attrs + " cx='" + p.x + "' cy='" + p.y + "' r='" + (focus[p.id] ? 5.5 : 4) + "' fill='" + jumpPlanner.BAND_COLORS[p.band] + "'></circle>"
					+ (p.jammed ? "<circle class='jp-pt-jamring' cx='" + p.x + "' cy='" + p.y + "' r='6.5'></circle>" : "");
			} else if (p.kind === "jammed") {
				svg += "<g" + attrs + "><circle cx='" + p.x + "' cy='" + p.y + "' r='4.5'></circle><line x1='" + (p.x - 3.5) + "' y1='" + (p.y - 3.5) + "' x2='" + (p.x + 3.5) + "' y2='" + (p.y + 3.5) + "'></line></g>";
			} else {
				svg += "<circle" + attrs + " cx='" + p.x + "' cy='" + p.y + "' r='" + (p.kind === "hs" ? 2.4 : 2) + "'></circle>";
			}
		});
		const found = foundID ? mapModel.points.filter(function(p) { return p.id === Number(foundID); })[0] : null;
		if (found) {
			svg += "<circle class='jp-found-ring' cx='" + found.x + "' cy='" + found.y + "' r='9'></circle>"
				+ "<circle class='jp-found-pulse' cx='" + found.x + "' cy='" + found.y + "' r='9'></circle>";
		}
		svg += "</g>" + (overlay || "") + "<g class='jp-labels'>" + (labels || []).map(function(l) {
			return "<text class='" + l.cls + "' x='" + l.x + "' y='" + l.y + "' text-anchor='" + l.anchor + "'>" + esc(l.text) + "</text>";
		}).join("") + "</g></svg>";
		return svg;
	},

	/** Header: ship select, JDC buttons, range */
	headerHtml: function(presets, settings, range) {
		const esc = jumpPlanner.escape;
		const r = jumpPlanner.range(settings, presets);
		const ship = r.preset ? r.preset.key : "";
		return "<select class='jp-ship' aria-label='Jump ship' title='Jump ship (its hull sets the base range)'>" + (presets || []).map(function(p) {
			return "<option value='" + esc(p.key) + "'" + (p.key === ship ? " selected" : "") + " title='" + esc(p.ships.join(", ")) + "'>" + esc(p.label) + "</option>";
		}).join("") + "</select>"
			+ "<span class='jp-jdc' role='group' aria-label='Jump Drive Calibration'>" + jumpPlanner.ROMAN.map(function(label, level) {
				return "<button type='button' data-jdc='" + level + "' class='" + (level === settings.jdc ? "active" : "") + "' title='Jump Drive Calibration " + label + "'>" + label + "</button>";
			}).join("") + "</span><span class='jp-jdc-label'>JDC</span>"
			+ "<span class='jp-range' title='" + esc(r.preset ? r.preset.label + ": " + r.preset.baseLy + " LY base" + (settings.cap && settings.cap < r.max ? ", capped at " + jumpRange.formatLy(settings.cap) + " in Settings" : "") : "") + "'>"
			+ esc(jumpRange.formatLy(range === undefined ? r.range : range)) + "</span>";
	},

	/** Tabs: one per exit with its in-range count (null: not known yet) */
	tabsHtml: function(exits, selected, names, counts) {
		const esc = jumpPlanner.escape;
		return (exits || []).map(function(id) {
			const c = counts ? counts[id] : null;
			return "<button type='button' class='jp-tab" + (id === selected ? " active" : "") + "' data-jp-tab='" + id + "'>" + esc(names(id))
				+ (c === null || c === undefined ? "" : " <span class='jp-tab-count'>" + c + "</span>") + "</button>";
		}).join("");
	},

	/** The list of in-range systems */
	listHtml: function(rows, sort, settings, covert) {
		const esc = jumpPlanner.escape;
		const head = [["name", "System"], ["sec", "Sec"], ["region", "Region"], ["ly", "LY"], ["gates", "Gates"]];
		let html = "<table class='jp-list'><thead><tr>" + head.map(function(h) {
			const active = sort.key === h[0];
			return "<th data-jp-sort='" + h[0] + "' class='jp-col-" + h[0] + (active ? " active" : "") + "' title='Sort by " + h[1] + "'>" + h[1]
				+ (active ? (sort.dir === -1 ? " ▴" : " ▾") : "") + "</th>";
		}).join("") + "<th></th></tr></thead><tbody>";
		if (!rows.length) {
			html += "<tr><td colspan='6' class='jp-empty'>No " + (settings.lowsec && !settings.nullsec ? "low-sec " : !settings.lowsec && settings.nullsec ? "null-sec " : "")
				+ "systems in range.</td></tr>";
		}
		rows.forEach(function(r) {
			const action = r.blocked ? "<span class='jp-jammed-text' title='Cyno-jammed: a normal cyno can't be lit here'>jammed</span>"
				: "<a href='#' class='jp-dest' title='Set destination in game'>Dest</a>";
			html += "<tr data-jp-id='" + r.id + "' class='" + (r.blocked ? "jp-row-blocked" : "") + "'>"
				+ "<td class='jp-col-name'>" + esc(r.name) + (r.jammed && !r.blocked ? " <span class='jp-jammed-tag' title='" + esc(covert ? "Cyno-jammed: only a covert cyno works here" : "Marked cyno-jammed (shown as in range in Settings)") + "'>jammed</span>" : "") + "</td>"
				+ "<td class='jp-col-sec " + jumpPlanner.secClass(r.sec) + "'>" + esc(r.secText) + "</td>"
				+ "<td class='jp-col-region'>" + esc(r.region) + "</td>"
				+ "<td class='jp-col-ly jp-band-" + r.band + "'>" + r.ly.toFixed(1) + "</td>"
				+ "<td class='jp-col-gates'>" + (r.gates === null ? "–" : r.gates) + "</td>"
				+ "<td class='jp-col-act'>" + action + "</td></tr>";
		});
		return html + "</tbody></table>";
	},

	/** Tooltip for one system. info {id, name, sec, region, ly, gates, kind ("in"|"jammed"|"out"|"hs"|"exit"), jam: {setBy, age}, canMark} */
	tooltipHtml: function(info) {
		const esc = jumpPlanner.escape;
		const lines = [];
		lines.push("<div class='jp-tip-title'>" + esc(info.name) + " <span class='" + jumpPlanner.secClass(info.sec) + "'>" + esc(jumpPlanner.secText(info.sec)) + "</span></div>");
		const parts = [];
		if (info.region) { parts.push(esc(info.region)); }
		if (info.kind !== "exit") { parts.push("<span class='jp-band-" + (info.band === null || info.band === undefined ? "out" : info.band) + "'>" + info.ly.toFixed(1) + " LY</span>"); }
		parts.push(info.gates === null || info.gates === undefined ? "no gate route" : info.gates === 0 ? "here" : info.gates + (info.gates === 1 ? " gate" : " gates"));
		lines.push("<div class='jp-tip-sub'>" + parts.join(" · ") + "</div>");
		const note = { hs: "High-sec: no cyno", out: "Out of range", jammed: "Cyno-jammed: no normal cyno" }[info.kind];
		// Get home: an exit's route from the start (instead of "out of range" for one jump)
		if (info.route) { lines.push("<div class='jp-tip-route'>" + esc(info.route) + "</div>"); }
		else if (note) { lines.push("<div class='jp-tip-note'>" + esc(note) + "</div>"); }
		if (info.jam) {
			lines.push("<div class='jp-tip-jam'>Marked jammed" + (info.jam.setBy ? " by " + esc(info.jam.setBy) : "") + ", " + esc(jumpPlanner.ageText(info.jam.age)) + (info.jam.age >= 60 ? " ago" : "") + "</div>");
		}
		const links = [];
		if (info.cyno) { links.push("<a href='#' class='jp-home-dest' data-jp-cyno='" + (parseInt(info.cyno, 10) || 0) + "'>Set destination</a>"); }
		else if (info.kind === "in") { links.push("<a href='#' class='jp-tip-dest'>Set destination</a>"); }
		links.push("<a href='#' class='jp-tip-copy'>Copy</a>");
		if (info.canMark) { links.push("<a href='#' class='jp-tip-jamtoggle'>" + (info.jam ? "Unmark jammed" : "Mark jammed") + "</a>"); }
		lines.push("<div class='jp-tip-links'>" + links.join("") + "</div>");
		return lines.join("");
	},

	/**
	 * Trade-hub reach lines for the selected exit.
	 * @param results [{hubID, to: reach(hub -> exit), back: nearHub(exit -> near hub) or null}]; name: function(id)
	 */
	hubsHtml: function(results, exitName, name) {
		const esc = jumpPlanner.escape;
		return (results || []).map(function(h) {
			const hub = esc(name(h.hubID));
			let to;
			const r = h.to;
			if (r && r.reason === "target") {
				to = "<span class='jp-hub-no'>exit is cyno-jammed (normal cyno)</span>";
			} else if (!r || r.jumps === null) {
				to = "<span class='jp-hub-no'>not within 2 jumps</span>" + (r && isFinite(r.direct) ? " <span class='jp-dim'>(" + r.direct.toFixed(1) + " LY)</span>" : "");
			} else if (r.jumps === 1) {
				to = "<span class='jp-hub-ok'>1 jump</span> <span class='jp-dim'>(" + r.direct.toFixed(1) + " LY)</span>";
			} else {
				const v = r.via[0];
				to = "<span class='jp-hub-ok2'>2 jumps</span> via " + esc(name(v.id)) + " <span class='jp-dim'>(" + v.ly1.toFixed(1) + " + " + v.ly2.toFixed(1) + " LY"
					+ (r.via.length > 1 ? ", " + (r.via.length - 1) + " other midpoint" + (r.via.length === 2 ? "" : "s") : "") + ")</span>";
			}
			let back;
			if (!h.back) {
				back = "<span class='jp-hub-no'>no low/null-sec near " + hub + " in 2 jumps</span>";
			} else {
				const b = h.back.reach;
				back = esc(name(h.back.systemID)) + " <span class='jp-dim'>(" + (b.jumps === 1 ? "1 jump" : "2 jumps via " + esc(name(b.via[0].id))) + ", then "
					+ h.back.gates + (h.back.gates === 1 ? " gate" : " gates") + " to " + hub + ")</span>";
			}
			return "<div class='jp-hub'><span class='jp-hub-name'>" + hub + "</span>"
				+ "<span class='jp-hub-line' title='" + esc("Can the jump ship get from " + name(h.hubID) + " to " + exitName + " with at most 2 jumps (high-sec is a valid start)?") + "'>→ " + esc(exitName) + ": " + to + "</span>"
				+ "<span class='jp-hub-line' title='" + esc(name(h.hubID) + " is high-sec, so no cyno there: the closest low/null-sec system within " + jumpPlanner.HUB_GATES + " gates of it that the ship reaches from " + exitName) + "'>← back: " + back + "</span></div>";
		}).join("");
	},

	/** Footer counts: "18 in range · 1 jammed · 4 out of range shown" */
	footerText: function(model, outShown, showOut) {
		const parts = [model.counts.inRange + " in range"];
		if (model.counts.jammed) { parts.push(model.counts.jammed + " jammed"); }
		if (showOut) { parts.push(outShown + " out of range shown"); }
		return parts.join(" · ");
	},

	/** Plain-text list for the clipboard */
	copyText: function(rows, exitName, presetLabel, jdc, range) {
		const lines = ["Jump range from " + exitName + " (" + presetLabel + ", JDC " + jumpPlanner.ROMAN[jdc] + ", " + jumpRange.formatLy(range) + ")"];
		rows.forEach(function(r) {
			lines.push([r.name, r.secText, r.region, r.ly.toFixed(2) + " LY", r.gates === null ? "-" : r.gates + " gates"].join("\t") + (r.jammed ? "\tjammed" : ""));
		});
		return lines.join("\n");
	},

	// ---- System search (pure) ----

	SEARCH_LIMIT: 8,
	SORT_NAMES: { name: "System", sec: "Sec", region: "Region", ly: "LY", gates: "Gates" },

	/** A name or query for matching: lower case, without dashes and spaces ("0sht-a" and "0 SHT A" both give "0shta") */
	searchKey: function(text) {
		return String(text === undefined || text === null ? "" : text).toLowerCase().replace(/[-\s]/g, "");
	},

	/**
	 * Systems whose name matches a query: exact first, then prefix matches, then substring matches (each by name),
	 * case-insensitive and ignoring dashes and spaces. Every system in the lookup counts, not only those in range.
	 * @param systems appData.systems-like {systemID: {name}}; limit default SEARCH_LIMIT
	 * @return [systemID]
	 */
	searchSystems: function(query, systems, limit) {
		const q = jumpPlanner.searchKey(query);
		const max = limit === undefined ? jumpPlanner.SEARCH_LIMIT : limit;
		if (!q || !systems || !(max > 0)) { return []; }
		const hits = [];
		Object.keys(systems).forEach(function(id) {
			const sys = systems[id];
			if (!sys || !sys.name) { return; }
			const key = jumpPlanner.searchKey(sys.name);
			const at = key.indexOf(q);
			if (at < 0) { return; }
			hits.push({ id: Number(id), name: String(sys.name), rank: key === q ? 0 : at === 0 ? 1 : 2 });
		});
		hits.sort(function(a, b) {
			return a.rank - b.rank || a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id);
		});
		return hits.slice(0, max).map(function(h) { return h.id; });
	},

	/**
	 * Where a searched system is, or why it isn't in the list, for the panel's current exit, using the engine's rules.
	 * @param id the system; ctx as model(); model model() output; rows the list as shown (sortRows output)
	 * @return {id, name, status ("listed" | "exit" | "wh" | "pochven" | "zarzakh" | "hs" | "range" | "lowsec" | "nullsec"
	 *   | "jammed" | "nopos" | "unknown" | "other"), rank (1-based, listed), total, ly (NaN without positions), range,
	 *   row (listed)}
	 */
	searchStatus: function(id, ctx, model, rows) {
		const systemID = Number(id);
		const sys = ctx.systems ? ctx.systems[systemID] : null;
		const list = rows || model.rows;
		const out = { id: systemID, name: sys && sys.name ? sys.name : String(systemID), status: "other", rank: null, total: list.length,
			ly: jumpRange.distanceLy(ctx.index.pos[ctx.exitID], ctx.index.pos[systemID]), range: model.range, row: null };
		const set = function(status) { out.status = status; return out; };
		for (let i = 0; i < list.length; i++) {
			if (list[i].id === systemID) { out.rank = i + 1; out.row = list[i]; return set("listed"); }
		}
		if (systemID === Number(ctx.exitID)) { return set("exit"); }
		const kind = jumpRange.kind(systemID, sys);
		if (!kind) { return set("unknown"); }
		if (kind === "wh" || kind === "pochven" || kind === "zarzakh" || kind === "hs") { return set(kind); }
		if (!ctx.index.pos[systemID]) { return set("nopos"); }
		if (out.ly > model.range) { return set("range"); }
		const opts = model.opts || {};
		if (!jumpRange.isValidCynoTarget(systemID, sys, Object.assign({}, opts, { jammed: null }))) { return set(kind === "ls" ? "lowsec" : "nullsec"); }
		if (!jumpRange.isValidCynoTarget(systemID, sys, opts)) { return set("jammed"); }
		return out;
	},

	/** scrollTop that puts a row (top and height in the scrolled content) in the middle of the box below a sticky header */
	centerScrollTop: function(rowTop, rowHeight, headHeight, boxHeight) {
		const visible = Math.max(0, boxHeight - headHeight);
		return Math.max(0, Math.round(rowTop - headHeight - Math.max(0, (visible - rowHeight) / 2)));
	},

	/** "8.03 LY" next to a range of 8.0: more decimals (up to 3, the data's precision) until it shows it is beyond the range */
	beyondText: function(ly, range) {
		let text = Number(ly).toFixed(1);
		for (let d = 2; d <= 3 && Number(text) <= Number(range); d++) { text = Number(ly).toFixed(d); }
		return text + " LY";
	},

	/** The one-line search result (HTML, escaped). result searchStatus() output; sort {key, dir} */
	searchResultHtml: function(result, sort) {
		if (!result) { return ""; }
		const esc = jumpPlanner.escape;
		const ly = isFinite(result.ly) ? result.ly.toFixed(1) + " LY" : "";
		const withLy = function(text) { return esc(text) + (ly ? " <span class='jp-dim'>(" + esc(ly) + ")</span>" : ""); };
		let text, cls = "jp-search-no";
		switch (result.status) {
			case "listed": {
				const by = (jumpPlanner.SORT_NAMES[sort && sort.key] || "LY") + (sort && sort.dir === -1 ? " (reversed)" : "");
				cls = result.row && result.row.blocked ? "jp-search-jammed" : "jp-search-ok";
				text = "#" + result.rank + " of " + result.total + " listed, by " + esc(by)
					+ (result.row && result.row.blocked ? " · cyno-jammed, no normal cyno" : result.row && result.row.jammed ? " · marked cyno-jammed" : "");
				break;
			}
			case "exit": text = "the exit itself"; cls = "jp-search-ok"; break;
			case "wh": text = "wormhole space, jump drives can't go there"; break;
			case "pochven": text = withLy("Pochven, no cyno can be lit"); break;
			case "zarzakh": text = withLy("Zarzakh, no cyno can be lit"); break;
			case "hs": text = withLy("high-sec, can't light a cyno"); break;
			case "range": text = "out of range: " + esc(jumpPlanner.beyondText(result.ly, result.range)) + " <span class='jp-dim'>(range " + esc(jumpRange.formatLy(result.range).replace(" LY", "")) + ")</span>"; break;
			case "lowsec": text = withLy("low-sec, but Low-sec targets are off in Settings"); break;
			case "nullsec": text = withLy("null-sec, but Null-sec targets are off in Settings"); break;
			case "jammed": text = withLy("cyno-jammed (hidden by your setting)"); break;
			case "nopos": text = "no position known"; break;
			case "unknown": text = "unknown system"; break;
			default: text = withLy("not in the list");
		}
		return "<span class='jp-search-name'>" + esc(result.name) + "</span> — <span class='" + cls + "'>" + text + "</span>";
	},

	/** Search suggestions (HTML, escaped): name, security and region; active the highlighted index */
	searchMenuHtml: function(ids, active, systems, regions) {
		const esc = jumpPlanner.escape;
		return (ids || []).map(function(id, i) {
			const sys = (systems && systems[id]) || {};
			const kind = jumpRange.kind(id, sys);
			const sec = kind === "wh" ? "<span class='jp-search-wh'>" + esc(sys.class ? "C" + sys.class : "W") + "</span>"
				: "<span class='" + jumpPlanner.secClass(sys.security) + "'>" + esc(jumpPlanner.secText(sys.security)) + "</span>";
			const region = regions && regions[sys.regionID] ? regions[sys.regionID].name : "";
			return "<li role='option' data-jp-find='" + (parseInt(id, 10) || 0) + "' class='" + (i === active ? "active" : "") + "'"
				+ (i === active ? " aria-selected='true'" : "") + ">" + esc(sys.name || String(id)) + " " + sec
				+ (region ? " <span class='jp-dim'>" + esc(region) + "</span>" : "") + "</li>";
		}).join("");
	},

	// ---- Get home mode (pure) ----

	/** Root of a chain row (c[1].v null, undefined or "") */
	isRootRow: function(row) {
		const p = row && row.c && row.c[1] ? row.c[1].v : null;
		return p === null || p === undefined || p === "";
	},

	/**
	 * Each chain system's way home: the root of its chain tree (the same "home" pathHome counts from) and the holes
	 * from the system back to it, fewest holes when a system is on the chain twice. Calculated / synthetic rows are left out.
	 * @param result chain.nodes() output: {map: {rows}, lines: [[childV, parentV, modifiers, wormholeID]]}
	 * @return {homes: [root systemID, chain order], paths: {systemID: {home, holes: [{wormholeID, from, to, name,
	 *   signatureID, type (the far side's type), eol, mass ("critical" | "destab" | null)}]}}} (holes: exit first)
	 */
	homePaths: function(result) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		const byV = {}, line = {};
		rows.forEach(function(row) { if (!jumpPlanner.isExtraRow(row)) { byV[row.c[0].v] = row; } });
		((result && result.lines) || []).forEach(function(l) { if (l) { line[l[0]] = l; } });
		const homes = [], paths = {};
		rows.forEach(function(row) {
			if (jumpPlanner.isExtraRow(row)) { return; }
			const id = parseInt(row.c[0].systemID, 10);
			const holes = [];
			let cur = row, steps = 0;
			while (cur && !jumpPlanner.isRootRow(cur) && steps++ < 200) {
				const parent = byV[cur.c[1].v];
				if (!parent) { return; }		// not a whole path (parent left out): skip
				const pathHome = Array.isArray(cur.pathHome) ? cur.pathHome : [];
				const child = pathHome[pathHome.length - 1] || {};
				const l = line[cur.c[0].v] || [];
				const mods = Array.isArray(l[2]) ? l[2] : [];
				holes.push({
					wormholeID: l[3] === undefined ? null : l[3], from: parseInt(parent.c[0].systemID, 10) || null, to: parseInt(cur.c[0].systemID, 10) || null,
					name: child.name || "", signatureID: child.signatureID || "", type: child.type || "",
					eol: mods.indexOf("eol") >= 0, mass: mods.indexOf("critical") >= 0 ? "critical" : mods.indexOf("destab") >= 0 ? "destab" : null
				});
				cur = parent;
			}
			if (!cur || !jumpPlanner.isRootRow(cur)) { return; }
			const home = parseInt(cur.c[0].systemID, 10);
			if (!home) { return; }
			if (cur === row && homes.indexOf(home) < 0) { homes.push(home); }
			if (!id) { return; }
			if (!paths[id] || holes.length < paths[id].holes.length) { paths[id] = { home: home, holes: holes }; }
		});
		return { homes: homes, paths: paths };
	},

	/** The exits Get home routes to: every LS/NS exit on the chain, whatever "Exits that get a range" says */
	homeExits: function(result, systems) {
		return jumpPlanner.chainExits(result, systems, "all");
	},

	/**
	 * What Get home shows from the chain, as a string to compare: the exits, each system's way home, and which holes on
	 * those ways are flagged preserve mass (flags: preserveMass.flags, by wormhole id)
	 */
	homeKey: function(result, systems, flags) {
		const hp = jumpPlanner.homePaths(result);
		const preserved = [];
		Object.keys(hp.paths).forEach(function(id) {
			hp.paths[id].holes.forEach(function(h) {
				const key = String(h.wormholeID);
				if (flags && flags[key] && preserved.indexOf(key) < 0) { preserved.push(key); }
			});
		});
		return JSON.stringify({ exits: jumpPlanner.homeExits(result, systems), homes: hp.homes, paths: hp.paths, preserve: preserved.sort() });
	},

	/** A hole's short name: its signature name, else the first 3 letters of the signature, plus the type when known ("N1 Z142") */
	holeLabel: function(hole) {
		const base = hole.name ? String(hole.name).substring(0, 24) : hole.signatureID ? String(hole.signatureID).substring(0, 3).toUpperCase() : "?";
		const type = hole.realType && hole.realType !== "K162" && hole.realType !== "????" ? hole.realType : "";
		return type && base.indexOf(type) < 0 ? base + " " + type : base;
	},

	/**
	 * Warnings for taking a ship home along these holes. Hole sizes come from size-tags (hole.size, hole.certain),
	 * the ship's need from jumpRange.shipNeeds. Never blocks anything: text only.
	 * @param holes homePaths() holes, annotated with size / certain / realType / preserve
	 * @return [{level: "warn" | "note", text}]
	 */
	holeWarnings: function(holes, need, shipName) {
		const out = [];
		const ship = shipName || "this ship";
		if (need === "none") { out.push({ level: "warn", text: ship + " can't go through wormholes" }); }
		const unknown = [];
		(holes || []).forEach(function(h) {
			const label = jumpPlanner.holeLabel(h);
			if (need !== "none") {
				const fits = jumpRange.holeFits(need, h.size);
				if (fits === false) { out.push({ level: "warn", text: (h.certain ? "hole too small for " : "hole likely too small for ") + ship + ": " + label + " (" + h.size + (h.certain ? "" : "?") + ")" }); }
				else if (fits === null && need && !h.size) { unknown.push(label); }
			}
			if (h.eol) { out.push({ level: "warn", text: "EOL: " + label }); }
			if (h.mass === "critical") { out.push({ level: "warn", text: "mass critical: " + label }); }
			else if (h.mass === "destab") { out.push({ level: "note", text: "destab: " + label }); }
			if (h.preserve) { out.push({ level: "note", text: "preserve mass: " + label }); }
		});
		if (unknown.length) { out.push({ level: "note", text: "size unknown: " + unknown.join(", ") }); }
		return out;
	},

	/**
	 * Get home: from a start system, the routes to each exit on the chain (1-2 jumps), and the holes from there home.
	 * @param ctx {startID, exits: [systemID], paths (homePaths().paths, holes annotated), index, systems, settings, presets, jammed}
	 * @return {range, preset, covert, need, problem (jumpRange.startProblem), rows: [routesTo row + {name, sec, secText, cyno,
	 *   home, holes, warnings}], counts: {reachable, total}}
	 */
	homeModel: function(ctx) {
		const s = ctx.settings;
		const r = jumpPlanner.range(s, ctx.presets);
		const covert = !!(r.preset && r.preset.covert);
		const jammedIDs = {};
		Object.keys(ctx.jammed || {}).forEach(function(id) { jammedIDs[id] = true; });
		const opts = { lowsec: s.lowsec, nullsec: s.nullsec, covert: covert, jammed: s.jammed === "ignore" ? {} : jammedIDs };
		const need = r.preset ? jumpRange.shipNeeds(r.preset.key.replace(/^group-(\d+).*$/, "$1")) : null;
		// Supercarriers and titans can't take the wormholes home: nothing to list
		const problem = need === "none" ? "supercap" : ctx.startID ? jumpRange.startProblem(ctx.startID, ctx.systems[ctx.startID], ctx.index) : "none";
		const exits = (ctx.exits || []).filter(function(id) { return ctx.paths && ctx.paths[id]; });
		const routes = problem ? [] : jumpRange.routesTo(ctx.startID, exits, r.range, ctx.index, ctx.systems, opts);
		const rows = routes.map(function(route) {
			const sys = ctx.systems[route.id] || {};
			const path = ctx.paths[route.id];
			return Object.assign(route, {
				name: sys.name || String(route.id), sec: Number(sys.security), secText: jumpPlanner.secText(sys.security),
				cyno: route.jumps === 2 ? route.via : route.jumps === 1 ? route.id : null,
				home: path.home, holes: path.holes, warnings: jumpPlanner.holeWarnings(path.holes, need, r.preset ? r.preset.group : "")
			});
		});
		return {
			range: r.range, max: r.max, preset: r.preset, covert: covert, need: need, opts: opts, problem: problem, rows: rows,
			counts: { reachable: rows.filter(function(x) { return x.jumps !== null; }).length, total: rows.length }
		};
	},

	/** "1 jump 6.2 LY", "2 jumps via M (5.8 + 5.6 LY)", or why not */
	routeText: function(row, name, settings) {
		if (row.jumps === 0) { return "you are here"; }
		if (row.jumps === 1) { return "1 jump " + row.legs[0].toFixed(1) + " LY"; }
		if (row.jumps === 2) { return "2 jumps via " + name(row.via) + " (" + row.legs[0].toFixed(1) + " + " + row.legs[1].toFixed(1) + " LY)"; }
		const direct = row.reach && isFinite(row.reach.direct) ? " (" + row.reach.direct.toFixed(1) + " LY)" : "";
		switch (row.reason) {
			case "range": return "out of range within 2 jumps" + direct;
			case "jammed": return "cyno-jammed (normal cyno)";
			case "target": return (jumpRange.kind(row.id, { security: row.sec }) === "ls" ? "low-sec" : "null-sec") + " targets are off in Settings";
			case "nopos": return "no position known";
			default: return "not reachable";
		}
	},

	/** Why a start can't be used, for the panel */
	startProblemText: function(problem, startName) {
		switch (problem) {
			case "none": return "Pick the system to jump from: type a name, or click Jita or Amarr.";
			case "supercap": return "Supercarriers and titans can't go through wormholes. Pick another jump ship to plan the way home.";
			case "wh": return startName + " is in wormhole space: jump drives can't be used there. Pick a k-space system.";
			case "zarzakh": return startName + " is Zarzakh: jump drives can't be used there. Pick another system.";
			case "nopos": return "No position known for " + startName + ".";
			case "unknown": return "Unknown system.";
			default: return "";
		}
	},

	/** Mode switch for the panel: From exit | Get home */
	modeHtml: function(mode) {
		const b = function(value, text, title) {
			return "<button type='button' data-jp-mode='" + value + "' class='" + (mode === value ? "active" : "") + "' title='" + title + "'>" + text + "</button>";
		};
		return "<span class='jp-mode' role='group' aria-label='Planner mode'>"
			+ b("exit", "From exit", "Where a jump ship can go from each low/null-sec exit on the chain")
			+ b("home", "Get home", "From a system of your choice, jump to an exit on the chain and take the wormholes home") + "</span>";
	},

	/** "Home: J152820" (or several homes, or none) */
	homeText: function(homes, name) {
		if (!homes || !homes.length) { return "no home on this chain"; }
		return "Home: " + homes.map(name).join(", ");
	},

	/** Quick picks for the start: the last one used (when not a hub), Jita, Amarr */
	quickPicks: function(lastID) {
		const list = Number(lastID) > 0 && jumpPlanner.HUBS.indexOf(Number(lastID)) < 0 ? [Number(lastID)] : [];
		return list.concat(jumpPlanner.HUBS);
	},

	/** Start row (HTML, escaped): quick-pick buttons and, when there is one, why the start can't be used */
	quickPicksHtml: function(picks, startID, lastID, name) {
		const esc = jumpPlanner.escape;
		return (picks || []).map(function(id) {
			const title = Number(id) === Number(lastID) && jumpPlanner.HUBS.indexOf(Number(id)) < 0 ? "Last used start" : "Jump from " + name(id);
			return "<button type='button' class='jp-quick" + (Number(id) === Number(startID) ? " active" : "") + "' data-jp-start='" + (parseInt(id, 10) || 0) + "' title='" + esc(title) + "'>" + esc(name(id)) + "</button>";
		}).join("");
	},

	/** The Get home list: reachable exits first (ranked), then the rest greyed with the reason; warnings under each row */
	homeListHtml: function(model, name, settings, homes) {
		const esc = jumpPlanner.escape;
		let html = "<table class='jp-list jp-home-list'><thead><tr><th>Exit</th><th>Jump route</th><th>Wormholes</th><th></th></tr></thead><tbody>";
		if (!model.rows.length) { html += "<tr><td colspan='4' class='jp-empty'>No low-sec or null-sec exits on this chain.</td></tr>"; }
		const several = (homes || []).length > 1;
		model.rows.forEach(function(r) {
			const ok = r.jumps !== null;
			const holes = r.holes.length + (r.holes.length === 1 ? " hole" : " holes") + " to " + (several ? name(r.home) : "home");
			const dest = ok && r.cyno ? "<a href='#' class='jp-home-dest' data-jp-cyno='" + r.cyno + "' title='" + esc("Set destination in game: " + name(r.cyno)) + "'>Dest</a>" : "";
			html += "<tr data-jp-id='" + r.id + "' class='jp-home-row" + (ok ? "" : " jp-row-out") + "'>"
				+ "<td class='jp-col-name'>" + esc(r.name) + " <span class='" + jumpPlanner.secClass(r.sec) + "'>" + esc(r.secText) + "</span></td>"
				+ "<td class='jp-col-route" + (ok ? "" : " jp-dim") + "'>" + esc(jumpPlanner.routeText(r, name, settings)) + "</td>"
				+ "<td class='jp-col-holes' title='" + esc(r.holes.map(jumpPlanner.holeLabel).join(" → ") + " → " + name(r.home)) + "'>" + esc(holes) + "</td>"
				+ "<td class='jp-col-act'>" + dest + "</td></tr>";
			if (r.warnings.length) {
				html += "<tr data-jp-id='" + r.id + "' class='jp-home-warn" + (ok ? "" : " jp-row-out") + "'><td colspan='4'>" + r.warnings.map(function(w) {
					return "<span class='jp-w-" + w.level + "'>" + (w.level === "warn" ? "⚠ " : "") + esc(w.text) + "</span>";
				}).join("") + "</td></tr>";
			}
		});
		return html + "</tbody></table>";
	},

	/** Footer for Get home: "2 of 4 exits reachable" */
	homeFooterText: function(model) {
		return model.counts.reachable + " of " + model.counts.total + (model.counts.total === 1 ? " exit" : " exits") + " reachable within 2 jumps";
	},

	/** Plain-text routes for the clipboard */
	homeCopyText: function(model, startName, name, jdc) {
		const lines = ["Get home from " + startName + " (" + (model.preset ? model.preset.label : "") + ", JDC " + jumpPlanner.ROMAN[jdc] + ", " + jumpRange.formatLy(model.range) + ")"];
		model.rows.forEach(function(r) {
			lines.push([r.name, r.secText, jumpPlanner.routeText(r, name), r.holes.length + " holes to " + name(r.home)].join("\t")
				+ (r.warnings.length ? "\t" + r.warnings.map(function(w) { return w.text; }).join("; ") : ""));
		});
		return lines.join("\n");
	},

	/** A position on the mini-map (mapModel() output) */
	projectPoint: function(mapModel, pos) {
		if (!pos || !mapModel.origin) { return null; }
		return { x: Math.round((mapModel.cx + (pos.x - mapModel.origin.x) * mapModel.scale) * 10) / 10, y: Math.round((mapModel.cy - (pos.z - mapModel.origin.z) * mapModel.scale) * 10) / 10 };
	},

	/**
	 * Get home overlay on the mini-map (SVG, escaped): the chain's exits as diamonds with their names, and the selected
	 * route as lines start → (midpoint) → exit.
	 * @param rows homeModel() rows; pos {systemID: {x, y, z}}; selectedID the route to draw
	 */
	homeOverlaySvg: function(mapModel, rows, pos, selectedID, name) {
		const esc = jumpPlanner.escape;
		const W = jumpPlanner.MAP_W, H = jumpPlanner.MAP_H;
		const inside = function(p) { return p && p.x >= -2 && p.x <= W + 2 && p.y >= -2 && p.y <= H + 2; };
		let svg = "<g class='jp-home-overlay'>";
		const sel = (rows || []).filter(function(r) { return r.id === Number(selectedID) && r.jumps; })[0];
		if (sel) {
			const ids = [null].concat(sel.via ? [sel.via] : []).concat([sel.id]);
			const pts = ids.map(function(id) { return id === null ? { x: mapModel.cx, y: mapModel.cy } : jumpPlanner.projectPoint(mapModel, pos[id]); });
			if (pts.every(function(p) { return p; })) {
				svg += "<polyline class='jp-route' points='" + pts.map(function(p) { return p.x + "," + p.y; }).join(" ") + "'></polyline>";
				if (sel.via && inside(pts[1])) {
					svg += "<circle class='jp-route-mid' cx='" + pts[1].x + "' cy='" + pts[1].y + "' r='4'></circle>"
						+ "<text class='jp-l-mid' x='" + pts[1].x + "' y='" + (pts[1].y + 15) + "' text-anchor='middle'>" + esc(name(sel.via)) + "</text>";
				}
			}
		}
		// Names beside the diamonds: right or left, above or below, whichever is free and inside the map
		const boxes = [{ x0: mapModel.cx - 8, x1: mapModel.cx + 8, y0: mapModel.cy - 8, y1: mapModel.cy + 8 }];
		let labels = "";
		(rows || []).forEach(function(r) {
			const p = jumpPlanner.projectPoint(mapModel, pos[r.id]);
			if (!inside(p)) { return; }
			const d = 6;
			svg += "<g class='jp-pt jp-hx" + (r.jumps !== null ? " jp-hx-ok" : " jp-hx-no") + (r.id === Number(selectedID) ? " jp-hx-sel" : "") + "' data-jp-id='" + r.id + "'>"
				+ "<polygon points='" + [[p.x, p.y - d], [p.x + d, p.y], [p.x, p.y + d], [p.x - d, p.y]].map(function(q) { return q[0] + "," + q[1]; }).join(" ") + "'></polygon></g>";
			boxes.push({ x0: p.x - d, x1: p.x + d, y0: p.y - d, y1: p.y + d });
			const w = String(r.name).length * 6.2 + 2;
			const spots = [[8, -5, "start"], [-8, -5, "end"], [8, 13, "start"], [-8, 13, "end"]].map(function(o) {
				const x0 = o[2] === "start" ? p.x + o[0] : p.x + o[0] - w;
				return { x: p.x + o[0], y: p.y + o[1], anchor: o[2], box: { x0: x0, x1: x0 + w, y0: p.y + o[1] - 9, y1: p.y + o[1] + 2 } };
			});
			const free = spots.filter(function(o) {
				return o.box.x0 >= 0 && o.box.x1 <= W && o.box.y0 >= 0 && o.box.y1 <= H && !boxes.some(function(b) {
					return o.box.x0 < b.x1 && o.box.x1 > b.x0 && o.box.y0 < b.y1 && o.box.y1 > b.y0;
				});
			})[0];
			if (!free) { return; }
			boxes.push(free.box);
			labels += "<text class='jp-l-hx' x='" + Math.round(free.x * 10) / 10 + "' y='" + Math.round(free.y * 10) / 10 + "' text-anchor='" + free.anchor + "'>" + esc(r.name) + "</text>";
		});
		return svg + labels + "</g>";
	},

	/**
	 * Where the panel goes without a saved position (first open, after Settings > Reset).
	 * "right": the highest free spot against the right edge of the window (the free space beside the chain map in the
	 * usual layout), else under everything at the right; "left": the first column at the top (the widgets there
	 * move down to make room).
	 * @param widgets [{col, row, size_x, size_y}]; availableCols grid columns that fit in the window
	 */
	defaultPlacement: function(widgets, availableCols, dock) {
		const size = jumpPlanner.SIZE;
		const list = (widgets || []).filter(function(w) { return w; }).map(function(w) {
			const col = Number(w.col) || 1, row = Number(w.row) || 1;
			return { c0: col, c1: col + (Number(w.size_x) || 1) - 1, r0: row, r1: row + (Number(w.size_y) || 1) - 1 };
		});
		const maxCol = list.reduce(function(m, w) { return Math.max(m, w.c1); }, 0);
		const maxRow = list.reduce(function(m, w) { return Math.max(m, w.r1); }, 0);
		const place = function(col, row) { return { col: col, row: row, size_x: size.x, size_y: size.y }; };
		if (dock === "left") { return place(1, 1); }
		const cols = Math.max(availableCols || 0, size.x);
		const col = availableCols ? cols - size.x + 1 : maxCol + 1;
		const free = function(row) {
			return !list.some(function(w) { return w.c0 <= col + size.x - 1 && w.c1 >= col && w.r0 <= row + size.y - 1 && w.r1 >= row; });
		};
		for (let row = 1; row <= maxRow + 1; row++) {
			if (free(row)) { return place(col, row); }
		}
		return place(col, maxRow + 1);
	},

	/** Placement from a saved entry ({col, row, size_x, size_y}), or null */
	savedPlacement: function(entry) {
		if (!entry || typeof entry !== "object") { return null; }
		const p = {
			col: Number(entry.col), row: Number(entry.row),
			size_x: Math.max(jumpPlanner.MIN_SIZE.x, Number(entry.size_x) || 0),
			size_y: Math.max(jumpPlanner.MIN_SIZE.y, Number(entry.size_y) || 0)
		};
		return p.col >= 1 && p.row >= 1 ? p : null;
	},

	/** The widget's entry in options.grid (array or object, old "oog" format) */
	gridEntry: function(grid, id) {
		if (!grid || typeof grid !== "object") { return null; }
		const source = grid.oog && typeof grid.oog === "object" && Object.keys(grid.oog).length ? grid.oog : grid;
		const entries = Array.isArray(source) ? source : Object.keys(source).map(function(k) { return source[k]; });
		return entries.filter(function(e) { return e && e.id === id; })[0] || null;
	},

	/** Options of the Settings ship select (a disabled "Loading ships…" one until ships.json is there) */
	shipOptionsHtml: function(presets) {
		const esc = jumpPlanner.escape;
		if (!presets || !presets.length) { return "<option value='' disabled>Loading ships…</option>"; }
		return presets.map(function(p) {
			return "<option value='" + esc(p.key) + "' title='" + esc(p.ships.join(", ")) + "'>" + esc(p.label + " (" + p.baseLy + " LY base)") + "</option>";
		}).join("");
	},

	/** A layout (options.grid: array, object, or the old {oog: ...} form) without the panel's entry. Never mutates grid. */
	withoutGridEntry: function(grid, id) {
		if (!grid || typeof grid !== "object") { return grid; }
		const strip = function(source) {
			if (Array.isArray(source)) { return source.filter(function(e) { return !(e && e.id === id); }); }
			const out = {};
			Object.keys(source || {}).forEach(function(k) { if (!(source[k] && source[k].id === id)) { out[k] = source[k]; } });
			return out;
		};
		if (grid.oog && typeof grid.oog === "object") { return Object.assign(strip(grid), { oog: strip(grid.oog) }); }
		return strip(grid);
	},

	/** Settings > Routes & Navigation row, next to the other panels' on/off rows (same key as "Enable jump planner") */
	generalRowHtml: function() {
		return "<tr><th>Jump planner:</th><td><label><input type='checkbox' id='jumpPlanner-enabled-general' /> Show the Jump planner and its ring on low/null-sec exits</label></td></tr>";
	},

	/** Settings section rows (HTML) */
	settingsHtml: function(presets) {
		const esc = jumpPlanner.escape;
		const radios = function(name, list) {
			return list.map(function(o) { return "<label><input type='radio' name='" + name + "' value='" + esc(o[0]) + "' /> " + esc(o[1]) + "</label>"; }).join(" ");
		};
		const swatch = function(i, text) { return "<span class='jp-swatch' style='background: " + jumpPlanner.BAND_COLORS[i] + "'></span>" + esc(text); };
		// The rows of Settings > Jump Planner (the section itself comes from forkSettings.section)
		return "<tr><th>Enable jump planner:</th><td>" + radios("jumpPlanner-enabled", [["1", "Yes"], ["0", "No"]]) + "</td></tr>"
			+ "<tr><th>Jump ship:</th><td><select id='jumpPlanner-ship'>" + jumpPlanner.shipOptionsHtml(presets) + "</select>"
			+ " <span class='jp-settings-error hidden'></span></td></tr>"
			+ "<tr><th>Jump Drive Calibration:</th><td>" + radios("jumpPlanner-jdc", jumpPlanner.ROMAN.map(function(r, i) { return [String(i), r]; })) + "</td></tr>"
			+ "<tr><th>Range used:</th><td><span class='jp-dim'>cap</span> <input type='range' id='jumpPlanner-cap' min='1' max='10' step='0.05' /> <span id='jumpPlanner-cap-label' class='jp-cap-label'></span></td></tr>"
			+ "<tr><th>Targets:</th><td><label><input type='checkbox' id='jumpPlanner-lowsec' /> <span class='jp-ls'>Low-sec</span></label> <label><input type='checkbox' id='jumpPlanner-nullsec' /> <span class='jp-ns'>Null-sec</span></label></td></tr>"
			+ "<tr><th>Exits that get a range:</th><td><select id='jumpPlanner-exits'><option value='all'>All LS/NS exits in the chain</option><option value='viewing'>Only the system I'm viewing</option></select></td></tr>"
			+ "<tr><th>Distance bands:</th><td class='jp-bands'>" + swatch(0, "≤ 3.5") + swatch(1, "≤ 5.0") + swatch(2, "≤ max") + "</td></tr>"
			+ "<tr><th>Cyno-jammed systems:</th><td><select id='jumpPlanner-jammed'><option value='mark'>Show, marked as jammed</option><option value='hide'>Hide</option><option value='ignore'>Treat as in range</option></select></td></tr>"
			+ "<tr class='jp-sep'><td colspan='2'></td></tr>"
			+ "<tr><th>Dock side:</th><td>" + radios("jumpPlanner-dock", [["right", "Right"], ["left", "Left"]]) + " <span class='jp-dim'>(where the panel first opens)</span></td></tr>"
			+ "<tr><th>Open when I click an exit:</th><td>" + radios("jumpPlanner-click", [["1", "Yes"], ["0", "Only from ring icon"]]) + "</td></tr>"
			+ "<tr><th>Mini-map shows:</th><td><span class='jp-dim'>out to</span> <input type='range' id='jumpPlanner-radius' min='7' max='15' step='1' /> <span id='jumpPlanner-radius-label'></span></td></tr>"
			+ "<tr><th>Out-of-range systems:</th><td><label><input type='checkbox' id='jumpPlanner-showOut' /> Show greyed in mini-map</label></td></tr>"
			+ "<tr><th>High-sec systems:</th><td><label><input type='checkbox' id='jumpPlanner-showHs' /> Show inside the range (no cyno there)</label></td></tr>"
			+ "<tr><th>Trade-hub reach:</th><td>" + radios("jumpPlanner-hubs", [["1", "Show"], ["0", "Hide"]]) + "</td></tr>"
			+ "<tr><th>System search:</th><td>" + radios("jumpPlanner-search", [["1", "Show"], ["0", "Hide"]]) + " <span class='jp-dim'>(find a system in the list)</span></td></tr>";
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	(function() {
		const jp = jumpPlanner;
		const state = {
			exits: [],			// exits on the current chain (setting applied)
			selected: null,
			data: null,			// {coords, index, presets} once loaded
			loading: null,
			error: "",
			jammed: {},			// {systemID: {setBy, age, at}}
			jammedTimer: null,
			sort: { key: "ly", dir: 1 },
			hoverID: null,
			pinnedID: null,
			gates: {},			// {exitID: gate jumps from it}
			counts: {},			// {key: in-range count}
			renderTimer: null,
			hideTip: null,
			last: null,			// {ctx, model, mapModel} of the last render
			// System search (this page only): the picked system, the suggestions, and whether to scroll to it on the next render
			search: { id: null, matches: [], active: -1, scroll: false, refocusing: false },
			$search: null,			// the search row, kept across renders so typing isn't lost
			// Get home mode
			chainResult: null,		// the last chain.nodes() output (rows and lines)
			homeKey: "",			// exits and holes on the way home, to redraw when they change
			allExits: [],			// every LS/NS exit on the chain (Get home ignores "Exits that get a range")
			start: null,			// the system to jump from (options.jumpRange.origin once a valid one is picked)
			from: { matches: [], active: -1, refocusing: false },
			$from: null				// the "Jump from" row, kept across renders like the search row
		};

		function current() { return jp.settings(options); }
		function isOn() { return jp.enabled(options); }
		function systems() { return (tripwire && tripwire.systems) || appData.systems; }
		function regions() { return (tripwire && tripwire.regions) || appData.regions; }
		function gateMap() { return (tripwire.map && tripwire.map.shortest) || appData.map.shortest; }
		function name(id) { return (systems()[id] || appData.systems[id] || {}).name || String(id); }
		function notify(html, color, ms) { if (typeof Notify !== "undefined") { Notify.trigger(html, color, ms); } }
		function $widget() { return $("#" + jp.WIDGET_ID); }
		function gridApi() { return typeof grid !== "undefined" && grid && typeof grid.add_widget === "function" ? grid : null; }
		function viewing() { return typeof viewingSystemID !== "undefined" ? viewingSystemID : null; }

		/** Save some keys of options.jumpRange (keeping the rest) */
		function store(changes, save) {
			options.jumpRange = Object.assign({}, options.jumpRange || {}, changes);
			if (save) { options.save(); }
		}

		// Settings > Reset happened in this page and the panel hasn't been placed since: forget its saved position
		// (options.apply() restores options.grid from the browser's copy, so the layout entry is dropped there too)
		let resetPending = false;

		// ---- Data ----

		let presets = null, presetsLoading = null;

		/** The ship presets (ships.json, small): for Settings and the panel. A failed fetch is retried on the next call. */
		function loadShips() {
			if (presets) { return $.Deferred().resolve(presets).promise(); }
			if (!presetsLoading) {
				presetsLoading = $.getJSON(jp.DATA_URL + "ships.json?v=" + jp.DATA_VERSION).then(function(ships) {
					presets = jumpRange.presets(ships);
					return presets;
				}, function() {
					presetsLoading = null;
					return $.Deferred().reject().promise();
				});
			}
			return presetsLoading;
		}

		/** Everything the panel needs: positions (systems.json, only fetched when the panel is first shown) and presets */
		function load() {
			if (state.data) { return $.Deferred().resolve(state.data).promise(); }
			if (state.loading) { return state.loading; }
			state.loading = $.when($.getJSON(jp.DATA_URL + "systems.json?v=" + jp.DATA_VERSION), loadShips()).then(function(sys, list) {
				const coords = jumpRange.decode(sys[0]);
				state.data = { coords: coords, index: jumpRange.buildIndex(coords, 7), presets: list };
				state.error = "";
				return state.data;
			}, function() {
				state.error = "Could not load the jump range data. Click an exit's ring icon to try again.";
				state.loading = null;
				return $.Deferred().reject().promise();
			});
			return state.loading;
		}

		function loadJammed() {
			clearTimeout(state.jammedTimer);
			if (!$widget().length) { return; }
			$.ajax({ url: jp.JAMMED_URL, type: "GET", dataType: "JSON", cache: false, timeout: 15000 }).done(absorbJammed).always(function() {
				clearTimeout(state.jammedTimer);
				state.jammedTimer = setTimeout(loadJammed, jp.JAMMED_REFRESH_MS);
			});
		}

		function absorbJammed(response) {
			const next = {};
			((response && response.jammed) || []).forEach(function(j) {
				const id = parseInt(j.systemID, 10);
				if (id) { next[id] = { setBy: j.setBy || "", age: Number(j.age) || 0, at: Date.now() - (Number(j.age) || 0) * 1000 }; }
			});
			const changed = JSON.stringify(Object.keys(next).sort()) !== JSON.stringify(Object.keys(state.jammed).sort());
			state.jammed = next;
			state.counts = {};
			if (changed || state.pinnedID) { render(); }
		}

		function jammedNow() {
			const out = {};
			Object.keys(state.jammed).forEach(function(id) {
				const j = state.jammed[id];
				out[id] = { setBy: j.setBy, age: Math.round((Date.now() - j.at) / 1000) };
			});
			return out;
		}

		function toggleJammed(id) {
			const mode = state.jammed[id] ? "clear" : "set";
			$.ajax({ url: jp.JAMMED_URL, type: "POST", data: { mode: mode, systemID: id }, dataType: "JSON", timeout: 15000,
				headers: { "X-Requested-With": "XMLHttpRequest" } }).done(function(response) {
				absorbJammed(response);
				render();
			}).fail(function() {
				notify("Could not " + (mode === "set" ? "mark " : "unmark ") + jp.escape(name(id)) + " as cyno-jammed.", "red", 6000);
			});
		}

		// ---- Chain map ----

		let hooked = false;	// other features wrap chain.nodes after us (not always keeping our flag): wrap once
		function installHook() {
			if (hooked || typeof chain === "undefined" || !chain || typeof chain.nodes !== "function" || chain.nodes.jumpPlannerWrapped) { return; }
			hooked = true;
			const previous = chain.nodes;
			const wrapped = function() {
				const result = previous.apply(this, arguments);
				try {
					const s = current();
					const exits = s.enabled ? jp.chainExits(result, systems(), s.exits, viewing()) : [];
					jp.decorate(result, exits, systems());
					state.chainResult = result;
					// Get home: every LS/NS exit (not the "Exits that get a range" setting), and the holes on the way
					// home (new, EOL, mass, preserve mass, a new root)
					const allExits = s.enabled ? jp.homeExits(result, systems()) : [];
					const homeKey = s.enabled && s.mode === "home" ? jp.homeKey(result, systems(), preserveFlags()) : "";
					if (exits.join(",") !== state.exits.join(",") || allExits.join(",") !== state.allExits.join(",") || homeKey !== state.homeKey) {
						state.exits = exits;
						state.allExits = allExits;
						state.homeKey = homeKey;
						clearTimeout(state.renderTimer);
						state.renderTimer = setTimeout(render, 150);	// debounced: the chain redraws often
					}
				} catch (e) { console.warn("Jump planner: could not decorate the chain", e); }
				return result;
			};
			Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
			wrapped.jumpPlannerWrapped = true;
			chain.nodes = wrapped;
		}

		function redrawChain() { if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); } }

		// ---- Widget ----

		function widgetHtml() {
			return "<li id='" + jp.WIDGET_ID + "' class='gridWidget'>"
				+ "<div class='controls'><span class='jp-title'>Jump planner</span>"
				+ "<i class='jp-close' data-icon='times' title='Close the Jump planner'></i>"
				+ "<i class='jp-settings' data-icon='settings' title='Jump planner settings'></i></div>"
				+ "<div class='content'><div class='jp-head'></div><div class='jp-modebar'></div><div class='jp-tabs'></div><div class='jp-body'></div></div>"
				+ "</li>";
		}

		function availableCols(api) {
			const o = api.options || {};
			const step = ((o.widget_base_dimensions || [50])[0]) + 2 * ((o.widget_margins || [5])[0]);
			const zoom = parseFloat($("body").css("zoom")) || 1;
			return Math.floor((window.innerWidth || $(window).width()) / zoom / step);
		}

		function addWidget() {
			const api = gridApi();
			if (!api) { return null; }
			const $existing = $widget();
			if ($existing.length) {
				if (api.$widgets.is($existing)) { return $existing; }
				$existing.stop(true, true).remove();
			}
			const s = current();
			// After Settings > Reset the remembered position is gone: place it by the Dock side setting
			const placement = (resetPending ? null : jp.savedPlacement(jp.gridEntry(options.grid, jp.WIDGET_ID)) || jp.savedPlacement(s.position))
				|| jp.defaultPlacement(api.serialize(), availableCols(api), s.dock);
			resetPending = false;
			const $w = api.add_widget(widgetHtml(), placement.size_x, placement.size_y, placement.col, placement.row, null, [jp.MIN_SIZE.x, jp.MIN_SIZE.y]);
			$w.stop(true, true);
			$w.find(".grid-resize").attr("data-icon", "resize").toggleClass("hidden", !$("#layout").hasClass("active"));
			loadJammed();
			return $w;
		}

		function removeWidget() {
			const api = gridApi();
			const $w = $widget();
			clearTimeout(state.jammedTimer);
			resetSearch();	// the search lasts while the panel is open
			if (!api || !$w.length) { return; }
			// Remember where it was, so opening it again puts it back there (not when Settings > Reset removes it)
			const entry = jp.gridEntry(api.serialize($w), jp.WIDGET_ID);
			if (entry && !resetPending) { store({ position: { col: entry.col, row: entry.row, size_x: entry.size_x, size_y: entry.size_y } }); }
			$w.attr("id", jp.WIDGET_ID + "-removed");
			api.remove_widget($w, true);
			$w.stop(true, true);
		}

		/** Open the panel on an exit's tab (fromRing: the exit's ring icon, which always shows From exit) */
		function open(systemID, fromRing) {
			if (!isOn()) { return; }
			const id = parseInt(systemID, 10);
			if (id) { state.selected = id; }
			if (fromRing && current().mode === "home") { store({ mode: "exit" }, true); }
			state.pinnedID = null;
			state.error = "";
			const wasOpen = !!$widget().length;
			const $w = addWidget();
			if (!current().open) { store({ open: true }, true); }
			if ($w && !wasOpen && $w[0].scrollIntoView) { setTimeout(function() { $w[0].scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 50); }
			render();
		}

		/** Settings (the toolbar's path) with the Jump Planner section open */
		function openSettings() {
			$("#settings.options").first().trigger("click");
			setTimeout(function() {
				const $accordion = $("#dialog-options #optionsAccordion");
				const index = $accordion.children("h3").index($("#jumpPlanner-header"));
				if (index >= 0 && $accordion.hasClass("ui-accordion")) { $accordion.accordion("option", "active", index); }
			}, 0);
		}

		function close() {
			removeWidget();
			store({ open: false }, true);
		}

		/** Show or remove the panel to match the settings (Save, Reset, start) */
		function sync() {
			if (isOn() && current().open) { addWidget(); render(); } else { removeWidget(); }
		}

		// ---- Rendering ----

		function context(exitID) {
			const s = current();
			const d = state.data;
			if (!state.gates[exitID]) {
				if (Object.keys(state.gates).length > 20) { state.gates = {}; }
				state.gates[exitID] = jumpRange.gateJumps(gateMap(), exitID);
			}
			return { exitID: exitID, index: d.index, coords: d.coords, systems: systems(), regions: regions(), map: gateMap(),
				settings: s, presets: d.presets, jammed: jammedNow(), gates: state.gates[exitID] };
		}

		function countFor(exitID) {
			const s = current();
			const key = exitID + "|" + JSON.stringify([s.ship, s.jdc, s.cap, s.lowsec, s.nullsec, s.jammed]);
			if (state.counts[key] === undefined) {
				const ctx = context(exitID);
				state.counts[key] = jp.model(ctx).counts.inRange;
			}
			return state.counts[key];
		}

		function render() {
			const $w = $widget();
			if (!$w.length) { return; }
			if (!state.data) {
				$w.find(".jp-body").html("<div class='jp-state" + (state.error ? " jp-error" : "") + "'>" + jp.escape(state.error || "Loading jump range data…") + "</div>");
				if (state.error) { return; }	// tried again when the planner is opened again (open() clears it)
				load().always(render);
				return;
			}
			const s = current();
			const exits = state.exits.slice();
			if (state.selected && exits.indexOf(state.selected) < 0 && !jp.isRangeExit(state.selected, systems()[state.selected])) { state.selected = null; }
			// The selected exit stays while it is a LS/NS system, even when it isn't on the chain any more (opened from elsewhere)
			if (state.selected && exits.indexOf(state.selected) < 0) { exits.push(state.selected); }
			if (!state.selected) { state.selected = exits[0] || null; }
			const r = jp.range(s, state.data.presets);
			$w.find(".jp-head").html(jp.headerHtml(state.data.presets, s, r.range));
			$w.find(".jp-modebar").html(jp.modeHtml(s.mode) + "<span class='jp-home-name'></span>");
			const fromFocus = !!state.$from && state.$from.find(".jp-from-input").is(":focus");
			if (state.$from) { state.$from.detach(); }
			if (s.mode === "home") { renderHome($w, s, fromFocus); return; }
			$w.find(".jp-tabs").removeClass("hidden").html(jp.tabsHtml(exits, state.selected, name, exits.reduce(function(acc, id) { acc[id] = countFor(id); return acc; }, {})));
			const $body = $w.find(".jp-body");
			if (!state.selected) {
				$body.html("<div class='jp-state'>No low-sec or null-sec exits on this chain. Exits get a small ring icon on the chain map; click it to plan jumps from there.</div>");
				return;
			}
			if (!state.data.index.pos[state.selected]) {
				$body.html("<div class='jp-state'>No position known for " + jp.escape(name(state.selected)) + ".</div>");
				return;
			}
			const ctx = context(state.selected);
			const model = jp.model(ctx);
			const mapModel = jp.mapModel(ctx, model);
			state.last = { ctx: ctx, model: model, mapModel: mapModel };
			const rows = jp.sortRows(model.rows, state.sort.key, state.sort.dir);
			const scroll = $body.find(".jp-list-wrap").scrollTop();
			const $search = searchRow();
			const searchFocus = $search.find(".jp-search-input").is(":focus");
			$search.detach();
			if (!s.search) { resetSearch(); }
			let hubs = "";
			if (s.hubs) {
				const hubOpts = { covert: model.covert, jammed: s.jammed === "ignore" ? {} : model.opts.jammed };
				hubs = "<div class='jp-hubs'>" + jp.hubsHtml(jp.HUBS.map(function(hubID) {
					return {
						hubID: hubID,
						to: jumpRange.reach(hubID, state.selected, model.range, ctx.index, ctx.systems, hubOpts, 2),
						back: jumpRange.nearHub(state.selected, hubID, model.range, ctx.index, ctx.systems, ctx.map, hubOpts, jp.HUB_GATES)
					};
				}), name(state.selected), name) + "</div>";
			}
			$body.html("<div class='jp-map'>" + mapHtml() + "<div class='jp-tip hidden'></div>"
				+ "<span class='jp-map-note'>top-down, true scale · " + jp.escape(s.mapRadius + " LY") + "</span></div>"
				+ hubs
				+ "<div class='jp-list-wrap'>" + jp.listHtml(rows, state.sort, s, model.covert) + "</div>"
				+ "<div class='jp-foot'><span class='jp-foot-text'>" + jp.escape(jp.footerText(model, mapModel.outShown, s.showOut)) + "</span>"
				+ "<a href='#' class='jp-copy-list'>Copy list</a></div>");
			$body.find(".jp-list-wrap").scrollTop(scroll || 0);
			if (s.search) { $body.find(".jp-list-wrap").before($search); }
			if (searchFocus) {
				// Only moved: keep the suggestions and the highlighted one as they are (the focus handler leaves them alone)
				state.search.refocusing = true;
				try { $search.find(".jp-search-input")[0].focus({ preventScroll: true }); } finally { state.search.refocusing = false; }
			}
			showSearch();
			if (state.pinnedID) { showTip(state.pinnedID); } else if (state.search.id) { showTip(state.search.id); }
		}

		function mapHtml() {
			const l = state.last;
			if (l.home) {
				// Get home: only the start's label from the usual set; the exits carry their own names
				const focusHome = [state.hoverID, state.pinnedID];
				const first = l.home.rows.filter(function(r) { return r.jumps; })[0];
				const selected = state.pinnedID || state.hoverID || (first ? first.id : null);
				const labels = jp.placeLabels(l.mapModel, []).filter(function(x) { return x.cls === "jp-l-exit"; });
				return jp.mapSvg(l.mapModel, labels, focusHome, null, jp.homeOverlaySvg(l.mapModel, l.home.rows, l.ctx.index.pos, selected, name));
			}
			const focus = [state.hoverID, state.pinnedID, state.search.id];
			return jp.mapSvg(l.mapModel, jp.placeLabels(l.mapModel, focus), focus, state.search.id);
		}

		// ---- Get home mode ----

		/** The mask's preserve-mass flags by wormhole id (preserve-mass.js), or none */
		function preserveFlags() {
			return typeof preserveMass !== "undefined" && preserveMass.flags ? preserveMass.flags : {};
		}

		/** Preserve-mass flags arrive and change without a chain redraw: hook the marker refresh both apply() and
		 * a local change go through, and show Get home again when a hole on a way home changed */
		function hookPreserveMass() {
			if (typeof preserveMass === "undefined" || typeof preserveMass.refreshMap !== "function" || preserveMass.refreshMap.jumpPlannerWrapped) { return; }
			const refreshMap = preserveMass.refreshMap;
			preserveMass.refreshMap = function() {
				const result = refreshMap.apply(this, arguments);
				try {
					const s = current();
					if (s.enabled && s.mode === "home" && state.chainResult) {
						const key = jp.homeKey(state.chainResult, systems(), preserveFlags());
						if (key !== state.homeKey) {
							state.homeKey = key;
							clearTimeout(state.renderTimer);
							state.renderTimer = setTimeout(render, 150);
						}
					}
				} catch (e) { console.warn("Jump planner: preserve mass refresh", e); }
				return result;
			};
			preserveMass.refreshMap.jumpPlannerWrapped = true;
		}

		/** Holes on the way home with what the other features know: size class (size-tags), real type, preserve-mass flag */
		function annotateHoles(paths) {
			Object.keys(paths).forEach(function(id) {
				paths[id].holes.forEach(function(h) {
					const real = typeof sizeTags !== "undefined" ? sizeTags.wormholeTypeFor(h.wormholeID) : undefined;
					h.realType = real || "";
					let tag = null;
					try {
						// The same lookup as the size tags on the chain map: one side is the hole's type, the other K162
						if (typeof sizeTags !== "undefined" && h.from && h.to) { tag = sizeTags.tagFor(real && real !== h.type ? real : "K162", h.type, h.from, h.to); }
					} catch (e) { tag = null; }
					h.size = tag ? tag.size : null;
					h.certain = !!(tag && tag.certain);
					h.preserve = !!preserveFlags()[String(h.wormholeID)];
				});
			});
			return paths;
		}

		function homeData() {
			const result = state.chainResult || (typeof chain !== "undefined" && chain && chain.data ? { map: chain.data.map, lines: chain.data.lines } : null);
			const hp = jp.homePaths(result);
			annotateHoles(hp.paths);
			return hp;
		}

		function startID() {
			if (!state.start) { state.start = current().origin; }
			return state.start;
		}

		function renderHome($w, s, fromFocus) {
			const hp = homeData();
			const start = startID();
			$w.find(".jp-modebar .jp-home-name").text(jp.homeText(hp.homes, name));
			$w.find(".jp-tabs").addClass("hidden").empty();
			const $body = $w.find(".jp-body");
			const $from = fromRow();
			$from.find(".jp-quicks").html(jp.quickPicksHtml(jp.quickPicks(s.origin), start, s.origin, name));
			if (!$from.find(".jp-from-input").is(":focus")) { $from.find(".jp-from-input").val(start ? name(start) : ""); }
			const scroll = $body.find(".jp-list-wrap").scrollTop();
			const ctx = context(start && state.data.index.pos[start] ? start : null);
			const home = jp.homeModel({ startID: start, exits: state.allExits, paths: hp.paths, index: state.data.index, systems: systems(),
				settings: s, presets: state.data.presets, jammed: ctx.jammed });
			let html;
			if (!hp.homes.length) {
				html = "<div class='jp-state'>No chain on this tab. Get home needs a chain map with a home system (the system the chain starts from).</div>";
				state.last = null;
			} else if (home.problem) {
				html = "<div class='jp-state" + (start ? " jp-error" : "") + "'>" + jp.escape(jp.startProblemText(home.problem, start ? name(start) : "")) + "</div>";
				state.last = null;
			} else {
				// The farthest reachable exit fits on the map (a little beyond, so it isn't lost to rounding at the edge)
				ctx.fitLy = home.rows.reduce(function(m, r) { return r.jumps ? Math.max(m, r.reach.direct + 0.05) : m; }, 0);
				const model = jp.model(ctx);
				const mapModel = jp.mapModel(ctx, model);
				state.last = { ctx: ctx, model: model, mapModel: mapModel, home: home };
				html = "<div class='jp-map'>" + mapHtml() + "<div class='jp-tip hidden'></div>"
					+ "<span class='jp-map-note'>top-down, true scale · centred on " + jp.escape(name(start)) + "</span></div>"
					+ "<div class='jp-list-wrap'>" + jp.homeListHtml(home, name, s, hp.homes) + "</div>"
					+ "<div class='jp-foot'><span class='jp-foot-text'>" + jp.escape(jp.homeFooterText(home)) + "</span>"
					+ "<a href='#' class='jp-copy-list'>Copy list</a></div>";
			}
			$body.html(html).prepend($from);
			$body.find(".jp-list-wrap").scrollTop(scroll || 0);
			if (fromFocus) {
				state.from.refocusing = true;
				try { $from.find(".jp-from-input")[0].focus({ preventScroll: true }); } finally { state.from.refocusing = false; }
			}
			if (state.last) {
				refreshMap();
				if (state.pinnedID) { showTip(state.pinnedID); }
			}
		}

		/** The "Jump from" row (built once; renderHome moves it into the new body) */
		function fromRow() {
			if (!state.$from) {
				state.$from = $("<div class='jp-from'><span class='jp-from-label'>Jump from</span><span class='jp-from-box'>"
					+ "<input type='text' class='jp-from-input' placeholder='System…' aria-label='The system to jump from'"
					+ " autocomplete='off' spellcheck='false' maxlength='40' role='combobox' aria-autocomplete='list' aria-expanded='false' />"
					+ "<ul class='jp-from-menu jp-search-menu hidden' role='listbox'></ul></span><span class='jp-quicks'></span></div>");
			}
			return state.$from;
		}

		function closeFromMenu() {
			state.from.matches = [];
			state.from.active = -1;
			fromRow().find(".jp-from-menu").addClass("hidden").empty();
			fromRow().find(".jp-from-input").attr("aria-expanded", "false");
		}

		function fromInput(text) {
			const $menu = fromRow().find(".jp-from-menu");
			if (!$.trim(text)) { closeFromMenu(); return; }
			state.from.matches = jp.searchSystems(text, systems());
			state.from.active = state.from.matches.length ? 0 : -1;
			if (!state.from.matches.length) { $menu.html("<li class='jp-search-none'>No system with that name</li>").removeClass("hidden"); return; }
			$menu.html(jp.searchMenuHtml(state.from.matches, state.from.active, systems(), regions())).removeClass("hidden");
			fromRow().find(".jp-from-input").attr("aria-expanded", "true");
		}

		/** A new start: remembered (options.jumpRange.origin) when a jump drive can be used there */
		function pickStart(id) {
			if (!id) { return; }
			state.start = id;
			state.pinnedID = null;
			state.hoverID = null;
			closeFromMenu();
			fromRow().find(".jp-from-input").val(name(id)).blur();
			if (state.data && !jumpRange.startProblem(id, systems()[id], state.data.index)) { store({ origin: id }, true); }
			render();
		}

		// ---- System search ----

		function resetSearch() {
			state.search = { id: null, matches: [], active: -1, scroll: false, refocusing: false };
			state.$search = null;
		}

		/** The search row (built once; render() moves it into the new body) */
		function searchRow() {
			if (!state.$search) {
				state.$search = $("<div class='jp-search'>"
					+ "<input type='text' class='jp-search-input' placeholder='Find system…' aria-label='Find a system: where it is in the list, or why it is not there'"
					+ " autocomplete='off' spellcheck='false' maxlength='40' role='combobox' aria-autocomplete='list' aria-expanded='false' />"
					+ "<ul class='jp-search-menu hidden' role='listbox'></ul>"
					+ "<span class='jp-search-result'></span></div>");
			}
			return state.$search;
		}

		/** Result line, row highlight and scroll for the picked system (after every render, so tab / ship changes re-run it) */
		function showSearch() {
			const $w = $widget();
			const $result = searchRow().find(".jp-search-result");
			$w.find(".jp-list tr.jp-row-found").removeClass("jp-row-found");
			const l = state.last;
			if (!state.search.id || !l || l.ctx.exitID !== state.selected) { $result.html("").removeAttr("title"); return; }
			const rows = jp.sortRows(l.model.rows, state.sort.key, state.sort.dir);
			const result = jp.searchStatus(state.search.id, l.ctx, l.model, rows);
			$result.html(jp.searchResultHtml(result, state.sort)).attr("title", $result.text());
			if (result.status !== "listed") { return; }
			const $row = $w.find(".jp-list tr[data-jp-id='" + result.id + "']").addClass("jp-row-found");
			if (!state.search.scroll || !$row.length) { return; }
			state.search.scroll = false;
			// Inside the list's own scroll box (not the page): the row in the middle, below the sticky header
			// Layout px only (offsetTop / offsetHeight / clientHeight), not getBoundingClientRect: with Settings > UI Scale
			// (body zoom) those are scaled while scrollTop isn't. The table is the scroll box's only child, at its top.
			const wrap = $w.find(".jp-list-wrap")[0];
			const head = $w.find(".jp-list thead")[0];
			wrap.scrollTop = jp.centerScrollTop($row[0].offsetTop, $row[0].offsetHeight, head ? head.offsetHeight : 0, wrap.clientHeight);
		}

		function closeMenu() {
			state.search.matches = [];
			state.search.active = -1;
			searchRow().find(".jp-search-menu").addClass("hidden").empty();
			searchRow().find(".jp-search-input").attr("aria-expanded", "false");
		}

		function drawMenu() {
			const $menu = searchRow().find(".jp-search-menu");
			if (!state.search.matches.length) { closeMenu(); return; }
			$menu.html(jp.searchMenuHtml(state.search.matches, state.search.active, systems(), regions())).removeClass("hidden");
			searchRow().find(".jp-search-input").attr("aria-expanded", "true");
		}

		/** Typing: new suggestions (the picked system stays until another is picked or the box is cleared) */
		function searchInput(text) {
			if (!$.trim(text)) { clearSearch(); return; }
			state.search.matches = jp.searchSystems(text, systems());
			state.search.active = state.search.matches.length ? 0 : -1;
			drawMenu();
			if (!state.search.matches.length) { searchRow().find(".jp-search-menu").html("<li class='jp-search-none'>No system with that name</li>").removeClass("hidden"); }
		}

		function pick(id) {
			if (!id) { return; }
			state.search.id = id;
			state.search.scroll = true;
			state.pinnedID = null;
			searchRow().find(".jp-search-input").val(name(id));
			closeMenu();
			refreshMap();
			showSearch();
			if (tipInfo(id) && tipInfo(id).point) { showTip(id); } else { $widget().find(".jp-tip").addClass("hidden"); }
		}

		function clearSearch() {
			const had = !!state.search.id;
			state.search.id = null;
			closeMenu();
			searchRow().find(".jp-search-input").val("");
			if (had) {
				refreshMap();
				showSearch();
				if (!state.pinnedID) { $widget().find(".jp-tip").addClass("hidden"); }
			}
		}

		/** Re-draw the map only (hover), keeping the rest */
		function refreshMap() {
			const $map = $widget().find(".jp-map");
			if (!state.last || !$map.length) { return; }
			$map.find("svg.jp-svg").replaceWith(mapHtml());
			$widget().find(".jp-list tr[data-jp-id]").removeClass("jp-row-focus");
			[state.hoverID, state.pinnedID].forEach(function(id) { if (id) { $widget().find(".jp-list tr[data-jp-id='" + id + "']").addClass("jp-row-focus"); } });
		}

		function tipInfo(id) {
			const l = state.last;
			if (!l) { return null; }
			const route = l.home ? l.home.rows.filter(function(r) { return r.id === id; })[0] : null;
			// Get home: an exit beyond the drawn systems still has its diamond
			const point = l.mapModel.points.filter(function(p) { return p.id === id; })[0] || (route ? jp.projectPoint(l.mapModel, l.ctx.index.pos[id]) : undefined) || undefined;
			const row = l.model.rows.filter(function(r) { return r.id === id; })[0];
			const sys = l.ctx.systems[id] || {};
			const region = l.ctx.regions && l.ctx.regions[sys.regionID] ? l.ctx.regions[sys.regionID].name : "";
			const kind = point ? point.kind : row ? (row.blocked ? "jammed" : "in") : "out";
			return {
				id: id, name: sys.name || String(id), sec: sys.security, region: region,
				ly: jumpRange.distanceLy(l.ctx.index.pos[l.ctx.exitID], l.ctx.index.pos[id]),
				band: row ? row.band : null, gates: l.ctx.gates[id] === undefined ? null : l.ctx.gates[id], kind: kind,
				jam: l.ctx.jammed[id] || null, canMark: jp.isRangeExit(id, sys), point: point,
				route: route ? jp.routeText(route, name) + " · " + route.holes.length + (route.holes.length === 1 ? " hole" : " holes") + " to " + name(route.home) : null,
				cyno: route && route.jumps ? route.cyno : null
			};
		}

		function showTip(id) {
			const $tip = $widget().find(".jp-tip");
			const info = tipInfo(id);
			if (!info || !$tip.length) { return; }
			clearTimeout(state.hideTip);
			$tip.html(jp.tooltipHtml(info)).attr("data-jp-id", id).toggleClass("jp-tip-pinned", state.pinnedID === id).removeClass("hidden");
			// Next to the point, inside the map (the SVG is scaled to the map's width)
			const $map = $widget().find(".jp-map");
			const svg = $map.find("svg.jp-svg")[0];
			if (!svg || !info.point) { $tip.css({ left: 6, top: 6 }); return; }
			const box = svg.getBoundingClientRect(), mapBox = $map[0].getBoundingClientRect();
			const k = Math.min(box.width / jp.MAP_W, box.height / jp.MAP_H);
			const ox = box.left - mapBox.left + (box.width - jp.MAP_W * k) / 2, oy = box.top - mapBox.top + (box.height - jp.MAP_H * k) / 2;
			const px = ox + info.point.x * k, py = oy + info.point.y * k;
			const w = $tip.outerWidth(), h = $tip.outerHeight();
			let left = px + 12, top = py + 10;
			if (left + w > mapBox.width - 4) { left = px - 12 - w; }
			if (top + h > mapBox.height - 4) { top = py - 10 - h; }
			$tip.css({ left: Math.max(4, left), top: Math.max(4, top) });
		}

		function hideTipSoon() {
			clearTimeout(state.hideTip);
			state.hideTip = setTimeout(function() {
				if (state.pinnedID) { showTip(state.pinnedID); return; }
				const found = state.search.id ? tipInfo(state.search.id) : null;
				if (found && found.point) { showTip(state.search.id); return; }
				$widget().find(".jp-tip").addClass("hidden");
			}, 350);
		}

		function hover(id) {
			if (state.hoverID === id) { return; }
			state.hoverID = id;
			refreshMap();
			if (id) { showTip(id); } else { hideTipSoon(); }
		}

		function setDestination(id) {
			if (typeof autopilotRoute === "undefined" || typeof autopilotRoute.push !== "function") {
				notify("Setting a destination in game isn't available.", "red", 5000);
				return;
			}
			// Get home: the jumps start at the chosen start, not at an exit
			const from = state.last && state.last.home ? state.last.ctx.exitID : state.selected;
			autopilotRoute.push([from, id], "Destination " + name(id) + " (jump from " + name(from) + ")");
		}

		function copy(text, what) {
			const done = function() { notify(jp.escape(what) + " copied", "green", 2500); };
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).then(done, function() { notify("Could not copy to the clipboard", "red", 4000); });
			} else {
				const $t = $("<textarea class='jp-clip'></textarea>").val(text).appendTo("body");
				$t[0].select();
				try { document.execCommand("copy"); done(); } catch (e) { notify("Could not copy to the clipboard", "red", 4000); }
				$t.remove();
			}
		}

		// ---- Settings ----

		/** Fill the ship select once ships.json is there; show an error (and retry on the next open) if it fails */
		function fillShips() {
			const $err = $("#jumpPlanner-section .jp-settings-error");
			loadShips().done(function(list) {
				const $ship = $("#jumpPlanner-ship");
				if (!$ship.find("option:not([disabled])").length) {
					$ship.html(jp.shipOptionsHtml(list));
					fillForm(current());
				}
				$err.addClass("hidden").text("");
			}).fail(function() {
				$err.removeClass("hidden").text("Could not load the ship list; it is tried again when Settings opens.");
			});
		}

		function fillForm(s) {
			const $s = $("#jumpPlanner-section");
			$s.find("input[name='jumpPlanner-enabled'][value='" + (s.enabled ? "1" : "0") + "']").prop("checked", true);
			$("#jumpPlanner-ship").val(s.ship);
			if (!$("#jumpPlanner-ship").val()) { $("#jumpPlanner-ship").val(jp.DEFAULTS.ship); }
			$s.find("input[name='jumpPlanner-jdc'][value='" + s.jdc + "']").prop("checked", true);
			$("#jumpPlanner-lowsec").prop("checked", s.lowsec);
			$("#jumpPlanner-nullsec").prop("checked", s.nullsec);
			$("#jumpPlanner-exits").val(s.exits);
			$("#jumpPlanner-jammed").val(s.jammed);
			$s.find("input[name='jumpPlanner-dock'][value='" + s.dock + "']").prop("checked", true);
			$s.find("input[name='jumpPlanner-click'][value='" + (s.clickOpen ? "1" : "0") + "']").prop("checked", true);
			$("#jumpPlanner-radius").val(s.mapRadius);
			$("#jumpPlanner-showOut").prop("checked", s.showOut);
			$("#jumpPlanner-showHs").prop("checked", s.showHs);
			$s.find("input[name='jumpPlanner-hubs'][value='" + (s.hubs ? "1" : "0") + "']").prop("checked", true);
			$s.find("input[name='jumpPlanner-search'][value='" + (s.search ? "1" : "0") + "']").prop("checked", true);
			$("#jumpPlanner-enabled-general").prop("checked", s.enabled);
			updateCap(s.cap);
			$("#jumpPlanner-radius-label").text(s.mapRadius + " LY");
		}

		/** The cap slider goes from 1 LY to the ship's range at the chosen JDC; at the top it means "no cap" */
		function updateCap(cap) {
			const max = jp.range({ ship: $("#jumpPlanner-ship").val(), jdc: Number($("input[name='jumpPlanner-jdc']:checked").val()), cap: null }, presets || []).max || 10;
			const $cap = $("#jumpPlanner-cap");
			const value = cap === undefined ? Number($cap.val()) : (cap === null ? max : cap);
			$cap.attr("max", max).val(Math.min(max, value));
			const v = Number($cap.val());
			$("#jumpPlanner-cap-label").text(jumpRange.formatLy(v >= max - 0.025 ? max : Math.round(v * 20) / 20));
		}

		function readForm() {
			const max = Number($("#jumpPlanner-cap").attr("max"));
			const cap = Number($("#jumpPlanner-cap").val());
			const before = current();
			return {
				enabled: $("input[name='jumpPlanner-enabled']:checked").val() !== "0",
				// Without the ship list (not loaded) the ship and cap rows can't have changed: keep them
				ship: presets ? ($("#jumpPlanner-ship").val() || jp.DEFAULTS.ship) : before.ship,
				jdc: Number($("input[name='jumpPlanner-jdc']:checked").val()),
				cap: !presets ? before.cap : cap >= max - 0.025 ? null : Math.round(cap * 20) / 20,
				lowsec: $("#jumpPlanner-lowsec").prop("checked"),
				nullsec: $("#jumpPlanner-nullsec").prop("checked"),
				exits: $("#jumpPlanner-exits").val(),
				jammed: $("#jumpPlanner-jammed").val(),
				dock: $("input[name='jumpPlanner-dock']:checked").val() || "right",
				clickOpen: $("input[name='jumpPlanner-click']:checked").val() !== "0",
				mapRadius: Number($("#jumpPlanner-radius").val()),
				showOut: $("#jumpPlanner-showOut").prop("checked"),
				showHs: $("#jumpPlanner-showHs").prop("checked"),
				hubs: $("input[name='jumpPlanner-hubs']:checked").val() !== "0",
				search: $("input[name='jumpPlanner-search']:checked").val() !== "0"
			};
		}

		function setupSettings() {
			// Its own Settings section after Routes & Navigation, built right away (so the feature can always be turned
			// off); the ship list fills in from ships.json when Settings opens. Every open re-reads the stored values.
			forkSettings.section("jumpPlanner", "Jump Planner", { after: "routes", id: "jumpPlanner-section", tableClass: "jp-options" });
			forkSettings.register({
				section: "jumpPlanner", id: "jumpPlanner", type: "custom", rows: jp.settingsHtml(presets),
				keywords: "jump drive capital cyno",
				load: function() { fillForm(current()); fillShips(); },
				save: function() { store(readForm()); state.counts = {}; },
				// Settings > Reset: back to defaults (a missing key means defaults)
				reset: function(o) {
					delete o.jumpRange;
					resetPending = true;
					state.start = null;		// Get home's start goes with options.jumpRange.origin
				}
			});
			// Settings > Routes & Navigation: the same on/off as the section's first row (one key), kept in sync both
			// ways; the section's row is what Save reads
			forkSettings.register({
				section: "routes", order: 60, id: "jumpPlanner-enabled-general", type: "custom", rows: jp.generalRowHtml(),
				keywords: "jump planner capital",
				load: function() { $("#jumpPlanner-enabled-general").prop("checked", current().enabled); }
			});
			$(document).on("change", "#jumpPlanner-enabled-general", function() {
				$("#jumpPlanner-section input[name='jumpPlanner-enabled'][value='" + ($(this).prop("checked") ? "1" : "0") + "']").prop("checked", true);
			});
			$(document).on("change", "input[name='jumpPlanner-enabled']", function() {
				$("#jumpPlanner-enabled-general").prop("checked", $("input[name='jumpPlanner-enabled']:checked").val() !== "0");
			});
			$(document).on("change", "#jumpPlanner-ship, input[name='jumpPlanner-jdc']", function() { updateCap(); });
			$(document).on("input change", "#jumpPlanner-cap", function() { updateCap(); });
			$(document).on("input change", "#jumpPlanner-radius", function() { $("#jumpPlanner-radius-label").text($(this).val() + " LY"); });
			// Save and Reset both end in options.apply() (which redraws the chain): show/hide the panel to match
			if (typeof options.apply === "function" && !options.apply.jumpPlannerWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					if (resetPending) { this.grid = jp.withoutGridEntry(this.grid, jp.WIDGET_ID); }
					try { state.counts = {}; sync(); } catch (err) { console.error("Jump planner: apply failed", err); }
					return result;
				};
				options.apply.jumpPlannerWrapped = true;
			}
		}

		installHook();

		$(function() {
			installHook();
			hookPreserveMass();	// preserve-mass.js loads after this file: wrap it once everything is there
			setupSettings();
			sync();
			const $doc = $(document);
			const sel = "#" + jp.WIDGET_ID;
			// The ring icon: open the planner on that exit (and don't let the click reach the node)
			$doc.on("click", "#chainMap .jp-ring", function(e) {
				e.preventDefault();
				e.stopPropagation();
				open($(this).attr("data-jp-exit"), true);
			});
			$doc.on("mousedown", "#chainMap .jp-ring", function(e) { e.stopPropagation(); });
			// Clicking an exit's name (which also views it, upstream) opens the planner on it when that is switched on
			$doc.on("click", "#chainMap .nodeSystem a", function() {
				const s = current();
				if (!s.enabled || !s.clickOpen) { return; }
				const id = parseInt($(this).closest("[data-nodeid]").attr("data-nodeid"), 10);
				if (state.exits.indexOf(id) >= 0) { open(id, true); }	// like the ring: From exit, so the click shows something
			});
			$doc.on("click", sel + " .jp-close", function(e) { e.preventDefault(); close(); });
			$doc.on("click", sel + " .jp-settings", function(e) { e.preventDefault(); openSettings(); });
			$doc.on("click", sel + " .jp-tab", function() { state.selected = parseInt($(this).attr("data-jp-tab"), 10); state.pinnedID = null; state.hoverID = null; state.search.scroll = true; render(); });
			$doc.on("change", sel + " .jp-ship", function() { store({ ship: $(this).val() }, true); state.counts = {}; state.search.scroll = true; render(); });
			$doc.on("click", sel + " .jp-jdc button", function() { store({ jdc: Number($(this).attr("data-jdc")) }, true); state.counts = {}; state.search.scroll = true; render(); });
			$doc.on("click", sel + " .jp-list th[data-jp-sort]", function() {
				const key = $(this).attr("data-jp-sort");
				state.sort = state.sort.key === key ? { key: key, dir: -state.sort.dir } : { key: key, dir: 1 };
				state.search.scroll = true;
				render();
			});
			// System search: suggestions while typing; arrows move, Enter picks, Escape closes the list, then clears
			$doc.on("input", sel + " .jp-search-input", function() { searchInput($(this).val()); });
			$doc.on("focus", sel + " .jp-search-input", function() {
				if (state.search.refocusing) { return; }	// render() moving it: not a new search
				const text = $(this).val();
				if ($.trim(text) && !(state.search.id && text === name(state.search.id))) { searchInput(text); }
			});
			$doc.on("blur", sel + " .jp-search-input", function() {
				// Not when render() only moved it (it is focused again by then)
				setTimeout(function() { if (!searchRow().find(".jp-search-input").is(":focus")) { closeMenu(); } }, 150);
			});
			$doc.on("keydown", sel + " .jp-search-input", function(e) {
				const s = state.search;
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault();
					if (!s.matches.length) { searchInput($(this).val()); return; }
					s.active = (s.active + (e.key === "ArrowDown" ? 1 : -1) + s.matches.length) % s.matches.length;
					drawMenu();
				} else if (e.key === "Enter") {
					e.preventDefault();
					const list = s.matches.length ? s.matches : jp.searchSystems($(this).val(), systems(), 1);
					pick(list[Math.max(0, s.active)] || list[0]);
				} else if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					if (s.matches.length) { closeMenu(); } else { clearSearch(); }
				}
			});
			// mousedown, not click: it comes before the input's blur closes the list
			$doc.on("mousedown", sel + " .jp-search-menu li[data-jp-find]", function(e) { e.preventDefault(); pick(parseInt($(this).attr("data-jp-find"), 10)); });
			$doc.on("mouseenter", sel + " .jp-pt, " + sel + " .jp-list tr[data-jp-id]", function() { hover(parseInt($(this).attr("data-jp-id"), 10)); });
			$doc.on("mouseleave", sel + " .jp-pt, " + sel + " .jp-list tr[data-jp-id]", function() { hover(null); });
			$doc.on("mouseenter", sel + " .jp-tip", function() { clearTimeout(state.hideTip); });
			$doc.on("mouseleave", sel + " .jp-tip", hideTipSoon);
			$doc.on("click", sel + " .jp-pt, " + sel + " .jp-list tr[data-jp-id]", function(e) {
				if ($(e.target).closest("a").length) { return; }
				const id = parseInt($(this).attr("data-jp-id"), 10);
				state.pinnedID = state.pinnedID === id ? null : id;
				refreshMap();
				if (state.pinnedID) { showTip(id); } else { hideTipSoon(); }
			});
			$doc.on("click", sel + " .jp-map svg", function(e) {
				if ($(e.target).closest(".jp-pt").length || !state.pinnedID) { return; }
				state.pinnedID = null;
				refreshMap();
				$widget().find(".jp-tip").addClass("hidden");
			});
			// Get home: mode switch, start picker, quick picks, Dest (the first cyno: midpoint or exit)
			$doc.on("click", sel + " .jp-mode button", function() {
				const mode = $(this).attr("data-jp-mode");
				if (mode === current().mode) { return; }
				store({ mode: mode }, true);
				state.pinnedID = null;
				state.hoverID = null;
				state.homeKey = "";
				render();
			});
			$doc.on("click", sel + " .jp-quick", function() { pickStart(parseInt($(this).attr("data-jp-start"), 10)); });
			$doc.on("input", sel + " .jp-from-input", function() { fromInput($(this).val()); });
			$doc.on("focus", sel + " .jp-from-input", function() {
				if (state.from.refocusing) { return; }
				$(this).select();
			});
			$doc.on("blur", sel + " .jp-from-input", function() {
				setTimeout(function() {
					const $input = fromRow().find(".jp-from-input");
					if ($input.is(":focus")) { return; }
					closeFromMenu();
					if (!$.trim($input.val())) { $input.val(state.start ? name(state.start) : ""); }	// left empty: show the start again
				}, 150);
			});
			$doc.on("keydown", sel + " .jp-from-input", function(e) {
				const f = state.from;
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault();
					if (!f.matches.length) { fromInput($(this).val()); return; }
					f.active = (f.active + (e.key === "ArrowDown" ? 1 : -1) + f.matches.length) % f.matches.length;
					fromRow().find(".jp-from-menu").html(jp.searchMenuHtml(f.matches, f.active, systems(), regions()));
				} else if (e.key === "Enter") {
					e.preventDefault();
					const list = f.matches.length ? f.matches : jp.searchSystems($(this).val(), systems(), 1);
					pickStart(list[Math.max(0, f.active)] || list[0]);
				} else if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					closeFromMenu();
					$(this).val(state.start ? name(state.start) : "").blur();
				}
			});
			$doc.on("mousedown", sel + " .jp-from-menu li[data-jp-find]", function(e) { e.preventDefault(); pickStart(parseInt($(this).attr("data-jp-find"), 10)); });
			$doc.on("click", sel + " .jp-home-dest", function(e) { e.preventDefault(); setDestination(parseInt($(this).attr("data-jp-cyno"), 10)); });
			$doc.on("click", sel + " .jp-dest", function(e) { e.preventDefault(); setDestination(parseInt($(this).closest("tr").attr("data-jp-id"), 10)); });
			$doc.on("click", sel + " .jp-tip-dest", function(e) { e.preventDefault(); setDestination(parseInt($(this).closest(".jp-tip").attr("data-jp-id"), 10)); });
			$doc.on("click", sel + " .jp-tip-copy", function(e) { e.preventDefault(); const id = parseInt($(this).closest(".jp-tip").attr("data-jp-id"), 10); copy(name(id), name(id)); });
			$doc.on("click", sel + " .jp-tip-jamtoggle", function(e) { e.preventDefault(); toggleJammed(parseInt($(this).closest(".jp-tip").attr("data-jp-id"), 10)); });
			$doc.on("click", sel + " .jp-copy-list", function(e) {
				e.preventDefault();
				const l = state.last;
				if (!l) { return; }
				const s = current();
				if (l.home) { copy(jp.homeCopyText(l.home, name(l.ctx.exitID), name, s.jdc), "The routes"); return; }
				copy(jp.copyText(jp.sortRows(l.model.rows, state.sort.key, state.sort.dir), name(l.ctx.exitID), l.model.preset ? l.model.preset.label : "", s.jdc, l.model.range), "The list");
			});
			document.addEventListener("visibilitychange", function() { if (!document.hidden && $widget().length) { loadJammed(); } });
			// The chain was drawn before this ready handler on some loads: draw it again with the icons
			if (isOn()) { setTimeout(redrawChain, 0); }
		});

		jp.open = open;
		jp.state = state;
	})();
}
