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
		it('Progress text, one character', () => {
			const info = { character: { name: 'Alice' }, characterIndex: 0, characterCount: 1, done: 0, total: 3 };
			assert.equal(autopilotRoute.characterProgressText('A → B', info), 'Setting route in game: A → B. Alice: waypoint 1 of 3...');
			assert.equal(autopilotRoute.characterProgressText('A → B', Object.assign(info, { done: 3 })), 'Setting route in game: A → B. Alice: waypoint 3 of 3...');
		});
		it('Progress text, several characters', () => assert.equal(
			autopilotRoute.characterProgressText('A → B', { character: { name: 'Bob' }, characterIndex: 1, characterCount: 3, done: 2, total: 12 }),
			'Setting route in game: A → B. Bob: waypoint 3 of 12 (2 of 3 characters)...'));
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
		it('A call that throws counts as a failed call', async () => {
			await assert.rejects(autopilotRoute.sendAll([1, 2], id => { if (id === 2) { throw new Error('boom'); } return Promise.resolve(); }),
				failure => failure.index === 1 && failure.systemID === 2 && failure.error.message === 'boom');
		});
	});

	describe('Sending to several characters', () => {
		const alice = { characterID: '1', name: 'Alice' }, bob = { characterID: '2', name: 'Bob' }, carol = { characterID: '3', name: 'Carol' };
		const delay = ms => new Promise(r => setTimeout(r, ms));
		it('All succeed: each character in order, clear then append, one call at a time', async () => {
			const calls = [];
			let running = 0;
			const results = await autopilotRoute.sendToCharacters([alice, bob, carol], [10, 20, 30], (cid, id, clear) => {
				running++;
				assert.equal(running, 1, 'not in parallel');
				calls.push(cid + ':' + id + ':' + clear);
				return delay(id === 10 ? 5 : 1).then(() => { running--; });
			});
			assert.deepEqual(calls, ['1:10:true', '1:20:false', '1:30:false', '2:10:true', '2:20:false', '2:30:false',
				'3:10:true', '3:20:false', '3:30:false']);
			assert.deepEqual(results, [
				{ characterID: '1', name: 'Alice', ok: true, sent: 3 },
				{ characterID: '2', name: 'Bob', ok: true, sent: 3 },
				{ characterID: '3', name: 'Carol', ok: true, sent: 3 }]);
		});
		it('One fails, the others continue; partial failure index', async () => {
			const calls = [];
			const results = await autopilotRoute.sendToCharacters([alice, bob, carol], [10, 20, 30], (cid, id, clear) => {
				calls.push(cid + ':' + id);
				return cid === '2' && id === 30 ? Promise.reject({ status: 420 }) : Promise.resolve();
			});
			assert.deepEqual(calls, ['1:10', '1:20', '1:30', '2:10', '2:20', '2:30', '3:10', '3:20', '3:30']);
			assert.deepEqual(results.map(r => r.ok), [true, false, true]);
			assert.equal(results[1].sent, 2);
			assert.equal(results[1].systemID, 30);
			assert.equal(results[1].error.status, 420);
		});
		it('Failure on the first waypoint: nothing sent for that character', async () => {
			const results = await autopilotRoute.sendToCharacters([alice], [10, 20], () => Promise.reject({ status: 403 }));
			assert.deepEqual(results, [{ characterID: '1', name: 'Alice', ok: false, sent: 0, systemID: 10, error: { status: 403 } }]);
		});
		it('Progress per character and waypoint', async () => {
			const seen = [];
			await autopilotRoute.sendToCharacters([alice, bob], [10, 20], () => Promise.resolve(),
				p => seen.push(p.character.name + ' ' + p.done + '/' + p.total + ' ' + (p.characterIndex + 1) + '/' + p.characterCount));
			assert.deepEqual(seen, ['Alice 0/2 1/2', 'Alice 1/2 1/2', 'Alice 2/2 1/2', 'Bob 0/2 2/2', 'Bob 1/2 2/2', 'Bob 2/2 2/2']);
		});
		it('No characters: no calls', async () => {
			let called = false;
			assert.deepEqual(await autopilotRoute.sendToCharacters([], [10], () => { called = true; }), []);
			assert.equal(called, false);
		});
	});

	describe('Result summary', () => {
		const limited = autopilotRoute.limit([1, 2, 3].map(sys), 50);
		const name = id => 'S' + (id - 30000000);
		const ok = (n) => ({ characterID: n, name: n, ok: true, sent: 3 });
		it('All set', () => assert.deepEqual(autopilotRoute.summary([ok('Alice'), ok('Bob')], 'A → B', 'S3', 9, limited, name),
			{ color: 'green', lines: ['Route set in game: A → B for Alice and Bob (9 jumps, 3 waypoints)'] }));
		it('Cap notice kept', () => {
			const capped = autopilotRoute.limit([1, 2, 3, 4, 5, 6].map(sys), 3);
			assert.ok(/more than the 3 Tripwire sets/.test(autopilotRoute.summary([ok('Alice')], 'A → B', 'S6', 9, capped, name).lines[0]));
		});
		it('Some failed: who succeeded, who failed and why, how far it got', () => assert.deepEqual(
			autopilotRoute.summary([ok('Alice'), { name: 'Bob', ok: false, sent: 2, error: { status: 420 } }, ok('Carol')], 'A → B', 'S3', 9, limited, name),
			{ color: 'yellow', lines: ['Route set in game: A → B for Alice and Carol (9 jumps, 3 waypoints)',
				'Failed for Bob: ESI is rate limiting requests. Try again in a minute. Only the first 2 waypoints were set.'] }));
		it('The only character failed: the old error', () => assert.deepEqual(
			autopilotRoute.summary([{ name: 'Alice', ok: false, sent: 1, error: { status: 0 } }], 'A → B', 'S3', 9, limited, name),
			{ color: 'red', lines: ['Could not set the route to S3 in game.', 'Could not reach ESI. Only the first waypoint was set.'] }));
		it('All failed', () => {
			const r = autopilotRoute.summary([{ name: 'Alice', ok: false, sent: 0, error: { status: 403 } }, { name: 'Bob', ok: false, sent: 0, error: { status: 502 } }],
				'A → B', 'S3', 9, limited, name);
			assert.equal(r.color, 'red');
			assert.equal(r.lines[0], 'Could not set the route to S3 in game for any character.');
			assert.equal(r.lines[2], 'Bob: ESI error 502.');
		});
		it('Names', () => {
			assert.equal(autopilotRoute.joinNames(['A']), 'A');
			assert.equal(autopilotRoute.joinNames(['A', 'B', 'C']), 'A, B and C');
		});
	});

	describe('Errors', () => {
		it('Missing scope / expired token', () => assert.ok(/log in again/i.test(autopilotRoute.errorText({ status: 403 }))));
		it('Unauthorised', () => assert.ok(/log in again/i.test(autopilotRoute.errorText({ status: 401 }))));
		it('Network', () => assert.equal(autopilotRoute.errorText({ status: 0 }), 'Could not reach ESI.'));
		it('Other', () => assert.equal(autopilotRoute.errorText({ status: 502 }), 'ESI error 502.'));
	});

	describe('Characters', () => {
		const chars = {
			5: { characterName: 'Pilot', accessToken: 't' },
			6: { characterName: 'Alt', accessToken: 't' },
			7: { characterName: 'Expired' }
		};
		const byName = list => list.reduce((o, c) => { o[c.name] = c; return o; }, {});
		it('Every tracked character, sorted by name, with or without ESI', () => {
			const list = autopilotRoute.characters({ tracking: { active: 5 } }, chars);
			assert.deepEqual(list.map(c => c.name), ['Alt', 'Expired', 'Pilot']);
			assert.deepEqual(byName(list).Pilot, { characterID: '5', name: 'Pilot', usable: true, reason: null, active: true, preselected: true });
		});
		it('Preselects only the active character', () => {
			const list = byName(autopilotRoute.characters({ tracking: { active: '5' } }, chars));
			assert.equal(list.Alt.preselected, false);
			assert.equal(list.Pilot.preselected, true);
		});
		it('Character without ESI: shown, disabled, with a reason, never preselected', () => {
			const c = byName(autopilotRoute.characters({ tracking: { active: 7 } }, chars)).Expired;
			assert.equal(c.usable, false);
			assert.equal(c.reason, 'no ESI login, log in again');
			assert.equal(c.preselected, false);
			assert.equal(c.active, true);
		});
		it('No active character: nothing preselected', () =>
			assert.ok(autopilotRoute.characters({ tracking: { active: 'new' } }, chars).every(c => !c.preselected)));
		it('Last selection wins over the active character (usable ones only)', () => {
			const list = byName(autopilotRoute.characters({ tracking: { active: 5 }, autopilotRoute: { characters: ['6', 7] } }, chars));
			assert.deepEqual([list.Alt.preselected, list.Pilot.preselected, list.Expired.preselected], [true, false, false]);
		});
		it('Last selection with no usable character left: back to the active one', () => {
			const list = byName(autopilotRoute.characters({ tracking: { active: 5 }, autopilotRoute: { characters: ['7', '99'] } }, chars));
			assert.equal(list.Pilot.preselected, true);
		});
		it('No characters', () => {
			assert.deepEqual(autopilotRoute.characters({ tracking: { active: 5 } }, {}), []);
			assert.deepEqual(autopilotRoute.characters(undefined, undefined), []);
		});
		it('Error instead of the picker when no one can be sent to', () => {
			assert.equal(autopilotRoute.noCharacterError([]), 'Select a tracked character (logged in with EVE SSO) first.');
			assert.equal(autopilotRoute.noCharacterError(autopilotRoute.characters({}, { 7: chars[7] })),
				'Expired has no ESI login. Log in again with EVE SSO.');
			assert.ok(/None of your tracked characters/.test(autopilotRoute.noCharacterError(
				autopilotRoute.characters({}, { 7: chars[7], 8: { characterName: 'Old' } }))));
			assert.equal(autopilotRoute.noCharacterError(autopilotRoute.characters({}, chars)), null);
		});
		it('Select all state', () => {
			const list = autopilotRoute.characters({}, chars);
			assert.equal(autopilotRoute.selectAllState(list, []), 'none');
			assert.equal(autopilotRoute.selectAllState(list, ['5']), 'some');
			assert.equal(autopilotRoute.selectAllState(list, [5, 6]), 'all');
		});
	});
});
