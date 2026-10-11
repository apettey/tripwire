const sigInline = {
	// Inline life / mass edits on the signature table (fork-owned): click the Life or Mass cell of a wormhole row
	// (or press L / M with one row selected) and pick a value, instead of opening the edit dialog.
	// Double-click still opens the dialog. Only the changed field is sent (the dialog sends everything), and the
	// change is pushed on the same undo stack as the dialog's, so Ctrl+Z restores it.
	// sigInline.setWormhole(wormholeID, {life|mass: value}) is the save path; the command palette reuses it.
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

	KEY_FIELD: { l: "life", m: "mass" },

	// ---- Pure logic (unit-tested) ----

	enabled: function(o) {
		return !(o && o.sigInline && o.sigInline.enabled === false);
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
		const def = sigInline.FIELDS[field];
		if (!def) { return null; }
		return def.choices.filter(function(c) { return c.key === key; })[0] || null;
	},

	choiceFor: function(field, value) {
		const def = sigInline.FIELDS[field];
		if (!def) { return null; }
		return def.choices.filter(function(c) { return c.value === value; })[0] || null;
	},

	/** Text of the table cell for a value: what upstream renders (life: Stable / EOL, mass: the raw value) */
	cellText: function(field, value) {
		if (field === "life") { return { critical: "EOL", stable: "Stable" }[value] || value; }
		return value;
	},

	/** The wormhole a signature belongs to (wormholes: tripwire.client.wormholes), or undefined */
	findWormhole: function(wormholes, sigID) {
		return Object.values(wormholes || {}).filter(function(wh) {
			return String(wh.initialID) === String(sigID) || String(wh.secondaryID) === String(sigID);
		})[0];
	},

	/** Payload for tripwire.refresh: only the changed field, both signature ids (the server needs them).
	Null when nothing would change (unknown field/value, or the hole already has that value). */
	buildPayload: function(wormhole, field, value) {
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
		return { action: "update", signatures: [{ wormhole: copy(wormhole), signatures: [copy(sig1), copy(sig2)] }] };
	},

	/** What a key press means. state: {key, ctrlKey, metaKey, altKey, shiftKey, repeat, targetEditable, dialogOpen,
	selectedCount, popoverField (null = closed)}. Returns {type: "open", field} | {type: "pick", value} |
	{type: "move", delta} | {type: "close"} | null (leave the key alone). */
	keyAction: function(s) {
		if (s.ctrlKey || s.metaKey || s.altKey || s.repeat) { return null; }
		const key = String(s.key || "").toLowerCase();
		if (s.popoverField) {
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
		return field ? { type: "open", field: field } : null;
	},

	/** Next index of the focused chip (wraps) */
	step: function(index, delta, count) {
		return (((index + delta) % count) + count) % count;
	},

	/** What to do with an open popover after the table's rows were re-rendered (the 10 s refresh).
	prev: {field, value} shown in the popover; wormhole: the client's current wormhole (or undefined);
	rowExists: the row is still in the table. */
	reanchor: function(prev, wormhole, rowExists) {
		if (!rowExists || !wormhole) { return { action: "close" }; }
		if (wormhole[prev.field] !== prev.value) { return { action: "changed", value: wormhole[prev.field] }; }
		return { action: "keep" };
	},

	// ---- Save path ----

	/** Save a change to one wormhole: sigInline.setWormhole(wormholeID, {life: "critical"}) or {mass: "destab"}.
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
		const value = field ? change[field] : undefined;
		const wh = tripwire.client.wormholes[wormholeID];
		const payload = sigInline.buildPayload(wh, field, value);
		if (!payload) {
			if (wh && sigInline.choiceFor(field, value)) { return Promise.resolve("same"); }
			Notify.trigger("Could not save: that wormhole is no longer on the map", "red");
			return Promise.resolve("failed");
		}
		const s1 = tripwire.client.signatures[wh.initialID], s2 = tripwire.client.signatures[wh.secondaryID];
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
			$(c).removeClass("stable destab critical").addClass(value + " sig-inline-saving");
			c.textContent = sigInline.cellText(field, value);
		});

		return new Promise(function(resolve) {
			let saved = false;
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
			const always = function() {
				before.forEach(function(b) {
					$(b.cell).removeClass("sig-inline-saving");
					if (!saved && b.cell.isConnected) { b.cell.className = b.cls; b.cell.textContent = b.text; }
				});
				if (!saved) { Notify.trigger("Could not save the " + def.title.toLowerCase() + " change", "red"); }
				resolve(saved ? "saved" : "failed");
			};
			tripwire.refresh("refresh", payload, success, always);
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
		def.choices.forEach(function(c) {
			html += "<button type='button' role='option' class='" + c.value + "' data-value='" + c.value + "' aria-selected='" + (wh[field] === c.value) + "'>"
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
		sigInline.pop = { el: el, field: field, sigID: row.dataset.id, wormholeID: wh.id, value: wh[field], prevFocus: prevFocus };
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
	onRowsChanged: function() {
		const keep = sigInline.keepSelected;
		if (keep && Date.now() < keep.until && !document.querySelector("#sigTable tbody tr.selected")) {
			keep.ids.forEach(function(id) { $("#sigTable tbody tr[data-id='" + id + "']").addClass("selected"); });
			sigInline.keepSelected = null;
		}
		const p = sigInline.pop;
		if (!p) { return; }
		const row = document.querySelector("#sigTable tbody tr[data-id='" + p.sigID + "']");
		const wh = tripwire.client.wormholes[p.wormholeID];
		const result = sigInline.reanchor({ field: p.field, value: p.value }, wh, !!row);
		if (result.action === "close") { sigInline.close(true); return; }
		const cell = row.children[sigInline.FIELDS[p.field].column - 1];
		if (!cell) { sigInline.close(true); return; }
		if (result.action === "changed") {
			p.value = result.value;
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
			dialogOpen: $(".ui-dialog:visible").length > 0,
			selectedCount: document.querySelectorAll("#sigTable tbody tr.selected").length,
			popoverField: p ? p.field : null
		});
		if (!action) { return; }
		if (action.type === "open") {
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
			label: "Edit life and mass in place:", text: "Click the Life or Mass cell, or press L / M on a selected row",
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

	init: function() {
		sigInline.setupSettings();
		sigInline.syncBody();
		document.addEventListener("keydown", sigInline.onKeydown, true);
		// Delegated on the cells of the Life (5) and Mass (6) columns; non-wormhole rows have no such cells
		$("#sigTable tbody").on("click", "td:nth-child(5), td:nth-child(6)", sigInline.onCellClick);
		// A double click opens upstream's dialog; its own handler (on the row) runs unchanged
		$("#sigTable tbody").on("dblclick", "td:nth-child(5), td:nth-child(6)", function() { sigInline.close(true); });
		document.addEventListener("mousedown", function(e) {
			if (sigInline.pop && !sigInline.pop.el.contains(e.target) && !e.target.closest("#sigTable tbody td:nth-child(5), #sigTable tbody td:nth-child(6)")) { sigInline.close(true); }
		}, true);
		// Scrolling (capture: scroll events do not bubble) would leave the popover behind its cell
		document.addEventListener("scroll", function(e) {
			if (sigInline.pop && !sigInline.pop.el.contains(e.target)) { sigInline.close(true); }
		}, true);
		window.addEventListener("resize", function() { sigInline.onRowsChanged(); });
		const tbody = document.querySelector("#sigTable > tbody");
		if (tbody && typeof MutationObserver !== "undefined") {
			new MutationObserver(sigInline.onRowsChanged).observe(tbody, { childList: true });
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { sigInline.init(); });
}
