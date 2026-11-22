const rageRolling = {
	// Fork-owned: "Rage rolling mode". While a group rolls its home static over and over, every roll leaves a new
	// wormhole signature to scan and fill in. With the mode on, Tripwire takes the new hole for the new static: after
	// this client's own save in a home system (a probe scanner paste, with or without the paste preview, or the Sig
	// dialog), each static slot that is empty gets the first new unknown wormhole of that same save: its type is set to
	// the static (so the far side's class is known) and it is named with the static's letter (Statics get the first
	// letters, hole-naming.js; the name only while "Suggest hole names" is on).
	//  - Home system: the root of one of the user's chain tabs, with at least one static (sigQuickPicks.staticsFor).
	//  - A slot's holder: a wormhole sig in the system with the static's type on its own side, or a sig of unknown type
	//    holding the static's reserved name (A for the first static; with "Statics get the first letters" off only the
	//    type counts). A K162 or another known type named A (old data) doesn't hold it. No holder: the slot is empty.
	//  - The static rolled: a probe scanner paste of this client whose scan doesn't have the holder's signature ID (and
	//    is a full scan: it has another sig that is already listed, or the holders are the only sigs with an ID) empties
	//    the slot. That paste's save then deletes the old static (it collapsed) and fills the slot in one request, which
	//    is one Undo step. So the usual flow works: roll, rescan, paste (the paste preview's auto-save keeps gone sigs,
	//    Apply may delete them; either way).
	//  - Candidates: the wormhole sigs a save of ours added or turned into wormholes, in the order they were sent (= paste
	//    order); only unnamed ones with no type on this side (not K162) and a far side that is still unknown. A candidate
	//    counts only at the check right after its own save, so a hole pasted while the old static was still in the scan
	//    is never filled later (it could be any K162 that came in meanwhile). The first candidate fills the first empty
	//    slot, the next one the second. When it is a guess (more new holes than empty slots, or other unknown holes
	//    listed in the system) the toast is yellow and says so.
	//  - Only the client that saved acts (its own candidates), so two clients never fight. A toast gives the hole's
	//    bookmark text.
	// The mode is per user and off by default (it guesses): the "Rage roll" chip in the Signatures panel's header (shown
	// in a home system with a static) or the command palette (Rage rolling on / off) switch it; it switches itself off
	// after MODE_MS. Stored in options.rageRollingMode = {on, since}; Settings > Wormhole Jumps & Mass "Rage rolling
	// button" (options.rageRolling.enabled, missing = on) hides the chip and the mode with it.
	// Keep `const rageRolling` on the first line: the test helper strips it to define a global.

	MODE_MS: 3 * 3600000,		// the mode switches itself off after 3 hours
	CANDIDATE_MS: 60000,		// safety: a candidate never outlives this (it is used or dropped at the first check)
	PENDING_MS: 15000,			// a candidate not in the list yet (an answer without the list) waits this long for it
	// Wait this long after our save before the fill: the server keeps modifiedTime to the second, and an edit in the same
	// second as the paste's add is never redrawn in the signature list (tripwire/parse.js compares modifiedTime)
	SETTLE_MS: 1200,
	SCAN_MS: 10 * 60000,		// a paste's scan waits this long for its save (the paste preview can wait for Apply)

	/** The feature (the chip and the mode) is available: options.rageRolling.enabled, missing = on */
	enabled: function(opts) {
		return !(opts && opts.rageRolling && opts.rageRolling.enabled === false);
	},

	/** The mode is on (and not older than MODE_MS) */
	isOn: function(opts, now) {
		if (!rageRolling.enabled(opts)) { return false; }
		const m = opts && opts.rageRollingMode;
		if (!m || m.on !== true) { return false; }
		const since = Number(m.since);
		return since > 0 && now - since >= 0 && now - since < rageRolling.MODE_MS;
	},

	/** Minutes left before the mode switches itself off (0 when off) */
	minutesLeft: function(opts, now) {
		if (!rageRolling.isOn(opts, now)) { return 0; }
		return Math.max(1, Math.ceil((Number(opts.rageRollingMode.since) + rageRolling.MODE_MS - now) / 60000));
	},

	/** System IDs that are home: the roots of the chain tabs (a tab may list several, comma separated; 0 = all k-space) */
	homeSystems: function(tabs) {
		const out = [];
		(Array.isArray(tabs) ? tabs : []).forEach(function(t) {
			String(t && t.systemID !== undefined && t.systemID !== null ? t.systemID : "").split(",").forEach(function(s) {
				s = s.trim();
				if (s !== "" && s !== "0" && out.indexOf(s) < 0) { out.push(s); }
			});
		});
		return out;
	},

	/** The wormhole a signature belongs to, or null */
	wormholeOf: function(sigID, wormholes) {
		const keys = Object.keys(wormholes || {});
		for (let i = 0; i < keys.length; i++) {
			const wh = wormholes[keys[i]];
			if (wh && (wh.initialID == sigID || wh.secondaryID == sigID)) { return wh; }
		}
		return null;
	},

	/** The wormhole type on this signature's own side: the type ("H296"), "K162", or "" when unknown (holeNaming.sideType) */
	sideType: function(sigID, wormhole) {
		return holeNaming.sideType(sigID, wormhole);
	},

	/** The far side's system is still unknown (a pasted hole has none) */
	farUnknown: function(other) {
		return !other || other.systemID === null || other.systemID === undefined || other.systemID === "";
	},

	/** Signature IDs in a probe scanner paste ("ABC-123" columns), lower case without the dash, in paste order */
	scanIDs: function(text) {
		const out = [];
		String(text === undefined || text === null ? "" : text).split(/\r?\n/).forEach(function(row) {
			row.split("\t").some(function(col) {
				const m = /^([A-Za-z]{3})-(\d{3})$/.exec(col.trim());
				if (m) { const id = (m[1] + m[2]).toLowerCase(); if (out.indexOf(id) < 0) { out.push(id); } return true; }
				return false;
			});
		});
		return out;
	},

	MAX_SCANS: 5,	// recent pastes kept for their saves

	/** Which recorded paste a save comes from: the newest scan of that system, younger than SCAN_MS, that has every new
		signature ID of the save (a paste's save only adds sigs of its own scan; a paste the preview refused, because
		one was open, doesn't have the open preview's new sigs). scans: [{systemID, ids, at}], oldest first. Returns its
		index or -1. */
	matchScan: function(scans, systemID, signatureIDs, now) {
		const ids = (signatureIDs || []).map(function(id) { return String(id).toLowerCase(); });
		if (!ids.length) { return -1; }
		for (let i = (scans || []).length - 1; i >= 0; i--) {
			const sc = scans[i];
			if (!sc || String(sc.systemID) !== String(systemID) || now - sc.at >= rageRolling.SCAN_MS) { continue; }
			if (ids.every(function(id) { return sc.ids.indexOf(id) >= 0; })) { return i; }
		}
		return -1;
	},

	/** A real signature ID ("abc123"), not "???" or empty */
	hasID: function(sig) {
		return !!sig && /^[a-z]{3}\d{3}$/i.test(String(sig.signatureID || ""));
	},

	/**
	 * Which new holes become which statics. args:
	 *   systemID, statics (types in data order), signatures, wormholes (tripwire.client's),
	 *   candidates: [{id} | {signatureID}] in the order they were saved,
	 *   staticFirst (Statics get the first letters), naming (Suggest hole names), table (appData.wormholes, optional),
	 *   skip: sig ids never to fill again (filled once already: an Undo of the fill must stay undone),
	 *   scanIDs: optional, the signature IDs of the probe scanner paste this save came from (scanIDs()): a slot holder
	 *     missing from a full scan collapsed, so its slot counts as empty and the fill replaces (deletes) it,
	 *   broken: wormhole ids marked broken (brokenHoles.ids, e.g. "Mark broken" in the paste preview): the user kept
	 *     that hole, so it is never taken for gone,
	 *   kept: sig ids the user kept in the paste preview (unticked Gone rows, "keep all"; pastePreview.lastKept): the
	 *     same (the preview's auto-save makes no choice, so it keeps nothing)
	 * Returns [{systemID, sig, other, wormhole, type, name, parent, replaces, among, others, slots}] (name null when naming
	 * is off; parent: the static's side, "initial" or "secondary"; replaces: [{sig, other, wormhole}] holders the fill
	 * deletes; among: eligible new holes, others: other unknown holes listed in the system, slots: empty slots), at most
	 * one per empty static slot.
	 */
	plan: function(args) {
		const a = args || {};
		const signatures = a.signatures || {};
		const wormholes = a.wormholes || {};
		const inSystem = Object.keys(signatures).map(function(k) { return signatures[k]; })
			.filter(function(s) { return s && s.systemID == a.systemID; });
		const local = inSystem.filter(function(s) { return s.type === "wormhole"; });
		const slots = holeNaming.staticSlots(a.statics, "", a.table);
		if (!slots.length || !local.length) { return []; }
		const typeOf = {};
		local.forEach(function(s) { typeOf[s.id] = rageRolling.sideType(s.id, rageRolling.wormholeOf(s.id, wormholes)); });
		const holders = function(slot) {
			return local.filter(function(s) {
				if (typeOf[s.id] === slot.type) { return true; }
				// The reserved name holds the slot only on a hole that may be the static (unknown type)
				return a.staticFirst && holeNaming.leadingToken(s.name) === slot.ch && typeOf[s.id] === "";
			});
		};
		const skipped = function(sig) { return (a.skip || []).some(function(id) { return id == sig.id; }); };
		// The candidates' sigs, in candidate order (each once)
		const mine = [];
		(a.candidates || []).forEach(function(c) {
			if (!c) { return; }
			const key = c.signatureID ? String(c.signatureID).toUpperCase() : null;
			const sig = local.filter(function(s) {
				return (c.id !== undefined && c.id !== null && s.id == c.id) || (key && String(s.signatureID || "").toUpperCase() === key);
			})[0];
			if (sig && mine.indexOf(sig) < 0) { mine.push(sig); }
		});

		// Holders missing from a full scan collapsed
		const scan = Array.isArray(a.scanIDs) ? a.scanIDs.map(function(id) { return String(id).toLowerCase(); }) : null;
		const inScan = function(sig) { return scan.indexOf(String(sig.signatureID || "").toLowerCase()) >= 0; };
		const allHolders = [];
		slots.forEach(function(slot) { holders(slot).forEach(function(h) { if (allHolders.indexOf(h) < 0) { allHolders.push(h); } }); });
		// A full scan: every other listed hole (not a holder, not one this save added) is in it, and at least half of all
		// other listed sigs; or the holders are the only sigs with an ID. A two-row paste of a busy system is not full.
		const before = inSystem.filter(function(s) { return rageRolling.hasID(s) && allHolders.indexOf(s) < 0 && mine.indexOf(s) < 0; });
		const full = !!scan && (!before.length || (before.filter(function(s) { return s.type === "wormhole"; }).every(inScan) &&
			before.filter(inScan).length * 2 >= before.length));
		const kept = (a.kept || []).map(String);
		const broken = (a.broken || []).map(String);
		const gone = function(h) {
			if (!full || !rageRolling.hasID(h) || inScan(h) || kept.indexOf(String(h.id)) >= 0) { return false; }	// kept in the paste preview
			const wh = rageRolling.wormholeOf(h.id, wormholes);
			return !(wh && broken.indexOf(String(wh.id)) >= 0);	// marked broken: kept on purpose
		};

		const empty = [];
		slots.forEach(function(slot) {
			const hs = holders(slot);
			if (hs.every(gone)) { empty.push({ slot: slot, replaces: hs }); }
		});
		if (!empty.length) { return []; }
		const replaced = [];
		empty.forEach(function(e) { e.replaces.forEach(function(h) { replaced.push(h); }); });

		/** An unnamed hole of unknown type whose far side is listed and still unknown */
		const unknownHole = function(sig) {
			const name = String(sig.name === undefined || sig.name === null ? "" : sig.name).trim();
			if (name !== "" || typeOf[sig.id] !== "") { return null; }	// named (also a return bookmark), K162 or a known type
			const wormhole = rageRolling.wormholeOf(sig.id, wormholes);
			if (!wormhole) { return null; }
			const otherID = wormhole.initialID == sig.id ? wormhole.secondaryID : wormhole.initialID;
			const other = signatures[otherID] || null;
			if (!other) { return null; }	// no far side in the list: nothing to update (and nothing to undo)
			if (!rageRolling.farUnknown(other) || holeNaming.leadingToken(other.name)) { return null; }
			return { sig: sig, other: other, wormhole: wormhole };
		};

		const seen = {};
		const picks = [];
		mine.forEach(function(sig) {
			seen[sig.id] = true;
			if (skipped(sig)) { return; }
			const hole = unknownHole(sig);
			if (hole) { picks.push(hole); }
		});
		// Other unknown holes already listed: the new one may not be the static (the toast says so)
		const others = local.filter(function(s) {
			return !seen[s.id] && !skipped(s) && replaced.indexOf(s) < 0 && !!unknownHole(s);
		}).length;

		const used = local.filter(function(s) { return replaced.indexOf(s) < 0; }).map(function(s) { return s.name; }).filter(Boolean);
		const reserved = slots.map(function(s) { return s.ch; });
		const fills = [];
		empty.forEach(function(e, i) {
			const pick = picks[i];
			if (!pick) { return; }
			let name = null;
			if (a.naming) {
				name = holeNaming.nextName("", used, holeNaming.sizeClass(e.slot.type, a.table),
					a.staticFirst ? { reserved: reserved, own: e.slot.ch } : null);
				if (name) { used.push(name); }
			}
			fills.push({ systemID: a.systemID, sig: pick.sig, other: pick.other, wormhole: pick.wormhole, type: e.slot.type, name: name,
				parent: pick.wormhole.initialID == pick.sig.id ? "initial" : "secondary",
				replaces: e.replaces.map(function(h) {
					const wormhole = rageRolling.wormholeOf(h.id, wormholes);
					const otherID = wormhole ? (wormhole.initialID == h.id ? wormhole.secondaryID : wormhole.initialID) : null;
					return { sig: h, other: otherID !== null ? signatures[otherID] || null : null, wormhole: wormhole };
				}),
				among: picks.length, others: others, slots: empty.length });
		});
		return fills;
	},

	/** The fill is a guess the user should check: more new holes than empty slots, or other unknown holes listed */
	ambiguous: function(fill) {
		return !!fill && ((Number(fill.among) || 0) > (Number(fill.slots) || 1) || (Number(fill.others) || 0) > 0);
	},

	/** The new holes a save sends: [{systemID, id} | {systemID, signatureID}] in payload order (wormhole adds, and
		updates that make a sig a wormhole) */
	payloadCandidates: function(data) {
		const out = [];
		const sigs = data && data.signatures;
		if (!sigs) { return out; }
		(Array.isArray(sigs.add) ? sigs.add : []).forEach(function(e) {
			const s = e && e.wormhole && Array.isArray(e.signatures) ? e.signatures[0] : null;
			if (s && s.signatureID) { out.push({ systemID: s.systemID, signatureID: String(s.signatureID) }); }
		});
		(Array.isArray(sigs.update) ? sigs.update : []).forEach(function(e) {
			const s = e && e.wormhole && Array.isArray(e.signatures) ? e.signatures[0] : null;
			if (s && s.id !== undefined && s.id !== null) { out.push({ systemID: s.systemID, id: s.id }); }
		});
		return out;
	},

	/** Whether a candidate's sig is in the list yet (in its system, by id or signature ID) */
	resolved: function(c, signatures) {
		const key = c && c.signatureID ? String(c.signatureID).toUpperCase() : null;
		return Object.keys(signatures || {}).some(function(k) {
			const s = signatures[k];
			if (!s || (c.systemID !== undefined && c.systemID !== null && s.systemID != c.systemID)) { return false; }
			return (c.id !== undefined && c.id !== null && s.id == c.id) || (key && String(s.signatureID || "").toUpperCase() === key);
		});
	},

	/** The candidates left after a check: one that is in the list was used or is out (its slot was full: it must not
		be filled when the slot empties later). One whose sig isn't in the list yet (the save's answer came without the
		list) waits for the list until pendingUntil. */
	prune: function(candidates, signatures, now, pendingUntil) {
		return (candidates || []).filter(function(c) {
			return now < pendingUntil && now - c.at < rageRolling.CANDIDATE_MS && !rageRolling.resolved(c, signatures);
		});
	},

	/** The requests for the fills: payload (as the Sig dialog's update: wormhole type and parent, this side's name, the far
		side's class) and remove (the collapsed old statics they replace, or null; sent only after the update worked), and
		the undo items per system: {update: [{wormhole, signatures: [this side, far side]} as they were], remove: [the
		removed holes as they were]}.
		leadsTo(type): the far side's system for a type (wormholeAnalysis.targetSystemID), or null. */
	fillPayload: function(fills, leadsTo) {
		const copy = function(v) { return v ? JSON.parse(JSON.stringify(v)) : v; };
		const entries = [];
		const removes = [];
		const undo = {};
		(fills || []).forEach(function(f) {
			const thisSide = { id: f.sig.id };
			if (f.name) { thisSide.name = f.name; }
			const farSide = { id: f.other.id };
			const target = typeof leadsTo === "function" ? leadsTo(f.type) : null;
			if (target !== null && target !== undefined) { farSide.systemID = target; }
			entries.push({ wormhole: { id: f.wormhole.id, type: f.type, parent: f.parent, life: f.wormhole.life || "stable", mass: f.wormhole.mass || "stable" },
				signatures: [thisSide, farSide] });
			const u = undo[f.systemID] = undo[f.systemID] || { update: [], remove: [] };
			u.update.push({ wormhole: copy(f.wormhole), signatures: [copy(f.sig), copy(f.other)] });
			(f.replaces || []).forEach(function(r) {
				if (r.wormhole) {
					removes.push(copy(r.wormhole));	// as upstream's "delete missing sigs": the wormhole goes with both sides
					u.remove.push({ wormhole: copy(r.wormhole), signatures: [copy(r.sig), copy(r.other)] });
				} else {
					removes.push(r.sig.id);
					u.remove.push(copy(r.sig));
				}
			});
		});
		return { payload: { signatures: { update: entries } }, remove: removes.length ? { signatures: { remove: removes } } : null, undo: undo };
	},

	/** "QRS456" -> "QRS-456" */
	idText: function(id) {
		const s = String(id || "").toUpperCase();
		return s.length === 6 ? s.substring(0, 3) + "-" + s.substring(3) : s;
	},

	/** Toast text for one fill (plain text: escape it before showing) */
	message: function(fill, bookmark) {
		const among = Number(fill.among) || 0, slots = Number(fill.slots) || 1, others = Number(fill.others) || 0;
		const replaced = (fill.replaces || []).map(function(r) { return rageRolling.idText(r.sig && r.sig.signatureID); }).filter(Boolean);
		const guess = others > 0 ? " (picked the newest hole, " + (among + others) + " unknown holes in this system, check it)"
			: among > slots ? " (" + among + " new holes: " + (slots > 1 ? "picked in paste order, check them" : "picked the first, check it") + ")" : "";
		return "Rage rolling: " + rageRolling.idText(fill.sig.signatureID) + " set as new static " + fill.type +
			(fill.name ? " (" + fill.name + ")" : "") + guess + (replaced.length ? ", old " + replaced.join(", ") + " deleted (not in the scan)" : "") +
			(bookmark ? ". Bookmark: " + bookmark : "");
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined" || typeof tripwire.refresh !== "function" || typeof holeNaming === "undefined") { return; }

		let candidates = [];	// {systemID, id | signatureID, at}
		let pendingUntil = 0;
		let savedAt = 0;	// our last save that brought candidates
		const filled = [];	// sig ids filled in this session: never again (Undo brings them back unnamed and unknown)
		let scans = [];		// our recent probe scanner pastes {systemID, ids, at}, oldest first, until their saves
		const scanFor = {};		// systemID -> the scan IDs of the save whose candidates wait for their check
		let checking = false;

		function opts() { return typeof options !== "undefined" ? options : undefined; }
		function on() { return rageRolling.isOn(opts(), Date.now()); }
		function homes() { const o = opts(); return rageRolling.homeSystems(o && o.chain ? o.chain.tabs : []); }
		function staticsOf(systemID) {
			try { return typeof sigQuickPicks !== "undefined" ? sigQuickPicks.staticsFor(systemID) : []; } catch (e) { return []; }
		}
		/** A home system with a static: where the chip shows and the mode acts */
		function isHome(systemID) {
			return systemID !== undefined && systemID !== null && homes().indexOf(String(systemID)) >= 0 && staticsOf(systemID).length > 0;
		}

		// ---- The mode ----

		function setMode(value, quiet) {
			const o = opts();
			if (!o) { return; }
			const was = on();
			o.rageRollingMode = value ? { on: true, since: Date.now() } : { on: false };
			try { o.save(); } catch (e) { /* stays for this session */ }
			render();
			if (value && !was && typeof forkUsage !== "undefined") { forkUsage.track("rageRolling", "turned_on"); }
			if (!quiet) {
				Notify.trigger(value ? "Rage rolling on: paste a fresh scan after the roll; when the static's signature is gone from it, the old static is deleted and the new unknown wormhole becomes the new static. Off again in 3 hours."
					: "Rage rolling off", value ? "green" : "blue", 6000);
			}
		}
		rageRolling.setMode = setMode;

		// ---- The chip in the Signatures panel's header ----

		function render() {
			const $controls = $("#signaturesWidget > .controls");
			if (!$controls.length) { return; }
			let $chip = $("#rage-rolling-toggle");
			const show = rageRolling.enabled(opts()) && isHome(typeof viewingSystemID !== "undefined" ? viewingSystemID : null);
			if (!show) { $chip.remove(); return; }
			if (!$chip.length) {
				$chip = $("<span id='rage-rolling-toggle' class='rage-rolling-chip' role='switch' tabindex='0'></span>");
				const $after = $controls.children("#redo");
				if ($after.length) { $chip.insertAfter($after); } else { $controls.append($chip); }
			}
			const active = on();
			const left = rageRolling.minutesLeft(opts(), Date.now());
			$chip.toggleClass("on", active).attr("aria-checked", active ? "true" : "false")
				.text(active ? "Rage roll: on" : "Rage roll")
				.attr("data-tooltip", active
					? "Rage rolling is on (" + (left >= 60 ? Math.floor(left / 60) + " h " + (left % 60) + " min" : left + " min") + " left): paste a fresh scan after the roll; when the static's signature is gone from it, the new unknown wormhole becomes the new static. Click to turn it off."
					: "Rage rolling: after rolling the static, paste a fresh scan: the old static (gone from the scan) is deleted and the new unknown wormhole is set as the new static (type and letter). Click to turn it on.");
		}
		rageRolling.render = render;

		$(document).on("click", "#rage-rolling-toggle", function() { setMode(!on()); });
		$(document).on("keydown", "#rage-rolling-toggle", function(e) {
			if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMode(!on()); }
		});

		if (typeof tripwire.systemChange === "function") {
			const systemChange = tripwire.systemChange;
			const wrapped = function() {
				const result = systemChange.apply(this, arguments);
				try { render(); } catch (e) { /* ignore */ }
				return result;
			};
			Object.keys(systemChange).forEach(function(k) { wrapped[k] = systemChange[k]; });	// other wrappers' markers
			tripwire.systemChange = wrapped;
		}
		// The 3-hour switch-off, Settings saves and chain tab changes
		setInterval(function() {
			const o = opts();
			if (o && o.rageRollingMode && o.rageRollingMode.on === true && !on()) {
				setMode(false, true);	// 3 hours up, or the button was turned off in Settings
				if (rageRolling.enabled(o)) { Notify.trigger("Rage rolling switched itself off (3 hours).", "blue", 8000); }
			}
			render();
		}, 5000);
		render();

		// ---- After our own saves ----

		const next = tripwire.refresh;	// below this wrapper: our own fill goes straight there

		function scheduleCheck(delay) {
			setTimeout(function() {
				try { check(); } catch (e) { console.warn("rage-rolling: could not check the statics", e); }
			}, delay || 0);
		}

		function check() {
			const now = Date.now();
			candidates = candidates.filter(function(c) { return now - c.at < rageRolling.CANDIDATE_MS; });
			if (!candidates.length || checking || !on() || !tripwire.client || !tripwire.client.signatures) { return; }
			if (now - savedAt < rageRolling.SETTLE_MS) { scheduleCheck(rageRolling.SETTLE_MS - (now - savedAt)); return; }
			if (tripwire.xhr) { scheduleCheck(500); return; }	// one request at a time (a queued payload is merged)
			const o = opts();
			const systems = [];
			candidates.forEach(function(c) { if (c.systemID && systems.indexOf(String(c.systemID)) < 0) { systems.push(String(c.systemID)); } });
			let fills = [];
			systems.forEach(function(systemID) {
				if (!isHome(systemID)) { return; }
				fills = fills.concat(rageRolling.plan({
					systemID: systemID, statics: staticsOf(systemID),
					signatures: tripwire.client.signatures, wormholes: tripwire.client.wormholes,
					candidates: candidates.filter(function(c) { return String(c.systemID) === systemID; }),
					staticFirst: holeNaming.staticFirst(o), naming: holeNaming.enabled(o), skip: filled,
					scanIDs: scanFor[systemID] ? scanFor[systemID].ids : null,
					kept: scanFor[systemID] ? scanFor[systemID].kept : [],
					broken: typeof brokenHoles !== "undefined" ? Object.keys(brokenHoles.ids || {}) : []
				}));
			});
			// Every candidate in the list now was used or is out (see prune); the save below drops the used ones too
			candidates = rageRolling.prune(candidates, tripwire.client.signatures, now, pendingUntil);
			Object.keys(scanFor).forEach(function(systemID) {
				if (!candidates.some(function(c) { return String(c.systemID) === systemID; })) { delete scanFor[systemID]; }
			});
			if (fills.length) { save(fills); }
		}

		function leadsTo(type) {
			try { return wormholeAnalysis.targetSystemID("", type); } catch (e) { return null; }
		}

		function bookmarkOf(fill, target) {
			if (!fill.name) { return null; }
			let classText = "";
			if (target !== null && target !== undefined) {
				try { classText = holeNaming.classText(systemAnalysis.analyse(target).systemTypeName); } catch (e) { classText = ""; }
			}
			try {
				return holeNaming.bookmarkString({ name: fill.name, classText: classText, sigID: String(fill.sig.signatureID || ""),
					type: fill.type, size: holeNaming.sizeLetter(fill.type), system: holeNaming.systemName(fill.systemID),
					eol: fill.wormhole.life === "critical" });
			} catch (e) { return null; }
		}

		function undoStack(systemID) {
			return tripwire.signatures.undo[systemID] = tripwire.signatures.undo[systemID] || [];
		}
		function undoChanged() {
			$("#undo").removeClass("disabled");
			try { if (typeof undoHistory === "undefined") { sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo)); } } catch (e) { /* ignore */ }
		}

		/** The fill's undo entry, pushed as soon as the update is saved. Returns the entries by system. */
		function pushFillUndo(undo) {
			const out = {};
			Object.keys(undo).forEach(function(systemID) {
				if (!undo[systemID].update.length) { return; }
				const entry = { action: "update", signatures: undo[systemID].update };
				undoStack(systemID).push(entry);
				out[systemID] = entry;
			});
			undoChanged();
			return out;
		}

		/** The old statics' undo entry, once their delete is saved: in the fill's step (undo-history.js groups entries by
			meta.group) while the fill is still the newest step; otherwise a step of its own. */
		function pushRemoveUndo(undo, fillEntries) {
			Object.keys(undo).forEach(function(systemID) {
				if (!undo[systemID].remove.length) { return; }
				const entry = { action: "remove", signatures: undo[systemID].remove };
				const stack = undoStack(systemID);
				const fill = fillEntries[systemID];
				const ui = typeof undoHistory !== "undefined" ? undoHistory.ui : null;
				const group = fill && fill.meta ? fill.meta.group : undefined;
				if (ui && group !== undefined && stack[stack.length - 1] === fill && "openGroup" in ui) {
					const previous = ui.openGroup;
					ui.openGroup = group;	// annotate() takes the open group: the same step as the fill
					try { stack.push(entry); } finally { ui.openGroup = previous; }
				} else {
					stack.push(entry);
				}
			});
			undoChanged();
		}

		/** The fills with only the old statics still in the list (someone else may have deleted one meanwhile) */
		function stillListed(fills) {
			return fills.map(function(f) {
				return Object.assign({}, f, { replaces: (f.replaces || []).filter(function(r) {
					return r && r.sig && tripwire.client && tripwire.client.signatures && !!tripwire.client.signatures[r.sig.id];
				}) });
			});
		}

		function save(fills) {
			const built = rageRolling.fillPayload(fills, leadsTo);
			const notes = fills.map(function(f) { return { fill: f, bookmark: bookmarkOf(f, leadsTo(f.type)) }; });
			// These sigs are used up, whatever the answer (a failed save must not be retried over and over)
			const usedIDs = fills.map(function(f) { return String(f.sig.id); });
			usedIDs.forEach(function(id) { filled.push(id); });
			const usedKeys = fills.map(function(f) { return String(f.sig.signatureID || "").toUpperCase(); });
			candidates = candidates.filter(function(c) {
				return !(c.id !== undefined && usedIDs.indexOf(String(c.id)) >= 0) && !(c.signatureID && usedKeys.indexOf(String(c.signatureID).toUpperCase()) >= 0);
			});
			const ok = function(result) { return !!(result && result.resultSet && result.resultSet[0] && result.resultSet[0].result == true); };
			checking = true;
			let second = false;		// the old statics' delete was sent
			let finished = false;	// done() ran
			let fillEntries = {};
			next.call(tripwire, "refresh", built.payload, function(result) {
				if (!ok(result)) {
					Notify.trigger("Rage rolling: couldn't set the new static. Fill it in by hand.", "red", 8000);
					return;
				}
				fillEntries = pushFillUndo(built.undo);
				if (!built.remove) { done(fills, true); return; }
				// Then the old statics: only once the fill is saved
				second = true;
				const sendRemove = function() {
					let live = fills;
					try {
						if (tripwire.xhr) { setTimeout(sendRemove, 100); return; }	// the fill's request is still finishing
						live = stillListed(fills);
						const rb = rageRolling.fillPayload(live, leadsTo);
						if (!rb.remove) { checking = false; done(live, true); return; }	// already gone: nothing to delete
						next.call(tripwire, "refresh", rb.remove, function(res) {
							if (ok(res)) { pushRemoveUndo(rb.undo, fillEntries); }
							done(live, ok(res));
						}, function() { checking = false; if (!finished) { done(live, false); } });	// no answer at all: as failed
					} catch (e) {
						console.warn("rage-rolling: could not delete the old static", e);
						checking = false;
						if (!finished) { done(live, false); }
					}
				};
				setTimeout(sendRemove, 0);
			}, function() { if (!second) { checking = false; } });

			function done(live, removed) {
				finished = true;
				let shown = live;
				if (!removed) {
					shown = stillListed(live);	// one deleted meanwhile is no failure
					const old = [];
					shown.forEach(function(f) { f.replaces.forEach(function(r) { old.push(rageRolling.idText(r.sig.signatureID)); }); });
					if (old.length) { Notify.trigger(_.escape("Rage rolling: couldn't delete the old static " + old.join(", ") + ". Delete it by hand."), "red", 10000); }
					shown = shown.map(function(f) { return Object.assign({}, f, { replaces: [] }); });
				}
				notes.forEach(function(n, i) {
					n.fill = Object.assign({}, n.fill, { replaces: shown[i] ? shown[i].replaces : [] });
					if (typeof forkUsage !== "undefined") { forkUsage.track("rageRolling", "filled"); }
					const text = rageRolling.message(n.fill, null);
					const colour = rageRolling.ambiguous(n.fill) ? "yellow" : "green";
					if (!n.bookmark) { Notify.trigger(_.escape(text), colour, 10000); return; }
					// Not inside a click or key press: the copy may be refused, then the bookmark is in the toast to copy by hand
					const copier = typeof holeNaming.copyText === "function" ? holeNaming.copyText(n.bookmark) : Promise.resolve(false);
					copier.then(function(copied) {
						Notify.trigger(_.escape(copied ? text + ". Copied " + n.bookmark : rageRolling.message(n.fill, n.bookmark)), colour, 15000);
					}, function() {
						Notify.trigger(_.escape(rageRolling.message(n.fill, n.bookmark)), colour, 15000);
					});
				});
			}
		}

		tripwire.refresh = function(mode, data, successCallback, alwaysCallback) {
			if (!data || !data.signatures || !on()) { return next.apply(this, arguments); }
			let found = [];
			try { found = rageRolling.payloadCandidates(data); } catch (e) { found = []; }
			if (!found.length) { return next.apply(this, arguments); }
			// The save of our last probe scanner paste (plain paste.js, or the paste preview's Apply / auto-save): its new
			// sigs are in that scan. Its scan tells which old statics collapsed (rageRolling.plan, scanIDs).
			let scan = null;
			const added = found.filter(function(c) { return c.signatureID; }).map(function(c) { return c.signatureID; });
			const at = data.systemID !== undefined ? rageRolling.matchScan(scans, data.systemID, added, Date.now()) : -1;
			if (at >= 0) { scan = { ids: scans[at].ids, kept: [] }; scans.splice(at, 1); }
			// The paste preview's Apply records what the user kept (pastePreview.lastKept) just before it sends this save
			try {
				const lk = typeof pastePreview !== "undefined" ? pastePreview.lastKept : null;
				if (scan && lk && String(lk.systemID) === String(data.systemID) && Date.now() - lk.at < 5000) { scan.kept = lk.ids.slice(); }
			} catch (e) { /* nothing kept */ }
			const wrapped = function(result) {
				const ret = successCallback ? successCallback.apply(this, arguments) : undefined;
				try {
					if (result && result.resultSet && result.resultSet[0] && result.resultSet[0].result == true) {
						const now = Date.now();
						found.forEach(function(c) { candidates.push(Object.assign({ at: now }, c)); });
						if (scan) { scanFor[String(data.systemID)] = scan; }
						pendingUntil = now + rageRolling.PENDING_MS;
						savedAt = now;
						scheduleCheck(rageRolling.SETTLE_MS);
					}
				} catch (e) { console.warn("rage-rolling: after the save", e); }
				return ret;
			};
			return next.call(this, mode, data, wrapped, alwaysCallback);
		};
		Object.keys(next).forEach(function(k) { tripwire.refresh[k] = next[k]; });	// other wrappers' markers

		// The probe scanner paste: remember its signature IDs for its save (paste.js and the paste preview both go through
		// parsePaste with the whole pasted text; the save follows at once, or at the preview's Apply / auto-save)
		if (tripwire.pasteSignatures && typeof tripwire.pasteSignatures.parsePaste === "function") {
			const parsePaste = tripwire.pasteSignatures.parsePaste;
			const wrappedPaste = function(paste) {
				try {
					if (on() && typeof viewingSystemID !== "undefined") {
						scans.push({ systemID: String(viewingSystemID), ids: rageRolling.scanIDs(paste), at: Date.now() });
						scans = scans.slice(-rageRolling.MAX_SCANS);
					}
				} catch (e) { /* no scan: the older rules still apply */ }
				return parsePaste.apply(this, arguments);
			};
			Object.keys(parsePaste).forEach(function(k) { wrappedPaste[k] = parsePaste[k]; });
			tripwire.pasteSignatures.parsePaste = wrappedPaste;
		}

		// Our save's answer may come without the list (same second): check again when the list arrives
		if (typeof tripwire.parse === "function") {
			const parse = tripwire.parse;
			tripwire.parse = function() {
				const ret = parse.apply(this, arguments);
				if (candidates.length && Date.now() < pendingUntil) { scheduleCheck(0); }
				return ret;
			};
		}

		// ---- Command palette ----
		if (typeof forkCommands !== "undefined") {
			forkCommands.register({
				id: "rageRolling.on", title: "Rage rolling on", group: "Holes", icon: "auto",
				keywords: ["rage", "roll", "rolling", "static", "new static"],
				enabled: function() {
					if (!rageRolling.enabled(opts())) { return "Turned off in Settings > Wormhole Jumps & Mass"; }
					return on() ? "Rage rolling is already on" : true;
				},
				run: function() { setMode(true); }
			});
			forkCommands.register({
				id: "rageRolling.off", title: "Rage rolling off", group: "Holes", icon: "auto",
				keywords: ["rage", "roll", "rolling", "static", "stop"],
				enabled: function() { return on() ? true : "Rage rolling is off"; },
				run: function() { setMode(false); }
			});
		}

		// ---- Settings > Wormhole Jumps & Mass (the chip; the mode itself starts off and is switched from the chip) ----
		forkSettings.register({
			section: "jumps", order: 22, id: "rageRolling-enabled", type: "checkbox", key: "rageRolling",
			label: "Rage rolling button:",
			text: "Show the Rage roll switch in the Signatures panel of a home system with a static",
			hint: "Rage rolling: when a scan you paste no longer has the static's signature, the old static is deleted and the new unknown wormhole becomes the new static. It is off until you switch it on, and switches itself off after 3 hours.",
			keywords: ["rage", "roll", "rolling", "static", "paste"],
			get: function(o) { return rageRolling.enabled(o); },
			set: function(o, value) { o.rageRolling = Object.assign({}, o.rageRolling || {}, { enabled: !!value }); },
			reset: function(o) { delete o.rageRolling; delete o.rageRollingMode; }
		});

		// ---- Tip: someone marks a home static as rolling (rolling.js) while the mode is off ----
		if (typeof forkHints !== "undefined") {
			forkHints.register({
				id: "rageRolling.marked", feature: "rageRolling", section: "jumps",
				trigger: "rolling.marked", kind: "toast",
				eligible: function(ctx, data) {
					if (!rageRolling.enabled(ctx.options) || rageRolling.isOn(ctx.options, Date.now()) || !data) { return false; }
					const wh = tripwire.client && tripwire.client.wormholes ? tripwire.client.wormholes[data.wormholeID] : null;
					if (!wh) { return false; }
					return [wh.initialID, wh.secondaryID].some(function(sigID) {
						const sig = tripwire.client.signatures[sigID];
						return sig && isHome(sig.systemID) && staticsOf(sig.systemID).indexOf(rageRolling.sideType(sigID, wh)) >= 0;
					});
				},
				title: "Rolling your static?",
				body: "Turn on Rage roll in the Signatures panel (or Ctrl+K, Rage rolling on): when you paste a fresh scan after the roll, "
					+ "the old static (gone from the scan) is deleted and the new unknown wormhole is set as the new static, type and letter. "
					+ "Turn tips off in Settings > General.",
				action: { label: "Turn it on", run: function() { setMode(true); } },
				priority: 45, maxShows: 2, cooldownHours: 72, ttlSeconds: 600
			});
		}

		rageRolling.debug = { candidates: function() { return candidates.slice(); }, check: check };
	});
}
