const rally = {
	// Rally point: one system per mask that everyone on the chain map sees highlighted, plus the
	// wormhole route to it from the viewer's location (fork-owned file; server side is public/rally.php).
	// Keep `const rally` on the first line: the test helper strips it to define a global.
	URL: "rally.php",
	POLL_MS: 10000,
	LOCATION_CHECK_MS: 2000,
	ROUTE_CLASS: "rally-route",
	NODE_CLASS: "rally-node",
	MENU_COMMAND: "rallyToggle",

	// Current rally for this mask: { systemID, setBy, setAt } or systemID null
	state: { systemID: null, setBy: null, setAt: null },
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
	routes) are left out: the rally route only follows wormholes. */
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

	/** Add the rally class to a node's markup (makeSystemNode output) */
	markNode: function(markup) {
		if (typeof markup !== "string" || markup.indexOf(" " + rally.NODE_CLASS + " ") >= 0) { return markup; }
		return markup.replace("class='node ", "class='node " + rally.NODE_CLASS + " ");
	},

	/** Decorate the output of chain.nodes() in place for the current rally: mark rally nodes and add the
	route class to the lines on the route. Returns
	{ rallySystemID, onMap, startSystemID, jumps, lineIndexes } (jumps null if unreachable / not on map)
	@param result chain.nodes() output: { map: { rows }, lines }
	@param rallySystemID current rally system or null
	@param locations { tracked, viewing } system IDs */
	decorate: function(result, rallySystemID, locations) {
		const rows = (result && result.map && result.map.rows) || [];
		const lines = (result && result.lines) || [];
		locations = locations || {};

		// Lines are rebuilt on each draw, but strip any stale class anyway
		lines.forEach(function(line) {
			if (line && Array.isArray(line[2])) {
				const i = line[2].indexOf(rally.ROUTE_CLASS);
				if (i >= 0) { line[2].splice(i, 1); }
			}
		});

		const info = { rallySystemID: rallySystemID, onMap: false, startSystemID: null, jumps: null, lineIndexes: [] };
		if (!rally.isRealSystemID(rallySystemID)) { return info; }
		const target = String(rallySystemID);

		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (node && String(node.systemID) === target) {
				node.f = rally.markNode(node.f);
				info.onMap = true;
			}
		});
		if (!info.onMap) { return info; }

		const onMap = rally.systemsOnMap(rows);
		info.startSystemID = rally.pickStart(onMap, locations.tracked, locations.viewing, rally.rootSystem(rows));
		const route = rally.routeTo(rally.systemConnections(rows, lines), info.startSystemID, target);
		if (route) {
			info.jumps = route.length;
			info.lineIndexes = route;
			route.forEach(function(index) {
				const line = lines[index];
				if (line && Array.isArray(line[2]) && line[2].indexOf(rally.ROUTE_CLASS) < 0) { line[2].push(rally.ROUTE_CLASS); }
			});
		}
		return info;
	},

	/** Text after the system name in the banner */
	routeText: function(info) {
		if (!info || !info.onMap) { return "not on this map"; }
		if (info.jumps === null || info.jumps === undefined) { return "no route"; }
		if (info.jumps === 0) { return "you are here"; }
		return info.jumps + (info.jumps == 1 ? " jump" : " jumps");
	},

	// ---- Discord (server side: public/rally.php; the channel is the "Rally point" type corp admins set up in
	// Mask Admin > Discord, discord/rally.php, or else upstream's server-wide DISCORD_WEB_HOOK) ----
	DISCORD_COMMAND: "rallyDiscord",
	DISCORD_HELP: "Rally changes go to the Discord channel your corporation's admins chose in Mask Admin > Discord.",
	// Whether rally changes of this mask go to Discord at all (from rally.php's "discord")
	discordAvailable: false,

	/** "Also post to Discord" choice: options.rallyDiscord.enabled, a missing key means on */
	discordEnabled: function(opts) {
		return !(opts && opts.rallyDiscord && opts.rallyDiscord.enabled === false);
	},

	/** POST body for a rally change: adds discord=1 when the mask has a webhook and the user wants it */
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
		if (!rally.isRealSystemID(rally.state.systemID)) {
			banner.addClass("hidden");
			return;
		}
		const name = rally.systemName(rally.state.systemID);
		const info = rally.lastRoute && String(rally.lastRoute.rallySystemID) === String(rally.state.systemID) ? rally.lastRoute : null;
		banner.find(".rally-name").attr("href", ".?system=" + name).text(name);
		banner.find(".rally-jumps").text("(" + rally.routeText(info) + ")");
		banner.attr("title", "Rally point" + (rally.state.setBy ? " set by " + rally.state.setBy : "") + (rally.state.setAt ? " at " + rally.state.setAt : ""));
		banner.removeClass("hidden");
	},

	/** Apply rally data from the server; redraw if it changed */
	apply: function(data, fromOthers) {
		const systemID = data && rally.isRealSystemID(data.systemID) ? Number(data.systemID) : null;
		const changed = systemID !== rally.state.systemID;
		rally.state = { systemID: systemID, setBy: data ? data.setBy : null, setAt: data ? data.setAt : null };
		if (changed) {
			if (fromOthers && systemID && typeof Notify !== "undefined") {
				Notify.trigger("Rally point: " + rally.escape(rally.systemName(systemID)) + (rally.state.setBy ? " (set by " + rally.escape(rally.state.setBy) + ")" : ""), "green");
			}
			rally.redraw();
		} else {
			rally.renderBanner();
		}
	},

	fetch: function() {
		return $.ajax({ url: rally.URL, type: "GET", dataType: "JSON", cache: false })
			.done(function(data) { if (data) { rally.discordAvailable = !!data.discord; rally.apply(data.rally, true); } });
	},

	post: function(payload) {
		return $.ajax({
			url: rally.URL, type: "POST", dataType: "JSON",
			data: rally.changePayload(payload, rally.discordAvailable, typeof options !== "undefined" ? options : null),
			headers: { "X-Requested-With": "XMLHttpRequest" }
		}).done(function(data) {
			if (data) { rally.discordAvailable = !!data.discord; rally.apply(data.rally, false); }
		}).fail(function() {
			if (typeof Notify !== "undefined") { Notify.trigger("Couldn't update the rally point", "red"); }
			rally.fetch();
		});
	},

	set: function(systemID) {
		if (!rally.isRealSystemID(systemID)) { return; }
		rally.apply({ systemID: Number(systemID), setBy: tripwire.client && tripwire.client.EVE ? tripwire.client.EVE.characterName : null, setAt: null }, false);	// optimistic
		return rally.post({ mode: "set", systemID: Number(systemID) });
	},

	clear: function() {
		rally.apply(null, false);
		return rally.post({ mode: "clear" });
	},

	toggle: function(systemID) {
		return String(rally.state.systemID) === String(systemID) ? rally.clear() : rally.set(systemID);
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

	setupSettings: function() {
		if (typeof options === "undefined") { return; }
		// Settings > Map Markers row; takes effect on Save like its neighbours (Reset = on)
		forkSettings.register({
			section: "markers", order: 50, id: "rallyDiscord-enabled", type: "custom", key: "rallyDiscord", label: "Rally point:",
			keywords: "discord fight",
			html: "<label title='" + rally.escape(rally.DISCORD_HELP) + "'><input type='checkbox' id='rallyDiscord-enabled' /> Post my rally changes to Discord</label>"
				+ "<div class='rally-discord-note'>Corp admins choose the channel in Mask Admin &gt; Discord.</div>",
			load: function(o) { $("#rallyDiscord-enabled").prop("checked", rally.discordEnabled(o)); },
			save: function(o) { o.rallyDiscord = { enabled: $("#rallyDiscord-enabled").prop("checked") }; }
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
				rally.lastRoute = rally.decorate(result, rally.state.systemID, rally.lastLocations);
			} catch (e) { console.error("rally: decorate failed", e); }
			setTimeout(rally.renderBanner, 0);
			return result;
		};

		// Banner in the chain map header
		const banner = $("<span id='rally-banner' class='hidden'><span>|</span> <i class='rally-icon'>&#9873;</i> Rally: <a class='rally-name' href='#'></a> <span class='rally-jumps'></span> <i class='rally-clear' title='Clear rally point'>&#10005;</i></span>");
		const anchor = $("#chainWidget .controls #higgs-jump");
		if (anchor.length) { banner.insertAfter(anchor); } else { $("#chainWidget .controls").append(banner); }
		banner.on("click", ".rally-clear", function(e) { e.preventDefault(); rally.clear(); });

		// Context menu entry
		try {
			const chainParent = $("#chainParent");
			$("#chainMenu").append("<li data-command='" + rally.MENU_COMMAND + "'><a id='rallyMenuItem'>Rally here</a></li>");
			$("#chainMenu").append("<li data-command='" + rally.DISCORD_COMMAND + "' class='rally-discord-entry'><a id='rallyDiscordMenuItem' title='" + rally.escape("Post your rally changes too. " + rally.DISCORD_HELP) + "'><span class='rally-discord-check'></span> Also post to Discord</a></li>");
			$("#chainMenu").menu("refresh");

			const originalSelect = chainParent.contextmenu("option", "select");
			chainParent.contextmenu("option", "select", function(e, ui) {
				if (ui.cmd === rally.MENU_COMMAND) {
					rally.toggle($(ui.target[0]).closest("[data-nodeid]").data("nodeid"));
					return;
				}
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
					$(this).contextmenu("showEntry", rally.MENU_COMMAND, rally.isRealSystemID(systemID));
					$("#rallyMenuItem").text(String(rally.state.systemID) === String(systemID) ? "Clear rally" : "Rally here");
					$(this).contextmenu("showEntry", rally.DISCORD_COMMAND, rally.isRealSystemID(systemID) && rally.discordAvailable);
					rally.renderDiscordEntry();
				} catch (err) { console.error("rally: menu update failed", err); }
				return originalBeforeOpen ? originalBeforeOpen.apply(this, arguments) : undefined;
			});
		} catch (e) { console.error("rally: context menu setup failed", e); }

		// Shared state, and redraw when the tracked character moves (the route start changes)
		rally.fetch();
		setInterval(rally.fetch, rally.POLL_MS);
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
