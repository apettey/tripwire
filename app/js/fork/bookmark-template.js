const bookmarkTemplate = {
	// Fork-owned: mask-wide bookmark naming templates. The in-game bookmark strings Tripwire copies for you - the one for a
	// hole you just mapped ("=A C5 ABC EOL") and the return bookmark after you jump through it ("!A") - are built from two
	// templates that the mask's admins set in Mask Admin > Bookmark names. Everyone on the mask uses them. The defaults
	// reproduce the strings Tripwire made before templates existed, so nothing changes until an admin edits them.
	// Server side: public/bookmark_template.php, bookmark/bookmark.inc.php (validates again with the same rules: keep the
	// two in step, tests/bookmark_template_test.php and app/js-test/fork/bookmark-template.test.js share the vectors).
	// Keep `const bookmarkTemplate` on the first line: the test helper strips it to define a global.
	URL: "bookmark_template.php",
	REFRESH_AFTER_MS: 300000,
	MAX_OUTPUT: 50,			// characters in a finished bookmark string
	MAX_TEMPLATE: 80,		// characters in a template
	MAX_NAME: 12,			// longest {name} used (the length check assumes it; real names are 1-8)
	KINDS: ["hole", "back"],
	DEFAULTS: { hole: "={name} {class} {sig} {life}", back: "!{name}" },
	KIND_LABELS: {
		hole: "Hole bookmark (copied when you add or save a named hole)",
		back: "Return bookmark (offered after you jump through it; must start with ! or <)"
	},

	/** The tokens a template may use: name, what it is, a sample and the longest value it can take (for the length check) */
	TOKENS: [
		{ token: "name", help: "the hole's name, e.g. AB (the first letters/digits of the Name field)", sample: "AB", worst: "ABCDEFGHIJKL", required: true },
		{ token: "sig", help: "the signature ID letters, e.g. ABC", sample: "ABC", worst: "ABC" },
		{ token: "sigid", help: "the full signature ID when known, e.g. ABC-123 (else the letters)", sample: "ABC-123", worst: "ABC-123" },
		{ token: "type", help: "the wormhole type, e.g. C247 (K162 or empty when unknown)", sample: "C247", worst: "K162" },
		{ token: "class", help: "the class of the system it leads to: C1-C6, HS, LS, NS, Thera ... (empty when ambiguous)", sample: "C5", worst: "Pochven" },
		{ token: "size", help: "the biggest ship that fits: S, M, L, VL or XL (empty when the type is unknown)", sample: "L", worst: "VL" },
		{ token: "life", help: "the hole's life when it is ending: <4h, <1h or EOL (just EOL for any of them if the member turned the life states off in Settings), else empty", sample: "<1h", worst: "EOL" },
		{ token: "system", help: "the system the bookmark is saved in", sample: "J123456", worst: "ABCDEFGHIJKLM" },
		{ token: "dir", help: "out for the hole bookmark, in for the return bookmark", sample: "out", worst: "out" }
	],
	// What a bookmark may contain: letters, digits, spaces and these marks. Tokens are written {name}.
	TEMPLATE_CHARS: /^[A-Za-z0-9 =!<>_.,:;\/|+*()\[\]#@~{}-]*$/,
	VALUE_STRIP: /[^A-Za-z0-9._ -]/g,
	LIFE_STRIP: /[^A-Za-z0-9<]/g,	// {life} may be <4h / <1h

	JUMP_PROMPTS: [
		{ value: "nomatch", label: "Only when no signature matches (default)" },
		{ value: "always", label: "Also when someone already named the hole, until it has a signature ID" },
		{ value: "off", label: "Never" }
	],
	jumpPrompt: "nomatch",

	/** The templates in use (the mask's, once loaded; the defaults before) */
	current: { hole: "={name} {class} {sig} {life}", back: "!{name}" },
	canEdit: false,
	csrf: "",
	loadedAt: 0,

	known: function(token) {
		return bookmarkTemplate.TOKENS.some(function(t) { return t.token === token; });
	},

	/** The tokens written in a template, as typed ("name" for "{name}"; case does not matter) */
	tokensIn: function(template) {
		const found = [];
		String(template === undefined || template === null ? "" : template).replace(/\{([^{}]*)\}/g, function(m, token) { found.push(token.toLowerCase()); return m; });
		return found;
	},

	/** The text of a template with every value in place, not shortened. values: {token: text}; unknown tokens give nothing */
	expand: function(template, values) {
		const t = bookmarkTemplate;
		return String(template === undefined || template === null ? "" : template).replace(/\{([^{}]*)\}/g, function(m, token) {
			const value = values ? values[token.toLowerCase()] : "";
			return t.known(token.toLowerCase()) && value !== undefined && value !== null ? String(value).replace(token.toLowerCase() === "life" ? t.LIFE_STRIP : t.VALUE_STRIP, "") : "";
		}).replace(/\s+/g, " ").trim();
	},

	/** A bookmark string: the template filled in, spaces tidied (an empty token leaves no gap), at most MAX_OUTPUT characters */
	render: function(template, values) {
		const t = bookmarkTemplate;
		let text = t.expand(template, values);
		if (text.length > t.MAX_OUTPUT && values && String(values.name || "").length > t.MAX_NAME) {
			// Only a string that would be too long gets its name shortened (otherwise the output is exactly what the name says)
			text = t.expand(template, Object.assign({}, values, { name: String(values.name).substring(0, t.MAX_NAME) }));
		}
		return text.length > t.MAX_OUTPUT ? text.substring(0, t.MAX_OUTPUT).trim() : text;
	},

	/** Values for the tokens from what the callers know. info: {name, sigID, type, classText, size, life, eol, system, dir}:
		life is the hole's life text ("", "<4h", "<1h", "EOL"; lifeStates.bookmarkLife); without it eol (true = "EOL") */
	values: function(info) {
		info = info || {};
		const clean = function(v) { return String(v === undefined || v === null ? "" : v).trim(); };
		const sigRaw = clean(info.sigID !== undefined ? info.sigID : info.sigAlpha);
		const letters = sigRaw.replace(/[^A-Za-z]/g, "").substring(0, 3).toUpperCase();
		const digits = (/^[A-Za-z]{3}[-\s]?([0-9]{3})/.exec(sigRaw) || [])[1];
		const type = clean(info.type).toUpperCase();
		return {
			name: clean(info.name), sig: letters, sigid: letters && digits ? letters + "-" + digits : letters,
			type: /^[A-Z0-9]{3,4}$/.test(type) ? type : "", "class": clean(info.classText), size: clean(info.size),
			life: info.life !== undefined && info.life !== null ? clean(info.life) : (info.eol ? "EOL" : ""), system: clean(info.system), dir: clean(info.dir)
		};
	},

	sampleValues: function(kind) {
		const out = {};
		bookmarkTemplate.TOKENS.forEach(function(t) { out[t.token] = t.sample; });
		if (kind === "back") { out.dir = "in"; }
		return out;
	},

	/** Why a template can't be used, or "" if it can. kind: "hole" | "back". Rules (the server checks the same): not empty,
		at most MAX_TEMPLATE characters of letters, digits, spaces and = ! < > _ . , : ; / | + * ( ) [ ] # @ ~ -, only known
		{tokens}, {name} in it, a return bookmark starts with ! or < (that is how a name is told from a return bookmark), and
		with the longest values the result is at most MAX_OUTPUT characters. */
	validate: function(kind, template) {
		const t = bookmarkTemplate;
		if (t.KINDS.indexOf(kind) < 0) { return "Unknown template"; }
		if (typeof template !== "string" || template.trim() === "") { return "The template is empty"; }
		if (template.length > t.MAX_TEMPLATE) { return "The template can be at most " + t.MAX_TEMPLATE + " characters"; }
		if (!t.TEMPLATE_CHARS.test(template)) { return "Only letters, digits, spaces and = ! < > _ . , : ; / | + * ( ) [ ] # @ ~ - are allowed"; }
		if (template.replace(/\{[^{}]*\}/g, "").match(/[{}]/)) { return "Unbalanced { } - write tokens like {name}"; }
		const tokens = t.tokensIn(template);
		for (let i = 0; i < tokens.length; i++) {
			if (!t.known(tokens[i])) { return "Unknown token {" + tokens[i] + "}"; }
		}
		if (tokens.indexOf("name") < 0) { return "The template needs {name}"; }
		const first = template.trim().charAt(0);
		if (kind === "back" && "!<".indexOf(first) < 0) { return "A return bookmark has to start with ! or <"; }
		if (kind === "hole" && "!<".indexOf(first) >= 0) { return "A hole bookmark can't start with ! or < (that marks a return bookmark)"; }
		const worst = {};
		t.TOKENS.forEach(function(tok) { worst[tok.token] = tok.worst; });
		if (t.expand(template, worst).length > t.MAX_OUTPUT) { return "Too long: with the longest values it would be over " + t.MAX_OUTPUT + " characters"; }
		return "";
	},

	/** The template to use for a kind: the mask's if it is valid, else the default */
	active: function(kind) {
		const t = bookmarkTemplate;
		const own = t.current && t.current[kind];
		return typeof own === "string" && !t.validate(kind, own) ? own : t.DEFAULTS[kind];
	},

	/** The mask-wide mode of the "Which signature did you jump through?" prompt (app/js/fork/jump-sig-prompt.js): a bad or
		missing value is the default, "nomatch" */
	jumpPromptMode: function(value) {
		return bookmarkTemplate.JUMP_PROMPTS.some(function(m) { return m.value === value; }) ? value : "nomatch";
	},

	/** Take the templates of a server answer ({templates: {hole, back}, jumpPrompt}); bad or missing ones fall back to the defaults */
	use: function(templates, jumpPrompt) {
		const t = bookmarkTemplate;
		t.jumpPrompt = t.jumpPromptMode(jumpPrompt);
		t.current = {};
		t.KINDS.forEach(function(kind) {
			const own = templates && templates[kind];
			t.current[kind] = typeof own === "string" && !t.validate(kind, own) ? own : t.DEFAULTS[kind];
		});
	},

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** Mask Admin > Bookmark names (state: public/bookmark_template.php's answer) */
	pageHtml: function(state) {
		const t = bookmarkTemplate;
		const esc = t.escape;
		const edit = !!(state && state.canEdit);
		const rows = t.KINDS.map(function(kind) {
			const value = (state && state.templates && state.templates[kind]) || t.DEFAULTS[kind];
			return "<div class='bt-row' data-kind='" + kind + "'><label>" + esc(t.KIND_LABELS[kind]) + "</label>"
				+ "<input type='text' class='bt-input' maxlength='" + t.MAX_TEMPLATE + "' spellcheck='false' value='" + esc(value) + "'" + (edit ? "" : " readonly") + " />"
				+ "<div class='bt-preview'><span class='bt-dim'>Example:</span> <code class='bt-out'></code></div><div class='bt-error'></div></div>";
		}).join("");
		const tokens = t.TOKENS.map(function(tok) {
			return "<tr><td><code>{" + tok.token + "}</code></td><td>" + esc(tok.help) + "</td><td><code>" + esc(tok.sample) + "</code></td></tr>";
		}).join("");
		const mode = t.jumpPromptMode(state && state.jumpPrompt);
		const prompt = "<h3>After a jump</h3><p class='bt-dim'>When someone jumps through a wormhole the automapper can't tie to a signature, Tripwire can ask which signature they went through "
			+ "(a small pop-up listing the unlinked wormhole signatures; jumping is never blocked and everyone can hide it in Settings). Best practice is still to set the hole before jumping.</p>"
			+ "<div class='bt-row'><label>Ask which signature was used</label><select class='bt-jump-prompt'" + (edit ? "" : " disabled") + ">"
			+ t.JUMP_PROMPTS.map(function(m) { return "<option value='" + m.value + "'" + (m.value === mode ? " selected" : "") + ">" + esc(m.label) + "</option>"; }).join("")
			+ "</select></div>";
		const info = state && state.updatedBy ? "Last changed by " + esc(state.updatedBy) + ", " + esc(String(state.updatedAt || "").slice(0, 16)) + "." : "Using Tripwire's built-in names.";
		return "<div class='bt-message'></div><h3>Bookmark names</h3>"
			+ "<p class='bt-dim'>Everyone on this mask gets these bookmark strings when a hole is added or saved and after jumping through it. "
			+ "An empty token leaves no gap. At most " + t.MAX_OUTPUT + " characters. " + (edit ? "" : "Only the mask's owner and the owning corporation's Tripwire admins can change them.") + "</p>"
			+ rows + prompt
			+ (edit ? "<div class='bt-buttons'><button type='button' class='bt-save'>Save</button> <button type='button' class='bt-default'>Use the built-in names</button></div>" : "")
			+ "<p class='bt-dim'>" + info + "</p>"
			+ "<h3>Tokens</h3><table class='bt-table'><thead><tr><th>Token</th><th>Is replaced by</th><th>Example</th></tr></thead><tbody>" + tokens + "</tbody></table>";
	},

	// ---- browser ----

	errorText: function(xhr) {
		return (xhr && xhr.responseJSON && xhr.responseJSON.error) || "Request failed" + (xhr && xhr.status ? " (HTTP " + xhr.status + ")" : "");
	},

	/** Fetch the mask's templates; the answer also says whether this member may edit them */
	load: function() {
		const t = bookmarkTemplate;
		return $.ajax({ url: t.URL, type: "GET", data: { mode: "get" }, dataType: "JSON", cache: false }).done(function(data) {
			t.state = data;
			t.csrf = data.csrf || t.csrf;
			t.canEdit = !!data.canEdit;
			t.loadedAt = Date.now();
			t.use(data.templates, data.jumpPrompt);
		}).fail(function(xhr) {
			t.loadFailed = true;
			console.warn("bookmark-template: could not load the mask's templates, using the built-in names", t.errorText(xhr));
		});
	},

	/** Make sure the mask's templates have been read at least once (used before the first copy: Add/Save dialog opening, a jump).
		Starts a load when none succeeded yet; the answer applies to the next copy. */
	ensureLoaded: function() {
		const t = bookmarkTemplate;
		if (t.loadedAt === 0 && !t.loading) {
			t.loading = true;
			t.load().always(function() { t.loading = false; });
		}
	},

	request: function(mode, data) {
		const t = bookmarkTemplate;
		return $.ajax({
			url: t.URL, type: "POST", contentType: "application/json", dataType: "JSON",
			data: JSON.stringify(Object.assign({ mode: mode }, data || {})),
			headers: { "X-CSRF-Token": t.csrf, "X-Requested-With": "XMLHttpRequest" }
		}).done(function(answer) {
			t.state = answer;
			t.csrf = answer.csrf || t.csrf;
			t.use(answer.templates, answer.jumpPrompt);
		});
	},

	$window: function() { return $("#dialog-admin .window [data-window='bookmarks']"); },

	message: function(text, bad) {
		bookmarkTemplate.$window().find(".bt-message").removeClass("bt-good bt-bad").addClass(bad ? "bt-bad" : "bt-good").text(text || "");
	},

	/** Live example and error under each input */
	refreshPreview: function() {
		const t = bookmarkTemplate;
		let ok = true;
		t.$window().find(".bt-row[data-kind]").each(function() {
			const kind = $(this).attr("data-kind");
			const value = $(this).find(".bt-input").val();
			const error = t.validate(kind, value);
			ok = ok && !error;
			$(this).find(".bt-error").text(error);
			$(this).find(".bt-out").text(error ? "" : t.render(value, t.sampleValues(kind)));
		});
		t.$window().find(".bt-save").prop("disabled", !ok);
		return ok;
	},

	render_: function() {
		bookmarkTemplate.$window().html(bookmarkTemplate.pageHtml(bookmarkTemplate.state));
		bookmarkTemplate.refreshPreview();
	},

	bind: function() {
		const t = bookmarkTemplate;
		const sel = "#dialog-admin .window [data-window='bookmarks']";
		const $doc = $(document);
		$doc.on("input", sel + " .bt-input", function() { t.refreshPreview(); });
		$doc.on("click", sel + " .bt-save", function() {
			if (!t.refreshPreview()) { return; }
			const body = {};
			t.$window().find(".bt-row[data-kind]").each(function() { body[$(this).attr("data-kind")] = $(this).find(".bt-input").val().trim(); });
			body.jumpPrompt = t.$window().find(".bt-jump-prompt").val();
			t.request("save", body).done(function() { t.render_(); t.message("Saved. Members get it the next time their page loads.", false); })
				.fail(function(xhr) { t.message(t.errorText(xhr), true); });
		});
		$doc.on("click", sel + " .bt-default", function() {
			if (!window.confirm("Go back to Tripwire's built-in bookmark names for everyone on this mask?")) { return; }
			t.request("reset", {}).done(function() { t.render_(); t.message("Back to the built-in names.", false); })
				.fail(function(xhr) { t.message(t.errorText(xhr), true); });
		});
	},

	init: function() {
		const t = bookmarkTemplate;
		// Everyone on the mask reads the templates (and re-reads them when the tab comes back after a while)
		t.load();
		document.addEventListener("visibilitychange", function() {
			if (!document.hidden && Date.now() - t.loadedAt > t.REFRESH_AFTER_MS) { t.load(); }
		});
		const $dialog = $("#dialog-admin");
		if (!$dialog.length || !$("#admin").length || $("#admin").css("display") === "none") { return; }
		if (!$dialog.find(".menu li[data-window='bookmarks']").length) {
			$dialog.find(".menu ul").append("<li data-window='bookmarks'><a href='#'>Bookmarks</a></li>");
			$dialog.find(".window").append("<div data-window='bookmarks' class='hidden'></div>");
		}
		t.bind();
		$(document).on("click", "#dialog-admin .menu li", function() {
			const mine = $(this).attr("data-window") === "bookmarks";
			const $d = $("#dialog-admin");
			if (!$d.hasClass("ui-dialog-content")) { return; }
			$d.closest(".ui-dialog").toggleClass("bt-admin-active", mine);	// hides the "Total: n" tray
			if (mine) {
				$d.dialog("option", "height", Math.min(620, Math.max(350, $(window).height() - 40)));
				t.$window().html("<p class='bt-dim'>Loading...</p>");
				t.load().done(function() { t.render_(); }).fail(function(xhr) { t.$window().html("<p class='bt-bad'>" + t.escape(t.errorText(xhr)) + "</p>"); });
			}
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { bookmarkTemplate.init(); });
}
