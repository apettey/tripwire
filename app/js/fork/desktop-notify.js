const forkDesktopNotify = {
	// Fork-owned: desktop notifications (the browser's Notification API) for the alerts the fork already raises as in-app
	// pop-ups, so they reach you while Tripwire is in a background tab or you are in the EVE client. Nothing is detected
	// here: each alert source calls forkDesktopNotify.notify({type, title, body, tag, onClick}) with one guarded line next
	// to its own pop-up, with plain text that says no more than that pop-up does.
	//   - Shown only while the tab is hidden (document.hidden), so it never repeats a pop-up you can see; the pop-up still
	//     shows as before.
	//   - `tag` per event, so a repeat replaces the earlier notification instead of stacking.
	//   - Clicking one focuses Tripwire, closes it and runs the pop-up's own action (e.g. show the system).
	//   - The browser asks for permission only from a click: the button in Settings > General, or the tip's button.
	// Settings: options.desktopNotify = {enabled, timer, watchlist, newHole, homeStatic, capRange, rally} (missing = on).
	// Kills keep their existing switch, Settings > Kill Reporting > Desktop alerts (options.killReporting.desktop).
	// Pure logic first (tested), browser code at the bottom. Keep `const forkDesktopNotify` on the first line (test helper).

	// [type, Settings text]; "kill" is switched in Kill Reporting (its own, older setting)
	TYPES: [
		["kill", "Kills in the chain"],
		["timer", "Structure timers (15 minutes before and at the end)"],
		["watchlist", "Watchlist matches on the chain"],
		["newHole", "New holes mapped by someone else (Chain alerts)"],
		["homeStatic", "Home static <1h or EOL (Chain alerts)"],
		["capRange", "New low/null-sec exits in jump range (Chain alerts)"],
		["rally", "Fight here set or moved by someone else"]
	],
	ICON: "images/favicon.png",
	TITLE_MAX: 120,
	BODY_MAX: 300,

	// ---- Pure logic ----

	isType: function(type) {
		return forkDesktopNotify.TYPES.some(function(t) { return t[0] === type; });
	},

	/** options.desktopNotify with the defaults: the master switch and every type on (kill: Kill Reporting's switch) */
	settings: function(opts) {
		const raw = opts && opts.desktopNotify && typeof opts.desktopNotify === "object" ? opts.desktopNotify : {};
		const kr = opts && opts.killReporting && typeof opts.killReporting === "object" ? opts.killReporting : {};
		const out = { enabled: raw.enabled !== false, types: {} };
		forkDesktopNotify.TYPES.forEach(function(t) {
			out.types[t[0]] = t[0] === "kill" ? kr.desktop !== false : raw[t[0]] !== false;
		});
		return out;
	},

	/** What the browser allows: "insecure" (needs HTTPS) | "unsupported" | "default" | "granted" | "denied".
	 *  env: {Notification, isSecureContext} (window in the browser) */
	permission: function(env) {
		if (!env) { return "unsupported"; }
		if (env.isSecureContext === false) { return "insecure"; }
		const N = env.Notification;
		if (!N || typeof N !== "function") { return "unsupported"; }
		return N.permission === "granted" || N.permission === "denied" ? N.permission : "default";
	},

	/** Whether to show a desktop notification for this alert. ctx: {opts, hidden, permission}
	 *  @return {show: bool, reason: "" | "unknown_type" | "off" | "type_off" | "permission" | "visible" | "empty"} */
	decide: function(note, ctx) {
		const no = function(reason) { return { show: false, reason: reason }; };
		if (!note || !forkDesktopNotify.isType(note.type)) { return no("unknown_type"); }
		if (!forkDesktopNotify.plain(note.title, forkDesktopNotify.TITLE_MAX)) { return no("empty"); }
		const s = forkDesktopNotify.settings(ctx && ctx.opts);
		if (!s.enabled) { return no("off"); }
		if (!s.types[note.type]) { return no("type_off"); }
		if (!ctx || ctx.permission !== "granted") { return no("permission"); }
		if (!ctx.hidden) { return no("visible"); }
		return { show: true, reason: "" };
	},

	/** Notification tag for one event: "tripwire-<type>-<key>" (the same event again replaces it) */
	tag: function(type, key) {
		const k = key === undefined || key === null ? "" : String(key).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80);
		return "tripwire-" + String(type || "alert").replace(/[^A-Za-z0-9]/g, "") + (k ? "-" + k : "");
	},

	/** Plain text for a notification: no markup, one line of spaces, at most max characters */
	plain: function(text, max) {
		let s = String(text === undefined || text === null ? "" : text).replace(/<[^>]*>/g, "")
			.replace(/&nbsp;/g, " ").replace(/&middot;/g, "·").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
			.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
			.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
		if (max && s.length > max) { s = s.slice(0, max - 1).replace(/\s+$/, "") + "…"; }
		return s;
	},

	/** The options of `new Notification(title, options)` for an alert */
	payload: function(note) {
		return {
			title: forkDesktopNotify.plain(note.title, forkDesktopNotify.TITLE_MAX),
			options: {
				body: forkDesktopNotify.plain(note.body, forkDesktopNotify.BODY_MAX),
				tag: note.tag || forkDesktopNotify.tag(note.type),
				icon: note.icon || forkDesktopNotify.ICON
			}
		};
	},

	// ---- What each alert source sends (pure: the same words as its in-app pop-up) ----

	/** Chain alerts (chain-alerts.js): kind newHole | homeStatic | capRange is the type; t = its {title, text};
	 *  key: the hole (newHole, homeStatic: a later stage of the same static replaces the earlier one) or the exit */
	chainAlertNote: function(kind, t, key) {
		return { type: kind, title: t && t.title, body: t && t.text, tag: forkDesktopNotify.tag(kind, key) };
	},

	/** Structure timers (structure-timers.js): one tag per timer, so "ended" replaces "in 15 m" */
	timerNote: function(alert, text) {
		const r = alert && alert.row ? alert.row : {};
		return { type: "timer", title: "Structure timer", body: text, tag: forkDesktopNotify.tag("timer", r.id + ":" + r.timerAt) };
	},

	/** Watchlist (watchlist.js): group = {filterID, filterName, systemIDs}; analyse(id) -> {name, systemTypeName} */
	watchlistNote: function(group, analyse) {
		const ids = group && Array.isArray(group.systemIDs) ? group.systemIDs : [];
		const names = ids.slice(0, 6).map(function(id) {
			const s = (typeof analyse === "function" ? analyse(id) : null) || {};
			return (s.name || id) + (s.systemTypeName ? " (" + s.systemTypeName + ")" : "");
		});
		return {
			type: "watchlist", title: "Watchlist: " + (group && group.filterName || ""),
			body: "On the chain: " + names.join(", ") + (ids.length > 6 ? " and " + (ids.length - 6) + " more" : ""),
			tag: forkDesktopNotify.tag("watchlist", group && group.filterID)
		};
	},

	/** Fight here (rally.js) set or moved by someone else: where, the comp, who set it */
	rallyNote: function(where, state) {
		const s = state || {};
		return {
			type: "rally", title: "Fight here: " + where,
			body: [s.comp && s.comp.name ? s.comp.name : "", s.setBy ? "set by " + s.setBy : ""].filter(function(x) { return x; }).join(" · "),
			tag: forkDesktopNotify.tag("rally")
		};
	},

	/** Settings text for a permission state, and whether the Enable button shows */
	stateView: function(permission, enabled) {
		const views = {
			granted: { text: "Allowed: alerts reach your desktop while Tripwire is in the background.", button: false, cls: "ok" },
			denied: { text: "Blocked by the browser. To allow them, click the icon left of the address bar (site settings), set Notifications to Allow, then reload Tripwire.", button: false, cls: "warn" },
			"default": { text: "Not allowed yet: the browser asks once you click the button.", button: true, cls: "" },
			unsupported: { text: "This browser can't show desktop notifications.", button: false, cls: "warn" },
			insecure: { text: "Desktop notifications need Tripwire on HTTPS; this page is on plain HTTP.", button: false, cls: "warn" }
		};
		const v = Object.assign({}, views[permission] || views.unsupported);
		if (!enabled && permission === "granted") { v.text = "Allowed by the browser, but switched off above."; v.cls = ""; }
		return v;
	},

	/** Tip: only while the browser hasn't been asked yet and the alert's desktop switch is on */
	tipEligible: function(opts, permission, type) {
		const s = forkDesktopNotify.settings(opts);
		return permission === "default" && s.enabled && (!type || !forkDesktopNotify.isType(type) || s.types[type] !== false);
	},

	// ---- Browser ----

	env: function() { return typeof window !== "undefined" ? window : null; },
	opts: function() { return typeof options !== "undefined" ? options : null; },
	state: function() { return forkDesktopNotify.permission(forkDesktopNotify.env()); },

	/** Whether an alert of this type would reach the desktop if the tab were hidden (sources that only check while
	 *  visible can keep checking for it) */
	wanted: function(type) {
		return forkDesktopNotify.decide({ type: type, title: "x" }, { opts: forkDesktopNotify.opts(), hidden: true, permission: forkDesktopNotify.state() }).show;
	},

	/** An alert source raised an in-app pop-up. note: {type, title, body, tag, icon, onClick} (plain text); onClick may
	 *  also come as the second argument. Returns the Notification, or null when none was shown. */
	notify: function(note, onClick) {
		if (note && typeof onClick === "function") { note = Object.assign({}, note, { onClick: onClick }); }
		const hidden = typeof document !== "undefined" && !!document.hidden;
		const permission = forkDesktopNotify.state();
		if (!hidden && note && typeof forkHints !== "undefined") { forkHints.emit("alert.shown", { type: note.type }); }
		const d = forkDesktopNotify.decide(note, { opts: forkDesktopNotify.opts(), hidden: hidden, permission: permission });
		if (forkDesktopNotify.debugOn) { console.log("[dn] " + (note && note.type) + ": " + (d.show ? "shown" : "skipped (" + d.reason + ")")); }
		if (!d.show) { return null; }
		const p = forkDesktopNotify.payload(note);
		try {
			const n = new window.Notification(p.title, p.options);
			n.onclick = function() {
				try { window.focus(); } catch (e) { /* not allowed */ }
				n.close();
				if (typeof forkUsage !== "undefined") { forkUsage.track("desktopNotify", "clicked"); }
				if (typeof note.onClick === "function") {
					try { note.onClick(); } catch (e) { console.error("Desktop notification: click action failed", e); }
				}
			};
			if (typeof forkUsage !== "undefined") { forkUsage.track("desktopNotify", "shown"); }
			return n;
		} catch (e) {
			// Chrome on Android only allows them from a service worker: the in-app pop-up is still there
			console.warn("Desktop notification could not be shown", e);
			return null;
		}
	},

	/** Ask the browser for permission. Only ever from a click (Settings button, the tip). done(permission) */
	request: function(done) {
		let answered = false;
		const finish = function(result) {
			if (answered) { return result; }	// a browser may both call back and resolve
			answered = true;
			const p = forkDesktopNotify.state();
			if (p === "granted" && typeof forkUsage !== "undefined") { forkUsage.track("desktopNotify", "granted"); }
			else if (p === "denied" && typeof forkUsage !== "undefined") { forkUsage.track("desktopNotify", "denied"); }
			forkDesktopNotify.refreshRow();
			if (typeof done === "function") { done(p); }
			return result;
		};
		if (forkDesktopNotify.state() !== "default") { finish(); return; }
		try {
			// Older Safari takes a callback and returns nothing
			const r = window.Notification.requestPermission(finish);
			if (r && typeof r.then === "function") { r.then(finish, finish); }
		} catch (e) { finish(); }
	},

	/** The status line and button under the master switch in Settings */
	refreshRow: function() {
		const $state = typeof $ !== "undefined" ? $("#desktopNotify-state") : null;
		if (!$state || !$state.length) { return; }
		const v = forkDesktopNotify.stateView(forkDesktopNotify.state(), $("#desktopNotify-enabled").prop("checked"));
		$state.attr("class", "dn-state" + (v.cls ? " dn-" + v.cls : ""));
		$state.find(".dn-state-text").text(v.text);
		$state.find(".dn-enable").toggle(v.button);
	},

	debugOn: false,
	debug: function(on) { forkDesktopNotify.debugOn = !!on; return forkDesktopNotify.debugOn; },

	init: function() {
		const dn = forkDesktopNotify;
		const esc = typeof forkSettings !== "undefined" ? forkSettings.escape : function(s) { return String(s); };
		$(document).on("click", "#desktopNotify-section .dn-enable", function(e) {
			e.preventDefault();
			dn.request();
		});
		$(document).on("change", "#desktopNotify-enabled", dn.refreshRow);

		if (typeof forkSettings !== "undefined") {
			// Settings > General, right under the pop-up dock's rows: desktop notifications are another way the same
			// pop-ups reach you, and they cover alerts from several sections (kills, timers, chain, Fight here).
			forkSettings.register({
				section: "general", order: 43, id: "desktopNotify", type: "custom", key: "desktopNotify", label: "Desktop notifications:",
				keywords: "desktop notification browser background tab alert permission os toast",
				html: "<div id='desktopNotify-section'>"
					+ "<label><input type='checkbox' id='desktopNotify-enabled' /> Also show alerts on the desktop while Tripwire is in the background</label>"
					+ "<div id='desktopNotify-state' class='dn-state'><span class='dn-state-text'></span> "
					+ "<input type='button' class='dn-enable' value='Enable desktop notifications' /></div></div>",
				load: function(o) {
					$("#desktopNotify-enabled").prop("checked", dn.settings(o).enabled);
					dn.refreshRow();
				},
				save: function(o) {
					o.desktopNotify = Object.assign({}, o.desktopNotify, { enabled: $("#desktopNotify-enabled").prop("checked") });
				}
			});
			// Which alerts; registered after the row above, so its Save runs later and keeps `enabled`
			forkSettings.register({
				section: "general", order: 44, id: "desktopNotify-types", type: "custom", key: "desktopNotify", label: "Desktop alerts for:",
				keywords: "desktop notification kill timer watchlist hole static exit range fight",
				html: "<div class='dn-types'>"
					+ dn.TYPES.map(function(t) {
						if (t[0] === "kill") { return "<div class='dn-type dn-type-note'>" + esc(t[1]) + ": set in Kill Reporting &gt; Desktop alerts</div>"; }
						return "<label class='dn-type'><input type='checkbox' id='desktopNotify-" + t[0] + "' /> " + esc(t[1]) + "</label>";
					}).join("")
					+ "</div>",
				load: function(o) {
					const s = dn.settings(o);
					dn.TYPES.forEach(function(t) { if (t[0] !== "kill") { $("#desktopNotify-" + t[0]).prop("checked", s.types[t[0]]); } });
				},
				save: function(o) {
					const out = Object.assign({}, o.desktopNotify);
					dn.TYPES.forEach(function(t) { if (t[0] !== "kill") { out[t[0]] = $("#desktopNotify-" + t[0]).prop("checked"); } });
					o.desktopNotify = out;
				}
			});
		}

		// Tip: easy to miss (the browser never asks by itself), and only useful once alerts happen. After an in-app alert
		// while the browser hasn't been asked; its button asks (a click, so the browser may).
		if (typeof forkHints !== "undefined") {
			forkHints.register({
				id: "desktopNotify.enable", feature: "desktopNotify", section: "general",
				trigger: "alert.shown", kind: "toast",
				eligible: function(ctx, data) { return dn.tipEligible(ctx.options, dn.state(), data && data.type); },
				title: "Get alerts in the background",
				body: "Kills, timers and chain alerts can also reach your desktop while Tripwire is in another tab or you are in "
					+ "EVE. Click Enable and allow it when the browser asks; choose which alerts in Settings > General > Desktop "
					+ "notifications.\n\nTurn tips off in Settings > General.",
				action: { label: "Enable", run: function() { dn.request(); } },
				priority: 45, maxShows: 2, cooldownHours: 72, ttlSeconds: 600
			});
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined") {
	jQuery(forkDesktopNotify.init);
}
