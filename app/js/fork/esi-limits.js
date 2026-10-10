const esiLimits = {
	// Fork: ESI compatibility date and rate-limit handling for the browser's ESI calls (app/js/tripwire/esi.js,
	// which calls https://esi.evetech.net directly). Server side: esi/esi.inc.php (keep both dates equal).
	//
	// - Every ESI request gets compatibility_date=<date> as a query parameter (ESI's documented alternative to
	//   the X-Compatibility-Date header). A custom header would turn upstream's simple GETs, which pass the token
	//   in the query string on purpose, into CORS-preflighted requests.
	// - ESI's rate-limit headers are read centrally from every response. A 429 on a character's route pauses
	//   that character's location / ship / online polling until Retry-After; a 420 (legacy error limit) or an
	//   almost used-up error budget pauses all polling (and the TQ status poll) until X-ESI-Error-Limit-Reset.
	//   Each pause is logged once to the console. Otherwise upstream's polling is unchanged.
	COMPATIBILITY_DATE: "2025-12-16",
	ERROR_LIMIT_FLOOR: 10,  // pause when fewer errors than this are left in the error window
	DEFAULT_PAUSE: 60,      // seconds, when ESI doesn't say how long
	MAX_PAUSE: 900,         // seconds; ESI's rate-limit window is 15 minutes
	ALL: "*",               // pause key for everything (error limit)

	pauses: {},             // key ("*", "char:<id>", "status") => paused until (ms)

	isEsiUrl: function(url) {
		return /^https:\/\/esi\.evetech\.net\//i.test(String(url || ""));
	},

	/** The URL with compatibility_date added, unless it already has one */
	withCompatibilityDate: function(url, date) {
		url = String(url);
		if (/[?&]compatibility_date=/.test(url)) return url;
		const hash = url.indexOf("#");
		const base = hash < 0 ? url : url.slice(0, hash);
		const fragment = hash < 0 ? "" : url.slice(hash);
		const separator = base.indexOf("?") < 0 ? "?" : (/[?&]$/.test(base) ? "" : "&");
		return base + separator + "compatibility_date=" + encodeURIComponent(date || esiLimits.COMPATIBILITY_DATE) + fragment;
	},

	/** Character ID of an authenticated /characters/<id>/... request (its own rate-limit bucket), or null */
	characterOf: function(url, authenticated) {
		if (!authenticated) return null;
		const match = /^https:\/\/[^\/]+(\/[^?#]*)/i.exec(String(url || ""));
		const path = match ? match[1] : "";
		const id = /\/characters\/(\d+)(\/|$)/.exec(path);
		return id ? id[1] : null;
	},

	/** Whether a request carries an access token (token= query parameter or Authorization header) */
	isAuthenticated: function(url, headers) {
		if (/[?&]token=/.test(String(url || ""))) return true;
		return !!headers && Object.keys(headers).some(function(name) { return name.toLowerCase() === "authorization"; });
	},

	/** Seconds from a Retry-After value (delta seconds or HTTP date), or null */
	retryAfter: function(value, now) {
		if (value === null || value === undefined || value === "") return null;
		if (/^\s*\d+\s*$/.test(String(value))) return parseInt(value, 10);
		const time = Date.parse(value);
		return isNaN(time) ? null : Math.max(0, Math.ceil((time - now) / 1000));
	},

	clampPause: function(seconds) {
		return Math.max(1, Math.min(esiLimits.MAX_PAUSE, Math.ceil(seconds)));
	},

	/**
	 * Pure decision for one response: {key: seconds} of pauses to start.
	 * header(name) returns a response header or null.
	 */
	decide: function(url, status, header, authenticated, now) {
		const pauses = {};
		const add = function(key, seconds) {
			pauses[key] = Math.max(pauses[key] || 0, esiLimits.clampPause(seconds));
		};
		const number = function(name) {
			const value = header(name);
			return value !== null && value !== undefined && /^\s*\d+\s*$/.test(String(value)) ? parseInt(value, 10) : null;
		};
		const retryAfter = esiLimits.retryAfter(header("Retry-After"), now);
		const errorReset = number("X-ESI-Error-Limit-Reset");
		const errorRemain = number("X-ESI-Error-Limit-Remain");
		const characterID = esiLimits.characterOf(url, authenticated);

		if (status == 420) {
			add(esiLimits.ALL, retryAfter !== null ? retryAfter : (errorReset !== null ? errorReset + 1 : esiLimits.DEFAULT_PAUSE));
		} else if (status == 429) {
			const seconds = retryAfter !== null ? retryAfter : esiLimits.DEFAULT_PAUSE;
			if (characterID) add("char:" + characterID, seconds);
			else if (/^https:\/\/[^\/]+\/(v\d+\/|latest\/)?status\/?([?#]|$)/i.test(url)) add("status", seconds);
		}
		if (errorRemain !== null && errorRemain < esiLimits.ERROR_LIMIT_FLOOR) {
			add(esiLimits.ALL, errorReset !== null ? errorReset + 1 : esiLimits.DEFAULT_PAUSE);
		}
		return pauses;
	},

	/** Start the pauses ESI asked for; returns the keys that weren't paused before (logged once) */
	apply: function(pauses, now) {
		const started = {};
		Object.keys(pauses).forEach(function(key) {
			const previous = esiLimits.pauses[key] || 0;
			if (previous <= now) started[key] = pauses[key];
			esiLimits.pauses[key] = Math.max(previous, now + pauses[key] * 1000);
		});
		return started;
	},

	/** Record one ESI response; header(name) reads a response header */
	record: function(url, status, header, authenticated, now) {
		now = now || Date.now();
		const started = esiLimits.apply(esiLimits.decide(url, status, header, authenticated, now), now);
		Object.keys(started).forEach(function(key) {
			const what = key === esiLimits.ALL ? "all ESI polling" : key === "status" ? "the TQ status poll" : "polling of character " + key.slice(5);
			if (typeof console !== "undefined") console.warn("ESI HTTP " + status + ": pausing " + what + " for " + started[key] + " s");
		});
		return started;
	},

	/** Milliseconds a key (and the global pause) still has to wait */
	pausedFor: function(key, now) {
		now = now || Date.now();
		return Math.max(0, (esiLimits.pauses[esiLimits.ALL] || 0) - now, key ? (esiLimits.pauses[key] || 0) - now : 0);
	},

	isCharacterPaused: function(characterID, now) {
		return esiLimits.pausedFor("char:" + characterID, now) > 0;
	},

	/** A copy of the characters map without the paused ones */
	activeCharacters: function(characters, now) {
		const active = {};
		Object.keys(characters || {}).forEach(function(id) {
			if (!esiLimits.isCharacterPaused(id, now)) active[id] = characters[id];
		});
		return active;
	},

	/** Run a polling function (it loops over tripwire.esi.characters) with the paused characters left out */
	withoutPausedCharacters: function(esi, fn, self, args) {
		const all = esi.characters;
		esi.characters = esiLimits.activeCharacters(all);
		try {
			return fn.apply(self, args);
		} finally {
			// The polling loop only reads the map synchronously; its async callbacks look characters up again later.
			if (esi.characters !== all) {
				Object.keys(esi.characters).forEach(function(id) { all[id] = esi.characters[id]; });
				esi.characters = all;
			}
		}
	},

	/** Browser wiring: jQuery prefilter for every ESI request, and wrappers around upstream's pollers */
	install: function($, tripwire) {
		esiLimits.installPrefilter($);
		esiLimits.wrapPollers(tripwire);
	},

	installPrefilter: function($) {
		if (esiLimits.prefilterInstalled === $) return;
		esiLimits.prefilterInstalled = $;
		$.ajaxPrefilter(function(options, originalOptions, jqXHR) {
			if (!esiLimits.isEsiUrl(options.url)) return;
			const authenticated = esiLimits.isAuthenticated(options.url, options.headers);
			options.url = esiLimits.withCompatibilityDate(options.url);
			const url = options.url;
			jqXHR.always(function() {
				esiLimits.record(url, jqXHR.status, function(name) {
					try { return jqXHR.getResponseHeader(name); } catch (e) { return null; }
				}, authenticated);
			});
		});
	},

	wrapPollers: function(tripwire) {
		const esi = tripwire.esi;
		["location", "ship", "online"].forEach(function(name) {
			const poll = esi[name];
			if (typeof poll !== "function" || poll.esiLimitsWrapped) return;
			const wrapped = function() {
				return esiLimits.withoutPausedCharacters(tripwire.esi, poll, this, arguments);
			};
			wrapped.esiLimitsWrapped = true;
			esi[name] = wrapped;
		});

		// TQ status (every 15 s): skip a turn while paused, keep the timer going
		const serverStatus = tripwire.serverStatus;
		if (typeof serverStatus === "function" && !serverStatus.esiLimitsWrapped) {
			const wrappedStatus = function() {
				if (esiLimits.pausedFor("status") > 0) {
					clearTimeout(tripwire.serverStatus.timer);
					tripwire.serverStatus.timer = setTimeout("tripwire.serverStatus();", 15000);
					return;
				}
				return serverStatus.apply(this, arguments);
			};
			wrappedStatus.esiLimitsWrapped = true;
			wrappedStatus.data = serverStatus.data;
			wrappedStatus.timer = serverStatus.timer;
			tripwire.serverStatus = wrappedStatus;
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.ajaxPrefilter) {
	// The prefilter only needs jQuery. Upstream's pollers exist once app/js/tripwire/esi.js ran (normally before
	// this file in the bundle; if the bundle order differs, wrap them once the page is ready).
	esiLimits.installPrefilter(jQuery);
	if (typeof tripwire !== "undefined" && tripwire.esi && tripwire.esi.location) {
		esiLimits.wrapPollers(tripwire);
	} else {
		jQuery(function() { if (typeof tripwire !== "undefined" && tripwire.esi) esiLimits.wrapPollers(tripwire); });
	}
}
