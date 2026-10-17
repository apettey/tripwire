const panelModes = {
	// Panel display modes (fork-owned): every panel except the chain map (and the Region map, a window of its own) can be
	//   fixed      docked: a layout (gridster) panel, as it always was (moved and resized with Customize layout)
	//   floating   popped out: a non-modal window inside the page you can move and resize
	//   small      popped out, small view: a small window (panels whose panelHost def says small: true; the panel's CSS
	//              shows its compact content under .ph-small)
	//   minimized  popped out, nothing visible: the window is hidden, the panel keeps running; the Panels menu in the top
	//              bar (badge = how many) restores it
	// A built-in feature, without a Settings row (the user's choice; AGENTS.md's toggle rule doesn't apply). Per user:
	// options.panels.<id>.mode (missing or unknown = the panel's default, "fixed"), and where its windows were in
	// options.panelPlaces.<id> = {float: {left, top, width, height}, small: {...}, restore: "floating" | "small"}. Neither
	// is a Settings row, so a mask default (mask-defaults.js) never carries them. A popped-out panel's layout entry stays in
	// options.grid (layoutGrid.merge keeps entries of panels not in the layout), so docking puts it back where it was.
	// Switched from buttons at the top right of each panel (in the window's title bar when popped out), the Panels menu
	// and the command palette.
	// How: the panel's element itself moves (the <li> with its id, children, data and event handlers): out of gridster
	// into a jQuery UI dialog, and back. Nothing is rebuilt, so upstream's panels (System info, Signatures, Notes) work
	// the same as the fork's, whose add / remove go through panelHost.addGridWidget / removeGridWidget (they call
	// addPopped / removePopped here). Geometry helpers: panel-host.js. Keep `const panelModes` on the first line: the test
	// helper strips it to define a global.
	MODES: ["fixed", "floating", "small", "minimized"],
	LABELS: { fixed: "Docked", floating: "Popped out", small: "Small view", minimized: "Minimized" },
	OPTIONS_KEY: "panels",
	PLACES_KEY: "panelPlaces",
	SAVE_DELAY_MS: 800,	// moving or resizing a window saves once it has settled
	// Upstream's panels (tripwire.php), first in menus. size: tripwire.php's defaults (data-sizex/-sizey/-min-size*).
	UPSTREAM: [
		{ id: "infoWidget", title: "System info", size: { x: 7, y: 6, minX: 5, minY: 4 } },
		{ id: "signaturesWidget", title: "Signatures", size: { x: 7, y: 6, minX: 5, minY: 2 } },
		{ id: "notesWidget", title: "Notes", size: { x: 7, y: 6, minX: 5, minY: 2 } }
	],
	// #115 kept the kill panels' mode in options.<key>.mode ("minimized" was: shrunk in the layout) and their window in
	// options.killPanelPlaces.<key>.float
	// options.killPanelPlaces.<key>.fullSizeY: the height before minimizing (its layout entry kept the 2 rows it shrank to)
	LEGACY: [{ key: "systemKillFeed", id: "systemKillFeedWidget", minY: 3 }, { key: "chainKillFeed", id: "chainKillFeedWidget", minY: 3 }],
	LEGACY_PLACES_KEY: "killPanelPlaces",
	LEGACY_MODES: { fixed: "fixed", minimized: "small", floating: "floating" },

	isObject: function(v) {
		return !!v && typeof v === "object" && !Array.isArray(v);
	},

	/** The modes a panel can be in (small only when it has a small view) */
	allowed: function(def) {
		return panelModes.MODES.filter(function(m) { return m !== "small" || !!(def && def.small); });
	},

	/** The panel's mode when nothing (valid) is stored: def.defaultMode when allowed, else fixed */
	defaultMode: function(def) {
		const m = def && def.defaultMode;
		return m && panelModes.allowed(def).indexOf(m) >= 0 ? m : "fixed";
	},

	/** A mode the panel can be in: unknown = its default, small without a small view = floating */
	normalize: function(mode, def) {
		if (panelModes.allowed(def).indexOf(mode) >= 0) { return mode; }
		return mode === "small" ? "floating" : panelModes.defaultMode(def);
	},

	/** The panel's mode in the user options */
	modeOf: function(opts, def) {
		const all = opts && panelModes.isObject(opts[panelModes.OPTIONS_KEY]) ? opts[panelModes.OPTIONS_KEY] : {};
		const entry = def && panelModes.isObject(all[def.id]) ? all[def.id] : {};
		return panelModes.normalize(entry.mode, def);
	},

	/** A new options.panels with the panel's mode set (other panels and fields kept). Never mutates. */
	withMode: function(opts, id, mode) {
		const all = opts && panelModes.isObject(opts[panelModes.OPTIONS_KEY]) ? opts[panelModes.OPTIONS_KEY] : {};
		const out = Object.assign({}, all);
		out[id] = Object.assign({}, panelModes.isObject(all[id]) ? all[id] : {}, { mode: mode });
		return out;
	},

	/** Where the panel's windows were: options.panelPlaces.<id>, {} when nothing is stored */
	place: function(opts, id) {
		const all = opts ? opts[panelModes.PLACES_KEY] : null;
		const v = panelModes.isObject(all) ? all[id] : null;
		return panelModes.isObject(v) ? v : {};
	},

	/** A new options.panelPlaces with `patch` merged into the panel's entry. Never mutates. */
	withPlace: function(opts, id, patch) {
		const all = opts && panelModes.isObject(opts[panelModes.PLACES_KEY]) ? opts[panelModes.PLACES_KEY] : {};
		const out = Object.assign({}, all);
		out[id] = Object.assign({}, panelModes.place(opts, id), patch || {});
		return out;
	},

	/** The popped-out mode a minimized panel comes back in: the one it had (floating or small), else floating */
	restoreMode: function(opts, def) {
		const r = panelModes.place(opts, def ? def.id : null).restore;
		return r === "small" && def && def.small ? "small" : "floating";
	},

	/**
	 * The window's size limits in a shape ("floating" or "small"): panelHost's FLOAT or SMALL ({width, height, minWidth,
	 * minHeight}), with the panel's own def.minSize {minWidth, minHeight} for its normal window (the Jump planner's is bigger)
	 */
	sizeFor: function(def, shape, sizes) {
		const base = Object.assign({}, shape === "small" ? sizes.SMALL : sizes.FLOAT);
		const min = def && def.minSize;
		if (shape !== "small" && min && typeof min === "object") {
			["minWidth", "minHeight"].forEach(function(k) { const v = Number(min[k]); if (v > 0) { base[k] = v; } });
			base.width = Math.max(base.width, base.minWidth);
			base.height = Math.max(base.height, base.minHeight);
		}
		return base;
	},

	/**
	 * The mode a panel keeps once it is turned off (or closed): a minimized one is not invisible when it comes back,
	 * it takes its restore mode; any other mode stays.
	 */
	afterRemove: function(opts, def) {
		const mode = panelModes.modeOf(opts, def);
		return mode === "minimized" ? panelModes.restoreMode(opts, def) : mode;
	},

	/**
	 * A layout (options.grid in any of its forms) with one panel's entry's size_y set, in the form it came in; null when
	 * the layout has no such entry. Never mutates.
	 */
	withEntrySizeY: function(grid, id, sizeY) {
		if (!grid || typeof grid !== "object") { return null; }
		let found = false;
		const fix = function(e) {
			if (!e || typeof e !== "object" || e.id !== id) { return e; }
			found = true;
			return Object.assign({}, e, { size_y: sizeY });
		};
		const map = function(source) {
			if (Array.isArray(source)) { return source.map(fix); }
			const out = {};
			Object.keys(source || {}).forEach(function(k) { out[k] = fix(source[k]); });
			return out;
		};
		const usesOog = grid.oog && typeof grid.oog === "object" && !Array.isArray(grid) && Object.keys(grid.oog).length;
		const out = usesOog ? Object.assign({}, grid, { oog: map(grid.oog) }) : map(grid);
		return found ? out : null;
	},

	/**
	 * Header buttons for a mode, left to right: [{to (mode to switch to), icon, tooltip}]. The size button comes first,
	 * Minimize next, Dock last, in every mode.
	 *   fixed: Pop out, Small view (if any), Minimize; floating: Small view (if any), Minimize, Dock;
	 *   small: Normal size, Minimize, Dock; minimized (no window: the Panels menu): Restore, Dock
	 */
	buttons: function(mode, def) {
		const m = panelModes.normalize(mode, def);
		const small = !!(def && def.small);
		const b = {
			pop: { to: "floating", icon: "fullscreen", tooltip: "Pop out: a window you can move and resize" },
			normal: { to: "floating", icon: "fullscreen", tooltip: "Normal size" },
			small: { to: "small", icon: "fullscreen-exit", tooltip: "Small view: a small window with only the newest" },
			min: { to: "minimized", icon: "minus", tooltip: "Minimize: hide it (bring it back from the Panels menu at the top right)" },
			dock: { to: "fixed", icon: "pin", tooltip: "Dock back into the layout" }
		};
		if (m === "fixed") { return [b.pop].concat(small ? [b.small] : [], [b.min]); }
		if (m === "floating") { return (small ? [b.small] : []).concat([b.min, b.dock]); }
		if (m === "small") { return [b.normal, b.min, b.dock]; }
		return [{ to: "restore", icon: "plus", tooltip: "Restore" }, b.dock];
	},

	/** The buttons as HTML (for the panel header or the window's title bar) */
	buttonsHtml: function(mode, def) {
		return panelModes.buttons(mode, def).map(function(b) {
			return "<i class='ph-btn' data-ph-id='" + def.id + "' data-ph-to='" + b.to + "' data-icon='" + b.icon + "' data-tooltip='" + b.tooltip + "'></i>";
		}).join("");
	},

	/** Panels menu actions for a mode: [{to, label}] ("restore" = back to restoreMode) */
	actions: function(mode, def) {
		const m = panelModes.normalize(mode, def);
		const small = !!(def && def.small);
		if (m === "minimized") { return [{ to: "restore", label: "Restore" }, { to: "fixed", label: "Dock" }]; }
		const out = [];
		if (m !== "fixed") { out.push({ to: "fixed", label: "Dock" }); }
		if (m !== "floating") { out.push({ to: "floating", label: m === "small" ? "Normal size" : "Pop out" }); }
		if (small && m !== "small") { out.push({ to: "small", label: "Small view" }); }
		out.push({ to: "minimized", label: "Minimize" });
		return out;
	},

	/**
	 * The Panels menu: a row for every panel that is on (shown(id) true), in `defs` order, and the badge (how many of
	 * them are minimized). rows: [{id, title, mode, label, actions}]
	 */
	menuModel: function(defs, opts, shown) {
		const rows = (defs || []).filter(function(d) { return d && d.id && (!shown || shown(d.id)); }).map(function(d) {
			const mode = panelModes.modeOf(opts, d);
			return { id: d.id, title: d.title || d.id, mode: mode, label: panelModes.LABELS[mode], actions: panelModes.actions(mode, d) };
		});
		return { rows: rows, badge: rows.filter(function(r) { return r.mode === "minimized"; }).length };
	},

	/** Palette commands per panel: [{verb, to}] ("restore" = back to restoreMode); Small view only with a small view */
	commandList: function(def) {
		const out = [{ verb: "Pop out", to: "floating" }, { verb: "Dock", to: "fixed" }, { verb: "Minimize", to: "minimized" }, { verb: "Restore", to: "restore" }];
		if (def && def.small) { out.push({ verb: "Small view", to: "small" }); }
		return out;
	},

	/**
	 * Whether a palette command can run now: true, or why not.
	 * @param mode the panel's mode now; @param shown whether the panel is on (in the page)
	 */
	commandState: function(def, mode, to, shown) {
		if (!shown) { return (def && def.offReason) || "The panel is turned off"; }
		const m = panelModes.normalize(mode, def);
		if (to === "restore") { return m === "minimized" ? true : "It isn't minimized"; }
		if (to === "small" && !(def && def.small)) { return "It has no small view"; }
		if (to === m) { return "Already " + { fixed: "docked", floating: "popped out", small: "in small view", minimized: "minimized" }[m]; }
		return true;
	},

	/**
	 * #115's kill panel modes moved to options.panels (floating = floating, minimized = small, fixed = fixed) and their
	 * window places to options.panelPlaces.<id>.float; then the old keys go. A mode already in options.panels wins.
	 * Returns {changed, set: {optionsKey: newValue}, remove: [optionsKey]}. Never mutates; running it on its own result
	 * changes nothing (idempotent).
	 */
	migrate: function(opts) {
		const out = { changed: false, set: {}, remove: [] };
		if (!panelModes.isObject(opts)) { return out; }
		const layoutGridEntry = function(grid, id) {
			if (!grid || typeof grid !== "object") { return null; }
			const source = grid.oog && typeof grid.oog === "object" && !Array.isArray(grid) && Object.keys(grid.oog).length ? grid.oog : grid;
			const list = Array.isArray(source) ? source : Object.keys(source).map(function(k) { return source[k]; });
			return list.filter(function(e) { return e && typeof e === "object" && e.id === id; })[0] || null;
		};
		let panels = panelModes.isObject(opts[panelModes.OPTIONS_KEY]) ? opts[panelModes.OPTIONS_KEY] : null;
		let places = panelModes.isObject(opts[panelModes.PLACES_KEY]) ? opts[panelModes.PLACES_KEY] : null;
		const old = panelModes.isObject(opts[panelModes.LEGACY_PLACES_KEY]) ? opts[panelModes.LEGACY_PLACES_KEY] : null;
		panelModes.LEGACY.forEach(function(l) {
			const entry = opts[l.key];
			if (panelModes.isObject(entry) && entry.mode !== undefined) {
				const mode = panelModes.LEGACY_MODES[entry.mode];
				const has = panels && panelModes.isObject(panels[l.id]) && panels[l.id].mode !== undefined;
				if (mode && mode !== "fixed" && !has) {
					panels = Object.assign({}, panels || {});
					panels[l.id] = Object.assign({}, panelModes.isObject(panels[l.id]) ? panels[l.id] : {}, { mode: mode });
					out.set[panelModes.OPTIONS_KEY] = panels;
				}
				const rest = Object.assign({}, entry);
				delete rest.mode;
				out.set[l.key] = rest;
				out.changed = true;
			}
			// Minimized in the layout (#115) left its entry at 2 rows: give it back the height it had
			const full = old && panelModes.isObject(old[l.key]) ? parseInt(old[l.key].fullSizeY, 10) : NaN;
			if (full >= l.minY) {
				const grid = out.set.grid || opts.grid;
				const entry = layoutGridEntry(grid, l.id);
				if (entry && !(parseInt(entry.size_y, 10) >= l.minY)) {
					const fixed = panelModes.withEntrySizeY(grid, l.id, full);
					if (fixed) { out.set.grid = fixed; out.changed = true; }
				}
			}
			const geom = old && panelModes.isObject(old[l.key]) && panelModes.isObject(old[l.key].float) ? old[l.key].float : null;
			const hasFloat = places && panelModes.isObject(places[l.id]) && places[l.id].float !== undefined;
			if (geom && !hasFloat) {
				places = Object.assign({}, places || {});
				places[l.id] = Object.assign({}, panelModes.isObject(places[l.id]) ? places[l.id] : {}, { float: Object.assign({}, geom) });
				out.set[panelModes.PLACES_KEY] = places;
			}
		});
		if (opts[panelModes.LEGACY_PLACES_KEY] !== undefined) {
			out.remove.push(panelModes.LEGACY_PLACES_KEY);
			out.changed = true;
		}
		return out;
	},

	// ---- Browser-only code below (not run under mocha) ----

	saveTimers: {},
	migrated: false,

	opts: function() {
		return typeof options !== "undefined" ? options : null;
	},

	/** The registered panels (panelHost), upstream's first */
	defs: function() {
		const list = typeof panelHost !== "undefined" ? panelHost.list() : [];
		const rank = function(d) { return d.upstream ? 0 : 1; };
		return list.map(function(d, i) { return { d: d, i: i }; })
			.sort(function(a, b) { return rank(a.d) - rank(b.d) || a.i - b.i; }).map(function(x) { return x.d; });
	},

	defOf: function(id) {
		return typeof panelHost !== "undefined" ? panelHost.get(id) : null;
	},

	$el: function(id) {
		return $(document.getElementById(id));
	},

	/** Whether the panel is in the page (on, or open for the Jump planner) */
	isShown: function(id) {
		return panelModes.$el(id).length > 0;
	},

	/** Run #115's migration once (the first panel added asks for its mode: kill panels may come before init) */
	ensureMigrated: function() {
		if (panelModes.migrated) { return; }
		const opts = panelModes.opts();
		if (!opts) { return; }
		panelModes.migrated = true;
		// A mask default (mask-defaults.js) may still carry an old mode: it isn't the member's, leave it
		const inherited = typeof maskDefaults !== "undefined" && maskDefaults.inherited ? maskDefaults.inherited : {};
		const source = Object.assign({}, opts.get ? opts.get() : opts);
		panelModes.LEGACY.forEach(function(l) { if (inherited[l.key] !== undefined) { delete source[l.key]; } });
		const m = panelModes.migrate(source);
		if (!m.changed) { return; }
		Object.keys(m.set).forEach(function(k) { opts[k] = m.set[k]; });
		m.remove.forEach(function(k) { delete opts[k]; });
		if (typeof opts.save === "function") { setTimeout(function() { opts.save(); }, 0); }
	},

	/** The panel's mode now (from the options) */
	modeFor: function(id) {
		panelModes.ensureMigrated();
		return panelModes.modeOf(panelModes.opts(), panelModes.defOf(id) || { id: id });
	},

	/** The mode the panel's element is shown in (fixed when in the layout), or null when it isn't in the page */
	shownMode: function(id) {
		const $w = panelModes.$el(id);
		if (!$w.length) { return null; }
		return $w.hasClass("ph-floating") ? ($w.attr("data-ph-mode") || "floating") : "fixed";
	},

	title: function(def) {
		const t = typeof def.windowTitle === "function" ? def.windowTitle() : def.title;
		return t || def.id;
	},

	// ---- Windows ----

	/** {left, top, width, height} for the panel's window in `mode` (CSS px of the zoomed page, viewport-relative) */
	geometry: function(def, mode, chrome) {
		const small = mode === "small";
		const size = panelModes.sizeFor(def, small ? "small" : "floating", panelHost);
		const place = panelModes.place(panelModes.opts(), def.id);
		const view = panelHost.viewport();
		const index = Math.max(0, panelModes.defs().indexOf(def));
		const fallback = !small && typeof def.floatDefault === "function" ? def.floatDefault(view) : null;
		return panelHost.clampFloat(small ? place.small : place.float, view.width, view.height, index, chrome || 0, size, fallback);
	},

	/** Pop the panel's element out into a window (minimized: a hidden one) */
	float: function(def, $w, mode) {
		const shape = mode === "minimized" ? panelModes.restoreMode(panelModes.opts(), def) : mode;
		const size = panelModes.sizeFor(def, shape === "small" ? "small" : "floating", panelHost);
		let geom = panelModes.geometry(def, shape);
		// The dialog element is a host: jQuery UI sizes it, and options.apply() (which writes saved layout sizes onto the
		// element with the panel's id) only reaches the panel inside it, whose size the CSS fixes
		const $host = $("<div class='ph-float-host'></div>").attr("data-ph-for", def.id).appendTo("body");
		$w.removeClass("gridster-transition").addClass("ph-floating").toggleClass("ph-small", shape === "small").attr("data-ph-mode", mode).appendTo($host);
		$host.dialog({
			title: panelModes.title(def), modal: false, resizable: true, closeOnEscape: false, autoOpen: true,
			width: geom.width, height: geom.height, minWidth: Math.min(size.minWidth, geom.width), minHeight: Math.min(size.minHeight, geom.height),
			dialogClass: "dialog-noeffect ui-dialog-shadow dialog-floating ph-dialog" + (shape === "small" ? " ph-dialog-small" : ""),
			// dialog-floating: a window that stays open while you work (floating-windows.js: no blur, Follow keeps working)
			dragStop: function() { panelModes.queueSave(def); },
			resizeStop: function() { panelModes.queueSave(def); panelModes.resized(def); }
		});
		const $d = $host.dialog("widget");
		// Now that the dialog's border and padding are known: fit its outer width into the viewport
		const view = panelHost.viewport();
		geom = panelModes.geometry(def, shape, panelHost.chrome($d).w);
		$host.dialog("option", { width: geom.width, height: geom.height });
		$d.css({ left: geom.left + view.left, top: geom.top + view.top });
		// Mode buttons instead of the X; a click on them is not the start of a drag
		$d.find(".ui-dialog-titlebar").append("<span class='ph-buttons ph-title-buttons'></span>");
		if ($d.is(":data(ui-draggable)")) { $d.draggable("option", "cancel", ".ui-dialog-content, .ui-dialog-titlebar-close, .ph-buttons"); }
		$d.toggleClass("ph-minimized", mode === "minimized");
		// A panel that closes on Escape (the Jump planner): while its window has the focus
		if (typeof def.onEscape === "function") {
			$d.on("keydown", function(e) {
				if (e.key === "Escape" && !e.isDefaultPrevented() && !$(e.target).closest(".ph-buttons").length) { e.preventDefault(); def.onEscape(); }
			});
		}
		return $w;
	},

	/** Take the panel's element out of its window (kept, not in the page) and close the window */
	unfloat: function(def, $w) {
		panelModes.flushSave(def);
		const $host = $w.closest(".ph-float-host");
		const $d = $host.hasClass("ui-dialog-content") ? $host.dialog("widget") : $();
		panelHost.releaseTooltips($d.find(".ui-dialog-titlebar"));
		$w.detach().removeClass("ph-floating ph-small").removeAttr("data-ph-mode");
		if ($host.hasClass("ui-dialog-content")) { $host.dialog("destroy"); }	// destroy doesn't fire close
		$host.remove();
		return $w;
	},

	/** Take the panel's element out of the layout without removing it (the gap it leaves stays, as for a panel turned off) */
	undock: function(def, $w) {
		const g = panelHost.gridster();
		const opts = panelModes.opts();
		if (!g || !g.$widgets.is($w)) { $w.detach(); return $w; }
		// Its place now goes into options.grid, so docking it puts it back there
		if (opts && typeof layoutGrid !== "undefined") { opts.grid = layoutGrid.merge(g.serialize(), opts.grid); }
		g.remove_widget($w, true);
		// remove_widget fades it out and then removes it: stop the fade before its end (the element is kept)
		$w.stop(true, false).css({ opacity: "", display: "" });
		if (typeof g.set_dom_grid_height === "function") { g.set_dom_grid_height(); }
		$w.children(".grid-resize").remove();	// gridster adds a new handle when it comes back
		$w.detach();
		return $w;
	},

	/** Put the panel's element (out of the page) back into the layout: its saved place, else the first free one */
	dock: function(def, $w) {
		const g = panelHost.gridster();
		if (!g) { return null; }
		const opts = panelModes.opts();
		const size = def.size || { x: 7, y: 6, minX: 4, minY: 2 };
		let pos = panelHost.savedPosition(opts ? opts.grid : null, def.id);
		pos = pos ? panelHost.atLeastMinSize(pos, size) : panelHost.defaultPosition(panelHost.occupied(), panelHost.viewport().width, size);
		$w.css({ width: "", height: "" });	// options.apply()'s sizes: gridster sizes it by its data attributes
		g.add_widget($w, pos.size_x, pos.size_y, pos.col, pos.row, null, [size.minX, size.minY]);
		$w.stop(true, true).css({ opacity: "", display: "" });	// skip the fade-in (it never ends in a background tab)
		// Same as layout.js: the resize handle only while customising the layout
		$w.find(".grid-resize").attr("data-icon", "resize").toggleClass("hidden", !$("#layout").hasClass("active"));
		$w.addClass("gridster-transition");
		return $w;
	},

	/**
	 * Notes being edited (CKEditor's iframe) don't survive a move in the page. Before the panel moves, each editor's text
	 * is taken and the editor removed without writing it into its element (which keeps the saved note, for Cancel);
	 * once the panel is in its new place the editor starts again with that text. Returns [{name, data, html}].
	 */
	suspendEditors: function($w) {
		if (typeof CKEDITOR === "undefined" || !CKEDITOR.instances) { return []; }
		const out = [];
		Object.keys(CKEDITOR.instances).forEach(function(name) {
			const inst = CKEDITOR.instances[name];
			const el = inst && inst.element ? inst.element.$ : null;
			if (el && $w[0] && $.contains($w[0], el)) {
				const html = el.innerHTML;	// the note as saved: the editor writes into it only on Save
				out.push({ name: name, data: inst.getData(), html: html });
				inst.destroy(true);	// true: don't write the unsaved text into the element
				el.innerHTML = html;
			}
		});
		return out;
	},

	resumeEditors: function(editors) {
		(editors || []).forEach(function(e) {
			if (!document.getElementById(e.name) || typeof CKEDITOR === "undefined") { return; }
			const inst = CKEDITOR.replace(e.name, typeof CKConfig !== "undefined" ? CKConfig : {});
			inst.on("instanceReady", function() { inst.setData(e.data); });
		});
	},

	/** The panel's size changed (window resized, popped out, docked): tell it (the activity graph redraws) */
	resized: function(def) {
		if (typeof def.onResize !== "function") { return; }
		setTimeout(function() {
			try { def.onResize(); } catch (err) { console.error("Panel modes: " + def.id + " resize failed", err); }
		}, 50);
	},

	/** Switch the shown panel to `mode` (it must be in the page). Returns whether anything changed. */
	show: function(def, mode) {
		const $w = panelModes.$el(def.id);
		const from = panelModes.shownMode(def.id);
		if (!from || from === mode) { return false; }
		const editors = panelModes.suspendEditors($w);
		if (from === "fixed") { panelModes.undock(def, $w); } else { panelModes.unfloat(def, $w); }
		if (mode === "fixed") { panelModes.dock(def, $w); } else { panelModes.float(def, $w, mode); }
		panelModes.resumeEditors(editors);
		panelModes.decorate(def, $w, mode);
		if (mode !== "minimized") { panelModes.resized(def); }
		if (typeof def.afterMove === "function") { def.afterMove(mode); }
		return true;
	},

	/** The user picked a mode (button, Panels menu, command): store it, show it, save. "restore" = restoreMode. */
	setMode: function(id, mode) {
		const opts = panelModes.opts();
		const def = panelModes.defOf(id);
		if (!opts || !def) { return; }
		const from = panelModes.modeFor(id);
		const to = mode === "restore" ? panelModes.restoreMode(opts, def) : panelModes.normalize(mode, def);
		if ((from === "floating" || from === "small") && to !== from) { panelModes.saveGeometry(def, false); }
		if (to === "minimized" && from !== "minimized") {
			opts[panelModes.PLACES_KEY] = panelModes.withPlace(opts, id, { restore: from === "small" ? "small" : "floating" });
		}
		opts[panelModes.OPTIONS_KEY] = panelModes.withMode(opts, id, to);
		if (panelModes.isShown(id)) { panelModes.show(def, to); }
		panelModes.updateBadge();
		if (typeof opts.save === "function") { opts.save(); }
	},

	/** Header buttons: in the panel's controls when docked, in the window's title bar when popped out */
	decorate: function(def, $w, mode) {
		const html = panelModes.buttonsHtml(mode, def);
		const $controls = $w.children(".controls").first();
		const $own = $controls.children(".ph-buttons");
		panelHost.releaseTooltips($own);
		$own.remove();
		let $buttons = $();
		if (mode === "fixed") {
			// First in the controls and floated right: the top right corner, right of the panel's own right-hand controls
			$buttons = $("<span class='ph-buttons'></span>").html(html).prependTo($controls);
		} else {
			const $host = $w.closest(".ph-float-host");
			if ($host.hasClass("ui-dialog-content")) {
				const $title = $host.dialog("widget").find(".ph-title-buttons");
				panelHost.releaseTooltips($title);
				$buttons = $title.html(html);
			}
		}
		if (typeof Tooltips !== "undefined" && $buttons.length) { Tooltips.attach($buttons.find("[data-tooltip]")); }
	},

	/** Set the window's title again (a panel whose title changes, e.g. System kills: "Kills in <system>") */
	updateTitle: function(id) {
		const def = panelModes.defOf(id);
		const $host = panelModes.$el(id).closest(".ph-float-host");
		if (def && $host.hasClass("ui-dialog-content")) { $host.dialog("option", "title", panelModes.title(def)); }
	},

	// ---- Called by panelHost ----

	/** panelHost.addGridWidget: a popped-out panel is added as a window. Returns its element, or null (docked). */
	addPopped: function(def, html) {
		const known = panelModes.defOf(def.id) || def;
		const mode = panelModes.modeFor(def.id);
		if (mode === "fixed") { return null; }
		const $w = $(html);
		panelModes.float(known, $w, mode);
		panelModes.decorate(known, $w, mode);
		panelModes.updateBadge();
		return $w;
	},

	/** panelHost.addGridWidget added a docked panel */
	added: function(def, $w) {
		panelModes.decorate(panelModes.defOf(def.id) || def, $w, "fixed");
		panelModes.updateBadge();
	},

	/** panelHost.removeGridWidget: a popped-out panel's window closes. Returns whether it was one. */
	removePopped: function(def, $w) {
		if (!$w.hasClass("ph-floating")) { return false; }
		const known = panelModes.defOf(def.id) || def;
		const opts = panelModes.opts();
		let changed = !!panelModes.saveTimers[def.id];
		panelModes.flushSave(known);	// before the id goes: a move just before still counts
		// Minimized: it comes back in its window when it is turned on (or opened) again, not invisible
		if (opts && panelModes.modeFor(def.id) === "minimized") {
			opts[panelModes.OPTIONS_KEY] = panelModes.withMode(opts, def.id, panelModes.afterRemove(opts, known));
			changed = true;
		}
		panelHost.releaseTooltips($w);
		$w.attr("id", def.id + "-removed");
		panelModes.unfloat(known, $w);
		$w.remove();
		panelModes.updateBadge();
		if (changed && opts) {
			if (typeof opts.saveDelay === "function") { opts.saveDelay(500); } else if (typeof opts.save === "function") { opts.save(); }
		}
		return true;
	},

	// ---- Geometry saving ----

	queueSave: function(def) {
		clearTimeout(panelModes.saveTimers[def.id]);
		panelModes.saveTimers[def.id] = setTimeout(function() {
			delete panelModes.saveTimers[def.id];
			panelModes.saveGeometry(def, true);
		}, panelModes.SAVE_DELAY_MS);
	},

	/** A pending save happens now (the window is about to go) */
	flushSave: function(def) {
		if (!panelModes.saveTimers[def.id]) { return; }
		clearTimeout(panelModes.saveTimers[def.id]);
		delete panelModes.saveTimers[def.id];
		panelModes.saveGeometry(def, false);	// whoever removes it saves the options
	},

	/** Remember the window's place and size (float or small, by the mode it shows) */
	saveGeometry: function(def, save) {
		const opts = panelModes.opts();
		const $w = panelModes.$el(def.id);
		const $host = $w.closest(".ph-float-host");
		const mode = $w.attr("data-ph-mode");
		if (!opts || !$host.hasClass("ui-dialog-content") || (mode !== "floating" && mode !== "small")) { return; }
		const $d = $host.dialog("widget");
		// CSS values, not offset() (zoomed screen pixels with Settings > UI Scale). jQuery UI takes `width` as the CSS
		// width but `height` as the outer height.
		const view = panelHost.viewport();
		const px = function(name) { return parseFloat($d.css(name)) || 0; };
		const geom = { left: Math.round(px("left") - view.left), top: Math.round(px("top") - view.top),
			width: Math.round(px("width")), height: Math.round(px("height") + panelHost.chrome($d).h) };
		const patch = {};
		patch[mode === "small" ? "small" : "float"] = geom;
		opts[panelModes.PLACES_KEY] = panelModes.withPlace(opts, def.id, patch);
		if (save && typeof opts.save === "function") { opts.save(); }
	},

	/** Keep every window on screen (the browser window or Settings > UI Scale changed) */
	refit: function() {
		$(".ph-float-host.ui-dialog-content").each(function() {
			const $host = $(this);
			const $w = $host.children(".ph-floating");
			const def = panelModes.defOf($host.attr("data-ph-for"));
			if (!def || !$w.length) { return; }
			const $d = $host.dialog("widget");
			const view = panelHost.viewport();
			const px = function(name) { return parseFloat($d.css(name)) || 0; };
			const chrome = panelHost.chrome($d);
			const now = { left: px("left") - view.left, top: px("top") - view.top, width: px("width"), height: px("height") + chrome.h };
			const shape = $w.attr("data-ph-mode") === "small" ? "small" : "floating";
			const fit = panelHost.clampFloat(now, view.width, view.height, 0, chrome.w, panelModes.sizeFor(def, shape, panelHost));
			if (Math.round(now.width) !== fit.width || Math.round(now.height) !== fit.height) { $host.dialog("option", { width: fit.width, height: fit.height }); }
			$d.css({ left: fit.left + view.left, top: fit.top + view.top });
		});
	},

	// ---- Panels menu (top bar) ----

	menuHtml: function() {
		const esc = function(s) { return String(s).replace(/[&<>"']/g, function(c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
		const model = panelModes.menuModel(panelModes.defs(), panelModes.opts(), panelModes.isShown);
		if (!model.rows.length) { return "<div class='ph-menu-empty'>No panels are on</div>"; }
		return "<table class='ph-menu-table'>" + model.rows.map(function(r) {
			return "<tr class='ph-row ph-mode-" + r.mode + "'><td class='ph-name'>" + esc(r.title) + "</td><td class='ph-state'>" + esc(r.label) + "</td><td class='ph-acts'>"
				+ r.actions.map(function(a) { return "<a href='#' class='ph-act' data-ph-id='" + esc(r.id) + "' data-ph-to='" + a.to + "'>" + esc(a.label) + "</a>"; }).join(" ")
				+ "</td></tr>";
		}).join("") + "</table>";
	},

	installMenu: function() {
		if ($("#ph-menu-link").length || !$("#layout").length) { return; }
		$("<i id='ph-menu-link' data-icon='portrait' data-tooltip='Panels: pop out, dock, minimize, restore'><span class='ph-badge hidden'></span></i>").insertBefore("#layout");
		// In body, not the top bar: above the popped-out windows (the top bar's stacking order is below them)
		$("<div id='ph-menu' class='toggle-panel' style='display: none'><div class='triangle'></div><h4>Panels</h4><div class='ph-menu-body'></div></div>")
			.appendTo("body");
		if (typeof Tooltips !== "undefined") { Tooltips.attach($("#ph-menu-link")); }
		$("#ph-menu-link").on("click", function(e) {
			e.preventDefault();
			e.stopPropagation();
			if ($("#ph-menu").is(":visible")) { panelModes.closeMenu(); } else { panelModes.openMenu(); }
		});
		$("#ph-menu").on("click", ".ph-act", function(e) {
			e.preventDefault();
			e.stopPropagation();
			panelModes.setMode($(this).attr("data-ph-id"), $(this).attr("data-ph-to"));
			panelModes.renderMenu();
		}).on("click", function(e) { e.stopPropagation(); });
		$(document).on("click", function() { panelModes.closeMenu(); });
		$(document).on("keydown", function(e) { if (e.key === "Escape" && $("#ph-menu").is(":visible")) { panelModes.closeMenu(); } });
		panelModes.updateBadge();
	},

	renderMenu: function() {
		$("#ph-menu .ph-menu-body").html(panelModes.menuHtml());
	},

	openMenu: function() {
		panelModes.renderMenu();
		const $menu = $("#ph-menu").show();
		// Under its icon, right edges lined up, inside the window. The icon's box is in screen px; the menu is placed in
		// CSS px of the page zoomed by Settings > UI Scale.
		const r = $("#ph-menu-link")[0].getBoundingClientRect();
		const z = panelHost.zoom();
		const view = panelHost.viewport();
		const w = $menu.outerWidth();
		const left = Math.max(4, Math.min(r.right / z + 8 - w, view.width - w - 4));
		$menu.css({ left: Math.round(left + view.left), top: Math.round(r.bottom / z + 8 + view.top) });
		// The triangle points at the icon
		$menu.children(".triangle").css({ right: Math.max(6, Math.round(left + w - (r.left + r.right) / 2 / z - 5)) });
		$("#ph-menu-link").addClass("active");
	},

	closeMenu: function() {
		$("#ph-menu").hide();
		$("#ph-menu-link").removeClass("active");
	},

	updateBadge: function() {
		const $badge = $("#ph-menu-link .ph-badge");
		if (!$badge.length) { return; }
		const n = panelModes.menuModel(panelModes.defs(), panelModes.opts(), panelModes.isShown).badge;
		$badge.text(n || "").toggleClass("hidden", !n);
		$("#ph-menu-link").attr("data-tooltip", n ? "Panels: " + n + " minimized (click to restore)" : "Panels: pop out, dock, minimize, restore");
		if ($("#ph-menu").is(":visible")) { panelModes.renderMenu(); }
	},

	// ---- Command palette ----

	registerCommands: function() {
		if (typeof forkCommands === "undefined") { return; }
		const icons = { floating: "fullscreen", fixed: "pin", minimized: "minus", restore: "plus", small: "fullscreen-exit" };
		panelModes.defs().forEach(function(def) {
			const slug = def.id.replace(/Widget$/, "");
			panelModes.commandList(def).forEach(function(c) {
				if (forkCommands.commands.some(function(x) { return x.id === "panel." + slug + "." + c.to; })) { return; }
				forkCommands.register({
					id: "panel." + slug + "." + c.to, title: c.verb + " " + def.title, group: "Panels", icon: icons[c.to],
					keywords: ["panel", "window", "pop out", "float", "dock", "minimize", "restore", def.title.toLowerCase()],
					enabled: function() {
						if ($("#dialog-options").is(":visible")) { return "Close Settings first"; }
						return panelModes.commandState(def, panelModes.modeFor(def.id), c.to, panelModes.isShown(def.id));
					},
					run: function() { panelModes.setMode(def.id, c.to); }
				});
			});
		});
	},

	// ---- Start ----

	/** Register upstream's panels and pop out those that are not docked (right after the layout is set up) */
	start: function() {
		if (typeof panelHost === "undefined" || !panelHost.gridster()) { return; }
		panelModes.UPSTREAM.forEach(function(u) {
			const $w = panelModes.$el(u.id);
			if (!$w.length) { return; }
			const n = function(name, fallback) { const v = parseInt($w.attr(name), 10); return v > 0 ? v : fallback; };
			const def = panelHost.register({ id: u.id, title: u.title, upstream: true,
				size: { x: u.size.x, y: u.size.y, minX: n("data-min-sizex", u.size.minX), minY: n("data-min-sizey", u.size.minY) },
				onResize: u.id === "infoWidget" ? function() { if (typeof activity !== "undefined" && activity.redraw) { activity.redraw(); } } : undefined });
			const mode = panelModes.modeFor(u.id);
			if (mode === "fixed") { panelModes.decorate(def, $w, "fixed"); return; }
			try {
				panelModes.undock(def, $w);
				panelModes.float(def, $w, mode);
				panelModes.decorate(def, $w, mode);
			} catch (err) {
				console.error("Panel modes: could not pop out " + u.id, err);
			}
		});
	},

	init: function() {
		panelModes.installMenu();
		// Buttons in panel headers and window title bars
		$(document).on("mousedown", ".ph-btn", function(e) { e.stopPropagation(); });
		$(document).on("click", ".ph-btn", function(e) {
			e.preventDefault();
			e.stopPropagation();
			if (typeof Tooltips !== "undefined" && Tooltips.close) { Tooltips.close(); }
			panelModes.setMode($(this).attr("data-ph-id"), $(this).attr("data-ph-to"));
		});
		let resizeTimer = null;
		$(window).on("resize", function() {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(panelModes.refit, 200);
		});
		// Settings Save / Reset end in options.apply() (UI scale): keep the windows on screen
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.panelModesWrapped) {
			const apply = options.apply;
			const wrapped = function() {
				const result = apply.apply(this, arguments);
				try { panelModes.refit(); panelModes.updateBadge(); } catch (err) { console.error("Panel modes: apply failed", err); }
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrapped[k] = apply[k]; });
			wrapped.panelModesWrapped = true;
			options.apply = wrapped;
		}
		// Every panel has registered once all ready handlers have run
		setTimeout(function() { panelModes.registerCommands(); panelModes.updateBadge(); }, 0);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	// Upstream's panels are in the layout from the start: pop them out now, before the page shows, not on DOM ready
	try { panelModes.start(); } catch (err) { console.error("Panel modes: start failed", err); }
	$(function() { panelModes.init(); });
}
