const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/staging-scan');

describe('stagingScan', () => {
	// A small gate graph keyed by systemID - 30000000: a chain 1-2-3-4-5-6 with a branch 2-7, and 9 on its own
	const graph = { 1: { 2: 0 }, 2: { 1: 0, 3: 0, 7: 0 }, 3: { 2: 0, 4: 0 }, 4: { 3: 0, 5: 0 }, 5: { 4: 0, 6: 0 }, 6: { 5: 0 }, 7: { 2: 0 }, 9: {} };
	const S = (n) => 30000000 + n;

	describe('enabled / radius', () => {
		it('is on unless switched off', () => {
			assert.strictEqual(stagingScan.enabled(undefined), true);
			assert.strictEqual(stagingScan.enabled({}), true);
			assert.strictEqual(stagingScan.enabled({ stagingScan: {} }), true);
			assert.strictEqual(stagingScan.enabled({ stagingScan: { enabled: false } }), false);
		});
		it('uses a saved radius of 5, 10 or 15, else 10', () => {
			assert.strictEqual(stagingScan.radius({}), 10);
			assert.strictEqual(stagingScan.radius({ stagingScan: { radius: 15 } }), 15);
			assert.strictEqual(stagingScan.radius({ stagingScan: { radius: "5" } }), 5);
			assert.strictEqual(stagingScan.radius({ stagingScan: { radius: 7 } }), 10);
		});
	});

	describe('isNullSec', () => {
		it('accepts k-space null-sec only', () => {
			assert.strictEqual(stagingScan.isNullSec(30004759, { security: -0.39 }), true);
			assert.strictEqual(stagingScan.isNullSec(30004759, { security: 0 }), true);
			assert.strictEqual(stagingScan.isNullSec(30000142, { security: 0.946 }), false);
			assert.strictEqual(stagingScan.isNullSec(30002053, { security: 0.3 }), false);
		});
		it('excludes wormhole space, Pochven, Zarzakh and unknown systems', () => {
			assert.strictEqual(stagingScan.isNullSec(31000005, { security: -1, class: [12] }), false);
			assert.strictEqual(stagingScan.isNullSec(30002000, { security: -1, class: [3] }), false);
			assert.strictEqual(stagingScan.isNullSec(30000157, { security: -1, factionID: 500026 }), false);
			assert.strictEqual(stagingScan.isNullSec(30100000, { security: -1 }), false);
			assert.strictEqual(stagingScan.isNullSec(30004759, null), false);
			assert.strictEqual(stagingScan.isNullSec('Null-Sec', { security: -0.1 }), false);
			assert.strictEqual(stagingScan.isNullSec(30004759, { security: undefined }), false);
		});
	});

	describe('bfs', () => {
		it('lists systems within the radius with their gate jumps, origin first', () => {
			const out = stagingScan.bfs(graph, S(1), 2);
			assert.deepStrictEqual(out, [{ id: S(1), jumps: 0 }, { id: S(2), jumps: 1 }, { id: S(3), jumps: 2 }, { id: S(7), jumps: 2 }]);
		});
		it('counts plain hops and never lists a system twice', () => {
			const out = stagingScan.bfs(graph, S(3), 10);
			assert.strictEqual(out.length, 7);
			const byId = {};
			out.forEach(r => { assert.ok(!byId[r.id]); byId[r.id] = r.jumps; });
			assert.deepStrictEqual(byId, { [S(1)]: 2, [S(2)]: 1, [S(3)]: 0, [S(4)]: 1, [S(5)]: 2, [S(6)]: 3, [S(7)]: 2 });
		});
		it('radius 0 is the origin only', () => {
			assert.deepStrictEqual(stagingScan.bfs(graph, S(4), 0), [{ id: S(4), jumps: 0 }]);
		});
		it('a disconnected origin is alone; an unknown origin or graph gives nothing', () => {
			assert.deepStrictEqual(stagingScan.bfs(graph, S(9), 10), [{ id: S(9), jumps: 0 }]);
			assert.deepStrictEqual(stagingScan.bfs(graph, S(8), 10), []);
			assert.deepStrictEqual(stagingScan.bfs(graph, 31000005, 10), []);
			assert.deepStrictEqual(stagingScan.bfs(null, S(1), 10), []);
		});
	});

	describe('parseDay', () => {
		it('reads the compact rows', () => {
			const d = stagingScan.parseDay({ hours: 24, generated: 1, systems: { "30000001": [100, 2, 1, 30, 20], "x": [1, 1, 1, 1, 1], "30000002": "bad" } });
			assert.deepStrictEqual(d, { hours: 24, latest: null, systems: { "30000001": { jumps: 100, shipKills: 2, podKills: 1, npcKills: 30, activeHours: 20 } } });
		});
		it('keeps the covered hours (clamped to 0-24) and the newest row time', () => {
			const sys = { "30000001": [1, 0, 0, 0, 1] };
			assert.strictEqual(stagingScan.parseDay({ hours: 6, latest: 1791900000, systems: sys }).hours, 6);
			assert.strictEqual(stagingScan.parseDay({ hours: 6, latest: 1791900000, systems: sys }).latest, 1791900000);
			assert.strictEqual(stagingScan.parseDay({ hours: 99, systems: sys }).hours, 24);
			assert.strictEqual(stagingScan.parseDay({ systems: sys }).hours, 24, 'an answer without hours is a full day');
			assert.strictEqual(stagingScan.parseDay({ hours: 0, systems: sys }), null, 'no hours covered: last hour only');
		});
		it('gives null when there is no data (cron not run yet, bad answer)', () => {
			assert.strictEqual(stagingScan.parseDay({ hours: 24, systems: {} }), null);
			assert.strictEqual(stagingScan.parseDay({ hours: 24, systems: [] }), null);
			assert.strictEqual(stagingScan.parseDay(null), null);
			assert.strictEqual(stagingScan.parseDay("oops"), null);
		});
	});

	describe('isCurrent', () => {
		const NOW = Date.parse('2026-10-13T16:20:00Z');
		it('is true when the newest row is from this UTC hour', () => {
			assert.strictEqual(stagingScan.isCurrent(Date.parse('2026-10-13T16:00:00Z') / 1000, NOW), true);
			assert.strictEqual(stagingScan.isCurrent(Date.parse('2026-10-13T15:00:00Z') / 1000, NOW), false);
			assert.strictEqual(stagingScan.isCurrent(null, NOW), false);
		});
	});

	describe('coverage', () => {
		it('keeps the thresholds from 20 hours of history', () => {
			assert.deepStrictEqual(stagingScan.coverage(24), { activeHours: 16, quiet: 20, partial: false, label: '24h' });
			assert.deepStrictEqual(stagingScan.coverage(20), { activeHours: 16, quiet: 20, partial: false, label: '24h' });
		});
		it('scales busy hours and quiet to shorter history', () => {
			assert.deepStrictEqual(stagingScan.coverage(6), { activeHours: 4, quiet: 5, partial: true, label: '6h' });
			assert.deepStrictEqual(stagingScan.coverage(1), { activeHours: 1, quiet: 20 / 24, partial: true, label: '1h' });
		});
	});

	describe('analyse (partial history)', () => {
		const list = [1, 2, 3, 4, 5, 6].map(n => ({ id: S(n), jumps: n - 1 }));
		const day = { hours: 6, systems: {
			[S(1)]: { jumps: 600, shipKills: 0, podKills: 0, npcKills: 10, activeHours: 6 },
			[S(2)]: { jumps: 30, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 3 },
			[S(3)]: { jumps: 4, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 2 }
		} };
		const scan = stagingScan.analyse(list, {}, day);
		const row = (n) => scan.rows.find(r => r.id === S(n));
		it('can still flag a likely staging with 6 hours of history', () => {
			assert.strictEqual(scan.partial, true);
			assert.strictEqual(scan.label, '6h');
			assert.strictEqual(scan.hours, 6);
			assert.deepStrictEqual(stagingScan.stagingIDs(scan), [S(1)]);
		});
		it('scales Quiet to the covered hours', () => {
			assert.deepStrictEqual(row(2).tags, []);
			assert.deepStrictEqual(row(3).tags, ['Quiet']);
		});
		it('full history is not partial', () => {
			const full = stagingScan.analyse(list, {}, Object.assign({}, day, { hours: 24 }));
			assert.strictEqual(full.partial, false);
			assert.strictEqual(full.label, '24h');
			assert.deepStrictEqual(stagingScan.stagingIDs(full), [], '6 busy hours of 24 is not all day');
		});
	});

	describe('median', () => {
		it('handles odd, even and empty lists', () => {
			assert.strictEqual(stagingScan.median([3, 1, 2]), 2);
			assert.strictEqual(stagingScan.median([4, 1, 2, 3]), 2.5);
			assert.strictEqual(stagingScan.median([]), 0);
		});
	});

	describe('analyse (24 h)', () => {
		// 10 systems: one staging (busy all day, few NPC kills), one busy for a few hours only, one ratting system, the rest quiet
		const list = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: S(n + 1), jumps: n }));
		const day = { hours: 24, systems: {
			[S(1)]: { jumps: 10, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 5 },
			[S(4)]: { jumps: 2000, shipKills: 8, podKills: 4, npcKills: 20, activeHours: 24 },	// staging, PvP
			[S(5)]: { jumps: 1500, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 6 },	// busy, but not all day
			[S(6)]: { jumps: 900, shipKills: 0, podKills: 0, npcKills: 2500, activeHours: 24 },	// ratting
			[S(7)]: { jumps: 50, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 10 },
			[S(8)]: { jumps: 40, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 10 }
		} };
		const now = { [S(4)]: { shipJumps: 90, shipKills: 1, podKills: 0, npcKills: 3 } };
		const scan = stagingScan.analyse(list, now, day);
		const row = (n) => scan.rows.find(r => r.id === S(n));

		it('uses the 24 h data', () => {
			assert.strictEqual(scan.mode, '24h');
			assert.strictEqual(scan.rows.length, 10);
			assert.deepStrictEqual(row(4).day, { jumps: 2000, kills: 12, npc: 20, activeHours: 24 });
			assert.deepStrictEqual(row(4).now, { jumps: 90, kills: 1, npc: 3 });
			assert.deepStrictEqual(row(2).day, { jumps: 0, kills: 0, npc: 0, activeHours: 0 });
		});
		it('flags a likely staging only when top 3, >= 2x median and busy >= 16 h', () => {
			assert.deepStrictEqual(stagingScan.stagingIDs(scan), [S(4)]);
			assert.strictEqual(row(5).staging, false, 'busy only 6 hours');
			assert.strictEqual(row(6).staging, false, 'ratting system: NPC kills outnumber jumps');
		});
		it('ranks by score: jumps spread over the day, ratting systems lower', () => {
			assert.strictEqual(scan.rows[0].id, S(4));
			assert.ok(row(4).score > row(6).score);
			assert.ok(row(6).score > row(5).score, 'all-day traffic beats a busy few hours');
			assert.strictEqual(row(6).score, 900 * 0.5);
		});
		it('tags PvP, Ratting and Quiet', () => {
			assert.deepStrictEqual(row(4).tags, ['Likely staging', 'PvP']);
			assert.deepStrictEqual(row(6).tags, ['Ratting']);
			assert.deepStrictEqual(row(1).tags, ['Quiet']);
			assert.deepStrictEqual(row(5).tags, []);
		});
		it('tags Ratting from 1000 NPC kills in 24 h', () => {
			const two = [{ id: S(1), jumps: 0 }, { id: S(2), jumps: 1 }];
			const out = stagingScan.analyse(two, {}, { hours: 24, systems: {
				[S(1)]: { jumps: 5000, shipKills: 0, podKills: 0, npcKills: 999, activeHours: 24 },
				[S(2)]: { jumps: 5000, shipKills: 0, podKills: 0, npcKills: 1000, activeHours: 24 }
			} });
			assert.ok(out.rows.find(r => r.id === S(1)).tags.indexOf('Ratting') < 0);
			assert.ok(out.rows.find(r => r.id === S(2)).tags.indexOf('Ratting') >= 0);
		});
		it('flags nothing when the top systems are not well above the median', () => {
			const flat = stagingScan.analyse(list.slice(0, 4), {}, { hours: 24, systems: {
				[S(1)]: { jumps: 500, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 24 },
				[S(2)]: { jumps: 450, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 24 },
				[S(3)]: { jumps: 400, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 24 },
				[S(4)]: { jumps: 380, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 24 }
			} });
			assert.deepStrictEqual(stagingScan.stagingIDs(flat), []);
		});
		it('only the top 3 can be flagged', () => {
			const many = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(n => ({ id: S(n), jumps: 1 }));
			const systems = {};
			[1, 2, 3, 4].forEach(n => { systems[S(n)] = { jumps: 1000 + n, shipKills: 0, podKills: 0, npcKills: 0, activeHours: 24 }; });
			const out = stagingScan.analyse(many, {}, { hours: 24, systems: systems });
			assert.deepStrictEqual(stagingScan.stagingIDs(out).sort(), [S(2), S(3), S(4)]);
		});
	});

	describe('analyse (last hour only)', () => {
		it('falls back to the hourly numbers when there is no 24 h data', () => {
			const list = [1, 2, 3, 4, 5].map(n => ({ id: S(n), jumps: n - 1 }));
			const now = {
				[S(2)]: { shipJumps: 120, shipKills: 2, podKills: 1, npcKills: 0 },
				[S(3)]: { shipJumps: 5, npcKills: 80 },
				[S(4)]: { shipJumps: 3 }
			};
			const scan = stagingScan.analyse(list, now, null);
			assert.strictEqual(scan.mode, 'hour');
			const row = (n) => scan.rows.find(r => r.id === S(n));
			assert.strictEqual(row(2).day, null);
			assert.strictEqual(row(2).value, 120);
			assert.deepStrictEqual(stagingScan.stagingIDs(scan), [], 'never "likely staging" without the 24 h spread');
			assert.deepStrictEqual(row(2).tags, ['Busy now', 'PvP']);
			assert.deepStrictEqual(row(3).tags, ['Ratting']);
			assert.deepStrictEqual(row(1).tags, ['Quiet']);
			assert.strictEqual(scan.rows[0].id, S(2));
		});
		it('copes with no activity data at all', () => {
			const scan = stagingScan.analyse([{ id: S(1), jumps: 0 }], null, null);
			assert.strictEqual(scan.rows[0].busy, false);
			assert.deepStrictEqual(scan.rows[0].tags, ['Quiet']);
		});
	});

	describe('sortRows', () => {
		const rows = [
			{ id: S(1), jumps: 3, score: 10, now: { jumps: 5, kills: 0, npc: 1 }, day: { jumps: 50, kills: 1, npc: 9, activeHours: 3 } },
			{ id: S(2), jumps: 1, score: 30, now: { jumps: 1, kills: 0, npc: 7 }, day: { jumps: 90, kills: 0, npc: 2, activeHours: 20 } },
			{ id: S(3), jumps: 2, score: 20, now: { jumps: 9, kills: 4, npc: 0 }, day: { jumps: 10, kills: 5, npc: 1, activeHours: 1 } }
		];
		const names = { [S(1)]: 'Bravo', [S(2)]: 'Charlie', [S(3)]: 'Alpha' };
		const secs = { [S(1)]: -0.2, [S(2)]: -0.9, [S(3)]: 0.0 };
		const info = (id) => ({ name: names[id], security: secs[id] });
		const ids = (out) => out.map(r => r.id - 30000000);
		it('sorts by column and direction without changing the input', () => {
			assert.deepStrictEqual(ids(stagingScan.sortRows(rows, 'score', -1, info)), [2, 3, 1]);
			assert.deepStrictEqual(ids(stagingScan.sortRows(rows, 'jumps', 1, info)), [2, 3, 1]);
			assert.deepStrictEqual(ids(stagingScan.sortRows(rows, 'nowJumps', -1, info)), [3, 1, 2]);
			assert.deepStrictEqual(ids(stagingScan.sortRows(rows, 'dayJumps', -1, info)), [2, 1, 3]);
			assert.deepStrictEqual(ids(stagingScan.sortRows(rows, 'dayKills', -1, info)), [3, 1, 2]);
			assert.deepStrictEqual(ids(stagingScan.sortRows(rows, 'dayNpc', -1, info)), [1, 2, 3]);
			assert.deepStrictEqual(ids(stagingScan.sortRows(rows, 'name', 1, info)), [3, 1, 2]);
			assert.deepStrictEqual(ids(stagingScan.sortRows(rows, 'sec', 1, info)), [2, 1, 3]);
			assert.deepStrictEqual(ids(rows), [1, 2, 3]);
		});
	});

	describe('secText', () => {
		it('rounds to one decimal like EVE', () => {
			assert.strictEqual(stagingScan.secText(-0.39), '-0.4');
			assert.strictEqual(stagingScan.secText(-0.04), '0.0');
			assert.strictEqual(stagingScan.secText(0), '0.0');
			assert.strictEqual(stagingScan.secText(undefined), '');
		});
	});

	describe('decorate', () => {
		const node = (id) => ({ c: [{ v: 'n' + id, systemID: id, f: "<div data-nodeid='" + id + "'><div class='nodeIcons'></div><h4>x</h4></div>" }] });
		it('adds an escaped badge to the staging systems only, once', () => {
			const result = { map: { rows: [node(S(1)), node(S(2)), Object.assign(node(S(1)), { destination: true })] } };
			assert.strictEqual(stagingScan.decorate(result, [S(1)], "Tip <b>&'"), 1);
			assert.ok(result.map.rows[0].c[0].f.indexOf("<span class='staging-badge' data-tooltip='Tip &lt;b&gt;&amp;&#39;'>STG</span><div class='nodeIcons'>") > 0);
			assert.strictEqual(result.map.rows[1].c[0].f.indexOf('staging-badge'), -1);
			assert.strictEqual(result.map.rows[2].c[0].f.indexOf('staging-badge'), -1, 'not on a destination node');
			assert.strictEqual(stagingScan.decorate(result, [S(1)], 'Tip'), 0, 'not twice');
		});
		it('does nothing without staging systems or rows', () => {
			assert.strictEqual(stagingScan.decorate({ map: { rows: [node(S(1))] } }, [], 'Tip'), 0);
			assert.strictEqual(stagingScan.decorate(null, [S(1)], 'Tip'), 0);
		});
	});

	describe('escape', () => {
		it('escapes HTML', () => {
			assert.strictEqual(stagingScan.escape("<a href='x'>&\"</a>"), '&lt;a href=&#39;x&#39;&gt;&amp;&quot;&lt;/a&gt;');
			assert.strictEqual(stagingScan.escape(null), '');
		});
	});
});
