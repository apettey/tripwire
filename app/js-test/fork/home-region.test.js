const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/home-region');

describe('Home region tag', () => {
	const HOME = 31000881;		// J114342, C3, C-R00009 (11000009)
	const SAME_A = 31000880;	// J160650, C-R00009
	const SAME_B = 31000882;	// J152031, C-R00009
	const OTHER = 31000936;		// J165302, C-R00010
	const JITA = 30000142;		// high-sec, The Forge
	const opts = (tabs, active) => ({ chain: { tabs: tabs, active: active } });

	it('uses real static data for the fixtures', () => {
		assert.equal(appData.systems[HOME].regionID, 11000009);
		assert.equal(appData.systems[SAME_A].regionID, 11000009);
		assert.equal(appData.systems[SAME_B].regionID, 11000009);
		assert.notEqual(appData.systems[OTHER].regionID, 11000009);
	});

	describe('enabled', () => {
		it('is on without options or key', () => {
			assert.equal(homeRegion.enabled(undefined), true);
			assert.equal(homeRegion.enabled({}), true);
			assert.equal(homeRegion.enabled({ homeRegion: {} }), true);
			assert.equal(homeRegion.enabled({ homeRegion: { color: 'blue' } }), true);
		});
		it('is off only when explicitly false', () => assert.equal(homeRegion.enabled({ homeRegion: { enabled: false } }), false));
	});

	describe('color', () => {
		it('defaults to teal', () => {
			assert.equal(homeRegion.color(undefined), 'teal');
			assert.equal(homeRegion.color({ homeRegion: { enabled: true } }), 'teal');
		});
		it('accepts palette keys only', () => {
			homeRegion.PALETTE.forEach(p => assert.equal(homeRegion.color({ homeRegion: { color: p[0] } }), p[0]));
			['red', "teal' onmouseover='x", '', 'TEAL', null, 3, { a: 1 }, '__proto__', 'constructor', 'toString'].forEach(v =>
				assert.equal(homeRegion.color({ homeRegion: { color: v } }), 'teal', String(v)));
		});
		it('palette has about six colours with plain keys', () => {
			assert.ok(homeRegion.PALETTE.length >= 5 && homeRegion.PALETTE.length <= 8);
			homeRegion.PALETTE.forEach(p => assert.ok(/^[a-z]+$/.test(p[0]), p[0]));
			assert.ok(homeRegion.isColor(homeRegion.DEFAULT_COLOR));
		});
	});

	describe('homeSystemID', () => {
		it('reads the active tab (string or number)', () => {
			assert.equal(homeRegion.homeSystemID(opts([{ systemID: '31000881' }], 0)), HOME);
			assert.equal(homeRegion.homeSystemID(opts([{ systemID: 1 }, { systemID: HOME }], 1)), HOME);
		});
		it('no single home: no active tab, all-systems tab, several systems, missing tab', () => {
			assert.equal(homeRegion.homeSystemID(opts([{ systemID: HOME }], null)), null);
			assert.equal(homeRegion.homeSystemID(opts([{ systemID: HOME }], undefined)), null);
			assert.equal(homeRegion.homeSystemID(opts([{ systemID: 0 }], 0)), null);
			assert.equal(homeRegion.homeSystemID(opts([{ systemID: '0' }], 0)), null);
			assert.equal(homeRegion.homeSystemID(opts([{ systemID: '31000881,31000880' }], 0)), null);
			assert.equal(homeRegion.homeSystemID(opts([{ systemID: HOME }], 3)), null);
			assert.equal(homeRegion.homeSystemID(opts([{}], 0)), null);
			assert.equal(homeRegion.homeSystemID(opts(undefined, 0)), null);
			assert.equal(homeRegion.homeSystemID({}), null);
			assert.equal(homeRegion.homeSystemID(undefined), null);
		});
	});

	describe('isWormhole / homeRegionID', () => {
		it('J-space has a class, k-space and Pochven do not', () => {
			assert.ok(homeRegion.isWormhole(appData.systems[HOME]));
			assert.ok(!homeRegion.isWormhole(appData.systems[JITA]));
			assert.ok(!homeRegion.isWormhole({ regionID: 10000070, factionID: 500026 }));
			assert.ok(!homeRegion.isWormhole(undefined));
			assert.ok(homeRegion.isWormhole({ class: [3] }));
			assert.ok(!homeRegion.isWormhole({ class: [] }));
		});
		it('home region only for a wormhole home', () => {
			assert.equal(homeRegion.homeRegionID(HOME, appData.systems), 11000009);
			assert.equal(homeRegion.homeRegionID(JITA, appData.systems), null);
			assert.equal(homeRegion.homeRegionID(123, appData.systems), null);
			assert.equal(homeRegion.homeRegionID(null, appData.systems), null);
			assert.equal(homeRegion.homeRegionID(5, { 5: { class: 3 } }), null);	// no region
		});
	});

	describe('inRegion', () => {
		const R = 11000009;
		it('home and same-region systems are in', () => {
			assert.ok(homeRegion.inRegion(HOME, R, appData.systems));
			assert.ok(homeRegion.inRegion(SAME_A, R, appData.systems));
			assert.ok(homeRegion.inRegion(String(SAME_B), R, appData.systems));
		});
		it('other regions, unknown and placeholder systems are not', () => {
			assert.ok(!homeRegion.inRegion(OTHER, R, appData.systems));
			assert.ok(!homeRegion.inRegion(JITA, R, appData.systems));
			assert.ok(!homeRegion.inRegion('2|1234', R, appData.systems));
			assert.ok(!homeRegion.inRegion(3, R, appData.systems));
			assert.ok(!homeRegion.inRegion(undefined, R, appData.systems));
			assert.ok(!homeRegion.inRegion(SAME_A, null, appData.systems));
		});
	});

	describe('regionCode', () => {
		it('from the name', () => {
			assert.equal(homeRegion.regionCode('C-R00009', 11000009), 'R09');
			assert.equal(homeRegion.regionCode('A-R00001', 11000001), 'R01');
			assert.equal(homeRegion.regionCode('G-R00031', 11000031), 'R31');
			assert.equal(homeRegion.regionCode('E-R00024'), 'R24');
		});
		it('every J-space region gets R01..R33', () => {
			const ids = Object.keys(appData.regions).filter(id => id >= 11000001 && id <= 11000033);
			assert.ok(ids.length >= 30, ids.length);
			ids.forEach(id => {
				assert.equal(homeRegion.regionCode(appData.regions[id].name, id), 'R' + String(id - 11000000).padStart(2, '0'), appData.regions[id].name);
			});
		});
		it('falls back to the region id, then R?', () => {
			assert.equal(homeRegion.regionCode('', 11000009), 'R09');
			assert.equal(homeRegion.regionCode('Odd name', 11000012), 'R12');
			assert.equal(homeRegion.regionCode(undefined, 10000002), 'R?');
			assert.equal(homeRegion.regionCode(undefined, undefined), 'R?');
		});
	});

	describe('tooltip', () => {
		it('home and member wording, with the count', () => {
			assert.equal(homeRegion.tooltip('C-R00009', 'R09', true, 3), "C-R00009 · home's region · 3 systems on the chain");
			assert.equal(homeRegion.tooltip('C-R00009', 'R09', false, 3), 'C-R00009 · same region as home · 3 systems on the chain');
		});
		it('no count for a group of one, code when the name is missing', () => {
			assert.equal(homeRegion.tooltip('C-R00009', 'R09', true, 1), "C-R00009 · home's region");
			assert.equal(homeRegion.tooltip('', 'R09', false, 2), 'R09 · same region as home · 2 systems on the chain');
		});
	});

	describe('markerHtml / insertMarker', () => {
		const node = name => "<div id='node5' data-nodeid='31000880' class='node '><div class='nodeIcons'></div>" +
			"<h4 class='nodeClass'><span class='wh'>C3</span></h4><h4 class='nodeSystem'>" + name + "</h4>" +
			"<h4 class='nodeType'>U210</h4><div class='statics'></div></div>";
		it('tag with code, colour class, tooltip and screen reader text', () => {
			const m = homeRegion.markerHtml('R09', 'C-R00009 · same region as home', 'blue', false);
			assert.equal(m, "<span class='home-region-mark home-region-c-blue' data-tooltip='C-R00009 · same region as home'>R09" +
				"<span class='home-region-sr'>, C-R00009 · same region as home</span></span>");
		});
		it('home tag has its own class', () => assert.ok(homeRegion.markerHtml('R09', 't', 'teal', true).indexOf("<span class='home-region-mark home-region-c-teal home-region-home'") === 0));
		it('never puts an unknown colour into the markup', () => {
			const m = homeRegion.markerHtml('R09', 't', "x' onmouseover='alert(1)", false);
			assert.ok(m.indexOf("<span class='home-region-mark home-region-c-teal'") === 0, m);
			assert.ok(m.indexOf('onmouseover') < 0, m);
		});
		it('escapes the tooltip twice (jBox shows it as HTML) and the text once', () => {
			const m = homeRegion.markerHtml("<b>", "<i>'x'", 'teal', false);
			assert.ok(m.indexOf("data-tooltip='&amp;lt;i&amp;gt;&amp;#39;x&amp;#39;'") >= 0, m);
			assert.ok(m.indexOf("'>&lt;b&gt;<span class='home-region-sr'>, &lt;i&gt;&#39;x&#39;</span>") >= 0, m);
		});
		it('goes at the end of the name line, after the link', () => {
			const html = homeRegion.insertMarker(node("<a href='.?system=J160650'>ABC</a>"), '<i>M</i>');
			assert.equal(html, node("<a href='.?system=J160650'>ABC</a><i>M</i>"));
		});
		it('is added once', () => {
			const m = homeRegion.markerHtml('R09', 't', 'teal', false);
			const once = homeRegion.insertMarker(node('ABC'), m);
			assert.equal(homeRegion.insertMarker(once, m), once);
		});
		it('leaves markup without a name line alone', () => {
			assert.equal(homeRegion.insertMarker('<div>x</div>', '<i>M</i>'), null);
			assert.equal(homeRegion.insertMarker(undefined, '<i>M</i>'), null);
			assert.equal(homeRegion.insertMarker(node('ABC'), ''), null);
		});
	});

	describe('decorate', () => {
		const nodeHtml = id => "<div data-nodeid='" + id + "' class='node '><h4 class='nodeSystem'>" + id + "</h4><h4 class='nodeType'>X</h4></div>";
		const row = (v, parent, systemID, extra) => Object.assign({ c: [{ v: v, systemID: systemID, f: nodeHtml(systemID) }, { v: parent }] }, extra || {});
		const build = () => ({ map: { rows: [
			row(1, null, HOME),
			row(2, 1, SAME_A),
			row(3, 1, OTHER),
			row(4, 2, SAME_B),
			row(5, 2, JITA),
			row(6, 2, '2|1234'),
			row(7, 4, HOME),	// loop back to home
			row('dest-1', 4, SAME_A, { destination: true }),
			{ c: [{ v: 9, systemID: SAME_A }, { v: 1 }] }	// no markup
		] } });
		const tagged = r => r.map.rows.filter(x => typeof x.c[0].f === 'string' && x.c[0].f.indexOf('home-region-mark') >= 0).map(x => x.c[0].v);
		const f = (r, v) => r.map.rows.filter(x => x.c[0].v === v)[0].c[0].f;

		it('tags home and same-region nodes, not other regions, unknown systems or destinations', () => {
			const r = homeRegion.decorate(build(), HOME, appData.systems, appData.regions, 'amber');
			assert.deepEqual(tagged(r), [1, 2, 4, 7]);
			assert.ok(f(r, 1).indexOf("home-region-c-amber home-region-home' data-tooltip='C-R00009 · home&amp;#39;s region · 3 systems on the chain'>R09") >= 0, f(r, 1));
			assert.ok(f(r, 2).indexOf("home-region-c-amber' data-tooltip='C-R00009 · same region as home · 3 systems on the chain'>R09") >= 0, f(r, 2));
			assert.ok(f(r, 7).indexOf('home-region-home') >= 0);
		});
		it('home alone: tag without a count', () => {
			const r = homeRegion.decorate({ map: { rows: [row(1, null, HOME), row(3, 1, OTHER)] } }, HOME, appData.systems, appData.regions, 'teal');
			assert.deepEqual(tagged(r), [1]);
			assert.ok(f(r, 1).indexOf("data-tooltip='C-R00009 · home&amp;#39;s region'") >= 0, f(r, 1));
		});
		it('nothing without a wormhole home', () => {
			assert.deepEqual(tagged(homeRegion.decorate(build(), null, appData.systems, appData.regions)), []);
			assert.deepEqual(tagged(homeRegion.decorate(build(), JITA, appData.systems, appData.regions)), []);
			assert.deepEqual(tagged(homeRegion.decorate(build(), 999, appData.systems, appData.regions)), []);
		});
		it('home in the other region tags its own group', () => assert.deepEqual(tagged(homeRegion.decorate(build(), OTHER, appData.systems, appData.regions)), [3]));
		it('works without region names (code from the id), bad colour falls back', () => {
			const r = homeRegion.decorate(build(), HOME, appData.systems, undefined, 'nope');
			assert.deepEqual(tagged(r), [1, 2, 4, 7]);
			assert.ok(f(r, 2).indexOf("home-region-c-teal' data-tooltip='R09 · same region as home") >= 0, f(r, 2));
		});
		it('tolerates odd results', () => {
			assert.equal(homeRegion.decorate(undefined, HOME, appData.systems, appData.regions), undefined);
			assert.deepEqual(homeRegion.decorate({}, HOME, appData.systems, appData.regions), {});
			const r = { map: { rows: [null, {}, { c: [] }] } };
			assert.equal(homeRegion.decorate(r, HOME, appData.systems, appData.regions), r);
		});
	});

	describe('install', () => {
		let saved;
		beforeEach(() => { saved = Object.getOwnPropertyDescriptor(global, 'options'); });
		afterEach(() => { if (saved) { Object.defineProperty(global, 'options', saved); } else { delete global.options; } });
		it('wraps chain.nodes once and follows the setting, the colour and the active tab', () => {
			const rows = () => ({ map: { rows: [
				{ c: [{ v: 1, systemID: HOME, f: "<div><h4 class='nodeSystem'>a</h4></div>" }, { v: null }] },
				{ c: [{ v: 2, systemID: SAME_A, f: "<div><h4 class='nodeSystem'>b</h4></div>" }, { v: 1 }] }
			] } });
			const fake = { nodes: function() { return rows(); } };
			fake.nodes.extra = 1;
			homeRegion.install(fake);
			const wrapped = fake.nodes;
			homeRegion.install(fake);
			assert.equal(fake.nodes, wrapped);
			assert.equal(fake.nodes.extra, 1);
			const has = (r, i) => r.map.rows[i].c[0].f.indexOf('home-region-mark') >= 0;

			global.options = { chain: { tabs: [{ systemID: String(HOME) }, { systemID: 0 }], active: 0 } };
			assert.ok(has(fake.nodes(), 0) && has(fake.nodes(), 1));
			assert.ok(fake.nodes().map.rows[1].c[0].f.indexOf('home-region-c-teal') >= 0);
			global.options.homeRegion = { color: 'pink' };
			assert.ok(fake.nodes().map.rows[1].c[0].f.indexOf('home-region-c-pink') >= 0);
			global.options.chain.active = 1;
			assert.ok(!has(fake.nodes(), 1));
			global.options.chain.active = 0;
			global.options.homeRegion = { enabled: false, color: 'pink' };
			assert.ok(!has(fake.nodes(), 0) && !has(fake.nodes(), 1));
		});
	});
});
