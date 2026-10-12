const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { include } = require('../helpers/helpers');
include('app/js/fork/jump-range');
include('app/js/fork/region-map-jumps');

// Systems on a line (x in LY): origin 0, NS-near 3.9, NS-mid 4.1, HS 2, LS 7.9, NS-far 12 (two jumps via the one at 6),
// NS-mid2 6, Pochven 5, a wormhole system
const systems = {
	30000001: { name: 'Origin', security: -0.4, regionID: 10000060 },
	30000002: { name: 'Near', security: -0.3, regionID: 10000060 },
	30000003: { name: 'Mid', security: -0.2, regionID: 10000060 },
	30000004: { name: 'Safe', security: 0.9, regionID: 10000002 },
	30000005: { name: 'Low', security: 0.3, regionID: 10000060 },
	30000006: { name: 'Far', security: -0.5, regionID: 10000060 },
	30000007: { name: 'Halfway', security: -0.1, regionID: 10000060 },
	30000008: { name: 'Pochven', security: -0.6, regionID: 10000070, factionID: 500026 },
	31000001: { name: 'J100001', security: -0.99, regionID: 11000001, class: 3 }
};
const xs = { 30000001: 0, 30000002: 3.9, 30000003: 4.1, 30000004: 2, 30000005: 7.9, 30000006: 12, 30000007: 6, 30000008: 5, 31000001: 1 };
const coords = { ids: Object.keys(xs).map(Number), pos: {} };
coords.ids.forEach((id) => { coords.pos[id] = { x: xs[id], y: 0, z: 0 }; });
const index = jumpRange.buildIndex(coords, 7);
const ships = { ships: [
	{ typeID: 1, name: 'Panther', groupID: 898, group: 'Black Ops', baseLy: 4, covert: true },
	{ typeID: 2, name: 'Archon', groupID: 547, group: 'Carrier', baseLy: 3.5 },
	{ typeID: 3, name: 'Rhea', groupID: 902, group: 'Jump Freighter', baseLy: 5 }
] };
const presets = jumpRange.presets(ships);
const preset = (key) => jumpRange.preset(presets, key);
const ids = coords.ids;
const run = (key, jdc, origin = 30000001) => regionMapJumps.compute({ originID: origin, preset: preset(key), jdc, index, systems, ids });

describe('regionMapJumps range overlay', function() {
	it('Black Ops at JDC V reach 8 LY: low-sec and null-sec in range, high-sec / Pochven / wormhole never', function() {
		const r = run('group-898', 5);
		assert.strictEqual(r.range, 8);
		assert.strictEqual(r.label, 'Black Ops (JDC V)');
		const st = (id) => r.rows[id].state;
		assert.strictEqual(st(30000001), 'origin');
		assert.deepStrictEqual([30000002, 30000003, 30000005, 30000007].map(st), ['in', 'in', 'in', 'in']);
		assert.strictEqual(st(30000004), 'bad', 'high-sec');
		assert.strictEqual(st(30000008), 'bad', 'Pochven');
		assert.strictEqual(st(31000001), 'bad', 'wormhole space');
		assert.strictEqual(st(30000006), 'out');
		assert.strictEqual(r.inRange, 4);
	});

	it('distances are straight-line LY', function() {
		const r = run('group-898', 5);
		assert.ok(Math.abs(r.rows[30000002].ly - 3.9) < 1e-9);
		assert.ok(Math.abs(r.rows[30000004].ly - 2) < 1e-9);
		assert.strictEqual(r.rows[30000001].ly, 0);
	});

	it('JDC level changes the range: each level adds 20% of the base', function() {
		assert.strictEqual(run('group-898', 0).range, 4);
		assert.strictEqual(run('group-898', 3).range, 6.4);
		const r0 = run('group-898', 0);
		assert.strictEqual(r0.rows[30000002].state, 'in');
		assert.strictEqual(r0.rows[30000003].state, 'out', '4.1 LY is beyond 4 LY');
		assert.strictEqual(r0.label, 'Black Ops (JDC 0)');
		assert.strictEqual(run('group-898', 9).range, 8, 'clamped to V');
		assert.strictEqual(run('group-898', undefined).range, 8, 'missing = V');
	});

	it('other ships use their own base range', function() {
		assert.strictEqual(run('group-547', 5).range, 7);
		assert.strictEqual(run('group-547', 5).rows[30000005].state, 'out');
		assert.strictEqual(run('group-902', 5).range, 10);
	});

	it('works from an origin in another region (distances are galactic)', function() {
		const r = run('group-898', 5, 30000004);	// high-sec origin in The Forge
		assert.strictEqual(r.error, '');
		assert.strictEqual(r.rows[30000004].state, 'origin');
		assert.ok(Math.abs(r.rows[30000002].ly - 1.9) < 1e-9);
		assert.strictEqual(r.rows[30000002].state, 'in');
	});

	it('refuses an origin where no jump drive works and unknown data', function() {
		assert.strictEqual(run('group-898', 5, 31000001).error, 'origin');
		assert.strictEqual(run('group-898', 5, 99999999).error, 'nodata');
		assert.strictEqual(regionMapJumps.compute({ originID: 30000001, preset: null, index, systems, ids }).error, 'nodata');
		assert.strictEqual(run('group-898', 5, 30000008).error, '', 'Pochven can be left by jump drive');
	});

	it('describes systems for the card and tooltip', function() {
		const r = run('group-898', 5);
		const name = (id) => systems[id].name;
		assert.strictEqual(regionMapJumps.describe(r, r.rows[30000002], null, name, systems[30000002], 30000002), '3.9 LY · in range for Black Ops (JDC V)');
		assert.ok(/^Jump origin/.test(regionMapJumps.describe(r, r.rows[30000001], null, name, systems[30000001], 30000001)));
		assert.ok(/High-sec/.test(regionMapJumps.describe(r, r.rows[30000004], null, name, systems[30000004], 30000004)));
		// out of one jump: two jumps via the midpoint
		const reach = jumpRange.reach(30000001, 30000006, r.range, index, systems, regionMapJumps.engineOptions(preset('group-898')), 2);
		assert.strictEqual(reach.jumps, 2);
		assert.strictEqual(regionMapJumps.describe(r, r.rows[30000006], reach, name, systems[30000006], 30000006), '12.0 LY · 2 jumps via Halfway (6.0 LY + 6.0 LY)');
		const r0 = run('group-898', 0);
		const reach0 = jumpRange.reach(30000001, 30000006, r0.range, index, systems, regionMapJumps.engineOptions(preset('group-898')), 2);
		assert.ok(/out of range \(max 4\.0 LY\), not even in 2 jumps/.test(regionMapJumps.describe(r0, r0.rows[30000006], reach0, name, systems[30000006], 30000006)));
	});

	it('Black Ops use covert cynos, others do not', function() {
		assert.strictEqual(regionMapJumps.engineOptions(preset('group-898')).covert, true);
		assert.strictEqual(regionMapJumps.engineOptions(preset('group-547')).covert, false);
	});
});

describe('regionMapJumps origin choice', function() {
	const env = (extra) => Object.assign({ selected: 30000002, me: 30000003, exits: [30000005, 31000001, 30000004], systems, choice: 'selected' }, extra);
	it('offers selected, you and the chain exits where a jump drive works', function() {
		const o = regionMapJumps.origins(env());
		assert.deepStrictEqual(o.options.map((x) => x.value), ['selected', 'you', 'exit:30000005', 'exit:30000004']);
		assert.strictEqual(o.options[0].label, 'Selected: Near');
		assert.strictEqual(o.id, 30000002);
	});
	it('uses the remembered choice, else falls back selected -> you -> first exit', function() {
		assert.strictEqual(regionMapJumps.origins(env({ choice: 'you' })).id, 30000003);
		assert.strictEqual(regionMapJumps.origins(env({ choice: 'exit:30000005' })).id, 30000005);
		assert.strictEqual(regionMapJumps.origins(env({ choice: 'exit:30000099' })).id, 30000002);
		assert.strictEqual(regionMapJumps.origins(env({ selected: null, choice: 'selected' })).value, 'you');
		assert.strictEqual(regionMapJumps.origins(env({ selected: null, me: null, choice: 'selected' })).id, 30000005);
		assert.deepStrictEqual(regionMapJumps.origins(env({ selected: null, me: null, exits: [] })), { options: [], value: '', id: null });
		assert.strictEqual(regionMapJumps.origins(env({ selected: 31000001, me: null, exits: [] })).id, null, 'wormhole space is no origin');
	});
});

describe('regionMapJumps settings and arguments', function() {
	it('defaults to Black Ops, JDC V, the selected system', function() {
		assert.deepStrictEqual(regionMapJumps.settings({}), { ship: 'group-898', jdc: 5, origin: 'selected' });
		assert.deepStrictEqual(regionMapJumps.settings(null), { ship: 'group-898', jdc: 5, origin: 'selected' });
	});
	it('reads and changes saved choices, ignoring junk', function() {
		const o = { regionMap: { jump: { ship: 'group-902', jdc: 3, origin: 'exit:30000005' } } };
		assert.deepStrictEqual(regionMapJumps.settings(o), { ship: 'group-902', jdc: 3, origin: 'exit:30000005' });
		assert.deepStrictEqual(regionMapJumps.settings({ regionMap: { jump: { ship: '__proto__', jdc: 'x', origin: 'exit:abc' } } }), { ship: 'group-898', jdc: 5, origin: 'selected' });
		assert.deepStrictEqual(regionMapJumps.withJump(o, { jdc: 1 }), { ship: 'group-902', jdc: 1, origin: 'exit:30000005' });
		assert.strictEqual(regionMapJumps.withJump(o, { ship: 'nope' }).ship, 'group-902');
		assert.strictEqual(regionMapJumps.withJump(o, { origin: 'bad' }).origin, 'exit:30000005');
	});
	it('every ship the list offers exists in the real ships.json presets', function() {
		const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'jumprange', 'ships.json'), 'utf8'));
		const keys = jumpRange.presets(real).map((p) => p.key);
		regionMapJumps.SHIPS.forEach(([key]) => assert.ok(keys.indexOf(key) >= 0, key));
		assert.strictEqual(jumpRange.presets(real).filter((p) => p.key === 'group-898')[0].covert, true);
	});
	it('picks a ship from typed words', function() {
		assert.strictEqual(regionMapJumps.shipFromText('blops'), 'group-898');
		assert.strictEqual(regionMapJumps.shipFromText('Black'), 'group-898');
		assert.strictEqual(regionMapJumps.shipFromText('jump f'), 'group-902');
		assert.strictEqual(regionMapJumps.shipFromText('jf'), 'group-902');
		assert.strictEqual(regionMapJumps.shipFromText('carr'), 'group-547');
		assert.strictEqual(regionMapJumps.shipFromText('c'), null, 'Carrier and Command Carrier');
		assert.strictEqual(regionMapJumps.shipFromText(''), null);
		assert.strictEqual(regionMapJumps.shipFromText('xyz'), null);
	});
	it('formats distances', function() {
		assert.strictEqual(regionMapJumps.ly(4.349), '4.3 LY');
		assert.strictEqual(regionMapJumps.ly(0), '0.0 LY');
	});
});
