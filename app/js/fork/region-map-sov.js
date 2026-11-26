const regionMapSov = {
	// Fork-owned: the region map's Sovereignty overlay, pure logic (no DOM, testable in Node). Who holds each system:
	// alliance sovereignty, NPC faction space, faction warfare (occupier, contested %) and Sansha incursions.
	// Data: public/region_sov.php (sovereignty map + incursions, cached server-side for everyone, alliance names and
	// tickers resolved there) and the faction warfare list app/js/fw.js already loads (`fw.systems`). The panel is
	// region-map-view.js. Keep `const regionMapSov` on the first line: the test helper strips it to define a global.

	URL: "region_sov.php",
	REFRESH_MS: 10 * 60 * 1000,		// a region's data is asked again after 10 minutes (the server caches sov 1 h, incursions 10 min)
	RETRY_MS: 60 * 1000,			// after a failed request
	PENDING_MS: 20 * 1000,			// the server is still naming some alliances: ask again after 20 s ...
	PENDING_MAX: 3,					// ... at most 3 times
	LEGEND_MAX: 6,					// holders listed in the bar

	// Stable colours per alliance, readable as text on the map's dark background
	PALETTE: ["#4fc3f7", "#ffb74d", "#ce93d8", "#81c784", "#f06292", "#fff176", "#4db6ac", "#9fa8ff", "#ff8a65", "#c5e1a5",
		"#64b5f6", "#ef9a9a", "#e6ee9c", "#4dd0e1", "#f8bbd0", "#bcaaa4"],

	// Empire factions: their space (high-sec and low-sec) gets only a thin bar, no label, unless it is faction warfare
	EMPIRE: [500001, 500002, 500003, 500004, 500007, 500008],

	// [short label, colour] of the factions that hold space
	FACTIONS: {
		500001: ["Caldari", "#5fa8e8"], 500002: ["Minmatar", "#e0704f"], 500003: ["Amarr", "#e8c547"], 500004: ["Gallente", "#5fd08a"],
		500005: ["Jove", "#9aabb8"], 500006: ["CONCORD", "#6fb0d0"], 500007: ["Ammatar", "#d6b25a"], 500008: ["Khanid", "#c49a4a"],
		500009: ["Syndicate", "#a98fd0"], 500010: ["Guristas", "#e0d05a"], 500011: ["Angel", "#f08a4a"], 500012: ["Blood Raider", "#e05050"],
		500013: ["EverMore", "#cccccc"], 500014: ["ORE", "#d8b860"], 500015: ["Thukker", "#e09050"], 500016: ["Sisters", "#e8e8e8"],
		500017: ["SoCT", "#a8c8e8"], 500018: ["Mordu's", "#9fb0c0"], 500019: ["Sansha", "#8ee05a"], 500020: ["Serpentis", "#c09ae8"],
		500024: ["Drifters", "#8fb8c8"], 500025: ["Rogue Drones", "#b0b0b0"], 500026: ["Triglavian", "#ff5a5a"], 500027: ["EDENCOM", "#4fd0f0"],
		500028: ["AIR", "#b0d0a0"], 500029: ["Deathless", "#d07090"]
	},

	/** A stable colour for an alliance (the same ID always gets the same colour, for everyone) */
	allianceColour: function(id) {
		const n = Math.abs(Math.floor(Number(id) || 0));
		// Knuth's multiplicative hash: neighbouring IDs (alliances founded at about the same time) get different colours
		const h = (Math.imul(n, 2654435761) >>> 0) ^ (n >>> 16);
		return regionMapSov.PALETTE[(h >>> 0) % regionMapSov.PALETTE.length];
	},

	factionColour: function(id) { const f = regionMapSov.FACTIONS[id]; return f ? f[1] : "#aaaaaa"; },

	/** "Amarr Empire" (appData.factions), else the short label, else "Faction <id>" */
	factionName: function(id, factions) {
		const f = factions && factions[id];
		if (f && f.name) { return String(f.name); }
		return regionMapSov.FACTIONS[id] ? regionMapSov.FACTIONS[id][0] : "Faction " + id;
	},

	/** "Amarr" */
	factionShort: function(id, factions) {
		return regionMapSov.FACTIONS[id] ? regionMapSov.FACTIONS[id][0] : regionMapSov.factionName(id, factions);
	},

	isEmpire: function(id) { return regionMapSov.EMPIRE.indexOf(Number(id)) >= 0; },

	// ---- Faction warfare (rows of GET /fw/systems, as fw.systems keeps them) ----

	/** Victory points as a whole percentage of the threshold (0-100) */
	fwPercent: function(row) {
		const vp = Number(row && row.victory_points), max = Number(row && row.victory_points_threshold);
		if (!isFinite(vp) || !isFinite(max) || max <= 0) { return 0; }
		return Math.max(0, Math.min(100, Math.floor(100 * vp / max)));
	},

	/** {owner, occupier, state (uncontested | contested | vulnerable | captured), percent} or null */
	fwInfo: function(row) {
		if (!row || !Number(row.occupier_faction_id)) { return null; }
		const states = ["uncontested", "contested", "vulnerable", "captured"];
		return {
			owner: Number(row.owner_faction_id) || Number(row.occupier_faction_id), occupier: Number(row.occupier_faction_id),
			state: states.indexOf(row.contested) >= 0 ? row.contested : "uncontested", percent: regionMapSov.fwPercent(row),
			vp: Math.max(0, Number(row.victory_points) || 0)
		};
	},

	/** "37%", "<1%" (some victory points, less than 1%) */
	percentText: function(info) { return info.percent === 0 && info.vp > 0 ? "<1%" : info.percent + "%"; },

	/** "Faction warfare: occupied by Minmatar (owner Amarr), contested 37%" / "Faction warfare: Amarr, uncontested" */
	fwText: function(info, factions) {
		if (!info) { return ""; }
		const s = regionMapSov.factionShort;
		const who = info.occupier !== info.owner ? "occupied by " + s(info.occupier, factions) + " (owner " + s(info.owner, factions) + ")" : s(info.occupier, factions);
		const what = info.state === "uncontested" ? "uncontested" : info.state === "captured" ? "captured" : info.state + " " + regionMapSov.percentText(info);
		return "Faction warfare: " + who + ", " + what;
	},

	/** The label under the box: "Amarr", "Minmatar 37%", "Amarr VULN", "Caldari CAPT" */
	fwLabel: function(info, factions) {
		const name = regionMapSov.factionShort(info.occupier, factions);
		if (info.state === "contested") { return name + " " + regionMapSov.percentText(info); }
		if (info.state === "vulnerable") { return name + " VULN"; }
		if (info.state === "captured") { return name + " CAPT"; }
		return name;
	},

	// ---- Who holds a system ----

	/** The holder of a system.
	@param data region_sov.php's answer (or null while it loads); fwSystems: {systemID: row} (fw.systems); factions: appData.factions
	@return {kind: "alliance" | "fw" | "faction" | "none", colour, label (text under the box, "" for none), bar (draw a bar),
	allianceID, name, ticker, factionID, fw, text (the card line)} */
	holder: function(systemID, data, fwSystems, factions) {
		const id = Number(systemID), me = regionMapSov;
		const fwInfo = me.fwInfo(fwSystems && fwSystems[id]);
		if (fwInfo) {
			return { kind: "fw", colour: me.factionColour(fwInfo.occupier), label: me.fwLabel(fwInfo, factions), bar: true, factionID: fwInfo.occupier,
				fw: fwInfo, text: me.fwText(fwInfo, factions), state: fwInfo.state };
		}
		const row = data && data.systems && data.systems[id];
		if (row && Number(row.a)) {
			const a = (data.alliances && data.alliances[row.a]) || {};
			const name = a.name ? String(a.name) : "", ticker = a.ticker ? String(a.ticker) : "";
			return { kind: "alliance", colour: me.allianceColour(row.a), allianceID: Number(row.a), name: name, ticker: ticker, bar: true,
				label: ticker ? "[" + ticker + "]" : name ? me.shorten(name, 12) : "Alliance",
				text: "Sov: " + (name || "Alliance " + row.a) + (ticker ? " [" + ticker + "]" : "") };
		}
		if (row && Number(row.f)) {
			const f = Number(row.f), empire = me.isEmpire(f);
			return { kind: "faction", colour: me.factionColour(f), factionID: f, bar: true, empire: empire,
				label: empire ? "" : me.factionShort(f, factions), text: "Faction: " + me.factionName(f, factions) };
		}
		return { kind: "none", colour: "", label: "", bar: false, text: data && data.systems && !(data.sov && data.sov.unavailable) ? "Sov: nobody" : "" };
	},

	shorten: function(s, n) { s = String(s || ""); return s.length > n ? s.substring(0, n - 1) + "…" : s; },

	// ---- Incursions ----

	/** {systemID: {incursion, staging (bool)}} of every infested system and staging system */
	incursionIndex: function(incursions) {
		const out = {};
		(Array.isArray(incursions) ? incursions : []).forEach(function(inc) {
			if (!inc || !Array.isArray(inc.systems)) { return; }
			inc.systems.forEach(function(id) { out[Number(id)] = { incursion: inc, staging: Number(id) === Number(inc.staging) }; });
			if (Number(inc.staging) && !out[Number(inc.staging)]) { out[Number(inc.staging)] = { incursion: inc, staging: true }; }
		});
		return out;
	},

	/** "Incursion (Sansha's Nation): established, staging system, mothership present, influence 62%" */
	incursionText: function(entry, factions) {
		if (!entry) { return ""; }
		const inc = entry.incursion, parts = [inc.state || "established"];
		if (entry.staging) { parts.push("staging system"); }
		if (inc.boss) { parts.push("mothership present"); }
		parts.push("influence " + Math.round(100 * (Number(inc.influence) || 0)) + "%");
		const who = Number(inc.factionID) ? " (" + regionMapSov.factionName(inc.factionID, factions) + ")" : "";
		return "Incursion" + who + ": " + parts.join(", ");
	},

	/** The incursions with a system in the region (ids), and the others: {here: [incursion], elsewhere: [{incursion, regionID}]} */
	regionIncursions: function(incursions, ids, systems) {
		const inRegion = {};
		(ids || []).forEach(function(id) { inRegion[Number(id)] = true; });
		const out = { here: [], elsewhere: [] };
		(Array.isArray(incursions) ? incursions : []).forEach(function(inc) {
			const all = (inc.systems || []).concat(inc.staging ? [inc.staging] : []);
			if (all.some(function(id) { return inRegion[Number(id)]; })) { out.here.push(inc); return; }
			const first = all.map(function(id) { return systems && systems[id]; }).filter(Boolean)[0];
			if (first && Number(first.regionID)) { out.elsewhere.push({ incursion: inc, regionID: Number(first.regionID) }); }
		});
		return out;
	},

	// ---- The bar's legend ----

	/** The alliances holding the most systems of the region: [{allianceID, count, name, ticker, colour}] (most first) */
	legend: function(ids, data, fwSystems) {
		const counts = {};
		(ids || []).forEach(function(id) {
			if (fwSystems && fwSystems[id]) { return; }
			const row = data && data.systems && data.systems[id];
			if (row && Number(row.a)) { counts[row.a] = (counts[row.a] || 0) + 1; }
		});
		return Object.keys(counts).map(function(a) {
			const info = (data.alliances && data.alliances[a]) || {};
			return { allianceID: Number(a), count: counts[a], name: info.name || "", ticker: info.ticker || "", colour: regionMapSov.allianceColour(a) };
		}).sort(function(x, y) { return y.count - x.count || x.allianceID - y.allianceID; });
	},

	/** NPC factions holding systems of the region (faction warfare systems left out): [{factionID, count}] (most first) */
	factionLegend: function(ids, data, fwSystems) {
		const counts = {};
		(ids || []).forEach(function(id) {
			if (fwSystems && fwSystems[id]) { return; }
			const row = data && data.systems && data.systems[id];
			if (row && Number(row.f)) { counts[row.f] = (counts[row.f] || 0) + 1; }
		});
		return Object.keys(counts).map(function(f) { return { factionID: Number(f), count: counts[f] }; })
			.sort(function(a, b) { return b.count - a.count || a.factionID - b.factionID; });
	},

	/** Faction warfare in the region: {systems, contested, vulnerable, occupiers: [{factionID, count}] (most first)} */
	fwSummary: function(ids, fwSystems) {
		const out = { systems: 0, contested: 0, vulnerable: 0, occupiers: [] }, by = {};
		(ids || []).forEach(function(id) {
			const info = regionMapSov.fwInfo(fwSystems && fwSystems[id]);
			if (!info) { return; }
			out.systems++;
			by[info.occupier] = (by[info.occupier] || 0) + 1;
			if (info.state === "contested") { out.contested++; }
			if (info.state === "vulnerable") { out.vulnerable++; }
		});
		out.occupiers = Object.keys(by).map(function(f) { return { factionID: Number(f), count: by[f] }; })
			.sort(function(a, b) { return b.count - a.count || a.factionID - b.factionID; });
		return out;
	},

	// ---- Loading (when to ask region_sov.php again) ----

	/** Whether a region's entry should be (re)fetched now. entry: {data, at, failedAt, busy, pendingTries} or undefined */
	needsFetch: function(entry, now) {
		const me = regionMapSov;
		if (!entry) { return true; }
		if (entry.busy) { return false; }
		if (entry.failedAt && now - entry.failedAt < me.RETRY_MS) { return false; }
		if (!entry.data) { return true; }
		if (entry.data.pending && (entry.pendingTries || 0) < me.PENDING_MAX && now - entry.at >= me.PENDING_MS) { return true; }
		return now - entry.at >= me.REFRESH_MS;
	},

	/** The bar's status note: "" when all is well */
	statusText: function(data, fwLoaded) {
		if (!data) { return ""; }
		const notes = [];
		const st = data.sov || {};
		if (st.unavailable) { notes.push("Sovereignty unavailable" + (st.error ? " (" + st.error + ")" : "") + "."); }
		else if (st.stale) { notes.push("ESI is not answering: sovereignty is from " + regionMapSov.ago(((Number(data.now) || 0) - st.fetched) * 1000) + " ago."); }
		if (data.incursionsStatus && data.incursionsStatus.unavailable) { notes.push("Incursions unavailable."); }
		if (!fwLoaded) { notes.push("Faction warfare unavailable."); }
		return notes.join(" ");
	},

	/** "3 h", "25 min" */
	ago: function(ms) {
		const m = Math.max(0, Math.round(ms / 60000));
		return m >= 90 ? Math.round(m / 60) + " h" : m + " min";
	},

	/** A key of what the overlay draws for these systems: paint() repaints when it changes */
	signature: function(ids, data, fwSystems, factions) {
		const idx = regionMapSov.incursionIndex(data && data.incursions);
		return (ids || []).map(function(id) {
			const h = regionMapSov.holder(id, data, fwSystems, factions), i = idx[id];
			return h.label + "|" + h.colour + "|" + h.text + (i ? "|" + regionMapSov.incursionText(i, factions) : "");
		}).join(",");
	}
};
