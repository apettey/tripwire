const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { include } = require('../helpers/helpers');
include('app/js/fork/map-legend-entries');
include('app/js/fork/map-legend');

describe('Map key (forkLegend)', () => {
	const root = path.join(__dirname, '..', '..', '..');
	const sources = fs.readdirSync(path.join(root, 'app/js/fork')).filter(f => f.endsWith('.js'))
		.map(f => ({ file: f, text: fs.readFileSync(path.join(root, 'app/js/fork', f), 'utf8') }));

	// Settings rows in the Map Markers section: the `section` and `id` near the start of each forkSettings.register call
	const markerRows = [];
	const allRows = new Set();
	sources.forEach(s => s.text.split('forkSettings.register(').slice(1).forEach(chunk => {
		const head = chunk.slice(0, 600);
		const section = head.match(/\bsection:\s*"([A-Za-z]+)"/);
		const id = head.match(/\bid:\s*"([A-Za-z0-9_-]+)"/);
		if (id) { allRows.add(id[1]); }
		if (section && id && section[1] === 'markers') { markerRows.push(id[1]); }
	}));
	// Legend entries' settingId: the built-in entries (mapLegendEntries) and the forkLegend.register calls in the features'
	// own files, comments stripped (the doc comment's example must not count)
	const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');
	const legendSettingIds = new Set(mapLegendEntries.filter(e => e.settingId).map(e => e.settingId));
	sources.filter(s => s.file !== 'map-legend-entries.js').forEach(s => stripComments(s.text).split('forkLegend.register(').slice(1).forEach(chunk => {
		const m = chunk.split('});')[0].match(/\bsettingId:\s*"([A-Za-z0-9_-]+)"/);
		if (m) { legendSettingIds.add(m[1]); }
	}));

	it('the scans found the rows (guards the scanning itself)', () => {
		assert.ok(markerRows.includes('sizeTags-enabled') && markerRows.includes('killReporting-marker'), markerRows.join(','));
		assert.ok(legendSettingIds.has('sizeTags-enabled'));
		assert.ok(!legendSettingIds.has('myFeature-enabled'), 'the doc comment example must not count as an entry');
		assert.strictEqual(stripComments('a // settingId: "x"\nb /* settingId: "y" */ c'), 'a \nb  c');
	});

	it('every Map Markers Settings row has a legend entry (or a waiver)', () => {
		const missing = markerRows.filter(id => !legendSettingIds.has(id) && !forkLegend.WAIVERS[id]);
		assert.deepStrictEqual(missing, [], 'add a forkLegend.register({settingId: ...}) entry for these rows, or a line in forkLegend.WAIVERS');
	});

	it('waivers name real Map Markers rows and say why', () => {
		Object.keys(forkLegend.WAIVERS).forEach(id => {
			assert.ok(markerRows.includes(id), 'waiver for unknown row ' + id);
			assert.ok(typeof forkLegend.WAIVERS[id] === 'string' && forkLegend.WAIVERS[id].length > 5, id);
		});
	});

	it('every settingId names a registered Settings row', () => {
		[...legendSettingIds].forEach(id => assert.ok(allRows.has(id), 'settingId ' + id + ' is not a forkSettings.register id'));
	});

	it('the built-in entries are valid, with unique ids', () => {
		forkLegend.entries = []; forkLegend.seq = 0;
		mapLegendEntries.forEach(e => forkLegend.register(e));
		assert.strictEqual(forkLegend.entries.length, mapLegendEntries.length);
		assert.strictEqual(new Set(mapLegendEntries.map(e => e.id)).size, mapLegendEntries.length);
		mapLegendEntries.forEach(e => {
			assert.ok(!/[<>]/.test(e.title + e.text), e.id + ': title and text are plain text');
			assert.ok(e.text.length < 220, e.id + ': keep it to one line');
		});
	});

	describe('register', () => {
		beforeEach(() => { forkLegend.entries = []; forkLegend.seq = 0; });
		const ok = { id: 'x', group: 'systems', title: 'X', text: 'An x.', sample: '<b>x</b>' };
		it('rejects a missing field or an unknown group', () => {
			assert.throws(() => forkLegend.register(Object.assign({}, ok, { id: '' })));
			assert.throws(() => forkLegend.register(Object.assign({}, ok, { group: 'nope' })));
			assert.throws(() => forkLegend.register(Object.assign({}, ok, { text: '' })));
			assert.throws(() => forkLegend.register(Object.assign({}, ok, { sample: 3 })));
			assert.throws(() => forkLegend.register(Object.assign({}, ok, { enabled: true })));
		});
		it('ignores a second entry with the same id', () => {
			const warn = console.warn; console.warn = () => {};
			try {
				forkLegend.register(ok);
				forkLegend.register(Object.assign({}, ok, { title: 'Other' }));
			} finally { console.warn = warn; }
			assert.strictEqual(forkLegend.entries.length, 1);
			assert.strictEqual(forkLegend.entries[0].title, 'X');
		});
	});

	describe('on/off, where and visible', () => {
		const items = [
			{ id: 'a-enabled', section: 'markers', type: 'checkbox', label: 'Thing A:', get: o => !(o && o.a === false) },
			{ id: 'b', section: 'intel', type: 'custom', label: 'Thing B:' }
		];
		const titles = { markers: 'Map Markers', intel: 'Kills & Intel' };
		const title = k => titles[k];
		const entries = [
			{ id: 'a', group: 'systemMarks', order: 2, seq: 0, settingId: 'a-enabled' },
			{ id: 'b', group: 'systemMarks', order: 1, seq: 1, settingId: 'b', enabled: o => !!(o && o.b) },
			{ id: 'c', group: 'systems', order: 1, seq: 2 },
			{ id: 'd', group: 'connections', order: 1, seq: 3, where: 'Somewhere else' }
		];
		it('a checkbox row decides; enabled() wins; nothing means on', () => {
			assert.strictEqual(forkLegend.isOn(entries[0], {}, items), true);
			assert.strictEqual(forkLegend.isOn(entries[0], { a: false }, items), false);
			assert.strictEqual(forkLegend.isOn(entries[1], {}, items), false);
			assert.strictEqual(forkLegend.isOn(entries[1], { b: 1 }, items), true);
			assert.strictEqual(forkLegend.isOn(entries[2], {}, items), true);
		});
		it('a broken check counts as on', () => {
			const err = console.error; console.error = () => {};
			try { assert.strictEqual(forkLegend.isOn({ id: 'z', enabled: () => { throw new Error('x'); } }, {}, items), true); }
			finally { console.error = err; }
		});
		it('where: Settings > section > row label, or the entry\'s own text', () => {
			assert.strictEqual(forkLegend.where(entries[0], items, title), 'Settings > Map Markers > Thing A');
			assert.strictEqual(forkLegend.where(entries[1], items, title), 'Settings > Kills & Intel > Thing B');
			assert.strictEqual(forkLegend.where(entries[2], items, title), '');
			assert.strictEqual(forkLegend.where(entries[3], items, title), 'Somewhere else');
		});
		it('lists the entries that are on, by group in GROUPS order, sorted; Show all lists every one', () => {
			const on = forkLegend.visible({ a: true }, items, false, entries);
			assert.deepStrictEqual(on.map(g => g.group.key), ['systems', 'connections', 'systemMarks']);
			assert.deepStrictEqual(on[2].rows.map(r => r.entry.id), ['a']);
			const all = forkLegend.visible({ a: false }, items, true, entries);
			assert.deepStrictEqual(all[2].rows.map(r => [r.entry.id, r.on]), [['b', false], ['a', false]]);
			assert.deepStrictEqual(forkLegend.visible({ a: false }, items, false, entries.slice(0, 2)), []);
		});
	});

	describe('copying the map\'s #chainMap rules for the samples', () => {
		it('splits selector lists at top-level commas only', () => {
			assert.deepStrictEqual(forkLegend.splitSelectors('a, b:is(.c, .d) e ,f'), ['a', 'b:is(.c, .d) e', 'f']);
		});
		it('keeps only the #chainMap parts, swapped for the sample root', () => {
			assert.strictEqual(forkLegend.scopeSelector('.critical, #chainMap .critical, #guide .critical'), '#map-key-map .critical');
			assert.strictEqual(forkLegend.scopeSelector('#chainMap div.node.loop'), '#map-key-map div.node.loop');
			assert.strictEqual(forkLegend.scopeSelector('#chainMap.home-region-hover .x'), '#map-key-map.home-region-hover .x');
			assert.strictEqual(forkLegend.scopeSelector('#chainMapX .a, #chainMap-y'), null);
			assert.strictEqual(forkLegend.scopeSelector('.temp.rally-route'), null);
		});
		it('builds the CSS from style sheets, keeping @media and skipping unreadable sheets', () => {
			const sheets = [
				{ cssRules: [
					{ selectorText: '#chainMap .a', style: { cssText: 'color: red;' } },
					{ selectorText: '.b', style: { cssText: 'color: blue;' } },
					{ media: { mediaText: '(prefers-reduced-motion: reduce)' }, cssRules: [{ selectorText: '#chainMap .c', style: { cssText: 'animation: none !important;' } }] }
				] },
				{ get cssRules() { throw new Error('SecurityError'); } }
			];
			assert.strictEqual(forkLegend.scopedCss(sheets),
				'#map-key-map .a { color: red; }\n@media (prefers-reduced-motion: reduce) { #map-key-map .c { animation: none !important; } }');
		});
	});

	describe('rowHtml', () => {
		const items = [{ id: 'a-enabled', section: 'markers', type: 'checkbox', label: 'Thing A:', get: () => true }];
		const row = (entry, on) => forkLegend.rowHtml({ entry: Object.assign({ id: 'a', title: 'A', text: 'An a.', sample: '' }, entry), on: on }, items);
		it('the Settings path gets Turn off / Off. Turn on', () => {
			const sectionTitle = forkLegend.sectionTitle;
			forkLegend.sectionTitle = () => 'Map Markers';
			try {
				assert.ok(row({ settingId: 'a-enabled' }, true).includes('Turn off: Settings &gt; Map Markers &gt; Thing A'));
				assert.ok(row({ settingId: 'a-enabled' }, false).includes('Off. Turn on: Settings &gt; Map Markers &gt; Thing A'));
			} finally { forkLegend.sectionTitle = sectionTitle; }
		});
		it('an entry\'s own where is shown as written, on or off', () => {
			const off = row({ where: 'Replaced by Life states when they are on' }, false);
			assert.ok(off.includes('>Replaced by Life states when they are on<') && !off.includes('Turn on'));
		});
	});

	describe('sample helpers', () => {
		it('node escapes plain-text fields', () => {
			const html = forkLegend.node({ name: '<x>', cls: 'loop' });
			assert.ok(html.includes("class='node loop'") && html.includes('&lt;x&gt;') && html.includes("data-nodeid='0'"));
		});
		it('a failing sample renders as empty', () => {
			const err = console.error; console.error = () => {};
			try { assert.strictEqual(forkLegend.sampleHtml({ id: 'z', sample: () => { throw new Error('x'); } }), ''); }
			finally { console.error = err; }
		});
	});

	it('enabled: on unless options.mapLegend.enabled is false', () => {
		assert.strictEqual(forkLegend.enabled(undefined), true);
		assert.strictEqual(forkLegend.enabled({}), true);
		assert.strictEqual(forkLegend.enabled({ mapLegend: { enabled: false } }), false);
	});
});
