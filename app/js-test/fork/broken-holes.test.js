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

describe('brokenHoles: routes leave broken holes out (split)', () => {
	it('nothing broken: the result is untouched', () => {
		const r = chainResult();
		assert.strictEqual(brokenHoles.split(r, brokenOf([])), null);
		assert.deepStrictEqual(vs(r.map.rows), [1, 2, 3, 4, 5]);
	});
	it('takes the broken hole, its far system and everything beyond out of rows, lines, systemsInChainMap and exits', () => {
		const r = chainResult();
		const s = brokenHoles.split(r, brokenOf([11]));
		assert.deepStrictEqual(vs(r.map.rows), [1, 3, 4]);
		assert.deepStrictEqual(r.lines.map(l => l[3]), [13, 12]);
		assert.deepStrictEqual(Object.keys(r.systemsInChainMap).map(Number).sort(), [J105, THERA].sort());
		assert.deepStrictEqual(r.exits, [], 'Amarr and Jita are no longer exits');
		assert.deepStrictEqual(s.wormholes, [11]);
		assert.deepStrictEqual(s.rows.map(x => [x.row.c[0].v, x.after]), [[2, 1], [5, 4]]);
	});
	it('marks the broken line and dims the far system and what lies beyond; the far node gets the tag', () => {
		const r = chainResult();
		const s = brokenHoles.split(r, brokenOf([11]), id => "<span class='t'>" + id + '</span>');
		const line = s.lines.filter(l => l[3] === 11)[0];
		assert.ok(line[2].indexOf('broken-hole') >= 0);
		assert.ok(s.lines.filter(l => l[3] === 14)[0][2].indexOf('broken-hole') < 0, 'only the broken hole itself');
		assert.ok(s.rows[0].row.c[0].f.indexOf("class='node broken-hole-far ") >= 0);
		assert.ok(s.rows[0].row.c[0].f.indexOf("K162<span class='t'>11</span></h4>") >= 0);
		assert.ok(s.rows[1].row.c[0].f.indexOf("class='node broken-hole-beyond ") >= 0);
	});
	it('a system also reachable another way stays a route target', () => {
		const r = chainResult();
		// a second hole from J105033 to Amarr (a loop)
		r.map.rows.push({ c: [node(6, AMARR), { v: 4 }], pathHome: [{ systemID: J105 }, { systemID: AMARR }] });
		r.lines.push([6, 4, [], 15]);
		brokenHoles.split(r, brokenOf([11]));
		assert.deepStrictEqual(r.exits, [String(AMARR)]);
		assert.strictEqual(r.systemsInChainMap[AMARR].c[0].v, 6);
	});
	it('calculated route nodes are no route targets', () => {
		const r = chainResult();
		r.map.rows.push({ c: [node(7, JITA), { v: 3 }], pathHome: [{ systemID: THERA }, { systemID: JITA, path: [1, 2] }] });
		r.lines.push([7, 3, [], undefined]);
		brokenHoles.split(r, brokenOf([11]));
		assert.strictEqual(r.systemsInChainMap[JITA], undefined);
	});
	it('restore puts the rows back where they were, for drawing only (new arrays)', () => {
		const r = chainResult();
		const s = brokenHoles.split(r, brokenOf([11]));
		const kept = r.map.rows;
		const back = brokenHoles.restore(r.map.rows, r.lines, s);
		assert.deepStrictEqual(vs(back.rows), [1, 2, 3, 4, 5]);
		assert.strictEqual(back.lines.length, 4);
		assert.deepStrictEqual(vs(kept), [1, 3, 4], 'the routing rows are unchanged');
	});
	it('restore copes with rows other features added or removed meanwhile', () => {
		const r = chainResult();
		const s = brokenHoles.split(r, brokenOf([12, 11]));
		const rows = [{ c: [{ v: 99 }, { v: null }] }].concat(r.map.rows.filter(x => x.c[0].v !== 4));
		const back = brokenHoles.restore(rows, [], s);
		assert.deepStrictEqual(vs(back.rows), [99, 1, 2, 3, 5]);
		assert.deepStrictEqual(brokenHoles.restore(rows, [], null).rows.length, rows.length);
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
	it('an entry without a registered extra is unchanged', () => {
		const step = [{ action: 'update', signatures: [], meta: { extra: { other: 1 } } }];
		assert.deepStrictEqual(undoHistory.payload('undo', step), { signatures: {} });
		assert.strictEqual(undoHistory.label(step[0], null), 'edit');
	});
});
