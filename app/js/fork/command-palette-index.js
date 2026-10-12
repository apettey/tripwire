const paletteIndex = {
	// Fork-owned: the command palette's pure index and scorer (no DOM, testable in Node). Spec: reports/Command
	// palette and inline edits spec.md, A3 (ranking) and A8 (performance budget). The palette builds an index once
	// per open (dirty parts only), then every keystroke is search(): score, partial top-N selection, no sort of the
	// whole list. The 8.4k EVE systems live in parallel arrays (ids, names, keys, alts), everything else is a small
	// list of item objects with pre-normalised keys.

	DAY: 86400000,
	LIMIT: 50,
	PIN: 5000,				// added to an exact J-code / sig-ID match so it is always first
	KIND_WEIGHT: { chain: 150, cmd: 100, mask: 50, setting: 0, eve: -150, sig: 0 },	// eve: spec says 0; -150 so a 2-letter query isn't buried in prefix hits of 8.4k systems
	DISABLED_PENALTY: -400,
	SIG_BONUS: 200,			// a signature when the query looks like a sig ID
	FRECENCY_KEEP: 200,

	/** Lower case, dashes and spaces dropped (jumpPlanner.searchKey semantics) */
	normalise: function(text) {
		return String(text === undefined || text === null ? "" : text).toLowerCase().replace(/[-\s]/g, "");
	},

	/** First letters of the words of a title: "Fight here" -> "fh" */
	acronym: function(text) {
		return String(text === undefined || text === null ? "" : text).toLowerCase()
			.split(/[\s\-_/·:>()]+/).filter(Boolean).map(function(w) { return w.charAt(0); }).join("");
	},

	/** "abc", "abc1", "abc-123": looks like the start of a signature ID (query already normalised) */
	looksLikeSigId: function(q) {
		return /^[a-z]{3}\d{0,3}$/.test(q);
	},

	/** Scope prefix typed as the first character: {scope: {kind: true}, label, rest} or null */
	SCOPES: {
		">": { label: "Commands", kinds: { cmd: true } },
		"@": { label: "Systems", kinds: { chain: true, eve: true } },
		"#": { label: "Signatures", kinds: { sig: true } },
		",": { label: "Settings", kinds: { setting: true } }
	},
	parseScope: function(raw) {
		const text = String(raw === undefined || raw === null ? "" : raw);
		const scope = paletteIndex.SCOPES[text.charAt(0)];
		return scope ? { char: text.charAt(0), label: scope.label, kinds: scope.kinds, rest: text.substring(1) } : { char: "", label: "", kinds: null, rest: text };
	},

	/** Subsequence match: 300 - 10 x gaps - 2 x span (floor 50), 0 = no match */
	fuzzyScore: function(q, key) {
		let qi = 0, first = -1, last = -1, gaps = 0, prev = -2;
		for (let i = 0; i < key.length && qi < q.length; i++) {
			if (key.charCodeAt(i) !== q.charCodeAt(qi)) { continue; }
			if (first < 0) { first = i; }
			if (prev !== -2 && i !== prev + 1) { gaps++; }
			prev = i;
			last = i;
			qi++;
		}
		if (qi < q.length) { return 0; }
		return Math.max(50, 300 - 10 * gaps - 2 * (last - first + 1));
	},

	/** Score of a normalised query against one normalised key (0 = no match): exact, prefix, substring, fuzzy */
	matchScore: function(q, key, fuzzy) {
		if (key === q) { return 1000; }
		const at = key.indexOf(q);
		if (at === 0) { return 800 - key.length; }
		if (at > 0) { return Math.max(50, 500 - 5 * at); }
		return fuzzy && q.length >= 2 ? paletteIndex.fuzzyScore(q, key) : 0;
	},

	/** frecency record {n, t} -> boost: min(200, 60 log2(1+n)) halving every 7 days */
	frecencyBoost: function(rec, now) {
		if (!rec || !(rec.n > 0)) { return 0; }
		const age = Math.max(0, (now === undefined ? Date.now() : now) - (rec.t || 0));
		return Math.min(200, 60 * Math.log2(1 + rec.n)) * Math.pow(0.5, age / (7 * paletteIndex.DAY));
	},

	/** Record a use in a frecency map ({key: {n, t}}), keeping the 200 most recent; returns the map */
	frecencyTouch: function(map, key, now) {
		map = map && typeof map === "object" ? map : {};
		const rec = map[key];
		map[key] = { n: (rec && rec.n > 0 ? rec.n : 0) + 1, t: now === undefined ? Date.now() : now };
		const keys = Object.keys(map);
		if (keys.length > paletteIndex.FRECENCY_KEEP) {
			keys.sort(function(a, b) { return (map[b].t || 0) - (map[a].t || 0); });
			keys.slice(paletteIndex.FRECENCY_KEEP).forEach(function(k) { delete map[k]; });
		}
		return map;
	},

	/** Keys of a frecency map, most recent first */
	recent: function(map, limit) {
		if (!map || typeof map !== "object") { return []; }
		return Object.keys(map).sort(function(a, b) { return (map[b].t || 0) - (map[a].t || 0) || (a < b ? -1 : 1); }).slice(0, limit);
	},

	/** Complete an item definition for the index: normalised unique keys (title included), acronym of the title.
	 *  def: {key, kind, title, subtitle, icon, keys: [raw strings], pin, ctx, disabled, fuzzy, run, ...} */
	item: function(def) {
		const item = Object.assign({}, def);
		item.title = String(def.title === undefined || def.title === null ? "" : def.title);
		const seen = {};
		item.keys = [item.title].concat(def.keys || []).map(paletteIndex.normalise).filter(function(k) {
			if (!k || seen[k]) { return false; }
			seen[k] = true;
			return true;
		});
		item.acro = paletteIndex.acronym(item.title);
		item.fuzzy = def.fuzzy !== false;
		item.ctx = def.ctx || 0;
		return item;
	},

	/** Parallel arrays for the EVE systems. systems: {id: {name}}; make(id) builds the full item for a result row */
	buildEve: function(systems, make) {
		const ids = [], names = [], keys = [], alts = [];
		Object.keys(systems || {}).forEach(function(id) {
			const sys = systems[id];
			if (!sys || !sys.name) { return; }
			const key = paletteIndex.normalise(sys.name);
			ids.push(Number(id));
			names.push(String(sys.name));
			keys.push(key);
			alts.push(/^j\d{6}$/.test(key) ? key.substring(1) : "");	// "123456" finds J123456
		});
		return { ids: ids, names: names, keys: keys, alts: alts, make: make || null };
	},

	/** items: output of item(); eve: output of buildEve (or null); skipEve: {systemID: true} systems already listed
	 *  as chain systems */
	build: function(items, eve, skipEve) {
		return { items: items || [], eve: eve || null, skipEve: skipEve || {} };
	},

	/** a is a better result than b: score, then shorter title, then alphabetical, then id/key */
	better: function(a, b) {
		if (a.score !== b.score) { return a.score > b.score; }
		if (a.title.length !== b.title.length) { return a.title.length < b.title.length; }
		const ta = a.title.toLowerCase(), tb = b.title.toLowerCase();
		if (ta !== tb) { return ta < tb; }
		return String(a.tie) < String(b.tie);
	},

	/** Insert into the best-first buffer of at most `limit`; most candidates lose to the last entry and cost one compare */
	offer: function(top, entry, limit) {
		if (top.length >= limit && !paletteIndex.better(entry, top[top.length - 1])) { return; }
		let i = top.length;
		while (i > 0 && paletteIndex.better(entry, top[i - 1])) { i--; }
		top.splice(i, 0, entry);
		if (top.length > limit) { top.pop(); }
	},

	/**
	 * Search the index.
	 * opts: {scope: {kind: true} | null, frecency: {key: {n, t}}, now, limit, prev: the previous search() result}
	 * Returns {query, scopeKey, index, pool, total, results: [item]} where pool is every matching candidate (so a
	 * longer query rescores only these: anything matching "abc" also matched "ab") and results the top `limit`
	 * items (best first), each with .score.
	 */
	search: function(index, rawQuery, opts) {
		opts = opts || {};
		const q = paletteIndex.normalise(rawQuery);
		const limit = opts.limit || paletteIndex.LIMIT;
		const now = opts.now === undefined ? Date.now() : opts.now;
		const scope = opts.scope || null;
		const scopeKey = scope ? Object.keys(scope).sort().join(",") : "";
		const result = { query: q, scopeKey: scopeKey, index: index, pool: [], total: 0, results: [] };
		if (!q || !index) { return result; }

		const items = index.items, eve = index.eve, skip = index.skipEve;
		const n = items.length;
		const sigLike = paletteIndex.looksLikeSigId(q);
		const fmap = opts.frecency && Object.keys(opts.frecency).length ? opts.frecency : null;
		const KW = paletteIndex.KIND_WEIGHT;
		const top = [], pool = [];

		const prev = opts.prev;
		const ids = prev && prev.index === index && prev.scopeKey === scopeKey && prev.query && q.length > prev.query.length
			&& q.indexOf(prev.query) === 0 ? prev.pool : null;

		const scoreItem = function(item) {
			if (scope && !scope[item.kind]) { return; }
			let m = 0;
			for (let k = 0; k < item.keys.length; k++) {
				const s = paletteIndex.matchScore(q, item.keys[k], item.fuzzy);
				if (s > m) { m = s; }
			}
			if (q.length >= 2 && item.acro.indexOf(q) === 0 && m < 650) { m = 650; }
			if (!m) { return; }
			return m;
		};
		const finish = function(id, item, m) {
			pool.push(id);
			let score = m + (KW[item.kind] || 0) + item.ctx + (item.disabled ? paletteIndex.DISABLED_PENALTY : 0);
			if (sigLike && item.kind === "sig") { score += paletteIndex.SIG_BONUS; }
			if (item.pin && m === 1000) { score += paletteIndex.PIN; }
			if (fmap) { score += paletteIndex.frecencyBoost(fmap[item.key], now); }
			paletteIndex.offer(top, { score: score, title: item.title, tie: item.key, id: id }, limit);
		};
		const scoreEve = function(j) {
			const id = eve.ids[j];
			if (skip[id]) { return; }
			const key = eve.keys[j], alt = eve.alts[j];
			let m = paletteIndex.matchScore(q, key, false);
			let pin = false;
			if (alt) {
				const a = paletteIndex.matchScore(q, alt, false);
				if (a > m) { m = a; }
				pin = m === 1000;
			}
			if (!m) { return; }
			const id2 = n + j;
			pool.push(id2);
			let score = m + paletteIndex.KIND_WEIGHT.eve;
			if (pin) { score += paletteIndex.PIN; }
			if (fmap) { score += paletteIndex.frecencyBoost(fmap["eve:" + id], now); }
			paletteIndex.offer(top, { score: score, title: eve.names[j], tie: "eve:" + id, id: id2 }, limit);
		};
		const evalId = function(id) {
			if (id < n) {
				const m = scoreItem(items[id]);
				if (m) { finish(id, items[id], m); }
			} else if (eve && (!scope || scope.eve)) {
				scoreEve(id - n);
			}
		};

		if (ids) {
			for (let i = 0; i < ids.length; i++) { evalId(ids[i]); }
		} else {
			for (let i = 0; i < n; i++) { evalId(i); }
			if (eve && (!scope || scope.eve)) {
				for (let j = 0; j < eve.ids.length; j++) { scoreEve(j); }
			}
		}

		result.pool = pool;
		result.total = pool.length;
		result.results = top.map(function(e) {
			const it = e.id < n ? Object.assign({}, items[e.id]) : (eve.make ? eve.make(e.id - n) : { kind: "eve", key: e.tie, title: e.title });
			it.score = e.score;
			return it;
		});
		return result;
	},

	/** Indices (into the original title) of the characters to mark for a query: substring, then word-start
	 *  acronym, then subsequence. [] if nothing matches */
	highlight: function(title, rawQuery) {
		const q = paletteIndex.normalise(rawQuery);
		const text = String(title === undefined || title === null ? "" : title);
		if (!q) { return []; }
		const map = [];
		let nk = "";
		for (let i = 0; i < text.length; i++) {
			const c = text.charAt(i);
			if (c === "-" || /\s/.test(c)) { continue; }
			nk += c.toLowerCase();
			map.push(i);
		}
		const at = nk.indexOf(q);
		if (at >= 0) { return map.slice(at, at + q.length); }
		// word starts
		const starts = [];
		for (let i = 0; i < text.length; i++) {
			if (/[\s\-_/·:>()]/.test(text.charAt(i))) { continue; }
			if (i === 0 || /[\s\-_/·:>()]/.test(text.charAt(i - 1))) { starts.push(i); }
		}
		const acro = starts.map(function(i) { return text.charAt(i).toLowerCase(); }).join("");
		if (q.length >= 2 && acro.indexOf(q) === 0) { return starts.slice(0, q.length); }
		// subsequence
		const out = [];
		let qi = 0;
		for (let i = 0; i < nk.length && qi < q.length; i++) {
			if (nk.charAt(i) === q.charAt(qi)) { out.push(map[i]); qi++; }
		}
		return qi === q.length ? out : [];
	}
};
