const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/command-palette-index');
include('app/js/fork/command-palette');

// A small chain: root R (home) -[B1]-> A -[B2]-> B, and R -[B3]-> C
const systems = {
	1: { name: 'J111111', class: 3, regionID: 9, statics: ['H296', 'C247'] },
	2: { name: 'J222222', class: 4, regionID: 9, statics: ['Z457'] },
	3: { name: 'J333333', class: 2, regionID: 9, statics: [] },
	4: { name: 'Rens', security: 0.9, regionID: 10 },
	5: { name: 'Hed', security: 0.2, regionID: 10 },
	6: { name: 'Pochven-1', security: -0.3, factionID: 500026, regionID: 10 }
};
const regions = { 9: { name: 'Wormhole Space' }, 10: { name: 'Heimatar' } };
const rows = [
	{ c: [{ v: 100, systemID: 1 }, { v: null }] },
	{ c: [{ v: 101, systemID: 2 }, { v: 100 }], pathHome: [{ systemID: 2, name: 'B1' }] },
	{ c: [{ v: 102, systemID: 3 }, { v: 101 }], pathHome: [{ systemID: 2, name: 'B1' }, { systemID: 3, name: 'B2' }] },
	{ c: [{ v: 103, systemID: 4 }, { v: 100 }], pathHome: [{ systemID: 4, name: ' B3 ' }] }
];

describe('Command palette', () => {
	describe('shortcut and guards', () => {
		it('Ctrl+K and Cmd+K only, with no other modifier', () => {
			assert.ok(commandPalette.isToggleKey({ key: 'k', ctrlKey: true }));
			assert.ok(commandPalette.isToggleKey({ key: 'K', metaKey: true }));
			assert.ok(!commandPalette.isToggleKey({ key: 'k' }));
			assert.ok(!commandPalette.isToggleKey({ key: '/' }));
			assert.ok(!commandPalette.isToggleKey({ key: 'k', ctrlKey: true, shiftKey: true }));
			assert.ok(!commandPalette.isToggleKey({ key: 'k', ctrlKey: true, altKey: true }));
			assert.ok(!commandPalette.isToggleKey({ key: 'z', ctrlKey: true }));
			assert.ok(!commandPalette.isToggleKey(null));
		});
		it('does not open in an editor, over a modal dialog, or when switched off', () => {
			assert.ok(commandPalette.canOpen({ enabled: true, editable: false, modal: false }));
			assert.ok(!commandPalette.canOpen({ enabled: true, editable: true, modal: false }));
			assert.ok(!commandPalette.canOpen({ enabled: true, editable: false, modal: true }));
			assert.ok(!commandPalette.canOpen({ enabled: false, editable: false, modal: false }));
			assert.ok(!commandPalette.canOpen(null));
		});
		it('is on unless options.commandPalette.enabled is false', () => {
			assert.equal(commandPalette.enabled({}), true);
			assert.equal(commandPalette.enabled(null), true);
			assert.equal(commandPalette.enabled({ commandPalette: {} }), true);
			assert.equal(commandPalette.enabled({ commandPalette: { enabled: true } }), true);
			assert.equal(commandPalette.enabled({ commandPalette: { enabled: false } }), false);
		});
	});

	describe('describing systems', () => {
		it('class or security band', () => {
			assert.equal(commandPalette.systemClass(systems[1]), 'C3');
			assert.equal(commandPalette.systemClass({ class: [1, 2] }), 'C1/2');
			assert.equal(commandPalette.systemClass(systems[4]), 'HS');
			assert.equal(commandPalette.systemClass(systems[5]), 'LS');
			assert.equal(commandPalette.systemClass(systems[6]), 'Trig');
			assert.equal(commandPalette.systemClass({ security: -0.5 }), 'NS');
			assert.equal(commandPalette.systemClass(null), '');
		});
		it('formats signature IDs', () => {
			assert.equal(commandPalette.formatSigID('abc123'), 'ABC-123');
			assert.equal(commandPalette.formatSigID('abc'), 'ABC');
		});
		it('an EVE system item has class and region as subtitle', () => {
			const it = commandPalette.eveItem(4, systems[4], regions);
			assert.equal(it.subtitle, 'HS · Heimatar');
			assert.equal(it.key, 'eve:4');
			assert.equal(it.systemID, 4);
		});
	});

	describe('chain systems', () => {
		const items = commandPalette.chainItems({ rows: rows, systems: systems, regions: regions, viewingID: 2 });
		const byName = {};
		items.forEach(i => { byName[i.title] = i; });
		it('one item per system, including the root', () => {
			assert.deepEqual(items.map(i => i.title), ['J111111', 'J222222', 'J333333', 'Rens']);
		});
		it('subtitle: class, position, hole name, jumps', () => {
			assert.equal(byName.J111111.subtitle, 'C3 · chain root');
			assert.equal(byName.J222222.subtitle, 'C4 · viewing · B1 · 1 jump');
			assert.equal(byName.J333333.subtitle, 'C2 · on chain · B2 · 2 jumps');
			assert.equal(byName.Rens.subtitle, 'HS · on chain · B3 · 1 jump');
		});
		it('keys: name, J-code digits, hole name, class, statics, k-space region', () => {
			const index = paletteIndex.build(items.map(paletteIndex.item));
			const first = (q) => paletteIndex.search(index, q).results[0];
			assert.equal(first('222222').title, 'J222222');
			assert.equal(first('j222222').title, 'J222222');
			assert.equal(first('b2').title, 'J333333');
			assert.equal(first('c4').title, 'J222222');
			assert.equal(first('z457').title, 'J222222');
			assert.equal(first('heimatar').title, 'Rens');
			assert.equal(first('wormholespace'), undefined);	// no region key for wormhole systems
		});
		it('J-codes are pinned; the viewed system and its neighbours get a context boost', () => {
			assert.equal(byName.J222222.pin, true);
			assert.equal(byName.Rens.pin, false);
			assert.equal(byName.J222222.ctx, 120);
			assert.equal(byName.J111111.ctx, 60);	// parent of the viewed system
			assert.equal(byName.J333333.ctx, 60);	// child of the viewed system
			assert.equal(byName.Rens.ctx, 0);
		});
		it('always lists the viewed system, even with an empty chain', () => {
			const solo = commandPalette.chainItems({ rows: [], systems: systems, regions: regions, viewingID: '5' });
			assert.equal(solo.length, 1);
			assert.equal(solo[0].title, 'Hed');
		});
		it('survives missing data', () => {
			assert.deepEqual(commandPalette.chainItems({ rows: null, systems: null, viewingID: 1 }), []);
			assert.equal(commandPalette.chainItems({ rows: [{ c: [{ v: 1, systemID: 99 }, { v: null }] }], systems: systems, viewingID: 1 }).length, 1);
		});
	});

	describe('signatures and masks', () => {
		const signatures = {
			10: { id: 10, signatureID: 'abc123', systemID: 1, type: 'wormhole', name: 'B1' },
			11: { id: 11, signatureID: 'xyz789', systemID: 1, type: 'combat', name: '' },
			12: { id: 12, signatureID: 'ghi111', systemID: 2, type: 'wormhole', name: '' },
			13: { id: 13, signatureID: null, systemID: 1, type: 'wormhole', name: '' }
		};
		const wormholes = { 1: { id: 1, initialID: 10, secondaryID: 12, type: 'H296' } };
		it('lists the viewed system\'s signatures that have an ID', () => {
			const items = commandPalette.sigItems(signatures, wormholes, 1);
			assert.deepEqual(items.map(i => i.title), ['ABC-123', 'XYZ-789']);
			assert.equal(items[0].subtitle, 'wormhole H296 · B1');
			assert.equal(items[1].subtitle, 'combat');
			assert.equal(items[0].sigID, 10);
			assert.equal(items[0].pin, true);
		});
		it('finds a signature by ID with or without the dash', () => {
			const index = paletteIndex.build(commandPalette.sigItems(signatures, wormholes, 1).map(paletteIndex.item));
			['abc-123', 'abc123', 'abc'].forEach(q => assert.equal(paletteIndex.search(index, q).results[0].title, 'ABC-123', q));
		});
		it('lists the masks the user can use', () => {
			const masks = [{ mask: '1.0', label: 'Corp', active: true }, { mask: '1.1', label: 'Other', owner: true }, { mask: '1.2', label: 'Hidden' }, { mask: '1.3', label: 'Ally', joinedBy: 'alliance' }];
			const items = commandPalette.maskItems(masks);
			assert.deepEqual(items.map(i => i.title), ['Corp', 'Other', 'Ally']);
			assert.equal(items[0].subtitle, 'Mask · active');
			assert.equal(items[1].maskID, '1.1');
		});
	});

	describe('empty query', () => {
		const cmd = (id, group, extra) => paletteIndex.item(Object.assign({ key: 'cmd:' + id, kind: 'cmd', id: id, title: id, group: group }, extra));
		const items = [
			cmd('Add signature', 'Signatures', { inContext: true }), cmd('Undo', 'Signatures', { disabled: 'Nothing to undo', inContext: true }),
			cmd('Open Settings', 'App'), cmd('Make tab', 'Navigation'),
			paletteIndex.item({ key: 'sys:1', kind: 'chain', title: 'J111111' })
		];
		const text = (rows) => rows.map(r => r.header ? '#' + r.header : r.item.title);
		it('shows recents, then context commands for the viewed system, then commands by group', () => {
			const rows = commandPalette.emptyRows(items, ['sys:1', 'cmd:Open Settings', 'gone'], ['Navigation', 'Signatures', 'App'], 'J222222');
			assert.deepEqual(text(rows), ['#Recent', 'J111111', 'Open Settings', '#For J222222', 'Add signature', '#Navigation', 'Make tab', '#Signatures', 'Undo']);
		});
		it('does not list a disabled command under the viewed system', () => {
			assert.ok(text(commandPalette.emptyRows(items, [], ['Signatures'], 'X')).indexOf('Undo') > text(commandPalette.emptyRows(items, [], ['Signatures'], 'X')).indexOf('#Signatures'));
		});
		it('keeps at most 5 recents and can rebuild a recent EVE system', () => {
			const keys = ['cmd:Undo', 'cmd:Make tab', 'cmd:Open Settings', 'cmd:Add signature', 'sys:1', 'eve:4'];
			const rows = commandPalette.emptyRows(items, keys, [], '', (id) => commandPalette.eveItem(id, systems[id], regions));
			assert.equal(rows.length, 1 + 5);
			const rows2 = commandPalette.emptyRows(items, ['eve:4'], [], '', (id) => commandPalette.eveItem(id, systems[id], regions));
			assert.equal(rows2[1].item.title, 'Rens');
		});
	});

	describe('rendering helpers', () => {
		it('escapes user text', () => {
			assert.equal(commandPalette.escape('<b>"x"&\'y\''), '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;');
			assert.equal(commandPalette.escape(null), '');
		});
		it('marks matched characters and escapes the rest', () => {
			assert.equal(commandPalette.titleHtml('Fight <here>', [0, 6]), '<mark>F</mark>ight <mark>&lt;</mark>here&gt;');
			assert.equal(commandPalette.titleHtml('a&b', []), 'a&amp;b');
			assert.equal(commandPalette.titleHtml('abc', [0, 1, 2]), '<mark>abc</mark>');
		});
		it('escapes a hole name that tries to inject markup', () => {
			const items = commandPalette.chainItems({ rows: [{ c: [{ v: 1, systemID: 2 }, { v: null }], pathHome: [{ systemID: 2, name: '<img src=x onerror=alert(1)>' }] }], systems: systems, viewingID: 2 });
			assert.ok(commandPalette.escape(items[0].subtitle).indexOf('<') < 0);
			assert.ok(commandPalette.titleHtml(items[0].title, []).indexOf('<img') < 0);
		});
		it('moves the selection past group headers and wraps', () => {
			const rows = [{ header: 'A' }, { item: 1 }, { header: 'B' }, { item: 2 }];
			assert.equal(commandPalette.moveSelection(rows, -1, 1), 1);
			assert.equal(commandPalette.moveSelection(rows, 1, 1), 3);
			assert.equal(commandPalette.moveSelection(rows, 3, 1), 1);
			assert.equal(commandPalette.moveSelection(rows, 1, -1), 3);
			assert.equal(commandPalette.moveSelection([], 0, 1), -1);
			assert.equal(commandPalette.moveSelection([{ header: 'x' }], 0, 1), -1);
		});
	});

	describe('frecency storage', () => {
		afterEach(() => { delete global.localStorage; });
		it('reads what was saved and survives a throwing or corrupt store', () => {
			const store = {};
			global.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } };
			commandPalette.saveFrecency({ a: { n: 1, t: 2 } });
			assert.deepEqual(commandPalette.loadFrecency(), { a: { n: 1, t: 2 } });
			store[commandPalette.STORAGE_KEY] = '{oops';
			assert.deepEqual(commandPalette.loadFrecency(), {});
			store[commandPalette.STORAGE_KEY] = '[1]';
			assert.deepEqual(commandPalette.loadFrecency(), {});
			global.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
			assert.deepEqual(commandPalette.loadFrecency(), {});
			commandPalette.saveFrecency({ a: 1 });	// must not throw
		});
		it('works without localStorage at all', () => {
			assert.deepEqual(commandPalette.loadFrecency(), {});
			commandPalette.saveFrecency({});
		});
	});
});
