const tracking = {
	remove: function(characterID) {
		$("#tracking .tracking-clone[data-characterid='"+ characterID +"']").remove();		
	},
	add: function(character) {
		var $clone = $("#tracking-clone").clone();
		$clone.attr("data-characterid", characterID);
		$clone.find(".avatar img").attr("src", "https://image.eveonline.com/Character/"+ character.characterID +"_32.jpg");
		$clone.find(".name").html(character.characterName);
		$clone.removeAttr("id");
		$clone.removeClass("hidden");
		$clone.addClass("tracking-clone");

		$("#tracking").append($clone);
		Tooltips.attach($clone.find(".avatar [data-tooltip]"));
		
		const charOptions = options.tracking.characterOptions[character.characterID] || tracking.defaultCharacterOptions;
		if(charOptions.show) { $clone.find('.show').addClass('active'); }
		if(charOptions.showShip) { $clone.find('.show-ship').addClass('active'); }
		
		return $clone;
	},
	defaultCharacterOptions: { show: true, showShip: true }
	
};

$("#track").on("click", ".tracking-clone", function() {
	var characterID =$(this).attr("data-characterid");
	$("#tracking .tracking-clone").removeClass("active");

	if (options.tracking.active == characterID) {
		options.tracking.active = null;
		tripwire.EVE(false, true);
		$("#removeESI").attr("disabled", "disabled");
	} else {
		options.tracking.active = characterID;

		if (tripwire.esi.characters[options.tracking.active]) {
			$("#tracking .tracking-clone[data-characterid='"+ options.tracking.active +"']").addClass("active");
			tripwire.EVE(tripwire.esi.characters[options.tracking.active], true);
		}

		$("#removeESI").removeAttr("disabled");
	}
	set_tracking_text();
	options.save();
});

$("#track").on("click", ".tracking-clone i.interactable", function(e) {
	const elem = e.target;
	const container = $(elem).closest('.tracking-clone')[0];
	const characterID = container.dataset.characterid;
	const wasActive = $(elem).hasClass('active');
	if(wasActive) {
		$(elem).removeClass('active');
	} else {
		$(elem).addClass('active');
	}
	e.stopPropagation();
	
	if(!options.tracking.characterOptions[characterID]) { options.tracking.characterOptions[characterID] = tracking.defaultCharacterOptions; }
	
	options.tracking.characterOptions[characterID][elem.dataset.property] = !wasActive;
	tripwire.esi.updateTracking(tripwire.esi.characters[characterID]);
});

$("#login").on("click", "#removeESI", function() {
	var characterID = options.tracking.active;

	options.tracking.active = null;
	tripwire.EVE(false, true);
	options.save();

	$("#tracking .tracking-clone[data-characterid='"+ characterID +"']").remove();

	$("#removeESI").attr("disabled", "disabled");

	if ($.isArray(tripwire.data.esi.delete)) {
		tripwire.data.esiDelete.push(characterID);
	} else {
		tripwire.data.esiDelete = [characterID];
	}
});


/** Set UI text based on the current tracked character */
function set_tracking_text() {
	if(tripwire.esi.characters[options.tracking.active]) {
		document.getElementById('user-track-name').textContent = tripwire.esi.characters[options.tracking.active].characterName;
		document.getElementById('user-track').style.display = '';
		document.getElementById('user-no-track').style.display = 'none';
	} else {
		document.getElementById('user-track').style.display = 'none';
		document.getElementById('user-no-track').style.display = '';	
	}
}
