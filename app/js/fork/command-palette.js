const commandPalette = {
	// Fork-owned: the command palette (Ctrl+K / Cmd+K). Search systems, signatures, masks, settings and commands
	// from one box. The pure parts (guards, item builders, ranking in command-palette-index.js) are unit-tested; the
	// DOM part is below "---- DOM ----". Spec: reports/Command palette and inline edits spec.md (A1-A5, A8, A9).
	// Everything hooks from outside upstream: a capture-phase keydown, the existing globals, no upstream edits.

	STORAGE_KEY: "tw-palette-frecency",
	MAX_ROWS: 50,
	RECENTS: 5,
	EVE_INDEX_DELAY: 2000,

	KIND_LABEL: { chain: "Chain", eve: "System", sig: "Signature", mask: "Mask", setting: "Setting", cmd: "Command" },

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** Is this keydown the palette shortcut: Ctrl+K or Cmd+K, no other modifier */
	isToggleKey: function(e) {
		return !!e && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (String(e.key || "").toLowerCase() === "k" || e.code === "KeyK");
	},

	/** Whether the shortcut may open the palette. state: {enabled, editable (focus in CKEditor / contenteditable), modal (a modal dialog is open)} */
	canOpen: function(state) {
		return !!state && state.enabled !== false && !state.editable && !state.modal;
	},

	/** options.commandPalette.enabled: a missing key means on */
	enabled: function(o) {
		return !o || !o.commandPalette || o.commandPalette.enabled !== false;
	},

	// ---- Describing things ----

	/** "C3", "HS", "LS", "NS", "Trig" from an appData system */
	systemClass: function(sys) {
		if (!sys) { return ""; }
		const c = Array.isArray(sys.class) ? sys.class.join("/") : sys.class;
		if (c !== undefined && c !== null && c !== "" && c !== 0) { return "C" + c; }
		if (sys.factionID == 500026) { return "Trig"; }
		const sec = Number(sys.security);
		return sec >= 0.45 ? "HS" : sec > 0 ? "LS" : "NS";
	},

	regionName: function(sys, regions) {
		const r = sys && regions ? regions[sys.regionID] : null;
		return r && r.name ? String(r.name) : "";
	},

	/** "ABC-123" from a signature ID like "abc123" */
	formatSigID: function(id) {
		const s = String(id === undefined || id === null ? "" : id).toUpperCase();
		return s.length > 3 ? s.substring(0, 3) + "-" + s.substring(3) : s;
	},

	/** Palette item for any EVE system, from an appData.systems entry */
	eveItem: function(id, sys, regions) {
		const cls = commandPalette.systemClass(sys), region = commandPalette.regionName(sys, regions);
		return {
			key: "eve:" + id, kind: "eve", systemID: Number(id), title: sys.name, icon: "search",
			subtitle: [cls, region].filter(Boolean).join(" · "), keys: [], fuzzy: false, ctx: 0
		};
	},

	/**
	 * Palette items for the systems on the chain map. env: {rows (chain.data.map.rows), systems (appData.systems),
	 * regions, viewingID}. One item per system (first occurrence), keyed by name, J-code digits, hole name, class,
	 * static types and region (k-space). Systems next to the viewed one rank higher.
	 */
	chainItems: function(env) {
		const systems = env.systems || {}, rows = env.rows || [], viewingID = String(env.viewingID);
		const nodeSystem = {};
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (node && node.v !== undefined && node.v !== null) { nodeSystem[node.v] = String(node.systemID); }
		});
		const info = {}, order = [], near = {};
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || node.systemID === undefined || node.systemID === null) { return; }
			const id = String(node.systemID);
			const parentNode = row.c[1] && row.c[1].v !== null && row.c[1].v !== undefined ? nodeSystem[row.c[1].v] : undefined;
			if (parentNode !== undefined) {
				if (parentNode === viewingID) { near[id] = true; }
				if (id === viewingID) { near[parentNode] = true; }
			}
			if (info[id]) { return; }
			const path = row.pathHome || [];
			const last = path.length ? path[path.length - 1] : null;
			info[id] = { jumps: path.length, hole: last && last.name ? String(last.name).trim() : "", root: !path.length };
			order.push(id);
		});
		if (!info[viewingID] && systems[viewingID]) { info[viewingID] = { jumps: 0, hole: "", root: true, solo: true }; order.push(viewingID); }

		return order.filter(function(id) { return systems[id] && systems[id].name; }).map(function(id) {
			const sys = systems[id], meta = info[id], cls = commandPalette.systemClass(sys), region = commandPalette.regionName(sys, env.regions);
			const name = String(sys.name), jcode = /^J\d{6}$/i.test(name);
			const statics = Array.isArray(sys.statics) ? sys.statics.map(String) : [];
			const keys = [name, cls, meta.hole, (/^[A-Z0-9]+/i.exec(meta.hole) || [""])[0]].concat(statics);	// "AA - DRIFTER": "AA" finds the system behind hole AA
			if (jcode) { keys.push(name.substring(1)); }
			if (!sys.class && region) { keys.push(region); }
			const here = id === viewingID;
			const sub = [cls, here ? "viewing" : (meta.root ? "chain root" : "on chain"), meta.hole, meta.jumps > 0 ? meta.jumps + (meta.jumps === 1 ? " jump" : " jumps") : ""];
			return {
				key: "sys:" + id, kind: "chain", systemID: Number(id), title: name, icon: "tree",
				subtitle: sub.filter(Boolean).join(" · "), keys: keys, pin: jcode, ctx: here ? 120 : near[id] ? 60 : 0
			};
		});
	},

	/** Palette items for the signatures of the viewed system. signatures: tripwire.client.signatures */
	sigItems: function(signatures, wormholes, systemID) {
		const out = [];
		Object.keys(signatures || {}).forEach(function(k) {
			const s = signatures[k];
			if (!s || !s.signatureID || String(s.systemID) !== String(systemID)) { return; }
			let type = s.type || "";
			const wh = Object.keys(wormholes || {}).map(function(w) { return wormholes[w]; }).filter(function(w) {
				return w && (w.initialID == s.id || w.secondaryID == s.id);
			})[0];
			if (s.type === "wormhole") { type = wh && wh.type ? "wormhole " + wh.type : "wormhole"; }
			out.push({
				key: "sig:" + s.id, kind: "sig", sigID: s.id, title: commandPalette.formatSigID(s.signatureID), icon: "pin",
				subtitle: [type, s.name].filter(Boolean).join(" · "), keys: [s.signatureID], pin: true, ctx: 120
			});
		});
		return out;
	},

	maskItems: function(masks) {
		return (masks || []).filter(function(m) { return m && m.label && (m.owner || m.joined || m.joinedBy === "alliance" || m.active); }).map(function(m) {
			return {
				key: "mask:" + m.mask, kind: "mask", maskID: m.mask, title: String(m.label), icon: "eye",
				subtitle: m.active ? "Mask · active" : "Mask", keys: ["mask"], ctx: 0
			};
		});
	},

	/** Settings rows read from the Settings dialog's DOM (upstream rows and every fork row, with their keywords) */
	settingItems: function(accordion) {
		const out = [];
		if (!accordion) { return out; }
		const children = Array.prototype.slice.call(accordion.children);
		children.forEach(function(h3, i) {
			if (h3.tagName !== "H3") { return; }
			const div = children[i + 1];
			if (!div) { return; }
			const section = (h3.textContent || "").trim();
			Array.prototype.forEach.call(div.querySelectorAll("table.optionsTable > tbody > tr, table.optionsTable > tr"), function(tr) {
				const control = tr.querySelector("input, select, textarea, button");
				if (!control) { return; }
				const th = tr.querySelector("th");
				let label = th ? th.textContent : "";
				if (!label.trim()) {
					const l = tr.querySelector("label");
					label = l ? l.textContent : (tr.textContent || "");
				}
				label = label.replace(/\s+/g, " ").replace(/:\s*$/, "").trim();
				if (!label || label.length > 80) { return; }
				const tbody = tr.parentNode;
				const kw = tbody && tbody.getAttribute ? (tbody.getAttribute("data-fs-keywords") || "") : "";
				out.push({
					key: "set:" + (control.id || section + "/" + label), kind: "setting", title: label, icon: "settings",
					subtitle: "Settings · " + section, keys: [section].concat(kw.split(/\s+/)), row: tr, ctx: 0
				});
			});
		});
		return out;
	},

	// ---- Frecency (recents) ----

	loadFrecency: function() {
		try {
			const data = JSON.parse(localStorage.getItem(commandPalette.STORAGE_KEY) || "{}");
			const out = {};
			if (data && typeof data === "object" && !Array.isArray(data)) {
				Object.keys(data).forEach(function(k) {
					const r = data[k];
					if (r && typeof r === "object" && isFinite(r.n) && isFinite(r.t)) { out[k] = { n: Number(r.n), t: Number(r.t) }; }
				});
			}
			return out;
		} catch (e) { return {}; }
	},

	saveFrecency: function(map) {
		try { localStorage.setItem(commandPalette.STORAGE_KEY, JSON.stringify(map)); } catch (e) { /* storage unavailable */ }
	},

	// ---- Screen-reader text (pure, tested) ----

	/** Full spoken label of a result: title, kind, detail, shortcut, why it is unavailable */
	optionLabel: function(it) {
		const parts = [it.title, it.tag || commandPalette.KIND_LABEL[it.kind] || ""];
		if (it.subtitle) { parts.push(it.disabled ? "unavailable: " + it.subtitle : it.subtitle); }
		else if (it.disabled) { parts.push("unavailable"); }
		if (it.shortcut) { parts.push("shortcut " + it.shortcut); }
		return parts.filter(Boolean).join(", ");
	},

	/** Name of the search box for the current mode (the breadcrumb chip is visual only) */
	inputLabel: function(st) {
		const base = "Search systems, signatures, settings and commands";
		if (st && st.cmd && st.cmd.args[st.cmd.step]) {
			const arg = st.cmd.args[st.cmd.step];
			return st.cmd.command.title + ": choose the " + (arg.label || arg.name);
		}
		if (st && st.noun) { return "Actions for " + st.noun.item.title; }
		if (st && st.scope && st.scope.label) { return "Search " + st.scope.label.toLowerCase(); }
		return base;
	},

	/** What the live region says after a search: the mode and the number of results */
	liveText: function(st, n) {
		const count = n ? n + (n === 1 ? " result" : " results") : "No results";
		if (st && st.cmd && st.cmd.args[st.cmd.step]) { return commandPalette.inputLabel(st) + ". " + count; }
		if (st && st.noun) { return "Actions for " + st.noun.item.title + ". " + (n ? n + (n === 1 ? " action" : " actions") : "No actions"); }
		return count;
	},

	// ---- Rows of the result list ----

	/** Rows for an empty query: recents, the viewed system's context commands, then every command by group.
	 *  items: all indexed items; recentKeys: item keys, most recent first. Returns [{header} | {item}] */
	emptyRows: function(items, recentKeys, groups, viewName, makeEve) {
		const byKey = {};
		items.forEach(function(it) { byKey[it.key] = it; });
		const used = {}, rows = [];
		const add = function(item) { used[item.key] = true; rows.push({ item: item }); };

		const recents = [];
		(recentKeys || []).forEach(function(k) {
			const it = byKey[k] || (makeEve && /^eve:/.test(k) ? makeEve(k.substring(4)) : null);
			if (it && recents.length < commandPalette.RECENTS) { recents.push(it); }
		});
		if (recents.length) { rows.push({ header: "Recent" }); recents.forEach(add); }

		const ctxCommands = items.filter(function(it) { return it.kind === "cmd" && it.inContext && !it.disabled && !used[it.key]; });
		if (ctxCommands.length) {
			rows.push({ header: "For " + (viewName || "this system") });
			ctxCommands.slice(0, 6).forEach(add);
		}

		(groups || []).forEach(function(g) {
			const list = items.filter(function(it) { return it.kind === "cmd" && it.group === g && !used[it.key]; });
			if (!list.length || rows.length >= commandPalette.MAX_ROWS) { return; }
			rows.push({ header: g });
			list.forEach(add);
		});
		return rows.slice(0, commandPalette.MAX_ROWS + 8);
	},

	/** Rows for a scope prefix with nothing typed yet (# signatures, @ chain systems, , settings): everything in the scope,
	 *  the viewed system's and its neighbours' first */
	scopeRows: function(items, scope) {
		const list = items.filter(function(it) { return scope.kinds[it.kind]; }).sort(function(a, b) {
			return (b.ctx || 0) - (a.ctx || 0) || (String(a.title).toLowerCase() < String(b.title).toLowerCase() ? -1 : 1);
		}).slice(0, commandPalette.MAX_ROWS);
		return list.length ? [{ header: scope.label }].concat(list.map(function(it) { return { item: it }; })) : [];
	},

	/** Markup of a title with the matched characters in <mark> (bold + underline, not colour alone) */
	titleHtml: function(title, hits) {
		const esc = commandPalette.escape, text = String(title);
		if (!hits || !hits.length) { return esc(text); }
		const set = {};
		hits.forEach(function(i) { set[i] = true; });
		let out = "", open = false;
		for (let i = 0; i < text.length; i++) {
			if (set[i] && !open) { out += "<mark>"; open = true; }
			if (!set[i] && open) { out += "</mark>"; open = false; }
			out += esc(text.charAt(i));
		}
		return out + (open ? "</mark>" : "");
	},

	/** Index of the next selectable row from `from` in direction `step` (+1/-1), wrapping; -1 if there is none */
	moveSelection: function(rows, from, step) {
		const n = rows.length;
		if (!n) { return -1; }
		let i = from;
		for (let k = 0; k < n; k++) {
			i = (i + step + n) % n;
			if (rows[i].item) { return i; }
		}
		return -1;
	},

	// ---- DOM (browser only) ----

	state: {
		open: false, rows: [], sel: -1, scope: { char: "", label: "", kinds: null, rest: "" }, query: "", prev: null, index: null, items: [],
		previousFocus: null, ctx: null, frecency: {}, eve: null, mouse: [0, 0], liveTimer: null, chainStamp: null, settingStamp: null,
		perf: { last: 0, samples: [], open: 0 }, cmd: null, noun: null, argCache: {}, argCommands: []
	},

	hasDOM: function() {
		return typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined";
	},

	init: function() {
		if (!commandPalette.hasDOM() || commandPalette.initialized) { return; }
		commandPalette.initialized = true;
		if (typeof forkSettings !== "undefined") {
			forkSettings.register({
				section: "general", order: 40, id: "commandPalette-enabled", type: "checkbox", key: "commandPalette",
				label: "Command palette:", text: "Command palette (Ctrl+K, Cmd+K on Mac)",
				hint: "Search systems, signatures, settings and commands",
				keywords: "ctrl k search find go to jump command quick open",
				get: function(o) { return commandPalette.enabled(o); },
				set: function(o, on) { o.commandPalette = { enabled: !!on }; }
			});
		}
		commandPalette.registerCommands();
		commandPalette.registerProviders();
		// Capture phase: works inside text inputs and runs before upstream's jQuery key handler
		document.addEventListener("keydown", commandPalette.onGlobalKey, true);
		const idle = function() { commandPalette.ensureEve(); };
		setTimeout(function() {
			if (typeof requestIdleCallback === "function") { requestIdleCallback(idle, { timeout: 4000 }); } else { idle(); }
		}, commandPalette.EVE_INDEX_DELAY);
	},

	currentOptions: function() { return typeof options !== "undefined" ? options : null; },

	/** Focus is in CKEditor or any contenteditable (Ctrl+K inserts a link there) */
	inEditable: function() {
		const el = document.activeElement;
		if (!el) { return false; }
		if (el.isContentEditable) { return true; }
		return !!(el.closest && el.closest("[contenteditable]:not([contenteditable='false']), .cke_editable, .cke"));
	},

	modalOpen: function() {
		return $(".ui-widget-overlay:visible").length > 0;
	},

	onGlobalKey: function(e) {
		if (!commandPalette.isToggleKey(e)) { return; }
		if (e.repeat) { e.preventDefault(); return; }
		if (commandPalette.state.open) {
			e.preventDefault();
			e.stopPropagation();
			commandPalette.close(true);
			return;
		}
		if (!commandPalette.canOpen({ enabled: commandPalette.enabled(commandPalette.currentOptions()), editable: commandPalette.inEditable(), modal: commandPalette.modalOpen() })) { return; }
		e.preventDefault();
		e.stopPropagation();
		commandPalette.open();
	},

	// ---- Sources ----

	/** Lazy per-open context handed to commands */
	makeContext: function() {
		let chainIds = null;
		return {
			viewingSystemID: typeof viewingSystemID !== "undefined" ? viewingSystemID : undefined,
			trackedCharacterID: commandPalette.currentOptions() && options.tracking ? options.tracking.active : undefined,
			selectedSigIDs: function() {
				return $("#sigTable tbody tr.selected").map(function() { return $(this).data("id"); }).get();
			},
			holes: function() { return commandPalette.holeDefs(this); },
			chainSystems: function() {
				if (!chainIds) {
					chainIds = [];
					((typeof chain !== "undefined" && chain.data && chain.data.map && chain.data.map.rows) || []).forEach(function(r) {
						const id = r && r.c && r.c[0] && r.c[0].systemID;
						if (id !== undefined && chainIds.indexOf(String(id)) < 0) { chainIds.push(String(id)); }
					});
				}
				return chainIds;
			}
		};
	},

	chainRows: function() {
		return (typeof chain !== "undefined" && chain && chain.data && chain.data.map && chain.data.map.rows) || [];
	},

	/** The wormholes on the chain map (cached on the ctx): [{key, value: wormhole id, token, systemID, parentSystemID, title, ...}] */
	holeDefs: function(ctx) {
		if (!ctx._holes) {
			ctx._holes = typeof tripwire !== "undefined" && tripwire.client && typeof appData !== "undefined"
				? paletteArgs.holes({ rows: commandPalette.chainRows(), wormholes: tripwire.client.wormholes, systems: appData.systems, viewingID: ctx.viewingSystemID }) : [];
		}
		return ctx._holes;
	},

	registerProviders: function() {
		forkCommands.provider("palette.chain", function(ctx) {
			return commandPalette.chainItems({
				rows: commandPalette.chainRows(), systems: appData.systems, regions: appData.regions, viewingID: ctx.viewingSystemID
			});
		});
		forkCommands.provider("palette.sigs", function(ctx) {
			return typeof tripwire !== "undefined" && tripwire.client
				? commandPalette.sigItems(tripwire.client.signatures, tripwire.client.wormholes, ctx.viewingSystemID) : [];
		}, { volatile: true });
		forkCommands.provider("palette.masks", function() {
			return typeof tripwire !== "undefined" ? commandPalette.maskItems(tripwire.masks) : [];
		}, { volatile: true });
		forkCommands.provider("palette.settings", function() {
			return commandPalette.settingItems(document.getElementById("optionsAccordion"));
		});
	},

	/** The chain and Settings providers are cached; rebuild them when the chain map redrew, the viewed system
	 *  changed or the Settings dialog gained rows */
	refreshStale: function(ctx) {
		const rows = commandPalette.chainRows();
		const stamp = rows === commandPalette.state.chainStamp1 && ctx.viewingSystemID === commandPalette.state.chainStamp2;
		if (!stamp) {
			forkCommands.invalidate("palette.chain");
			commandPalette.state.chainStamp1 = rows;
			commandPalette.state.chainStamp2 = ctx.viewingSystemID;
		}
		const n = document.querySelectorAll("#optionsAccordion tr").length;
		if (n !== commandPalette.state.settingStamp) {
			forkCommands.invalidate("palette.settings");
			commandPalette.state.settingStamp = n;
		}
	},

	/** Index of the EVE systems, built once (idle after load, or on first open) */
	ensureEve: function() {
		const st = commandPalette.state;
		if (st.eve || typeof appData === "undefined" || !appData.systems) { return st.eve; }
		st.eve = paletteIndex.buildEve(appData.systems, function(j) {
			const id = st.eve.ids[j];
			return commandPalette.eveItem(id, appData.systems[id], appData.regions);
		});
		return st.eve;
	},

	buildIndex: function(ctx) {
		const st = commandPalette.state;
		commandPalette.refreshStale(ctx);
		const defs = forkCommands.items(ctx);
		Object.keys(forkCommands.providers).forEach(function(name) {
			forkCommands.providerItems(name, ctx).forEach(function(d) { defs.push(d); });
		});
		const items = defs.map(paletteIndex.item);
		const skip = {};
		items.forEach(function(it) { if (it.kind === "chain") { skip[it.systemID] = true; } });
		st.items = items;
		st.argCommands = items.filter(function(it) { return it.command && it.command.args && it.command.args.length; });
		st.index = paletteIndex.build(items, commandPalette.ensureEve(), skip);
		st.prev = null;
		st.argCache = {};
	},

	// ---- Arguments (A6): candidates, one-line commands, the step by step flow ----

	/** Prepared candidates (index items) of an argument; strict: no fuzzy matching (one-line commands). Cached per open. */
	argCandidates: function(command, arg, strict) {
		const st = commandPalette.state, cacheKey = command.id + "|" + arg.name + (strict ? "|s" : "");
		if (st.argCache[cacheKey]) { return st.argCache[cacheKey]; }
		let list = [];
		const pass = function(c) {
			if (!arg.filter) { return true; }
			try { return !!arg.filter(c.value, st.ctx); } catch (e) { return false; }
		};
		// The candidates of a type are prepared once per open and shared by every command that takes that type
		const shared = function(type, make) { return st.argCache["*" + type] || (st.argCache["*" + type] = make()); };
		if (arg.type === "chainSystem") { list = shared(arg.type, function() { return paletteArgs.chainSystems(st.items); }); }
		else if (arg.type === "hole") { list = shared(arg.type, function() { return commandPalette.holeDefs(st.ctx).map(paletteIndex.item); }); }
		else if (arg.type === "signature") { list = shared(arg.type, function() { return paletteArgs.signatures(st.items); }); }
		else if (arg.type === "choice") {
			try { list = paletteArgs.choices(arg.choices(st.ctx)).map(paletteIndex.item); } catch (e) { console.error("palette: choices of " + arg.name + " failed", e); }
		}
		list = list.filter(pass);
		if (strict) { list = list.map(function(c) { return Object.assign({}, c, { fuzzy: false }); }); }
		st.argCache[cacheKey] = list;
		return list;
	},

	/** Candidates of an argument ranked against typed text (best first, each with .score); [] if none */
	argRank: function(command, arg, text, strict, limit) {
		const t = String(text === undefined || text === null ? "" : text).trim();
		if (!t) { return []; }
		if (arg.type === "text") { return [{ key: "text:" + t, kind: "arg", value: t, title: t, subtitle: "", tag: "Text", score: 1000 }]; }
		if (arg.type === "system") {
			const eve = commandPalette.ensureEve();
			if (!eve) { return []; }
			return paletteIndex.search(paletteArgs.index([], eve), t, { limit: limit || 20 }).results.map(function(it) {
				return Object.assign({}, it, { kind: "arg", value: it.systemID, tag: "System" });
			});
		}
		return paletteArgs.rank(commandPalette.argCandidates(command, arg, strict), t, limit || 20);
	},

	/** The default value of an argument as a candidate, or null */
	argDefault: function(command, arg) {
		if (!arg.default) { return null; }
		const st = commandPalette.state;
		let v;
		try { v = arg.default(st.ctx); } catch (e) { return null; }
		if (v === undefined || v === null || v === "") { return null; }
		const found = arg.type === "system" || arg.type === "text" ? null
			: commandPalette.argCandidates(command, arg).filter(function(c) { return String(c.value) === String(v); })[0];
		if (found) { return found; }
		if (arg.type === "system" && typeof appData !== "undefined" && appData.systems[v]) {
			return { key: "eve:" + v, kind: "arg", value: Number(v), title: appData.systems[v].name, subtitle: "", tag: "System" };
		}
		return arg.type === "text" ? { key: "text:" + v, kind: "arg", value: v, title: String(v), tag: "Text" } : null;
	},

	/** Result rows for a one-line command typed in the box ("fight AA", "mark rolling A", "life eol B2") */
	inlineItems: function(query) {
		const st = commandPalette.state;
		if (!/\S\s+\S/.test(query)) { return []; }
		const commands = st.argCommands.filter(function(it) { return !it.disabled; }).map(function(it) { return it.command; });
		if (!commands.length) { return []; }
		const descs = paletteArgs.inline(commands, query, {
			resolve: function(arg, text, command) { return commandPalette.argRank(command, arg, text, true, 8); },
			defaultFor: function(arg, command) { return commandPalette.argDefault(command, arg); }
		});
		return descs.map(commandPalette.inlineItem);
	},

	inlineItem: function(d) {
		const cmd = d.command, args = cmd.args;
		const crumb = paletteArgs.breadcrumb(cmd, args, d.filled);
		const vals = args.map(function(a, i) { return d.filled[i] ? String(d.filled[i].value) : ""; }).join(",");
		const detail = args.map(function(a, i) { return d.filled[i] && a.type !== "choice" ? d.filled[i].subtitle : ""; }).filter(Boolean)[0];
		return {
			key: "inline:" + cmd.id + ":" + vals, freqKey: "cmd:" + cmd.id, kind: "cmd", title: crumb + (d.complete ? "" : " ›"),
			subtitle: (d.complete ? "Enter runs it" : "Enter asks for the " + (args[d.next].label || args[d.next].name)) + (detail ? " · " + detail : ""), icon: cmd.icon || "", tag: "Command",
			inline: d, command: cmd, disabled: ""
		};
	},

	/** Start the argument steps of a command (filled: {argIndex: candidate} already known) */
	startCommand: function(command, filled) {
		const st = commandPalette.state, input = document.getElementById("cp-input");
		st.cmd = { command: command, args: command.args, filled: filled || {}, skipped: {}, step: -1 };
		st.noun = null;
		commandPalette.touch("cmd:" + command.id);
		input.value = "";
		st.scope = paletteIndex.parseScope("");
		const next = commandPalette.nextStep();
		if (next < 0) { commandPalette.runCommand(); return; }
		st.cmd.step = next;
		commandPalette.renderChip();
		commandPalette.update();
	},

	/** Index of the next argument to ask for, or -1. An optional argument without candidates is skipped. */
	nextStep: function() {
		const c = commandPalette.state.cmd;
		for (let i = 0; i < c.args.length; i++) {
			if (c.filled[i] || c.skipped[i]) { continue; }
			const arg = c.args[i];
			if (arg.optional && (arg.type === "choice" || arg.type === "chainSystem" || arg.type === "hole" || arg.type === "signature")
				&& !commandPalette.argCandidates(c.command, arg).length) { c.skipped[i] = true; continue; }
			return i;
		}
		return -1;
	},

	acceptArg: function(item) {
		const st = commandPalette.state, c = st.cmd, input = document.getElementById("cp-input");
		if (item.skip) { c.skipped[c.step] = true; } else { c.filled[c.step] = item; }
		input.value = "";
		const next = commandPalette.nextStep();
		if (next < 0) { commandPalette.runCommand(); return; }
		c.step = next;
		commandPalette.renderChip();
		commandPalette.update();
	},

	/** Backspace on an empty box: take back the last argument, or leave the command */
	stepBack: function() {
		const st = commandPalette.state, c = st.cmd;
		let last = -1;
		for (let i = 0; i < c.args.length; i++) { if (c.filled[i] || c.skipped[i]) { last = i; } }
		if (last < 0) { st.cmd = null; } else { delete c.filled[last]; delete c.skipped[last]; c.step = last; }
		document.getElementById("cp-input").value = "";
		commandPalette.renderChip();
		commandPalette.update();
	},

	runCommand: function() {
		const st = commandPalette.state, c = st.cmd;
		const values = paletteArgs.values(c.args, c.filled);
		st.cmd = null;
		commandPalette.close(true);
		commandPalette.activate({ command: c.command, title: c.command.title, key: "cmd:" + c.command.id }, st.ctx, values);
	},

	runInline: function(item) {
		const d = item.inline;
		if (!d.complete) { commandPalette.startCommand(d.command, d.filled); return; }
		commandPalette.touch("cmd:" + d.command.id);
		commandPalette.close(true);
		commandPalette.activate({ command: d.command, title: d.command.title, key: "cmd:" + d.command.id }, commandPalette.state.ctx, paletteArgs.values(d.command.args, d.filled));
	},

	touch: function(key) {
		const st = commandPalette.state;
		paletteIndex.frecencyTouch(st.frecency, key);
		commandPalette.saveFrecency(st.frecency);
	},

	/** Rows of the current argument step: a header, "skip" when optional, then the candidates */
	stepRows: function(query) {
		const st = commandPalette.state, c = st.cmd, arg = c.args[c.step];
		const rows = [{ header: c.command.title + " › " + (arg.label || arg.name) }];
		if (arg.optional) { rows.push({ item: { key: "skip", kind: "arg", skip: true, title: "Skip", subtitle: "Leave out the " + (arg.label || arg.name), tag: "Skip", icon: "" } }); }
		let list;
		if (paletteIndex.normalise(query) || arg.type === "text") { list = commandPalette.argRank(c.command, arg, query, false, commandPalette.MAX_ROWS); }
		else {
			const def = commandPalette.argDefault(c.command, arg);
			list = arg.type === "system" ? (def ? [def] : [])
				: paletteArgs.listAll(commandPalette.argCandidates(c.command, arg), def ? def.value : undefined).slice(0, commandPalette.MAX_ROWS);
		}
		list.forEach(function(it) { rows.push({ item: it, hits: query ? paletteIndex.highlight(it.title, query) : [] }); });
		return rows;
	},

	// ---- Actions on a result: noun, then verb (the right arrow on a system or signature) ----

	NOUN_KINDS: { chain: true, eve: true, sig: true },

	/** The candidate for a command's first argument that stands for the noun, or null when the command doesn't fit it */
	nounCandidate: function(command, noun) {
		const st = commandPalette.state, arg = command.args[0], sys = noun.kind === "chain" || noun.kind === "eve";
		const find = function(id) {
			return commandPalette.argCandidates(command, arg).filter(function(c) { return String(c.value) === String(id); })[0] || null;
		};
		if (arg.type === "chainSystem") { return noun.kind === "chain" ? find(noun.systemID) : null; }
		if (arg.type === "system") {
			return sys ? { key: "eve:" + noun.systemID, kind: "arg", value: noun.systemID, title: noun.title, subtitle: noun.subtitle, tag: "System" } : null;
		}
		if (arg.type === "signature") { return noun.kind === "sig" ? find(noun.sigID) : null; }
		if (arg.type === "hole") {
			let id = null;
			if (noun.kind === "chain") {
				const h = commandPalette.holeDefs(st.ctx).filter(function(d) { return String(d.systemID) === String(noun.systemID); })[0];
				id = h ? h.value : null;	// the hole leading into that system
			} else if (noun.kind === "sig" && typeof tripwire !== "undefined" && tripwire.client) {
				const wh = Object.keys(tripwire.client.wormholes || {}).map(function(k) { return tripwire.client.wormholes[k]; }).filter(function(w) {
					return w && (String(w.initialID) === String(noun.sigID) || String(w.secondaryID) === String(noun.sigID));
				})[0];
				id = wh ? wh.id : null;
			}
			return id === null ? null : find(id);
		}
		return null;
	},

	/** Actions of a system or signature result: the built-in ones, then every command whose first argument is that noun.
	 *  A command that needs more arguments continues with the steps (the noun is already filled in). */
	actionsFor: function(noun) {
		const st = commandPalette.state, out = [];
		if (noun.kind === "chain" || noun.kind === "eve") {
			out.push({ key: "act:goto", kind: "act", title: "Go to " + noun.title, subtitle: "View this system", icon: "viewing", tag: "System",
				run: function() { tripwire.systemChange(noun.systemID); } });
		} else if (noun.kind === "sig") {
			out.push({ key: "act:select", kind: "act", title: "Select " + noun.title, subtitle: "Select the signature in the table", icon: "pin", tag: "Signature",
				run: function() { commandPalette.selectSig(noun.sigID); } });
			out.push({ key: "act:edit", kind: "act", title: "Edit " + noun.title, subtitle: "Open the signature dialog", icon: "edit", tag: "Signature",
				run: function() { commandPalette.selectSig(noun.sigID); setTimeout(function() { $("#edit-signature").trigger("click"); }, 0); } });
		}
		st.argCommands.forEach(function(it) {
			const cand = commandPalette.nounCandidate(it.command, noun);
			if (!cand) { return; }
			const d = paletteArgs.finish(it.command, { 0: cand }, function(a) { return commandPalette.argDefault(it.command, a); });
			out.push({
				key: "act:" + it.command.id, kind: "act", title: it.command.title, icon: it.icon || "", tag: it.group, disabled: it.disabled,
				subtitle: it.disabled || (d.complete ? forkCommands.hint(it.command, st.ctx) : "Asks for the " + (it.command.args[d.next].label || it.command.args[d.next].name)),
				inline: { command: it.command, filled: d.filled, complete: d.complete, next: d.next }, command: it.command
			});
		});
		return out;
	},

	/** Open the action list of the selected result; false when it has none (not a system or signature) */
	openActions: function() {
		const st = commandPalette.state, input = document.getElementById("cp-input"), row = st.rows[st.sel];
		if (st.cmd || st.noun || !row || !row.item || !commandPalette.NOUN_KINDS[row.item.kind]) { return false; }
		st.noun = { item: row.item, prepared: commandPalette.actionsFor(row.item).map(paletteIndex.item), query: input.value };
		input.value = "";
		commandPalette.renderChip();
		commandPalette.update();
		return true;
	},

	/** Back from the action list to the results (and the text) it was opened from */
	leaveActions: function() {
		const st = commandPalette.state, input = document.getElementById("cp-input");
		const q = st.noun ? st.noun.query : "";
		st.noun = null;
		input.value = q;
		st.prev = null;
		commandPalette.renderChip();
		commandPalette.update();
	},

	actionRows: function(query) {
		const st = commandPalette.state, n = st.noun;
		const rows = [{ header: "Actions for " + n.item.title }];
		const list = paletteIndex.normalise(query) ? paletteArgs.rank(n.prepared, query, commandPalette.MAX_ROWS) : n.prepared;
		list.forEach(function(it) { rows.push({ item: it, hits: query ? paletteIndex.highlight(it.title, query) : [] }); });
		return rows;
	},

	// ---- History and timing ----

	clearHistory: function() {
		const st = commandPalette.state;
		st.frecency = {};
		try { localStorage.removeItem(commandPalette.STORAGE_KEY); } catch (e) { /* storage unavailable */ }
		if (typeof Notify !== "undefined") { Notify.trigger("Palette history cleared", "green"); }
	},

	/** Timing summary of the searches since the page loaded: {n, median, p95, max (ms per keystroke), open (ms, last open)} */
	perfReport: function() {
		const st = commandPalette.state, s = st.perf.samples.slice().sort(function(a, b) { return a - b; });
		const at = function(p) { return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
		return { n: s.length, median: at(0.5), p95: at(0.95), max: s.length ? s[s.length - 1] : 0, open: st.perf.open };
	},

	// ---- Acting on an item ----

	activate: function(item, ctx, values) {
		const notify = function(text, color) { if (typeof Notify !== "undefined") { Notify.trigger(commandPalette.escape(text), color); } };
		try {
			if (item.command) {
				forkCommands.execute(item.command, values || {}, ctx).then(function(r) {
					if (!r.ok) { notify("Could not run \"" + item.title + "\": " + (r.error && r.error.message || r.error), "red"); }
				});
			} else if (item.kind === "chain" || item.kind === "eve") {
				tripwire.systemChange(item.systemID);
			} else if (item.kind === "sig") {
				commandPalette.selectSig(item.sigID);
			} else if (item.kind === "mask") {
				maskFunctions.updateActiveMask(item.maskID);
			} else if (item.kind === "setting") {
				commandPalette.openSetting(item.row);
			} else if (typeof item.run === "function") {
				const out = item.run(ctx);
				if (out && typeof out.catch === "function") { out.catch(function(e) { notify("Could not run \"" + item.title + "\": " + (e && e.message || e), "red"); }); }
			}
		} catch (e) {
			console.error("palette: " + item.key + " failed", e);
			notify("Could not run \"" + item.title + "\": " + (e && e.message || e), "red");
		}
	},

	selectSig: function(id) {
		const tr = document.querySelector("#sigTable tbody tr[data-id='" + id + "']");
		if (!tr) { return; }
		$("#sigTable tbody tr.selected").removeClass("selected");
		$(tr).addClass("selected");
		if (tr.scrollIntoView) { tr.scrollIntoView({ block: "nearest" }); }
	},

	/** Open Settings at a row: expand its section, scroll to it, flash it for 1.5 s and focus its control */
	openSetting: function(tr) {
		if (!tr || !document.body.contains(tr)) { return; }
		$("#settings").trigger("click");
		let tries = 0;
		const go = function() {
			const visible = $("#dialog-options").is(":visible");
			if (!visible && tries++ < 20) { setTimeout(go, 50); return; }
			if (typeof forkSettings !== "undefined" && forkSettings.filter) { forkSettings.filter(""); }	// a filter would hide the row
			const $acc = $("#optionsAccordion");
			const $div = $(tr).closest("#optionsAccordion > div");
			if ($acc.hasClass("ui-accordion") && $div.length) {
				$acc.accordion("option", "active", $acc.children("div").index($div));
			}
			setTimeout(function() {
				if (tr.scrollIntoView) { tr.scrollIntoView({ block: "center" }); }
				$(tr).addClass("cp-flash");
				setTimeout(function() { $(tr).removeClass("cp-flash"); }, 1500);
				const control = tr.querySelector("input, select, textarea, button");
				if (control && control.focus) { control.focus(); }
			}, 300);
		};
		go();
	},

	// ---- Upstream commands (each calls the code the menu / toolbar does) ----

	onChain: function(id) {
		return !!id && $("#chainMap [data-nodeid='" + id + "']").length > 0;
	},

	registerCommands: function() {
		const add = function(def) { forkCommands.register(def); };
		const kspace = function(ctx) {
			const sys = typeof appData !== "undefined" ? appData.systems[ctx.viewingSystemID] : null;
			if (!sys || sys.class) { return "Only for k-space systems"; }
			if (typeof tripwire === "undefined" || !tripwire.esi || !tripwire.esi.characters || !tripwire.esi.characters[options.tracking.active]) {
				return "Needs a tracked character";
			}
			return true;
		};
		const click = function(sel, reason) {
			return function() { return $(sel).hasClass("disabled") ? reason : true; };
		};
		const nodeOf = function(ctx) { return $("#chainMap [data-nodeid='" + ctx.viewingSystemID + "']").first(); };
		const onChain = function(ctx) { return commandPalette.onChain(ctx.viewingSystemID) ? true : "Not on the chain map"; };
		const flare = function(color) {
			return function(args, ctx) { $("#chainParent").contextmenu("setFlare", ctx.viewingSystemID, color, {}); };
		};
		const flareEnabled = function(color) {
			return function(ctx) {
				if (!commandPalette.onChain(ctx.viewingSystemID)) { return "Not on the chain map"; }
				return nodeOf(ctx).hasClass(color + "Node") ? "Already " + color : true;
			};
		};

		add({ id: "nav.setDestination", title: "Set destination", group: "Navigation", icon: "follow", keywords: ["autopilot", "route", "in game"],
			enabled: kspace, context: function() { return true; },
			run: function(args, ctx) { tripwire.esi.setDestination(ctx.viewingSystemID, options.tracking.active, true); } });
		add({ id: "nav.addWaypoint", title: "Add waypoint", group: "Navigation", icon: "follow", keywords: ["autopilot", "route", "in game"],
			enabled: kspace,
			run: function(args, ctx) { tripwire.esi.setDestination(ctx.viewingSystemID, options.tracking.active, false); } });
		add({ id: "nav.toggleFollow", title: "Toggle follow", group: "Navigation", icon: "follow", keywords: ["tracking", "my system"],
			run: function() { $("#follow").trigger("click"); } });
		add({ id: "nav.copyName", title: "Copy system name", group: "Navigation", context: function() { return true; },
			run: function(args, ctx) { return navigator.clipboard.writeText(appData.systems[ctx.viewingSystemID].name); } });
		add({ id: "nav.makeTab", title: "Make tab", group: "Navigation", icon: "plus", keywords: ["chain tab", "new tab"],
			run: function(args, ctx) { commandPalette.makeTab(ctx.viewingSystemID); } });
		add({ id: "nav.collapse", title: "Collapse", group: "Navigation", icon: "minus", keywords: ["chain", "fold", "expand"],
			enabled: function(ctx) { return commandPalette.onChain(ctx.viewingSystemID) && chain.renderer && chain.renderer.collapse ? true : "Not on the chain map"; },
			run: function(args, ctx) {
				const tab = options.chain.tabs[options.chain.active];
				chain.renderer.collapse(Number(ctx.viewingSystemID), tab ? $.inArray(Number(ctx.viewingSystemID), tab.collapsed) === -1 : true);
			} });

		add({ id: "sig.add", title: "Add signature", group: "Signatures", icon: "plus", keywords: ["new"], context: function() { return true; },
			run: function() { $("#add-signature").trigger("click"); } });
		add({ id: "sig.edit", title: "Edit selected signature", group: "Signatures", icon: "edit", keywords: ["change"],
			enabled: click("#edit-signature", "Select exactly one signature first"),
			run: function() { $("#edit-signature").trigger("click"); } });
		add({ id: "sig.undo", title: "Undo", group: "Signatures", icon: "undo", shortcut: "Ctrl+Z", keywords: ["revert"],
			enabled: click("#undo", "Nothing to undo"), run: function() { $("#undo").trigger("click"); } });
		add({ id: "sig.redo", title: "Redo", group: "Signatures", icon: "redo", shortcut: "Ctrl+Y",
			enabled: click("#redo", "Nothing to redo"), run: function() { $("#redo").trigger("click"); } });

		add({ id: "chain.flareRed", title: "Flare: battle (red)", group: "Fleet", icon: "alert", keywords: ["mark", "colour"], enabled: flareEnabled("red"), run: flare("red") });
		add({ id: "chain.flareYellow", title: "Flare: hold (yellow)", group: "Fleet", icon: "alert", keywords: ["mark", "colour"], enabled: flareEnabled("yellow"), run: flare("yellow") });
		add({ id: "chain.flareGreen", title: "Flare: fleet op (green)", group: "Fleet", icon: "alert", keywords: ["mark", "colour"], enabled: flareEnabled("green"), run: flare("green") });
		add({ id: "chain.ping", title: "Ping", group: "Fleet", icon: "alert", keywords: ["discord", "alert", "message"], enabled: onChain,
			run: function(args, ctx) { $("#dialog-ping").data("id", nodeOf(ctx).data("sigid") || null).data("systemID", ctx.viewingSystemID).dialog("open"); } });
		add({ id: "chain.mass", title: "Mass dialog", group: "Holes", icon: "prop-mod", keywords: ["jumped", "recorded", "mass used"], enabled: onChain,
			run: function(args, ctx) { $("#dialog-mass").data("id", nodeOf(ctx).data("sigid")).data("systemID", ctx.viewingSystemID).dialog("open"); } });

		add({ id: "palette.clearHistory", title: "Clear palette history", group: "App", icon: "erase", keywords: ["recent", "recents", "frecency", "forget", "reset"],
			enabled: function() { return Object.keys(commandPalette.loadFrecency()).length ? true : "No palette history yet"; },
			hint: function() { const n = Object.keys(commandPalette.loadFrecency()).length; return n + (n === 1 ? " recent item" : " recent items") + " remembered in this browser"; },
			run: function() { commandPalette.clearHistory(); } });
		add({ id: "app.settings", title: "Open Settings", group: "App", icon: "settings", keywords: ["options", "preferences"],
			run: function() { $("#settings").trigger("click"); } });
		add({ id: "app.whatsNew", title: "What's new", group: "App", icon: "info", keywords: ["changes", "updates", "release"],
			enabled: function() { return typeof whatsNew !== "undefined" ? true : "Not available"; },
			run: function() { whatsNew.open(); } });
	},

	/** Open (or switch to) a chain tab for a system, as the chain map's context menu does */
	makeTab: function(id) {
		const existing = Object.index(options.chain.tabs, "systemID", "" + id, false);
		if (undefined !== existing) { chain.setActiveTab(existing); return; }
		const name = tripwire.systems[id].name;
		options.chain.tabs.push({ systemID: "" + id, name: name });
		const tab = $("#chainTab .tab").clone();
		tab.attr("id", options.chain.tabs.length - 1).find(".name").data("tab", id).text(name);
		$("#chainTabs").append(tab);
		chain.setActiveTab(options.chain.tabs.length - 1);
	},

	// ---- Overlay ----

	build: function() {
		if (document.getElementById("cp-overlay")) { return; }
		const el = document.createElement("div");
		el.id = "cp-overlay";
		el.className = "cp-hidden";
		el.innerHTML = "<div id='cp-panel' role='dialog' aria-modal='true' aria-label='Command palette' aria-describedby='cp-keys'>"
			+ "<div class='cp-inputrow'><span id='cp-chip' class='cp-chip cp-hidden'></span>"
			+ "<input id='cp-input' type='text' role='combobox' aria-expanded='true' aria-controls='cp-list' aria-autocomplete='list' "
			+ "aria-label='Search systems, signatures, settings and commands' placeholder='Search systems, signatures, settings, commands…' autocomplete='off' spellcheck='false' />"
			+ "</div><ul id='cp-list' role='listbox' aria-label='Results'></ul>"
			+ "<div id='cp-foot'><span id='cp-keys' class='cp-keys'>&uarr;&darr; move &middot; &crarr; run &middot; &rarr; actions &middot; Tab complete &middot; Esc close</span>"
			+ "<span class='cp-scopes'>&gt; cmd &middot; @ sys &middot; # sig &middot; , set</span></div>"
			+ "<div id='cp-live' class='cp-sr' aria-live='polite'></div></div>";
		document.body.appendChild(el);

		const input = document.getElementById("cp-input"), list = document.getElementById("cp-list");
		input.addEventListener("input", commandPalette.onInput);
		input.addEventListener("keydown", commandPalette.onInputKey);
		el.addEventListener("mousedown", function(e) {
			if (e.target === el) { e.preventDefault(); commandPalette.close(true); }
			else if (e.target !== input) { e.preventDefault(); }	// keep focus in the input
		});
		list.addEventListener("mousemove", function(e) {
			const m = commandPalette.state.mouse;
			if (e.clientX === m[0] && e.clientY === m[1]) { return; }	// a scroll or re-render moved the row, not the mouse
			m[0] = e.clientX; m[1] = e.clientY;
			const li = e.target.closest ? e.target.closest("li[data-i]") : null;
			if (li) { commandPalette.select(Number(li.getAttribute("data-i")), false); }
		});
		list.addEventListener("click", function(e) {
			const li = e.target.closest ? e.target.closest("li[data-i]") : null;
			if (li) {
				e.stopPropagation();	// upstream's document click handler would unselect the signature row we just selected
				commandPalette.select(Number(li.getAttribute("data-i")), false);
				commandPalette.runSelected(e.ctrlKey || e.metaKey);
			}
		});
		// Focus trap: anything that takes focus outside the panel while open gives it back to the input
		// (not while a modal dialog has the focus: its own trap and ours would fight)
		document.addEventListener("focusin", function(e) {
			if (!commandPalette.state.open || commandPalette.state.refocusing || !e.target.closest || e.target.closest("#cp-panel")) { return; }
			if (commandPalette.modalOpen()) { commandPalette.close(false); return; }
			commandPalette.state.refocusing = true;
			input.focus();
			commandPalette.state.refocusing = false;
		});
	},

	open: function() {
		try { commandPalette.doOpen(); }
		catch (e) {
			console.error("palette: open failed", e);
			commandPalette.state.open = false;
			const el = document.getElementById("cp-overlay");
			if (el) { el.className = "cp-hidden"; }
		}
	},

	doOpen: function() {
		const st = commandPalette.state, t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
		commandPalette.build();
		st.previousFocus = document.activeElement;
		st.ctx = commandPalette.makeContext();
		st.frecency = commandPalette.loadFrecency();
		st.scope = paletteIndex.parseScope("");
		st.query = "";
		st.cmd = null;
		st.noun = null;
		commandPalette.buildIndex(st.ctx);
		const el = document.getElementById("cp-overlay"), input = document.getElementById("cp-input");
		input.value = "";
		el.className = "";
		st.open = true;
		commandPalette.renderChip();
		commandPalette.update();
		input.focus();
		st.perf.open = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
	},

	close: function(restore) {
		const st = commandPalette.state;
		if (!st.open) { return; }
		st.open = false;
		document.getElementById("cp-overlay").className = "cp-hidden";
		const prev = st.previousFocus;
		st.previousFocus = null;
		if (restore && prev && prev.focus && document.body.contains(prev)) { prev.focus(); }
	},

	renderChip: function() {
		const chip = document.getElementById("cp-chip"), st = commandPalette.state, sc = st.scope;
		const input = document.getElementById("cp-input");
		if (!input.hasAttribute("data-placeholder")) { input.setAttribute("data-placeholder", input.placeholder); }
		const arg = st.cmd ? st.cmd.args[st.cmd.step] : null;
		input.placeholder = arg ? "Filter the " + (arg.label || arg.name) + "…" : st.noun ? "Filter the actions…" : input.getAttribute("data-placeholder");
		input.setAttribute("aria-label", commandPalette.inputLabel(st));
		if (st.noun) {
			chip.textContent = st.noun.item.title + " ›";
			chip.className = "cp-chip cp-crumb";
			return;
		}
		if (st.cmd) {
			chip.textContent = paletteArgs.breadcrumb(st.cmd.command, st.cmd.args, st.cmd.filled) + " ›";
			chip.className = "cp-chip cp-crumb";
			return;
		}
		chip.textContent = sc.label;
		chip.className = "cp-chip" + (sc.char ? "" : " cp-hidden");
	},

	onInput: function() {
		const st = commandPalette.state, input = document.getElementById("cp-input");
		// A scope prefix typed as the first character becomes a chip
		if (!st.scope.char && !st.cmd && !st.noun) {
			const parsed = paletteIndex.parseScope(input.value);
			if (parsed.char) { st.scope = parsed; input.value = parsed.rest; commandPalette.renderChip(); }
		}
		commandPalette.update();
	},

	/** Re-run the search for the input's text and render. Timed: commandPalette.state.perf.last is the last duration (ms) */
	update: function() {
		const st = commandPalette.state, t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
		const q = document.getElementById("cp-input").value;
		st.query = q;
		let rows, nq = paletteIndex.normalise(q);
		if (st.cmd) {
			rows = commandPalette.stepRows(q);
		} else if (st.noun) {
			rows = commandPalette.actionRows(q);
		} else if (!nq && st.scope.kinds && !st.scope.kinds.cmd) {
			rows = commandPalette.scopeRows(st.items, st.scope);
		} else if (!nq) {
			st.prev = null;
			rows = commandPalette.emptyRows(st.items.filter(function(it) { return !st.scope.kinds || st.scope.kinds[it.kind]; }),
				paletteIndex.recent(st.frecency, 12), forkCommands.GROUPS, commandPalette.viewName(), function(id) {
					return appData.systems[id] ? commandPalette.eveItem(id, appData.systems[id], appData.regions) : null;
				});
		} else {
			const res = paletteIndex.search(st.index, q, { scope: st.scope.kinds, frecency: st.frecency, prev: st.prev, limit: commandPalette.MAX_ROWS });
			st.prev = res;
			rows = res.results.map(function(it) { return { item: it, hits: paletteIndex.highlight(it.title, q) }; });
			if (!st.scope.char) {
				const inline = commandPalette.inlineItems(q);
				if (inline.length) { rows = inline.map(function(it) { return { item: it, hits: [] }; }).concat(rows); }
			}
		}
		st.rows = rows;
		st.sel = commandPalette.moveSelection(rows, -1, 1);
		if (rows[st.sel] && rows[st.sel].item && rows[st.sel].item.inline && rows[st.sel].item.inline.tie) { st.sel = -1; }	// a tie: Enter does nothing until a row is picked
		commandPalette.render();
		const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
		st.perf.last = t1 - t0;
		st.perf.samples.push(st.perf.last);
		if (st.perf.samples.length > 200) { st.perf.samples.shift(); }
		commandPalette.announce(rows);
	},

	viewName: function() {
		return typeof viewingSystem !== "undefined" ? viewingSystem : "";
	},

	render: function() {
		const st = commandPalette.state, esc = commandPalette.escape;
		let html = "";
		st.rows.forEach(function(r, i) {
			if (r.header) { html += "<li role='presentation' class='cp-group'>" + esc(r.header) + "</li>"; return; }
			const it = r.item;
			html += "<li id='cp-opt-" + i + "' role='option' data-i='" + i + "' aria-selected='" + (i === st.sel) + "' aria-label='" + esc(commandPalette.optionLabel(it)) + "'"
				+ (it.disabled ? " aria-disabled='true'" : "") + " class='cp-row" + (i === st.sel ? " cp-sel" : "") + (it.disabled ? " cp-disabled" : "") + "'>"
				+ "<i class='cp-icon' data-icon='" + esc(it.icon || "") + "' aria-hidden='true'></i>"
				+ "<span class='cp-body'><span class='cp-title'>" + commandPalette.titleHtml(it.title, r.hits) + "</span>"
				+ (it.subtitle ? "<span class='cp-sub'>" + esc(it.subtitle) + "</span>" : "") + "</span>"
				+ (it.shortcut ? "<kbd class='cp-kbd'>" + esc(it.shortcut) + "</kbd>" : "")
				+ "<span class='cp-tag'>" + esc(it.tag || commandPalette.KIND_LABEL[it.kind] || "") + "</span></li>";
		});
		if (!st.rows.length) { html = "<li role='presentation' class='cp-empty'>No match</li>"; }
		document.getElementById("cp-list").innerHTML = html;
		document.getElementById("cp-input").setAttribute("aria-expanded", st.rows.some(function(r) { return r.item; }) ? "true" : "false");
		commandPalette.markSelection(false);
	},

	/** Selected row: class, aria-selected and aria-activedescendant */
	markSelection: function(scroll) {
		const st = commandPalette.state, list = document.getElementById("cp-list"), input = document.getElementById("cp-input");
		const old = list.querySelector("li.cp-sel");
		if (old && Number(old.getAttribute("data-i")) !== st.sel) { old.classList.remove("cp-sel"); old.setAttribute("aria-selected", "false"); }
		const cur = st.sel >= 0 ? list.querySelector("li[data-i='" + st.sel + "']") : null;
		if (cur) {
			cur.classList.add("cp-sel");
			cur.setAttribute("aria-selected", "true");
			input.setAttribute("aria-activedescendant", cur.id);
			if (scroll && cur.scrollIntoView) { cur.scrollIntoView({ block: "nearest" }); }
		} else {
			input.removeAttribute("aria-activedescendant");
		}
	},

	select: function(i, scroll) {
		const st = commandPalette.state;
		if (i < 0 || i >= st.rows.length || !st.rows[i].item) { return; }
		st.sel = i;
		commandPalette.markSelection(scroll !== false);
	},

	/** Result count for screen readers, debounced so typing doesn't chatter */
	announce: function(rows) {
		const st = commandPalette.state;
		clearTimeout(st.liveTimer);
		st.liveTimer = setTimeout(function() {
			const n = rows.filter(function(r) { return r.item; }).length;
			const live = document.getElementById("cp-live");
			if (live) { live.textContent = commandPalette.liveText(st, n); }
		}, 300);
	},

	runSelected: function(keepOpen) {
		const st = commandPalette.state, row = st.rows[st.sel];
		if (!row || !row.item) { return; }
		const item = row.item;
		if (item.disabled) {
			if (typeof Notify !== "undefined") { Notify.trigger(commandPalette.escape(item.disabled), "yellow"); }
			return;
		}
		if (st.cmd) { commandPalette.acceptArg(item); return; }
		if (item.inline) { commandPalette.runInline(item); return; }
		if (item.command && item.command.args && item.command.args.length) { commandPalette.startCommand(item.command, {}); return; }
		if (item.kind !== "act") { commandPalette.touch(item.freqKey || item.key); }	// actions of a result are not recents
		if (keepOpen) {
			commandPalette.activate(item, st.ctx);
			st.ctx = commandPalette.makeContext();
			commandPalette.buildIndex(st.ctx);
			commandPalette.update();
		} else {
			commandPalette.close(true);
			commandPalette.activate(item, st.ctx);
		}
	},

	onInputKey: function(e) {
		const st = commandPalette.state, input = e.target;
		const move = function(step) { const i = commandPalette.moveSelection(st.rows, st.sel, step); if (i >= 0) { commandPalette.select(i); } };
		const page = function(step) {
			let i = st.sel;
			for (let k = 0; k < 8; k++) { const n = commandPalette.moveSelection(st.rows, i, step); if (n < 0 || (step > 0 && n < i) || (step < 0 && n > i)) { break; } i = n; }
			if (i >= 0) { commandPalette.select(i); }
		};
		switch (e.key) {
			case "Escape": e.preventDefault(); e.stopPropagation(); commandPalette.close(true); break;
			case "ArrowDown": e.preventDefault(); move(1); break;
			case "ArrowUp": e.preventDefault(); move(-1); break;
			case "PageDown": e.preventDefault(); page(1); break;
			case "PageUp": e.preventDefault(); page(-1); break;
			case "Home": if (!input.value) { e.preventDefault(); const i = commandPalette.moveSelection(st.rows, -1, 1); if (i >= 0) { commandPalette.select(i); } } break;
			case "End": if (!input.value) { e.preventDefault(); const i = commandPalette.moveSelection(st.rows, 0, -1); if (i >= 0) { commandPalette.select(i); } } break;
			case "Enter": if (e.isComposing) { break; } e.preventDefault(); commandPalette.runSelected(e.ctrlKey || e.metaKey); break;
			case "Tab": {
				e.preventDefault();
				const row = st.rows[st.sel];
				if (row && row.item) { input.value = row.item.title; commandPalette.update(); }
				break;
			}
			case "ArrowRight":
				// At the end of the text, on a system or signature: its actions (noun, then verb)
				if (!e.shiftKey && !e.ctrlKey && !e.metaKey && input.selectionStart === input.value.length && input.selectionEnd === input.value.length && commandPalette.openActions()) { e.preventDefault(); }
				break;
			case "ArrowLeft":
				if (!input.value && st.cmd) { e.preventDefault(); commandPalette.stepBack(); }
				else if (st.noun && input.selectionStart === 0 && input.selectionEnd === 0) { e.preventDefault(); commandPalette.leaveActions(); }
				break;
			case "Backspace":
				if (!input.value && st.noun) { e.preventDefault(); commandPalette.leaveActions(); break; }
				if (!input.value && st.cmd) { e.preventDefault(); commandPalette.stepBack(); break; }
				if (!input.value && st.scope.char) {
					e.preventDefault();
					st.scope = paletteIndex.parseScope("");
					commandPalette.renderChip();
					commandPalette.update();
				}
				break;
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined") {
	jQuery(function() { commandPalette.init(); });
}
