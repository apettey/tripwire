const jumpReturn = {
	// After the tracked character jumps outbound through a named hole (e.g. "AB", bookmarked "=AB ..." on the
	// home side), offer the return bookmark string ("<AB") in a small click-to-copy panel - by default only to
	// the first pilot through (see firstThrough). Setting: options.jumpReturn = {enabled, firstOnly} (missing = on).
	AUTO_HIDE_MS: 60000,
	RETRY_DELAYS_MS: [1500, 6000, 12000],
	JUMP_LOG_TIMEOUT_MS: 4000,
	COPIED_KEY: "tripwire_jumpReturn_copied",

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

	/** Return string and hole token for a jump, or null if no named outbound hole connects the systems.
		toSig is the far-side (return) signature, used by firstThrough. */
	forJump: function(from, to, wormholes, signatures) {
		const hole = jumpReturn.findJumpHole(from, to, wormholes, signatures);
		if (!hole) { return null; }
		const text = jumpReturn.returnString(hole.fromSig.name, hole.toSig.name);
		if (!text) { return null; }
		return { text: text, token: holeNaming.leadingToken(hole.fromSig.name), wormholeId: hole.wormholeId, toSig: hole.toSig };
	},

	/** Has someone already started on the far side of this hole? Returns the reason (string), or null when
		this pilot is first through. In order:
		- the far-side (return) signature has a signature ID (at least its 3 letters): it was scanned from inside;
		- the far-side signature has a name (e.g. "<AB"): someone recorded the return;
		- this browser already copied the return bookmark for this hole (copiedBefore);
		- the hole's jump log (upstream's mass log, mass.php) has a jump, either way, by a character that is not
		  one of ours (myNames: this browser's tracked characters, compared case-insensitively).
		jumps: [{characterName, ...}] or null/undefined when unknown (counts as no jumps). */
	alreadyHandled: function(toSig, jumps, myNames, copiedBefore) {
		const sigID = toSig && toSig.signatureID ? String(toSig.signatureID) : "";
		if (/^[a-z]{3}/i.test(sigID)) { return "far side already has a signature ID"; }
		const name = toSig && toSig.name !== undefined && toSig.name !== null ? String(toSig.name).trim() : "";
		if (name !== "") { return "far side already named"; }
		if (copiedBefore) { return "already copied"; }
		const mine = {};
		(myNames || []).forEach(function(n) { if (n) { mine[String(n).trim().toLowerCase()] = true; } });
		const other = (Array.isArray(jumps) ? jumps : []).find(function(j) {
			const n = j && j.characterName ? String(j.characterName).trim().toLowerCase() : "";
			return n !== "" && !mine[n];
		});
		if (other) { return "already jumped by " + other.characterName; }
		return null;
	},

	/** Whether the feature is on (missing = on) */
	enabled: function(opts) {
		return !(opts && opts.jumpReturn && opts.jumpReturn.enabled === false);
	},

	/** Whether to show the panel only to the first pilot through (missing = yes) */
	firstOnly: function(opts) {
		return !(opts && opts.jumpReturn && opts.jumpReturn.firstOnly === false);
	},

	/** Settings select value <-> options: "first" (default), "always", "off" */
	modeFor: function(opts) {
		return !jumpReturn.enabled(opts) ? "off" : jumpReturn.firstOnly(opts) ? "first" : "always";
	},
	optionsForMode: function(mode) {
		return mode === "off" ? { enabled: false, firstOnly: true } :
			mode === "always" ? { enabled: true, firstOnly: false } : { enabled: true, firstOnly: true };
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined" || typeof tripwire.EVE !== "function") { return; }

		let jumpSeq = 0;
		let retryTimers = [];
		let hideTimer = null, fadeTimer = null;

		function opts() { return typeof options !== "undefined" ? options : undefined; }

		function systemName(systemID) {
			const system = (typeof appData !== "undefined" && appData.systems && appData.systems[systemID]) ||
				(tripwire.systems && tripwire.systems[systemID]);
			return system && system.name ? system.name : String(systemID);
		}

		// Holes whose return bookmark this browser already copied (this session)
		function copiedList() {
			try { return JSON.parse(sessionStorage.getItem(jumpReturn.COPIED_KEY) || "[]") || []; } catch (e) { return []; }
		}
		function rememberCopied(wormholeId) {
			try {
				const list = copiedList().filter(function(id) { return id != wormholeId; }).slice(-49);
				list.push(wormholeId);
				sessionStorage.setItem(jumpReturn.COPIED_KEY, JSON.stringify(list));
			} catch (e) { /* storage unavailable: only affects repeat pop-ups */ }
		}

		// Our own characters: the active one and every character tracked in this browser
		function myNames() {
			const names = [];
			if (tripwire.client && tripwire.client.EVE && tripwire.client.EVE.characterName) { names.push(tripwire.client.EVE.characterName); }
			const characters = (tripwire.esi && tripwire.esi.characters) || {};
			Object.keys(characters).forEach(function(id) {
				if (characters[id] && characters[id].characterName) { names.push(characters[id].characterName); }
			});
			return names;
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
			const summary = "Jumped " + systemName(from) + " → " + systemName(to) + " via " + result.token;
			const $panel = $("<div id='jump-return-panel' role='dialog' aria-live='polite' tabindex='-1'></div>")
				.attr({ "aria-label": summary + ". Return bookmark " + result.text, title: summary });
			const $label = $("<span class='jump-return-label'>Return bookmark</span>");
			const $button = $("<button type='button' class='jump-return-copy'></button>")
				.attr("title", "Copy " + result.text + " (bookmark name for the way back to " + systemName(from) + ")");
			const $text = $("<span class='jump-return-text'></span>").text(result.text);
			const $hint = $("<span class='jump-return-hint'>copy</span>");
			$button.append($text, $hint);
			const $close = $("<button type='button' class='jump-return-close' aria-label='Close'>✕</button>");
			$panel.append($label, $button, $close);

			function copy() {
				const copier = holeNaming.copyText;
				const promise = copier ? copier(result.text) : Promise.resolve(false);
				promise.then(function(ok) {
					if (ok) {
						rememberCopied(result.wormholeId);
						$hint.text("copied ✓");
						$button.addClass("jump-return-copied");
						fadeOutPanel(1200);
					} else {
						$label.text("Copy failed, copy by hand:");
						$panel.addClass("jump-return-failed");
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

		/** The hole's jump log (upstream's mass panel data); resolves to the jumps, or null if unavailable */
		function jumpLog(wormholeId) {
			return new Promise(function(resolve) {
				$.ajax({
					url: "mass.php",
					type: "POST",
					data: { wormholeID: wormholeId },
					dataType: "JSON",
					timeout: jumpReturn.JUMP_LOG_TIMEOUT_MS
				}).done(function(data) {
					resolve(data && Array.isArray(data.jumps) ? data.jumps : null);
				}).fail(function() { resolve(null); });
			});
		}

		/** Show the panel unless someone was through first (and the user wants first-only) */
		function decide(seq, from, to, result) {
			if (!jumpReturn.firstOnly(opts())) { showPanel(from, to, result); return; }
			const copied = copiedList().some(function(id) { return id == result.wormholeId; });
			let reason = jumpReturn.alreadyHandled(result.toSig, null, myNames(), copied);
			if (reason) { console.info("jump-return: not showing " + result.text + ", " + reason); return; }
			jumpLog(result.wormholeId).then(function(jumps) {
				if (seq !== jumpSeq) { return; }	// superseded by a newer jump
				const sigs = tripwire.client && tripwire.client.signatures;
				const toSig = (sigs && result.toSig && sigs[result.toSig.id]) || result.toSig;	// may have synced meanwhile
				reason = jumpReturn.alreadyHandled(toSig, jumps, myNames(), false);
				if (reason) { console.info("jump-return: not showing " + result.text + ", " + reason); return; }
				showPanel(from, to, result);
			});
		}

		/** Check for a named hole; true if it was found (the panel may still be suppressed) */
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
			decide(seq, from, to, result);
			return true;
		}

		function onJump(from, to) {
			jumpSeq++;
			const seq = jumpSeq;
			clearRetries();
			hidePanel();
			if (!jumpReturn.enabled(opts())) { return; }
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

		// ---- Settings > General Preferences: "Return bookmark pop-up" (takes effect on Save) ----
		const $table = $("#dialog-options #optionsAccordion > div").eq(2).find("table.optionsTable").first();
		if ($table.length && !$("#jumpReturn-mode").length) {
			$table.append("<tr><th>Return bookmark pop-up:</th><td><select id='jumpReturn-mode'>" +
				"<option value='first'>Only when I'm first through</option>" +
				"<option value='always'>After every jump</option>" +
				"<option value='off'>Off</option></select></td></tr>");
		}
		$(document).on("dialogopen", "#dialog-options", function() {
			$("#jumpReturn-mode").val(jumpReturn.modeFor(opts()));
		});
		// Capture phase so the value is in place before upstream's Save handler saves
		document.addEventListener("click", function(e) {
			const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
			if (!button || $.trim($(button).text()) !== "Save") { return; }
			if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#jumpReturn-mode").length) { return; }
			options.jumpReturn = jumpReturn.optionsForMode($("#jumpReturn-mode").val());
			if (!options.jumpReturn.enabled) { hidePanel(); }
		}, true);
		// Settings > Reset: a missing key means on, first-only
		if (typeof options !== "undefined" && typeof options.reset === "function" && !options.reset.jumpReturnWrapped) {
			const reset = options.reset;
			const wrapped = function() {
				const result = reset.apply(this, arguments);
				delete this.jumpReturn;
				return result;
			};
			Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
			wrapped.jumpReturnWrapped = true;
			options.reset = wrapped;
		}
	});
}
