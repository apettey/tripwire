const lifeWording = {
	// Wormhole life wording (fork-owned). Since the Catalyst update (2026-03-18, patch 23.02) the game's Wormhole
	// Information window says "Reliable lifetime", "less than 4 hours", "less than 1 hour" or "Expired" ("appears when
	// the guaranteed lifespan of a wormhole has ended, and the wormhole could close at any moment"). These are the
	// tooltips of the signature dialog's life buttons: Stable | <4h | <1h | Expired (life-states.js), or upstream's
	// Stable | EOL when that setting is off.

	TOOLTIPS: {
		wormholeLifeStable: "Stable: the game shows \"Reliable lifetime\" for this hole.",
		wormholeLifeEOL: "EOL: the hole is near the end of its life (the game shows \"less than 4 hours\", \"less than 1 hour\" or \"Expired\"). It can close at any moment.",
		wormholeLifeLt4h: "<4h: the game shows \"less than 4 hours\". Sets the hole's timer to 4 hours, unless it is already between 1 and 4 hours.",
		wormholeLifeLt1h: "<1h: the game shows \"less than 1 hour\". Sets the hole's timer to 1 hour, unless it is already under 1 hour.",
		wormholeLifeExpired: "Expired: the game shows \"Expired\"; the hole can close at any moment. Tripwire removes it a while after expiry (a tenth of its life length)."
	},

	/** Tooltip text for a life button (by its input id); statesOn: the four-state buttons are shown, so upstream's
	EOL button means "<4h" */
	tooltipFor: function(id, statesOn) {
		if (id === "wormholeLifeEOL" && statesOn) { return lifeWording.TOOLTIPS.wormholeLifeLt4h; }
		return lifeWording.TOOLTIPS[id] || "";
	},

	IDS: ["wormholeLifeStable", "wormholeLifeEOL", "wormholeLifeLt1h", "wormholeLifeExpired"],

	apply: function() {
		const statesOn = typeof lifeStates !== "undefined" && lifeStates.isOn();
		lifeWording.IDS.forEach(function(id) {
			const label = document.querySelector("label[for='" + id + "']");
			if (!label) { return; }
			label.setAttribute("data-tooltip", lifeWording.tooltipFor(id, statesOn));
			if (typeof Tooltips !== "undefined" && Tooltips.attach && typeof $ !== "undefined") { Tooltips.attach($(label)); }
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { lifeWording.apply(); });
}
