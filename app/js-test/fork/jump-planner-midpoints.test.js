const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/jump-range');
include('app/js/fork/jump-planner');

// Jump planner: choosing the midpoints (settings, live data, Get home rows, the other-systems list)
const DATA = loadJSON('public/jumprange/systems');
const SHIPS = loadJSON('public/jumprange/ships');
const STATIONS = loadJSON('public/jumprange/stations');
const COORDS = jumpRange.decode(DATA);
const INDEX = jumpRange.buildIndex(COORDS, 7);
const PRESETS = jumpRange.presets(SHIPS);
const S = appData.systems;
const sid = name => Number(Object.keys(S).find(k => S[k].name === name));
const EVIL = '<img src=x onerror=alert(1)>"\'&';
const noRawHtml = html => assert.ok(html.indexOf('<img') < 0 && html.indexOf('onerror=alert(1)>') < 0 && !/title='[^']*'[^>]*'[^>]*onerror/.test(html), html);
const J152820 = sid('J152820');

describe('jumpPlanner midpoints', () => {
	describe('settings', () => {
		it('defaults: fewer jumps, prefer stations, avoid kills, avoid incursions, nothing avoided', () => {
			const s = jumpPlanner.settings({});
			assert.deepStrictEqual([s.prefer, s.preferStations, s.avoidKills, s.avoidIncursions, s.avoid], ['jumps', true, true, true, []]);
		});
		it('a missing key means the default; each can be switched off', () => {
			const s = jumpPlanner.settings({ jumpRange: { prefer: 'fuel', preferStations: false, avoidKills: false, avoidIncursions: false } });
			assert.deepStrictEqual([s.prefer, s.preferStations, s.avoidKills, s.avoidIncursions], ['fuel', false, false, false]);
			assert.strictEqual(jumpPlanner.settings({ jumpRange: { prefer: '<x>' } }).prefer, 'jumps');
		});
		it('avoid: distinct positive integer ids, numeric strings accepted, junk dropped, at most 100', () => {
			assert.deepStrictEqual(jumpPlanner.settings({ jumpRange: { avoid: [30000142, '30002187', 30000142, -5, 0, 1.5, 'abc', null, '<x>', {}, 30000144] } }).avoid, [30000142, 30002187, 30000144]);
			assert.deepStrictEqual(jumpPlanner.settings({ jumpRange: { avoid: 'x' } }).avoid, []);
			assert.deepStrictEqual(jumpPlanner.settings({ jumpRange: { avoid: { 0: 5 } } }).avoid, []);
			const many = Array.from({ length: 300 }, (v, i) => 30000001 + i);
			assert.strictEqual(jumpPlanner.settings({ jumpRange: { avoid: many } }).avoid.length, 100);
			assert.deepStrictEqual(jumpPlanner.settings({ jumpRange: { avoid: many } }).avoid.slice(0, 2), [30000001, 30000002]);
		});
		it('never mutates the options', () => {
			const o = { jumpRange: { avoid: ['30000142'] } };
			jumpPlanner.settings(o);
			assert.deepStrictEqual(o, { jumpRange: { avoid: ['30000142'] } });
		});
		it('the Settings rows are there, with switches that default on', () => {
			const html = jumpPlanner.midpointSettingsHtml();
			['jumpPlanner-prefer', 'jumpPlanner-preferStations', 'jumpPlanner-avoidKills', 'jumpPlanner-avoidIncursions', 'jumpPlanner-avoid-list'].forEach(id => assert.ok(html.indexOf(id) > 0, id));
		});
	});

	describe('scoringOpts', () => {
		it('turns settings and data into jumpRange options; a part that is not loaded is left out', () => {
			const s = jumpPlanner.settings({ jumpRange: { avoid: [5, 6], prefer: 'fuel', avoidKills: false } });
			const o = jumpPlanner.scoringOpts(s, { stations: { 1: 1 }, kills: null, incursion: undefined });
			assert.deepStrictEqual(o, { prefer: 'fuel', preferStations: true, avoidKills: false, avoidIncursions: true, avoid: { 5: true, 6: true }, stations: { 1: 1 } });
			assert.ok(jumpRange.isScoring(jumpPlanner.scoringOpts(jumpPlanner.settings({}), null)));
		});
	});

	describe('live data', () => {
		it('stations.json decodes to counts by system', () => {
			const m = jumpPlanner.decodeStations(STATIONS);
			assert.strictEqual(Object.keys(m).length, STATIONS.meta.count);
			assert.ok(m[sid('Jita')] > 0 && m[sid('Amarr')] > 0);
			assert.ok(COORDS.ids.some(id => !m[id]) && COORDS.ids.filter(id => m[id]).length === STATIONS.meta.count, 'only systems with a station');
			assert.deepStrictEqual(jumpPlanner.decodeStations(null), {});
			assert.deepStrictEqual(jumpPlanner.decodeStations({ systems: [10, 5], counts: [2, 3] }), { 10: 2, 15: 3 });
		});
		it('kills: ship + pod kills from the chain map activity; NPC kills do not count; null without kill data', () => {
			const a = { 5: { systemID: 5, shipJumps: 9 }, 6: { shipKills: 2, podKills: 1, npcKills: 40 }, 7: { shipKills: 0, podKills: 0 }, 8: { podKills: 3 }, expires: new Date() };
			assert.deepStrictEqual(jumpPlanner.killsFrom(a), { 6: 3, 8: 3 });
			assert.strictEqual(jumpPlanner.killsFrom({ 5: { shipJumps: 9 } }), null);
			assert.strictEqual(jumpPlanner.killsFrom(null), null);
			assert.strictEqual(jumpPlanner.killsFrom({}), null);
		});
		it('incursions: every infested system; null when ESI did not answer with a list', () => {
			assert.deepStrictEqual(jumpPlanner.incursionMap([{ infested_solar_systems: [30000001, 30000002], state: 'established' }, { infested_solar_systems: [30000002, 30000003] }, null, { x: 1 }]),
				{ 30000001: true, 30000002: true, 30000003: true });
			assert.deepStrictEqual(jumpPlanner.incursionMap([]), {});
			assert.strictEqual(jumpPlanner.incursionMap({ error: 'x' }), null);
			assert.strictEqual(jumpPlanner.incursionMap(null), null);
			assert.deepStrictEqual(jumpPlanner.incursionMap([{ infested_solar_systems: ['<x>', -1, 1.5, 30000009] }]), { 30000009: true });
		});
	});

	describe('Get home with scored midpoints (real map)', () => {
		const JITA = sid('Jita');
		const all = COORDS.ids.filter(id => jumpRange.isValidCynoTarget(id, S[id], {}));
		const base = jumpRange.routePlan(JITA, all, 7, INDEX, S, {}, 5);
		const pick = k => base.filter(r => r.jumps === k)[0];
		const stations = jumpPlanner.decodeStations(STATIONS);
		const pathsFor = ids => {
			const paths = {};
			ids.forEach(id => { paths[id] = { home: J152820, holes: [{ name: 'A', signatureID: 'aaa111', wormholeID: 1, from: J152820, to: id, size: 'XL', certain: true }] }; });
			return paths;
		};
		const model = (exits, extra, settings) => jumpPlanner.homeModel(Object.assign({ startID: JITA, exits: exits, paths: pathsFor(exits), index: INDEX, systems: S,
			settings: jumpPlanner.settings({ jumpRange: settings || {} }), presets: PRESETS, jammed: {} }, extra || {}));
		const name = id => S[id].name;

		it('station data changes which midpoints are used and the rows carry the facts', () => {
			const ids = [pick(3).id];
			const without = model(ids).rows[0];
			const withStations = model(ids, { live: { stations: stations, rev: 'a' } }).rows[0];
			assert.strictEqual(withStations.jumps, without.jumps);
			const stationCount = r => r.mids.filter(m => m.station === true).length;
			assert.ok(stationCount(withStations) >= stationCount(without));
			assert.ok(withStations.mids.every(m => m.station === (stations[m.id] > 0)));
			assert.ok(without.mids.every(m => m.station === null));
		});
		it('switching "Prefer stations" off gives the unscored route again', () => {
			const ids = [pick(4).id];
			const off = model(ids, { live: { stations: stations, rev: 'a' } }, { preferStations: false }).rows[0];
			assert.deepStrictEqual(off.path, model(ids).rows[0].path);
		});
		it('kills in a midpoint of the cheapest route move the route away from it', () => {
			const ids = [pick(3).id];
			const plain = model(ids).rows[0];
			const kills = {};
			plain.path.forEach(id => { kills[id] = 12; });
			const moved = model(ids, { live: { kills: kills, rev: 'k' } }).rows[0];
			assert.strictEqual(moved.jumps, plain.jumps);
			assert.ok(moved.path.some(id => plain.path.indexOf(id) < 0) || plain.path.every(id => kills[id]), 'a quieter midpoint is used when there is one');
			assert.ok(moved.mids.every(m => m.kills === (kills[m.id] || 0)));
			assert.deepStrictEqual(model(ids, { live: { kills: kills, rev: 'k' } }, { avoidKills: false }).rows[0].path, plain.path);
		});
		it('an exit in an incursion is not a target (unless covert); the row says why', () => {
			const ids = [pick(2).id];
			const live = { incursion: { [ids[0]]: true }, rev: 'i' };
			const r = model(ids, { live: live }).rows[0];
			assert.deepStrictEqual([r.jumps, r.reason], [null, 'incursion']);
			assert.strictEqual(jumpPlanner.routeText(r, name), 'in an incursion (cynos jammed)');
			assert.strictEqual(model(ids, { live: live }, { avoidIncursions: false }).rows[0].jumps, pick(2).jumps);
			assert.strictEqual(model(ids, { live: live }, { ship: 'group-898' }).rows[0].jumps !== null, true);		// Black Ops: covert cynos
		});
		it('the avoided list and the mode are part of the cache key; live.rev too', () => {
			const ids = [pick(3).id];
			const cache = {};
			model(ids, { cache: cache });
			const key = cache.key;
			model(ids, { cache: cache });
			assert.strictEqual(cache.key, key);
			const keys = [model(ids, { cache: cache }, { avoid: [pick(3).path[0]] }), cache.key][1];
			assert.notStrictEqual(keys, key);
			model(ids, { cache: cache });
			const fuel = (model(ids, { cache: cache }, { prefer: 'fuel' }), cache.key);
			assert.notStrictEqual(fuel, key);
			model(ids, { cache: cache });
			assert.notStrictEqual((model(ids, { cache: cache, live: { rev: 'x' } }), cache.key), key);
			assert.notStrictEqual((model(ids, { cache: cache }, { ship: 'group-902' }), cache.key), key);
		});
		it('rows carry the fatigue of the ship class: carrier none, Jump Freighter 90%', () => {
			const ids = [pick(3).id];
			const carrier = model(ids).rows[0];
			const jf = model(ids, null, { ship: 'group-902' }).rows[0];
			assert.strictEqual(carrier.fatigue.cooldowns.length, carrier.jumps - 1);
			assert.deepStrictEqual(carrier.fatigue, jumpRange.fatigue(carrier.legs, 0));
			assert.deepStrictEqual(jf.fatigue, jumpRange.fatigue(jf.legs, 0.9));
			assert.ok(jf.fatigue.fatigueEnd < carrier.fatigue.fatigueEnd);
		});
		it('a pinned midpoint is kept and the rest is planned again; the row says pinned', () => {
			const ids = [pick(3).id];
			const row = model(ids).rows[0];
			const alt = jumpRange.alternatives(JITA, row.path[1], 7, INDEX, S, model(ids).plan).filter(a => a.id !== row.path[0])[0];
			assert.ok(alt, 'the real map has another system in range of both');
			const pinned = model(ids, { pins: { [ids[0]]: [alt.id] } }).rows[0];
			assert.strictEqual(pinned.path[0], alt.id);
			assert.strictEqual(pinned.cyno, alt.id);
			assert.strictEqual(pinned.pinned, true);
			assert.strictEqual(pinned.jumps, row.jumps);
			assert.strictEqual(pinned.legs.length, pinned.jumps);
			assert.strictEqual(pinned.fuel, pinned.legFuel.reduce((a, b) => a + b, 0));
			assert.strictEqual(model(ids).rows[0].pinned, undefined);
			// pins of another exit are ignored
			assert.strictEqual(model(ids, { pins: { 1: [alt.id] } }).rows[0].pinned, undefined);
		});
		it('a pin through a system that is no valid target any more is dropped (incursion, jam, setting)', () => {
			const ids = [pick(3).id];
			const row = model(ids).rows[0];
			const alt = jumpRange.alternatives(JITA, row.path[1], 7, INDEX, S, model(ids).plan).filter(a => a.id !== row.path[0])[0];
			const pins = { [ids[0]]: [alt.id] };
			assert.strictEqual(model(ids, { pins: pins }).rows[0].pinned, true);
			const plain = model(ids).rows[0];
			const inc = model(ids, { pins: pins, live: { incursion: { [alt.id]: true }, rev: 'i' } }).rows[0];
			assert.strictEqual(inc.pinned, false);
			assert.ok(inc.path.indexOf(alt.id) < 0 && inc.jumps === plain.jumps);
			const jammed = model(ids, { pins: pins, jammed: { [alt.id]: { setBy: 'x', age: 1 } } }).rows[0];
			assert.ok(jammed.pinned === false && jammed.path.indexOf(alt.id) < 0);
			// a Black Ops ship (covert) and the "ignore" setting keep the pin
			assert.strictEqual(model(ids, { pins: pins, jammed: { [alt.id]: { setBy: 'x', age: 1 } } }, { jammed: 'ignore' }).rows[0].pinned, true);
			assert.strictEqual(model(ids, { pins: pins, live: { incursion: { [alt.id]: true }, rev: 'i' } }, { avoidIncursions: false }).rows[0].pinned, true);
			// the engine: the prefix is checked against the options it is given
			const opts = Object.assign({}, model(ids).plan, { incursion: { [alt.id]: true }, avoidIncursions: true });
			const via = jumpRange.routeVia([JITA, alt.id], ids[0], 7, INDEX, S, opts, 5);
			assert.deepStrictEqual([via.pinDropped, via.path.indexOf(alt.id)], [true, -1]);
		});
		it('homeModel keeps the planner options for the other-systems list', () => {
			const m = model([pick(3).id], { live: { stations: stations, rev: 'a' } });
			assert.strictEqual(m.plan.prefer, 'jumps');
			assert.strictEqual(m.plan.stations, stations);
			assert.strictEqual(m.plan.reduction, 0);
		});
	});

	describe('From exit with incursions', () => {
		const exitID = sid('Amamake');
		const model = (live, settings) => jumpPlanner.model({ exitID: exitID, index: INDEX, systems: S, regions: appData.regions, map: null,
			settings: jumpPlanner.settings({ jumpRange: settings || {} }), presets: PRESETS, jammed: {}, gates: {}, live: live });
		const base = model(null);
		const target = base.rows.filter(r => !r.blocked)[3];
		const live = { incursion: { [target.id]: true }, rev: 'i' };
		it('an incursion system is shown like a jammed one: blocked and marked, counted as jammed', () => {
			const m = model(live);
			const r = m.rows.find(x => x.id === target.id);
			assert.deepStrictEqual([r.blocked, r.jammed, r.incursion], [true, true, true]);
			assert.strictEqual(m.counts.inRange, base.counts.inRange - 1);
			assert.strictEqual(m.counts.jammed, base.counts.jammed + 1);
			assert.ok(/>incursion</.test(jumpPlanner.listHtml([r], { key: 'ly', dir: 1 }, jumpPlanner.settings({}), false, null)));
			assert.ok(!base.rows.find(x => x.id === target.id).incursion);
		});
		it('"Hide" hides it like the jammed ones', () => {
			assert.ok(!model(live, { jammed: 'hide' }).rows.some(x => x.id === target.id));
		});
		it('"Avoid incursions" off and covert ships (Black Ops) leave it a normal target', () => {
			assert.strictEqual(model(live, { avoidIncursions: false }).rows.find(x => x.id === target.id).blocked, false);
			const covert = model(live, { ship: 'group-898' }).rows.find(x => x.id === target.id);
			assert.strictEqual(covert.blocked, false);
			assert.deepStrictEqual([covert.jammed, covert.incursion], [false, false], 'no misleading jammed tag for covert ships');
			assert.strictEqual(model(live, { ship: 'group-898' }).counts.jammed, base.counts.jammed);
		});
		it('without live data nothing changes', () => {
			assert.deepStrictEqual(model({ rev: 'x' }).rows.map(r => r.id), base.rows.map(r => r.id));
		});
	});

	describe('HTML', () => {
		const name = id => id === 3 ? EVIL : 'N' + id;
		const row = { id: 9, jumps: 3, legs: [5.82, 5.6, 4], path: [1, 2], via: 1, total: 15.4, cyno: 1,
			mids: [{ id: 1, station: true, kills: 0, avoided: false }, { id: 2, station: false, kills: 4, avoided: true }],
			fatigue: jumpRange.fatigue([5.82, 5.6, 4], 0) };
		it('routeHtml: each midpoint is a link with its number; station, kills and avoided tags', () => {
			const html = jumpPlanner.routeHtml(row, name, jumpPlanner.settings({}));
			assert.ok(/data-jp-mid='0'[^>]*>N1<\/a>/.test(html) && /data-jp-mid='1'[^>]*>N2<\/a>/.test(html));
			assert.ok(/jp-st/.test(html) && /4 kills/.test(html) && /jp-av/.test(html));
			assert.ok(html.indexOf('3 jumps via ') === 0 && /\(5\.8 \+ 5\.6 \+ 4\.0 LY\)/.test(html));
			assert.ok(!/pinned/.test(html) && /jp-pin/.test(jumpPlanner.routeHtml(Object.assign({ pinned: true }, row), name)));
		});
		it('routeHtml without facts (older rows) and for other cases is the plain text, escaped', () => {
			const plain = jumpPlanner.routeHtml({ jumps: 2, legs: [5, 5], path: [3], via: 3 }, name);
			noRawHtml(plain);
			assert.ok(plain.indexOf('&lt;img') > 0);
			assert.strictEqual(jumpPlanner.routeHtml({ jumps: 1, legs: [6.24] }, name), '1 jump 6.2 LY');
			assert.strictEqual(jumpPlanner.routeHtml({ jumps: null, reason: 'range', direct: 13.94 }, name), 'out of range within 5 jumps (13.9 LY)');
			noRawHtml(jumpPlanner.routeHtml(Object.assign({}, row, { mids: [{ id: 3, station: true, kills: 2, avoided: true }, row.mids[1]], path: [3, 2] }), name));
		});
		it('midTags: nothing without facts; the kill count is a number', () => {
			assert.strictEqual(jumpPlanner.midTags(null), '');
			assert.strictEqual(jumpPlanner.midTags({ station: null, kills: null, avoided: false }), '');
			assert.ok(/1 kill</.test(jumpPlanner.midTags({ kills: 1 })));
			noRawHtml(jumpPlanner.midTags({ station: true, kills: EVIL, avoided: true }));
		});
		it('fatigue text: the waits and the fatigue on arrival', () => {
			assert.strictEqual(jumpPlanner.fatigueText(jumpRange.fatigue([5, 5, 5], 0)), 'Waits: 6 min, 6 min · fatigue on arrival 5 h');
			assert.strictEqual(jumpPlanner.fatigueText(jumpRange.fatigue([3.5], 0)), 'Fatigue on arrival 45 min');
			assert.strictEqual(jumpPlanner.fatigueText(null), '');
		});
		it('route tooltip: isotopes per jump (when fuel is on) and the fatigue line, escaped', () => {
			const archon = PRESETS.find(p => p.key === 'group-547').hulls[0];
			const t = jumpPlanner.routeTitle(row, { fuel: { hull: archon, levels: {} } });
			assert.ok(/^ title='Isotopes per jump: /.test(t) && t.indexOf('Waits: ') > 0 && t.indexOf(String.fromCharCode(10)) > 0);
			assert.ok(/fatigue on arrival/.test(t));
			assert.ok(!/Isotopes/.test(jumpPlanner.routeTitle(row, { fuel: null })));
			assert.strictEqual(jumpPlanner.routeTitle({ jumps: 1, legs: [4] }, { fuel: null }), '');
		});
		it('the other-systems list: rows with Use / Avoid, the one in use marked, everything escaped', () => {
			const alt = { routeID: 9, index: 0, id: 1, prev: 5, next: 2, more: 3, list: [
				{ id: 1, ly1: 5.1, ly2: 4.9, station: true, kills: 0, avoided: false },
				{ id: 3, ly1: 5.3, ly2: 5, station: false, kills: 7, avoided: false },
				{ id: 4, ly1: 6, ly2: 6.5, station: null, kills: null, avoided: true }] };
			const info = id => ({ sec: -0.4, secText: id === 3 ? EVIL : '-0.4', region: EVIL });
			const html = jumpPlanner.altListHtml(alt, name, info, 4);
			noRawHtml(html);
			assert.ok(/data-jp-alt='9'/.test(html) && /Other systems to jump to instead of N1/.test(html));
			assert.strictEqual((html.match(/jp-alt-use/g) || []).length, 2, 'no Use for the one in use');
			assert.ok(/jp-alt-cur/.test(html) && /\(in use\)/.test(html));
			assert.ok(/>Allow</.test(html) && /data-jp-alt-id='4'/.test(html) && />Avoid</.test(html));
			assert.ok(/5\.1 \/ 4\.9/.test(html) && /\+ 3 more in range/.test(html));
			assert.ok(/No other system/.test(jumpPlanner.altListHtml(Object.assign({}, alt, { list: [] }), name, info)));
			noRawHtml(jumpPlanner.altListHtml(Object.assign({}, alt, { id: 3, prev: 3, next: 3 }), name, info));
		});
		it('the home list shows the other-systems list under the chosen route only', () => {
			const model = { rows: [Object.assign({ name: 'X', sec: -0.4, secText: '-0.4', home: J152820, holes: [], warnings: [], reach: { direct: 9 } }, row),
				Object.assign({ name: 'Y', sec: -0.4, secText: '-0.4', home: J152820, holes: [], warnings: [], reach: { direct: 9 } }, row, { id: 10 })],
				counts: { reachable: 2, total: 2 }, fuel: null };
			const alt = { routeID: 10, index: 1, id: 2, prev: 1, next: 10, more: 0, list: [{ id: 2, ly1: 5, ly2: 5, station: false, kills: 0, avoided: false }] };
			const html = jumpPlanner.homeListHtml(model, name, jumpPlanner.settings({}), [J152820], alt, () => ({}));
			assert.strictEqual((html.match(/jp-alt-box/g) || []).length, 1);
			assert.ok(html.indexOf("data-jp-alt='10'") > html.indexOf("data-jp-id='10'"));
			assert.ok(html.indexOf('jp-alt-box') > html.lastIndexOf("data-jp-id='9'"));
			assert.strictEqual((jumpPlanner.homeListHtml(model, name, jumpPlanner.settings({}), [J152820]).match(/jp-alt-box/g) || []).length, 0);
		});
		it('avoided systems in Settings: a chip each with a remove button, escaped; empty says how to add', () => {
			const html = jumpPlanner.avoidListHtml([3, 4], name);
			noRawHtml(html);
			assert.strictEqual((html.match(/jp-chip-x/g) || []).length, 2);
			assert.ok(/data-jp-avoid-id='3'/.test(html));
			assert.ok(/none/.test(jumpPlanner.avoidListHtml([], name)));
		});
		it('hub lines show the tags of the midpoint and the incursion reason', () => {
			const to = { jumps: 2, direct: 9, via: [{ id: 1, ly1: 5, ly2: 4, station: true, kills: 3, avoided: false }] };
			const html = jumpPlanner.hubsHtml([{ hubID: 7, to: to, back: { systemID: 8, gates: 2, reach: { jumps: 2, direct: 9, via: [{ id: 2, ly1: 4, ly2: 4, station: false, kills: 0 }] } } }], 'EXIT', name);
			assert.ok(/jp-st/.test(html) && /3 kills/.test(html));
			const inc = jumpPlanner.hubsHtml([{ hubID: 7, to: { jumps: null, reason: 'target', cause: 'incursion', via: [] }, back: null }], 'EXIT', name);
			assert.ok(/incursion/.test(inc));
			assert.ok(/cyno-jammed/.test(jumpPlanner.hubsHtml([{ hubID: 7, to: { jumps: null, reason: 'target', via: [] }, back: null }], 'EXIT', name)));
		});
	});
});
