const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/tripwire/genericSystemTypes');
include('app/js/systemAnalysis');
include('app/js/fork/highsec-region');

describe('High-sec region label', () => {
	const JITA = 30000142;	// 0.95, The Forge
	const TUOMUTA = 30003064;	// 0.4537 (rounds to 0.5), The Bleak Lands
	const ONSOOH = 30000013;	// 0.4428 (rounds to 0.4), Low-Sec
	const J114342 = 31000881;	// C3
	const analyse = id => appData.systems[id] ? systemAnalysis.analyse(id) : undefined;

	describe('enabled', () => {
		it('is on without options or key', () => {
			assert.equal(highsecRegion.enabled(undefined), true);
			assert.equal(highsecRegion.enabled({}), true);
			assert.equal(highsecRegion.enabled({ highsecRegion: {} }), true);
		});
		it('is off only when explicitly false', () => assert.equal(highsecRegion.enabled({ highsecRegion: { enabled: false } }), false));
	});

	describe('isHighSec', () => {
		it('Jita and 0.45 systems are high-sec', () => {
			assert.ok(highsecRegion.isHighSec(analyse(JITA)));
			assert.ok(highsecRegion.isHighSec(analyse(TUOMUTA)));
			assert.ok(highsecRegion.isHighSec(appData.systems[TUOMUTA]));
		});
		it('0.44 is low-sec', () => assert.ok(!highsecRegion.isHighSec(analyse(ONSOOH))));
		it('wormholes, null-sec and Pochven are not', () => {
			assert.ok(!highsecRegion.isHighSec(analyse(J114342)));
			assert.ok(!highsecRegion.isHighSec({ security: -0.5, regionID: 1 }));
			assert.ok(!highsecRegion.isHighSec({ security: 0.9, factionID: 500026, regionID: 1 }));
			assert.ok(!highsecRegion.isHighSec({ security: 0.9, class: [3] }));
		});
		it('missing data is not', () => {
			assert.ok(!highsecRegion.isHighSec(undefined));
			assert.ok(!highsecRegion.isHighSec({ regionID: 1 }));
		});
		it('matches systemAnalysis "HS" for every k-space system', () => {
			Object.keys(appData.systems).forEach(id => {
				const s = systemAnalysis.analyse(id);
				assert.equal(highsecRegion.isHighSec(s), s.systemTypeName == 'HS', s.name);
			});
		});
	});

	describe('labelFor', () => {
		it('high-sec gives the region', () => {
			assert.equal(highsecRegion.labelFor(analyse(JITA), appData.regions), 'The Forge');
			assert.equal(highsecRegion.labelFor(analyse(TUOMUTA), appData.regions), 'The Bleak Lands');
		});
		it('others give null', () => {
			assert.equal(highsecRegion.labelFor(analyse(ONSOOH), appData.regions), null);
			assert.equal(highsecRegion.labelFor(analyse(J114342), appData.regions), null);
			assert.equal(highsecRegion.labelFor(undefined, appData.regions), null);
		});
		it('unknown region gives null', () => assert.equal(highsecRegion.labelFor({ security: 0.9, regionID: 1 }, appData.regions), null));
	});

	describe('typeText', () => {
		const child = { type: 'D845', name: 'AABA' };
		it('default shows the type', () => assert.deepEqual(highsecRegion.typeText(child, { sigNameLocation: 'name', 'node-reference': 'type' }), { prefix: '', type: 'D845' }));
		it('ref_prefix shows name - type', () => assert.deepEqual(highsecRegion.typeText(child, { sigNameLocation: 'ref_prefix' }), { prefix: 'AABA - ', type: 'D845' }));
		it('ref shows only the name: nothing to replace', () => assert.equal(highsecRegion.typeText(child, { sigNameLocation: 'ref' }), null));
		it('ref without a name falls back to the type', () => assert.deepEqual(highsecRegion.typeText({ type: 'B274' }, { sigNameLocation: 'ref' }), { prefix: '', type: 'B274' }));
		it('signature IDs: nothing to replace', () => assert.equal(highsecRegion.typeText(child, { 'node-reference': 'id' }), null));
		it('gate routes: nothing to replace', () => assert.equal(highsecRegion.typeText({ path: [1, 2] }, {}), null));
		it('unknown type is (?)', () => assert.deepEqual(highsecRegion.typeText({}, {}), { prefix: '', type: '(?)' }));
	});

	describe('rewriteHtml', () => {
		const node = inner => "<div class='node'><h4 class='nodeClass'>x</h4><h4 class='nodeType'>" + inner + "</h4><div class='statics'></div></div>";
		const link = "<a href='#' onclick='sigDialog.openSignatureDialog({data: { signature: 7, mode: \"update\" }}); return false;'>";
		it('replaces the type inside the signature link', () => {
			const html = highsecRegion.rewriteHtml(node(link + 'D845</a>'), { prefix: '', type: 'D845' }, 'The Forge');
			assert.equal(html, node(link + "<span class='highsec-region-line' title='The Forge (high-sec region) - hole type D845'><span class='highsec-region'>The Forge</span></span>" +
				"<span class='highsec-region-reserve' aria-hidden='true'>D845</span></a>"));
		});
		it('keeps the name prefix', () => {
			const html = highsecRegion.rewriteHtml(node(link + 'AABA - D845</a>'), { prefix: 'AABA - ', type: 'D845' }, 'The Bleak Lands');
			assert.ok(html.indexOf(link + "<span class='highsec-region-line' title='The Bleak Lands (high-sec region) - hole type D845'>AABA - <span class='highsec-region'>The Bleak Lands</span></span>") >= 0, html);
			assert.ok(html.indexOf("<span class='highsec-region-reserve' aria-hidden='true'>AABA - D845</span></a></h4>") >= 0, html);
		});
		it('works without a link', () => assert.ok(highsecRegion.rewriteHtml(node('D845'), { prefix: '', type: 'D845' }, 'Domain').indexOf("<h4 class='nodeType'><span class='highsec-region-line'") >= 0));
		it('unknown type says so in the tooltip', () => assert.ok(highsecRegion.rewriteHtml(node('(?)'), { prefix: '', type: '(?)' }, 'Domain').indexOf('hole type unknown') >= 0));
		it('escapes names', () => {
			const html = highsecRegion.rewriteHtml(node('&lt;b&gt; - D845'), { prefix: '<b> - ', type: 'D845' }, "A'B<");
			assert.ok(html.indexOf("title='A&#39;B&lt; (high-sec region) - hole type D845'>&lt;b&gt; - <span class='highsec-region'>A&#39;B&lt;</span>") >= 0, html);
			assert.ok(html.indexOf("aria-hidden='true'>&lt;b&gt; - D845</span>") >= 0, html);
		});
		it('leaves markup it does not recognise alone', () => {
			assert.equal(highsecRegion.rewriteHtml(node(link + 'K162</a>'), { prefix: '', type: 'D845' }, 'Domain'), null);
			assert.equal(highsecRegion.rewriteHtml("<div>no type line</div>", { prefix: '', type: 'D845' }, 'Domain'), null);
			assert.equal(highsecRegion.rewriteHtml(node('D845'), { prefix: '', type: 'D845' }, null), null);
		});
	});

	describe('decorate', () => {
		const nodeHtml = text => "<div class='node'><h4 class='nodeType'>" + text + "</h4></div>";
		const row = (id, parent, systemID, child, text) => ({ c: [{ v: id, systemID: systemID, f: nodeHtml(text) }, { v: parent }], pathHome: child ? [{ systemID: 1 }, child] : undefined });
		const build = () => ({ map: { rows: [
			{ c: [{ v: 1, systemID: J114342, f: nodeHtml('&nbsp;') }, { v: null }] },
			row(2, 1, TUOMUTA, { systemID: TUOMUTA, type: 'D845', name: 'AABA' }, 'AABA - D845'),
			row(3, 1, JITA, { systemID: JITA, type: 'K162', name: 'AABB' }, 'AABB - K162'),
			row(4, 1, ONSOOH, { systemID: ONSOOH, type: 'U210', name: 'AABC' }, 'AABC - U210'),
			row(5, 1, '2|1234', { systemID: '2|1234', type: 'D845', name: 'AABD' }, 'AABD - D845'),
			row(6, 1, 31001880, { systemID: 31001880, type: 'H296', name: 'AABE' }, 'AABE - H296'),
			row(7, 1, JITA, { systemID: JITA, path: [1, 2] }, 'route')
		] } });
		const html = r => r.map.rows.map(x => x.c[0].f);

		it('labels high-sec holes only', () => {
			const result = highsecRegion.decorate(build(), highsecRegion.systemFor, appData.regions, { sigNameLocation: 'ref_prefix' });
			const out = html(result);
			assert.ok(out[1].indexOf("title='The Bleak Lands (high-sec region) - hole type D845'>AABA - <span class='highsec-region'>The Bleak Lands</span>") >= 0, out[1]);
			assert.ok(out[2].indexOf('>The Forge</span>') >= 0 && out[2].indexOf('hole type K162') >= 0, out[2]);
			const before = html(build());
			[0, 3, 4, 5, 6].forEach(i => assert.equal(out[i], before[i], 'row ' + i));
		});
		it('nothing to replace when only the name is shown', () => {
			const result = highsecRegion.decorate(build(), highsecRegion.systemFor, appData.regions, { sigNameLocation: 'ref' });
			assert.deepEqual(html(result), html(build()));
		});
		it('tolerates odd input', () => {
			assert.equal(highsecRegion.decorate(null), null);
			assert.deepEqual(highsecRegion.decorate({ map: {} }), { map: {} });
		});
	});

	describe('install', () => {
		it('wraps chain.nodes once, honours the setting and keeps other wrappers\' flags', () => {
			const fake = { nodes: function() { return { map: { rows: [
				{ c: [{ v: 1, systemID: J114342, f: '' }, { v: null }] },
				{ c: [{ v: 2, systemID: JITA, f: "<h4 class='nodeType'>D845</h4>" }, { v: 1 }], pathHome: [{ systemID: JITA, type: 'D845' }] }
			] } }; } };
			fake.nodes.otherWrapped = true;
			global.options = { chain: { sigNameLocation: 'name', 'node-reference': 'type' } };
			try {
				highsecRegion.install(fake);
				const wrapped = fake.nodes;
				highsecRegion.install(fake);
				assert.equal(fake.nodes, wrapped);
				assert.ok(fake.nodes.otherWrapped);
				assert.ok(fake.nodes().map.rows[1].c[0].f.indexOf('>The Forge</span>') >= 0);
				global.options.highsecRegion = { enabled: false };
				assert.equal(fake.nodes().map.rows[1].c[0].f, "<h4 class='nodeType'>D845</h4>");
			} finally { delete global.options; }
		});
	});
});
