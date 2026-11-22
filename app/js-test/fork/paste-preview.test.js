const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/paste-preview');

const HERE = 31001159, AMARR = 30002187, THERA = 31000005, J105 = 31001234;
const SAMPLE = [
	'ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t4.21 AU',
	'GHI-789\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t12.0 AU',
	'JKL-012\tCosmic Signature\tCombat Site\tSansha Military Outpost\t100.0%\t8.10 AU',
	'MNO-345\tCosmic Signature\tGas Site\tBarren Perimeter Reservoir\t100.0%\t2.03 AU',
	'STU-901\tCosmic Signature\t\t\t23.5%\t15.3 AU',
	'VWX-234\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t38 km'
].join('\n');

/** The mockup's J164104: three holes (to Amarr, Thera, J105033) and three sites */
function client() {
	const s = {}, w = {};
	const sig = (id, systemID, signatureID, type, name) => { s[id] = { id: id, systemID: systemID, signatureID: signatureID, type: type, name: name || '' }; };
	sig(1, HERE, 'abc123', 'wormhole', 'HS'); sig(2, AMARR, null, 'wormhole');
	sig(3, HERE, 'def456', 'wormhole', 'C5 static'); sig(4, THERA, null, 'wormhole');
	sig(5, HERE, 'ghi789', 'wormhole'); sig(6, J105, null, 'wormhole');
	sig(7, HERE, 'jkl012', 'combat', 'Sansha Military Outpost');
	sig(8, HERE, 'mno345', 'unknown');
	sig(9, HERE, 'pqr678', 'data', 'Unsecured Frontier Server');
	sig(10, HERE, '???', 'unknown');
	w[11] = { id: 11, initialID: 1, secondaryID: 2, type: 'D845', parent: 'initial', life: 'stable', mass: 'stable' };
	w[12] = { id: 12, initialID: 3, secondaryID: 4, type: 'K162', parent: 'initial', life: 'stable', mass: 'stable' };
	w[13] = { id: 13, initialID: 5, secondaryID: 6, type: 'O477', parent: 'initial', life: 'stable', mass: 'stable' };
	return { signatures: s, wormholes: w };
}
/** What paste.js would send for SAMPLE against client(): STU-901 and VWX-234 added, MNO-345 updated */
function upstreamPayload() {
	return { signatures: {
		add: [
			{ signatureID: 'STU901', systemID: HERE, type: 'unknown', name: '', lifeLength: 259200 },
			{ wormhole: { type: null, parent: 'initial', life: 'stable', mass: 'stable' }, signatures: [
				{ signatureID: 'VWX234', systemID: HERE, type: 'wormhole', lifeLength: 86400 }, { signatureID: null, systemID: null, type: 'wormhole', lifeLength: 86400 }] }
		],
		update: [{ id: 8, systemID: HERE, type: 'Gas', name: 'Barren Perimeter Reservoir', lifeLength: 259200 }]
	}, systemID: HERE };
}
function classify(extra) {
	const c = client();
	return Object.assign({ c: c }, { g: paste().classify(Object.assign({ rows: paste().parseRows(SAMPLE), payload: upstreamPayload(), systemID: HERE,
		signatures: c.signatures, wormholes: c.wormholes, broken: {} }, extra || {})) });
}
const paste = () => pastePreview;
const ids = list => list.map(r => r.id);

describe('pastePreview: settings', () => {
	it('previews are on unless turned off; Always preview is off unless on', () => {
		assert.strictEqual(pastePreview.enabled(undefined), true);
		assert.strictEqual(pastePreview.enabled({ pastePreview: {} }), true);
		assert.strictEqual(pastePreview.enabled({ pastePreview: { enabled: false } }), false);
		assert.strictEqual(pastePreview.always({}), false);
		assert.strictEqual(pastePreview.always({ pastePreview: { always: true } }), true);
		assert.strictEqual(pastePreview.always({ pastePreview: { always: true, enabled: false } }), false, 'off wins');
	});
	it('auto-save: 10 s unless set to Never, 3 or 5 s; anything else is the default', () => {
		assert.strictEqual(pastePreview.autoSeconds(undefined), 10);
		assert.strictEqual(pastePreview.autoSeconds({ pastePreview: {} }), 10);
		assert.strictEqual(pastePreview.autoSeconds({ pastePreview: { autoSeconds: 0 } }), 0);
		assert.strictEqual(pastePreview.autoSeconds({ pastePreview: { autoSeconds: 3 } }), 3);
		assert.strictEqual(pastePreview.autoSeconds({ pastePreview: { autoSeconds: '5' } }), 5);
		assert.strictEqual(pastePreview.autoSeconds({ pastePreview: { autoSeconds: 7 } }), 10);
		assert.strictEqual(pastePreview.autoSeconds({ pastePreview: { autoSeconds: null } }), 10);
		assert.deepStrictEqual(pastePreview.AUTO_CHOICES.map(c => c[0]), [0, 3, 5, 10]);
	});
});

describe('pastePreview: parseRows', () => {
	it('reads the ID, scan % and distance of each row, each ID once', () => {
		const rows = pastePreview.parseRows(SAMPLE + '\nSTU-901\tCosmic Signature\t\t\t40.0%\t1 AU\nnot a row');
		assert.deepStrictEqual(ids(rows), ['ABC123', 'GHI789', 'JKL012', 'MNO345', 'STU901', 'VWX234']);
		assert.deepStrictEqual(rows[4], { id: 'STU901', pct: '23.5%', dist: '15.3 AU' });
		assert.strictEqual(rows[5].dist, '38 km');
	});
	it('takes German separators and Windows line ends', () => {
		const rows = pastePreview.parseRows('ZJP-752\tKosmische Signatur\tGasgebiet\t\t0,0%\t7,28 AU\r\nDPF-143\tKosmische Signatur\tWurmloch\t\t100,0%\t2.566 m');
		assert.deepStrictEqual(rows.map(r => [r.id, r.pct, r.dist]), [['ZJP752', '0,0%', '7,28 AU'], ['DPF143', '100,0%', '2.566 m']]);
	});
	it('nothing for text without signature IDs', () => {
		assert.deepStrictEqual(pastePreview.parseRows('Jita Local\nabc-123\t1 AU'), []);
		assert.deepStrictEqual(pastePreview.parseRows(undefined), []);
	});
});

describe('pastePreview: classify', () => {
	it('sorts the mockup paste into New, Updated, Unchanged and Gone', () => {
		const { g } = classify();
		assert.deepStrictEqual(ids(g.neu), ['STU901', 'VWX234']);
		assert.deepStrictEqual(ids(g.upd), ['MNO345']);
		assert.deepStrictEqual(ids(g.same), ['ABC123', 'GHI789', 'JKL012']);
		assert.deepStrictEqual(ids(g.gone), ['DEF456', 'PQR678']);
	});
	it('New rows keep the payload index, scan % and distance', () => {
		const { g } = classify();
		assert.deepStrictEqual(g.neu[0], { id: 'STU901', add: 0, hole: false, type: 'unknown', name: '', pct: '23.5%', dist: '15.3 AU', ret: null, on: true });
		assert.strictEqual(g.neu[1].hole, true);
		assert.strictEqual(g.neu[1].add, 1);
	});
	it('Updated rows show the old and new type / name', () => {
		const u = classify().g.upd[0];
		assert.strictEqual(u.update, 0);
		assert.strictEqual(u.sigId, 8);
		assert.strictEqual(u.oldType, 'unknown');
		assert.strictEqual(u.type, 'Gas');
		assert.strictEqual(u.name, 'Barren Perimeter Reservoir');
	});
	it('a gone wormhole and a gone site both default to Delete', () => {
		const { g } = classify();
		assert.deepStrictEqual(g.gone[0], { id: 'DEF456', sigId: 3, hole: true, wormholeID: 12, type: 'K162', name: 'C5 static', farSystemID: THERA, act: 'delete', on: true });
		assert.strictEqual(g.gone[1].act, 'delete');
		assert.strictEqual(g.gone[1].hole, false);
	});
	it('never Gone: ??? sigs, gates, broken holes and what keep() keeps (anomalies kept by Don\'t import)', () => {
		const c = client();
		c.wormholes[12].type = 'GATE';
		const keep = sig => sig.id === 9;
		let g = pastePreview.classify({ rows: pastePreview.parseRows(SAMPLE), payload: upstreamPayload(), systemID: HERE, signatures: c.signatures, wormholes: c.wormholes, broken: {}, keep: keep });
		assert.deepStrictEqual(ids(g.gone), []);
		c.wormholes[12].type = 'K162';
		g = pastePreview.classify({ rows: pastePreview.parseRows(SAMPLE), payload: upstreamPayload(), systemID: HERE, signatures: c.signatures, wormholes: c.wormholes, broken: { 12: true }, keep: keep });
		assert.deepStrictEqual(ids(g.gone), []);
	});
	it('other systems\' signatures are never Gone', () => {
		const c = client();
		c.signatures[20] = { id: 20, systemID: AMARR, signatureID: 'zzz999', type: 'data' };
		const g = pastePreview.classify({ rows: pastePreview.parseRows(SAMPLE), payload: upstreamPayload(), systemID: HERE, signatures: c.signatures, wormholes: c.wormholes });
		assert.ok(ids(g.gone).indexOf('ZZZ999') < 0);
	});
	it('a broken hole in the scan again is an Updated row that restores it', () => {
		const c = client();
		const rows = pastePreview.parseRows(SAMPLE + '\nDEF-456\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t3 AU');
		const g = pastePreview.classify({ rows: rows, payload: upstreamPayload(), systemID: HERE, signatures: c.signatures, wormholes: c.wormholes, broken: { 12: true } });
		const r = g.upd.filter(x => x.id === 'DEF456')[0];
		assert.strictEqual(r.restore, 12);
		assert.strictEqual(r.on, true);
	});
	it('tags the return hole with the system it links to', () => {
		const { g } = classify({ returnHole: { id: 'VWX234', to: 31001753 } });
		assert.strictEqual(g.neu[1].ret, 31001753);
		assert.strictEqual(g.neu[0].ret, null);
	});
	it('works without a payload (nothing new or updated)', () => {
		const c = client();
		const g = pastePreview.classify({ rows: pastePreview.parseRows('ABC-123\tCosmic Signature\tWormhole\t\t100.0%\t4 AU'), payload: null, systemID: HERE, signatures: c.signatures, wormholes: c.wormholes });
		assert.deepStrictEqual(ids(g.same), ['ABC123']);
		assert.deepStrictEqual(ids(g.gone), ['DEF456', 'GHI789', 'JKL012', 'MNO345', 'PQR678']);
	});
	it('needs the preview only when something is Gone, or with Always preview', () => {
		assert.strictEqual(pastePreview.needsPreview(classify().g, {}), true);
		const quiet = { neu: [{}], upd: [], same: [], gone: [] };
		assert.strictEqual(pastePreview.needsPreview(quiet, {}), false);
		assert.strictEqual(pastePreview.needsPreview(quiet, { pastePreview: { always: true } }), true);
	});
});

describe('pastePreview: plan (Apply)', () => {
	it('everything ticked by default: one request with adds, the update and both deletes', () => {
		const { g, c } = classify();
		const p = pastePreview.plan(g, upstreamPayload(), c.signatures, c.wormholes);
		assert.deepStrictEqual(p.payload.signatures.remove, [{ id: 12 }, 9]);
		assert.strictEqual(p.payload.brokenHoles, undefined);
		assert.strictEqual(pastePreview.summary(p.counts), '2 added, 1 updated, 2 deleted');
	});
	it('the countdown (keepGone): new and updated only, nothing deleted or marked broken, groups not changed', () => {
		const { g, c } = classify();
		g.gone[0].act = 'broken';
		const k = pastePreview.keepGone(g);
		assert.ok(k.gone.length && k.gone.every(r => r.on === false));
		assert.ok(g.gone.every(r => r.on === true), 'a copy');
		const p = pastePreview.plan(k, upstreamPayload(), c.signatures, c.wormholes);
		assert.deepStrictEqual(Object.keys(p.payload.signatures).sort(), ['add', 'update']);
		assert.strictEqual(p.payload.brokenHoles, undefined);
		assert.deepStrictEqual(p.counts, { added: 2, updated: 1, restored: 0, marked: 0, deleted: 0 });
	});
	it('everything ticked, hole set to Mark broken: one request with adds, the update, the site delete and the broken mark', () => {
		const { g, c } = classify();
		g.gone[0].act = 'broken';
		const p = pastePreview.plan(g, upstreamPayload(), c.signatures, c.wormholes);
		assert.strictEqual(p.payload.signatures.add.length, 2);
		assert.strictEqual(p.payload.signatures.update.length, 1);
		assert.deepStrictEqual(p.payload.signatures.remove, [9]);
		assert.deepStrictEqual(p.payload.brokenHoles, { mark: [12] });
		assert.deepStrictEqual(p.counts, { added: 2, updated: 1, restored: 0, marked: 1, deleted: 1 });
		assert.strictEqual(pastePreview.summary(p.counts), '2 added, 1 updated, 1 hole marked broken, 1 deleted');
	});
	it('undo copies: the updated sig and the deleted site as they are now', () => {
		const { g, c } = classify();
		g.gone[0].on = false;
		const p = pastePreview.plan(g, upstreamPayload(), c.signatures, c.wormholes);
		assert.deepStrictEqual(p.undo.update, [c.signatures[8]]);
		assert.deepStrictEqual(p.undo.remove, [c.signatures[9]]);
		assert.notStrictEqual(p.undo.update[0], c.signatures[8], 'a copy');
	});
	it('unticked rows are left alone', () => {
		const { g, c } = classify();
		g.neu[1].on = false; g.upd[0].on = false; g.gone.forEach(r => { r.on = false; });
		const p = pastePreview.plan(g, upstreamPayload(), c.signatures, c.wormholes);
		assert.deepStrictEqual(p.payload, { signatures: { add: [upstreamPayload().signatures.add[0]] } });
		assert.deepStrictEqual(p.counts, { added: 1, updated: 0, restored: 0, marked: 0, deleted: 0 });
	});
	it('a gone hole set to Delete removes the whole hole (by wormhole id), with both sides saved for undo', () => {
		const { g, c } = classify();
		g.gone[0].act = 'delete';
		const p = pastePreview.plan(g, upstreamPayload(), c.signatures, c.wormholes);
		assert.deepStrictEqual(p.payload.signatures.remove, [{ id: 12 }, 9]);
		assert.strictEqual(p.payload.brokenHoles, undefined);
		assert.deepStrictEqual(p.undo.remove[0], { wormhole: c.wormholes[12], signatures: [c.signatures[3], c.signatures[4]] });
	});
	it('a restore row restores the broken hole', () => {
		const c = client();
		const rows = pastePreview.parseRows('DEF-456\tCosmic Signature\tWormhole\t\t100.0%\t3 AU');
		const g = pastePreview.classify({ rows: rows, payload: null, systemID: HERE, signatures: c.signatures, wormholes: c.wormholes, broken: { 12: true } });
		g.gone.forEach(r => { r.on = false; });
		const p = pastePreview.plan(g, null, c.signatures, c.wormholes);
		assert.deepStrictEqual(p.payload, { brokenHoles: { restore: [12] } });
		assert.strictEqual(pastePreview.summary(p.counts), '1 hole restored');
	});
	it('nothing ticked: an empty plan', () => {
		const { g, c } = classify();
		[].concat(g.neu, g.upd, g.gone).forEach(r => { r.on = false; });
		assert.strictEqual(pastePreview.isEmpty(pastePreview.plan(g, upstreamPayload(), c.signatures, c.wormholes)), true);
	});
	it('the notice counts the marks and restores the server made', () => {
		const counts = { added: 2, updated: 1, restored: 1, marked: 2, deleted: 1 };
		assert.deepStrictEqual(pastePreview.savedCounts(counts, { brokenHolesResult: { result: true, marked: [12], restored: [] } }),
			{ added: 2, updated: 1, restored: 0, marked: 1, deleted: 1 });
		assert.deepStrictEqual(pastePreview.savedCounts(counts, {}), { added: 2, updated: 1, restored: 0, marked: 0, deleted: 1 });
		assert.strictEqual(counts.marked, 2, 'not changed');
	});
	it('counts the dialog\'s summary line', () => {
		const { g } = classify();
		g.gone[1].on = false;
		assert.deepStrictEqual(pastePreview.countChoices(g), { neu: 2, upd: 1, same: 3, gone: 2, marked: 0, deleted: 1, kept: 1 });
	});
});

describe('pastePreview: text', () => {
	it('escapes and formats IDs', () => {
		assert.strictEqual(pastePreview.escape('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
		assert.strictEqual(pastePreview.idText('abc123'), 'ABC-123');
		assert.strictEqual(pastePreview.summary({}), '');
		assert.strictEqual(pastePreview.summary({ marked: 2, restored: 1 }), '1 hole restored, 2 holes marked broken');
	});
	it('the hole type from either side', () => {
		const w = { initialID: 1, secondaryID: 2, type: 'D845', parent: 'initial' };
		assert.strictEqual(pastePreview.typeFrom(w, 1), 'D845');
		assert.strictEqual(pastePreview.typeFrom(w, 2), 'K162');
		assert.strictEqual(pastePreview.typeFrom(Object.assign({}, w, { type: '????' }), 2), '????');
	});
	describe('keptIDs (read by rage rolling)', () => {
		const groups = { gone: [{ sigId: 5, on: false }, { sigId: 6, on: true }, { sigId: 7, on: false }] };
		it('the gone rows the user unticked', () => assert.deepEqual(pastePreview.keptIDs(groups, false), ['5', '7']));
		it('the auto-save made no choice: nothing kept', () => assert.deepEqual(pastePreview.keptIDs(pastePreview.keepGone(groups), true), []));
		it('no groups', () => assert.deepEqual(pastePreview.keptIDs(undefined, false), []));
	});
});
