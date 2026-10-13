const homeRegion = {
	// Chain map: a small house mark next to the name of every wormhole system in the same region as home (the
	// active chain tab's system), fork feature. Setting: options.homeRegion.enabled (missing = on).
	// Keep `const homeRegion` on the first line: the test helper only turns the first `const` into a global.

	/** Whether the feature is on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.homeRegion && opts.homeRegion.enabled === false);
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

	/** Whether a chain node's system gets the mark: a known system, not home itself, in home's region */
	sameRegion: function(systemID, homeID, regionID, systems) {
		if (!regionID || !systems || systemID === null || systemID === undefined) { return false; }
		if (String(systemID) === String(homeID)) { return false; }
		const system = systems[systemID];
		return !!(system && system.regionID && system.regionID == regionID);
	},

	escape: function(text) {
		return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	},

	/** Tooltip text; regionName may be missing */
	title: function(regionName) {
		return 'Same region as home' + (regionName ? ' (' + regionName + ')' : '');
	},

	CLASS: 'home-region-mark',

	/** The mark: a tiny house icon with the tooltip, plus the same text for screen readers */
	markerHtml: function(regionName) {
		const text = homeRegion.escape(homeRegion.title(regionName));
		return "<span class='" + homeRegion.CLASS + "' title='" + text + "'>" +
			"<svg class='home-region-icon' viewBox='0 0 10 10' aria-hidden='true' focusable='false'>" +
			"<path d='M5 0.6 L9.6 4.8 H8.2 V9.4 H6 V6.6 H4 V9.4 H1.8 V4.8 H0.4 Z'/></svg>" +
			"<span class='home-region-sr'>, " + text.charAt(0).toLowerCase() + text.substring(1) + "</span></span>";
	},

	/** Add the mark at the end of a chain node's name line (h4.nodeSystem, after the name or its link).
	Returns the markup unchanged when it already has the mark, null when there is no name line. */
	insertMarker: function(html, marker) {
		if (typeof html !== 'string' || !marker) { return null; }
		if (html.indexOf("class='" + homeRegion.CLASS + "'") >= 0) { return html; }
		const open = "<h4 class='nodeSystem'>";
		const start = html.indexOf(open);
		if (start < 0) { return null; }
		const end = html.indexOf('</h4>', start + open.length);
		if (end < 0) { return null; }
		return html.substring(0, end) + marker + html.substring(end);
	},

	/** Decorate the result of chain.nodes() in place: mark every node in home's region (not home itself).
	@param result { map: { rows } } from chain.nodes
	@param homeID home system id (homeSystemID) or null
	@param systems appData.systems
	@param regions appData.regions ({ regionID: { name } }) */
	decorate: function(result, homeID, systems, regions) {
		if (!result || !result.map || !Array.isArray(result.map.rows)) { return result; }
		const regionID = homeRegion.homeRegionID(homeID, systems);
		if (!regionID) { return result; }
		const region = regions && regions[regionID];
		const marker = homeRegion.markerHtml(region && region.name ? String(region.name) : '');
		result.map.rows.forEach(function(row) {
			try {
				const node = row && row.c && row.c[0];
				if (!node || typeof node.f !== 'string' || row.destination || String(node.v).indexOf('dest-') === 0) { return; }
				if (!homeRegion.sameRegion(node.systemID, homeID, regionID, systems)) { return; }
				const html = homeRegion.insertMarker(node.f, marker);
				if (html) { node.f = html; }
			} catch (e) {
				if (typeof console !== 'undefined') { console.warn('home-region: could not mark chain node', e); }
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

	/** Wrap chain.nodes so every redraw (tab change, Settings Save/Reset via options.apply()) is marked */
	install: function(chainObj) {
		// The flag lives on the chain, not on chain.nodes: other features wrap chain.nodes later without copying it
		if (!chainObj || typeof chainObj.nodes !== 'function' || chainObj.homeRegionInstalled) { return; }
		chainObj.homeRegionInstalled = true;
		const previous = chainObj.nodes;
		const wrapped = function() {
			const result = previous.apply(this, arguments);
			const opts = typeof options !== 'undefined' ? options : undefined;
			if (!homeRegion.enabled(opts)) { return result; }
			return homeRegion.decorate(result, homeRegion.homeSystemID(opts), homeRegion.systems(), homeRegion.regions());
		};
		Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
		chainObj.nodes = wrapped;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	if (typeof chain !== "undefined") { homeRegion.install(chain); }
	$(function() {
		if (typeof chain !== "undefined") { homeRegion.install(chain); }

		// Settings > Map Markers. Takes effect on Save (upstream Save runs options.apply() -> chain.redraw(), then
		// options.save(), which persists options.homeRegion); Close discards it; Reset = on (upstream then redraws).
		forkSettings.register({
			section: "markers", order: 22, id: "homeRegion-enabled", type: "checkbox", key: "homeRegion",
			label: "Home region:", text: "Mark systems in the same region as home",
			get: function(o) { return homeRegion.enabled(o); },
			set: function(o, on) { o.homeRegion = { enabled: on }; }
		});
	});
}
