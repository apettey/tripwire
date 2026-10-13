const lifeStates = {
	// Wormhole life states (fork-owned): Stable | <4h | <1h | Expired instead of just Stable | EOL, like the game's
	// Wormhole Information since the Catalyst update ("Reliable lifetime", "less than 4 hours", "less than 1 hour",
	// "Expired"). No schema change: wormholes.life stays 'stable' | 'critical' and the three critical states live in
	// the holes' signature timer (lifeLeft), which upstream already counts down for EOL holes:
	//   stable  - life 'stable' (the timer is upstream's)
	//   lt4h    - life 'critical', 1 h < time left <= 4 h (also: critical with more time left, or no timer known)
	//   lt1h    - life 'critical', 0 < time left <= 1 h
	//   expired - life 'critical', time left <= 0 (the countdown goes negative; the server's wormholeClean event deletes
	//             the hole 10 % of its life length after that, e.g. 1.6 h for a 16 h hole)
	// Picking a critical state keeps the timer when it is already inside the state's band, else sets it to the band's
	// top (now + 4 h, now + 1 h, now), on both signatures of the hole. So states move on by themselves, as in game.
	// Setting: options.lifeStates.enabled (missing = on); off = upstream's Stable / EOL.
	// Keep `const lifeStates` on the first line: the test helper strips it to define a global.

	HOUR: 3600000,

	STATES: [
		{ key: "stable", label: "Stable", life: "stable", cls: "stable", keys: ["stable", "reliable"] },
		{ key: "lt4h", label: "<4h", life: "critical", cls: "critical life-lt4h", top: 4, keys: ["eol", "4h", "lt4h", "critical"] },
		{ key: "lt1h", label: "<1h", life: "critical", cls: "critical life-lt1h", top: 1, keys: ["1h", "lt1h"] },
		{ key: "expired", label: "Expired", life: "critical", cls: "critical life-expired", top: 0, keys: ["expired", "closing"] }
	],

	CLASSES: "life-lt4h life-lt1h life-expired",

	// ---- Pure logic (unit-tested) ----

	/** Whether the feature is switched on in the given user options (on unless explicitly false) */
	enabled: function(o) {
		return !(o && o.lifeStates && o.lifeStates.enabled === false);
	},

	/** On for the page: the user's options say so (false while options are not loaded, e.g. in tests) */
	isOn: function() {
		return typeof options !== "undefined" && !!options && lifeStates.enabled(options);
	},

	state: function(key) {
		return lifeStates.STATES.filter(function(s) { return s.key === key; })[0] || null;
	},

	/** Time (ms) from a signature time string. Strings without a zone are UTC wall-clock ("2026-10-13 12:00:00"),
	the way the sig list reads them (moment.utc). NaN when unreadable. */
	parseTime: function(s) {
		if (s === undefined || s === null || s === "") { return NaN; }
		if (typeof s === "number") { return s; }
		if (s instanceof Date) { return s.getTime(); }
		const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?\s*(.*)$/.exec(String(s).trim());
		if (!m) { return NaN; }
		if (m[7] && m[7] !== "Z" && m[7] !== "UTC") {
			return Date.parse(m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + (m[6] || "00") + m[7].replace(/^([+-]\d\d)(\d\d)$/, "$1:$2"));
		}
		return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
	},

	/** "YYYY-MM-DD HH:mm:ss" UTC wall-clock, the format the server stores and the sig list reads */
	formatTime: function(ms) {
		const d = new Date(Math.floor(ms / 1000) * 1000);
		const p = function(n) { return (n < 10 ? "0" : "") + n; };
		return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
	},

	/** Time left (ms, negative once past) on a signature's timer, or null when it has none: no signature, an
	unreadable time, or a "never expires" signature (lifeLength 0) whose timer was never set (the server then stores
	lifeLeft = lifeTime exactly; a timer set to Expired is a second before "now", so it never equals lifeTime) */
	remaining: function(sig, now) {
		if (!sig) { return null; }
		const left = lifeStates.parseTime(sig.lifeLeft);
		if (isNaN(left)) { return null; }
		if (Number(sig.lifeLength) === 0) {
			const start = lifeStates.parseTime(sig.lifeTime);
			if (isNaN(start) || left === start) { return null; }
		}
		return left - now;
	},

	/** Time left on a hole: the shorter of its two signatures' timers (null when neither has one) */
	holeRemaining: function(sigs, now) {
		let out = null;
		(sigs || []).forEach(function(s) {
			const r = lifeStates.remaining(s, now);
			if (r !== null && (out === null || r < out)) { out = r; }
		});
		return out;
	},

	/** State key from the hole's life and time left */
	derive: function(life, remaining) {
		if (life !== "critical") { return "stable"; }
		if (remaining === null || remaining === undefined || remaining > lifeStates.HOUR) { return "lt4h"; }
		if (remaining > 0) { return "lt1h"; }
		return "expired";
	},

	/** State of a wormhole (tripwire.client.wormholes entry) given its signatures */
	deriveHole: function(wormhole, sigs, now) {
		if (!wormhole) { return null; }
		return lifeStates.derive(wormhole.life, lifeStates.holeRemaining(sigs, now));
	},

	/** Whether a time left lies inside a critical state's band */
	inBand: function(key, remaining) {
		if (remaining === null || remaining === undefined) { return false; }
		const H = lifeStates.HOUR;
		if (key === "lt4h") { return remaining > H && remaining <= 4 * H; }
		if (key === "lt1h") { return remaining > 0 && remaining <= H; }
		if (key === "expired") { return remaining <= 0; }
		return false;
	},

	/** Timer end (ms) for picking a state: kept when already inside the band, else the band's top (Expired: a second
	ago, so it can't equal a new signature's lifeTime, see remaining). null for stable (the server puts back the
	natural timer) or an unknown state. */
	targetLifeLeft: function(key, remaining, now) {
		const s = lifeStates.state(key);
		if (!s || s.life !== "critical") { return null; }
		if (lifeStates.inBand(key, remaining)) { return now + remaining; }
		return s.top ? now + s.top * lifeStates.HOUR : now - 1000;
	},

	/** Refresh payload for setting a hole's state from the sig list / command palette: the wormhole's life and,
	for critical states, the new timer on both signatures (sent with the life change, so the server keeps it).
	Null when the state is unknown or the hole is already in it. */
	payload: function(wormhole, sig1, sig2, key, now) {
		const s = lifeStates.state(key);
		if (!wormhole || !s) { return null; }
		const remaining = lifeStates.holeRemaining([sig1, sig2], now);
		if (lifeStates.derive(wormhole.life, remaining) === key) { return null; }
		const a = { id: wormhole.initialID }, b = { id: wormhole.secondaryID };
		const target = lifeStates.targetLifeLeft(key, remaining, now);
		if (target !== null) { a.lifeLeft = b.lifeLeft = lifeStates.formatTime(target); }
		return { signatures: { update: [{ wormhole: { id: wormhole.id, life: s.life }, signatures: [a, b] }] } };
	},

	/** Give the dialog's payload the picked state's timer. entry: the {wormhole, signatures} entry of the payload;
	key: the picked state; current: the hole's current signatures (none for a new hole); unchanged: the state is the
	one the dialog opened with, so each signature keeps its current timer (the state may have moved on while the
	dialog was open: that must not reset it). The dialog sends lifeLength, which would recompute the timer. */
	applyToEntry: function(entry, key, current, now, unchanged) {
		if (!entry || !entry.wormhole || typeof entry.wormhole !== "object" || entry.wormhole.life !== "critical") { return false; }
		const s = lifeStates.state(key);
		if (!s || s.life !== "critical") { return false; }
		const set = function(sig, value) {
			delete sig.lifeLeft;
			sig.lifeLeft = value;	// after lifeLength: the server applies the keys in order
		};
		if (unchanged) {
			const byId = {};
			(current || []).forEach(function(c) { if (c && c.id !== undefined) { byId[c.id] = c; } });
			(entry.signatures || []).forEach(function(sig) {
				const c = sig && byId[sig.id];
				if (c && c.lifeLeft) { set(sig, c.lifeLeft); }
			});
			return true;
		}
		const target = lifeStates.targetLifeLeft(key, lifeStates.holeRemaining(current, now), now);
		if (target === null) { return false; }
		(entry.signatures || []).forEach(function(sig) { if (sig) { set(sig, lifeStates.formatTime(target)); } });
		return true;
	},

	/** The server applies a signature's keys in order and lifeLength recomputes lifeLeft. A full signature (undo,
	redo) lists lifeLeft before lifeLength, so its timer would be lost: move lifeLeft after lifeLength. */
	lifeLeftLast: function(sig) {
		if (!sig || typeof sig !== "object" || !("lifeLeft" in sig) || !("lifeLength" in sig)) { return sig; }
		const keys = Object.keys(sig);
		if (keys.indexOf("lifeLeft") > keys.indexOf("lifeLength")) { return sig; }
		const v = sig.lifeLeft;
		delete sig.lifeLeft;
		sig.lifeLeft = v;
		return sig;
	},

	/** lifeLeftLast for every signature of a refresh payload's add / update lists */
	orderPayload: function(data) {
		const lists = data && data.signatures;
		if (!lists || typeof lists !== "object") { return data; }
		["add", "update"].forEach(function(k) {
			(Array.isArray(lists[k]) ? lists[k] : []).forEach(function(item) {
				if (item && Array.isArray(item.signatures)) { item.signatures.forEach(lifeStates.lifeLeftLast); }
				else { lifeStates.lifeLeftLast(item); }
			});
		});
		return data;
	},

	/** Text for the sig list's Life cell */
	label: function(key) {
		const s = lifeStates.state(key);
		return s ? s.label : key;
	},

	// ---- Page ----

	/** Server-corrected now (the sig list's countdowns use the server clock) */
	now: function() {
		if (typeof sigAge !== "undefined" && sigAge.now) { return sigAge.now(); }
		return Date.now();
	},

	/** The current signatures of a wormhole */
	sigsOf: function(wormhole) {
		const sigs = (typeof tripwire !== "undefined" && tripwire.client && tripwire.client.signatures) || {};
		return wormhole ? [sigs[wormhole.initialID], sigs[wormhole.secondaryID]] : [];
	},

	/** State of a client wormhole now */
	current: function(wormhole) {
		return lifeStates.deriveHole(wormhole, lifeStates.sigsOf(wormhole), lifeStates.now());
	},

	// Signature dialog: the radios after upstream's Stable / EOL (EOL becomes "<4h")
	EXTRA_RADIOS: [{ id: "wormholeLifeLt1h", key: "lt1h" }, { id: "wormholeLifeExpired", key: "expired" }],

	setupDialog: function() {
		const eol = document.getElementById("wormholeLifeEOL");
		if (!eol || document.getElementById("wormholeLifeLt1h")) { return; }
		eol.setAttribute("data-life-state", "lt4h");
		document.getElementById("wormholeLifeStable").setAttribute("data-life-state", "stable");
		let after = document.querySelector("label[for='wormholeLifeEOL']");
		lifeStates.EXTRA_RADIOS.forEach(function(r) {
			const s = lifeStates.state(r.key);
			const input = document.createElement("input");
			input.type = "radio";
			input.className = "mini-selector life-state-extra";
			input.name = "wormholeLife";
			input.id = r.id;
			input.value = "critical";	// the wormhole's life; the state is in data-life-state
			input.setAttribute("data-life-state", r.key);
			const label = document.createElement("label");
			label.setAttribute("for", r.id);
			label.className = s.cls + " life-state-extra";
			label.textContent = s.label;
			// The same whitespace between the elements as upstream's markup (the labels' spacing depends on it)
			const parent = after.parentNode;
			[document.createTextNode(" "), input, document.createTextNode(" "), label].forEach(function(el) {
				parent.insertBefore(el, after.nextSibling);
				after = el;
			});
		});
		lifeStates.syncDialog();
	},

	/** Four buttons when on, upstream's two (Stable / EOL) when off */
	syncDialog: function() {
		const on = lifeStates.isOn();
		const eolLabel = document.querySelector("label[for='wormholeLifeEOL']");
		if (!eolLabel) { return; }
		eolLabel.textContent = on ? lifeStates.label("lt4h") : "EOL";
		eolLabel.classList.toggle("life-lt4h", on);
		Array.prototype.forEach.call(document.querySelectorAll("#dialog-signature .life-state-extra"), function(el) {
			el.style.display = on ? "" : "none";
			if (!on && el.tagName === "INPUT" && el.checked) { document.getElementById("wormholeLifeEOL").checked = true; }
		});
		if (typeof lifeWording !== "undefined") { lifeWording.apply(); }
	},

	/** Called from the signature dialog's open (after upstream checked a radio): check the hole's state */
	dialogPrefill: function(wormhole) {
		if (!wormhole) { return; }
		const key = wormhole.life === "critical" ? (lifeStates.isOn() ? lifeStates.current(wormhole) : "lt4h") : "stable";
		const input = document.querySelector("#dialog-signature [name='wormholeLife'][data-life-state='" + key + "']");
		if (input) { input.checked = true; }
		lifeStates.prefilled = { wormholeID: String(wormhole.id), key: key };
	},

	prefilled: null,	// {wormholeID, key}: the state the dialog opened with (dialogPrefill)

	/** Called from the signature dialog's submit with the payload it built: add the picked state's timer */
	dialogPayload: function(payload) {
		if (!lifeStates.isOn() || !payload || !payload.signatures) { return; }
		const entry = (payload.signatures.update || payload.signatures.add || [])[0];
		if (!entry || !entry.wormhole || typeof entry.wormhole !== "object") { return; }
		const checked = document.querySelector("#dialog-signature [name='wormholeLife']:checked");
		const key = checked && checked.getAttribute("data-life-state");
		if (!key) { return; }
		const sigs = (typeof tripwire !== "undefined" && tripwire.client && tripwire.client.signatures) || {};
		const current = (entry.signatures || []).map(function(s) { return s && s.id ? sigs[s.id] : null; }).filter(Boolean);
		const p = lifeStates.prefilled;
		const unchanged = !!(p && entry.wormhole.id !== undefined && String(entry.wormhole.id) === p.wormholeID && p.key === key);
		lifeStates.applyToEntry(entry, key, current, lifeStates.now(), unchanged);
	},

	/** Life cells of the sig list (and the automapper's picker): text and colour for the hole's state now */
	refreshCells: function() {
		const on = lifeStates.isOn();
		const wormholes = (typeof tripwire !== "undefined" && tripwire.client && tripwire.client.wormholes) || {};
		const bySig = {};
		Object.keys(wormholes).forEach(function(k) {
			const wh = wormholes[k];
			bySig[wh.initialID] = wh;
			bySig[wh.secondaryID] = wh;
		});
		let changed = false;
		Array.prototype.forEach.call(document.querySelectorAll("#sigTable tbody tr[data-id]"), function(tr) {
			const wh = bySig[tr.getAttribute("data-id")];
			const cell = tr.children[4];
			if (!wh || !cell || cell.classList.contains("sig-inline-saving") || cell.getAttribute("colspan")) { return; }
			const key = on ? lifeStates.current(wh) : null;
			const text = key ? lifeStates.label(key) : ({ critical: "EOL", stable: "Stable" }[wh.life] || wh.life);
			if (cell.textContent !== text) { cell.textContent = text; changed = true; }
			lifeStates.CLASSES.split(" ").forEach(function(c) { cell.classList.toggle(c, !!key && key !== "stable" && c === "life-" + key); });
		});
		// The table sorter caches the cell texts: sorting by Life must see the new ones
		if (changed && typeof $ !== "undefined") { $("#sigTable").trigger("update"); }
	},

	setupSettings: function() {
		if (typeof forkSettings === "undefined") { return; }
		// Settings > Signatures row; takes effect on Save (Reset = on)
		forkSettings.register({
			section: "signatures", order: 35, id: "lifeStates-enabled", type: "checkbox", key: "lifeStates",
			label: "Wormhole life states:", text: "Stable, <4h, <1h and Expired, as in game (off: Stable and EOL only)",
			get: function(o) { return lifeStates.enabled(o); },
			set: function(o, on) { o.lifeStates = { enabled: on }; }
		});
		// options.apply() runs on Save and Reset
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.lifeStatesWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				lifeStates.syncDialog();
				lifeStates.refreshCells();
				return result;
			};
			options.apply.lifeStatesWrapped = true;
		}
	},

	init: function() {
		lifeStates.setupSettings();
		lifeStates.setupDialog();
		// Life text of every hole row (sig list, automapper picker): the state rather than plain EOL
		if (typeof tripwire !== "undefined" && typeof tripwire.makeSigInfo === "function" && !tripwire.makeSigInfo.lifeStatesWrapped) {
			const makeSigInfo = tripwire.makeSigInfo;
			tripwire.makeSigInfo = function(sig, wormhole) {
				const info = makeSigInfo.apply(this, arguments);
				if (info && info.wormhole && lifeStates.isOn()) { info.lifeText = lifeStates.label(lifeStates.current(info.wormhole)); }
				return info;
			};
			tripwire.makeSigInfo.lifeStatesWrapped = true;
		}
		// Undo / redo send whole signatures: keep their timers (see lifeLeftLast)
		if (typeof tripwire !== "undefined" && typeof tripwire.refresh === "function" && !tripwire.refresh.lifeStatesWrapped) {
			const refresh = tripwire.refresh;
			tripwire.refresh = function(mode, data) {
				try { lifeStates.orderPayload(data); } catch (e) { /* leave the payload as it is */ }
				return refresh.apply(this, arguments);
			};
			tripwire.refresh.lifeStatesWrapped = true;
		}
		// Rows are re-rendered on every change; states also move on with time
		const tbody = document.querySelector("#sigTable > tbody");
		if (tbody && typeof MutationObserver !== "undefined") {
			new MutationObserver(function() { lifeStates.refreshCells(); }).observe(tbody, { childList: true });
		}
		setInterval(lifeStates.refreshCells, 15000);
		lifeStates.refreshCells();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { lifeStates.init(); });
}
