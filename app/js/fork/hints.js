const forkHints = {
	// Fork-owned: feature tips. One short tip at a quiet moment, right where a feature is useful, never for a feature the user
	// already uses or switched off, at most one pop-up tip a session. Spec: reports/ (onboarding spec, section 2.5); UI in
	// hints-ui.js, styles in app/css/fork/hints.css. Settings > General "Show feature tips" (options.hints.enabled, missing = on).
	//
	// A feature registers its own tip from its own file (see command-palette.js and sig-anomalies.js for the two pilots):
	//
	//   forkHints.register({
	//     id: "sigAnomalies.paste",       required, unique, stable (it is the key of the saved state)
	//     feature: "sigAnomalies",         catalog id: the tip retires once forkUsage.used(feature), or when the feature's
	//                                      Settings toggle (its catalog settingsKey, or `settingsKey` here) is off
	//     section: "signatures",           Settings section (default: the feature's catalog section): per-section daily cap and
	//                                      "Don't show tips like this"
	//     trigger: "paste.sigs",           event name or names (forkHints.emit(name, data)), see EVENTS
	//     minCount: 1,                     show on the Nth time the trigger fires while eligible (counted across sessions)
	//     eligible: (ctx, data) => bool,   optional; an exception counts as false
	//     after: ["other.hint"],           optional; those tips must have been shown (or retired) first
	//     audience: "all",                 all | maskAdmin | new (accounts in their first 14 days)
	//     kind: "callout",                 callout (points at the anchor) | beacon (pulsing dot; click opens the callout) |
	//                                      toast (bottom corner, a nudge after an action). An "idle" line is not built yet.
	//     anchor: "#sel" or (ctx, data) => element,   callout/beacon: skipped while it isn't visible; toast: optional
	//     dialog: "#dialog-mass",          optional: the tip lives inside this dialog (its anchor is in it), so that dialog
	//                                      being open is no reason to wait or to hide; any other open dialog still is
	//     placement: "bottom",             top | bottom | left | right (flips when there's no room)
	//     title: "...", body: "..." or (ctx, data) => "...",   plain text; say how to turn tips off
	//     action: {label: "Show me", run: (ctx, data) => {}},   optional
	//     priority: 50, maxShows: 2, cooldownHours: 72, ttlSeconds: 600
	//   });
	//
	// API: emit(event, data) | show(id, {force, data}) -> bool | list() | reset() | debug(true|false) |
	//      hold(feature, by) (hold its tips back while something else teaches it) | listen(fn(event, data)) -> stop()
	// show(id, {force: true}) (What's New / features hub, later) skips the caps, the quiet check and the retire rules; it
	// still needs the anchor. Keep `const forkHints` on the first line: the test helper strips it to define a global.

	KINDS: ["callout", "beacon", "toast"],
	AUDIENCES: ["all", "maskAdmin", "new"],
	PLACEMENTS: ["top", "bottom", "left", "right"],
	// Core events (emitted from fork files with `typeof forkHints !== "undefined" && forkHints.emit(...)`):
	//   session.start, idle (15 s tick), paste.sigs {rows, anomalies}, system.viewed {systemID, kind, typeName},
	//   dialog.open / dialog.close {id} (hints.js); jump.done {from, to} (jump-return.js); paste.dscan {systemID}
	//   (intel-scans.js); kill.chain {killIDs} (kill-reporting.js, chain-killfeed.js); panel.open {id, popped}
	//   (panel-host.js); maskAdmin.open (mask-admin-tab.js); mouse.action {command} (command-palette.js);
	//   chain.exit {systemIDs: exits that just got a jump range ring} (jump-planner.js)
	EVENTS: ["session.start", "idle", "jump.done", "paste.sigs", "paste.dscan", "kill.chain", "system.viewed", "panel.open",
		"dialog.open", "dialog.close", "maskAdmin.open", "mouse.action", "chain.exit"],
	DONE: ["acted", "got_it", "section_off"],	// outcomes after which a tip never comes back
	DEFAULTS: { kind: "callout", placement: "bottom", priority: 50, maxShows: 2, cooldownHours: 72, ttlSeconds: 600, minCount: 1, audience: "all" },
	CAPS: {
		session: 1,						// pop-up tips (callouts and toasts) per session
		gapMs: 30 * 60000,				// between two pop-up tips
		week: 3,						// pop-up tips per rolling 7 days
		weekMs: 7 * 86400000,
		sectionMs: 86400000,			// one pop-up tip per Settings section per day
		graceMs: 2 * 60000,				// none in the first 2 minutes of a session
		beacons: 3						// beacons on screen at once
	},
	QUIET: {
		idleMs: 5000,					// no input for this long...
		presentMs: 2 * 60000,			// ...but input within this (else the user is away: wait)
		killMs: 10 * 60000,				// no kill in the chain for this long
		pasteMs: 30000					// no paste for this long
	},
	IDLE_MS: 15000,
	PUMP_MS: 2500,
	NEW_MS: 14 * 86400000,
	MAX_STATE: 200,
	MAX_KILLS: 500,
	DEBUG_KEY: "forkHints.debug",

	// ---- Pure logic (tested under mocha) ----

	/** Check and complete a tip's definition; throws on a mistake so it shows up in development */
	normalize: function(def) {
		if (!def || typeof def !== "object") { throw new Error("forkHints.register: definition object required"); }
		const name = "forkHints.register(" + (def.id || "?") + "): ";
		if (typeof def.id !== "string" || !/^[A-Za-z0-9_.-]{1,60}$/.test(def.id)) { throw new Error(name + "id is required ([A-Za-z0-9_.-])"); }
		if (typeof def.feature !== "string" || !def.feature) { throw new Error(name + "feature (catalog id) is required"); }
		const hint = Object.assign({}, forkHints.DEFAULTS, def);
		hint.triggers = (Array.isArray(def.trigger) ? def.trigger : [def.trigger]).filter(function(t) { return typeof t === "string" && t; });
		if (!hint.triggers.length) { throw new Error(name + "trigger is required"); }
		if (forkHints.KINDS.indexOf(hint.kind) < 0) { throw new Error(name + "kind must be callout, beacon or toast"); }
		if (forkHints.AUDIENCES.indexOf(hint.audience) < 0) { throw new Error(name + "audience must be all, maskAdmin or new"); }
		if (forkHints.PLACEMENTS.indexOf(hint.placement) < 0) { throw new Error(name + "placement must be top, bottom, left or right"); }
		if (hint.kind !== "toast" && !hint.anchor) { throw new Error(name + "anchor is required for a " + hint.kind); }
		if (typeof hint.title !== "string" || !hint.title) { throw new Error(name + "title is required"); }
		if (typeof hint.body !== "string" && typeof hint.body !== "function") { throw new Error(name + "body is required"); }
		if (hint.eligible !== undefined && typeof hint.eligible !== "function") { throw new Error(name + "eligible must be a function"); }
		if (hint.action !== undefined && (!hint.action || typeof hint.action.run !== "function")) { throw new Error(name + "action needs run(ctx, data)"); }
		if (hint.dialog !== undefined && (typeof hint.dialog !== "string" || !hint.dialog)) { throw new Error(name + "dialog must be a selector"); }
		hint.after = Array.isArray(def.after) ? def.after.slice() : [];
		["priority", "maxShows", "cooldownHours", "ttlSeconds", "minCount"].forEach(function(k) {
			if (typeof hint[k] !== "number" || !isFinite(hint[k])) { throw new Error(name + k + " must be a number"); }
		});
		return hint;
	},

	/** Tips on for these options (missing = on) */
	enabled: function(opts) {
		return !(opts && opts.hints && opts.hints.enabled === false);
	},

	/** options.hints, completed in place (created when missing): {enabled, disabledSections, state, log: {lastAt, week}} */
	stateOf: function(opts) {
		const st = opts.hints && typeof opts.hints === "object" ? opts.hints : (opts.hints = {});
		if (!Array.isArray(st.disabledSections)) { st.disabledSections = []; }
		if (!st.state || typeof st.state !== "object") { st.state = {}; }
		if (!st.log || typeof st.log !== "object") { st.log = {}; }
		if (!Array.isArray(st.log.week)) { st.log.week = []; }
		st.log.lastAt = Number(st.log.lastAt) || 0;
		return st;
	},

	/** One tip's saved state {shows, last, outcome, n} (created when missing) */
	entry: function(st, id) {
		if (!st.state[id] || typeof st.state[id] !== "object") { st.state[id] = { shows: 0, last: 0 }; }
		return st.state[id];
	},

	/** The tip's Settings section: its own, else its feature's catalog section, else general */
	sectionOf: function(hint, index) {
		if (hint.section) { return hint.section; }
		const f = index && index.features && index.features[hint.feature];
		return f && f.entry && f.entry.section ? f.entry.section : "general";
	},

	/** The options key of the feature's Settings toggle (or null) */
	settingsKeyOf: function(hint, index) {
		if (hint.settingsKey !== undefined) { return hint.settingsKey; }
		const f = index && index.features && index.features[hint.feature];
		return f && f.entry && f.entry.settingsKey ? f.entry.settingsKey : null;
	},

	matches: function(hint, event) {
		return hint.triggers.indexOf(event) >= 0;
	},

	interruptive: function(hint) {
		return hint.kind !== "beacon";
	},

	/** Why the tip is retired for good right now ("" = it isn't): the feature is used, or its toggle is off.
	 *  ctx: {used(feature), featureOff(hint)} */
	retiredReason: function(hint, ctx) {
		if (ctx.used && ctx.used(hint.feature)) { return "feature used"; }
		if (ctx.featureOff && ctx.featureOff(hint)) { return "feature turned off"; }
		return "";
	},

	/** Prerequisite met: that tip was shown at least once, or is retired (or isn't registered at all: a soft graph) */
	afterMet: function(hint, st, ctx) {
		return hint.after.every(function(id) {
			const other = ctx.hints && ctx.hints[id];
			if (!other) { return true; }
			const e = st.state[id];
			return !!(e && e.shows > 0) || !!forkHints.retiredReason(other, ctx);
		});
	},

	/** Why the tip can't be queued now ("" = it can). ctx: {used, featureOff, hints, isMaskAdmin, isNew, sectionOf(hint)} */
	blockedReason: function(hint, st, ctx, now) {
		if (st.enabled === false) { return "tips turned off"; }
		const section = ctx.sectionOf ? ctx.sectionOf(hint) : (hint.section || "general");
		if (st.disabledSections.indexOf(section) >= 0) { return "tips in " + section + " turned off"; }
		if (hint.audience === "maskAdmin" && !ctx.isMaskAdmin) { return "not a mask admin"; }
		if (hint.audience === "new" && !ctx.isNew) { return "not a new account"; }
		const retired = forkHints.retiredReason(hint, ctx);
		if (retired) { return retired; }
		if (ctx.held && ctx.held(hint.feature)) { return "held: " + ctx.held(hint.feature) + " teaches it now"; }
		const e = st.state[hint.id] || { shows: 0, last: 0 };
		if (forkHints.DONE.indexOf(e.outcome) >= 0) { return "done (" + e.outcome + ")"; }
		if ((e.shows || 0) >= hint.maxShows) { return "shown " + e.shows + " times"; }
		if (e.last && now - e.last < hint.cooldownHours * 3600000) { return "cooling down"; }
		if (!forkHints.afterMet(hint, st, ctx)) { return "waits for " + hint.after.join(", "); }
		return "";
	},

	/** hint.eligible(ctx, data); an exception is false (and logged) */
	eligibleSafe: function(hint, ctx, data) {
		if (typeof hint.eligible !== "function") { return true; }
		try { return !!hint.eligible(ctx, data); } catch (e) {
			if (typeof console !== "undefined") { console.warn("forkHints: eligible() of " + hint.id + " failed", e); }
			return false;
		}
	},

	/** Add (or refresh) a queued tip: [{id, data, at, expires}] */
	enqueue: function(queue, hint, data, now) {
		const item = { id: hint.id, data: data, at: now, expires: now + hint.ttlSeconds * 1000 };
		const i = queue.findIndex(function(q) { return q.id === hint.id; });
		if (i >= 0) { queue[i] = item; } else { queue.push(item); }
		return queue;
	},

	/** Drop expired items (mutates); returns the dropped ones */
	expire: function(queue, now) {
		const dropped = [];
		for (let i = queue.length - 1; i >= 0; i--) {
			if (queue[i].expires <= now) { dropped.push(queue.splice(i, 1)[0]); }
		}
		return dropped;
	},

	/** Queue in show order: priority (high first), then the most recent trigger */
	ordered: function(queue, hints) {
		return queue.slice().sort(function(a, b) {
			const pa = hints[a.id] ? hints[a.id].priority : 0, pb = hints[b.id] ? hints[b.id].priority : 0;
			return pb - pa || b.at - a.at;
		});
	},

	/** Pop-up tips shown within the last 7 days (week entries are [time, section]) */
	recent: function(st, now, ms) {
		return st.log.week.filter(function(w) { return Array.isArray(w) && now - w[0] < ms; });
	},

	/** Why the frequency caps refuse the tip now ("" = they don't). session: {start, shown, whatsNew}; o: {debug, beacons} */
	capsReason: function(hint, st, section, session, now, o) {
		o = o || {};
		const c = forkHints.CAPS;
		if (!forkHints.interruptive(hint)) {
			return (o.beacons || 0) >= c.beacons ? c.beacons + " beacons on screen" : "";
		}
		if (session.whatsNew) { return "What's New opened this session"; }
		if (!o.debug && now - session.start < c.graceMs) { return "first 2 minutes of the session"; }
		if (session.shown >= c.session) { return "a tip was shown this session"; }
		if (!o.debug && st.log.lastAt && now - st.log.lastAt < c.gapMs) { return "a tip less than 30 minutes ago"; }
		const week = forkHints.recent(st, now, c.weekMs);
		if (week.length >= c.week) { return c.week + " tips this week"; }
		if (week.some(function(w) { return w[1] === section && now - w[0] < c.sectionMs; })) { return "a " + section + " tip today"; }
		return "";
	},

	/** Why now is not a quiet moment ("" = it is). q: {now, visible, focused, lastInput, lastKill, lastPaste, dialogOpen,
	 *  inputFocused, dragging, popupOpen, fightHere} */
	quietReason: function(q) {
		const t = forkHints.QUIET;
		if (!q.visible) { return "tab hidden"; }
		if (!q.focused) { return "window not focused"; }
		if (!q.lastInput || q.now - q.lastInput > t.presentMs) { return "user away"; }
		if (q.now - q.lastInput < t.idleMs) { return "user busy"; }
		if (q.lastKill && q.now - q.lastKill < t.killMs) { return "kill in the chain"; }
		if (q.lastPaste && q.now - q.lastPaste < t.pasteMs) { return "just pasted"; }
		if (q.dialogOpen) { return "a dialog is open"; }
		if (q.inputFocused) { return "typing in a field"; }
		if (q.dragging) { return "dragging"; }
		if (q.popupOpen) { return "another pop-up is open"; }
		if (q.fightHere) { return "Fight here is active"; }
		return "";
	},

	/** Record a show (mutates st). Pop-up tips also go into the caps log, unless the user asked for the tip (forced). */
	recordShow: function(st, hint, section, now, forced) {
		const e = forkHints.entry(st, hint.id);
		e.shows = (e.shows || 0) + 1;
		e.last = now;
		e.outcome = "shown";
		delete e.n;		// a minCount tip needs its count again before it comes back
		if (forkHints.interruptive(hint) && !forced) {
			st.log.lastAt = now;
			st.log.week.push([now, section]);
		}
		forkHints.trim(st, now);
		return st;
	},

	/** Record what the user did with a tip (mutates st); section_off turns the tip's section off */
	recordOutcome: function(st, hint, outcome, section) {
		const e = forkHints.entry(st, hint.id);
		e.outcome = outcome;
		if (outcome === "section_off" && st.disabledSections.indexOf(section) < 0) { st.disabledSections.push(section); }
		return st;
	},

	/** Keep options small: 7 days of log, at most MAX_STATE tips (the oldest go) */
	trim: function(st, now) {
		st.log.week = forkHints.recent(st, now, forkHints.CAPS.weekMs);
		const ids = Object.keys(st.state);
		if (ids.length > forkHints.MAX_STATE) {
			ids.sort(function(a, b) { return (st.state[a].last || 0) - (st.state[b].last || 0); })
				.slice(0, ids.length - forkHints.MAX_STATE).forEach(function(id) { delete st.state[id]; });
		}
		return st;
	},

	/** Count a trigger toward minCount (mutates st): {reached, changed}. The count stops at minCount (no save per trigger
	 *  once reached) and starts again after the tip was shown (recordShow). */
	counted: function(st, hint) {
		if (hint.minCount <= 1) { return { reached: true, changed: false }; }
		const e = forkHints.entry(st, hint.id);
		const n = Math.min(hint.minCount, Number(e.n) || 0);
		if (n >= hint.minCount) { return { reached: true, changed: false }; }
		e.n = n + 1;
		return { reached: e.n >= hint.minCount, changed: true };
	},

	/** Kill ids not seen before (mutates seen: {id: true}, kept to the last MAX_KILLS); kill.chain comes from both Kill
	 *  Reporting and the Chain kills panel, so one kill counts once */
	newKills: function(seen, ids) {
		const fresh = (ids || []).filter(function(id) { return id !== undefined && id !== null && !seen.map[id]; });
		fresh.forEach(function(id) { seen.map[id] = true; seen.order.push(id); });
		while (seen.order.length > forkHints.MAX_KILLS) { delete seen.map[seen.order.shift()]; }
		return fresh;
	},

	/** "pochven" | "highsec" | "lowsec" | "nullsec" | "wormhole" | "unknown" from systemAnalysis' systemTypeClass */
	systemKind: function(typeClass) {
		const c = String(typeClass || "");
		if (/^wh\b/.test(c)) { return "wormhole"; }
		return { triglavian: "pochven", hisec: "highsec", lowsec: "lowsec", nullsec: "nullsec" }[c] || "unknown";
	},

	/** A scanner-window paste: {rows: sig/anomaly lines, anomalies: of which cosmic anomalies}. isAnomalyGroup: sigAnomalies' */
	pasteInfo: function(text, isAnomalyGroup) {
		const out = { rows: 0, anomalies: 0 };
		String(text || "").split("\n").forEach(function(line) {
			const cols = line.split("\t");
			if (!cols.some(function(c) { return /^[A-Z]{3}-\d{3}$/.test(c.trim()); })) { return; }
			out.rows++;
			if (isAnomalyGroup && cols.some(function(c) { return isAnomalyGroup(c); })) { out.anomalies++; }
		});
		return out;
	},

	// ---- State ----

	hints: {},				// id -> normalized definition
	queue: [],				// [{id, data, at, expires}]
	session: { start: 0, shown: 0, whatsNew: false },
	signals: { lastInput: 0, lastKill: 0, lastPaste: 0, dragging: false },
	seenKills: { map: {}, order: [] },
	debugOn: false,
	lastLog: "",
	pumpTimer: null,
	current: null,			// {hint, data, section} of the pop-up tip on screen
	holds: {},				// feature -> who holds its tips back for now (hold())
	listeners: [],			// fn(event, data) after every emit (listen())

	opts: function() {
		return typeof options !== "undefined" && options ? options : null;
	},

	index: function() {
		return typeof forkUsage !== "undefined" ? forkUsage.index : null;
	},

	/** Context for the decisions and for a tip's eligible / body / action.run */
	ctx: function() {
		const opts = forkHints.opts();
		const index = forkHints.index();
		const st = opts ? forkHints.stateOf(opts) : null;
		return {
			options: opts,
			hints: forkHints.hints,
			viewingSystemID: typeof viewingSystemID !== "undefined" ? viewingSystemID : null,
			used: function(feature) { return typeof forkUsage !== "undefined" && forkUsage.used(feature); },
			featureOff: function(hint) {
				const key = forkHints.settingsKeyOf(hint, index);
				return !!(key && opts && opts[key] && typeof opts[key] === "object" && opts[key].enabled === false);
			},
			sectionOf: function(hint) { return forkHints.sectionOf(hint, index); },
			held: function(feature) { return forkHints.holds[feature] || ""; },
			isMaskAdmin: forkHints.isMaskAdmin(),
			isNew: !!(st && st.newUntil && Date.now() < st.newUntil)
		};
	},

	isMaskAdmin: function() {
		if (typeof document === "undefined" || !document.getElementById) { return false; }
		const a = document.getElementById("admin");
		return !!(a && typeof getComputedStyle === "function" && getComputedStyle(a).display !== "none");
	},

	log: function(text) {
		if (!forkHints.debugOn || text === forkHints.lastLog) { return; }
		forkHints.lastLog = text;
		console.log("[hints] " + text);
	},

	save: function() {
		const opts = forkHints.opts();
		if (opts && typeof opts.saveDelay === "function") { opts.saveDelay(2000); }
	},

	// ---- API ----

	register: function(def) {
		const hint = forkHints.normalize(def);
		if (forkHints.hints[hint.id]) {
			console.warn("forkHints.register(" + hint.id + "): already registered, ignored");
			return forkHints.hints[hint.id];
		}
		forkHints.hints[hint.id] = hint;
		return hint;
	},

	emit: function(event, data) {
		const now = Date.now();
		if (event === "paste.sigs" || event === "paste.dscan") { forkHints.signals.lastPaste = now; }
		if (event === "kill.chain") {
			// Kill Reporting and the Chain kills panel both see a kill: only its first report counts
			if (data && Array.isArray(data.killIDs)) {
				data = Object.assign({}, data, { killIDs: forkHints.newKills(forkHints.seenKills, data.killIDs) });
				if (!data.killIDs.length) { return; }
			}
			forkHints.signals.lastKill = now;
		}
		const opts = forkHints.opts();
		if (!opts) { return; }
		const st = forkHints.stateOf(opts);
		const ctx = forkHints.ctx();
		let changed = false;
		Object.keys(forkHints.hints).forEach(function(id) {
			const hint = forkHints.hints[id];
			if (!forkHints.matches(hint, event)) { return; }
			const blocked = forkHints.blockedReason(hint, st, ctx, now);
			if (blocked) { forkHints.log(id + " on " + event + ": no, " + blocked); return; }
			if (!forkHints.eligibleSafe(hint, ctx, data)) { forkHints.log(id + " on " + event + ": not eligible"); return; }
			const count = forkHints.counted(st, hint);	// only eligible triggers count ("the 3rd k-space system")
			changed = changed || count.changed;
			if (!count.reached) { forkHints.log(id + " on " + event + ": counted " + st.state[id].n + "/" + hint.minCount); return; }
			forkHints.enqueue(forkHints.queue, hint, data, now);
			forkHints.log(id + " on " + event + ": queued for " + hint.ttlSeconds + " s");
		});
		if (changed) { forkHints.save(); }
		forkHints.listeners.slice().forEach(function(fn) {
			try { fn(event, data); } catch (e) { console.error("forkHints listener failed", e); }
		});
		if (event !== "idle") { forkHints.pump(); }
	},

	/** Hold a feature's tips back while something else teaches it (e.g. the Getting started card): by = a name for the debug
	 *  log, or "" to let them go again. A forced show (What's New "Try it") still shows them. */
	hold: function(feature, by) {
		if (by) { forkHints.holds[feature] = String(by); } else { delete forkHints.holds[feature]; }
	},

	/** fn(event, data) after every emitted event (paste.sigs, system.viewed, ...); returns a function that stops it */
	listen: function(fn) {
		if (typeof fn !== "function") { throw new Error("forkHints.listen: function required"); }
		forkHints.listeners.push(fn);
		return function() { forkHints.listeners = forkHints.listeners.filter(function(f) { return f !== fn; }); };
	},

	/** Show the best queued tip if the caps and the moment allow it; re-arms itself while anything is queued */
	pump: function() {
		clearTimeout(forkHints.pumpTimer);
		forkHints.pumpTimer = null;
		const opts = forkHints.opts();
		if (!opts || typeof forkHintsUI === "undefined") { return; }
		const now = Date.now();
		forkHints.expire(forkHints.queue, now).forEach(function(q) { forkHints.log(q.id + ": dropped, not shown within its ttl"); });
		if (!forkHints.queue.length) { return; }
		forkHints.pumpTimer = setTimeout(forkHints.pump, forkHints.PUMP_MS);
		if (forkHintsUI.busy()) { forkHints.log("waiting: a tip is on screen"); return; }
		const st = forkHints.stateOf(opts);
		const ctx = forkHints.ctx();
		const reasons = [];
		const items = forkHints.ordered(forkHints.queue, forkHints.hints);
		for (let i = 0; i < items.length; i++) {
			const item = items[i], hint = forkHints.hints[item.id];
			const drop = !hint ? "unregistered" : forkHints.blockedReason(hint, st, ctx, now);
			if (drop) { forkHints.unqueue(item.id); forkHints.log(item.id + ": dropped, " + drop); continue; }
			const section = ctx.sectionOf(hint);
			const caps = forkHints.capsReason(hint, st, section, forkHints.session, now, { debug: forkHints.debugOn, beacons: forkHintsUI.beaconCount() });
			if (caps) { reasons.push(item.id + ": " + caps); continue; }
			const quiet = forkHints.quietReason(forkHintsUI.quietSignals(now, hint));	// a tip in a dialog: that one doesn't count
			if (quiet) { reasons.push(item.id + ": " + quiet); continue; }
			if (!forkHintsUI.anchorFor(hint, ctx, item.data)) { reasons.push(item.id + ": anchor not visible"); continue; }
			forkHints.unqueue(item.id);
			forkHints.display(hint, item.data, section, false);
			return;
		}
		if (reasons.length) { forkHints.log("waiting: " + reasons.join("; ")); }
	},

	unqueue: function(id) {
		forkHints.queue = forkHints.queue.filter(function(q) { return q.id !== id; });
	},

	/** Put the tip on screen and record the show. forced: from show(id, {force}) */
	display: function(hint, data, section, forced) {
		const opts = forkHints.opts();
		const ctx = forkHints.ctx();
		let body;
		try { body = typeof hint.body === "function" ? String(hint.body(ctx, data)) : hint.body; } catch (e) {
			console.warn("forkHints: body() of " + hint.id + " failed", e);
			return false;
		}
		const shown = forkHintsUI.render(hint, { title: hint.title, body: body, actionLabel: hint.action ? (hint.action.label || "Show me") : "" }, data, ctx);
		if (!shown) { return false; }
		const now = Date.now();
		if (opts) {
			const st = forkHints.stateOf(opts);
			forkHints.recordShow(st, hint, section, now, forced);
			forkHints.save();
		}
		if (forkHints.interruptive(hint)) {
			if (!forced) { forkHints.session.shown++; }	// asked for (What's New, features hub): not a push, no cap
			forkHints.current = { hint: hint, data: data, section: section };
		}
		forkHints.log(hint.id + ": shown as " + hint.kind + (forced ? " (forced)" : ""));
		forkHints.track("shown", hint);
		return true;
	},

	/** Usage statistics for an outcome: hints.tip_shown / acted / got_it / closed / ignored / section_off, and
	 *  <feature>.hint_shown / hint_acted for the per-tip funnel
	 *  (shown -> used, on the tip's own feature). Literal calls: the catalog test looks for them. */
	track: function(outcome, hint) {
		if (typeof forkUsage === "undefined") { return; }
		const funnel = function(action) {
			const index = forkHints.index();
			if (!index || (index.features && index.features[hint.feature])) { forkUsage.track(hint.feature, action); }
		};
		if (outcome === "shown") { forkUsage.track("hints", "tip_shown"); funnel("hint_shown"); }	// not "shown": that is daily exposure
		else if (outcome === "acted") { forkUsage.track("hints", "acted"); funnel("hint_acted"); }
		else if (outcome === "got_it") { forkUsage.track("hints", "got_it"); }
		else if (outcome === "closed") { forkUsage.track("hints", "closed"); }
		else if (outcome === "ignored") { forkUsage.track("hints", "ignored"); }
		else if (outcome === "section_off") { forkUsage.track("hints", "section_off"); }
	},

	/** Called by the UI: what the user did with the tip on screen (acted, got_it, closed, ignored, section_off) */
	outcome: function(id, outcome, data) {
		const hint = forkHints.hints[id];
		if (!hint) { return; }
		const opts = forkHints.opts();
		const index = forkHints.index();
		const section = forkHints.sectionOf(hint, index);
		if (forkHints.current && forkHints.current.hint.id === id) { forkHints.current = null; }
		if (opts) {
			const st = forkHints.stateOf(opts);
			forkHints.recordOutcome(st, hint, outcome, section);
			if (outcome === "section_off") {
				forkHints.queue = forkHints.queue.filter(function(q) { return !forkHints.hints[q.id] || forkHints.sectionOf(forkHints.hints[q.id], index) !== section; });
				forkHintsUI.removeBeacons(function(h) { return forkHints.sectionOf(h, index) === section; });
			}
			forkHints.save();
		}
		forkHints.log(id + ": " + outcome);
		forkHints.track(outcome, hint);
		if (outcome === "acted" && hint.action) {
			try { hint.action.run(forkHints.ctx(), data); } catch (e) { console.error("forkHints: action of " + id + " failed", e); }
		}
	},

	/** Show a tip now (What's New "Try it", features hub). force: skip the caps, the quiet check and the retire rules
	 *  (the user asked for it); the anchor must still be visible. Returns whether it is on screen. */
	show: function(id, o) {
		o = o || {};
		const hint = forkHints.hints[id];
		if (!hint || typeof forkHintsUI === "undefined") { return false; }
		const ctx = forkHints.ctx();
		const opts = forkHints.opts();
		const now = Date.now();
		if (!o.force) {
			const st = opts ? forkHints.stateOf(opts) : null;
			const section = ctx.sectionOf(hint);
			const why = !st ? "no options" : forkHints.blockedReason(hint, st, ctx, now)
				|| forkHints.capsReason(hint, st, section, forkHints.session, now, { debug: forkHints.debugOn, beacons: forkHintsUI.beaconCount() })
				|| forkHints.quietReason(forkHintsUI.quietSignals(now, hint));
			if (why) { forkHints.log(id + ": not shown, " + why); return false; }
		}
		if (!forkHintsUI.anchorFor(hint, ctx, o.data)) { forkHints.log(id + ": not shown, anchor not visible"); return false; }
		if (o.force && forkHintsUI.busy()) { forkHintsUI.hide("closed"); }
		forkHints.unqueue(id);
		return forkHints.display(hint, o.data, ctx.sectionOf(hint), !!o.force);
	},

	/** Every registered tip with its state (for the features hub and the console) */
	list: function() {
		const opts = forkHints.opts();
		const st = opts ? forkHints.stateOf(opts) : null;
		const ctx = forkHints.ctx();
		const now = Date.now();
		return Object.keys(forkHints.hints).map(function(id) {
			const h = forkHints.hints[id];
			return {
				id: id, feature: h.feature, section: ctx.sectionOf(h), kind: h.kind, title: h.title, triggers: h.triggers.slice(),
				state: st && st.state[id] ? Object.assign({}, st.state[id]) : { shows: 0, last: 0 },
				blocked: st ? forkHints.blockedReason(h, st, ctx, now) : "no options",
				queued: forkHints.queue.some(function(q) { return q.id === id; })
			};
		});
	},

	/** Forget every tip's state and the turned-off sections. all: also turn tips back on (Settings > Reset) */
	reset: function(opts, all) {
		opts = opts || forkHints.opts();
		forkHints.queue = [];
		forkHints.current = null;
		if (typeof forkHintsUI !== "undefined" && typeof document !== "undefined") {
			forkHintsUI.hide(null);
			forkHintsUI.removeBeacons(function() { return true; });
		}
		if (!opts || !opts.hints) { return; }
		const enabled = opts.hints.enabled;
		delete opts.hints;
		if (!all && enabled === false) { opts.hints = { enabled: false }; }
		forkHints.save();
	},

	debug: function(on) {
		if (on === undefined) { return forkHints.debugOn; }
		forkHints.debugOn = !!on;
		forkHints.lastLog = "";
		try {
			if (forkHints.debugOn) { localStorage.setItem(forkHints.DEBUG_KEY, "1"); } else { localStorage.removeItem(forkHints.DEBUG_KEY); }
		} catch (e) { /* storage unavailable: this page only */ }
		console.log("[hints] debug " + (forkHints.debugOn ? "on: decisions are logged; no 2-minute grace or 30-minute gap" : "off"));
		if (forkHints.debugOn) { forkHints.pump(); }
		return forkHints.debugOn;
	},

	// ---- Browser-only code below (not run under mocha) ----

	registerSetting: function() {
		if (typeof forkSettings === "undefined") { return; }
		forkSettings.register({
			section: "general", order: 15, id: "hints-enabled", type: "checkbox", key: "hints",
			label: "Feature tips:", text: "Show feature tips",
			hint: "Now and then, one short tip about a feature you haven't used yet, right where it helps. Never during a fight.",
			keywords: "hints onboarding help tutorial discover",
			get: function(o) { return forkHints.enabled(o); },
			set: function(o, on) {
				const st = forkHints.stateOf(o);
				st.enabled = !!on;
				if (!on) { forkHints.queue = []; if (typeof forkHintsUI !== "undefined") { forkHintsUI.hide(null); forkHintsUI.removeBeacons(function() { return true; }); } }
			},
			// Settings > Reset: tips on again, every tip's state and the turned-off sections forgotten
			reset: function(o) { forkHints.reset(o, true); }
		});
	},

	/** Core events no feature file sees: session.start, idle, paste.sigs, system.viewed, dialog.open / close; What's New this session */
	installHooks: function() {
		["keydown", "pointerdown", "wheel"].forEach(function(type) {
			document.addEventListener(type, function(e) {
				if (e && e.isTrusted === false) { return; }
				forkHints.signals.lastInput = Date.now();
				if (type === "pointerdown") { forkHints.signals.dragging = true; }
			}, { capture: true, passive: true });
		});
		["pointerup", "pointercancel"].forEach(function(type) {
			document.addEventListener(type, function() { forkHints.signals.dragging = false; }, { capture: true, passive: true });
		});
		window.addEventListener("blur", function() { forkHints.signals.dragging = false; });
		// CKEditor's iframe keeps its keystrokes from the page's listeners: count them as input too
		if (typeof CKEDITOR !== "undefined" && CKEDITOR && typeof CKEDITOR.on === "function") {
			const typed = function() { forkHints.signals.lastInput = Date.now(); };
			const watch = function(editor) { if (editor && !editor.forkHintsWatched) { editor.forkHintsWatched = true; editor.on("key", typed); editor.on("change", typed); } };
			Object.keys(CKEDITOR.instances || {}).forEach(function(k) { watch(CKEDITOR.instances[k]); });
			CKEDITOR.on("instanceReady", function(e) { watch(e.editor); });
		}
		$(document).on("dialogopen", "#dialog-whatsNew", function() { forkHints.session.whatsNew = true; });
		$(document).on("dialogopen", function(e) { forkHints.emit("dialog.open", { id: e.target && e.target.id || "" }); });
		$(document).on("dialogclose", function(e) { forkHints.emit("dialog.close", { id: e.target && e.target.id || "" }); });
		if (typeof tripwire !== "undefined" && tripwire.pasteSignatures && typeof tripwire.pasteSignatures.parsePaste === "function" && !tripwire.pasteSignatures.parsePaste.forkHintsWrapped) {
			const parsePaste = tripwire.pasteSignatures.parsePaste;
			const wrapped = function(paste) {
				const result = parsePaste.apply(this, arguments);
				try {
					forkHints.emit("paste.sigs", forkHints.pasteInfo(paste, typeof sigAnomalies !== "undefined" ? sigAnomalies.isAnomalyGroup : null));
				} catch (e) { console.error("forkHints: paste.sigs", e); }
				return result;
			};
			wrapped.forkHintsWrapped = true;
			tripwire.pasteSignatures.parsePaste = wrapped;
		}
		if (typeof tripwire !== "undefined" && typeof tripwire.systemChange === "function" && !tripwire.systemChange.forkHintsWrapped) {
			const systemChange = tripwire.systemChange;
			const wrapped = function(systemID, mode) {
				const result = systemChange.apply(this, arguments);
				try {
					const sys = typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(systemID) : null;
					if (sys) { forkHints.emit("system.viewed", { systemID: systemID, kind: forkHints.systemKind(sys.systemTypeClass), typeName: sys.systemTypeName }); }
				} catch (e) { console.error("forkHints: system.viewed", e); }
				return result;
			};
			Object.keys(systemChange).forEach(function(k) { wrapped[k] = systemChange[k]; });	// other wrappers' markers
			wrapped.forkHintsWrapped = true;
			tripwire.systemChange = wrapped;
		}
		setInterval(function() {
			if (document.visibilityState === "hidden") { return; }
			forkHints.emit("idle");
			forkHints.pump();
		}, forkHints.IDLE_MS);
	},

	init: function() {
		try { forkHints.debugOn = localStorage.getItem(forkHints.DEBUG_KEY) === "1"; } catch (e) { forkHints.debugOn = false; }
		forkHints.session = { start: Date.now(), shown: 0, whatsNew: false };
		forkHints.registerSetting();
		const opts = forkHints.opts();
		if (opts && !opts.hints) {
			// A new account (What's New never seen yet): tips with audience "new" for its first 14 days
			const fresh = !(opts.whatsNew && opts.whatsNew.lastSeenPR);
			if (fresh) { forkHints.stateOf(opts).newUntil = Date.now() + forkHints.NEW_MS; forkHints.save(); }
		}
		forkHints.installHooks();
		if (forkHints.debugOn) { console.log("[hints] debug on (forkHints.debug(false) to stop)"); }
		// After the feature files registered their tips (DOM ready handlers run in bundle order; hints.js sorts early)
		setTimeout(function() { forkHints.emit("session.start"); }, 0);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	jQuery(function() { forkHints.init(); });
}
