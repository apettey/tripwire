const sigExpiry = {
	// Site expiry (fork-owned). Non-wormhole signatures ("sites": combat, data, relic, gas, ore, and unknown,
	// which may turn out to be a site) have no natural end in the game, but the server deletes them when their
	// Tripwire life (lifeLength, from creation) runs out. This feature:
	// - gives sites a longer default life than holes (options.sigExpiry.siteLife hours, default 7 days), used by
	//   paste and the Add dialog; holes keep the paste default (options.signatures.pasteLife) or their type's life;
	// - counts a site down in its Age cell for its last 24 h (orange), red in its last 4 h, like EOL holes, with an
	//   "Expires in ..." line in the Age tooltip.
	// Settings: options.sigExpiry = {siteLife, enabled}; a missing key means the defaults (7 days, on).
	// Keep `const sigExpiry` on the first line and no other `const` at the start of a line: the test helper
	// strips the first ones to define a global.

	HOUR_MS: 3600000,
	TICK_MS: 60000,
	SOON_H: 24,			// counted down from this many hours before the server deletes the sig
	CRITICAL_H: 4,		// red from here
	DEFAULT_SITE_LIFE_H: 168,
	SITE_LIFE_CHOICES: [[72, "72 Hours"], [168, "7 Days"], [336, "14 Days"], [672, "28 Days"]],
	DEFAULT_PASTE_LIFE_H: 72,	// upstream's options.signatures.pasteLife default

	/** Whether a signature type is a site (anything but a wormhole; unknown counts as a site) */
	isSite: function(type) {
		return String(type || "unknown").toLowerCase() !== "wormhole";
	},

	/** Default life of new sites in hours, from the user options */
	siteLifeHours: function(opts) {
		const h = parseFloat(opts && opts.sigExpiry && opts.sigExpiry.siteLife);
		return h > 0 ? h : sigExpiry.DEFAULT_SITE_LIFE_H;
	},

	/** Upstream's paste default life in hours */
	pasteLifeHours: function(opts) {
		const h = parseFloat(opts && opts.signatures && opts.signatures.pasteLife);
		return h > 0 ? h : sigExpiry.DEFAULT_PASTE_LIFE_H;
	},

	/** Default lifeLength (seconds) of a new signature of this type: the site life, or the paste default for holes */
	defaultLifeSeconds: function(type, opts) {
		return (sigExpiry.isSite(type) ? sigExpiry.siteLifeHours(opts) : sigExpiry.pasteLifeHours(opts)) * 3600;
	},

	/** Add dialog: the life to show after the signature type changes, or null to leave the picker alone.
	Only replaces the other kind's default (a value the user typed, or a wormhole type's life, stays).
	@param current the picker's value (seconds) before the change
	@param newType the newly selected signature type */
	lifeAfterTypeChange: function(current, newType, opts) {
		const next = sigExpiry.defaultLifeSeconds(newType, opts);
		const other = sigExpiry.defaultLifeSeconds(sigExpiry.isSite(newType) ? "wormhole" : "unknown", opts);
		return Number(current) === other && other !== next ? next : null;
	},

	/** lifeLength (seconds) for a site that a paste turns into a wormhole: the paste default counted from now, so the
	hole gets the same life as a freshly pasted one (its lifeLength runs from lifeTime, when the sig was first seen,
	and a site that is days old must not come out already expired)
	@param sig the signature (its lifeTime) @param now current time in ms (server clock) */
	holeLifeSeconds: function(sig, opts, now) {
		const base = sigExpiry.pasteLifeHours(opts) * 3600;
		// a never-expiring sig: the server restarts lifeTime at now when it gets a length (signatures.php)
		if (sig && Number(sig.lifeLength) === 0) { return base; }
		return base + sigExpiry.ageSeconds(sig, now);
	},

	/** lifeLength (seconds) for a paste that updates an existing site with new info (type, name): at least the
	default life counted from now, never shorter than its current life (a life the user extended stays), and a
	never-expiring sig (lifeLength 0) stays that way. lifeLength runs from lifeTime, when the sig was first seen.
	@param sig the signature before the update @param type its new type @param now current time in ms (server clock) */
	updateLifeSeconds: function(sig, type, opts, now) {
		if (sig && Number(sig.lifeLength) === 0) { return 0; }
		const fromNow = sigExpiry.defaultLifeSeconds(type, opts) + sigExpiry.ageSeconds(sig, now);
		return Math.max(Number(sig && sig.lifeLength) || 0, fromNow);
	},

	/** Whole seconds since the sig's lifeTime, 0 when unknown or in the future */
	ageSeconds: function(sig, now) {
		const created = sigExpiry.parseServerTime(sig && sig.lifeTime);
		if (isNaN(created) || !(now > created)) { return 0; }
		return Math.ceil((now - created) / 1000);
	},

	/** Milliseconds since the epoch for a server time 'YYYY-MM-DD HH:mm:ss' (UTC), or NaN */
	parseServerTime: function(text) {
		const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text || ""));
		if (!m) { return NaN; }
		return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
	},

	/** Expiry state of a signature.
	@param sig the signature (tripwire.client.signatures entry)
	@param now current time in ms (server clock)
	@return {state: 'soon'|'critical', remainingMs} in its last SOON_H hours, else null (holes, never-expiring
	sigs, unknown expiry, more time left) */
	stateFor: function(sig, now) {
		if (!sig || !sigExpiry.isSite(sig.type)) { return null; }
		const length = parseInt(sig.lifeLength);
		if (!(length > 0)) { return null; }
		const left = sigExpiry.parseServerTime(sig.lifeLeft);
		if (isNaN(left)) { return null; }
		const remainingMs = left - now;
		if (remainingMs > sigExpiry.SOON_H * sigExpiry.HOUR_MS) { return null; }
		return { state: remainingMs <= sigExpiry.CRITICAL_H * sigExpiry.HOUR_MS ? "critical" : "soon", remainingMs: remainingMs };
	},

	/** Whether the feature is switched on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.sigExpiry && opts.sigExpiry.enabled === false);
	},

	/** stateFor when the feature is on in the page's options, else null (used by sig-age.js too) */
	active: function(sig, now) {
		if (!sigExpiry.enabled(typeof options !== "undefined" ? options : undefined)) { return null; }
		return sigExpiry.stateFor(sig, now);
	},

	/** Short duration: '40 min', '3 h 20 min' under 10 h, '15 h' */
	formatLeft: function(ms) {
		const minutes = Math.max(0, Math.floor(ms / 60000));
		if (minutes < 60) { return minutes + " min"; }
		const h = Math.floor(minutes / 60), m = minutes % 60;
		return h < 10 && m ? h + " h " + m + " min" : h + " h";
	},

	/** Tooltip line for a state from stateFor, or '' */
	note: function(result) {
		if (!result) { return ""; }
		if (result.remainingMs <= 60000) { return "Expires now: Tripwire deletes it within a minute"; }
		return "Expires in " + sigExpiry.formatLeft(result.remainingMs) + " (edit its life to keep it)";
	},

	/** options.sigExpiry with one field changed, keeping the other (both Settings rows share the key) */
	withField: function(o, field, value) {
		const next = Object.assign({}, o && o.sigExpiry);
		next[field] = value;
		return next;
	},

	/** Current time (ms) corrected to the server's clock (sig-age.js), else the local clock */
	now: function() {
		return typeof sigAge !== "undefined" ? sigAge.now() : Date.now();
	},

	// ---- DOM ----

	CLASSES: "sig-expiry-soon sig-expiry-critical",

	/** Apply to every row of the signature table (cheap: rows are not rebuilt; a countdown is only replaced when
	its mode or end changes) */
	apply: function() {
		if (typeof tripwire === "undefined" || !tripwire.client) { return; }
		const signatures = tripwire.client.signatures || {};
		const now = sigExpiry.now();
		$("#sigTable tbody tr[data-id]").each(function() {
			const $cell = $(this).children("td.age-tooltip").first();
			if (!$cell.length) { return; }
			const sig = signatures[$(this).attr("data-id")];
			sigExpiry.decorate($cell, sig, sig ? sigExpiry.active(sig, now) : null);
		});
	},

	/** Set the cell's class, its countdown and its tooltip line */
	decorate: function($cell, sig, result) {
		const state = result ? result.state : null;
		$cell.toggleClass("sig-expiry-soon", state === "soon").toggleClass("sig-expiry-critical", state === "critical");
		if (typeof sigAge !== "undefined") { sigAge.setNote($cell, "expiry", sigExpiry.note(result)); }
		const $span = $cell.find("span[data-age]").first();
		if (!$span.length || !sig || typeof $span.countdown !== "function") { return; }
		// Upstream counts the age up (since: lifeTime); a site near its end counts down to lifeLeft instead
		const want = state ? "until " + sig.lifeLeft : null;
		const applied = $span.data("sigExpiryMode") || null;
		if (want === applied) { return; }
		const sync = { compact: true, format: tripwire.ageFormat, serverSync: tripwire.serverTime.getTime };
		$span.countdown("destroy");
		if (want) {
			$span.countdown(Object.assign({ until: moment.utc(sig.lifeLeft).toDate() }, sync));
			$span.data("sigExpiryMode", want);
		} else {
			$span.countdown(Object.assign({ since: moment.utc(sig.lifeTime).toDate() }, sync));
			$span.removeData("sigExpiryMode");
		}
	},

	scheduled: null,
	/** Re-apply soon (coalesces bursts of row inserts during a refresh) */
	schedule: function() {
		if (sigExpiry.scheduled) { return; }
		sigExpiry.scheduled = setTimeout(function() { sigExpiry.scheduled = null; sigExpiry.apply(); }, 50);
	},

	// ---- Add dialog ----

	/** When the Add dialog's type switches between a site and a wormhole, switch a default life to the new kind's */
	setupDialog: function() {
		// On document, so it runs after upstream's own handler on #dialog-signature
		$(document).on("selectmenuchange", "#dialog-signature [name='signatureType']", function() {
			if (typeof sigDialogVM === "undefined" || sigDialogVM.mode !== "add") { return; }	// edits keep their life
			const $picker = $("#dialog-signature #durationPicker");
			const next = sigExpiry.lifeAfterTypeChange($picker.val(), this.value, options);
			if (next !== null) { $picker.val(next).change(); }
		});
	},

	// ---- Settings ----

	setupSettings: function() {
		// Settings > Signatures rows; take effect on Save (Reset = defaults). Both rows live in options.sigExpiry,
		// so each keeps the other's field.
		forkSettings.register({
			section: "signatures", order: 25, id: "sigExpiry-siteLife", type: "select", key: "sigExpiry",
			label: "Site default life:",
			hint: "Combat, data, relic, gas, ore and unknown sigs, when pasted or added. Wormholes keep the paste default above, or their type's life. Sigs you already have keep their life.",
			choices: sigExpiry.SITE_LIFE_CHOICES.map(function(c) { return [String(c[0]), c[1]]; }),
			get: function(o) {
				const h = sigExpiry.siteLifeHours(o);
				const known = sigExpiry.SITE_LIFE_CHOICES.some(function(c) { return c[0] === h; });
				return String(known ? h : sigExpiry.DEFAULT_SITE_LIFE_H);
			},
			set: function(o, value) {
				const h = parseInt(value);
				o.sigExpiry = sigExpiry.withField(o, "siteLife", h > 0 ? h : sigExpiry.DEFAULT_SITE_LIFE_H);
			}
		});
		forkSettings.register({
			section: "signatures", order: 45, id: "sigExpiry-enabled", type: "checkbox", key: "sigExpiry",
			label: "Site expiry countdown:", text: "Count down and colour sites in their last 24 h (red under 4 h)",
			get: function(o) { return sigExpiry.enabled(o); },
			set: function(o, on) { o.sigExpiry = sigExpiry.withField(o, "enabled", !!on); }
		});
		// options.apply() runs on Save and Reset
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.sigExpiryWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				sigExpiry.schedule();
				return result;
			};
			options.apply.sigExpiryWrapped = true;
		}
	},

	init: function() {
		sigExpiry.setupSettings();
		sigExpiry.setupDialog();
		// Rows are added, replaced (edits rebuild the row and its countdown) and emptied by upstream: re-apply
		// after any of that. Only the row list is watched, not the ticking countdowns.
		const tbody = document.querySelector("#sigTable > tbody");
		if (tbody && typeof MutationObserver !== "undefined") {
			new MutationObserver(sigExpiry.schedule).observe(tbody, { childList: true });
		}
		setInterval(sigExpiry.apply, sigExpiry.TICK_MS);
		sigExpiry.schedule();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { sigExpiry.init(); });
}
