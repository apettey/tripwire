const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/layout-grid');
include('app/js/fork/panel-host');

describe('Panel host', () => {
	const ph = () => panelHost;
	const ID = 'systemKillFeedWidget';
	const SIZE = { x: 7, y: 6, minX: 4, minY: 3 };

	describe('registry', () => {
		beforeEach(() => { ph().panels = []; });
		after(() => { ph().panels = []; });
		it('lists panels in the order they registered, finds them by id', () => {
			const a = ph().register({ id: 'a', title: 'A', size: SIZE });
			ph().register({ id: 'b', title: 'B', floating: true });
			assert.strictEqual(ph().get('a'), a);
			assert.equal(ph().get('b').title, 'B');
			assert.equal(ph().get('c'), null);
			assert.deepEqual(ph().list().map(p => p.id), ['a', 'b']);
		});
		it('registering an id again replaces it; the list is a copy', () => {
			ph().register({ id: 'a', title: 'A' });
			ph().register({ id: 'a', title: 'A2' });
			assert.deepEqual(ph().list().map(p => p.title), ['A2']);
			ph().list().push({ id: 'x' });
			assert.equal(ph().list().length, 1);
		});
		it('ignores a panel without an id', () => {
			ph().register({ title: 'no id' });
			ph().register(null);
			assert.equal(ph().list().length, 0);
		});
	});

	describe('saved places', () => {
		const grid = [{ id: 'infoWidget', col: 1, row: 1, size_x: 7, size_y: 6 },
			{ id: ID, col: '22', row: '1', size_x: '5', size_y: '8' }];
		it('reads a saved position from a layout (array, object and old oog forms)', () => {
			const pos = { col: 22, row: 1, size_x: 5, size_y: 8 };
			assert.deepEqual(ph().savedPosition(grid, ID), pos);
			assert.deepEqual(ph().savedPosition({ 0: grid[1] }, ID), pos);
			assert.deepEqual(ph().savedPosition({ oog: [grid[1]] }, ID), pos);
		});
		it('has no saved position in layouts without the panel or with junk', () => {
			assert.equal(ph().savedPosition([grid[0]], ID), null);
			assert.equal(ph().savedPosition({}, ID), null);
			assert.equal(ph().savedPosition(null, ID), null);
			assert.equal(ph().savedPosition([{ id: ID, col: 0, row: 1, size_x: 7, size_y: 6 }], ID), null);
			assert.equal(ph().savedPosition([{ id: ID, col: 1, row: 1, size_x: 7 }], ID), null);
		});
		it('ignores the entry of a panel being removed', () => {
			assert.equal(ph().savedPosition([{ id: ID + '-removed', col: 3, row: 1, size_x: 7, size_y: 6 }], ID), null);
		});
		it('gridEntry returns the entry as stored', () => {
			const widgets = [{ id: 'infoWidget', col: 1 }, { id: 'notesWidget', col: 15 }];
			assert.equal(ph().gridEntry(widgets.concat([{ id: 'favouritesWidget', col: 3 }]), 'favouritesWidget').col, 3);
			assert.equal(ph().gridEntry({ 0: { id: 'favouritesWidget', col: 4 } }, 'favouritesWidget').col, 4);
			assert.equal(ph().gridEntry({ oog: [{ id: 'favouritesWidget', col: 5 }] }, 'favouritesWidget').col, 5);
			assert.equal(ph().gridEntry(widgets, 'favouritesWidget'), null);
			assert.equal(ph().gridEntry({}, 'favouritesWidget'), null);
		});
		it('remembers the place a panel was turned off at', () => {
			assert.deepEqual(ph().rememberedPosition({ intelScans: { enabled: false, position: { col: 15, row: 7, size_x: 7, size_y: 9 } } }, 'intelScans', 'intelScansWidget'),
				{ col: 15, row: 7, size_x: 7, size_y: 9 });
			assert.strictEqual(ph().rememberedPosition({ intelScans: { enabled: true } }, 'intelScans', 'intelScansWidget'), null);
			assert.strictEqual(ph().rememberedPosition({ intelScans: { position: { col: 0, row: 7 } } }, 'intelScans', 'intelScansWidget'), null);
			assert.strictEqual(ph().rememberedPosition(undefined, 'intelScans', 'intelScansWidget'), null);
		});
		it('atLeastMinSize raises the size to the minimum and rejects junk', () => {
			const min = { minX: 4, minY: 3 };
			assert.deepEqual(ph().atLeastMinSize({ col: '2', row: '3', size_x: 1, size_y: 9 }, min), { col: 2, row: 3, size_x: 4, size_y: 9 });
			assert.deepEqual(ph().atLeastMinSize({ col: 2, row: 3 }, min), { col: 2, row: 3, size_x: 4, size_y: 3 });
			assert.equal(ph().atLeastMinSize({ col: 0, row: 1 }, min), null);
			assert.equal(ph().atLeastMinSize(null, min), null);
		});
	});

	describe('default place', () => {
		const defaults = [{ col: 1, row: 1, size_x: 7, size_y: 6 }, { col: 8, row: 1, size_x: 7, size_y: 6 },
			{ col: 15, row: 1, size_x: 7, size_y: 6 }, { col: 1, row: 7, size_x: 21, size_y: 8 }];
		it('goes right of the top row on wide windows', () => {
			assert.deepEqual(ph().defaultPosition(defaults, 1920, SIZE), { col: 22, row: 1, size_x: 7, size_y: 6 });
		});
		it('goes under everything on narrow windows', () => {
			assert.deepEqual(ph().defaultPosition(defaults, 1280, SIZE), { col: 1, row: 15, size_x: 7, size_y: 6 });
			assert.deepEqual(ph().defaultPosition([], 0, SIZE), { col: 1, row: 1, size_x: 7, size_y: 6 });
		});
		it('uses the panel size', () => {
			assert.deepEqual(ph().defaultPosition(defaults, 1920, { x: 6, y: 6 }), { col: 22, row: 1, size_x: 6, size_y: 6 });
		});
	});

	describe('dropping a layout entry', () => {
		const w = (id, col) => ({ id: id, col: col, row: 1, size_x: 2, size_y: 2 });
		const id = 'skyhooksWidget';
		it('drops it from array, object and old oog forms, with its -removed twin', () => {
			assert.deepEqual(ph().withoutEntry([w('chainWidget', 1), w(id, 5)], id), [w('chainWidget', 1)]);
			assert.deepEqual(ph().withoutEntry({ 0: w('chainWidget', 1), 1: w(id, 5) }, id), { 0: w('chainWidget', 1) });
			assert.deepEqual(ph().withoutEntry({ oog: { a: w(id, 5), b: w('x', 1) } }, id), { oog: { b: w('x', 1) } });
			assert.deepEqual(ph().withoutEntry([w(id + '-removed', 2), w('b', 1)], id), [w('b', 1)]);
		});
		it('never mutates, leaves other layouts alone', () => {
			const g = [w('chainWidget', 1), w(id, 5)];
			ph().withoutEntry(g, id);
			assert.equal(g.length, 2);
			assert.equal(ph().withoutEntry(null, id), null);
		});
		it('hasEntry', () => {
			assert.strictEqual(ph().hasEntry([w('chainWidget', 1), w(id, 5)], id), true);
			assert.strictEqual(ph().hasEntry({ oog: { 0: w(id, 5) } }, id), true);
			assert.strictEqual(ph().hasEntry([w('chainWidget', 1)], id), false);
			assert.strictEqual(ph().hasEntry({}, id), false);
			assert.strictEqual(ph().hasEntry(undefined, id), false);
		});
	});

	describe('floating geometry', () => {
		it('defaults to the right side under the top bar, the second panel under the first', () => {
			assert.deepEqual(ph().defaultFloat(0, 1600, 900), { left: 1600 - 420 - 16, top: 60, width: 420, height: 360 });
			assert.deepEqual(ph().defaultFloat(1, 1600, 900), { left: 1600 - 420 - 16, top: 60 + 370, width: 420, height: 360 });
		});
		it('uses the defaults for missing or invalid values', () => {
			assert.deepEqual(ph().clampFloat(undefined, 1600, 900, 0), { left: 1164, top: 60, width: 420, height: 360 });
			assert.deepEqual(ph().clampFloat({ left: 'x', top: null, width: NaN }, 1600, 900, 0), { left: 1164, top: 60, width: 420, height: 360 });
		});
		it('keeps a saved place that fits', () => {
			assert.deepEqual(ph().clampFloat({ left: 100, top: 200, width: 500, height: 300 }, 1600, 900, 0), { left: 100, top: 200, width: 500, height: 300 });
		});
		it('moves a panel that is off screen back into the viewport', () => {
			assert.deepEqual(ph().clampFloat({ left: 1500, top: 850, width: 400, height: 300 }, 1280, 800, 0), { left: 880, top: 500, width: 400, height: 300 });
			assert.deepEqual(ph().clampFloat({ left: -50, top: -20, width: 400, height: 300 }, 1280, 800, 0), { left: 0, top: 0, width: 400, height: 300 });
		});
		it('shrinks a panel bigger than the viewport and keeps the minimum size', () => {
			assert.deepEqual(ph().clampFloat({ left: 0, top: 0, width: 3000, height: 2000 }, 1280, 800, 0), { left: 0, top: 0, width: 1280, height: 800 });
			assert.deepEqual(ph().clampFloat({ left: 10, top: 10, width: 50, height: 20 }, 1280, 800, 0), { left: 10, top: 10, width: 260, height: 140 });
		});
		it('copes with a viewport smaller than the minimum size', () => {
			assert.deepEqual(ph().clampFloat({ left: 10, top: 10, width: 400, height: 300 }, 200, 100, 0), { left: 0, top: 0, width: 200, height: 100 });
		});
		it('fits the outer width (CSS width + border and padding) into the viewport', () => {
			assert.deepEqual(ph().clampFloat({ left: 0, top: 0, width: 3000, height: 300 }, 1280, 800, 0, 6), { left: 0, top: 0, width: 1274, height: 300 });
			assert.deepEqual(ph().clampFloat({ left: 1200, top: 0, width: 400, height: 300 }, 1280, 800, 0, 6), { left: 874, top: 0, width: 400, height: 300 });
			assert.deepEqual(ph().clampFloat(undefined, 1600, 900, 0, 6), { left: 1600 - 420 - 6 - 16, top: 60, width: 420, height: 360 });
		});
		it('works in CSS pixels of a UI-scaled page (viewport divided by the zoom)', () => {
			// 1280x800 window at UI scale 1.4: 914x571 CSS pixels; the default window must open fully on screen
			const g = ph().clampFloat(undefined, 1280 / 1.4, 800 / 1.4, 1, 6);
			assert.ok(g.left >= 0 && g.left + g.width + 6 <= 1280 / 1.4, JSON.stringify(g));
			assert.ok(g.top >= 0 && g.top + g.height <= 800 / 1.4, JSON.stringify(g));
		});
		it('never reaches past a fractional viewport (UI scale), so the page cannot scroll', () => {
			// 1024x768 at UI scale 1.4: 731.43 x 548.57 CSS pixels
			const vw = 1024 / 1.4, vh = 768 / 1.4;
			const g = ph().clampFloat({ left: 0, top: 0, width: 3000, height: 3000 }, vw, vh, 0, 6);
			assert.deepEqual(g, { left: 0, top: 0, width: 725, height: 548 });
			assert.ok(g.left + g.width + 6 <= vw && g.top + g.height <= vh);
			const h = ph().clampFloat({ left: 5000, top: 5000, width: 300, height: 200 }, vw, vh, 0, 6.5);
			assert.ok(h.left + h.width + 6.5 <= vw && h.top + h.height <= vh, JSON.stringify(h));
		});
		it('rounds to whole pixels', () => {
			assert.deepEqual(ph().clampFloat({ left: 10.4, top: 20.6, width: 300.2, height: 200.7 }, 1280, 800, 0), { left: 10, top: 21, width: 300, height: 201 });
		});
	});
});
