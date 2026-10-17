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
