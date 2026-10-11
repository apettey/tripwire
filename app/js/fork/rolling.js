const holeRolling = {
	// "Rolling" flags on chain map connections: anyone on the mask marks a wormhole that we are rolling (burning its
	// mass to collapse it). Shared per mask through public/rolling.php, polled like preserve mass. A sibling of
	// app/js/fork/preserve-mass.js (loaded before this file): it reuses its marker geometry and helpers, places its
	// marker next to the size tag avoiding the preserve-mass marker, and warns when one hole gets both marks.
	// Fork-owned; keep `const holeRolling` on the first line (the test helper strips it).
	URL: "rolling.php",
	POLL_MS: 10000,
	NOTE_MAX: 100,
	MENU_COMMAND: "holeRolling",
	GLYPH: "↻",	// clockwise arrow: "rolling"

	// Flags by wormhole id: { wormholeID, setByID, setBy, setAt (unix seconds or null), note }
	flags: {},

	/** Server list -> flags by wormhole id; entries without a valid id are dropped */
	toMap: function(list) {
		const result = {};
		(Array.isArray(list) ? list : []).forEach(function(f) {
			if (!f || !preserveMass.isWormholeID(f.wormholeID)) { return; }
			result[String(f.wormholeID)] = {
				wormholeID: Number(f.wormholeID),
				setByID: Number(f.setByID) > 0 ? Number(f.setByID) : null,
				setBy: f.setBy === undefined || f.setBy === null ? null : String(f.setBy),
				setAt: Number(f.setAt) > 0 ? Number(f.setAt) : null,
				note: f.note === undefined || f.note === null ? "" : String(f.note)
			};
		});
		return result;
	},

	/** Flags by wormhole id with the passes read from the jump log added (passInfo: by wormhole id) */
	withPasses: function(map, info) {
		const result = {};
		Object.keys(map || {}).forEach(function(id) {
			const p = info && info[id];
			result[id] = p ? Object.assign({}, map[id], { passes: p.passes, massKg: p.massKg }) : map[id];
		});
		return result;
	},

	/** Whether two flag maps differ (anything a viewer would see) */
	changed: function(a, b) {
		const key = function(m) {
			return Object.keys(m || {}).sort().map(function(id) {
				const f = m[id];
				return [id, f.setBy, f.setAt, f.note, f.passes || 0, Math.round(Number(f.massKg || 0) / 1e6)].join("\u0001");
			}).join("\u0002");
		};
		return key(a) !== key(b);
	},

	/** Note as sent: cleaned like the preserve mass reason (the server does the same), at most NOTE_MAX characters */
	cleanNote: function(text) {
		return Array.from(preserveMass.cleanReason(text)).slice(0, holeRolling.NOTE_MAX).join("");
	},

	/** "19:08 EVE" (EVE time is UTC) for unix seconds; "" when unknown */
	eveTime: function(unixSeconds) {
		const n = Number(unixSeconds);
		if (!(n > 0)) { return ""; }
		const d = new Date(n * 1000);
		const p = function(x) { return (x < 10 ? "0" : "") + x; };
		return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + " EVE";
	},

	/** "started by Chribba at 19:08 EVE" (parts left out when unknown) */
	startedText: function(flag) {
		if (!flag) { return ""; }
		const when = holeRolling.eveTime(flag.setAt);
		return ["started", flag.setBy ? "by " + flag.setBy : "", when ? "at " + when : ""].filter(Boolean).join(" ");
	},

	// Passes through flagged holes by wormhole id: { passes, massKg } from the jump log (mass.php); set by refreshPasses
	passInfo: {},
	PASSES_MS: 30000,

	/** "3 passes, 450 kt through" (kt = 1,000 t); "" when the jump log hasn't been read or is empty */
	passesText: function(flag) {
		if (!flag || !(Number(flag.passes) > 0)) { return ""; }
		const n = Number(flag.passes);
		return n + " pass" + (n === 1 ? "" : "es") + ", " + Math.round(Number(flag.massKg || 0) / 1e6).toLocaleString("en-US") + " kt through";
	},

	/** Plain-text tooltip for the marker (escape it before putting it in markup) */
	tooltipText: function(flag) {
		if (!flag) { return ""; }
		const lines = ["Rolling — " + holeRolling.startedText(flag)];
		if (flag.note) { lines.push("Note: " + flag.note); }
		const passes = holeRolling.passesText(flag);
		if (passes) { lines.push(passes); }
		return lines.join("\n");
	},

	/** "Being rolled by Chribba since 19:08 EVE" */
	beingRolledText: function(flag) {
		if (!flag) { return ""; }
		const when = holeRolling.eveTime(flag.setAt);
		return "Being rolled" + (flag.setBy ? " by " + flag.setBy : "") + (when ? " since " + when : "");
	},

	escape: function(text) { return preserveMass.escape(text); },

	/** Marker markup for the chain map. extraClass: fixed class names; left/top/shift: numbers (px) only */
	markerHtml: function(flag, extraClass, position) {
		if (!flag) { return ""; }
		const num = function(v) { return Math.round(Number(v) || 0); };
		let style = "";
		if (position) {
			if (position.left !== undefined) { style += "left: " + num(position.left) + "px; "; }
			if (position.top !== undefined) { style += "top: " + num(position.top) + "px; "; }
			if (position.shift !== undefined) { style += "transform: translate(" + num(position.shift) + "px, 0); "; }
		}
		return "<span class='hole-rolling-marker size-tag-connector" + (extraClass ? " " + extraClass : "") + "'" +
			(style ? " style='" + style.trim() + "'" : "") +
			" title='" + holeRolling.escape(holeRolling.tooltipText(flag)) + "'>" + holeRolling.GLYPH + "</span>";
	},

	/** Mass dialog: the "being rolled" line for a flagged hole, or the link to flag it */
	panelHtml: function(flag) {
		const e = holeRolling.escape;
		if (!flag) {
			return "<a href='#' class='hr-mark' title='Mark that we are rolling this hole; everyone on your mask sees it'>" +
				holeRolling.GLYPH + " Rolling&hellip;</a>";
		}
		return "<div class='hr-line'><span class='hr-glyph'>" + holeRolling.GLYPH + "</span> " + e(holeRolling.beingRolledText(flag)) +
			" <a href='#' class='hr-clear' title='Rolling is done: remove the rolling mark'>Stop rolling</a>" +
			" <a href='#' class='hr-rolled' title='The hole is rolled (closed): remove the mark and tell Discord it was rolled'>Rolled (closed)</a></div>" +
			(flag.note ? "<div class='hr-meta'><span class='hr-note'>" + e(flag.note) + "</span></div>" : "");
	},

	/** Confirm text when marking rolling on a hole marked preserve mass ("" when it isn't) */
	preserveConflictText: function(pmFlag) {
		if (!pmFlag) { return ""; }
		return "This hole is marked preserve mass" + (pmFlag.setBy ? " by " + pmFlag.setBy : "") +
			(pmFlag.reason ? " (" + pmFlag.reason + ")" : "") + ": roll it anyway?";
	},

	/** Confirm text when marking preserve mass on a hole being rolled ("" when it isn't) */
	rollingConflictText: function(flag) {
		if (!flag) { return ""; }
		return "This hole is being rolled" + (flag.setBy ? " by " + flag.setBy : "") + (flag.note ? " (" + flag.note + ")" : "") +
			": preserve its mass anyway?";
	},

	/** Centres for rolling markers: preserveMass.layout with the preserve-mass markers already on the map as
	obstacles too. @param items [{ point, tag, obstacles }], tagRects / markerRects: map rects. @return [{ x, y }] */
	layout: function(items, tagRects, markerRects) {
		return preserveMass.layout(items, (tagRects || []).concat(markerRects || []));
	},

	/** Old org chart: the marker's shift (px from the connector line) so it sits right of the size tag and the
	preserve-mass marker in the same cell. tagWidth / pmWidth: 0 when there is none. undefined = centred on the line. */
	orgShift: function(tagWidth, pmWidth) {
		const g = preserveMass.GAP;
		const tag = Number(tagWidth) || 0, pm = Number(pmWidth) || 0;
		if (tag > 0) { return preserveMass.besideTag(0, tag) + (pm > 0 ? pm + g : 0); }
		if (pm > 0) { return pm / 2 + g; }	// the preserve-mass marker is centred on the line without a tag
		return undefined;
	},

	/** Whether the markers are switched on (options.rolling.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.rolling && opts.rolling.enabled === false);
	},

	/** The flag of a chain renderer node's connection (node.connection = [child, parent, modifiers, wormholeId]) */
	flagForNode: function(node, flags) {
		return preserveMass.flagForNode(node, flags);
	},

	/** POST body for a change */
	payload: function(mode, wormholeID, note) {
		const body = { mode: mode, wormholeID: Number(wormholeID) };
		if (mode === "set") { body.note = holeRolling.cleanNote(note); }
		return body;
	},

	legendRow: function() {
		return "<tr><th colspan='4'>Rolling</th></tr><tr><td colspan='4'>" +
			"<span class='hole-rolling-marker hole-rolling-legend'>" + holeRolling.GLYPH + "</span> we are rolling this hole</td></tr>";
	},

	// ---- Browser-only code below (not run under mocha) ----

	options: function() { return typeof options !== "undefined" ? options : undefined; },

	/** Canvas renderers: called after size-tags and preserve-mass placed theirs (same geometry), so the marker sits
	next to the connection's size tag, clear of every tag and preserve-mass marker, or on the line's visible midpoint */
	placeOnDrawnMap: function(renderer, drawConnection, nodes) {
		if (!holeRolling.enabled(holeRolling.options()) || typeof sizeTags === "undefined") { return; }
		const placed = [], containers = [];
		(nodes || []).forEach(function(node) {
			try {
				const flag = holeRolling.flagForNode(node, holeRolling.flags);
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
				if (typeof console !== "undefined") { console.warn("rolling: could not place marker", e); }
			}
		});
		const rectsOf = function(container, selector) {
			return Array.prototype.map.call(container.querySelectorAll(selector), function(t) {
				return preserveMass.centredRect(parseFloat(t.style.left), parseFloat(t.style.top), t.offsetWidth, t.offsetHeight);
			});
		};
		containers.forEach(function(container) {
			const mine = placed.filter(function(p) { return p.container === container; });
			// Every size tag and preserve-mass marker on the map is an obstacle; read before any marker is added
			const tags = rectsOf(container, ".size-tag.size-tag-connector");
			const markers = rectsOf(container, ".preserve-mass-marker.pm-centred");
			holeRolling.layout(mine, tags, markers).forEach(function(at, j) {
				container.insertAdjacentHTML("beforeend", holeRolling.markerHtml(mine[j].flag, "hr-centred", { left: at.x, top: at.y }));
			});
		});
	},

	/** Old org chart (Google OrgChart): on the vertical connector cell above the child node, right of its size tag and
	preserve-mass marker */
	placeOnOrgChart: function() {
		$("#chainMap .hole-rolling-marker").remove();
		if (!holeRolling.enabled(holeRolling.options())) { return; }
		$("#chainMap div.node[data-sigid]").each(function() {
			const flag = holeRolling.flags[String($(this).attr("data-sigid"))];
			if (!flag || !preserveMass.isWormholeID($(this).attr("data-sigid"))) { return; }
			const $td = $(this).parent();
			if (!$td.length || !$td.is(":visible") || typeof $td[0].cellIndex !== "number") { return; }
			const index = Math.ceil(($td[0].cellIndex + 1) / 2 - 1);
			const cell = $td.parent().prev().children("td.google-visualization-orgchart-lineleft, td.google-visualization-orgchart-lineright")[index];
			if (!cell) { return; }
			const side = $(cell).hasClass("google-visualization-orgchart-lineleft") ? "hr-on-left" : "hr-on-right";
			const tag = $(cell).children(".size-tag")[0], pm = $(cell).children(".preserve-mass-marker")[0];
			const shift = holeRolling.orgShift(tag ? tag.offsetWidth : 0, pm ? pm.offsetWidth : 0);
			$(cell).addClass("size-tag-cell").append(holeRolling.markerHtml(flag, "hr-orgchart " + side, shift === undefined ? null : { shift: shift }));
		});
	},

	/** Apply a server list */
	apply: function(list) {
		const next = holeRolling.withPasses(holeRolling.toMap(list), holeRolling.passInfo);
		if (!holeRolling.changed(holeRolling.flags, next)) { return; }
		holeRolling.flags = next;
		preserveMass.refreshMap();	// redraws every marker (size tags, preserve mass and these)
		holeRolling.renderMassPanel();
	},

	fetch: function() {
		return $.ajax({ url: holeRolling.URL, type: "GET", dataType: "JSON", cache: false })
			.done(function(data) {
				if (data && data.flags) { holeRolling.apply(data.flags); }
				holeRolling.refreshPasses();
			});
	},

	/** Mass of one jump log row (mass.php) in kg, or null when its ship is unknown: the fitted mass when logged, else the
	hull with the hot/cold prop rule, like the mass dialog */
	rowMass: function(row) {
		const ship = typeof appData !== "undefined" && appData.mass ? appData.mass[row.shipTypeID] : null;
		if (!ship) { return null; }
		const hull = parseFloat(ship.mass);
		const flags = String(row.shipType || "").split("|", 2)[1] || "";
		const j = { originalMass: hull, prop: flags.indexOf("p") >= 0, higgs: flags.indexOf("h") >= 0 };
		if (typeof autoMass !== "undefined" && typeof autoMass.jumpMass === "function") { return autoMass.jumpMass(row, j).mass; }
		return (hull + (j.prop ? (hull > 500e6 ? 500e6 : 50e6) : 0)) * (j.higgs ? 2 : 1);
	},

	/** Flagged holes whose jump log is due: never tried, or last tried over PASSES_MS ago (a failed try counts as a try, so
		a failing mass.php is not hammered); holes already being read are left out.
		@param tried {id: ms of the last attempt} @param busy {id: true} */
	passesDue: function(ids, tried, busy, now) {
		return (ids || []).filter(function(id) {
			return !(busy && busy[id]) && !(tried && tried[id] && now - tried[id] < holeRolling.PASSES_MS);
		});
	},

	passesTried: {},	// by wormhole id: ms of the last attempt
	passesBusy: {},		// by wormhole id: a request is out

	/** Read the jump logs of the flagged holes that are due, for the marker tooltip's "N passes, X kt through".
		Only while the markers are on (the line is part of their tooltip). */
	refreshPasses: function() {
		if (!holeRolling.enabled(holeRolling.options())) { return; }
		const ids = Object.keys(holeRolling.flags);
		Object.keys(holeRolling.passesTried).forEach(function(id) { if (ids.indexOf(id) < 0) { delete holeRolling.passesTried[id]; delete holeRolling.passInfo[id]; } });
		const now = Date.now();
		holeRolling.passesDue(ids, holeRolling.passesTried, holeRolling.passesBusy, now).forEach(function(id) {
			holeRolling.passesTried[id] = now;
			holeRolling.passesBusy[id] = true;
			$.ajax({ url: "mass.php", type: "POST", data: { wormholeID: id }, dataType: "JSON", timeout: 15000 })
				.done(function(data) {
					if (!data || !data.jumps || typeof rollingCalc === "undefined") { return; }
					holeRolling.passInfo[id] = rollingCalc.summarisePasses(data.jumps, holeRolling.rowMass);
					const next = holeRolling.withPasses(holeRolling.flags, holeRolling.passInfo);
					if (holeRolling.changed(holeRolling.flags, next)) {
						holeRolling.flags = next;
						preserveMass.refreshMap();
					}
				})
				.always(function() { delete holeRolling.passesBusy[id]; });
		});
	},

	post: function(body) {
		return $.ajax({
			url: holeRolling.URL, type: "POST", dataType: "JSON", data: body,
			headers: { "X-Requested-With": "XMLHttpRequest" }
		}).done(function(data) {
			if (data && data.flags) { holeRolling.apply(data.flags); }
		}).fail(function() {
			if (typeof Notify !== "undefined") { Notify.trigger("Couldn't update the rolling mark", "red"); }
			holeRolling.fetch();
		});
	},

	/** Apply a local change at once (the server's answer replaces it) */
	optimistic: function(wormholeID, flag) {
		const next = Object.assign({}, holeRolling.flags);
		if (flag) { next[String(wormholeID)] = flag; } else { delete next[String(wormholeID)]; }
		holeRolling.flags = holeRolling.withPasses(next, holeRolling.passInfo);
		preserveMass.refreshMap();
		holeRolling.renderMassPanel();
	},

	set: function(wormholeID, note) {
		if (!preserveMass.isWormholeID(wormholeID)) { return; }
		const body = holeRolling.payload("set", wormholeID, note);
		const eve = tripwire.client && tripwire.client.EVE ? tripwire.client.EVE : null;
		holeRolling.optimistic(wormholeID, { wormholeID: Number(wormholeID), setByID: eve ? Number(eve.characterID) || null : null,
			setBy: eve ? eve.characterName : null, setAt: Math.floor(Date.now() / 1000), note: body.note });
		return holeRolling.post(body);
	},

	clear: function(wormholeID, rolled) {
		if (!preserveMass.isWormholeID(wormholeID)) { return; }
		holeRolling.optimistic(wormholeID, null);
		return holeRolling.post(holeRolling.payload(rolled ? "rolled" : "clear", wormholeID));
	},

	/** Ask for the optional note, then flag the hole (after a confirm when it is marked preserve mass) */
	openDialog: function(wormholeID) {
		if (!preserveMass.isWormholeID(wormholeID)) { return; }
		let $d = $("#dialog-hole-rolling");
		if (!$d.length) {
			$d = $("<div id='dialog-hole-rolling' title='Rolling'>" +
				"<p class='hr-dialog-hole'></p>" +
				"<p class='hr-dialog-help'>Marks that we are rolling this hole. Everyone on your mask sees the marker on the chain map and a line in the mass dialog. Use Stop rolling when you are done.</p>" +
				"<p><label>Note (optional)<br><input type='text' class='hr-dialog-note' maxlength='" + holeRolling.NOTE_MAX + "' placeholder='e.g. closing it for a new static'></label></p>" +
				"</div>").appendTo("body");
			$d.dialog({
				autoOpen: false, modal: true, width: 360, resizable: false,
				buttons: {
					"Mark rolling": function() {
						const id = $d.data("wormholeID");
						const conflict = holeRolling.preserveConflictText(preserveMass.flags[String(id)]);
						if (conflict && !window.confirm(conflict)) { return; }
						holeRolling.set(id, $d.find(".hr-dialog-note").val());
						$(this).dialog("close");
					},
					Cancel: function() { $(this).dialog("close"); }
				}
			});
			$d.on("keydown", ".hr-dialog-note", function(e) {
				if (e.key === "Enter") { e.preventDefault(); $d.parent().find(".ui-dialog-buttonpane button").first().click(); }
			});
		}
		$d.data("wormholeID", Number(wormholeID));
		$d.find(".hr-dialog-hole").text(preserveMass.holeLabel(wormholeID));
		const existing = holeRolling.flags[String(wormholeID)];
		$d.find(".hr-dialog-note").val(existing ? existing.note : "");
		$d.dialog("open");
		$d.find(".hr-dialog-note").trigger("focus");
	},

	/** Mass dialog: the line directly above the preserve-mass panel (both above the rolling calculator's verdicts) */
	renderMassPanel: function() {
		const $dialog = $("#dialog-mass");
		if (!$dialog.length) { return; }
		let isOpen = false;
		try { isOpen = $dialog.dialog("isOpen"); } catch (e) { isOpen = false; }
		const wormholeID = $dialog.data("id");
		let $p = $("#hole-rolling-panel");
		if (!isOpen || !preserveMass.isWormholeID(wormholeID) || !tripwire.client.wormholes || !tripwire.client.wormholes[wormholeID]) {
			$p.hide().empty();
			return;
		}
		if (!$p.length) { $p = $("<div id='hole-rolling-panel'></div>"); }
		// Above the preserve-mass panel (it keeps itself directly above the verdicts), else above the verdicts
		const $anchor = $dialog.find("#preserve-mass-panel").length ? $dialog.find("#preserve-mass-panel") : $dialog.find("#rolling-calc");
		if ($anchor.length) { if ($p.next()[0] !== $anchor[0]) { $p.insertBefore($anchor); } }
		else if (!$p.parent().length) { $dialog.prepend($p); }
		const flag = holeRolling.flags[String(wormholeID)] || null;
		$p.toggleClass("hr-flagged", !!flag).html(holeRolling.panelHtml(flag)).show();
	},

	setupSettings: function() {
		if (typeof options === "undefined" || typeof forkSettings === "undefined") { return; }
		// Settings > Map Markers, right after Preserve mass; takes effect on Save like its neighbours, Reset = on
		forkSettings.register({
			section: "markers", order: 35, id: "rolling-enabled", type: "checkbox", key: "rolling",
			label: "Rolling:", text: "Show rolling markers on connections",
			get: function(o) { return holeRolling.enabled(o); },
			set: function(o, on) { o.rolling = { enabled: on }; }
		});
	},

	/** Draw the markers wherever size-tags draws, after preserve-mass (it hooked size-tags first) */
	hookSizeTags: function() {
		if (typeof sizeTags === "undefined" || sizeTags.holeRollingHooked) { return; }
		sizeTags.holeRollingHooked = true;
		const placeOnDrawnMap = sizeTags.placeOnDrawnMap;
		sizeTags.placeOnDrawnMap = function() {
			const result = placeOnDrawnMap.apply(this, arguments);
			try { holeRolling.placeOnDrawnMap.apply(holeRolling, arguments); }
			catch (e) { console.warn("rolling: could not place markers", e); }
			return result;
		};
		const placeOnOrgChart = sizeTags.placeOnOrgChart;
		sizeTags.placeOnOrgChart = function() {
			const result = placeOnOrgChart.apply(this, arguments);
			try { holeRolling.placeOnOrgChart(); }
			catch (e) { console.warn("rolling: could not place markers", e); }
			return result;
		};
	},

	/** Threat badges arrive after the draw: with size tags off, move the markers here (as preserve-mass does) */
	hookThreatBadges: function() {
		if (typeof systemThreat === "undefined" || typeof systemThreat.patchChain !== "function" || systemThreat.patchChain.holeRollingWrapped) { return; }
		const patchChain = systemThreat.patchChain;
		const wrapped = function() {
			const result = patchChain.apply(this, arguments);
			try {
				if (typeof sizeTags !== "undefined" && !sizeTags.enabled(holeRolling.options()) &&
					holeRolling.enabled(holeRolling.options()) && Object.keys(holeRolling.flags).length) { sizeTags.placeAgain(chain); }
			} catch (e) { console.warn("rolling: could not move markers", e); }
			return result;
		};
		Object.keys(patchChain).forEach(function(k) { wrapped[k] = patchChain[k]; });
		wrapped.holeRollingWrapped = true;
		systemThreat.patchChain = wrapped;
	},

	/** Marking preserve mass on a hole being rolled asks first */
	hookPreserveMass: function() {
		if (preserveMass.set.holeRollingWrapped) { return; }
		const set = preserveMass.set;
		const wrapped = function(wormholeID) {
			const conflict = holeRolling.rollingConflictText(holeRolling.flags[String(wormholeID)]);
			if (conflict && !window.confirm(conflict)) { return; }
			return set.apply(this, arguments);
		};
		wrapped.holeRollingWrapped = true;
		preserveMass.set = wrapped;
	},

	init: function() {
		if (typeof chain === "undefined" || !chain || typeof preserveMass === "undefined") { return; }
		holeRolling.hookSizeTags();
		holeRolling.hookThreatBadges();
		holeRolling.hookPreserveMass();
		holeRolling.setupSettings();

		const legend = $("#show-chainLegend");
		const tip = legend.attr("data-tooltip");
		if (tip && tip.indexOf("hole-rolling-legend") < 0 && tip.indexOf("</table>") >= 0) {
			legend.attr("data-tooltip", tip.replace("</table>", holeRolling.legendRow() + "</table>"));
		}

		// Context menu on a chain node: the hole leading into it (the node's data-sigid is its wormhole id)
		try {
			const chainParent = $("#chainParent");
			const $entry = $("<li data-command='" + holeRolling.MENU_COMMAND + "'><a id='holeRollingMenuItem'>Rolling&hellip;</a></li>");
			const $after = $("#chainMenu > li[data-command='" + preserveMass.MENU_COMMAND + "']").length ?
				$("#chainMenu > li[data-command='" + preserveMass.MENU_COMMAND + "']") : $("#chainMenu > li[data-command='mass']");
			if ($after.length) { $entry.insertAfter($after); } else { $("#chainMenu").append($entry); }
			$("#chainMenu").menu("refresh");
			const wormholeOf = function(target) {
				const id = $(target).closest("[data-nodeid]").attr("data-sigid");
				return preserveMass.isWormholeID(id) && tripwire.client.wormholes && tripwire.client.wormholes[id] ? Number(id) : null;
			};

			const originalSelect = chainParent.contextmenu("option", "select");
			chainParent.contextmenu("option", "select", function(e, ui) {
				if (ui.cmd === holeRolling.MENU_COMMAND) {
					const id = wormholeOf(ui.target[0]);
					if (id === null) { return; }
					if (holeRolling.flags[String(id)]) { holeRolling.clear(id); } else { holeRolling.openDialog(id); }
					return;
				}
				return originalSelect ? originalSelect.apply(this, arguments) : undefined;
			});

			const originalBeforeOpen = chainParent.contextmenu("option", "beforeOpen");
			chainParent.contextmenu("option", "beforeOpen", function(e, ui) {
				try {
					const id = wormholeOf(ui.target[0]);
					$(this).contextmenu("showEntry", holeRolling.MENU_COMMAND, id !== null);
					$("#holeRollingMenuItem").html(id !== null && holeRolling.flags[String(id)] ? "Stop rolling" : "Rolling&hellip;");
				} catch (err) { console.error("rolling: menu update failed", err); }
				return originalBeforeOpen ? originalBeforeOpen.apply(this, arguments) : undefined;
			});
		} catch (e) { console.error("rolling: context menu setup failed", e); }

		// Mass dialog line (after preserve-mass placed its panel on open, so ours goes above it)
		$(document).on("dialogopen", "#dialog-mass", function() { setTimeout(holeRolling.renderMassPanel, 0); });
		$(document).on("dialogclose", "#dialog-mass", function() { $("#hole-rolling-panel").hide().empty(); });
		$(document).on("click", "#hole-rolling-panel .hr-mark", function(e) {
			e.preventDefault();
			holeRolling.openDialog($("#dialog-mass").data("id"));
		});
		$(document).on("click", "#hole-rolling-panel .hr-clear", function(e) {
			e.preventDefault();
			holeRolling.clear($("#dialog-mass").data("id"));
		});
		$(document).on("click", "#hole-rolling-panel .hr-rolled", function(e) {
			e.preventDefault();
			holeRolling.clear($("#dialog-mass").data("id"), true);
		});

		holeRolling.fetch();
		setInterval(holeRolling.fetch, holeRolling.POLL_MS);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.menu) {
	$(function() { holeRolling.init(); });
}
