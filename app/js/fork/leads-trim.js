const leadsTrim = {
	// Leads To trimming (fork-owned). A system name copied from the game ("J163701 ") ends in a space, which the
	// signature dialog then rejects as "Must be a valid leads to system!". Strip leading/trailing whitespace on paste,
	// and again in the capture phase of change so the dialog's own handlers see the trimmed name (Save trims too,
	// in signature-dialog.js, because jQuery's .submit() fires no native submit event).

	SELECTOR: "#dialog-signature [name='leadsTo']",

	/** Trim one field in place; true if its value changed. */
	trim: function(el) {
		if (!el || typeof el.value !== "string") { return false; }
		const trimmed = el.value.trim();
		if (trimmed === el.value) { return false; }
		el.value = trimmed;
		return true;
	},

	isLeadsField: function(el) {
		return !!(el && el.matches && el.matches(leadsTrim.SELECTOR));
	},

	install: function(doc) {
		doc.addEventListener("paste", function(e) {
			const el = e.target;
			if (!leadsTrim.isLeadsField(el)) { return; }
			// The pasted text lands after this event; trim then, and let the autocomplete see the clean value
			setTimeout(function() {
				if (leadsTrim.trim(el)) { el.dispatchEvent(new Event("input", {bubbles: true})); }
			}, 0);
		}, true);
		doc.addEventListener("change", function(e) {
			if (leadsTrim.isLeadsField(e.target)) { leadsTrim.trim(e.target); }
		}, true);
	}
};

if (typeof document !== "undefined" && document.addEventListener) {
	leadsTrim.install(document);
}
