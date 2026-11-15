const siteValues = {
	// Estimated ISK value of wormhole gas and ore sites (fork-owned, see changes/2026-11-15-site-value-estimate):
	// a chip such as "~1.4B" after the site name in the signature list, with a tooltip of what is in the site.
	// Site contents: public/site-values/sites.json (sources and how sure we are are in the file). Prices: the
	// server's hourly copy of ESI's public /markets/prices/ (public/market_prices.php); until it answers, or when it
	// can't, the prices stored in sites.json. Sites the data marks "unverified" get a "?" chip and no value.
	// Setting: options.siteValues.enabled (missing = on). Keep `const siteValues` on the first line: the test helper
	// strips it to define a global.

	DATA_URL: "site-values/sites.json",
	PRICES_URL: "market_prices.php",
	STATUSES: ["verified", "approximate", "unverified"],

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

	/** {key: site} for every site name and alias in the data */
	index: function(data) {
		const index = {};
		if (!siteValues.valid(data)) { return index; }
		data.sites.forEach(function(site) {
			if (!site || !site.name) { return; }
			[site.name].concat(Array.isArray(site.aliases) ? site.aliases : []).forEach(function(name) { index[siteValues.key(name)] = site; });
		});
		return index;
	},

	/** The site for a signature (client shape), or null: never for wormholes, only for names in the data */
	siteFor: function(sig, index) {
		if (!sig || sig.type === "wormhole" || !index) { return null; }
		return index[siteValues.key(sig.name)] || null;
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
	@return {status, total, lines: [{name, units, m3, price, isk}] (highest ISK first), live (every price live), missing (types without a price)} */
	estimate: function(site, data, live) {
		const status = site && siteValues.STATUSES.indexOf(site.status) >= 0 ? site.status : "unverified";
		const out = { status: status, total: 0, lines: [], live: true, missing: [] };
		if (!site || status === "unverified" || !Array.isArray(site.contents) || !data) {
			out.status = "unverified";
			out.live = false;
			return out;
		}
		const fallback = data.fallbackPrices && data.fallbackPrices.prices;
		site.contents.forEach(function(row) {
			if (!Array.isArray(row)) { return; }
			const type = data.types && data.types[String(row[0])];
			const units = Number(row[1]);
			if (!type || !(units > 0)) { return; }
			// Ore is priced as its compressed form (priceAs), 1 unit for 1 unit: raw ore hardly trades
			const p = siteValues.priceOf(type.priceAs || row[0], live, fallback);
			if (!p) { out.missing.push(type.name); return; }
			if (!p.live) { out.live = false; }
			const isk = units * p.price;
			out.lines.push({ name: String(type.name), units: units, m3: units * (Number(type.m3) || 0), price: p.price, isk: isk, compressed: !!type.priceAs, live: p.live });
			out.total += isk;
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

	/** Chip text: "~1.4B", or "?" when there is no value */
	chipText: function(est) {
		return !est || est.status === "unverified" ? "?" : "~" + siteValues.shortIsk(est.total);
	},

	/** Escape text for HTML (tooltips are HTML; every text here is ours, escaped anyway) */
	escape: function(text) {
		return String(text).replace(/[&<>"']/g, function(c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; });
	},

	/** Tooltip HTML for a site and its estimate.
	@param pricesDate date of the fallback prices (shown when some price isn't live) */
	tooltip: function(site, est, pricesDate) {
		const e = siteValues.escape;
		const head = "<b>" + e(site.name) + "</b> (" + e(site.kind || "site") + (site.classes ? ", " + e(site.classes) : "") + ")";
		if (!est || est.status === "unverified") {
			return head + "<br>No value: the contents of this site couldn't be verified."
				+ (site.reason ? "<br>" + e(site.reason) : "");
		}
		const rows = est.lines.map(function(l) {
			return "<tr><td>" + e(l.name) + "</td><td class=\"site-value-num\">" + siteValues.thousands(l.units) + " u</td>"
				+ "<td class=\"site-value-num\">&times; " + siteValues.thousands(l.price) + "</td>"
				+ "<td class=\"site-value-num\">" + siteValues.shortIsk(l.isk) + "</td></tr>";
		}).join("");
		const total = "<tr class=\"site-value-total\"><td colspan=\"3\">Estimated value</td><td class=\"site-value-num\">~" + siteValues.shortIsk(est.total) + " ISK</td></tr>";
		const notes = [];
		if (site.kind === "gas") { notes.push("Two clouds; Sleepers usually arrive 15-20 min after the first ship lands."); }
		if (est.status === "approximate") { notes.push("Approximate: ore amounts change with the system class and more rocks spawn later."); }
		if (est.lines.some(function(l) { return l.compressed; })) { notes.push("Ore is valued at the compressed ore price (each mined unit compresses into one compressed unit)."); }
		if (est.missing.length) { notes.push("No price for " + e(est.missing.join(", ")) + "."); }
		const stored = est.lines.filter(function(l) { return !l.live; });
		if (!stored.length) { notes.push("Prices: ESI average market price, updated hourly."); }
		else if (stored.length === est.lines.length) { notes.push("Prices: ESI average market price of " + e(pricesDate || "an earlier date") + " (live prices unavailable)."); }
		else {
			notes.push("Prices: ESI average market price, updated hourly; " + e(stored.map(function(l) { return l.name; }).join(", "))
				+ " at the price of " + e(pricesDate || "an earlier date") + " (no live price).");
		}
		notes.push("Contents: EVE University wiki.");
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
			label: "Gas and ore site value:", text: "Show the estimated ISK value of wormhole gas and ore sites",
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
