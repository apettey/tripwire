// Fork-owned: small adapters that keep upstream Tripwire 2.0 working next to fork features
// (changes/2026-11-15-sync-upstream-tripwire-2-0).

// systemPanel.update (upstream 2.0) reads chain.data.flares[viewingSystemID] on every chain.draw, but chain.data.flares
// is only set once a refresh carried flares. Fork features draw the map earlier (EVE-Scout, tabs, settings), so start
// with no flares instead of throwing on the first draw.
if (typeof chain !== "undefined" && chain && chain.data && !chain.data.flares) {
	chain.data.flares = {};
}

// Upstream 2.0's kill stream (app/js/kill-stream.js) replaces the activity graph in J-space with the last kills, fetched
// by every browser straight from zkillboard.com. Here only the pooled worker may call zKillboard
// (docker/README.md#zkillboard), and the system / chain kill feeds (system-killfeed.js, chain-killfeed.js) already show
// kills from its data. So the stream never shows and never fetches, and the activity graph stays in J-space.
if (typeof tripwire !== "undefined" && tripwire && tripwire.killStream) {
	tripwire.killStream.isWormhole = function() { return false; };
	tripwire.killStream.refresh = function() {
		if (typeof $ === "function") {
			$("#killStream").addClass("hidden");
			$("#infoWidget").removeClass("is-wormhole");
		}
	};
}

// Upstream 2.0's note editor (app/js/editor.js) hands back the editable area's raw HTML: comments.js saves it (the server
// sanitises it) and, on save, puts it back into the page as the note as it is. Clean it here with the same sanitiser
// the notes are shown with (app/js/fork/sanitise-html.js), so what is saved and shown is what the server keeps.
if (typeof tripwire !== "undefined" && tripwire && tripwire.editor && typeof tripwire.editor.replace === "function" && !tripwire.editor.sanitiseWrapped) {
	const replaceEditor = tripwire.editor.replace;
	tripwire.editor.replace = function() {
		const inst = replaceEditor.apply(this, arguments);
		if (inst && typeof inst.getData === "function" && typeof sanitiseHtml === "function") {
			const getData = inst.getData;
			inst.getData = function() { return sanitiseHtml(getData.apply(this, arguments)); };
		}
		return inst;
	};
	tripwire.editor.sanitiseWrapped = true;
}
