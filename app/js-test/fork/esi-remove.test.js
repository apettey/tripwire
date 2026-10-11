const assert = require('assert');
const { include } = require('../helpers/helpers');

// Runs upstream's real #removeESI click handler (app/js/tracking.js) and real tripwire.sync (app/js/tripwire/sync.js,
// wrapped by app/js/fork/sync-pending.js) against a fake jQuery and a fake $.ajax whose responses the test resolves
// by hand. Removing several ESI characters before the next refresh must send every one of them in esiDelete.

function deferred() {
	const callbacks = [];
	let state = null, args = null;
	const d = {
		done(f) { callbacks.push(['done', f]); if (state === 'resolved') f.apply(null, args); return d; },
		always(f) { callbacks.push(['always', f]); if (state) f.apply(null, args); return d; },
		resolve(...a) { state = 'resolved'; args = a; callbacks.forEach(([, f]) => f.apply(null, a)); },
		reject(...a) { state = 'rejected'; args = a; callbacks.forEach(([t, f]) => t === 'always' && f.apply(null, a)); }
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
	'setTimeout', 'clearTimeout', 'syncPending', 'maxTimeByProperty', 'tracking', 'options', 'set_tracking_text'];

describe('Remove ESI character (#removeESI)', () => {
	let saved, requests, handlers, removed, upstreamSync;

	const removeESI = characterID => {
		options.tracking.active = characterID;	// the character selected in the tracking list
		handlers['#login click #removeESI'].call({});
	};
	const sent = () => requests[requests.length - 1];
	const respond = req => req.xhr.resolve({ sync: '2026-10-11 00:00:00' }, 'success', req.xhr);
	const fail = req => req.xhr.reject({ status: 500 }, 'error', 'Internal Server Error');

	before(() => {
		saved = {};
		GLOBALS.forEach(g => { saved[g] = global[g]; });
		requests = [];
		handlers = {};
		removed = [];
		const $ = selector => ({
			selector,
			on(event, child, fn) { handlers[selector + ' ' + event + ' ' + child] = fn; return this; },
			remove() { removed.push(selector); return this; },
			attr() { return this; }, removeAttr() { return this; },
			inlinecomplete() {}, click() {}, show() {}, hide() {}, 0: undefined
		});
		$.isArray = Array.isArray;
		$.extend = (...a) => (a[0] === true ? extend(true, ...a.slice(1)) : extend(false, ...a));
		$.ajax = opts => {
			const xhr = deferred();
			requests.push({ data: JSON.parse(JSON.stringify(opts.data)), xhr });
			return xhr;
		};
		global.$ = $;
		global.setTimeout = () => 1;
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
			esi: { characters: {}, parse() {}, parseOauth() {}, updateTracking() {} },
			chainMap: { parse() {} }, parse() {}, updateReturnStatus() {}, active() {}, refresh() {}, EVE() {}
		};
		include('app/js/tripwire/sync');	// sends "init"
		respond(requests[0]);
		upstreamSync = tripwire.sync;
		include('app/js/fork/sync-pending');
		include('app/js/tracking');
	});

	after(() => {
		GLOBALS.forEach(g => { if (saved[g] === undefined) delete global[g]; else global[g] = saved[g]; });
	});

	beforeEach(() => {
		// set per test: guidance.test.js replaces the global options in a root-level beforeEach
		global.options = { tracking: { active: null, characterOptions: {} }, save() {} };
		tripwire.sync = upstreamSync;
		syncPending.wrap(tripwire);
		tripwire.data = { tracking: {}, esi: {} };
		tripwire.xhr = null;
		tripwire.connected = true;
		requests.length = 0;
		removed.length = 0;
	});

	it('removes the character from the tracking list and queues it for deletion', () => {
		removeESI('9001');
		assert.deepStrictEqual(removed, ["#tracking .tracking-clone[data-characterid='9001']"]);
		assert.deepStrictEqual(tripwire.data.esiDelete, ['9001']);
		assert.strictEqual(options.tracking.active, null);
	});

	it('sends every character removed before the next refresh', () => {
		removeESI('9001');
		removeESI('9002');
		removeESI('9003');
		tripwire.sync('refresh');
		assert.deepStrictEqual(sent().data.esiDelete, ['9001', '9002', '9003']);
	});

	it('clears the list once refresh.php has accepted it', () => {
		removeESI('9001');
		removeESI('9002');
		tripwire.sync('refresh');
		respond(sent());
		assert.strictEqual(tripwire.data.esiDelete, undefined);
		tripwire.sync('refresh');
		assert.strictEqual(sent().data.esiDelete, undefined);
	});

	it('keeps the list after a failed refresh and adds later removals to it', () => {
		removeESI('9001');
		tripwire.sync('refresh');
		fail(sent());
		removeESI('9002');
		tripwire.sync('refresh');
		assert.deepStrictEqual(sent().data.esiDelete, ['9001', '9002']);
	});

	it('sends a character removed while a refresh is in flight on the next refresh', () => {
		removeESI('9001');
		tripwire.sync('refresh');
		assert.deepStrictEqual(sent().data.esiDelete, ['9001']);
		removeESI('9002');	// refresh.php has not answered yet
		respond(sent());
		tripwire.sync('refresh');
		assert.ok(sent().data.esiDelete.includes('9002'), 'esiDelete sent: ' + JSON.stringify(sent().data.esiDelete));
	});
});
