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

                    // Only pulse when the tab is actually being looked at, and
                    // clear any backlog first. jQuery animates off
                    // requestAnimationFrame, which is suspended while the tab is
                    // hidden, but .effect() still queues -- so a tab left open in
                    // the background accumulates one 5-pulse effect per player
                    // count change and plays all of them at once on return.
                    if (tripwire.serverStatus.data && !document.hidden) {
                        $("#serverStatus").stop(true, true).effect('pulsate', {times: 5});
                    }
                }

                tripwire.serverStatus.data = data;
            } else {
                $('#serverStatus').html("<span class='critical'>TQ</span>");
            }

            tripwire.serverStatus.timer = setTimeout(tripwire.serverStatus, 15000);
        });
}
tripwire.serverStatus();

tripwire.updateServerTime = function() {
	document.getElementById('serverTime').innerText = moment.utc().format('HH:mm')
};
setInterval(tripwire.updateServerTime, 5000);
tripwire.updateServerTime();