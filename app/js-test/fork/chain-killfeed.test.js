const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/system-killfeed');
include('app/js/fork/chain-killfeed');

describe('Chain kill feed', () => {
	const ckf = () => chainKillFeed;
	const T0 = Date.parse('2026-10-10T10:00:00Z');
	const iso = (ms) => new Date(ms).toISOString().replace('.000', '');
	const kill = (killID, systemID, minutesAgo, extra) => Object.assign({
		id: killID, killID: killID, systemID: systemID, killTime: iso(T0 - minutesAgo * 60000),
		victim: { characterID: 1000 + killID, corporationID: 2000 + killID, allianceID: null, shipTypeID: 587 },
		finalBlow: { characterID: 3000 + killID, corporationID: 4000 + killID, allianceID: 99000001, shipTypeID: 11393 },
		attackerCount: 3, attackerTotal: 3, totalValue: 1e6, npc: false, solo: false, awox: false
	}, extra || {});
	const all = { 31000005: true, 30002537: true, 30004759: true };
	const opts = (over) => Object.assign({ systems: all, nowMs: T0, max: 50, maxAgeMs: 6 * 3600000 }, over || {});

	describe('enabled', () => {
		it('is on unless explicitly false', () => {
			assert.equal(ckf().enabled(undefined), true);
			assert.equal(ckf().enabled({}), true);
			assert.equal(ckf().enabled({ chainKillFeed: {} }), true);
			assert.equal(ckf().enabled({ chainKillFeed: { enabled: true } }), true);
			assert.equal(ckf().enabled({ chainKillFeed: { enabled: false } }), false);
			assert.equal(ckf().enabled({ systemKillFeed: { enabled: false } }), true);
		});
	});

	describe('systemKind', () => {
		it('classifies like systemAnalysis (high-sec from 0.45)', () => {
			assert.equal(ckf().systemKind({ class: [5], security: -0.99 }), 'wh');
			assert.equal(ckf().systemKind({ class: [12], security: -0.99 }), 'wh');	// Thera
			assert.equal(ckf().systemKind({ class: 15 }), 'wh');	// drifter / shattered as a plain number
			assert.equal(ckf().systemKind({ baseSecurity: 0.945913 }), 'hs');	// Jita
			assert.equal(ckf().systemKind({ baseSecurity: 0.454546 }), 'hs');	// Rayeret rounds to 0.5
			assert.equal(ckf().systemKind({ baseSecurity: 0.438761 }), 'ls');	// Amamake rounds to 0.4
			assert.equal(ckf().systemKind({ security: 0.05 }), 'ls');
			assert.equal(ckf().systemKind({ security: 0.0 }), 'ns');
			assert.equal(ckf().systemKind({ security: -0.38 }), 'ns');
			assert.equal(ckf().systemKind({ security: -1.0, factionID: 500026 }), 'ns');	// Pochven
			assert.equal(ckf().systemKind({ security: 0.6, factionID: 500026 }), 'ns');
			assert.equal(ckf().systemKind({ class: [], security: 0.5 }), 'hs');
			assert.equal(ckf().systemKind({}), null);
			assert.equal(ckf().systemKind(null), null);
		});
		it('covers everything but high-sec', () => {
			assert.deepEqual(['wh', 'ls', 'ns', 'hs', null].map(ckf().coveredKind), [true, true, true, false, false]);
		});
	});

	describe('chainSystems', () => {
		const kinds = { 31000005: 'wh', 30002537: 'ls', 30000142: 'hs', 30004759: 'ns' };
		const row = (systemID, child, f) => ({ c: [{ v: systemID, systemID: systemID, f: f || "<div class='node'>" }, { v: 1 }], pathHome: child ? [child] : undefined });
		it('lists covered systems once, in map order, with the hole label', () => {
			const rows = [
				row(31000005),
				row(30002537, { systemID: 30002537, name: 'Ama', signatureID: 'abc111' }),
				row(30000142, { systemID: 30000142, signatureID: 'ghi333' }),
				row(30004759, { systemID: 30004759, signatureID: 'jkl444' }),
				row(30002537, { systemID: 30002537, signatureID: 'xyz999' }),	// loop: already listed
			];
			assert.deepEqual(ckf().chainSystems(rows, (id) => kinds[id]), [
				{ systemID: 31000005, label: '', kind: 'wh' },
				{ systemID: 30002537, label: 'Ama', kind: 'ls' },
				{ systemID: 30004759, label: 'JKL', kind: 'ns' },
			]);
		});
		it('skips generic, calculated and route nodes', () => {
			const rows = [
				row(4),	// genericSystemTypes index (unknown destination)
				row(30004759, null, "<div class='node calc'>"),
				row(30002537, { systemID: 30002537, path: [1, 2] }),
				Object.assign(row(31000005), { destination: true }),
				null, {}, { c: [] }
			];
			assert.deepEqual(ckf().chainSystems(rows, (id) => kinds[id]), []);
			assert.deepEqual(ckf().chainSystems(undefined, () => 'wh'), []);
		});
	});

	describe('diffSystems / chunk', () => {
		it('finds joined and left systems', () => {
			assert.deepEqual(ckf().diffSystems([1, 2, 3], [2, 3, 4, 5]), { added: [4, 5], removed: [1] });
			assert.deepEqual(ckf().diffSystems([], [1]), { added: [1], removed: [] });
		});
		it('splits into chunks of at most n', () => {
			const ids = Array.from({ length: 450 }, (_, i) => 30000001 + i);
			const chunks = ckf().chunk(ids, 200);
			assert.deepEqual(chunks.map(c => c.length), [200, 200, 50]);
			assert.deepEqual([].concat.apply([], chunks), ids);
			assert.deepEqual(ckf().chunk([], 200), []);
		});
	});

	describe('merge', () => {
		it('orders by kill time (then killID), not by arrival', () => {
			// since answers come in stored order: a back-fill or late upload brings old kills after new ones
			const r1 = ckf().merge([], [kill(10, 31000005, 1), kill(11, 30002537, 30)], opts());
			const r2 = ckf().merge(r1.kills, [kill(12, 30004759, 40), kill(13, 31000005, 5), kill(14, 31000005, 5)], opts());
			assert.deepEqual(r2.kills.map(k => k.killID), [10, 14, 13, 11, 12]);
			assert.deepEqual(r2.added.sort(), [12, 13, 14]);
		});
		it('deduplicates by killID; the newer copy wins', () => {
			const r1 = ckf().merge([], [kill(10, 31000005, 1, { totalValue: 1 })], opts());
			const r2 = ckf().merge(r1.kills, [kill(10, 31000005, 1, { totalValue: 2 }), kill(10, 31000005, 1, { totalValue: 3 })], opts());
			assert.equal(r2.kills.length, 1);
			assert.equal(r2.kills[0].totalValue, 3);
			assert.deepEqual(r2.added, []);
		});
		it('keeps at most max kills, dropping the oldest', () => {
			const many = Array.from({ length: 120 }, (_, i) => kill(100 + i, 31000005, i));
			const r = ckf().merge([], many, opts());
			assert.equal(r.kills.length, 50);
			assert.equal(r.kills[0].killID, 100);
			assert.equal(r.kills[49].killID, 149);
			// an old kill arriving again doesn't push out newer ones and isn't "added"
			const again = ckf().merge(r.kills, [kill(200, 31000005, 119)], opts());
			assert.deepEqual(again.kills.map(k => k.killID), r.kills.map(k => k.killID));
			assert.deepEqual(again.added, []);
		});
		it('drops kills of systems no longer on the chain and too old ones', () => {
			const r = ckf().merge([kill(1, 31000005, 1), kill(2, 30002537, 2)], [kill(3, 30000142, 1), kill(4, 31000005, 7 * 60)],
				opts({ systems: { 31000005: true } }));
			assert.deepEqual(r.kills.map(k => k.killID), [1]);
			assert.deepEqual(ckf().merge(r.kills, [], opts({ systems: {} })).kills, []);
		});
		it('ignores junk', () => {
			const r = ckf().merge(null, [null, {}, { killID: 0 }, kill(5, 31000005, 1)], opts());
			assert.deepEqual(r.kills.map(k => k.killID), [5]);
			assert.deepEqual(ckf().merge([], 'x', opts()).kills, []);
		});
	});

	describe('names', () => {
		it('keeps only names the kills reference', () => {
			const kills = [kill(1, 31000005, 1)];
			const names = ckf().mergeNames({ 1001: 'Old Pilot', 9999: 'Gone' }, { 2001: 'Corp', 587: 'Rifter', 8888: 'Other' }, kills);
			assert.deepEqual(names, { 1001: 'Old Pilot', 2001: 'Corp', 587: 'Rifter' });
		});
		it('stays bounded by the kills in memory', () => {
			let names = {};
			let kills = [];
			for (let round = 0; round < 200; round++) {
				const batch = Array.from({ length: 10 }, (_, i) => kill(round * 10 + i + 1, 31000005, -round));
				const incoming = {};
				batch.forEach(k => { incoming[k.victim.characterID] = 'p'; incoming[k.victim.corporationID] = 'c'; incoming[k.finalBlow.characterID] = 'f'; });
				kills = ckf().merge(kills, batch, opts({ nowMs: T0 + round * 60000 })).kills;
				names = ckf().mergeNames(names, incoming, kills);
			}
			assert.equal(kills.length, 50);
			assert.ok(Object.keys(names).length <= 50 * 3, 'names: ' + Object.keys(names).length);
		});
	});

	describe('cursor', () => {
		it('continues from the lowest cursor of the chunks', () => {
			assert.equal(ckf().nextCursor([500, 420, 510]), 420);
			assert.equal(ckf().nextCursor([0]), 0);
			assert.equal(ckf().nextCursor([undefined, 'x', 300]), 300);
			assert.equal(ckf().nextCursor([]), null);
		});
	});

	describe('back-fill bookkeeping', () => {
		const REQUEUE = 30 * 60000;
		it('asks for a back-fill once per system, again only after it was gone a while', () => {
			const handled = { 1: { leftAt: null }, 2: { leftAt: T0 - 60000 }, 3: { leftAt: T0 - REQUEUE - 1 } };
			assert.equal(ckf().needsBackfill(handled, 1, T0), false);
			assert.equal(ckf().needsBackfill(handled, 2, T0), false);
			assert.equal(ckf().needsBackfill(handled, 3, T0), true);
			assert.equal(ckf().needsBackfill(handled, 4, T0), true);
		});
		it('bounds the handled systems', () => {
			const handled = {};
			for (let i = 0; i < 3000; i++) { handled[i] = { leftAt: i < 10 ? null : T0 - (i % 2 ? 100 * i : REQUEUE + i) }; }
			const pruned = ckf().pruneHandled(handled, T0, 1000);
			assert.equal(Object.keys(pruned).length, 1000);
			for (let i = 0; i < 10; i++) { assert.ok(pruned[i], 'on-chain system kept'); }
			assert.ok(!Object.keys(pruned).some(id => pruned[id].leftAt !== null && T0 - pruned[id].leftAt > REQUEUE));
			assert.ok(pruned[11] && !pruned[2999], 'the most recently left are kept');
		});
	});

	describe('highlight', () => {
		it('highlights recent live kills from systems that are not loading history', () => {
			const kills = [kill(1, 31000005, 1), kill(2, 30002537, 2), kill(3, 31000005, 50), kill(4, 31000005, 1)];
			assert.deepEqual(ckf().freshKills(kills, [1, 2, 3], { 30002537: true }, T0), [1]);
		});
		it('forgets highlights of expired and dropped kills', () => {
			const fresh = { 1: T0 + 5000, 2: T0 - 1, 3: T0 + 5000 };
			assert.deepEqual(ckf().pruneFresh(fresh, [kill(1, 31000005, 1), kill(2, 31000005, 1)], T0), { 1: T0 + 5000 });
		});
		it('ends settle periods', () => {
			assert.deepEqual(ckf().pruneUntil({ 31000005: T0 + 1, 30002537: T0, 30004759: T0 - 1 }, T0), { 31000005: T0 + 1 });
			assert.deepEqual(ckf().pruneUntil(undefined, T0), {});
		});
	});

	describe('view', () => {
		it('picks the panel state', () => {
			assert.equal(ckf().viewState(0, 0, false, null), 'nosystems');
			assert.equal(ckf().viewState(3, 5, true, null), 'list');
			assert.equal(ckf().viewState(3, 0, true, { enabled: true }), 'loading');
			assert.equal(ckf().viewState(3, 0, false, { enabled: true }), 'empty');	// partial history without pending: no spinner
			assert.equal(ckf().viewState(3, 0, false, { enabled: false }), 'disabled');
		});
		it('describes the system', () => {
			assert.deepEqual(ckf().systemTooltip('Amamake', 'LS', 0.438761, 'Ama'), ['Amamake (LS 0.4)', 'Hole: Ama', 'Click to view the system']);
			assert.deepEqual(ckf().systemTooltip('J151231', 'C2', -0.99, ''), ['J151231 (C2)', '', 'Click to view the system']);
		});
		it('renders rows with the system kill feed renderer, escaped', () => {
			const response = { kills: [kill(7, 31000005, 1)], names: { 1007: '<b>Pilot</b>' } };
			const row = systemKillFeed.buildRows(response)[0];
			const html = systemKillFeed.rowHtml(row, T0, { className: 'ckf-new', html: "<span class='ckf-sys'>X</span>" });
			assert.ok(html.indexOf("class='skf-row ckf-new'") > 0);
			assert.ok(html.indexOf("<span class='ckf-sys'>X</span><span class='skf-time'") > 0);
			assert.ok(html.indexOf('&lt;b&gt;Pilot&lt;/b&gt;') > 0 && html.indexOf('<b>') < 0);
			// without extras the system panel's row is unchanged
			assert.ok(systemKillFeed.rowHtml(row, T0).indexOf("class='skf-row'") > 0);
		});
	});
});
