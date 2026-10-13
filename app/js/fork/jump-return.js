const jumpReturn = {
	// After the tracked character jumps outbound through a named hole (e.g. "AB", bookmarked "=AB ..." on the
	// home side), offer the return bookmark string ("!AB") in a small click-to-copy panel - by default only to
	// the first pilot through (see alreadyHandled). Setting: options.jumpReturn = {enabled, firstOnly} (missing = on).
	AUTO_HIDE_MS: 60000,
	RETRY_DELAYS_MS: [1500, 6000, 12000],
	JUMP_LOG_TIMEOUT_MS: 4000,
	COPIED_KEY: "tripwire_jumpReturn_copied",
	CREATE_WINDOW_MS: 5000,	// the automapper logs the jump that created a hole within this of the sigs' lifeTime
	OWN_EDIT_SLACK_MS: 15000,	// far-side edits by us this long before the jump was seen still count as "after it" (5 s ESI location poll + lag)

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
		unnamed or already a return bookmark ("!AB", or the older "<AB"). Returns e.g. "!AB", or null.
		The text comes from the mask's return template (Mask Admin > Bookmark names, default "!{name}"); extra is
		{type, size, classText, system, sigID} for its other tokens. */
	returnString: function(fromSigName, toSigName, extra) {
		const token = holeNaming.leadingToken(fromSigName);
		if (!token) { return null; }
		const toName = String(toSigName === undefined || toSigName === null ? "" : toSigName).trim();
		if (toName !== "" && !holeNaming.isReturnBookmark(toName) && holeNaming.leadingToken(toName)) { return null; }
		return bookmarkTemplate.render(bookmarkTemplate.active("back"), bookmarkTemplate.values(Object.assign({}, extra, { name: token, dir: "in" })));
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

	/** What the return template's other tokens ({type}, {size}, {class}, {system}, {sig}, {life}) are for a jump from -> to through
		hole (from findJumpHole): the hole's type and size, the class of the system it leads back to, the system the
		bookmark is saved in, and the signature ID of its sig there. Anything unknown is left out. */
	templateValues: function(hole, from, to, wormholes) {
		const wormhole = wormholes && wormholes[hole.wormholeId];
		const out = { sigID: hole.toSig && hole.toSig.signatureID, type: wormhole && wormhole.type };
		try {
			out.size = holeNaming.sizeLetter(out.type);
			out.system = holeNaming.systemName(to);
			if (wormhole && typeof lifeStates !== "undefined") { out.life = lifeStates.bookmarkLife(wormhole, lifeStates.sigsOf(wormhole), lifeStates.now(), lifeStates.isOn()); }
			if (typeof systemAnalysis !== "undefined") { out.classText = holeNaming.classText(systemAnalysis.analyse(from).systemTypeName); }
		} catch (e) { /* the other tokens stay empty */ }
		return out;
	},

	/** Return string and hole token for a jump, or null if no named outbound hole connects the systems.
		toSig / fromSig are the far-side (return) and near-side signatures, used by alreadyHandled. */
	forJump: function(from, to, wormholes, signatures) {
		const hole = jumpReturn.findJumpHole(from, to, wormholes, signatures);
		if (!hole) { return null; }
		const text = jumpReturn.returnString(hole.fromSig.name, hole.toSig.name, jumpReturn.templateValues(hole, from, to, wormholes));
		if (!text) { return null; }
		return { text: text, token: holeNaming.leadingToken(hole.fromSig.name), wormholeId: hole.wormholeId, toSig: hole.toSig, fromSig: hole.fromSig };
	},

	/** Character name without upstream's tracking visibility suffix ("Name|P", "Name|p", "Name|x" -> "Name") */
	baseName: function(name) {
		return name === undefined || name === null ? "" : String(name).split("|")[0].trim();
	},

	/** Milliseconds for a server time "YYYY-MM-DD HH:MM:SS" (UTC, like sig-age), or NaN */
	parseTime: function(value) {
		const m = String(value === undefined || value === null ? "" : value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
		return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
	},

	/** Has someone already started on the far side of this hole? Returns the reason (string), or null when
		this pilot is first through. In order:
		- the far-side (return) signature has a signature ID (at least its 3 letters): it was scanned from inside;
		- the far-side signature has a name (e.g. "!AB"): someone recorded the return;
		  (these two are skipped when one of our characters edited the far sig at or after this jump - minus
		  OWN_EDIT_SLACK_MS for location polling lag -: the first pilot may already have pasted sigs / set the return
		  sig before the hole was found. Note upstream bumps modifiedTime/modifiedByID on BOTH sigs on any wormhole
		  edit, so an edit from the home side made after the jump counts too; one before it doesn't.)
		- this browser already copied the return bookmark for this hole (copiedBefore);
		- the hole's jump log (upstream's mass log, mass.php) has a jump, either way, by a character that is not
		  one of ours, except the jump that created an automapped hole (within CREATE_WINDOW_MS of fromSig.lifeTime,
		  which wormhole edits don't change): a scout jumping an un-entered sig doesn't count once it's named.
		me: {names: [...], ids: [...]} (this browser's characters; names compared without upstream's "|P" suffix,
		any case), or just an array of names. jumps: [{characterName, time, ...}] or null/undefined when unknown
		(= none). jumpAt: ms (server clock) when this jump was seen, or undefined. */
	alreadyHandled: function(toSig, jumps, me, copiedBefore, fromSig, jumpAt) {
		const names = Array.isArray(me) ? me : (me && me.names) || [];
		const ids = (!Array.isArray(me) && me && me.ids) || [];
		const editedByMe = !!(toSig && toSig.modifiedByID && ids.some(function(id) { return id && id == toSig.modifiedByID; }));
		const editedAt = jumpReturn.parseTime(toSig && toSig.modifiedTime);
		const editedSinceJump = editedByMe && isFinite(jumpAt) && isFinite(editedAt) &&
			editedAt >= jumpAt - jumpReturn.OWN_EDIT_SLACK_MS;
		if (!editedSinceJump) {
			const sigID = toSig && toSig.signatureID ? String(toSig.signatureID) : "";
			if (/^[a-z]{3}/i.test(sigID)) { return "far side already has a signature ID"; }
			const name = toSig && toSig.name !== undefined && toSig.name !== null ? String(toSig.name).trim() : "";
			if (name !== "") { return "far side already named"; }
		}
		if (copiedBefore) { return "already copied"; }
		const mine = {};
		names.forEach(function(n) { const b = jumpReturn.baseName(n).toLowerCase(); if (b) { mine[b] = true; } });
		const created = jumpReturn.parseTime(fromSig && fromSig.lifeTime);
		const other = (Array.isArray(jumps) ? jumps : []).find(function(j) {
			const n = jumpReturn.baseName(j && j.characterName).toLowerCase();
			if (n === "" || mine[n]) { return false; }
			const at = jumpReturn.parseTime(j.time);
			return !(isFinite(created) && isFinite(at) && Math.abs(at - created) <= jumpReturn.CREATE_WINDOW_MS);
		});
		if (other) { return "already jumped by " + jumpReturn.baseName(other.characterName); }
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

		// Our own characters: the active one, every character tracked in this browser, and the logged-in character
		// (signature edits are recorded under the logged-in character's ID)
		function myCharacters() {
			const me = { names: [], ids: [] };
			function add(id, name) { if (id) { me.ids.push(id); } if (name) { me.names.push(name); } }
			if (tripwire.client && tripwire.client.EVE) { add(tripwire.client.EVE.characterID, tripwire.client.EVE.characterName); }
			const characters = (tripwire.esi && tripwire.esi.characters) || {};
			Object.keys(characters).forEach(function(id) {
				if (characters[id]) { add(characters[id].characterID || id, characters[id].characterName); }
			});
			const o = opts();
			if (o && o.character) { add(o.character.id, o.character.name); }
			return me;
		}

		function clearRetries() {
			retryTimers.forEach(function(t) { clearTimeout(t); });
			retryTimers = [];
		}

		function hidePanel() {
			clearTimeout(hideTimer);
			clearTimeout(fadeTimer);
			$("#jump-return-panel").remove();
			$("body").removeClass("jump-return-open");
		}

		function fadeOutPanel(delay) {
			clearTimeout(hideTimer);
			clearTimeout(fadeTimer);
			const $panel = $("#jump-return-panel");
			fadeTimer = setTimeout(function() {
				$panel.addClass("jump-return-fading");
				fadeTimer = setTimeout(function() { $panel.remove(); $("body").removeClass("jump-return-open"); }, 400);
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
			// Notices (jump mass prompt etc.) stack in the same top-right spot: push them below the panel
			document.documentElement.style.setProperty("--jump-return-height", ($panel.outerHeight() || 26) + "px");
			$("body").addClass("jump-return-open");
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
		// Server-clock now (sig-age's offset tracking when available), for comparing with server times
		function serverNow() {
			try { if (typeof sigAge !== "undefined" && typeof sigAge.now === "function") { return sigAge.now(); } } catch (e) { /* fall back */ }
			return Date.now();
		}

		function decide(seq, from, to, result, jumpAt) {
			if (!jumpReturn.firstOnly(opts())) { showPanel(from, to, result); return; }
			const copied = copiedList().some(function(id) { return id == result.wormholeId; });
			let reason = jumpReturn.alreadyHandled(result.toSig, null, myCharacters(), copied, result.fromSig, jumpAt);
			if (reason) { console.info("jump-return: not showing " + result.text + ", " + reason); return; }
			jumpLog(result.wormholeId).then(function(jumps) {
				if (seq !== jumpSeq) { return; }	// superseded by a newer jump
				const sigs = tripwire.client && tripwire.client.signatures;
				const toSig = (sigs && result.toSig && sigs[result.toSig.id]) || result.toSig;	// may have synced meanwhile
				const fromSig = (sigs && result.fromSig && sigs[result.fromSig.id]) || result.fromSig;
				reason = jumpReturn.alreadyHandled(toSig, jumps, myCharacters(), false, fromSig, jumpAt);
				if (reason) { console.info("jump-return: not showing " + result.text + ", " + reason); return; }
				showPanel(from, to, result);
			});
		}

		/** Check for a named hole; true if it was found (the panel may still be suppressed) */
		function attempt(seq, from, to, jumpAt) {
			if (seq !== jumpSeq) { return true; }	// superseded by a newer jump
			let result = null;
			try {
				result = jumpReturn.forJump(from, to, tripwire.client.wormholes, tripwire.client.signatures);
			} catch (e) {
				console.warn("jump-return: could not check the jump", e);
			}
			if (!result) { return false; }
			clearRetries();
			decide(seq, from, to, result, jumpAt);
			return true;
		}

		function onJump(from, to) {
			jumpSeq++;
			const seq = jumpSeq;
			const jumpAt = serverNow();
			clearRetries();
			hidePanel();
			if (!jumpReturn.enabled(opts())) { return; }
			bookmarkTemplate.ensureLoaded();	// the return string uses the mask's template (a no-op once read)
			if (attempt(seq, from, to, jumpAt)) { return; }
			// The automapper may still be adding/updating the hole: re-check after the next syncs
			jumpReturn.RETRY_DELAYS_MS.forEach(function(delay) {
				retryTimers.push(setTimeout(function() { attempt(seq, from, to, jumpAt); }, delay));
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

		// ---- Settings > Wormhole Jumps & Mass: "Return bookmark pop-up" (takes effect on Save; Reset = on, first-only) ----
		forkSettings.register({
			section: "jumps", order: 30, id: "jumpReturn-mode", type: "select", key: "jumpReturn",
			label: "Return bookmark pop-up:",
			choices: [["first", "Only when I'm first through"], ["always", "After every jump"], ["off", "Off"]],
			get: function() { return jumpReturn.modeFor(opts()); },
			set: function(o, mode) {
				o.jumpReturn = jumpReturn.optionsForMode(mode);
				if (!o.jumpReturn.enabled) { hidePanel(); }
			}
		});
	});
}
