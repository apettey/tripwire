const automapperRejump = {
	// Automapper helpers: re-jump matching and undo bookkeeping. Pure logic, used by app/js/tripwire/automapper.js.
	// The re-jump matching is the fix for Tripwire's oldest complaint: jumping into a system that already has a
	// scanned hole whose far side is unset (a K162 with no "Leads To") created a second, blank "???" hole.
	/** Wormholes that already have a signature in the system just jumped INTO (`to`) whose other end is not a real
		system yet, and which can plausibly be the hole we came through from `from`. The caller uses this only when
		wormholesForJump (holes starting in `from`) found nothing.
		A candidate is a wormhole with exactly one signature in `to` (dest) whose partner (other) has no system set,
		or only a generic "Leads To" (Class-3, Unknown, Dangerous, High-Sec ...) compatible with `from`. A hole that
		is already linked to `from` is not a candidate (the automapper skips existing connections before this).
		A known hole type has to agree too (K162 fits anything).
		@return [{wormhole, dest, other}] where dest/other are signature ids, ordered by wormhole id */
	holesIntoDestination: function(from, to, wormholes, signatures) {
		const fromSystem = systemAnalysis.analyse(from);
		const toSystem = systemAnalysis.analyse(to);
		const fromType = fromSystem.genericSystemType[0];
		const toType = toSystem.genericSystemType[0];
		const fromClass = (fromSystem.class || [])[0];
		const found = [];
		Object.values(wormholes || {}).forEach(function(wormhole) {
			const initial = signatures[wormhole.initialID], secondary = signatures[wormhole.secondaryID];
			if (!initial || !secondary) { return; }
			let dest = null, other = null;
			if (initial.systemID == to && secondary.systemID != to) { dest = initial; other = secondary; }
			else if (secondary.systemID == to && initial.systemID != to) { dest = secondary; other = initial; }
			else { return; }
			const linked = other.systemID == from;	// Leads To is exactly the origin system
			if (!linked && !automapperRejump.isUnset(other.systemID, fromType, fromClass)) { return; }
			if (!automapperRejump.typeFits(wormhole, dest.id, fromType, toType)) { return; }
			found.push({
				wormhole: wormhole, dest: dest.id, other: other.id,
				exact: linked || automapperRejump.typeIsExact(wormhole, dest.id, fromType)
			});
		});
		return found.sort(function(a, b) { return a.wormhole.id - b.wormhole.id; });
	},

	/** Is a signature's system "not yet known" and compatible with the system we jumped from?
		null / empty, or a generic Leads To (an index into appData.genericSystemTypes) naming from's type or class. */
	isUnset: function(systemID, fromType, fromClass) {
		if (systemID === null || systemID === undefined || systemID === '') { return true; }
		if (appData.systems[systemID]) { return false; }	// a real system
		const typeName = appData.genericSystemTypes[systemID];
		if (typeName === undefined) { return false; }
		if (typeName === fromType) { return true; }
		const classes = systemAnalysis.classForTypeName(typeName);
		return !!(classes && fromClass !== undefined && classes.indexOf(fromClass) >= 0);
	},

	/** Is the hole's type known, carried by the destination-side signature, and leading to exactly the origin's
		class? (K162, no type or a type on the far side tells us nothing certain.) Only then is a single candidate
		linked without asking. */
	typeIsExact: function(wormhole, destSigID, fromType) {
		const info = wormhole.type && appData.wormholes[wormhole.type];
		if (!info || wormhole.type === 'K162' || !info.leadsTo) { return false; }
		const realID = wormhole.parent ? wormhole[wormhole.parent + 'ID'] : null;
		return realID !== null && realID !== undefined && realID == destSigID && info.leadsTo === fromType;
	},

	/** The payload entry that adds a new, unknown hole between the two systems of a jump. */
	newHole: function(from, to) {
		return {
			wormhole: { type: null, parent: 'initial', life: 'stable', mass: 'stable' },
			signatures: [{ systemID: from, type: 'wormhole' }, { systemID: to, type: 'wormhole' }]
		};
	},

	/** From/to of a jump for the mass log: the ones the client sent, else the signatures' systems (initial to secondary). */
	jumpEnds: function(automap, sig1SystemID, sig2SystemID) {
		const from = automap && parseInt(automap.from, 10), to = automap && parseInt(automap.to, 10);
		return from && to ? { from: from, to: to } : { from: sig1SystemID, to: sig2SystemID };
	},

	/** Does the wormhole's known type agree with the jump? The side that carries the type leads to the other
		side's class: if that is the side in `to` it must lead to from's type, otherwise to to's type.
		No type, an unknown type or K162 fits anything. */
	typeFits: function(wormhole, destSigID, fromType, toType) {
		const info = wormhole.type && appData.wormholes[wormhole.type];
		if (!info || wormhole.type === 'K162' || !info.leadsTo) { return true; }
		const realID = wormhole.parent ? wormhole[wormhole.parent + 'ID'] : null;
		if (realID === null || realID === undefined) { return true; }
		return info.leadsTo === (realID == destSigID ? fromType : toType);
	},

	/** The two signature entries for an automapper update payload that links `wormhole` to the jump.
		Normal match (jumped out of a hole that starts in `from`): the secondary side gets system `to`.
		Re-jump match: the side with no system gets system `from`. */
	linkSignatures: function(wormhole, signatures, from, to, rejump) {
		const initial = signatures[wormhole.initialID], secondary = signatures[wormhole.secondaryID];
		if (!rejump) { return [{ id: initial.id }, { id: secondary.id, systemID: to }]; }
		return initial.systemID == to ?
			[{ id: initial.id }, { id: secondary.id, systemID: from }] :
			[{ id: initial.id, systemID: from }, { id: secondary.id }];
	},

	/** The signature to show in the "Which Signature?" picker: for a re-jump the one in the system we arrived in. */
	pickerSignature: function(wormhole, signatures, to, rejump) {
		const initial = signatures[wormhole.initialID], secondary = signatures[wormhole.secondaryID];
		return rejump && secondary.systemID == to ? secondary : initial;
	}
};
