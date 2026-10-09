const eveScout = new _EveScoutSignatureConnection();

function _EveScoutSignatureConnection() {
	const _this = this;
	
	this.links = [];
	
	this.active = function() {
		return 'undefined' !== typeof options && options.chain.tabs[options.chain.active] && options.chain.tabs[options.chain.active].evescout;
	}
	
	this.nodeNameSuffix = 'eve-scout';
	
	this.findLinks = function(systemID, ids) {
		if(!this.active()) { return []; }
		
		const r = [];
		for(var ti = 0; ti < this.links.length; ti++) {
			const eveScoutLink = this.links[ti];
			const eveScoutID = 'ES-' + eveScoutLink.id;
			
			const nodeDefaults = {
				life: eveScoutLink.remaining_hours >= 4 ? 'stable' : 'critical',
				mass: 'stable',	// they no longer attempt to track mass
				id: eveScoutID,
			};
			
			if(eveScoutLink.out_system_id == systemID) {	// Connection from this hole
				r.push(Object.assign({
					
					parent: {
						id: ids.parentID,
						systemID: systemID,
						signatureID: eveScoutLink.in_signature,
						type: eveScoutLink.wh_exits_outward ? eveScoutLink.wh_type : 'K162'
					},	child: {
						id: ids.nextChildID++,
						systemID: eveScoutLink.in_system_id,
						signatureID: eveScoutLink.out_signature,
						type: eveScoutLink.wh_exits_outward ? 'K162' : eveScoutLink.wh_type
					}
				}, nodeDefaults));
			} else if(eveScoutLink.in_system_id == systemID) { // Connection to this hole
				r.push(Object.assign({
					parent: {
						id: ids.parentID,
						systemID: systemID,
						signatureID: eveScoutLink.out_signature,
						type: eveScoutLink.wh_exits_outward ? 'K162' : eveScoutLink.wh_type
					},	child: {
						id: ids.nextChildID++,
						systemID: eveScoutLink.out_system_id,
						signatureID: eveScoutLink.in_signature,
						type: eveScoutLink.wh_exits_outward ? eveScoutLink.wh_type : 'K162'
					}
				}, nodeDefaults));				
			}
		}
		
		return r;
	}
	
	/** Refresh the signature data from the public Eve-Scout API */
	this.refresh = function() {
		if(!_this.active()) {
			return;	// only look for Thera data if on a tab with the option selected
		}
		
		$.ajax({
			url: 'cached_third_party.php?key=eve-scout-signatures',
			type: "GET",
			dataType: "JSON"
		}).done(function(data, status, xhr) {	
			if(!_.isEqual(data, _this.links)) {
				console.info('Updating map for EvE Scout update');
				_this.links = data;
				chain.redraw();
			}
		}).fail(function(xhr, status, error) {
			console.warn('Failed to fetch signatures from eve-scout.com: ' + status, error);
		});
	};
	
	setInterval(this.refresh, 60000);
	setTimeout(this.refresh, 0);
}