const rollingGuide = {
	// Rolling guide (fork-owned): a panel with the fleet rolling flowchart for a hole's size (battleships + HICs, in
	// waves). Opened from a hole's context menu on the chain map ("Rolling guide"), the mass dialog's rolling line and the
	// command palette. A standard panel (panel-host.js / panel-modes.js), popped out by default; docked, minimized or
	// closed from its buttons. The images are made offline by tools/rolling-guide (see its README) and served from
	// public/images/rolling-guide/. No Settings row: it only shows when asked for. options.rollingGuide = {open, size}:
	// open again after a reload, on the last size. Keep `const rollingGuide` on the first line: the test helper strips it
	// to define a global. panelHost and panelModes sort before this file; holeRolling (rolling.js) too: all used at run time.
	WIDGET_ID: "rollingGuideWidget",
	OPTIONS_KEY: "rollingGuide",
	MENU_COMMAND: "rollingGuide",
	IMAGE_DIR: "images/rolling-guide/",
	IMAGE_VERSION: "1",	// bump when the images are regenerated (browser caches)
	MIN_JUMP_KG: 300e6,	// a hot battleship (300,000 t) must fit through
	SIZE: { x: 8, y: 10, minX: 5, minY: 4 },
	WINDOW: { width: 560, height: 680, minWidth: 320, minHeight: 240 },
	// One guide per hole size (total mass, kg)
	GUIDES: [
		{ key: "750m", label: "750M", mass: 750e6 },
		{ key: "1b", label: "1B", mass: 1e9 },
		{ key: "2b", label: "2B", mass: 2e9 },
		{ key: "3b", label: "3B", mass: 3e9 },
		{ key: "3-3b", label: "3.3B", mass: 3.3e9 },
		{ key: "5b", label: "5B", mass: 5e9 }
	],

	// ---- Pure ----

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	guide: function(key) {
		return rollingGuide.GUIDES.filter(function(g) { return g.key === key; })[0] || null;
	},

	/** The wormhole type record ({mass, jump, ...}) for a type name, or null (unknown, K162, a size-only placeholder) */
	typeInfo: function(type, wormholes) {
		const name = String(type === undefined || type === null ? "" : type).trim().toUpperCase();
		if (!name || name === "K162" || name === "????") { return null; }
		const t = wormholes ? wormholes[name] : null;
		return t && typeof t === "object" && !t.dummy ? t : null;
	},

	/** The real type of a hole (tripwire.client.wormholes[id]: the side with the type is stored in `type`), or null */
	holeType: function(wormhole, wormholes) {
		if (!wormhole || !rollingGuide.typeInfo(wormhole.type, wormholes)) { return null; }
		return String(wormhole.type).trim().toUpperCase();
	},

	/** The guide key for a wormhole type ("3-3b"), or null: unknown type, not battleship-sized, or no guide for its mass */
	guideFor: function(type, wormholes) {
		const t = rollingGuide.typeInfo(type, wormholes);
		if (!t || !(Number(t.jump) >= rollingGuide.MIN_JUMP_KG)) { return null; }
		const mass = Number(t.mass);
		const g = rollingGuide.GUIDES.filter(function(x) { return Math.abs(x.mass - mass) < 1e6; })[0];
		return g ? g.key : null;
	},

	/** "3.3B kg", "750M kg" */
	formatMass: function(kg) {
		const n = Number(kg);
		if (!(n > 0)) { return "?"; }
		const trim = function(v) { return String(Math.round(v * 10) / 10); };
		return (n >= 1e9 ? trim(n / 1e9) + "B" : trim(n / 1e6) + "M") + " kg";
	},

	/** "2,000,000 t" (kg to tonnes) */
	formatTonnes: function(kg) {
		const t = Math.round(Number(kg) / 1000);
		return String(isFinite(t) ? t : 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " t";
	},

	/** "H296 · 3.3B kg · Max jump 2,000,000 t", "" for an unknown type */
	caption: function(type, wormholes) {
		const t = rollingGuide.typeInfo(type, wormholes);
		if (!t) { return ""; }
		return String(type).trim().toUpperCase() + " · " + rollingGuide.formatMass(t.mass) + " · Max jump " + rollingGuide.formatTonnes(t.jump);
	},

	/**
	 * What the panel shows for a hole's type: {guide (key or null), caption, note}.
	 * Unknown / K162: no guide, "Pick the hole's size"; too small for battleships: a note and no guide.
	 */
	forType: function(type, wormholes) {
		const t = rollingGuide.typeInfo(type, wormholes);
		const caption = rollingGuide.caption(type, wormholes);
		if (!t) { return { guide: null, caption: "", note: "Pick the hole's size" }; }
		if (!(Number(t.jump) >= rollingGuide.MIN_JUMP_KG)) {
			return { guide: null, caption: caption, note: "This hole doesn't take battleships (max jump " + rollingGuide.formatTonnes(t.jump) +
				"): the guide covers holes that do." };
		}
		const guide = rollingGuide.guideFor(type, wormholes);
		return { guide: guide, caption: caption, note: guide ? "" : "There is no guide for this hole's mass: pick the closest size." };
	},

	/** The settings: {open (boolean), size (a guide key or null)} */
	settings: function(opts) {
		const raw = opts && opts[rollingGuide.OPTIONS_KEY] && typeof opts[rollingGuide.OPTIONS_KEY] === "object" ? opts[rollingGuide.OPTIONS_KEY] : {};
		return { open: raw.open === true, size: rollingGuide.guide(raw.size) ? raw.size : null };
	},

	imageUrl: function(key) {
		return rollingGuide.guide(key) ? rollingGuide.IMAGE_DIR + key + ".png?v=" + rollingGuide.IMAGE_VERSION : "";
	},

	/**
	 * The panel's body: size buttons, caption, note, then the image (or nothing until a size is picked).
	 * @param view {size (guide key shown), caption (the hole it was opened for), holeGuide (that hole's guide key), note}.
	 * The caption only shows while that hole's own guide (or no guide) is shown, not once another size is picked.
	 */
	bodyHtml: function(view) {
		const e = rollingGuide.escape;
		view = view || {};
		const current = rollingGuide.guide(view.size);
		let html = "<div class='rg-tabs' role='group' aria-label='Hole size'>" + rollingGuide.GUIDES.map(function(g) {
			const on = current && current.key === g.key;
			return "<button type='button' class='rg-tab" + (on ? " rg-active" : "") + "' data-rg-size='" + g.key + "' aria-pressed='" + (on ? "true" : "false") + "'>" + e(g.label) + "</button>";
		}).join("") + "</div>";
		if (view.caption && (!current || current.key === view.holeGuide)) { html += "<div class='rg-caption'>" + e(view.caption) + "</div>"; }
		if (view.note) { html += "<div class='rg-note'>" + e(view.note) + "</div>"; }
		if (current) {
			const url = rollingGuide.imageUrl(current.key);
			html += "<div class='rg-image'><a href='" + e(url) + "' target='_blank' rel='noopener' class='rg-full' data-tooltip='Open full size in a new tab'>"
				+ "<img src='" + e(url) + "' alt='" + e("Fleet rolling flowchart for " + current.label + " kg holes") + "'></a></div>"
				+ "<div class='rg-foot'><a href='" + e(url) + "' target='_blank' rel='noopener'>Open full size</a></div>";
		}
		return html;
	},

	/** The mass dialog's link (next to "Rolling…") */
	massLinkHtml: function() {
		return " <span class='rg-mass-link'><a href='#' class='rg-open-mass' title='The fleet rolling flowchart for this hole size'>Rolling guide</a></span>";
	},

	// ---- Browser-only code below (not run under mocha) ----

	state: { size: null, caption: "", holeGuide: null, note: "" },

	opts: function() {
		return typeof options !== "undefined" ? options : null;
	},

	wormholes: function() {
		return (typeof tripwire !== "undefined" && tripwire && tripwire.wormholes) || (typeof appData !== "undefined" ? appData.wormholes : null) || {};
	},

	$widget: function() {
		return $("#" + rollingGuide.WIDGET_ID);
	},

	isShown: function() {
		return rollingGuide.$widget().length > 0;
	},

	/** Save keys of options.rollingGuide (keeping the rest) */
	store: function(changes) {
		const o = rollingGuide.opts();
		if (!o) { return; }
		o[rollingGuide.OPTIONS_KEY] = Object.assign({}, o[rollingGuide.OPTIONS_KEY] || {}, changes);
		if (typeof o.save === "function") { o.save(); }
	},

	/** The panel as panelHost and panelModes take it */
	panel: function() {
		return {
			id: rollingGuide.WIDGET_ID, title: "Rolling guide", key: rollingGuide.OPTIONS_KEY, size: rollingGuide.SIZE, defaultMode: "floating",
			minSize: { minWidth: rollingGuide.WINDOW.minWidth, minHeight: rollingGuide.WINDOW.minHeight },
			windowTitle: function() {
				const g = rollingGuide.guide(rollingGuide.state.size);
				return "Rolling guide" + (g ? " · " + g.label : "");
			},
			offReason: "Not open: open it from a hole's right-click menu on the chain map",
			onEscape: function() { rollingGuide.close(); },
			// The first window: tall, at the right under the top bar
			floatDefault: function(view) {
				const w = Math.min(rollingGuide.WINDOW.width, Math.max(0, view.width - 32));
				const h = Math.min(rollingGuide.WINDOW.height, Math.max(0, view.height - 80));
				return { left: view.width - w - 24, top: 60, width: w, height: h };
			}
		};
	},

	widgetHtml: function() {
		return "<li id='" + rollingGuide.WIDGET_ID + "' class='gridWidget rg-panel'>"
			+ "<div class='controls'><span class='rg-title ph-heading'>Rolling guide</span>"
			+ "<div style='float: right;'><i class='rg-close' data-icon='times' data-tooltip='Close the Rolling guide'></i></div></div>"
			+ "<div class='content'><div class='rg-wrap'></div></div></li>";
	},

	render: function() {
		const $w = rollingGuide.$widget();
		if (!$w.length) { return; }
		const $wrap = $w.find(".rg-wrap");
		if (typeof Tooltips !== "undefined" && Tooltips.detach && $wrap.find("[data-tooltip]").length) { Tooltips.detach($wrap.find("[data-tooltip]")); }
		$wrap.html(rollingGuide.bodyHtml(rollingGuide.state));
		if (typeof Tooltips !== "undefined" && Tooltips.attach) { Tooltips.attach($wrap.find("[data-tooltip]")); }
		if (typeof panelModes !== "undefined") { panelModes.updateTitle(rollingGuide.WIDGET_ID); }
	},

	/** Show the panel (in its mode), or bring its window to the front when it is open */
	addWidget: function() {
		let $w = rollingGuide.$widget();
		if ($w.length) {
			const $host = $w.closest(".ph-float-host");
			if ($host.hasClass("ui-dialog-content")) { $host.dialog("moveToTop"); }
			return $w;
		}
		if (typeof panelHost === "undefined") { return null; }
		$w = panelHost.addGridWidget(rollingGuide.panel(), rollingGuide.widgetHtml(), { transition: false });
		if (!$w) { return null; }
		if (typeof Tooltips !== "undefined" && Tooltips.attach) { Tooltips.attach($w.find(".controls .rg-close")); }
		return $w;
	},

	removeWidget: function() {
		if (!rollingGuide.isShown()) { return; }
		panelHost.removeGridWidget(rollingGuide.panel(), rollingGuide.$widget(), { finishFade: true });
	},

	/**
	 * Open the guide. @param wormholeID a hole (tripwire.client.wormholes) to show its size, or null for the last size
	 */
	open: function(wormholeID) {
		const wormhole = wormholeID !== null && wormholeID !== undefined && typeof tripwire !== "undefined" && tripwire.client && tripwire.client.wormholes
			? tripwire.client.wormholes[wormholeID] : null;
		if (wormhole) {
			const view = rollingGuide.forType(rollingGuide.holeType(wormhole, rollingGuide.wormholes()), rollingGuide.wormholes());
			rollingGuide.state = { size: view.guide, caption: view.caption, holeGuide: view.guide, note: view.note };
		} else {
			const size = rollingGuide.state.size || rollingGuide.settings(rollingGuide.opts()).size;
			rollingGuide.state = Object.assign({}, rollingGuide.state, { size: size, note: size ? "" : "Pick the hole's size" });
		}
		if (!rollingGuide.addWidget()) { return; }
		// Opened again while minimized: it comes back (in the window it had)
		if (typeof panelModes !== "undefined" && panelModes.modeFor(rollingGuide.WIDGET_ID) === "minimized") { panelModes.setMode(rollingGuide.WIDGET_ID, "restore"); }
		rollingGuide.render();
		const s = rollingGuide.settings(rollingGuide.opts());
		if (!s.open || (rollingGuide.state.size && s.size !== rollingGuide.state.size)) {
			rollingGuide.store(rollingGuide.state.size ? { open: true, size: rollingGuide.state.size } : { open: true });
		}
	},

	pickSize: function(key) {
		if (!rollingGuide.guide(key)) { return; }
		rollingGuide.state = Object.assign({}, rollingGuide.state, { size: key, note: "" });
		rollingGuide.render();
		rollingGuide.store({ size: key });
	},

	close: function() {
		if (typeof Tooltips !== "undefined" && Tooltips.close) { Tooltips.close(); }
		rollingGuide.removeWidget();
		rollingGuide.store({ open: false });
	},

	/** Match the options (page load, Settings Save / Reset) */
	sync: function() {
		const s = rollingGuide.settings(rollingGuide.opts());
		if (s.open && !rollingGuide.isShown()) {
			rollingGuide.state = { size: s.size, caption: "", holeGuide: null, note: s.size ? "" : "Pick the hole's size" };
			if (rollingGuide.addWidget()) { rollingGuide.render(); }
		} else if (!s.open && rollingGuide.isShown()) {
			rollingGuide.removeWidget();
		}
	},

	/** The hole whose node was right-clicked (the node's data-sigid is the wormhole id), or null */
	wormholeOf: function(target) {
		const id = $(target).closest("[data-nodeid]").attr("data-sigid");
		return /^\d+$/.test(String(id || "")) && tripwire.client && tripwire.client.wormholes && tripwire.client.wormholes[id] ? Number(id) : null;
	},

	setupMenu: function() {
		const chainParent = $("#chainParent");
		if (!chainParent.length || !chainParent.contextmenu || !$("#chainMenu").length) { return; }
		const $entry = $("<li data-command='" + rollingGuide.MENU_COMMAND + "'><a>Rolling guide</a></li>");
		// Right after "Rolling…" (rolling.js), else after Mass. The other entries may be added later: placed again on open.
		const place = function() {
			const $rolling = $("#chainMenu > li[data-command='holeRolling']");
			const $after = $rolling.length ? $rolling : $("#chainMenu > li[data-command='mass']");
			if ($after.length && $after.next()[0] === $entry[0]) { return false; }
			if ($after.length) { $entry.insertAfter($after); } else { $("#chainMenu").append($entry); }
			return true;
		};
		place();
		$("#chainMenu").menu("refresh");

		const originalSelect = chainParent.contextmenu("option", "select");
		chainParent.contextmenu("option", "select", function(e, ui) {
			if (ui.cmd === rollingGuide.MENU_COMMAND) {
				const id = rollingGuide.wormholeOf(ui.target[0]);
				if (id !== null) { rollingGuide.open(id); }
				return;
			}
			return originalSelect ? originalSelect.apply(this, arguments) : undefined;
		});
		const originalBeforeOpen = chainParent.contextmenu("option", "beforeOpen");
		chainParent.contextmenu("option", "beforeOpen", function(e, ui) {
			try {
				if (place()) { $("#chainMenu").menu("refresh"); }
				$(this).contextmenu("showEntry", rollingGuide.MENU_COMMAND, rollingGuide.wormholeOf(ui.target[0]) !== null);
			} catch (err) { console.error("Rolling guide: menu update failed", err); }
			return originalBeforeOpen ? originalBeforeOpen.apply(this, arguments) : undefined;
		});
	},

	registerCommands: function() {
		if (typeof forkCommands === "undefined") { return; }
		forkCommands.register({
			id: "rollingGuide.open", title: "Rolling guide", group: "Holes", icon: "connection",
			keywords: ["roll", "rolling", "guide", "flowchart", "battleship", "hic", "close", "collapse", "hole"],
			enabled: function() { return $("#dialog-options").is(":visible") ? "Close Settings first" : true; },
			run: function() { rollingGuide.open(null); }
		});
	},

	init: function() {
		if (typeof panelHost === "undefined") { return; }
		panelHost.register(rollingGuide.panel());
		try { rollingGuide.setupMenu(); } catch (err) { console.error("Rolling guide: context menu setup failed", err); }
		rollingGuide.registerCommands();
		const $doc = $(document);
		const sel = "#" + rollingGuide.WIDGET_ID;
		$doc.on("click", sel + " .rg-tab", function(e) { e.preventDefault(); rollingGuide.pickSize($(this).attr("data-rg-size")); });
		$doc.on("click", sel + " .controls .rg-close", function(e) { e.preventDefault(); rollingGuide.close(); });
		// Mass dialog: the link next to "Rolling…" (rolling.js renders it)
		$doc.on("click", "#hole-rolling-panel .rg-open-mass", function(e) {
			e.preventDefault();
			rollingGuide.open($("#dialog-mass").data("id"));
		});
		// options.apply() runs on Settings Save and Reset: open or close to match
		const o = rollingGuide.opts();
		if (o && typeof o.apply === "function" && !o.apply.rollingGuideWrapped) {
			const apply = o.apply;
			const wrapped = function() {
				const result = apply.apply(this, arguments);
				try { rollingGuide.sync(); } catch (err) { console.error("Rolling guide: sync failed", err); }
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrapped[k] = apply[k]; });
			wrapped.rollingGuideWrapped = true;
			o.apply = wrapped;
		}
		rollingGuide.sync();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { rollingGuide.init(); });
}
