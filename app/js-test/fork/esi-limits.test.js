const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/esi-limits');

const NOW = 1760000000000;
const headers = map => name => {
	const key = Object.keys(map).find(k => k.toLowerCase() === name.toLowerCase());
	return key === undefined ? null : map[key];
};
const LOCATION = 'https://esi.evetech.net/v1/characters/90000001/location/?token=abc&user_agent=x';
const quiet = fn => { const warn = console.warn; const logged = []; console.warn = m => logged.push(m); try { fn(); } finally { console.warn = warn; } return logged; };

describe('esiLimits', () => {
	beforeEach(() => { esiLimits.pauses = {}; });

	describe('compatibility date', () => {
		it('is a YYYY-MM-DD date', () => {
			assert.match(esiLimits.COMPATIBILITY_DATE, /^\d{4}-\d{2}-\d{2}$/);
		});
		it('is the same date the server uses (esi/esi.inc.php)', () => {
			const php = require('fs').readFileSync('esi/esi.inc.php').toString();
			assert.strictEqual(/const ESI_COMPATIBILITY_DATE = '([^']+)'/.exec(php)[1], esiLimits.COMPATIBILITY_DATE);
		});
		it('is added as a query parameter', () => {
			assert.strictEqual(esiLimits.withCompatibilityDate('https://esi.evetech.net/v1/status/?user_agent=x', '2025-12-16'),
				'https://esi.evetech.net/v1/status/?user_agent=x&compatibility_date=2025-12-16');
			assert.strictEqual(esiLimits.withCompatibilityDate('https://esi.evetech.net/status', '2025-12-16'),
				'https://esi.evetech.net/status?compatibility_date=2025-12-16');
			assert.strictEqual(esiLimits.withCompatibilityDate('https://esi.evetech.net/status?', '2025-12-16'),
				'https://esi.evetech.net/status?compatibility_date=2025-12-16');
		});
		it('defaults to the pinned date and keeps an existing one', () => {
			assert.ok(esiLimits.withCompatibilityDate('https://esi.evetech.net/status').endsWith('compatibility_date=' + esiLimits.COMPATIBILITY_DATE));
			const url = 'https://esi.evetech.net/status?compatibility_date=2020-01-01';
			assert.strictEqual(esiLimits.withCompatibilityDate(url), url);
		});
		it('only touches ESI URLs', () => {
			assert.ok(esiLimits.isEsiUrl(LOCATION));
			assert.ok(!esiLimits.isEsiUrl('https://login.eveonline.com/v2/oauth/token'));
			assert.ok(!esiLimits.isEsiUrl('refresh.php'));
			assert.ok(!esiLimits.isEsiUrl('https://example.com/?u=https://esi.evetech.net/'));
		});
	});

	describe('request helpers', () => {
		it('finds the character of authenticated character routes only', () => {
			assert.strictEqual(esiLimits.characterOf(LOCATION, true), '90000001');
			assert.strictEqual(esiLimits.characterOf('https://esi.evetech.net/latest/characters/90000001/', false), null);
			assert.strictEqual(esiLimits.characterOf('https://esi.evetech.net/v2/ui/autopilot/waypoint/?destination_id=1', true), null);
		});
		it('detects tokens in the query string or Authorization header', () => {
			assert.ok(esiLimits.isAuthenticated(LOCATION, {}));
			assert.ok(esiLimits.isAuthenticated('https://esi.evetech.net/v2/ui/autopilot/waypoint/', { Authorization: 'Bearer x' }));
			assert.ok(!esiLimits.isAuthenticated('https://esi.evetech.net/v1/status/?user_agent=x', { 'X-User-Agent': 'x' }));
		});
		it('parses Retry-After as seconds or a date', () => {
			assert.strictEqual(esiLimits.retryAfter('120', NOW), 120);
			assert.strictEqual(esiLimits.retryAfter(new Date(NOW + 30000).toUTCString(), NOW), 30);
			assert.strictEqual(esiLimits.retryAfter(null, NOW), null);
			assert.strictEqual(esiLimits.retryAfter('soon', NOW), null);
		});
	});

	describe('decide', () => {
		it('pauses the character on 429 for Retry-After', () => {
			assert.deepStrictEqual(esiLimits.decide(LOCATION, 429, headers({ 'Retry-After': '90', 'X-Ratelimit-Group': 'char-location' }), true, NOW),
				{ 'char:90000001': 90 });
		});
		it('defaults to 60 s and caps at 15 min', () => {
			assert.deepStrictEqual(esiLimits.decide(LOCATION, 429, headers({}), true, NOW), { 'char:90000001': 60 });
			assert.deepStrictEqual(esiLimits.decide(LOCATION, 429, headers({ 'Retry-After': '99999' }), true, NOW), { 'char:90000001': 900 });
		});
		it('pauses everything on 420 until the error window resets', () => {
			assert.deepStrictEqual(esiLimits.decide(LOCATION, 420, headers({ 'X-ESI-Error-Limit-Remain': '0', 'X-ESI-Error-Limit-Reset': '37' }), true, NOW),
				{ '*': 38 });
		});
		it('pauses everything before the error limit runs out', () => {
			assert.deepStrictEqual(esiLimits.decide(LOCATION, 404, headers({ 'X-ESI-Error-Limit-Remain': '3', 'X-ESI-Error-Limit-Reset': '12' }), true, NOW),
				{ '*': 13 });
			assert.deepStrictEqual(esiLimits.decide(LOCATION, 200, headers({ 'X-ESI-Error-Limit-Remain': '80', 'X-ESI-Error-Limit-Reset': '12' }), true, NOW), {});
		});
		it('pauses the TQ status poll on a 429 from /status', () => {
			assert.deepStrictEqual(esiLimits.decide('https://esi.evetech.net/v1/status/?user_agent=x&compatibility_date=2025-12-16', 429, headers({ 'Retry-After': '30' }), false, NOW),
				{ status: 30 });
		});
		it('does not pause polling for other 429s or normal answers', () => {
			assert.deepStrictEqual(esiLimits.decide('https://esi.evetech.net/v2/ui/autopilot/waypoint/', 429, headers({ 'Retry-After': '30' }), true, NOW), {});
			assert.deepStrictEqual(esiLimits.decide(LOCATION, 200, headers({ 'X-Ratelimit-Remaining': '3', 'X-Ratelimit-Limit': '1200/15m' }), true, NOW), {});
			assert.deepStrictEqual(esiLimits.decide(LOCATION, 0, headers({}), true, NOW), {});
		});
	});

	describe('record and pauses', () => {
		it('pauses one character and logs once', () => {
			const logged = quiet(() => {
				esiLimits.record(LOCATION, 429, headers({ 'Retry-After': '60' }), true, NOW);
				esiLimits.record(LOCATION, 429, headers({ 'Retry-After': '30' }), true, NOW + 1000);
			});
			assert.strictEqual(logged.length, 1);
			assert.ok(esiLimits.isCharacterPaused('90000001', NOW + 59000));
			assert.ok(!esiLimits.isCharacterPaused('90000002', NOW + 1000));
			assert.ok(!esiLimits.isCharacterPaused('90000001', NOW + 60001), 'a shorter later pause does not extend or shorten it');
		});
		it('logs again for a new pause after the old one ended', () => {
			const logged = quiet(() => {
				esiLimits.record(LOCATION, 429, headers({ 'Retry-After': '10' }), true, NOW);
				esiLimits.record(LOCATION, 429, headers({ 'Retry-After': '10' }), true, NOW + 20000);
			});
			assert.strictEqual(logged.length, 2);
		});
		it('a global pause covers every character', () => {
			quiet(() => esiLimits.record(LOCATION, 420, headers({ 'X-ESI-Error-Limit-Reset': '20' }), true, NOW));
			assert.ok(esiLimits.isCharacterPaused('123', NOW + 5000));
			assert.ok(esiLimits.pausedFor('status', NOW + 5000) > 0);
			assert.strictEqual(esiLimits.pausedFor('status', NOW + 22000), 0);
		});
		it('leaves paused characters out of the polling map', () => {
			quiet(() => esiLimits.record(LOCATION, 429, headers({ 'Retry-After': '60' }), true, NOW));
			const active = esiLimits.activeCharacters({ 90000001: { a: 1 }, 90000002: { b: 2 } }, NOW + 1000);
			assert.deepStrictEqual(Object.keys(active), ['90000002']);
		});
	});

	describe('install (browser wiring)', () => {
		let prefilter, tripwire, seen, requested;
		function fakeXHR(status, responseHeaders) {
			const callbacks = [];
			return {
				status: 0,
				always(fn) { callbacks.push(fn); return this; },
				getResponseHeader(name) { return headers(responseHeaders)(name); },
				finish() { this.status = status; callbacks.forEach(fn => fn()); }
			};
		}
		function ajax(options, status, responseHeaders) {
			const xhr = fakeXHR(status, responseHeaders || {});
			const settings = Object.assign({ headers: {} }, options);
			prefilter(settings, options, xhr);
			requested.push(settings.url);
			quiet(() => xhr.finish());
			return settings;
		}
		beforeEach(() => {
			seen = [];
			requested = [];
			const characters = { 90000001: { characterID: 90000001 }, 90000002: { characterID: 90000002 } };
			tripwire = {
				esi: {
					characters,
					location() { seen.push(Object.keys(tripwire.esi.characters)); },
					ship() { seen.push(Object.keys(tripwire.esi.characters)); },
					online() { seen.push(Object.keys(tripwire.esi.characters)); }
				},
				serverStatus() { seen.push('status'); }
			};
			const $ = { ajaxPrefilter(fn) { prefilter = fn; } };
			esiLimits.install($, tripwire);
		});
		afterEach(() => { esiLimits.pauses = {}; });

		it('adds the compatibility date to ESI requests only', () => {
			assert.ok(ajax({ url: LOCATION }, 200).url.endsWith('&compatibility_date=' + esiLimits.COMPATIBILITY_DATE));
			assert.strictEqual(ajax({ url: 'refresh.php' }, 200).url, 'refresh.php');
		});
		it('polls everyone normally', () => {
			tripwire.esi.location();
			tripwire.esi.ship();
			assert.deepStrictEqual(seen, [['90000001', '90000002'], ['90000001', '90000002']]);
		});
		it('skips a character after a 429 on its route, then resumes', () => {
			ajax({ url: LOCATION }, 429, { 'Retry-After': '1' });
			tripwire.esi.location();
			tripwire.esi.online();
			assert.deepStrictEqual(seen, [['90000002'], ['90000002']]);
			assert.strictEqual(Object.keys(tripwire.esi.characters).length, 2, 'the real map is restored');
			esiLimits.pauses['char:90000001'] = Date.now() - 1;
			tripwire.esi.ship();
			assert.deepStrictEqual(seen[2], ['90000001', '90000002']);
		});
		it('skips everyone and the TQ status after a 420', () => {
			ajax({ url: 'https://esi.evetech.net/v1/status/?user_agent=x' }, 420, { 'X-ESI-Error-Limit-Reset': '30' });
			const timers = [];
			const setTimeoutOrig = global.setTimeout, clearTimeoutOrig = global.clearTimeout;
			global.setTimeout = (fn, ms) => { timers.push(ms); return 1; };
			global.clearTimeout = () => {};
			try {
				tripwire.esi.location();
				tripwire.serverStatus();
			} finally {
				global.setTimeout = setTimeoutOrig;
				global.clearTimeout = clearTimeoutOrig;
			}
			assert.deepStrictEqual(seen, [[]]);
			assert.deepStrictEqual(timers, [15000], 'the status poll keeps its timer');
		});
		it('restores the characters map even if a poll throws', () => {
			ajax({ url: LOCATION }, 429, { 'Retry-After': '60' });
			const all = tripwire.esi.characters;
			tripwire.esi.characters = all;
			const throwing = () => { throw new Error('boom'); };
			assert.throws(() => esiLimits.withoutPausedCharacters(tripwire.esi, throwing, null, []));
			assert.strictEqual(tripwire.esi.characters, all);
		});
		it('does not wrap twice', () => {
			const location = tripwire.esi.location;
			esiLimits.install({ ajaxPrefilter() {} }, tripwire);
			assert.strictEqual(tripwire.esi.location, location);
		});
	});
});
