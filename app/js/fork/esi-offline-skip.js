const esiOfflineSkip = {
	// Fork: skip ESI location and ship polling for characters that are logged off. Upstream polls /location/ and /ship/
	// for every linked character every 5 s (app/js/tripwire/esi.js), online or not; an offline character can't move,
	// so that is ~24 wasted requests a minute per logged-off alt. /online/ is still polled every 60 s as before, and its
	// answer decides: offline = skip location and ship; online or unknown (first load, failed request, missing
	// esi-location.read_online scope) = poll as today. Coming back online polls that character's location and ship at
	// once. A character whose token is about to expire stays in the loop so upstream still asks the server to refresh
	// it (upstream's loop skips such a character without a request). The server's tracking row is only written when
	// something changes, so it stays exactly as it is today while the character is offline. For every user, no setting
	// (a pure improvement). Composes with esi-limits.js, which wraps the same pollers.
	// Keep `const esiOfflineSkip` on the first line: the test helper strips it to define a global.

	states: {},		// characterID -> "online" | "offline" (missing = unknown)

	/** online | offline | unknown from an /online/ answer (anything else is unknown: keep polling) */
	stateOf: function(data) {
		if (data && data.online === true) { return "online"; }
		if (data && data.online === false) { return "offline"; }
		return "unknown";
	},

	/** Poll this character's location and ship now? Only a known-offline character with a token that isn't about to
	 *  expire is skipped. */
	shouldPoll: function(state, tokenExpiring) {
		return state !== "offline" || !!tokenExpiring;
	},

	/** The characters to poll (same objects, a new map) */
	filter: function(characters, states, isExpiring) {
		const out = {};
		Object.keys(characters || {}).forEach(function(id) {
			const c = characters[id];
			const expiring = typeof isExpiring === "function" ? !!isExpiring(c) : false;
			if (esiOfflineSkip.shouldPoll(states && states[id], expiring)) { out[id] = c; }
		});
		return out;
	},

	/** Back from offline to online: poll at once instead of waiting for the next 5 s slot */
	resumes: function(prev, next) {
		return prev === "offline" && next === "online";
	},

	/** Run a poller (it loops over esi.characters synchronously) with only `characters` in the map */
	withCharacters: function(esi, characters, fn, self, args) {
		const all = esi.characters;
		esi.characters = characters;
		try {
			return fn.apply(self, args);
		} finally {
			if (esi.characters === characters) { esi.characters = all; }
		}
	},

	install: function(tripwire) {
		const esi = tripwire && tripwire.esi;
		if (!esi || typeof esi.location !== "function" || typeof esi.ship !== "function" || esi.offlineSkipInstalled) { return; }
		esi.offlineSkipInstalled = true;
		const isExpiring = function(c) {
			if (!c || !c.tokenExpire || typeof moment !== "function") { return true; }	// can't tell: let upstream decide
			return moment.utc(c.tokenExpire).subtract(5, "minutes").isBefore(moment());
		};
		["location", "ship"].forEach(function(name) {
			const poll = esi[name];
			esi[name] = function() {
				const all = tripwire.esi.characters;
				return esiOfflineSkip.withCharacters(tripwire.esi, esiOfflineSkip.filter(all, esiOfflineSkip.states, isExpiring), poll, this, arguments);
			};
		});

		// Learn each character's online state from upstream's own /online/ requests (no extra requests)
		const status = esi.characterStatus;
		if (typeof status === "function") {
			esi.characterStatus = function(characterID) {
				const xhr = status.apply(this, arguments);
				const id = String(characterID);
				if (xhr && typeof xhr.done === "function") {
					xhr.done(function(data) { esiOfflineSkip.update(tripwire, id, esiOfflineSkip.stateOf(data)); })
						.fail(function() { esiOfflineSkip.update(tripwire, id, "unknown"); });
				}
				return xhr;
			};
		}
	},

	update: function(tripwire, id, next) {
		const prev = esiOfflineSkip.states[id];
		if (next === "unknown") { delete esiOfflineSkip.states[id]; } else { esiOfflineSkip.states[id] = next; }
		if (!esiOfflineSkip.resumes(prev, next)) { return; }
		const esi = tripwire.esi;
		const c = esi.characters && esi.characters[id];
		if (!c) { return; }
		// Only this character, at once; each poller then carries on with its usual 5 s timer
		const one = {};
		one[id] = c;
		["location", "ship"].forEach(function(name) {
			try { esiOfflineSkip.withCharacters(esi, one, esi[name], esi, []); }
			catch (e) { console.warn("esi-offline-skip: could not poll " + name + " for " + id, e); }
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined") {
	// After esi-limits.js (it sorts first): both wrap the pollers, ours on the outside
	if (typeof tripwire !== "undefined" && tripwire.esi && tripwire.esi.location) {
		esiOfflineSkip.install(tripwire);
	} else {
		jQuery(function() { if (typeof tripwire !== "undefined") { esiOfflineSkip.install(tripwire); } });
	}
}
