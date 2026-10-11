const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/system-status');

const row = (id, extra) => Object.assign({ systemID: id, status: 'hostile', alias: '', occupier: '', setBy: 'Chribba', setAt: 1791659280 }, extra || {});
const NOW = 1791659280 * 1000;

describe('System status', () => {
	describe('isSystemID', () => {
		it('wormhole and k-space', () => { assert.ok(systemStatus.isSystemID(31000001)); assert.ok(systemStatus.isSystemID('30000142')); });
		it('refuses abyssal, junk, placeholders', () => {
			['32000001', '1', '', null, undefined, 'dest-1', '310000011'].forEach(v => assert.ok(!systemStatus.isSystemID(v), String(v)));
		});
	});

	describe('clean', () => {
		it('trims and collapses whitespace', () => assert.strictEqual(systemStatus.clean('  Home \t 2\n', 24), 'Home 2'));
		it('drops zero-width and direction marks', () => assert.strictEqual(systemStatus.clean('a​b‮c', 24), 'abc'));
		it('cuts to the maximum in characters', () => assert.strictEqual(systemStatus.clean('x'.repeat(50), 24).length, 24));
		it('null / undefined', () => { assert.strictEqual(systemStatus.clean(null, 5), ''); assert.strictEqual(systemStatus.clean(undefined, 5), ''); });
	});

	describe('toMap', () => {
		it('keys rows by system id', () => {
			const m = systemStatus.toMap([row(31000001, { alias: 'Staging' }), row(30000142, { status: 'friendly' })]);
			assert.deepStrictEqual(Object.keys(m).sort(), ['30000142', '31000001']);
			assert.strictEqual(m['31000001'].alias, 'Staging');
		});
		it('drops invalid ids and empty rows, unknown statuses become none', () => {
			const m = systemStatus.toMap([null, row('x'), row(31000002, { status: 'red' }), row(31000003, { status: 'red', alias: 'A' })]);
			assert.deepStrictEqual(Object.keys(m), ['31000003']);
			assert.strictEqual(m['31000003'].status, null);
		});
		it('not an array', () => assert.deepStrictEqual(systemStatus.toMap(null), {}));
		it('normalises missing fields', () => {
			const m = systemStatus.toMap([{ systemID: 31000001, status: 'active' }]);
			assert.deepStrictEqual(m['31000001'], { systemID: 31000001, status: 'active', alias: '', occupier: '', setBy: null, setAt: null });
		});
	});

	describe('changed', () => {
		it('same', () => assert.ok(!systemStatus.changed(systemStatus.toMap([row(31000001)]), systemStatus.toMap([row(31000001)]))));
		it('status, alias, occupier, who, when and removal differ', () => {
			const base = systemStatus.toMap([row(31000001)]);
			[row(31000001, { status: 'friendly' }), row(31000001, { alias: 'x' }), row(31000001, { occupier: 'x' }),
				row(31000001, { setBy: 'Other' }), row(31000001, { setAt: 5 })].forEach(r =>
				assert.ok(systemStatus.changed(base, systemStatus.toMap([r]))));
			assert.ok(systemStatus.changed(base, {}));
		});
	});

	describe('enabled', () => {
		it('on unless explicitly false', () => {
			assert.ok(systemStatus.enabled(undefined));
			assert.ok(systemStatus.enabled({}));
			assert.ok(systemStatus.enabled({ systemStatus: {} }));
			assert.ok(!systemStatus.enabled({ systemStatus: { enabled: false } }));
		});
	});

	describe('ago', () => {
		it('steps', () => {
			const at = 1791659280;
			assert.strictEqual(systemStatus.ago(at, NOW + 20000), 'just now');
			assert.strictEqual(systemStatus.ago(at, NOW + 5 * 60000), '5m ago');
			assert.strictEqual(systemStatus.ago(at, NOW + 3 * 3600000), '3h ago');
			assert.strictEqual(systemStatus.ago(at, NOW + 2 * 86400000 + 5000), '2d ago');
		});
		it('unknown or in the future', () => {
			assert.strictEqual(systemStatus.ago(null, NOW), '');
			assert.strictEqual(systemStatus.ago(1791659280 + 100, NOW), 'just now');
		});
	});

	describe('infoLine', () => {
		it('status, occupier, alias and who/when', () => {
			const r = row(31000001, { occupier: '[HSTL] Hostile Corp', alias: 'Staging' });
			assert.strictEqual(systemStatus.infoLine(r, NOW + 2 * 86400000), 'Hostile · occupied by [HSTL] Hostile Corp · alias Staging (set by Chribba 2d ago)');
		});
		it('only an alias', () => {
			assert.strictEqual(systemStatus.infoLine(row(31000001, { status: null, alias: 'Home 2', setBy: null, setAt: null }), NOW), 'alias Home 2');
		});
		it('nothing set', () => {
			assert.strictEqual(systemStatus.infoLine(null, NOW), '');
			assert.strictEqual(systemStatus.infoLine(row(31000001, { status: null }), NOW), '');
		});
	});

	describe('tooltipText', () => {
		it('lists alias, status, occupier and who', () => {
			const t = systemStatus.tooltipText(row(31000001, { alias: 'Staging', occupier: 'X' }), NOW);
			assert.strictEqual(t, 'Staging\nStatus: Hostile\nOccupier: X\nSet by Chribba just now');
		});
		it('no status', () => assert.ok(systemStatus.tooltipText(row(31000001, { status: null, alias: 'A' }), NOW).indexOf('Status: not set') > 0));
	});

	describe('nodeClasses / nodeHtml', () => {
		it('classes follow the status and alias', () => {
			assert.strictEqual(systemStatus.nodeClasses(row(1, { alias: 'A' })), 'sysstatus sysstatus-hostile sysstatus-has-alias');
			assert.strictEqual(systemStatus.nodeClasses(row(1, { status: 'friendly' })), 'sysstatus sysstatus-friendly');
		});
		it('letter and alias, escaped', () => {
			const html = systemStatus.nodeHtml(row(31000001, { alias: '<b>"x"</b>' }), NOW);
			assert.ok(html.indexOf("sysstatus-letter' title=") > 0 && html.indexOf('>H</span>') > 0);
			assert.ok(html.indexOf('<b>') < 0 && html.indexOf('&lt;b&gt;&quot;x&quot;&lt;/b&gt;') > 0);
		});
		it('letters are unique', () => {
			const letters = systemStatus.STATUSES.map(s => s.letter);
			assert.strictEqual(new Set(letters).size, letters.length);
		});
		it('occupier only gets a neutral dot', () => {
			assert.ok(systemStatus.nodeHtml(row(31000001, { status: null, occupier: 'X' }), NOW).indexOf('sysstatus-occupier-only') > 0);
		});
		it('nothing without a row', () => assert.strictEqual(systemStatus.nodeHtml(null), ''));
	});

	describe('suggestions', () => {
		it('ticker and name, corporations first, once each', () => {
			const s = systemStatus.suggestions({ entities: [
				{ kind: 'alliance', id: 1, name: 'Big Alliance', ticker: 'BIG' },
				{ kind: 'corporation', id: 2, name: 'Hostile Corp', ticker: 'HSTL' },
				{ kind: 'corporation', id: 3, name: 'Hostile Corp', ticker: 'HSTL' }
			] });
			assert.deepStrictEqual(s, ['[HSTL] Hostile Corp', '[BIG] Big Alliance']);
		});
		it('no ticker, none, bad input', () => {
			assert.deepStrictEqual(systemStatus.suggestions({ entities: [{ kind: 'corporation', name: 'No Ticker' }] }), ['No Ticker']);
			assert.deepStrictEqual(systemStatus.suggestions(null), []);
			assert.deepStrictEqual(systemStatus.suggestions({ entities: [null, {}] }), []);
		});
		it('at most 3, each at most 60 characters', () => {
			const entities = [1, 2, 3, 4, 5].map(i => ({ kind: 'corporation', name: 'Corp ' + i + ' ' + 'x'.repeat(80), ticker: 'T' + i }));
			const s = systemStatus.suggestions({ entities });
			assert.strictEqual(s.length, 3);
			s.forEach(t => assert.ok(t.length <= 60));
		});
	});

	describe('payload / applyFields', () => {
		it('only the given fields are sent', () => {
			assert.deepStrictEqual(systemStatus.payload('set', '31000001', { alias: ' Home  2 ' }), { mode: 'set', systemID: 31000001, alias: 'Home 2' });
			assert.deepStrictEqual(systemStatus.payload('set', 31000001, { status: null }), { mode: 'set', systemID: 31000001, status: '' });
			assert.deepStrictEqual(systemStatus.payload('clear', 31000001), { mode: 'clear', systemID: 31000001 });
		});
		it('applyFields keeps the other fields and drops an emptied row', () => {
			const r = systemStatus.applyFields(row(31000001, { alias: 'A' }), 31000001, { status: 'friendly' }, 'Me', 100);
			assert.deepStrictEqual([r.status, r.alias, r.setBy, r.setAt], ['friendly', 'A', 'Me', 100]);
			assert.strictEqual(systemStatus.applyFields(row(31000001, { status: null, alias: 'A' }), 31000001, { alias: '' }, 'Me', 100), null);
			assert.strictEqual(systemStatus.applyFields(null, 31000001, { occupier: 'X' }, null, 100).occupier, 'X');
		});
	});
});
