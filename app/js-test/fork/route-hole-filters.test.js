const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/rally');
include('app/js/fork/route-hole-filters');

// Chain: A -1- B -2- D (short way), A -3- C -4- D (long way). Connections are [a, b, modifiers, lineIndex].
const CONNECTIONS = [['A', 'B', [], 1], ['B', 'D', [], 2], ['A', 'C', [], 3], ['C', 'D', [], 4]];

function ctx(holes, extra) {
	return Object.assign({
		settings: routeHoleFilters.settings({}),
		oneWay: false,
		holeOf: function(c) { return holes[c[3]] || null; }
	}, extra || {});
}

describe('routeHoleFilters', function() {
	beforeEach(function() {
		routeHoleFilters.clearFlags();
		routeHoleFilters.registerFlag('preserve', 'preserve mass hole', function(h) { return h.preserve === true; }, { own: true, short: 'preserve mass' });
	});

	describe('settings', function() {
		it('everything is on by default, ship size from the Thera route setting', function() {
			const s = routeHoleFilters.settings({});
			assert.deepStrictEqual(s, { shipSize: 'S', eol: true, crit: true, small: true, flagged: true, preserve: true });
			assert.strictEqual(routeHoleFilters.settings({ theraRoute: { shipSize: 'L' } }).shipSize, 'L');
			assert.strictEqual(routeHoleFilters.settings({ theraRoute: { shipSize: 'huge' } }).shipSize, 'S');
		});
		it('only an explicit false switches a filter off', function() {
			const s = routeHoleFilters.settings({ routeHoleFilters: { eol: false, crit: 0, preserve: false } });
			assert.strictEqual(s.eol, false);
			assert.strictEqual(s.crit, true);
			assert.strictEqual(s.preserve, false);
		});
		it('does not mutate the options and ignores junk', function() {
			const o = { routeHoleFilters: 'x' };
			routeHoleFilters.settings(o);
			assert.deepStrictEqual(o, { routeHoleFilters: 'x' });
			assert.strictEqual(routeHoleFilters.settings(null).eol, true);
		});
		it('anyOn is false when every filter is off', function() {
			const off = routeHoleFilters.settings({ routeHoleFilters: { eol: false, crit: false, small: false, flagged: false, preserve: false } });
			assert.strictEqual(routeHoleFilters.anyOn(off), false);
			assert.strictEqual(routeHoleFilters.anyOn(routeHoleFilters.settings({})), true);
			assert.strictEqual(routeHoleFilters.anyOn(null), false);
		});
	});

	describe('reasons', function() {
		const s = function(shipSize) { return Object.assign(routeHoleFilters.settings({}), { shipSize: shipSize || 'S' }); };
		it('EOL', function() {
			assert.deepStrictEqual(routeHoleFilters.reasons({ eol: true }, s()).map(r => r.key), ['eol']);
		});
		it('critical mass', function() {
			assert.deepStrictEqual(routeHoleFilters.reasons({ crit: true }, s()).map(r => r.key), ['crit']);
		});
		it('too small for the ship, never for the smallest ship or an unknown size', function() {
			assert.deepStrictEqual(routeHoleFilters.reasons({ size: 'M' }, s('L')).map(r => r.key), ['small']);
			assert.deepStrictEqual(routeHoleFilters.reasons({ size: 'L' }, s('L')), []);
			assert.deepStrictEqual(routeHoleFilters.reasons({ size: 'S' }, s('S')), []);
			assert.deepStrictEqual(routeHoleFilters.reasons({ size: null }, s('XL')), []);
			assert.deepStrictEqual(routeHoleFilters.reasons({ size: 'VL' }, s('XL')).map(r => r.key), ['small']);
		});
		it('a filter that is off does not report', function() {
			const off = Object.assign(s(), { eol: false, crit: false, small: false });
			assert.deepStrictEqual(routeHoleFilters.reasons({ eol: true, crit: true, size: 'S' }, Object.assign(off, { shipSize: 'XL' })), []);
		});
		it('nothing known about the hole is fine', function() {
			assert.deepStrictEqual(routeHoleFilters.reasons(null, s()), []);
			assert.deepStrictEqual(routeHoleFilters.reasons(undefined, null), []);
		});
		it('preserve mass has its own switch', function() {
			assert.deepStrictEqual(routeHoleFilters.reasons({ preserve: true }, s()).map(r => r.key), ['preserve']);
			const off = Object.assign(s(), { preserve: false });
			assert.deepStrictEqual(routeHoleFilters.reasons({ preserve: true }, off), []);
		});
	});

	describe('registerFlag', function() {
		it('a flag without its own switch follows "flagged by other features"', function() {
			routeHoleFilters.registerFlag('rolling', 'hole being rolled', function(h) { return h.rolling; });
			const on = routeHoleFilters.settings({});
			assert.deepStrictEqual(routeHoleFilters.reasons({ rolling: true }, on).map(r => r.key), ['rolling']);
			const off = routeHoleFilters.settings({ routeHoleFilters: { flagged: false } });
			assert.deepStrictEqual(routeHoleFilters.reasons({ rolling: true }, off), []);
			// preserve is not affected by "flagged"
			assert.deepStrictEqual(routeHoleFilters.reasons({ preserve: true }, off).map(r => r.key), ['preserve']);
		});
		it('an own flag gets a settings key; registering again replaces it', function() {
			routeHoleFilters.registerFlag('mine', 'my hole', function() { return true; }, { own: true });
			assert.strictEqual(routeHoleFilters.settings({}).mine, true);
			assert.strictEqual(routeHoleFilters.settings({ routeHoleFilters: { mine: false } }).mine, false);
			routeHoleFilters.registerFlag('mine', 'my hole', function() { return false; }, { own: true });
			assert.strictEqual(routeHoleFilters.flagList.filter(f => f.key === 'mine').length, 1);
			assert.deepStrictEqual(routeHoleFilters.reasons({}, routeHoleFilters.settings({})), []);
		});
		it('isFlagged gets the hole; a throwing flag counts as not flagged', function() {
			let seen = null;
			routeHoleFilters.registerFlag('probe', 'probe', function(h) { seen = h; return false; });
			routeHoleFilters.registerFlag('bad', 'bad', function() { throw new Error('boom'); });
			const hole = { wormholeID: 7 };
			assert.deepStrictEqual(routeHoleFilters.reasons(hole, routeHoleFilters.settings({})), []);
			assert.strictEqual(seen, hole);
		});
		it('needs a key and a function', function() {
			assert.throws(function() { routeHoleFilters.registerFlag('', 'x', function() {}); });
			assert.throws(function() { routeHoleFilters.registerFlag('x', 'x'); });
		});
	});

	describe('route', function() {
		it('with nothing wrong it is the shortest route', function() {
			const r = routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({}));
			assert.deepStrictEqual(r.path, [1, 2]);
			assert.strictEqual(r.fallback, false);
			assert.strictEqual(r.note, '');
		});
		it('goes round an EOL hole', function() {
			const r = routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 2: { eol: true } }));
			assert.deepStrictEqual(r.path, [3, 4]);
			assert.deepStrictEqual(r.marks, {});
			assert.strictEqual(r.bad, 0);
		});
		it('goes round a critical mass hole', function() {
			const r = routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 1: { crit: true } }));
			assert.deepStrictEqual(r.path, [3, 4]);
		});
		it('goes round a hole too small for the ship', function() {
			const s = Object.assign(routeHoleFilters.settings({}), { shipSize: 'L' });
			const r = routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 1: { size: 'M' } }, { settings: s }));
			assert.deepStrictEqual(r.path, [3, 4]);
		});
		it('goes round a preserve mass hole, and a hole another feature flagged', function() {
			assert.deepStrictEqual(routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 2: { preserve: true } })).path, [3, 4]);
			routeHoleFilters.registerFlag('rolling', 'hole being rolled', function(h) { return h.rolling; });
			assert.deepStrictEqual(routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 4: { rolling: true } })).path, [1, 2]);
			assert.deepStrictEqual(routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 2: { rolling: true } })).path, [3, 4]);
		});
		it('a filter that is off lets the hole through', function() {
			const s = routeHoleFilters.settings({ routeHoleFilters: { eol: false } });
			assert.deepStrictEqual(routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 2: { eol: true } }, { settings: s })).path, [1, 2]);
		});
		it('never a dead end: with no way round it uses the best route and marks the hole', function() {
			const r = routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 2: { eol: true }, 4: { crit: true } }));
			assert.deepStrictEqual(r.path, [1, 2]);	// the shortest unfiltered
			assert.strictEqual(r.fallback, true);
			assert.strictEqual(r.bad, 1);
			assert.deepStrictEqual(Object.keys(r.marks), ['2']);
			assert.strictEqual(r.marks[2][0].label, 'EOL hole');
			assert.strictEqual(r.note, 'No route avoiding EOL — this one uses 1 EOL hole');
		});
		it('the note counts each kind of hole', function() {
			const r = routeHoleFilters.route([['A', 'B', [], 1], ['B', 'C', [], 2], ['C', 'D', [], 3]], 'A', 'D',
				ctx({ 1: { eol: true }, 2: { eol: true }, 3: { crit: true } }));
			assert.strictEqual(r.bad, 3);
			assert.strictEqual(r.note, 'No route avoiding EOL/crit — this one uses 2 EOL holes and 1 critical hole');
		});
		it('only the dead-end hops are marked, not the clean ones', function() {
			const r = routeHoleFilters.route([['A', 'B', [], 1], ['B', 'D', [], 2]], 'A', 'D', ctx({ 2: { preserve: true } }));
			assert.deepStrictEqual(r.path, [1, 2]);
			assert.deepStrictEqual(Object.keys(r.marks), ['2']);
			assert.strictEqual(r.note, 'No route avoiding preserve mass — this one uses 1 preserve mass hole');
		});
		it('no route at all is null', function() {
			assert.strictEqual(routeHoleFilters.route(CONNECTIONS, 'A', 'Z', ctx({})), null);
			assert.strictEqual(routeHoleFilters.route([], 'A', 'D', ctx({ 1: { eol: true } })), null);
		});
		it('same start and target is an empty route', function() {
			assert.deepStrictEqual(routeHoleFilters.route(CONNECTIONS, 'A', 'A', ctx({})).path, []);
		});
		it('without a usable context it behaves like rally.routeTo', function() {
			assert.deepStrictEqual(routeHoleFilters.route(CONNECTIONS, 'A', 'D', null).path, [1, 2]);
			const off = routeHoleFilters.settings({ routeHoleFilters: { eol: false, crit: false, small: false, flagged: false, preserve: false } });
			assert.deepStrictEqual(routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 2: { eol: true } }, { settings: off })).path, [1, 2]);
		});
		it('uses the route function it is given', function() {
			let calls = 0;
			const r = routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({}, { routeFn: function(c) { calls++; return [9]; } }));
			assert.deepStrictEqual(r.path, [9]);
			assert.strictEqual(calls, 1);
		});
	});

	describe('one-way', function() {
		it('allows EOL and critical holes: the short way is taken', function() {
			const r = routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 2: { eol: true }, 1: { crit: true } }, { oneWay: true }));
			assert.deepStrictEqual(r.path, [1, 2]);
			assert.strictEqual(r.fallback, false);
			assert.strictEqual(r.bad, 0);
			assert.strictEqual(r.note, '');
		});
		it('still marks them', function() {
			const r = routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 2: { eol: true }, 1: { crit: true } }, { oneWay: true }));
			assert.deepStrictEqual(Object.keys(r.marks).sort(), ['1', '2']);
			assert.strictEqual(routeHoleFilters.marksText(r.marks[2]), 'EOL hole');
		});
		it('still avoids too small and flagged holes', function() {
			const r = routeHoleFilters.route(CONNECTIONS, 'A', 'D', ctx({ 2: { preserve: true } }, { oneWay: true }));
			assert.deepStrictEqual(r.path, [3, 4]);
		});
		it('the switch is remembered in the session (memory when there is no sessionStorage)', function() {
			assert.strictEqual(routeHoleFilters.oneWay(), false);
			routeHoleFilters.setOneWay(true);
			assert.strictEqual(routeHoleFilters.oneWay(), true);
			routeHoleFilters.setOneWay(false);
			assert.strictEqual(routeHoleFilters.oneWay(), false);
		});
	});

	describe('destinations: pickRoutes', function() {
		const table = function(holes, extra) { return routeHoleFilters.reasonTable(CONNECTIONS, ctx(holes, extra)); };
		const routes = [
			{ exit: { holes: [2, 1] }, jumps: 1, index: 0 },
			{ exit: { holes: [4, 3] }, jumps: 3, index: 1 }
		];
		it('exits whose way home is clean come first, dirty ones are dropped', function() {
			const picked = routeHoleFilters.pickRoutes(routes, table({ 2: { eol: true } }));
			assert.deepStrictEqual(picked.map(r => r.index), [1]);
			assert.strictEqual(picked[0].note, '');
		});
		it('when every exit is dirty, the nearest is used and says so', function() {
			const picked = routeHoleFilters.pickRoutes(routes, table({ 2: { eol: true }, 4: { crit: true } }));
			assert.deepStrictEqual(picked.map(r => r.index), [0, 1]);
			assert.strictEqual(picked[0].note, 'No route avoiding EOL — this one uses 1 EOL hole');
			assert.strictEqual(picked[0].fallback, true);
		});
		it('one-way keeps the nearest exit and marks the hole', function() {
			const picked = routeHoleFilters.pickRoutes(routes, table({ 2: { eol: true } }, { oneWay: true }));
			assert.deepStrictEqual(picked.map(r => r.index), [0, 1]);
			assert.deepStrictEqual(Object.keys(picked[0].marks), ['2']);
			assert.strictEqual(picked[0].note, '');
		});
		it('no filters: untouched order', function() {
			assert.deepStrictEqual(routeHoleFilters.pickRoutes(routes, {}).map(r => r.index), [0, 1]);
		});
	});

	describe('holesHome', function() {
		// lines are [child, parent, mods, wormholeID]
		const lines = [['n2', 'n1', [], 11], ['n3', 'n2', [], 12], ['n4', 'n1', [], null]];
		it('lists the lines from a node back to the root', function() {
			assert.deepStrictEqual(routeHoleFilters.holesHome(lines, 'n3'), [1, 0]);
			assert.deepStrictEqual(routeHoleFilters.holesHome(lines, 'n1'), []);
		});
		it('lines without a wormhole (calculated routes) are not holes', function() {
			assert.deepStrictEqual(routeHoleFilters.holesHome(lines, 'n4'), []);
		});
		it('survives a loop', function() {
			assert.ok(routeHoleFilters.holesHome([['a', 'b', [], 1], ['b', 'a', [], 2]], 'a').length <= 200);
		});
	});

	describe('markLines', function() {
		it('adds the warning class to marked lines once', function() {
			const lines = [[1, 2, ['eol']], [2, 3, []]];
			routeHoleFilters.markLines(lines, { 0: [{}] });
			routeHoleFilters.markLines(lines, { 0: [{}], 5: [{}] });
			assert.deepStrictEqual(lines[0][2], ['eol', 'route-hole-warn']);
			assert.deepStrictEqual(lines[1][2], []);
		});
	});

	describe('noteText / escape / toggle', function() {
		it('noteText is empty without reasons', function() { assert.strictEqual(routeHoleFilters.noteText([]), ''); });
		it('escapes', function() { assert.strictEqual(routeHoleFilters.escape('<a "b">'), '&lt;a &quot;b&quot;&gt;'); });
		it('the toggle markup carries the state', function() {
			assert.ok(/checked/.test(routeHoleFilters.toggleHtml(true)));
			assert.ok(!/checked/.test(routeHoleFilters.toggleHtml(false)));
		});
	});
});
