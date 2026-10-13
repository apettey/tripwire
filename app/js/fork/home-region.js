const homeRegion = {
	// Chain map: a small region tag ("R09" for C-R00009) after the name of home (the active chain tab's system) and of
	// every chain system in the same wormhole region, so the tag shows the group (fork feature). Hovering a tag shows
	// the region and highlights the whole group. Settings: options.homeRegion = { enabled, color } (missing = on, teal);
	// mask admins can make it a mask default (mask-defaults.js). Keep `const homeRegion` on the first line: the test
	// helper only turns the first `const` into a global.

	/** Colours a tag can have: key -> name. The key is only ever used through color(), which checks it against this
	list, so a stored value never reaches the markup or CSS as such. Styles: home-region.css (.home-region-c-<key>). */
	PALETTE: [["teal", "Teal"], ["blue", "Blue"], ["violet", "Violet"], ["pink", "Pink"], ["amber", "Amber"], ["green", "Green"]],
	DEFAULT_COLOR: "teal",

	/** Whether the feature is on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.homeRegion && opts.homeRegion.enabled === false);
	},

	/** Whether a value is one of the palette's keys */
	isColor: function(value) {
		return typeof value === "string" && homeRegion.PALETTE.some(function(p) { return p[0] === value; });
	},

	/** The tag colour from the user options: a palette key, the default for anything else */
	color: function(opts) {
		const value = opts && opts.homeRegion ? opts.homeRegion.color : undefined;
		return homeRegion.isColor(value) ? value : homeRegion.DEFAULT_COLOR;
	},

	/** Home system id: the system the active chain tab starts from (options.chain.tabs[options.chain.active].systemID),
	or null when there is no single home (no active tab, "all systems" tab = 0, several systems "a,b"). */
	homeSystemID: function(opts) {
		const chainOpts = opts && opts.chain;
		if (!chainOpts || chainOpts.active === null || chainOpts.active === undefined || !Array.isArray(chainOpts.tabs)) { return null; }
		const tab = chainOpts.tabs[chainOpts.active];
		if (!tab || tab.systemID === null || tab.systemID === undefined) { return null; }
		const id = String(tab.systemID).trim();
		if (!/^\d+$/.test(id) || Number(id) <= 0) { return null; }
		return Number(id);
	},

	/** Whether a system (appData.systems[id]) is J-space: it has a wormhole class */
	isWormhole: function(system) {
		if (!system) { return false; }
		return !!(Array.isArray(system.class) ? system.class.length : system.class);
	},

	/** Home's region id, or null when home is unknown, not a wormhole system or has no region.
	@param systems appData.systems */
	homeRegionID: function(homeID, systems) {
		if (homeID === null || homeID === undefined || !systems) { return null; }
		const home = systems[homeID];
		if (!homeRegion.isWormhole(home) || !home.regionID) { return null; }
		return home.regionID;
	},

	/** Whether a chain node's system is in the group: a known system in home's region (home included) */
	inRegion: function(systemID, regionID, systems) {
		if (!regionID || !systems || systemID === null || systemID === undefined) { return false; }
		const system = systems[systemID];
		return !!(system && system.regionID && system.regionID == regionID);
	},

	/** Short region code for the tag: "R09" for "C-R00009" (number without leading zeros, at least 2 digits);
	from the region id when the name doesn't have that form (11000009 -> "R09") */
	regionCode: function(name, regionID) {
		const pad = function(n) { return "R" + (n < 10 ? "0" : "") + n; };
		const m = /-R0*(\d+)$/.exec(String(name || ""));
		if (m) { return pad(Number(m[1])); }
		const id = Number(regionID);
		if (id > 11000000 && id < 11001000) { return pad(id - 11000000); }
		return "R?";
	},

	/** Tooltip text: "C-R00009 · home's region · 3 systems on the chain" (home) or "... · same region as home ..." */
	tooltip: function(regionName, code, isHome, count) {
		return (regionName || code) + " · " + (isHome ? "home's region" : "same region as home") +
			(count > 1 ? " · " + count + " systems on the chain" : "");
	},

	escape: function(text) {
		return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	},

	CLASS: 'home-region-mark',

	/** The tag. The tooltip goes in data-tooltip for Tripwire's jBox tooltips, which show it as HTML, so it is
	escaped twice (once for the attribute, once for the tooltip). Screen readers get the same text, hidden. */
	markerHtml: function(code, tip, color, isHome) {
		const esc = homeRegion.escape;
		const key = homeRegion.isColor(color) ? color : homeRegion.DEFAULT_COLOR;
		return "<span class='" + homeRegion.CLASS + " home-region-c-" + key + (isHome ? " home-region-home" : "") +
			"' data-tooltip='" + esc(esc(tip)) + "'>" + esc(code) + "<span class='home-region-sr'>, " + esc(tip) + "</span></span>";
	},

	/** Add the tag at the end of a chain node's name line (h4.nodeSystem, after the name or its link).
	Returns the markup unchanged when it already has a tag, null when there is no name line. */
	insertMarker: function(html, marker) {
		if (typeof html !== 'string' || !marker) { return null; }
		if (html.indexOf("class='" + homeRegion.CLASS + " ") >= 0) { return html; }
		const open = "<h4 class='nodeSystem'>";
		const start = html.indexOf(open);
		if (start < 0) { return null; }
		const end = html.indexOf('</h4>', start + open.length);
		if (end < 0) { return null; }
		return html.substring(0, end) + marker + html.substring(end);
	},

	/** Decorate the result of chain.nodes() in place: tag home and every node in home's region.
	@param result { map: { rows } } from chain.nodes
	@param homeID home system id (homeSystemID) or null
	@param systems appData.systems
	@param regions appData.regions ({ regionID: { name } })
	@param color palette key (color()) */
	decorate: function(result, homeID, systems, regions, color) {
		if (!result || !result.map || !Array.isArray(result.map.rows)) { return result; }
		const regionID = homeRegion.homeRegionID(homeID, systems);
		if (!regionID) { return result; }
		const region = regions && regions[regionID];
		const name = region && region.name ? String(region.name) : '';
		const code = homeRegion.regionCode(name, regionID);
		const rows = result.map.rows.filter(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || typeof node.f !== 'string' || row.destination || String(node.v).indexOf('dest-') === 0) { return false; }
			return homeRegion.inRegion(node.systemID, regionID, systems);
		});
		const distinct = {};
		rows.forEach(function(row) { distinct[String(row.c[0].systemID)] = true; });
		const count = Object.keys(distinct).length;
		rows.forEach(function(row) {
			try {
				const node = row.c[0];
				const isHome = String(node.systemID) === String(homeID);
				const html = homeRegion.insertMarker(node.f, homeRegion.markerHtml(code, homeRegion.tooltip(name, code, isHome, count), color, isHome));
				if (html) { node.f = html; }
			} catch (e) {
				if (typeof console !== 'undefined') { console.warn('home-region: could not tag chain node', e); }
			}
		});
		return result;
	},

	systems: function() {
		return typeof appData !== 'undefined' && appData.systems ? appData.systems : undefined;
	},

	regions: function() {
		if (typeof appData !== 'undefined' && appData.regions) { return appData.regions; }
		return typeof tripwire !== 'undefined' && tripwire.regions ? tripwire.regions : undefined;
	},

	/** Wrap chain.nodes so every redraw (tab change, Settings Save/Reset via options.apply()) is tagged */
	install: function(chainObj) {
		// The flag lives on the chain, not on chain.nodes: other features wrap chain.nodes later without copying it
		if (!chainObj || typeof chainObj.nodes !== 'function' || chainObj.homeRegionInstalled) { return; }
		chainObj.homeRegionInstalled = true;
		const previous = chainObj.nodes;
		const wrapped = function() {
			const result = previous.apply(this, arguments);
			const opts = typeof options !== 'undefined' ? options : undefined;
			if (!homeRegion.enabled(opts)) { return result; }
			return homeRegion.decorate(result, homeRegion.homeSystemID(opts), homeRegion.systems(), homeRegion.regions(), homeRegion.color(opts));
		};
		Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
		chainObj.nodes = wrapped;
	},

	// ---- browser: tooltips, group highlight, Settings row ----

	HOVER_CLASS: 'home-region-hover',
	tipEls: null,

	/** jBox keeps every element it is attached to: detach the old tags and attach the new ones after each draw */
	attachTips: function() {
		if (typeof Tooltips === 'undefined' || !Tooltips.attach) { return; }
		if (homeRegion.tipEls && homeRegion.tipEls.length && Tooltips.detach) { Tooltips.detach(homeRegion.tipEls); }
		homeRegion.tipEls = $("#chainMap ." + homeRegion.CLASS + "[data-tooltip]");
		if (homeRegion.tipEls.length) { Tooltips.attach(homeRegion.tipEls); }
	},

	/** Wrap chain.draw: new tooltips after each draw, and no group highlight left from tags that are gone */
	installDraw: function(chainObj) {
		if (!chainObj || typeof chainObj.draw !== 'function' || chainObj.homeRegionDrawInstalled) { return; }
		chainObj.homeRegionDrawInstalled = true;
		const previous = chainObj.draw;
		const wrapped = function() {
			const result = previous.apply(this, arguments);
			try {
				$("#chainMap").removeClass(homeRegion.HOVER_CLASS);
				homeRegion.attachTips();
				setTimeout(homeRegion.attachTips, 400);	// renderers that place nodes a moment later
			} catch (e) { console.warn('home-region: tooltips', e); }
			return result;
		};
		Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
		chainObj.draw = wrapped;
	},

	/** Settings row: on/off and the colour, with a sample tag */
	settingsHtml: function() {
		const esc = homeRegion.escape;
		return "<label><input type='checkbox' id='homeRegion-enabled' /> Tag systems in the same region as home</label><br/>" +
			"<label>Colour: <select id='homeRegion-color'>" +
			homeRegion.PALETTE.map(function(p) { return "<option value='" + esc(p[0]) + "'>" + esc(p[1]) + "</option>"; }).join('') +
			"</select></label> <span id='homeRegion-sample' class='" + homeRegion.CLASS + " home-region-c-" + homeRegion.DEFAULT_COLOR + "'>R09</span>";
	},

	showSample: function() {
		const key = homeRegion.isColor($("#homeRegion-color").val()) ? $("#homeRegion-color").val() : homeRegion.DEFAULT_COLOR;
		$("#homeRegion-sample").attr("class", homeRegion.CLASS + " home-region-c-" + key);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	if (typeof chain !== "undefined") { homeRegion.install(chain); homeRegion.installDraw(chain); }
	$(function() {
		if (typeof chain !== "undefined") { homeRegion.install(chain); homeRegion.installDraw(chain); }

		// Group highlight while the pointer is over any tag (delegated: survives redraws without new handlers)
		$(document).on("mouseenter", "#chainMap ." + homeRegion.CLASS, function() {
			$("#chainMap").addClass(homeRegion.HOVER_CLASS);
			// Collapsing a node (double-click) redraws the nodes without chain.draw: give a new tag its tooltip now
			if (typeof Tooltips !== 'undefined' && Tooltips.attach && $(this).is("[data-tooltip]") && !(homeRegion.tipEls && homeRegion.tipEls.is(this))) {
				Tooltips.attach($(this));
				homeRegion.tipEls = homeRegion.tipEls ? homeRegion.tipEls.add(this) : $(this);
				$(this).trigger("mouseenter.jBox-attach-" + Tooltips.id);	// jBox's own handler missed this hover: open it now
			}
		});
		$(document).on("mouseleave", "#chainMap ." + homeRegion.CLASS, function() { $("#chainMap").removeClass(homeRegion.HOVER_CLASS); });
		$(document).on("change", "#homeRegion-color", homeRegion.showSample);
		// A double-click (collapse/expand) can remove the tag under the pointer without a mouseleave
		$(document).on("dblclick", "#chainMap", function() { $("#chainMap").removeClass(homeRegion.HOVER_CLASS); });

		// Settings > Map Markers. Takes effect on Save (upstream Save runs options.apply() -> chain.redraw(), then
		// options.save(), which persists options.homeRegion); Close discards it; Reset deletes the key (= on, teal).
		// A mask admin's choice can become the mask default (Mask Admin > Admins & members), see mask-defaults.js.
		forkSettings.register({
			section: "markers", order: 22, id: "homeRegion", type: "custom", key: "homeRegion",
			label: "Home region:", html: homeRegion.settingsHtml(), keywords: "region tag colour color home",
			load: function(o) {
				$("#homeRegion-enabled").prop("checked", homeRegion.enabled(o));
				$("#homeRegion-color").val(homeRegion.color(o));
				homeRegion.showSample();
			},
			save: function(o) {
				const value = $("#homeRegion-color").val();
				o.homeRegion = { enabled: $("#homeRegion-enabled").prop("checked"), color: homeRegion.isColor(value) ? value : homeRegion.DEFAULT_COLOR };
			}
		});
	});
}
