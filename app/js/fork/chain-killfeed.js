const chainKillFeed = {
	// Chain Kill Feed (fork-owned): a layout panel with one feed of the recent kills in every wormhole, low-sec and
	// null-sec system on the current chain map. Reads public/system_kills.php (the pooled zKillboard integration in
	// zkill/); the browser itself only loads images from images.evetech.net and links to zkillboard.com.
	// Rows are drawn by the System Kill Feed's renderer (systemKillFeed.rowHtml, app/js/fork/system-killfeed.js).
	// Settings: options.chainKillFeed.enabled (missing = on); docked / popped out / small view / minimized: app/js/fork/panel-modes.js. Keep `const chainKillFeed` on the first line:
	// the test helper strips it to define a global.
	URL: "system_kills.php",
	WIDGET_ID: "chainKillFeedWidget",
	WINDOW_SECONDS: 3600,	// history asked for when a system joins the chain (and kept in the live window)
	JOIN_LIMIT: 20,	// kills per window request for joining systems (the feed then grows with live kills)
	PAGE_LIMIT: 50,	// server maximum per request
	MAX_KILLS: 50,	// kills kept in memory (newest by kill time)
	MAX_AGE_MS: 6 * 3600000,	// kills older than this leave the feed
	MAX_SYSTEMS: 200,	// systems per request (server maximum)
	MAX_PAGES: 5,	// full pages followed per chunk and poll (a full page moves the cursor to its last kill)
	POLL_MS: 20000,
	FAST_POLL_MS: 4000,	// while back-fills or names are pending
	MAX_FAST_POLLS: 45,
	RETRY_MS: 30000,
	REQUEUE_MS: 30 * 60000,	// a system that left the chain longer ago than this gets a new back-fill when it returns
	MAX_HANDLED: 1000,	// systems remembered as handled this session
	FRESH_MS: 15 * 60000,	// a live kill younger than this is highlighted when it arrives
	HIGHLIGHT_MS: 8000,
	MAX_KSPACE_CHAIN: 10,	// k-space systems per join that get chain (high) back-fill priority
	STALE_MS: 10 * 60000,	// after a pause this long (hidden tab), start from a fresh window read instead of the old cursor
	SETTLE_MS: 90000,	// after joining or finishing a back-fill, a system's kills are history, not news, for this long
	SETTLE_ROUNDS: 3,	// ... and this many more live rounds (back-fill stragglers beyond a round's pages)
	CHAIN_DEBOUNCE_MS: 400,
	TICK_MS: 30000,
	SIZE: { x: 7, y: 6, minX: 4, minY: 3 },
	KIND_NAMES: { wh: "J-space", ls: "low-sec", ns: "null-sec" },

	/** Whether the panel is switched on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.chainKillFeed && opts.chainKillFeed.enabled === false);
	},

	/**
	 * 'wh' (J-space incl. Thera, shattered, drifter), 'ls', 'ns' (incl. Pochven), 'hs' or null, with the same thresholds
	 * as systemAnalysis (security >= 0.45 is high-sec).
	 * @param info {class, factionID, baseSecurity|security}, e.g. systemAnalysis.analyse(systemID)
	 */
	systemKind: function(info) {
		if (!info) { return null; }
		if (Array.isArray(info.class) ? info.class.length : info.class) { return "wh"; }
		if (Number(info.factionID) === 500026) { return "ns"; }
		const raw = info.baseSecurity !== undefined && info.baseSecurity !== null ? info.baseSecurity : info.security;
		if (raw === undefined || raw === null || raw === "") { return null; }
		const sec = Number(raw);
		if (!isFinite(sec)) { return null; }
		return sec >= 0.45 ? "hs" : sec > 0 ? "ls" : "ns";
	},

	/** Whether the feed covers systems of this kind (everything but high-sec) */
	coveredKind: function(kind) {
		return kind === "wh" || kind === "ls" || kind === "ns";
	},

	isRealSystemID: function(id) {
		const n = Number(id);
		return Number.isInteger(n) && n >= 30000000 && n < 32000000;
	},

	/** Whether a chain row is a calculated gate-route node or a synthetic node added by another feature */
	isExtraNode: function(row, node) {
		const id = String(node.v);
		const html = typeof node.f === "string" ? node.f : "";
		if (row.destination || id.indexOf("dest-") === 0 || html.indexOf("destination-node") >= 0 ||
			/id=['"](node)?dest-/.test(html)) { return true; }
		if (/class=['"][^'"]*\bcalc\b/.test(html)) { return true; }
		const last = Array.isArray(row.pathHome) && row.pathHome.length ? row.pathHome[row.pathHome.length - 1] : null;
		return !!(last && last.path);
	},

	/** Short label of the hole leading to a chain row's system: its name, else the first 3 letters of the signature.
	 *  Same as killReporting.holeLabel (kill-reporting.js): keep the two identical. */
	holeLabel: function(row) {
		const last = row && Array.isArray(row.pathHome) && row.pathHome.length ? row.pathHome[row.pathHome.length - 1] : null;
		if (!last) { return ""; }
		if (last.name) { return String(last.name).substring(0, 24); }
		return last.signatureID ? String(last.signatureID).substring(0, 3).toUpperCase() : "";
	},

	/**
	 * The chain map's systems the feed covers, in map order: [{systemID, label, kind}], each system once.
	 * @param rows chain rows (chain.data.map.rows)
	 * @param kindOf systemID => 'wh'|'ls'|'ns'|'hs'|null
	 */
	chainSystems: function(rows, kindOf) {
		const seen = {};
		const result = [];
		(Array.isArray(rows) ? rows : []).forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || typeof node !== "object" || chainKillFeed.isExtraNode(row, node)) { return; }
			const id = Number(node.systemID);
			if (!chainKillFeed.isRealSystemID(id) || seen[id]) { return; }
			seen[id] = true;
			const kind = kindOf(id);
			if (chainKillFeed.coveredKind(kind)) {
				result.push({ systemID: id, label: chainKillFeed.holeLabel(row), kind: kind });
			}
		});
		return result;
	},

	/** {added, removed} system IDs between two ID lists */
	diffSystems: function(before, after) {
		const was = {}, is = {};
		(before || []).forEach(function(id) { was[id] = true; });
		(after || []).forEach(function(id) { is[id] = true; });
		return {
			added: (after || []).filter(function(id) { return !was[id]; }),
			removed: (before || []).filter(function(id) { return !is[id]; })
		};
	},

	chunk: function(list, size) {
		const chunks = [];
		for (let i = 0; i < list.length; i += size) { chunks.push(list.slice(i, i + size)); }
		return chunks;
	},

	killTime: function(kill) {
		const t = Date.parse(kill && kill.killTime);
		return isFinite(t) ? t : 0;
	},

	/** Newest kill time first, then the higher kill ID */
	compareKills: function(a, b) {
		return chainKillFeed.killTime(b) - chainKillFeed.killTime(a) || (Number(b.killID) || 0) - (Number(a.killID) || 0);
	},

	/**
	 * Merge kills into the feed: deduplicated by killID (the newer copy wins), only systems in `systems`, not older than
	 * maxAgeMs, newest first by kill time (never by arrival: back-fills and late uploads arrive with old kill times),
	 * at most `max`.
	 * @param options {systems: {systemID: true}, nowMs, max, maxAgeMs}
	 * @return {kills, added: [killID] that were not in the feed before and are now}
	 */
	merge: function(current, incoming, options) {
		const opts = options || {};
		const max = opts.max || chainKillFeed.MAX_KILLS;
		const oldest = isFinite(opts.nowMs) && opts.maxAgeMs ? opts.nowMs - opts.maxAgeMs : -Infinity;
		const keep = function(k) {
			return k && Number(k.killID) > 0 && (!opts.systems || opts.systems[k.systemID]) && chainKillFeed.killTime(k) >= oldest;
		};
		const byID = {};
		const before = {};
		(current || []).forEach(function(k) { if (k && k.killID) { before[k.killID] = true; } if (keep(k)) { byID[k.killID] = k; } });
		(Array.isArray(incoming) ? incoming : []).forEach(function(k) { if (keep(k)) { byID[k.killID] = k; } });
		const kills = Object.keys(byID).map(function(id) { return byID[id]; }).sort(chainKillFeed.compareKills).slice(0, max);
		return { kills: kills, added: kills.filter(function(k) { return !before[k.killID]; }).map(function(k) { return k.killID; }) };
	},

	/** IDs referenced by kills (victim and final blow: characters, corporations, alliances, ships) */
	referencedIDs: function(kills) {
		const ids = {};
		(kills || []).forEach(function(k) {
			[k.victim, k.finalBlow].forEach(function(side) {
				if (!side) { return; }
				["characterID", "corporationID", "allianceID", "shipTypeID"].forEach(function(f) {
					if (side[f]) { ids[side[f]] = true; }
				});
			});
		});
		return ids;
	},

	/** Name cache reduced to what the kills reference, plus new names (bounded by the kills) */
	mergeNames: function(names, incoming, kills) {
		const used = chainKillFeed.referencedIDs(kills);
		const result = {};
		[names || {}, incoming || {}].forEach(function(source) {
			Object.keys(source).forEach(function(id) { if (used[id]) { result[id] = source[id]; } });
		});
		return result;
	},

	/** Next shared since-cursor: the lowest cursor of the chunks answered (kills seen twice are deduplicated) */
	nextCursor: function(cursors) {
		const valid = (cursors || []).map(Number).filter(function(c) { return isFinite(c) && c >= 0; });
		return valid.length ? Math.min.apply(null, valid) : null;
	},

	/**
	 * Back-fill priority for systems that join together: wormhole systems and the first `maxKspace` k-space systems
	 * (map order) as 'chain'; the rest as 'panel', so a big k-space chain doesn't queue ahead of everyone's System panel.
	 * @param ids system IDs in map order; @param kindOf systemID => 'wh'|'ls'|'ns'|...
	 * @return {chain: [ids], panel: [ids]}
	 */
	backfillSources: function(ids, kindOf, maxKspace) {
		const result = { chain: [], panel: [] };
		let kspace = 0;
		(ids || []).forEach(function(id) {
			if (kindOf(id) === "wh") { result.chain.push(id); }
			else if (kspace < maxKspace) { kspace++; result.chain.push(id); }
			else { result.panel.push(id); }
		});
		return result;
	},

	/**
	 * Whether a request step brings live kills (highlighted when new): since polls and the window re-reads that replace
	 * them while names resolve; not the window reads for joining systems or a refill (history)
	 */
	isLiveStep: function(step) {
		return !!step && (step.kind === "since" || !!step.refresh);
	},

	/** After systems left: re-read the others only if their kills were dropped and the feed is now short */
	needsRefill: function(countBefore, countAfter, target) {
		return countAfter < countBefore && countAfter < target;
	},

	/** Whether a system joining the chain should ask the server for a back-fill (queue=1) */
	needsBackfill: function(handled, systemID, nowMs) {
		const h = handled[systemID];
		return !h || (h.leftAt !== null && nowMs - h.leftAt > chainKillFeed.REQUEUE_MS);
	},

	/** Forget systems that left long ago (they get a new back-fill anyway) and keep at most `max` entries */
	pruneHandled: function(handled, nowMs, max) {
		const result = {};
		const gone = [];
		Object.keys(handled).forEach(function(id) {
			const h = handled[id];
			if (h.leftAt === null) { result[id] = h; }
			else if (nowMs - h.leftAt <= chainKillFeed.REQUEUE_MS) { gone.push(id); }
		});
		gone.sort(function(a, b) { return handled[b].leftAt - handled[a].leftAt; });
		gone.slice(0, Math.max(0, max - Object.keys(result).length)).forEach(function(id) { result[id] = handled[id]; });
		return result;
	},

	/** Keep only the entries whose key is a killID in kills (and not expired) */
	pruneFresh: function(fresh, kills, nowMs) {
		const result = {};
		(kills || []).forEach(function(k) { if (fresh[k.killID] > nowMs) { result[k.killID] = fresh[k.killID]; } });
		return result;
	},

	/** animation-delay (ms, <= 0) that resumes a highlight ending at `until` (the CSS animation lasts HIGHLIGHT_MS) */
	highlightDelay: function(until, nowMs) {
		const elapsed = chainKillFeed.HIGHLIGHT_MS - ((Number(until) || 0) - nowMs);
		return -Math.max(0, Math.min(chainKillFeed.HIGHLIGHT_MS, Math.round(elapsed)));
	},

	/** A settle period: at least SETTLE_MS and SETTLE_ROUNDS more live rounds (timers of a hidden tab are throttled) */
	settle: function(nowMs) {
		return { until: nowMs + chainKillFeed.SETTLE_MS, rounds: chainKillFeed.SETTLE_ROUNDS };
	},

	/** Settle periods still running; with `roundDone`, one live round is counted first */
	pruneSettling: function(map, nowMs, roundDone) {
		const result = {};
		Object.keys(map || {}).forEach(function(k) {
			const s = { until: map[k].until, rounds: map[k].rounds - (roundDone ? 1 : 0) };
			if (s.until > nowMs || s.rounds > 0) { result[k] = s; }
		});
		return result;
	},

	/** Kill IDs among `added` to highlight: recent kill time, from a system that is not loading history */
	freshKills: function(kills, added, pending, nowMs) {
		const isAdded = {};
		(added || []).forEach(function(id) { isAdded[id] = true; });
		return (kills || []).filter(function(k) {
			return isAdded[k.killID] && !pending[k.systemID] && chainKillFeed.killTime(k) >= nowMs - chainKillFeed.FRESH_MS;
		}).map(function(k) { return k.killID; });
	},

	/** Header/body state: 'nosystems' | 'disabled' | 'loading' | 'empty' | 'list' */
	viewState: function(systemCount, killCount, loading, feed) {
		if (!systemCount) { return "nosystems"; }
		if (killCount) { return "list"; }
		if (feed && feed.enabled === false) { return "disabled"; }
		return loading ? "loading" : "empty";
	},

	/** "System (C5, via Ama)" style tooltip lines for a row's system */
	systemTooltip: function(name, typeName, security, label) {
		const sec = isFinite(Number(security)) && security !== null && security !== "" ? " " + Number(security).toFixed(1) : "";
		return [name + " (" + typeName + (typeName === "LS" || typeName === "NS" || typeName === "HS" ? sec : "") + ")",
			label ? "Hole: " + label : "", "Click to view the system"];
	},

	// ---- Browser-only code below (not run under mocha) ----

	ids: [],	// covered chain systems, map order
	info: {},	// systemID => {label, kind}
	kills: [],
	names: {},
	namesPending: false,
	cursor: null,
	pending: {},	// systemID => true while its back-fill is under way
	handled: {},	// systemID => {leftAt: null|ms}
	joining: {},	// systemID => queue (bool): window request still to make
	fresh: {},	// killID => highlight until (ms)
	settling: {},	// systemID => no highlights until (ms)
	lastLive: 0,	// when the last live answer arrived (ms)
	feed: null,
	error: "",
	generation: 0,	// bumped on stop: answers of older requests are ignored
	busy: false,
	pollTimer: null,
	chainTimer: null,
	tickTimer: null,
	fastPolls: 0,
	missed: false,
	observer: null,
	xhr: null,

	isOn: function() {
		return chainKillFeed.enabled(typeof options !== "undefined" ? options : undefined);
	},

	$widget: function() {
		return $("#" + chainKillFeed.WIDGET_ID);
	},

	kindOf: function(systemID) {
		if (typeof systemAnalysis === "undefined" || !tripwire.systems || !tripwire.systems[systemID]) { return null; }
		return chainKillFeed.systemKind(systemAnalysis.analyse(systemID));
	},

	/** The panel's element (a layout panel, or a window when popped out: panel-modes.js; see systemKillFeed.widgetHtml) */
	widgetHtml: function() {
		return "<li id='" + chainKillFeed.WIDGET_ID + "' class='gridWidget skf-panel'>"
			+ "<div class='controls'>"
			+ "<span class='ckf-title ph-heading'>Chain kills</span>"
			+ "<div style='float: right;'>"
			+ "<span class='ckf-loading hidden'></span>"
			+ "<span class='ckf-status'></span>"
			+ "</div>"
			+ "</div>"
			+ "<div class='content'><div class='ckf-body'></div></div>"
			+ "</li>";
	},

	/** The panel as panelHost (panel-host.js) and panelModes take it */
	panel: function() {
		return { id: chainKillFeed.WIDGET_ID, title: "Chain kills", key: "chainKillFeed", size: chainKillFeed.SIZE, small: true };
	},

	/** Handlers on the panel's content (systemKillFeed.setupPanel) */
	setupContent: function(content) {
		// System name: view that system instead of opening the kill
		content.addEventListener("click", function(e) {
			const sys = e.target && e.target.closest ? e.target.closest(".ckf-sys[data-system]") : null;
			if (!sys) { return; }
			e.preventDefault();
			e.stopPropagation();
			tripwire.systemChange(parseInt(sys.getAttribute("data-system"), 10));
		});
	},

	addWidget: function() {
		if (chainKillFeed.$widget().length) { return; }
		const $w = panelHost.addGridWidget(chainKillFeed.panel(), chainKillFeed.widgetHtml(), { fadeIn: true });
		if (!$w) { return; }
		systemKillFeed.setupPanel(chainKillFeed, $w);
		clearInterval(chainKillFeed.tickTimer);
		chainKillFeed.tickTimer = setInterval(chainKillFeed.tick, chainKillFeed.TICK_MS);
		chainKillFeed.render();
		chainKillFeed.chainChanged(0);
	},

	removeWidget: function() {
		chainKillFeed.stop();
		clearInterval(chainKillFeed.tickTimer);
		chainKillFeed.tickTimer = null;
		systemKillFeed.dropPanel(chainKillFeed, chainKillFeed.$widget());
	},

	sync: function() {
		if (chainKillFeed.isOn()) { chainKillFeed.addWidget(); } else { chainKillFeed.removeWidget(); }
	},

	/** Stop all requests and timers and forget the feed (the panel is off) */
	stop: function() {
		chainKillFeed.generation++;
		clearTimeout(chainKillFeed.pollTimer);
		clearTimeout(chainKillFeed.chainTimer);
		chainKillFeed.pollTimer = chainKillFeed.chainTimer = null;
		if (chainKillFeed.xhr) { chainKillFeed.xhr.abort(); chainKillFeed.xhr = null; }
		chainKillFeed.busy = false;
		chainKillFeed.ids = [];
		chainKillFeed.info = {};
		chainKillFeed.kills = [];
		chainKillFeed.names = {};
		chainKillFeed.cursor = null;
		chainKillFeed.pending = {};
		chainKillFeed.joining = {};
		chainKillFeed.fresh = {};
		chainKillFeed.settling = {};
		chainKillFeed.lastLive = 0;
		chainKillFeed.feed = null;
		chainKillFeed.error = "";
		// `handled` survives: turning the panel off and on again shouldn't queue every back-fill again
	},

	/** The chain map was redrawn: work out which systems joined or left (debounced) */
	chainChanged: function(delay) {
		if (!chainKillFeed.$widget().length) { return; }
		clearTimeout(chainKillFeed.chainTimer);
		chainKillFeed.chainTimer = setTimeout(chainKillFeed.updateSystems, delay === undefined ? chainKillFeed.CHAIN_DEBOUNCE_MS : delay);
	},

	updateSystems: function() {
		chainKillFeed.chainTimer = null;
		if (!chainKillFeed.$widget().length || !chainKillFeed.isOn()) { return; }
		const rows = typeof chain !== "undefined" && chain && chain.data && chain.data.map ? chain.data.map.rows : [];
		const systems = chainKillFeed.chainSystems(rows, chainKillFeed.kindOf);
		const now = Date.now();
		const ids = systems.map(function(s) { return s.systemID; });
		const diff = chainKillFeed.diffSystems(chainKillFeed.ids, ids);
		const info = {};
		systems.forEach(function(s) { info[s.systemID] = { label: s.label, kind: s.kind }; });
		const labelsChanged = ids.some(function(id) { return !chainKillFeed.info[id] || chainKillFeed.info[id].label !== info[id].label; });
		chainKillFeed.ids = ids;
		chainKillFeed.info = info;
		diff.removed.forEach(function(id) {
			if (chainKillFeed.handled[id]) { chainKillFeed.handled[id].leftAt = now; }
			delete chainKillFeed.pending[id];
			delete chainKillFeed.joining[id];
		});
		diff.added.forEach(function(id) {
			chainKillFeed.joining[id] = chainKillFeed.needsBackfill(chainKillFeed.handled, id, now);
			chainKillFeed.handled[id] = { leftAt: null };
			chainKillFeed.settling[id] = chainKillFeed.settle(now);
		});
		chainKillFeed.handled = chainKillFeed.pruneHandled(chainKillFeed.handled, now, chainKillFeed.MAX_HANDLED);
		let refill = false;
		if (diff.removed.length) {
			const before = chainKillFeed.kills.length;
			chainKillFeed.mergeKills([], false);
			// A busy system that left may have taken most of the feed: read the others' last hour again (no back-fill)
			if (chainKillFeed.needsRefill(before, chainKillFeed.kills.length, chainKillFeed.JOIN_LIMIT) && chainKillFeed.cursor !== null) {
				ids.forEach(function(id) { if (!(id in chainKillFeed.joining)) { chainKillFeed.joining[id] = false; } });
				refill = ids.length > 0;
			}
		}
		if (diff.added.length || diff.removed.length || labelsChanged) { chainKillFeed.render(); }
		if (diff.added.length || refill) { chainKillFeed.run(); }
	},

	/** Apply kills and names of an answer to the feed */
	mergeKills: function(kills, live, names) {
		const now = Date.now();
		const allowed = {};
		chainKillFeed.ids.forEach(function(id) { allowed[id] = true; });
		const merged = chainKillFeed.merge(chainKillFeed.kills, kills, { systems: allowed, nowMs: now, max: chainKillFeed.MAX_KILLS, maxAgeMs: chainKillFeed.MAX_AGE_MS });
		if (live) {
			chainKillFeed.settling = chainKillFeed.pruneSettling(chainKillFeed.settling, now, false);
			const quiet = Object.assign({}, chainKillFeed.pending, chainKillFeed.settling);
			chainKillFeed.freshKills(merged.kills, merged.added, quiet, now).forEach(function(id) {
				chainKillFeed.fresh[id] = now + chainKillFeed.HIGHLIGHT_MS;
			});
		}
		chainKillFeed.kills = merged.kills;
		chainKillFeed.names = chainKillFeed.mergeNames(chainKillFeed.names, names, merged.kills);
		chainKillFeed.fresh = chainKillFeed.pruneFresh(chainKillFeed.fresh, merged.kills, now);
		return merged.added.length > 0;
	},

	/** Apply the per-system and feed status of an answer */
	applyStatus: function(response) {
		chainKillFeed.feed = response.feed || chainKillFeed.feed;
		(response.systems || []).forEach(function(s) {
			if (!chainKillFeed.info[s.systemID]) { return; }
			if (s.pending) {
				chainKillFeed.pending[s.systemID] = true;
			} else if (chainKillFeed.pending[s.systemID]) {
				delete chainKillFeed.pending[s.systemID];
				// Stragglers of the back-fill (later pages) are not highlighted either
				chainKillFeed.settling[s.systemID] = chainKillFeed.settle(Date.now());
			}
		});
	},

	get: function(params) {
		const xhr = $.ajax({ url: chainKillFeed.URL, type: "GET", data: params, dataType: "JSON", cache: false, timeout: 15000 });
		chainKillFeed.xhr = xhr;
		return xhr;
	},

	/**
	 * One round of work: window requests for joining systems, then the live since-poll (or a window refresh while
	 * names are pending). Requests run one after another; at most one round at a time.
	 */
	run: function() {
		if (chainKillFeed.busy || !chainKillFeed.$widget().length || !chainKillFeed.isOn()) { return; }
		clearTimeout(chainKillFeed.pollTimer);
		chainKillFeed.pollTimer = null;
		const generation = chainKillFeed.generation;
		const steps = [];
		// Joining systems: their history (kills the stream stored before our cursor never come back via since)
		const joining = Object.keys(chainKillFeed.joining).map(Number).filter(function(id) { return chainKillFeed.info[id]; });
		const inMapOrder = chainKillFeed.ids.filter(function(id) { return chainKillFeed.joining[id] === true; });
		const sources = chainKillFeed.backfillSources(inMapOrder, function(id) { return chainKillFeed.info[id] ? chainKillFeed.info[id].kind : null; },
			chainKillFeed.MAX_KSPACE_CHAIN);
		const groups = [
			{ ids: sources.chain, queue: true, source: "chain" },
			{ ids: sources.panel, queue: true, source: "panel" },
			{ ids: joining.filter(function(id) { return chainKillFeed.joining[id] === false; }), queue: false, source: "chain" }
		];
		groups.forEach(function(group) {
			chainKillFeed.chunk(group.ids, chainKillFeed.MAX_SYSTEMS).forEach(function(ids) {
				steps.push({ kind: "window", ids: ids, queue: group.queue, source: group.source, limit: chainKillFeed.JOIN_LIMIT });
			});
		});
		joining.forEach(function(id) { delete chainKillFeed.joining[id]; });
		const live = !joining.length || chainKillFeed.cursor !== null;
		if (!joining.length && document.hidden) { chainKillFeed.missed = true; return; }	// resumes on visibilitychange
		chainKillFeed.missed = false;
		// Back after a long pause (hidden tab): a fresh window read instead of paging through everything stored since
		if (chainKillFeed.cursor !== null && chainKillFeed.lastLive && Date.now() - chainKillFeed.lastLive > chainKillFeed.STALE_MS) {
			chainKillFeed.cursor = null;
		}
		if (live && chainKillFeed.ids.length) {
			// While names resolve, re-read the window instead (since answers don't repeat kills); not forever if they never do
			const refreshNames = chainKillFeed.cursor === null || chainKillFeed.namesPending && chainKillFeed.fastPolls < chainKillFeed.MAX_FAST_POLLS;
			// as many as the feed holds (names of all of them), without growing it
			const refreshLimit = Math.min(chainKillFeed.PAGE_LIMIT, Math.max(chainKillFeed.JOIN_LIMIT, chainKillFeed.kills.length));
			chainKillFeed.chunk(chainKillFeed.ids.slice(), chainKillFeed.MAX_SYSTEMS).forEach(function(ids) {
				steps.push(refreshNames ? { kind: "window", ids: ids, queue: false, limit: refreshLimit, refresh: true }
					: { kind: "since", ids: ids });
			});
		}
		if (!steps.length) { chainKillFeed.schedule(); return; }
		chainKillFeed.busy = true;
		const cursors = [];
		let namesPending = false;
		let changed = false;
		let failed = null;
		const finish = function() {
			if (generation !== chainKillFeed.generation) { return; }
			chainKillFeed.busy = false;
			chainKillFeed.xhr = null;
			const cursor = chainKillFeed.nextCursor(cursors);
			if (cursor !== null) { chainKillFeed.cursor = cursor; }
			if (!failed) { chainKillFeed.namesPending = namesPending; }
			chainKillFeed.settling = chainKillFeed.pruneSettling(chainKillFeed.settling, Date.now(), !failed && steps.some(chainKillFeed.isLiveStep));
			chainKillFeed.error = failed ? "Could not load kills" + (failed.status ? " (HTTP " + failed.status + ")" : "") + ", retrying…" : "";
			chainKillFeed.render();
			if (!failed && Object.keys(chainKillFeed.joining).length) { chainKillFeed.run(); return; }	// joined meanwhile
			chainKillFeed.schedule(failed ? chainKillFeed.RETRY_MS : undefined);
		};
		const next = function(i, since, page) {
			if (generation !== chainKillFeed.generation) { return; }
			if (i >= steps.length) { finish(); return; }
			const step = steps[i];
			const ids = step.ids.filter(function(id) { return chainKillFeed.info[id]; });	// may have left meanwhile
			if (!ids.length) { next(i + 1, null, 0); return; }
			const params = { systems: ids.join(","), pastSeconds: chainKillFeed.WINDOW_SECONDS, source: step.source || "chain" };
			if (step.kind === "window") {
				params.limit = step.limit;
				params.queue = step.queue ? 1 : 0;
			} else {
				params.limit = chainKillFeed.PAGE_LIMIT;
				params.queue = 0;
				params.since = since === null ? chainKillFeed.cursor : since;
			}
			chainKillFeed.get(params).done(function(response) {
				if (generation !== chainKillFeed.generation || !response) { return; }
				// Kills first, judged against the status from before this answer: a back-fill that just finished
				// delivers its (old) kills in the same answer that reports it done, and they must not light up
				// Live: since answers, and the window re-reads that replace them while names resolve (new kills arrive
				// there too). Not the window reads for joining systems or a refill: those are history.
				const live = chainKillFeed.isLiveStep(step);
				changed = chainKillFeed.mergeKills(response.kills, live, response.names) || changed;
				if (live) { chainKillFeed.lastLive = Date.now(); }
				chainKillFeed.applyStatus(response);
				namesPending = namesPending || !!response.namesPending;
				const kills = Array.isArray(response.kills) ? response.kills : [];
				if (step.kind === "since" && kills.length === params.limit && page + 1 < chainKillFeed.MAX_PAGES) {
					next(i, response.cursor, page + 1);	// a full page: continue after its last kill
					return;
				}
				// A window answer's cursor (the latest id) starts the live poll; since answers move it on. Later window
				// answers don't: kills stored meanwhile but not among their newest would be skipped.
				if (step.kind === "since" || chainKillFeed.cursor === null) { cursors.push(response.cursor); }
				next(i + 1, null, 0);
			}).fail(function(x, status) {
				if (generation !== chainKillFeed.generation || status === "abort") { return; }
				failed = x || {};
				// Keep the cursor where this chunk stopped, so the other chunks' answers don't move it past its kills
				if (step.kind === "since") { cursors.push(params.since); }
				// Window requests that failed are tried again with the next round
				if (step.kind === "window" && !step.refresh) { step.ids.forEach(function(id) { if (chainKillFeed.info[id]) { chainKillFeed.joining[id] = step.queue; } }); }
				next(i + 1, null, 0);
			});
		};
		chainKillFeed.render();
		next(0, null, 0);
	},

	schedule: function(ms) {
		clearTimeout(chainKillFeed.pollTimer);
		let delay = ms;
		if (delay === undefined) {
			const waiting = Object.keys(chainKillFeed.pending).length > 0 || chainKillFeed.namesPending;
			chainKillFeed.fastPolls = waiting ? chainKillFeed.fastPolls + 1 : 0;
			delay = waiting && chainKillFeed.fastPolls <= chainKillFeed.MAX_FAST_POLLS ? chainKillFeed.FAST_POLL_MS : chainKillFeed.POLL_MS;
		}
		chainKillFeed.pollTimer = setTimeout(chainKillFeed.run, delay);
	},

	detachTooltips: function($scope) {
		if (typeof Tooltips !== "undefined" && Tooltips.detach) {
			const $els = $scope.find("[data-tooltip]");
			if ($els.length) { Tooltips.detach($els); }
		}
	},

	systemHtml: function(systemID) {
		const esc = systemKillFeed.escape;
		const system = tripwire.systems[systemID] || {};
		const a = typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(systemID) : { systemTypeClass: "", systemTypeName: "" };
		const label = chainKillFeed.info[systemID] ? chainKillFeed.info[systemID].label : "";
		const tip = systemKillFeed.tooltip(chainKillFeed.systemTooltip(system.name || String(systemID), a.systemTypeName, a.baseSecurity, label));
		return "<span class='ckf-sys' data-system='" + systemID + "' data-tooltip='" + tip + "'>"
			+ "<span class='ckf-sysname " + esc(a.systemTypeClass) + "'>" + esc(system.name || systemID) + "</span>"
			+ (label ? "<span class='ckf-sig'>" + esc(label) + "</span>" : "")
			+ "</span>";
	},

	render: function() {
		const $w = chainKillFeed.$widget();
		if (!$w.length) { return; }
		const esc = systemKillFeed.escape;
		const now = Date.now();
		const pendingIDs = Object.keys(chainKillFeed.pending).filter(function(id) { return chainKillFeed.info[id]; });
		const joining = Object.keys(chainKillFeed.joining).length > 0 || chainKillFeed.cursor === null;
		const state = chainKillFeed.viewState(chainKillFeed.ids.length, chainKillFeed.kills.length,
			pendingIDs.length > 0 || joining || chainKillFeed.busy && chainKillFeed.cursor === null, chainKillFeed.feed);
		const feed = chainKillFeed.feed || {};
		let html;
		if (state === "list") {
			const byID = {};
			chainKillFeed.kills.forEach(function(k) { byID[k.killID] = k; });
			const rows = systemKillFeed.buildRows({ kills: chainKillFeed.kills, names: chainKillFeed.names, namesPending: chainKillFeed.namesPending });
			html = "<div class='skf-list'>" + rows.map(function(r) {
				const kill = byID[r.killID];
				return systemKillFeed.rowHtml(r, now, {
					className: chainKillFeed.fresh[r.killID] > now ? "ckf-new" : "",
					html: kill ? chainKillFeed.systemHtml(kill.systemID) : ""
				});
			}).join("") + "</div>";
		} else if (state === "nosystems") {
			html = "<div class='skf-state'>No wormhole, low-sec or null-sec systems on the chain map.</div>";
		} else if (state === "disabled") {
			html = "<div class='skf-state'>The zKillboard feed is turned off on this server.</div>";
		} else if (state === "loading") {
			html = "<div class='skf-state skf-loading'>Loading kills from zKillboard…</div>";
		} else {
			html = "<div class='skf-state'>No kills on the chain in the last hour.</div>";
		}
		let note = chainKillFeed.error;
		if (!note && state !== "disabled" && feed.enabled && feed.caughtUp === false && feed.lagSeconds !== null && feed.lagSeconds !== undefined) {
			note = "The zKillboard feed is behind by " + systemKillFeed.formatDuration(feed.lagSeconds) + "; recent kills may be missing.";
		}
		html += note ? "<div class='skf-note" + (chainKillFeed.error ? " skf-error" : "") + "'>" + esc(note) + "</div>" : "";

		if (typeof Tooltips !== "undefined" && Tooltips.close) { Tooltips.close(); }
		const $body = $w.find(".ckf-body");
		const scroll = $w.find(".content").scrollTop();
		chainKillFeed.detachTooltips($body);	// jBox keeps every attached element: detach before replacing them
		$body.html(html);
		$w.find(".content").scrollTop(scroll);
		if (typeof Tooltips !== "undefined") { Tooltips.attach($body.find("[data-tooltip]")); }
		// A re-rendered highlight continues where it was instead of starting over
		$body.find(".ckf-new").each(function() {
			this.style.animationDelay = chainKillFeed.highlightDelay(chainKillFeed.fresh[this.getAttribute("data-killid")], now) + "ms";
		});

		const count = chainKillFeed.kills.length;
		$w.find(".ckf-status").text(state === "list" ? count + (count === 1 ? " kill" : " kills") : "")
			.attr("title", chainKillFeed.ids.length + (chainKillFeed.ids.length === 1 ? " system" : " systems") + " watched (high-sec left out)");
		const $loading = $w.find(".ckf-loading");
		if ($loading.is("[data-tooltip]") && typeof Tooltips !== "undefined" && Tooltips.detach) { Tooltips.detach($loading); }
		if (pendingIDs.length) {
			const names = pendingIDs.map(function(id) { return tripwire.systems[id] ? tripwire.systems[id].name : id; });
			const shown = names.slice(0, 10).join(", ") + (names.length > 10 ? " and " + (names.length - 10) + " more" : "");
			$loading.removeClass("hidden").text("loading " + pendingIDs.length)
				.attr("data-tooltip", systemKillFeed.tooltip(["Loading the last hour of kills from zKillboard for:", shown]));
			if (typeof Tooltips !== "undefined") { Tooltips.attach($loading); }
		} else {
			$loading.addClass("hidden").text("").removeAttr("data-tooltip");
		}
	},

	/** Refresh the "time ago" labels and end highlights */
	tick: function() {
		const now = Date.now();
		const $w = chainKillFeed.$widget();
		$w.find(".skf-time[data-time]").each(function() {
			const t = Number($(this).attr("data-time"));
			if (t) { $(this).text(systemKillFeed.timeAgo(t, now)); }
		});
		$w.find(".ckf-new").each(function() {
			if (!(chainKillFeed.fresh[$(this).attr("data-killid")] > now)) { $(this).removeClass("ckf-new"); }
		});
		chainKillFeed.fresh = chainKillFeed.pruneFresh(chainKillFeed.fresh, chainKillFeed.kills, now);
	},

	// ---- Settings ----

	setupSettings: function() {
		// Settings > Kills & Intel, under the System kill feed; takes effect on Save like its neighbours (Reset = on)
		forkSettings.register({
			section: "intel", order: 20, id: "chainKillFeed-enabled", type: "checkbox", key: "chainKillFeed",
			label: "Chain kill feed:", text: "Show the Chain kills panel for the chain map",
			get: function() { return chainKillFeed.isOn(); },
			set: function(o, on) { o.chainKillFeed = systemKillFeed.merge(o.chainKillFeed, { enabled: on }); }
		});
		// options.apply() runs on Save and Reset: add or remove the panel to match
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.chainKillFeedWrapped) {
			const apply = options.apply;
			const wrapped = function() {
				const result = apply.apply(this, arguments);
				chainKillFeed.sync();
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrapped[k] = apply[k]; });
			wrapped.chainKillFeedWrapped = true;
			options.apply = wrapped;
		}
	},

	init: function() {
		if (typeof systemKillFeed === "undefined") { return; }
		panelHost.register(chainKillFeed.panel());
		chainKillFeed.setupSettings();
		if (typeof forkCommands !== "undefined") {	// command palette (Ctrl+K)
			forkCommands.panelToggle({ id: "panel.chainKills", title: "Toggle chain kills panel", key: "chainKillFeed", icon: "alert", keywords: ["kills", "killboard", "feed"] });
		}
		// Follow the chain map: every draw (new hole, chain tab or mask switch, system change) re-reads its systems
		if (typeof chain !== "undefined" && chain && typeof chain.draw === "function" && !chain.draw.chainKillFeedWrapped) {
			const draw = chain.draw;
			chain.draw = function() {
				const result = draw.apply(this, arguments);
				chainKillFeed.chainChanged();
				return result;
			};
			chain.draw.chainKillFeedWrapped = true;
		}
		document.addEventListener("visibilitychange", function() {
			if (!document.hidden && chainKillFeed.missed) { chainKillFeed.run(); }
		});
		chainKillFeed.sync();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { chainKillFeed.init(); });
}
