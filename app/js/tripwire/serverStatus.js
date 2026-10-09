// Handles pulling TQ status & player count
tripwire.serverStatus = function() {
    this.data;
    this.timer;

    clearTimeout(tripwire.serverStatus.timer);

    tripwire.esi.eveStatus()
        .always(function(data) {
            if (data && data.players && data.players > 0) {
                if (!tripwire.serverStatus.data || tripwire.serverStatus.data.players !== data.players) {
                    $('#serverStatus').html("<span class='"+(data.players > 0 ? 'stable' : 'critical')+"'>TQ</span>: "+Intl.NumberFormat().format(data.players));

                    if (tripwire.serverStatus.data) {
                        $("#serverStatus").effect('pulsate', {times: 5});
                    }
                }

                tripwire.serverStatus.data = data;
            } else {
                $('#serverStatus').html("<span class='critical'>TQ</span>");
            }

            tripwire.serverStatus.timer = setTimeout("tripwire.serverStatus();", 15000);
        });
}
tripwire.serverStatus();

tripwire.updateServerTime = function() {
	document.getElementById('serverTime').innerText = moment.utc().format('HH:mm')
};
setInterval(tripwire.updateServerTime, 5000);
tripwire.updateServerTime();