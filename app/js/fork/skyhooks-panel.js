const skyhooksPanel = {
	// Raidable skyhooks panel (fork-owned): a movable/resizable widget listing the skyhooks that can be raided
	// (stolen from) soon, near the chain's k-space exits. The list comes from public/skyhooks.php, which keeps one
	// server-wide copy of ESI's /skyhooks/raidable (the browser never calls ESI: that route allows 30 requests per
	// 15 minutes per IP). Jumps use the same gate routing as the Destinations window (routeDestinations, i.e. the
	// user's route security preference and avoid list). Saved per user in
	// options.skyhooksPanel = {enabled, maxJumps, low, null, window, soonHours, sort, position}; a missing key means
	// the default (panel on, 10 jumps, low-sec and null-sec, opens within 2 h, sorted by jumps).
	// Keep `const skyhooksPanel` on the first line: the test helper strips it to define a global.
	WIDGET_ID: "skyhooksWidget",
	URL: "skyhooks.php",
	REFRESH_MS: 5 * 60 * 1000,
	TICK_MS: 5000,
	REDRAW_MS: 30000,
	DEFAULT_SIZE: { x: 12, y: 8 },
	MIN_SIZE: { x: 5, y: 3 },
	DEFAULTS: { enabled: true, maxJumps: 10, low: true, null: true, window: "soon", soonHours: 2, sort: "jumps" },
	MAX_JUMPS_CHOICES: [3, 5, 10, 15, 20, 30],
	MAX_SEARCH_JUMPS: 60,       // "any distance" still stops here
	WINDOWS: ["now", "soon", "all"],
	SOON_HOURS_CHOICES: [1, 2, 4, 8, 24],
	SORTS: ["jumps", "start"],

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	// ---- Settings (pure) ----

	/** The effective settings from options.skyhooksPanel: every value valid, missing ones at their default.
	maxJumps 0 means "any distance". */
	settings: function(saved) {
		const d = skyhooksPanel.DEFAULTS;
		const s = saved && typeof saved === "object" ? saved : {};
		const maxJumps = Number(s.maxJumps);
		const soonHours = Number(s.soonHours);
		return {
			enabled: s.enabled !== false,
			maxJumps: s.maxJumps !== undefined && s.maxJumps !== null && s.maxJumps !== "" && Number.isInteger(maxJumps) && maxJumps >= 0 && maxJumps <= 200 ? maxJumps : d.maxJumps,
			low: s.low !== false,
			null: s.null !== false,
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

	/** Cheap filters (no routing): security and window. Returns the skyhooks that pass.
	@param skyhooks [{planetID, systemID, start, end}]; systemFor(id) the system's static data */
	prefilter: function(skyhooks, systemFor, now, settings) {
		return (Array.isArray(skyhooks) ? skyhooks : []).filter(function(s) {
			return s && skyhooksPanel.windowPasses(s.start, s.end, now, settings) && skyhooksPanel.securityPasses(systemFor(s.systemID), settings);
		});
	},

	/** Nearest chain exit: {exit, jumps} (fewest gate jumps; ties go to the earlier exit), or null if no exit reaches it.
	@param jumpsFn (exitSystemID, systemID) => jumps or null */
	nearestExit: function(exits, systemID, jumpsFn) {
		let best = null;
		(exits || []).forEach(function(exit) {
			const j = jumpsFn(exit.systemID, systemID);
			if (j !== null && j !== undefined && (!best || j < best.jumps)) { best = { exit: exit, jumps: j }; }
		});
		return best;
	},

	/** The rows to show: [{skyhook, nearest}] within maxJumps (0 = any), sorted
	@param jumpsFn (exitSystemID, systemID, limit) => jumps or null */
	rows: function(skyhooks, exits, systemFor, jumpsFn, now, settings) {
		const limit = settings.maxJumps > 0 ? settings.maxJumps : skyhooksPanel.MAX_SEARCH_JUMPS;
		const rows = skyhooksPanel.prefilter(skyhooks, systemFor, now, settings).map(function(s) {
			return { skyhook: s, nearest: skyhooksPanel.nearestExit(exits, s.systemID, function(from, to) { return jumpsFn(from, to, limit); }) };
		}).filter(function(r) { return r.nearest && r.nearest.jumps <= limit; });
		return skyhooksPanel.sort(rows, settings.sort);
	},

	/** Sorted copy: "jumps" (then window start), or "start" (then jumps) */
	sort: function(rows, by) {
		const jumps = function(r) { return r.nearest ? r.nearest.jumps : Infinity; };
		return rows.slice().sort(function(a, b) {
			if (by === "start") { return a.skyhook.start - b.skyhook.start || jumps(a) - jumps(b) || a.skyhook.systemID - b.skyhook.systemID; }
			return jumps(a) - jumps(b) || a.skyhook.start - b.skyhook.start || a.skyhook.systemID - b.skyhook.systemID;
		});
	},

	/** Text for an empty list: {kind, text}. `count` is the number of skyhooks the server knows, `exits` the chain's exits. */
	emptyState: function(count, exits, settings) {
		if (!count) { return { kind: "none", text: "No raidable skyhooks right now." }; }
		if (!exits || !exits.length) { return { kind: "noexits", text: "No k-space exit on your chain yet: jumps are counted from the chain's k-space systems." }; }
		return { kind: "filtered", text: "No raidable skyhook matches your options (" + (settings.maxJumps > 0 ? "within " + settings.maxJumps + " jumps" : "any distance") + "). Widen them above." };
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && typeof forkSettings !== "undefined") {
	(function() {
		const sp = skyhooksPanel;
		let data = null;          // last answer of skyhooks.php: {skyhooks, fetched, stale, error}
		let loadError = null;     // text when the last request failed
		let skew = 0;             // server time - browser time, seconds
		let loading = false;
		let lastExitsKey = null;
		let lastRender = 0;

		function opts() { return sp.settings(options.skyhooksPanel); }
		function isOn() { return opts().enabled; }
		function now() { return Date.now() / 1000 + skew; }
		function systemFor(id) { return (typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(id) : null) || appData.systems[id] || null; }
		function exits() { return (typeof routeDestinations !== "undefined" && routeDestinations.lastExits) || []; }
		function exitsKey() { return exits().map(function(e) { return e.systemID; }).join(","); }
		function jumps(from, to, limit) {
			const path = guidance.findShortestPath(routeDestinations.routeMap(), from - 30000000, to - 30000000, limit + 1);
			return path && path.length ? path.length - 1 : null;
		}
		function save(patch) {
			options.skyhooksPanel = Object.assign({}, options.skyhooksPanel || {}, patch);
			options.save();
		}

		// ---- Data ----

		function load() {
			if (loading || !isOn()) { return; }
			loading = true;
			$.ajax({ url: sp.URL, dataType: "json", cache: false }).done(function(d) {
				if (!d || !Array.isArray(d.skyhooks)) { loadError = "Unexpected answer from the server."; return; }
				data = d;
				loadError = null;
				if (d.now) { skew = d.now - Date.now() / 1000; }
			}).fail(function(xhr) {
				loadError = xhr && xhr.status === 403 ? "Not signed in." : "Could not load the skyhook list.";
			}).always(function() {
				loading = false;
				render();
			});
		}

		// ---- Widget ----

		function selectHtml(cls, choices, value) {
			return "<select class='" + cls + "'>" + choices.map(function(c) {
				return "<option value='" + sp.escape(c[0]) + "'" + (String(c[0]) === String(value) ? " selected" : "") + ">" + sp.escape(c[1]) + "</option>";
			}).join("") + "</select>";
		}

		function optionsHtml(s) {
			const jumpChoices = sp.MAX_JUMPS_CHOICES.map(function(n) { return [n, n + " jumps"]; }).concat([[0, "Any distance"]]);
			const windowChoices = [["now", "Vulnerable now"], ["soon", "Opens within..."], ["all", "All windows"]];
			return "<div class='sky-options'>"
				+ "<label title='Gate jumps from the nearest k-space system on your chain'>Within " + selectHtml("sky-max", jumpChoices, s.maxJumps) + "</label>"
				+ "<label><input type='checkbox' class='sky-low'" + (s.low ? " checked" : "") + " /> Low-sec</label>"
				+ "<label><input type='checkbox' class='sky-null'" + (s.null ? " checked" : "") + " /> Null-sec</label>"
				+ "<label>Window " + selectHtml("sky-window", windowChoices, s.window)
				+ (s.window === "soon" ? " " + selectHtml("sky-hours", sp.SOON_HOURS_CHOICES.map(function(h) { return [h, h + " h"]; }), s.soonHours) : "") + "</label>"
				+ "<label>Sort " + selectHtml("sky-sort", [["jumps", "Jumps"], ["start", "Window start"]], s.sort) + "</label>"
				+ "</div>";
		}

		function widgetHtml() {
			return "<li id='" + sp.WIDGET_ID + "' class='gridWidget'>"
				+ "<div class='controls'><span class='sky-title'><i data-icon='anchor'></i> Raidable skyhooks <span class='sky-count'></span></span>"
				+ "<span class='sky-time' title='Times are EVE time (UTC)'>EVE time</span></div>"
				+ "<div class='content'><div class='sky-opts'></div><div class='sky-status'></div><ul class='sky-list'></ul></div>"
				+ "</li>";
		}

		function rowHtml(r, t) {
			const esc = sp.escape;
			const sys = systemFor(r.skyhook.systemID) || {};
			const regions = (typeof appData !== "undefined" && appData.regions) || {};
			const region = (regions[sys.regionID] || {}).name || "";
			const st = sp.status(r.skyhook.start, r.skyhook.end, t);
			const sec = sp.securityClass(sys);
			const exit = r.nearest.exit;
			const exitName = (systemFor(exit.systemID) || {}).name || exit.systemID;
			const secText = isFinite(Number(sys.security)) ? (Math.round(Number(sys.security) * 10) / 10 || 0).toFixed(1) : "";
			return "<li class='sky-row sky-" + st.state + "' data-systemid='" + esc(r.skyhook.systemID) + "' data-exit='" + esc(exit.systemID) + "' data-planet='" + esc(r.skyhook.planetID) + "'>"
				+ "<span class='sky-system'><a class='" + esc(sys.systemTypeClass) + "' href='.?system=" + esc(sys.name) + "' title='View " + esc(sys.name) + "'>" + esc(sys.name || r.skyhook.systemID) + "</a>"
				+ " <span class='sky-sec sky-sec-" + esc(sec) + "'>" + esc(secText) + "</span></span>"
				+ "<span class='sky-region' title='" + esc(region) + "'>" + esc(region) + "</span>"
				+ "<span class='sky-exit' title='Nearest k-space system on your chain: " + esc(exitName) + "'>" + (r.nearest.jumps === 0 ? "on the chain" : r.nearest.jumps + (r.nearest.jumps === 1 ? " jump" : " jumps") + " from " + esc(exitName)) + "</span>"
				+ "<span class='sky-window' title='" + esc(sp.windowText(r.skyhook.start, r.skyhook.end, t)) + " EVE time'>" + esc(sp.windowText(r.skyhook.start, r.skyhook.end, t)) + "</span>"
				+ "<span class='sky-countdown'>" + esc(sp.countdown(r.skyhook.start, r.skyhook.end, t)) + "</span>"
				+ (r.nearest.jumps > 0 && typeof autopilotRoute !== "undefined" && typeof autopilotRoute.push === "function"
					? "<i class='sky-route' data-icon='auto' title='Set route in game: gate route from " + esc(exitName) + " to " + esc(sys.name) + " as autopilot waypoints'></i>" : "<i class='sky-route-none'></i>")
				+ "</li>";
		}

		function render() {
			lastRender = Date.now();
			const $w = $("#" + sp.WIDGET_ID);
			if (!$w.length) { return; }
			const s = opts();
			const $opts = $w.find(".sky-opts");
			if (!$opts.find(".sky-options").length || $opts.data("rendered") !== JSON.stringify(s)) {
				// Don't rebuild a control while it is being used
				if (!$opts.find(":focus").length) { $opts.html(optionsHtml(s)).data("rendered", JSON.stringify(s)); }
			}
			const $status = $w.find(".sky-status"), $list = $w.find(".sky-list");
			const e = exits();
			lastExitsKey = exitsKey();
			if (!data) {
				$list.empty();
				$w.find(".sky-count").text("");
				$status.text(loadError || "Loading...").toggleClass("sky-error", !!loadError);
				return;
			}
			const t = now();
			let rows = [];
			try {
				rows = sp.rows(data.skyhooks, e, systemFor, jumps, t, s);
			} catch (err) { console.error("Skyhooks panel: routing failed", err); }
			$w.find(".sky-count").text(rows.length ? "(" + rows.length + ")" : "");
			const notes = [];
			if (loadError) { notes.push(loadError + " Showing the last list."); }
			else if (data.error && data.stale) { notes.push("ESI is not answering: this list is from " + sp.duration(t - data.fetched) + " ago."); }
			if (!rows.length) { const empty = sp.emptyState(data.skyhooks.length, e, s); notes.push(empty.text); }
			$status.html(notes.map(sp.escape).join("<br/>")).toggleClass("sky-error", !!(loadError || (data.error && data.stale)));
			$list.html(rows.map(function(r) { return rowHtml(r, t); }).join(""));
		}

		// ---- Layout ----

		function gridApi() { return typeof grid !== "undefined" && grid && typeof grid.add_widget === "function" ? grid : null; }

		/** Below the existing widgets at the left, unless a position was saved */
		function placement(api) {
			const fp = typeof favouritesPanel !== "undefined" ? favouritesPanel : null;
			const saved = (fp && fp.gridEntry(options.grid, sp.WIDGET_ID)) || (options.skyhooksPanel && options.skyhooksPanel.position) || null;
			if (saved && Number(saved.col) >= 1 && Number(saved.row) >= 1) {
				return { col: Number(saved.col), row: Number(saved.row), size_x: Math.max(sp.MIN_SIZE.x, Number(saved.size_x) || 0), size_y: Math.max(sp.MIN_SIZE.y, Number(saved.size_y) || 0) };
			}
			let maxRow = 0;
			api.serialize().forEach(function(w) { maxRow = Math.max(maxRow, (Number(w.row) || 1) + (Number(w.size_y) || 1) - 1); });
			return { col: 1, row: maxRow + 1, size_x: sp.DEFAULT_SIZE.x, size_y: sp.DEFAULT_SIZE.y };
		}

		function addWidget() {
			const api = gridApi();
			if (!api) { return; }
			const $existing = $("#" + sp.WIDGET_ID);
			if ($existing.length) {
				if (api.$widgets.is($existing)) { return; }
				$existing.stop(true, true).remove();
			}
			const p = placement(api);
			const $widget = api.add_widget(widgetHtml(), p.size_x, p.size_y, p.col, p.row, null, [sp.MIN_SIZE.x, sp.MIN_SIZE.y]);
			$widget.stop(true, true);
			$widget.find(".grid-resize").attr("data-icon", "resize").toggleClass("hidden", !$("#layout").hasClass("active"));
			render();
			load();
		}

		function removeWidget() {
			const api = gridApi();
			const $widget = $("#" + sp.WIDGET_ID);
			if (!api || !$widget.length) { return; }
			const entry = typeof favouritesPanel !== "undefined" ? favouritesPanel.gridEntry(api.serialize($widget), sp.WIDGET_ID) : null;
			if (entry) {
				options.skyhooksPanel = Object.assign({}, options.skyhooksPanel || {}, { position: { col: entry.col, row: entry.row, size_x: entry.size_x, size_y: entry.size_y } });
			}
			api.remove_widget($widget, true);
			$widget.stop(true, true);
		}

		function applyEnabled() {
			if (isOn()) { addWidget(); } else { removeWidget(); }
		}

		// ---- Settings > Routes & Navigation ----

		function setupSettings() {
			forkSettings.register({
				section: "routes", order: 60, id: "skyhooksPanel-enabled", type: "checkbox", key: "skyhooksPanel",
				label: "Raidable skyhooks:", text: "Show the Raidable skyhooks panel",
				get: function() { return isOn(); },
				set: function(o, on) { o.skyhooksPanel = Object.assign({}, o.skyhooksPanel || {}, { enabled: on }); }
			});
			forkSettings.register({
				section: "routes", order: 61, id: "skyhooksPanel-maxJumps", type: "select",
				label: "Skyhooks within:",
				choices: sp.MAX_JUMPS_CHOICES.map(function(n) { return [String(n), n + " jumps of the chain"]; }).concat([["0", "Any distance"]]),
				get: function() { return String(opts().maxJumps); },
				set: function(o, v) { o.skyhooksPanel = Object.assign({}, o.skyhooksPanel || {}, { maxJumps: Number(v) }); },
				reset: function(o) { if (o.skyhooksPanel) { delete o.skyhooksPanel.maxJumps; } }
			});
			if (!options.apply.skyhooksPanelWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					try { applyEnabled(); render(); } catch (err) { console.error("Skyhooks panel: apply failed", err); }
					return result;
				};
				options.apply.skyhooksPanelWrapped = true;
			}
		}

		$(function() {
			setupSettings();
			applyEnabled();

			const sel = "#" + sp.WIDGET_ID;
			const $doc = $(document);
			$doc.on("change", sel + " .sky-max", function() { save({ maxJumps: Number($(this).val()) }); render(); });
			$doc.on("change", sel + " .sky-low", function() { save({ low: this.checked }); render(); });
			$doc.on("change", sel + " .sky-null", function() { save({ null: this.checked }); render(); });
			$doc.on("change", sel + " .sky-window", function() { save({ window: $(this).val() }); render(); });
			$doc.on("change", sel + " .sky-hours", function() { save({ soonHours: Number($(this).val()) }); render(); });
			$doc.on("change", sel + " .sky-sort", function() { save({ sort: $(this).val() }); render(); });
			$doc.on("click", sel + " .sky-route", function(e) {
				e.preventDefault();
				const $row = $(this).closest(".sky-row");
				const from = Number($row.data("exit")), to = Number($row.data("systemid"));
				const route = routeDestinations.route(from, to);
				if (!route) { return; }
				const name = function(id) { return (systemFor(id) || {}).name || id; };
				autopilotRoute.push(route.path, name(from) + " → " + name(to) + " (skyhook)");
			});

			setInterval(function() { if (isOn()) { load(); } }, sp.REFRESH_MS);
			// Countdowns every 30 s; sooner when the chain's exits change
			setInterval(function() {
				if (!isOn() || !$("#" + sp.WIDGET_ID).length) { return; }
				if (exitsKey() !== lastExitsKey || Date.now() - lastRender >= sp.REDRAW_MS) { render(); }
			}, sp.TICK_MS);
		});
	})();
}
