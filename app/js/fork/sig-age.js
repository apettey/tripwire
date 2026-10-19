const sigAge = {
	// Signature age colouring (fork-owned): tints the Age cell of signatures nobody has updated for a while,
	// so scanners can see at a glance which sigs need re-scanning.
	// Age is "time since the sig last changed": its modifiedTime (set when it is created, edited, or a paste
	// adds new info such as a type or name). Re-pasting a sig that is already fully known sends nothing to the
	// server, so it does not refresh the age.
	// Setting: options.sigAge.enabled (missing = on). Keep `const sigAge` on the first line: the test helper
	// strips it to define a global.

	HOUR_MS: 3600000,
	TICK_MS: 60000,

	/** Hours after the last change at which a sig counts as aging / stale */
	thresholds: {
		// Sites (combat, data, relic, gas, ore, unknown) last days in the game; their default life is 7 days
		// (sig-expiry.js), which counts them down in their last 24 h
		signature: { aging: 24, stale: 72 },
		// Holes live 16-48 h and go EOL 4 h before they die; one nobody has looked at for 12 h may have gone EOL
		// unnoticed. Holes already marked EOL are left alone: their red countdown says more.
		wormhole: { aging: 12, stale: 24 }
	},

	/** Milliseconds since the epoch for a server time 'YYYY-MM-DD HH:mm:ss' (UTC), or NaN */
	parseServerTime: function(text) {
		const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text || ''));
		if (!m) { return NaN; }
		return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
	},

	/** When the sig last changed (ms): the later of modifiedTime and lifeTime, or NaN if neither is known */
	lastChange: function(sig) {
		if (!sig) { return NaN; }
		const modified = sigAge.parseServerTime(sig.modifiedTime);
		const created = sigAge.parseServerTime(sig.lifeTime);
		if (isNaN(modified)) { return created; }
		if (isNaN(created)) { return modified; }
		return Math.max(modified, created);
	},

	/** Age level of a signature.
	@param sig the signature (tripwire.client.signatures entry)
	@param wormhole its wormhole (tripwire.client.wormholes entry) if it is a wormhole sig, else undefined
	@param now current time in ms
	@param thresholds optional override of sigAge.thresholds
	@return { level: 'fresh'|'aging'|'stale', ageMs } or null when the sig isn't coloured */
	levelFor: function(sig, wormhole, now, thresholds) {
		if (!sig) { return null; }
		if (parseInt(sig.lifeLength) === 0) { return null; }	// never expires (e.g. gates)
		const isWormhole = sig.type === 'wormhole';
		if (isWormhole && wormhole) {
			if (wormhole.life === 'critical') { return null; }	// EOL: upstream's countdown already covers it
			if (wormhole.type === 'GATE') { return null; }
		}
		const changed = sigAge.lastChange(sig);
		if (isNaN(changed)) { return null; }
		const t = (thresholds || sigAge.thresholds)[isWormhole ? 'wormhole' : 'signature'];
		const ageMs = Math.max(0, now - changed);
		const hours = ageMs / sigAge.HOUR_MS;
		const level = hours >= t.stale ? 'stale' : hours >= t.aging ? 'aging' : 'fresh';
		return { level: level, ageMs: ageMs };
	},

	/** Short duration: '40 min', '5 h', '5.5 h' under 10 h, '2 d 3 h' from 48 h */
	formatAge: function(ageMs) {
		const minutes = Math.floor(ageMs / 60000);
		if (minutes < 60) { return Math.max(minutes, 0) + ' min'; }
		const hours = ageMs / sigAge.HOUR_MS;
		if (hours < 10) {
			const half = Math.floor(hours * 2) / 2;
			return (half % 1 ? half.toFixed(1) : half) + ' h';
		}
		if (hours < 48) { return Math.floor(hours) + ' h'; }
		const days = Math.floor(hours / 24), rest = Math.floor(hours - days * 24);
		return days + ' d' + (rest ? ' ' + rest + ' h' : '');
	},

	/** Tooltip line for a level from levelFor, or '' for fresh/none */
	note: function(result) {
		if (!result || result.level === 'fresh') { return ''; }
		return (result.level === 'stale' ? 'Stale: ' : 'Aging: ') + 'not updated for ' + sigAge.formatAge(result.ageMs);
	},

	/** Clock offset from the server, like the Age column's countdowns (serverSync): the PC clock may be off by hours.
	serverMs: the last server time seen; offset: server minus local time when it was first seen */
	clock: { serverMs: null, offset: 0 },

	/** Current time (ms) corrected to the server's clock.
	@param serverTime the server time from the last sync (a Date or ms; tripwire.serverTime.getTime()), or undefined
	@param localNow the local Date.now()
	@param clock state kept between calls (sigAge.clock) */
	serverNow: function(serverTime, localNow, clock) {
		const serverMs = serverTime instanceof Date ? serverTime.getTime() : Number(serverTime);
		if (serverTime === undefined || serverTime === null || isNaN(serverMs) || !serverMs) {
			return clock && clock.serverMs !== null ? localNow + clock.offset : localNow;
		}
		if (clock.serverMs !== serverMs) {	// a new sync: re-measure the offset
			clock.serverMs = serverMs;
			clock.offset = serverMs - localNow;
		}
		return localNow + clock.offset;
	},

	/** Server-corrected now for the page, falling back to the local clock */
	now: function() {
		let serverTime;
		try {
			if (typeof tripwire !== 'undefined' && tripwire.serverTime && typeof tripwire.serverTime.getTime === 'function') {
				serverTime = tripwire.serverTime.getTime();
			}
		} catch (e) { serverTime = undefined; }
		return sigAge.serverNow(serverTime, Date.now(), sigAge.clock);
	},

	/** Whether the feature is switched on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.sigAge && opts.sigAge.enabled === false);
	},

	// ---- DOM ----

	CLASSES: 'sig-age-aging sig-age-stale',

	/** The wormhole a signature belongs to, by signature id */
	wormholeIndex: function() {
		const index = {};
		const wormholes = (typeof tripwire !== 'undefined' && tripwire.client && tripwire.client.wormholes) || {};
		Object.keys(wormholes).forEach(function(k) {
			const wh = wormholes[k];
			if (!wh) { return; }
			index[wh.initialID] = wh;
			index[wh.secondaryID] = wh;
		});
		return index;
	},

	/** Colour every row of the signature table (cheap: only classes and tooltips change, rows are not rebuilt) */
	apply: function() {
		if (typeof tripwire === 'undefined' || !tripwire.client) { return; }
		const on = sigAge.enabled(typeof options !== 'undefined' ? options : undefined);
		const signatures = tripwire.client.signatures || {};
		const wormholes = on ? sigAge.wormholeIndex() : {};
		const now = sigAge.now();
		$('#sigTable tbody tr[data-id]').each(function() {
			const $cell = $(this).children('td.age-tooltip').first();
			if (!$cell.length) { return; }
			const id = $(this).attr('data-id');
			// A site counting down to its expiry (sig-expiry.js) shows that instead of its age
			const expiring = typeof sigExpiry !== "undefined" && sigExpiry.active(signatures[id], now);
			const result = on && !expiring ? sigAge.levelFor(signatures[id], wormholes[id], now) : null;
			sigAge.decorate($cell, result);
		});
	},

	/** Set the cell's class and add (or remove) the age line in its tooltip */
	decorate: function($cell, result) {
		const level = result && result.level !== 'fresh' ? result.level : null;
		$cell.toggleClass('sig-age-aging', level === 'aging').toggleClass('sig-age-stale', level === 'stale');

		sigAge.setNote($cell, 'age', sigAge.note(result));
	},

	/** Order of the fork's lines in the Age tooltip (sig-expiry.js adds 'expiry') */
	NOTE_KEYS: ['expiry', 'age'],

	/** Upstream's tooltip (a <table> of Created / Last Modified) with our lines appended as rows.
	@param base upstream's tooltip markup
	@param notes [{text, cls}] in display order; empty texts are skipped (texts are our own, not user input) */
	composeTooltip: function(base, notes) {
		const rows = (notes || []).filter(function(n) { return n && n.text; });
		if (!rows.length) { return base; }
		if (base.indexOf('</table>') < 0) { return base + rows.map(function(n) { return n.text; }).join(' '); }
		const html = rows.map(function(n) {
			return "<tr><td colspan=\"3\" class=\"" + n.cls + "\">" + n.text + "</td></tr>";
		}).join('');
		return base.replace('</table>', html + '</table>');
	},

	/** Set one feature's line in the Age cell's tooltip, keeping upstream's tooltip and the other features' lines.
	@param key 'age' or 'expiry'; text '' removes the line */
	setNote: function($cell, key, text) {
		let base = $cell.data('sigAgeBase');
		if (base === undefined) {
			base = $cell.attr('data-tooltip') || '';
			$cell.data('sigAgeBase', base);
		}
		const notes = Object.assign({}, $cell.data('sigAgeNotes'));
		notes[key] = text || '';
		$cell.data('sigAgeNotes', notes);
		const tooltip = sigAge.composeTooltip(base, sigAge.NOTE_KEYS.map(function(k) {
			return { text: notes[k], cls: k === 'age' ? 'sig-age-note' : 'sig-' + k + '-note' };
		}));
		if ($cell.attr('data-tooltip') !== tooltip) { $cell.attr('data-tooltip', tooltip); }
	},

	scheduled: null,
	/** Re-colour soon (coalesces bursts of row inserts during a refresh) */
	schedule: function() {
		if (sigAge.scheduled) { return; }
		sigAge.scheduled = setTimeout(function() { sigAge.scheduled = null; sigAge.apply(); }, 50);
	},

	// ---- Settings ----

	setupSettings: function() {
		// Settings > Signatures row; takes effect on Save (Reset = on)
		forkSettings.register({
			section: "signatures", order: 40, id: "sigAge-enabled", type: "checkbox", key: "sigAge",
			label: "Colour signatures by age:", text: "Tint sigs not updated for 24 h (holes 12 h) and 72 h (holes 24 h)",
			get: function(o) { return sigAge.enabled(o); },
			set: function(o, on) { o.sigAge = { enabled: on }; }
		});
		// options.apply() runs on Save and Reset
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.sigAgeWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				sigAge.schedule();
				return result;
			};
			options.apply.sigAgeWrapped = true;
		}
	},

	init: function() {
		sigAge.setupSettings();
		// Rows are added, replaced (edits) and emptied (system change) by upstream: re-colour after any of that.
		// Only the row list is watched (not the subtree, where the age countdowns tick every second), so neither
		// the countdowns nor our own class/attribute updates trigger it.
		const tbody = document.querySelector("#sigTable > tbody");
		if (tbody && typeof MutationObserver !== "undefined") {
			new MutationObserver(sigAge.schedule).observe(tbody, { childList: true });
		}
		setInterval(sigAge.apply, sigAge.TICK_MS);
		sigAge.schedule();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { sigAge.init(); });
}
