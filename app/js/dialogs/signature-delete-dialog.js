$("#signaturesWidget").on("click", "#delete-signature", function(e) {
	e.preventDefault();

	if ($(this).closest("tr").attr("disabled")) {
		return false;
	} else if ($("#sigTable tr.selected").length == 0) {
		return false;
	} else if ($("#dialog-sigEdit").hasClass("ui-dialog-content") && $("#dialog-sigEdit").dialog("isOpen")) {
		$("#dialog-sigEdit").parent().effect("shake", 300);
		return false;
	}
		
	openDeleteDialog({
		signatures: $.map($("#sigTable tr.selected"), function(n) {
			return tripwire.client.signatures[$(n).data("id")];
		})
	});
});

function openDeleteDialog(vm, successFunction) {
	openDeleteDialog.deleteDialogVM = vm;	// outside so it's not saved in the closure first time we open the dialog

	// check if dialog is open
	if (!$("#dialog-deleteSig").hasClass("ui-dialog-content")) {
		$("#dialog-deleteSig").dialog({
			resizable: false,
			minHeight: 0,
			dialogClass: "dialog-noeffect ui-dialog-shadow",
			buttons: {
				Delete: function() {
					// Prevent duplicate submitting
					$("#dialog-deleteSig").parent().find(":button:contains('Delete')").button("enable");
					var payload = {"signatures": {"remove": []}, "systemID": viewingSystemID};
					var undo = [];

					var signaturePayload = $.map(openDeleteDialog.deleteDialogVM.signatures, function(signature) {
						if (signature.type != "wormhole") {
							undo.push(signature);
							return signature.id;
						} else {
							var wormhole = $.map(tripwire.client.wormholes, function(wormhole) { if (wormhole.initialID == signature.id || wormhole.secondaryID == signature.id) return wormhole; })[0];
							undo.push({"wormhole": wormhole, "signatures": [tripwire.client.signatures[wormhole.initialID], tripwire.client.signatures[wormhole.secondaryID]]});
							return wormhole;
						}
					});
					payload.signatures.remove = signaturePayload;

					var success = function(data) {
						if (data.resultSet && data.resultSet[0].result == true) {
							$("#dialog-deleteSig").dialog("close");
							if(successFunction) { successFunction(); }

							$("#undo").removeClass("disabled");
							if (viewingSystemID in tripwire.signatures.undo) {
								tripwire.signatures.undo[viewingSystemID].push({action: "remove", signatures: undo});
							} else {
								tripwire.signatures.undo[viewingSystemID] = [{action: "remove", signatures: undo}];
							}

							sessionStorage.setItem("tripwire_undo", JSON.stringify(tripwire.signatures.undo));
						}
					}

					var always = function(data) {
						$("#dialog-deleteSig").parent().find(":button:contains('Delete')").button("enable");
					}

					tripwire.refresh('refresh', payload, success, always);
				},
				Cancel: function() {
					$(this).dialog("close");
				}
			},
			open: function() {
				const sigs = openDeleteDialog.deleteDialogVM.signatures;
				$("#dialog-deleteSig").dialog("option", "title", sigs.length == 1 ? 'Delete Signature ' + formatSignatureID(sigs[0].signatureID) : 'Delete Multiple Signatures');
				document.getElementById('deleteSigText').innerText = sigs.length == 1 ? 'The ' + sigs[0].type + ' signature ' + formatSignatureID(sigs[0].signatureID) 
					: 'The signatures ' + sigs.map(s => formatSignatureID(s.signatureID)).join(', ');
				document.getElementById('deleteSigSystem').innerHTML = systemRendering.renderSystem(systemAnalysis.analyse(sigs[0].systemID));
				
				$("#dialog-deleteSig").parent().find(".ui-dialog-buttonset button:eq(0)").focus();
			},
			close: function() {
				$("#sigTable tr.selected").removeClass("selected");
				//$("#sigTable .sigDelete").removeClass("invisible");
			}
		});		
	} else if (!$("#dialog-deleteSig").dialog("isOpen")) {
		$("#dialog-deleteSig").dialog("open");
	}
}
