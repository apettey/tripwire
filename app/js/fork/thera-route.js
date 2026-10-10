const theraRoute = {
	// Routes through Thera and Turnur for the Favourites panel and the Destinations window (fork-owned file).
	// EVE-Scout's public Thera/Turnur connections (the data upstream's map supplier already fetches through
	// cached_third_party.php) become optional wormhole edges next to the k-space gates and the chain's wormholes.
	// Filters are saved per user in options.theraRoute = {thera, turnur, shipSize, minHours}; a missing key means
	// the default (both hubs on, any ship size, skip EOL holes).
	// Keep `const theraRoute` on the first line: the test helper strips it to define a global.
	HUBS: { 31000005: "Thera", 30002086: "Turnur" },
	THERA: 31000005,
	TURNUR: 30002086,
	// EVE-Scout's max_ship_size values mapped to the fork's size classes (sizeTags.classes)
	SIZES: { small: "S", medium: "M", large: "L", xlarge: "VL", capital: "XL" },
	SIZE_ORDER: ["S", "M", "L", "VL", "XL"],
	SHIP_LABELS: { S: "Frigate / destroyer", M: "Cruiser / battlecruiser", L: "Battleship", VL: "Freighter", XL: "Capital" },
	LIFE_CHOICES: [0, 1, 2, 4],
	EOL_HOURS: 4,
	DEFAULTS: { thera: true, turnur: true, shipSize: "S", minHours: 4 },
	REFRESH_MS: 300000,     // the server caches EVE-Scout's list for 5 minutes (cached_third_party.php)

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Real New Eden / J-space system ID as a number, or null */
	toID: function(systemID) {
		if (systemID === null || systemID === undefined || systemID === "" || typeof systemID === "boolean") { return null; }
		if (typeof systemID === "string" && !/^\s*\d+\s*$/.test(systemID)) { return null; }
		const n = Number(systemID);
		return Number.isInteger(n) && n >= 30000000 && n < 32000000 ? n : null;
	},

	// ---- Settings (pure) ----

	/** Filters from user options, defaults filled in. Never mutates opts. */
	settings: function(opts) {
		const raw = opts && opts.theraRoute && typeof opts.theraRoute === "object" ? opts.theraRoute : {};
		const d = theraRoute.DEFAULTS;
		const hours = Number(raw.minHours);
		return {
			thera: raw.thera !== false,
			turnur: raw.turnur !== false,
			shipSize: theraRoute.SIZE_ORDER.indexOf(raw.shipSize) >= 0 ? raw.shipSize : d.shipSize,
			minHours: raw.minHours !== undefined && raw.minHours !== null && theraRoute.LIFE_CHOICES.indexOf(hours) >= 0 ? hours : d.minHours
		};
	},

	/** Whether any hub is switched on */
	anyHub: function(settings) {
		return !!settings && (settings.thera || settings.turnur);
	},

	// ---- EVE-Scout links (pure) ----

	/** The hub (Thera or Turnur) a link belongs to: EVE-Scout's out_system is the hub, in_system the other end */
	hubOf: function(link) {
		const out = link ? theraRoute.toID(link.out_system_id) : null;
		return out && theraRoute.HUBS[out] ? out : null;
	},

	/** Size class ('S'...'XL') of a link's max_ship_size, or null if unknown */
	linkSize: function(link) {
		return link && link.max_ship_size ? theraRoute.SIZES[String(link.max_ship_size).toLowerCase()] || null : null;
	},

	/** Whether a ship of the given size class fits through the link. Unknown hole sizes only pass the smallest ships. */
	fits: function(link, shipSize) {
		const size = theraRoute.linkSize(link);
		const ship = theraRoute.SIZE_ORDER.indexOf(shipSize);
		if (ship <= 0) { return true; }
		return !!size && theraRoute.SIZE_ORDER.indexOf(size) >= ship;
	},

	/** Hours of life left: from expires_at (exact) or else remaining_hours (whole hours, as cached). Null if unknown. */
	hoursLeft: function(link, now) {
		if (!link) { return null; }
		const expires = Date.parse(link.expires_at);
		if (isFinite(expires) && isFinite(now)) { return (expires - now) / 3600000; }
		const hours = Number(link.remaining_hours);
		return link.remaining_hours !== null && link.remaining_hours !== undefined && link.remaining_hours !== "" && isFinite(hours) ? hours : null;
	},

	/** Why a link can't be used with these filters, or null if it can */
	rejectReason: function(link, settings, now) {
		const hub = theraRoute.hubOf(link);
		if (!hub) { return "not a Thera/Turnur connection"; }
		const other = theraRoute.toID(link.in_system_id);
		if (!other || other === hub) { return "far side unknown"; }
		if (hub === theraRoute.THERA && !settings.thera) { return "Thera off"; }
		if (hub === theraRoute.TURNUR && !settings.turnur) { return "Turnur off"; }
		if (!theraRoute.fits(link, settings.shipSize)) { return "too small"; }
		const hours = theraRoute.hoursLeft(link, now);
		if (hours !== null && hours <= 0) { return "expired"; }
		if (settings.minHours > 0 && (hours === null || hours < settings.minHours)) { return "too little life left"; }
		return null;
	},

	/** Links that may be used with these filters */
	usableLinks: function(links, settings, now) {
		return (Array.isArray(links) ? links : []).filter(function(link) {
			return link && typeof link === "object" && !theraRoute.rejectReason(link, settings, now);
		});
	},

	// ---- Route search (pure) ----

	/** K-space: a known system without a wormhole class, outside the wormhole regions (Pochven counts) */
	isKSpace: function(system) {
		return !!system && !system.class && (Number(system.regionID) || 0) < 11000000;
	},

	/** Same rule as the Favourites panel (favouritesPanel.passable): never Zarzakh or an avoided system; in safe
	mode only high-sec (security >= 0.45, not Pochven) */
	passable: function(system, safe, ignore) {
		if (!system) { return false; }
		const name = String(system.name || "");
		if (name === "Zarzakh" || (ignore && ignore[name.toLowerCase()])) { return false; }
		return !safe || (theraRoute.isKSpace(system) && system.factionID != 500026 && Number(system.security) >= 0.45);
	},

	/** Line ids of EVE-Scout connections drawn on the chain map (upstream's supplier uses 'ES-<id>') */
	isScoutLineID: function(id) {
		return typeof id === "string" && id.indexOf("ES-") === 0;
	},

	/** Shortest routes from the sources to everywhere, over k-space gates, the chain's wormholes and EVE-Scout's
	Thera/Turnur connections. Every jump counts 1; ties go to fewer wormhole jumps. Gate rule (as the Favourites panel):
	a system you gate into or out of is passable (safe: high-sec), unless it is a source or the destination; wormhole
	jumps are always allowed. Each state remembers whether an EVE-Scout connection was used, so pathTo can ask for
	the best route that does use one.
	@param o {sources: [systemID], gateMap (appData.map.shortest), systems, safe, ignore, connections: [[a, b, modifiers,
		lineIndex]] chain wormholes (rally.systemConnections), links: usable EVE-Scout links}
	@return {labels, sources} for pathTo */
	search: function(o) {
		const systems = o.systems || {}, map = o.gateMap || {};
		const sources = {};
		(o.sources || []).forEach(function(s) { const id = theraRoute.toID(s); if (id) { sources[id] = true; } });
		const adjacency = {};
		const addEdge = function(a, b, edge) {
			(adjacency[a] = adjacency[a] || []).push(Object.assign({ from: a, to: b }, edge));
		};
		(o.connections || []).forEach(function(c) {
			const a = theraRoute.toID(c && c[0]), b = theraRoute.toID(c && c[1]);
			if (!a || !b || a === b) { return; }
			addEdge(a, b, { kind: "chain", line: c[3] });
			addEdge(b, a, { kind: "chain", line: c[3] });
		});
		(o.links || []).forEach(function(link) {
			const hub = theraRoute.hubOf(link), other = theraRoute.toID(link.in_system_id);
			if (!hub || !other || hub === other) { return; }
			addEdge(other, hub, { kind: "scout", link: link, hub: hub });
			addEdge(hub, other, { kind: "scout", link: link, hub: hub });
		});

		const labels = {};
		const heap = [];
		const less = function(a, b) { return a.total < b.total || (a.total === b.total && a.holes < b.holes); };
		const push = function(item) {
			heap.push(item);
			for (let i = heap.length - 1; i > 0;) {
				const p = (i - 1) >> 1;
				if (!less(heap[i], heap[p])) { break; }
				const t = heap[i]; heap[i] = heap[p]; heap[p] = t; i = p;
			}
		};
		const pop = function() {
			const top = heap[0], last = heap.pop();
			if (heap.length) {
				heap[0] = last;
				for (let i = 0; ;) {
					const l = 2 * i + 1, r = l + 1;
					let m = i;
					if (l < heap.length && less(heap[l], heap[m])) { m = l; }
					if (r < heap.length && less(heap[r], heap[m])) { m = r; }
					if (m === i) { break; }
					const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m;
				}
			}
			return top;
		};
		// State key: system | terminal (arrived by gate at a system you may not pass through) | EVE-Scout used
		const relax = function(id, terminal, scout, total, holes, prev, edge) {
			const key = id + "|" + (terminal ? 1 : 0) + "|" + (scout ? 1 : 0);
			const old = labels[key];
			const label = { key: key, id: id, terminal: terminal, scout: scout, total: total, holes: holes, prev: prev, edge: edge };
			if (old && !less(label, old)) { return; }
			labels[key] = label;
			push(label);
		};
		Object.keys(sources).forEach(function(id) { relax(Number(id), false, false, 0, 0, null, null); });

		while (heap.length) {
			const current = pop();
			if (labels[current.key] !== current || current.terminal) { continue; }
			const id = current.id;
			if (sources[id] || theraRoute.passable(systems[id], o.safe, o.ignore)) {
				const next = theraRoute.isKSpace(systems[id]) ? map[id - 30000000] || {} : {};
				for (const k in next) {
					const to = 30000000 + Number(k);
					const terminal = !sources[to] && !theraRoute.passable(systems[to], o.safe, o.ignore);
					relax(to, terminal, current.scout, current.total + 1, current.holes, current.key, { kind: "gate", from: id, to: to });
				}
			}
			(adjacency[id] || []).forEach(function(edge) {
				// Straight back through the hole you just came out of is never useful (pathTo would offer it as "a route
				// that uses Thera" when no real one exists)
				if (edge.kind === "scout" && current.edge && current.edge.kind === "scout" && current.edge.link === edge.link) { return; }
				relax(edge.to, false, current.scout || edge.kind === "scout", current.total + 1, current.holes + 1, current.key, edge);
			});
		}
		return { labels: labels, sources: sources };
	},

	/** The best route found by search to a system that uses at least one EVE-Scout connection, as a list of edges
	({kind: "gate" | "chain" | "scout", from, to, line (chain), link and hub (scout)}), or null */
	pathTo: function(result, systemID) {
		const id = theraRoute.toID(systemID);
		if (!result || !id) { return null; }
		const a = result.labels[id + "|0|1"], b = result.labels[id + "|1|1"];
		let best = a && b ? (b.total < a.total || (b.total === a.total && b.holes < a.holes) ? b : a) : a || b;
		if (!best) { return null; }
		const edges = [];
		for (let l = best; l && l.edge; l = result.labels[l.prev]) { edges.unshift(l.edge); }
		return edges;
	},

	/** A route (pathTo's edges) as a plan the panels can show.
	@return {status: "ok", kind: "scout", mode, total, holes, gates, edges, legs: [{from, to, path}] (the gate stretches,
		in order), lineIndexes (chain wormholes used), scoutLineIDs ('ES-<id>' of the EVE-Scout links used), tokens} */
	plan: function(edges, mode) {
		if (!edges || !edges.length) { return null; }
		const legs = [], lineIndexes = [], scoutLineIDs = [];
		let gates = 0, holes = 0, leg = null;
		edges.forEach(function(e) {
			if (e.kind === "gate") {
				gates++;
				if (!leg) { leg = { from: e.from, to: e.to, path: [e.from] }; legs.push(leg); }
				leg.path.push(e.to);
				leg.to = e.to;
				return;
			}
			leg = null;
			holes++;
			if (e.kind === "chain" && e.line !== undefined && e.line !== null) { lineIndexes.push(e.line); }
			if (e.kind === "scout" && e.link) { scoutLineIDs.push("ES-" + e.link.id); }
		});
		return {
			status: "ok", kind: "scout", mode: mode, total: edges.length, gates: gates, holes: holes, edges: edges, legs: legs,
			lineIndexes: lineIndexes, scoutLineIDs: scoutLineIDs, tokens: theraRoute.tokens(edges)
		};
	},

	/** The route in steps: {type: "g" | "wh", n, from, to} for runs of gate / chain wormhole jumps, and
	{type: "hub", hub, in (edge into the hub), out (edge out of it)} for each visit to Thera or Turnur */
	tokens: function(edges) {
		const tokens = [];
		(edges || []).forEach(function(e) {
			const last = tokens[tokens.length - 1];
			if (e.kind === "scout") {
				if (e.from === e.hub) {
					if (last && last.type === "hub" && last.hub === e.hub && !last.out) { last.out = e; return; }
					tokens.push({ type: "hub", hub: e.hub, in: null, out: e });
				} else {
					tokens.push({ type: "hub", hub: e.hub, in: e, out: null });
				}
				return;
			}
			const type = e.kind === "gate" ? "g" : "wh";
			if (last && last.type === type) { last.n++; last.to = e.to; return; }
			tokens.push({ type: type, n: 1, from: e.from, to: e.to });
		});
		return tokens;
	},

	/** Short breakdown, e.g. "2wh → 3g → Thera → 5g" */
	planText: function(plan) {
		if (!plan || !plan.tokens) { return ""; }
		return plan.tokens.map(function(t) {
			return t.type === "hub" ? theraRoute.HUBS[t.hub] : t.n + t.type;
		}).join(" → ");
	},

	/** "7h left", "under 1h left", with ", EOL" under 4 hours */
	lifeText: function(link, now) {
		const h = theraRoute.hoursLeft(link, now);
		if (h === null) { return "life unknown"; }
		const text = h < 1 ? "under 1h left" : Math.floor(h) + "h left";
		return h < theraRoute.EOL_HOURS ? text + ", EOL" : text;
	},

	/** Hole facts for a tooltip: "N944, max capital, 7h left" */
	holeText: function(link, now) {
		const parts = [];
		if (link.wh_type) { parts.push(String(link.wh_type)); }
		parts.push(link.max_ship_size ? "max " + link.max_ship_size : "size unknown");
		parts.push(theraRoute.lifeText(link, now));
		return parts.join(", ");
	},

	/** Signature ID in the hub (out_signature) or in the far system (in_signature) */
	sigIn: function(link, systemID) {
		return String((theraRoute.toID(systemID) === theraRoute.hubOf(link) ? link.out_signature : link.in_signature) || "?");
	},

	/** The route in words, for a tooltip. name: function(systemID) -> system name; now: ms */
	planDetail: function(plan, destName, name, now) {
		if (!plan || !plan.tokens) { return ""; }
		const plural = function(n, word) { return n + " " + word + (n === 1 ? "" : "s"); };
		const steps = [];
		plan.tokens.forEach(function(t) {
			if (t.type === "g") { steps.push(plural(t.n, "gate jump") + " to " + name(t.to)); return; }
			if (t.type === "wh") { steps.push(plural(t.n, "wormhole jump") + " to " + name(t.to)); return; }
			const hub = theraRoute.HUBS[t.hub];
			if (t.in) {
				steps.push("in " + name(t.in.from) + " warp to " + theraRoute.sigIn(t.in.link, t.in.from) + " into " + hub
					+ " (" + theraRoute.holeText(t.in.link, now) + ")");
			}
			if (t.out) {
				steps.push("in " + hub + " warp to " + theraRoute.sigIn(t.out.link, t.hub) + " to " + name(t.out.to)
					+ " (" + theraRoute.holeText(t.out.link, now) + ")");
			}
		});
		return theraRoute.planText(plan) + " (" + steps.join(", ") + ")";
	},

	/** The hub visits as one line with the signatures to warp to, e.g. "Rens SCG-400 → Thera KAN-600 → Perimeter".
	Plain text; escape it for HTML. */
	lineText: function(plan, name) {
		if (!plan || !plan.tokens) { return ""; }
		return plan.tokens.filter(function(t) { return t.type === "hub"; }).map(function(t) {
			const hub = theraRoute.HUBS[t.hub];
			const parts = [];
			if (t.in) { parts.push(name(t.in.from) + " " + theraRoute.sigIn(t.in.link, t.in.from)); }
			parts.push(t.out ? hub + " " + theraRoute.sigIn(t.out.link, t.hub) : hub);
			if (t.out) { parts.push(name(t.out.to)); }
			return parts.join(" → ");
		}).join(" · ");
	},

	/** Whether a route through Thera/Turnur beats another plan: the other has no route, or this one has fewer jumps */
	better: function(other, scout) {
		if (!scout || scout.status !== "ok") { return false; }
		if (!other || other.status !== "ok") { return !other || other.status !== "here"; }
		return scout.total < other.total;
	},

	/** The gate legs of a plan for "Set route in game" (the autopilot can't route through wormholes, so each gate
	stretch is set on its own), with what comes right before and after each: a hub visit or the chain's wormholes.
	@return [{index, count, from, to, path, after, before}], after/before: {hub: systemID} or {chain: true} or null */
	gateLegs: function(plan) {
		if (!plan || !plan.legs) { return []; }
		const tokens = plan.tokens || [];
		const gateTokens = [];
		tokens.forEach(function(t, i) { if (t.type === "g") { gateTokens.push(i); } });
		const around = function(t) { return !t ? null : t.type === "hub" ? { hub: t.hub } : t.type === "wh" ? { chain: true } : null; };
		return plan.legs.map(function(leg, index) {
			const pos = gateTokens[index];
			return {
				index: index, count: plan.legs.length, from: leg.from, to: leg.to, path: leg.path.slice(),
				after: pos === undefined ? null : around(tokens[pos - 1]), before: pos === undefined ? null : around(tokens[pos + 1])
			};
		});
	},

	/** Tooltip for the "Set route in game" button of one gate leg */
	legTitle: function(leg, name) {
		const jumps = leg.path.length - 1;
		const parts = ["Set route in game" + (leg.count > 1 ? ", leg " + (leg.index + 1) + " of " + leg.count : "") + ": the gates from "
			+ name(leg.from) + " to " + name(leg.to) + " (" + jumps + " jump" + (jumps === 1 ? "" : "s") + ") as autopilot waypoints."];
		if (leg.after && leg.after.hub) {
			parts.push("Send it once you are " + (leg.after.hub === leg.from ? "in " : "out of " + theraRoute.HUBS[leg.after.hub] + " in ")
				+ name(leg.from) + ": the autopilot can't route through wormholes.");
		} else if (leg.after && leg.after.chain) {
			parts.push("Take the wormholes to " + name(leg.from) + " yourself.");
		}
		if (leg.before && leg.before.hub) {
			parts.push("Then take the " + (leg.before.hub === leg.to ? "wormhole" : theraRoute.HUBS[leg.before.hub] + " hole") + " in "
				+ name(leg.to) + " yourself" + (leg.index + 1 < leg.count ? " and send leg " + (leg.index + 2) + " after it." : "."));
		} else if (leg.before && leg.before.chain) {
			parts.push("Then take the wormholes from " + name(leg.to) + " yourself" + (leg.index + 1 < leg.count ? " and send leg " + (leg.index + 2) + " after them." : "."));
		}
		return parts.join(" ");
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined") {
	(function() {
		const tr = theraRoute;
		let ownLinks = [];          // fetched here when the chain tab doesn't show EVE-Scout (so eveScout.links stays empty)
		let lastFetch = 0, fetching = false;
		const cache = [];           // last searches: [{key, result}]

		function current() { return tr.settings(typeof options !== "undefined" ? options : null); }
		function gateMap() { return (tripwire.map && tripwire.map.shortest) || appData.map.shortest; }
		function systemName(id) { return ((tripwire.systems && tripwire.systems[id]) || appData.systems[id] || {}).name || String(id); }
		function redrawChain() { if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); } }
		function avoidList() {
			const r = options.chain && options.chain.routeIgnore;
			if (!r || !r.enabled || !Array.isArray(r.systems)) { return null; }
			const list = {};
			r.systems.forEach(function(n) { if (n) { list[String(n).trim().toLowerCase()] = true; } });
			return list;
		}
		function scoutActive() { return typeof eveScout !== "undefined" && eveScout && eveScout.active && eveScout.active(); }

		/** EVE-Scout's list: the map supplier's copy when the chain tab shows EVE-Scout, else our own */
		function links() {
			return scoutActive() && Array.isArray(eveScout.links) && eveScout.links.length ? eveScout.links : ownLinks;
		}
		tr.links = links;

		/** Whether any route would use the data: Favourites with Route on, or saved destinations */
		function needed() {
			if (!tr.anyHub(current())) { return false; }
			const favRoutes = typeof favouritesPanel !== "undefined" && favouritesPanel.enabled(options)
				&& favouritesPanel.routeFavorites(options.favorites, favouritesPanel.settings(options)).length;
			const dests = typeof routeDestinations !== "undefined" && routeDestinations.saved().length;
			return !!(favRoutes || dests);
		}

		/** Fetch the same cached list upstream's supplier reads (cached_third_party.php, cached 5 minutes on the
		server), only while routes need it and the chain tab isn't already fetching it */
		function refresh() {
			if (fetching || scoutActive() || !needed() || Date.now() - lastFetch < tr.REFRESH_MS) { return; }
			fetching = true;
			$.ajax({ url: "cached_third_party.php?key=eve-scout-signatures", type: "GET", dataType: "JSON" }).done(function(data) {
				lastFetch = Date.now();
				if (Array.isArray(data) && !_.isEqual(data, ownLinks)) { ownLinks = data; redrawChain(); }
			}).fail(function(xhr, status) {
				lastFetch = Date.now() - tr.REFRESH_MS + 60000;	// try again in a minute
				console.warn("Thera routes: could not load EVE-Scout connections: " + status);
			}).always(function() { fetching = false; });
		}
		tr.refresh = refresh;

		/** search() with a small cache: the chain map is redrawn often, the inputs rarely change */
		function cachedSearch(sources, safe, connections) {
			const settings = current();
			if (!tr.anyHub(settings)) { return null; }
			if (!scoutActive() && !lastFetch) { setTimeout(refresh, 0); }	// first route asked for: load the list now
			const usable = tr.usableLinks(links(), settings, Date.now());
			if (!usable.length) { return null; }
			const avoid = avoidList();
			const key = JSON.stringify([sources.slice().sort(), !!safe, avoid ? Object.keys(avoid).sort() : 0,
				(connections || []).map(function(c) { return c[0] + "-" + c[1] + "-" + c[3]; }),
				usable.map(function(l) { return l.id + ":" + l.in_system_id + ":" + l.out_system_id; })]);
			const hit = cache.filter(function(c) { return c.key === key; })[0];
			if (hit) { return hit.result; }
			const result = tr.search({ sources: sources, gateMap: gateMap(), systems: appData.systems, safe: !!safe, ignore: avoid,
				connections: connections, links: usable });
			cache.unshift({ key: key, result: result });
			cache.length = Math.min(cache.length, 6);
			return result;
		}

		// Favourites panel: a route through Thera/Turnur from the tracked character, for one favourite and mode
		tr.favouriteScout = function(ctx, favID, mode) {
			if (!ctx || !ctx.start) { return null; }
			const result = cachedSearch([ctx.start], mode === "safe", ctx.connections);
			return tr.plan(tr.pathTo(result, favID), mode);
		};

		// Destinations window: from any system on the chain (its wormholes aren't counted there), with the user's
		// K-space route selection: "Prefer HS" uses the high-sec only rule, anything else the shortest
		if (typeof routeDestinations !== "undefined") {
			routeDestinations.scoutRoute = function(destinationID) {
				const sources = routeDestinations.lastChainSystems || [];
				if (!sources.length) { return null; }
				const safe = options.chain && options.chain.routeSecurity === "highsec";
				return tr.plan(tr.pathTo(cachedSearch(sources, safe, []), destinationID), safe ? "safe" : "shortest");
			};
		}

		tr.name = systemName;

		// ---- Settings > General Preferences ----

		function settingsRowHtml() {
			const ships = tr.SIZE_ORDER.map(function(s) {
				return "<option value='" + s + "'>" + tr.escape(tr.SHIP_LABELS[s]) + " (" + s + ")</option>";
			}).join("");
			const lives = tr.LIFE_CHOICES.map(function(h) {
				return "<option value='" + h + "'>" + (h === 0 ? "Use all" : h === tr.EOL_HOURS ? "Skip EOL (under 4h)" : "Skip under " + h + "h") + "</option>";
			}).join("");
			return "<tr id='theraRoute-row'><th>Routes through:</th><td>"
				+ "<div><label><input type='checkbox' id='theraRoute-thera' /> Thera</label> "
				+ "<label><input type='checkbox' id='theraRoute-turnur' /> Turnur</label></div>"
				+ "<div><label>Ship: <select id='theraRoute-ship'>" + ships + "</select></label></div>"
				+ "<div><label>Holes: <select id='theraRoute-life'>" + lives + "</select></label></div>"
				+ "<div class='theraRoute-hint'>EVE-Scout's connections, for Favourites and Destinations routes</div>"
				+ "</td></tr>";
		}

		function setupSettings() {
			const $anchor = $("#chainRouteSecurity").closest("tr");
			if ($anchor.length && !$("#theraRoute-row").length) {
				$anchor.after(settingsRowHtml());
				if ($("#optionsAccordion").hasClass("ui-accordion")) { $("#optionsAccordion").accordion("refresh"); }
			}
			$(document).on("dialogopen", "#dialog-options", function() {
				const s = current();
				$("#theraRoute-thera").prop("checked", s.thera);
				$("#theraRoute-turnur").prop("checked", s.turnur);
				$("#theraRoute-ship").val(s.shipSize);
				$("#theraRoute-life").val(String(s.minHours));
			});
			// Capture phase, so the value is in place before upstream's Save handler applies and saves options
			document.addEventListener("click", function(e) {
				const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
				if (!button || $.trim($(button).text()) !== "Save") { return; }
				if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#theraRoute-row").length) { return; }
				const before = JSON.stringify(current());
				options.theraRoute = {
					thera: $("#theraRoute-thera").prop("checked"),
					turnur: $("#theraRoute-turnur").prop("checked"),
					shipSize: $("#theraRoute-ship").val(),
					minHours: Number($("#theraRoute-life").val())
				};
				if (JSON.stringify(current()) !== before) { setTimeout(function() { refresh(); redrawChain(); }, 0); }
			}, true);

			// Settings > Reset: back to the defaults (a missing key means defaults)
			if (typeof options.reset === "function" && !options.reset.theraRouteWrapped) {
				const reset = options.reset;
				const wrapped = function() {
					const result = reset.apply(this, arguments);
					delete this.theraRoute;
					return result;
				};
				Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
				wrapped.theraRouteWrapped = true;
				options.reset = wrapped;
			}
		}

		$(function() {
			setupSettings();
			setTimeout(refresh, 1000);
			setInterval(refresh, 60000);
		});
	})();
}
