const favouritesPanel = {
	// Favourites panel: a movable/resizable widget listing the user's favourite systems (options.favorites,
	// which stays the source of truth so upstream code keeps working), with per-system "Show on map" and
	// "Route" toggles (fork-owned file). Flags are saved per user in
	// options.favoritesPanel = {enabled, position, systems: {<systemID>: {map, route}}}; a missing key means
	// the default (panel on, map on, route off).
	// Keep `const favouritesPanel` on the first line: the test helper strips it to define a global.
	WIDGET_ID: "favouritesWidget",
	ROUTE_CLASS: "favourite-route",         // line modifier on the route's connections
	NODE_CLASS: "favourite-route-node",     // the favourite's node (or calculated route node) at the end of a route
	EXIT_CLASS: "favourite-route-exit",     // system a route enters / leaves the chain by over gates (no calculated node drawn)
	SAFE_ROUTE_CLASS: "favourite-safe-route",   // the same three for a safe (high-sec only) route
	SAFE_NODE_CLASS: "favourite-safe-node",
	SAFE_EXIT_CLASS: "favourite-safe-exit",
	DEFAULT_SIZE: { x: 5, y: 8 },
	MIN_SIZE: { x: 4, y: 3 },
	LOCATION_CHECK_MS: 2000,

	// Result of the last decorate() call: {<systemID>: route info}
	lastRoutes: {},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Real New Eden / J-space system ID as a number, or null (unknown "x|y" chain systems, generic types...) */
	toID: function(systemID) {
		if (systemID === null || systemID === undefined || systemID === "" || typeof systemID === "boolean") { return null; }
		if (typeof systemID === "string" && !/^\s*\d+\s*$/.test(systemID)) { return null; }
		const n = Number(systemID);
		return Number.isInteger(n) && n >= 30000000 && n < 32000000 ? n : null;
	},

	// ---- Settings (pure) ----

	/** Panel settings from user options, with defaults filled in. Never mutates opts. */
	settings: function(opts) {
		const raw = opts && opts.favoritesPanel && typeof opts.favoritesPanel === "object" ? opts.favoritesPanel : {};
		const systems = {};
		if (raw.systems && typeof raw.systems === "object") {
			Object.keys(raw.systems).forEach(function(key) {
				const id = favouritesPanel.toID(key);
				const f = raw.systems[key];
				if (!id || !f || typeof f !== "object") { return; }
				systems[id] = { map: f.map !== false, route: favouritesPanel.routeMode(f.route) };
			});
		}
		const result = { enabled: raw.enabled !== false, systems: systems };
		if (raw.position && typeof raw.position === "object") { result.position = raw.position; }
		return result;
	},

	/** Whether the panel is switched on (options.favoritesPanel.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.favoritesPanel && opts.favoritesPanel.enabled === false);
	},

	/** A route setting as false (off), "shortest" or "safe"; legacy true means "shortest" */
	routeMode: function(value) {
		if (value === "safe") { return "safe"; }
		return value === true || value === "shortest" ? "shortest" : false;
	},

	/** The next route setting when the route button is clicked: off -> shortest -> safe -> off */
	nextRouteMode: function(value) {
		const mode = favouritesPanel.routeMode(value);
		return mode === false ? "shortest" : mode === "shortest" ? "safe" : false;
	},

	/** Flags for one favourite: {map (default on), route (false, "shortest" or "safe"; default off)} */
	flags: function(settings, systemID) {
		const f = settings && settings.systems ? settings.systems[favouritesPanel.toID(systemID)] : null;
		return { map: !f || f.map !== false, route: f ? favouritesPanel.routeMode(f.route) : false };
	},

	/** New settings with one flag changed. Entries equal to the defaults are dropped to keep options small. */
	setFlag: function(settings, systemID, key, value) {
		const id = favouritesPanel.toID(systemID);
		const result = favouritesPanel.settings({ favoritesPanel: settings });
		if (!id || (key !== "map" && key !== "route")) { return result; }
		const f = favouritesPanel.flags(result, id);
		f[key] = key === "route" ? favouritesPanel.routeMode(value) : !!value;
		if (f.map && !f.route) { delete result.systems[id]; } else { result.systems[id] = f; }
		return result;
	},

	/** New settings without flags for systems that are no longer favourites */
	cleanFlags: function(settings, favorites) {
		const result = favouritesPanel.settings({ favoritesPanel: settings });
		const keep = {};
		favouritesPanel.sanitize(favorites).forEach(function(id) { keep[id] = true; });
		Object.keys(result.systems).forEach(function(id) { if (!keep[id]) { delete result.systems[id]; } });
		return result;
	},

	// ---- The favourites list (pure: these return new arrays, the caller saves) ----

	/** Favourites as unique numeric system IDs, order kept */
	sanitize: function(favorites) {
		const seen = {};
		return (Array.isArray(favorites) ? favorites : []).reduce(function(out, f) {
			const id = favouritesPanel.toID(f);
			if (id && !seen[id]) { seen[id] = true; out.push(id); }
			return out;
		}, []);
	},

	/** Add a system (ID or name, resolved by findByName). Returns {list, systemID} or {list, error} */
	add: function(favorites, system, systems, findByName) {
		const list = favouritesPanel.sanitize(favorites);
		const id = favouritesPanel.toID(system) || (findByName ? favouritesPanel.toID(findByName(system)) : null);
		if (!id || !systems || !systems[id]) {
			return { list: list, error: "Unknown system" + (system ? " \"" + system + "\"" : "") };
		}
		if (list.indexOf(id) >= 0) {
			return { list: list, error: systems[id].name + " is already a favourite" };
		}
		return { list: list.concat([id]), systemID: id };
	},

	remove: function(favorites, systemID) {
		const id = favouritesPanel.toID(systemID);
		return favouritesPanel.sanitize(favorites).filter(function(f) { return f !== id; });
	},

	/** Move the entry at index `from` to index `to` */
	move: function(favorites, from, to) {
		const list = favouritesPanel.sanitize(favorites);
		if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) { return list; }
		const item = list.splice(from, 1)[0];
		list.splice(to, 0, item);
		return list;
	},

	/** Favourites in the given order (e.g. the panel's rows after a drag). IDs not in the list are ignored,
	favourites missing from the order keep their place at the end. */
	reorder: function(favorites, order) {
		const list = favouritesPanel.sanitize(favorites);
		const ordered = favouritesPanel.sanitize(order).filter(function(id) { return list.indexOf(id) >= 0; });
		return ordered.concat(list.filter(function(id) { return ordered.indexOf(id) < 0; }));
	},

	/** Favourites with "Show on map" on */
	mapFavorites: function(favorites, settings) {
		return favouritesPanel.sanitize(favorites).filter(function(id) { return favouritesPanel.flags(settings, id).map; });
	},

	/** Favourites with "Route" on */
	routeFavorites: function(favorites, settings) {
		return favouritesPanel.sanitize(favorites).filter(function(id) { return favouritesPanel.flags(settings, id).route; });
	},

	/** Favourites with "Route" on and their mode: [{systemID, mode: "shortest" | "safe"}] */
	routeModes: function(favorites, settings) {
		return favouritesPanel.routeFavorites(favorites, settings).map(function(id) {
			return { systemID: id, mode: favouritesPanel.flags(settings, id).route };
		});
	},

	/** The array to stand in for options.favorites while the chain map is built: iterating it gives only
	the favourites shown on the map (the chain map loops over it with for..in), but indexOf still answers
	for every favourite so the star on favourite systems' nodes stays. */
	chainFavorites: function(favorites, settings) {
		const all = favorites;
		const shown = favouritesPanel.mapFavorites(favorites, settings);
		if (shown.length === favouritesPanel.sanitize(favorites).length) { return favorites; }
		Object.defineProperty(shown, "indexOf", {
			enumerable: false,
			value: function() { return Array.prototype.indexOf.apply(all, arguments); }
		});
		return shown;
	},

	/** Run fn() with options.favorites swapped for chainFavorites(...), always restoring the real list
	(also when fn throws). opts is the options object; returns fn's result. */
	withChainFavorites: function(opts, settings, fn) {
		const favorites = opts.favorites;
		opts.favorites = favouritesPanel.chainFavorites(favorites, settings);
		try {
			return fn();
		} finally {
			opts.favorites = favorites;
		}
	},

	/** Whether upstream ever draws a favourite on the chain map: only k-space ones (not J-space, Thera...) */
	/** New settings with "Show on map" on for one favourite and off for every other k-space favourite
	(used when favourites on the map were switched off: turning them on then shows just that one).
	Route flags and non-k-space favourites are left alone. systems: appData.systems-like lookup. */
	showOnly: function(settings, favorites, systemID, systems) {
		const id = favouritesPanel.toID(systemID);
		let result = favouritesPanel.settings({ favoritesPanel: settings });
		favouritesPanel.sanitize(favorites).forEach(function(f) {
			if (!favouritesPanel.canShowOnMap(systems ? systems[f] : null)) { return; }
			result = favouritesPanel.setFlag(result, f, "map", f === id);
		});
		return result;
	},

	/** Settings without the flags of one system (a favourite about to be removed) */
	dropFlags: function(settings, systemID) {
		const result = favouritesPanel.settings({ favoritesPanel: settings });
		delete result.systems[favouritesPanel.toID(systemID)];
		return result;
	},

	canShowOnMap: function(system) {
		return !!system && !(Number(system.regionID) >= 11000000);
	},

	// ---- Layout (pure) ----

	/** Where to put the widget when there's no saved position: right of the existing widgets, from row 1,
	as tall as they are (within limits), if that fits in the window; otherwise below them, at the left.
	widgets: [{col, row, size_x, size_y}]; availableCols: grid columns that fit in the window (optional) */
	defaultPlacement: function(widgets, availableCols) {
		let maxCol = 0, maxRow = 0;
		(widgets || []).forEach(function(w) {
			if (!w) { return; }
			maxCol = Math.max(maxCol, (Number(w.col) || 1) + (Number(w.size_x) || 1) - 1);
			maxRow = Math.max(maxRow, (Number(w.row) || 1) + (Number(w.size_y) || 1) - 1);
		});
		const size = favouritesPanel.DEFAULT_SIZE;
		if (availableCols && maxCol && maxCol + size.x > availableCols) {
			return { col: 1, row: maxRow + 1, size_x: Math.max(size.x, 7), size_y: size.y };
		}
		return { col: maxCol + 1, row: 1, size_x: size.x, size_y: Math.max(size.y, Math.min(maxRow, 14)) };
	},

	// ---- Routes through the chain (pure) ----

	/** A calculated route node (show viewing / show favourites): its last pathHome step has a gate path */
	isCalcRow: function(row) {
		const pathHome = row && Array.isArray(row.pathHome) ? row.pathHome : [];
		const last = pathHome[pathHome.length - 1];
		return !!(last && last.path);
	},

	/** Set of system IDs (strings) really on the chain: not calculated route nodes or destination nodes */
	chainSystems: function(rows) {
		const result = {};
		(rows || []).forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || row.destination || favouritesPanel.isCalcRow(row)) { return; }
			const id = favouritesPanel.toID(node.systemID);
			if (id) { result[String(id)] = true; }
		});
		return result;
	},

	/** Add a class to a node's markup (makeSystemNode output) */
	markNode: function(markup, cls) {
		if (typeof markup !== "string" || markup.indexOf(" " + cls + " ") >= 0) { return markup; }
		return markup.replace("class='node ", "class='node " + cls + " ");
	},

	/** K-space: a known system without a wormhole class, outside the wormhole regions (Pochven counts) */
	isKSpace: function(system) {
		return !!system && !system.class && (Number(system.regionID) || 0) < 11000000;
	},

	/** High-sec as the app shows it (security >= 0.45, like systemAnalysis), not Pochven */
	isHighSec: function(system) {
		return favouritesPanel.isKSpace(system) && system.factionID != 500026 && Number(system.security) >= 0.45;
	},

	/** Whether a route may pass through a system on its way (not as its start or destination): never Zarzakh
	(its gates hold you for hours) or a system on the user's avoid list; in safe mode only high-sec.
	@param ignore {<lower-case name>: true} (Settings > Routes & Navigation > avoid list, when enabled) */
	passable: function(system, safe, ignore) {
		if (!system) { return false; }
		const name = String(system.name || "");
		if (name === "Zarzakh" || (ignore && ignore[name.toLowerCase()])) { return false; }
		return !safe || favouritesPanel.isHighSec(system);
	},

	/** Gate jumps from one system to every system reachable by gates (breadth-first over the gate map).
	The start and every system reached may be anything, but only passable systems are travelled through:
	in safe mode the start and the destination may be any security, everything in between is high-sec.
	@param map gate adjacency keyed by systemID - 30000000 (appData.map.shortest)
	@param ignore see passable
	@return {<systemID>: jumps} */
	gateDistances: function(map, systems, fromID, safe, ignore) {
		const from = favouritesPanel.toID(fromID);
		const dist = {};
		if (!from || !map) { return dist; }
		dist[from] = 0;
		const queue = [from];
		for (let i = 0; i < queue.length; i++) {
			const current = queue[i];
			const next = map[current - 30000000] || {};
			for (const key in next) {
				const id = 30000000 + Number(key);
				if (dist[id] !== undefined) { continue; }
				dist[id] = dist[current] + 1;	// reachable as a destination...
				if (favouritesPanel.passable(systems[id], safe, ignore)) { queue.push(id); }	// ...and onwards
			}
		}
		return dist;
	},

	/** Everything a route needs about the current chain map, worked out once per draw.
	@param result chain.nodes() output
	@param startSystemID where the tracked character is
	@param exits [{systemID, nodeID}] k-space systems on the chain (routeDestinations.chainExits)
	@param distances function(systemID, safe) -> gateDistances (memoised by the caller)
	@param systems appData.systems-like lookup
	@param ignore avoid list, see passable
	@param dropScout leave out EVE-Scout links drawn on the chain (when theraRoute routes them, with its filters) */
	context: function(result, startSystemID, exits, distances, systems, ignore, dropScout) {
		const rows = (result && result.map && result.map.rows) || [];
		const lines = (result && result.lines) || [];
		const start = favouritesPanel.toID(startSystemID);
		const chain = favouritesPanel.chainSystems(rows);
		return {
			rows: rows, lines: lines, start: start, chain: chain, exits: exits || [], distances: distances, systems: systems || {}, ignore: ignore || null,
			connections: rally.systemConnections(rows, lines).filter(function(c) { return !(dropScout && favouritesPanel.isScoutLine(lines[c[3]])); }),
			startOnChain: !!(start && chain[String(start)]),
			startKSpace: !!(start && favouritesPanel.isKSpace((systems || {})[start])),
			holeFilters: typeof routeHoleFilters !== "undefined" && routeHoleFilters.contextFor ? routeHoleFilters.contextFor(lines) : null	// avoid EOL / crit / ... holes
		};
	},

	/** A chain line for an EVE-Scout connection (upstream's supplier gives them wormhole id 'ES-<id>') */
	isScoutLine: function(line) {
		return !!line && typeof line[3] === "string" && line[3].indexOf("ES-") === 0;
	},

	/** Quickest way from the tracked location to a favourite, for one route mode ("shortest" or "safe": your
	location and the favourite may be any security, every system you gate through in between is high-sec, including
	the chain systems you gate into or out of; wormhole legs through the chain are allowed either way).
	Candidates: gates straight there (k-space start); otherwise into the chain (you are on it, or gates to a
	k-space system on it), through wormholes, and out of it (the favourite is on the chain, or gates from a
	k-space system on it). Fewest jumps in total wins; ties go to fewer wormhole jumps.
	Returns {status: "ok" | "here" | "no-location" | "no-route", mode, kind: "direct" | "chain", total,
	gatesIn, holes, gatesOut, entrySystemID, exitSystemID, lineIndexes (wormhole connections)} */
	plan: function(ctx, favID, mode) {
		const id = favouritesPanel.toID(favID);
		const safe = mode === "safe";
		if (ctx.start && ctx.start === id) { return { status: "here", mode: mode }; }
		if (!ctx.start) { return { status: "no-location", reason: "untracked", mode: mode }; }
		if (!ctx.startOnChain && !ctx.startKSpace) { return { status: "no-location", reason: "off-chain", mode: mode }; }

		const fromFav = ctx.distances(id, safe);
		// Chain systems you gate into or out of are passed through, so they must be passable too
		const through = function(systemID) { return favouritesPanel.passable(ctx.systems[systemID], safe, ctx.ignore); };
		const fromStart = ctx.startKSpace ? ctx.distances(ctx.start, safe) : null;
		let best = null;
		const consider = function(c) {
			c.total = c.gatesIn + c.holes + c.gatesOut;
			// A route that avoids the filtered holes (routeHoleFilters) beats one that doesn't; then fewest jumps
			const dirtier = best && (best.holeBad > 0) !== (c.holeBad > 0);
			if (!best || (dirtier ? !(c.holeBad > 0) : (c.total < best.total || (c.total === best.total && c.holes < best.holes)))) { best = c; }
		};

		if (fromStart && fromStart[id] !== undefined) {
			consider({ kind: "direct", gatesIn: fromStart[id], holes: 0, gatesOut: 0, lineIndexes: [] });
		}
		const entries = [];
		if (ctx.startOnChain) { entries.push({ systemID: ctx.start, gates: 0 }); }
		if (fromStart) {
			ctx.exits.forEach(function(e) {
				if (e.systemID !== ctx.start && fromStart[e.systemID] !== undefined && through(e.systemID)) { entries.push({ systemID: e.systemID, gates: fromStart[e.systemID] }); }
			});
		}
		const targets = [];
		if (ctx.chain[String(id)]) { targets.push({ systemID: id, gates: 0 }); }
		ctx.exits.forEach(function(x) {
			if (x.systemID !== id && fromFav[x.systemID] !== undefined && through(x.systemID)) { targets.push({ systemID: x.systemID, gates: fromFav[x.systemID] }); }
		});
		entries.forEach(function(entry) {
			targets.forEach(function(target) {
				const found = ctx.holeFilters ? routeHoleFilters.route(ctx.connections, entry.systemID, target.systemID, ctx.holeFilters) : null;
				const path = ctx.holeFilters ? (found && found.path) : rally.routeTo(ctx.connections, entry.systemID, target.systemID);
				if (!path || !path.length) { return; }	// no wormholes used: a gate route, covered by "direct"
				consider({ kind: "chain", gatesIn: entry.gates, holes: path.length, gatesOut: target.gates,
					entrySystemID: entry.systemID, exitSystemID: target.systemID, lineIndexes: path,
					holeMarks: found ? found.marks : {}, holeBad: found ? found.bad : 0, holeNote: found ? found.note : "" });
			});
		});
		if (!best) { return { status: "no-route", mode: mode }; }
		best.status = "ok";
		best.mode = mode;
		return best;
	},

	/** Mark a plan on the chain: wormhole connections, the system you enter the chain at (when you gate to it),
	and where you leave it: the favourite's own node, its calculated route node (plus that connection), or the exit */
	highlight: function(ctx, favID, plan) {
		if (!plan || plan.status !== "ok" || (plan.kind !== "chain" && plan.kind !== "scout")) { return; }
		const id = favouritesPanel.toID(favID);
		const safe = plan.mode === "safe";
		const lineClass = safe ? favouritesPanel.SAFE_ROUTE_CLASS : favouritesPanel.ROUTE_CLASS;
		const nodeClass = safe ? favouritesPanel.SAFE_NODE_CLASS : favouritesPanel.NODE_CLASS;
		const exitClass = safe ? favouritesPanel.SAFE_EXIT_CLASS : favouritesPanel.EXIT_CLASS;
		const rows = ctx.rows, lines = ctx.lines;
		const addLine = function(index) {
			const line = lines[index];
			if (line && Array.isArray(line[2]) && line[2].indexOf(lineClass) < 0) { line[2].push(lineClass); }
		};
		const markFirst = function(test, cls) {
			for (let i = 0; i < rows.length; i++) {
				const row = rows[i], node = row && row.c && row.c[0];
				if (node && test(row, node)) { node.f = favouritesPanel.markNode(node.f, cls); return row; }
			}
			return null;
		};
		const realNode = function(systemID) {
			return function(row, node) { return !row.destination && !favouritesPanel.isCalcRow(row) && favouritesPanel.toID(node.systemID) === systemID; };
		};
		plan.lineIndexes.forEach(addLine);
		if (plan.holeMarks && typeof routeHoleFilters !== "undefined") { routeHoleFilters.markLines(lines, plan.holeMarks); }
		if (plan.kind === "scout") {	// through Thera/Turnur: the chain's wormholes, and EVE-Scout links if the tab draws them
			lines.forEach(function(line, index) { if (line && (plan.scoutLineIDs || []).indexOf(line[3]) >= 0) { addLine(index); } });
			return;
		}
		if (plan.gatesIn > 0) { markFirst(realNode(plan.entrySystemID), exitClass); }
		if (plan.exitSystemID === id) { markFirst(realNode(id), nodeClass); return; }
		const exitNodes = {};
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (node && !row.destination && !favouritesPanel.isCalcRow(row) && favouritesPanel.toID(node.systemID) === plan.exitSystemID) { exitNodes[node.v] = true; }
		});
		const calc = markFirst(function(row, node) {
			return favouritesPanel.isCalcRow(row) && favouritesPanel.toID(node.systemID) === id && row.c[1] && exitNodes[row.c[1].v];
		}, nodeClass);
		if (calc) {
			lines.forEach(function(line, index) { if (line && line[0] === calc.c[0].v && line[1] === calc.c[1].v) { addLine(index); } });
		} else {
			markFirst(realNode(plan.exitSystemID), exitClass);
		}
	},

	/** Decorate chain.nodes() output in place for the favourites with Route on, and work out both modes for
	each (the row's tooltip compares them). Returns {<favID>: {mode, shortest, safe}}.
	@param routeFavorites [{systemID, mode}]
	@param scout optional function(ctx, favID, mode) -> a route through Thera/Turnur (theraRoute), used when it is shorter */
	decorate: function(result, routeFavorites, startSystemID, exits, distances, systems, ignore, scout) {
		const lines = (result && result.lines) || [];
		const own = [favouritesPanel.ROUTE_CLASS, favouritesPanel.SAFE_ROUTE_CLASS];
		lines.forEach(function(line) {
			if (line && Array.isArray(line[2])) {
				for (let i = line[2].length - 1; i >= 0; i--) { if (own.indexOf(line[2][i]) >= 0) { line[2].splice(i, 1); } }
			}
		});
		const routes = {};
		if (!(routeFavorites || []).length) { return routes; }
		const ctx = favouritesPanel.context(result, startSystemID, exits, distances, systems, ignore, !!scout);
		routeFavorites.forEach(function(f) {
			const info = { mode: f.mode, shortest: favouritesPanel.plan(ctx, f.systemID, "shortest"), safe: favouritesPanel.plan(ctx, f.systemID, "safe") };
			if (scout && typeof theraRoute !== "undefined") {
				["shortest", "safe"].forEach(function(mode) {
					const alt = info[mode] && info[mode].status === "here" ? null : scout(ctx, f.systemID, mode);
					if (theraRoute.better(info[mode], alt)) { info[mode] = alt; }
				});
			}
			routes[f.systemID] = info;
			favouritesPanel.highlight(ctx, f.systemID, info[f.mode === "safe" ? "safe" : "shortest"]);
		});
		return routes;
	},

	/** Short breakdown of a plan, e.g. "4g → 2wh → 6g" or "direct 9g" */
	planText: function(plan) {
		if (!plan) { return ""; }
		if (plan.status === "here") { return "here"; }
		if (plan.status !== "ok") { return ""; }
		if (plan.kind === "direct") { return "direct " + plan.gatesIn + "g"; }
		if (plan.kind === "scout") { return theraRoute.planText(plan); }
		const parts = [];
		if (plan.gatesIn) { parts.push(plan.gatesIn + "g"); }
		parts.push(plan.holes + "wh");
		if (plan.gatesOut) { parts.push(plan.gatesOut + "g"); }
		return parts.join(" → ");
	},

	/** One plan in words. name: function(systemID) -> system name */
	planDetail: function(plan, favName, name) {
		const plural = function(n, word) { return n + " " + word + (n === 1 ? "" : "s"); };
		if (!plan) { return ""; }
		if (plan.status === "here") { return "you are in " + favName; }
		if (plan.status === "no-location") {
			return plan.reason === "untracked" ? "no route: your location isn't known" : "no route: you are in J-space off the chain map";
		}
		if (plan.status !== "ok") {
			return plan.mode === "safe" ? "no high-sec-only route" : "no route from here";
		}
		if (plan.kind === "direct") { return "direct: " + plural(plan.gatesIn, "gate jump") + ", no wormholes"; }
		if (plan.kind === "scout") { return theraRoute.planDetail(plan, favName, name, Date.now()); }
		const steps = [];
		if (plan.gatesIn) { steps.push(plural(plan.gatesIn, "gate jump") + " to " + name(plan.entrySystemID)); }
		steps.push(plural(plan.holes, "wormhole jump") + " to " + name(plan.exitSystemID));
		if (plan.gatesOut) { steps.push(plural(plan.gatesOut, "gate jump") + " to " + favName); }
		return favouritesPanel.planText(plan) + " (" + steps.join(", ") + ")";
	},

	/** Text and tooltip for a favourite's route: the selected mode first, the other one too when it differs */
	routeSummary: function(info, favName, name) {
		if (!info || !info.mode) { return { text: "", title: "Route: off. Click for the shortest route, again for a safe route (only high-sec between here and there)", ok: false }; }
		const label = { shortest: "Shortest", safe: "Safe" };
		const selected = info[info.mode];
		const other = info[info.mode === "safe" ? "shortest" : "safe"];
		let title = "Route (" + (info.mode === "safe" ? "safe, only high-sec between here and there" : "shortest") + "): "
			+ favouritesPanel.planDetail(selected, favName, name);
		if (other && other.status !== "no-location" && favouritesPanel.planText(other) !== favouritesPanel.planText(selected)) {
			title += " · " + label[other.mode] + ": " + favouritesPanel.planDetail(other, favName, name);
		}
		const ok = !!selected && (selected.status === "ok" || selected.status === "here");
		return { text: favouritesPanel.planText(selected), title: title, ok: ok };
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.sortable) {
	(function() {
		const fp = favouritesPanel;
		let renderTimer = null;
		let lastTracked = null;
		let dragging = false;		// a row is being dragged: don't rebuild the list under it
		let renderPending = false;
		let tooltipTimer = null;
		let tooltipOpen = false;	// ValidationTooltips is shared: only close what we opened

		function current() { return fp.settings(options); }
		function isOn() { return fp.enabled(options); }
		function trackedSystem() { return tripwire.client && tripwire.client.EVE ? tripwire.client.EVE.systemID : null; }
		function systemName(id) { return (tripwire.systems[id] || appData.systems[id] || {}).name || String(id); }
		function redrawChain() { if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); } }

		// ---- Chain map hook (installed now, before the first draw) ----
		if (typeof chain !== "undefined" && chain && typeof chain.nodes === "function" && !chain.nodes.favouritesPanelWrapped) {
			const originalNodes = chain.nodes;
			chain.nodes = function() {
				const on = isOn();
				const settings = current();
				const favorites = options.favorites;
				const self = this, args = arguments;
				// Only favourites with "Show on map" get calculated route nodes
				const result = on
					? fp.withChainFavorites(options, settings, function() { return originalNodes.apply(self, args); })
					: originalNodes.apply(this, arguments);
				try {
					lastTracked = trackedSystem();
					const routeFavs = on ? fp.routeModes(favorites, settings) : [];
					// Thera/Turnur routes on: EVE-Scout links drawn on the chain go through theraRoute (with its filters);
					// off: they count as chain wormholes and exits, as before
					const scout = typeof theraRoute !== "undefined" && theraRoute.enabled && theraRoute.enabled() ? theraRoute.favouriteScout : null;
					const exits = routeFavs.length ? routeDestinations.chainExits(result.map.rows, scout ? result.lines : null) : [];
					fp.lastRoutes = fp.decorate(result, routeFavs, lastTracked, exits, gateDistances, appData.systems, avoidList(), scout);
				} catch (e) { console.error("Favourites panel: route decorate failed", e); }
				clearTimeout(renderTimer);
				renderTimer = setTimeout(render, 0);
				return result;
			};
			chain.nodes.favouritesPanelWrapped = true;
		}

		// Gate jumps from a system to everywhere (shortest or high-sec only), kept between draws: the gate map
		// doesn't change, and favourites and the location change rarely
		let distanceCache = {}, distanceCount = 0, distanceAvoid = "";
		/** The user's avoid list (Settings > Routes & Navigation), when switched on: {<lower-case name>: true} */
		function avoidList() {
			const r = options.chain && options.chain.routeIgnore;
			if (!r || !r.enabled || !Array.isArray(r.systems)) { return null; }
			const list = {};
			r.systems.forEach(function(n) { if (n) { list[String(n).trim().toLowerCase()] = true; } });
			return list;
		}
		function gateDistances(systemID, safe) {
			const avoid = avoidList();
			const avoidKey = avoid ? Object.keys(avoid).sort().join(",") : "";
			if (avoidKey !== distanceAvoid) { distanceCache = {}; distanceCount = 0; distanceAvoid = avoidKey; }
			const key = systemID + (safe ? "|safe" : "");
			if (!distanceCache[key]) {
				if (++distanceCount > 60) { distanceCache = {}; distanceCount = 1; }
				const map = (tripwire.map && tripwire.map.shortest) || appData.map.shortest;
				distanceCache[key] = fp.gateDistances(map, appData.systems, systemID, safe, avoid);
			}
			return distanceCache[key];
		}

		// ---- Widget ----

		function globalMapOn() { return $("#show-favorite").hasClass("active"); }

		function mapIconHtml(id, system, flags) {
			const esc = fp.escape;
			if (!fp.canShowOnMap(tripwire.systems[id] || appData.systems[id])) {
				return "<i class='fav-map disabled' data-icon='eye' title='" + esc("Show on map: only k-space favourites can be drawn on the chain map") + "'></i>";
			}
			const title = !globalMapOn()
				? "Show only " + system.name + " on the chain map (favourites on the map are off: this turns on the star button in the chain map toolbar and hides the others)"
				: "Show on map: " + (flags.map ? "on" : "off") + ". Gate jumps to " + system.name + " from the chain's k-space exits";
			return "<i class='fav-map" + (flags.map ? " active" : "") + (globalMapOn() ? "" : " fav-map-global-off") + "' data-icon='eye' title='" + esc(title) + "'></i>";
		}

		function rowHtml(id, settings) {
			const esc = fp.escape;
			const system = systemAnalysis.analyse(id);
			const region = (tripwire.regions && tripwire.regions[system.regionID]) ? tripwire.regions[system.regionID].name : "";
			const flags = fp.flags(settings, id);
			const info = flags.route ? Object.assign({}, fp.lastRoutes[id] || {}, { mode: flags.route }) : null;
			const summary = fp.routeSummary(info, system.name, systemName);
			const routeState = !flags.route ? "" : (" fav-route-" + flags.route + (summary.ok ? " fav-route-ok" : " fav-route-none"));
			const next = { shortest: "click for the safe (high-sec only) route", safe: "click to turn the route off" }[flags.route] || "";
			const routeTitle = summary.title + (next ? " (" + next + ")" : "");
			return "<li class='fav-row' data-systemid='" + id + "'>"
				+ "<span class='fav-handle' title='Drag to reorder'>&#8942;&#8942;</span>"
				+ "<span class='fav-class " + esc(system.systemTypeClass) + "'>" + esc(system.systemTypeName) + "</span>"
				+ "<a class='fav-name " + esc(system.systemTypeClass) + "' href='.?system=" + esc(system.name) + "' title='View " + esc(system.name) + "'>" + esc(system.name) + "</a>"
				+ "<span class='fav-region' title='" + esc(region) + "'>" + esc(region) + "</span>"
				+ "<span class='fav-tools'>"
				+ "<span class='fav-route-text' title='" + esc(summary.title) + "'>"
				+ (flags.route === "safe" ? "<span class='fav-route-mode' title='High-sec only'>safe</span>" : "")
				+ esc(flags.route ? summary.text : "") + "</span>"
				+ mapIconHtml(id, system, flags)
				+ "<i class='fav-route" + (flags.route ? " active" : "") + routeState + "' data-icon='connection' title='" + esc(routeTitle) + "'></i>"
				+ "<i class='fav-remove' data-icon='times' title='Remove " + esc(system.name) + " from favourites'></i>"
				+ "</span>"
				+ scoutLine(info)
				+ holeNote(info)
				+ "</li>";
		}

		/** Second line of a row whose route had to use EOL / critical / ... holes (routeHoleFilters): the one-line note */
		function holeNote(info) {
			const plan = info ? info[info.mode] : null;
			if (!plan || !plan.holeNote) { return ""; }
			return "<span class='fav-hole-note' title='" + fp.escape(plan.holeNote) + "'>&#9888; " + fp.escape(plan.holeNote) + "</span>";
		}

		/** Second line of a row routed through Thera/Turnur: the systems and signatures to warp to */
		function scoutLine(info) {
			const plan = info ? info[info.mode] : null;
			if (!plan || plan.kind !== "scout" || typeof theraRoute === "undefined") { return ""; }
			// Jump markers on: the route strip shows the hops and the signatures as chips instead
			if (typeof favouritesRouteStrip !== "undefined" && favouritesRouteStrip.enabled(options)) { return ""; }
			return "<span class='fav-scout-line' title='" + fp.escape(theraRoute.planDetail(plan, "", systemName, Date.now())) + "'>"
				+ fp.escape(theraRoute.lineText(plan, systemName)) + "</span>";
		}

		function render() {
			const $list = $("#" + fp.WIDGET_ID + " .fav-list");
			if (!$list.length) { return; }
			if (dragging) { renderPending = true; return; }
			renderPending = false;
			const settings = current();
			const favorites = fp.sanitize(options.favorites);
			$list.html(favorites.length ? favorites.map(function(id) { return rowHtml(id, settings); }).join("")
				: "<li class='fav-empty'>No favourites yet. Add a system above, or use the star in the system info panel.</li>");
			$("#" + fp.WIDGET_ID + " .fav-count").text(favorites.length ? "(" + favorites.length + ")" : "");
			if ($list.hasClass("ui-sortable")) { $list.sortable("refresh"); }
		}
		fp.render = render;

		/** Keep the info panel's star button in step with options.favorites */
		function syncStar() {
			if (typeof viewingSystemID === "undefined") { return; }
			if (options.favorites.indexOf(parseInt(viewingSystemID)) >= 0) {
				$("#system-favorite").attr("data-icon", "star").addClass("active");
			} else {
				$("#system-favorite").attr("data-icon", "star-empty").removeClass("active");
			}
		}

		/** Save a changed favourites list and/or settings, then redraw */
		function save(favorites, settings) {
			if (favorites) { options.favorites = favorites; }
			const s = fp.cleanFlags(settings || current(), options.favorites);
			options.favoritesPanel = Object.assign({}, options.favoritesPanel || {}, { systems: s.systems });
			options.save();
			syncStar();
			redrawChain();
			render();
		}

		let searchSource = null;
		function allSystems() {
			if (!searchSource) {
				searchSource = {};
				for (const id in appData.systems) {
					if (fp.toID(id)) { searchSource[id] = appData.systems[id]; }
				}
			}
			return searchSource;
		}

		function closeTooltip() {
			clearTimeout(tooltipTimer);
			if (tooltipOpen && typeof ValidationTooltips !== "undefined") { ValidationTooltips.close(); }
			tooltipOpen = false;
		}

		function addFromInput() {
			const $input = $("#" + fp.WIDGET_ID + " .fav-search");
			const value = $.trim($input.val());
			if (!value) { return; }
			const result = fp.add(options.favorites, value, appData.systems, routeDestinations.findByName);
			if (result.error) {
				if (typeof ValidationTooltips !== "undefined") {
					ValidationTooltips.open({ target: $input }).setContent(fp.escape(result.error));
					tooltipOpen = true;
					clearTimeout(tooltipTimer);
					tooltipTimer = setTimeout(closeTooltip, 4000);
				}
				return;
			}
			closeTooltip();
			$input.val("");
			save(result.list);
		}

		function widgetHtml() {
			return "<li id='" + fp.WIDGET_ID + "' class='gridWidget'>"
				+ "<div class='controls'>"
				+ "<span class='fav-title'><i data-icon='star'></i> Favourites <span class='fav-count'></span></span>"
				+ "</div>"
				+ "<div class='content'>"
				+ "<form class='fav-add' autocomplete='off'>"
				+ "<input type='text' class='fav-search' placeholder='Add a system, e.g. Jita' />"
				+ "<input type='submit' value='Add' />"
				+ "</form>"
				+ "<ul class='fav-list'></ul>"
				+ (typeof routeHoleFilters !== "undefined" ? "<div class='fav-oneway'>" + routeHoleFilters.toggleHtml(routeHoleFilters.oneWay()) + "</div>" : "")
				+ "</div>"
				+ "</li>";
		}

		/** The panel as panelHost (panel-host.js) takes it */
		const panel = { id: fp.WIDGET_ID, title: "Favourites", key: "favoritesPanel",
			size: { x: fp.DEFAULT_SIZE.x, y: fp.DEFAULT_SIZE.y, minX: fp.MIN_SIZE.x, minY: fp.MIN_SIZE.y } };

		function addWidget() {
			// The saved layout, else where it was when it was turned off (kept), else the first free place
			const $widget = panelHost.addGridWidget(panel, widgetHtml(), { transition: false, place: function(others, g) {
				return panelHost.atLeastMinSize(panelHost.gridEntry(options.grid, fp.WIDGET_ID), panel.size)
					|| panelHost.atLeastMinSize(current().position, panel.size)
					|| fp.defaultPlacement(g.serialize(), panelHost.availableCols(g));
			} });
			if (!$widget) { return; }

			const $list = $widget.find(".fav-list");
			$list.sortable({
				handle: ".fav-handle",
				axis: "y",
				items: "> li.fav-row",
				containment: "parent",
				tolerance: "pointer",
				start: function() { dragging = true; },
				stop: function() {
					dragging = false;
					if (renderPending) { setTimeout(render, 0); }
				},
				update: function() {
					dragging = false;
					save(fp.reorder(options.favorites, $list.sortable("toArray", { attribute: "data-systemid" })));
				}
			});
			if ($.fn.inlinecomplete) {
				$widget.find(".fav-search").on("input blur", closeTooltip);
				$widget.find(".fav-search").inlinecomplete({ source: allSystems(), renderer: "system", maxSize: 10, delay: 0 });
			}
			render();
		}

		function removeWidget() {
			closeTooltip();
			// Remember where it was, so turning it back on puts it in the same place
			panelHost.removeGridWidget(panel, $("#" + fp.WIDGET_ID), { remember: "favoritesPanel", finishFade: true });
		}

		/** Show or hide the widget for the current setting (redraws the chain, as routes depend on it) */
		function applyEnabled() {
			if (isOn()) { addWidget(); } else { removeWidget(); }
			render();
		}

		// ---- Settings > Routes & Navigation ----

		function setupSettings() {
			// Takes effect on Save; Reset deletes options.favoritesPanel (back to the defaults)
			forkSettings.register({
				section: "routes", order: 50, id: "favouritesPanel-enabled", type: "checkbox", key: "favoritesPanel",
				label: "Favourites panel:", text: "Show the Favourites panel",
				get: function() { return isOn(); },
				set: function(o, on) { o.favoritesPanel = Object.assign({}, o.favoritesPanel || {}, { enabled: on }); }
			});

			// Save and Reset both end in options.apply(): show/hide the panel and refresh it then
			if (!options.apply.favouritesPanelWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					try { applyEnabled(); } catch (err) { console.error("Favourites panel: apply failed", err); }
					return result;
				};
				options.apply.favouritesPanelWrapped = true;
			}
		}

		$(function() {
			panelHost.register(panel);
			setupSettings();
			applyEnabled();
			if (typeof forkCommands !== "undefined") {	// command palette (Ctrl+K)
				forkCommands.register({
					id: "favourites.add", title: "Add favourite", group: "Routes", icon: "star", keywords: ["star", "favorite", "system"],
					context: function() { return true; },
					args: [{ name: "system", label: "system", type: "system", default: function(ctx) { return ctx.viewingSystemID; } }],
					run: function(args) {
						const result = fp.add(options.favorites, args.system, appData.systems, routeDestinations.findByName);
						if (result.error) { throw new Error(result.error); }
						save(result.list);
					}
				});
				forkCommands.panelToggle({ id: "panel.favourites", title: "Toggle Favourites panel", key: "favoritesPanel", icon: "star", keywords: ["favorite", "star"] });
			}

			const $doc = $(document);
			const sel = "#" + fp.WIDGET_ID;
			$doc.on("submit", sel + " .fav-add", function(e) { e.preventDefault(); addFromInput(); });
			$doc.on("click", sel + " .fav-remove", function(e) {
				e.preventDefault();
				save(fp.remove(options.favorites, $(this).closest(".fav-row").data("systemid")));
			});
			$doc.on("click", sel + " .fav-route", function(e) {
				e.preventDefault();
				const id = $(this).closest(".fav-row").data("systemid");
				save(null, fp.setFlag(current(), id, "route", fp.nextRouteMode(fp.flags(current(), id).route)));
			});
			$doc.on("click", sel + " .fav-map", function(e) {
				e.preventDefault();
				if ($(this).hasClass("disabled")) { return; }
				const id = $(this).closest(".fav-row").data("systemid");
				if (globalMapOn()) {
					save(null, fp.setFlag(current(), id, "map", !fp.flags(current(), id).map));
					return;
				}
				// Favourites on the map are off: show only this one (not every favourite at once), then switch
				// them on through the toolbar button's own handler (it redraws and saves options, flags included)
				const s = fp.cleanFlags(fp.showOnly(current(), options.favorites, id, tripwire.systems), options.favorites);
				options.favoritesPanel = Object.assign({}, options.favoritesPanel || {}, { systems: s.systems });
				$("#show-favorite").trigger("click");
				render();
			});
			// The toolbar button changes how the eyes look
			$("#show-favorite").on("click", function() { setTimeout(render, 0); });

			// The info panel's star. Un-favouriting: drop that system's flags in the capture phase, i.e. before
			// upstream's handler removes it and saves options, so the cleaned flags are saved with it (one save).
			const star = document.getElementById("system-favorite");
			if (star) {
				document.addEventListener("click", function(e) {
					if (e.target !== star || !$(star).hasClass("active") || typeof viewingSystemID === "undefined") { return; }
					const s = fp.dropFlags(current(), viewingSystemID);
					options.favoritesPanel = Object.assign({}, options.favoritesPanel || {}, { systems: s.systems });
				}, true);
			}
			// After upstream's handler (bound first): refresh the list. A click triggered from script runs jQuery
			// handlers before the capture listener, so if flags are still stale here, save them now.
			$("#system-favorite").on("click", function() {
				const before = JSON.stringify(current().systems);
				const s = fp.cleanFlags(current(), options.favorites);
				if (JSON.stringify(s.systems) !== before) {
					options.favoritesPanel = Object.assign({}, options.favoritesPanel || {}, { systems: s.systems });
					options.save();
				}
				syncStar();
				render();
			});

			// Routes start at the tracked character: redraw when they move
			setInterval(function() {
				if (!isOn() || !fp.routeFavorites(options.favorites, current()).length) { return; }
				if (String(trackedSystem()) !== String(lastTracked)) { redrawChain(); }
			}, fp.LOCATION_CHECK_MS);
		});
	})();
}
