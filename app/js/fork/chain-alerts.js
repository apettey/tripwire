const chainAlerts = {
	// Fork-owned: in-app pop-ups (the pop-up dock, notifications.js) when the chain changes in a way that matters:
	//   newHole    - a new hole (or K162) is mapped into home or anywhere in the chain drawn on the map, by someone else;
	//   homeStatic - home's static reaches <1h or EOL (the fork's life states, life-states.js);
	//   capRange   - a newly mapped low-sec / null-sec exit is within one jump of your jump ship (the Jump planner's ship,
	//                JDC and low/null choices; the range engine jump-range.js) from your Get home start, or, without one,
	//                from another k-space exit of the chain.
	// "Home" is where the active chain tab starts (as the Watchlist and home region tags read it); "the chain" is what the
	// chain map draws. New means new since this page was loaded: holes on the map when the page loads, or when the mask or
	// chain tab changes, are taken as known (primed). One pop-up per hole (per hole and stage for the static); none for
	// holes you mapped yourself (either signature last changed by your character). The same events go to Discord as
	// types 10-11 (discord/chain_alerts.php), each off until a mask admin turns it on.
	// Settings: options.chainAlerts = {enabled, newHole, scope ("chain" | "home"), homeStatic, capRange} (missing = on, chain).
	// Pure logic first (tested), browser code at the bottom. Keep `const chainAlerts` on the first line (test helper).

	SCOPES: [["chain", "into home or the chain"], ["home", "into home only"]],
	NOTICE_MS: 20000,
	TICK_MS: 30000,				// the static's life is checked this often (its state moves on with time)
	STATIC_KEY: "tripwire.chainAlerts.static",	// static stages already shown (localStorage), so a reload doesn't repeat them
	STATIC_KEEP: 100,
	HOUR: 3600000,

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	// ---- Settings (pure) ----

	/** options.chainAlerts with the defaults: every alert on, new holes anywhere in the chain */
	settings: function(opts) {
		const raw = opts && opts.chainAlerts && typeof opts.chainAlerts === "object" ? opts.chainAlerts : {};
		const off = raw.enabled === false;
		return {
			newHole: !off && raw.newHole !== false,
			scope: raw.scope === "home" ? "home" : "chain",
			homeStatic: !off && raw.homeStatic !== false,
			capRange: !off && raw.capRange !== false
		};
	},

	anyOn: function(s) { return !!(s && (s.newHole || s.homeStatic || s.capRange)); },

	// ---- Chain data (pure) ----

	/** Holes of the mask: [{id, a, b, type, parent, life, sigA, sigB}] from tripwire.client wormholes and signatures (a hole
	missing a signature is skipped). a / b: the initial / secondary signature's system (a generic index when not known). */
	holes: function(wormholes, signatures) {
		const out = [];
		Object.keys(wormholes || {}).forEach(function(key) {
			const w = wormholes[key];
			const sigA = w && signatures ? signatures[w.initialID] : null;
			const sigB = w && signatures ? signatures[w.secondaryID] : null;
			if (!sigA || !sigB) { return; }
			out.push({ id: String(w.id !== undefined ? w.id : key), a: Number(sigA.systemID), b: Number(sigB.systemID), type: w.type, parent: w.parent,
				life: w.life, sigA: sigA, sigB: sigB });
		});
		return out;
	},

	/** {systemID: true} for every system the chain map drew (chain.nodes() result: rows with c[0].systemID) */
	chainSystems: function(result) {
		const out = {};
		const rows = result && result.map && Array.isArray(result.map.rows) ? result.map.rows : [];
		rows.forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (node && node.systemID !== undefined && node.systemID !== null && Number(node.systemID) > 0) { out[Number(node.systemID)] = true; }
		});
		return out;
	},

	/** The mask the holes' signatures belong to ("98000001.2"), "" when not known */
	maskOf: function(holes) {
		const h = (holes || [])[0];
		const m = h && h.sigA ? h.sigA.maskID : undefined;
		return m === undefined || m === null ? "" : String(Number(m));
	},

	/** A real system id (a sig whose far side isn't known holds an index into appData.genericSystemTypes) */
	isReal: function(systemID) { return Number(systemID) >= 30000000; },

	typeCode: function(type) {
		const t = String(type === undefined || type === null ? "" : type).trim().toUpperCase();
		return t === "????" ? "" : t;
	},

	/** The side ("a" / "b") the real type was scanned on */
	typedSide: function(hole) { return hole && hole.parent === "secondary" ? "b" : "a"; },

	/** Whether it is known which side the real type was scanned on (parent "initial" / "secondary") */
	sideKnown: function(hole) { return !!hole && (hole.parent === "initial" || hole.parent === "secondary"); },

	/** The type seen from a side: the real type where it was scanned, else K162; "" when not known (also when neither
	side's type is known: no parent, so neither side is the K162) */
	typeFrom: function(hole, side) {
		if (!chainAlerts.sideKnown(hole)) { return ""; }
		if (chainAlerts.typedSide(hole) !== side) { return "K162"; }
		return chainAlerts.typeCode(hole.type);
	},

	/** Whether you mapped the hole: either signature last changed by your character */
	mine: function(hole, meID) {
		if (!meID) { return false; }
		return [hole.sigA, hole.sigB].some(function(s) { return s && Number(s.modifiedByID) === Number(meID); });
	},

	/** The end a new hole's pop-up is about: the end in home, else (scope "chain") an end on the chain; null when neither */
	nearSide: function(hole, homeID, chain, scope) {
		if (homeID && Number(hole.a) === Number(homeID)) { return "a"; }
		if (homeID && Number(hole.b) === Number(homeID)) { return "b"; }
		if (scope === "home") { return null; }
		if (chain && chain[hole.a]) { return "a"; }
		if (chain && chain[hole.b]) { return "b"; }
		return null;
	},

	/**
	 * What is new since the last look. seen: {holeID: true} from the last call, or null when this context (mask, chain tab)
	 * hasn't been looked at yet: then everything is taken as known and nothing is new.
	 * @return {fresh: [holes not seen before], seen: {holeID: true} for every hole now}
	 */
	diff: function(seen, holes) {
		const next = {};
		const fresh = [];
		(holes || []).forEach(function(h) {
			next[h.id] = true;
			if (seen && !seen[h.id]) { fresh.push(h); }
		});
		return { fresh: fresh, seen: next };
	},

	EMPTY_MS: 10000,	// a mask seen without holes this long (and still active) counts as loaded and empty

	/** Whether every signature loaded belongs to the mask (none loaded: yes) */
	sigsOfMask: function(signatures, mask) {
		return Object.keys(signatures || {}).every(function(k) {
			const m = signatures[k] && signatures[k].maskID;
			return m === undefined || m === null || String(Number(m)) === String(Number(mask));
		});
	},

	/**
	 * The baseline for the first holes of a mask (mask: maskOf the holes): {} (nothing known, so its first hole alerts)
	 * when the mask was seen loaded without holes (empty: {mask, since} recorded while it was active and had no holes)
	 * for at least EMPTY_MS, the mask has been active since before that (activeSince) and this is still that mask; else
	 * null (prime: the holes are the old data or the mask's first load).
	 */
	baselineFor: function(mask, empty, now, activeSince) {
		if (!empty || String(empty.mask) !== String(mask)) { return null; }
		if (empty.since < activeSince || now - empty.since < chainAlerts.EMPTY_MS) { return null; }
		return {};
	},

	/** New-hole pop-ups: [{hole, near, home}] for fresh holes (not yours) in home or (scope "chain") on the chain */
	newHoleAlerts: function(fresh, ctx) {
		const out = [];
		(fresh || []).forEach(function(h) {
			if (chainAlerts.mine(h, ctx.meID)) { return; }
			const near = chainAlerts.nearSide(h, ctx.homeID, ctx.chain, ctx.scope);
			if (!near) { return; }
			out.push({ hole: h, near: near, home: !!ctx.homeID && Number(h[near]) === Number(ctx.homeID) });
		});
		return out;
	},

	/** The fork's life state of a hole: stable | lt4h | lt1h | expired (life-states.js; a simple version without it) */
	lifeState: function(hole, now) {
		if (typeof lifeStates !== "undefined" && lifeStates.deriveHole) {
			return lifeStates.deriveHole({ life: hole.life }, [hole.sigA, hole.sigB], now);
		}
		return hole.life === "critical" ? "lt4h" : "stable";
	},

	/** Time left on a hole (ms) or null (life-states.js) */
	remaining: function(hole, now) {
		return typeof lifeStates !== "undefined" && lifeStates.holeRemaining ? lifeStates.holeRemaining([hole.sigA, hole.sigB], now) : null;
	},

	/** Whether a hole is a static of home: its real type was scanned in home and is one of home's statics */
	isHomeStatic: function(hole, homeID, statics) {
		if (!homeID || !Array.isArray(statics) || !statics.length) { return false; }
		if (!chainAlerts.sideKnown(hole)) { return false; }
		const side = chainAlerts.typedSide(hole);
		const type = chainAlerts.typeCode(hole.type);
		return Number(hole[side]) === Number(homeID) && !!type && statics.map(function(s) { return String(s).toUpperCase(); }).indexOf(type) >= 0;
	},

	/**
	 * Home static pop-ups due now: [{key, hole, stage, remaining}] for holes of home whose static is <1h or EOL, each
	 * (hole, stage) once (key "holeID:stage" not in `shown`). Only the current stage.
	 */
	staticAlerts: function(holes, homeID, statics, now, shown) {
		const out = [];
		(holes || []).forEach(function(h) {
			if (!chainAlerts.isHomeStatic(h, homeID, statics)) { return; }
			const stage = chainAlerts.lifeState(h, now);
			if (stage !== "lt1h" && stage !== "expired") { return; }
			const key = h.id + ":" + stage;
			if (shown && shown[key]) { return; }
			out.push({ key: key, hole: h, stage: stage, remaining: chainAlerts.remaining(h, now) });
		});
		return out;
	},

	/** "about 40 minutes left" / "past its lifetime, it can collapse any time" */
	whenText: function(stage, remaining) {
		if (stage === "expired") { return "past its lifetime, it can collapse any time"; }
		const minutes = Math.max(1, Math.floor((Number(remaining) || 0) / 60000));	// floor: <1h never says "60 minutes"
		return "about " + minutes + " minute" + (minutes === 1 ? "" : "s") + " left";
	},

	/**
	 * Capital range candidates among fresh holes (not yours, on the chain): the hole's k-space end that a cyno can be lit
	 * in for the Jump planner's choices (low-sec / null-sec ticks). @param systems appData.systems; planner: jumpPlanner.settings()
	 * @return [{hole, exitID}]
	 */
	capCandidates: function(fresh, ctx, systems, planner) {
		const out = [];
		if (typeof jumpRange === "undefined") { return out; }
		(fresh || []).forEach(function(h) {
			if (chainAlerts.mine(h, ctx.meID)) { return; }
			["a", "b"].forEach(function(side) {
				const id = Number(h[side]);
				if (!chainAlerts.isReal(id) || !(ctx.chain && ctx.chain[id])) { return; }
				if (!jumpRange.isValidCynoTarget(id, systems[id], { lowsec: planner.lowsec, nullsec: planner.nullsec })) { return; }
				if (!out.some(function(c) { return c.exitID === id; })) { out.push({ hole: h, exitID: id }); }
			});
		});
		return out;
	},

	/**
	 * Where a jump ship would jump from: [{id, start}] - your Get home start (the Jump planner's origin) when one is set,
	 * else every other k-space system of the chain a jump drive works in (jumpRange.canJumpFrom: only the destination is
	 * restricted, no cyno in high-sec; a jump may start anywhere in k-space). Your start is your own pick and is used as it
	 * is. The fallback only uses high-sec exits for ships that can be in high-sec (HS_SHIPS: jump freighters and Black Ops
	 * battleships); other capitals can't enter it.
	 * @param shipKey the Jump planner's ship (jumpPlanner.settings().ship, e.g. "group-547" or a hull "group-902-12.5")
	 */
	capRefs: function(exitID, origin, chain, systems, shipKey) {
		if (typeof jumpRange === "undefined") { return []; }
		if (origin && jumpRange.canJumpFrom(origin, systems[origin])) { return Number(origin) === Number(exitID) ? [] : [{ id: Number(origin), start: true }]; }
		const hsOk = chainAlerts.HS_SHIPS.indexOf(String(shipKey || "").split("-").slice(0, 2).join("-")) >= 0;
		return Object.keys(chain || {}).map(Number).filter(function(id) {
			if (id === Number(exitID) || !chainAlerts.isReal(id) || !jumpRange.canJumpFrom(id, systems[id])) { return false; }
			return hsOk || jumpRange.kind(id, systems[id]) !== "hs";
		}).map(function(id) { return { id: id, start: false }; });
	},

	HS_SHIPS: ["group-902", "group-898"],	// Jump Freighter, Black Ops: the jump ships that can be in high-sec

	/** refs within rangeLy of the exit, nearest first: [{id, start, ly}]. pos: {systemID: {x, y, z}} (jumpRange.decode) */
	capHits: function(exitID, refs, pos, rangeLy) {
		const at = pos && pos[exitID];
		if (!at || !(rangeLy > 0)) { return []; }
		return (refs || []).map(function(r) {
			return { id: r.id, start: r.start, ly: jumpRange.distanceLy(at, pos[r.id]) };
		}).filter(function(r) { return isFinite(r.ly) && r.ly <= rangeLy; }).sort(function(x, y) { return x.ly - y.ly; });
	},

	// ---- Text (pure) ----

	/** "J152820 (C5)" for a system id; "an unknown system" (with its kind, e.g. "an unknown Class-5 system") when not known */
	systemText: function(systemID, systems, generic) {
		const id = Number(systemID);
		if (chainAlerts.isReal(id)) {
			const s = systems && systems[id];
			const kind = typeof systemAnalysis !== "undefined" && s ? systemAnalysis.analyse(id).systemTypeName : "";
			return (s ? s.name : String(id)) + (kind ? " (" + kind + ")" : "");
		}
		const g = Array.isArray(generic) ? generic[id] : null;
		return g && g !== "Unknown" ? "an unknown " + g + " system" : "an unknown system";
	},

	sigText: function(sig) {
		const s = String(sig && sig.signatureID || "").toUpperCase();
		return /^[A-Z]{3}\d{3}$/.test(s) ? s.slice(0, 3) + "-" + s.slice(3) : (s || "???");
	},

	/** {title, text} of a new-hole pop-up */
	holeText: function(alert, systems, generic) {
		const h = alert.hole, near = alert.near, far = near === "a" ? "b" : "a";
		const sig = near === "a" ? h.sigA : h.sigB;
		const type = chainAlerts.typeFrom(h, near);
		const by = (sig && sig.modifiedByName) || (near === "a" ? h.sigB : h.sigA).modifiedByName || "";
		return {
			title: alert.home ? "New hole in home" : "New hole in the chain",
			text: chainAlerts.sigText(sig) + (type ? " " + type : "") + " in " + chainAlerts.systemText(h[near], systems, generic)
				+ " to " + chainAlerts.systemText(h[far], systems, generic) + (by ? ", mapped by " + by : "")
		};
	},

	/** {title, text} of a home static pop-up */
	staticText: function(alert, systems, generic) {
		const h = alert.hole, side = chainAlerts.typedSide(h), far = side === "a" ? "b" : "a";
		const sig = side === "a" ? h.sigA : h.sigB;
		return {
			title: "Home static " + (alert.stage === "expired" ? "EOL" : "<1h"),
			text: chainAlerts.typeCode(h.type) + " (" + chainAlerts.sigText(sig) + ") to " + chainAlerts.systemText(h[far], systems, generic)
				+ ": " + chainAlerts.whenText(alert.stage, alert.remaining)
		};
	},

	/** {title, text} of a capital range pop-up. hits: capHits(); ship: "Carrier"; jdc 0-5; rangeLy */
	capText: function(exitID, hits, ship, jdc, rangeLy, systems) {
		const s = systems && systems[exitID];
		const name = function(id) { return systems && systems[id] ? systems[id].name : String(id); };
		const ly = function(v) { return typeof jumpRange !== "undefined" ? jumpRange.formatLy(v) : (Math.round(v * 10) / 10) + " LY"; };
		const sec = s ? (Number(s.security) > 0 && Number(s.security) < 0.05 ? "0.1" : (Math.round(Number(s.security) * 10) / 10).toFixed(1)) : "";
		const first = hits[0];
		const from = first.start ? "your start " + name(first.id) : name(first.id) + " (another exit of the chain)";
		const more = hits.length > 1 ? " and " + (hits.length - 1) + " more" : "";
		return {
			title: "Exit in jump range",
			text: name(exitID) + (sec ? " (" + sec + ")" : "") + " is " + ly(first.ly) + " from " + from + more + ": a " + ship
				+ " (JDC " + ["0", "I", "II", "III", "IV", "V"][Math.max(0, Math.min(5, Number(jdc) || 0))] + ", " + ly(rangeLy) + ") can jump there"
		};
	},

	/** The pop-up's HTML; title and text are plain text, systemID the system its link opens */
	noticeHtml: function(kind, title, text, systemID, systemName) {
		const esc = chainAlerts.escape;
		return "<div class='chain-alert chain-alert-" + esc(kind) + "'>"
			+ "<div class='chain-alert-title'>" + esc(title) + "</div>"
			+ "<div class='chain-alert-text'>" + esc(text) + "</div>"
			+ (systemName ? "<a href='.?system=" + encodeURIComponent(systemName) + "' class='chain-alert-open' data-system='" + esc(systemID) + "'>Show " + esc(systemName) + "</a>" : "")
			+ "</div>";
	},

	/** Keys to keep in storage: the last `max` */
	trim: function(shown, max) {
		const keys = Object.keys(shown || {});
		const out = {};
		keys.slice(Math.max(0, keys.length - max)).forEach(function(k) { out[k] = true; });
		return out;
	}
};

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined") {
	(function() {
		const ca = chainAlerts;
		let seen = null;			// {holeID: true} of the mask below, null until primed
		let context = null;			// the mask the holes belong to: another one primes again
		let lastChain = {};			// systems on the chain as last drawn
		let lastActive = null, activeSince = 0;	// options.masks.active and since when
		let empty = null;			// {mask, since}: the active mask seen loaded without holes
		let staticShown = loadStatic();
		let jumpData = null, jumpLoading = null, jumpFailedAt = 0;
		let pendingCap = [];		// capital range candidates waiting for the jump range data

		function opts() { return typeof options !== "undefined" ? options : null; }
		function current() { return ca.settings(opts()); }
		function systems() { return (typeof appData !== "undefined" && appData.systems) || {}; }
		function generic() { return (typeof appData !== "undefined" && appData.genericSystemTypes) || []; }
		function activeMask() { const o = opts(); return o && o.masks && o.masks.active ? String(Number(o.masks.active)) : ""; }
		function meID() { const o = opts(); return o && o.character ? o.character.id : null; }

		function homeID() {
			if (typeof homeRegion !== "undefined" && homeRegion.homeSystemID) { return homeRegion.homeSystemID(opts()); }
			return null;
		}

		function loadStatic() {
			try {
				const raw = JSON.parse(window.localStorage.getItem(ca.STATIC_KEY) || "{}");
				return raw && typeof raw === "object" ? raw : {};
			} catch (e) { return {}; }
		}
		function storeStatic() {
			staticShown = ca.trim(staticShown, ca.STATIC_KEEP);
			try { window.localStorage.setItem(ca.STATIC_KEY, JSON.stringify(staticShown)); } catch (e) { /* memory only */ }
		}

		function show(kind, t, systemID) {
			if (typeof jBox === "undefined") { return; }
			const name = systems()[systemID] ? systems()[systemID].name : "";
			new jBox("Notice", {
				content: ca.noticeHtml(kind, t.title, t.text, systemID, name), color: kind === "homeStatic" ? "yellow" : "blue",
				autoClose: ca.NOTICE_MS, closeOnClick: false, offset: { y: 35 }, animation: "flip", addClass: "chain-alert-notice"
			});
			if (typeof forkUsage !== "undefined") {
				if (kind === "newHole") { forkUsage.track("chainAlerts", "alert_hole"); }
				else if (kind === "homeStatic") { forkUsage.track("chainAlerts", "alert_static"); }
				else { forkUsage.track("chainAlerts", "alert_range"); }
			}
		}

		// ---- Capital range: the Jump planner's data (systems.json, ships.json), fetched on the first candidate ----

		function loadJumpData() {
			if (jumpData) { return $.Deferred().resolve(jumpData).promise(); }
			if (jumpLoading) { return jumpLoading; }
			if (Date.now() - jumpFailedAt < 60000 || typeof jumpRange === "undefined" || typeof jumpPlanner === "undefined") { return $.Deferred().reject().promise(); }
			const jp = jumpPlanner;
			jumpLoading = $.when(
				$.getJSON(jp.DATA_URL + "systems.json?v=" + jp.DATA_VERSION),
				$.getJSON(jp.DATA_URL + "ships.json?v=" + jp.DATA_VERSION + "." + jp.SHIPS_REV)
			).then(function(sys, ships) {
				jumpData = { pos: jumpRange.decode(sys[0]).pos, presets: jumpRange.presets(ships[0]) };
				jumpLoading = null;
				return jumpData;
			}, function() {
				jumpLoading = null;
				jumpFailedAt = Date.now();
				return $.Deferred().reject().promise();
			});
			return jumpLoading;
		}

		function checkCap(candidates) {
			pendingCap = pendingCap.concat(candidates);
			loadJumpData().done(function(data) {
				const list = pendingCap;
				pendingCap = [];
				const planner = jumpPlanner.settings(opts());
				if (!current().capRange || !planner.enabled) { return; }
				const r = jumpPlanner.range(planner, data.presets);
				if (!r.preset || !(r.range > 0)) { return; }
				list.forEach(function(c) {
					const hits = ca.capHits(c.exitID, ca.capRefs(c.exitID, planner.origin, lastChain, systems(), planner.ship), data.pos, r.range);
					if (hits.length) { show("capRange", ca.capText(c.exitID, hits, r.preset.label, planner.jdc, r.range, systems()), c.exitID); }
				});
			}).fail(function() { pendingCap = []; });
		}

		// ---- The look at the chain ----

		function evaluate(result) {
			const s = current();
			const client = (typeof tripwire !== "undefined" && tripwire.client) || {};
			const holes = ca.holes(client.wormholes, client.signatures);
			const before = lastChain;
			if (result) { lastChain = ca.chainSystems(result); }
			// Primed per mask of the data itself (not options.masks.active, which switches before the new mask's data
			// arrives): holes of another mask are all known. No holes: remember that the active mask was seen empty, so its
			// first hole alerts once that was long enough ago to be the mask's own data (baselineFor), not a load in progress.
			const active = activeMask();
			if (active !== lastActive) { lastActive = active; activeSince = Date.now(); }
			if (!holes.length) {
				if (active && (!empty || empty.mask !== active) && ca.sigsOfMask(client.signatures, active)) { empty = { mask: active, since: Date.now() }; }
				return;
			}
			const mask = ca.maskOf(holes);
			if (mask !== context) { context = mask; seen = ca.baselineFor(mask, empty, Date.now(), activeSince); }
			empty = null;
			const d = ca.diff(seen, holes);
			seen = d.seen;
			if (!ca.anyOn(s)) { return; }
			const home = homeID();
			const ctx = { homeID: home, chain: lastChain, scope: s.scope, meID: meID() };
			if (s.newHole) {
				ca.newHoleAlerts(d.fresh, ctx).forEach(function(a) {
					show("newHole", ca.holeText(a, systems(), generic()), a.hole[a.near]);
				});
			}
			if (s.capRange && typeof jumpPlanner !== "undefined" && jumpPlanner.settings(opts()).enabled) {
				// Only exits the chain didn't have before (a second hole into a system already on the chain is no news)
				const candidates = ca.capCandidates(d.fresh, ctx, systems(), jumpPlanner.settings(opts())).filter(function(c) { return !before[c.exitID]; });
				if (candidates.length) { checkCap(candidates); }
			}
			if (s.homeStatic) { checkStatic(holes, home); }
		}

		function checkStatic(holes, home) {
			const sys = home ? systems()[home] : null;
			const due = ca.staticAlerts(holes, home, sys && sys.statics, Date.now(), staticShown);
			if (!due.length) { return; }
			due.forEach(function(a) {
				staticShown[a.key] = true;
				show("homeStatic", ca.staticText(a, systems(), generic()), home);
			});
			storeStatic();
		}

		/** Every TICK_MS: the static's life moves on with time, without a chain change */
		function tick() {
			if (document.hidden || !current().homeStatic) { return; }
			const client = (typeof tripwire !== "undefined" && tripwire.client) || {};
			if (!client.wormholes) { return; }
			try { checkStatic(ca.holes(client.wormholes, client.signatures), homeID()); } catch (e) { console.error("Chain alerts: static check failed", e); }
		}

		// ---- Chain map hook (as the Watchlist's: only the outermost call of chain.nodes is looked at) ----
		let depth = 0, installed = false;	// (other features' wrappers don't all copy the flag below, so it is kept here too)
		function installHook() {
			if (installed || typeof chain === "undefined" || !chain || typeof chain.nodes !== "function" || chain.nodes.chainAlertsWrapped) { return; }
			installed = true;
			const original = chain.nodes;
			const wrapped = function() {
				depth++;
				try {
					const result = original.apply(this, arguments);
					if (depth === 1) {
						setTimeout(function() { try { evaluate(result); } catch (e) { console.error("Chain alerts: check failed", e); } }, 0);
					}
					return result;
				} finally { depth--; }
			};
			Object.keys(original).forEach(function(k) { wrapped[k] = original[k]; });
			wrapped.chainAlertsWrapped = true;
			chain.nodes = wrapped;
		}

		$(function() {
			installHook();
			setInterval(tick, ca.TICK_MS);
			$(document).on("click", ".chain-alert .chain-alert-open", function() {
				if (typeof forkUsage !== "undefined") { forkUsage.track("chainAlerts", "clicked"); }
			});

			if (typeof forkSettings !== "undefined") {
				// Settings > Kills & Intel, next to the Watchlist's and the timers' pop-ups; takes effect on Save, Reset deletes the key
				forkSettings.register({
					section: "intel", order: 55, id: "chainAlerts", type: "custom", key: "chainAlerts", label: "Chain alerts:",
					keywords: "pop-up notification new hole k162 static eol capital jump range exit",
					html: "<label><input type='checkbox' id='chainAlerts-newHole' /> Pop-up for a new hole mapped by someone else</label> "
						+ "<select id='chainAlerts-scope'>" + ca.SCOPES.map(function(x) { return "<option value='" + x[0] + "'>" + ca.escape(x[1]) + "</option>"; }).join("") + "</select><br/>"
						+ "<label><input type='checkbox' id='chainAlerts-homeStatic' /> Pop-up when the home static is &lt;1h or EOL</label><br/>"
						+ "<label><input type='checkbox' id='chainAlerts-capRange' /> Pop-up when a new low/null-sec exit is in range of the Jump planner's ship</label>",
					load: function(o) {
						const s = ca.settings(o);
						$("#chainAlerts-newHole").prop("checked", s.newHole);
						$("#chainAlerts-scope").val(s.scope);
						$("#chainAlerts-homeStatic").prop("checked", s.homeStatic);
						$("#chainAlerts-capRange").prop("checked", s.capRange);
					},
					save: function(o) {
						const s = {
							newHole: $("#chainAlerts-newHole").prop("checked"),
							scope: $("#chainAlerts-scope").val() === "home" ? "home" : "chain",
							homeStatic: $("#chainAlerts-homeStatic").prop("checked"),
							capRange: $("#chainAlerts-capRange").prop("checked")
						};
						o.chainAlerts = Object.assign({ enabled: ca.anyOn(s) }, s);
					}
				});
			}

			// Tip: the capital range alert is only useful in some situations (a low/null exit appears), so it is easy to miss
			if (typeof forkHints !== "undefined") {
				forkHints.register({
					id: "chainAlerts.capRange", feature: "chainAlerts", section: "intel",
					trigger: "chain.exit", kind: "toast",
					eligible: function(ctx, data) {
						if (!ca.settings(ctx.options).capRange || typeof jumpPlanner === "undefined" || !jumpPlanner.enabled(ctx.options) || !data || !Array.isArray(data.systemIDs) || typeof jumpRange === "undefined") { return false; }
						return data.systemIDs.some(function(id) { return jumpRange.isValidCynoTarget(id, systems()[id], {}); });
					},
					title: "Exits in jump range",
					body: "When a new low-sec or null-sec exit is within one jump of the Jump planner's ship (from your Get home start, or "
						+ "another exit of the chain), you get a pop-up. Set the ship and JDC in the Jump planner; switch it off in "
						+ "Settings > Kills & Intel > Chain alerts.\n\nTurn tips off in Settings > General.",
					priority: 60, maxShows: 1, cooldownHours: 72, ttlSeconds: 600
				});
			}
		});
		// Hook before the first draw too (chain-map.js runs before the fork files' ready handlers)
		installHook();
	})();
}
