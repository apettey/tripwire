const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/bookmark-template');
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
		it('Single letter', () => assert.equal(jumpReturn.returnString('A', ''), '!A'));
		it('Deep name with digits', () => assert.equal(jumpReturn.returnString('AB16', undefined), '!AB16'));
		it('Name with suffix text, lower case', () => assert.equal(jumpReturn.returnString('ab1 - frig', null), '!AB1'));
		it('To side already a return bookmark', () => assert.equal(jumpReturn.returnString('AB', '!AB'), '!AB'));
		it('To side an older "<" return bookmark still counts, the new string uses "!"', () => assert.equal(jumpReturn.returnString('AB', '<AB'), '!AB'));
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
		it('Home -> child via "C" gives !C', () => {
			const f = fixtures();
			const r = jumpReturn.forJump(HOME, CHILD, f.wormholes, f.signatures);
			assert.deepEqual({ text: r.text, token: r.token, wormholeId: r.wormholeId }, { text: '!C', token: 'C', wormholeId: 1 });
			assert.equal(r.toSig.id, 102);
			assert.equal(r.fromSig.id, 101);
		});
		it('Child -> grandchild via "CA" gives !CA', () => {
			const f = fixtures();
			assert.equal(jumpReturn.forJump(CHILD, GRANDCHILD, f.wormholes, f.signatures).text, '!CA');
		});
		it('Deep hole AB16', () => {
			const f = fixtures({ 101: { name: 'AB16 frig' } });
			assert.equal(jumpReturn.forJump(HOME, CHILD, f.wormholes, f.signatures).text, '!AB16');
		});
		it('Jumping back toward home gives nothing', () => {
			const f = fixtures();
			assert.equal(jumpReturn.forJump(CHILD, HOME, f.wormholes, f.signatures), null);
		});
		it('Back toward home after the return bookmark was named', () => {
			const f = fixtures({ 102: { name: '!C' } });
			assert.equal(jumpReturn.forJump(CHILD, HOME, f.wormholes, f.signatures), null);
		});
		it('Back toward home after an older "<" return bookmark was named', () => {
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
	describe('alreadyHandled (first pilot through)', () => {
		const ME = ['Test Pilot', 'My Alt'];
		const fresh = { id: 102, systemID: CHILD, signatureID: null, name: null };
		it('Nothing recorded: first through', () => assert.equal(jumpReturn.alreadyHandled(fresh, [], ME, false), null));
		it('Jump log unknown: first through', () => assert.equal(jumpReturn.alreadyHandled(fresh, null, ME, false), null));
		it('Empty strings count as nothing', () => assert.equal(jumpReturn.alreadyHandled({ signatureID: '', name: '  ' }, undefined, ME, false), null));
		it('"???" is not a signature ID', () => assert.equal(jumpReturn.alreadyHandled({ signatureID: '???', name: '' }, [], ME, false), null));
		it('Far side has a signature ID', () => assert.ok(/signature ID/.test(jumpReturn.alreadyHandled({ signatureID: 'xyz987', name: null }, [], ME, false))));
		it('Far side has a partial signature ID', () => assert.ok(jumpReturn.alreadyHandled({ signatureID: 'XYZ', name: null }, [], ME, false)));
		it('Far side named (return bookmark recorded)', () => assert.ok(/named/.test(jumpReturn.alreadyHandled({ signatureID: null, name: '!C' }, [], ME, false))));
		it('Copied before in this browser', () => assert.equal(jumpReturn.alreadyHandled(fresh, [], ME, true), 'already copied'));
		it('Another pilot jumped it', () => assert.equal(jumpReturn.alreadyHandled(fresh, [{ characterName: 'Other Pilot', toID: CHILD }], ME, false), 'already jumped by Other Pilot'));
		it('Another pilot jumped it the other way', () => assert.ok(jumpReturn.alreadyHandled(fresh, [{ characterName: 'Other Pilot', toID: HOME }], ME, false)));
		it('Only my own jumps (this one, back and forth)', () => assert.equal(jumpReturn.alreadyHandled(fresh,
			[{ characterName: 'Test Pilot', toID: CHILD }, { characterName: 'test pilot ', toID: HOME }], ME, false), null));
		it('My other tracked character does not count', () => assert.equal(jumpReturn.alreadyHandled(fresh, [{ characterName: 'My Alt' }], ME, false), null));
		it('Jump without a name is ignored', () => assert.equal(jumpReturn.alreadyHandled(fresh, [{ characterName: null }, {}], ME, false), null));
		it('No names of mine known', () => assert.ok(jumpReturn.alreadyHandled(fresh, [{ characterName: 'Test Pilot' }], undefined, false)));
		it('No far-side signature', () => assert.equal(jumpReturn.alreadyHandled(undefined, [], ME, false), null));
		// Upstream stores tracked names with a visibility suffix (refresh.php): "Name|P", "Name|p", "Name|x"
		it('My own jump with the |P suffix is mine', () => assert.equal(jumpReturn.alreadyHandled(fresh, [{ characterName: 'Test Pilot|P' }], ME, false), null));
		it('|p and |x suffixes too', () => assert.equal(jumpReturn.alreadyHandled(fresh, [{ characterName: 'test pilot|p' }, { characterName: 'My Alt|x' }], ME, false), null));
		it('Another pilot with a suffix', () => assert.equal(jumpReturn.alreadyHandled(fresh, [{ characterName: 'Other|x' }], ME, false), 'already jumped by Other'));
		it('A lone suffix is ignored', () => assert.equal(jumpReturn.alreadyHandled(fresh, [{ characterName: '|P' }], ME, false), null));
		it('My names given with a suffix', () => assert.equal(jumpReturn.alreadyHandled(fresh, [{ characterName: 'Test Pilot|P' }], ['Test Pilot|p'], false), null));

		// Times as the server writes them: PHP date('Y-m-d H:i:s') / MySQL timestamps, UTC
		const T = s => Date.UTC(2026, 9, 10, +s.slice(0, 2), +s.slice(3, 5), +s.slice(6, 8));
		const at = s => '2026-10-10 ' + s;

		describe('the jump that created an automapped hole', () => {
			// Scout jumps an un-entered sig: the automapper creates the hole (sigs' lifeTime 20:13:55) and logs the
			// jump in the same request; the hole is named "C" later.
			const home = { id: 101, systemID: HOME, name: 'C', lifeTime: at('20:13:55'), modifiedTime: at('20:30:00') };
			const me = { names: ME, ids: [1] };
			it('Scout\'s creating jump is ignored', () => assert.equal(jumpReturn.alreadyHandled(fresh,
				[{ characterName: 'Scout|P', time: at('20:13:56') }], me, false, home), null));
			it('A second or two either side', () => assert.equal(jumpReturn.alreadyHandled(fresh,
				[{ characterName: 'Scout|P', time: at('20:13:51') }], me, false, home), null));
			it('The scout\'s later jumps count', () => assert.equal(jumpReturn.alreadyHandled(fresh,
				[{ characterName: 'Scout|P', time: at('20:13:56') }, { characterName: 'Scout|P', time: at('20:20:00') }], me, false, home),
				'already jumped by Scout'));
			it('Another pilot after creation counts', () => assert.ok(jumpReturn.alreadyHandled(fresh,
				[{ characterName: 'Other|P', time: at('20:14:05') }], me, false, home)));
			it('Hole edited (EOL/mass) after the first pilot\'s jump: later pilots still suppressed', () => {
				// Named hole added 20:00, first pilot jumped 20:13:55, marked EOL 20:13:58: upstream bumps both sigs'
				// modifiedTime/modifiedByID, lifeTime stays
				const edited = { id: 101, systemID: HOME, name: 'C', lifeTime: at('20:00:00'), modifiedTime: at('20:13:58'), modifiedByID: 7 };
				const far = { id: 102, systemID: CHILD, signatureID: null, name: null, lifeTime: at('20:00:00'), modifiedTime: at('20:13:58'), modifiedByID: 7 };
				assert.equal(jumpReturn.alreadyHandled(far, [{ characterName: 'First Pilot|P', time: at('20:13:55') }],
					{ names: ['Second Pilot'], ids: [8] }, false, edited, T('20:20:00')), 'already jumped by First Pilot');
			});
			it('No lifeTime on the sig: every jump counts', () => assert.ok(jumpReturn.alreadyHandled(fresh,
				[{ characterName: 'Scout|P', time: at('20:13:56') }], me, false, { name: 'C' })));
			it('No time on the jump: counts', () => assert.ok(jumpReturn.alreadyHandled(fresh, [{ characterName: 'Scout|P' }], me, false, home)));
			it('parseTime', () => {
				assert.equal(jumpReturn.parseTime('2026-10-10 20:13:55'), T('20:13:55'));
				assert.equal(jumpReturn.parseTime('2026-10-10T20:13:55Z'), T('20:13:55'));
				assert.ok(isNaN(jumpReturn.parseTime('soon')));
				assert.ok(isNaN(jumpReturn.parseTime(null)));
			});
		});

		describe('far side edited by one of my characters', () => {
			const me = { names: ME, ids: [1, 196379789] };
			const jumpAt = T('20:15:00');
			const far = (by, when) => ({ signatureID: 'xyz987', name: '!C', modifiedByID: by, modifiedTime: at(when) });
			it('I set the return sig right after my jump: not suppressed', () => assert.equal(jumpReturn.alreadyHandled(
				far(196379789, '20:15:08'), [], me, false, undefined, jumpAt), null));
			it('Within the polling slack before the jump seen', () => assert.equal(jumpReturn.alreadyHandled(
				far(196379789, '20:14:50'), [], me, false, undefined, jumpAt), null));
			it('My edit 30 s before the jump was seen (from home) still suppresses', () => assert.ok(jumpReturn.alreadyHandled(
				far(196379789, '20:14:30'), [], me, false, undefined, jumpAt)));
			it('ID as a string', () => assert.equal(jumpReturn.alreadyHandled(
				far('196379789', '20:15:08'), [], me, false, undefined, jumpAt), null));
			it('My edit well before this jump (e.g. EOL from home) still suppresses', () => assert.ok(jumpReturn.alreadyHandled(
				far(196379789, '20:05:00'), [], me, false, undefined, jumpAt)));
			it('Jump time unknown: suppresses', () => assert.ok(jumpReturn.alreadyHandled(
				far(196379789, '20:15:08'), [], me, false, undefined, undefined)));
			it('Someone else\'s edit suppresses', () => assert.ok(jumpReturn.alreadyHandled(
				far(555, '20:15:08'), [], me, false, undefined, jumpAt)));
			it('Copied before still suppresses', () => assert.equal(jumpReturn.alreadyHandled(
				far(1, '20:15:08'), [], me, true, undefined, jumpAt), 'already copied'));
			it('Other pilots in the log still suppress', () => assert.ok(jumpReturn.alreadyHandled(
				far(1, '20:15:08'), [{ characterName: 'Other|P', time: at('20:10:00') }], me, false, undefined, jumpAt)));
			it('No IDs known (array of names): suppresses', () => assert.ok(jumpReturn.alreadyHandled(
				far(1, '20:15:08'), [], ME, false, undefined, jumpAt)));
		});
	});

	describe('settings', () => {
		it('Missing options: on, first only', () => {
			assert.equal(jumpReturn.enabled(undefined), true);
			assert.equal(jumpReturn.firstOnly({}), true);
			assert.equal(jumpReturn.modeFor({ jumpReturn: {} }), 'first');
		});
		it('Off', () => {
			assert.equal(jumpReturn.enabled({ jumpReturn: { enabled: false } }), false);
			assert.equal(jumpReturn.modeFor({ jumpReturn: { enabled: false } }), 'off');
		});
		it('Every jump', () => assert.equal(jumpReturn.modeFor({ jumpReturn: { enabled: true, firstOnly: false } }), 'always'));
		it('Round trip', () => ['first', 'always', 'off'].forEach(m => assert.equal(jumpReturn.modeFor({ jumpReturn: jumpReturn.optionsForMode(m) }), m)));
		it('Unknown mode means the default', () => assert.deepEqual(jumpReturn.optionsForMode('x'), { enabled: true, firstOnly: true }));
	});
});
