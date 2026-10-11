const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/guidance');
include('app/js/systemAnalysis');
include('app/js/fork/skyhooks-panel');
include('app/js/fork/loot-buyers');

const root = path.join(__dirname, '../../..');
const DATA = JSON.parse(fs.readFileSync(path.join(root, 'public/loot-buyers/stations.json'), 'utf8'));

// Small gate maps keyed by systemID - 30000000 (like appData.map.shortest): 1-2-3-4-5 with 6 hanging off 3
const O = 30000000;
const mapOf = edges => { const m = {}; edges.forEach(([a, b]) => { (m[a] = m[a] || {})[b] = 0; (m[b] = m[b] || {})[a] = 0; }); return m; };
const MAP = mapOf([[1, 2], [2, 3], [3, 4], [4, 5], [3, 6]]);
const costFn = (from, to, base) => base;
const dist = exits => skyhooksPanel.distances(MAP, exits.map(e => e + O), 60, costFn);
const sys = { [O + 1]: { security: 0.9 }, [O + 3]: { security: 0.3 }, [O + 4]: { security: -0.2 }, [O + 5]: { security: 0.0 }, [O + 6]: { security: 0.6 } };
const systemFor = id => sys[id] || null;
const FIX = {
	blue: [[60000001, O + 3, 1000160, 'Three I - A'], [60000002, O + 3, 1000160, 'Three I - B'], [60000003, O + 5, 1000138, 'Five II - C'], [60000004, O + 6, 1000016, 'Six III - D']],
	red: [[60000005, O + 4, 1000125, 'Four IV - E'], [60000006, O + 1, 1000137, 'One V - F']],
	corps: { 1000160: 'Thukker Mix' }
};

describe('Loot buyers', () => {
	describe('settings', () => {
		it('on by default, red loot off', () => assert.deepStrictEqual(lootBuyers.settings(undefined), { enabled: true, red: false }));
		it('a missing key means the default', () => assert.deepStrictEqual(lootBuyers.settings({}), { enabled: true, red: false }));
		it('keeps saved values', () => assert.deepStrictEqual(lootBuyers.settings({ enabled: false, red: true }), { enabled: false, red: true }));
		it('ignores garbage', () => assert.deepStrictEqual(lootBuyers.settings('x'), { enabled: true, red: false }));
	});

	describe('stations', () => {
		it('blue only unless red is on', () => {
			assert.deepStrictEqual(lootBuyers.stations(FIX, false).map(s => s.kind), ['blue', 'blue', 'blue', 'blue']);
			assert.strictEqual(lootBuyers.stations(FIX, true).length, 6);
		});
		it('bad data gives nothing', () => {
			assert.deepStrictEqual(lootBuyers.stations(null, true), []);
			assert.deepStrictEqual(lootBuyers.stations({ blue: [[1]], red: [] }, true), []);
		});
	});

	describe('nearest', () => {
		it('orders by gate jumps and groups stations of one system', () => {
			const rows = lootBuyers.nearest(FIX, false, dist([1]), systemFor, 3);
			assert.deepStrictEqual(rows.map(r => [r.systemID - O, r.jumps, r.more]), [[3, 2, 1], [6, 3, 0], [5, 4, 0]]);
			assert.strictEqual(rows[0].stationID, 60000001);
			assert.strictEqual(rows[0].exitID, O + 1);
		});
		it('takes the nearest of several exits', () => {
			const rows = lootBuyers.nearest(FIX, false, dist([1, 5]), systemFor, 3);
			assert.deepStrictEqual(rows.map(r => [r.systemID - O, r.jumps, r.exitID - O]), [[5, 0, 5], [3, 2, 1], [6, 3, 1]]);
		});
		it('red loot adds its buyers', () => {
			const rows = lootBuyers.nearest(FIX, true, dist([1]), systemFor, 5);
			assert.deepStrictEqual(rows.map(r => [r.systemID - O, r.kinds.join()]), [[1, 'red'], [3, 'blue'], [4, 'red'], [6, 'blue'], [5, 'blue']]);
		});
		it('defaults to three rows', () => assert.strictEqual(lootBuyers.nearest(FIX, true, dist([1]), systemFor).length, 3));
		it('skips buyers the search cannot reach', () => {
			const rows = lootBuyers.nearest(FIX, false, skyhooksPanel.distances(mapOf([[1, 2]]), [O + 1], 60, costFn), systemFor, 3);
			assert.deepStrictEqual(rows, []);
		});
		it('no search result, no rows', () => assert.deepStrictEqual(lootBuyers.nearest(FIX, true, null, systemFor), []));
		it('route preferences change the answer: a closed gate sends the search the long way round', () => {
			const closed = (from, to, base) => (from === 2 && to === 3) || (from === 3 && to === 2) ? 0 : base;
			const rows = lootBuyers.nearest(FIX, false, skyhooksPanel.distances(mapOf([[1, 2], [2, 3], [1, 7], [7, 8], [8, 3]]), [O + 1], 60, closed), systemFor, 3);
			assert.deepStrictEqual(rows.map(r => [r.systemID - O, r.jumps]), [[3, 3]]);
		});
	});

	describe('usableExits (route hole filters)', () => {
		const exits = [{ systemID: 11, holes: [0] }, { systemID: 12, holes: [1] }, { systemID: 11, holes: [2] }];
		it('all exits once without hole filters', () => assert.deepStrictEqual(lootBuyers.usableExits(exits, null), [11, 12]));
		it('drops exits whose way home is filtered, when others are clean', () => {
			const saved = global.routeHoleFilters;
			global.routeHoleFilters = { pickRoutes: routes => routes.filter(r => r.exit.holes[0] !== 0) };
			try { assert.deepStrictEqual(lootBuyers.usableExits(exits, { 0: {} }), [12, 11]); } finally { global.routeHoleFilters = saved; }
		});
		it('nothing to search from, no exits', () => assert.deepStrictEqual(lootBuyers.usableExits([], null), []));
	});

	describe('rowHtml', () => {
		const row = { systemID: 30000017, stationID: 60014071, exitID: 30000001, jumps: 1, security: 0.04, name: 'Futzchag IX - Moon 9 - <Thukker> Mix Factory', corpID: 1, kinds: ['blue', 'red'], more: 2 };
		it('escapes, marks the kinds and offers the route', () => {
			const html = lootBuyers.rowHtml(row, 'Exit', '<span>Sys</span>', "Thukker's", true);
			assert.ok(html.indexOf('&lt;Thukker&gt;') > 0 && html.indexOf('<Thukker>') < 0);
			assert.ok(/loot-kind-blue/.test(html) && /loot-kind-red/.test(html) && /\+2 more here/.test(html) && /1 jump</.test(html) && /loot-route'/.test(html));
		});
		it('no route button when not routable', () => assert.ok(/loot-route-none/.test(lootBuyers.rowHtml(row, 'Exit', 'S', '', false))));
		it('jump texts', () => assert.deepStrictEqual([0, 1, 4].map(lootBuyers.jumpsText), ['this system', '1 jump', '4 jumps']));
		it('security text', () => assert.deepStrictEqual([0.04, -0.2, NaN].map(lootBuyers.securityText), ['0.0', '-0.2', '']));
	});

	describe('public/loot-buyers/stations.json (generated by tools/fork/build-loot-buyers.mjs)', () => {
		it('has the right shape and records its sources', () => {
			assert.ok(lootBuyers.valid(DATA));
			assert.ok(/^\d+$/.test(DATA.sde) && /^\d{4}-\d{2}-\d{2}$/.test(DATA.date) && /^\d{4}-\d{2}-\d{2}$/.test(DATA.ordersDate));
			assert.deepStrictEqual(Object.keys(DATA.blueTypes).map(Number), [30744, 30745, 30746, 30747]);
			assert.deepStrictEqual(Object.keys(DATA.redTypes).map(Number), [48121]);
		});
		it('lists hundreds of blue buyers and red buyers, each [station, system, corporation, name] in k-space ids', () => {
			assert.ok(DATA.blue.length > 200 && DATA.red.length > 100);
			DATA.blue.concat(DATA.red).forEach(s => {
				assert.ok(s[0] > 60000000 && s[0] < 61000000, 'station ' + s[0]);
				assert.ok(s[1] > 30000000 && s[1] < 31000000, 'system of ' + s[0]);
				assert.ok(DATA.corps[s[2]], 'corp of ' + s[0]);
				assert.ok(typeof s[3] === 'string' && s[3].length > 5, 'name of ' + s[0]);
			});
		});
		it('is sorted and has no duplicate stations', () => {
			[DATA.blue, DATA.red].forEach(list => {
				assert.deepStrictEqual(list.map(s => s[0]), list.map(s => s[0]).slice().sort((a, b) => a - b));
				assert.strictEqual(new Set(list.map(s => s[0])).size, list.length);
			});
		});
		it('red loot is bought at CONCORD, DED and Secure Commerce Commission stations only', () => {
			assert.deepStrictEqual([...new Set(DATA.red.map(s => DATA.corps[s[2]]))].sort(), ['CONCORD', 'DED', 'Secure Commerce Commission']);
		});
		it('a station that buys both kinds is one row with both kinds', () => {
			const both = DATA.blue.filter(s => DATA.red.some(r => r[0] === s[0]));
			assert.ok(both.length > 0);
			const id = both[0][0];
			const fix = { blue: [[id, 30000005, both[0][2], both[0][3]]], red: [[id, 30000005, both[0][2], both[0][3]]] };
			const rows = lootBuyers.nearest(fix, true, { 30000005: { jumps: 2, exitID: 30000001 } }, null, 3);
			assert.deepStrictEqual([rows.length, rows[0].kinds, rows[0].more], [1, ['blue', 'red'], 0]);
		});
		it('known buyers (names checked against ESI /universe/stations on 2026-10-11)', () => {
			const find = (list, id) => list.find(s => s[0] === id);
			assert.strictEqual(find(DATA.blue, 60014071)[3], 'Futzchag IX - Moon 9 - Thukker Mix Factory');
			assert.strictEqual(find(DATA.blue, 60014071)[1], 30000017);
			assert.ok(find(DATA.red, 60012295));
		});
		it('Jita (the trade hub) is not a buyer: Caldari Navy does not buy loot', () => assert.ok(!DATA.blue.some(s => s[0] === 60003760)));
	});

	describe('generator (tools/fork/build-loot-buyers.mjs)', () => {
		let gen;
		before(async () => { gen = await import(pathToFileURL(path.join(root, 'tools/fork/build-loot-buyers.mjs')).href); });
		const name = en => ({ en });
		const input = () => ({
			stations: [
				{ _key: 60000001, celestialIndex: 4, orbitIndex: 9, ownerID: 7, operationID: 3, solarSystemID: 30000017, useOperationName: true },
				{ _key: 60000002, celestialIndex: 10, ownerID: 7, operationID: 3, solarSystemID: 30000017, useOperationName: false },
				{ _key: 60000003, celestialIndex: 1, orbitIndex: 1, ownerID: 7, operationID: 3, solarSystemID: 30000017, useOperationName: true },
				{ _key: 60000004, celestialIndex: 2, orbitIndex: 1, ownerID: 8, operationID: 3, solarSystemID: 30000017, useOperationName: true }
			],
			systems: [{ _key: 30000017, name: name('Futzchag') }],
			corps: [{ _key: 7, name: name('Thukker Mix') }, { _key: 8, name: name('DED') }],
			operations: [{ _key: 3, operationName: name('Factory') }],
			orders: [].concat(...[30744, 30745, 30746, 30747].map(t => [60000001, 60000002].map(l => ({ type_id: t, location_id: l })))),
			sde: 3586130, date: '2026-10-11', ordersDate: '2026-10-11'
		});
		it('names stations the way EVE does (moon part only for moon stations, roman planet number)', () => {
			const out = gen.build(input());
			assert.deepStrictEqual(out.blue.map(s => s[3]), ['Futzchag IV - Moon 9 - Thukker Mix Factory', 'Futzchag X - Thukker Mix']);
		});
		it('lists a station only when it has an order for every type of the class', () => {
			const i = input();
			i.orders = i.orders.filter(o => !(o.location_id === 60000002 && o.type_id === 30747));
			i.orders.push({ type_id: 48121, location_id: 60000004 }, { type_id: 48121, location_id: 60000001 });
			const out = gen.build(i);
			assert.deepStrictEqual(out.blue.map(s => s[0]), [60000001]);
			assert.deepStrictEqual(out.red.map(s => s[0]), [60000001, 60000004]);
			assert.deepStrictEqual(out.corps, { 7: 'Thukker Mix', 8: 'DED' });
		});
		it('is reproducible: the same inputs give the same file, whatever the order of the orders', () => {
			const a = gen.build(input());
			const i = input(); i.orders.reverse();
			assert.strictEqual(JSON.stringify(gen.build(i)), JSON.stringify(a));
		});
		it('keeps only CCP-seeded orders: 365 days, about a million units, at an NPC station', () => {
			const o = (extra) => Object.assign({ is_buy_order: true, type_id: 30744, location_id: 60000001, duration: 365, volume_total: 1000000 }, extra);
			const ids = new Set([60000001]);
			assert.strictEqual(gen.seeded([o()], ids).length, 1);
			assert.strictEqual(gen.seeded([o({ duration: 90 })], ids).length, 0);
			assert.strictEqual(gen.seeded([o({ volume_total: 5000 })], ids).length, 0);
			assert.strictEqual(gen.seeded([o({ location_id: 1044752365771 })], ids).length, 0);
			assert.strictEqual(gen.seeded([o({ is_buy_order: false })], ids).length, 0);
			assert.strictEqual(gen.seeded([o({ type_id: 34 })], ids).length, 0);
			assert.strictEqual(gen.seeded([o(), o()], ids).length, 1);
		});
		it('roman numerals', () => assert.deepStrictEqual([1, 4, 9, 10, 14].map(gen.roman), ['I', 'IV', 'IX', 'X', 'XIV']));
	});
});
