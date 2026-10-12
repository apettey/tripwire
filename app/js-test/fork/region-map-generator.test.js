const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

// Fixture in the SDE's shapes: two regions, Alpha (2 systems + 1 more with no 2D position) and Beta (1 system), a
// wormhole system that must be left out, gates both ways inside Alpha and across to Beta.
const names = (en) => ({ en, de: en });
const sys = (id, name, region, constellation, x, y, sec, pos2D = true) => Object.assign({
	_key: id, name: names(name), regionID: region, constellationID: constellation, securityStatus: sec,
	position: { x: 0, y: 0, z: 0 }
}, pos2D ? { position2D: { x: x * 9460730472580800 / 100, y: y * 9460730472580800 / 100 } } : {});
const gate = (id, from, to) => ({ _key: id, solarSystemID: from, destination: { solarSystemID: to, stargateID: id + 1 } });
const fixture = {
	systems: [
		sys(30000001, 'A-One', 10000001, 20000001, 100, 100, -0.2),
		sys(30000002, 'A-Two', 10000001, 20000002, 200, 150, 0.34567),	// north-east of A-One (SDE y points north)
		sys(30000003, 'A-NoPos', 10000001, 20000002, 0, 0, 0.5, false),
		sys(30000010, 'B-One', 10000002, 20000010, 400, 100, 0.9),
		sys(31000001, 'J000001', 11000001, 21000001, 0, 0, -0.99)
	],
	regions: [{ _key: 10000001, name: names('Alpha') }, { _key: 10000002, name: names('Beta') }, { _key: 11000001, name: names('A-R00001') }],
	constellations: [{ _key: 20000001, name: names('Con-1'), factionID: 500012 }, { _key: 20000002, name: names('Con-2') }, { _key: 20000010, name: names('Con-B') }],
	stargates: [gate(1, 30000001, 30000002), gate(2, 30000002, 30000001), gate(3, 30000002, 30000010), gate(4, 30000010, 30000002), gate(5, 30000001, 31000001)]
};

describe('build-region-maps generator', function() {
	let build;
	before(async function() {
		build = await import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'tools', 'fork', 'build-region-maps.mjs')).href);
	});

	it('writes one file per k-space region and an index', function() {
		const out = build.buildRegionMaps(fixture, 123, '2026-10-07');
		assert.deepStrictEqual(out.index, { v: 1, sde: '123', date: '2026-10-07', regions: [[10000001, 'Alpha', 2], [10000002, 'Beta', 1]] });
		assert.deepStrictEqual(Object.keys(out.regions), ['10000001', '10000002']);
	});

	it('lays systems out with y down, in 0.01 ly units, from the top left padding', function() {
		const a = build.buildRegionMaps(fixture, 123, 'd').regions[10000001];
		assert.strictEqual(a.v, 1);
		assert.strictEqual(a.name, 'Alpha');
		const one = a.systems.find((s) => s[0] === 30000001), two = a.systems.find((s) => s[0] === 30000002);
		assert.strictEqual(two[2] - one[2], 100, 'A-Two is 100 units east');
		assert.strictEqual(two[3] - one[3], -50, 'A-Two is 50 units north: smaller y');
		assert.strictEqual(two[3], build.PAD);
		assert.strictEqual(one[2], build.PAD);
		assert.strictEqual(a.w, two[2] + build.PAD);
		assert.strictEqual(a.h, one[3] + build.PAD);
		assert.strictEqual(two[5], 0.35, 'security rounded to 2 decimals');
		assert.ok(!a.systems.some((s) => s[0] === 30000003), 'no 2D position, left out');
	});

	it('lists constellations once, in id order, with the system pointing to its index', function() {
		const a = build.buildRegionMaps(fixture, 1, 'd').regions[10000001];
		assert.deepStrictEqual(a.constellations, [[20000001, 'Con-1', 500012], [20000002, 'Con-2']]);
		assert.deepStrictEqual(a.systems.map((s) => s[4]), [0, 1]);
	});

	it('merges the two directions of a gate and turns gates leaving the region into links with a direction', function() {
		const out = build.buildRegionMaps(fixture, 1, 'd').regions;
		assert.deepStrictEqual(out[10000001].gates, [[30000001, 30000002]]);
		assert.deepStrictEqual(out[10000001].links, [[30000002, 30000010, 10000002, 'B-One', 200, 50]]);
		assert.deepStrictEqual(out[10000002].links, [[30000010, 30000002, 10000001, 'A-Two', -200, -50]]);
		assert.deepStrictEqual(out[10000002].gates, []);
	});

	it('drops wormhole-space systems and the gate into them', function() {
		const out = build.buildRegionMaps(fixture, 1, 'd');
		assert.ok(!out.regions[11000001]);
		assert.ok(out.regions[10000001].links.every((l) => l[1] !== 31000001));
	});
});
