// Floating windows (fork-owned): non-modal dialogs that can stay open while you work, like the Jump planner and the
// Region map. They carry dialogClass "dialog-floating". Upstream treats any visible .ui-dialog as "a dialog is open"
// (app/js/dialogs/base-dialog.js keeps #wrapper blurred, app/js/tripwire/eve.js stops Follow); fork code and the one-line
// eve.js edit skip .dialog-floating, and this file clears the blur base-dialog.js leaves when only floating ones are open.
if (typeof jQuery !== "undefined") {
	// Registered after base-dialog.js, so it runs after its own dialogclose handler
	jQuery(document).on("dialogclose", ".ui-dialog", function() {
		if (!jQuery(".ui-dialog:visible").not(".dialog-floating").length) { jQuery("#wrapper").removeClass("blur"); }
	});
}

// The grey #overlay under a second modal dialog: base-dialog.js decides it by counting every visible .ui-dialog, so
// windows that stay open (popped-out panels, the Region map) made a single confirm get the overlay and a confirm over
// Settings miss it. Registered after base-dialog.js, so this runs after its handlers and sets it again counting only
// the dialogs that aren't floating: an overlay while two or more are open, under the top one.
if (typeof jQuery !== "undefined") {
	const fixOverlay = function(opening) {
		const $open = jQuery(".ui-dialog:visible").not(".dialog-floating");
		let $overlay = jQuery("#overlay");
		if ($open.length < 2) { $overlay.remove(); return; }
		if (!$overlay.length) {
			if (!opening || !opening.hasClass("dialog-modal") || opening.hasClass("dialog-floating")) { return; }
			$overlay = jQuery("<div id='overlay' class='overlay' />").appendTo("body");
		}
		let top = 0;
		$open.each(function() { top = Math.max(top, parseInt(jQuery(this).css("z-index"), 10) || 0); });
		$overlay.css("z-index", top - 1);
	};
	jQuery(document).on("dialogopen", ".ui-dialog", function() { fixOverlay(jQuery(this)); });
	jQuery(document).on("dialogclose", ".ui-dialog", function() { fixOverlay(null); });
}
