const systemAnalysis = new function() {
	const mutators = [];
	this.addMutator = function(m) { mutators.push(m); }
	
	/** Extract attributes of the system, and allow mutators to add/modify them.
		Optionally, pass in a system object */
	this.analyse = function(systemID, system) {
		if(!system) { system = appData.systems[systemID]; }
		if(!system) { system = getDummySystem(systemID); }
		if(!systemID) { systemID = system.systemID; }
		const r = Object.assign({}, system);
		
		// Defaults or saved original values
		r.baseSecurity = 1 * system.security;
		r.pathSymbol = '■';
		r.systemTypeModifiers = [];		
		r.systemID = systemID;
		
		mutators.forEach(function(m) { m.mutate(r, systemID); });
		
		// Calculated final values
		r.class = (!r.class || Array.isArray(r.class)) ? r.class : [1 * r.class];
		r.systemTypeClass = r.class ? 'wh class-' + r.class[0] :
			r.factionID == 500026 ? 'triglavian' :
			r.security >= 0.45 ? 'hisec' :
			r.security > 0.0 ? 'lowsec' :
			r.security <= 0.0 ? 'nullsec' :
			'unknown';
		r.systemTypeName = r.class ? 'C' + r.class.join('/') :
			r.factionID == 500026 ? 'Trig' :
			r.baseSecurity >= 0.45 ? 'HS' :
			r.baseSecurity > 0.0 ? 'LS' :
			r.baseSecurity <= 0.0 ? 'NS' :
			' ';
		r.genericSystemType = r.class ? r.class.map(x => 'Class-' + x) :
			r.factionID == 500026 ? ['Triglavian'] :
			r.baseSecurity >= 0.45 ? ['High-Sec'] :
			r.baseSecurity > 0.0 ? ['Low-Sec'] :
			r.baseSecurity <= 0.0 ? ['Null-Sec'] :
			undefined;
		r.effectClass = 
			r.effect === 'Black Hole' ? 'blackhole' :
			r.effect === 'Cataclysmic Variable' ? 'cataclysmic-variable' :
			r.effect === 'Magnetar' ? 'magnetar' :
			r.effect === 'Pulsar' ? 'pulsar' :
			r.effect === 'Red Giant' ? 'red-giant' :
			r.effect === 'Wolf-Rayet Star' ? 'wolf-rayet' :
			undefined;
			
		return r;
	};
	
	/** Get the classes possible for a 'leads to' text e.g. 'Class-2', 'Dangerous', 'Triglavian' */
	function classForTypeName(leadsTo) {
		return leadsTo && leadsTo.substring(0, 6) == 'Class-' ? [1 * leadsTo.substring(6)] :
			'Dangerous' == leadsTo ? [4,5] :
			'Unknown' == leadsTo ? [2,3] :
			'Unknown (small)' == leadsTo ? [1,2,3,13] :
			undefined;
	};
	this.classForTypeName = classForTypeName;	// expose public
	
	/** Create a dummy system object for fake IDs like 'Null-Sec', 'Class-5' etc */
	function getDummySystem(systemID) {
		const leadsToPointer = typeof(systemID) === "string" && systemID.indexOf("|") >= 0 ? appData.genericSystemTypes[systemID.substring(0, systemID.indexOf("|"))]
		: appData.genericSystemTypes.indexOf(systemID) >= 0 ? systemID
		: appData.genericSystemTypes[systemID];
		const nodeClass = classForTypeName(leadsToPointer);
		const nodeSecurity = 
			leadsToPointer == "High-Sec" ? 0.8 :
			leadsToPointer == "Low-Sec" ? 0.4 :
			leadsToPointer == "Null-Sec" ? -0.1 :
			undefined;
		const nodeFaction = 
			leadsToPointer == "Triglavian" ? 500026 :
			undefined;
		
		return { security: nodeSecurity, class: nodeClass, factionID: nodeFaction };
	}
}