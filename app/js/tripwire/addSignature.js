// Hanldes adding to Signatures section
// ToDo: Use native JS
tripwire.makeSigInfo = function(sig, wormhole) {
	wormhole = wormhole ||	// allow to be passed in to save this lookup
		Object.values(tripwire.client.wormholes).find(function (wh) { return wh.initialID == sig.id || wh.secondaryID == sig.id});
	if (!wormhole) return false;
	var otherSignature = sig.id == wormhole.initialID ? tripwire.client.signatures[wormhole.secondaryID] : tripwire.client.signatures[wormhole.initialID];
	if (!otherSignature) return false;

	let leadsTo;
	if (sig.name) {
	  leadsTo = tripwire.systems[otherSignature.systemID] ?
		"<a href='.?system="+tripwire.systems[otherSignature.systemID].name+"'>"+_.escape(sig.name)+"</a> &ndash; " + systemRendering.renderSystem(systemAnalysis.analyse(otherSignature.systemID), 'a') : 
		_.escape(sig.name);
	} else if (appData.genericSystemTypes[otherSignature.systemID]) {
		leadsTo = appData.genericSystemTypes[otherSignature.systemID];
	} else if (tripwire.systems[otherSignature.systemID]) {
		leadsTo = systemRendering.renderSystem(systemAnalysis.analyse(otherSignature.systemID), 'a');
	} else {
		leadsTo = "";
	}

	const wormholeTypeText = wormhole.type || "???";
	return {
		id: sig.id,
		leadsTo: leadsTo,
		wormhole: wormhole,
		formattedType: (wormhole[wormhole.parent+"ID"] == sig.id ? wormholeTypeText : (wormhole.parent ? "[" + wormholeTypeText + "]" : "")),
		lifeText: { critical: 'EOL', stable: 'Stable' }[wormhole.life] || wormhole.life,
	}
}

tripwire.addSig = function(add, option, disabled) {
    var option = option || {};
    var animate = typeof(option.animate) !== 'undefined' ? option.animate : true;
    var disabled = disabled || false;
    var wormhole = {};

	const returnLinkText = add.signatureID ? '<a class="return-link" href="#" onclick="tripwire.setReturnSig(event, ' + add.id + ')">&gt;&gt; Set ' + 
				add.signatureID.substring(0, 3).toUpperCase() + '-' + add.signatureID.substring(3) +
				' as return</a>'
				: '';

    if (add.type == "wormhole") {
		const sigInfo = tripwire.makeSigInfo(add);
		if(!sigInfo) return false;
		
		wormhole = sigInfo.wormhole;
		
		const leadsToText = sigInfo.leadsTo ? sigInfo.leadsTo : 
			add.signatureID && add.signatureID.length && add.signatureID[0] != '?' ? returnLinkText
			: '';	

        var row = "<tr data-id='"+add.id+"' data-tooltip='' "+ (disabled ? 'disabled="disabled"' : '') +">"
            + "<td class='"+ options.signatures.alignment.sigID +"'>"+formatSignatureID(add.signatureID)+"</td>"
            + "<td class='type-tooltip "+ options.signatures.alignment.sigType +"' data-tooltip=\""+this.whTooltip(wormhole)+"\">"+sigInfo.formattedType+"</td>"
            + "<td class='age-tooltip "+ options.signatures.alignment.sigAge + (parseInt(add.lifeLength) === 0 ? " disabled" : "") +"' data-tooltip='"+this.ageTooltip(add)+"'><span data-age='"+add.lifeTime+"'></span></td>"
            + "<td class='"+ options.signatures.alignment.leadsTo +"'>"+leadsToText+"</td>"
            + "<td class='"+wormhole.life+" "+ options.signatures.alignment.sigLife +"'>"+sigInfo.lifeText+"</td>"
            + "<td class='"+wormhole.mass+" "+ options.signatures.alignment.sigMass +"'>"+wormhole.mass+"</td>"
            + "</tr>";

        var tr = $(row);
    } else {
		const leadsToText = add.type === 'unknown' ? returnLinkText : 
			(add.name ? linkSig(add.name) : '');
        var row = "<tr data-id='"+add.id+"' data-tooltip='' "+ (disabled ? 'disabled="disabled"' : '') +">"
            + "<td class='"+ options.signatures.alignment.sigID +"'>"+formatSignatureID(add.signatureID)+"</td>"
            + "<td class='"+ options.signatures.alignment.sigType +"'>"+add.type+"</td>"
            + "<td class='age-tooltip "+ options.signatures.alignment.sigAge + (parseInt(add.lifeLength) === 0 ? " disabled" : "") +"' data-tooltip='"+this.ageTooltip(add)+"'><span data-age='"+add.lifeTime+"'></span></td>"
            + "<td class='"+ options.signatures.alignment.leadsTo +"' colspan='3'>"+leadsToText+"</td>"
            + "</tr>";

        var tr = $(row);
    }

    Tooltips.attach($(tr).find("[data-tooltip]"));

    $("#sigTable").append(tr);

    // Add counter
    if (wormhole.life == "critical") {
        $(tr).find('span[data-age]').countdown({until: moment.utc(add.lifeLeft).toDate(), onExpiry: this.pastEOL, alwaysExpire: true, compact: true, format: this.ageFormat, serverSync: this.serverTime.getTime})
            // .countdown('pause')
            .addClass('critical')
            // .countdown('resume');
    } else {
        $(tr).find('span[data-age]').countdown({since: moment.utc(add.lifeTime).toDate(), compact: true, format: this.ageFormat, serverSync: this.serverTime.getTime});
    }

    if (animate) {
        $(tr)
            .find('td')
            .wrapInner('<div class="hidden" />')
            .parent()
            .find('td > div')
            .slideDown(700, function(){
                $set = $(this);
                $set.replaceWith($set.contents());
            });

        $(tr).find("td").animate({backgroundColor: "#004D16"}, 1000).delay(1000).animate({backgroundColor: "#111"}, 1000, null, function() {$(this).css({backgroundColor: ""});});
    }
}

tripwire.setReturnSig = function(event, sigToRemoveId) {
	event.preventDefault();
	const sigToUpdate = tripwire.signatures.returnSig;
	const sigToRemove = tripwire.client.signatures[sigToRemoveId];
	
	if(!(sigToUpdate && sigToRemove)) { return; }
	
	sigDialog.overwriteSignature(sigToRemoveId, function(data) {
		sigToUpdate.signatureID = sigToRemove.signatureID;
		// we need the wormhole part to make refresh.php not think the sig isn't a wormhole any more
		const payload = {"signatures": {"update": [ { wormhole: 'dummy', signatures: [ sigToUpdate ] } ] }};
		tripwire.refresh('refresh', payload);
	});
}