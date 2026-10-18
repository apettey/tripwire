const structures = {
	// Structures (fork-owned): a small, icon-heavy panel (its own layout widget, like the Intel panel) listing the
	// structures of the viewed system, one ~22 px line each: type icon, owner ticker, state icon, timer, "seen" age;
	// names, owners and notes are in the tooltip. Its header has a residents strip: one chip per structure owner (ours /
	// hostile / unresolved, count), plus the corporations System Threat saw in kills here (outlined). Structures are
	// saved from the d-scan dialog (a section is added to its preview, see wrapDialog) or added by hand. Server:
	// public/structures.php (structures/structures.inc.php; the parse and merge here mirror it for the preview, shared
	// fixtures structures/tests/fixtures.json). Static type data: public/intel/types.json (loaded by intelScans).
	// Settings: options.structures = {enabled (missing = on), position}. Spec: reports/Structures and timers spec.md.
	// Keep `const structures` on the first line: the test helper strips it to define a global.
	URL: "structures.php",
	POLL_MS: 60000,
	WIDGET_ID: "structuresWidget",
	SIZE: { x: 4, y: 3, minX: 3, minY: 2 },
	TIMER_PAST_S: 7200,		// an ended timer shows as "elapsed" for 2 hours, then "ended"
	TIMER_FUTURE_S: 2592000,	// at most 30 days ahead
	STALE_S: 2592000,
	OLD_S: 604800,
	TOWER_GROUP: 365,

	STATES: {
		unknown: ["Unknown state", "unknown"], online: ["Online", "online"], low_power: ["Low power", "low_power"],
		abandoned: ["Abandoned", "abandoned"], anchoring: ["Anchoring", "anchoring"], unanchoring: ["Unanchoring", "unanchoring"],
		reinforced: ["Reinforced", "reinforced"], offline: ["Offline", "offline"]
	},
	TIMER_KINDS: {
		armor: "Armor timer", hull: "Hull timer (final)", pos: "POS reinforced", anchoring: "Anchoring ends",
		unanchoring: "Unanchoring ends", fuel: "Fuel runs out", other: "Other timer"
	},
	TIMER_STATE: { armor: "reinforced", hull: "reinforced", pos: "reinforced", anchoring: "anchoring", unanchoring: "unanchoring" },

	enabled: function(opts) {
		return !(opts && opts.structures && opts.structures.enabled === false);
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	// ---- Classify, parse, merge (mirrors structures/structures.inc.php) ----

	/** {typeID, typeName, kind: upwell|starbase|deployable, tower} for a structure type, else null */
	classify: function(typeID, typeName, types) {
		if (!types || !types.types) { return null; }
		let id = null;
		let t = null;
		if (typeID !== null && typeID !== undefined && types.types[String(typeID)]) {
			t = types.types[String(typeID)];
			id = parseInt(typeID, 10);
		} else if (typeName) {
			const want = String(typeName).toLowerCase();
			Object.keys(types.types).some(function(k) {
				if (String(types.types[k][0]).toLowerCase() === want) { t = types.types[k]; id = parseInt(k, 10); return true; }
				return false;
			});
		}
		const g = t ? types.groups[String(t[1])] : null;
		const kind = g ? { structure: "upwell", starbase: "starbase", deployable: "deployable" }[g[1]] : null;
		return kind ? { typeID: id, typeName: t[0], kind: kind, tower: parseInt(t[1], 10) === structures.TOWER_GROUP } : null;
	},

	/** Upwell names are "<system> - <name>": {prefix (a J-code or a short plain name, else ""), rest} */
	splitName: function(name) {
		const s = String(name === undefined || name === null ? "" : name);
		let m = /^(J[0-9]{6}) - ([\s\S]*)$/.exec(s);
		if (!m) { m = /^([A-Za-z0-9'][A-Za-z0-9' -]{0,23}?) - ([\s\S]+)$/.exec(s); }
		return m ? { prefix: m[1], rest: m[2] } : { prefix: "", rest: s };
	},

	/**
	 * Structures of a d-scan paste (POS modules are counted, not listed).
	 * @param systemName optional: an Upwell named for another J-system is marked wrong
	 * @return {structures: [{typeID, typeName, kind, name, km, prefix, rest, wrong}], modules, notRecognised, invalid}
	 */
	parseScan: function(text, types, systemName) {
		const parsed = intelScans.parseDscan(text);
		const out = [];
		let modules = 0;
		let other = 0;
		parsed.rows.forEach(function(r) {
			const info = structures.classify(r[0], r[1], types);
			if (!info) { other++; return; }
			if (info.kind === "starbase" && !info.tower) { modules++; return; }
			const split = structures.splitName(r[2]);
			const wrong = info.kind === "upwell" && !!split.prefix && !!systemName && /^J[0-9]{6}$/.test(split.prefix)
				&& split.prefix.toLowerCase() !== String(systemName).toLowerCase();
			out.push({ typeID: info.typeID, typeName: info.typeName, kind: info.kind, name: r[2], km: r[3],
				prefix: split.prefix, rest: split.rest, wrong: wrong });
		});
		return { structures: out, modules: modules, notRecognised: other, invalid: parsed.invalid };
	},

	/**
	 * Structures of a copied overview selection (tab-separated, the columns the pilot chose; best effort). The first cell that
	 * is exactly a structure type name is the type, the first cell that reads as a distance the distance, and the name is the
	 * longest other cell, preferring those containing " - "; a name equal to the type name is no name. Mirrors
	 * structures_parse_overview (shared fixtures). Same result shape as parseScan, plus overview: true.
	 */
	parseOverview: function(text, types, systemName) {
		const out = [];
		let modules = 0;
		let other = 0;
		intelScans.lines(text).forEach(function(line) {
			const cells = line.split("\t").map(function(c) { return intelScans.cleanField(c); });
			let typeAt = -1;
			let info = null;
			cells.some(function(cell, i) {
				if (cell === "") { return false; }
				const found = structures.classify(null, cell, types);
				if (found && found.typeName.toLowerCase() === cell.toLowerCase()) { typeAt = i; info = found; return true; }
				return false;
			});
			if (!info) { other++; return; }
			if (info.kind === "starbase" && !info.tower) { modules++; return; }
			let km = null;
			let kmAt = -1;
			cells.some(function(cell, i) {
				if (i === typeAt || cell === "") { return false; }
				const v = intelScans.parseDistanceKm(cell);
				if (v !== null) { km = v; kmAt = i; return true; }
				return false;
			});
			let name = "";
			let withDash = false;
			cells.forEach(function(cell, i) {
				if (i === typeAt || i === kmAt || cell === "" || cell === "-" || /^[\[<(]?[A-Z0-9][A-Z0-9.\-]{1,4}[\]>)]?$/.test(cell)) { return; }	// not a ticker column
				const dash = cell.indexOf(" - ") >= 0;
				if ((dash && !withDash) || (dash === withDash && Array.from(cell).length > Array.from(name).length)) { name = cell; withDash = dash; }
			});
			if (name.toLowerCase() === info.typeName.toLowerCase()) { name = ""; }
			const split = structures.splitName(name);
			const wrong = info.kind === "upwell" && !!split.prefix && !!systemName && /^J[0-9]{6}$/.test(split.prefix)
				&& split.prefix.toLowerCase() !== String(systemName).toLowerCase();
			out.push({ typeID: info.typeID, typeName: info.typeName, kind: info.kind, name: name, km: km, prefix: split.prefix, rest: split.rest, wrong: wrong });
		});
		return { structures: out, modules: modules, notRecognised: other, invalid: 0, overview: true };
	},

	/**
	 * Match scanned structures with stored rows: [{id, restore}] per incoming row (id null = new).
	 * existing: [{id, typeID, name, removed}] (live rows and removed ones, not destroyed); incoming: [{typeID, name}].
	 * Rules: same type and full name (case-insensitive); same type and name without the system prefix; unnamed rows
	 * of the same type by count. Live rows are matched before removed ones.
	 */
	merge: function(existing, incoming) {
		const used = {};
		const order = existing.map(function(e, i) { return i; }).sort(function(a, z) {
			return (existing[a].removed ? 1 : 0) - (existing[z].removed ? 1 : 0) || a - z;
		});
		return incoming.map(function(inc) {
			const incRest = structures.splitName(inc.name).rest;
			let found = null;
			[1, 2, 3].some(function(rule) {
				return order.some(function(i) {
					const e = existing[i];
					if (used[i] || parseInt(e.typeID, 10) !== parseInt(inc.typeID, 10)) { return false; }
					let ok;
					if (rule === 1) { ok = inc.name !== "" && e.name.toLowerCase() === inc.name.toLowerCase(); }
					else if (rule === 2) { ok = incRest !== "" && structures.splitName(e.name).rest.toLowerCase() === incRest.toLowerCase(); }
					else { ok = inc.name === "" && e.name === ""; }
					if (ok) { found = i; }
					return ok;
				});
			});
			if (found === null) { return { id: null, restore: false }; }
			used[found] = true;
			return { id: existing[found].id, restore: !!existing[found].removed };
		});
	},

	// ---- Timers ----

	pad2: function(n) { return (n < 10 ? "0" : "") + n; },

	/** "2026-10-12 18:30" (EVE time = UTC) */
	formatEve: function(ms) {
		const d = new Date(ms);
		return d.getUTCFullYear() + "-" + structures.pad2(d.getUTCMonth() + 1) + "-" + structures.pad2(d.getUTCDate())
			+ " " + structures.pad2(d.getUTCHours()) + ":" + structures.pad2(d.getUTCMinutes());
	},

	/** "2026-10-12 18:30:15", what is sent to the server (second precision) */
	formatEveFull: function(ms) {
		return structures.formatEve(ms) + ":" + structures.pad2(new Date(ms).getUTCSeconds());
	},

	formatLocal: function(ms) {
		const d = new Date(ms);
		return structures.pad2(d.getHours()) + ":" + structures.pad2(d.getMinutes());
	},

	/**
	 * Timer input: an EVE time "2026.10.12 18:30", ISO (UTC unless it has an offset), or a countdown read off the game:
	 * "1d 4h 20m", "2h14", "4:20:00" (hours:minutes:seconds). A bare "18:30" is an EVE clock time: today, or tomorrow
	 * when it is more than 2 hours past. Seconds are kept.
	 * @return {ms} or {error}
	 */
	parseTime: function(text, nowMs) {
		const s = String(text === undefined || text === null ? "" : text).trim();
		if (!s) { return { error: "Enter when the timer ends" }; }
		let m = /^(\d{4})[-.](\d{2})[-.](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
		if (m) {
			const mo = parseInt(m[2], 10), d = parseInt(m[3], 10), h = parseInt(m[4], 10), mi = parseInt(m[5], 10);
			let ms = Date.UTC(parseInt(m[1], 10), mo - 1, d, h, mi, m[6] ? parseInt(m[6], 10) : 0);
			const back = new Date(ms);
			if (mo < 1 || mo > 12 || d < 1 || back.getUTCDate() !== d || h > 23 || mi > 59) { return { error: "That is not a valid date" }; }
			if (m[7] && m[7] !== "Z") {
				const digits = m[7].replace(":", "");
				ms -= (m[7][0] === "-" ? -1 : 1) * (parseInt(digits.substr(1, 2), 10) * 3600000 + parseInt(digits.substr(3, 2), 10) * 60000);
			}
			return { ms: ms };
		}
		m = /^(\d{1,2}):(\d{2})$/.exec(s);
		if (m) {
			const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
			if (h > 23 || mi > 59) { return { error: "That is not a valid time" }; }
			const d = new Date(nowMs);
			let ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi, 0);
			if (ms < nowMs - structures.TIMER_PAST_S * 1000) { ms += 86400000; }	// more than 2 h ago: it means tomorrow
			return { ms: ms, clock: true };
		}
		m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(s);
		if (m) { return { ms: nowMs + ((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 1000 }; }
		m = /^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/i.exec(s) || /^(?:(\d+)\s*d)?\s*(\d+)\s*h\s*(\d{1,2})()$/i.exec(s);
		if (m && (m[1] || m[2] || m[3] || m[4])) {
			const n = function(v) { return v ? parseInt(v, 10) : 0; };
			return { ms: nowMs + (((n(m[1]) * 24 + n(m[2])) * 60 + n(m[3])) * 60 + n(m[4])) * 1000 };
		}
		return { error: "Use 2026.10.12 18:30 (EVE time) or a countdown like 1d 4h 20m" };
	},

	/** Error text when a timer end is outside "2 hours ago .. 30 days ahead", else "" */
	timerRangeError: function(ms, nowMs) {
		if (ms < nowMs - structures.TIMER_PAST_S * 1000) { return "That timer ended more than 2 hours ago"; }
		if (ms > nowMs + structures.TIMER_FUTURE_S * 1000) { return "Timers can be at most 30 days ahead"; }
		return "";
	},

	/** "1d4h", "2h14", "14m", "45s" */
	duration: function(seconds) {
		const s = Math.max(0, Math.floor(seconds));
		if (s >= 86400) { return Math.floor(s / 86400) + "d" + Math.floor((s % 86400) / 3600) + "h"; }
		if (s >= 3600) { return Math.floor(s / 3600) + "h" + structures.pad2(Math.floor((s % 3600) / 60)); }
		if (s >= 60) { return Math.floor(s / 60) + "m"; }
		return s + "s";
	},

	/** {phase: none|upcoming|elapsed|ended, text, urgent, label} of a row's timer at nowSec */
	timerStatus: function(row, nowSec) {
		if (!row || !row.timerKind || !row.timerAt) { return { phase: "none", text: "", urgent: false, label: "" }; }
		const left = row.timerAt - nowSec;
		const label = structures.TIMER_KINDS[row.timerKind] || "Timer";
		if (left > 0) { return { phase: "upcoming", text: structures.duration(left), urgent: left < 3600, label: label }; }
		if (-left <= structures.TIMER_PAST_S) { return { phase: "elapsed", text: "-" + structures.duration(-left), urgent: true, label: label }; }
		return { phase: "ended", text: "ended", urgent: false, label: label };
	},

	/** "now", "12m", "5h", "3d" */
	age: function(seconds) {
		const s = Math.max(0, Math.floor(seconds));
		if (s < 60) { return "now"; }
		if (s < 3600) { return Math.floor(s / 60) + "m"; }
		if (s < 86400) { return Math.floor(s / 3600) + "h"; }
		return Math.floor(s / 86400) + "d";
	},

	/**
	 * What to send for the add / edit form: only the fields the user changed (so an unchanged ended timer is not
	 * range-checked again, and the server's timer -> state mapping applies unless the state was changed too).
	 * @param row the stored row, or null for a new structure; v {owner, state, note, tkind, tat}
	 * @return {params} or {error}
	 */
	formDiff: function(row, v, nowMs) {
		const params = {};
		const curOwner = row ? (row.ownerID ? (row.ownerTicker || row.ownerName || "") : (row.ownerText || "")) : "";
		if (v.owner !== curOwner) { params.owner = v.owner; }
		if (v.state !== (row ? row.state : "unknown")) { params.state = v.state; }
		if (v.note !== (row ? row.note : "")) { params.note = v.note; }
		const curKind = row && row.timerKind ? row.timerKind : "";
		const curTat = row && row.timerAt ? structures.formatEve(row.timerAt * 1000).replace(/-/g, ".") : "";
		if (v.tkind !== curKind || v.tat !== curTat) {
			params.timerKind = v.tkind;
			if (v.tkind) {
				if (!String(v.tat).trim()) { return { error: "Enter when the timer ends" }; }
				if (v.tat !== curTat) {
					const t = structures.parseTime(v.tat, nowMs);
					const err = t.error || structures.timerRangeError(t.ms, nowMs);
					if (err) { return { error: err }; }
					params.timerAt = structures.formatEveFull(t.ms);
				}
			}
		}
		return { params: params };
	},

	/**
	 * Where a new panel goes: right of the existing widgets from row 1 when that fits the window, else below them.
	 * @param widgets [{col, row, size_x, size_y}], availableCols grid columns that fit (optional)
	 */
	defaultPlacement: function(widgets, availableCols) {
		let maxCol = 0, maxRow = 0;
		(widgets || []).forEach(function(w) {
			if (!w) { return; }
			maxCol = Math.max(maxCol, (Number(w.col) || 1) + (Number(w.size_x) || 1) - 1);
			maxRow = Math.max(maxRow, (Number(w.row) || 1) + (Number(w.size_y) || 1) - 1);
		});
		const size = structures.SIZE;
		if (availableCols && maxCol && maxCol + size.x > availableCols) { return { col: 1, row: maxRow + 1, size_x: size.x, size_y: size.y }; }
		return { col: maxCol + 1, row: 1, size_x: size.x, size_y: size.y };
	},

	// ---- Residents strip ----

	ownerKey: function(row) {
		if (row.ownerID) { return row.ownerType + ":" + row.ownerID; }
		const t = String(row.ownerText || "").trim().toLowerCase();
		return t ? "text:" + t : "";
	},

	/**
	 * One chip per structure owner (ours first, then hostile, then unresolved; most structures first), then up to
	 * `extraMax` corporations seen in kills here that own none of them. Residents set by hand for the mask (Intel panel >
	 * Set residents) come first: one chip each; one that also owns structures here is that owner's chip (marked `set`).
	 * @param extra [{id, name, ticker}] corporations from System Threat
	 * @param set {entities: [{kind, id, name, ticker}], setBy} residents set by hand, or null
	 * @return [{key, side: ours|hostile|unknown|seen|set, id, type, ticker, name, count, set, setBy}]
	 */
	residents: function(rows, extra, extraMax, set) {
		const by = {};
		const out = [];
		rows.forEach(function(r) {
			const key = structures.ownerKey(r);
			if (!key) { return; }
			if (!by[key]) {
				by[key] = { key: key, side: r.ownerID ? r.side : "unknown", id: r.ownerID || null, type: r.ownerType || null,
					ticker: r.ownerTicker || (r.ownerID ? "" : String(r.ownerText || "")), name: r.ownerName || String(r.ownerText || ""), count: 0 };
				out.push(by[key]);
			}
			by[key].count++;
		});
		const rank = { ours: 0, hostile: 1, unknown: 2 };
		out.sort(function(a, z) { return rank[a.side] - rank[z.side] || z.count - a.count || (a.ticker < z.ticker ? -1 : a.ticker > z.ticker ? 1 : 0); });
		const first = [];
		const setKeys = {};
		((set && set.entities) || []).forEach(function(e) {
			const id = parseInt(e.id, 10);
			if (!(id > 0)) { return; }
			const type = e.kind === "alliance" ? "alliance" : "corporation";
			const key = type + ":" + id;
			if (setKeys[key]) { return; }
			setKeys[key] = true;
			if (by[key]) {
				by[key].set = true; by[key].setBy = set.setBy || "";
				out.splice(out.indexOf(by[key]), 1);
				first.push(by[key]);
			} else {
				first.push({ key: key, side: "set", set: true, setBy: set.setBy || "", id: id, type: type, ticker: e.ticker || "", name: e.name || "", count: 0 });
			}
		});
		(extra || []).slice(0, 20).forEach(function(c) {
			const key = "corporation:" + c.id;
			if (by[key] || setKeys[key] || out.filter(function(o) { return o.side === "seen"; }).length >= (extraMax === undefined ? 3 : extraMax)) { return; }
			out.push({ key: key, side: "seen", id: c.id, type: "corporation", ticker: c.ticker || "", name: c.name || "", count: 0 });
		});
		return first.concat(out);
	},

	// ---- Rendering ----

	ICONS: {
		online: "<circle cx='6' cy='6' r='4' fill='currentColor'/>",
		offline: "<circle cx='6' cy='6' r='3.4' fill='none' stroke='currentColor' stroke-width='1.5'/>",
		reinforced: "<path d='M6 1L10.5 2.8V6.2C10.5 8.6 8.6 10.4 6 11.3 3.4 10.4 1.5 8.6 1.5 6.2V2.8Z' fill='currentColor'/>",
		low_power: "<path d='M7 1L2.5 7H5.5L5 11 9.5 5H6.5Z' fill='currentColor'/>",
		anchoring: "<path d='M6 1V8M3 5.5L6 8.5 9 5.5M2.5 11H9.5' stroke='currentColor' fill='none' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/>",
		unanchoring: "<path d='M6 11V4M3 6.5L6 3.5 9 6.5M2.5 1H9.5' stroke='currentColor' fill='none' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/>",
		abandoned: "<path d='M3 3L9 9M9 3L3 9' stroke='currentColor' fill='none' stroke-width='1.6' stroke-linecap='round'/>",
		unknown: "<path d='M4.4 4.6A1.7 1.7 0 1 1 6.6 6.2C6.1 6.5 6 6.8 6 7.4M6 9.4V9.6' stroke='currentColor' fill='none' stroke-width='1.4' stroke-linecap='round'/>",
		paste: "<rect x='2.5' y='2.5' width='7' height='8.5' rx='1' fill='none' stroke='currentColor' stroke-width='1.2'/><path d='M4.5 2.5V1.3H7.5V2.5M4.5 6H7.5M4.5 8.2H7.5' stroke='currentColor' fill='none' stroke-width='1.1'/>",
		clock: "<circle cx='6' cy='6' r='4.6' fill='none' stroke='currentColor' stroke-width='1.2'/><path d='M6 3.2V6L8 7.2' stroke='currentColor' fill='none' stroke-width='1.2' stroke-linecap='round'/>",
		dead: "<circle cx='6' cy='6' r='4.6' fill='none' stroke='currentColor' stroke-width='1.2' stroke-dasharray='2 1.2'/><path d='M4 4L8 8M8 4L4 8' stroke='currentColor' fill='none' stroke-width='1.3' stroke-linecap='round'/>"
	},

	icon: function(name, extraClass, title) {
		return "<svg class='str-ico " + structures.escape(extraClass || "") + "' viewBox='0 0 12 12' width='12' height='12' aria-hidden='true'"
			+ ">" + (title ? "<title>" + structures.escape(title) + "</title>" : "") + (structures.ICONS[name] || "") + "</svg>";
	},

	typeIconUrl: function(typeID) {
		const n = parseInt(typeID, 10);
		return n > 0 ? "https://images.evetech.net/types/" + n + "/icon?size=32" : "";
	},

	/** Name without the "J123456 - " prefix */
	shortName: function(row) {
		return structures.splitName(row.name).rest;
	},

	/** Plain-text tooltip of a row (escaped by the caller) */
	rowTitle: function(row, nowSec) {
		const lines = [row.typeName + (row.name ? " \"" + row.name + "\"" : "")];
		const owner = row.ownerID ? (row.ownerTicker ? "[" + row.ownerTicker + "] " : "") + row.ownerName : (row.ownerText ? row.ownerText + " (unresolved)" : "");
		lines.push("Owner: " + (owner || "unknown") + (row.ownerID ? " (" + (row.side === "ours" ? "ours" : "hostile") + ")" : ""));
		lines.push("State: " + (structures.STATES[row.state] ? structures.STATES[row.state][0] : row.state));
		const t = structures.timerStatus(row, nowSec);
		if (t.phase !== "none") {
			lines.push(t.label + ": " + (t.phase === "ended" ? "ended " : "") + structures.formatEve(row.timerAt * 1000) + " EVE (your time " + structures.formatLocal(row.timerAt * 1000) + ")"
				+ (t.phase === "upcoming" ? ", in " + t.text : t.phase === "elapsed" ? ", " + t.text.substr(1) + " ago" : "")
				+ (row.timerSetBy ? ", set by " + row.timerSetBy : ""));
		}
		lines.push("Seen " + structures.age(nowSec - row.lastSeenAt) + (structures.age(nowSec - row.lastSeenAt) === "now" ? "" : " ago") + (row.lastSeenBy ? " by " + row.lastSeenBy : "")
			+ (nowSec - row.lastSeenAt > structures.STALE_S ? " (stale)" : ""));
		if (row.note) { lines.push("Note: " + row.note); }
		return lines.join("\n");
	},

	/**
	 * Hints from kills the feed stored here (never applied by themselves): {owner: [[id, type, name, ticker, losses]], destroyed: [killID, killTime]}.
	 * The owner chip shows the likeliest candidate, the destroyed icon asks "was it killed?".
	 */
	ownerHintHtml: function(row, sugg) {
		const esc = structures.escape;
		const c = sugg && sugg.owner && sugg.owner[0];
		if (!c || row.ownerID || row.ownerText) { return ""; }
		const label = c[3] || c[2];
		const also = sugg.owner.length > 1 ? " (also: " + sugg.owner.slice(1).map(function(o) { return o[3] || o[2]; }).join(", ") + ")" : "";
		return "<span class='str-sugg-chip'><a href='#' class='str-sugg str-sugg-owner' data-id='" + row.id + "' data-owner='" + parseInt(c[0], 10) + "' data-type='" + esc(c[1]) + "' title='"
			+ esc("Possible owner: " + c[2] + (c[3] ? " [" + c[3] + "]" : "") + " lost " + c[4] + " " + row.typeName + (c[4] === 1 ? "" : "s") + " here (from kills)" + also + ". Click to set it as the owner.") + "'>"
			+ esc(label) + "?</a>" + structures.dismissHtml(row.id, "owner", parseInt(c[0], 10)) + "</span>";
	},

	/** The small x of a hint chip: hide this hint (kind owner: key = corporation ID, destroyed: key = kill ID) */
	dismissHtml: function(id, kind, key) {
		return "<a href='#' class='str-sugg-x' data-id='" + parseInt(id, 10) + "' data-kind='" + structures.escape(kind) + "' data-key='" + parseInt(key, 10) + "' title='Hide this hint'>&#10005;</a>";
	},

	deadHintHtml: function(row, sugg, nowSec) {
		const k = sugg && sugg.destroyed;
		if (!k) { return ""; }
		return "<span class='str-sugg-chip str-sugg-chip-dead'><a href='#' class='str-sugg str-sugg-dead' data-id='" + row.id + "' title='" + structures.escape("Destroyed? A " + row.typeName + " was killed here " + structures.age(nowSec - k[1])
			+ (structures.age(nowSec - k[1]) === "now" ? "" : " ago") + " (kill " + k[0] + ", see More). Click to mark it destroyed; it can be undone for 30 days.") + "'>" + structures.icon("dead") + "</a>"
			+ structures.dismissHtml(row.id, "destroyed", k[0]) + "</span>";
	},

	rowHtml: function(row, nowSec, highlight, sugg) {
		const esc = structures.escape;
		const t = structures.timerStatus(row, nowSec);
		const seen = nowSec - row.lastSeenAt;
		const state = structures.STATES[row.state] || structures.STATES.unknown;
		const owner = row.ownerID ? (row.ownerTicker || row.ownerName || "?") : (row.ownerText || "");
		const key = structures.ownerKey(row);
		let html = "<div class='str-row" + (highlight && key === highlight ? " str-hl" : "") + (highlight && key !== highlight ? " str-dim" : "")
			+ " str-" + esc(row.kind) + "' data-id='" + row.id + "' title='" + esc(structures.rowTitle(row, nowSec)) + "'>";
		const url = structures.typeIconUrl(row.typeID);
		html += url ? "<img class='str-type' src='" + esc(url) + "' alt='' width='18' height='18' loading='lazy' />" : "<span class='str-type str-type-unk'>?</span>";
		html += "<span class='str-tname'>" + esc(row.typeName) + "</span>";
		const ownerHint = structures.ownerHintHtml(row, sugg);
		html += "<span class='str-owner str-side-" + (row.ownerID ? esc(row.side) : "unknown") + (!row.ownerID && owner ? " str-unres" : "") + "'>" + (ownerHint || esc(owner || "–")) + "</span>";
		html += "<span class='str-state str-st-" + esc(row.state) + "'>" + structures.icon(state[1], "", state[0]) + "</span>";
		html += "<span class='str-timer" + (t.phase === "none" ? "" : " str-t-" + t.phase + (t.urgent ? " str-urgent" : "")) + "'>"
			+ (t.phase === "none" ? "" : structures.icon("clock") + esc(t.text)) + "</span>";
		html += structures.deadHintHtml(row, sugg, nowSec);
		html += "<span class='str-seen" + (seen > structures.STALE_S ? " str-stale" : seen > structures.OLD_S ? " str-old" : "") + "'>" + esc(structures.age(seen)) + "</span>";
		html += "<span class='str-actions'>"
			+ "<a href='#' class='str-edit' title='Edit owner, state, timer, note'>&#9998;</a>"
			+ "<a href='#' class='str-seennow' title='Seen now'>&#10227;</a>"
			+ "<a href='#' class='str-destroyed' title='Mark destroyed (can be undone for 30 days)'>&#10005;</a>"
			+ "<a href='#' class='str-more' title='More'>&#8943;</a></span>";
		return html + "</div>";
	},

	chipHtml: function(c, highlight) {
		const esc = structures.escape;
		const label = c.ticker || c.name || "?";
		const tip = (c.name ? c.name : label) + (c.side === "seen" ? " – seen in kills here" : c.count ? " – " + c.count + " structure" + (c.count === 1 ? "" : "s") : "")
			+ (c.set ? " – set as a resident" + (c.setBy ? " by " + c.setBy : "") : "") + (c.id ? ". Arrow: zKillboard / EveWho" : "");
		let html = "<span class='str-chip str-chip-" + esc(c.side) + (c.set ? " str-chip-isset" : "") + (highlight === c.key ? " str-chip-on" : "") + "' data-key='" + esc(c.key) + "' title='" + esc(tip) + "'>"
			+ esc(label) + (c.count ? " <b>" + c.count + "</b>" : "");
		if (c.id && c.type) {
			html += " <a class='str-chip-link' href='https://zkillboard.com/" + esc(c.type) + "/" + c.id + "/' target='_blank' rel='noopener noreferrer' title='zKillboard (EveWho: right-click, or evewho.com/"
				+ esc(c.type) + "/" + c.id + ")'>&#8599;</a>";
		}
		return html + "</span>";
	},

	/** Form to add a structure (row null) or edit one. @param state {types (for the type list)} */
	formHtml: function(row, nowSec, types) {
		const esc = structures.escape;
		let html = "<div class='str-form' data-for='" + (row ? row.id : "new") + "'>";
		if (!row) {
			html += "<input class='str-f-type' list='str-types' placeholder='Type (Astrahus, Control Tower…)' autocomplete='off' />"
				+ "<datalist id='str-types'>" + structures.typeNames(types).map(function(n) { return "<option value='" + esc(n) + "'>"; }).join("") + "</datalist>"
				+ "<input class='str-f-name' placeholder='Name (optional)' maxlength='100' />";
		}
		const owner = row ? (row.ownerID ? (row.ownerTicker || row.ownerName) : (row.ownerText || "")) : "";
		html += "<input class='str-f-owner' placeholder='Owner ticker or name' maxlength='100' value='" + esc(owner) + "' />";
		html += "<select class='str-f-state'>" + Object.keys(structures.STATES).map(function(k) {
			return "<option value='" + k + "'" + ((row ? row.state : "unknown") === k ? " selected" : "") + ">" + esc(structures.STATES[k][0]) + "</option>";
		}).join("") + "</select>";
		const kind = row && row.timerKind ? row.timerKind : "";
		html += "<select class='str-f-tkind'><option value=''>No timer</option>" + Object.keys(structures.TIMER_KINDS).map(function(k) {
			return "<option value='" + k + "'" + (kind === k ? " selected" : "") + ">" + esc(structures.TIMER_KINDS[k]) + "</option>";
		}).join("") + "</select>";
		html += "<input class='str-f-tat' placeholder='2026.10.12 18:30 or 1d 4h 20m' value='"
			+ esc(row && row.timerAt ? structures.formatEve(row.timerAt * 1000).replace(/-/g, ".") : "") + "' />";
		html += "<span class='str-f-preview'></span>";
		html += "<input class='str-f-note' placeholder='Note' maxlength='500' value='" + esc(row ? row.note : "") + "' />";
		html += "<span class='str-f-buttons'><button type='button' class='str-f-save'>Save</button> <button type='button' class='str-f-cancel'>Cancel</button></span>";
		html += "<div class='str-f-error'></div></div>";
		return html;
	},

	/** Structure type names for the Add form: every Upwell / deployable type and Control Towers, plus Unknown structure */
	typeNames: function(types) {
		if (!types || !types.types) { return ["Unknown structure"]; }
		const names = ["Unknown structure"];
		Object.keys(types.types).forEach(function(k) {
			const info = structures.classify(k, null, types);
			if (info && (info.kind !== "starbase" || info.tower)) { names.push(info.typeName); }
		});
		return names.filter(function(n, i) { return names.indexOf(n) === i; }).sort();
	},

	/**
	 * Body of the panel.
	 * @param s {rows (live), gone, nowSec, highlight (owner key), editing ("new" | row id | null), moreID, showGone,
	 *           extraCorps, types, error, loaded, systemID}
	 */
	panelHtml: function(s) {
		const esc = structures.escape;
		let html = "";
		if (s.error) { html += "<div class='str-error'>" + esc(s.error) + "</div>"; }
		const chips = structures.residents(s.rows, s.extraCorps, undefined, s.setResidents);
		if (chips.length) {
			html += "<div class='str-residents' title='Who lives here: owners of the structures (ours green, hostile orange), outlined = corporations seen in kills here'>"
				+ chips.map(function(c) { return structures.chipHtml(c, s.highlight); }).join("") + "</div>";
		}
		if (s.editing === "new") { html += structures.formHtml(null, s.nowSec, s.types); }
		if (!s.rows.length && s.editing !== "new") {
			html += "<div class='str-empty'>" + (s.loaded ? "No structures recorded. Paste a d-scan (Ctrl+V) or add one with +." : "Loading…") + "</div>";
		}
		s.rows.forEach(function(row) {
			html += structures.rowHtml(row, s.nowSec, s.highlight, s.suggestions ? s.suggestions[row.id] : null);
			if (s.editing === row.id) { html += structures.formHtml(row, s.nowSec, s.types); }
			if (s.moreID === row.id) {
				const dead = s.suggestions && s.suggestions[row.id] ? s.suggestions[row.id].destroyed : null;
				html += "<div class='str-more-row'><a href='#' class='str-remove' data-id='" + row.id + "'>Remove this entry (not here any more)</a>"
					+ (dead ? " &middot; <a href='https://zkillboard.com/kill/" + parseInt(dead[0], 10) + "/' target='_blank' rel='noopener noreferrer'>the kill on zKillboard</a>" : "") + "</div>";
			}
		});
		if (s.gone && s.gone.length) {
			html += "<div class='str-gone-head'><a href='#' class='str-gone-toggle'>" + (s.showGone ? "&#9662;" : "&#9656;") + " Gone (" + s.gone.length + ")</a></div>";
			if (s.showGone) {
				s.gone.forEach(function(row) {
					html += "<div class='str-row str-gonerow' data-id='" + row.id + "' title='" + esc(structures.rowTitle(row, s.nowSec)) + "'>"
						+ "<span class='str-tname'>" + esc(row.typeName) + " " + esc(structures.shortName(row)) + "</span>"
						+ "<span class='str-seen'>" + esc(row.state === "destroyed" ? "destroyed" : "removed") + " " + esc(structures.age(s.nowSec - row.goneAt)) + "</span>"
						+ "<a href='#' class='str-undo' data-id='" + row.id + "'>Undo</a></div>";
				});
			}
		}
		return html;
	},

	/** Header counts: "5" and the next timer */
	headerText: function(rows, nowSec) {
		if (!rows.length) { return ""; }
		const next = rows.map(function(r) { return structures.timerStatus(r, nowSec); }).filter(function(t) { return t.phase === "upcoming" || t.phase === "elapsed"; })[0];
		return String(rows.length) + (next ? " · " + next.label.toLowerCase().split(" ")[0] + " " + next.text : "");
	},

	// ---- Dialog section (the d-scan paste dialog) ----

	/**
	 * Preview of the structures in a pasted d-scan.
	 * @param scan parseScan() result; existing: stored rows (live + removed) of the system or null when unknown;
	 * @param checked {index: bool} (default checked)
	 * @return {html, saveCount}
	 */
	dialogHtml: function(scan, existing, checked, master, systemName) {
		const esc = structures.escape;
		const plan = existing ? structures.merge(existing.map(function(e) { return { id: e.id, typeID: e.typeID, name: e.name, removed: e.state === "removed" }; }),
			scan.structures.map(function(r) { return { typeID: r.typeID, name: r.name }; })) : null;
		let wrong = {};
		scan.structures.forEach(function(r) { if (r.wrong) { wrong[r.prefix] = (wrong[r.prefix] || 0) + 1; } });
		let html = "<div class='str-dlg'><label class='str-dlg-master'><input type='checkbox' class='str-dlg-all'" + (master ? " checked" : "") + " /> Save structures to "
			+ esc(systemName || "this system") + " (" + scan.structures.length + ")</label>"
			+ (scan.overview ? "<div class='str-dlg-note'>Read from an overview selection (type, name and distance found by their content): check the rows.</div>" : "") + "<ul class='str-dlg-list'>";
		let saveCount = 0;
		scan.structures.forEach(function(r, i) {
			const on = checked[i] !== undefined ? !!checked[i] : !r.wrong;
			if (on && master) { saveCount++; }
			const p = plan ? plan[i] : null;
			const tag = p ? (p.id ? (p.restore ? "restored" : "seen again") : "new") : "";
			html += "<li class='" + (r.wrong ? "str-dlg-wrong" : "") + "'><label><input type='checkbox' class='str-dlg-row' data-i='" + i + "'" + (on ? " checked" : "") + (master ? "" : " disabled") + " /> "
				+ esc(r.typeName) + (r.name ? " · " + esc(r.name) : "") + (r.km !== null ? " · " + esc(intelScans.formatDistance(r.km)) : "") + "</label>"
				+ (tag ? " <span class='str-dlg-tag str-dlg-" + tag.replace(" ", "-") + "'>" + tag + "</span>" : "") + "</li>";
		});
		html += "</ul>";
		Object.keys(wrong).forEach(function(prefix) {
			html += "<div class='str-dlg-warn'>" + wrong[prefix] + " structure" + (wrong[prefix] === 1 ? " is" : "s are") + " named for " + esc(prefix) + ", not " + esc(systemName) + " (unchecked)</div>";
		});
		if (plan) {
			const matched = {};
			plan.forEach(function(p) { if (p.id) { matched[p.id] = true; } });
			const missing = existing.filter(function(e) { return e.state !== "removed" && !matched[e.id]; });
			if (missing.length) {
				html += "<div class='str-dlg-note'>Not in this scan: " + missing.length + " (out of range or gone)</div>";
				const newTypes = {};
				plan.forEach(function(p, i) { if (!p.id && scan.structures[i].kind === "upwell") { newTypes[scan.structures[i].typeID] = true; } });
				const renamed = missing.filter(function(e) { return e.kind === "upwell" && newTypes[e.typeID]; });
				if (renamed.length) { html += "<div class='str-dlg-note'>Possibly renamed: " + renamed.length + " " + esc(renamed[0].typeName) + " not seen in this scan</div>"; }
			}
		}
		if (scan.modules) { html += "<div class='str-dlg-note'>" + scan.modules + " POS module" + (scan.modules === 1 ? "" : "s") + " not stored (only the tower is)</div>"; }
		return { html: html + "</div>", saveCount: saveCount };
	},

	// ---- Browser-only code below (not run under mocha) ----

	rows: [],
	gone: [],
	hash: "",
	systemID: null,
	offset: 0,			// server time - browser time, seconds
	loaded: false,
	error: "",
	highlight: null,
	editing: null,
	moreID: null,
	showGone: false,
	xhr: null,
	notice: "",
	view: "system",		// "system" (this system's structures) or "timers" (the board of every active timer of the mask)
	sugg: {},			// hints from stored kills per structure id (never applied by themselves), from the list response
	setRes: null,		// residents set by hand for this system (system_residents.php), see setResidents()
	setResAt: 0,

	opts: function() { return typeof options !== "undefined" ? options : null; },
	isSystem: function(id) { id = parseInt(id, 10); return id >= 30000000 && id < 33000000; },
	nowSec: function() { return Math.floor(Date.now() / 1000) + structures.offset; },
	types: function() { return typeof intelScans !== "undefined" ? intelScans.types : null; },
	$widget: function() { return $("#" + structures.WIDGET_ID); },

	systemName: function(id) {
		return typeof intelScans !== "undefined" ? intelScans.systemName(id) : String(id);
	},

	/** Corporations System Threat saw in kills in the viewed system (extra residents chips) */
	threatCorps: function() {
		if (typeof systemThreat === "undefined" || !systemThreat.detailResponse || !systemThreat.detailResponse.detail
			|| systemThreat.detailResponse.detail.systemID !== structures.systemID) { return []; }
		try {
			const model = systemThreat.infoModel(systemThreat.detailResponse, Date.now(), typeof tripwire !== "undefined" ? tripwire.systems : null);
			return model ? model.residents.corporations.filter(function(c) { return c.kind === "corporation" && !!c.id; })
				.map(function(c) { return { id: c.id, name: c.name, ticker: c.ticker }; }) : [];
		} catch (e) { return []; }
	},

	/** Residents set by hand for the viewed system: our own poll, or System Threat's copy when it is newer (just edited) */
	setResidents: function() {
		let set = structures.setRes;
		if (typeof systemThreat !== "undefined" && systemThreat.detailID === structures.systemID && (systemThreat.residentsAt || 0) > structures.setResAt) {
			set = systemThreat.residentsSet || null;
		}
		return set && set.systemID === structures.systemID && set.entities && set.entities.length ? set : null;
	},

	fetchSetResidents: function() {
		const id = structures.systemID;
		if (!id) { return; }
		if (structures.resXhr) { structures.resXhr.abort(); }
		const xhr = $.ajax({ url: "system_residents.php", type: "GET", dataType: "JSON", cache: false, timeout: 15000, data: { systemID: id } });
		structures.resXhr = xhr;
		xhr.done(function(response) {
			if (id !== structures.systemID) { return; }
			structures.setRes = response && response.residents ? response.residents : null;
			structures.setResAt = Date.now();
			structures.renderPanel();
		}).always(function() { if (structures.resXhr === xhr) { structures.resXhr = null; } });
	},

	absorb: function(response) {
		if (!response || response.systemID !== structures.systemID) { return; }
		if (typeof response.serverTime === "number") { structures.offset = response.serverTime - Math.floor(Date.now() / 1000); }
		if (!response.unchanged) {
			structures.rows = response.structures || [];
			structures.gone = response.gone || [];
			structures.hash = response.hash || "";
			structures.sugg = response.suggestions && !Array.isArray(response.suggestions) ? response.suggestions : {};
		}
		structures.loaded = true;
		structures.error = "";
	},

	fetch: function() {
		if (!structures.enabled(structures.opts())) { return; }
		if (structures.view === "timers" && typeof structureTimers !== "undefined") { structureTimers.fetchBoard(); }
		if (!structures.isSystem(structures.systemID)) { return; }
		if (document.hidden) { structures.missed = true; return; }
		if (structures.xhr) { structures.xhr.abort(); }
		// Residents set by hand: with the system change (setSystem) and every 5 minutes, not with every 60 s poll
		if (Date.now() - structures.setResAt > 300000) { structures.fetchSetResidents(); }
		const id = structures.systemID;
		const xhr = $.ajax({ url: structures.URL, type: "GET", dataType: "JSON", cache: false, timeout: 15000,
			data: { action: "list", systemID: id, have: structures.hash } });
		structures.xhr = xhr;
		xhr.done(function(response) {
			if (id !== structures.systemID) { return; }
			structures.absorb(response);
			structures.renderPanel();
		}).fail(function(x, status) {
			if (status === "abort") { return; }
			structures.error = "Could not load structures" + (x && x.status ? " (HTTP " + x.status + ")" : "");
			structures.renderPanel();
		}).always(function() { if (structures.xhr === xhr) { structures.xhr = null; } });
	},

	post: function(params) {
		return $.ajax({ url: structures.URL, type: "POST", data: params, dataType: "JSON", timeout: 20000, headers: { "X-Requested-With": "XMLHttpRequest" } });
	},

	/** POST and show the answer (the system's list); extra(response) runs on success */
	write: function(params, done) {
		const id = structures.systemID;
		return structures.post(params).done(function(response) {
			if (response && response.systemID === id) { structures.absorb(response); }
			if (done) { done(response); }
			structures.renderPanel();
		}).fail(function(x) {
			structures.error = x && x.responseJSON && x.responseJSON.error ? x.responseJSON.error : "Could not save" + (x && x.status ? " (HTTP " + x.status + ")" : "");
			structures.renderPanel();
		});
	},

	/** The open form's typed values and focus, so a re-render (poll, another row's action) does not lose them */
	captureForm: function($w) {
		const $f = $w.find(".str-form");
		if (!$f.length) { return null; }
		const vals = {};
		$f.find("input, select").each(function() { vals[this.className] = $(this).val(); });
		const a = document.activeElement;
		const focus = a && $f[0].contains(a) ? { cls: a.className, start: a.selectionStart, end: a.selectionEnd } : null;
		return { "for": $f.attr("data-for"), vals: vals, focus: focus, error: $f.find(".str-f-error").html() };
	},

	restoreForm: function($w, cap) {
		const $f = $w.find(".str-form");
		if (!cap || !$f.length || $f.attr("data-for") !== cap["for"]) { return; }
		$f.find("input, select").each(function() { if (cap.vals[this.className] !== undefined) { $(this).val(cap.vals[this.className]); } });
		$f.find(".str-f-error").html(cap.error || "");
		structures.updatePreview($f);
		if (cap.focus) {
			const el = $f.find("." + String(cap.focus.cls).split(" ")[0])[0];
			if (el) { el.focus(); try { el.setSelectionRange(cap.focus.start, cap.focus.end); } catch (e) { /* not a text field */ } }
		}
	},

	renderPanel: function(force) {
		const $w = structures.$widget();
		if (!$w.length) { return; }
		const nowSec = structures.nowSec();
		const id = structures.systemID;
		if (typeof structureTimers !== "undefined") { structureTimers.renderInfo(); }
		const timersView = structures.view === "timers" && typeof structureTimers !== "undefined";
		$w.toggleClass("str-view-timers", timersView).find(".str-board").toggleClass("str-on", timersView);
		$w.find(".str-title").text(timersView ? "Timers" : "Structures");
		if (timersView) {
			const inChain = {};
			structureTimers.chainIDs.forEach(function(sid) { inChain[sid] = true; });
			const board = { rows: structureTimers.boardData || [], filters: structureTimers.filters, nowSec: nowSec, inChain: inChain,
				systemName: structures.systemName, loaded: structureTimers.boardData !== null, error: structureTimers.boardError || "", capped: structureTimers.boardCapped };
			$w.find(".str-system").text("");
			$w.find(".str-count").text(String(structureTimers.boardRows(board.rows, board.filters, nowSec).length || ""));
			const top = $w.find(".content").scrollTop();
			$w.find(".str-body").html(structureTimers.boardHtml(board));
			$w.find(".content").scrollTop(top);
			return;
		}
		$w.find(".str-system").text(id ? structures.systemName(id) : "");
		$w.find(".str-count").text(structures.headerText(structures.rows, nowSec));
		// The edited row was removed (by someone else): close the form and say so
		if (typeof structures.editing === "number" && !structures.rowByID(structures.editing)) {
			structures.editing = null;
			structures.notice = "This structure was removed by someone else";
		}
		// While a form is open (poll, another row's action) only the rows are refreshed; the form is never rebuilt.
		// Everything is rebuilt when the form closes (Save, Cancel, Esc) or another form opens (redraw).
		if (structures.editing && !force && $w.find(".str-form").length) {
			const live = {};
			structures.rows.forEach(function(r) {
				live[r.id] = true;
				$w.find(".str-row[data-id='" + r.id + "']:not(.str-gonerow)").replaceWith(structures.rowHtml(r, nowSec, structures.highlight, structures.sugg[r.id]));
			});
			$w.find(".str-row:not(.str-gonerow)").each(function() { if (!live[$(this).attr("data-id")]) { $(this).remove(); } });
			return;
		}
		const cap = structures.editing ? structures.captureForm($w) : null;
		const $content = $w.find(".content");
		const scroll = $content.scrollTop();
		$w.find(".str-body").html(structures.panelHtml({
			rows: structures.rows, gone: structures.gone, nowSec: nowSec, highlight: structures.highlight, editing: structures.editing, moreID: structures.moreID,
			showGone: structures.showGone, extraCorps: structures.threatCorps(), setResidents: structures.setResidents(), suggestions: structures.sugg, types: structures.types(), error: structures.error || structures.notice, loaded: structures.loaded
		}));
		structures.notice = "";	// shown once
		$content.scrollTop(scroll);
		structures.restoreForm($w, cap);
	},

	redraw: function() {
		structures.renderPanel(true);
		const $f = structures.$widget().find(".str-form");
		if ($f.length) { structures.updatePreview($f); }
	},

	rowByID: function(id) {
		return structures.rows.filter(function(r) { return r.id === id; })[0] || null;
	},

	/** "ends 2026-10-12 18:30 EVE (your time 20:30)" under the timer input */
	updatePreview: function($form) {
		const text = $form.find(".str-f-tat").val();
		const $p = $form.find(".str-f-preview");
		if (!$form.find(".str-f-tkind").val() || !String(text).trim()) { $p.text("").removeClass("str-bad"); return; }
		const nowMs = structures.nowSec() * 1000;
		const t = structures.parseTime(text, nowMs);
		const err = t.error || structures.timerRangeError(t.ms, nowMs);
		if (err) { $p.text(err).addClass("str-bad"); return; }
		$p.removeClass("str-bad").text("ends " + structures.formatEve(t.ms) + " EVE (your time " + structures.formatLocal(t.ms) + ")");
	},

	/** The form's changed fields as POST params; null (with the error shown) when invalid */
	formParams: function($form) {
		const id = $form.attr("data-for");
		const r = structures.formDiff(id === "new" ? null : structures.rowByID(parseInt(id, 10)), {
			owner: $.trim($form.find(".str-f-owner").val()), state: $form.find(".str-f-state").val(), note: $.trim($form.find(".str-f-note").val()),
			tkind: $form.find(".str-f-tkind").val(), tat: $.trim($form.find(".str-f-tat").val())
		}, structures.nowSec() * 1000);
		if (r.error) { $form.find(".str-f-error").text(r.error); return null; }
		return r.params;
	},

	bindPanel: function() {
		const sel = "#" + structures.WIDGET_ID;
		const rowID = function(el) { return parseInt($(el).closest("[data-id]").attr("data-id"), 10); };
		$(document).on("keydown", sel + " .str-form", function(e) {
			if (e.which === 27) { e.preventDefault(); structures.editing = null; structures.redraw(); }
		}).on("click", sel + " .str-add", function(e) {
			e.preventDefault();
			structures.notice = "";
			if (structures.types() === null && typeof intelScans !== "undefined") { intelScans.loadTypes(); }
			structures.editing = structures.editing === "new" ? null : "new";
			structures.redraw();
		}).on("click", sel + " .str-sugg-owner", function(e) {
			e.preventDefault();
			// Same request as picking the owner in the edit form: the server checks the entity against its cache
			structures.write({ action: "update", id: rowID(this), ownerID: $(this).attr("data-owner"), ownerType: $(this).attr("data-type") });
		}).on("click", sel + " .str-sugg-x", function(e) {
			e.preventDefault();
			e.stopPropagation();
			structures.write({ action: "dismiss", id: $(this).attr("data-id"), kind: $(this).attr("data-kind"), key: $(this).attr("data-key") });
		}).on("click", sel + " .str-sugg-dead", function(e) {
			e.preventDefault();
			structures.write({ action: "gone", id: rowID(this), state: "destroyed" });
		}).on("click", sel + " .str-board", function(e) {
			e.preventDefault();
			structures.setView(structures.view === "timers" ? "system" : "timers");
		}).on("click", sel + " .str-filter", function(e) {
			e.preventDefault();
			const f = $(this).attr("data-f");
			if (f === "hostileOnly" || f === "hideEnded") {
				structureTimers.filters[f] = !structureTimers.filters[f];
				structureTimers.saveFilters();
				structures.renderPanel();
			}
		}).on("click", sel + " .str-trow", function() {
			const id = parseInt($(this).attr("data-sys"), 10);
			if (structures.isSystem(id) && typeof tripwire !== "undefined") { tripwire.systemChange(id); }
		}).on("click", sel + " .str-paste", function(e) {
			e.preventDefault();
			if (typeof intelScans !== "undefined") { intelScans.openDialog(structures.systemID); }
		}).on("click", sel + " .str-chip", function(e) {
			if ($(e.target).closest(".str-chip-link").length || $(this).hasClass("str-chip-set")) { return; }
			const key = $(this).attr("data-key");
			structures.highlight = structures.highlight === key ? null : key;
			structures.redraw();
		}).on("click", sel + " .str-edit", function(e) {
			e.preventDefault();
			const id = rowID(this);
			structures.notice = "";
			structures.editing = structures.editing === id ? null : id;
			structures.moreID = null;
			structures.redraw();
		}).on("click", sel + " .str-more", function(e) {
			e.preventDefault();
			const id = rowID(this);
			structures.moreID = structures.moreID === id ? null : id;
			structures.redraw();
		}).on("click", sel + " .str-seennow", function(e) {
			e.preventDefault();
			structures.write({ action: "update", id: rowID(this), seenNow: "1" });
		}).on("click", sel + " .str-destroyed", function(e) {
			e.preventDefault();
			structures.write({ action: "gone", id: rowID(this), state: "destroyed" });
		}).on("click", sel + " .str-remove", function(e) {
			e.preventDefault();
			structures.moreID = null;
			structures.write({ action: "gone", id: rowID(this), state: "removed" });
		}).on("click", sel + " .str-undo", function(e) {
			e.preventDefault();
			structures.write({ action: "gone", id: rowID(this), state: "restore" });
		}).on("click", sel + " .str-gone-toggle", function(e) {
			e.preventDefault();
			structures.showGone = !structures.showGone;
			structures.redraw();
		}).on("input change", sel + " .str-form .str-f-tat, " + sel + " .str-form .str-f-tkind", function() {
			structures.updatePreview($(this).closest(".str-form"));
		}).on("click", sel + " .str-pick", function(e) {
			e.preventDefault();
			const p = structures.pending;
			if (p) { structures.submitForm($(sel + " .str-form"), Object.assign({}, p.params, { owner: "", ownerID: $(this).attr("data-id"), ownerType: $(this).attr("data-type") })); }
		}).on("click", sel + " .str-f-cancel", function() {
			structures.editing = null;
			structures.redraw();
		}).on("click", sel + " .str-f-save", function() {
			const $form = $(this).closest(".str-form");
			const params = structures.formParams($form);
			if (!params) { return; }
			const id = $form.attr("data-for");
			if (id === "new") {
				params.action = "add";
				params.systemID = structures.systemID;
				params.typeName = $.trim($form.find(".str-f-type").val());
				params.name = $.trim($form.find(".str-f-name").val());
				if (!params.typeName) { $form.find(".str-f-error").text("Pick a type"); return; }
			} else {
				params.action = "update";
				params.id = id;
				if (Object.keys(params).length === 2) { structures.editing = null; structures.redraw(); return; }	// nothing changed
			}
			structures.submitForm($form, params);
		});
	},

	/** Send a form; an ambiguous owner (several corporations with that ticker) is answered with a pick list */
	submitForm: function($form, params) {
		if (typeof forkUsage !== "undefined") { forkUsage.track("structures", "saved"); }
		structures.post(params).done(function(response) {
			if (response && response.ownerChoices) {
				const html = response.ownerChoices.map(function(c) {
					return "<a href='#' class='str-pick' data-id='" + c[0] + "' data-type='" + structures.escape(c[1]) + "'>[" + structures.escape(c[3]) + "] " + structures.escape(c[2]) + " (" + structures.escape(c[1]) + ")</a>";
				}).join(" ");
				$form.find(".str-f-error").html("Several match, pick one: " + html);
				structures.pending = { params: params };
				return;
			}
			if (response && response.systemID === structures.systemID) { structures.absorb(response); }
			structures.editing = null;
			structures.redraw();
		}).fail(function(x) {
			$form.find(".str-f-error").text(x && x.responseJSON && x.responseJSON.error ? x.responseJSON.error : "Could not save" + (x && x.status ? " (HTTP " + x.status + ")" : ""));
		});
	},

	// ---- Panel widget (placed, added and removed by panel-host.js) ----

	widgetHtml: function() {
		return "<li id='" + structures.WIDGET_ID + "' class='gridWidget'>"
			+ "<div class='controls'><span class='str-head'><span class='str-title'>Structures</span> <span class='str-system'></span> <span class='str-count'></span></span>"
			+ "<span class='str-tools'><a href='#' class='str-board' title='Timers of all systems (click again to go back)'>" + structures.icon("clock") + "</a>"
			+ "<a href='#' class='str-add' title='Add a structure'>+</a>"
			+ "<a href='#' class='str-paste' title='Paste a d-scan'>" + structures.icon("paste") + "</a></span></div>"
			+ "<div class='content'><div class='str-body'></div></div></li>";
	},

	/** The panel as panelHost (panel-host.js) takes it */
	panel: function() {
		return { id: structures.WIDGET_ID, title: "Structures", key: "structures", size: structures.SIZE };
	},

	addWidget: function() {
		if (structures.$widget().length) { return; }
		const $w = panelHost.addGridWidget(structures.panel(), structures.widgetHtml(), { remember: "structures",
			fallback: function(others, g) { return structures.defaultPlacement(others, panelHost.availableCols(g)); } });
		if ($w) { structures.renderPanel(); }
	},

	setView: function(view) {
		structures.view = view === "timers" ? "timers" : "system";
		if (view === "timers" && typeof forkUsage !== "undefined") { forkUsage.track("structureTimers", "opened"); }
		structures.editing = null; structures.moreID = null;
		if (structures.view === "timers" && typeof structureTimers !== "undefined") { structureTimers.fetchBoard(); }
		structures.redraw();
	},

	removeWidget: function() {
		panelHost.removeGridWidget(structures.panel(), structures.$widget(), { remember: "structures" });
	},

	sync: function() {
		if (!structures.enabled(structures.opts())) {
			structures.removeWidget();
			if (structures.xhr) { structures.xhr.abort(); structures.xhr = null; }
			if (typeof structureTimers !== "undefined") { structureTimers.renderInfo(); }
			return;
		}
		structures.addWidget();
		structures.setSystem(typeof viewingSystemID !== "undefined" ? viewingSystemID : null);
	},

	setSystem: function(systemID) {
		const id = parseInt(systemID, 10);
		if (id !== structures.systemID) {
			structures.systemID = structures.isSystem(id) ? id : null;
			structures.rows = []; structures.gone = []; structures.hash = ""; structures.loaded = false; structures.setRes = null; structures.setResAt = 0; structures.sugg = {};
			structures.editing = null; structures.moreID = null; structures.highlight = null; structures.showGone = false;
			structures.renderPanel();
			if (structures.systemID) { structures.fetchSetResidents(); }
		}
		structures.fetch();
	},

	// ---- d-scan dialog ----

	dlgChecked: {},
	dlgMaster: true,
	dlgText: "",

	/** Rows of the viewed system the dialog's merge preview compares with (null when the dialog is for another system) */
	existingForDialog: function() {
		const id = intelScans.dialogSystemID;
		if (id !== structures.systemID || !structures.loaded) { return null; }
		return structures.rows.concat(structures.gone.filter(function(r) { return r.state === "removed"; }));
	},

	dialogScan: function() {
		const $dialog = $("#" + intelScans.DIALOG_ID);
		const text = String($dialog.find(".intel-text").val() || "");
		const types = intelScans.types;
		if (!text.trim() || !types || intelScans.detectKind(text) !== "dscan") { return null; }
		const systemName = structures.systemName(intelScans.dialogSystemID);
		const scan = structures.parseScan(text, types, systemName);
		// A copied overview selection has the columns of the pilot's choice: when it gives more structures than the d-scan
		// reading (a real d-scan gives the same number, so it stays a d-scan), it is an overview
		const overview = structures.parseOverview(text, types, systemName);
		return overview.structures.length > scan.structures.length ? overview : scan;
	},

	renderDialogSection: function() {
		const $dialog = $("#" + intelScans.DIALOG_ID);
		if (!$dialog.length) { return; }
		$dialog.find(".str-dlg").remove();
		const $only = $dialog.parent().find(".str-save-only");
		$only.hide();
		// With the Intel panel turned off the dialog is only here to save structures: no scan is shared
		$dialog.parent().find(".intel-share").toggle(intelScans.enabled(intelScans.opts()));
		if (!structures.enabled(structures.opts())) { return; }
		const text = String($dialog.find(".intel-text").val() || "");
		if (text !== structures.dlgText) { structures.dlgText = text; structures.dlgChecked = {}; structures.dlgMaster = true; }
		const scan = structures.dialogScan();
		if (!scan || !scan.structures.length) { return; }
		if (scan.overview) { $dialog.parent().find(".intel-share").hide(); }	// an overview is not a d-scan: nothing to share with the Intel panel
		const view = structures.dialogHtml(scan, structures.existingForDialog(), structures.dlgChecked, structures.dlgMaster, structures.systemName(intelScans.dialogSystemID));
		$dialog.find(".intel-preview").append(view.html);
		$only.show().prop("disabled", view.saveCount === 0).toggleClass("ui-state-disabled", view.saveCount === 0);
	},

	/** Indexes of the checked structure rows of the open dialog, or [] */
	dialogKeep: function() {
		const $dialog = $("#" + intelScans.DIALOG_ID);
		if (!$dialog.find(".str-dlg-all").prop("checked")) { return []; }
		return $dialog.find(".str-dlg-row:checked").map(function() { return parseInt($(this).attr("data-i"), 10); }).get();
	},

	errorText: function(x, fallback) {
		return x && x.responseJSON && x.responseJSON.error ? x.responseJSON.error : fallback + (x && x.status ? " (HTTP " + x.status + ")" : "");
	},

	/** Save the checked structures of the dialog (server parses the text again); returns the request or null */
	saveFromDialog: function() {
		const keep = structures.dialogKeep();
		if (!keep.length) { return null; }
		const systemID = intelScans.dialogSystemID;
		const text = String($("#" + intelScans.DIALOG_ID).find(".intel-text").val() || "");
		const scan = structures.dialogScan();
		const params = { action: "scan", systemID: systemID, text: text, keep: JSON.stringify(keep), systemName: structures.systemName(systemID) };
		if (scan && scan.overview) { params.format = "overview"; }
		return structures.post(params).done(function(response) {
			if (response && response.systemID === structures.systemID) { structures.absorb(response); structures.redraw(); }
		});
	},

	wrapDialog: function() {
		if (typeof intelScans === "undefined" || intelScans.renderPreview.structuresWrapped) { return; }
		const renderPreview = intelScans.renderPreview;
		intelScans.renderPreview = function() {
			const result = renderPreview.apply(this, arguments);
			structures.renderDialogSection();
			return result;
		};
		intelScans.renderPreview.structuresWrapped = true;
		// The shared scan's own request failing leaves "Save structures only" disabled: refresh the buttons
		$(document).ajaxComplete(function(e, xhr, settings) {
			if (settings && settings.url === intelScans.URL && settings.type === "POST") {
				const $d = $("#" + intelScans.DIALOG_ID);
				if ($d.length && $d.dialog("isOpen")) { structures.renderDialogSection(); }
			}
		});
		const share = intelScans.share;
		intelScans.share = function() {
			const self = this, args = arguments;
			const $dialog = $("#" + intelScans.DIALOG_ID);
			const $buttons = $dialog.parent().find(".intel-share, .str-save-only");
			const req = structures.enabled(structures.opts()) ? structures.saveFromDialog() : null;
			if (!req) { return share.apply(self, args); }
			$buttons.prop("disabled", true).addClass("ui-state-disabled");
			// Structures first; a failure (limit, validation) stays in the dialog and nothing is shared
			req.done(function() {
				if ($dialog.dialog("isOpen")) { share.apply(self, args); }
			}).fail(function(x) {
				$dialog.find(".intel-error").text(structures.errorText(x, "Could not save the structures"));
				$buttons.prop("disabled", false).removeClass("ui-state-disabled");
			});
		};
		const openDialog = intelScans.openDialog;
		intelScans.openDialog = function() {
			const result = openDialog.apply(this, arguments);
			const $dialog = $("#" + intelScans.DIALOG_ID);
			if ($dialog.length && !$dialog.data("structuresWired")) {
				$dialog.data("structuresWired", true);
				const buttons = $dialog.dialog("option", "buttons");
				if (Array.isArray(buttons)) {
					buttons.unshift({ text: "Save structures only", "class": "str-save-only", click: function() {
						const req = structures.saveFromDialog();
						if (req) {
							const $buttons = $dialog.parent().find(".intel-share, .str-save-only");
							$buttons.prop("disabled", true).addClass("ui-state-disabled");
							req.done(function() { $dialog.dialog("close"); }).fail(function(x) {
								$dialog.find(".intel-error").text(structures.errorText(x, "Could not save the structures"));
								$buttons.prop("disabled", false).removeClass("ui-state-disabled");
							});
						}
					} });
					$dialog.dialog("option", "buttons", buttons);
				}
				$dialog.on("change", ".str-dlg-all", function() { structures.dlgMaster = $(this).prop("checked"); structures.renderDialogSection(); })
					.on("change", ".str-dlg-row", function() { structures.dlgChecked[parseInt($(this).attr("data-i"), 10)] = $(this).prop("checked"); structures.renderDialogSection(); });
			}
			$dialog.find(".intel-error").text("");
			structures.dlgText = "";
			structures.renderDialogSection();
			return result;
		};
	},

	// ---- Settings and init ----

	setupSettings: function() {
		// Settings > Kills & Intel; takes effect on Save, Reset deletes the key (on)
		forkSettings.register({
			section: "intel", order: 45, id: "structures-enabled", type: "checkbox", key: "structures",
			label: "Structures panel:", text: "Show the Structures panel (structures, owners and timers of the viewed system) and the d-scan save option",
			get: function(o) { return structures.enabled(o); },
			set: function(o, on) { o.structures = Object.assign({}, o.structures, { enabled: on }); }
		});
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.structuresWrapped) {
			const apply = options.apply;
			const wrappedApply = function() {
				const result = apply.apply(this, arguments);
				structures.sync();
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrappedApply[k] = apply[k]; });
			wrappedApply.structuresWrapped = true;
			options.apply = wrappedApply;
		}
	},

	init: function() {
		panelHost.register(structures.panel());
		structures.setupSettings();
		structures.wrapDialog();
		if (typeof tripwire !== "undefined" && typeof tripwire.systemChange === "function" && !tripwire.systemChange.structuresWrapped) {
			const systemChange = tripwire.systemChange;
			const wrapped = function(systemID) {
				const result = systemChange.apply(this, arguments);
				if (structures.enabled(structures.opts())) { structures.setSystem(systemID); }
				return result;
			};
			Object.keys(systemChange).forEach(function(k) { wrapped[k] = systemChange[k]; });
			wrapped.structuresWrapped = true;
			tripwire.systemChange = wrapped;
		}
		document.addEventListener("visibilitychange", function() {
			if (!document.hidden && structures.missed) { structures.missed = false; structures.fetch(); }
		});
		setInterval(structures.fetch, structures.POLL_MS);
		setInterval(structures.renderPanel, 20000);	// countdowns and ages move on between polls
		setInterval(function() { if (structures.view === "timers" && typeof structureTimers !== "undefined") { structureTimers.tick(); } }, 1000);
		structures.bindPanel();
		structures.sync();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { structures.init(); });
}
