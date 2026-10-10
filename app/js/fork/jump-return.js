const jumpReturn = {
	// After the tracked character jumps outbound through a named hole (e.g. "AB", bookmarked "=AB ..." on the
	// home side), offer the return bookmark string ("<AB") in a click-to-copy panel.
	AUTO_HIDE_MS: 60000,
	RETRY_DELAYS_MS: [1500, 6000, 12000],

	/** Detect a jump of the same character between two tracked locations.
		@param prev previous tripwire.client.EVE (or undefined), next the new EVE data
		@return {from, to} or null (first call, character change/switch, no location, same system) */
	detectJump: function(prev, next, characterChange) {
		if (characterChange || !prev || !next) { return null; }
		if (!prev.systemID || !next.systemID || prev.systemID == next.systemID) { return null; }
		if (prev.characterID && next.characterID && prev.characterID != next.characterID) { return null; }
		return { from: prev.systemID, to: next.systemID };
	},

	/** Return bookmark string for a hole jumped from the side named fromSigName to the side named toSigName.
		Only outbound jumps through a named hole count: the from side has a name token and the to side is
		unnamed or already a return bookmark ("<AB"). Returns e.g. "<AB", or null. */
	returnString: function(fromSigName, toSigName) {
		const token = holeNaming.leadingToken(fromSigName);
		if (!token) { return null; }
		const toName = String(toSigName === undefined || toSigName === null ? "" : toSigName).trim();
		if (toName !== "" && toName.charAt(0) !== "<" && holeNaming.leadingToken(toName)) { return null; }
		return "<" + token;
	},

	/** Wormhole connecting system from -> to (either sig orientation).
		With several, prefer one that yields a return string, then one whose from-side sig is named,
		then the lowest wormhole id.
		@return {wormholeId, fromSig, toSig} or null */
	findJumpHole: function(from, to, wormholes, signatures) {
		if (!wormholes || !signatures || from == to) { return null; }
		let best = null, bestScore = -1;
		Object.keys(wormholes).forEach(function(key) {
			const wormhole = wormholes[key];
			if (!wormhole) { return; }
			const a = signatures[wormhole.initialID], b = signatures[wormhole.secondaryID];
			if (!a || !b) { return; }
			let fromSig, toSig;
			if (a.systemID == from && b.systemID == to) { fromSig = a; toSig = b; }
			else if (b.systemID == from && a.systemID == to) { fromSig = b; toSig = a; }
			else { return; }
			const score = jumpReturn.returnString(fromSig.name, toSig.name) ? 2 :
				holeNaming.leadingToken(fromSig.name) ? 1 : 0;
			const id = Number(wormhole.id !== undefined ? wormhole.id : key);
			if (score > bestScore || (score === bestScore && id < best.wormholeId)) {
				best = { wormholeId: id, fromSig: fromSig, toSig: toSig };
				bestScore = score;
			}
		});
		return best;
	},

	/** Return string and hole token for a jump, or null if no named outbound hole connects the systems. */
	forJump: function(from, to, wormholes, signatures) {
		const hole = jumpReturn.findJumpHole(from, to, wormholes, signatures);
		if (!hole) { return null; }
		const text = jumpReturn.returnString(hole.fromSig.name, hole.toSig.name);
		if (!text) { return null; }
		return { text: text, token: holeNaming.leadingToken(hole.fromSig.name), wormholeId: hole.wormholeId };
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined" || typeof tripwire.EVE !== "function") { return; }

		let jumpSeq = 0;
		let retryTimers = [];
		let hideTimer = null, fadeTimer = null;

		function systemName(systemID) {
			const system = (typeof appData !== "undefined" && appData.systems && appData.systems[systemID]) ||
				(tripwire.systems && tripwire.systems[systemID]);
			return system && system.name ? system.name : String(systemID);
		}

		function clearRetries() {
			retryTimers.forEach(function(t) { clearTimeout(t); });
			retryTimers = [];
		}

		function hidePanel() {
			clearTimeout(hideTimer);
			clearTimeout(fadeTimer);
			$("#jump-return-panel").remove();
		}

		function fadeOutPanel(delay) {
			clearTimeout(hideTimer);
			clearTimeout(fadeTimer);
			const $panel = $("#jump-return-panel");
			fadeTimer = setTimeout(function() {
				$panel.addClass("jump-return-fading");
				fadeTimer = setTimeout(function() { $panel.remove(); }, 400);
			}, delay);
		}

		function showPanel(from, to, result) {
			hidePanel();
			const $panel = $("<div id='jump-return-panel' role='dialog' aria-live='polite' tabindex='-1'></div>");
			const $label = $("<div class='jump-return-label'></div>").text(
				"Jumped " + systemName(from) + " → " + systemName(to) + " via " + result.token +
				" · click to copy return bookmark");
			const $button = $("<button type='button' class='jump-return-copy'></button>").text(result.text)
				.attr("title", "Copy " + result.text);
			const $close = $("<button type='button' class='jump-return-close' aria-label='Close'>✕</button>");
			$panel.append($close, $label, $button);

			function copy() {
				const copier = holeNaming.copyText;
				const promise = copier ? copier(result.text) : Promise.resolve(false);
				promise.then(function(ok) {
					if (ok) {
						$button.text("Copied ✓").addClass("jump-return-copied");
						fadeOutPanel(1200);
					} else {
						$label.text("Copy failed - select and copy manually:");
						$button.text(result.text);
					}
				});
			}

			$button.on("click", function(e) { e.preventDefault(); copy(); });
			$close.on("click", function(e) { e.preventDefault(); hidePanel(); });
			$panel.on("keydown", function(e) {
				if (e.key === "Enter" && !$(e.target).is(".jump-return-close")) { e.preventDefault(); copy(); }
				else if (e.key === "Escape") { hidePanel(); }
			});

			$("body").append($panel);
			hideTimer = setTimeout(function() { fadeOutPanel(0); }, jumpReturn.AUTO_HIDE_MS);
		}

		/** Check for a named hole; true if the panel was shown */
		function attempt(seq, from, to) {
			if (seq !== jumpSeq) { return true; }	// superseded by a newer jump
			let result = null;
			try {
				result = jumpReturn.forJump(from, to, tripwire.client.wormholes, tripwire.client.signatures);
			} catch (e) {
				console.warn("jump-return: could not check the jump", e);
			}
			if (!result) { return false; }
			clearRetries();
			showPanel(from, to, result);
			return true;
		}

		function onJump(from, to) {
			jumpSeq++;
			const seq = jumpSeq;
			clearRetries();
			hidePanel();
			if (attempt(seq, from, to)) { return; }
			// The automapper may still be adding/updating the hole: re-check after the next syncs
			jumpReturn.RETRY_DELAYS_MS.forEach(function(delay) {
				retryTimers.push(setTimeout(function() { attempt(seq, from, to); }, delay));
			});
		}
		jumpReturn.onJump = onJump;	// handy for testing from the console
		jumpReturn.hide = hidePanel;

		const originalEVE = tripwire.EVE;
		tripwire.EVE = function(EVE, characterChange) {
			const prev = this.client && this.client.EVE ? {
				systemID: this.client.EVE.systemID,
				characterID: this.client.EVE.characterID
			} : null;
			const ret = originalEVE.apply(this, arguments);
			try {
				const jump = jumpReturn.detectJump(prev, EVE || null, characterChange);
				if (jump) { onJump(jump.from, jump.to); }
			} catch (e) {
				console.warn("jump-return: jump detection failed", e);
			}
			return ret;
		};
	});
}
