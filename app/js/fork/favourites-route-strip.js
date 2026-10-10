const favouritesRouteStrip = {
	// Favourites panel: each favourite's route as a strip of jump markers, one per jump in route order
	// (fork-owned file). Shape = kind of jump (square: stargate, circle: wormhole, triangle: EVE-Scout connection or
	// a wormhole into Thera / Turnur), colour = the system it enters (EVE's security colours for k-space, Tripwire's
	// class colours for J-space). Setting: options.favouritesRouteStrip.enabled (missing = on); off shows the
	// "1g → 2wh → 6g" text as before. Pure logic here; the UI is at the bottom.
	// Keep `const favouritesRouteStrip` on the first line: the test helper strips it to define a global.
	MARKER_STEP: 11,	// px per marker: 9 px marker + 2 px gap (keep in step with the CSS)
	GAP_WIDTH: 34,		// px reserved for the "…+N" in the middle of a compressed strip

	// EVE's in-game security colours (1.0 down to 0.1; 0.0 and below share the null-sec one), the scale the game's
	// map, route and system info use since 2021 (and Wanderer and other mappers follow)
	SECURITY_COLOURS: {
		"1.0": "#2C75E1", "0.9": "#399AEB", "0.8": "#4ECEF8", "0.7": "#60DBA3", "0.6": "#71E754",
		"0.5": "#F5FF83", "0.4": "#DC6D07", "0.3": "#CE440F", "0.2": "#BB1116", "0.1": "#731F1F", "0.0": "#8D3264"
	},
	// Tripwire's own colours (app/css/base.css) for J-space classes, Pochven; Zarzakh gets its own
	CLASS_COLOURS: { 1: "#4399F0", 2: "#4399F0", 3: "#4399F0", 4: "#9060f0", 5: "#9060f0", 6: "#f06090", 12: "#ffc800", 15: "#f06060", 16: "#f06060", 17: "#f06060" },
	WH_COLOUR: "#4399F0",
	POCHVEN_COLOUR: "#FF2060",
	ZARZAKH_COLOUR: "#B8B8D0",
	UNKNOWN_COLOUR: "#777777",
	HUB_SYSTEMS: { Thera: true, Turnur: true },

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Whether the strip is switched on (options.favouritesRouteStrip.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.favouritesRouteStrip && opts.favouritesRouteStrip.enabled === false);
	},

	/** Security as the game shows it: one decimal, rounded to nearest, but anything above 0.0 and below 0.05 is 0.1 */
	displaySecurity: function(security) {
		const s = Number(security);
		if (security === null || security === undefined || security === "" || !isFinite(s)) { return null; }
		if (s > 0 && s < 0.05) { return 0.1; }
		const r = Math.round(s * 10) / 10;
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

	/** Markers for a list of steps: [{kind: "gate" | "wormhole" | "hub", systemID, colour, systemKind, title}].
	@param lookup function(systemID) -> system-like object {name, security, class, regionID, factionID} or null
	@param regionName function(regionID) -> name or ""
	@param hole function(step) -> {label: "H296" | "K162" | "", thirdParty: bool} for wormhole steps */
	markers: function(steps, lookup, regionName, hole) {
		const rs = favouritesRouteStrip;
		const total = (steps || []).length;
		return (steps || []).map(function(step, i) {
			const system = lookup(step.to);
			const style = rs.systemStyle(system);
			const info = step.kind === "wormhole" ? (hole ? hole(step) || {} : {}) : {};
			const kind = step.kind === "gate" ? "gate"
				: info.thirdParty || (system && rs.HUB_SYSTEMS[system.name]) ? "hub" : "wormhole";
			const name = system && system.name ? String(system.name) : "unknown system";
			const region = system ? regionName(system.regionID) || "" : "";
			let how = step.kind === "gate" ? "Gate" : "Wormhole" + (info.label ? " " + info.label : "") + (info.thirdParty ? " (EVE-Scout)" : "");
			const title = "Jump " + (i + 1) + " of " + total + ": " + how + " → " + name + (style.label && style.label !== name ? " " + style.label : "")
				+ (region ? " · " + region : "");
			return { kind: kind, systemID: step.to, colour: style.colour, systemKind: style.kind, title: title };
		});
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
	{gap: n, hidden: [markers]} item. Returns the list unchanged when it fits. */
	compress: function(markers, max) {
		const list = markers || [];
		if (!(max >= 0) || list.length <= max) { return list.slice(); }
		const keep = Math.max(2, max);
		const tail = Math.max(1, Math.floor(keep / 2));
		const head = keep - tail;
		const hidden = list.slice(head, list.length - tail);
		return list.slice(0, head).concat([{ gap: hidden.length, hidden: hidden }], list.slice(list.length - tail));
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
			const s = systemAnalysis.analyse(id);	// generic "Class-5|..." chain systems: class / security only
			return s ? { name: s.name || "unknown system", security: s.security, class: s.class, factionID: s.factionID } : null;
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
					const thirdPartyNodes = {};
					rows.forEach(function(row) {
						const node = row && row.c && row.c[0];
						if (node && typeof node.f === "string" && node.f.indexOf("third-party") >= 0) { thirdPartyNodes[node.v] = true; }
					});
					const thirdParty = {}, lineWormholes = {};
					lines.forEach(function(line, index) {
						if (!line) { return; }
						if (thirdPartyNodes[line[0]] || thirdPartyNodes[line[1]]) { thirdParty[index] = true; }
						lineWormholes[index] = line[3];
					});
					snapshot = { connections: rally.systemConnections(rows, lines), thirdParty: thirdParty, lineWormholes: lineWormholes,
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

		function layoutStrip($strip) {
			const markers = $strip.data("markers") || [];
			const $marks = $strip.find(".fav-strip-markers");
			const width = $marks.width() || 0;
			$marks.html(rs.markersHtml(rs.compress(markers, rs.fit(markers.length, width))));
		}

		function decorateRows() {
			const $rows = $("#" + fp.WIDGET_ID + " .fav-row");
			$rows.removeClass("fav-has-strip").find(".fav-strip").remove();
			if (!isOn()) { return; }
			$rows.each(function() {
				const $row = $(this);
				const id = fp.toID($row.data("systemid"));
				let markers = null;
				try { markers = markersFor(id); } catch (e) { console.error("Favourites route strip", e); }
				if (!markers || !markers.length) { return; }
				const $text = $row.find(".fav-route-text");
				const summary = $text.attr("title") || "";
				const breakdown = $text.clone().children().remove().end().text();
				const title = summary + (breakdown && summary.indexOf(breakdown) < 0 ? " · " + breakdown : "");
				$text.contents().filter(function() { return this.nodeType === 3; }).remove();	// the text moves into the tooltip
				const $strip = $("<div class='fav-strip'></div>").attr("title", title)
					.append($("<span class='fav-strip-count'></span>").text(markers.length + (markers.length === 1 ? " jump" : " jumps")))
					.append("<span class='fav-strip-markers'></span>");
				$strip.data("markers", markers);
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

		// ---- Settings > General Preferences, under the Favourites panel's own row ----
		function setupSettings() {
			if (!$("#favouritesRouteStrip-enabled").length) {
				const row = "<tr><th></th><td><label><input type='checkbox' id='favouritesRouteStrip-enabled' /> Show routes as jump markers</label></td></tr>";
				const $panelRow = $("#favouritesPanel-enabled").closest("tr");
				if ($panelRow.length) {
					$panelRow.after(row);
				} else {
					$("#dialog-options #optionsAccordion > div").eq(2).find("table.optionsTable").first().append(row.replace("<th></th>", "<th>Favourites panel:</th>"));
				}
				if ($("#optionsAccordion").hasClass("ui-accordion")) { $("#optionsAccordion").accordion("refresh"); }
			}
			$(document).on("dialogopen", "#dialog-options", function() {
				$("#favouritesRouteStrip-enabled").prop("checked", isOn());
			});
			// Capture phase so the value is in place before upstream's Save handler applies and saves options
			document.addEventListener("click", function(e) {
				const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
				if (!button || $.trim($(button).text()) !== "Save") { return; }
				if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#favouritesRouteStrip-enabled").length) { return; }
				options.favouritesRouteStrip = { enabled: $("#favouritesRouteStrip-enabled").prop("checked") };
			}, true);

			// Settings > Reset: a missing key means on
			if (typeof options.reset === "function" && !options.reset.routeStripWrapped) {
				const reset = options.reset;
				const wrapped = function() {
					const result = reset.apply(this, arguments);
					delete this.favouritesRouteStrip;
					return result;
				};
				Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
				wrapped.routeStripWrapped = true;
				options.reset = wrapped;
			}
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

		$(function() {
			setupSettings();
			setTimeout(watch, 0);	// the panel adds its widget in its own ready handler
		});
	})();
}
