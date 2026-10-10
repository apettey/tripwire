const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/tripwire/genericSystemTypes');
include('app/js/wormholeAnalysis');
include('app/js/systemAnalysis');
jQuery = { fn: {} };
include('app/js/helpers');
include('app/js/fork/sig-quickpicks');

describe('Signature dialog quick picks', () => {
	const J004470 = 31002539;	// C4, statics U210, C247, X877
	const JITA = 30000142;	// High-Sec, no statics
	const keys = list => list.map(x => x.key);

	describe('Leads To empty', () => {
		const picks = sigQuickPicks.compute(J004470, '');
		it('shows the statics in data order', () => assert.deepEqual(keys(picks.from), ['U210', 'C247', 'X877']));
		it('marks them as static', () => assert.ok(picks.from.every(x => x.static)));
		it('other side is K162', () => assert.deepEqual(keys(picks.to), ['K162']));
		it('whitespace counts as empty', () => assert.deepEqual(keys(sigQuickPicks.compute(J004470, '  ').from), ['U210', 'C247', 'X877']));
		it('unrecognised text behaves like empty', () => assert.deepEqual(keys(sigQuickPicks.compute(J004470, 'J00').from), ['U210', 'C247', 'X877']));
		it('k-space system has no statics', () => assert.deepEqual(sigQuickPicks.compute(JITA, ''), { from: [], to: [{ key: 'K162', static: false, frig: false }] }));
		it('string system ID works', () => assert.deepEqual(keys(sigQuickPicks.compute('31002539', '').from), ['U210', 'C247', 'X877']));
	});

	describe('Leads To set', () => {
		it('class: static first, then other eligible', () => {
			const picks = sigQuickPicks.compute(J004470, 'Class-3');
			assert.deepEqual(picks.from, [{ key: 'C247', static: true, frig: false }, { key: 'Z006', static: false, frig: true }]);
			assert.deepEqual(keys(picks.to), ['T405', 'M001']);
		});
		it('Low-Sec: matching static first', () => {
			const picks = sigQuickPicks.compute(J004470, 'Low-Sec');
			assert.deepEqual(keys(picks.from), ['U210', 'N290', 'J492']);
			assert.deepEqual(picks.from.map(x => x.static), [true, false, false]);
		});
		it('High-Sec: no static matches', () => {
			const picks = sigQuickPicks.compute(J004470, 'High-Sec');
			assert.deepEqual(keys(picks.from), ['S047', 'D845']);
			assert.ok(picks.from.every(x => !x.static));
			assert.deepEqual(keys(picks.to), ['O128']);
		});
		it('from High-Sec system to a class', () => assert.deepEqual(sigQuickPicks.compute(JITA, 'Class-3'),
			{ from: [{ key: 'X702', static: false, frig: false }], to: [{ key: 'D845', static: false, frig: false }] }));
		it('from High-Sec to a specific system', () => {
			const picks = sigQuickPicks.compute(JITA, 'J004470');
			assert.deepEqual(keys(picks.from), ['O128']);
			assert.deepEqual(keys(picks.to), ['S047', 'D845']);
		});
	});

	describe('Ordering and cap', () => {
		const eligible = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'S1', 'A7', 'S2'].map(k => ({ key: k }));
		it('statics first then the first others, up to 6', () => assert.deepEqual(keys(sigQuickPicks.orderAndCap(eligible, ['S2', 'S1'])), ['S1', 'S2', 'A1', 'A2', 'A3', 'A4']));
		it('no statics: first 6', () => assert.deepEqual(keys(sigQuickPicks.orderAndCap(eligible, [])), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']));
	});

	describe('Leads To fill for a static', () => {
		it('class destination', () => assert.equal(sigQuickPicks.leadsToFor('C247'), 'Class-3'));
		it('k-space destination', () => assert.equal(sigQuickPicks.leadsToFor('u210'), 'Low-Sec'));
		it('specific system destination is skipped', () => assert.equal(sigQuickPicks.leadsToFor('J377'), null));
		it('unknown type', () => assert.equal(sigQuickPicks.leadsToFor('K162'), null));
	});
});
