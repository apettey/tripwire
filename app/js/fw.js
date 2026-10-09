const fw = new _FactionWarfare();

function _FactionWarfare() {
	const _this = this;
	this.listeners = [];
	this.data = null;
	this.systems = {};
	this.SamanuniAthounonGateOpen = true;
	
	/** Refresh the FW data from the public ESI endpoint */
	this.refresh = function() {
		$.ajax({
			url: 'cached_third_party.php?key=fw',
			type: "GET",
			dataType: "JSON"
		}).done(function(data, status, xhr) {	
			if(!_.isEqual(data, _this.data)) {
				console.info('Updating faction warfare status');
				_this.data = data;
				_this.parse(data);
				tripwire.systemChange(viewingSystemID);
				guidance.clearCache();
			}
		}).fail(function(xhr, status, error) {
			console.warn('Failed to fetch FW data from ESI: ' + status, error);
		});
	};	
	
	this.parse = function(data) {
		this.systems = {};
		for(var i = 0; i < data.length; i++) { this.systems[data[i].solar_system_id] = data[i]; }
		this.SamanuniAthounonGateOpen = this.systems[30003856].occupier_faction_id == 500001;
	}
	
	// Guidance plugin
	this.adjustJumpCost = function(from, to, cost) {
		const gateOpen = this.SamanuniAthounonGateOpen || !((from == 3856 && to == 45322) || (to == 3856 && from == 45322));
		return gateOpen ? cost : -1;
	}.bind(this);	// because it's called from outside
	guidance.jumpCostModifiers.push(this.adjustJumpCost);
	
	/** Gets the markup for faction text for a system. If it's in FW, it will show contested status; if not it will just show the faction */
	this.factionMarkup = function(system) {
		return system.factionID ? (
			_this.systems[system.systemID] ? 
				appData.factions[_this.systems[system.systemID].occupier_faction_id].name + ' (FW: ' + 
					(_this.systems[system.systemID].contested == 'uncontested' ? 'uncontested' : 
						Math.floor(100 * _this.systems[system.systemID].victory_points / _this.systems[system.systemID].victory_points_threshold) + '% contested') + ')'
				: appData.factions[system.factionID].name
		) : "&nbsp;";
	};
	
	setInterval(this.refresh, 3600000);
	this.refresh();	
}