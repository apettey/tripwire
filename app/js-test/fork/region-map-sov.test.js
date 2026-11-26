const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/region-map-sov');

const rv = regionMapSov;
const factions = { 500001: { name: 'Caldari State' }, 500002: { name: 'Minmatar Republic' }, 500003: { name: 'Amarr Empire' }, 500010: { name: 'Guristas Pirates' }, 500019: { name: "Sansha's Nation" } };
const data = {
	systems: { 1: { a: 99003581, c: 98000001 }, 2: { a: 99003581, c: 98000001 }, 3: { a: 1354830081, c: 98000002 }, 4: { f: 500010 }, 5: { f: 500003 }, 7: { a: 424242, c: 1 } },
	alliances: { 99003581: { name: 'Fraternity.', ticker: 'FRT' }, 1354830081: { name: 'Goonswarm Federation', ticker: 'CONDI' }, 424242: { name: '', ticker: '' } },
	incursions: [{ constellationID: 20000064, factionID: 500019, boss: true, systems: [1, 2, 3], influence: 0.62, staging: 2, state: 'established', type: 'Incursion' }],
	sov: { fetched: 1000, stale: false, unavailable: false, error: null },
	incursionsStatus: { fetched: 1000, stale: false, unavailable: false, error: null },
	now: 1100
};
const fwSystems = {
	5: { solar_system_id: 5, owner_faction_id: 500003, occupier_faction_id: 500002, contested: 'contested', victory_points: 37, victory_points_threshold: 100 },
	6: { solar_system_id: 6, owner_faction_id: 500001, occupier_faction_id: 500001, contested: 'uncontested', victory_points: 0, victory_points_threshold: 75000 },
	8: { solar_system_id: 8, owner_faction_id: 500001, occupier_faction_id: 500001, contested: 'vulnerable', victory_points: 80000, victory_points_threshold: 75000 },
	9: { solar_system_id: 9, owner_faction_id: 500003, occupier_faction_id: 500002, contested: 'captured', victory_points: 0, victory_points_threshold: 75000 }
};

describe('Region map sovereignty', () => {
	describe('allianceColour', () => {
		it('is stable and from the palette', () => {
			assert.strictEqual(rv.allianceColour(99003581), rv.allianceColour('99003581'));
			assert.ok(rv.PALETTE.indexOf(rv.allianceColour(99003581)) >= 0);
			assert.ok(rv.PALETTE.indexOf(rv.allianceColour(0)) >= 0);
			assert.ok(rv.PALETTE.indexOf(rv.allianceColour('junk')) >= 0);
		});
		it('spreads neighbouring alliance IDs over the palette', () => {
			const seen = new Set();
			for (let id = 99013000; id < 99013032; id++) { seen.add(rv.allianceColour(id)); }
			assert.ok(seen.size >= 10, 'only ' + seen.size + ' colours for 32 IDs');
		});
	});

	describe('faction warfare', () => {
		it('works out the contested percentage', () => {
			assert.strictEqual(rv.fwPercent(fwSystems[5]), 37);
			assert.strictEqual(rv.fwPercent(fwSystems[8]), 100);
			assert.strictEqual(rv.fwPercent({ victory_points: 5, victory_points_threshold: 0 }), 0);
			assert.strictEqual(rv.fwPercent(null), 0);
		});
		it('describes the occupier, the owner and the state', () => {
			assert.strictEqual(rv.fwText(rv.fwInfo(fwSystems[5]), factions), 'Faction warfare: occupied by Minmatar (owner Amarr), contested 37%');
			assert.strictEqual(rv.fwText(rv.fwInfo(fwSystems[6]), factions), 'Faction warfare: Caldari, uncontested');
			assert.strictEqual(rv.fwText(rv.fwInfo(fwSystems[8]), factions), 'Faction warfare: Caldari, vulnerable 100%');
			assert.strictEqual(rv.fwText(rv.fwInfo(fwSystems[9]), factions), 'Faction warfare: occupied by Minmatar (owner Amarr), captured');
			assert.strictEqual(rv.fwInfo({ occupier_faction_id: 0 }), null);
		});
		it('labels the box', () => {
			assert.strictEqual(rv.fwLabel(rv.fwInfo(fwSystems[5]), factions), 'Minmatar 37%');
			assert.strictEqual(rv.fwLabel(rv.fwInfo(fwSystems[6]), factions), 'Caldari');
			assert.strictEqual(rv.fwLabel(rv.fwInfo(fwSystems[8]), factions), 'Vulnerable');
			assert.strictEqual(rv.fwLabel(rv.fwInfo(fwSystems[9]), factions), 'Captured');
			const little = { owner_faction_id: 500001, occupier_faction_id: 500001, contested: 'contested', victory_points: 300, victory_points_threshold: 75000 };
			assert.strictEqual(rv.fwLabel(rv.fwInfo(little), factions), 'Caldari <1%');
			assert.strictEqual(rv.fwLabel(rv.fwInfo(Object.assign({}, little, { victory_points: 0 })), factions), 'Caldari 0%');
		});
		it('sums up a region by occupier', () => {
			const s = rv.fwSummary([5, 6, 8, 9, 1], fwSystems);
			assert.deepStrictEqual([s.systems, s.contested, s.vulnerable], [4, 1, 1]);
			assert.deepStrictEqual(s.occupiers, [{ factionID: 500001, count: 2 }, { factionID: 500002, count: 2 }]);
			assert.strictEqual(rv.fwSummary([1], null).systems, 0);
		});
	});

	describe('holder', () => {
		it('names the alliance with its ticker', () => {
			const h = rv.holder(1, data, fwSystems, factions);
			assert.deepStrictEqual([h.kind, h.label, h.text, h.allianceID], ['alliance', '[FRT]', 'Sov: Fraternity. [FRT]', 99003581]);
			assert.strictEqual(h.colour, rv.allianceColour(99003581));
		});
		it('falls back when the server has no name yet', () => {
			const h = rv.holder(7, data, null, factions);
			assert.deepStrictEqual([h.label, h.text], ['Alliance', 'Sov: Alliance 424242']);
		});
		it('shows NPC faction space with a label, empire space without one', () => {
			const npc = rv.holder(4, data, null, factions);
			assert.deepStrictEqual([npc.kind, npc.label, npc.text, npc.empire], ['faction', 'Guristas', 'Faction: Guristas Pirates', false]);
			const empire = rv.holder(5, data, null, factions);
			assert.deepStrictEqual([empire.kind, empire.label, empire.text, empire.bar], ['faction', '', 'Faction: Amarr Empire', true]);
		});
		it('prefers faction warfare over the faction of the sovereignty map', () => {
			const h = rv.holder(5, data, fwSystems, factions);
			assert.deepStrictEqual([h.kind, h.label, h.factionID, h.state], ['fw', 'Minmatar 37%', 500002, 'contested']);
			assert.strictEqual(h.colour, rv.factionColour(500002));
			// FW works before the sovereignty data has loaded
			assert.strictEqual(rv.holder(6, null, fwSystems, factions).label, 'Caldari');
		});
		it('says nobody holds an unclaimed system, and nothing while loading or unavailable', () => {
			assert.strictEqual(rv.holder(99, data, null, factions).text, 'Sov: nobody');
			assert.strictEqual(rv.holder(99, null, null, factions).text, '');
			assert.strictEqual(rv.holder(99, Object.assign({}, data, { sov: { unavailable: true } }), null, factions).text, '');
			assert.strictEqual(rv.holder(99, data, null, factions).bar, false);
		});
		it('uses the short label of a faction appData does not know', () => {
			assert.strictEqual(rv.factionName(500026, {}), 'Triglavian');
			assert.strictEqual(rv.factionName(123, {}), 'Faction 123');
		});
	});

	describe('incursions', () => {
		const idx = rv.incursionIndex(data.incursions);
		it('indexes infested and staging systems', () => {
			assert.deepStrictEqual(Object.keys(idx).map(Number), [1, 2, 3]);
			assert.strictEqual(idx[2].staging, true);
			assert.strictEqual(idx[1].staging, false);
			assert.deepStrictEqual(rv.incursionIndex(null), {});
		});
		it('adds a staging system outside the infested list', () => {
			const i = rv.incursionIndex([{ systems: [1], staging: 5, state: 'mobilizing' }]);
			assert.strictEqual(i[5].staging, true);
		});
		it('describes state, staging and mothership', () => {
			assert.strictEqual(rv.incursionText(idx[2], factions), "Incursion (Sansha's Nation): established, staging system, mothership present, influence 62%");
			assert.strictEqual(rv.incursionText(idx[1], factions), "Incursion (Sansha's Nation): established, mothership present, influence 62%");
			assert.strictEqual(rv.incursionText(null), '');
		});
		it('splits incursions into this region and elsewhere', () => {
			const systems = { 1: { regionID: 10 }, 2: { regionID: 10 }, 3: { regionID: 10 }, 50: { regionID: 20 } };
			const list = data.incursions.concat([{ systems: [50], staging: 50, state: 'withdrawing' }]);
			const r = rv.regionIncursions(list, [1, 2, 3, 4], systems);
			assert.strictEqual(r.here.length, 1);
			assert.deepStrictEqual(r.elsewhere.map(x => x.regionID), [20]);
		});
	});

	describe('legend', () => {
		it('lists the holders with the most systems first, FW systems left out', () => {
			const l = rv.legend([1, 2, 3, 4, 5], data, fwSystems);
			assert.deepStrictEqual(l.map(x => [x.ticker, x.count]), [['FRT', 2], ['CONDI', 1]]);
			assert.deepStrictEqual(rv.legend([4, 5], data, null), []);
		});
		it('lists the NPC factions, FW systems left out', () => {
			assert.deepStrictEqual(rv.factionLegend([1, 4, 5], data, null), [{ factionID: 500003, count: 1 }, { factionID: 500010, count: 1 }]);
			assert.deepStrictEqual(rv.factionLegend([4, 5], data, fwSystems), [{ factionID: 500010, count: 1 }]);
		});
	});

	describe('loading', () => {
		it('fetches a region once, again after 10 minutes, and backs off after a failure', () => {
			const t = 1e12;
			assert.strictEqual(rv.needsFetch(undefined, t), true);
			assert.strictEqual(rv.needsFetch({ busy: true }, t), false);
			assert.strictEqual(rv.needsFetch({ data: {}, at: t }, t + 60000), false);
			assert.strictEqual(rv.needsFetch({ data: {}, at: t }, t + rv.REFRESH_MS), true);
			assert.strictEqual(rv.needsFetch({ failedAt: t }, t + 30000), false);
			assert.strictEqual(rv.needsFetch({ failedAt: t }, t + rv.RETRY_MS), true);
		});
		it('asks again soon while alliances are being named, a few times only', () => {
			const t = 1e12;
			assert.strictEqual(rv.needsFetch({ data: { pending: true }, at: t, pendingTries: 1 }, t + rv.PENDING_MS), true);
			assert.strictEqual(rv.needsFetch({ data: { pending: true }, at: t, pendingTries: 1 }, t + 1000), false);
			assert.strictEqual(rv.needsFetch({ data: { pending: true }, at: t, pendingTries: rv.PENDING_MAX }, t + rv.PENDING_MS), false);
		});
		it('knows where faction warfare can be: low-sec or empire faction space', () => {
			const systems = { 1: { security: -0.4 }, 2: { security: 0.3 }, 3: { security: 0.46 }, 4: { security: 0.04 } };
			assert.strictEqual(rv.fwPossible([1], systems, data), false);
			assert.strictEqual(rv.fwPossible([1, 2], systems, data), true);
			assert.strictEqual(rv.fwPossible([3], systems, null), false, '0.46 shows as 0.5: high-sec');
			assert.strictEqual(rv.fwPossible([4], systems, null), true, '0.04 shows as 0.1: low-sec');
			assert.strictEqual(rv.fwPossible([5], {}, data), true, 'Amarr faction space');
			assert.strictEqual(rv.fwPossible([4], {}, data), false, 'Guristas space');
		});
		it('says when data is missing or old', () => {
			assert.strictEqual(rv.statusText(data, true), '');
			assert.strictEqual(rv.statusText(Object.assign({}, data, { sov: { unavailable: true, error: 'ESI answered 503' } }), true), 'Sovereignty unavailable (ESI answered 503).');
			assert.strictEqual(rv.statusText(Object.assign({}, data, { now: 1000 + 3 * 3600, sov: { stale: true, fetched: 1000 } }), true), 'ESI is not answering: sovereignty is from 3 h ago.');
			assert.strictEqual(rv.statusText(data, false), 'Faction warfare unavailable.');
		});
	});

	describe('signature', () => {
		it('changes with what is drawn', () => {
			const a = rv.signature([1, 5], data, fwSystems, factions);
			assert.strictEqual(a, rv.signature([1, 5], data, fwSystems, factions));
			const moved = Object.assign({}, fwSystems, { 5: Object.assign({}, fwSystems[5], { victory_points: 40 }) });
			assert.notStrictEqual(a, rv.signature([1, 5], data, moved, factions));
			// faction warfare is drawn before the sovereignty data has loaded
			assert.notStrictEqual(rv.signature([6], null, null, factions), rv.signature([6], null, fwSystems, factions));
		});
	});
});
