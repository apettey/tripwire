const sigDialog = {};
const sigDialogVM = {};

sigDialog.openSignatureDialog = function(e) {
	if(e.preventDefault) { e.preventDefault(); }	// Allow calls with fake event-like objects too
	sigDialogVM.mode = e.data.mode;
	
	switch(sigDialogVM.mode) {
		case 'update':
			if (e.data.source == "sig-row") {
				$("#sigTable tr.selected").removeClass("selected");
				$(this).closest("tr").addClass("selected");
				sigDialogVM.sigId = $(this).data('id');
			} else if (e.data.source == "edit-sig") {
				var elements = $("#sigTable tbody tr.selected");
				if (elements.length !== 1) {
					return false;
				} else {
					sigDialogVM.sigId = $(elements[0]).data('id');
				}
			} else { sigDialogVM.sigId = e.data.signature; }
			break;
		default: delete sigDialogVM.sigId;
	}
	
	sigDialogVM.viewingSystemID = ( sigDialogVM.sigId ) ? tripwire.client.signatures[sigDialogVM.sigId].systemID : viewingSystemID;
	sigDialogVM.viewingSystem = tripwire.systems[sigDialogVM.viewingSystemID];
	
	if (!$("#dialog-signature").hasClass("ui-dialog-content")) {
		$("#dialog-signature").dialog({
			autoOpen: true,
			resizable: false,
			dialogClass: "dialog-noeffect ui-dialog-shadow",
			position: {my: "center", at: "center", of: $("#signaturesWidget")},
			buttons: {
				Delete: function() {
					const d = $(this);
					openDeleteDialog({ signatures: [tripwire.client.signatures[sigDialogVM.sigId]] }, () => d.dialog('close') );
				},
				Save: function() {
					$("#form-signature").submit();
				},
				Add: function() {
					$("#form-signature").submit();
				},
				Cancel: function() {
					$(this).dialog("close");
				}
			},
			create: function() {
				var aSigWormholes = Object.assign({}, appData.wormholes, wormholeAnalysis.dummyWormholes, { K162: {} } );
				
				function system_select_item_mapper(items) {
					return items.concat(appData.genericSystemTypes).map(function(name) {
						return Object.assign({name:name}, systemAnalysis.analyse(name)); 
					});
				}

				$("#dialog-signature [name='signatureType'], #dialog-signature [name='signatureLife']").selectmenu({width: 100});
				$("#dialog-signature [data-autocomplete='sigSystems']").inlinecomplete({source: tripwire.aSigSystems, renderer: 'system', select_item_mapper: system_select_item_mapper, extraMatch: (term, value) => term.toUpperCase() === value.systemTypeName, maxSize: 10, delay: 0});
				
				function getTargetName() { return $("#dialog-signature .leadsTo:visible").val(); }
				function getTargetSystem() {
					return wormholeAnalysis.targetSystemID(getTargetName(), undefined);	
				};
				
				function sigTypeDropdownFiller(extractor) {
					return function() {
						const eligible = wormholeAnalysis.eligibleWormholeTypes(sigDialogVM.viewingSystemID, getTargetSystem());
						return extractor(eligible);
					}
				}
				const sigTypeFromFiller =  sigTypeDropdownFiller(function(x) { return x.from; });
				const sigTypeToFiller =  sigTypeDropdownFiller(function(x) { return x.to; });
				
				function renderInbound(item) {	// Render with the type of the systems, if we know, so we don't get "from: [drifter wormholes]" if we know we're in a C2
					return wormholeRendering.renderWormholeType(item, item.key, getTargetName(), sigDialogVM.viewingSystem.name);
				}
				function renderOutbound(item) {	// As above
					return wormholeRendering.renderWormholeType(item, item.key, sigDialogVM.viewingSystem.name, getTargetName());
				}
				
				$("#dialog-signature [data-autocomplete='sigTypeFrom']").inlinecomplete({source: aSigWormholes, renderer: renderOutbound, maxSize: 10, delay: 0, customDropdown: sigTypeFromFiller});
				$("#dialog-signature [data-autocomplete='sigTypeTo']").inlinecomplete({source: aSigWormholes, renderer: renderInbound, maxSize: 10, delay: 0, customDropdown:sigTypeToFiller});
				
				function updateQuickSelect(elem, filler) {
					elem.innerHTML = '';
					const values = filler();
					if(values.length < 4) {
						values.forEach(type => {
							const button = document.createElement('button');
							button.className = 'quick-select';
							if(type.jump <= 5000000) { button.className += ' frig'; }
							button.textContent = type.key;
							button.value = type.key;
							button.type = 'button'; // otherwise it is 'submit'
							button.tabIndex = -1; // keyboard users will just want to type in the autocomplete field
							elem.appendChild(button);
						});
					}
				}
				function updateQuickSelects() {
					updateQuickSelect(document.getElementById('wormholeTypeQuickSelectFrom'), sigTypeFromFiller);
					updateQuickSelect(document.getElementById('wormholeTypeQuickSelectTo'), sigTypeToFiller);
				}
				
				$('#wormholeTypeQuickSelectFrom').on('click', e => $("#dialog-signature input[name='wormholeType']").val(e.target.value).change());
				$('#wormholeTypeQuickSelectTo').on('click', e => $("#dialog-signature input[name='wormholeType2']").val(e.target.value).change());

				$("#dialog-signature #durationPicker").durationPicker();
				$("#dialog-signature #durationPicker").on("change", function() {
					// prevent negative values
					if (this.value < 0) {
						this.value = 0;
						$(this).change();
					}
				});

				// Ensure first signature ID field only accepts letters
				$("#dialog-signature [name='signatureID_Alpha'], #dialog-signature [name='signatureID2_Alpha']").on("input", function() {
					while (!/^[a-zA-Z?]*$/g.test(this.value)) {
						this.value = this.value.substring(0, this.value.length -1);
					}
				});

				// Move to the numeric ID after filling out alpha ID
				$("#dialog-signature [name='signatureID_Alpha']").on("input", function() {
					if (this.value.length === 3) {
						$("#dialog-signature [name='signatureID_Numeric']").select();
					}
				});

				$("#dialog-signature [name='signatureID2_Alpha']").on("input", function() {
					if (this.value.length === 3) {
						$("#dialog-signature [name='signatureID2_Numeric']").select();
					}
				});

				// Ensure second signature ID field only accepts numbers
				$("#dialog-signature [name='signatureID_Numeric'], #dialog-signature [name='signatureID2_Numeric']").on("input", function() {
					while (!/^[0-9?]*$/g.test(this.value)) {
						this.value = this.value.substring(0, this.value.length -1);
					}
				});
				
				// Positioning hack to separate delete button visually
				$("#dialog-signature").parent().find("button:contains('Delete')").css( { position: 'absolute', left: '30px' } );

				// Select value on click
				$("#dialog-signature .signatureID, #dialog-signature .wormholeType").on("click", function() {
					$(this).select();
				});
				
				// Update quick selectors when the leadsTo system changes
				$("#dialog-signature [name='leadsTo']").on("change", updateQuickSelects);
				
				// Shortcut buttons to update leadsTo
				$('#leadsToQuickBar').on('click', e => {
					let target = e.target;
					while(target.tagName !== 'BUTTON') { target = target.parentElement; }
					$("#dialog-signature [name='leadsTo']").val(target.value).change();
				});

				// Auto fill opposite side wormhole w/ K162
				$("#dialog-signature .wormholeType").on("input, change", function() {
					if (this.value.length > 0 && aSigWormholes[this.value.toUpperCase()] != -1 && this.value.toUpperCase() != "K162") {
						$("#dialog-signature .wormholeType").not(this).val("K162");

						// Also auto calculate duration
						if (appData.wormholes[this.value.toUpperCase()]) {
							$("#dialog-signature #durationPicker").val(appData.wormholes[this.value.toUpperCase()].life.substring(0, 2) * 60 * 60).change();
						}
					} else if (this.value.toUpperCase() === "K162") {
						if (aSigWormholes[$("#dialog-signature .wormholeType").not(this).val().toUpperCase()] || $("#dialog-signature .wormholeType").not(this).val().toUpperCase() === "K162") {
							$("#dialog-signature .wormholeType").not(this).val("????");
						}
					} else if (this.value == "????") {
						$("#dialog-signature .wormholeType").not(this).val("K162");
					}
				});

				// Toggle between wormhole and regular signatures
				$("#dialog-signature").on("selectmenuchange", "[name='signatureType']", function() {
					if (this.value == "wormhole") {
						$("#dialog-signature #site").slideUp(200, function() { $(this).hide(0); });
						$("#dialog-signature #wormhole").slideDown(200, function() { $(this).show(200); });
					} else {
						$("#dialog-signature #site").slideDown(200, function() { $(this).show(200); });
						$("#dialog-signature #wormhole").slideUp(200, function() { $(this).hide(0); });
					}

					ValidationTooltips.close();
				});

				$("#form-signature").submit(function(e) {
					e.preventDefault();
					var form = $(this).serializeObject();
					var valid = true;
					ValidationTooltips.close();

					// Validate full signature ID fields (blank | 3 characters)
					$.each($("#dialog-signature .signatureID:visible"), function() {
						if (this.value.length > 0 && this.value.length < 3) {
							ValidationTooltips.open({target: $(this)}).setContent("Must be 3 characters in length!");
							$(this).select();
							valid = false;
							return false;
						}
					});
					if (!valid) return false;

					// Validate full signature ID doesn't already exist in current system
					if (form.signatureID_Alpha.length === 3 && form.signatureID_Numeric.length === 3) {
						for(var sigKey in tripwire.client.signatures) {
							const existing = tripwire.client.signatures[sigKey];
							if((existing.id != sigDialogVM.sigId) && // not the sig we are editing
								(existing.signatureID == form.signatureID_Alpha.toLowerCase() + form.signatureID_Numeric) && // same name
								(existing.systemID == sigDialogVM.viewingSystemID) // in current system
							) {
								ValidationTooltips.open({target: $("#dialog-signature .signatureID:first")}).setContent("Signature ID already exists! <input type='button' autofocus='true' id='overwrite' value='Overwrite' style='margin-bottom: -4px; margin-top: -4px; font-size: 0.8em;' data-id='"+ sigKey +"' />");
								$("#overwrite").focus();
								valid = false;
								return false;
							}
						}
					}
					if (!valid) return false;

					// Validate wormhole types (blank | wormhole)
					$.each($("#dialog-signature .wormholeType:visible"), function() {
						if (this.value.length > 0 && !aSigWormholes[this.value.toUpperCase()] && this.value != "????") {
							ValidationTooltips.open({target: $(this)}).setContent("Must be a valid wormhole type!");
							$(this).select();
							valid = false;
							return false;
						}
					});
					if (!valid) return false;

					// Validate leads to system (blank | system)
					$.each($("#dialog-signature .leadsTo:visible"), function() {
						if (this.value.length > 0 && appData.genericSystemTypes.findIndex((item) => this.value.toLowerCase() === item.toLowerCase()) == -1 && !findSystemID(this.value)) {
							ValidationTooltips.open({target: $(this)}).setContent("Must be a valid leads to system!");
							$(this).select();
							valid = false;
							return false;
						}
					});
					if (!valid) return false;

					// Validate leads to isn't the viewing system which causes a inner loop
					$.each($("#dialog-signature .leadsTo:visible"), function() {
						if (this.value.length > 0 && this.value.toLowerCase() === sigDialogVM.viewingSystem.name.toLowerCase()) {
							ValidationTooltips.open({target: $(this)}).setContent("Wormhole cannot lead to the same system it comes from!");
							$(this).select();
							valid = false;
							return false;
						}
					});
					if (!valid) return false;

					var payload = {};
					var undo = [];
					if (form.signatureType === "wormhole") {
						var signature = {
							"signatureID": form.signatureID_Alpha + form.signatureID_Numeric,
							"systemID": sigDialogVM.viewingSystemID,
							"type": "wormhole",
							"name": form.wormholeName,
							"lifeLength": form.signatureLength
						};
						var leadsTo = wormholeAnalysis.targetSystemID(form.leadsTo, form.wormholeType);

						var signature2 = {
							"signatureID": form.signatureID2_Alpha + form.signatureID2_Numeric,
							"systemID": leadsTo,
							"type": "wormhole",
							"name": form.wormholeName2,
							"lifeLength": form.signatureLength
						};
						var type = null;
						var parent = null;
						if (form.wormholeType.length > 0 && aSigWormholes[form.wormholeType.toUpperCase()] && form.wormholeType.toUpperCase() != "K162") {
							parent = "initial";
							type = form.wormholeType.toUpperCase();
						} else if (form.wormholeType2.length > 0 && aSigWormholes[form.wormholeType2.toUpperCase()] && form.wormholeType2.toUpperCase() != "K162") {
							parent = "secondary";
							type = form.wormholeType2.toUpperCase();
						} else if (form.wormholeType.toUpperCase() == "K162") {
							parent = "secondary";
							type = "????";
						} else if (form.wormholeType2.toUpperCase() == "K162") {
							parent = "initial";
							type = "????";
						}
						var wormhole = {
							"type": type,
							"parent": parent,
							"life": form.wormholeLife,
							"mass": form.wormholeMass
						};
						if (sigDialogVM.mode == "update") {
							signature.id = $("#dialog-signature").data("signatureid");
							signature2.id = $("#dialog-signature").data("signature2id");
							wormhole.id = $("#dialog-signature").data("wormholeid");

							// Update the initial and type based on which side of the wormhole we are editing
							if (tripwire.client.wormholes[wormhole.id]) {
								if (form.wormholeType.length > 0 && aSigWormholes[form.wormholeType.toUpperCase()] && form.wormholeType.toUpperCase() != "K162") {
									wormhole.parent = tripwire.client.wormholes[wormhole.id].initialID == signature.id ? "initial" : "secondary";
									wormhole.type = form.wormholeType.toUpperCase();
								} else if (form.wormholeType2.length > 0 && aSigWormholes[form.wormholeType2.toUpperCase()] && form.wormholeType2.toUpperCase() != "K162") {
									wormhole.parent = tripwire.client.wormholes[wormhole.id].initialID == signature.id ? "secondary" : "initial";
									wormhole.type = form.wormholeType2.toUpperCase();
								} else if (form.wormholeType.toUpperCase() == "K162") {
									wormhole.parent = tripwire.client.wormholes[wormhole.id].initialID == signature.id ? "secondary" : "initial";
									wormhole.type = "????";
								} else if (form.wormholeType2.toUpperCase() == "K162") {
									wormhole.parent = tripwire.client.wormholes[wormhole.id].initialID == signature.id ? "initial" : "secondary";
									wormhole.type = "????";
								}
							}

							payload = {"signatures": {"update": [{"wormhole": wormhole, "signatures": [signature, signature2]}]}};

							if (tripwire.client.wormholes[wormhole.id]) {
									//used to be a wormhole
									undo.push({"wormhole": tripwire.client.wormholes[wormhole.id], "signatures": [tripwire.client.signatures[signature.id], tripwire.client.signatures[signature2.id]]});
							} else {
									// used to be just a regular signature
									undo.push(tripwire.client.signatures[signature.id]);
							}
						} else {
							payload = {"signatures": {"add": [{"wormhole": wormhole, "signatures": [signature, signature2]}]}};
						}
					} else {
						if (sigDialogVM.mode == "update") {
							var signature = {
								"id": $("#dialog-signature").data("signatureid"),
								"signatureID": form.signatureID_Alpha + form.signatureID_Numeric,
								"systemID": sigDialogVM.viewingSystemID,
								"type": form.signatureType,
								"name": form.signatureName,
								"lifeLength": form.signatureLength
							};
							payload = {"signatures": {"update": [signature]}};

							if (tripwire.client.signatures[signature.id].type == "wormhole") {
								//used to be a wormhole
								var wormhole = $.map(tripwire.client.wormholes, function(wormhole) { if (wormhole.initialID == signature.id || wormhole.secondaryID == signature.id) return wormhole; })[0];
								var signature2 = signature.id == wormhole.initialID ? tripwire.client.signatures[wormhole.secondaryID] : tripwire.client.signatures[wormhole.initialID];
								undo.push({"wormhole": tripwire.client.wormholes[wormhole.id], "signatures": [tripwire.client.signatures[signature.id], tripwire.client.signatures[signature2.id]]});
							} else {
								// used to be just a regular signature
								undo.push(tripwire.client.signatures[signature.id]);
							}
						} else {
							var signature = {
								"signatureID": form.signatureID_Alpha + form.signatureID_Numeric,
								"systemID": sigDialogVM.viewingSystemID,
								"type": form.signatureType,
								"name": form.signatureName,
								"lifeLength": form.signatureLength
							};
							payload = {"signatures": {"add": [signature]}};
						}
					}

					$("#dialog-signature").parent().find(":button:contains('Save')").button("disable");

					var success = function(data) {
						if (data.resultSet && data.resultSet[0].result == true) {
							$("#dialog-signature").dialog("close");

							$("#undo").removeClass("disabled");

							if (sigDialogVM.mode == "add") {
								undo = data.results;
							}
							if (sigDialogVM.viewingSystemID in tripwire.signatures.undo) {
								tripwire.signatures.undo[sigDialogVM.viewingSystemID].push({action: sigDialogVM.mode, signatures: undo});
							} else {
								tripwire.signatures.undo[sigDialogVM.viewingSystemID] = [{action: sigDialogVM.mode, signatures: undo}];
							}

							sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo));
						}
					}

					var always = function() {
						$("#sigEditForm input[type=submit]").removeAttr("disabled");
						$("#dialog-signature").parent().find(":button:contains('Save')").button("enable");
					}

					tripwire.refresh('refresh', payload, success, always);
				});
			},
			open: function() {
				$("#dialog-signature").data("signatureid", "");
				$("#dialog-signature").data("signature2id", "");
				$("#dialog-signature").data("wormholeid", "");

				$("#dialog-signature input[type!='radio']").val("");
				$("#dialog-signature [name='signatureType']").val("unknown").selectmenu("refresh");

				$("#dialog-signature [name='wormholeLife'][value='stable']").prop("checked", true);
				$("#dialog-signature [name='wormholeMass'][value='stable']").prop("checked", true);
				
				$("#dialog-signature #site").show();
				$("#dialog-signature #wormhole").hide();

				// Side labels
				$("#dialog-signature .sideLabel:first").text(sigDialogVM.viewingSystem.name + " Side");
				$("#dialog-signature .sideLabel:last").text("Other Side");

				// Default signature life
				$("#dialog-signature #durationPicker").val(options.signatures.pasteLife * 60 * 60).change();

				var id = sigDialogVM.sigId;
				if (sigDialogVM.mode == "update" && id && tripwire.client.signatures[id]) {
					var signature = tripwire.client.signatures[id];
					$("#dialog-signature").data("signatureid", id);

					// Change the dialog buttons
					$("#dialog-signature").parent().find("button:contains('Add')").hide();
					$("#dialog-signature").parent().find("button:contains('Save')").show();
					$("#dialog-signature").parent().find("button:contains('Delete')").show();

					// Change the dialog title
					$("#dialog-signature").dialog("option", "title", "Edit Signature");

					if (signature.type == "wormhole") {
						var wormhole = $.map(tripwire.client.wormholes, function(wormhole) { if (wormhole.initialID == id || wormhole.secondaryID == id) return wormhole; })[0];
						var otherSignature = id == wormhole.initialID ? tripwire.client.signatures[wormhole.secondaryID] : tripwire.client.signatures[wormhole.initialID];
						$("#dialog-signature").data("signature2id", otherSignature.id);
						$("#dialog-signature").data("wormholeid", wormhole.id);
						
						const sigAlpha = signature.signatureID ? signature.signatureID.substr(0, 3) : "???";
						$("#dialog-signature input[name='signatureID_Alpha']").val(sigAlpha);
						$("#dialog-signature input[name='signatureID_Numeric']").val(signature.signatureID ? signature.signatureID.substr(3, 5) : "");
						$("#dialog-signature [name='signatureType']").val(signature.type).selectmenu("refresh").trigger("selectmenuchange");
						$("#dialog-signature [name='wormholeName']").val(signature.name);
						$("#dialog-signature [name='leadsTo']").val(tripwire.systems[otherSignature.systemID] ? tripwire.systems[otherSignature.systemID].name : (appData.genericSystemTypes[otherSignature.systemID] ? appData.genericSystemTypes[otherSignature.systemID] : ""));

						$("#dialog-signature input[name='signatureID2_Alpha']").val(otherSignature.signatureID ? otherSignature.signatureID.substr(0, 3) : "???");
						$("#dialog-signature input[name='signatureID2_Numeric']").val(otherSignature.signatureID ? otherSignature.signatureID.substr(3, 5) : "");
						$("#dialog-signature [name='wormholeName2']").val(otherSignature.name);
						$("#dialog-signature [name='wormholeLife'][value='"+wormhole.life+"']").prop("checked", true);
						$("#dialog-signature [name='wormholeMass'][value='"+wormhole.mass+"']").prop("checked", true);
						if (wormhole[wormhole.parent+"ID"] == signature.id) {
							$("#dialog-signature input[name='wormholeType']").val(wormhole.type).change();
						} else if (wormhole[wormhole.parent+"ID"] == otherSignature.id) {
							$("#dialog-signature input[name='wormholeType2']").val(wormhole.type).change();
						}
						$("#dialog-signature #durationPicker").val(signature.lifeLength).change();
						
						// Focus the sig ID, if it isn't set, otherwise the sig name
						if(sigAlpha != '???') { $("#dialog-signature input[name='wormholeName']").select(); }
						else { $("#dialog-signature input[name='signatureID_Alpha']").select(); }
						
						// Trigger the VM/display updates based on system
						$("#dialog-signature [name='leadsTo']").change();
					} else {
						$("#dialog-signature input[name='signatureID_Alpha']").val(signature.signatureID ? signature.signatureID.substr(0, 3) : "???");
						$("#dialog-signature input[name='signatureID_Numeric']").val(signature.signatureID ? signature.signatureID.substr(3, 5) : "");
						$("#dialog-signature [name='signatureType']").val(signature.type).selectmenu("refresh").trigger("selectmenuchange");
						$("#dialog-signature [name='signatureName']").val(signature.name);
						$("#dialog-signature #durationPicker").val(signature.lifeLength).change();
						
						// Not a wormhole - always focus the sig ID
						$("#dialog-signature input[name='signatureID_Alpha']").select();
					}

					// Hightlight first ID section, if not set, otherwise the name
				} else {
					// Change the dialog buttons
					$("#dialog-signature").parent().find("button:contains('Add')").show();
					$("#dialog-signature").parent().find("button:contains('Delete')").hide();
					$("#dialog-signature").parent().find("button:contains('Save')").hide();

					// Change the dialog title
					$("#dialog-signature").dialog("option", "title", "Add Signature");

					$("#dialog-signature [name='signatureType']").val(options.signatures.editType || "unknown").selectmenu("refresh")
					if ($("#dialog-signature [name='signatureType']").val() === "wormhole") {
						$("#dialog-signature #site").hide();
						$("#dialog-signature #wormhole").show();
					}
				}
			},
			close: function() {
				ValidationTooltips.close();
				$("#sigTable tr.selected").removeClass("selected");
				$("#dialog-signature").data("signatureid", "");
				$("#dialog-signature").data("signature2id", "");
				$("#dialog-signature").data("wormholeid", "");
			}
		});
	} else if (!$("#dialog-signature").dialog("isOpen")) {
		$("#dialog-signature").dialog("open");
	}
};

$("#sigTable tbody").on("dblclick", "tr", {mode: "update", source:"sig-row"}, sigDialog.openSignatureDialog);
$("#edit-signature").on("click", {mode: "update", source:"edit-sig"}, sigDialog.openSignatureDialog);
$("#add-signature").click({mode: "add"}, sigDialog.openSignatureDialog);

// Signature overwrite. Attached to document because the element gets recreated each time
sigDialog.overwriteSignature = function(sigToRemove, completeFunction, always) {
	var payload = {"signatures": {"remove": []}, "systemID": viewingSystemID};
	var undo = [];

	var signature = tripwire.client.signatures[sigToRemove];
	if (signature.type != "wormhole") {
		undo.push(signature);
		payload.signatures.remove.push(signature.id);
	} else {
		var wormhole = $.map(tripwire.client.wormholes, function(wormhole) { if (wormhole.initialID == signature.id || wormhole.secondaryID == signature.id) return wormhole; })[0];
		undo.push({"wormhole": wormhole, "signatures": [tripwire.client.signatures[wormhole.initialID], tripwire.client.signatures[wormhole.secondaryID]]});
		payload.signatures.remove.push(wormhole);
	}

	var success = function(data) {
		$("#undo").removeClass("disabled");
		if (viewingSystemID in tripwire.signatures.undo) {
			tripwire.signatures.undo[viewingSystemID].push({action: "remove", signatures: undo});
		} else {
			tripwire.signatures.undo[viewingSystemID] = [{action: "remove", signatures: undo}];
		}

		sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo));
		
		completeFunction(data);
	}

	tripwire.refresh('refresh', payload, success, always);
}

/** Delegate the next action after sig overwrite to the save dialog */
sigDialog.delegateSave = function(data) {
	if (data.resultSet && data.resultSet[0].result == true) {
		ValidationTooltips.close();

		if ($("#dialog-signature").parent().find(":button:contains('Save')")) {
			$("#dialog-signature").parent().find(":button:contains('Save')").click();
		} else {
			$("#dialog-signature").parent().find(":button:contains('Add')").click();
		}
	}
}

$(document).on("click", "#overwrite", function() { 
	$("#overwrite").attr("disable", true);
	sigDialog.overwriteSignature($(this).data("id"), sigDialog.delegateSave, function() {
		$("#overwrite").removeAttr("disable");
	}); 
});
