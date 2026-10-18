const forkUsage = {
	// Fork-owned: which fork features someone uses (docker/README.md#product-analytics). Two jobs:
	// 1. Local "used" state, options.usage = {featureId: {first, last, n}} (minutes since 1970, UTC), so later features (tips,
	//    the features hub) never re-teach something the user already uses. Kept even with statistics turned off: it is the
	//    user's own options and nothing is sent.
	// 2. Usage statistics: counters {feature.action: n} sent to this server (public/fork_events.php) every 60 s and when the
	//    tab is hidden, unless the server has them off (ANALYTICS_ENABLED) or the user turned them off in Settings > General
	//    (options.usageStats.enabled === false; missing = on). No third party, no system/signature/character data: only ids
	//    from public/fork/feature-catalog.json and short action words.
	//
	// API:  forkUsage.track(featureId, action)    action: [a-z_]{1,24}, "command" / "opened" / "shown" / a `use` word of the
	//                                              feature in the catalog... (unknown ids or actions are dropped with a warning)
	//       forkUsage.used(featureId) -> bool      has the user ever used it (a use action, see isUse)
	//       forkUsage.on(fn) -> off()              fn(featureId, action) after every accepted track (e.g. tips)
	//       forkUsage.debug(true|false)            log every event as "[usage] feature.action" and send at once (localStorage)
	//       <button data-track="<id>.<action>">  a click on it tracks that (explicit attributes only)
	// Explicit: each feature calls forkUsage.track("<id>", "<use word>") where it is really used (a menu choice, a button,
	// a dialog save, a paste...): menus and buttons don't go through forkCommands. app/js-test/fork/feature-catalog.test.js
	// checks every catalog `use` word has such a call.
	// Automatic (no code in the feature): Ctrl+K palette commands (catalog `commands`) that succeeded -> "command"; panels
	// added by the user or switched to a shown mode (catalog `panels`) -> "opened"; Settings Save -> "setting_on" / "setting_off" /
	// "setting_changed" for a feature's settingsKey; once a minute while the tab is visible, a catalog `exposed` selector or
	// panel on screen -> "shown" (once a day); the first send of a UTC day -> "disabled" for each feature turned off;
	// "app.active" at most every 5 minutes on real keyboard/mouse input while visible (polling never counts).
	// Keep `const forkUsage` on the first line: the test helper strips it to define a global. Pure logic first.

	URL: "fork_events.php",
	CATALOG_URL: "fork/feature-catalog.json",
	FLUSH_MS: 60000,
	DEBUG_FLUSH_MS: 2500,
	EXPOSURE_MS: 60000,
	ACTIVE_MS: 5 * 60000,
	USER_ACTION_MS: 3000,		// a panel added within this long of real input was opened by the user (not by page load)
	USED_SAVE_MINUTES: 60,		// a repeat use saves options at most this often (the first use saves at once)
	MAX_ENTRIES: 50,			// per request (the server takes no more)
	MAX_BYTES: 8192,
	MAX_KEYS: 300,				// distinct counters waiting to be sent
	MAX_QUEUE: 200,				// events tracked before the catalog has loaded
	MAX_COUNT: 1000,
	ACTION_RE: /^[a-z_]{1,24}$/,
	GENERIC: ["command", "opened", "shown", "disabled", "setting_on", "setting_off", "setting_changed"],
	USE: ["command", "opened"],
	INTERNAL: { app: ["active"] },
	DEBUG_KEY: "forkUsage.debug",
	SEEN_KEY: "forkUsage.seen",

	// ---- Pure logic (tested under mocha) ----

	/** Lookups from the catalog: {features: {id: {entry, actions: {a: true}, use: {a: true}}}, commands: {id: feature},
	 *  panels: {id: feature}} */
	buildIndex: function(catalog) {
		const index = { features: {}, commands: {}, panels: {} };
		const list = catalog && Array.isArray(catalog.features) ? catalog.features : [];
		const generic = catalog && Array.isArray(catalog.generic) ? catalog.generic : [];
		list.forEach(function(f) {
			if (!f || typeof f.id !== "string") { return; }
			const use = {};
			forkUsage.USE.concat(Array.isArray(f.use) ? f.use : []).forEach(function(a) { if (forkUsage.ACTION_RE.test(a)) { use[a] = true; } });
			const actions = Object.assign({}, use);
			// Allowed but not use: the generic actions, the catalog's `generic` list (every feature, e.g. a tip's hint_shown)
			// and the feature's own `events`
			forkUsage.GENERIC.concat(generic, Array.isArray(f.events) ? f.events : []).forEach(function(a) {
				if (typeof a === "string" && forkUsage.ACTION_RE.test(a)) { actions[a] = true; }
			});
			index.features[f.id] = { entry: f, actions: actions, use: use };
			(f.commands || []).forEach(function(c) { index.commands[c] = f.id; });
			(f.panels || []).forEach(function(p) { index.panels[p] = f.id; });
		});
		(catalog && Array.isArray(catalog.internal) ? catalog.internal : []).forEach(function(id) {
			const own = forkUsage.INTERNAL[id];
			if (!own) { return; }
			const actions = {};
			own.forEach(function(a) { actions[a] = true; });
			index.features[id] = { entry: { id: id, internal: true }, actions: actions, use: {} };
		});
		return index;
	},

	/** Whether the server would take this feature + action */
	allowed: function(index, feature, action) {
		const f = index && index.features && Object.prototype.hasOwnProperty.call(index.features, feature) ? index.features[feature] : null;
		return !!f && typeof action === "string" && forkUsage.ACTION_RE.test(action) && f.actions[action] === true;
	},

	/** Whether the action means the feature was used (vs. seen, switched off, ...) */
	isUse: function(index, feature, action) {
		return forkUsage.allowed(index, feature, action) && index.features[feature].use[action] === true;
	},

	/** Count one event in the pending map {"feature.action": n}. False when the map is full (a new key is dropped). */
	add: function(pending, feature, action, n, maxKeys) {
		const key = feature + "." + action;
		if (!Object.prototype.hasOwnProperty.call(pending, key) && Object.keys(pending).length >= (maxKeys || forkUsage.MAX_KEYS)) { return false; }
		pending[key] = Math.min(forkUsage.MAX_COUNT, (pending[key] || 0) + Math.max(1, n || 1));
		return true;
	},

	/** Request bodies for the pending counters: each {"t": token, "e": [{f, a, n}]} with at most maxEntries entries and
	 *  maxBytes bytes (an entry that can't fit even alone is dropped) */
	batches: function(pending, token, maxEntries, maxBytes) {
		maxEntries = maxEntries || forkUsage.MAX_ENTRIES;
		maxBytes = maxBytes || forkUsage.MAX_BYTES;
		const body = function(entries) { return JSON.stringify({ t: token, e: entries }); };
		const out = [];
		let current = [];
		Object.keys(pending).sort().forEach(function(key) {
			const dot = key.indexOf(".");
			const entry = { f: key.slice(0, dot), a: key.slice(dot + 1), n: pending[key] };
			if (body([entry]).length > maxBytes) { return; }
			if (current.length >= maxEntries || body(current.concat([entry])).length > maxBytes) {
				out.push(body(current));
				current = [];
			}
			current.push(entry);
		});
		if (current.length) { out.push(body(current)); }
		return out;
	},

	/** Minutes since 1970 (UTC) */
	minute: function(ms) {
		return Math.floor(ms / 60000);
	},

	/** "YYYY-MM-DD" (UTC) */
	day: function(ms) {
		return new Date(ms).toISOString().slice(0, 10);
	},

	/** Record a use in the used-state map (mutates and returns it). Returns {usage, changed: true when it should be saved} */
	markUsed: function(usage, feature, minute, saveEvery) {
		usage = usage && typeof usage === "object" ? usage : {};
		const u = usage[feature];
		if (!u || typeof u !== "object") {
			usage[feature] = { first: minute, last: minute, n: 1 };
			return { usage: usage, changed: true };
		}
		const changed = !(minute - (u.last || 0) < (saveEvery || forkUsage.USED_SAVE_MINUTES));
		u.first = u.first || minute;
		u.last = minute;
		u.n = (u.n || 0) + 1;
		return { usage: usage, changed: changed };
	},

	wasUsed: function(usage, feature) {
		return !!(usage && typeof usage === "object" && Object.prototype.hasOwnProperty.call(usage, feature) && usage[feature] && usage[feature].n > 0);
	},

	/** Usage statistics on for this user (missing = on) */
	statsOn: function(opts) {
		return !(opts && opts.usageStats && opts.usageStats.enabled === false);
	},

	/** A feature's toggle is off: options[key].enabled === false (missing = on) */
	isOff: function(opts, key) {
		return !!(key && opts && opts[key] && typeof opts[key] === "object" && opts[key].enabled === false);
	},

	/**
	 * The settings of every feature with a settingsKey: {id: {off, json}}. `json`: what the feature's checkbox / select rows
	 * show for these options (their get(options), which fills in the defaults), so a Save that only writes the defaults of
	 * a missing key is no change. rows: forkSettings.items (custom rows are left out: only their on/off is compared).
	 */
	settingState: function(opts, index, rows) {
		const out = {};
		Object.keys(index.features).forEach(function(id) {
			const key = index.features[id].entry.settingsKey;
			if (!key) { return; }
			const values = (rows || []).filter(function(r) { return r.key === key && r.type !== "custom" && typeof r.get === "function"; })
				.map(function(r) { try { return r.get(opts); } catch (e) { return null; } });
			let json;
			try { json = JSON.stringify(values); } catch (e) { json = ""; }
			out[id] = { off: forkUsage.isOff(opts, key), json: json };
		});
		return out;
	},

	/** What a Settings Save changed: [[featureId, "setting_on" | "setting_off" | "setting_changed"]] */
	settingChanges: function(before, after) {
		const out = [];
		Object.keys(after).forEach(function(id) {
			const b = before[id], a = after[id];
			if (!b) { return; }
			if (b.off !== a.off) { out.push([id, a.off ? "setting_off" : "setting_on"]); }
			else if (b.json !== a.json) { out.push([id, "setting_changed"]); }
		});
		return out;
	},

	/** Ids of the features whose toggle is off */
	disabledIds: function(opts, index) {
		return Object.keys(index.features).filter(function(id) { return forkUsage.isOff(opts, index.features[id].entry.settingsKey); });
	},

	/** True the first time `key` is seen on `day` (mutates seen: {key: day}; entries of other days are dropped) */
	firstToday: function(seen, key, day) {
		Object.keys(seen).forEach(function(k) { if (seen[k] !== day) { delete seen[k]; } });
		if (seen[key] === day) { return false; }
		seen[key] = day;
		return true;
	},

	/** "feature.action" of a data-track attribute, or null */
	parseTrack: function(value) {
		const m = /^([a-z][A-Za-z0-9]{1,39})\.([a-z_]{1,24})$/.exec(String(value || ""));
		return m ? { feature: m[1], action: m[2] } : null;
	},

	// ---- State ----

	index: null,			// buildIndex(catalog) once loaded
	serverKnown: false,		// the mode=get answer (or its failure) is in
	queue: [],				// [feature, action] tracked before both arrived
	pending: {},			// counters waiting to be sent
	listeners: [],
	server: { enabled: false, token: "", key: "" },
	serverInfo: null,		// Promise of the mode=get answer {enabled, token, key, accountAgeDays}, null when it failed (What's New, Getting started)
	seen: null,				// {key: day}: shown / snapshot once a day (localStorage, per account: seenFor)
	seenFor: "",
	lastActive: 0,
	lastInput: 0,
	flushTimer: null,
	debugOn: false,

	opts: function() {
		return typeof options !== "undefined" && options ? options : null;
	},

	// ---- API ----

	track: function(feature, action) {
		if (!forkUsage.index || !forkUsage.serverKnown) {
			if (forkUsage.queue.length < forkUsage.MAX_QUEUE) { forkUsage.queue.push([feature, action]); }
			return;
		}
		if (!forkUsage.allowed(forkUsage.index, feature, action)) {
			console.warn("forkUsage.track: unknown feature or action " + feature + "." + action + " (public/fork/feature-catalog.json)");
			return;
		}
		// "Try it" / "Show me" running the feature (its command, panel, own open code) is not the user using it
		if (forkUsage.isUse(forkUsage.index, feature, action) && forkUsage.fromTry(feature)) {
			if (forkUsage.debugOn) { console.log("[usage] " + feature + "." + action + " (not counted: Try it)"); }
			return;
		}
		const now = Date.now();
		const opts = forkUsage.opts();
		if (opts && forkUsage.isUse(forkUsage.index, feature, action)) {
			const r = forkUsage.markUsed(opts.usage, feature, forkUsage.minute(now));
			opts.usage = r.usage;
			if (r.changed && typeof opts.saveDelay === "function") { opts.saveDelay(2000); }
		}
		const sending = forkUsage.sending();
		if (sending) { forkUsage.add(forkUsage.pending, feature, action, 1); }
		if (forkUsage.debugOn) {
			console.log("[usage] " + feature + "." + action + (sending ? "" : " (not sent: " + (forkUsage.server.enabled ? "statistics turned off" : "server collects none") + ")"));
			if (sending) { forkUsage.flushSoon(); }
		}
		forkUsage.listeners.slice().forEach(function(fn) {
			try { fn(feature, action); } catch (e) { console.error("forkUsage listener failed", e); }
		});
	},

	used: function(feature) {
		const opts = forkUsage.opts();
		return forkUsage.wasUsed(opts && opts.usage, feature);
	},

	on: function(fn) {
		if (typeof fn !== "function") { throw new Error("forkUsage.on: function required"); }
		forkUsage.listeners.push(fn);
		return function() { forkUsage.listeners = forkUsage.listeners.filter(function(f) { return f !== fn; }); };
	},

	debug: function(on) {
		if (on === undefined) { return forkUsage.debugOn; }
		forkUsage.debugOn = !!on;
		try {
			if (forkUsage.debugOn) { localStorage.setItem(forkUsage.DEBUG_KEY, "1"); } else { localStorage.removeItem(forkUsage.DEBUG_KEY); }
		} catch (e) { /* storage unavailable: this page only */ }
		console.log("[usage] debug " + (forkUsage.debugOn ? "on: events are logged and sent at once" : "off"));
		if (forkUsage.debugOn) { forkUsage.flushSoon(); }
		return forkUsage.debugOn;
	},

	/** Whether counters are collected now: the server takes them and the user hasn't turned them off */
	sending: function() {
		return forkUsage.server.enabled && !!forkUsage.server.token && forkUsage.statsOn(forkUsage.opts());
	},

	// ---- Browser-only code below (not run under mocha) ----

	/** localStorage key of the once-a-day marks: per account (an opaque key from fork_events.php), so two accounts in
	 *  one browser each get their own `shown` and snapshot */
	seenStorageKey: function() {
		return forkUsage.SEEN_KEY + "." + (forkUsage.server.key || "anon");
	},

	loadSeen: function() {
		const storageKey = forkUsage.seenStorageKey();
		if (forkUsage.seen && forkUsage.seenFor === storageKey) { return forkUsage.seen; }
		let seen = {};
		try { seen = JSON.parse(localStorage.getItem(storageKey) || "{}") || {}; } catch (e) { seen = {}; }
		forkUsage.seen = seen && typeof seen === "object" ? seen : {};
		forkUsage.seenFor = storageKey;
		return forkUsage.seen;
	},

	firstTodayStored: function(key) {
		const seen = forkUsage.loadSeen();
		const first = forkUsage.firstToday(seen, key, forkUsage.day(Date.now()));
		if (first) { try { localStorage.setItem(forkUsage.seenFor, JSON.stringify(seen)); } catch (e) { /* this page only */ } }
		return first;
	},

	visible: function() {
		return typeof document === "undefined" || document.visibilityState !== "hidden";
	},

	/** Send the pending counters. beacon: the page is going away (sendBeacon, which survives unload) */
	flush: function(beacon) {
		if (!forkUsage.sending()) { forkUsage.pending = {}; return; }
		if (forkUsage.index && forkUsage.firstTodayStored("~snapshot")) {
			forkUsage.disabledIds(forkUsage.opts(), forkUsage.index).forEach(function(id) {
				forkUsage.add(forkUsage.pending, id, "disabled", 1);
				if (forkUsage.debugOn) { console.log("[usage] " + id + ".disabled (daily snapshot)"); }
			});
		}
		const bodies = forkUsage.batches(forkUsage.pending, forkUsage.server.token);
		forkUsage.pending = {};
		bodies.forEach(function(body) {
			let sent = false;
			if (beacon && navigator.sendBeacon) {
				try { sent = navigator.sendBeacon(forkUsage.URL, new Blob([body], { type: "text/plain" })); } catch (e) { sent = false; }
			}
			if (!sent && typeof fetch === "function") {
				fetch(forkUsage.URL, { method: "POST", body: body, keepalive: true, credentials: "same-origin", headers: { "Content-Type": "text/plain" } })
					.catch(function() { /* statistics are best effort */ });
			}
		});
	},

	flushSoon: function() {
		if (forkUsage.flushTimer) { return; }
		// Debug sends "at once", batched over DEBUG_FLUSH_MS: well under the server's limit of requests a minute
		forkUsage.flushTimer = setTimeout(function() { forkUsage.flushTimer = null; forkUsage.flush(false); }, forkUsage.DEBUG_FLUSH_MS);
	},

	/** Once a minute while visible: catalog `exposed` selectors and panels on screen -> "shown" once a day */
	checkExposure: function() {
		if (!forkUsage.index || !forkUsage.serverKnown || !forkUsage.visible()) { return; }
		const onScreen = function(selector) {
			let els;
			try { els = document.querySelectorAll(selector); } catch (e) { return false; }
			for (let i = 0; i < els.length && i < 50; i++) {
				if (els[i].getClientRects().length && getComputedStyle(els[i]).visibility !== "hidden") { return true; }
			}
			return false;
		};
		Object.keys(forkUsage.index.features).forEach(function(id) {
			const e = forkUsage.index.features[id].entry;
			const selectors = (e.exposed ? [e.exposed] : []).concat((e.panels || []).map(function(p) { return "#" + p; }));
			if (!selectors.length || !selectors.some(onScreen)) { return; }
			if (forkUsage.firstTodayStored(id + ".shown")) { forkUsage.track(id, "shown"); }
		});
	},

	/** Real keyboard / mouse input: app.active (at most every ACTIVE_MS while visible) */
	input: function(e) {
		if (e && e.isTrusted === false) { return; }
		const now = Date.now();
		forkUsage.lastInput = now;
		if (forkUsage.visible() && now - forkUsage.lastActive >= forkUsage.ACTIVE_MS) {
			forkUsage.lastActive = now;
			forkUsage.track("app", "active");
		}
	},

	byUser: function() {
		return Date.now() - forkUsage.lastInput <= forkUsage.USER_ACTION_MS;
	},

	/** "Try it" / "Show me" is running the feature right now (forkFeatureActions): not the user using it */
	fromTry: function(feature) {
		return typeof forkFeatureActions !== "undefined" && typeof forkFeatureActions.isTrying === "function" && forkFeatureActions.isTrying(feature);
	},

	/** Wrap a method of a global object (once): after(result, args) runs after it, and never breaks it */
	wrap: function(obj, name, after, before) {
		if (!obj || typeof obj[name] !== "function" || obj[name].forkUsageWrapped) { return; }
		const orig = obj[name];
		const wrapped = function() {
			let state;
			if (before) { try { state = before.apply(this, arguments); } catch (e) { console.error("forkUsage: " + name, e); } }
			const result = orig.apply(this, arguments);
			try { after.call(this, result, arguments, state); } catch (e) { console.error("forkUsage: " + name, e); }
			return result;
		};
		wrapped.forkUsageWrapped = true;
		obj[name] = wrapped;
	},

	installHooks: function() {
		const idx = function() { return forkUsage.index; };
		// Commands run from the Ctrl+K palette (the only caller of forkCommands.execute), once they succeeded. Menus,
		// buttons and map clicks call the feature's code directly: those features track their own use (forkUsage.track
		// at the action, see the catalog test that every `use` action has a sender).
		if (typeof forkCommands !== "undefined") {
			forkUsage.wrap(forkCommands, "execute", function(result, args) {
				const id = args[0] && args[0].id;
				const feature = idx() ? idx().commands[id] : null;
				if (!feature || !result || typeof result.then !== "function") { return; }
				result.then(function(r) { if (r && r.ok) { forkUsage.track(feature, "command"); } });
			});
		}
		if (typeof commandPalette !== "undefined") {
			forkUsage.wrap(commandPalette, "open", function() { forkUsage.track("commandPalette", "opened"); });
		}
		if (typeof whatsNew !== "undefined") {
			// Only when the user opened it (it also opens by itself after an update); open(true) is Ctrl+K, which the
			// forkCommands hook above counts as whatsNew.command already (one open, one use)
			forkUsage.wrap(whatsNew, "open", function(result, args) { if (args[0] !== true && forkUsage.byUser()) { forkUsage.track("whatsNew", "opened"); } });
		}
		// Panels: added by the user (not at page load), or switched to another mode
		if (typeof panelHost !== "undefined") {
			forkUsage.wrap(panelHost, "addGridWidget", function(result, args) {
				const feature = idx() && args[0] ? idx().panels[args[0].id] : null;
				if (feature && result && forkUsage.byUser()) { forkUsage.track(feature, "opened"); }
			});
		}
		if (typeof panelModes !== "undefined") {
			// setMode returns early (changes nothing) without options or an unknown panel; minimizing isn't opening it
			forkUsage.wrap(panelModes, "setMode", function(result, args, known) {
				if (!known) { return; }
				const feature = idx() ? idx().panels[args[0]] : null;
				if (feature && forkUsage.fromTry(feature)) { return; }	// "Try it" restoring the panel
				forkUsage.track("panelModes", "mode");
				if (feature && panelModes.modeFor(args[0]) !== "minimized") { forkUsage.track(feature, "opened"); }
			}, function(id) {
				return !!(panelModes.opts() && panelModes.defOf(id));
			});
		}
		// Settings Save: what each feature's setting changed to (before/after forkSettings writes the rows into options)
		if (typeof forkSettings !== "undefined") {
			forkUsage.wrap(forkSettings, "saveAll", function(result, args, before) {
				if (!before || !idx()) { return; }
				forkUsage.settingChanges(before, forkUsage.settingState(args[0], idx(), forkSettings.items)).forEach(function(c) { forkUsage.track(c[0], c[1]); });
			}, function(opts) {
				return idx() ? forkUsage.settingState(opts, idx(), forkSettings.items) : null;
			});
		}
		document.addEventListener("click", function(e) {
			const el = e.isTrusted !== false && e.target && e.target.closest ? e.target.closest("[data-track]") : null;
			const t = el ? forkUsage.parseTrack(el.getAttribute("data-track")) : null;
			if (t) { forkUsage.track(t.feature, t.action); }
		}, true);
		["keydown", "pointerdown", "wheel"].forEach(function(type) {
			document.addEventListener(type, forkUsage.input, { capture: true, passive: true });
		});
		document.addEventListener("visibilitychange", function() {
			if (document.visibilityState === "hidden") { forkUsage.flush(true); }
		});
		window.addEventListener("pagehide", function() { forkUsage.flush(true); });
		setInterval(function() { forkUsage.flush(false); }, forkUsage.FLUSH_MS);
		setInterval(forkUsage.checkExposure, forkUsage.EXPOSURE_MS);
	},

	registerSetting: function() {
		if (typeof forkSettings === "undefined") { return; }
		forkSettings.register({
			section: "general", order: 80, id: "usageStats-enabled", type: "checkbox", key: "usageStats",
			label: "Usage statistics:", text: "Send usage statistics",
			hint: "Which Tripwire features you use, as daily counts, to this server only. Never your systems, signatures or names.",
			keywords: "analytics privacy tracking telemetry",
			get: function(o) { return forkUsage.statsOn(o); },
			set: function(o, on) {
				o.usageStats = { enabled: !!on };
				if (!on) { forkUsage.pending = {}; }
			}
		});
	},

	/** Track what waited for the catalog and the server's answer */
	replay: function() {
		if (!forkUsage.index || !forkUsage.serverKnown) { return; }
		const queued = forkUsage.queue;
		forkUsage.queue = [];
		queued.forEach(function(q) { forkUsage.track(q[0], q[1]); });
	},

	init: function() {
		try { forkUsage.debugOn = localStorage.getItem(forkUsage.DEBUG_KEY) === "1"; } catch (e) { forkUsage.debugOn = false; }
		forkUsage.registerSetting();
		forkUsage.installHooks();
		let settle = function() {};
		forkUsage.serverInfo = new Promise(function(resolve) { settle = resolve; });
		$.ajax({ url: forkUsage.URL, data: { mode: "get" }, dataType: "json", cache: false }).done(function(data) {
			settle(data && typeof data === "object" ? data : null);
			const str = function(v) { return data && typeof data[v] === "string" ? data[v] : ""; };
			forkUsage.server = { enabled: !!(data && data.enabled), token: str("token"), key: /^[0-9a-f]{16}$/.test(str("key")) ? str("key") : "" };
			if (!forkUsage.server.enabled) {
				$("#usageStats-enabled").prop("disabled", true).closest("td").find(".fs-hint").text("This server collects no usage statistics.");
			}
			if (forkUsage.debugOn) { console.log("[usage] debug on; server " + (forkUsage.server.enabled ? "collects statistics" : "collects none")); }
		}).fail(function() { settle(null); }).always(function() {
			forkUsage.serverKnown = true;
			forkUsage.replay();
		});
		$.ajax({ url: forkUsage.CATALOG_URL, dataType: "json", cache: false }).done(function(catalog) {
			forkUsage.index = forkUsage.buildIndex(catalog);
			forkUsage.replay();
			setTimeout(forkUsage.checkExposure, 15000);
		}).fail(function() { console.warn("forkUsage: could not load " + forkUsage.CATALOG_URL); });
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined") {
	jQuery(function() { forkUsage.init(); });
}
