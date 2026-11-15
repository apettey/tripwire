const systemPanel = new function() {
	this.update = function() {
		// Update dependent controls: Path to chain/home
		const exits = chain.data.exits;
		var html = [
			renderFlare(),
			renderRoute((exits || []).map(function(x) { return x  - 30000000; }), true, 'chain', 'To chain'), 
			renderRoute(guidance_profiles.blueLootSystems, false, 'blue-loot', 'Blue loot buyer')
		].filter(function(x) { return x; }).join('');
		$("#infoExtra").html(html);
		Tooltips.attach($("#infoExtra [data-tooltip]"));
	};

	// Fork (ported from upstream 2.0): the viewed system's flare, its reason and how long it lasts (app/js/fork/flare-details.js)
	function renderFlare() {
		return typeof flareDetails !== 'undefined' ? flareDetails.panelHtml(flareDetails.find(chain.data.flares, viewingSystemID), flareDetails.nowSec()) : '';
	}
	
	function renderRoute(targets, addPathHome, cssClass, categoryText) {
		const path = targets ? guidance.findShortestPath(tripwire.map.shortest, viewingSystemID - 30000000, targets) : null;
		if(path) {
			const inChain = path.length <= 1;
			const exitSystem = path[path.length - 1] + 30000000;
			const prefixText = inChain ? 'In chain: ' : (path.length - 1) + 'j from ' ;
			const pathHomeText = addPathHome ? chain.data.systemsInChainMap[exitSystem].pathHome.slice().reverse()
				.map(function(n) { return '<a href=".?system=' + tripwire.systems[n.systemID].name + '">' + (n.name || tripwire.systems[n.systemID].name || '???') + '</a>'; })
				.join(' &gt; ') : '<a href=".?system=' + tripwire.systems[exitSystem].name + '">' + tripwire.systems[exitSystem].name + '</a>';
				const pathToChainText = inChain ? '' : '<br/>' + systemRendering.renderPath(path.slice().reverse());
				return '<div class="' + cssClass + '">' + categoryText + ': ' + prefixText + pathHomeText + pathToChainText + '</div>';
		} else { return null; }
	}

}();