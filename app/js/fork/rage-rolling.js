const rageRolling = {
	// Fork-owned: "Rage rolling mode". While a group rolls its home static over and over, every roll leaves a new
	// wormhole signature to scan and fill in. With the mode on, Tripwire takes the new hole for the new static:
	// after this client's own save in a home system (a probe scanner paste, a paste preview's Apply, the Sig dialog),
	// each static slot that is empty gets the first new unknown wormhole of that same save: its type is set to the
	// static (so the far side's class is known) and it is named with the static's letter (Statics get the first letters,
	// hole-naming.js; the name only while "Suggest hole names" is on).
	//  - Home system: the root of one of the user's chain tabs, with at least one static (sigQuickPicks.staticsFor).
	//  - A static slot is empty when no wormhole sig in the system has the static's type on its own side and no sig with
	//    an unknown type (or the static's type) holds the static's reserved name (A for the first static; with "Statics
	//    get the first letters" off only the type counts). A K162 or another known type named A (old data) doesn't hold it.
	//  - Candidates: the wormhole sigs a save of ours added or turned into wormholes, in the order they were sent (= paste
	//    order); only unnamed ones with no type on this side (not K162) and a far side that is still unknown. A candidate
	//    counts only at the check right after its own save: when the slot was already empty, or that same save emptied it
	//    (the paste preview's Apply deletes the old static and adds the new hole in one request). A hole pasted while the
	//    old static was still listed is never filled later (it could be any K162 that came in meanwhile). The first
	//    candidate fills the first empty slot, the next one the second; with more candidates than empty slots the toast
	//    says it picked by paste order.
	//  - Only the client that saved acts (its own candidates), so two clients never fight; the fill is one update request
	//    (an Undo step too) and a toast with the hole's bookmark text.
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

	/**
	 * Which new holes become which statics. args:
	 *   systemID, statics (types in data order), signatures, wormholes (tripwire.client's),
	 *   candidates: [{id} | {signatureID}] in the order they were saved,
	 *   staticFirst (Statics get the first letters), naming (Suggest hole names), table (appData.wormholes, optional),
	 *   skip: sig ids never to fill again (filled once already: an Undo of the fill must stay undone)
	 * Returns [{systemID, sig, other, wormhole, type, name, parent, among, slots}] (name null when naming is off; parent:
	 * the static's side, "initial" or "secondary"; among: how many new holes were eligible, slots: how many slots were
	 * empty), at most one per empty static slot.
	 */
	plan: function(args) {
		const a = args || {};
		const signatures = a.signatures || {};
		const wormholes = a.wormholes || {};
		const local = Object.keys(signatures).map(function(k) { return signatures[k]; })
			.filter(function(s) { return s && s.type === "wormhole" && s.systemID == a.systemID; });
		const slots = holeNaming.staticSlots(a.statics, "", a.table);
		if (!slots.length || !local.length) { return []; }
		const typeOf = {};
		local.forEach(function(s) { typeOf[s.id] = rageRolling.sideType(s.id, rageRolling.wormholeOf(s.id, wormholes)); });

		const empty = slots.filter(function(slot) {
			return !local.some(function(s) {
				if (typeOf[s.id] === slot.type) { return true; }
				// The reserved name holds the slot only on a hole that may be the static (unknown type, or that type)
				return a.staticFirst && holeNaming.leadingToken(s.name) === slot.ch && typeOf[s.id] === "";
			});
		});
		if (!empty.length) { return []; }

		const seen = {};
		const picks = [];
		(a.candidates || []).forEach(function(c) {
			if (!c) { return; }
			const key = c.signatureID ? String(c.signatureID).toUpperCase() : null;
			const sig = local.filter(function(s) {
				return (c.id !== undefined && c.id !== null && s.id == c.id) || (key && String(s.signatureID || "").toUpperCase() === key);
			})[0];
			if (!sig || seen[sig.id] || (a.skip || []).some(function(id) { return id == sig.id; })) { return; }
			seen[sig.id] = true;
			const name = String(sig.name === undefined || sig.name === null ? "" : sig.name).trim();
			if (name !== "" || typeOf[sig.id] !== "") { return; }	// named (also a return bookmark), K162 or a known type
			const wormhole = rageRolling.wormholeOf(sig.id, wormholes);
			if (!wormhole) { return; }
			const otherID = wormhole.initialID == sig.id ? wormhole.secondaryID : wormhole.initialID;
			const other = signatures[otherID] || null;
			if (!other) { return; }	// no far side in the list: nothing to update (and nothing to undo)
			if (!rageRolling.farUnknown(other) || holeNaming.leadingToken(other.name)) { return; }
			picks.push({ sig: sig, other: other, wormhole: wormhole });
		});

		const used = local.map(function(s) { return s.name; }).filter(Boolean);
		const reserved = slots.map(function(s) { return s.ch; });
		const fills = [];
		empty.forEach(function(slot, i) {
			const pick = picks[i];
			if (!pick) { return; }
			let name = null;
			if (a.naming) {
				name = holeNaming.nextName("", used, holeNaming.sizeClass(slot.type, a.table),
					a.staticFirst ? { reserved: reserved, own: slot.ch } : null);
				if (name) { used.push(name); }
			}
			fills.push({ systemID: a.systemID, sig: pick.sig, other: pick.other, wormhole: pick.wormhole, type: slot.type, name: name,
				parent: pick.wormhole.initialID == pick.sig.id ? "initial" : "secondary", among: picks.length, slots: empty.length });
		});
		return fills;
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

	/** The update request for the fills (as the Sig dialog's update: wormhole type and parent, this side's name, the far
		side's class) and the undo items per system ({wormhole, signatures: [this side, far side]} as they were).
		leadsTo(type): the far side's system for a type (wormholeAnalysis.targetSystemID), or null. */
	fillPayload: function(fills, leadsTo) {
		const copy = function(v) { return v ? JSON.parse(JSON.stringify(v)) : v; };
		const entries = [];
		const undo = {};
		(fills || []).forEach(function(f) {
			const thisSide = { id: f.sig.id };
			if (f.name) { thisSide.name = f.name; }
			const farSide = { id: f.other.id };
			const target = typeof leadsTo === "function" ? leadsTo(f.type) : null;
			if (target !== null && target !== undefined) { farSide.systemID = target; }
			entries.push({ wormhole: { id: f.wormhole.id, type: f.type, parent: f.parent, life: f.wormhole.life || "stable", mass: f.wormhole.mass || "stable" },
				signatures: [thisSide, farSide] });
			(undo[f.systemID] = undo[f.systemID] || []).push({ wormhole: copy(f.wormhole), signatures: [copy(f.sig), copy(f.other)] });
		});
		return { payload: { signatures: { update: entries } }, undo: undo };
	},

	/** "QRS456" -> "QRS-456" */
	idText: function(id) {
		const s = String(id || "").toUpperCase();
		return s.length === 6 ? s.substring(0, 3) + "-" + s.substring(3) : s;
	},

	/** Toast text for one fill (plain text: escape it before showing) */
	message: function(fill, bookmark) {
		const among = Number(fill.among) || 0, slots = Number(fill.slots) || 1;
		const guess = among > slots ? " (" + among + " new holes: " + (slots > 1 ? "picked in paste order, check them" : "picked the first, check it") + ")" : "";
		return "Rage rolling: " + rageRolling.idText(fill.sig.signatureID) + " set as new static " + fill.type +
			(fill.name ? " (" + fill.name + ")" : "") + guess + (bookmark ? ". Bookmark: " + bookmark : "");
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined" || typeof tripwire.refresh !== "function" || typeof holeNaming === "undefined") { return; }

		let candidates = [];	// {systemID, id | signatureID, at}
		let pendingUntil = 0;
		let savedAt = 0;	// our last save that brought candidates
		const filled = [];	// sig ids filled in this session: never again (Undo brings them back unnamed and unknown)
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
				Notify.trigger(value ? "Rage rolling on: a new unknown wormhole you paste in a home system becomes the new static when the paste also removes the old one (paste preview: Apply). Off again in 3 hours."
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
					? "Rage rolling is on (" + (left >= 60 ? Math.floor(left / 60) + " h " + (left % 60) + " min" : left + " min") + " left): a new unknown wormhole you paste becomes the new static when the paste also removes the old one. Click to turn it off."
					: "Rage rolling: when you paste after rolling the static, the new unknown wormhole is set as the new static (type and name). Click to turn it on.");
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
					staticFirst: holeNaming.staticFirst(o), naming: holeNaming.enabled(o), skip: filled
				}));
			});
			// Every candidate in the list now was used or is out (see prune); the save below drops the used ones too
			candidates = rageRolling.prune(candidates, tripwire.client.signatures, now, pendingUntil);
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

		function saveUndo(systemID, items) {
			const stack = tripwire.signatures.undo[systemID] = tripwire.signatures.undo[systemID] || [];
			stack.push({ action: "update", signatures: items });
			$("#undo").removeClass("disabled");
			try { sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo)); } catch (e) { /* ignore */ }
		}

		function save(fills) {
			const built = rageRolling.fillPayload(fills, leadsTo);
			const undo = built.undo;
			const notes = fills.map(function(f) { return { fill: f, bookmark: bookmarkOf(f, leadsTo(f.type)) }; });
			// These sigs are used up, whatever the answer (a failed save must not be retried over and over)
			const usedIDs = fills.map(function(f) { return String(f.sig.id); });
			usedIDs.forEach(function(id) { filled.push(id); });
			const usedKeys = fills.map(function(f) { return String(f.sig.signatureID || "").toUpperCase(); });
			candidates = candidates.filter(function(c) {
				return !(c.id !== undefined && usedIDs.indexOf(String(c.id)) >= 0) && !(c.signatureID && usedKeys.indexOf(String(c.signatureID).toUpperCase()) >= 0);
			});
			checking = true;
			next.call(tripwire, "refresh", built.payload, function(result) {
				checking = false;
				if (!(result && result.resultSet && result.resultSet[0] && result.resultSet[0].result == true)) {
					Notify.trigger("Rage rolling: couldn't set the new static. Fill it in by hand.", "red", 8000);
					return;
				}
				Object.keys(undo).forEach(function(systemID) { saveUndo(systemID, undo[systemID]); });
				notes.forEach(function(n) {
					if (typeof forkUsage !== "undefined") { forkUsage.track("rageRolling", "filled"); }
					const text = rageRolling.message(n.fill, null);
					if (!n.bookmark) { Notify.trigger(_.escape(text), n.fill.among > n.fill.slots ? "yellow" : "green", 10000); return; }
					// Not inside a click or key press: the copy may be refused, then the bookmark is in the toast to copy by hand
					const copier = typeof holeNaming.copyText === "function" ? holeNaming.copyText(n.bookmark) : Promise.resolve(false);
					copier.then(function(ok) {
						Notify.trigger(_.escape(ok ? text + ". Copied " + n.bookmark : rageRolling.message(n.fill, n.bookmark)), n.fill.among > n.fill.slots ? "yellow" : "green", 15000);
					}, function() {
						Notify.trigger(_.escape(rageRolling.message(n.fill, n.bookmark)), "green", 15000);
					});
				});
			}, function() { checking = false; });
		}

		tripwire.refresh = function(mode, data, successCallback, alwaysCallback) {
			if (!data || !data.signatures || !on()) { return next.apply(this, arguments); }
			let found = [];
			try { found = rageRolling.payloadCandidates(data); } catch (e) { found = []; }
			if (!found.length) { return next.apply(this, arguments); }
			const wrapped = function(result) {
				const ret = successCallback ? successCallback.apply(this, arguments) : undefined;
				try {
					if (result && result.resultSet && result.resultSet[0] && result.resultSet[0].result == true) {
						const now = Date.now();
						found.forEach(function(c) { candidates.push(Object.assign({ at: now }, c)); });
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
			hint: "Rage rolling sets a new unknown wormhole you paste as the new static when the same paste removes the old one. It is off until you switch it on, and switches itself off after 3 hours.",
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
				body: "Turn on Rage roll in the Signatures panel (or Ctrl+K, Rage rolling on): when you paste after the roll, the new "
					+ "unknown wormhole is set as the new static, type and letter. Turn tips off in Settings > General.",
				action: { label: "Turn it on", run: function() { setMode(true); } },
				priority: 45, maxShows: 2, cooldownHours: 72, ttlSeconds: 600
			});
		}

		rageRolling.debug = { candidates: function() { return candidates.slice(); }, check: check };
	});
}
