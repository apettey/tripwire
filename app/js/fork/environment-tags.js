const environmentTags = {
	// Fork-owned: environment tags on chain map systems and a one-line chain effects summary.
	//  - a storm icon on systems with a crowd-reported metaliminal storm (electric / exotic / gamma / plasma), from
	//    EVE-Scout's public observations list, kept in ONE server-wide copy by public/cached_third_party.php (key
	//    eve-scout-observations, 10 minutes): browsers never call EVE-Scout themselves.
	//  - an "A0" icon on k-space systems whose star is "Sun A0 (Blue Small)", from public/environment-data/a0-suns.json
	//    (static, built from the SDE by tools/fork/build-a0-suns.mjs). Ice belts are not tagged: they are not in the SDE.
	//  - above the map, "Chain: 2 Pulsar, 1 Wolf-Rayet · Storm: Gamma in X": the wormhole effects of the systems on the
	//    chain (Tripwire's own system data) and the storms.
	// Settings > Map Markers: options.environmentTags = {enabled, storms} (missing = on).
	// Keep `const environmentTags` on the first line: the test helper strips it to define a global.
	OBSERVATIONS_URL: "cached_third_party.php?key=eve-scout-observations",
	A0_URL: "environment-data/a0-suns.json",
	REFRESH_MS: 600000,
	MAX_REPORT_AGE_H: 168,	// the API drops old reports itself; ignore anything it still lists that is older than a week
	MAX_SUMMARY_STORMS: 3,

	STORMS: {
		electric: { name: "Electric", color: "#5cc8f5" },
		exotic: { name: "Exotic", color: "#c78cff" },
		gamma: { name: "Gamma", color: "#6fe28a" },
		plasma: { name: "Plasma", color: "#ff8a5c" }
	},

	/** Wormhole effects in the order the summary lists them: [Tripwire's effect text, short name] */
	EFFECTS: [
		["Black Hole", "Black Hole"], ["Cataclysmic Variable", "Cataclysmic Variable"], ["Magnetar", "Magnetar"],
		["Pulsar", "Pulsar"], ["Red Giant", "Red Giant"], ["Wolf-Rayet Star", "Wolf-Rayet"]
	],

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** Whether the tags / summary are on: options.environmentTags.enabled (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.environmentTags && opts.environmentTags.enabled === false);
	},

	/** Whether storm reports are used: on unless the tags are off or options.environmentTags.storms is false */
	stormsEnabled: function(opts) {
		return environmentTags.enabled(opts) && !(opts && opts.environmentTags && opts.environmentTags.storms === false);
	},

	/**
	 * The storms of an EVE-Scout observations answer.
	 * @param list the parsed JSON (an array; anything else gives no storms)
	 * @return {systemID: {kind, name, reportedMs, hoursInSystem}}; only observation_category "storm" of a known kind,
	 *         the newest report per system, reports older than MAX_REPORT_AGE_H dropped
	 */
	parseStorms: function(list, nowMs) {
		const out = {};
		if (!Array.isArray(list)) { return out; }
		list.forEach(function(o) {
			if (!o || typeof o !== "object" || o.observation_category !== "storm") { return; }
			const kind = String(o.observation_type || "").split("_")[0];
			const id = parseInt(o.system_id, 10);
			const at = Date.parse(o.created_at);
			if (!environmentTags.STORMS[kind] || !(id > 0) || isNaN(at)) { return; }
			if (nowMs - at > environmentTags.MAX_REPORT_AGE_H * 3600000) { return; }
			if (out[id] && out[id].reportedMs >= at) { return; }
			const hours = Number(o.hours_in_system);
			out[id] = {
				kind: kind,
				name: typeof o.display_name === "string" && o.display_name ? o.display_name.slice(0, 40) : environmentTags.STORMS[kind].name + " Storm",
				reportedMs: at,
				hoursInSystem: isFinite(hours) && hours >= 0 ? hours : null
			};
		});
		return out;
	},

	/** A0 data file {systems: [ids]} as a Set of IDs (a bad file gives an empty set) */
	parseA0: function(data) {
		const set = new Set();
		if (data && Array.isArray(data.systems)) {
			data.systems.forEach(function(id) { if (Number(id) > 0) { set.add(Number(id)); } });
		}
		return set;
	},

	/** "3 h ago", "just now", "2 d ago" */
	ago: function(ms) {
		const m = Math.max(0, Math.round(ms / 60000));
		if (m < 5) { return "just now"; }
		if (m < 90) { return m + " min ago"; }
		const h = Math.round(m / 60);
		return h < 48 ? h + " h ago" : Math.round(h / 24) + " d ago";
	},

	stormTip: function(storm, nowMs) {
		let tip = storm.name + ", reported " + environmentTags.ago(nowMs - storm.reportedMs);
		if (storm.hoursInSystem !== null) { tip += " (already there " + Math.round(storm.hoursInSystem) + " h)"; }
		return tip + " - crowd-sourced by EVE-Scout";
	},

	/**
	 * The tags of one system.
	 * @param ctx {storms: {id: storm}, a0: Set, nowMs}
	 * @param system the system record (a wormhole system has `class`; it never gets the A0 tag)
	 * @return [{type: "storm"|"a0", kind?, tip}]
	 */
	tagsFor: function(systemID, system, ctx) {
		const tags = [];
		const id = parseInt(systemID, 10);
		if (!(id > 0)) { return tags; }
		const storm = ctx.storms ? ctx.storms[id] : null;
		if (storm) { tags.push({ type: "storm", kind: storm.kind, tip: environmentTags.stormTip(storm, ctx.nowMs) }); }
		if (ctx.a0 && ctx.a0.has(id) && system && !system.class) {
			tags.push({ type: "a0", tip: "A0 sun (Blue Small)" });
		}
		return tags;
	},

	tagHtml: function(tag) {
		const tip = " data-tooltip='" + environmentTags.escape(tag.tip) + "'";
		if (tag.type === "storm") {
			const color = environmentTags.STORMS[tag.kind].color;
			return "<span class='env-tag env-storm env-" + tag.kind + "'" + tip + " style='color:" + color + ";border-color:" + color + "'>"
				+ "<svg width='8' height='10' viewBox='0 0 8 10' aria-hidden='true'><path d='M5 0 L1 5.6 H3.6 L2.8 10 L7 4 H4.4 Z' fill='currentColor'></path></svg></span>";
		}
		return "<span class='env-tag env-a0'" + tip + ">A0</span>";
	},

	tagsHtml: function(tags) {
		return tags.length ? "<span class='env-tags'>" + tags.map(environmentTags.tagHtml).join("") + "</span>" : "";
	},

	/** Insert the tags into a chain node's HTML (before its icon row, like the other node icons) */
	insertTags: function(nodeHtml, html) {
		if (!html || typeof nodeHtml !== "string" || nodeHtml.indexOf("env-tags") >= 0) { return nodeHtml; }
		const at = nodeHtml.indexOf("<div class='nodeIcons'>");
		return at < 0 ? nodeHtml : nodeHtml.substring(0, at) + html + nodeHtml.substring(at);
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

	/** The systems on the chain (unique IDs, in order) from chain.nodes() output */
	chainSystemIDs: function(result) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		const ids = [];
		rows.forEach(function(row) {
			if (environmentTags.isExtraRow(row)) { return; }
			const id = parseInt(row.c[0].systemID, 10);
			if (id > 0 && ids.indexOf(id) < 0) { ids.push(id); }
		});
		return ids;
	},

	/**
	 * Add the tags to every system of chain.nodes() output, in place.
	 * @param getSystem function(id) -> system record
	 * @return {systemIDs: unique IDs of the chain, tagged: IDs that got a tag}
	 */
	decorate: function(result, getSystem, ctx) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		const tagged = [];
		rows.forEach(function(row) {
			if (environmentTags.isExtraRow(row)) { return; }
			const node = row.c[0];
			if (typeof node.f !== "string") { return; }
			const id = parseInt(node.systemID, 10);
			const tags = environmentTags.tagsFor(id, getSystem(id), ctx);
			if (!tags.length) { return; }
			node.f = environmentTags.insertTags(node.f, environmentTags.tagsHtml(tags));
			if (tagged.indexOf(id) < 0) { tagged.push(id); }
		});
		return { systemIDs: environmentTags.chainSystemIDs(result), tagged: tagged };
	},

	/**
	 * What the summary line says.
	 * @param systemIDs the chain's unique system IDs
	 * @param getSystem function(id) -> system record (its `effect` is Tripwire's wormhole effect text)
	 * @param storms {id: storm} (empty when storm reports are off)
	 * @param nameOf function(id) -> system name
	 * @return {effects: [{name, count}], storms: [{id, name, kind}]}
	 */
	summaryModel: function(systemIDs, getSystem, storms, nameOf) {
		const counts = {};
		const stormList = [];
		(systemIDs || []).forEach(function(id) {
			const system = getSystem(id);
			if (system && system.effect) { counts[system.effect] = (counts[system.effect] || 0) + 1; }
			if (storms && storms[id]) { stormList.push({ id: id, name: nameOf(id) || String(id), kind: storms[id].kind }); }
		});
		return {
			effects: environmentTags.EFFECTS.filter(function(e) { return counts[e[0]]; })
				.map(function(e) { return { name: e[1], count: counts[e[0]] }; }),
			storms: stormList
		};
	},

	/** The line of text ("" when there is nothing to say) */
	summaryText: function(model) {
		const parts = [];
		if (model.effects.length) {
			parts.push("Chain: " + model.effects.map(function(e) { return e.count + " " + e.name; }).join(", "));
		}
		if (model.storms.length) {
			const max = environmentTags.MAX_SUMMARY_STORMS;
			const shown = model.storms.slice(0, max).map(function(s) { return environmentTags.STORMS[s.kind].name + " in " + s.name; });
			if (model.storms.length > max) { shown.push("+" + (model.storms.length - max) + " more"); }
			parts.push((model.storms.length === 1 ? "Storm: " : "Storms: ") + shown.join(", "));
		}
		return parts.join(" · ");
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	(function() {
		const et = environmentTags;
		const state = { storms: {}, a0: new Set(), a0Loaded: false, stormsKey: "", timer: null, xhr: null, ids: [], lastAt: 0 };

		function opts() { return typeof options !== "undefined" ? options : null; }
		function system(id) {
			try { return systemAnalysis.analyse(id); } catch (e) { return null; }
		}
		function nameOf(id) { const s = system(id); return s && s.name ? s.name : ""; }

		function ctx() {
			return { storms: et.stormsEnabled(opts()) ? state.storms : {}, a0: state.a0, nowMs: Date.now() };
		}

		/** The summary span (made once, after the chain widget's toolbar icons) */
		function $summary() {
			let $s = $("#chainWidget .controls #envSummary");
			if (!$s.length) {
				$s = $("<span id='envSummary' class='env-summary hidden'></span>");
				const anchor = $("#chainWidget .controls #higgs-jump");
				if (anchor.length) { $s.insertAfter(anchor); } else { $("#chainWidget .controls").append($s); }
			}
			return $s;
		}

		function renderSummary() {
			const on = et.enabled(opts());
			const text = on ? et.summaryText(et.summaryModel(state.ids, system, ctx().storms, nameOf)) : "";
			const $s = $summary();
			$s.text(text).attr("data-tooltip", text ? et.escape(text) : "").toggleClass("hidden", !text);
		}

		function redrawChain() {
			if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); }
		}

		// ---- chain map hook ----
		let hooked = false;
		function installHook() {
			if (hooked || typeof chain === "undefined" || !chain || typeof chain.nodes !== "function" || chain.nodes.environmentTagsWrapped) { return; }
			hooked = true;
			const previous = chain.nodes;
			const wrapped = function() {
				const result = previous.apply(this, arguments);
				try {
					state.ids = et.decorate(et.enabled(opts()) ? result : null, system, ctx()).systemIDs;
					renderSummary();
				} catch (e) { console.warn("Environment tags: could not decorate the chain", e); }
				return result;
			};
			Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
			wrapped.environmentTagsWrapped = true;
			chain.nodes = wrapped;
		}

		// ---- data ----
		function loadA0() {
			if (state.a0Loaded) { return; }
			state.a0Loaded = true;
			$.ajax({ url: et.A0_URL, type: "GET", dataType: "JSON", cache: true, timeout: 15000 }).done(function(data) {
				state.a0 = et.parseA0(data);
				if (et.enabled(opts()) && state.a0.size) { redrawChain(); }
			}).fail(function() { state.a0Loaded = false; });
		}

		function stormKey(storms) {
			return Object.keys(storms).sort().map(function(id) { return id + ":" + storms[id].kind + ":" + storms[id].reportedMs; }).join(",");
		}

		function loadStorms() {
			clearTimeout(state.timer);
			if (!et.stormsEnabled(opts())) { return; }
			state.timer = setTimeout(loadStorms, et.REFRESH_MS);
			if (document.hidden || state.xhr || Date.now() - state.lastAt < 30000) { return; }
			state.lastAt = Date.now();
			state.xhr = $.ajax({ url: et.OBSERVATIONS_URL, type: "GET", dataType: "JSON", cache: false, timeout: 20000 }).done(function(list) {
				state.storms = et.parseStorms(list, Date.now());
				const key = stormKey(state.storms);
				if (key !== state.stormsKey) { state.stormsKey = key; redrawChain(); }
			}).always(function() { state.xhr = null; });
		}

		// ---- Settings > Map Markers ----
		function setupSettings() {
			// Take effect on Save (upstream Save runs options.apply() -> chain.redraw()); Reset deletes the key
			forkSettings.register({
				section: "markers", order: 55, id: "environmentTags-enabled", type: "checkbox", key: "environmentTags",
				label: "Environment tags:", text: "Show A0 sun and storm tags on systems, and a chain effects summary above the map",
				get: function(o) { return et.enabled(o); },
				set: function(o, on) { o.environmentTags = Object.assign({}, o.environmentTags || {}, { enabled: on }); }
			});
			forkSettings.register({
				section: "markers", order: 56, id: "environmentTags-storms", type: "checkbox",
				label: "Storm reports:", text: "Include metaliminal storms reported to EVE-Scout (fetched through this server)",
				get: function(o) { return !(o && o.environmentTags && o.environmentTags.storms === false); },
				set: function(o, on) { o.environmentTags = Object.assign({}, o.environmentTags || {}, { storms: on }); }
			});
			if (typeof options !== "undefined" && options.apply && !options.apply.environmentTagsWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					try { loadStorms(); renderSummary(); } catch (err) { console.error("Environment tags: apply failed", err); }
					return result;
				};
				options.apply.environmentTagsWrapped = true;
			}
		}

		installHook();
		$(function() {
			installHook();
			setupSettings();
			loadA0();
			loadStorms();
			$(document).on("visibilitychange", function() { if (!document.hidden && !state.xhr && et.stormsEnabled(opts())) { loadStorms(); } });
		});
	})();
}
