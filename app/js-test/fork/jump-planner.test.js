const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/jump-range');
include('app/js/fork/jump-planner');

const DATA = loadJSON('public/jumprange/systems');
const SHIPS = loadJSON('public/jumprange/ships');
const COORDS = jumpRange.decode(DATA);
const INDEX = jumpRange.buildIndex(COORDS, 7);
const PRESETS = jumpRange.presets(SHIPS);
const S = appData.systems;
const sid = name => Number(Object.keys(S).find(k => S[k].name === name));
const AMAMAKE = sid('Amamake'), EC = sid('EC-P8R'), HEK = sid('Hek'), J152820 = sid('J152820');
const EVIL = '<img src=x onerror=alert(1)>"\'&';

function ctx(settings, extra) {
	return Object.assign({
		exitID: AMAMAKE, index: INDEX, systems: S, regions: appData.regions, map: appData.map.shortest,
		settings: jumpPlanner.settings({ jumpRange: settings || {} }), presets: PRESETS, jammed: {},
		gates: jumpRange.gateJumps(appData.map.shortest, AMAMAKE)
	}, extra || {});
}
function node(systemID, v) {
	return { c: [{ v: v || String(systemID), systemID: systemID, f: "<div id='node1' data-nodeid='" + systemID + "' class='node '><div class='nodeIcons'><div style='float: left;'></div></div><h4>x</h4></div>" }, { v: '' }] };
}
const noRawHtml = html => assert.ok(html.indexOf('<img') < 0 && html.indexOf('onerror=alert(1)>') < 0, html);

describe('jumpPlanner', () => {
	it('uses the data version of the generated files (cache busting)', () => {
		assert.strictEqual(jumpPlanner.DATA_VERSION, DATA.meta.version);
		assert.strictEqual(jumpPlanner.DATA_VERSION, SHIPS.meta.version);
	});

	describe('settings', () => {
		it('defaults: on, Carrier, JDC V, no cap, both targets, all exits, jammed marked, right, click opens, 10 LY, greyed, hubs', () => {
			const s = jumpPlanner.settings({});
			assert.deepStrictEqual(s, { enabled: true, ship: 'group-547', jdc: 5, cap: null, lowsec: true, nullsec: true, exits: 'all', jammed: 'mark',
				dock: 'right', clickOpen: true, mapRadius: 10, showOut: true, showHs: false, hubs: true, search: true, open: false });
			assert.strictEqual(jumpPlanner.settings({ jumpRange: { search: false } }).search, false);
			assert.strictEqual(jumpPlanner.enabled({}), true);
			assert.strictEqual(jumpPlanner.enabled({ jumpRange: { enabled: false } }), false);
		});
		it('checks values', () => {
			const s = jumpPlanner.settings({ jumpRange: { ship: '<x>', jdc: 9, cap: 'abc', exits: 'x', jammed: 'y', dock: 'top', mapRadius: 40, hubs: false, open: true } });
			assert.deepStrictEqual([s.ship, s.jdc, s.cap, s.exits, s.jammed, s.dock, s.mapRadius, s.hubs, s.open], ['group-547', 5, null, 'all', 'mark', 'right', 15, false, true]);
			assert.strictEqual(jumpPlanner.settings({ jumpRange: { cap: 5 } }).cap, 5);
			assert.strictEqual(jumpPlanner.settings({ jumpRange: { jdc: 0 } }).jdc, 0);
		});
		it('range with cap', () => {
			assert.deepStrictEqual([jumpPlanner.range(jumpPlanner.settings({}), PRESETS).range, jumpPlanner.range(jumpPlanner.settings({ jumpRange: { cap: 5 } }), PRESETS).range], [7, 5]);
			assert.strictEqual(jumpPlanner.range(jumpPlanner.settings({ jumpRange: { ship: 'group-902', jdc: 4 } }), PRESETS).range, 9);
		});
		it('formats security like the game', () => {
			assert.deepStrictEqual([0.449, 0.04, 0.0, -0.446, 0.95].map(jumpPlanner.secText), ['0.4', '0.1', '0.0', '-0.4', '1.0']);
		});
	});

	describe('chain exits and icons', () => {
		const result = { map: { rows: [node(J152820), node(AMAMAKE), node(HEK), node(EC), node(AMAMAKE, 'dup'), node(sid('Kino')), node(30100000),
			Object.assign(node(sid('Siseide'), 'dest-1'), { destination: true }), Object.assign(node(sid('Auga')), { pathHome: [{}, { path: [1] }] })] }, lines: [] };
		it('LS/NS k-space only, once each, no synthetic or calculated rows', () => {
			assert.deepStrictEqual(jumpPlanner.chainExits(result, S, 'all'), [AMAMAKE, EC]);
			assert.deepStrictEqual(jumpPlanner.chainExits(result, S, 'viewing', EC), [EC]);
			assert.deepStrictEqual(jumpPlanner.chainExits(result, S, 'viewing', HEK), []);
			assert.deepStrictEqual(jumpPlanner.chainExits(null, S, 'all'), []);
		});
		it('decorates only those nodes, once', () => {
			const copy = JSON.parse(JSON.stringify(result));
			jumpPlanner.decorate(copy, [AMAMAKE], S);
			jumpPlanner.decorate(copy, [AMAMAKE], S);
			const marked = copy.map.rows.filter(r => r.c[0].f.indexOf('jp-ring') >= 0).map(r => r.c[0].systemID);
			assert.deepStrictEqual(marked, [AMAMAKE, AMAMAKE]);
			assert.strictEqual(copy.map.rows[1].c[0].f.split('jp-ring').length, 2);
			assert.ok(copy.map.rows[1].c[0].f.indexOf("jp-ring") < copy.map.rows[1].c[0].f.indexOf("nodeIcons"));
		});
		it('escapes the icon title', () => {
			noRawHtml(jumpPlanner.ringHtml(30000001, EVIL));
		});
	});

	describe('model', () => {
		it('rows with region, gates and band; counts', () => {
			const m = jumpPlanner.model(ctx());
			assert.strictEqual(m.range, 7);
			assert.strictEqual(m.rows.length, 81);
			const auga = m.rows[0];
			assert.deepStrictEqual([auga.name, auga.region, auga.secText, auga.band, auga.gates], ['Auga', 'Heimatar', '0.4', 0, 1]);
			assert.deepStrictEqual(m.counts, { inRange: 81, jammed: 0 });
		});
		it('jammed: marked (blocked), hidden, or treated as in range; covert ships ignore jammers', () => {
			const jammed = {}; jammed[sid('Auga')] = { setBy: 'X', age: 60 };
			const mark = jumpPlanner.model(ctx({}, { jammed }));
			assert.deepStrictEqual([mark.counts.inRange, mark.counts.jammed, mark.rows[0].blocked], [80, 1, true]);
			const hide = jumpPlanner.model(ctx({ jammed: 'hide' }, { jammed }));
			assert.deepStrictEqual([hide.rows.length, hide.rows[0].name], [80, 'Olfeim']);
			const ignore = jumpPlanner.model(ctx({ jammed: 'ignore' }, { jammed }));
			assert.deepStrictEqual([ignore.counts.inRange, ignore.rows[0].jammed, ignore.rows[0].blocked], [81, true, false]);
			const bo = jumpPlanner.model(ctx({ ship: 'group-898' }, { jammed }));
			assert.deepStrictEqual([bo.covert, bo.rows[0].name, bo.rows[0].blocked, bo.rows[0].jammed], [true, 'Auga', false, true]);
		});
		it('sorts by any column, ties by distance', () => {
			const rows = [{ name: 'b', sec: 0.1, region: 'Z', ly: 2, gates: null }, { name: 'a', sec: -0.5, region: 'A', ly: 3, gates: 2 }, { name: 'c', sec: 0.3, region: 'A', ly: 1, gates: 5 }];
			assert.deepStrictEqual(jumpPlanner.sortRows(rows, 'ly', 1).map(r => r.name), ['c', 'b', 'a']);
			assert.deepStrictEqual(jumpPlanner.sortRows(rows, 'name', -1).map(r => r.name), ['c', 'b', 'a']);
			assert.deepStrictEqual(jumpPlanner.sortRows(rows, 'region', 1).map(r => r.name), ['c', 'a', 'b']);
			assert.deepStrictEqual(jumpPlanner.sortRows(rows, 'gates', 1).map(r => r.name), ['a', 'c', 'b']);
			assert.deepStrictEqual(jumpPlanner.sortRows(rows, 'sec', 1).map(r => r.name), ['a', 'b', 'c']);
		});
	});

	describe('mini-map', () => {
		const c = ctx();
		const m = jumpPlanner.model(c);
		const map = jumpPlanner.mapModel(c, m);
		it('centres the exit, draws rings for the bands and the range', () => {
			const exit = map.points.find(p => p.kind === 'exit');
			assert.deepStrictEqual([exit.x, exit.y], [jumpPlanner.MAP_W / 2, jumpPlanner.MAP_H / 2]);
			assert.deepStrictEqual(map.rings.map(r => r.ly), [3.5, 5, 7]);
		});
		it('north is up and east is right (x right, z up)', () => {
			const exit = COORDS.pos[AMAMAKE];
			map.points.filter(p => p.kind !== 'exit').slice(0, 20).forEach(p => {
				const q = COORDS.pos[p.id];
				assert.strictEqual(Math.sign(Math.round(p.x - map.cx)), Math.sign(Math.round((q.x - exit.x) * map.scale)));
				assert.strictEqual(Math.sign(Math.round(map.cy - p.y)), Math.sign(Math.round((q.z - exit.z) * map.scale)));
			});
		});
		it('in-range points match the list; no high-sec by default; nothing beyond the radius', () => {
			assert.strictEqual(map.points.filter(p => p.kind === 'in').length, 81);
			assert.strictEqual(map.points.filter(p => p.kind === 'hs').length, 0);
			assert.ok(map.points.every(p => p.ly <= 10 + 1e-9));
			assert.ok(map.lines.length > 0);
		});
		it('high-sec only with its setting: inside the range ring, without gate lines', () => {
			const c2 = ctx({ showHs: true });
			const hs = jumpPlanner.mapModel(c2, jumpPlanner.model(c2));
			const dots = hs.points.filter(p => p.kind === 'hs');
			assert.ok(dots.length > 0);
			assert.ok(dots.every(p => p.ly <= 7 + 1e-9));
			const at = {}; dots.forEach(p => { at[p.x + ',' + p.y] = true; });
			assert.ok(hs.lines.every(l => !at[l[0] + ',' + l[1]] && !at[l[2] + ',' + l[3]]));
			assert.strictEqual(hs.lines.length, map.lines.length);
		});
		it('the whole range fits when it is larger than the mini-map radius', () => {
			const c2 = ctx({ ship: 'group-902', mapRadius: 7 });	// jump freighter, 10 LY
			const m2 = jumpPlanner.mapModel(c2, jumpPlanner.model(c2));
			const outer = m2.rings[m2.rings.length - 1];
			assert.strictEqual(outer.ly, 10);
			assert.ok(outer.r <= jumpPlanner.MAP_H / 2 - 6);
			assert.ok(m2.points.every(p => p.y >= 0 && p.y <= jumpPlanner.MAP_H));
		});
		it('"Cyno-jammed: Hide" leaves jammed systems off the map and out of the out-of-range count', () => {
			const auga = sid('Auga');
			const jammed = {}; jammed[auga] = { setBy: 'X', age: 1 };
			const c2 = ctx({ jammed: 'hide' }, { jammed });
			const m2 = jumpPlanner.mapModel(c2, jumpPlanner.model(c2));
			assert.ok(!m2.points.some(p => p.id === auga));
			assert.strictEqual(m2.outShown, map.outShown);
			const c3 = ctx({}, { jammed });
			assert.strictEqual(jumpPlanner.mapModel(c3, jumpPlanner.model(c3)).points.find(p => p.id === auga).kind, 'jammed');
		});
		it('out-of-range systems only when switched on', () => {
			const off = jumpPlanner.mapModel(ctx({ showOut: false }), m);
			assert.strictEqual(off.points.filter(p => p.kind === 'out').length, 0);
			assert.ok(map.outShown > 0);
		});
		it('labels don\'t overlap, the exit is always labelled, at most LABELS nearest', () => {
			const labels = jumpPlanner.placeLabels(map, [sid('Bosboger')]);
			assert.strictEqual(labels[0].id, AMAMAKE);
			assert.ok(labels.some(l => l.id === sid('Bosboger')));
			assert.ok(labels.filter(l => l.cls === 'jp-l-in').length <= jumpPlanner.LABELS);
		});
		it('escapes names in the SVG', () => {
			const evil = { cx: 10, cy: 10, scale: 1, rings: [], lines: [], points: [{ id: 30000001, x: 50, y: 50, kind: 'in', band: 0, name: EVIL, ly: 1 }] };
			const svg = jumpPlanner.mapSvg(evil, jumpPlanner.placeLabels(evil), []);
			noRawHtml(svg);
			assert.ok(svg.indexOf('&lt;img') >= 0);
		});
	});

	describe('HTML builders escape everything', () => {
		const row = { id: 30000001, name: EVIL, sec: 0.3, secText: '0.3', region: EVIL, ly: 2, band: 0, gates: 1, jammed: true, blocked: false, jam: null };
		it('list', () => {
			const html = jumpPlanner.listHtml([row, Object.assign({}, row, { blocked: true })], { key: 'ly', dir: 1 }, jumpPlanner.settings({}), false);
			noRawHtml(html);
			assert.ok(/class='jp-dest'/.test(html) && /jp-jammed-text/.test(html));
		});
		it('empty list', () => {
			assert.ok(/No low-sec systems in range/.test(jumpPlanner.listHtml([], { key: 'ly', dir: 1 }, jumpPlanner.settings({ jumpRange: { nullsec: false } }))));
		});
		it('tooltip, including who marked a system jammed', () => {
			const html = jumpPlanner.tooltipHtml({ id: 1, name: EVIL, sec: 0.3, region: EVIL, ly: 2, band: 0, gates: 3, kind: 'in', jam: { setBy: EVIL, age: 7200 }, canMark: true });
			noRawHtml(html);
			assert.ok(/Set destination/.test(html) && /Unmark jammed/.test(html) && /2 h ago/.test(html));
			const hs = jumpPlanner.tooltipHtml({ id: 1, name: 'Hek', sec: 0.8, region: 'Metropolis', ly: 2, band: null, gates: null, kind: 'hs', jam: null, canMark: false });
			assert.ok(!/Set destination|Mark jammed/.test(hs) && /no cyno/.test(hs) && /no gate route/.test(hs));
		});
		it('header and tabs', () => {
			const presets = [{ key: 'group-1', label: EVIL, ships: [EVIL], baseLy: 3, covert: false }];
			noRawHtml(jumpPlanner.headerHtml(presets, jumpPlanner.settings({ jumpRange: { ship: 'group-1' } })));
			noRawHtml(jumpPlanner.tabsHtml([1, 2], 1, () => EVIL, { 1: 3 }));
			assert.ok(/7.0 LY/.test(jumpPlanner.headerHtml(PRESETS, jumpPlanner.settings({}))));
			assert.ok(/class='active'[^>]*>V</.test(jumpPlanner.headerHtml(PRESETS, jumpPlanner.settings({}))));
		});
		it('trade hubs', () => {
			const one = { jumps: 1, direct: 4.2, via: [] };
			const two = { jumps: 2, direct: 10.9, via: [{ id: 2, ly1: 5.8, ly2: 5.6 }, { id: 3, ly1: 6, ly2: 6 }] };
			const html = jumpPlanner.hubsHtml([{ hubID: 1, to: two, back: { systemID: 2, gates: 3, reach: one } }, { hubID: 4, to: { jumps: null, direct: 11.9, via: [] }, back: null }], EVIL, () => EVIL);
			noRawHtml(html);
			assert.ok(/2 jumps/.test(html) && /1 other midpoint\)/.test(html) && /not within 2 jumps/.test(html) && /3 gates to/.test(html));
		});
		it('hub reach to a jammed exit (normal cyno) says so', () => {
			const jammed = {}; jammed[AMAMAKE] = true;
			const to = jumpRange.reach(jumpRange.AMARR, AMAMAKE, 7, INDEX, S, { jammed }, 2);
			assert.strictEqual(to.reason, 'target');
			const html = jumpPlanner.hubsHtml([{ hubID: jumpRange.AMARR, to: to, back: null }], 'Amamake', id => S[id].name);
			assert.ok(/exit is cyno-jammed \(normal cyno\)/.test(html) && !/not within 2 jumps/.test(html));
		});
		it('settings ship list: placeholder until ships.json is there', () => {
			assert.ok(/Loading ships/.test(jumpPlanner.shipOptionsHtml(null)));
			assert.ok(/Carrier \(3.5 LY base\)/.test(jumpPlanner.shipOptionsHtml(PRESETS)));
			assert.ok(/Loading ships/.test(jumpPlanner.settingsHtml(null)) && /jumpPlanner-showHs/.test(jumpPlanner.settingsHtml(null)));
		});
		it('settings section', () => {
			noRawHtml(jumpPlanner.settingsHtml([{ key: 'group-1', label: EVIL, ships: [EVIL], baseLy: 3 }]));
		});
		it('settings: the System search row in the section, the on/off row for General Preferences', () => {
			const html = jumpPlanner.settingsHtml(PRESETS);
			assert.ok(/System search:/.test(html) && /name='jumpPlanner-search' value='1'/.test(html) && /name='jumpPlanner-search' value='0'/.test(html));
			assert.ok(/name='jumpPlanner-enabled' value='1'/.test(html));
			const general = jumpPlanner.generalRowHtml();
			assert.ok(/^<tr><th>Jump planner:<\/th>/.test(general) && /type='checkbox' id='jumpPlanner-enabled-general'/.test(general));
		});
	});

	describe('trade-hub reach for real', () => {
		it('Amarr reaches Amamake in 2 jumps with a Carrier at JDC V, Jita doesn\'t', () => {
			const amarr = jumpRange.reach(jumpRange.AMARR, AMAMAKE, 7, INDEX, S, {}, 2);
			const jita = jumpRange.reach(jumpRange.JITA, AMAMAKE, 7, INDEX, S, {}, 2);
			assert.deepStrictEqual([amarr.jumps, jita.jumps], [2, null]);
		});
	});

	describe('footer, copy, placement', () => {
		it('footer', () => {
			assert.strictEqual(jumpPlanner.footerText({ counts: { inRange: 18, jammed: 1 } }, 4, true), '18 in range · 1 jammed · 4 out of range shown');
			assert.strictEqual(jumpPlanner.footerText({ counts: { inRange: 2, jammed: 0 } }, 4, false), '2 in range');
		});
		it('copy list is plain text', () => {
			const text = jumpPlanner.copyText([{ name: 'Auga', secText: '0.4', region: 'Heimatar', ly: 0.4312, gates: 1, jammed: false }, { name: 'Vard', secText: '0.4', region: 'Heimatar', ly: 0.8, gates: null, jammed: true }], 'Amamake', 'Carrier', 5, 7);
			assert.strictEqual(text, 'Jump range from Amamake (Carrier, JDC V, 7.0 LY)\nAuga\t0.4\tHeimatar\t0.43 LY\t1 gates\nVard\t0.4\tHeimatar\t0.80 LY\t-\tjammed');
		});
		it('default placement: free spot against the right edge, else under everything; left: top left', () => {
			const widgets = [{ col: 1, row: 1, size_x: 7, size_y: 6 }, { col: 8, row: 1, size_x: 21, size_y: 6 }, { col: 1, row: 7, size_x: 21, size_y: 8 }];
			assert.deepStrictEqual(jumpPlanner.defaultPlacement(widgets, 32, 'right'), { col: 25, row: 7, size_x: 8, size_y: 12 });
			assert.deepStrictEqual(jumpPlanner.defaultPlacement(widgets, 40, 'right'), { col: 33, row: 1, size_x: 8, size_y: 12 });
			assert.deepStrictEqual(jumpPlanner.defaultPlacement([{ col: 1, row: 1, size_x: 30, size_y: 20 }], 30, 'right'), { col: 23, row: 21, size_x: 8, size_y: 12 });
			assert.deepStrictEqual(jumpPlanner.defaultPlacement(widgets, 32, 'left'), { col: 1, row: 1, size_x: 8, size_y: 12 });
		});
		it('saved placement', () => {
			assert.deepStrictEqual(jumpPlanner.savedPlacement({ col: 3, row: 4, size_x: 2, size_y: 20 }), { col: 3, row: 4, size_x: 6, size_y: 20 });
			assert.strictEqual(jumpPlanner.savedPlacement({ col: 0, row: 1 }), null);
			assert.deepStrictEqual(jumpPlanner.gridEntry([{ id: 'x' }, { id: jumpPlanner.WIDGET_ID, col: 1 }], jumpPlanner.WIDGET_ID), { id: jumpPlanner.WIDGET_ID, col: 1 });
		});
		it('Reset drops the panel from the layout (array, object and old oog forms)', () => {
			const id = jumpPlanner.WIDGET_ID;
			const arr = [{ id: 'chainWidget', col: 1 }, { id: id, col: 25 }];
			assert.deepStrictEqual(jumpPlanner.withoutGridEntry(arr, id), [{ id: 'chainWidget', col: 1 }]);
			assert.strictEqual(arr.length, 2);
			assert.deepStrictEqual(jumpPlanner.withoutGridEntry({ 0: { id: 'a' }, 1: { id: id } }, id), { 0: { id: 'a' } });
			assert.deepStrictEqual(jumpPlanner.withoutGridEntry({ oog: { 0: { id: id }, 1: { id: 'b' } } }, id), { oog: { 1: { id: 'b' } } });
			assert.strictEqual(jumpPlanner.gridEntry(jumpPlanner.withoutGridEntry(arr, id), id), null);
			assert.strictEqual(jumpPlanner.withoutGridEntry(null, id), null);
		});
		it('age text', () => {
			assert.deepStrictEqual([30, 600, 7200, 200000].map(jumpPlanner.ageText), ['now', '10 min', '2 h', '2 d']);
		});
	});

	describe('system search', () => {
		const sort = { key: 'ly', dir: 1 };
		const status = (name, settings, extra) => {
			const c = ctx(settings, extra);
			const m = jumpPlanner.model(c);
			return jumpPlanner.searchStatus(sid(name), c, m, jumpPlanner.sortRows(m.rows, sort.key, sort.dir));
		};
		it('prefix before substring, case-insensitive, ignoring dashes and spaces, limited', () => {
			const names = (q, limit) => jumpPlanner.searchSystems(q, S, limit).map(id => S[id].name);
			const bos = names('BOS');
			assert.ok(bos.length > 0 && bos.every(n => n.toLowerCase().indexOf('bos') >= 0));
			const firstSub = bos.findIndex(n => n.toLowerCase().indexOf('bos') > 0);
			assert.ok(firstSub < 0 || bos.slice(firstSub).every(n => n.toLowerCase().indexOf('bos') > 0), bos.join());
			assert.ok(bos.indexOf('Bosboger') >= 0 && bos.indexOf('Bosboger') < (firstSub < 0 ? Infinity : firstSub));
			assert.strictEqual(names('0sht-a')[0], '0SHT-A');
			assert.strictEqual(names('0 sht a')[0], '0SHT-A');
			assert.strictEqual(names('1pwgb')[0], '1P-WGB');
			assert.strictEqual(names('jita')[0], 'Jita');
			assert.strictEqual(names('a').length, jumpPlanner.SEARCH_LIMIT);
			assert.strictEqual(names('a', 3).length, 3);
			assert.deepStrictEqual([names(''), names('  '), names('-'), jumpPlanner.searchSystems('x', null)], [[], [], [], []]);
		});
		it('exact name first, then shorter names', () => {
			const sys = { 1: { name: 'Amamake' }, 2: { name: 'Ama' }, 3: { name: 'Xama' }, 4: { name: 'Amarr' } };
			assert.deepStrictEqual(jumpPlanner.searchSystems('ama', sys), [2, 4, 1, 3]);
		});
		it('in the list: rank in the current sort', () => {
			const r = status('Auga');
			assert.deepStrictEqual([r.status, r.rank, r.total], ['listed', 1, 81]);
			const c = ctx(); const m = jumpPlanner.model(c);
			const byName = jumpPlanner.sortRows(m.rows, 'name', -1);
			const r2 = jumpPlanner.searchStatus(sid('Auga'), c, m, byName);
			assert.strictEqual(r2.rank, byName.findIndex(x => x.name === 'Auga') + 1);
			assert.ok(/#\d+ of 81 by System \(reversed\)/.test(jumpPlanner.searchResultHtml(r2, { key: 'name', dir: -1 })));
			assert.ok(/Auga<\/span> — <span class='jp-search-ok'>#1 of 81 by LY/.test(jumpPlanner.searchResultHtml(r, sort)));
			assert.strictEqual(status('Amamake').status, 'exit');
		});
		it('why not listed: high-sec, W-space, Pochven, Zarzakh', () => {
			const hs = status('Jita');
			assert.strictEqual(hs.status, 'hs');
			assert.ok(/high-sec, can&#39;t light a cyno/.test(jumpPlanner.searchResultHtml(hs, sort)) && /\(\d+\.\d LY\)/.test(jumpPlanner.searchResultHtml(hs, sort)));
			assert.strictEqual(status('J152820').status, 'wh');
			assert.ok(/wormhole space/.test(jumpPlanner.searchResultHtml(status('J152820'), sort)));
			assert.strictEqual(status('Kino').status, 'pochven');
			assert.ok(/Pochven/.test(jumpPlanner.searchResultHtml(status('Kino'), sort)));
			const c = ctx(); const m = jumpPlanner.model(c);
			const z = jumpPlanner.searchStatus(jumpRange.ZARZAKH, c, m, m.rows);
			assert.strictEqual(z.status, 'zarzakh');
			assert.ok(/Zarzakh/.test(jumpPlanner.searchResultHtml(z, sort)));
			assert.strictEqual(jumpPlanner.searchStatus(123, c, m, m.rows).status, 'unknown');
		});
		it('why not listed: out of range, with the distance and the range', () => {
			const c = ctx(); const m = jumpPlanner.model(c);
			const far = jumpRange.within(INDEX, INDEX.pos[AMAMAKE], 12).filter(h => h.ly > 8 && jumpRange.isValidCynoTarget(h.id, S[h.id], {}))[0];
			const r = jumpPlanner.searchStatus(far.id, c, m, m.rows);
			assert.strictEqual(r.status, 'range');
			assert.ok(new RegExp('out of range: ' + far.ly.toFixed(1) + ' LY <span class=\'jp-dim\'>\\(range 7.0\\)').test(jumpPlanner.searchResultHtml(r, sort)));
		});
		it('why not listed: jammed and hidden; low-sec or null-sec targets off', () => {
			const jammed = {}; jammed[sid('Auga')] = { setBy: 'X', age: 60 };
			const hidden = status('Auga', { jammed: 'hide' }, { jammed });
			assert.strictEqual(hidden.status, 'jammed');
			assert.ok(/cyno-jammed \(hidden by your setting\)/.test(jumpPlanner.searchResultHtml(hidden, sort)));
			const marked = status('Auga', {}, { jammed });
			assert.deepStrictEqual([marked.status, marked.row.blocked], ['listed', true]);
			assert.ok(/cyno-jammed, no normal cyno/.test(jumpPlanner.searchResultHtml(marked, sort)));
			const ls = status('Auga', { lowsec: false });
			assert.strictEqual(ls.status, 'lowsec');
			assert.ok(/low-sec, but Low-sec targets are off in Settings/.test(jumpPlanner.searchResultHtml(ls, sort)));
			const ecCtx = s => ctx(s, { exitID: EC, gates: jumpRange.gateJumps(appData.map.shortest, EC) });
			const nsIn = jumpPlanner.model(ecCtx({})).rows.filter(r => r.sec <= 0)[0];
			const offCtx = ecCtx({ nullsec: false }); const offModel = jumpPlanner.model(offCtx);
			const nsOff = jumpPlanner.searchStatus(nsIn.id, offCtx, offModel, offModel.rows);
			assert.strictEqual(nsOff.status, 'nullsec');
			assert.ok(/null-sec, but Null-sec targets are off in Settings/.test(jumpPlanner.searchResultHtml(nsOff, sort)));
		});
		it('escapes the system name in the result and the suggestions', () => {
			const sys = {}; sys[30000001] = { name: EVIL, security: 0.3, regionID: 1 };
			noRawHtml(jumpPlanner.searchResultHtml({ id: 30000001, name: EVIL, status: 'range', ly: 9.4, range: 8, total: 0 }, sort));
			noRawHtml(jumpPlanner.searchResultHtml({ id: 30000001, name: EVIL, status: 'listed', rank: 1, total: 1, ly: 1, range: 8, row: {} }, sort));
			const menu = jumpPlanner.searchMenuHtml([30000001], 0, sys, { 1: { name: EVIL } });
			noRawHtml(menu);
			assert.ok(/class='active'/.test(menu) && /data-jp-find='30000001'/.test(menu));
			// The query itself never goes into HTML: matching on it is safe
			assert.deepStrictEqual(jumpPlanner.searchSystems(EVIL, S), []);
		});
		it('found ring on the mini-map only when the system is drawn; its label is forced on', () => {
			const c = ctx(); const m = jumpPlanner.model(c); const mm = jumpPlanner.mapModel(c, m);
			const auga = sid('Auga');
			assert.ok(/jp-found-ring/.test(jumpPlanner.mapSvg(mm, [], [auga], auga)));
			assert.ok(!/jp-found-ring/.test(jumpPlanner.mapSvg(mm, [], [], sid('Jita'))));
			assert.ok(jumpPlanner.placeLabels(mm, [auga]).some(l => l.id === auga && l.cls === 'jp-l-focus'));
		});
	});
});
