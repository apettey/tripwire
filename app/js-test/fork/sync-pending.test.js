const assert = require('assert');
const { include } = require('../helpers/helpers');

// Runs upstream's real tripwire.sync (app/js/tripwire/sync.js) against a fake $.ajax whose responses the test
// resolves by hand, so a tracking update can be written while a refresh.php request is in flight.

function deferred() {
	const callbacks = [];
	let state = null, args = null;
	const run = (type, f) => {
		if (state === 'resolved' && type !== 'fail') f.apply(null, args);
		if (state === 'rejected' && type !== 'done') f.apply(null, args);
	};
	const d = {
		done(f) { callbacks.push(['done', f]); run('done', f); return d; },
		fail(f) { callbacks.push(['fail', f]); run('fail', f); return d; },
		always(f) { callbacks.push(['always', f]); run('always', f); return d; },
		resolve(...a) { state = 'resolved'; args = a; callbacks.forEach(([t, f]) => t !== 'fail' && f.apply(null, a)); },
		reject(...a) { state = 'rejected'; args = a; callbacks.forEach(([t, f]) => t !== 'done' && f.apply(null, a)); }
	};
	return d;
}

function isPlain(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
function extend(deep, target, ...sources) {
	sources.forEach(src => {
		for (const k in src || {}) {
			const v = src[k];
			if (deep && isPlain(v)) target[k] = extend(true, isPlain(target[k]) ? target[k] : {}, v);
			else if (deep && Array.isArray(v)) target[k] = extend(true, [], v);
			else if (v !== undefined) target[k] = v;
		}
	});
	return target;
}

const GLOBALS = ['$', 'tripwire', 'appData', 'systemAnalysis', 'chain', 'Notify', 'viewingSystemID', 'viewingSystem',
	'setTimeout', 'clearTimeout', 'syncPending', 'maxTimeByProperty'];

describe('syncPending (pending tracking survives an in-flight refresh)', () => {
	let saved, requests, timers, upstreamSync;

	const track = (id, systemID) => tripwire.esi.updateTracking({ characterID: id, characterName: 'Pilot ' + id, systemID, systemName: 'J' + systemID });
	const sent = () => requests[requests.length - 1];
	const respond = (req, body) => req.xhr.resolve(body || { sync: '2026-10-11 00:00:00' }, 'success', req.xhr);
	const fail = req => req.xhr.reject({ status: 500 }, 'error', 'Internal Server Error');

	before(() => {
		saved = {};
		GLOBALS.forEach(g => { saved[g] = global[g]; });
		requests = [];
		timers = [];
		const $ = () => ({ inlinecomplete() {}, click() {}, show() {}, hide() {}, 0: undefined });
		$.extend = (...a) => (a[0] === true ? extend(true, ...a.slice(1)) : extend(false, ...a));
		$.ajax = options => {
			const xhr = deferred();
			requests.push({ options, data: JSON.parse(JSON.stringify(options.data)), xhr });
			return xhr;
		};
		global.$ = $;
		global.setTimeout = f => { timers.push(f); return timers.length; };
		global.clearTimeout = () => {};
		global.appData = { genericSystemTypes: [] };
		global.systemAnalysis = { analyse: () => ({}) };
		global.chain = { data: {} };
		global.Notify = { trigger() {} };
		global.viewingSystemID = 31000005;
		global.viewingSystem = 'J105246';
		global.tripwire = {
			data: { tracking: {}, esi: {} },
			client: { signatures: {} }, comments: { data: {} }, serverTime: {},
			instance: 1, version: 'test', refreshRate: 5000, connected: true,
			esi: {
				parse() {}, parseOauth() {},
				updateTracking(c) { tripwire.data.tracking[c.characterID] = Object.assign({}, c); }
			},
			chainMap: { parse() {} }, parse() {}, updateReturnStatus() {}, active() {}, refresh() {}
		};
		include('app/js/tripwire/sync');	// sends "init"
		respond(requests[0]);
		upstreamSync = tripwire.sync;
		include('app/js/fork/sync-pending');
	});

	after(() => {
		GLOBALS.forEach(g => { if (saved[g] === undefined) delete global[g]; else global[g] = saved[g]; });
	});

	beforeEach(() => {
		tripwire.sync = upstreamSync;
		syncPending.wrap(tripwire);
		tripwire.data = { tracking: {}, esi: {} };
		tripwire.xhr = null;
		tripwire.connected = true;
		requests.length = 0;
		timers.length = 0;
	});

	it('reproduces the upstream bug: a jump written mid-flight is wiped unsent', () => {
		tripwire.sync = upstreamSync;
		track(1, 31000001);
		tripwire.sync('refresh');
		assert.strictEqual(sent().data.tracking[1].systemID, 31000001);
		track(1, 31000002);	// jump while refresh.php is in flight
		respond(sent());
		assert.deepStrictEqual(tripwire.data.tracking, {});	// lost: esi.js won't write it again
	});

	it('keeps a jump written mid-flight and sends it on the next sync', () => {
		track(1, 31000001);
		tripwire.sync('refresh');
		track(1, 31000002);
		respond(sent());
		assert.strictEqual(tripwire.data.tracking[1].systemID, 31000002);
		tripwire.sync('refresh');
		assert.strictEqual(sent().data.tracking[1].systemID, 31000002);
		respond(sent());
		assert.deepStrictEqual(tripwire.data.tracking, {});
	});

	it('does not resend entries that were sent unchanged', () => {
		track(1, 31000001);
		track(2, 31000003);
		tripwire.sync('refresh');
		track(2, 31000004);	// only character 2 moves mid-flight
		track(3, 31000005);	// character 3 is new
		respond(sent());
		assert.deepStrictEqual(Object.keys(tripwire.data.tracking).sort(), ['2', '3']);
		assert.strictEqual(tripwire.data.tracking[2].systemID, 31000004);
	});

	it('lets an update written after the response win over the restored one', () => {
		track(1, 31000001);
		tripwire.sync('refresh', {}, () => track(1, 31000009));	// success callback runs after upstream's reset
		track(1, 31000002);
		respond(sent());
		assert.strictEqual(tripwire.data.tracking[1].systemID, 31000009);
	});

	it('restores an ESI flag set mid-flight', () => {
		tripwire.sync('refresh');
		tripwire.data.esi = { expired: true };
		respond(sent());
		assert.deepStrictEqual(tripwire.data.esi, { expired: true });
	});

	it('keeps everything when the request fails, and resends it', () => {
		track(1, 31000001);
		tripwire.sync('refresh');
		track(2, 31000003);
		fail(sent());
		assert.deepStrictEqual(Object.keys(tripwire.data.tracking).sort(), ['1', '2']);
		tripwire.sync('refresh');
		assert.deepStrictEqual(Object.keys(sent().data.tracking).sort(), ['1', '2']);
	});

	it('sends a jump queued by a sync that waited for the in-flight request', () => {
		track(1, 31000001);
		tripwire.sync('refresh');
		const first = sent();
		track(1, 31000002);
		const log = console.log; console.log = () => {};	// upstream logs "Awaiting existing XHR"
		try { assert.strictEqual(tripwire.sync('refresh'), false); } finally { console.log = log; }	// waits for the in-flight request
		track(1, 31000003);
		respond(first);
		timers.filter(t => typeof t === 'function').forEach(t => t());	// the 50 ms retry
		assert.strictEqual(requests.length, 2);
		assert.strictEqual(sent().data.tracking[1].systemID, 31000003);
	});

	it('keeps a mid-flight jump when a success callback syncs again before the request is finished', () => {
		track(1, 31000001);
		const log = console.log; console.log = () => {};	// upstream logs "Awaiting existing XHR"
		try {
			tripwire.sync('refresh', {}, () => assert.strictEqual(tripwire.sync('refresh'), false));	// after the reset, xhr still set
			const first = sent();
			track(1, 31000002);
			respond(first);
		} finally { console.log = log; }
		timers.filter(t => typeof t === 'function').forEach(t => t());	// the 50 ms retry
		assert.strictEqual(requests.length, 2);
		assert.strictEqual(sent().data.tracking[1].systemID, 31000002);
	});

	it('wraps only once', () => {
		const once = tripwire.sync;
		syncPending.wrap(tripwire);
		assert.strictEqual(tripwire.sync, once);
	});

	describe('unsent / restore', () => {
		it('finds added and changed entries per object, whole values otherwise', () => {
			const snapshot = { tracking: { 1: { s: 1 } }, esi: {}, esiDelete: [5] };
			const pending = { tracking: { 1: { s: 1 }, 2: { s: 2 } }, esi: { expired: true }, esiDelete: [5, 6] };
			assert.deepStrictEqual(syncPending.unsent(snapshot, pending), { tracking: { 2: { s: 2 } }, esi: { expired: true }, esiDelete: [5, 6] });
			assert.deepStrictEqual(syncPending.unsent(snapshot, syncPending.clone(snapshot)), {});
		});
		it('never overwrites what is already pending', () => {
			const target = { tracking: { 1: { s: 9 } }, esi: {} };
			syncPending.restore(target, { tracking: { 1: { s: 2 }, 2: { s: 3 } }, esiDelete: [6] });
			assert.deepStrictEqual(target, { tracking: { 1: { s: 9 }, 2: { s: 3 } }, esi: {}, esiDelete: [6] });
		});
	});
});
