// Fork: don't lose pending tracking/ESI updates written while a refresh.php request is in flight.
//
// Upstream tripwire.sync (app/js/tripwire/sync.js) copies tripwire.data (pending character tracking from
// tripwire.esi.updateTracking, ESI flags, esiDelete) into the request when it is sent, but resets tripwire.data
// to {tracking: {}, esi: {}} when the response arrives. Anything written in between was never sent and is wiped;
// esi.js only writes tracking when something changes, so a jump made during that window never reaches the
// `tracking` table (no `jumps` row from the jumpHistory trigger, the automapper and fitted-mass reports miss it).
//
// This wrapper snapshots tripwire.data at send time and, after upstream's reset on success, puts back every entry
// that was added or changed after the send. Newer entries written after the reset win. Failed requests are left
// alone: upstream keeps tripwire.data on failure, so everything is resent on the next refresh.
var syncPending = {
	isPlainObject: function(value) {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	},

	same: function(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	},

	clone: function(value) {
		return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
	},

	/** The parts of `pending` (the live tripwire.data object of a sent request) that differ from `snapshot`
	 * (a copy taken when the request was sent): per entry for objects such as `tracking`, whole values otherwise. */
	unsent: function(snapshot, pending) {
		const out = {};
		snapshot = snapshot || {};
		for (const key in pending || {}) {
			const value = pending[key], before = snapshot[key];
			if (syncPending.isPlainObject(value) && syncPending.isPlainObject(before)) {
				const changed = {};
				for (const id in value) {
					if (!(id in before) || !syncPending.same(value[id], before[id])) changed[id] = value[id];
				}
				if (Object.keys(changed).length) out[key] = changed;
			} else if (!syncPending.same(value, before)) {
				out[key] = value;
			}
		}
		return out;
	},

	/** Merge `leftovers` into `target` (the fresh tripwire.data) without overwriting anything already in it. */
	restore: function(target, leftovers) {
		for (const key in leftovers) {
			const value = leftovers[key];
			if (syncPending.isPlainObject(value) && syncPending.isPlainObject(target[key])) {
				for (const id in value) {
					if (!(id in target[key])) target[key][id] = value[id];
				}
			} else if (target[key] === undefined || (syncPending.isPlainObject(target[key]) && !Object.keys(target[key]).length)) {
				target[key] = value;
			}
		}
		return target;
	},

	wrap: function(tw) {
		if (!tw || typeof tw.sync !== "function" || tw.sync.syncPendingWrapped) return;
		const original = tw.sync;
		let inflight = null;
		const wrapped = function() {
			const pending = tw.data;
			const snapshot = syncPending.clone(pending);
			const sent = original.apply(this, arguments);
			const xhr = tw.xhr;
			if (!sent) {
				// Upstream is waiting for the in-flight request: it copied tripwire.data (including anything written
				// mid-flight) into the retry it sends next, so there is nothing left to restore for that request.
				// Only if tripwire.data was still that request's pending object: a sync made after upstream's reset
				// (e.g. from a success callback) built its retry from the fresh, empty data, so restore as usual.
				if (inflight && pending === inflight.pending) inflight.superseded = true;
				return sent;
			}
			if (xhr && typeof xhr.done === "function" && pending) {
				const request = inflight = { pending: pending, superseded: false };
				// Registered after upstream's own done handler, so this runs right after its reset.
				xhr.done(function() {
					if (inflight === request) inflight = null;
					if (request.superseded || tw.data === pending) return;	// queued in a retry, or not reset
					const leftovers = syncPending.unsent(snapshot, pending);
					if (Object.keys(leftovers).length) {
						tw.data = tw.data || {tracking: {}, esi: {}};
						syncPending.restore(tw.data, leftovers);
					}
				});
			}
			return sent;
		};
		wrapped.syncPendingWrapped = true;
		wrapped.original = original;
		tw.sync = wrapped;
	}
};

if (typeof window !== "undefined" && typeof tripwire !== "undefined") {
	syncPending.wrap(tripwire);
}
