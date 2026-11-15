const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/undo-history');

const ME = 196379789, BOB = 91000001;
const JITA = 30000142, J1 = 31000005, J2 = 31000006;

function sig(id, systemID, signatureID, extra) {
	return Object.assign({ id: id, systemID: systemID, signatureID: signatureID, type: 'data', name: '', modifiedByID: ME, modifiedByName: 'Me',
		lifeLength: 259200, lifeLeft: '2026-11-18 12:00:00' }, extra || {});
}
function hole(id, a, b, extra) {
	return { wormhole: Object.assign({ id: id, initialID: a.id, secondaryID: b.id, type: 'H296', parent: 'initial', life: 'stable', mass: 'stable' }, extra || {}),
		signatures: [Object.assign({}, a, { type: 'wormhole' }), Object.assign({}, b, { type: 'wormhole' })] };
}
function client(sigs, holes) {
	const c = { signatures: {}, wormholes: {} };
	(sigs || []).forEach(s => { c.signatures[s.id] = s; });
	(holes || []).forEach(w => { c.wormholes[w.id] = w; });
	return c;
}
const names = { [JITA]: 'Jita', [J1]: 'J100005', [J2]: 'J100006' };
const ctx = (c, extra) => Object.assign({ client: c, me: ME, viewingSystemID: JITA, systemName: id => names[id] || '' }, extra || {});

describe('undoHistory: steps', () => {
	it('a step is the entries one action pushed together (same group); others stand alone', () => {
		const s = [
			{ action: 'add', signatures: [], meta: { group: 1 } },
			{ action: 'add', signatures: [], meta: { group: 2 } },
			{ action: 'update', signatures: [], meta: { group: 2 } }
		];
		assert.strictEqual(undoHistory.stepSize(s), 2);
		assert.strictEqual(undoHistory.stepSize(s.slice(0, 1)), 1);
		assert.strictEqual(undoHistory.stepSize([]), 0);
		assert.strictEqual(undoHistory.stepSize([{ action: 'add', signatures: [] }, { action: 'add', signatures: [] }]), 1, 'no meta: one entry');
		assert.strictEqual(undoHistory.stepSize([{ action: 'add', signatures: [], meta: { group: 3 } }, { action: 'jumpLink', linkId: 4, signatures: [], meta: { group: 3 } }]), 1, 'a feature entry is its own step');
	});

	it('trim keeps the newest whole steps', () => {
		const s = [1, 1, 2, 3, 3, 3, 4].map(g => ({ action: 'add', signatures: [], meta: { group: g } }));
		undoHistory.trim(s, 2);
		assert.deepStrictEqual(s.map(e => e.meta.group), [3, 3, 3, 4]);
		const t = [{ action: 'add', signatures: [], meta: { group: 1 } }];
		undoHistory.trim(t, 5);
		assert.strictEqual(t.length, 1);
	});
});

describe('undoHistory: payloads', () => {
	const a = sig(11, JITA, 'abc123'), b = sig(12, J1, '', { type: 'wormhole' });
	const h = hole(5, a, b);

	it('undo of an add removes it (a hole by its wormhole id), redo adds it back', () => {
		const step = [{ action: 'add', signatures: [a, h] }];
		assert.deepStrictEqual(undoHistory.payload('undo', step), { signatures: { remove: [11, { id: 5 }] } });
		const redo = undoHistory.payload('redo', step);
		assert.strictEqual(redo.signatures.add.length, 2);
		assert.strictEqual(redo.signatures.remove, undefined);
	});

	it('undo of a delete adds the saved copies back (the server makes new ids), redo deletes again', () => {
		const step = [{ action: 'remove', signatures: [h] }];
		const p = undoHistory.payload('undo', step);
		assert.strictEqual(p.signatures.add.length, 1);
		assert.strictEqual(p.signatures.add[0].wormhole.parent, 'initial');
		assert.strictEqual(p.signatures.add[0].wormhole.initialID, undefined, 'the server sets the sides');
		assert.strictEqual(p.signatures.add[0].signatures[0].signatureID, 'abc123');
		assert.notStrictEqual(p.signatures.add[0], h, 'a copy');
		assert.deepStrictEqual(undoHistory.payload('redo', step), { signatures: { remove: [{ id: 5 }] } });
	});

	it('update goes back to the saved copies either way; a paste step does adds and updates in one request', () => {
		const step = [{ action: 'add', signatures: [a] }, { action: 'update', signatures: [h] }];
		const p = undoHistory.payload('undo', step);
		assert.deepStrictEqual(p.signatures.remove, [11]);
		assert.deepStrictEqual(p.signatures.update, [h]);
		assert.strictEqual(undoHistory.effect('redo', 'update'), 'update');
	});

	it('skips entries it does not own and empty elements', () => {
		assert.deepStrictEqual(undoHistory.payload('undo', [{ action: 'jumpLink', linkId: 3, signatures: [] }, { action: 'add', signatures: [null] }]), { signatures: {} });
	});

	it('succeeded: every part true; failure: the server reason', () => {
		assert.strictEqual(undoHistory.succeeded({ resultSet: [{ result: true }, { result: true }] }), true);
		assert.strictEqual(undoHistory.succeeded({ resultSet: [{ result: true }, { result: false, value: 'Signature ID not found' }] }), false);
		assert.strictEqual(undoHistory.succeeded({}), false);
		assert.strictEqual(undoHistory.succeeded(undefined), false);
		assert.strictEqual(undoHistory.failure({ resultSet: [{ result: true }, { result: false, value: 'Signature ID not found' }] }), 'Signature ID not found');
		assert.strictEqual(undoHistory.failure(null), '');
	});
});

describe('undoHistory: conflicts', () => {
	const a = sig(11, JITA, 'abc123');

	it('undo of my edit: allowed while I was the last to change it', () => {
		const step = [{ action: 'update', signatures: [Object.assign({}, a, { name: 'old' })] }];
		assert.strictEqual(undoHistory.conflict('undo', step, ctx(client([a]))), null);
	});

	it('refused when someone else changed it since, naming them', () => {
		const step = [{ action: 'update', signatures: [a] }];
		const now = Object.assign({}, a, { modifiedByID: BOB, modifiedByName: 'Bob' });
		const c = undoHistory.conflict('undo', step, ctx(client([now])));
		assert.strictEqual(c.reason, 'changed');
		assert.ok(/Bob changed sig ABC-123 since/.test(c.text), c.text);
	});

	it('character ids compare as text (the page has strings, the list numbers)', () => {
		const step = [{ action: 'update', signatures: [a] }];
		assert.strictEqual(undoHistory.conflict('undo', step, ctx(client([a]), { me: String(ME) })), null);
	});

	it('refused when it is gone (someone deleted it)', () => {
		const c = undoHistory.conflict('undo', [{ action: 'add', signatures: [a] }], ctx(client([])));
		assert.strictEqual(c.reason, 'gone');
		assert.ok(/sig ABC-123 is no longer on the list/.test(c.text));
	});

	it('a hole: either side changed by someone else refuses; a side that no longer exists is fine (it was converted)', () => {
		const x = sig(21, JITA, 'xyz789', { type: 'wormhole' }), y = sig(22, J1, '', { type: 'wormhole' });
		const h = hole(7, x, y);
		const bobSide = Object.assign({}, y, { modifiedByID: BOB, modifiedByName: 'Bob' });
		assert.strictEqual(undoHistory.conflict('undo', [{ action: 'update', signatures: [h] }], ctx(client([x, bobSide]))).reason, 'changed');
		assert.strictEqual(undoHistory.conflict('undo', [{ action: 'update', signatures: [h] }], ctx(client([x]))), null);
		assert.strictEqual(undoHistory.conflict('undo', [{ action: 'update', signatures: [h] }], ctx(client([y]))).reason, 'gone', 'the main side');
	});

	it('adding back is refused when the same ID is on the list again in that system', () => {
		const step = [{ action: 'remove', signatures: [a] }];
		assert.strictEqual(undoHistory.conflict('undo', step, ctx(client([]))), null);
		const again = sig(99, JITA, 'ABC123', { modifiedByName: 'Bob', modifiedByID: BOB });
		const c = undoHistory.conflict('undo', step, ctx(client([again])));
		assert.strictEqual(c.reason, 'back');
		assert.ok(/ABC-123 is on the list again \(Bob added it\)/.test(c.text), c.text);
		const elsewhere = sig(98, J1, 'abc123');
		assert.strictEqual(undoHistory.conflict('undo', step, ctx(client([elsewhere]))), null, 'same ID in another system');
		assert.strictEqual(undoHistory.conflict('redo', [{ action: 'add', signatures: [a] }], ctx(client([again]))).reason, 'back', 'redo of an add');
	});

	it('redo of a delete: the item must be there and mine', () => {
		assert.strictEqual(undoHistory.conflict('redo', [{ action: 'remove', signatures: [a] }], ctx(client([a]))), null);
		assert.strictEqual(undoHistory.conflict('redo', [{ action: 'remove', signatures: [a] }], ctx(client([]))).reason, 'gone');
	});

	it('systemNeeded: a plain signature made in another system needs that system\'s list; holes never do', () => {
		const other = sig(31, J2, 'qqq111');
		assert.strictEqual(undoHistory.systemNeeded([{ action: 'remove', signatures: [other] }], JITA), J2);
		assert.strictEqual(undoHistory.systemNeeded([{ action: 'remove', signatures: [other] }], J2), null);
		assert.strictEqual(undoHistory.systemNeeded([{ action: 'remove', signatures: [String(J2) === '31000006' ? Object.assign({}, other, { systemID: '31000006' }) : other] }], J2), null, 'string ids');
		const h = hole(7, sig(1, J2, 'aaa111'), sig(2, J1, ''));
		assert.strictEqual(undoHistory.systemNeeded([{ action: 'update', signatures: [h] }], JITA), null);
		assert.strictEqual(undoHistory.systemNeeded([{ action: 'update', signatures: [sig(3, J2, 'w', { type: 'wormhole' })] }], JITA), null);
	});
});

describe('undoHistory: snapshots, results and id remapping', () => {
	const x = sig(21, JITA, 'xyz789', { type: 'wormhole' }), y = sig(22, J1, '', { type: 'wormhole' });
	const w = { id: 7, initialID: 21, secondaryID: 22, type: 'H296', parent: 'initial', life: 'stable', mass: 'destab' };

	it('snapshot: how a hole is now, initial side first, as a copy', () => {
		const c = client([x, y], [w]);
		const snap = undoHistory.snapshot({ wormhole: { id: 7 }, signatures: [{ id: 22 }, { id: 21 }] }, c);
		assert.strictEqual(snap.wormhole.mass, 'destab');
		assert.deepStrictEqual(snap.signatures.map(s => s.id), [21, 22]);
		snap.wormhole.mass = 'critical';
		assert.strictEqual(w.mass, 'destab', 'a copy');
	});

	it('snapshot: a signature that became a hole comes back as the hole; one that is gone as itself', () => {
		const c = client([x, y], [w]);
		assert.strictEqual(undoHistory.snapshot(Object.assign({}, x, { type: 'data' }), c).wormhole.id, 7);
		const lost = sig(50, JITA, 'lll000');
		assert.deepStrictEqual(undoHistory.snapshot(lost, c), lost);
		const plain = sig(51, JITA, 'ppp000', { name: 'now' });
		assert.strictEqual(undoHistory.snapshot(Object.assign({}, plain, { name: 'then' }), client([plain])).name, 'now');
	});

	it('idMap / remap: re-added items get their new ids in every remaining entry', () => {
		const a = sig(11, JITA, 'abc123');
		const h = { wormhole: Object.assign({}, w), signatures: [x, y] };
		const step = [{ action: 'remove', signatures: [a, h] }];
		const added = undoHistory.addedElements('undo', step);
		const results = [Object.assign({}, a, { id: 111 }), { wormhole: Object.assign({}, w, { id: 77, initialID: 121, secondaryID: 122 }), signatures: [Object.assign({}, x, { id: 121 }), Object.assign({}, y, { id: 122 })] }];
		const map = undoHistory.idMap(added, results);
		assert.deepStrictEqual(map, { sig: { 11: 111, 21: 121, 22: 122 }, hole: { 7: 77 } });
		const older = [
			{ action: 'update', signatures: [Object.assign({}, a)] },
			{ action: 'update', signatures: [{ wormhole: Object.assign({}, w), signatures: [Object.assign({}, x), Object.assign({}, y)] }] },
			{ action: 'update', signatures: [sig(12, JITA, 'other')] }
		];
		undoHistory.remap(older, map);
		assert.strictEqual(older[0].signatures[0].id, 111);
		assert.strictEqual(older[1].signatures[0].wormhole.id, 77);
		assert.strictEqual(older[1].signatures[0].wormhole.initialID, 121);
		assert.deepStrictEqual(older[1].signatures[0].signatures.map(s => s.id), [121, 122]);
		assert.strictEqual(older[2].signatures[0].id, 12, 'others untouched');
		assert.strictEqual(undoHistory.idMap(added, results.slice(0, 1)), null, 'a partial answer does not line up');
	});

	it('opposite: undo of a delete -> redo deletes the re-added items (new ids); undo of an edit -> redo puts back the state before the undo', () => {
		const a = sig(11, JITA, 'abc123');
		const step = [{ action: 'remove', signatures: [a], meta: { group: 4, label: 'delete sig ABC-123' } }, { action: 'update', signatures: [Object.assign({}, x, { name: 'old' })], meta: { group: 4 } }];
		const snaps = [[a], [Object.assign({}, x, { name: 'new' })]];
		const out = undoHistory.opposite('undo', step, snaps, [Object.assign({}, a, { id: 111 })]);
		assert.strictEqual(out.entries.length, 2);
		assert.strictEqual(out.entries[0].action, 'remove');
		assert.strictEqual(out.entries[0].signatures[0].id, 111);
		assert.strictEqual(out.entries[1].signatures[0].name, 'new');
		assert.strictEqual(out.entries[0].meta.group, 4, 'still one step');
		assert.deepStrictEqual(out.map.sig, { 11: 111 });
		const back = undoHistory.opposite('redo', [{ action: 'add', signatures: [a] }], [[a]], [Object.assign({}, a, { id: 222 })]);
		assert.strictEqual(back.entries[0].action, 'add');
		assert.strictEqual(back.entries[0].signatures[0].id, 222);
	});
});

describe('undoHistory: labels', () => {
	const c = ctx(client([]));
	it('names the step the way a pilot would say it', () => {
		assert.strictEqual(undoHistory.label({ action: 'remove', signatures: [sig(1, JITA, 'abc123')] }, c), 'delete sig ABC-123');
		assert.strictEqual(undoHistory.label({ action: 'add', signatures: [sig(1, JITA, 'abc123'), sig(2, JITA, 'def456')] }, c), 'add 2 sigs');
		const h = hole(5, sig(11, JITA, 'xyz789'), sig(12, J1, ''));
		assert.strictEqual(undoHistory.label({ action: 'remove', signatures: [h] }, c), 'delete hole XYZ-789 to J100005');
		assert.strictEqual(undoHistory.label({ action: 'remove', signatures: [h, h] }, c), 'delete 2 holes');
		assert.strictEqual(undoHistory.label({ action: 'remove', signatures: [h, sig(1, JITA, 'a')] }, c), 'delete 2 signatures');
		assert.strictEqual(undoHistory.label({ action: 'jumpLink', linkId: 1, signatures: [] }, c), 'link the jump to its signature');
	});

	it('a hole seen from its other side, and an automapped hole without IDs', () => {
		const h = hole(5, sig(11, J1, ''), sig(12, JITA, 'qwe123'));
		assert.strictEqual(undoHistory.label({ action: 'add', signatures: [h] }, c), 'add hole QWE-123 to J100005');
		const bare = hole(6, sig(13, JITA, ''), sig(14, J2, ''));
		assert.strictEqual(undoHistory.label({ action: 'add', signatures: [bare] }, c), 'add hole Jita to J100006');
		assert.strictEqual(undoHistory.label({ action: 'add', signatures: [bare] }, ctx(client([]), { viewingSystemID: J2 })), 'add hole J100006 to Jita');
	});

	it('an edit says what changed (compared with the list now)', () => {
		const a = sig(11, JITA, 'xyz789', { type: 'wormhole' }), b = sig(12, J1, '', { type: 'wormhole' });
		const before = hole(5, a, b);
		const now = client([a, b], [Object.assign({}, before.wormhole, { mass: 'destab', life: 'critical' })]);
		assert.strictEqual(undoHistory.label({ action: 'update', signatures: [before] }, ctx(now)), 'edit hole XYZ-789 to J100005 (life, mass)');
		const moved = client([a, Object.assign({}, b, { systemID: J2 })], [before.wormhole]);
		assert.strictEqual(undoHistory.label({ action: 'update', signatures: [before] }, ctx(moved)), 'edit hole XYZ-789 to J100005 (leads to)');
		const typed = client([a, b], [Object.assign({}, before.wormhole, { type: 'K162' })]);
		assert.strictEqual(undoHistory.label({ action: 'update', signatures: [before] }, ctx(typed)), 'edit hole XYZ-789 to J100005 (type)');
		const timer = client([Object.assign({}, a, { lifeLeft: '2026-11-15 13:00:00' }), b], [before.wormhole]);
		assert.strictEqual(undoHistory.label({ action: 'update', signatures: [before] }, ctx(timer)), 'edit hole XYZ-789 to J100005 (life)', 'a life state (<1h) is a timer');
		const s = sig(30, JITA, 'abc123', { type: 'relic', name: 'Forgotten' });
		assert.strictEqual(undoHistory.label({ action: 'update', signatures: [sig(30, JITA, 'abc123')] }, ctx(client([s]))), 'edit sig ABC-123 (type, name)');
		assert.strictEqual(undoHistory.label({ action: 'update', signatures: [sig(30, JITA, 'abc123')] }, null), 'edit sig ABC-123');
	});

	it('stepLabel joins the entries of a step', () => {
		assert.strictEqual(undoHistory.stepLabel([{ meta: { label: 'add 3 sigs' } }, { meta: { label: 'edit sig ABC-123' } }]), 'add 3 sigs, edit sig ABC-123');
	});
});

describe('undoHistory: keys and storage', () => {
	it('Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo; never while typing or with Alt', () => {
		assert.strictEqual(undoHistory.keyAction({ key: 'z', ctrlKey: true }), 'undo');
		assert.strictEqual(undoHistory.keyAction({ key: 'Z', ctrlKey: true, shiftKey: true }), 'redo');
		assert.strictEqual(undoHistory.keyAction({ key: 'y', metaKey: true }), 'redo');
		assert.strictEqual(undoHistory.keyAction({ key: 'я', code: 'KeyZ', ctrlKey: true }), 'undo', 'another keyboard layout');
		assert.strictEqual(undoHistory.keyAction({ key: 'z', ctrlKey: true, editable: true }), null);
		assert.strictEqual(undoHistory.keyAction({ key: 'z', ctrlKey: true, altKey: true }), null);
		assert.strictEqual(undoHistory.keyAction({ key: 'z' }), null);
		assert.strictEqual(undoHistory.keyAction({ key: 'Y', ctrlKey: true, shiftKey: true }), null);
		assert.strictEqual(undoHistory.keyAction(null), null);
	});

	it('load keeps well-formed entries only, per mask', () => {
		const s = undoHistory.load(JSON.stringify({ byMask: { '1.0': { undo: [{ action: 'add', signatures: [] }, { nope: 1 }, null], redo: 'x' }, '2.0': null }, group: 7 }));
		assert.strictEqual(s.byMask['1.0'].undo.length, 1);
		assert.deepStrictEqual(s.byMask['1.0'].redo, []);
		assert.strictEqual(s.byMask['2.0'], undefined);
		assert.strictEqual(s.group, 7);
		assert.deepStrictEqual(undoHistory.load('not json'), { byMask: {}, group: 0 });
		assert.deepStrictEqual(undoHistory.load(null), { byMask: {}, group: 0 });
		assert.deepStrictEqual(undoHistory.load(JSON.stringify({ undo: [{ action: 'add', signatures: [] }] })).byMask, {}, 'the old one-mask shape is dropped');
	});

	it('maskKey: the active mask as text', () => {
		assert.strictEqual(undoHistory.maskKey({ masks: { active: '196379789.1' } }), '196379789.1');
		assert.strictEqual(undoHistory.maskKey({ masks: { active: 273 } }), '273');
		assert.strictEqual(undoHistory.maskKey(null), '');
	});
});

describe('undoHistory: a step the server applied only in part', () => {
	const a = sig(11, JITA, 'abc123'), b = sig(12, JITA, 'def456'), c = sig(13, JITA, 'ghi789');
	// A paste step: adds a, b (undo: remove them) and updated c (undo: update it back)
	const step = () => [
		{ action: 'add', signatures: [Object.assign({}, a), Object.assign({}, b)], meta: { group: 9, label: 'add 2 sigs' } },
		{ action: 'update', signatures: [Object.assign({}, c, { name: 'before' })], meta: { group: 9 } }
	];

	it('parts are in the order the server answers: adds, updates, removes', () => {
		const p = undoHistory.parts('undo', step());
		assert.deepStrictEqual(p.map(x => x.kind + ':' + x.entry + '.' + x.el), ['update:1.0', 'remove:0.0', 'remove:0.1']);
		const r = undoHistory.parts('undo', [{ action: 'remove', signatures: [a] }, { action: 'add', signatures: [b] }]);
		assert.deepStrictEqual(r.map(x => x.kind), ['add', 'remove']);
	});

	it('outcome maps the resultSet back to the elements; null when it does not line up', () => {
		const data = { resultSet: [{ result: false, value: 'Signature ID not found' }, { result: true }, { result: true }] };
		assert.deepStrictEqual(undoHistory.outcome('undo', step(), data), [{ 0: true, 1: true }, { 0: false }]);
		assert.strictEqual(undoHistory.outcome('undo', step(), { resultSet: [{ result: true }] }), null);
		assert.strictEqual(undoHistory.outcome('undo', step(), {}), null);
	});

	it('appliedPart keeps the applied elements and their snapshots', () => {
		const s = step();
		const part = undoHistory.appliedPart(s, [[a, b], [c]], [{ 0: true, 1: false }, { 0: true }]);
		assert.strictEqual(part.applied, 2);
		assert.strictEqual(part.sent, 3);
		assert.deepStrictEqual(part.entries.map(e => e.signatures.map(x => x.id)), [[11], [13]]);
		assert.deepStrictEqual(part.snapshots, [[a], [c]]);
		assert.strictEqual(part.entries[0].meta.group, 9);
	});

	it('settle: the applied part goes on the redo stack, the step leaves the undo stack, nothing is lost', () => {
		global.options = { masks: { active: '1.0' } };
		undoHistory.ui.reset();
		const undo = undoHistory.ui.stack('undo');
		step().forEach(e => undo.push(e));
		assert.strictEqual(undoHistory.ui.top('undo').length, 2, 'one step');
		const s = undoHistory.ui.top('undo');
		const snaps = [[a, b], [Object.assign({}, c, { name: 'after' })]];
		// the update failed, both removes went through
		const r = undoHistory.ui.settle('undo', s, snaps, { resultSet: [{ result: false, value: 'Signature ID not found' }, { result: true }, { result: true }] }, '1.0');
		assert.deepStrictEqual([r.status, r.applied, r.sent, r.why], ['partial', 2, 3, 'Signature ID not found']);
		assert.strictEqual(undoHistory.ui.stack('undo').length, 0);
		const redo = undoHistory.ui.stack('redo');
		assert.strictEqual(redo.length, 1);
		assert.strictEqual(redo[0].action, 'add');
		assert.deepStrictEqual(redo[0].signatures.map(x => x.signatureID), ['abc123', 'def456'], 'redo deletes them again');
		// all failed: dropped, nothing to redo
		undoHistory.ui.reset();
		step().forEach(e => undoHistory.ui.stack('undo').push(e));
		const f = undoHistory.ui.settle('undo', undoHistory.ui.top('undo'), snaps, { resultSet: [{ result: false }, { result: false }, { result: false }] }, '1.0');
		assert.strictEqual(f.status, 'failed');
		assert.strictEqual(undoHistory.ui.stack('undo').length + undoHistory.ui.stack('redo').length, 0);
		// all done: the whole step is redoable, re-added ids remapped
		undoHistory.ui.reset();
		undoHistory.ui.stack('undo').push({ action: 'update', signatures: [Object.assign({}, a)] });
		undoHistory.ui.stack('undo').push({ action: 'remove', signatures: [Object.assign({}, b)] });
		const d = undoHistory.ui.settle('undo', undoHistory.ui.top('undo'), [[a], [b]], { resultSet: [{ result: true }, { result: true }], results: [Object.assign({}, b, { id: 112 })] }, '1.0');
		assert.strictEqual(d.status, 'done');
		assert.deepStrictEqual(undoHistory.ui.stack('redo').map(e => e.action + ':' + e.signatures[0].id), ['update:11', 'remove:112'], 're-added b has its new id');
	});
});

describe('undoHistory: one history per mask', () => {
	afterEach(() => { delete global.options; });

	it('a step made in one mask is never offered in another (the server saves into the active mask)', () => {
		global.options = { masks: { active: 'private.1' } };
		undoHistory.ui.reset();
		undoHistory.ui.stack('undo').push({ action: 'remove', signatures: [sig(1, JITA, 'abc123')] });
		assert.strictEqual(undoHistory.ui.top('undo').length, 1);
		assert.strictEqual(undoHistory.ui.top('undo')[0].meta.mask, 'private.1');
		global.options.masks.active = 'corp.2';
		assert.strictEqual(undoHistory.ui.top('undo').length, 0, 'nothing to undo in the corp mask');
		assert.strictEqual(undoHistory.ui.run('undo'), false);
		undoHistory.ui.stack('undo').push({ action: 'add', signatures: [sig(2, JITA, 'zzz999')] });
		global.options.masks.active = 'private.1';
		assert.deepStrictEqual(undoHistory.ui.top('undo')[0].signatures[0].signatureID, 'abc123', 'back in the private mask, its own step');
		assert.strictEqual(undoHistory.ui.stack('redo', 'private.1').length, 0);
	});

	it('a new edit clears the redo stack of its own mask only', () => {
		global.options = { masks: { active: 'a' } };
		undoHistory.ui.reset();
		undoHistory.ui.internal = true;
		undoHistory.ui.stack('redo', 'a').push({ action: 'add', signatures: [] });
		undoHistory.ui.stack('redo', 'b').push({ action: 'add', signatures: [] });
		undoHistory.ui.internal = false;
		undoHistory.ui.stack('undo', 'a').push({ action: 'add', signatures: [] });
		assert.strictEqual(undoHistory.ui.stack('redo', 'a').length, 0);
		assert.strictEqual(undoHistory.ui.stack('redo', 'b').length, 1);
	});

	it('saved state survives a reload per mask', () => {
		global.options = { masks: { active: 'a' } };
		undoHistory.ui.reset();
		undoHistory.ui.stack('undo').push({ action: 'remove', signatures: [sig(1, JITA, 'abc123')] });
		const text = JSON.stringify(undoHistory.ui.state);
		undoHistory.ui.reset(text);
		assert.strictEqual(undoHistory.ui.stack('undo', 'a').length, 1);
		assert.strictEqual(undoHistory.ui.stack('undo', 'a').isHistoryStack, true);
		assert.strictEqual(undoHistory.ui.stack('undo', 'b').length, 0);
	});
});
