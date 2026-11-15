const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/broken-holes');
include('app/js/fork/undo-history');

const HERE = 31001159, AMARR = 30002187, JITA = 30000142, THERA = 31000005, J105 = 31001234;

function node(v, systemID) { return { v: v, systemID: systemID, f: "<div id='node" + v + "' data-nodeid='" + systemID + "' class='node '><h4 class='nodeType'>K162</h4></div>" }; }
/** A chain like chain.nodes() returns: J164104 -> Amarr (hole 11) -> Jita (hole 14), J164104 -> Thera (hole 12), J164104 -> J105033 (hole 13) */
function chainResult() {
	const rows = [
		{ c: [node(1, HERE), { v: null }] },
		{ c: [node(2, AMARR), { v: 1 }], pathHome: [{ systemID: AMARR }] },
		{ c: [node(3, THERA), { v: 1 }], pathHome: [{ systemID: THERA }] },
		{ c: [node(4, J105), { v: 1 }], pathHome: [{ systemID: J105 }] },
		{ c: [node(5, JITA), { v: 2 }], pathHome: [{ systemID: AMARR }, { systemID: JITA }] }
	];
	const lines = [[5, 2, [], 14], [4, 1, [], 13], [3, 1, ['eol'], 12], [2, 1, [], 11]];
	const sim = {};
	rows.slice(1).forEach(r => { sim[r.c[0].systemID] = r; });
	return { map: { rows: rows }, lines: lines, systemsInChainMap: sim, exits: Object.keys(sim).filter(x => x < 31000000) };
}
const vs = rows => rows.map(r => r.c[0].v);
const brokenOf = ids => id => ids.indexOf(Number(id)) >= 0;

describe('brokenHoles: the server list', () => {
	it('setList says whether the set of broken holes changed', () => {
		brokenHoles.ids = {};
		assert.strictEqual(brokenHoles.setList([{ wormholeID: 12, markedBy: 'A', markedAt: 1 }]), true);
		assert.strictEqual(brokenHoles.isBroken(12), true);
		assert.strictEqual(brokenHoles.isBroken('12'), true);
		assert.strictEqual(brokenHoles.isBroken(13), false);
		assert.strictEqual(brokenHoles.setList([{ wormholeID: 12, markedBy: 'B', markedAt: 2 }]), false, 'same holes');
		assert.strictEqual(brokenHoles.setList(null), true);
		assert.deepStrictEqual(brokenHoles.ids, {});
	});
});

describe('brokenHoles: flag (routes leave broken holes out, the chain keeps them)', () => {
	it('nothing broken: the result is untouched', () => {
		const r = chainResult();
		assert.strictEqual(brokenHoles.flag(r, brokenOf([])), null);
		assert.deepStrictEqual(vs(r.map.rows), [1, 2, 3, 4, 5]);
		assert.ok(r.map.rows.every(x => !x.brokenHole));
	});
	it('keeps every row and line; flags the systems cut off and leaves them out of exits', () => {
		const r = chainResult();
		const f = brokenHoles.flag(r, brokenOf([11]));
		assert.deepStrictEqual(vs(r.map.rows), [1, 2, 3, 4, 5]);
		assert.strictEqual(r.lines.length, 4);
		assert.deepStrictEqual(r.map.rows.filter(x => x.brokenHole).map(x => x.c[0].v), [2, 5]);
		assert.deepStrictEqual(f, { wormholes: [11], cut: [String(AMARR), String(JITA)] });
		assert.deepStrictEqual(r.exits, [], 'Amarr and Jita are no longer exits');
		assert.ok(r.systemsInChainMap[AMARR] && r.systemsInChainMap[JITA], 'systemsInChainMap stays whole');
	});
	it('marks the broken line and dims the far system and what lies beyond; the far node gets the tag', () => {
		const r = chainResult();
		brokenHoles.flag(r, brokenOf([11]), id => "<span class='t'>" + id + '</span>');
		const line = r.lines.filter(l => l[3] === 11)[0];
		assert.strictEqual(brokenHoles.isBrokenLine(line), true);
		assert.strictEqual(brokenHoles.isBrokenLine(r.lines.filter(l => l[3] === 14)[0]), false, 'only the broken hole itself');
		assert.ok(r.map.rows[1].c[0].f.indexOf("class='node broken-hole-far ") >= 0);
		assert.ok(r.map.rows[1].c[0].f.indexOf("K162<span class='t'>11</span></h4>") >= 0);
		assert.ok(r.map.rows[4].c[0].f.indexOf("class='node broken-hole-beyond ") >= 0);
		assert.ok(r.map.rows[2].c[0].f.indexOf('broken-hole') < 0, 'Thera untouched');
	});
	it('flagging twice adds nothing twice', () => {
		const r = chainResult();
		brokenHoles.flag(r, brokenOf([11]));
		brokenHoles.flag(r, brokenOf([11]));
		assert.strictEqual(r.lines.filter(l => l[3] === 11)[0][2].filter(m => m === 'broken-hole').length, 1);
	});
	it('a system also reachable another way (a loop) stays a route target, and so does what lies beyond it', () => {
		const r = chainResult();
		r.map.rows.push({ c: [node(6, AMARR), { v: 4 }], pathHome: [{ systemID: J105 }, { systemID: AMARR }] });
		r.lines.push([6, 4, [], 15]);
		r.exits = [String(AMARR), String(JITA)];
		brokenHoles.flag(r, brokenOf([11]));
		assert.deepStrictEqual(r.exits, [String(AMARR), String(JITA)]);
		assert.ok(r.map.rows.every(x => !x.brokenHole));
	});
	it('a calculated node (gate route) is cut off with the system it hangs under; its system stays an exit when reachable', () => {
		const r = chainResult();
		r.map.rows.push({ c: [node(7, JITA), { v: 3 }], pathHome: [{ systemID: THERA }, { systemID: JITA, path: [1, 2] }] });
		r.lines.push([7, 3, [], undefined]);
		r.exits = [String(AMARR), String(JITA)];
		brokenHoles.flag(r, brokenOf([12]));
		assert.deepStrictEqual(r.map.rows.filter(x => x.brokenHole).map(x => x.c[0].v), [3, 7]);
		assert.deepStrictEqual(r.exits, [String(AMARR), String(JITA)], 'Jita is reached through Amarr');
	});
});

describe('brokenHoles: its chain.nodes wrapper is the innermost', () => {
	it('it wraps when it loads, and no fork file before it wraps chain.nodes then (upstream never does)', () => {
		const vm = require('vm'), fs = require('fs'), path = require('path');
		const dir = 'app/js/fork';
		const ready = [];
		const any = new Proxy(function() { return any; }, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : any, apply: () => any });
		const $ = function(a) { if (typeof a === 'function') { ready.push(a); return any; } return any; };
		$.fn = { dialog: function() {} }; $.extend = Object.assign; $.each = function() {}; $.map = function() { return []; };
		const original = function() { return { map: { rows: [] }, lines: [], exits: [] }; };
		const sandbox = { console: { log() {}, warn() {}, error() {}, debug() {} }, setTimeout() {}, setInterval() {}, clearTimeout() {},
			window: {}, document: { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } },
			jQuery: $, $: $, chain: { nodes: original, renderer: { draw() {} }, useRenderer() {}, data: {} }, options: { chain: {} } };
		sandbox.window = sandbox;
		vm.createContext(sandbox);
		const files = fs.readdirSync(dir).filter(f => /\.js$/.test(f)).sort();
		files.forEach(f => {
			// Files that load after broken-holes.js wrap its wrapper, whenever they do it; files before it must not wrap at load
			if (f === 'broken-holes.js') { assert.strictEqual(sandbox.chain.nodes, original, 'a file before broken-holes.js wrapped chain.nodes while the bundle loads'); }
			try { vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }); } catch (e) { /* a file that needs the real page: its load-time code stops here */ }
			if (f === 'broken-holes.js') { assert.strictEqual(sandbox.chain.nodes.brokenHolesWrapped, true, 'broken-holes.js wraps chain.nodes when it loads'); }
		});
		assert.ok(ready.length > 0, 'the other files wait for DOM ready');
	});
});

describe('brokenHoles: route features honour the marks, the rest still sees the systems', () => {
	include('app/js/fork/rally');
	include('app/js/fork/route-destinations');
	include('app/js/fork/favourites-panel');
	include('app/js/fork/jump-planner');
	include('app/js/fork/chain-alerts');
	include('app/js/fork/route-hole-filters');
	it('routes leave the hole out; chain alerts, the automapper\'s inChain and the kill feed still see the systems', () => {
		global.appData = global.appData || { systems: {} };
		[AMARR, JITA, THERA, J105, HERE].forEach(id => { if (!appData.systems[id]) { appData.systems[id] = id < 31000000 ? { name: String(id), security: 0.9 } : { name: String(id), security: -1, class: 3 }; } });
		const r = chainResult();
		brokenHoles.flag(r, brokenOf([11]));
		// Route features
		assert.deepStrictEqual(rally.systemConnections(r.map.rows, r.lines).map(c => r.lines[c[3]][3]).sort(), [12, 13, 14], 'no connection through hole 11');
		assert.deepStrictEqual(routeDestinations.chainExits(r.map.rows, r.lines).map(e => e.systemID), [], 'Amarr and Jita are no exits');
		assert.deepStrictEqual(routeDestinations.chainSystems(r.map.rows, r.lines).sort(), [HERE, THERA, J105].sort());
		assert.deepStrictEqual(Object.keys(favouritesPanel.chainSystems(r.map.rows)).map(Number).sort(), [HERE, THERA, J105].sort());
		assert.strictEqual(jumpPlanner.isExtraRow(r.map.rows[1]), true);
		assert.deepStrictEqual(r.exits, []);
		// Everything else: the rows, the lines and systemsInChainMap stay whole
		assert.deepStrictEqual(vs(r.map.rows), [1, 2, 3, 4, 5]);
		assert.strictEqual(r.lines.length, 4);
		const inChain = id => r.map.rows.filter(row => row.c[0].systemID == id).length > 0;	// automapper.js's guard
		assert.strictEqual(inChain(AMARR), true);
		assert.strictEqual(inChain(JITA), true);
		assert.ok(r.systemsInChainMap[JITA], 'hole naming / smart notes / kill feed lookups');
		assert.strictEqual(chainAlerts.chainSystems(r)[JITA], true, 'chain alerts still watch Jita');
	});
	it('a loop: Get home, the exits\' hole names and "To chain:" use the way that avoids the broken hole', () => {
		// root J164104 -> Amarr (hole 11, broken) -> Jita (hole 12); root -> Jita (hole 13); Jita (under Amarr) -> J105 (hole 14)
		const n = (v, sys, p, pathHome) => ({ c: [node(v, sys), { v: p }], pathHome: pathHome });
		const rows = [n(1, HERE, null, undefined), n(2, AMARR, 1, [{ systemID: AMARR, name: 'via-amarr' }]),
			n(3, JITA, 2, [{ systemID: AMARR }, { systemID: JITA, name: 'through-broken' }]), n(4, JITA, 1, [{ systemID: JITA, name: 'direct' }]),
			n(5, J105, 3, [{ systemID: AMARR }, { systemID: JITA }, { systemID: J105 }]),
			// show viewing: a calculated gate route Jita -> Amarr hung under the direct Jita (never a clean row for Amarr)
			n(6, AMARR, 4, [{ systemID: JITA, name: 'direct' }, { systemID: AMARR, path: [1, 2] }]),
			// Thera behind another broken hole (15): where the pilot is, cut off
			n(7, THERA, 1, [{ systemID: THERA }])];
		const sim = { [AMARR]: rows[1], [JITA]: rows[2], [J105]: rows[4] };	// upstream keeps one row per system: here the stale one
		const r = { map: { rows: rows }, lines: [[2, 1, [], 11], [3, 2, [], 12], [4, 1, [], 13], [5, 3, [], 14], [6, 4, [], undefined], [7, 1, [], 15]], systemsInChainMap: sim, exits: [String(AMARR), String(JITA)] };
		brokenHoles.flag(r, brokenOf([11, 15]));
		assert.deepStrictEqual(r.map.rows.filter(x => x.brokenHole).map(x => x.c[0].v), [7], 'Amarr is still reached through Jita (hole 12); Thera is cut off');
		assert.deepStrictEqual(r.map.rows.filter(x => x.brokenPath).map(x => x.c[0].v), [2, 3, 5, 7]);
		assert.deepStrictEqual(r.exits, [String(AMARR), String(JITA)]);
		assert.strictEqual(r.systemsInChainMap[JITA], rows[3], '"To chain:" reads the direct row');
		assert.deepStrictEqual(r.systemsInChainMap[AMARR].pathHome, [{ systemID: AMARR, name: 'via-amarr' }], 'no clean row: "To chain:" shows just the system');
		assert.strictEqual(rows[1].pathHome.length, 1, 'the map row itself is untouched');
		assert.deepStrictEqual(r.systemsInChainMap[J105].pathHome, [{ systemID: J105 }]);
		assert.strictEqual(rows[4].pathHome.length, 3, 'the map row keeps its whole way home');
		const exits = routeDestinations.chainExits(r.map.rows, r.lines);
		assert.deepStrictEqual(exits.map(e => [e.systemID, e.holeName, !!e.brokenPath]), [[AMARR, '', true], [JITA, 'direct', false]],
			'Amarr stays an exit (reached through Jita), flagged; Jita comes from its clean row');
		// Destinations: a flagged exit is judged by the route from where you are, never by its tree way home
		const conns = rally.systemConnections(r.map.rows, r.lines);
		const route = rally.routeTo(conns, String(HERE), String(AMARR));
		assert.ok(route && route.every(i => r.lines[i][3] !== 11), 'the route to Amarr goes via Jita');
		// Destinations decorate: the flagged exit is routed from the chain root over the hole graph (via Jita)
		// The pilot sits in the cut-off Thera: no route from there, so the flagged exit is judged from the chain's root
		const prevCtx = routeHoleFilters.contextFor, prevLoc = rally.currentLocations;
		routeHoleFilters.contextFor = lines => routeHoleFilters.makeContext(lines, {}, { wormholes: {} });
		rally.currentLocations = () => ({ tracked: THERA, viewing: THERA });
		try {
			routeDestinations.decorate(r, [], 0);
			const amarr = routeDestinations.lastExits.filter(e => e.systemID === AMARR)[0];
			assert.deepStrictEqual(amarr.holes.map(i => r.lines[i][3]), [13, 12], 'judged by the way via Jita, not by the broken tree path');
			assert.strictEqual(amarr.unreachable, undefined);
			assert.strictEqual(amarr.fromRoot, true);
		} finally { routeHoleFilters.contextFor = prevCtx; rally.currentLocations = prevLoc; }
		const hp = jumpPlanner.homePaths(r);
		assert.deepStrictEqual(hp.paths[JITA].holes.map(h => h.wormholeID), [13], 'Get home goes the direct way');
		assert.strictEqual(hp.paths[AMARR], undefined, 'the map has no row for the other way to Amarr: no Get home rather than a wrong one');
		assert.strictEqual(hp.paths[J105], undefined, 'its only way home on the map crosses the broken hole');
	});
	it('an exit with no way on the map at all is unreachable: bad and last (Destinations, Loot buyers)', () => {
		const rated = routeHoleFilters.pickRoutes([
			{ exit: { systemID: AMARR, holes: [], unreachable: true }, jumps: 1, index: 0 },
			{ exit: { systemID: JITA, holes: [] }, jumps: 5, index: 1 }
		], {});
		assert.deepStrictEqual(rated.map(x => x.exit.systemID), [JITA], 'a clean exit wins');
		const only = routeHoleFilters.pickRoutes([
			{ exit: { systemID: AMARR, holes: [], unreachable: true }, jumps: 1, index: 0 },
			{ exit: { systemID: JITA, holes: [0] }, jumps: 5, index: 1 }
		], { 0: { all: [{ key: 'eol' }], avoid: [{ key: 'eol', noun: 'EOL hole', short: 'EOL' }] } });
		assert.deepStrictEqual(only.map(x => x.exit.systemID), [JITA, AMARR], 'all bad: the unreachable one ranks last');
		assert.strictEqual(only[1].note, 'no route to it on the map');
	});
});

describe('brokenHoles: undo', () => {
	it('undo swaps mark and restore; redo repeats them', () => {
		assert.deepStrictEqual(brokenHoles.undoPart('undo', { mark: [12] }), { restore: [12] });
		assert.deepStrictEqual(brokenHoles.undoPart('redo', { mark: [12] }), { mark: [12] });
		assert.deepStrictEqual(brokenHoles.undoPart('undo', { mark: [1], restore: [2] }), { mark: [2], restore: [1] });
		assert.strictEqual(brokenHoles.undoPart('undo', {}), null);
		assert.deepStrictEqual(brokenHoles.mergeParts({ mark: [1] }, { mark: [2], restore: [3] }), { mark: [1, 2], restore: [3] });
	});
	it('labels', () => {
		assert.strictEqual(brokenHoles.label({ mark: [1, 2] }), 'mark 2 holes broken');
		assert.strictEqual(brokenHoles.label({ restore: [1] }), 'restore 1 broken hole');
	});
	it('the undo history sends the extra part with the step, in one request', () => {
		undoHistory.registerExtra('brokenHoles', { payload: brokenHoles.undoPart, ok: d => !!(d && d.brokenHolesResult && d.brokenHolesResult.result), label: brokenHoles.label, merge: brokenHoles.mergeParts });
		const step = [
			{ action: 'remove', signatures: [{ id: 9, systemID: HERE, signatureID: 'pqr678', type: 'data' }], meta: { group: 3 } },
			{ action: 'update', signatures: [], meta: { group: 3, extra: { brokenHoles: { mark: [12] } } } }
		];
		assert.deepStrictEqual(undoHistory.payload('undo', step), { signatures: { add: [{ id: 9, systemID: HERE, signatureID: 'pqr678', type: 'data' }] }, brokenHoles: { restore: [12] } });
		assert.deepStrictEqual(undoHistory.payload('redo', step), { signatures: { remove: [9] }, brokenHoles: { mark: [12] } });
		assert.strictEqual(undoHistory.stepSize(step), 2, 'one step');
		assert.strictEqual(undoHistory.label(step[1], null), 'mark 1 hole broken');
		assert.strictEqual(undoHistory.extrasOk(step, { brokenHolesResult: { result: true } }), true);
		assert.strictEqual(undoHistory.extrasOk(step, {}), false);
	});
	it('settle: a step of signatures and broken marks is done only when both were saved', () => {
		const sigEntry = () => ({ action: 'remove', signatures: [{ id: 9, systemID: HERE, signatureID: 'pqr678', type: 'data' }], meta: { group: 4 } });
		const extraEntry = () => ({ action: 'update', signatures: [], meta: { group: 4, extra: { brokenHoles: { mark: [12] } } } });
		const ok = { resultSet: [{ result: true }], brokenHolesResult: { result: true } };
		let step = [sigEntry(), extraEntry()];
		let r = undoHistory.ui.settlePart('undo', step, [[{}], []], ok);
		assert.strictEqual(r.status, 'done');
		assert.strictEqual(r.part.entries.length, 2, 'both go on the redo stack');
		// The marks failed: partial, and the extra entry stays off the other stack
		step = [sigEntry(), extraEntry()];
		r = undoHistory.ui.settlePart('undo', step, [[{}], []], { resultSet: [{ result: true }], brokenHolesResult: { result: false } });
		assert.strictEqual(r.status, 'partial');
		assert.deepStrictEqual([r.part.applied, r.part.sent], [1, 2]);
		assert.deepStrictEqual(r.part.entries.map(e => e.action), ['remove']);
		// The signature failed but the marks were saved: partial, and the extra entry goes on the other stack
		step = [sigEntry(), extraEntry()];
		r = undoHistory.ui.settlePart('undo', step, [[{}], []], { resultSet: [{ result: false, value: 'gone' }], brokenHolesResult: { result: true } });
		assert.strictEqual(r.status, 'partial');
		assert.deepStrictEqual(r.part.entries.map(e => e.meta.extra ? 'extra' : e.action), ['extra']);
		// Both failed
		r = undoHistory.ui.settlePart('undo', [sigEntry(), extraEntry()], [[{}], []], { resultSet: [{ result: false }] });
		assert.strictEqual(r.status, 'failed');
		assert.deepStrictEqual(r.part.entries, []);
		// Only the extra
		assert.strictEqual(undoHistory.ui.settlePart('undo', [extraEntry()], [[]], { brokenHolesResult: { result: true } }).status, 'done');
		assert.strictEqual(undoHistory.ui.settlePart('undo', [extraEntry()], [[]], {}).status, 'failed');
		// An entry with signatures and the extra: the extra is dropped from it when the marks failed
		const mixed = Object.assign(sigEntry(), { meta: { group: 5, extra: { brokenHoles: { mark: [12] } } } });
		r = undoHistory.ui.settlePart('undo', [mixed], [[{}]], { resultSet: [{ result: true }], brokenHolesResult: { result: false } });
		assert.strictEqual(r.status, 'partial');
		assert.strictEqual(r.part.entries[0].meta.extra, undefined);
		assert.ok(mixed.meta.extra, 'the step itself is not changed');
	});
	it('an entry without a registered extra is unchanged', () => {
		const step = [{ action: 'update', signatures: [], meta: { extra: { other: 1 } } }];
		assert.deepStrictEqual(undoHistory.payload('undo', step), { signatures: {} });
		assert.strictEqual(undoHistory.label(step[0], null), 'edit');
	});
});
