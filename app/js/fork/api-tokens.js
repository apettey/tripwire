const apiTokens = {
	// Fork-owned: personal access tokens of the REST API. Settings > General > API tokens (your tokens: create, copy once, revoke) and
	// the shared formatting used by Mask Admin > API tokens (api-tokens-tab.js). Server side: public/api_tokens.php; docs:
	// docker/README.md#rest-api. Keep `const apiTokens` on the first line (test helper).
	URL: "api_tokens.php",
	EXPIRY: [["90", "90 days"], ["30", "30 days"], ["365", "1 year"], ["", "No expiry"]],
	state: null,	// the last answer of api_tokens.php
	created: null,	// the token string just created, shown once
	message: null,	// {text, bad}

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** "2026-10-12T14:03:22Z" (server, UTC) -> "2026-10-12 14:03" */
	when: function(iso) {
		return iso ? String(iso).replace("T", " ").slice(0, 16) : "";
	},

	/** "never" when unused, else the time (UTC) and, for the owner, the address it came from */
	lastUsedText: function(token) {
		if (!token || !token.lastUsedAt) { return "never"; }
		return apiTokens.when(token.lastUsedAt) + (token.lastUsedIP ? " from " + token.lastUsedIP : "");
	},

	/** "no expiry" / "expired" / "in 5 days" / "today" for a token (nowMs: for tests) */
	expiryText: function(token, nowMs) {
		if (!token || !token.expiresAt) { return "no expiry"; }
		const left = Date.parse(token.expiresAt) - (nowMs === undefined ? Date.now() : nowMs);
		if (isNaN(left)) { return ""; }
		if (left <= 0) { return "expired"; }
		const days = Math.floor(left / 86400000);
		if (days < 1) { return "today"; }
		return "in " + days + (days === 1 ? " day" : " days");
	},

	/** The select's value ("90", "") as the days the server wants: a whole number, or null for no expiry */
	expiresDays: function(value) {
		const n = parseInt(value, 10);
		return String(value) === "" || isNaN(n) || n < 1 ? null : n;
	},

	/** The curl line that tries a new token */
	exampleCommand: function(token, origin) {
		return "curl -H \"Authorization: Bearer " + token + "\" " + (origin || "") + "/api/v1/chain";
	},

	/** One token as a table row (Mask Admin). Not data-id on the <tr>: upstream's admin window removes every tr[data-id] it has no data for. */
	rowHtml: function(token, opts, nowMs) {
		const t = apiTokens;
		opts = opts || {};
		const expired = token.expired || t.expiryText(token, nowMs) === "expired";
		return "<tr class='apitok-row" + (expired ? " apitok-expired" : "") + "' data-token='" + Number(token.id) + "'>"
			+ "<td class='apitok-name'>" + t.escape(token.name) + "<div class='apitok-dim'>" + t.escape(token.hint) + " &middot; " + t.escape(token.scope) + "</div></td>"
			+ (opts.admin ? "<td>" + t.escape(token.owner || "") + "</td>" : "<td>" + t.escape(token.maskLabel || token.mask) + "</td>")
			+ "<td class='apitok-nowrap'>" + t.escape(t.when(token.createdAt)) + "</td>"
			+ "<td>" + t.escape(t.lastUsedText(token)) + "</td>"
			+ "<td class='apitok-nowrap'>" + t.escape(t.expiryText(token, nowMs)) + "</td>"
			+ "<td><button type='button' class='apitok-revoke' data-id='" + Number(token.id) + "'>Revoke</button></td></tr>";
	},

	/** One token as a compact block (Settings is a narrow dialog): name, mask, dates, revoke */
	cardHtml: function(token, nowMs) {
		const t = apiTokens;
		const expired = token.expired || t.expiryText(token, nowMs) === "expired";
		return "<div class='apitok-card" + (expired ? " apitok-expired" : "") + "' data-id='" + Number(token.id) + "'>"
			+ "<button type='button' class='apitok-revoke' data-id='" + Number(token.id) + "'>Revoke</button>"
			+ "<div class='apitok-name'>" + t.escape(token.name) + " <span class='apitok-dim'>" + t.escape(token.hint) + " &middot; " + t.escape(token.scope) + "</span></div>"
			+ "<div class='apitok-dim'>Mask: " + t.escape(token.maskLabel || token.mask) + "</div>"
			+ "<div class='apitok-dim'>Created " + t.escape(t.when(token.createdAt)) + " &middot; last used " + t.escape(t.lastUsedText(token))
			+ " &middot; expires " + t.escape(t.expiryText(token, nowMs)) + "</div></div>";
	},

	/** The tokens as blocks (Settings), or a line saying there are none. UTC times. */
	listHtml: function(tokens, nowMs) {
		const t = apiTokens;
		if (!tokens || !tokens.length) { return "<p class='apitok-dim'>You have no API tokens.</p>"; }
		return "<div class='apitok-list'>" + tokens.map(function(tok) { return t.cardHtml(tok, nowMs); }).join("") + "</div>"
			+ "<div class='apitok-dim'>Times are UTC.</div>";
	},

	/** The table of tokens (Mask Admin), or a line saying there are none */
	tableHtml: function(tokens, opts, nowMs) {
		const t = apiTokens;
		opts = opts || {};
		if (!tokens || !tokens.length) { return "<p class='apitok-dim'>" + (opts.admin ? "Nobody has an API token for this mask." : "You have no API tokens.") + "</p>"; }
		return "<table class='apitok-table'><thead><tr><th>Name</th><th>" + (opts.admin ? "Owner" : "Mask") + "</th><th>Created (UTC)</th><th>Last used (UTC)</th><th>Expires</th><th></th></tr></thead><tbody>"
			+ tokens.map(function(tok) { return t.rowHtml(tok, opts, nowMs); }).join("") + "</tbody></table>";
	},

	/** The new token, once: the string, a copy button and a curl line */
	createdHtml: function(token, origin) {
		const t = apiTokens;
		return "<div class='apitok-new'><strong>Copy your new token now: it is not shown again.</strong>"
			+ "<div class='apitok-copyrow'><input type='text' readonly class='apitok-token' value='" + t.escape(token) + "' /> <button type='button' class='apitok-copy'>Copy</button></div>"
			+ "<div class='apitok-dim'>Try it: <code>" + t.escape(t.exampleCommand(token, origin)) + "</code></div></div>";
	},

	createFormHtml: function(state) {
		const t = apiTokens;
		const options = t.EXPIRY.map(function(e) { return "<option value='" + t.escape(e[0]) + "'>" + t.escape(e[1]) + "</option>"; }).join("");
		return "<div class='apitok-create'><input type='text' class='apitok-name-input' maxlength='40' placeholder='Name, e.g. Discord bot' /> "
			+ "<select class='apitok-expiry'>" + options + "</select> "
			+ "<button type='button' class='apitok-create-btn'>Create token</button>"
			+ "<div class='apitok-dim'>For the mask you are on (" + t.escape(state.mask && state.mask.label ? state.mask.label : "") + "); read-only. At most " + Number(state.max) + " active tokens.</div></div>";
	},

	/** The whole Settings view for a server answer */
	settingsHtml: function(state, created, origin, nowMs) {
		const t = apiTokens;
		if (!state) { return "<p class='apitok-dim'>Loading...</p>"; }
		if (!state.enabled) { return "<p class='apitok-dim'>The API is turned off on this server (TRIPWIRE_API).</p>"; }
		return "<p class='apitok-dim'>Personal access tokens let your own scripts and bots read this mask over the REST API without your password. "
			+ "A token can read one mask and never change anything; if you lose access to the mask, it stops working.</p>"
			+ (created ? t.createdHtml(created, origin) : "")
			+ t.listHtml(state.tokens, nowMs)
			+ (state.canCreate ? t.createFormHtml(state) : "<p class='apitok-dim'>" + t.escape(state.reason || "") + "</p>");
	},

	// ---- browser ----

	errorText: function(xhr) {
		return (xhr && xhr.responseJSON && xhr.responseJSON.error) || "Request failed" + (xhr && xhr.status ? " (HTTP " + xhr.status + ")" : "");
	},

	load: function() {
		return $.ajax({ url: apiTokens.URL, type: "GET", dataType: "JSON", cache: false });
	},

	request: function(mode, data) {
		return $.ajax({
			url: apiTokens.URL, type: "POST", contentType: "application/json", dataType: "JSON",
			data: JSON.stringify(Object.assign({ mode: mode }, data || {})),
			headers: { "X-CSRF-Token": apiTokens.state ? apiTokens.state.csrf : "", "X-Requested-With": "XMLHttpRequest" }
		});
	},

	/** Redraw every view that is on the page */
	render: function() {
		const t = apiTokens;
		const $box = $(".apitok-settings");
		if ($box.length) {
			$box.html(t.settingsHtml(t.state, t.created, window.location.origin));
			if (t.message) { $box.prepend($("<p class='apitok-msg'></p>").addClass(t.message.bad ? "apitok-bad" : "apitok-good").text(t.message.text)); }
		}
		if (typeof apiTokensTab !== "undefined") { apiTokensTab.render(); }
	},

	/** A new answer of api_tokens.php (create / revoke answers carry the lists too) */
	use: function(data) {
		apiTokens.state = data;
		apiTokens.render();
	},

	refresh: function() {
		const t = apiTokens;
		return t.load().done(function(data) { t.use(data); }).fail(function(xhr) {
			t.state = null;
			t.message = { text: t.errorText(xhr), bad: true };
			t.render();
		});
	},

	copy: function(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) { return navigator.clipboard.writeText(text); }
		const $input = $(".apitok-token").first();
		$input.trigger("focus").trigger("select");
		document.execCommand("copy");
		return Promise.resolve();
	},

	revoke: function(id) {
		const t = apiTokens;
		return t.request("revoke", { id: id }).done(function(data) {
			t.message = { text: "Token revoked.", bad: false };
			t.use(data);
		}).fail(function(xhr) {
			t.message = { text: t.errorText(xhr), bad: true };
			t.render();
		});
	},

	create: function(name, days) {
		const t = apiTokens;
		return t.request("create", { name: name, expiresDays: days }).done(function(data) {
			t.created = data.token;
			t.message = null;
			delete data.token;
			t.use(data);
		}).fail(function(xhr) {
			t.created = null;
			t.message = { text: t.errorText(xhr), bad: true };
			t.render();
		});
	},

	bind: function() {
		const t = apiTokens;
		$(document).on("click", ".apitok-create-btn", function() {
			const $c = $(this).closest(".apitok-create");
			t.create($c.find(".apitok-name-input").val(), t.expiresDays($c.find(".apitok-expiry").val()));
		});
		$(document).on("keydown", ".apitok-name-input", function(e) {
			if (e.key === "Enter") { e.preventDefault(); $(this).closest(".apitok-create").find(".apitok-create-btn").trigger("click"); }
		});
		$(document).on("click", ".apitok-revoke", function() {
			const id = Number($(this).attr("data-id"));
			const name = $(this).closest("tr").find(".apitok-name").clone().children().remove().end().text();
			if (window.confirm("Revoke the token \"" + name + "\"? Whatever uses it stops working at once.")) { t.revoke(id); }
		});
		$(document).on("click", ".apitok-copy", function() {
			const $b = $(this);
			Promise.resolve(t.copy($b.closest(".apitok-copyrow").find(".apitok-token").val())).then(function() {
				$b.text("Copied");
				setTimeout(function() { $b.text("Copy"); }, 2000);
			});
		});
		// Settings opens: show the current list (never keep the new token around after the dialog was closed)
		$(document).on("dialogopen", "#dialog-options", function() {
			t.created = null;
			t.message = null;
			t.refresh();
		});
	},

	init: function() {
		apiTokens.bind();
		if (typeof forkSettings !== "undefined") {
			// Settings > General. Stores nothing in options (the tokens live on the server), so there is no options key and no
			// Settings toggle: nothing is shown or done until someone creates a token.
			forkSettings.register({
				section: "general", order: 90, id: "apiTokens", type: "custom", label: "API tokens:",
				keywords: "api rest token bot script access personal",
				html: "<div class='apitok-settings'><p class='apitok-dim'>Loading...</p></div>"
			});
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { apiTokens.init(); });
}
