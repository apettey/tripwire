const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/rally');
include('app/js/fork/favourites-panel');

const fp = favouritesPanel;
const HOME = 31000001, J135100 = 31000002, AMAMAKE = 30002537, UEDAMA = 30002768,
	JITA = 30000142, AMARR = 30002187, DODIXIE = 30002659;

function node(id, systemID, cls) {
	return { v: id, systemID: systemID, f: "<div id='node" + id + "' data-nodeid='" + systemID + "' class='node " + (cls || '') + "'></div>" };
}
function row(id, systemID, parent, cls, extra) { return Object.assign({ c: [node(id, systemID, cls), { v: parent }] }, extra || {}); }
function calcRow(id, systemID, parent, jumps) {
	return row(id, systemID, parent, 'calc', { pathHome: [{ systemID: 1 }, { systemID: systemID, path: [1, 2], jumps: jumps }] });
}

// HOME -> J135100 -> Uedama (HS); HOME -> Amamake (LS)
function chainMap() {
	return {
		map: { rows: [
			row(1, HOME, null, 'top-level'),
			row(2, J135100, 1), row(3, AMAMAKE, 1), row(4, UEDAMA, 2)
		] },
		lines: [[4, 2, [], 104], [3, 1, [], 103], [2, 1, [], 102]]
	};
}
// The same map with calculated nodes to Jita: 2 jumps from Uedama... and 20 from Amamake
function chainMapWithCalc() {
	const r = chainMap();
	r.map.rows.push(calcRow(5, JITA, 4, 2), calcRow(6, JITA, 3, 20));
	r.lines.unshift([5, 4, [], undefined], [6, 3, [], undefined]);
	return r;
}
const routeLines = r => r.lines.map((l, i) => l[2].indexOf('favourite-route') >= 0 ? (l[3] === undefined ? 'calc' + l[0] : l[3]) : null).filter(x => x !== null);
const marked = (r, cls) => r.map.rows.filter(x => x.c[0].f.indexOf(cls) >= 0).map(x => x.c[0].v);

describe('Favourites panel', () => {
	describe('settings', () => {
		it('Missing key: enabled, no flags', () => assert.deepEqual(fp.settings({}), { enabled: true, systems: {} }));
		it('No options at all', () => assert.deepEqual(fp.settings(undefined), { enabled: true, systems: {} }));
		it('Disabled', () => assert.equal(fp.settings({ favoritesPanel: { enabled: false } }).enabled, false));
		it('Flags normalised, junk dropped', () => assert.deepEqual(
			fp.settings({ favoritesPanel: { systems: { '30000142': { map: false }, '30002187': { route: true }, 'x|1': { map: false }, '30002659': null } } }).systems,
			{ 30000142: { map: false, route: false }, 30002187: { map: true, route: true } }));
		it('Keeps a saved position', () => assert.deepEqual(fp.settings({ favoritesPanel: { position: { col: 3 } } }).position, { col: 3 }));
		it('enabled(): missing means on', () => assert.ok(fp.enabled({})));
		it('enabled(): explicit false', () => assert.ok(!fp.enabled({ favoritesPanel: { enabled: false } })));
		it('enabled(): anything else is on', () => assert.ok(fp.enabled({ favoritesPanel: { enabled: 'yes' } })));
	});

	describe('flags', () => {
		const s = fp.settings({ favoritesPanel: { systems: { 30000142: { map: false, route: true } } } });
		it('Defaults: map on, route off', () => assert.deepEqual(fp.flags(s, AMARR), { map: true, route: false }));
		it('Saved', () => assert.deepEqual(fp.flags(s, JITA), { map: false, route: true }));
		it('String ID', () => assert.deepEqual(fp.flags(s, '30000142'), { map: false, route: true }));
		it('setFlag turns route on', () => assert.deepEqual(fp.setFlag(fp.settings({}), AMARR, 'route', true).systems, { 30002187: { map: true, route: true } }));
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
		it('gridEntry from array', () => assert.equal(fp.gridEntry(widgets.concat([{ id: 'favouritesWidget', col: 3 }]), 'favouritesWidget').col, 3));
		it('gridEntry from object', () => assert.equal(fp.gridEntry({ 0: { id: 'favouritesWidget', col: 4 } }, 'favouritesWidget').col, 4));
		it('gridEntry from old oog format', () => assert.equal(fp.gridEntry({ oog: [{ id: 'favouritesWidget', col: 5 }] }, 'favouritesWidget').col, 5));
		it('gridEntry: layout saved before the panel existed', () => assert.equal(fp.gridEntry(widgets, 'favouritesWidget'), null));
		it('gridEntry: no layout', () => assert.equal(fp.gridEntry({}, 'favouritesWidget'), null));
		it('defaultPlacement: right of the widgets, full height', () => assert.deepEqual(fp.defaultPlacement(widgets), { col: 22, row: 1, size_x: 5, size_y: 14 }));
		it('defaultPlacement: fits in a wide window', () => assert.equal(fp.defaultPlacement(widgets, 30).col, 22));
		it('defaultPlacement: narrow window goes below', () => assert.deepEqual(fp.defaultPlacement(widgets, 24), { col: 1, row: 15, size_x: 7, size_y: 8 }));
		it('defaultPlacement: empty grid', () => assert.deepEqual(fp.defaultPlacement([]), { col: 1, row: 1, size_x: 5, size_y: 8 }));
		it('savedPlacement enforces the minimum size', () => assert.deepEqual(fp.savedPlacement({ col: '2', row: '3', size_x: 1, size_y: 9 }), { col: 2, row: 3, size_x: 4, size_y: 9 }));
		it('savedPlacement rejects junk', () => assert.equal(fp.savedPlacement({ col: 0, row: 1 }), null));
	});

	describe('routes', () => {
		const exits = [{ systemID: AMAMAKE, nodeID: 3 }, { systemID: UEDAMA, nodeID: 4 }];
		const gates = { [AMAMAKE + '>' + JITA]: 20, [UEDAMA + '>' + JITA]: 2, [AMAMAKE + '>' + AMARR]: 9, [UEDAMA + '>' + AMARR]: 9 };
		const gateJumps = (from, to) => gates[from + '>' + to] === undefined ? null : gates[from + '>' + to];

		it('Via a calculated node: picks fewest total jumps', () => {
			const r = chainMapWithCalc();
			const info = fp.route(r, JITA, HOME, exits, gateJumps);
			assert.equal(info.status, 'ok');
			assert.equal(info.kind, 'calc');
			assert.equal(info.holes, 2);
			assert.equal(info.gates, 2);
			assert.equal(info.exitSystemID, UEDAMA);
		});
		it('Via a calculated node from the location', () => {
			const r = chainMapWithCalc();
			const routes = fp.decorate(r, [JITA], J135100, exits, gateJumps);
			assert.equal(routes[JITA].holes, 1);
			assert.deepEqual(routeLines(r).sort(), [104, 'calc5'].sort());
			assert.deepEqual(marked(r, 'favourite-route-node'), [5]);
		});
		it('No calculated nodes: routes to the best exit and marks it', () => {
			const r = chainMap();
			const routes = fp.decorate(r, [AMARR], HOME, exits, gateJumps);
			// Amamake: 1 hole + 9 gates beats Uedama: 2 holes + 9 gates
			assert.equal(routes[AMARR].kind, 'exit');
			assert.equal(routes[AMARR].exitSystemID, AMAMAKE);
			assert.deepEqual(routeLines(r), [103]);
			assert.deepEqual(marked(r, 'favourite-route-exit'), [3]);
		});
		it('Ties on total prefer fewer holes', () => {
			const g = (from) => from === AMAMAKE ? 3 : 2;	// Amamake 1+3, Uedama 2+2
			const info = fp.route(chainMap(), JITA, HOME, exits, g);
			assert.equal(info.exitSystemID, AMAMAKE);
		});
		it('Favourite on the chain itself', () => {
			const r = chainMap();
			const routes = fp.decorate(r, [UEDAMA], HOME, exits, gateJumps);
			assert.equal(routes[UEDAMA].kind, 'chain');
			assert.equal(routes[UEDAMA].holes, 2);
			assert.deepEqual(routeLines(r).sort(), [102, 104]);
			assert.deepEqual(marked(r, 'favourite-route-node'), [4]);
		});
		it('Already there', () => assert.equal(fp.route(chainMap(), UEDAMA, UEDAMA, exits, gateJumps).status, 'here'));
		it('No location', () => assert.equal(fp.route(chainMap(), JITA, null, exits, gateJumps).status, 'no-location'));
		it('Location not on the chain', () => assert.equal(fp.route(chainMap(), JITA, 30000144, exits, gateJumps).status, 'no-location'));
		it('No gate route from any exit', () => assert.equal(fp.route(chainMap(), DODIXIE, HOME, exits, gateJumps).status, 'no-route'));
		it('Several favourites at once', () => {
			const r = chainMapWithCalc();
			fp.decorate(r, [JITA, AMAMAKE], HOME, exits, gateJumps);
			assert.deepEqual(routeLines(r).sort(), [102, 103, 104, 'calc5'].sort());
		});
		it('Strips stale route classes', () => {
			const r = chainMap();
			r.lines[0][2].push('favourite-route');
			fp.decorate(r, [], HOME, exits, gateJumps);
			assert.deepEqual(routeLines(r), []);
		});
		it('Leaves rally classes alone', () => {
			const r = chainMap();
			r.lines[0][2].push('rally-route');
			fp.decorate(r, [UEDAMA], HOME, exits, gateJumps);
			assert.deepEqual(r.lines[0][2], ['rally-route', 'favourite-route']);
		});
		it('Location on a calculated node is not on the chain', () => {
			const r = chainMapWithCalc();
			assert.equal(fp.route(r, AMARR, JITA, exits, gateJumps).status, 'no-location');
		});
		it('Location on a destination node is not on the chain', () => {
			const r = chainMap();
			r.map.rows.push(row(9, DODIXIE, 3, '', { destination: { systemID: DODIXIE } }));
			assert.equal(fp.route(r, AMARR, DODIXIE, exits, gateJumps).status, 'no-location');
		});
		it('In the favourite but off the chain: here', () => assert.equal(fp.route(chainMap(), JITA, JITA, exits, gateJumps).status, 'here'));
		it('chainSystems skips calculated and destination rows', () => {
			const r = chainMapWithCalc();
			r.map.rows.push(row(9, DODIXIE, 3, '', { destination: {} }));
			assert.deepEqual(Object.keys(fp.chainSystems(r.map.rows)).sort(), [HOME, J135100, AMAMAKE, UEDAMA].map(String).sort());
		});
		it('Favourite on the chain far away: a gate route from a near exit wins', () => {
			// Uedama is 2 holes from home through the chain; via Amamake it's 1 hole + 0 gates (contrived)
			const g = (from, to) => from === AMAMAKE && to === UEDAMA ? 0 : null;
			const info = fp.route(chainMap(), UEDAMA, HOME, exits, g);
			assert.equal(info.kind, 'exit');
			assert.equal(info.exitSystemID, AMAMAKE);
			assert.equal(info.holes + info.gates, 1);
		});
		it('Favourite on the chain: stays on the chain route when exits are not quicker', () => {
			const info = fp.route(chainMap(), UEDAMA, HOME, exits, gateJumps);
			assert.equal(info.kind, 'chain');
		});
		it('markNode is idempotent', () => assert.equal(fp.markNode(fp.markNode("<div class='node x'>", 'a'), 'a'), "<div class='node a x'>"));
	});

	describe('routeSummary', () => {
		it('Via exit', () => assert.deepEqual(fp.routeSummary({ status: 'ok', kind: 'calc', holes: 2, gates: 1 }, 'Jita', 'Uedama'),
			{ text: '2+1j', title: '2 wormhole jumps to Uedama, then 1 gate jump to Jita' }));
		it('On the chain', () => assert.deepEqual(fp.routeSummary({ status: 'ok', kind: 'chain', holes: 1, gates: 0 }, 'Uedama', 'Uedama'),
			{ text: '1j', title: '1 wormhole jump to Uedama' }));
		it('No location', () => assert.equal(fp.routeSummary({ status: 'no-location' }, 'Jita').text, ''));
		it('No route mentions it', () => assert.ok(/No route/.test(fp.routeSummary({ status: 'no-route' }, 'Jita').title)));
	});
});
