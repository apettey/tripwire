const forkLegend = {
	// Map key (fork feature): a button in the chain map header opens a panel that explains what the map can show, each
	// entry with a live sample built from the classes and functions the map itself uses, one plain line, and where in
	// Settings it is switched off. Shows the entries whose feature is on for this user; "Show all" lists every one.
	// Setting: options.mapLegend.enabled (missing = on) hides the button. Keep `const forkLegend` on the first line:
	// the test helper only turns the first `const` into a global.
	//
	// A feature that draws something on the chain map adds its own entry (from its own file, at DOM ready, so this file
	// has loaded whatever the script order):
	//   if (typeof forkLegend !== "undefined") { forkLegend.register({
	//     id: "sizeTags",                  unique id
	//     group: "connectionMarks",        systems | connections | systemMarks | connectionMarks (GROUPS)
	//     order: 10,                       position within the group (lower first)
	//     title: "Hole size tags",         plain text
	//     text: "Largest ship ...",        one plain-language line (plain text)
	//     sample: function() { return html; },   markup built from the map's own classes / the feature's own markup
	//                                      functions (forkLegend.node / line / chips help); called on every open
	//     settingId: "sizeTags-enabled",   optional: the forkSettings row that turns it off. A checkbox row's get(options)
	//                                      decides whether the entry is on; its section and label say where to turn it off
	//     enabled: function(options) {},   optional: whether it is on (instead of the row's checkbox; custom rows)
	//     where: "..."                     optional: plain text instead of "Settings > <section> > <row label>"
	//   }); }
	// Every Map Markers Settings row needs an entry with its settingId, or a line in WAIVERS saying why not
	// (app/js-test/fork/map-legend.test.js checks it).

	GROUPS: [
		{ key: "systems", title: "Systems" },
		{ key: "connections", title: "Connections" },
		{ key: "systemMarks", title: "Marks on systems" },
		{ key: "connectionMarks", title: "Marks on connections" }
	],

	// Map Markers Settings rows with no legend entry: "<row id>": "why"
	WAIVERS: {},

	BUTTON_ID: "map-key-button",
	PANEL_ID: "map-key",
	SAMPLE_ROOT_ID: "map-key-map",	// stands in for #chainMap: the map's #chainMap rules are copied for it (scopedCss)
	MAP_ID: "chainMap",
	LINE_SCALE: 1.5,	// sample connections are drawn this much larger than on the map

	entries: [],
	seq: 0,
	showAll: false,

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** Whether the Map key button is on in the given user options (options.mapLegend.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.mapLegend && opts.mapLegend.enabled === false);
	},

	group: function(key) {
		return forkLegend.GROUPS.filter(function(g) { return g.key === key; })[0] || null;
	},

	/** Check and complete an entry; throws on a mistake so it shows up in development */
	normalize: function(def) {
		if (!def || typeof def !== "object") { throw new Error("forkLegend.register: definition object required"); }
		const name = "forkLegend.register(" + (def.id || "?") + "): ";
		if (!def.id || typeof def.id !== "string") { throw new Error(name + "id is required"); }
		if (!forkLegend.group(def.group)) { throw new Error(name + "group must be one of " + forkLegend.GROUPS.map(function(g) { return g.key; }).join(", ")); }
		if (!def.title || !def.text) { throw new Error(name + "title and text are required"); }
		if (typeof def.sample !== "function" && typeof def.sample !== "string") { throw new Error(name + "sample (function or markup) is required"); }
		if (def.enabled !== undefined && typeof def.enabled !== "function") { throw new Error(name + "enabled must be a function"); }
		const entry = Object.assign({}, def);
		entry.order = typeof def.order === "number" ? def.order : 1000;
		entry.seq = forkLegend.seq++;
		return entry;
	},

	/** Add an entry (see the top of this file). A second entry with the same id is ignored. */
	register: function(def) {
		const entry = forkLegend.normalize(def);
		const existing = forkLegend.entries.filter(function(e) { return e.id === entry.id; })[0];
		if (existing) {
			console.warn("forkLegend.register(" + entry.id + "): already registered, ignored");
			return existing;
		}
		forkLegend.entries.push(entry);
		return entry;
	},

	/** The forkSettings row an entry names, or null */
	settingItem: function(entry, items) {
		if (!entry.settingId) { return null; }
		return (items || []).filter(function(i) { return i.id === entry.settingId; })[0] || null;
	},

	/** Whether the entry's feature is on for these options: its enabled(options), else its checkbox row's value, else on.
	A broken check counts as on, so the entry still shows. */
	isOn: function(entry, opts, items) {
		try {
			if (typeof entry.enabled === "function") { return !!entry.enabled(opts); }
			const item = forkLegend.settingItem(entry, items);
			if (item && item.type === "checkbox" && typeof item.get === "function") { return !!item.get(opts); }
		} catch (e) {
			console.error("Map key: " + entry.id + " enabled check failed", e);
		}
		return true;
	},

	/** Row label as a path step: "Hole size tags:" -> "Hole size tags" */
	stripLabel: function(label) {
		return String(label || "").replace(/\s*:\s*$/, "").trim();
	},

	/** Where to switch the entry off: its `where`, else "Settings > <section title> > <row label>", else "" */
	where: function(entry, items, sectionTitle) {
		if (typeof entry.where === "string") { return entry.where; }
		const item = forkLegend.settingItem(entry, items);
		if (!item) { return ""; }
		const section = sectionTitle ? sectionTitle(item.section) : "";
		const label = forkLegend.stripLabel(item.label);
		return ["Settings", section, label].filter(function(x) { return !!x; }).join(" > ");
	},

	/** The entries to list, by group: [{group, rows: [{entry, on}]}]. Without showAll only the ones that are on. */
	visible: function(opts, items, showAll, entries) {
		const all = (entries || forkLegend.entries).slice().sort(function(a, b) { return a.order - b.order || a.seq - b.seq; });
		return forkLegend.GROUPS.map(function(g) {
			const rows = all.filter(function(e) { return e.group === g.key; })
				.map(function(e) { return { entry: e, on: forkLegend.isOn(e, opts, items) }; })
				.filter(function(r) { return showAll || r.on; });
			return { group: g, rows: rows };
		}).filter(function(g) { return g.rows.length > 0; });
	},

	// ---- Live samples: the map's own CSS, copied for the panel ----

	/** Split a selector list at its top-level commas (not the ones inside :is(...) / :has(...)) */
	splitSelectors: function(text) {
		const out = [];
		let depth = 0, start = 0;
		const s = String(text || "");
		for (let i = 0; i < s.length; i++) {
			const c = s[i];
			if (c === "(" || c === "[") { depth++; }
			else if (c === ")" || c === "]") { depth = Math.max(0, depth - 1); }
			else if (c === "," && depth === 0) { out.push(s.substring(start, i).trim()); start = i + 1; }
		}
		out.push(s.substring(start).trim());
		return out.filter(function(x) { return !!x; });
	},

	/** A rule's selector for the samples: the #chainMap parts with #chainMap swapped for the sample root (an id too, so
	the cascade between the rules stays the same); null when no part is about #chainMap */
	scopeSelector: function(selectorText) {
		const re = new RegExp("#" + forkLegend.MAP_ID + "(?![\\w-])", "g");
		const parts = forkLegend.splitSelectors(selectorText).filter(function(p) { re.lastIndex = 0; return re.test(p); });
		if (!parts.length) { return null; }
		return parts.map(function(p) { return p.replace(re, "#" + forkLegend.SAMPLE_ROOT_ID); }).join(", ");
	},

	/** CSS text: every #chainMap rule of these style sheets (CSSOM-like objects) re-targeted at the sample root, @media
	blocks kept. Sheets the page may not read (another origin) are skipped. */
	scopedCss: function(sheets) {
		const out = [];
		const walk = function(rules, into) {
			for (let i = 0; i < (rules ? rules.length : 0); i++) {
				const r = rules[i];
				if (!r) { continue; }
				if (typeof r.selectorText === "string" && r.style) {
					const sel = forkLegend.scopeSelector(r.selectorText);
					if (sel && r.style.cssText) { into.push(sel + " { " + r.style.cssText + " }"); }
				} else if (r.media && r.cssRules) {
					const inner = [];
					walk(r.cssRules, inner);
					if (inner.length) { into.push("@media " + r.media.mediaText + " { " + inner.join("\n") + " }"); }
				}
			}
		};
		for (let i = 0; i < (sheets ? sheets.length : 0); i++) {
			let rules = null;
			try { rules = sheets[i].cssRules; } catch (e) { rules = null; }
			walk(rules, out);
		}
		return out.join("\n");
	},

	// ---- Sample helpers (markup with the classes the map uses) ----

	/** A chain node like chain.nodes() makes (makeSystemNode). o: {cls, cls2 (on the wrapper), label (class line markup),
	name, type (type line markup), left / right (icon row), statics, before (marks inserted before the icon row, where
	the features put theirs), activity (nodeActivity markup)}. Plain-text fields are escaped; *Html ones are markup. */
	node: function(o) {
		o = o || {};
		const esc = forkLegend.escape;
		const html = "<div class='node " + esc(o.cls || "") + "' data-nodeid='0'>"
			+ (o.before || "")
			+ "<div class='nodeIcons'><div style='float: left;'>" + (o.left || "") + "</div><div style='float: right;'>" + (o.right || "") + "</div></div>"
			+ "<h4 class='nodeClass'>" + (o.label !== undefined ? o.label : "<span class='wh class-2'>C2</span>") + "</h4>"
			+ "<h4 class='nodeSystem'>" + (o.nameHtml !== undefined ? o.nameHtml : esc(o.name || "J105443")) + "</h4>"
			+ "<h4 class='nodeType'>" + (o.type !== undefined ? o.type : "B274") + "</h4>"
			+ "<div class='statics'>" + (o.statics || "") + "</div>"
			+ "<div class='nodeActivity'>" + (o.activity || "") + "</div>"
			+ "</div>";
		return "<div class='map-key-node" + (o.wrap ? " " + esc(o.wrap) : "") + "'>" + html + "</div>";
	},

	/** A connection: a small canvas the panel draws with the radial map's rules (drawLines). mods: the connection's
	modifier classes, as chain.nodes() gives them (e.g. "eol critical jm-62kt"); label: optional caption */
	line: function(mods, label) {
		const esc = forkLegend.escape;
		return "<span class='map-key-conn'><canvas class='map-key-line' width='66' height='22' data-mods='" + esc(mods || "") + "'></canvas>"
			+ (label ? "<span class='map-key-cap'>" + esc(label) + "</span>" : "") + "</span>";
	},

	/** A line with a mark sitting on it (size tag, preserve mass ...) */
	onLine: function(mods, markHtml, label) {
		return "<span class='map-key-conn map-key-onl'><canvas class='map-key-line' width='66' height='22' data-mods='" + forkLegend.escape(mods || "") + "'></canvas>"
			+ "<span class='map-key-mark'>" + (markHtml || "") + "</span>"
			+ (label ? "<span class='map-key-cap'>" + forkLegend.escape(label) + "</span>" : "") + "</span>";
	},

	/** Marks side by side (a scale), each with an optional caption: [[markup, caption], ...] */
	chips: function(list) {
		return "<span class='map-key-chips'>" + (list || []).map(function(c) {
			return "<span class='map-key-chip'>" + c[0] + (c[1] ? "<span class='map-key-cap'>" + forkLegend.escape(c[1]) + "</span>" : "") + "</span>";
		}).join("") + "</span>";
	},

	sampleHtml: function(entry) {
		try { return typeof entry.sample === "function" ? String(entry.sample() || "") : String(entry.sample); }
		catch (e) {
			console.error("Map key: " + entry.id + " sample failed", e);
			return "";
		}
	},

	// ---- Browser-only code below (not run under mocha) ----

	opts: function() { return typeof options !== "undefined" ? options : null; },

	items: function() { return typeof forkSettings !== "undefined" ? forkSettings.items : []; },

	sectionTitle: function(key) {
		const def = typeof forkSettings !== "undefined" ? forkSettings.sectionDef(key) : null;
		if (def && def.title) { return def.title; }
		return { account: "Account", general: "General", chain: "Chain Map" }[key] || key;
	},

	/** Draw a sample connection exactly as the radial map draws one (chain-map-renderer-base.js: aura first when the
	aura option is on, then the line with its width, colour and dash read from the connection's classes) */
	drawLine: function(canvas) {
		if (!canvas || !canvas.getContext || typeof propertyFromCssClass !== "function") { return; }
		const ctx = canvas.getContext("2d");
		const styles = ["connection"].concat(String(canvas.getAttribute("data-mods") || "").split(/\s+/).filter(function(x) { return !!x; }));
		const weight = (forkLegend.opts() && forkLegend.opts().chain && forkLegend.opts().chain.lineWeight) || 1.0;
		// Drawn 1.5x (CSS size 66x22, backing store at the screen's pixel ratio) so dashes and dots are easy to tell apart
		const css = { w: 66, h: 22 }, ratio = window.devicePixelRatio || 1, scale = forkLegend.LINE_SCALE;
		canvas.width = Math.round(css.w * ratio);
		canvas.height = Math.round(css.h * ratio);
		ctx.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
		const w = css.w / scale, y = css.h / scale / 2;
		const path = function() { ctx.beginPath(); ctx.moveTo(3, y); ctx.lineTo(w - 3, y); };
		if (forkLegend.opts() && forkLegend.opts().chain && forkLegend.opts().chain.aura) {
			ctx.save();
			path();
			ctx.lineWidth = weight;
			ctx.shadowBlur = 11 * weight;
			ctx.shadowColor = propertyFromCssClass(styles, "color");
			ctx.strokeStyle = "black";
			for (let i = 0; i < 8; i++) { ctx.stroke(); }
			ctx.restore();
		}
		ctx.save();
		path();
		ctx.lineWidth = weight * parseInt(propertyFromCssClass(styles, "border-width"), 10) || 2;
		ctx.strokeStyle = propertyFromCssClass(styles, "border-top-color");
		ctx.setLineDash({ dashed: [5, 3], dotted: [1.5, 4], double: [1.5, 9] }[propertyFromCssClass(styles, "border-top-style")] || []);
		ctx.stroke();
		ctx.restore();
	},

	/** Copy the map's #chainMap rules for the samples (once: the style sheets don't change after load) */
	ensureCss: function() {
		if (document.getElementById("map-key-css")) { return; }
		const style = document.createElement("style");
		style.id = "map-key-css";
		style.textContent = forkLegend.scopedCss(document.styleSheets);
		document.head.appendChild(style);
	},

	rowHtml: function(row, items) {
		const e = row.entry, esc = forkLegend.escape;
		const where = forkLegend.where(e, items, forkLegend.sectionTitle);
		const whereText = !where ? "" : row.on ? (e.where !== undefined ? where : "Turn off: " + where) : "Off. Turn on: " + where;
		return "<div class='map-key-row" + (row.on ? "" : " map-key-off") + "' data-key='" + esc(e.id) + "'>"
			+ "<div class='map-key-sample' aria-hidden='true'>" + forkLegend.sampleHtml(e) + "</div>"
			+ "<div class='map-key-desc'><div class='map-key-name'>" + esc(e.title) + (row.on ? "" : " <span class='map-key-offtag'>off</span>") + "</div>"
			+ "<div class='map-key-text'>" + esc(e.text) + "</div>"
			+ (whereText ? "<div class='map-key-where'>" + esc(whereText) + "</div>" : "")
			+ "</div></div>";
	},

	bodyHtml: function() {
		const items = forkLegend.items();
		const groups = forkLegend.visible(forkLegend.opts(), items, forkLegend.showAll);
		if (!groups.length) { return "<div class='map-key-empty'>Nothing to explain: every map marker is switched off. Tick Show all to see them.</div>"; }
		return groups.map(function(g) {
			return "<div class='map-key-group'><div class='map-key-gtitle'>" + forkLegend.escape(g.group.title) + "</div>"
				+ g.rows.map(function(r) { return forkLegend.rowHtml(r, items); }).join("") + "</div>";
		}).join("");
	},

	render: function() {
		const panel = document.getElementById(forkLegend.PANEL_ID);
		if (!panel) { return; }
		const root = document.getElementById(forkLegend.SAMPLE_ROOT_ID);
		// Sample nodes in the text size of the map's nodes (the map's zoom aside)
		const mapNode = document.querySelector("#" + forkLegend.MAP_ID + " div.node");
		if (mapNode) { root.style.setProperty("--map-key-font", getComputedStyle(mapNode).fontSize); }
		root.innerHTML = forkLegend.bodyHtml();
		const lines = root.querySelectorAll("canvas.map-key-line");
		for (let i = 0; i < lines.length; i++) { forkLegend.drawLine(lines[i]); }
		const all = document.getElementById("map-key-all");
		if (all) { all.checked = forkLegend.showAll; }
	},

	isOpen: function() {
		const panel = document.getElementById(forkLegend.PANEL_ID);
		return !!panel && !panel.classList.contains("hidden");
	},

	/** Put the panel under the button (or the chain map header when the button is hidden), inside the window */
	place: function() {
		const panel = document.getElementById(forkLegend.PANEL_ID);
		const btn = document.getElementById(forkLegend.BUTTON_ID);
		const anchor = btn && btn.offsetParent ? btn : document.querySelector("#chainWidget .controls");
		if (!panel || !anchor) { return; }
		const r = anchor.getBoundingClientRect();
		const w = panel.offsetWidth || 440;
		const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
		const top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 160));
		panel.style.left = left + "px";
		panel.style.top = top + "px";
		panel.style.maxHeight = Math.max(150, window.innerHeight - top - 8) + "px";
	},

	ensurePanel: function() {
		if (document.getElementById(forkLegend.PANEL_ID)) { return; }
		const panel = document.createElement("div");
		panel.id = forkLegend.PANEL_ID;
		panel.className = "map-key hidden";
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "Map key");
		panel.innerHTML = "<div class='map-key-head'><span class='map-key-title'>Map key</span>"
			+ "<label class='map-key-all' title='Also list the markers you have switched off'><input type='checkbox' id='map-key-all' /> Show all</label>"
			+ "<button type='button' class='map-key-close' title='Close (Esc)' aria-label='Close'>&times;</button></div>"
			+ "<div class='map-key-body'><div id='" + forkLegend.SAMPLE_ROOT_ID + "'></div></div>"
			+ "<div class='map-key-foot'>Lists what is switched on for you. Samples use the map's own styles.</div>";
		document.body.appendChild(panel);
		panel.querySelector(".map-key-close").addEventListener("click", function() { forkLegend.close(); });
		panel.querySelector("#map-key-all").addEventListener("change", function() {
			forkLegend.showAll = this.checked;
			if (forkLegend.showAll && typeof forkUsage !== "undefined") { forkUsage.track("mapLegend", "show_all"); }
			forkLegend.render();
		});
	},

	open: function() {
		forkLegend.ensureCss();
		forkLegend.ensurePanel();
		forkLegend.render();
		document.getElementById(forkLegend.PANEL_ID).classList.remove("hidden");
		const btn = document.getElementById(forkLegend.BUTTON_ID);
		if (btn) { btn.classList.add("active"); btn.setAttribute("aria-expanded", "true"); }
		forkLegend.place();
		if (typeof forkUsage !== "undefined") { forkUsage.track("mapLegend", "opened"); }
	},

	close: function() {
		const panel = document.getElementById(forkLegend.PANEL_ID);
		if (panel) { panel.classList.add("hidden"); }
		const btn = document.getElementById(forkLegend.BUTTON_ID);
		if (btn) { btn.classList.remove("active"); btn.setAttribute("aria-expanded", "false"); }
	},

	toggle: function() {
		if (forkLegend.isOpen()) { forkLegend.close(); } else { forkLegend.open(); }
	},

	ICON: "<svg width='13' height='11' viewBox='0 0 13 11' aria-hidden='true'><circle cx='2' cy='2' r='1.6' fill='currentColor'></circle>"
		+ "<path d='M5 2H12.5' stroke='currentColor' stroke-width='1.3'></path><path d='M0.5 5.5H3.5' stroke='currentColor' stroke-width='1.6' stroke-dasharray='1.4 0.8'></path>"
		+ "<path d='M5 5.5H12.5' stroke='currentColor' stroke-width='1.3'></path><rect x='0.6' y='7.7' width='3' height='2.6' rx='0.6' fill='none' stroke='currentColor' stroke-width='1'></rect>"
		+ "<path d='M5 9H12.5' stroke='currentColor' stroke-width='1.3'></path></svg>",

	/** The header button, right after upstream's hover legend (≡); hidden when switched off */
	syncButton: function() {
		let btn = document.getElementById(forkLegend.BUTTON_ID);
		if (!btn) {
			const after = document.getElementById("show-chainLegend");
			if (!after) { return; }
			btn = document.createElement("i");
			btn.id = forkLegend.BUTTON_ID;
			btn.setAttribute("role", "button");
			btn.setAttribute("tabindex", "0");
			btn.setAttribute("aria-expanded", "false");
			btn.setAttribute("aria-label", "Map key");
			btn.title = "Map key: what the colours and markers on the map mean";
			btn.innerHTML = forkLegend.ICON;
			after.parentNode.insertBefore(btn, after.nextSibling);
			btn.addEventListener("click", function() { forkLegend.toggle(); });
			btn.addEventListener("keydown", function(e) {
				if (e.key === "Enter" || e.key === " ") { e.preventDefault(); forkLegend.toggle(); }
			});
		}
		const on = forkLegend.enabled(forkLegend.opts());
		btn.classList.toggle("hidden", !on);
		if (!on && forkLegend.isOpen()) { forkLegend.close(); }
	},

	init: function() {
		if (typeof mapLegendEntries !== "undefined") {
			mapLegendEntries.forEach(function(e) {
				try { forkLegend.register(e); } catch (err) { console.error(err); }
			});
		}
		forkLegend.syncButton();
		// Escape or a click outside closes the panel
		document.addEventListener("keydown", function(e) {
			if (e.key === "Escape" && forkLegend.isOpen()) { forkLegend.close(); }
		});
		document.addEventListener("mousedown", function(e) {
			if (!forkLegend.isOpen()) { return; }
			const panel = document.getElementById(forkLegend.PANEL_ID), btn = document.getElementById(forkLegend.BUTTON_ID);
			if (panel.contains(e.target) || (btn && btn.contains(e.target))) { return; }
			forkLegend.close();
		});
		window.addEventListener("resize", function() { if (forkLegend.isOpen()) { forkLegend.place(); } });

		if (typeof forkSettings !== "undefined") {
			// Settings > Chain Map; takes effect on Save (options.apply below), Reset deletes the key (on)
			forkSettings.register({
				section: "chain", order: 90, id: "mapLegend-enabled", type: "checkbox", key: "mapLegend",
				label: "Map key button:", text: "Show the Map key button in the chain map header (what the map's colours and markers mean)",
				keywords: "legend key colours colors markers help",
				get: function(o) { return forkLegend.enabled(o); },
				set: function(o, on) { o.mapLegend = { enabled: on }; }
			});
		}
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.mapLegendWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				forkLegend.syncButton();
				if (forkLegend.isOpen()) { forkLegend.render(); }
				return result;
			};
			options.apply.mapLegendWrapped = true;
		}
		if (typeof forkCommands !== "undefined") {
			forkCommands.register({
				id: "mapKey.open", title: "Map key", group: "App", icon: "info",
				keywords: ["legend", "key", "colours", "colors", "markers", "what does", "mean", "map"],
				run: function() { forkLegend.open(); }
			});
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { forkLegend.init(); });
}
