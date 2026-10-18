const featuresHub = {
	// Fork-owned: the Features dialog ("Features you haven't tried"). One row per catalog feature the user can use
	// (public/fork/feature-catalog.json; mask admin features only for mask admins, operator features only for analytics
	// admins): title, Settings section, the first sentence of its newest What's New entry, Used / Not tried / Turned off,
	// and "Show me" (forkFeatureActions.tryIt) / "Settings" (its Settings row). Not tried comes first, from the sections the
	// user already uses most ("near what you already use"), then used, then turned off. Filters: section, stage, status, text.
	// Opened from Ctrl+K (features.open), Settings > General, a link in the What's New dialog's footer and the "See all
	// features" link in the Getting started card (getting-started.js renders it, this file handles the click).
	// No Settings toggle (it only opens when asked) and no tip (Getting started and What's New link to it).
	// Statistics: featuresHub.opened (use; from Ctrl+K it is featuresHub.command instead, counted by forkUsage),
	// .tried (Show me: use), .settings (the Settings button).
	// Keep `const featuresHub` on the first line: the test helper strips it to define a global. Pure logic first.

	DIALOG_ID: "dialog-featuresHub",
	WN_URL: "whats-new/features.json",
	// Not listed: the hub itself, and Getting started (new accounts only, it can't be brought back)
	EXCLUDE: ["featuresHub", "gettingStarted"],
	STAGES: ["first", "core", "intermediate", "admin"],
	STAGE_TITLES: { first: "First steps", core: "Core", intermediate: "Intermediate", admin: "Admin" },
	STATUS_ORDER: { "new": 0, "used": 1, "off": 2 },
	STATUS_TITLES: { "new": "Not tried", "used": "Used", "off": "Turned off" },
	// Section titles when Settings can't say (Mask Admin isn't a Settings section)
	SECTION_TITLES: {
		chain: "Chain Map", markers: "Map Markers", jumps: "Wormhole Jumps & Mass", signatures: "Signatures",
		routes: "Routes & Navigation", jumpPlanner: "Jump Planner", intel: "Kills & Intel", killReporting: "Kill Reporting",
		general: "General", maskAdmin: "Mask Admin"
	},
	MAX_DESC: 200,

	// ---- Pure logic (tested under mocha) ----

	/** The user may see the entry: audience all; maskAdmin for mask admins; operator for analytics admins. who: {maskAdmin, operator} */
	visible: function(entry, who) {
		if (!entry || featuresHub.EXCLUDE.indexOf(entry.id) >= 0) { return false; }
		who = who || {};
		if (entry.audience === "all") { return true; }
		if (entry.audience === "maskAdmin") { return who.maskAdmin === true; }
		if (entry.audience === "operator") { return who.operator === true; }
		return false;
	},

	/** First sentence of the first paragraph of a What's New description, as plain text (cut at MAX_DESC) */
	firstSentence: function(text) {
		const para = String(text === undefined || text === null ? "" : text).split(/\r?\n\s*\r?\n/)
			.map(function(p) { return p.replace(/\s+/g, " ").trim(); }).filter(function(p) { return p.length; })[0] || "";
		// A sentence ends at . ! ? followed by a space and a capital / digit / quote / bracket, or by the end (not "e.g.")
		const m = para.match(/^[\s\S]*?(?<!\b(?:e\.g|i\.e))[.!?](?=\s+["'(\[A-Z0-9]|$)/);
		let s = m ? m[0] : para;
		if (s.length > featuresHub.MAX_DESC) {
			const cut = s.slice(0, featuresHub.MAX_DESC);
			const space = cut.lastIndexOf(" ");
			s = (space > featuresHub.MAX_DESC / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "") + "…";
		}
		return s;
	},

	/** One-line description of the entry: the first sentence of its newest What's New entry (wn: features.json list) */
	describe: function(entry, wn) {
		const prs = entry && Array.isArray(entry.prs) ? entry.prs : [];
		const newest = (wn || []).filter(function(f) { return f && prs.indexOf(parseInt(f.pr, 10)) >= 0; })
			.sort(function(a, b) { return parseInt(b.pr, 10) - parseInt(a.pr, 10); })[0];
		return newest ? featuresHub.firstSentence(newest.description) : "";
	},

	sectionTitle: function(key, lookup) {
		const t = lookup ? lookup(key) : null;
		return t || featuresHub.SECTION_TITLES[key] || key || "";
	},

	/**
	 * Rows for the user, in catalog order. env: {status(id) -> used|off|new, who: {maskAdmin, operator}, wn: features.json list,
	 * sectionTitle(key) -> title | null}
	 * Row: {id, title, section, sectionTitle, stage, description, status, settingsKey, index}
	 */
	rows: function(catalog, env) {
		env = env || {};
		const list = catalog && Array.isArray(catalog.features) ? catalog.features : [];
		return list.map(function(f, i) { return { f: f, i: i }; })
			.filter(function(x) { return x.f && typeof x.f.id === "string" && featuresHub.visible(x.f, env.who); })
			.map(function(x) {
				const status = env.status ? env.status(x.f.id) : "new";
				return {
					id: x.f.id, title: String(x.f.title || x.f.id), section: x.f.section, sectionTitle: featuresHub.sectionTitle(x.f.section, env.sectionTitle),
					stage: x.f.stage, description: featuresHub.describe(x.f, env.wn), status: featuresHub.STATUS_ORDER.hasOwnProperty(status) ? status : "new",
					settingsKey: x.f.settingsKey || null, index: x.i
				};
			});
	},

	/** Used features per section: {section: n} */
	sectionUse: function(rows) {
		const use = {};
		(rows || []).forEach(function(r) { if (r.status === "used") { use[r.section] = (use[r.section] || 0) + 1; } });
		return use;
	},

	/** Default order: not tried, then used, then turned off; within each, sections used most first, then stage, then catalog */
	sort: function(rows) {
		const use = featuresHub.sectionUse(rows);
		const stage = function(s) { const i = featuresHub.STAGES.indexOf(s); return i < 0 ? featuresHub.STAGES.length : i; };
		return (rows || []).slice().sort(function(a, b) {
			return (featuresHub.STATUS_ORDER[a.status] - featuresHub.STATUS_ORDER[b.status])
				|| ((use[b.section] || 0) - (use[a.section] || 0))
				|| (stage(a.stage) - stage(b.stage))
				|| (a.index - b.index);
		});
	},

	/** Rows matching the filters {section, stage, status, text} (empty = any); text matches title, description and section */
	filter: function(rows, f) {
		f = f || {};
		const words = String(f.text || "").toLowerCase().split(/\s+/).filter(function(w) { return w.length; });
		return (rows || []).filter(function(r) {
			if (f.section && r.section !== f.section) { return false; }
			if (f.stage && r.stage !== f.stage) { return false; }
			if (f.status && r.status !== f.status) { return false; }
			if (!words.length) { return true; }
			const hay = (r.title + " " + r.description + " " + r.sectionTitle).toLowerCase();
			return words.every(function(w) { return hay.indexOf(w) >= 0; });
		});
	},

	/** "You've used N of M features" over all the user's rows */
	summary: function(rows) {
		const total = (rows || []).length;
		const used = (rows || []).filter(function(r) { return r.status === "used"; }).length;
		return "You've used " + used + " of " + total + " feature" + (total === 1 ? "" : "s");
	},

	/** Sections that have rows, once each, sorted by title: [{key, title}] */
	sections: function(rows) {
		const seen = {};
		const out = [];
		(rows || []).forEach(function(r) {
			if (seen[r.section]) { return; }
			seen[r.section] = true;
			out.push({ key: r.section, title: r.sectionTitle });
		});
		return out.sort(function(a, b) { return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; });
	},

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** Show me's label: it shows the feature (canTry), turns it on (off), or only tells how (canTell: a short toast) */
	tryLabel: function(status, extra) {
		extra = extra || {};
		if (!extra.canTry && extra.canTell) { return "How?"; }
		return status === "off" ? "Turn on" : "Show me";
	},

	/** A row's markup. extra: {canTry, canTell, hasSetting} */
	rowHtml: function(r, extra) {
		const esc = featuresHub.escape;
		extra = extra || {};
		const tryLabel = featuresHub.tryLabel(r.status, extra);
		const enabled = extra.canTry || extra.canTell;
		return "<li class='fhub-row fhub-" + esc(r.status) + "' data-feature='" + esc(r.id) + "'>"
			+ "<div class='fhub-main'>"
			+ "<div class='fhub-title'><span class='fhub-name'>" + esc(r.title) + "</span>"
			+ " <span class='fhub-section'>" + esc(r.sectionTitle) + "</span></div>"
			+ (r.description ? "<div class='fhub-desc' title='" + esc(r.description) + "'>" + esc(r.description) + "</div>" : "")
			+ "</div>"
			+ "<span class='fhub-badge fhub-badge-" + esc(r.status) + "'>" + esc(featuresHub.STATUS_TITLES[r.status]) + "</span>"
			+ "<span class='fhub-buttons'>"
			+ "<button type='button' class='fhub-try'" + (extra.canTry ? "" : enabled ? " title='Tells you in a few words how to use it'"
				: " disabled title='Nothing to show for this right now'") + ">" + tryLabel + "</button>"
			+ (extra.hasSetting ? "<button type='button' class='fhub-settings' title='Open its row in Settings'>Settings</button>" : "")
			+ "</span></li>";
	},

	// ---- State ----

	state: { section: "", stage: "", status: "", text: "" },
	wn: null,

	// ---- Browser-only code below (not run under mocha) ----

	/** Mask admin (the Mask Admin link is shown, as mask-admin-tab.js checks) and analytics admin (the dashboard's command exists) */
	who: function() {
		const $admin = typeof $ !== "undefined" ? $("a#admin") : null;
		return {
			maskAdmin: !!($admin && $admin.length && $admin.css("display") !== "none"),
			operator: typeof forkFeatureActions !== "undefined" && !!forkFeatureActions.findCommand("analytics.open")
		};
	},

	/** What's New entries: whats-new.js's copy when loaded, else fetched once */
	loadWhatsNew: function() {
		if (typeof whatsNew !== "undefined" && whatsNew.features && whatsNew.features.length) { return Promise.resolve(whatsNew.features); }
		if (featuresHub.wn) { return Promise.resolve(featuresHub.wn); }
		return new Promise(function(resolve) {
			$.ajax({ url: featuresHub.WN_URL, dataType: "json", cache: false })
				.done(function(d) { featuresHub.wn = d && Array.isArray(d.features) ? d.features : []; resolve(featuresHub.wn); })
				.fail(function() { resolve([]); });
		});
	},

	currentRows: function(wn) {
		const fa = forkFeatureActions;
		return featuresHub.sort(featuresHub.rows(fa.catalog(), {
			status: function(id) { return fa.status(id); },
			who: featuresHub.who(),
			wn: wn,
			sectionTitle: function(key) {
				const def = typeof forkSettings !== "undefined" ? forkSettings.sectionDef(key) : null;
				return def && def.title ? def.title : null;
			}
		}));
	},

	/** The Settings row (<tr>) of a feature, or null */
	settingRow: function(id) {
		if (typeof forkFeatureActions === "undefined") { return null; }
		const item = forkFeatureActions.settingItem(forkFeatureActions.byId(id));
		return item ? forkFeatureActions.settingRowEl(item.id) : null;
	},

	ensureDialog: function() {
		let $d = $("#" + featuresHub.DIALOG_ID);
		if ($d.length) { return $d; }
		const esc = featuresHub.escape;
		$d = $("<div id='" + featuresHub.DIALOG_ID + "'></div>").appendTo("body");
		$d.html("<div class='fhub-wrap'>"
			+ "<div class='fhub-filters'>"
			+ "<input type='search' class='fhub-text' placeholder='Filter features...' aria-label='Filter features' />"
			+ "<select class='fhub-f-section' aria-label='Section'><option value=''>All sections</option></select>"
			+ "<select class='fhub-f-stage' aria-label='Stage'><option value=''>Any stage</option>"
			+ featuresHub.STAGES.map(function(s) { return "<option value='" + s + "'>" + esc(featuresHub.STAGE_TITLES[s]) + "</option>"; }).join("") + "</select>"
			+ "<select class='fhub-f-status' aria-label='Status'><option value=''>Any status</option>"
			+ ["new", "used", "off"].map(function(s) { return "<option value='" + s + "'>" + esc(featuresHub.STATUS_TITLES[s]) + "</option>"; }).join("") + "</select>"
			+ "</div>"
			+ "<div class='fhub-summary' aria-live='polite'></div>"
			+ "<ul class='fhub-list'></ul>"
			+ "</div>");
		$d.dialog({
			autoOpen: false,
			title: "Features you haven't tried",
			resizable: false,
			modal: true,
			width: Math.min(640, Math.max(320, $(window).width() - 24)),
			height: Math.max(300, Math.min(640, Math.round($(window).height() * 0.85))),
			dialogClass: "dialog-noeffect ui-dialog-shadow dialog-featuresHub",
			buttons: { Close: function() { $(this).dialog("close"); } }
		});
		$d.on("input", ".fhub-text", function() { featuresHub.state.text = this.value; featuresHub.draw(); });
		$d.on("change", ".fhub-f-section", function() { featuresHub.state.section = this.value; featuresHub.draw(); });
		$d.on("change", ".fhub-f-stage", function() { featuresHub.state.stage = this.value; featuresHub.draw(); });
		$d.on("change", ".fhub-f-status", function() { featuresHub.state.status = this.value; featuresHub.draw(); });
		$d.on("click", ".fhub-try", function(e) { e.preventDefault(); featuresHub.showMe($(this).closest(".fhub-row").attr("data-feature")); });
		$d.on("click", ".fhub-settings", function(e) { e.preventDefault(); featuresHub.openSettings($(this).closest(".fhub-row").attr("data-feature")); });
		return $d;
	},

	/** Open the dialog (closes What's New first: both are modal). fromCommand: Ctrl+K, which forkUsage counts as
	 *  featuresHub.command already; What's New's Try it running that command isn't the user opening it at all */
	open: function(fromCommand) {
		if (typeof forkFeatureActions === "undefined" || typeof $ === "undefined") { return; }
		if (typeof forkUsage !== "undefined" && fromCommand !== true && !forkFeatureActions.isTrying("featuresHub")) { forkUsage.track("featuresHub", "opened"); }
		// Each open starts from the full list (a section or stage picked last time stays)
		featuresHub.state.status = "";
		featuresHub.state.text = "";
		const $wn = $("#dialog-whatsNew");
		if ($wn.length && $wn.hasClass("ui-dialog-content") && $wn.dialog("isOpen")) { $wn.dialog("close"); }
		const $d = featuresHub.ensureDialog();
		$d.find(".fhub-list").html("<li class='fhub-empty'>Loading…</li>");
		$d.dialog("open");
		Promise.all([forkFeatureActions.load(), featuresHub.loadWhatsNew()]).then(function(res) {
			if (!res[0]) { $d.find(".fhub-list").html("<li class='fhub-empty'>Could not load the feature list.</li>"); return; }
			featuresHub.all = featuresHub.currentRows(res[1]);
			featuresHub.all.forEach(featuresHub.addPageState);	// once per open, not on every keystroke
			featuresHub.fillSections();
			featuresHub.draw();
			$d.find(".fhub-list").scrollTop(0);
		});
	},

	all: [],

	fillSections: function() {
		const $sel = $("#" + featuresHub.DIALOG_ID + " .fhub-f-section");
		const sections = featuresHub.sections(featuresHub.all);
		if (featuresHub.state.section && !sections.some(function(s) { return s.key === featuresHub.state.section; })) { featuresHub.state.section = ""; }
		$sel.html("<option value=''>All sections</option>" + sections.map(function(s) {
			return "<option value='" + featuresHub.escape(s.key) + "'>" + featuresHub.escape(s.title) + "</option>";
		}).join(""));
		$sel.val(featuresHub.state.section);
		const $d = $("#" + featuresHub.DIALOG_ID);
		$d.find(".fhub-f-stage").val(featuresHub.state.stage);
		$d.find(".fhub-f-status").val(featuresHub.state.status);
		$d.find(".fhub-text").val(featuresHub.state.text);
	},

	draw: function() {
		const $d = $("#" + featuresHub.DIALOG_ID);
		const shown = featuresHub.filter(featuresHub.all, featuresHub.state);
		const filtered = shown.length !== featuresHub.all.length;
		$d.find(".fhub-summary").text(featuresHub.summary(featuresHub.all) + (filtered ? " · showing " + shown.length : ""));
		$d.find(".fhub-list").html(shown.length ? shown.map(function(r) {
			return featuresHub.rowHtml(r, r.page);
		}).join("") : "<li class='fhub-empty'>No features match.</li>");
	},

	/** What the page offers for a row now: r.page = {canTry, canTell, hasSetting} */
	addPageState: function(r) {
		let canTry = false, canTell = false;
		try { canTry = forkFeatureActions.canTry(r.id); } catch (e) { canTry = false; }
		// Nothing to show on screen: tryIt can still tell how in a toast (the newest What's New text)
		try { canTell = !canTry && typeof forkFeatureActions.howText === "function" && !!forkFeatureActions.howText(forkFeatureActions.byId(r.id)); } catch (e) { canTell = false; }
		r.page = { canTry: canTry, canTell: canTell, hasSetting: !!featuresHub.settingRow(r.id) };
	},

	/** Show me: close the hub, then let the feature show itself. Settings, if the hub sits on it, stays open (it may hold
	 *  unsaved changes). */
	showMe: function(id) {
		if (typeof forkUsage !== "undefined") { forkUsage.track("featuresHub", "tried"); }
		$("#" + featuresHub.DIALOG_ID).dialog("close");
		setTimeout(function() {
			const did = typeof forkFeatureActions !== "undefined" ? forkFeatureActions.tryIt(id) : null;
			if (!did && typeof Notify !== "undefined") { Notify.trigger("Nothing to show for this right now", "yellow"); }
		}, 0);
	},

	openSettings: function(id) {
		const tr = featuresHub.settingRow(id);
		if (!tr || typeof commandPalette === "undefined" || typeof commandPalette.openSetting !== "function") { return; }
		if (typeof forkUsage !== "undefined") { forkUsage.track("featuresHub", "settings"); }
		$("#" + featuresHub.DIALOG_ID).dialog("close");
		commandPalette.openSetting(tr);
	},

	init: function() {
		if (typeof forkCommands !== "undefined") {
			forkCommands.register({
				id: "features.open", title: "Features you haven't tried", group: "App", icon: "info",
				keywords: ["features", "help", "discover", "tips", "what can", "hub"],
				run: function() { featuresHub.open(true); }
			});
		}
		if (typeof forkSettings !== "undefined") {
			forkSettings.register({
				section: "general", order: 11, id: "featuresHubShow", type: "custom", label: "Features:",
				keywords: ["features", "discover", "help", "haven't tried"],
				html: "<input type='button' id='featuresHubShow' value='Features you haven&#39;t tried' />"
			});
		}
		$(document).on("click", "#featuresHubShow", function(e) { e.preventDefault(); featuresHub.open(); });
		// What's New footer: a link next to its Close button
		$(document).on("dialogopen", "#dialog-whatsNew", function() {
			const $pane = $(this).closest(".ui-dialog").find(".ui-dialog-buttonpane");
			if (!$pane.length || $pane.find(".fhub-wn-link").length) { return; }
			$pane.prepend("<a href='#' class='fhub-wn-link'>Features you haven't tried</a>");
		});
		$(document).on("click", ".fhub-wn-link, #gettingStarted .gs-features", function(e) { e.preventDefault(); featuresHub.open(); });
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	jQuery(function() { featuresHub.init(); });
}
