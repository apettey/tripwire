const skyhooksPanel = {
	// Raidable skyhooks box (fork-owned), opened like the Jump planner: low-sec / null-sec systems on the chain map get a
	// small skyhook icon (and clicking such a system's name opens it too, when that is on). It opens a movable box,
	// "Raidable skyhooks near <system>", listing the skyhooks whose theft window is open or opens soon within a number of
	// gate jumps of THAT system, with a close button. The list comes from public/skyhooks.php, which keeps one
	// server-wide copy of ESI's /skyhooks/raidable (the browser never calls ESI: that route allows 30 requests per
	// 15 minutes per IP). Jumps use guidance's costs (the user's route security preference and avoid list). Saved per user in
	// options.skyhooksPanel = {enabled (the icon), clickOpen, maxJumps, low, null, window, soonHours, sort, position}; a
	// missing key means the default (icon on, opens on click, 10 jumps, low-sec and null-sec, opens within 2 h, by jumps).
	// Also {lava, ice} (planet filter; both on) and sort "value": planet type, name and yield come from the static
	// public/skyhooks-data/planets.json (SDE), see planetInfo.
	// Keep `const skyhooksPanel` on the first line: the test helper strips it to define a global.
	WIDGET_ID: "skyhooksWidget",
	URL: "skyhooks.php",
	REFRESH_MS: 5 * 60 * 1000,
	NEAR_TTL_MS: 5 * 60 * 1000,   // how long a routing search is kept
	TICK_MS: 5000,
	REDRAW_MS: 30000,
	DEFAULT_SIZE: { x: 12, y: 8 },
	MIN_SIZE: { x: 5, y: 3 },
	DEFAULTS: { enabled: true, clickOpen: true, maxJumps: 10, low: true, null: true, lava: true, ice: true, window: "soon", soonHours: 2, sort: "jumps" },
	MAX_JUMPS_CHOICES: [3, 5, 10, 15, 20, 30],
	MAX_SEARCH_JUMPS: 60,       // "any distance" still stops here
	WINDOWS: ["now", "soon", "all"],
	SOON_HOURS_CHOICES: [1, 2, 4, 8, 24],
	SORTS: ["jumps", "start", "value"],
	PLANETS_URL: "skyhooks-data/planets.json",

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	// ---- Settings (pure) ----

	/** The effective settings from options.skyhooksPanel: every value valid, missing ones at their default.
	maxJumps 0 means "any distance". */
	settings: function(saved) {
		const d = skyhooksPanel.DEFAULTS;
		const s = saved && typeof saved === "object" ? saved : {};
		const maxJumps = Number(s.maxJumps);
		const soonHours = Number(s.soonHours);
		return {
			enabled: s.enabled !== false,
			clickOpen: s.clickOpen !== false,
			maxJumps: s.maxJumps !== undefined && s.maxJumps !== null && s.maxJumps !== "" && Number.isInteger(maxJumps) && maxJumps >= 0 && maxJumps <= 200 ? maxJumps : d.maxJumps,
			low: s.low !== false,
			null: s.null !== false,
			lava: s.lava !== false,
			ice: s.ice !== false,
			window: skyhooksPanel.WINDOWS.indexOf(s.window) >= 0 ? s.window : d.window,
			soonHours: isFinite(soonHours) && soonHours > 0 && soonHours <= 168 ? soonHours : d.soonHours,
			sort: skyhooksPanel.SORTS.indexOf(s.sort) >= 0 ? s.sort : d.sort
		};
	},

	// ---- Time (pure; seconds since the epoch) ----

	/** "1h12m", "34m", "<1m" */
	duration: function(seconds) {
		const s = Math.max(0, Math.floor(Number(seconds) || 0));
		const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
		if (h > 0) { return h + "h" + (m < 10 ? "0" : "") + m + "m"; }
		return m > 0 ? m + "m" : "<1m";
	},

	/** {state: "open"|"soon"|"closed", opensIn, leftIn} (seconds, 0 when not applicable) */
	status: function(start, end, now) {
		if (now >= end) { return { state: "closed", opensIn: 0, leftIn: 0 }; }
		if (now >= start) { return { state: "open", opensIn: 0, leftIn: end - now }; }
		return { state: "soon", opensIn: start - now, leftIn: 0 };
	},

	/** "open now, 1h12m left" / "opens in 34m" / "closed" */
	countdown: function(start, end, now) {
		const st = skyhooksPanel.status(start, end, now);
		if (st.state === "open") { return "open now, " + skyhooksPanel.duration(st.leftIn) + " left"; }
		if (st.state === "soon") { return "opens in " + skyhooksPanel.duration(st.opensIn); }
		return "closed";
	},

	/** "14:06–16:06" in EVE time (UTC); with the date ("Oct 12 14:06–16:06") when it isn't today's */
	windowText: function(start, end, now) {
		const pad = function(n) { return (n < 10 ? "0" : "") + n; };
		const hm = function(t) { const d = new Date(t * 1000); return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); };
		const a = new Date(start * 1000), n = new Date(now * 1000);
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const sameDay = a.getUTCFullYear() === n.getUTCFullYear() && a.getUTCMonth() === n.getUTCMonth() && a.getUTCDate() === n.getUTCDate();
		return (sameDay ? "" : months[a.getUTCMonth()] + " " + a.getUTCDate() + " ") + hm(start) + "–" + hm(end);
	},

	// ---- Rows, filter, sort (pure) ----

	/** "high" | "low" | "null" from the system's security (as the app shows it: >= 0.45 is high-sec); null if unknown */
	securityClass: function(system) {
		if (!system) { return null; }
		const security = system.baseSecurity !== undefined ? system.baseSecurity : system.security;
		if (security === undefined || security === null || security === "" || !isFinite(Number(security))) { return null; }
		const value = Number(security);
		return value >= 0.45 ? "high" : value > 0 ? "low" : "null";
	},

	/** Whether a row passes the security checkboxes. High-sec (not expected in the data) is shown rather than hidden. */
	securityPasses: function(system, settings) {
		const cls = skyhooksPanel.securityClass(system);
		if (cls === "low") { return settings.low; }
		if (cls === "null") { return settings.null; }
		return true;
	},

	/** Whether a window passes the window filter ("now" = open now, "soon" = open now or opening within soonHours, "all") */
	windowPasses: function(start, end, now, settings) {
		const st = skyhooksPanel.status(start, end, now);
		if (st.state === "closed") { return false; }
		if (settings.window === "now") { return st.state === "open"; }
		if (settings.window === "soon") { return st.state === "open" || st.opensIn <= settings.soonHours * 3600; }
		return true;
	},

	// ---- Planet: lava / ice / other, and what a raid is worth (pure) ----
	// Data: public/skyhooks-data/planets.json, generated from CCP's SDE (tools/fork/build-skyhook-planets.mjs):
	// {reagents: {1: {name, price}, 2: ...}, planets: {planetID: [kind (1 lava, 2 ice), reagent units per hour, planet number]}}.
	// A planet that isn't in the file produces no reagents (power / workforce planets), so there's nothing to steal.

	/** "IV" for 4 (1 to 3999); "" for anything else */
	roman: function(n) {
		n = Math.floor(Number(n));
		if (!(n >= 1 && n <= 3999)) { return ""; }
		const map = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
		let out = "";
		map.forEach(function(m) { while (n >= m[0]) { out += m[1]; n -= m[0]; } });
		return out;
	},

	/** {kind: "lava"|"ice"|"unknown", name (system + roman number, "" when unknown), number (the roman number), reagent, perHour, isk} for a planet;
	isk = estimated ISK per hour of all the reagent the planet produces (half of it ends up in the raidable surplus bay).
	A planet the list doesn't know (or no list yet) is "unknown": never hidden by the Planet filter.
	@param planets the parsed planets.json (null while it isn't loaded) */
	planetInfo: function(planets, planetID, systemName) {
		if (!planets || typeof planets !== "object" || !planets.planets) { return { kind: "unknown", name: "", number: "", reagent: "", perHour: 0, isk: 0, cuts: null }; }
		const p = planets.planets[planetID];
		const reagent = p && planets.reagents ? planets.reagents[p[0]] : null;
		if (!p || !reagent || (p[0] !== 1 && p[0] !== 2)) { return { kind: "unknown", name: "", number: "", reagent: "", perHour: 0, isk: 0, cuts: null }; }
		const perHour = Number(p[1]) || 0;
		const numeral = skyhooksPanel.roman(p[2]);
		return {
			kind: p[0] === 1 ? "lava" : "ice",
			name: systemName && numeral ? systemName + " " + numeral : "",
			number: numeral,
			reagent: String(reagent.name || ""),
			perHour: perHour,
			isk: perHour * (Number(reagent.price) || 0),
			cuts: Array.isArray(planets.lavaCuts) ? planets.lavaCuts : null
		};
	},

	/** Value rating 1-5 of a planetInfo() result, 0 = none: ice = 1; lava = 2-5 by quartile of the raidable ISK/h (half of
	isk) of ALL lava planets, using the 3 cut points the generator stores in planets.json (`lavaCuts`, raidable ISK/h), so
	it doesn't depend on which skyhooks are live; an unknown planet, or lava without cut points, has no rating. */
	valueRating: function(planet) {
		if (!planet) { return 0; }
		if (planet.kind === "ice") { return 1; }
		if (planet.kind !== "lava") { return 0; }
		const cuts = planet.cuts;
		if (!Array.isArray(cuts) || cuts.length !== 3 || !cuts.every(function(c) { return isFinite(Number(c)); })) { return 0; }
		const raidable = planet.isk / 2;
		return 2 + cuts.filter(function(c) { return raidable >= Number(c); }).length;
	},

	/** "$$$$" with the unearned ones of 5 dimmed; fixed width. "" for no rating. */
	ratingHtml: function(rating) {
		const n = Math.max(0, Math.min(5, Math.floor(Number(rating) || 0)));
		if (!n) { return ""; }
		return "<b class='sky-dollar-on'>" + new Array(n + 1).join("$") + "</b><b class='sky-dollar-off'>" + new Array(6 - n).join("$") + "</b>";
	},

	/** Whether a planet kind passes the lava / ice checkboxes (an unknown planet: always) */
	planetPasses: function(kind, settings) {
		if (kind === "lava") { return settings.lava; }
		if (kind === "ice") { return settings.ice; }
		return true;
	},

	/** "2.2M", "540k", "950" */
	formatIsk: function(n) {
		n = Number(n) || 0;
		if (n >= 1e9) { return (Math.round(n / 1e8) / 10) + "B"; }
		if (n >= 1e6) { return (Math.round(n / 1e5) / 10) + "M"; }
		if (n >= 1e3) { return Math.round(n / 1e3) + "k"; }
		return String(Math.round(n));
	},

	/** Cheap filters (no routing): security, window and planet kind. Returns the skyhooks that pass.
	@param skyhooks [{planetID, systemID, start, end}]; systemFor(id) the system's static data; planets: see planetInfo (optional) */
	prefilter: function(skyhooks, systemFor, now, settings, planets) {
		return (Array.isArray(skyhooks) ? skyhooks : []).filter(function(s) {
			return s && skyhooksPanel.windowPasses(s.start, s.end, now, settings) && skyhooksPanel.securityPasses(systemFor(s.systemID), settings)
				&& skyhooksPanel.planetPasses(skyhooksPanel.planetInfo(planets, s.planetID).kind, settings);
		});
	},

	/** Extra cost of entering a system under the user's route preferences: the same rules as guidance's private
	adjustCostForOptions (100 for an avoided system, Zarzakh, or the wrong security for the route security option).
	@param system systemAnalysis.analyse() result (or null) @param chainOptions options.chain */
	entryPenalty: function(system, chainOptions) {
		if (!system) { return 0; }
		const o = chainOptions || {};
		let cost = 0;
		const ignore = o.routeIgnore;
		if (ignore && ignore.enabled && Array.isArray(ignore.systems) && ignore.systems.indexOf(system.name) >= 0) { cost += 100; }
		if (system.name === "Zarzakh") { cost += 100; }
		switch (o.routeSecurity) {
			case "highsec": return cost + (system.security < 0.45 ? 100 : 0);
			case "avoid-high": return cost + (system.security >= 0.45 ? 100 : 0);
			case "avoid-null": return cost + (system.security <= 0.0 ? 100 : 0);
			default: return cost;
		}
	},

	/** One search from all chain exits at once (multi-source Dijkstra over the gate map, the same costs and cut-off as
	guidance.findShortestPath with a limit): for every system reached, the gate jumps from the nearest exit.
	@param map gate adjacency keyed by systemID - 30000000 (appData.map.shortest); values are the neighbours
	@param exitIDs real system IDs
	@param limit guidance's cost limit: systems are not expanded from a cost of `limit` on
	@param costFn (fromKey, toKey, base) => cost of the hop, <= 0 when closed; base is guidance's 1 + the map's cost
	(keys are offset IDs). The caller adds the entry penalty, as guidance does.
	@return {<real systemID>: {jumps, exitID}} (exits themselves: 0 jumps) */
	distances: function(map, exitIDs, limit, costFn) {
		const OFFSET = 30000000;
		const cost = {}, hops = {}, source = {};
		const open = {};   // cost -> [keys]
		let pending = 0;
		const add = function(c, key) { (open[c] = open[c] || []).push(key); pending++; };
		(exitIDs || []).forEach(function(id) {
			const key = Number(id) - OFFSET;
			if (!map || !map[key] || cost[key] !== undefined) { return; }
			cost[key] = 0; hops[key] = 0; source[key] = Number(id);
			add(0, key);
		});
		while (pending > 0) {
			const c = Math.min.apply(null, Object.keys(open).map(Number));
			const node = open[c].shift();
			pending--;
			if (!open[c].length) { delete open[c]; }
			if (c > cost[node] || c >= limit) { continue; }   // outdated entry, or past the limit
			const next = map[node] || {};
			for (const k in next) {
				if (next[k] === undefined) { continue; }
				const to = Number(k);
				const step = costFn(node, to, 1 + (Number(next[k]) || 0));
				if (!(step > 0)) { continue; }
				const total = c + step;
				if (cost[to] === undefined || total < cost[to]) {
					cost[to] = total; hops[to] = hops[node] + 1; source[to] = source[node];
					add(total, to);
				}
			}
		}
		const result = {};
		for (const key in cost) { result[Number(key) + OFFSET] = { jumps: hops[key], exitID: source[key] }; }
		return result;
	},

	/** The rows to show: [{skyhook, nearest: {exit: {systemID}, jumps}}] within maxJumps (0 = any), sorted
	@param nearestFn (systemID) => {jumps, exitID} or null/undefined (see distances) */
	rows: function(skyhooks, systemFor, nearestFn, now, settings, planets) {
		const limit = settings.maxJumps > 0 ? settings.maxJumps : skyhooksPanel.MAX_SEARCH_JUMPS;
		const rows = skyhooksPanel.prefilter(skyhooks, systemFor, now, settings, planets).map(function(s) {
			const n = nearestFn(s.systemID);
			const sys = systemFor(s.systemID) || {};
			return { skyhook: s, planet: skyhooksPanel.planetInfo(planets, s.planetID, sys.name), nearest: n ? { exit: { systemID: n.exitID }, jumps: n.jumps } : null };
		}).filter(function(r) { return r.nearest && r.nearest.jumps <= limit; });
		return skyhooksPanel.sort(rows, settings.sort);
	},

	/** Where to put the widget when there's no saved position: right of the existing widgets, from row 1, if that fits
	in the window; otherwise below them, at the left (as the Favourites panel does).
	widgets: [{col, row, size_x, size_y}]; availableCols: grid columns that fit in the window (optional) */
	defaultPlacement: function(widgets, availableCols) {
		let maxCol = 0, maxRow = 0;
		(widgets || []).forEach(function(w) {
			if (!w) { return; }
			maxCol = Math.max(maxCol, (Number(w.col) || 1) + (Number(w.size_x) || 1) - 1);
			maxRow = Math.max(maxRow, (Number(w.row) || 1) + (Number(w.size_y) || 1) - 1);
		});
		const size = skyhooksPanel.DEFAULT_SIZE;
		if (availableCols && maxCol && maxCol + size.x > availableCols) {
			return { col: 1, row: maxRow + 1, size_x: size.x, size_y: size.y };
		}
		return { col: maxCol + 1, row: 1, size_x: size.x, size_y: size.y };
	},

	/** Sorted copy: "jumps" (then window start), "start" (then jumps) or "value" (estimated ISK per hour, highest first, then jumps) */
	sort: function(rows, by) {
		const jumps = function(r) { return r.nearest ? r.nearest.jumps : Infinity; };
		const isk = function(r) { return r.planet ? r.planet.isk : 0; };
		return rows.slice().sort(function(a, b) {
			if (by === "value") { return isk(b) - isk(a) || jumps(a) - jumps(b) || a.skyhook.start - b.skyhook.start || a.skyhook.systemID - b.skyhook.systemID; }
			if (by === "start") { return a.skyhook.start - b.skyhook.start || jumps(a) - jumps(b) || a.skyhook.systemID - b.skyhook.systemID; }
			return jumps(a) - jumps(b) || a.skyhook.start - b.skyhook.start || a.skyhook.systemID - b.skyhook.systemID;
		});
	},

	// ---- Chain map icon (pure) ----

	/** A low-sec / null-sec k-space system that gets the icon (not high-sec, W-space, Pochven, Zarzakh, unknown) */
	isLowNull: function(systemID, system) {
		if (!systemID || !system || system.class || (Number(system.regionID) || 0) >= 11000000 || system.factionID == 500026 || system.name === "Zarzakh") { return false; }
		const cls = skyhooksPanel.securityClass(system);
		return cls === "low" || cls === "null";
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

	iconHtml: function(systemID, name) {
		return "<span class='sky-icon' data-sky-system='" + (parseInt(systemID, 10) || 0) + "' title='"
			+ skyhooksPanel.escape("Raidable skyhooks near " + (name || "this system")) + "'>"
			+ "<svg width='10' height='10' viewBox='0 0 10 10' aria-hidden='true'><circle cx='5' cy='2.2' r='1.4' fill='none' stroke='currentColor' stroke-width='1.2'></circle>"
			+ "<path d='M5 3.6 V9 M2 6.2 Q5 10 8 6.2' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linecap='round'></path></svg></span>";
	},

	/** Insert the icon into a chain node's HTML (before its icon row, like the Jump planner's ring) */
	insertIcon: function(nodeHtml, icon) {
		if (!icon || typeof nodeHtml !== "string" || nodeHtml.indexOf("sky-icon") >= 0) { return nodeHtml; }
		const at = nodeHtml.indexOf("<div class='nodeIcons'>");
		return at < 0 ? nodeHtml : nodeHtml.substring(0, at) + icon + nodeHtml.substring(at);
	},

	/** Add the icon to every low-sec / null-sec system of chain.nodes() output, in place. Returns the system IDs that got it. */
	decorate: function(result, systems) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		const ids = [];
		rows.forEach(function(row) {
			if (skyhooksPanel.isExtraRow(row)) { return; }
			const node = row.c[0];
			const id = parseInt(node.systemID, 10);
			const system = systems ? systems[id] : null;
			if (!skyhooksPanel.isLowNull(id, system) || typeof node.f !== "string") { return; }
			node.f = skyhooksPanel.insertIcon(node.f, skyhooksPanel.iconHtml(id, system.name));
			if (ids.indexOf(id) < 0) { ids.push(id); }
		});
		return ids;
	},

	/** Text for an empty list: {kind, text}. `count` is the number of skyhooks the server knows, `exits` the chain's exits. */
	emptyState: function(count, exits, settings, unavailable) {
		if (unavailable) { return { kind: "unavailable", text: "Skyhook data unavailable." }; }
		if (!count) { return { kind: "none", text: "No raidable skyhooks right now." }; }
		if (!exits || !exits.length) { return { kind: "noexits", text: "No k-space exit on your chain yet: jumps are counted from the chain's k-space systems." }; }
		return { kind: "filtered", text: "No raidable skyhook matches your options (" + (settings.maxJumps > 0 ? "within " + settings.maxJumps + " jumps" : "any distance") + (!settings.lava || !settings.ice ? ", " + (!settings.lava && !settings.ice ? "no planet type" : settings.lava ? "lava only" : "ice only") + " (Planet filter)" : "") + "). Widen them above." };
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && typeof forkSettings !== "undefined") {
	(function() {
		const sp = skyhooksPanel;
		let planets = null;       // public/skyhooks-data/planets.json once loaded
		let planetsLoading = false;
		let planetsFailed = false;
		let data = null;          // last answer of skyhooks.php: {skyhooks, fetched, stale, error}
		let loadError = null;     // text when the last request failed
		let skew = 0;             // server time - browser time, seconds
		let loading = false;
		let origin = null;        // the system the box is open for
		let lastRender = 0;

		function opts() { return sp.settings(options.skyhooksPanel); }
		function isOn() { return opts().enabled; }
		function now() { return Date.now() / 1000 + skew; }
		function systemFor(id) { return (typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(id) : null) || appData.systems[id] || null; }
		function systems() { return (typeof tripwire !== "undefined" && tripwire && tripwire.systems) || appData.systems; }
		function redrawChain() { if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); } }
		// One search from the box's system per (system, limit, route preferences, gate map), kept until one of them changes.
		// The route itself is only worked out when "Set route in game" is clicked.
		let nearCache = { key: null, map: null, value: null, at: 0 };
		// Gate changes (faction warfare) reach the map through guidance.clearCache: forget the search then too, and after 5 min
		if (typeof guidance !== "undefined" && typeof guidance.clearCache === "function" && !guidance.clearCache.skyhooksWrapped) {
			const clear = guidance.clearCache;
			guidance.clearCache = function() { nearCache = { key: null, map: null, value: null, at: 0 }; return clear.apply(this, arguments); };
			guidance.clearCache.skyhooksWrapped = true;
		}
		function prefsKey() {
			const c = options.chain || {}, r = c.routeIgnore || {};
			return (c.routeSecurity || "") + "|" + (r.enabled ? (r.systems || []).join(",") : "");
		}
		function nearest(limit) {
			const map = routeDestinations.routeMap();
			const key = origin + "|" + limit + "|" + prefsKey();
			if (nearCache.key !== key || nearCache.map !== map || Date.now() - nearCache.at > sp.NEAR_TTL_MS) {
				const mods = (typeof guidance !== "undefined" && guidance.jumpCostModifiers) || [];
				const costFn = function(from, to, mapCost) {
					const base = mapCost + sp.entryPenalty(typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(30000000 + to) : null, options.chain);
					return mods.reduce(function(c, m) { return c > 0 ? m(from, to, c) : c; }, base) > 0 ? base : 0;
				};
				nearCache = { key: key, map: map, value: sp.distances(map, [origin], limit, costFn), at: Date.now() };
			}
			return nearCache.value;
		}
		function save(patch) {
			options.skyhooksPanel = Object.assign({}, options.skyhooksPanel || {}, patch);
			options.save();
		}

		// ---- Data ----

		/** The static planet list (lava / ice, reagent per hour): once; on failure the rows just have no planet details */
		function loadPlanets() {
			if (planets || planetsLoading) { return; }
			planetsLoading = true;
			$.ajax({ url: sp.PLANETS_URL, dataType: "json", cache: true }).done(function(d) {
				if (d && d.planets && typeof d.planets === "object") { planets = d; planetsFailed = false; } else { planetsFailed = true; }
			}).fail(function() {
				planetsFailed = true;
			}).always(function() {
				planetsLoading = false;
				render();
			});
		}

		function load() {
			if (loading || !isOn() || !$("#" + sp.WIDGET_ID).length) { return; }
			loading = true;
			loadPlanets();
			$.ajax({ url: sp.URL, dataType: "json", cache: false }).done(function(d) {
				if (!d || !Array.isArray(d.skyhooks)) { loadError = "Unexpected answer from the server."; return; }
				data = d;
				loadError = null;
				if (d.now) { skew = d.now - Date.now() / 1000; }
			}).fail(function(xhr) {
				loadError = xhr && xhr.status === 403 ? "Not signed in." : "Could not load the skyhook list.";
			}).always(function() {
				loading = false;
				render();
			});
		}

		// ---- Widget ----

		function selectHtml(cls, choices, value) {
			return "<select class='" + cls + "'>" + choices.map(function(c) {
				return "<option value='" + sp.escape(c[0]) + "'" + (String(c[0]) === String(value) ? " selected" : "") + ">" + sp.escape(c[1]) + "</option>";
			}).join("") + "</select>";
		}

		function optionsHtml(s) {
			const jumpChoices = sp.MAX_JUMPS_CHOICES.map(function(n) { return [n, n + " jumps"]; }).concat([[0, "Any distance"]]);
			const windowChoices = [["now", "Vulnerable now"], ["soon", "Opens within..."], ["all", "All windows"]];
			return "<div class='sky-options'>"
				+ "<label title='Gate jumps from this system'>Within " + selectHtml("sky-max", jumpChoices, s.maxJumps) + "</label>"
				+ "<label><input type='checkbox' class='sky-low'" + (s.low ? " checked" : "") + " /> Low-sec</label>"
				+ "<label><input type='checkbox' class='sky-null'" + (s.null ? " checked" : "") + " /> Null-sec</label>"
				+ "<span class='sky-planets' title='Lava planets give Magmatic Gas, ice planets Superionic Ice'>Planet:"
				+ " <label><input type='checkbox' class='sky-lava'" + (s.lava ? " checked" : "") + " /> Lava</label>"
				+ " <label><input type='checkbox' class='sky-ice'" + (s.ice ? " checked" : "") + " /> Ice</label>"
				+ "</span>"
				+ "<label>Window " + selectHtml("sky-window", windowChoices, s.window)
				+ (s.window === "soon" ? " " + selectHtml("sky-hours", sp.SOON_HOURS_CHOICES.map(function(h) { return [h, h + " h"]; }), s.soonHours) : "") + "</label>"
				+ "<label>Sort " + selectHtml("sky-sort", [["jumps", "Jumps"], ["start", "Window start"], ["value", "Value"]], s.sort) + "</label>"
				+ "</div>";
		}

		function widgetHtml() {
			return "<li id='" + sp.WIDGET_ID + "' class='gridWidget'>"
				+ "<div class='controls'><span class='sky-title'><i data-icon='anchor'></i> <span class='sky-title-text'>Raidable skyhooks</span> <span class='sky-count'></span></span>"
				+ "<i class='sky-close' data-icon='times' title='Close the Raidable skyhooks box'></i>"
				+ "<span class='sky-time' title='Times are EVE time (UTC)'>EVE time</span></div>"
				+ "<div class='content'><div class='sky-opts'></div><div class='sky-status'></div><ul class='sky-list'></ul></div>"
				+ "</li>";
		}

		function rowHtml(r, t) {
			const esc = sp.escape;
			const sys = systemFor(r.skyhook.systemID) || {};
			const regions = (typeof appData !== "undefined" && appData.regions) || {};
			const region = (regions[sys.regionID] || {}).name || "";
			const st = sp.status(r.skyhook.start, r.skyhook.end, t);
			const sec = sp.securityClass(sys);
			const originName = (systemFor(origin) || {}).name || origin;
			const secText = isFinite(Number(sys.security)) ? (Math.round(Number(sys.security) * 10) / 10 || 0).toFixed(1) : "";
			const pl = r.planet || { kind: "unknown" };
			const planetName = pl.number;	// the system's name is in the first column already; the full name is the tooltip
			const badge = pl.kind === "lava" || pl.kind === "ice"
				? "<span class='sky-planet sky-planet-" + pl.kind + "' title='" + esc((pl.kind === "lava" ? "Lava" : "Ice") + " planet: " + pl.reagent + ", " + pl.perHour.toLocaleString("en-US") + " units/hour. About half of it sits in the raidable surplus bay.") + "'>" + (pl.kind === "lava" ? "Lava" : "Ice") + "</span>"
				: "";
			const rating = sp.valueRating(pl);
			const value = rating > 0
				? "<span class='sky-value' aria-label='Value " + rating + " of 5' title='" + esc("Value " + rating + "/5 \u2014 ~" + sp.formatIsk(pl.isk / 2) + " ISK/h raidable (estimate: CCP average price, SDE yield). " + pl.reagent + ": " + pl.perHour.toLocaleString("en-US") + " units/hour at about " + sp.formatIsk(pl.isk / pl.perHour) + " ISK each; the whole planet makes about " + sp.formatIsk(pl.isk) + " ISK/h and half of it goes to the raidable surplus bay.") + "'>" + sp.ratingHtml(rating) + "</span>"
				: "<span class='sky-value'></span>";
			return "<li class='sky-row sky-" + st.state + "' data-systemid='" + esc(r.skyhook.systemID) + "' data-planet='" + esc(r.skyhook.planetID) + "'>"
				+ "<span class='sky-system'><a class='" + esc(sys.systemTypeClass) + "' href='.?system=" + esc(encodeURIComponent(sys.name)) + "' title='View " + esc(sys.name) + "'>" + esc(sys.name || r.skyhook.systemID) + "</a>"
				+ " <span class='sky-sec sky-sec-" + esc(sec) + "'>" + esc(secText) + "</span></span>"
				+ "<span class='sky-planetcell'" + (pl.name ? " title='" + esc("Planet " + pl.name) + "'" : "") + ">" + badge + (planetName ? " <span class='sky-planetname'>" + esc(planetName) + "</span>" : "") + "</span>"
				+ value
				+ "<span class='sky-region' title='" + esc(region) + "'>" + esc(region) + "</span>"
				+ "<span class='sky-exit' title='Gate jumps from " + esc(originName) + "'>" + (r.nearest.jumps === 0 ? "this system" : r.nearest.jumps + (r.nearest.jumps === 1 ? " jump" : " jumps")) + "</span>"
				+ "<span class='sky-window' title='" + esc(sp.windowText(r.skyhook.start, r.skyhook.end, t)) + " EVE time'>" + esc(sp.windowText(r.skyhook.start, r.skyhook.end, t)) + "</span>"
				+ "<span class='sky-countdown'>" + esc(sp.countdown(r.skyhook.start, r.skyhook.end, t)) + "</span>"
				+ (r.nearest.jumps > 0 && typeof autopilotRoute !== "undefined" && typeof autopilotRoute.push === "function"
					? "<i class='sky-route' data-icon='auto' title='Set route in game: gate route from " + esc(originName) + " to " + esc(sys.name) + " as autopilot waypoints'></i>" : "<i class='sky-route-none'></i>")
				+ "</li>";
		}

		function render() {
			lastRender = Date.now();
			const $w = $("#" + sp.WIDGET_ID);
			if (!$w.length) { return; }
			const s = opts();
			const $opts = $w.find(".sky-opts");
			if (!$opts.find(".sky-options").length || $opts.data("rendered") !== JSON.stringify(s)) {
				// Don't rebuild a control while it is being used
				if (!$opts.find(":focus").length) { $opts.html(optionsHtml(s)).data("rendered", JSON.stringify(s)); }
			}
			const $status = $w.find(".sky-status"), $list = $w.find(".sky-list");
			$w.find(".sky-title-text").text("Raidable skyhooks near " + ((systemFor(origin) || {}).name || ""));
			if (!data) {
				$list.empty();
				$w.find(".sky-count").text("");
				$status.text(loadError || "Loading...").toggleClass("sky-error", !!loadError);
				return;
			}
			const t = now();
			let rows = [];
			try {
				const near = nearest(s.maxJumps > 0 ? s.maxJumps : sp.MAX_SEARCH_JUMPS);
				rows = sp.rows(data.skyhooks, systemFor, function(id) { return near[id]; }, t, s, planets);
			} catch (err) { console.error("Skyhooks panel: routing failed", err); }
			$w.find(".sky-count").text(rows.length ? "(" + rows.length + ")" : "");
			const notes = [];
			if (loadError) { notes.push(loadError + " Showing the last list."); }
			else if (data.error && data.stale && !data.unavailable) { notes.push("ESI is not answering: this list is from " + sp.duration(t - data.fetched) + " ago."); }
			else if (data.unavailable && data.error) { notes.push(data.error); }
			if (planetsFailed && !planets) { notes.push("Planet details (lava / ice, value) could not be loaded."); }
			if (!rows.length) { const empty = sp.emptyState(data.skyhooks.length, [{}], s, data.unavailable); notes.push(empty.text); }
			$status.html(notes.map(sp.escape).join("<br/>")).toggleClass("sky-error", !!(loadError || data.unavailable || (data.error && data.stale)));
			$list.html(rows.map(function(r) { return rowHtml(r, t); }).join(""));
		}

		// ---- Layout ----

		function gridApi() { return typeof grid !== "undefined" && grid && typeof grid.add_widget === "function" ? grid : null; }

		/** Grid columns that fit in the window (widget_base_dimensions + margins), as the Favourites panel does */
		function availableCols(api) {
			const o = api.options || {};
			const step = ((o.widget_base_dimensions || [50])[0]) + 2 * ((o.widget_margins || [5])[0]);
			const zoom = parseFloat($("body").css("zoom")) || 1;	// Settings > UI Scale
			return Math.floor((window.innerWidth || $(window).width()) / zoom / step);
		}

		/** The saved position, else right of the existing widgets (below them when that doesn't fit) */
		function placement(api) {
			const fp = typeof favouritesPanel !== "undefined" ? favouritesPanel : null;
			const saved = (fp && fp.gridEntry(options.grid, sp.WIDGET_ID)) || (options.skyhooksPanel && options.skyhooksPanel.position) || null;
			if (saved && Number(saved.col) >= 1 && Number(saved.row) >= 1) {
				return { col: Number(saved.col), row: Number(saved.row), size_x: Math.max(sp.MIN_SIZE.x, Number(saved.size_x) || 0), size_y: Math.max(sp.MIN_SIZE.y, Number(saved.size_y) || 0) };
			}
			return sp.defaultPlacement(api.serialize(), availableCols(api));
		}

		function addWidget() {
			const api = gridApi();
			if (!api) { return; }
			const $existing = $("#" + sp.WIDGET_ID);
			if ($existing.length) {
				if (api.$widgets.is($existing)) { return; }
				$existing.stop(true, true).remove();
			}
			const p = placement(api);
			const $widget = api.add_widget(widgetHtml(), p.size_x, p.size_y, p.col, p.row, null, [sp.MIN_SIZE.x, sp.MIN_SIZE.y]);
			$widget.stop(true, true);
			$widget.find(".grid-resize").attr("data-icon", "resize").toggleClass("hidden", !$("#layout").hasClass("active"));
		}

		function removeWidget() {
			const api = gridApi();
			const $widget = $("#" + sp.WIDGET_ID);
			if (!api || !$widget.length) { return; }
			// Remember where it was, so opening it again puts it back there
			const entry = typeof favouritesPanel !== "undefined" ? favouritesPanel.gridEntry(api.serialize($widget), sp.WIDGET_ID) : null;
			if (entry) {
				options.skyhooksPanel = Object.assign({}, options.skyhooksPanel || {}, { position: { col: entry.col, row: entry.row, size_x: entry.size_x, size_y: entry.size_y } });
				options.save();
			}
			$widget.attr("id", sp.WIDGET_ID + "-removed");
			api.remove_widget($widget, true);
			$widget.stop(true, true);
		}

		/** Open the box for a system (switches it when already open) */
		function open(systemID) {
			const id = parseInt(systemID, 10);
			if (!isOn() || !id) { return; }
			origin = id;
			const wasOpen = !!$("#" + sp.WIDGET_ID).length;
			addWidget();
			const $w = $("#" + sp.WIDGET_ID);
			if ($w.length && !wasOpen && $w[0].scrollIntoView) { setTimeout(function() { $w[0].scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 50); }
			render();
			load();
		}

		function close() {
			removeWidget();
			origin = null;
		}

		/** Settings turned the icon off (Save, Reset): the box goes, and the chain is redrawn without the icons */
		let lastOn = null;
		function applySettings() {
			const on = isOn();
			if (!on) { close(); }
			if (lastOn !== null && on !== lastOn) { redrawChain(); }	// only when the icons appear or go
			lastOn = on;
		}

		// ---- Chain map hook: the icon on low-sec / null-sec systems ----

		let hooked = false;	// other features wrap chain.nodes after us (not always keeping our flag): wrap once
		function installHook() {
			if (hooked || typeof chain === "undefined" || !chain || typeof chain.nodes !== "function" || chain.nodes.skyhooksPanelWrapped) { return; }
			hooked = true;
			const previous = chain.nodes;
			const wrapped = function() {
				const result = previous.apply(this, arguments);
				try { if (isOn()) { sp.decorate(result, systems()); } } catch (e) { console.warn("Skyhooks: could not decorate the chain", e); }
				return result;
			};
			Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
			wrapped.skyhooksPanelWrapped = true;
			chain.nodes = wrapped;
		}

		// ---- Settings > Routes & Navigation ----

		function setupSettings() {
			// Take effect on Save; Reset deletes options.skyhooksPanel (back to the defaults)
			forkSettings.register({
				section: "routes", order: 62, id: "skyhooksPanel-enabled", type: "checkbox", key: "skyhooksPanel",
				label: "Skyhook icon:", text: "Show a skyhook icon on low-sec and null-sec systems on the chain map",
				get: function() { return isOn(); },
				set: function(o, on) { o.skyhooksPanel = Object.assign({}, o.skyhooksPanel || {}, { enabled: on }); }
			});
			forkSettings.register({
				section: "routes", order: 63, id: "skyhooksPanel-click", type: "checkbox",
				label: "Raidable skyhooks:", text: "Also open it when I click a low-sec or null-sec system's name",
				get: function() { return opts().clickOpen; },
				set: function(o, on) { o.skyhooksPanel = Object.assign({}, o.skyhooksPanel || {}, { clickOpen: on }); },
				reset: function(o) { if (o.skyhooksPanel) { delete o.skyhooksPanel.clickOpen; } }
			});
			forkSettings.register({
				section: "routes", order: 64, id: "skyhooksPanel-maxJumps", type: "select",
				label: "Skyhooks within:",
				choices: sp.MAX_JUMPS_CHOICES.map(function(n) { return [String(n), n + " jumps"]; }).concat([["0", "Any distance"]]),
				get: function() { return String(opts().maxJumps); },
				set: function(o, v) { o.skyhooksPanel = Object.assign({}, o.skyhooksPanel || {}, { maxJumps: Number(v) }); },
				reset: function(o) { if (o.skyhooksPanel) { delete o.skyhooksPanel.maxJumps; } }
			});
			if (!options.apply.skyhooksPanelWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					try { applySettings(); } catch (err) { console.error("Skyhooks: apply failed", err); }
					return result;
				};
				options.apply.skyhooksPanelWrapped = true;
			}
		}

		$(function() {
			installHook();
			setupSettings();
			lastOn = isOn();
			if (typeof forkCommands !== "undefined") {	// command palette (Ctrl+K)
				forkCommands.register({
					id: "skyhooks.open", title: "Open Skyhooks", group: "Routes", icon: "anchor", keywords: ["skyhook", "planet", "sov", "low-sec", "null-sec", "exit"],
					enabled: function() { return isOn() ? true : "The Skyhooks panel is switched off in Settings"; },
					args: [{ name: "exit", label: "exit", type: "chainSystem", default: function(ctx) { return ctx.viewingSystemID; },
						filter: function(id) { const s = appData.systems[id]; return !!s && !s.class; } }],
					run: function(args) { open(args.exit); }
				});
				forkCommands.panelToggle({ id: "panel.skyhooks", title: "Toggle Skyhooks panel", key: "skyhooksPanel", icon: "anchor", keywords: ["skyhook"] });
			}

			const sel = "#" + sp.WIDGET_ID;
			const $doc = $(document);
			// The icon: open the box for that system (and don't let the click reach the node)
			$doc.on("click", "#chainMap .sky-icon", function(e) {
				e.preventDefault();
				e.stopPropagation();
				open($(this).attr("data-sky-system"));
			});
			$doc.on("mousedown", "#chainMap .sky-icon", function(e) { e.stopPropagation(); });
			// Clicking a low-sec / null-sec system's name (which also views it, upstream) opens it when that is on
			// Capture phase: viewing the system redraws the chain, which would detach the link before a delegated handler ran.
			document.addEventListener("click", function(e) {
				const link = e.target && e.target.closest ? e.target.closest("#chainMap .nodeSystem a") : null;
				if (!link || !isOn() || !opts().clickOpen) { return; }
				const id = $(link).closest("[data-nodeid]").find(".sky-icon").first().attr("data-sky-system");
				if (id) { open(id); }
			}, true);
			$doc.on("click", sel + " .sky-close", function(e) { e.preventDefault(); close(); });
			$doc.on("change", sel + " .sky-max", function() { save({ maxJumps: Number($(this).val()) }); render(); });
			$doc.on("change", sel + " .sky-low", function() { save({ low: this.checked }); render(); });
			$doc.on("change", sel + " .sky-null", function() { save({ null: this.checked }); render(); });
			$doc.on("change", sel + " .sky-lava", function() { save({ lava: this.checked }); render(); });
			$doc.on("change", sel + " .sky-ice", function() { save({ ice: this.checked }); render(); });
			$doc.on("change", sel + " .sky-window", function() { save({ window: $(this).val() }); render(); });
			$doc.on("change", sel + " .sky-hours", function() { save({ soonHours: Number($(this).val()) }); render(); });
			$doc.on("change", sel + " .sky-sort", function() { save({ sort: $(this).val() }); render(); });
			$doc.on("click", sel + " .sky-route", function(e) {
				e.preventDefault();
				const to = Number($(this).closest(".sky-row").data("systemid"));
				const route = origin ? routeDestinations.route(origin, to) : null;
				if (!route) { return; }
				const name = function(id) { return (systemFor(id) || {}).name || id; };
				autopilotRoute.push(route.path, name(origin) + " \u2192 " + name(to) + " (skyhook)");
			});

			// The list comes from our server every 5 minutes while the box is open; countdowns redraw every 30 s
			setInterval(function() { if ($(sel).length) { load(); } }, sp.REFRESH_MS);
			setInterval(function() {
				if ($(sel).length && Date.now() - lastRender >= sp.REDRAW_MS) { render(); }
			}, sp.TICK_MS);
		});
	})();
}
