const maskFunctions = {
		getMasks: function() {
			// Get masks
			$.ajax({
				url: "masks.php",
				type: "POST",
				dataType: "JSON"
			}).done(function(response) {
				if (response && response.masks) {
					tripwire.masks = response.masks;
					maskRendering.update(tripwire.masks);
					$("#dialog-masks #masks #default").text("");
					$("#dialog-masks #masks #owned").text("");
					$("#dialog-masks #masks #invited").text("");
					
					const iconBar = mask => 
						'<span class="icon_bar">' +
						(mask.optional ? '<a href="#" class="icon ' + (mask.joined ? 'closeIcon' : 'joinIcon') + '" data-tooltip="' + (mask.joined ? 'Remove from quick switch' : 'Add to quick switch') + '">' +
							(mask.joined ? '×' : '+') + '</a>' : '')
						+ '</span>';


					for (var x in response.masks) {
						var mask = response.masks[x];
						var node = $(''
							+ '<input type="radio" name="mask" id="mask'+x+'" value="'+mask.mask+'" class="selector" data-owner="'+mask.owner+'" data-admin="'+mask.admin+'" />'
							+ '<label for="mask'+x+'"><img src="'+mask.img+'" />'
							+ iconBar(mask)
							+ '<span class="source_bar ' + mask.joinedBy+'">&nbsp;</span>'
							+ '<span class="selector_label">'+maskRendering.renderMask(mask)
								+ ((mask.joined || mask.owner) ? ' <i data-icon="star" data-tooltip="On quick switch"></i>' : '')
							+ '</span></label>');

						$("#dialog-masks #masks #"+mask.type).append(node);
					}

					var node = $(''
						+ '<input type="checkbox" name="create" id="create-mask" class="selector" />'
						+ '<label for="create-mask"><i data-icon="plus" style="font-size: 3em; margin-left: 16px; margin-top: 16px; display: block;"></i>'
						+ '<span class="source_bar personal">&nbsp;</span>'
						+ '<span class="selector_label">Create</span></label>');
					
					node.click(function(e) {
						e.preventDefault();
						$("#dialog-createMask").dialog("open");
					});
					$("#dialog-masks #masks #owned").append(node);
					
					const activeMask = response.masks.find(x => x.active);
					$("#dialog-masks input[name='mask']").filter("[value='"+activeMask.mask+"']").attr("checked", true).trigger("change");

					// toggle mask admin icon
					document.getElementById('admin').style.display = activeMask.admin ? '' : 'none';
					
					// fix tooltips for new elements
					Tooltips.attach($("#dialog-masks").find("[data-tooltip]"));
				}
			});
		}, 
		updateActiveMask: function(newActive, afterFunction) {
				var maskChange = false;
				if (options.masks.active != newActive) {
					maskChange = true;
					options.masks.active = newActive;
					maskRendering.update(tripwire.masks, newActive);
				}

				options.save() // Performs AJAX
					.done(function() {
						if (maskChange) {
							// Reset signatures
							$("#sigTable span[data-age]").countdown("destroy");
							$("#sigTable tbody").empty()
							$("#signature-count").text(0);
							tripwire.signatures.list = {};
							tripwire.client.signatures = [];

							tripwire.refresh('change');
						}
						if(afterFunction) { afterFunction(); }
					});		
		},
};

$("#dialog-masks").dialog({
	autoOpen: false,
	width: 450,
	minHeight: 400,
	modal: true,
	buttons: {
		Save: function() {
			maskFunctions.updateActiveMask($("#dialog-masks input[name='mask']:checked").val(), () => {
				// toggle mask admin icon
				document.getElementById('admin').disabled = !$("#dialog-masks input[name='mask']:checked").data("admin");			
				$(this).dialog("close");
			});
		},
		Close: function() {
			$(this).dialog("close");
		}		
	}, 

		open: function() { maskFunctions.getMasks(); }
	
});

$("#mask-menu-link").click(function(e) {
	e.preventDefault();
	const elem = document.getElementById('mask-menu');
	elem.style.display = elem.style.display == 'none' ? '' : 'none';
});

$("#mask-link").click(function(e) {
	e.preventDefault();

	if ($(this).hasClass("disabled"))
		return false;
	
	$("#dialog-masks").dialog('open');
 });
 
// Mask selections
$("#masks").on("change", "input.selector:checked", function() {
	if ($(this).data("owner")) {
		$("#maskControls #edit").removeAttr("disabled");
		$("#maskControls #delete").removeAttr("disabled");
	} else {
		$("#maskControls #edit").attr("disabled", "disabled");
		$("#maskControls #delete").attr("disabled", "disabled");
	}

	if ($(this).val() != 0.0 && $(this).val().split(".")[1] == 0) {
		$("#dialog-masks #leave").removeAttr("disabled");
	} else {
		$("#dialog-masks #leave").attr("disabled", "disabled");
	}
});

const joinMask = maskID => {
	const completeFunction = () => {
						$.ajax({
							url: "masks.php",
							type: "POST",
							data: {mask: maskID, mode: "join"},
							dataType: "JSON"
						}).done(function(response) {
							if (response && response.result) {
								maskFunctions.getMasks();
								$("#dialog-joinMask").dialog("close");
							}
						});	
	};
	
	const mask = tripwire.masks.find(m => m.mask === maskID);
	if(!mask) { throw 'unknown mask ' + maskID; }
	
	if(mask.joinedBy === 'corporate') {
				$("#dialog-confirm #msg").text("This will add the mask '" + mask.label + " to the quick switch list for your whole corporation. Is that what you want?");
				$("#dialog-confirm").dialog("option", {
					buttons: {
						Confirm: function() {
							completeFunction();
							$(this).dialog("close");
						},
						Cancel: function() {
							$(this).dialog("close");
						}
					}
				}).dialog("open");		
	} else { completeFunction(); }
};

			// Mask join
			$("#dialog-masks #masks").on("click", ".joinIcon", function() {
				var maskElem = $(this).closest("input.selector+label").prev();
				joinMask(maskElem.val());
			});

			// Mask leave
			$("#dialog-masks #masks").on("click", ".closeIcon", function() {
				var maskElem = $(this).closest("input.selector+label").prev();
				const mask = tripwire.masks.find(m => m.mask === maskElem.val());
				if(!mask) { throw 'unexpected mask ' + maskElem.val(); }
				
				const completeFunction = () => {
							var send = {mode: "leave", mask: maskElem.val()};
							$.ajax({
								url: "masks.php",
								type: "POST",
								data: send,
								dataType: "JSON"
							}).done(function(response) {
								if (response && response.result) {
									maskFunctions.getMasks();

									$("#dialog-confirm").dialog("close");
								} else {
									$("#dialog-confirm").dialog("close");

									$("#dialog-error #msg").text("Unable to delete");
									$("#dialog-error").dialog("open");
								}
							});			
				};
				if(mask.joinedBy === 'corporate') {
					$("#dialog-confirm #msg").text("This will remove the mask '" + mask.label + " from the quick switch list for your whole corporation. Is that what you want?");
					$("#dialog-confirm").dialog("option", {
						buttons: {
							Confirm: function() {
								completeFunction();
								$(this).dialog("close");
							},
							Cancel: function() {
								$(this).dialog("close");
							}
						}
					}).dialog("open");							
				} else { completeFunction(); }
				
			});

			// Mask delete
			$("#maskControls #delete").click(function() {
				var mask = $("#masks input.selector:checked");
				$("#dialog-confirm #msg").text("Are you sure you want to delete this mask?");
				$("#dialog-confirm").dialog("option", {
					buttons: {
						Delete: function() {
							var send = {mode: "delete", mask: mask.val()};

							$.ajax({
								url: "masks.php",
								type: "POST",
								data: send,
								dataType: "JSON"
							}).done(function(response) {
								if (response && response.result) {
									maskFunctions.getMasks();
									$("#dialog-confirm").dialog("close");
								} else {
									$("#dialog-confirm").dialog("close");

									$("#dialog-error #msg").text("Unable to delete");
									$("#dialog-error").dialog("open");
								}
							});
						},
						Cancel: function() {
							$(this).dialog("close");
						}
					}
				}).dialog("open");
			});

			// User Create mask
			$("#dialog-createMask").dialog({
				autoOpen: false,
				dialogClass: "ui-dialog-shadow dialog-noeffect dialog-modal",
				buttons: {
					Create: function() {
						$("#dialog-createMask form").submit();
					},
					Cancel: function() {
						$(this).dialog("close");
					}
				},
				create: function() {
					$("#dialog-createMask #accessList").on("click", "#create_add+label", function() {
						$("#dialog-EVEsearch").dialog("open");
					});

					$("#dialog-createMask form").submit(function(e) {
						e.preventDefault();

						$.ajax({
							url: "masks.php",
							type: "POST",
							data: $(this).serialize(),
							dataType: "JSON"
						}).done(function(response) {
							if (response && response.result) {
								maskFunctions.getMasks();

								$("#dialog-createMask").dialog("close");
							} else if (response && response.error) {
								$("#dialog-error #msg").text(response.error);
								$("#dialog-error").dialog("open");
							} else {
								$("#dialog-error #msg").text("Unknown error");
								$("#dialog-error").dialog("open");
							}
						});
					});

					$("#dialog-createMask select").selectmenu({width: 100});
				},
				open: function() {
					$("#dialog-createMask input[name='name']").val("");
					$("#dialog-createMask #accessList :not(.static)").remove();
				}
			});

			$("#dialog-createMask #accessList").on("click", ".maskRemove", function() {
				$(this).closest("input.selector+label").prev().remove();
				$(this).closest("label").remove();
			});
			
			function makeAccessListNode(item, prefix, name) {
				const extraAttributes = prefix == 'edit' ? 'checked="checked" onclick="return false"' : '';
				const buttons = prefix == 'edit' ? '<input type="button" class="maskRemove" value="Remove" style="position: absolute; bottom: 3px; right: 3px;" />' : '';
				if (item.category == "character") {
					return $(''
						+ '<div class="maskNode"><input type="checkbox" ' + extraAttributes + ' name="' + name + '" id="' + prefix + '_'+item.id+'_1373" value="'+item.id+'_1373" class="selector" />'
						+ '<label for="' + prefix + '_'+item.id+'_1373">'
						+ '	<img src="https://image.eveonline.com/Character/'+item.id+'_64.jpg" />'
						+ '	<span class="selector_label">Character</span>'
						+ '	<div class="info">'
						+ '		'+item.name + '<br/>'
						+ '		'+item.corporation.name+'<br/>'
						+ '		'+(item.alliance ? item.alliance.name : '')+'<br/>'
						+ buttons
						+ '	</div>'
						+ '</label></div>');

				} else if (item.category == "corporation") {
					return $(''
						+ '<div class="maskNode"><input type="checkbox" ' + extraAttributes + ' name="' + name + '" id="' + prefix + '_'+item.id+'_2" value="'+item.id+'_2" class="selector" />'
						+ '<label for="' + prefix + '_'+item.id+'_2">'
						+ '	<img src="https://image.eveonline.com/Corporation/'+item.id+'_64.png" />'
						+ '	<span class="selector_label">Corporation</span>'
						+ '	<div class="info">'
						+ '		'+item.name+'<br/>'
						+ '		'+(item.alliance ? item.alliance.name : '')+'<br/>'
						+ buttons
						+ '	</div>'
						+ '</label></div>');

				} else if (item.category == "alliance") {
					return $(''
						+ '<div class="maskNode"><input type="checkbox" ' + extraAttributes + ' name="' + name + '" id="' + prefix + '_'+item.id+'_3" value="'+item.id+'_3" class="selector" />'
						+ '<label for="' + prefix + '_'+item.id+'_3">'
						+ '	<img src="https://image.eveonline.com/Alliance/'+item.id+'_64.png" />'
						+ '	<span class="selector_label">Alliance</span>'
						+ '	<div class="info">'
						+ '		'+item.name+'<br/>'
						+ buttons
						+ '	</div>'
						+ '</label></div>');
				}				
			}

			$("#dialog-editMask").dialog({
				autoOpen: false,
				dialogClass: "ui-dialog-shadow dialog-noeffect dialog-modal",
				buttons: {
					Save: function() {
						$("#dialog-editMask form").submit();
					},
					Cancel: function() {
						$(this).dialog("close");
					}
				},
				create: function() {
					$("#dialog-editMask #accessList").on("click", ".maskRemove", function() {
						$(this).closest("input.selector+label").prev().attr("name", "deletes[]").hide();
						$(this).closest("label").hide();
					});

					$("#dialog-editMask #accessList").on("click", "#edit_add+label", function() {
						$("#dialog-EVEsearch").dialog("open");
					});

					$("#dialog-editMask form").submit(function(e) {
						e.preventDefault();

						$.ajax({
							url: "masks.php",
							type: "POST",
							data: $(this).serialize(),
							dataType: "JSON"
						}).done(function(response) {
							if (response && response.result) {
								$("#dialog-editMask").dialog("close");
							} else if (response && response.error) {
								$("#dialog-error #msg").text(response.error);
								$("#dialog-error").dialog("open");
							} else {
								$("#dialog-error #msg").text("Unknown error");
								$("#dialog-error").dialog("open");
							}
						});
					});
				},
				open: function() {
					var mask = $("#dialog-masks input[name='mask']:checked").val();
					$("#dialog-editMask input[name='mask']").val(mask);
					$("#dialog-editMask #accessList label.static").hide();
					$("#dialog-editMask #loading").show();
					$("#dialog-editMask #name").text($("#dialog-masks input[name='mask']:checked+label .selector_label").text());

					$.ajax({
						url: "masks.php",
						type: "POST",
						data: {mode: "edit", mask: mask},
						dataType: "JSON"
					}).then(function(response) {
						if (response && response.results && response.results.length) {
							return tripwire.esi.fullLookup(response.results)
								.done(function(results) {
									if (results) {
										for (var x in results) {
											var node = makeAccessListNode(results[x], 'edit', '');
											$("#dialog-editMask #accessList .static:first").before(node);
										}
									}
								});
						}
					}).then(function(response) {
						$("#dialog-editMask #accessList label.static").show();
						$("#dialog-editMask #loading").hide();
					});
				},
				close: function() {
					$("#dialog-editMask #accessList :not(.static)").remove();
				}
			});

			// EVE search dialog
			$("#dialog-EVEsearch").dialog({
				autoOpen: false,
				dialogClass: "ui-dialog-shadow dialog-noeffect dialog-modal",
				buttons: {
					Add: function() {
						if ($("#accessList input[value='"+$("#EVESearchResults input").val()+"']").length) {
							$("#dialog-error #msg").text("Already has access");
							$("#dialog-error").dialog("open");
							return false;
						}

						$("#EVESearchResults .info").append('<input type="button" class="maskRemove" value="Remove" style="position: absolute; bottom: 3px; right: 3px;" />');
						$("#EVESearchResults input:checked").attr("checked", "checked");
						$("#EVESearchResults input:checked").attr("onclick", "return false");

						var nodes = $("#EVESearchResults .maskNode:has(input:checked)");

						if ($("#dialog-createMask").dialog("isOpen"))
							$("#dialog-createMask #accessList .static:first").before(nodes);
						else if ($("#dialog-editMask").dialog("isOpen"))
							$("#dialog-editMask #accessList .static:first").before(nodes);

						$(this).dialog("close");
					},
					Close: function() {
						$(this).dialog("close");
					}
				},
				create: function() {
					$("#EVEsearch").submit(function(e) {
						e.preventDefault();

						if ($("#EVEsearch input[name='name']").val() == "") {
							return false;
						}

						$("#EVESearchResults, #searchCount").text("");
						$("#EVEsearch #searchSpinner").show();
						$("#EVEsearch input[type='submit']").attr("disabled", "disabled");
						$("#dialog-EVEsearch").parent().find(".ui-dialog-buttonpane button:contains('Add')").attr("disabled", true).addClass("ui-state-disabled");

						tripwire.esi.search($("#EVEsearch input[name='name']").val(), $("#EVEsearch input[name='category']:checked").map((x, e) => e.value).get().join(','), $("#EVEsearch input[name='exact']")[0].checked)
							.done(function(results) {
								if (results && (results.character || results.corporation || results.alliance)) {
									// limit results
									results = [].concat(results.character || [],results.corporation || [], results.alliance || []);
									total = results.length;
									results = results.slice(0, 10);
									return tripwire.esi.fullLookup(results)
										.done(function(results) {
											$("#EVEsearch #searchCount").html("Found: "+total+"<br/>Showing: "+(total<10?total:10));
											if (results) {
												for (var x in results) {
													var node = makeAccessListNode(results[x], 'find', 'adds[]');
													$("#EVESearchResults").append(node);
												}
											}
										}).always(function() {
											$("#EVEsearch #searchSpinner").hide();
											$("#EVEsearch input[type='submit']").removeAttr("disabled");
											$("#dialog-EVEsearch").parent().find(".ui-dialog-buttonpane button:contains('Add')").removeAttr("disabled").removeClass("ui-state-disabled");
										});
								} else {
									$("#dialog-error #msg").text("No Results");
									$("#dialog-error").dialog("open");

									$("#EVEsearch #searchSpinner").hide();
									$("#EVEsearch input[type='submit']").removeAttr("disabled");
									$("#dialog-EVEsearch").parent().find(".ui-dialog-buttonpane button:contains('Add')").removeAttr("disabled").removeClass("ui-state-disabled");
								}
							}).fail(data => {
									$("#dialog-error #msg").text("Error from ESI while searching");
									$("#dialog-error").dialog("open");
									
									$("#EVEsearch #searchSpinner").hide();
									$("#EVEsearch input[type='submit']").removeAttr("disabled");
									$("#dialog-EVEsearch").parent().find(".ui-dialog-buttonpane button:contains('Add')").removeAttr("disabled").removeClass("ui-state-disabled");								
							});
					});
				},
				close: function() {
					$("#EVEsearch input[name='name']").val("");
					$("#EVESearchResults, #searchCount").text("");
				}
			});
			
			$("#maskControls #edit").click(function() {
				$("#dialog-editMask").dialog("open");
			});
