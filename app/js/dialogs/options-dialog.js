$(".options").click(function(e) {
	e.preventDefault();

	if ($(this).hasClass("disabled"))
		return false;

	$("#dialog-options").dialog({
		autoOpen: false,
		width: 450,
		minHeight: 400,
		modal: true,
		buttons: {
			Save: function() {
				// Options
				var data = {mode: "set", options: JSON.stringify(options)};

				$("#dialog-options").parent().find(".ui-dialog-buttonpane button:contains('Save')").attr("disabled", true).addClass("ui-state-disabled");
				
				options.chain.sigNameLocation = $("#dialog-options #chainSigNameLocation").val();
				options.chain.routingLimit = 1 * $("#dialog-options #chainRoutingLimit").val();
				options.chain.routeSecurity = $("#dialog-options #chainRouteSecurity").val();
				options.chain.routeIgnore.enabled = $("#dialog-options #route-ignore-enabled").prop('checked');
				options.chain.routeIgnore.systems = $("#dialog-options #route-ignore").val().split(",").map(x => x.trim());

				options.chain.gridlines = 'true' == $("#dialog-options input[name=gridlines]:checked").val();
				options.chain.aura = 'true' == $("#dialog-options input[name=aura]:checked").val();
				options.chain.scrollWithoutCtrl = 'true' == $("#dialog-options input[name=scrollWithoutCtrl]:checked").val();

				options.chain.nodeSpacing.x = $("#dialog-options #node-spacing-x-slider").slider("value");
				options.chain.nodeSpacing.y = $("#dialog-options #node-spacing-y-slider").slider("value");
				
				options.chain.lineWeight = $("#dialog-options #node-spacing-line-weight-slider").slider("value");
				
				options.chain["node-reference"] = $("#dialog-options input[name=node-reference]:checked").val();
				
				options.chain.renderer = $("#dialog-options #renderer").val();

				options.signatures.editType = $("#dialog-options #editType").val();

				options.signatures.pasteLife = $("#dialog-options #pasteLife").val();

				options.signatures.copySeparator = $("#dialog-options #copySeparator").val();

				options.background = $("#dialog-options #background-image").val();

				options.uiscale = $("#dialog-options #uiscale-slider").slider("value");

				options.apply();
				options.save(); // Performs AJAX

				$("#dialog-options").dialog("close");
				$("#dialog-options").parent().find(".ui-dialog-buttonpane button:contains('Save')").attr("disabled", false).removeClass("ui-state-disabled");

			},
			Reset: function() {
				$("#dialog-confirm #msg").html("Settings will be reset to defaults temporarily.<br/><br/><p><em>Save settings to make changes permanent.</em></p>");
				$("#dialog-confirm").dialog("option", {
					buttons: {
						Reset: function() {
							options.reset();
							options.apply();

							$("#dialog-options").dialog("close");
							$(this).dialog("close");
						},
						Cancel: function() {
							$(this).dialog("close");
						}
					}
				}).dialog("open");
			},
			Close: function() {
				$(this).dialog("close");
			}
		},
		open: function() {
			// Get user stats data
			$.ajax({
				url: "user_stats.php",
				type: "POST",
				dataType: "JSON"
			}).done(function(data) {
				for (i in data.stats) {
					for (x in data.stats[i]) {
						$("#optionsAccordion #"+ x).text(data.stats[i][x]);
					}
				}

				$("#optionsAccordion #systems_visited").text(data.system_visits);
				$("#optionsAccordion #logins").text(data.account.logins);
				$("#optionsAccordion #lastLogin").text(data.account.lastLogin);
				$("#optionsAccordion #username").text(data.username);
			});

			$("#dialog-options #editType").val(options.signatures.editType);
			$("#dialog-options #pasteLife").val(options.signatures.pasteLife);
			$("#dialog-options #copySeparator").val(options.signatures.copySeparator);
			$("#dialog-options #chainRoutingLimit").val(options.chain.routingLimit);
			$("#dialog-options #chainSigNameLocation").val(options.chain.sigNameLocation);
			$("#dialog-options #chainRouteSecurity").val(options.chain.routeSecurity);
			$("#dialog-options #route-ignore-enabled").prop('checked', options.chain.routeIgnore.enabled);
			$("#dialog-options #route-ignore").val(options.chain.routeIgnore.systems.join(','));
			$("#dialog-options #renderer").val(options.chain.renderer);
			$("#dialog-options input[name='node-reference'][value='"+options.chain["node-reference"]+"']").prop("checked", true);
			$("#dialog-options input[name='gridlines'][value='"+options.chain.gridlines+"']").prop("checked", true);
			$("#dialog-options input[name='aura'][value='"+options.chain.aura+"']").prop("checked", true);
			$("#dialog-options input[name='scrollWithoutCtrl'][value='"+options.chain.scrollWithoutCtrl+"']").prop("checked", true);
			$("#dialog-options #node-spacing-x-slider").slider("value", options.chain.nodeSpacing.x);
			$("#dialog-options #node-spacing-y-slider").slider("value", options.chain.nodeSpacing.y);
			$("#dialog-options #node-spacing-line-weight-slider").slider("value", options.chain.lineWeight);
			$("#dialog-options #background-image").val(options.background);
		},
		create: function() {
			$("#optionsAccordion").accordion({heightStyle: "content", collapsible: true, active: false});
			function setUpSlider(id, value, change, range) {
				range = Object.assign({min: 0.7, max:1.4, step:0.05}, range);
				$("#" + id).slider({
					min: range.min,
					max: range.max,
					step: range.step,
					value: value || 1.0,
					change: change,
					slide: function(e, ui) {
						$("label[for='" + id + "']").text(ui.value);
					}
				});

				$("label[for='" + id + "']").text($("#" + id).slider("value"));
			}
			setUpSlider('uiscale-slider', options.uiscale, function(e, ui) {
						$("body").css("zoom", ui.value);
					});
			setUpSlider('node-spacing-x-slider', options.chain.nodeSpacing.x);
			setUpSlider('node-spacing-y-slider', options.chain.nodeSpacing.y);
			setUpSlider('node-spacing-line-weight-slider', options.chain.lineWeight, undefined, { min: 0.5, max: 1.5 });

			$("#dialog-pwChange").dialog({
				autoOpen: false,
				resizable: false,
				minHeight: 0,
				dialogClass: "ui-dialog-shadow dialog-noeffect dialog-modal",
				buttons: {
					Save: function() {
						$("#pwForm").submit();
					},
					Cancel: function() {
						$(this).dialog("close");
					}
				},
				close: function() {
					$("#pwForm input[name='password'], #pwForm input[name='confirm']").val("");
					$("#pwError").text("").hide();
				}
			});

			$("#pwChange").click(function() {
				$("#dialog-pwChange").dialog("open");
			});

			$("#pwForm").submit(function(e) {
				e.preventDefault();

				$("#pwError").text("").hide();

				$.ajax({
					url: "options.php",
					type: "POST",
					data: $(this).serialize(),
					dataType: "JSON"
				}).done(function(response) {
					if (response && response.result) {
						$("#dialog-msg #msg").text("Password changed");
						$("#dialog-msg").dialog("open");

						$("#dialog-pwChange").dialog("close");
					} else if (response && response.error) {
						$("#pwError").text(response.error).show("slide", {direction: "up"});
					} else {
						$("#pwError").text("Unknown error").show("slide", {direction: "up"});
					}
				});
			});

			$("#dialog-usernameChange").dialog({
				autoOpen: false,
				resizable: false,
				minHeight: 0,
				dialogClass: "ui-dialog-shadow dialog-noeffect dialog-modal",
				buttons: {
					Save: function() {
						$("#usernameForm").submit();
					},
					Cancel: function() {
						$(this).dialog("close");
					}
				},
				open: function() {
					$("#usernameForm #username").html($("#dialog-options #username").html());
				},
				close: function() {
					$("#usernameForm [name='username']").val("");
					$("#usernameError").text("").hide();
				}
			});

			$("#usernameChange").click(function() {
				$("#dialog-usernameChange").dialog("open");
			});

			$("#usernameForm").submit(function(e) {
				e.preventDefault();

				$("#usernameError").text("").hide();

				$.ajax({
					url: "options.php",
					type: "POST",
					data: $(this).serialize(),
					dataType: "JSON"
				}).done(function(response) {
					if (response && response.result) {
						$("#dialog-msg #msg").text("Username changed");
						$("#dialog-msg").dialog("open");

						$("#dialog-options #username").text(response.result);

						$("#dialog-usernameChange").dialog("close");
					} else if (response && response.error) {
						$("#usernameError").text(response.error).show("slide", {direction: "up"});
					} else {
						$("#usernameError").text("Unknown error").show("slide", {direction: "up"});
					}
				});
			});


		}
	});

	$("#dialog-options").dialog("open");
});
