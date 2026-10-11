const threat90d = {
	// System Threat, 90 days (fork-owned): inside the Threat & residents section, a 7 d / 90 d switch, a 24-bar
	// kills-by-hour-of-day sparkline (EVE time = UTC), the busiest window, the top groups (kills on 3+ different days)
	// and how long ago it was analysed. The numbers come from the `profile` of public/system_threat.php (computed from
	// the kills the server stores, see zkill/profile.php). Rendered by systemThreat.sectionHtml; shown and hidden with
	// the section (Settings > "System threat & residents"). Keep `const threat90d` on the first line: the test helper
	// strips it to define a global.
	STORAGE_KEY: "tripwire.threat90d.period",
	PERIODS: [{ key: "d7", label: "7d", days: 7 }, { key: "d90", label: "90d", days: 90 }],
	LEVEL_NAMES: { none: "Quiet", low: "Low", moderate: "Moderate", high: "High", critical: "Critical" },
	BAR_WIDTH: 6,
	BAR_GAP: 1,
	BAR_HEIGHT: 26,
	period: "d90",

	escape: function(text) {
		return String(text === null || text === undefined ? "" : text).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	pad: function(hour) {
		return (hour < 10 ? "0" : "") + hour + ":00";
	},

	/** "18:00–22:00 EVE" for {start, end} (hours, end exclusive) */
	windowLabel: function(busiest) {
		return threat90d.pad(busiest.start) + "–" + threat90d.pad(busiest.end);
	},

	/**
	 * The same window in the viewer's clock, "20:00–00:00", from a Date offset function. UTC hours do not shift with
	 * daylight saving, but the local ones do, so the offset is taken for today.
	 * @param offsetMinutes minutes to add to UTC (e.g. 120 for UTC+2); defaults to the browser's offset now
	 */
	localLabel: function(busiest, offsetMinutes) {
		const offset = typeof offsetMinutes === "number" ? offsetMinutes : -new Date().getTimezoneOffset();
		if (offset === 0) { return ""; }
		const shift = function(hour) {
			const minutes = (((hour * 60 + offset) % 1440) + 1440) % 1440;
			const h = Math.floor(minutes / 60);
			const m = minutes % 60;
			return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
		};
		return shift(busiest.start) + "–" + shift(busiest.end);
	},

	/** Rough prime-time region of the window's middle (EVE players call them AU / EU / US TZ) */
	timezone: function(busiest) {
		const length = ((busiest.end - busiest.start) + 24) % 24 || 24;
		const middle = (busiest.start + length / 2) % 24;
		if (middle >= 6 && middle < 15) { return "AU"; }
		if (middle >= 15 && middle < 22) { return "EU"; }
		return "US";
	},

	/** 24 counts, anything else becomes zeros */
	cleanHours: function(hours) {
		const out = [];
		for (let i = 0; i < 24; i++) {
			const n = Array.isArray(hours) ? parseInt(hours[i], 10) : 0;
			out.push(n > 0 ? n : 0);
		}
		return out;
	},

	/** Whether an hour lies in the busiest window (wrapping around midnight) */
	inWindow: function(hour, busiest) {
		if (!busiest) { return false; }
		return ((hour - busiest.start + 24) % 24) < (((busiest.end - busiest.start) + 24) % 24 || 24);
	},

	/** 24-bar sparkline as SVG; the busiest window is orange, the rest blue (Okabe-Ito pair, safe for colour blindness) */
	sparkline: function(hours, busiest) {
		const esc = threat90d.escape;
		const h = threat90d.cleanHours(hours);
		const max = Math.max.apply(null, h.concat([1]));
		const step = threat90d.BAR_WIDTH + threat90d.BAR_GAP;
		const width = 24 * step - threat90d.BAR_GAP;
		const total = h.reduce(function(a, b) { return a + b; }, 0);
		let svg = "<svg class='threat90d-chart' viewBox='0 0 " + width + " " + (threat90d.BAR_HEIGHT + 10) + "' width='" + width + "' height='" + (threat90d.BAR_HEIGHT + 10)
			+ "' role='img' aria-label='" + esc("Kills by hour of day, EVE time: " + total + " kills") + "'>";
		h.forEach(function(n, hour) {
			const bar = n > 0 ? Math.max(2, Math.round(n / max * threat90d.BAR_HEIGHT)) : 1;
			const busy = threat90d.inWindow(hour, busiest);
			svg += "<rect class='threat90d-bar" + (busy ? " threat90d-busy" : "") + (n === 0 ? " threat90d-zero" : "") + "' x='" + (hour * step)
				+ "' y='" + (threat90d.BAR_HEIGHT - bar) + "' width='" + threat90d.BAR_WIDTH + "' height='" + bar + "'><title>"
				+ esc(threat90d.pad(hour) + " EVE: " + n + (n === 1 ? " kill" : " kills")) + "</title></rect>";
		});
		// Hour ticks under the bars at 00, 06, 12, 18
		[0, 6, 12, 18].forEach(function(hour) {
			svg += "<text class='threat90d-tick' x='" + (hour * step) + "' y='" + (threat90d.BAR_HEIGHT + 9) + "'>" + (hour < 10 ? "0" : "") + hour + "</text>";
		});
		return svg + "</svg>";
	},

	groupURL: function(group) {
		return "https://zkillboard.com/" + (group.kind === "alliance" ? "alliance" : "corporation") + "/" + parseInt(group.id, 10) + "/";
	},

	/** Top groups as a list; names = {id: name} from the response (empty while ESI names are still being looked up) */
	groupsHtml: function(groups, names) {
		const esc = threat90d.escape;
		if (!groups || !groups.length) { return "<div class='threat-muted'>No group with kills on 3 or more different days.</div>"; }
		const known = names || {};
		let html = "<ol class='threat90d-groups'>";
		groups.forEach(function(g) {
			const name = Object.prototype.hasOwnProperty.call(known, String(g.id)) && known[String(g.id)] ? String(known[String(g.id)]) : "";
			html += "<li><a href='" + esc(threat90d.groupURL(g)) + "' target='_blank' rel='noopener noreferrer'>"
				+ esc(name || (g.kind === "alliance" ? "Alliance " : "Corporation ") + g.id) + "</a> "
				+ "<span class='threat-stats' title='" + esc(g.kills + " kills on " + g.days + " different days, " + g.losses + " ships lost here") + "'>"
				+ esc(g.kills + (g.kills === 1 ? " kill" : " kills") + " · " + g.days + " days" + (g.losses ? " · " + g.losses + " lost" : "")) + "</span></li>";
		});
		return html + "</ol>";
	},

	/** "analysed 12 min ago" */
	analysedText: function(analysedAt, nowMs) {
		const t = Date.parse(analysedAt);
		if (!(t > 0)) { return ""; }
		const seconds = Math.max(0, Math.round((nowMs - t) / 1000));
		if (seconds < 90) { return "analysed just now"; }
		if (seconds < 5400) { return "analysed " + Math.round(seconds / 60) + " min ago"; }
		if (seconds < 172800) { return "analysed " + Math.round(seconds / 3600) + " h ago"; }
		return "analysed " + Math.round(seconds / 86400) + " d ago";
	},

	/**
	 * Section body for one profile.
	 * @param profile  response.detail.profile
	 * @param view     {period: "d7"|"d90", names: {id: name}, offsetMinutes (tests)}
	 */
	html: function(profile, nowMs, view) {
		const esc = threat90d.escape;
		if (!profile || !profile.d90 || !profile.d7) { return ""; }
		const v = view || {};
		const key = v.period === "d7" ? "d7" : "d90";
		const p = profile[key];
		const days = key === "d7" ? 7 : 90;
		let html = "<div class='threat90d'><div class='threat90d-head'><span class='threat90d-toggle' role='group' aria-label='Period'>";
		threat90d.PERIODS.forEach(function(per) {
			html += "<button type='button' data-period='" + per.key + "' aria-pressed='" + (per.key === key ? "true" : "false") + "'>" + per.label + "</button>";
		});
		html += "</span> <span class='threat-counts'>" + esc(p.kills + (p.kills === 1 ? " kill" : " kills") + " in " + days + " days") + "</span>";
		if (key === "d90" && profile.level && profile.level !== "none") {
			html += " <span class='threat90d-level threat90d-" + esc(profile.level) + "' title='Kills in 90 days: Critical 50 or more, High 15 or more'>"
				+ esc(threat90d.LEVEL_NAMES[profile.level] || profile.level) + "</span>";
		}
		html += "</div>";
		if (p.kills > 0) {
			html += threat90d.sparkline(p.hours, p.busiest);
			if (p.busiest) {
				const local = threat90d.localLabel(p.busiest, v.offsetMinutes);
				html += "<div class='threat90d-window'>Most active <b>" + esc(threat90d.windowLabel(p.busiest)) + " EVE</b> "
					+ "<span class='threat-muted' title='" + esc(p.busiest.kills + " kills, " + p.busiest.share + "% of the period") + "'>(" + esc(threat90d.timezone(p.busiest)) + " time zone"
					+ (local ? ", " + esc(local) + " your time" : "") + ")</span></div>";
			} else {
				html += "<div class='threat-muted'>Too few kills to name a busiest time.</div>";
			}
			html += threat90d.groupsHtml(p.groups, v.names);
		} else {
			html += "<div class='threat-muted'>No kills seen in this period.</div>";
		}
		const covered = Number(profile.coveredDays) || 0;
		const notes = [];
		if (covered < days) {
			notes.push("kills seen for " + (covered < 1 ? "under a day" : "about " + Math.round(covered) + (Math.round(covered) === 1 ? " day" : " days")) + " so far");
		}
		const analysed = threat90d.analysedText(profile.analysedAt, nowMs);
		if (analysed) { notes.push(analysed); }
		if (notes.length) { html += "<div class='threat-muted threat90d-note'>" + esc(notes.join(" · ")) + "</div>"; }
		return html + "</div>";
	},

	load: function() {
		try {
			const saved = window.localStorage.getItem(threat90d.STORAGE_KEY);
			if (saved === "d7" || saved === "d90") { threat90d.period = saved; }
		} catch (e) { /* storage unavailable: keep the default */ }
	},

	setPeriod: function(key) {
		threat90d.period = key === "d7" ? "d7" : "d90";
		try { window.localStorage.setItem(threat90d.STORAGE_KEY, threat90d.period); } catch (e) { /* not saved */ }
	},

	init: function() {
		threat90d.load();
		$(document).on("click", "#systemThreatInfo .threat90d-toggle button", function(e) {
			e.preventDefault();
			threat90d.setPeriod($(this).attr("data-period"));
			if (typeof systemThreat !== "undefined") { systemThreat.renderInfo(); }
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { threat90d.init(); });
}
