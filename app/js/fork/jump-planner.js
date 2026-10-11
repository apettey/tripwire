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
		dock: "right", clickOpen: true, mapRadius: 10, showOut: true, showHs: false, hubs: true
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
			open: raw.open === true
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
		// The whole range must fit (it can be larger than the "Mini-map shows" radius), with a little margin
		const scale = (H / 2 - 6) / (Math.max(s.mapRadius, model.range) * 1.04);
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
		jumpRange.within(ctx.index, origin, Math.max(s.mapRadius, model.range)).forEach(function(hit) {
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
		return { scale: scale, cx: cx, cy: cy, rings: rings, points: points, lines: lines, outShown: out };
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

	/** SVG markup of the mini-map */
	mapSvg: function(mapModel, labels, focusIDs) {
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
		svg += "</g><g class='jp-labels'>" + (labels || []).map(function(l) {
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
		if (note) { lines.push("<div class='jp-tip-note'>" + esc(note) + "</div>"); }
		if (info.jam) {
			lines.push("<div class='jp-tip-jam'>Marked jammed" + (info.jam.setBy ? " by " + esc(info.jam.setBy) : "") + ", " + esc(jumpPlanner.ageText(info.jam.age)) + (info.jam.age >= 60 ? " ago" : "") + "</div>");
		}
		const links = [];
		if (info.kind === "in") { links.push("<a href='#' class='jp-tip-dest'>Set destination</a>"); }
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

	/** Settings section rows (HTML) */
	settingsHtml: function(presets) {
		const esc = jumpPlanner.escape;
		const radios = function(name, list) {
			return list.map(function(o) { return "<label><input type='radio' name='" + name + "' value='" + esc(o[0]) + "' /> " + esc(o[1]) + "</label>"; }).join(" ");
		};
		const swatch = function(i, text) { return "<span class='jp-swatch' style='background: " + jumpPlanner.BAND_COLORS[i] + "'></span>" + esc(text); };
		return "<h3 id='jumpPlanner-header'><a href='#'>Jump Planner</a></h3>"
			+ "<div id='jumpPlanner-section'><table class='optionsTable jp-options' width='100%' cellpadding='1' cellspacing='0'>"
			+ "<tr><th>Enable jump planner:</th><td>" + radios("jumpPlanner-enabled", [["1", "Yes"], ["0", "No"]]) + "</td></tr>"
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
			+ "</table></div>";
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
			last: null			// {ctx, model, mapModel} of the last render
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
					if (exits.join(",") !== state.exits.join(",")) {
						state.exits = exits;
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
				+ "<i class='jp-close' data-icon='times' title='Close the Jump planner'></i></div>"
				+ "<div class='content'><div class='jp-head'></div><div class='jp-tabs'></div><div class='jp-body'></div></div>"
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
			if (!api || !$w.length) { return; }
			// Remember where it was, so opening it again puts it back there (not when Settings > Reset removes it)
			const entry = jp.gridEntry(api.serialize($w), jp.WIDGET_ID);
			if (entry && !resetPending) { store({ position: { col: entry.col, row: entry.row, size_x: entry.size_x, size_y: entry.size_y } }); }
			$w.attr("id", jp.WIDGET_ID + "-removed");
			api.remove_widget($w, true);
			$w.stop(true, true);
		}

		/** Open the panel on an exit's tab */
		function open(systemID) {
			if (!isOn()) { return; }
			const id = parseInt(systemID, 10);
			if (id) { state.selected = id; }
			state.pinnedID = null;
			state.error = "";
			const wasOpen = !!$widget().length;
			const $w = addWidget();
			if (!current().open) { store({ open: true }, true); }
			if ($w && !wasOpen && $w[0].scrollIntoView) { setTimeout(function() { $w[0].scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 50); }
			render();
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
			$w.find(".jp-tabs").html(jp.tabsHtml(exits, state.selected, name, exits.reduce(function(acc, id) { acc[id] = countFor(id); return acc; }, {})));
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
			if (state.pinnedID) { showTip(state.pinnedID); }
		}

		function mapHtml() {
			const l = state.last;
			const focus = [state.hoverID, state.pinnedID];
			return jp.mapSvg(l.mapModel, jp.placeLabels(l.mapModel, focus), focus);
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
			const point = l.mapModel.points.filter(function(p) { return p.id === id; })[0];
			const row = l.model.rows.filter(function(r) { return r.id === id; })[0];
			const sys = l.ctx.systems[id] || {};
			const region = l.ctx.regions && l.ctx.regions[sys.regionID] ? l.ctx.regions[sys.regionID].name : "";
			const kind = point ? point.kind : row ? (row.blocked ? "jammed" : "in") : "out";
			return {
				id: id, name: sys.name || String(id), sec: sys.security, region: region,
				ly: jumpRange.distanceLy(l.ctx.index.pos[l.ctx.exitID], l.ctx.index.pos[id]),
				band: row ? row.band : null, gates: l.ctx.gates[id] === undefined ? null : l.ctx.gates[id], kind: kind,
				jam: l.ctx.jammed[id] || null, canMark: jp.isRangeExit(id, sys), point: point
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
			autopilotRoute.push([state.selected, id], "Destination " + name(id) + " (jump from " + name(state.selected) + ")");
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
				hubs: $("input[name='jumpPlanner-hubs']:checked").val() !== "0"
			};
		}

		function setupSettings() {
			const $accordion = $("#dialog-options #optionsAccordion");
			if (!$accordion.length || $("#jumpPlanner-section").length) { return; }
			// Built right away (so the feature can always be turned off); the ship list fills in from ships.json when
			// Settings opens. Before "Personal Statistics" (the last section): the indexes other code uses stay put.
			const $last = $accordion.children("h3").last();
			if ($last.length) { $last.before(jp.settingsHtml(presets)); } else { $accordion.append(jp.settingsHtml(presets)); }
			if ($accordion.hasClass("ui-accordion")) { $accordion.accordion("refresh"); }
			$(document).on("change", "#jumpPlanner-ship, input[name='jumpPlanner-jdc']", function() { updateCap(); });
			$(document).on("input change", "#jumpPlanner-cap", function() { updateCap(); });
			$(document).on("input change", "#jumpPlanner-radius", function() { $("#jumpPlanner-radius-label").text($(this).val() + " LY"); });
			$(document).on("dialogopen", "#dialog-options", function() {
				if (!$("#jumpPlanner-section").length) { return; }
				fillForm(current());
				fillShips();
			});
			// Capture phase so the values are in place before upstream's Save handler applies and saves options
			document.addEventListener("click", function(e) {
				const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
				if (!button || $.trim($(button).text()) !== "Save") { return; }
				if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#jumpPlanner-section").length) { return; }
				store(readForm());
				state.counts = {};
			}, true);
			// Settings > Reset: back to defaults (a missing key means defaults)
			if (typeof options.reset === "function" && !options.reset.jumpPlannerWrapped) {
				const reset = options.reset;
				const wrapped = function() {
					const result = reset.apply(this, arguments);
					delete this.jumpRange;
					resetPending = true;
					return result;
				};
				Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
				wrapped.jumpPlannerWrapped = true;
				options.reset = wrapped;
			}
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
			setupSettings();
			sync();
			const $doc = $(document);
			const sel = "#" + jp.WIDGET_ID;
			// The ring icon: open the planner on that exit (and don't let the click reach the node)
			$doc.on("click", "#chainMap .jp-ring", function(e) {
				e.preventDefault();
				e.stopPropagation();
				open($(this).attr("data-jp-exit"));
			});
			$doc.on("mousedown", "#chainMap .jp-ring", function(e) { e.stopPropagation(); });
			// Clicking an exit's name (which also views it, upstream) opens the planner on it when that is switched on
			$doc.on("click", "#chainMap .nodeSystem a", function() {
				const s = current();
				if (!s.enabled || !s.clickOpen) { return; }
				const id = parseInt($(this).closest("[data-nodeid]").attr("data-nodeid"), 10);
				if (state.exits.indexOf(id) >= 0) { open(id); }
			});
			$doc.on("click", sel + " .jp-close", function(e) { e.preventDefault(); close(); });
			$doc.on("click", sel + " .jp-tab", function() { state.selected = parseInt($(this).attr("data-jp-tab"), 10); state.pinnedID = null; state.hoverID = null; render(); });
			$doc.on("change", sel + " .jp-ship", function() { store({ ship: $(this).val() }, true); state.counts = {}; render(); });
			$doc.on("click", sel + " .jp-jdc button", function() { store({ jdc: Number($(this).attr("data-jdc")) }, true); state.counts = {}; render(); });
			$doc.on("click", sel + " .jp-list th[data-jp-sort]", function() {
				const key = $(this).attr("data-jp-sort");
				state.sort = state.sort.key === key ? { key: key, dir: -state.sort.dir } : { key: key, dir: 1 };
				render();
			});
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
			$doc.on("click", sel + " .jp-dest", function(e) { e.preventDefault(); setDestination(parseInt($(this).closest("tr").attr("data-jp-id"), 10)); });
			$doc.on("click", sel + " .jp-tip-dest", function(e) { e.preventDefault(); setDestination(parseInt($(this).closest(".jp-tip").attr("data-jp-id"), 10)); });
			$doc.on("click", sel + " .jp-tip-copy", function(e) { e.preventDefault(); const id = parseInt($(this).closest(".jp-tip").attr("data-jp-id"), 10); copy(name(id), name(id)); });
			$doc.on("click", sel + " .jp-tip-jamtoggle", function(e) { e.preventDefault(); toggleJammed(parseInt($(this).closest(".jp-tip").attr("data-jp-id"), 10)); });
			$doc.on("click", sel + " .jp-copy-list", function(e) {
				e.preventDefault();
				const l = state.last;
				if (!l) { return; }
				const s = current();
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
