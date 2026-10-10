const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('app/js/fork/fit-mass-data');
include('app/js/fork/auto-mass');

const t = n => n * 1000;	// tonnes -> kg
const MEGATHRON = 1040000000001, LOKI = 1040000000002, ONYX = 1040000000003;
const MEGA_HULL = t(98400), LOKI_HULL = t(13800);
const pages = () => [loadJSON('app/js-test/testdata/auto-mass/assets-page1'), loadJSON('app/js-test/testdata/auto-mass/assets-page2')];

// A JWT with the given payload (signature not checked)
const jwt = payload => 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_') + '.sig';

describe('Fitted jump mass (auto-mass)', () => {
	describe('fit-mass-data', () => {
		it('knows real prop module mass additions', () => {
			assert.equal(fitMassData.types[12068].a, t(50000));	// 100MN Afterburner II
			assert.equal(fitMassData.types[12068].p, 1);
			assert.equal(fitMassData.types[12076].a, t(5000));	// 50MN Microwarpdrive II
			assert.equal(fitMassData.types[41239].a, t(500000));	// 10000MN Afterburner II
		});
		it('knows plates (always on) and Higgs anchors (x2)', () => {
			assert.equal(fitMassData.types[20353].a, t(3750));	// 1600mm Steel Plates II
			assert.equal(fitMassData.types[20353].p, undefined);
			assert.equal(fitMassData.types[34306].x, 2);	// Large Higgs Anchor I
		});
		it('has nothing for modules that leave mass alone (T3 subsystems, damage control)', () => {
			assert.equal(fitMassData.types[45595], undefined);
			assert.equal(fitMassData.types[2048], undefined);
		});
	});

	describe('indexAssets / fitFor', () => {
		const index = autoMass.indexAssets(pages());
		it('finds the modules fitted in the active ship across pages, not its cargo or drones', () => {
			assert.deepEqual(autoMass.fitFor(index, MEGATHRON).sort(), [12068, 20353, 20353, 2048, 34306, 3146, 3146].sort());
		});
		it('finds a docked ship\'s fit, subsystems included', () => {
			assert.deepEqual(autoMass.fitFor(index, LOKI), [45595, 45599, 45603, 45607, 12076, 11325]);
		});
		it('an assembled ship with nothing fitted has an empty fit', () => assert.deepEqual(autoMass.fitFor(index, ONYX), []));
		it('a ship missing from the snapshot is unknown (null), not empty', () => {
			assert.equal(autoMass.fitFor(index, 1049999999999), null);
			assert.equal(autoMass.fitFor(index, null), null);
			assert.equal(autoMass.fitFor(null, MEGATHRON), null);
		});
		it('copes with empty or broken pages', () => {
			assert.deepEqual(autoMass.indexAssets([]), { fits: {}, items: {} });
			assert.deepEqual(autoMass.indexAssets([null, [null, {}]]), { fits: {}, items: {} });
		});
	});

	describe('fitMass', () => {
		const index = autoMass.indexAssets(pages());
		it('rolling Megathron: plates and Higgs in cold, 100MN AB in hot', () => {
			const m = autoMass.fitMass(MEGA_HULL, autoMass.fitFor(index, MEGATHRON), fitMassData);
			assert.equal(m.known, true);
			assert.equal(m.base, MEGA_HULL + 2 * t(3750));
			assert.equal(m.multiplier, 2);
			assert.equal(m.cold, (MEGA_HULL + t(7500)) * 2);	// 211,800 t
			assert.equal(m.hot, (MEGA_HULL + t(7500) + t(50000)) * 2);	// 311,800 t
			assert.equal(m.prop.name, '100MN Afterburner II');
			assert.equal(m.higgs, 'Large Higgs Anchor I');
			assert.equal(m.additions.length, 2);
		});
		it('Loki: subsystems add nothing, a 50MN MWD adds 5,000 t (not 50,000 t)', () => {
			const m = autoMass.fitMass(LOKI_HULL, autoMass.fitFor(index, LOKI), fitMassData);
			assert.equal(m.cold, LOKI_HULL + t(3500));
			assert.equal(m.hot, LOKI_HULL + t(3500) + t(5000));
			assert.equal(m.multiplier, 1);
			assert.equal(m.higgs, null);
		});
		it('several prop modules: only the heaviest counts (one can be active)', () => {
			const m = autoMass.fitMass(t(1000), [12076, 12068], fitMassData);
			assert.equal(m.prop.typeID, 12068);
			assert.equal(m.hot, t(1000) + t(50000));
		});
		it('no fit (hull only) or an empty fit is the hull', () => {
			assert.deepEqual([autoMass.fitMass(t(1000), null, fitMassData).cold, autoMass.fitMass(t(1000), null, fitMassData).hot], [t(1000), t(1000)]);
			assert.equal(autoMass.fitMass(t(1000), [], fitMassData).prop, null);
		});
		it('unknown modules and missing data add nothing', () => {
			assert.equal(autoMass.fitMass(t(1000), [999999999], fitMassData).cold, t(1000));
			assert.equal(autoMass.fitMass(t(1000), [20353], undefined).cold, t(1000));
		});
		it('unknown hull is unknown', () => {
			assert.deepEqual(autoMass.fitMass(undefined, [20353], fitMassData), { known: false });
			assert.deepEqual(autoMass.fitMass(0, [], fitMassData), { known: false });
		});
	});

	describe('jumpMass (logged jumps)', () => {
		const upstream = (hull, prop, higgs) => ({ originalMass: hull, prop: !!prop, higgs: !!higgs });
		const fitRow = (hot) => ({ fitSource: 'assets', baseMass: String(MEGA_HULL + t(7500)), propMass: String(t(50000)), higgsMult: '2.00', propTypeID: '12068', fitTime: '1791640000', hot: hot });
		it('a logged cold fit uses the fitted cold mass', () => {
			const m = autoMass.jumpMass(fitRow('0'), upstream(MEGA_HULL));
			assert.equal(m.mass, (MEGA_HULL + t(7500)) * 2);
			assert.deepEqual([m.hot, m.prop, m.higgs], [false, false, true]);
			assert.equal(m.fit.source, 'assets');
			assert.equal(m.fit.propTypeID, 12068);
		});
		it('a logged hot fit adds the real prop module, times Higgs', () => {
			assert.equal(autoMass.jumpMass(fitRow('1'), upstream(MEGA_HULL)).mass, (MEGA_HULL + t(57500)) * 2);
		});
		it('the pilot\'s hot/cold wins over the chain map toggle stored upstream', () => {
			assert.equal(autoMass.jumpMass(fitRow(0), upstream(MEGA_HULL, true)).hot, false);
			assert.equal(autoMass.jumpMass(fitRow(null), upstream(MEGA_HULL, true)).hot, true);
		});
		it('hot without a prop module fitted is the cold mass', () => {
			const row = Object.assign(fitRow(1), { propMass: '0', propTypeID: null });
			const m = autoMass.jumpMass(row, upstream(MEGA_HULL));
			assert.equal(m.mass, (MEGA_HULL + t(7500)) * 2);
			assert.equal(m.prop, false);
		});
		it('hull only: upstream\'s rule, with the confirmed hot/cold', () => {
			assert.equal(autoMass.jumpMass({ fitSource: 'hull', hot: '1' }, upstream(MEGA_HULL)).mass, MEGA_HULL + t(50000));
			assert.equal(autoMass.jumpMass({ fitSource: 'hull', hot: '0' }, upstream(MEGA_HULL, true, true)).mass, MEGA_HULL * 2);
			assert.equal(autoMass.jumpMass({ fitSource: 'hull', hot: '1' }, upstream(t(1200000))).mass, t(1700000));
			assert.equal(autoMass.jumpMass({ fitSource: 'hull' }, upstream(MEGA_HULL)).fit.source, 'hull');
		});
		it('no fork row at all: exactly upstream', () => {
			const m = autoMass.jumpMass({ fitSource: null, hot: null }, upstream(MEGA_HULL, true, true));
			assert.equal(m.mass, (MEGA_HULL + t(50000)) * 2);
			assert.equal(m.fit, null);
		});
		it('a broken fit row falls back to the hull', () => {
			assert.equal(autoMass.jumpMass({ fitSource: 'assets', baseMass: null }, upstream(MEGA_HULL)).mass, MEGA_HULL);
		});
	});

	describe('totals', () => {
		it('re-totals per size class like upstream', () => {
			const r = autoMass.totals([
				{ originalMass: t(1000), mass: t(1500) }, { originalMass: t(13800), mass: t(22300) },
				{ originalMass: MEGA_HULL, mass: t(311800) }, { originalMass: t(1200000), mass: t(1700000) }
			]);
			assert.equal(r.totalMass, t(1500 + 22300 + 311800 + 1700000));
			assert.deepEqual([r.smallMass, r.mediumMass, r.largeMass, r.xlMass], [t(1500), t(22300), t(311800), t(1700000)]);
			assert.equal(r.jumps.length, 4);
		});
		it('empty log', () => assert.equal(autoMass.totals([]).totalMass, 0));
	});

	describe('tokens and throttling', () => {
		it('reads scopes from the SSO token', () => {
			const token = jwt({ scp: ['esi-location.read_location.v1', 'esi-assets.read_assets.v1'] });
			assert.equal(autoMass.hasAssetsScope(token), true);
			assert.equal(autoMass.hasAssetsScope(jwt({ scp: ['esi-location.read_location.v1'] })), false);
			assert.equal(autoMass.hasAssetsScope(jwt({ scp: 'esi-assets.read_assets.v1' })), true);
			assert.equal(autoMass.hasAssetsScope(jwt({ sub: 'CHARACTER:EVE:1' })), false);
		});
		it('an unreadable token is "don\'t know" (try and look for a 403)', () => {
			assert.equal(autoMass.hasAssetsScope('not-a-jwt'), null);
			assert.equal(autoMass.hasAssetsScope(undefined), null);
		});
		const now = 1e12, min = 60000;
		it('fetches the first time, never twice at once, and backs off after errors', () => {
			assert.equal(autoMass.shouldFetch({}, now, 5), true);
			assert.equal(autoMass.shouldFetch({ fetching: true }, now, 5), false);
			assert.equal(autoMass.shouldFetch({ retryAt: now + 1 }, now, 5), false);
			assert.equal(autoMass.shouldFetch({}, now, null), false);
		});
		it('never before ESI\'s cache expires', () => {
			assert.equal(autoMass.shouldFetch({ index: {}, shipID: 4, fetchedAt: now - 60 * min, expires: now + min }, now, 5), false);
		});
		it('after a ship change once the cache expired, else at most every 10 minutes', () => {
			assert.equal(autoMass.shouldFetch({ index: {}, shipID: 4, fetchedAt: now - 2 * min, expires: now - 1 }, now, 5), true);
			assert.equal(autoMass.shouldFetch({ index: {}, shipID: 5, fetchedAt: now - 2 * min, expires: now - 1 }, now, 5), false);
			assert.equal(autoMass.shouldFetch({ index: {}, shipID: 5, fetchedAt: now - 11 * min, expires: now - 1 }, now, 5), true);
		});
	});

	describe('report', () => {
		it('sends numbers for a fitted ship', () => {
			const m = autoMass.fitMass(MEGA_HULL, autoMass.fitFor(autoMass.indexAssets(pages()), MEGATHRON), fitMassData);
			assert.deepEqual(autoMass.report(91, 31001880, 31001881, 641, m, 'assets', 1791640000123, true), {
				mode: 'report', characterID: 91, fromID: 31001880, toID: 31001881, shipTypeID: 641, fitSource: 'assets', hot: 1,
				baseMass: MEGA_HULL + t(7500), higgsMult: 2, propTypeID: 12068, propMass: t(50000), fitTime: 1791640000
			});
		});
		it('hull only sends no fit numbers', () => {
			assert.deepEqual(autoMass.report(91, 1, 2, 641, autoMass.fitMass(MEGA_HULL, null, fitMassData), 'hull', null, false),
				{ mode: 'report', characterID: 91, fromID: 1, toID: 2, shipTypeID: 641, fitSource: 'hull', hot: 0 });
		});
	});

	describe('helpers', () => {
		it('gate neighbours from the gate map', () => {
			const map = { 2: { 3: 1 } };
			assert.equal(autoMass.gateNeighbours(map, 30000002, 30000003), true);
			assert.equal(autoMass.gateNeighbours(map, 30000002, 30000004), false);
			assert.equal(autoMass.gateNeighbours(null, 30000002, 30000003), false);
		});
		it('finds the hole between two systems either way round', () => {
			const sigs = { 1: { systemID: 10 }, 2: { systemID: 20 }, 3: { systemID: 30 } };
			const holes = { 7: { id: 7, initialID: 1, secondaryID: 2 }, 8: { id: 8, initialID: 3, secondaryID: 1 } };
			assert.equal(autoMass.holeBetween(20, 10, holes, sigs).id, 7);
			assert.equal(autoMass.holeBetween(10, 30, holes, sigs).id, 8);
			assert.equal(autoMass.holeBetween(20, 30, holes, sigs), null);
		});
		it('formats tonnes and times', () => {
			assert.equal(autoMass.formatT(t(311800)), '311,800 t');
			assert.equal(autoMass.formatTime(''), '');
			assert.match(autoMass.formatTime(1791640000), /^\d\d:\d\d$/);
			assert.match(autoMass.formatTime('2026-10-10 19:16:55'), /^\d\d:\d\d$/);
		});
		it('describes the source honestly', () => {
			assert.match(autoMass.sourceText({ source: 'assets', time: 1791640000, cold: 1, hotMass: 2, propMass: 0, multiplier: 1 }), /up to an hour late.*no prop module/);
			assert.match(autoMass.sourceText({ source: 'hull' }), /Hull mass only/);
			assert.match(autoMass.sourceText(null), /no fit logged/);
		});
		it('escapes', () => assert.equal(autoMass.escape('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;'));
		it('toggles: on unless turned off', () => {
			assert.equal(autoMass.enabled(undefined), true);
			assert.equal(autoMass.enabled({ autoMass: { enabled: false } }), false);
			assert.equal(autoMass.promptEnabled({ autoMass: { prompt: false } }), false);
			assert.equal(autoMass.promptEnabled({ autoMass: { enabled: false, prompt: true } }), false);
			assert.equal(autoMass.promptEnabled({}), true);
		});
	});
});
