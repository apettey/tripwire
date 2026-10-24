const skyhooksPanel = {
	// Raidable skyhooks (fork-owned): the data and the pure logic behind the region map's Skyhooks overlay (region-map-view.js,
	// region-map-skyhooks.js) and the staging scan's skyhook tag. Low-sec / null-sec systems on the chain map get a small
	// skyhook icon; clicking it (or, when that is on, the system's name) opens the region map on that system with Skyhooks on.
	// (Until 2026-10-13 this opened a floating "Raidable skyhooks" box; it was retired in favour of the region map.)
	// The list comes from public/skyhooks.php, which keeps one server-wide copy of ESI's /skyhooks/raidable (the browser
	// never calls ESI: that route allows 30 requests per 15 minutes per IP); `skyhooksPanel.store` is the one loader every
	// user of the data shares (every 5 minutes at most, only while something shows skyhooks). Saved per user in
	// options.skyhooksPanel = {enabled (the icon), nameClick, low, null, lava, ice, window, soonHours, sort}; a missing key means
	// the default (icon on, name click off, low-sec and null-sec, lava and ice, opens within 2 h, by jumps).
	// Planet type, name and yield come from the static public/skyhooks-data/planets.json (SDE), see planetInfo.
	// Keep `const skyhooksPanel` on the first line: the test helper strips it to define a global.
	URL: "skyhooks.php",
	REFRESH_MS: 5 * 60 * 1000,
	RETRY_MS: 60 * 1000,          // after a failed request
	NEAR_TTL_MS: 5 * 60 * 1000,   // how long a routing search is kept
	DEFAULTS: { enabled: true, nameClick: false, low: true, null: true, lava: true, ice: true, window: "soon", soonHours: 2, sort: "jumps" },
	MAX_SEARCH_JUMPS: 60,       // jump counts stop here
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

	/** The effective settings from options.skyhooksPanel: every value valid, missing ones at their default */
	settings: function(saved) {
		const d = skyhooksPanel.DEFAULTS;
		const s = saved && typeof saved === "object" ? saved : {};
		const soonHours = Number(s.soonHours);
		return {
			enabled: s.enabled !== false,
			nameClick: s.nameClick === true,	// was clickOpen until 2026-10-23: old saved values are ignored, so it starts off
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

	/** Sorted copy of rows [{skyhook: {start, systemID}, nearest: {jumps} or null, planet: {isk}}]: "jumps" (then window start),
	"start" (then jumps) or "value" (estimated ISK per hour, highest first, then jumps) */
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
			+ skyhooksPanel.escape("Raidable skyhooks: open the region map on " + (name || "this system")) + "'>"
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
	}
};


if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined") {
	(function() {
		const sp = skyhooksPanel;

		function opts() { return sp.settings(typeof options !== "undefined" ? options.skyhooksPanel : null); }
		function isOn() { return opts().enabled; }
		function systemFor(id) { return (typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(id) : null) || appData.systems[id] || null; }
		function systems() { return (typeof tripwire !== "undefined" && tripwire && tripwire.systems) || appData.systems; }
		function redrawChain() { if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); } }

		// ---- The shared loader: skyhooks.php (every 5 minutes at most) and planets.json (once) ----

		const store = {
			data: null,			// last answer of skyhooks.php: {skyhooks, fetched, stale, unavailable, error}
			planets: null,		// planets.json once loaded
			error: null,		// text when the last request failed
			planetsFailed: false,
			loading: false, planetsLoading: false, loadedAt: 0, failedAt: 0, skew: 0, listeners: []
		};

		function changed() {
			store.listeners.forEach(function(fn) { try { fn(); } catch (e) { console.error("Skyhooks: listener failed", e); } });
		}

		function loadPlanets() {
			if (store.planets || store.planetsLoading || store.planetsFailed) { return; }
			store.planetsLoading = true;
			$.ajax({ url: sp.PLANETS_URL, dataType: "json", cache: true }).done(function(d) {
				if (d && d.planets && typeof d.planets === "object") { store.planets = d; } else { store.planetsFailed = true; }
			}).fail(function() { store.planetsFailed = true; }).always(function() { store.planetsLoading = false; changed(); });
		}

		/** Load the list when it is older than 5 minutes (after a failure: a minute later). Users call it on every paint. */
		function ensure() {
			loadPlanets();
			const now = Date.now();
			if (store.loading || now - store.loadedAt < sp.REFRESH_MS || now - store.failedAt < sp.RETRY_MS) { return; }
			store.loading = true;
			$.ajax({ url: sp.URL, dataType: "json", cache: false }).done(function(d) {
				if (!d || !Array.isArray(d.skyhooks)) { store.error = "Unexpected answer from the server."; store.failedAt = Date.now(); return; }
				store.data = d;
				store.error = null;
				store.loadedAt = Date.now();
				if (d.now) { store.skew = d.now - Date.now() / 1000; }
			}).fail(function(xhr) {
				store.error = xhr && xhr.status === 403 ? "Not signed in." : "Could not load the skyhook list.";
				store.failedAt = Date.now();
			}).always(function() { store.loading = false; changed(); });
		}

		// Jumps from a set of systems (you, or the chain's exits) to every system: one multi-source search with guidance's
		// costs (the user's route security preference and avoid list), kept per (origins, preferences, gate map) for 5 min
		let nearCache = { key: null, map: null, value: null, at: 0 };
		if (typeof guidance !== "undefined" && typeof guidance.clearCache === "function" && !guidance.clearCache.skyhooksWrapped) {
			const clear = guidance.clearCache;
			guidance.clearCache = function() { nearCache = { key: null, map: null, value: null, at: 0 }; return clear.apply(this, arguments); };
			guidance.clearCache.skyhooksWrapped = true;
		}
		function prefsKey() {
			const c = options.chain || {}, r = c.routeIgnore || {};
			return (c.routeSecurity || "") + "|" + (r.enabled ? (r.systems || []).join(",") : "");
		}
		function jumpsFrom(originIDs) {
			const ids = (originIDs || []).map(Number).filter(Boolean).sort();
			if (!ids.length) { return {}; }
			const map = typeof routeDestinations !== "undefined" && routeDestinations.routeMap ? routeDestinations.routeMap() : ((tripwire.map && tripwire.map.shortest) || appData.map.shortest);
			const key = ids.join(",") + "|" + prefsKey();
			if (nearCache.key !== key || nearCache.map !== map || Date.now() - nearCache.at > sp.NEAR_TTL_MS) {
				const mods = (typeof guidance !== "undefined" && guidance.jumpCostModifiers) || [];
				const costFn = function(from, to, mapCost) {
					const base = mapCost + sp.entryPenalty(typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(30000000 + to) : null, options.chain);
					return mods.reduce(function(c, m) { return c > 0 ? m(from, to, c) : c; }, base) > 0 ? base : 0;
				};
				nearCache = { key: key, map: map, value: sp.distances(map, ids, sp.MAX_SEARCH_JUMPS, costFn), at: Date.now() };
			}
			return nearCache.value;
		}

		sp.store = {
			/** The current state (and a refresh when the list is old): {data, planets, error, planetsFailed, loading} */
			get: function() {
				ensure();
				return { data: store.data, planets: store.planets, error: store.error, planetsFailed: store.planetsFailed, loading: store.loading };
			},
			/** Server time, seconds */
			now: function() { return Date.now() / 1000 + store.skew; },
			/** fn() runs whenever new data (or an error) arrives */
			onChange: function(fn) { if (typeof fn === "function") { store.listeners.push(fn); } },
			jumpsFrom: jumpsFrom,
			systemFor: systemFor
		};

		// ---- Opening the region map ----

		function openMap(systemID) {
			const id = parseInt(systemID, 10);
			if (!id) { return; }
			if (typeof regionMap === "undefined" || typeof regionMap.openSkyhooks !== "function") { console.warn("Skyhooks: the region map is not loaded"); return; }
			regionMap.openSkyhooks(id);
		}

		// ---- The retired box: drop its saved layout entry and position ----

		function cleanOptions() {
			try {
				if (typeof regionMapSkyhooks !== "undefined" && typeof options !== "undefined") { regionMapSkyhooks.cleanOptions(options); }
			} catch (e) { console.error("Skyhooks: could not clean the old box's options", e); }
		}

		/** Settings turned the icon off or on (Save, Reset): the chain is redrawn with or without the icons */
		let lastOn = null;
		function applySettings() {
			const on = isOn();
			if (lastOn !== null && on !== lastOn) { redrawChain(); }
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
			if (typeof forkSettings === "undefined") { return; }
			// Take effect on Save; Reset deletes options.skyhooksPanel (back to the defaults, filters included)
			forkSettings.register({
				section: "routes", order: 62, id: "skyhooksPanel-enabled", type: "checkbox", key: "skyhooksPanel",
				label: "Skyhook icon:", text: "Show a skyhook icon on low-sec and null-sec systems on the chain map",
				hint: "Clicking it opens the region map on that system with the Skyhooks overlay on.",
				get: function() { return isOn(); },
				set: function(o, on) { o.skyhooksPanel = Object.assign({}, o.skyhooksPanel || {}, { enabled: on }); }
			});
			forkSettings.register({
				section: "routes", order: 63, id: "skyhooksPanel-click", type: "checkbox",
				label: "Raidable skyhooks:", text: "Also open the region map when I click a low-sec or null-sec system's name",
				get: function() { return opts().nameClick; },
				set: function(o, on) { o.skyhooksPanel = Object.assign({}, o.skyhooksPanel || {}, { nameClick: on }); },
				reset: function(o) { if (o.skyhooksPanel) { delete o.skyhooksPanel.nameClick; } }
			});
		}

		cleanOptions();
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.skyhooksPanelWrapped) {
			// options.apply() puts back the page-load copy of the layout (localStorage): drop the old box's entry again
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				cleanOptions();
				try { applySettings(); } catch (err) { console.error("Skyhooks: apply failed", err); }
				return result;
			};
			options.apply.skyhooksPanelWrapped = true;
		}

		$(function() {
			installHook();
			setupSettings();
			cleanOptions();
			lastOn = isOn();
			if (typeof forkCommands !== "undefined") {	// command palette (Ctrl+K)
				forkCommands.register({
					id: "skyhooks.map", title: "Skyhooks", group: "Routes", icon: "anchor",
					keywords: ["skyhook", "raid", "planet", "sov", "low-sec", "null-sec", "region map"],
					args: [{ name: "system", label: "system", type: "system",
						default: function(ctx) { return sp.isLowNull(ctx.viewingSystemID, appData.systems[ctx.viewingSystemID]) ? ctx.viewingSystemID : undefined; } }],
					run: function(args) {
						const s = appData.systems[args.system];
						if (!s || s.class || (Number(s.regionID) || 0) >= 11000000) { throw new Error("Pick a k-space system"); }
						openMap(args.system);
					}
				});
				forkCommands.panelToggle({ id: "panel.skyhooks", title: "Toggle skyhook icon", key: "skyhooksPanel", icon: "anchor", keywords: ["skyhook", "icon", "chain map"] });
			}

			const $doc = $(document);
			// The icon: open the region map on that system (and don't let the click reach the node)
			$doc.on("click", "#chainMap .sky-icon", function(e) {
				e.preventDefault();
				e.stopPropagation();
				if (typeof forkUsage !== "undefined") { forkUsage.track("skyhooks", "opened"); }
				openMap($(this).attr("data-sky-system"));
			});
			$doc.on("mousedown", "#chainMap .sky-icon", function(e) { e.stopPropagation(); });
			// Clicking a low-sec / null-sec system's name (which also views it, upstream) opens the map when that is on.
			// Capture phase: viewing the system redraws the chain, which would detach the link before a delegated handler ran.
			document.addEventListener("click", function(e) {
				const link = e.target && e.target.closest ? e.target.closest("#chainMap .nodeSystem a") : null;
				if (!link || !isOn() || !opts().nameClick) { return; }
				const id = $(link).closest("[data-nodeid]").find(".sky-icon").first().attr("data-sky-system");
				if (id) { setTimeout(function() { openMap(id); }, 0); }
			}, true);
		});
	})();
}
