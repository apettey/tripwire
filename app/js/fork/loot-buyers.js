const lootBuyers = {
	// "Nearest loot buyers" in the Destinations window (fork-owned file): the NPC stations that buy blue loot (Sleeper
	// components) and, optionally, red loot (Triglavian Survey Database), nearest first by gate jumps from the chain's
	// k-space exits, with "Set route in game". The station list is the static file public/loot-buyers/stations.json,
	// built by tools/fork/build-loot-buyers.mjs; no third-party call at runtime.
	// Saved per user in options.lootBuyers = {enabled (default on), red (default off)}.
	// Keep `const lootBuyers` on the first line: the test helper strips it to define a global.
	DATA_URL: "loot-buyers/stations.json",
	COUNT: 3,             // buyers shown
	MAX_SEARCH_JUMPS: 60, // the routing search stops here, as skyhooksPanel.MAX_SEARCH_JUMPS

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** The user's settings with defaults: on, red loot off (a missing key means the default) */
	settings: function(saved) {
		const s = saved && typeof saved === "object" ? saved : {};
		return { enabled: s.enabled !== false, red: s.red === true };
	},

	/** Whether the generated file has the shape the code relies on */
	valid: function(data) {
		return !!data && Array.isArray(data.blue) && Array.isArray(data.red)
			&& data.blue.concat(data.red).every(function(s) { return Array.isArray(s) && s.length >= 4 && s[0] > 0 && s[1] > 0; });
	},

	/** The buyer stations as [{stationID, systemID, corpID, name, kind}], kind "blue" or "red" (red only when asked for) */
	stations: function(data, red) {
		if (!lootBuyers.valid(data)) { return []; }
		const make = function(kind) { return function(s) { return { stationID: s[0], systemID: s[1], corpID: s[2], name: s[3], kind: kind }; }; };
		return data.blue.map(make("blue")).concat(red ? data.red.map(make("red")) : []);
	},

	/** The blue-loot buyer systems as guidance wants them (systemID - 30000000), sorted, once each */
	blueSystems: function(data) {
		if (!lootBuyers.valid(data)) { return []; }
		const seen = {};
		return data.blue.map(function(s) { return Number(s[1]) - 30000000; }).filter(function(id) { return id > 0 && !seen[id] && (seen[id] = true); })
			.sort(function(a, b) { return a - b; });
	},

	/** The chain exits to search from: when routeHoleFilters is judging the holes (holeFilters = the table
	routeDestinations.holeFilters), exits whose way home avoids the filtered holes, or else all of them (the same rule
	as Destinations). exits: [{systemID, holes?, ...}] -> [systemID] */
	usableExits: function(exits, holeFilters) {
		let list = (exits || []).map(function(exit, index) { return { exit: exit, jumps: 0, index: index }; });
		if (holeFilters && typeof routeHoleFilters !== "undefined" && routeHoleFilters.pickRoutes) { list = routeHoleFilters.pickRoutes(list, holeFilters); }
		const seen = {};
		return list.map(function(r) { return Number(r.exit.systemID); }).filter(function(id) { return id > 0 && !seen[id] && (seen[id] = true); });
	},

	/** The nearest buyers: one row per system (its first station; `more` = other buyer stations there), fewest jumps first
	@param dist {<systemID>: {jumps, exitID}} from skyhooksPanel.distances @param systemFor (id) => system or null */
	nearest: function(data, red, dist, systemFor, count) {
		const bySystem = {};
		lootBuyers.stations(data, red).forEach(function(s) {
			const d = dist ? dist[s.systemID] : null;
			if (!d) { return; }
			const system = systemFor ? systemFor(s.systemID) : null;
			const row = bySystem[s.systemID] = bySystem[s.systemID] || { systemID: s.systemID, jumps: d.jumps, exitID: d.exitID, security: system ? Number(system.security) : NaN, stations: [] };
			// A station can buy both (Secure Commerce Commission): one entry with both kinds
			const same = row.stations.filter(function(o) { return o.stationID === s.stationID; })[0];
			if (same) { same.kinds.push(s.kind); } else { row.stations.push(Object.assign({}, s, { kinds: [s.kind] })); }
		});
		const kindOrder = function(s) { return s.kinds[0] === "blue" ? 0 : 1; };
		return Object.keys(bySystem).map(function(id) {
			const row = bySystem[id];
			row.stations.sort(function(a, b) { return kindOrder(a) - kindOrder(b) || a.stationID - b.stationID; });
			const first = row.stations[0];
			return { systemID: row.systemID, jumps: row.jumps, exitID: row.exitID, security: row.security, stationID: first.stationID, name: first.name, corpID: first.corpID,
				kinds: first.kinds, more: row.stations.length - 1 };
		}).sort(function(a, b) { return a.jumps - b.jumps || a.systemID - b.systemID; }).slice(0, count === undefined ? lootBuyers.COUNT : count);
	},

	/** "3 jumps" / "1 jump" / "this system" */
	jumpsText: function(jumps) {
		return jumps === 0 ? "this system" : jumps + (jumps === 1 ? " jump" : " jumps");
	},

	securityText: function(security) {
		return isFinite(security) ? (Math.round(security * 10) / 10 || 0).toFixed(1) : "";
	},

	/** HTML of one buyer row. exitName: the exit it is measured from; sysHtml: the coloured system name */
	rowHtml: function(row, exitName, sysHtml, corpName, routable) {
		const esc = lootBuyers.escape;
		const kinds = row.kinds.map(function(k) { return "<span class='loot-kind loot-kind-" + k + "'>" + (k === "blue" ? "Blue" : "Red") + "</span>"; }).join(" ");
		return "<li class='loot-row' data-systemid='" + esc(row.systemID) + "' data-stationid='" + esc(row.stationID) + "' data-exitid='" + esc(row.exitID) + "'>"
			+ "<span class='loot-sys'>" + sysHtml + " <span class='loot-sec'>" + esc(lootBuyers.securityText(row.security)) + "</span></span>"
			+ "<span class='loot-station' title='" + esc(row.name + (corpName ? " (" + corpName + ")" : "")) + "'>" + esc(row.name) + (row.more > 0 ? " <span class='loot-more'>+" + row.more + " more here</span>" : "") + "</span>"
			+ "<span class='loot-kinds'>" + kinds + "</span>"
			+ "<span class='loot-jumps' title='Gate jumps from " + esc(exitName) + "'>" + lootBuyers.jumpsText(row.jumps) + "</span>"
			+ (routable ? "<i class='loot-route' data-icon='auto' title='Set destination in game: " + esc(row.name) + " as your in-game destination (gate route from " + esc(exitName) + ")'></i>" : "<i class='loot-route-none'></i>")
			+ "</li>";
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	(function() {
		const lb = lootBuyers;
		let data = null, loading = false, failed = false;
		let cache = { key: null, value: null };

		function opts() { return lb.settings(typeof options !== "undefined" && options ? options.lootBuyers : null); }
		function save(patch) {
			options.lootBuyers = Object.assign({}, options.lootBuyers || {}, patch);
			options.save();
		}
		function systemFor(id) { return (typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(id) : null) || appData.systems[id] || null; }

		function load() {
			if (data || loading) { return; }
			loading = true;
			$.ajax({ url: lb.DATA_URL, dataType: "json", cache: true }).done(function(d) {
				if (lb.valid(d)) { data = d; failed = false; applyToSystemPanel(); } else { failed = true; }
			}).fail(function() { failed = true; }).always(function() { loading = false; render(); });
		}

		/** Upstream's system panel line "Blue loot buyer: Nj from X" reads guidance_profiles.blueLootSystems, a hard-coded list
		that is a bit stale; use our list (no upstream edit) once it is loaded */
		function applyToSystemPanel() {
			if (typeof guidance_profiles === "undefined" || !opts().enabled) { return; }
			const systems = lb.blueSystems(data);
			if (!systems.length) { return; }
			guidance_profiles.blueLootSystems = systems;
			try {
				if (typeof guidance !== "undefined" && typeof guidance.clearCache === "function") { guidance.clearCache(); }
				if (typeof systemPanel !== "undefined" && typeof viewingSystemID !== "undefined" && viewingSystemID) { systemPanel.update(); }
			} catch (e) { /* the line refreshes with the next system view */ }
		}

		/** Distances from the usable exits, kept while the exits, route preferences and gate map stay the same */
		function distances(exitIDs) {
			// Intentional dependency: the skyhook panel's multi-source search (same costs and cut-off as guidance) is reused, not copied.
			// Its file (skyhooks-panel.js) loads after ours, which is fine: it is only used when the window renders.
			if (typeof skyhooksPanel === "undefined" || typeof skyhooksPanel.distances !== "function") { throw new Error("skyhooksPanel is not loaded"); }
			const map = routeDestinations.routeMap();
			const c = (typeof options !== "undefined" && options && options.chain) || {}, r = c.routeIgnore || {};
			const key = exitIDs.join(",") + "|" + (c.routeSecurity || "") + "|" + (r.enabled ? (r.systems || []).join(",") : "");
			if (cache.key !== key || cache.map !== map) {
				const mods = (typeof guidance !== "undefined" && guidance.jumpCostModifiers) || [];
				const costFn = function(from, to, mapCost) {
					const base = mapCost + skyhooksPanel.entryPenalty(typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(30000000 + to) : null, c);
					return mods.reduce(function(cost, m) { return cost > 0 ? m(from, to, cost) : cost; }, base) > 0 ? base : 0;
				};
				cache = { key: key, map: map, value: skyhooksPanel.distances(map, exitIDs, lb.MAX_SEARCH_JUMPS, costFn) };
			}
			return cache.value;
		}
		// Gate changes (faction warfare) reach the map through guidance.clearCache: forget the search then too
		if (typeof guidance !== "undefined" && typeof guidance.clearCache === "function" && !guidance.clearCache.lootBuyersWrapped) {
			const clear = guidance.clearCache;
			guidance.clearCache = function() { cache = { key: null, value: null }; return clear.apply(this, arguments); };
			guidance.clearCache.lootBuyersWrapped = true;
		}

		function render() {
			const $d = $("#dialog-routeDestinations");
			const $box = $d.find(".loot-buyers");
			if (!$box.length || !$d.hasClass("ui-dialog-content") || !$d.dialog("isOpen")) { return; }
			const s = opts();
			$box.toggleClass("hidden", !s.enabled);
			if (!s.enabled) { return; }
			$box.find(".loot-red").prop("checked", s.red);
			const $list = $box.find(".loot-list");
			const note = function(text) { $list.html("<li class='loot-note'>" + lb.escape(text) + "</li>"); };
			if (!data) { load(); note(failed ? "The loot buyer list could not be loaded." : "Loading..."); return; }
			const exitIDs = lb.usableExits(routeDestinations.lastExits, routeDestinations.holeFilters);
			if (!exitIDs.length) { note("No k-space exit on the chain map to route from."); return; }
			let rows;
			try {
				rows = lb.nearest(data, s.red, distances(exitIDs), systemFor, lb.COUNT);
			} catch (err) {
				console.error("Loot buyers: search failed", err);
				note("Loot buyer search unavailable.");
				return;
			}
			if (!rows.length) { note("No loot buyer reachable by gates from the chain's exits."); return; }
			const name = function(id) { return (appData.systems[id] || {}).name || id; };
			const canRoute = typeof autopilotRoute !== "undefined" && typeof autopilotRoute.push === "function";
			$list.html(rows.map(function(r) {
				return lb.rowHtml(r, name(r.exitID), routeDestinations.systemLabel(r.systemID), data.corps ? data.corps[r.corpID] : "", canRoute && r.jumps > 0);
			}).join(""));
		}

		// Redraw with the Destinations window (after each chain map build, and when it opens)
		function install() {
			if (typeof routeDestinations === "undefined" || routeDestinations.lootBuyersWrapped) { return; }
			const previous = routeDestinations.onDecorate;
			routeDestinations.onDecorate = function() {
				if (typeof previous === "function") { previous.apply(this, arguments); }
				clearTimeout(install.timer);
				install.timer = setTimeout(render, 0);
			};
			routeDestinations.lootBuyersWrapped = true;
		}

		// This file loads before route-destinations.js (alphabetical): wait until that file's ready handler has built the window
		$(function() { setTimeout(init, 0); });
		function init() {
			install();
			if (opts().enabled) { load(); }   // also corrects the system panel's blue loot line
			const $d = $("#dialog-routeDestinations");
			if ($d.length && !$d.find(".loot-buyers").length) {
				$d.find(".route-dest-note").before(
					"<div class='loot-buyers'>"
					+ "<div class='loot-head'><b>Nearest loot buyers</b> "
					+ "<label class='loot-red-label' title='Also list the NPC stations that buy red loot (Triglavian Survey Database)'><input type='checkbox' class='loot-red' /> Red loot</label></div>"
					+ "<ul class='loot-list'></ul>"
					+ "<p class='loot-foot'>Blue loot: Sleeper components, bought by NPC stations of 12 corporations. Red loot: Triglavian Survey Database, bought at CONCORD, DED and Secure Commerce Commission stations. "
					+ "Gate jumps from the nearest k-space exit of the chain, keeping to your K-space route selection and hole filters.</p>"
					+ "</div>");
			}
			$d.on("dialogopen", function() { render(); });
			$d.on("change", ".loot-red", function() { save({ red: this.checked }); render(); });
			$d.on("click", ".loot-route", function(e) {
				e.preventDefault();
				const $row = $(this).closest(".loot-row");
				const from = Number($row.data("exitid")), to = Number($row.data("systemid"));
				const route = routeDestinations.route(from, to);
				if (!route) { return; }
				const name = function(id) { return (appData.systems[id] || {}).name || id; };
				autopilotRoute.push(route.path, name(from) + " → " + name(to) + " (loot buyer)");
			});

			// Settings > Routes & Navigation: takes effect on Save; Reset deletes options.lootBuyers (back to on / red loot off)
			forkSettings.register({
				section: "routes", order: 41, id: "lootBuyers-enabled", type: "checkbox", key: "lootBuyers",
				label: "Loot buyers:", text: "Show the nearest blue-loot buyers in the Destinations window",
				get: function() { return opts().enabled; },
				set: function(o, on) { o.lootBuyers = Object.assign({}, o.lootBuyers || {}, { enabled: on }); }
			});
			forkSettings.register({
				section: "routes", order: 42, id: "lootBuyers-red", type: "checkbox",
				label: "Red loot:", text: "Also list the buyers of red loot (Triglavian Survey Database)",
				get: function() { return opts().red; },
				set: function(o, on) { o.lootBuyers = Object.assign({}, o.lootBuyers || {}, { red: on }); },
				reset: function(o) { if (o.lootBuyers) { delete o.lootBuyers.red; } }
			});
			if (typeof options !== "undefined" && options.apply && !options.apply.lootBuyersWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					try { if (data) { applyToSystemPanel(); } else if (opts().enabled) { load(); } render(); } catch (err) { console.error("Loot buyers: apply failed", err); }
					return result;
				};
				options.apply.lootBuyersWrapped = true;
			}
		}
	})();
}
