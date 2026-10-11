const systemStatus = {
	// System status colour, occupier and alias, shared by everyone on the mask (public/system_status.php, polled like
	// preserve mass). Per SYSTEM, not per hole: it survives deleting and re-adding the system. Right-click a chain map
	// system > Status / Alias / Occupier. The node gets a coloured outline plus a letter (colour-blind safe) and the alias.
	// Fork-owned; keep `const systemStatus` on the first line (the test helper strips it).
	URL: "system_status.php",
	RESIDENTS_URL: "system_residents.php",
	POLL_MS: 10000,
	ALIAS_MAX: 24,
	OCCUPIER_MAX: 60,
	CMD: "sysStatus-",
	CMD_ALIAS: "sysAlias",
	CMD_OCCUPIER: "sysOccupier",
	CMD_CLEAR: "sysClearAll",

	STATUSES: [
		{ key: "friendly", label: "Friendly", letter: "F" },
		{ key: "hostile", label: "Hostile", letter: "H" },
		{ key: "active", label: "Active", letter: "A" },
		{ key: "empty", label: "Empty", letter: "E" },
		{ key: "unscanned", label: "Unscanned", letter: "U" }
	],

	// Rows by system id: { systemID, status, alias, occupier, setBy, setAt (unix seconds or null) }
	rows: {},

	statusInfo: function(key) {
		return systemStatus.STATUSES.filter(function(s) { return s.key === key; })[0] || null;
	},

	/** A real solar system id (k-space 30xxxxxx, wormholes 31xxxxxx) */
	isSystemID: function(id) {
		return /^3[01][0-9]{6}$/.test(String(id));
	},

	/** One line of plain text as the server stores it: zero-width and direction marks dropped, whitespace and control
	characters become one space, trimmed, at most max characters */
	clean: function(text, max) {
		if (text === undefined || text === null) { return ""; }
		const s = String(text)
			.replace(/[­​-‏‪-‮⁠-⁤⁦-⁯﻿]/g, "")
			.replace(/[\s\u0000-\u001F\u007F-\u009F]+/g, " ")
			.trim();
		return Array.from(s).slice(0, max).join("");
	},

	/** Server list -> rows by system id; entries without a valid system id are dropped, unknown statuses become none */
	toMap: function(list) {
		const result = {};
		(Array.isArray(list) ? list : []).forEach(function(r) {
			if (!r || !systemStatus.isSystemID(r.systemID)) { return; }
			const row = {
				systemID: Number(r.systemID),
				status: systemStatus.statusInfo(r.status) ? r.status : null,
				alias: systemStatus.clean(r.alias, systemStatus.ALIAS_MAX),
				occupier: systemStatus.clean(r.occupier, systemStatus.OCCUPIER_MAX),
				setBy: r.setBy === undefined || r.setBy === null ? null : String(r.setBy),
				setAt: Number(r.setAt) > 0 ? Number(r.setAt) : null
			};
			if (row.status || row.alias || row.occupier) { result[String(row.systemID)] = row; }
		});
		return result;
	},

	/** Whether two maps differ (anything a viewer would see) */
	changed: function(a, b) {
		const key = function(m) {
			return Object.keys(m || {}).sort().map(function(id) {
				const r = m[id];
				return [id, r.status, r.alias, r.occupier, r.setBy, r.setAt].join("\u0001");
			}).join("\u0002");
		};
		return key(a) !== key(b);
	},

	enabled: function(opts) {
		return !(opts && opts.systemStatus && opts.systemStatus.enabled === false);
	},

	/** "just now", "5m ago", "3h ago", "2d ago" ("" when unknown) */
	ago: function(unixSeconds, nowMs) {
		const t = Number(unixSeconds);
		if (!(t > 0)) { return ""; }
		const s = Math.max(0, Math.floor(((nowMs === undefined ? Date.now() : nowMs) / 1000) - t));
		if (s < 60) { return "just now"; }
		if (s < 3600) { return Math.floor(s / 60) + "m ago"; }
		if (s < 86400) { return Math.floor(s / 3600) + "h ago"; }
		return Math.floor(s / 86400) + "d ago";
	},

	/** "set by Chribba 2d ago" (parts left out when unknown) */
	setByText: function(row, nowMs) {
		if (!row) { return ""; }
		const ago = systemStatus.ago(row.setAt, nowMs);
		const parts = [];
		if (row.setBy) { parts.push("set by " + row.setBy); }
		if (ago) { parts.push(ago); }
		return parts.join(" ");
	},

	/** The system info panel line: "Hostile · occupied by X · alias Staging (set by Y 2d ago)"; "" when nothing is set */
	infoLine: function(row, nowMs) {
		if (!row) { return ""; }
		const parts = [];
		const st = systemStatus.statusInfo(row.status);
		if (st) { parts.push(st.label); }
		if (row.occupier) { parts.push("occupied by " + row.occupier); }
		if (row.alias) { parts.push("alias " + row.alias); }
		if (!parts.length) { return ""; }
		const by = systemStatus.setByText(row, nowMs);
		return parts.join(" · ") + (by ? " (" + by + ")" : "");
	},

	/** Plain-text tooltip of a node's marker (escape before putting it in markup) */
	tooltipText: function(row, nowMs) {
		if (!row) { return ""; }
		const lines = [];
		const st = systemStatus.statusInfo(row.status);
		if (row.alias) { lines.push(row.alias); }
		lines.push("Status: " + (st ? st.label : "not set"));
		if (row.occupier) { lines.push("Occupier: " + row.occupier); }
		const by = systemStatus.setByText(row, nowMs);
		if (by) { lines.push(by.charAt(0).toUpperCase() + by.slice(1)); }
		return lines.join("\n");
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Class names a decorated node gets */
	nodeClasses: function(row) {
		const st = row ? systemStatus.statusInfo(row.status) : null;
		return "sysstatus" + (st ? " sysstatus-" + st.key : "") + (row && row.alias ? " sysstatus-has-alias" : "");
	},

	/** Markup added inside a node: the status letter and the alias line (each only when set) */
	nodeHtml: function(row, nowMs) {
		if (!row) { return ""; }
		const st = systemStatus.statusInfo(row.status);
		const title = systemStatus.escape(systemStatus.tooltipText(row, nowMs));
		return (st ? "<span class='sysstatus-letter' title='" + title + "'>" + st.letter + "</span>" : "") +
			(row.alias ? "<span class='sysstatus-alias' title='" + title + "'>" + systemStatus.escape(row.alias) + "</span>" : "") +
			(!st && !row.alias ? "<span class='sysstatus-letter sysstatus-occupier-only' title='" + title + "'>&#9679;</span>" : "");
	},

	/** Occupier suggestions from the mask's residents (system_residents.php answer): "[TICK] Name", corporations
	first, each once, at most 3 (max OCCUPIER_MAX characters) */
	suggestions: function(residents) {
		const entities = residents && Array.isArray(residents.entities) ? residents.entities : [];
		const seen = {};
		const out = [];
		entities.slice().sort(function(a, b) {
			return (a && a.kind === "corporation" ? 0 : 1) - (b && b.kind === "corporation" ? 0 : 1);
		}).forEach(function(e) {
			if (!e || !e.name) { return; }
			const text = systemStatus.clean((e.ticker ? "[" + e.ticker + "] " : "") + e.name, systemStatus.OCCUPIER_MAX);
			if (text && !seen[text]) { seen[text] = true; out.push(text); }
		});
		return out.slice(0, 3);
	},

	/** POST body */
	payload: function(mode, systemID, fields) {
		const body = { mode: mode, systemID: Number(systemID) };
		if (mode === "set") {
			if (fields && fields.status !== undefined) { body.status = fields.status === null ? "" : String(fields.status); }
			if (fields && fields.alias !== undefined) { body.alias = systemStatus.clean(fields.alias, systemStatus.ALIAS_MAX); }
			if (fields && fields.occupier !== undefined) { body.occupier = systemStatus.clean(fields.occupier, systemStatus.OCCUPIER_MAX); }
		}
		return body;
	},

	/** The row after applying a local change (fields as in payload); null when nothing is left */
	applyFields: function(row, systemID, fields, setBy, nowSec) {
		const next = Object.assign({ systemID: Number(systemID), status: null, alias: "", occupier: "" }, row || {});
		if (fields.status !== undefined) { next.status = fields.status; }
		if (fields.alias !== undefined) { next.alias = systemStatus.clean(fields.alias, systemStatus.ALIAS_MAX); }
		if (fields.occupier !== undefined) { next.occupier = systemStatus.clean(fields.occupier, systemStatus.OCCUPIER_MAX); }
		if (!next.status && !next.alias && !next.occupier) { return null; }
		next.setBy = setBy || null;
		next.setAt = nowSec;
		return next;
	},

	// ---- Browser-only code below (not run under mocha) ----

	options: function() { return typeof options !== "undefined" ? options : undefined; },

	/** Decorate (or clean) one drawn node element */
	patchNode: function(node, on) {
		const $node = $(node);
		$node.children(".sysstatus-letter, .sysstatus-alias").remove();
		$node.removeClass("sysstatus sysstatus-has-alias").removeClass(systemStatus.STATUSES.map(function(s) { return "sysstatus-" + s.key; }).join(" "));
		if (!on || $node.closest(".destination-node").length) { return; }
		const row = systemStatus.rows[String($node.attr("data-nodeid"))];
		if (!row) { return; }
		$node.addClass(systemStatus.nodeClasses(row));
		const html = systemStatus.nodeHtml(row);
		if (html) { $node.prepend(html); }
	},

	/** Decorate every drawn node of the chain map (all renderers draw div.node[data-nodeid]) */
	patchChain: function() {
		const on = systemStatus.enabled(systemStatus.options());
		if (on && !systemStatus.requested) { systemStatus.requested = true; systemStatus.fetch(); }	// switched on after load: nothing read yet
		$("#chainMap .node[data-nodeid]").each(function() { systemStatus.patchNode(this, on); });
	},

	/** The system info panel line for the viewed system: before the activity graph, re-rendered from systemChange and the
	poll tick. Hidden when the setting is off. */
	renderInfo: function() {
		let $el = $("#systemStatusInfo");
		const $anchor = $("#infoWidget #activityGraph");
		if (!$anchor.length || !systemStatus.enabled(systemStatus.options())) { $el.remove(); return; }
		if (!$el.length) { $el = $("<div id='systemStatusInfo' class='sysstatus-info'></div>"); }
		if ($el.next()[0] !== $anchor[0]) { $anchor.before($el.detach()); }
		const id = typeof viewingSystemID !== "undefined" ? viewingSystemID : null;
		const row = id ? systemStatus.rows[String(id)] : null;
		const line = systemStatus.infoLine(row);
		const st = row ? systemStatus.statusInfo(row.status) : null;
		$el.attr("class", "sysstatus-info" + (st ? " sysstatus-info-" + st.key : ""));
		$el.text(line).toggle(!!line);
	},

	hash: "",	// of the last full answer: the poll sends it back and gets { unchanged: true } when nothing changed
	pending: 0,	// POSTs in flight: poll answers that arrive meanwhile may predate them and are ignored
	postSeq: 0,

	apply: function(list, hash) {
		if (hash) { systemStatus.hash = hash; }
		const next = systemStatus.toMap(list);
		if (!systemStatus.changed(systemStatus.rows, next)) { return; }
		systemStatus.rows = next;
		systemStatus.patchChain();
		systemStatus.renderInfo();
	},

	/** Read the mask's rows (the poll, and on demand when the menu opens). Skipped while the tab is hidden. */
	fetch: function() {
		if (typeof document !== "undefined" && document.hidden) { return; }
		systemStatus.requested = true;
		const seq = systemStatus.postSeq;
		return $.ajax({ url: systemStatus.URL, type: "GET", dataType: "JSON", cache: false, data: systemStatus.hash ? { have: systemStatus.hash } : {} })
			.done(function(data) {
				// A change of ours is on its way, or was answered since this read began: this answer may predate it
				if (systemStatus.pending > 0 || seq !== systemStatus.postSeq) { return; }
				if (data && data.systems) { systemStatus.apply(data.systems, data.hash); }
			});
	},

	/** The 10 s tick: nothing at all while the setting is off (the menu reads on demand); else the age text and a poll */
	tick: function() {
		if (!systemStatus.enabled(systemStatus.options()) || document.hidden) { return; }
		systemStatus.renderInfo();
		systemStatus.fetch();
	},

	post: function(body) {
		systemStatus.pending++;
		systemStatus.postSeq++;
		return $.ajax({
			url: systemStatus.URL, type: "POST", dataType: "JSON", data: body,
			headers: { "X-Requested-With": "XMLHttpRequest" }
		}).done(function(data) {
			if (data && data.systems) { systemStatus.apply(data.systems, data.hash); }
		}).fail(function(x) {
			const msg = x && x.responseJSON && x.responseJSON.error ? x.responseJSON.error : "Couldn't update the system";
			if (typeof Notify !== "undefined") { Notify.trigger(msg, "red"); }
			systemStatus.hash = "";
		}).always(function() {
			systemStatus.pending--;
			systemStatus.postSeq++;
		}).fail(function() { systemStatus.fetch(); });
	},

	/** Show a local change at once (row, or null for none); the server's answer replaces it */
	show: function(systemID, row) {
		const next = Object.assign({}, systemStatus.rows);
		if (row) { next[String(systemID)] = row; } else { delete next[String(systemID)]; }
		systemStatus.rows = next;
		systemStatus.patchChain();
		systemStatus.renderInfo();
	},

	/** Change fields of a system */
	change: function(systemID, fields) {
		if (!systemStatus.isSystemID(systemID)) { return; }
		const by = tripwire.client && tripwire.client.EVE ? tripwire.client.EVE.characterName : null;
		systemStatus.show(systemID, systemStatus.applyFields(systemStatus.rows[String(systemID)], systemID, fields, by, Math.floor(Date.now() / 1000)));
		return systemStatus.post(systemStatus.payload("set", systemID, fields));
	},

	/** Remove status, alias and occupier at once */
	clearAll: function(systemID) {
		if (!systemStatus.isSystemID(systemID)) { return; }
		systemStatus.show(systemID, null);
		return systemStatus.post(systemStatus.payload("clear", systemID));
	},

	systemName: function(systemID) {
		return tripwire.systems && tripwire.systems[systemID] ? tripwire.systems[systemID].name : String(systemID);
	},

	/** Dialog for the alias or the occupier (one text field, Clear and Save) */
	openDialog: function(kind, systemID) {
		if (!systemStatus.isSystemID(systemID)) { return; }
		const isAlias = kind === "alias";
		const max = isAlias ? systemStatus.ALIAS_MAX : systemStatus.OCCUPIER_MAX;
		let $d = $("#dialog-system-status");
		if (!$d.length) {
			$d = $("<div id='dialog-system-status'>" +
				"<p class='ss-dialog-system'></p><p class='ss-dialog-help'></p>" +
				"<p><input type='text' class='ss-dialog-text'></p>" +
				"<p class='ss-dialog-suggest'></p></div>").appendTo("body");
			$d.dialog({
				autoOpen: false, modal: true, width: 380, resizable: false,
				buttons: [
					{ text: "Save", click: function() { $d.data("save")($d.find(".ss-dialog-text").val()); $(this).dialog("close"); } },
					{ text: "Clear", click: function() { $d.data("save")(""); $(this).dialog("close"); } },
					{ text: "Cancel", click: function() { $(this).dialog("close"); } }
				]
			});
			$d.on("keydown", ".ss-dialog-text", function(e) {
				if (e.key === "Enter") { e.preventDefault(); $d.parent().find(".ui-dialog-buttonpane button").first().click(); }
			});
			$d.on("click", ".ss-suggestion", function(e) {
				e.preventDefault();
				$d.find(".ss-dialog-text").val($(this).text()).trigger("focus");
			});
		}
		const row = systemStatus.rows[String(systemID)];
		$d.dialog("option", "title", isAlias ? "System alias" : "System occupier");
		$d.data("save", function(text) {
			const fields = {};
			fields[isAlias ? "alias" : "occupier"] = text;
			systemStatus.change(systemID, fields);
		});
		$d.find(".ss-dialog-system").text(systemStatus.systemName(systemID));
		$d.find(".ss-dialog-help").text(isAlias
			? "A short name shown on the map node, e.g. Staging or Home 2. Everyone on your mask sees it; it stays when the system leaves the chain."
			: "Who lives here, e.g. [HSTL] Hostile Corp. Everyone on your mask sees it.");
		$d.find(".ss-dialog-text").attr("maxlength", max).attr("placeholder", isAlias ? "e.g. Staging" : "e.g. [HSTL] Hostile Corp")
			.val(row ? (isAlias ? row.alias : row.occupier) : "");
		const $suggest = $d.find(".ss-dialog-suggest").empty();
		$d.dialog("open");
		$d.find(".ss-dialog-text").trigger("focus");
		if (!isAlias) {
			// Pre-suggest from the residents set for this system (Intel panel > Threat & residents): nothing is stored twice
			$.ajax({ url: systemStatus.RESIDENTS_URL, type: "GET", dataType: "JSON", cache: false, data: { systemID: systemID } })
				.done(function(data) {
					if (!$d.dialog("isOpen")) { return; }
					const list = systemStatus.suggestions(data && data.residents);
					if (!list.length) { return; }
					$suggest.append(document.createTextNode("From residents: "));
					list.forEach(function(text, i) {
						if (i) { $suggest.append(document.createTextNode(" · ")); }
						$suggest.append($("<a href='#' class='ss-suggestion'></a>").text(text));
					});
				});
		}
	},

	setupSettings: function() {
		if (typeof options === "undefined") { return; }
		// Settings > Map Markers; takes effect on Save like its neighbours (upstream Save redraws the chain), Reset = on
		forkSettings.register({
			section: "markers", order: 60, id: "systemStatus-enabled", type: "checkbox", key: "systemStatus",
			label: "System status:", text: "Show system status colours and aliases on the map and in the system info panel",
			get: function(o) { return systemStatus.enabled(o); },
			set: function(o, on) { o.systemStatus = { enabled: on }; }
		});
	},

	/** Decorate after every draw: size-tags hooks every renderer's draw and collapse (and the old org chart) */
	hookSizeTags: function() {
		if (typeof sizeTags === "undefined" || sizeTags.systemStatusHooked) { return; }
		sizeTags.systemStatusHooked = true;
		["placeOnDrawnMap", "placeOnOrgChart"].forEach(function(name) {
			const original = sizeTags[name];
			sizeTags[name] = function() {
				const result = original.apply(this, arguments);
				try { systemStatus.patchChain(); } catch (e) { console.warn("system-status: could not decorate the map", e); }
				return result;
			};
		});
	},

	menuHtml: function() {
		return "<li data-command='sysStatusMenu'><a id='sysStatusMenuItem'>Status</a><ul style='width: 10em;'>" +
			systemStatus.STATUSES.map(function(s) {
				return "<li data-command='" + systemStatus.CMD + s.key + "'><a>" + s.label + "</a></li>";
			}).join("") +
			"<li>-</li><li data-command='" + systemStatus.CMD + "clear'><a>Clear status</a></li></ul></li>" +
			"<li data-command='" + systemStatus.CMD_ALIAS + "'><a>Alias&hellip;</a></li>" +
			"<li data-command='" + systemStatus.CMD_OCCUPIER + "'><a>Occupier&hellip;</a></li>" +
			"<li data-command='" + systemStatus.CMD_CLEAR + "'><a title='Remove status, alias and occupier'>Clear all status</a></li>";
	},

	setupMenu: function() {
		const chainParent = $("#chainParent");
		const $mass = $("#chainMenu > li[data-command='mass']");
		const $entries = $(systemStatus.menuHtml());
		if ($mass.length) { $entries.insertAfter($mass); } else { $("#chainMenu").append($entries); }
		$("#chainMenu").menu("refresh");
		const systemOf = function(target) {
			const id = $(target).closest("[data-nodeid]").attr("data-nodeid");
			return systemStatus.isSystemID(id) ? Number(id) : null;
		};

		const originalSelect = chainParent.contextmenu("option", "select");
		chainParent.contextmenu("option", "select", function(e, ui) {
			const cmd = String(ui.cmd || "");
			if (cmd.indexOf(systemStatus.CMD) === 0 || cmd === systemStatus.CMD_ALIAS || cmd === systemStatus.CMD_OCCUPIER || cmd === systemStatus.CMD_CLEAR) {
				const id = systemOf(ui.target[0]);
				if (id === null) { return; }
				if (cmd === systemStatus.CMD_CLEAR) { systemStatus.clearAll(id); }
				else if (cmd === systemStatus.CMD_ALIAS) { systemStatus.openDialog("alias", id); }
				else if (cmd === systemStatus.CMD_OCCUPIER) { systemStatus.openDialog("occupier", id); }
				else {
					const key = cmd.substring(systemStatus.CMD.length);
					systemStatus.change(id, { status: key === "clear" ? null : key });
				}
				return;
			}
			return originalSelect ? originalSelect.apply(this, arguments) : undefined;
		});

		const originalBeforeOpen = chainParent.contextmenu("option", "beforeOpen");
		chainParent.contextmenu("option", "beforeOpen", function(e, ui) {
			try {
				const id = systemOf(ui.target[0]);
				const menu = $(this);
				systemStatus.fetch();	// on demand: current the next time it opens, also while polling is off
				["sysStatusMenu", systemStatus.CMD_ALIAS, systemStatus.CMD_OCCUPIER, systemStatus.CMD_CLEAR].forEach(function(c) { menu.contextmenu("showEntry", c, id !== null); });
				const row = id !== null ? systemStatus.rows[String(id)] : null;
				systemStatus.STATUSES.forEach(function(s) {
					$("#chainMenu li[data-command='" + systemStatus.CMD + s.key + "'] > a").text((row && row.status === s.key ? "✓ " : "") + s.label);
				});
				$("#chainMenu li[data-command='" + systemStatus.CMD_ALIAS + "'] > a").html(row && row.alias ? "Alias: " + systemStatus.escape(row.alias) + "&hellip;" : "Alias&hellip;");
				$("#chainMenu li[data-command='" + systemStatus.CMD_OCCUPIER + "'] > a").html(row && row.occupier ? "Occupier&hellip; (set)" : "Occupier&hellip;");
			} catch (err) { console.error("system-status: menu update failed", err); }
			return originalBeforeOpen ? originalBeforeOpen.apply(this, arguments) : undefined;
		});
	},

	init: function() {
		if (typeof chain === "undefined" || !chain) { return; }
		systemStatus.hookSizeTags();
		systemStatus.setupSettings();
		try { systemStatus.setupMenu(); } catch (e) { console.error("system-status: context menu setup failed", e); }
		if (typeof tripwire !== "undefined" && typeof tripwire.systemChange === "function" && !tripwire.systemChange.systemStatusWrapped) {
			const systemChange = tripwire.systemChange;
			tripwire.systemChange = function() {
				const result = systemChange.apply(this, arguments);
				systemStatus.renderInfo();
				return result;
			};
			tripwire.systemChange.systemStatusWrapped = true;
		}
		if (systemStatus.enabled(systemStatus.options())) { systemStatus.fetch(); }	// off: read on demand (menu), never polled
		setInterval(systemStatus.tick, systemStatus.POLL_MS);
		document.addEventListener("visibilitychange", function() { if (!document.hidden && systemStatus.enabled(systemStatus.options())) { systemStatus.fetch(); } });
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.menu) {
	$(function() { systemStatus.init(); });
}
