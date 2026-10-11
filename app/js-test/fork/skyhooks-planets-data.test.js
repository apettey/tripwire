const assert = require('assert');
const fs = require('fs');
const path = require('path');

// public/skyhooks-data/planets.json is generated from CCP's SDE by tools/fork/build-skyhook-planets.mjs
describe('Skyhook planet data (generated file)', () => {
	const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../public/skyhooks-data/planets.json'), 'utf8'));
	const entries = Object.keys(data.planets).map(id => [Number(id), data.planets[id]]);

	it('has the two reagents with a price', () => {
		assert.equal(data.reagents[1].name, 'Magmatic Gas');
		assert.equal(data.reagents[2].name, 'Superionic Ice');
		assert.ok(data.reagents[1].price > 0 && data.reagents[2].price > 0);
	});
	it('has 3 ascending lava rating cut points (raidable ISK/h) and the SDE build', () => {
		assert.equal(data.lavaCuts.length, 3);
		assert.ok(data.lavaCuts[0] > 0 && data.lavaCuts[0] < data.lavaCuts[1] && data.lavaCuts[1] < data.lavaCuts[2]);
		assert.ok(/^\d+$/.test(data.sde));
	});
	it('has thousands of planets, each [kind, units per hour, planet number]', () => {
		assert.ok(entries.length > 3000);
		entries.forEach(([id, p]) => {
			assert.ok(id > 40000000, 'planet id ' + id);
			assert.ok(p[0] === 1 || p[0] === 2, 'kind of ' + id);
			assert.ok(Number.isInteger(p[1]) && p[1] > 0, 'yield of ' + id);
			assert.ok(Number.isInteger(p[2]) && p[2] >= 1, 'number of ' + id);
		});
	});
	it('K4YZ-Y IV (verified in ESI: planet type Lava) is a lava planet, number 4', () => assert.deepEqual(data.planets[40233522].slice(0, 1).concat(data.planets[40233522][2]), [1, 4]));
});
