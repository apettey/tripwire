const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/guidance');
include('app/js/systemAnalysis');
include('app/js/fork/route-destinations');

const sid = name => Number(Object.keys(appData.systems).find(k => appData.systems[k].name === name));
const JITA = sid('Jita'), PERIMETER = sid('Perimeter'), AMARR = sid('Amarr'), RENS = sid('Rens'),
	ICHORIYA = sid('Ichoriya'), THERA = sid('Thera'), J152820 = sid('J152820');

// Rows shaped like chain.nodes() output
function root(v, systemID) { return { c: [{ v: v, systemID: systemID, f: '' }, { v: null }] }; }
function link(v, parent, systemID, name, extra) {
	return Object.assign({ c: [{ v: v, systemID: systemID, f: '' }, { v: parent }], pathHome: [{ systemID: systemID, name: name }] }, extra || {});
}

describe('Route destinations', () => {
	beforeEach(() => {
		options = { chain: { routeIgnore: { enabled: false, systems: [] }, routeSecurity: 'shortest', routingLimit: 15 } };
		guidance.clearCache();
	});

	describe('k-space filter', () => {
		it('High-sec', () => assert.ok(routeDestinations.isKSpace(JITA)));
		it('String ID', () => assert.ok(routeDestinations.isKSpace('' + JITA)));
		it('Pochven', () => assert.ok(routeDestinations.isKSpace(ICHORIYA)));
		it('J-space', () => assert.ok(!routeDestinations.isKSpace(J152820)));
		it('Thera', () => assert.ok(!routeDestinations.isKSpace(THERA)));
		it('Unknown chain pseudo-system', () => assert.ok(!routeDestinations.isKSpace('5|1234')));
		it('Generic type ID', () => assert.ok(!routeDestinations.isKSpace(5)));
		it('Nothing', () => assert.ok(!routeDestinations.isKSpace(undefined)));
	});

	describe('Jumps', () => {
		it('Perimeter to Jita is 1', () => assert.equal(routeDestinations.jumps(PERIMETER, JITA), 1));
		it('Jita to itself is 0', () => assert.equal(routeDestinations.jumps(JITA, JITA), 0));
		it('Jita to Amarr', () => assert.equal(routeDestinations.jumps(JITA, AMARR), 11));
		it('No gate route to Pochven', () => assert.equal(routeDestinations.jumps(JITA, ICHORIYA), null));
		it('Pseudo-system has no route', () => assert.equal(routeDestinations.jumps('5|1234', JITA), null));
		it('Path starts at the exit', () => {
			const r = routeDestinations.route(PERIMETER, JITA);
			assert.deepEqual(r.path, [PERIMETER - 30000000, JITA - 30000000]);
		});
	});

	describe('Saved list', () => {
		it('Missing options key', () => {
			delete options.routeDestinations;
			assert.deepEqual(routeDestinations.saved(), []);
		});
		it('Sanitises bad entries and duplicates', () => assert.deepEqual(
			routeDestinations.sanitize([{ systemID: '' + JITA, show: 1 }, { systemID: JITA, show: false }, { systemID: J152820, show: true }, null, { systemID: 'x' }]),
			[{ systemID: JITA, show: true }]
		));
		it('Add by name (shown by default)', () => {
			const r = routeDestinations.add([], 'jita');
			assert.equal(r.error, undefined);
			assert.deepEqual(r.list, [{ systemID: JITA, show: true }]);
		});
		it('Add by ID', () => assert.deepEqual(routeDestinations.add([], '' + AMARR).list, [{ systemID: AMARR, show: true }]));
		it('Rejects J-space', () => {
			const r = routeDestinations.add([], 'J152820');
			assert.ok(/k-space/.test(r.error));
			assert.deepEqual(r.list, []);
		});
		it('Rejects unknown', () => assert.ok(routeDestinations.add([], 'Not A System').error));
		it('Rejects duplicate', () => assert.ok(/already/.test(routeDestinations.add([{ systemID: JITA, show: false }], 'Jita').error)));
		it('Remove', () => assert.deepEqual(routeDestinations.remove([{ systemID: JITA, show: true }, { systemID: AMARR, show: true }], '' + JITA), [{ systemID: AMARR, show: true }]));
		it('Toggle one', () => assert.deepEqual(
			routeDestinations.setShow([{ systemID: JITA, show: true }, { systemID: AMARR, show: true }], AMARR, false),
			[{ systemID: JITA, show: true }, { systemID: AMARR, show: false }]));
		it('Show all / all shown', () => {
			const list = routeDestinations.setAllShow([{ systemID: JITA, show: false }, { systemID: AMARR, show: true }], true);
			assert.ok(routeDestinations.allShown(list));
			assert.ok(!routeDestinations.allShown(routeDestinations.setAllShow(list, false)));
			assert.ok(!routeDestinations.allShown([]));
		});
	});

	describe('Chain exits', () => {
		const rows = [
			root(1, '' + J152820),
			link(2, 1, '' + RENS, 'Exit R'),
			link(3, 1, '6|4242', ''),							// unknown low-sec
			link(4, 1, '' + sid('J135100'), ''),			// J-space
			link(5, 4, '' + PERIMETER, 'Peri'),
			link(6, 5, '' + JITA, '', { pathHome: [{ systemID: JITA, path: [1, 2] }] }),	// calculated (favorite) node
			link(7, 2, '' + RENS, 'loop'),					// loop back to Rens
			{ c: [false, { v: null }] }						// upstream topLevel() can return false
		];
		it('Only k-space, first occurrence, no calculated nodes', () => assert.deepEqual(
			routeDestinations.chainExits(rows),
			[{ systemID: RENS, nodeID: 2, holeName: 'Exit R' }, { systemID: PERIMETER, nodeID: 5, holeName: 'Peri' }]
		));
		it('K-space root', () => assert.deepEqual(routeDestinations.chainExits([root(1, '' + AMARR)]), [{ systemID: AMARR, nodeID: 1, holeName: '' }]));
		it('Ignores synthetic rows', () => assert.deepEqual(routeDestinations.chainExits([{ c: [{ v: 'dest-1-1', systemID: 0 }, { v: 1 }], destination: {} }]), []));
	});

	describe('Best exit', () => {
		const exits = [
			{ systemID: RENS, nodeID: 2, holeName: 'R' },
			{ systemID: AMARR, nodeID: 3, holeName: '' },
			{ systemID: PERIMETER, nodeID: 5, holeName: 'P' }
		];
		it('Picks the exit with fewest jumps', () => {
			const ev = routeDestinations.evaluate(exits, JITA, 15);
			assert.equal(ev.best.exit.systemID, PERIMETER);
			assert.equal(ev.best.jumps, 1);
			assert.deepEqual(ev.routes.map(r => r.exit.systemID), [PERIMETER, AMARR, RENS]);
		});
		it('Map shows every exit within the limit', () =>
			assert.deepEqual(routeDestinations.evaluate(exits, JITA, 11).onMap.map(r => r.exit.systemID), [PERIMETER, AMARR]));
		it('Map shows only the best exit when none are within the limit', () =>
			assert.deepEqual(routeDestinations.evaluate(exits, JITA, 0).onMap.map(r => r.exit.systemID), [PERIMETER]));
		it('Nothing on the map when the destination is on the chain', () =>
			assert.deepEqual(routeDestinations.evaluate(exits, AMARR, 15).onMap, []));
		it('No route at all', () => {
			const ev = routeDestinations.evaluate(exits, ICHORIYA, 15);
			assert.equal(ev.best, null);
			assert.deepEqual(ev.onMap, []);
		});
		it('No exits', () => assert.equal(routeDestinations.evaluate([], JITA, 15).best, null));
	});

	describe('Synthetic rows', () => {
		const exits = [{ systemID: PERIMETER, nodeID: 5, holeName: 'P' }, { systemID: RENS, nodeID: 2, holeName: '' }];
		it('Only shown destinations, flagged and attached to the exit node', () => {
			const r = routeDestinations.syntheticRows(exits, [{ systemID: JITA, show: true }, { systemID: AMARR, show: false }], 0);
			assert.equal(r.rows.length, 1);
			assert.equal(r.rows[0].c[0].v, 'dest-5-' + JITA);
			assert.equal(r.rows[0].c[0].systemID, 0);
			assert.equal(r.rows[0].c[1].v, 5);
			assert.deepEqual(r.rows[0].destination, { systemID: JITA, exitSystemID: PERIMETER, jumps: 1 });
			assert.deepEqual(r.lines, [['dest-5-' + JITA, 5, ['destination-route'], null]]);
		});
		it('Node markup: class, name, jumps', () => {
			const f = routeDestinations.syntheticRows(exits, [{ systemID: JITA, show: true }], 0).rows[0].c[0].f;
			assert.ok(f.indexOf("id='nodedest-5-" + JITA + "'") >= 0);
			assert.ok(f.indexOf('destination-node') >= 0);
			assert.ok(f.indexOf("<span class='hisec'>HS</span>") >= 0);
			assert.ok(f.indexOf('>JITA</a>') >= 0);
			assert.ok(f.indexOf("<h4 class='destJumps'>1</h4>") >= 0);
			assert.ok(f.indexOf('data-nodeid') < 0, 'must not look like a real system node');
			assert.ok(f.indexOf('nodeSystem') < 0, 'must not trigger the system context menu');
		});
		it('Decorate appends rows and lines to chain.nodes() output', () => {
			const result = {
				map: { rows: [root(1, '' + J152820), link(2, 1, '' + PERIMETER, 'P')] },
				lines: [[2, 1, [], 99]]
			};
			routeDestinations.decorate(result, [{ systemID: JITA, show: true }], 15);
			assert.equal(result.map.rows.length, 3);
			assert.equal(result.map.rows[2].c[0].v, 'dest-2-' + JITA);
			assert.deepEqual(result.lines.map(l => l[0]), ['dest-2-' + JITA, 2]);
			assert.deepEqual(routeDestinations.lastExits, [{ systemID: PERIMETER, nodeID: 2, holeName: 'P' }]);
		});
		it('Decorate with nothing shown leaves the map alone', () => {
			const result = { map: { rows: [root(1, '' + PERIMETER)] }, lines: [] };
			routeDestinations.decorate(result, [{ systemID: JITA, show: false }], 15);
			assert.equal(result.map.rows.length, 1);
			assert.deepEqual(result.lines, []);
		});
		it('Decorate tolerates missing saved options', () => {
			delete options.routeDestinations;
			const result = { map: { rows: [root(1, '' + PERIMETER)] }, lines: [] };
			routeDestinations.decorate(result);
			assert.equal(result.map.rows.length, 1);
		});
	});

	describe('Window rows', () => {
		it('Empty list', () => assert.ok(/No destinations yet/.test(routeDestinations.renderRows([], [], 15))));
		it('Best exit with hole name and jumps', () => {
			const html = routeDestinations.renderRows([{ systemID: JITA, show: true }], [{ systemID: PERIMETER, nodeID: 2, holeName: 'Out<b>' }], 15);
			assert.ok(html.indexOf("<span class='hisec'>Perimeter</span>") >= 0);
			assert.ok(html.indexOf('(Out&lt;b&gt;)') >= 0);
			assert.ok(html.indexOf("<td class='route-dest-jumps'>1</td>") >= 0);
			assert.ok(html.indexOf(' checked') >= 0);
		});
		it('No exits on the chain', () => assert.ok(/No k-space exit/.test(routeDestinations.renderRows([{ systemID: JITA, show: false }], [], 15))));
	});
});
