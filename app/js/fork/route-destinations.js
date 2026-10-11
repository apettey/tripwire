const routeDestinations = {
	// Saved destinations ("common routes"): gate jumps from the chain's k-space exits to systems the user
	// often travels to, listed in a window and optionally drawn on the chain map (fork-owned file).
	// Saved per user in options.routeDestinations = [{systemID, show}].
	// Keep `const routeDestinations` on the first line: the test helper strips it to define a global.
	ID_PREFIX: "dest-",                     // synthetic chain node ids: dest-<exit node id>-<destination systemID>
	NODE_CLASS: "destination-node",         // class on synthetic chain nodes
	LINE_MODIFIER: "destination-route",     // modifier on synthetic chain connections
	DEFAULT_LIMIT: 15,

	// Exits found on the last chain map drawn (see decorate)
	lastExits: [],
	// Called after each chain map build, set by the UI code
	onDecorate: null,

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	},

	/** Numeric system ID, or null for anything else (including unknown "x|y" chain pseudo-systems) */
	toID: function(systemID) {
		if (systemID === null || systemID === undefined || systemID === "" || systemID === false) return null;
		if (typeof systemID === "string" && !/^\s*\d+\s*$/.test(systemID)) return null;
		const id = Number(systemID);
		return isFinite(id) && id > 0 ? id : null;
	},

	/** High-sec, low-sec, null-sec, Pochven: a known system without a wormhole class, in a k-space region */
	isKSpace: function(systemID) {
		const id = routeDestinations.toID(systemID);
		const system = id ? appData.systems[id] : null;
		return !!system && !system.class && (Number(system.regionID) || 0) < 11000000;
	},

	/** System ID for a system name (case-insensitive), or null */
	findByName: function(name) {
		const wanted = String(name || "").trim().toUpperCase();
		if (!wanted) return null;
		for (const id in appData.systems) {
			if (String(appData.systems[id].name).toUpperCase() === wanted) return Number(id);
		}
		return null;
	},

	routingLimit: function() {
		const limit = (typeof options !== "undefined" && options && options.chain) ? Number(options.chain.routingLimit) : NaN;
		return isFinite(limit) && limit >= 0 ? limit : routeDestinations.DEFAULT_LIMIT;
	},

	routeMap: function() {
		return (typeof tripwire !== "undefined" && tripwire && tripwire.map && tripwire.map.shortest) || appData.map.shortest;
	},

	// ---- Saved list (pure: these return new arrays, the caller saves) ----

	/** Valid, de-duplicated k-space entries as {systemID: number, show: boolean} */
	sanitize: function(list) {
		const seen = {};
		return (Array.isArray(list) ? list : []).reduce(function(out, entry) {
			const id = routeDestinations.toID(entry && entry.systemID);
			if (id && !seen[id] && routeDestinations.isKSpace(id)) {
				seen[id] = true;
				out.push({systemID: id, show: !!entry.show});
			}
			return out;
		}, []);
	},

	/** The current user's saved destinations (handles a missing options key) */
	saved: function() {
		return routeDestinations.sanitize(typeof options !== "undefined" && options ? options.routeDestinations : []);
	},

	/** Add a destination by system ID or name. Returns {list, systemID} or {list, error} */
	add: function(list, system) {
		list = routeDestinations.sanitize(list);
		const id = routeDestinations.toID(system) || routeDestinations.findByName(system);
		if (!id || !appData.systems[id]) {
			return {list: list, error: "Unknown system" + (system ? " \"" + system + "\"" : "")};
		}
		const name = appData.systems[id].name;
		if (!routeDestinations.isKSpace(id)) {
			return {list: list, error: name + " is not in k-space (high-sec, low-sec, null-sec or Pochven)"};
		}
		if (list.some(function(d) { return d.systemID === id; })) {
			return {list: list, error: name + " is already in your destinations"};
		}
		return {list: list.concat([{systemID: id, show: true}]), systemID: id};
	},

	remove: function(list, systemID) {
		const id = routeDestinations.toID(systemID);
		return routeDestinations.sanitize(list).filter(function(d) { return d.systemID !== id; });
	},

	setShow: function(list, systemID, show) {
		const id = routeDestinations.toID(systemID);
		return routeDestinations.sanitize(list).map(function(d) { return d.systemID === id ? {systemID: d.systemID, show: !!show} : d; });
	},

	setAllShow: function(list, show) {
		return routeDestinations.sanitize(list).map(function(d) { return {systemID: d.systemID, show: !!show}; });
	},

	allShown: function(list) {
		list = routeDestinations.sanitize(list);
		return list.length > 0 && list.every(function(d) { return d.show; });
	},

	// ---- Chain analysis ----

	/** K-space systems on the chain map, from chain.nodes() rows, in chain order:
	[{systemID, nodeID, holeName}]. Skips J-space, unknown "x|y" systems, calculated route nodes
	(viewing/favorite systems), our own synthetic nodes and repeated (loop) occurrences. With the chain's lines, also
	skips systems drawn through an EVE-Scout link (Thera/Turnur routes come from theraRoute, which applies its filters). */
	chainExits: function(rows, lines) {
		const seen = {}, exits = [];
		const scout = routeDestinations.scoutNodes(lines);
		(Array.isArray(rows) ? rows : []).forEach(function(row) {
			if (!row || !row.c || !row.c[0] || row.destination) return;
			const node = row.c[0];
			if (scout[node.v]) return;
			const pathHome = Array.isArray(row.pathHome) ? row.pathHome : [];
			const last = pathHome[pathHome.length - 1];
			if (last && last.path) return;	// calculated route node (show viewing / favorites)
			const id = routeDestinations.toID(node.systemID);
			if (!id || seen[id] || !routeDestinations.isKSpace(id)) return;
			seen[id] = true;
			exits.push({systemID: id, nodeID: node.v, holeName: last && last.name ? String(last.name) : ""});
		});
		return exits;
	},

	/** Node ids drawn through an EVE-Scout link: lines [child, parent, modifiers, 'ES-<id>'] -> {<child node id>: true} */
	scoutNodes: function(lines) {
		const result = {};
		(Array.isArray(lines) ? lines : []).forEach(function(line) {
			if (line && typeof line[3] === "string" && line[3].indexOf("ES-") === 0) result[line[0]] = true;
		});
		return result;
	},

	/** Every real system on the chain map (k-space and J-space), as numbers, skipping the same rows as chainExits */
	chainSystems: function(rows, lines) {
		const seen = {}, result = [];
		const scout = routeDestinations.scoutNodes(lines);
		(Array.isArray(rows) ? rows : []).forEach(function(row) {
			if (!row || !row.c || !row.c[0] || row.destination || scout[row.c[0].v]) return;
			const pathHome = Array.isArray(row.pathHome) ? row.pathHome : [];
			const last = pathHome[pathHome.length - 1];
			if (last && last.path) return;
			const id = routeDestinations.toID(row.c[0].systemID);
			if (!id || seen[id] || !appData.systems[id]) return;
			seen[id] = true;
			result.push(id);
		});
		return result;
	},

	/** Gate route from one system to another, using the user's route preferences.
	Results are cached per (from, to) by guidance (cleared when routing options change). */
	route: function(fromSystemID, toSystemID) {
		const from = routeDestinations.toID(fromSystemID), to = routeDestinations.toID(toSystemID);
		if (!from || !to) return null;
		const path = guidance.findShortestPath(routeDestinations.routeMap(), from - 30000000, to - 30000000);
		return path && path.length ? {jumps: path.length - 1, path: path} : null;
	},

	jumps: function(fromSystemID, toSystemID) {
		const r = routeDestinations.route(fromSystemID, toSystemID);
		return r ? r.jumps : null;
	},

	/** Routes from every exit to the destination, nearest first.
	best: the exit with fewest jumps (null if no exit has a gate route).
	onMap: the routes to draw - every exit within the limit, or else just the best one; none if the destination is on the chain. */
	evaluate: function(exits, destinationID, limit) {
		const id = routeDestinations.toID(destinationID);
		let routes = (exits || []).map(function(exit, index) {
			const r = routeDestinations.route(exit.systemID, id);
			return r ? {exit: exit, jumps: r.jumps, path: r.path, index: index} : null;
		}).filter(function(r) { return r; }).sort(function(a, b) { return a.jumps - b.jumps || a.index - b.index; });
		// Exits whose way home through the chain avoids EOL / critical / ... holes come first (routeHoleFilters), else the nearest anyway
		if (routeDestinations.holeFilters) { routes = routeHoleFilters.pickRoutes(routes, routeDestinations.holeFilters); }
		const best = routes[0] || null;
		const near = routes.filter(function(r) { return r.jumps <= limit; });
		// A route through Thera/Turnur (theraRoute), when it has fewer jumps than the best gate route
		const alt = typeof routeDestinations.scoutRoute === "function" && !(best && best.jumps === 0) ? routeDestinations.scoutRoute(id) : null;
		return {
			systemID: id,
			scout: alt && alt.status === "ok" && (!best || alt.total < best.jumps) ? alt : null,
			best: best,
			routes: routes,
			onMap: !best || best.jumps === 0 ? [] : (near.length ? near : [best])
		};
	},

	nodeID: function(exitNodeID, destinationID) {
		return routeDestinations.ID_PREFIX + exitNodeID + "-" + destinationID;
	},

	/** Markup for a destination node: security class, system name, jump count */
	nodeMarkup: function(id, destinationID, route) {
		const esc = routeDestinations.escape;
		const system = systemAnalysis.analyse(destinationID);
		const exitName = (appData.systems[route.exit.systemID] || {}).name || "";
		const title = system.name + ": " + route.jumps + " jump" + (route.jumps === 1 ? "" : "s") + " from " + exitName
			+ (route.exit.holeName ? " (" + route.exit.holeName + ")" : "");
		return "<div id='node" + esc(id) + "' class='node " + routeDestinations.NODE_CLASS + "'"
			+ " data-destid='" + destinationID + "' data-exitid='" + route.exit.systemID + "' title='" + esc(title) + "'>"
			+ "<h4 class='destClass'><span class='" + esc(system.systemTypeClass) + "'>" + esc(system.systemTypeName) + "</span></h4>"
			+ "<h4 class='destName'><a href='.?system=" + esc(system.name) + "'>" + esc(String(system.name).toUpperCase()) + "</a></h4>"
			+ "<h4 class='destJumps'>" + route.jumps + "</h4>"
			+ "</div>";
	},

	/** Synthetic chain rows/connections for the shown destinations.
	Rows are flagged with `destination` and have systemID 0 so nothing treats them as a real system
	(automapper's inChain, collapse, flares, activity, context menu all key on real system IDs). */
	syntheticRows: function(exits, destinations, limit) {
		const rows = [], lines = [];
		routeDestinations.sanitize(destinations).filter(function(d) { return d.show; }).forEach(function(d) {
			routeDestinations.evaluate(exits, d.systemID, limit).onMap.forEach(function(route) {
				const id = routeDestinations.nodeID(route.exit.nodeID, d.systemID);
				rows.push({
					c: [{v: id, f: routeDestinations.nodeMarkup(id, d.systemID, route), systemID: 0}, {v: route.exit.nodeID}],
					destination: {systemID: d.systemID, exitSystemID: route.exit.systemID, jumps: route.jumps}
				});
				lines.push([id, route.exit.nodeID, [routeDestinations.LINE_MODIFIER], null]);
			});
		});
		return {rows: rows, lines: lines};
	},

	/** Add destination nodes to the result of chain.nodes(). Mutates and returns it. */
	decorate: function(result, destinations, limit) {
		if (!result || !result.map || !Array.isArray(result.map.rows)) return result;
		// While Thera/Turnur routes are on, systems drawn through EVE-Scout links are routed by theraRoute (with its
		// filters), not used as exits; while off, they are exits as before
		const scoutLines = typeof routeDestinations.scoutEnabled === "function" && routeDestinations.scoutEnabled() ? result.lines : null;
		const exits = routeDestinations.chainExits(result.map.rows, scoutLines);
		routeDestinations.lastExits = exits;
		routeDestinations.holeFilters = null;
		if (typeof routeHoleFilters !== "undefined" && routeHoleFilters.contextFor) {
			const hf = routeHoleFilters.contextFor(result.lines);
			if (hf) {
				exits.forEach(function(e) { e.holes = routeHoleFilters.holesHome(result.lines, e.nodeID); });
				routeDestinations.holeFilters = routeHoleFilters.reasonTable(rally.systemConnections(result.map.rows, result.lines), hf);
			}
		}
		routeDestinations.lastChainSystems = routeDestinations.chainSystems(result.map.rows, scoutLines);
		const extra = routeDestinations.syntheticRows(exits, destinations === undefined ? routeDestinations.saved() : destinations,
			limit === undefined ? routeDestinations.routingLimit() : limit);
		if (extra.rows.length) {
			Array.prototype.push.apply(result.map.rows, extra.rows);
			result.lines = extra.lines.concat(result.lines || []);	// leaves first, like chain.nodes
		}
		return result;
	},

	// ---- Window ----

	systemLabel: function(systemID) {
		const esc = routeDestinations.escape;
		const system = systemAnalysis.analyse(systemID);
		return "<span class='" + esc(system.systemTypeClass) + "'>" + esc(system.name) + "</span>";
	},

	STRIP_WIDTH: 230,	// px of jump markers in the "Best exit from chain" column (rows are built as HTML, not measured)

	/** The route as jump markers (favouritesRouteStrip, when its "Show routes as jump markers" setting is on), or ""
	@param steps favouritesRouteStrip steps; chips: theraRoute.warpSigs (signature chips); title: tooltip of the strip */
	stripHtml: function(steps, chips, title) {
		if (typeof favouritesRouteStrip === "undefined" || !steps || !steps.length
			|| !favouritesRouteStrip.enabled(typeof options !== "undefined" ? options : null)) return "";
		const rs = favouritesRouteStrip;
		const lookup = rs.lookup || function(id) { return appData.systems[id] || null; };
		const regionName = rs.regionName || function() { return ""; };
		return "<div class='route-dest-strip'" + (title ? " title='" + routeDestinations.escape(title) + "'" : "") + ">"
			+ rs.stripHtml(steps, lookup, regionName, routeDestinations.STRIP_WIDTH, chips) + "</div>";
	},

	/** Table rows for the Destinations window */
	renderRows: function(list, exits, limit) {
		const esc = routeDestinations.escape;
		list = routeDestinations.sanitize(list);
		if (!list.length) {
			return "<tr class='route-dest-none'><td colspan='5'>No destinations yet. Add a k-space system above.</td></tr>";
		}
		return list.map(function(d) {
			const system = systemAnalysis.analyse(d.systemID);
			const ev = routeDestinations.evaluate(exits, d.systemID, limit);
			var exitCell, jumpsCell = "&ndash;";
			if (ev.scout && typeof theraRoute !== "undefined") {
				const name = function(id) { return (appData.systems[id] || {}).name || String(id); };
				const detail = theraRoute.planDetail(ev.scout, system.name, name, Date.now());
				const strip = routeDestinations.stripHtml(theraRoute.stripSteps(ev.scout, Date.now()), theraRoute.warpSigs(ev.scout, name, Date.now()), detail);
				exitCell = strip || "<span class='route-dest-scout' title='" + esc(detail) + "'><span class='route-dest-scout-text'>" + esc(theraRoute.planText(ev.scout)) + "</span> "
					+ "<span class='route-dest-scout-line'>" + esc(theraRoute.lineText(ev.scout, name)) + "</span></span>";
				jumpsCell = "<span title='" + esc(detail) + "'>" + ev.scout.total + "</span>";
			} else if (!(exits || []).length) {
				exitCell = "<span class='route-dest-muted'>No k-space exit on the chain</span>";
			} else if (!ev.best) {
				exitCell = "<span class='route-dest-muted'>No gate route</span>";
			} else if (ev.best.jumps === 0) {
				exitCell = "<span class='route-dest-muted'>On the chain</span>";
				jumpsCell = "0";
			} else {
				exitCell = routeDestinations.systemLabel(ev.best.exit.systemID)
					+ (ev.best.exit.holeName ? " <span class='route-dest-hole'>(" + esc(ev.best.exit.holeName) + ")</span>" : "")
					+ (ev.best.note ? " <span class='route-dest-warn' title='" + esc(ev.best.note) + "'>&#9888; " + esc(ev.best.note) + "</span>" : "")
					+ (typeof favouritesRouteStrip !== "undefined" ? routeDestinations.stripHtml(favouritesRouteStrip.pathSteps(ev.best.path), []) : "");
				jumpsCell = String(ev.best.jumps);
			}
			return "<tr data-systemid='" + d.systemID + "'>"
				+ "<td class='route-dest-name'><span class='route-dest-class " + esc(system.systemTypeClass) + "'>" + esc(system.systemTypeName) + "</span> "
				+ "<a href='.?system=" + esc(system.name) + "' class='" + esc(system.systemTypeClass) + "'>" + esc(system.name) + "</a></td>"
				+ "<td class='route-dest-exit'>" + exitCell + "</td>"
				+ "<td class='route-dest-jumps'>" + jumpsCell + "</td>"
				+ "<td class='route-dest-show'><label><input type='checkbox' class='route-dest-show-toggle' data-systemid='" + d.systemID + "'" + (d.show ? " checked" : "") + " /> Show</label></td>"
				+ "<td class='route-dest-remove'><a href='#' class='route-dest-remove-link' data-systemid='" + d.systemID + "' title='Remove " + esc(system.name) + "'>&#10005;</a></td>"
				+ "</tr>";
		}).join("");
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	(function() {
		const rd = routeDestinations;

		// Hook the chain map builder now (before the first draw) so every renderer gets the extra rows
		if (typeof chain !== "undefined" && chain && typeof chain.nodes === "function" && !chain.nodes.routeDestinationsWrapped) {
			const originalNodes = chain.nodes;
			chain.nodes = function() {
				const result = originalNodes.apply(this, arguments);
				try {
					rd.decorate(result);
				} catch (e) {
					console.error("Destinations: could not add destination nodes", e);
				}
				if (typeof rd.onDecorate === "function") {
					try { rd.onDecorate(); } catch (e) { console.error(e); }
				}
				return result;
			};
			chain.nodes.routeDestinationsWrapped = true;
		}

		function save(list) {
			options.routeDestinations = rd.sanitize(list);
			options.save();
			if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) {
				chain.redraw();
			} else {
				render();
			}
			updateButton();
		}

		function updateButton() {
			const anyShown = rd.saved().some(function(d) { return d.show; });
			$("#show-destinations").toggleClass("active", anyShown);
		}

		var kspaceSource = null;
		function kspaceSystems() {
			if (!kspaceSource) {
				kspaceSource = {};
				for (const id in appData.systems) {
					if (rd.isKSpace(id)) kspaceSource[id] = appData.systems[id];
				}
			}
			return kspaceSource;
		}

		function render() {
			const $dialog = $("#dialog-routeDestinations");
			if (!$dialog.length || !$dialog.hasClass("ui-dialog-content") || !$dialog.dialog("isOpen")) return;
			const list = rd.saved();
			$dialog.find(".route-dest-table tbody").html(rd.renderRows(list, rd.lastExits, rd.routingLimit()));
			$dialog.find(".route-dest-toggle-all")
				.val(rd.allShown(list) ? "Hide all" : "Show all on map")
				.prop("disabled", !list.length);
		}

		var renderTimer = null;
		rd.onDecorate = function() {
			clearTimeout(renderTimer);
			renderTimer = setTimeout(render, 0);
		};

		function addFromInput() {
			const $input = $("#routeDestinationInput");
			const value = $.trim($input.val());
			if (!value) return;
			const result = rd.add(rd.saved(), value);
			if (result.error) {
				if (typeof ValidationTooltips !== "undefined") {
					ValidationTooltips.open({target: $input}).setContent(rd.escape(result.error));
				} else {
					alert(result.error);
				}
				return;
			}
			if (typeof ValidationTooltips !== "undefined") ValidationTooltips.close();
			$input.val("");
			save(result.list);
		}

		function open() {
			const $dialog = $("#dialog-routeDestinations");
			if (!$dialog.hasClass("ui-dialog-content")) {
				$dialog.dialog({
					autoOpen: false,
					title: "Destinations",
					resizable: false,
					modal: false,
					width: 560,
					maxHeight: Math.max(300, Math.round($(window).height() * 0.8)),
					dialogClass: "dialog-noeffect ui-dialog-shadow dialog-routeDestinations",
					buttons: {
						Close: function() { $(this).dialog("close"); }
					},
					close: function() {
						if (typeof ValidationTooltips !== "undefined") ValidationTooltips.close();
					}
				});
				const $input = $("#routeDestinationInput");
				if ($.fn.inlinecomplete) {
					$input.inlinecomplete({source: kspaceSystems(), renderer: "system", maxSize: 10, delay: 0});
				}
			}
			$dialog.dialog("open");
			render();
			$("#routeDestinationInput").focus();
		}
		rd.open = open;

		$(function() {
			$("body").append(
				"<div id='dialog-routeDestinations' class='hidden'>"
				+ "<form class='route-dest-add' autocomplete='off'>"
				+ "<input type='text' id='routeDestinationInput' placeholder='Add a k-space system, e.g. Jita' /> "
				+ "<input type='submit' value='Add' /> "
				+ "<input type='button' class='route-dest-toggle-all' value='Show all on map' />"
				+ "</form>"
				+ "<table class='route-dest-table'>"
				+ "<thead><tr><th>Destination</th><th>Best exit from chain</th><th>Jumps</th><th>Map</th><th></th></tr></thead>"
				+ "<tbody></tbody></table>"
				+ "<p class='route-dest-note'>Jumps are gate jumps from the nearest k-space system on the current chain map, using your "
				+ "K-space route selection (Settings &gt; Routes &amp; Navigation). Holes to unidentified systems (e.g. just \"Low-Sec\") can't be routed. "
				+ "On the map, a destination is attached to every exit within the \"Show Route as Blobs\" limit, or else to the nearest one. "
				+ "A route through Thera or Turnur (EVE-Scout's connections) is shown instead when it has fewer jumps, gates plus the two holes "
				+ "(Settings &gt; Routes &amp; Navigation &gt; Routes through). Its gate jumps keep strictly to your K-space route selection: "
				+ "Prefer HS only goes through high-sec, Avoid NS / Avoid HS never through null-sec / high-sec.</p>"
				+ "</div>"
			);

			$("#dialog-routeDestinations .route-dest-add").on("submit", function(e) {
				e.preventDefault();
				addFromInput();
			});
			$("#dialog-routeDestinations").on("click", ".route-dest-toggle-all", function(e) {
				e.preventDefault();
				const list = rd.saved();
				save(rd.setAllShow(list, !rd.allShown(list)));
			});
			$("#dialog-routeDestinations").on("change", ".route-dest-show-toggle", function() {
				save(rd.setShow(rd.saved(), $(this).data("systemid"), this.checked));
			});
			$("#dialog-routeDestinations").on("click", ".route-dest-remove-link", function(e) {
				e.preventDefault();
				save(rd.remove(rd.saved(), $(this).data("systemid")));
			});

			// Chain map toolbar button
			if (!$("#show-destinations").length) {
				const $button = $("<i id='show-destinations' data-icon='pin' data-tooltip='Destinations: jumps from the chain to your saved systems'></i>");
				if ($("#show-favorite").length) {
					$("#show-favorite").after($button).after(" ");
				} else {
					$("#chainWidget .controls #newTab").after($button);
				}
				if (typeof Tooltips !== "undefined" && Tooltips.attach) Tooltips.attach($button);
				$button.on("click", function(e) {
					e.preventDefault();
					open();
				});
			}
			updateButton();

			// Settings > Routes & Navigation row: a button that opens the Destinations window (no value of its own)
			forkSettings.register({
				section: "routes", order: 40, id: "routeDestinationsEdit", type: "custom", label: "Destinations:",
				html: "<input type='button' id='routeDestinationsEdit' value='Edit' />"
			});
			$(document).on("click", "#routeDestinationsEdit", function(e) {
				e.preventDefault();
				open();
			});

			// Double-clicking a destination node must not collapse anything (it's not a real system)
			const chainMap = document.getElementById("chainMap");
			if (chainMap) {
				chainMap.addEventListener("dblclick", function(e) {
					if (e.target && e.target.closest && e.target.closest("." + rd.NODE_CLASS)) {
						e.stopPropagation();
					}
				}, true);
			}
		});
	})();
}
