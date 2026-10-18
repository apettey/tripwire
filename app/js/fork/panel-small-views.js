const panelSmallViews = {
	// Small views of upstream's panels (fork-owned; panel-modes.js turns them on with small: true in its UPSTREAM list).
	//   Signatures: the total and unscanned count, then the newest signatures, one compact row each (a click opens the
	//               signature's edit dialog, as a double-click on its table row does). Rendered here from the signature
	//               data into a block of its own (.ssv) that only shows under .ph-small.
	//   System info: name, class (or security), region and statics: CSS only (panel-small-views.css hides the rest).
	// The block is redrawn whenever upstream redraws the signature table (rows added, replaced, removed, system change),
	// every minute (ages) and when the panel moves, so it is current the moment the small view opens. No requests.
	// The full panel's options are respected: hidden anomalies (sig-anomalies.js) are left out, ages are tinted when
	// "Colour signatures by age" (sig-age.js) is on. Keep `const panelSmallViews` on the first line: the test helper
	// strips it to define a global.
	SIG_ID: "signaturesWidget",
	MAX_ROWS: 30,		// rows rendered; the window shows as many as fit
	TICK_MS: 60000,

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	// ---- Signatures (pure) ----

	/**
	 * Unscanned: a signature whose group nobody has identified yet, what a scanner still has to scan down. In Tripwire's
	 * data that is type "unknown" (a paste below 25%, or added without a type) or no type at all. Wormholes, sites and
	 * anomalies are identified, whatever else is missing.
	 */
	isUnscanned: function(sig) {
		const type = sig ? String(sig.type === undefined || sig.type === null ? "" : sig.type).trim().toLowerCase() : "";
		return !!sig && (type === "" || type === "unknown");
	},

	/** Milliseconds since the epoch for a server time 'YYYY-MM-DD HH:mm:ss' (UTC), or NaN */
	parseTime: function(text) {
		const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text || ""));
		return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN;
	},

	/**
	 * The signatures the full list shows: the viewed system's, without the hidden ones (anomalies folded away)
	 * @param sigs {id: signature}; @param hidden [id] not shown
	 */
	visible: function(sigs, systemID, hidden) {
		const skip = {};
		(hidden || []).forEach(function(id) { skip[String(id)] = true; });
		return Object.keys(sigs || {}).map(function(k) { return sigs[k]; }).filter(function(s) {
			return s && String(s.systemID) === String(systemID) && !skip[String(s.id)];
		});
	},

	/** {total, unscanned} of a list */
	counts: function(list) {
		return { total: (list || []).length, unscanned: (list || []).filter(panelSmallViews.isUnscanned).length };
	},

	/** The newest first (created: lifeTime; unknown times last), ties by id (the later added first); at most `limit` */
	newest: function(list, limit) {
		const at = function(s) { const t = panelSmallViews.parseTime(s.lifeTime); return isNaN(t) ? -Infinity : t; };
		return (list || []).slice().sort(function(a, b) {
			return at(b) - at(a) || (Number(b.id) || 0) - (Number(a.id) || 0);
		}).slice(0, Math.max(0, limit === undefined ? panelSmallViews.MAX_ROWS : limit));
	},

	/** "ABC-123" (as the list shows it), "???" when unknown */
	sigID: function(signatureID) {
		const s = String(signatureID === undefined || signatureID === null ? "" : signatureID).replace(/[^A-Za-z0-9?#]/g, "");
		if (!s || /^\?+$/.test(s)) { return "???"; }
		return s.substring(0, 3).toUpperCase() + (s.length > 3 ? "-" + s.substring(3, 6).toUpperCase() : "");
	},

	/**
	 * The type column: "?" unscanned; a wormhole's type (its own end) or "[type]" (the far end's, as the list shows it),
	 * "WH" when nobody set one; else the site group ("combat", "data"...)
	 */
	typeText: function(sig, wormhole) {
		if (panelSmallViews.isUnscanned(sig)) { return "?"; }
		if (sig.type !== "wormhole") { return String(sig.type); }
		if (!wormhole || !wormhole.parent) { return "WH"; }
		const type = wormhole.type || "???";
		return String(wormhole[wormhole.parent + "ID"]) === String(sig.id) ? type : "[" + type + "]";
	},

	/** "now", "12m", "5h", "3d" */
	age: function(ms) {
		const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
		if (s < 60) { return "now"; }
		if (s < 3600) { return Math.floor(s / 60) + "m"; }
		if (s < 86400) { return Math.floor(s / 3600) + "h"; }
		return Math.floor(s / 86400) + "d";
	},

	/** The header line: "No signatures", "5 signatures", "5 signatures · 2 unscanned" (plain text parts) */
	headText: function(c) {
		if (!c || !c.total) { return { total: "No signatures", unscanned: "" }; }
		return { total: c.total + (c.total === 1 ? " signature" : " signatures"), unscanned: c.unscanned ? c.unscanned + " unscanned" : "" };
	},

	// ---- Browser-only code below (not run under mocha) ----

	scheduled: null,

	$sigs: function() {
		return $("#" + panelSmallViews.SIG_ID);
	},

	/** The block inside the Signatures panel (made once; the panel's element moves between modes, the block with it) */
	sigBlock: function() {
		const $w = panelSmallViews.$sigs();
		if (!$w.length) { return $(); }
		let $b = $w.children(".content").children(".ssv");
		if (!$b.length) {
			$b = $("<div class='ssv'><div class='ssv-head'><span class='ssv-total'></span><span class='ssv-unscanned'></span>"
				+ "<a href='#' class='ssv-add' title='Add a new signature'>+</a></div><ul class='ssv-list'></ul></div>");
			$w.children(".content").append($b);
		}
		return $b;
	},

	/** {sigID: wormhole} */
	wormholeIndex: function() {
		const index = {};
		const holes = (typeof tripwire !== "undefined" && tripwire.client && tripwire.client.wormholes) || {};
		Object.keys(holes).forEach(function(k) {
			const wh = holes[k];
			if (wh) { index[wh.initialID] = wh; index[wh.secondaryID] = wh; }
		});
		return index;
	},

	/** Where a wormhole leads (its name and the far end's system, in its class colour), or a site's name: HTML */
	leadsHtml: function(sig, wormhole) {
		const esc = panelSmallViews.escape;
		const name = sig.name ? "<span class='ssv-name'>" + esc(sig.name) + "</span>" : "";
		if (sig.type !== "wormhole" || !wormhole) { return name; }
		const otherID = String(wormhole.initialID) === String(sig.id) ? wormhole.secondaryID : wormhole.initialID;
		const other = tripwire.client.signatures ? tripwire.client.signatures[otherID] : null;
		let dest = "";
		if (other && tripwire.systems[other.systemID]) {
			let cls = "";
			try { cls = systemAnalysis.analyse(other.systemID).systemTypeClass || ""; } catch (e) { cls = ""; }
			dest = "<span class='ssv-dest " + esc(cls) + "'>" + esc(tripwire.systems[other.systemID].name) + "</span>";
		} else if (other && typeof appData !== "undefined" && appData.genericSystemTypes && appData.genericSystemTypes[other.systemID]) {
			dest = "<span class='ssv-dest'>" + esc(appData.genericSystemTypes[other.systemID]) + "</span>";
		}
		return name && dest ? name + " &ndash; " + dest : name || dest;
	},

	renderSigs: function() {
		const $b = panelSmallViews.sigBlock();
		if (!$b.length || typeof tripwire === "undefined" || !tripwire.signatures) { return; }
		const opts = typeof options !== "undefined" ? options : undefined;
		const systemID = typeof viewingSystemID !== "undefined" ? viewingSystemID : null;
		const sigs = tripwire.signatures.currentSystem || {};
		const hidden = typeof sigAnomalies !== "undefined" && !sigAnomalies.revealed ? sigAnomalies.hiddenIds(sigs, systemID, opts) : [];
		const list = panelSmallViews.visible(sigs, systemID, hidden);
		const head = panelSmallViews.headText(panelSmallViews.counts(list));
		$b.find(".ssv-total").text(head.total);
		$b.find(".ssv-unscanned").text(head.unscanned).toggleClass("ssv-hot", !!head.unscanned);
		const esc = panelSmallViews.escape;
		const holes = panelSmallViews.wormholeIndex();
		const ageOn = typeof sigAge !== "undefined" && sigAge.enabled(opts);
		const now = typeof sigAge !== "undefined" ? sigAge.now() : Date.now();
		$b.find(".ssv-list").html(panelSmallViews.newest(list).map(function(s) {
			const wh = holes[s.id];
			const created = panelSmallViews.parseTime(s.lifeTime);
			const level = ageOn ? sigAge.levelFor(s, wh, now) : null;
			const eol = wh && wh.life === "critical";
			return "<li class='ssv-row" + (panelSmallViews.isUnscanned(s) ? " ssv-unscanned-row" : "") + "' data-id='" + esc(s.id) + "' title='Edit this signature'>"
				+ "<span class='ssv-id'>" + esc(panelSmallViews.sigID(s.signatureID)) + "</span>"
				+ "<span class='ssv-type'>" + esc(panelSmallViews.typeText(s, wh)) + "</span>"
				+ "<span class='ssv-leads'>" + panelSmallViews.leadsHtml(s, wh) + "</span>"
				+ "<span class='ssv-age" + (eol ? " critical" : "") + (level && level.level !== "fresh" ? " sig-age-" + level.level : "") + "'>"
				+ esc(isNaN(created) ? "" : panelSmallViews.age(now - created)) + "</span>"
				+ "</li>";
		}).join(""));
	},

	schedule: function() {
		if (panelSmallViews.scheduled) { return; }
		panelSmallViews.scheduled = setTimeout(function() {
			panelSmallViews.scheduled = null;
			try { panelSmallViews.renderSigs(); } catch (err) { console.error("Small views: signatures failed", err); }
		}, 60);
	},

	init: function() {
		panelSmallViews.renderSigs();
		// Upstream redraws the table's rows on every change (and empties it on a system change)
		const tbody = document.querySelector("#sigTable > tbody");
		if (tbody && typeof MutationObserver !== "undefined") {
			new MutationObserver(panelSmallViews.schedule).observe(tbody, { childList: true });
		}
		setInterval(panelSmallViews.schedule, panelSmallViews.TICK_MS);
		// Show / hide anomalies (sig-anomalies.js), Settings Save (sig-age, anomalies)
		$("body").on("click", "#sigAnomalyBar a", panelSmallViews.schedule);
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.panelSmallViewsWrapped) {
			const apply = options.apply;
			const wrapped = function() {
				const result = apply.apply(this, arguments);
				panelSmallViews.schedule();
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrapped[k] = apply[k]; });
			wrapped.panelSmallViewsWrapped = true;
			options.apply = wrapped;
		}
		// A row does what a double-click on its table row does: the signature's edit dialog
		panelSmallViews.$sigs().on("click", ".ssv-row", function(e) {
			e.preventDefault();
			const $tr = $("#sigTable tbody tr[data-id='" + String($(this).attr("data-id")).replace(/[^0-9]/g, "") + "']");
			if ($tr.length) { $tr.first().trigger("dblclick"); }
		}).on("click", ".ssv-add", function(e) {
			e.preventDefault();
			$("#add-signature").trigger("click");
		});
		// Current the moment it is shown small
		const def = typeof panelHost !== "undefined" ? panelHost.get(panelSmallViews.SIG_ID) : null;
		if (def) {
			const after = def.afterMove;
			def.afterMove = function(mode) {
				if (typeof after === "function") { after.apply(this, arguments); }
				if (mode === "small") { panelSmallViews.renderSigs(); }
			};
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { panelSmallViews.init(); });
}
