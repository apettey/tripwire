// One place that knows the shape of a signature update.
//
// The Add/Edit dialog built its update payload and its undo entry inline,
// from form fields, in about a hundred lines that also infer wormhole parent
// and type from what was typed. Inline editing needs the same payload and
// the same undo entry but from the records the client already holds, not
// from a form. Two copies of that shape would drift, and the failure mode of
// drift here is not an error -- it is a wormhole quietly linked to the wrong
// signature. So the shape lives here and both callers use it.
//
// What is deliberately NOT here: the dialog's form parsing (which side is
// the parent, what the type string means). That is form-specific and stays
// with the form. This module only knows what a signature record, a wormhole
// record, an update payload and an undo entry look like.

tripwire.signaturePayload = (function() {

	// The fields the server reads for a signature update; nothing else is sent.
	function signatureRecord(sig) {
		return {
			"id":          sig.id,
			"signatureID": sig.signatureID,
			"systemID":    sig.systemID,
			"type":        sig.type,
			"name":        sig.name,
			"lifeLength":  sig.lifeLength
		};
	}

	function wormholeRecord(wh) {
		return {
			"id":     wh.id,
			"type":   wh.type,
			"parent": wh.parent,
			"life":   wh.life,
			"mass":   wh.mass
		};
	}

	function wormholeForSignature(sigId) {
		var holes = tripwire.client.wormholes || {};
		for (var k in holes) {
			if (holes[k].initialID == sigId || holes[k].secondaryID == sigId) { return holes[k]; }
		}
		return null;
	}

	// The update payload for a wormhole and its two signatures. The dialog
	// passes objects it built from the form; inline editing passes records.
	function wormholeUpdatePayload(wormhole, sigA, sigB) {
		return {"signatures": {"update": [{"wormhole": wormhole, "signatures": [sigA, sigB]}]}};
	}

	function signatureUpdatePayload(sig) {
		return {"signatures": {"update": [sig]}};
	}

	// The undo entry for an update to the signature with this id, capturing
	// its state *before* the update: the wormhole and both sides if it is a
	// wormhole now, the bare signature otherwise. undo.js reads
	// `entry.wormhole.id` and `entry.signatures[n].id` to find the current
	// state when it comes to redo, so the records go in whole.
	function undoEntryFor(sigId) {
		var sig = tripwire.client.signatures[sigId];
		if (!sig) { return null; }
		var wh = wormholeForSignature(sigId);
		if (sig.type === "wormhole" && wh) {
			return {"wormhole": wh, "signatures": [tripwire.client.signatures[wh.initialID], tripwire.client.signatures[wh.secondaryID]]};
		}
		return sig;
	}

	// Push an undo entry for the viewing system and turn the control on.
	// Mirrors what the dialog's success handler does.
	function recordUndo(systemID, action, entries) {
		$("#undo").removeClass("disabled");
		if (systemID in tripwire.signatures.undo) {
			tripwire.signatures.undo[systemID].push({action: action, signatures: entries});
		} else {
			tripwire.signatures.undo[systemID] = [{action: action, signatures: entries}];
		}
		sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo));
	}

	// Change one or more fields on an existing wormhole. Everything else is
	// sent exactly as the client holds it. Returns the payload and the undo
	// entry, or null if the wormhole or either side is missing.
	function changeWormhole(wormholeId, changes) {
		var wh = tripwire.client.wormholes[wormholeId];
		if (!wh) { return null; }
		var a = tripwire.client.signatures[wh.initialID], b = tripwire.client.signatures[wh.secondaryID];
		if (!a || !b) { return null; }
		var undo = undoEntryFor(a.id);
		var updated = $.extend(wormholeRecord(wh), changes);
		return {
			payload: wormholeUpdatePayload(updated, signatureRecord(a), signatureRecord(b)),
			undo: [undo]
		};
	}

	return {
		signatureRecord: signatureRecord,
		wormholeRecord: wormholeRecord,
		wormholeForSignature: wormholeForSignature,
		wormholeUpdatePayload: wormholeUpdatePayload,
		signatureUpdatePayload: signatureUpdatePayload,
		undoEntryFor: undoEntryFor,
		recordUndo: recordUndo,
		changeWormhole: changeWormhole
	};
})();
