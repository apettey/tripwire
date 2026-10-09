tripwire.esi = function() {
    var baseUrl = "https://esi.evetech.net";
    var userAgent = "Tripwire Client " + tripwire.version + " (" + window.location.hostname + ") - " + window.navigator.userAgent;
    var locationTimer, shipTimer, onlineTimer;
    this.esi.connection = true;
    this.esi.characters = {};
    this.esi.oauth = { subject: "", accessToken: ""};

    var scopeError = function(characterID) {
        $("#tracking .tracking-clone[data-characterid='"+ characterID +"']").find(".alert").show();
    }

	var isExpired = function(tokenExpire) {
		return moment.utc(tokenExpire).subtract(5, "minutes").isBefore(moment());
	}

	function updateTracking(character) {
		// Send to Tripwire server on next refresh call
		tripwire.data.tracking[character.characterID] = {
			characterID: character.characterID,
			characterName: character.characterName,
			systemID: character.systemID,
			systemName: character.systemName,
			stationID: character.stationID,
			stationName: character.stationName,
			shipID: character.shipID,
			shipName: character.shipName,
			shipTypeID: character.shipTypeID,
			shipTypeName: character.shipTypeName,
			massOptions: tripwire.massOptions,
			characterOptions: options.tracking.characterOptions[character.characterID]
		};				
	}
	this.esi.updateTracking = updateTracking;	// so it can be called outside

    this.esi.location = function() {
        clearTimeout(locationTimer);

        for (characterID in tripwire.esi.characters) {
            var character = tripwire.esi.characters[characterID];

            // Check for expiring token
            if (isExpired(character.tokenExpire)) {
                tripwire.data.esi = {"expired": true};
                continue;
            }

            const xhr = $.ajax({
                url: baseUrl + "/v1/characters/"+ characterID +"/location/?" + $.param({"token": character.accessToken, "user_agent": userAgent}),
                // headers: {"Authorization": "Bearer "+ character.accessToken, "X-User-Agent": userAgent},
                type: "GET",
                dataType: "JSON",
                characterID: characterID
            }).done(function(data, status, jqXHR) {
                var character = tripwire.esi.characters[this.characterID];

                if (character) {
                    character.locationDate = moment(jqXHR.getResponseHeader("last-modified"), "ddd, DD MMMM YYYY HH:mm:ss").format();

                    if (character.systemID != data.solar_system_id) {
                        character.systemID = data.solar_system_id || null;
						const system = systemAnalysis.analyse(data.solar_system_id);
                        character.systemName = system ? system.name : null;

                        $("#tracking .tracking-clone[data-characterid='"+ this.characterID +"']").find(".system").html(systemRendering.renderSystem(system) || "&nbsp;");
						
						updateTracking(character);
                    }

                    if (character.stationID != data.station_id) {
                        character.stationID = data.station_id || null;

                        if (data.station_id) {
                            tripwire.esi.stationLookup(data.station_id, this.characterID)
                                .always(function(data) {
                                    var character = tripwire.esi.characters[this.reference];

                                    character.stationName = data.name || null;
                                    $("#tracking .tracking-clone[data-characterid='"+ this.reference +"']").find(".station").html(data.name.substring(0, 17) + "..." || "&nbsp;").attr("data-tooltip", data.name);
                                    Tooltips.attach($("#tracking .tracking-clone[data-characterid='"+ this.reference +"'] .station[data-tooltip]"));

                                    updateTracking(character);
                                });
                        } else {
                            character.stationName = null;
                            // $("#tracking .tracking-clone[data-characterid='"+ this.characterID +"']").find(".station").html("&nbsp;").attr("data-tooltip", "&nbsp;");
                            Tooltips.detach($("#tracking .tracking-clone[data-characterid='"+ this.characterID +"'] .station[data-tooltip]"));
							updateTracking(character);
                        }
                    }

                    if (options.tracking.active == this.characterID) {
                        tripwire.EVE(tripwire.esi.characters[options.tracking.active]);
                    }
                }
            }).fail(function(data) {
                if (data.status == 403) {
                    tripwire.refresh("refresh", {"esi": {"expired": true}});
                }
            }).always(function(data, status, jqXHR) {
                if (status != "success" && status != "abort" && tripwire.esi.connection == true) {
                    tripwire.esi.connection = false;
                    $("#esiConnectionSuccess, #esiConnectionError").click();
                    Notify.trigger("ESI Connection Failed", "red", false, "esiConnectionError");
                } else if (status == "success" && tripwire.esi.connection == false) {
                    tripwire.esi.connection = true;
                    $("#esiConnectionSuccess, #esiConnectionError").click();
                    Notify.trigger("ESI Connection Resumed", "green", 5000, "esiConnectionSuccess");
                }
            });
            xhr.always(function(){
                const warn = xhr.getResponseHeader('warning');
                if (warn) console.warn('ESI API Warning: ', warn, this.url);
            });
        }

        locationTimer = setTimeout("tripwire.esi.location()", 5000);
    }

    this.esi.ship = function() {
        clearTimeout(shipTimer);

        for (characterID in tripwire.esi.characters) {
            var character = tripwire.esi.characters[characterID];

            // Check for expiring token
            if (isExpired(character.tokenExpire)) {
                tripwire.data.esi = {"expired": true};
                continue;
            }

            const xhr = $.ajax({
                url: baseUrl + "/v1/characters/"+ characterID +"/ship/?" + $.param({"token": character.accessToken, "user_agent": userAgent}),
                // headers: {"Authorization": "Bearer "+ character.accessToken, "X-User-Agent": userAgent},
                type: "GET",
                dataType: "JSON",
                characterID: characterID
            }).done(function(data, status, jqXHR) {
                var character = tripwire.esi.characters[this.characterID];

                if (character) {
                    character.shipDate = moment(jqXHR.getResponseHeader("last-modified"), "ddd, DD MMMM YYYY HH:mm:ss").format();

                    if (character.shipID != data.ship_item_id) {
                        character.shipID = data.ship_item_id || null;
						tripwire.resetMassOptions();
						updateTracking(character);
                    }

                    if (character.shipName != data.ship_name) {
                        character.shipName = data.ship_name || null;
                        $("#tracking .tracking-clone[data-characterid='"+ this.characterID +"']").find(".shipname").html(data.ship_name || "&nbsp;");
						updateTracking(character);
                    }

                    if (character.shipTypeID != data.ship_type_id) {
                        character.shipTypeID = data.ship_type_id || null;

                        if (data.ship_type_id) {
                            tripwire.esi.typeLookup(data.ship_type_id, this.characterID)
                                .always(function(data) {
                                    var character = tripwire.esi.characters[this.reference];

                                    character.shipTypeName = data.name || null;
                                    $("#tracking .tracking-clone[data-characterid='"+ this.reference +"']").find(".ship").html(data.name || "&nbsp;");
									updateTracking(character);
                                });
                        } else {
                            character.shipTypeName = null;
                            $("#tracking .tracking-clone[data-characterid='"+ this.characterID +"']").find(".ship").html("&nbsp;");
							updateTracking(character);
                        }
                    }
                }
            }).fail(function(data) {
                if (data.status == 403) {
                    tripwire.refresh("refresh", {"esi": {"expired": true}});
                }
            }).always(function(data, status, jqXHR) {
                if (status != "success" && status != "abort" && tripwire.esi.connection == true) {
                    tripwire.esi.connection = false;
                    $("#esiConnectionSuccess, #esiConnectionError").click();
                    Notify.trigger("ESI Connection Failed", "red", false, "esiConnectionError");
                } else if (status == "success" && tripwire.esi.connection == false) {
                    tripwire.esi.connection = true;
                    $("#esiConnectionSuccess, #esiConnectionError").click();
                    Notify.trigger("ESI Connection Resumed", "green", 5000, "esiConnectionSuccess");
                }
            });
            xhr.always(function(){
                const warn = xhr.getResponseHeader('warning');
                if (warn) console.warn('ESI API Warning: ', warn, this.url);
            });

        }

        shipTimer = setTimeout("tripwire.esi.ship()", 5000);
    }

    this.esi.online = function() {
        clearTimeout(onlineTimer);

        for (characterID in tripwire.esi.characters) {
            var character = tripwire.esi.characters[characterID];

            tripwire.esi.characterStatus(character.characterID, character)
                .done(function(data) {
                    if (data.online) {
                        $("#tracking .tracking-clone[data-characterid='"+ this.reference.characterID +"']").find(".online").removeClass("critical").addClass("stable");
                    } else {
                        $("#tracking .tracking-clone[data-characterid='"+ this.reference.characterID +"']").find(".online").removeClass("stable").addClass("critical");
                    }
                }).fail(function(data) {
                    if (data && data.status == 403) {
                        scopeError(this.reference.characterID);
                    }
                    $("#tracking .tracking-clone[data-characterid='"+ this.reference.characterID +"']").find(".online").removeClass("stable").addClass("critical");
                });
        }

        onlineTimer = setTimeout("tripwire.esi.online()", 60000);
    }

    this.esi.typeLookup = function(typeID, reference) {
        const xhr = $.ajax({
            url: baseUrl + "/v3/universe/types/"+ typeID +"/?" + $.param({"user_agent": userAgent}),
            // headers: {"X-User-Agent": userAgent},
            type: "GET",
            dataType: "JSON",
            reference: reference
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.stationLookup = function(stationID, reference) {
        const xhr = $.ajax({
            url: baseUrl + "/v2/universe/stations/"+ stationID +"/?" + $.param({"user_agent": userAgent}),
            // headers: {"X-User-Agent": userAgent},
            type: "GET",
            dataType: "JSON",
            reference: reference
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.setDestination = function(destinationID, characterID, clear_waypoints, beginning) {
        clear_waypoints = clear_waypoints ? clear_waypoints : false;
        beginning = beginning ? beginning : false;
        const xhr = $.ajax({
            url: baseUrl + "/v2/ui/autopilot/waypoint/?" + $.param({destination_id: destinationID, clear_other_waypoints: clear_waypoints, add_to_beginning: beginning}),
            headers: {"Authorization": "Bearer "+ tripwire.esi.characters[characterID].accessToken, "X-User-Agent": userAgent},
            type: "POST",
            dataType: "JSON"
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.showInfo = function(targetID, characterID) {
        const xhr = $.ajax({
            url: baseUrl + "/v1/ui/openwindow/information/?" + $.param({target_id: targetID}),
            headers: {"Authorization": "Bearer "+ tripwire.esi.characters[characterID].accessToken, "X-User-Agent": userAgent},
            type: "POST",
            dataType: "JSON"
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.characterStatus = function(characterID, reference) {
        const xhr = $.ajax({
            url: baseUrl + "/v2/characters/" + characterID + "/online/?" + $.param({"token": tripwire.esi.characters[characterID].accessToken, "user_agent": userAgent}),
            // headers: {"Authorization": "Bearer "+ tripwire.esi.characters[characterID].accessToken, "X-User-Agent": userAgent},
            type: "GET",
            dataType: "JSON",
            reference: reference
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.eveStatus = function() {
        const xhr = $.ajax({
            url: baseUrl + "/v1/status/?" + $.param({"user_agent": userAgent}),
            // headers: {"X-User-Agent": userAgent},
            type: "GET",
            dataType: "JSON"
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.idLookup = function(eveIDs) {
        const xhr = $.ajax({
            url: baseUrl + "/v2/universe/names/?" + $.param({"user_agent": userAgent}),
            type: "POST",
            dataType: "JSON",
            contentType: "application/json",
            processData: false,
            data: JSON.stringify(eveIDs)
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.characterLookup = function(eveID, reference, async) {
        var async = typeof(async) !== 'undefined' ? async : true;
        const xhr = $.ajax({
            url: baseUrl + "/latest/characters/" + eveID + "/?" + $.param({"user_agent": userAgent}),
            type: "GET",
            dataType: "JSON",
            async: async,
            eveID: eveID,
            reference: reference
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.corporationLookup = function(eveID, reference, async) {
        var async = typeof(async) !== 'undefined' ? async : true;
        const xhr = $.ajax({
            url: baseUrl + "/v4/corporations/" + eveID + "/?" + $.param({"user_agent": userAgent}),
            type: "GET",
            dataType: "JSON",
            async: async,
            eveID: eveID,
            reference: reference
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.allianceLookup = function(eveID, reference, async) {
        var async = typeof(async) !== 'undefined' ? async : true;
        const xhr = $.ajax({
            url: baseUrl + "/v3/alliances/" + eveID + "/?" + $.param({"user_agent": userAgent}),
            type: "GET",
            dataType: "JSON",
            async: async,
            eveID: eveID,
            reference: reference
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.search = function(searchString, categories, strict) {
        const xhr = $.ajax({
            url: baseUrl + "/latest/characters/" + tripwire.esi.oauth.subject + "/search/?" + $.param({"user_agent": userAgent}),
            headers: {"Authorization": "Bearer "+ tripwire.esi.oauth.accessToken},
            type: "GET",
            dataType: "JSON",
            contentType: "application/json",
            data: {"search": searchString, "categories": categories, "strict": strict}
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.universeJumps = function() {
        const xhr = $.ajax({
            url: baseUrl + "/v1/universe/system_jumps/?" + $.param({"user_agent": userAgent}),
            type: "GET",
            dataType: "JSON"
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    this.esi.universeKills = function() {
        const xhr = $.ajax({
            url: baseUrl + "/v2/universe/system_kills/?" + $.param({"user_agent": userAgent}),
            type: "GET",
            dataType: "JSON"
        });
        return xhr.always(function(){
            const warn = xhr.getResponseHeader('warning');
            if (warn) console.warn('ESI API Warning: ', warn, this.url);
        });
    }

    // Wrapper to make lookups easier
    this.esi.fullLookup = function(eveIDs) {
        var promise = $.Deferred();

        tripwire.esi.idLookup(eveIDs)
            .done(function(data) {
                for (item in data) {
                    if (data[item].category == "character") {
                        tripwire.esi.characterLookup(data[item].id, data[item], false)
                            .done(function(characterData) {
                                $.extend(data[item], characterData);
                                tripwire.esi.corporationLookup(characterData.corporation_id, this.reference, false)
                                    .done(function(corporationData) {
                                        data[item].corporation = corporationData;
                                        if (corporationData.alliance_id) {
                                            tripwire.esi.allianceLookup(corporationData.alliance_id, this.reference, false)
                                                .done(function(allianceData) {
                                                    data[item].alliance = allianceData;
                                                });
                                        }
                                    });
                            });
                    } else if (data[item].category == "corporation") {
                        tripwire.esi.corporationLookup(data[item].id, data[item], false)
                            .done(function(corporationData) {
                                $.extend(data[item], corporationData);
                                if (corporationData.alliance_id) {
                                    tripwire.esi.allianceLookup(corporationData.alliance_id, this.reference, false)
                                        .done(function(allianceData) {
                                            data[item].alliance = allianceData;
                                        });
                                }
                            })
                    } else if (data[item].category == "alliance") {
                        tripwire.esi.allianceLookup(data[item].id, data[item], false)
                            .done(function(allianceData) {
                                $.extend(data[item], allianceData);
                            })
                    }
                }

                promise.resolve(data);
            });

        return promise;
    }

    // Parse main account oauth information out of refresh data. This is used
    // to make authenticated ESI requests for enpoints that are not specific to
    // tracking characters, e.g., mask access management.
    this.esi.parseOauth = function(data) {
        const _data = data || {}
        tripwire.esi.oauth = {
            subject: _data.subject,
            accessToken: _data.accessToken
        };
    }

    this.esi.parse = function(characters) {
        for (characterID in tripwire.esi.characters) {
            if (!(characterID in characters)) {
                delete tripwire.esi.characters[characterID];
                tracking.remove(characterID);
                if (options.tracking.active == characterID) {
                    tripwire.EVE(false, true);
                    $("#removeESI").attr("disabled", "disabled");
                }
            }
        }

        for (characterID in characters) {
            if (options.tracking.active == "new") {
                options.tracking.active = characterID;
            }

            if (!(characterID in tripwire.esi.characters)) {
                var $clone = tracking.add(characters[characterID]);
				
                if (options.tracking.active == characterID) {
                    $clone.addClass("active");
                    $("#removeESI").removeAttr("disabled");
                }

            }

            tripwire.esi.characters[characterID] = characters[characterID];
        }
		
		set_tracking_text();

        tripwire.esi.ship();
        tripwire.esi.location();
        tripwire.esi.online();
    }
}
tripwire.esi();
