// Fork-owned: the region map panel (Dotlan-style schematic of one k-space region), see region-map.js for the logic and
// the layout data. Opened from the chain map's right-click menu, the system panel and the command palette (Ctrl+K).
// The bundle concatenates fork files alphabetically: region-map.js defines `regionMap`; everything here runs at DOM ready.
if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined") {
	(function() {
		let rj = null;		// regionMapJumps (region-map-jumps.js), looked up at DOM ready like rm
		let rs = null;		// regionMapSkyhooks (region-map-skyhooks.js), looked up at DOM ready like rm
		let rm = null;		// regionMap (region-map.js sorts after this file in the bundle, so it is looked up at DOM ready)
		const NS = "http://www.w3.org/2000/svg";
		const DIALOG_ID = "dialog-regionMap";
		const POLL_MS = 3000;
		const HOUR_MS = 3600 * 1000;
		const SKY_TICK_S = 30;		// skyhook countdowns (tooltips, card, list) are rewritten every 30 s, without a repaint

		const state = {
			layout: null, regionID: null, sel: null, t: { k: 1, x: 0, y: 0 }, view: { w: 800, h: 500 },
			cache: {}, loading: null, signature: "", timer: null, jumpOn: false, sessionOrigin: null, reach: { key: "", rows: {} }, jumpData: null, jumpLoading: null, jumpFailed: 0,
			activity: null, activityAt: 0, activityBusy: false, activityFailedAt: 0, nodes: {}, layers: {}, skyTick: 0
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
			const own = chain.data && chain.data.activity;
			if (own && Object.keys(own).length > 1) { return; }	// the chain map already has it
			if (state.activity && Date.now() - state.activityAt < HOUR_MS) { return; }
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
			if (state.layout && state.view.w > 1) { state.t = rm.clampPan(state.t, state.layout, state.view.w, state.view.h); }
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

		// ---- Jump range overlay (the Jump planner's engine and data, read only) ----

		/** systems.json + ships.json of the Jump planner (same URLs and cache keys, so the browser has them already if the
		planner was used); loaded once, on first use of the overlay */
		function loadJumpData() {
			if (state.jumpData) { return $.Deferred().resolve(state.jumpData).promise(); }
			if (state.jumpLoading) { return state.jumpLoading; }
			if (Date.now() - state.jumpFailed < 30000 || typeof jumpRange === "undefined") { return $.Deferred().reject().promise(); }
			const planner = typeof jumpPlanner !== "undefined" ? jumpPlanner : {};
			const base = planner.DATA_URL || "jumprange/", v = planner.DATA_VERSION || "";
			state.jumpLoading = $.when(
				$.getJSON(base + "systems.json" + (v ? "?v=" + v : "")),
				$.getJSON(base + "ships.json" + (v ? "?v=" + v + "." + (planner.SHIPS_REV || "") : ""))
			).then(function(sys, ships) {
				const coords = jumpRange.decode(sys[0]);
				state.jumpData = { index: jumpRange.buildIndex(coords, rj.CELL_LY), presets: jumpRange.presets(ships[0]) };
				state.jumpLoading = null;
				paint(true);
				return state.jumpData;
			}, function() {
				state.jumpLoading = null;
				state.jumpFailed = Date.now();
				paint(true);
				return $.Deferred().reject().promise();
			});
			return state.jumpLoading;
		}

		/** What the overlay needs for this paint: null when it is off, else {loading | error | res, originID, preset, ...} */
		function jumpContext(layout) {
			if (!state.jumpOn) { return null; }
			if (!state.jumpData) {
				loadJumpData();
				return { loading: !state.jumpFailed || Date.now() - state.jumpFailed >= 30000, failed: Date.now() - state.jumpFailed < 30000 };
			}
			const cfg = rj.settings(options);
			const exits = chainExits().map(Number).filter(function(id) { return rm.isKSpace(appData.systems[id]); });
			const origins = rj.origins({ selected: state.sel, me: myLocation(), exits: exits, systems: appData.systems, choice: state.sessionOrigin || cfg.origin });
			if (origins.problem) { return { origins: origins, error: "problem", problem: origins.problem }; }
			if (!origins.id) { return { origins: origins, error: "none" }; }
			const preset = jumpRange.preset(state.jumpData.presets, cfg.ship);
			const res = rj.compute({ originID: origins.id, preset: preset, jdc: cfg.jdc, index: state.jumpData.index, systems: appData.systems,
				ids: layout.systems.map(function(s) { return s.id; }) });
			return { origins: origins, originID: origins.id, preset: preset, res: res, cfg: cfg, error: res.error };
		}

		/** The two-jump answer for one system, only asked for the selected system's card and kept per origin, ship and JDC level */
		function jumpReach(jc, id) {
			const key = [jc.originID, jc.cfg.ship, jc.cfg.jdc].join("|");
			if (state.reach.key !== key) { state.reach = { key: key, rows: {} }; }
			if (state.reach.rows[id] === undefined) {
				try {
					state.reach.rows[id] = jumpRange.reach(jc.originID, id, jc.res.range, state.jumpData.index, appData.systems, rj.engineOptions(jc.preset), 2);
				} catch (e) { state.reach.rows[id] = null; }
			}
			return state.reach.rows[id];
		}

		/** The line for a system: tooltips just say "out of range"; the card (withReach) also looks for a two-jump route */
		function jumpLine(jc, id, withReach) {
			const row = jc.res.rows[id];
			if (!row) { return "No position data for this system"; }
			return rj.describe(jc.res, row, withReach && row.state === "out" ? jumpReach(jc, id) : null, sysName, appData.systems[id], id);
		}

		function paintJumpBar(jc) {
			const $bar = $("#" + DIALOG_ID + " .rm-jbar"), cfg = rj.settings(options);
			$bar.toggle(state.jumpOn);
			if (!state.jumpOn) { return; }
			$bar.find(".rm-jship").val(cfg.ship);
			$bar.find(".rm-jdc").val(String(cfg.jdc));
			const $o = $bar.find(".rm-jorigin"), list = jc && jc.origins ? jc.origins.options : [];
			const html = list.length ? list.map(function(o) { return "<option value='" + rm.escape(o.value) + "'>" + rm.escape(o.label) + "</option>"; }).join("") : "<option value=''>No origin</option>";
			if ($o.attr("data-html") !== html) { $o.html(html).attr("data-html", html); }
			$o.val(jc && jc.origins ? jc.origins.value : "");
			let text;
			if (!jc || jc.loading) { text = "Loading jump data\u2026"; }
			else if (jc.failed) { text = "Could not load the jump range data."; }
			else if (jc.error === "problem") { text = jc.problem; }
			else if (jc.error === "none") { text = "Select a system, or be in one, to see its jump range."; }
			else if (jc.error === "origin") { text = "No jump drive can be used from " + sysName(jc.originID) + "."; }
			else if (jc.error) { text = "No jump data for " + sysName(jc.originID) + "."; }
			else {
				const inHere = state.layout.systems.filter(function(s) { return (jc.res.rows[s.id] || {}).state === "in"; }).length;
				text = jc.res.label + " \u00b7 range " + rj.ly(jc.res.range) + (state.layout.byId[jc.originID] ? "" : " from " + sysName(jc.originID) + " (" + regionName((appData.systems[jc.originID] || {}).regionID) + ")")
					+ " \u00b7 " + inHere + " in range here";
			}
			$bar.find(".rm-jinfo").text(text);
		}

		/** Open the map on a system with the jump overlay on ("Region map jumps <system> [ship]") */
		function openJumps(systemID, ship) {
			state.jumpOn = true;
			state.sessionOrigin = "selected";	// this session only: the remembered origin choice is left alone
			if (ship) { saveSetting({ jump: rj.withJump(options, { ship: ship }) }); }	// a ship the user typed is remembered
			return open({ kind: "system", id: Number(systemID) });
		}

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
			ctx.jump = jumpContext(layout);
			ctx.sky = skyContext(layout, ctx.me);
			ctx.targets = targetsContext();
			return ctx;
		}

		// ---- Targets (mask-wide, map-targets.js keeps the list: public/map_targets.php, polled every 30 s while this paints) ----

		function tStore() { return typeof mapTargets !== "undefined" && mapTargets.store ? mapTargets.store : null; }

		/** null when the overlay is off, else {list, numbers, loaded, error, now} */
		function targetsContext() {
			const store = tStore();
			if (!rm.settings(options).overlays.targets || !store) { return null; }
			const st = store.get();
			return { list: st.list, numbers: mapTargets.numbers(st.list), loaded: st.loaded, error: st.error, now: st.now,
				sig: mapTargets.badgeKey(st.list) + "#" + st.list.map(function(t) { return t.createdBy.name + "@" + t.expires; }).join(",") };
		}

		function targetLine(t, n, now) {
			return "Target " + n + (t.note ? ": " + t.note : "") + " (marked by " + (t.createdBy.name || "?") + ", expires in " + mapTargets.duration(t.expires - now) + ")";
		}

		function drawTargets(L, layout, tc) {
			if (!tc) { return; }
			tc.list.forEach(function(t, i) {
				const s = layout.byId[t.systemID];
				if (!s) { return; }
				outline(L.tags, s, "rm-target", 3);
				const g = el("g", { "class": "rm-tnum", "data-id": s.id, transform: "translate(" + (s.x - rm.BOX_W / 2 - 3).toFixed(1) + " " + s.y.toFixed(1) + ")" }, L.tags);
				el("circle", { r: 9 }, g);
				el("text", { y: 4, "text-anchor": "middle" }, g, String(i + 1));
				state.nodes[s.id].tnum = el("title", null, g);
				state.nodes[s.id].tnum.textContent = targetLine(t, i + 1, tc.now);
			});
		}

		/** Mark / remove from the card or with Shift+click */
		function toggleTarget(id) {
			const store = tStore();
			if (!store) { return; }
			if (!mapTargets.canTarget(appData.systems[id])) { notify("Targets: only k-space systems can be targets.", "yellow", 4000); return; }
			const xhr = store.toggle(id);
			if (xhr) { xhr.always(function() { paint(true); }); }
		}

		function targetCardHtml(tc, id) {
			if (!tc || !mapTargets.canTarget(appData.systems[id])) { return ""; }
			const e = rm.escape, hit = tc.numbers[id];
			const end = tStore().skyhookEnd(id), def = mapTargets.defaultExpiry(end, tc.now);
			// An existing target keeps its expiry unless another one is picked (saving only a note must not reset it)
			const choices = (hit ? [["keep", "keep (expires in " + mapTargets.duration(hit.target.expires - tc.now) + ")"]] : [])
				.concat(def.until ? [["skyhook", "until its skyhook window ends"]] : []).concat(mapTargets.HOURS.map(function(h) { return [String(h), h + " h"]; }));
			const sel = hit ? "keep" : def.until ? "skyhook" : String(def.hours);
			const expiry = "<select class='rm-texpiry' title='When the target goes away by itself'>" + choices.map(function(c) {
				return "<option value='" + c[0] + "'" + (c[0] === sel ? " selected" : "") + ">" + e(c[1]) + "</option>";
			}).join("") + "</select>";
			const note = "<input type='text' class='rm-tnote' maxlength='" + mapTargets.NOTE_MAX + "' placeholder='Note (optional)' value='" + e(hit ? hit.target.note : "") + "' />";
			if (hit) {
				return "<div class='rm-card-target'><div class='rm-card-row rm-tline'>" + e(targetLine(hit.target, hit.n, tc.now)) + "</div>"
					+ "<div class='rm-card-row'>" + note + " " + expiry + " <button class='rm-tsave' title='Change the note and expiry'>Save</button> "
					+ "<button class='rm-tremove' title='Remove this target for the whole mask (Shift+click on the map does it too)'>Remove target</button></div></div>";
			}
			return "<div class='rm-card-target'><div class='rm-card-row'>" + note + " " + expiry + " "
				+ "<button class='rm-tadd' title='Mark this system for the whole mask (Shift+click on the map does it too)'>Mark as target</button></div></div>";
		}

		/** The "Targets (N)" list of the side panel: every target of the mask, in any region */
		function renderTargets(ctx) {
			const $side = $("#" + DIALOG_ID + " .rm-side");
			const tc = ctx.targets;
			if (!tc) { $side.find(".rm-side-targets").remove(); return; }
			let $sec = $side.find(".rm-side-targets");
			if (!$sec.length) { $sec = $("<div class='rm-side-sec rm-side-targets'></div>").prependTo($side); }
			const e = rm.escape, collapsed = ctx.cfg.collapsed.targets;
			const origins = skyOrigins(ctx.me);
			let jumps = {};
			if (!collapsed && tc.list.length && origins.ids.length && skyStore()) { try { jumps = skyStore().jumpsFrom(origins.ids); } catch (err) { jumps = {}; } }
			const from = origins.from === "you" ? "from you" : origins.from === "exit" ? "from the nearest chain exit" : "";
			const head = "<a href='#' class='rm-side-toggle' data-list='targets' title='" + (collapsed ? "Show the list" : "Hide the list") + "'>" + (collapsed ? "&#9656;" : "&#9662;") + "</a> "
				+ "<b>Targets</b> <span class='rm-muted'>(" + tc.list.length + "/" + mapTargets.MAX + ")</span><span class='rm-thint rm-muted' title='Shift+click a system on the map to mark or remove it'>shift+click</span>";
			let html = "";
			if (!collapsed) {
				if (!tc.loaded) { html += "<div class='rm-muted rm-side-note'>" + e(tc.error || "Loading\u2026") + "</div>"; }
				else if (!tc.list.length) { html += "<div class='rm-muted rm-side-note'>No targets. Select a system and click \u201cMark as target\u201d, or Shift+click it. The whole mask sees them.</div>"; }
				html += "<ul class='rm-tlist'>" + tc.list.map(function(t, i) {
					const sys = appData.systems[t.systemID] || {}, here = state.layout.byId[t.systemID];
					const j = jumps[t.systemID];
					const tip = targetLine(t, i + 1, tc.now) + (j ? " \u00b7 " + j.jumps + " jumps " + from : "") + (here ? "" : " \u00b7 click to open " + regionName(sys.regionID));
					return "<li class='rm-trow' draggable='true' data-id='" + t.systemID + "' title='" + e(tip) + "'>"
						+ "<span class='rm-t-n'>" + (i + 1) + "</span>"
						+ "<span class='rm-t-sys'>" + e(sysName(t.systemID)) + (here ? "" : " <span class='rm-muted'>" + e(regionName(sys.regionID)) + "</span>")
						+ (t.note ? "<span class='rm-t-note'>" + e(t.note) + "</span>" : "") + "</span>"
						+ "<span class='rm-t-by rm-muted'>" + e(t.createdBy.name) + "</span>"
						+ "<span class='rm-t-exp rm-muted'>" + e(mapTargets.duration(t.expires - tc.now)) + "</span>"
						+ "<span class='rm-t-jumps'>" + (j ? j.jumps + " j" : "\u2013") + "</span>"
						+ "<span class='rm-t-btns'><a href='#' class='rm-tup' title='Move up'>&#9650;</a><a href='#' class='rm-tdown' title='Move down'>&#9660;</a><a href='#' class='rm-tdel' title='Remove'>&times;</a></span></li>";
				}).join("") + "</ul>";
				if (tc.list.length) {
					html += "<div class='rm-side-note rm-tbuttons'><button class='rm-tsend' title='Send the targets to your characters as in-game waypoints, in this order'>Send waypoints</button> "
						+ "<button class='rm-tshort' title='Reorder the list: always the nearest next target by gate jumps, starting " + e(from || "nowhere (no location)") + "'>Shortest order</button> "
						+ "<button class='rm-tclear' title='Remove every target of the mask'>Clear all</button> <span class='rm-tsend-status rm-muted'></span></div>";
				}
			}
			// keep the sending progress line while the list is redrawn
			const status = $sec.find(".rm-tsend-status").text();
			setSection($sec, head, html);
			if (status) { $sec.find(".rm-tsend-status").text(status); }
		}

		function targetIDs() { const tc = state.lastTargets; return tc ? tc.list.map(function(t) { return t.systemID; }) : []; }

		function shortestOrder() {
			const ids = targetIDs();
			if (ids.length < 2) { return; }
			const origins = skyOrigins(myLocation());
			if (!origins.ids.length) { notify("Shortest order needs your location in k-space or a k-space exit on the chain.", "yellow", 6000); return; }
			let order;
			try { order = mapTargets.shortestOrder(origins.ids, ids, function(from) { return skyStore().jumpsFrom(from); }); } catch (e) { console.error("Targets: shortest order failed", e); return; }
			tStore().reorder(order).always(function() { paint(true); });
		}

		/** "Mark all listed skyhooks as targets": the systems of the region's filtered list, as many as fit */
		function markSkyhookTargets() {
			const sky = state.lastSky, tc = state.lastTargets;
			if (!sky || sky.loading || !tc || !tStore()) { return; }
			const ids = [];
			rs.regionRows(sky.bySys, sky.ids, skyJumps(sky), sky.cfg.sort).forEach(function(r) {
				if (ids.indexOf(r.skyhook.systemID) < 0 && !tc.numbers[r.skyhook.systemID]) { ids.push(r.skyhook.systemID); }
			});
			const room = Math.max(0, mapTargets.MAX - tc.list.length), take = ids.slice(0, room);
			if (!take.length) { notify(ids.length ? "The target list is full (" + mapTargets.MAX + ")." : "Every listed skyhook system is a target already.", "yellow", 5000); return; }
			if (!window.confirm("Mark " + take.length + " system" + (take.length === 1 ? "" : "s") + " with listed skyhooks as targets for the whole mask?" + (take.length < ids.length ? " (" + (ids.length - take.length) + " more don't fit in the list of " + mapTargets.MAX + ".)" : ""))) { return; }
			let chain = $.Deferred().resolve().promise();
			take.forEach(function(id) { chain = chain.then(function() { return tStore().add(id, "", "skyhook") || $.Deferred().resolve().promise(); }); });
			chain.always(function() { paint(true); });
		}

		// ---- Skyhooks overlay (the data comes from skyhooks-panel.js's shared loader, skyhooks.php: never ESI from here) ----

		function skyStore() { return typeof skyhooksPanel !== "undefined" && skyhooksPanel.store ? skyhooksPanel.store : null; }
		function skyCfg() { return skyhooksPanel.settings(options.skyhooksPanel); }

		/** Where the side list counts jumps from: you (in k-space), else the chain's k-space exits */
		function skyOrigins(me) {
			if (me && rm.isKSpace(appData.systems[me])) { return { ids: [me], from: "you" }; }
			const exits = chainExits().map(Number).filter(function(id) { return rm.isKSpace(appData.systems[id]); });
			return { ids: exits, from: exits.length ? "exit" : "" };
		}

		/** null when the overlay is off, else {loading, error, cfg, now, bySys, ...} */
		function skyContext(layout, me) {
			const store = skyStore();
			if (!rm.settings(options).overlays.skyhooks || !store || !rs) { return null; }
			const st = store.get(), now = store.now(), cfg = skyCfg();
			const out = { cfg: cfg, now: now, bySys: {}, error: st.error, planetsFailed: st.planetsFailed, loading: !st.data, data: st.data, planets: st.planets, origins: skyOrigins(me), ids: [], sig: "" };
			if (!st.data) { return out; }
			try { out.bySys = rs.bySystem(st.data.skyhooks, store.systemFor, now, cfg, st.planets); } catch (e) { console.error("Region map: skyhooks failed", e); }
			out.ids = layout.systems.map(function(s) { return s.id; });
			out.sig = rs.signature(out.bySys, out.ids);
			return out;
		}

		/** Open the map on a system with the Skyhooks overlay on (the chain map's skyhook icon, Ctrl+K "Skyhooks").
		The overlay is switched on as the user's saved choice, so the header checkbox and the next opening agree. */
		function openSkyhooks(systemID) {
			if (!rm.settings(options).overlays.skyhooks) { saveSetting({ overlay: { name: "skyhooks", on: true } }); }
			return open({ kind: "system", id: Number(systemID) });
		}

		function paintSkyBar(sky) {
			const $bar = $("#" + DIALOG_ID + " .rm-sbar");
			$bar.toggle(!!sky);
			if (!sky) { return; }
			const cfg = sky.cfg;
			if (!$bar.find(":focus").length) {
				$bar.find(".rm-swindow").val(cfg.window);
				$bar.find(".rm-shours").val(String(cfg.soonHours)).toggle(cfg.window === "soon");
				["lava", "ice", "low", "null"].forEach(function(k) { $bar.find("input[data-sky='" + k + "']").prop("checked", cfg[k]); });
			}
			let text;
			if (sky.loading) { text = sky.error ? sky.error : "Loading skyhooks\u2026"; }
			else {
				let here = 0, open = 0;
				state.layout.systems.forEach(function(s) { const x = sky.bySys[s.id]; if (x) { here += x.items.length; open += x.open; } });
				const notes = [];
				if (sky.error) { notes.push(sky.error + " Showing the last list."); }
				else if (sky.data.error && sky.data.stale && !sky.data.unavailable) { notes.push("ESI is not answering: the list is from " + skyhooksPanel.duration(sky.now - sky.data.fetched) + " ago."); }
				else if (sky.data.unavailable) { notes.push(sky.data.error || "Skyhook data unavailable."); }
				if (sky.planetsFailed && !sky.planets) { notes.push("Planet details could not be loaded."); }
				text = here + " skyhook" + (here === 1 ? "" : "s") + " here, " + open + " open now (EVE time)" + (notes.length ? " \u00b7 " + notes.join(" ") : "");
			}
			$bar.find(".rm-sinfo").text(text);
		}

		/** Jumps for the side list (one search from you or all the chain's exits, cached by skyhooks-panel.js) */
		function skyJumps(sky) {
			try { return sky.origins.ids.length ? skyStore().jumpsFrom(sky.origins.ids) : {}; } catch (e) { console.error("Region map: skyhook jumps failed", e); return {}; }
		}

		/** The "Skyhooks in <region>" list of the side panel */
		function renderSide(ctx) {
			const $side = $("#" + DIALOG_ID + " .rm-side");
			const sky = ctx.sky;
			if (!sky) { $side.find(".rm-side-sky").remove(); return; }
			let $sec = $side.find(".rm-side-sky");
			if (!$sec.length) { $sec = $("<div class='rm-side-sec rm-side-sky'></div>").appendTo($side); }
			const e = rm.escape, sp = skyhooksPanel, collapsed = ctx.cfg.collapsed.skyhooks;
			const rows = sky.loading ? [] : rs.regionRows(sky.bySys, sky.ids, skyJumps(sky), sky.cfg.sort);
			let head = "<a href='#' class='rm-side-toggle' data-list='skyhooks' title='" + (collapsed ? "Show the list" : "Hide the list") + "'>" + (collapsed ? "&#9656;" : "&#9662;") + "</a> "
				+ "<b>Skyhooks in " + e(state.layout.name) + "</b> <span class='rm-muted'>(" + rows.length + ")</span>";
			if (!collapsed) {
				head += " <select class='rm-ssort' title='Sort the list'>" + [["jumps", "by jumps"], ["start", "by window"], ["value", "by value"]].map(function(o) {
					return "<option value='" + o[0] + "'" + (o[0] === sky.cfg.sort ? " selected" : "") + ">" + o[1] + "</option>";
				}).join("") + "</select>";
			}
			let html = "";
			if (!collapsed) {
				if (sky.loading) { html += "<div class='rm-muted rm-side-note'>" + e(sky.error || "Loading\u2026") + "</div>"; }
				else if (!rows.length) { html += "<div class='rm-muted rm-side-note'>No raidable skyhook here matches the filters.</div>"; }
				const from = sky.origins.from === "you" ? "from you" : sky.origins.from === "exit" ? "from the nearest chain exit" : "";
				html += "<ul class='rm-slist'>" + rows.map(function(r) {
					const item = r.skyhook, p = item.planet || {}, name = sysName(item.systemID);
					const jumps = r.nearest ? (r.nearest.jumps === 0 ? "here" : r.nearest.jumps + " j") : "\u2013";
					return "<li class='rm-srow rm-s-" + item.state + "' data-id='" + item.systemID + "' title='" + e(name + " " + rs.itemText(item, sky.now) + (r.nearest ? " \u00b7 " + (r.nearest.jumps === 0 ? "0 jumps" : r.nearest.jumps + " jumps") + " " + from : "")) + "'>"
						+ "<span class='rm-s-sys'>" + e(name) + (p.number ? " " + e(p.number) : "") + "</span>"
						+ "<span class='rm-s-kind rm-s-" + e(p.kind || "unknown") + "'>" + e(rs.kindText(p.kind)) + "</span>"
						+ "<span class='rm-s-val'>" + (r.rating ? sp.ratingHtml(r.rating) : "") + "</span>"
						+ "<span class='rm-s-time'>" + e(sp.countdown(item.start, item.end, sky.now).replace("open now, ", "")) + "</span>"
						+ "<span class='rm-s-jumps' title='Gate jumps " + e(from) + "'>" + e(jumps) + "</span></li>";
				}).join("") + "</ul>";
				if (!sky.loading) {
					const nb = rs.neighbours(sky.bySys, state.layout.stubs.map(function(st) { return st.toRegionID; }), appData.systems);
					const total = nb.reduce(function(n, x) { return n + x.count; }, 0);
					if (rows.length && ctx.targets) {
						html += "<div class='rm-side-note'><button class='rm-smark' title='Mark the systems of this list (as filtered) as targets for the whole mask'>Mark all listed as targets</button></div>";
					}
					if (total) {
						html += "<div class='rm-side-note'>" + total + " more in neighbouring regions: " + nb.map(function(x) {
							return "<a href='#' class='rm-snb' data-region='" + x.regionID + "'>" + e(regionName(x.regionID)) + " (" + x.count + ")</a>";
						}).join(", ") + "</div>";
					}
				}
			}
			setSection($sec, head, html);
		}

		/** A side list section: its header (left alone while one of its controls has the focus, so an open dropdown stays
		open) and its body are replaced separately, and only when they changed */
		function setSection($sec, head, body) {
			let $h = $sec.children(".rm-side-head"), $b = $sec.children(".rm-side-body");
			if (!$h.length || !$b.length) {
				$sec.empty();
				$h = $("<div class='rm-side-head'></div>").appendTo($sec);
				$b = $("<div class='rm-side-body'></div>").appendTo($sec);
			}
			if ($h.attr("data-html") !== head && !$h.find(":focus").length) { $h.html(head).attr("data-html", head); }
			if ($b.attr("data-html") !== body) { $b.html(body).attr("data-html", body); }
		}

		/** The card's "Skyhooks" block for the selected system: the ones passing the filters, and how many the filters hide */
		function skyCardHtml(sky, id) {
			if (!sky || sky.loading) { return ""; }
			const e = rm.escape, entry = sky.bySys[id];
			const all = rs.bySystem(sky.data.skyhooks.filter(function(x) { return Number(x.systemID) === id; }), skyStore().systemFor, sky.now,
				Object.assign({}, sky.cfg, { window: "all", low: true, null: true, lava: true, ice: true }), sky.planets)[id];
			if (!all) { return ""; }
			const shown = entry ? entry.items : [];
			const hidden = all.items.length - shown.length;
			return "<div class='rm-card-sky'><div class='rm-card-sky-head'>\u2693 Skyhooks</div>" + shown.map(function(item) {
				return "<div class='rm-card-row rm-s-" + item.state + "'>" + e(rs.itemText(item, sky.now)) + "</div>";
			}).join("") + (hidden > 0 ? "<div class='rm-card-row rm-muted'>" + hidden + " more hidden by the Skyhooks filters</div>" : "") + "</div>";
		}

		/** The skyhook pill above the box; a row higher on a chain exit (its hole pill takes the first row on the right) */
		function drawSky(L, layout, sky, fight, exits) {
			if (!sky || sky.loading) { return; }
			const exitIDs = (exits || []).map(function(x) { return x.systemID; });
			layout.systems.forEach(function(s) {
				const m = rs.marker(sky.bySys[s.id]);
				if (!m) { return; }
				const w = 17 + m.text.length * 7, row = exitIDs.indexOf(s.id) >= 0 ? 2 : 1;
				const g = el("g", { "class": "rm-sky rm-sky-" + m.state, "data-id": s.id, transform: "translate(" + (s.x - rm.BOX_W / 2).toFixed(1) + " " + (s.y - rm.BOX_H / 2 - 17 * row).toFixed(1) + ")" }, L.tags);
				el("rect", { width: w, height: 15, rx: 7 }, g);
				el("text", { x: 3, y: 12, "class": "rm-sky-glyph" }, g, "\u2693");
				if (m.text) { el("text", { x: 15, y: 11 }, g, m.text); }
				state.nodes[s.id].sky = el("title", null, g);
				state.nodes[s.id].sky.textContent = rs.tooltip(sky.bySys[s.id], sky.now).join("\n");
				if (fight === s.id) { $(L.tags).find(".rm-flag").attr("transform", "translate(0 " + (-17 * row) + ")"); }
			});
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
			const sky = ctx.sky;
			const sig = JSON.stringify([ctx.cfg, ctx.exits, ctx.pilots, ctx.fight, ctx.heat.values, ctx.route && ctx.route.path, state.sel,
				ctx.jump && [ctx.jump.loading, ctx.jump.failed, ctx.jump.error, ctx.jump.originID, ctx.jump.cfg, ctx.jump.res && ctx.jump.res.rows],
				sky && [sky.loading, sky.error, sky.cfg, sky.sig, sky.origins, !!sky.planets, sky.data && sky.data.fetched],
				ctx.targets && [ctx.targets.loaded, ctx.targets.error, ctx.targets.sig]]);
			state.lastSky = sky;
			state.lastTargets = ctx.targets;
			// Countdowns (skyhook windows, target expiries) tick every 30 s
			const tick = sky || ctx.targets ? Math.floor((sky ? sky.now : ctx.targets.now) / SKY_TICK_S) : 0;
			if (!force && sig === state.signature) {
				// Only the countdowns changed: rewrite the texts (tooltips, card, list), keep the drawing
				if (tick && tick !== state.skyTick) { state.skyTick = tick; texts(ctx); }
				return;
			}
			state.skyTick = tick;
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
				const pill = rm.pillText(x.hole) || "exit", w = Math.max(24, pill.length * 8 + 12);
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
			layout.systems.forEach(function(s) { state.nodes[s.id].sky = null; state.nodes[s.id].tnum = null; });
			drawSky(L, layout, sky, ctx.fight, ctx.exits);
			drawTargets(L, layout, ctx.targets);
			if (state.sel && layout.byId[state.sel]) { outline(L.tags, layout.byId[state.sel], "rm-selected", 2.5); }

			// Jump range: in range ringed, the rest dimmed, the origin marked
			const jc = ctx.jump && ctx.jump.res && !ctx.jump.error ? ctx.jump : null;
			layout.systems.forEach(function(s) {
				const row = jc ? jc.res.rows[s.id] : null, g = $(state.nodes[s.id].g);
				g.toggleClass("rm-jin", !!row && row.state === "in").toggleClass("rm-jout", !!row && row.state === "out")
					.toggleClass("rm-jbad", !!row && row.state === "bad").toggleClass("rm-jorigin", !!row && row.state === "origin");
				if (row && row.state === "origin") { outline(L.tags, s, "rm-jorigin-ring", 3.5); }
			});
			$("#" + DIALOG_ID + " .rm-svg").toggleClass("rm-jumping", !!jc);
			paintJumpBar(ctx.jump);
			paintSkyBar(sky);
			texts(ctx);
		}

		/** Tooltips, the selected card and the side list: everything with a countdown in it */
		function texts(ctx) {
			const layout = state.layout, sky = ctx.sky;
			const jc = ctx.jump && ctx.jump.res && !ctx.jump.error ? ctx.jump : null;
			layout.systems.forEach(function(s) {
				let parts = [s.name + " (" + rm.secText(secOf(s)) + ")"];
				if (jc && jc.res.rows[s.id]) { parts.push(jumpLine(jc, s.id)); }
				const a = activityNow() && activityNow()[s.id];
				if (a && (a.npcKills || a.shipKills || a.shipJumps)) {
					parts.push("last hour: " + (a.npcKills || 0) + " NPC kills, " + (a.shipKills || 0) + " ship kills, " + (a.shipJumps || 0) + " jumps");
				}
				if (sky && !sky.loading && sky.bySys[s.id]) {
					const tip = rs.tooltip(sky.bySys[s.id], sky.now);
					parts = parts.concat(tip);
					if (state.nodes[s.id].sky) { state.nodes[s.id].sky.textContent = tip.join("\n"); }
				}
				const hit = ctx.targets && ctx.targets.numbers[s.id];
				if (hit) {
					parts.push(targetLine(hit.target, hit.n, ctx.targets.now));
					if (state.nodes[s.id].tnum) { state.nodes[s.id].tnum.textContent = targetLine(hit.target, hit.n, ctx.targets.now); }
				}
				state.nodes[s.id].title.textContent = parts.join("\n");
			});
			renderCard(ctx);
			renderSide(ctx);
			renderTargets(ctx);
			const $side = $("#" + DIALOG_ID + " .rm-side");
			$side.toggleClass("hidden", !$side.children().length);
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
			if (ctx.jump && ctx.jump.res && !ctx.jump.error && ctx.jump.res.rows[id]) {
				const row = ctx.jump.res.rows[id];
				lines.push("<div class='rm-card-row rm-card-jump rm-j-" + row.state + "'>" + (row.state === "origin" ? "" : "Jump here: ") + e(jumpLine(ctx.jump, id, true)) + "</div>");
			}
			if (ctx.route && ctx.route.from === "you" && ctx.route.jumps > 0) {
				lines.push("<div class='rm-card-row'>" + ctx.route.jumps + " jump" + (ctx.route.jumps === 1 ? "" : "s") + " from you</div>");
			}
			lines.push(skyCardHtml(ctx.sky, id));
			lines.push(targetCardHtml(ctx.targets, id));
			// Don't rebuild the card while its note or expiry is being edited
			if ($card.attr("data-id") === String(id) && $card.find("input:focus, select:focus").length) { return; }
			$card.attr("data-id", String(id)).removeClass("hidden").html(
				"<div class='rm-card-head'><b>" + e(sys.name) + "</b> <span class='rm-sec' style='color:" + rm.secColour(sys.security) + "'>" + rm.secText(sys.security) + "</span>"
				+ "<button class='rm-card-close' title='Close' aria-label='Close'>&times;</button></div>" + lines.join("")
				+ "<div class='rm-card-buttons'><button class='rm-dest' title='Set as the in-game destination (clears other waypoints)'>Set destination</button> "
				+ "<button class='rm-route-btn' title='Set this system as the in-game destination for the characters you pick'>Set destination for...</button> "
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
			$d.find("input[data-jump]").prop("checked", state.jumpOn);
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
				if (state.loading !== token) { return; }
				$("#" + DIALOG_ID + " .rm-region").val(String(state.regionID));
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
				dialogClass: "dialog-noeffect ui-dialog-shadow dialog-floating dialog-regionMap",
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
			$d.on("change", "input[data-jump]", function() { state.jumpOn = this.checked; paint(true); });
			$d.on("change", ".rm-jship", function() { saveSetting({ jump: rj.withJump(options, { ship: this.value }) }); paint(true); });
			$d.on("change", ".rm-jdc", function() { saveSetting({ jump: rj.withJump(options, { jdc: this.value }) }); paint(true); });
			$d.on("change", ".rm-jorigin", function() { if (this.value) { state.sessionOrigin = null; saveSetting({ jump: rj.withJump(options, { origin: this.value }) }); paint(true); } });
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

			// Skyhooks: the filters are the old box's (options.skyhooksPanel), the list's sort too
			const saveSky = function(patch) {
				try {
					options.skyhooksPanel = rs.withFilter(options.skyhooksPanel, patch);
					if (patch.sort) { options.skyhooksPanel.sort = patch.sort; }
					options.save();
				} catch (e) { console.error("Region map: could not save the skyhook filter", e); }
				paint(true);
			};
			$d.on("change", ".rm-swindow", function() { saveSky({ window: this.value }); });
			$d.on("change", ".rm-shours", function() { saveSky({ soonHours: Number(this.value) }); });
			$d.on("change", "input[data-sky]", function() { const p = {}; p[$(this).attr("data-sky")] = this.checked; saveSky(p); });
			$d.on("change", ".rm-ssort", function() { saveSky({ sort: this.value }); });
			$d.on("click", ".rm-side-toggle", function(e) {
				e.preventDefault();
				const name = $(this).attr("data-list");
				saveSetting({ collapsed: { name: name, on: !rm.settings(options).collapsed[name] } });
				paint(true);
			});
			$d.on("click", ".rm-srow", function() {
				const id = Number($(this).attr("data-id"));
				select(id);
				centreOnSystem(id, Math.max(1, state.t.k));
			});
			$d.on("click", ".rm-snb", function(e) { e.preventDefault(); show(Number($(this).attr("data-region")), null); });
			$d.on("click", ".rm-smark", function(e) { e.preventDefault(); markSkyhookTargets(); });

			// Targets
			const cardNote = function() { return mapTargets.cleanNote(card().find(".rm-tnote").val()); };
			const cardExpiry = function() { return card().find(".rm-texpiry").val(); };
			$d.on("click", ".rm-tadd, .rm-tsave", function() {
				if (!state.sel || !tStore()) { return; }
				const xhr = tStore().add(state.sel, cardNote(), cardExpiry());
				$(this).blur();
				if (xhr) { xhr.always(function() { paint(true); }); }
			});
			$d.on("keydown", ".rm-tnote", function(e) { if (e.which === 13) { e.preventDefault(); card().find(".rm-tadd, .rm-tsave").first().click(); } });
			$d.on("click", ".rm-tremove", function() { if (state.sel && tStore()) { $(this).blur(); tStore().remove(state.sel).always(function() { paint(true); }); } });
			$d.on("click", ".rm-trow", function(e) {
				if ($(e.target).closest(".rm-t-btns").length) { return; }
				const id = Number($(this).attr("data-id")), sys = appData.systems[id];
				if (state.layout.byId[id]) { select(id); centreOnSystem(id, Math.max(1, state.t.k)); } else if (sys) { show(Number(sys.regionID), id); }
			});
			const moveTarget = function(el, dir) {
				const order = mapTargets.move(targetIDs(), Number($(el).closest(".rm-trow").attr("data-id")), dir);
				if (order) { tStore().reorder(order).always(function() { paint(true); }); }
			};
			$d.on("click", ".rm-tup", function(e) { e.preventDefault(); moveTarget(this, -1); });
			$d.on("click", ".rm-tdown", function(e) { e.preventDefault(); moveTarget(this, 1); });
			$d.on("click", ".rm-tdel", function(e) { e.preventDefault(); tStore().remove(Number($(this).closest(".rm-trow").attr("data-id"))).always(function() { paint(true); }); });
			$d.on("click", ".rm-tclear", function() {
				if (window.confirm("Remove all " + targetIDs().length + " targets for everyone on the mask?")) { tStore().clear().always(function() { paint(true); }); }
			});
			$d.on("click", ".rm-tsend", function() { tStore().sendWaypoints(targetIDs()); });
			$d.on("click", ".rm-tshort", function() { shortestOrder(); });
			let dragID = null;
			$d.on("dragstart", ".rm-trow", function(e) { dragID = Number($(this).attr("data-id")); if (e.originalEvent.dataTransfer) { e.originalEvent.dataTransfer.effectAllowed = "move"; e.originalEvent.dataTransfer.setData("text/plain", String(dragID)); } });
			$d.on("dragover", ".rm-trow", function(e) { if (dragID) { e.preventDefault(); $(this).addClass("rm-tdrop"); } });
			$d.on("dragleave", ".rm-trow", function() { $(this).removeClass("rm-tdrop"); });
			$d.on("drop", ".rm-trow", function(e) {
				e.preventDefault();
				$(this).removeClass("rm-tdrop");
				const order = dragID ? mapTargets.moveBefore(targetIDs(), dragID, Number($(this).attr("data-id"))) : null;
				dragID = null;
				if (order && order.join() !== targetIDs().join()) { tStore().reorder(order).always(function() { paint(true); }); }
			});
			$d.on("dragend", ".rm-trow", function() { dragID = null; });
			$d.on("wheel pointerdown", ".rm-side", function(e) { e.stopPropagation(); });

			// Card
			$d.on("click", ".rm-card-close", function() { select(null); });
			$d.on("click", ".rm-dest", function() { if (state.sel) { setDestination(state.sel); } });
			$d.on("click", ".rm-route-btn", function() { if (state.sel) { setRoute(state.sel); } });
			$d.on("click", ".rm-view", function() { if (state.sel) { viewSystem(state.sel); } });

			// Systems and stubs
			let moved = false;
			$d.on("click", ".rm-sys", function(e) {
				if (moved) { return; }
				e.stopPropagation();
				if (e.shiftKey && rm.settings(options).overlays.targets) { toggleTarget(Number($(this).attr("data-id"))); return; }
				select($(this).attr("data-id"));
			});
			$d.on("dblclick", ".rm-sys", function(e) { e.preventDefault(); viewSystem($(this).attr("data-id")); });
			$d.on("click", ".rm-stub", function() {
				if (moved) { return; }
				show(Number($(this).attr("data-region")), Number($(this).attr("data-system")));
			});
			$d.on("click", ".rm-sky[data-id]", function(e) { if (moved) { return; } e.stopPropagation(); select($(this).attr("data-id")); });
			$d.on("click", ".rm-svg", function(e) { if (!moved && !$(e.target).closest(".rm-sys, .rm-stub, .rm-sky").length) { select(null); } });

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
				state.t = rm.zoomAt(state.t, oe.clientX - rect.left, oe.clientY - rect.top, rm.wheelFactor(oe.deltaY, oe.deltaMode));
				applyTransform();
			});
		}

		function zoomBy(factor) {
			measure();
			state.t = rm.zoomAt(state.t, state.view.w / 2, state.view.h / 2, factor);
			applyTransform();
		}

		function buildDialog() {
			const toggles = [["exits", "Chain exits"], ["pilots", "Pilots"], ["fight", "Fight here"], ["route", "Route"], ["constellations", "Constellations"], ["skyhooks", "Skyhooks"], ["targets", "Targets"]];
			$("body").append(
				"<div id='" + DIALOG_ID + "' class='hidden'><div class='rm-wrap'>"
				+ "<div class='rm-bar'>"
				+ "<select class='rm-region' title='Region'></select> "
				+ "<input type='text' class='rm-goto' placeholder='Go to system or region' autocomplete='off' /> "
				+ "<span class='rm-toggles'>" + toggles.map(function(t) {
					return "<label><input type='checkbox' data-ov='" + t[0] + "' /> " + t[1] + "</label>";
				}).join("") + "<label title='Which systems a jump ship can reach in one jump'><input type='checkbox' data-jump /> Jump range</label></span> "
				+ "<select class='rm-heat' title='Last hour, from the data Tripwire already loads'>" + Object.keys(rm.HEAT).map(function(k) {
					return "<option value='" + k + "'>" + (k === "none" ? "Heat: off" : "Heat: " + rm.HEAT[k].label) + "</option>";
				}).join("") + "</select> "
				+ "<span class='rm-view-buttons'><button class='rm-zoom-out' title='Zoom out' aria-label='Zoom out'>&minus;</button><button class='rm-zoom-in' title='Zoom in' aria-label='Zoom in'>+</button><button class='rm-fit' title='Fit the whole region' aria-label='Fit the whole region'>Fit</button></span>"
				+ "</div>"
				+ "<div class='rm-jbar' style='display:none'>"
				+ "<select class='rm-jship' title='Ship'>" + rj.SHIPS.map(function(x) { return "<option value='" + x[0] + "'>" + x[1] + "</option>"; }).join("") + "</select> "
				+ "<select class='rm-jdc' title='Jump Drive Calibration level'>" + [5, 4, 3, 2, 1, 0].map(function(n) { return "<option value='" + n + "'>JDC " + rj.ROMAN[n] + "</option>"; }).join("") + "</select> "
				+ "<select class='rm-jorigin' title='Where the jump starts'></select> <span class='rm-jinfo'></span>"
				+ "</div>"
				+ "<div class='rm-sbar' style='display:none'><span class='rm-slabel'>\u2693 Skyhooks:</span> "
				+ "<select class='rm-swindow' title='Theft window'><option value='now'>Vulnerable now</option><option value='soon'>Opens within</option><option value='all'>All windows</option></select> "
				+ "<select class='rm-shours' title='Hours'>" + skyhooksPanel.SOON_HOURS_CHOICES.map(function(h) { return "<option value='" + h + "'>" + h + " h</option>"; }).join("") + "</select> "
				+ "<label title='Lava planets: Magmatic Gas'><input type='checkbox' data-sky='lava' /> Lava</label>"
				+ "<label title='Ice planets: Superionic Ice'><input type='checkbox' data-sky='ice' /> Ice</label>"
				+ "<label><input type='checkbox' data-sky='low' /> Low-sec</label>"
				+ "<label><input type='checkbox' data-sky='null' /> Null-sec</label> <span class='rm-sinfo'></span>"
				+ "</div>"
				+ "<div class='rm-stage'><svg class='rm-svg' xmlns='" + NS + "'></svg><div class='rm-side hidden'></div><div class='rm-card hidden'></div>"
				+ "<div class='rm-hint'>Drag to pan · wheel to zoom · click a system · Shift+click marks a target · double-click opens it in Tripwire · click a gate label to cross into that region</div></div>"
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
				id: "regionmap.jumps", title: "Region map jumps", group: "Navigation", icon: "follow",
				keywords: ["jump", "range", "black ops", "blops", "cyno", "bridge", "region map"],
				enabled: function() { return enabled() ? true : "Turned off in Settings > Routes & Navigation"; },
				args: [
					{ name: "system", label: "origin system", type: "system", default: function(ctx) { return rm.canOpen(appData.systems[ctx.viewingSystemID]) ? ctx.viewingSystemID : undefined; } },
					{ name: "ship", label: "ship", type: "choice", optional: true,
						choices: function() { return rj.SHIPS.map(function(x) { return { value: x[0], title: x[1], keys: rj.SHIP_KEYS[x[0]] || [] }; }); } }
				],
				run: function(args) {
					if (!rm.canOpen(appData.systems[args.system])) { throw new Error("Pick a k-space system"); }
					const problem = rj.noDrive(args.system, appData.systems[args.system]);
					if (problem) { throw new Error(problem); }
					openJumps(args.system, args.ship);
				}
			});
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
				section: "routes", order: 72, id: "regionMap-jumpShip", type: "select", key: "regionMap",
				label: "Region map jump ship:", choices: rj.SHIPS.map(function(x) { return [x[0], x[1]]; }),
				hint: "The ship the map's Jump range overlay starts with (Black Ops by default). The overlay's header changes it too.",
				get: function(o) { return rj.settings(o).ship; },
				set: function(o, ship) { o.regionMap = rm.withSetting(o, { jump: rj.withJump(o, { ship: ship }) }); }
			});
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
				rj = regionMapJumps;
				rs = typeof regionMapSkyhooks !== "undefined" ? regionMapSkyhooks : null;
				rm.openJumps = openJumps;
				rm.openSkyhooks = openSkyhooks;
				if (tStore()) {
					tStore().onChange(function() {
						const $d = $("#" + DIALOG_ID);
						if (state.layout && $d.hasClass("ui-dialog-content") && $d.dialog("isOpen")) { paint(false); }
					});
				}
				if (skyStore()) {
					skyStore().onChange(function() {
						const $d = $("#" + DIALOG_ID);
						if (state.layout && $d.hasClass("ui-dialog-content") && $d.dialog("isOpen")) { paint(true); }
					});
				}
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
