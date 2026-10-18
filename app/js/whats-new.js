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

	// Tooltip for the version top-left of the app (#version, rendered by PHP from the same fork version):
	// "Tripwire fork v1.2.0 · based on upstream Tripwire 1.30b"
	versionTooltip: function(info) {
		const upstream = String((info && info.upstream) || "").trim();
		return "Tripwire fork " + whatsNew.shortVersion(info) + (upstream ? " · based on upstream Tripwire " + upstream : "");
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

	// A new account (created less than NEW_DAYS ago) that has never seen What's New: "new" (mark everything seen silently and
	// let Getting started introduce the app, instead of ~90 NEW entries). "seen": it has What's New state (today's behaviour).
	// "unknown": no What's New state but not known to be new (old account, or the server's answer failed): today's behaviour.
	// serverHadOptions false: the server had no options for this account (init.options empty), so any What's New state in the
	// options came from this browser's copy of another account's (upstream's localStorage fallback): a new account ignores it.
	NEW_DAYS: 14,
	firstRun: function(opts, accountAgeDays, serverHadOptions) {
		const age = typeof accountAgeDays === "number" && isFinite(accountAgeDays) ? accountAgeDays : null;
		const isNew = age !== null && age >= 0 && age < whatsNew.NEW_DAYS;
		if (isNew && serverHadOptions === false) { return "new"; }
		if (opts && opts.whatsNew) { return "seen"; }
		return isNew ? "new" : "unknown";
	},

	// Whether the server sent stored options for this account (the page's init.options); false for an account that never saved any
	serverHadOptions: function(initData) {
		const o = initData && initData.options;
		return !!(o && typeof o === "object" && Object.keys(o).length > 0);
	},

	// The line under an entry's date: a tick when used, "Turned off", and a Try it button. info: {feature, status, canTry}
	actionsHtml: function(info) {
		if (!info || !info.feature) { return ""; }
		const esc = whatsNew.escape;
		const status = info.status === "used" ? "<span class='whats-new-used' title='You have used this'>&#10003; You've used this</span>"
			: info.status === "off" ? "<span class='whats-new-off' title='Turned off in Settings'>Turned off</span>" : "";
		const tryIt = info.canTry && info.feature !== "whatsNew" ? "<button type='button' class='whats-new-try' data-feature='" + esc(info.feature) + "'>"
			+ (info.status === "off" ? "Turn it on" : "Try it") + "</button>" : "";
		return status || tryIt ? "<div class='whats-new-actions'>" + tryIt + status + "</div>" : "";
	},

	// HTML for the given features (all of them, newest first); unseen ones get a NEW badge. infoFor(pr) (optional): the
	// entry's feature, status and whether it can be tried (actionsHtml)
	render: function(features, lastSeenPR, infoFor) {
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
				+ (infoFor ? whatsNew.actionsHtml(infoFor(pr)) : "")
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
		whatsNew.fill();
		$dialog.dialog("open");
		$dialog.scrollTop(0);
	},

	// (Re)write the dialog's content; counts the NEW entries' exposure once the catalog is in
	fill: function() {
		const $dialog = $("#dialog-whatsNew");
		const scroll = $dialog.scrollTop();
		whatsNew.trackExposure();
		$dialog.html(whatsNew.render(whatsNew.features, whatsNew.lastSeenPR(), whatsNew.infoFor())
			+ "<div class='whats-new-version'>" + whatsNew.escape(whatsNew.formatVersion(whatsNew.version)) + "</div>");
		$dialog.find(".whats-new-image img").on("error", function() {
			$(this).closest(".whats-new-image").hide();
		});
		$dialog.scrollTop(scroll);
	},

	// Promise of firstRun(): no waiting when the server's options say What's New was seen before; otherwise the server's
	// account age (feature-usage.js asks fork_events.php once), "unknown" when it fails or takes longer than 5 s
	firstRunKind: function() {
		const opts = typeof options !== "undefined" ? options : null;
		const serverHad = whatsNew.serverHadOptions(typeof init !== "undefined" ? init : null);
		if (serverHad && whatsNew.firstRun(opts, null) === "seen") { return Promise.resolve("seen"); }
		const info = typeof forkUsage !== "undefined" && forkUsage.serverInfo ? forkUsage.serverInfo : Promise.resolve(null);
		let timer = null;
		const timeout = new Promise(function(resolve) { timer = setTimeout(function() { resolve(null); }, 5000); });
		return Promise.race([info, timeout]).then(function(data) {
			clearTimeout(timer);
			return whatsNew.firstRun(opts, data ? data.accountAgeDays : null, serverHad);
		}, function() { clearTimeout(timer); return "unknown"; });
	},

	// Feature, status and Try it of an entry (forkFeatureActions, app/js/fork/feature-actions.js), once its catalog is in
	infoFor: function() {
		if (typeof forkFeatureActions === "undefined" || !forkFeatureActions.catalog()) { return null; }
		return function(pr) {
			const entry = forkFeatureActions.byPR(pr);
			if (!entry) { return null; }
			return { feature: entry.id, status: forkFeatureActions.status(entry.id), canTry: forkFeatureActions.canTry(entry.id) };
		};
	},

	// Opening What's New lists the features of its NEW entries: "wn_listed" for each (a catalog `generic` action: not use, and
	// not "shown", which stays the on-screen exposure of feature-usage.js), once a day
	trackExposure: function() {
		if (typeof forkFeatureActions === "undefined" || typeof forkUsage === "undefined" || !forkFeatureActions.catalog()) { return; }
		const done = {};
		whatsNew.unseen(whatsNew.features, whatsNew.lastSeenPR()).forEach(function(f) {
			const entry = forkFeatureActions.byPR(f.pr);
			if (!entry || done[entry.id]) { return; }
			done[entry.id] = true;
			if (forkUsage.firstTodayStored(entry.id + ".wn_listed")) { forkUsage.track(entry.id, "wn_listed"); }
		});
	},

	// "Try it": close What's New (it is modal), then show the feature
	tryIt: function(feature) {
		if (typeof forkUsage !== "undefined") { forkUsage.track("whatsNew", "tried"); }
		$("#dialog-whatsNew").dialog("close");
		setTimeout(function() {
			const did = typeof forkFeatureActions !== "undefined" ? forkFeatureActions.tryIt(feature) : null;
			if (!did && typeof Notify !== "undefined") { Notify.trigger("Nothing to show for this right now", "yellow"); }
		}, 0);
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

		// Settings > General row
		forkSettings.register({
			section: "general", order: 10, id: "whatsNewShow", type: "custom", label: "What's new:",
			html: "<input type='button' id='whatsNewShow' value='Show' /> <span id='whatsNewVersion' class='whats-new-version-inline'></span>"
		});
		$(document).on("click", "#whatsNewShow", function(e) {
			e.preventDefault();
			whatsNew.open();
		});
		$(document).on("click", "#dialog-whatsNew .whats-new-try", function(e) {
			e.preventDefault();
			whatsNew.tryIt($(this).attr("data-feature"));
		});
		const catalog = typeof forkFeatureActions !== "undefined" ? forkFeatureActions.load() : Promise.resolve(null);

		// Not cached: the file changes with every announced feature, independently of the app version
		$.ajax({
			url: whatsNew.dataURL,
			dataType: "json",
			cache: false
		}).done(function(data) {
			whatsNew.features = (data && Array.isArray(data.features)) ? data.features : [];
			if (whatsNew.latestPR(whatsNew.features) <= whatsNew.lastSeenPR()) { return; }
			whatsNew.firstRunKind().then(function(kind) {
				if (kind === "new") {
					// A new account: no list of every feature so far (Getting started introduces the app instead)
					whatsNew.markSeen();
					return;
				}
				setTimeout(whatsNew.open, 2000);
			});
			// Try it buttons and ticks once the catalog is in (if it came after the dialog opened)
			catalog.then(function(c) { if (c && $("#dialog-whatsNew").dialog("isOpen")) { whatsNew.fill(); } });
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
		// Without version.json (dev stack) fall back to the version PHP rendered
		const $top = $("#version");
		$top.attr("title", whatsNew.versionTooltip(whatsNew.version || {version: $top.text()}));
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { whatsNew.setup(); });
}
