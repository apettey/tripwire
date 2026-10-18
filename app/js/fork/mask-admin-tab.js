const maskAdminTab = {
	// Fork-owned: Mask Admin > Admins & members. Mask admins (several), removing/blocking members, mask-wide default
	// settings and the audit trail. Server side: public/mask_admins.php (everything is checked there again; this only shows
	// what the server says the viewer may do). Keep `const maskAdminTab` on the first line (test helper).
	URL: "mask_admins.php",
	WINDOW: "maskadmins",
	state: null,
	csrf: "",
	query: "",
	blocking: null,		// character id whose block form is open

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** "2026-10-11 14:03:22" (server, UTC) -> "2026-10-11 14:03" */
	when: function(stamp) {
		return stamp ? String(stamp).slice(0, 16) : "";
	},

	KIND: { "owner": "Owner", "corp-admin": "Corp admin", "granted": "Mask admin" },

	ACTIONS: {
		grant: "made {target} a mask admin", revoke: "revoked mask admin from {target}", block: "blocked {target}",
		unblock: "unblocked {target}", remove: "removed {target}'s access", defaults: "changed the mask defaults",
		bookmarks: "changed the bookmark names"
	},

	/** One audit line as text: "Alice blocked Bob (reason)" */
	auditText: function(e) {
		const template = maskAdminTab.ACTIONS[e.action] || e.action;
		const text = (e.actorName || "?") + " " + template.replace("{target}", e.targetName || ("#" + e.targetID));
		return e.detail ? text + " (" + e.detail + ")" : text;
	},

	/** Characters an admin can be made from: members who aren't admin (of any kind) or blocked, by name */
	grantable: function(state) {
		return (state.members || []).filter(function(m) { return !m.protected && !m.granted && !m.blocked; });
	},

	/** Buttons a member row offers: ["block", "remove", "unblock"] */
	memberActions: function(member) {
		if (member.protected || member.granted) { return []; }
		if (member.blocked) { return ["unblock"]; }
		return member.direct ? ["block", "remove"] : ["block"];
	},

	adminsHtml: function(state) {
		const esc = maskAdminTab.escape;
		const rows = [];
		(state.owners || []).forEach(function(o) {
			rows.push("<tr><td>" + esc(o.characterName) + "</td><td>" + esc(maskAdminTab.KIND[o.kind] || o.kind) + "</td><td class='ma-dim'>from the mask's ownership</td><td></td></tr>");
		});
		(state.granted || []).forEach(function(g) {
			rows.push("<tr data-cid='" + esc(g.characterID) + "'><td>" + esc(g.characterName || ("#" + g.characterID)) + "</td><td>Mask admin</td><td class='ma-dim'>by "
				+ esc(g.grantedByName) + ", " + esc(maskAdminTab.when(g.grantedAt)) + "</td><td>"
				+ (state.canManage ? "<button type='button' class='ma-revoke'>Revoke</button>" : "") + "</td></tr>");
		});
		const options = maskAdminTab.grantable(state).map(function(m) {
			return "<option value='" + esc(m.characterID) + "'>" + esc(m.characterName) + " (" + esc(m.corporationName) + ")</option>";
		}).join("");
		const add = state.canManage
			? "<div class='ma-add'><select class='ma-grant-select'><option value=''>Make a member a mask admin...</option>" + options + "</select> "
				+ "<button type='button' class='ma-grant'>Make admin</button></div>"
			: "<p class='ma-dim'>Only the owner or the owning corporation's admins can add or revoke mask admins.</p>";
		return "<h3>Admins</h3><table class='ma-table'><thead><tr><th>Character</th><th>Role</th><th>Since</th><th></th></tr></thead><tbody>"
			+ rows.join("") + "</tbody></table>" + add;
	},

	membersHtml: function(state) {
		const esc = maskAdminTab.escape;
		const rows = (state.members || []).map(function(m) {
			const blocked = (state.blocked || []).filter(function(b) { return Number(b.characterID) === m.characterID; })[0];
			let status = "";
			if (m.protected) { status = "Admin"; }
			else if (m.granted) { status = "Mask admin"; }
			else if (blocked) {
				status = "<span class='ma-blocked'>Blocked</span> <span class='ma-dim'>" + esc(blocked.reason) + " (" + esc(blocked.blockedByName) + ", " + esc(maskAdminTab.when(blocked.blockedAt)) + ")</span>";
			}
			const buttons = maskAdminTab.memberActions(m).map(function(a) {
				const title = { block: "Block: they can't use this mask even if their corporation or alliance has access",
					remove: "Remove their own entry from the access list", unblock: "Let them use the mask again" }[a];
				return "<button type='button' class='ma-" + a + "' title='" + esc(title) + "'>" + a.charAt(0).toUpperCase() + a.slice(1) + "</button>";
			}).join(" ");
			let html = "<tr data-cid='" + esc(m.characterID) + "'" + (blocked ? " class='ma-row-blocked'" : "") + "><td>" + esc(m.characterName) + "</td><td class='ma-dim'>" + esc(m.corporationName)
				+ "</td><td>" + status + "</td><td class='ma-buttons'>" + buttons + "</td></tr>";
			if (maskAdminTab.blocking === m.characterID) {
				html += "<tr class='ma-block-form'><td colspan='4'>Block " + esc(m.characterName) + ": <input type='text' class='ma-reason' maxlength='200' placeholder='Reason (required)' /> "
					+ "<button type='button' class='ma-block-confirm'>Block</button> <button type='button' class='ma-block-cancel'>Cancel</button></td></tr>";
			}
			return html;
		}).join("");
		return "<h3>Members</h3><div class='ma-search'><input type='search' class='ma-q' placeholder='Find a character...' value='" + esc(maskAdminTab.query) + "' maxlength='50' /></div>"
			+ "<table class='ma-table'><thead><tr><th>Character</th><th>Corporation</th><th>Status</th><th></th></tr></thead><tbody>"
			+ (rows || "<tr><td colspan='4' class='ma-dim'>No members found.</td></tr>") + "</tbody></table>"
			+ "<p class='ma-dim'>Members are the characters of the mask's corporations and characters, and anyone who used the mask. Alliance members appear once they have used it. Blocks are per character: a player's other characters are not blocked unless you block them too.</p>"
			+ (state.truncated ? "<p class='ma-dim'>Showing the first " + (state.members || []).length + ": search by name to find others.</p>" : "");
	},

	defaultsHtml: function(state) {
		const esc = maskAdminTab.escape;
		const defaults = state.defaults || {};
		const keys = Object.keys(defaults);
		const pickable = typeof maskDefaults !== "undefined" && typeof forkSettings !== "undefined" ? maskDefaults.pickable(forkSettings.items) : [];
		const boxes = pickable.map(function(p) {
			const on = Object.prototype.hasOwnProperty.call(defaults, p.key);
			return "<label class='ma-pick'><input type='checkbox' class='ma-pick-box' value='" + esc(p.key) + "'" + (on ? " checked" : "") + " /> " + esc(p.label) + "</label>";
		}).join("");
		const current = keys.length
			? "Set by " + esc(state.defaultsBy || "?") + ", " + esc(maskAdminTab.when(state.defaultsAt)) + ": " + keys.map(esc).join(", ")
			: "No mask defaults: everyone starts with Tripwire's built-in settings.";
		return "<h3>Mask default settings</h3><p class='ma-dim'>Members who haven't chosen a value for a setting get the mask default instead of the built-in one. "
			+ "Pick the settings, set them up the way you want in your own Settings, then save.</p><div class='ma-picks'>" + (boxes || "<span class='ma-dim'>No settings to pick.</span>") + "</div>"
			+ "<div class='ma-defaults-buttons'><button type='button' class='ma-defaults-save'>Save current settings as mask defaults</button> "
			+ "<button type='button' class='ma-defaults-clear'" + (keys.length ? "" : " disabled") + ">Clear mask defaults</button></div><p class='ma-dim'>" + current + "</p>";
	},

	auditHtml: function(state) {
		const esc = maskAdminTab.escape;
		const rows = (state.audit || []).map(function(e) {
			return "<tr><td class='ma-dim'>" + esc(maskAdminTab.when(e.at)) + "</td><td>" + esc(maskAdminTab.auditText(e)) + "</td></tr>";
		}).join("");
		return "<h3>Recent changes</h3><table class='ma-table ma-audit'><tbody>" + (rows || "<tr><td class='ma-dim'>Nothing yet.</td></tr>") + "</tbody></table>";
	},

	pageHtml: function(state) {
		if (!state || !state.canAdmin) { return "<p class='ma-bad'>Only mask admins can see this.</p>"; }
		let html = "<div class='ma-message'></div>";
		if (state.custom) { html += maskAdminTab.adminsHtml(state) + maskAdminTab.membersHtml(state); }
		else { html += "<p class='ma-dim'>Admins and blocking are for custom masks. On this mask you can set the default settings.</p>"; }
		return html + maskAdminTab.defaultsHtml(state) + maskAdminTab.auditHtml(state);
	},

	// ---- browser ----

	$window: function() { return $("#dialog-admin .window [data-window='" + maskAdminTab.WINDOW + "']"); },

	errorText: function(xhr) {
		return (xhr && xhr.responseJSON && xhr.responseJSON.error) || "Request failed" + (xhr && xhr.status ? " (HTTP " + xhr.status + ")" : "");
	},

	message: function(text, bad) {
		maskAdminTab.$window().find(".ma-message").removeClass("ma-good ma-bad").addClass(bad ? "ma-bad" : "ma-good").text(text || "");
	},

	render: function(text) {
		const $w = maskAdminTab.$window();
		const scroll = $w.scrollTop();
		$w.html(maskAdminTab.pageHtml(maskAdminTab.state));
		$w.scrollTop(scroll);
		if (text) { maskAdminTab.message(text, false); }
	},

	use: function(data, text) {
		maskAdminTab.state = data;
		maskAdminTab.csrf = data.csrf || maskAdminTab.csrf;
		maskAdminTab.render(text);
		if (data.defaults !== undefined && typeof maskDefaults !== "undefined" && maskAdminTab.state.canAdmin) {
			maskDefaults.use({ defaults: data.defaults, updatedBy: data.defaultsBy, updatedAt: data.defaultsAt });
		}
	},

	load: function() {
		const t = maskAdminTab;
		return $.ajax({ url: t.URL, type: "GET", data: { mode: "get", q: t.query }, dataType: "JSON", cache: false }).done(function(data) {
			t.state = data;
			t.csrf = data.csrf || t.csrf;
			// keep the search box (and what is typed in it) while the lists redraw
			t.render();
		}).fail(function(xhr) { t.$window().html("<p class='ma-bad'>" + t.escape(t.errorText(xhr)) + "</p>"); });
	},

	request: function(mode, data, done) {
		const t = maskAdminTab;
		return $.ajax({
			url: t.URL, type: "POST", contentType: "application/json", dataType: "JSON",
			data: JSON.stringify(Object.assign({ mode: mode }, data || {})),
			headers: { "X-CSRF-Token": t.csrf, "X-Requested-With": "XMLHttpRequest" }
		}).done(function(answer) {
			t.blocking = null;
			t.use(answer, done);
			if (t.query) { t.load(); }
		}).fail(function(xhr) { t.message(t.errorText(xhr), true); });
	},

	rowID: function(el) { return Number($(el).closest("tr[data-cid]").attr("data-cid")); },

	bind: function() {
		const t = maskAdminTab;
		const sel = "#dialog-admin .window [data-window='" + t.WINDOW + "']";
		const $doc = $(document);
		$doc.on("click", sel + " .ma-grant", function() {
			const id = Number($(sel + " .ma-grant-select").val());
			if (!id) { t.message("Pick a member first.", true); return; }
			t.request("grant", { characterID: id }, "Mask admin granted.");
		});
		$doc.on("click", sel + " .ma-revoke", function() {
			if (window.confirm("Revoke mask admin from this character?")) { t.request("revoke", { characterID: t.rowID(this) }, "Mask admin revoked."); }
		});
		$doc.on("click", sel + " .ma-block", function() { t.blocking = t.rowID(this); t.render(); t.$window().find(".ma-reason").focus(); });
		$doc.on("click", sel + " .ma-block-cancel", function() { t.blocking = null; t.render(); });
		$doc.on("click", sel + " .ma-block-confirm", function() {
			const reason = $.trim(t.$window().find(".ma-reason").val());
			if (!reason) { t.message("Give a reason.", true); return; }
			t.request("block", { characterID: t.blocking, reason: reason }, "Blocked: they drop to their corp mask on their next request.");
		});
		$doc.on("click", sel + " .ma-unblock", function() { t.request("unblock", { characterID: t.rowID(this) }, "Unblocked."); });
		$doc.on("click", sel + " .ma-remove", function() {
			if (window.confirm("Remove this character's own access entry? Access through their corporation or alliance stays: block them for that.")) {
				t.request("remove", { characterID: t.rowID(this) }, "Access removed.");
			}
		});
		$doc.on("click", sel + " .ma-defaults-save", function() {
			const keys = t.$window().find(".ma-pick-box:checked").map(function() { return $(this).val(); }).get();
			if (!keys.length) { t.message("Tick the settings that should become mask defaults.", true); return; }
			// The member's real value, not an inherited one
			t.request("defaults-save", { defaults: maskDefaults.collect(options, keys) }, "Mask defaults saved.");
		});
		$doc.on("click", sel + " .ma-defaults-clear", function() {
			if (window.confirm("Clear the mask defaults? Members go back to the built-in settings unless they chose their own.")) { t.request("defaults-clear", {}, "Mask defaults cleared."); }
		});
		let timer;
		$doc.on("input", sel + " .ma-q", function() {
			t.query = $.trim($(this).val());
			clearTimeout(timer);
			timer = setTimeout(function() { t.load().done(function() { const $q = t.$window().find(".ma-q"); $q.focus(); $q[0].setSelectionRange($q.val().length, $q.val().length); }); }, 300);
		});
	},

	init: function() {
		const t = maskAdminTab;
		const $dialog = $("#dialog-admin");
		if (!$dialog.length || !$("a#admin").length || $("a#admin").css("display") === "none") { return; }
		if (!$dialog.find(".menu li[data-window='" + t.WINDOW + "']").length) {
			$dialog.find(".menu ul").append("<li data-window='" + t.WINDOW + "'><a href='#'>Admins &amp; members</a></li>");
			$dialog.find(".window").append("<div data-window='" + t.WINDOW + "' class='hidden'></div>");
		}
		t.bind();
		$(document).on("click", "#dialog-admin .menu li", function() {
			const mine = $(this).attr("data-window") === t.WINDOW;
			const $d = $("#dialog-admin");
			if (!$d.hasClass("ui-dialog-content")) { return; }
			$d.closest(".ui-dialog").toggleClass("ma-admin-active", mine);	// hides the "Total: n" tray
			if (mine) {
				$d.dialog("option", "height", Math.min(700, Math.max(350, $(window).height() - 40)));
				t.blocking = null;
				t.query = "";
				if (typeof forkUsage !== "undefined") { forkUsage.track("maskAdmins", "opened"); }
				t.load();
			}
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { maskAdminTab.init(); });
}
