const whatsNew = {
	// What's New: tells users about features merged into this fork (fork-owned file).
	// Data: public/whats-new/features.json. Seen state: options.whatsNew.lastSeenPR.
	// Keep `const whatsNew` on the first line: the test helper strips it to define a global.
	repoURL: "https://github.com/apettey/tripwire/pull/",
	dataURL: "whats-new/features.json",
	versionURL: "version.json",
	features: [],
	version: null,

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	},

	// "v1.2.0" for a release, otherwise the raw value ("dev" when unknown). info: public/version.json
	shortVersion: function(info) {
		const v = String((info && info.version) || "").trim();
		if (!v) return "dev";
		return /^\d+\.\d+\.\d+/.test(v) ? "v" + v : v;
	},

	// "Tripwire fork v1.2.0 (upstream 1.30b)"
	formatVersion: function(info) {
		const upstream = String((info && info.upstream) || "").trim();
		return "Tripwire fork " + whatsNew.shortVersion(info) + (upstream ? " (upstream " + upstream + ")" : "");
	},

	// Highest PR number in the list, or 0
	latestPR: function(features) {
		return (features || []).reduce(function(max, f) {
			const pr = parseInt(f && f.pr, 10) || 0;
			return pr > max ? pr : max;
		}, 0);
	},

	// Features newer than lastSeenPR, newest first
	unseen: function(features, lastSeenPR) {
		const seen = parseInt(lastSeenPR, 10) || 0;
		return whatsNew.sorted(features).filter(function(f) { return (parseInt(f.pr, 10) || 0) > seen; });
	},

	sorted: function(features) {
		return (features || []).filter(function(f) { return f && f.pr; }).slice().sort(function(a, b) { return b.pr - a.pr; });
	},

	// HTML for the given features (all of them, newest first); unseen ones get a NEW badge
	render: function(features, lastSeenPR) {
		const esc = whatsNew.escape;
		const seen = parseInt(lastSeenPR, 10) || 0;
		const list = whatsNew.sorted(features);

		if (!list.length) {
			return "<p class='whats-new-empty'>Nothing here yet.</p>";
		}

		return list.map(function(f) {
			const pr = parseInt(f.pr, 10);
			const isNew = pr > seen;
			const paragraphs = String(f.description || "").split(/\r?\n\s*\r?\n/).filter(function(p) { return p.trim().length; });
			const images = Array.isArray(f.images) ? f.images : [];

			return "<div class='whats-new-item" + (isNew ? " whats-new-unseen" : "") + "' data-pr='" + pr + "'>"
				+ "<h4 class='whats-new-title'>"
				+ (isNew ? "<span class='whats-new-badge'>NEW</span> " : "")
				+ "<a href='" + esc(whatsNew.repoURL + pr) + "' target='_blank' rel='noopener'>#" + pr + "</a> — " + esc(f.title)
				+ "</h4>"
				+ (f.date ? "<div class='whats-new-date'>" + esc(f.date) + "</div>" : "")
				+ paragraphs.map(function(p) { return "<p class='whats-new-description'>" + esc(p.trim()) + "</p>"; }).join("")
				+ images.filter(function(img) { return img && img.src; }).map(function(img) {
					return "<figure class='whats-new-image'>"
						+ "<a href='" + esc(img.src) + "' target='_blank' rel='noopener'>"
						+ "<img src='" + esc(img.src) + "' alt='" + esc(img.caption || f.title) + "' />"
						+ "</a>"
						+ (img.caption ? "<figcaption>" + esc(img.caption) + "</figcaption>" : "")
						+ "</figure>";
				}).join("")
				+ "</div>";
		}).join("");
	},

	lastSeenPR: function() {
		return (typeof options !== "undefined" && options.whatsNew && parseInt(options.whatsNew.lastSeenPR, 10)) || 0;
	},

	// Open the dialog showing all features; unseen ones (relative to the stored state) are badged NEW
	open: function() {
		const $dialog = $("#dialog-whatsNew");
		$dialog.html(whatsNew.render(whatsNew.features, whatsNew.lastSeenPR())
			+ "<div class='whats-new-version'>" + whatsNew.escape(whatsNew.formatVersion(whatsNew.version)) + "</div>");
		$dialog.find(".whats-new-image img").on("error", function() {
			$(this).closest(".whats-new-image").hide();
		});
		$dialog.dialog("open");
		$dialog.scrollTop(0);
	},

	// Remember that everything currently listed has been seen
	markSeen: function() {
		const latest = whatsNew.latestPR(whatsNew.features);
		if (!latest || typeof options === "undefined" || latest <= whatsNew.lastSeenPR()) return;

		options.whatsNew = {lastSeenPR: latest};
		options.save();
	},

	setup: function() {
		// options.reset() restores built-in defaults and throws on any key that has none (upstream already
		// trips on `userID`, which is undefined so never lands in the defaults snapshot). Keep such keys
		// as they are, which also preserves the What's New seen state (it is not a preference).
		if (typeof options !== "undefined" && options.reset && !options.reset.whatsNewWrapped) {
			const reset = options.reset;
			options.reset = function() {
				const kept = {};
				for (const key of Object.keys(this)) {
					if (typeof this[key] !== "function" && !(key in reset.defaults)) {
						kept[key] = this[key];
						delete this[key];
					}
				}
				const result = reset.apply(this, arguments);
				Object.assign(this, kept);
				return result;
			};
			options.reset.defaults = reset.defaults;
			options.reset.whatsNewWrapped = true;
		}

		$("body").append("<div id='dialog-whatsNew' class='hidden'></div>");
		$("#dialog-whatsNew").dialog({
			autoOpen: false,
			title: "What's New in Tripwire",
			resizable: false,
			modal: true,
			width: 520,
			maxHeight: Math.max(300, Math.round($(window).height() * 0.8)),
			dialogClass: "dialog-noeffect ui-dialog-shadow dialog-whatsNew",
			buttons: {
				Close: function() { $(this).dialog("close"); }
			},
			close: function() { whatsNew.markSeen(); }
		});

		// Settings > General Preferences row
		const $row = $("<tr><th>What's new:</th><td><input type='button' id='whatsNewShow' value='Show' /> <span id='whatsNewVersion' class='whats-new-version-inline'></span></td></tr>");
		$("#dialog-options #optionsAccordion > div").eq(2).find("table.optionsTable").first().append($row);
		if ($("#optionsAccordion").hasClass("ui-accordion")) {
			$("#optionsAccordion").accordion("refresh");
		}
		$(document).on("click", "#whatsNewShow", function(e) {
			e.preventDefault();
			whatsNew.open();
		});

		// Not cached: the file changes with every announced feature, independently of the app version
		$.ajax({
			url: whatsNew.dataURL,
			dataType: "json",
			cache: false
		}).done(function(data) {
			whatsNew.features = (data && Array.isArray(data.features)) ? data.features : [];
			if (whatsNew.latestPR(whatsNew.features) > whatsNew.lastSeenPR()) {
				setTimeout(whatsNew.open, 2000);
			}
		}).fail(function(xhr, status, error) {
			console.warn("What's New: could not load " + whatsNew.dataURL, status, error);
		});

		// Fork version, written into the image at build time; missing in the dev stack ("dev")
		whatsNew.showVersion();
		$.ajax({
			url: whatsNew.versionURL,
			dataType: "json",
			cache: false
		}).done(function(data) {
			whatsNew.version = data;
			whatsNew.showVersion();
		});
	},

	showVersion: function() {
		$("#whatsNewVersion").text("· " + whatsNew.shortVersion(whatsNew.version));
		$("#whatsNewShow, #whatsNewVersion").attr("title", whatsNew.formatVersion(whatsNew.version));
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { whatsNew.setup(); });
}
