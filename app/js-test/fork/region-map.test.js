const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { include } = require('../helpers/helpers');
include('app/js/fork/region-map');

const DATA = path.join(__dirname, '..', '..', '..', 'public', 'region-map');
const readRegion = (id) => JSON.parse(fs.readFileSync(path.join(DATA, id + '.json'), 'utf8'));

// A tiny region: A - B - C in a row, B also has a gate to a system in another region; constellations 0 (A, B) and 1 (C)
const raw = {
	v: 1, id: 10, name: 'Testland', w: 400, h: 200,
	constellations: [[100, 'Alpha'], [101, 'Beta']],
	systems: [[1, 'AAA-A', 40, 40, 0, -0.4], [2, 'BBB-B', 140, 40, 0, 0.3], [3, 'CCC-C', 240, 40, 1, 0.9]],
	gates: [[1, 2], [2, 3]],
	links: [[2, 99, 11, 'Faraway', 0, -100]]
};

describe('regionMap layout loading', function() {
	it('turns a region file into scaled geometry', function() {
		const l = regionMap.normaliseRegion(raw);
		assert.strictEqual(l.name, 'Testland');
		assert.strictEqual(l.systems.length, 3);
		assert.strictEqual(l.byId[2].x, 140 * regionMap.SCALE);
		assert.strictEqual(l.edges.length, 2);
		assert.deepStrictEqual(l.constellations.map((c) => c.ids), [[1, 2], [3]]);
		assert.ok(l.w > l.byId[3].x && l.h > l.byId[3].y);
	});

	it('draws a gate that leaves the region as a stub pointing at the neighbour', function() {
		const s = regionMap.normaliseRegion(raw).stubs[0];
		assert.strictEqual(s.from, 2);
		assert.strictEqual(s.toRegionID, 11);
		assert.strictEqual(s.toName, 'Faraway');
		assert.ok(s.y2 < s.y1, 'north of the system');
		assert.ok(Math.abs(Math.hypot(s.x2 - s.x1, s.y2 - s.y1) - regionMap.STUB_LEN) < 1e-9);
		assert.ok(Math.abs(s.y1 - (regionMap.normaliseRegion(raw).byId[2].y - regionMap.BOX_H / 2)) < 1e-9, 'starts at the box edge');
	});

	it('ignores broken rows and refuses what is not a region file', function() {
		assert.strictEqual(regionMap.normaliseRegion(null), null);
		assert.strictEqual(regionMap.normaliseRegion({ id: 1, systems: [] }), null);
		assert.strictEqual(regionMap.normaliseRegion({ id: 1, systems: ['x', [1, 'a', 'b', 3]] }), null);
		const l = regionMap.normaliseRegion(Object.assign({}, raw, { gates: [[1, 2], [1, 777]], links: [[777, 1, 1, 'x', 1, 1], [1, 2, 3, 'y', 'a', 1]] }));
		assert.strictEqual(l.edges.length, 1);
		assert.strictEqual(l.stubs.length, 0);
	});

	it('hulls: the convex hull of a square with an inner point', function() {
		const h = regionMap.hull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, 5]]);
		assert.strictEqual(h.length, 4);
	});

	describe('the generated data files', function() {
		const index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));

		it('has one file per k-space region, with the counts the index states', function() {
			assert.ok(index.regions.length >= 60);
			index.regions.forEach(([id, name, n]) => {
				const file = readRegion(id);
				assert.strictEqual(file.id, id);
				assert.strictEqual(file.name, name);
				assert.strictEqual(file.systems.length, n);
				assert.ok(id < 11000000);
			});
		});

		it('every region loads, its gates and stubs refer to its own systems and its systems do not overlap', function() {
			const known = new Set(index.regions.map((r) => r[0]));
			index.regions.forEach(([id]) => {
				const file = readRegion(id);
				const l = regionMap.normaliseRegion(file);
				assert.ok(l, 'region ' + id + ' loads');
				assert.strictEqual(l.edges.length, file.gates.length, 'region ' + id + ' gates all resolve');
				file.links.forEach((link) => {
					assert.ok(l.byId[link[0]], 'stub starts inside ' + id);
					assert.ok(!l.byId[link[1]], 'stub ends outside ' + id);
					assert.ok(known.has(link[2]), 'neighbour region ' + link[2] + ' has a map');
				});
				const cells = new Set(file.systems.map((s) => s[2] + ',' + s[3]));
				assert.strictEqual(cells.size, file.systems.length, 'region ' + id + ': no two systems at one spot');
				file.systems.forEach((s) => {
					assert.ok(s[2] >= 0 && s[3] >= 0 && s[2] <= file.w && s[3] <= file.h, 'inside the canvas');
					assert.ok(s[4] >= 0 && s[4] < file.constellations.length);
				});
			});
		});

		it('knows Jita in The Forge and Delve as a null-sec region', function() {
			const forge = readRegion(10000002);
			assert.ok(forge.systems.some((s) => s[0] === 30000142 && s[1] === 'Jita'));
			const delve = readRegion(10000060);
			assert.ok(delve.systems.length > 90 && delve.systems.every((s) => s[5] <= 0.05));
		});
	});
});

describe('regionMap security colours', function() {
	it('rounds like the game', function() {
		assert.strictEqual(regionMap.secBucket(0.945913), 0.9);
		assert.strictEqual(regionMap.secBucket(0.04), 0.1);
		assert.strictEqual(regionMap.secBucket(-0.005), 0);
		assert.strictEqual(regionMap.secBucket(-1), 0);
		assert.strictEqual(regionMap.secBucket(1.2), 1);
		assert.strictEqual(regionMap.secBucket('x'), 0);
	});
	it('maps to the colour scale and the class', function() {
		assert.strictEqual(regionMap.secColour(1), '#2fefef');
		assert.strictEqual(regionMap.secColour(-0.3), '#f00000');
		assert.strictEqual(regionMap.secColour(0.5), '#efef00');
		assert.strictEqual(regionMap.secText(0.45), '0.5');
		assert.deepStrictEqual([0.9, 0.4, -0.2].map(regionMap.secClass), ['high', 'low', 'null']);
	});
});

describe('regionMap view maths', function() {
	const layout = { w: 2000, h: 1000 };
	it('fit shows everything, centred, never magnified', function() {
		const t = regionMap.fit(layout, 1000, 800);
		assert.ok(t.k < 0.5 && Math.abs(t.k - (1000 - 32) / 2000) < 1e-9);
		assert.ok(Math.abs(t.x + layout.w * t.k / 2 - 500) < 1e-9);
		assert.strictEqual(regionMap.fit({ w: 100, h: 100 }, 1000, 800).k, 1);
	});
	it('centreOn puts the point in the middle', function() {
		const t = regionMap.centreOn(300, 200, 2, 800, 600);
		assert.strictEqual(300 * t.k + t.x, 400);
		assert.strictEqual(200 * t.k + t.y, 300);
	});
	it('zoomAt keeps the point under the cursor and clamps', function() {
		const t0 = { k: 1, x: 10, y: 20 }, t1 = regionMap.zoomAt(t0, 300, 200, 2);
		assert.strictEqual(t1.k, 2);
		assert.strictEqual((300 - t0.x) / t0.k * t1.k + t1.x, 300);
		assert.strictEqual(regionMap.zoomAt(t0, 0, 0, 1000).k, regionMap.MAX_ZOOM);
		assert.strictEqual(regionMap.zoomAt(t0, 0, 0, 1e-6).k, regionMap.MIN_ZOOM);
	});
});

describe('regionMap wheel and pan', function() {
	it('honours deltaMode and caps one event', function() {
		const px = regionMap.wheelFactor(-100, 0), lines = regionMap.wheelFactor(-3, 1), pages = regionMap.wheelFactor(-1, 2);
		assert.ok(px > 1 && Math.abs(px - Math.exp(0.16)) < 1e-9);
		assert.ok(Math.abs(lines - Math.exp(3 * 16 * 0.0016)) < 1e-9, 'Firefox line wheel zooms like pixels');
		assert.ok(pages <= Math.exp(300 * 0.0016) + 1e-9 && pages > 1, 'a page is capped');
		assert.ok(regionMap.wheelFactor(5000, 0) >= Math.exp(-0.48) - 1e-9);
		assert.ok(regionMap.wheelFactor(100, 0) < 1);
		assert.strictEqual(regionMap.wheelFactor(0, 0), 1);
		assert.strictEqual(regionMap.wheelFactor('x', 1), 1);
	});
	it('keeps part of the map in view', function() {
		const layout = { w: 1000, h: 800 };
		const far = regionMap.clampPan({ k: 1, x: 5000, y: -5000 }, layout, 900, 600);
		assert.deepStrictEqual([far.x, far.y], [820, -720]);
		const other = regionMap.clampPan({ k: 0.5, x: -5000, y: 5000 }, layout, 900, 600);
		assert.deepStrictEqual([other.x, other.y], [80 - 500, 520]);
		assert.deepStrictEqual(regionMap.clampPan({ k: 1, x: 10, y: 20 }, layout, 900, 600), { k: 1, x: 10, y: 20 });
	});
	it('shortens long hole names in the pill', function() {
		assert.strictEqual(regionMap.pillText('B2'), 'B2');
		assert.strictEqual(regionMap.pillText('DRIFTERX'), 'DRIFTE');
		assert.strictEqual(regionMap.pillText(null), '');
	});
});

describe('regionMap overlays', function() {
	const layout = regionMap.normaliseRegion(raw);

	it('highlights the chain exits in this region with their hole names', function() {
		const chainSystems = {
			2: { pathHome: [{ name: 'A1' }, { name: 'b2 - drifter' }] },
			3: { pathHome: [{ name: 'A1' }, { name: '' }] },
			55: { pathHome: [{ name: 'Z9' }] }
		};
		const exits = regionMap.exitsIn(layout, ['2', 3, '55', '31000001'], chainSystems);
		assert.deepStrictEqual(exits, [{ systemID: 2, hole: 'B2' }, { systemID: 3, hole: '' }]);
		assert.deepStrictEqual(regionMap.exitsIn(layout, [], chainSystems), []);
		assert.deepStrictEqual(regionMap.exitsIn(layout, ['2'], null), [{ systemID: 2, hole: '' }]);
		assert.strictEqual(regionMap.exitHole(2, chainSystems), 'B2');
		assert.strictEqual(regionMap.exitHole(9, chainSystems), '');
		assert.strictEqual(regionMap.holeLabel('  cd7 x'), 'CD7');
		assert.strictEqual(regionMap.holeLabel(null), '');
	});

	it('scales heat logarithmically, never hotter than the busiest, and not hot in a quiet region', function() {
		assert.strictEqual(regionMap.heatLevel(0, 100, 60), 0);
		assert.strictEqual(regionMap.heatLevel(-5, 100, 60), 0);
		assert.strictEqual(regionMap.heatLevel(100, 100, 60), 1);
		assert.strictEqual(regionMap.heatLevel(500, 100, 60), 1);
		const mid = regionMap.heatLevel(10, 100, 60);
		assert.ok(mid > 0.4 && mid < 0.6, 'log scale: ' + mid);
		assert.ok(regionMap.heatLevel(3, 3, 60) < 0.4, 'a quiet region stays cool');
		assert.ok(regionMap.heatLevel(1, 1000, 60) < regionMap.heatLevel(10, 1000, 60));
	});

	it('builds the heat of a region from the activity data', function() {
		const activity = { 1: { npcKills: 200, shipKills: 1, shipJumps: 5 }, 2: { npcKills: 20, shipJumps: 90 }, 9: { npcKills: 999 } };
		const npc = regionMap.heatMap('npc', [1, 2, 3], activity);
		assert.deepStrictEqual(Object.keys(npc.values), ['1', '2']);
		assert.strictEqual(npc.max, 200);
		assert.strictEqual(npc.levels[1], 1);
		assert.ok(npc.levels[2] > 0 && npc.levels[2] < 1);
		assert.strictEqual(regionMap.heatMap('jumps', [1, 2, 3], activity).values[2], 90);
		assert.strictEqual(regionMap.heatMap('ships', [1, 2, 3], activity).values[1], 1);
		assert.deepStrictEqual(regionMap.heatMap('none', [1], activity), { levels: {}, values: {}, max: 0 });
		assert.deepStrictEqual(regionMap.heatMap('constructor', [1], activity).values, {});
		assert.deepStrictEqual(regionMap.heatMap('npc', [1], null).values, {});
	});

	it('shows pilots and you', function() {
		assert.deepStrictEqual(regionMap.pilots([{ systemID: 2, count: 3 }, { systemID: 3, count: '0' }, { systemID: 'x', count: 1 }], 2),
			{ 2: { count: 3, you: true } });
		assert.deepStrictEqual(regionMap.pilots(null, 3), { 3: { count: 0, you: true } });
		assert.deepStrictEqual(regionMap.pilots([{ systemID: 1, count: 2 }], null), { 1: { count: 2, you: false } });
	});

	it('routes with the preferences Tripwire already applied (guidance) and turns the answer into real ids', function() {
		const calls = [];
		const find = (map, a, b) => { calls.push([a, b]); return [a - 30000000, 2, b - 30000000].map((n) => (n < 30000000 ? n : n)); };
		assert.strictEqual(regionMap.route(find, {}, 0, 5), null);
		assert.deepStrictEqual(regionMap.route(find, {}, 30000001, 30000001), { path: [30000001], jumps: 0 });
		const stub = () => [1, 2, 3];
		assert.deepStrictEqual(regionMap.route(stub, {}, 30000001, 30000003), { path: [30000001, 30000002, 30000003], jumps: 2 });
		assert.strictEqual(regionMap.route(() => null, {}, 30000001, 30000003), null);
		assert.strictEqual(regionMap.route(() => [1, 'x'], {}, 30000001, 30000003), null);
	});

	it('finds the nearest exit with one search from the target and turns it round', function() {
		const seen = [];
		const find = (map, from, to) => { seen.push([from, to]); return [3, 2, 1]; };	// target 3 ... exit 1
		const r = regionMap.routeFromAny(find, {}, ['30000001', 30000009], 30000003);
		assert.deepStrictEqual(r, { path: [30000001, 30000002, 30000003], jumps: 2, exit: 30000001 });
		assert.deepStrictEqual(seen, [[3, [1, 9]]]);
		assert.deepStrictEqual(regionMap.routeFromAny(find, {}, [30000003], 30000003), { path: [30000003], jumps: 0, exit: 30000003 });
		assert.strictEqual(regionMap.routeFromAny(find, {}, [], 30000003), null);
		assert.strictEqual(regionMap.routeFromAny(() => null, {}, [30000001], 30000003), null);
	});

	it('splits a route into the gates drawn in this region', function() {
		const l = regionMap.normaliseRegion(raw);
		const r = regionMap.routeInside(l, [99, 1, 2, 3, 98]);
		assert.deepStrictEqual(r.edges, [[1, 2], [2, 3]]);
		assert.deepStrictEqual(Object.keys(r.ids), ['1', '2', '3']);
	});
});

describe('regionMap settings', function() {
	it('defaults: on, every overlay on, no heat', function() {
		const s = regionMap.settings({});
		assert.strictEqual(s.enabled, true);
		assert.strictEqual(s.heat, 'none');
		assert.deepStrictEqual(Object.keys(s.overlays), regionMap.OVERLAYS);
		assert.ok(Object.values(s.overlays).every(Boolean));
		assert.strictEqual(regionMap.settings(null).enabled, true);
	});
	it('reads saved choices and ignores junk', function() {
		const s = regionMap.settings({ regionMap: { enabled: false, overlays: { route: false }, heat: 'npc' } });
		assert.strictEqual(s.enabled, false);
		assert.strictEqual(s.overlays.route, false);
		assert.strictEqual(s.overlays.exits, true);
		assert.strictEqual(s.heat, 'npc');
		assert.strictEqual(regionMap.settings({ regionMap: { heat: 'toString' } }).heat, 'none');
		assert.strictEqual(regionMap.settings({ regionMap: 5 }).enabled, true);
	});
	it('changes one part and keeps the rest', function() {
		const o = { regionMap: { overlays: { pilots: false }, heat: 'jumps' } };
		const a = regionMap.withSetting(o, { enabled: false });
		assert.deepStrictEqual([a.enabled, a.overlays.pilots, a.heat], [false, false, 'jumps']);
		const b = regionMap.withSetting(o, { overlay: { name: 'fight', on: false } });
		assert.deepStrictEqual([b.enabled, b.overlays.fight, b.overlays.pilots, b.heat], [true, false, false, 'jumps']);
		assert.strictEqual(regionMap.withSetting(o, { heat: 'bogus' }).heat, 'jumps');
		assert.strictEqual(regionMap.withSetting(o, { overlay: { name: '__proto__', on: true } }).overlays.__proto__, Object.prototype);
	});
	it('skyhooks overlay: on by default, can be turned off', function() {
		assert.strictEqual(regionMap.settings({}).overlays.skyhooks, true);
		assert.strictEqual(regionMap.withSetting({}, { overlay: { name: 'skyhooks', on: false } }).overlays.skyhooks, false);
	});
	it('side lists: open by default, collapsed state kept when something else changes', function() {
		assert.deepStrictEqual(regionMap.settings({}).collapsed, { skyhooks: false });
		const c = regionMap.withSetting({}, { collapsed: { name: 'skyhooks', on: true } });
		assert.strictEqual(c.collapsed.skyhooks, true);
		assert.strictEqual(regionMap.withSetting({ regionMap: c }, { heat: 'npc' }).collapsed.skyhooks, true);
		assert.strictEqual(regionMap.withSetting({}, { collapsed: { name: 'bogus', on: true } }).collapsed.bogus, undefined);
	});
});

describe('regionMap command arguments', function() {
	const systems = {
		30000142: { name: 'Jita', security: 0.95, regionID: 10000002 },
		30002187: { name: 'Amarr', security: 1, regionID: 10000043 },
		30004759: { name: '1DQ1-A', security: -0.3, regionID: 10000060 },
		30004760: { name: 'Delvian', security: -0.2, regionID: 10000060 },
		30004761: { name: 'Delvaux', security: -0.1, regionID: 10000060 },
		31000005: { name: 'J123456', security: -0.99, regionID: 11000001, class: 3 }
	};
	const regions = { 10000002: { name: 'The Forge' }, 10000043: { name: 'Domain' }, 10000060: { name: 'Delve' }, 11000001: { name: 'A-R00001' } };

	it('lists regions first, then k-space systems, no wormhole space', function() {
		const c = regionMap.choices(systems, regions);
		assert.deepStrictEqual(c.map((x) => x.value), ['r:10000060', 'r:10000043', 'r:10000002', 's:30004759', 's:30002187', 's:30004761', 's:30004760', 's:30000142']);
		assert.strictEqual(c[3].hint, '0.0 · Delve');
		assert.strictEqual(c[0].hint, 'Region');
	});
	it('parses a choice value', function() {
		assert.deepStrictEqual(regionMap.parseTarget('s:30000142'), { kind: 'system', id: 30000142 });
		assert.deepStrictEqual(regionMap.parseTarget(' r:10000060 '), { kind: 'region', id: 10000060 });
		['', null, undefined, 'x:1', 's:', 's:12a', 'Jita', 's:1;2'].forEach((v) => assert.strictEqual(regionMap.parseTarget(v), null, String(v)));
	});
	it('resolves typed text: exact name, then a unique start, systems before regions', function() {
		assert.deepStrictEqual(regionMap.resolveText('jita', systems, regions), { kind: 'system', id: 30000142 });
		assert.deepStrictEqual(regionMap.resolveText('Delve', systems, regions), { kind: 'region', id: 10000060 });
		assert.deepStrictEqual(regionMap.resolveText('the f', systems, regions), { kind: 'region', id: 10000002 });
		assert.deepStrictEqual(regionMap.resolveText('1dq', systems, regions), { kind: 'system', id: 30004759 });
		assert.strictEqual(regionMap.resolveText('delv', systems, regions), null, 'Delvian and Delvaux: ambiguous');
		assert.strictEqual(regionMap.resolveText('J123456', systems, regions), null, 'wormhole space has no region map');
		assert.strictEqual(regionMap.resolveText('', systems, regions), null);
		assert.strictEqual(regionMap.resolveText('zzz', systems, regions), null);
	});
	it('turns a target into the region to load and the system to centre on', function() {
		assert.deepStrictEqual(regionMap.targetRegion({ kind: 'system', id: 30000142 }, systems), { regionID: 10000002, systemID: 30000142 });
		assert.deepStrictEqual(regionMap.targetRegion({ kind: 'region', id: 10000060 }, systems), { regionID: 10000060, systemID: null });
		assert.strictEqual(regionMap.targetRegion({ kind: 'system', id: 31000005 }, systems), null);
		assert.strictEqual(regionMap.targetRegion({ kind: 'system', id: 1 }, systems), null);
		assert.strictEqual(regionMap.targetRegion(null, systems), null);
	});
	it('only k-space systems can open the map', function() {
		assert.strictEqual(regionMap.canOpen(systems[30000142]), true);
		assert.strictEqual(regionMap.canOpen(systems[31000005]), false);
		assert.strictEqual(regionMap.canOpen(undefined), false);
	});
});
