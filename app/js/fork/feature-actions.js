const forkFeatureActions = {
	// Fork-owned: what a feature's "Try it" does, and whether the user has used it. Shared by What's New (whats-new.js),
	// Getting started (getting-started.js) and the features hub. Reads public/fork/feature-catalog.json (once, cached),
	// forkUsage (used), forkHints (tips), forkCommands / commandPalette (commands, Settings rows) and panelHost / panelModes.
	//
	// API: forkFeatureActions.load() -> Promise(catalog)      fetch the catalog once (later calls reuse it)
	//      forkFeatureActions.catalog() -> catalog | null       once loaded
	//      forkFeatureActions.byId(id) / byPR(pr) -> entry | null
	//      forkFeatureActions.status(id) -> "used" | "off" | "new"   off: its Settings toggle is off (wins over used: it isn't
	//                                                                 in use now); used: forkUsage.used(id); else new / not tried
	//      forkFeatureActions.canTry(id) -> bool                  tryIt can show the feature itself (not only the toast)
	//      forkFeatureActions.tryIt(id) -> {did, id} | null       did: "tip" | "command" | "palette" | "panel" | "setting" | "toast"
	// tryIt order: a tip registered for the feature, shown with forkHints.show(id, {force: true}) (skipped when it can't show,
	// e.g. its anchor isn't on screen) -> the feature's catalog `try` command, if it has one and it is registered and
	// available now (one with arguments opens the palette at it so the user picks; a panel toggle only while its panel is
	// hidden) -> its first catalog panel that is on the page (restored if minimized, scrolled to and flashed) -> its Settings
	// row (commandPalette.openSetting) -> a short toast with the first paragraph of its newest What's New entry. A feature
	// turned off goes to its Settings row first.
	// Only `try` commands are ever run, never the feature's other `commands`: `try` is an allow-list of commands that only
	// open or show something (TRY_SAFE; the catalog test checks every `try` against it), because the palette prefilled at
	// e.g. Fight here or Mark rolling is two Enters away from a write for the whole mask.
	// tryIt sends no statistics of its own: the caller tracks its click (e.g. whatsNew.tried); a tip counts as tips do, a
	// command as a palette command.
	// Keep `const forkFeatureActions` on the first line: the test helper strips it to define a global. Pure logic first.

	CATALOG_URL: "fork/feature-catalog.json",
	// The only commands a catalog `try` may name: they open a panel, window or map and write nothing for the mask (a panel
	// toggle changes the user's own options). Add one here only after checking its run() (and the catalog test passes).
	TRY_SAFE: /^panel\.[A-Za-z]+$|^(destinations|regionmap|jumpPlanner|rollingGuide|analytics)\.open$|^structures\.(show|timers)$/,
	FLASH_MS: 1500,
	TOAST_CHARS: 220,

	// ---- Pure logic (tested under mocha) ----

	/** Lookups: {byId: {id: entry}, byPR: {pr: entry}} */
	buildIndex: function(catalog) {
		const index = { byId: {}, byPR: {} };
		(catalog && Array.isArray(catalog.features) ? catalog.features : []).forEach(function(f) {
			if (!f || typeof f.id !== "string") { return; }
			index.byId[f.id] = f;
			(Array.isArray(f.prs) ? f.prs : []).forEach(function(pr) { index.byPR[pr] = f; });
		});
		return index;
	},

	/** A feature's Settings toggle is off: options[key].enabled === false (missing = on) */
	isOff: function(opts, key) {
		return !!(key && opts && opts[key] && typeof opts[key] === "object" && opts[key].enabled === false);
	},

	/** "used" | "off" | "new" from the entry, the options and used(id) */
	statusOf: function(entry, opts, used) {
		if (!entry) { return "new"; }
		if (forkFeatureActions.isOff(opts, entry.settingsKey)) { return "off"; }
		return used && used(entry.id) ? "used" : "new";
	},

	/** The entry's `try` command if it is an allowed one (TRY_SAFE), else null */
	tryCommand: function(entry) {
		const id = entry && typeof entry.try === "string" ? entry.try : null;
		return id && forkFeatureActions.TRY_SAFE.test(id) ? id : null;
	},

	/**
	 * What "Try it" can do for the entry, best first: [{kind, id}], kind tip | command | palette | panel | setting | toast.
	 * env (what is on the page now):
	 *   tips: [tip ids registered for the feature]
	 *   command(id) -> null (not registered) | {available: bool, hasArgs: bool, panelShown: bool (a panel toggle whose panel
	 *                  is shown now: running it would hide it)}
	 *   panel(id) -> bool (on the page)
	 *   settingRow: id of its Settings row, or null
	 *   howText: a short how-to text (the toast), or ""
	 *   off: its toggle is off
	 */
	candidates: function(entry, env) {
		if (!entry) { return []; }
		env = env || {};
		const out = [];
		const setting = env.settingRow ? [{ kind: "setting", id: env.settingRow }] : [];
		const toast = env.howText ? [{ kind: "toast", id: entry.id }] : [];
		if (env.off) { return setting.concat(toast); }	// turned off: the way to try it is turning it on
		(env.tips || []).forEach(function(id) { out.push({ kind: "tip", id: id }); });
		// Only the catalog's `try` command (an allow-list), never any other of the feature's commands
		const tryId = forkFeatureActions.tryCommand(entry);
		const c = tryId && env.command ? env.command(tryId) : null;
		if (c && c.available && !c.panelShown) { out.push({ kind: c.hasArgs ? "palette" : "command", id: tryId }); }
		for (let i = 0; i < (entry.panels || []).length; i++) {
			if (env.panel && env.panel(entry.panels[i])) { out.push({ kind: "panel", id: entry.panels[i] }); break; }
		}
		return out.concat(setting, toast);
	},

	/** The palette would open on an empty picker: the command's first required argument is a chain system, hole or signature
	 *  and candidatesOf(arg) (the palette's argCandidates) has none (e.g. Jump planner from an exit, with no exit in range) */
	pickerEmpty: function(command, candidatesOf) {
		const first = ((command && command.args) || []).filter(function(a) { return a && !a.optional; })[0];
		if (!first || ["chainSystem", "hole", "signature"].indexOf(first.type) < 0) { return false; }
		let list = [];
		try { list = candidatesOf(first) || []; } catch (e) { list = []; }
		return list.length === 0;
	},

	/** The first paragraph of the newest What's New entry of the feature (features: features.json's list), cut to max chars */
	howTextOf: function(entry, features, max) {
		if (!entry || !Array.isArray(entry.prs) || !Array.isArray(features)) { return ""; }
		const own = features.filter(function(f) { return f && entry.prs.indexOf(parseInt(f.pr, 10)) >= 0; })
			.sort(function(a, b) { return b.pr - a.pr; })[0];
		const p = own ? String(own.description || "").split(/\r?\n\s*\r?\n/)[0].replace(/\s+/g, " ").trim() : "";
		max = max || forkFeatureActions.TOAST_CHARS;
		return p.length > max ? p.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : p;
	},

	// ---- State ----

	index: null,
	raw: null,
	loading: null,

	// ---- API ----

	load: function() {
		if (forkFeatureActions.loading) { return forkFeatureActions.loading; }
		forkFeatureActions.loading = new Promise(function(resolve) {
			if (typeof $ === "undefined" || !$.ajax) { resolve(null); return; }
			$.ajax({ url: forkFeatureActions.CATALOG_URL, dataType: "json", cache: false }).done(function(catalog) {
				forkFeatureActions.setCatalog(catalog);
				resolve(catalog);
			}).fail(function() {
				console.warn("forkFeatureActions: could not load " + forkFeatureActions.CATALOG_URL);
				forkFeatureActions.loading = null;	// try again next time
				resolve(null);
			});
		});
		return forkFeatureActions.loading;
	},

	setCatalog: function(catalog) {
		forkFeatureActions.raw = catalog || null;
		forkFeatureActions.index = forkFeatureActions.buildIndex(catalog);
	},

	catalog: function() {
		return forkFeatureActions.raw;
	},

	byId: function(id) {
		const ix = forkFeatureActions.index;
		return ix && Object.prototype.hasOwnProperty.call(ix.byId, id) ? ix.byId[id] : null;
	},

	byPR: function(pr) {
		const ix = forkFeatureActions.index;
		const n = parseInt(pr, 10);
		return ix && Object.prototype.hasOwnProperty.call(ix.byPR, n) ? ix.byPR[n] : null;
	},

	opts: function() {
		return typeof options !== "undefined" && options ? options : null;
	},

	used: function(id) {
		return typeof forkUsage !== "undefined" && forkUsage.used(id);
	},

	status: function(id) {
		return forkFeatureActions.statusOf(forkFeatureActions.byId(id), forkFeatureActions.opts(), forkFeatureActions.used);
	},

	canTry: function(id) {
		return forkFeatureActions.candidates(forkFeatureActions.byId(id), forkFeatureActions.env(forkFeatureActions.byId(id)))
			.some(function(c) { return c.kind !== "toast"; });
	},

	tryIt: function(id) {
		const entry = forkFeatureActions.byId(id);
		const list = forkFeatureActions.candidates(entry, forkFeatureActions.env(entry));
		for (let i = 0; i < list.length; i++) {
			let ok = false;
			try { ok = forkFeatureActions.run(list[i]); } catch (e) { console.error("forkFeatureActions: " + list[i].kind + " " + list[i].id + " failed", e); }
			if (ok) { return { did: list[i].kind, id: list[i].id }; }
		}
		return null;
	},

	// ---- Browser-only code below (not run under mocha) ----

	/** The palette's context for a command's enabled() / run() */
	commandCtx: function() {
		if (typeof commandPalette !== "undefined" && typeof commandPalette.makeContext === "function") {
			try { return commandPalette.makeContext(); } catch (e) { /* fall through */ }
		}
		return { viewingSystemID: typeof viewingSystemID !== "undefined" ? viewingSystemID : null };
	},

	findCommand: function(id) {
		if (typeof forkCommands === "undefined") { return null; }
		return forkCommands.commands.filter(function(c) { return c.id === id; })[0] || null;
	},

	settingItem: function(entry) {
		if (!entry || !entry.settingsKey || typeof forkSettings === "undefined") { return null; }
		const rows = forkSettings.items.filter(function(r) { return r.key === entry.settingsKey; });
		return rows.filter(function(r) { return r.type !== "custom"; })[0] || rows[0] || null;
	},

	settingRowEl: function(itemId) {
		if (typeof document === "undefined") { return null; }
		const body = Array.prototype.filter.call(document.querySelectorAll("tbody.fs-item"), function(b) { return b.getAttribute("data-fs-id") === itemId; })[0];
		return body ? body.querySelector("tr") : null;
	},

	/** What is on the page now, for candidates() */
	env: function(entry) {
		if (!entry) { return {}; }
		const ctx = { value: null };
		const lazyCtx = function() { if (!ctx.value) { ctx.value = forkFeatureActions.commandCtx(); } return ctx.value; };
		const item = forkFeatureActions.settingItem(entry);
		return {
			off: forkFeatureActions.isOff(forkFeatureActions.opts(), entry.settingsKey),
			tips: typeof forkHints !== "undefined" ? Object.keys(forkHints.hints).filter(function(h) { return forkHints.hints[h].feature === entry.id; }) : [],
			command: function(id) {
				const c = forkFeatureActions.findCommand(id);
				if (!c) { return null; }
				let enabled = true;
				if (c.enabled) { try { enabled = c.enabled(lazyCtx()); } catch (e) { enabled = false; } }
				const hint = typeof forkCommands.hint === "function" ? forkCommands.hint(c, lazyCtx()) : "";
				const required = (c.args || []).filter(function(a) { return !a.optional; });
				return { available: enabled === true || enabled === undefined, hasArgs: required.length > 0, panelShown: /^Shown now/.test(hint) };
			},
			panel: function(id) {
				return typeof panelHost !== "undefined" && !!panelHost.get(id) && !!document.getElementById(id);
			},
			settingRow: item && forkFeatureActions.settingRowEl(item.id) ? item.id : null,
			howText: forkFeatureActions.howText(entry)
		};
	},

	run: function(c) {
		if (c.kind === "tip") {
			return typeof forkHints !== "undefined" && forkHints.show(c.id, { force: true });
		}
		if (c.kind === "command" || c.kind === "palette") {
			if (!forkFeatureActions.TRY_SAFE.test(c.id)) { return false; }	// never anything off the allow-list
			const command = forkFeatureActions.findCommand(c.id);
			if (!command) { return false; }
			if (c.kind === "palette") {
				// Arguments to pick (a hole, a system): the palette asks, the user confirms
				if (typeof commandPalette === "undefined" || typeof commandPalette.startCommand !== "function") { return false; }
				// doOpen, not open: forkUsage counts open() as the user using Ctrl+K, which this isn't
				try { commandPalette.doOpen(); } catch (e) {
					console.error("forkFeatureActions: palette open failed", e);
					commandPalette.state.open = false;
					const overlay = document.getElementById("cp-overlay");
					if (overlay) { overlay.className = "cp-hidden"; }
					return false;
				}
				if (!commandPalette.state.open) { return false; }
				// Its candidates are known only once the palette has built its index (doOpen): an empty picker is no way to
				// try it, so close again and let tryIt fall through to the panel / Settings row / toast
				if (forkFeatureActions.pickerEmpty(command, function(arg) { return commandPalette.argCandidates(command, arg); })) {
					commandPalette.close(false);
					return false;
				}
				commandPalette.startCommand(command);
				return true;
			}
			const ctx = forkFeatureActions.commandCtx();
			forkCommands.execute(command, {}, ctx).then(function(r) {
				if (r && !r.ok && typeof Notify !== "undefined") { Notify.trigger("Could not run \"" + forkFeatureActions.escape(command.title) + "\"", "red"); }
			});
			return true;
		}
		if (c.kind === "panel") {
			const el = document.getElementById(c.id);
			if (!el) { return false; }
			if (typeof panelModes !== "undefined" && panelModes.modeFor(c.id) === "minimized") { panelModes.setMode(c.id, "restore"); }
			const shown = document.getElementById(c.id) || el;
			if (shown.scrollIntoView) { shown.scrollIntoView({ block: "nearest" }); }
			$(shown).addClass("ffa-flash");
			setTimeout(function() { $(shown).removeClass("ffa-flash"); }, forkFeatureActions.FLASH_MS);
			return true;
		}
		if (c.kind === "setting") {
			const tr = forkFeatureActions.settingRowEl(c.id);
			if (!tr || typeof commandPalette === "undefined" || typeof commandPalette.openSetting !== "function") { return false; }
			commandPalette.openSetting(tr);
			return true;
		}
		if (c.kind === "toast") {
			const entry = forkFeatureActions.byId(c.id);
			const text = forkFeatureActions.howText(entry);
			if (!text || typeof Notify === "undefined") { return false; }
			Notify.trigger("<b>" + forkFeatureActions.escape(entry.title) + "</b><br/>" + forkFeatureActions.escape(text), "blue", 15000);
			return true;
		}
		return false;
	},

	/** The toast's text: from What's New's list (whatsNew.features, loaded by whats-new.js) */
	howText: function(entry) {
		const features = typeof whatsNew !== "undefined" && Array.isArray(whatsNew.features) ? whatsNew.features : [];
		return forkFeatureActions.howTextOf(entry, features);
	},

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	}
};
