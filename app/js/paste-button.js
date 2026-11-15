// A visible way in for the tool's main loop.
//
// Pasting probe-scanner results has always been the primary way signatures
// get into Tripwire, and it has never had a control on screen -- Ctrl-V with
// nothing focused. New corp members find it in the tutorial or not at all,
// and on a tablet there is no Ctrl-V to find.
//
// The button reads the clipboard directly where the browser allows it (a
// user gesture is enough in Chromium; Firefox and Safari prompt or refuse),
// and otherwise falls back to the existing hidden textarea and asks for the
// keystroke. Either way the text ends up in the same parsePaste path the
// keystroke uses, so the two routes cannot drift.

var __tripwirePasteIngest;
(function() {
	function ingest(text) {
		if (!text || !text.trim()) {
			Notify.trigger("Nothing on the clipboard looked like scanner results.");
			return;
		}
		Notify.trigger("Paste detected<br/>(<a id='fullPaste' href=''>Click to delete missing sigs</a>)");
		$("#fullPaste").data("paste", text);
		tripwire.pasteSignatures.parsePaste(text);
	}

	__tripwirePasteIngest = ingest;

	function fallback() {
		$("#clipboard").focus();
		Notify.trigger("Press Ctrl-V (or &#8984;V) now to paste your scan results.");
	}

	$(function() {
		$(document).on("click", "#paste-signatures", function(e) {
			e.preventDefault();
			if (navigator.clipboard && navigator.clipboard.readText) {
				navigator.clipboard.readText().then(ingest, fallback);
			} else {
				fallback();
			}
		});
	});
})();

// Paste from anywhere.
//
// paste.js only listens on a hidden textarea it focuses when Ctrl-V is
// pressed with nothing else focused. Click the system name (which opens
// search), or the palette, or any field, and focus is in an input -- so the
// keystroke pastes there and the scan never reaches the parser. That is
// "I can't paste sigs" from the user's side of the screen.
//
// If what is being pasted looks like probe-scanner output -- tab-separated
// rows starting with a signature id -- it is a scan wherever it lands. The
// exceptions are places where a person is genuinely editing text: the
// signature dialog, the notes editor, and settings.
(function() {
	var SCAN = /^[A-Z]{3}-\d{3}\t/m;
	document.addEventListener("paste", function(e) {
		var t = e.target;
		if (t && t.closest && t.closest("#dialog-signature, .rte, #dialog-options, #clipboard")) { return; }
		var cb = e.clipboardData; if (!cb) { return; }
		var text = cb.getData("text/plain") || "";
		if (!SCAN.test(text)) { return; }
		e.preventDefault();
		e.stopPropagation();
		if (t && t.blur) { t.blur(); }
		__tripwirePasteIngest(text);
	}, true);
})();
