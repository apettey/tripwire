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

	/** Toast text while waypoints are being sent */
	progressText: function(label, done, total) {
		return "Setting route in game: " + label + ", waypoint " + Math.min(done + 1, total) + " of " + total + "...";
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
				return Promise.resolve(sendOne(systemID, index === 0)).then(function() {
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

	/** The character to set the route for, like upstream's "Set destination": the active tracked character, if
	it has an ESI login. @return {characterID, name} or {error} */
	character: function(opts, characters) {
		const id = opts && opts.tracking ? opts.tracking.active : null;
		const c = id && characters ? characters[id] : null;
		if (!c) { return { error: "Select a tracked character (logged in with EVE SSO) first." }; }
		if (!c.accessToken) { return { error: (c.characterName || "This character") + " has no ESI login. Log in again with EVE SSO." }; }
		return { characterID: id, name: c.characterName || String(id) };
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

		/** Send a gate path to the in-game autopilot */
		function push(path, label) {
			if (busy) { notify("Still setting the previous route, one moment.", "yellow", 4000); return; }
			const who = ap.character(options, tripwire.esi && tripwire.esi.characters);
			if (who.error) { notify(ap.escape(who.error), "red", 8000); return; }
			const leg = ap.kspaceLeg(path, appData.systems);	// never send wormhole space (it can't be waypointed)
			const limited = ap.limit(ap.waypoints(leg, appData.map.shortest, appData.systems));
			const waypoints = limited.waypoints;
			if (!waypoints.length) { notify("Nothing to set: no gate jumps on this route.", "yellow", 5000); return; }
			const dest = systemName(waypoints[waypoints.length - 1]);
			busy = true;
			// One toast for the whole run, updated per waypoint (jBox is what Notify uses)
			let progress = null;
			const showProgress = function(done) {
				const html = ap.escape(ap.progressText(label, done, waypoints.length));
				if (progress) { progress.setContent(html); return; }
				if (typeof jBox === "undefined") { notify(html, "blue", 3000); return; }
				progress = new jBox("Notice", { content: html, offset: { y: 35 }, animation: "flip", color: "blue", autoClose: false });
			};
			const closeProgress = function() { if (progress) { progress.close(); progress = null; } };
			showProgress(0);
			ap.sendAll(waypoints, function(systemID, clear) {
				return tripwire.esi.setDestination(systemID, who.characterID, clear, false);
			}, showProgress).then(function() {
				busy = false;
				closeProgress();
				notify(ap.escape(ap.doneText(label, who.name, leg.length - 1, limited, systemName)), "green", limited.capped ? 15000 : 6000);
			}, function(failure) {
				busy = false;
				closeProgress();
				const at = failure.index === 1 ? " Only the first waypoint was set."
					: failure.index > 1 ? " Only the first " + failure.index + " waypoints were set." : "";
				notify("Could not set the route to " + ap.escape(dest) + " in game. " + ap.escape(ap.errorText(failure.error)) + at, "red", 12000);
			});
		}
		ap.push = push;

		// ---- Favourites panel: a button next to each favourite's route button ----

		function favouriteButton(id) {
			const fp = favouritesPanel;
			const flags = fp.flags(fp.settings(options), id);
			if (!flags.route) { return ""; }
			const plan = (fp.lastRoutes[id] || {})[flags.route];
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
			const leg = ap.favouriteLeg(plan, trackedSystem(), id, function(from, to, safe) {
				return ap.gatePath(gateMap(), appData.systems, from, to, safe, avoidList());
			});
			if (leg.error) { notify(ap.escape(leg.error), "yellow", 5000); return; }
			push(leg.path, systemName(leg.from) + " → " + systemName(id) + (flags.route === "safe" ? " (safe)" : ""));
		}

		// ---- Destinations window: a button in each row ----

		function destinationButton(id) {
			const rd = routeDestinations;
			const best = rd.evaluate(rd.lastExits, id, rd.routingLimit()).best;
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
			const best = rd.evaluate(rd.lastExits, id, rd.routingLimit()).best;
			const leg = ap.destinationLeg(best);
			if (leg.error) { notify(ap.escape(leg.error), "yellow", 5000); return; }
			push(leg.path, systemName(leg.from) + " → " + systemName(id));
		}

		$(function() {
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
