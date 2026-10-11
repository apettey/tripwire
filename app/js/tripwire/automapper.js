const automapState = {
	pendingDecision: false
};

tripwire.autoMapper = function(from, to) {
	console.log('Automapper: Jump from ' + from + ' to ' + to);
	
    var pods = [33328, 670];
    var undo = [];

    // Make sure the automapper is turned on & not disabled
    if (!$("#toggle-automapper").hasClass("active") || $("#toggle-automapper").hasClass("disabled"))
        return false;

	// Not waiting on a decision for the previous jump
	if(automapState.pendingDecision) {
		console.info('Not automapping because there is an automap dialog up');
		return false;
	}

    // Make sure from and to are valid systems
    if (!tripwire.systems[from] || !tripwire.systems[to])
        return false;

    // Make sure from and to are not the same system
    if (from == to)
        return false;
	
	// Not into a special region e.g. abyssal space
	if(tripwire.systems[from].regionID > 12000000 || tripwire.systems[to].regionID > 12000000) {
		console.info('Not automapping into abyssal or other special space');
		return false;
	}
	
	// Not into a special system
	const noMapSystems = [30000142, 30002187];	// Jita/Amarr
	if(noMapSystems.indexOf(from) >= 0 || noMapSystems.indexOf(to) >= 0) {	
		console.info('Not automapping into likely pod-out destination');
		return false;
	}

    // Is pilot in a station?
    if (tripwire.client.EVE && tripwire.client.EVE.stationID) {
		console.log('Automapper: Not recording because you are in a station');
        return false;
	}
	
    // Is pilot in a pod?
    if (tripwire.client.EVE && tripwire.client.EVE.shipTypeID && $.inArray(parseInt(tripwire.client.EVE.shipTypeID), pods) >= 0) {
    	console.log('Automapper: Not recording because you are in a pod');
		return false;
	}
	
    // Is this a gate?
    if (typeof(tripwire.map.shortest[from - 30000000]) != "undefined" && typeof(tripwire.map.shortest[from - 30000000][to - 30000000]) != "undefined") {
		console.log('Automapper: Not recording because this jump is a stargate');
        return false;
	}

     // Is this an existing connection?
     if ($.map(tripwire.client.wormholes,
               function(wormhole) {
                 const initial = tripwire.client.signatures[wormhole.initialID];
                 const secondary = tripwire.client.signatures[wormhole.secondaryID];
                 return initial && secondary &&
                   ((initial.systemID == from && secondary.systemID == to) ||
                    (initial.systemID == to && secondary.systemID == from))  ? wormhole : null;
               }).length > 0) {
		console.log('Automapper: Not recording because the connection exists');
       return false;
     }
	 
	 // Are both systems already in chain? Loops do happen but it's much more likely ESI missed a jump
	 function inChain(systemID) { return chain.data.map.rows.filter(r => r.c[0].systemID == systemID).length > 0; }
	if(inChain(from) && inChain(to)) {
		console.info('Not automapping because both systems are already in chain');
		return false;
	}	 

    var payload = {"signatures": {"add": [], "update": []}, "automap": { "character": tripwire.client.EVE.characterID, "from": from, "to": to } };

    var wormholes = wormholesForJump(from, to, tripwire.client.wormholes, tripwire.client.signatures);
    var rejump = false, candidates = [];
    if (!wormholes.length) {
        // No hole out of `from` matches: the hole into `to` may already be scanned with its far side unset (re-jump)
        candidates = automapperRejump.holesIntoDestination(from, to, tripwire.client.wormholes, tripwire.client.signatures);
        wormholes = candidates.map(function(c) { return c.wormhole; });
        rejump = wormholes.length > 0;
    }
	
    if (wormholes.length) {
        // A single re-jump candidate is only linked without asking when its Leads To / hole type match exactly
        if (wormholes.length > 1 || (rejump && !candidates[0].exact)) {
			console.log('Automapper: Multiple sigs matched, asking which one to update');
            $("#dialog-select-signature").dialog({
                autoOpen: true,
                title: "Which Signature?",
                width: 390,
                buttons: {
                    Cancel: function() {
                        $(this).dialog("close");
                    },
                    Ok: function() {
                        var i = $("#dialog-select-signature [name=sig]:checked").val();
                        if (i === undefined) { return; }
                        if (i === "new") {
                            payload.signatures.add.push(automapperRejump.newHole(from, to));
                            tripwire.refresh('refresh', payload, function(data) {
                                recordUndo(data);
                                $("#dialog-select-signature").dialog("close");
                            });
                            return;
                        }
                        var wormhole = wormholes[i];
                        var signature = tripwire.client.signatures[wormhole.initialID];
                        var signature2 = tripwire.client.signatures[wormhole.secondaryID];

                        payload.signatures.update.push({
                            "wormhole": {
                                "id": wormhole.id
                            },
                            "signatures": automapperRejump.linkSignatures(wormhole, tripwire.client.signatures, from, to, rejump)
                        });

                        var success = function(data) {
                            if (data.resultSet && data.resultSet[0].result == true) {
                                undo.push({"wormhole": wormhole, "signatures": [signature, signature2]});
                                $("#dialog-select-signature").dialog("close");
                            }
                        }

                        tripwire.refresh('refresh', payload, success);
                    }
                },
                open: function() {
					automapState.pendingDecision = true;
                    $("#dialog-select-signature .optionsTable tbody").empty();
					
					function formatSystem(systemID) {
						const system = systemAnalysis.analyse(systemID);
						return systemRendering.renderSystem(system);
					}
					
					document.getElementById('select-sig-from').innerHTML = formatSystem(from);
					document.getElementById('select-sig-to').innerHTML = formatSystem(to);

                    $.each(wormholes, function(i) {
                        const signature = automapperRejump.pickerSignature(wormholes[i], tripwire.client.signatures, to, rejump);
						const sigInfo = tripwire.makeSigInfo(signature, wormholes[i]);
						
                        const tr = "<tr>"
                          + "<td><input type='radio' name='sig' value='"+i+"' id='sig"+i+"' /></td>"
						  + "<td class='centerAlign'>" + formatSignatureID(signature.signatureID) + "</td>"
						  + "<td class='centerAlign'>" + sigInfo.formattedType + "</td>"
						  + "<td class='centerAlign'>" + sigInfo.leadsTo + "</td>"
						  + "<td class='centerAlign " + wormholes[i].life + "'>" + sigInfo.lifeText + "</td>"
						  + "<td class='centerAlign " + wormholes[i].mass + "'>" + wormholes[i].mass + "</td>"
                          + "</tr>";
						  
						const trElem = $(tr);
                        $(trElem).find('td').wrapInner("<label for='sig"+i+"' />");
                        $("#dialog-select-signature .optionsTable tbody").append(trElem);
                    });
                    if (rejump) {
                        // The hole may not be the one we came through: offer a fresh unknown hole instead
                        $("#dialog-select-signature .optionsTable tbody").append("<tr><td><input type='radio' name='sig' value='new' id='signew' /></td>"
                          + "<td class='centerAlign' colspan='5'><label for='signew'>New hole (none of these)</label></td></tr>");
                    }
                }, close: function() {
					automapState.pendingDecision = false;
				}
            });
        } else {
            var wormhole = wormholes[0];
            var signature = tripwire.client.signatures[wormhole.initialID];
            var signature2 = tripwire.client.signatures[wormhole.secondaryID];
			console.log('Automapper: Single signature: w=' + JSON.stringify(wormhole) + ' s1=' + signature.id + '/' + signature.signatureID + ' s2=' + signature2.id + '/' + signature2.signatureID );

            payload.signatures.update.push({
                "wormhole": {
                    "id": wormhole.id
                },
                "signatures": automapperRejump.linkSignatures(wormhole, tripwire.client.signatures, from, to, rejump)
            });
            undo.push({"wormhole": wormhole, "signatures": [signature, signature2]});
        }
    } else {
        // Nothing matches, create a new wormhole
		console.log('Automapper: No signatures match, creating a new unknown hole');
        payload.signatures.add.push(automapperRejump.newHole(from, to));
    }

    // Records undo entries for a finished automap request (also used by the picker's "New hole")
    function recordUndo(data) {
            if (data.resultSet && data.resultSet[0].result == true) {
                $("#undo").removeClass("disabled");

                // The undo stack of a system of the jump, not whatever system is being viewed
                var undoSystemID = automapperUndo.system(viewingSystemID, from, to);

                if (data.results) {
                    if (undoSystemID in tripwire.signatures.undo) {
                        tripwire.signatures.undo[undoSystemID].push({action: "add", signatures: data.results});
                    } else {
                        tripwire.signatures.undo[undoSystemID] = [{action: "add", signatures: data.results}];
                    }
                }

                if (undo.length) {
                    if (undoSystemID in tripwire.signatures.undo) {
                        tripwire.signatures.undo[undoSystemID].push({action: "update", signatures: undo});
                    } else {
                        tripwire.signatures.undo[undoSystemID] = [{action: "update", signatures: undo}];
                    }
                }

                sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo));
            }
    }

    if (payload.signatures.add.length || payload.signatures.update.length) {
        tripwire.refresh('refresh', payload, recordUndo);
    }
}

function wormholesForJump(from, to, wormholes, signatures) {
	const toSystem = systemAnalysis.analyse(to);
    const toType = toSystem.genericSystemType[0];
	const toClass = (toSystem.class || [])[0];
	return Object.values(wormholes).filter(function(wormhole) {
        if ( ( signatures[wormhole.initialID] !== undefined ) && ( signatures[wormhole.secondaryID] !== undefined ) ) {
            // Find wormholes that have no set Leads To system, and their initial system is from the wormhole we just jumped from
            if (signatures[wormhole.initialID].systemID == from && !appData.systems[signatures[wormhole.secondaryID].systemID]) {
				const holeTargetTypeName = appData.genericSystemTypes[signatures[wormhole.secondaryID].systemID];
				const holeClasses = systemAnalysis.classForTypeName(holeTargetTypeName);
				if(holeTargetTypeName === toType) {
					// Find wormholes where Leads To is the type we jumped into
					return true;
                } else if (holeClasses && 0 <= holeClasses.indexOf(toClass)) {
                    // Find wormholes that Leads To is generically set to the class we just jumped into
                    return true;
                } else if (wormhole.type && appData.wormholes[wormhole.type] && appData.wormholes[wormhole.type].leadsTo == toType) {
                    // Find wormholes that Type is known to lead to the class we just jumped into
                    return true;
                } else if (signatures[wormhole.secondaryID].systemID === null && (!wormhole.type || !appData.wormholes[wormhole.type])) {
                    // Find wormholes that don't have a Type or any kind of Leads To entered
                    return true;
                }
            }
        }
    });
}	