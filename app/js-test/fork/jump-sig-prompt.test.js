const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/bookmark-template');
include('app/js/fork/hole-naming');
include('app/js/fork/jump-sig-prompt');

const FROM = 31001880, TO = 31001881, ELSEWHERE = 31000005;

// A jump FROM -> TO. Wormhole 1 is the bare hole the automapper made. Wormhole 2: a scanned sig in FROM that does not lead anywhere yet.
// Wormhole 3: a scanned K162 in TO whose far side is unset. Wormhole 4: a hole from FROM to somewhere else (already linked).
function fixtures(overrides) {
	const signatures = {
		11: { id: 11, systemID: FROM, signatureID: '', type: 'wormhole', name: '' },
		12: { id: 12, systemID: TO, signatureID: '', type: 'wormhole', name: '' },
		21: { id: 21, systemID: FROM, signatureID: 'abc123', type: 'wormhole', name: 'A' },
		22: { id: 22, systemID: null, signatureID: '', type: 'wormhole', name: '' },
		31: { id: 31, systemID: TO, signatureID: 'xyz987', type: 'wormhole', name: '' },
		32: { id: 32, systemID: null, signatureID: '', type: 'wormhole', name: '' },
		41: { id: 41, systemID: FROM, signatureID: 'ddd444', type: 'wormhole', name: 'B' },
		42: { id: 42, systemID: ELSEWHERE, signatureID: '', type: 'wormhole', name: '' },
		51: { id: 51, systemID: FROM, signatureID: 'ggg555', type: 'gas', name: '' }
	};
	Object.keys(overrides || {}).forEach(id => { signatures[id] = Object.assign({}, signatures[id], overrides[id]); });
	const wormholes = {
		1: { id: 1, initialID: 11, secondaryID: 12, type: null, parent: 'initial', life: 'stable', mass: 'stable' },
		2: { id: 2, initialID: 21, secondaryID: 22, type: 'H296', parent: 'initial', life: 'stable', mass: 'stable' },
		3: { id: 3, initialID: 32, secondaryID: 31, type: 'K162', parent: 'initial', life: 'critical', mass: 'stable' },
		4: { id: 4, initialID: 41, secondaryID: 42, type: 'C247', parent: 'initial', life: 'stable', mass: 'stable' }
	};
	return { signatures, wormholes };
}

describe('Jump signature prompt', () => {
	describe('settings', () => {
		it('Mask mode defaults to "only when no signature matches"', () => assert.equal(jumpSigPrompt.mode(undefined), 'nomatch'));
		it('Mask mode: known values', () => assert.deepEqual(['off', 'nomatch', 'always'].map(jumpSigPrompt.mode), ['off', 'nomatch', 'always']));
		it('Mask mode: unknown values fall back to the default', () => assert.deepEqual(['x', null, 5, ''].map(jumpSigPrompt.mode), ['nomatch', 'nomatch', 'nomatch', 'nomatch']));
		it('The server mode list and the admin select agree', () => assert.deepEqual(bookmarkTemplate.JUMP_PROMPTS.map(m => m.value).sort(), jumpSigPrompt.MODES.slice().sort()));
		it('Bookmark module normalises the mode too', () => assert.deepEqual([undefined, 'always', 'bogus', 'off'].map(bookmarkTemplate.jumpPromptMode), ['nomatch', 'always', 'nomatch', 'off']));
		it('User toggle: missing = on', () => assert.equal(jumpSigPrompt.userEnabled({}), true));
		it('User toggle: off', () => assert.equal(jumpSigPrompt.userEnabled({ jumpSigPrompt: { enabled: false } }), false));
		it('User toggle: on', () => assert.equal(jumpSigPrompt.userEnabled({ jumpSigPrompt: { enabled: true } }), true));
		it('Active needs both the mask and the user', () => {
			assert.equal(jumpSigPrompt.active('nomatch', {}), true);
			assert.equal(jumpSigPrompt.active('always', undefined), true);
			assert.equal(jumpSigPrompt.active('off', {}), false);
			assert.equal(jumpSigPrompt.active('nomatch', { jumpSigPrompt: { enabled: false } }), false);
		});
	});

	describe('which hole to ask about', () => {
		it('A bare hole in the default mode', () => {
			const f = fixtures();
			const hole = jumpSigPrompt.holeToAsk('nomatch', FROM, TO, f.wormholes, f.signatures);
			assert.equal(hole.wormhole.id, 1);
			assert.deepEqual([hole.fromSig.id, hole.toSig.id], [11, 12]);
		});
		it('Either orientation of the hole', () => {
			const f = fixtures();
			f.wormholes[1] = { id: 1, initialID: 12, secondaryID: 11, type: null, parent: 'initial' };
			const hole = jumpSigPrompt.holeToAsk('nomatch', FROM, TO, f.wormholes, f.signatures);
			assert.deepEqual([hole.fromSig.id, hole.toSig.id], [11, 12]);
		});
		it('Off never asks', () => {
			const f = fixtures();
			assert.equal(jumpSigPrompt.holeToAsk('off', FROM, TO, f.wormholes, f.signatures), null);
		});
		it('No hole between the systems: nothing to ask', () => {
			const f = fixtures();
			delete f.wormholes[1];
			assert.equal(jumpSigPrompt.holeToAsk('always', FROM, TO, f.wormholes, f.signatures), null);
		});
		it('A hole that has a signature ID on the side you left is tied: no prompt', () => {
			const f = fixtures({ 11: { signatureID: 'qqq111' } });
			assert.equal(jumpSigPrompt.holeToAsk('nomatch', FROM, TO, f.wormholes, f.signatures), null);
			assert.equal(jumpSigPrompt.holeToAsk('always', FROM, TO, f.wormholes, f.signatures), null);
		});
		it('A hole with a signature ID on the arrival side is tied too', () => {
			const f = fixtures({ 12: { signatureID: 'qqq111' } });
			assert.equal(jumpSigPrompt.holeToAsk('always', FROM, TO, f.wormholes, f.signatures), null);
		});
		it('A named hole: not in the default mode, yes in "always" while it has no ID', () => {
			const f = fixtures({ 11: { name: 'AB' } });
			assert.equal(jumpSigPrompt.holeToAsk('nomatch', FROM, TO, f.wormholes, f.signatures), null);
			assert.equal(jumpSigPrompt.holeToAsk('always', FROM, TO, f.wormholes, f.signatures).wormhole.id, 1);
		});
		it('A hole with a type was filled in by someone: never replaced', () => {
			const f = fixtures();
			f.wormholes[1].type = 'H296';
			assert.equal(jumpSigPrompt.holeToAsk('nomatch', FROM, TO, f.wormholes, f.signatures), null);
			assert.equal(jumpSigPrompt.holeToAsk('always', FROM, TO, f.wormholes, f.signatures), null);
		});
		it('A signature ID with fewer than three letters still counts as not scanned', () => {
			const f = fixtures({ 11: { signatureID: '??' } });
			assert.equal(jumpSigPrompt.holeToAsk('nomatch', FROM, TO, f.wormholes, f.signatures).wormhole.id, 1);
		});
		it('Other holes are not the jump: an unrelated bare hole', () => {
			const f = fixtures();
			delete f.wormholes[1];
			f.signatures[61] = { id: 61, systemID: FROM, signatureID: '', type: 'wormhole', name: '' };
			f.signatures[62] = { id: 62, systemID: ELSEWHERE, signatureID: '', type: 'wormhole', name: '' };
			f.wormholes[6] = { id: 6, initialID: 61, secondaryID: 62, type: null, parent: 'initial' };
			assert.equal(jumpSigPrompt.holeToAsk('nomatch', FROM, TO, f.wormholes, f.signatures), null);
		});
	});

	describe('candidates', () => {
		it('Lists the unlinked wormhole signatures of both systems, the system you left first', () => {
			const f = fixtures();
			const list = jumpSigPrompt.candidates(FROM, TO, f.wormholes, f.signatures, 1);
			assert.deepEqual(list.map(c => [c.sig.id, c.side]), [[21, 'from'], [31, 'to']]);
		});
		it('Not the bare hole itself, nor linked holes, nor other signature types', () => {
			const f = fixtures();
			const ids = jumpSigPrompt.candidates(FROM, TO, f.wormholes, f.signatures, 1).map(c => c.sig.id);
			assert.equal(ids.indexOf(11), -1);
			assert.equal(ids.indexOf(41), -1);	// leads to a real system
			assert.equal(ids.indexOf(51), -1);	// a gas site
		});
		it('A generic Leads To (Class-3 ...) still counts as unlinked', () => {
			const f = fixtures({ 22: { systemID: 3 } });
			assert.deepEqual(jumpSigPrompt.candidates(FROM, TO, f.wormholes, f.signatures, 1).map(c => c.sig.id), [21, 31]);
		});
		it('Nothing to choose from: empty list', () => {
			const f = fixtures();
			delete f.wormholes[2];
			delete f.wormholes[3];
			assert.deepEqual(jumpSigPrompt.candidates(FROM, TO, f.wormholes, f.signatures, 1), []);
		});
		it('Sorted by side, then wormhole id', () => {
			const f = fixtures();
			f.signatures[71] = { id: 71, systemID: FROM, signatureID: 'eee111', type: 'wormhole', name: 'C' };
			f.signatures[72] = { id: 72, systemID: null, signatureID: '', type: 'wormhole', name: '' };
			f.wormholes[0] = { id: 0, initialID: 71, secondaryID: 72, type: null, parent: 'initial' };
			assert.deepEqual(jumpSigPrompt.candidates(FROM, TO, f.wormholes, f.signatures, 1).map(c => c.sig.id), [71, 21, 31]);
		});
	});

	describe('plan (what the pop-up shows after linking)', () => {
		function plan(candidateSigId, overrides) {
			const f = fixtures(overrides);
			const hole = jumpSigPrompt.holeToAsk('always', FROM, TO, f.wormholes, f.signatures);
			const candidate = jumpSigPrompt.candidates(FROM, TO, f.wormholes, f.signatures, hole.wormhole.id).filter(c => c.sig.id === candidateSigId)[0];
			return jumpSigPrompt.plan(candidate, FROM, TO, hole);
		}
		it('The signature in the system you left is the origin', () => assert.equal(plan(21).origin.id, 21));
		it('A signature in the system you arrived in: its far side becomes the origin', () => assert.equal(plan(31).origin.id, 32));
		it('A name on the bare hole moves to an unnamed origin', () => assert.equal(plan(31, { 11: { name: 'AB' } }).originName, 'AB'));
		it('A named origin keeps its own name', () => assert.equal(plan(21, { 11: { name: 'AB' } }).originName, 'A'));
		it('No name anywhere: empty', () => assert.equal(plan(31).originName, ''));
	});

	describe('several unknown holes between the same systems', () => {
		function twoHoles() {
			const f = fixtures();
			f.signatures[81] = { id: 81, systemID: FROM, signatureID: '', type: 'wormhole', name: '' };
			f.signatures[82] = { id: 82, systemID: TO, signatureID: '', type: 'wormhole', name: '' };
			f.wormholes[8] = { id: 8, initialID: 81, secondaryID: 82, type: null, parent: 'initial', life: 'stable', mass: 'stable' };
			return jumpSigPrompt.holesToAsk('nomatch', FROM, TO, f.wormholes, f.signatures);
		}
		const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
		const at = secondsAgo => new Date(NOW - secondsAgo * 1000).toISOString().replace('T', ' ').slice(0, 19);
		it('holesToAsk lists both', () => assert.deepEqual(twoHoles().map(h => h.wormhole.id), [1, 8]));
		it('A single hole needs no proof', () => assert.equal(jumpSigPrompt.pickHole([twoHoles()[0]], {}, ['Me'], NOW, 60000).wormhole.id, 1));
		it('The one my jump was logged on', () => {
			const logs = { 1: [{ characterName: 'Other|P', time: at(5) }], 8: [{ characterName: 'Me|P', time: at(5) }] };
			assert.equal(jumpSigPrompt.pickHole(twoHoles(), logs, ['me'], NOW, 60000).wormhole.id, 8);
		});
		it('A jump of mine from long before does not prove it', () => {
			const logs = { 1: [{ characterName: 'Me', time: at(3600) }], 8: [] };
			assert.equal(jumpSigPrompt.pickHole(twoHoles(), logs, ['Me'], NOW, 60000), null);
		});
		it('Both logged by me: not clear, no prompt', () => {
			const logs = { 1: [{ characterName: 'Me', time: at(5) }], 8: [{ characterName: 'Me', time: at(5) }] };
			assert.equal(jumpSigPrompt.pickHole(twoHoles(), logs, ['Me'], NOW, 60000), null);
		});
		it('No logs (unavailable): no prompt', () => assert.equal(jumpSigPrompt.pickHole(twoHoles(), {}, ['Me'], NOW, 60000), null));
		it('Nothing to pick from', () => assert.equal(jumpSigPrompt.pickHole([], {}, ['Me'], NOW, 60000), null));
	});

	describe('bookmark after linking', () => {
		afterEach(() => bookmarkTemplate.use(null));
		function planFor(sigId) {
			const f = fixtures();
			const hole = jumpSigPrompt.holeToAsk('nomatch', FROM, TO, f.wormholes, f.signatures);
			const candidate = jumpSigPrompt.candidates(FROM, TO, f.wormholes, f.signatures, 1).filter(c => c.sig.id === sigId)[0];
			return { plan: jumpSigPrompt.plan(candidate, FROM, TO, hole), candidate };
		}
		it('Default template: =<name> <class> <SIG>', () => {
			const p = planFor(21);
			assert.equal(jumpSigPrompt.bookmark(p.plan, p.candidate, FROM, 'C5'), '=A C5 ABC');
		});
		it('Uses the mask template', () => {
			bookmarkTemplate.use({ hole: '{name}-{sigid} {type} {class}', back: '!{name}' });
			const p = planFor(21);
			assert.equal(jumpSigPrompt.bookmark(p.plan, p.candidate, FROM, 'C5'), 'A-ABC-123 H296 C5');
		});
		it('End of life is marked', () => {
			const p = planFor(21);
			p.candidate.wormhole.life = 'critical';
			assert.equal(jumpSigPrompt.bookmark(p.plan, p.candidate, FROM, ''), '=A ABC EOL');
		});
		it('An unnamed hole has no bookmark yet', () => {
			const p = planFor(31);
			assert.equal(jumpSigPrompt.bookmark(p.plan, p.candidate, FROM, 'C5'), null);
		});
	});

	describe('idText', () => {
		it('Letters and digits', () => assert.equal(jumpSigPrompt.idText({ signatureID: 'abc123' }), 'ABC-123'));
		it('Letters only', () => assert.equal(jumpSigPrompt.idText({ signatureID: 'abc' }), 'ABC'));
		it('Placeholder', () => assert.deepEqual([{ signatureID: '' }, { signatureID: null }, undefined].map(jumpSigPrompt.idText), ['no ID yet', 'no ID yet', 'no ID yet']));
	});
});
