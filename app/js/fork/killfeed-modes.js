const killfeedModes = {
	// Kill panel display modes (fork-owned), shared by the System kills (system-killfeed.js) and Chain kills
	// (chain-killfeed.js) panels. Each panel has its own mode, stored per user in options.<key>.mode:
	//   fixed      a layout (gridster) panel, as it always was
	//   minimized  the same layout panel shrunk to its header and the most recent kill
	//   floating   not in the layout: a non-modal, draggable, resizable dialog like the Region map; closing it docks it back
	// Missing or unknown = fixed. Where each panel was (the height to restore after minimized, the floating window's
	// {left, top, width, height} in CSS pixels of the zoomed page) is kept apart in options.killPanelPlaces.<key>: that
	// key is not a Settings row, so a mask default (mask-defaults.js, whole options.<key> objects) never carries one
	// person's window position or panel height to everyone. Switched from the panel header, Settings > Kills & Intel and the command palette.
	// A panel object passed in here provides: MODE_KEY (options key), WIDGET_ID, SIZE {x, y, minX, minY},
	// FLOAT_INDEX (0, 1: default float position), isOn(), innerHtml() (controls + content, with an empty
	// <span class='skm-buttons'>), title() (dialog title), setupContent(content) (optional), render(),
	// afterSwap() (optional), addWidget(), removeWidget(), observer (set here).
	// Grid placement and floating geometry: panel-host.js (panelHost).
	// Keep `const killfeedModes` on the first line: the test helper strips it to define a global. Other fork globals
	// (panelHost, systemKillFeed, forkSettings, Tooltips) are only used at call time: this file loads before some of them.
	MODES: ["fixed", "minimized", "floating"],
	LABELS: { fixed: "Fixed", minimized: "Fixed and minimized", floating: "Floating" },
	MIN_SIZE_Y: 2,	// gridster rows (50 px + 10 px margin): the header and one kill row
	SAVE_DELAY_MS: 800,	// moving or resizing the floating panel saves once it has settled
	PLACES_KEY: "killPanelPlaces",

	/** A known mode, else "fixed" */
	normalize: function(mode) {
		return killfeedModes.MODES.indexOf(mode) >= 0 ? mode : "fixed";
	},

	/** The panel's mode in the user options */
	modeOf: function(opts, key) {
		return killfeedModes.normalize(opts && opts[key] && typeof opts[key] === "object" ? opts[key].mode : undefined);
	},

	/** options.<key> with `patch` merged in (a new object; other fields such as `enabled` are kept). Never mutates. */
	merge: function(current, patch) {
		const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
		return Object.assign({}, base, patch || {});
	},

	/** Where the panel was: options.killPanelPlaces.<key> ({fullSizeY, float}), {} when nothing is stored */
	place: function(opts, key) {
		const places = opts ? opts[killfeedModes.PLACES_KEY] : null;
		const v = places && typeof places === "object" ? places[key] : null;
		return v && typeof v === "object" && !Array.isArray(v) ? v : {};
	},

	/** A new options.killPanelPlaces with `patch` merged into the panel's entry. Never mutates. */
	withPlace: function(opts, key, patch) {
		const places = opts ? opts[killfeedModes.PLACES_KEY] : null;
		const out = killfeedModes.merge(places);
		out[key] = killfeedModes.merge(killfeedModes.place(opts, key), patch);
		return out;
	},

	/** The remembered full height (gridster rows) of a minimized panel, or null */
	fullSizeY: function(opts, key, minY) {
		const v = parseInt(killfeedModes.place(opts, key).fullSizeY, 10);
		return v >= (minY || 1) ? v : null;
	},

	/**
	 * Rows (size_y) a layout panel gets when it is added.
	 * @param saved the saved layout entry ({size_y}) or null; @param fullSizeY remembered full height or null
	 * @param size the panel's SIZE {y, minY}
	 * A fixed panel whose saved height is below its minimum (saved while minimized) gets its full height back.
	 */
	gridSizeY: function(mode, saved, fullSizeY, size) {
		if (mode === "minimized") { return killfeedModes.MIN_SIZE_Y; }
		const savedY = saved ? parseInt(saved.size_y, 10) : NaN;
		if (savedY >= size.minY) { return savedY; }
		return fullSizeY && fullSizeY >= size.minY ? fullSizeY : size.y;
	},

	/** Height to remember when minimizing: the current height, unless it is already below the minimum */
	rememberSizeY: function(currentY, previous, size) {
		const y = parseInt(currentY, 10);
		if (y >= size.minY) { return y; }
		return previous && previous >= size.minY ? previous : size.y;
	},

	/** Header buttons for a mode: [{mode (to switch to), icon, tooltip}] */
	buttons: function(mode) {
		const m = killfeedModes.normalize(mode);
		const list = [];
		if (m === "fixed") { list.push({ mode: "minimized", icon: "minus", tooltip: "Minimize: show only the most recent kill" }); }
		if (m === "minimized") { list.push({ mode: "fixed", icon: "plus", tooltip: "Restore the full panel" }); }
		if (m === "floating") { list.push({ mode: "fixed", icon: "pin", tooltip: "Dock back into the layout" }); }
		else { list.push({ mode: "floating", icon: "fullscreen", tooltip: "Float: show in a window you can move and resize" }); }
		return list;
	},

	buttonsHtml: function(mode) {
		return killfeedModes.buttons(mode).map(function(b) {
			return "<i class='skm-btn' data-mode='" + b.mode + "' data-icon='" + b.icon + "' data-tooltip='" + b.tooltip + "'></i>";
		}).join("");
	},

	/** Settings select choices */
	choices: function() {
		return killfeedModes.MODES.map(function(m) { return [m, killfeedModes.LABELS[m]]; });
	},

	// ---- Browser-only code below (not run under mocha) ----

	saveTimers: {},

	opts: function() {
		return typeof options !== "undefined" ? options : null;
	},

	$panel: function(panel) {
		return $("#" + panel.WIDGET_ID);
	},

	/** The mode the panel is shown in now (null when it isn't shown) */
	shownMode: function(panel) {
		const $w = killfeedModes.$panel(panel);
		return $w.length ? killfeedModes.normalize($w.attr("data-skm-mode")) : null;
	},

	/** Build the panel in the user's mode (or `mode`). Returns the panel element, or null when it can't be shown. */
	attach: function(panel, mode) {
		const m = killfeedModes.normalize(mode || killfeedModes.modeOf(killfeedModes.opts(), panel.MODE_KEY));
		const $w = m === "floating" ? killfeedModes.attachFloating(panel) : killfeedModes.attachGrid(panel, m);
		if (!$w) { return null; }
		$w.attr("data-skm-mode", m);
		killfeedModes.setupCommon(panel, $w, m);
		return $w;
	},

	/** The panel as panelHost takes it */
	def: function(panel) {
		return { id: panel.WIDGET_ID, size: panel.SIZE };
	},

	attachGrid: function(panel, mode) {
		const opts = killfeedModes.opts();
		const size = panel.SIZE;
		const saved = panelHost.savedPosition(opts ? opts.grid : null, panel.WIDGET_ID);
		const minimized = mode === "minimized";
		return panelHost.addGridWidget(killfeedModes.def(panel), "<li id='" + panel.WIDGET_ID + "' class='gridWidget skm-panel" + (minimized ? " skm-minimized" : "") + "'>"
			+ panel.innerHtml() + "</li>", { fadeIn: true, sizeY: killfeedModes.gridSizeY(mode, saved, killfeedModes.fullSizeY(opts, panel.MODE_KEY, size.minY), size),
			minY: minimized ? killfeedModes.MIN_SIZE_Y : size.minY });
	},

	attachFloating: function(panel) {
		const saved = killfeedModes.place(killfeedModes.opts(), panel.MODE_KEY).float;
		const view = panelHost.viewport();
		let geom = panelHost.clampFloat(saved, view.width, view.height, panel.FLOAT_INDEX);
		const f = panelHost.FLOAT;
		// The dialog element is a host: jQuery UI sizes it, and options.apply() (which writes saved layout sizes onto
		// the element with the panel's id) only reaches the panel inside it, whose size the CSS fixes
		const $host = $("<div class='skm-float-host'><div id='" + panel.WIDGET_ID + "' class='skm-panel skm-floating'>"
			+ panel.innerHtml() + "</div></div>").appendTo("body");
		$host.dialog({
			title: panel.title(), modal: false, resizable: true, closeOnEscape: false, closeText: "Dock",
			width: geom.width, height: geom.height, minWidth: Math.min(f.minWidth, geom.width), minHeight: Math.min(f.minHeight, geom.height),
			dialogClass: "dialog-noeffect ui-dialog-shadow skm-dialog",
			// X docks the panel back into the layout (it doesn't turn it off: that's the Settings checkbox)
			close: function() { setTimeout(function() { killfeedModes.setMode(panel, "fixed"); }, 0); },
			dragStop: function() { killfeedModes.queueSave(panel); },
			resizeStop: function() { killfeedModes.queueSave(panel); }
		});
		// Now that the dialog's border and padding are known: fit its outer width into the viewport
		const $d = $host.dialog("widget");
		geom = panelHost.clampFloat(geom, view.width, view.height, panel.FLOAT_INDEX, panelHost.chrome($d).w);
		$host.dialog("option", { width: geom.width, height: geom.height });
		$d.css({ left: geom.left + view.left, top: geom.top + view.top });
		return $host.find("#" + panel.WIDGET_ID);
	},

	/** What both kinds of panel need: image fallback, header buttons, tooltips, width classes */
	setupCommon: function(panel, $w, mode) {
		const content = $w.find(".content")[0];
		content.addEventListener("error", function(e) {
			if (e.target && e.target.tagName === "IMG") { $(e.target).replaceWith("<span class='" + e.target.className + " skf-noimg'></span>"); }
		}, true);
		if (typeof panel.setupContent === "function") { panel.setupContent(content, $w); }
		$w.find(".skm-buttons").html(killfeedModes.buttonsHtml(mode));
		$w.on("click", ".skm-btn", function(e) {
			e.preventDefault();
			e.stopPropagation();
			killfeedModes.setMode(panel, $(this).attr("data-mode"));
		});
		if (typeof Tooltips !== "undefined") { Tooltips.attach($w.find(".controls [data-tooltip]")); }
		const fit = function() {
			$w.removeClass("skf-lt340 skf-lt280 skf-lt230 skf-wide").addClass(systemKillFeed.widthClasses(content.clientWidth).join(" "));
		};
		fit();
		if (panel.observer) { panel.observer.disconnect(); }
		panel.observer = null;
		if (typeof ResizeObserver !== "undefined") {
			panel.observer = new ResizeObserver(fit);
			panel.observer.observe(content);
		}
	},

	/**
	 * Remove the panel's element (layout widget or floating dialog). Timers and requests are the panel's own.
	 * @param closeGap true: the panels under a layout widget move up (it is floating now, not turned off)
	 */
	detach: function(panel, closeGap) {
		if (panel.observer) { panel.observer.disconnect(); panel.observer = null; }
		killfeedModes.flushSave(panel);
		const $w = killfeedModes.$panel(panel);
		if (!$w.length) { return; }
		if (!$w.hasClass("skm-floating")) {
			panelHost.removeGridWidget(killfeedModes.def(panel), $w, { closeGap: closeGap });
			return;
		}
		panelHost.releaseTooltips($w);
		$w.attr("id", panel.WIDGET_ID + "-removed");
		const $host = $w.closest(".skm-float-host");
		if ($host.hasClass("ui-dialog-content")) { $host.dialog("destroy"); }	// destroy doesn't fire close
		$host.remove();
	},

	/** Change the shown panel to `mode` (it must be shown). Returns whether anything changed. */
	show: function(panel, mode) {
		const from = killfeedModes.shownMode(panel);
		const to = killfeedModes.normalize(mode);
		if (!from || from === to) { return false; }
		if (from !== "floating" && to !== "floating") {
			killfeedModes.resizeGrid(panel, from, to);
			return true;
		}
		killfeedModes.detach(panel, to === "floating");
		if (!killfeedModes.attach(panel, to)) { return true; }
		panel.render();
		if (typeof panel.afterSwap === "function") { panel.afterSwap(); }
		return true;
	},

	/** Minimize or restore a layout panel in place (its width and position stay) */
	resizeGrid: function(panel, from, to) {
		const g = panelHost.gridster();
		const $w = killfeedModes.$panel(panel);
		const opts = killfeedModes.opts();
		const size = panel.SIZE;
		const coords = $w.coords && $w.data("coords") ? $w.coords().grid : null;
		if (!g || !coords) { return; }
		if (to === "minimized") {
			if (opts) {
				opts[killfeedModes.PLACES_KEY] = killfeedModes.withPlace(opts, panel.MODE_KEY,
					{ fullSizeY: killfeedModes.rememberSizeY(coords.size_y, killfeedModes.fullSizeY(opts, panel.MODE_KEY, size.minY), size) });
			}
			g.set_widget_min_size($w, [size.minX, killfeedModes.MIN_SIZE_Y]);
			g.resize_widget($w, coords.size_x, killfeedModes.MIN_SIZE_Y);
		} else {
			g.set_widget_min_size($w, [size.minX, size.minY]);
			g.resize_widget($w, coords.size_x, killfeedModes.fullSizeY(opts, panel.MODE_KEY, size.minY) || size.y);
		}
		// options.apply() writes the saved pixel height inline; gridster sizes by data-sizey
		$w.css("height", "");
		$w.toggleClass("skm-minimized", to === "minimized").attr("data-skm-mode", to);
		$w.find(".content").scrollTop(0);
		if (typeof Tooltips !== "undefined") {
			if (Tooltips.close) { Tooltips.close(); }
			const $old = $w.find(".skm-btn");
			if (Tooltips.detach && $old.length) { Tooltips.detach($old); }
		}
		$w.find(".skm-buttons").html(killfeedModes.buttonsHtml(to));
		if (typeof Tooltips !== "undefined") { Tooltips.attach($w.find(".skm-btn")); }
	},

	/** The user picked a mode (header button, dialog X, command): store it, show it, save */
	setMode: function(panel, mode) {
		const opts = killfeedModes.opts();
		if (!opts) { return; }
		const to = killfeedModes.normalize(mode);
		opts[panel.MODE_KEY] = killfeedModes.merge(opts[panel.MODE_KEY], { mode: to });
		if (panel.isOn()) {
			if (killfeedModes.$panel(panel).length) { killfeedModes.show(panel, to); } else { panel.addWidget(); }
		}
		if (typeof opts.save === "function") { opts.save(); }
	},

	/** Add, remove or switch the panel to match the options (after Settings Save / Reset and on page load) */
	sync: function(panel) {
		if (!panel.isOn()) { panel.removeWidget(); return; }
		if (!killfeedModes.$panel(panel).length) { panel.addWidget(); return; }
		killfeedModes.show(panel, killfeedModes.modeOf(killfeedModes.opts(), panel.MODE_KEY));
		const $w = killfeedModes.$panel(panel);
		if ($w.hasClass("skm-floating")) { killfeedModes.updateTitle(panel); }
	},

	/** Set the floating dialog's title (no-op for a layout panel) */
	updateTitle: function(panel) {
		const $host = killfeedModes.$panel(panel).closest(".skm-float-host");
		if ($host.hasClass("ui-dialog-content")) { $host.dialog("option", "title", panel.title()); }
	},

	/** Remember the floating panel's place and size once it has settled */
	queueSave: function(panel) {
		clearTimeout(killfeedModes.saveTimers[panel.MODE_KEY]);
		killfeedModes.saveTimers[panel.MODE_KEY] = setTimeout(function() {
			delete killfeedModes.saveTimers[panel.MODE_KEY];
			killfeedModes.saveGeometry(panel, true);
		}, killfeedModes.SAVE_DELAY_MS);
	},

	/** A pending geometry save happens now (the dialog is about to go) */
	flushSave: function(panel) {
		if (!killfeedModes.saveTimers[panel.MODE_KEY]) { return; }
		clearTimeout(killfeedModes.saveTimers[panel.MODE_KEY]);
		delete killfeedModes.saveTimers[panel.MODE_KEY];
		killfeedModes.saveGeometry(panel, false);	// whoever removes it saves the options
	},

	saveGeometry: function(panel, save) {
		const opts = killfeedModes.opts();
		const $host = killfeedModes.$panel(panel).closest(".skm-float-host");
		if (!opts || !$host.hasClass("ui-dialog-content")) { return; }
		const $d = $host.dialog("widget");
		// CSS values, not offset() (zoomed screen pixels with Settings > UI Scale). jQuery UI takes `width` as the
		// CSS width but `height` as the outer height.
		const view = panelHost.viewport();
		const px = function(name) { return parseFloat($d.css(name)) || 0; };
		opts[killfeedModes.PLACES_KEY] = killfeedModes.withPlace(opts, panel.MODE_KEY, { float: {
			left: Math.round(px("left") - view.left), top: Math.round(px("top") - view.top),
			width: Math.round(px("width")), height: Math.round(px("height") + panelHost.chrome($d).h) } });
		if (save && typeof opts.save === "function") { opts.save(); }
	},

	/** Settings > Kills & Intel select for the panel's mode, under its on/off checkbox */
	registerSetting: function(panel, def) {
		forkSettings.register({
			section: "intel", order: def.order, id: panel.MODE_KEY + "-mode", type: "select", key: panel.MODE_KEY,
			label: def.label, choices: killfeedModes.choices(), hint: def.hint, keywords: ["float", "floating", "minimize", "minimized", "dock", "window"],
			get: function(o) { return killfeedModes.modeOf(o, panel.MODE_KEY); },
			set: function(o, value) { o[panel.MODE_KEY] = killfeedModes.merge(o[panel.MODE_KEY], { mode: killfeedModes.normalize(value) }); }
		});
	},

	/** Command palette: float/dock and minimize/restore the panel */
	registerCommands: function(panel, def) {
		if (typeof forkCommands === "undefined") { return; }
		const available = function() {
			if ($("#dialog-options").is(":visible")) { return "Close Settings first"; }
			return panel.isOn() ? true : "The panel is turned off";
		};
		const mode = function() { return killfeedModes.modeOf(killfeedModes.opts(), panel.MODE_KEY); };
		forkCommands.register({
			id: def.id + ".float", title: "Float or dock " + def.name, group: "Panels", icon: "fullscreen",
			keywords: (def.keywords || []).concat(["float", "dock", "window", "detach"]), enabled: available,
			hint: function() { return mode() === "floating" ? "Floating now: this docks it" : "This makes it a floating window"; },
			run: function() { killfeedModes.setMode(panel, mode() === "floating" ? "fixed" : "floating"); }
		});
		forkCommands.register({
			id: def.id + ".minimize", title: "Minimize or restore " + def.name, group: "Panels", icon: "minus",
			keywords: (def.keywords || []).concat(["minimize", "restore", "shrink", "compact"]), enabled: available,
			hint: function() { return mode() === "minimized" ? "Minimized now: this restores it" : "This shows only the most recent kill"; },
			run: function() { killfeedModes.setMode(panel, mode() === "minimized" ? "fixed" : "minimized"); }
		});
	}
};
