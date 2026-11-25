const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/hole-roll-stats');

describe('Hole statistics', () => {
	const h = holeRollStats;
	const HOME = 31002012;		// J163701, C5 with an H296 static
	const C5a = 31002013, C5b = 31002014, C5c = 31000880;
	const row = (firstSeen, homeType, farSystemID, farType, extra) => Object.assign({
		id: 0, wormholeID: 0, homeSig: 'abc123', homeType: homeType, farSystemID: farSystemID || 0, farSig: '', farType: farType || '',
		firstSeen: firstSeen, lastUpdated: firstSeen, source: 'live', guessed: 0 }, extra || {});

	it('reads home statics from appData', () => {
		assert.deepStrictEqual(h.staticsOf(HOME, appData.systems), ['H296']);
		assert.deepStrictEqual(h.staticsOf(1, appData.systems), []);
	});

	it('classifies a hole by its home-side type', () => {
		assert.strictEqual(h.classify(row('2026-11-01 00:00:00', 'H296'), ['H296']), 'static');
		assert.strictEqual(h.classify(row('2026-11-01 00:00:00', 'h296'), ['H296']), 'static');
		assert.strictEqual(h.classify(row('2026-11-01 00:00:00', 'K162'), ['H296']), 'inbound');
		assert.strictEqual(h.classify(row('2026-11-01 00:00:00', ''), ['H296']), 'other');
		assert.strictEqual(h.classify(row('2026-11-01 00:00:00', 'N062'), ['H296']), 'other');		// a wandering hole out of home
	});

	it('names the space of a system as wormhole types do', () => {
		assert.strictEqual(h.spaceOf(HOME, appData.systems), 'Class-5');
		assert.strictEqual(h.spaceOf(30000142, appData.systems), 'High-Sec');	// Jita
		assert.strictEqual(h.spaceOf(31000005, appData.systems), 'Class-12');	// Thera
		assert.strictEqual(h.spaceOf(1, appData.systems), '');
		assert.strictEqual(h.spaceLabel('Class-5'), 'C5');
		assert.strictEqual(h.spaceLabel('Class-12'), 'Thera');
		assert.strictEqual(h.spaceLabel('High-Sec'), 'HS');
	});

	it('counts the destination pool: exact class, k-space without Jove regions and Zarzakh', () => {
		const c5 = Object.keys(appData.systems).filter(id => { const c = appData.systems[id].class; return (Array.isArray(c) ? c[0] : c) == 5; }).length;
		assert.strictEqual(h.poolSize('Class-5', appData.systems), c5);
		assert.ok(c5 > 400 && c5 < 600, 'about 500 C5 systems: ' + c5);
		const hs = h.poolSize('High-Sec', appData.systems);
		const joveHs = Object.keys(appData.systems).filter(id => h.UNREACHABLE_REGIONS.includes(appData.systems[id].regionID) && h.spaceOf(id, appData.systems) === 'High-Sec').length;
		const allHs = Object.keys(appData.systems).filter(id => h.spaceOf(id, appData.systems) === 'High-Sec').length;
		assert.strictEqual(hs, allHs - joveHs);
		assert.strictEqual(h.poolSize('Unknown', appData.systems), 0);
		assert.strictEqual(h.poolSize('', appData.systems), 0);
		// a fake pool
		const systems = { 1: { class: 5 }, 2: { class: [5] }, 3: { class: 4 }, 30100000: { security: -1 }, 4: { security: -0.5, regionID: 10000017 }, 5: { security: -0.2 } };
		assert.strictEqual(h.poolSize('Class-5', systems), 2);
		assert.strictEqual(h.poolSize('Null-Sec', systems), 1);
	});

	it('computes the expected distinct destinations and repeats of uniform random rolls', () => {
		assert.deepStrictEqual(h.expected(1, 3), { distinct: 1, repeats: 2 });
		const e = h.expected(500, 20);
		assert.ok(Math.abs(e.distinct - 500 * (1 - Math.pow(499 / 500, 20))) < 1e-9);
		assert.ok(Math.abs(e.repeats - 0.3755) < 0.001, String(e.repeats));	// about k(k-1)/2N = 0.38
		assert.strictEqual(h.expected(500, 0).repeats, 0);
		assert.strictEqual(h.expected(0, 5), null);
	});

	it('counts static rolls, known destinations, repeats and the times-seen histogram', () => {
		const rows = [
			row('2026-11-01 10:00:00', 'H296', C5a),
			row('2026-11-02 10:00:00', 'H296', C5b),
			row('2026-11-03 10:00:00', 'H296', C5a),
			row('2026-11-04 10:00:00', 'H296', 0),			// far side never found: a roll, destination unknown
			row('2026-11-05 10:00:00', 'H296', C5a),
			row('2026-11-06 10:00:00', 'H296', C5c),
			row('2026-11-07 10:00:00', 'K162', C5b, 'H296'),	// inbound, not a roll
		];
		const s = h.staticStats(rows, ['H296'], appData.systems, appData.wormholes)[0];
		assert.strictEqual(s.leadsTo, 'Class-5');
		assert.strictEqual(s.rolls, 6);
		assert.strictEqual(s.known, 5);
		assert.strictEqual(s.distinct, 3);
		assert.strictEqual(s.repeats, 2);
		assert.deepStrictEqual(s.histogram, [{ times: 1, systems: 2 }, { times: 3, systems: 1 }]);
		assert.deepStrictEqual(s.destinations.map(d => [d.systemID, d.count]), [[C5a, 3], [C5c, 1], [C5b, 1]]);	// most, then latest
		assert.strictEqual(s.destinations[0].last, Date.UTC(2026, 10, 5, 10));
		assert.ok(s.pool > 400);
		assert.ok(Math.abs(s.expected.repeats - (5 - s.pool * (1 - Math.pow(1 - 1 / s.pool, 5)))) < 1e-9);
	});

	it('counts each row as given (de-duplication is the server\'s: a row is one hole)', () => {
		const rows = [row('2026-11-01 10:00:00', 'H296', C5a), row('2026-11-01 10:00:00', 'H296', C5a)];
		assert.strictEqual(h.staticStats(rows, ['H296'], appData.systems, appData.wormholes)[0].rolls, 2);
	});

	it('breaks inbound holes down by origin type and origin system', () => {
		const rows = [
			row('2026-11-01 10:00:00', 'K162', C5a, 'H296'),
			row('2026-11-02 10:00:00', 'K162', C5a, 'H296'),
			row('2026-11-03 10:00:00', 'K162', 30000142, 'B274'),
			row('2026-11-04 10:00:00', 'K162', 0, ''),
			row('2026-11-05 10:00:00', 'K162', 0, 'K162'),		// both ends K162 (odd data): origin type unknown
			row('2026-11-06 10:00:00', 'H296', C5b),
		];
		const inb = h.inboundStats(rows, ['H296']);
		assert.strictEqual(inb.total, 5);
		assert.deepStrictEqual(inb.byType.map(t => [t.type, t.count]), [['', 2], ['H296', 2], ['B274', 1]]);
		assert.deepStrictEqual(inb.bySystem.map(t => [t.systemID, t.count]), [[0, 2], [C5a, 2], [30000142, 1]]);
	});

	it('buckets by ISO week, month, quarter, half-year and year (UTC)', () => {
		const t = (y, m, d) => Date.UTC(y, m - 1, d, 12);
		assert.strictEqual(h.periodKey(t(2026, 1, 1), 'week'), '2026-W01');		// a Thursday
		assert.strictEqual(h.periodKey(t(2027, 1, 1), 'week'), '2026-W53');		// a Friday: last week of 2026
		assert.strictEqual(h.periodKey(t(2024, 12, 30), 'week'), '2025-W01');	// a Monday: first week of 2025
		assert.strictEqual(h.periodKey(t(2026, 11, 25), 'week'), '2026-W48');
		assert.strictEqual(h.periodStart(t(2026, 11, 25), 'week'), Date.UTC(2026, 10, 23));	// back to Monday
		assert.strictEqual(h.periodStart(Date.UTC(2026, 10, 29, 23, 59), 'week'), Date.UTC(2026, 10, 23));	// Sunday night
		assert.strictEqual(h.periodKey(t(2026, 11, 25), 'month'), '2026-11');
		assert.strictEqual(h.periodKey(t(2026, 3, 31), 'quarter'), '2026-Q1');
		assert.strictEqual(h.periodKey(t(2026, 4, 1), 'quarter'), '2026-Q2');
		assert.strictEqual(h.periodKey(t(2026, 6, 30), 'half'), '2026-H1');
		assert.strictEqual(h.periodKey(t(2026, 7, 1), 'half'), '2026-H2');
		assert.strictEqual(h.periodKey(t(2026, 7, 1), 'year'), '2026');
		assert.strictEqual(h.nextPeriod(Date.UTC(2026, 9, 1), 'quarter'), Date.UTC(2027, 0, 1));
		assert.strictEqual(h.nextPeriod(Date.UTC(2026, 6, 1), 'half'), Date.UTC(2027, 0, 1));
		assert.strictEqual(h.nextPeriod(Date.UTC(2026, 11, 1), 'month'), Date.UTC(2027, 0, 1));
	});

	it('builds a timeline with empty periods filled in', () => {
		const rows = [
			row('2026-01-15 10:00:00', 'H296', C5a),
			row('2026-01-20 10:00:00', 'K162', C5a),
			row('2026-04-02 10:00:00', 'H296', C5b),
			row('2026-04-03 10:00:00', '', 0),
		];
		const months = h.timeline(rows, ['H296'], 'month');
		assert.deepStrictEqual(months.map(p => [p.key, p.static, p.inbound, p.other]),
			[['2026-01', 1, 1, 0], ['2026-02', 0, 0, 0], ['2026-03', 0, 0, 0], ['2026-04', 1, 0, 1]]);
		assert.deepStrictEqual(h.timeline(rows, ['H296'], 'quarter').map(p => p.key), ['2026-Q1', '2026-Q2']);
		assert.deepStrictEqual(h.timeline(rows, ['H296'], 'year').map(p => [p.key, p.static]), [['2026', 2]]);
		assert.strictEqual(h.timeline(rows, ['H296'], 'week').length, 12);	// W03 .. W14
		assert.deepStrictEqual(h.timeline([], ['H296'], 'month'), []);
	});

	it('filters by date range (to includes its whole day)', () => {
		const rows = [row('2026-11-01 00:00:00', 'H296'), row('2026-11-02 23:59:59', 'H296'), row('2026-11-03 00:00:00', 'H296'), row('bad', 'H296')];
		assert.strictEqual(h.inRange(rows, '', '').length, 3);
		assert.strictEqual(h.inRange(rows, '2026-11-02', '').length, 2);
		assert.strictEqual(h.inRange(rows, '', '2026-11-02').length, 2);
		assert.strictEqual(h.inRange(rows, '2026-11-02', '2026-11-02').length, 1);
	});

	it('writes CSV oldest first, quoted where needed and safe from spreadsheet formulas', () => {
		const rows = [
			row('2026-11-02 10:00:00', 'K162', C5a, 'H296', { homeSig: 'xyz789', source: 'backfill', guessed: 1 }),
			row('2026-11-01 10:00:00', 'H296', 0, '', { homeSig: '=cmd', farSig: 'a,"b"' }),
		];
		const lines = h.toCSV(rows, ['H296'], appData.systems).split('\r\n');
		assert.strictEqual(lines[0], 'first_seen_utc,last_updated_utc,kind,home_sig,home_type,far_system,far_system_id,far_space,far_sig,far_type,source,side_guessed');
		assert.strictEqual(lines[1], "2026-11-01 10:00:00,2026-11-01 10:00:00,static,'=CMD,H296,,,,\"A,\"\"B\"\"\",,live,0");
		assert.strictEqual(lines[2], '2026-11-02 10:00:00,2026-11-02 10:00:00,inbound,XYZ789,K162,' + appData.systems[C5a].name + ',' + C5a + ',C5,,H296,backfill,1');
		assert.strictEqual(lines[3], '');
		assert.strictEqual(h.csvField('-1'), "'-1");
		assert.strictEqual(h.csvField(null), '');
	});

	it('renders the no-home message and escapes what it shows', () => {
		const state = { from: '', to: '', gran: 'month', sorts: {} };
		assert.ok(/Mask Admin &gt; Discord &gt; Home system/.test(h.render({ home: 0, rows: [] }, state, appData.systems, appData.wormholes)));
		const html = h.render({ home: HOME, rows: [
			row('2026-11-02 10:00:00', 'K162', 0, '<b>x</b>'),
			row('2026-11-01 10:00:00', 'H296', C5a),
		], backfill: { doneAt: '2026-11-25 10:00:00', rows: 1 }, capped: false, max: 20000 }, state, appData.systems, appData.wormholes);
		assert.ok(!/<b>x<\/b>/i.test(html) && /&lt;b&gt;x&lt;\/b&gt;/i.test(html));
		assert.ok(/H296 static to C5/.test(html));
		assert.ok(/N = \d+ C5 systems/.test(html));
		assert.ok(/2026-11/.test(html));
		assert.ok(!/only its newest rows/.test(html));
		const capped = h.render({ home: HOME, rows: [row('2026-11-01 10:00:00', 'H296', C5a)], backfill: { doneAt: '2026-11-25 10:00:00', rows: 1, capped: true } },
			state, appData.systems, appData.wormholes);
		assert.ok(/only its newest rows were read/.test(capped));
	});

	it('is on unless switched off', () => {
		assert.strictEqual(h.enabled(undefined), true);
		assert.strictEqual(h.enabled({}), true);
		assert.strictEqual(h.enabled({ holeRollStats: { enabled: true } }), true);
		assert.strictEqual(h.enabled({ holeRollStats: { enabled: false } }), false);
	});
});
