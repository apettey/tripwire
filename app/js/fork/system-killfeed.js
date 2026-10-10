const systemKillFeed = {
	// System Kill Feed (fork-owned): a layout panel listing the most recent kills in the viewed system.
	// Reads public/system_kills.php, which serves kills stored by the pooled zKillboard integration (zkill/);
	// the browser itself only loads images from images.evetech.net and links to zkillboard.com.
	// Setting: options.systemKillFeed.enabled (missing = on). Keep `const systemKillFeed` on the first line:
	// the test helper strips it to define a global.
	URL: "system_kills.php",
	WIDGET_ID: "systemKillFeedWidget",
	LIMIT: 20,
	REFRESH_MS: 90000,	// while the system is viewed
	PENDING_MS: 4000,	// while a back-fill or names are pending
	MAX_PENDING_POLLS: 30,
	TICK_MS: 30000,	// re-render "time ago"
	SIZE: { x: 7, y: 6, minX: 4, minY: 3 },
	COL_PX: 60,	// gridster widget_base_dimensions 50 + 2 * margin 5

	/** Whether the panel is switched on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.systemKillFeed && opts.systemKillFeed.enabled === false);
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** data-tooltip attribute value for plain text lines (the tooltip renders HTML, so escape twice) */
	tooltip: function(lines) {
		const html = (Array.isArray(lines) ? lines : [lines]).filter(function(l) { return l !== null && l !== undefined && l !== ""; })
			.map(systemKillFeed.escape).join("<br/>");
		return systemKillFeed.escape(html);
	},

	/** "12.3M", "1.20B", "450K", "" for nothing */
	formatISK: function(value) {
		const v = Number(value);
		if (!isFinite(v) || v <= 0) { return ""; }
		if (v >= 1e12) { return (v / 1e12).toFixed(2) + "T"; }
		if (v >= 1e9) { return (v / 1e9).toFixed(2) + "B"; }
		if (v >= 1e6) { return (v / 1e6).toFixed(1) + "M"; }
		if (v >= 1e3) { return Math.round(v / 1e3) + "K"; }
		return String(Math.round(v));
	},

	/** Short age: "now", "45s", "12m", "3h", "2d" */
	timeAgo: function(timeMs, nowMs) {
		if (!isFinite(timeMs) || !isFinite(nowMs)) { return ""; }
		const s = Math.max(0, Math.floor((nowMs - timeMs) / 1000));
		if (s < 10) { return "now"; }
		if (s < 60) { return s + "s"; }
		if (s < 3600) { return Math.floor(s / 60) + "m"; }
		if (s < 86400) { return Math.floor(s / 3600) + "h"; }
		return Math.floor(s / 86400) + "d";
	},

	/** "2026-10-10 09:41:57" (EVE time = UTC) */
	eveTime: function(timeMs) {
		if (!isFinite(timeMs)) { return ""; }
		return new Date(timeMs).toISOString().replace("T", " ").substring(0, 19);
	},

	/** "48 hours", "1 hour", "7 days", "30 minutes" */
	formatWindow: function(seconds) {
		const s = Number(seconds) || 0;
		const plural = function(n, unit) { return n + " " + unit + (n === 1 ? "" : "s"); };
		if (s > 86400 * 2 && s % 86400 === 0) { return plural(s / 86400, "day"); }
		if (s >= 3600 && s % 3600 === 0) { return plural(s / 3600, "hour"); }
		return plural(Math.max(1, Math.round(s / 60)), "minute");
	},

	imageURL: function(kind, id, size) {
		const n = parseInt(id, 10);
		if (!n || n <= 0) { return ""; }
		return kind === "type"
			? "https://images.evetech.net/types/" + n + "/icon?size=" + size
			: "https://images.evetech.net/" + kind + "/" + n + "/logo?size=" + size;
	},

	/** Row models from a system_kills.php response, newest first */
	buildRows: function(response) {
		const kills = response && Array.isArray(response.kills) ? response.kills : [];
		const names = response && response.names && typeof response.names === "object" ? response.names : {};
		const name = function(id) {
			return id !== null && id !== undefined && Object.prototype.hasOwnProperty.call(names, String(id)) ? String(names[String(id)]) : null;
		};
		const namesPending = !!(response && response.namesPending);
		return kills.filter(function(k) { return k && k.killID; }).map(function(k) {
			const victim = k.victim || {};
			const finalBlow = k.finalBlow || {};
			const shipName = name(victim.shipTypeID);
			const pilotName = victim.characterID ? name(victim.characterID) : null;
			const time = Date.parse(k.killTime);
			const pilots = parseInt(k.attackerCount, 10) || 0;
			return {
				killID: parseInt(k.killID, 10),
				url: "https://zkillboard.com/kill/" + parseInt(k.killID, 10) + "/",
				time: time,
				// Structures and other losses without a pilot are named by their type
				victimName: victim.characterID ? (pilotName || (namesPending ? "…" : "Unknown pilot"))
					: (shipName || (namesPending ? "…" : "Unknown")),
				victimIsPilot: !!victim.characterID,
				shipTypeID: victim.shipTypeID || null,
				shipName: shipName || "",
				victimCorporationID: victim.corporationID || null,
				victimCorporationName: name(victim.corporationID) || "",
				victimAllianceName: name(victim.allianceID) || "",
				finalBlowCorporationID: finalBlow.corporationID || null,
				finalBlowCorporationName: name(finalBlow.corporationID) || "",
				finalBlowAllianceName: name(finalBlow.allianceID) || "",
				finalBlowName: name(finalBlow.characterID) || "",
				finalBlowShipName: name(finalBlow.shipTypeID) || "",
				pilots: pilots,
				npc: !!k.npc || pilots === 0,
				solo: !!k.solo,
				value: systemKillFeed.formatISK(k.totalValue)
			};
		});
	},

	/**
	 * What the panel shows for a response: { state: 'list'|'loading'|'empty'|'disabled', rows, note }
	 * note: a status line under the list ("" for none)
	 */
	viewModel: function(response) {
		const rows = systemKillFeed.buildRows(response);
		const feed = response && response.feed ? response.feed : {};
		const windowText = systemKillFeed.formatWindow(response && response.pastSeconds);
		let note = "";
		if (response && response.pending) { note = "Loading older kills from zKillboard…"; }
		else if (feed.enabled && feed.live === false) { note = "The zKillboard feed is behind; recent kills may be missing."; }
		if (feed.enabled === false && !rows.length) {
			return { state: "disabled", rows: rows, note: "The zKillboard feed is turned off on this server." };
		}
		if (!rows.length) {
			return response && response.pending
				? { state: "loading", rows: rows, note: "" }
				: { state: "empty", rows: rows, note: "No kills in the last " + windowText + "." };
		}
		return { state: "list", rows: rows, note: note };
	},

	rowHtml: function(row, nowMs) {
		const esc = systemKillFeed.escape;
		const tip = systemKillFeed.tooltip;
		const img = function(cls, url, tooltip) {
			return url ? "<img class='" + cls + "' src='" + esc(url) + "' alt='' loading='lazy' data-tooltip='" + tooltip + "' />"
				: "<span class='" + cls + " skf-noimg'></span>";
		};
		const victimCorp = [row.victimCorporationName || "Unknown corporation", row.victimAllianceName];
		const finalBlow = ["Final blow: " + (row.finalBlowName || (row.npc ? "NPC" : "unknown")),
			row.finalBlowCorporationName + (row.finalBlowAllianceName ? " [" + row.finalBlowAllianceName + "]" : ""),
			row.finalBlowShipName ? "in a " + row.finalBlowShipName : ""];
		const pilotsText = row.npc && row.pilots === 0 ? "NPC" : String(row.pilots);
		const pilotsTip = row.npc && row.pilots === 0 ? "Killed by NPCs" : (row.pilots === 1 ? "1 pilot involved" : row.pilots + " pilots involved") + (row.solo ? " (solo)" : "");
		return "<a class='skf-row" + (row.npc ? " skf-npc" : "") + "' href='" + esc(row.url) + "' target='_blank' rel='noopener noreferrer' data-killid='" + row.killID + "'>"
			+ img("skf-ship", systemKillFeed.imageURL("type", row.shipTypeID, 64), tip(row.shipName || "Unknown ship"))
			+ img("skf-corp", systemKillFeed.imageURL("corporations", row.victimCorporationID, 64), tip(victimCorp))
			+ "<span class='skf-main'>"
			+ "<span class='skf-name" + (row.victimIsPilot ? "" : " skf-structure") + "'>" + esc(row.victimName) + "</span>"
			+ "<span class='skf-sub'><span class='skf-shipname'>" + esc(row.victimIsPilot ? row.shipName : (row.victimCorporationName || row.shipName)) + "</span>"
			+ (row.value ? "<span class='skf-value'>" + esc(row.value) + "</span>" : "") + "</span>"
			+ "</span>"
			+ "<span class='skf-time' data-time='" + (isFinite(row.time) ? row.time : "") + "' data-tooltip='" + tip(systemKillFeed.eveTime(row.time) + " EVE") + "'>"
			+ esc(systemKillFeed.timeAgo(row.time, nowMs)) + "</span>"
			+ "<span class='skf-pilots' data-tooltip='" + tip(pilotsTip) + "'><i data-icon='user'></i>" + esc(pilotsText) + "</span>"
			+ "<span class='skf-fbname'>" + esc(row.finalBlowCorporationName) + "</span>"
			+ img("skf-fb", systemKillFeed.imageURL("corporations", row.finalBlowCorporationID, 64), tip(finalBlow))
			+ "</a>";
	},

	/** Inner HTML of the panel body for a view model (or an error / loading state without one) */
	bodyHtml: function(model, nowMs, error) {
		const esc = systemKillFeed.escape;
		if (!model) {
			return error ? "<div class='skf-state skf-error'>" + esc(error) + "</div>"
				: "<div class='skf-state skf-loading'>Loading kills…</div>";
		}
		let html;
		if (model.state === "list") {
			html = "<div class='skf-list'>" + model.rows.map(function(r) { return systemKillFeed.rowHtml(r, nowMs); }).join("") + "</div>";
		} else if (model.state === "loading") {
			html = "<div class='skf-state skf-loading'>Loading kills from zKillboard…</div>";
		} else {
			html = "<div class='skf-state'>" + esc(model.note) + "</div>";
		}
		const note = error ? error : (model.state === "list" ? model.note : "");
		return html + (note ? "<div class='skf-note" + (error ? " skf-error" : "") + "'>" + esc(note) + "</div>" : "");
	},

	/** CSS classes for the panel's content width: secondary information is dropped as it gets narrower */
	widthClasses: function(width) {
		const w = Number(width) || 0;
		const classes = [];
		if (w < 340) { classes.push("skf-lt340"); }
		if (w < 280) { classes.push("skf-lt280"); }
		if (w < 230) { classes.push("skf-lt230"); }
		if (w >= 520) { classes.push("skf-wide"); }
		return classes;
	},

	/** Saved layout entry for the panel in options.grid (array or object of {id, col, row, size_x, size_y}) */
	savedPosition: function(grid, id) {
		if (!grid || typeof grid !== "object") { return null; }
		const list = Array.isArray(grid) ? grid : Object.keys(grid).map(function(k) { return grid[k]; });
		const entry = list.filter(function(w) { return w && w.id === id; })[0];
		if (!entry) { return null; }
		const n = function(v) { const x = parseInt(v, 10); return x > 0 ? x : null; };
		const pos = { col: n(entry.col), row: n(entry.row), size_x: n(entry.size_x), size_y: n(entry.size_y) };
		return pos.col && pos.row && pos.size_x && pos.size_y ? pos : null;
	},

	/**
	 * Where a panel without a saved position goes: right of the top widgets when the window has room for it,
	 * otherwise under everything in the first column.
	 * @param widgets [{col, row, size_x, size_y}] the other widgets
	 */
	defaultPosition: function(widgets, viewportWidth) {
		const size = systemKillFeed.SIZE;
		let maxCol = 0, maxRow = 0;
		(widgets || []).forEach(function(w) {
			maxCol = Math.max(maxCol, (w.col || 1) + (w.size_x || 1) - 1);
			maxRow = Math.max(maxRow, (w.row || 1) + (w.size_y || 1) - 1);
		});
		if (maxCol && (maxCol + size.x) * systemKillFeed.COL_PX <= (viewportWidth || 0) - 40) {
			return { col: maxCol + 1, row: 1, size_x: size.x, size_y: size.y };
		}
		return { col: 1, row: maxRow + 1, size_x: size.x, size_y: size.y };
	},

	// ---- Browser-only code below (not run under mocha) ----

	systemID: null,
	response: null,
	error: "",
	xhr: null,
	timer: null,
	tickTimer: null,
	pendingPolls: 0,
	lastLoad: 0,
	missed: false,
	observer: null,	// a refresh was skipped while the tab was hidden

	isOn: function() {
		return systemKillFeed.enabled(typeof options !== "undefined" ? options : undefined);
	},

	$widget: function() {
		return $("#" + systemKillFeed.WIDGET_ID);
	},

	widgetHtml: function() {
		return "<li id='" + systemKillFeed.WIDGET_ID + "' class='gridWidget'>"
			+ "<div class='controls'>"
			+ "<span class='skf-title'>Kills in</span> <span class='skf-system'></span>"
			+ "<div style='float: right;'>"
			+ "<span class='skf-status'></span>"
			+ "<a class='skf-zkill' href='#' target='_blank' rel='noopener noreferrer' data-tooltip='Open the system on zKillboard'>zKillboard</a>"
			+ "</div>"
			+ "</div>"
			+ "<div class='content'><div class='skf-body'></div></div>"
			+ "</li>";
	},

	gridster: function() {
		return typeof grid !== "undefined" && grid && typeof grid.add_widget === "function" ? grid : null;
	},

	addWidget: function() {
		const g = systemKillFeed.gridster();
		if (!g || systemKillFeed.$widget().length) { return; }
		const others = $(".gridster li.gridWidget").map(function() {
			return { col: parseInt($(this).attr("data-col"), 10), row: parseInt($(this).attr("data-row"), 10),
				size_x: parseInt($(this).attr("data-sizex"), 10), size_y: parseInt($(this).attr("data-sizey"), 10) };
		}).get();
		const saved = systemKillFeed.savedPosition(typeof options !== "undefined" ? options.grid : null, systemKillFeed.WIDGET_ID);
		const pos = saved || systemKillFeed.defaultPosition(others, $(window).width());
		const size = systemKillFeed.SIZE;
		const $w = g.add_widget(systemKillFeed.widgetHtml(), pos.size_x, pos.size_y, pos.col, pos.row, null, [size.minX, size.minY]);
		// Same as layout.js does for the built-in widgets: resize handle only while customising the layout
		$w.find(".grid-resize").attr("data-icon", "resize").toggleClass("hidden", !$("#layout").hasClass("active"));
		$w.addClass("gridster-transition");
		$w.find(".content")[0].addEventListener("error", function(e) {
			if (e.target && e.target.tagName === "IMG") { $(e.target).replaceWith("<span class='" + e.target.className + " skf-noimg'></span>"); }
		}, true);
		Tooltips.attach($w.find(".controls [data-tooltip]"));
		const content = $w.find(".content")[0];
		const fit = function() {
			$w.removeClass("skf-lt340 skf-lt280 skf-lt230 skf-wide").addClass(systemKillFeed.widthClasses(content.clientWidth).join(" "));
		};
		fit();
		if (typeof ResizeObserver !== "undefined") {
			systemKillFeed.observer = new ResizeObserver(fit);
			systemKillFeed.observer.observe(content);
		}
		systemKillFeed.load(typeof viewingSystemID !== "undefined" ? viewingSystemID : null);
		systemKillFeed.tickTimer = setInterval(systemKillFeed.tick, systemKillFeed.TICK_MS);
	},

	removeWidget: function() {
		systemKillFeed.stop();
		clearInterval(systemKillFeed.tickTimer);
		systemKillFeed.tickTimer = null;
		if (systemKillFeed.observer) { systemKillFeed.observer.disconnect(); systemKillFeed.observer = null; }
		const g = systemKillFeed.gridster();
		const $w = systemKillFeed.$widget();
		if (!$w.length) { return; }
		if (g) { g.remove_widget($w, true); } else { $w.remove(); }
	},

	/** Add or remove the panel to match the setting */
	sync: function() {
		if (systemKillFeed.isOn()) { systemKillFeed.addWidget(); } else { systemKillFeed.removeWidget(); }
	},

	stop: function() {
		clearTimeout(systemKillFeed.timer);
		systemKillFeed.timer = null;
		if (systemKillFeed.xhr) { systemKillFeed.xhr.abort(); systemKillFeed.xhr = null; }
	},

	schedule: function(ms) {
		clearTimeout(systemKillFeed.timer);
		systemKillFeed.timer = setTimeout(function() { systemKillFeed.fetch(false); }, ms);
	},

	/** Show a (new) system */
	load: function(systemID) {
		const id = parseInt(systemID, 10);
		if (!systemKillFeed.$widget().length || !id) { return; }
		const changed = id !== systemKillFeed.systemID;
		systemKillFeed.systemID = id;
		const system = typeof tripwire !== "undefined" && tripwire.systems ? tripwire.systems[id] : null;
		const $w = systemKillFeed.$widget();
		$w.find(".skf-system").text(system && system.name ? system.name : "");
		$w.find(".skf-zkill").attr("href", "https://zkillboard.com/system/" + id + "/");
		if (changed) {
			systemKillFeed.response = null;
			systemKillFeed.error = "";
			systemKillFeed.render();
		}
		systemKillFeed.pendingPolls = 0;
		systemKillFeed.fetch(true);
	},

	fetch: function(force) {
		const id = systemKillFeed.systemID;
		if (!id || !systemKillFeed.$widget().length || !systemKillFeed.isOn()) { return; }
		if (!force && document.hidden) { systemKillFeed.missed = true; return; }	// resumes on visibilitychange
		systemKillFeed.missed = false;
		if (systemKillFeed.xhr) { systemKillFeed.xhr.abort(); }
		systemKillFeed.$widget().find(".skf-status").text("updating…");
		const xhr = $.ajax({ url: systemKillFeed.URL, type: "GET", data: { systemID: id, limit: systemKillFeed.LIMIT },
			dataType: "JSON", cache: false, timeout: 15000 });
		systemKillFeed.xhr = xhr;
		xhr.done(function(response) {
			if (id !== systemKillFeed.systemID) { return; }
			systemKillFeed.response = response;
			systemKillFeed.error = "";
			systemKillFeed.lastLoad = Date.now();
			const waiting = response && (response.pending || response.namesPending);
			systemKillFeed.pendingPolls = waiting ? systemKillFeed.pendingPolls + 1 : 0;
			systemKillFeed.schedule(waiting && systemKillFeed.pendingPolls <= systemKillFeed.MAX_PENDING_POLLS
				? systemKillFeed.PENDING_MS : systemKillFeed.REFRESH_MS);
		}).fail(function(x, status) {
			if (status === "abort" || id !== systemKillFeed.systemID) { return; }
			systemKillFeed.error = "Could not load kills" + (x && x.status ? " (HTTP " + x.status + ")" : "") + ", retrying…";
			systemKillFeed.schedule(systemKillFeed.REFRESH_MS / 3);
		}).always(function() {
			if (systemKillFeed.xhr === xhr) { systemKillFeed.xhr = null; }
			if (id === systemKillFeed.systemID) { systemKillFeed.render(); }
		});
	},

	render: function() {
		const $w = systemKillFeed.$widget();
		if (!$w.length) { return; }
		const response = systemKillFeed.response;
		const model = response ? systemKillFeed.viewModel(response) : null;
		if (typeof Tooltips !== "undefined" && Tooltips.close) { Tooltips.close(); }
		const $body = $w.find(".skf-body");
		const scroll = $w.find(".content").scrollTop();
		$body.html(systemKillFeed.bodyHtml(model, Date.now(), systemKillFeed.error));
		$w.find(".content").scrollTop(scroll);
		if (typeof Tooltips !== "undefined") { Tooltips.attach($body.find("[data-tooltip]")); }
		let status = "";
		if (model && model.state === "list") { status = model.rows.length + (model.rows.length === 1 ? " kill" : " kills"); }
		$w.find(".skf-status").text(status);
	},

	/** Refresh the "time ago" labels */
	tick: function() {
		const now = Date.now();
		systemKillFeed.$widget().find(".skf-time[data-time]").each(function() {
			const t = Number($(this).attr("data-time"));
			if (t) { $(this).text(systemKillFeed.timeAgo(t, now)); }
		});
	},

	// ---- Settings ----

	setupSettings: function() {
		// Settings > General Preferences row; takes effect on Save like its neighbours
		const $table = $("#dialog-options #optionsAccordion > div").eq(2).find("table.optionsTable").first();
		if ($table.length && !$("#systemKillFeed-enabled").length) {
			$table.append("<tr><th>System kill feed:</th><td><label><input type='checkbox' id='systemKillFeed-enabled' /> Show the Kills panel for the viewed system</label></td></tr>");
		}
		$(document).on("dialogopen", "#dialog-options", function() {
			$("#systemKillFeed-enabled").prop("checked", systemKillFeed.isOn());
		});
		// Capture phase so the value is in place before upstream's Save handler runs options.apply() and saves
		document.addEventListener("click", function(e) {
			const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
			if (!button || $.trim($(button).text()) !== "Save") { return; }
			if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#systemKillFeed-enabled").length) { return; }
			options.systemKillFeed = { enabled: $("#systemKillFeed-enabled").prop("checked") };
		}, true);

		// Settings > Reset: a missing key means on. Wraps whatever reset is in place (registered after What's New's
		// wrapper, which would otherwise keep this key).
		if (typeof options !== "undefined" && typeof options.reset === "function" && !options.reset.systemKillFeedWrapped) {
			const reset = options.reset;
			const wrapped = function() {
				const result = reset.apply(this, arguments);
				delete this.systemKillFeed;
				return result;
			};
			Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
			wrapped.systemKillFeedWrapped = true;
			options.reset = wrapped;
		}
		// options.apply() runs on Save and Reset: add or remove the panel to match
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.systemKillFeedWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				systemKillFeed.sync();
				return result;
			};
			options.apply.systemKillFeedWrapped = true;
		}
	},

	init: function() {
		systemKillFeed.setupSettings();
		// Follow the viewed system
		if (typeof tripwire !== "undefined" && typeof tripwire.systemChange === "function" && !tripwire.systemChange.systemKillFeedWrapped) {
			const systemChange = tripwire.systemChange;
			tripwire.systemChange = function(systemID) {
				const result = systemChange.apply(this, arguments);
				systemKillFeed.load(systemID);
				return result;
			};
			tripwire.systemChange.systemKillFeedWrapped = true;
		}
		document.addEventListener("visibilitychange", function() {
			if (!document.hidden && systemKillFeed.missed) {
				systemKillFeed.fetch(false);
			}
		});
		systemKillFeed.sync();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { systemKillFeed.init(); });
}
