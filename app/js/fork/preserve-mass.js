const preserveMass = {
	// "Preserve mass" flags on chain map connections: anyone on the mask marks a wormhole that must not be rolled
	// or have mass burnt on it (home static, the fleet's way back). Shared per mask through public/preserve_mass.php,
	// polled like the rally point. Fork-owned; keep `const preserveMass` on the first line (the test helper strips it).
	URL: "preserve_mass.php",
	POLL_MS: 10000,
	REASON_MAX: 100,
	MENU_COMMAND: "preserveMass",
	GLYPH: "⊘",	// circled slash: "don't"

	// Flags by wormhole id: { wormholeID, setBy, setAt (unix seconds or null), reason }
	flags: {},

	/** A Tripwire wormhole id (wormholes.id): a positive integer. Not EVE-Scout links ('ES-...') or '?' */
	isWormholeID: function(id) {
		if (id === null || id === undefined || id === "" || typeof id === "boolean") { return false; }
		const s = String(id);
		if (!/^[1-9][0-9]{0,9}$/.test(s)) { return false; }
		return Number(s) <= 2147483647;
	},

	/** Server list -> flags by wormhole id; entries without a valid id are dropped */
	toMap: function(list) {
		const result = {};
		(Array.isArray(list) ? list : []).forEach(function(f) {
			if (!f || !preserveMass.isWormholeID(f.wormholeID)) { return; }
			result[String(f.wormholeID)] = {
				wormholeID: Number(f.wormholeID),
				setBy: f.setBy === undefined || f.setBy === null ? null : String(f.setBy),
				setAt: Number(f.setAt) > 0 ? Number(f.setAt) : null,
				reason: f.reason === undefined || f.reason === null ? "" : String(f.reason)
			};
		});
		return result;
	},

	/** Whether two flag maps differ (anything a viewer would see) */
	changed: function(a, b) {
		const key = function(m) {
			return Object.keys(m || {}).sort().map(function(id) {
				const f = m[id];
				return [id, f.setBy, f.setAt, f.reason].join("\u0001");
			}).join("\u0002");
		};
		return key(a) !== key(b);
	},

	/** Reason as sent: whitespace runs and control characters become one space, zero-width and direction marks
	are dropped, trimmed, at most REASON_MAX characters (the server does the same) */
	cleanReason: function(text) {
		if (text === undefined || text === null) { return ""; }
		const s = String(text)
			.replace(/[­​-‏‪-‮⁠-⁤⁦-⁯﻿]/g, "")
			.replace(/[\s\u0000-\u001F\u007F-\u009F]+/g, " ")
			.trim();
		return Array.from(s).slice(0, preserveMass.REASON_MAX).join("");
	},

	/** "2026-10-10 19:08 EVE" (EVE time is UTC) for unix seconds; "" when unknown */
	formatTime: function(unixSeconds) {
		const n = Number(unixSeconds);
		if (!(n > 0)) { return ""; }
		const d = new Date(n * 1000);
		const p = function(x) { return (x < 10 ? "0" : "") + x; };
		return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " +
			p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + " EVE";
	},

	/** "Set by Chribba, 2026-10-10 19:08 EVE" (parts left out when unknown) */
	setByText: function(flag) {
		if (!flag) { return ""; }
		const parts = [];
		if (flag.setBy) { parts.push("Set by " + flag.setBy); }
		const when = preserveMass.formatTime(flag.setAt);
		if (when) { parts.push(parts.length ? when : "Set " + when); }
		return parts.join(", ");
	},

	/** Plain-text tooltip for the marker (escape it before putting it in markup) */
	tooltipText: function(flag) {
		if (!flag) { return ""; }
		const lines = ["Preserve mass: don't roll this hole"];
		const by = preserveMass.setByText(flag);
		if (by) { lines.push(by); }
		if (flag.reason) { lines.push("Reason: " + flag.reason); }
		return lines.join("\n");
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Marker markup for the chain map. extraClass: fixed class names; left/top/transform: numbers (px) only */
	markerHtml: function(flag, extraClass, position) {
		if (!flag) { return ""; }
		const num = function(v) { return Math.round(Number(v) || 0); };
		let style = "";
		if (position) {
			if (position.left !== undefined) { style += "left: " + num(position.left) + "px; "; }
			if (position.top !== undefined) { style += "top: " + num(position.top) + "px; "; }
			if (position.shift !== undefined) { style += "transform: translate(" + num(position.shift) + "px, 0); "; }
		}
		return "<span class='preserve-mass-marker size-tag-connector" + (extraClass ? " " + extraClass : "") + "'" +
			(style ? " style='" + style.trim() + "'" : "") +
			" title='" + preserveMass.escape(preserveMass.tooltipText(flag)) + "'>" + preserveMass.GLYPH + "</span>";
	},

	/** Mass dialog: the warning above the rolling verdicts for a flagged hole, or the link to flag it */
	panelHtml: function(flag) {
		const e = preserveMass.escape;
		if (!flag) {
			return "<a href='#' class='pm-mark' title='Mark this hole so nobody rolls it; everyone on your mask sees it'>" +
				preserveMass.GLYPH + " Preserve mass&hellip;</a>";
		}
		const by = preserveMass.setByText(flag);
		return "<div class='pm-warning'><span class='pm-glyph'>" + preserveMass.GLYPH + "</span> Preserve mass &mdash; don't roll this hole" +
			" <a href='#' class='pm-clear' title='Remove the preserve mass flag'>Clear</a></div>" +
			(by || flag.reason ? "<div class='pm-meta'>" + e(by) + (by && flag.reason ? ": " : "") +
				(flag.reason ? "<span class='pm-reason'>" + e(flag.reason) + "</span>" : "") + "</div>" : "");
	},

	/** Left edge (map px) for a marker set just right of a size tag centred on x with the given width */
	besideTag: function(x, tagWidth, gap) {
		return x + (Number(tagWidth) || 0) / 2 + (gap === undefined ? 2 : gap);
	},

	/** Half the marker's size in map px */
	MARKER_HALF: { x: 8, y: 6 },
	GAP: 2,

	/** Centre for a marker next to a size tag centred on point (tag: { width, height }): right of it, else left,
	below or above, whichever covers the least of the obstacles ({ x0, y0, x1, y1 } map rects: the two nodes, their
	badges and text). Without a tag the marker goes on the point itself. */
	besidePoint: function(point, tag, obstacles) {
		if (!tag || !(tag.width > 0)) { return { x: point.x, y: point.y }; }
		const h = preserveMass.MARKER_HALF, g = preserveMass.GAP, tw = tag.width / 2, th = (tag.height || 0) / 2;
		const candidates = [
			{ x: point.x + tw + g + h.x, y: point.y },
			{ x: point.x - tw - g - h.x, y: point.y },
			{ x: point.x, y: point.y + th + g + h.y },
			{ x: point.x, y: point.y - th - g - h.y }
		];
		const overlap = function(a, b) {
			const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), hh = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
			return w > 0 && hh > 0 ? w * hh : 0;
		};
		let best = candidates[0], bestCost = Infinity;
		candidates.forEach(function(c) {
			const rect = { x0: c.x - h.x, y0: c.y - h.y, x1: c.x + h.x, y1: c.y + h.y };
			const cost = (obstacles || []).reduce(function(acc, r) { return acc + (r ? overlap(rect, r) : 0); }, 0);
			if (cost < bestCost) { bestCost = cost; best = c; }
		});
		return best;
	},

	/** Rect ({ x0, y0, x1, y1 }) of a box of the given size centred on x, y (NaN-safe: an empty rect at 0, 0) */
	centredRect: function(x, y, width, height) {
		x = Number(x) || 0; y = Number(y) || 0;
		const w = (Number(width) || 0) / 2, h = (Number(height) || 0) / 2;
		return { x0: x - w, y0: y - h, x1: x + w, y1: y + h };
	},

	/** Centres for several markers on one map: each goes next to its own tag (besidePoint), avoiding its nodes'
	boxes (item.obstacles), every size tag on the map (tagRects) and the markers placed before it.
	@param items [{ point, tag, obstacles }] @return [{ x, y }] in the same order */
	layout: function(items, tagRects) {
		const h = preserveMass.MARKER_HALF;
		const markers = [];
		return (items || []).map(function(item) {
			const at = preserveMass.besidePoint(item.point, item.tag, (item.obstacles || []).concat(tagRects || [], markers));
			markers.push({ x0: at.x - h.x, y0: at.y - h.y, x1: at.x + h.x, y1: at.y + h.y });
			return at;
		});
	},

	/** Whether the markers are switched on (options.preserveMass.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.preserveMass && opts.preserveMass.enabled === false);
	},

	/** The flag of a chain renderer node's connection (node.connection = [child, parent, modifiers, wormholeId]) */
	flagForNode: function(node, flags) {
		const id = node && node.connection ? node.connection[3] : undefined;
		if (!preserveMass.isWormholeID(id)) { return null; }
		return (flags || {})[String(id)] || null;
	},

	/** POST body for a change */
	payload: function(mode, wormholeID, reason) {
		const body = { mode: mode, wormholeID: Number(wormholeID) };
		if (mode === "set") { body.reason = preserveMass.cleanReason(reason); }
		return body;
	},

	legendRow: function() {
		return "<tr><th colspan='4'>Preserve mass</th></tr><tr><td colspan='4'>" +
			"<span class='preserve-mass-marker preserve-mass-legend'>" + preserveMass.GLYPH + "</span> don't roll this hole</td></tr>";
	},

	// ---- Browser-only code below (not run under mocha) ----

	options: function() { return typeof options !== "undefined" ? options : undefined; },

	/** Canvas renderers: called after size-tags placed its tags (same geometry), so the marker can sit right of
	the size tag on the same connection, or on the line's visible midpoint when there is no tag */
	placeOnDrawnMap: function(renderer, drawConnection, nodes) {
		if (!preserveMass.enabled(preserveMass.options()) || typeof sizeTags === "undefined") { return; }
		const placed = [], containers = [];
		(nodes || []).forEach(function(node) {
			try {
				const flag = preserveMass.flagForNode(node, preserveMass.flags);
				if (!flag || !node.parent || !node.parent.position || !node.position) { return; }
				const container = node.domNode && node.domNode.parentNode;
				if (!container || node.domNode.style.display == "none") { return; }	// child of a collapsed system
				const path = sizeTags.tracePath(drawConnection, renderer, node);
				const child = sizeTags.measureNode(node) || { box: sizeTags.nodeRect(node), badges: [], texts: [] };
				const parent = sizeTags.measureNode(node.parent) || { box: sizeTags.nodeRect(node.parent), badges: [], texts: [] };
				const point = sizeTags.pointOnPath(path, [child.box, parent.box], child.badges.concat(parent.badges), child.texts.concat(parent.texts));
				if (!point) { return; }
				const left = Math.round(point.x) + "px", top = Math.round(point.y) + "px";
				const tag = Array.prototype.filter.call(container.querySelectorAll(".size-tag.size-tag-connector"), function(t) {
					return t.style.left === left && t.style.top === top;
				})[0];
				if (containers.indexOf(container) < 0) { containers.push(container); }
				placed.push({ container: container, flag: flag, point: point, tag: tag ? { width: tag.offsetWidth, height: tag.offsetHeight } : null,
					obstacles: [child.box, parent.box].concat(child.badges, parent.badges, child.texts, parent.texts) });
			} catch (e) {
				if (typeof console !== "undefined") { console.warn("preserve-mass: could not place marker", e); }
			}
		});
		// Every size tag on the map (other connections' too) is an obstacle; read before any marker is added
		const tagRects = containers.map(function(container) {
			return Array.prototype.map.call(container.querySelectorAll(".size-tag.size-tag-connector"), function(t) {
				return preserveMass.centredRect(parseFloat(t.style.left), parseFloat(t.style.top), t.offsetWidth, t.offsetHeight);
			});
		});
		containers.forEach(function(container, i) {
			const mine = placed.filter(function(p) { return p.container === container; });
			preserveMass.layout(mine, tagRects[i]).forEach(function(at, j) {
				container.insertAdjacentHTML("beforeend", preserveMass.markerHtml(mine[j].flag, "pm-centred", { left: at.x, top: at.y }));
			});
		});
	},

	/** Old org chart (Google OrgChart): on the vertical connector cell above the child node, right of its size tag */
	placeOnOrgChart: function() {
		$("#chainMap .preserve-mass-marker").remove();
		if (!preserveMass.enabled(preserveMass.options())) { return; }
		$("#chainMap div.node[data-sigid]").each(function() {
			const flag = preserveMass.flags[String($(this).attr("data-sigid"))];
			if (!flag || !preserveMass.isWormholeID($(this).attr("data-sigid"))) { return; }
			const $td = $(this).parent();
			if (!$td.length || !$td.is(":visible") || typeof $td[0].cellIndex !== "number") { return; }
			const index = Math.ceil(($td[0].cellIndex + 1) / 2 - 1);
			const cell = $td.parent().prev().children("td.google-visualization-orgchart-lineleft, td.google-visualization-orgchart-lineright")[index];
			if (!cell) { return; }
			const side = $(cell).hasClass("google-visualization-orgchart-lineleft") ? "pm-on-left" : "pm-on-right";
			const tag = $(cell).children(".size-tag")[0];
			$(cell).addClass("size-tag-cell").append(preserveMass.markerHtml(flag, "pm-orgchart " + side,
				tag ? { shift: preserveMass.besideTag(0, tag.offsetWidth) } : null));
		});
	},

	/** Draw the markers again after the flags changed, without a full redraw where possible */
	refreshMap: function() {
		if (typeof chain === "undefined" || !chain || !chain.renderer) { return; }
		const r = chain.renderer;
		try {
			if (r.sizeTagsOrgChart) {
				if (!r.drawing && r.lastLineData) { sizeTags.placeOnOrgChart(r.lastLineData.map); }
			} else if (r.sizeTagsLast && typeof sizeTags !== "undefined") {
				sizeTags.placeAgain(chain);
			} else if (chain.data && chain.data.rawMap) {
				chain.redraw();
			}
		} catch (e) { console.warn("preserve-mass: could not refresh the map", e); }
	},

	/** Apply a server list */
	apply: function(list) {
		const next = preserveMass.toMap(list);
		if (!preserveMass.changed(preserveMass.flags, next)) { return; }
		preserveMass.flags = next;
		preserveMass.refreshMap();
		preserveMass.renderMassPanel();
	},

	fetch: function() {
		return $.ajax({ url: preserveMass.URL, type: "GET", dataType: "JSON", cache: false })
			.done(function(data) { if (data && data.flags) { preserveMass.apply(data.flags); } });
	},

	post: function(body) {
		return $.ajax({
			url: preserveMass.URL, type: "POST", dataType: "JSON", data: body,
			headers: { "X-Requested-With": "XMLHttpRequest" }
		}).done(function(data) {
			if (data && data.flags) { preserveMass.apply(data.flags); }
		}).fail(function() {
			if (typeof Notify !== "undefined") { Notify.trigger("Couldn't update the preserve mass flag", "red"); }
			preserveMass.fetch();
		});
	},

	/** Apply a local change at once (the server's answer replaces it) */
	optimistic: function(wormholeID, flag) {
		const next = Object.assign({}, preserveMass.flags);
		if (flag) { next[String(wormholeID)] = flag; } else { delete next[String(wormholeID)]; }
		preserveMass.flags = next;
		preserveMass.refreshMap();
		preserveMass.renderMassPanel();
	},

	set: function(wormholeID, reason) {
		if (!preserveMass.isWormholeID(wormholeID)) { return; }
		const body = preserveMass.payload("set", wormholeID, reason);
		preserveMass.optimistic(wormholeID, { wormholeID: Number(wormholeID), setBy: tripwire.client && tripwire.client.EVE ? tripwire.client.EVE.characterName : null,
			setAt: Math.floor(Date.now() / 1000), reason: body.reason });
		return preserveMass.post(body);
	},

	clear: function(wormholeID) {
		if (!preserveMass.isWormholeID(wormholeID)) { return; }
		preserveMass.optimistic(wormholeID, null);
		return preserveMass.post(preserveMass.payload("clear", wormholeID));
	},

	/** "J152820 → J163701 (H296)" for a wormhole of the mask, or "" */
	holeLabel: function(wormholeID) {
		const wormhole = tripwire.client && tripwire.client.wormholes ? tripwire.client.wormholes[wormholeID] : null;
		if (!wormhole) { return ""; }
		const a = tripwire.client.signatures[wormhole.initialID], b = tripwire.client.signatures[wormhole.secondaryID];
		const name = function(sig) {
			if (!sig) { return "?"; }
			try { return systemAnalysis.analyse(sig.systemID).name || String(sig.systemID); } catch (e) { return String(sig.systemID); }
		};
		const from = wormhole.parent === "secondary" ? b : a, to = wormhole.parent === "secondary" ? a : b;
		return name(from) + " → " + name(to) + (wormhole.type && wormhole.type !== "????" ? " (" + wormhole.type + ")" : "");
	},

	/** Ask for the optional reason, then flag the hole */
	openDialog: function(wormholeID) {
		if (!preserveMass.isWormholeID(wormholeID)) { return; }
		let $d = $("#dialog-preserve-mass");
		if (!$d.length) {
			$d = $("<div id='dialog-preserve-mass' title='Preserve mass'>" +
				"<p class='pm-dialog-hole'></p>" +
				"<p class='pm-dialog-help'>Marks this hole so nobody rolls it or burns its mass. Everyone on your mask sees the marker on the chain map and a warning in the mass dialog.</p>" +
				"<p><label>Reason (optional)<br><input type='text' class='pm-dialog-reason' maxlength='" + preserveMass.REASON_MAX + "' placeholder='e.g. home static, fleet still out'></label></p>" +
				"</div>").appendTo("body");
			$d.dialog({
				autoOpen: false, modal: true, width: 360, resizable: false,
				buttons: {
					"Preserve mass": function() {
						preserveMass.set($d.data("wormholeID"), $d.find(".pm-dialog-reason").val());
						$(this).dialog("close");
					},
					Cancel: function() { $(this).dialog("close"); }
				}
			});
			$d.on("keydown", ".pm-dialog-reason", function(e) {
				if (e.key === "Enter") { e.preventDefault(); $d.parent().find(".ui-dialog-buttonpane button").first().click(); }
			});
		}
		$d.data("wormholeID", Number(wormholeID));
		$d.find(".pm-dialog-hole").text(preserveMass.holeLabel(wormholeID));
		const existing = preserveMass.flags[String(wormholeID)];
		$d.find(".pm-dialog-reason").val(existing ? existing.reason : "");
		$d.dialog("open");
		$d.find(".pm-dialog-reason").trigger("focus");
	},

	/** Mass dialog: panel above the rolling guidance (fork rolling-calculator) */
	renderMassPanel: function() {
		const $dialog = $("#dialog-mass");
		if (!$dialog.length) { return; }
		let isOpen = false;
		try { isOpen = $dialog.dialog("isOpen"); } catch (e) { isOpen = false; }
		const wormholeID = $dialog.data("id");
		let $p = $("#preserve-mass-panel");
		if (!isOpen || !preserveMass.isWormholeID(wormholeID) || !tripwire.client.wormholes || !tripwire.client.wormholes[wormholeID]) {
			$p.hide().empty();
			return;
		}
		if (!$p.length) { $p = $("<div id='preserve-mass-panel'></div>"); }
		// Directly above the rolling verdicts, or under the "Total recorded" line
		const $rolling = $("#rolling-calc");
		if ($rolling.length) { if ($p.next()[0] !== $rolling[0]) { $p.insertBefore($rolling); } }
		else {
			const $total = $("#mass-jumped").closest("p");
			if ($total.length) { if ($p.prev()[0] !== $total[0]) { $p.insertAfter($total); } } else if (!$p.parent().length) { $dialog.prepend($p); }
		}
		const flag = preserveMass.flags[String(wormholeID)] || null;
		$p.toggleClass("pm-flagged", !!flag).html(preserveMass.panelHtml(flag)).show();
	},

	setupSettings: function() {
		if (typeof options === "undefined") { return; }
		// Settings > Chain Map Settings row; takes effect on Save like its neighbours (upstream Save redraws the chain)
		const $table = $("#dialog-options #optionsAccordion > div").eq(1).find("table.optionsTable").first();
		if ($table.length && !$("#preserveMass-enabled").length) {
			$table.append("<tr><th>Preserve mass:</th><td><label><input type='checkbox' id='preserveMass-enabled' /> Show preserve-mass markers on connections</label></td></tr>");
		}
		$(document).on("dialogopen", "#dialog-options", function() {
			$("#preserveMass-enabled").prop("checked", preserveMass.enabled(options));
		});
		// Capture phase so the value is in place before upstream's Save handler applies and saves the options
		document.addEventListener("click", function(e) {
			const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
			if (!button || $.trim($(button).text()) !== "Save") { return; }
			if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#preserveMass-enabled").length) { return; }
			options.preserveMass = { enabled: $("#preserveMass-enabled").prop("checked") };
		}, true);
		// Settings > Reset: back to on (a missing key means on)
		if (typeof options.reset === "function" && !options.reset.preserveMassWrapped) {
			const reset = options.reset;
			const wrapped = function() {
				const result = reset.apply(this, arguments);
				delete this.preserveMass;
				return result;
			};
			Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
			wrapped.preserveMassWrapped = true;
			options.reset = wrapped;
		}
	},

	/** Draw the markers wherever size-tags draws (it hooks every renderer, draw and collapse) */
	hookSizeTags: function() {
		if (typeof sizeTags === "undefined" || sizeTags.preserveMassHooked) { return; }
		sizeTags.preserveMassHooked = true;
		const placeOnDrawnMap = sizeTags.placeOnDrawnMap;
		sizeTags.placeOnDrawnMap = function() {
			const result = placeOnDrawnMap.apply(this, arguments);
			try { preserveMass.placeOnDrawnMap.apply(preserveMass, arguments); }
			catch (e) { console.warn("preserve-mass: could not place markers", e); }
			return result;
		};
		const placeOnOrgChart = sizeTags.placeOnOrgChart;
		sizeTags.placeOnOrgChart = function() {
			const result = placeOnOrgChart.apply(this, arguments);
			try { preserveMass.placeOnOrgChart(); }
			catch (e) { console.warn("preserve-mass: could not place markers", e); }
			return result;
		};
	},

	/** Threat badges arrive after the draw (async): size-tags moves its tags (and so the markers) off them, but only
	while size tags are on; with them off, move the markers here */
	hookThreatBadges: function() {
		if (typeof systemThreat === "undefined" || typeof systemThreat.patchChain !== "function" || systemThreat.patchChain.preserveMassWrapped) { return; }
		const patchChain = systemThreat.patchChain;
		const wrapped = function() {
			const result = patchChain.apply(this, arguments);
			try {
				if (typeof sizeTags !== "undefined" && !sizeTags.enabled(preserveMass.options()) &&
					preserveMass.enabled(preserveMass.options()) && Object.keys(preserveMass.flags).length) { sizeTags.placeAgain(chain); }
			} catch (e) { console.warn("preserve-mass: could not move markers", e); }
			return result;
		};
		Object.keys(patchChain).forEach(function(k) { wrapped[k] = patchChain[k]; });
		wrapped.preserveMassWrapped = true;
		systemThreat.patchChain = wrapped;
	},

	init: function() {
		if (typeof chain === "undefined" || !chain) { return; }
		preserveMass.hookSizeTags();
		preserveMass.hookThreatBadges();
		preserveMass.setupSettings();

		const legend = $("#show-chainLegend");
		const tip = legend.attr("data-tooltip");
		if (tip && tip.indexOf("preserve-mass-legend") < 0 && tip.indexOf("</table>") >= 0) {
			legend.attr("data-tooltip", tip.replace("</table>", preserveMass.legendRow() + "</table>"));
		}

		// Context menu on a chain node: the hole leading into it (the node's data-sigid is its wormhole id)
		try {
			const chainParent = $("#chainParent");
			const $entry = $("<li data-command='" + preserveMass.MENU_COMMAND + "'><a id='preserveMassMenuItem'>Preserve mass&hellip;</a></li>");
			const $mass = $("#chainMenu > li[data-command='mass']");	// next to "Mass": both are about the hole into this system
			if ($mass.length) { $entry.insertAfter($mass); } else { $("#chainMenu").append($entry); }
			$("#chainMenu").menu("refresh");
			const wormholeOf = function(target) {
				const id = $(target).closest("[data-nodeid]").attr("data-sigid");
				return preserveMass.isWormholeID(id) && tripwire.client.wormholes && tripwire.client.wormholes[id] ? Number(id) : null;
			};

			const originalSelect = chainParent.contextmenu("option", "select");
			chainParent.contextmenu("option", "select", function(e, ui) {
				if (ui.cmd === preserveMass.MENU_COMMAND) {
					const id = wormholeOf(ui.target[0]);
					if (id === null) { return; }
					if (preserveMass.flags[String(id)]) { preserveMass.clear(id); } else { preserveMass.openDialog(id); }
					return;
				}
				return originalSelect ? originalSelect.apply(this, arguments) : undefined;
			});

			const originalBeforeOpen = chainParent.contextmenu("option", "beforeOpen");
			chainParent.contextmenu("option", "beforeOpen", function(e, ui) {
				try {
					const id = wormholeOf(ui.target[0]);
					$(this).contextmenu("showEntry", preserveMass.MENU_COMMAND, id !== null);
					$("#preserveMassMenuItem").html(id !== null && preserveMass.flags[String(id)] ? "Stop preserving mass" : "Preserve mass&hellip;");
				} catch (err) { console.error("preserve-mass: menu update failed", err); }
				return originalBeforeOpen ? originalBeforeOpen.apply(this, arguments) : undefined;
			});
		} catch (e) { console.error("preserve-mass: context menu setup failed", e); }

		// Mass dialog panel (after rolling-calculator created its panel on open, so ours goes above it)
		$(document).on("dialogopen", "#dialog-mass", function() { setTimeout(preserveMass.renderMassPanel, 0); });
		$(document).on("dialogclose", "#dialog-mass", function() { $("#preserve-mass-panel").hide().empty(); });
		$(document).on("click", "#preserve-mass-panel .pm-mark", function(e) {
			e.preventDefault();
			preserveMass.openDialog($("#dialog-mass").data("id"));
		});
		$(document).on("click", "#preserve-mass-panel .pm-clear", function(e) {
			e.preventDefault();
			preserveMass.clear($("#dialog-mass").data("id"));
		});

		preserveMass.fetch();
		setInterval(preserveMass.fetch, preserveMass.POLL_MS);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.menu) {
	$(function() { preserveMass.init(); });
}
