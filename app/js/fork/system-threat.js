const systemThreat = {
	// System Threat (fork-owned): a kill-activity badge on chain map nodes and a collapsible "Threat & residents" section at
	// the top of the Intel panel (in the system info panel when the Intel panel is off), with residents set by hand and
	// shared with the mask (public/system_residents.php, which looks names up on ESI). Reads public/system_threat.php, which
	// serves zKillboard's per-system stats cached by the pooled zKillboard integration (zkill/stats.php, fetched only by
	// the feed worker) plus the kills the stream keeps; the browser itself only loads logos from images.evetech.net and links to zkillboard.com.
	// Settings: options.systemThreat.enabled (badges), options.systemResidents.enabled (the section); missing = on.
	// Keep `const systemThreat` on the first line: the test helper strips it to define a global.
	URL: "system_threat.php",
	REFRESH_MS: 300000,	// chain badges and the viewed system, while visible
	PENDING_MS: 6000,	// while stats, a back-fill or names are pending
	MAX_PENDING_POLLS: 40,
	DETAIL_DELAY_MS: 1000,	// a system must be viewed this long before the server is asked to queue work for it
	MAX_SYSTEMS: 200,
	RESIDENTS_SHOWN: 6,

	/** Levels by kills per day: [upper bound (exclusive), name]; level = index */
	LEVELS: [
		{ max: 0, name: "None" },
		{ max: 0.5, name: "Low" },	// up to 3 kills a week
		{ max: 2, name: "Moderate" },	// up to 13 a week
		{ max: 6, name: "High" },	// up to 41 a week
		{ max: Infinity, name: "Extreme" }
	],

	enabled: function(opts) {
		return !(opts && opts.systemThreat && opts.systemThreat.enabled === false);
	},

	residentsEnabled: function(opts) {
		return !(opts && opts.systemResidents && opts.systemResidents.enabled === false);
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Threat level (0-4) for a number of kills per day */
	levelForRate: function(perDay) {
		const rate = Number(perDay);
		if (!isFinite(rate) || rate <= 0) { return 0; }
		for (let i = 1; i < systemThreat.LEVELS.length; i++) {
			if (rate < systemThreat.LEVELS[i].max) { return i; }
		}
		return systemThreat.LEVELS.length - 1;
	},

	/**
	 * Estimated kills in the last `days` days from zKillboard's monthly totals: months inside the window count fully,
	 * the month the window starts in counts by the share of it that lies inside (the current month counts as far as
	 * it has gone). null without monthly data.
	 * @param months [{year, month (1-12), kills}]
	 */
	estimateFromMonths: function(months, nowMs, days) {
		if (!Array.isArray(months) || !months.length || !isFinite(nowMs)) { return null; }
		const from = nowMs - days * 86400000;
		let total = 0;
		months.forEach(function(m) {
			const start = Date.UTC(m.year, m.month - 1, 1);
			const end = Math.min(Date.UTC(m.year, m.month, 1), nowMs);
			if (end <= start || end <= from) { return; }
			const share = (end - Math.max(start, from)) / (end - start);
			total += (Number(m.kills) || 0) * share;
		});
		return Math.round(total);
	},

	/** "12", "1.2k", "15k" */
	formatCount: function(n) {
		const v = Number(n) || 0;
		if (v >= 10000) { return Math.round(v / 1000) + "k"; }
		if (v >= 1000) { return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k"; }
		return String(Math.round(v));
	},

	/** "45s", "12m", "3h", "2d" */
	ago: function(timeMs, nowMs) {
		if (!isFinite(timeMs) || !isFinite(nowMs)) { return ""; }
		const s = Math.max(0, Math.floor((nowMs - timeMs) / 1000));
		if (s < 60) { return s + "s"; }
		if (s < 3600) { return Math.floor(s / 60) + "m"; }
		if (s < 86400) { return Math.floor(s / 3600) + "h"; }
		return Math.floor(s / 86400) + "d";
	},

	/** "48 h", "7 days" */
	formatHours: function(seconds) {
		const h = Math.round((Number(seconds) || 0) / 3600);
		return h > 48 && h % 24 === 0 ? (h / 24) + " days" : h + " h";
	},

	/**
	 * What the badge and the info block show for one system.
	 * @param entry systems[id] of a system_threat.php response: {stats, fetchedAt, pending, local: {kills1h, kills24h,
	 *              killsWindow, lastKill}}
	 * @param context {nowMs, retentionSeconds, localSinceMs (since when the stream has every kill, null = never)}
	 * @return {level (0-4, null = unknown), levelName, count, basis ('7 days' / '48 h' ...), source ('zkillboard' /
	 *          'local' / null), kills1h, kills24h, kills24hPartial, kills7d, kills30d, kills90d, hot, pending,
	 *          lastKillMs, fetchedAtMs}
	 */
	summarize: function(entry, context) {
		const e = entry || {};
		const ctx = context || {};
		const now = ctx.nowMs;
		const local = e.local || {};
		const stats = e.stats && typeof e.stats === "object" ? e.stats : null;
		const localSince = ctx.localSinceMs;
		// How far back the stream's store has every kill, within the retention
		const localSpan = localSince === null || localSince === undefined || !isFinite(localSince) ? 0
			: Math.max(0, Math.min((ctx.retentionSeconds || 0) * 1000, now - localSince));
		const out = {
			level: null, levelName: "Unknown", count: null, basis: "", source: null,
			kills1h: localSpan >= 3600000 ? (local.kills1h || 0) : null,
			kills24h: local.kills24h || 0,
			kills24hPartial: localSpan < 86400000,
			kills7d: stats ? (Number(stats.kills7d) || 0) : null,
			kills30d: stats ? systemThreat.estimateFromMonths(stats.months, now, 30) : null,
			kills90d: stats ? systemThreat.estimateFromMonths(stats.months, now, 90) : null,
			hot: (local.kills1h || 0) > 0,
			pending: !!e.pending,
			lastKillMs: local.lastKill ? Date.parse(local.lastKill) : null,
			fetchedAtMs: e.fetchedAt ? Date.parse(e.fetchedAt) : null
		};
		let rate = null;
		if (stats) {
			// zKillboard leaves its 7-day count out when it is 0 or 1, and the stats can be hours old: when the stored
			// kills cover the whole retention window (at most 7 days), they are a lower bound for the 7-day count
			const retentionMs = (ctx.retentionSeconds || 0) * 1000;
			if (retentionMs > 0 && retentionMs <= 7 * 86400000 && localSpan >= retentionMs) {
				out.kills7d = Math.max(out.kills7d, local.killsWindow || 0);
			}
			out.count = out.kills7d;
			out.basis = "7 days";
			out.source = "zkillboard";
			rate = out.kills7d / 7;
			// zKillboard's numbers may be hours old: a busier day since then still raises the level (damped: one gang
			// can kill many ships in a single fight)
			if (!out.kills24hPartial) { rate = Math.max(rate, out.kills24h / 3); }
		} else if (localSpan >= 3600000) {
			out.count = local.killsWindow || 0;
			out.basis = systemThreat.formatHours(localSpan / 1000);
			out.source = "local";
			rate = out.count / (localSpan / 86400000);
		}
		if (rate !== null) {
			out.level = systemThreat.levelForRate(rate);
			out.levelName = systemThreat.LEVELS[out.level].name;
		}
		return out;
	},

	/** Plain-text lines describing a summary (badge tooltip, info block tooltip) */
	describe: function(s, nowMs) {
		if (!s) { return []; }
		const lines = [];
		lines.push("Threat: " + (s.level === null ? (s.pending ? "loading…" : "unknown") : s.levelName)
			+ (s.count !== null ? " (" + s.count + (s.count === 1 ? " kill" : " kills") + " in " + s.basis + ")" : ""));
		const parts = [];
		if (s.kills1h !== null) { parts.push("1h " + s.kills1h); }
		parts.push("24h " + (s.kills24hPartial ? "≥" : "") + s.kills24h);
		if (s.kills7d !== null) { parts.push("7d " + s.kills7d); }
		if (s.kills30d !== null) { parts.push("30d ~" + s.kills30d); }
		if (s.kills90d !== null) { parts.push("90d ~" + s.kills90d); }
		lines.push("Kills: " + parts.join(" · "));
		if (s.kills30d !== null) { lines.push("(30d / 90d estimated from zKillboard's monthly totals)"); }
		if (s.lastKillMs) { lines.push("Last kill " + systemThreat.ago(s.lastKillMs, nowMs) + " ago"); }
		if (s.source === "zkillboard" && s.fetchedAtMs) {
			lines.push("zKillboard stats from " + systemThreat.ago(s.fetchedAtMs, nowMs) + " ago" + (s.pending ? ", updating…" : ""));
		} else if (s.pending) {
			lines.push("Loading zKillboard stats…");
		} else if (s.source === "local") {
			lines.push("From the kills of the last " + s.basis + " (zKillboard stats not available yet)");
		}
		return lines;
	},

	/** Badge markup for a summary ('' when there is nothing to show) */
	badgeHtml: function(s, nowMs) {
		if (!s) { return ""; }
		const title = systemThreat.escape(systemThreat.describe(s, nowMs).join("\n"));
		if (s.level === null) {
			return s.pending ? "<span class='threat-badge threat-pending' title='" + title + "'>…</span>" : "";
		}
		return "<span class='threat-badge threat-" + s.level + (s.hot ? " threat-hot" : "") + "' title='" + title + "'>"
			+ systemThreat.escape(systemThreat.formatCount(s.count)) + "</span>";
	},

	/** Insert badge markup into a chain node's HTML as the node's first child (CSS puts it on the top-left corner) */
	insertBadge: function(nodeHtml, badge) {
		if (!badge || typeof nodeHtml !== "string" || nodeHtml.indexOf("threat-badge") >= 0) { return nodeHtml; }
		const at = nodeHtml.indexOf("<div class='nodeIcons'>");
		if (at < 0) { return nodeHtml; }
		return nodeHtml.substring(0, at) + badge + nodeHtml.substring(at);
	},

	/** Whether a system ID is a real solar system (not a generic destination such as "Unknown") */
	isSystem: function(systemID, systems) {
		const id = parseInt(systemID, 10);
		return id >= 30000000 && id < 33000000 && !!(systems && systems[id]);
	},

	/** Whether a chain row is a synthetic node added by another feature (e.g. route destinations) */
	isSynthetic: function(node) {
		const id = String(node.v);
		const html = typeof node.f === "string" ? node.f : "";
		return id.indexOf("dest-") === 0 || html.indexOf("destination-node") >= 0;
	},

	/** Real solar systems on the chain, from chain.nodes() output, in order, each once */
	chainSystems: function(result, systems) {
		const seen = {};
		const out = [];
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || systemThreat.isSynthetic(node) || !systemThreat.isSystem(node.systemID, systems)) { return; }
			const id = parseInt(node.systemID, 10);
			if (!seen[id]) { seen[id] = true; out.push(id); }
		});
		return out;
	},

	/**
	 * Add badges to chain.nodes() output in place.
	 * @param badgeFor function(systemID) returning badge markup ('' for none)
	 */
	decorate: function(result, systems, badgeFor) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || typeof node.f !== "string" || systemThreat.isSynthetic(node) || !systemThreat.isSystem(node.systemID, systems)) { return; }
			node.f = systemThreat.insertBadge(node.f, badgeFor(parseInt(node.systemID, 10)));
		});
		return result;
	},

	/** Whether an ID is an NPC corporation (EVE gives them 1000000-1999999) */
	isNpcCorporation: function(kind, id) {
		const n = Number(id);
		return kind === "corporation" && n >= 1000000 && n < 2000000;
	},

	/**
	 * Corporations and alliances active in a system, most active first, with a "likely resident" flag.
	 * Sources: zKillboard's 7-day top lists (kills as attackers) and the stored kills of the last hours (final blows
	 * and losses). Likely resident: lost a structure here, or, in a wormhole (where living in a system is the norm and
	 * traffic is low), both killed and lost ships here, or lost 3 or more (ratting / mining losses at home). In k-space
	 * only a structure loss flags anyone: busy gate systems are full of corporations that both kill and die. NPC
	 * corporations are never flagged, and are left out entirely in wormholes.
	 * @param detail `detail` of a system_threat.php response (corporations / alliances: [{id, kills, losses, iskLost,
	 *               lastSeen (unix s)}], structures, names)
	 * @param stats the system's cached zKillboard stats (corporations / alliances: [{id, name, ticker, kills}]) or null
	 * @param wormhole whether the system is a wormhole system
	 * @return {corporations: [...], alliances: [...]}, each [{kind, id, name, ticker, kills7d, kills, losses, iskLost,
	 *         lastSeenMs, structureLost, resident, score}]
	 */
	residents: function(detail, stats, wormhole) {
		const d = detail || {};
		const names = d.names && typeof d.names === "object" ? d.names : {};
		const structureOwners = {};
		(Array.isArray(d.structures) ? d.structures : []).forEach(function(s) {
			if (s.corporationID) { structureOwners["corporation:" + s.corporationID] = true; }
			if (s.allianceID) { structureOwners["alliance:" + s.allianceID] = true; }
		});
		const build = function(kind, local, top) {
			const byID = {};
			const get = function(id) {
				const key = String(id);
				if (!byID[key]) {
					byID[key] = { kind: kind, id: parseInt(id, 10), name: "", ticker: "", kills7d: 0, kills: 0, losses: 0, iskLost: 0, lastSeenMs: null };
				}
				return byID[key];
			};
			(Array.isArray(top) ? top : []).forEach(function(t) {
				if (!t || !(t.id > 0)) { return; }
				const e = get(t.id);
				e.kills7d = Number(t.kills) || 0;
				e.name = t.name || e.name;
				e.ticker = t.ticker || e.ticker;
			});
			(Array.isArray(local) ? local : []).forEach(function(l) {
				if (!l || !(l.id > 0)) { return; }
				const e = get(l.id);
				e.kills = Number(l.kills) || 0;
				e.losses = Number(l.losses) || 0;
				e.iskLost = Number(l.iskLost) || 0;
				e.lastSeenMs = l.lastSeen ? Number(l.lastSeen) * 1000 : null;
			});
			return Object.keys(byID).map(function(k) {
				return byID[k];
			}).filter(function(e) {
				// NPC corporations (starter, militia, Interbus customs offices) never live anywhere; in wormholes they
				// are noise, in k-space (faction warfare militias) they stay listed but are never flagged
				return !(wormhole && systemThreat.isNpcCorporation(kind, e.id));
			}).map(function(e) {
				if (!e.name && Object.prototype.hasOwnProperty.call(names, String(e.id))) { e.name = String(names[String(e.id)]); }
				e.structureLost = !!structureOwners[kind + ":" + e.id];
				e.resident = !systemThreat.isNpcCorporation(kind, e.id)
					&& (e.structureLost || (!!wormhole && ((e.losses > 0 && (e.kills > 0 || e.kills7d > 0)) || e.losses >= 3)));
				e.score = e.kills7d + e.kills + 2 * e.losses + (e.structureLost ? 10 : 0);
				return e;
			}).sort(function(a, b) {
				if (a.resident !== b.resident) { return a.resident ? -1 : 1; }
				if (b.score !== a.score) { return b.score - a.score; }
				return (b.lastSeenMs || 0) - (a.lastSeenMs || 0);
			});
		};
		const s = stats || {};
		return {
			corporations: build("corporation", d.corporations, s.corporations),
			alliances: build("alliance", d.alliances, s.alliances)
		};
	},

	logoURL: function(kind, id) {
		const n = parseInt(id, 10);
		return n > 0 ? "https://images.evetech.net/" + (kind === "alliance" ? "alliances" : "corporations") + "/" + n + "/logo?size=32" : "";
	},

	/** Header of the collapsible section: caret, title, level pill and short count (visible while collapsed), Set residents */
	headHtml: function(model, nowMs, view) {
		const esc = systemThreat.escape;
		const v = view || {};
		let html = "<div class='threat-head' role='button' tabindex='0' aria-expanded='" + (v.collapsed ? "false" : "true") + "'";
		if (model) { html += " title='" + esc(systemThreat.describe(model.summary, nowMs).join("\n")) + "'"; }
		html += "><span class='threat-caret' aria-hidden='true'>" + (v.collapsed ? "&#9656;" : "&#9662;") + "</span>"
			+ "<span class='threat-label'>Threat &amp; residents</span> ";
		const s = model ? model.summary : null;
		if (!s) {
			html += "<span class='threat-muted'>loading…</span>";
		} else if (s.level === null) {
			html += "<span class='threat-muted'>" + (s.pending ? "loading zKillboard stats…" : "unknown") + "</span>";
		} else {
			html += "<span class='threat-level threat-" + s.level + (s.hot ? " threat-hot" : "") + "'>" + esc(s.levelName) + "</span> "
				+ "<span class='threat-counts'>" + esc(s.count) + " in " + esc(s.basis) + "</span>";
		}
		if (v.canSet) {
			html += "<button type='button' class='threat-set-residents' title='Set who lives in this system (shared with your mask)'>"
				+ (v.residents && v.residents.entities && v.residents.entities.length ? "Edit residents" : "Set residents") + "</button>";
		}
		return html + "</div>";
	},

	/** Auto-detected activity: corporations active here, alliances, structures lost (from kills) */
	activityHtml: function(model, nowMs) {
		const esc = systemThreat.escape;
		if (!model) { return ""; }
		const s = model.summary;
		let html = "";
		const r = model.residents;
		if (r) {
			const corps = r.corporations.slice(0, systemThreat.RESIDENTS_SHOWN);
			const ellipsis = model.namesPending ? "…" : "Unknown";
			if (corps.length) {
				html += "<div class='threat-sub' title='Kills: last 7 days (zKillboard) plus final blows of the last "
					+ esc(model.windowText) + ". Lost: ships and structures lost in the last " + esc(model.windowText) + ".'>Active here</div><ul class='threat-residents'>";
				corps.forEach(function(e) {
					const kills = Math.max(e.kills7d, e.kills);
					const stats = [];
					if (kills) { stats.push(kills + (kills === 1 ? " kill" : " kills")); }
					if (e.losses) { stats.push(e.losses + " lost"); }
					html += "<li" + (e.resident ? " class='threat-resident'" : "") + ">"
						+ "<a href='https://zkillboard.com/corporation/" + e.id + "/' target='_blank' rel='noopener noreferrer'>"
						+ "<img src='" + esc(systemThreat.logoURL("corporation", e.id)) + "' alt='' loading='lazy' />"
						+ "<span class='threat-name'>" + esc(e.name || ellipsis) + "</span>"
						+ (e.ticker ? " <span class='threat-ticker'>[" + esc(e.ticker) + "]</span>" : "") + "</a>"
						+ " <span class='threat-stats'>" + esc(stats.join(" · ")) + "</span>"
						+ (e.resident ? " <span class='threat-tag' title='" + esc(e.structureLost ? "Lost a structure here"
							: e.kills7d || e.kills ? "Both killed and lost ships here" : "Lost several ships here") + "'>"
							+ (e.structureLost ? "structure lost" : "likely resident") + "</span>" : "")
						+ "</li>";
				});
				html += "</ul>";
			} else if (s.level !== null) {
				html += "<div class='threat-muted'>No corporations seen here recently.</div>";
			}
			const alliances = r.alliances.slice(0, 4);
			if (alliances.length) {
				html += "<div class='threat-alliances'>Alliances: " + alliances.map(function(e) {
					return "<a href='https://zkillboard.com/alliance/" + e.id + "/' target='_blank' rel='noopener noreferrer'"
						+ (e.resident ? " class='threat-resident'" : "") + ">" + esc(e.ticker || e.name || ellipsis) + "</a>";
				}).join(", ") + "</div>";
			}
		}
		if (model.structures && model.structures.length) {
			html += "<div class='threat-structures'>Structures lost (" + esc(model.windowText) + "): " + model.structures.map(function(st) {
				return "<a href='https://zkillboard.com/kill/" + st.killID + "/' target='_blank' rel='noopener noreferrer'>"
					+ esc(st.typeName || "Structure") + "</a>" + (st.ownerName ? " (" + esc(st.ownerName) + ")" : "")
					+ " " + esc(systemThreat.ago(st.timeMs, nowMs)) + " ago";
			}).join(", ") + "</div>";
		}
		return html;
	},

	/**
	 * Residents set by hand (shared with the mask), shown instead of the auto-detected list.
	 * @param set {entities: [{kind, id, name, ticker}], note, setBy, setAt (unix s)}
	 */
	setResidentsHtml: function(set, nowMs) {
		const esc = systemThreat.escape;
		if (!set || !Array.isArray(set.entities) || !set.entities.length) { return ""; }
		let html = "<div class='threat-sub'>Residents</div><ul class='threat-residents threat-residents-set'>";
		set.entities.forEach(function(e) {
			const id = parseInt(e.id, 10);
			if (!(id > 0)) { return; }
			const kind = e.kind === "alliance" ? "alliance" : "corporation";
			html += "<li><a href='https://zkillboard.com/" + kind + "/" + id + "/' target='_blank' rel='noopener noreferrer'>"
				+ "<img src='" + esc(systemThreat.logoURL(kind, id)) + "' alt='' loading='lazy' />"
				+ "<span class='threat-name'>" + esc(e.name || "Unknown") + "</span>"
				+ (e.ticker ? " <span class='threat-ticker'>[" + esc(e.ticker) + "]</span>" : "") + "</a>"
				+ (kind === "alliance" ? " <span class='threat-stats'>alliance</span>" : "") + "</li>";
		});
		html += "</ul>";
		if (set.note) { html += "<div class='threat-note'>" + esc(set.note) + "</div>"; }
		const when = set.setAt ? systemThreat.ago(Number(set.setAt) * 1000, nowMs) : "";
		if (set.setBy || when) {
			html += "<div class='threat-muted threat-setby'>set" + (set.setBy ? " by " + esc(set.setBy) : "") + (when ? ", " + esc(when) + " ago" : "") + "</div>";
		}
		return html;
	},

	/**
	 * The whole section (header + body unless collapsed).
	 * @param view {collapsed, canSet, residents (set by hand, or null), showActivity, error}
	 */
	sectionHtml: function(model, nowMs, view) {
		const esc = systemThreat.escape;
		const v = view || {};
		const html = systemThreat.headHtml(model, nowMs, v);
		if (v.collapsed) { return html; }
		let body = "";
		const error = v.error || (model && model.error);
		if (error) { body += "<div class='threat-muted'>" + esc(error) + "</div>"; }
		const s = model ? model.summary : null;
		if (s && s.kills90d !== null) { body += "<div class='threat-muted'>~" + esc(systemThreat.formatCount(s.kills90d)) + " kills in 90 days</div>"; }
		const set = systemThreat.setResidentsHtml(v.residents, nowMs);
		if (set) {
			body += set + "<a href='#' class='threat-show-activity' aria-expanded='" + (v.showActivity ? "true" : "false") + "'>"
				+ (v.showActivity ? "hide activity" : "show activity") + "</a>";
			if (v.showActivity) { body += "<div class='threat-activity'>" + systemThreat.activityHtml(model, nowMs) + "</div>"; }
		} else {
			body += systemThreat.activityHtml(model, nowMs);
		}
		return html + (body ? "<div class='threat-body'>" + body + "</div>" : "");
	},

	/** HTML of the block, expanded, without the Set residents button */
	infoHtml: function(model, nowMs) {
		return systemThreat.sectionHtml(model, nowMs, {});
	},

	/**
	 * Quick picks for the Set residents dialog: what is set plus the corporations and alliances listed as active here,
	 * each once. Ticked: what is set; when nothing is set, the likely residents.
	 * @return [{kind, id, name, ticker, checked, resident}]
	 */
	quickPicks: function(model, set) {
		const out = [];
		const seen = {};
		const stored = set && Array.isArray(set.entities) && set.entities.length ? set.entities : null;
		const isSet = {};
		(stored || []).forEach(function(e) { isSet[(e.kind === "alliance" ? "alliance" : "corporation") + ":" + parseInt(e.id, 10)] = true; });
		const add = function(e, kind) {
			const id = parseInt(e.id, 10);
			const key = kind + ":" + id;
			if (!(id > 0) || seen[key]) { return; }
			seen[key] = true;
			out.push({ kind: kind, id: id, name: e.name || "", ticker: e.ticker || "", resident: !!e.resident,
				checked: stored ? !!isSet[key] : !!e.resident });
		};
		(stored || []).forEach(function(e) { add(e, e.kind === "alliance" ? "alliance" : "corporation"); });
		const r = model && model.residents ? model.residents : null;
		if (r) {
			r.corporations.slice(0, systemThreat.RESIDENTS_SHOWN).forEach(function(e) { add(e, "corporation"); });
			r.alliances.slice(0, 4).forEach(function(e) { add(e, "alliance"); });
		}
		return out;
	},

	/** Free-entry names typed in the dialog (comma or new line separated), trimmed, each once */
	parseNames: function(text) {
		const seen = {};
		return String(text || "").split(/[,\n]/).map(function(n) { return n.replace(/\s+/g, " ").trim(); }).filter(function(n) {
			const k = n.toLowerCase();
			if (!n || seen[k]) { return false; }
			seen[k] = true;
			return true;
		});
	},

	/** Body of the Set residents dialog */
	dialogHtml: function(picks, set) {
		const esc = systemThreat.escape;
		let html = "<p class='threat-dialog-help'>Who lives in this system? Shown to everyone on your mask instead of the corporations detected from kills.</p>";
		if (picks.length) {
			html += "<div class='threat-dialog-picks'>" + picks.map(function(p) {
				return "<label><input type='checkbox' class='threat-pick' data-kind='" + esc(p.kind) + "' data-id='" + esc(p.id) + "'" + (p.checked ? " checked" : "") + " /> "
					+ "<img src='" + esc(systemThreat.logoURL(p.kind, p.id)) + "' alt='' loading='lazy' />"
					+ esc(p.name || (p.kind + " " + p.id)) + (p.ticker ? " <span class='threat-ticker'>[" + esc(p.ticker) + "]</span>" : "")
					+ (p.kind === "alliance" ? " <span class='threat-muted'>alliance</span>" : "")
					+ (p.resident ? " <span class='threat-muted'>· likely resident</span>" : "") + "</label>";
			}).join("") + "</div>";
		} else {
			html += "<p class='threat-muted'>No corporations seen here recently.</p>";
		}
		html += "<label class='threat-dialog-field'>Add by exact name<input type='text' class='threat-names' maxlength='300' autocomplete='off' spellcheck='false' placeholder='Corporation or alliance (separate several with commas)' /></label>"
			+ "<div class='threat-dialog-error'></div>"
			+ "<label class='threat-dialog-field'>Note<input type='text' class='threat-note-input' maxlength='200' autocomplete='off' placeholder='e.g. Lowsec static, active EU TZ' value='"
			+ esc(set && set.note ? set.note : "") + "' /></label>";
		return html;
	},

	/** Whether people live in a system of this kind: C1-C6 wormholes and shattered C13s (not Thera or drifter holes) */
	isLivedIn: function(systemID, systems) {
		const id = parseInt(systemID, 10);
		const sys = systems ? systems[id] : null;
		return id >= 31000000 && id < 32000000 && !!sys && [1, 2, 3, 4, 5, 6, 13].indexOf(parseInt(sys.class, 10)) >= 0;
	},

	/** Model for infoHtml from a system_threat.php response with `detail`; systems = tripwire.systems */
	infoModel: function(response, nowMs, systems) {
		if (!response || !response.detail) { return null; }
		const detail = response.detail;
		const entry = response.systems ? response.systems[String(detail.systemID)] : null;
		const summary = systemThreat.summarize(entry, {
			nowMs: nowMs, retentionSeconds: response.retentionSeconds,
			localSinceMs: response.localSince ? Date.parse(response.localSince) : null
		});
		const names = detail.names || {};
		const name = function(id) { return id && Object.prototype.hasOwnProperty.call(names, String(id)) ? String(names[String(id)]) : ""; };
		return {
			summary: summary,
			residents: systemThreat.residents(detail, entry ? entry.stats : null, systemThreat.isLivedIn(detail.systemID, systems)),
			structures: (detail.structures || []).map(function(st) {
				return { killID: parseInt(st.killID, 10), typeName: name(st.typeID), ownerName: name(st.corporationID), timeMs: Date.parse(st.time) };
			}),
			namesPending: !!detail.namesPending,
			windowText: systemThreat.formatHours(response.retentionSeconds)
		};
	},

	// ---- Browser ----

	cache: {},	// systemID => {entry, at (ms)}
	context: { retentionSeconds: 0, localSinceMs: null },
	chainIDs: [],

	summaryFor: function(systemID, nowMs) {
		const c = systemThreat.cache[systemID];
		if (!c) { return null; }
		return systemThreat.summarize(c.entry, { nowMs: nowMs, retentionSeconds: systemThreat.context.retentionSeconds, localSinceMs: systemThreat.context.localSinceMs });
	},

	badgeFor: function(systemID) {
		const now = Date.now();
		return systemThreat.badgeHtml(systemThreat.summaryFor(systemID, now), now);
	},

	/** Remember a response's systems and context */
	absorb: function(response) {
		if (!response || !response.systems) { return; }
		const now = Date.now();
		systemThreat.context = {
			retentionSeconds: response.retentionSeconds || 0,
			localSinceMs: response.localSince ? Date.parse(response.localSince) : null
		};
		Object.keys(response.systems).forEach(function(id) {
			systemThreat.cache[id] = { entry: response.systems[id], at: now };
		});
	},

	/** Replace the badges of the drawn chain map with the cached data (no redraw needed) */
	patchChain: function() {
		const on = systemThreat.enabled(typeof options !== "undefined" ? options : null);
		$("#chainMap .node[data-nodeid]").each(function() {
			const $node = $(this);
			$node.children(".threat-badge").remove();
			if (!on || $node.closest(".destination-node").length) { return; }
			const id = parseInt($node.attr("data-nodeid"), 10);
			const badge = systemThreat.badgeFor(id);
			if (badge) { $node.prepend(badge); }
		});
	},

	/** Called with every chain build: remember the chain's systems and fetch those without fresh data */
	chainChanged: function(ids) {
		systemThreat.chainIDs = ids.slice(0, systemThreat.MAX_SYSTEMS);
		const now = Date.now();
		const stale = systemThreat.chainIDs.some(function(id) {
			const c = systemThreat.cache[id];
			return !c || now - c.at > systemThreat.REFRESH_MS;
		});
		if (stale) {
			clearTimeout(systemThreat.chainDebounce);
			systemThreat.chainDebounce = setTimeout(function() { systemThreat.fetchChain(true); }, 300);
		}
	},

	fetchChain: function(queue) {
		if (!systemThreat.enabled(options) || !systemThreat.chainIDs.length) { return; }
		if (document.hidden) { systemThreat.missed = true; return; }
		if (systemThreat.chainXhr) { systemThreat.chainXhr.abort(); }
		const ids = systemThreat.chainIDs.slice();
		const xhr = $.ajax({ url: systemThreat.URL, type: "GET", data: { systems: ids.join(","), queue: queue ? 1 : 0 },
			dataType: "JSON", cache: false, timeout: 15000 });
		systemThreat.chainXhr = xhr;
		xhr.done(function(response) {
			systemThreat.absorb(response);
			systemThreat.patchChain();
			systemThreat.chainPolls = response && response.pending ? (systemThreat.chainPolls || 0) + 1 : 0;
			clearTimeout(systemThreat.chainTimer);
			systemThreat.chainTimer = setTimeout(function() { systemThreat.fetchChain(!systemThreat.chainPolls); },
				systemThreat.chainPolls && systemThreat.chainPolls <= systemThreat.MAX_PENDING_POLLS ? systemThreat.PENDING_MS : systemThreat.REFRESH_MS);
		}).fail(function(x, status) {
			if (status === "abort") { return; }
			clearTimeout(systemThreat.chainTimer);
			systemThreat.chainTimer = setTimeout(function() { systemThreat.fetchChain(true); }, systemThreat.REFRESH_MS / 3);
		}).always(function() {
			if (systemThreat.chainXhr === xhr) { systemThreat.chainXhr = null; }
		});
	},

	install: function(chainObj) {
		if (!chainObj || typeof chainObj.nodes !== "function" || chainObj.nodes.systemThreatWrapped) { return; }
		const previous = chainObj.nodes;
		const wrapped = function() {
			const result = previous.apply(this, arguments);
			try {
				if (systemThreat.enabled(typeof options !== "undefined" ? options : null)) {
					const systems = typeof tripwire !== "undefined" ? tripwire.systems : null;
					systemThreat.decorate(result, systems, systemThreat.badgeFor);
					systemThreat.chainChanged(systemThreat.chainSystems(result, systems));
				}
			} catch (e) {
				if (typeof console !== "undefined") { console.warn("system-threat: could not decorate the chain", e); }
			}
			return result;
		};
		wrapped.systemThreatWrapped = true;
		chainObj.nodes = wrapped;
	},

	// ---- Threat & residents section: in the Intel panel, or in the system info panel when that is off ----

	RESIDENTS_URL: "system_residents.php",
	RESIDENTS_REFRESH_MS: 60000,	// other mask members' changes, with the detail polls
	COLLAPSED_KEY: "tripwire.threatResidents.collapsed",
	DIALOG_ID: "dialog-systemResidents",

	$info: function() { return $("#systemThreatInfo"); },

	/** Where the section goes: [element to insert before, 'intel' / 'info'], or null when neither panel is there */
	host: function() {
		const $intel = $("#intelScansWidget .content > .intel-body");
		if ($intel.length) { return [$intel.first(), "intel"]; }
		// Above the activity graph, so the threat line is visible without scrolling the panel
		const $graph = $("#infoWidget #activityGraph");
		return $graph.length ? [$graph.first(), "info"] : null;
	},

	/** Create the section or move it to its host (the Intel panel can be turned on and off at runtime). False when there is no host. */
	place: function() {
		const host = systemThreat.host();
		let $info = systemThreat.$info();
		if (!host) { $info.remove(); return false; }
		if (!$info.length) {
			$info = $("<div id='systemThreatInfo' class='threat-info'></div>");
			systemThreat.detailID = null;
		}
		if ($info.next()[0] !== host[0][0]) { host[0].before($info.detach()); }
		$info.toggleClass("threat-in-intel", host[1] === "intel").toggleClass("threat-in-info", host[1] === "info");
		return true;
	},

	collapsed: function() {
		try { return window.localStorage.getItem(systemThreat.COLLAPSED_KEY) === "1"; } catch (e) { return false; }
	},

	setCollapsed: function(on) {
		try {
			if (on) { window.localStorage.setItem(systemThreat.COLLAPSED_KEY, "1"); } else { window.localStorage.removeItem(systemThreat.COLLAPSED_KEY); }
		} catch (e) { /* private mode: not remembered */ }
	},

	syncInfo: function() {
		const on = systemThreat.residentsEnabled(typeof options !== "undefined" ? options : null);
		if (!on) {
			systemThreat.stopDetail();
			systemThreat.$info().remove();
			systemThreat.detailID = null;
			return;
		}
		const had = systemThreat.$info().length;
		if (!systemThreat.place()) { systemThreat.stopDetail(); systemThreat.detailID = null; return; }
		if (had && systemThreat.detailID) { systemThreat.renderInfo(); return; }	// only moved: keep the data and the polling
		systemThreat.loadDetail(typeof viewingSystemID !== "undefined" ? viewingSystemID : null);
	},

	stopDetail: function() {
		clearTimeout(systemThreat.detailTimer);
		clearTimeout(systemThreat.detailQueueTimer);
		if (systemThreat.detailXhr) { systemThreat.detailXhr.abort(); systemThreat.detailXhr = null; }
		if (systemThreat.residentsXhr) { systemThreat.residentsXhr.abort(); systemThreat.residentsXhr = null; }
	},

	loadDetail: function(systemID) {
		const id = parseInt(systemID, 10);
		if (!systemThreat.$info().length || !systemThreat.isSystem(id, typeof tripwire !== "undefined" ? tripwire.systems : null)) {
			systemThreat.detailID = null;
			systemThreat.$info().empty();
			return;
		}
		if (id !== systemThreat.detailID) {
			systemThreat.detailID = id;
			systemThreat.detailResponse = null;
			systemThreat.detailError = "";
			systemThreat.residentsSet = null;
			systemThreat.residentsAt = 0;
			systemThreat.showActivity = false;
			systemThreat.renderInfo();
		}
		systemThreat.detailPolls = 0;
		systemThreat.stopDetail();
		systemThreat.fetchResidents();
		// What the server has right away; queue work only once the system has been viewed a moment
		systemThreat.fetchDetail(false);
		systemThreat.detailQueueTimer = setTimeout(function() {
			if (systemThreat.detailID === id) { systemThreat.fetchDetail(true); }
		}, systemThreat.DETAIL_DELAY_MS);
	},

	fetchDetail: function(queue) {
		const id = systemThreat.detailID;
		if (!id || !systemThreat.$info().length) { return; }
		if (document.hidden) { systemThreat.missed = true; return; }
		if (systemThreat.detailXhr) { systemThreat.detailXhr.abort(); }
		// Residents set by other mask members: with the detail polls, at most once a minute
		if (queue && Date.now() - (systemThreat.residentsAt || 0) >= systemThreat.RESIDENTS_REFRESH_MS) { systemThreat.fetchResidents(); }
		const xhr = $.ajax({ url: systemThreat.URL, type: "GET", data: { systemID: id, queue: queue ? 1 : 0 },
			dataType: "JSON", cache: false, timeout: 15000 });
		systemThreat.detailXhr = xhr;
		xhr.done(function(response) {
			if (id !== systemThreat.detailID) { return; }
			systemThreat.detailResponse = response;
			systemThreat.detailError = "";
			systemThreat.absorb(response);
			if (systemThreat.chainIDs.indexOf(id) >= 0) { systemThreat.patchChain(); }
			if (!queue) { return; }	// the queueing request follows
			systemThreat.detailPolls = response && response.pending ? systemThreat.detailPolls + 1 : 0;
			clearTimeout(systemThreat.detailTimer);
			systemThreat.detailTimer = setTimeout(function() { systemThreat.fetchDetail(true); },
				systemThreat.detailPolls && systemThreat.detailPolls <= systemThreat.MAX_PENDING_POLLS ? systemThreat.PENDING_MS : systemThreat.REFRESH_MS);
		}).fail(function(x, status) {
			if (status === "abort" || id !== systemThreat.detailID) { return; }
			systemThreat.detailError = "Could not load threat data" + (x && x.status ? " (HTTP " + x.status + ")" : "");
			clearTimeout(systemThreat.detailTimer);
			systemThreat.detailTimer = setTimeout(function() { systemThreat.fetchDetail(true); }, systemThreat.REFRESH_MS / 3);
		}).always(function() {
			if (systemThreat.detailXhr === xhr) { systemThreat.detailXhr = null; }
			if (id === systemThreat.detailID) { systemThreat.renderInfo(); }
		});
	},

	fetchResidents: function() {
		const id = systemThreat.detailID;
		if (!id) { return; }
		if (systemThreat.residentsXhr) { systemThreat.residentsXhr.abort(); }
		systemThreat.residentsAt = Date.now();
		const xhr = $.ajax({ url: systemThreat.RESIDENTS_URL, type: "GET", data: { systemID: id }, dataType: "JSON", cache: false, timeout: 15000 });
		systemThreat.residentsXhr = xhr;
		xhr.done(function(response) {
			if (id !== systemThreat.detailID) { return; }
			systemThreat.residentsSet = response && response.residents ? response.residents : null;
			systemThreat.renderInfo();
		}).always(function() {
			if (systemThreat.residentsXhr === xhr) { systemThreat.residentsXhr = null; }
		});
	},

	currentModel: function(nowMs) {
		const model = systemThreat.infoModel(systemThreat.detailResponse, nowMs, typeof tripwire !== "undefined" ? tripwire.systems : null);
		if (model) { model.error = systemThreat.detailError; }
		return model;
	},

	renderInfo: function() {
		if (!systemThreat.$info().length || !systemThreat.place()) { return; }
		const $info = systemThreat.$info();
		if (!systemThreat.detailID) { $info.empty(); return; }
		const now = Date.now();
		$info.html(systemThreat.sectionHtml(systemThreat.currentModel(now), now, {
			collapsed: systemThreat.collapsed(), canSet: true, residents: systemThreat.residentsSet,
			showActivity: systemThreat.showActivity, error: systemThreat.detailError
		}));
	},

	bindInfo: function() {
		$(document).on("click", "#systemThreatInfo .threat-head", function(e) {
			if ($(e.target).closest("button, a").length) { return; }
			systemThreat.setCollapsed(!systemThreat.collapsed());
			systemThreat.renderInfo();
		}).on("keydown", "#systemThreatInfo .threat-head", function(e) {
			if ((e.key === "Enter" || e.key === " ") && e.target === this) {
				e.preventDefault();
				systemThreat.setCollapsed(!systemThreat.collapsed());
				systemThreat.renderInfo();
				systemThreat.$info().find(".threat-head").trigger("focus");
			}
		}).on("click", "#systemThreatInfo .threat-set-residents", function(e) {
			e.preventDefault();
			e.stopPropagation();
			systemThreat.openResidentsDialog();
		}).on("click", "#systemThreatInfo .threat-show-activity", function(e) {
			e.preventDefault();
			systemThreat.showActivity = !systemThreat.showActivity;
			systemThreat.renderInfo();
		});
	},

	// ---- Set residents dialog ----

	openResidentsDialog: function() {
		const id = systemThreat.detailID;
		if (!id) { return; }
		let $dialog = $("#" + systemThreat.DIALOG_ID);
		if (!$dialog.length) {
			$dialog = $("<div id='" + systemThreat.DIALOG_ID + "' class='threat-dialog'></div>").appendTo("body");
			$dialog.dialog({
				autoOpen: false,
				resizable: false,
				modal: true,
				width: 420,
				dialogClass: "dialog-noeffect ui-dialog-shadow dialog-systemResidents",
				buttons: [
					{ text: "Save", "class": "threat-save", click: function() { systemThreat.saveResidents("set"); } },
					{ text: "Clear residents", "class": "threat-clear", click: function() { systemThreat.saveResidents("clear"); } },
					{ text: "Cancel", click: function() { $(this).dialog("close"); } }
				]
			});
			$dialog.on("keydown", "input[type=text]", function(e) {
				if (e.key === "Enter") { e.preventDefault(); systemThreat.saveResidents("set"); }
			});
		}
		const set = systemThreat.residentsSet;
		systemThreat.dialogSystemID = id;
		$dialog.html(systemThreat.dialogHtml(systemThreat.quickPicks(systemThreat.currentModel(Date.now()), set), set));
		const name = typeof tripwire !== "undefined" && tripwire.systems && tripwire.systems[id] ? tripwire.systems[id].name : String(id);
		$dialog.dialog("option", "title", "Residents: " + name);
		$dialog.parent().find(".threat-clear").toggle(!!(set && set.entities && set.entities.length));
		$dialog.parent().find(".threat-save, .threat-clear").prop("disabled", false).removeClass("ui-state-disabled");
		$dialog.dialog("open");
	},

	saveResidents: function(mode) {
		const $dialog = $("#" + systemThreat.DIALOG_ID);
		const id = systemThreat.dialogSystemID;
		if (!$dialog.length || !id) { return; }
		const $error = $dialog.find(".threat-dialog-error").text("");
		const data = { mode: mode, systemID: id };
		if (mode === "set") {
			const picks = $dialog.find(".threat-pick:checked").map(function() {
				return { kind: $(this).attr("data-kind"), id: parseInt($(this).attr("data-id"), 10) };
			}).get();
			const names = systemThreat.parseNames($dialog.find(".threat-names").val());
			if (!picks.length && !names.length) { $error.text("Tick or enter at least one corporation or alliance (or use Clear residents)."); return; }
			data.entities = JSON.stringify(picks);
			data.names = JSON.stringify(names);
			data.note = String($dialog.find(".threat-note-input").val() || "").slice(0, 200);
		}
		const $buttons = $dialog.parent().find(".threat-save, .threat-clear").prop("disabled", true).addClass("ui-state-disabled");
		$.ajax({ url: systemThreat.RESIDENTS_URL, type: "POST", data: data, dataType: "JSON", timeout: 30000,
			headers: { "X-Requested-With": "XMLHttpRequest" } }).done(function(response) {
			if (id === systemThreat.detailID) {
				systemThreat.residentsSet = response && response.residents ? response.residents : null;
				systemThreat.residentsAt = Date.now();
				systemThreat.showActivity = false;
				systemThreat.renderInfo();
			}
			$dialog.dialog("close");
		}).fail(function(x) {
			$error.text(x && x.responseJSON && x.responseJSON.error ? x.responseJSON.error
				: "Could not save the residents" + (x && x.status ? " (HTTP " + x.status + ")" : ""));
		}).always(function() {
			$buttons.prop("disabled", false).removeClass("ui-state-disabled");
		});
	},

	// ---- Settings ----

	setupSettings: function() {
		// Settings > Map Markers (badges) and Kills & Intel (the section); take effect on Save like their neighbours (Reset = on)
		forkSettings.register({
			section: "markers", order: 40, id: "systemThreat-enabled", type: "checkbox", key: "systemThreat",
			label: "Threat badges:", text: "Show recent kill activity on nodes",
			get: function(o) { return systemThreat.enabled(o); },
			set: function(o, on) { o.systemThreat = { enabled: on }; }
		});
		forkSettings.register({
			section: "intel", order: 30, id: "systemResidents-enabled", type: "checkbox", key: "systemResidents",
			label: "System threat & residents:", text: "Show threat and residents in the Intel panel (or the system info panel)",
			get: function(o) { return systemThreat.residentsEnabled(o); },
			set: function(o, on) { o.systemResidents = { enabled: on }; }
		});
		// options.apply() runs on Save and Reset (chain.redraw() follows there and re-decorates the nodes)
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.systemThreatWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				systemThreat.syncInfo();
				systemThreat.patchChain();
				if (systemThreat.enabled(options)) { systemThreat.fetchChain(true); }
				return result;
			};
			options.apply.systemThreatWrapped = true;
		}
	},

	init: function() {
		systemThreat.setupSettings();
		systemThreat.bindInfo();
		if (typeof tripwire !== "undefined" && typeof tripwire.systemChange === "function" && !tripwire.systemChange.systemThreatWrapped) {
			const systemChange = tripwire.systemChange;
			tripwire.systemChange = function(systemID) {
				const result = systemChange.apply(this, arguments);
				if (systemThreat.$info().length) { systemThreat.loadDetail(systemID); }
				return result;
			};
			tripwire.systemChange.systemThreatWrapped = true;
		}
		document.addEventListener("visibilitychange", function() {
			if (!document.hidden && systemThreat.missed) {
				systemThreat.missed = false;
				systemThreat.fetchChain(true);
				systemThreat.fetchDetail(true);
			}
		});
		systemThreat.syncInfo();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	if (typeof chain !== "undefined") { systemThreat.install(chain); }
	$(function() {
		if (typeof chain !== "undefined") { systemThreat.install(chain); }
		systemThreat.init();
	});
}
