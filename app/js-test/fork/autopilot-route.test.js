const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/favourites-panel');
include('app/js/fork/autopilot-route');

const sid = name => Number(Object.keys(appData.systems).find(k => appData.systems[k].name === name));
const JITA = sid('Jita'), PERIMETER = sid('Perimeter'), HEK = sid('Hek'), AMARR = sid('Amarr'), J152820 = sid('J152820');
const MAP = appData.map.shortest, SYSTEMS = appData.systems;

// A tiny gate map: synthetic systems 30000001.. (keys are systemID - 30000000)
function tinyMap(edges) {
	const map = {};
	edges.forEach(([a, b]) => {
		(map[a] = map[a] || {})[b] = 0;
		(map[b] = map[b] || {})[a] = 0;
	});
	return map;
}
function tinySystems(securities) {
	const systems = {};
	Object.keys(securities).forEach(k => {
		systems[30000000 + Number(k)] = { name: 'S' + k, security: securities[k], regionID: 10000002, factionID: null };
	});
	return systems;
}
const sys = n => 30000000 + n;

/** Every segment between consecutive waypoints is the only shortest gate route (as EVE would pick it) */
function followsPath(path, waypoints) {
	let from = 0;
	for (const wp of waypoints) {
		const to = path.indexOf(wp, from + 1);
		if (to < 0) { return false; }
		const info = autopilotRoute.reach(MAP, path[from], to - from);
		for (let i = from + 1; i <= to; i++) {
			if (info.dist[path[i]] !== i - from || info.count[path[i]] !== 1) { return false; }
		}
		from = to;
	}
	return from === path.length - 1;
}

describe('Set route in game', () => {
	describe('IDs', () => {
		it('Real ID', () => assert.equal(autopilotRoute.toID(JITA), JITA));
		it('Guidance offset ID', () => assert.equal(autopilotRoute.toID(JITA - 30000000), JITA));
		it('String ID', () => assert.equal(autopilotRoute.toID('' + JITA), JITA));
		it('Unknown chain pseudo-system', () => assert.equal(autopilotRoute.toID('5|1234'), null));
		it('Nothing', () => assert.equal(autopilotRoute.toID(undefined), null));
		it('Normalise a guidance path', () => assert.deepEqual(autopilotRoute.normalise([PERIMETER - 30000000, JITA - 30000000]), [PERIMETER, JITA]));
		it('Normalise rejects junk', () => assert.equal(autopilotRoute.normalise([JITA, 'x|y']), null));
	});

	describe('K-space leg', () => {
		it('Drops the wormhole part', () => assert.deepEqual(autopilotRoute.kspaceLeg([J152820, HEK, JITA], SYSTEMS), [HEK, JITA]));
		it('Only k-space after the last J-space system', () =>
			assert.deepEqual(autopilotRoute.kspaceLeg([PERIMETER, J152820, HEK, JITA], SYSTEMS), [HEK, JITA]));
		it('All k-space', () => assert.deepEqual(autopilotRoute.kspaceLeg([PERIMETER, JITA], SYSTEMS), [PERIMETER, JITA]));
		it('Ends in J-space: nothing', () => assert.deepEqual(autopilotRoute.kspaceLeg([JITA, J152820], SYSTEMS), []));
		it('Guidance offset IDs', () => assert.deepEqual(autopilotRoute.kspaceLeg([PERIMETER - 30000000, JITA - 30000000], SYSTEMS), [PERIMETER, JITA]));
	});

	describe('Gate path', () => {
		it('Perimeter to Jita', () => assert.deepEqual(autopilotRoute.gatePath(MAP, SYSTEMS, PERIMETER, JITA, false), [PERIMETER, JITA]));
		it('Same system', () => assert.deepEqual(autopilotRoute.gatePath(MAP, SYSTEMS, JITA, JITA, false), [JITA]));
		it('Matches the Favourites panel jump counts', () => {
			[[HEK, JITA], [HEK, AMARR], [JITA, AMARR]].forEach(([a, b]) => {
				[false, true].forEach(safe => {
					const path = autopilotRoute.gatePath(MAP, SYSTEMS, a, b, safe);
					assert.equal(path.length - 1, favouritesPanel.gateDistances(MAP, SYSTEMS, a, safe)[b]);
				});
			});
		});
		it('Safe route: only high-sec in between', () => {
			const path = autopilotRoute.gatePath(MAP, SYSTEMS, HEK, JITA, true);
			assert.ok(path.slice(1, -1).every(id => autopilotRoute.isHighSec(SYSTEMS[id])));
			assert.ok(path.length > autopilotRoute.gatePath(MAP, SYSTEMS, HEK, JITA, false).length);
		});
		it('Path is connected by gates', () => {
			const path = autopilotRoute.gatePath(MAP, SYSTEMS, HEK, AMARR, false);
			for (let i = 1; i < path.length; i++) { assert.ok(MAP[path[i - 1] - 30000000][path[i] - 30000000] !== undefined); }
		});
		it('Avoid list is respected', () => {
			const path = autopilotRoute.gatePath(MAP, SYSTEMS, HEK, JITA, false);
			const avoided = SYSTEMS[path[3]].name.toLowerCase();
			const other = autopilotRoute.gatePath(MAP, SYSTEMS, HEK, JITA, false, { [avoided]: true });
			assert.ok(other.indexOf(path[3]) < 0);
		});
		it('No route to J-space', () => assert.equal(autopilotRoute.gatePath(MAP, SYSTEMS, JITA, J152820, false), null));
	});

	describe('Waypoints (tiny map)', () => {
		// 1-2-3-4 and a short cut 1-5-4
		const map = tinyMap([[1, 2], [2, 3], [3, 4], [1, 5], [5, 4]]);
		const hs = tinySystems({ 1: 0.9, 2: 0.9, 3: 0.9, 4: 0.9, 5: 0.9 });
		it('One jump: just the destination', () => assert.deepEqual(autopilotRoute.waypoints([sys(1), sys(2)], map, hs), [sys(2)]));
		it('Nowhere to go', () => assert.deepEqual(autopilotRoute.waypoints([sys(1)], map, hs), []));
		it('Unique shortest: just the destination', () => assert.deepEqual(autopilotRoute.waypoints([sys(1), sys(2), sys(3)], map, hs), [sys(3)]));
		it('A shorter way exists: pin the path', () =>
			assert.deepEqual(autopilotRoute.waypoints([sys(1), sys(2), sys(3), sys(4)], map, hs), [sys(3), sys(4)]));
		it('Two equally short ways: pin the one we want', () => {
			// 1-2-4 and 1-3-4
			const square = tinyMap([[1, 2], [2, 4], [1, 3], [3, 4]]);
			assert.deepEqual(autopilotRoute.waypoints([sys(1), sys(2), sys(4)], square, hs), [sys(2), sys(4)]);
		});
		it('Leaving high-sec: waypoint before it, then every low-sec system', () => {
			const line = tinyMap([[1, 2], [2, 3], [3, 4]]);
			const mixed = tinySystems({ 1: 0.9, 2: 0.9, 3: 0.3, 4: 0.3 });
			assert.deepEqual(autopilotRoute.waypoints([sys(1), sys(2), sys(3), sys(4)], line, mixed), [sys(2), sys(3), sys(4)]);
		});
		it('Low-sec stretch that is the only shortest route: still every system ("safer" would go round by high-sec)', () => {
			// 1-2-3-4 through low-sec 2 and 3 (3 jumps, unique shortest); 1-5-6-7-8-4 all high-sec (5 jumps)
			const map = tinyMap([[1, 2], [2, 3], [3, 4], [1, 5], [5, 6], [6, 7], [7, 8], [8, 4]]);
			const systems = tinySystems({ 1: 0.9, 2: 0.3, 3: 0.2, 4: 0.9, 5: 0.9, 6: 0.9, 7: 0.9, 8: 0.9 });
			assert.deepEqual(autopilotRoute.waypoints([1, 2, 3, 4].map(sys), map, systems), [sys(2), sys(3), sys(4)]);
		});
		it('Back into high-sec: skips ahead again', () => {
			const line = tinyMap([[1, 2], [2, 3], [3, 4], [4, 5]]);
			const systems = tinySystems({ 1: 0.9, 2: 0.3, 3: 0.9, 4: 0.9, 5: 0.9 });
			assert.deepEqual(autopilotRoute.waypoints([1, 2, 3, 4, 5].map(sys), line, systems), [sys(2), sys(5)]);
		});
	});

	describe('Cap', () => {
		const list = [1, 2, 3, 4, 5, 6].map(sys);
		it('Within the cap: unchanged', () =>
			assert.deepEqual(autopilotRoute.limit(list, 6), { waypoints: list, capped: false, total: 6 }));
		it('Over the cap: first max-1, then the destination', () =>
			assert.deepEqual(autopilotRoute.limit(list, 3), { waypoints: [sys(1), sys(2), sys(6)], capped: true, total: 6, pinnedUntil: sys(2) }));
		it('Default cap', () => assert.equal(autopilotRoute.limit(new Array(80).fill(0).map((x, i) => sys(i + 1))).waypoints.length, autopilotRoute.MAX_WAYPOINTS));
		const name = id => 'S' + (id - 30000000);
		it('Done text', () => assert.equal(autopilotRoute.doneText('A → B', 'Pilot', 9, autopilotRoute.limit(list, 6), name),
			'Route set in game: A → B for Pilot (9 jumps, 6 waypoints)'));
		it('Done text when capped says where EVE takes over', () => assert.equal(
			autopilotRoute.doneText('A → B', 'Pilot', 9, autopilotRoute.limit(list, 3), name),
			'Route set in game: A → B for Pilot (9 jumps, 3 waypoints). The route needs 6 waypoints, more than the 3 Tripwire sets: '
			+ 'it is followed as far as S2, from there EVE picks its own route to S6.'));
		it('Progress text', () => {
			assert.equal(autopilotRoute.progressText('A → B', 0, 3), 'Setting route in game: A → B, waypoint 1 of 3...');
			assert.equal(autopilotRoute.progressText('A → B', 3, 3), 'Setting route in game: A → B, waypoint 3 of 3...');
		});
	});

	describe('Waypoints (New Eden)', () => {
		[[HEK, JITA, false], [HEK, JITA, true], [HEK, AMARR, false], [HEK, AMARR, true], [JITA, AMARR, true]].forEach(([a, b, safe]) => {
			it(SYSTEMS[a].name + ' to ' + SYSTEMS[b].name + (safe ? ' (safe)' : ''), () => {
				const path = autopilotRoute.gatePath(MAP, SYSTEMS, a, b, safe);
				const waypoints = autopilotRoute.waypoints(path, MAP, SYSTEMS);
				assert.equal(waypoints[waypoints.length - 1], b);
				assert.ok(waypoints.length <= path.length - 1);
				if (safe) { assert.ok(waypoints.length < path.length - 1, 'fewer waypoints than jumps on a high-sec route'); }
				path.slice(1).forEach(id => {
					if (!autopilotRoute.isHighSec(SYSTEMS[id])) { assert.ok(waypoints.indexOf(id) >= 0, SYSTEMS[id].name + ' (not high-sec) is a waypoint'); }
				});
				assert.ok(followsPath(path, waypoints), 'each leg is the only shortest route');
			});
		});
	});

	describe('Favourite leg', () => {
		const pathFn = (from, to, safe) => autopilotRoute.gatePath(MAP, SYSTEMS, from, to, safe);
		it('Through the chain: from the exit', () => {
			const plan = { status: 'ok', mode: 'safe', kind: 'chain', gatesIn: 0, holes: 1, gatesOut: 19, exitSystemID: HEK };
			const leg = autopilotRoute.favouriteLeg(plan, J152820, JITA, pathFn);
			assert.equal(leg.from, HEK);
			assert.equal(leg.path.length - 1, 19);
		});
		it('Direct: from where you are', () => {
			const plan = { status: 'ok', mode: 'shortest', kind: 'direct', gatesIn: 1, holes: 0, gatesOut: 0 };
			assert.deepEqual(autopilotRoute.favouriteLeg(plan, PERIMETER, JITA, pathFn).path, [PERIMETER, JITA]);
		});
		it('Favourite on the chain: nothing to fly by gates', () => {
			const plan = { status: 'ok', mode: 'shortest', kind: 'chain', gatesIn: 0, holes: 2, gatesOut: 0, exitSystemID: JITA };
			assert.equal(autopilotRoute.favouriteLeg(plan, J152820, JITA, pathFn).error, 'Nothing to fly by gates after the chain');
		});
		it('Gates into the chain but none after it', () => {
			const plan = { status: 'ok', mode: 'shortest', kind: 'chain', gatesIn: 3, holes: 1, gatesOut: 0, entrySystemID: HEK, exitSystemID: JITA };
			assert.equal(autopilotRoute.favouriteLeg(plan, PERIMETER, JITA, pathFn).error, 'Nothing to fly by gates after the chain');
		});
		it('Here', () => assert.ok(autopilotRoute.favouriteLeg({ status: 'here' }, JITA, JITA, pathFn).error));
		it('No route', () => assert.equal(autopilotRoute.favouriteLeg({ status: 'no-route', mode: 'safe' }, JITA, AMARR, pathFn).error, 'No high-sec only route'));
		it('No plan', () => assert.ok(autopilotRoute.favouriteLeg(undefined, JITA, AMARR, pathFn).error));
	});

	describe('Destination leg', () => {
		it('Guidance path from the best exit', () => {
			const leg = autopilotRoute.destinationLeg({ jumps: 1, path: [PERIMETER - 30000000, JITA - 30000000] });
			assert.deepEqual(leg.path, [PERIMETER, JITA]);
			assert.equal(leg.from, PERIMETER);
		});
		it('On the chain', () => assert.ok(autopilotRoute.destinationLeg({ jumps: 0, path: [JITA - 30000000] }).error));
		it('No route', () => assert.ok(autopilotRoute.destinationLeg(null).error));
	});

	describe('Sending', () => {
		const delay = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));
		it('In order, one at a time, clearing only first', async () => {
			const calls = [];
			let running = 0;
			const sent = await autopilotRoute.sendAll([1, 2, 3], (id, clear) => {
				running++;
				assert.equal(running, 1, 'not in parallel');
				calls.push([id, clear]);
				return delay(10 - id * 3).then(() => { running--; });
			});
			assert.equal(sent, 3);
			assert.deepEqual(calls, [[1, true], [2, false], [3, false]]);
		});
		it('Progress', async () => {
			const progress = [];
			await autopilotRoute.sendAll([1, 2], () => Promise.resolve(), (done, total) => progress.push(done + '/' + total));
			assert.deepEqual(progress, ['1/2', '2/2']);
		});
		it('Stops at the first failure', async () => {
			const calls = [];
			await assert.rejects(autopilotRoute.sendAll([1, 2, 3], id => {
				calls.push(id);
				return id === 2 ? Promise.reject({ status: 403 }) : Promise.resolve();
			}), failure => failure.index === 1 && failure.systemID === 2 && failure.error.status === 403);
			assert.deepEqual(calls, [1, 2]);
		});
		it('Works with jQuery-style thenables', async () => {
			const thenable = { then: (ok) => ok() };
			assert.equal(await autopilotRoute.sendAll([1], () => thenable), 1);
		});
	});

	describe('Errors and character', () => {
		it('Missing scope / expired token', () => assert.ok(/log in again/i.test(autopilotRoute.errorText({ status: 403 }))));
		it('Unauthorised', () => assert.ok(/log in again/i.test(autopilotRoute.errorText({ status: 401 }))));
		it('Network', () => assert.equal(autopilotRoute.errorText({ status: 0 }), 'Could not reach ESI.'));
		it('Other', () => assert.equal(autopilotRoute.errorText({ status: 502 }), 'ESI error 502.'));
		it('Active tracked character', () => assert.deepEqual(
			autopilotRoute.character({ tracking: { active: 5 } }, { 5: { characterName: 'Pilot', accessToken: 't' } }),
			{ characterID: 5, name: 'Pilot' }));
		it('No active character', () => assert.ok(autopilotRoute.character({ tracking: { active: null } }, {}).error));
		it('Active character without ESI', () => assert.ok(autopilotRoute.character({ tracking: { active: 5 } }, {}).error));
		it('No token', () => assert.ok(autopilotRoute.character({ tracking: { active: 5 } }, { 5: { characterName: 'P' } }).error));
	});
});
