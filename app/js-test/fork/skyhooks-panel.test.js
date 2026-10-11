const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/guidance');
include('app/js/systemAnalysis');
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
		const near = { 1: { jumps: 3, exitID: 100 }, 2: { jumps: 4, exitID: 200 }, 3: { jumps: 1, exitID: 100 }, 4: { jumps: 2, exitID: 200 } };
		const nearestFn = id => near[id];
		const list = [sh(1, -60, 3600), sh(2, 600, 7800), sh(4, 100, 7300), sh(3, 0, 100), sh(1, 7200, 14400, 999)];
		const rows = saved => skyhooksPanel.rows(list, systemFor, nearestFn, T, S(saved));

		it('filters by window, security and jumps, sorted by jumps', () => {
			// system 3 is high-sec but open and 1 jump away: shown; planet 999 opens in 2 h: shown
			const r = rows({ maxJumps: 10 });
			assert.deepEqual(r.map(x => x.skyhook.systemID), [3, 4, 1, 1, 2]);
			assert.deepEqual(r.map(x => x.nearest.jumps), [1, 2, 3, 3, 4]);
			assert.deepEqual(r[0].nearest.exit, { systemID: 100 });
		});
		it('max jumps', () => assert.deepEqual(rows({ maxJumps: 3 }).map(x => x.skyhook.systemID), [3, 4, 1, 1]));
		it('any distance', () => {
			const far = [sh(2, 0, 100)];
			assert.equal(skyhooksPanel.rows(far, systemFor, () => ({ jumps: 40, exitID: 1 }), T, S({ maxJumps: 0 })).length, 1);
			assert.equal(skyhooksPanel.rows(far, systemFor, () => ({ jumps: 40, exitID: 1 }), T, S({ maxJumps: 10 })).length, 0);
		});
		it('unreachable systems are left out', () => {
			assert.deepEqual(skyhooksPanel.rows([sh(1, 0, 100), sh(5, 0, 100)], systemFor, id => id === 1 ? near[1] : null, T, S({})).map(x => x.skyhook.systemID), [1]);
		});
		it('security checkboxes', () => assert.deepEqual(rows({ low: false }).map(x => x.skyhook.systemID), [3, 4, 2]));
		it('window now', () => assert.deepEqual(rows({ window: 'now' }).map(x => x.skyhook.systemID), [3, 1]));
		it('sort by window start, then jumps', () => assert.deepEqual(rows({ sort: 'start' }).map(x => x.skyhook.start - T), [-60, 0, 100, 600, 7200]));
		it('no exits: nothing', () => assert.deepEqual(skyhooksPanel.rows(list, systemFor, () => undefined, T, S({})), []));
		it('garbage input', () => assert.deepEqual(skyhooksPanel.rows(null, systemFor, nearestFn, T, S({})), []));
		it('does not mutate its input', () => {
			const copy = JSON.stringify(list);
			rows({ sort: 'start' });
			assert.equal(JSON.stringify(list), copy);
		});
	});

	describe('distances (multi-source search)', () => {
		const O = 30000000;
		// 1-2-3-4 chain, 5-3 branch, 9 isolated
		const g = { 1: { 2: 0 }, 2: { 1: 0, 3: 0 }, 3: { 2: 0, 4: 0, 5: 0 }, 4: { 3: 0 }, 5: { 3: 0 }, 9: {} };
		const unit = () => 1;
		const d = (exits, limit, fn) => skyhooksPanel.distances(g, exits.map(e => e + O), limit, fn || unit);

		it('single exit', () => {
			const r = d([1], 10);
			assert.deepEqual([1, 2, 3, 4, 5].map(i => r[i + O].jumps), [0, 1, 2, 3, 3]);
			assert.equal(r[9 + O], undefined);
		});
		it('nearest of several exits, and which one', () => {
			const r = d([1, 4], 10);
			assert.deepEqual([1, 2, 3, 4, 5].map(i => r[i + O].jumps), [0, 1, 1, 0, 2]);
			assert.equal(r[2 + O].exitID, 1 + O);
			assert.equal(r[3 + O].exitID, 4 + O);
			assert.equal(r[5 + O].exitID, 4 + O);
		});
		it('limit stops the search', () => {
			const r = d([1], 2);
			assert.deepEqual(Object.keys(r).map(k => k - O).sort(), ['1', '2', '3']);
		});
		it('unknown or duplicate exits are ignored', () => {
			assert.deepEqual(Object.keys(d([77, 1, 1], 10)).length, 5);
			assert.deepEqual(d([], 10), {});
			assert.deepEqual(skyhooksPanel.distances(null, [1 + O], 5, unit), {});
		});
		it('closed gates (cost <= 0) are not used', () => {
			const r = d([1], 10, (a, b) => (a === 2 && b === 3) ? 0 : 1);
			assert.deepEqual(Object.keys(r).map(k => k - O).sort(), ['1', '2']);
		});
		it('a penalised hop is avoided when there is another way, jumps still count hops', () => {
			// 1-2-4 (2 hops, 4 is costly) vs 1-3-5-4 ... build a diamond: 1-2-4 and 1-3-5-4
			const m = { 1: { 2: 0, 3: 0 }, 2: { 1: 0, 4: 0 }, 3: { 1: 0, 5: 0 }, 4: { 2: 0, 5: 0 }, 5: { 3: 0, 4: 0 } };
			const r = skyhooksPanel.distances(m, [1 + O], 200, (a, b) => b === 2 ? 101 : 1);
			assert.equal(r[4 + O].jumps, 3);   // via 3 and 5: cost 3, not via 2: cost 102
			assert.equal(r[2 + O].jumps, 1);
		});

		describe('same answers as guidance.findShortestPath', () => {
			let savedOptions;
			before(() => { savedOptions = global.options; });
			after(() => { global.options = savedOptions; guidance.clearCache(); });
			const sid = name => Number(Object.keys(appData.systems).find(k => appData.systems[k].name === name));
			const names = ['Perimeter', 'Rens', 'Amarr', 'Dodixie', 'Hek', 'Tama', 'Kedama', 'Aunenen', 'Heydieles'];
			const check = routeSecurity => {
				global.options = { chain: { routeIgnore: { enabled: true, systems: ['Niarja'] }, routeSecurity: routeSecurity } };
				guidance.clearCache();
				const exits = ['Jita', 'Tama'].map(sid);
				const limit = 25;
				const costFn = (from, to) => 1 + skyhooksPanel.entryPenalty(systemAnalysis.analyse(O + to), options.chain);
				const r = skyhooksPanel.distances(appData.map.shortest, exits, limit, costFn);
				names.map(sid).forEach(target => {
					let best = null;
					exits.forEach(e => {
						const p = guidance.findShortestPath(appData.map.shortest, e - O, target - O, limit);
						if (p && p.length && (!best || p.length - 1 < best)) { best = p.length - 1; }
					});
					const got = r[target] ? r[target].jumps : null;
					// the nearest exit by cost can differ from the fewest hops only when a penalty is involved
					if (routeSecurity === 'shortest') { assert.equal(got, best, appData.systems[target].name); }
					else if (got !== null && best !== null) { assert.ok(Math.abs(got - best) <= 3, appData.systems[target].name + ' ' + got + ' vs ' + best); }
				});
				assert.ok(Object.keys(r).length > 100);
			};
			const O = 30000000;
			it('shortest', () => check('shortest'));
			it('high-sec only', () => check('highsec'));
			it('avoid null', () => check('avoid-null'));
		});

		describe('entry penalty', () => {
			const hs = { name: 'A', security: 0.9 }, ls = { name: 'B', security: 0.3 }, ns = { name: 'C', security: -0.2 };
			it('shortest: none', () => assert.equal(skyhooksPanel.entryPenalty(ls, { routeSecurity: 'shortest' }), 0));
			it('high-sec only penalises low and null', () => {
				assert.deepEqual([hs, ls, ns].map(x => skyhooksPanel.entryPenalty(x, { routeSecurity: 'highsec' })), [0, 100, 100]);
			});
			it('avoid high-sec', () => assert.equal(skyhooksPanel.entryPenalty(hs, { routeSecurity: 'avoid-high' }), 100));
			it('avoid null', () => assert.deepEqual([hs, ls, ns].map(x => skyhooksPanel.entryPenalty(x, { routeSecurity: 'avoid-null' })), [0, 0, 100]));
			it('avoid list and Zarzakh', () => {
				assert.equal(skyhooksPanel.entryPenalty(ls, { routeIgnore: { enabled: true, systems: ['B'] } }), 100);
				assert.equal(skyhooksPanel.entryPenalty(ls, { routeIgnore: { enabled: false, systems: ['B'] } }), 0);
				assert.equal(skyhooksPanel.entryPenalty({ name: 'Zarzakh', security: -1 }, {}), 100);
			});
			it('unknown system or options', () => {
				assert.equal(skyhooksPanel.entryPenalty(null, {}), 0);
				assert.equal(skyhooksPanel.entryPenalty(ls, undefined), 0);
			});
		});
	});

	describe('default placement', () => {
		const W = (col, row, x, y) => ({ col: col, row: row, size_x: x, size_y: y });
		const size = skyhooksPanel.DEFAULT_SIZE;
		it('right of the existing widgets when it fits', () => {
			assert.deepEqual(skyhooksPanel.defaultPlacement([W(1, 1, 7, 6), W(8, 1, 7, 6)], 40), { col: 15, row: 1, size_x: size.x, size_y: size.y });
		});
		it('below them when it does not fit', () => {
			assert.deepEqual(skyhooksPanel.defaultPlacement([W(1, 1, 7, 6), W(8, 7, 14, 8)], 24), { col: 1, row: 15, size_x: size.x, size_y: size.y });
		});
		it('empty layout, unknown width', () => assert.deepEqual(skyhooksPanel.defaultPlacement([], undefined), { col: 1, row: 1, size_x: size.x, size_y: size.y }));
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
