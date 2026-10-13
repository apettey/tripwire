const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/life-states');

describe('Wormhole life states', () => {
	const H = 3600000, M = 60000;
	const now = Date.UTC(2026, 9, 13, 12, 0, 0);
	const at = ms => lifeStates.formatTime(ms);
	const sig = (id, left, extra) => Object.assign({ id: id, lifeTime: '2026-10-13 00:00:00', lifeLength: '57600', lifeLeft: at(left) }, extra);
	const wh = (life) => ({ id: '7', initialID: '11', secondaryID: '12', life: life, mass: 'stable' });

	describe('enabled', () => {
		it('is on when the key is missing', () => {
			assert.equal(lifeStates.enabled({}), true);
			assert.equal(lifeStates.enabled(undefined), true);
			assert.equal(lifeStates.enabled({ lifeStates: {} }), true);
		});
		it('is off only when explicitly disabled', () => assert.equal(lifeStates.enabled({ lifeStates: { enabled: false } }), false));
	});

	describe('times', () => {
		it('reads the server format as UTC wall-clock, like the sig list (moment.utc)', () => {
			assert.equal(lifeStates.parseTime('2026-10-13 12:00:00'), now);
			assert.equal(lifeStates.parseTime('2026-10-13T12:00:00Z'), now);
			assert.equal(lifeStates.parseTime('2026-10-13 14:00:00 +0200'), now);
		});
		it('unreadable times are NaN', () => {
			assert.ok(isNaN(lifeStates.parseTime('')));
			assert.ok(isNaN(lifeStates.parseTime(null)));
			assert.ok(isNaN(lifeStates.parseTime('soon')));
		});
		it('formats back to the server format', () => {
			assert.equal(lifeStates.formatTime(now), '2026-10-13 12:00:00');
			assert.equal(lifeStates.formatTime(now + 1500), '2026-10-13 12:00:01');
			assert.equal(lifeStates.parseTime(lifeStates.formatTime(now + 4 * H)), now + 4 * H);
		});
	});

	describe('remaining', () => {
		it('is the time to lifeLeft, negative once past', () => {
			assert.equal(lifeStates.remaining(sig('1', now + 2 * H), now), 2 * H);
			assert.equal(lifeStates.remaining(sig('1', now - 5 * M), now), -5 * M);
		});
		it('is null without a signature or a readable time', () => {
			assert.equal(lifeStates.remaining(null, now), null);
			assert.equal(lifeStates.remaining({ lifeLeft: 'x', lifeLength: 100 }, now), null);
		});
		it('a "never expires" signature (lifeLength 0) has no timer until one was set', () => {
			assert.equal(lifeStates.remaining({ lifeTime: '2026-10-13 00:00:00', lifeLeft: '2026-10-13 00:00:00', lifeLength: '0' }, now), null);
			assert.equal(lifeStates.remaining({ lifeTime: '2026-10-13 00:00:00', lifeLeft: at(now + H / 2), lifeLength: 0 }, now), H / 2);
		});
		it('a hole uses the shorter of its two timers', () => {
			assert.equal(lifeStates.holeRemaining([sig('1', now + 3 * H), sig('2', now + 2 * H)], now), 2 * H);
			assert.equal(lifeStates.holeRemaining([undefined, sig('2', now + 2 * H)], now), 2 * H);
			assert.equal(lifeStates.holeRemaining([], now), null);
		});
	});

	describe('derive', () => {
		it('a stable hole is stable whatever its timer', () => {
			assert.equal(lifeStates.derive('stable', -H), 'stable');
			assert.equal(lifeStates.derive('stable', null), 'stable');
		});
		it('critical holes by time left', () => {
			assert.equal(lifeStates.derive('critical', 10 * H), 'lt4h');	// upstream EOL with a natural timer
			assert.equal(lifeStates.derive('critical', 4 * H), 'lt4h');
			assert.equal(lifeStates.derive('critical', H + 1), 'lt4h');
			assert.equal(lifeStates.derive('critical', H), 'lt1h');
			assert.equal(lifeStates.derive('critical', 1), 'lt1h');
			assert.equal(lifeStates.derive('critical', 0), 'expired');
			assert.equal(lifeStates.derive('critical', -2 * H), 'expired');
		});
		it('a critical hole without a timer is <4h', () => assert.equal(lifeStates.derive('critical', null), 'lt4h'));
		it('deriveHole reads the signatures', () => {
			assert.equal(lifeStates.deriveHole(wh('critical'), [sig('11', now + 30 * M), sig('12', now + 30 * M)], now), 'lt1h');
			assert.equal(lifeStates.deriveHole(undefined, [], now), null);
		});
	});

	describe('target timer', () => {
		it('keeps a timer already inside the band', () => {
			assert.equal(lifeStates.targetLifeLeft('lt4h', 2 * H, now), now + 2 * H);
			assert.equal(lifeStates.targetLifeLeft('lt1h', 20 * M, now), now + 20 * M);
			assert.equal(lifeStates.targetLifeLeft('expired', -H, now), now - H);
		});
		it('else sets the band top', () => {
			assert.equal(lifeStates.targetLifeLeft('lt4h', 10 * H, now), now + 4 * H);
			assert.equal(lifeStates.targetLifeLeft('lt4h', 30 * M, now), now + 4 * H);	// back up from <1h
			assert.equal(lifeStates.targetLifeLeft('lt4h', null, now), now + 4 * H);
			assert.equal(lifeStates.targetLifeLeft('lt1h', 3 * H, now), now + H);
			assert.equal(lifeStates.targetLifeLeft('lt1h', -M, now), now + H);
			assert.equal(lifeStates.targetLifeLeft('expired', 3 * H, now), now - 1000);	// a second ago, see remaining
		});
		it('none for stable or an unknown state', () => {
			assert.equal(lifeStates.targetLifeLeft('stable', H, now), null);
			assert.equal(lifeStates.targetLifeLeft('critical', H, now), null);
		});
	});

	describe('payload (sig list, command palette)', () => {
		it('stable -> <1h: life critical and a 1 h timer on both signatures', () => {
			assert.deepStrictEqual(lifeStates.payload(wh('stable'), sig('11', now + 10 * H), sig('12', now + 10 * H), 'lt1h', now), {
				signatures: { update: [{ wormhole: { id: '7', life: 'critical' }, signatures: [{ id: '11', lifeLeft: at(now + H) }, { id: '12', lifeLeft: at(now + H) }] }] }
			});
		});
		it('stable -> <4h keeps a timer already under 4 hours', () => {
			const p = lifeStates.payload(wh('stable'), sig('11', now + 3 * H), sig('12', now + 3 * H), 'lt4h', now);
			assert.equal(p.signatures.update[0].signatures[0].lifeLeft, at(now + 3 * H));
		});
		it('<4h -> Expired: the timer ends now (a second ago)', () => {
			const p = lifeStates.payload(wh('critical'), sig('11', now + 3 * H), sig('12', now + 3 * H), 'expired', now);
			assert.deepStrictEqual(p.signatures.update[0].signatures, [{ id: '11', lifeLeft: at(now - 1000) }, { id: '12', lifeLeft: at(now - 1000) }]);
		});
		it('critical -> stable sends only the life (the server puts back the natural timer)', () => {
			assert.deepStrictEqual(lifeStates.payload(wh('critical'), sig('11', now + 3 * H), sig('12', now + 3 * H), 'stable', now), {
				signatures: { update: [{ wormhole: { id: '7', life: 'stable' }, signatures: [{ id: '11' }, { id: '12' }] }] }
			});
		});
		it('null when already in that state or the state is unknown', () => {
			assert.equal(lifeStates.payload(wh('critical'), sig('11', now + 3 * H), sig('12', now + 3 * H), 'lt4h', now), null);
			assert.equal(lifeStates.payload(wh('stable'), sig('11', now + 3 * H), sig('12', now + 3 * H), 'stable', now), null);
			assert.equal(lifeStates.payload(wh('stable'), null, null, 'critical', now), null);
			assert.equal(lifeStates.payload(undefined, null, null, 'lt1h', now), null);
		});
		it('a "never expires" hole gets a timer too', () => {
			const forever = { lifeTime: '2026-10-13 00:00:00', lifeLeft: '2026-10-13 00:00:00', lifeLength: '0' };
			const p = lifeStates.payload(wh('stable'), Object.assign({ id: '11' }, forever), Object.assign({ id: '12' }, forever), 'lt1h', now);
			assert.equal(p.signatures.update[0].signatures[1].lifeLeft, at(now + H));
		});
	});

	describe('applyToEntry (signature dialog)', () => {
		const entry = (life) => ({ wormhole: { id: '7', life: life, mass: 'stable' }, signatures: [
			{ id: '11', signatureID: 'abc123', lifeLength: '57600' }, { id: '12', signatureID: 'xyz789', lifeLength: '57600' }] });
		it('adds the timer after lifeLength on both signatures', () => {
			const e = entry('critical');
			assert.equal(lifeStates.applyToEntry(e, 'expired', [sig('11', now + 3 * H)], now), true);
			e.signatures.forEach(s => {
				assert.equal(s.lifeLeft, at(now - 1000));
				assert.deepStrictEqual(Object.keys(s).slice(-2), ['lifeLength', 'lifeLeft']);
			});
		});
		it('keeps the current timer when the state did not change (editing an EOL hole\'s name)', () => {
			const e = entry('critical');
			lifeStates.applyToEntry(e, 'lt1h', [sig('11', now + 40 * M), sig('12', now + 40 * M)], now);
			assert.equal(e.signatures[0].lifeLeft, at(now + 40 * M));
		});
		it('the state the dialog opened with keeps each signature timer, even if it moved on meanwhile', () => {
			const e = entry('critical');
			// opened at 1h01m left (<4h), saved two minutes later (now <1h): no reset to 4 hours
			assert.equal(lifeStates.applyToEntry(e, 'lt4h', [sig('11', now - 1 * M), sig('12', now + 59 * M)], now, true), true);
			assert.equal(e.signatures[0].lifeLeft, at(now - 1 * M));
			assert.equal(e.signatures[1].lifeLeft, at(now + 59 * M));
			assert.deepStrictEqual(Object.keys(e.signatures[0]).slice(-2), ['lifeLength', 'lifeLeft']);
		});
		it('unchanged leaves a signature without a current timer alone (it gets the server default)', () => {
			const e = entry('critical');
			lifeStates.applyToEntry(e, 'lt1h', [sig('11', now + 30 * M)], now, true);
			assert.equal(e.signatures[0].lifeLeft, at(now + 30 * M));
			assert.equal(e.signatures[1].lifeLeft, undefined);
		});
		it('a "never expires" hole added as Expired stays Expired', () => {
			const e = { wormhole: { life: 'critical' }, signatures: [{ signatureID: 'abc123', lifeLength: '0' }, { signatureID: 'xyz789', lifeLength: '0' }] };
			lifeStates.applyToEntry(e, 'expired', [], now);
			// the server stores lifeTime = its own now (here the same second, or a little later)
			[now, now + 2000].forEach(serverNow => {
				const stored = e.signatures.map(s => ({ lifeTime: at(serverNow), lifeLength: '0', lifeLeft: s.lifeLeft }));
				assert.equal(lifeStates.deriveHole({ life: 'critical' }, stored, now), 'expired');
			});
		});
		it('a new hole (no current signatures) gets the band top', () => {
			const e = entry('critical');
			lifeStates.applyToEntry(e, 'lt4h', [], now);
			assert.equal(e.signatures[1].lifeLeft, at(now + 4 * H));
		});
		it('leaves stable holes and odd entries alone', () => {
			const e = entry('stable');
			assert.equal(lifeStates.applyToEntry(e, 'stable', [], now), false);
			assert.equal(e.signatures[0].lifeLeft, undefined);
			assert.equal(lifeStates.applyToEntry({ wormhole: 'dummy', signatures: [] }, 'lt1h', [], now), false);
			assert.equal(lifeStates.applyToEntry(entry('critical'), 'stable', [], now), false);
		});
	});

	describe('lifeLeft after lifeLength (undo / redo restore the timer)', () => {
		it('moves lifeLeft behind lifeLength', () => {
			const s = { id: 1, lifeTime: 'a', lifeLeft: 'b', lifeLength: 'c', modifiedTime: 'd' };
			lifeStates.lifeLeftLast(s);
			assert.deepStrictEqual(Object.keys(s), ['id', 'lifeTime', 'lifeLength', 'modifiedTime', 'lifeLeft']);
			assert.equal(s.lifeLeft, 'b');
		});
		it('leaves signatures without both keys alone', () => {
			const s = { id: 1, lifeLeft: 'b', name: 'x' };
			lifeStates.lifeLeftLast(s);
			assert.deepStrictEqual(Object.keys(s), ['id', 'lifeLeft', 'name']);
			assert.equal(lifeStates.lifeLeftLast(null), null);
		});
		it('orders every signature of a payload', () => {
			const full = () => ({ id: 1, lifeLeft: 'b', lifeLength: 'c' });
			const data = { signatures: { add: [full()], update: [{ wormhole: { id: 7 }, signatures: [full(), full()] }], remove: [3] } };
			lifeStates.orderPayload(data);
			assert.deepStrictEqual(Object.keys(data.signatures.add[0]), ['id', 'lifeLength', 'lifeLeft']);
			data.signatures.update[0].signatures.forEach(s => assert.deepStrictEqual(Object.keys(s), ['id', 'lifeLength', 'lifeLeft']));
			assert.doesNotThrow(() => lifeStates.orderPayload({ systemID: 1 }));
			assert.doesNotThrow(() => lifeStates.orderPayload(undefined));
		});
	});

	it('labels', () => {
		assert.deepStrictEqual(lifeStates.STATES.map(s => lifeStates.label(s.key)), ['Stable', '<4h', '<1h', 'Expired']);
		assert.deepStrictEqual(lifeStates.STATES.map(s => s.life), ['stable', 'critical', 'critical', 'critical']);
	});
});
