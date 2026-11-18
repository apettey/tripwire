const pastePreview = {
	// Fork-owned: "Paste preview". A probe scanner paste (Ctrl+V, tripwire/paste.js) is classified against the viewed
	// system's signatures first: New, Updated (type or site name now known, or a broken hole that is back), Unchanged,
	// and Gone (in Tripwire but missing from the paste). Only when something would be Gone (or with "Always preview")
	// a preview dialog lists the groups: untick a row to leave that sig alone, choose Delete or Mark broken for a gone
	// wormhole (Delete by default; Mark broken: broken-holes.js), "keep all" for the Gone group. Apply (Enter) saves it
	// all in one request and as one Undo step; Esc cancels and saves nothing. The dialog counts down autoSeconds() (a
	// drop-down in its title bar: Never, 3, 5 or 10 s, saved in options.pastePreview.autoSeconds, missing = 10): with
	// no input from the user by then (a click, key, scroll or touch anywhere stops the countdown) the paste is saved without
	// the Gone group (keepGone: new and updated sigs only, nothing deleted or marked broken). Without anything Gone the
	// paste saves straight away, as before, and a notice sums it up ("3 added, 1 updated") with an Undo link.
	//
	// How: tripwire.pasteSignatures.parsePaste is wrapped (paste.js itself is unchanged). The wrapper lets upstream's
	// parser build its add / update payload but catches its tripwire.refresh call (nothing is sent), adds the Gone
	// group's deletes and broken marks, and sends the result itself. Upstream's "Paste detected (Click to delete
	// missing sigs)" notice is not shown while the preview is on (Gone replaces it). Gates, sigs without an ID (???)
	// and anomalies kept by "Anomalies: Don't import" are never Gone, as with upstream's delete. Return hole on paste
	// (return-sig-paste.js) still runs, at Apply: its row is tagged in the preview, and its Edit Signature dialog opens
	// after Apply. Settings > Signatures: "Preview pastes" (options.pastePreview.enabled, missing = on; off = upstream's
	// behaviour exactly) and "Always preview" (options.pastePreview.always, missing = off).
	//
	// The pure part (parsing, classifying, the Apply plan, the summary) is mocha-tested; the DOM part is below.
	// Keep `const pastePreview` on the first line: the test helper strips it to define a global.

	DIALOG_ID: "paste-preview-dialog",

	/** Seconds the preview waits for input before it saves the paste without the Gone group (the default) */
	AUTO_SECONDS: 10,

	/** The auto-save choices: [seconds, label]; 0 = never (the preview waits) */
	AUTO_CHOICES: [[0, "Never"], [3, "3 s"], [5, "5 s"], [10, "10 s"]],

	/** Auto-save after: options.pastePreview.autoSeconds when it is one of AUTO_CHOICES, else AUTO_SECONDS (0 = never) */
	autoSeconds: function(opts) {
		const raw = opts && opts.pastePreview ? opts.pastePreview.autoSeconds : undefined;
		const v = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
		return pastePreview.AUTO_CHOICES.some(function(c) { return c[0] === v; }) ? v : pastePreview.AUTO_SECONDS;
	},

	/** Preview pastes: on unless options.pastePreview.enabled is false */
	enabled: function(opts) {
		return !(opts && opts.pastePreview && opts.pastePreview.enabled === false);
	},

	/** Always preview: only when options.pastePreview.always is true (and previews are on) */
	always: function(opts) {
		return pastePreview.enabled(opts) && !!(opts && opts.pastePreview && opts.pastePreview.always === true);
	},

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** "abc123" / "ABC-123" -> "ABC123" ("" for nothing) */
	key: function(id) {
		return String(id === undefined || id === null ? "" : id).replace(/-/g, "").toUpperCase();
	},

	/** "ABC123" -> "ABC-123" */
	idText: function(id) {
		const s = pastePreview.key(id);
		return s.length === 6 ? s.substring(0, 3) + "-" + s.substring(3) : s;
	},

	/** The paste's rows with a signature ID, each ID once: [{id: "ABC123", pct: "23.5%" | "", dist: "15.3 AU" | ""}].
	The probe scanner's columns as paste.js reads them: the ID is "ABC-123"; scan % and distance only shown. */
	parseRows: function(text) {
		const out = [], seen = {};
		String(text === undefined || text === null ? "" : text).split(/\r?\n/).forEach(function(line) {
			let id = null, pct = "", dist = "";
			line.split("\t").forEach(function(c) {
				c = c.trim();
				if (id === null && /^[A-Z]{3}-\d{3}$/.test(c)) { id = c.replace("-", ""); return; }
				if (!pct && /^\d+([.,]\d+)?\s?%$/.test(c)) { pct = c; return; }
				if (!dist && /\d/.test(c) && /\s?(UA|AU|AE|km|m|а\.е\.|км|м)$/i.test(c) && /^[\d\s.,  ]+\s?\S+$/.test(c)) { dist = c; }
			});
			if (id && !seen[id]) { seen[id] = true; out.push({ id: id, pct: pct, dist: dist }); }
		});
		return out;
	},

	/** The client's wormhole of a signature id, or null */
	holeOf: function(sigId, wormholes) {
		const keys = Object.keys(wormholes || {});
		for (let i = 0; i < keys.length; i++) {
			const w = wormholes[keys[i]];
			if (w && (String(w.initialID) === String(sigId) || String(w.secondaryID) === String(sigId))) { return w; }
		}
		return null;
	},

	/** The other side of a hole from the signature with this id */
	otherSide: function(hole, sigId, signatures) {
		if (!hole) { return null; }
		const other = String(hole.initialID) === String(sigId) ? hole.secondaryID : hole.initialID;
		return (signatures || {})[other] || null;
	},

	/** The hole's type as seen from this side: the real type on its parent side, K162 on the other ("????" unknown) */
	typeFrom: function(hole, sigId) {
		if (!hole) { return ""; }
		const parentSide = hole.parent === "secondary" ? hole.secondaryID : hole.initialID;
		if (String(parentSide) === String(sigId)) { return hole.type || "????"; }
		return hole.type && hole.type !== "????" ? "K162" : "????";
	},

	/**
	 * Sort a paste into groups. input:
	 *   rows        parseRows() of the paste
	 *   payload     what upstream's parser would send: {signatures: {add: [], update: []}} (null: nothing)
	 *   systemID    the viewed system
	 *   signatures, wormholes   tripwire.client's
	 *   broken      {wormholeID: true} of the broken holes (broken-holes.js)
	 *   keep(sig)   true for a sig upstream's "delete missing sigs" never deletes (anomalies kept by Don't import)
	 *   returnHole  {id: "VWX234", to: <systemID>} when Return hole on paste will link a new hole of this paste, or null
	 * Returns {neu, upd, same, gone}; each row has `on` (ticked) and gone rows `act` ("broken" | "delete"):
	 *   neu  {id, add (index in payload add), hole, type, name, pct, dist, ret (returnHole.to or null)}
	 *   upd  {id, update (index in payload update) | restore (wormholeID), sigId, hole, oldType, oldName, type, name, pct, dist}
	 *   same {id, sigId, hole, type, name, pct, dist}
	 *   gone {id, sigId, hole, wormholeID, type, name, farSystemID, act}
	 */
	classify: function(input) {
		const sigs = input.signatures || {};
		const wormholes = input.wormholes || {};
		const broken = input.broken || {};
		const keep = typeof input.keep === "function" ? input.keep : function() { return false; };
		const add = (input.payload && input.payload.signatures && input.payload.signatures.add) || [];
		const update = (input.payload && input.payload.signatures && input.payload.signatures.update) || [];
		const out = { neu: [], upd: [], same: [], gone: [] };
		const byId = {};	// pasted ID -> row
		(input.rows || []).forEach(function(r) { byId[r.id] = r; });

		// The system's signatures by pasted ID
		const here = {};
		Object.keys(sigs).forEach(function(k) {
			const s = sigs[k];
			if (s && s.systemID == input.systemID && s.signatureID) { here[pastePreview.key(s.signatureID)] = s; }	// eslint-disable-line eqeqeq
		});

		const used = {};
		add.forEach(function(a, i) {
			const hole = !!(a && a.wormhole);
			const s = hole ? (a.signatures && a.signatures[0]) || {} : a || {};
			const id = pastePreview.key(s.signatureID);
			const r = byId[id] || {};
			used[id] = true;
			const ret = hole && input.returnHole && pastePreview.key(input.returnHole.id) === id ? input.returnHole.to : null;
			out.neu.push({ id: id, add: i, hole: hole, type: hole ? "Wormhole" : String(s.type || "unknown"), name: hole ? "" : String(s.name || ""),
				pct: r.pct || "", dist: r.dist || "", ret: ret, on: true });
		});
		update.forEach(function(u, i) {
			const hole = !!(u && u.wormhole);
			const s = hole ? (u.signatures && u.signatures[0]) || {} : u || {};
			const cur = sigs[s.id] || {};
			const id = pastePreview.key(cur.signatureID || s.signatureID);
			const r = byId[id] || {};
			used[id] = true;
			out.upd.push({ id: id, update: i, sigId: s.id, hole: hole, oldType: String(cur.type || ""), oldName: String(cur.name || ""),
				type: hole ? "Wormhole" : String(s.type || "unknown"), name: hole ? String(cur.name || "") : String(s.name || ""), pct: r.pct || "", dist: r.dist || "", on: true });
		});
		(input.rows || []).forEach(function(r) {
			if (used[r.id]) { return; }
			const s = here[r.id];
			if (!s) { return; }	// e.g. an anomaly "Anomalies: Don't import" skips
			const w = s.type === "wormhole" ? pastePreview.holeOf(s.id, wormholes) : null;
			if (w && broken[w.id]) {
				// A broken hole is in the scan again: it is back (restore it)
				out.upd.push({ id: r.id, restore: w.id, sigId: s.id, hole: true, oldType: "Broken", oldName: "", type: pastePreview.typeFrom(w, s.id),
					name: String(s.name || ""), pct: r.pct, dist: r.dist, on: true });
				return;
			}
			out.same.push({ id: r.id, sigId: s.id, hole: s.type === "wormhole", type: s.type === "wormhole" ? pastePreview.typeFrom(w, s.id) : String(s.type || ""),
				name: String(s.name || ""), pct: r.pct, dist: r.dist, farSystemID: w ? (pastePreview.otherSide(w, s.id, sigs) || {}).systemID : null });
		});

		// Gone: the same rule as upstream's "Click to delete missing sigs"
		Object.keys(here).forEach(function(id) {
			const s = here[id];
			if (byId[id] || s.signatureID === "???" || keep(s)) { return; }
			if (s.type === "wormhole") {
				const w = pastePreview.holeOf(s.id, wormholes);
				if (w && (w.type === "GATE" || broken[w.id])) { return; }	// gates never; broken holes are already handled
				const far = w ? pastePreview.otherSide(w, s.id, sigs) : null;
				out.gone.push({ id: id, sigId: s.id, hole: !!w, wormholeID: w ? w.id : null, type: w ? pastePreview.typeFrom(w, s.id) : "Wormhole",
					name: String(s.name || ""), farSystemID: far ? far.systemID : null, act: "delete", on: true });
				return;
			}
			out.gone.push({ id: id, sigId: s.id, hole: false, wormholeID: null, type: String(s.type || "unknown"), name: String(s.name || ""),
				farSystemID: null, act: "delete", on: true });
		});
		const byKey = function(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; };
		out.neu.sort(byKey); out.upd.sort(byKey); out.same.sort(byKey); out.gone.sort(byKey);
		return out;
	},

	/** The groups with every Gone row unticked (what the countdown saves: nothing deleted or marked broken) */
	keepGone: function(groups) {
		const out = Object.assign({}, groups);
		out.gone = (groups.gone || []).map(function(r) { return Object.assign({}, r, { on: false }); });
		return out;
	},

	/** Whether the paste needs the preview: something is Gone, or Always preview is on */
	needsPreview: function(groups, opts) {
		return !!(groups && groups.gone.length) || pastePreview.always(opts);
	},

	copy: function(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },

	/** The undo copy of a signature as it is now: the hole with both sides, or the signature (as paste.js saves it) */
	snapshot: function(sigId, signatures, wormholes) {
		const s = (signatures || {})[sigId];
		if (!s) { return null; }
		const w = s.type === "wormhole" ? pastePreview.holeOf(sigId, wormholes) : null;
		if (w) {
			const a = signatures[w.initialID], b = signatures[w.secondaryID];
			if (a && b) { return { wormhole: pastePreview.copy(w), signatures: [pastePreview.copy(a), pastePreview.copy(b)] }; }
		}
		return pastePreview.copy(s);
	},

	/**
	 * What Apply sends, from the groups (with the user's ticks and choices) and upstream's payload:
	 * {payload: {signatures: {add, update, remove}, brokenHoles: {mark, restore}} (empty parts left out),
	 *  undo: {update: [...], remove: [...]} (the copies to put back, pushed after the answer like paste.js does),
	 *  counts: {added, updated, restored, marked, deleted}}
	 */
	plan: function(groups, payload, signatures, wormholes) {
		const add = (payload && payload.signatures && payload.signatures.add) || [];
		const update = (payload && payload.signatures && payload.signatures.update) || [];
		const out = { add: [], update: [], remove: [], mark: [], restore: [] };
		const undo = { update: [], remove: [] };
		const counts = { added: 0, updated: 0, restored: 0, marked: 0, deleted: 0 };
		(groups.neu || []).forEach(function(r) {
			if (!r.on || !add[r.add]) { return; }
			out.add.push(pastePreview.copy(add[r.add]));
			counts.added++;
		});
		(groups.upd || []).forEach(function(r) {
			if (!r.on) { return; }
			if (r.restore !== undefined && r.restore !== null) {
				out.restore.push(r.restore);
				counts.restored++;
				return;
			}
			const u = update[r.update];
			if (!u) { return; }
			out.update.push(pastePreview.copy(u));
			const snap = pastePreview.snapshot(r.sigId, signatures, wormholes);
			if (snap) { undo.update.push(snap); }
			counts.updated++;
		});
		(groups.gone || []).forEach(function(r) {
			if (!r.on) { return; }
			if (r.hole && r.act === "broken" && r.wormholeID !== null && r.wormholeID !== undefined) {
				out.mark.push(r.wormholeID);
				counts.marked++;
				return;
			}
			const snap = pastePreview.snapshot(r.sigId, signatures, wormholes);
			if (r.hole && r.wormholeID !== null && r.wormholeID !== undefined) { out.remove.push({ id: r.wormholeID }); }
			else { out.remove.push(r.sigId); }
			if (snap) { undo.remove.push(snap); }
			counts.deleted++;
		});
		const sigPart = {};
		["add", "update", "remove"].forEach(function(k) { if (out[k].length) { sigPart[k] = out[k]; } });
		const result = {};
		if (Object.keys(sigPart).length) { result.signatures = sigPart; }
		if (out.mark.length || out.restore.length) {
			result.brokenHoles = {};
			if (out.mark.length) { result.brokenHoles.mark = out.mark; }
			if (out.restore.length) { result.brokenHoles.restore = out.restore; }
		}
		return { payload: result, undo: undo, counts: counts };
	},

	/** Whether a plan sends anything */
	isEmpty: function(plan) {
		return !plan || (!plan.payload.signatures && !plan.payload.brokenHoles);
	},

	/** "2 added, 1 updated, 1 hole marked broken, 1 deleted" ("" for nothing) */
	summary: function(counts) {
		const c = counts || {};
		const parts = [];
		if (c.added) { parts.push(c.added + " added"); }
		if (c.updated) { parts.push(c.updated + " updated"); }
		if (c.restored) { parts.push(c.restored + " hole" + (c.restored === 1 ? "" : "s") + " restored"); }
		if (c.marked) { parts.push(c.marked + " hole" + (c.marked === 1 ? "" : "s") + " marked broken"); }
		if (c.deleted) { parts.push(c.deleted + " deleted"); }
		return parts.join(", ");
	},

	/** The plan's counts with the broken marks and restores the server says it made (data.brokenHolesResult: a hole
	someone else marked or restored first, or that is gone, isn't counted) */
	savedCounts: function(counts, data) {
		const r = data && data.brokenHolesResult;
		const n = function(list) { return Array.isArray(list) ? list.length : 0; };
		return Object.assign({}, counts || {}, { marked: r && r.result ? n(r.marked) : 0, restored: r && r.result ? n(r.restored) : 0 });
	},

	/** The counts of the ticked rows (for the dialog's summary line) */
	countChoices: function(groups) {
		const c = { neu: 0, upd: 0, same: (groups.same || []).length, gone: (groups.gone || []).length, marked: 0, deleted: 0, kept: 0 };
		(groups.neu || []).forEach(function(r) { if (r.on) { c.neu++; } });
		(groups.upd || []).forEach(function(r) { if (r.on) { c.upd++; } });
		(groups.gone || []).forEach(function(r) {
			if (!r.on) { c.kept++; } else if (r.hole && r.act === "broken" && r.wormholeID !== null && r.wormholeID !== undefined) { c.marked++; } else { c.deleted++; }
		});
		return c;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined" || !tripwire.pasteSignatures || typeof tripwire.pasteSignatures.parsePaste !== "function") { return; }
		const pp = pastePreview;
		let state = null;	// the open preview: {groups, payload, next, systemID, paste}

		function opts() { return typeof options !== "undefined" ? options : undefined; }
		function systemName(id) {
			if (id === null || id === undefined || id === "") { return ""; }
			try {
				if (typeof holeNaming !== "undefined" && holeNaming.systemName) { const n = holeNaming.systemName(id); if (n) { return String(n); } }
			} catch (e) { /* below */ }
			const sys = typeof appData !== "undefined" && appData.systems ? appData.systems[id] : null;
			if (sys && sys.name) { return String(sys.name); }
			const generic = typeof appData !== "undefined" && appData.genericSystemTypes ? appData.genericSystemTypes[id] : null;
			return generic ? String(generic) : "";
		}
		function systemClass(id) {
			try {
				const a = systemAnalysis.analyse(id);
				return a ? { name: a.systemTypeName || "", cls: a.systemTypeClass || "" } : { name: "", cls: "" };
			} catch (e) { return { name: "", cls: "" }; }
		}
		function brokenSet() {
			return typeof brokenHoles !== "undefined" && brokenHoles.ids ? brokenHoles.ids : {};
		}

		// ---- Upstream's "Paste detected (Click to delete missing sigs)" notice: not while the preview is on ----
		if (typeof Notify !== "undefined" && typeof Notify.trigger === "function") {
			const trigger = Notify.trigger;
			Notify.trigger = function(content) {
				if (typeof content === "string" && content.indexOf("id='fullPaste'") >= 0 && pp.enabled(opts())) { return; }
				return trigger.apply(this, arguments);
			};
		}

		// ---- The dialog ----
		function rowHtml(kind, i, r, type, what, act) {
			const esc = pp.escape;
			return "<div class='pp-row" + (r.on ? "" : " pp-off") + "' data-kind='" + kind + "' data-i='" + i + "'>"
				+ "<input type='checkbox'" + (r.on ? " checked" : "") + " aria-label='Include " + esc(pp.idText(r.id)) + "'>"
				+ "<span class='pp-id'>" + esc(pp.idText(r.id)) + "</span><span class='pp-type'>" + esc(type) + "</span>"
				+ "<span class='pp-what'>" + what + "</span><span class='pp-act'>" + act + "</span></div>";
		}
		function holeLead(farSystemID, name) {
			const esc = pp.escape;
			if (!farSystemID) { return name ? "<span class='pp-lead'>" + esc(name) + "</span>" : "<span class='pp-dim'>leads to ?</span>"; }
			const c = systemClass(farSystemID);
			return "<span class='pp-lead'>" + esc((name ? name + " - " : "") + systemName(farSystemID)) + "</span>"
				+ (c.name ? " (<span class='" + esc(c.cls) + "'>" + esc(c.name) + "</span>)" : "");
		}
		function scanText(r) {
			return "<span class='pp-dim'>" + pp.escape([r.pct, r.dist].filter(Boolean).join(" · ")) + "</span>";
		}
		function typeWord(t) { return String(t || "").replace(/^\w/, function(c) { return c.toUpperCase(); }); }

		function render() {
			if (!state) { return; }
			const g = state.groups, esc = pp.escape;
			const c = pp.countChoices(g);
			let h = "<div class='pp-summary'><b class='pp-n'>" + c.neu + " new</b> · <b class='pp-u'>" + c.upd + " updated</b> · "
				+ c.same + " unchanged · <b class='pp-g'>" + c.gone + " gone</b>"
				+ (c.gone ? " <span class='pp-dim'>(" + c.marked + " hole" + (c.marked === 1 ? "" : "s") + " marked broken, " + c.deleted + " deleted"
					+ (c.kept ? ", " + c.kept + " kept" : "") + ")</span>" : "") + "</div>";
			if (g.neu.length) {
				h += "<div class='pp-group'><div class='pp-head pp-n'><span>New</span><span>added</span></div>";
				g.neu.forEach(function(r, i) {
					let what = r.hole ? "<span class='pp-pill pp-wh'>Wormhole</span> <span class='pp-dim'>leads to ?</span>" : esc(typeWord(r.type)) + (r.name ? " · " + esc(r.name) : "");
					if (r.ret) {
						what += "<br><span class='pp-pill pp-ret' title='Return hole on paste: within 100 km right after your jump'>return hole: links to "
							+ esc(systemName(r.ret) || "the system you came from") + "</span>";
					}
					h += rowHtml("neu", i, r, r.hole ? "Wormhole" : typeWord(r.type), what, scanText(r));
				});
				h += "</div>";
			}
			if (g.upd.length) {
				h += "<div class='pp-group'><div class='pp-head pp-u'><span>Updated</span><span>type / site now known</span></div>";
				g.upd.forEach(function(r, i) {
					let what;
					if (r.restore !== undefined) {
						what = "<span class='pp-old'>Broken</span> <span class='pp-arrow'>&rarr;</span> back in the scan: restore";
					} else {
						what = "<span class='pp-old'>" + esc(typeWord(r.oldType)) + (r.oldName ? " · " + esc(r.oldName) : "") + "</span> <span class='pp-arrow'>&rarr;</span> "
							+ esc(typeWord(r.type)) + (r.name && !r.hole ? " · " + esc(r.name) : "");
					}
					h += rowHtml("upd", i, r, r.hole ? "Wormhole" : typeWord(r.type), what, scanText(r));
				});
				h += "</div>";
			}
			if (g.gone.length) {
				h += "<div class='pp-group'><div class='pp-head pp-g'><span>Gone: in Tripwire, not in this paste</span><a href='#' class='pp-keep-all'>keep all</a></div>";
				g.gone.forEach(function(r, i) {
					const what = r.hole ? holeLead(r.farSystemID, r.name) + " <span class='pp-dim'>via " + esc(r.type) + "</span>" : esc(r.name);
					const act = r.hole
						? "<select aria-label='What to do with " + esc(pp.idText(r.id)) + "'><option value='delete'" + (r.act === "delete" ? " selected" : "") + ">Delete</option>"
							+ "<option value='broken'" + (r.act === "broken" ? " selected" : "") + ">Mark broken</option></select>"
						: "<span class='pp-del'>Delete</span>";
					h += rowHtml("gone", i, r, r.hole || r.type === "wormhole" ? "Wormhole" : typeWord(r.type), what, act);
				});
				h += "</div>";
			}
			if (g.same.length) {
				h += "<div class='pp-group'><div class='pp-head pp-s' tabindex='0' role='button' aria-expanded='" + (state.sameOpen ? "true" : "false") + "'>"
					+ "<span>" + (state.sameOpen ? "&#9662;" : "&#9656;") + " Unchanged (" + g.same.length + ")</span><span>nothing to save</span></div>";
				if (state.sameOpen) {
					g.same.forEach(function(r) {
						const what = r.hole ? holeLead(r.farSystemID, r.name) : esc(r.name);
						h += "<div class='pp-row pp-same'><span></span><span class='pp-id'>" + esc(pp.idText(r.id)) + "</span><span class='pp-type'>"
							+ esc(r.hole ? "Wormhole" : typeWord(r.type)) + "</span><span class='pp-what'>" + what + "</span><span class='pp-act'>" + scanText(r) + "</span></div>";
					});
				}
				h += "</div>";
			}
			if (!g.neu.length && !g.upd.length && !g.gone.length) { h += "<div class='pp-empty'>Nothing to save: every signature is already in Tripwire as it is.</div>"; }
			$("#" + pp.DIALOG_ID + " .pp-body").html(h);
		}

		function dialog() {
			let $d = $("#" + pp.DIALOG_ID);
			if ($d.length) { return $d; }
			$d = $("<div id='" + pp.DIALOG_ID + "' class='pp-dialog'><div class='pp-auto' role='status'><span class='pp-auto-text'></span>"
				+ "<span class='pp-auto-bar'><span></span></span></div><div class='pp-body'></div>"
				+ "<div class='pp-keys'><kbd>Enter</kbd> apply · <kbd>Esc</kbd> cancel · untick a row to leave it alone</div></div>").appendTo("body");
			$d.dialog({
				autoOpen: false, modal: true, width: 600, resizable: false, dialogClass: "pp-ui-dialog",
				buttons: [
					{ text: "Apply", class: "pp-apply", click: function() { apply(); } },
					{ text: "Cancel", click: function() { $(this).dialog("close"); } }
				],
				close: function() { stopCountdown(true); if (state && !state.applying) { state = null; } }
			});
			$d.on("change", "input[type=checkbox]", function() {
				const $row = $(this).closest(".pp-row");
				const r = state && state.groups[$row.data("kind")] ? state.groups[$row.data("kind")][$row.data("i")] : null;
				if (r) { r.on = this.checked; render(); focusRow($row.data("kind"), $row.data("i"), "input"); }
			});
			$d.on("change", "select", function() {
				const $row = $(this).closest(".pp-row");
				const r = state && state.groups.gone ? state.groups.gone[$row.data("i")] : null;
				if (r) { r.act = this.value; r.on = true; render(); focusRow("gone", $row.data("i"), "select"); }
			});
			$d.on("click", ".pp-keep-all", function(e) {
				e.preventDefault();
				if (state) { state.groups.gone.forEach(function(r) { r.on = false; }); render(); }
			});
			$d.on("click keydown", ".pp-s", function(e) {
				if (e.type === "keydown" && e.key !== " " && e.key !== "Enter") { return; }
				e.preventDefault();
				e.stopPropagation();
				if (state) { state.sameOpen = !state.sameOpen; render(); $d.find(".pp-s").trigger("focus"); }
			});
			$d.on("keydown", function(e) {
				if (e.key !== "Enter" || e.isDefaultPrevented()) { return; }
				const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
				if (tag === "select" || tag === "a" || (tag === "button" && !$(e.target).hasClass("pp-apply"))) { return; }
				e.preventDefault();
				apply();
			});
			return $d;
		}
		function focusRow(kind, i, what) {
			const el = $("#" + pp.DIALOG_ID + " .pp-row[data-kind='" + kind + "'][data-i='" + i + "'] " + what)[0];
			if (el) { el.focus(); }
		}

		// ---- The countdown: no input for autoSeconds() saves the paste without the Gone group (0: no countdown) ----
		function countdownText(left) {
			const c = pp.countChoices(state.groups);
			const what = c.neu || c.upd ? "Saving " + [c.neu ? c.neu + " new" : "", c.upd ? c.upd + " updated" : ""].filter(Boolean).join(" and ") : "Closing without changes";
			return what + (c.gone ? ", gone signatures left alone," : "") + " in <b>" + left + " s</b>. Click or press a key to choose yourself.";
		}
		function startCountdown() {
			stopCountdown();
			const $a = $("#" + pp.DIALOG_ID + " .pp-auto");
			const secs = pp.autoSeconds(opts());
			if (!secs) { $a.hide(); return; }
			const total = secs * 1000, end = Date.now() + total;
			let shown = null;
			$a.show().removeClass("pp-auto-stopped").find(".pp-auto-bar > span").css("width", "100%");
			const tick = function() {
				if (!state) { stopCountdown(true); return; }
				const ms = Math.max(0, end - Date.now());
				const left = Math.ceil(ms / 1000);
				if (left !== shown) { shown = left; $a.find(".pp-auto-text").html(countdownText(left)); }	// the live region: once a second
				$a.find(".pp-auto-bar > span").css("width", (100 * ms / total) + "%");
				if (ms <= 0) {
					stopCountdown(true);
					state.groups = pp.keepGone(state.groups);
					state.auto = true;
					apply();
				}
			};
			state.timer = setInterval(tick, 200);
			tick();
			// Any input means the user is choosing (in the dialog or not): the countdown stops. Bound after this event, so
			// the paste that opened the preview doesn't count.
			setTimeout(function() {
				if (state && state.timer) { $(document).on("mousedown.ppAuto keydown.ppAuto wheel.ppAuto touchstart.ppAuto", function() { stopCountdown(false); }); }
			}, 0);
		}
		/** Stop the countdown. On input the line stays (same height, so the button under the mouse doesn't move away);
		on apply / close it is hidden. */
		function stopCountdown(hide) {
			$(document).off(".ppAuto");
			const wasRunning = !!(state && state.timer);
			if (wasRunning) { clearInterval(state.timer); state.timer = null; }
			const $a = $("#" + pp.DIALOG_ID + " .pp-auto");
			if (hide) { $a.hide(); }
			else if (wasRunning) {
				$a.addClass("pp-auto-stopped").find(".pp-auto-text").text("Countdown stopped: choose, then Apply (Enter) or Cancel (Esc).");
				$a.find(".pp-auto-bar > span").css("width", "0");
			}
		}

		// The auto-save drop-down in the title bar (top right). Choosing stops this paste's countdown (any input does) and
		// is saved for the next paste.
		function autoSelect($d) {
			const $bar = $d.parent().find(".ui-dialog-titlebar");
			let $s = $bar.find(".pp-auto-select");
			if (!$s.length) {
				$s = $("<label class='pp-auto-select' title='Save the paste without removing anything when you make no choice in time'>Auto-save: <select aria-label='Auto-save after'>"
					+ pp.AUTO_CHOICES.map(function(c) { return "<option value='" + c[0] + "'>" + pp.escape(c[1]) + "</option>"; }).join("") + "</select></label>");
				$bar.find(".ui-dialog-titlebar-close").before($s);
				// The title bar is jQuery UI's drag handle and focuses the dialog on mousedown, which keeps the select from
				// opening: keep its mousedown to itself (and stop the countdown here, as the document handler won't see it).
				$s.on("mousedown touchstart", function(e) { e.stopPropagation(); stopCountdown(false); });
				$s.on("change", "select", function() {
					const v = Number(this.value);
					stopCountdown(false);
					if (typeof options === "undefined") { return; }
					options.pastePreview = Object.assign({}, options.pastePreview || {}, { autoSeconds: v });
					try { if (typeof options.save === "function") { options.save(); } } catch (e) { console.warn("paste-preview: save", e); }
					$("#" + pp.DIALOG_ID + " .pp-auto").show().addClass("pp-auto-stopped").find(".pp-auto-text")
						.text("Auto-save " + (v ? "after " + v + " s" : "off") + " from the next paste. Choose, then Apply (Enter) or Cancel (Esc).");
				});
			}
			$s.find("select").val(String(pp.autoSeconds(opts())));
		}

		function open() {
			const $d = dialog();
			$d.dialog("option", "title", "Paste preview: " + (systemName(state.systemID) || "this system"));
			autoSelect($d);
			render();
			$d.dialog("open");
			$d.parent().find(".pp-apply").trigger("focus");
			startCountdown();
			if (typeof forkUsage !== "undefined") { forkUsage.track("pastePreview", "previewed"); }
		}

		// ---- Apply ----
		function pushUndo(systemID, data, plan) {
			if (typeof tripwire.signatures === "undefined" || !tripwire.signatures.undo) { return null; }
			const ok = !!(data && data.resultSet && data.resultSet[0] && data.resultSet[0].result == true);	// eslint-disable-line eqeqeq
			const broke = data && data.brokenHolesResult && data.brokenHolesResult.result ? data.brokenHolesResult : null;
			const entries = [];
			if (ok && Array.isArray(data.results) && data.results.length) { entries.push({ action: "add", signatures: data.results }); }
			if (ok && plan.undo.update.length) { entries.push({ action: "update", signatures: plan.undo.update }); }
			if (ok && plan.undo.remove.length) { entries.push({ action: "remove", signatures: plan.undo.remove }); }
			const extra = {};
			if (broke && broke.marked && broke.marked.length) { extra.mark = broke.marked.slice(); }
			if (broke && broke.restored && broke.restored.length) { extra.restore = broke.restored.slice(); }
			if (extra.mark || extra.restore) { entries.push({ action: "update", signatures: [], meta: { extra: { brokenHoles: extra } } }); }
			if (!entries.length) { return null; }
			const stack = tripwire.signatures.undo[systemID] || (tripwire.signatures.undo[systemID] = []);
			const list = tripwire.signatures.undo[systemID] || stack;
			entries.forEach(function(e) { list.push(e); });	// pushed together: one Undo step (undo-history.js)
			$("#undo").removeClass("disabled");
			try { if (typeof undoHistory === "undefined") { sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo)); } } catch (e) { /* ignore */ }
			return entries[entries.length - 1];
		}

		function undoLink(entry) {
			if (!entry) { return ""; }
			const id = "pp-undo-" + Date.now();
			$(document).off("click.ppUndo").on("click.ppUndo", "#" + id, function(e) {
				e.preventDefault();
				$(this).closest(".jBox-wrapper").find(".jBox-closeButton").trigger("click");
				const top = typeof undoHistory !== "undefined" && undoHistory.ui && undoHistory.ui.top ? undoHistory.ui.top("undo") : null;
				const ours = !top || top.some(function(x) { return x === entry || (x && entry.meta && x.meta && x.meta.group === entry.meta.group && x.meta.at === entry.meta.at); });
				if (!ours) { Notify.trigger("Something else was changed since: use the Undo arrow above the signatures.", "yellow", 6000); return; }
				if (typeof tripwire.undo === "function") { tripwire.undo(); }
			});
			return " <a href='#' class='pp-undo' id='" + id + "'>Undo</a>";
		}

		function apply() {
			if (!state || state.applying) { return; }
			const s = state;
			stopCountdown(true);
			const plan = pp.plan(s.groups, s.payload, tripwire.client.signatures, tripwire.client.wormholes);
			const kept = s.auto ? s.groups.gone.length : 0;
			const keptText = kept ? " (" + kept + " gone left alone: no choice made)" : "";
			s.applying = true;
			const $d = $("#" + pp.DIALOG_ID);
			if ($d.length && $d.dialog("isOpen")) { $d.dialog("close"); }
			state = null;
			if (pp.isEmpty(plan)) {
				const why = [s.groups.same.length ? s.groups.same.length + " unchanged" : "", kept ? kept + " gone left alone: no choice made" : ""].filter(Boolean).join(", ");
				Notify.trigger("Paste: nothing to save" + (why ? " (" + why + ")" : "") + ".", "blue", 4000);
				return;
			}
			const payload = plan.payload;
			payload.systemID = s.systemID;
			const success = function(data) {
				let entry = null;
				try { entry = pushUndo(s.systemID, data, plan); } catch (e) { console.warn("paste-preview: undo", e); }
				const sigFailed = payload.signatures && !(data && data.resultSet && data.resultSet[0] && data.resultSet[0].result == true);	// eslint-disable-line eqeqeq
				const brokeFailed = payload.brokenHoles && !(data && data.brokenHolesResult && data.brokenHolesResult.result);
				if (typeof brokenHoles !== "undefined" && data && data.brokenHoles) { brokenHoles.receive(data.brokenHoles); }
				if (sigFailed || brokeFailed) {
					const why = data && data.resultSet && data.resultSet[0] && data.resultSet[0].value ? data.resultSet[0].value
						: data && data.brokenHolesResult && data.brokenHolesResult.error ? data.brokenHolesResult.error : "the server refused it";
					Notify.trigger("Paste: not everything was saved (" + pp.escape(why) + "). Check the list." + undoLink(entry), "red", 10000);
					return;
				}
				Notify.trigger("Paste saved: " + pp.escape(pp.summary(pp.savedCounts(plan.counts, data)) || "nothing changed") + keptText + "." + undoLink(entry), "blue", 8000);
				if (typeof forkUsage !== "undefined") { if (s.auto) { forkUsage.track("pastePreview", "auto_saved"); } else { forkUsage.track("pastePreview", "applied"); } }
			};
			const send = typeof s.next === "function" ? s.next : tripwire.refresh;
			send.call(tripwire, "refresh", payload, success);
		}

		// ---- The paste ----
		const parsePaste = tripwire.pasteSignatures.parsePaste;
		const wrapped = function(paste) {
			if (!pp.enabled(opts())) { return parsePaste.apply(this, arguments); }
			if (state) {
				Notify.trigger("Finish or cancel the paste preview first.", "yellow", 4000);
				return undefined;
			}
			const rows = pp.parseRows(paste);
			if (!rows.length) { return parsePaste.apply(this, arguments); }
			const systemID = viewingSystemID;
			const next = tripwire.refresh;
			let captured = null;
			tripwire.refresh = function(mode, data, success, always) { captured = { data: data, always: always }; };
			let ret;
			try { ret = parsePaste.apply(this, arguments); } finally { tripwire.refresh = next; }
			// paste.js waits for its request to end before it takes the next paste: it ends here, nothing was sent
			if (captured && typeof captured.always === "function") { try { captured.always({}); } catch (e) { /* ignore */ } }
			let groups;
			try {
				const hit = typeof returnSigPaste !== "undefined" ? returnSigPaste.current : null;
				let ret2 = null;
				if (hit && hit.row && hit.jump) {
					const pickerOpen = typeof automapState !== "undefined" && !!automapState.pendingDecision;
					const plan = returnSigPaste.plan(hit.jump, tripwire.client.wormholes, tripwire.client.signatures, pickerOpen);
					if (plan.mode !== "none") { ret2 = { id: hit.row.id, to: hit.jump.from }; }
				}
				groups = pp.classify({
					rows: rows, payload: captured ? captured.data : null, systemID: systemID,
					signatures: tripwire.client.signatures, wormholes: tripwire.client.wormholes, broken: brokenSet(),
					keep: function(sig) { return typeof sigAnomalies !== "undefined" && sigAnomalies.keepOnFullPaste(sig, opts()); },
					returnHole: ret2
				});
			} catch (e) {
				console.warn("paste-preview: could not sort the paste, saving it as before", e);
				if (captured) { next.call(tripwire, "refresh", captured.data, null, null); }
				return ret;
			}
			state = { groups: groups, payload: captured ? captured.data : null, next: next, systemID: systemID, sameOpen: false };
			if (pp.needsPreview(groups, opts())) { open(); }
			else { apply(); }
			return ret;
		};
		Object.keys(parsePaste).forEach(function(k) { wrapped[k] = parsePaste[k]; });
		tripwire.pasteSignatures.parsePaste = wrapped;

		// ---- Settings > Signatures (Preview pastes: on unless off; Always preview: off unless on; Reset = both default) ----
		if (typeof forkSettings !== "undefined") {
			forkSettings.register({
				section: "signatures", order: 21, id: "pastePreview-enabled", type: "checkbox", key: "pastePreview",
				label: "Preview pastes:",
				text: "When a paste would remove signatures, show what changes first (gone signatures are deleted when you apply)",
				hint: "Off: a paste adds and updates straight away, with the old \"Click to delete missing sigs\" link.",
				keywords: ["paste", "preview", "missing", "delete", "broken", "gone", "probe scanner"],
				get: function(o) { return pp.enabled(o); },
				set: function(o, on) { o.pastePreview = Object.assign({}, o.pastePreview || {}, { enabled: !!on }); }
			});
			forkSettings.register({
				section: "signatures", order: 21.3, id: "pastePreview-auto", type: "select", key: "pastePreview",
				label: "Paste preview auto-save:",
				choices: pp.AUTO_CHOICES.map(function(c) { return [String(c[0]), c[0] ? "After " + c[1] : "Never (wait for me)"]; }),
				hint: "With no input in time, the preview saves only new and updated signatures: nothing is deleted or marked broken. Also in the preview's top right.",
				keywords: ["paste", "preview", "auto", "timer", "countdown", "seconds"],
				get: function(o) { return String(pp.autoSeconds(o)); },
				set: function(o, v) { o.pastePreview = Object.assign({}, o.pastePreview || {}, { autoSeconds: Number(v) }); }
			});
			forkSettings.register({
				section: "signatures", order: 21.5, id: "pastePreview-always", type: "checkbox", key: "pastePreview",
				label: "Always preview:",
				text: "Show the paste preview for every paste, also when nothing would be removed",
				keywords: ["paste", "preview", "always"],
				get: function(o) { return !!(o && o.pastePreview && o.pastePreview.always === true); },
				set: function(o, on) { o.pastePreview = Object.assign({}, o.pastePreview || {}, { always: !!on }); }
			});
		}

		pastePreview.debug = { state: function() { return state; }, apply: apply, stopCountdown: function() { stopCountdown(false); } };
	});
}
