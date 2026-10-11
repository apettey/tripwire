var layoutGrid = {
	// Layout grid (fork-owned): keeps Settings > Save / Reset from moving the panels back.
	// Upstream's options.apply() replaces options.grid with the browser's copy of the options loaded with the page
	// (localStorage "tripwire_options"), then moves every panel to it and options.save() stores it. So a panel moved or
	// resized with Customize layout since the page loaded jumped back (and the old layout was saved) on every Settings
	// Save. options.apply() now asks layoutGrid.live() for the layout on screen and uses it instead (two lines marked
	// "fork" in app/js/options.js), and options.save() is wrapped (wrapSave) to store the layout on screen as well: fork
	// panels added or removed by their apply hooks, after options.grid was taken, push their neighbours around. Keep `var layoutGrid` on the first line (the test helper strips it to define a global),
	// and keep it a var: options.js reads it on page load, before this file has run, where a const would throw.

	/** The entries of a layout (options.grid: array, object, or the old {oog: ...} form) as a list. Never mutates. */
	entries: function(layout) {
		if (!layout || typeof layout !== "object") { return []; }
		const source = layout.oog && typeof layout.oog === "object" && Object.keys(layout.oog).length ? layout.oog : layout;
		const list = Array.isArray(source) ? source : Object.keys(source).map(function(k) { return source[k]; });
		return list.filter(function(e) { return e && typeof e === "object" && typeof e.id === "string" && e.id; });
	},

	/**
	 * One layout from several, first wins per panel id: the live layout first, then saved ones, whose entries are kept
	 * for panels not on the page (a panel turned off keeps its place for when it is turned on again). Entries of
	 * widgets being removed ("<id>-removed") are dropped. Returns a new array; never mutates its arguments.
	 */
	merge: function() {
		const seen = {};
		const out = [];
		Array.prototype.forEach.call(arguments, function(layout) {
			layoutGrid.entries(layout).forEach(function(e) {
				if (seen[e.id] || /-removed$/.test(e.id)) { return; }
				seen[e.id] = true;
				out.push(Object.assign({}, e));
			});
		});
		return out;
	},

	/**
	 * The layout options.apply() should use: what gridster has on screen, plus the saved entries (in `saved`) of panels
	 * that aren't on the page. null before the layout exists (the first apply, on page load), so upstream's restore from
	 * the browser's copy still places the panels then.
	 * @param api the gridster instance (global `grid` from layout.js), or anything else when it isn't there yet
	 * @param saved options.grid as it is before apply
	 */
	live: function(api, saved) {
		if (!api || typeof api.serialize !== "function" || !api.$widgets) { return null; }
		return layoutGrid.merge(api.serialize(), saved);
	},

	/**
	 * Wrap opts.save (once) so every save first takes options.grid from the screen (layoutGrid.live), then saves as before.
	 * @param opts the options object (global `options` from options.js)
	 * @param getApi returns the gridster instance, or nothing while it isn't there
	 */
	wrapSave: function(opts, getApi) {
		if (!opts || typeof opts.save !== "function" || opts.save.layoutGridWrapped) { return false; }
		const save = opts.save;
		const wrapped = function() {
			try {
				const live = layoutGrid.live(getApi ? getApi() : null, opts.grid);
				if (live) { opts.grid = live; }
			} catch (err) {
				if (typeof console !== "undefined") { console.error("Layout grid: reading the layout failed", err); }
			}
			return save.apply(this, arguments);
		};
		Object.keys(save).forEach(function(k) { wrapped[k] = save[k]; });
		wrapped.layoutGridWrapped = true;
		opts.save = wrapped;
		return true;
	}
};

// options.js has run by now (it comes first in the bundle): wrap its save
if (typeof window !== "undefined" && typeof options !== "undefined") {
	layoutGrid.wrapSave(options, function() { return typeof grid !== "undefined" ? grid : null; });
}
