const forkCommands = {
	// Fork-owned: the command palette's registry. A feature registers its commands, and dynamic items (a provider),
	// from its init() (DOM ready; the bundle concatenates fork files alphabetically, so don't register at load time):
	//
	//   forkCommands.register({
	//     id: "rally.fightHere",     required, unique (a duplicate is ignored with a console warning)
	//     title: "Fight here",       required, plain text
	//     group: "Fleet",            Navigation | Signatures | Holes | Fleet | Routes | Intel | Panels | App
	//     keywords: ["rally"], icon: "flag" (data-icon name), shortcut: "Ctrl+Z" (display only)
	//     enabled: ctx => true | "reason it is unavailable"   (a disabled command is listed greyed with the reason)
	//     context: ctx => boolean    listed under "For <viewed system>" and ranked higher
	//     hint: ctx => "text"        subtitle shown instead of the group (e.g. the current state)
	//     args: [{name, type, optional, default: ctx => value, choices: ctx => [{value, title, hint}], filter: value => bool}]
	//                                type: chainSystem | system | hole | signature | choice | text. The palette asks for each
	//                                (or takes them from one line: "fight AA", "mark rolling A") and calls
	//                                run({name: value, ...}, ctx): a system id, a wormhole id, a choice's value or text.
	//     run: (args, ctx) => {}     required; may return a Promise; an exception becomes a red notification
	//   });
	//   forkCommands.provider("watchlist", ctx => [{key, kind, title, subtitle, icon, keys: [], run}]);
	//   forkCommands.invalidate("watchlist");   // its items are rebuilt on the next open
	//
	// ctx = {viewingSystemID, selectedSigIDs(), chainSystems(), holes(), trackedCharacterID} built by the palette on open (lazy).

	ARG_TYPES: ["chainSystem", "system", "hole", "signature", "choice", "text"],
	GROUPS: ["Navigation", "Signatures", "Holes", "Fleet", "Routes", "Intel", "Panels", "App"],

	commands: [],
	providers: {},		// name -> {fn, volatile, cache}

	register: function(def) {
		if (!def || typeof def !== "object") { throw new Error("forkCommands.register: definition object required"); }
		if (typeof def.id !== "string" || !def.id) { throw new Error("forkCommands.register: id is required"); }
		const name = "forkCommands.register(" + def.id + "): ";
		if (typeof def.title !== "string" || !def.title) { throw new Error(name + "title is required"); }
		if (typeof def.run !== "function") { throw new Error(name + "run(args, ctx) is required"); }
		if (def.enabled !== undefined && typeof def.enabled !== "function") { throw new Error(name + "enabled must be a function"); }
		if (def.context !== undefined && typeof def.context !== "function") { throw new Error(name + "context must be a function"); }
		if (def.hint !== undefined && typeof def.hint !== "function") { throw new Error(name + "hint must be a function"); }
		if (def.args !== undefined) { forkCommands.checkArgs(name, def.args); }
		const existing = forkCommands.commands.filter(function(c) { return c.id === def.id; })[0];
		if (existing) {
			console.warn("forkCommands.register(" + def.id + "): already registered, ignored");
			return existing;
		}
		const command = Object.assign({}, def);
		command.group = forkCommands.GROUPS.indexOf(def.group) >= 0 ? def.group : "App";
		command.keywords = Array.isArray(def.keywords) ? def.keywords : [];
		forkCommands.commands.push(command);
		return command;
	},

	checkArgs: function(name, args) {
		if (!Array.isArray(args)) { throw new Error(name + "args must be an array"); }
		const seen = {};
		args.forEach(function(a) {
			if (!a || typeof a.name !== "string" || !a.name) { throw new Error(name + "every argument needs a name"); }
			if (seen[a.name]) { throw new Error(name + "duplicate argument " + a.name); }
			seen[a.name] = true;
			if (forkCommands.ARG_TYPES.indexOf(a.type) < 0) { throw new Error(name + "argument " + a.name + ": unknown type " + a.type); }
			if (a.type === "choice" && typeof a.choices !== "function") { throw new Error(name + "argument " + a.name + ": choices must be a function"); }
			["default", "filter"].forEach(function(f) {
				if (a[f] !== undefined && typeof a[f] !== "function") { throw new Error(name + "argument " + a.name + ": " + f + " must be a function"); }
			});
		});
	},

	/**
	 * "Toggle <panel>" for a panel with an `enabled` option: flips options[key].enabled (the same key as the Settings row),
	 * saves and runs options.apply() (every panel's own sync is wrapped around it, as for Settings > Save).
	 * def: {id, title, key, icon, keywords, group, isOn: options => bool (default: enabled !== false), available: ctx => true | reason}
	 */
	panelToggle: function(def) {
		const key = def.key;
		const isOn = def.isOn || function(o) { return !(o && o[key] && o[key].enabled === false); };
		const current = function() { return typeof options !== "undefined" ? options : null; };
		return forkCommands.register({
			id: def.id, title: def.title, group: def.group || "Panels", icon: def.icon || "", keywords: (def.keywords || []).concat(["show", "hide", "panel"]),
			enabled: def.available || function() { return current() ? true : "Not available"; },
			hint: function() { return isOn(current()) ? "Shown now: this hides it" : "Hidden now: this shows it"; },
			run: function() {
				const o = current();
				o[key] = Object.assign({}, o[key], { enabled: !isOn(o) });
				if (typeof o.save === "function") { o.save(); }
				if (typeof o.apply === "function") { o.apply(); }
			}
		});
	},

	/** Dynamic items. opts.volatile: rebuilt on every open (default: cached until invalidate(name)) */
	provider: function(name, fn, opts) {
		if (!name || typeof fn !== "function") { throw new Error("forkCommands.provider: name and function are required"); }
		forkCommands.providers[name] = { fn: fn, volatile: !!(opts && opts.volatile), cache: null };
	},

	invalidate: function(name) {
		if (name === undefined) {
			Object.keys(forkCommands.providers).forEach(function(n) { forkCommands.providers[n].cache = null; });
		} else if (forkCommands.providers[name]) {
			forkCommands.providers[name].cache = null;
		}
	},

	/** Items of one provider; a broken provider gives no items instead of breaking the palette */
	providerItems: function(name, ctx) {
		const p = forkCommands.providers[name];
		if (!p) { return []; }
		if (p.cache && !p.volatile) { return p.cache; }
		let items = [];
		try { items = p.fn(ctx) || []; }
		catch (e) { console.error("palette: provider " + name + " failed", e); }
		p.cache = items;
		return items;
	},

	/** The command's own subtitle, "" if none (a broken hint never breaks the palette) */
	hint: function(c, ctx) {
		if (!c.hint) { return ""; }
		try { return String(c.hint(ctx) || ""); } catch (e) { return ""; }
	},

	/** The registered commands as palette item definitions, for the current ctx (enabled/context evaluated now) */
	items: function(ctx) {
		return forkCommands.commands.map(function(c) {
			let enabled = true;
			if (c.enabled) {
				try { enabled = c.enabled(ctx); }
				catch (e) { console.error("palette: " + c.id + ".enabled failed", e); enabled = "Not available"; }
			}
			let inContext = false;
			if (c.context) {
				try { inContext = !!c.context(ctx); } catch (e) { inContext = false; }
			}
			const disabled = enabled === true || enabled === undefined ? "" : (typeof enabled === "string" && enabled ? enabled : "Not available right now");
			return {
				key: "cmd:" + c.id, kind: "cmd", id: c.id, title: c.title, group: c.group, icon: c.icon || "", shortcut: c.shortcut || "",
				subtitle: disabled || forkCommands.hint(c, ctx) || c.group, keys: c.keywords.concat([c.group]), disabled: disabled,
				ctx: inContext && !disabled ? 120 : 0, inContext: inContext, command: c, args: c.args || null
			};
		});
	},

	/** Run a command. Resolves {ok: true} or {ok: false, error}; never throws (the caller shows the error) */
	execute: function(command, args, ctx) {
		try {
			const out = command.run(args || {}, ctx);
			if (out && typeof out.then === "function") {
				return out.then(function() { return { ok: true }; }, function(e) { return { ok: false, error: e }; });
			}
			return Promise.resolve({ ok: true });
		} catch (e) {
			return Promise.resolve({ ok: false, error: e });
		}
	}
};
