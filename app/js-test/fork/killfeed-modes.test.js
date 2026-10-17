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

	describe('floating geometry', () => {
		it('defaults to the right side under the top bar, the second panel under the first', () => {
			assert.deepEqual(km().defaultFloat(0, 1600, 900), { left: 1600 - 420 - 16, top: 60, width: 420, height: 360 });
			assert.deepEqual(km().defaultFloat(1, 1600, 900), { left: 1600 - 420 - 16, top: 60 + 370, width: 420, height: 360 });
		});
		it('uses the defaults for missing or invalid values', () => {
			assert.deepEqual(km().clampFloat(undefined, 1600, 900, 0), { left: 1164, top: 60, width: 420, height: 360 });
			assert.deepEqual(km().clampFloat({ left: 'x', top: null, width: NaN }, 1600, 900, 0), { left: 1164, top: 60, width: 420, height: 360 });
		});
		it('keeps a saved place that fits', () => {
			assert.deepEqual(km().clampFloat({ left: 100, top: 200, width: 500, height: 300 }, 1600, 900, 0), { left: 100, top: 200, width: 500, height: 300 });
		});
		it('moves a panel that is off screen back into the viewport', () => {
			assert.deepEqual(km().clampFloat({ left: 1500, top: 850, width: 400, height: 300 }, 1280, 800, 0), { left: 880, top: 500, width: 400, height: 300 });
			assert.deepEqual(km().clampFloat({ left: -50, top: -20, width: 400, height: 300 }, 1280, 800, 0), { left: 0, top: 0, width: 400, height: 300 });
		});
		it('shrinks a panel bigger than the viewport and keeps the minimum size', () => {
			assert.deepEqual(km().clampFloat({ left: 0, top: 0, width: 3000, height: 2000 }, 1280, 800, 0), { left: 0, top: 0, width: 1280, height: 800 });
			assert.deepEqual(km().clampFloat({ left: 10, top: 10, width: 50, height: 20 }, 1280, 800, 0), { left: 10, top: 10, width: 260, height: 140 });
		});
		it('copes with a viewport smaller than the minimum size', () => {
			assert.deepEqual(km().clampFloat({ left: 10, top: 10, width: 400, height: 300 }, 200, 100, 0), { left: 0, top: 0, width: 200, height: 100 });
		});
		it('fits the outer width (CSS width + border and padding) into the viewport', () => {
			assert.deepEqual(km().clampFloat({ left: 0, top: 0, width: 3000, height: 300 }, 1280, 800, 0, 6), { left: 0, top: 0, width: 1274, height: 300 });
			assert.deepEqual(km().clampFloat({ left: 1200, top: 0, width: 400, height: 300 }, 1280, 800, 0, 6), { left: 874, top: 0, width: 400, height: 300 });
			assert.deepEqual(km().clampFloat(undefined, 1600, 900, 0, 6), { left: 1600 - 420 - 6 - 16, top: 60, width: 420, height: 360 });
		});
		it('works in CSS pixels of a UI-scaled page (viewport divided by the zoom)', () => {
			// 1280x800 window at UI scale 1.4: 914x571 CSS pixels; the default window must open fully on screen
			const g = km().clampFloat(undefined, 1280 / 1.4, 800 / 1.4, 1, 6);
			assert.ok(g.left >= 0 && g.left + g.width + 6 <= 1280 / 1.4, JSON.stringify(g));
			assert.ok(g.top >= 0 && g.top + g.height <= 800 / 1.4, JSON.stringify(g));
		});
		it('rounds to whole pixels', () => {
			assert.deepEqual(km().clampFloat({ left: 10.4, top: 20.6, width: 300.2, height: 200.7 }, 1280, 800, 0), { left: 10, top: 21, width: 300, height: 201 });
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
