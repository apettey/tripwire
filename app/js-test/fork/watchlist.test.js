const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/watchlist');

const wl = watchlist;
const sid = name => Number(Object.keys(appData.systems).find(k => appData.systems[k].name === name));
const HOME = sid('J115405');		// C5, static H296
const WR_C5 = sid('J122515');		// C5 Wolf-Rayet, static H296
const C2 = sid('J150627');			// C2, statics E545 (null) + N062 (C5)
const PULSAR_C3 = sid('J133207');	// C3 Pulsar, static D845 (high-sec)
const AMAMAKE = sid('Amamake');		// low-sec, Heimatar
const JITA = sid('Jita'), PERIMETER = sid('Perimeter');
const THERA = sid('Thera'), SENTINEL = sid('Sentinel MZ'), C13 = sid('J000102');
const POCHVEN = Number(Object.keys(appData.systems).find(k => appData.systems[k].factionID == 500026));

// Rows and lines shaped like chain.nodes() output: node v, its system, the parent node, the step's type
function root(v, systemID) { return { c: [{ v: v, systemID: systemID, f: "<div id='node" + v + "' data-nodeid='" + systemID + "' class='node top-level'><div class='nodeIcons'></div></div>" }, { v: null }] }; }
function child(v, parent, systemID, type, depth) {
	const pathHome = [];
	for (let i = 1; i < (depth || 1); i++) { pathHome.push({ systemID: 0 }); }
	pathHome.push({ systemID: systemID, type: type || 'K162' });
	return { c: [{ v: v, systemID: systemID, f: "<div id='node" + v + "' data-nodeid='" + systemID + "' class='node '><div class='nodeIcons'></div></div>" }, { v: parent }], pathHome: pathHome };
}
function line(v, parent, wormholeID) { return [v, parent, [], wormholeID]; }

/** HOME -(H296 #1)-> WR_C5 -(D845 #2)-> PULSAR_C3 ; HOME -(N062 #3)-> C2 ; HOME -(???? #4)-> AMAMAKE */
function sampleChain() {
	return {
		map: { rows: [
			root(1, HOME),
			child(2, 1, WR_C5, 'H296', 1),
			child(3, 1, C2, 'K162', 1),
			child(4, 1, AMAMAKE, '????', 1),
			child(5, 2, PULSAR_C3, 'K162', 2)
		] },
		lines: [line(2, 1, 1), line(3, 1, 3), line(4, 1, 4), line(5, 2, 2)]
	};
}
const types = { 1: 'H296', 2: 'D845', 3: 'N062', 4: '????' };
const sizes = { 1: 'XL', 2: 'L', 3: 'L', 4: null };
function model(result, tracked) {
	const r = result || sampleChain();
	const byChild = {};
	r.lines.forEach(l => { byChild[l[0]] = l[3]; });
	return wl.chainModel(r, {
		typeFor: id => types[id],
		sizeFor: row => sizes[byChild[row.c[0].v]],
		trackedSystemID: tracked
	});
}
const filter = (id, conditions, extra) => Object.assign({ id: id, name: 'Filter ' + id, enabled: true, conditions: wl.normaliseConditions(conditions) }, extra || {});
const matchedSystems = (filters, m) => wl.match(filters, m || model(), appData).map(x => x.systemID);

describe('Watchlist', () => {
	describe('settings', () => {
		it('Missing key: on, default sound, no filters', () => assert.deepEqual(wl.settings({}),
			{ enabled: true, sound: 'tone-chime', volume: 70, filters: [] }));
		it('No options at all', () => assert.equal(wl.settings(undefined).enabled, true));
		it('enabled(): missing means on, explicit false is off', () => {
			assert.ok(wl.enabled({}));
			assert.ok(wl.enabled({ watchlist: {} }));
			assert.ok(!wl.enabled({ watchlist: { enabled: false } }));
		});
		it('Unknown sound falls back, volume clamped', () => {
			const s = wl.settings({ watchlist: { sound: 'javascript:alert(1)', volume: 400 } });
			assert.equal(s.sound, 'tone-chime');
			assert.equal(s.volume, 100);
		});
		it('No sound is kept', () => assert.equal(wl.settings({ watchlist: { sound: 'none' } }).sound, 'none'));
		it('Filters normalised; junk, ID-less and duplicate filters dropped', () => {
			const s = wl.settings({ watchlist: { filters: [
				{ id: 'a', name: '  Hunt  ', conditions: { classes: ['C5', 'C99'], bogus: 1, systemID: 'x|3' } },
				{ id: 'a', name: 'duplicate', conditions: { classes: ['C1'] } },
				{ name: 'no id', conditions: { classes: ['C1'] } },
				null, 'text',
				{ id: 'b<script>', enabled: false, conditions: { whType: 'h296', minSize: 'XXL', maxJumpsMe: '3' } }
			] } });
			assert.deepEqual(s.filters, [
				{ id: 'a', name: 'Hunt', enabled: true, conditions: { classes: ['C5'] } },
				{ id: 'bscript', name: 'Unnamed filter', enabled: false, conditions: { whType: 'H296', maxJumpsMe: 3 } }
			]);
		});
	});

	describe('classes', () => {
		it('C1-C6', () => assert.deepEqual(wl.classKeys(appData.systems[HOME]), ['C5']));
		it('C13 is shattered', () => assert.deepEqual(wl.classKeys(appData.systems[C13]), ['C13', 'Shattered']));
		it('Thera', () => assert.deepEqual(wl.classKeys(appData.systems[THERA]), ['Thera']));
		it('Drifter systems are shattered', () => assert.deepEqual(wl.classKeys(appData.systems[SENTINEL]), ['Drifter', 'Shattered']));
		it('Pochven', () => assert.deepEqual(wl.classKeys(appData.systems[POCHVEN]), ['Pochven']));
		it('High-sec, low-sec (as the app shows them)', () => {
			assert.deepEqual(wl.classKeys(appData.systems[JITA]), ['HS']);
			assert.deepEqual(wl.classKeys(appData.systems[AMAMAKE]), ['LS']);
		});
		it('Null-sec', () => assert.deepEqual(wl.classKeys({ security: -0.4, regionID: 10000001 }), ['NS']));
		it('Unknown system: nothing', () => assert.deepEqual(wl.classKeys(undefined), []));
		it('leadsTo texts', () => {
			const ix = wl.index(appData);
			assert.deepEqual(wl.leadsToKeys('Class-5', ix.byName), ['C5']);
			assert.deepEqual(wl.leadsToKeys('High-Sec', ix.byName), ['HS']);
			assert.deepEqual(wl.leadsToKeys('Triglavian', ix.byName), ['Pochven']);
			assert.deepEqual(wl.leadsToKeys('Turnur', ix.byName), ['LS']);
			assert.deepEqual(wl.leadsToKeys('J055520', ix.byName), wl.classKeys(appData.systems[sid('J055520')]));
			assert.deepEqual(wl.leadsToKeys('Nowhere', ix.byName), []);
		});
	});

	describe('chain model', () => {
		const m = model(null, WR_C5);
		const entry = id => m.entries.find(e => e.systemID === id);
		it('One entry per real system, in chain order', () => assert.deepEqual(m.entries.map(e => e.systemID), [HOME, WR_C5, C2, AMAMAKE, PULSAR_C3]));
		it('Connection into a system: real type, K162 never', () => {
			assert.deepEqual(entry(WR_C5).connections, [{ wormholeID: 1, type: 'H296', size: 'XL' }]);
			assert.deepEqual(entry(AMAMAKE).connections, [{ wormholeID: 4, type: null, size: null }]);
			assert.deepEqual(entry(HOME).connections, []);
		});
		it('Jumps from home', () => assert.deepEqual(m.entries.map(e => e.jumpsHome), [0, 1, 1, 1, 2]));
		it('Jumps from the tracked system, both directions', () => assert.deepEqual(m.entries.map(e => e.jumpsMe), [1, 0, 2, 2, 1]));
		it('Not tracked or off the chain: unknown', () => {
			assert.deepEqual(model(null, null).entries.map(e => e.jumpsMe), [null, null, null, null, null]);
			assert.deepEqual(model(null, JITA).entries.map(e => e.jumpsMe), [null, null, null, null, null]);
		});
		it('Skips calculated gate-route nodes, destination nodes and unknown systems', () => {
			const r = sampleChain();
			r.map.rows.push(Object.assign(child(6, 4, JITA, 'K162', 2), { pathHome: [{ systemID: AMAMAKE }, { systemID: JITA, path: [1, 2] }] }));
			r.map.rows.push(Object.assign(child('dest-1', 4, PERIMETER), { destination: true }));
			r.map.rows.push(child(7, 1, '3|1234', 'K162'));
			assert.deepEqual(model(r).entries.map(e => e.systemID), [HOME, WR_C5, C2, AMAMAKE, PULSAR_C3]);
		});
		it('A system on the chain twice (loop): one entry, both nodes and connections', () => {
			const r = sampleChain();
			r.map.rows.push(child(8, 3, WR_C5, 'K162', 2));
			r.lines.push(line(8, 3, 9));
			const e = model(r).entries.find(x => x.systemID === WR_C5);
			assert.deepEqual(e.nodeIDs, [2, 8]);
			assert.equal(e.connections.length, 2);
			assert.equal(e.jumpsHome, 1);
		});
		it('Empty or missing result', () => {
			assert.deepEqual(wl.chainModel(undefined, {}).entries, []);
			assert.deepEqual(wl.chainModel({ map: { rows: [] }, lines: [] }, {}).entries, []);
		});
	});

	describe('matching', () => {
		it('A J-code', () => assert.deepEqual(matchedSystems([filter('a', { systemID: PULSAR_C3 })]), [PULSAR_C3]));
		it('A k-space system by name (through the editor)', () => {
			const f = wl.fromForm({ name: 'Amamake', system: 'amamake' }, appData, [], 1).filter;
			assert.deepEqual(matchedSystems([f]), [AMAMAKE]);
		});
		it('A J-code not on the chain: no match', () => assert.deepEqual(matchedSystems([filter('a', { systemID: sid('J100001') })]), []));
		it('Class', () => assert.deepEqual(matchedSystems([filter('a', { classes: ['C5'] })]), [HOME, WR_C5]));
		it('Any of several classes', () => assert.deepEqual(matchedSystems([filter('a', { classes: ['C2', 'LS'] })]), [C2, AMAMAKE]));
		it('Class and effect together', () => {
			assert.deepEqual(matchedSystems([filter('a', { classes: ['C5'], effects: ['Wolf-Rayet Star'] })]), [WR_C5]);
			assert.deepEqual(matchedSystems([filter('a', { classes: ['C3'], effects: ['Wolf-Rayet Star'] })]), []);
			assert.deepEqual(matchedSystems([filter('a', { effects: ['Pulsar', 'Wolf-Rayet Star'] })]), [WR_C5, PULSAR_C3]);
		});
		it('Region', () => assert.deepEqual(matchedSystems([filter('a', { regionID: appData.systems[AMAMAKE].regionID })]), [AMAMAKE]));
		it('Constellation', () => assert.deepEqual(matchedSystems([filter('a', { constellationID: appData.systems[HOME].constellationID })]),
			[HOME, WR_C5, C2, PULSAR_C3].filter(id => appData.systems[id].constellationID === appData.systems[HOME].constellationID)));
		it('Static leading to a class ("has a C5 static")', () => assert.deepEqual(matchedSystems([filter('a', { staticLeadsTo: 'C5' })]), [HOME, WR_C5, C2]));
		it('Static leading to a class combined with the class', () => assert.deepEqual(matchedSystems([filter('a', { classes: ['C2'], staticLeadsTo: 'C5' })]), [C2]));
		it('Static to high-sec', () => assert.deepEqual(matchedSystems([filter('a', { staticLeadsTo: 'HS' })]), [PULSAR_C3]));
		it('A specific static type', () => assert.deepEqual(matchedSystems([filter('a', { staticType: 'N062' })]), [C2]));
		it('Connection type', () => {
			assert.deepEqual(matchedSystems([filter('a', { whType: 'H296' })]), [WR_C5]);
			assert.deepEqual(matchedSystems([filter('a', { whType: 'N062' })]), [C2]);
			assert.deepEqual(matchedSystems([filter('a', { whType: 'D845' })]), [PULSAR_C3]);
		});
		it('Connection type: an unknown hole never matches', () => assert.deepEqual(matchedSystems([filter('a', { whType: 'K162' })]), []));
		it('Hole type leading to a class', () => assert.deepEqual(matchedSystems([filter('a', { whLeadsTo: 'C5' })]), [WR_C5, C2]));
		it('Connection type and system class together', () => assert.deepEqual(matchedSystems([filter('a', { whType: 'D845', classes: ['C3'] })]), [PULSAR_C3]));
		it('Minimum size', () => {
			assert.deepEqual(matchedSystems([filter('a', { minSize: 'L' })]), [WR_C5, C2, PULSAR_C3]);
			assert.deepEqual(matchedSystems([filter('a', { minSize: 'XL' })]), [WR_C5]);
		});
		it('Jumps from you', () => assert.deepEqual(matchedSystems([filter('a', { classes: ['C5', 'C3', 'C2'], maxJumpsMe: 1 })], model(null, WR_C5)), [HOME, WR_C5, PULSAR_C3]));
		it('Jumps from you, location unknown: no match', () => assert.deepEqual(matchedSystems([filter('a', { classes: ['C5'], maxJumpsMe: 5 })], model(null, null)), []));
		it('Jumps from home', () => assert.deepEqual(matchedSystems([filter('a', { classes: ['C5', 'C3'], maxJumpsHome: 1 })]), [HOME, WR_C5]));
		it('Disabled filter never matches', () => assert.deepEqual(matchedSystems([filter('a', { classes: ['C5'] }, { enabled: false })]), []));
		it('A filter without conditions never matches', () => assert.deepEqual(matchedSystems([filter('a', {})]), []));
		it('Several filters: each match names its filter', () => {
			const m = wl.match([filter('a', { systemID: AMAMAKE }), filter('b', { classes: ['LS'] })], model(), appData);
			assert.deepEqual(m.map(x => x.key), ['a|' + AMAMAKE, 'b|' + AMAMAKE]);
			assert.deepEqual(m[0].nodeIDs, [4]);
			assert.deepEqual(wl.namesByNode(m), { 4: ['Filter a', 'Filter b'] });
		});
		it('Grouped per filter', () => assert.deepEqual(
			wl.groupByFilter(wl.match([filter('a', { classes: ['C5'] })], model(), appData)),
			[{ filterID: 'a', filterName: 'Filter a', systemIDs: [HOME, WR_C5] }]));
	});

	describe('new matches (repeat suppression)', () => {
		const m1 = wl.match([filter('a', { classes: ['C5'] })], model(), appData);
		it('First time: everything is new', () => {
			const d = wl.diff(null, m1);
			assert.deepEqual(d.fresh.map(x => x.systemID), [HOME, WR_C5]);
			assert.deepEqual(d.seen, { ['a|' + HOME]: true, ['a|' + WR_C5]: true });
		});
		it('Same matches on the next sync: nothing new', () => {
			const d1 = wl.diff(null, m1);
			assert.deepEqual(wl.diff(d1.seen, m1).fresh, []);
		});
		it('Only the newly added system is announced', () => {
			const d1 = wl.diff(null, m1);
			const extra = { key: 'a|31000999', filterID: 'a', filterName: 'Filter a', systemID: 31000999, nodeIDs: [9] };
			assert.deepEqual(wl.diff(d1.seen, m1.concat([extra])).fresh, [extra]);
		});
		it('A match that disappeared and came back is announced again', () => {
			const d1 = wl.diff(null, m1);
			const gone = wl.diff(d1.seen, m1.slice(0, 1));
			assert.deepEqual(gone.fresh, []);
			assert.deepEqual(wl.diff(gone.seen, m1).fresh.map(x => x.systemID), [WR_C5]);
		});
		it('The same system for another filter is new for that filter', () => {
			const d1 = wl.diff(null, m1);
			const m2 = m1.concat(wl.match([filter('b', { systemID: WR_C5 })], model(), appData));
			assert.deepEqual(wl.diff(d1.seen, m2).fresh.map(x => x.key), ['b|' + WR_C5]);
		});
		it('Duplicate keys count once', () => assert.equal(wl.diff(null, m1.concat(m1)).fresh.length, 2));
		it('Context key per mask and chain tab', () => {
			assert.equal(wl.contextKey('123.2', ''), '123.2#viewing');
			assert.equal(wl.contextKey('123.2', 31002238), '123.2#31002238');
			assert.notEqual(wl.contextKey('123.2', 1), wl.contextKey('456.2', 1));
		});
	});

	describe('chain map marker', () => {
		it('Badge and class on matching nodes, names escaped', () => {
			const r = sampleChain();
			wl.decorate(r, { 2: ["<b>Hunt</b>", "It's here"] });
			const f = r.map.rows[1].c[0].f;
			assert.ok(f.indexOf("class='node watchlist-match ") >= 0);
			assert.ok(f.indexOf("title='Watchlist: &lt;b&gt;Hunt&lt;/b&gt;, It&#39;s here'") >= 0);
			assert.ok(f.indexOf('<b>') < 0);
			assert.ok(f.indexOf("watchlist-badge") < f.indexOf("<div class='nodeIcons'>"));
			assert.equal(r.map.rows[0].c[0].f.indexOf('watchlist'), -1);
		});
		it('Decorating twice adds one badge', () => {
			const r = sampleChain();
			wl.decorate(r, { 2: ['a'] });
			wl.decorate(r, { 2: ['a'] });
			assert.equal(r.map.rows[1].c[0].f.split('watchlist-badge').length, 2);
		});
	});

	describe('editor', () => {
		it('Builds a filter from the form', () => {
			const r = wl.fromForm({ name: ' C5 WR ', classes: ['C5'], effects: ['Wolf-Rayet Star'], whType: 'h296', minSize: 'L', maxJumpsMe: '3', maxJumpsHome: '' }, appData, [], 1000);
			assert.deepEqual(r.filter, { id: 'f' + (1000).toString(36), name: 'C5 WR', enabled: true,
				conditions: { classes: ['C5'], effects: ['Wolf-Rayet Star'], whType: 'H296', minSize: 'L', maxJumpsMe: 3 } });
		});
		it('Region and constellation by name', () => {
			const r = wl.fromForm({ name: 'x', region: 'the forge', constellation: 'Jita' }, appData, [], 1);
			assert.equal(r.filter.conditions.regionID, appData.systems[JITA].regionID);
			assert.equal(r.filter.conditions.constellationID, appData.systems[JITA].constellationID);
			assert.equal(r.filter.conditions.constellationRef, JITA);
		});
		it('Keeps the ID when editing, new ID otherwise', () => {
			const existing = [{ id: 'abc' }];
			assert.equal(wl.fromForm({ id: 'abc', name: 'x', classes: ['C1'] }, appData, existing, 1).filter.id, 'abc');
			assert.notEqual(wl.fromForm({ id: 'zzz', name: 'x', classes: ['C1'] }, appData, existing, 1).filter.id, 'zzz');
		});
		it('New IDs never clash', () => assert.equal(wl.newID([{ id: 'f1' }], 1), 'f2'));
		it('Errors: no name, unknown system, K162, bad jumps', () => {
			const r = wl.fromForm({ name: '', system: 'Nowhere', whType: 'K162', staticType: 'X999', maxJumpsMe: '-1' }, appData, [], 1);
			assert.deepEqual(r.errors.map(e => e.field), ['name', 'system', 'staticType', 'whType', 'maxJumpsMe']);
		});
		it('Error: no conditions', () => assert.deepEqual(wl.fromForm({ name: 'x' }, appData, [], 1).errors, [{ field: '', message: 'Add at least one condition' }]));
		it('Form round trip', () => {
			const f = wl.fromForm({ name: 'x', system: 'J122515', region: 'Derelik', constellation: 'Jita', classes: ['C5'], effects: ['Pulsar'],
				staticLeadsTo: 'C5', staticType: 'H296', whType: 'D845', whLeadsTo: 'HS', minSize: 'M', maxJumpsMe: '0', maxJumpsHome: '4' }, appData, [], 1).filter;
			const form = wl.toForm(f, appData);
			assert.deepEqual(wl.fromForm(form, appData, [f], 2).filter, f);
		});
		it('Empty form for a new filter', () => assert.deepEqual(wl.toForm(null, appData).classes, []));
	});

	describe('describe', () => {
		it('Conditions in words', () => assert.deepEqual(
			wl.describe(wl.normaliseConditions({ systemID: WR_C5, classes: ['C5', 'C6'], effects: ['Wolf-Rayet Star'], staticLeadsTo: 'C5',
				whType: 'H296', minSize: 'L', maxJumpsMe: 1, maxJumpsHome: 3 }), appData),
			['J122515', 'C5 or C6', 'Wolf-Rayet', 'static to C5', 'through H296', 'hole size L or larger', '≤ 1 jump from you', '≤ 3 jumps from home']));
		it('Region and constellation', () => assert.deepEqual(
			wl.describe({ regionID: appData.systems[JITA].regionID, constellationID: appData.systems[JITA].constellationID, constellationRef: JITA }, appData),
			['in The Forge', 'in the constellation of Jita']));
		it('Nothing', () => assert.deepEqual(wl.describe(undefined, appData), []));
	});

	describe('escape', () => {
		it('HTML special characters', () => assert.equal(wl.escape(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'));
		it('null and undefined', () => assert.equal(wl.escape(null) + wl.escape(undefined), ''));
	});
});
