const autopilotRoute = {
	// "Set destination in game": sets the end of the gate leg of a route Tripwire worked out (Favourites panel,
	// Destinations window, Thera/Turnur legs, skyhooks, loot buyers, region map, jump planner) as each picked
	// character's in-game destination: one ESI call per character. EVE's autopilot picks the way there with the
	// player's own route settings (fork-owned file). Pure logic here; the UI is at the bottom.
	// Keep `const autopilotRoute` on the first line: the test helper strips it to define a global.

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

	/** Where "Set destination in game" sends a route: the last system of its k-space leg, or null when there are no
	gate jumps to fly (the leg has fewer than two systems). @return {destID, from, jumps} or null */
	destination: function(path, systems) {
		const leg = autopilotRoute.kspaceLeg(path, systems);
		return leg.length < 2 ? null : { destID: leg[leg.length - 1], from: leg[0], jumps: leg.length - 1 };
	},

	/** Toast text once the destination is set: "Destination set in game: Jita for Alice and Bob (19 jumps from Hek)".
	jumps null: no jump count (e.g. a jump drive target, where gate jumps say nothing) */
	doneText: function(dest, who, jumps, from) {
		return "Destination set in game: " + dest + " for " + who + (jumps === null || jumps === undefined ? ""
			: " (" + jumps + " jump" + (jumps === 1 ? "" : "s") + (from ? " from " + from : "") + ")");
	},

	/** The gate leg of a Favourites panel plan. Direct: from where you are. Through the chain: from the system you
	leave it at (the autopilot can't route through wormholes).
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

	/** Words for a failed ESI call (jqXHR-like {status}) */
	errorText: function(error) {
		const status = error && error.status;
		if (status === 401 || status === 403) {
			return "EVE refused it: the login has expired or lacks the permission to set your destination. Log in again with EVE SSO.";
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

	/** Set the same destination for several characters, one ESI call per character, one character after another (so
	ESI sees one call at a time). Each call clears the character's other waypoints. A failure for one character
	doesn't stop the others. sendOne(characterID, systemID, clear) returns a thenable (it may also throw).
	@return Promise (never rejects) of [{characterID, name, ok, error}] in send order */
	sendToCharacters: function(targets, destID, sendOne) {
		const list = (targets || []).slice(), results = [];
		let chain = Promise.resolve();
		list.forEach(function(c) {
			chain = chain.then(function() {
				// new Promise: a sendOne that throws (rather than rejecting) is reported like a failed call
				return new Promise(function(resolve) { resolve(sendOne(c.characterID, destID, true)); }).then(function() {
					results.push({ characterID: c.characterID, name: c.name, ok: true });
				}, function(error) {
					results.push({ characterID: c.characterID, name: c.name, ok: false, error: error });
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

	/** Result toast for sendToCharacters' results. dest: destination name, jumps: gate jumps on the route, from: where
	the route starts (name).
	@return {color: green (all set) / yellow (some failed) / red (all failed), lines: [plain text, escape each]} */
	summary: function(results, dest, jumps, from) {
		const ok = (results || []).filter(function(r) { return r.ok; });
		const failed = (results || []).filter(function(r) { return !r.ok; });
		const failure = function(r) { return (results.length > 1 ? r.name + ": " : "") + autopilotRoute.errorText(r.error); };
		const done = function() {
			return autopilotRoute.doneText(dest, autopilotRoute.joinNames(ok.map(function(r) { return r.name; })), jumps, from);
		};
		if (!failed.length) { return { color: "green", lines: [done()] }; }
		if (!ok.length) {
			return { color: "red", lines: ["Could not set " + dest + " as the destination in game" + (failed.length > 1 ? " for any character." : ".")]
				.concat(failed.map(failure)) };
		}
		return { color: "yellow", lines: [done()].concat(failed.map(function(r) { return "Failed for " + failure(r); })) };
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

		// ---- Character picker: which tracked characters get the destination ----

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
				title: "Set destination in game",
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
				console.error("Set destination in game: could not save the character selection", err);
			}
		}

		/** Ask which characters get the destination. onSend([character]) runs only on Send, with at least one character. */
		function pickCharacters(label, jumps, safe, onSend) {
			const list = ap.characters(options, tripwire.esi && tripwire.esi.characters);
			const error = ap.noCharacterError(list);
			if (error) { notify(ap.escape(error), "red", 8000); return; }
			const $dialog = ensureDialog();
			pending = { list: list, onSend: onSend };
			$dialog.find(".autopilot-chars-route").html(ap.escape(label)
				+ (jumps === null ? "" : ", " + jumps + " jump" + (jumps === 1 ? "" : "s")) + ". Set destination for:");
			$dialog.find(".autopilot-chars-safe").toggle(!!safe);
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

		/** Set the end of a route's gate leg as the in-game destination of the characters picked in the dialog */
		/** opts: {safe: the route is Tripwire's high-sec only one (the picker says to set Prefer safer in game),
		noJumps: leave the jump count out (a jump drive target: EVE's gate route there is something else)} */
		function push(path, label, opts) {
			opts = opts || {};
			if (busy) { notify("Still setting the previous destination, one moment.", "yellow", 4000); return; }
			const target = ap.destination(path, appData.systems);	// never wormhole space (the autopilot can't route there)
			if (!target) { notify("Nothing to set: no gate jumps on this route.", "yellow", 5000); return; }
			if (opts.noJumps) { target.jumps = null; }
			pickCharacters(label, target.jumps, opts.safe, function(targets) {
				if (busy) { notify("Still setting the previous destination, one moment.", "yellow", 4000); return; }
				send(targets, target);
			});
		}

		function send(targets, target) {
			const dest = systemName(target.destID);
			busy = true;		// covers the whole run, every character
			ap.sendToCharacters(targets, target.destID, function(characterID, systemID, clear) {
				return tripwire.esi.setDestination(systemID, characterID, clear, false);
			}).then(function(results) {
				busy = false;
				const result = ap.summary(results, dest, target.jumps, systemName(target.from));
				notify(result.lines.map(ap.escape).join("<br/>"), result.color, result.color === "green" ? 6000 : 15000);
			}).catch(function(err) {	// only a bug in the code above gets here
				busy = false;
				console.error("Set destination in game", err);
				notify("Could not set " + ap.escape(dest) + " as the destination in game.", "red", 8000);
			});
		}
		ap.push = push;

		// ---- Favourites panel: a button next to each favourite's route button ----

		/** One button per gate leg of a route through Thera/Turnur, numbered when there is more than one */
		function scoutButtons(plan) {
			const legs = theraRoute.gateLegs(plan);
			if (!legs.length) {
				return "<i class='autopilot-route-btn disabled' data-icon='auto' title='" + ap.escape("Set destination in game: nothing to fly by gates on this route") + "'></i>";
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
				title = "Set destination in game: " + leg.error;
			} else {
				const from = plan.kind === "direct" ? "where you are" : systemName(plan.exitSystemID);
				title = "Set destination in game: " + name + " as your in-game destination"
					+ (plan.kind === "chain" ? " (take the wormholes to " + from + " yourself)" : "") + ". "
					+ (flags.route === "safe"
						? "The in-game autopilot picks its own route: set it to Prefer safer in game for a high-sec only route."
						: "The in-game autopilot picks the route with your in-game route settings.");
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
				push(scoutLeg.path, scoutLabel(plan, index, id, flags.route === "safe"), { safe: flags.route === "safe" });
				return;
			}
			const leg = ap.favouriteLeg(plan, trackedSystem(), id, function(from, to, safe) {
				return ap.gatePath(gateMap(), appData.systems, from, to, safe, avoidList());
			});
			if (leg.error) { notify(ap.escape(leg.error), "yellow", 5000); return; }
			push(leg.path, systemName(leg.from) + " → " + systemName(id) + (flags.route === "safe" ? " (safe)" : ""), { safe: flags.route === "safe" });
		}

		// ---- Destinations window: a button in each row ----

		function destinationButton(id) {
			const rd = routeDestinations;
			const ev = rd.evaluate(rd.lastExits, id, rd.routingLimit());
			if (ev.scout && typeof theraRoute !== "undefined") { return "<td class='route-dest-autopilot'>" + scoutButtons(ev.scout) + "</td>"; }
			const best = ev.best;
			const leg = ap.destinationLeg(best);
			const title = leg.error ? "Set destination in game: " + leg.error
				: "Set destination in game: " + systemName(id) + " as your in-game destination"
					+ " (take the wormholes to " + systemName(best.exit.systemID) + " yourself)";
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
					console.error("Set destination in game: destinations", err);
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
				+ "<p class='autopilot-chars-hint'>Sets each character's in-game destination, replacing its current route. EVE's autopilot picks the way there, using your in-game route settings.</p>"
				+ "<p class='autopilot-chars-hint autopilot-chars-safe'>For the high-sec only way, set your autopilot to Prefer safer in game.</p>"
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
