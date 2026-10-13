const apiTokensTab = {
	// Fork-owned: Mask Admin > API tokens. The tokens issued for the mask (name, owner, created, last used, expiry) with Revoke, for
	// the mask's admins (the server sends nothing to anybody else, and refuses a revoke by anybody else). Shares the formatting and
	// requests of api-tokens.js. Keep `const apiTokensTab` on the first line (test helper).
	WINDOW: "apitokens",

	$window: function() { return $("#dialog-admin .window [data-window='" + apiTokensTab.WINDOW + "']"); },

	/** The tab's content for a server answer of api_tokens.php */
	html: function(state, message, nowMs) {
		const t = apiTokens;
		if (!state) { return "<h3>API tokens</h3>" + (message ? "<p class='apitok-bad'>" + t.escape(message.text) + "</p>" : "<p class='apitok-dim'>Loading...</p>"); }
		if (!state.enabled) { return "<h3>API tokens</h3><p class='apitok-dim'>The API is turned off on this server (TRIPWIRE_API).</p>"; }
		if (!state.maskTokens) { return "<h3>API tokens</h3><p class='apitok-dim'>Only mask admins can see the API tokens of the mask.</p>"; }
		return "<h3>API tokens</h3><p class='apitok-dim'>Personal access tokens members created for " + t.escape(state.mask.label) + ". Revoking one stops it at once; "
			+ "a member who loses access to the mask or is blocked loses their tokens' access without you doing anything.</p>"
			+ (message ? "<p class='apitok-msg " + (message.bad ? "apitok-bad" : "apitok-good") + "'>" + t.escape(message.text) + "</p>" : "")
			+ t.tableHtml(state.maskTokens, { admin: true }, nowMs);
	},

	render: function() {
		const $w = apiTokensTab.$window();
		if (!$w.length || !$w.is(":visible")) { return; }
		$w.html(apiTokensTab.html(apiTokens.state, apiTokens.message));
	},

	open: function() {
		apiTokens.message = null;
		apiTokensTab.$window().html(apiTokensTab.html(null));
		apiTokens.refresh();
	},

	init: function() {
		const t = apiTokensTab;
		const $dialog = $("#dialog-admin");
		if (!$dialog.length || !$("a#admin").length || $("a#admin").css("display") === "none") { return; }
		if (!$dialog.find(".menu li[data-window='" + t.WINDOW + "']").length) {
			$dialog.find(".menu ul").append("<li data-window='" + t.WINDOW + "'><a href='#'>API tokens</a></li>");
			$dialog.find(".window").append("<div data-window='" + t.WINDOW + "' class='hidden'></div>");
		}
		$(document).on("click", "#dialog-admin .menu li", function() {
			if ($(this).attr("data-window") !== t.WINDOW) { return; }
			const $d = $("#dialog-admin");
			if (!$d.hasClass("ui-dialog-content")) { return; }
			$d.closest(".ui-dialog").addClass("ma-admin-active");	// hides the "Total: n" tray, like Admins & members
			// upstream's own menu handler sizes the dialog after this one: wait for it
			setTimeout(function() { $d.dialog("option", "height", Math.min(700, Math.max(350, $(window).height() - 40))); }, 0);
			t.open();
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { apiTokensTab.init(); });
}
