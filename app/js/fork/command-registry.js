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
	//     run: (args, ctx) => {}     required; may return a Promise; an exception becomes a red notification
	//   });
	//   forkCommands.provider("watchlist", ctx => [{key, kind, title, subtitle, icon, keys: [], run}]);
	//   forkCommands.invalidate("watchlist");   // its items are rebuilt on the next open
	//
	// ctx = {viewingSystemID, ...} built by the palette on open (lazy). Argument commands (`args`) come later.

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
				subtitle: disabled || c.group, keys: c.keywords.concat([c.group]), disabled: disabled,
				ctx: inContext && !disabled ? 120 : 0, inContext: inContext, command: c
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
