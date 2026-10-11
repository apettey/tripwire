tripwire.sync = function(mode, data, successCallback, alwaysCallback) {	
    var data = typeof(data) === "object" ? $.extend(true, {}, data) : {};

    // Grab any pending changes
    $.extend(true, data, tripwire.data);

    // Whether this request carries a signature action, so the response can
    // be checked for the list that action should have changed.
    var sentAction = !!(data.signatures && (data.signatures.add || data.signatures.update || data.signatures.remove));

    // Remove old timer to prevent multiple
    if (this.timer) clearTimeout(this.timer);
    if (this.xhr) {
		console.log('Awaiting existing XHR ' + this.xhr.data.mode + ': ', this.xhr);
		tripwire.data = data;
		this.timer = setTimeout(function() { tripwire.sync(mode, data, successCallback, alwaysCallback); }, 50);
		return false;
	}

    if (mode == 'refresh' || mode == 'change') {
        // The server resends the signature list only when the count differs or
        // the client's newest modifiedTime is OLDER than the database's -- at
        // one-second resolution. Two edits inside the same second (a paste
        // that adds, then a paste that updates the same row; or two people)
        // leave count and time equal, and the second edit is invisible to
        // every client until something else changes. After an action whose
        // response omitted the list, the next request declares itself stale
        // so the list comes back whole.
        data.signatureCount = tripwire.forceFullSync ? -1 : tripwire.serverSignatureCount;
        data.signatureTime = tripwire.forceFullSync ? "1970-01-01 00:00:00" : maxTimeByProperty(this.client.signatures, "modifiedTime");
        tripwire.forceFullSync = false;

        data.flareCount = chain.data.flares ? chain.data.flares.flares.length : 0;
        data.flareTime = chain.data.flares ? chain.data.flares.last_modified : 0;

        data.commentCount = Object.keys(this.comments.data||{}).length;
        data.commentTime = maxTimeByProperty(this.comments.data, "modified");

        data.activity = this.activity;
    } else {
        // Expand Tripwire with JSON data from EVE Data Dump and other static data
        $.extend(this, appData);

        this.aSigSystems = Object.assign(
			// Using the index as a key here because numeric keys always come first and we want these before real systems
			// see https://stackoverflow.com/questions/47881998/
			appData.genericSystemTypes.reduce(function(o, s, i) { o[i] = systemAnalysis.analyse(s); o[i].name = s; return o; }, {} ),
			this.systems);
		
        $(".systemsAutocomplete").inlinecomplete({source: this.systems, renderer: 'system', maxSize: 10, delay: 0});
    }

    data.mode = mode != "init" ? "refresh" : "init";
    data.systemID = viewingSystemID;
    data.systemName = viewingSystem;
    data.instance = tripwire.instance;
    data.version = tripwire.version;

    this.xhr = $.ajax({
        url: "refresh.php",
        data: data,
        type: "POST",
        dataType: "JSON",
        cache: false
    }).done(function(data) {
        if (data) {
            tripwire.server = data;
            if(data.signatures) { // Save this count before we delete entries
                tripwire.serverSignatureCount = Object.keys(data.signatures||{}).length;
            }

            if (data.wormholes) {
                // Purge bad wormhole signatures
                var wormholeInitialIDs = {};
                var wormholeSecondaryIDs = {};
                Object.values(data.wormholes).forEach(function (wh) {
                    wormholeInitialIDs[parseInt(wh.initialID)] = wh.id;
                    wormholeSecondaryIDs[parseInt(wh.secondaryID)] = wh.id;
                })
                for (var i in data.signatures) {
                  if (data.signatures[i].type == "wormhole") {
                    var id = data.signatures[i].id;
                    if (wormholeInitialIDs[id] === undefined && wormholeSecondaryIDs[id] === undefined) {
                      delete data.signatures[i];
                    }
                  }
                }
            }

            if (data.esi) {
                tripwire.esi.parse(data.esi);
            }

            if (data.oauth) {
                tripwire.esi.parseOauth(data.oauth);
            }

            if (data.sync) {
                tripwire.serverTime.time = new Date(data.sync);
            }

            if (data.signatures) {
                tripwire.parse(data, mode);
            } else if (sentAction && data.resultSet && data.resultSet[0] && data.resultSet[0].result == true) {
                // The action succeeded but the list did not come back: the
                // same-second case. Ask again, stale, straight away.
                tripwire.forceFullSync = true;
                setTimeout(function() { tripwire.refresh(); }, 150);
            }

            if (data.comments) {
                tripwire.comments.parse(data.comments);
            }

            if (data.wormholes || data.occupied || data.flares) {
                tripwire.chainMap.parse({"map": data.wormholes || null, "occupied": data.occupied || null, "flares": data.flares || null});
            } else if (chain.data.occupied && chain.data.occupied.length && !data.occupied) {
                // send update to remove all occupied system indicators
                tripwire.chainMap.parse({"occupied": []});
            }

			tripwire.updateReturnStatus();

            tripwire.active(data.activity);

            if (data.notify && !$("#serverNotification")[0]) Notify.trigger(data.notify, "yellow", false, "serverNotification");
			
			$('[data-command=ping]')[data.discord_integration ? 'show' : 'hide']();
        }

        tripwire.data = {tracking: {}, esi: {}};
        successCallback ? successCallback(data) : null;
    }).always(function(data, status) {
        tripwire.timer = setTimeout("tripwire.refresh();", tripwire.refreshRate);

        alwaysCallback ? alwaysCallback(data) : null;

        if (data.status == 403) {
            window.location.href = ".";
        } else if (status != "success" && status != "abort" && tripwire.connected == true) {
            tripwire.connected = false;
            $("#ConnectionSuccess").click();
            Notify.trigger("Error syncing with server", "red", false, "connectionError");
        } else if (status == "success" && tripwire.connected == false) {
            tripwire.connected = true;
            $("#connectionError").click();
            Notify.trigger("Successfully reconnected with server", "green", 5000, "connectionSuccess");
        }
		
		tripwire.xhr = null;
    });
	this.xhr.data = data;
	
    return true;
};

function maxTimeByProperty(obj, prop) {
	var maxTimeString = "", maxTime;

	for (var key in obj) {
		if (!maxTime || maxTime < new Date(obj[key][prop])) {
			maxTime = new Date(obj[key][prop]);
			maxTimeString = obj[key][prop];
		}
	}
	return maxTimeString;
}

tripwire.sync("init");
