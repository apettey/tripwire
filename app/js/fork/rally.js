const rally = {
	// "Fight here" (first called the rally point): one system per mask that everyone on the chain map sees highlighted,
	// in the colour of the fleet comp it is for, plus the wormhole route to it from the viewer's location (fork-owned
	// file; server side is public/rally.php, comps in app/js/fork/fight-comps.js and public/fight.php). Internal names
	// stay "rally"; everything users read says "Fight here".
	// Keep `const rally` on the first line: the test helper strips it to define a global.
	URL: "rally.php",
	POLL_MS: 10000,
	LOCATION_CHECK_MS: 2000,
	BANNER_TICK_MS: 30000,
	ROUTE_CLASS: "rally-route",
	NODE_CLASS: "rally-node",
	COLOUR_PREFIX: "fight-c-",
	MENU_COMMAND: "fightMenu",	// "Fight here ▸" with the comps (masks with at least one comp)
	TOGGLE_COMMAND: "fightToggle",	// one-click "Fight here" / "Clear fight" (masks without comps)

	// Current fight point of this mask: { systemID, setBy, setAt, comp: {id, name, colour, note} | null, label, age, receivedAt }
	state: { systemID: null, setBy: null, setAt: null, comp: null, label: "", age: null, receivedAt: null },
	// The mask's fleet comps (normalised, fightComps.normaliseComps)
	comps: [],
	// Result of the last decorate() call (see there)
	lastRoute: null,

	/** Real New Eden / J-space system IDs only (not unknown-system or calculated nodes) */
	isRealSystemID: function(id) {
		if (id === null || id === undefined || id === "" || typeof id === "boolean") { return false; }
		const n = Number(id);
		return Number.isInteger(n) && n >= 30000000 && n < 32000000;
	},

	/** Shortest path (fewest connections) through an undirected graph.
	@param connections array of [a, b, modifiers, id] (the chain map's line format; a/b are node keys)
	@param start node key to start from
	@param target node key to reach
	@return the ids (4th element) of the connections on the path, in order from start to target;
		[] if start == target; null if the target can't be reached */
	routeTo: function(connections, start, target) {
		if (start === null || start === undefined || target === null || target === undefined) { return null; }
		const s = String(start), t = String(target);
		if (s === t) { return []; }

		const adjacency = {};
		(connections || []).forEach(function(c) {
			if (!c) { return; }
			const a = String(c[0]), b = String(c[1]);
			if (a === b) { return; }
			(adjacency[a] = adjacency[a] || []).push({ to: b, id: c[3] });
			(adjacency[b] = adjacency[b] || []).push({ to: a, id: c[3] });
		});

		const previous = {};	// node -> { from, id }
		previous[s] = null;
		const queue = [s];
		while (queue.length) {
			const current = queue.shift();
			if (current === t) { break; }
			(adjacency[current] || []).forEach(function(edge) {
				if (!Object.prototype.hasOwnProperty.call(previous, edge.to)) {
					previous[edge.to] = { from: current, id: edge.id };
					queue.push(edge.to);
				}
			});
		}
		if (!Object.prototype.hasOwnProperty.call(previous, t)) { return null; }

		const path = [];
		for (let step = previous[t]; step; step = previous[step.from]) {
			path.unshift(step.id);
		}
		return path;
	},

	/** Map chain node ids (row.c[0].v) to their system IDs (as strings) */
	nodeSystems: function(rows) {
		const result = {};
		(rows || []).forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (node && node.v !== undefined && node.v !== null) { result[node.v] = String(node.systemID); }
		});
		return result;
	},

	/** Turn the chain map's lines ([childNodeId, parentNodeId, modifiers, wormholeId]) into system-level
	connections [childSystemID, parentSystemID, modifiers, lineIndex]. Working on systems rather than
	nodes means a system shown twice (a loop) is one place. Lines without a wormhole id (calculated gate
	routes) are left out: the route only follows wormholes. */
	systemConnections: function(rows, lines) {
		const systems = rally.nodeSystems(rows);
		const result = [];
		(lines || []).forEach(function(line, index) {
			if (!line || line[3] === undefined || line[3] === null || line[3] === "?") { return; }
			const a = systems[line[0]], b = systems[line[1]];
			if (a === undefined || b === undefined) { return; }
			result.push([a, b, line[2], index]);
		});
		return result;
	},

	/** Set of system IDs (as strings) drawn on the map */
	systemsOnMap: function(rows) {
		const result = {};
		(rows || []).forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (node && node.systemID !== undefined && node.systemID !== null) { result[String(node.systemID)] = true; }
		});
		return result;
	},

	/** System ID (string) of the first chain root, or null */
	rootSystem: function(rows) {
		const root = (rows || []).filter(function(row) {
			return row && row.c && row.c[0] && row.c[0].systemID !== undefined && (!row.c[1] || row.c[1].v === null || row.c[1].v === undefined);
		})[0];
		return root ? String(root.c[0].systemID) : null;
	},

	/** Where the route starts: the tracked character's system if it's on the map, else the viewing
	system if it's on the map, else the chain root */
	pickStart: function(onMap, trackedID, viewingID, rootID) {
		if (trackedID !== undefined && trackedID !== null && onMap[String(trackedID)]) { return String(trackedID); }
		if (viewingID !== undefined && viewingID !== null && onMap[String(viewingID)]) { return String(viewingID); }
		return rootID === undefined ? null : rootID;
	},

	/** The colour class of a fight point's comp ("fight-c-red"), "" without a comp (today's green rally style) */
	colourClass: function(comp) {
		if (!comp || !comp.colour) { return ""; }
		const key = typeof fightComps !== "undefined" ? fightComps.colourKey(comp.colour) : String(comp.colour).replace(/[^a-z]/g, "");
		return key ? rally.COLOUR_PREFIX + key : "";
	},

	/** Add the fight point class (and the comp's colour class) to a node's markup (makeSystemNode output) */
	markNode: function(markup, colourClass) {
		if (typeof markup !== "string" || markup.indexOf(" " + rally.NODE_CLASS + " ") >= 0) { return markup; }
		return markup.replace("class='node ", "class='node " + rally.NODE_CLASS + " " + (colourClass ? colourClass + " " : ""));
	},

	/** Decorate the output of chain.nodes() in place for the current fight point: mark its nodes and add the
	route class (and the comp's colour class) to the lines on the route. Returns
	{ rallySystemID, onMap, startSystemID, jumps, lineIndexes } (jumps null if unreachable / not on map)
	@param result chain.nodes() output: { map: { rows }, lines }
	@param rallySystemID current fight system or null
	@param locations { tracked, viewing } system IDs
	@param colourClass the comp's colour class (rally.colourClass), "" / undefined without a comp */
	decorate: function(result, rallySystemID, locations, colourClass) {
		const rows = (result && result.map && result.map.rows) || [];
		const lines = (result && result.lines) || [];
		locations = locations || {};

		// Lines are rebuilt on each draw, but strip any stale class anyway
		lines.forEach(function(line) {
			if (line && Array.isArray(line[2])) {
				for (let i = line[2].length - 1; i >= 0; i--) {
					if (line[2][i] === rally.ROUTE_CLASS || String(line[2][i]).indexOf(rally.COLOUR_PREFIX) === 0) { line[2].splice(i, 1); }
				}
			}
		});

		const info = { rallySystemID: rallySystemID, onMap: false, startSystemID: null, jumps: null, lineIndexes: [] };
		if (!rally.isRealSystemID(rallySystemID)) { return info; }
		const target = String(rallySystemID);

		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (node && String(node.systemID) === target) {
				node.f = rally.markNode(node.f, colourClass);
				info.onMap = true;
			}
		});
		if (!info.onMap) { return info; }

		const onMap = rally.systemsOnMap(rows);
		info.startSystemID = rally.pickStart(onMap, locations.tracked, locations.viewing, rally.rootSystem(rows));
		const connections = rally.systemConnections(rows, lines);
		const hf = typeof routeHoleFilters !== "undefined" && routeHoleFilters.contextFor ? routeHoleFilters.contextFor(lines) : null;	// avoid EOL / crit / ... holes
		const found = hf ? routeHoleFilters.route(connections, info.startSystemID, target, hf) : null;
		const route = hf ? (found && found.path) : rally.routeTo(connections, info.startSystemID, target);
		if (route) {
			info.jumps = route.length;
			info.lineIndexes = route;
			info.holeNote = found ? found.note : "";
			if (found) { routeHoleFilters.markLines(lines, found.marks); }
			route.forEach(function(index) {
				const line = lines[index];
				if (line && Array.isArray(line[2]) && line[2].indexOf(rally.ROUTE_CLASS) < 0) {
					line[2].push(rally.ROUTE_CLASS);
					if (colourClass) { line[2].push(colourClass); }
				}
			});
		}
		return info;
	},

	/** Route text in the banner */
	routeText: function(info) {
		if (!info || !info.onMap) { return "not on this map"; }
		if (info.jumps === null || info.jumps === undefined) { return "no route"; }
		if (info.jumps === 0) { return "you are here"; }
		return info.jumps + (info.jumps == 1 ? " jump" : " jumps") + (info.holeNote ? " \u26a0 " + info.holeNote.replace(/^No route avoiding [^\u2014]*\u2014 this one /, "") : "");
	},

	/** Fight point data from the server -> state ({systemID: null} when there is none) */
	normaliseState: function(data, now) {
		const systemID = data && rally.isRealSystemID(data.systemID) ? Number(data.systemID) : null;
		if (!systemID) { return { systemID: null, setBy: null, setAt: null, comp: null, label: "", age: null, receivedAt: null }; }
		const comp = data.comp && typeof fightComps !== "undefined" ? fightComps.normaliseComp(data.comp) : null;
		const age = data.age === undefined || data.age === null || isNaN(Number(data.age)) ? null : Math.max(0, Number(data.age));
		return { systemID: systemID, setBy: data.setBy || null, setAt: data.setAt || null, comp: comp,
			label: typeof data.label === "string" ? data.label : "", age: age, receivedAt: age === null ? null : (now || Date.now()) };
	},

	/** Whether two states show a different fight (system or comp) */
	differs: function(a, b) {
		const compKey = function(s) { return s && s.comp ? [s.comp.id, s.comp.name, s.comp.colour, s.comp.note].join("|") : ""; };
		return String(a && a.systemID) !== String(b && b.systemID) || compKey(a) !== compKey(b);
	},

	/** Seconds since the fight point was set, now */
	ageNow: function(state, now) {
		if (!state || state.age === null || state.age === undefined || !state.receivedAt) { return null; }
		return state.age + Math.max(0, ((now || Date.now()) - state.receivedAt) / 1000);
	},

	// ---- Settings (Settings > Map Markers > Fight here) ----
	// Discord (server side: public/rally.php; the channel is the "Fight here" type corp admins set up in Mask Admin >
	// Discord, discord/rally.php, or else upstream's server-wide DISCORD_WEB_HOOK)
	DISCORD_COMMAND: "rallyDiscord",
	DISCORD_HELP: "Fight here changes go to the Discord channel your corporation's admins chose in Mask Admin > Discord.",
	// Whether fight changes of this mask go to Discord at all (from rally.php's "discord")
	discordAvailable: false,

	/** "Also post to Discord" choice: options.rallyDiscord.enabled, a missing key means on */
	discordEnabled: function(opts) {
		return !(opts && opts.rallyDiscord && opts.rallyDiscord.enabled === false);
	},

	/** The fight banner in the chain map header: options.fightBanner.enabled, a missing key means on */
	bannerEnabled: function(opts) {
		return !(opts && opts.fightBanner && opts.fightBanner.enabled === false);
	},

	/** POST body for a change: adds discord=1 when the mask has a webhook and the user wants it */
	changePayload: function(payload, available, opts) {
		const result = Object.assign({}, payload);
		result.discord = available && rally.discordEnabled(opts) ? 1 : 0;
		return result;
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Notification text when someone else sets or moves the fight (HTML-escaped) */
	notifyText: function(name, state) {
		return "Fight here: " + rally.escape(name) + (state.comp ? " &middot; " + rally.escape(state.comp.name) : "")
			+ (state.setBy ? " (set by " + rally.escape(state.setBy) + ")" : "");
	},

	// ---- Browser-only code below (not run under mocha) ----

	systemName: function(systemID) {
		const system = typeof tripwire !== "undefined" && tripwire.systems ? tripwire.systems[systemID] : null;
		return system && system.name ? system.name : String(systemID);
	},

	currentLocations: function() {
		return {
			tracked: tripwire.client && tripwire.client.EVE ? tripwire.client.EVE.systemID : null,
			viewing: typeof viewingSystemID !== "undefined" ? viewingSystemID : null
		};
	},

	redraw: function() {
		if (chain && chain.data && chain.data.rawMap) { chain.redraw(); }
		rally.renderBanner();
	},

	renderBanner: function() {
		const banner = $("#rally-banner");
		if (!banner.length) { return; }
		if (!rally.isRealSystemID(rally.state.systemID) || !rally.bannerEnabled(typeof options !== "undefined" ? options : null)) {
			banner.addClass("hidden");
			return;
		}
		const system = typeof tripwire !== "undefined" && tripwire.systems ? tripwire.systems[rally.state.systemID] : null;
		const info = rally.lastRoute && String(rally.lastRoute.rallySystemID) === String(rally.state.systemID) ? rally.lastRoute : null;
		const parts = fightComps.bannerParts(rally.state, system, rally.routeText(info), rally.ageNow(rally.state));
		banner.find(".rally-name").attr("href", ".?system=" + encodeURIComponent(rally.systemName(rally.state.systemID))).text(parts.where);
		banner.find(".rally-jumps").text(parts.details ? "(" + parts.details + ")" : "");
		const $comp = banner.find(".fight-comp").toggleClass("hidden", !parts.comp);
		if (parts.comp) {
			$comp.find(".fight-dot").css("background-color", fightComps.colourOf(parts.comp.colour));
			$comp.find(".fight-comp-name").text(parts.comp.name);
		}
		banner.find(".fight-who").text(parts.who ? " · " + parts.who : "");
		banner.find(".fight-age").text(parts.age ? " · " + parts.age : "");
		banner.attr("title", fightComps.bannerTitle(parts));
		banner.attr("class", rally.colourClass(rally.state.comp));
	},

	/** Apply fight point data from the server; redraw if it changed */
	apply: function(data, fromOthers) {
		const next = rally.normaliseState(data);
		const changed = rally.differs(rally.state, next);
		rally.state = next;
		if (changed) {
			if (fromOthers && next.systemID && typeof Notify !== "undefined") {
				Notify.trigger(rally.notifyText(fightComps.labelSystem(next.label, rally.systemName(next.systemID)), next), "green");
			}
			rally.redraw();
		} else {
			rally.renderBanner();
		}
	},

	/** The mask's comps changed (rally.php's answer, or an admin's change in Mask Admin > Fight here) */
	setComps: function(list) {
		rally.comps = fightComps.normaliseComps(list);
	},

	answer: function(data, fromOthers) {
		if (!data) { return; }
		rally.discordAvailable = !!data.discord;
		if (data.comps) { rally.setComps(data.comps); }
		rally.apply(data.rally, fromOthers);
	},

	fetch: function() {
		return $.ajax({ url: rally.URL, type: "GET", dataType: "JSON", cache: false })
			.done(function(data) { rally.answer(data, true); });
	},

	post: function(payload) {
		return $.ajax({
			url: rally.URL, type: "POST", dataType: "JSON",
			data: rally.changePayload(payload, rally.discordAvailable, typeof options !== "undefined" ? options : null),
			headers: { "X-Requested-With": "XMLHttpRequest" }
		}).done(function(data) {
			rally.answer(data, false);
		}).fail(function(xhr) {
			if (typeof Notify !== "undefined") {
				Notify.trigger(rally.escape((xhr && xhr.responseJSON && xhr.responseJSON.error) || "Couldn't update the fight point"), "red");
			}
			rally.fetch();
		});
	},

	/** Set (or move) the fight point, with a comp of the mask ("" / undefined = no comp) */
	set: function(systemID, compID) {
		if (!rally.isRealSystemID(systemID)) { return; }
		const comp = compID ? rally.comps.filter(function(c) { return c.id === compID; })[0] || null : null;
		const same = String(rally.state.systemID) === String(systemID);
		// optimistic; keep the label while it stays on the same system
		rally.apply({ systemID: Number(systemID), setBy: tripwire.client && tripwire.client.EVE ? tripwire.client.EVE.characterName : null,
			comp: comp, label: same ? rally.state.label : "", age: 0 }, false);
		const payload = { mode: "set", systemID: Number(systemID) };
		if (comp) { payload.compID = comp.id; }
		return rally.post(payload);
	},

	clear: function() {
		rally.apply(null, false);
		return rally.post({ mode: "clear" });
	},

	renderDiscordEntry: function() {
		const on = rally.discordEnabled(options);
		$("#rallyDiscordMenuItem .rally-discord-check").html(on ? "&#9745;" : "&#9744;").toggleClass("on", on);
	},

	/** Remember the "Also post to Discord" choice for this user (saved with the other options) */
	setDiscordEnabled: function(enabled) {
		options.rallyDiscord = { enabled: !!enabled };
		$("#rallyDiscord-enabled").prop("checked", !!enabled);
		rally.renderDiscordEntry();
		if (typeof options.save === "function") { options.save(); }
	},

	/** Fill the "Fight here" submenu for the right-clicked system */
	renderSubmenu: function(systemID) {
		const entries = fightComps.menuEntries(rally.comps, rally.state, systemID, rally.systemName);
		$("#fightSubmenu").html(fightComps.menuHtml(entries));
		$("#chainMenu").menu("refresh");
	},

	setupSettings: function() {
		if (typeof options === "undefined") { return; }
		// Settings > Map Markers row; takes effect on Save like its neighbours (Reset = on for both)
		forkSettings.register({
			section: "markers", order: 50, id: "fightHere", type: "custom", label: "Fight here:",
			keywords: "rally discord banner comp",
			html: "<label title='The fight point, its fleet comp, who set it and when, above the chain map. The system is marked on the map either way.'><input type='checkbox' id='fightBanner-enabled' /> Show the fight banner in the chain map header</label><br/>"
				+ "<label title='" + rally.escape(rally.DISCORD_HELP) + "'><input type='checkbox' id='rallyDiscord-enabled' /> Post my fight changes to Discord</label>"
				+ "<div class='rally-discord-note'>Corp admins choose the channel in Mask Admin &gt; Discord and the fleet comps in Mask Admin &gt; Fight here.</div>",
			load: function(o) {
				$("#rallyDiscord-enabled").prop("checked", rally.discordEnabled(o));
				$("#fightBanner-enabled").prop("checked", rally.bannerEnabled(o));
			},
			save: function(o) {
				o.rallyDiscord = { enabled: $("#rallyDiscord-enabled").prop("checked") };
				o.fightBanner = { enabled: $("#fightBanner-enabled").prop("checked") };
				setTimeout(rally.renderBanner, 0);
			},
			reset: function(o) {
				delete o.rallyDiscord;
				delete o.fightBanner;
				setTimeout(rally.renderBanner, 0);
			}
		});
	},

	init: function() {
		if (typeof chain === "undefined" || !chain || typeof chain.nodes !== "function") { return; }
		rally.setupSettings();

		// Decorate every chain build (chain.draw and chain.redraw both go through chain.nodes) so the
		// highlight is part of the node markup and line modifiers, and survives redraws and collapses.
		const originalNodes = chain.nodes;
		chain.nodes = function() {
			const result = originalNodes.apply(this, arguments);
			try {
				rally.lastLocations = rally.currentLocations();
				rally.lastRoute = rally.decorate(result, rally.state.systemID, rally.lastLocations, rally.colourClass(rally.state.comp));
			} catch (e) { console.error("fight here: decorate failed", e); }
			setTimeout(rally.renderBanner, 0);
			return result;
		};

		// Banner in the chain map header
		// The text parts are cut with an ellipsis when the header is narrow; the clear button stays visible after them
		const banner = $("<span id='rally-banner' class='hidden'><span class='fight-sep'>|</span><span class='fight-text'><i class='rally-icon'>&#9873;</i> Fight here: <a class='rally-name' href='#'></a> <span class='rally-jumps'></span>"
			+ "<span class='fight-comp hidden'> · <span class='fight-dot'></span><span class='fight-comp-name'></span></span><span class='fight-who'></span><span class='fight-age'></span></span>"
			+ "<i class='rally-clear' title='Clear fight'>&#10005;</i></span>");
		const anchor = $("#chainWidget .controls #higgs-jump");
		if (anchor.length) { banner.insertAfter(anchor); } else { $("#chainWidget .controls").append(banner); }
		banner.on("click", ".rally-clear", function(e) { e.preventDefault(); rally.clear(); });

		// Context menu: "Fight here" with a submenu (no comp, one entry per comp, clear), filled when the menu opens
		try {
			const chainParent = $("#chainParent");
			$("#chainMenu").append("<li data-command='" + rally.MENU_COMMAND + "'><a id='rallyMenuItem'>Fight here</a><ul id='fightSubmenu' class='fight-submenu'></ul></li>");
			$("#chainMenu").append("<li data-command='" + rally.TOGGLE_COMMAND + "'><a id='fightToggleMenuItem'>Fight here</a></li>");
			$("#chainMenu").append("<li data-command='" + rally.DISCORD_COMMAND + "' class='rally-discord-entry'><a id='rallyDiscordMenuItem' title='" + rally.escape("Post your fight changes too. " + rally.DISCORD_HELP) + "'><span class='rally-discord-check'></span> Also post to Discord</a></li>");
			$("#fightSubmenu").html(fightComps.menuHtml(fightComps.menuEntries([], null, null)));
			$("#chainMenu").menu("refresh");

			const originalSelect = chainParent.contextmenu("option", "select");
			chainParent.contextmenu("option", "select", function(e, ui) {
				const compID = fightComps.compOfCommand(ui.cmd);
				if (compID !== null) {
					rally.set($(ui.target[0]).closest("[data-nodeid]").data("nodeid"), compID);
					return;
				}
				if (ui.cmd === rally.TOGGLE_COMMAND) {
					const systemID = $(ui.target[0]).closest("[data-nodeid]").data("nodeid");
					if (fightComps.flatEntry(rally.state, systemID).clear) { rally.clear(); } else { rally.set(systemID, ""); }
					return;
				}
				if (ui.cmd === fightComps.CLEAR_COMMAND) {
					rally.clear();
					return;
				}
				if (ui.cmd === rally.MENU_COMMAND) { return false; }	// the submenu's parent
				if (ui.cmd === rally.DISCORD_COMMAND) {
					rally.setDiscordEnabled(!rally.discordEnabled(options));
					return false;	// keep the menu open
				}
				return originalSelect ? originalSelect.apply(this, arguments) : undefined;
			});

			const originalBeforeOpen = chainParent.contextmenu("option", "beforeOpen");
			chainParent.contextmenu("option", "beforeOpen", function(e, ui) {
				const systemID = $(ui.target[0]).closest("[data-nodeid]").data("nodeid");
				try {
					// With comps a submenu, without them the old one-click entry
					const real = rally.isRealSystemID(systemID);
					const withComps = rally.comps.length > 0;
					$(this).contextmenu("showEntry", rally.MENU_COMMAND, real && withComps);
					$(this).contextmenu("showEntry", rally.TOGGLE_COMMAND, real && !withComps);
					if (real && withComps) { rally.renderSubmenu(systemID); }
					if (real && !withComps) { $("#fightToggleMenuItem").text(fightComps.flatEntry(rally.state, systemID).text); }
					$(this).contextmenu("showEntry", rally.DISCORD_COMMAND, rally.isRealSystemID(systemID) && rally.discordAvailable);
					rally.renderDiscordEntry();
				} catch (err) { console.error("fight here: menu update failed", err); }
				return originalBeforeOpen ? originalBeforeOpen.apply(this, arguments) : undefined;
			});
		} catch (e) { console.error("fight here: context menu setup failed", e); }

		// Shared state, and redraw when the tracked character moves (the route start changes)
		rally.fetch();
		setInterval(rally.fetch, rally.POLL_MS);
		setInterval(rally.renderBanner, rally.BANNER_TICK_MS);	// "x min ago"
		setInterval(function() {
			if (!rally.state.systemID || !rally.lastLocations) { return; }
			const now = rally.currentLocations();
			if (String(now.tracked) !== String(rally.lastLocations.tracked)) { rally.redraw(); }
		}, rally.LOCATION_CHECK_MS);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.menu) {
	$(function() { rally.init(); });
}
