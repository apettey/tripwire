// Refresh the moment a hidden tab is looked at again.
//
// sync.js drops to a one-minute cadence while the tab is hidden. That is only
// acceptable if returning is instant, so this cancels the pending long timer
// and refreshes straight away on becoming visible.

(function() {
	$(function() {
		document.addEventListener("visibilitychange", function() {
			if (document.hidden || typeof tripwire === "undefined" || !tripwire.refresh) { return; }
			if (tripwire.timer) { clearTimeout(tripwire.timer); tripwire.timer = null; }
			tripwire.refresh();
		});
	});
})();
