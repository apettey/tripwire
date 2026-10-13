const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/home-region');

describe('Home region mark', () => {
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
		});
		it('is off only when explicitly false', () => assert.equal(homeRegion.enabled({ homeRegion: { enabled: false } }), false));
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

	describe('sameRegion', () => {
		const R = 11000009;
		it('same region, not home', () => {
			assert.ok(homeRegion.sameRegion(SAME_A, HOME, R, appData.systems));
			assert.ok(homeRegion.sameRegion(String(SAME_B), HOME, R, appData.systems));
		});
		it('home itself, other regions, unknown and placeholder systems are not', () => {
			assert.ok(!homeRegion.sameRegion(HOME, HOME, R, appData.systems));
			assert.ok(!homeRegion.sameRegion(String(HOME), HOME, R, appData.systems));
			assert.ok(!homeRegion.sameRegion(OTHER, HOME, R, appData.systems));
			assert.ok(!homeRegion.sameRegion(JITA, HOME, R, appData.systems));
			assert.ok(!homeRegion.sameRegion('2|1234', HOME, R, appData.systems));
			assert.ok(!homeRegion.sameRegion(3, HOME, R, appData.systems));
			assert.ok(!homeRegion.sameRegion(undefined, HOME, R, appData.systems));
			assert.ok(!homeRegion.sameRegion(SAME_A, HOME, null, appData.systems));
		});
	});

	describe('markerHtml / insertMarker', () => {
		const node = name => "<div id='node5' data-nodeid='31000880' class='node '><div class='nodeIcons'></div>" +
			"<h4 class='nodeClass'><span class='wh'>C3</span></h4><h4 class='nodeSystem'>" + name + "</h4>" +
			"<h4 class='nodeType'>U210</h4><div class='statics'></div></div>";
		it('tooltip and screen reader text name the region', () => {
			const m = homeRegion.markerHtml('C-R00009');
			assert.ok(m.indexOf("<span class='home-region-mark' title='Same region as home (C-R00009)'>") === 0, m);
			assert.ok(m.indexOf("<span class='home-region-sr'>, same region as home (C-R00009)</span>") >= 0, m);
			assert.ok(m.indexOf("aria-hidden='true'") >= 0, m);
		});
		it('without a region name', () => assert.ok(homeRegion.markerHtml('').indexOf("title='Same region as home'") >= 0));
		it('escapes the region name', () => {
			const m = homeRegion.markerHtml("<b>'x'");
			assert.ok(m.indexOf("title='Same region as home (&lt;b&gt;&#39;x&#39;)'") >= 0, m);
			assert.ok(m.indexOf('<b>') < 0, m);
		});
		it('goes at the end of the name line, after the link', () => {
			const html = homeRegion.insertMarker(node("<a href='.?system=J160650'>ABC</a>"), '<i>M</i>');
			assert.equal(html, node("<a href='.?system=J160650'>ABC</a><i>M</i>"));
		});
		it('is added once', () => {
			const m = homeRegion.markerHtml('C-R00009');
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
		const marked = r => r.map.rows.filter(x => typeof x.c[0].f === 'string' && x.c[0].f.indexOf('home-region-mark') >= 0).map(x => x.c[0].v);

		it('marks only same-region nodes, not home, other regions, unknown systems or destinations', () => {
			const r = homeRegion.decorate(build(), HOME, appData.systems, appData.regions);
			assert.deepEqual(marked(r), [2, 4]);
			assert.ok(r.map.rows[1].c[0].f.indexOf("title='Same region as home (C-R00009)'") >= 0);
		});
		it('nothing without a wormhole home', () => {
			assert.deepEqual(marked(homeRegion.decorate(build(), null, appData.systems, appData.regions)), []);
			assert.deepEqual(marked(homeRegion.decorate(build(), JITA, appData.systems, appData.regions)), []);
			assert.deepEqual(marked(homeRegion.decorate(build(), 999, appData.systems, appData.regions)), []);
		});
		it('home in the other region marks nothing here', () => assert.deepEqual(marked(homeRegion.decorate(build(), OTHER, appData.systems, appData.regions)), []));
		it('works without region names', () => {
			const r = homeRegion.decorate(build(), HOME, appData.systems, undefined);
			assert.deepEqual(marked(r), [2, 4]);
			assert.ok(r.map.rows[1].c[0].f.indexOf("title='Same region as home'") >= 0);
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
		it('wraps chain.nodes once and follows the setting and the active tab', () => {
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
			const has = r => r.map.rows[1].c[0].f.indexOf('home-region-mark') >= 0;

			global.options = { chain: { tabs: [{ systemID: String(HOME) }, { systemID: 0 }], active: 0 } };
			assert.ok(has(fake.nodes()));
			assert.ok(fake.nodes().map.rows[0].c[0].f.indexOf('home-region-mark') < 0);
			global.options.chain.active = 1;
			assert.ok(!has(fake.nodes()));
			global.options.chain.active = 0;
			global.options.homeRegion = { enabled: false };
			assert.ok(!has(fake.nodes()));
		});
	});
});
