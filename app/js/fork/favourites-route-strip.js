const favouritesRouteStrip = {
	// Favourites panel: each favourite's route as a strip of jump markers, one per jump in route order
	// (fork-owned file). Shape = kind of jump (square: stargate, circle: wormhole, ringed circle: a hop into or out of
	// Thera / Turnur, by an EVE-Scout connection or a mapped wormhole), colour = the system it enters (EVE's security
	// colours for k-space, Tripwire's class colours for J-space), except hub hops: Thera yellow, Turnur pink (HUB_COLOURS). Setting: options.favouritesRouteStrip.enabled (missing = on); off shows the
	// "1g → 2wh → 6g" text as before. Pure logic here; the UI is at the bottom.
	// Keep `const favouritesRouteStrip` on the first line: the test helper strips it to define a global.
	MARKER_STEP: 11,	// px per marker: 9 px marker + 2 px gap (keep in step with the CSS)
	GAP_WIDTH: 34,		// px reserved for the "…+N" in the middle of a compressed strip

	// EVE's security status colours (1.0 down to 0.1; 0.0 and below share the null-sec one), as CCP publishes them:
	// https://developers.eveonline.com/docs/guides/system-security/ ("Security Status Colors")
	SECURITY_COLOURS: {
		"1.0": "#2C75E1", "0.9": "#399AEB", "0.8": "#4ECEF8", "0.7": "#60DBA3", "0.6": "#71E754",
		"0.5": "#F5FF83", "0.4": "#DC6C06", "0.3": "#CE440F", "0.2": "#BB1116", "0.1": "#731F1F", "0.0": "#8D3163"
	},
	// Tripwire's own colours (app/css/base.css) for J-space classes, Pochven; Zarzakh gets its own
	CLASS_COLOURS: { 1: "#4399F0", 2: "#4399F0", 3: "#4399F0", 4: "#9060f0", 5: "#9060f0", 6: "#f06090", 12: "#ffc800", 15: "#f06060", 16: "#f06060", 17: "#f06060" },
	WH_COLOUR: "#4399F0",
	POCHVEN_COLOUR: "#FF2060",
	ZARZAKH_COLOUR: "#B8B8D0",
	UNKNOWN_COLOUR: "#777777",
	HUB_SYSTEMS: { Thera: true, Turnur: true },
	// Hops into / out of a hub: Thera in its class colour from base.css (C12), Turnur in a colour no security step or
	// wormhole class uses
	HUB_COLOURS: { Thera: "#ffc800", Turnur: "#FF4DFF" },

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Whether the strip is switched on (options.favouritesRouteStrip.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.favouritesRouteStrip && opts.favouritesRouteStrip.enabled === false);
	},

	/** Security as the game shows it (CCP's rule, see SECURITY_COLOURS): one decimal, normal rounding (half away from
	zero, so -0.85 is -0.9), but anything above 0.0 and below 0.05 is 0.1 */
	displaySecurity: function(security) {
		const s = Number(security);
		if (security === null || security === undefined || security === "" || !isFinite(s)) { return null; }
		if (s > 0 && s < 0.05) { return 0.1; }
		const r = Math.sign(s) * Math.round(Math.abs(s) * 10) / 10;
		return r === 0 ? 0 : r;	// no -0
	},

	securityColour: function(security) {
		const s = favouritesRouteStrip.displaySecurity(security);
		if (s === null) { return favouritesRouteStrip.UNKNOWN_COLOUR; }
		return favouritesRouteStrip.SECURITY_COLOURS[Math.max(0, Math.min(1, s)).toFixed(1)];
	},

	/** First wormhole class of a system (appData has a number or string, systemAnalysis an array), or null */
	whClass: function(system) {
		if (!system || system.class === undefined || system.class === null || system.class === "") { return null; }
		const c = Array.isArray(system.class) ? system.class[0] : system.class;
		const n = Number(c);
		return isFinite(n) && n > 0 ? n : null;
	},

	/** How a system looks on the strip: {kind: "hisec"|"lowsec"|"nullsec"|"wh"|"pochven"|"zarzakh"|"unknown",
	colour, label (security "0.9", class "C5", "Thera", "Pochven"...)} */
	systemStyle: function(system) {
		const rs = favouritesRouteStrip;
		if (!system) { return { kind: "unknown", colour: rs.UNKNOWN_COLOUR, label: "" }; }
		if (system.name === "Zarzakh") { return { kind: "zarzakh", colour: rs.ZARZAKH_COLOUR, label: "Zarzakh" }; }
		const c = rs.whClass(system);
		if (c) {
			return { kind: "wh", colour: rs.CLASS_COLOURS[c] || rs.WH_COLOUR, label: c === 12 ? "Thera" : "C" + c };
		}
		if (Number(system.factionID) === 500026) { return { kind: "pochven", colour: rs.POCHVEN_COLOUR, label: "Pochven" }; }
		const s = rs.displaySecurity(system.security);
		if (s === null) { return { kind: "unknown", colour: rs.UNKNOWN_COLOUR, label: "" }; }
		return { kind: s >= 0.5 ? "hisec" : s > 0 ? "lowsec" : "nullsec", colour: rs.securityColour(s), label: s.toFixed(1) };
	},

	/** The hole you jump through from fromID: its type on the side that has it ("H296"), "K162" from the other side.
	@param wormhole tripwire.client.wormholes entry {type, parent: "initial" | "secondary"}
	@param initialSystemID / secondarySystemID systems of its two signatures */
	holeLabel: function(wormhole, initialSystemID, secondarySystemID, fromID) {
		if (!wormhole) { return ""; }
		const typed = wormhole.parent === "secondary" ? secondarySystemID : initialSystemID;
		const other = wormhole.parent === "secondary" ? initialSystemID : secondarySystemID;
		const type = wormhole.type && wormhole.type !== "????" ? String(wormhole.type) : "";
		if (String(fromID) === String(typed)) { return type; }
		if (String(fromID) === String(other)) { return type === "K162" ? "" : "K162"; }
		return type;
	},

	/** Every jump of a Favourites panel plan, in order: [{from, to, kind: "gate" | "wormhole", lineIndex}].
	@param plan favouritesPanel.plan() result
	@param gatePath function(fromID, toID, safe) -> [systemIDs] (autopilotRoute.gatePath, the same search as the plan)
	@param connections rally.systemConnections(rows, lines): [systemA, systemB, classes, lineIndex]
	@return the list, or null when it can't be worked out (no route, or the chain changed under it) */
	steps: function(plan, startID, favID, gatePath, connections) {
		if (!plan || plan.status !== "ok") { return null; }
		const safe = plan.mode === "safe";
		const out = [];
		const gates = function(from, to, count) {
			if (!count) { return true; }
			const path = gatePath(from, to, safe);
			if (!path || path.length !== count + 1) { return false; }
			for (let i = 1; i < path.length; i++) { out.push({ from: String(path[i - 1]), to: String(path[i]), kind: "gate" }); }
			return true;
		};
		if (plan.kind === "direct") { return gates(startID, favID, plan.gatesIn) && out.length ? out : null; }
		if (plan.kind === "scout") {	// through Thera / Turnur: the plan has every jump already (theraRoute)
			const scout = typeof theraRoute !== "undefined" ? theraRoute.stripSteps(plan, Date.now()) : null;
			return scout && scout.length ? scout : null;
		}
		if (plan.kind !== "chain") { return null; }	// a kind of plan this doesn't know: the row keeps its text
		if (!gates(startID, plan.entrySystemID, plan.gatesIn)) { return null; }
		const byIndex = {};
		(connections || []).forEach(function(c) { if (c) { byIndex[c[3]] = c; } });
		let current = String(plan.entrySystemID);
		for (let i = 0; i < (plan.lineIndexes || []).length; i++) {
			const index = plan.lineIndexes[i];
			const c = byIndex[index];
			if (!c) { return null; }
			const next = String(c[0]) === current ? String(c[1]) : String(c[1]) === current ? String(c[0]) : null;
			if (next === null) { return null; }
			out.push({ from: current, to: next, kind: "wormhole", lineIndex: index });
			current = next;
		}
		if (current !== String(plan.exitSystemID)) { return null; }
		if (!gates(plan.exitSystemID, favID, plan.gatesOut)) { return null; }
		return out.length ? out : null;
	},

	/** Whether a chain node's markup (makeSystemNode output) is an EVE-Scout (third-party) node: the class token,
	not just the text anywhere in the HTML */
	isThirdPartyNode: function(markup) {
		const m = typeof markup === "string" ? /class='([^']*)'/.exec(markup) || /class="([^"]*)"/.exec(markup) : null;
		return !!m && m[1].split(/\s+/).indexOf("third-party") >= 0;
	},

	/** Chain connections that are EVE-Scout ones: {<line index>: true}. A line is [child node, parent node, ...]
	and the connection belongs to its child, so only the child counts (your own hole off an EVE-Scout system isn't one). */
	thirdPartyLines: function(rows, lines) {
		const nodes = {};
		(rows || []).forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (node && favouritesRouteStrip.isThirdPartyNode(node.f)) { nodes[node.v] = true; }
		});
		const result = {};
		(lines || []).forEach(function(line, index) { if (line && nodes[line[0]]) { result[index] = true; } });
		return result;
	},

	/** A system-like object for a chain node that isn't a real system ("High-Sec|..." / "Class-5|..."): class and
	faction (Pochven) are known, but the security systemAnalysis fills in is a placeholder, so leave it out */
	genericSystem: function(analysed) {
		if (!analysed) { return null; }
		return { name: analysed.name || "unknown system", class: analysed.class, factionID: analysed.factionID };
	},

	/** Tooltip of the whole strip: the route detail plus the short breakdown ("1g → 2wh → 6g") unless already in it */
	stripTitle: function(summary, breakdown) {
		summary = summary || "";
		breakdown = String(breakdown || "").trim();
		return summary + (breakdown && summary.indexOf(breakdown) < 0 ? (summary ? " · " : "") + breakdown : "");
	},

	/** Markers for a list of steps: [{kind: "gate" | "wormhole" | "hub", systemID, colour, systemKind, title}].
	Hub markers (a hop into or out of Thera / Turnur: an EVE-Scout hole, or a mapped wormhole into one of them) are
	circles in the hub's colour (HUB_COLOURS) with a ring, whatever system they enter.
	@param steps [{from, to, kind: "gate" | "wormhole" | "scout", lineIndex (wormhole), hubName, sig, sigSystemID, hole (scout)}]
	@param lookup function(systemID) -> system-like object {name, security, class, regionID, factionID} or null
	@param regionName function(regionID) -> name or ""
	@param hole function(step) -> {label: "H296" | "K162" | "", thirdParty: bool} for wormhole steps */
	markers: function(steps, lookup, regionName, hole) {
		const rs = favouritesRouteStrip;
		const total = (steps || []).length;
		return (steps || []).map(function(step, i) {
			const system = lookup(step.to);
			const from = lookup(step.from);
			const style = rs.systemStyle(system);
			const info = step.kind === "wormhole" ? (hole ? hole(step) || {} : {}) : {};
			const hubName = step.kind === "scout" ? step.hubName
				: step.kind === "wormhole" ? (system && rs.HUB_SYSTEMS[system.name] ? system.name : from && rs.HUB_SYSTEMS[from.name] ? from.name : null)
				: null;
			const kind = step.kind === "gate" ? "gate" : hubName || info.thirdParty ? "hub" : "wormhole";
			const name = system && system.name ? String(system.name) : "unknown system";
			const region = system ? regionName(system.regionID) || "" : "";
			const how = step.kind === "gate" ? "Gate"
				: step.kind === "scout" ? hubName + " hole (EVE-Scout)"
				: "Wormhole" + (info.label ? " " + info.label : "") + (info.thirdParty ? " (EVE-Scout)" : "");
			let title = "Jump " + (i + 1) + " of " + total + ": " + how + " → " + name + (style.label && style.label !== name ? " " + style.label : "")
				+ (region ? " · " + region : "");
			if (step.kind === "scout") {
				const where = lookup(step.sigSystemID);
				title += " · warp to " + (step.sig || "?") + " in " + (where && where.name ? where.name : "?") + (step.hole ? " · " + step.hole : "");
			}
			const colour = kind === "hub" && hubName && rs.HUB_COLOURS[hubName] ? rs.HUB_COLOURS[hubName] : style.colour;
			return { kind: kind, systemID: step.to, colour: colour, systemKind: kind === "hub" && hubName ? "hub-" + hubName.toLowerCase() : style.kind, title: title };
		});
	},

	/** Gate steps along a path of system IDs (real, or guidance's offset IDs) */
	pathSteps: function(path) {
		const ids = (Array.isArray(path) ? path : []).map(function(id) { const n = Number(id); return n > 0 && n < 30000000 ? n + 30000000 : n; });
		const out = [];
		for (let i = 1; i < ids.length; i++) { out.push({ from: String(ids[i - 1]), to: String(ids[i]), kind: "gate" }); }
		return out;
	},

	/** How many markers fit in `width` px; when not all do, room is kept for the "…+N" in the middle (at least 2:
	the first jump and the destination) */
	fit: function(count, width, step, gapWidth) {
		const rs = favouritesRouteStrip;
		step = step || rs.MARKER_STEP;
		gapWidth = gapWidth === undefined ? rs.GAP_WIDTH : gapWidth;
		const all = Math.floor((Number(width) || 0) / step);
		if (count <= all) { return count; }
		return Math.min(count, Math.max(2, Math.floor(((Number(width) || 0) - gapWidth) / step)));
	},

	/** Markers to show when only `max` fit: the start and the end of the route, the middle replaced by one
	{gap: n, hidden: [markers]} item. Returns the list unchanged when it fits, or when only one or two would be hidden
	(the "…+N" is wider than that; the strip wraps instead, which only happens when the panel is very narrow). */
	compress: function(markers, max) {
		const list = markers || [];
		if (!(max >= 0) || list.length <= max) { return list.slice(); }
		const keep = Math.max(2, max);
		if (list.length - keep <= 2) { return list.slice(); }
		const tail = Math.max(1, Math.floor(keep / 2));
		const head = keep - tail;
		const hidden = list.slice(head, list.length - tail);
		return list.slice(0, head).concat([{ gap: hidden.length, hidden: hidden }], list.slice(list.length - tail));
	},

	/** Small signature chips for the EVE-Scout holes of a route (theraRoute.warpSigs): the sig ID, the rest in the
	tooltip; a click copies the ID (UI). All text escaped. */
	sigChipsHtml: function(chips) {
		const esc = favouritesRouteStrip.escape;
		return (chips || []).map(function(c) {
			const hub = String(c.hubName || "");
			const title = "In " + c.where + " warp to " + c.sig + (c.into ? " into " + hub : " out of " + hub + " to " + c.to)
				+ (c.hole ? " (" + c.hole + ")" : "") + ". Click to copy the signature ID.";
			return "<span class='fav-sig fav-sig-" + esc(hub.toLowerCase()) + "' data-sig='" + esc(c.sig) + "' title='" + esc(title) + "'>" + esc(c.sig) + "</span>";
		}).join("");
	},

	/** A whole strip without a panel to measure (Destinations window): the markers for `width` px plus sig chips */
	stripHtml: function(steps, lookup, regionName, width, chips) {
		const rs = favouritesRouteStrip;
		const markers = rs.markers(steps, lookup, regionName, null);
		return "<span class='fav-strip-markers'>" + rs.markersHtml(rs.compress(markers, rs.fit(markers.length, width))) + "</span>"
			+ (chips && chips.length ? "<span class='fav-sigs'>" + rs.sigChipsHtml(chips) + "</span>" : "");
	},

	/** HTML for the markers (all text escaped) */
	markersHtml: function(items) {
		const esc = favouritesRouteStrip.escape;
		return (items || []).map(function(m) {
			if (m.gap) {
				const titles = m.hidden.map(function(h) { return h.title; });
				const shown = titles.length > 12 ? titles.slice(0, 6).concat(["…"], titles.slice(-6)) : titles;
				return "<span class='fav-mk-gap' title='" + esc(m.gap + " more jumps:\n" + shown.join("\n")) + "'>…+" + m.gap + "</span>";
			}
			return "<i class='fav-mk fav-mk-" + esc(m.kind) + " fav-mk-" + esc(m.systemKind) + "' style='--fav-mk:" + esc(m.colour) + "' title='" + esc(m.title) + "'></i>";
		}).join("");
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && typeof favouritesPanel !== "undefined") {
	(function() {
		const rs = favouritesRouteStrip;
		const fp = favouritesPanel;
		// The chain as of the last route decorate: what's needed to turn a plan into jumps later
		let snapshot = { connections: [], thirdParty: {}, lineWormholes: {}, start: null, ignore: null };
		let pathCache = {}, pathCount = 0;

		function isOn() { return rs.enabled(options); }
		function gateMap() { return (tripwire.map && tripwire.map.shortest) || appData.map.shortest; }
		function lookup(id) {
			const n = Number(id);
			if (appData.systems[id]) { return Object.assign({ systemID: n }, appData.systems[id]); }
			if (typeof systemAnalysis === "undefined") { return null; }
			return rs.genericSystem(systemAnalysis.analyse(id));	// generic "Class-5|..." chain systems
		}
		function regionName(regionID) { return (tripwire.regions && tripwire.regions[regionID] && tripwire.regions[regionID].name) || ""; }

		function gatePath(from, to, safe) {
			const key = from + ">" + to + (safe ? "|safe" : "") + "|" + (snapshot.ignore ? Object.keys(snapshot.ignore).sort().join(",") : "");
			if (!(key in pathCache)) {
				if (++pathCount > 200) { pathCache = {}; pathCount = 1; }
				pathCache[key] = autopilotRoute.gatePath(gateMap(), appData.systems, from, to, safe, snapshot.ignore);
			}
			return pathCache[key];
		}

		function hole(step) {
			const info = { label: "", thirdParty: !!snapshot.thirdParty[step.lineIndex] };
			const wh = tripwire.client && tripwire.client.wormholes ? tripwire.client.wormholes[snapshot.lineWormholes[step.lineIndex]] : null;
			if (wh && tripwire.client.signatures) {
				const a = tripwire.client.signatures[wh.initialID], b = tripwire.client.signatures[wh.secondaryID];
				info.label = rs.holeLabel(wh, a ? a.systemID : null, b ? b.systemID : null, step.from);
			}
			return info;
		}

		// Keep a snapshot of the chain each time the panel works out its routes
		if (typeof fp.decorate === "function" && !fp.decorate.routeStripWrapped) {
			const decorate = fp.decorate;
			fp.decorate = function(result, routeFavorites, startSystemID, exits, distances, systems, ignore) {
				const routes = decorate.apply(this, arguments);
				try {
					const rows = (result && result.map && result.map.rows) || [];
					const lines = (result && result.lines) || [];
					const lineWormholes = {};
					lines.forEach(function(line, index) { if (line) { lineWormholes[index] = line[3]; } });
					snapshot = { connections: rally.systemConnections(rows, lines), thirdParty: rs.thirdPartyLines(rows, lines), lineWormholes: lineWormholes,
						start: startSystemID, ignore: ignore || null };
				} catch (e) { console.error("Favourites route strip: snapshot failed", e); }
				return routes;
			};
			fp.decorate.routeStripWrapped = true;
		}

		/** Markers for a favourite's selected route, or null (route off, no route, here...) */
		function markersFor(id) {
			const flags = fp.flags(fp.settings(options), id);
			if (!flags.route) { return null; }
			const plan = (fp.lastRoutes[id] || {})[flags.route];
			const steps = rs.steps(plan, snapshot.start, id, gatePath, snapshot.connections);
			return steps ? rs.markers(steps, lookup, regionName, hole) : null;
		}

		/** Signature chips for a favourite's route through Thera / Turnur, or [] */
		function chipsFor(id) {
			const flags = fp.flags(fp.settings(options), id);
			const plan = flags.route ? (fp.lastRoutes[id] || {})[flags.route] : null;
			if (!plan || plan.kind !== "scout" || typeof theraRoute === "undefined") { return []; }
			return theraRoute.warpSigs(plan, function(sid) { const s = lookup(sid); return s && s.name ? s.name : String(sid); }, Date.now());
		}
		rs.lookup = lookup;
		rs.regionName = regionName;

		function layoutStrip($strip) {
			const markers = $strip.data("markers") || [];
			const $marks = $strip.find(".fav-strip-markers");
			const width = $marks.width() || 0;
			$marks.html(rs.markersHtml(rs.compress(markers, rs.fit(markers.length, width))));
		}

		const BREAKDOWN_ATTR = "data-fav-breakdown";	// the row's "1g → 2wh → 6g", kept while the strip shows instead

		/** The route text as the panel rendered it: from the attribute once a strip has replaced it */
		function breakdownOf($text) {
			const stored = $text.attr(BREAKDOWN_ATTR);
			return stored !== undefined ? stored : $text.clone().children().remove().end().text();
		}

		function decorateRows() {
			const $rows = $("#" + fp.WIDGET_ID + " .fav-row");
			$rows.removeClass("fav-has-strip").find(".fav-strip").remove();
			// Rows decorated before (this runs again on Save / Reset without the panel re-rendering): text back first
			$rows.find(".fav-route-text[" + BREAKDOWN_ATTR + "]").each(function() {
				const $text = $(this);
				$text.contents().filter(function() { return this.nodeType === 3; }).remove();
				$text.append(document.createTextNode($text.attr(BREAKDOWN_ATTR))).removeAttr(BREAKDOWN_ATTR);
			});
			if (!isOn()) { return; }
			$rows.each(function() {
				const $row = $(this);
				const id = fp.toID($row.data("systemid"));
				let markers = null;
				try { markers = markersFor(id); } catch (e) { console.error("Favourites route strip", e); }
				if (!markers || !markers.length) { return; }
				const $text = $row.find(".fav-route-text");
				const summary = $text.attr("title") || "";
				const breakdown = breakdownOf($text);
				const title = rs.stripTitle(summary, breakdown);
				$text.attr(BREAKDOWN_ATTR, breakdown).contents().filter(function() { return this.nodeType === 3; }).remove();	// the text moves into the tooltip
				const $strip = $("<div class='fav-strip'></div>").attr("title", title)
					.append($("<span class='fav-strip-count'></span>").text(markers.length + (markers.length === 1 ? " jump" : " jumps")))
					.append("<span class='fav-strip-markers'></span>");
				$strip.data("markers", markers);
				const chips = chipsFor(id);
				if (chips.length) { $strip.append("<span class='fav-sigs'>" + rs.sigChipsHtml(chips) + "</span>"); }
				$row.addClass("fav-has-strip").append($strip);
				layoutStrip($strip);
			});
		}
		rs.decorateRows = decorateRows;

		function relayout() {
			$("#" + fp.WIDGET_ID + " .fav-strip").each(function() { layoutStrip($(this)); });
		}

		let observed = null, resizeTimer = null;
		const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(decorateRows) : null;
		const resizer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(function() {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(relayout, 50);
		}) : null;
		function watch() {
			const list = document.querySelector("#" + fp.WIDGET_ID + " .fav-list");
			if (list === observed) { return; }
			if (observer) { observer.disconnect(); }
			if (resizer) { resizer.disconnect(); }
			observed = list;
			if (list) {
				if (observer) { observer.observe(list, { childList: true }); }	// the panel rebuilds its rows
				if (resizer) { resizer.observe(list); }
				decorateRows();
			}
		}

		// ---- Settings > Routes & Navigation, under the Favourites panel's own row ----
		function setupSettings() {
			// Takes effect on Save; Reset = on
			forkSettings.register({
				section: "routes", order: 51, id: "favouritesRouteStrip-enabled", type: "checkbox", key: "favouritesRouteStrip",
				label: "", text: "Show routes as jump markers", keywords: "favourites panel",
				get: function() { return isOn(); },
				set: function(o, on) { o.favouritesRouteStrip = { enabled: on }; }
			});
			// Save and Reset both end in options.apply(): the panel re-renders (or is re-added) there
			if (typeof options.apply === "function" && !options.apply.routeStripWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					setTimeout(function() { watch(); decorateRows(); }, 0);
					return result;
				};
				options.apply.routeStripWrapped = true;
			}
		}

		/** Copy a signature chip's ID (Favourites panel, Destinations window) */
		function copySig(e) {
			e.preventDefault();
			e.stopPropagation();
			const sig = String($(this).attr("data-sig") || "");
			if (!sig) { return; }
			const done = function() { if (typeof Notify !== "undefined") { Notify.trigger("Copied " + rs.escape(sig), "green", 2000); } };
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(sig).then(done, function() { window.prompt("Signature ID", sig); });
			} else {
				window.prompt("Signature ID", sig);
			}
		}

		$(function() {
			setupSettings();
			setTimeout(watch, 0);	// the panel adds its widget in its own ready handler
			$(document).on("click", ".fav-sig[data-sig]", copySig);
		});
	})();
}
