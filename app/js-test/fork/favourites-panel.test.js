const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/rally');
include('app/js/fork/favourites-panel');

const fp = favouritesPanel;
const HOME = 31000001, UEDAMA = 30002768,
	JITA = 30000142, AMARR = 30002187, DODIXIE = 30002659;

function node(id, systemID, cls) {
	return { v: id, systemID: systemID, f: "<div id='node" + id + "' data-nodeid='" + systemID + "' class='node " + (cls || '') + "'></div>" };
}
function row(id, systemID, parent, cls, extra) { return Object.assign({ c: [node(id, systemID, cls), { v: parent }] }, extra || {}); }
function calcRow(id, systemID, parent, jumps) {
	return row(id, systemID, parent, 'calc', { pathHome: [{ systemID: 1 }, { systemID: systemID, path: [1, 2], jumps: jumps }] });
}

const marked = (r, cls) => r.map.rows.filter(x => x.c[0].f.indexOf(cls) >= 0).map(x => x.c[0].v);

describe('Favourites panel', () => {
	describe('settings', () => {
		it('Missing key: enabled, no flags', () => assert.deepEqual(fp.settings({}), { enabled: true, systems: {} }));
		it('No options at all', () => assert.deepEqual(fp.settings(undefined), { enabled: true, systems: {} }));
		it('Disabled', () => assert.equal(fp.settings({ favoritesPanel: { enabled: false } }).enabled, false));
		it('Flags normalised, junk dropped', () => assert.deepEqual(
			fp.settings({ favoritesPanel: { systems: { '30000142': { map: false }, '30002187': { route: true }, 'x|1': { map: false }, '30002659': null } } }).systems,
			{ 30000142: { map: false, route: false }, 30002187: { map: true, route: 'shortest' } }));
		it('Keeps a saved position', () => assert.deepEqual(fp.settings({ favoritesPanel: { position: { col: 3 } } }).position, { col: 3 }));
		it('enabled(): missing means on', () => assert.ok(fp.enabled({})));
		it('enabled(): explicit false', () => assert.ok(!fp.enabled({ favoritesPanel: { enabled: false } })));
		it('enabled(): anything else is on', () => assert.ok(fp.enabled({ favoritesPanel: { enabled: 'yes' } })));
	});

	describe('flags', () => {
		const s = fp.settings({ favoritesPanel: { systems: { 30000142: { map: false, route: true } } } });
		it('Defaults: map on, route off', () => assert.deepEqual(fp.flags(s, AMARR), { map: true, route: false }));
		it('Saved (legacy true)', () => assert.deepEqual(fp.flags(s, JITA), { map: false, route: 'shortest' }));
		it('String ID', () => assert.deepEqual(fp.flags(s, '30000142'), { map: false, route: 'shortest' }));
		it('setFlag turns route on', () => assert.deepEqual(fp.setFlag(fp.settings({}), AMARR, 'route', true).systems, { 30002187: { map: true, route: 'shortest' } }));
		it('setFlag keeps a non-default entry', () => assert.deepEqual(fp.setFlag(s, JITA, 'route', false).systems[JITA], { map: false, route: false }));
		it('setFlag all defaults removes it', () => {
			const t = fp.setFlag(fp.setFlag(s, JITA, 'route', false), JITA, 'map', true);
			assert.deepEqual(t.systems, {});
		});
		it('setFlag ignores unknown keys', () => assert.deepEqual(fp.setFlag(s, JITA, 'colour', true).systems, s.systems));
		it('setFlag does not mutate', () => { fp.setFlag(s, JITA, 'map', true); assert.equal(s.systems[JITA].map, false); });
		it('cleanFlags drops removed favourites', () => assert.deepEqual(
			Object.keys(fp.cleanFlags(fp.settings({ favoritesPanel: { systems: { 30000142: { map: false }, 30002187: { route: true } } } }), [AMARR]).systems), ['30002187']));
	});

	describe('list', () => {
		const systems = { 30000142: { name: 'Jita' }, 30002187: { name: 'Amarr' } };
		const byName = n => ({ JITA: JITA, AMARR: AMARR })[String(n).toUpperCase()] || null;
		it('sanitize: ints, unique, valid', () => assert.deepEqual(fp.sanitize(['30000142', JITA, 5, null, AMARR, 'x|1']), [JITA, AMARR]));
		it('sanitize: not an array', () => assert.deepEqual(fp.sanitize(undefined), []));
		it('add by name', () => assert.deepEqual(fp.add([JITA], 'amarr', systems, byName), { list: [JITA, AMARR], systemID: AMARR }));
		it('add by ID', () => assert.deepEqual(fp.add([], JITA, systems, byName).list, [JITA]));
		it('add duplicate', () => assert.equal(fp.add([JITA], 'Jita', systems, byName).error, 'Jita is already a favourite'));
		it('add unknown', () => assert.equal(fp.add([JITA], 'Nowhere', systems, byName).error, 'Unknown system "Nowhere"'));
		it('remove', () => assert.deepEqual(fp.remove([JITA, AMARR, DODIXIE], '30002187'), [JITA, DODIXIE]));
		it('move down', () => assert.deepEqual(fp.move([JITA, AMARR, DODIXIE], 0, 2), [AMARR, DODIXIE, JITA]));
		it('move up', () => assert.deepEqual(fp.move([JITA, AMARR, DODIXIE], 2, 0), [DODIXIE, JITA, AMARR]));
		it('move out of range', () => assert.deepEqual(fp.move([JITA, AMARR], 0, 5), [JITA, AMARR]));
		it('reorder', () => assert.deepEqual(fp.reorder([JITA, AMARR, DODIXIE], ['30002659', '30000142', '30002187']), [DODIXIE, JITA, AMARR]));
		it('reorder ignores strangers, keeps missing', () => assert.deepEqual(fp.reorder([JITA, AMARR, DODIXIE], [DODIXIE, UEDAMA]), [DODIXIE, JITA, AMARR]));
	});

	describe('map filter', () => {
		const s = fp.settings({ favoritesPanel: { systems: { 30002187: { map: false }, 30002659: { route: true } } } });
		it('mapFavorites', () => assert.deepEqual(fp.mapFavorites([JITA, AMARR, DODIXIE], s), [JITA, DODIXIE]));
		it('routeFavorites', () => assert.deepEqual(fp.routeFavorites([JITA, AMARR, DODIXIE], s), [DODIXIE]));
		it('chainFavorites: same array when all shown', () => {
			const favs = [JITA, DODIXIE];
			assert.strictEqual(fp.chainFavorites(favs, s), favs);
		});
		it('chainFavorites: for..in only sees shown favourites', () => {
			const shown = fp.chainFavorites([JITA, AMARR, DODIXIE], s);
			const seen = [];
			for (const x in shown) { seen.push(shown[x]); }
			assert.deepEqual(seen, [JITA, DODIXIE]);
		});
		it('chainFavorites: indexOf still knows every favourite (stars stay)', () => {
			const shown = fp.chainFavorites([JITA, AMARR, DODIXIE], s);
			assert.equal(shown.indexOf(AMARR), 1);
			assert.equal(shown.indexOf(UEDAMA), -1);
		});
	});

	describe('withChainFavorites', () => {
		const s = fp.settings({ favoritesPanel: { systems: { 30002187: { map: false } } } });
		it('Swaps during the call', () => {
			const opts = { favorites: [JITA, AMARR] };
			const seen = fp.withChainFavorites(opts, s, () => { const r = []; for (const x in opts.favorites) { r.push(opts.favorites[x]); } return r; });
			assert.deepEqual(seen, [JITA]);
			assert.deepEqual(opts.favorites, [JITA, AMARR]);
		});
		it('Restores the real list when the chain build throws', () => {
			const favorites = [JITA, AMARR];
			const opts = { favorites: favorites };
			assert.throws(() => fp.withChainFavorites(opts, s, () => { throw new Error('boom'); }), /boom/);
			assert.strictEqual(opts.favorites, favorites);
		});
	});

	describe('showOnly', () => {
		const J = 31000005;
		const systems = { [JITA]: { regionID: 10000002 }, [AMARR]: { regionID: 10000043 }, [DODIXIE]: { regionID: 10000032 }, [J]: { regionID: 11000001, class: 3 } };
		const start = fp.settings({ favoritesPanel: { systems: { [AMARR]: { map: false, route: true } } } });
		const result = fp.showOnly(start, [JITA, AMARR, DODIXIE, J], AMARR, systems);
		it('Only the clicked favourite is shown', () => assert.deepEqual(fp.mapFavorites([JITA, AMARR, DODIXIE], result), [AMARR]));
		it('Route flags kept', () => assert.equal(fp.flags(result, AMARR).route, 'shortest'));
		it('J-space favourites untouched', () => assert.equal(result.systems[J], undefined));
		it('Does not mutate', () => assert.equal(start.systems[AMARR].map, false));
	});

	describe('dropFlags', () => {
		const s = fp.settings({ favoritesPanel: { systems: { [JITA]: { route: true }, [AMARR]: { map: false } } } });
		it('Drops one system', () => assert.deepEqual(Object.keys(fp.dropFlags(s, '30000142').systems), [String(AMARR)]));
		it('Unknown system is a no-op', () => assert.equal(Object.keys(fp.dropFlags(s, DODIXIE).systems).length, 2));
	});

	describe('canShowOnMap', () => {
		it('K-space', () => assert.ok(fp.canShowOnMap({ regionID: 10000002 })));
		it('J-space', () => assert.ok(!fp.canShowOnMap({ regionID: 11000001, class: 3 })));
		it('Unknown', () => assert.ok(!fp.canShowOnMap(undefined)));
	});

	describe('layout', () => {
		const widgets = [
			{ id: 'infoWidget', col: 1, row: 1, size_x: 7, size_y: 6 },
			{ id: 'notesWidget', col: 15, row: 1, size_x: 7, size_y: 6 },
			{ id: 'chainWidget', col: 1, row: 7, size_x: 21, size_y: 8 }
		];
		it('defaultPlacement: right of the widgets, full height', () => assert.deepEqual(fp.defaultPlacement(widgets), { col: 22, row: 1, size_x: 5, size_y: 14 }));
		it('defaultPlacement: fits in a wide window', () => assert.equal(fp.defaultPlacement(widgets, 30).col, 22));
		it('defaultPlacement: narrow window goes below', () => assert.deepEqual(fp.defaultPlacement(widgets, 24), { col: 1, row: 15, size_x: 7, size_y: 8 }));
		it('defaultPlacement: empty grid', () => assert.deepEqual(fp.defaultPlacement([]), { col: 1, row: 1, size_x: 5, size_y: 8 }));
	});

	describe('route modes', () => {
		it('Legacy true is shortest', () => assert.equal(fp.routeMode(true), 'shortest'));
		it('Safe', () => assert.equal(fp.routeMode('safe'), 'safe'));
		it('Junk is off', () => assert.equal(fp.routeMode('fast'), false));
		it('Cycle: off -> shortest -> safe -> off', () => {
			assert.equal(fp.nextRouteMode(false), 'shortest');
			assert.equal(fp.nextRouteMode('shortest'), 'safe');
			assert.equal(fp.nextRouteMode('safe'), false);
		});
		it('Saved safe mode', () => assert.equal(fp.flags(fp.settings({ favoritesPanel: { systems: { 30000142: { route: 'safe' } } } }), JITA).route, 'safe'));
		it('routeModes', () => assert.deepEqual(
			fp.routeModes([JITA, AMARR, DODIXIE], fp.settings({ favoritesPanel: { systems: { 30000142: { route: true }, 30002659: { route: 'safe' } } } })),
			[{ systemID: JITA, mode: 'shortest' }, { systemID: DODIXIE, mode: 'safe' }]));
	});

	describe('gateDistances', () => {
		// a(HS) - b(LS) - c(HS); a - d(HS) - e(HS) - c; z = Zarzakh between a and c
		const a = 30000001, b = 30000002, c = 30000003, d = 30000004, e = 30000005, z = 30000006;
		const hs = { regionID: 10000001, security: 0.9 }, ls = { regionID: 10000001, security: 0.3 };
		const systems = { [a]: hs, [b]: ls, [c]: hs, [d]: hs, [e]: hs, [z]: { regionID: 10000001, security: -1, name: 'Zarzakh' } };
		const map = { 1: { 2: 0, 4: 0, 6: 0 }, 2: { 1: 0, 3: 0 }, 3: { 2: 0, 5: 0, 6: 0 }, 4: { 1: 0, 5: 0 }, 5: { 4: 0, 3: 0 }, 6: { 1: 0, 3: 0 } };
		it('Shortest goes through low-sec', () => assert.equal(fp.gateDistances(map, systems, a, false)[c], 2));
		it('Never through Zarzakh', () => assert.equal(fp.gateDistances(map, systems, a, false)[z], 1));
		it('Safe stays in high-sec', () => assert.equal(fp.gateDistances(map, systems, a, true)[c], 3));
		it('Safe: may start in low-sec', () => assert.equal(fp.gateDistances(map, systems, b, true)[a], 1));
		it('Safe: low-sec is reached as a destination, never passed through', () => {
			const d = fp.gateDistances(map, systems, a, true);
			assert.equal(d[b], 1);
			assert.equal(d[c], 3);
		});
		it('Avoid list: reached as a destination, never passed through', () => {
			const named = Object.assign({}, systems, { [d]: Object.assign({ name: 'Dee' }, hs) });
			const dist = fp.gateDistances({ 1: { 4: 0 }, 4: { 1: 0, 5: 0 }, 5: { 4: 0 } }, named, a, false, { dee: true });
			assert.equal(dist[d], 1);
			assert.equal(dist[e], undefined);
		});
		it('passable', () => {
			assert.ok(fp.passable(hs, true));
			assert.ok(!fp.passable(ls, true));
			assert.ok(fp.passable(ls, false));
			assert.ok(!fp.passable({ name: 'Zarzakh', security: -1, regionID: 10000001 }, false));
			assert.ok(!fp.passable({ name: 'Tama', security: 0.3, regionID: 10000001 }, false, { tama: true }));
			assert.ok(!fp.passable(undefined, false));
		});
		it('Unknown start', () => assert.deepEqual(fp.gateDistances(map, systems, null, false), {}));
	});

	describe('routes', () => {
		// Chain: HOME (C5) with holes to A (HS), B (low-sec) and U (HS).
		// Gates: L (HS, off the chain) - A; B - F (1 jump, but B is low-sec); U - Q1 - Q2 - F (high-sec);
		// L - D1 - D2 - D3 - D4 - D5 - D6 - F (direct, 7 jumps, high-sec); B - T (low-sec favourite).
		const R = 10000001;
		const L = 30000001, A = 30000002, B = 30000003, U = 30000004, F = 30000005, Q1 = 30000006, Q2 = 30000007,
			D = [30000011, 30000012, 30000013, 30000014, 30000015, 30000016], T = 30000020, JOFF = 31000099,
			N = 30000021, M = 30000022;	// low-sec favourites one gate from high-sec D[2] / Q1
		const hs = { regionID: R, security: 0.8 }, ls = { regionID: R, security: 0.2 };
		const systems = { [HOME]: { regionID: 11000001, class: 5 }, [JOFF]: { regionID: 11000001, class: 3 },
			[L]: hs, [A]: hs, [B]: ls, [U]: hs, [F]: hs, [Q1]: hs, [Q2]: hs, [T]: ls, [N]: ls, [M]: ls };
		D.forEach(d => { systems[d] = hs; });
		const map = {};
		const link = (x, y) => { (map[x - 30000000] = map[x - 30000000] || {})[y - 30000000] = 0; (map[y - 30000000] = map[y - 30000000] || {})[x - 30000000] = 0; };
		link(L, A); link(B, F); link(U, Q1); link(Q1, Q2); link(Q2, F); link(B, T); link(D[2], N); link(Q1, M);
		[L].concat(D, [F]).forEach((x, i, all) => { if (i) { link(all[i - 1], x); } });
		const distances = (id, safe) => fp.gateDistances(map, systems, id, safe);
		const exits = [{ systemID: A, nodeID: 2 }, { systemID: B, nodeID: 3 }, { systemID: U, nodeID: 4 }];
		const world = () => ({
			map: { rows: [row(1, HOME, null, 'top-level'), row(2, A, 1), row(3, B, 1), row(4, U, 1)] },
			lines: [[4, 1, [], 104], [3, 1, [], 103], [2, 1, [], 102]]
		});
		const withCalc = () => {
			const r = world();
			r.map.rows.push(calcRow(5, F, 3, 1));
			r.lines.unshift([5, 3, [], undefined]);
			return r;
		};
		const ctx = (r, start) => fp.context(r, start, exits, distances, systems);
		const lineIds = (r, cls) => r.lines.filter(l => l[2].indexOf(cls) >= 0).map(l => l[3] === undefined ? 'calc' + l[0] : l[3]).sort();

		it('Off the chain in k-space: gates in, wormholes, gates out (shortest)', () => {
			const p = fp.plan(ctx(world(), L), F, 'shortest');
			assert.equal(p.status, 'ok');
			assert.equal(p.kind, 'chain');
			assert.deepEqual([p.gatesIn, p.holes, p.gatesOut], [1, 2, 1]);
			assert.equal(p.entrySystemID, A);
			assert.equal(p.exitSystemID, B);
		});
		it('Safe picks a different, high-sec exit', () => {
			const p = fp.plan(ctx(world(), L), F, 'safe');
			assert.deepEqual([p.gatesIn, p.holes, p.gatesOut], [1, 2, 3]);
			assert.equal(p.exitSystemID, U);
		});
		it('Direct gates win when quicker', () => {
			const p = fp.plan(ctx(world(), L), D[1], 'shortest');
			assert.equal(p.kind, 'direct');
			assert.equal(p.gatesIn, 2);
			assert.equal(fp.planText(p), 'direct 2g');
		});
		it('On the chain: wormholes then gates', () => {
			const p = fp.plan(ctx(world(), HOME), F, 'shortest');
			assert.deepEqual([p.gatesIn, p.holes, p.gatesOut], [0, 1, 1]);
			assert.equal(fp.planText(p), '1wh → 1g');
		});
		it('Favourite on the chain', () => {
			const p = fp.plan(ctx(world(), HOME), U, 'safe');
			assert.deepEqual([p.holes, p.gatesOut, p.exitSystemID], [1, 0, U]);
		});
		it('No safe route', () => {
			const c = ctx(world(), HOME);
			assert.equal(fp.plan(c, T, 'shortest').status, 'ok');
			assert.equal(fp.plan(c, T, 'safe').status, 'no-route');
			assert.equal(fp.planDetail(fp.plan(c, T, 'safe'), 'T', String), 'no high-sec-only route');
		});
		it('J-space off the chain: no route', () => {
			const p = fp.plan(ctx(world(), JOFF), F, 'shortest');
			assert.equal(p.status, 'no-location');
			assert.equal(p.reason, 'off-chain');
		});
		it('Safe: k-space start to a low-sec favourite one gate from high-sec goes direct', () => {
			const p = fp.plan(ctx(world(), L), N, 'safe');
			assert.equal(p.status, 'ok');
			assert.equal(p.kind, 'direct');
			assert.equal(p.gatesIn, 4);
		});
		it('Safe: high-sec system on the chain to a low-sec favourite by gates', () => {
			const p = fp.plan(ctx(world(), U), M, 'safe');
			assert.equal(p.kind, 'direct');
			assert.equal(p.gatesIn, 2);
		});
		it('Safe: a low-sec chain exit is never gated through', () => {
			const p = fp.plan(ctx(world(), HOME), F, 'safe');
			assert.equal(p.exitSystemID, U);
			assert.equal(fp.plan(ctx(world(), HOME), F, 'shortest').exitSystemID, B);
		});
		it('Not tracked', () => assert.equal(fp.plan(ctx(world(), null), F, 'shortest').reason, 'untracked'));
		it('In the favourite', () => assert.equal(fp.plan(ctx(world(), F), F, 'safe').status, 'here'));
		it('Location on a calculated node counts as off the chain (k-space: gates)', () => {
			const c = ctx(withCalc(), F);
			assert.equal(c.startOnChain, false);
			assert.equal(c.startKSpace, true);
		});

		it('decorate: shortest from off the chain marks entry, holes, calc node and its line', () => {
			const r = withCalc();
			const routes = fp.decorate(r, [{ systemID: F, mode: 'shortest' }], L, exits, distances, systems);
			assert.equal(routes[F].shortest.exitSystemID, B);
			assert.equal(routes[F].safe.exitSystemID, U);
			assert.deepEqual(lineIds(r, 'favourite-route'), [102, 103, 'calc5'].sort());
			assert.deepEqual(marked(r, 'favourite-route-exit'), [2]);
			assert.deepEqual(marked(r, 'favourite-route-node'), [5]);
			assert.deepEqual(lineIds(r, 'favourite-safe-route'), []);
		});
		it('decorate: safe uses its own classes and marks the exit when no calc node leads there', () => {
			const r = withCalc();
			fp.decorate(r, [{ systemID: F, mode: 'safe' }], L, exits, distances, systems);
			assert.deepEqual(lineIds(r, 'favourite-safe-route'), [102, 104]);
			assert.deepEqual(marked(r, 'favourite-safe-exit'), [2, 4]);
			assert.deepEqual(lineIds(r, 'favourite-route'), []);
		});
		it('decorate: direct route highlights nothing', () => {
			const r = world();
			fp.decorate(r, [{ systemID: D[1], mode: 'shortest' }], L, exits, distances, systems);
			assert.deepEqual(lineIds(r, 'favourite-route'), []);
			assert.deepEqual(marked(r, 'favourite-route'), []);
		});
		it('decorate: strips stale classes, leaves rally alone', () => {
			const r = world();
			r.lines[0][2].push('rally-route', 'favourite-route', 'favourite-safe-route');
			fp.decorate(r, [], L, exits, distances, systems);
			assert.deepEqual(r.lines[0][2], ['rally-route']);
		});
		it('markNode is idempotent', () => assert.equal(fp.markNode(fp.markNode("<div class='node x'>", 'a'), 'a'), "<div class='node a x'>"));

		it('Summary compares modes when they differ', () => {
			const c = ctx(world(), L);
			const info = { mode: 'shortest', shortest: fp.plan(c, F, 'shortest'), safe: fp.plan(c, F, 'safe') };
			const names = { [A]: 'Alpha', [B]: 'Bravo', [U]: 'Uniform' };
			const s = fp.routeSummary(info, 'Fox', id => names[id]);
			assert.equal(s.text, '1g → 2wh → 1g');
			assert.ok(s.ok);
			assert.equal(s.title, 'Route (shortest): 1g → 2wh → 1g (1 gate jump to Alpha, 2 wormhole jumps to Bravo, 1 gate jump to Fox)'
				+ ' · Safe: 1g → 2wh → 3g (1 gate jump to Alpha, 2 wormhole jumps to Uniform, 3 gate jumps to Fox)');
		});
		it('Summary: safe with no safe route is not ok', () => {
			const c = ctx(world(), HOME);
			const s = fp.routeSummary({ mode: 'safe', shortest: fp.plan(c, T, 'shortest'), safe: fp.plan(c, T, 'safe') }, 'T', String);
			assert.equal(s.ok, false);
			assert.ok(/no high-sec-only route/.test(s.title));
			assert.ok(/Shortest: 1wh/.test(s.title));
		});
		it('Summary: direct', () => assert.equal(fp.planDetail({ status: 'ok', kind: 'direct', gatesIn: 9 }, 'X', String), 'direct: 9 gate jumps, no wormholes'));
		it('Summary: off', () => assert.equal(fp.routeSummary(null).ok, false));
	});
});
