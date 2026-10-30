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

	it('detectMoves: system changes, the active character marked', () => {
		let r = multiTrack.detectMoves({}, chars(), ['1', '2', '3'], '1');
		assert.deepStrictEqual(r.moves, [], 'first sighting is not a move');
		assert.strictEqual(r.last['2'].systemID, J1);

		r = multiTrack.detectMoves(r.last, chars({ 2: { characterID: 2, characterName: 'Alt Two', systemID: J2, systemName: 'J100002' } }), ['1', '2', '3'], '1');
		assert.strictEqual(r.moves.length, 1);
		assert.deepStrictEqual([r.moves[0].id, r.moves[0].from, r.moves[0].to, r.moves[0].active], ['2', J1, J2, false]);
		assert.strictEqual(r.moves[0].before.systemID, J1);

		const again = multiTrack.detectMoves(r.last, chars({ 2: { characterID: 2, systemID: J2 } }), ['1', '2', '3'], '1');
		assert.deepStrictEqual(again.moves, [], 'unchanged');
	});

	it('detectMoves: the active character move is reported, marked active', () => {
		let r = multiTrack.detectMoves({}, chars(), ['1', '2'], 1);
		r = multiTrack.detectMoves(r.last, chars({ 1: { characterID: 1, systemID: J2 } }), ['1', '2'], 1);
		assert.deepStrictEqual(r.moves.map(m => [m.id, m.active]), [['1', true]]);
		assert.strictEqual(r.last['1'].systemID, J2);
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

	it('detectMoves: no active character means no move is marked active', () => {
		let r = multiTrack.detectMoves({}, chars(), ['1', '2'], null);
		r = multiTrack.detectMoves(r.last, chars({ 1: { characterID: 1, systemID: J2 }, 2: { characterID: 2, systemID: J2 } }), ['1', '2'], null);
		assert.deepStrictEqual(r.moves.map(m => [m.id, m.active]), [['1', false], ['2', false]]);
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

	it('chipState: active, recent (a minute, any jumper), fresh, offline, queued, paused, mapped, stale', () => {
		const c = { characterID: 2, characterName: 'Alt Two', systemName: 'J100002', shipTypeName: 'Cheetah' };
		let s = multiTrack.chipState(c, { activeId: '2', jumps: { 2: 1000 }, now: 5000 });
		assert.deepStrictEqual([s.id, s.active, s.recent, s.fresh, s.offline, s.agoSeconds, s.mapped], ['2', true, true, true, false, 4, true]);
		s = multiTrack.chipState(c, { activeId: '1', jumps: { 2: 1000, 3: 1000 }, now: 1000 + 30000 });
		assert.deepStrictEqual([s.active, s.recent, s.fresh], [false, true, false], 'several jumpers can be ringed');
		s = multiTrack.chipState(c, { activeId: '1', jumps: { 2: 1000 }, now: 1000 + 60000 });
		assert.strictEqual(s.recent, false, 'after a minute');
		s = multiTrack.chipState(c, { activeId: '1', jumps: { 3: 1000 }, now: 2000 });
		assert.deepStrictEqual([s.recent, s.agoSeconds], [false, null], 'someone else jumped');
		s = multiTrack.chipState(Object.assign({ online: false }, c), { activeId: null, now: 0 });
		assert.deepStrictEqual([s.offline, s.active, s.systemName, s.ship], [true, false, 'J100002', 'Cheetah']);
		s = multiTrack.chipState(c, { activeId: '2', queued: { 2: true }, used: ['1'], pausedMs: 61000, stale: { 2: 'token expired' } });
		assert.deepStrictEqual([s.queued, s.mapped, s.paused, s.pausedMs, s.stale], [true, false, true, 61000, 'token expired']);
		s = multiTrack.chipState(c, { activeId: '1', pausedMs: 61000 });
		assert.deepStrictEqual([s.paused, s.pausedMs], [false, 0], 'the pause shows on the active chip only');
		s = multiTrack.chipState(undefined, undefined);
		assert.strictEqual(s.active, false);
	});

	it('chipTitle: plain text with where, state and how long ago', () => {
		const base = { name: 'Alt <b>', systemName: 'J100002', ship: 'Cheetah', active: true, recent: true, agoSeconds: 12, offline: false, mapped: true };
		assert.strictEqual(multiTrack.chipTitle(base), 'Alt <b> · J100002, Cheetah · Active character (Current System, Follow, destination) · jumped 12 s ago');
		assert.strictEqual(multiTrack.chipTitle({ name: 'X', systemName: '', ship: '', active: false, recent: false, agoSeconds: null, offline: true }),
			'X · offline · Click to make this the active character');
		assert.strictEqual(multiTrack.chipTitle(Object.assign({}, base, { recent: false, mapped: false, paused: true, pausedMs: 161000, stale: 'token expired' })),
			'Alt <b> · J100002, Cheetah · location not updating (token expired) · Active character (Current System, Follow, destination) · '
			+ 'not auto-mapped (its A switch is off or over the 5) · Auto-switch paused 2:41 · click to resume');
		assert.ok(/jump waiting/.test(multiTrack.chipTitle(Object.assign({}, base, { active: false, queued: true }))));
	});

	it('tipBody: names who jumped and where, and how to turn tips off', () => {
		const b = multiTrack.tipBody({ name: 'Alt Two', fromName: 'J100001', toName: 'J100002', activeName: 'Main' });
		assert.ok(b.indexOf('Alt Two jumped J100001 → J100002, but only Main is mapped') === 0, b);
		assert.ok(/Settings > Wormhole Jumps & Mass/.test(b));
		assert.ok(/Turn tips off in Settings > General\.$/.test(b));
		assert.ok(b.indexOf('Turn on "' + multiTrack.SETTING_TEXT + '" in Settings') > 0, 'quotes the Settings row exactly');
		assert.ok(/^Another of your characters jumped through a wormhole, but only your active character/.test(multiTrack.tipBody()));
	});

	it('whoFor: the jumper is named with 2+ tracked characters, on or off', () => {
		const jumper = { characterID: 2, characterName: 'Alt Two', systemID: J2 };
		assert.deepStrictEqual(multiTrack.whoFor(chars(), jumper), { id: '2', name: 'Alt Two' });
		assert.strictEqual(multiTrack.whoFor({ 2: chars()[2] }, jumper), null, 'one character: no change');
		assert.strictEqual(multiTrack.whoFor(chars(), null), null);
		assert.strictEqual(multiTrack.whoFor(chars(), { characterID: 2 }), null, 'no name');
		assert.strictEqual(multiTrack.whoFor(undefined, jumper), null);
	});

	it('pickerTitle: names the jumper in the automapper dialog title', () => {
		assert.strictEqual(multiTrack.pickerTitle({ id: '2', name: 'Alt Two' }), 'Which signature did Alt Two jump through?');
		assert.strictEqual(multiTrack.pickerTitle(null), 'Which Signature?');
	});

	it('waitNotice / switchText / removedNotice: plain-text notices', () => {
		assert.strictEqual(multiTrack.waitNotice('Alt Two', 'J1', 'J2'),
			'Alt Two jumped J1 → J2 while a jump question was open. It is mapped as soon as you close this question.');
		assert.ok(/^A character jumped \? → \?/.test(multiTrack.waitNotice()));
		assert.strictEqual(multiTrack.switchText('Hauler Alt', 'J132605', 'J125634'), 'Now on Hauler Alt (jumped J132605 → J125634)');
		assert.ok(/^Main is no longer tracked/.test(multiTrack.removedNotice('Main')));
		assert.ok(/^The active character is no longer tracked/.test(multiTrack.removedNotice('')));
	});

	it('tracking: the user has an active character (null / empty = untracked on purpose)', () => {
		assert.strictEqual(multiTrack.tracking('9001'), true);
		assert.strictEqual(multiTrack.tracking(0), true);
		assert.strictEqual(multiTrack.tracking(null), false);
		assert.strictEqual(multiTrack.tracking(undefined), false);
		assert.strictEqual(multiTrack.tracking(''), false);
	});

	it('tracking: "new" (before the first character arrives) is not a pick', () => {
		assert.strictEqual(multiTrack.tracking('new'), false);
	});

	it('switchedOn / optedIn / capNote: the A switches choose; only 5 are used, with a note', () => {
		const many = {};
		for (let i = 1; i <= 7; i++) { many[i] = { characterID: i, characterName: 'Pilot ' + i }; }
		const o = { multiTrack: { enabled: true, exclude: { 7: true } } };
		assert.deepStrictEqual(multiTrack.switchedOn(o, many), ['1', '2', '3', '4', '5', '6']);
		assert.deepStrictEqual(multiTrack.optedIn(o, many), ['1', '2', '3', '4', '5']);
		assert.strictEqual(multiTrack.capNote(o, many), 'Auto-map is on for 6 characters; only 5 are used (the first by name). Turn one off with its A icon.');
		o.multiTrack.exclude[6] = true;
		assert.strictEqual(multiTrack.capNote(o, many), '');
		assert.strictEqual(multiTrack.capNote({}, many), '', 'feature off');
	});

	it('stripIds: the used characters plus the active one even if it is off or over the cap', () => {
		assert.deepStrictEqual(multiTrack.stripIds(on({ 2: true }), chars(), '2'), ['3', '2', '1'], 'excluded active shown, by name');
		assert.deepStrictEqual(multiTrack.stripIds(on({ 2: true }), chars(), '1'), ['3', '1']);
		assert.deepStrictEqual(multiTrack.stripIds(on(), chars(), null), ['3', '2', '1'], 'nothing tracked: still shown (a click resumes)');
		assert.deepStrictEqual(multiTrack.stripIds({}, chars(), '1'), [], 'off');
		assert.deepStrictEqual(multiTrack.stripIds(on(), chars(), '99'), ['3', '2', '1'], 'unknown active');
	});

	describe('planMoves: fleet jumps, pause', () => {
		const NOW = 100000;
		const mv = (id, from, to, active) => ({ id: String(id), from, to, active: !!active });
		const plan = (moves, extra) => multiTrack.planMoves(moves, Object.assign({ now: NOW, windowMs: 10000, activeSystemID: J1, eligible: () => true }, extra || {}));
		const actions = (r) => r.decisions.map(d => d.move.id + ':' + d.action);

		it('one alt jumps elsewhere: switch', () => {
			assert.deepStrictEqual(actions(plan([mv(2, HS, J2)], { activeSystemID: J1 })), ['2:switch']);
		});
		it('the active character and an alt take the same hole in the same tick: no switch', () => {
			assert.deepStrictEqual(actions(plan([mv(2, J1, J2), mv(1, J1, J2, true)])), ['1:self', '2:fleet']);
		});
		it('the active character took that hole a few seconds ago: no switch; long ago: switch', () => {
			assert.deepStrictEqual(actions(plan([mv(2, J1, J2)], { activeSystemID: HS, recent: [{ from: J1, to: J2, at: NOW - 8000 }] })), ['2:fleet']);
			assert.deepStrictEqual(actions(plan([mv(2, J1, J2)], { activeSystemID: HS, recent: [{ from: J1, to: J2, at: NOW - 30000 }] })), ['2:switch']);
		});
		it('an alt lands where the active character already is: no switch', () => {
			assert.deepStrictEqual(actions(plan([mv(2, HS, J1)], { activeSystemID: J1 })), ['2:fleet']);
		});
		it('several alts through one hole without the active character: one switch, the rest follow it', () => {
			const r = plan([mv(2, J1, J2), mv(3, J1, J2), mv(4, J1, J2)], { activeSystemID: HS });
			assert.deepStrictEqual(actions(r), ['2:switch', '3:fleet', '4:fleet']);
			assert.deepStrictEqual(r.recent.map(x => [x.from, x.to, x.by]), [[J1, J2, '2']]);
			// ...and one tick later the next alt through the same hole follows too
			assert.deepStrictEqual(actions(plan([mv(5, J1, J2)], { activeSystemID: HS, recent: r.recent, now: NOW + 1000 })), ['5:fleet']);
		});
		it('two alts through different holes: two switches (queued in order)', () => {
			assert.deepStrictEqual(actions(plan([mv(2, J1, J2), mv(3, HS, HS2)], { activeSystemID: 30000142 })), ['2:switch', '3:switch']);
		});
		it('not eligible (off, over the cap, untracked): skip; paused: no switch, but the fleet rule still counts', () => {
			assert.deepStrictEqual(actions(plan([mv(2, HS, J2)], { eligible: () => false })), ['2:skip']);
			assert.deepStrictEqual(actions(plan([mv(2, HS, J2)], { paused: true })), ['2:paused']);
			assert.deepStrictEqual(actions(plan([mv(2, HS, J1)], { paused: true })), ['2:fleet']);
		});
		it('old entries fall out of recent', () => {
			assert.deepStrictEqual(plan([], { recent: [{ from: 1, to: 2, at: NOW - 20000 }, { from: 3, to: 4, at: NOW - 1000 }] }).recent.map(x => x.from), [3]);
			assert.deepStrictEqual(multiTrack.planMoves(undefined, undefined).decisions, []);
		});
	});

	it('isFleet: same hole within the window, or landing where the active character is', () => {
		const m = { id: '2', from: J1, to: J2 };
		assert.strictEqual(multiTrack.isFleet(m, [{ from: J1, to: J2, at: 0 }], HS, 5000, 10000), true);
		assert.strictEqual(multiTrack.isFleet(m, [{ from: J2, to: J1, at: 0 }], HS, 5000, 10000), false, 'the other way');
		assert.strictEqual(multiTrack.isFleet(m, [], J2, 5000, 10000), true);
		assert.strictEqual(multiTrack.isFleet(m, null, null, 5000, 10000), false);
	});

	it('shortName: keeps the start and the end of a long name', () => {
		assert.strictEqual(multiTrack.shortName('Bob Hauler'), 'Bob Hauler');
		assert.strictEqual(multiTrack.shortName('Alexandria Longname-Of-The-Deep Space', 18), 'Alexandr…eep Space');
		assert.strictEqual(multiTrack.shortName('Bob Scout Number Two', 18).slice(-8), 'mber Two');
		assert.strictEqual(multiTrack.shortName(null), '');
		assert.ok(multiTrack.shortName('x'.repeat(40), 18).length === 18);
	});

	it('clock: m:ss', () => {
		assert.strictEqual(multiTrack.clock(161000), '2:41');
		assert.strictEqual(multiTrack.clock(180000), '3:00');
		assert.strictEqual(multiTrack.clock(500), '0:01');
		assert.strictEqual(multiTrack.clock(-5), '0:00');
	});
});
