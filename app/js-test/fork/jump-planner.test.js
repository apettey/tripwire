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
				dock: 'right', clickOpen: true, mapRadius: 10, showOut: true, hubs: true, open: false });
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
		it('in-range points match the list; high-sec drawn as non-targets; nothing beyond the radius', () => {
			assert.strictEqual(map.points.filter(p => p.kind === 'in').length, 81);
			assert.ok(map.points.some(p => p.kind === 'hs'));
			assert.ok(map.points.every(p => p.ly <= 10 + 1e-9));
			assert.ok(map.lines.length > 0);
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
		it('settings section', () => {
			noRawHtml(jumpPlanner.settingsHtml([{ key: 'group-1', label: EVIL, ships: [EVIL], baseLy: 3 }]));
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
		it('age text', () => {
			assert.deepStrictEqual([30, 600, 7200, 200000].map(jumpPlanner.ageText), ['now', '10 min', '2 h', '2 d']);
		});
	});
});
