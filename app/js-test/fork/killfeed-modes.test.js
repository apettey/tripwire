const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/killfeed-modes');

describe('Kill panel display modes', () => {
	const km = () => killfeedModes;
	const SIZE = { x: 7, y: 6, minX: 4, minY: 3 };

	describe('normalize / modeOf', () => {
		it('keeps known modes and turns anything else into fixed', () => {
			assert.equal(km().normalize('fixed'), 'fixed');
			assert.equal(km().normalize('minimized'), 'minimized');
			assert.equal(km().normalize('floating'), 'floating');
			assert.equal(km().normalize(undefined), 'fixed');
			assert.equal(km().normalize('FLOATING'), 'fixed');
			assert.equal(km().normalize(null), 'fixed');
		});
		it('reads the mode from the options (missing = fixed)', () => {
			assert.equal(km().modeOf(undefined, 'systemKillFeed'), 'fixed');
			assert.equal(km().modeOf({}, 'systemKillFeed'), 'fixed');
			assert.equal(km().modeOf({ systemKillFeed: { enabled: false } }, 'systemKillFeed'), 'fixed');
			assert.equal(km().modeOf({ systemKillFeed: { mode: 'floating' } }, 'systemKillFeed'), 'floating');
			assert.equal(km().modeOf({ systemKillFeed: { mode: 'floating' } }, 'chainKillFeed'), 'fixed');
			assert.equal(km().modeOf({ chainKillFeed: 'minimized' }, 'chainKillFeed'), 'fixed');
		});
	});

	describe('merge', () => {
		it('keeps the other fields and does not mutate', () => {
			const current = { enabled: false, fullSizeY: 8 };
			const merged = km().merge(current, { mode: 'minimized' });
			assert.deepEqual(merged, { enabled: false, fullSizeY: 8, mode: 'minimized' });
			assert.deepEqual(current, { enabled: false, fullSizeY: 8 });
			assert.deepEqual(km().merge({ mode: 'floating', float: { left: 1 } }, { enabled: true }), { mode: 'floating', float: { left: 1 }, enabled: true });
		});
		it('starts from nothing for missing or broken values', () => {
			assert.deepEqual(km().merge(undefined, { mode: 'fixed' }), { mode: 'fixed' });
			assert.deepEqual(km().merge('x', { enabled: true }), { enabled: true });
			assert.deepEqual(km().merge([1], { enabled: true }), { enabled: true });
		});
	});

	describe('places (kept out of the mask-default keys)', () => {
		it('reads the place of a panel, {} when missing or broken', () => {
			assert.deepEqual(km().place({ killPanelPlaces: { k: { fullSizeY: 7 } } }, 'k'), { fullSizeY: 7 });
			assert.deepEqual(km().place({}, 'k'), {});
			assert.deepEqual(km().place(undefined, 'k'), {});
			assert.deepEqual(km().place({ killPanelPlaces: { k: [1] } }, 'k'), {});
		});
		it('merges into the entry of the panel and keeps the other panels, without mutating', () => {
			const opts = { killPanelPlaces: { a: { fullSizeY: 7 }, b: { float: { left: 1 } } }, a: { mode: 'fixed' } };
			const out = km().withPlace(opts, 'a', { float: { left: 5, top: 6, width: 300, height: 200 } });
			assert.deepEqual(out, { a: { fullSizeY: 7, float: { left: 5, top: 6, width: 300, height: 200 } }, b: { float: { left: 1 } } });
			assert.deepEqual(opts.killPanelPlaces.a, { fullSizeY: 7 });
			assert.deepEqual(km().withPlace({}, 'c', { fullSizeY: 5 }), { c: { fullSizeY: 5 } });
		});
		it('uses a key that is not a Settings row', () => {
			assert.equal(km().PLACES_KEY, 'killPanelPlaces');
		});
	});

	describe('minimized size', () => {
		it('reads the remembered full height', () => {
			const at = (v) => ({ killPanelPlaces: { k: v } });
			assert.equal(km().fullSizeY(at({ fullSizeY: 9 }), 'k', 3), 9);
			assert.equal(km().fullSizeY(at({ fullSizeY: '9' }), 'k', 3), 9);
			assert.equal(km().fullSizeY(at({ fullSizeY: 2 }), 'k', 3), null);
			assert.equal(km().fullSizeY(at({}), 'k', 3), null);
			assert.equal(km().fullSizeY({ k: { fullSizeY: 9 } }, 'k', 3), null);	// not in the panel's own (mask-default) key
			assert.equal(km().fullSizeY({ killPanelPlaces: 'x' }, 'k', 3), null);
			assert.equal(km().fullSizeY(undefined, 'k', 3), null);
		});
		it('is header plus one kill row (2 rows of 50 px + margin)', () => {
			assert.equal(km().MIN_SIZE_Y, 2);
			assert.equal(km().gridSizeY('minimized', { size_y: 8 }, 8, SIZE), 2);
			assert.equal(km().gridSizeY('minimized', null, null, SIZE), 2);
		});
		it('keeps a fixed panel at its saved height', () => {
			assert.equal(km().gridSizeY('fixed', { size_y: 8 }, 5, SIZE), 8);
			assert.equal(km().gridSizeY('fixed', { size_y: 3 }, null, SIZE), 3);
		});
		it('gives a fixed panel saved while minimized its full height back', () => {
			assert.equal(km().gridSizeY('fixed', { size_y: 2 }, 9, SIZE), 9);
			assert.equal(km().gridSizeY('fixed', { size_y: 2 }, null, SIZE), 6);
			assert.equal(km().gridSizeY('fixed', null, 9, SIZE), 9);
			assert.equal(km().gridSizeY('fixed', null, null, SIZE), 6);
		});
		it('remembers the height to restore', () => {
			assert.equal(km().rememberSizeY(8, null, SIZE), 8);
			assert.equal(km().rememberSizeY(3, 9, SIZE), 3);
			assert.equal(km().rememberSizeY(2, 9, SIZE), 9);	// already small: keep what was remembered
			assert.equal(km().rememberSizeY(2, null, SIZE), 6);
			assert.equal(km().rememberSizeY(undefined, 2, SIZE), 6);
		});
	});

	describe('header buttons', () => {
		it('offers minimize and float in fixed mode', () => {
			assert.deepEqual(km().buttons('fixed').map((b) => b.mode), ['minimized', 'floating']);
			assert.deepEqual(km().buttons(undefined).map((b) => b.mode), ['minimized', 'floating']);
		});
		it('offers restore and float when minimized', () => {
			assert.deepEqual(km().buttons('minimized').map((b) => b.mode), ['fixed', 'floating']);
		});
		it('offers dock when floating', () => {
			assert.deepEqual(km().buttons('floating').map((b) => b.mode), ['fixed']);
		});
		it('renders icons with tooltips', () => {
			const html = km().buttonsHtml('fixed');
			assert.ok(html.includes("data-mode='minimized'"));
			assert.ok(html.includes("data-icon='minus'"));
			assert.ok(html.includes("data-mode='floating'"));
			assert.ok(html.includes("data-tooltip='"));
		});
	});

	describe('settings choices', () => {
		it('lists the three modes, fixed first', () => {
			assert.deepEqual(km().choices(), [['fixed', 'Fixed'], ['minimized', 'Fixed and minimized'], ['floating', 'Floating']]);
		});
	});
});
