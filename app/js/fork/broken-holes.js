const brokenHoles = {
	// Fork-owned: broken wormholes (part of the paste preview, paste-preview.js). A hole that was missing from a probe
	// scanner paste can be marked broken instead of deleted: it stays on the chain map, drawn red and dashed with the far
	// system dimmed and a Restore link; its row in the signature list shows "Broken" struck through with a Restore link;
	// and every route through the chain leaves it out (Favourites, Destinations, Get home, the route filters, Thera,
	// the jump planner, the chain's exits). The state is saved per hole and mask (broken_wormholes.inc.php, through
	// refresh.php) so everyone on the mask sees it; it lasts until the hole itself expires or is deleted. Marks and
	// restores are undoable (undo-history.js extra "brokenHoles") and in the audit log; they never post to Discord.
	//
	// Routes only: the chain keeps every row and line (chain alerts, the automapper, kill feeds, the palette, life and
	// size marks all still see the systems behind a broken hole). chain.nodes is wrapped when this file loads (every
	// other wrapper wraps at DOM ready or later, so this one is innermost; app/js-test/fork/broken-holes.test.js pins
	// it) and flag() marks the result: the broken line gets LINE_CLASS in its modifiers, rows whose system can't be
	// reached from the chain's roots without a broken hole get row.brokenHole, and `exits` leaves those systems out.
	// The route features honour the marks: rally.systemConnections (the hole graph of Favourites, Destinations,
	// Fight here, the route filters) skips broken lines; routeDestinations.chainExits / chainSystems,
	// favouritesPanel.chainSystems and jumpPlanner.isExtraRow (Get home, jump ranges) skip broken rows; systemPanel and
	// the region map read the filtered `exits`.
	//
	// The pure part is mocha-tested; the DOM part is below "---- DOM ----".
	// Keep `const brokenHoles` on the first line: the test helper strips it to define a global.

	ids: {},	// {wormholeID: {markedBy, markedAt}} of the mask's broken holes, as the server last sent them
	LINE_CLASS: "broken-hole",
	FAR_CLASS: "broken-hole-far",
	BEYOND_CLASS: "broken-hole-beyond",

	/** Take a server list ([{wormholeID, markedBy, markedAt}]); true when the set of broken holes changed */
	setList: function(list) {
		const next = {};
		(Array.isArray(list) ? list : []).forEach(function(b) {
			if (b && b.wormholeID !== undefined && b.wormholeID !== null) { next[String(b.wormholeID)] = { markedBy: b.markedBy || "", markedAt: b.markedAt || 0 }; }
		});
		const before = Object.keys(brokenHoles.ids).sort().join(",");
		brokenHoles.ids = next;
		return before !== Object.keys(next).sort().join(",");
	},

	isBroken: function(wormholeID) {
		return wormholeID !== undefined && wormholeID !== null && Object.prototype.hasOwnProperty.call(brokenHoles.ids, String(wormholeID));
	},

	/** "mark 2 holes broken", "restore 1 hole", for the undo history's labels. value: {mark: [ids], restore: [ids]} */
	label: function(value) {
		const n = function(list) { return Array.isArray(list) ? list.length : 0; };
		const parts = [];
		if (n(value && value.mark)) { parts.push("mark " + n(value.mark) + " hole" + (n(value.mark) === 1 ? "" : "s") + " broken"); }
		if (n(value && value.restore)) { parts.push("restore " + n(value.restore) + " broken hole" + (n(value.restore) === 1 ? "" : "s")); }
		return parts.join(", ");
	},

	/** The request part that undoes ("undo") or redoes ("redo") a change {mark, restore}: undo swaps them */
	undoPart: function(direction, value) {
		const mark = value && Array.isArray(value.mark) ? value.mark.slice() : [];
		const restore = value && Array.isArray(value.restore) ? value.restore.slice() : [];
		const out = direction === "undo" ? { mark: restore, restore: mark } : { mark: mark, restore: restore };
		if (!out.mark.length) { delete out.mark; }
		if (!out.restore.length) { delete out.restore; }
		return out.mark || out.restore ? out : null;
	},

	/** Two request parts in one ({mark, restore} lists joined) */
	mergeParts: function(a, b) {
		const out = {};
		["mark", "restore"].forEach(function(k) {
			const list = [].concat((a && a[k]) || [], (b && b[k]) || []);
			if (list.length) { out[k] = list; }
		});
		return out;
	},

	/** Whether a chain line is a broken hole's (its modifiers carry LINE_CLASS, set by flag()) */
	isBrokenLine: function(line) {
		return !!line && Array.isArray(line[2]) && line[2].indexOf(brokenHoles.LINE_CLASS) >= 0;
	},

	/**
	 * Mark chain.nodes() output for broken holes, in place; nothing is removed (only routes leave them out).
	 * - each broken hole's line gets LINE_CLASS in its modifiers (drawn red and dashed; route graphs skip it);
	 * - rows whose system can't be reached from the chain's roots without a broken hole get row.brokenHole = true and
	 *   are dimmed (the broken hole's far node FAR_CLASS plus the tag, nodes further out BEYOND_CLASS); a far system
	 *   also reachable another way (a loop) keeps its route;
	 * - result.exits leaves the unreachable systems out (systemsInChainMap is kept whole: it is also a "what is on the
	 *   chain" lookup).
	 * result: {map: {rows: [{c: [{v, f, systemID}, {v}], pathHome}]}, lines: [[childV, parentV, modifiers, wormholeID]],
	 *   exits}; isBroken(wormholeID); tagHtml(wormholeID) -> markup added to the far node's hole line (optional).
	 * Returns {wormholes: [ids on this map], cut: [system ids cut off]} or null when no broken hole is on this map.
	 */
	flag: function(result, isBroken, tagHtml) {
		if (!result || !result.map || !Array.isArray(result.map.rows) || !Array.isArray(result.lines)) { return null; }
		const far = {}, wormholes = [];
		result.lines.forEach(function(line) {
			if (line && line[3] !== undefined && line[3] !== null && isBroken(line[3])) {
				far[line[0]] = line[3];
				if (wormholes.indexOf(line[3]) < 0) { wormholes.push(line[3]); }
				if (Array.isArray(line[2]) && line[2].indexOf(brokenHoles.LINE_CLASS) < 0) { line[2].push(brokenHoles.LINE_CLASS); }
			}
		});
		if (!wormholes.length) { return null; }
		// The systems reachable from the roots over every line but the broken ones (system level: a loop counts)
		const sysOf = {}, roots = [];
		result.map.rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || node.v === undefined) { return; }
			sysOf[node.v] = String(node.systemID);
			const parent = row.c[1] ? row.c[1].v : null;
			if (parent === null || parent === undefined) { roots.push(String(node.systemID)); }
		});
		const adj = {}, lineOf = {}, rowOf = {};
		const link = function(a, b) { (adj[a] = adj[a] || []).push(b); };
		const hole = function(line) { return line[3] !== undefined && line[3] !== null && line[3] !== "?"; };	// not a calculated gate route
		result.map.rows.forEach(function(row) { if (row && row.c && row.c[0]) { rowOf[row.c[0].v] = row; } });
		result.lines.forEach(function(line) {
			if (line) { lineOf[line[0]] = line; }
			if (!line || !hole(line) || far[line[0]] !== undefined && line[3] === far[line[0]]) { return; }
			const a = sysOf[line[0]], b = sysOf[line[1]];
			if (a === undefined || b === undefined) { return; }
			link(a, b); link(b, a);
		});
		const reach = {};
		const queue = roots.slice();
		roots.forEach(function(s) { reach[s] = true; });
		while (queue.length) {
			const s = queue.shift();
			(adj[s] || []).forEach(function(t) { if (!reach[t]) { reach[t] = true; queue.push(t); } });
		}
		// A calculated node (a gate route hung under a system) is cut off when the system it hangs under is
		const offMemo = {};
		const isOff = function(row, depth) {
			const v = row.c[0].v;
			if (offMemo[v] !== undefined) { return offMemo[v]; }
			const parent = row.c[1] ? row.c[1].v : null;
			const line = lineOf[v];
			let off;
			if (parent === null || parent === undefined) { off = false; }
			else if (line && !hole(line) && rowOf[parent] && depth < 200) { off = isOff(rowOf[parent], depth + 1); }
			else { off = !reach[String(row.c[0].systemID)]; }
			return (offMemo[v] = off);
		};
		const cut = [];
		result.map.rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || node.v === undefined) { return; }
			const isFar = far[node.v] !== undefined;
			const off = isOff(row, 0);
			if (off) {
				row.brokenHole = true;
				if (!reach[String(node.systemID)] && cut.indexOf(String(node.systemID)) < 0) { cut.push(String(node.systemID)); }
			}
			if (typeof node.f !== "string" || (!isFar && !off)) { return; }
			const cls = isFar ? brokenHoles.FAR_CLASS : brokenHoles.BEYOND_CLASS;
			if (off || isFar) { node.f = node.f.replace("class='node ", "class='node " + cls + " "); }
			if (isFar && typeof tagHtml === "function") {
				// on the node's hole line ("K162"), so the node keeps its size
				const tag = tagHtml(far[node.v]) || "";
				const start = node.f.indexOf("<h4 class='nodeType'>");
				const end = start >= 0 ? node.f.indexOf("</h4>", start) : -1;
				if (tag && end >= 0) { node.f = node.f.substring(0, end) + tag + node.f.substring(end); }
			}
		});
		if (Array.isArray(result.exits)) {
			result.exits = result.exits.filter(function(x) { return cut.indexOf(String(x)) < 0; });
		}
		return { wormholes: wormholes, cut: cut };
	},

	/** The far node's tag: "✗ Restore" after the hole type, with a tooltip naming the hole (sigName: its ID on the
	near side, may be "") */
	tag: function(wormholeID, sigName) {
		const esc = function(s) { return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
		return " <span class='broken-hole-tag' title='" + esc((sigName ? sigName + " was" : "This hole was") + " missing from a paste, so routes leave it out. Restore it if it is still there.") + "'>&#10007; "
			+ "<a href='#' class='broken-hole-restore' data-wormhole='" + esc(wormholeID) + "'>Restore</a></span>";
	}
};

// ---- DOM ----
if (typeof window !== "undefined" && typeof jQuery !== "undefined" && typeof chain !== "undefined" && chain && typeof chain.nodes === "function") {
	(function() {
		const bh = brokenHoles;

		function sigName(wormholeID) {
			try {
				const w = tripwire.client.wormholes[wormholeID];
				if (!w) { return ""; }
				const a = tripwire.client.signatures[w.initialID], b = tripwire.client.signatures[w.secondaryID];
				const here = a && a.systemID == viewingSystemID ? a : b && b.systemID == viewingSystemID ? b : (a && a.signatureID ? a : b);	// eslint-disable-line eqeqeq
				const id = here && here.signatureID ? String(here.signatureID).toUpperCase() : "";
				return id.length === 6 ? id.substring(0, 3) + "-" + id.substring(3) : id;
			} catch (e) { return ""; }
		}

		// ---- Routes: the innermost chain.nodes wrapper, installed when this file loads (the others wrap at DOM ready) ----
		const nodes = chain.nodes;
		const wrapped = function() {
			const result = nodes.apply(this, arguments);
			try {
				if (result && Object.keys(bh.ids).length) { bh.flag(result, bh.isBroken, function(id) { return bh.tag(id, sigName(id)); }); }
			} catch (e) { console.warn("broken-holes: chain", e); }
			return result;
		};
		Object.keys(nodes).forEach(function(k) { wrapped[k] = nodes[k]; });
		wrapped.brokenHolesWrapped = true;
		chain.nodes = wrapped;

		function redrawChain() {
			if (chain.data && chain.data.rawMap && !chain.drawing) { chain.redraw(); }
		}

		// ---- Signature list: "Broken" struck through, with Restore ----
		function holeBySig() {
			const out = {};
			const holes = (tripwire.client && tripwire.client.wormholes) || {};
			Object.keys(holes).forEach(function(k) {
				const w = holes[k];
				if (w) { out[w.initialID] = w; out[w.secondaryID] = w; }
			});
			return out;
		}
		let decorating = false;
		function decorateRows() {
			if (typeof document === "undefined" || typeof tripwire === "undefined" || !tripwire.client) { return; }
			decorating = true;
			try {
				const holes = holeBySig();
				const redraw = [];
				Array.prototype.forEach.call(document.querySelectorAll("#sigTable tbody tr[data-id]"), function(tr) {
					const w = holes[tr.getAttribute("data-id")];
					const on = !!w && bh.isBroken(w.id);
					const cell = tr.children[4], mass = tr.children[5];	// Life: "Broken"; Mass: the Restore link
					if (on) {
						tr.classList.add("sig-broken");
						if (cell && !cell.querySelector(".broken-hole-label")) {
							cell.classList.add("broken-hole-cell");
							cell.innerHTML = "<span class='broken-hole-label'>Broken</span>";
						}
						if (mass && !mass.querySelector(".broken-hole-restore")) {
							mass.classList.add("broken-hole-cell");
							mass.innerHTML = "<a href='#' class='broken-hole-restore' data-wormhole='" + String(w.id).replace(/\D/g, "") + "'>Restore</a>";
						}
					} else if (tr.classList.contains("sig-broken")) {
						// restored: upstream draws the row again as it is
						const sig = tripwire.client.signatures[tr.getAttribute("data-id")];
						if (sig && typeof tripwire.editSig === "function") { redraw.push(sig); }
						else { tr.classList.remove("sig-broken"); }
					}
				});
				redraw.forEach(function(sig) { try { tripwire.editSig(sig); } catch (e) { console.warn("broken-holes: row", e); } });
				if (redraw.length && typeof lifeStates !== "undefined" && typeof lifeStates.refreshCells === "function") { lifeStates.refreshCells(); }
			} finally { decorating = false; }
		}
		let rowsTimer = null;
		function decorateSoon() {
			clearTimeout(rowsTimer);
			rowsTimer = setTimeout(decorateRows, 0);
		}

		// ---- The mask's list, from every refresh.php answer ----
		bh.receive = function(list) {
			if (bh.setList(list)) { redrawChain(); }
			decorateSoon();
		};
		$(document).ajaxSuccess(function(e, xhr, settings, data) {
			if (!settings || String(settings.url || "").indexOf("refresh.php") < 0 || !data || typeof data !== "object" || data.brokenHoles === undefined) { return; }
			bh.receive(data.brokenHoles);
		});

		// ---- Restore (map and signature list) ----
		bh.restoreHole = function(wormholeID) {
			const id = parseInt(wormholeID, 10);
			if (!(id > 0)) { return; }
			const name = sigName(id) || "The hole";
			const systemID = viewingSystemID;
			tripwire.refresh("refresh", { brokenHoles: { restore: [id] } }, function(data) {
				const r = data && data.brokenHolesResult;
				if (!r || !r.result) {
					Notify.trigger("Couldn't restore " + _.escape(name) + (r && r.error ? " (" + _.escape(r.error) + ")" : "") + ".", "red", 8000);
					return;
				}
				if (data.brokenHoles) { bh.receive(data.brokenHoles); }
				if (!r.restored || r.restored.indexOf(id) < 0) { return; }	// someone else restored it first
				let entry = null;
				if (tripwire.signatures && tripwire.signatures.undo) {
					entry = { action: "update", signatures: [], meta: { extra: { brokenHoles: { restore: [id] } } } };
					(tripwire.signatures.undo[systemID] || (tripwire.signatures.undo[systemID] = [])).push(entry);
					$("#undo").removeClass("disabled");
				}
				if (typeof forkUsage !== "undefined") { forkUsage.track("pastePreview", "restored"); }
				const undoId = "broken-undo-" + Date.now();
				$(document).off("click.brokenUndo").on("click.brokenUndo", "#" + undoId, function(ev) {
					ev.preventDefault();
					$(this).closest(".jBox-wrapper").find(".jBox-closeButton").trigger("click");
					const top = typeof undoHistory !== "undefined" && undoHistory.ui && undoHistory.ui.top ? undoHistory.ui.top("undo") : null;
					if (top && top.indexOf(entry) < 0) { Notify.trigger("Something else was changed since: use the Undo arrow above the signatures.", "yellow", 6000); return; }
					tripwire.undo();
				});
				Notify.trigger(_.escape(name) + " restored: routes use it again." + (entry ? " <a href='#' class='pp-undo' id='" + undoId + "'>Undo</a>" : ""), "green", 6000);
			});
		};
		// Capture phase: before the list's inline editing (sig-inline.js) and the map's node handlers see the click
		document.addEventListener("click", function(e) {
			const a = e.target && e.target.closest ? e.target.closest(".broken-hole-restore") : null;
			if (!a || a.closest("#map-key")) { return; }
			e.preventDefault();
			e.stopPropagation();
			bh.restoreHole(a.getAttribute("data-wormhole"));
		}, true);

		$(function() {
			const tbody = document.querySelector("#sigTable tbody");
			if (tbody && typeof MutationObserver !== "undefined") {
				new MutationObserver(function() { if (!decorating) { decorateSoon(); } }).observe(tbody, { childList: true, subtree: true, characterData: true });
			}
			// Undo / redo of marks and restores go through the same request (undo-history.js)
			if (typeof undoHistory !== "undefined" && typeof undoHistory.registerExtra === "function") {
				undoHistory.registerExtra("brokenHoles", {
					payload: bh.undoPart,
					ok: function(data) { return !!(data && data.brokenHolesResult && data.brokenHolesResult.result); },
					label: bh.label,
					merge: bh.mergeParts
				});
			}
			// Map key: the broken connection style
			if (typeof forkLegend !== "undefined" && typeof forkLegend.register === "function") {
				forkLegend.register({
					id: "brokenHole", group: "connections", order: 40, title: "Broken (missing from a paste)",
					text: "A hole that was missing from your last probe scan. Routes leave it out; Restore brings it back.",
					// always on: mask-mates' broken holes draw whatever this user's Preview pastes setting is
					enabled: function() { return true; },
					where: "Always shown. Holes are marked broken from the paste preview (Settings > Signatures > Preview pastes).",
					sample: function() {
						return forkLegend.line(bh.LINE_CLASS, "broken")
							+ forkLegend.node({ cls: bh.FAR_CLASS, wrap: "", type: "O477", before: "", statics: "" });
					}
				});
			}
		});
	})();
}
