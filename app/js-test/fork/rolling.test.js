const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/preserve-mass');
include('app/js/fork/rolling');

// 2026-10-10 19:08 UTC
const T = Date.UTC(2026, 9, 10, 19, 8) / 1000;
const flag = (id, extra) => Object.assign({ wormholeID: id, setByID: 196379789, setBy: 'Chribba', setAt: T, note: '' }, extra || {});

describe('Rolling', () => {
	describe('toMap', () => {
		it('keys flags by wormhole id', () => {
			const m = holeRolling.toMap([flag(5, { note: 'closing it' }), flag(7)]);
			assert.deepStrictEqual(Object.keys(m).sort(), ['5', '7']);
			assert.strictEqual(m['5'].note, 'closing it');
			assert.strictEqual(m['5'].setByID, 196379789);
		});
		it('drops invalid entries and normalises missing fields', () => {
			const m = holeRolling.toMap([null, { wormholeID: 'ES-1' }, { wormholeID: '9' }]);
			assert.deepStrictEqual(m, { 9: { wormholeID: 9, setByID: null, setBy: null, setAt: null, note: '' } });
		});
		it('not a list', () => assert.deepStrictEqual(holeRolling.toMap(null), {}));
	});

	describe('changed', () => {
		it('same flags', () => assert.ok(!holeRolling.changed(holeRolling.toMap([flag(5)]), holeRolling.toMap([flag(5)]))));
		it('note changed', () => assert.ok(holeRolling.changed(holeRolling.toMap([flag(5)]), holeRolling.toMap([flag(5, { note: 'x' })]))));
		it('flag added', () => assert.ok(holeRolling.changed({}, holeRolling.toMap([flag(5)]))));
	});

	describe('cleanNote', () => {
		it('collapses whitespace and control characters, drops zero-width marks', () => {
			assert.strictEqual(holeRolling.cleanNote('  closing\n\tit​ now '), 'closing it now');
		});
		it('at most 100 characters', () => assert.strictEqual(holeRolling.cleanNote('x'.repeat(150)).length, 100));
		it('null', () => assert.strictEqual(holeRolling.cleanNote(null), ''));
	});

	describe('texts', () => {
		it('EVE time is UTC HH:MM', () => {
			assert.strictEqual(holeRolling.eveTime(T), '19:08 EVE');
			assert.strictEqual(holeRolling.eveTime(null), '');
		});
		it('tooltip: who, when and the note', () => {
			assert.strictEqual(holeRolling.tooltipText(flag(5, { note: 'new static' })), 'Rolling — started by Chribba at 19:08 EVE\nNote: new static');
			assert.strictEqual(holeRolling.tooltipText(flag(5, { setBy: null, setAt: null })), 'Rolling — started');
		});
		it('mass dialog line', () => {
			assert.strictEqual(holeRolling.beingRolledText(flag(5)), 'Being rolled by Chribba since 19:08 EVE');
			assert.strictEqual(holeRolling.beingRolledText(flag(5, { setBy: null })), 'Being rolled since 19:08 EVE');
		});
		it('marker escapes the tooltip and only puts numbers in its style', () => {
			const html = holeRolling.markerHtml(flag(5, { setBy: "<b>'x'</b>", note: '"><script>' }), 'hr-centred', { left: '10.4', top: 'x;color:red' });
			assert.ok(html.indexOf('<b>') < 0 && html.indexOf('<script>') < 0);
			assert.ok(html.indexOf('&lt;b&gt;&#39;x&#39;&lt;/b&gt;') > 0);
			assert.ok(html.indexOf("style='left: 10px; top: 0px;'") > 0);
			assert.ok(html.indexOf("class='hole-rolling-marker size-tag-connector hr-centred'") > 0);
			assert.ok(html.indexOf('>↻</span>') > 0);
		});
		it('no flag, no marker', () => assert.strictEqual(holeRolling.markerHtml(null), ''));
		it('panel: link without a flag, the escaped line and note with one', () => {
			assert.ok(/class='hr-mark'/.test(holeRolling.panelHtml(null)));
			const html = holeRolling.panelHtml(flag(5, { setBy: '<i>', note: '<img src=x>' }));
			assert.ok(html.indexOf('Being rolled by &lt;i&gt; since 19:08 EVE') > 0);
			assert.ok(html.indexOf('&lt;img src=x&gt;') > 0 && html.indexOf('<img') < 0);
			assert.ok(/class='hr-clear'/.test(html));
			assert.ok(/class='hr-rolled'[^>]*>Rolled \(closed\)</.test(html));
		});
		it('the marker tooltip says how many passes and how much mass went through', () => {
			const withPasses = Object.assign(flag(5), { passes: 3, massKg: 450e6 });
			assert.strictEqual(holeRolling.passesText(withPasses), '3 passes, 450 kt through');
			assert.strictEqual(holeRolling.passesText(Object.assign(flag(5), { passes: 1, massKg: 1234e6 })), '1 pass, 1,234 kt through');
			assert.ok(holeRolling.tooltipText(withPasses).split('\n').pop() === '3 passes, 450 kt through');
			assert.strictEqual(holeRolling.passesText(flag(5)), '');
			assert.strictEqual(holeRolling.passesText(Object.assign(flag(5), { passes: 0, massKg: 0 })), '');
			assert.strictEqual(holeRolling.tooltipText(flag(5)).indexOf('pass'), -1);
		});
		it('jump logs are read for new holes at once, then at most every 30 s, failures included', () => {
			const now = 1e6, ms = holeRolling.PASSES_MS;
			assert.deepStrictEqual(holeRolling.passesDue(['5', '7'], {}, {}, now), ['5', '7']);
			assert.deepStrictEqual(holeRolling.passesDue(['5', '7'], { 5: now - 1000 }, {}, now), ['7']);
			assert.deepStrictEqual(holeRolling.passesDue(['5', '7'], { 5: now - ms - 1, 7: now - ms + 1 }, {}, now), ['5']);
			assert.deepStrictEqual(holeRolling.passesDue(['5'], { 5: now - ms - 1 }, { 5: true }, now), []);
			assert.deepStrictEqual(holeRolling.passesDue(undefined, undefined, undefined, now), []);
		});
		it('passes are merged into the flags and count as a change', () => {
			const map = holeRolling.toMap([flag(5), flag(7)]);
			const merged = holeRolling.withPasses(map, { 5: { passes: 2, massKg: 10e6 } });
			assert.strictEqual(merged['5'].passes, 2);
			assert.strictEqual(merged['7'].passes, undefined);
			assert.ok(holeRolling.changed(map, merged));
			assert.ok(!holeRolling.changed(merged, holeRolling.withPasses(map, { 5: { passes: 2, massKg: 10e6 } })));
			assert.ok(holeRolling.changed(merged, holeRolling.withPasses(map, { 5: { passes: 3, massKg: 10e6 } })));
		});
		it('conflict confirms', () => {
			assert.strictEqual(holeRolling.preserveConflictText({ setBy: 'Kytus', reason: 'home static' }),
				'This hole is marked preserve mass by Kytus (home static): roll it anyway?');
			assert.strictEqual(holeRolling.preserveConflictText({ setBy: null, reason: '' }), 'This hole is marked preserve mass: roll it anyway?');
			assert.strictEqual(holeRolling.preserveConflictText(null), '');
			assert.strictEqual(holeRolling.rollingConflictText(flag(5, { note: 'closing' })), 'This hole is being rolled by Chribba (closing): preserve its mass anyway?');
			assert.strictEqual(holeRolling.rollingConflictText(null), '');
		});
		it('legend row', () => assert.ok(holeRolling.legendRow().indexOf('hole-rolling-legend') > 0));
	});

	describe('enabled', () => {
		it('missing key = on', () => assert.ok(holeRolling.enabled({})));
		it('undefined options = on', () => assert.ok(holeRolling.enabled(undefined)));
		it('explicitly off', () => assert.ok(!holeRolling.enabled({ rolling: { enabled: false } })));
		it('preserve mass off does not turn it off', () => assert.ok(holeRolling.enabled({ preserveMass: { enabled: false } })));
	});

	describe('payload', () => {
		it('set carries the cleaned note', () => assert.deepStrictEqual(holeRolling.payload('set', '5', ' a \n b '), { mode: 'set', wormholeID: 5, note: 'a b' }));
		it('clear has no note', () => assert.deepStrictEqual(holeRolling.payload('clear', 5), { mode: 'clear', wormholeID: 5 }));
		it('rolled has no note either', () => assert.deepStrictEqual(holeRolling.payload('rolled', 5), { mode: 'rolled', wormholeID: 5 }));
	});

	describe('flagForNode', () => {
		const flags = holeRolling.toMap([flag(5)]);
		it('the node connection\'s wormhole', () => assert.strictEqual(holeRolling.flagForNode({ connection: [1, 2, {}, 5] }, flags).wormholeID, 5));
		it('EVE-Scout connection', () => assert.strictEqual(holeRolling.flagForNode({ connection: [1, 2, {}, 'ES-5'] }, flags), null));
		it('root', () => assert.strictEqual(holeRolling.flagForNode({}, flags), null));
	});

	describe('placement', () => {
		const point = { x: 100, y: 100 }, tag = { width: 14, height: 10 };
		const tagRect = preserveMass.centredRect(100, 100, 14, 10);
		it('right of the size tag when nothing is there', () => {
			const at = holeRolling.layout([{ point: point, tag: tag, obstacles: [] }], [tagRect], []);
			assert.deepStrictEqual(at, [preserveMass.besidePoint(point, tag, [])]);
			assert.ok(at[0].x > 107);
		});
		it('avoids the preserve-mass marker on the same connection', () => {
			const pmAt = preserveMass.besidePoint(point, tag, []);
			const pmRect = preserveMass.centredRect(pmAt.x, pmAt.y, 16, 12);
			const at = holeRolling.layout([{ point: point, tag: tag, obstacles: [] }], [tagRect], [pmRect])[0];
			assert.notDeepStrictEqual(at, pmAt);
			const mine = preserveMass.centredRect(at.x, at.y, 16, 12);
			const overlap = Math.min(mine.x1, pmRect.x1) > Math.max(mine.x0, pmRect.x0) && Math.min(mine.y1, pmRect.y1) > Math.max(mine.y0, pmRect.y0);
			assert.ok(!overlap, JSON.stringify(at));
		});
		it('two rolling markers do not overlap each other', () => {
			const at = holeRolling.layout([{ point: point, tag: tag }, { point: { x: 104, y: 100 }, tag: tag }], [tagRect], []);
			assert.notDeepStrictEqual(at[0], at[1]);
		});
		it('on the point without a tag', () => assert.deepStrictEqual(holeRolling.layout([{ point: point, tag: null }], [], []), [{ x: 100, y: 100 }]));
		it('old org chart: right of the tag, then of the preserve-mass marker', () => {
			assert.strictEqual(holeRolling.orgShift(0, 0), undefined);
			assert.strictEqual(holeRolling.orgShift(20, 0), preserveMass.besideTag(0, 20));
			assert.strictEqual(holeRolling.orgShift(20, 14), preserveMass.besideTag(0, 20) + 14 + preserveMass.GAP);
			assert.strictEqual(holeRolling.orgShift(0, 14), 7 + preserveMass.GAP);
		});
	});
});
