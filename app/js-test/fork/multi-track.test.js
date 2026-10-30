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
			+ 'not switched to automatically (its A switch is off or over the 5) · Auto-switch paused 2:41; other characters\' jumps are still mapped · click to resume');
		assert.ok(/switches to it when you close the open jump question/.test(multiTrack.chipTitle(Object.assign({}, base, { active: false, queued: true }))));
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
		assert.strictEqual(multiTrack.waitNotice('Alt Two', 'J1', 'J2', true),
			'Alt Two jumped J1 → J2 while a jump question was open. It is mapped; Tripwire switches to it when you close this question.');
		assert.strictEqual(multiTrack.waitNotice('Alt Two', 'J1', 'J2'),
			'Alt Two jumped J1 → J2 while a jump question was open. It is mapped and switched to as soon as you close this question.');
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
		assert.strictEqual(multiTrack.capNote(o, many), 'Switching to 6 characters on jumps; only 5 are used (the first by name). Turn one off with its A icon.');
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
		const plan = (moves, extra) => multiTrack.planMoves(moves, Object.assign({ now: NOW, windowMs: 10000, eligible: () => true }, extra || {}));
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
		it('an alt lands where the active character is, but through another hole: a jump of its own (switch)', () => {
			assert.deepStrictEqual(actions(plan([mv(2, HS, J1)])), ['2:switch']);
			assert.deepStrictEqual(actions(plan([mv(1, J2, J1, true), mv(2, J2, J1)])), ['1:self', '2:fleet'], 'the same hole: fleet');
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
		it('not eligible (off, over the cap, untracked): skip; paused: mapped without switching, the fleet rule still counts', () => {
			assert.deepStrictEqual(actions(plan([mv(2, HS, J2)], { eligible: () => false })), ['2:skip']);
			assert.deepStrictEqual(actions(plan([mv(2, HS, J2)], { paused: true })), ['2:map']);
			assert.deepStrictEqual(actions(plan([mv(1, HS, J1, true), mv(2, HS, J1)], { paused: true })), ['1:self', '2:fleet']);
			assert.deepStrictEqual(actions(plan([mv(2, J1, J2), mv(3, J1, J2)], { paused: true })), ['2:map', '3:map'], 'each mapped (the second finds the hole)');
		});
		it('old entries fall out of recent', () => {
			assert.deepStrictEqual(plan([], { recent: [{ from: 1, to: 2, at: NOW - 20000 }, { from: 3, to: 4, at: NOW - 1000 }] }).recent.map(x => x.from), [3]);
			assert.deepStrictEqual(multiTrack.planMoves(undefined, undefined).decisions, []);
		});
	});

	it('isFleet: the same hole (from → to) within the window only', () => {
		const m = { id: '2', from: J1, to: J2 };
		assert.strictEqual(multiTrack.isFleet(m, [{ from: J1, to: J2, at: 0 }], 5000, 10000), true);
		assert.strictEqual(multiTrack.isFleet(m, [{ from: J1, to: J2, at: 0 }], 15000, 10000), false, 'too long ago');
		assert.strictEqual(multiTrack.isFleet(m, [{ from: J2, to: J1, at: 0 }], 5000, 10000), false, 'the other way');
		assert.strictEqual(multiTrack.isFleet(m, [{ from: HS, to: J2, at: 0 }], 5000, 10000), false, 'same destination, another hole');
		assert.strictEqual(multiTrack.isFleet(m, null, 5000, 10000), false);
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

	describe('replayPlan: switching after queued jumps', () => {
		const m = (from, to, extra) => Object.assign({ id: '2', from, to }, extra || {});
		it('chained jumps where the character is now: replayed in order (first from as a character change)', () => {
			assert.deepStrictEqual(multiTrack.replayPlan([m(J1, J2), m(J2, HS)], HS), { silent: [], steps: [
				{ systemID: J1, characterChange: true }, { systemID: J2, characterChange: false }, { systemID: HS, characterChange: false }] });
			assert.deepStrictEqual(multiTrack.replayPlan([m(J1, J2)], undefined).steps.length, 2, 'location unknown: trust the jumps');
		});
		it('moved on since (or the jumps don\'t chain): map them silently, then only a character change (no false hole)', () => {
			const a = m(J1, J2), b = m(J2, HS);
			assert.deepStrictEqual(multiTrack.replayPlan([a, b], HS2), { silent: [a, b], steps: [{ systemID: HS2, characterChange: true }] });
			const c = m(HS, HS2);
			assert.deepStrictEqual(multiTrack.replayPlan([a, c], HS2), { silent: [a, c], steps: [{ systemID: HS2, characterChange: true }] });
		});
		it('a jump already mapped silently (while held): the rest silently, then a character change', () => {
			const a = m(J1, J2, { mapped: true }), b = m(J2, HS);
			assert.deepStrictEqual(multiTrack.replayPlan([a, b], HS), { silent: [b], steps: [{ systemID: HS, characterChange: true }] });
		});
		it('nothing queued', () => {
			assert.deepStrictEqual(multiTrack.replayPlan([], J1), { silent: [], steps: [{ systemID: J1, characterChange: true }] });
			assert.deepStrictEqual(multiTrack.replayPlan(null, null), { silent: [], steps: [] });
		});
	});

	it('switchBack: the character a switch left takes the same hole within the window', () => {
		const last = { prevId: '1', toId: '2', from: J1, to: J2, at: 1000 };
		assert.strictEqual(multiTrack.switchBack({ id: '1', from: J1, to: J2 }, last, 6000, 10000), true);
		assert.strictEqual(multiTrack.switchBack({ id: '1', from: J1, to: J2 }, last, 12000, 10000), false, 'too late');
		assert.strictEqual(multiTrack.switchBack({ id: '1', from: J1, to: J2, at: 5000 }, last, 40000, 10000), true,
			're-checked after a question closed: measured from the jump');
		assert.strictEqual(multiTrack.switchBack({ id: '3', from: J1, to: J2 }, last, 6000, 10000), false, 'someone else');
		assert.strictEqual(multiTrack.switchBack({ id: '1', from: J2, to: J1 }, last, 6000, 10000), false, 'another hole');
		assert.strictEqual(multiTrack.switchBack({ id: '1', from: J1, to: J2 }, null, 6000, 10000), false);
	});

	it('afterPick: pauses switching for 3 minutes and drops waiting switches', () => {
		const st = multiTrack.afterPick({ pausedUntil: 0, queue: [{ id: '2' }] }, 1000);
		assert.deepStrictEqual(st, { pausedUntil: 1000 + 180000, queue: [] });
	});

	it('Ctrl+K "Switch to character": the previously active character first, run = a manual pick', () => {
		const chars3 = chars();
		const opts1 = multiTrack.commandChoices(chars3, '1', '2');
		assert.deepStrictEqual(opts1.map(c => c.value), ['2', '3', '1'], 'previous first, then by name');
		assert.deepStrictEqual(opts1.map(c => c.hint), ['(previous)', '', '(active)']);
		assert.deepStrictEqual(multiTrack.commandChoices(chars3, '1', null).map(c => c.value), ['3', '2', '1']);
		assert.deepStrictEqual(multiTrack.commandChoices(chars3, '2', '2').map(c => c.value), ['3', '2', '1'], 'previous = active: no move');
		const picked = [];
		const def = multiTrack.switchCommand({ characters: () => chars3, activeId: () => '1', prevId: () => '2', pick: id => { picked.push(id); return id !== '9'; } });
		assert.strictEqual(def.id, 'tracking.switchTo');
		assert.deepStrictEqual(def.args[0].choices({}).map(c => c.value), ['2', '3', '1']);
		def.run({ character: 3 });
		assert.deepStrictEqual(picked, ['3']);
		assert.throws(() => def.run({ character: '9' }), /isn't tracked/);
		assert.strictEqual(def.enabled(), true);
		assert.strictEqual(def.hint(), 'Active: Main');
		assert.strictEqual(multiTrack.switchCommand({ characters: () => ({}), activeId: () => null, prevId: () => null, pick: () => false }).enabled(), 'No tracked characters');
	});

	it('minutes / toggleTitle', () => {
		assert.strictEqual(multiTrack.minutes(180000), '3m');
		assert.strictEqual(multiTrack.minutes(121000), '3m');
		assert.strictEqual(multiTrack.minutes(5000), '1m');
		assert.strictEqual(multiTrack.toggleTitle(false), "Switch to this character when it jumps: off: its jumps aren't mapped unless it is active");
		assert.ok(/^Switch to this character when it jumps: on \(while switching is paused/.test(multiTrack.toggleTitle(true)));
		assert.ok(/over the 5/.test(multiTrack.toggleTitle(true, true)));
	});

	describe('round 4: holds, replays, fleet mapping', () => {
		const NOW = 100000;
		const mv = (id, from, to, active, at) => ({ id: String(id), from, to, active: !!active, at: at === undefined ? NOW : at });

		it('E1: Logi jumps, the active Scanner takes the same hole 4 s later, a question holds Logi for 15 s: no switch', () => {
			// t0: Logi (2) jumps J1 -> J2; switch decided and held
			let p = multiTrack.planMoves([mv(2, J1, J2, false, NOW)], { now: NOW, windowMs: 10000, eligible: () => true });
			assert.deepStrictEqual(p.decisions.map(d => d.action), ['switch']);
			const queued = p.decisions[0].move;
			// t0+4: the active Scanner (1) takes the same hole
			p = multiTrack.planMoves([mv(1, J1, J2, true, NOW + 4000)], { now: NOW + 4000, windowMs: 10000, recent: p.recent, keepSince: queued.at });
			// t0+19: the question closed; ticks in between keep the entries while Logi is held
			p = multiTrack.planMoves([], { now: NOW + 19000, windowMs: 10000, recent: p.recent, keepSince: queued.at });
			assert.ok(p.recent.some(r => r.by === 'self'), 'the active character\'s jump is still known');
			const due = multiTrack.releaseDecision([queued], { recent: p.recent.filter(r => r.by !== '2'), windowMs: 10000, now: NOW + 19000,
				activeSystemID: J2, currentSystemID: J2 });
			assert.strictEqual(due.action, 'fleet');
			// even without the entry: Logi is where the active character is, so no switch
			const stay = multiTrack.releaseDecision([queued], { recent: [], windowMs: 10000, now: NOW + 19000, activeSystemID: J2, currentSystemID: J2 });
			assert.strictEqual(stay.action, 'stay');
			assert.deepStrictEqual(stay.map, [queued], 'its jump is still mapped');
		});

		it('releaseDecision: switch when apart; nothing queued', () => {
			assert.deepStrictEqual(multiTrack.releaseDecision([mv(2, J1, J2)], { recent: [], now: NOW, activeSystemID: HS, currentSystemID: J2 }), { action: 'switch', map: [] });
			assert.strictEqual(multiTrack.releaseDecision([], {}).action, 'none');
		});

		it('E3: a fleet jump whose hole the active character didn\'t get mapped (dialog cancelled) is mapped from the alt', () => {
			const queued = mv(2, J1, J2, false, NOW);
			const due = multiTrack.releaseDecision([queued, mv(2, J2, HS, false, NOW + 1000)], {
				recent: [{ from: J1, to: J2, at: NOW + 3000, by: 'self' }], windowMs: 10000, now: NOW + 30000, activeSystemID: J2, currentSystemID: HS });
			assert.strictEqual(due.action, 'fleet');
			assert.deepStrictEqual(due.map.map(m => [m.from, m.to]), [[J1, J2], [J2, HS]], 'the first jump too, not only the later ones');
			assert.deepStrictEqual(multiTrack.releaseDecision([Object.assign(queued, { mapped: true })], {
				recent: [{ from: J1, to: J2, at: NOW, by: 'self' }], now: NOW, activeSystemID: J2, currentSystemID: J2 }).map, [], 'already mapped');
		});

		it('isFleet / planMoves: measured from the jump, entries kept while a switch is held', () => {
			assert.strictEqual(multiTrack.isFleet({ from: J1, to: J2, at: NOW }, [{ from: J1, to: J2, at: NOW + 4000 }], NOW + 60000, 10000), true);
			const p = multiTrack.planMoves([], { now: NOW + 30000, windowMs: 10000, recent: [{ from: J1, to: J2, at: NOW }, { from: 1, to: 2, at: NOW - 20000 }], keepSince: NOW + 5000 });
			assert.deepStrictEqual(p.recent.map(r => r.from), [J1], 'kept from 10 s before the held switch');
		});

		describe('E2: runReplay', () => {
			const run = (plan, moves, blockAfter, silentOk) => {
				const eves = [];
				let replayed = 0;
				const deferred = multiTrack.runReplay(plan, moves, {
					silentMap: m => { if (silentOk === false) { return false; } m.mapped = true; return true; },
					eve: step => { eves.push(step); if (!step.characterChange) { replayed++; } },
					blocked: () => blockAfter !== undefined && replayed >= blockAfter
				});
				return { eves, deferred };
			};
			const a = () => ({ id: '2', from: J1, to: J2 }), b = () => ({ id: '2', from: J2, to: HS }), c = () => ({ id: '2', from: HS, to: HS2 });

			it('all replayed in order', () => {
				const moves = [a(), b(), c()];
				const r = run(multiTrack.replayPlan(moves, HS2), moves);
				assert.deepStrictEqual(r.eves.map(e => [e.systemID, e.characterChange]), [[J1, true], [J2, false], [HS, false], [HS2, false]]);
				assert.deepStrictEqual(r.deferred, []);
			});
			it('the first replayed jump opens "Which Signature?": the rest wait, the character lands on its last system', () => {
				const moves = [a(), b(), c()];
				const r = run(multiTrack.replayPlan(moves, HS2), moves, 1);
				assert.deepStrictEqual(r.eves.map(e => [e.systemID, e.characterChange]), [[J1, true], [J2, false], [HS2, true]]);
				assert.deepStrictEqual(r.deferred.map(m => [m.from, m.to]), [[J2, HS], [HS, HS2]], 'mapped later, in order');
			});
			it('silent maps that can\'t run now are returned too', () => {
				const moves = [a(), b()];
				const plan = multiTrack.replayPlan(moves, HS2);	// moved on: silent + character change
				const r = run(plan, moves, undefined, false);
				assert.deepStrictEqual(r.deferred.map(m => [m.from, m.to]), [[J1, J2], [J2, HS]]);
				assert.deepStrictEqual(r.eves.map(e => [e.systemID, e.characterChange]), [[HS2, true]]);
			});
		});

		it('E7: latest jumper and the mapped-without-switching tooltip', () => {
			assert.strictEqual(multiTrack.latestJumper({ 1: { at: NOW - 5000 }, 2: { at: NOW - 1000 }, 3: NOW - 200000 }, NOW), '2');
			assert.strictEqual(multiTrack.latestJumper({}, NOW), null);
			const c = { characterID: 2, characterName: 'Logi', systemName: 'J2', shipTypeName: 'Scimitar' };
			const st = multiTrack.chipState(c, { activeId: '1', now: NOW, latestId: '2',
				jumps: { 2: { at: NOW - 12000, kind: 'mapped', fromName: 'J100001', toName: 'J100002', stayedOn: 'Bob Scanner' } } });
			assert.deepStrictEqual([st.recent, st.latest, st.silent], [true, true, true]);
			assert.ok(/mapped J100001 → J100002 12 s ago \(stayed on Bob Scanner\)$/.test(multiTrack.chipTitle(st)), multiTrack.chipTitle(st));
			const sw = multiTrack.chipState(c, { activeId: '2', now: NOW, latestId: '1', jumps: { 2: { at: NOW - 3000, kind: 'jumped', fromName: 'A', toName: 'B' } } });
			assert.deepStrictEqual([sw.latest, sw.silent], [false, false]);
			assert.ok(/jumped A → B 3 s ago$/.test(multiTrack.chipTitle(sw)));
		});
	});
});
