const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/hole-naming');
include('app/js/fork/jump-return');

// Home J152820 (31001880) -> "C" -> J135100 (31001881) -> "CA" -> another system (31000005)
const HOME = 31001880, CHILD = 31001881, GRANDCHILD = 31000005, ELSEWHERE = 30000142;

function fixtures(overrides) {
	const signatures = {
		101: { id: 101, systemID: HOME, signatureID: 'abc123', type: 'wormhole', name: 'C' },
		102: { id: 102, systemID: CHILD, signatureID: 'xyz987', type: 'wormhole', name: '' },
		201: { id: 201, systemID: CHILD, signatureID: 'bcd234', type: 'wormhole', name: 'CA' },
		202: { id: 202, systemID: GRANDCHILD, signatureID: 'qqq111', type: 'wormhole', name: null }
	};
	Object.keys(overrides || {}).forEach(id => { signatures[id] = Object.assign({}, signatures[id], overrides[id]); });
	const wormholes = {
		1: { id: 1, initialID: 101, secondaryID: 102, type: 'H296', parent: 'initial' },
		2: { id: 2, initialID: 201, secondaryID: 202, type: 'H296', parent: 'initial' }
	};
	return { signatures, wormholes };
}

describe('Jump return', () => {
	describe('returnString', () => {
		it('Single letter', () => assert.equal(jumpReturn.returnString('A', ''), '<A'));
		it('Deep name with digits', () => assert.equal(jumpReturn.returnString('AB16', undefined), '<AB16'));
		it('Name with suffix text, lower case', () => assert.equal(jumpReturn.returnString('ab1 - frig', null), '<AB1'));
		it('To side already a return bookmark', () => assert.equal(jumpReturn.returnString('AB', '<AB'), '<AB'));
		it('Unnamed from side', () => assert.equal(jumpReturn.returnString('', ''), null));
		it('Missing from side name', () => assert.equal(jumpReturn.returnString(undefined, 'C'), null));
		it('Named only on the to side (jumping toward home)', () => assert.equal(jumpReturn.returnString('', 'AB'), null));
		it('Named on both sides is ambiguous', () => assert.equal(jumpReturn.returnString('C', 'CA'), null));
	});

	describe('findJumpHole', () => {
		it('Outbound through the named hole', () => {
			const f = fixtures();
			const hole = jumpReturn.findJumpHole(HOME, CHILD, f.wormholes, f.signatures);
			assert.equal(hole.wormholeId, 1);
			assert.equal(hole.fromSig.id, 101);
			assert.equal(hole.toSig.id, 102);
		});
		it('Reverse direction swaps the sides', () => {
			const f = fixtures();
			const hole = jumpReturn.findJumpHole(CHILD, HOME, f.wormholes, f.signatures);
			assert.equal(hole.fromSig.id, 102);
			assert.equal(hole.toSig.id, 101);
		});
		it('Reversed initial/secondary', () => {
			const f = fixtures();
			f.wormholes[1] = { id: 1, initialID: 102, secondaryID: 101, type: 'K162', parent: 'secondary' };
			const hole = jumpReturn.findJumpHole(HOME, CHILD, f.wormholes, f.signatures);
			assert.equal(hole.fromSig.id, 101);
			assert.equal(hole.toSig.id, 102);
		});
		it('No connection', () => {
			const f = fixtures();
			assert.equal(jumpReturn.findJumpHole(HOME, ELSEWHERE, f.wormholes, f.signatures), null);
		});
		it('Same system', () => {
			const f = fixtures();
			assert.equal(jumpReturn.findJumpHole(HOME, HOME, f.wormholes, f.signatures), null);
		});
		it('Missing signature is skipped', () => {
			const f = fixtures();
			delete f.signatures[102];
			assert.equal(jumpReturn.findJumpHole(HOME, CHILD, f.wormholes, f.signatures), null);
		});
		it('Prefers a hole whose from side is named', () => {
			const f = fixtures();
			f.signatures[301] = { id: 301, systemID: HOME, name: '' };
			f.signatures[302] = { id: 302, systemID: CHILD, name: '' };
			f.wormholes[0] = { id: 0, initialID: 301, secondaryID: 302 };
			const hole = jumpReturn.findJumpHole(HOME, CHILD, f.wormholes, f.signatures);
			assert.equal(hole.wormholeId, 1);
		});
		it('Lowest id among equally good holes', () => {
			const f = fixtures();
			f.signatures[301] = { id: 301, systemID: HOME, name: '' };
			f.signatures[302] = { id: 302, systemID: CHILD, name: '' };
			f.signatures[101].name = '';
			f.wormholes[7] = { id: 7, initialID: 301, secondaryID: 302 };
			assert.equal(jumpReturn.findJumpHole(HOME, CHILD, f.wormholes, f.signatures).wormholeId, 1);
		});
	});

	describe('forJump', () => {
		it('Home -> child via "C" gives <C', () => {
			const f = fixtures();
			assert.deepEqual(jumpReturn.forJump(HOME, CHILD, f.wormholes, f.signatures), { text: '<C', token: 'C', wormholeId: 1 });
		});
		it('Child -> grandchild via "CA" gives <CA', () => {
			const f = fixtures();
			assert.equal(jumpReturn.forJump(CHILD, GRANDCHILD, f.wormholes, f.signatures).text, '<CA');
		});
		it('Deep hole AB16', () => {
			const f = fixtures({ 101: { name: 'AB16 frig' } });
			assert.equal(jumpReturn.forJump(HOME, CHILD, f.wormholes, f.signatures).text, '<AB16');
		});
		it('Jumping back toward home gives nothing', () => {
			const f = fixtures();
			assert.equal(jumpReturn.forJump(CHILD, HOME, f.wormholes, f.signatures), null);
		});
		it('Back toward home after the return bookmark was named', () => {
			const f = fixtures({ 102: { name: '<C' } });
			assert.equal(jumpReturn.forJump(CHILD, HOME, f.wormholes, f.signatures), null);
		});
		it('Unnamed hole gives nothing', () => {
			const f = fixtures({ 101: { name: '' } });
			assert.equal(jumpReturn.forJump(HOME, CHILD, f.wormholes, f.signatures), null);
		});
		it('No connection gives nothing', () => {
			const f = fixtures();
			assert.equal(jumpReturn.forJump(HOME, GRANDCHILD, f.wormholes, f.signatures), null);
		});
		it('No data yet', () => assert.equal(jumpReturn.forJump(HOME, CHILD, undefined, undefined), null));
	});

	describe('detectJump', () => {
		const prev = { characterID: 1, systemID: HOME };
		it('System change', () => assert.deepEqual(jumpReturn.detectJump(prev, { characterID: 1, systemID: CHILD }), { from: HOME, to: CHILD }));
		it('First call', () => assert.equal(jumpReturn.detectJump(null, { characterID: 1, systemID: CHILD }), null));
		it('Previous call had no system', () => assert.equal(jumpReturn.detectJump({ characterID: undefined, systemID: undefined }, { characterID: 1, systemID: CHILD }), null));
		it('Same system', () => assert.equal(jumpReturn.detectJump(prev, { characterID: 1, systemID: HOME }), null));
		it('Character change call', () => assert.equal(jumpReturn.detectJump(prev, { characterID: 1, systemID: CHILD }, true), null));
		it('Different character', () => assert.equal(jumpReturn.detectJump(prev, { characterID: 2, systemID: CHILD }), null));
		it('Tracking stopped', () => assert.equal(jumpReturn.detectJump(prev, false), null));
		it('String vs number IDs', () => assert.deepEqual(jumpReturn.detectJump(prev, { characterID: '1', systemID: String(CHILD) }), { from: HOME, to: String(CHILD) }));
	});
});
