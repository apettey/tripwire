// Fork-owned: the region map panel (Dotlan-style schematic of one k-space region), see region-map.js for the logic and
// the layout data. Opened from the chain map's right-click menu, the system panel and the command palette (Ctrl+K).
// The bundle concatenates fork files alphabetically: region-map.js defines `regionMap`; everything here runs at DOM ready.
if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined") {
	(function() {
		let rm = null;		// regionMap (region-map.js sorts after this file in the bundle, so it is looked up at DOM ready)
		const NS = "http://www.w3.org/2000/svg";
		const DIALOG_ID = "dialog-regionMap";
		const POLL_MS = 3000;
		const HOUR_MS = 3600 * 1000;

		const state = {
			layout: null, regionID: null, sel: null, t: { k: 1, x: 0, y: 0 }, view: { w: 800, h: 500 },
			cache: {}, loading: null, signature: "", timer: null,
			activity: null, activityAt: 0, activityBusy: false, activityFailedAt: 0, nodes: {}, layers: {}
		};

		// ---- Live data (read from Tripwire's own globals; nothing here calls a third party) ----

		function systems() { return (typeof tripwire !== "undefined" && tripwire.systems) || appData.systems; }
		function regions() { return (typeof appData !== "undefined" && appData.regions) || {}; }
		function sysName(id) { const s = appData.systems[id]; return s && s.name ? s.name : String(id); }
		function regionName(id) { const r = regions()[id]; return r && r.name ? r.name : String(id); }
		function gateMap() { return (tripwire.map && tripwire.map.shortest) || appData.map.shortest; }
		function enabled() { return rm.settings(options).enabled; }
		function myLocation() { return tripwire.client && tripwire.client.EVE ? Number(tripwire.client.EVE.systemID) || null : null; }
		function notify(html, color, ms) {
			if (typeof Notify !== "undefined") { Notify.trigger(html, color, ms); } else { console.log(html); }
		}
		function findPath(map, a, b) { return guidance.findShortestPath(map, a, b); }
		function chainExits() { return (chain.data && chain.data.exits) || []; }
		function activityNow() {
			const a = chain.data && chain.data.activity;
			return a && Object.keys(a).length > 1 ? a : state.activity;
		}

		/** Activity of the universe (jumps, kills in the last hour): the chain map's copy if it has one, else the same two
		public ESI calls the chain map makes, at most once an hour (ESI's own cache time) */
		function ensureActivity() {
			if (activityNow() && (!state.activity || Date.now() - state.activityAt < HOUR_MS)) { return; }
			if (state.activityBusy || Date.now() - state.activityFailedAt < 60000 || !tripwire.esi || !tripwire.esi.universeJumps) { return; }
			state.activityBusy = true;
			const data = {};
			tripwire.esi.universeJumps().then(function(jumps) {
				$.each(jumps, function(i, j) { data[j.system_id] = { shipJumps: j.ship_jumps }; });
				return tripwire.esi.universeKills();
			}).then(function(kills) {
				$.each(kills, function(i, k) {
					data[k.system_id] = Object.assign(data[k.system_id] || {}, { podKills: k.pod_kills, shipKills: k.ship_kills, npcKills: k.npc_kills });
				});
				state.activity = data;
				state.activityAt = Date.now();
				paint(true);
			}).always(function() { state.activityBusy = false; }).fail(function() { state.activityFailedAt = Date.now(); });
		}

		function fightSystem() {
			return typeof rally !== "undefined" && rally.state && rally.state.systemID ? Number(rally.state.systemID) : null;
		}

		// ---- Persisting the header choices ----

		function saveSetting(change) {
			try {
				options.regionMap = rm.withSetting(options, change);
				options.save();
			} catch (e) { console.error("Region map: could not save the setting", e); }
		}

		// ---- SVG helpers ----

		function el(name, attrs, parent, text) {
			const node = document.createElementNS(NS, name);
			if (attrs) { Object.keys(attrs).forEach(function(k) { node.setAttribute(k, attrs[k]); }); }
			if (text !== undefined) { node.textContent = text; }
			if (parent) { parent.appendChild(node); }
			return node;
		}
		function $svg() { return $("#" + DIALOG_ID + " .rm-svg"); }
		function applyTransform() {
			const t = state.t;
			if (state.layers.world) { state.layers.world.setAttribute("transform", "translate(" + t.x.toFixed(1) + " " + t.y.toFixed(1) + ") scale(" + t.k.toFixed(4) + ")"); }
		}
		function measure() {
			const svg = $svg()[0];
			if (svg && svg.clientWidth) { state.view = { w: svg.clientWidth, h: svg.clientHeight }; }
		}

		// ---- Drawing a region ----

		function render() {
			const layout = state.layout, svg = $svg()[0];
			if (!layout || !svg) { return; }
			while (svg.firstChild) { svg.removeChild(svg.firstChild); }
			const world = el("g", { "class": "rm-world" }, svg);
			const layers = { world: world };
			["hulls", "labels", "edges", "route", "stubs", "heat", "systems", "tags"].forEach(function(name) {
				layers[name] = el("g", { "class": "rm-layer rm-layer-" + name }, world);
			});
			state.layers = layers;
			state.nodes = {};

			layout.constellations.forEach(function(c) {
				if (c.points.length < 3) { return; }
				const hue = (c.index * 47) % 360;
				el("polygon", {
					"class": "rm-hull", points: c.points.map(function(p) { return p[0].toFixed(0) + "," + p[1].toFixed(0); }).join(" "),
					fill: "hsla(" + hue + ",35%,45%,0.10)", stroke: "hsla(" + hue + ",35%,55%,0.16)", "stroke-width": 34, "stroke-linejoin": "round"
				}, layers.hulls);
				el("text", { "class": "rm-clabel", x: c.cx.toFixed(0), y: c.cy.toFixed(0), "text-anchor": "middle" }, layers.labels, c.name);
			});
			layout.edges.forEach(function(e) {
				el("line", { "class": "rm-edge", x1: e.x1.toFixed(1), y1: e.y1.toFixed(1), x2: e.x2.toFixed(1), y2: e.y2.toFixed(1) }, layers.edges);
			});
			layout.stubs.forEach(function(s) {
				const g = el("g", { "class": "rm-stub", "data-region": s.toRegionID, "data-system": s.toSystemID }, layers.stubs);
				el("line", { x1: s.x1.toFixed(1), y1: s.y1.toFixed(1), x2: s.x2.toFixed(1), y2: s.y2.toFixed(1) }, g);
				const anchor = s.ux > 0.35 ? "start" : s.ux < -0.35 ? "end" : "middle";
				const tx = s.x2 + s.ux * 5, ty = s.y2 + s.uy * 5 + (Math.abs(s.uy) > 0.6 ? (s.uy > 0 ? 9 : -4) : 4);
				const label = el("text", { x: tx.toFixed(1), y: ty.toFixed(1), "text-anchor": anchor }, g);
				el("tspan", { "class": "rm-stub-region" }, label).textContent = regionName(s.toRegionID);
				el("title", null, g).textContent = "Open " + regionName(s.toRegionID) + " (" + s.toName + ")";
			});
			layout.systems.forEach(function(s) {
				const g = el("g", { "class": "rm-sys", "data-id": s.id, transform: "translate(" + s.x.toFixed(1) + " " + s.y.toFixed(1) + ")" }, layers.systems);
				el("rect", { x: -rm.BOX_W / 2, y: -rm.BOX_H / 2, width: rm.BOX_W, height: rm.BOX_H, rx: 6, fill: rm.secColour(secOf(s)) }, g);
				el("text", { y: 4 }, g, s.name);
				state.nodes[s.id] = { g: g, title: el("title", null, g) };
			});
			state.signature = "";
			applyTransform();
			paint(true);
		}

		function secOf(s) {
			const known = appData.systems[s.id];
			return known && known.security !== undefined ? known.security : s.sec;
		}

		// ---- Overlays ----

		function context() {
			const cfg = rm.settings(options), layout = state.layout;
			const ids = layout.systems.map(function(s) { return s.id; });
			const ctx = {
				cfg: cfg, exits: [], pilots: {}, fight: null, heat: { levels: {}, values: {}, max: 0 }, route: null, routeFrom: "", me: myLocation()
			};
			if (cfg.overlays.exits) { ctx.exits = rm.exitsIn(layout, chainExits(), chain.data && chain.data.systemsInChainMap); }
			if (cfg.overlays.pilots) { ctx.pilots = rm.pilots(chain.data && chain.data.occupied, ctx.me); }
			if (cfg.overlays.fight) { const f = fightSystem(); ctx.fight = f && layout.byId[f] ? f : null; }
			if (cfg.heat !== "none") { ctx.heat = rm.heatMap(cfg.heat, ids, activityNow()); }
			if (cfg.overlays.route && state.sel) { ctx.route = routeTo(state.sel); }
			return ctx;
		}

		/** The route to the selected system, drawn on the map: from where you are (k-space), else from the nearest chain exit */
		function routeTo(target) {
			try {
				const me = myLocation(), map = gateMap();
				if (me && rm.isKSpace(appData.systems[me])) {
					const r = rm.route(findPath, map, me, target);
					if (r) { return { path: r.path, jumps: r.jumps, from: "you" }; }
				}
				const exits = chainExits().map(Number).filter(function(id) { return rm.isKSpace(appData.systems[id]); });
				const r = rm.routeFromAny(findPath, map, exits, target);
				if (r) { return { path: r.path, jumps: r.jumps, from: "exit", exit: r.exit }; }
			} catch (e) { console.error("Region map: route failed", e); }
			return null;
		}

		function paint(force) {
			const layout = state.layout;
			if (!layout || !state.layers.tags) { return; }
			if (rm.settings(options).heat !== "none" || state.sel) { ensureActivity(); }
			const ctx = context();
			const sig = JSON.stringify([ctx.cfg, ctx.exits, ctx.pilots, ctx.fight, ctx.heat.values, ctx.route && ctx.route.path, state.sel]);
			if (!force && sig === state.signature) { return; }
			state.signature = sig;
			const L = state.layers;
			["heat", "tags", "route"].forEach(function(name) { while (L[name].firstChild) { L[name].removeChild(L[name].firstChild); } });
			$(L.hulls).toggle(ctx.cfg.overlays.constellations);
			$(L.labels).toggle(ctx.cfg.overlays.constellations);

			// Heat: a glow behind the box, bigger and stronger with the value
			const heatColour = (rm.HEAT[ctx.cfg.heat] || {}).colour;
			Object.keys(ctx.heat.levels).forEach(function(id) {
				const s = layout.byId[id], lv = ctx.heat.levels[id];
				if (!s) { return; }
				const pad = 3 + 11 * lv;
				el("rect", { x: (s.x - rm.BOX_W / 2 - pad).toFixed(1), y: (s.y - rm.BOX_H / 2 - pad).toFixed(1), width: (rm.BOX_W + 2 * pad).toFixed(1), height: (rm.BOX_H + 2 * pad).toFixed(1), rx: 9 + pad / 2, fill: heatColour, "fill-opacity": (0.25 + 0.55 * lv).toFixed(2) }, L.heat);
			});

			// Route: highlighted gates, then an outline round every system on it inside this region
			if (ctx.route) {
				const inside = rm.routeInside(layout, ctx.route.path);
				inside.edges.forEach(function(pair) {
					const a = layout.byId[pair[0]], b = layout.byId[pair[1]];
					el("line", { "class": "rm-route", x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1) }, L.route);
				});
				Object.keys(inside.ids).forEach(function(id) {
					const s = layout.byId[id];
					outline(L.tags, s, "rm-route-node", 3);
				});
				// the route leaves this region: highlight the stub it takes
				const path = ctx.route.path;
				for (let i = 0; i < path.length - 1; i++) {
					if (layout.byId[path[i]] && !layout.byId[path[i + 1]]) {
						layout.stubs.filter(function(st) { return st.from === path[i] && st.toSystemID === path[i + 1]; }).forEach(function(st) {
							el("line", { "class": "rm-route", x1: st.x1.toFixed(1), y1: st.y1.toFixed(1), x2: st.x2.toFixed(1), y2: st.y2.toFixed(1) }, L.route);
						});
					}
				}
			}

			// Fight here, chain exits, pilots
			if (ctx.fight) {
				const s = layout.byId[ctx.fight];
				outline(L.tags, s, "rm-fight", 4);
				el("text", { "class": "rm-flag", x: (s.x - rm.BOX_W / 2 + 2).toFixed(1), y: (s.y - rm.BOX_H / 2 - 4).toFixed(1) }, L.tags, "⚑ Fight here");
			}
			ctx.exits.forEach(function(x) {
				const s = layout.byId[x.systemID];
				outline(L.tags, s, "rm-exit", 3);
				const pill = x.hole || "exit", w = Math.max(24, pill.length * 8 + 12);
				const g = el("g", { "class": "rm-pill", transform: "translate(" + (s.x + rm.BOX_W / 2 - w).toFixed(1) + " " + (s.y - rm.BOX_H / 2 - 17).toFixed(1) + ")" }, L.tags);
				el("rect", { width: w, height: 15, rx: 7 }, g);
				el("text", { x: w / 2, y: 11, "text-anchor": "middle" }, g, pill);
				el("title", null, g).textContent = x.hole ? "Chain exit " + x.hole + " (" + s.name + ")" : "Chain exit (" + s.name + ")";
			});
			Object.keys(ctx.pilots).forEach(function(id) {
				const s = layout.byId[id], p = ctx.pilots[id];
				if (!s) { return; }
				if (p.you) {
					outline(L.tags, s, "rm-you", 3);
					const g = el("g", { "class": "rm-pill rm-pill-you", transform: "translate(" + (s.x - rm.BOX_W / 2).toFixed(1) + " " + (s.y + rm.BOX_H / 2 + 2).toFixed(1) + ")" }, L.tags);
					el("rect", { width: 34, height: 15, rx: 7 }, g);
					el("text", { x: 17, y: 11, "text-anchor": "middle" }, g, "you");
				}
				const others = p.count - (p.you ? 1 : 0);
				if (others > 0) {
					const g = el("g", { "class": "rm-badge", transform: "translate(" + (s.x + rm.BOX_W / 2 - 2).toFixed(1) + " " + (s.y + rm.BOX_H / 2 - 1).toFixed(1) + ")" }, L.tags);
					el("circle", { r: 9 }, g);
					el("text", { y: 4, "text-anchor": "middle" }, g, String(others));
					el("title", null, g).textContent = others + " tracked pilot" + (others === 1 ? "" : "s") + " in " + s.name;
				}
			});
			if (state.sel && layout.byId[state.sel]) { outline(L.tags, layout.byId[state.sel], "rm-selected", 2.5); }

			// Tooltips and the selected card
			layout.systems.forEach(function(s) {
				const parts = [s.name + " (" + rm.secText(secOf(s)) + ")"];
				const a = activityNow() && activityNow()[s.id];
				if (a && (a.npcKills || a.shipKills || a.shipJumps)) {
					parts.push("last hour: " + (a.npcKills || 0) + " NPC kills, " + (a.shipKills || 0) + " ship kills, " + (a.shipJumps || 0) + " jumps");
				}
				state.nodes[s.id].title.textContent = parts.join("\n");
			});
			renderCard(ctx);
		}

		function outline(parent, s, cls, width) {
			return el("rect", {
				"class": "rm-outline " + cls, x: (s.x - rm.BOX_W / 2 - 3).toFixed(1), y: (s.y - rm.BOX_H / 2 - 3).toFixed(1),
				width: rm.BOX_W + 6, height: rm.BOX_H + 6, rx: 8, "stroke-width": width
			}, parent);
		}

		// ---- The card of the selected system ----

		function card() { return $("#" + DIALOG_ID + " .rm-card"); }

		function renderCard(ctx) {
			const $card = card();
			if (!state.sel || !appData.systems[state.sel]) { $card.addClass("hidden").empty(); return; }
			const id = state.sel, sys = appData.systems[id], e = rm.escape;
			const a = (activityNow() || {})[id] || {};
			const constellation = state.layout.constellations.filter(function(c) { return c.ids.indexOf(id) >= 0; })[0];
			const lines = [];
			lines.push("<div class='rm-card-sub'>" + e(constellation ? constellation.name + " · " : "") + e(state.layout.name) + "</div>");
			const hasActivity = activityNow();
			lines.push("<div class='rm-card-row'>" + (hasActivity
				? "Last hour: " + (a.npcKills || 0) + " NPC kills · " + (a.shipKills || 0) + " ship kills · " + (a.shipJumps || 0) + " jumps"
				: "Last hour: loading…") + "</div>");
			const exitRoute = ctx.route && ctx.route.from === "exit" ? ctx.route : routeFromExit(id);
			if (exitRoute) {
				const hole = rm.exitHole(exitRoute.exit, chain.data.systemsInChainMap);
				lines.push("<div class='rm-card-row'>" + (exitRoute.jumps === 0 ? "This is a chain exit" : exitRoute.jumps + " jump" + (exitRoute.jumps === 1 ? "" : "s") + " from the nearest chain exit")
					+ " (" + e((hole ? hole + ", " : "") + sysName(exitRoute.exit)) + ")</div>");
			} else if (chainExits().length) {
				lines.push("<div class='rm-card-row rm-muted'>No gate route from the chain's exits</div>");
			}
			if (ctx.route && ctx.route.from === "you" && ctx.route.jumps > 0) {
				lines.push("<div class='rm-card-row'>" + ctx.route.jumps + " jump" + (ctx.route.jumps === 1 ? "" : "s") + " from you</div>");
			}
			$card.removeClass("hidden").html(
				"<div class='rm-card-head'><b>" + e(sys.name) + "</b> <span class='rm-sec' style='color:" + rm.secColour(sys.security) + "'>" + rm.secText(sys.security) + "</span>"
				+ "<i class='rm-card-close' title='Close'>&times;</i></div>" + lines.join("")
				+ "<div class='rm-card-buttons'><button class='rm-dest' title='Set as the in-game destination (clears other waypoints)'>Set destination</button> "
				+ "<button class='rm-route-btn' title='Send the gate route to the in-game autopilot'>Set route in game</button> "
				+ "<button class='rm-view' title='Open this system in Tripwire'>View in Tripwire</button></div>"
			);
		}

		function routeFromExit(target) {
			const exits = chainExits().map(Number).filter(function(id) { return rm.isKSpace(appData.systems[id]); });
			try { return rm.routeFromAny(findPath, gateMap(), exits, target); } catch (e) { return null; }
		}

		// ---- Actions on the selected system ----

		function characterID() {
			const id = options.tracking && options.tracking.active;
			return tripwire.esi && tripwire.esi.characters && tripwire.esi.characters[id] && tripwire.esi.characters[id].accessToken ? id : null;
		}

		function setDestination(id) {
			const c = characterID();
			if (!c) { notify("Select a tracked character (logged in with EVE SSO) first.", "red", 6000); return; }
			tripwire.esi.setDestination(id, c, true).done(function() {
				notify("Destination set in game: " + rm.escape(sysName(id)), "green", 5000);
			}).fail(function(xhr) {
				notify("Could not set the destination in game (ESI error " + (xhr && xhr.status || "?") + ").", "red", 8000);
			});
		}

		function setRoute(id) {
			if (typeof autopilotRoute === "undefined" || !autopilotRoute.push) { setDestination(id); return; }
			const route = routeTo(id);
			if (!route || route.jumps < 1) { notify(route ? "You are already there." : "No gate route to " + rm.escape(sysName(id)) + ".", "yellow", 5000); return; }
			autopilotRoute.push(route.path, "Region map: " + sysName(route.path[0]) + " → " + sysName(id));
		}

		function viewSystem(id) { window.location.href = ".?system=" + encodeURIComponent(sysName(id)); }

		// ---- Choosing, panning and zooming ----

		function select(id) {
			state.sel = id ? Number(id) : null;
			$("#" + DIALOG_ID + " .rm-sys").removeClass("rm-sel");
			if (state.sel && state.nodes[state.sel]) { $(state.nodes[state.sel].g).addClass("rm-sel"); }
			paint(true);
		}

		function fitView() {
			measure();
			state.t = rm.fit(state.layout, state.view.w, state.view.h);
			applyTransform();
		}

		function centreOnSystem(id, zoom) {
			const s = state.layout.byId[id];
			if (!s) { fitView(); return; }
			measure();
			state.t = rm.centreOn(s.x, s.y, zoom || 1, state.view.w, state.view.h);
			applyTransform();
		}

		function fillRegionSelect() {
			const $sel = $("#" + DIALOG_ID + " .rm-region");
			if ($sel.children().length) { return; }
			const list = Object.keys(regions()).filter(function(id) { return Number(id) < 11000000; }).sort(function(a, b) {
				return regionName(a) < regionName(b) ? -1 : 1;
			});
			$sel.html(list.map(function(id) { return "<option value='" + id + "'>" + rm.escape(regionName(id)) + "</option>"; }).join(""));
		}

		function syncHeader() {
			const cfg = rm.settings(options), $d = $("#" + DIALOG_ID);
			$d.find(".rm-region").val(String(state.regionID));
			rm.OVERLAYS.forEach(function(name) { $d.find("input[data-ov='" + name + "']").prop("checked", cfg.overlays[name]); });
			$d.find(".rm-heat").val(cfg.heat);
			$d.dialog("option", "title", "Region map – " + (state.layout ? state.layout.name : ""));
		}

		function loadRegion(regionID) {
			if (state.cache[regionID]) { return $.Deferred().resolve(state.cache[regionID]).promise(); }
			return $.ajax({ url: "region-map/" + regionID + ".json", dataType: "json", cache: true }).then(function(raw) {
				const layout = rm.normaliseRegion(raw);
				if (!layout) { return $.Deferred().reject().promise(); }
				state.cache[regionID] = layout;
				return layout;
			});
		}

		/** Show a region; centre on a system (and select it) when given, else fit the whole region */
		function show(regionID, systemID) {
			ensureDialog();
			const $d = $("#" + DIALOG_ID);
			if (!$d.dialog("isOpen")) { $d.dialog("open"); }
			const token = state.loading = {};
			return loadRegion(regionID).done(function(layout) {
				if (state.loading !== token) { return; }
				state.layout = layout;
				state.regionID = regionID;
				state.sel = systemID && layout.byId[systemID] ? Number(systemID) : null;
				fillRegionSelect();
				syncHeader();
				render();
				if (state.sel) { select(state.sel); }
				measure();
				if (systemID && layout.byId[systemID]) { centreOnSystem(systemID, Math.max(1, rm.fit(layout, state.view.w, state.view.h).k)); } else { fitView(); }
			}).fail(function() {
				notify("Region map: could not load the map of " + rm.escape(regionName(regionID)) + ".", "red", 6000);
			});
		}

		/** Entry point: target is {kind: "system" | "region", id} */
		function open(target) {
			const where = rm.targetRegion(target, appData.systems);
			if (!where) { notify("Region map: that is not a k-space system or region.", "yellow", 5000); return null; }
			return show(where.regionID, where.systemID);
		}



		// ---- The panel ----

		function ensureDialog() {
			const $d = $("#" + DIALOG_ID);
			if ($d.hasClass("ui-dialog-content")) { return $d; }
			$d.dialog({
				autoOpen: false, title: "Region map", modal: false, resizable: true, width: 1000, height: 680, minWidth: 560, minHeight: 360,
				dialogClass: "dialog-noeffect ui-dialog-shadow dialog-regionMap",
				open: function() {
					measure();
					clearInterval(state.timer);
					state.timer = setInterval(function() { paint(false); }, POLL_MS);
				},
				close: function() { clearInterval(state.timer); state.timer = null; },
				resizeStop: function() { measure(); },
				dragStop: function() { measure(); }
			});
			bind($d);
			return $d;
		}

		function bind($d) {
			// Overlay toggles and heat: saved as the user's choice
			$d.on("change", "input[data-ov]", function() {
				saveSetting({ overlay: { name: $(this).attr("data-ov"), on: this.checked } });
				paint(true);
			});
			$d.on("change", ".rm-heat", function() { saveSetting({ heat: this.value }); paint(true); });
			$d.on("change", ".rm-region", function() { show(Number(this.value), null); });
			$d.on("click", ".rm-fit", function() { fitView(); });
			$d.on("click", ".rm-zoom-in", function() { zoomBy(1.4); });
			$d.on("click", ".rm-zoom-out", function() { zoomBy(1 / 1.4); });
			$d.on("keydown", ".rm-goto", function(e) {
				if (e.which !== 13) { return; }
				const target = rm.resolveText(this.value, appData.systems, regions());
				if (!target) { notify("Region map: no single system or region starts with \"" + rm.escape(this.value) + "\".", "yellow", 4000); return; }
				this.value = "";
				open(target);
			});

			// Card
			$d.on("click", ".rm-card-close", function() { select(null); });
			$d.on("click", ".rm-dest", function() { if (state.sel) { setDestination(state.sel); } });
			$d.on("click", ".rm-route-btn", function() { if (state.sel) { setRoute(state.sel); } });
			$d.on("click", ".rm-view", function() { if (state.sel) { viewSystem(state.sel); } });

			// Systems and stubs
			let moved = false;
			$d.on("click", ".rm-sys", function(e) { if (moved) { return; } e.stopPropagation(); select($(this).attr("data-id")); });
			$d.on("dblclick", ".rm-sys", function(e) { e.preventDefault(); viewSystem($(this).attr("data-id")); });
			$d.on("click", ".rm-stub", function() {
				if (moved) { return; }
				show(Number($(this).attr("data-region")), Number($(this).attr("data-system")));
			});
			$d.on("click", ".rm-svg", function(e) { if (!moved && !$(e.target).closest(".rm-sys, .rm-stub").length) { select(null); } });

			// Pan (drag) and zoom (wheel)
			let drag = null;
			$d.on("pointerdown", ".rm-svg", function(e) {
				if (e.button !== 0) { return; }
				drag = { x: e.clientX, y: e.clientY, tx: state.t.x, ty: state.t.y, active: false, id: e.pointerId };
			});
			$d.on("pointermove", ".rm-svg", function(e) {
				if (!drag) { return; }
				const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
				if (!drag.active) {
					if (Math.hypot(dx, dy) < 4) { return; }
					drag.active = true;
					try { this.setPointerCapture(drag.id); } catch (err) { /* the pointer is gone */ }
					$(this).addClass("rm-dragging");
				}
				state.t = { k: state.t.k, x: drag.tx + dx, y: drag.ty + dy };
				applyTransform();
			});
			const end = function() {
				if (drag && drag.active) { moved = true; setTimeout(function() { moved = false; }, 0); }
				$d.find(".rm-svg").removeClass("rm-dragging");
				drag = null;
			};
			$d.on("pointerup pointercancel", ".rm-svg", end);
			$d.on("wheel", ".rm-svg", function(e) {
				e.preventDefault();
				const rect = this.getBoundingClientRect(), oe = e.originalEvent;
				state.t = rm.zoomAt(state.t, oe.clientX - rect.left, oe.clientY - rect.top, Math.exp(-oe.deltaY * 0.0016));
				applyTransform();
			});
		}

		function zoomBy(factor) {
			measure();
			state.t = rm.zoomAt(state.t, state.view.w / 2, state.view.h / 2, factor);
			applyTransform();
		}

		function buildDialog() {
			const toggles = [["exits", "Chain exits"], ["pilots", "Pilots"], ["fight", "Fight here"], ["route", "Route"], ["constellations", "Constellations"]];
			$("body").append(
				"<div id='" + DIALOG_ID + "' class='hidden'><div class='rm-wrap'>"
				+ "<div class='rm-bar'>"
				+ "<select class='rm-region' title='Region'></select> "
				+ "<input type='text' class='rm-goto' placeholder='Go to system or region' autocomplete='off' /> "
				+ "<span class='rm-toggles'>" + toggles.map(function(t) {
					return "<label><input type='checkbox' data-ov='" + t[0] + "' /> " + t[1] + "</label>";
				}).join("") + "</span> "
				+ "<select class='rm-heat' title='Last hour, from the data Tripwire already loads'>" + Object.keys(rm.HEAT).map(function(k) {
					return "<option value='" + k + "'>" + (k === "none" ? "Heat: off" : "Heat: " + rm.HEAT[k].label) + "</option>";
				}).join("") + "</select> "
				+ "<span class='rm-view-buttons'><button class='rm-zoom-out' title='Zoom out'>&minus;</button><button class='rm-zoom-in' title='Zoom in'>+</button><button class='rm-fit' title='Fit the whole region'>Fit</button></span>"
				+ "</div>"
				+ "<div class='rm-stage'><svg class='rm-svg' xmlns='" + NS + "'></svg><div class='rm-card hidden'></div>"
				+ "<div class='rm-hint'>Drag to pan · wheel to zoom · click a system · double-click opens it in Tripwire · click a gate label to cross into that region</div></div>"
				+ "</div></div>");
		}

		// ---- Where it opens from ----

		function setupChainMenu() {
			const $parent = $("#chainParent"), $menu = $("#chainMenu");
			if (!$parent.length || !$menu.length || !$parent.contextmenu) { return; }
			const COMMAND = "regionMap";
			$menu.append("<li data-command='" + COMMAND + "'><a id='regionMapMenuItem'>Region map</a></li>");
			$menu.menu("refresh");
			const select = $parent.contextmenu("option", "select");
			$parent.contextmenu("option", "select", function(e, ui) {
				if (ui.cmd === COMMAND) {
					rm.openSystem($(ui.target[0]).closest("[data-nodeid]").data("nodeid"));
					return;
				}
				return select ? select.apply(this, arguments) : undefined;
			});
			const beforeOpen = $parent.contextmenu("option", "beforeOpen");
			$parent.contextmenu("option", "beforeOpen", function(e, ui) {
				try {
					const id = $(ui.target[0]).closest("[data-nodeid]").data("nodeid");
					$(this).contextmenu("showEntry", COMMAND, enabled() && rm.canOpen(appData.systems[id]));
				} catch (err) { console.error("Region map: menu update failed", err); }
				return beforeOpen ? beforeOpen.apply(this, arguments) : undefined;
			});
		}

		function updateInfoLink(systemID) {
			const show = enabled() && rm.canOpen(appData.systems[systemID]);
			$("#infoLinks .rm-info-link, #infoLinks .rm-info-sep").toggle(show);
		}

		function setupInfoLink() {
			const $links = $("#infoLinks");
			if (!$links.length) { return; }
			$links.append("<span class='rm-info-sep'> - </span><a href='#' class='rm-info-link' title='Open the region map on this system'>Region map</a>");
			$links.on("click", ".rm-info-link", function(e) { e.preventDefault(); rm.openSystem(viewingSystemID); });
			if (typeof tripwire.systemChange === "function" && !tripwire.systemChange.regionMapWrapped) {
				const original = tripwire.systemChange;
				tripwire.systemChange = function(systemID) {
					const result = original.apply(this, arguments);
					try { updateInfoLink(systemID); } catch (e) { console.error("Region map: info link failed", e); }
					return result;
				};
				tripwire.systemChange.regionMapWrapped = true;
			}
			updateInfoLink(viewingSystemID);
		}

		function setupCommand() {
			if (typeof forkCommands === "undefined") { return; }
			forkCommands.register({
				id: "regionmap.open", title: "Region map", group: "Navigation", icon: "follow", keywords: ["dotlan", "null-sec", "low-sec", "region", "map", "constellation"],
				enabled: function() { return enabled() ? true : "Turned off in Settings > Routes & Navigation"; },
				args: [{
					name: "where", label: "system or region", type: "choice",
					choices: function() { return rm.choices(appData.systems, regions()); },
					default: function(ctx) { return rm.canOpen(appData.systems[ctx.viewingSystemID]) ? "s:" + ctx.viewingSystemID : undefined; }
				}],
				run: function(args) {
					const target = rm.parseTarget(args.where);
					if (!target) { throw new Error("Pick a system or a region"); }
					open(target);
				}
			});
		}

		function setupSettings() {
			if (typeof forkSettings === "undefined") { return; }
			forkSettings.register({
				section: "routes", order: 70, id: "regionMap-enabled", type: "checkbox", key: "regionMap",
				label: "Region map:", text: "Show the region map (right-click menu, system panel, Ctrl+K)",
				hint: "A Dotlan-style map of a null-sec, low-sec or high-sec region with your chain exits, pilots, routes and activity.",
				get: function(o) { return rm.settings(o).enabled; },
				set: function(o, on) { o.regionMap = rm.withSetting(o, { enabled: on }); }
			});
			forkSettings.register({
				section: "routes", order: 71, id: "regionMap-heat", type: "select", key: "regionMap",
				label: "Region map heat:", choices: Object.keys(rm.HEAT).map(function(k) { return [k, k === "none" ? "Off" : rm.HEAT[k].label]; }),
				hint: "Which last-hour activity the map shades when it opens. The map's header changes it too.",
				get: function(o) { return rm.settings(o).heat; },
				set: function(o, heat) { o.regionMap = rm.withSetting(o, { heat: heat }); }
			});
		}

		$(function() {
			try {
				rm = regionMap;
				rm.open = open;
				rm.openSystem = function(systemID) { return open({ kind: "system", id: Number(systemID) }); };
				buildDialog();
				setupSettings();
				setupCommand();
				setupChainMenu();
				setupInfoLink();
			} catch (e) { console.error("Region map: setup failed", e); }
		});
	})();
}
