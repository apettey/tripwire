const fightNow = {
	// Fight now (fork-owned, part of Kill tags): a marker on chain map systems with 2 or more player kills in the last hour,
	// a link to zKillboard's related kills (battle report) for that system and hour. Reads public/fight_now.php, which counts
	// the kills the pooled zKillboard stream stored (zkill/); the browser never calls zKillboard, the marker is only a link.
	// Settings: options.fightNow.enabled (missing = on), Settings > Map Markers. CSS: app/css/fork/kill-tags.css.
	// Keep `const fightNow` on the first line: the test helper strips it to define a global.
	URL: "fight_now.php",
	MIN_KILLS: 2,
	POLL_MS: 60000,
	MAX_SYSTEMS: 200,	// server maximum per request
	RELATED_URL: "https://zkillboard.com/related/",

	/** Whether the markers are on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.fightNow && opts.fightNow.enabled === false);
	},

	/**
	 * Whether a system is high-sec, where Fight now never marks (busy trade hubs and gank systems would always be lit).
	 * The Chain kill feed's rule (chainKillFeed.systemKind: security 0.45+; J-space and Pochven never).
	 * @param info {class, factionID, baseSecurity|security}, e.g. systemAnalysis.analyse(systemID)
	 */
	isHighsec: function(info) {
		return typeof chainKillFeed !== "undefined" && chainKillFeed.systemKind(info) === "hs";
	},

	/** zKillboard's related kills (battle report) for a system and the hour of an ISO time: /related/<system>/<YYYYMMDDHH>00/ */
	relatedURL: function(systemID, isoTime) {
		const id = parseInt(systemID, 10);
		const t = new Date(Date.parse(isoTime));
		if (!(id > 0) || isNaN(t.getTime())) { return null; }
		const pad = function(n) { return (n < 10 ? "0" : "") + n; };
		return fightNow.RELATED_URL + id + "/" + t.getUTCFullYear() + pad(t.getUTCMonth() + 1) + pad(t.getUTCDate()) + pad(t.getUTCHours()) + "00/";
	},

	/**
	 * Systems to mark from a fight_now.php response: { systemID: {kills, lastKill, url} } for those with MIN_KILLS or more
	 * player kills
	 */
	marks: function(response, minKills) {
		const out = {};
		const min = minKills || fightNow.MIN_KILLS;
		const systems = response && response.systems && typeof response.systems === "object" ? response.systems : {};
		Object.keys(systems).forEach(function(id) {
			const s = systems[id] || {};
			const kills = parseInt(s.kills, 10) || 0;
			const url = fightNow.relatedURL(id, s.lastKill);
			if (kills >= min && url) { out[id] = { kills: kills, lastKill: s.lastKill, url: url }; }
		});
		return out;
	},

	escape: function(text) {
		return String(text === null || text === undefined ? "" : text).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** "12 min ago" style age of the last kill */
	ago: function(isoTime, nowMs) {
		const minutes = Math.max(0, Math.round((nowMs - Date.parse(isoTime)) / 60000));
		return minutes < 1 ? "just now" : minutes + " min ago";
	},

	/** The marker for a mark (a link; the tooltip attribute is escaped twice, the tooltip renders HTML) */
	markerHtml: function(mark, nowMs) {
		if (!mark || !mark.url) { return ""; }
		const esc = fightNow.escape;
		const tip = esc("Fight now: " + mark.kills + " player kills here in the last hour (last one " + fightNow.ago(mark.lastKill, nowMs) + ").")
			+ "<br/>" + esc("Click to open zKillboard's related kills (battle report) for that hour.");
		return "<a class='fight-now' href='" + esc(mark.url) + "' target='_blank' rel='noopener noreferrer' data-tooltip='" + esc(tip)
			+ "' aria-label='" + esc(mark.kills + " player kills in the last hour: open the battle report on zKillboard") + "'>"
			+ "<span class='fight-now-icon' aria-hidden='true'>⚔</span>" + esc(mark.kills) + "</a>";
	},

	// ---- Browser-only code below (not run under mocha) ----

	data: {},	// systemID => mark
	ids: [],	// real systems drawn on the chain map
	timer: null,
	xhr: null,
	missed: false,

	isOn: function() {
		return fightNow.enabled(typeof options !== "undefined" ? options : undefined);
	},

	/** What isHighsec needs to know about a system: systemAnalysis when it knows the system, else the static data */
	info: function(systemID) {
		if (typeof systemAnalysis !== "undefined" && typeof tripwire !== "undefined" && tripwire.systems && tripwire.systems[systemID]) {
			return systemAnalysis.analyse(systemID);
		}
		return typeof appData !== "undefined" && appData.systems ? appData.systems[String(systemID)] || null : null;
	},

	/** Real systems on the drawn chain map, high-sec left out (not route / destination nodes) */
	chainIDs: function() {
		const seen = {};
		$("#chainMap .node[data-nodeid]").each(function() {
			if ($(this).closest(".destination-node").length) { return; }
			const id = parseInt($(this).attr("data-nodeid"), 10);
			if (id >= 30000000 && id < 32000000 && !fightNow.isHighsec(fightNow.info(id))) { seen[id] = true; }
		});
		return Object.keys(seen).map(Number).sort(function(a, b) { return a - b; }).slice(0, fightNow.MAX_SYSTEMS);
	},

	/** Put the markers on the drawn chain map (after each draw and each poll) */
	apply: function() {
		const $map = $("#chainMap");
		const $old = $map.find(".fight-now");
		if ($old.length && typeof Tooltips !== "undefined" && Tooltips.detach) { Tooltips.detach($old); }
		$old.remove();
		if (!fightNow.isOn()) { return; }
		const now = Date.now();
		let added = $();
		$map.find(".node[data-nodeid]").each(function() {
			const $node = $(this);
			if ($node.closest(".destination-node").length) { return; }
			const html = fightNow.markerHtml(fightNow.data[$node.attr("data-nodeid")], now);
			if (!html) { return; }
			const $marker = $(html);
			$node.append($marker);
			added = added.add($marker);
		});
		if (added.length && typeof Tooltips !== "undefined") { Tooltips.attach(added); }
	},

	/** The chain was drawn: markers back on the new nodes, and a poll when its systems changed */
	chainDrawn: function() {
		fightNow.apply();
		const ids = fightNow.chainIDs();
		if (ids.join(",") !== fightNow.ids.join(",")) {
			fightNow.ids = ids;
			clearTimeout(fightNow.timer);
			fightNow.timer = setTimeout(fightNow.poll, 300);
		}
	},

	poll: function() {
		clearTimeout(fightNow.timer);
		fightNow.timer = setTimeout(fightNow.poll, fightNow.POLL_MS);
		if (!fightNow.isOn() || !fightNow.ids.length) {
			if (Object.keys(fightNow.data).length) { fightNow.data = {}; fightNow.apply(); }
			return;
		}
		if (document.hidden) { fightNow.missed = true; return; }
		fightNow.missed = false;
		if (fightNow.xhr) { fightNow.xhr.abort(); }
		const xhr = $.ajax({ url: fightNow.URL, type: "GET", dataType: "JSON", cache: false, timeout: 15000,
			data: { systems: fightNow.ids.join(",") } });
		fightNow.xhr = xhr;
		xhr.done(function(response) {
			fightNow.data = fightNow.marks(response);
			fightNow.apply();
		}).always(function() { if (fightNow.xhr === xhr) { fightNow.xhr = null; } });
	},

	setupSettings: function() {
		if (typeof forkSettings === "undefined") { return; }
		// Drawn on the map, so Map Markers; takes effect on Save like its neighbours (Reset = on)
		forkSettings.register({
			section: "markers", order: 72, id: "fightNow-enabled", type: "checkbox", key: "fightNow",
			label: "Fight now:", text: "Mark chain systems (not high-sec) with 2+ player kills in the last hour (links to the zKillboard battle report)",
			get: function() { return fightNow.isOn(); },
			set: function(o, on) { o.fightNow = Object.assign({}, o.fightNow || {}, { enabled: on }); }
		});
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.fightNowWrapped) {
			const apply = options.apply;
			const wrapped = function() {
				const result = apply.apply(this, arguments);
				fightNow.poll();
				fightNow.apply();
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrapped[k] = apply[k]; });
			wrapped.fightNowWrapped = true;
			options.apply = wrapped;
		}
	},

	/** Map key entry (map-legend.js) */
	setupLegend: function() {
		if (typeof forkLegend === "undefined") { return; }
		forkLegend.register({
			id: "fightNow", group: "systemMarks", order: 95, title: "Fight now",
			text: "2 or more player kills here in the last hour (not shown in high-sec). Click it for zKillboard's battle report.",
			settingId: "fightNow-enabled",
			sample: function() {
				const marker = fightNow.markerHtml({ kills: 4, lastKill: new Date(Date.now() - 6 * 60000).toISOString(),
					url: fightNow.RELATED_URL }, Date.now()).replace(/^<a [^>]*?href='[^']*'/, "<span class='fight-now'").replace(/<\/a>$/, "</span>");
				return forkLegend.node({ before: marker, label: "<span class='nullsec'>NS</span>", name: "HED-GP", type: "K162" });
			}
		});
	},

	init: function() {
		fightNow.setupSettings();
		fightNow.setupLegend();
		// Redraws replace the nodes: put the markers back
		if (typeof chain !== "undefined" && chain && typeof chain.draw === "function" && !chain.draw.fightNowWrapped) {
			const draw = chain.draw;
			const wrapped = function() {
				const result = draw.apply(this, arguments);
				try { fightNow.chainDrawn(); } catch (e) { console.warn("Fight now: could not mark the chain", e); }
				return result;
			};
			Object.keys(draw).forEach(function(k) { wrapped[k] = draw[k]; });
			wrapped.fightNowWrapped = true;
			chain.draw = wrapped;
		}
		// The marker is a link: don't let the click also select the system on the map
		$(document).on("mousedown click", "#chainMap .fight-now", function(e) {
			e.stopPropagation();
			if (e.type === "click" && typeof forkUsage !== "undefined") { forkUsage.track("fightNow", "opened"); }
		});
		document.addEventListener("visibilitychange", function() {
			if (!document.hidden && fightNow.missed) { fightNow.poll(); }
		});
		fightNow.chainDrawn();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { fightNow.init(); });
}
