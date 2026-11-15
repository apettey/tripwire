// Recent kills for a wormhole system, from zKillboard, in our own markup.
//
// ESI's hourly activity feed covers no wormhole system, so the System
// panel's graph read "no activity" in every J-system. zKillboard records
// every player loss. In J-space the graph gives way to the system's last
// eight hours of kills: the five newest as hull, value and age, each a
// link to its mail on the board. k-space keeps the ESI graph, where jumps
// and NPC kills are real. One request per system, cached five minutes and
// refreshed on that cadence while the system stays in view; the board's
// own Streambox was tried first and could not wear the room.
tripwire.killStream = (function() {
	"use strict";
	var BASE = "https://zkillboard.com", IMG = "https://images.evetech.net/types/";
	var WINDOW = 8 * 3600, CACHE_MS = 5 * 60 * 1000, SHOW = 5;
	var current = null, request = 0, cache = {}, timer = null;

	function isWormhole(systemID) {
		var r = systemAnalysis.analyse(systemID);
		return !!(r && r.class);
	}

	function kills(systemID) {
		var hit = cache[systemID];
		if (hit && Date.now() - hit.at < CACHE_MS) { return Promise.resolve(hit.list); }
		return fetch(BASE + "/api/kills/solarSystemID/" + systemID + "/pastSeconds/" + WINDOW + "/", { headers: { Accept: "application/json" } })
			.then(function(r) { if (!r.ok) { throw new Error("zKillboard " + r.status); } return r.json(); })
			.then(function(list) { if (!Array.isArray(list)) { throw new Error("zKillboard shape"); } cache[systemID] = { list: list, at: Date.now() }; return list; });
	}

	// 15210.83 -> "15.2k", 3373.24 -> "3.4k", 450100000 -> "450.1m", 1.2e9 -> "1.2b"
	function isk(v) {
		v = Number(v) || 0;
		if (v >= 1e9) { return (v / 1e9).toFixed(1) + "b"; }
		if (v >= 1e6) { return (v / 1e6).toFixed(1) + "m"; }
		if (v >= 1e3) { return (v / 1e3).toFixed(1) + "k"; }
		return Math.round(v).toString();
	}
	function age(iso) {
		var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
		if (s < 3600) { return Math.max(1, Math.round(s / 60)) + "m"; }
		return (s / 3600).toFixed(s < 36000 ? 1 : 0).replace(/\.0$/, "") + "h";
	}
	function hull(typeID) {
		var t = appData.mass && appData.mass[typeID];
		return t && t.typeName ? t.typeName : "Unknown hull";
	}
	function sortNewest(list) {
		return list.slice().sort(function(a, b) { return Date.parse(b.killmail_time) - Date.parse(a.killmail_time); });
	}

	function label(n) {
		$("#killStreamWindow").text((n ? (n === 1 ? "1 kill" : n + " kills") + " in the past 8 hours" : "past 8 hours") + " · zKillboard");
	}

	function render(list) {
		var $strip = $("#killStreamStrip").empty();
		sortNewest(list).slice(0, SHOW).forEach(function(k) {
			var v = k.victim || {}, z = k.zkb || {};
			var name = hull(v.ship_type_id), value = isk(z.totalValue), when = age(k.killmail_time);
			var tags = [];
			if (z.npc) { tags.push("NPC"); }
			if (z.solo) { tags.push("solo"); }
			var $a = $("<a class='kill' role='listitem' target='_blank' rel='noopener noreferrer'></a>")
				.attr("href", BASE + "/kill/" + k.killmail_id + "/")
				.attr("title", name + " · " + value + " ISK · " + when + " ago" + (tags.length ? " · " + tags.join(", ") : ""))
				.toggleClass("is-npc", !!z.npc);
			$("<img class='kill-hull' alt='' loading='lazy' decoding='async'>").attr("src", IMG + v.ship_type_id + "/render?size=64").appendTo($a);
			$("<span class='kill-name'></span>").text(name).appendTo($a);
			$("<span class='kill-meta'></span>").append($("<b></b>").text(value)).append(document.createTextNode(" · " + when)).appendTo($a);
			$a.appendTo($strip);
		});
	}

	function show(systemID, force) {
		var $block = $("#killStream");
		$("#killStreamLink").attr("href", BASE + "/system/" + systemID + "/");
		$block.removeClass("hidden");
		if (current === systemID && !force) { return; }
		current = systemID;
		var mine = ++request;
		$block.removeClass("is-quiet").removeClass("is-failed").addClass("is-waiting");
		if (!force) { label(null); }
		kills(systemID).then(function(list) {
			if (mine !== request) { return; }
			$block.removeClass("is-waiting");
			label(list.length);
			if (!list.length) { $("#killStreamStrip").empty(); $block.addClass("is-quiet"); return; }
			render(list);
		}).catch(function() {
			if (mine !== request) { return; }
			$block.removeClass("is-waiting").addClass("is-failed");
		});
		clearTimeout(timer);
		timer = setTimeout(function() { if (current === systemID && !document.hidden) { delete cache[systemID]; show(systemID, true); } }, CACHE_MS);
	}

	function hide() {
		clearTimeout(timer); request++;
		$("#killStream").addClass("hidden").removeClass("is-waiting is-quiet is-failed");
		$("#killStreamStrip").empty();
		current = null;
	}

	// Called whenever the viewed system changes.
	function refresh(systemID) {
		var wormhole = isWormhole(systemID);
		$("#infoWidget").toggleClass("is-wormhole", wormhole);
		if (wormhole) { show(systemID); } else { hide(); }
	}

	return { refresh: refresh, isWormhole: isWormhole, isk: isk, age: age };
})();
