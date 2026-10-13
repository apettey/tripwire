const mapTargets = {
	// Fork-owned: region map targets. Any member of the active mask marks up to 25 k-space systems as targets (with a short
	// note and an expiry); everyone on the mask sees them on the region map (numbered magenta rings, a "Targets" list) and as
	// numbered badges on the chain map, and can send them to their characters as in-game waypoints in list order.
	// Server: public/map_targets.php (fork_map_targets). Pure logic first (testable in Node); the browser part at the bottom
	// (shared store, chain badges, Settings > Map Markers row, Ctrl+K, waypoint sending). The region map's UI for targets is
	// in region-map-view.js. Keep `const mapTargets` on the first line: the test helper strips it to define a global.
	URL: "map_targets.php",
	MAX: 25,
	NOTE_MAX: 60,
	HOURS: [1, 3, 6, 24],
	DEFAULT_HOURS: 6,
	POLL_MS: 30000,		// while the region map is open
	IDLE_POLL_MS: 300000,	// otherwise (chain badges), while the page is visible

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** Chain map badges on/off: options.mapTargets.enabled (a missing key means on) */
	enabled: function(opts) {
		return !(opts && opts.mapTargets && typeof opts.mapTargets === "object" && opts.mapTargets.enabled === false);
	},

	/** Whether a system can be a target: k-space (not wormhole space), as the server checks */
	canTarget: function(system) {
		return !!system && !system.class && (Number(system.regionID) || 0) > 0 && Number(system.regionID) < 11000000;
	},

	/** A note as the server stores it: plain text, whitespace and control characters as one space, trimmed, at most 60 */
	cleanNote: function(text) {
		return String(text === undefined || text === null ? "" : text).replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().substring(0, mapTargets.NOTE_MAX);
	},

	/** The server's list, cleaned and in order: [{systemID, note, ord, createdBy: {id, name}, created, expires}] */
	normalise: function(list) {
		return (Array.isArray(list) ? list : []).filter(function(t) { return t && Number(t.systemID) > 0; }).map(function(t) {
			const by = t.createdBy && typeof t.createdBy === "object" ? t.createdBy : {};
			return { systemID: Number(t.systemID), note: String(t.note || ""), ord: Number(t.ord) || 0,
				createdBy: { id: Number(by.id) || 0, name: String(by.name || "") }, created: Number(t.created) || 0, expires: Number(t.expires) || 0 };
		}).sort(function(a, b) { return a.ord - b.ord || a.created - b.created || a.systemID - b.systemID; });
	},

	/** Live targets only (expires after now) */
	live: function(list, now) {
		return (list || []).filter(function(t) { return t.expires > now; });
	},

	/** {systemID: {n (1-based position), target}} */
	numbers: function(list) {
		const out = {};
		(list || []).forEach(function(t, i) { out[t.systemID] = { n: i + 1, target: t }; });
		return out;
	},

	/** "2h10m" / "34m" / "<1m" */
	duration: function(seconds) {
		const s = Math.max(0, Math.floor(Number(seconds) || 0));
		const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
		if (h > 0) { return h + "h" + (m < 10 ? "0" : "") + m + "m"; }
		return m > 0 ? m + "m" : "<1m";
	},

	/** The default expiry of a new target: the end of the latest raidable skyhook window of the system when it has one
	that hasn't ended (lastEnd, unix s; at most 7 days ahead), else 6 hours. @return {until} or {hours, label} */
	defaultExpiry: function(lastEnd, now) {
		const end = Number(lastEnd) || 0;
		if (end > now + 60 && end <= now + 7 * 86400) { return { until: Math.floor(end), label: "until its skyhook window ends" }; }
		return { hours: mapTargets.DEFAULT_HOURS, label: mapTargets.DEFAULT_HOURS + " h" };
	},

	/** The POST parameters of an expiry choice: "keep" (nothing), "skyhook" (with until), or a number of hours */
	expiryParams: function(choice, until) {
		if (choice === "keep") { return {}; }	// no expiry sent: the server keeps the target's current one
		if (choice === "skyhook" && Number(until) > 0) { return { until: String(Math.floor(Number(until))) }; }
		const h = Number(choice);
		return { hours: String(mapTargets.HOURS.indexOf(h) >= 0 ? h : mapTargets.DEFAULT_HOURS) };
	},

	/** The list order after moving one target up (-1) or down (+1); null when it can't move */
	move: function(ids, systemID, dir) {
		const list = (ids || []).map(Number), i = list.indexOf(Number(systemID)), j = i + dir;
		if (i < 0 || j < 0 || j >= list.length) { return null; }
		const out = list.slice();
		out[i] = list[j];
		out[j] = list[i];
		return out;
	},

	/** The list order after dragging one target before another (or to the end when beforeID is not in the list) */
	moveBefore: function(ids, systemID, beforeID) {
		const id = Number(systemID), list = (ids || []).map(Number).filter(function(x) { return x !== id; });
		if (list.length === (ids || []).length) { return null; }
		const at = list.indexOf(Number(beforeID));
		if (at < 0) { list.push(id); } else { list.splice(at, 0, id); }
		return list;
	},

	/** Nearest-neighbour order: from the start, always the closest target not visited yet (gate jumps); targets nobody can
	reach by gate go last, in their list order. distFrom(ids) -> {systemID: {jumps}} (a multi-source search: from any of ids) */
	shortestOrder: function(startIDs, ids, distFrom) {
		const left = (ids || []).map(Number), out = [];
		let from = (startIDs || []).map(Number).filter(Boolean);
		while (left.length) {
			const dist = from.length ? (distFrom(from) || {}) : {};
			let best = -1, bestJumps = Infinity;
			left.forEach(function(id, i) {
				const d = dist[id];
				const j = d && isFinite(Number(d.jumps)) ? Number(d.jumps) : Infinity;
				if (j < bestJumps) { best = i; bestJumps = j; }
			});
			if (best < 0) { return out.concat(left); }
			const next = left.splice(best, 1)[0];
			out.push(next);
			from = [next];
		}
		return out;
	},

	/** The waypoints to send: [{systemID, clear}] (the first clears the character's other waypoints), at most 25 */
	waypoints: function(ids) {
		return (ids || []).map(Number).filter(Boolean).slice(0, mapTargets.MAX).map(function(id, i) { return { systemID: id, clear: i === 0 }; });
	},

	/** Send the waypoints to each character, one ESI call after another; a character stops at its first error, the others
	go on. sendOne(characterID, systemID, clear) returns a thenable. progress(done, total) after each call (optional).
	@return Promise (never rejects) of [{characterID, name, sent, total, error}] */
	send: function(characters, plan, sendOne, progress) {
		const results = [], total = (characters || []).length * (plan || []).length;
		let done = 0, chain = Promise.resolve();
		(characters || []).forEach(function(c) {
			const r = { characterID: c.characterID, name: c.name, sent: 0, total: plan.length, error: null };
			results.push(r);
			plan.forEach(function(w) {
				chain = chain.then(function() {
					// after an error this character's remaining waypoints are skipped (they still count as done for the progress)
					const call = r.error ? Promise.resolve() : new Promise(function(resolve) { resolve(sendOne(c.characterID, w.systemID, w.clear)); }).then(function() {
						r.sent++;
					}, function(error) {
						r.error = error || { status: 0 };
					});
					return call.then(function() {
						done++;
						if (progress) { try { progress(done, total); } catch (e) { /* the UI went away */ } }
					});
				});
			});
		});
		return chain.then(function() { return results; });
	},

	/** Result line: {color, lines} - "Sent 4 waypoints to 2 pilots", and a line per pilot that failed */
	summary: function(results, errorText) {
		const list = results || [];
		const ok = list.filter(function(r) { return !r.error; }), failed = list.filter(function(r) { return r.error; });
		const n = list.length ? list[0].total : 0;
		const words = function(count, what) { return count + " " + what + (count === 1 ? "" : "s"); };
		const lines = [];
		if (ok.length) { lines.push("Sent " + words(n, "waypoint") + " to " + words(ok.length, "pilot") + "."); }
		failed.forEach(function(r) {
			lines.push(r.name + ": stopped after " + words(r.sent, "waypoint") + " of " + r.total + " (" + (errorText ? errorText(r.error) : "error") + ")");
		});
		return { color: !failed.length ? "green" : ok.length ? "yellow" : "red", lines: lines };
	},

	/** "Target <system> [note]" typed in Ctrl+K: the note is the rest of the line after the system (cleaned) */
	commandNote: function(text) {
		return mapTargets.cleanNote(text);
	},

	// ---- Chain map badge ----

	insertBadge: function(nodeHtml, html) {
		if (!html || typeof nodeHtml !== "string" || nodeHtml.indexOf("target-badge") >= 0) { return nodeHtml; }
		const at = nodeHtml.indexOf("<div class='nodeIcons'>");
		return at < 0 ? nodeHtml : nodeHtml.substring(0, at) + html + nodeHtml.substring(at);
	},

	/** Add the numbered badge to chain nodes of target systems (chain.nodes() output, in place); returns how many */
	decorate: function(result, numbers) {
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		let n = 0;
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || typeof node.f !== "string" || row.destination) { return; }
			const t = numbers && numbers[parseInt(node.systemID, 10)];
			if (!t) { return; }
			const tip = "Target " + t.n + (t.target.note ? ": " + t.target.note : "") + (t.target.createdBy.name ? " (marked by " + t.target.createdBy.name + ")" : "");
			const f = mapTargets.insertBadge(node.f, "<span class='target-badge' title='" + mapTargets.escape(tip) + "'>" + t.n + "</span>");
			if (f !== node.f) { node.f = f; n++; }
		});
		return n;
	},

	/** A key of what the chain badges show: the chain is redrawn when it changes */
	badgeKey: function(list) {
		return (list || []).map(function(t, i) { return t.systemID + ":" + (i + 1) + ":" + t.note; }).join("|");
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined") {
	(function() {
		const mt = mapTargets;
		const state = { list: [], loadedAt: 0, loading: null, failedAt: 0, error: null, skew: 0, listeners: [], badgeKey: "", busy: false };

		function opts() { return typeof options !== "undefined" ? options : null; }
		function sysName(id) { const s = appData.systems[id]; return s && s.name ? s.name : String(id); }
		function notify(html, color, ms) { if (typeof Notify !== "undefined") { Notify.trigger(html, color, ms); } else { console.log(html); } }
		function now() { return Date.now() / 1000 + state.skew; }
		function redrawChain() { if (typeof chain !== "undefined" && chain && chain.data && chain.data.rawMap) { chain.redraw(); } }

		function changed() {
			const key = mt.enabled(opts()) ? mt.badgeKey(state.list) : "";
			if (key !== state.badgeKey) { state.badgeKey = key; redrawChain(); }
			state.listeners.forEach(function(fn) { try { fn(); } catch (e) { console.error("Targets: listener failed", e); } });
		}

		function take(d) {
			if (!d || !Array.isArray(d.targets)) { return false; }
			state.list = mt.normalise(d.targets);
			state.loadedAt = Date.now();
			state.error = null;
			if (d.now) { state.skew = d.now - Date.now() / 1000; }
			return true;
		}

		function load() {
			if (state.loading) { return state.loading; }
			state.loading = $.ajax({ url: mt.URL, dataType: "json", cache: false }).done(function(d) {
				if (!take(d)) { state.error = "Unexpected answer from the server."; }
			}).fail(function(xhr) {
				state.failedAt = Date.now();
				state.error = xhr && xhr.status === 403 ? "Not signed in." : "Could not load the targets.";
			}).always(function() { state.loading = null; changed(); });
			return state.loading;
		}

		/** POST a change; the answer is the new list. @return the jqXHR */
		function post(params) {
			return $.ajax({ url: mt.URL, type: "POST", data: params, dataType: "json", headers: { "X-Requested-With": "XMLHttpRequest" } }).done(function(d) {
				take(d);
				changed();
			}).fail(function(xhr) {
				const msg = xhr && xhr.responseJSON && xhr.responseJSON.error ? xhr.responseJSON.error : "Could not save the targets (error " + (xhr && xhr.status || "?") + ").";
				notify(mt.escape(msg), "red", 6000);
			});
		}

		/** The list, refreshed when older than maxAge (default 30 s): the region map calls it on every paint */
		function get(maxAge) {
			const age = maxAge === undefined ? mt.POLL_MS : maxAge;
			if (!state.loading && Date.now() - state.loadedAt >= age && Date.now() - state.failedAt >= 30000) { load(); }
			return { list: mt.live(state.list, now()), loaded: state.loadedAt > 0, error: state.error, now: now() };
		}

		/** A live target (an expired one that the server hasn't purged yet counts as none) */
		function find(id) { return mt.live(state.list, now()).filter(function(t) { return t.systemID === Number(id); })[0] || null; }

		/** The latest end of the system's raidable skyhook windows (any filter), for the default expiry; 0 when none */
		function skyhookEnd(id) {
			try {
				if (typeof skyhooksPanel === "undefined" || !skyhooksPanel.store || typeof regionMapSkyhooks === "undefined") { return 0; }
				const st = skyhooksPanel.store.get();
				if (!st.data) { return 0; }
				const all = { window: "all", low: true, null: true, lava: true, ice: true, soonHours: 2, sort: "jumps" };
				const e = regionMapSkyhooks.bySystem(st.data.skyhooks.filter(function(s) { return Number(s.systemID) === Number(id); }), skyhooksPanel.store.systemFor, skyhooksPanel.store.now(), all, st.planets)[id];
				return e ? e.lastEnd : 0;
			} catch (e) { return 0; }
		}

		function add(id, note, choice) {
			id = Number(id);
			if (!mt.canTarget(appData.systems[id])) { notify("Targets: only k-space systems can be targets.", "yellow", 5000); return null; }
			const existing = find(id);
			if (!existing && mt.live(state.list, now()).length >= mt.MAX) { notify("Targets: at most " + mt.MAX + " targets per mask. Remove one first.", "yellow", 6000); return null; }
			const def = mt.defaultExpiry(skyhookEnd(id), now());
			const params = Object.assign({ mode: "add", systemID: id, note: mt.cleanNote(note) },
				choice ? mt.expiryParams(choice, def.until) : (def.until ? { until: String(def.until) } : { hours: String(def.hours) }));
			return post(params);
		}
		function remove(id) { return post({ mode: "remove", systemID: Number(id) }); }
		function clear() { return post({ mode: "clear" }); }
		function reorder(ids) { return post({ mode: "reorder", order: (ids || []).map(Number).join(",") }); }
		function toggle(id) { return find(id) ? remove(id) : add(id, ""); }

		// ---- Waypoints: the existing character picker of autopilot-route.js, then one ESI call per waypoint ----

		function sendWaypoints(ids) {
			const list = (ids || mt.live(state.list, now()).map(function(t) { return t.systemID; })).slice(0, mt.MAX);
			if (!list.length) { notify("No targets to send.", "yellow", 4000); return; }
			if (state.busy) { notify("Still sending the previous waypoints, one moment.", "yellow", 4000); return; }
			if (typeof autopilotRoute === "undefined" || typeof autopilotRoute.pickCharacters !== "function") { notify("The character picker is not loaded.", "red", 5000); return; }
			const plan = mt.waypoints(list);
			const label = "Targets: " + plan.length + " waypoint" + (plan.length === 1 ? "" : "s") + " (" + plan.map(function(w) { return sysName(w.systemID); }).join(" → ") + ")";
			autopilotRoute.pickCharacters(label, null, false, function(characters) {
				if (state.busy) { notify("Still sending the previous waypoints, one moment.", "yellow", 4000); return; }
				state.busy = true;
				const progress = function(done, total) { $(".rm-tsend-status").text("Sending waypoints… " + done + "/" + total); };
				progress(0, characters.length * plan.length);
				mt.send(characters, plan, function(characterID, systemID, clearOthers) {
					if (typeof esiLimits !== "undefined" && esiLimits.isCharacterPaused(characterID)) { return Promise.reject({ status: 429 }); }
					return tripwire.esi.setDestination(systemID, characterID, clearOthers, false);
				}, progress).then(function(results) {
					state.busy = false;
					const s = mt.summary(results, autopilotRoute.errorText);
					$(".rm-tsend-status").text(s.lines[0] || "");
					notify(s.lines.map(mt.escape).join("<br/>"), s.color, s.color === "green" ? 6000 : 15000);
				});
			}, { title: "Send waypoints", hint: "The first target replaces each character's in-game route; the others are added as waypoints in this order. EVE's autopilot flies between them with your in-game route settings." });
		}

		mt.store = {
			get: get, refresh: load, find: find, add: add, remove: remove, clear: clear, reorder: reorder, toggle: toggle,
			sendWaypoints: sendWaypoints, skyhookEnd: skyhookEnd, now: now,
			onChange: function(fn) { if (typeof fn === "function") { state.listeners.push(fn); } }
		};

		// ---- Chain map badges (re-applied on every redraw, like the staging scan's STG badge) ----
		let hooked = false;
		function installHook() {
			if (hooked || typeof chain === "undefined" || !chain || typeof chain.nodes !== "function" || chain.nodes.mapTargetsWrapped) { return; }
			hooked = true;
			const previous = chain.nodes;
			const wrapped = function() {
				const result = previous.apply(this, arguments);
				try { if (mt.enabled(opts()) && state.list.length) { mt.decorate(result, mt.numbers(mt.live(state.list, now()))); } } catch (e) { console.warn("Targets: could not decorate the chain", e); }
				return result;
			};
			Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
			wrapped.mapTargetsWrapped = true;
			chain.nodes = wrapped;
		}

		function setupSettings() {
			if (typeof forkSettings === "undefined") { return; }
			forkSettings.register({
				section: "markers", order: 65, id: "mapTargets-enabled", type: "checkbox", key: "mapTargets",
				label: "Target badges:", text: "Show the mask's region map targets as numbered badges on the chain map",
				keywords: ["target", "waypoint", "region map"],
				get: function(o) { return mt.enabled(o); },
				set: function(o, on) { o.mapTargets = Object.assign({}, o.mapTargets || {}, { enabled: on }); }
			});
			if (typeof options !== "undefined" && options.apply && !options.apply.mapTargetsWrapped) {
				const apply = options.apply;
				options.apply = function() {
					const result = apply.apply(this, arguments);
					try { changed(); } catch (err) { console.error("Targets: apply failed", err); }
					return result;
				};
				options.apply.mapTargetsWrapped = true;
			}
		}

		function setupCommands() {
			if (typeof forkCommands === "undefined") { return; }
			forkCommands.register({
				id: "targets.add", title: "Target", group: "Navigation", icon: "follow",
				keywords: ["target", "mark", "waypoint", "region map", "skyhook"],
				args: [
					{ name: "system", label: "system", type: "system", default: function(ctx) { return mt.canTarget(appData.systems[ctx.viewingSystemID]) ? ctx.viewingSystemID : undefined; } },
					{ name: "note", label: "note", type: "text", optional: true }
				],
				run: function(args) {
					if (!mt.canTarget(appData.systems[args.system])) { throw new Error("Pick a k-space system"); }
					// Already a target: keep its expiry, and its note unless the command gives one
					const existing = find(args.system), note = mt.commandNote(args.note);
					const xhr = add(args.system, note || (existing ? existing.note : ""), existing ? "keep" : undefined);
					if (xhr) { xhr.done(function() { notify("Target set: " + mt.escape(sysName(args.system)) + " (the whole mask sees it)", "green", 4000); }); }
				}
			});
			forkCommands.register({
				id: "targets.send", title: "Send target waypoints", group: "Navigation", icon: "auto",
				keywords: ["target", "waypoint", "autopilot", "destination", "in game"],
				run: function() {
					const go = function() { sendWaypoints(); };
					if (state.loadedAt) { go(); } else { load().always(go); }
				}
			});
		}

		installHook();
		$(function() {
			installHook();
			setupSettings();
			setupCommands();
			load();
			// Chain badges without the region map: a slow refresh while the page is visible (the map polls every 30 s)
			setInterval(function() { if (!document.hidden && Date.now() - state.loadedAt >= mt.IDLE_POLL_MS) { load(); } }, 60000);
		});
	})();
}
