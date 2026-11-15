tripwire.parse = function(server, mode) {
    var data = $.extend(true, {}, server);

    var updateSignatureTable = false;
	const newSigsInSystem = { };

    if (options.chain.active == null || (options.chain.tabs[options.chain.active] && options.chain.tabs[options.chain.active].evescout != true)) {
        if (options.masks.active != "273.0") {
            for (var key in data.signatures) {
                if (data.signatures[key].mask == "273.0") {
                    delete data.signatures[key];
                }
            }
        }
    }

    if (mode == 'refresh') {
        // preserve client.EVE across refresh otherwise tracking/automapper will be confused
        var EVE = this.client.EVE;
        var prevWormholes = (this.client && this.client.wormholes) || {};
        this.client = server;
        this.client.EVE = EVE;
        var wormholeOf = function(wormholes, sigId) {
            for (var id in wormholes) { if (wormholes[id].initialID == sigId || wormholes[id].secondaryID == sigId) { return wormholes[id]; } }
            return null;
        };

        for (var key in data.signatures) {
            if (data.signatures[key].systemID != viewingSystemID) {
                continue;
            }
			newSigsInSystem[key] = data.signatures[key];
            var disabled = data.signatures[key].mask == "273.0" && options.masks.active != "273.0" ? true : false;

            // Check for differences
            if (!tripwire.signatures.list[key]) {
				tripwire.signatures.list[key] = data.signatures[key];	// To reduce race condition chance
                this.addSig(data.signatures[key], {animate: true}, disabled);
                updateSignatureTable = true;
            } else {
                // Any column that differs re-renders the row. This used to be
                // gated on modifiedTime, which has one-second resolution: two
                // edits of a hole inside a second (life to <1h, then Expired)
                // left the second one invisible until something else changed.
                // A wormhole's own record (life, mass, type) lives beside the
                // signature and is compared too.
                var edit = false;
                for (column in data.signatures[key]) {
                    if (data.signatures[key][column] != tripwire.signatures.list[key][column] && column != "editing") {
                        edit = true;
                    }
                }
                if (!edit && data.signatures[key].type == "wormhole") {
                    var whNow = wormholeOf(this.client.wormholes || {}, key), whBefore = wormholeOf(prevWormholes, key);
                    if (whNow && whBefore && (whNow.life != whBefore.life || whNow.mass != whBefore.mass || whNow.type != whBefore.type || whNow.parent != whBefore.parent)) {
                        edit = true;
                    }
                }

                if (edit) {
                    this.editSig(data.signatures[key], disabled);
                }
            }
        }

        // Sigs needing removal
        for (var key in tripwire.signatures.list) {
            if (!data.signatures[key]) {
                this.deleteSig(key);
            }
        }
    } else if (mode == 'init' || mode == 'change') {
        // fork: keep client.EVE here too, or the next location poll can't see a jump (automapper, Follow, jump pop-ups)
        var EVE = this.client.EVE;
        this.client = server;
        this.client.EVE = EVE;

        for (var key in data.signatures) {
            if (data.signatures[key].systemID != viewingSystemID) {
                continue;
            }
			newSigsInSystem[key] = data.signatures[key];
            var disabled = data.signatures[key].mask == "273.0" && options.masks.active != "273.0" ? true : false;
			
			if(!tripwire.signatures.list[key]) {
				this.addSig(data.signatures[key], {animate: false}, disabled);
				updateSignatureTable = true;
			}
            if (data.signatures[key].editing) {
                this.sigEditing(data.signatures[key]);
            }
        }
    } else { return; }	// unknown type of parse request so do nothing

    if (updateSignatureTable) {
        $("#sigTable").trigger("update");
    }
    tripwire.signatures.list = data.signatures;
	tripwire.signatures.currentSystem = newSigsInSystem;
		
    // set the sig count in the UI
    var signatureCount = { total: 0, wormhole: 0, signature: 0, anomaly: 0 };
    $.map(data.signatures, function(signature) {
		if(signature.systemID != viewingSystemID) { return; }
		signatureCount.total++;
		
		if(signature.type === 'wormhole') { signatureCount.wormhole++; }
		else if(signature.scan_group === 'anomaly') { signatureCount.anomaly++; }
		else { signatureCount.signature++; }
	});
    $("#signature-count").html(signatureCount.total ? (signatureCount.total + ' ( <span id="sig-breakdown">'
		+ (signatureCount.wormhole ? scanGroupText.wormhole + signatureCount.wormhole + ' ' : '')
		+ (signatureCount.signature ? scanGroupText.signature + signatureCount.signature + ' ' : '')
		+ (signatureCount.anomaly ? scanGroupText.anomaly + signatureCount.anomaly + ' ' : '')
		+ '</span>)'): 0
	);
}

/** Find if there is an unknown return sig. The markup is always generated (in addSignature.js) */
tripwire.updateReturnStatus = function() {
	const inSigId = $("#chainMap [data-nodeid='"+viewingSystemID+"']:not(.calc)").attr('data-insigid');
	const wormholeId = $("#chainMap [data-nodeid='"+viewingSystemID+"']:not(.calc)").attr('data-sigid');
	const wormhole = tripwire.client.wormholes[wormholeId] || {};
	// One of the two ends should be in this system, In sig will be the wrong end, so find the other end
	const returnSigId = wormhole.initialID == inSigId ? wormhole.secondaryID : wormhole.initialID;
	tripwire.signatures.returnSig = tripwire.signatures.list[returnSigId];
	const needReturn = tripwire.signatures.returnSig && (tripwire.signatures.returnSig.signatureID == '???' || tripwire.signatures.returnSig.signatureID == '' || tripwire.signatures.returnSig.signatureID === null || tripwire.signatures.returnSig.signatureID === undefined);
	document.getElementById('sigTableWrapper').className = needReturn ? 'return-visible' : 'return-invisible';	
}