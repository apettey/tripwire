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
				dock: 'right', clickOpen: true, mapRadius: 10, showOut: true, showHs: false, hubs: true, search: true, fuel: true, hull: null, fuelSkills: { 21610: 5 }, open: false, mode: 'exit', origin: null,
				prefer: 'jumps', preferStations: true, avoidKills: true, avoidIncursions: true, avoid: [] });
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
		it('settings: the System search row in the section, the on/off row for Routes & Navigation', () => {
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
			assert.ok(/#\d+ of 81 listed, by System \(reversed\)/.test(jumpPlanner.searchResultHtml(r2, { key: 'name', dir: -1 })));
			assert.ok(/Auga<\/span> — <span class='jp-search-ok'>#1 of 81 listed, by LY/.test(jumpPlanner.searchResultHtml(r, sort)));
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
			// The total is the rows listed (jammed ones too), worded so it doesn't read as the footer's "in range"
			const c = ctx({}, { jammed }); const m = jumpPlanner.model(c);
			assert.deepStrictEqual([m.counts.inRange, marked.total], [80, 81]);
			assert.ok(/#1 of 81 listed, by LY · cyno-jammed/.test(jumpPlanner.searchResultHtml(marked, sort)));
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
		it('just beyond the range: two decimals, so it does not read "8.0 LY (range 8.0)"', () => {
			assert.strictEqual(jumpPlanner.beyondText(8.03, 8), '8.03 LY');
			assert.strictEqual(jumpPlanner.beyondText(8.049, 8), '8.05 LY');
			assert.strictEqual(jumpPlanner.beyondText(8.06, 8), '8.1 LY');
			assert.strictEqual(jumpPlanner.beyondText(9.34, 8), '9.3 LY');
			assert.strictEqual(jumpPlanner.beyondText(8.004, 8), '8.004 LY');
			const html = jumpPlanner.searchResultHtml({ id: 1, name: 'X', status: 'range', ly: 8.03, range: 8, total: 0 }, sort);
			assert.ok(/out of range: 8.03 LY <span class='jp-dim'>\(range 8.0\)/.test(html), html);
		});
		it('scrolls the picked row to the middle of the list, below the sticky header (layout px)', () => {
			// row 40 px into the table, 18 high; header 20; box 160 -> visible 140, centred: 40 - 20 - (140 - 18) / 2 = -41 -> 0
			assert.strictEqual(jumpPlanner.centerScrollTop(40, 18, 20, 160), 0);
			assert.strictEqual(jumpPlanner.centerScrollTop(2000, 18, 20, 160), 2000 - 20 - 61);
			assert.strictEqual(jumpPlanner.centerScrollTop(500, 18, 20, 10), 480);
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

	describe('Get home', () => {
		const KBP = sid('KBP7-G'), EY = sid('E-YCML'), C3 = sid('J160650'), EGG = sid('Egghelende');
		const row = (systemID, v, parent, pathHome) => ({ c: [{ v: v, systemID: systemID, f: '<div></div>' }, { v: parent }], pathHome: pathHome });
		const hop = (systemID, name, sig, type) => ({ systemID: systemID, name: name, signatureID: sig, type: type });
		const chainResult = () => ({
			map: { rows: [
				row(J152820, '1', null),
				row(C3, '2', '1', [hop(C3, '', 'ccc333', 'K162')]),
				row(EY, '3', '2', [hop(C3, '', 'ccc333', 'K162'), hop(EY, 'N2', 'ddd444', 'K162')]),
				row(KBP, '4', '1', [hop(KBP, 'N1', 'aaa111', 'K162')]),
				row(KBP, '6', '2', [hop(C3, '', 'ccc333', 'K162'), hop(KBP, 'X', 'xxx999', 'K162')]),
				row(EGG, '5', '1', [hop(EGG, 'L1', 'bbb222', 'K162')]),
				row(AMAMAKE, '7', '5', [hop(EGG, 'L1', 'bbb222', 'K162'), { systemID: AMAMAKE, path: [1, 2] }]),
				Object.assign(row(HEK, 'dest-1', '5', []), { destination: true })
			] },
			lines: [['2', '1', ['eol'], 11], ['3', '2', ['critical', 'eol-chain'], 12], ['4', '1', [], 13], ['6', '2', ['destab'], 14], ['5', '1', [], 15]]
		});

		it('homePaths: the root is home; holes counted back to it, fewest when a system is on the chain twice; calculated rows left out', () => {
			const hp = jumpPlanner.homePaths(chainResult());
			assert.deepStrictEqual(hp.homes, [J152820]);
			assert.strictEqual(hp.paths[J152820].holes.length, 0);
			assert.strictEqual(hp.paths[EY].holes.length, 2);
			assert.strictEqual(hp.paths[KBP].holes.length, 1);
			assert.strictEqual(hp.paths[KBP].holes[0].name, 'N1');
			assert.ok(!hp.paths[AMAMAKE] && !hp.paths[HEK]);
			const ey = hp.paths[EY].holes;
			assert.deepStrictEqual(ey.map(h => [h.wormholeID, h.from, h.to, h.eol, h.mass]), [[12, C3, EY, false, 'critical'], [11, J152820, C3, true, null]]);
			assert.strictEqual(hp.paths[EY].home, J152820);
		});
		it('homePaths: several roots, each its own home; nothing for no chain', () => {
			const r = chainResult();
			r.map.rows.push(row(HEK, '9', ''), row(EC, '10', '9', [hop(EC, 'Z', 'zzz000', 'K162')]));
			const hp = jumpPlanner.homePaths(r);
			assert.deepStrictEqual(hp.homes, [J152820, HEK]);
			assert.strictEqual(hp.paths[EC].home, HEK);
			assert.deepStrictEqual(jumpPlanner.homePaths(null), { homes: [], paths: {} });
			assert.deepStrictEqual(jumpPlanner.homePaths({ map: { rows: [row(EY, '3', '2', [])] } }).paths, {});	// parent missing
		});
		it('hole labels: name, else signature, plus the real type', () => {
			assert.strictEqual(jumpPlanner.holeLabel({ name: 'N2', realType: 'K346' }), 'N2 K346');
			assert.strictEqual(jumpPlanner.holeLabel({ name: '', signatureID: 'abc123', realType: 'K162' }), 'ABC');
			assert.strictEqual(jumpPlanner.holeLabel({}), '?');
		});
		it('warnings: too small (known / likely), unknown size, EOL, mass, preserve; supers once', () => {
			const holes = [
				{ name: 'A', size: 'L', certain: true, eol: true }, { name: 'B', size: 'XL', certain: true, mass: 'critical' },
				{ name: 'C', size: 'M', certain: false, mass: 'destab' }, { name: 'D', size: null, preserve: true }
			];
			const w = jumpPlanner.holeWarnings(holes, 'XL', 'Dreadnought').map(x => x.level + ':' + x.text);
			assert.deepStrictEqual(w, ['warn:hole too small for Dreadnought: A (L)', 'warn:EOL: A', 'warn:mass critical: B',
				'warn:hole likely too small for Dreadnought: C (M?)', 'note:destab: C', 'note:preserve mass: D', 'note:size unknown: D']);
			assert.deepStrictEqual(jumpPlanner.holeWarnings([{ name: 'A', size: 'L', certain: true }], 'L', 'Black Ops'), []);
			const sup = jumpPlanner.holeWarnings([{ name: 'A', size: 'XL', certain: true }, { name: 'B' }], 'none', 'Titan');
			assert.deepStrictEqual(sup.map(x => x.text), ['Titan can\'t go through wormholes']);
		});
		it('homeModel: routes from the start, ranked, with holes and warnings; Dest is the first cyno', () => {
			const hp = jumpPlanner.homePaths(chainResult());
			hp.paths[EGG].holes[0].size = 'L'; hp.paths[EGG].holes[0].certain = true;
			const m = jumpPlanner.homeModel({ startID: AMAMAKE, exits: [KBP, EY, EGG, sid('Tama')], paths: hp.paths, index: INDEX, systems: S,
				settings: jumpPlanner.settings({}), presets: PRESETS, jammed: {} });
			assert.strictEqual(m.problem, null);
			assert.strictEqual(m.need, 'XL');	// Carrier
			assert.deepStrictEqual(m.rows.map(r => r.id), [EGG, KBP, EY]);	// Tama has no path home here
			assert.deepStrictEqual(m.rows.map(r => r.jumps), [1, 2, 2]);
			assert.strictEqual(m.rows[0].cyno, EGG);
			assert.strictEqual(m.rows[1].cyno, m.rows[1].via);
			assert.ok(m.rows[0].warnings.some(w => w.text === 'hole too small for Carrier: L1 (L)'));
			assert.deepStrictEqual(m.counts, { reachable: 3, total: 3 });
			const bo = jumpPlanner.homeModel({ startID: AMAMAKE, exits: [EGG], paths: hp.paths, index: INDEX, systems: S,
				settings: jumpPlanner.settings({ jumpRange: { ship: 'group-898' } }), presets: PRESETS, jammed: {} });
			assert.deepStrictEqual(bo.rows[0].warnings, []);
		});
		it('homeModel: jammed exit unreachable for a normal cyno, reachable for Black Ops; W-space start rejected, high-sec allowed', () => {
			const hp = jumpPlanner.homePaths(chainResult());
			const jammed = {}; jammed[EGG] = { setBy: 'x', age: 1 };
			const base = { startID: AMAMAKE, exits: [EGG], paths: hp.paths, index: INDEX, systems: S, presets: PRESETS, jammed: jammed };
			const normal = jumpPlanner.homeModel(Object.assign({ settings: jumpPlanner.settings({}) }, base));
			assert.deepStrictEqual([normal.rows[0].jumps, normal.rows[0].reason, normal.rows[0].cyno], [null, 'jammed', null]);
			const covert = jumpPlanner.homeModel(Object.assign({ settings: jumpPlanner.settings({ jumpRange: { ship: 'group-898' } }) }, base));
			assert.strictEqual(covert.rows[0].jumps, 1);
			const ignore = jumpPlanner.homeModel(Object.assign({ settings: jumpPlanner.settings({ jumpRange: { jammed: 'ignore' } }) }, base));
			assert.strictEqual(ignore.rows[0].jumps, 1);
			const wh = jumpPlanner.homeModel(Object.assign({ settings: jumpPlanner.settings({}) }, base, { startID: J152820 }));
			assert.deepStrictEqual([wh.problem, wh.rows.length], ['wh', 0]);
			assert.ok(/wormhole space/.test(jumpPlanner.startProblemText('wh', 'J152820')));
			const hs = jumpPlanner.homeModel(Object.assign({ settings: jumpPlanner.settings({}) }, base, { startID: sid('Jita'), jammed: {} }));
			assert.strictEqual(hs.problem, null);
			assert.strictEqual(jumpPlanner.homeModel(Object.assign({ settings: jumpPlanner.settings({}) }, base, { startID: null })).problem, 'none');
		});
		it('homeModel: Supercarrier / Titan: nothing listed or counted, one clear message', () => {
			const hp = jumpPlanner.homePaths(chainResult());
			['group-659', 'group-30'].forEach(ship => {
				const m = jumpPlanner.homeModel({ startID: AMAMAKE, exits: [KBP, EY, EGG], paths: hp.paths, index: INDEX, systems: S,
					settings: jumpPlanner.settings({ jumpRange: { ship: ship } }), presets: PRESETS, jammed: {} });
				assert.deepStrictEqual([m.problem, m.rows.length, m.counts.reachable], ['supercap', 0, 0], ship);
			});
			assert.ok(/can't go through wormholes/.test(jumpPlanner.startProblemText('supercap', '')));
		});
		it('homeExits: every LS/NS exit, whatever "Exits that get a range" is set to', () => {
			const r = chainResult();
			const all = jumpPlanner.homeExits(r, S);
			assert.deepStrictEqual(all, [EY, KBP, EGG]);
			assert.deepStrictEqual(jumpPlanner.chainExits(r, S, 'viewing', J152820), []);	// what the From exit tabs would get
			const m = jumpPlanner.homeModel({ startID: AMAMAKE, exits: all, paths: jumpPlanner.homePaths(r).paths, index: INDEX, systems: S,
				settings: jumpPlanner.settings({ jumpRange: { exits: 'viewing' } }), presets: PRESETS, jammed: {} });
			assert.strictEqual(m.rows.length, 3);
		});
		it('homeKey changes with the preserve-mass flags of holes on a way home only', () => {
			const r = chainResult();
			const none = jumpPlanner.homeKey(r, S, {});
			assert.strictEqual(jumpPlanner.homeKey(r, S, { 999: { wormholeID: 999 } }), none);	// not on a way home
			assert.notStrictEqual(jumpPlanner.homeKey(r, S, { 12: { wormholeID: 12 } }), none);
			const more = chainResult(); more.lines[0][2] = [];	// the EOL on hole 11 gone
			assert.notStrictEqual(jumpPlanner.homeKey(more, S, {}), none);
		});
		it('route text', () => {
			const n = id => S[id].name;
			assert.strictEqual(jumpPlanner.routeText({ jumps: 1, legs: [6.24] }, n), '1 jump 6.2 LY');
			assert.strictEqual(jumpPlanner.routeText({ jumps: 2, legs: [5.81, 5.6], via: AMAMAKE }, n), '2 jumps via Amamake (5.8 + 5.6 LY)');
			assert.strictEqual(jumpPlanner.routeText({ jumps: null, reason: 'range', reach: { direct: 13.94 } }, n), 'out of range within 5 jumps (13.9 LY)');
			assert.strictEqual(jumpPlanner.routeText({ jumps: null, reason: 'range', direct: 13.94 }, n), 'out of range within 5 jumps (13.9 LY)');
			assert.strictEqual(jumpPlanner.routeText({ jumps: null, reason: 'jammed', reach: {} }, n), 'cyno-jammed (normal cyno)');
			assert.strictEqual(jumpPlanner.routeText({ id: EC, sec: -0.4, jumps: null, reason: 'target', reach: {} }, n), 'null-sec targets are off in Settings');
		});
		it('settings: mode and start remembered, checked', () => {
			const s = jumpPlanner.settings({ jumpRange: { mode: 'home', origin: 30002537 } });
			assert.deepStrictEqual([s.mode, s.origin], ['home', 30002537]);
			const bad = jumpPlanner.settings({ jumpRange: { mode: '<x>', origin: 'abc' } });
			assert.deepStrictEqual([bad.mode, bad.origin], ['exit', null]);
			assert.deepStrictEqual(jumpPlanner.quickPicks(AMAMAKE), [AMAMAKE, 30000142, 30002187]);
			assert.deepStrictEqual(jumpPlanner.quickPicks(30000142), [30000142, 30002187]);
			assert.deepStrictEqual(jumpPlanner.quickPicks(null), [30000142, 30002187]);
		});
		it('HTML builders escape system and hole names', () => {
			const nameOf = () => EVIL;
			const holes = [{ name: EVIL, signatureID: EVIL, realType: EVIL, size: 'L', certain: true, eol: true }];
			const rows = [{ id: EGG, name: EVIL, sec: 0.4, secText: '0.4', jumps: 2, legs: [1, 2], path: [AMAMAKE], via: AMAMAKE, cyno: AMAMAKE, total: 3, home: J152820, holes: holes,
				warnings: jumpPlanner.holeWarnings(holes, 'XL', EVIL), reach: { direct: 3 } },
				{ id: KBP, name: EVIL, sec: -0.3, secText: '-0.3', jumps: null, reason: 'range', legs: [], home: J152820, holes: holes, warnings: [], reach: { direct: 20 } }];
			const model = { rows: rows, counts: { reachable: 1, total: 2 }, preset: { label: EVIL }, range: 7 };
			const html = jumpPlanner.homeListHtml(model, nameOf, jumpPlanner.settings({}), [J152820, KBP]);
			noRawHtml(html);
			assert.ok(/jp-row-out/.test(html) && /data-jp-cyno='/.test(html) && /⚠/.test(html));
			noRawHtml(jumpPlanner.quickPicksHtml([AMAMAKE], AMAMAKE, AMAMAKE, nameOf));
			const c = ctx({}, { exitID: AMAMAKE }); const mm = jumpPlanner.mapModel(c, jumpPlanner.model(c));
			const pos = {}; pos[EGG] = INDEX.pos[EGG]; pos[AMAMAKE] = INDEX.pos[sid('Auga')]; pos[KBP] = INDEX.pos[sid('Siseide')];
			const svg = jumpPlanner.homeOverlaySvg(mm, rows, pos, EGG, nameOf);
			noRawHtml(svg);
			assert.ok(/jp-route/.test(svg) && /jp-hx-ok/.test(svg) && /jp-hx-no/.test(svg) && /jp-hx-sel/.test(svg));
			noRawHtml(jumpPlanner.tooltipHtml({ id: EGG, name: EVIL, sec: 0.4, region: EVIL, ly: 3, kind: 'out', route: EVIL, cyno: EGG }));
			assert.ok(/jp-home-dest/.test(jumpPlanner.tooltipHtml({ id: EGG, name: 'x', sec: 0.4, ly: 3, kind: 'out', route: 'r', cyno: EGG })));
			assert.ok(jumpPlanner.homeCopyText(model, EVIL, nameOf, 5).indexOf('Get home from') === 0);
		});
		it('mode switch, home line and footer', () => {
			assert.ok(/data-jp-mode='home' class='active'/.test(jumpPlanner.modeHtml('home')));
			assert.ok(/data-jp-mode='exit' class='active'/.test(jumpPlanner.modeHtml('exit')));
			assert.strictEqual(jumpPlanner.homeFooterText({ counts: { reachable: 2, total: 3 } }), '2 of 3 exits reachable within 5 jumps');
			assert.strictEqual(jumpPlanner.homeText([], String), 'no home on this chain');
			assert.strictEqual(jumpPlanner.homeText([J152820], id => S[id].name), 'Home: J152820');
		});
		it('the mini-map can be widened to fit the farthest exit (fitLy)', () => {
			const c = ctx({}, { exitID: AMAMAKE });
			const m = jumpPlanner.model(c);
			const narrow = jumpPlanner.mapModel(c, m), wide = jumpPlanner.mapModel(Object.assign({}, c, { fitLy: 14 }), m);
			assert.ok(wide.scale < narrow.scale);
			assert.deepStrictEqual(jumpPlanner.projectPoint(wide, INDEX.pos[AMAMAKE]), { x: wide.cx, y: wide.cy });
		});
	});

	describe('Get home: up to 5 jumps', () => {
		const JITA = sid('Jita');
		const all = COORDS.ids.filter(id => jumpRange.isValidCynoTarget(id, S[id], {}));
		const far = jumpRange.routesFrom(JITA, all, 7, INDEX, S, {}, 5);
		const pick = k => far.filter(r => r.jumps === k)[0];
		const pathsFor = ids => {
			const paths = {};
			ids.forEach(id => { paths[id] = { home: J152820, holes: [{ name: 'A', signatureID: 'aaa111', wormholeID: 1, from: J152820, to: id, size: 'XL', certain: true }] }; });
			return paths;
		};
		const model = (exits, extra, settings) => jumpPlanner.homeModel(Object.assign({ startID: JITA, exits: exits, paths: pathsFor(exits), index: INDEX, systems: S,
			settings: jumpPlanner.settings({ jumpRange: settings || {} }), presets: PRESETS, jammed: {} }, extra || {}));
		const name = id => S[id].name;

		it('the limit is 5 jumps', () => {
			assert.strictEqual(jumpPlanner.HOME_MAX_JUMPS, 5);
			assert.ok(pick(3) && pick(4) && pick(5), 'the real map has 3-, 4- and 5-jump exits from Jita for a Carrier');
			assert.ok(far.every(r => r.jumps === null || r.jumps <= 5));
		});
		it('homeModel lists 3-, 4- and 5-jump exits with every leg; Dest is the first midpoint', () => {
			const ids = [pick(3).id, pick(4).id, pick(5).id];
			const m = model(ids);
			assert.deepStrictEqual(m.rows.map(r => r.jumps), [3, 4, 5]);
			m.rows.forEach(r => {
				assert.strictEqual(r.legs.length, r.jumps);
				assert.strictEqual(r.path.length, r.jumps - 1);
				assert.ok(r.legs.every(l => l <= 7 + 1e-9));
				assert.strictEqual(r.cyno, r.path[0]);
				assert.strictEqual(r.via, r.path[0]);
				const text = jumpPlanner.routeText(r, name);
				assert.strictEqual(text, r.jumps + ' jumps via ' + r.path.map(name).join(' → ') + ' (' + r.legs.map(l => l.toFixed(1)).join(' + ') + ' LY)');
			});
			assert.deepStrictEqual(m.counts, { reachable: 3, total: 3 });
			// 1 jump: Dest is the exit itself, 2 jumps: the midpoint
			const one = far.filter(r => r.jumps === 1)[0], two = far.filter(r => r.jumps === 2)[0];
			const m2 = model([one.id, two.id]);
			assert.deepStrictEqual(m2.rows.map(r => r.cyno), [one.id, two.path[0]]);
		});
		it('beyond 5 jumps: "out of range within 5 jumps" with the straight-line distance, and the footer says 5', () => {
			const out = far.filter(r => r.jumps === null && r.reason === 'range')[0];
			const m = model([out.id]);
			assert.strictEqual(m.rows[0].jumps, null);
			assert.strictEqual(jumpPlanner.routeText(m.rows[0], name), 'out of range within 5 jumps (' + out.direct.toFixed(1) + ' LY)');
			assert.strictEqual(jumpPlanner.homeFooterText(m), '0 of 1 exit reachable within 5 jumps');
			assert.strictEqual(jumpPlanner.routeText({ jumps: 0 }, name), 'you are here');
		});
		it('a Jump Freighter (10 LY) needs fewer jumps than a Carrier (7 LY)', () => {
			const ids = [pick(5).id, pick(4).id];
			const jfm = model(ids, null, { ship: 'group-902' });
			const carrier = model(ids);
			assert.ok(jfm.rows.every((r, i) => r.jumps < carrier.rows.find(c => c.id === r.id).jumps));
			assert.ok(jfm.rows.every(r => r.legs.every(l => l <= 10 + 1e-9)));
		});
		it('the search is kept in ctx.cache: the same inputs reuse it, other inputs redo it, and the cached rows are not changed', () => {
			const ids = [pick(3).id, pick(4).id];
			const cache = {};
			const a = model(ids, { cache: cache });
			const routes = cache.routes;
			assert.ok(routes && cache.key);
			const b = model(ids, { cache: cache });
			assert.strictEqual(cache.routes, routes);
			assert.deepStrictEqual(b.rows.map(r => r.id), a.rows.map(r => r.id));
			assert.ok(!('name' in routes[0]) && routes[0].fuel === null && !('warnings' in routes[0]), 'cached rows stay plain routes (no panel fields, no fuel)');
			model(ids, { cache: cache }, { cap: 5 });
			assert.notStrictEqual(cache.routes, routes);
			const key = cache.key;
			model(ids.slice(0, 1), { cache: cache });
			assert.notStrictEqual(cache.key, key);
			const jam = {}; jam[pick(3).path[0]] = { setBy: 'x', age: 1 };
			const jammedKey = (model(ids, { cache: cache, jammed: jam }), cache.key);
			assert.notStrictEqual(jammedKey, key);
		});
		it('homeModel with fuel: each route\'s fuel is the sum of its jumps; "Show jump fuel" off gives none', () => {
			const ids = [pick(3).id];
			const m = model(ids);
			const archon = PRESETS.find(p => p.key === 'group-547').hulls[0];
			const r = m.rows[0];
			assert.strictEqual(m.fuel.hull, archon);
			assert.deepStrictEqual(r.legFuel, r.legs.map(l => jumpRange.fuelPerJump(l, archon, {})));
			assert.strictEqual(r.fuel, r.legFuel.reduce((x, y) => x + y, 0));
			const off = model(ids, null, { fuel: false });
			assert.deepStrictEqual([off.fuel, off.rows[0].fuel, off.rows[0].legFuel], [null, null, []]);
			assert.ok(!/jp-route-fuel/.test(jumpPlanner.homeListHtml(off, name, jumpPlanner.settings({}), [J152820])));
			const html = jumpPlanner.homeListHtml(m, name, jumpPlanner.settings({}), [J152820]);
			assert.ok(html.indexOf("<div class='jp-route-fuel'") > 0 && html.indexOf(jumpRange.formatFuel(r.fuel, archon)) > 0 && html.indexOf('Isotopes per jump: ') > 0);
			const levels = model(ids, null, { fuelSkills: { 21610: 0 } });
			assert.strictEqual(levels.rows[0].fuel, levels.rows[0].legs.reduce((sum, l) => sum + jumpRange.fuelPerJump(l, archon, { 21610: 0 }), 0));
		});
		it('copy text: fuel per route, and what it is based on', () => {
			const m = model([pick(3).id]);
			const text = jumpPlanner.homeCopyText(m, 'Jita', name, 5);
			const lines = text.split('\n');
			assert.ok(/^Get home from Jita/.test(lines[0]));
			assert.strictEqual(lines[1], 'Fuel for Archon, Jump Fuel Conservation V');
			assert.ok(lines[2].split('\t').length === 5 && lines[2].indexOf(m.rows[0].fuel.toLocaleString('en-US')) > 0, lines[2]);
			const off = jumpPlanner.homeCopyText(model([pick(3).id], null, { fuel: false }), 'Jita', name, 5);
			assert.ok(off.indexOf('Fuel for') < 0 && off.split('\n')[1].split('\t').length === 4);
		});
		it('the map overlay draws the whole route: a line through every midpoint, each marked and named', () => {
			const r = pick(5);
			const m = model([r.id]);
			const c = ctx({}, { exitID: JITA, fitLy: 30 });
			const mm = jumpPlanner.mapModel(c, jumpPlanner.model(c));
			const svg = jumpPlanner.homeOverlaySvg(mm, m.rows, INDEX.pos, r.id, name);
			assert.strictEqual((svg.match(/class='jp-route-mid'/g) || []).length, r.path.length);
			assert.strictEqual((svg.match(/class='jp-l-mid'/g) || []).length, r.path.length);
			const pts = svg.match(/<polyline class='jp-route' points='([^']*)'/)[1].split(' ');
			assert.strictEqual(pts.length, r.jumps + 1);
			r.path.forEach(id => assert.ok(svg.indexOf('>' + name(id) + '</text>') > 0, name(id)));
			// a route without a path (older shape) still draws via
			const old = jumpPlanner.homeOverlaySvg(mm, [{ id: r.id, jumps: 2, via: r.path[0], name: 'x' }], INDEX.pos, r.id, name);
			assert.strictEqual((old.match(/class='jp-route-mid'/g) || []).length, 1);
		});
		it('the tooltip of a multi-jump route has Set destination (first cyno) and the per-jump fuel; text escaped', () => {
			const html = jumpPlanner.tooltipHtml({ id: 1, name: EVIL, sec: -0.3, region: EVIL, ly: 20, kind: 'out', route: '3 jumps via ' + EVIL, cyno: 4242, fuel: '6,150 + 5,850 = 12,000 ' + EVIL });
			noRawHtml(html);
			assert.ok(/data-jp-cyno='4242'/.test(html) && /jp-tip-fuel/.test(html) && /6,150 \+ 5,850 = 12,000/.test(html));
			assert.ok(!/jp-tip-fuel/.test(jumpPlanner.tooltipHtml({ id: 1, name: 'x', sec: 0.4, ly: 3, kind: 'out', fuel: '' })));
		});
	});

	describe('jump fuel (panel)', () => {
		const carrier = PRESETS.find(p => p.key === 'group-547');
		const jfPreset = PRESETS.find(p => p.group === 'Jump Freighter');
		const rorqual = PRESETS.find(p => p.group === 'Capital Industrial Ship');
		const archon = carrier.hulls[0];
		const cfg = (o) => jumpPlanner.settings({ jumpRange: o || {} });

		it('settings: Show jump fuel on by default; hull and skill levels checked', () => {
			const d = cfg();
			assert.deepStrictEqual([d.fuel, d.hull, d.fuelSkills], [true, null, { 21610: 5 }]);
			assert.strictEqual(cfg({ fuel: false }).fuel, false);
			assert.strictEqual(cfg({ fuel: 0 }).fuel, true);		// only an explicit false turns it off, like the others
			assert.strictEqual(cfg({ hull: 23757 }).hull, 23757);
			['abc', -3, 1.5, 0, null, '<x>'].forEach(h => assert.strictEqual(cfg({ hull: h }).hull, null, String(h)));
			const skills = cfg({ fuelSkills: { 21610: 3, 29029: 9, x: 2, 5: 'a', 7: null, 8: '', 9: -4, 10: '2' } }).fuelSkills;
			assert.deepStrictEqual(skills, { 21610: 3, 29029: 5, 9: 0, 10: 2 });
			assert.deepStrictEqual(cfg({ fuelSkills: { 29029: 2 } }).fuelSkills, { 21610: 5, 29029: 2 });		// Jump Fuel Conservation defaults to V
			assert.deepStrictEqual(cfg({ fuelSkills: 'x' }).fuelSkills, { 21610: 5 });
			assert.deepStrictEqual(cfg({ fuelSkills: [3] }).fuelSkills, { 21610: 5, 0: 3 });
			// the settings object is never changed
			const raw = { jumpRange: { fuelSkills: { 21610: 2 } } };
			jumpPlanner.settings(raw);
			assert.deepStrictEqual(raw, { jumpRange: { fuelSkills: { 21610: 2 } } });
		});
		it('the ships.json cache is busted when its fields change without a new SDE build', () => {
			assert.ok(Number.isInteger(jumpPlanner.SHIPS_REV) && jumpPlanner.SHIPS_REV >= 2);
		});
		it('hullFor: the saved hull when it belongs to the ship group, else the first; none without fuel data', () => {
			const thanatos = carrier.hulls.find(h => h.name === 'Thanatos');
			assert.strictEqual(jumpPlanner.hullFor(carrier, cfg({ hull: thanatos.typeID })), thanatos);
			assert.strictEqual(jumpPlanner.hullFor(carrier, cfg({ hull: jfPreset.hulls[0].typeID })), archon);		// another group's hull
			assert.strictEqual(jumpPlanner.hullFor(carrier, cfg()), archon);
			assert.strictEqual(jumpPlanner.hullFor({ hulls: [] }, cfg()), null);
			assert.strictEqual(jumpPlanner.hullFor(null, cfg()), null);
			assert.strictEqual(jumpPlanner.fuelSetup(carrier, cfg({ fuel: false })), null);
			assert.strictEqual(jumpPlanner.fuelSetup({ hulls: [] }, cfg()), null);
			assert.deepStrictEqual(Object.keys(jumpPlanner.fuelSetup(carrier, cfg())), ['hull', 'levels']);
		});
		it('model: each in-range system has the fuel of that jump; nothing when off', () => {
			const m = jumpPlanner.model(ctx({}));
			assert.strictEqual(m.fuel.hull, archon);
			assert.ok(m.rows.length > 3);
			m.rows.forEach(r => assert.strictEqual(r.fuel, jumpRange.fuelPerJump(r.ly, archon, {})));
			assert.strictEqual(m.rows[0].fuel, Math.ceil(3000 * m.rows[0].ly * 0.5 - 1e-6));
			const lv = jumpPlanner.model(ctx({ fuelSkills: { 21610: 0 } }));
			assert.strictEqual(lv.rows[0].fuel, Math.ceil(3000 * lv.rows[0].ly - 1e-6));
			const off = jumpPlanner.model(ctx({ fuel: false }));
			assert.strictEqual(off.fuel, null);
			assert.ok(off.rows.every(r => r.fuel === null));
		});
		it('list: a Fuel column with the amount and isotope, sortable like LY; none without fuel; escaped', () => {
			const m = jumpPlanner.model(ctx({}));
			const html = jumpPlanner.listHtml(m.rows.slice(0, 3), { key: 'ly', dir: 1 }, cfg(), false, m.fuel);
			assert.ok(/data-jp-sort='fuel' class='jp-col-fuel'/.test(html) && />Fuel</.test(html));
			assert.strictEqual((html.match(/class='jp-col-fuel'/g) || []).length, 4);
			assert.ok(html.indexOf(jumpRange.formatFuel(m.rows[0].fuel, archon)) > 0 && /Helium/.test(html));
			assert.ok(jumpPlanner.listHtml(m.rows.slice(0, 3), { key: 'ly', dir: 1 }, cfg(), false, null).indexOf('jp-col-fuel') < 0);
			assert.ok(/colspan='7'/.test(jumpPlanner.listHtml([], { key: 'ly', dir: 1 }, cfg(), false, m.fuel)));
			assert.ok(/colspan='6'/.test(jumpPlanner.listHtml([], { key: 'ly', dir: 1 }, cfg(), false, null)));
			const evil = { hull: Object.assign({}, archon, { fuelName: EVIL + ' Isotopes' }), levels: {} };
			noRawHtml(jumpPlanner.listHtml(m.rows.slice(0, 2).map(r => Object.assign({}, r, { fuel: 123456 })), { key: 'fuel', dir: 1 }, cfg(), false, evil));
			const sorted = jumpPlanner.sortRows(m.rows, 'fuel', -1).map(r => r.id);
			assert.deepStrictEqual(sorted, jumpPlanner.sortRows(m.rows, 'ly', -1).map(r => r.id));
			assert.strictEqual(jumpPlanner.SORT_NAMES.fuel, 'Fuel');
		});
		it('fuel bar: hull select only with several hulls; Jump Fuel Conservation and the hull\'s skills as level buttons', () => {
			const bar = jumpPlanner.fuelBarHtml(carrier, cfg({ fuelSkills: { 21610: 3 } }));
			assert.ok(/<select class='jp-hull'/.test(bar));
			assert.strictEqual((bar.match(/<option /g) || []).length, 4);
			assert.ok(/Archon \(Helium\)/.test(bar) && /Thanatos \(Oxygen\)/.test(bar));
			assert.strictEqual((bar.match(/data-fskill='21610'/g) || []).length, 6);
			assert.ok(/data-fskill='21610' data-level='3' class='active'/.test(bar));
			assert.ok(!/data-fskill='29029'/.test(bar) && />JFC</.test(bar));
			const jf = jumpPlanner.fuelBarHtml(jfPreset, cfg({ ship: 'group-902', fuelSkills: { 29029: 2 } }));
			assert.strictEqual((jf.match(/data-fskill='29029'/g) || []).length, 6);
			assert.ok(/data-fskill='29029' data-level='2' class='active'/.test(jf) && />JF</.test(jf));
			assert.ok(/data-fskill='29029' data-level='5' class=''/.test(jumpPlanner.fuelBarHtml(jfPreset, cfg())) === false, 'missing = V is active');
			assert.ok(/data-fskill='29029' data-level='5' class='active'/.test(jumpPlanner.fuelBarHtml(jfPreset, cfg())));
			const single = jumpPlanner.fuelBarHtml(rorqual, cfg());
			assert.ok(single.indexOf('<select') < 0 && /data-fskill='21610'/.test(single));
			assert.strictEqual(jumpPlanner.fuelBarHtml(carrier, cfg({ fuel: false })), '');
			assert.strictEqual(jumpPlanner.fuelBarHtml({ hulls: [] }, cfg()), '');
			assert.strictEqual(jumpPlanner.fuelBarHtml(null, cfg()), '');
		});
		it('fuel bar: the chosen hull is selected; names are escaped', () => {
			const t = carrier.hulls.find(h => h.name === 'Thanatos');
			assert.ok(new RegExp("<option value='" + t.typeID + "' selected>").test(jumpPlanner.fuelBarHtml(carrier, cfg({ hull: t.typeID }))));
			const evil = { hulls: [Object.assign({}, archon, { name: EVIL, fuelBonuses: [{ skillID: 1, skill: EVIL, perLevel: 0.1 }] }), Object.assign({}, archon, { typeID: 9, name: EVIL })] };
			const html = jumpPlanner.fuelBarHtml(evil, cfg());
			noRawHtml(html);
			assert.ok(/aria-label='&lt;img/.test(html));
		});
		it('fuelDetail / fuelBasis / skillAbbr', () => {
			const setup = jumpPlanner.fuelSetup(carrier, cfg());
			assert.strictEqual(jumpPlanner.fuelDetail(setup, [4.1]), '6,150 Helium');
			assert.strictEqual(jumpPlanner.fuelDetail(setup, [4.1, 3.9]), '6,150 + 5,850 = 12,000 Helium');
			assert.strictEqual(jumpPlanner.fuelDetail(setup, []), '0 Helium');
			assert.strictEqual(jumpPlanner.fuelDetail(null, [4.1]), '');
			assert.strictEqual(jumpPlanner.fuelDetail(setup, null), '');
			assert.strictEqual(jumpPlanner.fuelDetail({ hull: { name: 'x' }, levels: {} }, [4]), '');		// no fuel data
			assert.strictEqual(jumpPlanner.fuelBasis(setup), 'Archon, Jump Fuel Conservation V');
			const jf = jumpPlanner.fuelSetup(jfPreset, cfg({ fuelSkills: { 21610: 4, 29029: 3 } }));
			assert.strictEqual(jumpPlanner.fuelBasis(jf), jfPreset.hulls[0].name + ', Jump Fuel Conservation IV, Jump Freighters III');
			assert.strictEqual(jumpPlanner.fuelBasis(null), '');
			assert.deepStrictEqual(['Jump Fuel Conservation', 'Jump Freighters', 'x', ''].map(jumpPlanner.skillAbbr), ['JFC', 'JF', 'X', '']);
		});
		it('hub lines: the fuel of the route shown', () => {
			const fuel = jumpPlanner.fuelSetup(carrier, cfg());
			const results = [{ hubID: sid('Jita'), to: { jumps: 1, direct: 6.2, via: [] }, back: null },
				{ hubID: sid('Amarr'), to: { jumps: 2, direct: 11, via: [{ id: AMAMAKE, ly1: 5.5, ly2: 5.5 }] },
					back: { systemID: AMAMAKE, gates: 2, reach: { jumps: 2, direct: 11, via: [{ id: HEK, ly1: 4, ly2: 3 }] } } }];
			const html = jumpPlanner.hubsHtml(results, 'EC-P8R', id => S[id].name, fuel);
			assert.ok(html.indexOf('(6.2 LY, 9,300 Helium)') > 0, html);
			assert.ok(html.indexOf('5.5 + 5.5 LY, 8,250 + 8,250 = 16,500 Helium') > 0);
			assert.ok(html.indexOf('via Hek, 6,000 + 4,500 = 10,500 Helium, then 2 gates') > 0);
			const plain = jumpPlanner.hubsHtml(results, 'EC-P8R', id => S[id].name);
			assert.ok(plain.indexOf('Helium') < 0 && plain.indexOf('(6.2 LY)') > 0);
			assert.strictEqual(jumpPlanner.hubsHtml(results, 'EC-P8R', id => S[id].name, null), plain);
			noRawHtml(jumpPlanner.hubsHtml(results, EVIL, () => EVIL, { hull: Object.assign({}, archon, { fuelName: EVIL + ' Isotopes' }), levels: {} }));
		});
		it('copy text: a fuel column and its basis; none when off', () => {
			const m = jumpPlanner.model(ctx({}));
			const text = jumpPlanner.copyText(m.rows.slice(0, 2), 'Amamake', 'Carrier', 5, 7, m.fuel);
			const lines = text.split('\n');
			assert.strictEqual(lines[1], 'Fuel per jump for Archon, Jump Fuel Conservation V');
			assert.strictEqual(lines[2].split('\t').length, 6);
			assert.ok(lines[2].indexOf(jumpRange.formatFuel(m.rows[0].fuel, archon)) > 0);
			const plain = jumpPlanner.copyText(m.rows.slice(0, 2), 'Amamake', 'Carrier', 5, 7);
			assert.strictEqual(plain.split('\n').length, 3);
			assert.strictEqual(plain.split('\n')[1].split('\t').length, 5);
		});
		it('Settings rows: Show jump fuel and Jump Fuel Conservation', () => {
			const html = jumpPlanner.fuelSettingsHtml();
			assert.ok(/name='jumpPlanner-fuel' value='1'/.test(html) && /name='jumpPlanner-fuel' value='0'/.test(html));
			assert.strictEqual((html.match(/name='jumpPlanner-jfc'/g) || []).length, 6);
			assert.ok(/Show jump fuel:/.test(html) && /Jump Fuel Conservation:/.test(html));
			assert.ok(jumpPlanner.settingsHtml(PRESETS).indexOf('jumpPlanner-fuel') < 0, 'its own block');
		});
	});
});
