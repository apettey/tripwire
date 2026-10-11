const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/skyhooks-panel');

const T = Date.UTC(2026, 9, 11, 15, 0, 0) / 1000;   // 2026-10-11 15:00 UTC
const sh = (systemID, startOffset, endOffset, planetID) => ({ planetID: planetID || systemID * 10, systemID, start: T + startOffset, end: T + endOffset });
const systems = { 1: { security: 0.2 }, 2: { security: -0.5 }, 3: { security: 0.9 }, 4: { security: 0.0 }, 5: {} };
const systemFor = id => systems[id] || null;
const S = saved => skyhooksPanel.settings(saved);

describe('Skyhooks panel', () => {
	describe('settings', () => {
		it('defaults', () => assert.deepEqual(S(undefined), { enabled: true, maxJumps: 10, low: true, null: true, window: 'soon', soonHours: 2, sort: 'jumps' }));
		it('keeps valid values', () => assert.deepEqual(S({ enabled: false, maxJumps: 5, low: false, null: true, window: 'now', soonHours: 4, sort: 'start' }),
			{ enabled: false, maxJumps: 5, low: false, null: true, window: 'now', soonHours: 4, sort: 'start' }));
		it('0 means any distance', () => assert.equal(S({ maxJumps: 0 }).maxJumps, 0));
		it('rejects nonsense', () => assert.deepEqual(S({ maxJumps: -3, window: 'x', soonHours: 'abc', sort: 5 }), S({})));
		it('string numbers from a select', () => assert.equal(S({ maxJumps: '15' }).maxJumps, 15));
		it('garbage options', () => assert.deepEqual(S('x'), S({})));
	});

	describe('time', () => {
		it('duration hours and minutes', () => assert.equal(skyhooksPanel.duration(3600 + 12 * 60), '1h12m'));
		it('duration pads minutes', () => assert.equal(skyhooksPanel.duration(3600 + 5 * 60), '1h05m'));
		it('duration minutes', () => assert.equal(skyhooksPanel.duration(34 * 60 + 59), '34m'));
		it('duration under a minute', () => assert.equal(skyhooksPanel.duration(20), '<1m'));
		it('duration negative', () => assert.equal(skyhooksPanel.duration(-5), '<1m'));
		it('status open', () => assert.deepEqual(skyhooksPanel.status(T - 10, T + 100, T), { state: 'open', opensIn: 0, leftIn: 100 }));
		it('status starts exactly now', () => assert.equal(skyhooksPanel.status(T, T + 100, T).state, 'open'));
		it('status soon', () => assert.deepEqual(skyhooksPanel.status(T + 60, T + 100, T), { state: 'soon', opensIn: 60, leftIn: 0 }));
		it('status ended exactly now', () => assert.equal(skyhooksPanel.status(T - 100, T, T).state, 'closed'));
		it('countdown open', () => assert.equal(skyhooksPanel.countdown(T - 3600, T + 72 * 60, T), 'open now, 1h12m left'));
		it('countdown soon', () => assert.equal(skyhooksPanel.countdown(T + 34 * 60, T + 4000, T), 'opens in 34m'));
		it('countdown closed', () => assert.equal(skyhooksPanel.countdown(T - 200, T - 100, T), 'closed'));
		it('window text, same day, UTC', () => assert.equal(skyhooksPanel.windowText(T + 6 * 60, T + 126 * 60, T), '15:06–17:06'));
		it('window text with the date when not today', () => assert.equal(skyhooksPanel.windowText(T + 10 * 3600, T + 12 * 3600, T), 'Oct 12 01:00–03:00'));
	});

	describe('security', () => {
		it('classes', () => {
			assert.equal(skyhooksPanel.securityClass(systems[1]), 'low');
			assert.equal(skyhooksPanel.securityClass(systems[2]), 'null');
			assert.equal(skyhooksPanel.securityClass(systems[3]), 'high');
			assert.equal(skyhooksPanel.securityClass(systems[4]), 'null');
			assert.equal(skyhooksPanel.securityClass(systems[5]), null);
			assert.equal(skyhooksPanel.securityClass(null), null);
		});
		it('0.45 is high-sec, 0.44 low', () => {
			assert.equal(skyhooksPanel.securityClass({ security: 0.45 }), 'high');
			assert.equal(skyhooksPanel.securityClass({ security: 0.44 }), 'low');
		});
		it('baseSecurity wins', () => assert.equal(skyhooksPanel.securityClass({ baseSecurity: 0.1, security: 0.9 }), 'low'));
		it('checkboxes', () => {
			assert.equal(skyhooksPanel.securityPasses(systems[1], S({ low: false })), false);
			assert.equal(skyhooksPanel.securityPasses(systems[1], S({ null: false })), true);
			assert.equal(skyhooksPanel.securityPasses(systems[2], S({ null: false })), false);
		});
		it('high-sec and unknown are not hidden by the checkboxes', () => {
			assert.equal(skyhooksPanel.securityPasses(systems[3], S({ low: false, null: false })), true);
			assert.equal(skyhooksPanel.securityPasses(systems[5], S({ low: false, null: false })), true);
		});
	});

	describe('window filter', () => {
		const pass = (start, end, saved) => skyhooksPanel.windowPasses(T + start, T + end, T, S(saved));
		it('now: open only', () => {
			assert.equal(pass(-60, 60, { window: 'now' }), true);
			assert.equal(pass(60, 7200, { window: 'now' }), false);
		});
		it('soon: open or opening within the hours', () => {
			assert.equal(pass(-60, 60, { window: 'soon', soonHours: 2 }), true);
			assert.equal(pass(7200, 14400, { window: 'soon', soonHours: 2 }), true);
			assert.equal(pass(7201, 14400, { window: 'soon', soonHours: 2 }), false);
			assert.equal(pass(7201, 14400, { window: 'soon', soonHours: 4 }), true);
		});
		it('all: everything not over', () => {
			assert.equal(pass(86400, 90000, { window: 'all' }), true);
			assert.equal(pass(-100, -1, { window: 'all' }), false);
		});
	});

	describe('rows', () => {
		const exits = [{ systemID: 100 }, { systemID: 200 }];
		// jumps from exit 100 / 200 to systems 1..4
		const table = { '100>1': 3, '200>1': 7, '100>2': 12, '200>2': 4, '100>3': 1, '100>4': null, '200>4': 2 };
		const jumpsFn = (from, to) => { const j = table[from + '>' + to]; return j === undefined ? null : j; };
		const list = [sh(1, -60, 3600), sh(2, 600, 7800), sh(4, 100, 7300), sh(3, 0, 100), sh(1, 7200, 14400, 999)];

		it('nearest exit', () => {
			assert.deepEqual(skyhooksPanel.nearestExit(exits, 1, jumpsFn), { exit: exits[0], jumps: 3 });
			assert.deepEqual(skyhooksPanel.nearestExit(exits, 2, jumpsFn), { exit: exits[1], jumps: 4 });
			assert.equal(skyhooksPanel.nearestExit(exits, 99, jumpsFn), null);
			assert.equal(skyhooksPanel.nearestExit([], 1, jumpsFn), null);
		});
		it('nearest exit: tie goes to the first', () => {
			assert.equal(skyhooksPanel.nearestExit([{ systemID: 100 }, { systemID: 200 }], 4, (f) => 5).exit.systemID, 100);
		});
		it('filters by window, security and jumps, sorted by jumps', () => {
			const rows = skyhooksPanel.rows(list, exits, systemFor, jumpsFn, T, S({ maxJumps: 10 }));
			// system 3 is high-sec but open and 1 jump away: shown; planet 999 opens in 2 h: shown
			assert.deepEqual(rows.map(r => r.skyhook.systemID), [3, 4, 1, 1, 2]);
			assert.deepEqual(rows.map(r => r.nearest.jumps), [1, 2, 3, 3, 4]);
		});
		it('max jumps', () => {
			const rows = skyhooksPanel.rows(list, exits, systemFor, jumpsFn, T, S({ maxJumps: 3 }));
			assert.deepEqual(rows.map(r => r.skyhook.systemID), [3, 4, 1, 1]);
		});
		it('any distance', () => {
			const far = [sh(2, 0, 100)];
			assert.equal(skyhooksPanel.rows(far, exits, systemFor, () => 40, T, S({ maxJumps: 0 })).length, 1);
			assert.equal(skyhooksPanel.rows(far, exits, systemFor, () => 40, T, S({ maxJumps: 10 })).length, 0);
		});
		it('passes the limit to the router', () => {
			let seen = null;
			skyhooksPanel.rows([sh(1, 0, 100)], exits, systemFor, (f, t, limit) => { seen = limit; return 1; }, T, S({ maxJumps: 7 }));
			assert.equal(seen, 7);
			skyhooksPanel.rows([sh(1, 0, 100)], exits, systemFor, (f, t, limit) => { seen = limit; return 1; }, T, S({ maxJumps: 0 }));
			assert.equal(seen, skyhooksPanel.MAX_SEARCH_JUMPS);
		});
		it('security checkboxes', () => {
			const rows = skyhooksPanel.rows(list, exits, systemFor, jumpsFn, T, S({ low: false }));
			assert.deepEqual(rows.map(r => r.skyhook.systemID), [3, 4, 2]);
		});
		it('window now', () => {
			const rows = skyhooksPanel.rows(list, exits, systemFor, jumpsFn, T, S({ window: 'now' }));
			assert.deepEqual(rows.map(r => r.skyhook.systemID), [3, 1]);
		});
		it('sort by window start, then jumps', () => {
			const rows = skyhooksPanel.rows(list, exits, systemFor, jumpsFn, T, S({ sort: 'start' }));
			assert.deepEqual(rows.map(r => r.skyhook.start - T), [-60, 0, 100, 600, 7200]);
		});
		it('no exits: nothing', () => assert.deepEqual(skyhooksPanel.rows(list, [], systemFor, jumpsFn, T, S({})), []));
		it('garbage input', () => assert.deepEqual(skyhooksPanel.rows(null, exits, systemFor, jumpsFn, T, S({})), []));
		it('does not mutate its input', () => {
			const copy = JSON.stringify(list);
			skyhooksPanel.rows(list, exits, systemFor, jumpsFn, T, S({ sort: 'start' }));
			assert.equal(JSON.stringify(list), copy);
		});
	});

	describe('empty state', () => {
		it('nothing from the server', () => assert.equal(skyhooksPanel.emptyState(0, [{}], S({})).kind, 'none'));
		it('no exits', () => assert.equal(skyhooksPanel.emptyState(50, [], S({})).kind, 'noexits'));
		it('filtered out', () => {
			const e = skyhooksPanel.emptyState(50, [{}], S({ maxJumps: 5 }));
			assert.equal(e.kind, 'filtered');
			assert.ok(e.text.indexOf('within 5 jumps') >= 0);
		});
		it('filtered, any distance', () => assert.ok(skyhooksPanel.emptyState(50, [{}], S({ maxJumps: 0 })).text.indexOf('any distance') >= 0));
	});

	it('escapes', () => assert.equal(skyhooksPanel.escape('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'));
});
