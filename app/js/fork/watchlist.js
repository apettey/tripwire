const watchlist = {
	// Watchlist: the corporation's filters ("a C5 with a Wolf-Rayet effect", "J123450", "anything on an H296 within
	// 3 jumps of me") matched against the systems and connections on the chain map. A new match shows a pop-up
	// (and plays a sound) once, and the matching node, the hole that makes the match and its signature are marked
	// (fork-owned file). Filters belong to the mask and are set by the corporation's Tripwire admins (Mask Admin >
	// Watchlist, public/watchlist.php, watchlist/watchlist.inc.php, which has a port of the matcher below for the
	// Discord type; both pass watchlist/tests/cases.json).
	// Per-user settings in options.watchlist = {enabled (panel), popups, markers, soundEnabled, sound, position};
	// a missing key means the default (all on, chime).
	// Keep `const watchlist` on the first line: the test helper strips it to define a global.
	WIDGET_ID: "watchlistWidget",
	DEFAULT_SIZE: { x: 7, y: 6 },
	MIN_SIZE: { x: 4, y: 3 },
	FORGET_MS: 30 * 60 * 1000,	// a match whose system left the chain map is remembered this long
	MAX_FILTERS: 50,
	MAX_NAME: 60,
	TOAST_MS: 15000,
	DEFAULT_SOUND: "tone-chime",
	DEFAULT_VOLUME: 70,
	SOUNDS: ["tone-chime", "tone-blip", "tone-double-beep", "tone-sonar", "tone-klaxon"],
	URL: "watchlist.php",
	HOLE_CLASS: "watchlist-hole",	// line modifier of a highlighted hole (the chain map renderers read its CSS)
	POLL_MS: 60000,		// filters are read again this often (admins may change them)
	MASK_RETRY_MS: 2000,	// after a mask switch, the filters are asked for again this often until they are the new mask's
	MASK_RETRIES: 5,

	/** System classes a filter can ask for, in the order the editor shows them */
	CLASSES: [
		{ key: "C1", label: "C1" }, { key: "C2", label: "C2" }, { key: "C3", label: "C3" },
		{ key: "C4", label: "C4" }, { key: "C5", label: "C5" }, { key: "C6", label: "C6" },
		{ key: "C13", label: "C13" }, { key: "Thera", label: "Thera" },
		{ key: "Shattered", label: "Shattered", title: "C13 and the Drifter systems (Tripwire's data doesn't mark shattered C1-C6)" },
		{ key: "Drifter", label: "Drifter", title: "Sentinel, Barbican, Vidette, Conflux, Redoubt" },
		{ key: "Pochven", label: "Pochven" },
		{ key: "HS", label: "High-sec" }, { key: "LS", label: "Low-sec" }, { key: "NS", label: "Null-sec" }
	],

	EFFECTS: [
		{ key: "Wolf-Rayet Star", label: "Wolf-Rayet" }, { key: "Pulsar", label: "Pulsar" },
		{ key: "Magnetar", label: "Magnetar" }, { key: "Black Hole", label: "Black Hole" },
		{ key: "Cataclysmic Variable", label: "Cataclysmic Variable" }, { key: "Red Giant", label: "Red Giant" }
	],

	/** Size classes of the size tags feature (sizeTags.classes), smallest first */
	SIZES: ["S", "M", "L", "VL", "XL"],

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
		return Number.isInteger(n) && n >= 30000000 && n < 33000000 ? n : null;
	},

	positiveInt: function(value) {
		if (value === null || value === undefined || value === "" || typeof value === "boolean") { return null; }
		const n = Number(value);
		return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null;
	},

	// ---- Settings (pure) ----

	/** Whether the Watchlist panel is shown (options.watchlist.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.watchlist && opts.watchlist.enabled === false);
	},

	/** Per-user settings with defaults filled in (a missing key means on). Never mutates opts. */
	settings: function(opts) {
		const raw = opts && opts.watchlist && typeof opts.watchlist === "object" ? opts.watchlist : {};
		const sound = watchlist.SOUNDS.indexOf(raw.sound) >= 0 ? raw.sound : watchlist.DEFAULT_SOUND;
		const volume = Number(raw.volume);
		const result = {
			enabled: raw.enabled !== false,
			popups: raw.popups !== false,
			markers: raw.markers !== false,
			soundEnabled: raw.soundEnabled !== false && raw.sound !== "none",
			sound: sound,
			volume: isFinite(volume) && raw.volume !== null && raw.volume !== "" ? Math.max(0, Math.min(100, Math.round(volume))) : watchlist.DEFAULT_VOLUME
		};
		if (raw.position && typeof raw.position === "object") { result.position = raw.position; }
		return result;
	},

	/** The mask's filters as the server sent them: normalised, unique IDs, at most MAX_FILTERS */
	normaliseFilters: function(list) {
		const seen = {};
		return (Array.isArray(list) ? list : []).map(watchlist.normaliseFilter)
			.filter(function(f) {
				if (!f || seen[f.id]) { return false; }
				seen[f.id] = true;
				return true;
			}).slice(0, watchlist.MAX_FILTERS);
	},

	/** A stored filter as {id, name, enabled, conditions}, or null when it isn't usable */
	normaliseFilter: function(f) {
		if (!f || typeof f !== "object") { return null; }
		const id = String(f.id === undefined || f.id === null ? "" : f.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
		if (!id) { return null; }
		return {
			id: id,
			name: String(f.name === undefined || f.name === null ? "" : f.name).trim().slice(0, watchlist.MAX_NAME) || "Unnamed filter",
			enabled: f.enabled !== false,
			conditions: watchlist.normaliseConditions(f.conditions)
		};
	},

	/** Conditions with only known keys and valid values (anything else dropped) */
	normaliseConditions: function(c) {
		c = c && typeof c === "object" ? c : {};
		const result = {};
		const classKeys = watchlist.CLASSES.map(function(x) { return x.key; });
		const effectKeys = watchlist.EFFECTS.map(function(x) { return x.key; });
		const pick = function(list, allowed) {
			const out = [];
			(Array.isArray(list) ? list : []).forEach(function(v) { if (allowed.indexOf(v) >= 0 && out.indexOf(v) < 0) { out.push(v); } });
			return out;
		};
		const systemID = watchlist.toID(c.systemID);
		if (systemID) { result.systemID = systemID; }
		const regionID = Number(c.regionID);
		if (Number.isInteger(regionID) && regionID >= 10000000 && regionID < 13000000) { result.regionID = regionID; }
		const constellationID = Number(c.constellationID);
		if (Number.isInteger(constellationID) && constellationID >= 20000000 && constellationID < 23000000) {
			result.constellationID = constellationID;
			const ref = watchlist.toID(c.constellationRef);
			if (ref) { result.constellationRef = ref; }
		}
		const classes = pick(c.classes, classKeys);
		if (classes.length) { result.classes = classes; }
		const effects = pick(c.effects, effectKeys);
		if (effects.length) { result.effects = effects; }
		if (classKeys.indexOf(c.staticLeadsTo) >= 0) { result.staticLeadsTo = c.staticLeadsTo; }
		const staticType = watchlist.typeCode(c.staticType);
		if (staticType) { result.staticType = staticType; }
		const whType = watchlist.typeCode(c.whType);
		if (whType) { result.whType = whType; }
		if (classKeys.indexOf(c.whLeadsTo) >= 0) { result.whLeadsTo = c.whLeadsTo; }
		if (watchlist.SIZES.indexOf(c.minSize) >= 0) { result.minSize = c.minSize; }
		const me = watchlist.positiveInt(c.maxJumpsMe);
		if (me !== null) { result.maxJumpsMe = me; }
		const home = watchlist.positiveInt(c.maxJumpsHome);
		if (home !== null) { result.maxJumpsHome = home; }
		return result;
	},

	/** A wormhole type code as upper case (e.g. "H296"), or null if it doesn't look like one */
	typeCode: function(value) {
		const code = String(value === undefined || value === null ? "" : value).trim().toUpperCase();
		return /^[A-Z][0-9]{3}$/.test(code) ? code : null;
	},

	/** Whether conditions ask for anything at all (an empty filter would match every system, so it never matches) */
	hasConditions: function(c) {
		return !!c && Object.keys(c).some(function(k) { return k !== "constellationRef"; });
	},

	/** Whether any connection condition is set */
	needsConnection: function(c) {
		return !!c && (!!c.whType || !!c.whLeadsTo || !!c.minSize);
	},

	/** A new filter ID that isn't used yet */
	newID: function(filters, now) {
		const used = {};
		(filters || []).forEach(function(f) { if (f) { used[f.id] = true; } });
		let n = Math.floor(Number(now) || 0);
		let id = "f" + n.toString(36);
		while (used[id]) { id = "f" + (++n).toString(36); }
		return id;
	},

	// ---- Classes, statics (pure) ----

	/** Class keys of a system, e.g. ["C5"], ["C13", "Shattered"], ["Drifter", "Shattered"], ["HS"], ["Pochven"] */
	classKeys: function(system) {
		if (!system) { return []; }
		const cls = Array.isArray(system.class) ? Number(system.class[0]) : Number(system.class);
		if (cls >= 1 && cls <= 6) { return ["C" + cls]; }
		if (cls === 13) { return ["C13", "Shattered"]; }
		if (cls === 12) { return ["Thera"]; }
		if (cls >= 14 && cls <= 18) { return ["Drifter", "Shattered"]; }
		if (cls) { return []; }	// Abyssal and other special spaces
		if ((Number(system.regionID) || 0) >= 11000000) { return []; }
		if (Number(system.factionID) === 500026) { return ["Pochven"]; }
		const sec = Number(system.security);
		if (!isFinite(sec)) { return []; }
		return [sec >= 0.45 ? "HS" : sec > 0.0 ? "LS" : "NS"];
	},

	/** Class keys a wormhole type's "leadsTo" text stands for ("Class-5" -> ["C5"], "High-Sec" -> ["HS"]; a system
	name such as "Turnur" or a Drifter J-code -> that system's classes). systemsByName: {<upper-case name>: system} */
	leadsToKeys: function(leadsTo, systemsByName) {
		const text = String(leadsTo || "");
		const m = /^Class-(\d+)$/.exec(text);
		if (m) { return watchlist.classKeys({ class: Number(m[1]) }); }
		const map = { "High-Sec": ["HS"], "Low-Sec": ["LS"], "Null-Sec": ["NS"], "Thera": ["Thera"], "Triglavian": ["Pochven"] };
		if (map[text]) { return map[text]; }
		const system = systemsByName ? systemsByName[text.toUpperCase()] : null;
		if (system) { return watchlist.classKeys(system); }
		// Drifter hole types (S877, B735...) name the Drifter system's J-code, which appData lists under its
		// in-game name (Sentinel MZ...), so an unknown J-code here is a Drifter system
		return /^J\d{6}$/.test(text) ? ["Drifter", "Shattered"] : [];
	},

	/** Data lookup with a name index (built once per data object) */
	index: function(data) {
		if (!data) { return { systems: {}, wormholes: {}, byName: {} }; }
		if (!data._watchlistByName) {
			const byName = {};
			for (const id in (data.systems || {})) {
				const s = data.systems[id];
				if (s && s.name) { byName[String(s.name).toUpperCase()] = s; }
			}
			Object.defineProperty(data, "_watchlistByName", { value: byName, enumerable: false, configurable: true });
		}
		return { systems: data.systems || {}, wormholes: data.wormholes || {}, regions: data.regions || {}, byName: data._watchlistByName };
	},

	// ---- Matching (pure) ----

	/** Whether a system satisfies a filter's system conditions. system: appData.systems entry */
	matchSystem: function(c, systemID, system, data) {
		if (!system) { return false; }
		if (c.systemID && c.systemID !== Number(systemID)) { return false; }
		if (c.regionID && c.regionID !== Number(system.regionID)) { return false; }
		if (c.constellationID && c.constellationID !== Number(system.constellationID)) { return false; }
		const keys = watchlist.classKeys(system);
		if (c.classes && !c.classes.some(function(k) { return keys.indexOf(k) >= 0; })) { return false; }
		if (c.effects && c.effects.indexOf(system.effect) < 0) { return false; }
		if (c.staticLeadsTo || c.staticType) {
			const ix = watchlist.index(data);
			const statics = Array.isArray(system.statics) ? system.statics : [];
			if (c.staticType && statics.indexOf(c.staticType) < 0) { return false; }
			if (c.staticLeadsTo && !statics.some(function(t) {
				const wh = ix.wormholes[t];
				return wh && watchlist.leadsToKeys(wh.leadsTo, ix.byName).indexOf(c.staticLeadsTo) >= 0;
			})) { return false; }
		}
		return true;
	},

	/** Whether one connection satisfies all of a filter's connection conditions.
	connection: {type: real wormhole type or null, size: "S".."XL" or null} */
	matchConnection: function(c, connection, data) {
		if (!connection) { return false; }
		if (c.whType && connection.type !== c.whType) { return false; }
		if (c.whLeadsTo) {
			const ix = watchlist.index(data);
			const wh = connection.type ? ix.wormholes[connection.type] : null;
			if (!wh || watchlist.leadsToKeys(wh.leadsTo, ix.byName).indexOf(c.whLeadsTo) < 0) { return false; }
		}
		if (c.minSize) {
			const have = watchlist.SIZES.indexOf(connection.size);
			if (have < 0 || have < watchlist.SIZES.indexOf(c.minSize)) { return false; }
		}
		return true;
	},

	/** The entry's connections that make the match: those fitting the connection conditions, or all of them */
	matchingConnections: function(c, entry, data) {
		return (entry && entry.connections || []).filter(function(conn) {
			return !watchlist.needsConnection(c) || watchlist.matchConnection(c, conn, data);
		});
	},

	/** Whether a chain entry (one system, see chainModel) matches a filter's conditions (all of them) */
	matchEntry: function(c, entry, data) {
		if (!watchlist.hasConditions(c) || !entry) { return false; }
		const ix = watchlist.index(data);
		if (!watchlist.matchSystem(c, entry.systemID, ix.systems[entry.systemID], data)) { return false; }
		if (c.maxJumpsMe !== undefined && !(entry.jumpsMe !== null && entry.jumpsMe !== undefined && entry.jumpsMe <= c.maxJumpsMe)) { return false; }
		if (c.maxJumpsHome !== undefined && !(entry.jumpsHome !== null && entry.jumpsHome !== undefined && entry.jumpsHome <= c.maxJumpsHome)) { return false; }
		if (watchlist.needsConnection(c)) {
			return (entry.connections || []).some(function(conn) { return watchlist.matchConnection(c, conn, data); });
		}
		return true;
	},

	/**
	 * Match enabled filters against the chain.
	 * @param filters settings().filters
	 * @param model chainModel() or {entries: entriesFromLinks()} output
	 * @return [{key: "<filterID>|<systemID>", filterID, filterName, systemID, wormholeIDs (the connections that make
	 *         the match: those fitting the hole conditions, else all of the system's), viaHole (the filter has hole
	 *         conditions), nodeIDs, inbound (the connections the chain map reaches the system's nodes through)}]
	 */
	match: function(filters, model, data) {
		const out = [];
		const entries = model && Array.isArray(model.entries) ? model.entries : [];
		(filters || []).forEach(function(f) {
			if (!f || !f.enabled || !watchlist.hasConditions(f.conditions)) { return; }
			entries.forEach(function(entry) {
				if (watchlist.matchEntry(f.conditions, entry, data)) {
					const ids = watchlist.matchingConnections(f.conditions, entry, data)
						.map(function(conn) { return conn.wormholeID; })
						.filter(function(id) { return id !== null && id !== undefined; });
					out.push({ key: f.id + "|" + entry.systemID, filterID: f.id, filterName: f.name, systemID: entry.systemID,
						wormholeIDs: ids, viaHole: watchlist.needsConnection(f.conditions),
						nodeIDs: (entry.nodeIDs || []).slice(), inbound: (entry.inbound || []).slice() });
				}
			});
		});
		return out;
	},

	/** The holes to highlight and the filters they are for: {<wormholeID>: [filter names]}. A filter with hole
	conditions highlights the holes that make the match; one on the system only, the hole the chain map reaches the
	system through. */
	namesByHole: function(matches) {
		const result = {};
		(matches || []).forEach(function(m) {
			((m.viaHole ? m.wormholeIDs : m.inbound) || []).forEach(function(id) {
				if (id === null || id === undefined) { return; }
				result[id] = result[id] || [];
				if (result[id].indexOf(m.filterName) < 0) { result[id].push(m.filterName); }
			});
		});
		return result;
	},

	/** New matches since the previous evaluation of the same chain. A remembered key isn't announced again.
	A key that no longer matches is forgotten (so it is announced when it matches again) only when its system is
	still on the chain map; when the system is gone from the map (a hole collapsed, or you viewed an unconnected
	system and the chain shrank to it) it is kept for FORGET_MS since it last matched.
	@param seen {<key>: last matched (ms)} from the last call (or null; legacy `true` values count as now)
	@param onChain system IDs on the chain map now (chainModel entries)
	@return {fresh: matches not remembered, seen: the keys to remember now} */
	diff: function(seen, matches, onChain, now) {
		const before = seen && typeof seen === "object" ? seen : {};
		const time = Number(now) || 0;
		const present = {};
		(onChain || []).forEach(function(id) { present[id] = true; });
		const next = {};
		const fresh = [];
		(matches || []).forEach(function(m) {
			if (next[m.key] !== undefined) { return; }
			next[m.key] = time;
			if (before[m.key] === undefined || before[m.key] === null || before[m.key] === false) { fresh.push(m); }
		});
		Object.keys(before).forEach(function(key) {
			if (next[key] !== undefined) { return; }
			const systemID = Number(String(key).split("|")[1]);
			if (present[systemID]) { return; }	// on the map but no longer matching: forget
			const last = before[key] === true ? time : Number(before[key]);
			if (isFinite(last) && time - last < watchlist.FORGET_MS) { next[key] = last; }
		});
		return { fresh: fresh, seen: next };
	},

	/** Matches grouped per filter, filter order kept: [{filterID, filterName, systemIDs}] */
	groupByFilter: function(matches) {
		const groups = [];
		const byID = {};
		(matches || []).forEach(function(m) {
			if (!byID[m.filterID]) {
				byID[m.filterID] = { filterID: m.filterID, filterName: m.filterName, systemIDs: [] };
				groups.push(byID[m.filterID]);
			}
			if (byID[m.filterID].systemIDs.indexOf(m.systemID) < 0) { byID[m.filterID].systemIDs.push(m.systemID); }
		});
		return groups;
	},

	/** Filter names per chain node: {<nodeID>: [names]} */
	namesByNode: function(matches) {
		const result = {};
		(matches || []).forEach(function(m) {
			(m.nodeIDs || []).forEach(function(v) {
				result[v] = result[v] || [];
				if (result[v].indexOf(m.filterName) < 0) { result[v].push(m.filterName); }
			});
		});
		return result;
	},

	// ---- The chain (pure) ----

	/** A calculated gate-route node (show viewing / show favourites) or a node another feature added */
	isExtraRow: function(row) {
		const node = row && row.c && row.c[0];
		if (!node) { return true; }
		if (row.destination || String(node.v).indexOf("dest-") === 0) { return true; }
		const pathHome = Array.isArray(row.pathHome) ? row.pathHome : [];
		const last = pathHome[pathHome.length - 1];
		return !!(last && last.path);
	},

	/**
	 * The systems on a chain with their connections, from the chain's links (shared with the server's
	 * watchlist_entries_from_links): systemIDs first (in order), then each link's ends (a, then b). Every link is a
	 * connection of both of its (real) systems: {wormholeID, type (real type, never K162, else null), size}.
	 * @param links [{wormholeID, a, b, type, size}]
	 * @return [{systemID, connections}]
	 */
	entriesFromLinks: function(systemIDs, links) {
		const entries = [];
		const byID = {};
		const add = function(value) {
			const id = watchlist.toID(value);
			if (id && !byID[id]) { byID[id] = { systemID: id, connections: [] }; entries.push(byID[id]); }
		};
		(systemIDs || []).forEach(add);
		(links || []).forEach(function(l) { add(l.a); add(l.b); });
		(links || []).forEach(function(l) {
			let type = watchlist.typeCode(l.type);
			if (type === "K162") { type = null; }
			const connection = { wormholeID: l.wormholeID === undefined ? null : l.wormholeID, type: type,
				size: watchlist.SIZES.indexOf(l.size) >= 0 ? l.size : null };
			[l.a, l.b].forEach(function(end) {
				const e = byID[watchlist.toID(end)];
				if (!e) { return; }
				if (connection.wormholeID !== null && e.connections.some(function(c) { return c.wormholeID === connection.wormholeID; })) { return; }
				e.connections.push(connection);
			});
		});
		return entries;
	},

	/**
	 * The systems on the chain map, from chain.nodes() output, for matching.
	 * @param result {map: {rows}, lines} from chain.nodes()
	 * @param opts {typeFor(wormholeID, row) -> type, sizeFor(row, type, parentSystemID) -> "S".."XL" or null,
	 *        trackedSystemID: where the user is}
	 * @return {entries: [{systemID, nodeIDs, connections: [{wormholeID, type, size}], inbound: [wormholeID of the
	 *         line into each node], jumpsHome, jumpsMe}]}; connections are all of the system's wormholes on the map
	 *         (to its parent and to its children)
	 */
	chainModel: function(result, opts) {
		opts = opts || {};
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		const lines = result && Array.isArray(result.lines) ? result.lines : [];
		const wormholeByChild = {};
		lines.forEach(function(l) { if (l) { wormholeByChild[l[0]] = l[3]; } });
		const nodes = {};		// v -> {systemID, parent v}
		const systemIDs = [];
		const links = [];
		const extra = {};		// systemID -> {nodeIDs, inbound, jumpsHome}
		const rawSystem = {};	// v -> the node's systemID as the chain has it (also unknown "x|y" systems)
		rows.forEach(function(row) { if (row && row.c && row.c[0]) { rawSystem[row.c[0].v] = row.c[0].systemID; } });
		rows.forEach(function(row) {
			if (watchlist.isExtraRow(row)) { return; }
			const node = row.c[0];
			const parentV = row.c[1] ? row.c[1].v : null;
			const systemID = watchlist.toID(node.systemID);
			nodes[node.v] = { systemID: systemID, parent: parentV };
			if (!systemID) { return; }
			if (!extra[systemID]) { extra[systemID] = { nodeIDs: [], inbound: [], jumpsHome: null }; systemIDs.push(systemID); }
			const x = extra[systemID];
			x.nodeIDs.push(node.v);
			const home = Array.isArray(row.pathHome) ? row.pathHome.length : 0;
			if (x.jumpsHome === null || home < x.jumpsHome) { x.jumpsHome = home; }
			if (parentV !== null && parentV !== undefined) {
				const wormholeID = wormholeByChild[node.v];
				let type = watchlist.typeCode(opts.typeFor ? opts.typeFor(wormholeID, row) : null);
				if (type === "K162") { type = null; }
				const size = opts.sizeFor ? opts.sizeFor(row, type, rawSystem[parentV]) : null;
				if (wormholeID !== undefined && wormholeID !== null && x.inbound.indexOf(wormholeID) < 0) { x.inbound.push(wormholeID); }
				links.push({ wormholeID: wormholeID, a: rawSystem[parentV], b: systemID, type: type, size: size });
			}
		});
		const entries = watchlist.entriesFromLinks(systemIDs, links).filter(function(e) { return extra[e.systemID]; });
		entries.forEach(function(e) {
			const x = extra[e.systemID];
			e.nodeIDs = x.nodeIDs;
			e.inbound = x.inbound;
			e.jumpsHome = x.jumpsHome;
			e.jumpsMe = null;
		});

		// Wormhole jumps from the tracked system, over the chain's connections (systems linked by a parent/child node)
		const start = watchlist.toID(opts.trackedSystemID);
		if (start && extra[start]) {
			const adjacent = {};
			const link = function(a, b) {
				if (!a || !b || a === b) { return; }
				(adjacent[a] = adjacent[a] || {})[b] = true;
				(adjacent[b] = adjacent[b] || {})[a] = true;
			};
			Object.keys(nodes).forEach(function(v) {
				const n = nodes[v];
				const parent = n.parent !== null && n.parent !== undefined ? nodes[n.parent] : null;
				if (parent) { link(n.systemID, parent.systemID); }
			});
			const dist = {};
			dist[start] = 0;
			const queue = [start];
			for (let i = 0; i < queue.length; i++) {
				const current = queue[i];
				Object.keys(adjacent[current] || {}).forEach(function(k) {
					const next = Number(k);
					if (dist[next] === undefined) { dist[next] = dist[current] + 1; queue.push(next); }
				});
			}
			entries.forEach(function(e) { e.jumpsMe = dist[e.systemID] === undefined ? null : dist[e.systemID]; });
		}
		return { entries: entries };
	},

	/** Mark the holes of namesByHole() on chain.nodes() output (in place): the line gets HOLE_CLASS (all renderers
	draw it from that class), and the child node's cell a sizeTag.watchlist list of filter names, which the size tag
	on the connection shows as an eye (an eye only when there is no size tag, e.g. size tags switched off). */
	decorateHoles: function(result, byHole) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		const lines = result && Array.isArray(result.lines) ? result.lines : [];
		const nodeByV = {};
		rows.forEach(function(row) { if (row && row.c && row.c[0]) { nodeByV[row.c[0].v] = row.c[0]; } });
		lines.forEach(function(line) {
			if (!line || !Array.isArray(line[2])) { return; }
			const at = line[2].indexOf(watchlist.HOLE_CLASS);
			if (at >= 0) { line[2].splice(at, 1); }
			const node = nodeByV[line[0]];
			if (node && node.sizeTag && node.sizeTag.watchlist) {
				if (node.sizeTag.size) { delete node.sizeTag.watchlist; } else { delete node.sizeTag; }
			}
			const names = line[3] !== undefined && line[3] !== null ? (byHole || {})[line[3]] : null;
			if (!names) { return; }
			line[2].push(watchlist.HOLE_CLASS);
			if (node) {
				if (node.sizeTag) { node.sizeTag.watchlist = names.slice(); } else { node.sizeTag = { size: null, watchlist: names.slice() }; }
			}
		});
		return result;
	},

	/** Add the watchlist marker to the matching nodes of chain.nodes() output (in place).
	byNode: namesByNode() output */
	decorate: function(result, byNode) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || typeof node.f !== "string" || !byNode[node.v] || node.f.indexOf("watchlist-badge") >= 0) { return; }
			const names = byNode[node.v];
			const title = "Watchlist: " + names.join(", ");
			const badge = "<span class='watchlist-badge' title='" + watchlist.escape(title) + "'>"
				+ "<i data-icon='eye'></i></span>";
			let f = node.f.replace("class='node ", "class='node watchlist-match ");
			// Inside the node's top row, right after the effect icon (that row only holds the centred class label
			// and the pilots marker on the right), clear of the corner badges, connectors, statics and names
			const marker = "<div class='nodeIcons'><div style='float: left;'>";
			const at = f.indexOf(marker);
			const end = at < 0 ? -1 : f.indexOf("</div>", at + marker.length);
			f = end < 0 ? f : f.substring(0, end) + badge + f.substring(end);
			node.f = f;
		});
		return result;
	},

	// ---- Editing (pure) ----

	/** Find a system by exact name (case-insensitive). Returns its ID or null */
	findSystem: function(name, data) {
		const wanted = String(name || "").trim().toUpperCase();
		if (!wanted) { return null; }
		const ix = watchlist.index(data);
		for (const id in ix.systems) {
			if (String(ix.systems[id].name).toUpperCase() === wanted) { return Number(id); }
		}
		return null;
	},

	findRegion: function(name, data) {
		const wanted = String(name || "").trim().toUpperCase();
		if (!wanted) { return null; }
		const regions = (data && data.regions) || {};
		for (const id in regions) {
			if (regions[id] && String(regions[id].name).toUpperCase() === wanted) { return Number(id); }
		}
		return null;
	},

	/**
	 * Build a filter from the editor's form values.
	 * @param raw {id, name, enabled, system, region, constellation (a system name), classes, effects, staticLeadsTo,
	 *        staticType, whType, whLeadsTo, minSize, maxJumpsMe, maxJumpsHome} (strings / arrays as typed)
	 * @return {filter} or {errors: [{field, message}]}
	 */
	fromForm: function(raw, data, existing, now) {
		raw = raw || {};
		const errors = [];
		const c = {};
		const ix = watchlist.index(data);
		const text = function(v) { return String(v === undefined || v === null ? "" : v).trim(); };
		const name = text(raw.name);
		if (!name) { errors.push({ field: "name", message: "Give the filter a name" }); }
		if (name.length > watchlist.MAX_NAME) { errors.push({ field: "name", message: "Name is too long (max " + watchlist.MAX_NAME + " characters)" }); }

		if (text(raw.system)) {
			const id = watchlist.findSystem(raw.system, data);
			if (id) { c.systemID = id; } else { errors.push({ field: "system", message: "Unknown system \"" + text(raw.system) + "\"" }); }
		}
		if (text(raw.region)) {
			const id = watchlist.findRegion(raw.region, data);
			if (id) { c.regionID = id; } else { errors.push({ field: "region", message: "Unknown region \"" + text(raw.region) + "\"" }); }
		}
		if (text(raw.constellation)) {
			const id = watchlist.findSystem(raw.constellation, data);
			const s = id ? ix.systems[id] : null;
			if (s && s.constellationID) { c.constellationID = Number(s.constellationID); c.constellationRef = id; }
			else { errors.push({ field: "constellation", message: "Unknown system \"" + text(raw.constellation) + "\"" }); }
		}
		c.classes = raw.classes;
		c.effects = raw.effects;
		c.staticLeadsTo = raw.staticLeadsTo;
		c.whLeadsTo = raw.whLeadsTo;
		c.minSize = raw.minSize;
		[["staticType", "static"], ["whType", "connection"]].forEach(function(pair) {
			const value = text(raw[pair[0]]);
			if (!value) { return; }
			const code = watchlist.typeCode(value);
			if (!code || code === "K162" || !ix.wormholes[code]) {
				errors.push({ field: pair[0], message: "Unknown wormhole type \"" + value + "\"" + (code === "K162" ? " (K162 is the exit side of any hole)" : "") });
			} else {
				c[pair[0]] = code;
			}
		});
		[["maxJumpsMe", "from you"], ["maxJumpsHome", "from home"]].forEach(function(pair) {
			const value = text(raw[pair[0]]);
			if (!value) { return; }
			const n = watchlist.positiveInt(value);
			if (n === null) { errors.push({ field: pair[0], message: "Jumps " + pair[1] + ": a whole number from 0 to 999" }); } else { c[pair[0]] = n; }
		});
		const conditions = watchlist.normaliseConditions(c);
		if (!errors.length && !watchlist.hasConditions(conditions)) {
			errors.push({ field: "", message: "Add at least one condition" });
		}
		if (errors.length) { return { errors: errors }; }
		const id = raw.id && (existing || []).some(function(f) { return f && f.id === raw.id; }) ? raw.id : watchlist.newID(existing, now);
		return { filter: { id: id, name: name, enabled: raw.enabled !== false, conditions: conditions } };
	},

	/** Form values for a filter (the reverse of fromForm) */
	toForm: function(filter, data) {
		const ix = watchlist.index(data);
		const c = (filter && filter.conditions) || {};
		const name = function(id) { return id && ix.systems[id] ? ix.systems[id].name : ""; };
		return {
			id: filter ? filter.id : "",
			name: filter ? filter.name : "",
			enabled: filter ? filter.enabled !== false : true,
			system: name(c.systemID),
			region: c.regionID && ix.regions[c.regionID] ? ix.regions[c.regionID].name : "",
			constellation: name(c.constellationRef),
			classes: (c.classes || []).slice(),
			effects: (c.effects || []).slice(),
			staticLeadsTo: c.staticLeadsTo || "",
			staticType: c.staticType || "",
			whType: c.whType || "",
			whLeadsTo: c.whLeadsTo || "",
			minSize: c.minSize || "",
			maxJumpsMe: c.maxJumpsMe === undefined ? "" : String(c.maxJumpsMe),
			maxJumpsHome: c.maxJumpsHome === undefined ? "" : String(c.maxJumpsHome)
		};
	},

	/** Conditions in words, e.g. ["C5", "Wolf-Rayet", "static to C5", "through an H296", "≤ 3 jumps from you"]
	(plain text, escape before rendering) */
	describe: function(c, data) {
		c = c || {};
		const ix = watchlist.index(data);
		const label = function(list, key) { const x = list.filter(function(i) { return i.key === key; })[0]; return x ? x.label : key; };
		const parts = [];
		if (c.systemID) { parts.push(ix.systems[c.systemID] ? ix.systems[c.systemID].name : String(c.systemID)); }
		if (c.regionID) { parts.push("in " + (ix.regions[c.regionID] ? ix.regions[c.regionID].name : "region " + c.regionID)); }
		if (c.constellationID) {
			parts.push("in the constellation of " + (c.constellationRef && ix.systems[c.constellationRef] ? ix.systems[c.constellationRef].name : c.constellationID));
		}
		if (c.classes) { parts.push(c.classes.map(function(k) { return label(watchlist.CLASSES, k); }).join(" or ")); }
		if (c.effects) { parts.push(c.effects.map(function(k) { return label(watchlist.EFFECTS, k); }).join(" or ")); }
		if (c.staticLeadsTo) { parts.push("static to " + label(watchlist.CLASSES, c.staticLeadsTo)); }
		if (c.staticType) { parts.push("static " + c.staticType); }
		if (c.whType) { parts.push("hole " + c.whType); }
		if (c.whLeadsTo) { parts.push("hole type to " + label(watchlist.CLASSES, c.whLeadsTo)); }
		if (c.minSize) { parts.push("hole size " + c.minSize + (c.minSize === "XL" ? "" : " or larger")); }
		if (c.maxJumpsMe !== undefined) { parts.push("≤ " + c.maxJumpsMe + " jump" + (c.maxJumpsMe === 1 ? "" : "s") + " from you"); }
		if (c.maxJumpsHome !== undefined) { parts.push("≤ " + c.maxJumpsHome + " jump" + (c.maxJumpsHome === 1 ? "" : "s") + " from home"); }
		return parts;
	},

	/** Key for the chain the matches belong to (mask and chain tab), so switching tabs or masks keeps
	each chain's "already announced" state. tab: the current chain tab's systems ("" when there is no tab and the
	chain starts at the viewed system) */
	contextKey: function(mask, tab) {
		const t = tab === undefined || tab === null || tab === "" ? "viewing" : String(tab);
		return String(mask === undefined || mask === null ? "" : mask) + "#" + t;
	},

	/** Whether two mask IDs are the same mask ("98000001.2", 98000001.2) */
	sameMask: function(a, b) {
		if (a === undefined || a === null || a === "" || b === undefined || b === null || b === "") { return false; }
		return String(a) === String(b) || Number(a) === Number(b);
	},

	/** The loaded filters ({loaded, mask: {id}, filters}) to match with on the active mask: null while none are
	loaded or they are another mask's (after a mask switch, until the new mask's have loaded) */
	filtersFor: function(server, activeMask) {
		if (!server || !server.loaded || !server.mask || !watchlist.sameMask(server.mask.id, activeMask)) { return null; }
		return server.filters || [];
	},

	/** Whether to ask for the active mask's filters now: they aren't loaded, no request for this mask is under way,
	and the last one for it (request: {mask, at, pending}) was at least MASK_RETRY_MS ago */
	needsReload: function(server, activeMask, request, now) {
		if (watchlist.filtersFor(server, activeMask) !== null) { return false; }
		if (!request || !watchlist.sameMask(request.mask, activeMask)) { return true; }
		return !request.pending && now - request.at >= watchlist.MASK_RETRY_MS;
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	(function() {
		const wl = watchlist;
		const STORAGE_KEY = "tripwire_watchlist_seen";
		const LOCATION_CHECK_MS = 2000;
		let lastMatches = [];		// matches on the chain as last drawn
		let lastHoles = {};			// {<wormholeID>: [filter names]}: the holes marked on the map (markers on)
		let lastTracked = null;		// tracked system when the chain was last matched
		let renderTimer = null;
		let seen = loadSeen();		// {<context>: {<filterID|systemID>: last matched}}: already announced, per mask and chain tab
		// The mask's filters (public/watchlist.php): every member reads them, the corporation's admins change them
		const server = { loaded: false, available: false, canEdit: false, filters: [], csrf: "", mask: null, error: "", loadedAt: 0 };
		let maskRequest = null;		// {mask, at, pending, retries}: the last request for the filters after a mask switch

		function current() { return wl.settings(options); }
		function trackedSystem() { return tripwire.client && tripwire.client.EVE ? tripwire.client.EVE.systemID : null; }
		function redrawChain() { if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); } }

		// "Already announced" survives a page reload within the browser session (sessionStorage), never required
		function loadSeen() {
			try {
				const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}");
				return raw && typeof raw === "object" ? raw : {};
			} catch (e) { return {}; }
		}
		function storeSeen() {
			try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(seen)); } catch (e) { /* private mode etc.: memory only */ }
		}

		function activeMask() { return options.masks ? options.masks.active : ""; }

		function contextKey() {
			const $tab = $("#chainTabs .current .name");
			const tab = $tab.length ? $tab.data("tab") : "";
			return wl.contextKey(activeMask(), tab);
		}

		// ---- The mask's filters ----

		function errorText(xhr) {
			return (xhr && xhr.responseJSON && xhr.responseJSON.error) || "Request failed" + (xhr && xhr.status ? " (HTTP " + xhr.status + ")" : "");
		}

		function absorb(data) {
			server.loaded = true;
			server.available = !!(data && data.available);
			server.canEdit = !!(data && data.canEdit);
			server.filters = wl.normaliseFilters(data && data.filters);
			server.csrf = (data && data.csrf) || "";
			server.mask = data && data.mask ? data.mask : null;
			server.error = "";
			server.loadedAt = Date.now();
		}

		/** After a mask switch: ask for the new mask's filters (the server answers for the mask of the session, which
		follows options.save(), so ask again a few times while it still answers for the previous one) */
		function reloadForMask() {
			const mask = activeMask();
			if (!wl.needsReload(server, mask, maskRequest, Date.now())) { return; }
			const retries = maskRequest && wl.sameMask(maskRequest.mask, mask) ? maskRequest.retries + 1 : 0;
			if (retries > wl.MASK_RETRIES) { return; }	// the minute's poll takes over
			const request = maskRequest = { mask: mask, at: Date.now(), pending: true, retries: retries };
			loadFilters().always(function() {
				request.pending = false;
				if (wl.filtersFor(server, activeMask()) === null) { setTimeout(reloadForMask, wl.MASK_RETRY_MS); }
				else if (maskRequest === request) { maskRequest = null; }
			});
		}

		function loadFilters() {
			return $.ajax({ url: wl.URL, type: "GET", data: { mode: "get" }, dataType: "JSON", cache: false }).done(function(data) {
				const state = function() { return JSON.stringify(server.filters) + server.canEdit + (server.mask ? server.mask.id : ""); };
				const before = state();
				absorb(data);
				if (state() !== before) { redrawChain(); }
				renderAll();
			}).fail(function(xhr) {
				server.error = errorText(xhr);
				renderAll();
			});
		}

		/** An admin's change; the answer is the new list */
		function request(mode, payload) {
			if (typeof forkUsage !== "undefined") { forkUsage.track("watchlist", "configured"); }
			return $.ajax({
				url: wl.URL, type: "POST", contentType: "application/json", dataType: "JSON",
				data: JSON.stringify(Object.assign({ mode: mode }, payload || {})),
				headers: { "X-CSRF-Token": server.csrf, "X-Requested-With": "XMLHttpRequest" }
			}).done(function(data) {
				absorb(data);
				redrawChain();
				renderAll();
			});
		}

		// ---- Chain data for matching ----

		function lastStep(row) {
			const pathHome = row && Array.isArray(row.pathHome) ? row.pathHome : [];
			return pathHome[pathHome.length - 1] || null;
		}

		/** The connection's real wormhole type (not K162), from Tripwire's wormholes, EVE-Scout links or the node */
		function typeFor(wormholeID, row) {
			let type = null;
			if (typeof sizeTags !== "undefined" && sizeTags.wormholeTypeFor) {
				type = sizeTags.wormholeTypeFor(wormholeID);
			} else if (tripwire.client && tripwire.client.wormholes && tripwire.client.wormholes[wormholeID]) {
				type = tripwire.client.wormholes[wormholeID].type;
			}
			if (!wl.typeCode(type) || wl.typeCode(type) === "K162") {
				const step = lastStep(row);
				if (step && wl.typeCode(step.type) && wl.typeCode(step.type) !== "K162") { type = step.type; }
			}
			return type;
		}

		/** Max ship size of the connection (size tags' classes), guessed from the classes when the type is unknown */
		function sizeFor(row, type, parentSystemID) {
			if (typeof sizeTags === "undefined" || !sizeTags.tagFor) { return null; }
			try {
				const step = lastStep(row);
				const childType = step && step.type ? step.type : "K162";
				const otherType = type && type !== childType ? type : "K162";
				const tag = sizeTags.tagFor(otherType, childType, parentSystemID, row.c[0].systemID);
				return tag ? tag.size : null;
			} catch (e) { return null; }
		}

		/** Match the filters against a freshly built chain (chain.nodes() output), mark the nodes and holes, announce
		new matches */
		function evaluate(result) {
			const settings = current();
			lastTracked = trackedSystem();
			// Only the active mask's filters: after a mask switch the previous mask's stay loaded until the new ones come
			const filters = wl.filtersFor(server, activeMask());
			if (server.loaded && filters === null) { reloadForMask(); }
			if (!server.available || !filters || !filters.length) {
				lastMatches = [];
				lastHoles = {};
				scheduleRender();
				return;
			}
			const model = wl.chainModel(result, { typeFor: typeFor, sizeFor: sizeFor, trackedSystemID: lastTracked });
			const matches = wl.match(filters, model, appData);
			lastMatches = matches;
			lastHoles = settings.markers ? wl.namesByHole(matches) : {};
			if (settings.markers) {
				wl.decorate(result, wl.namesByNode(matches));
				wl.decorateHoles(result, lastHoles);
			}
			const key = contextKey();
			const onChain = model.entries.map(function(e) { return e.systemID; });
			const d = wl.diff(seen[key], matches, onChain, Date.now());
			seen[key] = d.seen;
			storeSeen();
			if (d.fresh.length) { notify(d.fresh, settings); }
			scheduleRender();
		}

		// ---- Chain map hook (installed now, before the first draw, and again on ready if another feature wrapped
		// chain.nodes after us: the marks must go on last, after e.g. size tags rebuilt node.sizeTag) ----
		let nodesDepth = 0;
		let outerHook = null;
		function installHook() {
			if (typeof chain === "undefined" || !chain || typeof chain.nodes !== "function" || chain.nodes === outerHook) { return; }
			const originalNodes = chain.nodes;
			const wrapped = function() {
				nodesDepth++;
				try {
					const result = originalNodes.apply(this, arguments);
					if (nodesDepth === 1) {	// only the outermost of our wrappers matches
						try { evaluate(result); } catch (e) { console.error("Watchlist: matching failed", e); }
					}
					return result;
				} finally { nodesDepth--; }
			};
			Object.keys(originalNodes).forEach(function(k) { wrapped[k] = originalNodes[k]; });	// keep other features' "wrapped" flags
			wrapped.watchlistWrapped = true;
			chain.nodes = outerHook = wrapped;
		}
		installHook();

		// ---- Signature table: the signatures of marked holes ----

		let sigTimer = null;
		function scheduleSignatures() {
			clearTimeout(sigTimer);
			sigTimer = setTimeout(markSignatures, 0);
		}

		/** Mark the rows of the viewed system's signatures that are an end of a marked hole (tint, an eye in the Leads To
		cell, the filters in its tooltip) */
		function markSignatures() {
			const holes = tripwire.client && tripwire.client.wormholes ? tripwire.client.wormholes : {};
			const bySig = {};
			Object.keys(lastHoles).forEach(function(id) {
				const w = holes[id];
				if (!w) { return; }
				bySig[w.initialID] = lastHoles[id];
				bySig[w.secondaryID] = lastHoles[id];
			});
			$("#sigTable tbody tr[data-id]").each(function() {
				const $row = $(this);
				const names = bySig[$row.attr("data-id")];
				const marked = $row.hasClass("watchlist-sig");
				if (!names && !marked) { return; }
				$row.toggleClass("watchlist-sig", !!names);
				const $cell = $row.children("td").eq(3);	// Leads To (where the eye is drawn)
				if (names) { $cell.attr("title", "Watchlist: " + names.join(", ")); } else { $cell.removeAttr("title"); }
			});
		}

		// ---- Pop-ups and sound ----

		function systemLink(id, extra) {
			const esc = wl.escape;
			const s = systemAnalysis.analyse(id);
			return "<a href='.?system=" + encodeURIComponent(s.name || "") + "' class='" + esc(s.systemTypeClass) + "'" + (extra || "") + ">" + esc(s.name || id) + "</a>";
		}

		function toastHtml(group) {
			const esc = wl.escape;
			const shown = group.systemIDs.slice(0, 6);
			const links = shown.map(function(id) {
				return systemLink(id) + " <span class='watchlist-toast-class'>" + esc(systemAnalysis.analyse(id).systemTypeName) + "</span>";
			}).join(", ");
			const more = group.systemIDs.length - shown.length;
			return "<div class='watchlist-toast' role='status'>"
				+ "<span class='watchlist-toast-close' title='Dismiss'>&#10005;</span>"
				+ "<div class='watchlist-toast-title'><i data-icon='eye'></i> Watchlist: <strong>" + esc(group.filterName) + "</strong></div>"
				+ "<div class='watchlist-toast-text'>On the chain: " + links + (more > 0 ? " and " + more + " more" : "") + "</div>"
				+ "</div>";
		}

		function notify(fresh, settings) {
			if (settings.popups) {
				let $box = $("#watchlist-toasts");
				if (!$box.length) {
					$box = $("<div id='watchlist-toasts' aria-live='polite'></div>").appendTo("body");
					$box.on("click", ".watchlist-toast-close", function() { $(this).closest(".watchlist-toast").remove(); });
				}
				wl.groupByFilter(fresh).forEach(function(group) {
					const $toast = $(toastHtml(group));
					$box.append($toast);
					setTimeout(function() { $toast.fadeOut(400, function() { $toast.remove(); }); }, wl.TOAST_MS);
				});
				while ($box.children(".watchlist-toast").length > 4) { $box.children(".watchlist-toast").first().remove(); }
			}
			// The sound comes from Kill Reporting's sound pack (its tones)
			if (settings.soundEnabled && typeof killReporting !== "undefined" && typeof killReporting.play === "function") {
				killReporting.play(settings.sound, settings.volume, "neutral");
			}
		}

		// ---- Panel and Mask Admin page ----

		function scheduleRender() {
			clearTimeout(renderTimer);
			renderTimer = setTimeout(renderAll, 0);
		}

		function renderAll() {
			render();
			renderAdmin();
			markSignatures();
		}

		function rowHtml(filter, matchesByFilter, editable) {
			const esc = wl.escape;
			const ids = matchesByFilter[filter.id] || [];
			const desc = wl.describe(filter.conditions, appData).join(" · ");
			const hits = !filter.enabled ? "paused" : ids.length ? ids.length + " on chain" : "none on chain";
			const matches = filter.enabled && ids.length
				? "<div class='wl-matches'>" + ids.map(function(id) { return systemLink(id); }).join(", ") + "</div>"
				: "";
			return "<li class='wl-row" + (filter.enabled ? "" : " wl-off") + (filter.enabled && ids.length ? " wl-hit" : "") + (editable ? "" : " wl-readonly") + "' data-id='" + esc(filter.id) + "'>"
				+ "<div class='wl-head'>"
				+ (editable
					? "<input type='checkbox' class='wl-enabled'" + (filter.enabled ? " checked" : "") + " title='" + esc(filter.enabled ? "Watching: click to pause this filter for everyone on the mask" : "Paused: click to watch again") + "' />"
					: "<i class='wl-state' data-icon='eye' title='" + esc(filter.enabled ? "Watching" : "Paused by an admin") + "'></i>")
				+ "<span class='wl-name' title='" + esc(filter.name) + "'>" + esc(filter.name) + "</span>"
				+ "<span class='wl-hits'>" + esc(hits) + "</span>"
				+ (editable
					? "<i class='wl-edit' data-icon='edit' title='Edit " + esc(filter.name) + "'></i>"
						+ "<i class='wl-delete' data-icon='trash' title='Delete " + esc(filter.name) + "'></i>"
					: "")
				+ "</div>"
				+ "<div class='wl-desc' title='" + esc(desc) + "'>" + esc(desc) + "</div>"
				+ matches
				+ "</li>";
		}

		/** The list for the panel and the Mask Admin page */
		function listHtml(editable) {
			const byFilter = {};
			wl.groupByFilter(lastMatches).forEach(function(g) { byFilter[g.filterID] = g.systemIDs; });
			if (!server.loaded) { return "<li class='wl-empty'>" + (server.error ? wl.escape(server.error) : "Loading...") + "</li>"; }
			if (!server.available) {
				return "<li class='wl-empty'>The watchlist belongs to your corporation's masks: switch to the corp mask (or a corporation custom mask) to see its filters.</li>";
			}
			if (!server.filters.length) {
				return "<li class='wl-empty'>" + (editable
					? "No filters yet. Add one to tell everyone on the mask when the chain map has what you are looking for: a J-code or system, a class, an effect, a static or a hole type."
					: "No filters yet. Your corporation's Tripwire admins set them in Mask Admin &gt; Watchlist.") + "</li>";
			}
			return server.filters.map(function(f) { return rowHtml(f, byFilter, editable); }).join("");
		}

		function countText() {
			if (!server.filters.length) { return ""; }
			const byFilter = {};
			wl.groupByFilter(lastMatches).forEach(function(g) { byFilter[g.filterID] = true; });
			const hits = server.filters.filter(function(f) { return f.enabled && byFilter[f.id]; }).length;
			return "(" + hits + " of " + server.filters.length + " matching)";
		}

		function render() {
			const $widget = $("#" + wl.WIDGET_ID);
			if (!$widget.length) { return; }
			$widget.find(".wl-list").html(listHtml(server.canEdit));
			$widget.find(".wl-count").text(countText());
			$widget.find(".wl-toolbar").toggleClass("hidden", !server.canEdit);
			$widget.find(".wl-note").toggleClass("hidden", server.canEdit || !server.available)
				.text("Set by your corporation's Tripwire admins (Mask Admin > Watchlist).");
		}
		wl.render = render;

		function renderAdmin() {
			const $page = $("#dialog-admin .window [data-window='watchlist'] .wl-admin");
			if (!$page.length) { return; }
			$page.find(".wl-list").html(listHtml(server.canEdit));
			$page.find(".wl-count").text(countText());
			$page.find(".wl-admin-title").text("Watchlist for the " + (server.mask ? server.mask.name : "") + " mask");
			$page.find(".wl-admin-error").toggleClass("hidden", !server.error || server.canEdit).text(server.error);
		}

		function widgetHtml() {
			return "<li id='" + wl.WIDGET_ID + "' class='gridWidget'>"
				+ "<div class='controls'>"
				+ "<span class='wl-title'><i data-icon='eye'></i> Watchlist <span class='wl-count'></span></span>"
				+ "</div>"
				+ "<div class='content'>"
				+ "<div class='wl-toolbar hidden'><input type='button' class='wl-new' value='New filter' /></div>"
				+ "<ul class='wl-list'></ul>"
				+ "<div class='wl-note hidden'></div>"
				+ "</div>"
				+ "</li>";
		}

		function adminPageHtml() {
			return "<div class='wl-admin'>"
				+ "<h2 class='wl-admin-title'>Watchlist</h2>"
				+ "<p class='wl-small'>Filters for everyone on this mask: when a system on the chain map matches one, they get a pop-up and a sound (each member can turn those off in Settings &gt; Kills &amp; Intel &gt; Watchlist), and the system, the hole into it and its signature are marked. To post matches to Discord, turn on <b>Watchlist match</b> in Mask Admin &gt; Discord: only systems connected to the home system set there are posted, not old chain fragments.</p>"
				+ "<p class='wl-admin-error dn-bad hidden'></p>"
				+ "<div class='wl-toolbar'><input type='button' class='wl-new' value='New filter' /> <span class='wl-count wl-small'></span></div>"
				+ "<ul class='wl-list'></ul>"
				+ "</div>";
		}

		/** The panel as panelHost (panel-host.js) takes it */
		const panel = { id: wl.WIDGET_ID, title: "Watchlist", key: "watchlist",
			size: { x: wl.DEFAULT_SIZE.x, y: wl.DEFAULT_SIZE.y, minX: wl.MIN_SIZE.x, minY: wl.MIN_SIZE.y } };

		/** Default place: below the existing widgets, at the left */
		function defaultPlacement(widgets) {
			let maxRow = 0;
			(widgets || []).forEach(function(w) { if (w) { maxRow = Math.max(maxRow, (Number(w.row) || 1) + (Number(w.size_y) || 1) - 1); } });
			return { col: 1, row: maxRow + 1, size_x: wl.DEFAULT_SIZE.x, size_y: wl.DEFAULT_SIZE.y };
		}

		function addWidget() {
			// The saved layout, else where it was when it was turned off (kept), else under everything
			const $widget = panelHost.addGridWidget(panel, widgetHtml(), { transition: false, place: function(others, g) {
				return panelHost.atLeastMinSize(panelHost.gridEntry(options.grid, wl.WIDGET_ID), panel.size)
					|| panelHost.atLeastMinSize(current().position, panel.size)
					|| defaultPlacement(g.serialize());
			} });
			if ($widget) { render(); }
		}

		function removeWidget() {
			// Remember where it was, so turning it back on puts it in the same place
			panelHost.removeGridWidget(panel, $("#" + wl.WIDGET_ID), { remember: "watchlist", finishFade: true });
		}

		function applySettings() {
			const settings = current();
			if (settings.enabled) { addWidget(); } else { removeWidget(); }
			if (!settings.popups) { $("#watchlist-toasts").empty(); }
			render();
		}

		// ---- Filter editor (admins) ----

		function checkboxes(name, list) {
			return list.map(function(x) {
				return "<label class='wl-check'" + (x.title ? " title='" + wl.escape(x.title) + "'" : "") + "><input type='checkbox' name='" + name + "' value='" + wl.escape(x.key) + "' /> " + wl.escape(x.label) + "</label>";
			}).join("");
		}

		function classSelect(name, anyLabel) {
			return "<select name='" + name + "'><option value=''>" + wl.escape(anyLabel) + "</option>"
				+ wl.CLASSES.map(function(x) { return "<option value='" + wl.escape(x.key) + "'>" + wl.escape(x.label) + "</option>"; }).join("")
				+ "</select>";
		}

		function editorHtml() {
			return "<div id='dialog-watchlist' class='hidden'>"
				+ "<form class='wl-form' autocomplete='off'>"
				+ "<div class='wl-errors hidden'></div>"
				+ "<table class='optionsTable wl-form-table'>"
				+ "<tr><th>Name:</th><td><input type='text' name='name' maxlength='" + wl.MAX_NAME + "' placeholder='e.g. C5 with a Wolf-Rayet' /></td></tr>"
				+ "<tr><td></td><td class='wl-hint'>For everyone on the mask. A system on the chain map matches when it meets every condition you fill in; leave the rest empty.</td></tr>"
				+ "<tr><th>System:</th><td><input type='text' name='system' placeholder='J-code or k-space system, e.g. J123450 or Jita' /></td></tr>"
				+ "<tr><th>Region:</th><td><input type='text' name='region' placeholder='e.g. The Forge' /></td></tr>"
				+ "<tr><th>Constellation:</th><td><input type='text' name='constellation' placeholder='The constellation of this system, e.g. Jita' /></td></tr>"
				+ "<tr><th>Class:</th><td class='wl-checks'><div class='wl-check-grid'>" + checkboxes("classes", wl.CLASSES) + "</div><div class='wl-hint'>Any of the ticked classes</div></td></tr>"
				+ "<tr><th>Effect:</th><td class='wl-checks'>" + checkboxes("effects", wl.EFFECTS) + "<div class='wl-hint'>Any of the ticked effects</div></td></tr>"
				+ "<tr><th>Static:</th><td>leads to " + classSelect("staticLeadsTo", "any class") + " &nbsp; type <input type='text' name='staticType' class='wl-code' placeholder='e.g. H296' /></td></tr>"
				+ "<tr><th>Connection:</th><td>hole type <input type='text' name='whType' class='wl-code' placeholder='e.g. H296' /> &nbsp; leads to " + classSelect("whLeadsTo", "any class")
				+ " &nbsp; size at least <select name='minSize'><option value=''>any</option>"
				+ wl.SIZES.map(function(s) { return "<option value='" + s + "'>" + s + "</option>"; }).join("") + "</select>"
				+ "<div class='wl-hint'>Any wormhole of the system on the chain map (in or out); type, leads to and size must fit the same hole. <em>Leads to</em> is the hole type's destination (H296: C5), whichever side was scanned. Sizes: S frigates, M up to battlecruisers, L battleships, VL freighters, XL capitals.</div></td></tr>"
				+ "<tr><th>Jumps:</th><td>at most <input type='text' inputmode='numeric' name='maxJumpsMe' class='wl-num' maxlength='3' /> from you"
				+ " &nbsp; at most <input type='text' inputmode='numeric' name='maxJumpsHome' class='wl-num' maxlength='3' /> from home"
				+ "<div class='wl-hint'>Wormhole jumps on each member's chain map; home is where their chain starts. Filters with a jump limit depend on who is looking, so they are not posted to Discord.</div></td></tr>"
				+ "</table>"
				+ "</form>"
				+ "</div>";
		}

		let editingID = null;

		function readForm($form) {
			const val = function(n) { return $form.find("[name='" + n + "']").val(); };
			const checked = function(n) { return $form.find("input[name='" + n + "']:checked").map(function() { return this.value; }).get(); };
			const existing = editingID ? server.filters.filter(function(f) { return f.id === editingID; })[0] : null;
			return {
				id: editingID, name: val("name"), system: val("system"), region: val("region"), constellation: val("constellation"),
				classes: checked("classes"), effects: checked("effects"), staticLeadsTo: val("staticLeadsTo"), staticType: val("staticType"),
				whType: val("whType"), whLeadsTo: val("whLeadsTo"), minSize: val("minSize"),
				maxJumpsMe: val("maxJumpsMe"), maxJumpsHome: val("maxJumpsHome"),
				enabled: existing ? existing.enabled : true
			};
		}

		function fillForm($form, values) {
			["name", "system", "region", "constellation", "staticLeadsTo", "staticType", "whType", "whLeadsTo", "minSize", "maxJumpsMe", "maxJumpsHome"].forEach(function(n) {
				$form.find("[name='" + n + "']").val(values[n] || "");
			});
			$form.find("input[name='classes']").each(function() { this.checked = values.classes.indexOf(this.value) >= 0; });
			$form.find("input[name='effects']").each(function() { this.checked = values.effects.indexOf(this.value) >= 0; });
			$form.find(".wl-errors").addClass("hidden").empty();
			$form.find(".wl-invalid").removeClass("wl-invalid");
		}

		function showErrors($form, messages) {
			$form.find(".wl-errors").removeClass("hidden").html(messages.map(function(m) { return "<div>" + wl.escape(m) + "</div>"; }).join(""));
		}

		function saveEditor() {
			const $form = $("#dialog-watchlist .wl-form");
			const result = wl.fromForm(readForm($form), appData, server.filters, Date.now());
			$form.find(".wl-invalid").removeClass("wl-invalid");
			if (result.errors) {
				showErrors($form, result.errors.map(function(e) { return e.message; }));
				result.errors.forEach(function(e) { if (e.field) { $form.find("[name='" + e.field + "']").addClass("wl-invalid"); } });
				return;
			}
			if (!editingID && server.filters.length >= wl.MAX_FILTERS) {
				showErrors($form, ["A mask can have up to " + wl.MAX_FILTERS + " filters"]);
				return;
			}
			// A new filter gets its ID from the server
			const filter = Object.assign({}, result.filter, { id: editingID || "" });
			request("filter-save", { filter: filter }).done(function() {
				$("#dialog-watchlist").dialog("close");
			}).fail(function(xhr) {
				showErrors($form, (xhr.responseJSON && xhr.responseJSON.errors) || [errorText(xhr)]);
			});
		}

		let searchSources = null;
		function sources() {
			if (!searchSources) {
				const systems = {};
				for (const id in appData.systems) { if (wl.toID(id)) { systems[id] = appData.systems[id]; } }
				const regions = Object.keys(appData.regions || {}).map(function(id) { return appData.regions[id].name; }).sort();
				const types = Object.keys(appData.wormholes || {}).filter(function(t) { return wl.typeCode(t) && t !== "K162"; }).sort();
				searchSources = { systems: systems, regions: regions, types: types };
			}
			return searchSources;
		}

		function openEditor(filterID) {
			if (!server.canEdit) { return; }
			let $dialog = $("#dialog-watchlist");
			if (!$dialog.length) {
				$("body").append(editorHtml());
				$dialog = $("#dialog-watchlist");
				$dialog.dialog({
					autoOpen: false,
					resizable: false,
					modal: false,
					width: 640,
					dialogClass: "dialog-noeffect ui-dialog-shadow dialog-watchlist",
					buttons: {
						Save: saveEditor,
						Cancel: function() { $(this).dialog("close"); }
					}
				});
				$dialog.find(".wl-form").on("submit", function(e) { e.preventDefault(); saveEditor(); });
				if ($.fn.inlinecomplete) {
					const s = sources();
					$dialog.find("[name='system'], [name='constellation']").inlinecomplete({ source: s.systems, renderer: "system", maxSize: 10, delay: 0 });
					$dialog.find("[name='region']").inlinecomplete({ source: s.regions, maxSize: 10, delay: 0 });
					$dialog.find("[name='staticType'], [name='whType']").inlinecomplete({ source: s.types, maxSize: 10, delay: 0 });
				}
			}
			const filter = filterID ? server.filters.filter(function(f) { return f.id === filterID; })[0] : null;
			editingID = filter ? filter.id : null;
			fillForm($dialog.find(".wl-form"), wl.toForm(filter, appData));
			$dialog.dialog("option", "title", filter ? "Edit watchlist filter" : "New watchlist filter");
			$dialog.dialog("open");
			$dialog.closest(".ui-dialog").css("z-index", 10001);	// above Mask Admin
			$dialog.find("[name='name']").focus();
		}
		wl.openEditor = openEditor;

		// ---- Settings > Kills & Intel ----

		function setupSettings() {
			const sounds = wl.SOUNDS.map(function(id) {
				const tone = typeof killReporting !== "undefined" ? killReporting.tones.filter(function(t) { return t.id === id; })[0] : null;
				return "<option value='" + id + "'>" + wl.escape(tone ? tone.label : id) + "</option>";
			}).join("");
			// Takes effect on Save; Reset deletes the key (everything back to the defaults, a missing key means on)
			forkSettings.register({
				section: "intel", order: 50, id: "watchlist", type: "custom", key: "watchlist", label: "Watchlist:",
				html: "<label><input type='checkbox' id='watchlist-enabled' /> Show the Watchlist panel</label><br/>"
					+ "<label><input type='checkbox' id='watchlist-popups' /> Pop-up for a new match</label><br/>"
					+ "<label><input type='checkbox' id='watchlist-markers' /> Mark matches on the chain map and signatures</label><br/>"
					+ "<label><input type='checkbox' id='watchlist-sound-on' /> Sound for a new match:</label> <select id='watchlist-sound'>" + sounds + "</select>",
				load: function() {
					const s = current();
					$("#watchlist-enabled").prop("checked", s.enabled);
					$("#watchlist-popups").prop("checked", s.popups);
					$("#watchlist-markers").prop("checked", s.markers);
					$("#watchlist-sound-on").prop("checked", s.soundEnabled);
					$("#watchlist-sound").val(s.sound);
				},
				save: function(o) {
					const kept = {};
					if (o.watchlist && o.watchlist.position) { kept.position = o.watchlist.position; }
					o.watchlist = Object.assign(kept, {
						enabled: $("#watchlist-enabled").prop("checked"),
						popups: $("#watchlist-popups").prop("checked"),
						markers: $("#watchlist-markers").prop("checked"),
						soundEnabled: $("#watchlist-sound-on").prop("checked"),
						sound: $("#watchlist-sound").val()
					});
				}
			});

			// Save and Reset both end in options.apply(): show/hide the panel and mark again
			if (!options.apply.watchlistWrapped) {
				const apply = options.apply;
				const wrapped = function() {
					const result = apply.apply(this, arguments);
					try { applySettings(); redrawChain(); } catch (err) { console.error("Watchlist: apply failed", err); }
					return result;
				};
				Object.keys(apply).forEach(function(k) { wrapped[k] = apply[k]; });
				wrapped.watchlistWrapped = true;
				options.apply = wrapped;
			}
		}

		// ---- Mask Admin > Watchlist ----

		function setupMaskAdmin() {
			const $dialog = $("#dialog-admin");
			// Where Mask Admin is offered, for the masks the watchlist is for (the server checks again on every change)
			if (!$dialog.length || !$("#admin").length || $("#admin").css("display") === "none") { return; }
			const active = typeof init !== "undefined" && init && Array.isArray(init.masks) ? init.masks.filter(function(m) { return m.active; })[0] : null;
			const allowed = typeof discordNotifications !== "undefined" && discordNotifications.maskAllowed ? discordNotifications.maskAllowed(active) : false;
			if (!allowed) { return; }
			if (!$dialog.find(".menu li[data-window='watchlist']").length) {
				$dialog.find(".menu ul").append("<li data-window='watchlist'><a href='#'>Watchlist</a></li>");
				$dialog.find(".window").append("<div data-window='watchlist' class='hidden'>" + adminPageHtml() + "</div>");
			}
			$(document).on("click", "#dialog-admin .menu li", function() {
				const mine = $(this).attr("data-window") === "watchlist";
				const $d = $("#dialog-admin");
				if (!$d.hasClass("ui-dialog-content")) { return; }
				$d.closest(".ui-dialog").toggleClass("wl-admin-active", mine);	// hides the "Total: n" tray
				if (mine) {
					$d.dialog("option", "height", Math.min(620, Math.max(350, $(window).height() - 40)));
					loadFilters();
				}
			});
		}

		$(function() {
			panelHost.register(panel);
			installHook();
			setupSettings();
			if (typeof forkCommands !== "undefined") {	// command palette (Ctrl+K)
				forkCommands.panelToggle({ id: "panel.watchlist", title: "Toggle Watchlist panel", key: "watchlist", icon: "eye", keywords: ["watch", "alert", "pilots"] });
			}
			applySettings();
			setupMaskAdmin();
			loadFilters();
			setInterval(function() { if (!document.hidden) { loadFilters(); } }, wl.POLL_MS);
			document.addEventListener("visibilitychange", function() {
				if (!document.hidden && Date.now() - server.loadedAt > wl.POLL_MS / 2) { loadFilters(); }
			});

			const $doc = $(document);
			$doc.on("click", "#" + wl.WIDGET_ID + " .wl-new, #dialog-admin .wl-admin .wl-new", function(e) { e.preventDefault(); openEditor(null); });
			$doc.on("click", "#" + wl.WIDGET_ID + " .wl-edit, #dialog-admin .wl-admin .wl-edit", function(e) {
				e.preventDefault();
				openEditor(String($(this).closest(".wl-row").attr("data-id")));
			});
			$doc.on("click", "#" + wl.WIDGET_ID + " .wl-delete, #dialog-admin .wl-admin .wl-delete", function(e) {
				e.preventDefault();
				const id = String($(this).closest(".wl-row").attr("data-id"));
				const filter = server.filters.filter(function(f) { return f.id === id; })[0];
				if (!filter || !window.confirm("Delete the watchlist filter \"" + filter.name + "\" for everyone on the mask?")) { return; }
				request("filter-delete", { id: id }).fail(function(xhr) { window.alert(errorText(xhr)); });
			});
			$doc.on("change", "#" + wl.WIDGET_ID + " .wl-enabled, #dialog-admin .wl-admin .wl-enabled", function() {
				const id = String($(this).closest(".wl-row").attr("data-id"));
				request("filter-enable", { id: id, enabled: this.checked }).fail(function(xhr) { window.alert(errorText(xhr)); loadFilters(); });
			});

			// The signature table is rebuilt by upstream (edits, system change): mark its rows again
			const tbody = document.querySelector("#sigTable > tbody");
			if (tbody && typeof MutationObserver !== "undefined") {
				new MutationObserver(scheduleSignatures).observe(tbody, { childList: true });
			}

			// "Jumps from you" depends on where the tracked character is: match again when they move
			setInterval(function() {
				const usesLocation = server.filters.some(function(f) { return f.enabled && f.conditions.maxJumpsMe !== undefined; });
				if (usesLocation && String(trackedSystem()) !== String(lastTracked)) { redrawChain(); }
			}, LOCATION_CHECK_MS);
		});
	})();
}
