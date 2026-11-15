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

	it('has the 9 wormhole gas sites and 11 ore sites, each with a status and a source page', () => {
		assert.strictEqual(data.sites.filter(s => s.kind === 'gas').length, 9);
		assert.strictEqual(data.sites.filter(s => s.kind === 'ore').length, 11);
		const names = {};
		data.sites.forEach(s => {
			assert.ok(siteValues.STATUSES.indexOf(s.status) >= 0, s.name);
			assert.ok(/^https:\/\/wiki\.eveuniversity\.org\//.test(s.source), s.name);
			[s.name].concat(s.aliases || []).forEach(n => { assert.ok(!names[n.toLowerCase()], 'duplicate ' + n); names[n.toLowerCase()] = true; });
			if (s.status === 'unverified') { assert.ok(s.reason, s.name + ' says why it is unverified'); }
			else {
				assert.ok(Array.isArray(s.contents) && s.contents.length >= 2, s.name);
				s.contents.forEach(([id, units]) => {
					assert.ok(data.types[id], s.name + ': type ' + id);
					assert.ok(Number.isInteger(units) && units > 0, s.name + ': units');
				});
			}
		});
	});

	it('gas sites are two clouds of different gas; every type has a volume and a fallback price', () => {
		data.sites.filter(s => s.kind === 'gas').forEach(s => {
			assert.strictEqual(s.contents.length, 2, s.name);
			assert.notStrictEqual(s.contents[0][0], s.contents[1][0], s.name);
		});
		Object.keys(data.types).forEach(id => {
			assert.ok(data.types[id].m3 > 0, id);
			assert.ok(data.fallbackPrices.prices[data.types[id].priceAs || id] > 0, 'price of ' + id);
		});
		// every ore is priced as its compressed form
		data.sites.filter(s => s.kind === 'ore' && s.contents).forEach(s => s.contents.forEach(([id]) => assert.ok(data.types[id].priceAs, s.name + ': ' + id)));
	});

	it('gives every verified gas site a value with the stored prices', () => {
		data.sites.filter(s => s.status !== 'unverified').forEach(s => {
			const est = siteValues.estimate(s, data, null);
			assert.ok(est.total > 0 && !est.missing.length, s.name);
		});
	});
});
