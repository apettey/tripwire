const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { include } = require('../helpers/helpers');
include('app/js/fork/site-values');

describe('Gas and ore site value', () => {
	const data = {
		types: { 1: { name: 'Gas A', m3: 1 }, 2: { name: 'Gas B', m3: 10 }, 3: { name: 'Rock', m3: 16 } },
		fallbackPrices: { date: '2026-11-15', prices: { 1: 1000, 2: 50000, 3: 2000 } },
		sites: [
			{ name: 'Vital Core Reservoir', kind: 'gas', classes: 'C5-C6', status: 'verified', contents: [[2, 24000], [1, 2000]] },
			{ name: 'Sizeable Perimeter Reservoir', aliases: ['Sizable Perimeter Reservoir'], kind: 'gas', status: 'verified', contents: [[1, 12000]] },
			{ name: 'Rarified Core Deposit', kind: 'ore', status: 'approximate', contents: [[3, 100000]] },
			{ name: 'Shattered Debris Field', kind: 'ore', status: 'unverified', reason: 'Old <names>' }
		]
	};
	const index = siteValues.index(data);

	it('is on unless switched off', () => {
		assert.strictEqual(siteValues.enabled(undefined), true);
		assert.strictEqual(siteValues.enabled({}), true);
		assert.strictEqual(siteValues.enabled({ siteValues: { enabled: true } }), true);
		assert.strictEqual(siteValues.enabled({ siteValues: { enabled: false } }), false);
	});

	it('finds sites by scanner name, ignoring case, spacing and known spelling variants', () => {
		assert.strictEqual(siteValues.siteFor({ type: 'gas', name: 'Vital Core Reservoir' }, index).name, 'Vital Core Reservoir');
		assert.strictEqual(siteValues.siteFor({ type: 'gas', name: '  vital  core reservoir ' }, index).name, 'Vital Core Reservoir');
		assert.strictEqual(siteValues.siteFor({ type: 'gas', name: 'Sizable Perimeter Reservoir' }, index).name, 'Sizeable Perimeter Reservoir');
		assert.strictEqual(siteValues.siteFor({ type: 'unknown', name: 'Rarified Core Deposit' }, index).name, 'Rarified Core Deposit');
	});

	it('ignores wormholes, unknown names and missing data', () => {
		assert.strictEqual(siteValues.siteFor({ type: 'wormhole', name: 'Vital Core Reservoir' }, index), null);
		assert.strictEqual(siteValues.siteFor({ type: 'gas', name: 'Bright Nebula' }, index), null);
		assert.strictEqual(siteValues.siteFor({ type: 'gas', name: '' }, index), null);
		assert.strictEqual(siteValues.siteFor({ type: 'gas' }, index), null);
		assert.strictEqual(siteValues.siteFor(null, index), null);
		assert.strictEqual(siteValues.siteFor({ type: 'gas', name: 'Vital Core Reservoir' }, null), null);
		assert.deepStrictEqual(siteValues.index(null), {});
		assert.deepStrictEqual(siteValues.index({ sites: 'x' }), {});
	});

	it('adds up units times price, highest value first, with fallback prices', () => {
		const est = siteValues.estimate(index['vital core reservoir'], data, null);
		assert.strictEqual(est.status, 'verified');
		assert.strictEqual(est.total, 24000 * 50000 + 2000 * 1000);
		assert.deepStrictEqual(est.lines.map(l => l.name), ['Gas B', 'Gas A']);
		assert.strictEqual(est.lines[0].m3, 240000);
		assert.strictEqual(est.live, false);
	});

	it('prefers live prices and says when every price is live', () => {
		const est = siteValues.estimate(index['vital core reservoir'], data, { 1: 2000, 2: 60000 });
		assert.strictEqual(est.total, 24000 * 60000 + 2000 * 2000);
		assert.strictEqual(est.live, true);
		const mixed = siteValues.estimate(index['vital core reservoir'], data, { 2: 60000, 1: 0 });
		assert.strictEqual(mixed.total, 24000 * 60000 + 2000 * 1000);
		assert.strictEqual(mixed.live, false);
	});

	it('prices ore as its compressed form when the type says so', () => {
		const d = Object.assign({}, data, { types: Object.assign({}, data.types, { 3: { name: 'Rock', m3: 16, priceAs: 9 } }) });
		const est = siteValues.estimate(index['rarified core deposit'], d, { 3: 1, 9: 3000 });
		assert.strictEqual(est.total, 100000 * 3000);
		assert.strictEqual(est.lines[0].compressed, true);
		assert.ok(siteValues.tooltip(index['rarified core deposit'], est).indexOf('compressed ore price (each mined unit compresses into one compressed unit)') > 0);
		assert.strictEqual(est.lines[0].price, 3000, 'units x compressed price, no extra division');
		assert.strictEqual(siteValues.estimate(index['rarified core deposit'], d, null).missing[0], 'Rock');
	});

	it('lists items without any price and leaves them out of the total', () => {
		const d = Object.assign({}, data, { fallbackPrices: { prices: { 2: 50000 } } });
		const est = siteValues.estimate(index['vital core reservoir'], d, null);
		assert.strictEqual(est.total, 24000 * 50000);
		assert.deepStrictEqual(est.missing, ['Gas A']);
	});

	it('gives no value for unverified sites or sites without any price', () => {
		assert.strictEqual(siteValues.estimate(index['shattered debris field'], data, null).status, 'unverified');
		assert.strictEqual(siteValues.estimate(index['shattered debris field'], data, null).total, 0);
		const noPrices = Object.assign({}, data, { fallbackPrices: {} });
		assert.strictEqual(siteValues.estimate(index['vital core reservoir'], noPrices, null).status, 'unverified');
		assert.strictEqual(siteValues.estimate(null, data, null).status, 'unverified');
		assert.strictEqual(siteValues.estimate({ name: 'X', status: 'weird', contents: [[1, 5]] }, data, null).status, 'unverified');
	});

	it('formats short ISK amounts', () => {
		assert.strictEqual(siteValues.shortIsk(1.4237e9), '1.4B');
		assert.strictEqual(siteValues.shortIsk(85.4e6), '85M');
		assert.strictEqual(siteValues.shortIsk(8.54e6), '8.5M');
		assert.strictEqual(siteValues.shortIsk(999.9e6), '1B');
		assert.strictEqual(siteValues.shortIsk(850e3), '850k');
		assert.strictEqual(siteValues.shortIsk(900), '900');
		assert.strictEqual(siteValues.shortIsk(0), '0');
		assert.strictEqual(siteValues.shortIsk(NaN), '0');
		assert.strictEqual(siteValues.thousands(1234567.6), '1,234,568');
	});

	it('chip text: ~value, or ? without a value', () => {
		assert.strictEqual(siteValues.chipText(siteValues.estimate(index['vital core reservoir'], data, null)), '~1.2B');
		assert.strictEqual(siteValues.chipText(siteValues.estimate(index['shattered debris field'], data, null)), '?');
		assert.strictEqual(siteValues.chipText(null), '?');
	});

	it('tooltip breaks the value down and escapes text', () => {
		const site = index['vital core reservoir'];
		const tip = siteValues.tooltip(site, siteValues.estimate(site, data, null), '2026-11-15');
		assert.ok(tip.indexOf('Gas B</td><td class="site-value-num">24,000 u') > 0, tip);
		assert.ok(tip.indexOf('&times; 50,000') > 0);
		assert.ok(tip.indexOf('~1.2B ISK') > 0);
		assert.ok(tip.indexOf('of 2026-11-15 (live prices unavailable)') > 0);
		const live = siteValues.tooltip(site, siteValues.estimate(site, data, { 1: 1, 2: 1 }), '2026-11-15');
		assert.ok(live.indexOf('updated hourly.') > 0);
		const mixed = siteValues.tooltip(site, siteValues.estimate(site, data, { 2: 1 }), '2026-11-15');
		assert.ok(mixed.indexOf('updated hourly; Gas A at the price of 2026-11-15 (no live price)') > 0, mixed);
		const ore = index['rarified core deposit'];
		assert.ok(siteValues.tooltip(ore, siteValues.estimate(ore, data, null)).indexOf('Approximate') > 0);
		const odd = index['shattered debris field'];
		const none = siteValues.tooltip(odd, siteValues.estimate(odd, data, null));
		assert.ok(none.indexOf("couldn't be verified") > 0);
		assert.ok(none.indexOf('Old &lt;names&gt;') > 0 && none.indexOf('<names>') < 0);
	});
});

describe('Gas and ore site data (public/site-values/sites.json)', () => {
	const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../public/site-values/sites.json'), 'utf8'));

	it('is valid and names its sources', () => {
		assert.ok(siteValues.valid(data));
		['eveuniGas', 'eveuniOre', 'fuzzworks', 'allout', 'prices'].forEach(k => assert.ok(data.sources[k], k));
	});

	it('has the 9 wormhole gas sites and 11 wormhole ore sites, each with a status and a source page', () => {
		// wormhole sites name their classes; k-space ones (and the W-Space Blue A0 anomaly) say where they spawn
		assert.strictEqual(data.sites.filter(s => s.kind === 'gas' && s.classes).length, 9);
		assert.strictEqual(data.sites.filter(s => s.kind === 'ore' && s.classes).length, 11);
		const names = {};
		data.sites.filter(s => s.kind === 'gas' || s.kind === 'ore').forEach(s => {
			assert.ok(siteValues.STATUSES.indexOf(s.status) >= 0, s.name);
			assert.ok(/^https:\/\/wiki\.eveuniversity\.org\//.test(s.source), s.name);
			[s.name].concat(s.aliases || []).forEach(n => { assert.ok(!names[n.toLowerCase()], 'duplicate ' + n); names[n.toLowerCase()] = true; });
			if (s.status === 'unverified') { assert.ok(s.reason, s.name + ' says why it is unverified'); }
			else {
				// k-space gas sites hold one gas (several clouds of it) and Mercoxit sites one ore; wormhole sites at least two items
				assert.ok(Array.isArray(s.contents) && s.contents.length >= (s.classes ? 2 : 1), s.name);
				s.contents.forEach(([id, units]) => {
					assert.ok(data.types[id], s.name + ': type ' + id);
					// [low, high] when the sources disagree
					const u = Array.isArray(units) ? units : [units, units];
					assert.ok(u.length === 2 && u.every(n => Number.isInteger(n) && n > 0) && u[0] <= u[1], s.name + ': units');
					if (Array.isArray(units)) { assert.ok(u[0] < u[1] && s.status === 'approximate' && s.note, s.name + ': a range is approximate and says why'); }
				});
			}
		});
	});

	it('wormhole gas sites are two clouds of different gas; every type has a volume and a fallback price', () => {
		data.sites.filter(s => s.kind === 'gas' && s.classes).forEach(s => {
			assert.strictEqual(s.contents.length, 2, s.name);
			assert.notStrictEqual(s.contents[0][0], s.contents[1][0], s.name);
		});
		Object.keys(data.types).forEach(id => {
			assert.ok(data.types[id].m3 > 0 || data.types[id].salvage, id);
			assert.ok(data.fallbackPrices.prices[data.types[id].priceAs || id] > 0, 'price of ' + id);
		});
		// every ore is priced as its compressed form
		data.sites.filter(s => s.kind === 'ore' && s.contents).forEach(s => s.contents.forEach(([id]) => assert.ok(data.types[id].priceAs, s.name + ': ' + id)));
	});

	it('gives every verified gas site a value with the stored prices', () => {
		data.sites.filter(s => s.status !== 'unverified' && (s.kind === 'gas' || s.kind === 'ore')).forEach(s => {
			const est = siteValues.estimate(s, data, null);
			assert.ok(est.total > 0 && !est.missing.length, s.name);
		});
	});
});

describe('Relic and data site value', () => {
	const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../public/site-values/sites.json'), 'utf8'));
	const index = siteValues.index(data);
	const site = name => siteValues.siteFor({ type: 'relic', name: name }, index);
	const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ': ' + a + ' vs ' + b);
	const FACTIONS = ['Angel', 'Blood Raider', 'Guristas', 'Sansha', 'Serpentis'];

	it('reproduces the per-container expected units of the drop table (chance x mean stack)', () => {
		const ch = data.relicModel.chances;
		[['rubble', 2.875, 0.11], ['remains', 11.25, 0.375], ['ruins', 0, 2.0]].forEach(([c, t1, t2]) => {
			const u = siteValues.expectedUnits({ [c]: 1 }, ch);
			close(u.t1, t1, c + ' T1');
			close(u.t2, t2, c + ' T2');
		});
	});

	it('reproduces the research expected units per item for each Ruined layout', () => {
		const ch = data.relicModel.chances;
		const want = { 'Monument Site': [39.5, 3.345], 'Temple Site': [36.625, 5.235], 'Science Outpost': [45.0, 5.5], 'Crystal Quarry': [36.625, 7.235] };
		Object.keys(want).forEach(layout => {
			const u = siteValues.expectedUnits(site('Ruined Sansha ' + layout).containers, ch);
			close(u.t1, want[layout][0], layout + ' T1');
			close(u.t2, want[layout][1], layout + ' T2');
		});
		// the spawn-weighted mean matches EVE University's own appraisal recipe (x3945 / x472, divided by 100)
		const share = { 'Monument Site': 0.4, 'Temple Site': 0.3, 'Science Outpost': 0.2, 'Crystal Quarry': 0.1 };
		let t1 = 0, t2 = 0;
		Object.keys(share).forEach(l => { t1 += share[l] * want[l][0]; t2 += share[l] * want[l][1]; });
		close(Math.round(t1 * 100) / 100, 39.45, 'weighted T1');
		assert.strictEqual(Math.round(t2 * 100), 473, 'weighted T2 (wiki rounds to 472)');
	});

	it('values a Ruined site as sum of expected units x price, T2 on T2 types and T1 on T1 types', () => {
		const s = site('Ruined Sansha Monument Site');
		const est = siteValues.estimate(s, data, null);
		assert.strictEqual(est.status, 'estimate');
		assert.strictEqual(est.value, 'model');
		const p = data.fallbackPrices.prices;
		let want = 0;
		data.relicModel.universal.concat(data.relicModel.factions.Sansha).forEach(([t2, t1]) => { want += 3.345 * p[t2] + 39.5 * p[t1]; });
		assert.ok(Math.abs(est.total - want) < 1, est.total + ' vs ' + want);
		close(est.t1Total + est.t2Total, est.total, 'T1 + T2 = total');
		// research table with the stored prices (ESI of 2026-11-21; 26.0M and 22.2M with those of 2026-11-15): Sansha
		// Monument 26.8M, Angel Crystal Quarry 22.2M
		assert.strictEqual(siteValues.shortIsk(est.total), '27M');
		assert.strictEqual(siteValues.chipText(est), '~27M exp.');
		assert.strictEqual((siteValues.estimate(site('Ruined Angel Crystal Quarry'), data, null).total / 1e6).toFixed(1), '22.2');
		assert.strictEqual(est.lines.length, 16, '8 T2 + 8 T1 types');
	});

	it('counts the Serpentis T1-only Malfunctioning Shield Emitter once, with T1 units only', () => {
		const est = siteValues.estimate(site('Ruined Serpentis Temple Site'), data, null);
		const mse = est.lines.filter(l => l.name === 'Malfunctioning Shield Emitter');
		assert.strictEqual(mse.length, 1);
		assert.strictEqual(mse[0].tier, 'T1');
		close(mse[0].units, 36.625, 'units');
		assert.strictEqual(est.lines.length, 17, '8 T2 + 9 T1 types');
	});

	it('uses live prices when known and names the dominant item without capping it', () => {
		const s = site('Ruined Angel Temple Site');
		const live = { 25619: 10e6 };
		const est = siteValues.estimate(s, data, live);
		assert.ok(est.dominant && est.dominant.name === 'Logic Circuit', 'Logic Circuit dominates');
		close(est.dominant.without + 10e6 * 5.235, est.total, 'without = total minus that item');
		assert.strictEqual(est.live, false, 'other items use the stored price');
		const tip = siteValues.tooltip(s, est, '2026-11-15');
		assert.ok(/Logic Circuit is \d+% of this \(~[\d.]+M without it\)/.test(tip), tip);
		assert.ok(tip.indexOf('830k') > 0, 'says what the 2023 price was');
		const sansha = siteValues.estimate(site('Ruined Sansha Temple Site'), data, null);
		assert.strictEqual(sansha.dominant, null, 'no single Sansha item is half the value');
	});

	it('Ruined tooltip gives the T2 and T1 breakdown, what is left out and how sure it is', () => {
		const s = site('Ruined Guristas Science Outpost');
		const tip = siteValues.tooltip(s, siteValues.estimate(s, data, null), '2026-11-15');
		['T2 salvage', 'T1 salvage', 'Expected value', '0 Rubble, 4 Remains and 2 Ruins', 'blueprint copies, carbon and Spatial Attunement Units', 'How sure: medium', 'Enhanced Ward Console'].forEach(t => assert.ok(tip.indexOf(t) >= 0, t));
	});

	it('Rogue Drone Ruined sites, Regional data, ghost sites, Sleeper caches and Silent Battleground show "?" with a reason', () => {
		['Ruined Rogue Drone Monument Site', 'Regional Serpentis Data Fortress', 'Superior Blood Raider Covert Research Facility', 'Lesser Sansha Covert Research Facility',
			'Limited Sleeper Cache', 'Standard Sleeper Cache', 'Superior Sleeper Cache', 'Silent Battleground'].forEach(n => {
			const s = site(n);
			assert.ok(s, n);
			const est = siteValues.estimate(s, data, null);
			assert.strictEqual(siteValues.chipText(est), '?', n);
			const tip = siteValues.tooltip(s, est);
			assert.ok(tip.indexOf('No value shown.') > 0 && s.reason && tip.indexOf(siteValues.escape(s.reason)) > 0, n);
		});
	});

	it('Forgotten sites show Sleeper rat loot, with both figures where the sources disagree', () => {
		const c4 = site('Forgotten Frontier Conversion Module');
		const est = siteValues.estimate(c4, data, null);
		assert.strictEqual(siteValues.chipText(est), '~115M Sleeper loot');
		const tip = siteValues.tooltip(c4, est);
		assert.ok(tip.indexOf('combat loot, not hacking loot') > 0 && tip.indexOf('cans hold is unverified') > 0 && tip.indexOf('Template:Whisk') > 0, tip);
		const c3 = site('Forgotten Frontier Quarantine Outpost');
		assert.strictEqual(siteValues.chipText(siteValues.estimate(c3, data, null)), '~50-77M Sleeper loot');
		assert.ok(siteValues.tooltip(c3, siteValues.estimate(c3, data, null)).indexOf('49.5M') > 0);
		assert.strictEqual(siteValues.chipText(siteValues.estimate(site('Forgotten Frontier Recursive Depot'), data, null)), '~66-93M Sleeper loot');
		assert.strictEqual(siteValues.chipText(siteValues.estimate(site('Forgotten Core Circuitry Disassembler'), data, null)), '~658M Sleeper loot');
	});

	it('Central, Local, Decayed and Crumbling sites show a dated rough range (dashed)', () => {
		const want = { 'Central Guristas Survey Site': '~5-15M', 'Local Serpentis Mainframe': '~2-4M', 'Decayed Blood Raider Mass Grave': '~1-10M', 'Crumbling Angel Excavation': '<2M' };
		Object.keys(want).forEach(n => {
			const s = site(n);
			const est = siteValues.estimate(s, data, null);
			assert.strictEqual(est.status, 'approximate', n);
			assert.strictEqual(siteValues.chipText(est), want[n], n);
			const tip = siteValues.tooltip(s, est);
			assert.ok(tip.indexOf('How sure: low') > 0 && /20\d\d/.test(s.sourceDate) && tip.indexOf(siteValues.escape(s.sourceDate)) > 0, n);
		});
		assert.ok(siteValues.tooltip(site('Central Sansha Command Center'), siteValues.estimate(site('Central Sansha Command Center'), data, null)).indexOf('typically ~8M') > 0);
	});

	it('matches every scanner name of every family and faction, ignoring case and spacing', () => {
		const fams = { Ruined: ['Monument Site', 'Temple Site', 'Science Outpost', 'Crystal Quarry'],
			Decayed: ['Excavation', 'Particle Accelerator', 'Collision Site', 'Mass Grave', 'Lone Vessel', 'Rock Formation', 'Mining Installation', 'Quarry'],
			Crumbling: ['Antiquated Outpost', 'Excavation', 'Crystal Quarry', 'Solar Harvesters', 'Explosive Debris', 'Stone Formation', 'Abandoned Colony', 'Mining Installation'],
			Central: ['Sparking Transmitter', 'Survey Site', 'Command Center', 'Data Mining Site'],
			Regional: ['Data Fortress', 'Mainframe', 'Command Center', 'Data Processing Center', 'Data Mining Site', 'Data Terminal', 'Backup Server', 'Secure Server'],
			Local: ['Mainframe', 'Virus Test Site', 'Data Processing Center', 'Shattered Life-Support Unit', 'Data Terminal', 'Production Installation', 'Backup Server', 'Minor Shipyard'] };
		Object.keys(fams).forEach(prefix => FACTIONS.forEach(f => fams[prefix].forEach(l => {
			const n = prefix + ' ' + f + ' ' + l;
			const s = site(n);
			assert.ok(s && s.name === n && s.faction === f, n);
			assert.ok(site('  ' + n.toLowerCase().replace(/ /g, '  ') + ' '), n + ' (spacing)');
		})));
		['Ruined Angel Monument Site', 'Ruined Blood Raider Temple Site'].forEach(n => assert.strictEqual(siteValues.estimate(site(n), data, null).value, 'model', n));
		['Perimeter Coronation Platform', 'Perimeter Power Array', 'Perimeter Gateway', 'Perimeter Habitation Coils', 'Frontier Quarantine Outpost', 'Frontier Recursive Depot',
			'Frontier Conversion Module', 'Frontier Evacuation Center', 'Core Data Field', 'Core Information Pen', 'Core Assembly Hall', 'Core Circuitry Disassembler'].forEach(n => {
			const est = siteValues.estimate(site('Forgotten ' + n), data, null);
			assert.strictEqual(est.value, 'combat', n);
			assert.ok(est.low > 0, n);
		});
		// every non-"?" relic/data site has a value
		Object.keys(index).forEach(k => {
			const s = index[k];
			if ((s.kind === 'relic' || s.kind === 'data') && s.status !== 'unverified') { assert.ok(siteValues.estimate(s, data, null).total > 0, s.name); }
		});
		assert.strictEqual(site('Ruined Angel Monument'), null, 'no partial names');
		assert.strictEqual(site('Ruined Amarr Monument Site'), null, 'no empire factions');
	});

	it('never gives a chip to wormhole Unsecured data sites', () => {
		['Unsecured Perimeter Amplifier', 'Unsecured Perimeter Information Center', 'Unsecured Frontier Database', 'Unsecured Frontier Receiver',
			'Unsecured Frontier Digital Nexus', 'Unsecured Frontier Trinary Hub', 'Unsecured Frontier Enclave Relay', 'Unsecured Frontier Server Bank',
			'Unsecured Core Backup Array', 'Unsecured Core Emergence', 'unsecured  frontier database'].forEach(n => {
			assert.strictEqual(siteValues.siteFor({ type: 'data', name: n }, index), null, n);
		});
		assert.ok(siteValues.excluded('Unsecured Frontier Database', data));
		assert.ok(!siteValues.excluded('Unsecuredness', data));
		// even a site the data happened to name would be dropped
		const d = Object.assign({}, data, { sites: data.sites.concat([{ name: 'Unsecured Core Emergence', kind: 'data', status: 'approximate', value: 'range', range: [1, 2] }]) });
		assert.strictEqual(siteValues.siteFor({ type: 'data', name: 'Unsecured Core Emergence' }, siteValues.index(d)), null);
		assert.ok(Object.keys(index).every(k => k.indexOf('unsecured') !== 0));
	});

	it('every relic/data figure carries a source that the data names, and a date', () => {
		const all = data.families.concat(data.sites.filter(s => s.kind === 'relic' || s.kind === 'data'));
		all.forEach(s => {
			const id = s.name || s.prefix || s.suffix;
			assert.ok(data.sources[s.source], id + ' source');
			assert.ok(siteValues.STATUSES.indexOf(s.status) >= 0, id);
			if (s.status === 'unverified') { assert.ok(s.reason, id + ' reason'); return; }
			assert.ok(s.value === 'model' || /20\d\d/.test(s.sourceDate || ''), id + ' date');
		});
		assert.ok(data.sources[data.relicModel.source] && /20\d\d/.test(data.relicModel.sourceNote));
		// every salvage type of the model is a type with a stored price (the server fetches every type in types)
		const ids = [].concat.apply([], data.relicModel.universal.concat(...Object.values(data.relicModel.factions))).filter(id => id !== null);
		assert.strictEqual(new Set(ids).size, 38);
		ids.forEach(id => { assert.ok(data.types[id] && data.types[id].salvage, 'type ' + id); assert.ok(data.fallbackPrices.prices[id] > 0, 'price ' + id); });
	});

	it('formats ranges', () => {
		assert.strictEqual(siteValues.rangeIsk(1e6, 10e6), '1-10M');
		assert.strictEqual(siteValues.rangeIsk(500e3, 2e6), '500k-2M');
		assert.strictEqual(siteValues.rangeIsk(0, 2e6), '<2M');
		assert.strictEqual(siteValues.rangeIsk(115e6, 115e6), '115M');
		assert.strictEqual(siteValues.units(3.345), '3.3');
		assert.strictEqual(siteValues.units(39.5), '40');
	});

	it('escapes data text in relic tooltips', () => {
		const s = { name: 'X <b>', kind: 'data', status: 'unverified', reason: '<i>why</i>' };
		const tip = siteValues.tooltip(s, siteValues.estimate(s, data, null));
		assert.ok(tip.indexOf('<i>') < 0 && tip.indexOf('X &lt;b&gt;') > 0);
	});
});

describe('K-space gas and ore site value', () => {
	const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../public/site-values/sites.json'), 'utf8'));
	const index = siteValues.index(data);
	const kspace = data.sites.filter(s => (s.kind === 'gas' || s.kind === 'ore') && !s.classes);
	const MYKO = ['Sister', 'Helix', 'Wild', 'Blackeye', 'Sunspark', 'Diablo', 'Smoking', 'Ring', 'Calabash', 'Glass', 'Bright', 'Sparking', 'Ghost', 'Eagle', 'Flame', 'Pipe'];
	const CYTO = ['Emerald', 'Cheetah', 'Duo', 'Leopard', 'Rimy', 'Crimson', 'Cobra', 'Crab Spider', 'Hazy', 'Hidden', 'Whirling', 'Bandit', 'Fluttering',
		'Rocky', 'Dewy', 'Foggy', 'Shimmering', 'Spacious', 'Profiteer', 'Moth', 'Swarm', 'Lion', 'Shiny', 'Gaseous', 'Phoenix', 'Flowing', 'Thick', 'Diamond',
		'Massive', 'Peacock', 'Forgotten', 'Frosty', 'Goose', 'Icy', 'Pale', 'Polar Bear', 'Rapture', 'Crystal', 'Snowy Owl', 'Arctic Fox', 'Glistening',
		'Murky', 'Saintly', 'Boisterous', 'Cardinal', 'Red Dragonfly', 'Wispy'];
	const gasName = id => data.types[id].name;

	it('values the two nebulae of the request (low-sec Essence): Bright Nebula and Calabash Nebula', () => {
		[['Bright Nebula', 28701, 'Viridian Mykoserocin'], ['Calabash Nebula', 28696, 'Celadon Mykoserocin']].forEach(([name, id, gas]) => {
			const site = siteValues.siteFor({ type: 'gas', name: name }, index);
			assert.ok(site, name);
			const est = siteValues.estimate(site, data, null);
			assert.strictEqual(est.status, 'verified');
			assert.strictEqual(est.total, 2000 * data.fallbackPrices.prices[id], name + ': 2 clouds of 1,000 units');
			assert.strictEqual(est.lines[0].name, gas);
			assert.ok(/^~\d/.test(siteValues.chipText(est)), siteValues.chipText(est));
			assert.strictEqual(siteValues.estimate(site, data, { [id]: 100000 }).total, 2000 * 100000, 'live price');
		});
	});

	it('covers every Mykoserocin and Cytoserocin nebula, each with one booster gas and a value', () => {
		MYKO.concat(CYTO).forEach(w => {
			const site = siteValues.siteFor({ type: 'gas', name: w + ' Nebula' }, index);
			assert.ok(site, w + ' Nebula');
			assert.strictEqual(site.contents.length, 1, w);
			assert.ok(/(Myko|Cyto)serocin$/.test(gasName(site.contents[0][0])), w);
			assert.ok(siteValues.estimate(site, data, null).total > 0, w + ' has a value');
			assert.ok(site.where && site.note && site.sourceDate, w + ' says where, what and when');
		});
		assert.strictEqual(kspace.filter(s => s.kind === 'gas').length, MYKO.length + CYTO.length);
		// Sunspark and Pipe: their pages ask for the quantities to be reviewed after 19.11, so approximate
		MYKO.forEach(w => assert.strictEqual(index[siteValues.key(w + ' Nebula')].status, ['Sunspark', 'Pipe'].indexOf(w) >= 0 ? 'approximate' : 'verified', w));
		['sunspark nebula', 'pipe nebula'].forEach(k => assert.ok(index[k].note.indexOf('asks for its quantities to be reviewed') > 0, k));
		CYTO.forEach(w => assert.strictEqual(index[siteValues.key(w + ' Nebula')].status, 'approximate', w));
		MYKO.forEach(w => assert.ok(/Mykoserocin$/.test(gasName(index[siteValues.key(w + ' Nebula')].contents[0][0])), w));
	});

	it('shows both figures when the sources disagree, as a range', () => {
		const site = index['gaseous nebula'];
		const est = siteValues.estimate(site, data, { 25273: 30000 });
		assert.strictEqual(est.range, true);
		assert.strictEqual(est.low, 9000 * 30000);
		assert.strictEqual(est.total, 18000 * 30000);
		assert.strictEqual(siteValues.chipText(est), '~270-540M');
		const tip = siteValues.tooltip(site, est, '2026-11-21');
		assert.ok(tip.indexOf('9,000-18,000 u') > 0, tip);
		assert.ok(tip.indexOf('~270-540M ISK') > 0, tip);
		assert.ok(tip.indexOf('disagrees') > 0 && tip.indexOf('December 2021') > 0, tip);
	});

	it('gas notes say only what the sources say', () => {
		// Red Dragonfly: table 18,000; the page's walkthrough one cloud of 9,000 (before the 19.11 doubling)
		assert.deepStrictEqual(index['red dragonfly nebula'].contents[0][1], [9000, 18000]);
		// Moth Nebula has no page: the gas table is its source
		assert.strictEqual(index['moth nebula'].source, 'https://wiki.eveuniversity.org/Gas_cloud_harvesting#Cytoserocin');
		assert.strictEqual(index['moth nebula'].sourceDate, 'gas table of 2026-11-08');
		// deadspace only where the page says so; regions from the table and the page
		assert.ok(index['bright nebula'].note.indexOf('deadspace') < 0, 'Bright: page says "?"');
		assert.ok(index['calabash nebula'].note.indexOf('Not in deadspace') >= 0);
		['Essence', 'Syndicate', 'Outer Ring'].forEach(r => assert.ok(index['calabash nebula'].note.indexOf(r) > 0, 'Calabash in ' + r));
		// cloud damage: a figure only where the gas table and the page agree
		assert.ok(index['leopard nebula'].note.indexOf('1400 explosive damage in its gas table and 700 thermal on the site page') > 0, index['leopard nebula'].note);
		assert.ok(index['duo nebula'].note.indexOf('for 1000 EM + 1000 thermal damage') > 0, index['duo nebula'].note);
	});

	it('k-space gas tooltips: their own notes, no wormhole Sleeper note, raw gas price', () => {
		const site = index['bright nebula'];
		const tip = siteValues.tooltip(site, siteValues.estimate(site, data, null), data.fallbackPrices.date);
		assert.ok(tip.indexOf('(gas, high, low and null-sec)') > 0, tip);
		assert.ok(tip.indexOf('2 clouds of 1,000 units') > 0 && tip.indexOf('Essence') > 0, tip);
		assert.ok(tip.indexOf('Sleepers') < 0, 'no Sleepers in k-space');
		assert.ok(tip.indexOf('raw gas price') > 0);
		assert.ok(tip.indexOf('Contents: EVE University wiki (gas table of 2026-11-08') > 0, tip);
		const wh = index['vital core reservoir'];
		const whTip = siteValues.tooltip(wh, siteValues.estimate(wh, data, null), data.fallbackPrices.date);
		assert.ok(whTip.indexOf('Sleepers usually arrive') > 0 && whTip.indexOf('raw gas price') < 0, 'wormhole gas tooltip unchanged');
	});

	it('pasted ore anomalies (bookmark "anomaly") and ore signatures get the chip', () => {
		const anomaly = siteValues.siteFor({ type: 'ore', bookmark: 'anomaly', name: 'Average Jaspet Deposit' }, index);
		assert.ok(anomaly);
		const est = siteValues.estimate(anomaly, data, null);
		assert.strictEqual(est.status, 'approximate');
		assert.ok(est.total > 0 && !est.missing.length);
		const tip = siteValues.tooltip(anomaly, est, data.fallbackPrices.date);
		assert.ok(tip.indexOf('from one EVE University page (usually one player') > 0 && tip.indexOf('compressed ore price') > 0, tip);
		assert.ok(siteValues.siteFor({ type: 'ore', name: 'Hidden Gneiss Deposit' }, index), 'signature');
		assert.ok(siteValues.siteFor({ type: 'unknown', bookmark: 'anomaly', name: 'Large Hezorime Deposit' }, index), 'any type');
	});

	it('every k-space ore site says where it spawns; ore variants are priced as their own compressed grade', () => {
		kspace.filter(s => s.kind === 'ore').forEach(s => {
			assert.ok(s.where && s.status, s.name);
			if (s.status !== 'unverified') { assert.ok(/^page of \d{4}-\d{2}-\d{2}$/.test(s.sourceDate), s.name); }
		});
		Object.keys(data.types).filter(id => / (II|III|IV)-Grade$/.test(data.types[id].name)).forEach(id => {
			const t = data.types[id];
			assert.ok(t.priceAs && t.priceAs !== Number(id), t.name);
		});
		// Arkonor III-Grade (formerly Prime Arkonor) -> Compressed Arkonor III-Grade
		assert.strictEqual(data.types['17426'].name, 'Arkonor III-Grade');
		assert.strictEqual(data.types['17426'].priceAs, 62570);
	});

	it('fills the Shattered Debris Field now its old ore names map to today\'s grades; Infrequent Core Deposit stays unverified', () => {
		const sdf = index['shattered debris field'];
		assert.strictEqual(sdf.status, 'approximate');
		const est = siteValues.estimate(sdf, data, null);
		assert.ok(est.total > 0 && est.lines.length === 9 && !est.missing.length);
		assert.ok(est.lines.some(l => l.name === 'Arkonor III-Grade' && l.units === 250000));
		assert.strictEqual(index['infrequent core deposit'].status, 'unverified');
	});

	it('gives "?" with the reason to known sites without usable figures', () => {
		// Small Kernite and Omber / Average Omber: back with Catalyst, and their pages say the numbers still need checking
		['Enormous Mercoxit Deposit', 'Large Griemeer Deposit', 'Small Omber Deposit', 'Small Kernite and Omber Deposit', 'Average Omber Deposit'].forEach(n => {
			const s = index[siteValues.key(n)];
			assert.strictEqual(s.status, 'unverified', n);
			assert.ok(s.reason, n);
			assert.strictEqual(siteValues.chipText(siteValues.estimate(s, data, null)), '?');
		});
	});
});

describe('Site value ranges (contents [typeID, [low, high]])', () => {
	const data = { types: { 1: { name: 'Gas', m3: 10 } }, fallbackPrices: { prices: { 1: 1000 } }, sites: [] };

	it('adds up low and high, and ignores a reversed or broken range', () => {
		const est = siteValues.estimate({ name: 'N', kind: 'gas', status: 'approximate', contents: [[1, [500, 1000]]] }, data, null);
		assert.deepStrictEqual([est.low, est.total, est.range], [500000, 1000000, true]);
		assert.strictEqual(siteValues.chipText(est), '~500k-1M');
		const one = siteValues.estimate({ name: 'N', kind: 'gas', status: 'approximate', contents: [[1, 700]] }, data, null);
		assert.deepStrictEqual([one.low, one.total, one.range], [700000, 700000, false]);
		assert.strictEqual(siteValues.chipText(one), '~700k');
		assert.strictEqual(siteValues.estimate({ name: 'N', status: 'approximate', contents: [[1, [1000, 500]]] }, data, null).status, 'unverified');
		assert.strictEqual(siteValues.estimate({ name: 'N', status: 'approximate', contents: [[1, [0, 500]]] }, data, null).status, 'unverified');
	});
});
