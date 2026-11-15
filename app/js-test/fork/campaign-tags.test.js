const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/campaign-tags');

describe('Campaign and Fabricator tags', () => {
	it('is on unless switched off', () => {
		assert.strictEqual(campaignTags.enabled(undefined), true);
		assert.strictEqual(campaignTags.enabled({ campaignTags: {} }), true);
		assert.strictEqual(campaignTags.enabled({ campaignTags: { enabled: false } }), false);
	});

	it('finds the sites by CCP\'s names, whatever their type, ignoring case and spacing', () => {
		assert.strictEqual(campaignTags.siteFor({ type: 'combat', name: 'Rampant Drone Fabricator' }).kind, 'fabricator');
		assert.strictEqual(campaignTags.siteFor({ type: 'unknown', name: ' rogue drone  fabricator' }).kind, 'fabricator');
		assert.strictEqual(campaignTags.siteFor({ type: 'data', name: 'Collapsed Drifter Cache' }).tag, 'Campaign');
		assert.strictEqual(campaignTags.siteFor({ type: 'relic', name: 'Fabricated Rogue Cache' }).tag, 'Campaign');
	});

	it('ignores wormholes, other sites, containers and missing names', () => {
		assert.strictEqual(campaignTags.siteFor({ type: 'wormhole', name: 'Rampant Drone Fabricator' }), null);
		assert.strictEqual(campaignTags.siteFor({ type: 'data', name: 'Omega Logging' }), null);	// a container, not a site
		assert.strictEqual(campaignTags.siteFor({ type: 'data', name: 'Unsecured Frontier Database' }), null);
		assert.strictEqual(campaignTags.siteFor({ type: 'data', name: '' }), null);
		assert.strictEqual(campaignTags.siteFor({ type: 'data' }), null);
		assert.strictEqual(campaignTags.siteFor(null), null);
	});

	it('uses CCP\'s Rampancy table and thresholds', () => {
		const pts = {};
		campaignTags.RAMPANCY.forEach(r => { pts[r.label] = r.points; });
		assert.deepStrictEqual(pts, {
			'Capital (other)': 72, 'Force Auxiliary': 36, 'Marauder': 12, 'Black Ops': 8, 'Battleship (other)': 6,
			'Strategic Cruiser': 4, 'Command Ship': 3, 'Battlecruiser (other)': 2, 'Heavy Assault Cruiser': 2,
			'Logistics Cruiser': 2, 'Cruiser (other)': 1
		});
		assert.deepStrictEqual(campaignTags.THRESHOLDS, [12, 36, 72]);
	});

	it('adds up Rampancy and finds the escalation', () => {
		assert.deepStrictEqual(campaignTags.rampancy({}), { points: 0, escalation: 0, next: 12 });
		assert.deepStrictEqual(campaignTags.rampancy({ battleship: 1, hac: 2, logi: 1 }), { points: 12, escalation: 1, next: 36 });
		assert.deepStrictEqual(campaignTags.rampancy({ marauder: 2, battleship: 2 }), { points: 36, escalation: 2, next: 72 });
		assert.deepStrictEqual(campaignTags.rampancy({ capital: 1 }), { points: 72, escalation: 3, next: null });
		assert.deepStrictEqual(campaignTags.rampancy({ cruiser: 11 }), { points: 11, escalation: 0, next: 12 });
	});

	it('ignores bad counts and unknown ship classes', () => {
		assert.strictEqual(campaignTags.rampancy({ cruiser: -3, hac: 'x', frigate: 10, t3c: 2.7 }).points, 8);
		assert.strictEqual(campaignTags.rampancy(null).points, 0);
	});

	it('describes the result', () => {
		assert.strictEqual(campaignTags.rampancyText({ points: 14, escalation: 1, next: 36 }),
			'Rampancy 14: first escalation (the old battleship escalation); next escalation at 36.');
		assert.strictEqual(campaignTags.rampancyText({ points: 80, escalation: 3, next: null }),
			'Rampancy 80: final escalation (the old capital escalation).');
	});

	it('tooltips: the Fabricator; caches say more in C1-C3', () => {
		const fab = campaignTags.tooltip(campaignTags.SITES[0], 5);
		assert.ok(fab.indexOf('100 waves') > 0 && fab.indexOf('12, 36, 72 Rampancy') > 0 && fab.indexOf('Click the tag') > 0);
		const cache = campaignTags.SITES[1];
		assert.ok(campaignTags.tooltip(cache, 2).indexOf('This is a C2 wormhole') > 0);
		assert.ok(campaignTags.tooltip(cache, 5).indexOf('This is a') < 0);
		assert.ok(campaignTags.tooltip(cache, null).indexOf('are in C1-C3 wormholes') > 0);
		assert.strictEqual(campaignTags.tooltip(null, 1), '');
	});
});
