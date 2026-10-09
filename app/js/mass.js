// Model and data binding for mass related UI
tripwire.massOptions = {
	higgs: false,
	prop: false
}
	
tripwire.resetMassOptions = function() {
	$("#hot-jump").removeClass("active");
	tripwire.massOptions.prop = false;		
	$("#higgs-jump").removeClass("active");
	tripwire.massOptions.higgs = false;
};

$("#hot-jump").click(function() {
	if ($(this).hasClass("active")) {		
		$(this).removeClass("active");
		tripwire.massOptions.prop = false;
	} else {
		$(this).addClass("active");
		tripwire.massOptions.prop = true;
	}
});

$("#higgs-jump").click(function() {
	if ($(this).hasClass("active")) {
		$(this).removeClass("active");
		tripwire.massOptions.higgs = false;
	} else {
		$(this).addClass("active");
		tripwire.massOptions.higgs = true;
	}
});
