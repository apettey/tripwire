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
		const html = i => result.map.rows[i].c[0].f;

		it('does not tag the root', () => assert.ok(html(0).indexOf('size-tag') < 0));
		it('tags a known hole after the type text', () => assert.ok(html(1).indexOf("H296</a><span class=\"size-tag size-xl\"") > 0));
		it('tags an unknown K162 as likely', () => assert.ok(html(2).indexOf('>XL?</span></h4>') > 0));
		it('uses the wormhole type for the K162 side', () => assert.ok(html(3).indexOf('>VL</span></h4>') > 0));
		it('skips destination nodes', () => assert.ok(html(4).indexOf('size-tag') < 0));
		it('skips calculated route nodes', () => assert.ok(html(5).indexOf('size-tag') < 0));
		it('decorating twice does not add a second tag', () => {
			sizeTags.decorate(result, id => types[id]);
			assert.equal(html(1).split('size-tag').length, 2);
		});
	});

	describe('install', () => {
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
