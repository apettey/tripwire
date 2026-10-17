const panelHost = {
	// Panel host (fork-owned): the gridster plumbing and floating-window geometry the fork's panels share, and a list of
	// those panels. Each panel keeps its own content, timers, requests and settings; this file only places, adds and
	// removes it. Panels: System kills, Chain kills, Intel, Structures, Watchlist, Favourites and the Jump planner;
	// panel-modes.js adds upstream's System info, Signatures and Notes. The chain map is not registered.
	// Every registered panel can be docked (a layout panel), popped out, shown small or minimized: panel-modes.js.
	// addGridWidget / removeGridWidget hand a popped-out panel to it, so a panel's own add / remove code is the same in
	// every mode. Keep `const panelHost` on the first line: the test helper strips it to define a global. Several fork
	// files that use this one sort (and so load) before it: they only call it at run time, never at the top level. It
	// uses layoutGrid (layout-grid.js, loads first) to read layouts.
	COL_PX: 60,	// gridster widget_base_dimensions 50 + 2 * margin 5
	FLOAT: { width: 420, height: 360, minWidth: 260, minHeight: 140, top: 60, margin: 16, cascade: 28 },
	SMALL: { width: 340, height: 130, minWidth: 220, minHeight: 80 },	// a popped-out panel's small view

	// ---- Registry ----

	panels: [],

	/**
	 * Add a panel to the list (again: replaces the one with the same id). Returns def.
	 * @param def {id (element id), title (its name in menus), key (options key of its on/off setting), size {x, y, minX,
	 * minY} (gridster cells), and for panel-modes.js: small (true: has a small view), windowTitle() (the popped-out
	 * window's title, default title), defaultMode (default "fixed"), floatDefault() (optional first window place
	 * {left, top, width, height}), minSize {minWidth, minHeight} (its window's, default FLOAT's), onEscape() (Escape
	 * in its window), onResize() (after its size changed: moved, resized, docked), upstream (true: markup
	 * from tripwire.php)}
	 */
	register: function(def) {
		if (!def || !def.id) { return def; }
		panelHost.panels = panelHost.panels.filter(function(p) { return p.id !== def.id; }).concat([def]);
		return def;
	},

	get: function(id) {
		return panelHost.panels.filter(function(p) { return p.id === id; })[0] || null;
	},

	/** The registered panels, in the order they registered (a copy) */
	list: function() {
		return panelHost.panels.slice();
	},

	// ---- Layout entries (pure) ----

	/** The entries of a layout (options.grid: array, object or the old {oog: ...} form) as a list (layoutGrid.entries) */
	entries: function(layout) {
		return layoutGrid.entries(layout);
	},

	/** A panel's entry in a layout as it is stored, or null */
	gridEntry: function(grid, id) {
		return panelHost.entries(grid).filter(function(e) { return e.id === id; })[0] || null;
	},

	/** A panel's saved place in a layout: {col, row, size_x, size_y}, all whole numbers above 0, or null */
	savedPosition: function(grid, id) {
		const entry = panelHost.gridEntry(grid, id);
		if (!entry) { return null; }
		const n = function(v) { const x = parseInt(v, 10); return x > 0 ? x : null; };
		const pos = { col: n(entry.col), row: n(entry.row), size_x: n(entry.size_x), size_y: n(entry.size_y) };
		return pos.col && pos.row && pos.size_x && pos.size_y ? pos : null;
	},

	/** A saved place (layout entry or position) with its size raised to the minimum: {col, row, size_x, size_y}, or null */
	atLeastMinSize: function(entry, size) {
		if (!entry) { return null; }
		const p = { col: Number(entry.col), row: Number(entry.row),
			size_x: Math.max(size.minX, Number(entry.size_x) || 0), size_y: Math.max(size.minY, Number(entry.size_y) || 0) };
		return p.col >= 1 && p.row >= 1 ? p : null;
	},

	/** The place a panel had when it was turned off (options.<key>.position, see removeGridWidget), or null */
	rememberedPosition: function(opts, key, id) {
		const p = opts && opts[key] ? opts[key].position : null;
		return p ? panelHost.savedPosition([Object.assign({}, p, { id: id })], id) : null;
	},

	/**
	 * Where a panel without a saved place goes: right of the top widgets when the window has room for it, otherwise
	 * under everything in the first column.
	 * @param widgets [{col, row, size_x, size_y}] the other widgets; @param size {x, y} the panel's size
	 */
	defaultPosition: function(widgets, viewportWidth, size) {
		let maxCol = 0, maxRow = 0;
		(widgets || []).forEach(function(w) {
			maxCol = Math.max(maxCol, (w.col || 1) + (w.size_x || 1) - 1);
			maxRow = Math.max(maxRow, (w.row || 1) + (w.size_y || 1) - 1);
		});
		if (maxCol && (maxCol + size.x) * panelHost.COL_PX <= (viewportWidth || 0) - 40) {
			return { col: maxCol + 1, row: 1, size_x: size.x, size_y: size.y };
		}
		return { col: 1, row: maxRow + 1, size_x: size.x, size_y: size.y };
	},

	/** A layout without a panel's entry (nor its "<id>-removed" one), in the form it came in. Never mutates. */
	withoutEntry: function(grid, id) {
		if (!grid || typeof grid !== "object") { return grid; }
		const gone = function(e) { return e && (e.id === id || e.id === id + "-removed"); };
		const strip = function(source) {
			if (Array.isArray(source)) { return source.filter(function(e) { return !gone(e); }); }
			const out = {};
			Object.keys(source || {}).forEach(function(k) { if (!gone(source[k])) { out[k] = source[k]; } });
			return out;
		};
		if (grid.oog && typeof grid.oog === "object" && !Array.isArray(grid)) { return Object.assign(strip(grid), { oog: strip(grid.oog) }); }
		return strip(grid);
	},

	/** Whether a layout has a panel's entry (or its "<id>-removed" one) */
	hasEntry: function(grid, id) {
		return JSON.stringify(panelHost.withoutEntry(grid, id)) !== JSON.stringify(grid);
	},

	// ---- Floating geometry (pure) ----

	/**
	 * Default floating geometry: right side under the top bar; each next panel (index) a step further down and left,
	 * so several popped-out panels don't cover each other exactly.
	 * @param chrome the dialog's border + padding width (`width` is its CSS width, `height` its outer height)
	 * @param size optional {width, height} instead of FLOAT's (the small view: SMALL)
	 */
	defaultFloat: function(index, viewportWidth, viewportHeight, chrome, size) {
		const f = panelHost.FLOAT;
		const s = size || f;
		const i = Math.max(0, parseInt(index, 10) || 0);
		return { left: Math.round((viewportWidth || 0) - s.width - (Number(chrome) || 0) - f.margin - i * f.cascade), top: f.top + i * f.cascade,
			width: s.width, height: s.height };
	},

	/**
	 * Floating geometry that fits the viewport: saved values where valid, defaults for the rest, then size and
	 * position clamped so the whole panel is on screen (as much as the viewport allows).
	 * Viewport and geometry in CSS pixels of the (UI-scaled) page. `width` is the dialog's CSS width, which jQuery UI
	 * takes without its border and padding (`chrome`), so the outer width (width + chrome) is what has to fit.
	 * @param size optional {width, height, minWidth, minHeight} instead of FLOAT's (the small view: SMALL)
	 * @param fallback optional geometry used instead of the default place for missing values (in the same pixels)
	 */
	clampFloat: function(geom, viewportWidth, viewportHeight, index, chrome, size, fallback) {
		const f = size || panelHost.FLOAT;
		const extra = Math.max(0, Number(chrome) || 0);
		// Whole pixels, rounded down: a window even a fraction of a pixel too big makes the page scroll
		const vw = Math.max(0, Math.floor((Number(viewportWidth) || 0) - extra));	// room for the CSS width
		const vh = Math.max(0, Math.floor(Number(viewportHeight) || 0));
		const def = Object.assign(panelHost.defaultFloat(index, vw + extra, vh, extra, f), fallback && typeof fallback === "object" ? fallback : {});
		const g = geom && typeof geom === "object" ? geom : {};
		const num = function(v, fallback) { const n = Number(v); return v !== null && v !== "" && isFinite(n) ? n : fallback; };
		const clamp = function(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
		const width = Math.round(clamp(num(g.width, num(def.width, f.width)), Math.min(f.minWidth, vw), Math.max(Math.min(f.minWidth, vw), vw)));
		const height = Math.round(clamp(num(g.height, num(def.height, f.height)), Math.min(f.minHeight, vh), Math.max(Math.min(f.minHeight, vh), vh)));
		const left = Math.round(clamp(num(g.left, def.left), 0, Math.max(0, vw - width)));
		const top = Math.round(clamp(num(g.top, def.top), 0, Math.max(0, vh - height)));
		return { left: left, top: top, width: width, height: height };
	},

	// ---- Browser-only code below (not run under mocha) ----

	opts: function() {
		return typeof options !== "undefined" ? options : null;
	},

	/** The layout (global `grid` from layout.js), or null before it exists */
	gridster: function() {
		return typeof grid !== "undefined" && grid && typeof grid.add_widget === "function" ? grid : null;
	},

	/** Settings > General > UI Scale: the body's CSS zoom */
	zoom: function() {
		return parseFloat($("body").css("zoom")) || 1;
	},

	/** Viewport size and scroll in CSS pixels of the zoomed page */
	viewport: function() {
		const z = panelHost.zoom();
		// clientWidth/Height: without scrollbars (the html element is not zoomed)
		const root = document.documentElement;
		return { width: (root.clientWidth || $(window).width()) / z, height: (root.clientHeight || $(window).height()) / z, left: $(window).scrollLeft() / z, top: $(window).scrollTop() / z };
	},

	/** A dialog's border + padding (CSS pixels): {w, h} */
	chrome: function($d) {
		const px = function(name) { return parseFloat($d.css(name)) || 0; };
		return { w: px("border-left-width") + px("border-right-width") + px("padding-left") + px("padding-right"),
			h: px("border-top-width") + px("border-bottom-width") + px("padding-top") + px("padding-bottom") };
	},

	/** Layout columns that fit in the window (widget_base_dimensions + margins, UI scale) */
	availableCols: function(g) {
		const o = (g && g.options) || {};
		const step = ((o.widget_base_dimensions || [50])[0]) + 2 * ((o.widget_margins || [5])[0]);
		return Math.floor((window.innerWidth || $(window).width()) / panelHost.zoom() / step);
	},

	/** The places of the widgets in the layout now: [{col, row, size_x, size_y}] */
	occupied: function() {
		return $(".gridster li.gridWidget").map(function() {
			return { col: parseInt($(this).attr("data-col"), 10), row: parseInt($(this).attr("data-row"), 10),
				size_x: parseInt($(this).attr("data-sizex"), 10), size_y: parseInt($(this).attr("data-sizey"), 10) };
		}).get();
	},

	/** Close the shared tooltip and release the ones attached inside $w (the jBox tooltip keeps them until detached) */
	releaseTooltips: function($w) {
		if (typeof Tooltips === "undefined") { return; }
		if (Tooltips.close) { Tooltips.close(); }
		const $tips = $w.find("[data-tooltip]");
		if (Tooltips.detach && $tips.length) { Tooltips.detach($tips); }
	},

	/**
	 * Add a panel to the layout. Returns the widget, or null (no layout yet, or the panel is in it already).
	 * Where it goes: o.place(others, g) when given, else the place it had when it was turned off (o.remember), the saved
	 * layout, then o.fallback(others, g) (default: panelHost.defaultPosition).
	 * @param def {id, size {x, y, minX, minY}}; @param html the <li id='<id>' class='gridWidget'> element
	 * @param o {place, remember (options key, see removeGridWidget; the layout owns the place once it is used),
	 *   fallback, sizeY (rows instead of the place's), minY (instead of size.minY), fadeIn (keep gridster's fade-in;
	 *   default: skip it, as it never finishes in a background tab), transition (false: no gridster-transition class)}
	 */
	addGridWidget: function(def, html, o) {
		const g = panelHost.gridster();
		if (!g) { return null; }
		o = o || {};
		const $old = $("#" + def.id);
		if ($old.length) {
			if (!$old.is("li.gridWidget") || g.$widgets.is($old) || $old.hasClass("ph-floating")) { return null; }
			$old.stop(true, true).remove();	// left over from a removal still fading out
		}
		// Popped out (panel-modes.js): a window instead of a layout panel
		const $popped = typeof panelModes !== "undefined" ? panelModes.addPopped(def, html) : null;
		if ($popped) { return $popped; }
		const size = def.size;
		const opts = panelHost.opts();
		const others = panelHost.occupied();
		let pos = o.place ? o.place(others, g) : null;
		if (!pos) {
			// options.grid can be the page-load copy (options.apply() restores it from local storage): the place it was
			// turned off at goes first
			pos = (o.remember ? panelHost.rememberedPosition(opts, o.remember, def.id) : null)
				|| panelHost.savedPosition(opts ? opts.grid : null, def.id)
				|| (o.fallback ? o.fallback(others, g) : panelHost.defaultPosition(others, panelHost.viewport().width, size));
			// From now on the layout (Customize layout) owns the place
			if (o.remember && opts && opts[o.remember] && opts[o.remember].position) { delete opts[o.remember].position; }
		}
		const $w = g.add_widget(html, pos.size_x, o.sizeY || pos.size_y, pos.col, pos.row, null, [size.minX, o.minY || size.minY]);
		if (!o.fadeIn) { $w.stop(true, true); }
		// Same as layout.js does for the built-in widgets: resize handle only while customising the layout
		$w.find(".grid-resize").attr("data-icon", "resize").toggleClass("hidden", !$("#layout").hasClass("active"));
		if (o.transition !== false) { $w.addClass("gridster-transition"); }
		if (typeof panelModes !== "undefined") { panelModes.added(def, $w); }	// header buttons, Panels menu
		return $w;
	},

	/**
	 * Remove a panel from the layout.
	 * @param o {remember (options key: keep its place in options.<key>.position, so turning it back on puts it there),
	 *   closeGap (true: the panels under it move up), finishFade (remove it now instead of after gridster's fade-out)}
	 */
	removeGridWidget: function(def, $w, o) {
		if (!$w || !$w.length) { return; }
		o = o || {};
		// A popped-out panel: close its window (panel-modes.js); its layout place stays in options.grid
		if (typeof panelModes !== "undefined" && panelModes.removePopped(def, $w)) { return; }
		const g = panelHost.gridster();
		const opts = panelHost.opts();
		panelHost.releaseTooltips($w);
		if (o.remember && g && opts) {
			const entry = panelHost.savedPosition(g.serialize($w), def.id);
			if (entry) { opts[o.remember] = Object.assign({}, opts[o.remember] || {}, { position: entry }); }
		}
		// Drop the id first: gridster fades the widget out before removing it, and adding the panel again meanwhile
		// must add a new one
		$w.attr("id", def.id + "-removed");
		if (!g) { $w.remove(); return; }
		g.remove_widget($w, !o.closeGap);
		if (o.finishFade) { $w.stop(true, true); }	// the fade-out's end removes the element
		if (typeof panelModes !== "undefined") { panelModes.updateBadge(); }
	}
};
