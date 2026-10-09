
		$("#dialog-mass").dialog({
			autoOpen: false,
			width: "auto",
			height: "auto",
			dialogClass: "dialog-noeffect ui-dialog-shadow",
			buttons: {
				Close: function() {
					$(this).dialog("close");
				}
			},
			open: function() {
				var wormholeID = $(this).data("id");
				var systemID = $(this).data("systemID");
				var wormhole = tripwire.client.wormholes[wormholeID];
				var signature = tripwire.client.signatures[wormhole.initialID];
				var otherSignature = tripwire.client.signatures[wormhole.secondaryID];
				
				const fromSystem = systemAnalysis.analyse(signature.systemID), toSystem = systemAnalysis.analyse(otherSignature.systemID);
				
				const wormholeType = wormhole.type ? tripwire.wormholes[wormhole.type] : 
					Object.assign({from: fromSystem.genericSystemType, leadsTo: toSystem.genericSystemType }, wormholeAnalysis.likelyWormhole(signature.systemID, otherSignature.systemID));

				$("#dialog-mass").dialog("option", "title", "From "+fromSystem.name+" to "+toSystem.name);
				document.getElementById('mass-systems').innerHTML = "From "+systemRendering.renderSystem(fromSystem)+
				" To "+systemRendering.renderSystem(toSystem) +
				" via "+wormholeRendering.renderWormholeType(wormholeType, wormhole.type, fromSystem, toSystem);

				$("#dialog-mass #massTable tbody tr").remove();
				document.getElementById('mass-jumped').innerText = '?';
				document.getElementById('mass-capacity').innerText = '?';

				var payload = {wormholeID: wormhole.id};

				$.ajax({
					url: "mass.php",
					type: "POST",
					data: payload,
					dataType: "JSON"
				}).done(function(data) {
					if (data && data.jumps) {
						const massData = parseMassData(data.jumps);
						document.getElementById('mass-jumped').innerText = wormholeRendering.renderMass(massData.totalMass);
						document.getElementById('mass-capacity').innerText = wormholeType.mass ? wormholeRendering.renderMass(wormholeType.mass) : 'Unknown';
						document.getElementById('mass-placeholder-desc').style.display = wormholeType.dummy ? '' : 'none';
						for (x in massData.jumps) {
							const j = massData.jumps[x];
							
							const massMarkup = (j.massClass === 'Small' ? '' :
									'<i data-icon="prop-mod" class="' + (j.prop ? ' active' : 'inactive') + '"></i>' +
									'<i data-icon="anchor" class="' + (j.higgs ? ' active' : 'inactive') + '"></i> '
								) + wormholeRendering.renderMass(j.mass);
							$("#dialog-mass #massTable tbody").append("<tr class='mass-" + getMassClass(j.mass) + "'><td>"+j.characterName+"</td><td>"+(j.targetSystem == systemID ? "Into " + systemRendering.renderSystem(toSystem, 'span') : "Return to " + systemRendering.renderSystem(fromSystem, 'span'))+"</td><td>"+j.shipName+"</td><td>"+massMarkup+"</td><td>"+j.time+"</td></tr>");
						}
						// Summary rows
                        $("#dialog-mass #massTable tbody").append("<tr id='small-mass'><td></td><td></td><td>Small jumps</td><td>"+ wormholeRendering.renderMass(massData.smallMass) +"</td><td></td></tr>");
                        $("#dialog-mass #massTable tbody").append("<tr id='medium-mass'><td></td><td></td><td>Medium jumps</td><td>"+ wormholeRendering.renderMass(massData.mediumMass) +"</td><td></td></tr>");
                        $("#dialog-mass #massTable tbody").append("<tr id='large-mass'><td></td><td></td><td>Large jumps</td><td>"+ wormholeRendering.renderMass(massData.largeMass) +"</td><td></td></tr>");
                        $("#dialog-mass #massTable tbody").append("<tr><td></td><td></td><td></td><th>"+ wormholeRendering.renderMass(massData.totalMass) +"</th><td></td></tr>");
					}
				});
			}
		});

function getMassClass(jumpMass) {
	return jumpMass <= 5e6 ? 'Small' :
	 jumpMass <= 80e6 ? 'Medium' :
	 jumpMass <= 500e6 ? 'Large' :
	 'X-Large';
}

function parseMassData(jumps) {
	const result = { totalMass: 0, smallMass: 0, mediumMass: 0, largeMass: 0, xlMass: 0, jumps: [] };
	for (x in jumps) {
		const shipData = appData.mass[jumps[x].shipTypeID];
		if(!shipData) { continue; }	// sometimes ship is not recorded, or ship isn't in SDE dump yet
		const originalMass = parseFloat(shipData.mass);
		const shipFlagsText = jumps[x].shipType.split('|', 2)[1] || '';
		const shipFlags = { higgs: shipFlagsText.indexOf('h') >= 0, prop: shipFlagsText.indexOf('p') >= 0 };
		const massClass = getMassClass(originalMass);
		const jumpMass = (originalMass + (shipFlags.prop ? (massClass === 'X-Large' ? 500e6 : 50e6) : 0)) * (shipFlags.higgs ? 2 : 1);
		result.totalMass += jumpMass;
		switch(massClass) {
			case 'Small': result.smallMass += jumpMass; break;
			case 'Medium': result.mediumMass += jumpMass; break;
			case 'Large': result.largeMass += jumpMass; break;
			case 'X-Large': result.xlMass += jumpMass; break;
		}
		result.jumps.push( { 
			originalMass: originalMass, mass: jumpMass, massClass: massClass,
			higgs: shipFlags.higgs, prop: shipFlags.prop, shipName: shipData.typeName,
			targetSystem: jumps[x].toID, 
			characterName: jumps[x].characterName.split('|')[0],
			time: jumps[x].time 
		});
	}
	return result;
}