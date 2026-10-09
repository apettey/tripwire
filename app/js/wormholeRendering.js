/** Functions for rendering things relating to wormholes */
const wormholeRendering = new function() { 
	/** Render a wormhole type (from appData.wormholes).
	* @param type The type object e.g. appData.wormholes.B274
	* @param key The wormhole type e.g. 'B274'
	* @param from What system, or type of system e.g. 'Class-2' the wormhole comes from. If omitted, the type object will be used
	* @param target As above but for the target of the wormhole
	*/
	this.renderWormholeType = function(type, key, from, target) {
		return ((key || type.key) ? '<b>' + (key || type.key || '') + '</b>: ' : '') +
			formatEndTypes(type.from, from) + '➔' + formatEndTypes(type.leadsTo, target) +
			(type.jump ? ' (' + this.renderMass(type.jump) + ')' : '')
			;
	};
	
	/** Render a mass number. */
	this.renderMass = function(mass) { return Math.trunc(mass / 1e6) + 'kt'; }
	
	function formatEndTypes(types, override) {
		if(!types) { return '?'; }
		types = Array.isArray(types) ? types : [ types ];
		
		if(override) {
			const overrideSystem = override.name ? override :
				systemAnalysis.analyse(Object.index(appData.systems, "name", override, true) || override);	// look up real system ID first
			
			const eligibleTypes = types.filter(function(type) {
				return overrideSystem.name == type || overrideSystem.genericSystemType == type;
			});
			
			if(eligibleTypes.length) { types = eligibleTypes; }
		}
		
		return types.map(function(type) {
			const systemID = Object.index(appData.systems, "name", type, true) || type;	// look up real system ID first
			const system = systemAnalysis.analyse(systemID);
			return system ? '<span class="' + system.systemTypeClass + '">' + (system.name || system.systemTypeName) + '</span>' : undefined }
		).filter(function(x) { return x !== undefined; }).join(',');
	};
}