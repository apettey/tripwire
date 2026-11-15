const campaignTags = {
	// Tags for Military Campaign caches and the Rampant Drone Fabricator in the signature list (fork-owned, see
	// changes/2026-11-15-campaign-fabricator-tags). Site names come from CCP's own notes only:
	//  - Fractured Skies expansion notes (2026-11-10): "Collapsed Drifter Cache" and "Fabricated Rogue Cache" are the
	//    Military Campaign caches; the most lucrative ones, and the Omega Logging and Rogue Stockpile containers, are in
	//    C1-C3 wormholes only.
	//  - Patch notes 24.01 (2026-07-23.1) and "Rampant Drone Fabricator sites are back": the "Rampant Drone Fabricator"
	//    is back in C1-C6 for good, up to 100 waves; its escalation follows "Rampancy" points of the ships near it, with
	//    escalations at 12, 36 and 72 (both the thresholds and the per-ship points are CCP's).
	// Anomalies the user hides (sig-anomalies.js) stay hidden: the tag lives in the row. Setting:
	// options.campaignTags.enabled (missing = on). Keep `const campaignTags` on the first line: the test helper
	// strips it to define a global.

	SOURCES: {
		fracturedSkies: "https://www.eveonline.com/news/view/fractured-skies-expansion-notes",
		patch2401: "https://www.eveonline.com/news/view/patch-notes-version-24-01",
		fabricatorNews: "https://www.eveonline.com/news/view/rampant-drone-fabricator-sites-are-back"
	},

	/** Sites by scanner name. aliases: other names CCP's notes use for the same site */
	SITES: [
		{ name: "Rampant Drone Fabricator", aliases: ["Rogue Drone Fabricator"], kind: "fabricator", tag: "Fabricator" },
		{ name: "Collapsed Drifter Cache", kind: "campaign", tag: "Campaign" },
		{ name: "Fabricated Rogue Cache", kind: "campaign", tag: "Campaign" }
	],

	/** Rampancy each ship near the Fabricator adds (patch 2026-07-23.1). Frigates and destroyers are not in CCP's table. */
	RAMPANCY: [
		{ id: "capital", label: "Capital (other)", points: 72 },
		{ id: "fax", label: "Force Auxiliary", points: 36 },
		{ id: "marauder", label: "Marauder", points: 12 },
		{ id: "blops", label: "Black Ops", points: 8 },
		{ id: "battleship", label: "Battleship (other)", points: 6 },
		{ id: "t3c", label: "Strategic Cruiser", points: 4 },
		{ id: "command", label: "Command Ship", points: 3 },
		{ id: "battlecruiser", label: "Battlecruiser (other)", points: 2 },
		{ id: "hac", label: "Heavy Assault Cruiser", points: 2 },
		{ id: "logi", label: "Logistics Cruiser", points: 2 },
		{ id: "cruiser", label: "Cruiser (other)", points: 1 }
	],

	/** Rampancy at which the escalations happen (patch 2026-07-23.1) */
	THRESHOLDS: [12, 36, 72],
	ESCALATIONS: ["no escalation", "first escalation (the old battleship escalation)", "second escalation", "final escalation (the old capital escalation)"],

	/** Whether the feature is on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.campaignTags && opts.campaignTags.enabled === false);
	},

	key: function(name) {
		return String(name === undefined || name === null ? "" : name).trim().replace(/\s+/g, " ").toLowerCase();
	},

	/** The site for a signature (client shape), or null; never for wormholes */
	siteFor: function(sig) {
		if (!sig || sig.type === "wormhole") { return null; }
		const k = campaignTags.key(sig.name);
		if (!k) { return null; }
		for (let i = 0; i < campaignTags.SITES.length; i++) {
			const s = campaignTags.SITES[i];
			if ([s.name].concat(s.aliases || []).some(function(n) { return campaignTags.key(n) === k; })) { return s; }
		}
		return null;
	},

	/** Rampancy of a group of ships.
	@param counts {shipClassID: number of ships} (ids of RAMPANCY; anything else counts 0)
	@return {points, escalation (0 none .. 3 final), next (Rampancy of the next escalation, or null after the last)} */
	rampancy: function(counts) {
		let points = 0;
		campaignTags.RAMPANCY.forEach(function(r) {
			const n = Math.floor(Number(counts && counts[r.id]));
			if (n > 0) { points += n * r.points; }
		});
		const escalation = campaignTags.THRESHOLDS.filter(function(t) { return points >= t; }).length;
		return { points: points, escalation: escalation, next: escalation < campaignTags.THRESHOLDS.length ? campaignTags.THRESHOLDS[escalation] : null };
	},

	/** One line describing a rampancy() result */
	rampancyText: function(r) {
		return "Rampancy " + r.points + ": " + campaignTags.ESCALATIONS[r.escalation]
			+ (r.next !== null ? "; next escalation at " + r.next + "." : ".");
	},

	/** Tooltip HTML (texts are our own constants and numbers).
	@param systemClass the wormhole class (1-6) of the sig's system, or null (k-space, unknown) */
	tooltip: function(site, systemClass) {
		if (!site) { return ""; }
		if (site.kind === "fabricator") {
			return "<b>Rampant Drone Fabricator</b><br>"
				+ "Rogue drone waves that escalate with the ships near the Fabricator, up to 100 waves. Rewards grow with every "
				+ "wave you clear and you can leave with your loot at any time. Built for small teams; CCP says solo pilots are "
				+ "unlikely to get much past wave 40. Back in C1-C6 wormholes for good (patch 24.01).<br>"
				+ "Escalations at " + campaignTags.THRESHOLDS.join(", ") + " Rampancy. Click the tag to add up your fleet's Rampancy.";
		}
		const lowClass = systemClass >= 1 && systemClass <= 3;
		return "<b>" + site.name + "</b> (Military Campaign cache)<br>"
			+ "Hack it for data for the empires' research projects. It can drop the new Aberrant modules, Penumbral Shadows SKINs "
			+ "and hardwirings that reduce rig drawbacks (Fractured Skies).<br>"
			+ (lowClass
				? "This is a C" + systemClass + " wormhole: C1-C3 have the most lucrative caches and the only Omega Logging and Rogue Stockpile containers, the best chance of an Aberrant module."
				: "The most lucrative caches, and the Omega Logging and Rogue Stockpile containers, are in C1-C3 wormholes.");
	},

	// ---- DOM ----

	/** The wormhole class of a system id, or null */
	systemClass: function(systemID) {
		const s = typeof appData !== "undefined" && appData.systems ? appData.systems[systemID] : null;
		const c = s ? Number(s["class"]) : NaN;
		return c >= 1 && c <= 6 ? c : null;
	},

	apply: function() {
		if (typeof tripwire === "undefined" || !tripwire.client) { return; }
		const on = campaignTags.enabled(typeof options !== "undefined" ? options : undefined);
		const signatures = tripwire.client.signatures || {};
		$("#sigTable tbody tr[data-id]").each(function() {
			const $cell = $(this).children("td").eq(3);
			const sig = signatures[$(this).attr("data-id")];
			const site = on ? campaignTags.siteFor(sig) : null;
			let $tag = $cell.children(".campaign-tag");
			if (!site) { $tag.remove(); return; }
			const tip = campaignTags.tooltip(site, campaignTags.systemClass(sig.systemID));
			if ($tag.length && $tag.text() === site.tag && $tag.attr("data-tooltip") === tip) { return; }
			if (!$tag.length) {
				// after the name (and any value chip), so the Leads To column still sorts by name
				$tag = $("<span class=\"campaign-tag\"></span>").appendTo($cell);
			}
			$tag.text(site.tag).attr("data-tooltip", tip)
				.toggleClass("campaign-tag-fabricator", site.kind === "fabricator")
				.attr("role", site.kind === "fabricator" ? "button" : null)
				.attr("tabindex", site.kind === "fabricator" ? "0" : null);
			const box = campaignTags.tipBox();
			if (box && !$tag.data("campaignTip")) {
				box.attach($tag);
				$tag.data("campaignTip", true);
			}
		});
	},

	box: null,
	/** Tooltip opened beside the right edge of the name cell (as site-values.js does), not over the rows around it */
	tipBox: function() {
		if (campaignTags.box || typeof jBox === "undefined") { return campaignTags.box; }
		campaignTags.box = new jBox("Tooltip", {
			getContent: "data-tooltip",
			position: { x: "right", y: "center" },
			outside: "x",
			repositionOnOpen: true,
			onOpen: function() {
				const tag = this.source && this.source[0], cell = tag && this.source.closest("td")[0];
				const gap = cell ? Math.max(0, cell.getBoundingClientRect().right - tag.getBoundingClientRect().right) : 0;
				this.options.offset = { x: gap, y: 0 };
			}
		});
		return campaignTags.box;
	},

	scheduled: null,
	schedule: function() {
		if (campaignTags.scheduled) { return; }
		campaignTags.scheduled = setTimeout(function() { campaignTags.scheduled = null; campaignTags.apply(); }, 50);
	},

	// ---- Rampancy counter (a small pop-up from the Fabricator tag) ----

	counts: {},

	closeCounter: function() {
		$("#campaignRampancy").remove();
		$(document).off(".campaignRampancy");
	},

	openCounter: function(anchor) {
		campaignTags.closeCounter();
		if (campaignTags.box) { campaignTags.box.close(); }
		const rows = campaignTags.RAMPANCY.map(function(r) {
			return "<tr><td>" + r.label + "</td><td class=\"campaign-rampancy-pts\">" + r.points + "</td>"
				+ "<td><input type=\"number\" min=\"0\" max=\"99\" step=\"1\" data-ship=\"" + r.id + "\" value=\"" + (campaignTags.counts[r.id] || "") + "\" aria-label=\"" + r.label + "\"></td></tr>";
		}).join("");
		const $pop = $("<div id=\"campaignRampancy\" role=\"dialog\" aria-label=\"Rampancy counter\">"
			+ "<div class=\"campaign-rampancy-title\">Rampancy counter <a href=\"#\" class=\"campaign-rampancy-close\" aria-label=\"Close\">&times;</a></div>"
			+ "<table><tr><th>Ships near the Fabricator</th><th>Each</th><th>How many</th></tr>" + rows + "</table>"
			+ "<div class=\"campaign-rampancy-result\"></div>"
			+ "<div class=\"campaign-rampancy-note\">Points per ship and escalations at 12, 36 and 72: CCP, patch 24.01. Frigates and destroyers aren't in CCP's table.</div>"
			+ "</div>").appendTo("body");
		const update = function() {
			$pop.find("input[data-ship]").each(function() {
				const n = Math.max(0, Math.floor(Number(this.value) || 0));
				campaignTags.counts[$(this).attr("data-ship")] = n;
			});
			const r = campaignTags.rampancy(campaignTags.counts);
			$pop.find(".campaign-rampancy-result").text(campaignTags.rampancyText(r)).attr("data-escalation", r.escalation);
		};
		$pop.on("input", "input", update);
		$pop.on("click", ".campaign-rampancy-close", function(e) { e.preventDefault(); campaignTags.closeCounter(); });
		update();
		const a = anchor.getBoundingClientRect();
		const w = $pop.outerWidth(), h = $pop.outerHeight();
		$pop.css({
			left: Math.max(4, Math.min(window.innerWidth - w - 4, a.left)) + "px",
			top: Math.max(4, a.bottom + h + 4 > window.innerHeight ? a.top - h - 4 : a.bottom + 4) + "px"
		});
		$pop.find("input").first().trigger("focus");
		setTimeout(function() {
			$(document).on("mousedown.campaignRampancy", function(e) { if (!$(e.target).closest("#campaignRampancy").length) { campaignTags.closeCounter(); } });
			$(document).on("keydown.campaignRampancy", function(e) { if (e.key === "Escape") { campaignTags.closeCounter(); } });
		}, 0);
		if (typeof forkUsage !== "undefined") { forkUsage.track("campaignTags", "opened"); }
	},

	setupSettings: function() {
		forkSettings.register({
			section: "signatures", order: 43, id: "campaignTags-enabled", type: "checkbox", key: "campaignTags",
			label: "Campaign and Fabricator tags:", text: "Tag Military Campaign caches and Rampant Drone Fabricators",
			get: function(o) { return campaignTags.enabled(o); },
			set: function(o, on) { o.campaignTags = { enabled: on }; }
		});
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.campaignTagsWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				campaignTags.schedule();
				return result;
			};
			options.apply.campaignTagsWrapped = true;
		}
	},

	init: function() {
		campaignTags.setupSettings();
		// the tag sits in a row: don't let the click (or a double-click, which opens the edit dialog) reach upstream's
		// row handlers, delegated on the same tbody (jQuery runs the handler of the deeper element first)
		$("#sigTable tbody").on("dblclick", ".campaign-tag-fabricator", function(e) { e.stopPropagation(); });
		$("#sigTable tbody").on("click", ".campaign-tag-fabricator", function(e) {
			e.stopPropagation();
			campaignTags.openCounter(this);
		}).on("keydown", ".campaign-tag-fabricator", function(e) {
			if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); campaignTags.openCounter(this); }
		});
		const tbody = document.querySelector("#sigTable > tbody");
		if (tbody && typeof MutationObserver !== "undefined") {
			new MutationObserver(campaignTags.schedule).observe(tbody, { childList: true });
		}
		campaignTags.schedule();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { campaignTags.init(); });
}
