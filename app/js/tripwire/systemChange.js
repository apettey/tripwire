// Change the currently viewed system
tripwire.systemChange = function(systemID, mode) {
	const system = systemAnalysis.analyse(systemID);
	if(!system) { return; }
		
    if (mode != "init") {
        $("#infoSecurity").removeClass();
        $("#infoStatics").empty();

        viewingSystem = system.name;
        viewingSystemID = systemID;

        // Reset activity
        activity.refresh(true);

        // Reset signatures
        $("#sigTable span[data-age]").countdown("destroy");
        $("#sigTable tbody").empty();
        $("#signature-count").text('0');
        tripwire.signatures.list = {};
        tripwire.client.signatures = null;

        // Reset chain map
        chain.redraw();

        // Reset comments
        $("#notesWidget .content .comment:visible").remove();
        tripwire.comments.data = null;

        // Change the URL & history
        history.replaceState(null, null, "?system="+viewingSystem);

        tripwire.refresh("change");
    }

    // Change the title
    document.title = system.name + " - " + app_name;

    $("#infoSystem").text(system.name);

    // Current system favorite
    $.inArray(parseInt(viewingSystemID), options.favorites) != -1 ? $("#system-favorite").attr("data-icon", "star").addClass("active") : $("#system-favorite").attr("data-icon", "star-empty").removeClass("active");
	
    if (system.class) {
        // Security
        $("#infoSecurity").html("<span class='" + system.systemTypeClass+" pointer'>Class " + system.class + "</span>");

        // Effects
        if (system.effect) {
            var tooltip = "<table cellpadding=\"0\" cellspacing=\"1\">";
            for (var x in tripwire.effects[system.effect]) {
                var effect = tripwire.effects[system.effect][x].name;
                var base = tripwire.effects[system.effect][x].base;
                var bad = tripwire.effects[system.effect][x].bad;
                var whClass = system.class > 6 ? 6 : system.class;
                var modifier = 0;

                switch (Math.abs(base)) {
                    case 15:
                        modifier = base > 0 ? 7 : -7;
                        break;
                    case 30:
                        modifier = base > 0 ? 14 : -14;
                        break;
                    case 60:
                        modifier = base > 0 ? 28 : -28;
                        break;
                }

                tooltip += "<tr><td>" + effect + "</td><td style=\"padding-left: 25px; text-align: right;\" class=\"" + (bad ? "critical" : "stable") + "\">";
                tooltip += base + (modifier * (whClass -1)) + "%</td></tr>";
            }
            tooltip += "</table>";
            $("#infoSecurity").append("&nbsp;<span class='pointer' data-tooltip='" + tooltip + "'>" + system.effect + "</span>");
        }

        // Statics
        for (var x in system.statics) {
            var type = system.statics[x];
            var wormhole = appData.wormholes[type];
            var color = "wh";

            switch (wormhole.leadsTo) {
                case "High-Sec":
                    color = "hisec";
                    break;
                case "Low-Sec":
                    color = "lowsec";
                    break;
                case "Null-Sec":
                    color = "nullsec";
                    break;
            }

            $("#infoStatics").append("<div><span class='"+ color +"'>&#9679;</span> <b class='"+ color +"'>"+ wormhole.leadsTo +"</b> via <span>"+ wormholeRendering.renderWormholeType(wormhole, type, system) +"</span></div>");
        }

        // Faction
        $("#infoFaction").html("&nbsp;");
    } else {
        // Security
		const securityText = {HS: 'High-Sec', LS: 'Low-Sec', NS: 'Null-Sec', 'Trig': 'Triglavian' }[system.systemTypeName];
       $("#infoSecurity").addClass(system.systemTypeClass).html(securityText + " " + system.baseSecurity.toFixed(2) + system.systemTypeModifiers.join(' '));

        // Faction
        if(fw) { $("#infoFaction").html(fw.factionMarkup(system)); }
		
		// Gates
		const connections = guidance.connections(tripwire.map.shortest, viewingSystemID);
		if(connections.length) {
			$('#infoStatics').append('<p><b>Gates</b>: ' + connections.map(c => {
				const system = systemAnalysis.analyse(c.systemID);
				return c.closed ? '<s>' + system.name + '</s> (closed)' : systemRendering.renderSystem(system); 
			}).join(', ') + '</p>');
		}
		
		// Route to favourites
		for (var fi in options.favorites) {
			const f = options.favorites[fi];
			const path = guidance.findShortestPath(tripwire.map.shortest, f, viewingSystemID);
			if(path) { $('#infoStatics').append('<p><b><a href=".?system=' + tripwire.systems[f].name + '">' +tripwire.systems[f].name + '</a></b>: ' + systemRendering.renderPath(path) + '</p>'); }
		}
    }

	Tooltips.attach($("#infoStatics [data-tooltip]"));
    Tooltips.attach($("#infoSecurity [data-tooltip]"));

    // Region
    $("#infoRegion").text(tripwire.regions[system.regionID].name);

    // Info Links
    $("#infoWidget .infoLink").each(function() {
        this.href = $(this).data("href").replace(/\$systemName/gi, system.name).replace(/\$systemID/gi, systemID);
    });

    // Reset undo/redo
    tripwire.signatures.undo[systemID] && tripwire.signatures.undo[systemID].length > 0 ? $("#undo").removeClass("disabled") : $("#undo").addClass("disabled");
    tripwire.signatures.redo[systemID] && tripwire.signatures.redo[systemID].length > 0 ? $("#redo").removeClass("disabled") : $("#redo").addClass("disabled");

    // Reset delete signature icon
    $("#sigTable tr.selected").length == 0 ? $("#signaturesWidget #delete-signature").addClass("disabled") : $("#signaturesWidget #delete-signature").removeClass("disabled");
}

setTimeout(() => tripwire.systemChange(viewingSystemID, "init"), 0);
