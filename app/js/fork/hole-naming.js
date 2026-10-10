const holeNaming = {
	// Hierarchical wormhole naming: holes leaving the chain root get one character, holes leaving a deeper
	// system get the name of the hole leading into that system plus one character.
	// Large holes use letters, small (frigate) holes digits 1-5, medium holes digits 6-9.
	LETTERS: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
	SMALL_DIGITS: "12345",
	MEDIUM_DIGITS: "6789",
	SMALL_MAX_JUMP: 5000000,
	MEDIUM_MAX_JUMP: 62000000,

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

	/** Next free name below the prefix: prefix + lowest unused character of the size class.
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

	/** In-game bookmark string: "=<name> <class> <SIG>[ EOL]". Returns null without a name. */
	bookmarkString: function(args) {
		const token = holeNaming.leadingToken(args && args.name);
		if (!token) { return null; }
		const parts = ["=" + token];
		if (args.classText) { parts.push(String(args.classText)); }
		const sig = String(args.sigAlpha || "").replace(/[^A-Za-z]/g, "").substring(0, 3).toUpperCase();
		if (sig) { parts.push(sig); }
		if (args.eol) { parts.push("EOL"); }
		return parts.join(" ");
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		const dialogSel = "#dialog-signature";
		let userEdited = false;

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

		holeNaming.suggestForDialog = function() {
			const systemID = sigDialogVM.viewingSystemID;
			const context = holeNaming.chainContext(systemID, typeof chain !== "undefined" ? chain.data : undefined);
			const prefix = holeNaming.prefixFor(context.incomingName, context.isRoot);
			const used = holeNaming.siblingNames(tripwire.client.signatures, systemID, sigDialogVM.sigId);
			return holeNaming.nextName(prefix, used, holeNaming.sizeClass(effectiveType()));
		};

		function autoFill() {
			if (userEdited || !isAddMode() || !isWormholeSelected()) { return; }
			try {
				const suggestion = holeNaming.suggestForDialog();
				field("wormholeName").val(suggestion || "");
			} catch (e) {
				console.warn("hole-naming: could not suggest a name", e);
			}
		}

		// jQuery UI fires the 'dialogopen' event before the dialog's own open callback (which clears inputs), so defer
		$(document).on("dialogopen", dialogSel, function() {
			userEdited = false;
			setTimeout(autoFill, 0);
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
				sigAlpha: String(thisSide.signatureID || "").substring(0, 3),
				eol: entry.wormhole.life === "critical"
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
