const sigInline = {
	// Inline life / mass edits on the signature table (fork-owned): click the Life or Mass cell of a wormhole row
	// (or press L / M with one row selected) and pick a value, instead of opening the edit dialog.
	// Double-click still opens the dialog. Only the changed field is sent (the dialog sends everything), and the
	// change is pushed on the same undo stack as the dialog's, so Ctrl+Z restores it.
	// sigInline.setWormhole(wormholeID, {life|mass: value}) is the save path; the command palette reuses it.
	// Life offers Stable / <4h / <1h / EOL when the life states setting is on (life-states.js), else Stable / EOL.
	// Setting: options.sigInline.enabled (missing = on). Keep `const sigInline` on the first line: the test helper
	// strips it to define a global.

	FIELDS: {
		life: {
			column: 5, title: "Life",
			choices: [{ value: "stable", label: "Stable", key: "1" }, { value: "critical", label: "EOL", key: "2" }]
		},
		mass: {
			column: 6, title: "Mass",
			choices: [{ value: "stable", label: "Stable", key: "1" }, { value: "destab", label: "Destab", key: "2" }, { value: "critical", label: "Critical", key: "3" }]
		}
	},

	SAVE_TIMEOUT_MS: 15000,

	KEY_FIELD: { l: "life", m: "mass" },

	// ---- Pure logic (unit-tested) ----

	enabled: function(o) {
		return !(o && o.sigInline && o.sigInline.enabled === false);
	},

	/** Whether life uses the four states (life-states.js) */
	statesOn: function() {
		return typeof lifeStates !== "undefined" && lifeStates.isOn();
	},

	/** The choices of a field: life's four states when they are on, else FIELDS[field].choices */
	choices: function(field) {
		if (field === "life" && sigInline.statesOn()) {
			return lifeStates.STATES.map(function(s, i) { return { value: s.key, label: s.label, key: String(i + 1), keys: s.keys }; });
		}
		const def = sigInline.FIELDS[field];
		return def ? def.choices : [];
	},

	/** Field name for a table column (1-based), or null */
	fieldForColumn: function(column) {
		const names = Object.keys(sigInline.FIELDS);
		for (let i = 0; i < names.length; i++) {
			if (sigInline.FIELDS[names[i]].column === column) { return names[i]; }
		}
		return null;
	},

	/** The choice for a hotkey digit, or null */
	choiceForKey: function(field, key) {
		return sigInline.choices(field).filter(function(c) { return c.key === key; })[0] || null;
	},

	choiceFor: function(field, value) {
		return sigInline.choices(field).filter(function(c) { return c.value === value; })[0] || null;
	},

	/** Text of the table cell for a value: what upstream renders (life: Stable / EOL, mass: the raw value);
	a life state shows its label (<4h, <1h, EOL) */
	cellText: function(field, value) {
		if (field === "life") {
			const state = typeof lifeStates !== "undefined" ? lifeStates.state(value) : null;
			return { critical: "EOL", stable: "Stable" }[value] || (state ? state.label : value);
		}
		return value;
	},

	/** Classes of the table cell for a value (the colour): the value, or a life state's classes */
	cellClass: function(field, value) {
		const state = field === "life" && typeof lifeStates !== "undefined" ? lifeStates.state(value) : null;
		return state ? state.cls : value;
	},

	/** A life value in the current mode: with life states on, upstream's "critical" (EOL) is "lt4h" */
	normalise: function(field, value) {
		return field === "life" && value === "critical" && sigInline.statesOn() ? "lt4h" : value;
	},

	/** The value shown for a wormhole's field: its life state when those are on, else the stored value */
	valueOf: function(wormhole, field) {
		if (field === "life" && wormhole && sigInline.statesOn()) { return lifeStates.current(wormhole); }
		return wormhole ? wormhole[field] : undefined;
	},

	/** What a change of the field by someone else would change: the stored value (and for life states, the timers) */
	snapshot: function(wormhole, field) {
		if (!wormhole) { return undefined; }
		if (field === "life" && sigInline.statesOn()) {
			const sigs = lifeStates.sigsOf(wormhole);
			return [wormhole.life, (sigs[0] || {}).lifeLeft, (sigs[1] || {}).lifeLeft].join("|");
		}
		return wormhole[field];
	},

	/** The wormhole a signature belongs to (wormholes: tripwire.client.wormholes), or undefined */
	findWormhole: function(wormholes, sigID) {
		return Object.values(wormholes || {}).filter(function(wh) {
			return String(wh.initialID) === String(sigID) || String(wh.secondaryID) === String(sigID);
		})[0];
	},

	/** Payload for tripwire.refresh: only the changed field, both signature ids (the server needs them).
	Null when nothing would change (unknown field/value, or the hole already has that value).
	states: {sigs: [sig1, sig2], now} when life uses the four states: the value is a state, see lifeStates.payload */
	buildPayload: function(wormhole, field, value, states) {
		if (field === "life" && states && typeof lifeStates !== "undefined") {
			return lifeStates.payload(wormhole, states.sigs[0], states.sigs[1], value, states.now);
		}
		if (!wormhole || !sigInline.choiceFor(field, value)) { return null; }
		if (wormhole[field] === value) { return null; }
		const change = { id: wormhole.id };
		change[field] = value;
		return { signatures: { update: [{ wormhole: change, signatures: [{ id: wormhole.initialID }, { id: wormhole.secondaryID }] }] } };
	},

	/** Undo-stack entry, the same shape the signature dialog pushes for an update. Copies, so a later
	refresh replacing the client's objects cannot change it. */
	undoEntry: function(wormhole, sig1, sig2) {
		const copy = function(o) { return JSON.parse(JSON.stringify(o)); };
		// lifeLeft after lifeLength, so the server restores the timer (the life state) and doesn't recompute it
		const sig = function(o) { const c = copy(o); return typeof lifeStates !== "undefined" ? lifeStates.lifeLeftLast(c) : c; };
		return { action: "update", signatures: [{ wormhole: copy(wormhole), signatures: [sig(sig1), sig(sig2)] }] };
	},

	/** What a key press means. state: {key, ctrlKey, metaKey, altKey, shiftKey, repeat, targetEditable, dialogOpen,
	selectedCount, popoverField (null = closed)}. Returns {type: "open", field} | {type: "pick", value} |
	{type: "move", delta} | {type: "close"} | null (leave the key alone). */
	keyAction: function(s) {
		if (s.ctrlKey || s.metaKey || s.altKey) { return null; }
		const key = String(s.key || "").toLowerCase();
		// Held arrow keys keep moving the selection (and keep the page from scrolling); every other key acts once per press
		if (s.repeat && !(key === "arrowup" || key === "arrowdown") ) { return null; }
		if (s.popoverField) {
			if (s.repeat) { return null; }
			if (s.targetEditable) { return null; }
			if (key === "tab") { return { type: "close" }; }
			if (key === "escape") { return { type: "close" }; }
			if (key === "arrowleft" || key === "arrowup") { return { type: "move", delta: -1 }; }
			if (key === "arrowright" || key === "arrowdown") { return { type: "move", delta: 1 }; }
			const choice = sigInline.choiceForKey(s.popoverField, key);
			if (choice) { return { type: "pick", value: choice.value }; }
			if (sigInline.KEY_FIELD[key] && !s.shiftKey && s.selectedCount === 1) { return { type: "open", field: sigInline.KEY_FIELD[key] }; }
			return null;
		}
		if (s.shiftKey || s.targetEditable || s.dialogOpen || s.selectedCount !== 1) { return null; }
		const field = sigInline.KEY_FIELD[key];
		if (field) { return { type: "open", field: field }; }
		// Keyboard walk through the signature table: with one row selected, up/down move it and Enter edits it
		// (only when the focus is on the page itself or plainly inside the signature widget, see focusOk)
		if (!s.focusOk) { return null; }
		if (key === "arrowup") { return { type: "nav", delta: -1 }; }
		if (key === "arrowdown") { return { type: "nav", delta: 1 }; }
		if (key === "enter") { return { type: "edit" }; }
		return null;
	},

	/** Whether the focused element lets the table keys act: the page body, or a plain element inside the signature widget.
	Never a button, link, tab, summary, form control, [tabindex] / [role] widget, details or scrollable panel (they use those keys). */
	focusOk: function(el) {
		const doc = el && el.ownerDocument;
		if (!el || (doc && (el === doc.body || el === doc.documentElement))) { return true; }
		if (!el.closest || !el.closest("#signaturesWidget")) { return false; }
		if (el.matches && el.matches("button, a, summary, select, input, textarea, [tabindex], [role], [contenteditable]")) { return false; }
		if (el.closest("details, [role='tab'], [role='tablist'], [role='dialog']")) { return false; }
		return !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test((el.ownerDocument.defaultView.getComputedStyle(el) || {}).overflowY || ""));
	},

	/** Index of the row to select after moving from `index` by `delta` in a table of `count` rows (stops at the ends), or -1 */
	neighbour: function(index, delta, count) {
		if (!(count > 0) || index < 0 || index >= count) { return -1; }
		return Math.max(0, Math.min(count - 1, index + delta));
	},

	/** Ids to re-select after a refresh: those of `keep.ids` that were newly inserted as rows (addedIds), while the
	remembered selection is still fresh. */
	idsToReselect: function(keep, addedIds, now) {
		if (!keep || now >= keep.until) { return []; }
		return keep.ids.filter(function(id) { return addedIds.indexOf(String(id)) >= 0; });
	},

	/** Next index of the focused chip (wraps) */
	step: function(index, delta, count) {
		return (((index + delta) % count) + count) % count;
	},

	/** What to do with an open popover after the table's rows were re-rendered (the 10 s refresh).
	prev: {field, value, snap} shown in the popover; wormhole: the client's current wormhole (or undefined);
	rowExists: the row is still in the table; now: {value, snap} of the wormhole now (default: its stored field).
	Only a change of the stored data (snap) counts, not a life state moving on with time. */
	reanchor: function(prev, wormhole, rowExists, now) {
		if (!rowExists || !wormhole) { return { action: "close" }; }
		const cur = now || { value: wormhole[prev.field], snap: wormhole[prev.field] };
		const before = prev.snap !== undefined ? prev.snap : prev.value;
		if (cur.snap !== before) { return { action: "changed", value: cur.value }; }
		return { action: "keep" };
	},

	// ---- Save path ----

	/** Save a change to one wormhole: sigInline.setWormhole(wormholeID, {life: "lt1h"}) or {mass: "destab"}.
	Life takes a state (stable / lt4h / lt1h / expired) when life states are on, else stable / critical; "critical"
	means "lt4h" with states on.
	Updates the table cell at once (restored if the save fails), and on success pushes the undo entry so Ctrl+Z
	works. Returns a Promise of "saved" | "same" | "failed". */
	setWormhole: function(wormholeID, change) {
		// One save at a time: tripwire.sync merges a request made while another is in flight into the pending one
		// and loses the first, so each save starts after the previous one's response.
		const run = function() { return sigInline.saveNow(wormholeID, change); };
		const result = sigInline.queue.then(run, run);
		sigInline.queue = result.then(function() {}, function() {});
		return result;
	},

	queue: Promise.resolve(),

	saveNow: function(wormholeID, change) {
		const field = Object.keys(change || {})[0];
		const value = sigInline.normalise(field, field ? change[field] : undefined);
		const wh = tripwire.client.wormholes[wormholeID];
		const s1 = wh && tripwire.client.signatures[wh.initialID], s2 = wh && tripwire.client.signatures[wh.secondaryID];
		const states = field === "life" && sigInline.statesOn() ? { sigs: [s1, s2], now: lifeStates.now() } : null;
		const payload = sigInline.buildPayload(wh, field, value, states);
		if (!payload) {
			if (wh && sigInline.choiceFor(field, value)) { return Promise.resolve("same"); }
			Notify.trigger("Could not save: that wormhole is no longer on the map", "red");
			return Promise.resolve("failed");
		}
		if (!s1 || !s2) {
			Notify.trigger("Could not save: the wormhole's signatures are missing", "red");
			return Promise.resolve("failed");
		}
		sigInline.keepSelected = { ids: $("#sigTable tbody tr.selected").map(function() { return String($(this).data("id")); }).get(), until: Date.now() + 5000 };
		const entry = sigInline.undoEntry(wh, s1, s2);
		const systemID = viewingSystemID;	// the undo stack of the system the change was made in
		const cells = sigInline.cellsFor(wh, field);
		const before = cells.map(function(c) { return { cell: c, cls: c.className, text: c.textContent }; });
		const def = sigInline.FIELDS[field];
		cells.forEach(function(c) {
			$(c).removeClass("stable destab critical life-lt4h life-lt1h life-expired").addClass(sigInline.cellClass(field, value) + " sig-inline-saving");
			c.textContent = sigInline.cellText(field, value);
		});

		return new Promise(function(resolve) {
			let saved = false, done = false, timer = null;
			// Settle once: when the response never comes (the request hangs) the queue must not stay blocked
			const finish = function() {
				if (done) { return; }
				done = true;
				clearTimeout(timer);
				before.forEach(function(b) {
					$(b.cell).removeClass("sig-inline-saving");
					if (!saved && b.cell.isConnected) { b.cell.className = b.cls; b.cell.textContent = b.text; }
				});
				if (!saved) { Notify.trigger("Could not save the " + def.title.toLowerCase() + " change", "red"); }
				resolve(saved ? "saved" : "failed");
			};
			const success = function(data) {
				if (data && data.resultSet && data.resultSet[0] && data.resultSet[0].result == true) {
					saved = true;
					$("#undo").removeClass("disabled");
					if (systemID in tripwire.signatures.undo) {
						tripwire.signatures.undo[systemID].push(entry);
					} else {
						tripwire.signatures.undo[systemID] = [entry];
					}
					try { sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo)); } catch (e) { /* storage unavailable */ }
				}
			};
			timer = setTimeout(finish, sigInline.SAVE_TIMEOUT_MS);
			tripwire.refresh("refresh", payload, success, finish);
		});
	},

	/** The table cells showing a field of a wormhole (one per signature row in the viewed system) */
	cellsFor: function(wormhole, field) {
		const column = sigInline.FIELDS[field].column;
		return [wormhole.initialID, wormhole.secondaryID].map(function(id) {
			return document.querySelector("#sigTable tbody tr[data-id='" + id + "'] td:nth-child(" + column + ")");
		}).filter(function(c, i, all) { return c && all.indexOf(c) === i; });
	},

	// ---- Popover ----

	keepSelected: null,	// rows selected when a save started: re-selected when the refresh re-renders them

	pop: null,	// {el, field, sigID, value, prevFocus}

	isOpen: function() { return !!sigInline.pop; },

	open: function(cell) {
		const row = cell.closest("tr");
		const field = sigInline.fieldForColumn(Array.prototype.indexOf.call(row.children, cell) + 1);
		if (!field || !row.dataset.id || row.hasAttribute("disabled")) { return false; }
		const wh = sigInline.findWormhole(tripwire.client.wormholes, row.dataset.id);
		if (!wh) { return false; }
		const prevFocus = sigInline.pop ? sigInline.pop.prevFocus : document.activeElement;
		sigInline.close(true);

		const def = sigInline.FIELDS[field];
		const el = document.createElement("div");
		el.className = "sig-inline-pop";
		el.setAttribute("role", "listbox");
		el.setAttribute("aria-label", def.title);
		let html = "<span class='sig-inline-title'>" + def.title + "</span>";
		const value = sigInline.valueOf(wh, field);
		sigInline.choices(field).forEach(function(c) {
			html += "<button type='button' role='option' class='" + sigInline.cellClass(field, c.value) + "' data-value='" + c.value + "' aria-selected='" + (value === c.value) + "'>"
				+ "<kbd>" + c.key + "</kbd>" + c.label + "</button>";
		});
		html += "<span class='sig-inline-note' role='status' aria-live='polite'></span>";
		el.innerHTML = html;
		// Clicks inside must not reach upstream's "click outside the table clears the selection" handler
		el.addEventListener("focusout", function(e) {
			if (e.relatedTarget && !el.contains(e.relatedTarget)) { sigInline.close(true); }
		});
		el.addEventListener("click", function(e) {
			e.stopPropagation();
			const btn = e.target.closest("button[data-value]");
			if (btn) { sigInline.pick(btn.getAttribute("data-value")); }
		});
		document.body.appendChild(el);
		sigInline.pop = { el: el, field: field, sigID: row.dataset.id, wormholeID: wh.id, value: value, snap: sigInline.snapshot(wh, field), prevFocus: prevFocus };
		sigInline.place(cell);
		const current = el.querySelector("button[aria-selected='true']") || el.querySelector("button");
		if (current) { current.focus(); }

		tripwire.activity = tripwire.activity || {};
		tripwire.activity.editSig = row.dataset.id;
		// The widget can be dragged or resized (gridster) while the popover is open: follow the cell
		sigInline.pop.timer = setInterval(sigInline.onRowsChanged, 200);
		return true;
	},

	/** Put the popover under a cell, kept inside the window */
	place: function(cell) {
		const p = sigInline.pop;
		if (!p) { return; }
		const r = cell.getBoundingClientRect();
		const w = p.el.offsetWidth;
		p.el.style.top = Math.round(r.bottom + 2) + "px";
		p.el.style.left = Math.round(Math.max(4, Math.min(r.left, window.innerWidth - w - 4))) + "px";
	},

	close: function(keepFocus) {
		const p = sigInline.pop;
		if (!p) { return; }
		sigInline.pop = null;
		clearInterval(p.timer);
		p.el.remove();
		if (tripwire.activity && String(tripwire.activity.editSig) === String(p.sigID)) { delete tripwire.activity.editSig; }
		if (!keepFocus && p.prevFocus && p.prevFocus.isConnected && typeof p.prevFocus.focus === "function") { p.prevFocus.focus(); }
	},

	pick: function(value) {
		const p = sigInline.pop;
		if (!p) { return; }
		const wormholeID = p.wormholeID, field = p.field;
		if (typeof forkUsage !== "undefined") { forkUsage.track("sigInline", "edited"); }
		sigInline.close();
		const change = {};
		change[field] = value;
		sigInline.setWormhole(wormholeID, change);
	},

	move: function(delta) {
		const p = sigInline.pop;
		if (!p) { return; }
		const buttons = Array.prototype.slice.call(p.el.querySelectorAll("button"));
		const index = Math.max(0, buttons.indexOf(document.activeElement));
		buttons[sigInline.step(index, delta, buttons.length)].focus();
	},

	/** After upstream re-rendered the rows (the 10 s refresh replaces edited rows): follow the new cell,
	say so if somebody changed the value meanwhile, close if the row is gone. */
	onMutations: function(mutations) {
		const added = [];
		mutations.forEach(function(m) {
			Array.prototype.forEach.call(m.addedNodes || [], function(n) { if (n.dataset && n.dataset.id) { added.push(String(n.dataset.id)); } });
		});
		const ids = sigInline.idsToReselect(sigInline.keepSelected, added, Date.now());
		if (ids.length) {
			ids.forEach(function(id) { $("#sigTable tbody tr[data-id='" + id + "']").addClass("selected"); });
			sigInline.keepSelected = null;
			$("#signaturesWidget").trigger("selected:change");
		}
		sigInline.onRowsChanged();
	},

	onRowsChanged: function() {
		const p = sigInline.pop;
		if (!p) { return; }
		const row = document.querySelector("#sigTable tbody tr[data-id='" + p.sigID + "']");
		const wh = tripwire.client.wormholes[p.wormholeID];
		const result = sigInline.reanchor({ field: p.field, value: p.value, snap: p.snap }, wh, !!row, wh ? { value: sigInline.valueOf(wh, p.field), snap: sigInline.snapshot(wh, p.field) } : null);
		if (result.action === "close") { sigInline.close(true); return; }
		const cell = row.children[sigInline.FIELDS[p.field].column - 1];
		if (!cell) { sigInline.close(true); return; }
		if (result.action === "changed") {
			p.value = result.value;
			p.snap = sigInline.snapshot(wh, p.field);
			Array.prototype.forEach.call(p.el.querySelectorAll("button"), function(b) {
				b.setAttribute("aria-selected", String(b.getAttribute("data-value") === result.value));
			});
			const note = p.el.querySelector(".sig-inline-note");
			const who = wh.modifiedByName || (tripwire.client.signatures[wh.initialID] || {}).modifiedByName;
			if (note) { note.textContent = "Changed by " + (who || "someone else"); }
		}
		sigInline.place(cell);
	},

	// ---- Wiring ----

	targetEditable: function(t) {
		return !!(t && t.closest && t.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
	},

	onKeydown: function(e) {
		if (!sigInline.enabled(options)) { return; }
		const p = sigInline.pop;
		const action = sigInline.keyAction({
			key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat,
			targetEditable: sigInline.targetEditable(e.target),
			dialogOpen: $(".ui-dialog:visible").not(".dialog-floating").length > 0,	// floating windows (floating-windows.js) stay open while you work
			selectedCount: document.querySelectorAll("#sigTable tbody tr.selected").length,
			popoverField: p ? p.field : null,
			focusOk: sigInline.focusOk(document.activeElement)
		});
		if (!action) { return; }
		if (action.type === "nav") {
			sigInline.moveSelection(action.delta);
		} else if (action.type === "edit") {
			const $edit = $("#edit-signature");
			const selected = document.querySelector("#sigTable tbody tr.selected");
			if ($edit.hasClass("disabled") || !selected || selected.querySelector(".sig-inline-saving")) { return; }	// disabled, or a life / mass save is still in flight
			$edit.trigger("click");
		} else if (action.type === "open") {
			const row = document.querySelector("#sigTable tbody tr.selected");
			const cell = row && row.children[sigInline.FIELDS[action.field].column - 1];
			if (!cell || !sigInline.open(cell)) { return; }
		} else if (action.type === "pick") {
			sigInline.pick(action.value);
		} else if (action.type === "move") {
			sigInline.move(action.delta);
		} else {
			sigInline.close();
		}
		e.preventDefault();
		e.stopPropagation();
	},

	/** Select the row above / below the selected one (the page does not scroll); stays on the first / last row */
	moveSelection: function(delta) {
		const rows = Array.prototype.slice.call(document.querySelectorAll("#sigTable tbody tr"));
		const current = document.querySelector("#sigTable tbody tr.selected");
		const to = sigInline.neighbour(rows.indexOf(current), delta, rows.length);
		if (to < 0 || rows[to] === current) { return; }
		$(current).removeClass("selected");
		$(rows[to]).addClass("selected");
		if (rows[to].scrollIntoView) { rows[to].scrollIntoView({ block: "nearest" }); }
	},

	onCellClick: function(e) {
		if (!sigInline.enabled(options) || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) { return; }
		const cell = e.currentTarget;
		if (sigInline.pop) {
			// A second click on the cell that has the popover closes it
			const field = sigInline.fieldForColumn(Array.prototype.indexOf.call(cell.parentNode.children, cell) + 1);
			if (cell.parentNode.dataset.id === sigInline.pop.sigID && field === sigInline.pop.field) { sigInline.close(); return; }
		}
		sigInline.open(cell);
	},

	setupSettings: function() {
		// Settings > Signatures row; takes effect on Save (Reset = on)
		forkSettings.register({
			section: "signatures", order: 45, id: "sigInline-enabled", type: "checkbox", key: "sigInline",
			label: "Edit life and mass in place:", text: "Click the Life or Mass cell, or press L / M on a selected row; up / down move the selection, Enter edits the row",
			get: function(o) { return sigInline.enabled(o); },
			set: function(o, on) { o.sigInline = { enabled: on }; }
		});
		// options.apply() runs on Save and Reset
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.sigInlineWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				sigInline.syncBody();
				return result;
			};
			options.apply.sigInlineWrapped = true;
		}
	},

	/** body.sig-inline-on shows the pointer cursor and hover underline on the editable cells */
	syncBody: function() {
		const on = sigInline.enabled(options);
		document.body.classList.toggle("sig-inline-on", on);
		if (!on) { sigInline.close(true); }
	},

	/** Command palette (Ctrl+K): "Set life <hole> <stable|EOL>" (with life states: <stable|4h|1h|expired>) and "Set mass <hole> <stable|destab|critical>" (undoable, like the cell popover) */
	registerCommands: function() {
		if (typeof forkCommands === "undefined") { return; }
		["life", "mass"].forEach(function(field) {
			forkCommands.register({
				id: "hole.set" + field.charAt(0).toUpperCase() + field.substring(1), title: "Set " + field, group: "Holes", icon: "edit", keywords: field === "life" ? ["eol", "end of life", "stable", "hole", "4h", "1h", "expired"] : ["destab", "critical", "stable", "hole", "mass"],
				enabled: function(ctx) { return ctx.holes().length ? true : "No wormholes on the chain map"; },
				args: [
					{ name: "hole", label: "hole", type: "hole" },
					{ name: field, label: field, type: "choice", choices: function() {
						return sigInline.choices(field).map(function(c) { return { value: c.value, title: c.label, keys: c.keys || [c.value] }; });
					} }
				],
				run: function(args) {
					const change = {};
					change[field] = args[field];
					return sigInline.setWormhole(args.hole, change);
				}
			});
		});
	},

	// ---- Tip (hints.js): after the user changed a hole's life or mass in the Edit signature dialog ----

	dialogEdit: null,	// {sigID}: life / mass changed by the user since the Edit signature dialog opened (null: not)
	lastEdit: null,		// the last such change (the tip's "Show me" opens that row's Mass cell)

	/** The dialog close a tip follows: the Edit signature dialog, after a life or mass change in it */
	tipEligible: function(data, dialogEdit, opts) {
		return !!data && data.id === "dialog-signature" && !!dialogEdit && sigInline.enabled(opts);
	},

	/** "Show me": the Mass popover on the edited row, else on the first wormhole row */
	showFromTip: function() {
		const id = sigInline.lastEdit && sigInline.lastEdit.sigID;
		const rows = $("#sigTable tbody tr[data-id]:visible").filter(function() { return !!sigInline.findWormhole(tripwire.client.wormholes, this.dataset.id); });
		const row = (id ? rows.filter("[data-id='" + String(id).replace(/[^0-9A-Za-z_-]/g, "") + "']")[0] : null) || rows[0];
		const cell = row ? row.children[sigInline.FIELDS.mass.column - 1] : null;
		if (cell) { sigInline.open(cell); }
	},

	setupTip: function() {
		$(document).on("dialogopen", "#dialog-signature", function() { sigInline.dialogEdit = null; });
		$(document).on("change", "#dialog-signature [name='wormholeLife'], #dialog-signature [name='wormholeMass']", function(e) {
			if (!e.originalEvent) { return; }	// the dialog filling itself in, not the user
			if (typeof sigDialogVM === "undefined" || sigDialogVM.mode !== "update") { return; }
			sigInline.dialogEdit = sigInline.lastEdit = { sigID: $("#dialog-signature").data("signatureid") || null };
		});
		if (typeof forkHints === "undefined") { return; }
		forkHints.register({
			id: "sigInline.dialog", feature: "sigInline", section: "signatures",
			trigger: "dialog.close", kind: "toast",
			eligible: function(ctx, data) { return sigInline.tipEligible(data, sigInline.dialogEdit, ctx.options); },
			title: "Life and mass without the dialog",
			body: "Next time, click the Life or Mass cell of the hole in the signature list (or select the row and press L or M) "
				+ "and pick the new value.\n\nTurn tips off in Settings > General.",
			action: { label: "Show me", run: function() { sigInline.showFromTip(); } },
			priority: 60, maxShows: 2, cooldownHours: 72, ttlSeconds: 300
		});
	},

	init: function() {
		sigInline.registerCommands();
		sigInline.setupSettings();
		sigInline.setupTip();
		sigInline.syncBody();
		document.addEventListener("keydown", sigInline.onKeydown, true);
		// Delegated on the cells of the Life (5) and Mass (6) columns; non-wormhole rows have no such cells
		$("#sigTable tbody").on("click", "td:nth-child(5), td:nth-child(6)", sigInline.onCellClick);
		// A double click opens upstream's dialog; its own handler (on the row) runs unchanged
		$("#sigTable tbody").on("dblclick", "td:nth-child(5), td:nth-child(6)", function() { sigInline.close(true); });
		document.addEventListener("mousedown", function(e) {
			if (sigInline.pop && !sigInline.pop.el.contains(e.target) && !e.target.closest("#sigTable tbody td:nth-child(5), #sigTable tbody td:nth-child(6)")) { sigInline.close(true); }
		}, true);
		// Any click means the user chose a selection of their own
		document.addEventListener("click", function() { sigInline.keepSelected = null; }, true);
		// Scrolling (capture: scroll events do not bubble) would leave the popover behind its cell
		document.addEventListener("scroll", function(e) {
			if (sigInline.pop && !sigInline.pop.el.contains(e.target)) { sigInline.close(true); }
		}, true);
		window.addEventListener("resize", function() { sigInline.onRowsChanged(); });
		const tbody = document.querySelector("#sigTable > tbody");
		if (tbody && typeof MutationObserver !== "undefined") {
			new MutationObserver(sigInline.onMutations).observe(tbody, { childList: true });
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { sigInline.init(); });
}
