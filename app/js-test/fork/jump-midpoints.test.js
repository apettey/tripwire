const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/jump-range');

// Midpoint scoring: routePlan / routeVia / alternatives / fatigue (app/js/fork/jump-range.js)
describe('jumpRange midpoint scoring', () => {
	// A made-up world: systems by position, ids 30009001+, null-sec unless a security is given
	function world(points, secs) {
		const ids = points.map((p, i) => 30009001 + i);
		const coords = { ids: ids, pos: {} };
		const systems = {};
		ids.forEach((id, i) => {
			coords.pos[id] = { x: points[i][0], y: points[i][1] || 0, z: points[i][2] || 0 };
			systems[id] = { security: secs && secs[i] !== undefined ? secs[i] : -0.5, regionID: 10000002 };
		});
		return { ids: ids, index: jumpRange.buildIndex(coords, 5), systems: systems, coords: coords };
	}
	const plan = (w, start, dest, range, opts, max) => jumpRange.routePlan(w.ids[start], [w.ids[dest]], range, w.index, w.systems, opts || {}, max === undefined ? 5 : max)[0];
	const set = (w, idxs) => { const o = {}; idxs.forEach(i => { o[w.ids[i]] = true; }); return o; };
	const near = (a, b) => Math.abs(a - b) < 1e-9;

	// start 0 at x=0, destination 3 at x=10; two midpoints in the middle: 1 slightly shorter than 2
	//   0 -(5)- 1 -(5)- 3 (10 LY) and 0 -(5.1)- 2 -(5.1)- 3 (10.2 LY), range 5.5
	const fork = () => world([[0, 0], [5, 0], [5, 1], [10, 0]]);

	describe('midpointPenalty', () => {
		const w = fork();
		it('nothing without data or switches', () => {
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[1], {}), 0);
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[1], { preferStations: true }), 0);		// station data not loaded: no penalty
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[1], { avoidKills: true }), 0);			// kills not loaded
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[1], null), 0);
		});
		it('no station +3 LY only while preferStations and the stations are known', () => {
			const o = { preferStations: true, stations: { [w.ids[2]]: 2 } };
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[1], o), jumpRange.MIDPOINT_WEIGHTS.noStation);
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[2], o), 0);
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[1], { preferStations: false, stations: {} }), 0);
			assert.strictEqual(jumpRange.MIDPOINT_WEIGHTS.noStation, 3);
		});
		it('kills: 0.5 LY each, at most 5; only while avoidKills', () => {
			const k = n => jumpRange.midpointPenalty(w.ids[1], { avoidKills: true, kills: { [w.ids[1]]: n } });
			assert.deepStrictEqual([k(0), k(1), k(4), k(10), k(11), k(300)], [0, 0.5, 2, 5, 5, 5]);
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[1], { avoidKills: false, kills: { [w.ids[1]]: 9 } }), 0);
		});
		it('avoided systems +50, and the parts add up; weights can be overridden', () => {
			const o = { preferStations: true, stations: {}, avoidKills: true, kills: { [w.ids[1]]: 2 }, avoid: set(w, [1]) };
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[1], o), 3 + 1 + 50);
			assert.strictEqual(jumpRange.midpointPenalty(w.ids[1], Object.assign({ weights: { avoid: 7, noStation: 1 } }, o)), 1 + 1 + 7);
		});
		it('midpointFacts: station / kills null when the data is not there', () => {
			assert.deepStrictEqual(jumpRange.midpointFacts(w.ids[1], {}), { station: null, kills: null, avoided: false });
			assert.deepStrictEqual(jumpRange.midpointFacts(w.ids[1], { stations: { [w.ids[1]]: 1 }, kills: {}, avoid: set(w, [1]) }), { station: true, kills: 0, avoided: true });
		});
	});

	describe('routePlan', () => {
		it('without scoring data it is the fewest jumps, then the least total LY (like routesFrom)', () => {
			const w = fork();
			const r = plan(w, 0, 3, 5.5);
			assert.strictEqual(r.jumps, 2);
			assert.deepStrictEqual(r.path, [w.ids[1]]);		// 4.9 + 4.9 beats 5 + 5
			assert.ok(near(r.total, 10) && near(r.cost, r.total));
			const old = jumpRange.routesFrom(w.ids[0], [w.ids[3]], 5.5, w.index, w.systems, {}, 5)[0];
			assert.deepStrictEqual([old.jumps, old.path, old.total], [r.jumps, r.path, r.total]);
		});
		it('a midpoint with a station beats a slightly shorter one without', () => {
			const w = fork();
			const o = { preferStations: true, stations: { [w.ids[2]]: 1 } };
			const r = plan(w, 0, 3, 5.5, o);
			assert.deepStrictEqual(r.path, [w.ids[2]]);
			assert.deepStrictEqual(r.mids.map(m => m.station), [true]);
			assert.ok(near(r.cost, 2 * Math.sqrt(26)));
			// switched off: back to the shorter one
			assert.deepStrictEqual(plan(w, 0, 3, 5.5, { preferStations: false, stations: o.stations }).path, [w.ids[1]]);
			// a station-less midpoint still wins when it saves more than the penalty (4.1 LY here, penalty 3)
			const far = world([[0, 0], [5, 0], [5, 5], [10, 0]]);
			assert.deepStrictEqual(plan(far, 0, 3, 7.5, { preferStations: true, stations: { [far.ids[2]]: 1 } }).path, [far.ids[1]]);
		});
		it('does not let a station win over a clearly shorter route', () => {
			const w = world([[0, 0], [5, 0], [5, 3.5], [10, 0]]);		// via 1: 10 LY; via 2: 12.2 LY (+2.2 < 3, so still a station win)
			const o = { preferStations: true, stations: { [w.ids[2]]: 1 } };
			assert.deepStrictEqual(plan(w, 0, 3, 7, o).path, [w.ids[2]]);
			const w2 = world([[0, 0], [5, 0], [5, 4.5], [10, 0]]);		// via 2: 13.4 LY (+3.4 > 3)
			assert.deepStrictEqual(plan(w2, 0, 3, 7, { preferStations: true, stations: { [w2.ids[2]]: 1 } }).path, [w2.ids[1]]);
		});
		it('recent kills push the route to a quieter midpoint; cost carries the penalty, total does not', () => {
			const w = fork();
			const o = { avoidKills: true, kills: { [w.ids[1]]: 3 } };
			const r = plan(w, 0, 3, 5.5, o);
			assert.deepStrictEqual(r.path, [w.ids[2]]);
			assert.deepStrictEqual(r.mids.map(m => m.kills), [0]);
			const camped = plan(w, 0, 3, 5.5, { avoidKills: true, kills: { [w.ids[1]]: 3, [w.ids[2]]: 3 } });
			assert.deepStrictEqual(camped.path, [w.ids[1]]);		// both equally camped: the shorter again
			assert.ok(near(camped.cost - camped.total, 1.5));
			assert.deepStrictEqual(plan(w, 0, 3, 5.5, { avoidKills: false, kills: o.kills }).path, [w.ids[1]]);
		});
		it('avoided systems are penalised, not forbidden: used when they are the only way', () => {
			const w = fork();
			assert.deepStrictEqual(plan(w, 0, 3, 5.5, { avoid: set(w, [1]) }).path, [w.ids[2]]);
			const only = plan(w, 0, 3, 5.5, { avoid: set(w, [1, 2]) });
			assert.strictEqual(only.jumps, 2);
			assert.ok(near(only.cost - only.total, 50));
			assert.strictEqual(only.mids[0].avoided, true);
			// an avoided destination or start is never penalised
			const dest = plan(w, 0, 3, 5.5, { avoid: set(w, [3, 0]) });
			assert.ok(near(dest.cost, dest.total));
		});
		it('incursions: no normal cyno midpoint or target when avoiding them; covert and switched off pass', () => {
			const w = fork();
			const inc = set(w, [1]);
			assert.deepStrictEqual(plan(w, 0, 3, 5.5, { incursion: inc, avoidIncursions: true }).path, [w.ids[2]]);
			assert.deepStrictEqual(plan(w, 0, 3, 5.5, { incursion: inc, avoidIncursions: true, covert: true }).path, [w.ids[1]]);
			assert.deepStrictEqual(plan(w, 0, 3, 5.5, { incursion: inc, avoidIncursions: false }).path, [w.ids[1]]);
			const both = plan(w, 0, 3, 5.5, { incursion: set(w, [1, 2]), avoidIncursions: true });
			assert.deepStrictEqual([both.jumps, both.reason], [null, 'range']);
			const dest = plan(w, 0, 1, 5.5, { incursion: inc, avoidIncursions: true });
			assert.deepStrictEqual([dest.jumps, dest.reason], [null, 'incursion']);
			assert.strictEqual(plan(w, 0, 1, 5.5, { incursion: inc, avoidIncursions: true, covert: true }).jumps, 1);
			// jammed wins as the reason when both apply
			assert.strictEqual(plan(w, 0, 1, 5.5, { incursion: inc, avoidIncursions: true, jammed: inc }).reason, 'jammed');
		});
		it('jumps mode never adds a jump for a penalty', () => {
			// a direct 2-jump pair only through a camped, station-less, avoided midpoint, or 3 jumps through clean ones
			const w = world([[0, 0], [5, 0], [1.5, 0], [8.5, 0], [10, 0]]);
			const o = { prefer: 'jumps', avoid: set(w, [1]), preferStations: true, stations: {}, avoidKills: true, kills: { [w.ids[1]]: 99 } };
			const r = plan(w, 0, 4, 5.5, o);
			assert.strictEqual(r.jumps, 2);
			assert.deepStrictEqual(r.path, [w.ids[1]]);
		});
		it('fuel mode takes an extra midpoint when it saves more than it costs; ties keep fewer jumps', () => {
			// 2 jumps only via the avoided system 1 (5 + 5 LY); 3 jumps via 2 and 3 are clean (10 LY)
			const w = world([[0, 0], [5, 0], [3.3, 0], [6.7, 0], [10, 0]]);
			const o = { avoid: set(w, [1]) };
			const jumps = plan(w, 0, 4, 5.5, Object.assign({ prefer: 'jumps' }, o));
			assert.deepStrictEqual([jumps.jumps, jumps.path], [2, [w.ids[1]]]);
			const fuel = plan(w, 0, 4, 5.5, Object.assign({ prefer: 'fuel' }, o));
			assert.deepStrictEqual([fuel.jumps, fuel.path], [3, [w.ids[2], w.ids[3]]]);
			assert.ok(near(fuel.cost, 10));
			assert.strictEqual(plan(w, 0, 4, 5.5, { prefer: 'fuel' }).jumps, 2);		// equal cost (10 LY): fewer jumps
			assert.strictEqual(plan(w, 0, 4, 5.5, Object.assign({ prefer: 'fuel' }, o), 2).jumps, 2);		// maxJumps 2: the 3-jump way is not allowed
		});
		it('fuel mode ranks by total LY, jumps mode by jumps', () => {
			const w = world([[0], [4], [8], [12]]);
			const ids = w.ids.slice(1);
			const fuel = jumpRange.routePlan(w.ids[0], ids, 5, w.index, w.systems, { prefer: 'fuel' }, 5);
			assert.deepStrictEqual(fuel.map(r => r.jumps), [1, 2, 3]);
		});
		it('maxJumps, 0, unknown start, unreachable, same system, empty list', () => {
			const w = world([[0], [4], [8], [12], [16], [20], [24]]);
			assert.strictEqual(plan(w, 0, 5, 5).jumps, 5);
			assert.deepStrictEqual([plan(w, 0, 6, 5).jumps, plan(w, 0, 6, 5).reason], [null, 'range']);
			assert.strictEqual(plan(w, 0, 3, 5, {}, 2).jumps, null);
			assert.strictEqual(plan(w, 0, 3, 5, { prefer: 'fuel' }, 2).jumps, null);
			assert.strictEqual(plan(w, 0, 3, 5, {}, 0).jumps, null);
			assert.deepStrictEqual([plan(w, 2, 2, 5).jumps, plan(w, 2, 2, 5).total], [0, 0]);
			assert.strictEqual(jumpRange.routePlan(31000001, [w.ids[1]], 5, w.index, w.systems, {}, 5)[0].reason, 'nopos');
			assert.deepStrictEqual(jumpRange.routePlan(w.ids[0], [], 5, w.index, w.systems, {}, 5), []);
		});
		it('rows: legs, mids, fuel and fatigue', () => {
			const w = world([[0], [4], [8], [12]]);
			const ship = { fuelPerLy: 1000, fuelBonuses: [], fuelRole: 0 };
			const r = plan(w, 0, 3, 5, { stations: { [w.ids[1]]: 1 }, kills: { [w.ids[2]]: 4 }, ship: ship, levels: { 21610: 0 }, reduction: 0 });
			assert.deepStrictEqual(r.legs, [4, 4, 4]);
			assert.deepStrictEqual(r.mids.map(m => [m.id, m.station, m.kills]), [[w.ids[1], true, 0], [w.ids[2], false, 4]]);
			assert.strictEqual(r.fuel, 12000);
			assert.deepStrictEqual(r.legFuel, [4000, 4000, 4000]);
			assert.deepStrictEqual(r.fatigue.cooldowns.length, 2);
			const plain = plan(w, 0, 3, 5);
			assert.deepStrictEqual([plain.fuel, plain.legFuel], [null, []]);
		});
		it('brute-force oracle on small random worlds: both modes minimise (jumps, cost) / cost', () => {
			let seed = 20261012;
			const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
			for (let round = 0; round < 40; round++) {
				const n = 9;
				const pts = Array.from({ length: n }, () => [rnd() * 16, rnd() * 10]);
				const secs = pts.map(() => rnd() < 0.15 ? 0.9 : -0.5);
				secs[0] = -0.5;
				const w = world(pts, secs);
				const range = 4 + rnd() * 2;
				const stations = {}, kills = {}, avoid = {}, incursion = {};
				w.ids.forEach(id => { if (rnd() < 0.5) { stations[id] = 1; } if (rnd() < 0.3) { kills[id] = Math.floor(rnd() * 14); } if (rnd() < 0.15) { avoid[id] = true; } if (rnd() < 0.1) { incursion[id] = true; } });
				['jumps', 'fuel'].forEach(prefer => {
					const o = { prefer: prefer, preferStations: true, stations: stations, avoidKills: true, kills: kills, avoid: avoid, incursion: incursion, avoidIncursions: true };
					const valid = id => jumpRange.isValidCynoTarget(id, w.systems[id], o);
					const d = (a, b) => jumpRange.distanceLy(w.coords.pos[a], w.coords.pos[b]);
					const brute = {};		// id -> {jumps, cost}
					const better = (a, b) => !b || (prefer === 'jumps' ? a.jumps < b.jumps || (a.jumps === b.jumps && a.cost < b.cost - 1e-9)
						: a.cost < b.cost - 1e-9 || (Math.abs(a.cost - b.cost) <= 1e-9 && a.jumps < b.jumps));
					const walk = (cur, jumps, cost, seen) => {
						if (jumps > 4) { return; }
						if (jumps > 0) {
							const cand = { jumps: jumps, cost: cost };
							if (better(cand, brute[cur])) { brute[cur] = cand; }
						}
						w.ids.forEach(next => {
							if (seen.indexOf(next) >= 0 || !valid(next) || d(cur, next) > range) { return; }
							// the penalty of cur (a midpoint when it is not the start) is paid when leaving it
							walk(next, jumps + 1, cost + d(cur, next) + (jumps > 0 ? jumpRange.midpointPenalty(cur, o) : 0), seen.concat([next]));
						});
					};
					walk(w.ids[0], 0, 0, [w.ids[0]]);
					const rows = jumpRange.routePlan(w.ids[0], w.ids.slice(1), range, w.index, w.systems, o, 4);
					rows.forEach(r => {
						const tag = 'round ' + round + ' ' + prefer + ' ' + r.id;
						if (!valid(r.id) || !brute[r.id]) { assert.strictEqual(r.jumps, null, tag); return; }
						assert.strictEqual(r.jumps, brute[r.id].jumps, tag);
						assert.ok(near(r.cost, brute[r.id].cost), tag + ' ' + r.cost + ' vs ' + brute[r.id].cost);
						assert.ok(r.path.every(valid) && r.legs.every(l => l <= range + 1e-9), tag);
						assert.strictEqual(new Set(r.path.concat([r.id, w.ids[0]])).size, r.jumps + 1, tag + ' no system twice');
					});
				});
			}
		});
	});

	describe('routeVia (a pinned midpoint)', () => {
		const w = world([[0, 0], [5, 1], [5, 0], [10, 0], [5, -3]]);
		it('keeps the pinned jumps and plans the rest', () => {
			const r = jumpRange.routeVia([w.ids[0], w.ids[4]], w.ids[3], 5.9, w.index, w.systems, {}, 5);
			assert.deepStrictEqual(r.path, [w.ids[4]]);
			assert.strictEqual(r.jumps, 2);
		});
		it('the rest may need more jumps; the limit counts the pinned ones', () => {
			const line = world([[0], [4], [8], [12]]);
			const r = jumpRange.routeVia([line.ids[0], line.ids[1]], line.ids[3], 5, line.index, line.systems, {}, 5);
			assert.deepStrictEqual([r.jumps, r.path], [3, [line.ids[1], line.ids[2]]]);
			assert.strictEqual(jumpRange.routeVia([line.ids[0], line.ids[1]], line.ids[3], 5, line.index, line.systems, {}, 2).jumps, null);
		});
		it('a pin that is the destination, and one that cannot get there', () => {
			const r = jumpRange.routeVia([w.ids[0], w.ids[2]], w.ids[2], 5.5, w.index, w.systems, {}, 5);
			assert.deepStrictEqual([r.jumps, r.path], [1, []]);
			const far = world([[0], [4], [30]]);
			const none = jumpRange.routeVia([far.ids[0], far.ids[1]], far.ids[2], 5, far.index, far.systems, {}, 5);
			assert.deepStrictEqual([none.jumps, none.reason], [null, 'range']);
		});
	});

	describe('alternatives', () => {
		const w = world([[0, 0], [5, 0], [5, 1], [10, 0], [5, 4], [2, 5], [9, 0.5]]);
		it('every valid system within range of both ends, best cost first, without the ends', () => {
			const alt = jumpRange.alternatives(w.ids[0], w.ids[3], 5.5, w.index, w.systems, {});
			assert.deepStrictEqual(alt.map(a => a.id), [w.ids[1], w.ids[2]]);
			alt.forEach(a => {
				assert.ok(a.ly1 <= 5.5 && a.ly2 <= 5.5);
				assert.ok(near(a.ly1, jumpRange.distanceLy(w.coords.pos[w.ids[0]], w.coords.pos[a.id])));
				assert.ok(near(a.cost, a.ly1 + a.ly2));
			});
		});
		it('flags and ordering follow the scoring; avoided ones are listed (last), invalid ones are not', () => {
			const o = { preferStations: true, stations: { [w.ids[2]]: 1 }, avoidKills: true, kills: { [w.ids[1]]: 2 }, avoid: set(w, [2]) };
			const alt = jumpRange.alternatives(w.ids[0], w.ids[3], 5.5, w.index, w.systems, o);
			assert.deepStrictEqual(alt.map(a => [a.id, a.station, a.kills, a.avoided]), [[w.ids[1], false, 2, false], [w.ids[2], true, 0, true]]);
			assert.ok(alt[0].cost < alt[1].cost);
			assert.deepStrictEqual(jumpRange.alternatives(w.ids[0], w.ids[3], 5.5, w.index, w.systems, { incursion: set(w, [1]), avoidIncursions: true }).map(a => a.id), [w.ids[2]]);
			assert.deepStrictEqual(jumpRange.alternatives(w.ids[0], w.ids[3], 5.5, w.index, w.systems, { incursion: set(w, [1]), avoidIncursions: true, covert: true }).map(a => a.id), [w.ids[1], w.ids[2]]);
		});
		it('unknown systems give none', () => {
			assert.deepStrictEqual(jumpRange.alternatives(31000001, w.ids[3], 5.5, w.index, w.systems, {}), []);
		});
	});

	describe('reach (2 jumps) uses the same scoring', () => {
		it('ranks the midpoints by cost when scoring data is passed, with the facts', () => {
			const w = fork();
			const o = { preferStations: true, stations: { [w.ids[2]]: 1 } };
			const r = jumpRange.reach(w.ids[0], w.ids[3], 5.5, w.index, w.systems, o, 2);
			assert.deepStrictEqual(r.via.map(v => v.id), [w.ids[2], w.ids[1]]);
			assert.deepStrictEqual(r.via.map(v => v.station), [true, false]);
			const legacy = jumpRange.reach(w.ids[0], w.ids[3], 5.5, w.index, w.systems, {}, 2);
			assert.deepStrictEqual(legacy.via.map(v => v.id), [w.ids[1], w.ids[2]]);
			assert.strictEqual(legacy.via[0].station, undefined);
		});
		it('an incursion exit is not a target; the cause says so', () => {
			const w = fork();
			const r = jumpRange.reach(w.ids[0], w.ids[1], 5.5, w.index, w.systems, { incursion: set(w, [1]), avoidIncursions: true }, 2);
			assert.deepStrictEqual([r.jumps, r.reason, r.cause], [null, 'target', 'incursion']);
		});
	});

	describe('fatigue (https://wiki.eveuniversity.org/Jump_fatigue)', () => {
		const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);
		it('a carrier: waits use the fatigue before the jump; caps at 5 h fatigue and 30 min wait', () => {
			const f = jumpRange.fatigue([5, 5, 5], 0);
			assert.deepStrictEqual(f.cooldowns, [6, 6]);		// max(1 + 5, 0 / 10), then max(6, 60 / 10)
			assert.strictEqual(f.waitTotal, 12);
			assert.strictEqual(f.fatigueEnd, 300);			// 60 -> min(300, 60 x 6)
			assert.strictEqual(f.cooldownEnd, 30);			// max(6, 300 / 10)
		});
		it('the first jump: fatigue 10 x (1 + LY) minutes, wait 1 + LY', () => {
			const f = jumpRange.fatigue([3.5], 0);
			assert.deepStrictEqual([f.cooldowns, f.fatigueEnd, f.cooldownEnd, f.waitTotal], [[], 45, 4.5, 0]);
		});
		it('the wait comes from fatigue / 10 once that is larger', () => {
			const f = jumpRange.fatigue([1, 1, 1, 1], 0);
			// F: 0 -> 20 -> 40 -> 80 -> 160; waits max(2, F_before / 10): 2, 2, 4
			assert.deepStrictEqual(f.cooldowns, [2, 2, 4]);
			assert.strictEqual(f.fatigueEnd, 160);
		});
		it('Jump Freighter 90% and Black Ops 75% reduce the distance', () => {
			const jf = jumpRange.fatigue([7, 7], jumpRange.fatigueReduction(902));
			close(jf.cooldowns[0], 1.7);
			close(jf.fatigueEnd, 28.9);			// max(17, 17 x 1.7)
			const bo = jumpRange.fatigue([4], jumpRange.fatigueReduction(898));
			assert.deepStrictEqual([bo.fatigueEnd, bo.cooldownEnd], [20, 2]);
			assert.deepStrictEqual([883, 902, 898, 547, 485, 30, 659, 1538, 4594].map(jumpRange.fatigueReduction), [0.9, 0.9, 0.75, 0, 0, 0, 0, 0, 0]);
		});
		it('existing fatigue carries on; bad input is harmless', () => {
			const f = jumpRange.fatigue([2], 0, 100);
			assert.deepStrictEqual([f.fatigueEnd, f.cooldownEnd], [300, 10]);		// max(30, 100 x 3) capped
			assert.deepStrictEqual(jumpRange.fatigue([], 0), { cooldowns: [], waitTotal: 0, fatigueEnd: 0, cooldownEnd: 0 });
			assert.deepStrictEqual(jumpRange.fatigue(null, 5).cooldowns, []);
		});
		it('formatMinutes', () => {
			assert.deepStrictEqual([6, 6.2, 59, 60, 72, 300, 0, NaN].map(jumpRange.formatMinutes), ['6 min', '7 min', '59 min', '1 h', '1 h 12 min', '5 h', '0 min', '0 min']);
		});
	});

	describe('incursions in isValidCynoTarget', () => {
		it('only when avoiding them and not covert', () => {
			const s = { security: -0.5, regionID: 10000002 };
			const inc = { 30009001: true };
			assert.strictEqual(jumpRange.isValidCynoTarget(30009001, s, { incursion: inc }), true);
			assert.strictEqual(jumpRange.isValidCynoTarget(30009001, s, { incursion: inc, avoidIncursions: true }), false);
			assert.strictEqual(jumpRange.isValidCynoTarget(30009001, s, { incursion: inc, avoidIncursions: true, covert: true }), true);
			assert.strictEqual(jumpRange.isValidCynoTarget(30009002, s, { incursion: inc, avoidIncursions: true }), true);
		});
	});

	describe('real data', () => {
		const DATA = loadJSON('public/jumprange/systems');
		const COORDS = jumpRange.decode(DATA);
		const INDEX = jumpRange.buildIndex(COORDS, 7);
		const S = appData.systems;
		const sid = name => Number(Object.keys(S).find(k => S[k].name === name));
		it('all of k-space from Jita, carrier, fuel mode: a timing for the record', () => {
			const dests = COORDS.ids.filter(id => jumpRange.isValidCynoTarget(id, S[id], {}));
			const t = process.hrtime.bigint();
			const rows = jumpRange.routePlan(sid('Jita'), dests, 7, INDEX, S, { prefer: 'fuel' }, 5);
			const ms = Number(process.hrtime.bigint() - t) / 1e6;
			console.log('      routePlan Jita -> ' + dests.length + ' systems, 7 LY, 5 jumps, fuel mode: ' + ms.toFixed(0) + ' ms');
			assert.ok(rows.filter(r => r.jumps !== null).length > 1000);
			assert.ok(ms < 1000);
		});
	});

	describe('stations.json', () => {
		const ST = loadJSON('public/jumprange/stations');
		const SYS = loadJSON('public/jumprange/systems');
		it('lists the systems with an NPC station, among the systems of systems.json', () => {
			let id = 0;
			const ids = ST.systems.map(d => (id += d));
			const known = new Set(jumpRange.decode(SYS).ids);
			assert.strictEqual(ids.length, ST.meta.count);
			assert.strictEqual(ST.counts.length, ids.length);
			assert.ok(ids.every(x => known.has(x)) && ST.counts.every(c => c > 0));
			assert.ok(ids.length > 1000 && ids.length < 2500);
			[30000142, 30002187, 30002659].forEach(hub => assert.ok(ids.indexOf(hub) >= 0, String(hub)));		// Jita, Amarr, Dodixie
			assert.strictEqual(ST.meta.sdeBuild, SYS.meta.sdeBuild);
		});
	});
});
