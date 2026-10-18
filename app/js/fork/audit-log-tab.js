const auditLogTab = {
	// Fork-owned: Mask Admin > Audit. Who changed which signature or wormhole on the mask, newest first, with filters (system,
	// character, kind, dates) and paging; the mask-admin actions of Mask Admin > Admins & members are in the same list.
	// Server side: public/audit_log.php (admins only; the mask is the session's). Keep `const auditLogTab` on the first line (test helper).
	URL: "audit_log.php",
	WINDOW: "auditlog",
	rows: [],
	page: 1,
	hasMore: false,
	days: 0,
	filters: { system: "", character: "", kind: "", from: "", to: "" },

	KINDS: [
		["", "Everything"], ["signature", "Signatures"], ["signature.add", "Signature added"], ["signature.update", "Signature changed"], ["signature.delete", "Signature deleted"],
		["wormhole", "Wormholes"], ["wormhole.add", "Wormhole mapped"], ["wormhole.update", "Wormhole changed"], ["wormhole.delete", "Wormhole deleted"], ["target", "Region map targets"], ["mask", "Mask admin actions"]
	],

	FIELDS: { signatureID: "ID", systemID: "system", type: "type", name: "name", bookmark: "bookmark", lifeLength: "life", life: "life", mass: "mass", parent: "parent" },

	MASK_ACTIONS: {
		grant: "made {target} a mask admin", revoke: "revoked mask admin from {target}", block: "blocked {target}",
		unblock: "unblocked {target}", remove: "removed {target}'s access", defaults: "changed the mask defaults",
		"token-create": "created an API token", "token-revoke": "revoked an API token of {target}",
		bookmarks: "changed the bookmark names"
	},

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** "2026-10-11 14:03:22" (server, UTC) -> "2026-10-11 14:03" */
	when: function(stamp) {
		return stamp ? String(stamp).slice(0, 16) : "";
	},

	/** A system id as its name (sysName: id -> name or undefined); unknown ones as "#id" */
	system: function(id, sysName) {
		const name = typeof sysName === "function" ? sysName(Number(id)) : undefined;
		return name || ("#" + id);
	},

	/** One changed value for display: system ids by name, empty as "none", long game strings left to the server's clipping */
	value: function(field, v, sysName) {
		if (v === "" || v === null || v === undefined) { return "none"; }
		if (field === "systemID") { return auditLogTab.system(v, sysName); }
		if (field === "lifeLength") { return Number(v) ? (Number(v) / 3600) + "h" : "none"; }
		return String(v);
	},

	/** "name: none → Foo; type: unknown → relic" */
	changesText: function(changes, sysName) {
		const t = auditLogTab;
		return Object.keys(changes || {}).map(function(field) {
			const pair = changes[field] || [];
			if (field === "systemID") { return "leads to " + t.value(field, pair[0], sysName) + " → " + t.value(field, pair[1], sysName); }
			return (t.FIELDS[field] || field) + " " + t.value(field, pair[0], sysName) + " → " + t.value(field, pair[1], sysName);
		}).join("; ");
	},

	/** What the entry says, as plain text without the actor and without the systems (they have their own column) */
	describe: function(row, sysName) {
		const t = auditLogTab;
		const d = row.detail && typeof row.detail === "object" ? row.detail : {};
		const quoted = d.name ? " \"" + d.name + "\"" : "";
		if (row.entity === "mask") {
			const template = t.MASK_ACTIONS[row.action] || row.action;
			const text = template.replace("{target}", row.subject || "someone");
			return typeof row.detail === "string" && row.detail ? text + " (" + row.detail + ")" : text;
		}
		if (row.entity === "signature") {
			const id = d.id || row.subject || "?";
			if (row.action === "add") { return "added " + (d.type || "unknown") + " signature " + id + quoted; }
			if (row.action === "delete") { return "deleted " + (d.type || "unknown") + " signature " + id + quoted; }
			return "changed signature " + id + ": " + t.changesText(d.changes, sysName);
		}
		if (row.entity === "wormhole") {
			const hole = (row.subject || d.type || "?") + " wormhole";
			const ends = d.from || d.to ? " (" + (d.from || "?") + " ↔ " + (d.to || "?") + ")" : "";
			if (row.action === "add") { return "mapped " + hole + ends + ", life " + (d.life || "stable") + ", mass " + (d.mass || "stable"); }
			if (row.action === "delete") { return "deleted " + hole + ends; }
			if (d.from === undefined && d.to === undefined) { return "changed wormhole signature " + (d.id || row.subject || "?") + ": " + t.changesText(d.changes, sysName); }
			return "changed " + hole + ends + ": " + t.changesText(d.changes, sysName);
		}
		if (row.entity === "target") {
			const note = row.subject ? " \"" + row.subject + "\"" : "";
			if (row.action === "add") { return "marked a region map target" + note + (d.expires ? " (until " + d.expires + " EVE time)" : ""); }
			if (row.action === "update") { return "changed a region map target" + note + (d.expires ? " (until " + d.expires + " EVE time)" : ""); }
			if (row.action === "delete") { return "removed a region map target"; }
			if (row.action === "clear") { return "cleared all region map targets" + (d.count ? " (" + d.count + ")" : ""); }
		}
		return row.action + " " + (row.subject || "");
	},

	/** The system cell: links to the system(s) ("J123456" or "J1 → J2"); nothing for entries that have no system */
	systemCell: function(row, sysName) {
		const t = auditLogTab;
		const link = function(id) {
			const name = t.system(id, sysName);
			return String(name).charAt(0) === "#" ? t.escape(name) : "<a href='.?system=" + encodeURIComponent(name) + "' title='Open " + t.escape(name) + "'>" + t.escape(name) + "</a>";
		};
		if (!row.systemID) { return ""; }
		return row.toSystemID && row.toSystemID !== row.systemID ? link(row.systemID) + " → " + link(row.toSystemID) : link(row.systemID);
	},

	rowHtml: function(row, sysName) {
		const t = auditLogTab;
		return "<tr><td class='al-dim al-when'>" + t.escape(t.when(row.at)) + "</td><td class='al-who'>" + t.escape(row.characterName || ("#" + row.characterID))
			+ "</td><td class='al-what'>" + t.escape(t.describe(row, sysName)) + "</td><td class='al-system'>" + t.systemCell(row, sysName) + "</td></tr>";
	},

	/** The system a typed name stands for: exact match, case-insensitive, on {id: {name}}; 0 if none */
	systemID: function(name, systems) {
		const wanted = String(name || "").trim().toLowerCase();
		if (!wanted || !systems) { return 0; }
		const ids = Object.keys(systems);
		for (let i = 0; i < ids.length; i++) {
			if (systems[ids[i]] && String(systems[ids[i]].name).toLowerCase() === wanted) { return Number(ids[i]); }
		}
		return 0;
	},

	/** The request's query values: only the filters that are set. `system` is the typed name, resolved with `systems`. Returns null if the system is unknown. */
	params: function(filters, systems, page) {
		const t = auditLogTab;
		const out = {};
		if (filters.system && String(filters.system).trim()) {
			const id = t.systemID(filters.system, systems);
			if (!id) { return null; }
			out.system = id;
		}
		["character", "kind", "from", "to"].forEach(function(k) {
			const v = String(filters[k] || "").trim();
			if (v) { out[k] = v; }
		});
		if (page > 1) { out.page = page; }
		return out;
	},

	tableHtml: function(rows, sysName) {
		const body = (rows || []).map(function(r) { return auditLogTab.rowHtml(r, sysName); }).join("");
		return "<table class='al-table'><thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>System</th></tr></thead><tbody>"
			+ (body || "<tr><td colspan='4' class='al-dim'>No entries.</td></tr>") + "</tbody></table>";
	},

	filtersHtml: function(filters) {
		const esc = auditLogTab.escape;
		const kinds = auditLogTab.KINDS.map(function(k) {
			return "<option value='" + esc(k[0]) + "'" + (filters.kind === k[0] ? " selected" : "") + ">" + esc(k[1]) + "</option>";
		}).join("");
		return "<div class='al-filters'>"
			+ "<input type='search' class='al-system-q' placeholder='System' maxlength='40' value='" + esc(filters.system) + "' /> "
			+ "<input type='search' class='al-character-q' placeholder='Character' maxlength='50' value='" + esc(filters.character) + "' /> "
			+ "<select class='al-kind'>" + kinds + "</select> "
			+ "<label>From <input type='date' class='al-from' value='" + esc(filters.from) + "' /></label> "
			+ "<label>to <input type='date' class='al-to' value='" + esc(filters.to) + "' /></label> "
			+ "<button type='button' class='al-reset'>Reset</button></div>";
	},

	pagerHtml: function(page, hasMore, count) {
		return "<div class='al-pager'><button type='button' class='al-prev'" + (page > 1 ? "" : " disabled") + ">Newer</button> <span class='al-dim'>Page " + page
			+ (count ? "" : " (empty)") + "</span> <button type='button' class='al-next'" + (hasMore ? "" : " disabled") + ">Older</button></div>";
	},

	// ---- browser ----

	$window: function() { return $("#dialog-admin .window [data-window='" + auditLogTab.WINDOW + "']"); },

	sysName: function(id) {
		return typeof tripwire !== "undefined" && tripwire.systems && tripwire.systems[id] ? tripwire.systems[id].name : undefined;
	},

	/** Redraw the list and pager; the filter inputs stay as they are (so typing isn't interrupted) */
	renderResults: function(message) {
		const t = auditLogTab;
		const $w = t.$window();
		$w.find(".al-results").html((message ? "<p class='al-bad'>" + t.escape(message) + "</p>" : "") + t.tableHtml(t.rows, t.sysName) + t.pagerHtml(t.page, t.hasMore, t.rows.length));
		$w.find(".al-note").text(t.days ? "Entries are kept for " + t.days + " days." : "The audit log is turned off (AUDIT_LOG_DAYS=0).");
	},

	load: function(page) {
		const t = auditLogTab;
		t.page = page || 1;
		const params = t.params(t.filters, typeof tripwire !== "undefined" ? tripwire.systems : null, t.page);
		if (params === null) { t.rows = []; t.hasMore = false; t.renderResults("Unknown system: " + t.filters.system); return $.Deferred().resolve().promise(); }
		return $.ajax({ url: t.URL, type: "GET", data: params, dataType: "JSON", cache: false }).done(function(data) {
			t.rows = data.rows || [];
			t.hasMore = !!data.hasMore;
			t.days = data.days;
			t.renderResults();
		}).fail(function(xhr) {
			t.renderResults((xhr && xhr.responseJSON && xhr.responseJSON.error) || "Request failed" + (xhr && xhr.status ? " (HTTP " + xhr.status + ")" : ""));
		});
	},

	open: function() {
		const t = auditLogTab;
		t.$window().html("<h3>Audit log</h3><p class='al-dim al-note'></p>" + t.filtersHtml(t.filters) + "<div class='al-results'></div>");
		t.load(1);
	},

	bind: function() {
		const t = auditLogTab;
		const sel = "#dialog-admin .window [data-window='" + t.WINDOW + "']";
		const $doc = $(document);
		let timer;
		const search = function() { clearTimeout(timer); timer = setTimeout(function() { t.load(1); }, 350); };
		$doc.on("input", sel + " .al-system-q", function() { t.filters.system = $(this).val(); search(); });
		$doc.on("input", sel + " .al-character-q", function() { t.filters.character = $(this).val(); search(); });
		$doc.on("change", sel + " .al-kind", function() { t.filters.kind = $(this).val(); t.load(1); });
		$doc.on("change", sel + " .al-from", function() { t.filters.from = $(this).val(); t.load(1); });
		$doc.on("change", sel + " .al-to", function() { t.filters.to = $(this).val(); t.load(1); });
		$doc.on("click", sel + " .al-reset", function() { t.filters = { system: "", character: "", kind: "", from: "", to: "" }; t.open(); });
		$doc.on("click", sel + " .al-prev", function() { t.load(Math.max(1, t.page - 1)); });
		$doc.on("click", sel + " .al-next", function() { t.load(t.page + 1); });
	},

	init: function() {
		const t = auditLogTab;
		const $dialog = $("#dialog-admin");
		if (!$dialog.length || !$("a#admin").length || $("a#admin").css("display") === "none") { return; }
		if (!$dialog.find(".menu li[data-window='" + t.WINDOW + "']").length) {
			$dialog.find(".menu ul").append("<li data-window='" + t.WINDOW + "'><a href='#'>Audit</a></li>");
			$dialog.find(".window").append("<div data-window='" + t.WINDOW + "' class='hidden'></div>");
		}
		t.bind();
		$(document).on("click", "#dialog-admin .menu li", function() {
			if ($(this).attr("data-window") !== t.WINDOW) { return; }
			const $d = $("#dialog-admin");
			if (!$d.hasClass("ui-dialog-content")) { return; }
			$d.closest(".ui-dialog").addClass("ma-admin-active");	// hides the "Total: n" tray, like Admins & members
			// upstream's own menu handler sizes the dialog after this one: wait for it
			setTimeout(function() { $d.dialog("option", "height", Math.min(700, Math.max(350, $(window).height() - 40))); }, 0);
			if (typeof forkUsage !== "undefined") { forkUsage.track("auditLog", "opened"); }
			t.open();
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { auditLogTab.init(); });
}
