const brokenHoles = {
	// Fork-owned: broken wormholes (part of the paste preview, paste-preview.js). A hole that was missing from a probe
	// scanner paste can be marked broken instead of deleted: it stays on the chain map, drawn red and dashed with the far
	// system dimmed and a Restore link; its row in the signature list shows "Broken" struck through with a Restore link;
	// and every route through the chain leaves it out (Favourites, Destinations, Get home, the route filters, Thera,
	// the jump planner, the chain's exits). The state is saved per hole and mask (broken_wormholes.inc.php, through
	// refresh.php) so everyone on the mask sees it; it lasts until the hole itself expires or is deleted. Marks and
	// restores are undoable (undo-history.js extra "brokenHoles") and in the audit log; they never post to Discord.
	//
	// Routes: the fork's route features all read chain.nodes() output (rows with pathHome, lines, systemsInChainMap,
	// exits). chain.nodes is wrapped here first (this file sorts before every other wrapper, which wrap at DOM ready),
	// so the rows behind a broken hole are taken out before any of them sees the result (split), and put back only for
	// drawing (each renderer's draw is wrapped: restore). Features that decorate systems (badges, kill marks) therefore
	// don't decorate the systems behind a broken hole either: they are cut off until the hole is restored.
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

	/**
	 * Take the parts of chain.nodes() output behind broken holes out, in place: the broken hole's line and its far
	 * system's row, and every row further out (their lines too), so routes never use them. systemsInChainMap and exits
	 * are rebuilt without them. The removed rows are decorated for drawing (the line gets LINE_CLASS, the far node
	 * FAR_CLASS and a Restore link, nodes further out BEYOND_CLASS).
	 * result: {map: {rows: [{c: [{v, f, systemID}, {v}], pathHome}]}, lines: [[childV, parentV, modifiers, wormholeID]],
	 *   systemsInChainMap, exits}; isBroken(wormholeID); tagHtml(wormholeID) -> markup added to the far node (optional).
	 * Returns {rows: [{row, after}], lines: [line], wormholes: [ids]} (after: the node id of the row just before it,
	 * kept or not; null for the first), or null when nothing is broken on this map.
	 */
	split: function(result, isBroken, tagHtml) {
		if (!result || !result.map || !Array.isArray(result.map.rows) || !Array.isArray(result.lines)) { return null; }
		const far = {}, wormholes = [];
		result.lines.forEach(function(line) {
			if (line && line[3] !== undefined && isBroken(line[3])) {
				far[line[0]] = line[3];
				if (wormholes.indexOf(line[3]) < 0) { wormholes.push(line[3]); }
			}
		});
		if (!wormholes.length) { return null; }
		const out = {};
		Object.keys(far).forEach(function(v) { out[v] = true; });
		let grew = true;
		while (grew) {
			grew = false;
			result.map.rows.forEach(function(row) {
				const v = row && row.c && row.c[0] ? row.c[0].v : undefined;
				const parent = row && row.c && row.c[1] ? row.c[1].v : null;
				if (v !== undefined && !out[v] && parent !== null && parent !== undefined && out[parent]) { out[v] = true; grew = true; }
			});
		}
		const removed = [], kept = [];
		let previous = null;
		result.map.rows.forEach(function(row) {
			const v = row && row.c && row.c[0] ? row.c[0].v : undefined;
			if (v !== undefined && out[v]) {
				const node = row.c[0];
				if (typeof node.f === "string") {
					const cls = far[v] !== undefined ? brokenHoles.FAR_CLASS : brokenHoles.BEYOND_CLASS;
					node.f = node.f.replace("class='node ", "class='node " + cls + " ");
					if (far[v] !== undefined && typeof tagHtml === "function") {
						// on the node's hole line ("K162"), so the node keeps its size
						const tag = tagHtml(far[v]) || "";
						const start = node.f.indexOf("<h4 class='nodeType'>");
						const end = start >= 0 ? node.f.indexOf("</h4>", start) : -1;
						if (tag && end >= 0) { node.f = node.f.substring(0, end) + tag + node.f.substring(end); }
					}
				}
				removed.push({ row: row, after: previous });
			} else {
				kept.push(row);
			}
			previous = v === undefined ? previous : v;
		});
		const lines = [], keptLines = [];
		result.lines.forEach(function(line) {
			if (line && out[line[0]]) {
				if (far[line[0]] !== undefined && Array.isArray(line[2]) && line[2].indexOf(brokenHoles.LINE_CLASS) < 0) { line[2].push(brokenHoles.LINE_CLASS); }
				lines.push(line);
			} else {
				keptLines.push(line);
			}
		});
		result.map.rows = kept;
		result.lines = keptLines;
		// The systems reachable without a broken hole
		if (result.systemsInChainMap && typeof result.systemsInChainMap === "object") {
			const gone = removed.map(function(r) { return r.row; });
			Object.keys(result.systemsInChainMap).forEach(function(id) {
				if (gone.indexOf(result.systemsInChainMap[id]) >= 0) { delete result.systemsInChainMap[id]; }
			});
			kept.forEach(function(row) {
				const node = row && row.c && row.c[0];
				const pathHome = Array.isArray(row.pathHome) ? row.pathHome : [];
				const last = pathHome[pathHome.length - 1];
				if (!node || node.systemID === undefined || (last && last.path) || !pathHome.length) { return; }	// root or calculated route node
				if (!result.systemsInChainMap[node.systemID]) { result.systemsInChainMap[node.systemID] = row; }
			});
			result.exits = Object.keys(result.systemsInChainMap).filter(function(x) { return x < 31000000; });
		}
		return { rows: removed, lines: lines, wormholes: wormholes };
	},

	/** The rows and lines to draw: kept ones plus what split() took out, each removed row back right after the row
	that was before it (new arrays; the inputs are not changed) */
	restore: function(rows, lines, split) {
		const outRows = (rows || []).slice();
		if (!split) { return { rows: outRows, lines: (lines || []).slice() }; }
		split.rows.forEach(function(r) {
			let at = 0;
			if (r.after !== null && r.after !== undefined) {
				at = -1;
				for (let i = 0; i < outRows.length; i++) {
					if (outRows[i] && outRows[i].c && outRows[i].c[0] && outRows[i].c[0].v === r.after) { at = i + 1; break; }
				}
				if (at < 0) { at = outRows.length; }
			}
			outRows.splice(at, 0, r.row);
		});
		return { rows: outRows, lines: split.lines.concat(lines || []) };
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

		// ---- Routes: the innermost chain.nodes wrapper (loaded before the others, which wrap at DOM ready) ----
		const nodes = chain.nodes;
		const wrapped = function() {
			const result = nodes.apply(this, arguments);
			try {
				if (result) { result.brokenSplit = Object.keys(bh.ids).length ? bh.split(result, bh.isBroken, function(id) { return bh.tag(id, sigName(id)); }) : null; }
			} catch (e) { console.warn("broken-holes: chain", e); }
			return result;
		};
		Object.keys(nodes).forEach(function(k) { wrapped[k] = nodes[k]; });
		wrapped.brokenHolesWrapped = true;
		chain.nodes = wrapped;

		// ---- Drawing: every renderer draws the broken parts back ----
		function hookRenderer(r) {
			if (!r || typeof r.draw !== "function" || r.draw.brokenHolesWrapped) { return; }
			const draw = r.draw;
			r.draw = function(map, lines) {
				const s = chain.data ? chain.data.brokenSplit : null;
				if (s && map && map === chain.data.map) {
					const back = bh.restore(map.rows, lines, s);
					const args = Array.prototype.slice.call(arguments);
					args[0] = Object.assign({}, map, { rows: back.rows });
					args[1] = back.lines;
					return draw.apply(this, args);
				}
				return draw.apply(this, arguments);
			};
			r.draw.brokenHolesWrapped = true;
		}
		hookRenderer(chain.renderer);
		const useRenderer = chain.useRenderer;
		if (typeof useRenderer === "function") {
			chain.useRenderer = function(name) {
				// hook the new renderer before useRenderer draws with it
				const before = chain.renderer;
				const ret = useRenderer.apply(this, arguments);
				if (chain.renderer !== before) { hookRenderer(chain.renderer); if (chain.data && chain.data.rawMap) { chain.redraw(); } }
				return ret;
			};
		}

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
					settingId: "pastePreview-enabled",
					sample: function() {
						return forkLegend.line(bh.LINE_CLASS, "broken")
							+ forkLegend.node({ cls: bh.FAR_CLASS, wrap: "", type: "O477", before: "", statics: "" });
					}
				});
			}
		});
	})();
}
