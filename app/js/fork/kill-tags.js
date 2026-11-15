const killTags = {
	// Kill tags (fork-owned): small labels on the System and Chain kill feeds (gate camp, bubble, smartbomb, gank, solo,
	// awox, NPC), a filter by tag and the System kill feed's time window. Classification is pure (killTags.classify) and
	// reads only what the pooled zKillboard worker stores per kill (zkill/killmails.php: locationID, attackerShips,
	// attackerWeapons, concord, ganked, npc, awox, attackerCount); kills stored before those columns get only the tags
	// the older fields allow. Settings: options.killTags.enabled (missing = on), Settings > Kills & Intel.
	// Keep `const killTags` on the first line: the test helper strips it to define a global.

	/** Tags in display order: key, chip text, filter label, tooltip */
	TAGS: [
		{ key: "gatecamp", text: "Gate", label: "Gate camp", tip: "Gate camp: killed next to a stargate" },
		{ key: "bubble", text: "Bubble", label: "Bubble", tip: "Bubble: an Interdictor or Heavy Interdiction Cruiser was on the kill" },
		{ key: "smartbomb", text: "Smartbomb", label: "Smartbomb", tip: "Smartbomb: a smartbomb did damage" },
		{ key: "gank", text: "Gank", label: "Gank", tip: "Gank: a high-sec suicide gank (CONCORD on the mail, zKillboard's ganked label, or 3+ pilots on an unarmed hull)" },
		{ key: "solo", text: "Solo", label: "Solo", tip: "Solo: one pilot on the kill" },
		{ key: "awox", text: "Awox", label: "Awox", tip: "Awox: killed by their own corporation" },
		{ key: "npc", text: "NPC", label: "NPC", tip: "NPC: killed by NPCs" }
	],

	/** Time windows of the System kill feed (the server clamps to its retention, ZKILL_RETENTION_HOURS) */
	WINDOWS: [
		{ key: "1h", seconds: 3600, text: "1h", tip: "Kills in the last hour" },
		{ key: "24h", seconds: 86400, text: "24h", tip: "Kills in the last 24 hours" },
		{ key: "7d", seconds: 604800, text: "7d", tip: "Kills in the last 7 days (as far back as this server keeps kills)" }
	],
	DEFAULT_WINDOW: "24h",

	// Item IDs of stargates (zKillboard's locationID is the nearest celestial; 50000000-59999999 are stargates)
	STARGATE_MIN: 50000000,
	STARGATE_MAX: 59999999,
	HIGHSEC: 0.45,	// same threshold as systemAnalysis / chainKillFeed.systemKind
	GANK_MIN_PILOTS: 3,
	// Interdictors (group 541) and Heavy Interdiction Cruisers (894); a test keeps this equal to public/intel/types.json
	BUBBLE_HULLS: [11995, 12013, 12017, 12021, 22452, 22456, 22460, 22464, 35781, 60764],
	// Unarmed or nearly unarmed hulls a gank goes for: haulers, DSTs, blockade runners, freighters, jump freighters, mining
	// barges, exhumers, Orca / Porpoise, expedition frigates, shuttles (groups 28, 380, 1202, 513, 902, 463, 543, 941, 1283, 31;
	// a test keeps this equal to public/intel/types.json)
	UNARMED_HULLS: [648, 649, 650, 651, 652, 653, 654, 655, 656, 657, 672, 1944, 2863, 2998, 4363, 4388, 11129, 11132, 11134,
		12729, 12731, 12733, 12735, 12743, 12745, 12747, 12753, 17476, 17478, 17480, 19744, 20183, 20185, 20187, 20189, 21097,
		21628, 22544, 22546, 22548, 27299, 27301, 27303, 27305, 28606, 28844, 28846, 28848, 28850, 29266, 29328, 29330, 29332,
		29334, 30842, 32811, 33513, 33683, 33685, 33689, 33691, 33693, 33695, 33697, 34328, 34496, 37135, 42244, 64034, 81008,
		81040, 81046, 81047],
	// Smartbombs (group 72, from ESI /universe/groups/72/)
	SMARTBOMBS: [1547, 1549, 1551, 1553, 1557, 1559, 1563, 1565, 3897, 3899, 3901, 3903, 3907, 3909, 3913, 3915, 3937, 3939,
		3941, 3943, 3947, 3949, 3953, 3955, 3977, 3979, 3981, 3983, 3987, 3989, 3993, 3995, 9668, 9670, 9678, 9680, 9702, 9706,
		9728, 9734, 9744, 9750, 9762, 9772, 9784, 9790, 9800, 9808, 14188, 14190, 14192, 14194, 14196, 14198, 14200, 14202,
		14204, 14206, 14208, 14210, 14212, 14214, 14218, 14220, 14222, 14224, 14226, 14228, 14544, 14546, 14548, 14550, 14692,
		14694, 14696, 14698, 14784, 14786, 14788, 14790, 14792, 14794, 14796, 14798, 15152, 15154, 15156, 15158, 15405, 15925,
		15927, 15929, 15931, 15933, 15935, 15937, 15939, 15941, 15943, 15945, 15947, 15949, 15951, 15953, 15955, 15957, 15959,
		15961, 15963, 21532, 21534, 21536, 21538, 23864, 23866, 23868, 28545, 28550, 28557, 84434, 84435, 84436, 84437, 84438,
		84439, 84440, 84441, 84442, 84443, 84444, 84445, 84495, 84496, 84497, 84498, 84499, 84500, 84740],

	/** Whether the tags and the filter are on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.killTags && opts.killTags.enabled === false);
	},

	/** Whether any of the IDs is in the list */
	anyIn: function(ids, list) {
		if (!Array.isArray(ids) || !ids.length) { return false; }
		for (let i = 0; i < ids.length; i++) {
			if (list.indexOf(Number(ids[i])) >= 0) { return true; }
		}
		return false;
	},

	/**
	 * Tag keys of a kill (system_kills.php shape), in TAGS order. An NPC kill (zKillboard's npc flag, or no pilot among
	 * the attackers) is only "npc".
	 * @param kill {npc, awox, attackerCount, locationID, attackerShips, attackerWeapons, concord, ganked, victim: {shipTypeID}}
	 * @param security the system's security status (null / undefined when unknown: no gank from the hull rule)
	 */
	classify: function(kill, security) {
		const k = kill || {};
		const pilots = parseInt(k.attackerCount, 10) || 0;
		if (k.npc || pilots === 0) { return ["npc"]; }
		const tags = [];
		const location = Number(k.locationID);
		if (location >= killTags.STARGATE_MIN && location <= killTags.STARGATE_MAX) { tags.push("gatecamp"); }
		if (killTags.anyIn(k.attackerShips, killTags.BUBBLE_HULLS)) { tags.push("bubble"); }
		if (killTags.anyIn(k.attackerWeapons, killTags.SMARTBOMBS)) { tags.push("smartbomb"); }
		const sec = security === null || security === undefined || security === "" ? NaN : Number(security);
		const highsec = isFinite(sec) && sec >= killTags.HIGHSEC;
		const victimShip = Number(k.victim && k.victim.shipTypeID);
		if (k.ganked || highsec && (k.concord || pilots >= killTags.GANK_MIN_PILOTS && killTags.UNARMED_HULLS.indexOf(victimShip) >= 0)) {
			tags.push("gank");
		}
		if (pilots === 1) { tags.push("solo"); }
		if (k.awox) { tags.push("awox"); }
		return tags;
	},

	/** The tag definition for a key, or null */
	tag: function(key) {
		for (let i = 0; i < killTags.TAGS.length; i++) {
			if (killTags.TAGS[i].key === key) { return killTags.TAGS[i]; }
		}
		return null;
	},

	/** Kills per tag over rows with `tags`: { key: n } (only tags that occur) */
	counts: function(rows) {
		const out = {};
		(rows || []).forEach(function(r) {
			(r && Array.isArray(r.tags) ? r.tags : []).forEach(function(t) { out[t] = (out[t] || 0) + 1; });
		});
		return out;
	},

	/** Rows with the tag (all rows for "" / null) */
	filter: function(rows, key) {
		const list = rows || [];
		if (!key) { return list; }
		return list.filter(function(r) { return r && Array.isArray(r.tags) && r.tags.indexOf(key) >= 0; });
	},

	/** The window for a key (the default one for an unknown key) */
	window: function(key) {
		for (let i = 0; i < killTags.WINDOWS.length; i++) {
			if (killTags.WINDOWS[i].key === key) { return killTags.WINDOWS[i]; }
		}
		return killTags.window(killTags.DEFAULT_WINDOW);
	},

	escape: function(text) {
		return String(text === null || text === undefined ? "" : text).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** Chips for a row's tags ("" for none). The tooltip attribute is escaped twice (the tooltip renders HTML). */
	chipsHtml: function(tags) {
		if (!Array.isArray(tags) || !tags.length) { return ""; }
		const esc = killTags.escape;
		return "<span class='kill-tags'>" + tags.map(function(key) {
			const t = killTags.tag(key);
			if (!t) { return ""; }
			return "<span class='kill-tag kill-tag-" + esc(t.key) + "' data-tooltip='" + esc(esc(t.tip)) + "'>" + esc(t.text) + "</span>";
		}).join("") + "</span>";
	},

	/**
	 * The filter bar over a feed: "All" and one chip per tag that occurs (with its count), the selected one marked.
	 * A selected tag with no kills (any more) stays so it can be cleared. Empty when there is nothing to filter.
	 * @param counts killTags.counts(rows); @param total rows; @param selected tag key or ""
	 */
	filterHtml: function(counts, total, selected) {
		const esc = killTags.escape;
		const shown = killTags.TAGS.filter(function(t) { return counts[t.key] || t.key === selected; });
		if (!shown.length) { return ""; }
		const chip = function(key, text, n, tip) {
			return "<a href='#' class='kill-filter" + ((selected || "") === key ? " active" : "") + (key ? " kill-tag-" + esc(key) : "")
				+ "' data-killtag='" + esc(key) + "' role='button' aria-pressed='" + ((selected || "") === key) + "'"
				+ (tip ? " data-tooltip='" + esc(esc(tip)) + "'" : "") + ">" + esc(text) + " <span class='kill-filter-n'>" + n + "</span></a>";
		};
		return "<div class='kill-filters'>" + chip("", "All", total, "")
			+ shown.map(function(t) { return chip(t.key, t.label, counts[t.key] || 0, t.tip); }).join("") + "</div>";
	},

	/** Window buttons of the System kill feed */
	windowHtml: function(selected) {
		const esc = killTags.escape;
		const current = killTags.window(selected).key;
		return "<span class='kill-windows'>" + killTags.WINDOWS.map(function(w) {
			return "<a href='#' class='kill-window" + (w.key === current ? " active" : "") + "' data-killwindow='" + esc(w.key) + "' role='button' aria-pressed='"
				+ (w.key === current) + "' data-tooltip='" + esc(esc(w.tip)) + "'>" + esc(w.text) + "</a>";
		}).join("") + "</span>";
	},

	// ---- Browser-only code below (not run under mocha) ----

	isOn: function() {
		return killTags.enabled(typeof options !== "undefined" ? options : undefined);
	},

	/** Security status of a system from the static data (null when unknown) */
	securityOf: function(systemID) {
		const id = String(systemID);
		const sys = typeof appData !== "undefined" && appData.systems ? appData.systems[id] : null;
		if (sys && sys.security !== undefined && sys.security !== null && sys.security !== "") { return Number(sys.security); }
		return null;
	},

	/** Per-viewer convenience: the filter / window last picked in a panel (localStorage; gone in a private window) */
	remembered: function(name, fallback) {
		try {
			const v = window.localStorage.getItem("killTags." + name);
			return v === null ? fallback : v;
		} catch (e) { return fallback; }
	},

	remember: function(name, value) {
		try { window.localStorage.setItem("killTags." + name, value || ""); } catch (e) { /* not remembered */ }
	},

	setupSettings: function() {
		if (typeof forkSettings === "undefined") { return; }
		// Settings > Kills & Intel, after the two feeds; takes effect on Save like its neighbours (Reset = on)
		forkSettings.register({
			section: "intel", order: 22, id: "killTags-enabled", type: "checkbox", key: "killTags",
			label: "Kill tags:", text: "Tag kills in the kill feeds (gate camp, bubble, smartbomb, gank, solo, awox, NPC) and filter by tag",
			get: function() { return killTags.isOn(); },
			set: function(o, on) { o.killTags = Object.assign({}, o.killTags || {}, { enabled: on }); }
		});
		// options.apply() runs on Save and Reset: redraw both feeds with or without the tags
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.killTagsWrapped) {
			const apply = options.apply;
			const wrapped = function() {
				const result = apply.apply(this, arguments);
				if (typeof systemKillFeed !== "undefined" && systemKillFeed.$widget().length) { systemKillFeed.render(); }
				if (typeof chainKillFeed !== "undefined" && chainKillFeed.$widget().length) { chainKillFeed.render(); }
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrapped[k] = apply[k]; });
			wrapped.killTagsWrapped = true;
			options.apply = wrapped;
		}
	},

	selectedTags: {},	// panel id => tag key ("" = all)

	/** The tag filter of a kill panel (remembered per viewer) */
	selected: function(panelID) {
		if (!Object.prototype.hasOwnProperty.call(killTags.selectedTags, panelID)) {
			const key = killTags.remembered("filter." + panelID, "");
			killTags.selectedTags[panelID] = killTags.tag(key) ? key : "";
		}
		return killTags.selectedTags[panelID];
	},

	/** Filter a kill panel by a tag ("" = all) and redraw it */
	select: function(panelID, key) {
		const next = killTags.tag(key) ? key : "";
		if (killTags.selected(panelID) === next) { return; }
		killTags.selectedTags[panelID] = next;
		killTags.remember("filter." + panelID, next);
		if (typeof systemKillFeed !== "undefined" && panelID === systemKillFeed.WIDGET_ID) { systemKillFeed.render(); }
		if (typeof chainKillFeed !== "undefined" && panelID === chainKillFeed.WIDGET_ID) { chainKillFeed.render(); }
		if (next && typeof forkUsage !== "undefined") { forkUsage.track("killTags", "filtered"); }
	},

	init: function() {
		killTags.setupSettings();
		// The System kill feed starts with the window picked last (it loads after this file: its first fetch reads it)
		if (typeof systemKillFeed !== "undefined") {
			const key = killTags.remembered("window", "");
			systemKillFeed.windowKey = killTags.window(key).key === key ? key : null;
		}
		$(document).on("click", ".skf-panel .kill-filter[data-killtag]", function(e) {
			e.preventDefault();
			killTags.select($(this).closest(".skf-panel").attr("id"), $(this).attr("data-killtag"));
		});
		$(document).on("click", ".skf-panel .kill-window[data-killwindow]", function(e) {
			e.preventDefault();
			if (typeof systemKillFeed === "undefined") { return; }
			if (systemKillFeed.setWindow($(this).attr("data-killwindow")) && typeof forkUsage !== "undefined") { forkUsage.track("killTags", "window"); }
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { killTags.init(); });
}
