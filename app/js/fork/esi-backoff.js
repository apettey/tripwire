const esiBackoff = {
	// Fork: per-character backoff, cache lifetimes and spreading for the browser's ESI polling of
	// /characters/<id>/location/, /ship/ and /online/ (app/js/tripwire/esi.js polls them every 5 s / 5 s / 60 s for every
	// linked character). All three share one ESI rate-limit bucket per character (char-location, 1200 tokens per 15 min;
	// a 2xx costs 2 tokens, a 4xx 5). esi-limits.js handles what ESI says outright (429 Retry-After, 420, low budgets);
	// this file handles what upstream's loop does on its own:
	// - 401/403 (token rejected): upstream kept polling every 5 s (and a 403 made it ask the server for the characters
	//   again, whose answer re-ran every poller at once, so a rejected token looped as fast as the network allowed).
	//   Now that route waits 30 s, then 120 s, and after the 3rd failure in a row it stops until the server hands over a
	//   different token (tokens are refreshed every ~20 min; one try per new token). The character's tracking card
	//   shows a small alert icon while it is stopped.
	// - 5xx, network errors and other 4xx: exponential backoff per route, 5 s doubling to 5 min, +-25% jitter.
	// - Cache lifetime: a route isn't asked again while ESI's Cache-Control max-age (Expires only when there is no
	//   max-age) says the last answer is still current, nor while a request for it is still out.
	// - Spreading: the requests of one poll go out spaced over up to 2 s (250 ms apart) instead of all at once.
	// Composes with esi-limits.js and esi-offline-skip.js, which wrap the same pollers (this file sorts first, so its
	// wrapper is the inner one). Keep `const esiBackoff` on the first line: the test helper strips it to define a global.

	ROUTES: ["location", "ship", "online"],
	AUTH_PAUSES: [30, 120],		// s after the 1st and 2nd 401/403 in a row; the next one stops the route
	AUTH_STOP_AFTER: 3,
	ERROR_BASE: 5,				// s after the first 5xx / network error / other 4xx, doubling
	ERROR_MAX: 300,				// s
	JITTER: 0.25,				// +-25% on every backoff
	CACHE_SLACK_MS: 3000,		// ask this much before the cache expires: a poll's requests go out up to 2 s late
	INFLIGHT_MS: 30000,			// a request older than this no longer blocks the next one
	STAGGER_STEP_MS: 250,
	STAGGER_MAX_MS: 2000,

	state: {},		// "<characterID>:<route>" -> {kind, failures, status, until, token, stopped, expires, inflight}

	// ---- Pure logic (tested under mocha) ----

	/** {id, route} of a character location / ship / online request, or null */
	routeOf: function(url) {
		const m = /^https:\/\/esi\.evetech\.net\/(?:v\d+\/|latest\/)?characters\/(\d+)\/(location|ship|online)\/?(?:[?#]|$)/i.exec(String(url || ""));
		return m ? { id: m[1], route: m[2].toLowerCase() } : null;
	},

	/** The access token of a request (token= query parameter), or "" */
	tokenOf: function(url) {
		const m = /[?&]token=([^&#]*)/.exec(String(url || ""));
		if (!m) { return ""; }
		try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { return m[1]; }
	},

	key: function(id, route) {
		return String(id) + ":" + route;
	},

	/** ok | auth | error | limited (esi-limits.js handles it) | ignore (aborted) */
	classify: function(status, textStatus) {
		status = Number(status) || 0;
		if (textStatus === "abort") { return "ignore"; }
		if (status === 429 || status === 420) { return "limited"; }
		if (status === 401 || status === 403) { return "auth"; }
		if (status >= 200 && status < 400 && textStatus !== "parsererror") { return "ok"; }
		return "error";
	},

	/** How long (ms) an answer stays current: Cache-Control max-age (less Age), else Expires; null if it doesn't say.
	 *  header(name) reads a response header. In the browser Date and Age aren't readable (not CORS-exposed by ESI), so
	 *  Expires is then measured against the local clock. */
	cacheMs: function(header, now) {
		const read = function(name) { try { const v = header(name); return v === null || v === undefined ? "" : String(v); } catch (e) { return ""; } };
		const cc = read("Cache-Control").toLowerCase();
		if (/(^|[\s,])(no-store|no-cache)([\s,=]|$)/.test(cc)) { return 0; }
		const maxAge = /(?:^|[\s,])max-age\s*=\s*"?(\d+)/.exec(cc);
		if (maxAge) {
			const age = /^\s*\d+\s*$/.test(read("Age")) ? parseInt(read("Age"), 10) : 0;
			return Math.max(0, parseInt(maxAge[1], 10) - age) * 1000;
		}
		if (!read("Expires")) { return null; }
		const expires = Date.parse(read("Expires"));
		if (isNaN(expires)) { return 0; }	// an invalid Expires means already expired (RFC 9111)
		const date = Date.parse(read("Date"));
		return Math.max(0, expires - (isNaN(date) ? now : date));
	},

	/** Seconds from a Retry-After value (delta seconds or HTTP date), or null */
	retryAfter: function(value, now) {
		if (value === null || value === undefined || value === "") { return null; }
		if (/^\s*\d+\s*$/.test(String(value))) { return parseInt(value, 10); }
		const t = Date.parse(value);
		return isNaN(t) ? null : Math.max(0, Math.ceil((t - now) / 1000));
	},

	/** rand in [0, 1) -> factor in [1 - JITTER, 1 + JITTER) */
	jitter: function(rand) {
		const r = typeof rand === "number" && rand >= 0 && rand < 1 ? rand : 0.5;
		return 1 - esiBackoff.JITTER + 2 * esiBackoff.JITTER * r;
	},

	/** Seconds to wait after the n-th error in a row (before jitter) */
	errorDelay: function(failures) {
		const n = Math.max(1, failures || 1);
		return Math.min(esiBackoff.ERROR_MAX, esiBackoff.ERROR_BASE * Math.pow(2, Math.min(n - 1, 20)));
	},

	/**
	 * The next state of one route after an answer. outcome: {kind, status, token, cacheMs}. Pure: returns a new object.
	 * A different kind of failure starts its count again; an ok clears everything (and stores the cache expiry).
	 */
	next: function(entry, outcome, now, rand) {
		const prev = entry || {};
		const o = outcome || {};
		if (o.kind === "ignore" || o.kind === "limited") {
			const same = Object.assign({}, prev);
			delete same.inflight;
			return same;
		}
		if (o.kind === "ok") {
			return { kind: "ok", failures: 0, expires: typeof o.cacheMs === "number" ? now + o.cacheMs : 0 };
		}
		const failures = (prev.kind === o.kind ? prev.failures || 0 : 0) + 1;
		const out = { kind: o.kind, failures: failures, status: Number(o.status) || 0, token: o.token || "" };
		if (o.kind === "auth" && failures >= esiBackoff.AUTH_STOP_AFTER) {
			out.stopped = true;
			return out;
		}
		const seconds = o.kind === "auth" ? esiBackoff.AUTH_PAUSES[failures - 1] : esiBackoff.errorDelay(failures);
		out.until = now + Math.round(seconds * 1000 * esiBackoff.jitter(rand));
		// A Retry-After on the error (a 503, say) is a minimum, capped like esi-limits.js caps its pauses (15 min)
		if (typeof o.retryAfter === "number" && o.retryAfter > 0) { out.until = Math.max(out.until, now + Math.min(o.retryAfter, 900) * 1000); }
		return out;
	},

	/** May this route be asked now? token: the character's current access token */
	due: function(entry, token, now) {
		if (!entry) { return true; }
		if (entry.inflight && now - entry.inflight < esiBackoff.INFLIGHT_MS) { return false; }
		if (entry.stopped) { return String(token || "") !== String(entry.token || ""); }
		if (entry.until && entry.until > now) { return false; }
		if (entry.expires && entry.expires - now > esiBackoff.CACHE_SLACK_MS) { return false; }
		return true;
	},

	/** Delay (ms) of the k-th of n requests of one poll */
	staggerOffset: function(k, n, rand) {
		if (n <= 1 || k <= 0) { return 0; }
		const step = Math.min(esiBackoff.STAGGER_STEP_MS, esiBackoff.STAGGER_MAX_MS / (n - 1));
		const r = typeof rand === "number" && rand >= 0 && rand < 1 ? rand : 0.5;
		return Math.min(esiBackoff.STAGGER_MAX_MS, Math.round(k * step + (r - 0.5) * step * 0.4));
	},

	/** The characters (same objects, a new map) whose `route` may be asked now. keep(c): poll anyway (token expiring:
	 *  upstream then skips it without a request and asks the server to refresh the token) */
	filter: function(characters, route, state, now, keep) {
		const out = {};
		Object.keys(characters || {}).forEach(function(id) {
			const c = characters[id];
			if (!c) { return; }
			if ((typeof keep === "function" && keep(c)) || esiBackoff.due(state && state[esiBackoff.key(id, route)], c.accessToken, now)) { out[id] = c; }
		});
		return out;
	},

	/** Routes stopped for this character because ESI keeps rejecting its token: [{route, status}] (empty = fine) */
	failing: function(id, state) {
		const s = state || esiBackoff.state;
		const out = [];
		esiBackoff.ROUTES.forEach(function(route) {
			const e = s[esiBackoff.key(id, route)];
			if (e && e.stopped) { out.push({ route: route, status: e.status }); }
		});
		return out;
	},

	/** The alert icon's tooltip, plain text */
	failingText: function(list) {
		if (!list || !list.length) { return ""; }
		const statuses = [];
		list.forEach(function(f) { if (statuses.indexOf(f.status) < 0) { statuses.push(f.status); } });
		return "Token rejected by ESI (HTTP " + statuses.join("/") + "): " + list.map(function(f) { return f.route; }).join(", ") +
			" not updating. Retried when the token refreshes; if it lasts, re-add the character.";
	},

	// ---- Browser wiring ----

	/** Record one answer for a character route; returns the new entry */
	record: function(url, status, textStatus, header, now, rand) {
		const r = esiBackoff.routeOf(url);
		if (!r) { return null; }
		now = now || Date.now();
		const kind = esiBackoff.classify(status, textStatus);
		const k = esiBackoff.key(r.id, r.route);
		const entry = esiBackoff.next(esiBackoff.state[k], {
			kind: kind, status: status, token: esiBackoff.tokenOf(url), cacheMs: kind === "ok" ? esiBackoff.cacheMs(header, now) : null,
			retryAfter: kind === "ok" ? null : esiBackoff.retryAfter((function() { try { return header("Retry-After"); } catch (e) { return null; } })(), now)
		}, now, typeof rand === "number" ? rand : Math.random());
		const was = esiBackoff.state[k];
		esiBackoff.state[k] = entry;
		if (entry.stopped && !(was && was.stopped) && typeof console !== "undefined") {
			console.warn("ESI HTTP " + status + " for character " + r.id + " " + r.route + " (" + entry.failures + " in a row): stopped polling it until its token changes");
		}
		if ((entry.stopped || 0) !== ((was && was.stopped) || 0)) { esiBackoff.showFailing(r.id); }
		return entry;
	},

	markInflight: function(url, now) {
		const r = esiBackoff.routeOf(url);
		if (!r) { return; }
		const k = esiBackoff.key(r.id, r.route);
		esiBackoff.state[k] = Object.assign({}, esiBackoff.state[k] || {}, { inflight: now || Date.now() });
	},

	/** Show or hide the alert icon on a character's tracking card (fork-owned element, upstream's scope alert untouched) */
	showFailing: function(id) {
		if (typeof jQuery === "undefined") { return; }
		try {
			const $card = jQuery("#tracking .tracking-clone[data-characterid='" + String(id).replace(/[^0-9]/g, "") + "']");
			if (!$card.length) { return; }
			const text = esiBackoff.failingText(esiBackoff.failing(id));
			let $icon = $card.find(".esi-token-failing");
			$card.toggleClass("esi-token-failing-card", !!text);
			if (!text) { $icon.remove(); return; }
			if (!$icon.length) {
				$icon = jQuery('<i data-icon="alert" class="esi-token-failing"></i>');
				$card.find(".name").first().append($icon);
			}
			$icon.attr("data-tooltip", text).attr("aria-label", text);
			if (typeof Tooltips !== "undefined" && Tooltips.attach) { Tooltips.attach($icon); }
		} catch (e) { /* the next change */ }
	},

	/**
	 * Run a poller (it calls $.ajax synchronously for each character) with its character requests spread out: the
	 * first goes at once, the others a little later. Upstream's code gets a promise that settles like the real request
	 * (same `this`, same arguments) and whose getResponseHeader reads the real one once it is sent.
	 */
	staggered: function($, fn, self, args, count) {
		const real = $.ajax;
		let k = 0;
		$.ajax = function(url, options) {
			const settings = typeof url === "object" ? url : $.extend({}, options || {}, { url: url });
			if (!esiBackoff.routeOf(settings && settings.url)) { return real.apply(this, arguments); }
			const delay = esiBackoff.staggerOffset(k++, count, Math.random());
			if (delay <= 0) { return real.call($, settings); }
			return esiBackoff.deferred($, real, settings, delay);
		};
		try {
			return fn.apply(self, args);
		} finally {
			$.ajax = real;
		}
	},

	/** A jqXHR stand-in that sends `settings` after `delay` ms */
	deferred: function($, real, settings, delay) {
		const d = $.Deferred();
		let xhr = null, timer = null;
		const context = settings.context || settings;
		const fake = d.promise({
			readyState: 0,
			status: 0,
			getResponseHeader: function(name) { return xhr ? xhr.getResponseHeader(name) : null; },
			getAllResponseHeaders: function() { return xhr ? xhr.getAllResponseHeaders() : null; },
			abort: function(reason) {
				if (xhr) { xhr.abort(reason); return fake; }
				clearTimeout(timer);
				d.rejectWith(context, [fake, "abort", reason || "abort"]);
				return fake;
			}
		});
		esiBackoff.markInflight(settings.url);
		timer = setTimeout(function() {
			xhr = real.call($, settings);
			xhr.done(function() { fake.readyState = 4; fake.status = xhr.status; d.resolveWith(this, arguments); })
				.fail(function() { fake.readyState = 4; fake.status = xhr.status; d.rejectWith(this, arguments); });
		}, delay);
		return fake;
	},

	install: function($, tripwire) {
		esiBackoff.installPrefilter($);
		esiBackoff.wrapPollers($, tripwire);
	},

	installPrefilter: function($) {
		if (esiBackoff.prefilterInstalled === $) { return; }
		esiBackoff.prefilterInstalled = $;
		$.ajaxPrefilter(function(options, originalOptions, jqXHR) {
			if (!esiBackoff.routeOf(options.url)) { return; }
			const url = options.url;
			esiBackoff.markInflight(url);
			jqXHR.always(function(a, textStatus) {
				esiBackoff.record(url, jqXHR.status, textStatus, function(name) {
					try { return jqXHR.getResponseHeader(name); } catch (e) { return null; }
				});
			});
		});
	},

	wrapPollers: function($, tripwire) {
		const esi = tripwire && tripwire.esi;
		if (!esi) { return; }
		const expiring = function(c) {
			if (!c || !c.tokenExpire || typeof moment !== "function") { return false; }
			return moment.utc(c.tokenExpire).subtract(5, "minutes").isBefore(moment());
		};
		esiBackoff.ROUTES.forEach(function(route) {
			const poll = esi[route];
			if (typeof poll !== "function" || poll.esiBackoffWrapped) { return; }
			// Upstream's location / ship loops skip a character whose token is about to expire (no request) and ask the
			// server to refresh it, so those stay in; /online/ has no such check
			const keep = route === "online" ? null : expiring;
			const wrapped = function() {
				const all = tripwire.esi.characters;
				const due = esiBackoff.filter(all, route, esiBackoff.state, Date.now(), keep);
				const count = Object.keys(due).filter(function(id) { return !keep || !keep(due[id]); }).length;
				tripwire.esi.characters = due;
				try {
					return esiBackoff.staggered($, poll, this, arguments, count);
				} finally {
					// The loop reads the map synchronously; its callbacks look characters up again later
					if (tripwire.esi.characters === due) { tripwire.esi.characters = all; }
				}
			};
			wrapped.esiBackoffWrapped = true;
			esi[route] = wrapped;
		});
		// A character whose token changed gets its card's alert re-checked (cleared once an answer is ok)
		const parse = esi.parse;
		if (typeof parse === "function" && !parse.esiBackoffWrapped) {
			const wrappedParse = function() {
				const result = parse.apply(this, arguments);
				Object.keys(tripwire.esi.characters || {}).forEach(function(id) { esiBackoff.showFailing(id); });
				return result;
			};
			wrappedParse.esiBackoffWrapped = true;
			esi.parse = wrappedParse;
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.ajaxPrefilter) {
	// Before esi-limits.js and esi-offline-skip.js (it sorts first): their wrappers go around this one
	if (typeof tripwire !== "undefined" && tripwire.esi && tripwire.esi.location) {
		esiBackoff.install(jQuery, tripwire);
	} else {
		esiBackoff.installPrefilter(jQuery);
		jQuery(function() { if (typeof tripwire !== "undefined" && tripwire.esi) { esiBackoff.wrapPollers(jQuery, tripwire); } });
	}
}
