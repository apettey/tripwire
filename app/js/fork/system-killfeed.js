const systemKillFeed = {
	// System Kill Feed (fork-owned): a layout panel listing the most recent kills in the viewed system.
	// Reads public/system_kills.php, which serves kills stored by the pooled zKillboard integration (zkill/);
	// the browser itself only loads images from images.evetech.net and links to zkillboard.com.
	// Settings: options.systemKillFeed.enabled (missing = on), .mode (app/js/fork/killfeed-modes.js). Keep `const systemKillFeed` on the first line:
	// the test helper strips it to define a global.
	URL: "system_kills.php",
	WIDGET_ID: "systemKillFeedWidget",
	LIMIT: 20,
	WINDOW_SECONDS: 86400,	// asked of the server (it clamps to its retention)
	QUEUE_DELAY_MS: 1000,	// a system must be viewed this long before the server is asked to back-fill it
	REFRESH_MS: 90000,	// while the system is viewed
	PENDING_MS: 4000,	// while a back-fill or names are pending
	MAX_PENDING_POLLS: 30,
	TICK_MS: 30000,	// re-render "time ago"
	SIZE: { x: 7, y: 6, minX: 4, minY: 3 },

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

	/** Short duration: "45 s", "12 min", "3 h 5 min" */
	formatDuration: function(seconds) {
		const s = Math.max(0, Math.round(Number(seconds) || 0));
		if (s < 60) { return s + " s"; }
		if (s < 3600) { return Math.floor(s / 60) + " min"; }
		const m = Math.floor((s % 3600) / 60);
		return Math.floor(s / 3600) + " h" + (m ? " " + m + " min" : "");
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
	 * note: a status line under the list ("" for none).
	 * @param provisional the response was read-only (no back-fill requested yet): an empty answer means "not known yet"
	 */
	viewModel: function(response, provisional) {
		const rows = systemKillFeed.buildRows(response);
		const feed = response && response.feed ? response.feed : {};
		const windowText = systemKillFeed.formatWindow(response && response.pastSeconds);
		const incomplete = !(response && response.complete);
		let note = "";
		if (response && response.pending) { note = "Loading older kills from zKillboard…"; }
		else if (feed.enabled && feed.caughtUp === false && feed.lagSeconds !== null && feed.lagSeconds !== undefined) {
			note = "The zKillboard feed is behind by " + systemKillFeed.formatDuration(feed.lagSeconds) + "; recent kills may be missing.";
		} else if (response && response.queueFull && incomplete) { note = "The server is busy; older kills may be missing."; }
		if (feed.enabled === false && !rows.length) {
			return { state: "disabled", rows: rows, note: "The zKillboard feed is turned off on this server." };
		}
		if (!rows.length) {
			if ((response && response.pending) || (provisional && incomplete)) { return { state: "loading", rows: rows, note: "" }; }
			return { state: "empty", rows: rows, note: "No kills in the last " + windowText + "." + (note ? " " + note : "") };
		}
		return { state: "list", rows: rows, note: note };
	},

	/**
	 * One kill row. Also used by the Chain Kill Feed (app/js/fork/chain-killfeed.js).
	 * @param extra optional { className: added to the row, html: inserted before the time (already escaped) }
	 */
	rowHtml: function(row, nowMs, extra) {
		const esc = systemKillFeed.escape;
		const add = extra || {};
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
		return "<a class='skf-row" + (row.npc ? " skf-npc" : "") + (add.className ? " " + esc(add.className) : "") + "' href='" + esc(row.url) + "' target='_blank' rel='noopener noreferrer' data-killid='" + row.killID + "'>"
			+ img("skf-ship", systemKillFeed.imageURL("type", row.shipTypeID, 64), tip(row.shipName || "Unknown ship"))
			+ img("skf-corp", systemKillFeed.imageURL("corporations", row.victimCorporationID, 64), tip(victimCorp))
			+ "<span class='skf-main'>"
			+ "<span class='skf-name" + (row.victimIsPilot ? "" : " skf-structure") + "'>" + esc(row.victimName) + "</span>"
			+ "<span class='skf-sub'><span class='skf-shipname'>" + esc(row.victimIsPilot ? row.shipName : (row.victimCorporationName || row.shipName)) + "</span>"
			+ (row.value ? "<span class='skf-value'>" + esc(row.value) + "</span>" : "") + "</span>"
			+ "</span>"
			+ (add.html || "")
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

	/**
	 * Release tooltips of elements that are about to be replaced or removed: the shared jBox tooltip keeps every
	 * element it was attached to (attachedElements) until it is detached, so re-rendering without this leaks them.
	 * @param tooltips the jBox tooltip (Tooltips); @param $elements jQuery collection of [data-tooltip] elements
	 */
	detachTooltips: function(tooltips, $elements) {
		if (tooltips && typeof tooltips.detach === "function" && $elements && $elements.length) { tooltips.detach($elements); }
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
	missed: false,	// a refresh was skipped while the tab was hidden
	provisional: false,	// the current response was read-only (queue=0)
	queueTimer: null,
	observer: null,

	isOn: function() {
		return systemKillFeed.enabled(typeof options !== "undefined" ? options : undefined);
	},

	$widget: function() {
		return $("#" + systemKillFeed.WIDGET_ID);
	},

	// Display modes (fixed / minimized / floating): app/js/fork/killfeed-modes.js
	MODE_KEY: "systemKillFeed",
	FLOAT_INDEX: 0,

	innerHtml: function() {
		return "<div class='controls'>"
			+ "<span class='skf-title skm-heading'>Kills in</span> <span class='skf-system skm-heading'></span>"
			+ "<div style='float: right;'>"
			+ "<span class='skf-status'></span>"
			+ "<a class='skf-zkill' href='#' target='_blank' rel='noopener noreferrer' data-tooltip='Open the system on zKillboard'>zKillboard</a>"
			+ "<span class='skm-buttons'></span>"
			+ "</div>"
			+ "</div>"
			+ "<div class='content'><div class='skf-body'></div></div>";
	},

	/** Title of the floating window */
	title: function() {
		const system = systemKillFeed.systemID && typeof tripwire !== "undefined" && tripwire.systems ? tripwire.systems[systemKillFeed.systemID] : null;
		return system && system.name ? "Kills in " + system.name : "System kills";
	},

	addWidget: function() {
		if (systemKillFeed.$widget().length || !killfeedModes.attach(systemKillFeed)) { return; }
		systemKillFeed.load(typeof viewingSystemID !== "undefined" ? viewingSystemID : null);
		clearInterval(systemKillFeed.tickTimer);
		systemKillFeed.tickTimer = setInterval(systemKillFeed.tick, systemKillFeed.TICK_MS);
	},

	removeWidget: function() {
		systemKillFeed.stop();
		clearInterval(systemKillFeed.tickTimer);
		systemKillFeed.tickTimer = null;
		if (!systemKillFeed.$widget().length) { return; }
		killfeedModes.detach(systemKillFeed, false);
		systemKillFeed.systemID = null;
		systemKillFeed.response = null;
	},

	/** The panel moved between the layout and a floating window: its header again (the body is re-rendered) */
	afterSwap: function() {
		systemKillFeed.showHeader();
	},

	/** Header: system name, zKillboard link, floating window title */
	showHeader: function() {
		const id = systemKillFeed.systemID;
		const $w = systemKillFeed.$widget();
		if (!$w.length || !id) { return; }
		const system = typeof tripwire !== "undefined" && tripwire.systems ? tripwire.systems[id] : null;
		$w.find(".skf-system").text(system && system.name ? system.name : "");
		$w.find(".skf-zkill").attr("href", "https://zkillboard.com/system/" + id + "/");
		killfeedModes.updateTitle(systemKillFeed);
	},

	/** Add or remove the panel to match the setting */
	sync: function() {
		killfeedModes.sync(systemKillFeed);
	},

	stop: function() {
		clearTimeout(systemKillFeed.timer);
		systemKillFeed.timer = null;
		clearTimeout(systemKillFeed.queueTimer);
		systemKillFeed.queueTimer = null;
		if (systemKillFeed.xhr) { systemKillFeed.xhr.abort(); systemKillFeed.xhr = null; }
	},

	schedule: function(ms) {
		clearTimeout(systemKillFeed.timer);
		systemKillFeed.timer = setTimeout(function() { systemKillFeed.fetch(false, true); }, ms);
	},

	/** Show a (new) system */
	load: function(systemID) {
		const id = parseInt(systemID, 10);
		if (!systemKillFeed.$widget().length || !id) { return; }
		const changed = id !== systemKillFeed.systemID;
		systemKillFeed.systemID = id;
		systemKillFeed.showHeader();
		if (changed) {
			systemKillFeed.response = null;
			systemKillFeed.error = "";
			systemKillFeed.render();
		}
		systemKillFeed.pendingPolls = 0;
		// Show what the server has right away, but only ask it to back-fill once the system has been viewed a moment
		// (clicking through systems shouldn't queue each one)
		clearTimeout(systemKillFeed.queueTimer);
		systemKillFeed.fetch(true, false);
		systemKillFeed.queueTimer = setTimeout(function() {
			systemKillFeed.queueTimer = null;
			if (systemKillFeed.systemID === id) { systemKillFeed.fetch(true, true); }
		}, systemKillFeed.QUEUE_DELAY_MS);
	},

	fetch: function(force, queue) {
		const id = systemKillFeed.systemID;
		if (!id || !systemKillFeed.$widget().length || !systemKillFeed.isOn()) { return; }
		if (!force && document.hidden) { systemKillFeed.missed = true; return; }	// resumes on visibilitychange
		systemKillFeed.missed = false;
		if (systemKillFeed.xhr) { systemKillFeed.xhr.abort(); }
		systemKillFeed.$widget().find(".skf-status").text("updating…");
		const xhr = $.ajax({ url: systemKillFeed.URL, type: "GET",
			data: { systemID: id, limit: systemKillFeed.LIMIT, pastSeconds: systemKillFeed.WINDOW_SECONDS, queue: queue ? 1 : 0 },
			dataType: "JSON", cache: false, timeout: 15000 });
		systemKillFeed.xhr = xhr;
		xhr.done(function(response) {
			if (id !== systemKillFeed.systemID) { return; }
			systemKillFeed.response = response;
			systemKillFeed.provisional = !queue;
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
		const model = response ? systemKillFeed.viewModel(response, systemKillFeed.provisional) : null;
		if (typeof Tooltips !== "undefined" && Tooltips.close) { Tooltips.close(); }
		const $body = $w.find(".skf-body");
		const scroll = $w.find(".content").scrollTop();
		systemKillFeed.detachTooltips(typeof Tooltips !== "undefined" ? Tooltips : null, $body.find("[data-tooltip]"));
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
		// Settings > Kills & Intel row; takes effect on Save like its neighbours (Reset = on)
		forkSettings.register({
			section: "intel", order: 10, id: "systemKillFeed-enabled", type: "checkbox", key: "systemKillFeed",
			label: "System kill feed:", text: "Show the Kills panel for the viewed system",
			get: function() { return systemKillFeed.isOn(); },
			set: function(o, on) { o.systemKillFeed = killfeedModes.merge(o.systemKillFeed, { enabled: on }); }
		});
		killfeedModes.registerSetting(systemKillFeed, { order: 11, label: "System kills display:",
			hint: "Minimized: the newest kill only. Floating: a window you can move and resize." });
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
		panelHost.register({ id: systemKillFeed.WIDGET_ID, title: "System kills", key: "systemKillFeed", size: systemKillFeed.SIZE });
		systemKillFeed.setupSettings();
		if (typeof forkCommands !== "undefined") {	// command palette (Ctrl+K)
			forkCommands.panelToggle({ id: "panel.systemKills", title: "Toggle system kills panel", key: "systemKillFeed", icon: "alert", keywords: ["kills", "killboard", "feed"] });
			killfeedModes.registerCommands(systemKillFeed, { id: "panel.systemKills", name: "system kills panel", keywords: ["kills", "killboard", "feed"] });
		}
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
				systemKillFeed.fetch(false, true);
			}
		});
		systemKillFeed.sync();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { systemKillFeed.init(); });
}
