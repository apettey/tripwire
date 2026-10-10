const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/tripwire/genericSystemTypes');
include('app/js/wormholeAnalysis');
include('app/js/systemAnalysis');
jQuery = { fn: {} };
include('app/js/helpers');
include('app/js/fork/size-tags');

describe('Chain map size tags', () => {
	const J152820 = 31001880, J135100 = 31001881;	// both C5
	const JITA = 30000142;	// High-Sec

	describe('sizeOf', () => {
		it('frigate hole is S', () => assert.equal(sizeTags.sizeOf(5000000), 'S'));
		it('62kt / 20kt are M', () => { assert.equal(sizeTags.sizeOf(62000000), 'M'); assert.equal(sizeTags.sizeOf(20000000), 'M'); });
		it('300/375/410kt are L', () => ['300', '375', '410'].forEach(kt => assert.equal(sizeTags.sizeOf(kt * 1e6), 'L')));
		it('1,000kt is VL', () => assert.equal(sizeTags.sizeOf(1000000000), 'VL'));
		it('2,000kt is XL', () => assert.equal(sizeTags.sizeOf(2000000000), 'XL'));
		it('no size is null', () => { assert.equal(sizeTags.sizeOf(undefined), null); assert.equal(sizeTags.sizeOf(0), null); });
	});

	describe('tagFor with known types', () => {
		const sizeFor = (type, k162First) => k162First ? sizeTags.tagFor('K162', type, J152820, J135100) : sizeTags.tagFor(type, 'K162', J152820, J135100);
		it('H296 is XL, certain', () => assert.deepEqual(sizeFor('H296'), { size: 'XL', certain: true, jump: 2000000000 }));
		it('H296 on the child side too', () => assert.equal(sizeFor('H296', true).size, 'XL'));
		it('D792 is VL', () => assert.equal(sizeFor('D792').size, 'VL'));
		it('M267 is L', () => assert.equal(sizeFor('M267').size, 'L'));
		it('Q317 is M', () => assert.equal(sizeFor('Q317').size, 'M'));
		it('Z006 is S', () => assert.equal(sizeFor('Z006').size, 'S'));
		it('O883 is M', () => assert.equal(sizeFor('O883').size, 'M'));
		it('known types are certain', () => ['D792', 'M267', 'Q317', 'Z006', 'O883'].forEach(t => assert.ok(sizeFor(t).certain, t)));
	});

	describe('tagFor with unknown type', () => {
		it('K162 between two C5s is a likely XL', () => assert.deepEqual(sizeTags.tagFor('K162', 'K162', J152820, J135100), { size: 'XL', certain: false, jump: 2000000000 }));
		it('K162 from C5 to High-Sec is a guess', () => assert.equal(sizeTags.tagFor('K162', 'K162', J152820, JITA).certain, false));
		it('GATE has no size', () => assert.equal(sizeTags.tagFor('GATE', 'K162', JITA, 30000144), null));
	});

	describe('tagHtml', () => {
		it('certain XL', () => assert.equal(sizeTags.tagHtml({ size: 'XL', certain: true, jump: 2e9 }),
			'<span class="size-tag size-xl" title="Max ship 2,000 kt (capitals)">XL</span>'));
		it('likely tag has ? and uncertain class', () => {
			const html = sizeTags.tagHtml({ size: 'L', certain: false, jump: 375e6 });
			assert.ok(html.indexOf('size-uncertain') > 0);
			assert.ok(html.indexOf('>L?</span>') > 0);
		});
		it('no tag is empty', () => assert.equal(sizeTags.tagHtml(null), ''));
	});

	describe('decorate chain.nodes result', () => {
		const nodeHtml = (id, type) => "<div id='node" + id + "' class='node'><h4 class='nodeClass'>C5</h4><h4 class='nodeType'><a href='#'>" + type + "</a></h4><div class='statics'></div></div>";
		const makeResult = () => {
			const root = { c: [{ v: 1, systemID: J152820, f: nodeHtml(1, '&nbsp;') }, { v: null }] };
			const holeChild = { systemID: J135100, type: 'H296' };
			const hole = { c: [{ v: 2, systemID: J135100, f: nodeHtml(2, 'H296') }, { v: 1 }], pathHome: [holeChild] };
			const k162Child = { systemID: J135100, type: 'K162' };
			const k162 = { c: [{ v: 3, systemID: J135100, f: nodeHtml(3, 'K162') }, { v: 1 }], pathHome: [k162Child] };
			const k162Known = { c: [{ v: 4, systemID: JITA, f: nodeHtml(4, 'K162') }, { v: 2 }], pathHome: [holeChild, { systemID: JITA, type: 'K162' }] };
			const dest = { c: [{ v: 'dest-1', systemID: JITA, f: "<div class='node destination-node'><h4 class='nodeType'>x</h4></div>" }, { v: 1 }], destination: true, pathHome: [{ systemID: JITA, type: 'K162' }] };
			const calc = { c: [{ v: 6, systemID: JITA, f: nodeHtml(6, 'path') }, { v: 2 }], pathHome: [holeChild, { systemID: JITA, path: [1, 2] }] };
			return { map: { rows: [root, hole, k162, k162Known, dest, calc] }, lines: [[2, 1, [], 'wh2'], [3, 1, [], 'wh3'], [4, 2, [], 'wh4']] };
		};
		const types = { wh2: 'H296', wh4: 'D792' };
		const result = sizeTags.decorate(makeResult(), id => types[id]);
		const tag = i => result.map.rows[i].c[0].sizeTag;
		const html = i => result.map.rows[i].c[0].f;

		it('does not tag the root', () => assert.equal(tag(0), undefined));
		it('tags a known hole', () => assert.deepEqual(tag(1), { size: 'XL', certain: true, jump: 2000000000 }));
		it('tags an unknown K162 as likely', () => assert.deepEqual(tag(2), { size: 'XL', certain: false, jump: 2000000000 }));
		it('uses the wormhole type for the K162 side', () => assert.equal(tag(3).size, 'VL'));
		it('skips destination nodes', () => assert.equal(tag(4), undefined));
		it('skips calculated route nodes', () => assert.equal(tag(5), undefined));
		it('leaves the node markup alone (the tag goes on the connection)', () => {
			for (let i = 0; i < 6; i++) { assert.ok(html(i).indexOf('size-tag') < 0, 'row ' + i); }
		});
		it('decorating twice keeps one tag per node', () => {
			sizeTags.decorate(result, id => types[id]);
			assert.equal(tag(1).size, 'XL');
			assert.equal(tag(0), undefined);
		});
		it('tagsByNodeId maps child node ids to their tags', () => {
			const tags = sizeTags.tagsByNodeId(result.map);
			assert.deepEqual(Object.keys(tags).sort(), ['2', '3', '4']);
			assert.equal(tags[4].size, 'VL');
			assert.deepEqual(sizeTags.tagsByNodeId(undefined), {});
		});
	});

	describe('connector geometry', () => {
		const line = (x0, y0, x1, y1, n) => Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + (x1 - x0) * i / n, y: y0 + (y1 - y0) * i / n }));
		const near = (p, x, y, eps) => assert.ok(Math.abs(p.x - x) <= (eps || 0.01) && Math.abs(p.y - y) <= (eps || 0.01), JSON.stringify(p) + ' vs ' + x + ',' + y);

		it('cubicPoint: ends and middle', () => {
			const p0 = { x: 0, y: 0 }, p1 = { x: 0, y: 10 }, p2 = { x: 10, y: 10 }, p3 = { x: 10, y: 0 };
			near(sizeTags.cubicPoint(p0, p1, p2, p3, 0), 0, 0);
			near(sizeTags.cubicPoint(p0, p1, p2, p3, 1), 10, 0);
			near(sizeTags.cubicPoint(p0, p1, p2, p3, 0.5), 5, 7.5);
		});

		it('tracePath records lines from the node position', () => {
			const renderer = {};
			const draw = function(ctx, node) { assert.equal(this, renderer); ctx.lineTo(node.parent.position.x, node.parent.position.y); };
			const pts = sizeTags.tracePath(draw, renderer, { position: { x: 0, y: 0 }, parent: { position: { x: 10, y: 20 } } }, 4);
			assert.equal(pts.length, 5);
			near(pts[0], 0, 0); near(pts[2], 5, 10); near(pts[4], 10, 20);
		});

		it('tracePath follows bezier and quadratic curves', () => {
			// the org chart (top) curve: up from the child, then across to the parent
			const draw = (ctx, node) => ctx.bezierCurveTo(node.position.x, -50, node.position.x, -50, 0, -50);
			const pts = sizeTags.tracePath(draw, {}, { position: { x: 100, y: 0 } }, 10);
			assert.equal(pts.length, 11);
			near(pts[10], 0, -50);
			near(pts[5], 87.5, -43.75);
			const quad = sizeTags.tracePath((ctx) => ctx.quadraticCurveTo(0, 10, 10, 10), {}, { position: { x: 0, y: 0 } }, 2);
			near(quad[1], 2.5, 7.5); near(quad[2], 10, 10);
		});

		it('nodeRect is centred on the position', () => {
			assert.deepEqual(sizeTags.nodeRect({ position: { x: 10, y: 20 }, requestedSize: { width: 40, height: 30 } }), { x0: -10, x1: 30, y0: 5, y1: 35 });
		});

		it('visibleMidpoint: middle of the line between the node boxes', () => {
			// child box covers x up to 20, parent box from 60 on a line from 0 to 100: visible 20..60
			const pts = line(0, 0, 100, 0, 100);
			near(sizeTags.visibleMidpoint(pts, [{ x0: -10, x1: 20, y0: -5, y1: 5 }, { x0: 60, x1: 110, y0: -5, y1: 5 }]), 40, 0, 0.5);
		});

		it('visibleMidpoint: without rects it is the middle of the whole line', () => {
			near(sizeTags.visibleMidpoint(line(0, 0, 0, 80, 8), []), 0, 40);
		});

		it('visibleMidpoint: falls back to the middle when the boxes cover the whole line', () => {
			near(sizeTags.visibleMidpoint(line(0, 0, 100, 0, 10), [{ x0: -10, x1: 110, y0: -5, y1: 5 }]), 50, 0);
		});

		it('visibleMidpoint: null below minVisible, or for an empty path', () => {
			const pts = line(0, 0, 100, 0, 100);
			assert.equal(sizeTags.visibleMidpoint(pts, [{ x0: -10, x1: 49, y0: -5, y1: 5 }, { x0: 51, x1: 110, y0: -5, y1: 5 }], 4), null);
			assert.equal(sizeTags.visibleMidpoint([], []), null);
			near(sizeTags.visibleMidpoint([{ x: 3, y: 4 }], []), 3, 4);
		});

		it('growRect and inRect', () => {
			const r = sizeTags.growRect({ x0: 0, y0: 0, x1: 10, y1: 10 }, 2);
			assert.deepEqual(r, { x0: -2, y0: -2, x1: 12, y1: 12 });
			assert.ok(sizeTags.inRect({ x: 11, y: 0 }, r));
			assert.ok(!sizeTags.inRect({ x: 12, y: 0 }, r));
		});

		it('outsideRects keeps only rects sticking out of the box', () => {
			const box = { left: 0, top: 0, right: 50, bottom: 30 };
			const inside = { left: 5, top: 5, right: 20, bottom: 15 }, badge = { left: -4, top: -4, right: 10, bottom: 8 }, empty = { left: -9, top: -9, right: -9, bottom: 2 };
			assert.deepEqual(sizeTags.outsideRects(box, [inside, badge, empty, null]), [badge]);
		});

		it('toMapRect converts screen px to map px (zoom)', () => {
			assert.deepEqual(sizeTags.toMapRect({ left: 120, top: 80, right: 160, bottom: 110 }, { left: 100, top: 50 }, 2), { x0: 10, y0: 15, x1: 30, y1: 30 });
			assert.deepEqual(sizeTags.toMapRect({ left: 1, top: 2, right: 3, bottom: 4 }, { left: 0, top: 0 }, 0), { x0: 1, y0: 2, x1: 3, y1: 4 });
		});

		it('nearestClearPoint slides off a rect along the line', () => {
			const pts = line(0, 0, 100, 0, 100);
			near(sizeTags.nearestClearPoint(pts, { x: 50, y: 0 }, [{ x0: 45, x1: 52, y0: -5, y1: 5 }]), 52, 0);
			near(sizeTags.nearestClearPoint(pts, { x: 50, y: 0 }, []), 50, 0);
			assert.equal(sizeTags.nearestClearPoint(pts, { x: 50, y: 0 }, [{ x0: -1, x1: 101, y0: -5, y1: 5 }]), null);
		});

		describe('pointOnPath', () => {
			const pts = line(0, 0, 200, 0, 200);
			const child = { x0: -30, x1: 30, y0: -20, y1: 20 }, parent = { x0: 170, x1: 230, y0: -20, y1: 20 };
			it('middle of the free line', () => near(sizeTags.pointOnPath(pts, [child, parent], []), 100, 0, 0.5));
			it('keeps clear of a badge on the line', () => {
				// badge over x 60..100: with margins the free line is 35..52 and 108..165
				const p = sizeTags.pointOnPath(pts, [child, parent], [{ x0: 60, x1: 100, y0: -6, y1: 6 }]);
				assert.ok(p.x >= 108 || p.x <= 52, JSON.stringify(p));
			});
			it('nodes nearly touching: between the borders, off the badges', () => {
				const a = { x0: -30, x1: 30, y0: -20, y1: 20 }, b = { x0: 40, x1: 100, y0: -20, y1: 20 };
				near(sizeTags.pointOnPath(line(0, 0, 70, 0, 70), [a, b], []), 35, 0, 0.5);
				const p = sizeTags.pointOnPath(line(0, 0, 70, 0, 70), [a, b], [{ x0: 31, x1: 36, y0: -3, y1: 3 }]);
				assert.ok(p.x >= 39 || p.x <= 28, JSON.stringify(p));
			});
		});
	});

	describe('tagHtml on a connector', () => {
		it('adds the extra class and position style', () => {
			const html = sizeTags.tagHtml({ size: 'M', certain: true, jump: 62e6 }, 'size-tag-connector', 'left: 3px; top: -4px');
			assert.equal(html, '<span class="size-tag size-m size-tag-connector" style="left: 3px; top: -4px" title="Max ship 62 kt (up to battlecruisers)">M</span>');
		});
	});

	describe('installRenderer', () => {
		const withStub = (name, fn, body) => { const orig = sizeTags[name]; sizeTags[name] = fn; try { body(); } finally { sizeTags[name] = orig; } };

		it('canvas renderers: tags are placed after draw and collapse, from the drawn connections', () => {
			const nodes = [{ id: 2 }, { id: 3 }];
			const ctx = { calls: [] };
			const drawConnection = function(c, node) { c.calls.push(node.id); };
			const renderer = {
				drawConnection: drawConnection,
				draw: function() { nodes.forEach(n => { this.drawConnection(ctx, n); this.drawConnection(ctx, n); }); return 'drawn'; },
				collapse: function() { this.drawConnection(ctx, nodes[0]); }
			};
			const placed = [];
			withStub('placeOnDrawnMap', (r, dc, ns) => placed.push({ r: r, dc: dc, ids: ns.map(n => n.id) }), () => {
				sizeTags.installRenderer(renderer);
				sizeTags.installRenderer(renderer);	// idempotent
				assert.equal(renderer.draw(), 'drawn');
				renderer.collapse();
			});
			assert.deepEqual(ctx.calls, [2, 2, 3, 3, 2]);	// the real drawing still happens
			assert.deepEqual(placed.map(p => p.ids), [[2, 3], [2]]);	// each connection once (auras draw twice)
			assert.equal(placed[0].r, renderer);
			assert.equal(placed[0].dc, drawConnection);	// traced with the original, not the hook
			assert.equal(renderer.sizeTagsNodes, null);
		});

		it('canvas renderers: tags are placed even if drawing throws', () => {
			const renderer = { drawConnection: () => {}, draw: () => { throw new Error('boom'); }, collapse: () => {} };
			let calls = 0;
			withStub('placeOnDrawnMap', () => calls++, () => {
				sizeTags.installRenderer(renderer);
				assert.throws(() => renderer.draw(), /boom/);
			});
			assert.equal(calls, 1);
		});

		it('old org chart: tags are placed after draw with the drawn map', () => {
			const map = { rows: [] };
			const renderer = { collapseHandler: () => {}, draw: function(m) { this.lastLineData = { map: m }; } };
			const maps = [];
			withStub('placeOnOrgChart', m => maps.push(m), () => {
				sizeTags.installRenderer(renderer);
				renderer.draw(map);
			});
			assert.deepEqual(maps, [map]);
			assert.ok(renderer.sizeTagsOrgChart);
		});

		it('installRenderers hooks the current renderer, renderer switches and the org chart collapse', () => {
			const legacy = { collapseHandler: () => {}, draw: () => {}, lastLineData: { map: { rows: ['x'] } } };
			const radial = { drawConnection: () => {}, draw: () => {}, collapse: () => {} };
			const fakeChain = {
				renderer: radial,
				useRenderer: function(name) { this.renderer = name == 'orgChart' ? legacy : radial; },
				updateCollapsed: function(c) { this.collapsed = c; }
			};
			const maps = [];
			withStub('placeOnOrgChart', m => maps.push(m), () => {
				sizeTags.installRenderers(fakeChain);
				sizeTags.installRenderers(fakeChain);	// idempotent
				assert.ok(radial.sizeTagsHooked);
				fakeChain.updateCollapsed([1]);	// canvas renderers redraw themselves on collapse
				assert.equal(maps.length, 0);
				fakeChain.useRenderer('orgChart');
				assert.ok(legacy.sizeTagsHooked);
				fakeChain.updateCollapsed([2]);
				assert.deepEqual(fakeChain.collapsed, [2]);
				assert.deepEqual(maps, [legacy.lastLineData.map]);
				legacy.drawing = true;	// collapses re-applied during a draw are covered by the draw hook
				fakeChain.updateCollapsed([3]);
				assert.equal(maps.length, 1);
			});
		});
	});

	describe('enabled', () => {
		it('on without options', () => { assert.equal(sizeTags.enabled(undefined), true); assert.equal(sizeTags.enabled(null), true); });
		it('on when options have no sizeTags key', () => assert.equal(sizeTags.enabled({ chain: {} }), true));
		it('on when sizeTags has no enabled property', () => assert.equal(sizeTags.enabled({ sizeTags: {} }), true));
		it('on when enabled is true', () => assert.equal(sizeTags.enabled({ sizeTags: { enabled: true } }), true));
		it('off when enabled is false', () => assert.equal(sizeTags.enabled({ sizeTags: { enabled: false } }), false));
	});

	describe('install', () => {
		it('leaves the result untouched when size tags are off', () => {
			const node = { v: 2, f: "<h4 class='nodeType'>H296</h4>", systemID: J135100 };
			const result = { map: { rows: [
				{ c: [{ v: 1, f: 'root', systemID: J152820 }, { v: null }] },
				{ c: [node, { v: 1 }], pathHome: [{ systemID: J135100, type: 'H296' }] }
			] }, lines: [[2, 1, [], undefined]] };
			const fakeChain = { nodes: () => JSON.parse(JSON.stringify(result)) };
			sizeTags.install(fakeChain);
			global.options = { sizeTags: { enabled: false } };
			try {
				assert.equal(fakeChain.nodes().map.rows[1].c[0].sizeTag, undefined);
				global.options.sizeTags.enabled = true;
				assert.equal(fakeChain.nodes().map.rows[1].c[0].sizeTag.size, 'XL');
			} finally { delete global.options; }
		});

		it('wraps and composes with an existing chain.nodes', () => {
			const fakeChain = { nodes: function(m) { return { map: { rows: [] }, lines: [], marker: m, self: this }; } };
			sizeTags.install(fakeChain);
			sizeTags.install(fakeChain);	// idempotent
			const r = fakeChain.nodes('x');
			assert.equal(r.marker, 'x');
			assert.equal(r.self, fakeChain);
			assert.ok(fakeChain.nodes.sizeTagsWrapped);
		});
	});
});
