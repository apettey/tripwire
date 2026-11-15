const undoHistory = {
	// Fork-owned: one undo / redo history per browser session for every signature and map edit (sig add / edit / delete
	// from the dialog, paste or inline cells; hole life, mass, type and leads-to; hole deletes, which take a system off the
	// map; automapper adds). Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes (not while typing in a field); the Undo / Redo
	// arrows and the command palette name the step ("Undo: delete sig ABC-123").
	//
	// How: upstream (and the fork features) push undo entries onto per-system stacks, tripwire.signatures.undo[systemID],
	// in the shapes {action: "add" | "remove" | "update", signatures: [sig | {wormhole, signatures: [sig, sig]}]}. Those
	// objects are replaced by proxies whose every system key is the same one stack, so every existing push lands in one
	// history without editing the pushers (upstream 2.0 pushes the same way: signaturePayload.recordUndo). tripwire.undo
	// and tripwire.redo are replaced: they undo a whole step (the entries one action pushed together, e.g. a paste's adds
	// and updates), through the normal save (refresh.php -> signatures.php), so other clients see it and the audit log
	// records it. A step is refused, with the reason, when someone else changed the items since.
	//
	// The pure part (entries, payloads, conflicts, labels, id remapping) is mocha-tested; the DOM part is below "---- DOM ----".
	// Keep `const undoHistory` on the first line: the test helper strips it to define a global.

	MAX: 100,							// steps kept per stack
	STORAGE_KEY: "tripwire_history",
	WAIT_LIST_MS: 3000,					// after a step, wait this long at most for the new list before the next one
	SWITCH_WAIT_MS: 8000,				// loading another system's list to undo a step made there

	// ---- Entries ----

	copy: function(o) {
		return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
	},

	/** An entry this history can undo itself (others, e.g. "jumpLink", belong to the feature that pushed them) */
	isStandard: function(entry) {
		return !!entry && (entry.action === "add" || entry.action === "remove" || entry.action === "update") && Array.isArray(entry.signatures);
	},

	isHole: function(el) {
		return !!el && typeof el === "object" && !!el.wormhole && typeof el.wormhole === "object" && Array.isArray(el.signatures);
	},

	/** The signature ids of an element: both sides of a hole, or the one signature */
	sigIds: function(el) {
		if (undoHistory.isHole(el)) { return el.signatures.map(function(s) { return s && s.id; }).filter(undoHistory.present); }
		return el && undoHistory.present(el.id) ? [el.id] : [];
	},

	/** The signature that must still be there for an element: the first side of a hole, or the signature */
	mainSigId: function(el) {
		if (undoHistory.isHole(el)) { return el.signatures[0] ? el.signatures[0].id : undefined; }
		return el ? el.id : undefined;
	},

	present: function(v) {
		return v !== undefined && v !== null && v !== "";
	},

	same: function(a, b) {
		return undoHistory.present(a) && undoHistory.present(b) && String(a) === String(b);
	},

	/** The top step of a stack: the last entry and the entries before it pushed by the same action (same meta.group).
	Returns how many entries from the end make the step (0 for an empty stack). A non-standard entry is a step of its own. */
	stepSize: function(stack) {
		if (!stack || !stack.length) { return 0; }
		const last = stack[stack.length - 1];
		if (!undoHistory.isStandard(last) || !last.meta || last.meta.group === undefined) { return 1; }
		let n = 1;
		while (n < stack.length) {
			const e = stack[stack.length - 1 - n];
			if (!undoHistory.isStandard(e) || !e.meta || e.meta.group !== last.meta.group) { break; }
			n++;
		}
		return n;
	},

	// ---- Payloads ----

	/** The refresh payload that undoes (direction "undo") or redoes ("redo") a step. Undo: add -> remove, remove -> add the
	saved copies back, update -> update to the saved copies. Redo: add -> add the saved copies, remove -> remove, update ->
	update. Returns {signatures: {add, update, remove}} (empty lists left out). */
	payload: function(direction, entries) {
		const add = [], update = [], remove = [];
		(entries || []).forEach(function(entry) {
			if (!undoHistory.isStandard(entry)) { return; }
			const kind = undoHistory.effect(direction, entry.action);
			entry.signatures.forEach(function(el) {
				if (!el) { return; }
				if (kind === "remove") {
					if (undoHistory.isHole(el)) { if (undoHistory.present(el.wormhole.id)) { remove.push({ id: el.wormhole.id }); } }
					else if (undoHistory.present(el.id)) { remove.push(el.id); }
				} else if (kind === "add") {
					add.push(undoHistory.forAdd(el));
				} else {
					update.push(undoHistory.copy(el));
				}
			});
		});
		const signatures = {};
		if (add.length) { signatures.add = add; }
		if (update.length) { signatures.update = update; }
		if (remove.length) { signatures.remove = remove; }
		return { signatures: signatures };
	},

	/** What the server is asked to do with an entry's elements: "add", "remove" or "update" */
	effect: function(direction, action) {
		if (action === "update") { return "update"; }
		if (direction === "undo") { return action === "add" ? "remove" : "add"; }
		return action === "add" ? "add" : "remove";
	},

	/** A saved copy ready to be added again (the server makes new ids and takes the author from the session) */
	forAdd: function(el) {
		const c = undoHistory.copy(el);
		if (undoHistory.isHole(c)) {
			if (!c.wormhole.parent) { c.wormhole.parent = "initial"; }
			delete c.wormhole.initialID;
			delete c.wormhole.secondaryID;
		}
		return c;
	},

	/** The elements a payload adds, in the order the server answers them in data.results */
	addedElements: function(direction, entries) {
		const out = [];
		(entries || []).forEach(function(entry) {
			if (undoHistory.isStandard(entry) && undoHistory.effect(direction, entry.action) === "add") {
				entry.signatures.forEach(function(el) { if (el) { out.push({ entry: entry, el: el }); } });
			}
		});
		return out;
	},

	/** Whether a refresh answer says every part was saved */
	succeeded: function(data) {
		return !!(data && Array.isArray(data.resultSet) && data.resultSet.length &&
			data.resultSet.every(function(r) { return r && r.result == true; }));	// eslint-disable-line eqeqeq
	},

	/** The server's reason for a failed answer, or "" */
	failure: function(data) {
		const r = data && Array.isArray(data.resultSet) ? data.resultSet.filter(function(x) { return !x || x.result != true; })[0] : null;	// eslint-disable-line eqeqeq
		return r && r.value ? String(r.value) : "";
	},

	// ---- Current state ----

	/** The wormhole a signature belongs to, from the client's list */
	holeOf: function(sigId, client) {
		const holes = client && client.wormholes ? client.wormholes : {};
		const keys = Object.keys(holes);
		for (let i = 0; i < keys.length; i++) {
			const w = holes[keys[i]];
			if (w && (undoHistory.same(w.initialID, sigId) || undoHistory.same(w.secondaryID, sigId))) { return w; }
		}
		return null;
	},

	/** A copy of how an element is now, to go back to it later (redo after an undo, undo after a redo): the hole with
	both sides if it is a hole now (initial side first, as the pushers save it and as adding it back needs), else the
	signature; the element itself when the client no longer has it. */
	snapshot: function(el, client) {
		const sigs = client && client.signatures ? client.signatures : {};
		const holes = client && client.wormholes ? client.wormholes : {};
		const group = function(w) {
			const a = sigs[w.initialID], b = sigs[w.secondaryID];
			return a && b ? { wormhole: undoHistory.copy(w), signatures: [undoHistory.copy(a), undoHistory.copy(b)] } : null;
		};
		if (undoHistory.isHole(el) && el.wormhole.id !== undefined && holes[el.wormhole.id]) {
			const g = group(holes[el.wormhole.id]);
			if (g) { return g; }
		}
		const id = undoHistory.mainSigId(el);
		const cur = undoHistory.present(id) ? sigs[id] : null;
		if (cur && cur.type === "wormhole") {
			const w = undoHistory.holeOf(cur.id, client);
			const g = w ? group(w) : null;
			if (g) { return g; }
		}
		if (cur) { return undoHistory.copy(cur); }
		return undoHistory.copy(el);
	},

	// ---- Conflicts ----

	/** Why a step can't be undone / redone without overwriting someone else's change, or null. ctx: {client, me (the
	session's character id), viewingSystemID, sigName(sig) -> "ABC-123"}. An item the step changes must still be there
	and be last changed by me; an item the step adds back must not be on the list again (same ID in the same system). */
	conflict: function(direction, entries, ctx) {
		const client = ctx && ctx.client ? ctx.client : {};
		const sigs = client.signatures || {};
		const name = ctx && ctx.sigName ? ctx.sigName : function(s) { return s && s.signatureID ? undoHistory.formatId(s.signatureID) : "a signature"; };
		const who = function(s) { return s && s.modifiedByName ? String(s.modifiedByName) : "someone else"; };
		const mine = function(s) { return !!s && ctx && undoHistory.present(ctx.me) && String(s.modifiedByID) === String(ctx.me); };
		const all = (entries || []).filter(undoHistory.isStandard);
		for (let i = 0; i < all.length; i++) {
			const entry = all[i];
			const kind = undoHistory.effect(direction, entry.action);
			for (let j = 0; j < entry.signatures.length; j++) {
				const el = entry.signatures[j];
				if (!el) { continue; }
				if (kind === "add") {
					// Adding back: the same signature ID must not be on the list again in that system
					const parts = undoHistory.isHole(el) ? el.signatures : [el];
					for (let k = 0; k < parts.length; k++) {
						const p = parts[k];
						if (!p || !p.signatureID) { continue; }
						const back = Object.keys(sigs).map(function(key) { return sigs[key]; }).filter(function(s) {
							return s && !undoHistory.same(s.id, p.id) && undoHistory.same(s.systemID, p.systemID) &&
								String(s.signatureID || "").toLowerCase() === String(p.signatureID).toLowerCase();
						})[0];
						if (back) { return { reason: "back", sig: back, text: name(back) + " is on the list again (" + (back.createdByName ? String(back.createdByName) : who(back)) + " added it)" }; }
					}
					continue;
				}
				// Removing or updating: the item must be there and nobody else may have changed it since
				const id = undoHistory.mainSigId(el);
				const cur = undoHistory.present(id) ? sigs[id] : null;
				if (!cur) { return { reason: "gone", sig: el, text: undoHistory.elementName(el, ctx) + " is no longer on the list (someone deleted it)" }; }
				const ids = undoHistory.sigIds(el);
				for (let k = 0; k < ids.length; k++) {
					const s = sigs[ids[k]];
					if (s && !mine(s)) { return { reason: "changed", sig: s, text: who(s) + " changed " + undoHistory.elementName(el, ctx) + " since" }; }
				}
			}
		}
		return null;
	},

	/** The system whose signature list is needed to check a step: a plain signature's system when it isn't the viewed
	one (the client holds the viewed system's signatures and every hole's), else null */
	systemNeeded: function(entries, viewingSystemID) {
		const all = (entries || []).filter(undoHistory.isStandard);
		for (let i = 0; i < all.length; i++) {
			for (let j = 0; j < all[i].signatures.length; j++) {
				const el = all[i].signatures[j];
				if (!el || undoHistory.isHole(el) || el.type === "wormhole") { continue; }
				if (undoHistory.present(el.systemID) && !undoHistory.same(el.systemID, viewingSystemID)) { return Number(el.systemID); }
			}
		}
		return null;
	},

	// ---- After a step ----

	/** Old id -> new id for what a step added back, from the answer's results (same order as the payload's adds).
	Returns {sig: {}, hole: {}} or null when the answer doesn't line up with the request. */
	idMap: function(added, results) {
		if (!Array.isArray(results) || results.length !== added.length) { return null; }
		const map = { sig: {}, hole: {} };
		for (let i = 0; i < added.length; i++) {
			const el = added[i].el, res = results[i];
			if (!res) { return null; }
			if (undoHistory.isHole(el)) {
				if (!res.wormhole || !Array.isArray(res.signatures)) { return null; }
				if (undoHistory.present(el.wormhole.id)) { map.hole[el.wormhole.id] = res.wormhole.id; }
				el.signatures.forEach(function(s, k) {
					if (s && undoHistory.present(s.id) && res.signatures[k]) { map.sig[s.id] = res.signatures[k].id; }
				});
			} else if (undoHistory.present(el.id)) {
				map.sig[el.id] = res.id;
			}
		}
		return map;
	},

	/** Rewrite ids in stack entries (in place) after items were added back under new ids */
	remap: function(stack, map) {
		if (!map || !Array.isArray(stack)) { return stack; }
		const sig = function(id) { return undoHistory.present(id) && Object.prototype.hasOwnProperty.call(map.sig, id) ? map.sig[id] : id; };
		const one = function(el) {
			if (!el || typeof el !== "object") { return; }
			if (undoHistory.isHole(el)) {
				if (undoHistory.present(el.wormhole.id) && Object.prototype.hasOwnProperty.call(map.hole, el.wormhole.id)) { el.wormhole.id = map.hole[el.wormhole.id]; }
				if (el.wormhole.initialID !== undefined) { el.wormhole.initialID = sig(el.wormhole.initialID); }
				if (el.wormhole.secondaryID !== undefined) { el.wormhole.secondaryID = sig(el.wormhole.secondaryID); }
				el.signatures.forEach(function(s) { if (s) { s.id = sig(s.id); } });
			} else if (el.id !== undefined) {
				el.id = sig(el.id);
			}
		};
		stack.forEach(function(entry) {
			if (entry && Array.isArray(entry.signatures)) { entry.signatures.forEach(one); }
		});
		return stack;
	},

	/** The entries that go on the other stack after a step succeeded, in push order. snapshots: per entry, the
	snapshot() of each element taken just before the step. results: data.results of the answer. Returns
	{entries, map} (map: the id remapping for re-added items, or null). */
	opposite: function(direction, entries, snapshots, results) {
		const added = undoHistory.addedElements(direction, entries);
		const map = added.length ? undoHistory.idMap(added, results) : null;
		let r = 0;
		const out = (entries || []).filter(undoHistory.isStandard).map(function(entry, i) {
			const kind = undoHistory.effect(direction, entry.action);
			let sigs;
			if (kind === "add") {
				// what was added back, as the server returned it (new ids)
				sigs = entry.signatures.filter(Boolean).map(function(el) { const res = Array.isArray(results) ? results[r++] : null; return res ? undoHistory.copy(res) : undoHistory.copy(el); });
			} else {
				// removed or updated: how it was just before, to put it back
				sigs = (snapshots && snapshots[i]) ? snapshots[i] : undoHistory.copy(entry.signatures);
			}
			return { action: entry.action, signatures: sigs, meta: Object.assign({}, entry.meta || {}) };
		});
		return { entries: out, map: map };
	},

	// ---- Labels ----

	/** "ABC-123" from "abc123" */
	formatId: function(id) {
		const s = String(id === undefined || id === null ? "" : id).toUpperCase();
		return s.length > 3 ? s.substring(0, 3) + "-" + s.substring(3) : s;
	},

	/** "sig ABC-123", "hole ABC-123 to J123456", "hole Jita to J123456" (no ID yet) */
	elementName: function(el, ctx) {
		const sysName = function(id) { return ctx && ctx.systemName ? (ctx.systemName(id) || "") : ""; };
		if (undoHistory.isHole(el)) {
			const viewing = ctx ? ctx.viewingSystemID : undefined;
			let here = el.signatures[0], there = el.signatures[1];
			if (there && undoHistory.same(there.systemID, viewing) && !(here && undoHistory.same(here.systemID, viewing))) { here = el.signatures[1]; there = el.signatures[0]; }
			if (!(here && here.signatureID) && there && there.signatureID) { const t = here; here = there; there = t; }
			const to = there ? sysName(there.systemID) : "";
			if (here && here.signatureID) { return "hole " + undoHistory.formatId(here.signatureID) + (to ? " to " + to : ""); }
			const from = here ? sysName(here.systemID) : "";
			return from && to ? "hole " + from + " to " + to : to ? "hole to " + to : "hole";
		}
		if (el && el.type === "wormhole") { return el.signatureID ? "hole " + undoHistory.formatId(el.signatureID) : "hole"; }
		return el && el.signatureID ? "sig " + undoHistory.formatId(el.signatureID) : "sig";
	},

	/** What an edit changed, by comparing the saved copy (before) with the client's item now (after) */
	changedFields: function(el, client) {
		const sigs = client && client.signatures ? client.signatures : {};
		const holes = client && client.wormholes ? client.wormholes : {};
		const out = [];
		if (undoHistory.isHole(el)) {
			const w = holes[el.wormhole.id];
			if (!w) { return out; }
			if (String(w.life || "") !== String(el.wormhole.life || "")) { out.push("life"); }
			else {
				const a = el.signatures[0], cur = a ? sigs[a.id] : null;
				if (a && cur && a.lifeLeft && cur.lifeLeft && String(a.lifeLeft) !== String(cur.lifeLeft) && String(a.lifeLength) === String(cur.lifeLength)) { out.push("life"); }
			}
			if (String(w.mass || "") !== String(el.wormhole.mass || "")) { out.push("mass"); }
			if (String(w.type || "").toUpperCase() !== String(el.wormhole.type || "").toUpperCase()) { out.push("type"); }
			const lead = el.signatures.some(function(s) { const c = s ? sigs[s.id] : null; return c && !undoHistory.same(c.systemID, s.systemID); });
			if (lead) { out.push("leads to"); }
			const named = el.signatures.some(function(s) {
				const c = s ? sigs[s.id] : null;
				return c && (String(c.signatureID || "") !== String(s.signatureID || "") || String(c.name || "") !== String(s.name || ""));
			});
			if (named) { out.push("name"); }
			return out;
		}
		const cur = el ? sigs[el.id] : null;
		if (!cur) { return out; }
		if (String(cur.type || "") !== String(el.type || "")) { out.push("type"); }
		if (String(cur.signatureID || "") !== String(el.signatureID || "")) { out.push("ID"); }
		if (String(cur.name || "") !== String(el.name || "")) { out.push("name"); }
		return out;
	},

	/** "delete sig ABC-123", "edit hole ABC-123 to J123456 (mass)", "add 4 sigs" */
	label: function(entry, ctx) {
		if (!entry) { return ""; }
		if (entry.action === "jumpLink") { return "link the jump to its signature"; }
		if (!undoHistory.isStandard(entry)) { return String(entry.action || "change"); }
		const verb = { add: "add", remove: "delete", update: "edit" }[entry.action];
		const els = entry.signatures.filter(Boolean);
		if (!els.length) { return verb; }
		if (els.length === 1) {
			let text = verb + " " + undoHistory.elementName(els[0], ctx);
			const fields = entry.action === "update" && ctx && ctx.client ? undoHistory.changedFields(els[0], ctx.client) : [];
			if (fields.length) { text += " (" + fields.join(", ") + ")"; }
			return text;
		}
		const holes = els.filter(undoHistory.isHole).length;
		const noun = holes === els.length ? "holes" : holes === 0 ? "sigs" : "signatures";
		return verb + " " + els.length + " " + noun;
	},

	/** The label of a step (one or more entries pushed together) */
	stepLabel: function(entries) {
		const labels = (entries || []).map(function(e) { return e && e.meta && e.meta.label ? e.meta.label : undoHistory.label(e, null); }).filter(Boolean);
		return labels.join(", ");
	},

	// ---- Keys ----

	/** What a keydown means: "undo" (Ctrl/Cmd+Z), "redo" (Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y) or null. state: {key, code,
	ctrlKey, metaKey, shiftKey, altKey, editable (focus in a text field / editor)} */
	keyAction: function(s) {
		if (!s || s.editable || s.altKey || !(s.ctrlKey || s.metaKey)) { return null; }
		const key = String(s.key || "").toLowerCase();
		const z = key === "z" || s.code === "KeyZ", y = key === "y" || s.code === "KeyY";
		if (z) { return s.shiftKey ? "redo" : "undo"; }
		if (y && !s.shiftKey) { return "redo"; }
		return null;
	},

	// ---- Storage ----

	/** The saved history, checked (anything odd is dropped) */
	load: function(text) {
		let o = null;
		try { o = JSON.parse(text); } catch (e) { o = null; }
		const ok = function(list) {
			return Array.isArray(list) ? list.filter(function(e) { return e && typeof e === "object" && typeof e.action === "string" && Array.isArray(e.signatures); }) : [];
		};
		return { undo: ok(o && o.undo), redo: ok(o && o.redo), group: o && Number.isInteger(o.group) ? o.group : 0 };
	},

	/** Keep the newest MAX steps of a stack (in place); whole steps only */
	trim: function(stack, max) {
		const limit = max || undoHistory.MAX;
		let steps = 0, i = stack.length;
		while (i > 0) {
			const n = undoHistory.stepSize(stack.slice(0, i));
			i -= n;
			steps++;
			if (steps === limit) { break; }
		}
		if (i > 0) { stack.splice(0, i); }
		return stack;
	}
};

// ---- DOM ----

undoHistory.ui = {
	state: null,			// {undo: [], redo: [], group}
	busy: false,
	openGroup: null,		// the group id of entries pushed in the current task
	lastParse: 0,

	ctx: function() {
		const me = typeof init !== "undefined" && init ? init.characterID : (typeof options !== "undefined" && options.character ? options.character.id : null);
		return {
			client: tripwire.client || {},
			me: me,
			viewingSystemID: typeof viewingSystemID !== "undefined" ? viewingSystemID : null,
			systemName: undoHistory.ui.systemName,
			sigName: function(s) { return s && s.signatureID ? undoHistory.formatId(s.signatureID) : "a signature"; }
		};
	},

	systemName: function(id) {
		if (!undoHistory.present(id)) { return ""; }
		const sys = (typeof appData !== "undefined" && appData.systems && appData.systems[id]) || (tripwire.systems && tripwire.systems[id]);
		if (sys && sys.name) { return String(sys.name); }
		const generic = typeof appData !== "undefined" && appData.genericSystemTypes ? appData.genericSystemTypes[id] : null;
		return generic ? String(generic) : "";
	},

	save: function() {
		try { sessionStorage.setItem(undoHistory.STORAGE_KEY, JSON.stringify(undoHistory.ui.state)); } catch (e) { /* storage unavailable */ }
	},

	/** One stack array whose push / pop keep the history's bookkeeping (labels, groups, redo cleared by a new edit) */
	makeStack: function(which, items) {
		const ui = undoHistory.ui;
		const stack = Array.isArray(items) ? items : [];
		Object.defineProperty(stack, "push", { enumerable: false, configurable: true, writable: true, value: function() {
			const added = Array.prototype.slice.call(arguments);
			added.forEach(function(entry) { ui.annotate(entry); });
			const n = Array.prototype.push.apply(stack, added);
			if (which === "undo" && !ui.internal) {
				ui.state.redo.length = 0;	// a new edit: what was undone can't be redone over it
				undoHistory.trim(stack);
				added.forEach(function(entry) {
					if (typeof forkHints !== "undefined" && forkHints.emit) { forkHints.emit("history.recorded", { action: entry && entry.action }); }
				});
			}
			ui.changed();
			return n;
		} });
		Object.defineProperty(stack, "pop", { enumerable: false, configurable: true, writable: true, value: function() {
			const out = Array.prototype.pop.apply(stack, arguments);
			ui.changed();
			return out;
		} });
		return stack;
	},

	/** Label and group a pushed entry. Entries pushed in the same task (a paste's adds and updates, an automap's add
	and update) are one step. */
	annotate: function(entry) {
		const ui = undoHistory.ui;
		if (!entry || typeof entry !== "object") { return; }
		if (ui.internal) { return; }	// moved between the stacks by undo / redo: keeps its meta
		const meta = entry.meta = entry.meta || {};
		meta.at = Date.now();
		if (undoHistory.isStandard(entry)) {
			// Pushers hand over the client's own objects; a later list could change them: keep a copy
			entry.signatures = undoHistory.copy(entry.signatures);
			if (ui.openGroup === null) {
				ui.openGroup = ++ui.state.group;
				setTimeout(function() { ui.openGroup = null; }, 0);
			}
			meta.group = ui.openGroup;
		}
		try { meta.label = undoHistory.label(entry, ui.ctx()); } catch (e) { meta.label = undoHistory.label(entry, null); }
	},

	/** Proxy for tripwire.signatures.undo / .redo: every system id is the one stack */
	proxy: function(which) {
		const ui = undoHistory.ui;
		const isKey = function(k) { return typeof k === "string" && /^-?\d+$|^undefined$|^null$/.test(k); };
		return new Proxy({}, {
			get: function(t, k) { return isKey(k) ? ui.state[which] : undefined; },
			has: function(t, k) { return isKey(k); },
			set: function(t, k, v) {
				if (isKey(k) && Array.isArray(v) && v !== ui.state[which]) { ui.state[which].push.apply(ui.state[which], v); }
				return true;
			},
			deleteProperty: function() { return true; },
			ownKeys: function() { return []; },
			getOwnPropertyDescriptor: function() { return undefined; }
		});
	},

	install: function() {
		const ui = undoHistory.ui;
		let saved = null;
		try { saved = sessionStorage.getItem(undoHistory.STORAGE_KEY); } catch (e) { saved = null; }
		const s = undoHistory.load(saved);
		ui.state = { undo: [], redo: [], group: s.group };
		ui.state.undo = ui.makeStack("undo", s.undo);
		ui.state.redo = ui.makeStack("redo", s.redo);
		tripwire.signatures.undo = ui.proxy("undo");
		tripwire.signatures.redo = ui.proxy("redo");
		try { sessionStorage.removeItem("tripwire_undo"); sessionStorage.removeItem("tripwire_redo"); } catch (e) { /* ignore */ }
		tripwire.undo = function() { return ui.run("undo"); };
		tripwire.redo = function() { return ui.run("redo"); };
		// When the new list arrives (a step's answer may come without it)
		const parse = tripwire.parse;
		if (typeof parse === "function") {
			tripwire.parse = function() {
				const ret = parse.apply(this, arguments);
				ui.lastParse = Date.now();
				return ret;
			};
		}
	},

	changed: function() {
		const ui = undoHistory.ui;
		ui.save();
		clearTimeout(ui.paintTimer);
		ui.paintTimer = setTimeout(ui.paint, 0);
	},

	top: function(which) {
		const stack = undoHistory.ui.state[which];
		const n = undoHistory.stepSize(stack);
		return n ? stack.slice(stack.length - n) : [];
	},

	/** "Undo: delete sig ABC-123" for the buttons, the palette and the notices */
	describe: function(which) {
		const step = undoHistory.ui.top(which);
		if (!step.length) { return ""; }
		return (which === "undo" ? "Undo: " : "Redo: ") + undoHistory.stepLabel(step);
	},

	paint: function() {
		const ui = undoHistory.ui;
		["undo", "redo"].forEach(function(which) {
			const $b = $("#" + which);
			const has = ui.state[which].length > 0;
			$b.toggleClass("disabled", !has || ui.busy);
			const keys = which === "undo" ? "Ctrl+Z" : "Ctrl+Shift+Z";
			$b.attr("data-tooltip", has ? _.escape(ui.describe(which)) + " - " + keys : (which === "undo" ? "Nothing to undo" : "Nothing to redo"));
		});
	},

	notify: function(text, color, ms) {
		if (typeof Notify !== "undefined") { Notify.trigger(_.escape(text), color || "blue", ms || 4000); }
	},

	/** Undo or redo the top step */
	run: function(which) {
		const ui = undoHistory.ui;
		if (ui.busy) { return false; }
		const stack = ui.state[which];
		const step = ui.top(which);
		if (!step.length) { ui.notify(which === "undo" ? "Nothing to undo" : "Nothing to redo"); return false; }
		if (!undoHistory.isStandard(step[0])) {
			// A feature's own entry (it wraps tripwire.undo and handles it; reaching here means it isn't loaded)
			stack.pop();
			ui.notify("Can't " + which + " \"" + undoHistory.stepLabel(step) + "\" here: it was skipped.", "yellow", 6000);
			return false;
		}
		const label = undoHistory.stepLabel(step);
		const sys = undoHistory.systemNeeded(step, viewingSystemID);
		ui.busy = true;
		ui.paint();
		const go = function() { ui.perform(which, step, label); };
		if (sys !== null && typeof tripwire.systemChange === "function") {
			// The change was made in another system: show it, and check it against that system's list
			const asked = Date.now();
			tripwire.systemChange(sys);
			const wait = function() {
				if (ui.lastParse > asked && viewingSystemID == sys && !tripwire.xhr) { go(); return; }	// eslint-disable-line eqeqeq
				if (Date.now() - asked > undoHistory.SWITCH_WAIT_MS) {
					ui.busy = false;
					ui.paint();
					ui.notify("Couldn't load " + (ui.systemName(sys) || "that system") + " to " + which + " \"" + label + "\". Try again.", "red", 8000);
					return;
				}
				setTimeout(wait, 100);
			};
			setTimeout(wait, 100);
			return true;
		}
		go();
		return true;
	},

	perform: function(which, step, label) {
		const ui = undoHistory.ui;
		const ctx = ui.ctx();
		const verb = which === "undo" ? "undo" : "redo";
		const conflict = undoHistory.conflict(which, step, ctx);
		const stack = ui.state[which];
		const drop = function() {
			ui.internal = true;
			try { stack.splice(stack.length - step.length, step.length); } finally { ui.internal = false; }
			ui.changed();
		};
		if (conflict) {
			drop();
			ui.busy = false;
			ui.paint();
			if (typeof forkUsage !== "undefined") { forkUsage.track("undoHistory", "conflict"); }
			ui.notify("Can't " + verb + " \"" + label + "\": " + conflict.text + ". Nothing was changed; that step is skipped.", "red", 10000);
			return;
		}
		const snapshots = step.map(function(entry) {
			return entry.signatures.map(function(el) { return undoHistory.snapshot(el, ctx.client); });
		});
		const payload = undoHistory.payload(which, step);
		payload.systemID = viewingSystemID;
		let answered = false;
		const success = function(data) {
			answered = true;
			if (!undoHistory.succeeded(data)) {
				drop();
				const why = undoHistory.failure(data);
				ui.notify("Couldn't " + verb + " \"" + label + "\"" + (why ? ": " + why : "") + ". That step is skipped.", "red", 10000);
				return;
			}
			const other = which === "undo" ? "redo" : "undo";
			const opp = undoHistory.opposite(which, step, snapshots, data.results);
			ui.internal = true;
			try {
				stack.splice(stack.length - step.length, step.length);
				if (opp.map) { undoHistory.remap(ui.state.undo, opp.map); undoHistory.remap(ui.state.redo, opp.map); }
				opp.entries.forEach(function(e) { ui.state[other].push(e); });
				undoHistory.trim(ui.state[other]);
			} finally { ui.internal = false; }
			ui.changed();
			if (typeof forkUsage !== "undefined") {
				if (which === "undo") { forkUsage.track("undoHistory", "undone"); } else { forkUsage.track("undoHistory", "redone"); }
			}
			ui.notify((which === "undo" ? "Undone: " : "Redone: ") + label, "green", 4000);
			if (!data.signatures) { ui.waitForList = Date.now(); }
		};
		const always = function() {
			const release = function() { ui.busy = false; ui.paint(); };
			if (!answered) {
				ui.notify("Couldn't " + verb + " \"" + label + "\": no answer from the server. Try again.", "red", 8000);
				release();
				return;
			}
			// The answer may come without the new list (same-second edits): wait for it so the next step checks fresh data
			const since = ui.waitForList;
			ui.waitForList = 0;
			if (!since) { release(); return; }
			const wait = function() {
				if (ui.lastParse > since || Date.now() - since > undoHistory.WAIT_LIST_MS) { release(); return; }
				setTimeout(wait, 100);
			};
			wait();
		};
		tripwire.refresh("refresh", payload, success, always);
	},

	isEditable: function(el) {
		if (!el || el === document.body) { return false; }
		if (el.isContentEditable) { return true; }
		const tag = String(el.tagName || "").toLowerCase();
		if (tag === "textarea" || tag === "select") { return true; }
		if (tag === "input") {
			const type = String(el.type || "text").toLowerCase();
			return ["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"].indexOf(type) < 0;
		}
		return false;
	},

	onKeydown: function(e) {
		const ui = undoHistory.ui;
		const action = undoHistory.keyAction({
			key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
			editable: ui.isEditable(document.activeElement)
		});
		if (!action) { return; }
		e.preventDefault();
		e.stopImmediatePropagation();	// upstream's own Ctrl+Z / Ctrl+Y handler (global-hooks.js) would run it again
		if (e.repeat) { return; }
		if (ui.busy) { return; }
		if (!ui.state[action].length) { ui.notify(action === "undo" ? "Nothing to undo" : "Nothing to redo"); return; }
		// Through the button's handler, so a feature wrapping tripwire.undo (jump-sig-prompt's link entries) sees it
		if (action === "undo") { tripwire.undo(); } else { tripwire.redo(); }
	},

	setupPalette: function() {
		if (typeof forkCommands === "undefined" || !Array.isArray(forkCommands.commands)) { return; }
		forkCommands.commands.forEach(function(c) {
			if (c.id === "sig.undo") {
				c.hint = function() { return undoHistory.ui.describe("undo") || "Nothing to undo"; };
				c.keywords = (c.keywords || []).concat(["undo", "history"]);
			}
			if (c.id === "sig.redo") {
				c.shortcut = "Ctrl+Shift+Z";
				c.hint = function() { return undoHistory.ui.describe("redo") || "Nothing to redo"; };
			}
		});
	},

	setupTip: function() {
		if (typeof forkHints === "undefined" || !forkHints.register) { return; }
		forkHints.register({
			id: "undoHistory.keys", feature: "undoHistory", section: "signatures",
			trigger: "history.recorded", kind: "callout", anchor: "#undo", placement: "bottom",
			eligible: function(ctx, data) { return !!data && (data.action === "remove" || data.action === "update"); },
			title: "Undo any edit with Ctrl+Z",
			body: "Ctrl+Z undoes your last signature or map edit (a delete, a life or mass change, a paste), wherever you made it; "
				+ "Ctrl+Shift+Z or Ctrl+Y redoes it. Hover the arrow to see which step is next.\n\nTurn tips off in Settings > General.",
			priority: 55, maxShows: 2, cooldownHours: 72, ttlSeconds: 300
		});
	},

	init: function() {
		const ui = undoHistory.ui;
		window.addEventListener("keydown", ui.onKeydown, true);
		ui.setupPalette();
		ui.setupTip();
		ui.paint();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && typeof tripwire !== "undefined" && tripwire && tripwire.signatures &&
	typeof Proxy !== "undefined") {
	undoHistory.ui.install();
	jQuery(function() { undoHistory.ui.init(); });
}
