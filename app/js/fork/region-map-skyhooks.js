const regionMapSkyhooks = {
	// Fork-owned: raidable skyhooks on the region map (and the staging scan's skyhook tag), pure logic (no DOM, testable
	// in Node). The skyhook list and the planet data come from skyhooks-panel.js (one shared loader, `skyhooksPanel.store`);
	// the filters and their meaning are the old Raidable skyhooks box's, still saved in options.skyhooksPanel
	// (window now / soon within soonHours / all, lava, ice, low, null). The panel is region-map-view.js.
	// Keep `const regionMapSkyhooks` on the first line: the test helper strips it to define a global.

	OLD_WIDGET_ID: "skyhooksWidget",	// the retired floating box's gridster widget
	FILTER_KEYS: ["window", "soonHours", "lava", "ice", "low", "null"],

	sp: function() { return skyhooksPanel; },

	/** options.skyhooksPanel after changing some filters (only the filter keys; the rest is kept as it is) */
	withFilter: function(saved, patch) {
		const out = Object.assign({}, saved && typeof saved === "object" ? saved : {});
		regionMapSkyhooks.FILTER_KEYS.forEach(function(k) {
			if (patch && patch[k] !== undefined) { out[k] = patch[k]; }
		});
		return out;
	},

	/** The skyhooks that pass the filters, grouped per system.
	@param skyhooks [{planetID, systemID, start, end}] from skyhooks.php; systemFor(id) the system's static data (name, security);
	now: server time (s); settings: skyhooksPanel.settings(); planets: planets.json (or null while it is loading)
	@return {systemID: {systemID, items: [{planetID, systemID, start, end, state, planet, rating}] (by window start), open, soon,
	rating (best of the system), state ("open" when any is open now, else "soon"), lastEnd}} */
	bySystem: function(skyhooks, systemFor, now, settings, planets) {
		const sp = regionMapSkyhooks.sp(), out = {};
		sp.prefilter(skyhooks, systemFor, now, settings, planets).forEach(function(s) {
			const id = Number(s.systemID);
			if (!id) { return; }
			const sys = systemFor(id) || {};
			const planet = sp.planetInfo(planets, s.planetID, sys.name);
			const state = sp.status(s.start, s.end, now).state;
			const e = out[id] || (out[id] = { systemID: id, items: [], open: 0, soon: 0, rating: 0, state: "soon", lastEnd: 0 });
			e.items.push({ planetID: s.planetID, systemID: id, start: Number(s.start), end: Number(s.end), state: state, planet: planet, rating: sp.valueRating(planet) });
			if (state === "open") { e.open++; e.state = "open"; } else { e.soon++; }
			e.rating = Math.max(e.rating, sp.valueRating(planet));
			e.lastEnd = Math.max(e.lastEnd, Number(s.end) || 0);
		});
		Object.keys(out).forEach(function(id) {
			out[id].items.sort(function(a, b) { return a.start - b.start || a.planetID - b.planetID; });
		});
		return out;
	},

	/** What the marker on a system box shows: {state, count, dollars ("$$$", "" without a rating), text ("2 $$$")} */
	marker: function(entry) {
		if (!entry || !entry.items || !entry.items.length) { return null; }
		const count = entry.items.length, dollars = new Array(Math.max(0, Math.min(5, entry.rating)) + 1).join("$");
		return { state: entry.state, count: count, dollars: dollars, text: (count > 1 ? count + (dollars ? " " : "") : "") + dollars };
	},

	/** "Lava", "Ice", "" */
	kindText: function(kind) { return kind === "lava" ? "Lava" : kind === "ice" ? "Ice" : ""; },

	/** One skyhook as one line of text: "Planet IV, Lava: 14:06–16:06 EVE time, open now, 1h12m left, $$$$ (~2.2M ISK/h)" */
	itemText: function(item, now) {
		const sp = regionMapSkyhooks.sp(), p = item.planet || {};
		const parts = [(p.name ? "Planet " + p.number : "Planet") + (p.kind === "lava" || p.kind === "ice" ? ", " + regionMapSkyhooks.kindText(p.kind) : "") + ":"];
		parts.push(sp.windowText(item.start, item.end, now) + " EVE time, " + sp.countdown(item.start, item.end, now));
		const value = regionMapSkyhooks.valueText(item);
		return parts.join(" ") + (value ? ", " + value : "");
	},

	/** "$$$$ (~2.2M ISK/h)"; "" without a rating */
	valueText: function(item) {
		if (!item || !item.rating) { return ""; }
		const p = item.planet || {};
		return new Array(item.rating + 1).join("$") + (p.isk ? " (~" + regionMapSkyhooks.sp().formatIsk(p.isk / 2) + " ISK/h)" : "");
	},

	/** Tooltip lines for a system's marker */
	tooltip: function(entry, now) {
		if (!entry || !entry.items.length) { return []; }
		const n = entry.items.length;
		return [n + " raidable skyhook" + (n === 1 ? "" : "s") + ":"].concat(entry.items.map(function(i) { return "  " + regionMapSkyhooks.itemText(i, now); }));
	},

	/** The side list's rows for one region: one row per skyhook of a system in the layout, sorted by sort ("jumps", "start",
	"value"; skyhooksPanel.sort). jumps: {systemID: {jumps}} (from you or the nearest chain exit; missing = unknown, last) */
	regionRows: function(bySys, layoutIds, jumps, sort) {
		const rows = [];
		(layoutIds || []).forEach(function(id) {
			const e = bySys && bySys[id];
			if (!e) { return; }
			const j = jumps && jumps[id];
			e.items.forEach(function(item) {
				rows.push({ skyhook: item, planet: item.planet, rating: item.rating, nearest: j && isFinite(Number(j.jumps)) ? { jumps: Number(j.jumps) } : null });
			});
		});
		return regionMapSkyhooks.sp().sort(rows, sort);
	},

	/** Matching skyhooks in the neighbouring regions (those the region's gates lead to): [{regionID, count}], most first.
	@param regionIDs the neighbouring regions (layout.stubs' toRegionID; duplicates are fine) */
	neighbours: function(bySys, regionIDs, systems) {
		const want = {}, counts = {};
		(regionIDs || []).forEach(function(r) { want[Number(r)] = true; });
		Object.keys(bySys || {}).forEach(function(id) {
			const s = systems && systems[id], r = s ? Number(s.regionID) : 0;
			if (r && want[r]) { counts[r] = (counts[r] || 0) + bySys[id].items.length; }
		});
		return Object.keys(counts).map(function(r) { return { regionID: Number(r), count: counts[r] }; })
			.sort(function(a, b) { return b.count - a.count || a.regionID - b.regionID; });
	},

	/** The staging scan's tag for a system: "⚓2 now" (open now), "⚓1 soon" (opens within the user's hours), "" for none */
	stagingTag: function(entry) {
		if (!entry) { return ""; }
		if (entry.open) { return "⚓" + entry.open + " now"; }
		return entry.soon ? "⚓" + entry.soon + " soon" : "";
	},

	/** The staging scan's settings: the user's filters, but always "now or within soonHours" (a scan is about tonight) */
	stagingSettings: function(settings) {
		return Object.assign({}, settings, { window: "soon" });
	},

	/** A key of what the map draws for skyhooks (state, count, rating per system): paint() repaints when it changes */
	signature: function(bySys, ids) {
		return (ids || []).filter(function(id) { return bySys && bySys[id]; }).map(function(id) {
			const e = bySys[id];
			return id + ":" + e.state + ":" + e.items.length + ":" + e.rating;
		}).join(",");
	},

	// ---- The retired floating box ----

	/** Drop what only the box used from the options (its grid entry and options.skyhooksPanel.position), in place.
	@return whether anything changed */
	cleanOptions: function(opts) {
		if (!opts || typeof opts !== "object") { return false; }
		let changed = false;
		const id = regionMapSkyhooks.OLD_WIDGET_ID;
		if (panelHost.hasEntry(opts.grid, id)) { opts.grid = panelHost.withoutEntry(opts.grid, id); changed = true; }
		if (opts.skyhooksPanel && typeof opts.skyhooksPanel === "object" && opts.skyhooksPanel.position !== undefined) {
			opts.skyhooksPanel = Object.assign({}, opts.skyhooksPanel);
			delete opts.skyhooksPanel.position;
			changed = true;
		}
		return changed;
	}
};
