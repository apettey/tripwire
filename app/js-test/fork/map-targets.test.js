const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/map-targets');

const mt = mapTargets;
const T = 1800000000;
const target = (systemID, ord, extra) => Object.assign({ systemID, note: '', ord, createdBy: { id: 1, name: 'Alice' }, created: T - 100, expires: T + 3600 }, extra || {});

describe('Map targets', () => {
	it('badges on by default, off only when saved off', () => {
		assert.equal(mt.enabled({}), true);
		assert.equal(mt.enabled({ mapTargets: {} }), true);
		assert.equal(mt.enabled({ mapTargets: { enabled: false } }), false);
		assert.equal(mt.enabled(null), true);
	});

	it('only k-space systems can be targets', () => {
		assert.equal(mt.canTarget({ security: -0.4, regionID: 10000060 }), true);
		assert.equal(mt.canTarget({ security: -0.99, regionID: 11000001, class: 3 }), false);
		assert.equal(mt.canTarget(null), false);
	});

	it('cleans notes like the server', () => {
		assert.equal(mt.cleanNote('  hit\tthis\u0001 one '), 'hit this one');
		assert.equal(mt.cleanNote('x'.repeat(80)).length, 60);
		assert.equal(mt.cleanNote(null), '');
		assert.equal(mt.cleanNote('<b>x</b>'), '<b>x</b>');	// plain text, escaped where it is shown
	});

	it('normalise: order by ord, then created; junk left out', () => {
		const list = mt.normalise([target(3, 2), null, { systemID: 'x' }, target(1, 0), target(2, 0, { created: T })]);
		assert.deepEqual(list.map(t => t.systemID), [1, 2, 3]);
		assert.deepEqual(mt.normalise('x'), []);
	});

	it('live and numbers', () => {
		const list = [target(1, 0), target(2, 1, { expires: T - 1 }), target(3, 2)];
		const live = mt.live(list, T);
		assert.deepEqual(live.map(t => t.systemID), [1, 3]);
		const n = mt.numbers(live);
		assert.equal(n[3].n, 2);
		assert.equal(n[2], undefined);
	});

	describe('expiry', () => {
		it('default: until the end of the latest skyhook window when there is one', () => {
			assert.deepEqual(mt.defaultExpiry(T + 5000, T), { until: T + 5000, label: 'until its skyhook window ends' });
		});
		it('else 6 h (no window, one that ends now, or one too far ahead)', () => {
			assert.equal(mt.defaultExpiry(0, T).hours, 6);
			assert.equal(mt.defaultExpiry(T + 30, T).hours, 6);
			assert.equal(mt.defaultExpiry(T + 8 * 86400, T).hours, 6);
		});
		it('POST parameters of a choice', () => {
			assert.deepEqual(mt.expiryParams('skyhook', T + 5000), { until: String(T + 5000) });
			assert.deepEqual(mt.expiryParams('3'), { hours: '3' });
			assert.deepEqual(mt.expiryParams('5'), { hours: '6' });
			assert.deepEqual(mt.expiryParams('skyhook', 0), { hours: '6' });
		});
		it('duration text', () => {
			assert.equal(mt.duration(2 * 3600 + 600), '2h10m');
			assert.equal(mt.duration(59), '<1m');
			assert.equal(mt.duration(-5), '<1m');
		});
	});

	describe('order', () => {
		it('move up and down', () => {
			assert.deepEqual(mt.move([1, 2, 3], 2, -1), [2, 1, 3]);
			assert.deepEqual(mt.move([1, 2, 3], 2, 1), [1, 3, 2]);
			assert.equal(mt.move([1, 2, 3], 1, -1), null);
			assert.equal(mt.move([1, 2, 3], 3, 1), null);
			assert.equal(mt.move([1, 2, 3], 9, 1), null);
		});
		it('drag before another, or to the end', () => {
			assert.deepEqual(mt.moveBefore([1, 2, 3, 4], 4, 2), [1, 4, 2, 3]);
			assert.deepEqual(mt.moveBefore([1, 2, 3, 4], 1, 99), [2, 3, 4, 1]);
			assert.equal(mt.moveBefore([1, 2], 9, 1), null);
		});
		it('shortest order: nearest neighbour from the start, unreachable last', () => {
			// a line 10 - 1 - 2 - 3, and 4 unreachable; jumps = |a - b| on the line positions
			const pos = { 10: 0, 1: 1, 2: 2, 3: 3 };
			const distFrom = from => {
				const out = {};
				Object.keys(pos).forEach(id => { out[id] = { jumps: Math.min.apply(null, from.map(f => Math.abs(pos[f] - pos[id]))) }; });
				return out;
			};
			assert.deepEqual(mt.shortestOrder([10], [3, 4, 1, 2], distFrom), [1, 2, 3, 4]);
			assert.deepEqual(mt.shortestOrder([], [3, 1], distFrom), [3, 1]);
		});
	});

	describe('waypoints', () => {
		it('the first clears the others, at most 25', () => {
			assert.deepEqual(mt.waypoints([5, 6]), [{ systemID: 5, clear: true }, { systemID: 6, clear: false }]);
			assert.equal(mt.waypoints(Array.from({ length: 30 }, (x, i) => 30000001 + i)).length, 25);
		});
		it('sends one after another per character, stops a character at its first error', async () => {
			const calls = [];
			const send = (c, s, clear) => { calls.push(c + ':' + s + ':' + clear); return c === 'b' && s === 6 ? Promise.reject({ status: 420 }) : Promise.resolve(); };
			const progress = [];
			const r = await mt.send([{ characterID: 'a', name: 'A' }, { characterID: 'b', name: 'B' }], mt.waypoints([5, 6, 7]), send, (d, t) => progress.push(d + '/' + t));
			assert.deepEqual(calls, ['a:5:true', 'a:6:false', 'a:7:false', 'b:5:true', 'b:6:false']);
			assert.deepEqual(r.map(x => [x.name, x.sent, !!x.error]), [['A', 3, false], ['B', 1, true]]);
			assert.equal(progress[progress.length - 1], '6/6');
		});
		it('a sender that throws counts as an error', async () => {
			const r = await mt.send([{ characterID: 'a', name: 'A' }], mt.waypoints([5]), () => { throw new Error('x'); });
			assert.ok(r[0].error);
		});
		it('summary', () => {
			const ok = { name: 'A', sent: 4, total: 4, error: null };
			assert.deepEqual(mt.summary([ok, Object.assign({}, ok, { name: 'B' })]), { color: 'green', lines: ['Sent 4 waypoints to 2 pilots.'] });
			const s = mt.summary([ok, { name: 'B', sent: 1, total: 4, error: { status: 420 } }], e => 'ESI error ' + e.status);
			assert.deepEqual(s, { color: 'yellow', lines: ['Sent 4 waypoints to 1 pilot.', 'B: stopped after 1 waypoint of 4 (ESI error 420)'] });
			assert.equal(mt.summary([{ name: 'B', sent: 0, total: 1, error: {} }]).color, 'red');
		});
	});

	describe('chain badge', () => {
		const row = (systemID, extra) => Object.assign({ c: [{ systemID: systemID, f: "<div class='node'><div class='nodeIcons'></div></div>" }] }, extra || {});
		it('numbered, escaped tooltip, once, not on destination rows', () => {
			const result = { map: { rows: [row(1), row(2), row(1, { destination: {} }), null] } };
			const nums = mt.numbers([target(1, 0, { note: "<img src=x onerror='x'>" })]);
			assert.equal(mt.decorate(result, nums), 1);
			const f = result.map.rows[0].c[0].f;
			assert.ok(f.indexOf("<span class='target-badge'") > 0 && f.indexOf('>1</span>') > 0);
			assert.ok(f.indexOf('<img') < 0);
			assert.equal(mt.decorate(result, nums), 0);	// already there
			assert.equal(result.map.rows[1].c[0].f.indexOf('target-badge'), -1);
		});
		it('badge key changes with order and notes', () => {
			const a = [target(1, 0), target(2, 1)];
			assert.notEqual(mt.badgeKey(a), mt.badgeKey([a[1], a[0]]));
			assert.notEqual(mt.badgeKey(a), mt.badgeKey([target(1, 0, { note: 'x' }), a[1]]));
		});
	});
});
