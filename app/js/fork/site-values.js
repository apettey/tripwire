const siteValues = {
	// Estimated ISK value of wormhole gas and ore sites (fork-owned, see changes/2026-11-15-site-value-estimate):
	// a chip such as "~1.4B" after the site name in the signature list, with a tooltip of what is in the site.
	// Site contents: public/site-values/sites.json (sources and how sure we are are in the file). Prices: the
	// server's hourly copy of ESI's public /markets/prices/ (public/market_prices.php); until it answers, or when it
	// can't, the prices stored in sites.json. Sites the data marks "unverified" get a "?" chip and no value.
	// Setting: options.siteValues.enabled (missing = on). Keep `const siteValues` on the first line: the test helper
	// strips it to define a global.
	// Relic and data sites (changes/2026-11-15-relic-data-site-values): scanner-name families ("Ruined <faction> ...")
	// are expanded from sites.json families. Ruined sites get a live expected-salvage model ("~18M exp."), Forgotten
	// wormhole relic sites their Sleeper rat loot ("~115M Sleeper loot"), other families a dated static range (dashed
	// chip), and sites without a sourced figure a "?" with the reason. Wormhole "Unsecured ..." sites never get a chip.
	// K-space gas and ore (changes/2026-11-21-all-gas-ore-site-values): Mykoserocin/Cytoserocin nebulae and k-space ore
	// anomalies and signatures, same shape as the wormhole sites plus `where` and `note`. A contents row may give
	// [typeID, [low, high]] units when the sources disagree: the chip then shows a range ("~120-240M").

	DATA_URL: "site-values/sites.json",
	PRICES_URL: "market_prices.php",
	// estimate = a modelled or sourced figure for relic/data sites (solid chip, labelled "exp." or "Sleeper loot")
	STATUSES: ["verified", "estimate", "approximate", "unverified"],

	/** Whether the feature is on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.siteValues && opts.siteValues.enabled === false);
	},

	/** Key used to match a scanner name: trimmed, single spaces, lower case */
	key: function(name) {
		return String(name === undefined || name === null ? "" : name).trim().replace(/\s+/g, " ").toLowerCase();
	},

	/** Whether the parsed sites.json has the expected shape */
	valid: function(data) {
		return !!data && typeof data === "object" && Array.isArray(data.sites) && !!data.types && typeof data.types === "object";
	},

	/** Sites of the data's scanner-name families: "<prefix> <faction> <layout>" for each faction (the family's own list
	or data.factions) and each layout/name; ghost sites are "<size> <faction> <suffix>". Each site copies the family's
	fields and adds name, faction and (model families) containers. */
	familySites: function(data) {
		const out = [];
		if (!data || !Array.isArray(data.families)) { return out; }
		data.families.forEach(function(fam) {
			if (!fam || typeof fam !== "object") { return; }
			const factions = Array.isArray(fam.factions) ? fam.factions : (Array.isArray(data.factions) ? data.factions : []);
			const base = {};
			Object.keys(fam).forEach(function(k) { if (["layouts", "names", "prefixes", "suffix", "factions", "prefix"].indexOf(k) < 0) { base[k] = fam[k]; } });
			const add = function(name, faction, containers) {
				const site = Object.assign({}, base, { name: name, faction: faction });
				if (containers) { site.containers = containers; }
				out.push(site);
			};
			factions.forEach(function(faction) {
				if (Array.isArray(fam.prefixes) && fam.suffix) {
					fam.prefixes.forEach(function(prefix) { add(prefix + " " + faction + " " + fam.suffix, faction); });
				} else if (fam.prefix && fam.layouts && typeof fam.layouts === "object") {
					Object.keys(fam.layouts).forEach(function(layout) { add(fam.prefix + " " + faction + " " + layout, faction, fam.layouts[layout]); });
				} else if (fam.prefix && Array.isArray(fam.names)) {
					fam.names.forEach(function(layout) { add(fam.prefix + " " + faction + " " + layout, faction); });
				}
			});
		});
		return out;
	},

	/** Whether a name is one the data excludes on purpose (wormhole "Unsecured ..." data sites) */
	excluded: function(name, data) {
		const k = siteValues.key(name);
		const prefixes = data && data.exclude && Array.isArray(data.exclude.prefixes) ? data.exclude.prefixes : [];
		return prefixes.some(function(p) { const q = siteValues.key(p); return !!q && (k === q || k.indexOf(q + " ") === 0); });
	},

	/** {key: site} for every site name and alias in the data, and every name of its families */
	index: function(data) {
		const index = {};
		if (!siteValues.valid(data)) { return index; }
		const put = function(name, site) { if (!siteValues.excluded(name, data)) { index[siteValues.key(name)] = site; } };
		siteValues.familySites(data).forEach(function(site) { put(site.name, site); });
		data.sites.forEach(function(site) {
			if (!site || !site.name) { return; }
			[site.name].concat(Array.isArray(site.aliases) ? site.aliases : []).forEach(function(name) { put(name, site); });
		});
		return index;
	},

	/** The site for a signature (client shape), or null: never for wormholes, only for names in the data */
	siteFor: function(sig, index) {
		if (!sig || sig.type === "wormhole" || !index) { return null; }
		return index[siteValues.key(sig.name)] || null;
	},

	/** Expected units of EACH item of a faction's salvage list in a site: sum over container types of
	count x chance x mean uniform stack ((min + max) / 2), separately for T1 and T2.
	@param containers {rubble, remains, ruins} counts
	@param chances relicModel.chances: {rubble: {t1: [chance, min, max], t2: [...]}, ...} */
	expectedUnits: function(containers, chances) {
		const out = { t1: 0, t2: 0 };
		if (!containers || !chances) { return out; }
		Object.keys(containers).forEach(function(c) {
			const n = Number(containers[c]) || 0, ch = chances[c];
			if (!n || !ch) { return; }
			["t1", "t2"].forEach(function(t) {
				const r = ch[t];
				if (Array.isArray(r) && r.length === 3) { out[t] += n * Number(r[0]) * (Number(r[1]) + Number(r[2])) / 2; }
			});
		});
		return out;
	},

	/** Expected salvage value of a Ruined site (value "model"): every item of the universal and faction lists, T2 units
	on the T2 type and T1 units on the T1 type, priced live or with the stored price.
	@return {status, value: "model", total, t1Total, t2Total, units {t1, t2}, lines [{name, tier, units, price, isk, live}],
	live, missing, dominant: {name, share, without, note} or null} */
	modelEstimate: function(site, data, live) {
		const model = data && data.relicModel;
		const out = { status: "estimate", value: "model", total: 0, t1Total: 0, t2Total: 0, lines: [], live: true, missing: [], dominant: null, units: { t1: 0, t2: 0 } };
		const pairs = model && model.factions && model.factions[site.faction];
		if (!model || !Array.isArray(pairs) || !Array.isArray(model.universal) || !site.containers) {
			return Object.assign(out, { status: "unverified", live: false });
		}
		const units = out.units = siteValues.expectedUnits(site.containers, model.chances);
		const fallback = data.fallbackPrices && data.fallbackPrices.prices;
		const byType = {};
		model.universal.concat(pairs).forEach(function(pair) {
			if (!Array.isArray(pair)) { return; }
			[[pair[0], "T2", units.t2], [pair[1], "T1", units.t1]].forEach(function(t) {
				if (t[0] === null || t[0] === undefined || !(t[2] > 0)) { return; }
				const id = String(t[0]);
				if (byType[id]) { byType[id].units += t[2]; return; }
				const type = data.types && data.types[id];
				byType[id] = { id: id, name: type ? String(type.name) : "Type " + id, tier: t[1], units: t[2], note: type && type.priceNote };
			});
		});
		Object.keys(byType).forEach(function(id) {
			const it = byType[id];
			const p = siteValues.priceOf(id, live, fallback);
			if (!p) { out.missing.push(it.name); return; }
			if (!p.live) { out.live = false; }
			const isk = it.units * p.price;
			out.lines.push({ name: it.name, tier: it.tier, units: it.units, price: p.price, isk: isk, live: p.live, note: it.note });
			out.total += isk;
			if (it.tier === "T2") { out.t2Total += isk; } else { out.t1Total += isk; }
		});
		if (!out.lines.length) { return Object.assign(out, { status: "unverified", live: false }); }
		out.lines.sort(function(a, b) { return b.isk - a.isk; });
		const top = out.lines[0], limit = Number(model.dominantShare) || 0.5;
		if (out.total > 0 && top.isk / out.total >= limit) {
			out.dominant = { name: top.name, share: top.isk / out.total, without: out.total - top.isk, note: top.note || "" };
		}
		return out;
	},

	/** Static figure of a site: value "range" ([low, high] ISK, low 0 = "under high") or "combat" (Sleeper rat loot,
	one figure or [low, high] when sources disagree). @return {status, value, low, high, typical, total (= high)} */
	staticEstimate: function(site) {
		const v = site.value === "combat" ? site.blueLoot : site.range;
		const r = Array.isArray(v) ? v.map(Number) : [Number(v), Number(v)];
		if (r.length !== 2 || !(r[1] > 0) || !(r[0] >= 0) || r[0] > r[1]) { return { status: "unverified", value: site.value, low: 0, high: 0, total: 0 }; }
		return { status: site.status, value: site.value, low: r[0], high: r[1], typical: Number(site.typical) > 0 ? Number(site.typical) : null, total: r[1] };
	},

	/** Price of one type: live price when known and positive, else the fallback; {price, live} or null */
	priceOf: function(typeID, live, fallback) {
		const id = String(typeID);
		const a = live ? Number(live[id]) : NaN;
		if (a > 0) { return { price: a, live: true }; }
		const b = fallback ? Number(fallback[id]) : NaN;
		if (b > 0) { return { price: b, live: false }; }
		return null;
	},

	/** Estimate for a site.
	@param site an entry of sites.json
	@param data the parsed sites.json (types, fallbackPrices)
	@param live {typeID: ISK} from market_prices.php, or null
	@return {status, total, low (= total unless a row gives [low, high] units), range (some row has a range), lines: [{name, units,
	unitsLow, m3, price, isk, iskLow}] (highest ISK first), live (every price live), missing (types without a price)} */
	estimate: function(site, data, live) {
		const status = site && siteValues.STATUSES.indexOf(site.status) >= 0 ? site.status : "unverified";
		if (site && status !== "unverified" && site.value === "model") { return siteValues.modelEstimate(site, data, live); }
		if (site && status !== "unverified" && (site.value === "range" || site.value === "combat")) { return siteValues.staticEstimate(site); }
		const out = { status: status, total: 0, low: 0, range: false, lines: [], live: true, missing: [] };
		if (!site || status === "unverified" || !Array.isArray(site.contents) || !data) {
			out.status = "unverified";
			out.live = false;
			return out;
		}
		const fallback = data.fallbackPrices && data.fallbackPrices.prices;
		site.contents.forEach(function(row) {
			if (!Array.isArray(row)) { return; }
			const type = data.types && data.types[String(row[0])];
			// [low, high] when the sources disagree
			const pair = Array.isArray(row[1]) && row[1].length === 2 ? row[1].map(Number) : null;
			const units = pair ? pair[1] : Number(row[1]);
			const unitsLow = pair ? pair[0] : units;
			if (!type || !(units > 0) || !(unitsLow > 0) || unitsLow > units) { return; }
			// Ore is priced as its compressed form (priceAs), 1 unit for 1 unit: raw ore hardly trades
			const p = siteValues.priceOf(type.priceAs || row[0], live, fallback);
			if (!p) { out.missing.push(type.name); return; }
			if (!p.live) { out.live = false; }
			const isk = units * p.price;
			out.lines.push({ name: String(type.name), units: units, unitsLow: unitsLow, m3: units * (Number(type.m3) || 0), price: p.price, isk: isk,
				iskLow: unitsLow * p.price, compressed: !!type.priceAs, live: p.live });
			out.total += isk;
			out.low += unitsLow * p.price;
			if (unitsLow !== units) { out.range = true; }
		});
		if (!out.lines.length) { out.status = "unverified"; out.live = false; }
		out.lines.sort(function(a, b) { return b.isk - a.isk; });
		return out;
	},

	/** Short ISK: 1.4B, 85M, 8.5M, 850k, 900 (2 significant figures under 10 of a unit) */
	shortIsk: function(isk) {
		const n = Number(isk);
		if (!isFinite(n) || n <= 0) { return "0"; }
		const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
		for (let i = 0; i < units.length; i++) {
			if (n >= units[i][0] * 0.9995) {
				const v = n / units[i][0];
				return (v < 10 ? (Math.round(v * 10) / 10) : Math.round(v)) + units[i][1];
			}
		}
		return String(Math.round(n));
	},

	/** Whole number with thousands separators */
	thousands: function(n) {
		return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	},

	/** "1-10M", "50-77M", "500k-2M"; low 0 = "<2M"; equal ends = one figure */
	rangeIsk: function(low, high) {
		const b = siteValues.shortIsk(high);
		if (!(low > 0)) { return "<" + b; }
		const a = siteValues.shortIsk(low);
		if (a === b) { return a; }
		const unit = b.replace(/^[\d.]+/, "");
		return (unit && a.slice(-unit.length) === unit && /\d$/.test(a.slice(0, -unit.length)) ? a.slice(0, -unit.length) : a) + "-" + b;
	},

	/** Chip text: "~1.4B" (gas/ore), "~18M exp." (Ruined model), "~115M Sleeper loot" (Forgotten), "~1-10M" / "<2M"
	(ranges), or "?" when there is no value */
	chipText: function(est) {
		if (!est || est.status === "unverified") { return "?"; }
		if (est.value === "model") { return "~" + siteValues.shortIsk(est.total) + " exp."; }
		if (est.value === "combat") { return "~" + siteValues.rangeIsk(est.low, est.high) + " Sleeper loot"; }
		if (est.value === "range") { return (est.low > 0 ? "~" : "") + siteValues.rangeIsk(est.low, est.high); }
		if (est.range && est.low > 0) { return "~" + siteValues.rangeIsk(est.low, est.total); }
		return "~" + siteValues.shortIsk(est.total);
	},

	/** Expected units: one decimal under 10, else whole */
	units: function(n) {
		const v = Number(n) || 0;
		return v < 10 ? (Math.round(v * 10) / 10).toFixed(1) : siteValues.thousands(v);
	},

	/** Name of a source key of sites.json for the tooltip */
	sourceName: function(key) {
		return { eveuniRDS: "EVE University (Relic and data sites)", eveuniWhisk: "EVE University (Template:Whisk)", signalCartel: "Signal Cartel (Making ISK as an Explorer)",
			ccpRework2025: "CCP (Exploration and Industry Balance Rework, 2025-07-17)", forum294175: "EVE Online forum" }[key] || String(key || "");
	},

	/** The prices line of a tooltip: all live, all stored, or which items use the stored price */
	pricesNote: function(lines, pricesDate) {
		const e = siteValues.escape;
		const stored = lines.filter(function(l) { return !l.live; });
		if (!stored.length) { return "Prices: ESI average market price, updated hourly."; }
		if (stored.length === lines.length) { return "Prices: ESI average market price of " + e(pricesDate || "an earlier date") + " (live prices unavailable)."; }
		return "Prices: ESI average market price, updated hourly; " + e(stored.map(function(l) { return l.name; }).join(", "))
			+ " at the price of " + e(pricesDate || "an earlier date") + " (no live price).";
	},

	/** Tooltip of a relic/data site (model, Sleeper loot, range or no value) */
	relicTooltip: function(site, est, pricesDate) {
		const e = siteValues.escape;
		const head = "<b>" + e(site.name) + "</b> (" + e(site.kind || "site") + (site.where || site.classes ? ", " + e(site.where || site.classes) : "") + ")";
		const notes = [];
		if (!est || est.status === "unverified") {
			return head + "<br>No value shown." + (site.reason ? "<br>" + e(site.reason) : "");
		}
		const source = "Source: " + e(siteValues.sourceName(site.source)) + (site.sourceDate ? ", " + e(site.sourceDate) : "") + ".";
		if (est.value === "range") {
			notes.push("Rough figure per site: " + (est.low > 0 ? e(siteValues.rangeIsk(est.low, est.high)) : "under " + e(siteValues.shortIsk(est.high))) + " ISK"
				+ (est.typical ? ", typically ~" + e(siteValues.shortIsk(est.typical)) : "") + ".");
			if (site.sourceNote) { notes.push(e(site.sourceNote) + "."); }
			notes.push(source);
			notes.push("How sure: low. Player estimates at old prices; no drop table is published. A rare blueprint can be worth far more.");
			return head + "<div class=\"site-value-notes\">" + notes.join("<br>") + "</div>";
		}
		if (est.value === "combat") {
			notes.push("Sleeper loot from killing the rats: ~" + e(siteValues.rangeIsk(est.low, est.high)) + " ISK. It sells to fixed NPC buy orders, so it doesn't change with the market.");
			if (site.conflict) { notes.push(e(site.conflict) + " Both are shown."); }
			notes.push("This is combat loot, not hacking loot. What the cans hold is unverified: players say they're usually worth little unless a Talocan wreck spawns.");
			notes.push(source);
			notes.push("How sure: medium for the Sleeper loot (some spawns vary by a wave); none for the cans.");
			return head + "<div class=\"site-value-notes\">" + notes.join("<br>") + "</div>";
		}
		// Ruined: expected-salvage model
		const c = site.containers || {};
		const group = function(tier, total) {
			const lines = est.lines.filter(function(l) { return l.tier === tier; });
			const big = lines.filter(function(l) { return l.isk >= est.total * 0.02; });
			const small = lines.filter(function(l) { return l.isk < est.total * 0.02; });
			let html = "<tr class=\"site-value-group\"><td colspan=\"3\">" + tier + " salvage</td><td class=\"site-value-num\">" + siteValues.shortIsk(total) + "</td></tr>";
			html += big.map(function(l) {
				return "<tr><td>" + e(l.name) + "</td><td class=\"site-value-num\">" + siteValues.units(l.units) + " u</td>"
					+ "<td class=\"site-value-num\">&times; " + siteValues.thousands(l.price) + "</td>"
					+ "<td class=\"site-value-num\">" + siteValues.shortIsk(l.isk) + "</td></tr>";
			}).join("");
			if (small.length) {
				html += "<tr><td colspan=\"3\">" + small.length + " other " + tier + " item" + (small.length > 1 ? "s" : "") + "</td><td class=\"site-value-num\">"
					+ siteValues.shortIsk(small.reduce(function(sum, l) { return sum + l.isk; }, 0)) + "</td></tr>";
			}
			return html;
		};
		const rows = group("T2", est.t2Total) + group("T1", est.t1Total)
			+ "<tr class=\"site-value-total\"><td colspan=\"3\">Expected value</td><td class=\"site-value-num\">~" + siteValues.shortIsk(est.total) + " ISK</td></tr>";
		notes.push("Expected salvage if every can is hacked: " + (Number(c.rubble) || 0) + " Rubble, " + (Number(c.remains) || 0) + " Remains and "
			+ (Number(c.ruins) || 0) + " Ruins cans, each " + e(site.faction) + " salvage item dropping by its chance and average stack.");
		if (est.dominant) {
			notes.push(e(est.dominant.name) + " is " + Math.round(est.dominant.share * 100) + "% of this (~" + siteValues.shortIsk(est.dominant.without) + " without it)."
				+ (est.dominant.note ? " " + e(est.dominant.note) : ""));
		}
		notes.push("Not included: blueprint copies, carbon and Spatial Attunement Units (no published drop rates), so the average is a little higher, and a rare blueprint can be worth far more. Failed hacks lose cans.");
		if (est.missing.length) { notes.push("No price for " + e(est.missing.join(", ")) + "."); }
		notes.push(siteValues.pricesNote(est.lines, pricesDate));
		notes.push("How sure: medium. " + source.replace(/\.$/, "") + ", from a 2019 player study (still the wiki's model in 2026).");
		return head + "<table class=\"site-value-table\">" + rows + "</table>"
			+ "<div class=\"site-value-notes\">" + notes.join("<br>") + "</div>";
	},

	/** Escape text for HTML (tooltips are HTML; every text here is ours, escaped anyway) */
	escape: function(text) {
		return String(text).replace(/[&<>"']/g, function(c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; });
	},

	/** Tooltip HTML for a site and its estimate.
	@param pricesDate date of the fallback prices (shown when some price isn't live) */
	tooltip: function(site, est, pricesDate) {
		if (site && (site.kind === "relic" || site.kind === "data")) { return siteValues.relicTooltip(site, est, pricesDate); }
		const e = siteValues.escape;
		const where = site.where || site.classes;
		const head = "<b>" + e(site.name) + "</b> (" + e(site.kind || "site") + (where ? ", " + e(where) : "") + ")";
		if (!est || est.status === "unverified") {
			return head + "<br>No value: the contents of this site couldn't be verified."
				+ (site.reason ? "<br>" + e(site.reason) : "");
		}
		const span = function(low, high, fmt) { return low !== high ? fmt(low) + "-" + fmt(high) : fmt(high); };
		const rows = est.lines.map(function(l) {
			return "<tr><td>" + e(l.name) + "</td><td class=\"site-value-num\">" + span(l.unitsLow, l.units, siteValues.thousands) + " u</td>"
				+ "<td class=\"site-value-num\">&times; " + siteValues.thousands(l.price) + "</td>"
				+ "<td class=\"site-value-num\">" + (l.unitsLow !== l.units ? siteValues.rangeIsk(l.iskLow, l.isk) : siteValues.shortIsk(l.isk)) + "</td></tr>";
		}).join("");
		const total = "<tr class=\"site-value-total\"><td colspan=\"3\">Estimated value</td><td class=\"site-value-num\">~"
			+ (est.range ? siteValues.rangeIsk(est.low, est.total) : siteValues.shortIsk(est.total)) + " ISK</td></tr>";
		const notes = [];
		const wormhole = !!site.classes;
		if (site.note) { notes.push(e(site.note)); }
		else if (site.kind === "gas" && wormhole) { notes.push("Two clouds; Sleepers usually arrive 15-20 min after the first ship lands."); }
		if (est.status === "approximate") {
			if (site.kind === "gas") { notes.push("Approximate: EVE University only, and some of its cytoserocin pages weren't re-checked after CCP doubled cytoserocin in December 2021."); }
			else if (wormhole) { notes.push("Approximate: ore amounts change with the system class and more rocks spawn later."); }
			else { notes.push("Approximate: from one EVE University page (usually one player's scan of the site)."); }
		}
		if (est.lines.some(function(l) { return l.compressed; })) { notes.push("Ore is valued at the compressed ore price (each mined unit compresses into one compressed unit)."); }
		if (site.kind === "gas" && !wormhole) { notes.push("Gas is valued at the raw gas price (it trades well; compressed gas loses some when decompressed)."); }
		if (est.missing.length) { notes.push("No price for " + e(est.missing.join(", ")) + "."); }
		notes.push(siteValues.pricesNote(est.lines, pricesDate));
		notes.push("Contents: EVE University wiki" + (site.sourceDate ? " (" + e(site.sourceDate) + ")" : "") + ".");
		return head + "<table class=\"site-value-table\">" + rows + total + "</table>"
			+ "<div class=\"site-value-notes\">" + notes.join("<br>") + "</div>";
	},

	// ---- DOM ----

	data: null,
	sites: {},
	live: null,
	loading: false,

	load: function() {
		if (siteValues.data || siteValues.loading) { return; }
		siteValues.loading = true;
		$.ajax({ url: siteValues.DATA_URL, dataType: "json", cache: true }).done(function(d) {
			if (siteValues.valid(d)) { siteValues.data = d; siteValues.sites = siteValues.index(d); }
		}).always(function() { siteValues.loading = false; siteValues.schedule(); });
		siteValues.loadPrices();
	},

	pricesAt: 0,
	/** Live prices from the server (at most every 30 min per page; the server itself refreshes hourly) */
	loadPrices: function() {
		const now = Date.now();
		if (now - siteValues.pricesAt < 30 * 60000) { return; }
		siteValues.pricesAt = now;
		$.ajax({ url: siteValues.PRICES_URL, dataType: "json", cache: false }).done(function(d) {
			if (d && d.prices && typeof d.prices === "object" && Object.keys(d.prices).length) { siteValues.live = d.prices; siteValues.schedule(); }
		});
	},

	/** Add, update or remove the chip in every signature row (only the name cell of non-wormhole rows) */
	apply: function() {
		if (typeof tripwire === "undefined" || !tripwire.client) { return; }
		const on = siteValues.enabled(typeof options !== "undefined" ? options : undefined) && !!siteValues.data;
		const signatures = tripwire.client.signatures || {};
		$("#sigTable tbody tr[data-id]").each(function() {
			const $cell = $(this).children("td").eq(3);
			const site = on ? siteValues.siteFor(signatures[$(this).attr("data-id")], siteValues.sites) : null;
			let $chip = $cell.children(".site-value-chip");
			if (!site) { $chip.remove(); return; }
			const est = siteValues.estimate(site, siteValues.data, siteValues.live);
			const text = siteValues.chipText(est);
			const tip = siteValues.tooltip(site, est, siteValues.data.fallbackPrices && siteValues.data.fallbackPrices.date);
			if ($chip.length && $chip.text() === text && $chip.attr("data-tooltip") === tip) { return; }
			if (!$chip.length) {
				// right after the name (so the Leads To column still sorts by name); an inline-block that doesn't break, so in a
				// narrow cell it wraps under the name whole
				$chip = $("<span class=\"site-value-chip\"></span>").appendTo($cell);
			}
			$chip.text(text).attr("data-tooltip", tip)
				.toggleClass("site-value-approx", est.status === "approximate")
				.toggleClass("site-value-unknown", est.status === "unverified");
			const box = siteValues.tipBox();
			if (box && !$chip.data("siteValueTip")) {
				box.attach($chip);
				$chip.data("siteValueTip", true);
			}
		});
	},

	box: null,
	/** Our own tooltip (like upstream's Tooltips, but opened beside the right edge of the name cell rather than the chip,
	so it covers the next column instead of the chips of the rows above and below) */
	tipBox: function() {
		if (siteValues.box || typeof jBox === "undefined") { return siteValues.box; }
		siteValues.box = new jBox("Tooltip", {
			getContent: "data-tooltip",
			position: { x: "right", y: "center" },
			outside: "x",
			repositionOnOpen: true,
			onOpen: function() {
				const chip = this.source && this.source[0], cell = chip && this.source.closest("td")[0];
				const gap = cell ? Math.max(0, cell.getBoundingClientRect().right - chip.getBoundingClientRect().right) : 0;
				this.options.offset = { x: gap, y: 0 };
			}
		});
		return siteValues.box;
	},

	scheduled: null,
	schedule: function() {
		if (siteValues.scheduled) { return; }
		siteValues.scheduled = setTimeout(function() { siteValues.scheduled = null; siteValues.apply(); }, 50);
	},

	setupSettings: function() {
		// Settings > Signatures row; takes effect on Save (Reset = on)
		forkSettings.register({
			section: "signatures", order: 42, id: "siteValues-enabled", type: "checkbox", key: "siteValues",
			label: "Site value:", text: "Show the estimated ISK value of gas, ore, relic and data sites",
			get: function(o) { return siteValues.enabled(o); },
			set: function(o, on) { o.siteValues = { enabled: on }; }
		});
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.siteValuesWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				siteValues.schedule();
				return result;
			};
			options.apply.siteValuesWrapped = true;
		}
	},

	init: function() {
		siteValues.setupSettings();
		siteValues.load();
		// Rows are added, replaced (edits) and emptied (system change) by upstream: look again after any of that
		const tbody = document.querySelector("#sigTable > tbody");
		if (tbody && typeof MutationObserver !== "undefined") {
			new MutationObserver(siteValues.schedule).observe(tbody, { childList: true });
		}
		setInterval(siteValues.loadPrices, 30 * 60000);
		siteValues.schedule();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { siteValues.init(); });
}
