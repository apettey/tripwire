const pasteAnywhere = {
	// Paste probe-scanner results anywhere on the page, with a preview of what will change.
	// Parsing and applying stay upstream's (app/js/tripwire/paste.js: rowParse, parsePaste, removeMissing);
	// this file only works out the same add/update/delete decisions for display.
	// Settings: options.pasteAnywhere = {enabled, preview} (a missing key means on).
	// Keep `const pasteAnywhere` on the first line: the mocha include() helper turns it into a global.

	/** Paste scans when focus is not in an input field (options.pasteAnywhere.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.pasteAnywhere && opts.pasteAnywhere.enabled === false);
	},

	/** Preview changes before applying (options.pasteAnywhere.preview; on unless explicitly false) */
	previewEnabled: function(opts) {
		return !(opts && opts.pasteAnywhere && opts.pasteAnywhere.preview === false);
	},

	/** Whether a paste into this element belongs to the element (text fields, selects, rich text) */
	isEditable: function(el) {
		if (!el) { return false; }
		const tag = (el.tagName || '').toUpperCase();
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { return true; }
		return !!el.isContentEditable;
	},

	/** Parse pasted text into scanner rows using upstream's row parser; lines that aren't scanner rows are dropped */
	parseRows: function(text, rowParse) {
		if (typeof text !== 'string' || !text || typeof rowParse !== 'function') { return []; }
		return text.split("\n").map(line => rowParse(line.replace(/\r$/, ''))).filter(row => row && row.id && row.id.length === 2);
	},

	/** 'abc123' -> 'ABC-123' */
	formatID: function(signatureID) {
		const id = String(signatureID || '').toUpperCase();
		return /^[A-Z]{3}\d{3}$/.test(id) ? id.substr(0, 3) + '-' + id.substr(3) : id;
	},

	/** The wormhole a signature belongs to, or {} */
	wormholeFor: function(signature, wormholes) {
		return Object.values(wormholes || {}).find(wh => wh && (wh.initialID == signature.id || wh.secondaryID == signature.id)) || {};
	},

	/** Work out what pasting these rows into the system would do, following upstream's rules:
	- unknown ID: add
	- known non-wormhole: becomes a wormhole if the paste says so, otherwise updated when the paste has a different
	  type or a (non-empty) different name; wormholes are never changed
	- signatures in the system missing from the paste (not '???', not gates): delete candidates
	@param rows parsed scanner rows ({id: ['ABC', '123'], type, name, scanGroup})
	@param signatures tripwire.client.signatures, wormholes tripwire.client.wormholes
	@return {systemID, add: [{id, type, name}], update: [{id, signature, changes: [{field, from, to}]}],
	         remove: [{id, signature, wormhole}], unchanged: [{id, signature}]} */
	diff: function(rows, signatures, wormholes, systemID) {
		const result = { systemID: systemID, add: [], update: [], remove: [], unchanged: [] };
		const inSystem = Object.values(signatures || {}).filter(s => s && s.systemID == systemID && s.signatureID);
		const seen = {};

		(rows || []).forEach(row => {
			const id = (row.id[0] + row.id[1]).toUpperCase();
			if (seen[id]) { return; }
			seen[id] = true;
			const signature = inSystem.find(s => s.signatureID.toUpperCase() === id);

			if (!signature) {
				const type = row.type ? row.type.toLowerCase() : 'unknown';
				// upstream stores no name for a new wormhole
				result.add.push({ id: id, type: type, name: type === 'wormhole' ? '' : (row.name || '') });
				return;
			}

			const changes = [];
			if (row.type === 'Wormhole' && signature.type !== 'wormhole') {
				changes.push({ field: 'type', from: signature.type, to: 'wormhole' });
			} else if (signature.type !== 'wormhole' && ((row.type && row.type.toLowerCase() !== signature.type) || (row.name && row.name !== signature.name))) {
				const type = row.type ? row.type.toLowerCase() : 'unknown';
				if (type !== signature.type) { changes.push({ field: 'type', from: signature.type, to: type }); }
				if (row.name && row.name !== signature.name) { changes.push({ field: 'name', from: signature.name || '', to: row.name }); }
			}

			if (changes.length) {
				result.update.push({ id: id, signature: signature, changes: changes });
			} else {
				result.unchanged.push({ id: id, signature: signature });
			}
		});

		inSystem.forEach(signature => {
			const id = signature.signatureID.toUpperCase();
			if (seen[id] || signature.signatureID === '???') { return; }
			if (signature.type === 'wormhole') {
				const wormhole = pasteAnywhere.wormholeFor(signature, wormholes);
				if (wormhole.type === 'GATE') { return; }
				result.remove.push({ id: id, signature: signature, wormhole: wormhole });
			} else {
				result.remove.push({ id: id, signature: signature, wormhole: null });
			}
		});

		return result;
	},

	/** Whether applying the paste would change anything (adds/updates, or deletions when asked for) */
	hasChanges: function(diff, includeRemovals) {
		return !!(diff && (diff.add.length || diff.update.length || (includeRemovals && diff.remove.length)));
	},

	escape: function(text) {
		return String(text === undefined || text === null ? '' : text)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	},

	/** 'relic' -> 'Relic'; a wormhole with a known type -> 'Wormhole H296' */
	typeLabel: function(type, wormholeType) {
		const t = String(type || 'unknown');
		const label = t.charAt(0).toUpperCase() + t.slice(1);
		return wormholeType ? label + ' ' + wormholeType : label;
	},

	/** Wormhole type shown for a wormhole signature: its own side's type (the far side of a typed hole is a K162) */
	wormholeTypeOf: function(signature, wormhole) {
		if (!wormhole || !wormhole.type) { return ''; }
		if (wormhole.type === 'GATE') { return ''; }
		return wormhole.initialID == signature.id ? wormhole.type : 'K162';
	},

	/** Preview dialog body. All pasted and stored text is escaped. */
	renderHTML: function(diff, deleteChecked) {
		const e = pasteAnywhere.escape;
		const fmt = pasteAnywhere.formatID;
		const parts = [];
		const counts = [];
		if (diff.add.length) { counts.push(diff.add.length + ' new'); }
		if (diff.update.length) { counts.push(diff.update.length + ' changed'); }
		if (diff.unchanged.length) { counts.push(diff.unchanged.length + ' unchanged'); }
		parts.push("<p class='pa-summary'>" + e(counts.join(', ') || 'No signatures in the paste') + '.</p>');

		const rows = [];
		diff.add.forEach(a => {
			rows.push("<tr class='pa-add'><td class='pa-badge'>Add</td><td class='pa-id'>" + e(fmt(a.id)) + '</td><td>' +
				e(pasteAnywhere.typeLabel(a.type)) + '</td><td>' + e(a.name) + '</td></tr>');
		});
		diff.update.forEach(u => {
			const what = u.changes.map(c => c.field === 'type'
				? e(pasteAnywhere.typeLabel(c.from)) + ' &rarr; ' + e(pasteAnywhere.typeLabel(c.to))
				: "<span class='pa-old'>" + e(c.from || '(no name)') + '</span> &rarr; ' + e(c.to));
			rows.push("<tr class='pa-update'><td class='pa-badge'>Update</td><td class='pa-id'>" + e(fmt(u.id)) +
				"</td><td colspan='2'>" + what.join('<br/>') + '</td></tr>');
		});
		diff.remove.forEach(r => {
			const whType = pasteAnywhere.wormholeTypeOf(r.signature, r.wormhole);
			rows.push("<tr class='pa-remove" + (deleteChecked ? '' : ' pa-off') + "'><td class='pa-badge'>Delete</td><td class='pa-id'>" +
				e(fmt(r.id)) + '</td><td>' + e(pasteAnywhere.typeLabel(r.signature.type, whType)) + '</td><td>' +
				e(r.signature.name || '') + '</td></tr>');
		});
		if (rows.length) { parts.push("<table class='pa-table'><tbody>" + rows.join('') + '</tbody></table>'); }

		if (diff.remove.length) {
			parts.push("<label class='pa-delete'><input type='checkbox' id='pasteAnywhere-delete'" + (deleteChecked ? " checked='checked'" : '') +
				' /> Delete ' + diff.remove.length + ' signature' + (diff.remove.length === 1 ? '' : 's') + ' not in the paste</label>');
		}
		return parts.join('');
	},

	/** Short notice after applying */
	summary: function(diff, includeRemovals) {
		const parts = [];
		if (diff.add.length) { parts.push(diff.add.length + ' added'); }
		if (diff.update.length) { parts.push(diff.update.length + ' updated'); }
		if (includeRemovals && diff.remove.length) { parts.push(diff.remove.length + ' deleted'); }
		return parts.length ? 'Signatures ' + parts.join(', ') : 'No signature changes';
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	(function() {
		const pa = pasteAnywhere;
		let pending = null;	// {text, diff}

		function upstream() {
			return typeof tripwire !== "undefined" && tripwire.pasteSignatures && tripwire.pasteSignatures.rowParse ? tripwire.pasteSignatures : null;
		}

		function currentDiff(rows) {
			return pa.diff(rows, tripwire.client.signatures, tripwire.client.wormholes, viewingSystemID);
		}

		// Same as upstream's paste handler: notice with the "delete missing sigs" link, then import
		function applyDirect(text) {
			Notify.trigger("Paste detected<br/>(<a id='fullPaste' href=''>Click to delete missing sigs</a>)");
			$("#fullPaste").data("paste", text);
			upstream().parsePaste(text);
		}

		function apply() {
			const $dialog = $("#dialog-pasteAnywhere");
			if (!pending) { $dialog.dialog("close"); return; }
			const p = pending;
			pending = null;
			$dialog.dialog("close");
			if (p.diff.systemID != viewingSystemID) { return; }	// moved on to another system meanwhile
			const removals = p.diff.remove.length > 0 && $("#pasteAnywhere-delete").prop("checked");
			if (removals) { upstream().removeMissing(p.text); }
			if (p.diff.add.length || p.diff.update.length) { upstream().parsePaste(p.text); }
			Notify.trigger(pa.escape(pa.summary(p.diff, removals)));
		}

		function dialog() {
			let $dialog = $("#dialog-pasteAnywhere");
			if (!$dialog.length) {
				$dialog = $("<div id='dialog-pasteAnywhere' class='hidden'></div>").appendTo("body");
			}
			if (!$dialog.hasClass("ui-dialog-content")) {
				$dialog.dialog({
					autoOpen: false,
					title: "Paste signatures",
					resizable: false,
					modal: true,
					width: 520,
					maxHeight: Math.max(300, Math.round($(window).height() * 0.8)),
					dialogClass: "dialog-noeffect ui-dialog-shadow dialog-pasteAnywhere",
					buttons: {
						Apply: apply,
						Cancel: function() { $(this).dialog("close"); }
					},
					open: function() {
						$(this).closest(".ui-dialog").find(".ui-dialog-buttonpane button").first().focus();
					},
					close: function() { pending = null; }
				});
				// Enter applies (except on a button, which does its own thing)
				$dialog.closest(".ui-dialog").on("keydown", function(e) {
					if (e.key !== "Enter" || $(e.target).is("button")) { return; }
					e.preventDefault();
					apply();
				});
				$dialog.on("change", "#pasteAnywhere-delete", function() {
					$dialog.find("tr.pa-remove").toggleClass("pa-off", !this.checked);
				});
			}
			return $dialog;
		}

		function preview(text, rows) {
			const diff = currentDiff(rows);
			if (!pa.hasChanges(diff, true)) {
				Notify.trigger("Paste detected: signatures already up to date");
				return;
			}
			pending = { text: text, diff: diff };
			const $dialog = dialog();
			$dialog.html(pa.renderHTML(diff, false));
			if (!$dialog.dialog("isOpen")) { $dialog.dialog("open"); }
		}

		// Capture phase: runs before upstream's handler on #clipboard (which Ctrl+V focuses) and also sees
		// pastes on the page itself (Shift+Insert, browser Edit menu) that upstream never receives.
		document.addEventListener("paste", function(e) {
			const up = upstream();
			if (!up || typeof options === "undefined" || typeof viewingSystemID === "undefined") { return; }
			const target = e.target && e.target.nodeType === 1 ? e.target : document.activeElement;
			const viaClipboard = !!(target && target.id === "clipboard");
			if (!viaClipboard && pa.isEditable(target)) { return; }
			// Inside another dialog (e.g. Add Signature) a paste is not meant as a scan; inside ours it replaces the preview
			const $inDialog = $(target).closest(".ui-dialog");
			if (!viaClipboard && $inDialog.length && !$inDialog.find("#dialog-pasteAnywhere").length) { return; }

			const anywhere = pa.enabled(options);
			const withPreview = pa.previewEnabled(options);
			if (viaClipboard && !withPreview) { return; }	// upstream as before
			if (!viaClipboard && !anywhere) { return; }

			const data = window.clipboardData || (e.clipboardData);
			const text = data ? data.getData(window.clipboardData ? "Text" : "text/plain") : "";
			const rows = pa.parseRows(text, up.rowParse);

			e.preventDefault();
			e.stopImmediatePropagation();
			if (viaClipboard) { $("#clipboard").blur(); }
			if (!rows.length) { return; }	// not scanner output: ignore

			if (withPreview) { preview(text, rows); } else { applyDirect(text); }
		}, true);

		$(function() {
			// Settings > General Preferences, below "Signature paste default life". Applied on Save like its neighbours.
			const $after = $("#dialog-options #pasteLife").closest("tr");
			if ($after.length && !$("#pasteAnywhere-enabled").length) {
				$after.after("<tr><th>Signature paste:</th><td>" +
					"<label><input type='checkbox' id='pasteAnywhere-enabled' /> Paste scans anywhere on the page</label><br/>" +
					"<label><input type='checkbox' id='pasteAnywhere-preview' /> Preview changes before applying</label></td></tr>");
			}
			$(document).on("dialogopen", "#dialog-options", function() {
				$("#pasteAnywhere-enabled").prop("checked", pa.enabled(options));
				$("#pasteAnywhere-preview").prop("checked", pa.previewEnabled(options));
			});
			// Capture phase so the value is in place before upstream's Save handler saves options
			document.addEventListener("click", function(e) {
				const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
				if (!button || $.trim($(button).text()) !== "Save") { return; }
				if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#pasteAnywhere-enabled").length) { return; }
				options.pasteAnywhere = { enabled: $("#pasteAnywhere-enabled").prop("checked"), preview: $("#pasteAnywhere-preview").prop("checked") };
			}, true);

			// Settings > Reset: back to defaults (a missing key means on)
			if (typeof options !== "undefined" && typeof options.reset === "function" && !options.reset.pasteAnywhereWrapped) {
				const reset = options.reset;
				const wrapped = function() {
					const result = reset.apply(this, arguments);
					delete this.pasteAnywhere;
					return result;
				};
				Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
				wrapped.pasteAnywhereWrapped = true;
				options.reset = wrapped;
			}
		});
	})();
}
