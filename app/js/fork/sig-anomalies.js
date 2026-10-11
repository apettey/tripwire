const sigAnomalies = {
	// Cosmic anomalies in the signature list (fork-owned). A paste of the scanner window contains both cosmic
	// signatures and cosmic anomalies; anomalies are combat/ore sites that need no scanning and clutter the list.
	// Pasted anomalies are marked with signatures.bookmark = "anomaly" (an upstream column nothing else uses; the
	// server keeps it when a sig is edited). The Settings row decides what happens with them:
	//   show (default)  list them as before, hide  keep them but fold them away, skip  don't import them.
	// Setting: options.sigAnomalies.mode (missing = show). Keep `const sigAnomalies` on the first line: the test
	// helper strips it to define a global.

	MARKER: "anomaly",
	MODES: ["show", "hide", "skip"],

	/** The scanner-window group names of cosmic anomalies in every client language (see paste.js validScanGroups) */
	GROUPS: [
		"Cosmic Anomaly",		// en
		"Anomalie cosmique",	// fr
		"Kosmische Anomalie",	// de
		"宇宙の特異点",			// ja
		"코즈믹 어노말리",		// ko
		"Космическая аномалия"	// ru
	],

	isAnomalyGroup: function(group) {
		return sigAnomalies.GROUPS.indexOf(String(group === undefined || group === null ? "" : group).trim()) >= 0;
	},

	/** The mode in the given user options: "show" unless "hide" or "skip" is set */
	mode: function(opts) {
		const mode = opts && opts.sigAnomalies && opts.sigAnomalies.mode;
		return sigAnomalies.MODES.indexOf(mode) >= 0 ? mode : "show";
	},

	/** Whether a signature (client or server shape) is a marked anomaly */
	isAnomaly: function(sig) {
		return !!sig && sig.bookmark === sigAnomalies.MARKER;
	},

	/** Whether a parsed paste row (paste.js rowParse result) is an anomaly */
	isAnomalyRow: function(scanner) {
		return !!scanner && sigAnomalies.isAnomalyGroup(scanner.scanGroup);
	},

	/** Paste: the bookmark value to send for a parsed row (undefined for ordinary sigs, so nothing is sent) */
	marker: function(scanner) {
		return sigAnomalies.isAnomalyRow(scanner) ? sigAnomalies.MARKER : undefined;
	},

	/** Paste: true if the row must not be added (mode "skip", an anomaly, and not in the list yet). Rows that
	 *  already exist are not skipped: they only get marked (needsMark), so they stay known as anomalies. */
	skipRow: function(scanner, sig, opts) {
		return sigAnomalies.mode(opts) === "skip" && sigAnomalies.isAnomalyRow(scanner) && !sig;
	},

	/** Paste: true if an existing non-wormhole sig should get the anomaly marker now (a row of the paste is an
	 *  anomaly and the sig isn't marked yet), in every mode. */
	needsMark: function(scanner, sig) {
		return sigAnomalies.isAnomalyRow(scanner) && !!sig && sig.type !== "wormhole" && !sigAnomalies.isAnomaly(sig);
	},

	/** "Delete missing sigs": true if the sig must be kept although the paste doesn't list it. In "skip" mode
	 *  anomalies are not part of what the user imports, so a paste without them never deletes them. */
	keepOnFullPaste: function(sig, opts) {
		return sigAnomalies.mode(opts) === "skip" && sigAnomalies.isAnomaly(sig);
	},

	/** List: ids of the sigs to hide in the given mode (only "hide" hides) */
	hiddenIds: function(signatures, systemID, opts) {
		const ids = [];
		if (sigAnomalies.mode(opts) !== "hide") { return ids; }
		Object.keys(signatures || {}).forEach(function(id) {
			const sig = signatures[id];
			if (sig && sigAnomalies.isAnomaly(sig) && sig.systemID == systemID) { ids.push(String(id)); }
		});
		return ids;
	},

	/** Text of the toggle line, or "" when there is nothing hidden */
	barText: function(count, revealed) {
		if (!count) { return ""; }
		const noun = count + (count === 1 ? " anomaly" : " anomalies");
		return revealed ? "Showing " + noun + " - hide" : noun + " hidden - show";
	},

	// ---- DOM ----

	revealed: false,

	apply: function() {
		if (typeof tripwire === "undefined" || !tripwire.client) { return; }
		const opts = typeof options !== "undefined" ? options : undefined;
		const hidden = sigAnomalies.hiddenIds(tripwire.client.signatures, typeof viewingSystemID !== "undefined" ? viewingSystemID : undefined, opts);
		const set = {};
		hidden.forEach(function(id) { set[id] = true; });
		$("#sigTable tbody tr[data-id]").each(function() {
			$(this).toggleClass("sig-anomaly-hidden", !sigAnomalies.revealed && !!set[$(this).attr("data-id")]);
		});
		sigAnomalies.unselectHidden();
		let $bar = $("#sigAnomalyBar");
		const text = sigAnomalies.barText(hidden.length, sigAnomalies.revealed);
		if (!text) { $bar.remove(); sigAnomalies.revealed = false; return; }
		if (!$bar.length) {
			$bar = $("<div id=\"sigAnomalyBar\"><a href=\"#\"></a></div>");
			$("#sigTableWrapper").before($bar);
		}
		$bar.find("a").text(text);
	},

	/** A hidden row must not stay selected (Ctrl+A, shift-click ranges): Delete and Copy would act on it unseen */
	unselectHidden: function() {
		const $rows = $("#sigTable tbody tr.sig-anomaly-hidden.selected");
		if (!$rows.length) { return; }
		$rows.removeClass("selected");
		$("#signaturesWidget").trigger("selected:change");
	},

	scheduled: null,
	schedule: function() {
		if (sigAnomalies.scheduled) { return; }
		sigAnomalies.scheduled = setTimeout(function() { sigAnomalies.scheduled = null; sigAnomalies.apply(); }, 50);
	},

	setupSettings: function() {
		forkSettings.register({
			section: "signatures", order: 50, id: "sigAnomalies-mode", type: "select", key: "sigAnomalies",
			label: "Anomalies in the signature list:",
			hint: "Hide folds anomalies away behind a toggle line; Don't import skips new ones when you paste. Pasted anomalies are always marked, so you can switch later.",
			choices: [["show", "Show"], ["hide", "Hide"], ["skip", "Don't import"]],
			get: function(o) { return sigAnomalies.mode(o); },
			set: function(o, value) { o.sigAnomalies = { mode: sigAnomalies.MODES.indexOf(value) >= 0 ? value : "show" }; }
		});
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.sigAnomaliesWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				sigAnomalies.schedule();
				return result;
			};
			options.apply.sigAnomaliesWrapped = true;
		}
	},

	init: function() {
		sigAnomalies.setupSettings();
		$("body").on("click", "#sigAnomalyBar a", function(e) {
			e.preventDefault();
			sigAnomalies.revealed = !sigAnomalies.revealed;
			sigAnomalies.apply();
		});
		// Ctrl+A and shift-click select rows after this handler: look again once they are done
		$(document).on("keydown", function(e) { if ((e.ctrlKey || e.metaKey) && e.keyCode === 65) { setTimeout(sigAnomalies.unselectHidden, 0); } });
		$("#sigTable").on("click", "tbody tr", function() { setTimeout(sigAnomalies.unselectHidden, 0); });
		// a paste (or any refresh) can mark rows after they were drawn: hide them once the answer is in
		$(document).ajaxComplete(sigAnomalies.schedule);
		const tbody = document.querySelector("#sigTable > tbody");
		if (tbody && typeof MutationObserver !== "undefined") {
			new MutationObserver(sigAnomalies.schedule).observe(tbody, { childList: true });
		}
		sigAnomalies.schedule();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { sigAnomalies.init(); });
}
