const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/multi-track');

const J1 = 31000101, J2 = 31000102, HS = 30000001, HS2 = 30000002;
const systems = {
	[J1]: { name: 'J100001', regionID: 11000001 },
	[J2]: { name: 'J100002', regionID: 11000001 },
	[HS]: { name: 'Tanoo', regionID: 10000001 },
	[HS2]: { name: 'Lashesih', regionID: 10000001 },
	30000142: { name: 'Jita', regionID: 10000002 },
	30002187: { name: 'Amarr', regionID: 10000043 },
	32000001: { name: 'Abyss', regionID: 12000001 }
};
const shortest = { [HS - 30000000]: { [HS2 - 30000000]: 1 } };	// HS -> HS2 is a stargate
const ctx = { systems, shortest };

const chars = (o) => Object.assign({
	1: { characterID: 1, characterName: 'Main', systemID: J1 },
	2: { characterID: 2, characterName: 'Alt Two', systemID: J1 },
	3: { characterID: 3, characterName: 'alt one', systemID: J1 }
}, o || {});
const on = (exclude) => ({ multiTrack: { enabled: true, exclude: exclude || {} } });

describe('multiTrack', () => {
	it('enabled: only when switched on (missing = off)', () => {
		assert.strictEqual(multiTrack.enabled(undefined), false);
		assert.strictEqual(multiTrack.enabled({}), false);
		assert.strictEqual(multiTrack.enabled({ multiTrack: {} }), false);
		assert.strictEqual(multiTrack.enabled({ multiTrack: { enabled: 'true' } }), false, 'only a real true');
		assert.strictEqual(multiTrack.enabled({ multiTrack: { enabled: false } }), false);
		assert.strictEqual(multiTrack.enabled(on()), true);
	});

	it('included: on and not excluded', () => {
		assert.strictEqual(multiTrack.included(on(), 2), true);
		assert.strictEqual(multiTrack.included(on({ 2: true }), 2), false);
		assert.strictEqual(multiTrack.included(on({ 2: true }), '3'), true);
		assert.strictEqual(multiTrack.included({}, 2), false, 'feature off');
		assert.strictEqual(multiTrack.included({ multiTrack: { enabled: true } }, 2), true, 'no exclude list');
	});

	it('optedIn: included characters sorted by name, capped', () => {
		assert.deepStrictEqual(multiTrack.optedIn(on(), chars()), ['3', '2', '1']);
		assert.deepStrictEqual(multiTrack.optedIn(on({ 2: true }), chars()), ['3', '1']);
		assert.deepStrictEqual(multiTrack.optedIn({}, chars()), [], 'off');
		assert.deepStrictEqual(multiTrack.optedIn(on(), chars(), 2), ['3', '2']);
		const many = {};
		for (let i = 1; i <= 7; i++) { many[i] = { characterID: i, characterName: 'Pilot ' + i }; }
		assert.strictEqual(multiTrack.optedIn(on(), many).length, 5, 'cap of 5');
		assert.deepStrictEqual(multiTrack.optedIn(on(), many), ['1', '2', '3', '4', '5']);
		assert.deepStrictEqual(multiTrack.optedIn(on(), null), []);
	});

	it('detectMoves: system changes of non-active characters only', () => {
		let r = multiTrack.detectMoves({}, chars(), ['1', '2', '3'], '1');
		assert.deepStrictEqual(r.moves, [], 'first sighting is not a move');
		assert.strictEqual(r.last['2'].systemID, J1);

		r = multiTrack.detectMoves(r.last, chars({ 2: { characterID: 2, characterName: 'Alt Two', systemID: J2, systemName: 'J100002' } }), ['1', '2', '3'], '1');
		assert.strictEqual(r.moves.length, 1);
		assert.deepStrictEqual([r.moves[0].id, r.moves[0].from, r.moves[0].to], ['2', J1, J2]);
		assert.strictEqual(r.moves[0].before.systemID, J1);

		const again = multiTrack.detectMoves(r.last, chars({ 2: { characterID: 2, systemID: J2 } }), ['1', '2', '3'], '1');
		assert.deepStrictEqual(again.moves, [], 'unchanged');
	});

	it('detectMoves: the active character is skipped but remembered', () => {
		let r = multiTrack.detectMoves({}, chars(), ['1', '2'], 1);
		r = multiTrack.detectMoves(r.last, chars({ 1: { characterID: 1, systemID: J2 } }), ['1', '2'], 1);
		assert.deepStrictEqual(r.moves, []);
		assert.strictEqual(r.last['1'].systemID, J2, 'snapshot kept up to date');
		// Once it is no longer active, its old move is not replayed
		r = multiTrack.detectMoves(r.last, chars({ 1: { characterID: 1, systemID: J2 } }), ['1', '2'], 2);
		assert.deepStrictEqual(r.moves, []);
	});

	it('detectMoves: a missing systemID keeps the old snapshot; gone characters are dropped', () => {
		let r = multiTrack.detectMoves({}, chars(), ['1', '2'], null);
		r = multiTrack.detectMoves(r.last, chars({ 2: { characterID: 2, systemID: null } }), ['1', '2'], null);
		assert.deepStrictEqual(r.moves, []);
		assert.strictEqual(r.last['2'].systemID, J1, 'ESI not answered yet (esi.parse replaced the object)');
		r = multiTrack.detectMoves(r.last, chars({ 2: { characterID: 2, systemID: J1 } }), ['1', '2'], null);
		assert.deepStrictEqual(r.moves, [], 'back to the same system: no move');
		r = multiTrack.detectMoves(r.last, { 1: chars()[1] }, ['1'], null);
		assert.strictEqual(r.last['2'], undefined);
		assert.deepStrictEqual(multiTrack.detectMoves(undefined, undefined, undefined, null), { moves: [], last: {} });
	});

	it('detectMoves: no active character means every move counts', () => {
		let r = multiTrack.detectMoves({}, chars(), ['1', '2'], null);
		r = multiTrack.detectMoves(r.last, chars({ 1: { characterID: 1, systemID: J2 }, 2: { characterID: 2, systemID: J2 } }), ['1', '2'], null);
		assert.deepStrictEqual(r.moves.map(m => m.id), ['1', '2']);
	});

	it('isMappableJump: mirrors the automapper', () => {
		const ship = { shipTypeID: 11182 };
		assert.strictEqual(multiTrack.isMappableJump(J1, J2, ship, ctx), true, 'wormhole');
		assert.strictEqual(multiTrack.isMappableJump(HS, J1, ship, ctx), true, 'k-space to j-space');
		assert.strictEqual(multiTrack.isMappableJump(HS, HS2, ship, ctx), false, 'stargate');
		assert.strictEqual(multiTrack.isMappableJump(J1, J1, ship, ctx), false, 'same system');
		assert.strictEqual(multiTrack.isMappableJump(J1, 99, ship, ctx), false, 'unknown system');
		assert.strictEqual(multiTrack.isMappableJump(null, J1, ship, ctx), false);
		assert.strictEqual(multiTrack.isMappableJump(J1, 30000142, ship, ctx), false, 'Jita');
		assert.strictEqual(multiTrack.isMappableJump(30002187, J1, ship, ctx), false, 'Amarr');
		assert.strictEqual(multiTrack.isMappableJump(J1, 32000001, ship, ctx), false, 'abyssal');
		assert.strictEqual(multiTrack.isMappableJump(J1, J2, { shipTypeID: 670 }, ctx), false, 'capsule');
		assert.strictEqual(multiTrack.isMappableJump(J1, J2, { shipTypeID: '33328' }, ctx), false, 'genolution capsule');
		assert.strictEqual(multiTrack.isMappableJump(J1, J2, { stationID: 60003760 }, ctx), false, 'docked');
		assert.strictEqual(multiTrack.isMappableJump(J1, J2, null, ctx), true, 'no ship info yet');
		assert.strictEqual(multiTrack.isMappableJump(J1, J2, ship, { systems }), true, 'no route map');
		assert.strictEqual(multiTrack.isMappableJump(J1, J2, ship, null), false);
	});

	it('jumperLabel: the active name only with 2+ opted in and the active one among them', () => {
		assert.strictEqual(multiTrack.jumperLabel(on(), chars(), '2'), 'Alt Two');
		assert.strictEqual(multiTrack.jumperLabel(on(), chars(), 2), 'Alt Two');
		assert.strictEqual(multiTrack.jumperLabel({}, chars(), '2'), '', 'off');
		assert.strictEqual(multiTrack.jumperLabel(on({ 1: true, 3: true }), chars(), '2'), '', 'only one opted in');
		assert.strictEqual(multiTrack.jumperLabel(on({ 2: true }), chars(), '2'), '', 'active one excluded');
		assert.strictEqual(multiTrack.jumperLabel(on(), chars(), null), '');
		assert.strictEqual(multiTrack.jumperLabel(on(), chars(), 'new'), '');
	});

	it('chipState: active, recent (a minute), fresh, offline', () => {
		const c = { characterID: 2, characterName: 'Alt Two', systemName: 'J100002', shipTypeName: 'Cheetah' };
		let s = multiTrack.chipState(c, { activeId: '2', lastJump: { id: 2, at: 1000 }, now: 5000 });
		assert.deepStrictEqual([s.id, s.active, s.recent, s.fresh, s.offline, s.agoSeconds], ['2', true, true, true, false, 4]);
		s = multiTrack.chipState(c, { activeId: '1', lastJump: { id: '2', at: 1000 }, now: 1000 + 30000 });
		assert.deepStrictEqual([s.active, s.recent, s.fresh], [false, true, false]);
		s = multiTrack.chipState(c, { activeId: '1', lastJump: { id: '2', at: 1000 }, now: 1000 + 60000 });
		assert.strictEqual(s.recent, false, 'after a minute');
		s = multiTrack.chipState(c, { activeId: '1', lastJump: { id: '3', at: 1000 }, now: 2000 });
		assert.deepStrictEqual([s.recent, s.agoSeconds], [false, null], 'someone else jumped');
		s = multiTrack.chipState(Object.assign({ online: false }, c), { activeId: null, lastJump: null, now: 0 });
		assert.deepStrictEqual([s.offline, s.active, s.systemName, s.ship], [true, false, 'J100002', 'Cheetah']);
		s = multiTrack.chipState(undefined, undefined);
		assert.strictEqual(s.active, false);
	});

	it('chipTitle: plain text with where, state and how long ago', () => {
		const t = multiTrack.chipTitle({ name: 'Alt <b>', systemName: 'J100002', ship: 'Cheetah', active: true, recent: true, agoSeconds: 12, offline: false });
		assert.strictEqual(t, 'Alt <b> · J100002, Cheetah · active: its jumps are mapped · jumped 12 s ago');
		assert.strictEqual(multiTrack.chipTitle({ name: 'X', systemName: '', ship: '', active: false, recent: false, agoSeconds: null, offline: true }),
			'X · offline · click to make it the active character');
	});

	it('tipBody: names who jumped and where, and how to turn tips off', () => {
		const b = multiTrack.tipBody({ name: 'Alt Two', fromName: 'J100001', toName: 'J100002', activeName: 'Main' });
		assert.ok(b.indexOf('Alt Two jumped J100001 → J100002, but only Main is mapped') === 0, b);
		assert.ok(/Settings > Wormhole Jumps & Mass/.test(b));
		assert.ok(/Turn tips off in Settings > General\.$/.test(b));
		assert.ok(/^Another of your characters jumped through a wormhole, but only your active character/.test(multiTrack.tipBody()));
	});
});
