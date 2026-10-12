const paletteArgs = {
	// Fork-owned: the command palette's argument handling, pure (no DOM, testable in Node). Spec: reports/Command
	// palette and inline edits spec.md A6. Three jobs:
	//  - candidates for an argument (wormholes of the chain, choices) as palette index items,
	//  - ranking candidates against what was typed (paletteIndex.search over just those candidates),
	//  - one-line commands: "fight AA", "mark rolling A", "life eol B2" -> command + arguments, in any argument order.
	// Keep `const paletteArgs` on the first line: the test helper strips it to define a global.

	TYPES: ["chainSystem", "system", "hole", "signature", "choice", "text"],
	MAX_TOKENS: 6,
	ALTERNATIVES: 5,
	MAX_COMMANDS: 3,

	/** "Fight  AA " -> ["Fight", "AA"] */
	words: function(text) {
		return String(text === undefined || text === null ? "" : text).split(/\s+/).filter(Boolean);
	},

	/** Leading name token of a hole's sig name ("BA - DRIFTER" -> "BA"), upper case; "" if none */
	holeToken: function(name) {
		const m = /^[A-Z0-9]+/i.exec(String(name === undefined || name === null ? "" : name).trim());
		return m ? m[0].toUpperCase() : "";
	},

	// ---- Candidates ----

	/**
	 * The wormholes on the chain map as palette items (value = wormhole id). env: {rows (chain.data.map.rows),
	 * wormholes (tripwire.client.wormholes, optional: when given, a hole must exist there), systems (appData.systems),
	 * viewingID}. The node's markup carries the wormhole id (data-sigid); the hole's name is the last pathHome entry.
	 * Keys: hole name (token and full), the system behind it (name, J-code digits), the system it leaves, wormhole
	 * type, sig ID. Holes touching the viewed system rank first.
	 */
	holes: function(env) {
		const rows = (env && env.rows) || [], systems = (env && env.systems) || {}, viewing = String(env && env.viewingID);
		const nodeSystem = {};
		rows.forEach(function(row) {
			const n = row && row.c && row.c[0];
			if (n && n.v !== undefined && n.v !== null && n.systemID !== undefined) { nodeSystem[n.v] = String(n.systemID); }
		});
		const sysName = function(id) { return systems[id] && systems[id].name ? String(systems[id].name) : String(id); };
		const digits = function(name) { return /^J\d{6}$/i.test(name) ? name.substring(1) : ""; };
		const seen = {}, out = [];
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0], parentNode = row && row.c && row.c[1];
			if (!node || !parentNode || typeof node.f !== "string" || row.destination) { return; }
			const m = /data-sigid=['"](\d+)['"]/.exec(node.f);
			if (!m) { return; }
			const id = Number(m[1]);
			const path = row.pathHome || [], last = path.length ? path[path.length - 1] : null;
			if (seen[id] || !last || last.path) { return; }
			const parent = parentNode.v !== undefined && parentNode.v !== null ? nodeSystem[parentNode.v] : undefined;
			if (parent === undefined) { return; }
			const wh = env.wormholes ? env.wormholes[id] : null;
			if (env.wormholes && !wh) { return; }
			seen[id] = true;
			const child = String(node.systemID), name = last.name ? String(last.name).trim() : "";
			const token = paletteArgs.holeToken(name), type = (wh && wh.type) || last.type || "";
			const childName = sysName(child), parentName = sysName(parent);
			const sigID = last.signatureID ? String(last.signatureID).toUpperCase() : "";
			const flags = [];
			if (wh && wh.life === "critical") { flags.push("EOL"); }
			if (wh && wh.mass === "critical") { flags.push("critical"); } else if (wh && wh.mass === "destab") { flags.push("destab"); }
			const here = child === viewing || parent === viewing;
			out.push({
				key: "hole:" + id, kind: "arg", value: id, systemID: Number(child), parentSystemID: Number(parent), token: token,
				title: (token ? token + " → " : "") + childName + " (from " + parentName + ")",
				subtitle: [type && type !== "????" ? type : "", sigID ? sigID.substring(0, 3) + (sigID.length > 3 ? "-" + sigID.substring(3) : "") : "", flags.join(" ")].filter(Boolean).join(" · "),
				keys: [token, name, childName, digits(childName), parentName, digits(parentName), type, sigID],
				icon: "tree", tag: "Hole", fuzzy: false, ctx: here ? 120 : 0
			});
		});
		return out;
	},

	/** Choices of a "choice" argument as palette index items. choices: [{value, title, hint, keys}] */
	choices: function(list) {
		return (list || []).map(function(c, i) {
			return {
				key: "choice:" + String(c.value), kind: "arg", value: c.value, title: String(c.title === undefined ? c.value : c.title),
				subtitle: c.hint || "", keys: c.keys || [], icon: c.icon || "", tag: "Option", fuzzy: true, ctx: 0, order: i
			};
		});
	},

	/** Chain-system palette items (kind "chain") as argument candidates (value = system id), after an optional filter */
	chainSystems: function(items, filter) {
		return (items || []).filter(function(it) { return it.kind === "chain" && (!filter || filter(it.systemID)); }).map(function(it) {
			return Object.assign({}, it, { kind: "arg", value: it.systemID, tag: "System", pin: false });
		});
	},

	/** Signature palette items as candidates (value = signature row id) */
	signatures: function(items) {
		return (items || []).filter(function(it) { return it.kind === "sig"; }).map(function(it) {
			return Object.assign({}, it, { kind: "arg", value: it.sigID, tag: "Signature", pin: false });
		});
	},

	/** Index of the candidate list for ranking (search() needs an index of finished items) */
	index: function(cands, eve) {
		return paletteIndex.build(cands, eve || null, {});
	},

	/**
	 * Candidates for an empty query: the default first, then the ones with context (next to the viewed system), then by
	 * title (choices keep their declared order). defaultValue: arg.default evaluated, or undefined.
	 */
	listAll: function(cands, defaultValue) {
		const isDefault = function(c) { return defaultValue !== undefined && defaultValue !== null && String(c.value) === String(defaultValue); };
		return cands.slice().sort(function(a, b) {
			const da = isDefault(a), db = isDefault(b);
			if (da !== db) { return da ? -1 : 1; }
			if (a.order !== undefined && b.order !== undefined) { return a.order - b.order; }
			if ((b.ctx || 0) !== (a.ctx || 0)) { return (b.ctx || 0) - (a.ctx || 0); }
			return String(a.title).toLowerCase() < String(b.title).toLowerCase() ? -1 : 1;
		});
	},

	/** Rank prepared candidates (paletteIndex.item output) against typed text; best first, each with .score */
	rank: function(cands, text, limit, frecency) {
		if (!paletteIndex.normalise(text)) { return []; }
		return paletteIndex.search(paletteArgs.index(cands), text, { limit: limit || 20, frecency: frecency || null }).results;
	},

	// ---- One-line commands ----

	/** How well the typed command words match a command's title/keywords: 0 = no match, higher is better */
	commandMatch: function(command, cmdWords) {
		const c = paletteIndex.normalise(cmdWords.join(""));
		if (c.length < 2) { return 0; }
		const title = String(command.title || ""), tn = paletteIndex.normalise(title);
		if (tn === c) { return 100; }
		if (tn.indexOf(c) === 0) { return 90; }
		const tw = title.split(/[\s\-_/·:>()]+/).filter(Boolean);
		for (let i = 1; i < tw.length; i++) {
			if (paletteIndex.normalise(tw.slice(i).join("")).indexOf(c) === 0) { return 70; }
		}
		if (paletteIndex.acronym(title) === c) { return 60; }
		const kws = command.keywords || [];
		for (let i = 0; i < kws.length; i++) {
			if (c.length >= 3 && paletteIndex.normalise(kws[i]).indexOf(c) === 0) { return 50; }
		}
		return 0;
	},

	/**
	 * Split "<command words> <argument words>": the longest run of leading words that matches a command with arguments.
	 * Returns [{command, rest: [word], score}] best match first (at most MAX_COMMANDS), or [].
	 */
	splitInline: function(commands, query) {
		const words = paletteArgs.words(query);
		for (let k = words.length - 1; k >= 1; k--) {
			const cw = words.slice(0, k), found = [];
			commands.forEach(function(command) {
				if (!command.args || !command.args.length) { return; }
				const score = paletteArgs.commandMatch(command, cw);
				if (score) { found.push({ command: command, rest: words.slice(k), score: score }); }
			});
			if (found.length) {
				found.sort(function(a, b) { return b.score - a.score || String(a.command.title).length - String(b.command.title).length; });
				return found.slice(0, paletteArgs.MAX_COMMANDS);
			}
		}
		return [];
	},

	/** All ways to cut tokens into exactly k non-empty consecutive groups (as joined strings) */
	cuts: function(tokens, k) {
		const out = [];
		const go = function(from, left, acc) {
			if (left === 1) { out.push(acc.concat(tokens.slice(from).join(" "))); return; }
			for (let end = from + 1; end <= tokens.length - (left - 1); end++) {
				go(end, left - 1, acc.concat(tokens.slice(from, end).join(" ")));
			}
		};
		if (k >= 1 && tokens.length >= k) { go(0, k, []); }
		return out;
	},

	/** Orderings of the first (up to 3) argument indexes, the declared order first */
	orders: function(n) {
		const idx = [];
		for (let i = 0; i < Math.min(n, 3); i++) { idx.push(i); }
		const out = [];
		const go = function(rest, acc) {
			if (!rest.length) { out.push(acc); return; }
			rest.forEach(function(x, i) { go(rest.slice(0, i).concat(rest.slice(i + 1)), acc.concat(x)); });
		};
		go(idx, []);
		return out;
	},

	/**
	 * Give typed words to the command's arguments, in any order ("life eol B2" and "life B2 eol" are the same).
	 * resolve(arg, text) -> ranked candidates (best first, each with .score), [] if none. Prefers using more of the
	 * arguments, then the higher total score, then the declared order. Returns [{index, text, ranked}] ordered by
	 * argument index, or [] when the words match nothing.
	 */
	assign: function(args, tokens, resolve) {
		tokens = tokens.slice(0, paletteArgs.MAX_TOKENS);
		let best = null;
		const orders = paletteArgs.orders(args.length);
		for (let k = Math.min(tokens.length, orders[0] ? orders[0].length : 0); k >= 1; k--) {
			const cuts = paletteArgs.cuts(tokens, k);
			orders.forEach(function(order, oi) {
				cuts.forEach(function(cut) {
					let total = 0;
					const got = [];
					for (let g = 0; g < k; g++) {
						const arg = order[g], ranked = resolve(args[arg], cut[g]);
						if (!ranked || !ranked.length) { return; }
						total += ranked[0].score;
						got.push({ index: arg, text: cut[g], ranked: ranked });
					}
					if (!best || total > best.total || (total === best.total && oi < best.oi)) { best = { total: total, oi: oi, got: got }; }
				});
			});
			if (best) { break; }	// using more arguments beats a higher score on fewer
		}
		return best ? best.got.sort(function(a, b) { return a.index - b.index; }) : [];
	},

	/**
	 * One-line commands for a query. env: {resolve(arg, text) -> ranked candidates, defaultFor(arg) -> candidate | null}.
	 * Returns descriptors [{command, filled: {argIndex: candidate}, complete, next}] best first: `complete` when every
	 * required argument is given (typed or default), otherwise `next` is the index of the first one still missing.
	 * An ambiguous free-text argument (a system or hole) gives one descriptor per likely candidate (ALTERNATIVES).
	 */
	inline: function(commands, query, env) {
		const out = [];
		paletteArgs.splitInline(commands, query).forEach(function(match) {
			const args = match.command.args;
			const resolve = function(arg, text) { return env.resolve(arg, text, match.command); };
			const got = paletteArgs.assign(args, match.rest, resolve);
			if (!got.length) { return; }
			// The argument with several candidates (not a choice) is the one to list alternatives of
			let free = -1;
			got.forEach(function(g) {
				if (args[g.index].type !== "choice" && g.ranked.length > 1 && (free < 0 || g.ranked.length > got[free].ranked.length)) { free = got.indexOf(g); }
			});
			const variants = free >= 0 ? got[free].ranked.slice(0, paletteArgs.ALTERNATIVES) : [null];
			// Two equally good candidates (e.g. two holes named AA): nothing is pre-selected, the user picks
			const tie = free >= 0 && got[free].ranked.length > 1 && got[free].ranked[0].score === got[free].ranked[1].score;
			variants.forEach(function(alt) {
				const typed = {};
				got.forEach(function(g, gi) { typed[g.index] = gi === free ? alt : g.ranked[0]; });
				const done = paletteArgs.finish(match.command, typed, function(a) { return env.defaultFor ? env.defaultFor(a, match.command) : null; });
				out.push({ command: match.command, filled: done.filled, complete: done.complete, next: done.next, score: match.score, tie: tie });
			});
		});
		return out;
	},

	/**
	 * Complete a partly filled command: defaults fill what is missing, then `next` is the first required argument still
	 * missing (null: runnable). filled: {argIndex: candidate}; defaultFor(arg) -> candidate | null. Returns {filled, complete, next}.
	 */
	finish: function(command, filled, defaultFor) {
		const args = command.args || [], out = Object.assign({}, filled);
		let next = null;
		for (let i = 0; i < args.length; i++) {
			if (out[i]) { continue; }
			const d = defaultFor ? defaultFor(args[i]) : null;
			if (d) { out[i] = d; continue; }
			if (!args[i].optional && next === null) { next = i; }
		}
		return { filled: out, complete: next === null, next: next };
	},

	/** Values object for command.run: {argName: value} from filled candidates (index -> candidate) */
	values: function(args, filled) {
		const out = {};
		args.forEach(function(arg, i) {
			const c = filled[i];
			if (c) { out[arg.name] = c.value; }
		});
		return out;
	},

	/** "Fight here › J123456 ›" breadcrumb text for the filled arguments (title of each) */
	breadcrumb: function(command, args, filled) {
		const parts = [command.title];
		args.forEach(function(arg, i) { if (filled[i]) { parts.push(filled[i].crumb || filled[i].title); } });
		return parts.join(" › ");
	}
};
