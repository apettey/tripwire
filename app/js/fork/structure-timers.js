const structureTimers = {
	// Structure timers (fork-owned, spec phase 2 of reports/Structures and timers spec.md): the parts of the Structures
	// feature (app/js/fork/structures.js) that look across systems.
	//  - Chain map markers: a structure glyph (orange = a hostile owner, grey otherwise) and a clock glyph (amber, red under
	//    1 h or just elapsed) in the bottom-left corner of nodes whose system holds structures / a timer within 48 h. Data:
	//    structures.php?action=markers for the systems on the map, polled every 60 s with have=<hash>.
	//  - The Timers board: the Structures panel's second view (clock icon in its header): every active timer of the mask,
	//    soonest first, with two filters. Data: structures.php?action=timers.
	//  - The "3 structures - armor timer in 4h12" line under the system info, and two chain context menu entries.
	// Settings: options.structures.mapMarker (Settings > Map Markers; missing = on); the rest follows options.structures.enabled.
	// Keep `const structureTimers` on the first line: the test helper strips it to define a global.
	URL: "structures.php",
	POLL_MS: 60000,
	SOON_S: 172800,		// the clock glyph appears 48 hours before a timer ends
	MENU_VIEW: "structuresView",
	MENU_TIMERS: "structuresTimers",
	FILTER_KEY: "tripwire.structureTimers.filters",

	mapMarkerEnabled: function(opts) {
		return !(opts && opts.structures && opts.structures.mapMarker === false);
	},

	// ---- Pure: markers ----

	/** Short label of a timer kind for the board and glyph titles */
	KIND_SHORT: { armor: "Armor", hull: "Hull", pos: "POS", anchoring: "Anchoring", unanchoring: "Unanchoring", fuel: "Fuel", other: "Timer" },

	/**
	 * What to draw on a node for a markers entry.
	 * @param entry {count, hostile, types: [[name, n]], owners: [ticker], lastSeen, nextTimer: {kind, at, typeName, name} | null}
	 * @return {count, hostile, title, timer: {level: soon|urgent, title} | null} or null when there is nothing to draw
	 */
	markerFor: function(entry, nowSec) {
		if (!entry) { return null; }
		const timer = structureTimers.timerGlyph(entry.nextTimer, nowSec);
		if (!(entry.count > 0) && !timer) { return null; }
		let title = "";
		if (entry.count > 0) {
			title = (entry.types || []).map(function(t) { return t[1] + " " + t[0]; }).join(", ")
				+ ((entry.owners || []).length ? " · " + entry.owners.join(", ") : "")
				+ (entry.lastSeen ? " · seen " + structures.age(nowSec - entry.lastSeen) + (structures.age(nowSec - entry.lastSeen) === "now" ? "" : " ago") : "");
		}
		if (timer) { title += (title ? "\n" : "") + timer.title; }
		return { count: entry.count || 0, hostile: !!entry.hostile, title: title, timer: timer };
	},

	/** The clock glyph of a system's next timer: within 48 h or elapsed under 2 h; red under 1 h or elapsed */
	timerGlyph: function(t, nowSec) {
		if (!t || !t.at) { return null; }
		const left = t.at - nowSec;
		if (left > structureTimers.SOON_S || -left > structures.TIMER_PAST_S) { return null; }
		const label = (structureTimers.KIND_SHORT[t.kind] || "Timer") + " timer";
		const what = [t.typeName, t.name].filter(function(x) { return !!x; }).join(" ");
		const when = left > 0 ? "in " + structures.duration(left) : structures.duration(-left) + " ago";
		return { level: left < 3600 ? "urgent" : "soon",
			title: label + " " + when + " (" + structures.formatEve(t.at * 1000).substr(11) + " EVE)" + (what ? ": " + what : "") };
	},

	GLYPHS: {
		structure: "<path d='M1.5 9V4.2L5 1.5 8.5 4.2V9ZM4 9V6.4H6V9' fill='currentColor' fill-rule='evenodd'/>",
		clock: "<circle cx='5' cy='5' r='4' fill='none' stroke='currentColor' stroke-width='1.2'/><path d='M5 2.6V5L6.7 6' stroke='currentColor' fill='none' stroke-width='1.2' stroke-linecap='round'/>"
	},

	glyph: function(name) {
		return "<svg viewBox='0 0 10 10' width='9' height='9' aria-hidden='true'>" + structureTimers.GLYPHS[name] + "</svg>";
	},

	markerHtml: function(m) {
		if (!m) { return ""; }
		const esc = structures.escape;
		return "<span class='str-marker" + (m.count > 0 ? " str-m-" + (m.hostile ? "hostile" : "neutral") : "") + (m.timer ? " str-m-timer str-m-" + m.timer.level : "")
			+ (m.count > 0 && m.timer ? " str-m-both" : "") + "' role='img' title='" + esc(m.title) + "' aria-label='" + esc(m.title) + "'>"
			+ (m.count > 0 ? "<span class='str-m-s'>" + structureTimers.glyph("structure") + "</span>" : "")
			+ (m.timer ? "<span class='str-m-c'>" + structureTimers.glyph("clock") + "</span>" : "") + "</span>";
	},

	/** Insert marker markup into a chain node's HTML before its icon row, like the other corner marks */
	insertMarker: function(nodeHtml, marker) {
		if (!marker || typeof nodeHtml !== "string" || nodeHtml.indexOf("str-marker") >= 0) { return nodeHtml; }
		const at = nodeHtml.indexOf("<div class='nodeIcons'>");
		if (at < 0) { return nodeHtml; }
		return nodeHtml.substring(0, at) + marker + nodeHtml.substring(at);
	},

	/** Real solar systems on the chain (chain.nodes() output), each once, at most 500 */
	chainSystems: function(result, systems) {
		const seen = {};
		const out = [];
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || String(node.v).indexOf("dest-") === 0) { return; }
			const id = parseInt(node.systemID, 10);
			if (id >= 30000000 && id < 33000000 && !seen[id] && (!systems || systems[id])) { seen[id] = true; out.push(id); }
		});
		return out.slice(0, 500);
	},

	// ---- Pure: system info line and board ----

	/** "3 structures · armor timer in 4h12" for the viewed system's live rows, or "" */
	infoLine: function(rows, nowSec) {
		if (!rows || !rows.length) { return ""; }
		const timers = rows.map(function(r) { return Object.assign({ row: r }, structures.timerStatus(r, nowSec)); })
			.filter(function(t) { return t.phase === "upcoming" || t.phase === "elapsed"; })
			.sort(function(a, z) { return (a.phase === "upcoming" ? 0 : 1) - (z.phase === "upcoming" ? 0 : 1) || a.row.timerAt - z.row.timerAt; });
		let text = rows.length + " structure" + (rows.length === 1 ? "" : "s");
		if (timers.length) {
			const t = timers[0];
			text += " · " + t.label.toLowerCase().replace(" (final)", "") + (t.label.toLowerCase().indexOf("timer") < 0 ? " timer" : "")
				+ (t.phase === "upcoming" ? " in " + t.text : " " + t.text.substr(1) + " ago");
		}
		return text;
	},

	/** Rows for the board: active only (an ended timer drops off), filters applied, soonest first */
	boardRows: function(rows, filters, nowSec) {
		const f = filters || {};
		return (rows || []).filter(function(r) {
			const t = structures.timerStatus(r, nowSec);
			if (t.phase === "none" || t.phase === "ended") { return false; }
			if (f.hideEnded && t.phase === "elapsed") { return false; }
			if (f.hostileOnly && r.side === "ours") { return false; }
			return true;
		}).sort(function(a, z) { return a.timerAt - z.timerAt || a.id - z.id; });
	},

	/** Countdown text and class of one timer */
	countdown: function(row, nowSec) {
		const t = structures.timerStatus(row, nowSec);
		return { text: t.text, cls: "str-t-" + t.phase + (t.urgent ? " str-urgent" : "") };
	},

	boardRowHtml: function(row, nowSec, ctx) {
		const esc = structures.escape;
		const t = structures.timerStatus(row, nowSec);
		const name = ctx.systemName(row.systemID);
		const inChain = !!ctx.inChain[row.systemID];
		const owner = row.ownerID ? (row.ownerTicker || row.ownerName || "?") : (row.ownerText || "");
		const tip = [(structureTimers.KIND_SHORT[row.timerKind] || "Timer") + " timer – " + name + (inChain ? "" : " (not in the chain)"),
			row.typeName + (row.name ? " \"" + row.name + "\"" : ""),
			"Ends " + structures.formatEve(row.timerAt * 1000) + " EVE (your time " + structures.formatLocal(row.timerAt * 1000) + ")",
			"Owner: " + (owner || "unknown") + (row.ownerID ? " (" + (row.side === "ours" ? "ours" : "hostile") + ")" : ""),
			(row.timerSetBy ? "Set by " + row.timerSetBy : ""), (row.note ? "Note: " + row.note : ""), "Click to view the system"].filter(function(x) { return !!x; }).join("\n");
		const url = structures.typeIconUrl(row.typeID);
		return "<div class='str-row str-trow' data-sys='" + (parseInt(row.systemID, 10) || 0) + "' title='" + esc(tip) + "'>"
			+ "<span class='str-timer str-tcd str-t-" + t.phase + (t.urgent ? " str-urgent" : "") + "' data-at='" + row.timerAt + "'>" + structures.icon("clock") + "<span class='str-tcd-t'>" + esc(t.text) + "</span></span>"
			+ "<span class='str-tsys" + (inChain ? "" : " str-notchain") + "'>" + esc(name) + "</span>"
			+ (url ? "<img class='str-type' src='" + esc(url) + "' alt='' width='18' height='18' loading='lazy' />" : "<span class='str-type str-type-unk'>?</span>")
			+ "<span class='str-owner str-side-" + (row.ownerID ? esc(row.side) : "unknown") + (!row.ownerID && owner ? " str-unres" : "") + "'>" + esc(owner || "–") + "</span>"
			+ "<span class='str-tkind'>" + esc(structureTimers.KIND_SHORT[row.timerKind] || "Timer") + "</span></div>";
	},

	/**
	 * Body of the Timers view.
	 * @param s {rows (from the server), filters {hostileOnly, hideEnded}, nowSec, inChain {systemID: true}, systemName(id), loaded, error}
	 */
	boardHtml: function(s) {
		const esc = structures.escape;
		const rows = structureTimers.boardRows(s.rows, s.filters, s.nowSec);
		let html = "<div class='str-filters'>"
			+ "<a href='#' class='str-filter" + (s.filters.hostileOnly ? " str-on" : "") + "' data-f='hostileOnly' title='Hostile only: hide the structures of your own corporation / alliance'>Hostile only</a>"
			+ "<a href='#' class='str-filter" + (s.filters.hideEnded ? " str-on" : "") + "' data-f='hideEnded' title='Hide ended: hide timers that already ran out (they stay listed for 2 hours)'>Hide ended</a></div>";
		if (s.error) { html += "<div class='str-error'>" + esc(s.error) + "</div>"; }
		if (!rows.length) { return html + "<div class='str-empty'>" + (s.loaded ? "No active timers." : "Loading…") + "</div>"; }
		rows.forEach(function(r) { html += structureTimers.boardRowHtml(r, s.nowSec, s); });
		if (s.capped) { html += "<div class='str-empty'>Showing the first " + (s.rows || []).length + " timers.</div>"; }
		return html;
	},

	// ---- Pure: in-app alerts (toast + sound) ----

	ALERT_LEADS: [900, 0],		// seconds before the end: 15 minutes, and the end
	ALERT_GRACE_S: 120,			// the "ended" alert is still given this long after the end
	ALERT_SOUNDS: { 900: "tone-chime", 0: "tone-klaxon" },
	ALERT_KEY: "tripwire.structureTimers.alerted",

	alertsEnabled: function(opts) {
		return !(opts && opts.structures && opts.structures.alerts === false);
	},

	/**
	 * The alerts due now: per timer only the most recent due lead (a timer that is already 10 minutes away gives the
	 * 15-minute alert, not the end), never one whose key (id:timerAt:lead) is in `seen`, nothing from 2 minutes after the end.
	 * @param next the mask's next timers (rows as the server sends them)
	 * @return [{key, lead, row}] soonest first
	 */
	dueAlerts: function(next, nowSec, seen) {
		const out = [];
		(next || []).forEach(function(r) {
			if (!r || !r.timerAt || !r.timerKind || nowSec >= r.timerAt + structureTimers.ALERT_GRACE_S) { return; }
			let lead = null;
			structureTimers.ALERT_LEADS.forEach(function(l) {
				if (r.timerAt - l <= nowSec && (lead === null || l < lead)) { lead = l; }
			});
			if (lead === null) { return; }
			const key = r.id + ":" + r.timerAt + ":" + lead;
			if (seen && seen[key]) { return; }
			out.push({ key: key, lead: lead, row: r });
		});
		return out.sort(function(a, z) { return a.row.timerAt - z.row.timerAt; });
	},

	/** "Hull timer in 15 m: Fortizar in J163701" */
	alertText: function(alert, systemName) {
		const r = alert.row;
		const kind = (structureTimers.KIND_SHORT[r.timerKind] || "Timer") + " timer";
		return kind + (alert.lead > 0 ? " in 15 m" : " ended") + ": " + r.typeName + (r.name ? " \"" + structures.splitName(r.name).rest + "\"" : "") + " in " + systemName;
	},

	alertHtml: function(alert, systemName) {
		const esc = structures.escape;
		return "<div class='kill-toast kill-toast-timer" + (alert.lead === 0 ? " kill-toast-timer-end" : "") + "' data-key='" + esc(alert.key) + "' title='Open the Timers board'>"
			+ "<span class='kill-toast-close' title='Dismiss'>&#10005;</span>"
			+ "<div class='kill-toast-text'><span class='str-alert-ico'>" + structures.icon("clock") + "</span> " + esc(structureTimers.alertText(alert, systemName)) + "</div></div>";
	},

	// ---- Browser state ----

	data: {},		// systemID => markers entry
	hash: "",
	next: [],		// the mask's next timers (for the in-app alerts, phase 3)
	offset: 0,		// server time - browser time, seconds
	chainIDs: [],
	filters: { hostileOnly: false, hideEnded: false },
	boardData: null,	// timers of the mask for the board (null until loaded)
	boardCapped: false,	// the server sent only the first STRUCTURES_BOARD_MAX
	boardHash: "",

	opts: function() { return typeof options !== "undefined" ? options : null; },
	nowSec: function() { return Math.floor(Date.now() / 1000) + structureTimers.offset; },
	active: function() { return structures.enabled(structureTimers.opts()) && structureTimers.mapMarkerEnabled(structureTimers.opts()); },

	loadFilters: function() {
		try {
			const f = JSON.parse(window.localStorage.getItem(structureTimers.FILTER_KEY) || "{}");
			structureTimers.filters = { hostileOnly: !!f.hostileOnly, hideEnded: !!f.hideEnded };
		} catch (e) { /* private mode: defaults */ }
	},

	saveFilters: function() {
		try { window.localStorage.setItem(structureTimers.FILTER_KEY, JSON.stringify(structureTimers.filters)); } catch (e) { /* not remembered */ }
	},

	markerForSystem: function(systemID) {
		return structureTimers.markerFor(structureTimers.data[systemID], structureTimers.nowSec());
	},

	/** Replace the markers of the drawn chain map; adding / removing one (it pads the last line) redraws the chain */
	patchChain: function() {
		const on = structureTimers.active();
		let redraw = false;
		$("#chainMap .node[data-nodeid]").each(function() {
			const $node = $(this);
			if ($node.closest(".destination-node").length) { return; }
			const $old = $node.children(".str-marker");
			const html = on ? structureTimers.markerHtml(structureTimers.markerForSystem(parseInt($node.attr("data-nodeid"), 10))) : "";
			if (!html !== !$old.length) {
				redraw = true;	// added / removed: the renderers lay out the measured markup
			} else if (html && $old.prop("outerHTML") !== $(html).prop("outerHTML")) {	// both through the browser's serialisation
				$old.replaceWith(html);	// another glyph, colour or tooltip: swapped in place
			}
		});
		if (redraw && typeof chain !== "undefined" && chain.data && chain.data.rawMap) {
			clearTimeout(structureTimers.redrawTimer);
			structureTimers.redrawTimer = setTimeout(function() { chain.redraw(); }, 0);
		}
	},

	absorb: function(response) {
		if (!response) { return; }
		if (typeof response.serverTime === "number") { structureTimers.offset = response.serverTime - Math.floor(Date.now() / 1000); }
		if (response.unchanged) { return; }
		structureTimers.data = response.systems || {};
		structureTimers.next = response.next || [];
		structureTimers.hash = response.hash || "";
	},

	/** Whether anything uses the markers poll's answer (the node icons) */
	consumers: function() { return structures.enabled(structureTimers.opts()) && (structureTimers.mapMarkerEnabled(structureTimers.opts()) || structureTimers.alertsEnabled(structureTimers.opts())); },

	fetchMarkers: function() {
		// Only while something uses the answer (the node icons, the alerts)
		if (!structureTimers.consumers()) { return; }
		if (document.hidden) { structureTimers.missed = true; return; }
		if (structureTimers.xhr) { structureTimers.xhr.abort(); }
		const xhr = $.ajax({ url: structureTimers.URL, type: "GET", dataType: "JSON", cache: false, timeout: 15000,
			data: { action: "markers", systemIDs: structureTimers.chainIDs.join(","), have: structureTimers.hash } });
		structureTimers.xhr = xhr;
		xhr.done(function(response) {
			structureTimers.absorb(response);
			if (!response.unchanged || structureTimers.dirty) { structureTimers.patchChain(); }
			structureTimers.dirty = false;
			if (typeof structureTimers.onNext === "function") { structureTimers.onNext(structureTimers.next, structureTimers.nowSec()); }
		}).always(function() { if (structureTimers.xhr === xhr) { structureTimers.xhr = null; } });
	},

	/** The Timers view's data (every active timer of the mask); polled with the panel while the view is open */
	fetchBoard: function() {
		if (!structures.enabled(structureTimers.opts())) { return; }
		if (structureTimers.boardXhr) { structureTimers.boardXhr.abort(); }
		const xhr = $.ajax({ url: structureTimers.URL, type: "GET", dataType: "JSON", cache: false, timeout: 15000, data: { action: "timers", have: structureTimers.boardHash } });
		structureTimers.boardXhr = xhr;
		xhr.done(function(response) {
			if (response && typeof response.serverTime === "number") { structures.offset = response.serverTime - Math.floor(Date.now() / 1000); }
			if (!response || !response.unchanged) {
				structureTimers.boardData = response && response.timers ? response.timers : [];
				structureTimers.boardCapped = !!(response && response.capped);
				structureTimers.boardHash = response && response.hash ? response.hash : "";
			}
			structureTimers.boardError = "";
		}).fail(function(x, status) {
			if (status === "abort") { return; }
			structureTimers.boardError = "Could not load timers" + (x && x.status ? " (HTTP " + x.status + ")" : "");
			if (structureTimers.boardData === null) { structureTimers.boardData = []; }
		}).always(function() {
			if (structureTimers.boardXhr === xhr) { structureTimers.boardXhr = null; }
			if (structures.view === "timers") { structures.renderPanel(); }
		});
	},

	alerted: {},	// key => true: alerts already given in this browser (kept in localStorage too)

	loadAlerted: function() {
		try {
			(JSON.parse(window.localStorage.getItem(structureTimers.ALERT_KEY) || "[]") || []).forEach(function(k) { structureTimers.alerted[k] = true; });
		} catch (e) { /* private mode: memory only */ }
	},

	saveAlerted: function() {
		try { window.localStorage.setItem(structureTimers.ALERT_KEY, JSON.stringify(Object.keys(structureTimers.alerted).slice(-200))); } catch (e) { /* not remembered */ }
	},

	/** Toast + sound for the timers that reached 15 minutes / the end; called every 10 s with the markers poll's next timers */
	checkAlerts: function() {
		const opts = structureTimers.opts();
		if (!structures.enabled(opts) || !structureTimers.alertsEnabled(opts)) { return; }
		const due = structureTimers.dueAlerts(structureTimers.next, structureTimers.nowSec(), structureTimers.alerted);
		if (!due.length) { return; }
		let $box = $("#kill-reporting-toasts");
		if (!$box.length) {
			$box = $("<div id='kill-reporting-toasts' aria-live='polite'></div>").appendTo("body");
			$box.on("click", ".kill-toast-close", function(e) { e.stopPropagation(); $(this).closest(".kill-toast").remove(); });
		}
		let sound = null;
		due.forEach(function(a) {
			structureTimers.alerted[a.key] = true;
			const $toast = $(structureTimers.alertHtml(a, structures.systemName(a.row.systemID)));
			$toast.on("click", function() { structureTimers.showPanel("timers"); $toast.remove(); });
			$box.append($toast);
			setTimeout(function() { $toast.fadeOut(400, function() { $toast.remove(); }); }, 20000);
			if (sound === null || a.lead === 0) { sound = a.lead; }
		});
		structureTimers.saveAlerted();
		// The kill-reporting sound helper (it honours the Mute button); a toast alone without it
		if (typeof killReporting !== "undefined" && typeof killReporting.play === "function") {
			killReporting.play(structureTimers.ALERT_SOUNDS[sound], 80, "neutral");
		}
	},

	/** Every second while the board is open: move the countdowns on without rebuilding the rows */
	tick: function() {
		if (document.hidden) { return; }
		const now = structures.nowSec();
		$("#" + structures.WIDGET_ID + " .str-tcd").each(function() {
			const c = structureTimers.countdown({ timerKind: "other", timerAt: parseInt($(this).attr("data-at"), 10) }, now);
			const cls = "str-timer str-tcd " + c.cls;
			if (this.className !== cls) { this.className = cls; }
			const t = this.querySelector(".str-tcd-t");
			if (t && t.textContent !== c.text) { t.textContent = c.text; }
		});
	},

	/** The chain was built with these systems: fetch when they changed */
	chainChanged: function(ids) {
		const changed = ids.join(",") !== structureTimers.chainIDs.join(",");
		structureTimers.chainIDs = ids;
		if (changed) {
			structureTimers.hash = "";
			clearTimeout(structureTimers.chainDebounce);
			structureTimers.chainDebounce = setTimeout(structureTimers.fetchMarkers, 300);
		}
	},

	install: function(chainObj) {
		if (!chainObj || typeof chainObj.nodes !== "function" || chainObj.nodes.structureTimersWrapped) { return; }
		const previous = chainObj.nodes;
		const wrapped = function() {
			const result = previous.apply(this, arguments);
			try {
				if (structures.enabled(structureTimers.opts())) {
					const systems = typeof tripwire !== "undefined" ? tripwire.systems : null;
					const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
					if (structureTimers.mapMarkerEnabled(structureTimers.opts())) {
						rows.forEach(function(row) {
							const node = row && row.c && row.c[0];
							if (!node || typeof node.f !== "string" || String(node.v).indexOf("dest-") === 0 || !(parseInt(node.systemID, 10) >= 30000000)) { return; }
							node.f = structureTimers.insertMarker(node.f, structureTimers.markerHtml(structureTimers.markerForSystem(node.systemID)));
						});
					}
					structureTimers.chainChanged(structureTimers.chainSystems(result, systems));
				}
			} catch (e) {
				if (typeof console !== "undefined") { console.warn("structure-timers: could not decorate the chain", e); }
			}
			return result;
		};
		wrapped.structureTimersWrapped = true;
		chainObj.nodes = wrapped;
	},

	// ---- System info line ----

	renderInfo: function() {
		let $line = $("#structuresInfoLine");
		const text = structures.enabled(structureTimers.opts()) && structures.loaded ? structureTimers.infoLine(structures.rows, structures.nowSec()) : "";
		if (!text) { $line.remove(); return; }
		if (!$line.length) {
			const $anchor = $("#infoFaction");	// the last line of the system's name block, a stable anchor
			if (!$anchor.length) { return; }
			$line = $("<div id='structuresInfoLine' class='str-infoline' title='Open the Structures panel'></div>");
			$anchor.after($line);
		}
		$line.text(text);
	},

	showPanel: function(view, systemID) {
		if (!structures.enabled(structureTimers.opts())) { return; }
		if (view === "timers") { structures.setView("timers"); } else { structures.setView("system"); }
		if (systemID && typeof tripwire !== "undefined" && parseInt(systemID, 10) !== parseInt(viewingSystemID, 10)) { tripwire.systemChange(parseInt(systemID, 10)); }
		const $w = structures.$widget();
		if ($w.length) {
			$w[0].scrollIntoView({ block: "nearest" });
			$w.addClass("str-flash");
			setTimeout(function() { $w.removeClass("str-flash"); }, 1200);
		}
	},

	// ---- Context menu ----

	setupMenu: function() {
		try {
			const chainParent = $("#chainParent");
			if (!$("#chainMenu").length || !chainParent.length) { return; }
			$("#chainMenu").append("<li data-command='" + structureTimers.MENU_VIEW + "'><a>Structures…</a></li>"
				+ "<li data-command='" + structureTimers.MENU_TIMERS + "'><a>Structure timers…</a></li>");
			$("#chainMenu").menu("refresh");
			const originalSelect = chainParent.contextmenu("option", "select");
			chainParent.contextmenu("option", "select", function(e, ui) {
				if (ui.cmd === structureTimers.MENU_VIEW || ui.cmd === structureTimers.MENU_TIMERS) {
					structureTimers.showPanel(ui.cmd === structureTimers.MENU_TIMERS ? "timers" : "system", $(ui.target[0]).closest("[data-nodeid]").data("nodeid"));
					return;
				}
				return originalSelect ? originalSelect.apply(this, arguments) : undefined;
			});
			const originalBeforeOpen = chainParent.contextmenu("option", "beforeOpen");
			chainParent.contextmenu("option", "beforeOpen", function(e, ui) {
				try {
					const id = parseInt($(ui.target[0]).closest("[data-nodeid]").data("nodeid"), 10);
					const on = structures.enabled(structureTimers.opts()) && structures.isSystem(id) && !$(ui.target[0]).closest(".destination-node").length;
					$(this).contextmenu("showEntry", structureTimers.MENU_VIEW, on);
					$(this).contextmenu("showEntry", structureTimers.MENU_TIMERS, on);
				} catch (err) { console.error("structure-timers: menu update failed", err); }
				return originalBeforeOpen ? originalBeforeOpen.apply(this, arguments) : undefined;
			});
		} catch (e) { console.error("structure-timers: context menu setup failed", e); }
	},

	// ---- Settings and init ----

	setupSettings: function() {
		// Settings > Map Markers; takes effect on Save (options.apply redraws the chain), Reset removes the key (on)
		forkSettings.register({
			section: "markers", order: 45, id: "structures-mapMarker", type: "checkbox", key: "structures",
			label: "Structure & timer icons:", text: "Show structures and timers on nodes",
			get: function(o) { return structureTimers.mapMarkerEnabled(o); },
			set: function(o, on) { o.structures = Object.assign({}, o.structures, { mapMarker: on }); },
			reset: function(o) { if (o.structures) { delete o.structures.mapMarker; } }
		});
		// Settings > Kills & Intel; Reset removes the key (on)
		forkSettings.register({
			section: "intel", order: 46, id: "structures-alerts", type: "checkbox", key: "structures",
			label: "Timer alerts:", text: "Pop-up and sound when a structure timer is 15 minutes away and when it ends",
			get: function(o) { return structureTimers.alertsEnabled(o); },
			set: function(o, on) { o.structures = Object.assign({}, o.structures, { alerts: on }); },
			reset: function(o) { if (o.structures) { delete o.structures.alerts; } }
		});
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.structureTimersWrapped) {
			const apply = options.apply;
			const wrappedApply = function() {
				const result = apply.apply(this, arguments);
				structureTimers.dirty = true;
				structureTimers.hash = "";
				structureTimers.fetchMarkers();
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrappedApply[k] = apply[k]; });
			wrappedApply.structureTimersWrapped = true;
			options.apply = wrappedApply;
		}
	},

	init: function() {
		structureTimers.loadFilters();
		$(document).on("click", "#structuresInfoLine", function() { structureTimers.showPanel("system"); });
		structureTimers.loadAlerted();
		structureTimers.setupSettings();
		structureTimers.setupMenu();
		if (typeof chain !== "undefined") { structureTimers.install(chain); }
		document.addEventListener("visibilitychange", function() {
			if (!document.hidden && structureTimers.missed) { structureTimers.missed = false; structureTimers.fetchMarkers(); }
		});
		setInterval(structureTimers.fetchMarkers, structureTimers.POLL_MS);
		setInterval(structureTimers.checkAlerts, 10000);
		setTimeout(structureTimers.fetchMarkers, 1500);	// alerts need the next timers even before the chain is drawn
		setInterval(structureTimers.patchChain, 30000);	// glyphs appear 48 h ahead and turn red under 1 h
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	if (typeof chain !== "undefined") { structureTimers.install(chain); }
	$(function() { structureTimers.init(); });
}
