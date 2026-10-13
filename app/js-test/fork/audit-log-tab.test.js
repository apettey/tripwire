const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/audit-log-tab');

describe('auditLogTab', () => {
	const names = { 31000201: 'J100001', 31000202: 'J100002', 30000142: 'Jita' };
	const sysName = id => names[id];

	describe('describe', () => {
		it('says what a signature add / delete was', () => {
			const row = { entity: 'signature', action: 'add', subject: 'ABC123', detail: { id: 'ABC123', type: 'relic', name: 'Old temple' } };
			assert.strictEqual(auditLogTab.describe(row, sysName), 'added relic signature ABC123 "Old temple"');
			assert.strictEqual(auditLogTab.describe(Object.assign({}, row, { action: 'delete' }), sysName), 'deleted relic signature ABC123 "Old temple"');
			assert.strictEqual(auditLogTab.describe({ entity: 'signature', action: 'add', subject: 'ABC123', detail: {} }, sysName), 'added unknown signature ABC123');
		});
		it('lists before and after of a signature change, systems by name', () => {
			const row = { entity: 'signature', action: 'update', subject: 'ABC123', detail: { id: 'ABC123', changes: { name: ['', 'Foo'], type: ['unknown', 'gas'], systemID: [31000201, 31000202] } } };
			assert.strictEqual(auditLogTab.describe(row, sysName), 'changed signature ABC123: name none → Foo; type unknown → gas; leads to J100001 → J100002');
		});
		it('shows unknown systems as #id', () => {
			assert.strictEqual(auditLogTab.changesText({ systemID: [5, 31000201] }, sysName), 'leads to #5 → J100001');
			assert.strictEqual(auditLogTab.changesText({ systemID: [5, 6] }, undefined), 'leads to #5 → #6');
		});
		it('describes a wormhole mapped, changed and deleted', () => {
			const add = { entity: 'wormhole', action: 'add', subject: 'H296', detail: { type: 'H296', life: 'stable', mass: 'stable', from: 'XYZ789', to: 'DEF456' } };
			assert.strictEqual(auditLogTab.describe(add, sysName), 'mapped H296 wormhole (XYZ789 ↔ DEF456), life stable, mass stable');
			const upd = { entity: 'wormhole', action: 'update', subject: 'H296', detail: { from: 'XYZ789', to: 'DEF456', changes: { life: ['stable', 'critical'], mass: ['stable', 'destab'] } } };
			assert.strictEqual(auditLogTab.describe(upd, sysName), 'changed H296 wormhole (XYZ789 ↔ DEF456): life stable → critical; mass stable → destab');
			assert.strictEqual(auditLogTab.describe(Object.assign({}, add, { action: 'delete' }), sysName), 'deleted H296 wormhole (XYZ789 ↔ DEF456)');
		});
		it('describes a wormhole end moved (leads to)', () => {
			const row = { entity: 'wormhole', action: 'update', subject: 'DEF456', detail: { id: 'DEF456', changes: { systemID: [31000201, 31000202] } } };
			assert.strictEqual(auditLogTab.describe(row, sysName), 'changed wormhole signature DEF456: leads to J100001 → J100002');
		});
		it('describes mask-admin entries from fork_mask_audit', () => {
			assert.strictEqual(auditLogTab.describe({ entity: 'mask', action: 'block', subject: 'Mallory', detail: 'spying' }, sysName), 'blocked Mallory (spying)');
			assert.strictEqual(auditLogTab.describe({ entity: 'mask', action: 'defaults', subject: '', detail: '' }, sysName), 'changed the mask defaults');
		});
		it('describes region map targets', () => {
			assert.strictEqual(auditLogTab.describe({ entity: 'target', action: 'add', subject: 'hit it', detail: { expires: '18:20' } }, sysName), 'marked a region map target "hit it" (until 18:20 EVE time)');
			assert.strictEqual(auditLogTab.describe({ entity: 'target', action: 'delete', subject: '', detail: {} }, sysName), 'removed a region map target');
			assert.strictEqual(auditLogTab.describe({ entity: 'target', action: 'clear', subject: '', detail: { count: 3 } }, sysName), 'cleared all region map targets (3)');
		});
		it('survives missing detail', () => {
			assert.strictEqual(typeof auditLogTab.describe({ entity: 'wormhole', action: 'delete', detail: null }, sysName), 'string');
			assert.strictEqual(typeof auditLogTab.describe({ entity: 'signature', action: 'update' }, sysName), 'string');
		});
	});

	describe('rowHtml', () => {
		it('escapes everything that came from users (names, signature text)', () => {
			const row = { at: '2026-10-12 10:11:12', characterID: 1, characterName: '<img src=x onerror=alert(1)>', entity: 'signature', action: 'add', subject: 'A', systemID: 31000201, toSystemID: 0,
				detail: { id: 'A', type: 'gas', name: '"><script>alert(1)</script>' } };
			const html = auditLogTab.rowHtml(row, sysName);
			assert.ok(!/<script|<img/i.test(html), html);
			assert.ok(html.indexOf('&lt;img') >= 0 && html.indexOf('&lt;script&gt;') >= 0);
			assert.ok(html.indexOf('2026-10-12 10:11') >= 0 && html.indexOf('10:11:12') < 0);
		});
		it('links the system, and both ends of a wormhole', () => {
			const one = auditLogTab.systemCell({ systemID: 31000201, toSystemID: 0 }, sysName);
			assert.strictEqual(one, "<a href='.?system=J100001' title='Open J100001'>J100001</a>");
			const two = auditLogTab.systemCell({ systemID: 31000201, toSystemID: 31000202 }, sysName);
			assert.ok(two.indexOf('system=J100001') > 0 && two.indexOf('system=J100002') > 0 && two.indexOf(' → ') > 0);
		});
		it('does not link a system it cannot name, and encodes names', () => {
			assert.strictEqual(auditLogTab.systemCell({ systemID: 5, toSystemID: 0 }, sysName), '#5');
			assert.strictEqual(auditLogTab.systemCell({ systemID: 0, toSystemID: 0 }, sysName), '');
			assert.ok(auditLogTab.systemCell({ systemID: 9 }, () => 'A B&C').indexOf('system=A%20B%26C') > 0);
		});
	});

	describe('filters', () => {
		const systems = { 31000201: { name: 'J100001' }, 30000142: { name: 'Jita' } };
		it('finds a system by exact name, case-insensitive', () => {
			assert.strictEqual(auditLogTab.systemID(' jita ', systems), 30000142);
			assert.strictEqual(auditLogTab.systemID('Jit', systems), 0);
			assert.strictEqual(auditLogTab.systemID('', systems), 0);
			assert.strictEqual(auditLogTab.systemID('Jita', null), 0);
		});
		it('sends only the filters that are set', () => {
			assert.deepStrictEqual(auditLogTab.params({ system: '', character: ' ', kind: '', from: '', to: '' }, systems, 1), {});
			assert.deepStrictEqual(auditLogTab.params({ system: 'jita', character: ' bob ', kind: 'signature.add', from: '2026-10-01', to: '2026-10-12' }, systems, 3),
				{ system: 30000142, character: 'bob', kind: 'signature.add', from: '2026-10-01', to: '2026-10-12', page: 3 });
		});
		it('returns null for a system name that is not known', () => {
			assert.strictEqual(auditLogTab.params({ system: 'Nowhere' }, systems, 1), null);
		});
		it('offers the kinds the server accepts', () => {
			const kinds = auditLogTab.KINDS.map(k => k[0]);
			['', 'signature', 'signature.add', 'signature.update', 'signature.delete', 'wormhole', 'wormhole.add', 'wormhole.update', 'wormhole.delete', 'mask'].forEach(k => assert.ok(kinds.indexOf(k) >= 0, k));
		});
	});

	describe('markup', () => {
		it('lists rows newest first as given, with an empty state', () => {
			assert.ok(auditLogTab.tableHtml([], sysName).indexOf('No entries.') > 0);
			const rows = [{ at: '2026-10-12 10:00:00', characterName: 'A', entity: 'mask', action: 'grant', subject: 'B', detail: '', systemID: 0, toSystemID: 0 },
				{ at: '2026-10-11 10:00:00', characterName: 'C', entity: 'mask', action: 'revoke', subject: 'D', detail: '', systemID: 0, toSystemID: 0 }];
			const html = auditLogTab.tableHtml(rows, sysName);
			assert.ok(html.indexOf('2026-10-12') < html.indexOf('2026-10-11'));
		});
		it('disables the pager buttons at the ends', () => {
			assert.ok(/al-prev'\s+disabled/.test(auditLogTab.pagerHtml(1, true, 5)));
			assert.ok(!/al-next'\s+disabled/.test(auditLogTab.pagerHtml(1, true, 5)));
			assert.ok(/al-next'\s+disabled/.test(auditLogTab.pagerHtml(2, false, 5)));
			assert.ok(!/al-prev'\s+disabled/.test(auditLogTab.pagerHtml(2, false, 5)));
		});
		it('escapes the typed filter values', () => {
			const html = auditLogTab.filtersHtml({ system: "'><b>", character: '"', kind: 'wormhole', from: '', to: '' });
			assert.ok(html.indexOf('<b>') < 0 && html.indexOf('value=\'&#39;&gt;&lt;b&gt;\'') > 0);
			assert.ok(html.indexOf("value='wormhole' selected") > 0);
		});
	});
});
