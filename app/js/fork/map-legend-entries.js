const mapLegendEntries = [
	// Map key entries for what upstream Tripwire and the fork's existing features draw on the chain map (fork-owned).
	// map-legend.js registers them at DOM ready; new features call forkLegend.register() from their own file instead.
	// Fields: the top of map-legend.js. Samples run when the panel opens, so they may use any feature's globals; they
	// build their markup from the same classes (and, where a feature has one, the same markup function) as the map.
	// Keep `const mapLegendEntries` on the first line: the test helper only turns the first `const` into a global.

	// ---- Systems (upstream) ----
	{
		id: "systemClass", group: "systems", order: 10, title: "System class",
		text: "Wormhole class or security band. Blue C1-C3, purple C4-C5, pink C6, yellow Thera, red Drifter; green high-sec, orange low-sec, red null-sec, Pochven (Trig).",
		sample: function() {
			return forkLegend.chips([["<span class='wh class-1'>C1</span>"], ["<span class='class-4'>C4</span>"], ["<span class='class-6'>C6</span>"],
				["<span class='class-12'>C12</span>"], ["<span class='class-15'>C15</span>"], ["<span class='hisec'>HS</span>"],
				["<span class='lowsec'>LS</span>"], ["<span class='nullsec'>NS</span>"], ["<span class='triglavian'>Trig</span>"]]);
		}
	},
	{
		id: "statics", group: "systems", order: 20, title: "Statics",
		text: "The tabs under a system are its static holes and where they lead (H, L, N, 1-6, ▼ Pochven); + means more than four. Hover one for the hole type.",
		sample: function() { return forkLegend.node({ statics: "<span class='hisec'>H</span><span class='class-5'>5</span>" }); }
	},
	{
		id: "effect", group: "systems", order: 30, title: "System effect",
		text: "Wormhole effect icon (Magnetar, Pulsar, Wolf-Rayet, Black Hole, Cataclysmic Variable, Red Giant). Hover it for the name.",
		sample: function() { return forkLegend.node({ left: "<i class='whEffect' data-icon='magnetar'></i>" }); }
	},
	{
		id: "pilots", group: "systems", order: 40, title: "Pilots here",
		text: "Characters on your mask who are in this system, with how many. Hover for the names.",
		sample: function() { return forkLegend.node({ right: "<i data-icon='user'></i><span class='badge'>3</span>" }); }
	},
	{
		id: "activity", group: "systems", order: 50, title: "Activity dots",
		text: "Activity in the last hour: blue jumps, red pod kills, orange ship kills, green NPC kills. Hover a dot for the number.",
		sample: function() {
			return forkLegend.node({ label: "<span class='lowsec'>LS</span>", name: "Amamake", type: "N062",
				activity: "<span class='jumps'>&#9679;</span>&nbsp;<span class='pods'>&#9679;</span>&nbsp;&nbsp;<span class='ships'>&#9679;</span>&nbsp;<span class='npcs'>&#9679;</span>" });
		}
	},
	{
		id: "current", group: "systems", order: 60, title: "Viewing",
		text: "The system you are looking at in Tripwire.",
		sample: function() { return forkLegend.node({ wrap: "currentNode", label: "<span class='hisec'>HS</span>", name: "Jita", type: "&nbsp;" }); }
	},
	{
		id: "flares", group: "systems", order: 70, title: "Flares",
		text: "Red, yellow or green flare your mask put on a system (right-click a system, Flares). The (i) icon: the flare has a reason; hover it to read it and see how long it lasts.",
		sample: function() {
			return forkLegend.node({ cls: "redNode", type: "&nbsp;", name: "J1", left: "<i data-icon='info' class='fork-flare-mark'></i>" }) + forkLegend.node({ cls: "yellowNode", type: "&nbsp;", name: "J2" })
				+ forkLegend.node({ cls: "greenNode", type: "&nbsp;", name: "J3" });
		}
	},
	{
		id: "favourite", group: "systems", order: 80, title: "Favourite",
		text: "A star after the class marks one of your favourite systems.",
		sample: function() { return forkLegend.node({ label: "<span class='hisec'>HS<span class='favorite active' data-icon='star'></span></span>", name: "Dodixie", type: "E004" }); }
	},
	{
		id: "loop", group: "systems", order: 90, title: "Loop",
		text: "A round node: this system is already on the chain higher up (a loop back to it).",
		sample: function() { return forkLegend.node({ cls: "loop", name: "J105443" }); }
	},
	{
		id: "frigChain", group: "systems", order: 100, title: "Frigate-only reach",
		text: "Thin green border: the way to this system goes through a frigate-only hole.",
		sample: function() { return forkLegend.node({ cls: "frig-chain", label: "<span class='wh class-3'>C3</span>", name: "J120450", type: "Q003" }); }
	},
	{
		id: "gateRoute", group: "systems", order: 110, title: "Gate route",
		text: "Gate jumps from a k-space exit to the system you view (eye button) or to your favourites (star button). One square per jump, coloured by security.",
		sample: function() {
			return forkLegend.node({ cls: "calc", label: "<span class='hisec'>HS</span>", name: "Jita",
				type: "<span class='path'><span class='lowsec'>&#9632;</span><span class='hisec'>&#9632;</span><span class='hisec'>&#9632;</span><span class='hisec'>&#9632;</span></span>" });
		}
	},
	{
		id: "eveScout", group: "systems", order: 120, title: "EVE-Scout connection",
		text: "Faded italic node: a public Thera or Turnur connection from EVE-Scout, not mapped by your mask.",
		where: "Chain tab (pencil) > Include EVE-Scout's Thera chain",
		enabled: function(o) { return !!(o && o.chain && (o.chain.tabs || []).some(function(t) { return t && t.evescout; })); },
		sample: function() { return forkLegend.node({ cls: "third-party third-party-eve-scout", label: "<span class='class-12'>C12</span>", name: "Thera", type: "L005" }); }
	},
	{
		id: "destinations", group: "systems", order: 130, title: "Destinations",
		text: "A destination you added, at the end of its route line, with the number of jumps from the nearest exit.",
		settingId: "routeDestinationsEdit", where: "Shown when you add destinations (Settings > Routes & Navigation > Destinations)",
		enabled: function() { return true; },
		sample: function() {
			return forkLegend.line("destination-route") + "<span class='map-key-node'><div class='node destination-node' data-nodeid='0'>"
				+ "<h4 class='destClass'><span class='hisec'>HS</span></h4><h4 class='destName'><a>AMARR</a></h4><h4 class='destJumps'>7</h4></div></span>";
		}
	},
	{
		id: "favouriteRoutes", group: "systems", order: 140, title: "Favourite routes",
		text: "The route to a favourite you chose to show on the map (Favourites panel): dashed for the shortest route, solid light blue for a safe one.",
		settingId: "favouritesPanel-enabled",
		enabled: function(o) { return typeof favouritesPanel === "undefined" || favouritesPanel.enabled(o); },
		sample: function() {
			return forkLegend.line("favourite-route", "shortest") + forkLegend.line("favourite-safe-route", "safe")
				+ forkLegend.node({ cls: "calc favourite-route-node", label: "<span class='hisec'>HS</span>", name: "Jita", type: "<span class='path'><span class='hisec'>&#9632;</span><span class='hisec'>&#9632;</span></span>" });
		}
	},

	// ---- Connections ----
	{
		id: "mass", group: "connections", order: 10, title: "Mass",
		text: "Line colour: blue mass not reduced, orange reduced (destab), red critical.",
		sample: function() { return forkLegend.line("", "stable") + forkLegend.line("destab", "destab") + forkLegend.line("critical", "critical"); }
	},
	{
		id: "eol", group: "connections", order: 20, title: "End of life",
		text: "Dashed line: the hole is in its last 4 hours.",
		enabled: function(o) { return typeof lifeStates === "undefined" || !lifeStates.enabled(o); },
		where: "Replaced by Life states when they are on (Settings > Signatures > Wormhole life states)",
		sample: function() { return forkLegend.line("eol", "EOL"); }
	},
	{
		id: "lifeStates", group: "connections", order: 25, title: "Life states",
		text: "Line style shows how long the hole has left: dashed under 4 hours, dotted under 1 hour, sparse dots when it is expiring (EOL).",
		settingId: "lifeStates-enabled",
		sample: function() { return forkLegend.line("eol", "<4h") + forkLegend.line("eol life-map-lt1h", "<1h") + forkLegend.line("eol life-map-eol", "EOL"); }
	},
	{
		id: "frigHole", group: "connections", order: 30, title: "Frigate hole",
		text: "Thin green line: only frigates and destroyers fit through.",
		sample: function() { return forkLegend.line("frig jm-5kt", "frigate"); }
	},
	{
		id: "auras", group: "connections", order: 40, title: "Hole size",
		text: "Line width and glow show the largest ship that fits: frigate, medium, large, X-large (on the radial and side/top layouts).",
		where: "Glow: Settings > Chain Map > Show Line Aura",
		sample: function() { return forkLegend.line("jm-5kt", "S") + forkLegend.line("jm-62kt", "M") + forkLegend.line("jm-375kt", "L") + forkLegend.line("jm-2000kt", "XL"); }
	},

	// ---- Marks on connections ----
	{
		id: "sizeTags", group: "connectionMarks", order: 10, title: "Hole size tags",
		text: "Largest ship that fits: S frigate, M 62kt, L 410kt, VL freighter, XL capital; L? is a guess when the hole type is unknown.",
		settingId: "sizeTags-enabled",
		sample: function() {
			return forkLegend.chips([["<span class='size-tag size-s'>S</span>"], ["<span class='size-tag size-m'>M</span>"], ["<span class='size-tag size-l'>L</span>"],
				["<span class='size-tag size-vl'>VL</span>"], ["<span class='size-tag size-xl'>XL</span>"], ["<span class='size-tag size-l size-uncertain'>L?</span>"]]);
		}
	},
	{
		id: "preserveMass", group: "connectionMarks", order: 20, title: "Preserve mass",
		text: "Someone on your mask asked not to roll or waste mass on this hole (right-click the hole to set it).",
		settingId: "preserveMass-enabled",
		sample: function() { return forkLegend.onLine("", "<span class='preserve-mass-marker'>" + (typeof preserveMass !== "undefined" ? preserveMass.GLYPH : "") + "</span>"); }
	},
	{
		id: "rolling", group: "connectionMarks", order: 30, title: "Rolling",
		text: "Your mask is rolling this hole right now (right-click the hole to mark it).",
		settingId: "rolling-enabled",
		sample: function() { return forkLegend.onLine("destab", "<span class='hole-rolling-marker'>" + (typeof holeRolling !== "undefined" ? holeRolling.GLYPH : "") + "</span>"); }
	},
	{
		id: "watchlistHole", group: "connectionMarks", order: 40, title: "Watchlist hole",
		text: "Highlighted line: the hole that makes a watchlist match.",
		settingId: "watchlist", where: "Settings > Kills & Intel > Watchlist > Mark matches on the chain map",
		enabled: function(o) { return typeof watchlist === "undefined" || watchlist.settings(o).markers; },
		sample: function() { return forkLegend.line("watchlist-hole"); }
	},

	// ---- Marks on systems ----
	{
		id: "threat", group: "systemMarks", order: 10, title: "Threat badges",
		text: "Kills in the system lately (zKillboard), grey quiet to red extreme; a glow means a kill in the last hour. Hover for details.",
		settingId: "systemThreat-enabled",
		sample: function() {
			const b = function(level, count, hot) {
				return typeof systemThreat !== "undefined" ? systemThreat.badgeHtml({ level: level, count: count, hot: hot, levelName: "", basis: "" }, Date.now()) : "";
			};
			return forkLegend.node({ before: b(2, 9), name: "Amamake", label: "<span class='lowsec'>LS</span>", type: "N062" })
				+ forkLegend.chips([[b(0, 0)], [b(1, 2)], [b(2, 9)], [b(3, 30)], [b(4, 80)], [b(3, 30, true), "hot"]]);
		}
	},
	{
		id: "highsecRegion", group: "systemMarks", order: 20, title: "High-sec region",
		text: "On holes into high-sec, the region name takes the place of the hole type, so you can see where it comes out.",
		settingId: "highsecRegion-enabled",
		sample: function() {
			const t = typeof highsecRegion !== "undefined" ? highsecRegion.labelHtml({ type: "B274" }, "Sinq Laison") : "Sinq Laison";
			return forkLegend.node({ cls: "highsec-region-tall", label: "<span class='hisec'>HS</span>", name: "Dodixie", type: t });
		}
	},
	{
		id: "homeRegion", group: "systemMarks", order: 30, title: "Home region",
		text: "Region tag on home and on every chain system in the same wormhole region. Hover it to highlight the group.",
		settingId: "homeRegion",
		enabled: function(o) { return typeof homeRegion === "undefined" || homeRegion.enabled(o); },
		sample: function() {
			const tag = typeof homeRegion !== "undefined" ? homeRegion.markerHtml("R09", "C-R00009", homeRegion.color(forkLegend.opts()), true) : "";
			return forkLegend.node({ nameHtml: "J105443" + tag, label: "<span class='wh class-2'>C2</span>" });
		}
	},
	{
		id: "environmentA0", group: "systemMarks", order: 40, title: "A0 sun",
		text: "A0 (blue) sun in a k-space system, good for ratting and mining with the right ships.",
		settingId: "environmentTags-enabled",
		sample: function() {
			const tag = typeof environmentTags !== "undefined" ? environmentTags.tagHtml({ type: "a0", tip: "" }) : "";
			return forkLegend.node({ before: "<span class='env-tags'>" + tag + "</span>", label: "<span class='nullsec'>NS</span>", name: "1DQ1-A", type: "Z142" });
		}
	},
	{
		id: "environmentStorms", group: "systemMarks", order: 45, title: "Storms",
		text: "A metaliminal storm reported to EVE-Scout in the system: electric, exotic, gamma or plasma, each with its own colour.",
		settingId: "environmentTags-storms",
		enabled: function(o) { return typeof environmentTags === "undefined" || environmentTags.stormsEnabled(o); },
		sample: function() {
			if (typeof environmentTags === "undefined") { return ""; }
			const tags = Object.keys(environmentTags.STORMS).map(function(k) { return environmentTags.tagHtml({ type: "storm", kind: k, tip: "" }); });
			return forkLegend.node({ before: "<span class='env-tags'>" + tags[0] + "</span>", label: "<span class='lowsec'>LS</span>", name: "Amamake", type: "N062" })
				+ forkLegend.chips(tags.map(function(t, i) { return [t, environmentTags.STORMS[Object.keys(environmentTags.STORMS)[i]].name]; }));
		}
	},
	{
		id: "structures", group: "systemMarks", order: 50, title: "Structures & timers",
		text: "Known structures in the system (orange hostile, grey neutral) and a clock when a structure timer is coming up (yellow) or under an hour away (red).",
		settingId: "structures-mapMarker",
		sample: function() {
			if (typeof structureTimers === "undefined") { return ""; }
			return forkLegend.node({ before: structureTimers.markerHtml({ count: 2, hostile: true, title: "" }), name: "J105443" })
				+ forkLegend.node({ before: structureTimers.markerHtml({ count: 1, hostile: false, timer: { level: "urgent" }, title: "" }), name: "J100744" });
		}
	},
	{
		id: "stagingScan", group: "systemMarks", order: 60, title: "Staging (STG)",
		text: "Null-sec: a busy system near you that looks like someone's staging system.",
		settingId: "stagingScan-enabled",
		sample: function() { return forkLegend.node({ before: "<span class='staging-badge'>STG</span>", label: "<span class='nullsec'>NS</span>", name: "1DQ1-A", type: "Z142" }); }
	},
	{
		id: "targets", group: "systemMarks", order: 70, title: "Targets",
		text: "Numbered badge: one of your mask's targets set on the region map.",
		settingId: "mapTargets-enabled",
		sample: function() { return forkLegend.node({ before: "<span class='target-badge'>1</span>", label: "<span class='lowsec'>LS</span>", name: "Amamake", type: "N062" }); }
	},
	{
		id: "fightHere", group: "systemMarks", order: 80, title: "Fight here",
		text: "Pulsing system in the fleet comp's colour, with a thick line along the way there: where your fleet is forming up.",
		settingId: "fightHere", where: "Shown when someone sets a fight point (right-click a system > Fight here)",
		enabled: function() { return true; },
		sample: function() { return forkLegend.line("rally-route") + forkLegend.node({ cls: "rally-node", name: "J100744" }); }
	},
	{
		id: "killMarkers", group: "systemMarks", order: 90, title: "Kill markers",
		text: "Ring for 10 minutes after a reported kill: red our loss, green our kill, orange a large gank, grey a small one.",
		settingId: "killReporting-marker",
		sample: function() {
			return ["loss", "kill", "gank", "neutral"].map(function(c) {
				return forkLegend.node({ cls: "kill-reporting-mark kill-reporting-mark-" + c, type: "&nbsp;", name: c === "loss" ? "Loss" : c === "kill" ? "Kill" : c === "gank" ? "Gank" : "Small" });
			}).join("");
		}
	},
	{
		id: "watchlist", group: "systemMarks", order: 100, title: "Watchlist",
		text: "Eye badge and highlight: the system matches one of your corporation's watchlist filters (Watchlist panel).",
		settingId: "watchlist", where: "Settings > Kills & Intel > Watchlist > Mark matches on the chain map",
		enabled: function(o) { return typeof watchlist === "undefined" || watchlist.settings(o).markers; },
		sample: function() { return forkLegend.node({ cls: "watchlist-match", left: "<span class='watchlist-badge'><i data-icon='eye'></i></span>", name: "J105443" }); }
	},
	{
		id: "intelScans", group: "systemMarks", order: 110, title: "Fresh d-scan / local",
		text: "Dot: someone on your mask pasted a d-scan (cyan), local (green) or both here recently. Hover it for how long ago.",
		settingId: "intelScans",
		enabled: function(o) { return typeof intelScans === "undefined" || intelScans.enabled(o); },
		sample: function() {
			if (typeof intelScans === "undefined") { return ""; }
			const m = function(text) { return intelScans.markerHtml({ text: text, title: "" }); };
			return forkLegend.node({ before: m("DL"), name: "J105443" }) + forkLegend.chips([[m("D"), "d-scan"], [m("L"), "local"], [m("DL"), "both"]]);
		}
	},
	{
		id: "jumpRing", group: "systemMarks", order: 120, title: "Jump range ring",
		text: "Ring icon on low-sec and null-sec systems: click it to see jump drive range from there in the Jump planner.",
		settingId: "jumpPlanner-enabled-general", where: "Settings > Routes & Navigation > Jump planner",
		enabled: function(o) { return typeof jumpPlanner === "undefined" || jumpPlanner.enabled(o); },
		sample: function() {
			return forkLegend.node({ before: typeof jumpPlanner !== "undefined" ? jumpPlanner.ringHtml(0, "") : "", label: "<span class='lowsec'>LS</span>", name: "Amamake", type: "N062" });
		}
	},
	{
		id: "skyhooks", group: "systemMarks", order: 130, title: "Skyhook icon",
		text: "On low-sec and null-sec systems: click it to see raidable skyhooks on the region map.",
		settingId: "skyhooksPanel-enabled",
		sample: function() {
			return forkLegend.node({ before: typeof skyhooksPanel !== "undefined" ? skyhooksPanel.iconHtml(0, "") : "", label: "<span class='nullsec'>NS</span>", name: "1DQ1-A", type: "Z142" });
		}
	}
];
