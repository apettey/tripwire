const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/systemAnalysis');
include('public/js/combine');
include('app/js/tripwire/genericSystemTypes');
include('app/js/fork/automapper-rejump');

// Sample well known systems; generic Leads To are indexes into appData.genericSystemTypes
const C1 = 31000083, C2 = 31000537, C3 = 31001053, C4 = 31001477, C5 = 31001916, HS = 30000001, LS = 30000162;
const G_C2 = 4, G_C3 = 5, G_UNKNOWN = 11, G_DANGEROUS = 13, G_HS = 2;

// Jumped from FROM into TO; the wormhole in each case is 10 with signatures 11 (initial) and 12 (secondary)
function holes(wormholeProps, initialSystem, secondarySystem) {
	return {
		wormholes: { 10: Object.assign({ id: 10, initialID: 11, secondaryID: 12 }, wormholeProps) },
		signatures: { 11: { id: 11, systemID: initialSystem }, 12: { id: 12, systemID: secondarySystem } }
	};
}
function find(from, to, h) { return automapperRejump.holesIntoDestination(from, to, h.wormholes, h.signatures); }

describe('automapperRejump.holesIntoDestination', () => {
	it('K162 scanned in the destination with Leads To unset', () => {
		const h = holes({ type: 'K162', parent: 'initial' }, C3, null);
		assert.deepEqual(find(C2, C3, h).map(c => [c.wormhole.id, c.dest, c.other]), [[10, 11, 12]]);
	});
	it('works with the signature order swapped (destination sig is the secondary)', () => {
		const h = holes({}, null, C3);
		assert.deepEqual(find(C2, C3, h).map(c => [c.wormhole.id, c.dest, c.other]), [[10, 12, 11]]);
	});
	it('generic Leads To naming the origin class', () => {
		assert.equal(find(C2, C3, holes({}, C3, G_C2)).length, 1);
	});
	it('generic Leads To that lists the origin class (Unknown = C2/C3, Dangerous = C4/C5)', () => {
		assert.equal(find(C2, C3, holes({}, C3, G_UNKNOWN)).length, 1);
		assert.equal(find(C5, C3, holes({}, C3, G_DANGEROUS)).length, 1);
	});
	it('generic Leads To for k-space matches a k-space origin', () => {
		assert.equal(find(HS, C3, holes({}, C3, G_HS)).length, 1);
	});
	it('class mismatch is not a candidate', () => {
		assert.equal(find(C2, C3, holes({}, C3, G_C3)).length, 0);
		assert.equal(find(C1, C3, holes({}, C3, G_DANGEROUS)).length, 0);
		assert.equal(find(LS, C3, holes({}, C3, G_HS)).length, 0);
	});
	it('linked to another real system is not a candidate', () => {
		assert.equal(find(C2, C3, holes({}, C3, C4)).length, 0);
	});
	it('Leads To exactly the origin system is a candidate and exact', () => {
		const c = find(C2, C3, holes({}, C3, C2));
		assert.equal(c.length, 1);
		assert.equal(c[0].exact, true);
	});
	it('exact: only a known hole type on the destination side that leads to the origin class', () => {
		assert.equal(find(C2, C3, holes({ type: 'N766', parent: 'initial' }, C3, null))[0].exact, true);
		// the type is on the far side: nothing certain about the origin
		assert.equal(find(C1, C2, holes({ type: 'N766', parent: 'initial' }, null, C2))[0].exact, false);
	});
	it('not exact: K162, no type, unset or generic Leads To', () => {
		assert.equal(find(C2, C3, holes({ type: 'K162', parent: 'initial' }, C3, null))[0].exact, false);
		assert.equal(find(C2, C3, holes({}, C3, null))[0].exact, false);
		assert.equal(find(C2, C3, holes({}, C3, G_C2))[0].exact, false);
		assert.equal(find(C2, C3, holes({}, C3, G_UNKNOWN))[0].exact, false);
	});
	it('a hole entirely elsewhere is not a candidate', () => {
		assert.equal(find(C2, C3, holes({}, C4, null)).length, 0);
		assert.equal(find(C2, C3, holes({}, null, C4)).length, 0);
	});
	it('both ends already in the destination is not a candidate', () => {
		assert.equal(find(C2, C3, holes({}, C3, C3)).length, 0);
	});
	it('known type that leads somewhere else is rejected; K162 and no type fit', () => {
		// N766 is a static into a class 2; destination C3 side holds the real type (initial) so it must lead to the origin class
		const n766 = holes({ type: 'N766', parent: 'initial' }, C3, null);
		assert.equal(find(C2, C3, n766).length, 1);	// origin is C2
		assert.equal(find(C4, C3, n766).length, 0);	// origin is C4
		assert.equal(find(C4, C3, holes({ type: 'K162', parent: 'initial' }, C3, null)).length, 1);
		assert.equal(find(C4, C3, holes({}, C3, null)).length, 1);
	});
	it('the real-type side being the far side must lead to the destination class', () => {
		// parent initial = the unset side (11) carries N766, so it leads to a C2; destination C3 is not a C2
		const h = holes({ type: 'N766', parent: 'initial' }, null, C3);
		assert.equal(find(C1, C3, h).length, 0);
		assert.equal(find(C1, C2, holes({ type: 'N766', parent: 'initial' }, null, C2)).length, 1);
	});
	it('several candidates come back ordered by wormhole id', () => {
		const wormholes = { 30: { id: 30, initialID: 31, secondaryID: 32 }, 10: { id: 10, initialID: 11, secondaryID: 12 }, 20: { id: 20, initialID: 21, secondaryID: 22 } };
		const signatures = {
			11: { id: 11, systemID: C3 }, 12: { id: 12, systemID: null },
			21: { id: 21, systemID: C3 }, 22: { id: 22, systemID: G_C2 },
			31: { id: 31, systemID: C3 }, 32: { id: 32, systemID: C4 }	// linked elsewhere
		};
		assert.deepEqual(automapperRejump.holesIntoDestination(C2, C3, wormholes, signatures).map(c => c.wormhole.id), [10, 20]);
	});
	it('missing signatures and empty input are ignored', () => {
		assert.deepEqual(automapperRejump.holesIntoDestination(C2, C3, {}, {}), []);
		assert.deepEqual(automapperRejump.holesIntoDestination(C2, C3, { 10: { id: 10, initialID: 11, secondaryID: 12 } }, { 11: { id: 11, systemID: C3 } }), []);
	});
});

describe('automapperRejump.newHole / jumpEnds', () => {
	it('new hole payload joins the two systems', () => {
		const h = automapperRejump.newHole(C2, C3);
		assert.deepEqual(h.signatures, [{ systemID: C2, type: 'wormhole' }, { systemID: C3, type: 'wormhole' }]);
		assert.equal(h.wormhole.type, null);
		assert.equal(h.wormhole.parent, 'initial');
	});
	it('jump ends come from the payload, else the signature systems', () => {
		assert.deepEqual(automapperRejump.jumpEnds({ from: '5', to: '6' }, 1, 2), { from: 5, to: 6 });
		assert.deepEqual(automapperRejump.jumpEnds({}, 1, 2), { from: 1, to: 2 });
		assert.deepEqual(automapperRejump.jumpEnds(undefined, 1, 2), { from: 1, to: 2 });
	});
});

describe('automapperRejump.linkSignatures', () => {
	const sigs = { 11: { id: 11, systemID: C3 }, 12: { id: 12, systemID: null } };
	it('normal match sets the secondary side to the destination', () => {
		assert.deepEqual(automapperRejump.linkSignatures({ initialID: 11, secondaryID: 12 }, sigs, C2, C3, false), [{ id: 11 }, { id: 12, systemID: C3 }]);
	});
	it('re-jump sets the unset side to the origin (secondary unset)', () => {
		assert.deepEqual(automapperRejump.linkSignatures({ initialID: 11, secondaryID: 12 }, sigs, C2, C3, true), [{ id: 11 }, { id: 12, systemID: C2 }]);
	});
	it('re-jump sets the unset side to the origin (initial unset)', () => {
		const swapped = { 11: { id: 11, systemID: null }, 12: { id: 12, systemID: C3 } };
		assert.deepEqual(automapperRejump.linkSignatures({ initialID: 11, secondaryID: 12 }, swapped, C2, C3, true), [{ id: 11, systemID: C2 }, { id: 12 }]);
	});
});

describe('automapperRejump.pickerSignature', () => {
	const wh = { initialID: 11, secondaryID: 12 };
	it('shows the initial signature for a normal match', () => {
		assert.equal(automapperRejump.pickerSignature(wh, { 11: { id: 11, systemID: C2 }, 12: { id: 12, systemID: null } }, C3, false).id, 11);
	});
	it('shows the signature in the destination for a re-jump', () => {
		assert.equal(automapperRejump.pickerSignature(wh, { 11: { id: 11, systemID: null }, 12: { id: 12, systemID: C3 } }, C3, true).id, 12);
		assert.equal(automapperRejump.pickerSignature(wh, { 11: { id: 11, systemID: C3 }, 12: { id: 12, systemID: null } }, C3, true).id, 11);
	});
});
