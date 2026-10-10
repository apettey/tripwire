const assert = require('assert');
const { include, fake$ } = require('../helpers/helpers');

// Load upstream's paste handler for its real row parser (it binds DOM events on load, so fake those)
fake$('inArray', (value, array) => array.indexOf(value));
fake$('keydown', () => $);
fake$('on', () => $);
if (typeof tripwire === 'undefined') { global.tripwire = {}; }
const hadDocument = typeof document !== 'undefined';
if (!hadDocument) { global.document = {}; }
include('app/js/tripwire/paste');
if (!hadDocument) { delete global.document; }
const upstreamPaste = tripwire.pasteSignatures;
const rowParse = upstreamPaste.rowParse;
include('app/js/fork/paste-anywhere');

const SYSTEM = 31001880;
const OTHER = 31001881;

// Probe scanner window, Ctrl+A / Ctrl+C (ID, group, type, name, signal, distance)
const SCAN = [
	"ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t4.21 AU",
	"DEF-456\tCosmic Signature\tData Site\tUnsecured Perimeter Information Center\t100.0%\t2.10 AU",
	"GHI-789\tCosmic Signature\t\t\t12.0%\t8.33 AU",
	"JKL-012\tCosmic Signature\tRelic Site\tForgotten Frontier Recursive Depot\t100.0%\t12.40 AU",
	"MNO-345\tCosmic Anomaly\tCombat Site\tSansha Forsaken Hub\t100.0%\t1.50 AU",
	"PQR-678\tCosmic Signature\tGas Site\t\t45.6%\t950 km"
].join("\r\n");

function signatures() {
	return {
		1: { id: 1, signatureID: 'abc123', systemID: SYSTEM, type: 'unknown', name: null },
		2: { id: 2, signatureID: 'def456', systemID: SYSTEM, type: 'data', name: null },
		3: { id: 3, signatureID: 'ghi789', systemID: SYSTEM, type: 'unknown', name: null },
		4: { id: 4, signatureID: 'old111', systemID: SYSTEM, type: 'gas', name: 'Barren Perimeter Reservoir' },
		5: { id: 5, signatureID: 'whx999', systemID: SYSTEM, type: 'wormhole', name: '' },
		6: { id: 6, signatureID: null, systemID: OTHER, type: 'wormhole', name: '' },
		7: { id: 7, signatureID: '???', systemID: SYSTEM, type: 'unknown', name: null },
		8: { id: 8, signatureID: 'jkl012', systemID: OTHER, type: 'relic', name: 'elsewhere' },
		9: { id: 9, signatureID: 'gat000', systemID: SYSTEM, type: 'wormhole', name: 'Jita' },
		10: { id: 10, signatureID: 'mno345', systemID: SYSTEM, type: 'combat', name: 'Sansha Forsaken Hub' }
	};
}
const WORMHOLES = {
	100: { id: 100, initialID: 5, secondaryID: 6, type: 'H296', life: 'stable', mass: 'stable' },
	101: { id: 101, initialID: 9, secondaryID: 11, type: 'GATE' }
};

describe('Paste anywhere', () => {
	describe('settings', () => {
		it('on when the key is missing', () => {
			assert.equal(pasteAnywhere.enabled({}), true);
			assert.equal(pasteAnywhere.previewEnabled(undefined), true);
			assert.equal(pasteAnywhere.enabled({ pasteAnywhere: {} }), true);
		});
		it('off only when explicitly false', () => {
			assert.equal(pasteAnywhere.enabled({ pasteAnywhere: { enabled: false } }), false);
			assert.equal(pasteAnywhere.previewEnabled({ pasteAnywhere: { enabled: false } }), true);
			assert.equal(pasteAnywhere.previewEnabled({ pasteAnywhere: { preview: false } }), false);
		});
	});

	describe('isEditable', () => {
		it('text fields, selects and rich text keep their pastes', () => {
			['INPUT', 'textarea', 'SELECT'].forEach(tag => assert.equal(pasteAnywhere.isEditable({ tagName: tag }), true));
			assert.equal(pasteAnywhere.isEditable({ tagName: 'DIV', isContentEditable: true }), true);
		});
		it('the page itself does not', () => {
			assert.equal(pasteAnywhere.isEditable({ tagName: 'BODY' }), false);
			assert.equal(pasteAnywhere.isEditable({ tagName: 'BUTTON' }), false);
			assert.equal(pasteAnywhere.isEditable(null), false);
		});
	});

	describe('parseRows (upstream parser)', () => {
		it('parses every scanner row, with CRLF line ends', () => {
			const rows = pasteAnywhere.parseRows(SCAN, rowParse);
			assert.equal(rows.length, 6);
			assert.deepEqual(rows[0].id, ['ABC', '123']);
			assert.equal(rows[0].type, 'Wormhole');
			assert.equal(rows[1].name, 'Unsecured Perimeter Information Center');
			assert.equal(rows[2].type, undefined);
			assert.equal(rows[4].scanGroup, 'Cosmic Anomaly');
		});
		it('ignores text that is not scanner output', () => {
			assert.deepEqual(pasteAnywhere.parseRows('hello world\nhttps://example.com', rowParse), []);
			assert.deepEqual(pasteAnywhere.parseRows('', rowParse), []);
			assert.deepEqual(pasteAnywhere.parseRows(undefined, rowParse), []);
		});
		it('keeps scanner rows among other lines', () => {
			assert.equal(pasteAnywhere.parseRows('some chat\n' + "XYZ-987\tCosmic Signature\t\t\t3.0%\t20 AU", rowParse).length, 1);
		});
	});

	describe('diff', () => {
		const diff = () => pasteAnywhere.diff(pasteAnywhere.parseRows(SCAN, rowParse), signatures(), WORMHOLES, String(SYSTEM));

		it('adds unknown IDs with type and name', () => {
			const d = diff();
			assert.deepEqual(d.add, [
				{ id: 'JKL012', type: 'relic', name: 'Forgotten Frontier Recursive Depot' },	// same ID in another system doesn't count
				{ id: 'PQR678', type: 'gas', name: '' }
			]);
		});
		it('a new wormhole gets no name (upstream stores none)', () => {
			const rows = pasteAnywhere.parseRows("NEW-001\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t1.00 AU", rowParse);
			assert.deepEqual(pasteAnywhere.diff(rows, {}, {}, SYSTEM).add, [{ id: 'NEW001', type: 'wormhole', name: '' }]);
		});
		it('updates type and name', () => {
			const d = diff();
			assert.deepEqual(d.update.map(u => [u.id, u.changes]), [
				['ABC123', [{ field: 'type', from: 'unknown', to: 'wormhole' }]],
				['DEF456', [{ field: 'name', from: '', to: 'Unsecured Perimeter Information Center' }]]
			]);
		});
		it('counts unchanged signatures (no new info, or same type and name)', () => {
			assert.deepEqual(diff().unchanged.map(u => u.id), ['GHI789', 'MNO345']);
		});
		it('lists signatures missing from the paste, skipping ??? and gates', () => {
			const d = diff();
			assert.deepEqual(d.remove.map(r => r.id), ['OLD111', 'WHX999']);
			assert.equal(d.remove[1].wormhole.type, 'H296');
			assert.equal(d.remove[0].wormhole, null);
		});
		it('never changes an existing wormhole', () => {
			const rows = pasteAnywhere.parseRows("WHX-999\tCosmic Signature\tData Site\tSomething\t100.0%\t1.00 AU", rowParse);
			const d = pasteAnywhere.diff(rows, signatures(), WORMHOLES, SYSTEM);
			assert.deepEqual(d.update, []);
			assert.deepEqual(d.unchanged.map(u => u.id), ['WHX999']);
		});
		it('a type change without a name keeps the old name', () => {
			const rows = pasteAnywhere.parseRows("OLD-111\tCosmic Signature\tOre Site\t\t50.0%\t1.00 AU", rowParse);
			const d = pasteAnywhere.diff(rows, signatures(), WORMHOLES, SYSTEM);
			assert.deepEqual(d.update[0].changes, [{ field: 'type', from: 'gas', to: 'ore' }]);
		});
		it('matches IDs case-insensitively and lists duplicates once', () => {
			const rows = pasteAnywhere.parseRows("JKL-012\tCosmic Signature\t\t\t1.0%\t1.00 AU\nJKL-012\tCosmic Signature\t\t\t1.0%\t1.00 AU", rowParse);
			assert.equal(pasteAnywhere.diff(rows, {}, {}, SYSTEM).add.length, 1);
		});
		it('hasChanges', () => {
			const rows = pasteAnywhere.parseRows("GHI-789\tCosmic Signature\t\t\t12.0%\t8.33 AU", rowParse);
			const d = pasteAnywhere.diff(rows, signatures(), WORMHOLES, SYSTEM);
			assert.equal(pasteAnywhere.hasChanges(d, false), false);
			assert.equal(pasteAnywhere.hasChanges(d, true), true);	// others are missing from the paste
			assert.equal(pasteAnywhere.hasChanges(diff(), false), true);
		});
	});

	describe('sameDiff (preview still valid at Apply time)', () => {
		const rows = () => pasteAnywhere.parseRows(SCAN, rowParse);
		const previewed = () => pasteAnywhere.diff(rows(), signatures(), WORMHOLES, SYSTEM);

		it('nothing changed meanwhile', () => {
			const now = pasteAnywhere.diff(rows(), signatures(), WORMHOLES, String(SYSTEM));
			assert.equal(pasteAnywhere.sameDiff(previewed(), now, true), true);
		});
		it('another user added a signature: deletion set grew', () => {
			const sigs = signatures();
			sigs[20] = { id: 20, signatureID: 'eee555', systemID: SYSTEM, type: 'unknown', name: null };
			const now = pasteAnywhere.diff(rows(), sigs, WORMHOLES, SYSTEM);
			assert.deepEqual(now.remove.map(r => r.id), ['OLD111', 'WHX999', 'EEE555']);
			assert.equal(pasteAnywhere.sameDiff(previewed(), now, true), false);
			// irrelevant when nothing is being deleted
			assert.equal(pasteAnywhere.sameDiff(previewed(), now, false), true);
		});
		it('a previewed deletion was already removed', () => {
			const sigs = signatures();
			delete sigs[4];
			assert.equal(pasteAnywhere.sameDiff(previewed(), pasteAnywhere.diff(rows(), sigs, WORMHOLES, SYSTEM), true), false);
		});
		it('someone else added a signature that the paste would add', () => {
			const sigs = signatures();
			sigs[21] = { id: 21, signatureID: 'pqr678', systemID: SYSTEM, type: 'gas', name: null };
			assert.equal(pasteAnywhere.sameDiff(previewed(), pasteAnywhere.diff(rows(), sigs, WORMHOLES, SYSTEM), false), false);
		});
		it('someone else changed a signature that the paste would update', () => {
			const sigs = signatures();
			sigs[1].type = 'wormhole';
			assert.equal(pasteAnywhere.sameDiff(previewed(), pasteAnywhere.diff(rows(), sigs, WORMHOLES, SYSTEM), false), false);
		});
	});

	describe('upstream hooks', () => {
		it('exposes whether an import is still saving', () => {
			assert.equal(typeof upstreamPaste.isProcessing, 'function');
			assert.equal(upstreamPaste.isProcessing(), false);
		});
	});

	describe('rendering', () => {
		it('formats IDs', () => {
			assert.equal(pasteAnywhere.formatID('abc123'), 'ABC-123');
			assert.equal(pasteAnywhere.formatID('???'), '???');
		});
		it('labels types, with the wormhole type of this side', () => {
			assert.equal(pasteAnywhere.typeLabel('relic'), 'Relic');
			assert.equal(pasteAnywhere.typeLabel(undefined), 'Unknown');
			assert.equal(pasteAnywhere.wormholeTypeOf({ id: 5 }, WORMHOLES[100]), 'H296');
			assert.equal(pasteAnywhere.wormholeTypeOf({ id: 6 }, WORMHOLES[100]), 'K162');
			assert.equal(pasteAnywhere.typeLabel('wormhole', 'H296'), 'Wormhole H296');
		});
		it('shows adds, updates and deletions, deletions struck out until ticked', () => {
			const d = pasteAnywhere.diff(pasteAnywhere.parseRows(SCAN, rowParse), signatures(), WORMHOLES, SYSTEM);
			const html = pasteAnywhere.renderHTML(d, false);
			assert.ok(html.indexOf('2 new, 2 changed, 2 unchanged') >= 0);
			assert.ok(html.indexOf('JKL-012') >= 0 && html.indexOf('Forgotten Frontier Recursive Depot') >= 0);
			assert.ok(html.indexOf('Unknown &rarr; Wormhole') >= 0);
			assert.ok(html.indexOf("class='pa-remove pa-off'") >= 0);
			assert.ok(html.indexOf('Wormhole H296') >= 0);
			assert.ok(html.indexOf('Delete 2 signatures not in the paste') >= 0);
			assert.ok(html.indexOf("checked='checked'") < 0);
			assert.ok(pasteAnywhere.renderHTML(d, true).indexOf("checked='checked'") >= 0);
		});
		it('escapes pasted and stored text', () => {
			const rows = pasteAnywhere.parseRows("EVL-666\tCosmic Signature\tRelic Site\t<img src=x onerror=alert(1)>\t100.0%\t1.00 AU", rowParse);
			const sigs = { 1: { id: 1, signatureID: 'xss001', systemID: SYSTEM, type: 'data', name: "<script>alert('x')</script>" } };
			const html = pasteAnywhere.renderHTML(pasteAnywhere.diff(rows, sigs, {}, SYSTEM), true);
			assert.ok(html.indexOf('<img') < 0 && html.indexOf('<script') < 0);
			assert.ok(html.indexOf('&lt;img src=x onerror=alert(1)&gt;') >= 0);
			assert.ok(html.indexOf('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;') >= 0);
		});
		it('summary', () => {
			const d = pasteAnywhere.diff(pasteAnywhere.parseRows(SCAN, rowParse), signatures(), WORMHOLES, SYSTEM);
			assert.equal(pasteAnywhere.summary(d, false), 'Signatures 2 added, 2 updated');
			assert.equal(pasteAnywhere.summary(d, true), 'Signatures 2 added, 2 updated, 2 deleted');
		});
	});
});
