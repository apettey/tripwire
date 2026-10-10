const intelScans = {
	// D-scan & local intel (fork-owned): pilots paste a directional scan or a local member list into the Intel dialog
	// (an explicit text box: there is no page-wide paste hook) and share it with the mask, pinned to a system. The
	// system info panel lists the system's scans as chips that expand to the full summary; chain map nodes with a fresh
	// scan get a small marker. Server: public/intel_scans.php (validates, normalises and stores the rows; the parse
	// here is only the preview). Static type data: public/intel/types.json (from ESI, built by intel/tools/).
	// Settings: options.intelScans = {enabled (missing = on), freshMinutes, gridKm}.
	// Keep `const intelScans` on the first line: the test helper strips it to define a global.
	URL: "intel_scans.php",
	TYPES_URL: "intel/types.json",
	POLL_MS: 30000,
	MAX_BYTES: 200000,	// same limits as intel/intel.inc.php
	MAX_LINES: 2000,
	FIELD_MAX: 100,
	AU_KM: 149597870.7,
	DEFAULT_FRESH_MINUTES: 15,
	DEFAULT_GRID_KM: 10000,
	MENU_COMMAND: "intelScanPaste",
	NAMES_SHOWN: 60,

	/** Ship classes in summary order (most dangerous first); key = shipClass in types.json */
	SHIP_CLASSES: [
		{ key: "titan", label: "Titans", one: "Titan", notable: true },
		{ key: "super", label: "Supercarriers", one: "Supercarrier", notable: true },
		{ key: "capital", label: "Capitals", one: "Capital", notable: true },
		{ key: "battleship", label: "Battleships", one: "Battleship" },
		{ key: "battlecruiser", label: "Battlecruisers", one: "Battlecruiser" },
		{ key: "t3c", label: "T3 cruisers", one: "T3 cruiser" },
		{ key: "hic", label: "HICs", one: "HIC", notable: true },
		{ key: "dictor", label: "Interdictors", one: "Interdictor", notable: true, short: "dictor", shorts: "dictors" },
		{ key: "logistics", label: "Logistics", one: "Logistics", notable: true, short: "logi", shorts: "logi" },
		{ key: "cruiser", label: "Cruisers", one: "Cruiser" },
		{ key: "t3d", label: "T3 destroyers", one: "T3 destroyer" },
		{ key: "destroyer", label: "Destroyers", one: "Destroyer" },
		{ key: "frigate", label: "Frigates", one: "Frigate" },
		{ key: "industrial", label: "Industrials", one: "Industrial" },
		{ key: "shuttle", label: "Shuttles", one: "Shuttle" },
		{ key: "ship", label: "Other ships", one: "Other ship" }
	],
	/** Everything else on d-scan, in summary order; key = kind in types.json (structure-like kinds are merged) */
	OTHER_KINDS: [
		{ key: "cyno", label: "Lit cynos", one: "Lit cyno", notable: true, short: "lit cyno", shorts: "lit cynos" },
		{ key: "pod", label: "Pods", one: "Pod" },
		{ key: "fighter", label: "Fighters", one: "Fighter" },
		{ key: "drone", label: "Drones", one: "Drone" },
		{ key: "structure", label: "Structures", one: "Structure" },
		{ key: "deployable", label: "Deployables", one: "Deployable" },
		{ key: "container", label: "Containers", one: "Container" },
		{ key: "celestial", label: "Celestials", one: "Celestial" },
		{ key: "unknown", label: "Unknown", one: "Unknown" }
	],
	STRUCTURE_KINDS: ["structure", "starbase", "sovereignty", "orbital", "station"],
	/** Deployables worth calling out: group name -> short label */
	NOTABLE_DEPLOYABLES: { "Mobile Warp Disruptor": ["bubble", "bubbles"], "Mobile Cyno Inhibitor": ["cyno inhibitor", "cyno inhibitors"] },

	// ---- Settings ----

	enabled: function(opts) {
		return !(opts && opts.intelScans && opts.intelScans.enabled === false);
	},

	/** Minutes a scan counts as fresh (chips and map markers); 1-1440 */
	freshMinutes: function(opts) {
		const v = parseInt(opts && opts.intelScans ? opts.intelScans.freshMinutes : NaN, 10);
		return v >= 1 && v <= 1440 ? v : intelScans.DEFAULT_FRESH_MINUTES;
	},

	/** On-grid range in km; 1-1000000 */
	gridKm: function(opts) {
		const v = parseInt(opts && opts.intelScans ? opts.intelScans.gridKm : NaN, 10);
		return v >= 1 && v <= 1000000 ? v : intelScans.DEFAULT_GRID_KM;
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	// ---- Parsing (preview; mirrors intel/intel.inc.php) ----

	detectKind: function(text) {
		return String(text || "").indexOf("\t") >= 0 ? "dscan" : "local";
	},

	// Same explicit classes as intel/intel.inc.php (JavaScript's \s and PCRE's \s differ on Unicode spaces)
	stripInvisible: function(value) {
		return String(value === undefined || value === null ? "" : value).replace(/[\x00-\x08\x0E-\x1F\x7F\p{Cf}]/gu, "");
	},

	trim: function(value) {
		return String(value).replace(/^[\t\n\x0B\f\r\p{Z}]+|[\t\n\x0B\f\r\p{Z}]+$/gu, "");
	},

	lines: function(text) {
		return String(text || "").split(/\r\n|\r|\n/).map(function(l) { return l.replace(/[ \x0B\0]+$/, ""); })
			.filter(function(l) { return intelScans.trim(intelScans.stripInvisible(l)) !== ""; });
	},

	cleanField: function(value) {
		const s = String(value === undefined || value === null ? "" : value).replace(/[\x00-\x1F\x7F\p{Cf}]/gu, "");
		return Array.from(intelScans.trim(s)).slice(0, intelScans.FIELD_MAX).join("");
	},

	/** Distance in km (0.1 km), or null for "-", empty, unreadable or impossible (beyond d-scan range) values */
	parseDistanceKm: function(value) {
		const km = intelScans.parseDistanceRaw(value);
		return km === null || km > 15 * intelScans.AU_KM ? null : km;
	},

	parseDistanceRaw: function(value) {
		const s = intelScans.trim(intelScans.stripInvisible(value).replace(/\p{Z}/gu, " "));
		if (s === "" || s === "-") { return null; }
		const m = /^([0-9][0-9 .,']*) *([^ 0-9][^ ]*)$/u.exec(s);
		if (!m) { return null; }
		let number = m[1].replace(/[ ']/g, "");
		const unit = m[2].replace(/\./g, "").toLowerCase();
		if (["m", "м", "米"].indexOf(unit) >= 0) { return Math.round(parseInt(number.replace(/\D/g, "") || "0", 10) / 100) / 10; }
		if (["km", "км", "公里", "千米"].indexOf(unit) >= 0) { return parseInt(number.replace(/\D/g, "") || "0", 10); }
		if (["au", "ae", "ua", "ае", "天文单位"].indexOf(unit) >= 0) {
			const decimal = Math.max(number.lastIndexOf("."), number.lastIndexOf(","));
			if (decimal >= 0) {
				const separators = (number.match(/[.,]/g) || []).length;
				const same = number.split(number[decimal]).length - 1;
				number = separators > 1 && same > 1 ? number.replace(/\D/g, "")
					: number.substring(0, decimal).replace(/\D/g, "") + "." + number.substring(decimal + 1).replace(/\D/g, "");
			}
			const v = Number(number);
			return isFinite(v) && number !== "" ? Math.round(v * intelScans.AU_KM * 10) / 10 : null;
		}
		return null;
	},

	/** {rows: [[typeID|null, typeName, name, km|null]], invalid} */
	parseDscan: function(text) {
		const rows = [];
		let invalid = 0;
		intelScans.lines(text).forEach(function(line) {
			const f = line.split("\t");
			let typeID, name, type, distance;
			const first = f.length >= 4 ? intelScans.trim(intelScans.stripInvisible(f[0])) : "";
			if (f.length >= 4 && /^[0-9]{1,10}$/.test(first)) {
				typeID = parseInt(first, 10); name = f[1]; type = f[2]; distance = f[3];
			} else if (f.length === 3) {
				typeID = null; name = f[0]; type = f[1]; distance = f[2];
			} else { invalid++; return; }
			type = intelScans.cleanField(type);
			if (type === "" || (typeID !== null && typeID <= 0)) { invalid++; return; }
			rows.push([typeID, type, intelScans.cleanField(name), intelScans.parseDistanceKm(distance)]);
		});
		return { rows: rows, invalid: invalid };
	},

	validCharacterName: function(name) {
		const length = Array.from(name).length;
		return length >= 3 && length <= 37 && /^[\p{L}\p{N}][\p{L}\p{N} .'_-]*$/u.test(name);
	},

	/** {names: [...] unique in paste order, invalid} */
	parseLocal: function(text) {
		const names = [];
		const seen = {};
		let invalid = 0;
		intelScans.lines(text).forEach(function(line) {
			const name = intelScans.trim(intelScans.stripInvisible(line)).replace(/[\t\n\x0B\f\r\p{Z}]+/gu, " ");
			if (!intelScans.validCharacterName(name)) { invalid++; return; }
			const key = name.toLowerCase();
			if (seen[key]) { return; }
			seen[key] = true;
			names.push(name);
		});
		return { names: names, invalid: invalid };
	},

	/** {kind, data} or {error} (same rules as the server) */
	parse: function(text) {
		if (typeof text !== "string") { return { error: "Nothing pasted" }; }
		const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : text.length;
		if (bytes > intelScans.MAX_BYTES) { return { error: "Too much text (at most " + Math.round(intelScans.MAX_BYTES / 1000) + " kB)" }; }
		if (!intelScans.lines(text).length) { return { error: "Nothing pasted" }; }
		if (intelScans.lines(text).length > intelScans.MAX_LINES) { return { error: "Too many lines (at most " + intelScans.MAX_LINES + ")" }; }
		const kind = intelScans.detectKind(text);
		if (kind === "dscan") {
			const data = intelScans.parseDscan(text);
			return data.rows.length ? { kind: kind, data: data } : { error: "No d-scan lines found (copy the d-scan results with Ctrl+A, Ctrl+C)" };
		}
		const data = intelScans.parseLocal(text);
		return data.names.length ? { kind: kind, data: data } : { error: "No character names found (copy the local member list, one name per line)" };
	},

	// ---- Summaries ----

	/** Type info {name, groupName, kind, shipClass, cyno} for a row, from the static data; null when unknown */
	typeInfo: function(typeID, typeName, types) {
		if (!types || !types.types) { return null; }
		let t = typeID !== null && typeID !== undefined ? types.types[String(typeID)] : null;
		if (!t && typeName) {
			if (!types.byName) {
				const byName = {};
				Object.keys(types.types).forEach(function(id) {
					const key = String(types.types[id][0]).toLowerCase();
					if (!byName[key]) { byName[key] = types.types[id]; }
				});
				Object.defineProperty(types, "byName", { value: byName, enumerable: false });
			}
			t = types.byName[String(typeName).toLowerCase()] || null;
		}
		if (!t) { return null; }
		const g = types.groups[String(t[1])];
		if (!g) { return null; }
		return { name: t[0], groupName: g[0], kind: g[1], shipClass: g[2] || "", cyno: !!t[2] };
	},

	/** Summary bucket key for a type: a ship class, "pod", or one of OTHER_KINDS */
	bucketFor: function(info) {
		if (!info) { return "unknown"; }
		if (info.kind === "ship") { return info.shipClass === "pod" ? "pod" : (info.shipClass || "ship"); }
		if (intelScans.STRUCTURE_KINDS.indexOf(info.kind) >= 0) { return "structure"; }
		if (["fighter", "drone", "deployable", "container", "cyno", "celestial"].indexOf(info.kind) >= 0) { return info.kind; }
		return "unknown";
	},

	/**
	 * Summary of d-scan rows.
	 * @return {total, ships, shipsOnGrid, shipsOffGrid, onGrid / offGrid / noDistance (all objects), buckets: [{key, label, one, count, onGrid,
	 *          ship, types: [{name, count}]}] (non-empty, in order), notable: [{key, label, count}], cyno: n,
	 *          structures: [{type, name, km}], deployables: [{type, name, km}], invalid}
	 */
	summarizeDscan: function(data, types, gridKm) {
		const rows = data && Array.isArray(data.rows) ? data.rows : [];
		const grid = gridKm > 0 ? gridKm : intelScans.DEFAULT_GRID_KM;
		const buckets = {};
		const out = { total: 0, ships: 0, shipsOnGrid: 0, shipsOffGrid: 0, onGrid: 0, offGrid: 0, noDistance: 0, buckets: [], notable: [], cyno: 0,
			structures: [], deployables: [], invalid: data && data.invalid ? data.invalid : 0 };
		const deployableNotes = {};
		rows.forEach(function(row) {
			if (!Array.isArray(row)) { return; }
			const typeID = row[0], pastedType = row[1], name = row[2];
			const km = typeof row[3] === "number" && isFinite(row[3]) ? row[3] : null;
			const info = intelScans.typeInfo(typeID, pastedType, types);
			const key = intelScans.bucketFor(info);
			const typeName = info ? info.name : String(pastedType || "?");
			const onGrid = km !== null && km <= grid;
			out.total++;
			if (km === null) { out.noDistance++; } else if (onGrid) { out.onGrid++; } else { out.offGrid++; }
			const b = buckets[key] || (buckets[key] = { key: key, count: 0, onGrid: 0, typeCounts: {} });
			b.count++;
			if (onGrid) { b.onGrid++; }
			b.typeCounts[typeName] = (b.typeCounts[typeName] || 0) + 1;
			if (info && info.kind === "ship" && key !== "pod") {
				out.ships++;
				if (onGrid) { out.shipsOnGrid++; } else if (km !== null) { out.shipsOffGrid++; }
				if (info.cyno) { out.cyno++; }
			}
			if (key === "structure") { out.structures.push({ type: typeName, name: String(name || ""), km: km }); }
			if (key === "deployable") {
				out.deployables.push({ type: typeName, name: String(name || ""), km: km });
				if (info && intelScans.NOTABLE_DEPLOYABLES[info.groupName]) {
					deployableNotes[info.groupName] = (deployableNotes[info.groupName] || 0) + 1;
				}
			}
		});
		intelScans.SHIP_CLASSES.concat(intelScans.OTHER_KINDS).forEach(function(c) {
			const b = buckets[c.key];
			if (!b) { return; }
			out.buckets.push({
				key: c.key, label: c.label, one: c.one, count: b.count, onGrid: b.onGrid,
				ship: intelScans.OTHER_KINDS.every(function(o) { return o.key !== c.key; }),
				types: Object.keys(b.typeCounts).map(function(n) { return { name: n, count: b.typeCounts[n] }; })
					.sort(function(a, z) { return z.count - a.count || (a.name < z.name ? -1 : a.name > z.name ? 1 : 0); })
			});
			if (c.notable) {
				out.notable.push({ key: c.key, label: b.count === 1 ? (c.short || c.one) : (c.shorts || c.label), count: b.count });
			}
		});
		Object.keys(deployableNotes).forEach(function(g) {
			const words = intelScans.NOTABLE_DEPLOYABLES[g];
			out.notable.push({ key: g, label: deployableNotes[g] === 1 ? words[0] : words[1], count: deployableNotes[g] });
		});
		// A lit cyno is the most urgent call-out
		out.notable.sort(function(a, z) { return (z.key === "cyno") - (a.key === "cyno"); });
		const byDistance = function(a, z) { return (a.km === null ? Infinity : a.km) - (z.km === null ? Infinity : z.km); };
		out.structures.sort(byDistance);
		out.deployables.sort(byDistance);
		return out;
	},

	/** {count, names, invalid} */
	summarizeLocal: function(data) {
		const names = data && Array.isArray(data.names) ? data.names.map(String) : [];
		return { count: names.length, names: names, invalid: data && data.invalid ? data.invalid : 0 };
	},

	summarize: function(scan, types, gridKm) {
		if (!scan) { return null; }
		return scan.kind === "local" ? intelScans.summarizeLocal(scan.data) : intelScans.summarizeDscan(scan.data, types, gridKm);
	},

	// ---- Text ----

	/** "just now", "4 min ago", "2 h ago" */
	ago: function(seconds) {
		const s = Math.max(0, Math.floor(Number(seconds) || 0));
		if (s < 60) { return "just now"; }
		if (s < 3600) { return Math.floor(s / 60) + " min ago"; }
		return Math.floor(s / 3600) + " h ago";
	},

	plural: function(n, one, many) {
		return n + " " + (n === 1 ? one : many);
	},

	/** "1,234 km", "4.2 AU", "–" */
	formatDistance: function(km) {
		if (km === null || km === undefined || !isFinite(km)) { return "–"; }
		if (km >= 0.1 * intelScans.AU_KM) { return (Math.round(km / intelScans.AU_KM * 10) / 10) + " AU"; }
		if (km < 1) { return Math.round(km * 1000) + " m"; }
		return String(Math.round(km)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " km";
	},

	/** Plain-text parts of a chip: ["D-scan", "2 min ago", "14 ships (3 on grid)", "1 HIC"] */
	chipParts: function(scan, summary) {
		const parts = [scan.kind === "local" ? "Local" : "D-scan", intelScans.ago(scan.age)];
		if (!summary) { return parts; }
		if (scan.kind === "local") {
			parts.push(intelScans.plural(summary.count, "pilot", "pilots"));
			return parts;
		}
		parts.push(intelScans.plural(summary.ships, "ship", "ships") + (summary.ships && summary.shipsOnGrid ? " (" + summary.shipsOnGrid + " on grid)" : ""));
		summary.notable.slice(0, 3).forEach(function(n) { parts.push(n.count + " " + n.label); });
		if (!summary.ships && summary.structures.length) { parts.push(intelScans.plural(summary.structures.length, "structure", "structures")); }
		return parts;
	},

	/** Chip markup (escaped) */
	chipHtml: function(scan, summary, fresh, open) {
		const esc = intelScans.escape;
		const parts = intelScans.chipParts(scan, summary);
		return "<button type='button' class='intel-chip intel-" + (scan.kind === "local" ? "local" : "dscan") + (fresh ? "" : " intel-stale")
			+ (open ? " intel-open" : "") + "' data-scan='" + esc(scan.id) + "' aria-expanded='" + (open ? "true" : "false") + "'"
			+ " title='" + esc("Shared by " + (scan.createdBy || "unknown") + ". Click for the full summary.") + "'>"
			+ "<b>" + esc(parts[0]) + "</b> " + esc(parts.slice(1).join(" · ")) + "</button>";
	},

	/** Full summary markup (escaped); preview: without the "shared by" line (paste dialog) */
	detailHtml: function(scan, summary, gridKm, preview) {
		const esc = intelScans.escape;
		const f = intelScans.formatDistance;
		let html = "<div class='intel-detail" + (preview ? " intel-detail-preview" : "") + "' data-scan='" + esc(scan.id) + "'>";
		if (!preview) html += "<div class='intel-detail-head'>" + esc((scan.kind === "local" ? "Local" : "D-scan") + " shared by " + (scan.createdBy || "unknown") + ", " + intelScans.ago(scan.age))
			+ (scan.mine ? " <a href='#' class='intel-delete' data-scan='" + esc(scan.id) + "' title='Delete this scan for everyone'>delete</a>" : "") + "</div>";
		if (!summary) { return html + "<div class='intel-muted'>loading…</div></div>"; }
		if (scan.kind === "local") {
			html += "<div>" + esc(intelScans.plural(summary.count, "pilot", "pilots")) + "</div>";
			const shown = summary.names.slice(0, intelScans.NAMES_SHOWN);
			html += "<div class='intel-names'>" + shown.map(esc).join(", ")
				+ (summary.names.length > shown.length ? " <span class='intel-muted'>and " + (summary.names.length - shown.length) + " more</span>" : "") + "</div>";
			if (summary.invalid) { html += "<div class='intel-muted'>" + esc(intelScans.plural(summary.invalid, "line", "lines")) + " not understood</div>"; }
			return html + "</div>";
		}
		const shipsNoDistance = summary.ships - summary.shipsOnGrid - summary.shipsOffGrid;
		html += "<div>" + esc(intelScans.plural(summary.ships, "ship", "ships") + ": " + summary.shipsOnGrid + " on grid (≤ " + f(gridKm) + "), "
			+ summary.shipsOffGrid + " off grid" + (shipsNoDistance ? ", " + shipsNoDistance + " without distance" : "")
			+ " · " + intelScans.plural(summary.total, "object", "objects") + " in total") + "</div>";
		if (summary.cyno) {
			html += "<div class='intel-warn' title='Hulls that can fit a normal, covert or industrial cyno; the fit itself is unknown'>"
				+ esc(intelScans.plural(summary.cyno, "hull", "hulls") + " that can fit a cyno") + "</div>";
		}
		html += "<table class='intel-table'>";
		summary.buckets.forEach(function(b) {
			if (b.key === "structure" || b.key === "deployable") { return; }	// listed by name below
			const notable = summary.notable.some(function(n) { return n.key === b.key; });
			html += "<tr" + (notable ? " class='intel-notable'" : "") + "><th>" + esc(b.label) + "</th><td class='intel-count'>" + esc(b.count) + "</td>"
				+ "<td class='intel-grid'>" + (b.onGrid ? esc(b.onGrid === b.count ? "on grid" : b.onGrid + " on grid") : "") + "</td>"
				+ "<td class='intel-types'>" + b.types.map(function(t) { return esc(t.name) + (t.count > 1 ? " ×" + esc(t.count) : ""); }).join(", ") + "</td></tr>";
		});
		html += "</table>";
		const list = function(title, items) {
			if (!items.length) { return ""; }
			return "<div class='intel-sub'>" + esc(title) + " (" + items.length + ")</div><ul class='intel-list'>" + items.map(function(s) {
				return "<li><span class='intel-type'>" + esc(s.type) + "</span>" + (s.name && s.name !== s.type ? " " + esc(s.name) : "")
					+ " <span class='intel-muted'>" + esc(f(s.km)) + "</span></li>";
			}).join("") + "</ul>";
		};
		html += list("Structures", summary.structures);
		html += list("Deployables", summary.deployables);
		if (summary.invalid) { html += "<div class='intel-muted'>" + esc(intelScans.plural(summary.invalid, "line", "lines")) + " not understood</div>"; }
		return html + "</div>";
	},

	/** Marker tooltip/letters for a system's latest ages {dscan, local} within the fresh window; null when nothing fresh */
	markerFor: function(latest, freshSeconds) {
		if (!latest) { return null; }
		const fresh = function(k) { return typeof latest[k] === "number" && latest[k] < freshSeconds; };
		const d = fresh("dscan"), l = fresh("local");
		if (!d && !l) { return null; }
		const lines = [];
		if (d) { lines.push("D-scan " + intelScans.ago(latest.dscan)); }
		if (l) { lines.push("Local " + intelScans.ago(latest.local)); }
		return { text: (d ? "D" : "") + (l ? "L" : ""), title: lines.join("\n") };
	},

	markerHtml: function(marker) {
		if (!marker) { return ""; }
		return "<span class='intel-marker' title='" + intelScans.escape(marker.title) + "'>" + intelScans.escape(marker.text) + "</span>";
	},

	/** Insert marker markup into a chain node's HTML as the node's first child */
	insertMarker: function(nodeHtml, marker) {
		if (!marker || typeof nodeHtml !== "string" || nodeHtml.indexOf("intel-marker") >= 0) { return nodeHtml; }
		const at = nodeHtml.indexOf("<div class='nodeIcons'>");
		if (at < 0) { return nodeHtml; }
		return nodeHtml.substring(0, at) + marker + nodeHtml.substring(at);
	},

	isSystem: function(systemID) {
		const id = parseInt(systemID, 10);
		return id >= 30000000 && id < 33000000;
	},

	// ---- Browser state ----

	types: null,
	typesXhr: null,
	latest: {},	// systemID => {dscan: age, local: age} at latestAt
	latestAt: 0,
	scans: [],	// scans of the viewed system, ages as of scansAt
	scansAt: 0,
	scansSystemID: null,
	openScanID: null,
	showOlder: false,

	opts: function() { return typeof options !== "undefined" ? options : null; },

	loadTypes: function() {
		if (intelScans.types || intelScans.typesXhr) { return; }
		intelScans.typesXhr = $.ajax({ url: intelScans.TYPES_URL, dataType: "JSON", cache: true, timeout: 20000 })
			.done(function(data) { intelScans.types = data; intelScans.renderInfo(); intelScans.renderPreview(); })
			.always(function() { intelScans.typesXhr = null; });
	},

	/** Latest ages as of now */
	latestNow: function() {
		const shift = Math.floor((Date.now() - intelScans.latestAt) / 1000);
		const out = {};
		Object.keys(intelScans.latest).forEach(function(id) {
			const e = intelScans.latest[id];
			out[id] = {};
			Object.keys(e).forEach(function(k) { out[id][k] = e[k] + shift; });
		});
		return out;
	},

	markerForSystem: function(systemID) {
		const opts = intelScans.opts();
		if (!intelScans.enabled(opts)) { return null; }
		return intelScans.markerFor(intelScans.latestNow()[String(systemID)], intelScans.freshMinutes(opts) * 60);
	},

	/**
	 * Fill in the rows of scans the server left out (it sends `data` only for IDs not in `have`; scans never change).
	 * @param cache {id: data} of earlier responses
	 * @return {scans (with data where known), cache (only the listed scans), missing (IDs without rows)}
	 */
	mergeScans: function(scans, cache) {
		const next = {};
		const missing = [];
		const out = (Array.isArray(scans) ? scans : []).map(function(s) {
			const id = String(s.id);
			const data = s.data !== undefined ? s.data : (cache && Object.prototype.hasOwnProperty.call(cache, id) ? cache[id] : undefined);
			if (data === undefined) { missing.push(s.id); return s; }
			next[id] = data;
			return Object.assign({}, s, { data: data });
		});
		return { scans: out, cache: next, missing: missing };
	},

	dataCache: {},	// scan id => rows

	/** The `have` parameter: IDs whose rows the browser keeps */
	haveParam: function() {
		return Object.keys(intelScans.dataCache).slice(0, 60).join(",");
	},

	absorb: function(response) {
		if (!response) { return; }
		if (response.latest) { intelScans.latest = response.latest; intelScans.latestAt = Date.now(); }
		if (Array.isArray(response.scans) && String(response.systemID) === String(intelScans.scansSystemID)) {
			const merged = intelScans.mergeScans(response.scans, intelScans.dataCache);
			intelScans.scans = merged.scans;
			intelScans.dataCache = merged.cache;
			intelScans.scansAt = Date.now();
			if (merged.missing.length && !intelScans.refetched) {
				// Rows the server thought we had (should not happen): ask once more without `have`
				intelScans.refetched = true;
				setTimeout(intelScans.fetch, 0);
			} else {
				intelScans.refetched = false;
			}
		}
	},

	fetch: function() {
		if (!intelScans.enabled(intelScans.opts())) { return; }
		if (document.hidden) { intelScans.missed = true; return; }
		if (intelScans.xhr) { intelScans.xhr.abort(); }
		const data = intelScans.isSystem(intelScans.scansSystemID) ? { systemID: intelScans.scansSystemID } : {};
		if (data.systemID && !intelScans.refetched) { data.have = intelScans.haveParam(); }
		const xhr = $.ajax({ url: intelScans.URL, type: "GET", data: data, dataType: "JSON", cache: false, timeout: 15000 });
		intelScans.xhr = xhr;
		xhr.done(function(response) {
			intelScans.error = "";
			intelScans.absorb(response);
			intelScans.patchChain();
			intelScans.renderInfo();
		}).fail(function(x, status) {
			if (status === "abort") { return; }
			intelScans.error = "Could not load scans" + (x && x.status ? " (HTTP " + x.status + ")" : "");
			intelScans.renderInfo();
		}).always(function() {
			if (intelScans.xhr === xhr) { intelScans.xhr = null; }
		});
	},

	post: function(params) {
		if (params.systemID !== undefined && String(params.systemID) === String(intelScans.scansSystemID)) {
			params = Object.assign({ have: intelScans.haveParam() }, params);
		}
		return $.ajax({ url: intelScans.URL, type: "POST", data: params, dataType: "JSON", timeout: 20000,
			headers: { "X-Requested-With": "XMLHttpRequest" } });
	},

	// ---- Chain map ----

	patchChain: function() {
		$("#chainMap .node[data-nodeid]").each(function() {
			const $node = $(this);
			$node.children(".intel-marker").remove();
			if ($node.closest(".destination-node").length) { return; }
			const marker = intelScans.markerHtml(intelScans.markerForSystem(parseInt($node.attr("data-nodeid"), 10)));
			if (marker) { $node.prepend(marker); }
		});
	},

	install: function(chainObj) {
		if (!chainObj || typeof chainObj.nodes !== "function" || chainObj.nodes.intelScansWrapped) { return; }
		const previous = chainObj.nodes;
		const wrapped = function() {
			const result = previous.apply(this, arguments);
			try {
				const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
				rows.forEach(function(row) {
					const node = row && row.c && row.c[0];
					if (!node || typeof node.f !== "string" || String(node.v).indexOf("dest-") === 0 || !intelScans.isSystem(node.systemID)) { return; }
					node.f = intelScans.insertMarker(node.f, intelScans.markerHtml(intelScans.markerForSystem(node.systemID)));
				});
			} catch (e) {
				if (typeof console !== "undefined") { console.warn("intel-scans: could not decorate the chain", e); }
			}
			return result;
		};
		wrapped.intelScansWrapped = true;
		chainObj.nodes = wrapped;
	},

	setupMenu: function() {
		try {
			const chainParent = $("#chainParent");
			if (!$("#chainMenu").length || !chainParent.length) { return; }
			$("#chainMenu").append("<li data-command='" + intelScans.MENU_COMMAND + "'><a id='intelScanMenuItem'>Paste d-scan / local</a></li>");
			$("#chainMenu").menu("refresh");
			const originalSelect = chainParent.contextmenu("option", "select");
			chainParent.contextmenu("option", "select", function(e, ui) {
				if (ui.cmd === intelScans.MENU_COMMAND) {
					intelScans.openDialog(parseInt($(ui.target[0]).closest("[data-nodeid]").data("nodeid"), 10));
					return;
				}
				return originalSelect ? originalSelect.apply(this, arguments) : undefined;
			});
			const originalBeforeOpen = chainParent.contextmenu("option", "beforeOpen");
			chainParent.contextmenu("option", "beforeOpen", function(e, ui) {
				try {
					const systemID = $(ui.target[0]).closest("[data-nodeid]").data("nodeid");
					$(this).contextmenu("showEntry", intelScans.MENU_COMMAND, intelScans.enabled(intelScans.opts()) && intelScans.isSystem(systemID)
						&& !$(ui.target[0]).closest(".destination-node").length);
				} catch (err) { console.error("intel-scans: menu update failed", err); }
				return originalBeforeOpen ? originalBeforeOpen.apply(this, arguments) : undefined;
			});
		} catch (e) { console.error("intel-scans: context menu setup failed", e); }
	},

	// ---- System info panel ----

	$info: function() { return $("#intelScansInfo"); },

	systemName: function(systemID) {
		const systems = typeof tripwire !== "undefined" && tripwire.systems ? tripwire.systems : (typeof appData !== "undefined" ? appData.systems : null);
		const s = systems ? systems[systemID] : null;
		return s && s.name ? s.name : String(systemID);
	},

	syncInfo: function() {
		if (!intelScans.enabled(intelScans.opts())) {
			intelScans.$info().remove();
			return;
		}
		if (!intelScans.$info().length) {
			const $before = $("#infoWidget #activityGraph");
			if (!$before.length) { return; }
			$before.before("<div id='intelScansInfo' class='intel-info'></div>");
			intelScans.$info().on("click", ".intel-paste", function(e) {
				e.preventDefault();
				intelScans.openDialog(intelScans.scansSystemID);
			}).on("click", ".intel-chip", function() {
				const id = parseInt($(this).attr("data-scan"), 10);
				intelScans.openScanID = intelScans.openScanID === id ? null : id;
				intelScans.renderInfo();
			}).on("click", ".intel-older", function(e) {
				e.preventDefault();
				intelScans.showOlder = !intelScans.showOlder;
				intelScans.renderInfo();
			}).on("click", ".intel-delete", function(e) {
				e.preventDefault();
				const id = parseInt($(this).attr("data-scan"), 10);
				if (!window.confirm("Delete this scan for everyone on the mask?")) { return; }
				intelScans.post({ mode: "delete", id: id, systemID: intelScans.scansSystemID }).done(function(response) {
					intelScans.absorb(response);
					intelScans.patchChain();
					intelScans.renderInfo();
				});
			});
		}
		intelScans.setSystem(typeof viewingSystemID !== "undefined" ? viewingSystemID : null);
	},

	setSystem: function(systemID) {
		const id = parseInt(systemID, 10);
		if (id !== intelScans.scansSystemID) {
			intelScans.scansSystemID = intelScans.isSystem(id) ? id : null;
			intelScans.scans = [];
			intelScans.openScanID = null;
			intelScans.showOlder = false;
			intelScans.renderInfo();
		}
		intelScans.fetch();
	},

	renderInfo: function() {
		const $info = intelScans.$info();
		if (!$info.length) { return; }
		if (!intelScans.scansSystemID) { $info.empty(); return; }
		const opts = intelScans.opts();
		const freshSeconds = intelScans.freshMinutes(opts) * 60;
		const gridKm = intelScans.gridKm(opts);
		const shift = Math.floor((Date.now() - intelScans.scansAt) / 1000);
		const scans = intelScans.scans.map(function(s) { return Object.assign({}, s, { age: s.age + shift }); });
		if (scans.some(function(s) { return s.kind === "dscan"; })) { intelScans.loadTypes(); }
		const fresh = scans.filter(function(s) { return s.age < freshSeconds; });
		const older = scans.filter(function(s) { return s.age >= freshSeconds; });
		const shown = intelScans.showOlder ? scans : fresh;
		let html = "<div class='intel-head'><span class='intel-label'>Intel</span> "
			+ "<a href='#' class='intel-paste' title='Paste a directional scan or the local member list and share a summary with your mask'>Paste d-scan / local</a>"
			+ (older.length ? " <a href='#' class='intel-older'>" + (intelScans.showOlder ? "hide older" : intelScans.escape("older (" + older.length + ")")) + "</a>" : "")
			+ "</div>";
		if (intelScans.error) { html += "<div class='intel-muted'>" + intelScans.escape(intelScans.error) + "</div>"; }
		if (shown.length) {
			html += "<div class='intel-chips'>";
			shown.forEach(function(s) {
				const summary = s.data !== undefined && (s.kind === "local" || intelScans.types) ? intelScans.summarize(s, intelScans.types, gridKm) : null;
				const open = s.id === intelScans.openScanID;
				html += intelScans.chipHtml(s, summary, s.age < freshSeconds, open);
				if (open) { html += intelScans.detailHtml(s, summary, gridKm); }
			});
			html += "</div>";
		}
		$info.html(html);
	},

	// ---- Paste dialog ----

	DIALOG_ID: "dialog-intelScan",

	openDialog: function(systemID) {
		const id = parseInt(systemID, 10);
		if (!intelScans.isSystem(id)) { return; }
		intelScans.loadTypes();
		let $dialog = $("#" + intelScans.DIALOG_ID);
		if (!$dialog.length) {
			$dialog = $("<div id='" + intelScans.DIALOG_ID + "' class='intel-dialog'>"
				+ "<p class='intel-help'>Copy the d-scan results (click a result, Ctrl+A, Ctrl+C) or the local member list, and paste it here (Ctrl+V). It is shared with your mask, pinned to this system.</p>"
				+ "<textarea class='intel-text' rows='9' spellcheck='false' autocomplete='off' placeholder='Paste d-scan or local here'></textarea>"
				+ "<div class='intel-preview'></div><div class='intel-error'></div></div>").appendTo("body");
			$dialog.dialog({
				autoOpen: false,
				resizable: false,
				modal: true,
				width: 440,
				dialogClass: "dialog-noeffect ui-dialog-shadow dialog-intelScan",
				buttons: [
					{ text: "Share", "class": "intel-share", click: function() { intelScans.share(); } },
					{ text: "Cancel", click: function() { $(this).dialog("close"); } }
				],
				open: function() { $(this).find(".intel-text").trigger("focus"); }
			});
			let timer = null;
			$dialog.on("input", ".intel-text", function() {
				clearTimeout(timer);
				timer = setTimeout(intelScans.renderPreview, 150);
			});
		}
		intelScans.dialogSystemID = id;
		$dialog.find(".intel-text").val("");
		$dialog.find(".intel-error").text("");
		$dialog.dialog("option", "title", "Paste d-scan / local: " + intelScans.systemName(id));
		intelScans.renderPreview();
		$dialog.dialog("open");
	},

	renderPreview: function() {
		const $dialog = $("#" + intelScans.DIALOG_ID);
		if (!$dialog.length) { return; }
		const text = String($dialog.find(".intel-text").val() || "");
		const $share = $dialog.parent().find(".intel-share");
		const $preview = $dialog.find(".intel-preview");
		if (!text.trim()) {
			$preview.html("<span class='intel-muted'>Nothing pasted yet.</span>");
			$share.prop("disabled", true).addClass("ui-state-disabled");
			return;
		}
		const parsed = intelScans.parse(text);
		$share.prop("disabled", !!parsed.error).toggleClass("ui-state-disabled", !!parsed.error);
		if (parsed.error) { $preview.html("<span class='intel-warn'>" + intelScans.escape(parsed.error) + "</span>"); return; }
		const scan = { id: 0, kind: parsed.kind, data: parsed.data, age: 0, createdBy: "you" };
		const gridKm = intelScans.gridKm(intelScans.opts());
		const summary = parsed.kind === "local" || intelScans.types ? intelScans.summarize(scan, intelScans.types, gridKm) : null;
		const parts = intelScans.chipParts(scan, summary);
		$preview.html("<div><b>" + intelScans.escape(parts[0]) + "</b> " + intelScans.escape(parts.slice(2).join(" · ")) + "</div>"
			+ (summary ? intelScans.detailHtml(scan, summary, gridKm, true) : ""));
	},

	share: function() {
		const $dialog = $("#" + intelScans.DIALOG_ID);
		const text = String($dialog.find(".intel-text").val() || "");
		const systemID = intelScans.dialogSystemID;
		const parsed = intelScans.parse(text);
		if (parsed.error || !intelScans.isSystem(systemID)) { return; }
		const $share = $dialog.parent().find(".intel-share").prop("disabled", true).addClass("ui-state-disabled");
		intelScans.post({ mode: "add", systemID: systemID, text: text }).done(function(response) {
			if (String(systemID) === String(intelScans.scansSystemID)) {
				intelScans.absorb(response);
				intelScans.openScanID = response && response.added ? response.added : null;
			} else if (response && response.latest) {
				intelScans.latest = response.latest;
				intelScans.latestAt = Date.now();
			}
			$dialog.dialog("close");
			intelScans.patchChain();
			intelScans.renderInfo();
		}).fail(function(x) {
			const message = x && x.responseJSON && x.responseJSON.error ? x.responseJSON.error : "Could not share the scan" + (x && x.status ? " (HTTP " + x.status + ")" : "");
			$dialog.find(".intel-error").text(message);
			$share.prop("disabled", false).removeClass("ui-state-disabled");
		});
	},

	// ---- Settings ----

	setupSettings: function() {
		const $general = $("#dialog-options #optionsAccordion > div").eq(2).find("table.optionsTable").first();
		if ($general.length && !$("#intelScans-enabled").length) {
			$general.append("<tr><th>D-scan &amp; local intel:</th><td>"
				+ "<label><input type='checkbox' id='intelScans-enabled' /> Show shared scans and the paste button</label><br/>"
				+ "<label>Fresh for <input type='number' id='intelScans-fresh' min='1' max='1440' style='width: 4em;' /> min</label>, "
				+ "<label>on grid within <input type='number' id='intelScans-grid' min='1' max='1000000' style='width: 6em;' /> km</label></td></tr>");
		}
		$(document).on("dialogopen", "#dialog-options", function() {
			const opts = intelScans.opts();
			$("#intelScans-enabled").prop("checked", intelScans.enabled(opts));
			$("#intelScans-fresh").val(intelScans.freshMinutes(opts));
			$("#intelScans-grid").val(intelScans.gridKm(opts));
		});
		// Capture phase so the values are in place before upstream's Save handler runs options.apply() and saves
		document.addEventListener("click", function(e) {
			const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
			if (!button || $.trim($(button).text()) !== "Save") { return; }
			if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#intelScans-enabled").length) { return; }
			const settings = { enabled: $("#intelScans-enabled").prop("checked") };
			const fresh = parseInt($("#intelScans-fresh").val(), 10);
			const grid = parseInt($("#intelScans-grid").val(), 10);
			if (fresh >= 1 && fresh <= 1440) { settings.freshMinutes = fresh; }
			if (grid >= 1 && grid <= 1000000) { settings.gridKm = grid; }
			options.intelScans = settings;
		}, true);

		// Settings > Reset: a missing key means on with the defaults
		if (typeof options !== "undefined" && typeof options.reset === "function" && !options.reset.intelScansWrapped) {
			const reset = options.reset;
			const wrapped = function() {
				const result = reset.apply(this, arguments);
				delete this.intelScans;
				return result;
			};
			Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
			wrapped.intelScansWrapped = true;
			options.reset = wrapped;
		}
		// options.apply() runs on Save and Reset
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.intelScansWrapped) {
			const apply = options.apply;
			const wrappedApply = function() {
				const result = apply.apply(this, arguments);
				intelScans.syncInfo();
				intelScans.patchChain();
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrappedApply[k] = apply[k]; });
			wrappedApply.intelScansWrapped = true;
			options.apply = wrappedApply;
		}
	},

	init: function() {
		intelScans.setupSettings();
		intelScans.setupMenu();
		if (typeof tripwire !== "undefined" && typeof tripwire.systemChange === "function" && !tripwire.systemChange.intelScansWrapped) {
			const systemChange = tripwire.systemChange;
			const wrapped = function(systemID) {
				const result = systemChange.apply(this, arguments);
				if (intelScans.$info().length) { intelScans.setSystem(systemID); }
				return result;
			};
			Object.keys(systemChange).forEach(function(k) { wrapped[k] = systemChange[k]; });
			wrapped.intelScansWrapped = true;
			tripwire.systemChange = wrapped;
		}
		document.addEventListener("visibilitychange", function() {
			if (!document.hidden && intelScans.missed) { intelScans.missed = false; intelScans.fetch(); }
		});
		setInterval(intelScans.fetch, intelScans.POLL_MS);
		// Ages in chips and markers move on between polls
		setInterval(function() { intelScans.renderInfo(); intelScans.patchChain(); }, intelScans.POLL_MS);
		intelScans.syncInfo();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	if (typeof chain !== "undefined") { intelScans.install(chain); }
	$(function() {
		if (typeof chain !== "undefined") { intelScans.install(chain); }
		intelScans.init();
	});
}
