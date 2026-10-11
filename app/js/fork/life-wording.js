const lifeWording = {
	// Wormhole life wording (fork-owned). Since the Catalyst update (2026-03-18, patch 23.02) the game's Wormhole
	// Information window says "Reliable Lifetime" and has an "Expired" state ("appears when the guaranteed lifespan
	// of a wormhole has ended, and the wormhole could close at any moment"). Tripwire keeps its own Stable / EOL
	// buttons (a stored value, not a timer) and only adds tooltips that say which in-game wording each one means.

	TOOLTIPS: {
		wormholeLifeStable: "Stable: the game shows \"Reliable lifetime\" for this hole.",
		wormholeLifeEOL: "EOL: the hole is near the end of its life (the game shows \"Expired\" or a short time remaining). It can close at any moment."
	},

	apply: function() {
		Object.keys(lifeWording.TOOLTIPS).forEach(function(id) {
			const label = document.querySelector("label[for='" + id + "']");
			if (label && !label.getAttribute("data-tooltip")) { label.setAttribute("data-tooltip", lifeWording.TOOLTIPS[id]); }
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { lifeWording.apply(); });
}
