const holeNaming = {
	// Hierarchical wormhole naming: holes leaving the chain root get one character, holes leaving a deeper
	// system get the name of the hole leading into that system plus one character.
	// Large holes use letters, small (frigate) holes digits 1-5, medium holes digits 6-9;
	// the size digit is added only once along a path (see nextName).
	LETTERS: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
	SMALL_DIGITS: "12345",
	MEDIUM_DIGITS: "6789",
	SMALL_MAX_JUMP: 5000000,
	MEDIUM_MAX_JUMP: 62000000,
	// Return bookmarks (the far side of a named hole, pointing back home) are "!" + the hole's name token, e.g. "!AB".
	// Earlier versions wrote "<AB"; both are still recognised (discord/chain_label.php mirrors this).
	RETURN_PREFIX: "!",
	RETURN_PREFIXES: "!<",

	/** True if a sig name is a return bookmark ("!AB", or the older "<AB"). */
	isReturnBookmark: function(name) {
		const s = String(name === undefined || name === null ? "" : name).trim();
		return s !== "" && holeNaming.RETURN_PREFIXES.indexOf(s.charAt(0)) !== -1;
	},

	/** The leading name token of a sig name, e.g. "BA - DRIFTER" -> "BA". Empty string if none. */
	leadingToken: function(name) {
		const m = /^[A-Z0-9]+/i.exec(String(name === undefined || name === null ? "" : name).trim());
		return m ? m[0].toUpperCase() : "";
	},

	/** Size class of a wormhole type from its max jump mass: 'small', 'medium' or 'large'.
		Unknown types (including K162 and no type) are 'large'. */
	sizeClass: function(type, wormholes) {
		const table = wormholes || (typeof appData !== "undefined" && appData.wormholes) || {};
		const wormhole = type ? table[String(type).toUpperCase()] : undefined;
		if (!wormhole || !wormhole.jump) { return "large"; }
		if (wormhole.jump <= holeNaming.SMALL_MAX_JUMP) { return "small"; }
		if (wormhole.jump <= holeNaming.MEDIUM_MAX_JUMP) { return "medium"; }
		return "large";
	},

	/** Most restrictive size marked in a name token: 'small' if it has a small digit, else 'medium' if it has a
		medium digit, else 'large'. */
	pathSize: function(token) {
		const s = String(token === undefined || token === null ? "" : token);
		let size = "large";
		for (let i = 0; i < s.length; i++) {
			if (holeNaming.SMALL_DIGITS.indexOf(s.charAt(i)) !== -1) { return "small"; }
			if (holeNaming.MEDIUM_DIGITS.indexOf(s.charAt(i)) !== -1) { size = "medium"; }
		}
		return size;
	},

	/** Next free name below the prefix: prefix + lowest unused character of the size class.
		The size digit is skipped (letters used instead) when the prefix already marks that size or a smaller one.
		usedNames are the (full) names of sibling holes; only those whose leading token is exactly
		prefix + 1 character count. Digit classes fall back to letters; returns null if nothing is free. */
	nextName: function(prefix, usedNames, sizeClass) {
		if (prefix === null || prefix === undefined) { return null; }
		prefix = String(prefix).toUpperCase();
		const used = {};
		(usedNames || []).forEach(function(name) {
			const token = holeNaming.leadingToken(name);
			if (token.length === prefix.length + 1 && token.substring(0, prefix.length) === prefix) {
				used[token.charAt(prefix.length)] = true;
			}
		});
		// A size digit is only added when the hole is more restrictive than the path so far: past a small hole
		// everything is letters, past a medium hole only a small hole gets a digit again (AB6 -> AB6A, AB61).
		const pathSize = holeNaming.pathSize(prefix);
		if (sizeClass === "medium" && pathSize !== "large") { sizeClass = "large"; }
		if (sizeClass === "small" && pathSize === "small") { sizeClass = "large"; }
		const pools = sizeClass === "small" ? [holeNaming.SMALL_DIGITS, holeNaming.LETTERS] :
			sizeClass === "medium" ? [holeNaming.MEDIUM_DIGITS, holeNaming.LETTERS] :
			[holeNaming.LETTERS];
		for (let p = 0; p < pools.length; p++) {
			for (let i = 0; i < pools[p].length; i++) {
				if (!used[pools[p].charAt(i)]) { return prefix + pools[p].charAt(i); }
			}
		}
		return null;
	},

	/** Name prefix for holes leaving a system.
		@param incomingName name of the hole leading into the system (last pathHome entry), or undefined if the system is not in the chain
		@param isRoot true if the system is a chain root
		@return "" for roots / systems not in the chain, the incoming hole's leading token otherwise,
			or null if the incoming hole has no name (so no suggestion can be made) */
	prefixFor: function(incomingName, isRoot) {
		if (isRoot || incomingName === undefined) { return ""; }
		return holeNaming.leadingToken(incomingName) || null;
	},

	/** Find root status and incoming hole name for a system from chain.data. */
	chainContext: function(systemID, chainData) {
		if (!chainData || !chainData.systemsInChainMap) { return { isRoot: false, incomingName: undefined }; }
		const rows = (chainData.map && chainData.map.rows) || [];
		const isRoot = rows.some(function(r) {
			return r && r.c && r.c[0] && r.c[1] && r.c[1].v === null && r.c[0].systemID == systemID;
		});
		const entry = chainData.systemsInChainMap[systemID];
		if (!entry || !entry.pathHome || !entry.pathHome.length) { return { isRoot: isRoot, incomingName: undefined }; }
		const last = entry.pathHome[entry.pathHome.length - 1];
		return { isRoot: isRoot, incomingName: last && last.name ? String(last.name) : "" };
	},

	/** Root system IDs of the active chain tab, from the tab's data (the same value chain-map.js reads from
		$("#chainTabs .current .name").data("tab")): a system ID or comma separated list of them.
		Returns null when there is no active tab, or for the "all k-space" tab (0), whose roots aren't home. */
	tabRoots: function(tabData) {
		if (tabData === undefined || tabData === null) { return null; }
		const roots = String(tabData).split(",").map(function(s) { return s.trim(); })
			.filter(function(s) { return s !== "" && s !== "0"; });
		return roots.length ? roots : null;
	},

	/** Leading name token of the hole leading into a system, derived from the wormholes themselves (for when
		the chain map isn't rooted at home). A wormhole touching the system is an incoming hole if its far-side
		sig has a name token and its near-side sig is unnamed or a return bookmark ("!C", or "<C"); a named near side
		(e.g. "CA") is an outbound hole of this system. With several candidates the shortest token (closest to
		home) wins, ties go to the lowest wormhole id. Returns undefined if there is none. */
	incomingFromWormholes: function(systemID, wormholes, signatures) {
		let best;
		Object.keys(wormholes || {}).forEach(function(key) {
			const wormhole = wormholes[key];
			if (!wormhole || !signatures) { return; }
			const a = signatures[wormhole.initialID], b = signatures[wormhole.secondaryID];
			let near, far;
			if (a && a.systemID == systemID) { near = a; far = b; }
			else if (b && b.systemID == systemID) { near = b; far = a; }
			else { return; }
			if (!far || far.systemID == systemID) { return; }
			const token = holeNaming.leadingToken(far.name);
			if (!token) { return; }
			const nearName = String(near.name === undefined || near.name === null ? "" : near.name).trim();
			if (nearName !== "" && !holeNaming.isReturnBookmark(nearName)) { return; }
			const id = Number(wormhole.id !== undefined ? wormhole.id : key);
			if (!best || token.length < best.token.length || (token.length === best.token.length && id < best.id)) {
				best = { token: token, id: id };
			}
		});
		return best ? best.token : undefined;
	},

	/** Name prefix for holes leaving a system, relative to home.
		With an active chain tab (tabRoots) the chain map is rooted at home, so chain.data is used; otherwise
		(no tab, "all k-space" tab, or the system isn't in the chain) the incoming hole comes from the wormholes.
		@return "" for home / no incoming hole, the incoming token, or null if the chain's incoming hole is unnamed */
	resolvePrefix: function(systemID, tabRoots, chainData, wormholes, signatures) {
		if (tabRoots && tabRoots.length) {
			if (tabRoots.some(function(r) { return r == systemID; })) { return ""; }
			const context = holeNaming.chainContext(systemID, chainData);
			if (context.isRoot) { return ""; }
			if (context.incomingName !== undefined) { return holeNaming.prefixFor(context.incomingName, false); }
		}
		return holeNaming.incomingFromWormholes(systemID, wormholes, signatures) || "";
	},

	/** Names of the other wormhole sigs in a system (excluding excludeSigId). */
	siblingNames: function(signatures, systemID, excludeSigId) {
		const names = [];
		Object.keys(signatures || {}).forEach(function(key) {
			const sig = signatures[key];
			if (!sig || sig.type !== "wormhole" || sig.systemID != systemID) { return; }
			if (excludeSigId !== undefined && excludeSigId !== null && sig.id == excludeSigId) { return; }
			if (sig.name) { names.push(sig.name); }
		});
		return names;
	},

	/** Short class text for a bookmark from systemAnalysis' systemTypeName. Ambiguous types (C2/3) give "". */
	classText: function(systemTypeName) {
		const name = String(systemTypeName === undefined || systemTypeName === null ? "" : systemTypeName).trim();
		if (!name || name.indexOf("/") >= 0) { return ""; }
		if (name === "C12") { return "Thera"; }
		if (name === "Trig") { return "Pochven"; }
		return name;
	},

	/** In-game bookmark string for a named hole, built from the mask's hole template (Mask Admin > Bookmark names; the
		default "={name} {class} {sig} {life}" gives "=<name> <class> <SIG>[ EOL]", e.g. "=A C5 ABC EOL"). Returns null
		without a name. args: {name, classText, sigAlpha | sigID, type, size, system, life, eol, template?} */
	bookmarkString: function(args) {
		const token = holeNaming.leadingToken(args && args.name);
		if (!token) { return null; }
		const values = bookmarkTemplate.values(Object.assign({}, args, { name: token, dir: "out" }));
		// A hole bookmark never starts with < (the return bookmark mark), e.g. from an old template that starts with {life}
		return bookmarkTemplate.render(args.template || bookmarkTemplate.active("hole"), values).replace(/^<+\s*/, "") || null;
	},

	/** Settings > Signatures "Suggest hole names" (a missing key means on) */
	enabled: function(opts) {
		return !(opts && opts.holeNaming && opts.holeNaming.enabled === false);
	},

	/** Suggest a name when editing an existing sig (e.g. a hole added by a scan paste)? Only when it has no name
		yet and its other side isn't a named hole: then this side is the way back into the chain, not a new hole. */
	suggestOnEdit: function(name, otherSideName) {
		const own = String(name === undefined || name === null ? "" : name).trim();
		return own === "" && !holeNaming.leadingToken(otherSideName);
	},

	/** Size letter (S, M, L, VL, XL) of a wormhole type for the {size} bookmark token, "" when unknown */
	sizeLetter: function(type, wormholes) {
		const table = wormholes || (typeof appData !== "undefined" && appData.wormholes) || {};
		const wormhole = type ? table[String(type).toUpperCase()] : undefined;
		return wormhole && wormhole.jump && typeof sizeTags !== "undefined" ? sizeTags.sizeOf(wormhole.jump) || "" : "";
	},

	/** Name of a system for the {system} bookmark token ("" when unknown) */
	systemName: function(systemID) {
		const system = (typeof appData !== "undefined" && appData.systems && appData.systems[systemID]) ||
			(typeof tripwire !== "undefined" && tripwire.systems && tripwire.systems[systemID]);
		return system && system.name ? String(system.name) : "";
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		const dialogSel = "#dialog-signature";
		let userEdited = false;
		let allowed = false;

		function field(name) { return $(dialogSel + " [name='" + name + "']"); }
		function isAddMode() { return typeof sigDialogVM !== "undefined" && sigDialogVM.mode !== "update"; }
		function isWormholeSelected() { return field("signatureType").val() === "wormhole"; }

		/** Type used for sizing: this side's type, or the other side's when this side is K162/unknown */
		function effectiveType() {
			const t1 = String(field("wormholeType").val() || "").toUpperCase();
			const t2 = String(field("wormholeType2").val() || "").toUpperCase();
			if (t1 !== "K162" && appData.wormholes[t1]) { return t1; }
			if (t2 !== "K162" && appData.wormholes[t2]) { return t2; }
			return t1;
		}

		/** Prefix for holes leaving systemID, relative to home (also handy from the console) */
		holeNaming.prefixForSystem = function(systemID) {
			// Same source chain-map.js uses to pick its roots
			const $tabName = $("#chainTabs .current .name");
			const roots = holeNaming.tabRoots($tabName.length ? $tabName.data("tab") : undefined);
			return holeNaming.resolvePrefix(systemID, roots, typeof chain !== "undefined" ? chain.data : undefined,
				tripwire.client.wormholes, tripwire.client.signatures);
		};

		holeNaming.suggestForDialog = function() {
			const systemID = sigDialogVM.viewingSystemID;
			const prefix = holeNaming.prefixForSystem(systemID);
			const used = holeNaming.siblingNames(tripwire.client.signatures, systemID, sigDialogVM.sigId);
			return holeNaming.nextName(prefix, used, holeNaming.sizeClass(effectiveType()));
		};

		/** Whether this dialog may get a suggestion: Add mode, or editing a sig that has no name yet */
		function suggestionAllowed() {
			if (isAddMode()) { return true; }
			const sig = tripwire.client.signatures[sigDialogVM.sigId];
			if (!sig) { return false; }
			const other = tripwire.client.signatures[$(dialogSel).data("signature2id")];
			// Non-wormhole sigs keep their site name elsewhere; the hole Name field starts empty for them
			return holeNaming.suggestOnEdit(sig.type === "wormhole" ? sig.name : "", other ? other.name : "");
		}

		function autoFill() {
			if (userEdited || !allowed || !isWormholeSelected()) { return; }
			if (typeof options !== "undefined" && !holeNaming.enabled(options)) { return; }
			try {
				const suggestion = holeNaming.suggestForDialog();
				const $name = field("wormholeName");
				$name.val(suggestion || "");
				// Edit mode focuses the Name field: keep the suggestion selected so typing replaces it
				if ($name.length && document.activeElement === $name[0]) { $name.select(); }
			} catch (e) {
				console.warn("hole-naming: could not suggest a name", e);
			}
		}

		// jQuery UI fires the 'dialogopen' event before the dialog's own open callback (which clears inputs), so defer
		// Decided once the open callback has filled the form (it fires type changes before setting the name)
		$(document).on("dialogopen", dialogSel, function() {
			userEdited = false;
			allowed = false;
			bookmarkTemplate.ensureLoaded();	// the Add/Save copy needs the mask's templates (a no-op once they are read)
			setTimeout(function() {
				try { allowed = suggestionAllowed(); } catch (e) { allowed = false; }
				autoFill();
			}, 0);
		});
		$(document).on("dialogclose", dialogSel, function() { allowed = false; });

		// --- Settings > Signatures (takes effect on Save; Reset = on) ---
		forkSettings.register({
			section: "signatures", order: 50, id: "holeNaming-enabled", type: "checkbox", key: "holeNaming",
			label: "Suggest hole names:", text: "Fill in the Name of new and pasted wormholes (A, AB, AB6 ...)",
			get: function(o) { return holeNaming.enabled(o); },
			set: function(o, on) { o.holeNaming = { enabled: on }; }
		});
		$(document).on("input", dialogSel + " [name='wormholeName']", function() { userEdited = true; });
		$(document).on("change input", dialogSel + " [name='wormholeType'], " + dialogSel + " [name='wormholeType2']", autoFill);
		$(document).on("selectmenuchange", dialogSel + " [name='signatureType']", autoFill);

		// --- Bookmark string copy ---

		function copyWithTextarea(text) {
			const previous = document.activeElement;
			const textarea = document.createElement("textarea");
			textarea.value = text;
			textarea.setAttribute("readonly", "");
			textarea.style.position = "fixed";
			textarea.style.left = "-9999px";
			textarea.style.top = "0";
			document.body.appendChild(textarea);
			textarea.select();
			let ok = false;
			try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
			document.body.removeChild(textarea);
			if (previous && previous.focus) { try { previous.focus(); } catch (e) { /* ignore */ } }
			return ok;
		}

		/** Start copying now (inside the user gesture); returns a promise resolving to true/false */
		function copyText(text) {
			if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
				return navigator.clipboard.writeText(text).then(function() { return true; }, function() { return copyWithTextarea(text); });
			}
			return Promise.resolve(copyWithTextarea(text));
		}
		holeNaming.copyText = copyText;

		function bookmarkForPayload(payload) {
			if (!payload || !payload.signatures) { return null; }
			const list = payload.signatures.add || payload.signatures.update;
			if (!list || list.length !== 1) { return null; }
			const entry = list[0];
			if (!entry || !entry.wormhole || !entry.signatures || !entry.signatures[0]) { return null; }
			const thisSide = entry.signatures[0];
			if (typeof sigDialogVM === "undefined" || thisSide.systemID != sigDialogVM.viewingSystemID) { return null; }
			if (!$(dialogSel).hasClass("ui-dialog-content") || !$(dialogSel).dialog("isOpen")) { return null; }

			let classText = "";
			const target = entry.signatures[1] ? entry.signatures[1].systemID : null;
			if (target !== null && target !== undefined && target !== "") {
				try { classText = holeNaming.classText(systemAnalysis.analyse(target).systemTypeName); } catch (e) { classText = ""; }
			}
			return holeNaming.bookmarkString({
				name: thisSide.name,
				classText: classText,
				sigID: String(thisSide.signatureID || ""),
				type: entry.wormhole.type,
				size: holeNaming.sizeLetter(entry.wormhole.type),
				system: holeNaming.systemName(thisSide.systemID),
				eol: entry.wormhole.life === "critical",
				life: typeof lifeStates !== "undefined" ? lifeStates.entryLife(entry, lifeStates.entryCurrent(entry), lifeStates.now(), lifeStates.isOn()) : undefined	// <4h / <1h / EOL
			});
		}
		holeNaming.bookmarkForPayload = bookmarkForPayload;

		// The dialog's submit handler builds the payload and calls tripwire.refresh synchronously from the
		// Add/Save click (or Enter key), so copying here happens inside the user gesture. The toast is only
		// shown if the save succeeds (same check the dialog's own success callback makes).
		const originalRefresh = tripwire.refresh;
		tripwire.refresh = function(mode, data, successCallback, alwaysCallback) {
			let bookmark = null;
			try { bookmark = bookmarkForPayload(data); } catch (e) { bookmark = null; }
			if (!bookmark) { return originalRefresh.apply(this, arguments); }

			const copied = copyText(bookmark);
			const wrappedSuccess = function(result) {
				const ret = successCallback ? successCallback.apply(this, arguments) : undefined;
				if (result && result.resultSet && result.resultSet[0] && result.resultSet[0].result == true) {
					copied.then(function(ok) {
						if (ok) {
							Notify.trigger("Copied " + _.escape(bookmark), "green", 4000);
						} else {
							Notify.trigger("Bookmark (copy failed, copy manually): " + _.escape(bookmark), "yellow", 15000);
						}
					});
				}
				return ret;
			};
			return originalRefresh.call(this, mode, data, wrappedSuccess, alwaysCallback);
		};
	});
}
