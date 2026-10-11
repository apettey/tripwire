const routeHoleFilters = {
	// Route filters on hole state (fork-owned): the routes that go through the chain's wormholes (Favourites panel,
	// Destinations, Fight here) avoid holes that are EOL, at critical mass, too small for the ship chosen in
	// Settings > Routes & Navigation > Routes through, or flagged by another feature. Never a dead end: with no route
	// that avoids them, the best route anyway is used and its offending hops are marked (and a one-line note says so).
	// One-way (remembered per browser session): EOL and critical holes are allowed, still marked.
	// Settings are saved per user in options.routeHoleFilters = {eol, crit, small, <own flag keys>, flagged}; a missing
	// key means on. Keep `const routeHoleFilters` on the first line: the test helper strips it to define a global.
	//
	// Other features add their own hole flag with routeHoleFilters.registerFlag(key, label, isFlagged, opts):
	//   key        short unique id ("preserve", "rolling")
	//   label      what the tooltip says about a hop, e.g. "preserve mass hole" (plain text)
	//   isFlagged  function(hole) -> truthy when the hole carries the flag. `hole` is {wormholeID, lineIndex, eol, crit,
	//              size, mods}; wormholeID is the Tripwire wormhole id (look your flag up with it)
	//   opts       {own: true} gives the flag its own "Avoid ..." row in Settings (settings key = `key`) and counts it
	//              under `short` (default: label); without own the flag follows the "flagged by other features" row
	// Registering the same key again replaces it. preserve mass registers itself from this file; rolling too once
	// holeRolling exists (see the bottom of the file).
	SIZE_ORDER: ["S", "M", "L", "VL", "XL"],	// same classes as sizeTags.classes / theraRoute.SIZE_ORDER
	DEFAULTS: { eol: true, crit: true, small: true, preserve: true, flagged: true },
	SHIP_DEFAULT: "S",
	WARN_CLASS: "route-hole-warn",	// modifier on chain lines whose hole a route had to use anyway

	flagList: [],	// [{key, label, short, isFlagged, own}] in registration order

	registerFlag: function(key, label, isFlagged, opts) {
		if (!key || typeof isFlagged !== "function") { throw new Error("routeHoleFilters.registerFlag: key and isFlagged(hole) are required"); }
		const flag = { key: String(key), label: String(label || key), short: String((opts && opts.short) || label || key), isFlagged: isFlagged, own: !!(opts && opts.own) };
		const at = routeHoleFilters.flagList.map(function(f) { return f.key; }).indexOf(flag.key);
		if (at >= 0) { routeHoleFilters.flagList[at] = flag; } else { routeHoleFilters.flagList.push(flag); }
		return flag;
	},

	clearFlags: function() { routeHoleFilters.flagList = []; },

	// ---- Settings (pure) ----

	/** Filters from user options, defaults filled in (a missing key = on). `shipSize` comes from the Thera route's
	setting (options.theraRoute.shipSize), "S" when unset. Never mutates opts. */
	settings: function(opts) {
		const raw = opts && opts.routeHoleFilters && typeof opts.routeHoleFilters === "object" ? opts.routeHoleFilters : {};
		const ship = opts && opts.theraRoute && opts.theraRoute.shipSize;
		const out = { shipSize: routeHoleFilters.SIZE_ORDER.indexOf(ship) >= 0 ? ship : routeHoleFilters.SHIP_DEFAULT };
		Object.keys(routeHoleFilters.DEFAULTS).concat(routeHoleFilters.flagList.filter(function(f) { return f.own; }).map(function(f) { return f.key; }))
			.forEach(function(k) { out[k] = raw[k] !== false; });
		return out;
	},

	/** Whether any filter is on (all off = routes as before) */
	anyOn: function(settings) {
		if (!settings) { return false; }
		return Object.keys(settings).some(function(k) { return k !== "shipSize" && settings[k]; });
	},

	// ---- Judging a hole (pure) ----

	/** Hole size classes in order: -1 for unknown */
	sizeRank: function(size) { return routeHoleFilters.SIZE_ORDER.indexOf(size); },

	/** Whether the hole is too small for the ship (unknown hole sizes pass: a guess is not a reason to avoid it) */
	tooSmall: function(hole, shipSize) {
		const ship = routeHoleFilters.sizeRank(shipSize), size = routeHoleFilters.sizeRank(hole && hole.size);
		return ship > 0 && size >= 0 && size < ship;
	},

	/** What is wrong with a hole, for these settings: [{key, label, short, noun}] (empty when nothing).
	@param hole {wormholeID, lineIndex, eol, crit, size, ...} or null/undefined (nothing known: fine)
	@param settings routeHoleFilters.settings() output; a filter that is off doesn't report */
	reasons: function(hole, settings) {
		const out = [];
		if (!hole || !settings) { return out; }
		if (settings.eol && hole.eol) { out.push({ key: "eol", label: "EOL hole", short: "EOL", noun: "EOL hole" }); }
		if (settings.crit && hole.crit) { out.push({ key: "crit", label: "critical mass hole", short: "crit", noun: "critical hole" }); }
		if (settings.small && routeHoleFilters.tooSmall(hole, settings.shipSize)) {
			out.push({ key: "small", label: "too small for your ship (" + hole.size + " hole, ship " + settings.shipSize + ")", short: "too-small holes", noun: "too-small hole" });
		}
		routeHoleFilters.flagList.forEach(function(f) {
			if (!(f.own ? settings[f.key] : settings.flagged)) { return; }
			let flagged = false;
			try { flagged = !!f.isFlagged(hole); } catch (e) { flagged = false; }
			if (flagged) { out.push({ key: f.key, label: f.label, short: f.short, noun: f.label }); }
		});
		return out;
	},

	// ---- Route search (pure) ----

	/** Default search: shortest path by connections, as rally.routeTo (connection ids = 4th element) */
	baseRoute: function(connections, start, target) {
		return typeof rally !== "undefined" ? rally.routeTo(connections, start, target) : null;
	},

	/** A route through chain connections that avoids the filtered holes, or else the best one anyway.
	@param connections [a, b, modifiers, lineIndex] (rally.systemConnections)
	@param start, target system ids (as rally.routeTo)
	@param ctx {holeOf(connection) -> hole info | null, settings, oneWay, routeFn (optional, default rally.routeTo)}
	@return null when no route exists at all, else {path: [lineIndex], marks: {lineIndex: [reason]}, bad: number of hops
		that break an active filter, fallback: bad > 0, note: "" | "No route avoiding EOL/crit — this one uses 1 EOL hole"}.
		marks holds every hop with a reason, also the EOL/crit ones that one-way allows. */
	route: function(connections, start, target, ctx) {
		const hf = routeHoleFilters;
		const routeFn = (ctx && ctx.routeFn) || hf.baseRoute;
		const cfg = ctx && ctx.settings;
		if (!ctx || !cfg || !hf.anyOn(cfg) || typeof ctx.holeOf !== "function") {
			const plain = routeFn(connections, start, target);
			return plain ? { path: plain, marks: {}, bad: 0, fallback: false, note: "" } : null;
		}
		const avoid = ctx.oneWay ? Object.assign({}, cfg, { eol: false, crit: false }) : cfg;
		const byLine = {};
		(connections || []).forEach(function(c) {
			if (!c) { return; }
			const hole = ctx.holeOf(c);
			byLine[c[3]] = { all: hf.reasons(hole, cfg), avoid: hf.reasons(hole, avoid) };
		});
		const clean = (connections || []).filter(function(c) { return c && !byLine[c[3]].avoid.length; });
		let path = routeFn(clean, start, target);
		if (!path) { path = routeFn(connections, start, target); }
		if (!path) { return null; }
		return hf.describe(path, byLine);
	},

	/** Marks, bad count and note for a path, given {lineIndex: {all, avoid}} reasons */
	describe: function(path, byLine) {
		const marks = {}, used = [];
		let bad = 0;
		(path || []).forEach(function(index) {
			const r = byLine[index];
			if (!r) { return; }
			if (r.all.length) { marks[index] = r.all; }
			if (r.avoid.length) { bad++; used.push.apply(used, r.avoid); }
		});
		return { path: path, marks: marks, bad: bad, fallback: bad > 0, note: bad > 0 ? routeHoleFilters.noteText(used) : "" };
	},

	/** "No route avoiding EOL/crit — this one uses 1 EOL hole" for the reasons of the hops a route had to use */
	noteText: function(reasons) {
		const kinds = [], counts = {}, nouns = {}, shorts = {};
		(reasons || []).forEach(function(r) {
			if (!(r.key in counts)) { kinds.push(r.key); counts[r.key] = 0; nouns[r.key] = r.noun; shorts[r.key] = r.short; }
			counts[r.key]++;
		});
		if (!kinds.length) { return ""; }
		const uses = kinds.map(function(k) { return counts[k] + " " + nouns[k] + (counts[k] === 1 ? "" : "s"); });
		return "No route avoiding " + kinds.map(function(k) { return shorts[k]; }).join("/") + " — this one uses " +
			(uses.length > 1 ? uses.slice(0, -1).join(", ") + " and " + uses[uses.length - 1] : uses[0]);
	},

	/** Add the warning class to the lines of marked hops (a hole a route had to use anyway) */
	markLines: function(lines, marks) {
		Object.keys(marks || {}).forEach(function(index) {
			const line = (lines || [])[index];
			if (line && Array.isArray(line[2]) && line[2].indexOf(routeHoleFilters.WARN_CLASS) < 0) { line[2].push(routeHoleFilters.WARN_CLASS); }
		});
	},

	/** Tooltip text for one marked hop: "EOL hole, preserve mass hole" */
	marksText: function(reasons) {
		return (reasons || []).map(function(r) { return r.label; }).join(", ");
	},

	/** Destinations: pick the exits to use. Each route is {exit: {holes: [lineIndex] (the exit's way home through the
	chain)}, jumps, index}; routes whose way avoids the filtered holes come first (all that remain when any exists),
	else the others, nearest first. Each route gets marks / bad / fallback / note.
	@param holesByLine {lineIndex: {all, avoid}} from routeHoleFilters.reasonTable */
	pickRoutes: function(routes, byLine) {
		const hf = routeHoleFilters;
		const rated = (routes || []).map(function(r) {
			const d = hf.describe((r.exit && r.exit.holes) || [], byLine || {});
			return Object.assign({}, r, { marks: d.marks, bad: d.bad, fallback: d.fallback, note: d.note });
		});
		const clean = rated.filter(function(r) { return !r.bad; });
		return (clean.length ? clean : rated).sort(function(a, b) { return a.jumps - b.jumps || a.index - b.index; });
	},

	/** Reasons for every connection: {lineIndex: {all, avoid}} (see route) */
	reasonTable: function(connections, ctx) {
		const hf = routeHoleFilters, cfg = ctx && ctx.settings, table = {};
		if (!ctx || !cfg || !hf.anyOn(cfg) || typeof ctx.holeOf !== "function") { return table; }
		const avoid = ctx.oneWay ? Object.assign({}, cfg, { eol: false, crit: false }) : cfg;
		(connections || []).forEach(function(c) {
			if (!c) { return; }
			const hole = ctx.holeOf(c);
			table[c[3]] = { all: hf.reasons(hole, cfg), avoid: hf.reasons(hole, avoid) };
		});
		return table;
	},

	/** The holes from a chain node back to the chain's root: [lineIndex] (each line is [child, parent, ...])
	@param lines chain lines; nodeID the node (row.c[0].v) */
	holesHome: function(lines, nodeID) {
		const byChild = {};
		(lines || []).forEach(function(line, index) { if (line && line[0] !== undefined && line[3] !== null && line[3] !== undefined) { byChild[line[0]] = index; } });
		const out = [];
		let cur = nodeID;
		for (let i = 0; i < 200 && byChild[cur] !== undefined; i++) {
			out.push(byChild[cur]);
			cur = lines[byChild[cur]][1];
		}
		return out;
	},

	// ---- One-way (session) ----

	ONE_WAY_KEY: "routeHoleFilters.oneWay",
	oneWayCache: false,

	/** The one-way switch: remembered per browser session (sessionStorage), memory only when that isn't available */
	oneWay: function() {
		try { if (typeof sessionStorage !== "undefined") { return sessionStorage.getItem(routeHoleFilters.ONE_WAY_KEY) === "1"; } } catch (e) { /* private mode */ }
		return routeHoleFilters.oneWayCache;
	},

	setOneWay: function(on) {
		routeHoleFilters.oneWayCache = !!on;
		try { if (typeof sessionStorage !== "undefined") { sessionStorage.setItem(routeHoleFilters.ONE_WAY_KEY, on ? "1" : "0"); } } catch (e) { /* memory only */ }
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** The "One-way" checkbox (same markup in the Favourites panel and in Destinations) */
	toggleHtml: function(on) {
		return "<label class='rhf-oneway' title='One-way: you are not coming back, so routes may use EOL and critical mass holes (still marked)'>"
			+ "<input type='checkbox' class='rhf-oneway-input'" + (on ? " checked" : "") + " /> One-way</label>";
	}
};

// Preserve mass (preserve-mass.js) has its own "Avoid ..." row in Settings
routeHoleFilters.registerFlag("preserve", "preserve mass hole", function(hole) {
	return typeof preserveMass !== "undefined" && !!preserveMass.flags && !!preserveMass.flags[String(hole.wormholeID)];
}, { own: true, short: "preserve mass" });

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined") {
	(function() {
		const rhf = routeHoleFilters;

		// Rolling (rolling.js) follows "flagged by other features"; registered here while it is not registering itself
		if (typeof holeRolling !== "undefined") {
			rhf.registerFlag("rolling", "hole being rolled", function(hole) {
				return !!holeRolling.flags && !!holeRolling.flags[String(hole.wormholeID)];
			});
		}

		function redrawChain() { if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); } }

		/** Size class of a chain connection [a, b, mods, lineIndex]: sizeTags' own lookup, null when unknown */
		function sizeOf(connection, wormholeID) {
			if (typeof sizeTags === "undefined") { return null; }
			const type = sizeTags.wormholeTypeFor(wormholeID);
			const tag = sizeTags.tagFor(type || "K162", "K162", connection[0], connection[1]);
			return tag && tag.size ? tag.size : null;
		}

		/** Routing context for these chain lines: {holeOf, settings, oneWay}, or null when the filters are all off */
		rhf.contextFor = function(lines) {
			const settings = rhf.settings(options);
			if (!rhf.anyOn(settings)) { return null; }
			const cache = {};
			return {
				settings: settings,
				oneWay: rhf.oneWay(),
				holeOf: function(c) {
					const index = c[3];
					if (index in cache) { return cache[index]; }
					const line = (lines || [])[index];
					const mods = line && Array.isArray(line[2]) ? line[2] : [];
					const id = line ? line[3] : null;
					const wh = tripwire.client && tripwire.client.wormholes ? tripwire.client.wormholes[id] : null;
					let size = null;
					try { size = sizeOf(c, id); } catch (e) { size = null; }
					return (cache[index] = {
						wormholeID: id, lineIndex: index, mods: mods, size: size,
						eol: mods.indexOf("eol") >= 0 || !!(wh && wh.life === "critical"),
						crit: mods.indexOf("critical") >= 0 || !!(wh && wh.mass === "critical")
					});
				}
			};
		};

		// ---- One-way checkbox: Favourites panel (placed by favourites-panel.js) and Destinations ----
		function syncToggles() { $(".rhf-oneway-input").prop("checked", rhf.oneWay()); }
		$(document).on("change", ".rhf-oneway-input", function() {
			rhf.setOneWay($(this).prop("checked"));
			syncToggles();
			redrawChain();
			if (typeof routeDestinations !== "undefined" && typeof routeDestinations.onDecorate === "function") { routeDestinations.onDecorate(); }
		});
		$(function() {
			const $form = $("#dialog-routeDestinations .route-dest-add");
			if ($form.length && !$form.find(".rhf-oneway").length) { $form.append(" " + rhf.toggleHtml(rhf.oneWay())); }
		});

		// ---- Settings > Routes & Navigation ----
		function rowsHtml() {
			const own = rhf.flagList.filter(function(f) { return f.own; });
			const box = function(id, text, title) {
				return "<div><label title='" + rhf.escape(title) + "'><input type='checkbox' id='rhf-" + id + "' /> " + rhf.escape(text) + "</label></div>";
			};
			return "<tr id='routeHoleFilters-row'><th>Routes avoid:</th><td>"
				+ box("eol", "EOL holes", "Skip holes that are about to close, unless nothing else gets you there")
				+ box("crit", "Critical mass holes", "Skip holes at critical mass, unless nothing else gets you there")
				+ box("small", "Holes too small for my ship", "Uses the ship chosen under Routes through; unknown hole sizes are allowed")
				+ own.map(function(f) { return box(f.key, f.label.charAt(0).toUpperCase() + f.label.slice(1) + "s", "Skip holes with this flag, unless nothing else gets you there"); }).join("")
				+ box("flagged", "Holes flagged by other features", "For example holes being rolled")
				+ "<div class='theraRoute-hint'>Favourites, Destinations and Fight here. With no way around, the best route is used and the holes are marked. The One-way switch (Favourites, Destinations) allows EOL and critical holes.</div>"
				+ "</td></tr>";
		}
		function keys() { return Object.keys(rhf.settings(options)).filter(function(k) { return k !== "shipSize"; }); }

		$(function() { forkSettings.register({
			section: "routes", order: 35, id: "routeHoleFilters", type: "custom", rows: rowsHtml(), key: "routeHoleFilters",
			keywords: "avoid eol critical mass too small preserve rolling one-way bubble route holes",
			load: function() {
				const s = rhf.settings(options);
				keys().forEach(function(k) { $("#rhf-" + k).prop("checked", !!s[k]); });
			},
			save: function(o) {
				const before = JSON.stringify(rhf.settings(options));
				const next = {};
				keys().forEach(function(k) { next[k] = $("#rhf-" + k).prop("checked"); });
				o.routeHoleFilters = next;
				if (JSON.stringify(rhf.settings(o)) !== before) { setTimeout(redrawChain, 0); }
			}
		}); });
	})();
}
