const multiTrack = {
	// Fork-owned: multi-character jump tracking (opt-in, Settings > Wormhole Jumps & Mass). Tripwire already polls ESI
	// for every linked character; only the "active" one drives the automapper. With this on, when another of your
	// opted-in characters jumps through a wormhole, it becomes the active character and the jump is replayed through
	// tripwire.EVE, so the automapper, the return-bookmark pop-up, the signature prompt and Follow all work for it.
	// A strip of character chips next to "Current System" shows who is active and who jumped last.
	// No new ESI requests, endpoints or polling: the 1 s tick only reads tripwire.esi.characters (filled by upstream's
	// 5 s location poll). Spec: changes/2026-10-30-multi-character-jumps/README.md.
	// Keep `const multiTrack` on the first line: the test helper strips it to define a global.

	CAP: 5,						// opted-in characters used for the strip and switching (linking stays unlimited)
	TICK_MS: 1000,
	RECENT_MS: 60000,			// the last jumper is highlighted this long
	FRESH_MS: 10000,			// ...and pulses for the first part of it
	SAVE_DELAY_MS: 10000,		// several switches in a row cause one options save
	PODS: [33328, 670],
	NO_MAP_SYSTEMS: [30000142, 30002187],	// Jita, Amarr: likely pod-out destinations (as the automapper)
	SPECIAL_REGION: 12000000,	// abyssal and other special space (as the automapper)

	// ---- Pure logic (tested under mocha) ----

	/** On only when switched on in Settings (missing = off: it changes which character is active) */
	enabled: function(opts) {
		return !!(opts && opts.multiTrack && typeof opts.multiTrack === "object" && opts.multiTrack.enabled === true);
	},

	/** The character's "map this character's jumps" switch is off */
	excluded: function(opts, id) {
		const ex = opts && opts.multiTrack && opts.multiTrack.exclude;
		return !!(ex && typeof ex === "object" && ex[id]);
	},

	included: function(opts, id) {
		return multiTrack.enabled(opts) && !multiTrack.excluded(opts, id);
	},

	/** Ids (strings) of the included characters, sorted by name (then id), the first `cap` */
	optedIn: function(opts, characters, cap) {
		if (!multiTrack.enabled(opts) || !characters) { return []; }
		const limit = typeof cap === "number" ? cap : multiTrack.CAP;
		return Object.keys(characters)
			.filter(function(id) { return characters[id] && !multiTrack.excluded(opts, id); })
			.sort(function(a, b) {
				const na = String(characters[a].characterName || "").toLowerCase();
				const nb = String(characters[b].characterName || "").toLowerCase();
				return na < nb ? -1 : na > nb ? 1 : (a < b ? -1 : a > b ? 1 : 0);
			})
			.slice(0, limit);
	},

	/** Snapshot of what a jump needs to know about where a character was */
	snapshot: function(c) {
		return { systemID: c.systemID, systemName: c.systemName || null, stationID: c.stationID || null, shipTypeID: c.shipTypeID || null };
	},

	/**
	 * Characters that changed system since the last tick. last: {id: snapshot}. Ignores a missing systemID (keeps the
	 * old snapshot: ESI just hasn't answered yet), the first sighting, an unchanged system and the active character
	 * (upstream's own path handles that one; its snapshot is still kept, so it is right once it stops being active).
	 * Characters that are gone are dropped. Returns {moves: [{id, from, to, before}], last: newLast}.
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
			if (activeId !== null && activeId !== undefined && String(id) === String(activeId)) { return; }
			moves.push({ id: String(id), from: was.systemID, to: c.systemID, before: was });
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

	/** The active character's name for the jump pop-ups and "Current System", or "" (feature off, fewer than 2 opted
	 *  in, or the active character isn't one of them): single-character users see no change */
	jumperLabel: function(opts, characters, activeId) {
		const ids = multiTrack.optedIn(opts, characters);
		if (ids.length < 2 || activeId === null || activeId === undefined) { return ""; }
		const id = String(activeId);
		if (ids.indexOf(id) < 0) { return ""; }
		return String(characters[id].characterName || "");
	},

	/** What a chip shows. ctx: {activeId, lastJump: {id, at}, now} */
	chipState: function(char, ctx) {
		const c = char || {};
		const id = String(c.characterID);
		const now = ctx && ctx.now || 0;
		const jump = ctx && ctx.lastJump;
		const since = jump && String(jump.id) === id ? now - jump.at : null;
		return {
			id: id,
			name: String(c.characterName || ""),
			active: !!(ctx && ctx.activeId !== null && ctx.activeId !== undefined && String(ctx.activeId) === id),
			recent: since !== null && since >= 0 && since < multiTrack.RECENT_MS,
			fresh: since !== null && since >= 0 && since < multiTrack.FRESH_MS,
			offline: c.online === false,
			systemName: c.systemName || "",
			ship: c.shipTypeName || "",
			agoSeconds: since !== null && since >= 0 ? Math.floor(since / 1000) : null
		};
	},

	/** A chip's tooltip, plain text */
	chipTitle: function(state) {
		const parts = [state.name];
		const where = [state.systemName, state.ship].filter(Boolean).join(", ");
		if (where) { parts.push(where); }
		if (state.offline) { parts.push("offline"); }
		if (state.active) { parts.push("active: its jumps are mapped"); }
		else { parts.push("click to make it the active character"); }
		if (state.recent && state.agoSeconds !== null) { parts.push("jumped " + state.agoSeconds + " s ago"); }
		return parts.join(" · ");
	},

	/** The tip's text when another character jumped while the feature is off */
	tipBody: function(data) {
		const d = data || {};
		const who = d.name || "Another of your characters";
		const route = d.fromName && d.toName ? " " + d.fromName + " → " + d.toName : " through a wormhole";
		const main = d.activeName ? "only " + d.activeName + " is mapped" : "only your active character is mapped";
		return who + " jumped" + route + ", but " + main + ". Turn on \"Map jumps of all my characters\" in Settings > "
			+ "Wormhole Jumps & Mass and Tripwire switches to whichever character jumps.\n\nTurn tips off in Settings > General.";
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined" || typeof tripwire.EVE !== "function" || typeof tracking === "undefined") { return; }

		const debugCharacters = {};
		const state = { last: {}, lastJump: null, queue: [], stripKey: null, labelKey: null, togglesOn: null, fitLevel: 0 };
		let originalLabel = null;

		function opts() { return typeof options !== "undefined" ? options : null; }
		function activeId() { const o = opts(); return o && o.tracking ? o.tracking.active : null; }
		function esiCharacters() { return (tripwire.esi && tripwire.esi.characters) || {}; }

		/** Every linked character (plus the debug ones), with the online flag from the tracking list's bar */
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
		function systemName(id) {
			const s = tripwire.systems && tripwire.systems[id];
			return s && s.name ? s.name : String(id);
		}

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

		/** An opted-in character jumped a wormhole: make it active, then replay its jump through tripwire.EVE */
		function switchTo(move) {
			const o = opts();
			const char = characters()[move.id];
			if (!o || !char) { return; }
			try {
				const now = Object.assign({}, char, { systemID: move.to, systemName: char.systemID == move.to ? char.systemName : systemName(move.to) });
				if (String(o.tracking.active) === move.id) {
					// Already active (picked meanwhile): a normal jump, only if tripwire hasn't seen it yet
					if (tripwire.client.EVE && tripwire.client.EVE.systemID == move.from) { tripwire.EVE(now); }
					return;
				}
				o.tracking.active = move.id;
				markActive(move.id);
				const before = move.before || {};
				// Where it was, as a character change (no automap, no pop-ups), then the jump itself
				tripwire.EVE(Object.assign({}, char, { systemID: move.from, systemName: before.systemName || systemName(move.from), stationID: null, stationName: null }), true);
				tripwire.EVE(now);
				state.lastJump = { id: move.id, at: Date.now() };
				if (typeof o.saveDelay === "function") { o.saveDelay(multiTrack.SAVE_DELAY_MS); } else { o.save(); }
				if (typeof forkUsage !== "undefined") { forkUsage.track("multiTrack", "switched"); }
			} catch (e) {
				console.warn("multi-track: could not switch to " + move.id, e);
			}
		}

		/** A chip or the API picks a character by hand (like clicking it in the tracking list) */
		function pick(id) {
			const o = opts();
			const char = characters()[id];
			if (!o || !char || String(o.tracking.active) === String(id)) { return; }
			o.tracking.active = String(id);
			markActive(String(id));
			state.queue = state.queue.filter(function(m) { return m.id !== String(id); });
			tripwire.EVE(char, true);
			o.save();
		}

		// ---- The tick: in memory only, no requests ----

		function tick() {
			const o = opts();
			if (!o || !o.tracking) { return; }
			const chars = characters();
			const result = multiTrack.detectMoves(state.last, chars, Object.keys(chars), o.tracking.active);
			state.last = result.last;
			const ctx = { systems: tripwire.systems, shortest: tripwire.map && tripwire.map.shortest };
			const on = multiTrack.enabled(o);
			const used = on ? multiTrack.optedIn(o, chars) : [];
			result.moves.forEach(function(m) {
				const char = chars[m.id];
				if (!multiTrack.isMappableJump(m.from, m.to, char, ctx)) { return; }	// gate, dock, pod...: strip only
				if (!on) {
					const active = chars[o.tracking.active];
					if (typeof forkHints !== "undefined" && active) {
						forkHints.emit("tracking.otherJump", {
							id: m.id, name: char.characterName, fromName: systemName(m.from), toName: systemName(m.to),
							activeName: active.characterName
						});
					}
					return;
				}
				if (used.indexOf(m.id) < 0) { return; }	// excluded, or over the cap
				state.queue.push(m);	// in order: a second jump of the same character follows its first
			});
			// One switch per tick: the next character's automap request then finds the hole the first one made
			const next = state.queue.shift();
			if (next) { switchTo(next); }
			render();
		}

		// ---- Header: chips and "Current System (name)" ----

		function render() {
			const o = opts();
			const chars = characters();
			const ids = multiTrack.optedIn(o, chars);
			syncToggles(multiTrack.enabled(o));
			renderLabel(multiTrack.jumperLabel(o, chars, activeId()));
			if (ids.length < 2) {
				if (state.stripKey !== null) { $("#multi-track-strip").remove(); state.stripKey = null; }
				return;
			}
			const now = Date.now();
			const states = ids.map(function(id) {
				return multiTrack.chipState(Object.assign({}, chars[id], { characterID: id, online: onlineOf(id) }), { activeId: activeId(), lastJump: state.lastJump, now: now });
			});
			const key = JSON.stringify(states.map(function(s) { return [s.id, s.name, s.active, s.recent, s.fresh, s.offline]; }));
			let $strip = $("#multi-track-strip");
			if (key !== state.stripKey || !$strip.length) {
				state.stripKey = key;
				$strip.remove();
				$strip = $("<span id='multi-track-strip' role='group' aria-label='Your tracked characters'></span>");
				states.forEach(function(s) {
					const $chip = $("<button type='button' class='multi-track-chip'></button>")
						.attr({ "data-characterid": s.id, "aria-pressed": s.active ? "true" : "false" })
						.toggleClass("is-active", s.active).toggleClass("is-recent", s.recent)
						.toggleClass("is-fresh", s.fresh).toggleClass("is-offline", s.offline);
					const $img = $("<img class='multi-track-avatar' alt='' width='18' height='18' />")
						.attr("src", "https://image.eveonline.com/Character/" + encodeURIComponent(s.id) + "_32.jpg")
						.on("error", function() { $(this).replaceWith($("<span class='multi-track-avatar multi-track-initial' aria-hidden='true'></span>").text(s.name.charAt(0) || "?")); });
					$chip.append($img, $("<span class='multi-track-name'></span>").text(s.name));
					$strip.append($chip);
				});
				const hidden = states.filter(function(s) { return !s.active && !s.recent; });
				if (hidden.length) {	// shown only when the header is too narrow for every chip (fit)
					$strip.append($("<span class='multi-track-more'></span>").text("+" + hidden.length)
						.attr("title", hidden.map(function(s) { return s.name; }).join(", ")));
				}
				$("#currentSpan").append($strip);
				fit(true);
			}
			states.forEach(function(s) {	// the "jumped 12 s ago" part changes every tick: only the tooltip text
				const title = multiTrack.chipTitle(s);
				$strip.find(".multi-track-chip[data-characterid='" + s.id + "']").attr({ title: title, "aria-label": title });
			});
			fit(false);
		}

		/** Keep the header on one line: names off, then only the active / last jumper (+N), then no strip */
		const FIT_LEVELS = ["", "mt-compact", "mt-compact mt-min", "mt-hidden"];
		function headerWrapped() {
			const left = document.querySelector("#topbar > .align-left");
			const right = document.querySelector("#topbar > .align-right");
			if (!left || !right) { return false; }
			return right.getBoundingClientRect().top > left.getBoundingClientRect().top + 5;
		}
		function fit(fromStart) {
			const $strip = $("#multi-track-strip");
			if (!$strip.length || !$("#currentSpan").is(":visible")) { return; }
			if (!fromStart && !headerWrapped()) { return; }	// the every-tick check only ever tightens
			let level = fromStart ? 0 : (state.fitLevel || 0);
			for (; level < FIT_LEVELS.length; level++) {
				$strip.removeClass("mt-compact mt-min mt-hidden").addClass(FIT_LEVELS[level]);
				if (!headerWrapped()) { break; }
			}
			state.fitLevel = Math.min(level, FIT_LEVELS.length - 1);
		}
		let resizeTimer = null;
		$(window).on("resize", function() {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(function() { try { fit(true); } catch (e) { /* the next render */ } }, 150);
		});

		function renderLabel(name) {
			const $label = $("#currentSpan > .pointer").first();
			if (!$label.length) { return; }
			if (originalLabel === null) { originalLabel = $label.text(); }
			if (name === state.labelKey || (!name && state.labelKey === null)) { return; }	// off: never touched
			state.labelKey = name;
			setTimeout(function() { fit(true); }, 0);	// the label changes the header's width
			if (name) { $label.text("Current System (").append($("<span class='multi-track-who'></span>").text(name), "): "); }
			else { $label.text(originalLabel); }
		}

		// ---- Tracking list: a "map this character's jumps" switch per character, only while the feature is on ----

		function toggleTitle(on) {
			return on ? "Map this character's wormhole jumps: ON. Click to stop switching to it when it jumps."
				: "Map this character's wormhole jumps: OFF. Click to switch to it whenever it jumps through a wormhole.";
		}

		function syncToggles(on) {
			const o = opts();
			if (!on) {
				if (state.togglesOn !== false) { $("#tracking .multi-track-toggle").remove(); state.togglesOn = false; }
				return;
			}
			state.togglesOn = true;
			$("#tracking .tracking-clone").each(function() {
				const id = $(this).attr("data-characterid");
				if (!id) { return; }
				let $t = $(this).find(".multi-track-toggle");
				if (!$t.length) {
					$t = $("<i class='multi-track-toggle' data-icon='auto' role='switch' tabindex='0'></i>");
					$(this).find(".control-group").first().append($t);
					if (typeof Tooltips !== "undefined") { Tooltips.attach($t); }
				}
				const included = !multiTrack.excluded(o, id);
				if ($t.attr("aria-checked") !== String(included)) {
					$t.toggleClass("is-on", included).attr({ "aria-checked": String(included), "data-tooltip": toggleTitle(included), "aria-label": toggleTitle(included) });
					// The tooltip under the mouse keeps its old text until reopened: update it in place
					if (typeof Tooltips !== "undefined" && Tooltips.isOpen && Tooltips.source && Tooltips.source[0] === $t[0] && typeof Tooltips.setContent === "function") {
						Tooltips.setContent(toggleTitle(included));
					}
				}
			});
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
		$("#topbar").on("click", ".multi-track-chip", function(e) {
			e.preventDefault();
			const id = $(this).attr("data-characterid");
			if (String(activeId()) === id) { return; }
			pick(id);
			if (typeof forkUsage !== "undefined") { forkUsage.track("multiTrack", "chip"); }
			render();
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
				text: "Map jumps of all my tracked characters (switch to whichever one jumps a wormhole)",
				hint: "Up to 5 characters. Leave one out with the A icon under it in the tracking list (click your name, top right).",
				keywords: ["multi", "multibox", "alts", "characters", "tracking", "active character", "switch"],
				get: function(o) { return multiTrack.enabled(o); },
				set: function(o, on) {
					o.multiTrack = Object.assign({ exclude: {} }, o.multiTrack, { enabled: !!on });
					if (!on) { state.queue = []; }
				}
			});
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
			state: function() { return { queue: state.queue.slice(), lastJump: state.lastJump, last: state.last }; },
			tick: tick
		};
		multiTrack.pick = pick;
		multiTrack.characters = characters;
		/** Name of the character that jumped, for the jump pop-ups (jump-return.js, jump-sig-prompt.js), or "" */
		multiTrack.labelNow = function() { return multiTrack.jumperLabel(opts(), characters(), activeId()); };
	});
}
