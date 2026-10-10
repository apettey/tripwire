const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/preserve-mass');

const flag = (id, extra) => Object.assign({ wormholeID: id, setBy: 'Chribba', setAt: 1791659280, reason: '' }, extra || {});

describe('Preserve mass', () => {
	describe('isWormholeID', () => {
		it('number', () => assert.ok(preserveMass.isWormholeID(42)));
		it('string', () => assert.ok(preserveMass.isWormholeID('42')));
		it('EVE-Scout link', () => assert.ok(!preserveMass.isWormholeID('ES-123')));
		it('placeholder', () => assert.ok(!preserveMass.isWormholeID('?')));
		it('zero', () => assert.ok(!preserveMass.isWormholeID(0)));
		it('negative', () => assert.ok(!preserveMass.isWormholeID(-1)));
		it('float', () => assert.ok(!preserveMass.isWormholeID('1.5')));
		it('too big for an int column', () => assert.ok(!preserveMass.isWormholeID('2147483648')));
		it('null / undefined / boolean / empty', () => {
			[null, undefined, true, false, ''].forEach(v => assert.ok(!preserveMass.isWormholeID(v), String(v)));
		});
	});

	describe('toMap', () => {
		it('keys flags by wormhole id', () => {
			const m = preserveMass.toMap([flag(5, { reason: 'home static' }), flag(7)]);
			assert.deepStrictEqual(Object.keys(m).sort(), ['5', '7']);
			assert.strictEqual(m['5'].reason, 'home static');
			assert.strictEqual(m['5'].wormholeID, 5);
		});
		it('drops invalid entries and normalises missing fields', () => {
			const m = preserveMass.toMap([null, { wormholeID: 'ES-1' }, { wormholeID: '9' }]);
			assert.deepStrictEqual(m, { '9': { wormholeID: 9, setBy: null, setAt: null, reason: '' } });
		});
		it('not a list', () => assert.deepStrictEqual(preserveMass.toMap(undefined), {}));
	});

	describe('changed', () => {
		const a = preserveMass.toMap([flag(5), flag(7)]);
		it('same flags, other order', () => assert.ok(!preserveMass.changed(a, preserveMass.toMap([flag(7), flag(5)]))));
		it('flag added', () => assert.ok(preserveMass.changed(a, preserveMass.toMap([flag(5), flag(7), flag(8)]))));
		it('flag removed', () => assert.ok(preserveMass.changed(a, preserveMass.toMap([flag(5)]))));
		it('reason changed', () => assert.ok(preserveMass.changed(a, preserveMass.toMap([flag(5), flag(7, { reason: 'x' })]))));
		it('set by someone else', () => assert.ok(preserveMass.changed(a, preserveMass.toMap([flag(5), flag(7, { setBy: 'Kytus' })]))));
		it('empty vs empty', () => assert.ok(!preserveMass.changed({}, {})));
	});

	describe('cleanReason', () => {
		it('trims and collapses whitespace', () => assert.strictEqual(preserveMass.cleanReason('  fleet\n\tout  '), 'fleet out'));
		it('keeps markup as text (escaped when shown)', () => assert.strictEqual(preserveMass.cleanReason('<b>x</b>'), '<b>x</b>'));
		it('drops zero-width and direction marks', () => assert.strictEqual(preserveMass.cleanReason('a​b‮c'), 'abc'));
		it('control characters', () => assert.strictEqual(preserveMass.cleanReason('a\u0000b'), 'a b'));
		it('length in characters', () => assert.strictEqual(Array.from(preserveMass.cleanReason('😀'.repeat(150))).length, 100));
		it('null', () => assert.strictEqual(preserveMass.cleanReason(null), ''));
	});

	describe('formatTime / setByText / tooltipText', () => {
		it('EVE time (UTC)', () => assert.strictEqual(preserveMass.formatTime(Date.UTC(2026, 9, 10, 19, 8) / 1000), '2026-10-10 19:08 EVE'));
		it('unknown time', () => assert.strictEqual(preserveMass.formatTime(null), ''));
		it('who and when', () => assert.strictEqual(preserveMass.setByText(flag(1, { setAt: Date.UTC(2026, 9, 10, 9, 5) / 1000 })), 'Set by Chribba, 2026-10-10 09:05 EVE'));
		it('when only', () => assert.strictEqual(preserveMass.setByText(flag(1, { setBy: null, setAt: Date.UTC(2026, 9, 10, 9, 5) / 1000 })), 'Set 2026-10-10 09:05 EVE'));
		it('nothing known', () => assert.strictEqual(preserveMass.setByText(flag(1, { setBy: null, setAt: null })), ''));
		it('tooltip with reason', () => {
			const t = preserveMass.tooltipText(flag(1, { setAt: Date.UTC(2026, 9, 10, 9, 5) / 1000, reason: 'home static' }));
			assert.strictEqual(t, "Preserve mass: don't roll this hole\nSet by Chribba, 2026-10-10 09:05 EVE\nReason: home static");
		});
		it('tooltip without reason', () => assert.strictEqual(preserveMass.tooltipText(flag(1, { setBy: null, setAt: null })), "Preserve mass: don't roll this hole"));
	});

	describe('escaping', () => {
		const evil = flag(1, { setBy: '<img src=x onerror=alert(1)>', reason: "'><script>alert(2)</script>\"" });
		it('marker title', () => {
			const html = preserveMass.markerHtml(evil, 'pm-centred', { left: 10, top: 20 });
			assert.ok(html.indexOf('<img') < 0 && html.indexOf('<script') < 0, html);
			assert.ok(html.indexOf("'>") === html.indexOf("'>" + preserveMass.GLYPH), 'the title attribute is not broken out of: ' + html);
			assert.ok(html.indexOf('&lt;script&gt;') > 0);
		});
		it('mass dialog panel', () => {
			const html = preserveMass.panelHtml(evil);
			assert.ok(html.indexOf('<img') < 0 && html.indexOf('<script') < 0, html);
			assert.ok(html.indexOf('&#39;&gt;&lt;script&gt;') > 0);
		});
		it('marker position is numbers only', () => {
			const html = preserveMass.markerHtml(flag(1), '', { left: '1px; background: url(x)', top: 2.6, shift: 7.4 });
			assert.ok(html.indexOf('url(') < 0, html);
			assert.ok(html.indexOf('left: 0px; top: 3px; transform: translate(7px, 0)') > 0, html);
		});
	});

	describe('markerHtml / panelHtml', () => {
		it('no flag, no marker', () => assert.strictEqual(preserveMass.markerHtml(null), ''));
		it('marker classes', () => {
			const html = preserveMass.markerHtml(flag(1), 'pm-beside', { left: 1, top: 2 });
			assert.ok(html.indexOf("class='preserve-mass-marker size-tag-connector pm-beside'") > 0, html);
		});
		it('unflagged panel offers to flag', () => assert.ok(preserveMass.panelHtml(null).indexOf('pm-mark') > 0));
		it('flagged panel warns and offers to clear', () => {
			const html = preserveMass.panelHtml(flag(1, { reason: 'home static' }));
			assert.ok(html.indexOf("don't roll this hole") > 0);
			assert.ok(html.indexOf('pm-clear') > 0);
			assert.ok(html.indexOf('home static') > 0);
		});
		it('flagged panel without who/when/reason has no meta line', () => {
			assert.ok(preserveMass.panelHtml(flag(1, { setBy: null, setAt: null })).indexOf('pm-meta') < 0);
		});
	});

	describe('besideTag', () => {
		it('right of the tag with a gap', () => assert.strictEqual(preserveMass.besideTag(100, 16), 110));
		it('custom gap', () => assert.strictEqual(preserveMass.besideTag(100, 16, 0), 108));
		it('no tag', () => assert.strictEqual(preserveMass.besideTag(100, 0), 102));
	});

	describe('besidePoint', () => {
		const point = { x: 100, y: 50 }, tag = { width: 16, height: 11 };
		it('no tag: on the point', () => assert.deepStrictEqual(preserveMass.besidePoint(point, null, []), { x: 100, y: 50 }));
		it('right of the tag when free', () => assert.deepStrictEqual(preserveMass.besidePoint(point, tag, []), { x: 118, y: 50 }));
		it('left of the tag when a node is on the right', () => {
			assert.deepStrictEqual(preserveMass.besidePoint(point, tag, [{ x0: 110, y0: 30, x1: 160, y1: 70 }]), { x: 82, y: 50 });
		});
		it('below when nodes are on both sides', () => {
			const nodes = [{ x0: 110, y0: 30, x1: 160, y1: 70 }, { x0: 40, y0: 30, x1: 90, y1: 70 }];
			assert.deepStrictEqual(preserveMass.besidePoint(point, tag, nodes), { x: 100, y: 63.5 });
		});
		it('least covered when nowhere is free', () => {
			const around = [{ x0: 0, y0: 0, x1: 200, y1: 44 }, { x0: 0, y0: 56, x1: 200, y1: 100 }, { x0: 0, y0: 44, x1: 92, y1: 56 }];
			assert.deepStrictEqual(preserveMass.besidePoint(point, tag, around), { x: 118, y: 50 });
		});
	});

	describe('centredRect', () => {
		it('box around the centre', () => assert.deepStrictEqual(preserveMass.centredRect(100, 50, 16, 10), { x0: 92, y0: 45, x1: 108, y1: 55 }));
		it('bad numbers', () => assert.deepStrictEqual(preserveMass.centredRect('x', undefined, null, NaN), { x0: 0, y0: 0, x1: 0, y1: 0 }));
	});

	describe('layout', () => {
		const tag = { width: 16, height: 11 };
		it('avoids the size tag of another connection', () => {
			// the tag of a neighbouring connection sits right of this one's tag
			const other = preserveMass.centredRect(125, 50, 16, 11);
			assert.deepStrictEqual(preserveMass.layout([{ point: { x: 100, y: 50 }, tag: tag, obstacles: [] }], [other]), [{ x: 82, y: 50 }]);
		});
		it('avoids markers placed before it', () => {
			// two connections whose tags are 36 px apart: the first marker goes right of its tag, into the gap; the
			// second has a node on its right and would go left of its tag (the gap), but the first marker is there: below
			const items = [
				{ point: { x: 100, y: 50 }, tag: tag, obstacles: [] },
				{ point: { x: 136, y: 50 }, tag: tag, obstacles: [{ x0: 146, y0: 30, x1: 200, y1: 70 }] }
			];
			const tags = [preserveMass.centredRect(100, 50, 16, 11), preserveMass.centredRect(136, 50, 16, 11)];
			const at = preserveMass.layout(items, tags);
			assert.deepStrictEqual(at, [{ x: 118, y: 50 }, { x: 136, y: 63.5 }]);
		});
		it('markers never overlap each other here', () => {
			const items = [0, 1, 2].map(i => ({ point: { x: 100 + 20 * i, y: 50 }, tag: tag, obstacles: [] }));
			const at = preserveMass.layout(items, items.map(i => preserveMass.centredRect(i.point.x, i.point.y, 16, 11)));
			for (let i = 0; i < at.length; i++) {
				for (let j = i + 1; j < at.length; j++) {
					assert.ok(Math.abs(at[i].x - at[j].x) >= 16 || Math.abs(at[i].y - at[j].y) >= 12, JSON.stringify(at));
				}
			}
		});
		it('empty', () => assert.deepStrictEqual(preserveMass.layout([], []), []));
	});

	describe('enabled', () => {
		it('missing key means on', () => assert.ok(preserveMass.enabled({})));
		it('no options', () => assert.ok(preserveMass.enabled(undefined)));
		it('on', () => assert.ok(preserveMass.enabled({ preserveMass: { enabled: true } })));
		it('off', () => assert.ok(!preserveMass.enabled({ preserveMass: { enabled: false } })));
	});

	describe('flagForNode', () => {
		const flags = preserveMass.toMap([flag(5)]);
		it('flagged connection', () => assert.strictEqual(preserveMass.flagForNode({ connection: [2, 1, [], 5] }, flags).wormholeID, 5));
		it('string id', () => assert.strictEqual(preserveMass.flagForNode({ connection: [2, 1, [], '5'] }, flags).wormholeID, 5));
		it('other connection', () => assert.strictEqual(preserveMass.flagForNode({ connection: [3, 1, [], 6] }, flags), null));
		it('placeholder connection', () => assert.strictEqual(preserveMass.flagForNode({ connection: [3, 1, [], '?'] }, flags), null));
		it('root node', () => assert.strictEqual(preserveMass.flagForNode({}, flags), null));
	});

	describe('payload', () => {
		it('set with a cleaned reason', () => assert.deepStrictEqual(preserveMass.payload('set', '5', '  home \n static '), { mode: 'set', wormholeID: 5, reason: 'home static' }));
		it('clear', () => assert.deepStrictEqual(preserveMass.payload('clear', 5), { mode: 'clear', wormholeID: 5 }));
	});

	describe('legendRow', () => {
		it('has the marker', () => assert.ok(preserveMass.legendRow().indexOf('preserve-mass-legend') > 0));
		it('fits in the double-quoted data-tooltip attribute', () => assert.ok(preserveMass.legendRow().indexOf('"') < 0));
	});
});
