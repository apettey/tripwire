const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/bookmark-template');
include('app/js/fork/hole-naming');
include('app/js/fork/rage-rolling');

describe('Rage rolling', () => {
	const HOME = 31001880;	// J152820, C5 with an H296 static
	const OTHER = 31000880;
	const WH = { H296: { jump: 2000000000 }, B274: { jump: 375000000 }, O477: { jump: 375000000 }, U210: { jump: 375000000 } };

	// sigs: [id, systemID, signatureID, name]; holes: [whID, initialID, secondaryID, type, parent]
	function world(sigs, holes) {
		const signatures = {}, wormholes = {};
		sigs.forEach(([id, systemID, signatureID, name]) => {
			signatures[id] = { id, systemID, signatureID, type: 'wormhole', name: name === undefined ? null : name };
		});
		holes.forEach(([id, initialID, secondaryID, type, parent]) => {
			wormholes[id] = { id, initialID, secondaryID, type, parent, life: 'stable', mass: 'stable' };
		});
		return { signatures, wormholes };
	}
	// A freshly pasted hole: this side has the sig ID, the far side nothing (paste.js: parent initial, no type)
	const pasted = (sigID, whID, signatureID) => ({ sigs: [[sigID, HOME, signatureID], [sigID + 1, null, null]], hole: [whID, sigID, sigID + 1, null, 'initial'] });
	function plan(w, extra) {
		return rageRolling.plan(Object.assign({ systemID: HOME, statics: ['H296'], signatures: w.signatures, wormholes: w.wormholes,
			candidates: [], staticFirst: true, naming: true, table: WH }, extra));
	}
	const brief = (fills) => fills.map(f => [f.sig.signatureID, f.type, f.name, f.parent]);

	describe('sideType', () => {
		const wh = { initialID: 1, secondaryID: 2, type: 'H296', parent: 'initial' };
		it('the typed side', () => assert.equal(rageRolling.sideType(1, wh), 'H296'));
		it('the other side is a K162', () => assert.equal(rageRolling.sideType(2, wh), 'K162'));
		it('"????" on the far side means K162 here', () => assert.equal(rageRolling.sideType(1, { initialID: 1, secondaryID: 2, type: '????', parent: 'secondary' }), 'K162'));
		it('a pasted hole is unknown', () => assert.equal(rageRolling.sideType(1, { initialID: 1, secondaryID: 2, type: null, parent: 'initial' }), ''));
		it('no parent is unknown', () => assert.equal(rageRolling.sideType(1, { initialID: 1, secondaryID: 2, type: null, parent: null }), ''));
		it('no wormhole is unknown', () => assert.equal(rageRolling.sideType(1, null), ''));
	});

	describe('plan', () => {
		it('old static gone: the new unknown hole becomes the static, named A', () => {
			const p = pasted(10, 100, 'qrs456');
			const w = world(p.sigs, [p.hole]);
			assert.deepEqual(brief(plan(w, { candidates: [{ signatureID: 'QRS456' }] })), [['qrs456', 'H296', 'A', 'initial']]);
		});
		it('by id too (a sig the paste turned into a wormhole)', () => {
			const p = pasted(10, 100, 'qrs456');
			assert.equal(plan(world(p.sigs, [p.hole]), { candidates: [{ id: 10 }] }).length, 1);
		});
		it('old static still there (its type): nothing', () => {
			const p = pasted(10, 100, 'qrs456');
			const w = world(p.sigs.concat([[20, HOME, 'abc123', 'A'], [21, null, null]]), [p.hole, [200, 20, 21, 'H296', 'initial']]);
			assert.deepEqual(plan(w, { candidates: [{ signatureID: 'qrs456' }] }), []);
		});
		it('old static still there (its name A, no type set): nothing', () => {
			const p = pasted(10, 100, 'qrs456');
			const w = world(p.sigs.concat([[20, HOME, 'abc123', 'A'], [21, null, null]]), [p.hole, [200, 20, 21, null, 'initial']]);
			assert.deepEqual(plan(w, { candidates: [{ signatureID: 'qrs456' }] }), []);
		});
		it('a K162 named A does not hold the slot when Statics first is off (type only)', () => {
			const p = pasted(10, 100, 'qrs456');
			const w = world(p.sigs.concat([[20, HOME, 'abc123', 'A'], [21, OTHER, null]]), [p.hole, [200, 20, 21, 'U210', 'secondary']]);
			assert.deepEqual(brief(plan(w, { candidates: [{ signatureID: 'qrs456' }], staticFirst: false })), [['qrs456', 'H296', 'B', 'initial']]);
		});
		it('other holes in the system keep their names; the static still gets A', () => {
			const p = pasted(10, 100, 'qrs456');
			const w = world(p.sigs.concat([[20, HOME, 'abc123', 'B'], [21, OTHER, null]]), [p.hole, [200, 20, 21, '????', 'secondary']]);
			assert.deepEqual(brief(plan(w, { candidates: [{ signatureID: 'qrs456' }] })), [['qrs456', 'H296', 'A', 'initial']]);
		});
		it('several new holes: the first in paste order is the static', () => {
			const a = pasted(10, 100, 'zzz999'), b = pasted(30, 300, 'aaa111');
			const w = world(a.sigs.concat(b.sigs), [a.hole, b.hole]);
			assert.deepEqual(brief(plan(w, { candidates: [{ signatureID: 'zzz999' }, { signatureID: 'aaa111' }] })).map(f => f[0]), ['zzz999']);
		});
		it('two statics, both gone: each empty slot in order with the next new hole', () => {
			const a = pasted(10, 100, 'aaa111'), b = pasted(30, 300, 'bbb222');
			const w = world(a.sigs.concat(b.sigs), [a.hole, b.hole]);
			assert.deepEqual(brief(plan(w, { statics: ['B274', 'O477'], candidates: [{ signatureID: 'aaa111' }, { signatureID: 'bbb222' }] })),
				[['aaa111', 'B274', 'A', 'initial'], ['bbb222', 'O477', 'B', 'initial']]);
		});
		it('two statics, only the second gone: the new hole becomes the second, named B', () => {
			const a = pasted(10, 100, 'aaa111');
			const w = world(a.sigs.concat([[20, HOME, 'old111', 'A'], [21, null, null]]), [a.hole, [200, 20, 21, 'B274', 'initial']]);
			assert.deepEqual(brief(plan(w, { statics: ['B274', 'O477'], candidates: [{ signatureID: 'aaa111' }] })), [['aaa111', 'O477', 'B', 'initial']]);
		});
		it('K162s, named and typed sigs are not candidates', () => {
			const w = world([
				[10, HOME, 'k16200', null], [11, OTHER, null],
				[20, HOME, 'named0', 'C'], [21, null, null],
				[30, HOME, 'typed0', null], [31, null, null],
				[40, HOME, 'retbk0', '!A'], [41, null, null]
			], [[100, 10, 11, 'U210', 'secondary'], [200, 20, 21, null, 'initial'], [300, 30, 31, 'U210', 'initial'], [400, 40, 41, null, 'initial']]);
			assert.deepEqual(plan(w, { candidates: ['k16200', 'named0', 'typed0', 'retbk0'].map(s => ({ signatureID: s })) }), []);
		});
		it('a hole whose far side is known (linked by return hole on paste) is not a candidate', () => {
			const w = world([[10, HOME, 'qrs456', null], [11, OTHER, null]], [[100, 10, 11, null, 'initial']]);
			assert.deepEqual(plan(w, { candidates: [{ signatureID: 'qrs456' }] }), []);
		});
		it('only candidates count: an unknown hole someone else pasted is left alone', () => {
			const p = pasted(10, 100, 'qrs456');
			assert.deepEqual(plan(world(p.sigs, [p.hole]), { candidates: [] }), []);
		});
		it('a candidate in another system is left alone', () => {
			const w = world([[10, OTHER, 'qrs456', null], [11, null, null]], [[100, 10, 11, null, 'initial']]);
			assert.deepEqual(plan(w, { candidates: [{ signatureID: 'qrs456' }] }), []);
		});
		it('no statics (k-space home): nothing', () => {
			const p = pasted(10, 100, 'qrs456');
			assert.deepEqual(plan(world(p.sigs, [p.hole]), { statics: [], candidates: [{ signatureID: 'qrs456' }] }), []);
		});
		it('Suggest hole names off: the type is set, the name is not', () => {
			const p = pasted(10, 100, 'qrs456');
			assert.deepEqual(brief(plan(world(p.sigs, [p.hole]), { candidates: [{ signatureID: 'qrs456' }], naming: false })), [['qrs456', 'H296', null, 'initial']]);
		});
		it('the hole on the secondary side gets parent secondary', () => {
			const w = world([[10, null, null], [11, HOME, 'qrs456', null]], [[100, 10, 11, null, null]]);
			assert.deepEqual(brief(plan(w, { candidates: [{ signatureID: 'qrs456' }] })), [['qrs456', 'H296', 'A', 'secondary']]);
		});
		it('a hole filled before (skip: its fill was undone) is not filled again', () => {
			const p = pasted(10, 100, 'qrs456');
			assert.deepEqual(plan(world(p.sigs, [p.hole]), { candidates: [{ signatureID: 'qrs456' }], skip: ['10'] }), []);
		});
		it('a K162 or another known type named A (old data) does not hold the slot', () => {
			const p = pasted(10, 100, 'qrs456');
			const k162 = world(p.sigs.concat([[20, HOME, 'abc123', 'A'], [21, OTHER, null]]), [p.hole, [200, 20, 21, 'U210', 'secondary']]);
			const typed = world(p.sigs.concat([[20, HOME, 'abc123', 'A'], [21, null, null]]), [p.hole, [200, 20, 21, 'U210', 'initial']]);
			// A is taken, so the new static is named like any other hole
			assert.deepEqual(brief(plan(k162, { candidates: [{ signatureID: 'qrs456' }] })), [['qrs456', 'H296', 'B', 'initial']]);
			assert.deepEqual(brief(plan(typed, { candidates: [{ signatureID: 'qrs456' }] })), [['qrs456', 'H296', 'B', 'initial']]);
		});
		it('a candidate whose far side is not in the list is skipped', () => {
			const w = world([[10, HOME, 'qrs456', null]], [[100, 10, 11, null, 'initial']]);
			assert.deepEqual(plan(w, { candidates: [{ signatureID: 'qrs456' }] }), []);
		});
		it('several eligible new holes: the first is picked and the fill says how many there were', () => {
			const a = pasted(10, 100, 'zzz999'), b = pasted(30, 300, 'aaa111');
			const fills = plan(world(a.sigs.concat(b.sigs), [a.hole, b.hole]), { candidates: [{ signatureID: 'zzz999' }, { signatureID: 'aaa111' }] });
			assert.deepEqual(fills.map(f => [f.sig.signatureID, f.among, f.slots]), [['zzz999', 2, 1]]);
			assert.equal(rageRolling.message(fills[0]), 'Rage rolling: ZZZ-999 set as new static H296 (A) (2 new holes: picked the first, check it)');
		});
		it('the same candidate listed twice is used once', () => {
			const a = pasted(10, 100, 'aaa111');
			const w = world(a.sigs, [a.hole]);
			assert.equal(plan(w, { statics: ['B274', 'O477'], candidates: [{ signatureID: 'aaa111' }, { id: 10 }] }).length, 1);
		});
	});

	describe('stale candidates (prune)', () => {
		const now = 1000000;
		it('a hole pasted while the old static was listed is dropped, not filled when the static is deleted later', () => {
			// t=0: old static A listed, our paste adds an unknown hole (an incoming K162 nobody has typed yet)
			const p = pasted(10, 100, 'k16299');
			const before = world(p.sigs.concat([[20, HOME, 'old111', 'A'], [21, null, null]]), [p.hole, [200, 20, 21, 'H296', 'initial']]);
			let candidates = [{ systemID: HOME, signatureID: 'k16299', at: now }];
			assert.deepEqual(plan(before, { candidates }), [], 'slot full');
			candidates = rageRolling.prune(candidates, before.signatures, now + 1500, now + 15000);
			assert.deepEqual(candidates, [], 'dropped at the first check');
			// t=6 min: A deleted (a save with no new holes): nothing to fill
			const after = world(p.sigs, [p.hole]);
			assert.deepEqual(plan(after, { candidates }), []);
		});
		it('the same save that deletes the old static and adds the new hole fills it', () => {
			const p = pasted(10, 100, 'new111');
			const after = world(p.sigs, [p.hole]);	// the list after the paste preview's Apply
			assert.equal(plan(after, { candidates: [{ systemID: HOME, signatureID: 'new111', at: now }] }).length, 1);
		});
		it('a candidate not in the list yet waits for it until pendingUntil', () => {
			const c = [{ systemID: HOME, signatureID: 'zzz000', at: now }];
			assert.equal(rageRolling.prune(c, {}, now + 1500, now + 15000).length, 1);
			assert.equal(rageRolling.prune(c, {}, now + 16000, now + 15000).length, 0);
		});
		it('resolved: by id or signature ID, in its own system', () => {
			const sigs = { 5: { id: 5, systemID: HOME, signatureID: 'abc123' } };
			assert.equal(rageRolling.resolved({ systemID: HOME, signatureID: 'ABC123' }, sigs), true);
			assert.equal(rageRolling.resolved({ systemID: HOME, id: 5 }, sigs), true);
			assert.equal(rageRolling.resolved({ systemID: OTHER, signatureID: 'abc123' }, sigs), false);
		});
	});

	describe('fillPayload', () => {
		it('the Sig dialog\'s update shape: wormhole id/type/parent/life/mass, this side id + name, far side id + class', () => {
			const p = pasted(10, 100, 'qrs456');
			const w = world(p.sigs, [p.hole]);
			const fills = plan(w, { candidates: [{ signatureID: 'qrs456' }] });
			const built = rageRolling.fillPayload(fills, type => (type === 'H296' ? 7 : null));
			assert.deepEqual(built.payload, { signatures: { update: [{
				wormhole: { id: 100, type: 'H296', parent: 'initial', life: 'stable', mass: 'stable' },
				signatures: [{ id: 10, name: 'A' }, { id: 11, systemID: 7 }]
			}] } });
			assert.deepEqual(Object.keys(built.undo), [String(HOME)]);
			assert.deepEqual(built.undo[HOME][0], { wormhole: w.wormholes[100], signatures: [w.signatures[10], w.signatures[11]] });
			assert.notStrictEqual(built.undo[HOME][0].wormhole, w.wormholes[100], 'a copy');
		});
		it('no name when naming is off, no class when unknown', () => {
			const p = pasted(10, 100, 'qrs456');
			const fills = plan(world(p.sigs, [p.hole]), { candidates: [{ signatureID: 'qrs456' }], naming: false });
			assert.deepEqual(rageRolling.fillPayload(fills, () => null).payload.signatures.update[0].signatures, [{ id: 10 }, { id: 11 }]);
		});
	});

	describe('payloadCandidates', () => {
		it('wormhole adds by signature ID in order, wormhole updates by id; sites left out', () => {
			const data = { signatures: {
				add: [{ wormhole: {}, signatures: [{ signatureID: 'AAA111', systemID: HOME }, {}] }, { signatureID: 'SIT111', systemID: HOME, type: 'data' },
					{ wormhole: {}, signatures: [{ signatureID: 'BBB222', systemID: HOME }, {}] }],
				update: [{ wormhole: { id: 5 }, signatures: [{ id: 77, systemID: HOME }, { id: 78 }] }, { id: 9, type: 'data' }]
			} };
			assert.deepEqual(rageRolling.payloadCandidates(data), [
				{ systemID: HOME, signatureID: 'AAA111' }, { systemID: HOME, signatureID: 'BBB222' }, { systemID: HOME, id: 77 }]);
		});
		it('nothing to see', () => {
			assert.deepEqual(rageRolling.payloadCandidates(undefined), []);
			assert.deepEqual(rageRolling.payloadCandidates({ signatures: {} }), []);
		});
	});

	describe('the mode', () => {
		const now = 1800000000000;
		it('off by default', () => assert.equal(rageRolling.isOn({}, now), false));
		it('on', () => assert.equal(rageRolling.isOn({ rageRollingMode: { on: true, since: now - 60000 } }, now), true));
		it('switches itself off after 3 hours', () => assert.equal(rageRolling.isOn({ rageRollingMode: { on: true, since: now - 3 * 3600000 } }, now), false));
		it('off when the feature is turned off in Settings', () =>
			assert.equal(rageRolling.isOn({ rageRolling: { enabled: false }, rageRollingMode: { on: true, since: now } }, now), false));
		it('minutes left', () => {
			assert.equal(rageRolling.minutesLeft({ rageRollingMode: { on: true, since: now } }, now), 180);
			assert.equal(rageRolling.minutesLeft({}, now), 0);
		});
		it('the button: missing = on', () => {
			assert.equal(rageRolling.enabled(undefined), true);
			assert.equal(rageRolling.enabled({ rageRolling: { enabled: false } }), false);
		});
	});

	describe('homeSystems and text', () => {
		it('roots of every chain tab, "0" (all k-space) left out', () =>
			assert.deepEqual(rageRolling.homeSystems([{ systemID: '31001880' }, { systemID: '0' }, { systemID: '30000142,31000005' }, { systemID: 31001880 }]),
				['31001880', '30000142', '31000005']));
		it('no tabs', () => assert.deepEqual(rageRolling.homeSystems(undefined), []));
		it('toast text', () => {
			const fill = { sig: { signatureID: 'qrs456' }, type: 'H296', name: 'A' };
			assert.equal(rageRolling.message(fill), 'Rage rolling: QRS-456 set as new static H296 (A)');
			assert.equal(rageRolling.message(fill, '=A C5 QRS'), 'Rage rolling: QRS-456 set as new static H296 (A). Bookmark: =A C5 QRS');
			assert.equal(rageRolling.message(Object.assign({}, fill, { name: null })), 'Rage rolling: QRS-456 set as new static H296');
		});
	});
});
