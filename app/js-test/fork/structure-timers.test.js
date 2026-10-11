const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/intel-scans');
include('app/js/fork/structures');
include('app/js/fork/structure-timers');

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const NOW_S = NOW / 1000;

const row = (o) => Object.assign({
	id: 1, systemID: 31001235, typeID: 35832, typeName: 'Astrahus', kind: 'upwell', name: 'J163701 - Home Base',
	ownerID: null, ownerType: null, ownerName: null, ownerTicker: null, ownerText: null, side: 'unknown',
	state: 'reinforced', timerKind: 'armor', timerAt: NOW_S + 3600 * 5, timerSetBy: 'Scout', note: '', lastSeenAt: NOW_S - 86400
}, o);

describe('Structure timers', () => {
	describe('settings', () => {
		it('map markers are on by default', () => {
			assert.equal(structureTimers.mapMarkerEnabled(undefined), true);
			assert.equal(structureTimers.mapMarkerEnabled({ structures: { enabled: false } }), true);
			assert.equal(structureTimers.mapMarkerEnabled({ structures: { mapMarker: false } }), false);
		});
	});

	describe('chain map markers', () => {
		const entry = (o) => Object.assign({ count: 3, hostile: true, types: [['Fortizar', 2], ['Athanor', 1]], owners: ['BAD'], lastSeen: NOW_S - 3 * 86400, nextTimer: null }, o);

		it('structure glyph: tooltip lists types, owners and sighting; orange when hostile', () => {
			const m = structureTimers.markerFor(entry(), NOW_S);
			assert.equal(m.title, '2 Fortizar, 1 Athanor · BAD · seen 3d ago');
			assert.equal(m.timer, null);
			const html = structureTimers.markerHtml(m);
			assert.ok(html.includes('str-m-hostile') && !html.includes('str-m-timer'));
			assert.ok(structureTimers.markerHtml(structureTimers.markerFor(entry({ hostile: false }), NOW_S)).includes('str-m-neutral'));
		});
		it('nothing to draw: no structures and no timer in range', () => {
			assert.equal(structureTimers.markerFor(null, NOW_S), null);
			assert.equal(structureTimers.markerFor(entry({ count: 0 }), NOW_S), null);
			assert.equal(structureTimers.markerFor(entry({ count: 0, nextTimer: { kind: 'armor', at: NOW_S + 49 * 3600 } }), NOW_S), null);
		});
		it('clock glyph: within 48 h, amber; red under 1 h; elapsed under 2 h red; older gone', () => {
			const at = (s) => structureTimers.timerGlyph({ kind: 'hull', at: NOW_S + s, typeName: 'Fortizar', name: 'Home' }, NOW_S);
			assert.equal(at(47 * 3600).level, 'soon');
			assert.equal(at(49 * 3600), null);
			assert.equal(at(52 * 60).level, 'urgent');
			assert.ok(at(52 * 60).title.startsWith('Hull timer in 52m (12:52 EVE)'));
			assert.equal(at(-1800).level, 'urgent');
			assert.ok(at(-1800).title.includes('30m ago'));
			assert.equal(at(-7201), null);
		});
		it('both glyphs, timer-only systems, and escaping', () => {
			const m = structureTimers.markerFor(entry({ nextTimer: { kind: 'armor', at: NOW_S + 600, typeName: '<i>', name: '' } }), NOW_S);
			const html = structureTimers.markerHtml(m);
			assert.ok(html.includes('str-m-both') && html.includes('str-m-urgent'));
			assert.ok(html.includes('&lt;i&gt;'));
			const only = structureTimers.markerFor(entry({ count: 0, types: [], owners: [], lastSeen: null, nextTimer: { kind: 'other', at: NOW_S + 7200, typeName: 'Mobile Depot', name: '' } }), NOW_S);
			assert.ok(!structureTimers.markerHtml(only).includes("class='str-m-s'"));
		});
		it('is inserted before the node icon row, once', () => {
			const node = "<div id='node1' class='node'><div class='nodeIcons'><div></div></div><h4></h4></div>";
			const out = structureTimers.insertMarker(node, "<span class='str-marker'></span>");
			assert.ok(out.indexOf('str-marker') < out.indexOf('nodeIcons'));
			assert.equal(structureTimers.insertMarker(out, "<span class='str-marker'></span>"), out);
			assert.equal(structureTimers.insertMarker('<div></div>', 'x'), '<div></div>');
		});
		it('collects the real systems of a chain build, skipping destinations and repeats', () => {
			const result = { map: { rows: [{ c: [{ v: 1, systemID: 31001235 }] }, { c: [{ v: 2, systemID: 31001235 }] }, { c: [{ v: 'dest-5', systemID: 30000142 }] },
				{ c: [{ v: 3, systemID: 0 }] }, { c: [{ v: 4, systemID: 30000142 }] }] } };
			assert.deepEqual(structureTimers.chainSystems(result, null), [31001235, 30000142]);
		});
	});

	describe('system info line', () => {
		it('count and next timer', () => {
			assert.equal(structureTimers.infoLine([], NOW_S), '');
			assert.equal(structureTimers.infoLine([row({ timerKind: null, timerAt: null })], NOW_S), '1 structure');
			assert.equal(structureTimers.infoLine([row({ id: 1 }), row({ id: 2, timerAt: NOW_S + 4 * 3600 + 12 * 60, timerKind: 'hull' }), row({ id: 3, timerKind: null, timerAt: null })], NOW_S),
				'3 structures · hull timer in 4h12');
			assert.equal(structureTimers.infoLine([row({ timerAt: NOW_S - 600, timerKind: 'armor' })], NOW_S), '1 structure · armor timer 10m ago');
			assert.equal(structureTimers.infoLine([row({ timerAt: NOW_S - 9000 })], NOW_S), '1 structure');
		});
	});

	describe('board', () => {
		const rows = [
			row({ id: 1, timerAt: NOW_S + 7200, side: 'hostile', ownerID: 2, ownerTicker: 'BAD', ownerType: 'corporation' }),
			row({ id: 2, timerAt: NOW_S + 600, side: 'ours', ownerID: 3, ownerTicker: 'OUR', ownerType: 'corporation' }),
			row({ id: 3, timerAt: NOW_S - 600, side: 'unknown' }),
			row({ id: 4, timerAt: NOW_S - 9000, side: 'hostile' }),
			row({ id: 5, timerKind: null, timerAt: null })
		];
		it('soonest first; ended and timerless rows drop off', () => {
			assert.deepEqual(structureTimers.boardRows(rows, {}, NOW_S).map((r) => r.id), [3, 2, 1]);
		});
		it('filters: hostile only keeps everything that is not ours; hide ended hides the elapsed', () => {
			assert.deepEqual(structureTimers.boardRows(rows, { hostileOnly: true }, NOW_S).map((r) => r.id), [3, 1]);
			assert.deepEqual(structureTimers.boardRows(rows, { hideEnded: true }, NOW_S).map((r) => r.id), [2, 1]);
			assert.deepEqual(structureTimers.boardRows(rows, { hideEnded: true, hostileOnly: true }, NOW_S).map((r) => r.id), [1]);
		});
		it('renders a compact row per timer: countdown, system (not in chain muted), owner, kind; escaped', () => {
			const ctx = { rows: rows.concat([row({ id: 9, typeName: '<b>Fort</b>', ownerText: '<x>', timerAt: NOW_S + 60 })]), filters: {}, nowSec: NOW_S, inChain: { 31001235: true },
				systemName: (id) => (id === 31001235 ? 'J163701' : 'Elsewhere'), loaded: true };
			const html = structureTimers.boardHtml(ctx);
			assert.equal((html.match(/str-trow/g) || []).length, 4);
			assert.ok(html.includes('J163701'));
			const out = structureTimers.boardHtml(Object.assign({}, ctx, { inChain: {} }));
			assert.ok(out.includes('str-notchain') && out.includes('not in the chain'));
			assert.ok(!html.includes('<b>Fort') && html.includes('&lt;b&gt;Fort'));
			assert.ok(html.includes('data-sys=\'31001235\''));
		});
		it('empty and loading states, and the countdown helper', () => {
			const base = { rows: [], filters: {}, nowSec: NOW_S, inChain: {}, systemName: String };
			assert.ok(structureTimers.boardHtml(Object.assign({ loaded: true }, base)).includes('No active timers'));
			assert.ok(structureTimers.boardHtml(Object.assign({ loaded: false }, base)).includes('Loading'));
			assert.deepEqual(structureTimers.countdown({ timerKind: 'x', timerAt: NOW_S + 600 }, NOW_S), { text: '10m', cls: 'str-t-upcoming str-urgent' });
			assert.deepEqual(structureTimers.countdown({ timerKind: 'x', timerAt: NOW_S + 7200 }, NOW_S), { text: '2h00', cls: 'str-t-upcoming' });
		});
	});
});
