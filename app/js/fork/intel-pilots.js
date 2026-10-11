const intelPilots = {
	// Who is in local (fork-owned, part of "D-scan & local intel"): groups a shared local scan's pilots by alliance and
	// corporation and shows a zKillboard threat badge per pilot. The server looks them up in the background
	// (intel/pilots.inc.php: ESI for corporations / alliances, zKillboard character stats for at most 20 pilots per scan,
	// both through the zKillboard worker); public/intel_scans.php?pilots=<scanID> returns what is known so far. This file
	// is the pure part (grouping, threat levels, markup); app/js/fork/intel-scans.js fetches, polls and renders it.
	// Settings: options.intelScans.affiliation / .threat (missing = on).
	// Keep `const intelPilots` on the first line: the test helper strips it to define a global.
	NPC_MIN: 1000000,
	NPC_MAX: 1999999,
	HIGH_DANGER: 75,	// danger ratio (%) from which a pilot counts as dangerous
	MIN_KILLS: 10,		// kills below which ratios say little
	SOLO_SHARE: 0.3,	// solo kills / kills from which a pilot counts as a solo hunter
	PILOTS_SHOWN: 100,	// pilots listed per expanded group
	ZKILL: "https://zkillboard.com/",

	/** Show corporation / alliance groups; missing = on */
	affiliation: function(opts) {
		return !(opts && opts.intelScans && opts.intelScans.affiliation === false);
	},

	/** Show zKillboard threat badges; missing = on */
	threat: function(opts) {
		return !(opts && opts.intelScans && opts.intelScans.threat === false);
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	isNpcCorp: function(id) {
		return typeof id === "number" && id >= intelPilots.NPC_MIN && id <= intelPilots.NPC_MAX;
	},

	/** Positive integer or null (IDs from the server, used in links) */
	id: function(value) {
		const n = Number(value);
		return Number.isInteger(n) && n > 0 ? n : null;
	},

	/**
	 * Threat summary of a pilot's compact zKillboard stats ({danger, gang, kills, losses, solo, kills7d, lastMonth, ships}).
	 * @param types static type data (public/intel/types.json) to spot cyno-capable hulls among the top ships, or null
	 * @return {level: "none"|"low"|"mid"|"high", danger, solo (solo hunter), cyno, text (badge), title (tooltip lines)}
	 */
	threatLevel: function(t, types) {
		if (!t || typeof t !== "object") { return null; }
		const kills = Number(t.kills) || 0;
		const danger = typeof t.danger === "number" ? t.danger : null;
		const soloKills = Number(t.solo) || 0;
		const solo = kills >= intelPilots.MIN_KILLS && soloKills / kills >= intelPilots.SOLO_SHARE;
		const ships = Array.isArray(t.ships) ? t.ships : [];
		const cyno = !!(types && typeof intelScans !== "undefined" && ships.some(function(s) {
			const info = Array.isArray(s) ? intelScans.typeInfo(s[0], s[1], types) : null;
			return info && info.cyno;
		}));
		let level = "none";
		if (kills > 0) {
			level = danger !== null && danger >= intelPilots.HIGH_DANGER && kills >= intelPilots.MIN_KILLS ? "high"
				: danger !== null && danger >= 50 && kills >= intelPilots.MIN_KILLS ? "mid" : "low";
		}
		const lines = [];
		lines.push(kills ? "Danger " + (danger === null ? "?" : danger) + "%" + (t.gang !== null && t.gang !== undefined ? " · gang " + t.gang + "%" : "") : "No kills on zKillboard");
		if (kills) { lines.push(intelPilots.number(kills) + " kills (" + intelPilots.number(soloKills) + " solo), " + intelPilots.number(Number(t.losses) || 0) + " losses"); }
		if (t.kills7d) { lines.push(t.kills7d + " kills in the last 7 days"); }
		if (t.lastMonth) { lines.push("Last kills: " + t.lastMonth); }
		if (ships.length) { lines.push("Flies: " + ships.map(function(s) { return Array.isArray(s) ? String(s[1] || "?") : "?"; }).join(", ")); }
		if (solo) { lines.push("Solo hunter"); }
		if (cyno) { lines.push("Flies cyno-capable hulls"); }
		const text = level === "none" ? "0" : (level === "high" ? "☠ " : "") + (danger === null ? "?" : danger) + "%" + (solo ? " solo" : "");
		return { level: level, danger: kills ? danger : null, solo: solo, cyno: cyno, text: text, title: lines.join("\n") };
	},

	number: function(n) {
		return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	},

	/**
	 * Group a local scan's pilots.
	 * @param names the scan's character names (paste order)
	 * @param view `pilots` of public/intel_scans.php: {pilots: [[characterID, corporationID, allianceID, threat]], entities: {id: [name, ticker]},
	 *        friendly: {corporations, alliances}, lookups, threat, pending, threatPending}
	 * @return {total, groups: [{key, kind, id, name, ticker, count, friendly, pilots, corps}], friendly (count),
	 *          other: [pilots] (NPC corporations and unknown names), pending: [pilots] (no answer yet, or not looked up)}
	 *          A pilot is {name, id, corporationID, allianceID, threat (compact stats | "q" | "f" | null)}.
	 */
	group: function(names, view) {
		const rows = view && Array.isArray(view.pilots) ? view.pilots : [];
		const entities = view && view.entities && typeof view.entities === "object" ? view.entities : {};
		const friendlyCorps = (view && view.friendly && view.friendly.corporations || []).map(Number);
		const friendlyAlliances = (view && view.friendly && view.friendly.alliances || []).map(Number);
		const entity = function(id) {
			const e = entities[String(id)];
			return Array.isArray(e) ? { name: String(e[0] || ""), ticker: String(e[1] || "") } : { name: "", ticker: "" };
		};
		const out = { total: 0, groups: [], friendly: 0, other: [], pending: [] };
		const byKey = {};
		(Array.isArray(names) ? names : []).forEach(function(name, i) {
			const row = Array.isArray(rows[i]) ? rows[i] : [];
			const pilot = { name: String(name), id: intelPilots.id(row[0]), corporationID: intelPilots.id(row[1]), allianceID: intelPilots.id(row[2]),
				threat: row[3] === undefined ? null : row[3] };
			out.total++;
			if (row[0] === null || row[0] === undefined) {
				out.pending.push(pilot);
				return;
			}
			if (!pilot.id || !pilot.corporationID || intelPilots.isNpcCorp(pilot.corporationID)) { out.other.push(pilot); return; }
			const friendly = friendlyCorps.indexOf(pilot.corporationID) >= 0 || (pilot.allianceID !== null && friendlyAlliances.indexOf(pilot.allianceID) >= 0);
			if (friendly) { out.friendly++; }
			const top = pilot.allianceID ? "a" + pilot.allianceID : "c" + pilot.corporationID;
			let g = byKey[top];
			if (!g) {
				const e = entity(pilot.allianceID || pilot.corporationID);
				g = byKey[top] = { key: top, kind: pilot.allianceID ? "alliance" : "corporation", id: pilot.allianceID || pilot.corporationID,
					name: e.name, ticker: e.ticker, count: 0, friendly: false, pilots: [], corps: [], corpByID: {} };
				out.groups.push(g);
			}
			g.count++;
			g.friendly = g.friendly || friendly;
			g.pilots.push(pilot);
			if (pilot.allianceID) {
				let c = g.corpByID[pilot.corporationID];
				if (!c) {
					const e = entity(pilot.corporationID);
					c = g.corpByID[pilot.corporationID] = { key: top + "c" + pilot.corporationID, kind: "corporation", id: pilot.corporationID,
						name: e.name, ticker: e.ticker, count: 0, friendly: friendly, pilots: [] };
					g.corps.push(c);
				}
				c.count++;
				c.pilots.push(pilot);
			}
		});
		const order = function(a, z) {
			return (a.friendly - z.friendly) || (z.count - a.count) || (a.name.toLowerCase() < z.name.toLowerCase() ? -1 : a.name.toLowerCase() > z.name.toLowerCase() ? 1 : 0) || (a.id - z.id);
		};
		out.groups.forEach(function(g) { delete g.corpByID; g.corps.sort(order); });
		out.groups.sort(order);	// others first (biggest first), friendly groups last
		return out;
	},

	/** Pilots of a list with threat data, most dangerous first: [{pilot, level}] */
	dangerous: function(pilots, types) {
		return pilots.map(function(p) {
			return { pilot: p, level: p.threat && typeof p.threat === "object" ? intelPilots.threatLevel(p.threat, types) : null };
		}).filter(function(x) { return x.level && x.level.level !== "none"; })
			.sort(function(a, z) { return (z.level.danger || 0) - (a.level.danger || 0) || (Number(z.pilot.threat.kills) || 0) - (Number(a.pilot.threat.kills) || 0); });
	},

	/** Threat badge markup of a pilot (escaped); friendly pilots get none */
	badgeHtml: function(pilot, view, types, friendly) {
		const esc = intelPilots.escape;
		if (friendly || !view || !view.threat) { return ""; }
		const t = pilot.threat;
		if (t && typeof t === "object") {
			const level = intelPilots.threatLevel(t, types);
			return "<span class='intel-threat intel-threat-" + level.level + (level.cyno ? " intel-threat-cyno" : "") + "' title='" + esc(level.title) + "'>"
				+ esc(level.text) + (level.cyno ? "<span class='intel-threat-flag'>cyno</span>" : "") + "</span>";
		}
		if (t === "q" || (t === null && view.threatPending)) {
			return "<span class='intel-threat intel-threat-loading' title='Threat loading…'>…</span>";
		}
		if (t === "f") { return "<span class='intel-threat intel-threat-na' title='The zKillboard lookup failed'>?</span>"; }
		if (!pilot.id) { return ""; }
		return "<span class='intel-threat intel-threat-na' title='Not looked up: zKillboard stats are fetched for at most 20 pilots per scan'>–</span>";
	},

	pilotHtml: function(pilot, view, types, friendly, showThreat) {
		const esc = intelPilots.escape;
		const name = pilot.id ? "<a href='" + intelPilots.ZKILL + "character/" + pilot.id + "/' target='_blank' rel='noopener noreferrer'>" + esc(pilot.name) + "</a>" : esc(pilot.name);
		const badge = showThreat ? intelPilots.badgeHtml(pilot, view, types, friendly) : "";
		return "<li>" + name + (badge ? " " + badge : "") + "</li>";
	},

	pilotsListHtml: function(pilots, view, types, friendly, showThreat) {
		const shown = pilots.slice(0, intelPilots.PILOTS_SHOWN);
		return "<ul class='intel-pilot-list'>" + shown.map(function(p) { return intelPilots.pilotHtml(p, view, types, friendly, showThreat); }).join("")
			+ (pilots.length > shown.length ? "<li class='intel-muted'>and " + (pilots.length - shown.length) + " more</li>" : "") + "</ul>";
	},

	/** Summary of a group's threat: badge of its most dangerous pilot plus up to two names, or a loading mark */
	groupThreatHtml: function(group, view, types) {
		const esc = intelPilots.escape;
		if (group.friendly || !view || !view.threat) { return ""; }
		const top = intelPilots.dangerous(group.pilots, types);
		if (top.length) {
			const best = top[0].level;
			const names = top.slice(0, 2).map(function(x) { return x.pilot.name + " " + (x.level.danger === null ? "?" : x.level.danger) + "%"; });
			const title = "Most dangerous: " + top.slice(0, 5).map(function(x) { return x.pilot.name + " " + (x.level.danger === null ? "?" : x.level.danger) + "%" + (x.level.solo ? " (solo)" : ""); }).join(", ");
			return " <span class='intel-threat intel-threat-" + best.level + (best.cyno ? " intel-threat-cyno" : "") + "' title='" + esc(title) + "'>" + esc(best.text) + "</span>"
				+ " <span class='intel-group-top' title='" + esc(title) + "'>" + esc(names.join(", ")) + "</span>";
		}
		const loading = group.pilots.some(function(p) { return p.threat === "q" || (p.threat === null && view.threatPending); });
		return loading ? " <span class='intel-threat intel-threat-loading' title='Threat loading…'>…</span>" : "";
	},

	/** One group row (alliance or corporation) and, when expanded, its corporations or pilots */
	groupHtml: function(group, ctx, nested) {
		const esc = intelPilots.escape;
		const key = ctx.scanID + ":" + group.key;
		const open = !!ctx.expanded[key];
		const label = (group.ticker ? "[" + group.ticker + "] " : "") + (group.name || (group.kind === "alliance" ? "Alliance " : "Corporation ") + group.id);
		let html = "<div class='intel-group" + (nested ? " intel-group-nested" : "") + (group.friendly ? " intel-friendly" : "") + "'>"
			+ "<a href='#' class='intel-group-toggle' data-group='" + esc(key) + "' aria-expanded='" + (open ? "true" : "false") + "'>"
			+ "<span class='intel-caret'>" + (open ? "▾" : "▸") + "</span><span class='intel-group-count'>" + esc(group.count) + "</span> "
			+ "<span class='intel-group-name'>" + esc(label) + "</span></a>"
			+ (group.friendly && !nested ? " <span class='intel-friendly-tag'>friendly</span>" : "")
			// Before the threat summary, which may be cut off at the panel's edge
			+ " <a class='intel-zkill' href='" + intelPilots.ZKILL + (group.kind === "alliance" ? "alliance/" : "corporation/") + esc(group.id) + "/'"
			+ " target='_blank' rel='noopener noreferrer' title='Open on zKillboard'>zKill</a>"
			+ (ctx.showThreat ? intelPilots.groupThreatHtml(group, ctx.view, ctx.types) : "");
		if (open) {
			if (group.corps && group.corps.length > 1) {
				html += "<div class='intel-group-body'>" + group.corps.map(function(c) { return intelPilots.groupHtml(c, ctx, true); }).join("") + "</div>";
			} else {
				html += "<div class='intel-group-body'>" + intelPilots.pilotsListHtml(group.pilots, ctx.view, ctx.types, group.friendly, ctx.showThreat) + "</div>";
			}
		}
		return html + "</div>";
	},

	/** A plain bucket (NPC corp / unknown, still looking up) */
	bucketHtml: function(key, label, pilots, ctx, title) {
		if (!pilots.length) { return ""; }
		const esc = intelPilots.escape;
		const id = ctx.scanID + ":" + key;
		const open = !!ctx.expanded[id];
		return "<div class='intel-group intel-group-" + esc(key) + "'><a href='#' class='intel-group-toggle' data-group='" + esc(id) + "' aria-expanded='" + (open ? "true" : "false") + "'"
			+ (title ? " title='" + esc(title) + "'" : "") + "><span class='intel-caret'>" + (open ? "▾" : "▸") + "</span><span class='intel-group-count'>" + pilots.length + "</span> "
			+ "<span class='intel-group-name'>" + esc(label) + "</span></a>"
			+ (open ? "<div class='intel-group-body'>" + intelPilots.pilotsListHtml(pilots, ctx.view, ctx.types, false, ctx.showThreat && key === "other") + "</div>" : "")
			+ "</div>";
	},

	/**
	 * Body of an open local scan (escaped).
	 * @param ctx {scanID, names, view (or null while loading), types, expanded: {key: true}, affiliation, threat (settings)}
	 */
	html: function(ctx) {
		const esc = intelPilots.escape;
		const view = ctx.view;
		const names = Array.isArray(ctx.names) ? ctx.names : [];
		if (!ctx.affiliation && !ctx.threat) { return ""; }
		if (!view) {
			if (!ctx.affiliation) { return ctx.threat ? "<div class='intel-muted intel-pilots-loading'>Threat loading…</div>" : ""; }
			return "<div class='intel-muted intel-pilots-loading'>Looking up corporations…</div>"
				+ "<div class='intel-names'>" + names.slice(0, 60).map(esc).join(", ") + (names.length > 60 ? " <span class='intel-muted'>and " + (names.length - 60) + " more</span>" : "") + "</div>";
		}
		const g = intelPilots.group(names, view);
		const c = Object.assign({}, ctx, { showThreat: !!ctx.threat && !!view.threat });
		let html = "";
		const status = [];
		if (g.pending.length && view.lookups) { status.push("looking up " + g.pending.length + "…"); }
		if (c.showThreat && view.threatPending) { status.push("threat loading…"); }
		if (view.queueFull) { status.push("lookup queue full, try again later"); }
		if (status.length) { html += "<div class='intel-muted intel-pilots-status'>" + esc(status.join(" · ")) + "</div>"; }
		if (!ctx.affiliation) {
			// Threat only: one list, most dangerous first
			const ranked = intelPilots.dangerous(g.groups.reduce(function(all, x) { return x.friendly ? all : all.concat(x.pilots); }, []).concat(g.other), ctx.types);
			if (!c.showThreat || !ranked.length) { return html; }
			return html + "<div class='intel-sub'>Most dangerous</div>" + intelPilots.pilotsListHtml(ranked.map(function(x) { return x.pilot; }), view, ctx.types, false, true);
		}
		html += g.groups.map(function(x) { return intelPilots.groupHtml(x, c, false); }).join("");
		html += intelPilots.bucketHtml("other", "NPC corp / unknown", g.other, c, "Pilots in NPC corporations and names ESI doesn't know");
		html += view.lookups ? intelPilots.bucketHtml("pending", "Looking up…", g.pending, c)
			: intelPilots.bucketHtml("pending", "Not looked up", g.pending, c, "This server doesn't look pilots up (its zKillboard worker is off)");
		return html;
	}
};
