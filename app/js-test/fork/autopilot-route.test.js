const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/favourites-panel');
include('app/js/fork/autopilot-route');

const sid = name => Number(Object.keys(appData.systems).find(k => appData.systems[k].name === name));
const JITA = sid('Jita'), PERIMETER = sid('Perimeter'), HEK = sid('Hek'), AMARR = sid('Amarr'), J152820 = sid('J152820');
const MAP = appData.map.shortest, SYSTEMS = appData.systems;

describe('Set destination in game', () => {
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

	describe('Destination', () => {
		it('Last system of the gate route', () =>
			assert.deepEqual(autopilotRoute.destination([PERIMETER, JITA], SYSTEMS), { destID: JITA, from: PERIMETER, jumps: 1 }));
		it('Only the k-space leg counts', () => {
			const path = autopilotRoute.gatePath(MAP, SYSTEMS, HEK, JITA, true);
			assert.deepEqual(autopilotRoute.destination([J152820].concat(path), SYSTEMS), { destID: JITA, from: HEK, jumps: path.length - 1 });
		});
		it('Guidance offset IDs', () =>
			assert.deepEqual(autopilotRoute.destination([PERIMETER - 30000000, JITA - 30000000], SYSTEMS), { destID: JITA, from: PERIMETER, jumps: 1 }));
		it('Ends in J-space: nothing to set', () => assert.equal(autopilotRoute.destination([JITA, J152820], SYSTEMS), null));
		it('One system: nothing to set', () => assert.equal(autopilotRoute.destination([JITA], SYSTEMS), null));
		it('Wormhole then one k-space system: nothing to set', () => assert.equal(autopilotRoute.destination([J152820, JITA], SYSTEMS), null));
		it('Junk: nothing to set', () => assert.equal(autopilotRoute.destination([JITA, 'x|y'], SYSTEMS), null));
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

	describe('Sending to several characters', () => {
		const alice = { characterID: '1', name: 'Alice' }, bob = { characterID: '2', name: 'Bob' }, carol = { characterID: '3', name: 'Carol' };
		const delay = ms => new Promise(r => setTimeout(r, ms));
		it('Exactly one call per character: the destination, clearing other waypoints, one call at a time', async () => {
			const calls = [];
			let running = 0;
			const results = await autopilotRoute.sendToCharacters([alice, bob, carol], JITA, (cid, id, clear) => {
				running++;
				assert.equal(running, 1, 'not in parallel');
				calls.push([cid, id, clear]);
				return delay(cid === '1' ? 5 : 1).then(() => { running--; });
			});
			assert.deepEqual(calls, [['1', JITA, true], ['2', JITA, true], ['3', JITA, true]]);
			assert.deepEqual(results, [
				{ characterID: '1', name: 'Alice', ok: true },
				{ characterID: '2', name: 'Bob', ok: true },
				{ characterID: '3', name: 'Carol', ok: true }]);
		});
		it('One fails, the others continue', async () => {
			const calls = [];
			const results = await autopilotRoute.sendToCharacters([alice, bob, carol], JITA, cid => {
				calls.push(cid);
				return cid === '2' ? Promise.reject({ status: 420 }) : Promise.resolve();
			});
			assert.deepEqual(calls, ['1', '2', '3']);
			assert.deepEqual(results.map(r => r.ok), [true, false, true]);
			assert.equal(results[1].error.status, 420);
		});
		it('A call that throws counts as a failed call', async () => {
			const results = await autopilotRoute.sendToCharacters([alice], JITA, () => { throw new Error('boom'); });
			assert.equal(results[0].ok, false);
			assert.equal(results[0].error.message, 'boom');
		});
		it('Works with jQuery-style thenables', async () => {
			const results = await autopilotRoute.sendToCharacters([alice], JITA, () => ({ then: ok => ok() }));
			assert.deepEqual(results, [{ characterID: '1', name: 'Alice', ok: true }]);
		});
		it('No characters: no calls', async () => {
			let called = false;
			assert.deepEqual(await autopilotRoute.sendToCharacters([], JITA, () => { called = true; }), []);
			assert.equal(called, false);
		});
	});

	describe('Result summary', () => {
		const ok = (n) => ({ characterID: n, name: n, ok: true });
		it('Done text', () => assert.equal(autopilotRoute.doneText('Jita', 'Alice and Bob', 19, 'Hek'),
			'Destination set in game: Jita for Alice and Bob (19 jumps from Hek)'));
		it('Done text, one jump', () => assert.equal(autopilotRoute.doneText('Jita', 'Alice', 1, 'Perimeter'),
			'Destination set in game: Jita for Alice (1 jump from Perimeter)'));
		it('All set', () => assert.deepEqual(autopilotRoute.summary([ok('Alice'), ok('Bob')], 'Jita', 19, 'Hek'),
			{ color: 'green', lines: ['Destination set in game: Jita for Alice and Bob (19 jumps from Hek)'] }));
		it('Some failed: who succeeded, who failed and why', () => assert.deepEqual(
			autopilotRoute.summary([ok('Alice'), { name: 'Bob', ok: false, error: { status: 420 } }, ok('Carol')], 'Jita', 19, 'Hek'),
			{ color: 'yellow', lines: ['Destination set in game: Jita for Alice and Carol (19 jumps from Hek)',
				'Failed for Bob: ESI is rate limiting requests. Try again in a minute.'] }));
		it('The only character failed', () => assert.deepEqual(
			autopilotRoute.summary([{ name: 'Alice', ok: false, error: { status: 0 } }], 'Jita', 19, 'Hek'),
			{ color: 'red', lines: ['Could not set Jita as the destination in game.', 'Could not reach ESI.'] }));
		it('All failed', () => {
			const r = autopilotRoute.summary([{ name: 'Alice', ok: false, error: { status: 403 } }, { name: 'Bob', ok: false, error: { status: 502 } }],
				'Jita', 19, 'Hek');
			assert.equal(r.color, 'red');
			assert.equal(r.lines[0], 'Could not set Jita as the destination in game for any character.');
			assert.ok(/^Alice: EVE refused it/.test(r.lines[1]));
			assert.equal(r.lines[2], 'Bob: ESI error 502.');
		});
		it('Names', () => {
			assert.equal(autopilotRoute.joinNames(['A']), 'A');
			assert.equal(autopilotRoute.joinNames(['A', 'B', 'C']), 'A, B and C');
		});
		it('No waypoint wording left', () => {
			['MAX_WAYPOINTS', 'waypoints', 'reach', 'limit', 'sendAll', 'partialText', 'characterProgressText']
				.forEach(k => assert.equal(autopilotRoute[k], undefined, k));
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
