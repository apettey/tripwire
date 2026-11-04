const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/jump-sig-prompt');
include('app/js/fork/return-sig-paste');

const AU = 149597870.7;
// The user's own paste (German-style separators): came in via TWD-137, then warped to DPF-143
const USER_PASTE = [
	'ZJP-752\tCosmic Signature\tGas Site\tOrdinary Perimeter Reservoir\t0,0%\t7,28 AU',
	'XUO-758\tCosmic Signature\tRelic Site\t\t36,3%\t2,69 AU',
	'TWD-137\tCosmic Signature\tWormhole\tUnstable Wormhole\t100,0%\t11,46 AU',
	'LNU-190\tCosmic Signature\tGas Site\t\t0,0%\t8,08 AU',
	'FYH-626\tCosmic Signature\tWormhole\tUnstable Wormhole\t100,0%\t9,60 AU',
	'DYH-327\tCosmic Signature\t\t\t0,0%\t16,77 AU',
	'DPF-143\tCosmic Signature\tWormhole\tUnstable Wormhole\t100,0%\t2.566 m',
	'BSK-682\tCosmic Signature\tWormhole\tUnstable Wormhole\t100,0%\t11,87 AU'
].join('\n');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), a + ' != ' + b);

describe('returnSigPaste', () => {
	describe('enabled (opt-in)', () => {
		it('is off unless enabled is true', () => {
			assert.strictEqual(returnSigPaste.enabled(undefined), false);
			assert.strictEqual(returnSigPaste.enabled({}), false);
			assert.strictEqual(returnSigPaste.enabled({ returnSigPaste: {} }), false);
			assert.strictEqual(returnSigPaste.enabled({ returnSigPaste: { enabled: false } }), false);
			assert.strictEqual(returnSigPaste.enabled({ returnSigPaste: { enabled: true } }), true);
		});
	});

	describe('parseDistanceKm', () => {
		it('metres and kilometres, thousands vs decimal separators', () => {
			near(returnSigPaste.parseDistanceKm('2.566 m'), 2.566);
			near(returnSigPaste.parseDistanceKm('2,566 m'), 2.566);
			near(returnSigPaste.parseDistanceKm('1,5 km'), 1.5);
			near(returnSigPaste.parseDistanceKm('1.5 km'), 1.5);
			near(returnSigPaste.parseDistanceKm('12 345 km'), 12345);
			near(returnSigPaste.parseDistanceKm('12 345 km'), 12345);
			near(returnSigPaste.parseDistanceKm('12 345 km'), 12345);
			near(returnSigPaste.parseDistanceKm('1.234,5 km'), 1234.5);
			near(returnSigPaste.parseDistanceKm('1,234.5 km'), 1234.5);
			near(returnSigPaste.parseDistanceKm('850 m'), 0.85);
			near(returnSigPaste.parseDistanceKm('99 km'), 99);
			near(returnSigPaste.parseDistanceKm('99km'), 99);
			near(returnSigPaste.parseDistanceKm('1,234,567 m'), 1234.567);
		});

		it('AU in every language, the last separator is the decimal point', () => {
			near(returnSigPaste.parseDistanceKm('7,28 AU'), 7.28 * AU);
			near(returnSigPaste.parseDistanceKm('7.28 AU'), 7.28 * AU);
			near(returnSigPaste.parseDistanceKm('11,46 UA'), 11.46 * AU);
			near(returnSigPaste.parseDistanceKm('2,69 AE'), 2.69 * AU);
			near(returnSigPaste.parseDistanceKm('3,5 а.е.'), 3.5 * AU);
			near(returnSigPaste.parseDistanceKm('1,234 AU'), 1.234 * AU);
			near(returnSigPaste.parseDistanceKm('12 au'), 12 * AU);
		});

		it('Russian m / km', () => {
			near(returnSigPaste.parseDistanceKm('2 566 м'), 2.566);
			near(returnSigPaste.parseDistanceKm('1,5 км'), 1.5);
			near(returnSigPaste.parseDistanceKm('45 КМ'), 45);
		});

		it('garbage is null', () => {
			['', '   ', 'km', '100,0%', 'Wormhole', 'abc m', '1..2 km', '1,5,2 km', '2 566', 'DPF-143', '1,2.345 km', null, undefined]
				.forEach(t => assert.strictEqual(returnSigPaste.parseDistanceKm(t), null, String(t)));
		});
	});

	describe('parseRow', () => {
		it('reads id, type and distance', () => {
			const rows = USER_PASTE.split('\n');
			const dpf = returnSigPaste.parseRow(rows[6]);
			assert.strictEqual(dpf.id, 'DPF143');
			assert.strictEqual(dpf.type, 'Wormhole');
			near(dpf.km, 2.566);
			const zjp = returnSigPaste.parseRow(rows[0]);
			assert.strictEqual(zjp.id, 'ZJP752');
			assert.strictEqual(zjp.type, '');
			near(zjp.km, 7.28 * AU);
			assert.strictEqual(returnSigPaste.parseRow(rows[5]).type, '');
		});

		it('wormhole type words in every language', () => {
			['Wormhole', 'Trou de ver', 'Wurmloch', 'ワームホール', '웜홀', 'Червоточина'].forEach(w =>
				assert.strictEqual(returnSigPaste.parseRow('ABC-123\tX\t' + w + '\t\t100,0%\t5 km').type, 'Wormhole', w));
		});

		it('no ID: null; no distance column: km null', () => {
			assert.strictEqual(returnSigPaste.parseRow('foo\tbar'), null);
			assert.strictEqual(returnSigPaste.parseRow(''), null);
			assert.strictEqual(returnSigPaste.parseRow('ABC-123\tCosmic Signature\tWormhole').km, null);
		});
	});

	describe('candidate', () => {
		it('the user\'s paste: DPF-143 when it is new', () => {
			const c = returnSigPaste.candidate(USER_PASTE, ['ZJP752', 'XUO758', 'TWD137'], 100);
			assert.strictEqual(c.id, 'DPF143');
		});

		it('the user\'s paste: nothing when DPF-143 is already in the system (any case, with a dash)', () => {
			assert.strictEqual(returnSigPaste.candidate(USER_PASTE, ['dpf143'], 100), null);
			assert.strictEqual(returnSigPaste.candidate(USER_PASTE, ['DPF-143'], 100), null);
		});

		it('accepts an array of rows and the default range', () => {
			assert.strictEqual(returnSigPaste.candidate(USER_PASTE.split('\n'), []).id, 'DPF143');
		});

		it('two new wormholes in range: null', () => {
			const paste = USER_PASTE + '\nQQQ-111\tCosmic Signature\tWormhole\t\t100,0%\t45 km';
			assert.strictEqual(returnSigPaste.candidate(paste, [], 100), null);
			assert.strictEqual(returnSigPaste.candidate(paste, ['QQQ111'], 100).id, 'DPF143', 'the other one is known');
		});

		it('a near row without a type does not count', () => {
			const paste = 'AAA-111\tCosmic Signature\t\t\t0,0%\t12 km\nBBB-222\tCosmic Signature\tWormhole\t\t100,0%\t3 AU';
			assert.strictEqual(returnSigPaste.candidate(paste, [], 100), null);
			const both = paste + '\nCCC-333\tCosmic Signature\tWormhole\t\t100,0%\t80 km';
			assert.strictEqual(returnSigPaste.candidate(both, [], 100).id, 'CCC333');
		});

		it('a non-wormhole near row does not count; beyond range does not count; exactly 100 km does', () => {
			assert.strictEqual(returnSigPaste.candidate('AAA-111\tCosmic Signature\tGas Site\t\t100,0%\t5 km', [], 100), null);
			assert.strictEqual(returnSigPaste.candidate('AAA-111\tCosmic Signature\tWormhole\t\t100,0%\t101 km', [], 100), null);
			assert.strictEqual(returnSigPaste.candidate('AAA-111\tCosmic Signature\tWormhole\t\t100,0%\t100 km', [], 100).id, 'AAA111');
		});

		it('empty and junk pastes: null', () => {
			assert.strictEqual(returnSigPaste.candidate('', [], 100), null);
			assert.strictEqual(returnSigPaste.candidate(undefined, undefined, 100), null);
		});
	});

	describe('isRecent', () => {
		const jump = { from: 31000001, to: 31000002, at: 1000000 };
		it('a jump into the viewed system in the last 10 minutes, still there', () => {
			assert.strictEqual(returnSigPaste.isRecent(jump, 1000000 + 60000, 31000002, 31000002), true);
			assert.strictEqual(returnSigPaste.isRecent(jump, 1000000 + 600000, 31000002, 31000002), true);
		});
		it('an old jump', () => {
			assert.strictEqual(returnSigPaste.isRecent(jump, 1000000 + 600001, 31000002, 31000002), false);
		});
		it('viewing another system', () => {
			assert.strictEqual(returnSigPaste.isRecent(jump, 1000000 + 1000, 31000001, 31000002), false);
		});
		it('the character left the system', () => {
			assert.strictEqual(returnSigPaste.isRecent(jump, 1000000 + 1000, 31000002, 31000003), false);
			assert.strictEqual(returnSigPaste.isRecent(jump, 1000000 + 1000, 31000002, null), false);
		});
		it('no jump', () => {
			assert.strictEqual(returnSigPaste.isRecent(null, 1000, 31000002, 31000002), false);
		});
		it('a clock going backwards is not recent', () => {
			assert.strictEqual(returnSigPaste.isRecent(jump, 1000000 - 5, 31000002, 31000002), false);
		});
	});

	describe('mergeTarget', () => {
		const FROM = 31000001, TO = 31000002;
		const jump = { from: FROM, to: TO, at: 1 };
		const sig = (id, systemID, signatureID) => ({ id: id, systemID: systemID, signatureID: signatureID, type: 'wormhole' });

		it('no hole between the systems: null', () => {
			assert.strictEqual(returnSigPaste.mergeTarget(jump, {}, {}), null);
			assert.strictEqual(returnSigPaste.mergeTarget(jump, undefined, undefined), null);
		});

		it('one hole, its side here has no ID: that hole (either orientation)', () => {
			const sigs = { 1: sig(1, FROM, 'abc123'), 2: sig(2, TO, null) };
			let t = returnSigPaste.mergeTarget(jump, { 7: { id: 7, initialID: 1, secondaryID: 2 } }, sigs);
			assert.strictEqual(t.wormhole.id, 7);
			assert.strictEqual(t.toSig.id, 2);
			assert.strictEqual(t.fromSig.id, 1);
			t = returnSigPaste.mergeTarget(jump, { 7: { id: 7, initialID: 2, secondaryID: 1 } }, sigs);
			assert.strictEqual(t.toSig.id, 2);
			assert.strictEqual(t.fromSig.id, 1);
		});

		it('a bare automapper hole ("???" / empty on both sides) counts', () => {
			const sigs = { 1: sig(1, FROM, ''), 2: sig(2, TO, '???') };
			assert.strictEqual(returnSigPaste.mergeTarget(jump, { 7: { id: 7, initialID: 1, secondaryID: 2 } }, sigs).toSig.id, 2);
		});

		it('the side here already has an ID: null', () => {
			const sigs = { 1: sig(1, FROM, null), 2: sig(2, TO, 'TWD137') };
			assert.strictEqual(returnSigPaste.mergeTarget(jump, { 7: { id: 7, initialID: 1, secondaryID: 2 } }, sigs), null);
		});

		it('two holes without an ID here: null; one of two without: that one', () => {
			const sigs = { 1: sig(1, FROM, null), 2: sig(2, TO, null), 3: sig(3, TO, null), 4: sig(4, FROM, null) };
			const holes = { 7: { id: 7, initialID: 1, secondaryID: 2 }, 8: { id: 8, initialID: 3, secondaryID: 4 } };
			assert.strictEqual(returnSigPaste.mergeTarget(jump, holes, sigs), null);
			sigs[3].signatureID = 'FYH626';
			assert.strictEqual(returnSigPaste.mergeTarget(jump, holes, sigs).wormhole.id, 7);
		});

		it('a hole to another system does not count', () => {
			const sigs = { 1: sig(1, 31000009, null), 2: sig(2, TO, null) };
			assert.strictEqual(returnSigPaste.mergeTarget(jump, { 7: { id: 7, initialID: 1, secondaryID: 2 } }, sigs), null);
		});
	});

	describe('rewrite', () => {
		const pastePayload = () => ({ systemID: 31000002, signatures: {
			add: [
				{ signatureID: 'ZJP752', systemID: 31000002, type: 'Gas' },
				{ wormhole: { type: null, parent: 'initial', life: 'stable', mass: 'stable' }, signatures: [
					{ signatureID: 'DPF143', systemID: 31000002, type: 'wormhole', lifeLength: 86400 },
					{ signatureID: null, systemID: null, type: 'wormhole', lifeLength: 86400 }] }
			], update: [] } });
		const jump = { from: 31000001, to: 31000002, at: 1 };

		it('linked: the add stays, its far side is the system you came from', () => {
			const p = pastePayload();
			const r = returnSigPaste.rewrite(p, 'DPF143', jump, null);
			assert.strictEqual(r.mode, 'linked');
			assert.strictEqual(r.undo, null);
			assert.strictEqual(p.signatures.add.length, 2);
			assert.strictEqual(p.signatures.add[1].signatures[1].systemID, 31000001);
			assert.strictEqual(p.signatures.add[1].signatures[0].systemID, 31000002);
		});

		it('merged: the add goes, an update puts the ID on the hole\'s side here, with an undo item', () => {
			const p = pastePayload();
			const merge = { wormhole: { id: 7, type: 'H296', life: 'stable', mass: 'stable', initialID: 1, secondaryID: 2 },
				fromSig: { id: 1, systemID: 31000001, signatureID: 'abc123', name: 'A' }, toSig: { id: 2, systemID: 31000002, signatureID: null, name: '' } };
			const r = returnSigPaste.rewrite(p, 'DPF143', jump, merge);
			assert.strictEqual(r.mode, 'merged');
			assert.strictEqual(p.signatures.add.length, 1);
			assert.strictEqual(p.signatures.add[0].signatureID, 'ZJP752');
			assert.deepStrictEqual(p.signatures.update, [{ wormhole: { id: 7 }, signatures: [{ id: 2, signatureID: 'DPF143' }] }]);
			assert.deepStrictEqual(r.undo, { wormhole: merge.wormhole, signatures: [merge.toSig, merge.fromSig] });
			assert.notStrictEqual(r.undo.wormhole, merge.wormhole, 'a copy: later syncs do not change the undo');
		});

		it('no add for that ID: null and nothing changed', () => {
			const p = pastePayload();
			assert.strictEqual(returnSigPaste.rewrite(p, 'QQQ111', jump, null), null);
			assert.strictEqual(p.signatures.add[1].signatures[1].systemID, null);
			assert.strictEqual(returnSigPaste.rewrite({}, 'DPF143', jump, null), null);
		});
	});

	it('idText', () => {
		assert.strictEqual(returnSigPaste.idText('DPF143'), 'DPF-143');
		assert.strictEqual(returnSigPaste.idText(''), '');
	});
});
