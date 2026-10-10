const sizeTags = {
	/** Size classes by the max jump mass (kg) of a wormhole, smallest first */
	classes: [
		{ size: 'S', max: 5000000, label: 'frigates and destroyers' },
		{ size: 'M', max: 62000000, label: 'up to battlecruisers' },
		{ size: 'L', max: 410000000, label: 'up to battleships' },
		{ size: 'VL', max: 1000000000, label: 'freighters, not capitals' },
		{ size: 'XL', max: Infinity, label: 'capitals' }
	],

	/** Size class for a wormhole's max jump mass in kg: 'S'|'M'|'L'|'VL'|'XL', or null if unknown */
	sizeOf: function(jumpKg) {
		const jump = Number(jumpKg);
		if (!jump || jump <= 0 || isNaN(jump)) { return null; }
		for (var i = 0; i < sizeTags.classes.length; i++) {
			if (jump <= sizeTags.classes[i].max) { return sizeTags.classes[i].size; }
		}
		return null;
	},

	/** Size tag for a connection, using the same lookup as the chain map's connection auras.
	@return { size, certain, jump } or null if no size is known.
	certain is true when the size comes from a known wormhole type, false when it is guessed from the system classes. */
	tagFor: function(parentType, childType, parentSystemID, childSystemID) {
		const known = wormholeAnalysis.wormholeFromTypePair(parentType, childType);
		const wormhole = known || wormholeAnalysis.likelyWormhole(parentSystemID, childSystemID);
		if (!wormhole) { return null; }
		const size = sizeTags.sizeOf(wormhole.jump);
		return size ? { size: size, certain: !!known, jump: wormhole.jump } : null;
	},

	formatKt: function(jumpKg) {
		return String(Math.round(jumpKg / 1e6)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	},

	/** HTML for a tag from tagFor, or '' if there is none */
	tagHtml: function(tag) {
		if (!tag || !tag.size) { return ''; }
		const cls = sizeTags.classes.filter(function(c) { return c.size == tag.size; })[0];
		const title = (tag.certain ? 'Max ship ' : 'Likely max ship ') + (tag.jump ? sizeTags.formatKt(tag.jump) + ' kt ' : '') +
			'(' + (cls ? cls.label : tag.size) + ')' +
			(tag.certain ? '' : ' - wormhole type unknown, guessed from the system classes');
		return '<span class="size-tag size-' + tag.size.toLowerCase() + (tag.certain ? '' : ' size-uncertain') + '" title="' + title + '">' +
			tag.size + (tag.certain ? '' : '?') + '</span>';
	},

	/** Insert tag markup at the end of the node's hole-type line (<h4 class='nodeType'>) */
	insertIntoNodeHtml: function(nodeHtml, tagMarkup) {
		if (!tagMarkup || typeof nodeHtml !== 'string' || nodeHtml.indexOf('size-tag') >= 0) { return nodeHtml; }
		const start = nodeHtml.indexOf("<h4 class='nodeType'>");
		if (start < 0) { return nodeHtml; }
		const end = nodeHtml.indexOf('</h4>', start);
		if (end < 0) { return nodeHtml; }
		return nodeHtml.substring(0, end) + tagMarkup + nodeHtml.substring(end);
	},

	/** Whether a chain row is a synthetic node added by another feature (e.g. route destinations) */
	isSynthetic: function(row, node) {
		const id = String(node.v);
		const html = typeof node.f === 'string' ? node.f : '';
		return !!(row.destination || id.indexOf('dest-') === 0 ||
			html.indexOf('destination-node') >= 0 || html.indexOf("id='dest-") >= 0 || html.indexOf('id="dest-') >= 0 ||
			html.indexOf("id='nodedest-") >= 0 || html.indexOf('id="nodedest-') >= 0);
	},

	/** Decorate the result of chain.nodes() with size tags in place.
	@param result { map: { rows }, lines } from chain.nodes
	@param wormholeTypeFor function(wormholeId) returning the connection's wormhole type (e.g. 'H296'), or undefined */
	decorate: function(result, wormholeTypeFor) {
		if (!result || !result.map || !Array.isArray(result.map.rows)) { return result; }
		const rows = result.map.rows;
		const byId = {};
		rows.forEach(function(row) { if (row && row.c && row.c[0]) { byId[row.c[0].v] = row.c[0]; } });
		const wormholeIdByChild = {};
		(result.lines || []).forEach(function(l) { if (l) { wormholeIdByChild[l[0]] = l[3]; } });

		rows.forEach(function(row) {
			try {
				if (!row || !row.c || !row.c[0] || !row.c[1]) { return; }
				const node = row.c[0], parentID = row.c[1].v;
				if (parentID === null || parentID === undefined) { return; }	// root
				if (typeof node.f !== 'string' || sizeTags.isSynthetic(row, node)) { return; }
				if (!Array.isArray(row.pathHome) || !row.pathHome.length) { return; }
				const child = row.pathHome[row.pathHome.length - 1];
				if (!child || child.path || child.systemID != node.systemID) { return; }	// calculated gate route, or not what we expect
				const parent = byId[parentID];
				if (!parent) { return; }

				const wormholeType = wormholeTypeFor ? wormholeTypeFor(wormholeIdByChild[node.v]) : undefined;
				// One side of a connection is the wormhole's type, the other is K162; the lookup is symmetric
				const otherType = wormholeType && wormholeType != child.type ? wormholeType : 'K162';
				const tag = sizeTags.tagFor(otherType, child.type, parent.systemID, node.systemID);
				node.f = sizeTags.insertIntoNodeHtml(node.f, sizeTags.tagHtml(tag));
			} catch (e) {
				if (typeof console !== 'undefined') { console.warn('size-tags: could not tag chain node', e); }
			}
		});
		return result;
	},

	/** Wormhole type for a chain connection id, from Tripwire's wormholes or EVE-Scout links */
	wormholeTypeFor: function(wormholeId) {
		if (wormholeId === undefined || wormholeId === null) { return undefined; }
		if (typeof tripwire !== 'undefined' && tripwire.client && tripwire.client.wormholes && tripwire.client.wormholes[wormholeId]) {
			return tripwire.client.wormholes[wormholeId].type || undefined;
		}
		const id = String(wormholeId);
		if (id.indexOf('ES-') === 0 && typeof eveScout !== 'undefined' && Array.isArray(eveScout.links)) {
			const link = eveScout.links.filter(function(l) { return 'ES-' + l.id == id; })[0];
			return link ? link.wh_type : undefined;
		}
		return undefined;
	},

	legendRow: function() {
		return "<tr><th colspan='4'>Max ship size</th></tr><tr><td colspan='4'>" +
			"<span class='size-tag size-s'>S</span> frig " +
			"<span class='size-tag size-m'>M</span> 62kt " +
			"<span class='size-tag size-l'>L</span> 410kt " +
			"<span class='size-tag size-vl'>VL</span> freighter " +
			"<span class='size-tag size-xl'>XL</span> capital " +
			"<span class='size-tag size-l size-uncertain'>L?</span> guessed" +
			"</td></tr>";
	},

	/** Whether size tags are switched on in the given user options (options.sizeTags.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.sizeTags && opts.sizeTags.enabled === false);
	},

	install: function(chainObj) {
		if (!chainObj || typeof chainObj.nodes !== 'function' || chainObj.nodes.sizeTagsWrapped) { return; }
		const previous = chainObj.nodes;
		const wrapped = function() {
			const result = previous.apply(this, arguments);
			if (!sizeTags.enabled(typeof options !== 'undefined' ? options : undefined)) { return result; }
			return sizeTags.decorate(result, sizeTags.wormholeTypeFor);
		};
		wrapped.sizeTagsWrapped = true;
		chainObj.nodes = wrapped;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	if (typeof chain !== "undefined") { sizeTags.install(chain); }
	$(function() {
		if (typeof chain !== "undefined") { sizeTags.install(chain); }
		const legend = $("#show-chainLegend");
		const tip = legend.attr("data-tooltip");
		if (tip && tip.indexOf("size-tag") < 0 && tip.indexOf("</table>") >= 0) {
			legend.attr("data-tooltip", tip.replace("</table>", sizeTags.legendRow() + "</table>"));
		}

		// Settings > Chain Map Settings: "Hole size tags" checkbox. Like the other chain settings it takes
		// effect on the dialog's Save (upstream Save then runs options.apply() -> chain.redraw() and options.save(),
		// which persists options.sizeTags); Close/Cancel discards it and every open re-reads the stored value.
		const $table = $("#dialog-options #optionsAccordion > div").eq(1).find("table.optionsTable").first();
		if ($table.length && !$("#sizeTags-enabled").length) {
			$table.append("<tr><th>Hole size tags:</th><td><label><input type='checkbox' id='sizeTags-enabled' /> Show max ship size on nodes</label></td></tr>");
		}
		$(document).on("dialogopen", "#dialog-options", function() {
			$("#sizeTags-enabled").prop("checked", sizeTags.enabled(options));
		});
		// Capture phase so the value is in place before upstream's Save handler applies and saves options
		document.addEventListener("click", function(e) {
			const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
			if (!button || $.trim($(button).text()) !== "Save") { return; }
			if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#sizeTags-enabled").length) { return; }
			options.sizeTags = { enabled: $("#sizeTags-enabled").prop("checked") };
		}, true);
	});
}
