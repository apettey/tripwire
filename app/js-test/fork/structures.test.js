const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('app/js/fork/intel-scans');	// the d-scan parser and distance format
include('app/js/fork/structures');

const types = loadJSON('public/intel/types');
const fixtures = loadJSON('structures/tests/fixtures');
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);	// 2026-10-11 12:00 EVE
const NOW_S = NOW / 1000;

const row = (o) => Object.assign({
	id: 1, systemID: 31001235, typeID: 35832, typeName: 'Astrahus', kind: 'upwell', name: 'J163701 - Home Base',
	ownerID: null, ownerType: null, ownerName: null, ownerTicker: null, ownerText: null, side: 'unknown',
	state: 'online', timerKind: null, timerAt: null, timerSetBy: null, note: '', firstSeenAt: NOW_S - 3600, lastSeenAt: NOW_S - 3 * 86400,
	lastSeenBy: 'Scout', lastDistanceKm: 10, updatedAt: NOW_S, updatedBy: 'Scout', goneAt: null, goneBy: null
}, o);

describe('Structures', () => {
	describe('settings', () => {
		it('is on by default', () => {
			assert.equal(structures.enabled(undefined), true);
			assert.equal(structures.enabled({}), true);
			assert.equal(structures.enabled({ structures: {} }), true);
			assert.equal(structures.enabled({ structures: { enabled: false } }), false);
		});
	});

	describe('classify and parse (shared fixtures with the PHP tests)', () => {
		it('classifies Upwell, POS towers and deployables, not ships, modules are not rows', () => {
			assert.deepEqual(structures.classify(35832, 'Astrahus', types), { typeID: 35832, typeName: 'Astrahus', kind: 'upwell', tower: false });
			assert.equal(structures.classify(16213, '', types).tower, true);
			assert.equal(structures.classify(null, 'mobile depot', types).kind, 'deployable');
			assert.equal(structures.classify(22456, 'Sabre', types), null);
			assert.equal(structures.classify(null, 'Nothing Like It', types), null);
			assert.equal(structures.classify(17182, '', types).tower, false);
		});
		it('splits the system prefix off Upwell names', () => {
			assert.deepEqual(structures.splitName('J163701 - Home Base'), { prefix: 'J163701', rest: 'Home Base' });
			assert.deepEqual(structures.splitName('Thera - Keep Star - Main'), { prefix: 'Thera', rest: 'Keep Star - Main' });
			assert.deepEqual(structures.splitName('Plain'), { prefix: '', rest: 'Plain' });
			assert.deepEqual(structures.splitName(''), { prefix: '', rest: '' });
		});
		fixtures.parse.forEach((c) => {
			it('parse: ' + c.name, () => {
				const r = structures.parseScan(c.lines.join('\r\n'), types, c.systemName);
				assert.deepEqual(r.structures.map((s) => [s.typeID, s.typeName, s.kind, s.name, s.km, s.prefix, s.rest, s.wrong]), c.structures);
				assert.deepEqual([r.modules, r.notRecognised, r.invalid], [c.modules, c.notRecognised, c.invalid]);
			});
		});
		it('an Upwell named for another system is flagged wrong only for J-codes', () => {
			const r = structures.parseScan('35832\tJ999999 - X\tAstrahus\t1 km\n35832\tJita - X\tAstrahus\t1 km', types, 'J163701');
			assert.deepEqual(r.structures.map((s) => s.wrong), [true, false]);
		});
	});

	describe('merge', () => {
		fixtures.merge.forEach((c) => {
			it('merge: ' + c.name, () => {
				assert.deepEqual(structures.merge(c.existing, c.incoming), c.expected);
			});
		});
	});

	describe('timer input', () => {
		it('parses EVE time, ISO and offsets', () => {
			assert.equal(structures.parseTime('2026.10.12 18:30', NOW).ms, Date.UTC(2026, 9, 12, 18, 30));
			assert.equal(structures.parseTime('2026-10-12 18:30', NOW).ms, Date.UTC(2026, 9, 12, 18, 30));
			assert.equal(structures.parseTime('2026-10-12T18:30:15Z', NOW).ms, Date.UTC(2026, 9, 12, 18, 30, 15));
			assert.equal(structures.parseTime('2026-10-12T20:30:00+02:00', NOW).ms, Date.UTC(2026, 9, 12, 18, 30));
		});
		it('parses countdowns read off the game', () => {
			assert.equal(structures.parseTime('1d 4h 20m', NOW).ms, NOW + ((24 + 4) * 60 + 20) * 60000);
			assert.equal(structures.parseTime('4:20:00', NOW).ms, NOW + (4 * 60 + 20) * 60000);
			assert.equal(structures.parseTime('1d 4h', NOW).ms, NOW + 28 * 3600000);
			assert.equal(structures.parseTime('4:20:07', NOW).ms, NOW + (4 * 3600 + 20 * 60 + 7) * 1000);	// seconds are kept
			assert.equal(structures.parseTime('1h 2m 3s', NOW + 500).ms, NOW + 500 + 3723000);
			assert.equal(structures.parseTime('2h14', NOW).ms, NOW + 134 * 60000);
			assert.equal(structures.parseTime('45m', NOW).ms, NOW + 45 * 60000);
			assert.equal(structures.parseTime('90 s', NOW).ms, NOW + 90000);
		});
		it('a bare HH:MM is an EVE clock time, today or tomorrow', () => {
			assert.deepEqual(structures.parseTime('18:30', NOW), { ms: Date.UTC(2026, 9, 11, 18, 30), clock: true });	// NOW is 12:00
			assert.equal(structures.parseTime('9:05', NOW).ms, Date.UTC(2026, 9, 12, 9, 5));	// more than 2 h past: tomorrow
			assert.equal(structures.parseTime('10:30', NOW).ms, Date.UTC(2026, 9, 11, 10, 30));	// just elapsed: still today
			assert.equal(structures.parseTime('10:00', NOW).ms, Date.UTC(2026, 9, 11, 10, 0));	// exactly 2 h: today
			assert.equal(structures.parseTime('9:59', NOW).ms, Date.UTC(2026, 9, 12, 9, 59));
			assert.equal(structures.parseTime('12:00', NOW).ms, NOW);
			assert.ok(structures.parseTime('24:00', NOW).error);
			assert.ok(structures.parseTime('12:75', NOW).error);
		});
		it('sends second precision', () => {
			assert.equal(structures.formatEveFull(Date.UTC(2026, 9, 12, 8, 5, 9)), '2026-10-12 08:05:09');
		});
		it('refuses garbage and impossible dates', () => {
			['', '   ', 'soon', '2026-02-31 10:00', '2026-13-01 10:00', '2026-10-12 25:00', 'abc 4h'].forEach((t) => {
				assert.ok(structures.parseTime(t, NOW).error, t);
			});
		});
		it('allows 2 hours in the past and 30 days ahead, no more', () => {
			assert.equal(structures.timerRangeError(NOW - 7200000, NOW), '');
			assert.ok(structures.timerRangeError(NOW - 7200001, NOW));
			assert.equal(structures.timerRangeError(NOW + 2592000000, NOW), '');
			assert.ok(structures.timerRangeError(NOW + 2592000001, NOW));
		});
	});

	describe('form changes', () => {
		const stored = row({ ownerID: 11, ownerType: 'corporation', ownerName: 'Home Corp', ownerTicker: 'HOME', state: 'reinforced',
			timerKind: 'armor', timerAt: NOW_S - 3 * 3600, note: 'n' });
		const same = { owner: 'HOME', state: 'reinforced', note: 'n', tkind: 'armor', tat: structures.formatEve((NOW_S - 3 * 3600) * 1000).replace(/-/g, '.') };
		it('an untouched form sends nothing, so an ended timer is not range-checked again', () => {
			assert.deepEqual(structures.formDiff(stored, same, NOW), { params: {} });
		});
		it('sends only what changed', () => {
			assert.deepEqual(structures.formDiff(stored, Object.assign({}, same, { note: 'x' }), NOW), { params: { note: 'x' } });
			assert.deepEqual(structures.formDiff(stored, Object.assign({}, same, { owner: '' }), NOW), { params: { owner: '' } });
		});
		it('a new timer is sent without the state, so the server maps it (armor -> reinforced)', () => {
			const r = structures.formDiff(row({ state: 'online' }), { owner: '', state: 'online', note: '', tkind: 'armor', tat: '2h14m' }, NOW);
			assert.deepEqual(Object.keys(r.params).sort(), ['timerAt', 'timerKind']);
			assert.equal(r.params.timerAt, '2026-10-11 14:14:00');
		});
		it('clearing the timer, a timer without a time, a bad timer', () => {
			assert.deepEqual(structures.formDiff(stored, Object.assign({}, same, { tkind: '', tat: '' }), NOW), { params: { timerKind: '' } });
			assert.ok(structures.formDiff(row(), { owner: '', state: 'online', note: '', tkind: 'hull', tat: '' }, NOW).error);
			assert.ok(structures.formDiff(row(), { owner: '', state: 'online', note: '', tkind: 'hull', tat: '2026.10.01 10:00' }, NOW).error);
		});
		it('a new structure sends the state only when it is not the default', () => {
			assert.deepEqual(structures.formDiff(null, { owner: 'HSTL', state: 'unknown', note: '', tkind: '', tat: '' }, NOW), { params: { owner: 'HSTL' } });
			assert.equal(structures.formDiff(null, { owner: '', state: 'online', note: '', tkind: '', tat: '' }, NOW).params.state, 'online');
		});
	});

	describe('default placement', () => {
		it('right of the existing widgets when it fits, else below them', () => {
			const widgets = [{ col: 1, row: 1, size_x: 7, size_y: 6 }, { col: 8, row: 1, size_x: 7, size_y: 6 }];
			assert.deepEqual(structures.defaultPlacement(widgets, 30), { col: 15, row: 1, size_x: 4, size_y: 3 });
			assert.deepEqual(structures.defaultPlacement(widgets, 17), { col: 1, row: 7, size_x: 4, size_y: 3 });
			assert.deepEqual(structures.defaultPlacement([], 17), { col: 1, row: 1, size_x: 4, size_y: 3 });
		});
	});

	describe('formatting', () => {
		it('countdown text', () => {
			assert.equal(structures.duration(45), '45s');
			assert.equal(structures.duration(14 * 60 + 5), '14m');
			assert.equal(structures.duration(2 * 3600 + 14 * 60), '2h14');
			assert.equal(structures.duration(3600 + 5 * 60), '1h05');
			assert.equal(structures.duration(86400 + 4 * 3600 + 20 * 60), '1d4h');
			assert.equal(structures.duration(-5), '0s');
		});
		it('EVE time', () => {
			assert.equal(structures.formatEve(Date.UTC(2026, 9, 12, 8, 5)), '2026-10-12 08:05');
		});
		it('timer phases: upcoming, red under 1 h, elapsed for 2 h, then ended', () => {
			const t = (secs) => structures.timerStatus(row({ timerKind: 'armor', timerAt: NOW_S + secs }), NOW_S);
			assert.deepEqual([t(3 * 3600).phase, t(3 * 3600).text, t(3 * 3600).urgent], ['upcoming', '3h00', false]);
			assert.deepEqual([t(1800).phase, t(1800).urgent], ['upcoming', true]);
			assert.deepEqual([t(-600).phase, t(-600).text], ['elapsed', '-10m']);
			assert.equal(t(-7200).phase, 'elapsed');
			assert.equal(t(-7201).phase, 'ended');
			assert.equal(structures.timerStatus(row(), NOW_S).phase, 'none');
		});
		it('age', () => {
			assert.deepEqual([10, 120, 7200, 3 * 86400].map(structures.age), ['now', '2m', '2h', '3d']);
		});
	});

	describe('residents strip', () => {
		const rows = [
			row({ id: 1, ownerID: 11, ownerType: 'corporation', ownerName: 'Home Corp', ownerTicker: 'HOME', side: 'ours' }),
			row({ id: 2, ownerID: 22, ownerType: 'corporation', ownerName: 'Bad Guys', ownerTicker: 'BAD', side: 'hostile' }),
			row({ id: 3, ownerID: 22, ownerType: 'corporation', ownerName: 'Bad Guys', ownerTicker: 'BAD', side: 'hostile' }),
			row({ id: 4, ownerText: 'Mystery Inc' }),
			row({ id: 5 })
		];
		it('one chip per owner: ours, hostile, unresolved, with counts; no owner = no chip', () => {
			const r = structures.residents(rows, []);
			assert.deepEqual(r.map((c) => [c.ticker, c.side, c.count]), [['HOME', 'ours', 1], ['BAD', 'hostile', 2], ['Mystery Inc', 'unknown', 1]]);
		});
		it('adds corporations seen in kills as outlined chips, not twice, at most 3', () => {
			const extra = [{ id: 22, name: 'Bad Guys', ticker: 'BAD' }, { id: 31, name: 'A', ticker: 'A' }, { id: 32, name: 'B', ticker: 'B' }, { id: 33, name: 'C', ticker: 'C' }, { id: 34, name: 'D', ticker: 'D' }];
			const r = structures.residents(rows, extra);
			assert.deepEqual(r.filter((c) => c.side === 'seen').map((c) => c.ticker), ['A', 'B', 'C']);
			assert.equal(r.filter((c) => c.ticker === 'BAD').length, 1);
		});
		it('a chip links to zKillboard only when resolved, and is escaped', () => {
			const html = structures.chipHtml({ key: 'corporation:22', side: 'hostile', id: 22, type: 'corporation', ticker: '<b>', name: 'x', count: 2 }, null);
			assert.ok(html.includes('zkillboard.com/corporation/22/'));
			assert.ok(html.includes('&lt;b&gt;'));
			assert.ok(!structures.chipHtml({ key: 'text:x', side: 'unknown', id: null, type: null, ticker: 'x', name: 'x', count: 1 }, null).includes('zkillboard'));
		});
	});

	describe('panel', () => {
		const state = (o) => Object.assign({ rows: [], gone: [], nowSec: NOW_S, highlight: null, editing: null, moreID: null, showGone: false, extraCorps: [], types: types, error: '', loaded: true }, o);

		it('empty state, and loading', () => {
			assert.ok(structures.panelHtml(state()).includes('No structures recorded'));
			assert.ok(structures.panelHtml(state({ loaded: false })).includes('Loading'));
		});
		it('one line per structure with the icon, owner ticker, state icon, timer and age; details only in the title', () => {
			const html = structures.panelHtml(state({ rows: [row({ ownerID: 11, ownerType: 'corporation', ownerName: 'Home Corp', ownerTicker: 'HOME', side: 'ours',
				state: 'reinforced', timerKind: 'armor', timerAt: NOW_S + 2 * 3600 + 14 * 60, timerSetBy: 'Scout', note: 'bring a bomber' })] }));
			assert.equal((html.match(/class='str-row/g) || []).length, 1);
			assert.ok(html.includes('images.evetech.net/types/35832/icon'));
			assert.ok(html.includes('>HOME<'));
			assert.ok(html.includes('2h14'));
			assert.ok(html.includes('str-st-reinforced'));
			assert.ok(html.includes('>3d<'));
			assert.ok(/title='[^']*Armor timer: 2026-10-11 14:14 EVE/.test(html));
			assert.ok(/title='[^']*Note: bring a bomber/.test(html));
			assert.ok(!/>bring a bomber</.test(html));
		});
		it('escapes hostile names, owners and notes', () => {
			const html = structures.panelHtml(state({ rows: [row({ name: '<img src=x onerror=alert(1)>', ownerText: '<script>x</script>', note: '"><b>' })] }));
			assert.ok(!html.includes('<img src=x'));
			assert.ok(!html.includes('<script>'));
			assert.ok(!html.includes('"><b>'));
		});
		it('marks an unresolved owner, an urgent timer and stale rows', () => {
			const html = structures.panelHtml(state({ rows: [row({ ownerText: 'Mystery', timerKind: 'hull', timerAt: NOW_S + 600, lastSeenAt: NOW_S - 40 * 86400 })] }));
			assert.ok(html.includes('str-unres'));
			assert.ok(html.includes('str-urgent'));
			assert.ok(html.includes('str-stale'));
			assert.ok(html.includes('(stale)'));
		});
		it('highlights the clicked owner and dims the rest', () => {
			const html = structures.panelHtml(state({ highlight: 'corporation:11', rows: [
				row({ id: 1, ownerID: 11, ownerType: 'corporation', ownerName: 'Home', ownerTicker: 'HOME', side: 'ours' }), row({ id: 2 })] }));
			assert.equal((html.match(/str-hl/g) || []).length, 1);
			assert.equal((html.match(/str-dim/g) || []).length, 1);
		});
		it('gone rows are collapsed with a count and have Undo when opened', () => {
			const gone = [row({ id: 9, state: 'destroyed', goneAt: NOW_S - 3600 })];
			assert.ok(structures.panelHtml(state({ gone: gone })).includes('Gone (1)'));
			assert.ok(!structures.panelHtml(state({ gone: gone })).includes('str-undo'));
			assert.ok(structures.panelHtml(state({ gone: gone, showGone: true })).includes('str-undo'));
		});
		it('shows the add form and the edit form for one row', () => {
			assert.ok(structures.panelHtml(state({ editing: 'new' })).includes("data-for='new'"));
			const html = structures.panelHtml(state({ rows: [row({ id: 4, timerKind: 'armor', timerAt: NOW_S + 3600 })], editing: 4 }));
			assert.ok(html.includes("data-for='4'") && html.includes('value=\'2026.10.11 13:00\''));
		});
		it('header text: count and the next timer', () => {
			assert.equal(structures.headerText([], NOW_S), '');
			assert.equal(structures.headerText([row(), row({ id: 2, timerKind: 'hull', timerAt: NOW_S + 3 * 3600 })], NOW_S), '2 · hull 3h00');
		});
		it('type names for the add form: Upwell, deployables and towers, no modules', () => {
			const names = structures.typeNames(types);
			assert.ok(names.includes('Astrahus') && names.includes('Mobile Depot') && names.includes('Caldari Control Tower') && names.includes('Unknown structure'));
			assert.ok(!names.includes('Warp Scrambling Battery') && !names.includes('Sabre'));
		});
	});

	describe('d-scan dialog section', () => {
		const scan = structures.parseScan(fixtures.parse[0].lines.join('\n'), types, 'J163701');
		it('lists the structures with checkboxes, tags new / seen again, warns about the wrong system', () => {
			const existing = [row({ id: 1, typeID: 35832, name: 'J163701 - Home Base' }), row({ id: 2, typeID: 35833, name: 'J163701 - Gone Missing', typeName: 'Fortizar' }),
				row({ id: 3, typeID: 35832, name: 'J163701 - Oldname' })];
			const v = structures.dialogHtml(scan, existing, {}, true, 'J163701');
			assert.ok(v.html.includes('Save structures to J163701 (6)'));
			assert.ok(v.html.includes('str-dlg-seen-again') && v.html.includes('str-dlg-new'));
			assert.ok(v.html.includes('1 structure is named for J123456, not J163701 (unchecked)'));
			assert.ok(v.html.includes('Not in this scan: 2'));
			assert.ok(v.html.includes('Possibly renamed: 1'));
			assert.ok(v.html.includes('2 POS modules not stored'));
			assert.equal(v.saveCount, 5);	// the wrong-system row is unchecked by default
		});
		it('unchecked master saves nothing; an explicit check overrides the default', () => {
			assert.equal(structures.dialogHtml(scan, null, {}, false, 'J163701').saveCount, 0);
			assert.equal(structures.dialogHtml(scan, null, { 1: true, 0: false }, true, 'J163701').saveCount, 5);
		});
		it('without stored rows (other system) no tags are shown', () => {
			assert.ok(!structures.dialogHtml(scan, null, {}, true, 'J163701').html.includes('str-dlg-tag'));
		});
		it('escapes names', () => {
			const s = structures.parseScan('35832\t<b>x</b>\tAstrahus\t1 km', types, 'J1');
			assert.ok(!structures.dialogHtml(s, [], {}, true, '<i>').html.includes('<b>x'));
		});
		it('a removed stored row is restored by the scan', () => {
			const existing = [row({ id: 1, typeID: 35832, name: 'J163701 - Home Base', state: 'removed' })];
			assert.ok(structures.dialogHtml(scan, existing, {}, true, 'J163701').html.includes('restored'));
		});
	});
});
