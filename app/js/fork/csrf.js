// Fork-owned: sends this session's CSRF token (csrf.inc.php, printed by tripwire.php in <meta name="csrf-token">)
// as the X-CSRF-Token header on same-origin jQuery requests that aren't GET/HEAD. options.php and masks.php refuse
// changes without it. Requests that already set X-CSRF-Token (fork endpoints with their own token) keep theirs.
var forkCsrf = {
	token: function(doc) {
		const meta = doc && doc.querySelector ? doc.querySelector('meta[name="csrf-token"]') : null;
		return meta ? meta.getAttribute("content") || "" : "";
	},

	// The header value to add to a request, or null.
	headerFor: function(options, token) {
		if (!token || !options || options.crossDomain) return null;
		const type = String(options.type || options.method || "GET").toUpperCase();
		if (type === "GET" || type === "HEAD") return null;
		const headers = options.headers || {};
		for (const name in headers) {
			if (name.toLowerCase() === "x-csrf-token") return null;
		}
		return token;
	},

	install: function($, doc) {
		if (forkCsrf.installed === $) return;
		forkCsrf.installed = $;
		$.ajaxPrefilter(function(options, originalOptions, jqXHR) {
			const value = forkCsrf.headerFor(options, forkCsrf.token(doc));
			if (value) jqXHR.setRequestHeader("X-CSRF-Token", value);
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.ajaxPrefilter) {
	forkCsrf.install(jQuery, document);
}
