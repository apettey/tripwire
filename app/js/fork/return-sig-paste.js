const returnSigPaste = {
	// Fork-owned: "Return hole on paste". Right after you jump through a wormhole you land within ~100 km of the hole you
	// came through. So when you paste the probe scanner right after a wormhole jump and exactly one NEW wormhole signature
	// is within 100 km, it is the return hole: the paste links it to the jump instead of adding a loose hole, and opens its
	// Edit Signature dialog to fill in. Opt-in (Settings > Signatures, options.returnSigPaste = {enabled: true}; missing = off).
	//  - The automapper already mapped the jump (one hole between the two systems whose side here has no signature ID): the
	//    pasted signature ID goes onto that side instead of a new hole being added (merged).
	//  - Otherwise the new hole is added as usual, with its far side already set to the system you came from (linked).
	// Only for the tracked character's own jump into the viewed system in the last 10 minutes, while still there, once per jump.
	// Hooked from outside paste.js: tripwire.pasteSignatures.parsePaste is wrapped and, for that one synchronous call,
	// tripwire.refresh too, so the paste's payload is adjusted before it is sent (paste.js itself is unchanged).
	// Keep `const returnSigPaste` on the first line: the test helper strips it to define a global.
	RECENT_MS: 600000,	// a jump this recent counts
	MAX_KM: 100,
	AU_KM: 149597870.7,
	OPEN_TIMEOUT_MS: 5000,
	OPEN_POLL_MS: 250,
	// The "Wormhole" type word in the probe scanner's six languages (paste.js's validTypes)
	WORMHOLE_WORDS: ["Wormhole", "Trou de ver", "Wurmloch", "ワームホール", "웜홀", "Червоточина"],

	/** The per-user setting: on only when options.returnSigPaste.enabled is true (opt-in) */
	enabled: function(opts) {
		return !!(opts && opts.returnSigPaste && opts.returnSigPaste.enabled === true);
	},

	/** A probe scanner distance ("2.566 m", "7,28 AU", "12 345 km", "1,5 км", "3 а.е.") in km, or null.
		m / km: a separator followed by exactly 3 digits groups thousands, any other is the decimal point. AU: the last
		separator is the decimal point. Spaces (also no-break and narrow no-break) group thousands. */
	parseDistanceKm: function(text) {
		const s = String(text === undefined || text === null ? "" : text).replace(/[\s  ]+/g, " ").trim();
		const m = /^(\d[\d .,]*?)\s*(km|m|au|ua|ae|а\.е\.|км|м)$/i.exec(s);
		if (!m) { return null; }
		const unit = m[2].toLowerCase();
		const au = unit === "au" || unit === "ua" || unit === "ae" || unit === "а.е.";
		const digits = m[1].replace(/ /g, "");
		if (!/^\d+([.,]\d+)*$/.test(digits)) { return null; }
		const groups = digits.split(/[.,]/);
		let whole = groups[0], fraction = "";
		for (let i = 1; i < groups.length; i++) {
			const last = i === groups.length - 1;
			const decimal = au ? last : groups[i].length !== 3;
			if (decimal) {
				if (!last) { return null; }	// a decimal point must be the last separator
				fraction = groups[i];
			} else {
				whole += groups[i];
			}
		}
		const value = Number(whole + (fraction ? "." + fraction : ""));
		if (!isFinite(value)) { return null; }
		if (au) { return value * returnSigPaste.AU_KM; }
		return unit === "m" || unit === "м" ? value / 1000 : value;
	},

	/** One probe scanner row (tab separated) -> {id: "DPF143", type: "Wormhole" | other type text | "", km: number | null},
		or null when it has no signature ID */
	parseRow: function(row) {
		const columns = String(row === undefined || row === null ? "" : row).split("\t").map(function(c) { return c.trim(); });
		let id = null, type = "", km = null;
		columns.forEach(function(c) {
			const idMatch = /^([A-Z]{3})-(\d{3})$/.exec(c);
			if (idMatch && id === null) { id = idMatch[1] + idMatch[2]; return; }
			if (returnSigPaste.WORMHOLE_WORDS.indexOf(c) >= 0) { type = "Wormhole"; return; }
			const d = returnSigPaste.parseDistanceKm(c);
			if (d !== null) { km = d; }
		});
		if (id === null) { return null; }
		return { id: id, type: type, km: km };
	},

	/** The one wormhole row within maxKm whose signature ID is not in existingIds; null when there are none or several.
		rows: the pasted text or an array of rows; existingIds: signature IDs already in this system (any case, dash or not). */
	candidate: function(rows, existingIds, maxKm) {
		const list = Array.isArray(rows) ? rows : String(rows === undefined || rows === null ? "" : rows).split(/\r?\n/);
		const known = {};
		(existingIds || []).forEach(function(id) {
			const key = String(id === undefined || id === null ? "" : id).replace(/-/g, "").toUpperCase();
			if (key) { known[key] = true; }
		});
		const limit = typeof maxKm === "number" ? maxKm : returnSigPaste.MAX_KM;
		const found = {};
		list.forEach(function(row) {
			const r = returnSigPaste.parseRow(row);
			if (r && r.type === "Wormhole" && r.km !== null && r.km <= limit && !known[r.id]) { found[r.id] = r; }
		});
		const ids = Object.keys(found);
		return ids.length === 1 ? found[ids[0]] : null;
	},

	/** Is this jump ({from, to, at}) recent enough, into the system being viewed, and is the character still there? */
	isRecent: function(jump, now, viewingSystemID, currentSystemID) {
		if (!jump || !jump.to || !jump.at) { return false; }
		const age = now - jump.at;
		return age >= 0 && age <= returnSigPaste.RECENT_MS && viewingSystemID == jump.to && currentSystemID == jump.to;
	},

	/** The automapper's hole of this jump to put the pasted ID on: the one hole between jump.from and jump.to whose side in
		jump.to has no signature ID. {wormhole, toSig, fromSig}, or null when there is none or more than one. */
	mergeTarget: function(jump, wormholes, signatures) {
		if (!jump || typeof jumpSigPrompt === "undefined") { return null; }
		const holes = jumpSigPrompt.holesBetween(jump.from, jump.to, wormholes, signatures)
			.filter(function(h) { return !jumpSigPrompt.hasId(h.toSig); });
		return holes.length === 1 ? { wormhole: holes[0].wormhole, toSig: holes[0].toSig, fromSig: holes[0].fromSig } : null;
	},

	/** What the paste does with the return hole: {mode: "merge", merge} (put the ID on the automapper's hole, see
		mergeTarget), {mode: "link"} (add it with its far side set to jump.from) or {mode: "none"} (leave the paste alone:
		a hole between the two systems already has an ID on this side, so the return hole is known, or the automapper's
		"Which Signature?" question is open and it will add its own hole). */
	plan: function(jump, wormholes, signatures, pickerOpen) {
		if (!jump || typeof jumpSigPrompt === "undefined") { return { mode: "none" }; }
		const merge = returnSigPaste.mergeTarget(jump, wormholes, signatures);
		if (merge) { return { mode: "merge", merge: merge }; }
		const known = jumpSigPrompt.holesBetween(jump.from, jump.to, wormholes, signatures)
			.some(function(h) { return jumpSigPrompt.hasId(h.toSig); });
		if (known || pickerOpen) { return { mode: "none" }; }
		return { mode: "link" };
	},

	/** Signature IDs already in the system */
	existingIds: function(systemID, signatures) {
		const out = [];
		Object.keys(signatures || {}).forEach(function(k) {
			const s = signatures[k];
			if (s && s.systemID == systemID && s.signatureID) { out.push(String(s.signatureID)); }
		});
		return out;
	},

	/** Index of the paste's add entry for the hole with this signature ID (payload.signatures.add), or -1 */
	addIndex: function(adds, id) {
		for (let i = 0; i < (adds || []).length; i++) {
			const a = adds[i];
			if (a && a.wormhole && Array.isArray(a.signatures) && a.signatures[0] &&
				String(a.signatures[0].signatureID || "").toUpperCase() === id) { return i; }
		}
		return -1;
	},

	/** Change the paste's payload in place. merge (from mergeTarget) given: the add entry goes, an update putting the ID on
		the hole's side here takes its place, and the undo item for it is returned. Else: the add stays, its far side set to
		jump.from. Returns {mode: "merged" | "linked", undo} or null when the payload has no add for this ID. */
	rewrite: function(payload, id, jump, merge) {
		const adds = payload && payload.signatures && payload.signatures.add;
		const i = returnSigPaste.addIndex(adds, id);
		if (i < 0) { return null; }
		if (merge) {
			adds.splice(i, 1);
			payload.signatures.update = payload.signatures.update || [];
			payload.signatures.update.push({
				wormhole: { id: merge.wormhole.id },
				signatures: [{ id: merge.toSig.id, signatureID: id }]
			});
			const copy = function(v) { return JSON.parse(JSON.stringify(v)); };
			return { mode: "merged", undo: { wormhole: copy(merge.wormhole), signatures: [copy(merge.toSig), copy(merge.fromSig)] } };
		}
		if (adds[i].signatures[1]) { adds[i].signatures[1].systemID = jump.from; }
		return { mode: "linked", undo: null };
	},

	/** Did the tracked character change (so a stored jump is someone else's)? */
	otherCharacter: function(prev, next, characterChange) {
		if (characterChange) { return true; }
		return !!(prev && next && prev.characterID && next.characterID && prev.characterID != next.characterID);
	},

	/** "DPF143" -> "DPF-143" */
	idText: function(id) {
		const s = String(id || "");
		return s.length === 6 ? s.substring(0, 3) + "-" + s.substring(3) : s;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined" || typeof tripwire.EVE !== "function" || typeof jumpReturn === "undefined" ||
			!tripwire.pasteSignatures || typeof tripwire.pasteSignatures.parsePaste !== "function") { return; }

		let jump = null;	// the last wormhole jump {from, to, at, used}
		let wouldFire = 0;	// when a paste last found a return hole while the feature was off (for the tip)

		function opts() { return typeof options !== "undefined" ? options : undefined; }
		function systemName(id) {
			try { return holeNaming.systemName(id) || String(id); } catch (e) { return String(id); }
		}

		/** Jumps through a stargate, from a station or in a pod are not wormhole jumps (as jump-sig-prompt.js checks) */
		function wormholeJump(from, to) {
			try {
				if (typeof tripwire.map !== "undefined" && tripwire.map.shortest && tripwire.map.shortest[from - 30000000] !== undefined &&
					tripwire.map.shortest[from - 30000000][to - 30000000] !== undefined) { return false; }
				const eve = tripwire.client && tripwire.client.EVE;
				if (eve && eve.stationID) { return false; }
				if (eve && eve.shipTypeID && [33328, 670].indexOf(parseInt(eve.shipTypeID, 10)) >= 0) { return false; }
			} catch (e) { /* assume it was a wormhole */ }
			return true;
		}

		const previousEVE = tripwire.EVE;
		tripwire.EVE = function(EVE, characterChange) {
			const prev = this.client && this.client.EVE ? { systemID: this.client.EVE.systemID, characterID: this.client.EVE.characterID } : null;
			const ret = previousEVE.apply(this, arguments);
			try {
				const j = jumpReturn.detectJump(prev, EVE || null, characterChange);
				if (j) { jump = wormholeJump(j.from, j.to) ? { from: j.from, to: j.to, at: Date.now(), used: false } : null; }
				else if (returnSigPaste.otherCharacter(prev, EVE || null, characterChange)) { jump = null; }	// never another character's jump
			} catch (e) {
				console.warn("return-sig-paste: jump detection failed", e);
			}
			return ret;
		};

		/** The return hole in this paste, if this paste is right after a jump: {jump, row} or null */
		function find(paste) {
			if (!jump || jump.used) { return null; }
			const current = tripwire.client && tripwire.client.EVE ? tripwire.client.EVE.systemID : null;
			if (!returnSigPaste.isRecent(jump, Date.now(), viewingSystemID, current)) { return null; }
			const row = returnSigPaste.candidate(paste, returnSigPaste.existingIds(viewingSystemID, tripwire.client.signatures), returnSigPaste.MAX_KM);
			return row ? { jump: jump, row: row } : null;
		}

		function openWhenListed(test, done) {
			const until = Date.now() + returnSigPaste.OPEN_TIMEOUT_MS;
			const tick = function() {
				const sig = test();
				const $row = sig ? $("#sigTable tbody tr[data-id='" + sig.id + "']") : $();
				if ($row.length) { $row.trigger("dblclick"); if (done) { done(sig); } return; }
				if (Date.now() < until) { setTimeout(tick, returnSigPaste.OPEN_POLL_MS); }
			};
			tick();
		}

		function saveUndo(item, pushedFrom) {
			const stack = tripwire.signatures.undo[viewingSystemID] = tripwire.signatures.undo[viewingSystemID] || [];
			const last = stack[stack.length - 1];
			// The paste's own update step (pushed by this paste) takes it in, so one Undo undoes the paste's updates
			if (stack.length > pushedFrom && last && last.action === "update") { last.signatures.push(item); }
			else { stack.push({ action: "update", signatures: [item] }); }
			$("#undo").removeClass("disabled");
			try { sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo)); } catch (e) { /* ignore */ }
		}

		const parsePaste = tripwire.pasteSignatures.parsePaste;
		const wrapped = function(paste) {
			let hit = null;
			try { hit = find(paste); } catch (e) { hit = null; console.warn("return-sig-paste: could not check the paste", e); }
			if (hit && !returnSigPaste.enabled(opts())) { wouldFire = Date.now(); hit = null; }
			if (!hit) { return parsePaste.apply(this, arguments); }

			const previousRefresh = tripwire.refresh;
			const intercept = function(mode, data, successCallback, alwaysCallback) {
				tripwire.refresh = previousRefresh;	// only the paste's own call
				let change = null;
				const systemID = viewingSystemID;
				const from = hit.jump.from;
				try {
					const pickerOpen = typeof automapState !== "undefined" && !!automapState.pendingDecision;
					const plan = returnSigPaste.plan(hit.jump, tripwire.client.wormholes, tripwire.client.signatures, pickerOpen);
					if (plan.mode !== "none") {
						change = returnSigPaste.rewrite(data, hit.row.id, hit.jump, plan.mode === "merge" ? plan.merge : null);
						if (change) { change.merge = plan.merge || null; }
					}
				} catch (e) { change = null; console.warn("return-sig-paste: could not link the hole", e); }
				if (!change) { return previousRefresh.apply(this, arguments); }
				hit.jump.used = true;
				const stackLength = (tripwire.signatures.undo[systemID] || []).length;
				const success = function(result) {
					const ret = successCallback ? successCallback.apply(this, arguments) : undefined;
					if (!(result && result.resultSet && result.resultSet[0] && result.resultSet[0].result == true)) { return ret; }
					try {
						if (change.undo) { saveUndo(change.undo, stackLength); }
						if (change.mode === "merged" && typeof jumpSigPrompt !== "undefined" && typeof jumpSigPrompt.hide === "function") { jumpSigPrompt.hide(); }
						if (typeof forkUsage !== "undefined") {
							if (change.mode === "merged") { forkUsage.track("returnSigPaste", "merged"); } else { forkUsage.track("returnSigPaste", "linked"); }
						}
						Notify.trigger(_.escape("Return hole " + returnSigPaste.idText(hit.row.id) + " linked to " + systemName(from) + " — fill in its type"), "green", 6000);
						if (viewingSystemID != systemID) { return ret; }
						openWhenListed(function() {
							if (change.mode === "merged") {
								const s = tripwire.client.signatures[change.merge.toSig.id];
								return s && String(s.signatureID || "").toUpperCase() === hit.row.id ? s : null;
							}
							return $.map(tripwire.client.signatures, function(s) {
								if (s && s.systemID == systemID && String(s.signatureID || "").toUpperCase() === hit.row.id) { return s; }
							})[0] || null;
						});
					} catch (e) { console.warn("return-sig-paste: after the paste", e); }
					return ret;
				};
				return previousRefresh.call(this, mode, data, success, alwaysCallback);
			};
			tripwire.refresh = intercept;
			try { return parsePaste.apply(this, arguments); } finally { if (tripwire.refresh === intercept) { tripwire.refresh = previousRefresh; } }
		};
		tripwire.pasteSignatures.parsePaste = wrapped;

		// ---- Settings > Signatures (opt-in: missing = off; takes effect on Save; Reset = off) ----
		forkSettings.register({
			section: "signatures", order: 22, id: "returnSigPaste-enabled", type: "checkbox", key: "returnSigPaste",
			label: "Return hole on paste:",
			text: "After a jump, open the new wormhole signature within 100 km of me when I paste (the hole I came through)",
			hint: "Only within 10 minutes of a wormhole jump: it goes onto the hole the automapper drew, or links to the system you came from.",
			keywords: ["return", "paste", "distance", "jump", "wormhole", "back", "probe scanner"],
			get: function(o) { return returnSigPaste.enabled(o); },
			set: function(o, on) { o.returnSigPaste = { enabled: !!on }; }
		});

		// ---- Tip: the paste right after a jump found the return hole, but the feature is off ----
		if (typeof forkHints !== "undefined") {
			forkHints.register({
				id: "returnSigPaste.paste", feature: "returnSigPaste", section: "signatures",
				trigger: "paste.sigs", kind: "toast",
				eligible: function(ctx) { return !returnSigPaste.enabled(ctx.options) && wouldFire > 0 && Date.now() - wouldFire < 5000; },
				title: "That new wormhole is the one you came through",
				body: "It is within 100 km right after your jump. Turn on Settings > Signatures > Return hole on paste and such a paste "
					+ "links it to your jump and opens it to fill in. Turn tips off in Settings > General.",
				action: { label: "Open Settings", run: function() {
					const row = document.getElementById("returnSigPaste-enabled");
					const tr = row && row.closest("tr");
					if (tr && typeof commandPalette !== "undefined" && typeof commandPalette.openSetting === "function") { commandPalette.openSetting(tr); }
					else { $("#settings").trigger("click"); }
				} },
				priority: 50, maxShows: 2, cooldownHours: 72, ttlSeconds: 600
			});
		}

		returnSigPaste.debug = { jump: function() { return jump; }, setJump: function(j) { jump = j; } };
	});
}
