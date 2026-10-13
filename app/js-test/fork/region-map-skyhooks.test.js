const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/skyhooks-panel');
include('app/js/fork/region-map-skyhooks');

const rs = regionMapSkyhooks;
const T = Date.UTC(2026, 9, 13, 15, 0, 0) / 1000;   // 2026-10-13 15:00 UTC
const sh = (systemID, startOffset, endOffset, planetID) => ({ planetID: planetID || systemID * 10, systemID, start: T + startOffset, end: T + endOffset });
const systems = {
	1: { name: 'Alpha', security: -0.3, regionID: 100 }, 2: { name: 'Beta', security: 0.3, regionID: 100 },
	3: { name: 'Gamma', security: -0.5, regionID: 200 }, 4: { name: 'Delta', security: -0.1, regionID: 300 }, 5: { name: 'Eps', security: -0.2, regionID: 400 }
};
const systemFor = id => systems[id] || null;
const planets = {
	reagents: { 1: { name: 'Magmatic Gas', price: 2000 }, 2: { name: 'Superionic Ice', price: 5000 } },
	lavaCuts: [900000, 1100000, 1300000],
	planets: { 10: [1, 1400, 4], 11: [2, 40, 9], 20: [1, 800, 2], 30: [1, 1000, 1], 40: [2, 30, 3] }
};
const S = saved => skyhooksPanel.settings(saved);
const list = [sh(1, -60, 3600, 10), sh(1, 3000, 9000, 11), sh(2, 600, 7800, 20), sh(3, -10, 50, 30), sh(4, 86400, 90000, 40), sh(5, -100, -1, 50)];

describe('Region map skyhooks', () => {
	describe('bySystem', () => {
		const by = rs.bySystem(list, systemFor, T, S({}), planets);
		it('groups the skyhooks passing the filters per system (closed and far ones out)', () => {
			assert.deepEqual(Object.keys(by).map(Number).sort(), [1, 2, 3]);
			assert.equal(by[1].items.length, 2);
		});
		it('now / soon counts and state', () => {
			assert.deepEqual([by[1].open, by[1].soon, by[1].state], [1, 1, 'open']);
			assert.deepEqual([by[2].open, by[2].soon, by[2].state], [0, 1, 'soon']);
		});
		it('best value rating of the system and the latest window end', () => {
			assert.equal(by[1].rating, 5);	// lava 1400/h = 1.4M raidable: top quartile
			assert.equal(by[2].rating, 2);
			assert.equal(by[1].lastEnd, T + 9000);
		});
		it('items sorted by window start, with the planet', () => {
			assert.deepEqual(by[1].items.map(i => i.planetID), [10, 11]);
			assert.equal(by[1].items[0].planet.name, 'Alpha IV');
			assert.equal(by[1].items[1].planet.kind, 'ice');
		});
		it('filters: window now, security, planet kind', () => {
			assert.deepEqual(Object.keys(rs.bySystem(list, systemFor, T, S({ window: 'now' }), planets)).map(Number).sort(), [1, 3]);
			assert.deepEqual(Object.keys(rs.bySystem(list, systemFor, T, S({ low: false }), planets)).map(Number).sort(), [1, 3]);
			assert.equal(rs.bySystem(list, systemFor, T, S({ ice: false }), planets)[1].items.length, 1);
			assert.ok(rs.bySystem(list, systemFor, T, S({ window: 'all' }), planets)[4]);
		});
		it('garbage', () => assert.deepEqual(rs.bySystem(null, systemFor, T, S({}), planets), {}));
	});

	describe('marker', () => {
		const by = rs.bySystem(list, systemFor, T, S({}), planets);
		it('count and dollars', () => {
			assert.deepEqual(rs.marker(by[1]), { state: 'open', count: 2, dollars: '$$$$$', text: '2 $$$$$' });
			assert.deepEqual(rs.marker(by[2]), { state: 'soon', count: 1, dollars: '$$', text: '$$' });
		});
		it('no planet data: no dollars', () => {
			const m = rs.marker(rs.bySystem(list, systemFor, T, S({}), null)[1]);
			assert.equal(m.text, '2');
		});
		it('nothing: no marker', () => {
			assert.equal(rs.marker(undefined), null);
			assert.equal(rs.marker({ items: [] }), null);
		});
	});

	describe('texts', () => {
		const by = rs.bySystem(list, systemFor, T, S({}), planets);
		it('one line per skyhook: planet, kind, window (EVE time), countdown, value', () => {
			assert.equal(rs.itemText(by[1].items[0], T), 'Planet IV, Lava: 14:59–16:00 EVE time, open now, 1h00m left, $$$$$ (~1.4M ISK/h)');
			assert.equal(rs.itemText(by[2].items[0], T), 'Planet II, Lava: 15:10–17:10 EVE time, opens in 10m, $$ (~800k ISK/h)');
		});
		it('tooltip', () => {
			const t = rs.tooltip(by[1], T);
			assert.equal(t[0], '2 raidable skyhooks:');
			assert.equal(t.length, 3);
		});
		it('unknown planet', () => {
			const e = rs.bySystem([sh(1, -10, 100, 777)], systemFor, T, S({}), planets)[1];
			assert.equal(rs.itemText(e.items[0], T), 'Planet: 14:59–15:01 EVE time, open now, 1m left');
		});
	});

	describe('region list', () => {
		const by = rs.bySystem(list, systemFor, T, S({ window: 'all' }), planets);
		const jumps = { 1: { jumps: 4 }, 2: { jumps: 1 } };
		it('only systems of the region, one row per skyhook, by jumps (unknown last)', () => {
			assert.deepEqual(rs.regionRows(by, [1, 2, 3], jumps, 'jumps').map(r => r.skyhook.planetID), [20, 10, 11, 30]);
		});
		it('by window start', () => assert.deepEqual(rs.regionRows(by, [1, 2], jumps, 'start').map(r => r.skyhook.planetID), [10, 20, 11]));
		it('by value', () => assert.deepEqual(rs.regionRows(by, [1, 2], jumps, 'value').map(r => r.skyhook.planetID), [10, 20, 11]));
		it('neighbouring regions: counts of the regions the gates lead to', () => {
			assert.deepEqual(rs.neighbours(by, [200, 300, 300, 999], systems), [{ regionID: 200, count: 1 }, { regionID: 300, count: 1 }]);
			assert.deepEqual(rs.neighbours(by, [], systems), []);
		});
	});

	describe('staging scan tag', () => {
		const by = rs.bySystem(list, systemFor, T, rs.stagingSettings(S({ window: 'now' })), planets);
		it('"now" wins, else "soon"', () => {
			assert.equal(rs.stagingTag(by[1]), '⚓1 now');
			assert.equal(rs.stagingTag(by[2]), '⚓1 soon');
			assert.equal(rs.stagingTag(undefined), '');
		});
		it('always now-or-soon, whatever the map shows', () => assert.equal(rs.stagingSettings(S({ window: 'all' })).window, 'soon'));
	});

	it('signature changes when a window opens', () => {
		const ids = [1, 2, 3];
		const a = rs.signature(rs.bySystem(list, systemFor, T, S({}), planets), ids);
		const b = rs.signature(rs.bySystem(list, systemFor, T + 700, S({}), planets), ids);
		assert.notEqual(a, b);
		assert.equal(a, rs.signature(rs.bySystem(list, systemFor, T + 5, S({}), planets), ids));
	});

	it('withFilter keeps the other keys and only takes filter keys', () => {
		assert.deepEqual(rs.withFilter({ enabled: false, sort: 'value' }, { window: 'now', enabled: true, evil: 1 }), { enabled: false, sort: 'value', window: 'now' });
		assert.deepEqual(rs.withFilter(undefined, { lava: false }), { lava: false });
	});

	describe('the retired box', () => {
		const w = (id, col) => ({ id: id, col: col, row: 1, size_x: 2, size_y: 2 });
		it('its layout entry is dropped (array, object and old oog form)', () => {
			assert.deepEqual(rs.withoutOldWidget([w('chainWidget', 1), w('skyhooksWidget', 5)]), [w('chainWidget', 1)]);
			assert.deepEqual(rs.withoutOldWidget({ 0: w('chainWidget', 1), 1: w('skyhooksWidget', 5) }), { 0: w('chainWidget', 1) });
			assert.deepEqual(rs.withoutOldWidget({ oog: { a: w('skyhooksWidget', 5), b: w('x', 1) } }), { oog: { b: w('x', 1) } });
			assert.deepEqual(rs.withoutOldWidget([w('skyhooksWidget-removed', 2)]), []);
		});
		it('never mutates, leaves other layouts alone', () => {
			const g = [w('skyhooksWidget', 5)];
			rs.withoutOldWidget(g);
			assert.equal(g.length, 1);
			assert.equal(rs.withoutOldWidget(null), null);
			assert.equal(rs.hasOldWidget([w('chainWidget', 1)]), false);
		});
		it('cleanOptions drops the entry and the saved position, keeps the filters', () => {
			const o = { grid: [w('chainWidget', 1), w('skyhooksWidget', 5)], skyhooksPanel: { position: { col: 3 }, window: 'now' } };
			assert.equal(rs.cleanOptions(o), true);
			assert.deepEqual(o.grid, [w('chainWidget', 1)]);
			assert.deepEqual(o.skyhooksPanel, { window: 'now' });
			assert.equal(rs.cleanOptions(o), false);
			assert.equal(rs.cleanOptions(null), false);
		});
	});
});
