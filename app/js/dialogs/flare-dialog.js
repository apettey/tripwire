function sendFlare(systemID, flare, lifeLength, reason, dialog) {
			const flareData = {"systemID": systemID, "flare": flare === 'none' ? undefined : flare, "lifeLength": lifeLength === 'none' ? undefined : lifeLength, "reason": reason};

			$.ajax({
				url: "flares.php",
				type: "POST",
				data: flareData,
				dataType: "JSON"
			}).done(function(data) {
				if (data && data.result) {
					chain.updateFlare(systemID, flareData);
					$(dialog).dialog("close");
				}
			});
}

function updateFlareDialogDisplayNode(dialog) {
	const node = dialog.querySelector('#flare-node .node');
	$(node).removeClass("redNode yellowNode greenNode");
	const flareType = dialog.querySelector("input[name='flare-type']:checked").value;
	if(flareType !== 'none') { $(node).addClass(flareType + 'Node'); }
}

		$("#dialog-flare").dialog({
			autoOpen: false,
			height: "auto",
			width: 350,
			dialogClass: "dialog-noeffect ui-dialog-shadow",
			buttons: {
				'Update': function() { 
					sendFlare($(this).data("systemID"), 
						this.querySelector("input[name='flare-type']:checked").value, 
						this.querySelector("input[name='flare-expiry']:checked").value, 
						this.querySelector('#flare-text').value,
						this);  
				},
				'Remove': function() { sendFlare($(this).data("systemID"), null, null, null, this); },
				Cancel: function() {
					$(this).dialog("close");
				},
			},
			create: function() {
				$(this).find("input[name='flare-type']").on('click', e => updateFlareDialogDisplayNode(this));
			},
			open: function() {
				const systemID = $(this).data("systemID");
				const copyNode = $(this).data('copyNode');
				this.systemName = tripwire.systems[systemID].name;
				const flare = chain.data.flares[systemID] || { lifeLength: 86400 };
				
				const typeRadio = this.querySelector("input[name='flare-type'][value='" + (flare.flare || 'none') + "']");
				typeRadio.checked = true;
				typeRadio.focus();
				this.querySelector("input[name='flare-expiry'][value='" + (flare.lifeLength || 'none') + "']").checked = true;
				this.querySelector('#flare-text').value = flare.reason || '';
				
				// drop the clone node in
				const nodeWrapper = this.querySelector('#flare-node');
				nodeWrapper.innerHTML = '';
				nodeWrapper.appendChild(copyNode);
				
				updateFlareDialogDisplayNode(this);
				$(this).dialog("option", "title", "Set flare on " + this.systemName);
			}
		});