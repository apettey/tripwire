const watchlist = {
	// Watchlist: user-defined filters ("a C5 with a Wolf-Rayet effect", "J123450", "anything through an H296 within
	// 3 jumps of me") matched against the systems and connections on the chain map. A new match shows a pop-up
	// (and plays a sound) once and marks the node on the map (fork-owned file).
	// Settings per user in options.watchlist = {enabled, sound, volume, filters: [...]}; a missing key means
	// the default (on, chime, no filters).
	// Keep `const watchlist` on the first line: the test helper strips it to define a global.
	WIDGET_ID: "watchlistWidget",
	DEFAULT_SIZE: { x: 5, y: 6 },
	MIN_SIZE: { x: 4, y: 3 },
	MAX_FILTERS: 50,
	MAX_NAME: 60,
	TOAST_MS: 15000,
	DEFAULT_SOUND: "tone-chime",
	DEFAULT_VOLUME: 70,
	SOUNDS: ["none", "tone-chime", "tone-blip", "tone-double-beep", "tone-sonar", "tone-klaxon"],

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

	/** Whether the watchlist is switched on (options.watchlist.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.watchlist && opts.watchlist.enabled === false);
	},

	/** Settings from user options with defaults filled in; filters normalised. Never mutates opts. */
	settings: function(opts) {
		const raw = opts && opts.watchlist && typeof opts.watchlist === "object" ? opts.watchlist : {};
		const sound = watchlist.SOUNDS.indexOf(raw.sound) >= 0 ? raw.sound : watchlist.DEFAULT_SOUND;
		const volume = Number(raw.volume);
		const seen = {};
		const filters = (Array.isArray(raw.filters) ? raw.filters : []).map(watchlist.normaliseFilter)
			.filter(function(f) {
				if (!f || seen[f.id]) { return false; }
				seen[f.id] = true;
				return true;
			}).slice(0, watchlist.MAX_FILTERS);
		const result = {
			enabled: raw.enabled !== false,
			sound: sound,
			volume: isFinite(volume) && raw.volume !== null && raw.volume !== "" ? Math.max(0, Math.min(100, Math.round(volume))) : watchlist.DEFAULT_VOLUME,
			filters: filters
		};
		if (raw.position && typeof raw.position === "object") { result.position = raw.position; }
		return result;
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
		return system ? watchlist.classKeys(system) : [];
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
	 * @param model chainModel() output
	 * @return [{key: "<filterID>|<systemID>", filterID, filterName, systemID, nodeIDs}]
	 */
	match: function(filters, model, data) {
		const out = [];
		const entries = model && Array.isArray(model.entries) ? model.entries : [];
		(filters || []).forEach(function(f) {
			if (!f || !f.enabled || !watchlist.hasConditions(f.conditions)) { return; }
			entries.forEach(function(entry) {
				if (watchlist.matchEntry(f.conditions, entry, data)) {
					out.push({ key: f.id + "|" + entry.systemID, filterID: f.id, filterName: f.name, systemID: entry.systemID, nodeIDs: entry.nodeIDs.slice() });
				}
			});
		});
		return out;
	},

	/** New matches since the previous evaluation of the same chain: a key seen last time isn't announced again;
	one that disappeared and comes back is. @param seen {<key>: true} from the last call (or null)
	@return {fresh: matches not in seen, seen: the keys to remember now} */
	diff: function(seen, matches) {
		const before = seen && typeof seen === "object" ? seen : {};
		const now = {};
		const fresh = [];
		(matches || []).forEach(function(m) {
			if (now[m.key]) { return; }
			now[m.key] = true;
			if (!before[m.key]) { fresh.push(m); }
		});
		return { fresh: fresh, seen: now };
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
	 * The systems on the chain map, from chain.nodes() output, for matching.
	 * @param result {map: {rows}, lines} from chain.nodes()
	 * @param opts {typeFor(wormholeID, row) -> type, sizeFor(row, type, parentSystemID) -> "S".."XL" or null,
	 *        trackedSystemID: where the user is}
	 * @return {entries: [{systemID, nodeIDs, connections: [{wormholeID, type, size}], jumpsHome, jumpsMe}]}
	 */
	chainModel: function(result, opts) {
		opts = opts || {};
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		const lines = result && Array.isArray(result.lines) ? result.lines : [];
		const wormholeByChild = {};
		lines.forEach(function(l) { if (l) { wormholeByChild[l[0]] = l[3]; } });
		const nodes = {};		// v -> {systemID, parent v}
		const byID = {};		// systemID -> entry
		const entries = [];
		const rawSystem = {};	// v -> the node's systemID as the chain has it (also unknown "x|y" systems)
		rows.forEach(function(row) { if (row && row.c && row.c[0]) { rawSystem[row.c[0].v] = row.c[0].systemID; } });
		rows.forEach(function(row) {
			if (watchlist.isExtraRow(row)) { return; }
			const node = row.c[0];
			const parentV = row.c[1] ? row.c[1].v : null;
			const systemID = watchlist.toID(node.systemID);
			nodes[node.v] = { systemID: systemID, parent: parentV };
			if (!systemID) { return; }
			let entry = byID[systemID];
			if (!entry) {
				entry = byID[systemID] = { systemID: systemID, nodeIDs: [], connections: [], jumpsHome: null, jumpsMe: null };
				entries.push(entry);
			}
			entry.nodeIDs.push(node.v);
			const home = Array.isArray(row.pathHome) ? row.pathHome.length : 0;
			if (entry.jumpsHome === null || home < entry.jumpsHome) { entry.jumpsHome = home; }
			if (parentV !== null && parentV !== undefined) {
				const wormholeID = wormholeByChild[node.v];
				let type = opts.typeFor ? opts.typeFor(wormholeID, row) : null;
				type = watchlist.typeCode(type);
				if (type === "K162") { type = null; }
				const size = opts.sizeFor ? opts.sizeFor(row, type, rawSystem[parentV]) : null;
				entry.connections.push({ wormholeID: wormholeID, type: type, size: watchlist.SIZES.indexOf(size) >= 0 ? size : null });
			}
		});

		// Wormhole jumps from the tracked system, over the chain's connections (systems linked by a parent/child node)
		const start = watchlist.toID(opts.trackedSystemID);
		if (start && byID[start]) {
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
				+ "<i data-icon='eye'></i>" + (names.length > 1 ? names.length : "") + "</span>";
			let f = node.f.replace("class='node ", "class='node watchlist-match ");
			const at = f.indexOf("<div class='nodeIcons'>");
			f = at < 0 ? f : f.substring(0, at) + badge + f.substring(at);
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
		if (c.whType) { parts.push("through " + c.whType); }
		if (c.whLeadsTo) { parts.push("through a hole type to " + label(watchlist.CLASSES, c.whLeadsTo)); }
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
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	(function() {
		const wl = watchlist;
		const STORAGE_KEY = "tripwire_watchlist_seen";
		const LOCATION_CHECK_MS = 2000;
		let lastMatches = [];		// matches on the chain as last drawn
		let lastTracked = null;		// tracked system when the chain was last matched
		let renderTimer = null;
		let seen = loadSeen();		// {<context>: {<filterID|systemID>: true}}: already announced, per mask and chain tab

		function current() { return wl.settings(options); }
		function isOn() { return wl.enabled(options); }
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

		function contextKey() {
			const $tab = $("#chainTabs .current .name");
			const tab = $tab.length ? $tab.data("tab") : "";
			return wl.contextKey(options.masks ? options.masks.active : "", tab);
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

		/** Match the filters against a freshly built chain (chain.nodes() output), mark the nodes, announce new matches */
		function evaluate(result) {
			if (!isOn()) { lastMatches = []; scheduleRender(); return; }
			const settings = current();
			lastTracked = trackedSystem();
			const model = wl.chainModel(result, { typeFor: typeFor, sizeFor: sizeFor, trackedSystemID: lastTracked });
			const matches = wl.match(settings.filters, model, appData);
			wl.decorate(result, wl.namesByNode(matches));
			lastMatches = matches;
			const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
			if (rows.length) {	// an empty map is the chain still loading: keep what was announced
				const key = contextKey();
				const d = wl.diff(seen[key], matches);
				seen[key] = d.seen;
				storeSeen();
				if (d.fresh.length) { notify(d.fresh, settings); }
			}
			scheduleRender();
		}

		// ---- Chain map hook (installed now, before the first draw) ----
		if (typeof chain !== "undefined" && chain && typeof chain.nodes === "function" && !chain.nodes.watchlistWrapped) {
			const originalNodes = chain.nodes;
			const wrapped = function() {
				const result = originalNodes.apply(this, arguments);
				try { evaluate(result); } catch (e) { console.error("Watchlist: matching failed", e); }
				return result;
			};
			Object.keys(originalNodes).forEach(function(k) { wrapped[k] = originalNodes[k]; });	// keep other features' "wrapped" flags
			wrapped.watchlistWrapped = true;
			chain.nodes = wrapped;
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
			// The sound comes from Kill Reporting's sound pack (its tones)
			if (settings.sound !== "none" && typeof killReporting !== "undefined" && typeof killReporting.play === "function") {
				killReporting.play(settings.sound, settings.volume, "neutral");
			}
		}

		// ---- Widget ----

		function scheduleRender() {
			clearTimeout(renderTimer);
			renderTimer = setTimeout(render, 0);
		}

		function rowHtml(filter, matchesByFilter) {
			const esc = wl.escape;
			const ids = matchesByFilter[filter.id] || [];
			const desc = wl.describe(filter.conditions, appData).join(" · ");
			const hits = !filter.enabled ? "paused" : ids.length ? ids.length + " on chain" : "none on chain";
			const matches = filter.enabled && ids.length
				? "<div class='wl-matches'>" + ids.map(function(id) { return systemLink(id); }).join(", ") + "</div>"
				: "";
			return "<li class='wl-row" + (filter.enabled ? "" : " wl-off") + (filter.enabled && ids.length ? " wl-hit" : "") + "' data-id='" + esc(filter.id) + "'>"
				+ "<div class='wl-head'>"
				+ "<input type='checkbox' class='wl-enabled'" + (filter.enabled ? " checked" : "") + " title='" + esc(filter.enabled ? "Watching: click to pause this filter" : "Paused: click to watch again") + "' />"
				+ "<span class='wl-name' title='" + esc(filter.name) + "'>" + esc(filter.name) + "</span>"
				+ "<span class='wl-hits'>" + esc(hits) + "</span>"
				+ "<i class='wl-edit' data-icon='edit' title='Edit " + esc(filter.name) + "'></i>"
				+ "<i class='wl-delete' data-icon='trash' title='Delete " + esc(filter.name) + "'></i>"
				+ "</div>"
				+ "<div class='wl-desc' title='" + esc(desc) + "'>" + esc(desc) + "</div>"
				+ matches
				+ "</li>";
		}

		function render() {
			const $list = $("#" + wl.WIDGET_ID + " .wl-list");
			if (!$list.length) { return; }
			const settings = current();
			const byFilter = {};
			wl.groupByFilter(lastMatches).forEach(function(g) { byFilter[g.filterID] = g.systemIDs; });
			$list.html(settings.filters.length ? settings.filters.map(function(f) { return rowHtml(f, byFilter); }).join("")
				: "<li class='wl-empty'>No filters yet. Add one to be told when the chain map has what you are looking for: a J-code or system, a class, an effect, a static or a hole type.</li>");
			const hits = settings.filters.filter(function(f) { return f.enabled && byFilter[f.id]; }).length;
			$("#" + wl.WIDGET_ID + " .wl-count").text(settings.filters.length ? "(" + hits + " of " + settings.filters.length + " matching)" : "");
		}
		wl.render = render;

		/** Save a new filter list, then match again */
		function saveFilters(filters) {
			options.watchlist = Object.assign({}, options.watchlist || {}, { filters: filters });
			options.save();
			redrawChain();
			render();
		}

		function widgetHtml() {
			return "<li id='" + wl.WIDGET_ID + "' class='gridWidget'>"
				+ "<div class='controls'>"
				+ "<span class='wl-title'><i data-icon='eye'></i> Watchlist <span class='wl-count'></span></span>"
				+ "</div>"
				+ "<div class='content'>"
				+ "<div class='wl-toolbar'><input type='button' class='wl-new' value='New filter' /></div>"
				+ "<ul class='wl-list'></ul>"
				+ "</div>"
				+ "</li>";
		}

		function gridApi() { return typeof grid !== "undefined" && grid && typeof grid.add_widget === "function" ? grid : null; }

		/** Placement from a saved gridster entry or position, or null */
		function savedPlacement(entry) {
			if (!entry) { return null; }
			const p = { col: Number(entry.col), row: Number(entry.row),
				size_x: Math.max(wl.MIN_SIZE.x, Number(entry.size_x) || 0), size_y: Math.max(wl.MIN_SIZE.y, Number(entry.size_y) || 0) };
			return p.col >= 1 && p.row >= 1 ? p : null;
		}

		/** Default place: below the existing widgets, at the left */
		function defaultPlacement(widgets) {
			let maxRow = 0;
			(widgets || []).forEach(function(w) { if (w) { maxRow = Math.max(maxRow, (Number(w.row) || 1) + (Number(w.size_y) || 1) - 1); } });
			return { col: 1, row: maxRow + 1, size_x: 7, size_y: wl.DEFAULT_SIZE.y };
		}

		function gridEntry(gridOptions, id) {
			if (typeof favouritesPanel !== "undefined" && favouritesPanel.gridEntry) { return favouritesPanel.gridEntry(gridOptions, id); }
			const entries = Array.isArray(gridOptions) ? gridOptions : Object.keys(gridOptions || {}).map(function(k) { return gridOptions[k]; });
			return entries.filter(function(e) { return e && e.id === id; })[0] || null;
		}

		function addWidget() {
			const api = gridApi();
			if (!api) { return; }
			const $existing = $("#" + wl.WIDGET_ID);
			if ($existing.length) {
				if (api.$widgets.is($existing)) { return; }
				$existing.stop(true, true).remove();	// left over from a removal still fading out
			}
			const placement = savedPlacement(gridEntry(options.grid, wl.WIDGET_ID))
				|| savedPlacement(current().position)
				|| defaultPlacement(api.serialize());
			const $widget = api.add_widget(widgetHtml(), placement.size_x, placement.size_y, placement.col, placement.row,
				null, [wl.MIN_SIZE.x, wl.MIN_SIZE.y]);
			$widget.stop(true, true);	// skip the fade-in (it never finishes in a background tab)
			// Resize handle like the other widgets: only visible while customising the layout
			$widget.find(".grid-resize").attr("data-icon", "resize").toggleClass("hidden", !$("#layout").hasClass("active"));
			render();
		}

		function removeWidget() {
			const api = gridApi();
			const $widget = $("#" + wl.WIDGET_ID);
			if (!api || !$widget.length) { return; }
			// Remember where it was, so turning it back on puts it in the same place
			const entry = gridEntry(api.serialize($widget), wl.WIDGET_ID);
			if (entry) {
				options.watchlist = Object.assign({}, options.watchlist || {}, {
					position: { col: entry.col, row: entry.row, size_x: entry.size_x, size_y: entry.size_y }
				});
			}
			api.remove_widget($widget, true);
			$widget.stop(true, true);	// finish the fade-out now, which removes the element
		}

		function applyEnabled() {
			if (isOn()) { addWidget(); } else { removeWidget(); $("#watchlist-toasts").empty(); }
			render();
		}

		// ---- Filter editor ----

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
				+ "<tr><td></td><td class='wl-hint'>A system on the chain map matches when it meets every condition you fill in; leave the rest empty.</td></tr>"
				+ "<tr><th>System:</th><td><input type='text' name='system' placeholder='J-code or k-space system, e.g. J123450 or Jita' /></td></tr>"
				+ "<tr><th>Region:</th><td><input type='text' name='region' placeholder='e.g. The Forge' /></td></tr>"
				+ "<tr><th>Constellation:</th><td><input type='text' name='constellation' placeholder='The constellation of this system, e.g. Jita' /></td></tr>"
				+ "<tr><th>Class:</th><td class='wl-checks'><div class='wl-check-grid'>" + checkboxes("classes", wl.CLASSES) + "</div><div class='wl-hint'>Any of the ticked classes</div></td></tr>"
				+ "<tr><th>Effect:</th><td class='wl-checks'>" + checkboxes("effects", wl.EFFECTS) + "<div class='wl-hint'>Any of the ticked effects</div></td></tr>"
				+ "<tr><th>Static:</th><td>leads to " + classSelect("staticLeadsTo", "any class") + " &nbsp; type <input type='text' name='staticType' class='wl-code' placeholder='e.g. H296' /></td></tr>"
				+ "<tr><th>Connection:</th><td>hole type <input type='text' name='whType' class='wl-code' placeholder='e.g. H296' /> &nbsp; leads to " + classSelect("whLeadsTo", "any class")
				+ " &nbsp; size at least <select name='minSize'><option value=''>any</option>"
				+ wl.SIZES.map(function(s) { return "<option value='" + s + "'>" + s + "</option>"; }).join("") + "</select>"
				+ "<div class='wl-hint'>The hole the chain map reaches the system through. Sizes: S frigates, M up to battlecruisers, L battleships, VL freighters, XL capitals.</div></td></tr>"
				+ "<tr><th>Jumps:</th><td>at most <input type='text' inputmode='numeric' name='maxJumpsMe' class='wl-num' maxlength='3' /> from you"
				+ " &nbsp; at most <input type='text' inputmode='numeric' name='maxJumpsHome' class='wl-num' maxlength='3' /> from home"
				+ "<div class='wl-hint'>Wormhole jumps on the chain map; home is where the chain starts.</div></td></tr>"
				+ "</table>"
				+ "</form>"
				+ "</div>";
		}

		let editingID = null;

		function readForm($form) {
			const val = function(n) { return $form.find("[name='" + n + "']").val(); };
			const checked = function(n) { return $form.find("input[name='" + n + "']:checked").map(function() { return this.value; }).get(); };
			const existing = editingID ? current().filters.filter(function(f) { return f.id === editingID; })[0] : null;
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
			const settings = current();
			const result = wl.fromForm(readForm($form), appData, settings.filters, Date.now());
			$form.find(".wl-invalid").removeClass("wl-invalid");
			if (result.errors) {
				showErrors($form, result.errors.map(function(e) { return e.message; }));
				result.errors.forEach(function(e) { if (e.field) { $form.find("[name='" + e.field + "']").addClass("wl-invalid"); } });
				return;
			}
			const filters = settings.filters.slice();
			const at = filters.map(function(f) { return f.id; }).indexOf(result.filter.id);
			if (at >= 0) {
				filters[at] = result.filter;
			} else if (filters.length >= wl.MAX_FILTERS) {
				showErrors($form, ["You can have up to " + wl.MAX_FILTERS + " filters"]);
				return;
			} else {
				filters.push(result.filter);
			}
			saveFilters(filters);
			$("#dialog-watchlist").dialog("close");
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
			const filter = filterID ? current().filters.filter(function(f) { return f.id === filterID; })[0] : null;
			editingID = filter ? filter.id : null;
			fillForm($dialog.find(".wl-form"), wl.toForm(filter, appData));
			$dialog.dialog("option", "title", filter ? "Edit watchlist filter" : "New watchlist filter");
			$dialog.dialog("open");
			$dialog.find("[name='name']").focus();
		}
		wl.openEditor = openEditor;

		// ---- Settings > General Preferences ----

		function setupSettings() {
			const $table = $("#dialog-options #optionsAccordion > div").eq(2).find("table.optionsTable").first();
			if ($table.length && !$("#watchlist-enabled").length) {
				const sounds = wl.SOUNDS.map(function(id) {
					const tone = typeof killReporting !== "undefined" ? killReporting.tones.filter(function(t) { return t.id === id; })[0] : null;
					return "<option value='" + id + "'>" + wl.escape(id === "none" ? "No sound" : tone ? tone.label : id) + "</option>";
				}).join("");
				$table.append("<tr><th>Watchlist:</th><td><label><input type='checkbox' id='watchlist-enabled' /> Show the Watchlist panel and alert when the chain has a match</label>"
					+ "<br/>Alert sound: <select id='watchlist-sound'>" + sounds + "</select></td></tr>");
				if ($("#optionsAccordion").hasClass("ui-accordion")) { $("#optionsAccordion").accordion("refresh"); }
			}
			$(document).on("dialogopen", "#dialog-options", function() {
				const s = current();
				$("#watchlist-enabled").prop("checked", s.enabled);
				$("#watchlist-sound").val(s.sound);
			});
			// Capture phase so the values are in place before upstream's Save handler applies and saves options
			document.addEventListener("click", function(e) {
				const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
				if (!button || $.trim($(button).text()) !== "Save") { return; }
				if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#watchlist-enabled").length) { return; }
				options.watchlist = Object.assign({}, options.watchlist || {}, {
					enabled: $("#watchlist-enabled").prop("checked"),
					sound: $("#watchlist-sound").val()
				});
			}, true);

			// Settings > Reset: switch and sound back to the defaults; the filters are kept (they are the user's data)
			if (typeof options.reset === "function" && !options.reset.watchlistWrapped) {
				const reset = options.reset;
				const wrapped = function() {
					const filters = this.watchlist && Array.isArray(this.watchlist.filters) ? this.watchlist.filters : null;
					const result = reset.apply(this, arguments);
					delete this.watchlist;
					if (filters && filters.length) { this.watchlist = { filters: filters }; }
					return result;
				};
				Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
				wrapped.watchlistWrapped = true;
				options.reset = wrapped;
			}

			// Save and Reset both end in options.apply(): show/hide the panel and match again
			if (!options.apply.watchlistWrapped) {
				const apply = options.apply;
				const wrapped = function() {
					const result = apply.apply(this, arguments);
					try { applyEnabled(); redrawChain(); } catch (err) { console.error("Watchlist: apply failed", err); }
					return result;
				};
				Object.keys(apply).forEach(function(k) { wrapped[k] = apply[k]; });
				wrapped.watchlistWrapped = true;
				options.apply = wrapped;
			}
		}

		$(function() {
			setupSettings();
			applyEnabled();

			const $doc = $(document);
			const sel = "#" + wl.WIDGET_ID;
			$doc.on("click", sel + " .wl-new", function(e) { e.preventDefault(); openEditor(null); });
			$doc.on("click", sel + " .wl-edit", function(e) {
				e.preventDefault();
				openEditor(String($(this).closest(".wl-row").attr("data-id")));
			});
			$doc.on("click", sel + " .wl-delete", function(e) {
				e.preventDefault();
				const id = String($(this).closest(".wl-row").attr("data-id"));
				const filter = current().filters.filter(function(f) { return f.id === id; })[0];
				if (!filter || !window.confirm("Delete the watchlist filter \"" + filter.name + "\"?")) { return; }
				saveFilters(current().filters.filter(function(f) { return f.id !== id; }));
			});
			$doc.on("change", sel + " .wl-enabled", function() {
				const id = String($(this).closest(".wl-row").attr("data-id"));
				const on = this.checked;
				saveFilters(current().filters.map(function(f) { return f.id === id ? Object.assign({}, f, { enabled: on }) : f; }));
			});

			// "Jumps from you" depends on where the tracked character is: match again when they move
			setInterval(function() {
				if (!isOn()) { return; }
				const usesLocation = current().filters.some(function(f) { return f.enabled && f.conditions.maxJumpsMe !== undefined; });
				if (usesLocation && String(trackedSystem()) !== String(lastTracked)) { redrawChain(); }
			}, LOCATION_CHECK_MS);
		});
	})();
}
