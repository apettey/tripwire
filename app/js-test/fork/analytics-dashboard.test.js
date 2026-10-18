const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/analytics-dashboard');

describe('analyticsDashboard', () => {
	const a = analyticsDashboard;

	describe('suppressed counts', () => {
		it('recognises "<5" and "<3" only', () => {
			assert.strictEqual(a.isSuppressed('<5'), true);
			assert.strictEqual(a.isSuppressed('<3'), true);
			assert.strictEqual(a.isSuppressed(4), false);
			assert.strictEqual(a.isSuppressed('36-39'), false);
			assert.strictEqual(a.isSuppressed(null), false);
		});
		it('value: numbers, half the limit for "<n", the middle of a range, else null', () => {
			assert.strictEqual(a.value(12), 12);
			assert.strictEqual(a.value(0), 0);
			assert.strictEqual(a.value('<5'), 2.5);
			assert.strictEqual(a.value('<3'), 1.5);
			assert.strictEqual(a.value('36-40'), 38);
			assert.strictEqual(a.value(null), null);
			assert.strictEqual(a.value('—'), null);
			assert.strictEqual(a.value(NaN), null);
		});
		it('count: text for a cell', () => {
			assert.strictEqual(a.count(7), '7');
			assert.strictEqual(a.count(0), '0');
			assert.strictEqual(a.count('<5'), '<5');
			assert.strictEqual(a.count('36-39'), '36–39');
			assert.strictEqual(a.count(null), '—');
			assert.strictEqual(a.count(undefined), '—');
		});
		it('pct', () => {
			assert.strictEqual(a.pct(12), '12%');
			assert.strictEqual(a.pct(null), '—');
		});
		it('escape', () => {
			assert.strictEqual(a.escape('<b a="1">&\'x\''), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;x&#39;');
			assert.strictEqual(a.escape(null), '');
		});
	});

	describe('wilson', () => {
		it('matches the textbook interval', () => {
			const ci = a.wilson(10, 40);	// 25%: 14.2% - 40.2%
			assert.ok(Math.abs(ci[0] - 0.1419) < 0.001, ci[0]);
			assert.ok(Math.abs(ci[1] - 0.4019) < 0.001, ci[1]);
		});
		it('stays inside 0-1 at the edges', () => {
			const none = a.wilson(0, 20), all = a.wilson(20, 20);
			assert.strictEqual(none[0], 0);
			assert.ok(none[1] > 0.1 && none[1] < 0.2);
			assert.ok(all[0] > 0.8 && all[0] < 0.9);
			assert.ok(Math.abs(all[1] - 1) < 1e-12);
		});
		it('null without a sample', () => {
			assert.strictEqual(a.wilson(0, 0), null);
			assert.strictEqual(a.wilson('<5', 10), null);
		});
		it('rate: percent with the interval, "—" for suppressed or impossible counts', () => {
			assert.strictEqual(a.rate(10, 40), '25% (14–41%)');
			assert.strictEqual(a.rate('<5', 40), '—');
			assert.strictEqual(a.rate(5, null), '—');
			assert.strictEqual(a.rate(8, 5), '—');
		});
	});

	describe('sparkPath', () => {
		it('draws oldest to newest, highest value at the top', () => {
			const p = a.sparkPath([0, 5, 10], 22, 12);
			assert.strictEqual(p.d, 'M1 11L11 6L21 1');
			assert.strictEqual(p.max, 10);
			assert.strictEqual(p.dots.length, 3);
		});
		it('breaks the line at null (not released yet) and draws "<5" at 2.5', () => {
			const p = a.sparkPath([null, null, '<5', 5], 32, 12);
			assert.strictEqual(p.d, 'M21 6L31 1');
			assert.strictEqual(p.dots[0].v, '<5');
		});
		it('all zero or empty stays on the baseline', () => {
			assert.strictEqual(a.sparkPath([0, 0], 12, 12).d, 'M1 11L11 11');
			assert.strictEqual(a.sparkPath([], 12, 12).d, '');
			assert.strictEqual(a.sparkPath([null], 12, 12).d, '');
		});
	});

	describe('sortRows', () => {
		const rows = [{ id: 'a', v: 3 }, { id: 'b', v: null }, { id: 'c', v: 10 }, { id: 'd', v: 3 }, { id: 'e', v: 2.5 }];
		const get = r => r.v;
		it('descending, ties in the original order, no value last', () => {
			assert.deepStrictEqual(a.sortRows(rows, get, 'desc').map(r => r.id), ['c', 'a', 'd', 'e', 'b']);
		});
		it('ascending keeps no value last too', () => {
			assert.deepStrictEqual(a.sortRows(rows, get, 'asc').map(r => r.id), ['e', 'a', 'd', 'c', 'b']);
		});
		it('sorts suppressed counts by value()', () => {
			const r = [{ id: 'x', v: '<5' }, { id: 'y', v: 4 }, { id: 'z', v: 0 }];
			assert.deepStrictEqual(a.sortRows(r, x => a.value(x.v), 'desc').map(x => x.id), ['y', 'x', 'z']);
		});
		it('does not change the input', () => {
			const copy = rows.map(r => r.id);
			a.sortRows(rows, get, 'desc');
			assert.deepStrictEqual(rows.map(r => r.id), copy);
		});
		it('feature columns sort a features view', () => {
			const f = [
				{ title: 'B', section: 'markers', prs: [2], released: '2026-10-10', eligible: 40, exposed: 20, used: '<5', adoption: null, repeat: { pct: null }, optOut: null, masks: 0, spark: [0, '<5'] },
				{ title: 'a', section: 'general', prs: [], released: null, eligible: '36-39', exposed: 30, used: 12, adoption: { pct: 30 }, repeat: { pct: 50 }, optOut: { users: '<5', pct: null }, masks: '<3', spark: [5, 12] }
			];
			const col = key => a.FEATURE_COLS.filter(c => c.key === key)[0].get;
			assert.deepStrictEqual(a.sortRows(f, col('used'), 'desc').map(x => x.title), ['a', 'B']);
			assert.deepStrictEqual(a.sortRows(f, col('title'), 'asc').map(x => x.title), ['a', 'B']);
			assert.deepStrictEqual(a.sortRows(f, col('released'), 'desc').map(x => x.title), ['B', 'a']);
			assert.deepStrictEqual(a.sortRows(f, col('adoption'), 'asc').map(x => x.title), ['a', 'B']);
			assert.deepStrictEqual(a.sortRows(f, col('optOut'), 'desc').map(x => x.title), ['a', 'B']);
			assert.deepStrictEqual(a.sortRows(f, col('eligible'), 'desc').map(x => x.title), ['B', 'a']);
		});
	});

	describe('rotationNote', () => {
		it('empty without a salt replacement in the window', () => {
			assert.strictEqual(a.rotationNote({ rotation: null }, 'features'), '');
			assert.strictEqual(a.rotationNote(null, 'features'), '');
		});
		it('names the day, until when it counts people twice, and what the view does about it', () => {
			const r = { date: '2026-10-25', until: '2027-01-16' };
			const f = a.rotationNote({ rotation: r, repeatSince: '2026-10-25' }, 'features');
			assert.ok(f.includes('2026-10-25') && f.includes('2027-01-16') && f.includes('count twice') && f.includes('Repeat only counts use since'), f);
			assert.ok(a.rotationNote({ rotation: r }, 'funnel').includes('only uses data since 2026-10-25'));
			assert.ok(!a.rotationNote({ rotation: r }, 'launches').includes('Repeat'));
		});
	});

	describe('heatLevel and hours', () => {
		it('heatLevel scales 1-5 and keeps empty at 0', () => {
			assert.strictEqual(a.heatLevel(0, 20), 0);
			assert.strictEqual(a.heatLevel('<5', 20), 1);
			assert.strictEqual(a.heatLevel(20, 20), 5);
			assert.strictEqual(a.heatLevel(10, 20), 3);
			assert.strictEqual(a.heatLevel(3, 0), 0);
		});
		it('hours reads as minutes, hours or days', () => {
			assert.strictEqual(a.hours(0.5), '30 min');
			assert.strictEqual(a.hours(5.25), '5.3 h');
			assert.strictEqual(a.hours(72), '3 days');
		});
	});
});
