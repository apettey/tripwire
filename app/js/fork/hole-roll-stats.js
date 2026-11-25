const holeRollStats = {
	// Fork-owned: "Hole statistics" of the mask's home system, a research window on how wormholes roll. The server records
	// every hole with one end in home (holestats/holestats.inc.php, public/hole_stats.php): home's statics going out and
	// the holes coming in, with their signature ids, types and far systems, for everyone on the mask. This file reads
	// those rows and does the statistics in the browser (pure functions, tested in app/js-test/fork/hole-roll-stats.test.js):
	//  - a static roll is a hole whose home-side type is one of home's statics; one whose far side was never found still
	//    counts (destination unknown); repeat rates use only the rolls with a known destination;
	//  - expected repeats if every roll picked a system at random: among the N systems of the static's destination
	//    (destinationPool), after k rolls E[distinct] = N(1 - (1 - 1/N)^k) and E[repeats] = k - E[distinct];
	//  - an inbound hole is a K162 in home: by origin hole type (the far side's type, when known) and origin system;
	//  - per week (ISO), month, quarter, half-year and year (UTC); a CSV of the rows.
	// Entry points: "Hole statistics" in the System info panel's links (only while viewing home) and Ctrl+K. Settings >
	// Wormhole Jumps & Mass "Hole statistics button" (options.holeRollStats.enabled, missing = on) hides both; recording is
	// mask-wide and doesn't depend on it. Home is the mask's home system (Mask Admin > Discord > Home system).
	// Keep `const holeRollStats` on the first line: the test helper strips it to define a global.

	URL: "hole_stats.php",
	DIALOG_ID: "hole-roll-stats-dialog",
	GRANULARITIES: [["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["half", "Half-year"], ["year", "Year"]],
	MAX_PERIODS: 600,			// a timeline longer than this shows only its newest periods
	// Regions no wormhole leads to (Jove space) and Zarzakh: not counted in the k-space pools
	UNREACHABLE_REGIONS: [10000004, 10000017, 10000019],
	UNREACHABLE_SYSTEMS: [30100000],
	TRIGLAVIAN_FACTION: 500026,

	/** The feature's entry points are shown: options.holeRollStats.enabled, missing = on */
	enabled: function(opts) {
		return !(opts && opts.holeRollStats && opts.holeRollStats.enabled === false);
	},

	escape: function(text) {
		return String(text === null || text === undefined ? "" : text).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** A server time ('YYYY-MM-DD HH:MM:SS', UTC) as milliseconds, NaN when not one */
	parseTime: function(text) {
		const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ""));
		return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
	},

	/** 'YYYY-MM-DD' (UTC) of a time in ms */
	day: function(ms) {
		return isNaN(ms) ? "" : new Date(ms).toISOString().slice(0, 10);
	},

	/** Home's statics in upper case (appData.systems[home].statics) */
	staticsOf: function(homeID, systems) {
		const s = systems && systems[homeID];
		return s && Array.isArray(s.statics) ? s.statics.map(function(t) { return String(t).toUpperCase(); }) : [];
	},

	/** 'static' (home-side type is one of home's statics), 'inbound' (home side is a K162) or 'other' */
	classify: function(row, statics) {
		const type = String((row && row.homeType) || "").toUpperCase();
		if (type && statics.indexOf(type) >= 0) { return "static"; }
		if (type === "K162") { return "inbound"; }
		return "other";
	},

	/** The kind of space of a system as wormhole types name it ('Class-5', 'High-Sec', 'Triglavian'...), '' when unknown */
	spaceOf: function(systemID, systems) {
		const s = systems && systems[systemID];
		if (!s) { return ""; }
		const cls = Array.isArray(s.class) ? s.class[0] : s.class;
		if (cls) { return "Class-" + cls; }
		if (Number(s.factionID) === holeRollStats.TRIGLAVIAN_FACTION) { return "Triglavian"; }
		const sec = Number(s.security);
		return sec >= 0.45 ? "High-Sec" : sec > 0.0 ? "Low-Sec" : "Null-Sec";
	},

	/** Short label of a space ('C5', 'HS', 'Pochven') */
	spaceLabel: function(space) {
		if (!space) { return "?"; }
		const m = /^Class-(\d+)$/.exec(space);
		if (m) { return m[1] === "12" ? "Thera" : "C" + m[1]; }
		return { "High-Sec": "HS", "Low-Sec": "LS", "Null-Sec": "NS", "Triglavian": "Pochven" }[space] || space;
	},

	/** How many systems a hole leading to `leadsTo` could land in: systems of that space (exact class for J-space, so
	Thera, C13 and the Drifter systems are only in their own pools; shattered C1-C6 systems count with their class),
	k-space without Jove regions and Zarzakh. 0 when the space is not a pool of systems ('Unknown'...). */
	poolSize: function(leadsTo, systems) {
		const h = holeRollStats;
		if (!leadsTo || !systems) { return 0; }
		let n = 0;
		Object.keys(systems).forEach(function(id) {
			const s = systems[id];
			if (!s || h.UNREACHABLE_SYSTEMS.indexOf(Number(id)) >= 0 || h.UNREACHABLE_REGIONS.indexOf(Number(s.regionID)) >= 0) { return; }
			if (h.spaceOf(id, systems) === leadsTo) { n++; }
		});
		return n;
	},

	/** Expected distinct destinations and repeats after k rolls uniformly at random among n systems (null when n < 1) */
	expected: function(n, k) {
		if (!(n >= 1) || !(k >= 0)) { return null; }
		const distinct = n * (1 - Math.pow(1 - 1 / n, k));
		return { distinct: distinct, repeats: k - distinct };
	},

	/** Rows whose first sighting is within [from, to] ('YYYY-MM-DD', either may be empty; to includes its whole day) */
	inRange: function(rows, from, to) {
		const h = holeRollStats;
		const lo = from ? h.parseTime(from + " 00:00:00") : -Infinity;
		const hi = to ? h.parseTime(to + " 00:00:00") + 86400000 : Infinity;
		return (rows || []).filter(function(r) {
			const t = h.parseTime(r.firstSeen);
			return !isNaN(t) && t >= (isNaN(lo) ? -Infinity : lo) && t < (isNaN(hi) ? Infinity : hi);
		});
	},

	/** [{key, count, last (ms)}] counted by key(row) (rows with a key of null are left out), most first, then latest */
	countBy: function(rows, key) {
		const h = holeRollStats;
		const map = {};
		rows.forEach(function(r) {
			const k = key(r);
			if (k === null || k === undefined) { return; }
			const t = h.parseTime(r.firstSeen);
			if (!map[k]) { map[k] = { key: k, count: 0, last: -Infinity }; }
			map[k].count++;
			if (t > map[k].last) { map[k].last = t; }
		});
		return Object.keys(map).map(function(k) { return map[k]; })
			.sort(function(a, b) { return b.count - a.count || b.last - a.last || String(a.key).localeCompare(String(b.key)); });
	},

	/**
	 * Per static of home: {type, leadsTo, pool (N), rolls, known, distinct, repeats, expected: {distinct, repeats} or null,
	 * histogram: [{times, systems}], destinations: [{systemID, count, last}]}.
	 * @param wormholes appData.wormholes (leadsTo of each type)
	 */
	staticStats: function(rows, statics, systems, wormholes) {
		const h = holeRollStats;
		return statics.map(function(type) {
			const mine = rows.filter(function(r) { return String(r.homeType || "").toUpperCase() === type; });
			const known = mine.filter(function(r) { return Number(r.farSystemID) > 0; });
			const destinations = h.countBy(known, function(r) { return Number(r.farSystemID); })
				.map(function(d) { return { systemID: d.key, count: d.count, last: d.last }; });
			const leadsTo = wormholes && wormholes[type] ? wormholes[type].leadsTo : "";
			const pool = h.poolSize(leadsTo, systems);
			const byTimes = {};
			destinations.forEach(function(d) { byTimes[d.count] = (byTimes[d.count] || 0) + 1; });
			const histogram = Object.keys(byTimes).map(Number).sort(function(a, b) { return a - b; })
				.map(function(t) { return { times: t, systems: byTimes[t] }; });
			return {
				type: type, leadsTo: leadsTo, pool: pool, rolls: mine.length, known: known.length, distinct: destinations.length,
				repeats: known.length - destinations.length, expected: h.expected(pool, known.length),
				histogram: histogram, destinations: destinations
			};
		});
	},

	/** Inbound holes (K162 in home): {total, byType: [{type ('' = unknown), count, last}], bySystem: [{systemID (0 = unknown), count, last}]} */
	inboundStats: function(rows, statics) {
		const h = holeRollStats;
		const inbound = rows.filter(function(r) { return h.classify(r, statics) === "inbound"; });
		const type = function(r) { const t = String(r.farType || "").toUpperCase(); return t === "K162" ? "" : t; };
		return {
			total: inbound.length,
			byType: h.countBy(inbound, type).map(function(d) { return { type: d.key, count: d.count, last: d.last }; }),
			bySystem: h.countBy(inbound, function(r) { return Number(r.farSystemID) > 0 ? Number(r.farSystemID) : 0; })
				.map(function(d) { return { systemID: Number(d.key), count: d.count, last: d.last }; })
		};
	},

	// ---- Periods (UTC) ----

	/** Start (ms) of the period holding time ms */
	periodStart: function(ms, gran) {
		const d = new Date(ms);
		const y = d.getUTCFullYear(), m = d.getUTCMonth();
		switch (gran) {
			case "week": {
				const day = Date.UTC(y, m, d.getUTCDate());
				return day - ((new Date(day).getUTCDay() + 6) % 7) * 86400000;	// back to Monday
			}
			case "month": return Date.UTC(y, m, 1);
			case "quarter": return Date.UTC(y, m - m % 3, 1);
			case "half": return Date.UTC(y, m < 6 ? 0 : 6, 1);
			default: return Date.UTC(y, 0, 1);
		}
	},

	/** Start (ms) of the period after the one starting at `start` */
	nextPeriod: function(start, gran) {
		const d = new Date(start);
		const y = d.getUTCFullYear(), m = d.getUTCMonth();
		switch (gran) {
			case "week": return start + 7 * 86400000;
			case "month": return Date.UTC(y, m + 1, 1);
			case "quarter": return Date.UTC(y, m + 3, 1);
			case "half": return Date.UTC(y, m + 6, 1);
			default: return Date.UTC(y + 1, 0, 1);
		}
	},

	/** Label of the period holding ms: '2026-W48' (ISO week), '2026-11', '2026-Q4', '2026-H2', '2026' */
	periodKey: function(ms, gran) {
		const d = new Date(ms);
		const y = d.getUTCFullYear(), m = d.getUTCMonth();
		const pad = function(n) { return (n < 10 ? "0" : "") + n; };
		switch (gran) {
			case "week": {
				// ISO 8601: the week belongs to the year of its Thursday
				const thursday = new Date(holeRollStats.periodStart(ms, "week") + 3 * 86400000);
				const year = thursday.getUTCFullYear();
				const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86400000));
				return year + "-W" + pad(week);
			}
			case "month": return y + "-" + pad(m + 1);
			case "quarter": return y + "-Q" + (Math.floor(m / 3) + 1);
			case "half": return y + "-H" + (m < 6 ? 1 : 2);
			default: return String(y);
		}
	},

	/** [{key, start, static, inbound, other}] for every period from the first row's to the last row's (empty ones
	included), oldest first; at most MAX_PERIODS (the newest) */
	timeline: function(rows, statics, gran) {
		const h = holeRollStats;
		const times = rows.map(function(r) { return h.parseTime(r.firstSeen); }).filter(function(t) { return !isNaN(t); });
		if (!times.length) { return []; }
		const first = h.periodStart(Math.min.apply(null, times), gran);
		const last = h.periodStart(Math.max.apply(null, times), gran);
		const out = [];
		const index = {};
		for (let s = first; s <= last; s = h.nextPeriod(s, gran)) {
			index[s] = out.length;
			out.push({ key: h.periodKey(s, gran), start: s, static: 0, inbound: 0, other: 0 });
			if (out.length > 100000) { break; }
		}
		rows.forEach(function(r) {
			const t = h.parseTime(r.firstSeen);
			if (isNaN(t)) { return; }
			out[index[h.periodStart(t, gran)]][h.classify(r, statics)]++;
		});
		return out.length > h.MAX_PERIODS ? out.slice(out.length - h.MAX_PERIODS) : out;
	},

	// ---- CSV ----

	/** One CSV field: quoted when needed; text that a spreadsheet would run as a formula gets a leading ' */
	csvField: function(value) {
		let s = String(value === null || value === undefined ? "" : value);
		if (/^[=+\-@\t\r]/.test(s)) { s = "'" + s; }
		return /[",\r\n]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
	},

	/** The rows as CSV (oldest first), with the kind of each hole and the far system's name and space */
	toCSV: function(rows, statics, systems) {
		const h = holeRollStats;
		const head = ["first_seen_utc", "last_updated_utc", "kind", "home_sig", "home_type", "far_system", "far_system_id", "far_space", "far_sig", "far_type", "source", "side_guessed"];
		const sorted = rows.slice().sort(function(a, b) { return h.parseTime(a.firstSeen) - h.parseTime(b.firstSeen) || (a.id || 0) - (b.id || 0); });
		const lines = [head.join(",")].concat(sorted.map(function(r) {
			const far = Number(r.farSystemID) > 0 ? Number(r.farSystemID) : 0;
			const name = far && systems && systems[far] ? systems[far].name : "";
			return [r.firstSeen, r.lastUpdated, h.classify(r, statics), String(r.homeSig || "").toUpperCase(), r.homeType, name, far || "",
				far ? h.spaceLabel(h.spaceOf(far, systems)) : "", String(r.farSig || "").toUpperCase(), r.farType, r.source, r.guessed ? 1 : 0]
				.map(h.csvField).join(",");
		}));
		return lines.join("\r\n") + "\r\n";
	},

	// ---- Rendering (HTML strings; every value from the server is escaped) ----

	systemName: function(systemID, systems) {
		const s = systems && systems[systemID];
		return s && s.name ? s.name : (systemID ? String(systemID) : "unknown");
	},

	timeText: function(ms) {
		return isNaN(ms) || !isFinite(ms) ? "" : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
	},

	fmt: function(n, digits) {
		return n === null || n === undefined || isNaN(n) ? "–" : Number(n).toFixed(digits || 0);
	},

	/** A sortable table of [{systemID, count, last}] (sort: {key: 'count'|'name'|'last', dir}) */
	systemTable: function(list, systems, sort, table) {
		const h = holeRollStats;
		const rows = list.slice();
		const name = function(d) { return d.systemID ? h.systemName(d.systemID, systems) : "~"; };
		rows.sort(function(a, b) {
			let c = sort.key === "name" ? name(a).localeCompare(name(b)) : sort.key === "last" ? a.last - b.last : a.count - b.count || a.last - b.last;
			return sort.dir === "asc" ? c : -c;
		});
		const th = function(key, label, cls) {
			const on = sort.key === key ? " hrs-sorted-" + sort.dir : "";
			return "<th class='hrs-sortable" + (cls ? " " + cls : "") + on + "' tabindex='0' data-table='" + table + "' data-sort='" + key + "'>" + label + "</th>";
		};
		return "<table class='hrs-table'><thead><tr>" + th("name", "System") + "<th>Space</th>" + th("count", "Times", "hrs-num") + th("last", "Last seen (UTC)") + "</tr></thead><tbody>"
			+ rows.map(function(d) {
				const space = d.systemID ? h.spaceLabel(h.spaceOf(d.systemID, systems)) : "";
				return "<tr" + (d.count >= 2 && d.systemID ? " class='hrs-hot'" : "") + "><td>" + (d.systemID ? h.escape(h.systemName(d.systemID, systems)) : "<i>unknown</i>")
					+ "</td><td>" + h.escape(space) + "</td><td class='hrs-num'>" + d.count + "</td><td class='hrs-nowrap'>" + h.escape(h.timeText(d.last)) + "</td></tr>";
			}).join("") + "</tbody></table>";
	},

	renderStatic: function(s, systems, sort) {
		const h = holeRollStats;
		const space = h.spaceLabel(s.leadsTo);
		const exp = s.expected;
		const rate = function(r, k) { return k > 0 ? " (" + h.fmt(100 * r / k) + "%)" : ""; };
		let html = "<h4>" + h.escape(s.type) + " static" + (s.leadsTo ? " to " + h.escape(space) : "") + "</h4>";
		html += "<table class='hrs-table hrs-metrics'><tbody>"
			+ "<tr><th>Rolls (holes of this static)</th><td class='hrs-num'>" + s.rolls + "</td></tr>"
			+ "<tr><th>With a known destination</th><td class='hrs-num'>" + s.known + "</td></tr>"
			+ "<tr><th>Distinct destinations</th><td class='hrs-num'>" + s.distinct + "</td></tr>"
			+ "<tr><th>Repeats (a destination seen before)</th><td class='hrs-num'>" + s.repeats + rate(s.repeats, s.known) + "</td></tr>"
			+ "<tr><th title='If every roll picked one of the N systems at random: N(1 - (1 - 1/N)^k) distinct after k rolls'>Expected repeats if random"
			+ (s.pool ? " (N = " + s.pool + " " + h.escape(space) + " systems)" : "") + "</th><td class='hrs-num'>"
			+ (exp ? h.fmt(exp.repeats, 1) + rate(exp.repeats, s.known) : "–") + "</td></tr>"
			+ "</tbody></table>";
		if (s.histogram.length) {
			html += "<p class='hrs-sub'>Destinations seen: " + s.histogram.map(function(b) {
				return (b.times === 1 ? "once" : b.times === 2 ? "twice" : b.times + " times") + ": " + b.systems;
			}).join(" · ") + "</p>";
			html += h.systemTable(s.destinations, systems, sort, "static-" + s.type);
		} else {
			html += "<p class='hrs-empty'>No roll of this static with a known destination" + (s.rolls ? " yet." : ".") + "</p>";
		}
		return html;
	},

	renderInbound: function(inb, systems, sort) {
		const h = holeRollStats;
		let html = "<h4>Inbound holes (a K162 in home): " + inb.total + "</h4>";
		if (!inb.total) { return html + "<p class='hrs-empty'>No K162 in home recorded.</p>"; }
		html += "<div class='hrs-cols'><div><h5>By origin hole type</h5><table class='hrs-table'><thead><tr><th>Type</th><th>From</th><th class='hrs-num'>Times</th><th>Last seen (UTC)</th></tr></thead><tbody>"
			+ inb.byType.map(function(t) {
				const wh = t.type && typeof appData !== "undefined" && appData.wormholes ? appData.wormholes[t.type] : null;
				const from = wh ? [].concat(wh.from || []).map(h.spaceLabel).join("/") : "";
				return "<tr" + (t.count >= 2 && t.type ? " class='hrs-hot'" : "") + "><td>" + (t.type ? h.escape(t.type) : "<i>unknown</i>") + "</td><td>" + h.escape(from)
					+ "</td><td class='hrs-num'>" + t.count + "</td><td class='hrs-nowrap'>" + h.escape(h.timeText(t.last)) + "</td></tr>";
			}).join("") + "</tbody></table></div>"
			+ "<div><h5>By origin system</h5>" + h.systemTable(inb.bySystem, systems, sort, "inbound") + "</div></div>";
		return html;
	},

	renderTimeline: function(periods, gran) {
		const h = holeRollStats;
		if (!periods.length) { return "<p class='hrs-empty'>No holes in this range.</p>"; }
		const max = Math.max.apply(null, periods.map(function(p) { return p.static + p.inbound + p.other; }).concat([1]));
		const bar = function(p) {
			const w = function(n) { return (100 * n / max).toFixed(1) + "%"; };
			return "<span class='hrs-bar'><span class='hrs-bar-static' style='width:" + w(p.static) + "'></span><span class='hrs-bar-inbound' style='width:" + w(p.inbound)
				+ "'></span><span class='hrs-bar-other' style='width:" + w(p.other) + "'></span></span>";
		};
		const label = h.GRANULARITIES.filter(function(g) { return g[0] === gran; })[0];
		return "<table class='hrs-table hrs-timeline'><thead><tr><th>" + h.escape(label ? label[1] : "Period") + " (UTC)</th><th class='hrs-num'>Static rolls</th><th class='hrs-num'>Inbound</th><th class='hrs-num'>Other</th><th>"
			+ "<span class='hrs-key hrs-bar-static'></span> static <span class='hrs-key hrs-bar-inbound'></span> inbound <span class='hrs-key hrs-bar-other'></span> other</th></tr></thead><tbody>"
			+ periods.slice().reverse().map(function(p) {
				return "<tr><td class='hrs-nowrap'>" + h.escape(p.key) + "</td><td class='hrs-num'>" + p.static + "</td><td class='hrs-num'>" + p.inbound
					+ "</td><td class='hrs-num'>" + p.other + "</td><td>" + bar(p) + "</td></tr>";
			}).join("") + "</tbody></table>";
	},

	/** The whole body for the server's answer and the window's state ({from, to, gran, sorts}) */
	render: function(data, state, systems, wormholes) {
		const h = holeRollStats;
		if (!data || !(Number(data.home) > 0)) {
			return "<p class='hrs-empty hrs-nohome'>No home system is set for this mask, so no holes are recorded. Hole statistics records the holes of the mask's home "
				+ "system: a Tripwire admin of the corporation sets it in Mask Admin &gt; Discord &gt; Home system (corporation masks).</p>";
		}
		const home = Number(data.home);
		const statics = h.staticsOf(home, systems);
		const all = data.rows || [];
		const rows = h.inRange(all, state.from, state.to);
		const counts = { static: 0, inbound: 0, other: 0 };
		rows.forEach(function(r) { counts[h.classify(r, statics)]++; });
		const guessed = rows.filter(function(r) { return r.guessed; }).length;
		const oldest = all.length ? h.parseTime(all[all.length - 1].firstSeen) : NaN;
		const sortOf = function(table) { return state.sorts[table] || { key: "count", dir: "desc" }; };

		let html = "<div class='hrs-tiles'>"
			+ "<div class='hrs-tile'><div class='hrs-tile-v'>" + counts.static + "</div><div class='hrs-tile-l'>static rolls</div></div>"
			+ "<div class='hrs-tile'><div class='hrs-tile-v'>" + counts.inbound + "</div><div class='hrs-tile-l'>inbound holes (K162)</div></div>"
			+ "<div class='hrs-tile'><div class='hrs-tile-v'>" + counts.other + "</div><div class='hrs-tile-l'>other or type not set</div></div>"
			+ "</div>";
		if (!statics.length) { html += "<p class='hrs-warn'>" + h.escape(h.systemName(home, systems)) + " has no static.</p>"; }
		statics.forEach(function(type) {
			const s = h.staticStats(rows, [type], systems, wormholes)[0];
			html += h.renderStatic(s, systems, sortOf("static-" + type));
		});
		html += h.renderInbound(h.inboundStats(rows, statics), systems, sortOf("inbound"));
		html += "<h4>Over time</h4>" + h.renderTimeline(h.timeline(rows, statics, state.gran), state.gran);

		const notes = [];
		notes.push("A hole counts once: deleted and added again with the same home signature ID within 48 hours is the same hole. "
			+ "A static whose far side was never found counts as a roll; repeats use only rolls with a known destination. "
			+ "\"Other\" holes have no type on the home side, or a type that is neither a static nor K162.");
		if (data.backfill) {
			notes.push("Holes before " + h.escape(String(data.backfill.doneAt).slice(0, 10)) + " were read once from the audit log (its history only) and the map.");
		}
		if (guessed) { notes.push(guessed + " of these older holes didn't record which end had the type: it was worked out from where the type can lead, or guessed."); }
		if (data.capped) { notes.push("Only the newest " + Number(data.max) + " holes are shown."); }
		if (!isNaN(oldest)) { notes.push("Oldest hole recorded: " + h.escape(h.day(oldest)) + ". Times are UTC."); }
		html += "<div class='hrs-notes'>" + notes.map(function(n) { return "<p>" + n + "</p>"; }).join("") + "</div>";
		return html;
	},

	// ---- Window ----

	state: { data: null, from: "", to: "", gran: "month", sorts: {}, loading: false },

	ensureDialog: function() {
		const h = holeRollStats;
		let $d = $("#" + h.DIALOG_ID);
		if (!$d.length) {
			$d = $("<div id='" + h.DIALOG_ID + "'></div>").appendTo("body");
			$d.html("<div class='hrs-wrap'><div class='hrs-head'>"
				+ "<label>From <input type='date' class='hrs-from' /></label> <label>to <input type='date' class='hrs-to' /></label>"
				+ " <label>Per <select class='hrs-gran'>" + h.GRANULARITIES.map(function(g) { return "<option value='" + g[0] + "'>" + g[1] + "</option>"; }).join("") + "</select></label>"
				+ "<span class='hrs-spacer'></span><button type='button' class='hrs-refresh' title='Read the holes again'>Refresh</button>"
				+ "<button type='button' class='hrs-csv' data-track='holeRollStats.csv' title='Every recorded hole of home as a CSV file'>Download CSV</button></div>"
				+ "<div class='hrs-body'></div></div>");
			$d.on("change", ".hrs-from, .hrs-to, .hrs-gran", function() {
				h.state.from = $d.find(".hrs-from").val() || "";
				h.state.to = $d.find(".hrs-to").val() || "";
				h.state.gran = $d.find(".hrs-gran").val() || "month";
				h.draw();
			});
			$d.on("click", ".hrs-refresh", function() { h.load(); });
			$d.on("click", ".hrs-csv", function() { h.download(); });
			$d.on("click keydown", "th.hrs-sortable", function(e) {
				if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") { return; }
				e.preventDefault();
				const table = $(this).attr("data-table");
				const key = $(this).attr("data-sort");
				const was = h.state.sorts[table] || { key: "count", dir: "desc" };
				h.state.sorts[table] = was.key === key ? { key: key, dir: was.dir === "desc" ? "asc" : "desc" } : { key: key, dir: key === "name" ? "asc" : "desc" };
				h.draw();
			});
		}
		if (!$d.hasClass("ui-dialog-content")) {
			$d.dialog({
				autoOpen: false, title: "Hole statistics", modal: false, resizable: true,
				width: Math.min(760, $(window).width() - 40), height: Math.min(680, Math.max(360, $(window).height() - 60)), minWidth: 420, minHeight: 260,
				dialogClass: "dialog-noeffect ui-dialog-shadow dialog-floating dialog-hole-stats"
			});
		}
		$d.find(".hrs-gran").val(h.state.gran);
		return $d;
	},

	/** fromCommand: Ctrl+K, which forkUsage counts as holeRollStats.command already */
	open: function(fromCommand) {
		const h = holeRollStats;
		const $d = h.ensureDialog();
		if (!$d.dialog("isOpen")) { $d.dialog("open"); }
		$d.dialog("moveToTop");
		if (typeof forkUsage !== "undefined" && fromCommand !== true) { forkUsage.track("holeRollStats", "opened"); }
		h.load();
	},

	load: function() {
		const h = holeRollStats;
		const $body = $("#" + h.DIALOG_ID + " .hrs-body");
		$body.html("<p class='hrs-dim'>Loading…</p>");
		$.ajax({ url: h.URL, data: { mode: "rows" }, dataType: "json", cache: false })
			.done(function(data) {
				h.state.data = data;
				h.setHome(Number(data && data.home) || 0);
				h.draw();
			})
			.fail(function(xhr) { $body.html("<p class='hrs-empty'>Could not load the hole statistics (" + h.escape(xhr.status) + ").</p>"); });
	},

	draw: function() {
		const h = holeRollStats;
		const $d = $("#" + h.DIALOG_ID);
		const data = h.state.data;
		const systems = typeof appData !== "undefined" ? appData.systems : {};
		const home = data ? Number(data.home) || 0 : 0;
		$d.dialog("option", "title", "Hole statistics" + (home ? " – " + h.systemName(home, systems) : ""));
		$d.find(".hrs-csv").prop("disabled", !(data && data.rows && data.rows.length));
		const $body = $d.find(".hrs-body");
		const scroll = $body.scrollTop();
		let html;
		try {
			html = h.render(data, h.state, systems, typeof appData !== "undefined" ? appData.wormholes : {});
		} catch (e) {
			console.error("Hole statistics: could not draw", e);
			html = "<p class='hrs-empty'>Could not draw the statistics.</p>";
		}
		$body.html(html);
		$body.scrollTop(scroll);
	},

	download: function() {
		const h = holeRollStats;
		const data = h.state.data;
		if (!data || !data.rows || !data.rows.length) { return; }
		const systems = typeof appData !== "undefined" ? appData.systems : {};
		const csv = h.toCSV(data.rows, h.staticsOf(Number(data.home), systems), systems);
		const name = "hole-statistics-" + h.systemName(Number(data.home), systems).replace(/[^A-Za-z0-9-]/g, "") + "-" + new Date().toISOString().slice(0, 10) + ".csv";
		const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
	},

	// ---- Entry points ----

	home: 0,			// the mask's home system (0 = none or not known yet)
	homeMask: null,		// the mask `home` was read for

	setHome: function(home) {
		holeRollStats.home = home;
		holeRollStats.updateLink();
	},

	activeMask: function() {
		return typeof options !== "undefined" && options && options.masks ? String(options.masks.active) : "";
	},

	/** Read the mask's home (once per mask) */
	fetchHome: function() {
		const h = holeRollStats;
		const mask = h.activeMask();
		if (h.homeMask === mask) { return; }
		h.homeMask = mask;
		$.ajax({ url: h.URL, data: { mode: "home" }, dataType: "json", cache: false })
			.done(function(r) { if (h.homeMask === mask) { h.setHome(Number(r && r.home) || 0); } });
	},

	/** The System info panel's "Hole statistics" link: only while viewing home, with the feature on */
	updateLink: function() {
		const h = holeRollStats;
		const viewing = typeof viewingSystemID !== "undefined" ? Number(viewingSystemID) : 0;
		const show = h.enabled(typeof options !== "undefined" ? options : null) && h.home > 0 && viewing === h.home;
		$("#infoLinks .hrs-info-link, #infoLinks .hrs-info-sep").toggle(show);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined") {
	jQuery(function() {
		const h = holeRollStats;
		if (typeof tripwire === "undefined") { return; }
		const opts = function() { return typeof options !== "undefined" ? options : null; };

		// System info panel link (shown by updateLink)
		const $links = $("#infoLinks");
		if ($links.length) {
			$links.append("<span class='hrs-info-sep' style='display:none'> - </span><a href='#' class='hrs-info-link' style='display:none' title='Static rolls and inbound holes of the mask&#39;s home system'>Hole statistics</a>");
			$links.on("click", ".hrs-info-link", function(e) { e.preventDefault(); h.open(); });
		}
		if (typeof tripwire.systemChange === "function" && !tripwire.systemChange.holeRollStatsWrapped) {
			const original = tripwire.systemChange;
			const wrapped = function() {
				const result = original.apply(this, arguments);
				try { h.fetchHome(); h.updateLink(); } catch (e) { console.error("Hole statistics: link failed", e); }
				return result;
			};
			Object.keys(original).forEach(function(k) { wrapped[k] = original[k]; });	// other wrappers' markers
			wrapped.holeRollStatsWrapped = true;
			tripwire.systemChange = wrapped;
		}
		h.fetchHome();

		// Command palette
		if (typeof forkCommands !== "undefined") {
			forkCommands.register({
				id: "holeRollStats.open", title: "Hole statistics", group: "Holes", icon: "info",
				keywords: ["hole", "statistics", "stats", "static", "roll", "rolls", "rolling", "k162", "inbound", "home", "research"],
				enabled: function() { return h.enabled(opts()) ? true : "Turned off in Settings > Wormhole Jumps & Mass"; },
				run: function() { h.open(true); }
			});
		}

		// Settings > Wormhole Jumps & Mass
		if (typeof forkSettings !== "undefined") {
			forkSettings.register({
				section: "jumps", order: 24, id: "holeRollStats-enabled", type: "checkbox", key: "holeRollStats",
				label: "Hole statistics button:",
				text: "Show Hole statistics in the System info panel of home and in Ctrl+K",
				hint: "Hole statistics: how often your home static rolls, where it lands and which holes open into home. "
					+ "The holes of the mask's home system are recorded for everyone on the mask either way.",
				keywords: ["hole", "statistics", "stats", "static", "roll", "k162", "research"],
				get: function(o) { return h.enabled(o); },
				set: function(o, value) { o.holeRollStats = Object.assign({}, o.holeRollStats || {}, { enabled: !!value }); },
				reset: function(o) { delete o.holeRollStats; }
			});
		}
		// Settings Save and Reset end in options.apply: show or hide the link at once
		if (typeof options !== "undefined" && options && typeof options.apply === "function" && !options.apply.holeRollStatsWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				try { h.updateLink(); } catch (e) { console.error("Hole statistics: link failed", e); }
				return result;
			};
			Object.keys(apply).forEach(function(k) { options.apply[k] = apply[k]; });
			options.apply.holeRollStatsWrapped = true;
		}
	});
}
