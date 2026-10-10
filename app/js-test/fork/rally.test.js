const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/rally');

// Dev map: J152820 home with holes to J135100, J160650, a low-sec and a C5;
// J135100 -> J205738 and a high-sec; J160650 -> another low-sec.
const HOME = 31000001, J135100 = 31000002, J160650 = 31000003, LS1 = 30000162, C5 = 31001916,
	J205738 = 31000004, HS = 30000001, LS2 = 30000163;

function node(id, systemID, cls) {
	return { v: id, systemID: systemID, f: "<div id='node" + id + "' data-nodeid='" + systemID + "' class='node " + (cls || '') + "'></div>" };
}
function row(id, systemID, parent, cls) { return { c: [node(id, systemID, cls), { v: parent }] }; }

function devMap() {
	return {
		map: { rows: [
			row(1, HOME, null, 'top-level'),
			row(2, J135100, 1), row(3, J160650, 1), row(4, LS1, 1), row(5, C5, 1),
			row(6, J205738, 2), row(7, HS, 2),
			row(8, LS2, 3)
		] },
		// [childNodeId, parentNodeId, modifiers, wormholeId]
		lines: [
			[8, 3, [], 108], [7, 2, ['eol'], 107], [6, 2, [], 106],
			[5, 1, ['frig'], 105], [4, 1, [], 104], [3, 1, [], 103], [2, 1, ['jm-375kt'], 102]
		]
	};
}

describe('Rally', () => {
	describe('isRealSystemID', () => {
		it('J-space', () => assert.ok(rally.isRealSystemID(31000002)));
		it('K-space as string', () => assert.ok(rally.isRealSystemID('30000142')));
		it('Unknown-system pseudo ID', () => assert.ok(!rally.isRealSystemID('31000002|1234')));
		it('Class placeholder', () => assert.ok(!rally.isRealSystemID(5)));
		it('Out of range', () => assert.ok(!rally.isRealSystemID(32000001)));
		it('Null', () => assert.ok(!rally.isRealSystemID(null)));
		it('Empty', () => assert.ok(!rally.isRealSystemID('')));
	});

	describe('routeTo', () => {
		const edges = [['a', 'b', [], 1], ['b', 'c', [], 2], ['c', 'd', [], 3], ['a', 'd', [], 4], ['d', 'e', [], 5], ['x', 'y', [], 6]];
		it('Same node', () => assert.deepEqual(rally.routeTo(edges, 'a', 'a'), []));
		it('Direct', () => assert.deepEqual(rally.routeTo(edges, 'a', 'b'), [1]));
		it('Shortest of two', () => assert.deepEqual(rally.routeTo(edges, 'a', 'e'), [4, 5]));
		it('Against connection direction', () => assert.deepEqual(rally.routeTo(edges, 'e', 'a'), [5, 4]));
		it('Unreachable', () => assert.equal(rally.routeTo(edges, 'a', 'x'), null));
		it('Unknown start', () => assert.equal(rally.routeTo(edges, 'zz', 'a'), null));
		it('Numbers and strings match', () => assert.deepEqual(rally.routeTo([[1, 2, [], 'w']], '1', 2), ['w']));
		it('No connections', () => assert.equal(rally.routeTo([], 'a', 'b'), null));
		it('Missing target', () => assert.equal(rally.routeTo(edges, 'a', null), null));
	});

	describe('pickStart', () => {
		const onMap = { '1': true, '2': true };
		it('Tracked on map', () => assert.equal(rally.pickStart(onMap, 2, 1, '1'), '2'));
		it('Tracked off map, viewing on map', () => assert.equal(rally.pickStart(onMap, 9, 2, '1'), '2'));
		it('Neither on map', () => assert.equal(rally.pickStart(onMap, 9, 8, '1'), '1'));
		it('No tracking', () => assert.equal(rally.pickStart(onMap, null, 2, '1'), '2'));
	});

	describe('rootSystem', () => {
		it('First top-level', () => assert.equal(rally.rootSystem(devMap().map.rows), String(HOME)));
		it('Empty', () => assert.equal(rally.rootSystem([]), null));
	});

	describe('markNode', () => {
		it('Adds class', () => assert.equal(rally.markNode("<div class='node top-level'>"), "<div class='node rally-node top-level'>"));
		it('Idempotent', () => assert.equal(rally.markNode(rally.markNode("<div class='node '>")), "<div class='node rally-node '>"));
	});

	describe('decorate', () => {
		const routeLines = r => r.lines.filter(l => l[2].indexOf('rally-route') >= 0).map(l => l[3]);
		const markedNodes = r => r.map.rows.filter(x => x.c[0].f.indexOf('rally-node') >= 0).map(x => x.c[0].systemID);

		it('From home to J205738', () => {
			const r = devMap();
			const info = rally.decorate(r, J205738, { tracked: HOME, viewing: HOME });
			assert.equal(info.jumps, 2);
			assert.equal(info.startSystemID, String(HOME));
			assert.deepEqual(routeLines(r).sort(), [102, 106]);
			assert.deepEqual(markedNodes(r), [J205738]);
			assert.deepEqual(r.lines.filter(l => l[3] == 102)[0][2], ['jm-375kt', 'rally-route']);
		});
		it('From J205738 back to the low-sec behind J160650 (crosses the root)', () => {
			const r = devMap();
			const info = rally.decorate(r, LS2, { tracked: J205738, viewing: HOME });
			assert.equal(info.jumps, 4);
			assert.deepEqual(routeLines(r).sort(), [102, 103, 106, 108]);
		});
		it('Tracked character off the map uses viewing system', () => {
			const r = devMap();
			const info = rally.decorate(r, HS, { tracked: 30000142, viewing: J135100 });
			assert.equal(info.startSystemID, String(J135100));
			assert.equal(info.jumps, 1);
			assert.deepEqual(routeLines(r), [107]);
		});
		it('Neither on map uses root', () => {
			const r = devMap();
			const info = rally.decorate(r, C5, { tracked: null, viewing: 30000142 });
			assert.equal(info.startSystemID, String(HOME));
			assert.deepEqual(routeLines(r), [105]);
		});
		it('Already there', () => {
			const r = devMap();
			const info = rally.decorate(r, J135100, { tracked: J135100 });
			assert.equal(info.jumps, 0);
			assert.deepEqual(routeLines(r), []);
			assert.deepEqual(markedNodes(r), [J135100]);
		});
		it('Rally not on map', () => {
			const r = devMap();
			const info = rally.decorate(r, 30000142, { tracked: HOME });
			assert.equal(info.onMap, false);
			assert.equal(info.jumps, null);
			assert.deepEqual(routeLines(r), []);
			assert.deepEqual(markedNodes(r), []);
		});
		it('No rally strips stale route classes', () => {
			const r = devMap();
			r.lines[0][2].push('rally-route');
			rally.decorate(r, null, {});
			assert.deepEqual(routeLines(r), []);
		});
		it('Ignores calculated (gate) connections', () => {
			const r = devMap();
			r.map.rows.push(row(9, 30000142, 7, 'calc'));
			r.lines.push([9, 7, [], undefined]);
			const info = rally.decorate(r, 30000142, { tracked: HOME });
			assert.equal(info.onMap, true);
			assert.equal(info.jumps, null);
			assert.deepEqual(routeLines(r), []);
		});
		it('Loop: system shown twice routes by the shortest hole', () => {
			const r = devMap();
			// A second hole from home straight to J205738 (shown as a loop node)
			r.map.rows.push(row(9, J205738, 1, 'loop'));
			r.lines.push([9, 1, [], 109]);
			const info = rally.decorate(r, J205738, { tracked: HOME });
			assert.equal(info.jumps, 1);
			assert.deepEqual(routeLines(r), [109]);
			assert.deepEqual(markedNodes(r), [J205738, J205738]);
		});
	});

	describe('routeText', () => {
		it('Jumps', () => assert.equal(rally.routeText({ onMap: true, jumps: 2 }), '2 jumps'));
		it('One jump', () => assert.equal(rally.routeText({ onMap: true, jumps: 1 }), '1 jump'));
		it('Here', () => assert.equal(rally.routeText({ onMap: true, jumps: 0 }), 'you are here'));
		it('No route', () => assert.equal(rally.routeText({ onMap: true, jumps: null }), 'no route'));
		it('Off map', () => assert.equal(rally.routeText({ onMap: false }), 'not on this map'));
		it('Unknown', () => assert.equal(rally.routeText(null), 'not on this map'));
	});

	describe('discordEnabled', () => {
		it('On when the option is missing', () => assert.equal(rally.discordEnabled({}), true));
		it('On without options', () => assert.equal(rally.discordEnabled(null), true));
		it('On when enabled', () => assert.equal(rally.discordEnabled({ rallyDiscord: { enabled: true } }), true));
		it('Off when disabled', () => assert.equal(rally.discordEnabled({ rallyDiscord: { enabled: false } }), false));
		it('On for an empty entry', () => assert.equal(rally.discordEnabled({ rallyDiscord: {} }), true));
	});

	describe('changePayload', () => {
		it('Posts when a webhook exists and the user wants it', () =>
			assert.deepEqual(rally.changePayload({ mode: 'set', systemID: HOME }, true, {}), { mode: 'set', systemID: HOME, discord: 1 }));
		it('Not when the user unticked it', () =>
			assert.deepEqual(rally.changePayload({ mode: 'clear' }, true, { rallyDiscord: { enabled: false } }), { mode: 'clear', discord: 0 }));
		it('Not without a webhook', () =>
			assert.deepEqual(rally.changePayload({ mode: 'clear' }, false, {}), { mode: 'clear', discord: 0 }));
		it('Leaves the input alone', () => {
			const input = { mode: 'clear' };
			rally.changePayload(input, true, {});
			assert.deepEqual(input, { mode: 'clear' });
		});
	});
});
