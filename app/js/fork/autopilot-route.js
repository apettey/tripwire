const autopilotRoute = {
	// "Set route in game": sends the gate leg of a route Tripwire worked out (Favourites panel, Destinations window)
	// to the in-game autopilot as ESI waypoints, so EVE follows that route (e.g. the high-sec only one) rather
	// than its own choice (fork-owned file). Pure logic here; the UI is at the bottom.
	// Keep `const autopilotRoute` on the first line: the test helper strips it to define a global.
	MAX_WAYPOINTS: 50,      // cap on ESI calls per route; 50 is the commonly quoted in-game waypoint limit (not confirmed by CCP)

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Real system ID as a number. Accepts guidance's offset IDs (systemID - 30000000). Null for anything else. */
	toID: function(systemID) {
		if (systemID === null || systemID === undefined || systemID === "" || typeof systemID === "boolean") { return null; }
		if (typeof systemID === "string" && !/^\s*\d+\s*$/.test(systemID)) { return null; }
		let n = Number(systemID);
		if (!Number.isInteger(n) || n <= 0) { return null; }
		if (n < 30000000) { n += 30000000; }
		return n < 32000000 ? n : null;
	},

	/** K-space: a known system without a wormhole class, outside the wormhole regions (Pochven counts) */
	isKSpace: function(system) {
		return !!system && !system.class && (Number(system.regionID) || 0) < 11000000;
	},

	/** High-sec as the app shows it (security >= 0.45), not Pochven */
	isHighSec: function(system) {
		return autopilotRoute.isKSpace(system) && system.factionID != 500026 && Number(system.security) >= 0.45;
	},

	/** Whether a route may pass through a system (same rules as the Favourites panel's routes) */
	passable: function(system, safe, ignore) {
		if (typeof favouritesPanel !== "undefined" && favouritesPanel.passable) { return favouritesPanel.passable(system, safe, ignore); }
		if (!system) { return false; }
		const name = String(system.name || "");
		if (name === "Zarzakh" || (ignore && ignore[name.toLowerCase()])) { return false; }
		return !safe || autopilotRoute.isHighSec(system);
	},

	/** A route path (real or guidance offset IDs) as real IDs; null if any entry isn't a system */
	normalise: function(path) {
		if (!Array.isArray(path) || !path.length) { return null; }
		const out = path.map(autopilotRoute.toID);
		return out.every(function(id) { return id; }) ? out : null;
	},

	/** Gate path between two systems, breadth-first over the gate map, travelling only through passable systems
	(the start and the end may be anything). The same search as favouritesPanel.gateDistances, so its jump
	count matches the panel's. @param map gate adjacency keyed by systemID - 30000000 (appData.map.shortest)
	@return [real system IDs, from first] or null */
	gatePath: function(map, systems, fromID, toID, safe, ignore) {
		const from = autopilotRoute.toID(fromID), to = autopilotRoute.toID(toID);
		if (!from || !to || !map) { return null; }
		if (from === to) { return [from]; }
		const previous = {};
		previous[from] = 0;
		const queue = [from];
		for (let i = 0; i < queue.length; i++) {
			const current = queue[i];
			const next = map[current - 30000000] || {};
			for (const key in next) {
				const id = 30000000 + Number(key);
				if (previous[id] !== undefined) { continue; }
				previous[id] = current;
				if (id === to) {
					const path = [id];
					for (let p = current; p; p = previous[p]) { path.unshift(p); }
					return path;
				}
				if (autopilotRoute.passable(systems[id], safe, ignore)) { queue.push(id); }
			}
		}
		return null;
	},

	/** The part of a route the autopilot can fly: the k-space systems after the last wormhole-space system
	(J-space, Thera, unknown...). Empty if the route ends outside k-space. */
	kspaceLeg: function(path, systems) {
		const ids = autopilotRoute.normalise(path) || [];
		let start = ids.length;
		while (start > 0 && autopilotRoute.isKSpace(systems[ids[start - 1]])) { start--; }
		return ids.slice(start);
	},

	/** Breadth-first from one system over the whole gate map (no avoid list: EVE's own view), up to maxDepth jumps.
	@return {dist: {id: jumps}, count: {id: number of shortest paths, capped at 2}} */
	reach: function(map, fromID, maxDepth) {
		const dist = {}, count = {};
		dist[fromID] = 0;
		count[fromID] = 1;
		const queue = [fromID];
		for (let i = 0; i < queue.length; i++) {
			const current = queue[i];
			if (dist[current] >= maxDepth) { continue; }
			const next = map[current - 30000000] || {};
			for (const key in next) {
				const id = 30000000 + Number(key);
				if (dist[id] === undefined) {
					dist[id] = dist[current] + 1;
					count[id] = count[current];
					queue.push(id);
				} else if (dist[id] === dist[current] + 1) {
					count[id] = Math.min(2, count[id] + count[current]);
				}
			}
		}
		return { dist: dist, count: count };
	},

	/** Waypoints that make the autopilot fly exactly this gate path. path: real IDs, path[0] = where the route
	starts (not sent). Low-sec, null-sec and Pochven systems are each a waypoint: EVE's "safer" preference would
	otherwise leave such a stretch for a longer high-sec way round, even when it is the only shortest route.
	High-sec stretches are skipped over greedily while the path so far is the only shortest gate route (so
	"shortest" can't pick another) and stays in high-sec (so "safer" has nothing better). Always ends with the
	destination. Not capped: see limit. */
	waypoints: function(path, map, systems) {
		const ids = autopilotRoute.normalise(path);
		if (!ids || ids.length < 2) { return []; }
		const result = [];
		let from = 0;
		while (from < ids.length - 1) {
			let end = from + 1;		// always at least the next system
			if (autopilotRoute.isHighSec(systems[ids[end]])) {
				const info = autopilotRoute.reach(map || {}, ids[from], ids.length - 1 - from);
				while (end + 1 < ids.length) {
					const id = ids[end + 1];
					if (!autopilotRoute.isHighSec(systems[id])) { break; }
					if (info.dist[id] !== end + 1 - from || info.count[id] !== 1) { break; }
					end++;
				}
			}
			result.push(ids[end]);
			from = end;
		}
		return result;
	},

	/** Waypoints within the cap (default MAX_WAYPOINTS). Over it: the first max-1, then the destination, so the
	autopilot still gets there but picks its own route after the last pinned one.
	@return {waypoints, capped, total (before capping), pinnedUntil (last waypoint on our route, when capped)} */
	limit: function(waypoints, max) {
		const list = (waypoints || []).slice();
		const cap = Math.max(2, max || autopilotRoute.MAX_WAYPOINTS);
		if (list.length <= cap) { return { waypoints: list, capped: false, total: list.length }; }
		const kept = list.slice(0, cap - 1);
		return { waypoints: kept.concat([list[list.length - 1]]), capped: true, total: list.length, pinnedUntil: kept[kept.length - 1] };
	},

	/** Toast text once the route is set. name: function(systemID) -> system name (plain text, escape it for HTML) */
	doneText: function(label, who, jumps, limited, name) {
		const n = limited.waypoints.length;
		let text = "Route set in game: " + label + " for " + who + " (" + jumps + " jump" + (jumps === 1 ? "" : "s") + ", "
			+ n + " waypoint" + (n === 1 ? "" : "s") + ")";
		if (limited.capped) {
			text += ". The route needs " + limited.total + " waypoints, more than the " + n + " Tripwire sets: it is followed as far as "
				+ name(limited.pinnedUntil) + ", from there EVE picks its own route to " + name(limited.waypoints[n - 1]) + ".";
		}
		return text;
	},

	/** The gate leg of a Favourites panel plan. Direct: from where you are. Through the chain: from the system you
	leave it at (wormholes can't be waypointed).
	@param pathFn function(fromID, toID, safe) -> gate path
	@return {path, from} or {error} */
	favouriteLeg: function(plan, startID, favID, pathFn) {
		if (!plan || plan.status === "no-location") { return { error: "Your location isn't known" }; }
		if (plan.status === "here") { return { error: "You are already there" }; }
		if (plan.status !== "ok") { return { error: plan.mode === "safe" ? "No high-sec only route" : "No route" }; }
		const from = plan.kind === "direct" ? autopilotRoute.toID(startID) : autopilotRoute.toID(plan.exitSystemID);
		const gates = plan.kind === "direct" ? plan.gatesIn : plan.gatesOut;
		if (!from || !gates) { return { error: "Nothing to fly by gates after the chain" }; }
		const path = pathFn(from, favID, plan.mode === "safe");
		return path && path.length > 1 ? { path: path, from: from } : { error: "No gate route" };
	},

	/** One gate leg of a route through Thera/Turnur (theraRoute plan). The autopilot can't route through wormholes,
	so each gate stretch is sent on its own: leg 1 now, leg 2 once you are out of Thera, and so on.
	@return {path, from, to} or {error} */
	scoutLeg: function(plan, index) {
		if (!plan || plan.status !== "ok" || plan.kind !== "scout") { return { error: "No route" }; }
		const leg = (plan.legs || [])[index || 0];
		const path = leg ? autopilotRoute.normalise(leg.path) : null;
		if (!path || path.length < 2) { return { error: (plan.legs || []).length ? "No such leg" : "Nothing to fly by gates on this route" }; }
		return { path: path, from: path[0], to: path[path.length - 1] };
	},

	/** The gate leg of a Destinations window entry (routeDestinations.evaluate(...).best) */
	destinationLeg: function(best) {
		if (!best || !best.jumps) { return { error: best ? "On the chain already" : "No gate route" }; }
		const path = autopilotRoute.normalise(best.path);
		return path && path.length > 1 ? { path: path, from: path[0] } : { error: "No gate route" };
	},

	/** Send waypoints one after another (order matters): the first clears the other waypoints, the rest are
	appended at the end. sendOne(systemID, clear) returns a thenable. onProgress(done, total) is optional.
	@return Promise resolving to the number sent, or rejecting with {index, systemID, error} */
	sendAll: function(waypoints, sendOne, onProgress) {
		const list = (waypoints || []).slice();
		let chain = Promise.resolve();
		list.forEach(function(systemID, index) {
			chain = chain.then(function() {
				// new Promise: a sendOne that throws (rather than rejecting) is reported like a failed call
				return new Promise(function(resolve) { resolve(sendOne(systemID, index === 0)); }).then(function() {
					if (onProgress) { onProgress(index + 1, list.length); }
				}, function(error) {
					throw { index: index, systemID: systemID, error: error };
				});
			});
		});
		return chain.then(function() { return list.length; });
	},

	/** Words for a failed ESI call (jqXHR-like {status}) */
	errorText: function(error) {
		const status = error && error.status;
		if (status === 401 || status === 403) {
			return "EVE refused it: the login has expired or lacks the autopilot waypoint permission. Log in again with EVE SSO.";
		}
		if (status === 420 || status === 429) { return "ESI is rate limiting requests. Try again in a minute."; }
		if (!status) { return "Could not reach ESI."; }
		return "ESI error " + status + ".";
	},

	/** Every tracked character (tripwire.esi.characters) for the character picker, sorted by name. Usable: has an
	ESI login. Preselected: the usable ones of the last selection sent (opts.autopilotRoute.characters), or else
	the active tracked character (opts.tracking.active, like upstream's "Set destination") if it is usable.
	@return [{characterID (string, the key in characters), name, usable, reason, active, preselected}] */
	characters: function(opts, characters) {
		const active = opts && opts.tracking && opts.tracking.active !== null && opts.tracking.active !== undefined
			? String(opts.tracking.active) : null;
		const saved = opts && opts.autopilotRoute && Array.isArray(opts.autopilotRoute.characters)
			? opts.autopilotRoute.characters.map(String) : [];
		const list = Object.keys(characters && typeof characters === "object" ? characters : {}).filter(function(id) {
			return characters[id] && typeof characters[id] === "object";
		}).map(function(id) {
			const c = characters[id];
			const usable = !!c.accessToken;
			return {
				characterID: id, name: String(c.characterName || id), usable: usable,
				reason: usable ? null : "no ESI login, log in again", active: id === active, preselected: false
			};
		});
		list.sort(function(a, b) { return a.name.localeCompare(b.name) || a.characterID.localeCompare(b.characterID); });
		const remembered = list.filter(function(c) { return c.usable && saved.indexOf(c.characterID) >= 0; });
		(remembered.length ? remembered : list.filter(function(c) { return c.usable && c.active; }))
			.forEach(function(c) { c.preselected = true; });
		return list;
	},

	/** Error to show instead of the character picker when no character can be sent to, else null */
	noCharacterError: function(list) {
		if ((list || []).some(function(c) { return c.usable; })) { return null; }
		if (list && list.length === 1) { return list[0].name + " has no ESI login. Log in again with EVE SSO."; }
		return list && list.length ? "None of your tracked characters has an ESI login. Log in again with EVE SSO."
			: "Select a tracked character (logged in with EVE SSO) first.";
	},

	/** State of the picker's "Select all" box: "all", "some" or "none" of the usable characters selected */
	selectAllState: function(list, selectedIDs) {
		const usable = (list || []).filter(function(c) { return c.usable; });
		const selected = (selectedIDs || []).map(String);
		const n = usable.filter(function(c) { return selected.indexOf(c.characterID) >= 0; }).length;
		return n && n === usable.length ? "all" : n ? "some" : "none";
	},

	/** Send the same waypoints to several characters, one character after another (each in order, see sendAll), so
	ESI sees one call at a time. A failure for one character doesn't stop the others.
	sendOne(characterID, systemID, clear) returns a thenable. onProgress({character, characterIndex, characterCount,
	done, total}) is optional, called before each character starts (done 0) and after each waypoint.
	@return Promise (never rejects) of [{characterID, name, ok, sent, systemID (failed one), error}] in send order */
	sendToCharacters: function(targets, waypoints, sendOne, onProgress) {
		const list = (targets || []).slice(), wps = (waypoints || []).slice(), results = [];
		let chain = Promise.resolve();
		list.forEach(function(c, ci) {
			const progress = function(done) {
				if (onProgress) {
					onProgress({ character: c, characterIndex: ci, characterCount: list.length, done: done, total: wps.length });
				}
			};
			chain = chain.then(function() {
				progress(0);
				return autopilotRoute.sendAll(wps, function(systemID, clear) {
					return sendOne(c.characterID, systemID, clear);
				}, progress).then(function(sent) {
					results.push({ characterID: c.characterID, name: c.name, ok: true, sent: sent });
				}, function(failure) {
					const f = failure && typeof failure.index === "number" ? failure : { index: 0, error: failure };
					results.push({ characterID: c.characterID, name: c.name, ok: false, sent: f.index, systemID: f.systemID, error: f.error });
				});
			});
		});
		return chain.then(function() { return results; });
	},

	/** "Alice", "Alice and Bob", "Alice, Bob and Carol" */
	joinNames: function(names) {
		const list = (names || []).slice();
		return list.length < 2 ? (list[0] || "") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
	},

	/** How much of a failed route was set: sent = waypoints set before the failing call */
	partialText: function(sent) {
		return sent === 1 ? " Only the first waypoint was set." : sent > 1 ? " Only the first " + sent + " waypoints were set." : "";
	},

	/** Progress toast text for a multi-character run */
	characterProgressText: function(label, info) {
		return "Setting route in game: " + label + ". " + info.character.name + ": waypoint " + Math.min(info.done + 1, info.total)
			+ " of " + info.total + (info.characterCount > 1 ? " (" + (info.characterIndex + 1) + " of " + info.characterCount + " characters)" : "")
			+ "...";
	},

	/** Result toast for sendToCharacters' results. dest: destination name; the rest as doneText.
	@return {color: green (all set) / yellow (some failed) / red (all failed), lines: [plain text, escape each]} */
	summary: function(results, label, dest, jumps, limited, name) {
		const ok = (results || []).filter(function(r) { return r.ok; });
		const failed = (results || []).filter(function(r) { return !r.ok; });
		const failure = function(r) {
			return (results.length > 1 ? r.name + ": " : "") + autopilotRoute.errorText(r.error) + autopilotRoute.partialText(r.sent);
		};
		if (!failed.length) {
			return { color: "green", lines: [autopilotRoute.doneText(label, autopilotRoute.joinNames(ok.map(function(r) { return r.name; })), jumps, limited, name)] };
		}
		if (!ok.length) {
			return { color: "red", lines: ["Could not set the route to " + dest + " in game" + (failed.length > 1 ? " for any character." : ".")]
				.concat(failed.map(failure)) };
		}
		return {
			color: "yellow",
			lines: [autopilotRoute.doneText(label, autopilotRoute.joinNames(ok.map(function(r) { return r.name; })), jumps, limited, name)]
				.concat(failed.map(function(r) { return "Failed for " + failure(r); }))
		};
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined") {
	(function() {
		const ap = autopilotRoute;
		let busy = false;

		function systemName(id) { return ((tripwire.systems && tripwire.systems[id]) || appData.systems[id] || {}).name || String(id); }
		function trackedSystem() { return tripwire.client && tripwire.client.EVE ? tripwire.client.EVE.systemID : null; }
		function gateMap() { return (tripwire.map && tripwire.map.shortest) || appData.map.shortest; }
		function notify(html, color, stick) {
			if (typeof Notify !== "undefined") { Notify.trigger(html, color, stick); } else { console.log(html); }
		}
		function avoidList() {
			const r = options.chain && options.chain.routeIgnore;
			if (!r || !r.enabled || !Array.isArray(r.systems)) { return null; }
			const list = {};
			r.systems.forEach(function(n) { if (n) { list[String(n).trim().toLowerCase()] = true; } });
			return list;
		}

		// ---- Character picker: which tracked characters get the route ----

		const DIALOG_ID = "dialog-autopilotCharacters";
		let pending = null;		// {list, onSend} while the picker is open; Send takes it, anything else drops it

		function sendButton() { return $("#" + DIALOG_ID).parent().find(".ui-dialog-buttonpane button.autopilot-chars-send"); }
		function selectedIDs() {
			return $("#" + DIALOG_ID + " .autopilot-chars-list input:checked:enabled").map(function() { return String(this.value); }).get();
		}
		function updatePicker() {
			if (!pending) { return; }
			const selected = selectedIDs();
			const state = ap.selectAllState(pending.list, selected);
			$("#" + DIALOG_ID + " .autopilot-chars-all").prop({ checked: state === "all", indeterminate: state === "some" });
			sendButton().prop("disabled", !selected.length).toggleClass("ui-state-disabled", !selected.length);
		}

		function ensureDialog() {
			const $dialog = $("#" + DIALOG_ID);
			if ($dialog.hasClass("ui-dialog-content")) { return $dialog; }
			$dialog.dialog({
				autoOpen: false,
				title: "Set route in game",
				resizable: false,
				modal: true,
				width: 340,
				dialogClass: "dialog-noeffect ui-dialog-shadow dialog-autopilotCharacters",
				buttons: [
					{ text: "Send", "class": "autopilot-chars-send", click: function() {
						const ids = selectedIDs();
						if (!pending || !ids.length) { return; }
						const job = pending;
						pending = null;
						$(this).dialog("close");
						rememberSelection(ids);
						job.onSend(job.list.filter(function(c) { return c.usable && ids.indexOf(c.characterID) >= 0; }));
					} },
					{ text: "Cancel", click: function() { $(this).dialog("close"); } }
				],
				open: function() { sendButton().focus(); },	// Enter sends: the old one-click flow is click, Enter
				close: function() { pending = null; }		// Cancel, Escape and the close button send nothing
			});
			return $dialog;
		}

		/** Remember the selection for next time (per user, in options like other fork features; not a setting) */
		function rememberSelection(ids) {
			try {
				options.autopilotRoute = Object.assign({}, options.autopilotRoute || {}, { characters: ids.slice() });
				options.save();
			} catch (err) {
				console.error("Set route in game: could not save the character selection", err);
			}
		}

		/** Ask which characters get the route. onSend([character]) runs only on Send, with at least one character. */
		function pickCharacters(label, waypointCount, onSend) {
			const list = ap.characters(options, tripwire.esi && tripwire.esi.characters);
			const error = ap.noCharacterError(list);
			if (error) { notify(ap.escape(error), "red", 8000); return; }
			const $dialog = ensureDialog();
			pending = { list: list, onSend: onSend };
			$dialog.find(".autopilot-chars-route").html(ap.escape(label) + ", " + waypointCount + " waypoint"
				+ (waypointCount === 1 ? "" : "s") + ". Send to:");
			$dialog.find(".autopilot-chars-list").html(list.map(function(c) {
				return "<li class='autopilot-chars-row" + (c.usable ? "" : " disabled") + "'><label>"
					+ "<input type='checkbox' value='" + ap.escape(c.characterID) + "'" + (c.preselected ? " checked" : "")
					+ (c.usable ? "" : " disabled") + " /> <span class='autopilot-chars-name'>" + ap.escape(c.name) + "</span>"
					+ (c.active ? " <span class='autopilot-chars-note'>(tracking)</span>" : "")
					+ (c.reason ? " <span class='autopilot-chars-reason'>" + ap.escape(c.reason) + "</span>" : "")
					+ "</label></li>";
			}).join(""));
			$dialog.find(".autopilot-chars-tools").toggle(list.filter(function(c) { return c.usable; }).length > 1);
			$dialog.dialog("open");
			updatePicker();
		}

		/** Send a gate path to the in-game autopilot, for the characters picked in the dialog */
		function push(path, label) {
			if (busy) { notify("Still setting the previous route, one moment.", "yellow", 4000); return; }
			const leg = ap.kspaceLeg(path, appData.systems);	// never send wormhole space (it can't be waypointed)
			const limited = ap.limit(ap.waypoints(leg, appData.map.shortest, appData.systems));
			const waypoints = limited.waypoints;
			if (!waypoints.length) { notify("Nothing to set: no gate jumps on this route.", "yellow", 5000); return; }
			pickCharacters(label, waypoints.length, function(targets) {
				if (busy) { notify("Still setting the previous route, one moment.", "yellow", 4000); return; }
				send(targets, waypoints, leg.length - 1, limited, label);
			});
		}

		function send(targets, waypoints, jumps, limited, label) {
			const dest = systemName(waypoints[waypoints.length - 1]);
			busy = true;		// covers the whole run, every character
			// One toast for the whole run, updated per waypoint (jBox is what Notify uses)
			let progress = null;
			const showProgress = function(info) {
				const html = ap.escape(ap.characterProgressText(label, info));
				if (progress) { progress.setContent(html); return; }
				if (typeof jBox === "undefined") { notify(html, "blue", 3000); return; }
				progress = new jBox("Notice", { content: html, offset: { y: 35 }, animation: "flip", color: "blue", autoClose: false });
			};
			const closeProgress = function() { if (progress) { progress.close(); progress = null; } };
			ap.sendToCharacters(targets, waypoints, function(characterID, systemID, clear) {
				return tripwire.esi.setDestination(systemID, characterID, clear, false);
			}, showProgress).then(function(results) {
				busy = false;
				closeProgress();
				const result = ap.summary(results, label, dest, jumps, limited, systemName);
				const ms = result.color === "green" ? (limited.capped ? 15000 : 6000) : 15000;
				notify(result.lines.map(ap.escape).join("<br/>"), result.color, ms);
			}).catch(function(err) {	// only a bug in the code above gets here
				busy = false;
				closeProgress();
				console.error("Set route in game", err);
				notify("Could not set the route to " + ap.escape(dest) + " in game.", "red", 8000);
			});
		}
		ap.push = push;

		// ---- Favourites panel: a button next to each favourite's route button ----

		/** One button per gate leg of a route through Thera/Turnur, numbered when there is more than one */
		function scoutButtons(plan) {
			const legs = theraRoute.gateLegs(plan);
			if (!legs.length) {
				return "<i class='autopilot-route-btn disabled' data-icon='auto' title='" + ap.escape("Set route in game: nothing to fly by gates on this route") + "'></i>";
			}
			return legs.map(function(leg) {
				return "<i class='autopilot-route-btn autopilot-route-leg' data-icon='auto' data-leg='" + leg.index + "' title='"
					+ ap.escape(theraRoute.legTitle(leg, systemName)) + "'>" + (leg.count > 1 ? "<sup>" + (leg.index + 1) + "</sup>" : "") + "</i>";
			}).join("");
		}

		function scoutLabel(plan, index, destID, safe) {
			const leg = ap.scoutLeg(plan, index);
			const count = (plan.legs || []).length;
			const notes = [];
			if (count > 1) { notes.push("leg " + (index + 1) + " of " + count + " to " + systemName(destID)); }
			else if (leg.to !== destID) { notes.push("to " + systemName(destID)); }
			if (safe) { notes.push("safe"); }
			return systemName(leg.from) + " → " + systemName(leg.to) + (notes.length ? " (" + notes.join(", ") + ")" : "");
		}

		function favouriteButton(id) {
			const fp = favouritesPanel;
			const flags = fp.flags(fp.settings(options), id);
			if (!flags.route) { return ""; }
			const plan = (fp.lastRoutes[id] || {})[flags.route];
			if (plan && plan.kind === "scout" && typeof theraRoute !== "undefined") { return scoutButtons(plan); }
			const leg = ap.favouriteLeg(plan, trackedSystem(), id, function() { return [0, 0]; });	// availability only
			const name = systemName(id);
			let title;
			if (leg.error) {
				title = "Set route in game: " + leg.error;
			} else {
				const from = plan.kind === "direct" ? "where you are" : systemName(plan.exitSystemID);
				title = "Set route in game: the " + (flags.route === "safe" ? "safe (high-sec only)" : "shortest") + " gate route from "
					+ from + " to " + name + " as autopilot waypoints" + (plan.kind === "chain" ? " (take the wormholes to " + from + " yourself)" : "");
			}
			return "<i class='autopilot-route-btn" + (leg.error ? " disabled" : "") + "' data-icon='auto' title='" + ap.escape(title) + "'></i>";
		}

		function decorateFavourites() {
			if (typeof favouritesPanel === "undefined") { return; }
			$("#" + favouritesPanel.WIDGET_ID + " .fav-row").each(function() {
				const $row = $(this);
				$row.find(".autopilot-route-btn").remove();
				const html = favouriteButton($row.data("systemid"));
				if (html) { $row.find(".fav-route").before(html); }
			});
		}

		let observed = null;
		const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(decorateFavourites) : null;
		function watchFavourites() {
			if (!observer || typeof favouritesPanel === "undefined") { return; }
			const list = document.querySelector("#" + favouritesPanel.WIDGET_ID + " .fav-list");
			if (list === observed) { return; }
			observer.disconnect();
			observed = list;
			if (list) {
				observer.observe(list, { childList: true });	// the panel rebuilds its rows; our buttons sit deeper
				decorateFavourites();
			}
		}

		function favouriteClick(e) {
			e.preventDefault();
			e.stopPropagation();
			if ($(this).hasClass("disabled")) { return; }
			const fp = favouritesPanel;
			const id = fp.toID($(this).closest(".fav-row").data("systemid"));
			const flags = fp.flags(fp.settings(options), id);
			const plan = (fp.lastRoutes[id] || {})[flags.route];
			if (plan && plan.kind === "scout") {
				const index = Number($(this).data("leg")) || 0;
				const scoutLeg = ap.scoutLeg(plan, index);
				if (scoutLeg.error) { notify(ap.escape(scoutLeg.error), "yellow", 5000); return; }
				push(scoutLeg.path, scoutLabel(plan, index, id, flags.route === "safe"));
				return;
			}
			const leg = ap.favouriteLeg(plan, trackedSystem(), id, function(from, to, safe) {
				return ap.gatePath(gateMap(), appData.systems, from, to, safe, avoidList());
			});
			if (leg.error) { notify(ap.escape(leg.error), "yellow", 5000); return; }
			push(leg.path, systemName(leg.from) + " → " + systemName(id) + (flags.route === "safe" ? " (safe)" : ""));
		}

		// ---- Destinations window: a button in each row ----

		function destinationButton(id) {
			const rd = routeDestinations;
			const ev = rd.evaluate(rd.lastExits, id, rd.routingLimit());
			if (ev.scout && typeof theraRoute !== "undefined") { return "<td class='route-dest-autopilot'>" + scoutButtons(ev.scout) + "</td>"; }
			const best = ev.best;
			const leg = ap.destinationLeg(best);
			const title = leg.error ? "Set route in game: " + leg.error
				: "Set route in game: the gate route from " + systemName(best.exit.systemID) + " to " + systemName(id)
					+ " as autopilot waypoints (take the wormholes to " + systemName(best.exit.systemID) + " yourself)";
			return "<td class='route-dest-autopilot'><i class='autopilot-route-btn" + (leg.error ? " disabled" : "")
				+ "' data-icon='auto' title='" + ap.escape(title) + "'></i></td>";
		}

		function wrapDestinations() {
			if (typeof routeDestinations === "undefined" || routeDestinations.renderRows.autopilotWrapped) { return; }
			const rd = routeDestinations;
			const original = rd.renderRows;
			rd.renderRows = function(list) {
				const html = original.apply(this, arguments);
				try {
					const $head = $("#dialog-routeDestinations .route-dest-table thead tr");
					if ($head.length && !$head.find(".route-dest-autopilot").length) {
						$head.children().last().before("<th class='route-dest-autopilot'></th>");
					}
					const $body = $("<tbody></tbody>").html(html);
					$body.find("td[colspan]").attr("colspan", 6);
					$body.find("tr[data-systemid]").each(function() {
						$(this).find(".route-dest-remove").before(destinationButton($(this).data("systemid")));
					});
					return $body.html();
				} catch (err) {
					console.error("Set route in game: destinations", err);
					return html;
				}
			};
			rd.renderRows.autopilotWrapped = true;
		}

		function destinationClick(e) {
			e.preventDefault();
			if ($(this).hasClass("disabled")) { return; }
			const rd = routeDestinations;
			const id = rd.toID($(this).closest("tr").data("systemid"));
			const ev = rd.evaluate(rd.lastExits, id, rd.routingLimit());
			if (ev.scout) {
				const index = Number($(this).data("leg")) || 0;
				const scoutLeg = ap.scoutLeg(ev.scout, index);
				if (scoutLeg.error) { notify(ap.escape(scoutLeg.error), "yellow", 5000); return; }
				push(scoutLeg.path, scoutLabel(ev.scout, index, id, false));
				return;
			}
			const best = ev.best;
			const leg = ap.destinationLeg(best);
			if (leg.error) { notify(ap.escape(leg.error), "yellow", 5000); return; }
			push(leg.path, systemName(leg.from) + " → " + systemName(id));
		}

		$(function() {
			$("body").append("<div id='" + DIALOG_ID + "' class='hidden'>"
				+ "<p class='autopilot-chars-route'></p>"
				+ "<div class='autopilot-chars-tools'><label><input type='checkbox' class='autopilot-chars-all' /> Select all</label></div>"
				+ "<ul class='autopilot-chars-list'></ul>"
				+ "<p class='autopilot-chars-hint'>Each character gets the same waypoints, replacing its current route.</p>"
				+ "</div>");
			$("#" + DIALOG_ID).on("change", ".autopilot-chars-all", function() {
				$("#" + DIALOG_ID + " .autopilot-chars-list input:enabled").prop("checked", this.checked);
				updatePicker();
			});
			$("#" + DIALOG_ID).on("change", ".autopilot-chars-list input", updatePicker);
			wrapDestinations();
			$(document).on("click", "#dialog-routeDestinations .autopilot-route-btn", destinationClick);
			$(document).on("click", ".fav-row .autopilot-route-btn", favouriteClick);
			// The Favourites panel adds its widget in its own ready handler (after this one) and again when it is
			// switched back on in Settings (both end in options.apply)
			setTimeout(watchFavourites, 0);
			if (typeof options !== "undefined" && options && typeof options.apply === "function" && !options.apply.autopilotWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					setTimeout(watchFavourites, 0);
					return result;
				};
				options.apply.autopilotWrapped = true;
			}
		});
	})();
}
