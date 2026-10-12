const stagingScan = {
	// Fork-owned: Staging scan. When the viewed system is k-space null-sec, list the systems within N stargate jumps
	// with their traffic and kills, and flag the likely staging systems (sustained heavy traffic all day, few NPC kills).
	// EVE has no public docked/undocked player counts: ship jumps (traffic) and NPC kills (ratters undocked) are the
	// honest proxies, and the UI says so.
	//  - "now": chain.data.activity (ESI jumps/kills of the last hour, already fetched by the chain map)
	//  - 24 h: public/staging_activity.php (sums of upstream's hourly system_activity table)
	// Settings > Map Markers and the "Staging" button in the chain map header: options.stagingScan.enabled (missing = on).
	// Keep `const stagingScan` on the first line: the test helper strips it to define a global.
	URL: "staging_activity.php",
	RADII: [5, 10, 15],
	DEFAULT_RADIUS: 10,
	ZARZAKH: 30100000,
	POCHVEN_FACTION: 500026,

	// Thresholds (documented in docker/README.md#staging-scan)
	T: {
		top: 3,				// "Likely staging": among the top 3 of the radius by jumps...
		medianFactor: 2,	// ...with at least 2x the radius median of jumps...
		activeHours: 16,	// ...busy (any jumps) in at least 16 of the 24 hours, and NPC kills not outnumbering jumps
		pvpKills: 10,		// 24 h ship + pod kills for "PvP"
		ratting: 200,		// 24 h NPC kills for "Ratting"
		quiet: 20,			// fewer 24 h jumps than this: "Quiet"
		ratterPenalty: 0.5,	// score factor when NPC kills outnumber jumps (a ratting system, not a staging)
		// Last hour only (no 24 h data yet): same idea, hourly numbers
		hour: { minJumps: 20, pvpKills: 3, ratting: 30, quiet: 2 }
	},

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** Whether the feature is on: options.stagingScan.enabled (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.stagingScan && opts.stagingScan.enabled === false);
	},

	/** The saved radius (one of RADII, else the default) */
	radius: function(opts) {
		const r = opts && opts.stagingScan ? Number(opts.stagingScan.radius) : NaN;
		return stagingScan.RADII.indexOf(r) >= 0 ? r : stagingScan.DEFAULT_RADIUS;
	},

	/** k-space null-sec: a gate system (30000000-30999999), not wormhole space, not Pochven, not Zarzakh, security <= 0.0 */
	isNullSec: function(systemID, system) {
		const id = Number(systemID);
		if (!system || !(id >= 30000000 && id < 31000000) || id === stagingScan.ZARZAKH) { return false; }
		if (system.class || system.factionID === stagingScan.POCHVEN_FACTION || Number(system.factionID) === stagingScan.POCHVEN_FACTION) { return false; }
		const sec = Number(system.security);
		return isFinite(sec) && sec <= 0.0;
	},

	/**
	 * Systems within `radius` stargate jumps (plain hop count) of the origin.
	 * @param graph gate adjacency keyed by systemID - 30000000 (tripwire.map.shortest)
	 * @return [{id, jumps}] in BFS order, the origin first (jumps 0); [] when the origin is not on the gate graph
	 */
	bfs: function(graph, originID, radius) {
		const start = Number(originID) - 30000000;
		if (!graph || !graph[start]) { return []; }
		const dist = {};
		dist[start] = 0;
		const out = [{ id: start + 30000000, jumps: 0 }];
		let queue = [start];
		for (let d = 0; d < radius && queue.length; d++) {
			const next = [];
			queue.forEach(function(node) {
				Object.keys(graph[node] || {}).forEach(function(k) {
					if (dist[k] !== undefined) { return; }
					dist[k] = d + 1;
					next.push(k);
					out.push({ id: Number(k) + 30000000, jumps: d + 1 });
				});
			});
			queue = next;
		}
		return out;
	},

	/** Parse the endpoint's answer: {systemID: {jumps, shipKills, podKills, npcKills, activeHours}}, or null when it has no data */
	parseDay: function(data) {
		if (!data || typeof data !== "object" || !data.systems || typeof data.systems !== "object") { return null; }
		const out = {};
		let n = 0;
		Object.keys(data.systems).forEach(function(id) {
			const v = data.systems[id];
			if (!Array.isArray(v) || !(Number(id) > 0)) { return; }
			const num = function(i) { const x = Number(v[i]); return isFinite(x) && x > 0 ? x : 0; };
			out[id] = { jumps: num(0), shipKills: num(1), podKills: num(2), npcKills: num(3), activeHours: num(4) };
			n++;
		});
		return n ? { hours: Number(data.hours) || 24, systems: out } : null;
	},

	median: function(values) {
		if (!values.length) { return 0; }
		const s = values.slice().sort(function(a, b) { return a - b; });
		const m = Math.floor(s.length / 2);
		return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	},

	/**
	 * Merge the BFS result with the activity data, score and tag every system.
	 * @param list [{id, jumps}] from bfs()
	 * @param now {systemID: {shipJumps, shipKills, podKills, npcKills}} (last hour, may be empty/null)
	 * @param day parseDay() result, or null: then the scan uses the last hour only
	 * @return {mode: "24h"|"hour", hours, median, rows: [{id, jumps, now: {jumps, kills, npc}, day: {jumps, kills, npc, activeHours}|null,
	 *          value (the jumps the ranking uses), score, staging, busy, tags: [..]}]} sorted by score (desc), then distance
	 */
	analyse: function(list, now, day) {
		const T = stagingScan.T;
		const mode = day ? "24h" : "hour";
		now = now || {};
		const rows = (list || []).map(function(s) {
			const a = now[s.id] || {};
			const d = day ? (day.systems[s.id] || { jumps: 0, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 0 }) : null;
			const row = {
				id: s.id, jumps: s.jumps,
				now: { jumps: Number(a.shipJumps) || 0, kills: (Number(a.shipKills) || 0) + (Number(a.podKills) || 0), npc: Number(a.npcKills) || 0 },
				day: d ? { jumps: d.jumps, kills: d.shipKills + d.podKills, npc: d.npcKills, activeHours: d.activeHours } : null,
				staging: false, busy: false, tags: []
			};
			const base = row.day || row.now;
			row.value = base.jumps;
			const hours = day ? day.hours : 1;
			const spread = row.day ? Math.min(1, row.day.activeHours / hours) : 1;
			row.score = base.jumps * spread * (base.npc > base.jumps ? T.ratterPenalty : 1);
			return row;
		});

		const median = stagingScan.median(rows.map(function(r) { return r.value; }));
		const byJumps = rows.slice().sort(function(a, b) { return b.value - a.value || a.jumps - b.jumps; });
		byJumps.slice(0, T.top).forEach(function(r) {
			const base = r.day || r.now;
			// few NPC kills: a system where NPC kills outnumber jumps is a ratting system, not a staging
			if (!(r.value > 0) || r.value < T.medianFactor * median || base.npc > base.jumps) { return; }
			if (r.day) { r.staging = r.day.activeHours >= T.activeHours; }
			else { r.busy = r.value >= T.hour.minJumps; }
		});

		rows.forEach(function(r) {
			const th = r.day ? T : T.hour;
			const base = r.day || r.now;
			if (r.staging) { r.tags.push("Likely staging"); }
			if (r.busy) { r.tags.push("Busy now"); }
			if (base.kills >= th.pvpKills) { r.tags.push("PvP"); }
			if (base.npc >= th.ratting) { r.tags.push("Ratting"); }
			if (base.jumps < th.quiet) { r.tags.push("Quiet"); }
		});

		rows.sort(function(a, b) { return b.score - a.score || a.jumps - b.jumps || a.id - b.id; });
		return { mode: mode, hours: day ? day.hours : 1, median: median, rows: rows };
	},

	/** IDs of the "Likely staging" systems of a scan */
	stagingIDs: function(scan) {
		return scan && scan.rows ? scan.rows.filter(function(r) { return r.staging; }).map(function(r) { return r.id; }) : [];
	},

	/** Sort keys of the table's columns: value of a row for that column */
	SORTS: {
		score: function(r) { return r.score; },
		name: null,	// sorted by name, see sortRows
		jumps: function(r) { return r.jumps; },
		sec: null,
		nowJumps: function(r) { return r.now.jumps; },
		dayJumps: function(r) { return r.day ? r.day.jumps : -1; },
		dayKills: function(r) { return r.day ? r.day.kills : r.now.kills; },
		dayNpc: function(r) { return r.day ? r.day.npc : r.now.npc; }
	},

	/**
	 * Sort rows by a column (a new array).
	 * @param info function(id) -> {name, security} for the name / sec columns
	 * @param dir 1 ascending, -1 descending
	 */
	sortRows: function(rows, key, dir, info) {
		const out = rows.slice();
		const tie = function(a, b) { return b.score - a.score || a.jumps - b.jumps || a.id - b.id; };
		if (key === "name") {
			out.sort(function(a, b) { return dir * String(info(a.id).name || "").localeCompare(String(info(b.id).name || "")) || tie(a, b); });
		} else if (key === "sec") {
			out.sort(function(a, b) { return dir * ((Number(info(a.id).security) || 0) - (Number(info(b.id).security) || 0)) || tie(a, b); });
		} else {
			const f = stagingScan.SORTS[key] || stagingScan.SORTS.score;
			out.sort(function(a, b) { return dir * (f(a) - f(b)) || tie(a, b); });
		}
		return out;
	},

	/** Security as EVE shows it: one decimal ("-0.4", "0.0") */
	secText: function(sec) {
		const s = Number(sec);
		if (!isFinite(s)) { return ""; }
		const t = (Math.round(s * 10) / 10).toFixed(1);
		return t === "-0.0" ? "0.0" : t;
	},

	/** Insert the badge into a chain node's HTML (before its icon row, like the other node icons) */
	insertBadge: function(nodeHtml, html) {
		if (!html || typeof nodeHtml !== "string" || nodeHtml.indexOf("staging-badge") >= 0) { return nodeHtml; }
		const at = nodeHtml.indexOf("<div class='nodeIcons'>");
		return at < 0 ? nodeHtml : nodeHtml.substring(0, at) + html + nodeHtml.substring(at);
	},

	/** Add the "likely staging" badge to the chain nodes of these systems (chain.nodes() output, in place); returns how many */
	decorate: function(result, ids, tip) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		if (!ids || !ids.length) { return 0; }
		let n = 0;
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || typeof node.f !== "string" || row.destination) { return; }
			if (ids.indexOf(parseInt(node.systemID, 10)) < 0) { return; }
			const html = "<span class='staging-badge' data-tooltip='" + stagingScan.escape(tip) + "'>STG</span>";
			const f = stagingScan.insertBadge(node.f, html);
			if (f !== node.f) { node.f = f; n++; }
		});
		return n;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	(function() {
		const ss = stagingScan;
		const state = {
			origin: null, cache: {}, day: null, dayHour: null, dayXhr: null, dayFailedAt: 0,
			scan: null, stagingKey: "", sort: { key: "score", dir: -1 }, timer: null, nowRef: null
		};
		const BADGE_TIP = "Likely staging system (Staging scan): busy all day, few NPC kills";

		function opts() { return typeof options !== "undefined" ? options : null; }
		function sys(id) {
			try { return systemAnalysis.analyse(id); } catch (e) { return null; }
		}
		function info(id) {
			const s = (typeof appData !== "undefined" && appData.systems[id]) || {};
			return { name: s.name || String(id), security: s.security, regionID: s.regionID };
		}
		function regionName(regionID) {
			return typeof appData !== "undefined" && appData.regions && appData.regions[regionID] ? appData.regions[regionID].name : "";
		}
		function viewing() { return typeof viewingSystemID !== "undefined" ? parseInt(viewingSystemID, 10) : null; }
		function inNull(id) { return ss.isNullSec(id, sys(id)); }
		function settings() {
			const o = opts();
			if (o && (!o.stagingScan || typeof o.stagingScan !== "object")) { o.stagingScan = {}; }
			return o ? o.stagingScan : {};
		}
		function utcHour() { return new Date().toISOString().substring(0, 13); }

		function list(origin, radius) {
			const key = origin + ":" + radius;
			if (!state.cache[key]) {
				const graph = typeof tripwire !== "undefined" && tripwire.map ? tripwire.map.shortest : (typeof appData !== "undefined" ? appData.map.shortest : null);
				state.cache[key] = ss.bfs(graph, origin, radius);
			}
			return state.cache[key];
		}

		// ---- 24 h data: at most once per UTC hour, only while on and in null-sec ----
		function loadDay() {
			const hour = utcHour();
			if (state.dayHour === hour || state.dayXhr || Date.now() - state.dayFailedAt < 120000) { return; }
			state.dayXhr = $.ajax({ url: ss.URL, data: { h: hour }, type: "GET", dataType: "JSON", cache: true, timeout: 20000 })
				.done(function(data) {
					state.day = ss.parseDay(data);
					state.dayHour = hour;
					schedule();
				})
				.fail(function() { state.dayFailedAt = Date.now(); })
				.always(function() { state.dayXhr = null; });
		}

		// ---- chain map badge ----
		let hooked = false;
		function installHook() {
			if (hooked || typeof chain === "undefined" || !chain || typeof chain.nodes !== "function" || chain.nodes.stagingScanWrapped) { return; }
			hooked = true;
			const previous = chain.nodes;
			const wrapped = function() {
				const result = previous.apply(this, arguments);
				try {
					if (ss.enabled(opts()) && state.scan && state.origin === viewing()) { ss.decorate(result, ss.stagingIDs(state.scan), BADGE_TIP); }
				} catch (e) { console.warn("Staging scan: could not decorate the chain", e); }
				return result;
			};
			Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
			wrapped.stagingScanWrapped = true;
			chain.nodes = wrapped;
		}
		let tipEls = null;
		function attachTips() {
			if (typeof Tooltips === "undefined") { return; }
			if (tipEls && tipEls.length && Tooltips.detach) { Tooltips.detach(tipEls); }
			tipEls = $("#chainMap .staging-badge[data-tooltip]");
			if (tipEls.length) { Tooltips.attach(tipEls); }
		}
		// "Now" data arrives after the map is drawn (chain.activity runs on every draw and when ESI answers)
		let activityHooked = false;
		function installActivityHook() {
			if (activityHooked || typeof chain === "undefined" || !chain || typeof chain.activity !== "function" || chain.activity.stagingScanWrapped) { return; }
			activityHooked = true;
			const previous = chain.activity;
			const wrapped = function(data) {
				const result = previous.apply(this, arguments);
				try {
					if (data && data !== state.nowRef) { schedule(); }
					setTimeout(attachTips, 0);
				} catch (e) { console.warn("Staging scan: activity hook", e); }
				return result;
			};
			Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
			wrapped.stagingScanWrapped = true;
			chain.activity = wrapped;
		}
		function redrawChain() {
			if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); }
		}

		// ---- panel ----
		function $toggle() {
			let $t = $("#staging-scan-toggle");
			if (!$t.length) {
				$t = $("<span id='staging-scan-toggle' class='staging-toggle' role='button' tabindex='0' data-tooltip='Staging scan'>Staging</span>");
				const anchor = $("#chainWidget .controls #higgs-jump");
				if (anchor.length) { anchor.after($t).after(" "); } else { $("#chainWidget .controls").append($t); }
				$t.on("click", function(e) { e.preventDefault(); setEnabled(!ss.enabled(opts())); });
				$t.on("keydown", function(e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEnabled(!ss.enabled(opts())); } });
				if (typeof Tooltips !== "undefined" && Tooltips.attach) { Tooltips.attach($t); }
			}
			return $t;
		}
		function $panel() {
			let $p = $("#staging-scan");
			if (!$p.length) {
				$p = $("<div id='staging-scan' class='staging-scan hidden' aria-live='polite'></div>");
				$("#chainWidget").append($p);
				$p.on("click", ".ss-sys[data-system]", function(e) {
					e.preventDefault();
					const id = parseInt(this.getAttribute("data-system"), 10);
					if (id && id !== viewing() && typeof tripwire !== "undefined") { tripwire.systemChange(id); }
				});
				$p.on("click", "th[data-sort]", function() {
					const key = this.getAttribute("data-sort");
					state.sort = state.sort.key === key ? { key: key, dir: -state.sort.dir } : { key: key, dir: key === "name" || key === "jumps" || key === "sec" ? 1 : -1 };
					render();
				});
				$p.on("change", ".ss-radius", function() {
					settings().radius = Number(this.value);
					save();
					update();
				});
				$p.on("click", ".ss-collapse", function(e) {
					e.preventDefault();
					settings().collapsed = !settings().collapsed;
					save();
					render();
				});
				$p.on("click", ".ss-close", function(e) { e.preventDefault(); setEnabled(false); });
				// Keep wheel and drag inside the panel (the map behind it scrolls/zooms and drag-scrolls)
				$p.on("wheel mousedown", function(e) { e.stopPropagation(); });
			}
			return $p;
		}

		function save() {
			if (typeof options !== "undefined" && typeof options.save === "function") { options.save(); }
		}

		function setEnabled(on) {
			settings().enabled = on;
			save();
			update();
			redrawChain();
		}

		function updateToggle() {
			const on = ss.enabled(opts());
			const tip = on ? "Staging scan is on: click to turn it off" : "Staging scan is off: click to turn it on";
			// jBox reads data-tooltip when it opens, so the tooltip follows the state
			$toggle().toggleClass("active", on).attr("aria-pressed", on ? "true" : "false")
				.attr("data-tooltip", tip + ". It lists busy systems within a few jumps when you view a null-sec system.");
		}

		/** Recompute (after the current draw, never inside it) */
		function schedule() {
			clearTimeout(state.timer);
			state.timer = setTimeout(update, 50);
		}

		function update() {
			updateToggle();
			const origin = viewing();
			const on = ss.enabled(opts());
			const was = state.stagingKey;
			if (!on || !origin || !inNull(origin)) {
				state.scan = null;
				state.origin = origin;
				state.stagingKey = "";
				render();
				if (was) { redrawChain(); }
				return;
			}
			loadDay();
			const now = typeof chain !== "undefined" && chain && chain.data ? chain.data.activity : null;
			state.nowRef = now;
			state.origin = origin;
			state.scan = ss.analyse(list(origin, ss.radius(opts())), now, state.day);
			state.stagingKey = origin + ":" + ss.stagingIDs(state.scan).join(",");
			render();
			if (state.stagingKey !== was) { redrawChain(); }
		}

		function header(key, text, title) {
			const cls = state.sort.key === key ? " class='ss-sorted " + (state.sort.dir > 0 ? "ss-asc" : "ss-desc") + "'" : "";
			return "<th data-sort='" + key + "'" + cls + (title ? " title='" + ss.escape(title) + "'" : "") + ">" + text + "</th>";
		}

		function render() {
			const $p = $panel();
			const origin = viewing();
			// Outside null-sec the panel stays out of the way; the Staging button's tooltip says where it works
			if (!ss.enabled(opts()) || !state.scan) { $p.addClass("hidden").empty(); return; }
			$p.removeClass("hidden");
			const scan = state.scan;
			const r = ss.radius(opts());
			const collapsed = !!settings().collapsed;
			const originInfo = info(origin);
			const n = scan.rows.length;
			const staging = scan.rows.filter(function(x) { return x.staging; }).length;
			let html = "<div class='ss-head'>"
				+ "<a href='#' class='ss-collapse' title='" + (collapsed ? "Expand" : "Collapse") + "'>" + (collapsed ? "&#9656;" : "&#9662;") + "</a> "
				+ "<span class='ss-title'>Staging scan</span> - " + ss.escape(originInfo.name) + " - within "
				+ "<select class='ss-radius' aria-label='Radius in jumps'>"
				+ ss.RADII.map(function(x) { return "<option value='" + x + "'" + (x === r ? " selected" : "") + ">" + x + "</option>"; }).join("")
				+ "</select> jumps - " + n + " systems"
				+ (staging ? " <span class='ss-count'>" + staging + " likely staging</span>" : "")
				+ (scan.mode === "hour" ? " <span class='ss-mode' title='No 24 hour history on the server yet'>last hour only</span>" : "")
				+ " <a href='#' class='ss-close' title='Turn the staging scan off (the Staging button brings it back)'>&times;</a>"
				+ "</div>";
			if (!collapsed) {
				const rows = ss.sortRows(scan.rows, state.sort.key, state.sort.dir, info);
				const dayCol = scan.mode === "24h";
				html += "<div class='ss-body'><table class='ss-table'><thead><tr>"
					+ header("name", "System") + header("jumps", "Jumps", "Stargate jumps from " + originInfo.name)
					+ "<th>Region</th>" + header("sec", "Sec")
					+ header("nowJumps", "Jumps/h", "Ship jumps through the system in the last hour (ESI)")
					+ (dayCol ? header("dayJumps", "Jumps 24h", "Ship jumps in the last 24 hours, and in how many of those hours there was traffic") : "")
					+ header("dayKills", dayCol ? "Kills 24h" : "Kills/h", "Ship and pod kills")
					+ header("dayNpc", dayCol ? "NPC 24h" : "NPC/h", "NPC kills: ratters undocked")
					+ header("score", "Tags", "Sorted by staging score: jumps, spread over the day, fewer if NPC kills outnumber jumps")
					+ "</tr></thead><tbody>";
				rows.forEach(function(row) {
					const i = info(row.id);
					const s = sys(row.id) || {};
					const region = i.regionID !== originInfo.regionID ? regionName(i.regionID) : "";
					const base = row.day || row.now;
					html += "<tr class='" + (row.staging ? "ss-staging" : "") + (row.id === origin ? " ss-origin" : "") + "'>"
						+ "<td><a href='.?system=" + encodeURIComponent(i.name) + "' class='ss-sys' data-system='" + row.id + "'>" + ss.escape(i.name) + "</a></td>"
						+ "<td class='ss-num'>" + row.jumps + "</td>"
						+ "<td class='ss-region'>" + ss.escape(region) + "</td>"
						+ "<td class='ss-num " + ss.escape(s.systemTypeClass || "") + "'>" + ss.secText(i.security) + "</td>"
						+ "<td class='ss-num'>" + row.now.jumps + "</td>"
						+ (dayCol ? "<td class='ss-num'>" + row.day.jumps + " <span class='ss-hours' title='Hours with traffic'>" + row.day.activeHours + "h</span></td>" : "")
						+ "<td class='ss-num'>" + base.kills + "</td>"
						+ "<td class='ss-num'>" + base.npc + "</td>"
						+ "<td class='ss-tags'>" + row.tags.map(function(t) {
							return "<span class='ss-tag ss-tag-" + ss.escape(t.toLowerCase().replace(/[^a-z]+/g, "-")) + "'>" + ss.escape(t) + "</span>";
						}).join("") + "</td></tr>";
				});
				html += "</tbody></table></div>"
					+ "<div class='ss-foot'>Jumps and kills from ESI (hourly). EVE has no public docked-player counts; NPC kills show ratters.</div>";
			}
			$p.toggleClass("ss-collapsed", collapsed).html(html);
		}

		// ---- Settings > Map Markers ----
		function setupSettings() {
			forkSettings.register({
				section: "markers", order: 60, id: "stagingScan-enabled", type: "checkbox", key: "stagingScan",
				label: "Staging scan:", text: "In null-sec, list busy systems within a few jumps and mark likely staging systems on the map",
				keywords: ["staging", "null", "nullsec", "jumps", "activity", "neighbourhood"],
				get: function(o) { return ss.enabled(o); },
				set: function(o, on) { o.stagingScan = Object.assign({}, o.stagingScan || {}, { enabled: on }); }
			});
			if (typeof options !== "undefined" && options.apply && !options.apply.stagingScanWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					try { schedule(); } catch (err) { console.error("Staging scan: apply failed", err); }
					return result;
				};
				options.apply.stagingScanWrapped = true;
			}
		}

		installHook();
		$(function() {
			installHook();
			installActivityHook();
			setupSettings();
			if (typeof tripwire !== "undefined" && typeof tripwire.systemChange === "function" && !tripwire.systemChange.stagingScanWrapped) {
				const systemChange = tripwire.systemChange;
				const wrapped = function() {
					const result = systemChange.apply(this, arguments);
					schedule();
					return result;
				};
				Object.keys(systemChange).forEach(function(k) { wrapped[k] = systemChange[k]; });
				wrapped.stagingScanWrapped = true;
				tripwire.systemChange = wrapped;
			}
			// A new hour: refresh the 24 h data (cheap: the endpoint and browser cache it for the hour)
			setInterval(function() { if (!document.hidden && state.scan) { schedule(); } }, 300000);
			schedule();
		});
	})();
}
