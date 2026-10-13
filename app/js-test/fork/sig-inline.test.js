const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/sig-inline');
include('app/js/fork/life-states');

describe('Inline life / mass edits', () => {
	const wh = { id: '7', initialID: '11', secondaryID: '12', type: 'H296', parent: 'initial', life: 'stable', mass: 'stable' };
	const s1 = { id: '11', signatureID: 'ABC123', lifeLeft: '2026-10-12 20:00:00' };
	const s2 = { id: '12', signatureID: 'XYZ789', lifeLeft: '2026-10-12 20:00:00' };
	// Upstream's two life values unless a test switches the life states on
	let statesOn;
	before(() => { statesOn = sigInline.statesOn; sigInline.statesOn = () => false; });
	after(() => { sigInline.statesOn = statesOn; });

	describe('with life states (Stable / <4h / <1h / Expired)', () => {
		const H = 3600000, now = Date.UTC(2026, 9, 13, 12, 0, 0);
		const at = ms => lifeStates.formatTime(ms);
		const sig = (id, left) => ({ id: id, lifeTime: '2026-10-13 00:00:00', lifeLength: '57600', lifeLeft: at(left) });
		beforeEach(() => { sigInline.statesOn = () => true; });
		afterEach(() => { sigInline.statesOn = () => false; });
		it('offers the four states on keys 1-4, with EOL as a typed key of <4h', () => {
			assert.deepStrictEqual(sigInline.choices('life').map(c => c.value), ['stable', 'lt4h', 'lt1h', 'expired']);
			assert.deepStrictEqual(sigInline.choices('life').map(c => c.label), ['Stable', '<4h', '<1h', 'Expired']);
			assert.deepStrictEqual(sigInline.choiceForKey('life', '3'), sigInline.choices('life')[2]);
			assert.ok(sigInline.choices('life')[1].keys.includes('eol'));
			assert.deepStrictEqual(sigInline.choices('mass').map(c => c.value), ['stable', 'destab', 'critical']);
		});
		it('number keys pick a state in the life popover', () => {
			const act = o => sigInline.keyAction(Object.assign({ key: '', selectedCount: 1, popoverField: 'life' }, o));
			assert.deepStrictEqual(act({ key: '4' }), { type: 'pick', value: 'expired' });
			assert.deepStrictEqual(act({ key: '2' }), { type: 'pick', value: 'lt4h' });
		});
		it('cell text and colour of a state', () => {
			assert.equal(sigInline.cellText('life', 'lt1h'), '<1h');
			assert.equal(sigInline.cellText('life', 'expired'), 'Expired');
			assert.equal(sigInline.cellClass('life', 'expired'), 'critical life-expired');
			assert.equal(sigInline.cellClass('mass', 'destab'), 'destab');
		});
		it('builds the life change with the new timer on both signatures', () => {
			const p = sigInline.buildPayload(wh, 'life', 'lt1h', { sigs: [sig('11', now + 10 * H), sig('12', now + 10 * H)], now: now });
			assert.deepStrictEqual(p, { signatures: { update: [{ wormhole: { id: '7', life: 'critical' }, signatures: [
				{ id: '11', lifeLeft: at(now + H) }, { id: '12', lifeLeft: at(now + H) }] }] } });
		});
		it('nothing to send when the hole is already in that state', () => {
			const crit = Object.assign({}, wh, { life: 'critical' });
			assert.equal(sigInline.buildPayload(crit, 'life', 'lt1h', { sigs: [sig('11', now + 30 * 60000), sig('12', now + 30 * 60000)], now: now }), null);
			assert.equal(sigInline.buildPayload(wh, 'life', 'stable', { sigs: [sig('11', now + 10 * H), sig('12', now + 10 * H)], now: now }), null);
		});
		it('the undo entry puts lifeLeft after lifeLength, so the server restores the timer', () => {
			const full = { id: '11', lifeTime: 'a', lifeLeft: 'b', lifeLength: 'c', name: 'n' };
			const e = sigInline.undoEntry(wh, full, full);
			assert.deepStrictEqual(Object.keys(e.signatures[0].signatures[0]), ['id', 'lifeTime', 'lifeLength', 'name', 'lifeLeft']);
			assert.deepStrictEqual(Object.keys(full), ['id', 'lifeTime', 'lifeLeft', 'lifeLength', 'name']);	// the client's object is untouched
		});
		it('reanchor ignores a state moving on with time, but reports changed data', () => {
			const prev = { field: 'life', value: 'lt4h', snap: 'critical|x|x' };
			assert.deepStrictEqual(sigInline.reanchor(prev, wh, true, { value: 'lt1h', snap: 'critical|x|x' }), { action: 'keep' });
			assert.deepStrictEqual(sigInline.reanchor(prev, wh, true, { value: 'expired', snap: 'critical|y|y' }), { action: 'changed', value: 'expired' });
		});
	});

	describe('enabled', () => {
		it('is on when the key is missing', () => { assert.equal(sigInline.enabled({}), true); assert.equal(sigInline.enabled(undefined), true); });
		it('is off only when explicitly disabled', () => {
			assert.equal(sigInline.enabled({ sigInline: { enabled: false } }), false);
			assert.equal(sigInline.enabled({ sigInline: { enabled: true } }), true);
			assert.equal(sigInline.enabled({ sigInline: {} }), true);
		});
	});

	describe('buildPayload', () => {
		it('sends only the changed life, with both signature ids', () => {
			assert.deepStrictEqual(sigInline.buildPayload(wh, 'life', 'critical'), {
				signatures: { update: [{ wormhole: { id: '7', life: 'critical' }, signatures: [{ id: '11' }, { id: '12' }] }] }
			});
		});
		it('sends only the changed mass', () => {
			assert.deepStrictEqual(sigInline.buildPayload(wh, 'mass', 'destab'), {
				signatures: { update: [{ wormhole: { id: '7', mass: 'destab' }, signatures: [{ id: '11' }, { id: '12' }] }] }
			});
		});
		it('has a single update entry: no EOL end time (EOL is a plain life change)', () => {
			assert.equal(sigInline.buildPayload(wh, 'life', 'critical').signatures.update.length, 1);
		});
		it('is null when the value is unchanged', () => {
			assert.equal(sigInline.buildPayload(wh, 'life', 'stable'), null);
			assert.equal(sigInline.buildPayload(Object.assign({}, wh, { mass: 'critical' }), 'mass', 'critical'), null);
		});
		it('is null for an unknown field, an unknown value or a missing wormhole', () => {
			assert.equal(sigInline.buildPayload(wh, 'type', 'B274'), null);
			assert.equal(sigInline.buildPayload(wh, 'life', 'destab'), null);
			assert.equal(sigInline.buildPayload(undefined, 'life', 'critical'), null);
		});
		it('does not accept destab for life but accepts critical for mass', () => {
			assert.equal(sigInline.buildPayload(wh, 'life', 'destab'), null);
			assert.notEqual(sigInline.buildPayload(wh, 'mass', 'critical'), null);
		});
	});

	describe('undoEntry', () => {
		it('has the shape the signature dialog pushes for an update', () => {
			const e = sigInline.undoEntry(wh, s1, s2);
			assert.deepStrictEqual(e, { action: 'update', signatures: [{ wormhole: wh, signatures: [s1, s2] }] });
		});
		it('holds copies, not the client objects', () => {
			const w = Object.assign({}, wh), a = Object.assign({}, s1), b = Object.assign({}, s2);
			const e = sigInline.undoEntry(w, a, b);
			w.life = 'critical'; a.lifeLeft = 'changed';
			assert.equal(e.signatures[0].wormhole.life, 'stable');
			assert.equal(e.signatures[0].signatures[0].lifeLeft, '2026-10-12 20:00:00');
		});
		it('survives the sessionStorage round trip', () => {
			const e = sigInline.undoEntry(wh, s1, s2);
			assert.deepStrictEqual(JSON.parse(JSON.stringify(e)), e);
		});
	});

	describe('columns, choices and cell text', () => {
		it('maps columns 5 and 6 to life and mass, nothing else', () => {
			assert.equal(sigInline.fieldForColumn(5), 'life');
			assert.equal(sigInline.fieldForColumn(6), 'mass');
			[1, 2, 3, 4, 7].forEach(c => assert.equal(sigInline.fieldForColumn(c), null));
		});
		it('life offers only Stable and EOL (life states off)', () => {
			assert.deepStrictEqual(sigInline.choices('life').map(c => c.value), ['stable', 'critical']);
			assert.deepStrictEqual(sigInline.FIELDS.life.choices.map(c => c.value), ['stable', 'critical']);
			assert.deepStrictEqual(sigInline.FIELDS.life.choices.map(c => c.label), ['Stable', 'EOL']);
		});
		it('mass offers Stable, Destab and Critical', () => {
			assert.deepStrictEqual(sigInline.FIELDS.mass.choices.map(c => c.value), ['stable', 'destab', 'critical']);
		});
		it('cell text matches upstream rendering', () => {
			assert.equal(sigInline.cellText('life', 'critical'), 'EOL');
			assert.equal(sigInline.cellText('life', 'stable'), 'Stable');
			assert.equal(sigInline.cellText('mass', 'destab'), 'destab');
		});
		it('finds the wormhole of either signature', () => {
			const wormholes = { 7: wh, 8: { id: '8', initialID: '21', secondaryID: '22' } };
			assert.equal(sigInline.findWormhole(wormholes, 11), wh);
			assert.equal(sigInline.findWormhole(wormholes, '12'), wh);
			assert.equal(sigInline.findWormhole(wormholes, '22').id, '8');
			assert.equal(sigInline.findWormhole(wormholes, '99'), undefined);
		});
	});

	describe('keyAction', () => {
		const base = { key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, targetEditable: false, dialogOpen: false, selectedCount: 1, popoverField: null };
		const act = o => sigInline.keyAction(Object.assign({}, base, o));
		it('L opens life, M opens mass (either case)', () => {
			assert.deepStrictEqual(act({ key: 'l' }), { type: 'open', field: 'life' });
			assert.deepStrictEqual(act({ key: 'M' }), { type: 'open', field: 'mass' });
		});
		it('needs exactly one selected row', () => {
			assert.equal(act({ key: 'l', selectedCount: 0 }), null);
			assert.equal(act({ key: 'l', selectedCount: 2 }), null);
		});
		it('ignores modifiers, typing in a field, open dialogs and key repeat', () => {
			assert.equal(act({ key: 'l', ctrlKey: true }), null);
			assert.equal(act({ key: 'l', metaKey: true }), null);
			assert.equal(act({ key: 'l', altKey: true }), null);
			assert.equal(act({ key: 'l', shiftKey: true }), null);
			assert.equal(act({ key: 'l', targetEditable: true }), null);
			assert.equal(act({ key: 'l', dialogOpen: true }), null);
			assert.equal(act({ key: 'l', repeat: true }), null);
		});
		it('leaves other keys alone, and Ctrl+Z always', () => {
			assert.equal(act({ key: 'x' }), null);
			assert.equal(act({ key: '1' }), null);
			assert.equal(act({ key: 'z', ctrlKey: true }), null);
			assert.equal(act({ key: 'z', ctrlKey: true, popoverField: 'life' }), null);
		});
		it('1-2 pick in the life popover, 1-3 in the mass popover', () => {
			assert.deepStrictEqual(act({ key: '1', popoverField: 'life' }), { type: 'pick', value: 'stable' });
			assert.deepStrictEqual(act({ key: '2', popoverField: 'life' }), { type: 'pick', value: 'critical' });
			assert.equal(act({ key: '3', popoverField: 'life' }), null);
			assert.deepStrictEqual(act({ key: '2', popoverField: 'mass' }), { type: 'pick', value: 'destab' });
			assert.deepStrictEqual(act({ key: '3', popoverField: 'mass' }), { type: 'pick', value: 'critical' });
		});
		it('Escape closes, arrows move', () => {
			assert.deepStrictEqual(act({ key: 'Escape', popoverField: 'life' }), { type: 'close' });
			assert.deepStrictEqual(act({ key: 'ArrowLeft', popoverField: 'mass' }), { type: 'move', delta: -1 });
			assert.deepStrictEqual(act({ key: 'ArrowRight', popoverField: 'mass' }), { type: 'move', delta: 1 });
		});
		it('Tab closes the popover; digits and arrows are ignored while typing in a field', () => {
			assert.deepStrictEqual(act({ key: 'Tab', popoverField: 'life' }), { type: 'close' });
			assert.equal(act({ key: '1', popoverField: 'life', targetEditable: true }), null);
			assert.equal(act({ key: 'ArrowLeft', popoverField: 'life', targetEditable: true }), null);
		});
		it('Escape is ignored when no popover is open', () => assert.equal(act({ key: 'Escape' }), null));
		it('M inside the life popover switches to mass', () => {
			assert.deepStrictEqual(act({ key: 'm', popoverField: 'life' }), { type: 'open', field: 'mass' });
		});
		it('popover digit keys work even though focus sits on the popover button', () => {
			assert.deepStrictEqual(act({ key: '2', popoverField: 'life', targetEditable: false, dialogOpen: false }), { type: 'pick', value: 'critical' });
		});
	});

	describe('step', () => {
		it('wraps both ways', () => {
			assert.equal(sigInline.step(0, -1, 3), 2);
			assert.equal(sigInline.step(2, 1, 3), 0);
			assert.equal(sigInline.step(1, 1, 3), 2);
		});
	});

	describe('reanchor (rows re-rendered while a popover is open)', () => {
		const prev = { field: 'mass', value: 'stable' };
		it('keeps it when the value is the same', () => assert.deepStrictEqual(sigInline.reanchor(prev, wh, true), { action: 'keep' }));
		it('reports a changed value', () => {
			assert.deepStrictEqual(sigInline.reanchor(prev, Object.assign({}, wh, { mass: 'destab' }), true), { action: 'changed', value: 'destab' });
		});
		it('closes when the row is gone', () => assert.deepStrictEqual(sigInline.reanchor(prev, wh, false), { action: 'close' }));
		it('closes when the wormhole is gone', () => assert.deepStrictEqual(sigInline.reanchor(prev, undefined, true), { action: 'close' }));
		it('only looks at its own field', () => {
			assert.equal(sigInline.reanchor({ field: 'life', value: 'stable' }, Object.assign({}, wh, { mass: 'critical' }), true).action, 'keep');
		});
	});

	describe('idsToReselect', () => {
		const keep = { ids: ['11', '12'], until: 1000 };
		it('returns only the kept ids that were newly inserted', () => assert.deepStrictEqual(sigInline.idsToReselect(keep, ['12', '99'], 500), ['12']));
		it('nothing when no kept row was inserted', () => assert.deepStrictEqual(sigInline.idsToReselect(keep, ['99'], 500), []));
		it('nothing once expired or cleared', () => {
			assert.deepStrictEqual(sigInline.idsToReselect(keep, ['11'], 1000), []);
			assert.deepStrictEqual(sigInline.idsToReselect(null, ['11'], 0), []);
		});
	});

	describe('saveNow timeout', () => {
		let notices, cell;
		const KEYS = ['$', 'Notify', 'viewingSystemID', 'document', 'tripwire'];
		const saved = {};
		beforeEach(() => {
			KEYS.forEach(k => { saved[k] = global[k]; });
			notices = [];
			cell = { className: 'stable', textContent: 'Stable', isConnected: true };
			const chain = { removeClass() { return chain; }, addClass() { return chain; }, map() { return chain; }, get() { return []; } };
			global.$ = () => chain;
			global.Notify = { trigger: (m, c) => notices.push(m + '|' + c) };
			global.viewingSystemID = 5;
			global.document = { querySelector: () => cell };
			global.tripwire = { client: { wormholes: { 7: JSON.parse(JSON.stringify(wh)) }, signatures: { 11: s1, 12: s2 } }, signatures: { undo: {} }, refresh: () => {} };
		});
		afterEach(() => { KEYS.forEach(k => { if (saved[k] === undefined) { delete global[k]; } else { global[k] = saved[k]; } }); sigInline.SAVE_TIMEOUT_MS = 15000; sigInline.queue = Promise.resolve(); });
		it('a save that never settles fails after the timeout, restores the cell and frees the queue', async () => {
			sigInline.SAVE_TIMEOUT_MS = 20;
			const first = sigInline.setWormhole('7', { life: 'critical' });
			const second = sigInline.setWormhole('7', { mass: 'destab' });
			assert.equal(await first, 'failed');
			assert.equal(cell.className, 'stable');
			assert.equal(cell.textContent, 'Stable');
			assert.ok(notices.some(n => /Could not save the life/.test(n) && /red/.test(n)));
			assert.equal(await second, 'failed');	// it ran (and timed out too) instead of waiting forever
			assert.equal(global.tripwire.signatures.undo[5], undefined);
		});
		it('a normal save records the undo entry', async () => {
			global.tripwire.refresh = (m, d, success, always) => { success({ resultSet: [{ result: true }] }); always(); };
			assert.equal(await sigInline.setWormhole('7', { life: 'critical' }), 'saved');
			assert.equal(global.tripwire.signatures.undo[5].length, 1);
		});
	});
});

describe('Signature table keyboard navigation', () => {
	const base = { key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, targetEditable: false, focusOk: true, dialogOpen: false, selectedCount: 1, popoverField: null };
	const act = (extra) => sigInline.keyAction(Object.assign({}, base, extra));
	it('up and down move the selection when exactly one row is selected', () => {
		assert.deepEqual(act({ key: 'ArrowUp' }), { type: 'nav', delta: -1 });
		assert.deepEqual(act({ key: 'ArrowDown' }), { type: 'nav', delta: 1 });
	});
	it('Enter edits the selected row', () => {
		assert.deepEqual(act({ key: 'Enter' }), { type: 'edit' });
	});
	it('nothing when no row or several rows are selected (the page scrolls as usual)', () => {
		['ArrowUp', 'ArrowDown', 'Enter'].forEach(key => {
			assert.equal(act({ key: key, selectedCount: 0 }), null);
			assert.equal(act({ key: key, selectedCount: 2 }), null);
		});
	});
	it('nothing in a text box, over a dialog, or with a modifier', () => {
		['ArrowUp', 'ArrowDown', 'Enter'].forEach(key => {
			assert.equal(act({ key: key, targetEditable: true }), null);
			assert.equal(act({ key: key, dialogOpen: true }), null);
			assert.equal(act({ key: key, ctrlKey: true }), null);
			assert.equal(act({ key: key, metaKey: true }), null);
			assert.equal(act({ key: key, altKey: true }), null);
			assert.equal(act({ key: key, shiftKey: true }), null);
		});
	});
	it('a held arrow keeps moving the selection; a held Enter does not edit again', () => {
		assert.deepEqual(act({ key: 'ArrowDown', repeat: true }), { type: 'nav', delta: 1 });
		assert.deepEqual(act({ key: 'ArrowUp', repeat: true }), { type: 'nav', delta: -1 });
		assert.equal(act({ key: 'Enter', repeat: true }), null);
		assert.equal(act({ key: 'l', repeat: true }), null);
		assert.equal(act({ key: 'ArrowDown', repeat: true, popoverField: 'life' }), null);
	});
	it('nothing unless the focus is on the page or plainly in the signature widget', () => {
		['ArrowUp', 'ArrowDown', 'Enter'].forEach(key => assert.equal(act({ key: key, focusOk: false }), null));
		assert.deepEqual(act({ key: 'l', focusOk: false }), { type: 'open', field: 'life' });	// L / M keep their own rules
	});
	describe('focusOk', () => {
		const doc = { body: {}, documentElement: {} };
		const el = (o) => Object.assign({ ownerDocument: Object.assign({ defaultView: { getComputedStyle: () => ({ overflowY: 'visible' }) } }, doc), closest: (s) => (o.inWidget && s === '#signaturesWidget' ? {} : (o.closest && o.closest[s]) || null), matches: () => !!o.interactive, scrollHeight: 10, clientHeight: 10 }, o.props || {});
		it('the body and nothing focused are fine', () => {
			assert.equal(sigInline.focusOk(null), true);
			const body = { ownerDocument: doc };
			doc.body = body;
			assert.equal(sigInline.focusOk(body), true);
		});
		it('a plain element inside the widget is fine, outside it is not', () => {
			assert.equal(sigInline.focusOk(el({ inWidget: true })), true);
			assert.equal(sigInline.focusOk(el({ inWidget: false })), false);
		});
		it('a button, tab, [tabindex] or [role] widget inside the widget is not', () => {
			assert.equal(sigInline.focusOk(el({ inWidget: true, interactive: true })), false);
		});
		it('inside details or a tab is not', () => {
			assert.equal(sigInline.focusOk(el({ inWidget: true, closest: { 'details, [role=\'tab\'], [role=\'tablist\'], [role=\'dialog\']': {} } })), false);
		});
		it('a scrollable panel is not', () => {
			const e = el({ inWidget: true, props: { scrollHeight: 100, clientHeight: 20 } });
			e.ownerDocument.defaultView.getComputedStyle = () => ({ overflowY: 'auto' });
			assert.equal(sigInline.focusOk(e), false);
		});
	});
	it('L and M still open the popover; inside it the arrows move the chips and Enter is not taken', () => {
		assert.deepEqual(act({ key: 'l' }), { type: 'open', field: 'life' });
		assert.deepEqual(act({ key: 'ArrowDown', popoverField: 'life' }), { type: 'move', delta: 1 });
		assert.equal(act({ key: 'Enter', popoverField: 'life' }), null);
	});
	it('neighbour: stops at the first and last row', () => {
		assert.equal(sigInline.neighbour(2, 1, 5), 3);
		assert.equal(sigInline.neighbour(2, -1, 5), 1);
		assert.equal(sigInline.neighbour(0, -1, 5), 0);
		assert.equal(sigInline.neighbour(4, 1, 5), 4);
		assert.equal(sigInline.neighbour(-1, 1, 5), -1);	// nothing selected
		assert.equal(sigInline.neighbour(0, 1, 0), -1);
	});
});
