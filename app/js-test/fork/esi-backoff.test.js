const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/esi-backoff');

const NOW = 1760000000000;
const headers = map => name => {
	const key = Object.keys(map).find(k => k.toLowerCase() === name.toLowerCase());
	return key === undefined ? null : map[key];
};
const url = (id, route, token) => 'https://esi.evetech.net/characters/' + id + '/' + route + '/?token=' + (token || 'tok') + '&user_agent=x';
const quiet = fn => { const warn = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = warn; } };

describe('esiBackoff', () => {
	beforeEach(() => { esiBackoff.state = {}; });

	describe('requests', () => {
		it('recognises character location, ship and online routes only', () => {
			assert.deepStrictEqual(esiBackoff.routeOf(url(9001, 'location')), { id: '9001', route: 'location' });
			assert.deepStrictEqual(esiBackoff.routeOf('https://esi.evetech.net/v1/characters/9001/ship/'), { id: '9001', route: 'ship' });
			assert.deepStrictEqual(esiBackoff.routeOf('https://esi.evetech.net/characters/9001/online'), { id: '9001', route: 'online' });
			assert.strictEqual(esiBackoff.routeOf('https://esi.evetech.net/characters/9001/assets/?page=1'), null);
			assert.strictEqual(esiBackoff.routeOf('https://esi.evetech.net/characters/9001/'), null);
			assert.strictEqual(esiBackoff.routeOf('https://example.com/characters/9001/location/'), null);
		});
		it('reads the token from the query string', () => {
			assert.strictEqual(esiBackoff.tokenOf(url(1, 'ship', 'a.b-c')), 'a.b-c');
			assert.strictEqual(esiBackoff.tokenOf('https://esi.evetech.net/characters/1/ship/'), '');
		});
		it('classifies answers', () => {
			assert.strictEqual(esiBackoff.classify(200, 'success'), 'ok');
			assert.strictEqual(esiBackoff.classify(304, 'notmodified'), 'ok');
			assert.strictEqual(esiBackoff.classify(200, 'parsererror'), 'error');
			assert.strictEqual(esiBackoff.classify(401, 'error'), 'auth');
			assert.strictEqual(esiBackoff.classify(403, 'error'), 'auth');
			assert.strictEqual(esiBackoff.classify(429, 'error'), 'limited');
			assert.strictEqual(esiBackoff.classify(420, 'error'), 'limited');
			assert.strictEqual(esiBackoff.classify(502, 'error'), 'error');
			assert.strictEqual(esiBackoff.classify(404, 'error'), 'error');
			assert.strictEqual(esiBackoff.classify(0, 'error'), 'error');
			assert.strictEqual(esiBackoff.classify(0, 'abort'), 'ignore');
		});
	});

	describe('cache lifetime', () => {
		it('uses Cache-Control max-age, less Age', () => {
			assert.strictEqual(esiBackoff.cacheMs(headers({ 'Cache-Control': 'private, max-age=5' }), NOW), 5000);
			assert.strictEqual(esiBackoff.cacheMs(headers({ 'Cache-Control': 'max-age=60', Age: '20' }), NOW), 40000);
			assert.strictEqual(esiBackoff.cacheMs(headers({ 'Cache-Control': 'max-age=5', Age: '20' }), NOW), 0);
		});
		it('prefers max-age over Expires', () => {
			const h = headers({ 'Cache-Control': 'max-age=5', Expires: new Date(NOW + 3600000).toUTCString() });
			assert.strictEqual(esiBackoff.cacheMs(h, NOW), 5000);
		});
		it('falls back to Expires, against Date when it is readable', () => {
			assert.strictEqual(esiBackoff.cacheMs(headers({ Expires: new Date(NOW + 30000).toUTCString() }), NOW), 30000);
			assert.strictEqual(esiBackoff.cacheMs(headers({ Expires: new Date(NOW + 30000).toUTCString(), Date: new Date(NOW + 20000).toUTCString() }), NOW), 10000);
			assert.strictEqual(esiBackoff.cacheMs(headers({ Expires: new Date(NOW - 30000).toUTCString() }), NOW), 0);
		});
		it('caps a lifetime from Expires per route: a slow PC clock must not stall polling', () => {
			// ESI's Expires is 5 s ahead of its clock; this PC is 2 minutes slow, so it looks 125 s away
			const slow = headers({ Expires: new Date(NOW + 125000).toUTCString() });
			assert.strictEqual(esiBackoff.cacheMs(slow, NOW, esiBackoff.EXPIRES_CEILING_MS.location), 5000);
			assert.strictEqual(esiBackoff.cacheMs(slow, NOW, esiBackoff.EXPIRES_CEILING_MS.online), 60000);
			assert.strictEqual(esiBackoff.cacheMs(headers({ 'Cache-Control': 'max-age=30' }), NOW, 5000), 30000, 'max-age is relative: not capped');
			const quiet2 = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
			const entry = quiet2(() => esiBackoff.record('https://esi.evetech.net/characters/7/location/?token=t', 200, 'success', slow, NOW));
			assert.strictEqual(entry.expires, NOW + 5000);
			assert.strictEqual(esiBackoff.due(entry, 't', NOW + 5000), true, 'polled again on the next 5 s tick');
		});
		it('no-cache / no-store mean ask every time; no header means unknown', () => {
			assert.strictEqual(esiBackoff.cacheMs(headers({ 'Cache-Control': 'no-cache', Expires: new Date(NOW + 30000).toUTCString() }), NOW), 0);
			assert.strictEqual(esiBackoff.cacheMs(headers({ 'Cache-Control': 'private, no-store' }), NOW), 0);
			assert.strictEqual(esiBackoff.cacheMs(headers({}), NOW), null);
			assert.strictEqual(esiBackoff.cacheMs(headers({ Expires: '0' }), NOW), 0, 'an invalid Expires means already expired');
			assert.strictEqual(esiBackoff.cacheMs(headers({ Expires: 'never' }), NOW), 0);
			assert.strictEqual(esiBackoff.cacheMs(() => { throw new Error('unsafe header'); }, NOW), null);
		});
		it('does not ask again while the answer is current', () => {
			const e = esiBackoff.next(null, { kind: 'ok', cacheMs: 30000 }, NOW);
			assert.strictEqual(esiBackoff.due(e, 'tok', NOW + 5000), false);
			assert.strictEqual(esiBackoff.due(e, 'tok', NOW + 30000 - esiBackoff.CACHE_SLACK_MS), true, 'asks a little early (the spread)');
			assert.strictEqual(esiBackoff.due(e, 'tok', NOW + 31000), true);
		});
		it('keeps the 5 s polling for a 5 s cache', () => {
			const e = esiBackoff.next(null, { kind: 'ok', cacheMs: 5000 }, NOW + 300);
			assert.strictEqual(esiBackoff.due(e, 'tok', NOW + 5000), true);
		});
		it('does not ask while a request is still out', () => {
			const e = { inflight: NOW };
			assert.strictEqual(esiBackoff.due(e, 'tok', NOW + 1000), false);
			assert.strictEqual(esiBackoff.due(e, 'tok', NOW + esiBackoff.INFLIGHT_MS), true, 'a lost request stops blocking');
		});
	});

	describe('backoff', () => {
		it('backs off 5xx and network errors exponentially, capped at 5 minutes', () => {
			assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 10].map(n => esiBackoff.errorDelay(n, 503)), [5, 10, 20, 40, 80, 160, 300, 300]);
			let e = null;
			const waits = [];
			for (let i = 0; i < 4; i++) { e = esiBackoff.next(e, { kind: 'error', status: 503 }, NOW, 0.5); waits.push(e.until - NOW); }
			assert.deepStrictEqual(waits, [5000, 10000, 20000, 40000]);
			assert.strictEqual(esiBackoff.due(e, 'tok', NOW + 39000), false);
			assert.strictEqual(esiBackoff.due(e, 'tok', NOW + 40000), true);
		});
		it('caps network errors and timeouts at 30 s (they never reached ESI)', () => {
			assert.deepStrictEqual([1, 2, 3, 4, 5, 10].map(n => esiBackoff.errorDelay(n, 0)), [5, 10, 20, 30, 30, 30]);
			let e = null;
			for (let i = 0; i < 6; i++) { e = esiBackoff.next(e, { kind: 'error', status: 0 }, NOW, 0.5); }
			assert.strictEqual(e.until - NOW, 30000);
		});
		it('adds +-25% jitter so many characters do not retry together', () => {
			const low = esiBackoff.next(null, { kind: 'error', status: 502 }, NOW, 0);
			const high = esiBackoff.next(null, { kind: 'error', status: 502 }, NOW, 0.999);
			assert.strictEqual(low.until - NOW, 3750);
			assert.ok(high.until - NOW > 6200 && high.until - NOW < 6250);
		});
		it('honours a Retry-After on an error as a minimum', () => {
			const e = esiBackoff.next(null, { kind: 'error', status: 503, retryAfter: 120 }, NOW, 0.5);
			assert.strictEqual(e.until - NOW, 120000);
			const capped = esiBackoff.next(null, { kind: 'error', status: 503, retryAfter: 99999 }, NOW, 0.5);
			assert.strictEqual(capped.until - NOW, 900000);
			assert.strictEqual(esiBackoff.retryAfter('7', NOW), 7);
			assert.strictEqual(esiBackoff.retryAfter(new Date(NOW + 30000).toUTCString(), NOW), 30);
			assert.strictEqual(esiBackoff.retryAfter('soon', NOW), null);
		});
		it('waits 30 s, then 120 s after a rejected token, then stops until the token changes', () => {
			let e = esiBackoff.next(null, { kind: 'auth', status: 401, token: 'old' }, NOW, 0.5);
			assert.strictEqual(e.until - NOW, 30000);
			e = esiBackoff.next(e, { kind: 'auth', status: 401, token: 'old' }, NOW, 0.5);
			assert.strictEqual(e.until - NOW, 120000);
			e = esiBackoff.next(e, { kind: 'auth', status: 403, token: 'old' }, NOW, 0.5);
			assert.strictEqual(e.stopped, true);
			assert.strictEqual(esiBackoff.due(e, 'old', NOW + esiBackoff.STOPPED_RETRY_MS - 1), false, 'not soon with the same token');
			assert.strictEqual(esiBackoff.due(e, 'old', NOW + esiBackoff.STOPPED_RETRY_MS), true, 'but every 5 min (an SSO blip)');
			assert.strictEqual(esiBackoff.due(e, 'new', NOW), true, 'at once with a new token');
			const again = esiBackoff.next(e, { kind: 'auth', status: 403, token: 'new' }, NOW, 0.5);
			assert.strictEqual(again.stopped, true, 'the new token fails too: stopped again at once');
			assert.strictEqual(esiBackoff.due(again, 'new', NOW + 1000), false);
		});
		it('the active character\'s location never waits more than 60 s, stopped or not', () => {
			let e = esiBackoff.next(null, { kind: 'auth', status: 401, token: 'a' }, NOW, 0.5);
			e = esiBackoff.next(e, { kind: 'auth', status: 401, token: 'a' }, NOW, 0.5);	// 120 s pause
			assert.strictEqual(esiBackoff.due(e, 'a', NOW + 59000, true), false);
			assert.strictEqual(esiBackoff.due(e, 'a', NOW + 60000, true), true);
			assert.strictEqual(esiBackoff.due(e, 'a', NOW + 60000, false), false, 'others wait the full 120 s');
			e = esiBackoff.next(e, { kind: 'auth', status: 401, token: 'a' }, NOW, 0.5);
			assert.strictEqual(e.stopped, true);
			assert.strictEqual(esiBackoff.due(e, 'a', NOW + 60000, true), true);
			assert.strictEqual(esiBackoff.due(Object.assign({}, e, { inflight: NOW + 59000 }), 'a', NOW + 60000, true), false, 'not while one is out');
		});
		it('an ok answer clears everything; a different failure starts its own count', () => {
			let e = esiBackoff.next(null, { kind: 'auth', status: 401 }, NOW, 0.5);
			e = esiBackoff.next(e, { kind: 'error', status: 502 }, NOW, 0.5);
			assert.strictEqual(e.failures, 1);
			assert.strictEqual(e.until - NOW, 5000);
			e = esiBackoff.next(e, { kind: 'ok', cacheMs: null }, NOW);
			assert.deepStrictEqual(e, { kind: 'ok', failures: 0, expires: 0 });
			assert.strictEqual(esiBackoff.due(e, 'tok', NOW), true);
		});
		it('leaves 429/420 to esi-limits.js and ignores aborts', () => {
			const e = { kind: 'error', failures: 2, until: NOW + 1000, inflight: NOW };
			assert.deepStrictEqual(esiBackoff.next(e, { kind: 'limited', status: 429 }, NOW), { kind: 'error', failures: 2, until: NOW + 1000 });
			assert.deepStrictEqual(esiBackoff.next(e, { kind: 'ignore', status: 0 }, NOW), { kind: 'error', failures: 2, until: NOW + 1000 });
		});
	});

	describe('spreading', () => {
		it('sends the first request at once and spaces the others 250 ms apart', () => {
			assert.deepStrictEqual([0, 1, 2, 3].map(k => esiBackoff.staggerOffset(k, 4, 0.5)), [0, 250, 500, 750]);
			assert.strictEqual(esiBackoff.staggerOffset(0, 1, 0.5), 0);
		});
		it('fits many characters into 2 s', () => {
			const offsets = Array.from({ length: 30 }, (x, k) => esiBackoff.staggerOffset(k, 30, 0.5));
			assert.strictEqual(offsets[0], 0);
			assert.ok(offsets[29] <= esiBackoff.STAGGER_MAX_MS);
			assert.ok(offsets.every((o, k) => k === 0 || o > offsets[k - 1]), 'in order');
		});
		it('jitters a little around each slot', () => {
			const a = esiBackoff.staggerOffset(2, 4, 0), b = esiBackoff.staggerOffset(2, 4, 0.999);
			assert.ok(a >= 450 && a < 500 && b > 500 && b <= 550, a + ' ' + b);
		});
	});

	describe('filter and failing', () => {
		it('leaves out characters that are not due on that route only', () => {
			const chars = { 1: { accessToken: 'a' }, 2: { accessToken: 'b' } };
			const state = { '1:location': { kind: 'auth', failures: 1, until: NOW + 30000 } };
			assert.deepStrictEqual(Object.keys(esiBackoff.filter(chars, 'location', state, NOW)), ['2']);
			assert.deepStrictEqual(Object.keys(esiBackoff.filter(chars, 'ship', state, NOW)), ['1', '2']);
			assert.deepStrictEqual(Object.keys(esiBackoff.filter(chars, 'location', state, NOW, c => c.accessToken === 'a')), ['1', '2'], 'keep() wins');
		});
		it('lists the stopped routes and explains them', () => {
			const state = { '1:location': { stopped: true, status: 401 }, '1:ship': { stopped: true, status: 403 }, '1:online': { kind: 'auth', failures: 1 } };
			assert.deepStrictEqual(esiBackoff.failing(1, state), [{ route: 'location', status: 401 }, { route: 'ship', status: 403 }]);
			assert.deepStrictEqual(esiBackoff.failing(2, state), []);
			const text = esiBackoff.failingText(esiBackoff.failing(1, state));
			assert.match(text, /HTTP 401\/403/);
			assert.match(text, /location, ship/);
			assert.strictEqual(esiBackoff.failingText([]), '');
		});
	});

	describe('wiring', () => {
		let prefilter, sent, timers, tripwire, $;
		function fakeDeferred() {
			const done = [], fail = [];
			let state = 'pending', args = null, ctx = null;
			const d = {
				promise(target) {
					const p = target || {};
					p.done = fn => { if (state === 'resolved') fn.apply(ctx, args); else done.push(fn); return p; };
					p.fail = fn => { if (state === 'rejected') fn.apply(ctx, args); else fail.push(fn); return p; };
					p.always = fn => { p.done(fn); p.fail(fn); return p; };
					p.state = () => state;
					return p;
				},
				resolveWith(c, a) { state = 'resolved'; ctx = c; args = a; done.forEach(fn => fn.apply(c, a)); },
				rejectWith(c, a) { state = 'rejected'; ctx = c; args = a; fail.forEach(fn => fn.apply(c, a)); }
			};
			return d;
		}
		/** A fake $.ajax: runs the prefilter, records the request; answer(i, status, headers) settles it */
		function fakeAjax(settings) {
			const d = fakeDeferred();
			const xhr = d.promise({ status: 0, getResponseHeader: () => null });
			prefilter(settings, settings, xhr);
			sent.push({ settings, xhr, answer(status, h) {
				xhr.status = status;
				xhr.getResponseHeader = headers(h || {});
				const ok = status >= 200 && status < 400;
				quiet(() => ok ? d.resolveWith(settings, [{}, 'success', xhr]) : d.rejectWith(settings, [xhr, 'error', 'x']));
			} });
			return xhr;
		}
		function poller(route) {
			return function() {
				Object.keys(tripwire.esi.characters).forEach(id => {
					const c = tripwire.esi.characters[id];
					$.ajax({ url: url(id, route, c.accessToken), characterID: id });
				});
			};
		}
		const flush = () => { const t = timers.slice(); timers.length = 0; t.forEach(x => x.fn()); };
		let setTimeoutOrig;
		beforeEach(() => {
			sent = []; timers = [];
			setTimeoutOrig = global.setTimeout;
			global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
			$ = { ajaxPrefilter(fn) { prefilter = fn; }, Deferred: fakeDeferred, extend: Object.assign, ajax: fakeAjax };
			tripwire = { esi: {
				characters: { 1: { characterID: 1, accessToken: 'a' }, 2: { characterID: 2, accessToken: 'b' }, 3: { characterID: 3, accessToken: 'c' } },
				location: poller('location'), ship: poller('ship'), online: poller('online')
			} };
			esiBackoff.prefilterInstalled = null;
			esiBackoff.install($, tripwire);
		});
		afterEach(() => { global.setTimeout = setTimeoutOrig; });

		it('spreads one poll over time and restores $.ajax', () => {
			const realAjax = $.ajax;
			tripwire.esi.location();
			assert.strictEqual(sent.length, 1, 'only the first goes at once');
			assert.strictEqual(timers.length, 2);
			assert.ok(timers[0].ms > 0 && timers[0].ms < timers[1].ms && timers[1].ms <= esiBackoff.STAGGER_MAX_MS);
			assert.strictEqual($.ajax, realAjax, '$.ajax is restored');
			flush();
			assert.strictEqual(sent.length, 3);
			sent.forEach(s => s.answer(200, { 'Cache-Control': 'max-age=5' }));
			assert.ok(['1', '2', '3'].every(id => esiBackoff.state[id + ':location'].kind === 'ok'));
		});
		it('gives upstream a promise with `this`, arguments and response headers of the real request', () => {
			let seen = null, header = null;
			$.ajax = fakeAjax;
			const wrappedPoll = esiBackoff.staggered;
			let fake;
			wrappedPoll($, function() {
				$.ajax({ url: url(1, 'ship', 'a'), characterID: '1' });
				fake = $.ajax({ url: url(2, 'ship', 'b'), characterID: '2' });
				fake.done(function(data, status, jq) { seen = [this.characterID, status, jq.status]; });
			}, null, [], 2);
			assert.strictEqual(fake.getResponseHeader('warning'), null, 'before it is sent');
			flush();
			sent[1].answer(200, { warning: '199 old route' });
			header = fake.getResponseHeader('warning');
			assert.deepStrictEqual(seen, ['2', 'success', 200]);
			assert.strictEqual(header, '199 old route');
		});
		it('a rejected token: no hammering, then stopped; a new token gets one try', () => {
			const now = Date.now;
			let t = NOW;
			Date.now = () => t;
			try {
				tripwire.esi.characters = { 1: { characterID: 1, accessToken: 'a' } };
				tripwire.esi.location();
				sent[0].answer(401);
				for (let i = 0; i < 4; i++) { t += 5000; tripwire.esi.location(); }	// 20 s: under 30 s less the jitter
				assert.strictEqual(sent.length, 1, 'waits 30 s, not 5 s');
				t += 30000; tripwire.esi.location(); sent[1].answer(401);
				t += 30000; tripwire.esi.location();
				assert.strictEqual(sent.length, 2, 'then 120 s');
				t += 130000; tripwire.esi.location(); sent[2].answer(403);	// 160 s: past 120 s plus the jitter
				assert.deepStrictEqual(esiBackoff.failing(1), [{ route: 'location', status: 403 }]);
				for (let i = 0; i < 50; i++) { t += 5000; tripwire.esi.location(); }
				assert.strictEqual(sent.length, 3, 'stopped');
				t += 60000; tripwire.esi.location();
				assert.strictEqual(sent.length, 4, 'retried after 5 min with the same token');
				sent[3].answer(401);
				tripwire.esi.ship();
				assert.strictEqual(sent.length, 5, 'other routes keep their own state');
				tripwire.esi.characters[1].accessToken = 'refreshed';
				tripwire.esi.location();
				assert.strictEqual(sent.length, 6, 'at once with the new token');
				sent[5].answer(200, { 'Cache-Control': 'max-age=5' });
				assert.deepStrictEqual(esiBackoff.failing(1), []);
			} finally { Date.now = now; }
		});
		it('keeps polling the active character\'s location every 60 s while its token is rejected', () => {
			const now = Date.now;
			let t = NOW;
			Date.now = () => t;
			global.options = { tracking: { active: '1' } };
			try {
				tripwire.esi.characters = { 1: { characterID: 1, accessToken: 'a' }, 2: { characterID: 2, accessToken: 'b' } };
				for (let i = 0; i < 3; i++) {
					tripwire.esi.location();
					flush();
					sent.filter(s => !s.done).forEach(s => { s.done = true; s.answer(401); });
					t += 150000;
				}
				assert.deepStrictEqual(esiBackoff.failing(1).map(f => f.route), ['location']);
				const before = sent.length;
				for (let i = 0; i < 24; i++) { t += 5000; tripwire.esi.location(); flush(); sent.filter(s => !s.done).forEach(s => { s.done = true; s.answer(401); }); }
				const extra = sent.slice(before).map(s => esiBackoff.routeOf(s.settings.url).id);
				assert.deepStrictEqual(extra, ['1', '1'], 'the active one every 60 s, the other not at all in 2 min');
			} finally { Date.now = now; delete global.options; }
		});
		it('does not ask again while the cache is current or a request is out', () => {
			const now = Date.now;
			let t = NOW;
			Date.now = () => t;
			try {
				tripwire.esi.characters = { 1: { characterID: 1, accessToken: 'a' } };
				tripwire.esi.online();
				tripwire.esi.online();
				assert.strictEqual(sent.length, 1, 'in flight');
				sent[0].answer(200, { 'Cache-Control': 'max-age=60' });
				t += 30000; tripwire.esi.online();
				assert.strictEqual(sent.length, 1, 'still cached');
				t += 30000; tripwire.esi.online();
				assert.strictEqual(sent.length, 2);
			} finally { Date.now = now; }
		});
		it('keeps an expiring token in the location loop (upstream skips it and asks for a refresh)', () => {
			const momentOrig = global.moment;
			global.moment = Object.assign(() => ({}), { utc: () => ({ subtract: () => ({ isBefore: () => true }) }) });
			try {
				tripwire.esi.characters = { 1: { characterID: 1, accessToken: 'a', tokenExpire: '2020-01-01' } };
				esiBackoff.state['1:location'] = { stopped: true, token: 'a', status: 401, at: Date.now() };
				esiBackoff.state['1:online'] = { stopped: true, token: 'a', status: 403, at: Date.now() };
				tripwire.esi.location();
				tripwire.esi.online();
				assert.deepStrictEqual(sent.map(s => esiBackoff.routeOf(s.settings.url).route), ['location'], 'online has no expiry check upstream: stays stopped');
			} finally { global.moment = momentOrig; }
		});
		it('restores the characters map and does not wrap twice', () => {
			const all = tripwire.esi.characters;
			const location = tripwire.esi.location;
			esiBackoff.wrapPollers($, tripwire);
			assert.strictEqual(tripwire.esi.location, location);
			esiBackoff.state['1:location'] = { kind: 'error', failures: 1, until: Date.now() + 60000 };
			tripwire.esi.location();
			assert.strictEqual(tripwire.esi.characters, all);
		});
	});
});
