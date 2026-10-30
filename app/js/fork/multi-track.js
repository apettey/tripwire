const multiTrack = {
	// Fork-owned: multi-character jump tracking (opt-in, Settings > Wormhole Jumps & Mass). Tripwire already polls ESI
	// for every linked character; only the "active" one drives the automapper. With this on, when another of your
	// opted-in characters jumps through a wormhole, it becomes the active character and the jump is replayed through
	// tripwire.EVE, so the automapper, the return-bookmark pop-up, the signature prompt and Follow all work for it.
	// A strip of character chips next to "Current System" shows who is active and who jumped last.
	// No new ESI requests, endpoints or polling: the 1 s tick only reads tripwire.esi.characters (filled by upstream's
	// 5 s location poll). Rules (fleet jumps, pause after a manual pick, held while a jump question is open):
	// changes/2026-10-30-multi-character-jumps/README.md.
	// Keep `const multiTrack` on the first line: the test helper strips it to define a global.

	CAP: 5,						// opted-in characters used for switching (linking stays unlimited)
	TICK_MS: 1000,
	RECENT_MS: 60000,			// a character that jumped is ringed this long
	FRESH_MS: 10000,			// ...and pulses for the first part of it
	FLEET_MS: 10000,			// an alt taking the same hole as the active character within this is following it
	SETTLE_MS: 7000,			// a switch waits this long: the active character's own jump may come a poll (5 s) later
	NOTICE_MS: 20000,
	AFTER_QUESTION_MS: 6000,	// a jump question closed: its answer reaches the map with the next sync (5 s)			// the switch notice (longer while a question about that jump is open)
	PAUSE_MS: 180000,			// no automatic switching for this long after the user picks a character
	NAME_CHARS: 18,				// chip names longer than this keep their start and end ("Bob Sc…r Hauler")
	PODS: [33328, 670],
	NO_MAP_SYSTEMS: [30000142, 30002187],	// Jita, Amarr: likely pod-out destinations (as the automapper)
	SPECIAL_REGION: 12000000,	// abyssal and other special space (as the automapper)

	SETTING_TEXT: "Map jumps of all my tracked characters",	// the Settings row's text; the tip quotes it

	// ---- Pure logic (tested under mocha) ----

	/** On only when switched on in Settings (missing = off: it changes which character is active) */
	enabled: function(opts) {
		return !!(opts && opts.multiTrack && typeof opts.multiTrack === "object" && opts.multiTrack.enabled === true);
	},

	/** The character's "auto-map this character's jumps" switch is off */
	excluded: function(opts, id) {
		const ex = opts && opts.multiTrack && opts.multiTrack.exclude;
		return !!(ex && typeof ex === "object" && ex[id]);
	},

	included: function(opts, id) {
		return multiTrack.enabled(opts) && !multiTrack.excluded(opts, id);
	},

	byName: function(characters) {
		return function(a, b) {
			const na = String(characters[a] && characters[a].characterName || "").toLowerCase();
			const nb = String(characters[b] && characters[b].characterName || "").toLowerCase();
			return na < nb ? -1 : na > nb ? 1 : (a < b ? -1 : a > b ? 1 : 0);
		};
	},

	/** Ids (strings) of the characters whose switch is on, sorted by name (then id) */
	switchedOn: function(opts, characters) {
		if (!multiTrack.enabled(opts) || !characters) { return []; }
		return Object.keys(characters)
			.filter(function(id) { return characters[id] && !multiTrack.excluded(opts, id); })
			.sort(multiTrack.byName(characters));
	},

	/** The ones used for switching: the first `cap` switched on */
	optedIn: function(opts, characters, cap) {
		return multiTrack.switchedOn(opts, characters).slice(0, typeof cap === "number" ? cap : multiTrack.CAP);
	},

	/** The tracking list's note when more characters are switched on than are used, or "" */
	capNote: function(opts, characters) {
		const n = multiTrack.switchedOn(opts, characters).length;
		return n > multiTrack.CAP ? "Switching to " + n + " characters on jumps; only " + multiTrack.CAP
			+ " are used (the first by name). Turn one off with its A icon." : "";
	},

	/** The strip's characters: the ones used, plus the active one even if it is off or over the cap, sorted by name */
	stripIds: function(opts, characters, activeId) {
		const ids = multiTrack.optedIn(opts, characters);
		if (ids.length && multiTrack.tracking(activeId) && characters && characters[activeId] && ids.indexOf(String(activeId)) < 0) {
			ids.push(String(activeId));
			ids.sort(multiTrack.byName(characters));
		}
		return ids;
	},

	/** A character is being tracked (the user didn't untrack with a click on the active one) */
	tracking: function(activeId) {
		return activeId !== null && activeId !== undefined && activeId !== "" && activeId !== "new";
	},

	/** Snapshot of what a jump needs to know about where a character was */
	snapshot: function(c) {
		return { systemID: c.systemID, systemName: c.systemName || null, stationID: c.stationID || null, shipTypeID: c.shipTypeID || null };
	},

	/**
	 * Characters that changed system since the last tick. last: {id: snapshot}. Ignores a missing systemID (keeps the
	 * old snapshot: ESI just hasn't answered yet), the first sighting and an unchanged system. The active character's
	 * move is reported too, marked `active` (upstream's own path maps it; it counts for the fleet rule and the ring).
	 * Characters that are gone are dropped. Returns {moves: [{id, from, to, before, active}], last: newLast}.
	 */
	detectMoves: function(last, characters, ids, activeId) {
		const prev = last || {};
		const next = {};
		const moves = [];
		(ids || []).forEach(function(id) {
			const c = characters && characters[id];
			if (!c) { return; }
			if (!c.systemID) { if (prev[id]) { next[id] = prev[id]; } return; }
			next[id] = multiTrack.snapshot(c);
			const was = prev[id];
			if (!was || was.systemID == c.systemID) { return; }
			const active = activeId !== null && activeId !== undefined && String(id) === String(activeId);
			moves.push({ id: String(id), from: was.systemID, to: c.systemID, before: was, active: active });
		});
		return { moves: moves, last: next };
	},

	/**
	 * Would the automapper map this jump? Mirrors automapper.js: valid and different systems, no special region, not
	 * Jita/Amarr, not docked, not in a pod, not a stargate. ctx: {systems, shortest}. A gate, a dock or a pod never
	 * makes another character the active one.
	 */
	isMappableJump: function(from, to, char, ctx) {
		const systems = ctx && ctx.systems;
		if (!from || !to || from == to || !systems) { return false; }
		const a = systems[from], b = systems[to];
		if (!a || !b) { return false; }
		if (a.regionID > multiTrack.SPECIAL_REGION || b.regionID > multiTrack.SPECIAL_REGION) { return false; }
		if (multiTrack.NO_MAP_SYSTEMS.indexOf(Number(from)) >= 0 || multiTrack.NO_MAP_SYSTEMS.indexOf(Number(to)) >= 0) { return false; }
		if (char && char.stationID) { return false; }
		if (char && char.shipTypeID && multiTrack.PODS.indexOf(parseInt(char.shipTypeID, 10)) >= 0) { return false; }
		const shortest = ctx.shortest;
		const row = shortest ? shortest[from - 30000000] : undefined;
		if (typeof row !== "undefined" && row !== null && typeof row[to - 30000000] !== "undefined") { return false; }
		return true;
	},

	/** An alt following the active character: the same hole (from → to) as a jump the active character made, or a
	 *  switch already decided, within windowMs. (Landing where the active character is only counts through the same
	 *  hole: from another system it is a jump of its own.) */
	isFleet: function(move, recent, now, windowMs) {
		const at = typeof move.at === "number" ? move.at : now;	// from the alt's own jump, not from when it is checked
		return (recent || []).some(function(r) { return r.from == move.from && r.to == move.to && Math.abs(at - r.at) <= windowMs; });
	},

	/**
	 * What to do with this tick's wormhole jumps. ctx: {recent: [{from, to, at}], now, windowMs, eligible(id)
	 * (followed, used, tracking, feature on), paused}. The active character's jumps come first ("self", added to recent).
	 * Then, in order, each other jump: "skip" (not eligible), "fleet" (follows the active character or a switch just
	 * decided through the same hole: nothing to map), "map" (switching is paused after the user picked a character: the
	 * jump is mapped without switching) or "switch" (added to recent, so other alts through the same hole are "fleet").
	 * Returns {decisions: [{move, action}], recent}.
	 */
	planMoves: function(moves, ctx) {
		const c = ctx || {};
		const now = c.now || 0, windowMs = typeof c.windowMs === "number" ? c.windowMs : multiTrack.FLEET_MS;
		// Entries are kept from windowMs before the oldest held switch (ctx.keepSince), so a switch held longer than the
		// window is still checked against the jumps around its own time
		const since = Math.min(now, typeof c.keepSince === "number" ? c.keepSince : now) - windowMs;
		const recent = (c.recent || []).filter(function(r) { return r.at >= since; });
		const decisions = [];
		(moves || []).filter(function(m) { return m.active; }).forEach(function(m) {
			recent.push({ from: m.from, to: m.to, at: now, by: "self" });
			decisions.push({ move: m, action: "self" });
		});
		(moves || []).filter(function(m) { return !m.active; }).forEach(function(m) {
			let action;
			if (typeof c.eligible === "function" && !c.eligible(m.id)) { action = "skip"; }
			else if (multiTrack.isFleet(m, recent, now, windowMs)) { action = "fleet"; }
			else if (c.paused) { action = "map"; }
			else {
				action = "switch";
				recent.push({ from: m.from, to: m.to, at: now, by: m.id });
			}
			decisions.push({ move: m, action: action });
		});
		return { decisions: decisions, recent: recent };
	},

	/**
	 * How to make a character active after its queued jumps (in order, the same character): replay them through
	 * tripwire.EVE (its first `from` as a character change, then each `to`), so the automapper, the pop-ups and Follow
	 * see every jump and the next location poll can't map a hole from the first stop to the last. When the jumps don't
	 * chain, one was already mapped silently, or the character has moved on since, the unmapped ones are mapped
	 * silently and it only becomes active (a character change, no automap). currentSystemID: where it is now.
	 * Returns {silent: [moves to map silently], steps: [{systemID, characterChange}]}.
	 */
	replayPlan: function(moves, currentSystemID) {
		const list = (moves || []).filter(Boolean);
		if (!list.length) { return { silent: [], steps: currentSystemID ? [{ systemID: currentSystemID, characterChange: true }] : [] }; }
		const last = list[list.length - 1];
		const chained = list.every(function(m, i) { return i === 0 || m.from == list[i - 1].to; });
		const fresh = list.every(function(m) { return !m.mapped; });
		const here = !currentSystemID || currentSystemID == last.to;
		if (chained && fresh && here) {
			return { silent: [], steps: [{ systemID: list[0].from, characterChange: true }].concat(list.map(function(m) { return { systemID: m.to, characterChange: false }; })) };
		}
		return {
			silent: list.filter(function(m) { return !m.mapped; }),
			steps: [{ systemID: currentSystemID || last.to, characterChange: true }]
		};
	},

	/** After a jump of `prevActive` (the character an automatic switch just left): the same hole as that switch within
	 *  windowMs means it was a fleet jump whose leader showed up a poll late, so switch back */
	switchBack: function(move, lastSwitch, now, windowMs) {
		const at = move && typeof move.at === "number" ? move.at : now;	// re-checked later (after a question closed): its own time
		return !!(lastSwitch && move && String(move.id) === String(lastSwitch.prevId) && move.from == lastSwitch.from
			&& move.to == lastSwitch.to && at - lastSwitch.at <= windowMs);
	},

	/**
	 * A held / settled switch is due: switch, or not. ctx: {recent (without this character's own switch entries),
	 * windowMs, now, activeSystemID, currentSystemID (where the character is now)}.
	 *  - "fleet": its first jump took the same hole as the active character within windowMs of it (measured from the
	 *    jump, however long the switch was held);
	 *  - "stay": it is in the active character's system now (they travel together; never switch to it then);
	 *  - "switch".
	 * Not switching, its unmapped jumps are mapped without switching (`map`): the active character's own automap of the
	 * same hole may have been cancelled ("Which Signature?"), and the automapper finds an existing connection anyway.
	 */
	releaseDecision: function(moves, ctx) {
		const c = ctx || {};
		const list = (moves || []).filter(Boolean);
		if (!list.length) { return { action: "none", map: [] }; }
		const unmapped = list.filter(function(m) { return !m.mapped; });
		if (multiTrack.isFleet(list[0], c.recent, c.now, typeof c.windowMs === "number" ? c.windowMs : multiTrack.FLEET_MS)) {
			return { action: "fleet", map: unmapped };
		}
		if (c.activeSystemID && c.currentSystemID && c.activeSystemID == c.currentSystemID) { return { action: "stay", map: unmapped }; }
		return { action: "switch", map: [] };
	},

	/**
	 * Carry out a replayPlan. api: {silentMap(move) -> bool (false: can't now), eve(step), blocked() (the automapper's
	 * dialog is open: it maps one jump at a time)}. A jump that can't be mapped now (silently, or because a replayed jump
	 * opened "Which Signature?") is returned, to be mapped later; the character then lands on its last system as a
	 * character change, so no hole is mapped from the stop where the replay ended. Returns the deferred moves.
	 */
	runReplay: function(plan, moves, api) {
		const deferred = [];
		(plan.silent || []).forEach(function(m) { if (!api.silentMap(m)) { deferred.push(m); } });
		const steps = plan.steps || [];
		for (let i = 0; i < steps.length; i++) {
			if (!steps[i].characterChange && api.blocked()) {
				(moves || []).slice(i - 1).forEach(function(m) { if (!m.mapped) { deferred.push(m); } });
				api.eve({ systemID: steps[steps.length - 1].systemID, characterChange: true });
				break;
			}
			api.eve(steps[i]);
		}
		return deferred;
	},

	/** A manual pick: automatic switching pauses, nothing waits to switch */
	afterPick: function(st, now) {
		st.pausedUntil = now + multiTrack.PAUSE_MS;
		st.queue = [];
		return st;
	},

	/** Ctrl+K "Switch to character" choices: the previously active character first, then the rest by name */
	commandChoices: function(characters, activeId, prevId) {
		const chars = characters || {};
		const ids = Object.keys(chars).sort(multiTrack.byName(chars));
		if (prevId && ids.indexOf(String(prevId)) > 0 && String(prevId) !== String(activeId)) {
			ids.splice(ids.indexOf(String(prevId)), 1);
			ids.unshift(String(prevId));
		}
		return ids.map(function(id) {
			const c = chars[id];
			const hint = [c.systemName || "", String(activeId) === id ? "(active)" : (String(prevId) === id ? "(previous)" : "")].filter(Boolean).join(" ");
			return { value: id, title: String(c.characterName || id), hint: hint };
		});
	},

	/** The Ctrl+K command (a manual pick: works with the feature off too). api: {characters(), activeId(), prevId(), pick(id)} */
	switchCommand: function(api) {
		return {
			id: "tracking.switchTo", title: "Switch to character", group: "Navigation", icon: "follow",
			keywords: ["character", "alt", "active", "tracking", "switch", "multibox"],
			enabled: function() { return Object.keys(api.characters()).length ? true : "No tracked characters"; },
			hint: function() { const c = api.characters()[api.activeId()]; return c ? "Active: " + c.characterName : "No active character"; },
			args: [{ name: "character", label: "character", type: "choice", choices: function() {
				return multiTrack.commandChoices(api.characters(), api.activeId(), api.prevId());
			} }],
			run: function(args) {
				if (!api.pick(String(args.character))) { throw new Error("That character isn't tracked"); }
			}
		};
	},

	/** The character that jumped last (within the ring time), or null. jumps: {id: {at} | at} */
	latestJumper: function(jumps, now) {
		let best = null, bestAt = -Infinity;
		Object.keys(jumps || {}).forEach(function(id) {
			const j = jumps[id];
			const at = typeof j === "number" ? j : (j && j.at);
			if (typeof at === "number" && now - at < multiTrack.RECENT_MS && at > bestAt) { best = id; bestAt = at; }
		});
		return best;
	},

	/** "3m" (whole minutes, rounded up) for the chip; the tooltip has m:ss */
	minutes: function(ms) {
		return Math.max(1, Math.ceil((ms || 0) / 60000)) + "m";
	},

	/** The A switch's tooltip */
	toggleTitle: function(on, overCap) {
		if (!on) { return "Switch to this character when it jumps: off: its jumps aren't mapped unless it is active"; }
		return overCap ? "Switch to this character when it jumps: on, but over the 5 (turn another one off)"
			: "Switch to this character when it jumps: on (while switching is paused, its jumps are mapped without switching)";
	},

	/** The active character's name for "Current System (name)", or "" (feature off, fewer than 2 opted in, or the
	 *  active character isn't one of them): single-character users see no change */
	jumperLabel: function(opts, characters, activeId) {
		const ids = multiTrack.optedIn(opts, characters);
		if (ids.length < 2 || !multiTrack.tracking(activeId)) { return ""; }
		const id = String(activeId);
		if (ids.indexOf(id) < 0) { return ""; }
		return String(characters[id].characterName || "");
	},

	/** A long chip name keeps its start and its end (alts often share a first word: "Bob Scout" / "Bob Hauler") */
	shortName: function(name, max) {
		const s = String(name === undefined || name === null ? "" : name);
		const n = typeof max === "number" ? max : multiTrack.NAME_CHARS;
		if (s.length <= n) { return s; }
		const tail = Math.ceil((n - 1) / 2), head = n - 1 - tail;
		return s.substring(0, head).replace(/\s+$/, "") + "…" + s.substring(s.length - tail).replace(/^\s+/, "");
	},

	/** "2:41" */
	clock: function(ms) {
		const s = Math.max(0, Math.ceil((ms || 0) / 1000));
		return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
	},

	/** What a chip shows. ctx: {activeId, jumps: {id: at}, now, queued: {id: true}, used: [ids], pausedMs, stale: {id: reason}} */
	chipState: function(char, ctx) {
		const c = char || {};
		const x = ctx || {};
		const id = String(c.characterID);
		const now = x.now || 0;
		const j = x.jumps && x.jumps[id];
		const at = typeof j === "number" ? j : (j && typeof j.at === "number" ? j.at : null);
		const since = typeof at === "number" ? now - at : null;
		const active = multiTrack.tracking(x.activeId) && String(x.activeId) === id;
		return {
			id: id,
			name: String(c.characterName || ""),
			active: active,
			recent: since !== null && since >= 0 && since < multiTrack.RECENT_MS,
			fresh: since !== null && since >= 0 && since < multiTrack.FRESH_MS,
			offline: c.online === false,
			queued: !!(x.queued && x.queued[id]),
			mapped: !x.used || x.used.indexOf(id) >= 0,
			paused: active && (x.pausedMs || 0) > 0,
			pausedMs: active ? Math.max(0, x.pausedMs || 0) : 0,
			stale: (x.stale && x.stale[id]) || "",
			latest: !!(x.latestId && String(x.latestId) === id),
			silent: !!(j && typeof j === "object" && j.kind === "mapped"),
			route: j && typeof j === "object" && j.fromName ? j.fromName + " → " + j.toName : "",
			stayedOn: j && typeof j === "object" ? j.stayedOn || "" : "",
			systemName: c.systemName || "",
			ship: c.shipTypeName || "",
			agoSeconds: since !== null && since >= 0 ? Math.floor(since / 1000) : null
		};
	},

	/** A chip's tooltip, plain text (escaped where it is set) */
	chipTitle: function(state) {
		const parts = [state.name];
		const where = [state.systemName, state.ship].filter(Boolean).join(", ");
		if (where) { parts.push(where); }
		if (state.offline) { parts.push("offline"); }
		else if (state.stale) { parts.push("location not updating (" + state.stale + ")"); }
		if (state.active) {
			parts.push("Active character (Current System, Follow, destination)");
			if (!state.mapped) { parts.push("not switched to automatically (its A switch is off or over the 5)"); }
			if (state.paused) { parts.push("Auto-switch paused " + multiTrack.clock(state.pausedMs) + "; other characters' jumps are still mapped · click to resume"); }
		} else {
			parts.push("Click to make this the active character");
		}
		if (state.queued) { parts.push("switches to it when you close the open jump question"); }
		if (state.recent && state.agoSeconds !== null) {
			if (state.silent) {
				parts.push("mapped " + (state.route ? state.route + " " : "") + state.agoSeconds + " s ago" + (state.stayedOn ? " (stayed on " + state.stayedOn + ")" : ""));
			} else {
				parts.push("jumped " + (state.route ? state.route + " " : "") + state.agoSeconds + " s ago");
			}
		}
		return parts.join(" · ");
	},

	/**
	 * The character a jump question (automapper "Which Signature?", signature prompt, return bookmark) is about, or null.
	 * Named whenever 2 or more characters are tracked, whether or not this feature is on; with one character no change.
	 * jumper: the jumping character ({characterID, characterName}, tripwire.client.EVE at the jump).
	 */
	whoFor: function(characters, jumper) {
		if (!jumper || !jumper.characterName || Object.keys(characters || {}).length < 2) { return null; }
		return { id: String(jumper.characterID || ""), name: String(jumper.characterName) };
	},

	/** The automapper's "Which Signature?" dialog title */
	pickerTitle: function(who) {
		return who && who.name ? "Which signature did " + who.name + " jump through?" : "Which Signature?";
	},

	/** Notice for a jump that waits while a question about another jump is open (plain text) */
	waitNotice: function(name, fromName, toName, mapped) {
		return (name || "A character") + " jumped " + (fromName || "?") + " → " + (toName || "?")
			+ " while a jump question was open. " + (mapped ? "It is mapped; Tripwire switches to it when you close this question."
				: "It is mapped and switched to as soon as you close this question.");
	},

	/** Notice after an automatic switch (plain text; the "Back to" link is added next to it) */
	switchText: function(name, fromName, toName) {
		return "Now on " + (name || "?") + " (jumped " + (fromName || "?") + " → " + (toName || "?") + ")";
	},

	/** Notice when the active character stopped being tracked */
	removedNotice: function(name) {
		return (name || "The active character") + " is no longer tracked, so no character is active now. Pick one in the tracking list, or click a character at the top.";
	},

	/** The tip's text when another character jumped while the feature is off */
	tipBody: function(data) {
		const d = data || {};
		const who = d.name || "Another of your characters";
		const route = d.fromName && d.toName ? " " + d.fromName + " → " + d.toName : " through a wormhole";
		const main = d.activeName ? "only " + d.activeName + " is mapped" : "only your active character is mapped";
		return who + " jumped" + route + ", but " + main + ". Turn on \"" + multiTrack.SETTING_TEXT + "\" in Settings > "
			+ "Wormhole Jumps & Mass and Tripwire switches to whichever character jumps.\n\nTurn tips off in Settings > General.";
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined" || typeof tripwire.EVE !== "function" || typeof tracking === "undefined") { return; }

		const debugCharacters = {};
		const state = {
			last: {}, jumps: {}, queue: [], silent: [], recent: [], pausedUntil: 0, prevActive: null, prevPicked: null, pendingBack: null,
			lastSwitch: null, stripKey: null, labelKey: null, togglesOn: null, fitLevel: 0, noticeUntil: 0
		};
		let originalLabel = null;

		function opts() { return typeof options !== "undefined" ? options : null; }
		function activeId() { const o = opts(); return o && o.tracking ? o.tracking.active : null; }
		function esiCharacters() { return (tripwire.esi && tripwire.esi.characters) || {}; }
		function esc(text) { return typeof _ !== "undefined" && _.escape ? _.escape(text) : forkSettings.escape(text); }

		/** Every linked character (plus the debug ones) */
		function characters() {
			const out = {};
			const esi = esiCharacters();
			Object.keys(esi).forEach(function(id) { if (esi[id]) { out[id] = esi[id]; } });
			Object.keys(debugCharacters).forEach(function(id) { out[id] = debugCharacters[id]; });
			return out;
		}
		function onlineOf(id) {
			if (debugCharacters[id]) { return debugCharacters[id].online !== false; }
			// What /online/ last said (esi-offline-skip.js); a failed request is not "offline"
			if (typeof esiOfflineSkip !== "undefined" && esiOfflineSkip.states) { return esiOfflineSkip.states[id] !== "offline"; }
			const $bar = $("#tracking .tracking-clone[data-characterid='" + id + "'] .online");
			return !($bar.length && $bar.hasClass("critical"));
		}
		/** Why a character's location isn't updating ("" if it is): expired token, or ESI paused for it */
		function staleOf(id) {
			const c = esiCharacters()[id];
			if (!c) { return debugCharacters[id] && debugCharacters[id].stale || ""; }
			try {
				if (c.tokenExpire && typeof moment === "function" && moment.utc(c.tokenExpire).isBefore(moment())) { return "token expired"; }
				if (typeof esiLimits !== "undefined" && esiLimits.pausedFor("char:" + id) > 0) { return "ESI paused"; }
			} catch (e) { /* unknown: say nothing */ }
			return "";
		}
		function systemName(id) {
			const s = tripwire.systems && tripwire.systems[id];
			return s && s.name ? s.name : String(id);
		}
		function pausedMs() { return Math.max(0, state.pausedUntil - Date.now()); }

		// ---- Making a character the active one (mirrors tracking.js's click handler) ----

		function markActive(id) {
			$("#tracking .tracking-clone").removeClass("active");
			$("#tracking .tracking-clone[data-characterid='" + id + "']").addClass("active");
			$("#removeESI").removeAttr("disabled");
			if (typeof set_tracking_text === "function") { set_tracking_text(); }
			const c = characters()[id];
			if (c && !esiCharacters()[id]) {	// a debug character: set_tracking_text only knows ESI characters
				$("#user-track-name").text(c.characterName || "");
				$("#user-track").show();
				$("#user-no-track").hide();
			}
		}

		function setActive(id) {
			const o = opts();
			const prev = multiTrack.tracking(o.tracking.active) ? String(o.tracking.active) : null;
			if (prev && prev !== String(id)) { state.prevPicked = prev; }
			o.tracking.active = String(id);
			state.prevActive = String(id);
			markActive(String(id));
		}

		/**
		 * Map a jump of a character that isn't the active one, without switching: the automapper reads the jumper from
		 * tripwire.client.EVE (its station / pod checks, automap.character) and builds its request (and its "Which
		 * Signature?" answer) during the call, so it gets the jumper's context for the call and the active character's
		 * back right after. Current System, Follow and the jump pop-ups (which hook tripwire.EVE) don't fire. Returns false
		 * when it can't run now (the automapper's dialog is open): the caller keeps the jump for later.
		 */
		function silentMap(move) {
			// One question at a time: not while "Which Signature?" or the signature prompt is on screen
			if (questionVisible() || typeof tripwire.autoMapper !== "function") { return false; }
			const char = characters()[move.id] || {};
			const saved = tripwire.client.EVE;
			tripwire.client.EVE = Object.assign({}, saved || {}, {
				characterID: char.characterID || move.id, characterName: char.characterName, systemID: move.from,
				systemName: (move.before && move.before.systemName) || systemName(move.from),
				stationID: null, stationName: null, shipTypeID: char.shipTypeID || (move.before && move.before.shipTypeID) || null,
				shipTypeName: char.shipTypeName || null, systemChange: false
			});
			try { tripwire.autoMapper(move.from, move.to); }
			catch (e) { console.warn("multi-track: could not map " + move.id + "'s jump", e); }
			finally { tripwire.client.EVE = saved; }
			move.mapped = true;
			const ring = state.jumps[move.id];
			if (ring && ring.from == move.from && ring.to == move.to) {
				ring.kind = "mapped";
				ring.stayedOn = saved && saved.characterName && String(saved.characterID) !== String(move.id) ? saved.characterName : "";
			}
			if (typeof forkUsage !== "undefined") { forkUsage.track("multiTrack", "mapped"); }
			return true;
		}

		/** Switch to a character after its queued jumps (all of them, in order: multiTrack.replayPlan) */
		function switchTo(moves) {
			const o = opts();
			const chars = characters();
			const id = moves[0].id;
			const char = chars[id];
			if (!o || !char) { return; }
			try {
				const plan = multiTrack.replayPlan(moves, char.systemID);
				const backId = multiTrack.tracking(o.tracking.active) && chars[o.tracking.active] && String(o.tracking.active) !== id ? String(o.tracking.active) : null;
				const first = moves[0], last = moves[moves.length - 1];
				// The silent maps run before the switch (the active character's context is restored after each)
				const silentFirst = { silent: plan.silent, steps: [] };
				const deferred = multiTrack.runReplay(silentFirst, moves, { silentMap: silentMap, eve: function() {}, blocked: pickerOpen });
				setActive(id);
				const eve = function(step) {
					tripwire.EVE(Object.assign({}, char, {
						systemID: step.systemID, systemName: systemName(step.systemID),
						stationID: step.characterChange && step.systemID != char.systemID ? null : char.stationID,
						stationName: step.characterChange && step.systemID != char.systemID ? null : char.stationName
					}), step.characterChange);
				};
				multiTrack.runReplay({ silent: [], steps: plan.steps }, moves, { silentMap: silentMap, eve: eve, blocked: pickerOpen })
					.concat(deferred).forEach(function(m) { if (state.silent.indexOf(m) < 0) { state.silent.push(m); } });
				// Not saved: the switch is this session's state. The next save the user makes carries it; a reload goes back
				// to the last saved active character. (Saving here let a background tab overwrite settings changed elsewhere.)
				state.lastSwitch = backId ? { prevId: backId, toId: id, from: first.from, to: first.to, at: Date.now() } : null;
				showSwitchNotice(char, first.from, last.to, backId ? chars[backId] : null);
				if (typeof forkUsage !== "undefined") { forkUsage.track("multiTrack", "switched"); }
			} catch (e) {
				console.warn("multi-track: could not switch to " + id, e);
			}
		}

		/** The character an automatic switch just left took the same hole a poll later: it was leading, go back quietly */
		function switchBack(move) {
			const char = characters()[move.id];
			if (!char) { return; }
			setActive(move.id);
			tripwire.EVE(char, true);
			state.lastSwitch = null;
			hideNotice();
		}

		/** The user picks a character (chip, Back link, palette): like a click in the tracking list. Pauses automatic
		 *  switching for a while (other characters' jumps are still mapped), so the pick isn't overridden. */
		function pick(id) {
			const o = opts();
			const char = characters()[id];
			if (!o || !char) { return false; }
			// Jumps that were waiting to switch are mapped now instead
			state.queue.forEach(function(m) { if (!m.mapped) { state.silent.push(m); } });
			multiTrack.afterPick(state, Date.now());
			state.lastSwitch = null;
			if (String(o.tracking.active) !== String(id)) {
				setActive(id);
				tripwire.EVE(char, true);
				o.save();
			} else {
				markActive(String(id));
				if (!tripwire.client.EVE || String(tripwire.client.EVE.characterID) !== String(id)) { tripwire.EVE(char, true); }
			}
			hideNotice();
			render();
			return true;
		}

		// ---- Notice after an automatic switch: "Now on X (jumped A → B) · Back to Y" (one at a time) ----

		function hideNotice() {
			state.noticeUntil = 0;
			$("#multi-track-notice").remove();
		}
		function showSwitchNotice(char, from, to, back) {
			hideNotice();
			const $n = $("<div id='multi-track-notice' role='status' aria-live='polite'></div>");
			$n.append($("<span class='multi-track-notice-text'></span>").text(multiTrack.switchText(char.characterName, systemName(from), systemName(to))));
			if (back) {
				$n.append(" · ", $("<button type='button' class='multi-track-back'></button>")
					.text("Back to " + back.characterName).attr("data-characterid", String(back.characterID)));
			}
			$n.append($("<button type='button' class='multi-track-notice-close' aria-label='Close'>✕</button>"));
			$("body").append($n);
			state.noticeUntil = Date.now() + multiTrack.NOTICE_MS;
		}
		/** The notice stays while a question about the jump it announced is open, or while hovered; then goes */
		function ageNotice(now) {
			const $n = $("#multi-track-notice");
			if (!$n.length) { return; }
			if (questionVisible() || $n.is(":hover")) { state.noticeUntil = Math.max(state.noticeUntil, now + 3000); }
			if (now > state.noticeUntil) { hideNotice(); }
		}
		$(document).on("click", "#multi-track-notice .multi-track-back", function(e) {
			e.preventDefault();
			if (pick($(this).attr("data-characterid")) && typeof forkUsage !== "undefined") { forkUsage.track("multiTrack", "back"); }
		});
		$(document).on("click", "#multi-track-notice .multi-track-notice-close", function(e) { e.preventDefault(); hideNotice(); });

		// ---- The tick: in memory only (its only requests are the automapper's, for jumps it maps) ----

		function pickerOpen() { return typeof automapState !== "undefined" && !!automapState.pendingDecision; }
		/** A question about the last jump is on screen ("Which Signature?", the signature prompt) */
		function questionVisible() { return pickerOpen() || $("#jump-sig-panel").length > 0; }
		/** ...or may still come (the signature prompt's retries): switching waits, so the question isn't wiped. The
		 *  return-bookmark panel is passive (nothing to answer), so it doesn't hold anything. */
		function questionPending() {
			try {
				if (questionVisible()) { return true; }
				if (typeof jumpSigPrompt !== "undefined" && typeof jumpSigPrompt.busy === "function" && jumpSigPrompt.busy()) { return true; }
			} catch (e) { /* assume nothing is open */ }
			return false;
		}

		function tick() {
			const o = opts();
			if (!o || !o.tracking) { return; }
			const chars = characters();
			const now = Date.now();
			const on = multiTrack.enabled(o);

			if (on) {
				// The active character was removed from tracking: nothing is active any more (the header via upstream's own path)
				if (state.prevActive && !chars[state.prevActive]) {
					if (String(o.tracking.active) === state.prevActive) {
						o.tracking.active = null;
						try { tripwire.EVE(false, true); } catch (e) { /* the header just keeps its text */ }
						if (typeof set_tracking_text === "function") { set_tracking_text(); }
						$("#removeESI").attr("disabled", "disabled");
					}
					if (typeof Notify !== "undefined") { Notify.trigger(esc(multiTrack.removedNotice(state.prevName || "")), "yellow", 10000); }
					state.prevActive = null;
				}
				if (multiTrack.tracking(o.tracking.active) && chars[o.tracking.active]) {
					state.prevActive = String(o.tracking.active);
					state.prevName = chars[o.tracking.active].characterName;
				}
			}

			const result = multiTrack.detectMoves(state.last, chars, Object.keys(chars), o.tracking.active);
			state.last = result.last;
			const ctx = { systems: tripwire.systems, shortest: tripwire.map && tripwire.map.shortest };
			const jumps = result.moves.filter(function(m) { return multiTrack.isMappableJump(m.from, m.to, chars[m.id], ctx); });
			// "Who just jumped": every wormhole jump, active included (silentMap marks the ones it maps without switching)
			jumps.forEach(function(m) {
				m.at = now;
				state.jumps[m.id] = { at: now, kind: "jumped", from: m.from, to: m.to, fromName: systemName(m.from), toName: systemName(m.to) };
			});

			if (!on) {
				state.queue = [];
				state.silent = [];
				const active = chars[o.tracking.active];
				jumps.filter(function(m) { return !m.active; }).forEach(function(m) {
					if (typeof forkHints !== "undefined" && active) {
						forkHints.emit("tracking.otherJump", {
							id: m.id, name: chars[m.id].characterName, fromName: systemName(m.from), toName: systemName(m.to),
							activeName: active.characterName
						});
					}
				});
				render();
				return;
			}

			// The character an automatic switch left took the same hole a poll late (a fleet jump it led): back to it. Not
			// while a question is on screen (it would wipe it): re-checked, from the jump's own time, once it closes.
			const back = jumps.filter(function(m) { return multiTrack.switchBack(m, state.lastSwitch, now, multiTrack.FLEET_MS); })[0];
			if (back) { state.pendingBack = back; }
			if (state.pendingBack && !questionVisible()) {
				const pb = state.pendingBack;
				state.pendingBack = null;
				if (multiTrack.switchBack(pb, state.lastSwitch, now, multiTrack.FLEET_MS)) { switchBack(pb); }
			}

			const used = multiTrack.optedIn(o, chars);
			const plan = multiTrack.planMoves(jumps.filter(function(m) { return m !== back; }), {
				recent: state.recent, now: now, windowMs: multiTrack.FLEET_MS,
				keepSince: state.queue.length ? state.queue[0].at : now,
				paused: pausedMs() > 0,
				eligible: function(id) { return used.indexOf(id) >= 0 && multiTrack.tracking(o.tracking.active); }
			});
			state.recent = plan.recent;
			plan.decisions.forEach(function(d) {
				if (d.action === "switch") { state.queue.push(d.move); }
				// "fleet": the active character's automap of that hole may be cancelled in its dialog; the automapper finds
				// the connection when it isn't, so mapping it again costs nothing
				else if (d.action === "map" || d.action === "fleet") { state.silent.push(d.move); }
			});

			// Jumps mapped without switching: one per tick, never while a jump question is on screen, and not until a sync
			// after one closed (its answer must reach the map first, or the automapper would ask the same question again)
			if (questionVisible()) { state.questionAt = now; }
			if (state.silent.length && !questionVisible() && now - (state.questionAt || 0) >= multiTrack.AFTER_QUESTION_MS) {
				const next = state.silent.shift();
				if (next.mapped || !silentMap(next)) { if (!next.mapped) { state.silent.unshift(next); } }
			}

			if (state.queue.length) {
				const id = state.queue[0].id;
				const mine = state.queue.filter(function(m) { return m.id === id; });
				if (questionPending()) {
					// Hold the switch so the open question isn't wiped; map the jumps meanwhile (unless the dialog is that question)
					mine.forEach(function(m) { if (!m.mapped) { silentMap(m); } });
					if (questionVisible()) {
						mine.forEach(function(m) {
							if (m.noticed) { return; }
							m.noticed = true;
							if (typeof Notify !== "undefined") {
								Notify.trigger(esc(multiTrack.waitNotice(chars[id] && chars[id].characterName, systemName(m.from), systemName(m.to), !!m.mapped)), "yellow", 8000);
							}
						});
					}
				} else if (now - state.queue[0].at >= multiTrack.SETTLE_MS) {
					state.queue = state.queue.filter(function(m) { return m.id !== id; });
					// Checked again: the active character may have taken the same hole meanwhile (a poll later), or be there now
					const activeNow = chars[o.tracking.active];
					const due = multiTrack.releaseDecision(mine, {
						recent: state.recent.filter(function(r) { return r.by !== id; }), windowMs: multiTrack.FLEET_MS, now: now,
						activeSystemID: activeNow ? activeNow.systemID : null, currentSystemID: chars[id] ? chars[id].systemID : null
					});
					if (due.action === "switch") { switchTo(mine); }
					else { due.map.forEach(function(m) { if (state.silent.indexOf(m) < 0) { state.silent.push(m); } }); }
				}
			}
			ageNotice(now);
			render();
		}

		// ---- Header: chips and "Current System (name)" ----

		function attachTip($el) { if (typeof Tooltips !== "undefined" && $el.length) { Tooltips.attach($el); } }
		/** Set a tooltip (jBox shows it as HTML, so it is escaped here) and the open tooltip's text when it shows for $el */
		function setTip($el, text) {
			const html = esc(text);
			if (!$el.length || $el.attr("data-tooltip") === html) { return; }
			$el.attr({ "data-tooltip": html, "aria-label": text });
			if (typeof Tooltips !== "undefined" && Tooltips.isOpen && Tooltips.source && Tooltips.source[0] === $el[0] && typeof Tooltips.setContent === "function") {
				Tooltips.setContent(html);
			}
		}

		function render() {
			const o = opts();
			const chars = characters();
			const on = multiTrack.enabled(o);
			syncToggles(on, chars);
			renderLabel(multiTrack.jumperLabel(o, chars, activeId()));
			const ids = on ? multiTrack.stripIds(o, chars, activeId()) : [];
			if (ids.length < 2) {
				if (state.stripKey !== null) { $("#multi-track-strip").remove(); state.stripKey = null; fit(true); }
				return;
			}
			const now = Date.now();
			const used = multiTrack.optedIn(o, chars);
			const queued = {};
			state.queue.forEach(function(m) { queued[m.id] = true; });
			const stale = {};
			ids.forEach(function(id) { stale[id] = staleOf(id); });
			const latest = multiTrack.latestJumper(state.jumps, now);
			const states = ids.map(function(id) {
				return multiTrack.chipState(Object.assign({}, chars[id], { characterID: id, online: onlineOf(id) }),
					{ activeId: activeId(), jumps: state.jumps, now: now, queued: queued, used: used, pausedMs: pausedMs(), stale: stale, latestId: latest });
			});
			const key = JSON.stringify(states.map(function(s) { return [s.id, s.name, s.active, s.recent, s.fresh, s.offline, s.queued, s.paused, s.mapped, s.latest, s.silent]; }));
			let $strip = $("#multi-track-strip");
			let rebuilt = false;
			if (key !== state.stripKey || !$strip.length) {
				state.stripKey = key;
				rebuilt = true;
				$strip.remove();
				// Next to the "Current System" heading, not inside it (the heading's name stays as it is)
				$strip = $("<span id='multi-track-strip' role='group' aria-label='Your tracked characters'></span>")
					.append("<h3 class='multi-track-sep' aria-hidden='true'>|</h3>");
				states.forEach(function(s) {
					const $chip = $("<button type='button' class='multi-track-chip'></button>")
						.attr({ "data-characterid": s.id, "aria-pressed": s.active ? "true" : "false" })
						.toggleClass("is-active", s.active).toggleClass("is-recent", s.recent)
						.toggleClass("is-fresh", s.fresh).toggleClass("is-offline", s.offline)
						.toggleClass("is-queued", s.queued).toggleClass("is-paused", s.paused).toggleClass("is-unmapped", !s.mapped)
						.toggleClass("is-latest", s.latest).toggleClass("is-silent", s.silent);
					const $img = $("<img class='multi-track-avatar' alt='' width='18' height='18' />")
						.attr("src", "https://image.eveonline.com/Character/" + encodeURIComponent(s.id) + "_32.jpg")
						.on("error", function() { $(this).replaceWith($("<span class='multi-track-avatar multi-track-initial' aria-hidden='true'></span>").text(s.name.charAt(0) || "?")); });
					$chip.append($img, $("<span class='multi-track-name'></span>").text(multiTrack.shortName(s.name)));
					if (s.paused) { $chip.append($("<span class='multi-track-pause'></span>"), $("<span class='multi-track-pause-glyph' aria-hidden='true'>⏸</span>")); }
					$strip.append($chip);
				});
				const hidden = states.filter(function(s) { return !s.active && !s.recent; });
				if (hidden.length) {	// shown only when the header is too narrow for every chip (fit)
					$strip.append($("<span class='multi-track-more'></span>").text("+" + hidden.length));
					setTip($strip.find(".multi-track-more"), hidden.map(function(s) { return s.name; }).join(", "));
				}
				$("h3#systemSearch").first().after($strip);
			}
			states.forEach(function(s) {	// "jumped 12 s ago" / the pause countdown change every tick: text only
				const $chip = $strip.find(".multi-track-chip[data-characterid='" + s.id + "']");
				setTip($chip, multiTrack.chipTitle(s));
				if (s.paused) { $chip.find(".multi-track-pause").text("paused " + multiTrack.minutes(s.pausedMs)); }
			});
			if (rebuilt) { attachTip($strip.find("[data-tooltip]")); }
			$strip.toggle(!$("#search").hasClass("active"));	// the system search box takes this place
			fit(rebuilt);
		}

		// Keep the header on one line: a long tracked name top right capped, chip names off, then only the active / last
		// jumper (+N), then no strip, then no name in "Current System", then the top-right name capped shorter. The
		// classes go on #topbar (the strip and the labels read them).
		const FIT_STEPS = ["mt-capuser", "mt-compact", "mt-min", "mt-nostrip", "mt-noname", "mt-capuser-tight"];
		const FIT_LEVELS = FIT_STEPS.map(function(c, i) { return FIT_STEPS.slice(0, i).join(" "); }).concat([FIT_STEPS.join(" ")]);
		const FIT_CLASSES = FIT_STEPS.join(" ");
		function headerWrapped() {
			const left = document.querySelector("#topbar > .align-left");
			const right = document.querySelector("#topbar > .align-right");
			if (!left || !right) { return false; }
			return right.getBoundingClientRect().top > left.getBoundingClientRect().top + 5;
		}
		/** fromStart: try the roomiest level first (after a resize or a change); else only tighten when wrapped */
		function fit(fromStart) {
			const $bar = $("#topbar");
			if (!$("#multi-track-strip").length && !$(".multi-track-who-wrap").length) {
				if (state.fitLevel) { $bar.removeClass(FIT_CLASSES); state.fitLevel = 0; }
				return;
			}
			if (!fromStart && !headerWrapped()) { return; }
			let level = fromStart ? 0 : (state.fitLevel || 0);
			for (; level < FIT_LEVELS.length; level++) {
				$bar.removeClass(FIT_CLASSES).addClass(FIT_LEVELS[level]);
				if (!headerWrapped()) { break; }
			}
			state.fitLevel = Math.min(level, FIT_LEVELS.length - 1);
		}
		let resizeTimer = null;
		$(window).on("resize", function() {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(function() { try { fit(true); } catch (e) { /* the next render */ } }, 150);
		});
		$("#search").on("click", function() { setTimeout(function() { try { render(); fit(true); } catch (e) { /* the next tick */ } }, 0); });

		function renderLabel(name) {
			const $label = $("#currentSpan > .pointer").first();
			if (!$label.length) { return; }
			if (originalLabel === null) { originalLabel = $label.text(); }
			if (name === state.labelKey || (!name && state.labelKey === null)) { return; }	// off: never touched
			state.labelKey = name;
			if (name) {
				$label.text("Current System").append(
					$("<span class='multi-track-who-wrap'></span>").append(" (", $("<span class='multi-track-who'></span>").text(name).attr("title", name), ")"), ": ");
			} else {
				$label.text(originalLabel);
			}
			setTimeout(function() { fit(true); }, 0);	// the label changes the header's width
		}

		// ---- Tracking list: an "auto-map this character's jumps" switch per character, only while the feature is on ----
		// Looks like the eye / ship icons next to it (orange when on), but is not `.interactable`: tracking.js's handler
		// for those would write a character option.

		function syncToggles(on, chars) {
			const o = opts();
			if (!on) {
				if (state.togglesOn !== false) {
					$("#tracking .multi-track-toggle, #tracking .multi-track-cap-note").remove();
					$("#tracking .multi-track-has-toggle").removeClass("multi-track-has-toggle");
					state.togglesOn = false;
				}
				return;
			}
			state.togglesOn = true;
			const used = multiTrack.optedIn(o, chars || characters());
			$("#tracking .tracking-clone").each(function() {
				const id = $(this).attr("data-characterid");
				if (!id) { return; }
				const included = !multiTrack.excluded(o, id);
				const overCap = included && used.indexOf(id) < 0;
				let $t = $(this).find(".multi-track-toggle");
				if (!$t.length) {
					$t = $("<i class='multi-track-toggle' data-icon='auto' role='switch' tabindex='0'></i>");
					$(this).find(".control-group").first().addClass("multi-track-has-toggle").append($t);
					setTip($t, multiTrack.toggleTitle(included, overCap));
					attachTip($t);
				}
				$t.toggleClass("active", included).toggleClass("over-cap", overCap).attr("aria-checked", String(included));
				setTip($t, multiTrack.toggleTitle(included, overCap));
			});
			// More switched on than are used: say so above the list
			const note = multiTrack.capNote(o, chars || characters());
			let $note = $("#tracking .multi-track-cap-note");
			if (!note) { $note.remove(); return; }
			if (!$note.length) { $note = $("<div class='multi-track-cap-note' role='note'></div>").prependTo("#tracking"); }
			if ($note.text() !== note) { $note.text(note); }
		}

		function toggle(id) {
			const o = opts();
			if (!o || !id) { return; }
			const mt = o.multiTrack = Object.assign({ enabled: true }, o.multiTrack);
			mt.exclude = Object.assign({}, mt.exclude);
			if (mt.exclude[id]) { delete mt.exclude[id]; } else { mt.exclude[id] = true; }
			state.queue = state.queue.filter(function(m) { return m.id !== id; });
			o.save();
			render();
		}

		$("#track").on("click", ".multi-track-toggle", function(e) {
			e.stopPropagation();	// not a click on the character (that makes it active)
			toggle($(this).closest(".tracking-clone").attr("data-characterid"));
		});
		$("#track").on("keydown", ".multi-track-toggle", function(e) {
			if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle($(this).closest(".tracking-clone").attr("data-characterid")); }
		});
		// A pick in the tracking list (upstream's handler ran first: bound earlier on #track) pauses automatic switching too
		$("#track").on("click", ".tracking-clone", function() {
			if (multiTrack.tracking(activeId())) {
				state.queue.forEach(function(m) { if (!m.mapped) { state.silent.push(m); } });
				multiTrack.afterPick(state, Date.now());
				state.lastSwitch = null;
				state.prevActive = String(activeId());
			}
			render();
		});
		$("#topbar").on("click", ".multi-track-chip", function(e) {
			e.preventDefault();
			const id = $(this).attr("data-characterid");
			if (String(activeId()) === id) {
				if (pausedMs() > 0) { state.pausedUntil = 0; render(); }	// "click to resume"
				return;
			}
			if (pick(id) && typeof forkUsage !== "undefined") { forkUsage.track("multiTrack", "chip"); }
		});

		// A character added to the tracking list gets its switch right away
		const originalAdd = tracking.add;
		tracking.add = function() {
			const $clone = originalAdd.apply(this, arguments);
			try { state.togglesOn = null; syncToggles(multiTrack.enabled(opts())); } catch (e) { /* the next tick adds it */ }
			return $clone;
		};

		setInterval(function() {
			try { tick(); } catch (e) { console.warn("multi-track: tick failed", e); }
		}, multiTrack.TICK_MS);

		// ---- Settings > Wormhole Jumps & Mass (takes effect on Save; Reset deletes options.multiTrack = off) ----
		if (typeof forkSettings !== "undefined") {
			forkSettings.register({
				section: "jumps", order: 5, id: "multiTrack-enabled", type: "checkbox", key: "multiTrack",
				label: "My characters:",
				text: multiTrack.SETTING_TEXT,
				hint: "When one of your tracked characters jumps a wormhole, Tripwire makes it your active character (Current "
					+ "System, Follow and the jump prompts move to it) and maps the jump. Picking a character yourself pauses "
					+ "the switching for 3 minutes; their jumps are still mapped. Up to 5 characters: choose them with the A "
					+ "icon (Switch to this character when it jumps) next to the eye and ship icons in the tracking list "
					+ "(click your name, top right).",
				keywords: ["multi", "multibox", "alts", "characters", "tracking", "active character", "switch"],
				get: function(o) { return multiTrack.enabled(o); },
				set: function(o, on) {
					o.multiTrack = Object.assign({ exclude: {} }, o.multiTrack, { enabled: !!on });
					if (!on) { state.queue = []; }
				}
			});
		}

		// ---- Ctrl+K: "Switch to <character>" (a manual pick: works with the feature off too; its own catalog entry) ----
		if (typeof forkCommands !== "undefined") {
			forkCommands.register(Object.assign(multiTrack.switchCommand({
				characters: characters, activeId: activeId, prevId: function() { return state.prevPicked; }, pick: pick
			}), { id: "tracking.switchTo" }));
		}

		// ---- Tip: another character jumped while this is off ----
		if (typeof forkHints !== "undefined") {
			forkHints.register({
				id: "multiTrack.otherJump", feature: "multiTrack", section: "jumps",
				trigger: "tracking.otherJump", kind: "toast",
				eligible: function(ctx, data) { return !!data && !multiTrack.enabled(ctx.options); },
				title: "Map your other characters' jumps too?",
				body: function(ctx, data) { return multiTrack.tipBody(data); },
				action: { label: "Open Settings", run: function() {
					const row = document.getElementById("multiTrack-enabled");
					const tr = row && row.closest("tr");
					if (tr && typeof commandPalette !== "undefined" && typeof commandPalette.openSetting === "function") { commandPalette.openSetting(tr); }
					else { $("#settings").trigger("click"); }
				} },
				priority: 50, maxShows: 2, cooldownHours: 72, ttlSeconds: 600
			});
		}

		// ---- Debug / dev stack: fake characters (never put into tripwire.esi.characters: the ESI poller would call CCP
		// with a fake token, and the next esi.parse deletes unknown characters) ----
		multiTrack.debug = {
			add: function(c) {
				if (!c || !c.characterID) { return null; }
				const id = String(c.characterID);
				debugCharacters[id] = Object.assign({ characterName: "Character " + id, online: true }, c, { characterID: id });
				if (c.systemID && !c.systemName) { debugCharacters[id].systemName = systemName(c.systemID); }
				if (!$("#tracking .tracking-clone[data-characterid='" + id + "']").length) {
					// tracking.add reads upstream's leaked global `characterID` (esi.parse's loop variable)
					const had = Object.prototype.hasOwnProperty.call(window, "characterID"), prev = window.characterID;
					window.characterID = id;
					let $clone;
					try { $clone = tracking.add(debugCharacters[id]); }
					finally { if (had) { window.characterID = prev; } else { try { delete window.characterID; } catch (e) { window.characterID = undefined; } } }
					$clone.attr("data-characterid", id);
					$clone.find(".system").text(debugCharacters[id].systemName || "");
					$clone.find(".ship").text(debugCharacters[id].shipTypeName || "");
					$clone.find(".online").toggleClass("stable", debugCharacters[id].online !== false).toggleClass("critical", debugCharacters[id].online === false);
				}
				tick();
				return debugCharacters[id];
			},
			/** Move one character, or several at once (an array of ids: a fleet jump seen in the same location poll) */
			move: function(id, systemID, extra) {
				const list = (Array.isArray(id) ? id : [id]).map(function(i) { return debugCharacters[String(i)]; }).filter(Boolean);
				if (!list.length) { return null; }
				list.forEach(function(c) {
					Object.assign(c, { systemID: systemID, systemName: systemName(systemID) }, extra || {});
					$("#tracking .tracking-clone[data-characterid='" + c.characterID + "'] .system").text(c.systemName);
				});
				// The active one: what upstream's location poll does for an active ESI character
				const active = list.filter(function(c) { return String(c.characterID) === String(activeId()); })[0];
				if (active) { tripwire.EVE(active); }
				tick();
				return { active: activeId(), queue: state.queue.length };
			},
			set: function(id, props) {
				const c = debugCharacters[String(id)];
				if (c) { Object.assign(c, props || {}); tick(); }
				return c || null;
			},
			remove: function(id) {
				delete debugCharacters[String(id)];
				$("#tracking .tracking-clone[data-characterid='" + id + "']").remove();
				tick();
			},
			resume: function() { state.pausedUntil = 0; render(); },
			state: function() { return { queue: state.queue.slice(), silent: state.silent.slice(), jumps: state.jumps, recent: state.recent, pausedMs: pausedMs(), lastSwitch: state.lastSwitch, last: state.last }; },
			tick: tick
		};
		multiTrack.pick = pick;
		multiTrack.characters = characters;
		/** The character a jump question is about ({id, name}), or null: the one tripwire.EVE just moved (call it at the
		 *  jump, not later). Used by jump-return.js, jump-sig-prompt.js and the automapper's dialog below. */
		multiTrack.jumperNow = function() { return multiTrack.whoFor(characters(), tripwire.client && tripwire.client.EVE); };

		/** "[portrait] Alt One <rest>" for a jump question (text only: no markup from the name) */
		function whoBanner(who, rest) {
			const $b = $("<div class='jump-who-banner'></div>");
			$("<img class='jump-who-avatar' alt='' width='28' height='28' />")
				.attr("src", "https://image.eveonline.com/Character/" + encodeURIComponent(who.id) + "_64.jpg")
				.on("error", function() { $(this).remove(); }).appendTo($b);
			const $text = $("<span class='jump-who-text'></span>").append($("<span class='jump-who'></span>").text(who.name));
			if (rest) { $text.append($("<span class='jump-who-rest'></span>").text(" " + rest)); }
			return $b.append($text);
		}
		multiTrack.whoBanner = whoBanner;

		// ---- The automapper's "Which Signature?" dialog names the character that jumped ----
		// automapper.js builds its answer (from, to, automap.character) when the jump happens, so a switch while the dialog
		// is open can't credit another character (and the tick holds switches until it closes); the dialog only has to
		// say whose jump it is. Named with 2+ tracked characters, whether or not "Map jumps of all" is on.
		let pickerWho = null;
		if (typeof tripwire.autoMapper === "function") {
			const originalAutoMapper = tripwire.autoMapper;
			tripwire.autoMapper = function() {
				try { pickerWho = multiTrack.jumperNow(); } catch (e) { pickerWho = null; }
				try { return originalAutoMapper.apply(this, arguments); }
				finally { pickerWho = null; }	// the dialog opens synchronously inside the call
			};
		}
		$(document).on("dialogopen", "#dialog-select-signature", function() {
			const $d = $(this);
			$d.find(".jump-who-banner").remove();
			const who = pickerWho;
			$d.dialog("option", "title", multiTrack.pickerTitle(who));	// jQuery UI 1.13 sets the title as text
			if (who) { $d.prepend(whoBanner(who, "jumped through an unknown hole")); }
		});
	});
}
