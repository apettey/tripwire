const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/getting-started');

describe('gettingStarted', () => {
	describe('shouldShow', () => {
		it('a new account', () => {
			assert.strictEqual(gettingStarted.shouldShow({}, 0), true);
			assert.strictEqual(gettingStarted.shouldShow({}, 13), true);
		});
		it('never for accounts 14 days or older', () => assert.strictEqual(gettingStarted.shouldShow({}, 14), false));
		it('not when the age is unknown (server failed)', () => {
			[null, undefined, 'x', NaN, -1].forEach(a => assert.strictEqual(gettingStarted.shouldShow({}, a), false, String(a)));
		});
		it('not once hidden', () => assert.strictEqual(gettingStarted.shouldShow({ gettingStarted: { hidden: true } }, 1), false));
		it('collapsed still shows', () => assert.strictEqual(gettingStarted.shouldShow({ gettingStarted: { collapsed: true, done: ['tab'] } }, 1), true));
	});

	describe('stateOf', () => {
		it('defaults', () => assert.deepStrictEqual(gettingStarted.stateOf(null), { hidden: false, collapsed: false, done: [] }));
		it('keeps only string ids', () => assert.deepStrictEqual(gettingStarted.stateOf({ gettingStarted: { done: ['tab', 3, null] } }).done, ['tab']));
	});

	describe('detect (each step ticks from real state)', () => {
		const base = { done: [], activeMask: '98000001.2', defaultMask: '98000001.2', masks: ['0.0', '12345.1', '98000001.2'], tabs: [], trackedCount: 0, autoMapper: false, paletteUsed: false };
		const on = s => Object.keys(gettingStarted.detect(Object.assign({}, base, s))).filter(k => gettingStarted.detect(Object.assign({}, base, s))[k]);

		it('nothing done on a fresh account', () => assert.deepStrictEqual(on({}), []));
		it('mask: another mask than the corp default', () => {
			assert.deepStrictEqual(on({ activeMask: '12345.1' }), ['mask']);
			assert.deepStrictEqual(on({ defaultMask: null, activeMask: '12345.1' }), [], 'default unknown: not guessed');
			assert.deepStrictEqual(on({ activeMask: 'undefined.2' }), [], 'a placeholder of unsaved options is not a choice');
		});
		it('tab: a tab with a home system (not a whole-chain tab)', () => {
			assert.deepStrictEqual(on({ tabs: [{ systemID: 0, name: 'all' }, { systemID: '0', name: 'all' }] }), []);
			assert.deepStrictEqual(on({ tabs: [{ systemID: '31000005', name: 'Home' }] }), ['tab']);
			assert.deepStrictEqual(on({ tabs: [null] }), []);
		});
		it('tracking: a tracked character and the auto-mapper on, both', () => {
			assert.deepStrictEqual(on({ trackedCount: 1 }), []);
			assert.deepStrictEqual(on({ autoMapper: true }), []);
			assert.deepStrictEqual(on({ trackedCount: 2, autoMapper: true }), ['tracking']);
		});
		it('palette: Ctrl+K used', () => assert.deepStrictEqual(on({ paletteUsed: true }), ['palette']));
		it('paste: only from the paste event (already ticked)', () => assert.deepStrictEqual(on({ done: ['paste'] }), ['paste']));
		it('ticked steps stay ticked (a tab removed later)', () => assert.deepStrictEqual(on({ done: ['tab', 'mask'] }), ['mask', 'tab']));
	});

	describe('corpMask', () => {
		it('the corp mask from init.masks', () => assert.strictEqual(gettingStarted.corpMask([
			{ mask: '0.0', ownerType: 'global', type: 'default' }, { mask: '9.1', ownerType: 'personal', type: 'default' },
			{ mask: '1000167.2', ownerType: 'corporate', type: 'default' }]), '1000167.2'));
		it('unknown', () => {
			assert.strictEqual(gettingStarted.corpMask(null), null);
			assert.strictEqual(gettingStarted.corpMask([{ mask: '5.0', ownerType: 'corporate', type: 'owned' }]), null);
		});
	});

	describe('newlyDone and count', () => {
		it('only what is new, in item order', () =>
			assert.deepStrictEqual(gettingStarted.newlyDone(['tab'], { palette: true, tab: true, mask: true }), ['mask', 'palette']));
		it('count ignores unknown ids', () => assert.strictEqual(gettingStarted.count(['tab', 'x', 'palette']), 2));
	});

	describe('html', () => {
		it('collapsed: one line with the count', () => {
			const h = gettingStarted.html({ collapsed: true, done: ['tab', 'mask'] });
			assert.ok(h.includes('Getting started') && h.includes('2/5') && h.includes('gs-hide'));
			assert.ok(!h.includes('gs-list'));
		});
		it('open: five steps, How only on the ones to do', () => {
			const h = gettingStarted.html({ collapsed: false, done: ['palette'] });
			assert.strictEqual((h.match(/class='gs-item/g) || []).length, 5);
			assert.strictEqual((h.match(/class='gs-how'/g) || []).length, 4);
			assert.ok(h.includes("gs-item gs-done' data-item='palette'"));
			assert.ok(!h.includes('All set'));
		});
		it('all done', () => assert.ok(gettingStarted.html({ collapsed: false, done: gettingStarted.ITEMS.map(i => i.id) }).includes('All set')));
	});
});
