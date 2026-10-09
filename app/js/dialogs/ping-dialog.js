const sendPing = function(dialog, pingType) {
					const text = $('#ping-text').val();
					if(text.trim() === '' && !confirm('You are sending a ping with no text. Are you sure you want to do that?\n\nIf not, press Cancel and enter some text and try again.')) { return; }					const _this = dialog;
					var payload = {systemName: _this.systemName, systemText: _this.systemText, message: $('#ping-text').val(), pingType: pingType };
					$.ajax({
						url: "ping.php",
						type: "POST",
						data: payload,
						dataType: "text"
					}).done(function(data) {	$(_this).dialog("close"); })
					.fail(function(xhr, status, error) { console.log(status, error); });	
}

		$("#dialog-ping").dialog({
			autoOpen: false,
			height: "auto",
			width: 350,
			dialogClass: "dialog-noeffect ui-dialog-shadow",
			buttons: {
				Send: function() { sendPing(this); },
				'@here': function() { sendPing(this, 'here'); },
				'@everyone': function() { sendPing(this, 'everyone'); },
				Cancel: function() {
					$(this).dialog("close");
				},
			},
			open: function() {
				const wormholeID = $(this).data("id");
				const systemID = $(this).data("systemID");
				const wormhole = tripwire.client.wormholes[wormholeID];
				const fromSignature = wormhole ? tripwire.client.signatures[wormhole.initialID] : { name: null};
				
				this.systemName = tripwire.systems[systemID].name;
				this.systemText = this.systemName + (fromSignature.name !== null && fromSignature.name.length ? ' (' + fromSignature.name + ')' : '');
				
				$("#dialog-ping").dialog("option", "title", "Ping about "+this.systemText);
				$('#ping-text').val('');
				$('#ping-text').focus();
			}
		});