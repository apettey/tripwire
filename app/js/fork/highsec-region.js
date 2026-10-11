const highsecRegion = {
	// Chain map: on holes into high-sec, show the region name where the node shows the hole type (fork feature).
	// Setting: options.highsecRegion.enabled (missing = on). Keep `const highsecRegion` on the first line: the
	// test helper only turns the first `const` into a global.

	/** Whether the feature is on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.highsecRegion && opts.highsecRegion.enabled === false);
	},

	/** Whether a system counts as high-sec the way Tripwire classifies it (systemAnalysis: no wormhole class,
	not Triglavian, security >= 0.45, which EVE displays as 0.5). Takes appData.systems[id] or systemAnalysis.analyse(id). */
	isHighSec: function(system) {
		if (!system) { return false; }
		if (Array.isArray(system.class) ? system.class.length : system.class) { return false; }
		if (system.factionID == 500026) { return false; }	// Triglavian (Pochven)
		const security = system.baseSecurity !== undefined ? system.baseSecurity : system.security;
		if (security === undefined || security === null || security === '') { return false; }
		const value = Number(security);
		return !isNaN(value) && value >= 0.45;
	},

	/** Region name to show for a hole's destination system, or null to leave the node alone
	(not high-sec, unknown system, or no region name). regions: appData.regions ({ regionID: { name } }) */
	labelFor: function(system, regions) {
		if (!highsecRegion.isHighSec(system) || !regions) { return null; }
		const region = regions[system.regionID];
		return region && region.name ? String(region.name) : null;
	},

	escape: function(text) {
		return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	},

	/** The hole type text a chain node shows, as upstream's chain.nodes builds it (chain-map.js).
	@param child the connection's child (last pathHome entry: { type, name, signatureID, path })
	@param chainOptions options.chain ({ "node-reference", sigNameLocation })
	@return { prefix, name, type }: the node shows prefix + type (with "Reference - prefix", prefix is
	"<name> - " and name the hole's name; otherwise both are ''); or null when it doesn't show the hole type (gate route, signature IDs instead of types, or only
	the hole's name) */
	typeText: function(child, chainOptions) {
		if (!child || child.path) { return null; }
		chainOptions = chainOptions || {};
		if (chainOptions['node-reference'] == 'id') { return null; }
		const type = child.type || '(?)';
		if (child.name && chainOptions.sigNameLocation == 'ref') { return null; }
		if (child.name && chainOptions.sigNameLocation == 'ref_prefix') { return { prefix: child.name + ' - ', name: String(child.name), type: type }; }
		return { prefix: '', name: '', type: type };
	},

	/** Tooltip for the label: the full region name and the hole type it replaces */
	title: function(region, type) {
		const known = type && type != '(?)';
		return region + ' (high-sec region)' + (known ? ' - hole type ' + type : ' - hole type unknown');
	},

	/** Markup for the node's type line with the region in place of the hole type (text from typeText).
	The region takes its natural width up to a cap that fits every high-sec region (ellipsis beyond it); the
	renderers lay nodes out from their measured width, so wider nodes get room. With "Reference - prefix" the
	hole name keeps the line and the region goes on a line of its own below it ("AABA - The Bleak Lands" on one
	line would make the node too wide for the layouts). The hole type stays in the tooltip and, for screen
	readers, in visually hidden text. */
	labelHtml: function(text, region) {
		const esc = highsecRegion.escape;
		const type = text.type && text.type != '(?)' ? text.type : 'unknown';
		return (text.name ? "<span class='highsec-region-name'>" + esc(text.name) + "</span>" : '') +
			"<span class='highsec-region-line" + (text.name ? " highsec-region-below" : '') + "' title='" +
			esc(highsecRegion.title(region, text.type)) + "'>" + esc(region) + "</span>" +
			"<span class='highsec-region-sr'>, hole type " + esc(type) + "</span>";
	},

	/** Class added to the node when the region gets a line of its own, so the node can be one line taller */
	TALL_CLASS: 'highsec-region-tall',

	/** Replace the hole type in a chain node's markup (the h4.nodeType line) with the region.
	Only changes the line when it holds exactly the text upstream put there (text), optionally inside
	the link that opens the signature; returns null otherwise. */
	rewriteHtml: function(html, text, region) {
		if (typeof html !== 'string' || !text || !region) { return null; }
		const open = "<h4 class='nodeType'>";
		const start = html.indexOf(open);
		if (start < 0) { return null; }
		const innerStart = start + open.length;
		const end = html.indexOf('</h4>', innerStart);
		if (end < 0) { return null; }
		var inner = html.substring(innerStart, end), before = '', after = '';
		if (inner.indexOf('<a ') === 0) {
			const close = inner.indexOf('>');
			if (close < 0 || inner.slice(-4) !== '</a>') { return null; }
			before = inner.substring(0, close + 1);
			after = '</a>';
			inner = inner.substring(close + 1, inner.length - 4);
		}
		if (inner !== highsecRegion.escape(text.prefix + text.type)) { return null; }
		var head = html.substring(0, innerStart);
		if (text.name) {
			// The node's own class list (makeSystemNode: class='node ...')
			const nodeClass = head.indexOf("class='node ");
			if (nodeClass < 0) { return null; }
			head = head.substring(0, nodeClass) + "class='node " + highsecRegion.TALL_CLASS + ' ' + head.substring(nodeClass + "class='node ".length);
		}
		return head + before + highsecRegion.labelHtml(text, region) + after + html.substring(end);
	},

	/** Decorate the result of chain.nodes() in place: holes into known high-sec systems show the region
	instead of the hole type.
	@param result { map: { rows } } from chain.nodes; each row's pathHome ends with the connection's child
	@param systemFor function(systemID) -> system data (systemAnalysis.analyse), or undefined if unknown
	@param regions appData.regions
	@param chainOptions options.chain */
	decorate: function(result, systemFor, regions, chainOptions) {
		if (!result || !result.map || !Array.isArray(result.map.rows)) { return result; }
		result.map.rows.forEach(function(row) {
			try {
				if (!row || !row.c || !row.c[0] || !row.c[1]) { return; }
				const node = row.c[0];
				if (row.c[1].v === null || row.c[1].v === undefined) { return; }	// chain root
				if (typeof node.f !== 'string' || !Array.isArray(row.pathHome) || !row.pathHome.length) { return; }
				const child = row.pathHome[row.pathHome.length - 1];
				if (!child || child.systemID != node.systemID) { return; }
				const text = highsecRegion.typeText(child, chainOptions);
				if (!text) { return; }
				const region = highsecRegion.labelFor(systemFor(node.systemID), regions);
				if (!region) { return; }
				const html = highsecRegion.rewriteHtml(node.f, text, region);
				if (html) { node.f = html; }
			} catch (e) {
				if (typeof console !== 'undefined') { console.warn('highsec-region: could not label chain node', e); }
			}
		});
		return result;
	},

	/** System data for a chain node's system id, or undefined for unidentified systems ("High-Sec" etc.) */
	systemFor: function(systemID) {
		if (typeof appData === 'undefined' || !appData.systems || !appData.systems[systemID]) { return undefined; }
		return typeof systemAnalysis !== 'undefined' ? systemAnalysis.analyse(systemID) : appData.systems[systemID];
	},

	regions: function() {
		if (typeof appData !== 'undefined' && appData.regions) { return appData.regions; }
		return typeof tripwire !== 'undefined' && tripwire.regions ? tripwire.regions : undefined;
	},

	/** Wrap chain.nodes so every redraw (including the one options.apply() does on Save/Reset) is labelled */
	install: function(chainObj) {
		// The flag lives on the chain, not on chain.nodes: other features wrap chain.nodes later without copying it
		if (!chainObj || typeof chainObj.nodes !== 'function' || chainObj.highsecRegionInstalled) { return; }
		chainObj.highsecRegionInstalled = true;
		const previous = chainObj.nodes;
		const wrapped = function() {
			const result = previous.apply(this, arguments);
			const opts = typeof options !== 'undefined' ? options : undefined;
			if (!highsecRegion.enabled(opts)) { return result; }
			return highsecRegion.decorate(result, highsecRegion.systemFor, highsecRegion.regions(), opts && opts.chain);
		};
		Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
		chainObj.nodes = wrapped;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	if (typeof chain !== "undefined") { highsecRegion.install(chain); }
	$(function() {
		if (typeof chain !== "undefined") { highsecRegion.install(chain); }

		// Settings > Map Markers. Takes effect on Save (upstream Save runs options.apply() -> chain.redraw(), then
		// options.save(), which persists options.highsecRegion); Close discards it; Reset = on (upstream then redraws).
		forkSettings.register({
			section: "markers", order: 20, id: "highsecRegion-enabled", type: "checkbox", key: "highsecRegion",
			label: "High-sec region:", text: "Show region instead of hole type on high-sec exits",
			get: function(o) { return highsecRegion.enabled(o); },
			set: function(o, on) { o.highsecRegion = { enabled: on }; }
		});
	});
}
