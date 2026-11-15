const flareDetails = {
	// Fork-owned: flares with a reason and a lifetime (changes/2026-11-15-flare-reason-life), ported from upstream
	// Tripwire 2.0's flare rework (app/js/dialogs/flare-dialog.js, systemPanel.js). Right-click a system > Flares >
	// Set flare... opens a dialog with the colour, how long it lasts (1 day or until removed) and an optional reason. The
	// reason shows in the system panel and in a tooltip on the flared node's (i) icon. Quick Battle / Hold / Fleet Op
	// items and the palette's flare commands re-colour a flare and keep its lifetime and reason.
	// Server: public/flares.php, flares/flares.inc.php. chain.data.flares keeps upstream's shape {flares: [...], last_modified};
	// each entry {systemID, flare, time, lifeLength (seconds or null = until removed), reason (or null), setAt (unix s)}.
	// Keep `const flareDetails` on the first line: the test helper only turns the first `const` into a global.

	COLOURS: ["red", "yellow", "green"],
	NAMES: { red: "Battle", yellow: "Hold", green: "Fleet op" },
	HINTS: { red: "battle, hostile, dangerous", yellow: "hold, warning", green: "op, rally, friendly" },
	DAY: 86400,
	REASON_MAX: 200,		// flares/flares.inc.php FLARES_REASON_MAX
	FOREVER: "forever",

	// ---- Pure logic ----

	esc: function(text) {
		return String(text === undefined || text === null ? "" : text).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** The flare list of chain.data.flares (upstream's {flares: [...]}), or [] */
	list: function(data) {
		return data && Array.isArray(data.flares) ? data.flares : [];
	},

	/** The flare on a system, or null */
	find: function(data, systemID) {
		const id = String(systemID);
		return flareDetails.list(data).find(function(f) { return f && String(f.systemID) === id; }) || null;
	},

	/** Reason as the server stores it (flares_clean_reason): zero-width / direction marks go, control characters and runs of
		whitespace become one space, trimmed. Not a string: "". */
	cleanReason: function(text) {
		if (typeof text !== "string") { return ""; }
		return text.replace(/\p{Cf}+/gu, "").replace(/[\p{Cc}\p{Z}\s]+/gu, " ").trim();
	},

	/** Request value for a stored lifeLength: "forever" (null) or the seconds as text */
	lifeValue: function(lifeLength) {
		return lifeLength === null ? flareDetails.FOREVER : String(lifeLength === undefined ? flareDetails.DAY : lifeLength);
	},

	/** The POST body for flares.php. A reason that is empty after cleaning is left out (no field, not ""). */
	payload: function(systemID, colour, life, reason) {
		const out = { systemID: Number(systemID), flare: colour, lifeLength: life === flareDetails.FOREVER ? flareDetails.FOREVER : String(life || flareDetails.DAY) };
		const r = flareDetails.cleanReason(reason);
		if (r) { out.reason = r; }
		return out;
	},

	/** Payload that gives a system this colour and keeps the lifetime and reason of the flare already there (a new flare:
		1 day, no reason) */
	recolour: function(data, systemID, colour) {
		const old = flareDetails.find(data, systemID);
		return flareDetails.payload(systemID, colour, old ? flareDetails.lifeValue(old.lifeLength) : flareDetails.DAY, old && old.reason ? old.reason : undefined);
	},

	/** What a quick colour item does: the same colour again removes the flare (null), another colour re-colours it */
	toggle: function(data, systemID, colour) {
		const old = flareDetails.find(data, systemID);
		return old && old.flare === colour ? null : flareDetails.recolour(data, systemID, colour);
	},

	/** chain.data.flares after a successful set (payload) or remove (payload null) of systemID, without waiting for the next
		refresh. Returns a new object; the newest flare first, as the server sends them. As on the server (flares_set): a
		re-colour keeps the time the flare was set; the dialog (payload.restart) or a flare whose lifetime is over starts it again. */
	applyLocal: function(data, systemID, payload, nowSec) {
		const id = String(systemID);
		const old = flareDetails.find(data, systemID);
		const rest = flareDetails.list(data).filter(function(f) { return f && String(f.systemID) !== id; });
		const out = {};
		for (const k in (data || {})) { if (k !== "flares") { out[k] = data[k]; } }
		if (payload) {
			const keep = !!old && !payload.restart && Number(old.setAt) > 0 && flareDetails.remaining(old, nowSec) !== 0;
			rest.unshift({
				systemID: Number(systemID), flare: payload.flare, time: keep ? old.time : null, setAt: keep ? Number(old.setAt) : Math.floor(nowSec),
				lifeLength: payload.lifeLength === flareDetails.FOREVER ? null : Number(payload.lifeLength),
				reason: payload.reason || null
			});
		}
		out.flares = rest;
		return out;
	},

	/** Seconds left (0 when over), or null for a flare that lasts until removed. Unknown set time: a full lifetime. */
	remaining: function(flare, nowSec) {
		if (!flare || flare.lifeLength === null) { return null; }
		const life = flare.lifeLength === undefined ? flareDetails.DAY : Number(flare.lifeLength);
		const setAt = Number(flare.setAt);
		if (!setAt) { return life; }
		return Math.max(0, setAt + life - nowSec);
	},

	/** "13 h 5 min left", "45 min left", "less than a minute left"; null: "until removed" */
	remainingText: function(seconds) {
		if (seconds === null) { return "until removed"; }
		if (seconds < 60) { return "less than a minute left"; }
		const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
		return (h ? h + " h" + (m ? " " + m + " min" : "") : m + " min") + " left";
	},

	/** Plain text parts for one flare: {colour, name, life, reason} */
	describe: function(flare, nowSec) {
		const colour = flareDetails.COLOURS.indexOf(flare && flare.flare) >= 0 ? flare.flare : "red";
		return {
			colour: colour,
			name: flareDetails.NAMES[colour],
			life: flareDetails.remainingText(flareDetails.remaining(flare, nowSec)),
			reason: flare && typeof flare.reason === "string" ? flare.reason : ""
		};
	},

	/** System panel line (escaped HTML), or "" for no flare */
	panelHtml: function(flare, nowSec) {
		if (!flare) { return ""; }
		const d = flareDetails.describe(flare, nowSec);
		return "<div class='fork-flare-panel'><span class='flare-" + d.colour + "'>" + flareDetails.esc(d.name) + " flare</span>"
			+ (d.reason ? ": " + flareDetails.esc(d.reason) : "") + " <span class='fork-flare-life'>(" + flareDetails.esc(d.life) + ")</span></div>";
	},

	/** Tooltip on the node's (i) icon (escaped HTML) */
	tooltipHtml: function(flare, nowSec) {
		const d = flareDetails.describe(flare, nowSec);
		return "<div class='fork-flare-tip'><b class='flare-" + d.colour + "'>" + flareDetails.esc(d.name) + " flare</b>"
			+ (d.reason ? "<br>" + flareDetails.esc(d.reason) : "")
			+ "<br><span class='fork-flare-life'>" + flareDetails.esc(d.life.charAt(0).toUpperCase() + d.life.slice(1)) + "</span></div>";
	},

	/** Key that changes when what the panel shows for a flare changes (colour, reason, lifetime, minute left) */
	panelKey: function(flare, nowSec) {
		if (!flare) { return ""; }
		const d = flareDetails.describe(flare, nowSec);
		return [d.colour, d.reason, d.life].join("|");
	},

	// ---- DOM ----

	nowSec: function() {
		return Math.floor((typeof sigAge !== "undefined" && sigAge.now ? sigAge.now() : Date.now()) / 1000);
	},

	data: function() {
		return typeof chain !== "undefined" && chain && chain.data ? chain.data.flares : null;
	},

	/** POST a set (payload) or a remove (payload null) to flares.php, then update the map without waiting for a refresh */
	send: function(systemID, payload) {
		const body = payload || { systemID: Number(systemID) };
		return $.ajax({ url: "flares.php", type: "POST", data: body, dataType: "JSON" }).then(function(out) {
			if (!out || out.result !== true) { return $.Deferred().reject(out && out.error ? out.error : "Could not save the flare").promise(); }
			chain.data.flares = flareDetails.applyLocal(flareDetails.data(), systemID, payload, flareDetails.nowSec());
			chain.flares(chain.data.flares);
			return out;
		}, function(xhr) {
			const err = xhr && xhr.responseJSON && xhr.responseJSON.error ? xhr.responseJSON.error : "Could not save the flare";
			return $.Deferred().reject(err).promise();
		});
	},

	/** Give a system a colour, keeping its lifetime and reason (palette, Battle / Hold / Fleet Op items) */
	setColour: function(systemID, colour) {
		return flareDetails.send(systemID, flareDetails.recolour(flareDetails.data(), systemID, colour));
	},

	remove: function(systemID) {
		return flareDetails.send(systemID, null);
	},

	systemName: function(systemID) {
		const s = typeof tripwire !== "undefined" && tripwire.systems ? tripwire.systems[systemID] : null;
		return s && s.name ? s.name : (typeof appData !== "undefined" && appData.systems && appData.systems[systemID] ? appData.systems[systemID].name : String(systemID));
	},

	openDialog: function(systemID) {
		if (!systemID) { return; }
		let $d = $("#dialog-fork-flare");
		if (!$d.length) {
			const colours = flareDetails.COLOURS.map(function(c) {
				return "<label class='fork-flare-colour'><input type='radio' name='fork-flare-colour' value='" + c + "'> <span class='flare-" + c + "'>"
					+ flareDetails.NAMES[c] + "</span> <span class='fork-flare-hint'>(" + flareDetails.HINTS[c] + ")</span></label>";
			}).join("");
			$d = $("<div id='dialog-fork-flare' title='Flare'>"
				+ "<div class='fork-flare-colours'>" + colours + "</div>"
				+ "<p class='fork-flare-lifetime'>Lasts: <label><input type='radio' name='fork-flare-life' value='" + flareDetails.DAY + "'> 1 day</label> "
				+ "<label><input type='radio' name='fork-flare-life' value='" + flareDetails.FOREVER + "'> Until removed</label></p>"
				+ "<p class='fork-flare-reason-row'><label>Reason (optional)<br><input type='text' class='fork-flare-reason' maxlength='" + flareDetails.REASON_MAX + "' placeholder='e.g. Loki gang camping the null exit'></label></p>"
				+ "<p class='fork-flare-error' role='alert'></p>"
				+ "</div>").appendTo("body");
			$d.dialog({
				autoOpen: false, modal: true, width: 380, resizable: false, dialogClass: "dialog-noeffect ui-dialog-shadow",
				buttons: [
					{ text: "Save", click: function() { flareDetails.saveDialog($d); } },
					{ text: "Remove flare", class: "fork-flare-remove", click: function() {
						flareDetails.remove($d.data("systemID")).then(function() { $d.dialog("close"); }, function(err) { $d.find(".fork-flare-error").text(err); });
					} },
					{ text: "Cancel", click: function() { $(this).dialog("close"); } }
				]
			});
			$d.on("keydown", ".fork-flare-reason", function(e) {
				if (e.key === "Enter") { e.preventDefault(); flareDetails.saveDialog($d); }
			});
		}
		const old = flareDetails.find(flareDetails.data(), systemID);
		$d.data("systemID", Number(systemID));
		$d.find(".fork-flare-error").text("");
		$d.find("input[name='fork-flare-colour'][value='" + (old ? old.flare : "red") + "']").prop("checked", true);
		$d.find("input[name='fork-flare-life'][value='" + flareDetails.lifeValue(old ? old.lifeLength : flareDetails.DAY) + "']").prop("checked", true);
		$d.find(".fork-flare-reason").val(old && old.reason ? old.reason : "");
		$d.dialog("option", "title", (old ? "Change flare on " : "Flare ") + flareDetails.systemName(systemID));
		$d.parent().find(".fork-flare-remove").toggle(!!old);
		$d.dialog("open");
		$d.find(".fork-flare-reason").trigger("focus");
	},

	saveDialog: function($d) {
		const systemID = $d.data("systemID");
		const colour = $d.find("input[name='fork-flare-colour']:checked").val();
		const life = $d.find("input[name='fork-flare-life']:checked").val();
		const payload = flareDetails.payload(systemID, colour, life, $d.find(".fork-flare-reason").val());
		payload.restart = "1";	// set again by the user: its lifetime starts again (a quick re-colour keeps it)
		flareDetails.send(systemID, payload).then(function() {
			if (typeof forkUsage !== "undefined" && (payload.reason || payload.lifeLength === flareDetails.FOREVER)) { forkUsage.track("flareDetails", "saved"); }
			$d.dialog("close");
		}, function(err) { $d.find(".fork-flare-error").text(err); });
	},

	tipBox: null,
	lastPanelKey: null,

	/** After chain.flares: the (i) icon with the tooltip on flared nodes that have a reason, and the system panel line */
	decorate: function(data) {
		const now = flareDetails.nowSec();
		$("#chainMap .fork-flare-mark").remove();
		flareDetails.list(data).forEach(function(f) {
			if (!f || !f.reason) { return; }
			const $node = $("#chainMap [data-nodeid='" + Number(f.systemID) + "']");
			if (!$node.length) { return; }
			$node.find(".nodeIcons > div").first().append("<i data-icon='info' class='fork-flare-mark' data-flare-system='" + Number(f.systemID)
				+ "' tabindex='0' aria-label='Flare reason'></i>");
		});
		if (typeof jBox !== "undefined") {
			if (!flareDetails.tipBox) {
				flareDetails.tipBox = new jBox("Tooltip", {
					position: { x: "center", y: "top" }, outside: "y", maxWidth: 280,
					onOpen: function() {
						const id = this.source ? this.source.attr("data-flare-system") : null;
						const f = id ? flareDetails.find(flareDetails.data(), id) : null;
						this.setContent(f ? flareDetails.tooltipHtml(f, flareDetails.nowSec()) : "");
					}
				});
			}
			flareDetails.tipBox.attach($("#chainMap .fork-flare-mark"));	// "shown": the catalog's exposed selector
		}
		const key = typeof viewingSystemID !== "undefined" ? viewingSystemID + "#" + flareDetails.panelKey(flareDetails.find(data, viewingSystemID), now) : "";
		if (key !== flareDetails.lastPanelKey && typeof systemPanel !== "undefined" && systemPanel.update) {
			flareDetails.lastPanelKey = key;
			try { systemPanel.update(); } catch (e) { /* the panel draws again on the next map draw */ }
		}
	},

	registerCommands: function() {
		if (typeof forkCommands === "undefined") { return; }
		forkCommands.register({
			id: "chain.flareSet", title: "Flare: set colour, reason and lifetime...", group: "Fleet", icon: "alert",
			keywords: ["mark", "colour", "reason", "forever", "label"],
			enabled: function(ctx) { return typeof commandPalette !== "undefined" && commandPalette.onChain(ctx.viewingSystemID) ? true : "Not on the chain map"; },
			run: function(args, ctx) { flareDetails.openDialog(ctx.viewingSystemID); }
		});
	},

	registerHint: function() {
		if (typeof forkHints === "undefined") { return; }
		// Right-click only, so easy to miss: when the map shows a flare that has no reason yet
		const target = function() {
			const f = flareDetails.list(flareDetails.data()).find(function(x) { return x && !x.reason && $("#chainMap [data-nodeid='" + Number(x.systemID) + "']:visible").length; });
			return f || null;
		};
		forkHints.register({
			id: "flareDetails.reason", feature: "flareDetails", section: "markers",
			trigger: "system.viewed", kind: "callout", placement: "right",
			eligible: function() { return !!target(); },
			anchor: function() { const f = target(); return f ? $("#chainMap [data-nodeid='" + Number(f.systemID) + "']")[0] : null; },
			title: "Say why it is flared",
			body: "A flare can carry a reason and last until removed instead of a day: right-click the system on the map and pick "
				+ "Flares, then Set flare. Everyone on your mask sees the reason in the system panel and on the map.\n\nTurn tips off in Settings > General.",
			action: { label: "Set flare...", run: function() { const f = target(); if (f) { flareDetails.openDialog(f.systemID); } } },
			priority: 40, maxShows: 2, cooldownHours: 72, ttlSeconds: 600
		});
	},

	/** Wrap chainObj.flares (upstream: colours the nodes): the data it is given becomes chainObj.data.flares BEFORE
		after(data) runs, so the system panel (systemPanel.update reads chain.data.flares) shows this refresh's flares, not
		the previous one's (chain.draw assigns the return value only afterwards). */
	hook: function(chainObj, after) {
		const orig = chainObj.flares;
		chainObj.flares = function(data) {
			if (data && chainObj.data) { chainObj.data.flares = data; }
			const out = orig.apply(this, arguments);
			try { after(data); } catch (e) { if (typeof console !== "undefined") { console.error("flare details", e); } }
			return out;
		};
	},

	init: function() {
		if (typeof chain === "undefined" || !chain || typeof chain.flares !== "function") { return; }
		// Upstream 2.0 crashed on the first map draw when flares weren't loaded yet: start with an empty list
		if (!chain.data.flares) { chain.data.flares = { flares: [] }; }
		flareDetails.hook(chain, function(data) { flareDetails.decorate(data); });
		flareDetails.registerCommands();
		flareDetails.registerHint();
		flareDetails.decorate(chain.data.flares);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { flareDetails.init(); });
}
