/** Functions for rendering things relating to systems or parts of the chain */
const systemRendering = new function() { 
	/** Render a path, as returned from guidance.findShortestPath */
	this.renderPath = function(path) {
		if(path.length <= 1 || path.length > options.chain.routingLimit) { return '' + path.length - 1; }
		else {
			var systemMarkup = path
			.slice(0, path.length - 1).reverse()
			.map(function(s) {
				const systemID = 30000000 + 1 * s;
				const system = systemAnalysis.analyse(systemID);
				const securityClass = system.systemTypeClass;
				return '<span class="' + securityClass + '" data-tooltip="' + system.name + ' (' + system.security + ')" onclick="tripwire.systemChange(' + systemID + ')">' + system.pathSymbol + '</span>';
			});
			var r = '<span class="path">';
			for(var i = 0; i < systemMarkup.length; i++) {
				if(i > 0 && 0 == i % 5) { r += '|'; }
				
				r += systemMarkup[i];				 
			}
			return r + '</span>';
		}
	}
	
	this.renderEffect = function(system, tag) {
		return system.effectClass ? "<" + tag + " class='whEffect' data-icon='"+system.effectClass+"' data-tooltip='"+system.effect+"'></" + tag + ">" : '';
	}
	
	this.renderSystem = function(systemInfo, tag) {
		tag = tag || 'a';
		const text = systemInfo.name || systemInfo.genericSystemType;
		return '<' + tag + (tag === 'a' ? ' href=".?system=' + systemInfo.name + '"' : '') + '>' + text + '</' + tag + '> (' + this.renderEffect(systemInfo, 'span') + '<span class="' + systemInfo.systemTypeClass + '">' + systemInfo.systemTypeName + '</span>)';
	}
};