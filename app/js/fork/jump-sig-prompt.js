const jumpSigPrompt = {
	// "Which signature did you jump through?": after the tracked character jumps through a wormhole and the automapper
	// could not tie the jump to a scanned signature (it made a bare "???" hole), a small non-modal panel lists the wormhole
	// signatures of the two systems that are not linked to a system yet. Picking one links that hole to the jump
	// (and removes the bare hole the automapper made), copies the bookmark string from the mask's template, and can be undone;
	// "New sig..." opens the Edit Signature dialog of the hole instead, "Skip" closes the panel. Jumping is never blocked.
	// Best practice is to set the hole before jumping, so it is mask-wide configurable (Mask Admin > Bookmarks: off / only
	// when no signature matches (default) / after every jump not tied to a signature) and per user (Settings > Wormhole Jumps
	// & Mass, options.jumpSigPrompt = {enabled}, missing = on).
	// The automapper's own "Which Signature?" picker (app/js/tripwire/automapper.js) is never doubled: while it is open
	// (automapState.pendingDecision), or was open for this jump, nothing is shown.
	// Keep `const jumpSigPrompt` on the first line: the test helper strips it to define a global.
	RETRY_DELAYS_MS: [2500, 6000, 11000],	// the automapper's hole reaches the client with the next syncs
	AUTO_HIDE_MS: 90000,
	JUMP_WINDOW_MS: 60000,	// a jump logged on a hole this long before the jump was seen (or later) is this pilot's
	MAX_ROWS: 8,
	MODES: ["off", "nomatch", "always"],
	REAL_SYSTEM: 30000000,	// ids below this are generic "Leads To" types (Class-3, High-Sec ...), not systems

	/** The mask-wide mode (Mask Admin): "off" | "nomatch" (default) | "always" */
	mode: function(value) {
		return jumpSigPrompt.MODES.indexOf(value) >= 0 ? value : "nomatch";
	},

	/** The per-user setting: on unless options.jumpSigPrompt.enabled is false */
	userEnabled: function(opts) {
		return !(opts && opts.jumpSigPrompt && opts.jumpSigPrompt.enabled === false);
	},

	/** Whether the prompt may show at all: the mask has not turned it off and the user has not hidden it */
	active: function(maskMode, opts) {
		return jumpSigPrompt.mode(maskMode) !== "off" && jumpSigPrompt.userEnabled(opts);
	},

	/** Has the signature been scanned (its ID has at least the three letters)? */
	hasId: function(sig) {
		return !!sig && /^[a-z]{3}/i.test(String(sig.signatureID === undefined || sig.signatureID === null ? "" : sig.signatureID));
	},

	isNamed: function(sig) {
		return !!sig && String(sig.name === undefined || sig.name === null ? "" : sig.name).trim() !== "";
	},

	/** Is a signature's far side still unset (no system, or a generic Leads To)? */
	isUnset: function(systemID) {
		return !(Number(systemID) >= jumpSigPrompt.REAL_SYSTEM);
	},

	/** Holes between the two systems of a jump, either orientation, lowest wormhole id first.
		@return [{wormhole, fromSig, toSig}] with fromSig in `from` and toSig in `to` */
	holesBetween: function(from, to, wormholes, signatures) {
		const found = [];
		Object.keys(wormholes || {}).forEach(function(key) {
			const wormhole = wormholes[key];
			const a = wormhole && signatures && signatures[wormhole.initialID], b = wormhole && signatures && signatures[wormhole.secondaryID];
			if (!a || !b) { return; }
			if (a.systemID == from && b.systemID == to) { found.push({ wormhole: wormhole, fromSig: a, toSig: b }); }
			else if (b.systemID == from && a.systemID == to) { found.push({ wormhole: wormhole, fromSig: b, toSig: a }); }
		});
		return found.sort(function(x, y) { return Number(x.wormhole.id) - Number(y.wormhole.id); });
	},

	/** A hole nobody has filled in: neither side has a signature ID or a name and the hole has no type. This is what the
		automapper makes when no signature matches the jump. */
	isBare: function(hole) {
		const s = jumpSigPrompt;
		return !s.hasId(hole.fromSig) && !s.hasId(hole.toSig) && !s.isNamed(hole.fromSig) && !s.isNamed(hole.toSig) && !hole.wormhole.type;
	},

	/** Is this hole one to ask about? "nomatch": only a bare hole (the automapper found no signature). "always": also a hole
		someone already named, as long as neither side has a signature ID and no type is set (nothing but a name is lost when it
		is replaced by the linked signature, and the name moves over). Never "off". */
	asks: function(mode, hole) {
		mode = jumpSigPrompt.mode(mode);
		if (mode === "off") { return false; }
		if (mode === "always") { return !jumpSigPrompt.hasId(hole.fromSig) && !jumpSigPrompt.hasId(hole.toSig) && !hole.wormhole.type; }
		return jumpSigPrompt.isBare(hole);
	},

	/** The first hole of the jump to ask about, or null */
	holeToAsk: function(mode, from, to, wormholes, signatures) {
		const holes = jumpSigPrompt.holesBetween(from, to, wormholes, signatures);
		return holes.filter(function(h) { return jumpSigPrompt.asks(mode, h); })[0] || null;
	},

	/** The wormhole signatures of the two systems that are not linked to a system yet (the ones to choose from), the system you
		left first, then the one you arrived in, each by wormhole id. exclude: the wormhole id of the hole being asked about.
		@return [{wormholeId, wormhole, sig, other, side: "from" | "to"}] */
	candidates: function(from, to, wormholes, signatures, exclude) {
		const out = [];
		Object.keys(wormholes || {}).forEach(function(key) {
			const wormhole = wormholes[key];
			if (!wormhole || wormhole.id == exclude || !signatures) { return; }
			const pair = [[signatures[wormhole.initialID], signatures[wormhole.secondaryID]], [signatures[wormhole.secondaryID], signatures[wormhole.initialID]]];
			pair.forEach(function(p) {
				const sig = p[0], other = p[1];
				if (!sig || !other || sig.type !== "wormhole" || !jumpSigPrompt.isUnset(other.systemID)) { return; }
				if (sig.systemID == from) { out.push({ wormholeId: Number(wormhole.id), wormhole: wormhole, sig: sig, other: other, side: "from" }); }
				else if (sig.systemID == to) { out.push({ wormholeId: Number(wormhole.id), wormhole: wormhole, sig: sig, other: other, side: "to" }); }
			});
		});
		return out.sort(function(x, y) { return (x.side === y.side ? 0 : x.side === "from" ? -1 : 1) || x.wormholeId - y.wormholeId; });
	},

	/** What linking a candidate does for the browser (the server does it, public/jump_link.php, in one transaction): the signature in the
		system you left ends up with the name the bare hole had there when it has none of its own. Returns {origin, originName}. */
	plan: function(candidate, from, to, hole) {
		const origin = candidate.side === "from" ? candidate.sig : candidate.other;	// the signature in `from` once linked
		const carried = !jumpSigPrompt.isNamed(origin) && jumpSigPrompt.isNamed(hole.fromSig) ? String(hole.fromSig.name).trim() : null;
		return { origin: origin, originName: carried !== null ? carried : String(origin.name || "").trim() };
	},

	/** Every hole of the jump to ask about (see asks), lowest wormhole id first */
	holesToAsk: function(mode, from, to, wormholes, signatures) {
		return jumpSigPrompt.holesBetween(from, to, wormholes, signatures).filter(function(h) { return jumpSigPrompt.asks(mode, h); });
	},

	/** Which of several holes to ask about is THIS jump's: the one that has a logged jump by one of my characters at or after
		jumpAt minus windowMs (server clock ms). A single hole needs no proof. Several and not exactly one proven: null (don't ask).
		logs: {wormholeId: [{characterName, time}] | null}; me: [names] (compared without upstream's "|P" suffix, any case). */
	pickHole: function(holes, logs, me, jumpAt, windowMs) {
		if (!holes || !holes.length) { return null; }
		if (holes.length === 1) { return holes[0]; }
		const mine = {};
		(me || []).forEach(function(n) { const b = String(n || "").split("|")[0].trim().toLowerCase(); if (b) { mine[b] = true; } });
		const parse = function(v) {
			const m = String(v === undefined || v === null ? "" : v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
			return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
		};
		const proven = holes.filter(function(h) {
			return ((logs && logs[h.wormhole.id]) || []).some(function(j) {
				const at = parse(j && j.time);
				return mine[String(j && j.characterName || "").split("|")[0].trim().toLowerCase()] && isFinite(at) && at >= jumpAt - windowMs;
			});
		});
		return proven.length === 1 ? proven[0] : null;
	},

	/** The hole bookmark string for the linked hole (the mask's hole template), or null while the side you left has no name.
		classText: short class of the system you arrived in. */
	bookmark: function(plan, candidate, from, classText) {
		return holeNaming.bookmarkString({
			name: plan.originName, classText: classText, sigID: plan.origin.signatureID, type: candidate.wormhole.type,
			size: holeNaming.sizeLetter(candidate.wormhole.type), system: holeNaming.systemName(from), eol: candidate.wormhole.life === "critical",
			life: typeof lifeStates !== "undefined" ? lifeStates.bookmarkLife(candidate.wormhole, lifeStates.sigsOf(candidate.wormhole), lifeStates.now(), lifeStates.isOn()) : undefined
		});
	},

	/** "ABC-123" for the list; "no ID yet" for a placeholder */
	idText: function(sig) {
		const raw = String(sig && sig.signatureID ? sig.signatureID : "");
		const letters = raw.replace(/[^A-Za-z]/g, "").substring(0, 3).toUpperCase();
		if (letters.length < 3) { return "no ID yet"; }
		const digits = (/([0-9]{3})/.exec(raw) || [])[1];
		return digits ? letters + "-" + digits : letters;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined" || typeof tripwire.EVE !== "function" || typeof jumpReturn === "undefined") { return; }

		let jumpSeq = 0;
		let timers = [];
		let hideTimer = null;
		let pickerSeen = false;

		function opts() { return typeof options !== "undefined" ? options : undefined; }
		function maskMode() { return typeof bookmarkTemplate !== "undefined" ? bookmarkTemplate.jumpPrompt : "nomatch"; }
		function pickerOpen() { return typeof automapState !== "undefined" && !!automapState.pendingDecision; }

		// Holes this browser was already asked about (this session), so jumping back and forth does not nag
		const ASKED_KEY = "tripwire_jumpSigPrompt_asked";
		function askedList() {
			try { return (JSON.parse(sessionStorage.getItem(ASKED_KEY) || "[]") || []).map(Number); } catch (e) { return []; }
		}
		function rememberAsked(wormholeId) {
			try {
				const list = askedList().filter(function(id) { return id !== Number(wormholeId); }).slice(-49);
				list.push(Number(wormholeId));
				sessionStorage.setItem(ASKED_KEY, JSON.stringify(list));
			} catch (e) { /* storage unavailable: only affects repeat prompts */ }
		}

		function clearTimers() {
			timers.forEach(function(t) { clearTimeout(t); });
			timers = [];
		}

		function hidePanel() {
			clearTimeout(hideTimer);
			$("#jump-sig-panel").remove();
			$("body").removeClass("jump-sig-open");
		}

		/** Jumps through a stargate, from a station or in a pod are not wormhole jumps (the automapper's own checks) */
		function wormholeJump(from, to) {
			try {
				if (typeof tripwire.map !== "undefined" && tripwire.map.shortest && tripwire.map.shortest[from - 30000000] !== undefined &&
					tripwire.map.shortest[from - 30000000][to - 30000000] !== undefined) { return false; }
				const eve = tripwire.client && tripwire.client.EVE;
				if (eve && eve.stationID) { return false; }
				if (eve && eve.shipTypeID && [33328, 670].indexOf(parseInt(eve.shipTypeID, 10)) >= 0) { return false; }
			} catch (e) { /* assume it was a wormhole */ }
			return true;
		}

		function candidateText(c) {
			const type = c.wormhole.type ? (c.wormhole[c.wormhole.parent + "ID"] == c.sig.id ? c.wormhole.type : "[" + c.wormhole.type + "]") : "";
			const name = jumpSigPrompt.isNamed(c.sig) ? "“" + String(c.sig.name).trim() + "”" : "";
			return [jumpSigPrompt.idText(c.sig), type, name, "in " + holeNaming.systemName(c.sig.systemID)].filter(Boolean).join(" · ");
		}

		// ---- the server does the linking (public/jump_link.php) ----
		let csrf = "";
		function token() {
			if (csrf) { return $.Deferred().resolve(csrf).promise(); }
			return $.ajax({ url: "jump_link.php", type: "GET", data: { mode: "token" }, dataType: "JSON", cache: false }).then(function(data) { csrf = data.csrf; return csrf; });
		}
		function post(body) {
			return token().then(function(t) {
				return $.ajax({
					url: "jump_link.php", type: "POST", contentType: "application/json", dataType: "JSON", data: JSON.stringify(body),
					headers: { "X-CSRF-Token": t, "X-Requested-With": "XMLHttpRequest" }
				});
			});
		}
		function errorText(xhr) {
			return (xhr && xhr.responseJSON && xhr.responseJSON.error) || (xhr && xhr.status ? "request failed (HTTP " + xhr.status + ")" : "request failed");
		}
		function fail(xhr) {
			Notify.trigger("Couldn't link that signature: " + _.escape(errorText(xhr)), "red", 8000);
		}

		function link(seq, from, to, hole, candidate) {
			const plan = jumpSigPrompt.plan(candidate, from, to, hole);
			let classText = "";
			try { classText = holeNaming.classText(systemAnalysis.analyse(to).systemTypeName); } catch (e) { classText = ""; }
			const bookmark = jumpSigPrompt.bookmark(plan, candidate, from, classText);
			hidePanel();
			post({ mode: "link", bareID: Number(hole.wormhole.id), candidateSigID: Number(candidate.sig.id) }).done(function(answer) {
				if (typeof forkUsage !== "undefined") { forkUsage.track("jumpSigPrompt", "linked"); }
				// One undo step: the server puts back exactly what the link changed (see the tripwire.undo wrapper below)
				const undoSystemID = typeof automapperUndo !== "undefined" ? automapperUndo.system(viewingSystemID, from, to) : to;
				const stack = tripwire.signatures.undo[undoSystemID] = tripwire.signatures.undo[undoSystemID] || [];
				stack.push({ action: "jumpLink", linkId: answer.linkId, signatures: [] });
				$("#undo").removeClass("disabled");
				try { sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo)); } catch (e) { /* ignore */ }
				const label = "Linked " + jumpSigPrompt.idText(candidate.sig) + ": " + holeNaming.systemName(from) + " \u2192 " + holeNaming.systemName(to);
				// Only now, after the server confirmed, the bookmark goes to the clipboard
				(bookmark ? holeNaming.copyText(bookmark) : Promise.resolve(false)).then(function(ok) {
					Notify.trigger(_.escape(label) + (bookmark ? (ok ? ". Copied " + _.escape(bookmark) : ". Bookmark (copy failed): " + _.escape(bookmark)) : ". Name the hole to get its bookmark."), "green", 6000);
				});
			}).fail(fail);
		}

		// Undo of a link is the server's unlink (one step: the bare hole and its jumps come back, the signature is unlinked)
		const previousUndo = tripwire.undo;
		tripwire.undo = function() {
			const stack = tripwire.signatures.undo[viewingSystemID] || [];
			const item = stack[stack.length - 1];
			if (!item || item.action !== "jumpLink") { return previousUndo.apply(this, arguments); }
			$("#undo").addClass("disabled");
			post({ mode: "unlink", linkId: item.linkId }).done(function() {
				stack.pop();
				try { sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo)); } catch (e) { /* ignore */ }
				Notify.trigger("Link undone", "green", 3000);
			}).fail(function(xhr) {
				stack.pop();	// the link can't be undone any more (it was edited since): drop the entry rather than offer it again
				try { sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo)); } catch (e) { /* ignore */ }
				Notify.trigger("Couldn't undo the link: " + _.escape(errorText(xhr)), "red", 8000);
			}).always(function() {
				if ((tripwire.signatures.undo[viewingSystemID] || []).length > 0) { $("#undo").removeClass("disabled"); }
			});
		};

		function newSig(to, hole) {
			hidePanel();
			const open = function() {
				const $row = $("#sigTable tbody tr[data-id='" + hole.toSig.id + "']");
				if ($row.length) { $row.trigger("dblclick"); }
			};
			if (viewingSystemID == to) { open(); return; }
			tripwire.systemChange(to);
			setTimeout(open, 800);
		}

		function showPanel(seq, from, to, hole, candidates) {
			hidePanel();
			let who = "";	// multi-character jumps: who jumped ("" otherwise)
			try { who = typeof multiTrack !== "undefined" && typeof multiTrack.labelNow === "function" ? multiTrack.labelNow() : ""; } catch (e) { who = ""; }
			const summary = (who ? who + ": " : "") + holeNaming.systemName(from) + " → " + holeNaming.systemName(to);
			const $panel = $("<div id='jump-sig-panel' role='dialog' aria-live='polite' tabindex='-1'></div>").attr("aria-label", "Which signature did you jump through? " + summary);
			const $head = $("<div class='jump-sig-head'></div>");
			$head.append($("<span class='jump-sig-title'>Which signature did you jump through?</span>"), $("<span class='jump-sig-route'></span>").text(summary));
			const $close = $("<button type='button' class='jump-sig-close' aria-label='Skip'>✕</button>").on("click", function(e) { e.preventDefault(); hidePanel(); });
			$head.append($close);
			const $list = $("<div class='jump-sig-list'></div>");
			candidates.slice(0, jumpSigPrompt.MAX_ROWS).forEach(function(c) {
				$("<button type='button' class='jump-sig-row'></button>").text(candidateText(c))
					.attr("title", "Link this signature to your jump (" + summary + "); Undo works")
					.on("click", function(e) { e.preventDefault(); link(seq, from, to, hole, c); }).appendTo($list);
			});
			if (!candidates.length) { $list.append($("<div class='jump-sig-none'></div>").text("No unlinked wormhole signatures in these systems.")); }
			const $foot = $("<div class='jump-sig-foot'></div>");
			$foot.append(
				$("<button type='button' class='jump-sig-new'>New sig…</button>").attr("title", "Open the unknown hole to fill it in").on("click", function(e) { e.preventDefault(); newSig(to, hole); }),
				$("<button type='button' class='jump-sig-skip'>Skip</button>").on("click", function(e) { e.preventDefault(); hidePanel(); })
			);
			$panel.append($head, $list, $foot);
			$panel.on("keydown", function(e) { if (e.key === "Escape") { hidePanel(); } });
			$("body").append($panel).addClass("jump-sig-open");
			document.documentElement.style.setProperty("--jump-sig-height", ($panel.outerHeight() || 100) + "px");
			hideTimer = setTimeout(hidePanel, jumpSigPrompt.AUTO_HIDE_MS);
		}

		function myNames() {
			const names = [];
			if (tripwire.client && tripwire.client.EVE && tripwire.client.EVE.characterName) { names.push(tripwire.client.EVE.characterName); }
			const characters = (tripwire.esi && tripwire.esi.characters) || {};
			Object.keys(characters).forEach(function(id) { if (characters[id] && characters[id].characterName) { names.push(characters[id].characterName); } });
			const o = opts();
			if (o && o.character && o.character.name) { names.push(o.character.name); }
			return names;
		}
		function serverNow() {
			try { if (typeof sigAge !== "undefined" && typeof sigAge.now === "function") { return sigAge.now(); } } catch (e) { /* fall back */ }
			return Date.now();
		}
		/** The hole's jump log (upstream's mass panel data) or null */
		function jumpLog(wormholeId) {
			return new Promise(function(resolve) {
				$.ajax({ url: "mass.php", type: "POST", data: { wormholeID: wormholeId }, dataType: "JSON", timeout: 4000 })
					.done(function(data) { resolve(data && Array.isArray(data.jumps) ? data.jumps : null); }).fail(function() { resolve(null); });
			});
		}

		function show(seq, from, to, hole) {
			if (seq !== jumpSeq || pickerOpen()) { return; }
			rememberAsked(hole.wormhole.id);
			const candidates = jumpSigPrompt.candidates(from, to, tripwire.client.wormholes, tripwire.client.signatures, hole.wormhole.id);
			showPanel(seq, from, to, hole, candidates);
		}

		/** Look for the hole to ask about; true when we are done with this jump (shown, or nothing to ask). With several unknown holes
			between the two systems the one this pilot's jump logged on is used, and none is asked about when that isn't clear. */
		function attempt(seq, from, to, jumpAt) {
			if (seq !== jumpSeq) { return true; }
			if (pickerOpen()) { pickerSeen = true; }
			if (pickerSeen) { return true; }	// the automapper is asking (or asked): never a second question
			let holes = [];
			try {
				holes = jumpSigPrompt.holesToAsk(maskMode(), from, to, tripwire.client.wormholes, tripwire.client.signatures)
					.filter(function(h) { return askedList().indexOf(Number(h.wormhole.id)) < 0; });	// once per hole and session
			} catch (e) {
				console.warn("jump-sig-prompt: could not check the jump", e);
				return true;
			}
			if (!holes.length) { return false; }
			if (holes.length === 1) { show(seq, from, to, holes[0]); return true; }
			const me = myNames();
			Promise.all(holes.map(function(h) { return jumpLog(h.wormhole.id); })).then(function(all) {
				const logs = {};
				holes.forEach(function(h, i) { logs[h.wormhole.id] = all[i]; });
				const hole = jumpSigPrompt.pickHole(holes, logs, me, jumpAt, jumpSigPrompt.JUMP_WINDOW_MS);
				if (hole) { show(seq, from, to, hole); } else { console.info("jump-sig-prompt: several unknown holes between the systems and none is this jump's: not asking"); }
			});
			return true;
		}

		function onJump(from, to) {
			jumpSeq++;
			const seq = jumpSeq;
			clearTimers();
			hidePanel();
			const jumpAt = serverNow();
			pickerSeen = pickerOpen();	// the automapper ran just before: its picker is up if it needs an answer
			if (!jumpSigPrompt.active(maskMode(), opts()) || !wormholeJump(from, to)) { return; }
			jumpSigPrompt.RETRY_DELAYS_MS.forEach(function(delay, i) {
				timers.push(setTimeout(function() { if (attempt(seq, from, to, jumpAt)) { clearTimers(); } }, delay));
			});
		}
		jumpSigPrompt.onJump = onJump;	// handy for testing from the console
		jumpSigPrompt.hide = hidePanel;

		const previousEVE = tripwire.EVE;
		tripwire.EVE = function(EVE, characterChange) {
			const prev = this.client && this.client.EVE ? { systemID: this.client.EVE.systemID, characterID: this.client.EVE.characterID } : null;
			const ret = previousEVE.apply(this, arguments);
			try {
				const jump = jumpReturn.detectJump(prev, EVE || null, characterChange);
				if (jump) { onJump(jump.from, jump.to); }
			} catch (e) {
				console.warn("jump-sig-prompt: jump detection failed", e);
			}
			return ret;
		};

		// ---- Settings > Wormhole Jumps & Mass (takes effect on Save; Reset = on). The mask can turn it off for everyone. ----
		forkSettings.register({
			section: "jumps", order: 35, id: "jumpSigPrompt-enabled", type: "checkbox", key: "jumpSigPrompt",
			label: "Which signature prompt:", text: "After a jump the automapper can't place, ask which signature I went through",
			get: function(o) { return jumpSigPrompt.userEnabled(o); },
			set: function(o, on) { o.jumpSigPrompt = { enabled: on }; if (!on) { jumpSeq++; clearTimers(); hidePanel(); } }
		});
	});
}
