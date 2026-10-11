const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/jump-range');

const DATA = loadJSON('public/jumprange/systems');
const SHIPS = loadJSON('public/jumprange/ships');
const COORDS = jumpRange.decode(DATA);
const INDEX = jumpRange.buildIndex(COORDS, 7);
const S = appData.systems;
const sid = name => Number(Object.keys(S).find(k => S[k].name === name));
const ly = (a, b) => jumpRange.distanceLy(COORDS.pos[sid(a)], COORDS.pos[sid(b)]);

describe('jumpRange', () => {
	describe('systems.json', () => {
		it('has every gate-reachable k-space system incl. high-sec, Pochven and Zarzakh, but no W-space', () => {
			assert.strictEqual(COORDS.ids.length, DATA.meta.count);
			assert.ok(COORDS.ids.length > 5000);
			['Jita', 'Amarr', 'Amamake', 'EC-P8R', 'Hek', 'Kino', 'Zarzakh'].forEach(n => assert.ok(COORDS.pos[sid(n)], n));
			assert.ok(!COORDS.pos[sid('Thera')]);
			assert.ok(!COORDS.pos[sid('J152820')]);
			assert.ok(COORDS.ids.every(id => jumpRange.isKSpaceID(id)));
		});
		it('records its source', () => {
			assert.ok(/Static Data Export/.test(DATA.meta.source));
			assert.ok(DATA.meta.sdeBuild > 0);
		});
		it('decodes nothing to nothing', () => {
			assert.deepStrictEqual(jumpRange.decode(null).ids, []);
		});
	});

	describe('distanceLy (cross-checked with Dotlan, evemaps.dotlan.net/range/Archon,5/Amamake and /range/Rhea,5/Jita, 2026-10-11)', () => {
		// Dotlan prints 3 decimals; positions here are rounded to 0.001 LY per axis
		[['Amamake', 'Auga', 0.432], ['Amamake', 'Siseide', 0.909], ['Amamake', 'Turnur', 2.516], ['Amamake', 'Egghelende', 3.75],
			['Amamake', 'Sifilar', 4.911], ['Amamake', 'Ofstold', 6.889], ['Jita', 'Eruka', 4.532], ['Jita', 'Nagamanen', 6.485],
			['Jita', 'Tama', 7.074], ['Jita', 'Kedama', 6.563]].forEach(([a, b, expected]) => {
			it(a + ' - ' + b + ' = ' + expected + ' LY', () => {
				assert.ok(Math.abs(ly(a, b) - expected) < 0.003, ly(a, b));
			});
		});
		it('Jita - Amarr is about 20.3 LY, and symmetric', () => {
			assert.ok(Math.abs(ly('Jita', 'Amarr') - 20.28) < 0.01);
			assert.strictEqual(ly('Jita', 'Amarr'), ly('Amarr', 'Jita'));
		});
		it('missing positions give NaN', () => {
			assert.ok(isNaN(jumpRange.distanceLy(null, COORDS.pos[sid('Jita')])));
		});
	});

	describe('presets', () => {
		const presets = jumpRange.presets(SHIPS);
		const base = group => presets.find(p => p.group === group).baseLy;
		it('come from the SDE hull ranges', () => {
			assert.strictEqual(base('Carrier'), 3.5);
			assert.strictEqual(base('Dreadnought'), 3.5);
			assert.strictEqual(base('Force Auxiliary'), 3.5);
			assert.strictEqual(base('Lancer Dreadnought'), 4);
			assert.strictEqual(base('Supercarrier'), 3);
			assert.strictEqual(base('Titan'), 3);
			assert.strictEqual(base('Black Ops'), 4);
			assert.strictEqual(base('Jump Freighter'), 5);
			assert.strictEqual(base('Capital Industrial Ship'), 5);
		});
		it('only Black Ops use covert cynos', () => {
			assert.deepStrictEqual(presets.filter(p => p.covert).map(p => p.group), ['Black Ops']);
		});
		it('name small groups by their hulls', () => {
			assert.strictEqual(presets.find(p => p.group === 'Capital Industrial Ship').label, 'Capital Industrial Ship (Rorqual)');
			assert.strictEqual(presets.find(p => p.group === 'Carrier').label, 'Carrier');
		});
		it('only ships (no jump bridges)', () => {
			assert.ok(!presets.some(p => /Jump Bridge|Jump Portal/.test(p.group)));
		});
		it('split a group with two base ranges', () => {
			const p = jumpRange.presets({ ships: [{ typeID: 1, name: 'A', groupID: 9, group: 'G', baseLy: 3 }, { typeID: 2, name: 'B', groupID: 9, group: 'G', baseLy: 4 }] });
			assert.deepStrictEqual(p.map(x => [x.key, x.baseLy]), [['group-9-3', 3], ['group-9-4', 4]]);
		});
		it('default preset is Carrier, unknown keys fall back to it', () => {
			assert.strictEqual(jumpRange.preset(presets, 'nope').group, 'Carrier');
			assert.strictEqual(jumpRange.preset(presets, 'group-898').group, 'Black Ops');
			assert.strictEqual(jumpRange.preset([], 'x'), null);
		});
	});

	describe('maxRange', () => {
		const table = { 3.5: [3.5, 4.2, 4.9, 5.6, 6.3, 7.0], 3: [3, 3.6, 4.2, 4.8, 5.4, 6], 4: [4, 4.8, 5.6, 6.4, 7.2, 8], 5: [5, 6, 7, 8, 9, 10] };
		Object.keys(table).forEach(b => {
			table[b].forEach((expected, jdc) => {
				it('base ' + b + ' JDC ' + jdc + ' = ' + expected, () => assert.strictEqual(jumpRange.maxRange(Number(b), jdc), expected));
			});
		});
		it('clamps JDC to 0-5', () => {
			assert.strictEqual(jumpRange.maxRange(3.5, 9), 7);
			assert.strictEqual(jumpRange.maxRange(3.5, -2), 3.5);
		});
		it('applies the cap only below the range', () => {
			assert.strictEqual(jumpRange.maxRange(3.5, 5, 5), 5);
			assert.strictEqual(jumpRange.maxRange(3.5, 5, 9), 7);
			assert.strictEqual(jumpRange.maxRange(3.5, 5, 0), 7);
			assert.strictEqual(jumpRange.maxRange(3.5, 5, null), 7);
		});
		it('formats', () => {
			assert.strictEqual(jumpRange.formatLy(7), '7.0 LY');
			assert.strictEqual(jumpRange.formatLy(7.5), '7.5 LY');
			assert.strictEqual(jumpRange.formatLy(3.75), '3.75 LY');
		});
	});

	describe('isValidCynoTarget / canJumpFrom', () => {
		const ls = { security: 0.3, regionID: 10000030 };
		it('high-sec boundary: 0.449 is low-sec, 0.45 is high-sec', () => {
			assert.strictEqual(jumpRange.isValidCynoTarget(30000001, { security: 0.449, regionID: 1 }), true);
			assert.strictEqual(jumpRange.isValidCynoTarget(30000001, { security: 0.45, regionID: 1 }), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('Onsooh'), S[sid('Onsooh')]), true);	// 0.4428
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('Iosantin'), S[sid('Iosantin')]), false);	// 0.4503
		});
		it('real systems', () => {
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('Amamake'), S[sid('Amamake')]), true);
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('EC-P8R'), S[sid('EC-P8R')]), true);
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('Hek'), S[sid('Hek')]), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('Thera'), S[sid('Thera')]), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('J152820'), S[sid('J152820')]), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('Kino'), S[sid('Kino')]), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(30100000, S[30100000]), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(30000001, null), false);
		});
		it('low-sec / null-sec toggles', () => {
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('Amamake'), S[sid('Amamake')], { lowsec: false }), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('EC-P8R'), S[sid('EC-P8R')], { lowsec: false }), true);
			assert.strictEqual(jumpRange.isValidCynoTarget(sid('EC-P8R'), S[sid('EC-P8R')], { nullsec: false }), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(30000001, { security: 0.0, regionID: 1 }, { nullsec: false }), false);
		});
		it('jammed: normal cyno no, covert cyno yes', () => {
			const jammed = { 30000001: true };
			assert.strictEqual(jumpRange.isValidCynoTarget(30000001, ls, { jammed: jammed }), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(30000001, ls, { jammed: jammed, covert: true }), true);
			assert.strictEqual(jumpRange.isValidCynoTarget(30000002, ls, { jammed: jammed }), true);
		});
		it('jump origins: any k-space incl. high-sec and Pochven; not Zarzakh or W-space', () => {
			assert.strictEqual(jumpRange.canJumpFrom(sid('Jita'), S[sid('Jita')]), true);
			assert.strictEqual(jumpRange.canJumpFrom(sid('Amamake'), S[sid('Amamake')]), true);
			assert.strictEqual(jumpRange.canJumpFrom(sid('Kino'), S[sid('Kino')]), true);
			assert.strictEqual(jumpRange.canJumpFrom(30100000, S[30100000]), false);
			assert.strictEqual(jumpRange.canJumpFrom(sid('Thera'), S[sid('Thera')]), false);
			assert.strictEqual(jumpRange.canJumpFrom(sid('J152820'), S[sid('J152820')]), false);
		});
	});

	describe('bands', () => {
		it('<= 3.5, <= 5.0, beyond', () => {
			assert.strictEqual(jumpRange.band(0.4, [3.5, 5]), 0);
			assert.strictEqual(jumpRange.band(3.5, [3.5, 5]), 0);
			assert.strictEqual(jumpRange.band(3.51, [3.5, 5]), 1);
			assert.strictEqual(jumpRange.band(5, [3.5, 5]), 1);
			assert.strictEqual(jumpRange.band(6.9, [3.5, 5]), 2);
			assert.strictEqual(jumpRange.band(6.9), 2);
		});
		it('rings below the range, then the range', () => {
			assert.deepStrictEqual(jumpRange.rings(7), [3.5, 5, 7]);
			assert.deepStrictEqual(jumpRange.rings(5), [3.5, 5]);
			assert.deepStrictEqual(jumpRange.rings(3), [3]);
		});
	});

	describe('inRange', () => {
		const amamake = sid('Amamake');
		it('Amamake, Carrier JDC V (7.0 LY): Dotlan\'s list less Pochven (Archee, Krirald)', () => {
			const list = jumpRange.inRange(amamake, INDEX, 7, S, {});
			assert.strictEqual(list.length, 81);
			assert.strictEqual(S[list[0].id].name, 'Auga');
			assert.strictEqual(S[list[list.length - 1].id].name, 'Ofstold');
			assert.ok(list.every((r, i) => !i || list[i - 1].ly <= r.ly));
			assert.ok(!list.some(r => r.id === amamake));
			assert.ok(!list.some(r => ['Archee', 'Krirald', 'Hek', 'Rens'].includes(S[r.id].name)));
			assert.deepStrictEqual(list.slice(0, 1).map(r => r.band), [0]);
			assert.strictEqual(list[list.length - 1].band, 2);
		});
		it('jammed systems: hidden, shown as blocked, or targets for a covert cyno', () => {
			const auga = sid('Auga');
			const jammed = {}; jammed[auga] = true;
			assert.ok(!jumpRange.inRange(amamake, INDEX, 7, S, { jammed }).some(r => r.id === auga));
			const shown = jumpRange.inRange(amamake, INDEX, 7, S, { jammed, showJammed: true }).find(r => r.id === auga);
			assert.deepStrictEqual([shown.jammed, shown.blocked], [true, true]);
			const covert = jumpRange.inRange(amamake, INDEX, 7, S, { jammed, covert: true }).find(r => r.id === auga);
			assert.deepStrictEqual([covert.jammed, !!covert.blocked], [true, false]);
		});
		it('honours the low-sec toggle', () => {
			assert.ok(jumpRange.inRange(amamake, INDEX, 7, S, { lowsec: false }).every(r => S[r.id].security <= 0));
		});
		it('unknown origin: nothing', () => {
			assert.deepStrictEqual(jumpRange.inRange(31000005, INDEX, 7, S, {}), []);
		});
	});

	describe('reach', () => {
		it('1 jump: Jita (high-sec origin) to Eruka with 7.0 LY', () => {
			const r = jumpRange.reach(sid('Jita'), sid('Eruka'), 7, INDEX, S, {});
			assert.strictEqual(r.jumps, 1);
			assert.ok(Math.abs(r.direct - 4.532) < 0.003);
		});
		it('2 jumps: Amarr to Amamake (10.9 LY) with 7.0 LY, best midpoint first', () => {
			const r = jumpRange.reach(sid('Amarr'), sid('Amamake'), 7, INDEX, S, {});
			assert.strictEqual(r.jumps, 2);
			assert.ok(r.via.length > 1);
			assert.ok(r.via.every(v => v.ly1 <= 7 && v.ly2 <= 7 && jumpRange.isValidCynoTarget(v.id, S[v.id])));
			assert.ok(r.via.every((v, i) => !i || Math.max(r.via[i - 1].ly1, r.via[i - 1].ly2) <= Math.max(v.ly1, v.ly2)));
		});
		it('not within 2: Jita to Amamake with 7.0 LY, Amamake to EC-P8R (23.9 LY)', () => {
			assert.strictEqual(jumpRange.reach(sid('Jita'), sid('Amamake'), 7, INDEX, S, {}).jumps, null);
			const r = jumpRange.reach(sid('Amamake'), sid('EC-P8R'), 7, INDEX, S, {});
			assert.deepStrictEqual([r.jumps, r.reason], [null, 'range']);
		});
		it('1 jump only when asked', () => {
			assert.strictEqual(jumpRange.reach(sid('Amarr'), sid('Amamake'), 7, INDEX, S, {}, 1).jumps, null);
		});
		it('never to high-sec or Pochven, never from W-space or Zarzakh', () => {
			assert.strictEqual(jumpRange.reach(sid('Amamake'), sid('Hek'), 7, INDEX, S, {}).reason, 'target');
			assert.strictEqual(jumpRange.reach(sid('Amamake'), sid('Archee'), 7, INDEX, S, {}).reason, 'target');
			assert.strictEqual(jumpRange.reach(30100000, sid('Amamake'), 7, INDEX, S, {}).reason, 'origin');
			assert.strictEqual(jumpRange.reach(sid('Thera'), sid('Amamake'), 7, INDEX, S, {}).reason, 'unknown');
		});
		it('a jammed destination needs a covert cyno; midpoints too', () => {
			const jammed = {}; jammed[sid('Amamake')] = true;
			assert.strictEqual(jumpRange.reach(sid('Auga'), sid('Amamake'), 7, INDEX, S, { jammed }).jumps, null);
			assert.strictEqual(jumpRange.reach(sid('Auga'), sid('Amamake'), 7, INDEX, S, { jammed, covert: true }).jumps, 1);
			const plain = jumpRange.reach(sid('Amarr'), sid('Amamake'), 7, INDEX, S, {});
			const best = plain.via[0].id;
			const j2 = {}; j2[best] = true;
			assert.ok(!jumpRange.reach(sid('Amarr'), sid('Amamake'), 7, INDEX, S, { jammed: j2 }).via.some(v => v.id === best));
		});
		it('a jammed midpoint stays a valid midpoint for a covert cyno (Black Ops)', () => {
			const plain = jumpRange.reach(sid('Amarr'), sid('Amamake'), 7, INDEX, S, {});
			const best = plain.via[0].id;
			const jammed = {}; jammed[best] = true;
			const covert = jumpRange.reach(sid('Amarr'), sid('Amamake'), 7, INDEX, S, { jammed, covert: true });
			assert.strictEqual(covert.via[0].id, best);
			assert.strictEqual(covert.via.length, plain.via.length);
		});
		it('same system: 0 jumps', () => {
			assert.strictEqual(jumpRange.reach(sid('Amamake'), sid('Amamake'), 7, INDEX, S, {}).jumps, 0);
		});
		it('2-jump search is fast (< 20 ms each)', () => {
			const pairs = [['Amarr', 'Amamake'], ['Jita', 'Amamake'], ['Amamake', 'EC-P8R'], ['Jita', 'Tama'], ['Amarr', 'Sahda']];
			jumpRange.reach(sid('Amarr'), sid('Amamake'), 10, INDEX, S, {});	// warm up
			pairs.forEach(([a, b]) => {
				const t = process.hrtime.bigint();
				jumpRange.reach(sid(a), sid(b), 10, INDEX, S, {});
				const ms = Number(process.hrtime.bigint() - t) / 1e6;
				assert.ok(ms < 20, a + '-' + b + ': ' + ms + ' ms');
			});
		});
	});

	describe('nearHub', () => {
		it('the best target within 5 gates of Jita that Amamake reaches (Jita itself is high-sec)', () => {
			const near = jumpRange.nearHub(sid('Amamake'), sid('Jita'), 7, INDEX, S, appData.map.shortest, {}, 5);
			assert.ok(near);
			assert.ok(near.gates <= 5 && near.reach.jumps >= 1);
			assert.ok(jumpRange.isValidCynoTarget(near.systemID, S[near.systemID]));
		});
		it('gate jumps', () => {
			const g = jumpRange.gateJumps(appData.map.shortest, sid('Jita'), 1);
			assert.strictEqual(g[sid('Jita')], 0);
			assert.strictEqual(g[sid('Perimeter')], 1);
			assert.ok(Object.values(g).every(n => n <= 1));
		});
	});
	describe('Get home: startProblem, routesTo', () => {
		const A = sid('Amamake');
		it('start: high-sec and Pochven allowed; W-space, Thera, Zarzakh and unknown systems not', () => {
			assert.strictEqual(jumpRange.startProblem(sid('Jita'), S[sid('Jita')], INDEX), null);
			assert.strictEqual(jumpRange.startProblem(A, S[A], INDEX), null);
			assert.strictEqual(jumpRange.startProblem(sid('Archee'), S[sid('Archee')], INDEX), null);
			assert.strictEqual(jumpRange.startProblem(sid('J152820'), S[sid('J152820')], INDEX), 'wh');
			assert.strictEqual(jumpRange.startProblem(sid('Thera'), S[sid('Thera')], INDEX), 'wh');
			assert.strictEqual(jumpRange.startProblem(30100000, S[30100000], INDEX), 'zarzakh');
			assert.strictEqual(jumpRange.startProblem(123, undefined, INDEX), 'unknown');
			assert.strictEqual(jumpRange.startProblem(A, S[A], { pos: {} }), 'nopos');
		});
		it('ranks 1 jump before 2 jumps, then by total LY; unreachable last with the reason', () => {
			const ids = ['EC-P8R', 'KBP7-G', 'E-YCML', 'Egghelende', 'Auga'].map(sid);
			const r = jumpRange.routesTo(A, ids, 7, INDEX, S, {});
			assert.deepStrictEqual(r.map(x => x.jumps), [1, 1, 2, 2, null]);
			assert.deepStrictEqual([r[0].id, r[1].id], [sid('Auga'), sid('Egghelende')]);	// 0.4 LY before 3.7 LY
			assert.ok(r[2].total <= r[3].total);
			assert.ok(r[2].via && r[2].legs.length === 2 && r[2].legs.every(l => l <= 7));
			assert.ok(Math.abs(r[2].total - (r[2].legs[0] + r[2].legs[1])) < 1e-9);
			assert.deepStrictEqual([r[4].id, r[4].reason, r[4].via], [sid('EC-P8R'), 'range', null]);
			assert.deepStrictEqual(r[0].legs.length, 1);
		});
		it('a cyno-jammed exit: unreachable for a normal cyno ("jammed"), fine with a covert one', () => {
			const egg = sid('Egghelende');
			const jammed = {}; jammed[egg] = true;
			assert.deepStrictEqual([jumpRange.routesTo(A, [egg], 7, INDEX, S, { jammed: jammed })[0].jumps, jumpRange.routesTo(A, [egg], 7, INDEX, S, { jammed: jammed })[0].reason], [null, 'jammed']);
			assert.strictEqual(jumpRange.routesTo(A, [egg], 7, INDEX, S, { jammed: jammed, covert: true })[0].jumps, 1);
		});
		it('targets switched off: "target"; the start itself: 0 jumps', () => {
			const egg = sid('Egghelende');
			assert.strictEqual(jumpRange.routesTo(A, [egg], 7, INDEX, S, { lowsec: false })[0].reason, 'target');
			const self = jumpRange.routesTo(A, [A], 7, INDEX, S, {})[0];
			assert.deepStrictEqual([self.jumps, self.total], [0, 0]);
		});
		it('a W-space start reaches nothing (it has no position)', () => {
			assert.strictEqual(jumpRange.routesTo(sid('J152820'), [A], 7, INDEX, S, {})[0].reason, 'nopos');
			assert.strictEqual(jumpRange.routesTo(sid('Thera'), [A], 7, INDEX, S, {})[0].jumps, null);
		});
	});

	describe('holeFits / shipNeeds', () => {
		it('ship groups: Black Ops L, Jump Freighter and Rorqual VL, capitals XL, supers and titans none', () => {
			assert.deepStrictEqual([898, 902, 883, 547, 485, 1538, 4594, 5120, 659, 30, 1].map(jumpRange.shipNeeds),
				['L', 'VL', 'VL', 'XL', 'XL', 'XL', 'XL', 'XL', 'none', 'none', null]);
		});
		it('hull masses agree (appData.mass): Black Ops <= 375 kt, JF / Rorqual <= 1,000 kt but > 410 kt, capitals <= 2,000 kt but > 1,000 kt', () => {
			const ships = SHIPS.ships;
			const mass = s => appData.mass[s.typeID].mass;
			const max = { L: 375e6, VL: 1000e6, XL: 2000e6 }, below = { L: 62e6, VL: 410e6, XL: 1000e6 };
			ships.forEach(s => {
				const need = jumpRange.shipNeeds(s.groupID);
				if (need === 'none' || !appData.mass[s.typeID]) { return; }
				assert.ok(mass(s) <= max[need] && mass(s) > below[need], s.name + ' ' + mass(s) + ' ' + need);
			});
		});
		it('matrix', () => {
			const sizes = ['S', 'M', 'L', 'VL', 'XL'];
			const table = ['L', 'VL', 'XL', 'none'].map(need => sizes.map(size => jumpRange.holeFits(need, size)));
			assert.deepStrictEqual(table, [
				[false, false, true, true, true],
				[false, false, false, true, true],
				[false, false, false, false, true],
				[false, false, false, false, false]
			]);
		});
		it('unknown size or ship: null (no warning); a super never fits, even an unknown hole', () => {
			assert.strictEqual(jumpRange.holeFits('XL', null), null);
			assert.strictEqual(jumpRange.holeFits(null, 'L'), null);
			assert.strictEqual(jumpRange.holeFits('none', null), false);
		});
	});
});
