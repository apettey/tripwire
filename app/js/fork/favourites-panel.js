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
	EXIT_CLASS: "favourite-route-exit",     // exit node a route leaves the chain by (when no calculated node is drawn)
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
				systems[id] = { map: f.map !== false, route: f.route === true };
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

	/** Flags for one favourite: {map (default on), route (default off)} */
	flags: function(settings, systemID) {
		const f = settings && settings.systems ? settings.systems[favouritesPanel.toID(systemID)] : null;
		return { map: !f || f.map !== false, route: !!(f && f.route === true) };
	},

	/** New settings with one flag changed. Entries equal to the defaults are dropped to keep options small. */
	setFlag: function(settings, systemID, key, value) {
		const id = favouritesPanel.toID(systemID);
		const result = favouritesPanel.settings({ favoritesPanel: settings });
		if (!id || (key !== "map" && key !== "route")) { return result; }
		const f = favouritesPanel.flags(result, id);
		f[key] = !!value;
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
	canShowOnMap: function(system) {
		return !!system && !(Number(system.regionID) >= 11000000);
	},

	// ---- Layout (pure) ----

	/** Saved gridster entry for the widget from options.grid (array or object, old "oog" format) */
	gridEntry: function(grid, id) {
		if (!grid || typeof grid !== "object") { return null; }
		const source = grid.oog && typeof grid.oog === "object" && Object.keys(grid.oog).length ? grid.oog : grid;
		const entries = Array.isArray(source) ? source : Object.keys(source).map(function(k) { return source[k]; });
		return entries.filter(function(e) { return e && e.id === id; })[0] || null;
	},

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

	/** Placement from a saved entry, or null if it isn't usable */
	savedPlacement: function(entry) {
		if (!entry) { return null; }
		const p = {
			col: Number(entry.col), row: Number(entry.row),
			size_x: Math.max(favouritesPanel.MIN_SIZE.x, Number(entry.size_x) || 0),
			size_y: Math.max(favouritesPanel.MIN_SIZE.y, Number(entry.size_y) || 0)
		};
		return p.col >= 1 && p.row >= 1 ? p : null;
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

	/** Ways to reach a favourite from the chain, each {exitSystemID, gateJumps, nodeIndex, lineIndex, kind}:
	 - "chain": the favourite is itself on the chain (gateJumps 0, nodeIndex = its row)
	 - "calc": a calculated route node to it is drawn (nodeIndex/lineIndex = that node and its connection)
	 - "exit": no calculated node, so every k-space exit with a gate route (gateJumps from gateJumps(exit, fav))
	@param exits [{systemID, nodeID}] k-space exits (only used when there is no chain/calc way) */
	candidates: function(rows, lines, favID, exits, gateJumps) {
		const id = favouritesPanel.toID(favID);
		const result = [];
		if (!id) { return result; }
		const nodeSystems = rally.nodeSystems(rows);
		(rows || []).forEach(function(row, index) {
			const node = row && row.c && row.c[0];
			if (!node || row.destination || favouritesPanel.toID(node.systemID) !== id) { return; }
			if (favouritesPanel.isCalcRow(row)) {
				const parentID = row.c[1] ? row.c[1].v : null;
				const exitSystemID = favouritesPanel.toID(nodeSystems[parentID]);
				const last = row.pathHome[row.pathHome.length - 1];
				let lineIndex = null;
				(lines || []).forEach(function(line, li) { if (line && line[0] === node.v && line[1] === parentID) { lineIndex = li; } });
				if (exitSystemID) {
					result.push({ kind: "calc", exitSystemID: exitSystemID, gateJumps: Number(last.jumps) || 0, nodeIndex: index, lineIndex: lineIndex });
				}
			} else {
				result.push({ kind: "chain", exitSystemID: id, gateJumps: 0, nodeIndex: index, lineIndex: null });
			}
		});
		// A calculated node already is the gate route from its exit. Without one (star button off, or the
		// favourite is itself on the chain, where upstream draws none) try every exit: a gate route from a
		// nearby exit can beat a long way round through wormholes.
		// Gate jumps: calculated nodes come from guidance.findShortestPath(tripwire.map.shortest, favourite, exit)
		// and gateJumps (routeDestinations.jumps) from the same function and map, exit to favourite, so both use
		// the user's route preferences; the direction differs, which can rarely change the count by a jump.
		if (result.some(function(c) { return c.kind === "calc"; })) { return result; }
		(exits || []).forEach(function(exit) {
			const jumps = gateJumps ? gateJumps(exit.systemID, id) : null;
			if (jumps === null || jumps === undefined) { return; }
			let nodeIndex = null;
			(rows || []).forEach(function(row, index) {
				if (nodeIndex === null && row && row.c && row.c[0] && row.c[0].v === exit.nodeID) { nodeIndex = index; }
			});
			result.push({ kind: "exit", exitSystemID: exit.systemID, gateJumps: jumps, nodeIndex: nodeIndex, lineIndex: null });
		});
		return result;
	},

	/** Quickest route from startSystemID to a favourite: fewest wormhole + gate jumps (ties: fewer wormhole jumps).
	Returns {status, holes, gates, kind, exitSystemID, lineIndexes, nodeIndex, lineIndex}; status is
	"ok", "here" (you are in the favourite), "no-location" (not tracked / not on the chain) or "no-route". */
	route: function(result, favID, startSystemID, exits, gateJumps) {
		const rows = (result && result.map && result.map.rows) || [];
		const lines = (result && result.lines) || [];
		const id = favouritesPanel.toID(favID);
		const start = favouritesPanel.toID(startSystemID);
		if (start && start === id) { return { status: "here", holes: 0, gates: 0, lineIndexes: [] }; }
		if (!start || !favouritesPanel.chainSystems(rows)[String(start)]) { return { status: "no-location" }; }

		const connections = rally.systemConnections(rows, lines);
		let best = null;
		favouritesPanel.candidates(rows, lines, id, exits, gateJumps).forEach(function(c) {
			const path = rally.routeTo(connections, start, c.exitSystemID);
			if (!path) { return; }
			const total = path.length + c.gateJumps;
			if (!best || total < best.total || (total === best.total && path.length < best.holes)) {
				best = { status: "ok", total: total, holes: path.length, gates: c.gateJumps, kind: c.kind,
					exitSystemID: c.exitSystemID, lineIndexes: path, nodeIndex: c.nodeIndex, lineIndex: c.lineIndex };
			}
		});
		return best || { status: "no-route" };
	},

	/** Decorate chain.nodes() output in place: route lines and end nodes for each favourite with Route on.
	Returns {<favID>: route info}. */
	decorate: function(result, routeFavorites, startSystemID, exits, gateJumps) {
		const rows = (result && result.map && result.map.rows) || [];
		const lines = (result && result.lines) || [];
		lines.forEach(function(line) {
			if (line && Array.isArray(line[2])) {
				const i = line[2].indexOf(favouritesPanel.ROUTE_CLASS);
				if (i >= 0) { line[2].splice(i, 1); }
			}
		});
		const routes = {};
		(routeFavorites || []).forEach(function(favID) {
			const info = favouritesPanel.route(result, favID, startSystemID, exits, gateJumps);
			routes[favID] = info;
			if (info.status !== "ok") { return; }
			const lineIndexes = info.lineIndexes.concat(info.lineIndex === null || info.lineIndex === undefined ? [] : [info.lineIndex]);
			lineIndexes.forEach(function(index) {
				const line = lines[index];
				if (line && Array.isArray(line[2]) && line[2].indexOf(favouritesPanel.ROUTE_CLASS) < 0) { line[2].push(favouritesPanel.ROUTE_CLASS); }
			});
			const row = info.nodeIndex === null || info.nodeIndex === undefined ? null : rows[info.nodeIndex];
			if (row && row.c && row.c[0]) {
				row.c[0].f = favouritesPanel.markNode(row.c[0].f, info.kind === "exit" ? favouritesPanel.EXIT_CLASS : favouritesPanel.NODE_CLASS);
			}
		});
		return routes;
	},

	/** Short text and tooltip for a favourite's route state */
	routeSummary: function(info, favName, exitName) {
		if (!info) { return { text: "", title: "Route: highlight the quickest way there from your location" }; }
		if (info.status === "here") { return { text: "here", title: "You are in " + favName }; }
		if (info.status === "no-location") { return { text: "", title: "No route: your location isn't on the chain map" }; }
		if (info.status !== "ok") { return { text: "", title: "No route: no k-space exit on the chain with a gate route to " + favName }; }
		const plural = function(n, word) { return n + " " + word + (n === 1 ? "" : "s"); };
		const text = info.holes + (info.gates ? "+" + info.gates : "") + "j";
		const title = info.kind === "chain"
			? plural(info.holes, "wormhole jump") + " to " + favName
			: plural(info.holes, "wormhole jump") + " to " + exitName + ", then " + plural(info.gates, "gate jump") + " to " + favName;
		return { text: text, title: title };
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
					const routeFavs = on ? fp.routeFavorites(favorites, settings) : [];
					const exits = routeFavs.length ? routeDestinations.chainExits(result.map.rows) : [];
					fp.lastRoutes = fp.decorate(result, routeFavs, lastTracked, exits, routeDestinations.jumps);
				} catch (e) { console.error("Favourites panel: route decorate failed", e); }
				clearTimeout(renderTimer);
				renderTimer = setTimeout(render, 0);
				return result;
			};
			chain.nodes.favouritesPanelWrapped = true;
		}

		// ---- Widget ----

		function globalMapOn() { return $("#show-favorite").hasClass("active"); }

		function mapIconHtml(id, system, flags) {
			const esc = fp.escape;
			if (!fp.canShowOnMap(tripwire.systems[id] || appData.systems[id])) {
				return "<i class='fav-map disabled' data-icon='eye' title='" + esc("Show on map: only k-space favourites can be drawn on the chain map") + "'></i>";
			}
			const title = !globalMapOn()
				? "Show on map: favourites on the chain map are off (star button in the chain map toolbar). Click to turn them on and show " + system.name
				: "Show on map: " + (flags.map ? "on" : "off") + ". Gate jumps to " + system.name + " from the chain's k-space exits";
			return "<i class='fav-map" + (flags.map ? " active" : "") + (globalMapOn() ? "" : " fav-map-global-off") + "' data-icon='eye' title='" + esc(title) + "'></i>";
		}

		function rowHtml(id, settings) {
			const esc = fp.escape;
			const system = systemAnalysis.analyse(id);
			const region = (tripwire.regions && tripwire.regions[system.regionID]) ? tripwire.regions[system.regionID].name : "";
			const flags = fp.flags(settings, id);
			const info = flags.route ? fp.lastRoutes[id] : null;
			const exitName = info && info.exitSystemID ? systemName(info.exitSystemID) : "";
			const summary = flags.route ? fp.routeSummary(info, system.name, exitName) : fp.routeSummary(null);
			const routeState = !flags.route ? "" : (info && (info.status === "ok" || info.status === "here") ? " fav-route-ok" : " fav-route-none");
			return "<li class='fav-row' data-systemid='" + id + "'>"
				+ "<span class='fav-handle' title='Drag to reorder'>&#8942;&#8942;</span>"
				+ "<span class='fav-class " + esc(system.systemTypeClass) + "'>" + esc(system.systemTypeName) + "</span>"
				+ "<a class='fav-name " + esc(system.systemTypeClass) + "' href='.?system=" + esc(system.name) + "' title='View " + esc(system.name) + "'>" + esc(system.name) + "</a>"
				+ "<span class='fav-region' title='" + esc(region) + "'>" + esc(region) + "</span>"
				+ "<span class='fav-tools'>"
				+ "<span class='fav-route-text' title='" + esc(summary.title) + "'>" + esc(flags.route ? summary.text : "") + "</span>"
				+ mapIconHtml(id, system, flags)
				+ "<i class='fav-route" + (flags.route ? " active" : "") + routeState + "' data-icon='connection' title='" + esc("Route: " + (flags.route ? "on. " + summary.title : "off. Highlight the quickest way there from your location")) + "'></i>"
				+ "<i class='fav-remove' data-icon='times' title='Remove " + esc(system.name) + " from favourites'></i>"
				+ "</span>"
				+ "</li>";
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
				+ "</div>"
				+ "</li>";
		}

		/** Grid columns that fit in the window (widget_base_dimensions + margins) */
		function availableCols(api) {
			const o = api.options || {};
			const step = ((o.widget_base_dimensions || [50])[0]) + 2 * ((o.widget_margins || [5])[0]);
			const zoom = parseFloat($("body").css("zoom")) || 1;	// Settings > UI Scale
			return Math.floor((window.innerWidth || $(window).width()) / zoom / step);
		}

		function gridApi() { return typeof grid !== "undefined" && grid && typeof grid.add_widget === "function" ? grid : null; }

		function addWidget() {
			const api = gridApi();
			if (!api) { return; }
			const $existing = $("#" + fp.WIDGET_ID);
			if ($existing.length) {
				if (api.$widgets.is($existing)) { return; }
				$existing.stop(true, true).remove();	// left over from a removal still fading out
			}
			const settings = current();
			const placement = fp.savedPlacement(fp.gridEntry(options.grid, fp.WIDGET_ID))
				|| fp.savedPlacement(settings.position)
				|| fp.defaultPlacement(api.serialize(), availableCols(api));
			const $widget = api.add_widget(widgetHtml(), placement.size_x, placement.size_y, placement.col, placement.row,
				null, [fp.MIN_SIZE.x, fp.MIN_SIZE.y]);
			$widget.stop(true, true);	// skip the fade-in (it never finishes in a background tab)
			// Resize handle like the other widgets: only visible while customising the layout
			$widget.find(".grid-resize").attr("data-icon", "resize").toggleClass("hidden", !$("#layout").hasClass("active"));

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
			const api = gridApi();
			const $widget = $("#" + fp.WIDGET_ID);
			closeTooltip();
			if (!api || !$widget.length) { return; }
			// Remember where it was, so turning it back on puts it in the same place
			const entry = fp.gridEntry(api.serialize($widget), fp.WIDGET_ID);
			if (entry) {
				options.favoritesPanel = Object.assign({}, options.favoritesPanel || {}, {
					position: { col: entry.col, row: entry.row, size_x: entry.size_x, size_y: entry.size_y }
				});
			}
			api.remove_widget($widget, true);
			$widget.stop(true, true);	// finish the fade-out now, which removes the element
		}

		/** Show or hide the widget for the current setting (redraws the chain, as routes depend on it) */
		function applyEnabled() {
			if (isOn()) { addWidget(); } else { removeWidget(); }
			render();
		}

		// ---- Settings > General Preferences ----

		function setupSettings() {
			const $table = $("#dialog-options #optionsAccordion > div").eq(2).find("table.optionsTable").first();
			if ($table.length && !$("#favouritesPanel-enabled").length) {
				$table.append("<tr><th>Favourites panel:</th><td><label><input type='checkbox' id='favouritesPanel-enabled' /> Show the Favourites panel</label></td></tr>");
				if ($("#optionsAccordion").hasClass("ui-accordion")) { $("#optionsAccordion").accordion("refresh"); }
			}
			$(document).on("dialogopen", "#dialog-options", function() {
				$("#favouritesPanel-enabled").prop("checked", isOn());
			});
			// Capture phase so the value is in place before upstream's Save handler applies and saves options
			document.addEventListener("click", function(e) {
				const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
				if (!button || $.trim($(button).text()) !== "Save") { return; }
				if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#favouritesPanel-enabled").length) { return; }
				options.favoritesPanel = Object.assign({}, options.favoritesPanel || {}, { enabled: $("#favouritesPanel-enabled").prop("checked") });
			}, true);

			// Settings > Reset: back to defaults (a missing key means defaults)
			if (typeof options.reset === "function" && !options.reset.favouritesPanelWrapped) {
				const reset = options.reset;
				const wrapped = function() {
					const result = reset.apply(this, arguments);
					delete this.favoritesPanel;
					return result;
				};
				Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
				wrapped.favouritesPanelWrapped = true;
				options.reset = wrapped;
			}

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
			setupSettings();
			applyEnabled();

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
				save(null, fp.setFlag(current(), id, "route", !fp.flags(current(), id).route));
			});
			$doc.on("click", sel + " .fav-map", function(e) {
				e.preventDefault();
				if ($(this).hasClass("disabled")) { return; }
				const id = $(this).closest(".fav-row").data("systemid");
				if (globalMapOn()) {
					save(null, fp.setFlag(current(), id, "map", !fp.flags(current(), id).map));
					return;
				}
				// Favourites on the map are off: show this one, then switch them on through the toolbar
				// button's own handler (it redraws and saves options, flags included)
				const s = fp.cleanFlags(fp.setFlag(current(), id, "map", true), options.favorites);
				options.favoritesPanel = Object.assign({}, options.favoritesPanel || {}, { systems: s.systems });
				$("#show-favorite").trigger("click");
				render();
			});
			// The toolbar button changes how the eyes look
			$("#show-favorite").on("click", function() { setTimeout(render, 0); });

			// The info panel's star (upstream handler runs first, as it was bound first)
			$("#system-favorite").on("click", function() {
				// Upstream already saved and redrew: just drop flags of a removed favourite and refresh the list
				const s = fp.cleanFlags(current(), options.favorites);
				options.favoritesPanel = Object.assign({}, options.favoritesPanel || {}, { systems: s.systems });
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
