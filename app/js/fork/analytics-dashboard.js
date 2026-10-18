const analyticsDashboard = {
	// Fork-owned: the usage analytics dashboard (docker/README.md#product-analytics) for the operators listed in
	// ANALYTICS_ADMINS. Data from public/fork_analytics.php (aggregates only, small counts already "<5" / "<3"); this file
	// only draws: plain tables, CSS bars and inline-SVG sparklines, no chart library. Opened from the user menu (the
	// character name, top right) or Ctrl+K "Usage analytics"; both appear only when the server says this character may.
	// Keep `const analyticsDashboard` on the first line: the test helper strips it to define a global. Pure logic first.

	URL: "fork_analytics.php",
	DIALOG_ID: "dialog-analytics",
	TABS: [
		{ mode: "features", title: "Features" },
		{ mode: "funnel", title: "Funnel" },
		{ mode: "launches", title: "Launches" },
		{ mode: "off", title: "Turned off" },
		{ mode: "never", title: "Never used" },
		{ mode: "health", title: "App health" },
		{ mode: "tips", title: "Tips & What's New" }
	],
	SECTIONS: { general: "General", markers: "Map Markers", jumps: "Jumps & Mass", signatures: "Signatures", routes: "Routes",
		jumpPlanner: "Jump Planner", intel: "Kills & Intel", killReporting: "Kill Reporting", maskAdmin: "Mask Admin", chain: "Chain Map" },
	WEEKDAYS: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],

	// ---- Pure logic (tested under mocha) ----

	escape: function(s) {
		return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** A count the server suppressed ("<5" users, "<3" masks) */
	isSuppressed: function(v) {
		return typeof v === "string" && /^<\d+$/.test(v);
	},

	/** A number to sort and draw by: numbers as they are, "<5" as 2.5 (half the limit), a range "36-39" by its middle,
	 *  anything else (null, "—") as null */
	value: function(v) {
		if (typeof v === "number" && isFinite(v)) { return v; }
		if (typeof v !== "string") { return null; }
		let m = /^<(\d+)$/.exec(v);
		if (m) { return Number(m[1]) / 2; }
		m = /^(\d+)-(\d+)$/.exec(v);
		if (m) { return (Number(m[1]) + Number(m[2])) / 2; }
		return null;
	},

	/** A count as text: "—" for nothing, a range with an en dash */
	count: function(v) {
		if (v === null || v === undefined) { return "—"; }
		if (typeof v === "string") { return v.replace(/^(\d+)-(\d+)$/, "$1–$2"); }
		return String(v);
	},

	pct: function(p) {
		return typeof p === "number" && isFinite(p) ? p + "%" : "—";
	},

	/** Wilson score 95% interval of k in n as fractions [lo, hi]; null when n is 0 (or not a number) */
	wilson: function(k, n, z) {
		if (typeof k !== "number" || typeof n !== "number" || !(n > 0)) { return null; }
		z = z || 1.96;
		const p = k / n, z2 = z * z, den = 1 + z2 / n;
		const mid = (p + z2 / (2 * n)) / den;
		const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
		return [Math.max(0, mid - half), Math.min(1, mid + half)];
	},

	/** "k of n" as "34% (22–48%)" when both are exact counts, else "—" */
	rate: function(k, n) {
		const ci = analyticsDashboard.wilson(k, n);
		if (!ci || analyticsDashboard.isSuppressed(k) || k > n) { return "—"; }
		return Math.round(100 * k / n) + "% (" + Math.floor(100 * ci[0]) + "–" + Math.ceil(100 * ci[1]) + "%)";
	},

	/**
	 * SVG path of a sparkline: values oldest first (numbers, "<5", or null for "not released yet" = a gap), w x h box, 1px
	 * inset. Returns {d, dots: [{x, y, v}], max}. A suppressed value is drawn at half its limit.
	 */
	sparkPath: function(values, w, h) {
		const vals = (values || []).map(analyticsDashboard.value);
		const max = Math.max.apply(null, [1].concat(vals.filter(function(v) { return v !== null; })));
		const step = vals.length > 1 ? (w - 2) / (vals.length - 1) : 0;
		let d = "", pen = false;
		const dots = [];
		vals.forEach(function(v, i) {
			if (v === null) { pen = false; return; }
			const x = Math.round((1 + i * step) * 10) / 10;
			const y = Math.round((h - 1 - (h - 2) * v / max) * 10) / 10;
			d += (pen ? "L" : "M") + x + " " + y;
			pen = true;
			dots.push({ x: x, y: y, v: values[i] });
		});
		return { d: d, dots: dots, max: max };
	},

	/** Rows sorted by a getter (stable); rows without a value go last whichever way */
	sortRows: function(rows, get, dir) {
		const sign = dir === "asc" ? 1 : -1;
		return rows.map(function(r, i) { return { r: r, i: i, v: get(r) }; }).sort(function(a, b) {
			const an = a.v === null || a.v === undefined, bn = b.v === null || b.v === undefined;
			if (an || bn) { return an === bn ? a.i - b.i : (an ? 1 : -1); }
			if (a.v < b.v) { return -sign; }
			if (a.v > b.v) { return sign; }
			return a.i - b.i;
		}).map(function(x) { return x.r; });
	},

	/** Heatmap shade 0-5 of a cell against the largest cell */
	heatLevel: function(v, max) {
		const n = analyticsDashboard.value(v);
		if (!n || !(max > 0)) { return 0; }
		return Math.max(1, Math.min(5, Math.ceil(5 * n / max)));
	},

	// ---- Views (browser only) ----

	state: { tab: "features", data: {}, sort: { key: "used", dir: "desc" }, funnel: null, features: null },

	FLAGS: {
		silent: ["No events since release", "Released 7+ days ago and nothing at all was recorded: tracking may be broken"],
		unused: ["No use", "An active feature nobody used in 28 days"]
	},

	sectionName: function(key) {
		return analyticsDashboard.SECTIONS[key] || key || "";
	},

	sparkSvg: function(values, w, h, cls) {
		const a = analyticsDashboard;
		w = w || 84;
		h = h || 22;
		const p = a.sparkPath(values, w, h);
		const tip = (values || []).map(function(v) { return v === null ? "–" : a.count(v); }).join(", ");
		return "<svg class='an-spark" + (cls ? " " + cls : "") + "' width='" + w + "' height='" + h + "' viewBox='0 0 " + w + " " + h + "' role='img' aria-label='Weekly users, oldest first: "
			+ a.escape(tip) + "'><title>Weekly users, oldest first: " + a.escape(tip) + "</title>"
			+ "<line class='an-spark-base' x1='1' y1='" + (h - 0.5) + "' x2='" + (w - 1) + "' y2='" + (h - 0.5) + "' />"
			+ (p.d ? "<path d='" + p.d + "' />" : "")
			+ p.dots.slice(-1).map(function(d) { return "<circle cx='" + d.x + "' cy='" + d.y + "' r='1.8' />"; }).join("") + "</svg>";
	},

	bar: function(pct, text, cls) {
		const w = typeof pct === "number" ? Math.max(0, Math.min(100, pct)) : 0;
		return "<span class='an-bar " + (cls || "") + "'><span class='an-bar-fill' style='width:" + w + "%'></span><span class='an-bar-text'>" + text + "</span></span>";
	},

	empty: function(text) {
		return "<p class='an-empty'>" + analyticsDashboard.escape(text) + "</p>";
	},

	FEATURE_COLS: [
		{ key: "title", title: "Feature", get: function(f) { return f.title.toLowerCase(); }, dir: "asc" },
		{ key: "section", title: "Section", get: function(f) { return analyticsDashboard.sectionName(f.section).toLowerCase(); }, dir: "asc" },
		{ key: "prs", title: "PRs", get: function(f) { return f.prs.length ? f.prs[0] : null; } },
		{ key: "released", title: "Released", get: function(f) { return f.released; } },
		{ key: "eligible", title: "Eligible", get: function(f) { return analyticsDashboard.value(f.eligible); }, tip: "Active users (28 days) without the feature turned off" },
		{ key: "exposed", title: "Exposed", get: function(f) { return analyticsDashboard.value(f.exposed); }, tip: "Users who had it on screen or used it (28 days)" },
		{ key: "used", title: "Used", get: function(f) { return analyticsDashboard.value(f.used); }, tip: "Users with a use event (28 days): command, opened or the feature's own use actions" },
		{ key: "adoption", title: "Adoption", get: function(f) { return f.adoption ? f.adoption.pct : null; }, tip: "Eligible users who used it ÷ eligible, with a 95% interval" },
		{ key: "repeat", title: "Repeat", get: function(f) { return f.repeat.pct; }, tip: "Share of users who used it on 3+ days in 28" },
		{ key: "optOut", title: "Opt-out", get: function(f) { return f.optOut ? (f.optOut.pct !== null ? f.optOut.pct : analyticsDashboard.value(f.optOut.users) / 100) : null; }, tip: "Active users with it turned off now" },
		{ key: "masks", title: "Masks", get: function(f) { return analyticsDashboard.value(f.masks); }, tip: "Masks where someone used it (28 days)" },
		{ key: "spark", title: "12 weeks", get: function(f) { return analyticsDashboard.value(f.spark[f.spark.length - 1]); }, tip: "Users a week, oldest first; the last point is the last 7 days" }
	],

	renderFeatures: function(data) {
		const a = analyticsDashboard;
		const col = a.FEATURE_COLS.filter(function(c) { return c.key === a.state.sort.key; })[0] || a.FEATURE_COLS[6];
		const rows = a.sortRows(data.features, col.get, a.state.sort.dir);
		const head = a.FEATURE_COLS.map(function(c) {
			const on = c.key === col.key;
			return "<th class='an-sortable" + (on ? " an-sorted-" + a.state.sort.dir : "") + "' data-sort='" + c.key + "'"
				+ (c.tip ? " title='" + a.escape(c.tip) + "'" : "") + " tabindex='0'>" + a.escape(c.title) + "</th>";
		}).join("");
		const body = rows.map(function(f) {
			const flags = f.flags.map(function(k) {
				const fl = a.FLAGS[k];
				return fl ? " <span class='an-flag an-flag-" + k + "' title='" + a.escape(fl[1]) + "'>" + a.escape(fl[0]) + "</span>" : "";
			}).join("");
			let adoption;
			if (f.adoption) {
				adoption = a.bar(f.adoption.pct, f.adoption.pct + "% <span class='an-dim'>" + f.adoption.lo + "–" + f.adoption.hi + "</span>");
			} else {
				adoption = "<span class='an-dim'>" + (a.isSuppressed(f.used) || a.isSuppressed(f.usedEligible) ? "&lt;5 users" : "—") + "</span>";
			}
			if (f.kind === "passive" && f.used === 0) { adoption = "<span class='an-dim' title='Drawn on the map: no use action, see Exposed and Opt-out'>passive</span>"; }
			const repeat = f.repeat.pct !== null ? f.repeat.pct + "%" : (a.isSuppressed(f.repeat.users) ? "&lt;5" : "—");
			const optOut = !f.optOut ? "<span class='an-dim' title='No Settings toggle'>n/a</span>"
				: (f.optOut.pct !== null ? f.optOut.pct + "%" : a.escape(a.count(f.optOut.users)) + " <span class='an-dim'>users</span>");
			return "<tr data-feature='" + a.escape(f.id) + "' class='an-row-link' title='Open the funnel of " + a.escape(f.title) + "'>"
				+ "<td class='an-name'>" + a.escape(f.title) + (f.audience !== "all" ? " <span class='an-dim'>(" + a.escape(f.audience === "maskAdmin" ? "mask admins" : f.audience) + ")</span>" : "") + flags + "</td>"
				+ "<td class='an-nowrap'>" + a.escape(a.sectionName(f.section)) + "</td>"
				+ "<td class='an-dim'>" + f.prs.map(function(p) { return "#" + a.escape(p); }).join(" ") + "</td>"
				+ "<td class='an-nowrap'>" + a.escape(f.released || "—") + "</td>"
				+ "<td class='an-num'>" + a.escape(a.count(f.eligible)) + "</td>"
				+ "<td class='an-num'>" + a.escape(a.count(f.exposed)) + "</td>"
				+ "<td class='an-num'>" + a.escape(a.count(f.used)) + "</td>"
				+ "<td title='Eligible users who used it ÷ eligible users'>" + adoption + "</td>"
				+ "<td class='an-num'>" + repeat + "</td>"
				+ "<td class='an-num'>" + optOut + "</td>"
				+ "<td class='an-num'>" + a.escape(a.count(f.masks)) + "</td>"
				+ "<td>" + a.sparkSvg(f.spark) + "</td></tr>";
		}).join("");
		const flagged = data.features.filter(function(f) { return f.flags.length; }).length;
		return "<p class='an-sub'>" + a.escape(a.count(data.active)) + " active users in the last " + data.window + " days. "
			+ data.features.length + " features" + (flagged ? ", " + flagged + " flagged" : "") + ". Click a column to sort, a row for its funnel.</p>"
			+ "<table class='an-table an-features'><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
	},

	renderFunnel: function(data, features) {
		const a = analyticsDashboard;
		const options = (features || []).slice().sort(function(x, y) { return x.title.localeCompare(y.title); }).map(function(f) {
			return "<option value='" + a.escape(f.id) + "'" + (data && data.feature.id === f.id ? " selected" : "") + ">" + a.escape(f.title) + "</option>";
		}).join("");
		let out = "<p class='an-sub'><label>Feature <select class='an-funnel-pick'>" + options + "</select></label></p>";
		if (!data) { return out + a.empty("Pick a feature."); }
		const LABELS = { eligible: ["Eligible", "active users without it turned off"], exposed: ["Exposed", "had it on screen or used it"],
			tried: ["Tried", "used it at least once"], repeat: ["Repeat", "used it on 3+ days"], retained: ["Retained", "used it in two weeks in a row"] };
		const top = a.value(data.steps[0].users) || Math.max.apply(null, [1].concat(data.steps.map(function(s) { return a.value(s.users) || 0; })));
		const byKey = {};
		data.steps.forEach(function(s) { byKey[s.key] = s; });
		out += "<p class='an-sub'>Users from " + a.escape(data.from) + " to " + a.escape(data.today) + ". Each share is of the step named next to it"
			+ " (repeat and retained are both shares of tried: someone can come back in a second week without using it on 3 days).</p>";
		out += "<table class='an-table an-funnel'><thead><tr><th>Step</th><th>Users</th><th></th><th title='Share of the step named, with a 95% interval'>Share</th></tr></thead><tbody>";
		data.steps.forEach(function(s) {
			const base = s.base ? byKey[s.base] : null;
			const v = a.value(s.users) || 0;
			out += "<tr><td><b>" + LABELS[s.key][0] + "</b> <span class='an-dim'>" + LABELS[s.key][1] + "</span></td>"
				+ "<td class='an-num'>" + a.escape(a.count(s.users)) + "</td>"
				+ "<td class='an-funnel-bar'>" + a.bar(Math.round(100 * v / top), "") + "</td>"
				+ "<td class='an-num'>" + (base ? a.rate(typeof s.users === "number" ? s.users : null, typeof base.users === "number" ? base.users : null)
					+ " <span class='an-dim'>of " + a.escape(LABELS[base.key][0].toLowerCase()) + "</span>" : "") + "</td></tr>";
		});
		out += "</tbody></table>";
		const t = data.toUse;
		out += "<p>Median time from first seeing it to first use: <b>" + (t.medianHours === null ? "—" : a.escape(a.hours(t.medianHours))) + "</b>"
			+ " <span class='an-dim'>(" + a.escape(a.count(t.users)) + " users seen before they used it; " + a.escape(a.count(t.usedBeforeShown))
			+ " used it before it was ever counted as seen" + (t.since ? "; only since " + a.escape(t.since) : "") + ")</span>"
			+ (t.before ? " <span class='an-dim'>Pseudonym salt replaced on " + a.escape(t.before) + ": only people who first saw and used it"
				+ " before then (after it, returning people get new ids that would look like first-time users).</span>" : "") + "</p>";
		if (data.feature.kind === "passive") { out += "<p class='an-dim'>Passive feature (drawn on the map): few or no use actions, so Exposed and Turned off say more.</p>"; }
		return out;
	},

	hours: function(h) {
		if (h < 1) { return Math.round(h * 60) + " min"; }
		if (h < 48) { return (Math.round(h * 10) / 10) + " h"; }
		return (Math.round(h / 2.4) / 10) + " days";
	},

	renderLaunches: function(data) {
		const a = analyticsDashboard;
		if (!data.launches.length) { return a.empty("No What's New entries."); }
		const cell = function(c) {
			if (!c) { return "<td class='an-dim an-num'>not yet</td>"; }
			if (c.noData) { return "<td class='an-dim an-num' title='Released before the first day with data'>no data</td>"; }
			if (c.pct === null) { return "<td class='an-num'>" + a.escape(a.count(c.users)) + " <span class='an-dim'>of " + a.escape(a.count(c.active)) + "</span></td>"; }
			return "<td>" + a.bar(c.pct, c.pct + "% <span class='an-dim'>" + a.escape(a.count(c.users)) + "/" + a.escape(a.count(c.active)) + "</span>") + "</td>";
		};
		return "<p class='an-sub'>The last " + data.launches.length + " What's New entries: share of users active since the release date who used the feature by day 1, 7, 14 and 28."
			+ " A follow-up PR counts every use of its feature, also by people who used it before.</p>"
			+ "<table class='an-table'><thead><tr><th>PR</th><th>Date</th><th>What's New</th><th>Feature</th><th>Day 1</th><th>Day 7</th><th>Day 14</th><th>Day 28</th></tr></thead><tbody>"
			+ data.launches.map(function(l) {
				return "<tr" + (l.feature ? " data-feature='" + a.escape(l.feature.id) + "' class='an-row-link'" : "") + "><td>#" + a.escape(l.pr) + "</td><td class='an-nowrap'>" + a.escape(l.date) + "</td>"
					+ "<td>" + a.escape(l.title) + (l.flag ? " <span class='an-flag' title='Under 10% of active users tried it by day 14'>&lt;10% by day 14</span>" : "") + "</td>"
					+ "<td>" + (l.feature ? a.escape(l.feature.title) + (l.feature.followUp ? " <span class='an-dim'>(follow-up)</span>" : "") : "<span class='an-dim'>not a feature (skipped in the catalog)</span>") + "</td>"
					+ cell(l.days["1"]) + cell(l.days["7"]) + cell(l.days["14"]) + cell(l.days["28"]) + "</tr>";
			}).join("") + "</tbody></table>";
	},

	renderOff: function(data) {
		const a = analyticsDashboard;
		const rows = a.sortRows(data.features, function(f) { return f.pct !== null ? f.pct : a.value(f.offNow) / 100; }, "desc");
		return "<p class='an-sub'>Features with a Settings toggle. Off now: active users (" + a.escape(a.count(data.active)) + ", 28 days) whose daily snapshot says it is off."
			+ " Turned off: users who switched it off in the last " + data.window + " days, split by whether they had used it before.</p>"
			+ "<table class='an-table'><thead><tr><th>Feature</th><th>Section</th><th>Off now</th><th>Turned off</th><th>after using it</th><th>without trying it</th><th>Turned back on</th></tr></thead><tbody>"
			+ rows.map(function(f) {
				const split = f.afterUsing === null ? "<td class='an-dim an-num' colspan='2' title='Hidden: one part is under 5 users'>&lt;5 in one part</td>"
					: "<td class='an-num'>" + f.afterUsing + "</td><td class='an-num'>" + f.withoutTrying + "</td>";
				return "<tr data-feature='" + a.escape(f.id) + "' class='an-row-link'><td>" + a.escape(f.title) + "</td><td>" + a.escape(a.sectionName(f.section)) + "</td>"
					+ "<td>" + (f.pct !== null ? a.bar(f.pct * 2, f.pct + "% <span class='an-dim'>" + a.escape(a.count(f.offNow)) + "</span>", "an-bar-warn") : "<span class='an-num'>" + a.escape(a.count(f.offNow)) + "</span>") + "</td>"
					+ "<td class='an-num'>" + a.escape(a.count(f.turnedOff)) + "</td>" + split
					+ "<td class='an-num'>" + a.escape(a.count(f.turnedOn)) + "</td></tr>";
			}).join("") + "</tbody></table>";
	},

	renderNever: function(data) {
		const a = analyticsDashboard;
		const table = function(rows) {
			const WHY = { few: "fewer than 5 users", norepeat: "nobody came back (3+ days)", fewseen: "passive: fewer than 5 users saw it" };
			return "<table class='an-table'><thead><tr><th>Feature</th><th>Section</th><th>Kind</th><th>Released</th><th>Age</th><th>Users (" + data.days + " d)</th><th>Saw it</th><th>Repeat users</th><th>Why</th></tr></thead><tbody>"
				+ rows.map(function(f) {
					return "<tr data-feature='" + a.escape(f.id) + "' class='an-row-link'><td>" + a.escape(f.title) + "</td><td>" + a.escape(a.sectionName(f.section)) + "</td><td>" + a.escape(f.kind) + "</td>"
						+ "<td class='an-nowrap'>" + a.escape(f.released || "unknown") + "</td><td class='an-num'>" + (f.age === null ? "—" : f.age + " d") + "</td>"
						+ "<td class='an-num'>" + a.escape(a.count(f.users)) + "</td><td class='an-num'>" + a.escape(a.count(f.seen)) + "</td><td class='an-num'>" + a.escape(a.count(f.repeat)) + "</td>"
						+ "<td>" + a.escape(WHY[f.reason] || f.reason) + "</td></tr>";
				}).join("") + "</tbody></table>";
		};
		return "<p class='an-sub'>Candidates to prune, rethink or make easier to find, released more than " + data.minAge + " days ago: an active feature with fewer than 5 users in the "
			+ data.days + " days kept or nobody using it on 3+ days; a passive one (drawn on the map, no use events) that fewer than 5 users had on screen.</p>"
			+ (data.candidates.length ? table(data.candidates) : a.empty("No feature older than " + data.minAge + " days qualifies."))
			+ "<h4>Not judged yet <span class='an-dim'>(released under " + data.minAge + " days ago, or no release date)</span></h4>"
			+ (data.tooNew.length ? table(data.tooNew) : a.empty("None."));
	},

	renderHealth: function(data) {
		const a = analyticsDashboard;
		const tile = function(label, v, tip) {
			return "<div class='an-tile' title='" + a.escape(tip) + "'><div class='an-tile-v'>" + a.escape(v) + "</div><div class='an-tile-l'>" + a.escape(label) + "</div></div>";
		};
		let out = "<div class='an-tiles'>"
			+ tile("daily active (median, last 7 days)", a.count(data.dauMedian7), "Median of the users with real keyboard/mouse input on each of the 7 full days before today")
			+ tile("weekly active", a.count(data.wau), "Users active in the last 7 days")
			+ tile(data.window + "-day active", a.count(data.mau), "Users active in the last " + data.window + " days")
			+ tile("weekly ÷ " + data.window + "-day", a.pct(data.stickiness), "How many of the month's users came back this week")
			+ tile("new, 7 days", a.count(data.new7), data.new7 === null ? "Not counted: the pseudonym salt was replaced in this window, so everyone looks new" : "First activity in the last 7 days")
			+ tile("new, " + data.window + " days", a.count(data.new28), data.new28 === null ? "Not counted: the pseudonym salt was replaced in this window, so everyone looks new" : "First activity in the last " + data.window + " days")
			+ tile("masks, 7 days", a.count(data.masks7), "Masks where someone used a feature")
			+ tile("masks, " + data.window + " days", a.count(data.masks28), "Masks where someone used a feature")
			+ "</div>";
		const max = Math.max.apply(null, [1].concat(data.dau.map(function(d) { return a.value(d.users) || 0; })));
		out += "<h4>Daily active users, last " + data.window + " days</h4><div class='an-cols'>" + data.dau.map(function(d) {
			const v = a.value(d.users) || 0;
			return "<div class='an-col' title='" + a.escape(d.day + ": " + a.count(d.users)) + "'><span style='height:" + Math.round(100 * v / max) + "%'></span></div>";
		}).join("") + "</div><div class='an-cols-axis'><span>" + a.escape(data.dau[0].day) + "</span><span>" + a.escape(data.dau[data.dau.length - 1].day) + "</span></div>";
		out += "<h4>Weekly active users, 12 weeks <span class='an-dim'>(oldest first)</span></h4>" + a.sparkSvg(data.weeks, 336, 44, "an-spark-big")
			+ " <span class='an-dim'>" + data.weeks.map(a.count).join(" · ") + "</span>";
		let hmax = 1;
		data.heat.forEach(function(r) { r.forEach(function(v) { hmax = Math.max(hmax, a.value(v) || 0); }); });
		out += "<h4>When people are active <span class='an-dim'>(UTC, last " + data.window + " days)</span></h4>"
			+ "<p class='an-dim'>User-days with a feature's first event of the day in that hour. Only the first time each feature is used in a day has a time, so late hours of long sessions are under-counted.</p>"
			+ "<table class='an-heat'><thead><tr><th></th>";
		for (let h = 0; h < 24; h++) { out += "<th>" + (h % 3 === 0 ? h : "") + "</th>"; }
		out += "</tr></thead><tbody>" + data.heat.map(function(r, wd) {
			return "<tr><th>" + a.WEEKDAYS[wd] + "</th>" + r.map(function(v, h) {
				return "<td class='an-heat-" + a.heatLevel(v, hmax) + "' title='" + a.WEEKDAYS[wd] + " " + (h < 10 ? "0" : "") + h + ":00 UTC: " + a.escape(a.count(v)) + "'></td>";
			}).join("") + "</tr>";
		}).join("") + "</tbody></table>";
		return out;
	},

	renderTips: function(data) {
		const a = analyticsDashboard;
		let out = "<h4>Feature tips by feature <span class='an-dim'>(last " + data.window + " days)</span></h4>";
		out += data.tips.length
			? "<table class='an-table'><thead><tr><th>Feature</th><th>Tip shown</th><th>Acted on it</th><th title='Used the feature within 7 days of first seeing its tip'>Used within 7 days</th></tr></thead><tbody>" + data.tips.map(function(t) {
				const share = function(n, pct) { return pct !== null ? a.bar(pct, pct + "% <span class='an-dim'>" + a.escape(a.count(n)) + "</span>") : a.escape(a.count(n)); };
				return "<tr data-feature='" + a.escape(t.id) + "' class='an-row-link'><td>" + a.escape(t.title) + "</td><td class='an-num'>" + a.escape(a.count(t.shown)) + "</td>"
					+ "<td>" + share(t.acted, t.actedPct) + "</td><td>" + share(t.used7, t.used7Pct) + "</td></tr>";
			}).join("") + "</tbody></table>"
			: a.empty("No tip has been shown yet (tips report hint_shown / hint_acted per feature once they ship).");
		out += "<h4>Tip outcomes <span class='an-dim'>(all tips together: the outcome events don't say which tip)</span></h4>";
		out += data.hints.length
			? "<table class='an-table'><thead><tr><th>Outcome</th><th>Users (" + data.window + " d)</th><th>Events</th></tr></thead><tbody>" + data.hints.map(function(h) {
				return "<tr><td>" + a.escape(h.action) + "</td><td class='an-num'>" + a.escape(a.count(h.users)) + "</td><td class='an-num'>" + a.escape(a.count(h.events)) + "</td></tr>";
			}).join("") + "</tbody></table>"
			: a.empty("No tip outcomes yet (tip_shown, acted, got_it, closed, ignored, section_off).");
		const off = data.tipsOff;
		out += "<p>\u201cShow feature tips\u201d turned off: <b>" + a.escape(a.count(off.turnedOff)) + "</b> users in " + data.window + " days; off now: <b>"
			+ a.escape(a.count(off.offNow)) + "</b>" + (off.pct !== null ? " (" + off.pct + "% of " + a.escape(a.count(off.active)) + " active)" : "")
			+ ". <span class='an-dim'>More than a few % a month means tips come too often.</span></p>";
		out += "<h4>What's New</h4><p class='an-sub'>" + a.escape(a.count(data.whatsNew.opened)) + " users opened What's New themselves in the last " + data.window
			+ " days (the automatic opening after an update isn't counted). Per release: active users in the 7 days from the release date who opened it.</p>";
		out += data.whatsNew.releases.length
			? "<table class='an-table'><thead><tr><th>Released</th><th>PRs</th><th>Active</th><th>Opened What's New</th></tr></thead><tbody>" + data.whatsNew.releases.map(function(r) {
				return "<tr><td class='an-nowrap'>" + a.escape(r.date) + (r.complete ? "" : " <span class='an-dim'>(week not over)</span>") + "</td>"
					+ "<td class='an-dim'>" + r.prs.slice(0, 8).map(function(p) { return "#" + a.escape(p); }).join(" ") + (r.prs.length > 8 ? " +" + (r.prs.length - 8) : "") + "</td>"
					+ "<td class='an-num'>" + a.escape(a.count(r.active)) + "</td>"
					+ "<td>" + (r.pct !== null ? a.bar(r.pct, r.pct + "% <span class='an-dim'>" + a.escape(a.count(r.opened)) + "</span>") : a.escape(a.count(r.opened))) + "</td></tr>";
			}).join("") + "</tbody></table>"
			: a.empty("No releases.");
		return out;
	},

	/** The warning for a pseudonym salt replacement inside a view's window (text, escaped) */
	rotationNote: function(data, tab) {
		const a = analyticsDashboard, r = data && data.rotation;
		if (!r || !r.date) { return ""; }
		const extra = {
			health: " New users are not counted for windows that include it."
		}[tab] || "";
		return "Pseudonym salt replaced on " + r.date + ": people active before and after it count twice in this view until " + r.until
			+ " (their ids changed)." + extra;
	},

	// ---- Dialog ----

	ensureDialog: function() {
		const a = analyticsDashboard;
		let $d = $("#" + a.DIALOG_ID);
		if (!$d.length) {
			$d = $("<div id='" + a.DIALOG_ID + "'></div>").appendTo("body");
			$d.html("<div class='an-wrap'><div class='an-head'><div class='an-tabs' role='tablist'>" + a.TABS.map(function(t) {
				return "<button type='button' role='tab' data-tab='" + t.mode + "'>" + a.escape(t.title) + "</button>";
			}).join("") + "</div><button type='button' class='an-refresh' title='Read the numbers again'>Refresh</button></div>"
				+ "<p class='an-caveat'>Tens of users: read as direction, not precision. Counts of 1–4 users show as &lt;5 (masks: &lt;3);"
				+ " people are accounts, days are UTC.</p><div class='an-body'></div></div>");
			$d.on("click", ".an-tabs button", function() { a.show($(this).attr("data-tab")); });
			$d.on("click", ".an-refresh", function() { a.state.data = {}; a.show(a.state.tab); });
			$d.on("click keydown", "th.an-sortable", function(e) {
				if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") { return; }
				e.preventDefault();
				const key = $(this).attr("data-sort");
				const col = a.FEATURE_COLS.filter(function(c) { return c.key === key; })[0];
				a.state.sort = a.state.sort.key === key ? { key: key, dir: a.state.sort.dir === "desc" ? "asc" : "desc" } : { key: key, dir: col.dir || "desc" };
				a.draw();
			});
			$d.on("click", "tr.an-row-link", function() { a.state.funnel = $(this).attr("data-feature"); a.show("funnel"); });
			$d.on("change", ".an-funnel-pick", function() { a.state.funnel = this.value; a.show("funnel"); });
		}
		if (!$d.hasClass("ui-dialog-content")) {
			$d.dialog({
				autoOpen: false, title: "Usage analytics", modal: false, resizable: true,
				width: Math.min(1180, $(window).width() - 40), height: Math.min(720, Math.max(380, $(window).height() - 60)), minWidth: 520, minHeight: 300,
				dialogClass: "dialog-noeffect ui-dialog-shadow dialog-floating dialog-analytics"
			});
		}
		return $d;
	},

	/** fromCommand: Ctrl+K, which forkUsage counts as analyticsDashboard.command already (one open, one use) */
	open: function(tab, fromCommand) {
		const a = analyticsDashboard;
		const $d = a.ensureDialog();
		if (!$d.dialog("isOpen")) { $d.dialog("open"); }
		$d.dialog("moveToTop");
		if (typeof forkUsage !== "undefined" && fromCommand !== true) { forkUsage.track("analyticsDashboard", "opened"); }
		a.show(tab || a.state.tab);
	},

	/** Load (once per open dialog, or on Refresh) and draw a tab */
	show: function(tab) {
		const a = analyticsDashboard;
		a.state.tab = tab;
		const $d = $("#" + a.DIALOG_ID);
		$d.find(".an-tabs button").each(function() {
			const on = $(this).attr("data-tab") === tab;
			$(this).toggleClass("an-active", on).attr("aria-selected", on ? "true" : "false");
		});
		if (tab === "funnel") {
			// The funnel's picker needs the feature list (from the Features view)
			a.load("features", null, function(features) {
				if (!a.state.funnel) {
					const best = a.sortRows(features.features, function(f) { return a.value(f.used); }, "desc")[0];
					a.state.funnel = best ? best.id : null;
				}
				if (!a.state.funnel) { a.draw(); return; }
				a.load("funnel", a.state.funnel, function() { a.draw(); });
			});
			return;
		}
		a.load(tab, null, function() { a.draw(); });
	},

	load: function(mode, feature, done) {
		const a = analyticsDashboard;
		const key = mode + (feature ? ":" + feature : "");
		if (a.state.data[key]) { done(a.state.data[key]); return; }
		$("#" + a.DIALOG_ID + " .an-body").html("<p class='an-dim'>Loading…</p>");
		$.ajax({ url: a.URL, data: feature ? { mode: mode, feature: feature } : { mode: mode }, dataType: "json", cache: false })
			.done(function(data) { a.state.data[key] = data; done(data); })
			.fail(function(xhr) {
				$("#" + a.DIALOG_ID + " .an-body").html(a.empty(xhr.status === 403 ? "Not allowed: this character is not in ANALYTICS_ADMINS." : "Could not load the statistics (" + xhr.status + ")."));
			});
	},

	draw: function() {
		const a = analyticsDashboard;
		const tab = a.state.tab;
		const $body = $("#" + a.DIALOG_ID + " .an-body");
		const scroll = $body.scrollTop();
		const data = tab === "funnel" ? a.state.data["funnel:" + a.state.funnel] : a.state.data[tab];
		let html;
		try {
			switch (tab) {
				case "features": html = a.renderFeatures(data); break;
				case "funnel": html = a.renderFunnel(data, a.state.data.features ? a.state.data.features.features : []); break;
				case "launches": html = a.renderLaunches(data); break;
				case "off": html = a.renderOff(data); break;
				case "never": html = a.renderNever(data); break;
				case "health": html = a.renderHealth(data); break;
				case "tips": html = a.renderTips(data); break;
			}
		} catch (e) {
			console.error("Usage analytics: could not draw " + tab, e);
			html = a.empty("Could not draw this view.");
		}
		const off = data && data.enabled === false ? "<p class='an-warn'>Collection is turned off on this server (ANALYTICS_ENABLED): showing what is stored.</p>" : "";
		const rotation = a.rotationNote(data, tab);
		$body.html(off + (rotation ? "<p class='an-warn an-rotation'>" + a.escape(rotation) + "</p>" : "") + html);
		if (tab === "features") { $body.scrollTop(scroll); }
	},

	/** Show the entry points (user menu button, Ctrl+K) when the server says this character may open the dashboard */
	setup: function() {
		const a = analyticsDashboard;
		if ($("#analytics-open").length) { return; }
		$("#logoutTable").append("<tr class='analytics-menu-row'><td colspan='2'><input type='button' id='analytics-open' value='Usage analytics' title='Which features are used (operators only)' /></td></tr>");
		$("#analytics-open").on("click", function() {
			$("#login > #panel").css({ display: "none" });
			$("#user").removeClass("active");
			a.open();
		});
		if (typeof forkCommands !== "undefined") {
			forkCommands.register({
				id: "analytics.open", title: "Usage analytics", group: "App", icon: "info",
				keywords: ["analytics", "statistics", "usage", "adoption", "dashboard", "metrics"],
				run: function() { a.open(undefined, true); }
			});
		}
	},

	init: function() {
		$.ajax({ url: analyticsDashboard.URL, data: { mode: "access" }, dataType: "json", cache: false })
			.done(function(r) { if (r && r.admin === true) { analyticsDashboard.setup(); } });
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined") {
	jQuery(function() { analyticsDashboard.init(); });
}
