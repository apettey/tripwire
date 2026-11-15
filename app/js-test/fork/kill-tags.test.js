const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('app/js/fork/kill-tags');
include('app/js/fork/system-killfeed');
include('app/js/fork/chain-killfeed');
include('app/js/fork/fight-now');

const fixtures = loadJSON('app/js-test/testdata/kill-tags-killmails');
const types = loadJSON('public/intel/types');

/** Type IDs of these groups in the static type data, sorted */
const groupTypes = (groups) => Object.keys(types.types).filter(id => groups.includes(Number(types.types[id][1]))).map(Number).sort((a, b) => a - b);

describe('Kill tags', () => {
	describe('classify (killmail fixtures)', () => {
		fixtures.cases.forEach(c => {
			it(c.name, () => {
				assert.deepStrictEqual(killTags.classify(c.kill, c.security), c.expected);
			});
		});

		it('knows which kills carry the tag facts', () => {
			assert.strictEqual(killTags.hasFacts({ attackerShips: [16240] }), true);
			assert.strictEqual(killTags.hasFacts({ attackerShips: [], locationID: 40009087 }), true);
			assert.strictEqual(killTags.hasFacts({ attackerShips: [], locationID: null }), false);
			assert.strictEqual(killTags.hasFacts({}), false);
			assert.strictEqual(killTags.hasFacts(null), false);
		});

		it('copes with missing or junk data', () => {
			assert.deepStrictEqual(killTags.classify(null, null), ['npc']);
			assert.deepStrictEqual(killTags.classify({ attackerCount: 3, attackerShips: 'x', attackerWeapons: null, locationID: 'gate' }, 'high'), []);
			assert.deepStrictEqual(killTags.classify({ attackerCount: '2', locationID: '50000001' }, 0.9), ['gatecamp']);
		});

		it('lists every tag in TAGS order with a label and a tooltip', () => {
			const keys = killTags.TAGS.map(t => t.key);
			assert.deepStrictEqual(keys, ['gatecamp', 'bubble', 'smartbomb', 'gank', 'solo', 'awox', 'npc']);
			killTags.TAGS.forEach(t => assert.ok(t.text && t.label && t.tip, t.key));
			fixtures.cases.forEach(c => {
				const got = killTags.classify(c.kill, c.security);
				assert.deepStrictEqual(got, keys.filter(k => got.includes(k)), c.name + ': order');
			});
		});
	});

	describe('type lists match the static data', () => {
		it('bubble hulls are the Interdictors and HICs in public/intel/types.json', () => {
			assert.deepStrictEqual(killTags.BUBBLE_HULLS.slice().sort((a, b) => a - b), groupTypes([541, 894]));
		});
		it('unarmed hulls are the industrial, mining, shuttle and expedition hulls in public/intel/types.json', () => {
			assert.deepStrictEqual(killTags.UNARMED_HULLS.slice().sort((a, b) => a - b), groupTypes([28, 380, 1202, 513, 902, 463, 543, 941, 1283, 31]));
		});
		it('smartbombs: unique IDs, no ship among them', () => {
			assert.strictEqual(new Set(killTags.SMARTBOMBS).size, killTags.SMARTBOMBS.length);
			killTags.SMARTBOMBS.forEach(id => assert.ok(!types.types[String(id)], id + ' is a ship / known type, not a smartbomb'));
		});
	});

	describe('enabled', () => {
		it('is on unless explicitly false', () => {
			assert.strictEqual(killTags.enabled(undefined), true);
			assert.strictEqual(killTags.enabled({ killTags: {} }), true);
			assert.strictEqual(killTags.enabled({ killTags: { enabled: false } }), false);
		});
	});

	describe('filter and counts', () => {
		const rows = [{ tags: ['gatecamp', 'bubble'] }, { tags: ['solo'] }, { tags: ['gatecamp'] }, { tags: [] }, { tags: null }];
		it('counts kills per tag', () => {
			assert.deepStrictEqual(killTags.counts(rows), { gatecamp: 2, bubble: 1, solo: 1 });
			assert.deepStrictEqual(killTags.counts(null), {});
		});
		it('filters by tag, all for none', () => {
			assert.strictEqual(killTags.filter(rows, 'gatecamp').length, 2);
			assert.strictEqual(killTags.filter(rows, '').length, 5);
			assert.strictEqual(killTags.filter(rows, 'awox').length, 0);
		});
		it('filter bar: All plus the tags that occur, the selected one marked', () => {
			const html = killTags.filterHtml(killTags.counts(rows), 5, 'solo');
			assert.ok(html.indexOf("data-killtag=''") > 0 && html.indexOf('All') > 0);
			assert.ok(html.indexOf("data-killtag='gatecamp'") > 0 && html.indexOf("data-killtag='bubble'") > 0);
			assert.ok(html.indexOf("data-killtag='awox'") < 0, 'no chip for a tag nobody has');
			assert.match(html, /class='kill-filter active kill-tag-solo'/);
			assert.match(html, /Gate camp <span class='kill-filter-n'>2<\/span>/);
		});
		it('keeps a selected tag that has no kills, so it can be cleared', () => {
			const html = killTags.filterHtml({ solo: 1 }, 1, 'awox');
			assert.match(html, /kill-filter active kill-tag-awox/);
			assert.match(html, /Awox <span class='kill-filter-n'>0<\/span>/);
		});
		it('no bar when no kill has a tag', () => {
			assert.strictEqual(killTags.filterHtml({}, 3, ''), '');
		});
	});

	describe('windows', () => {
		it('looks up a window, the default for unknown keys', () => {
			assert.strictEqual(killTags.window('1h').seconds, 3600);
			assert.strictEqual(killTags.window('7d').seconds, 604800);
			assert.strictEqual(killTags.window('nope').key, '24h');
			assert.strictEqual(killTags.window(null).seconds, 86400);
		});
		it('collapses windows longer than the server keeps kills into one labelled with the retention', () => {
			assert.deepStrictEqual(killTags.windows(172800).map(w => w.text), ['1h', '24h', '48h']);
			assert.deepStrictEqual(killTags.windows(604800).map(w => w.text), ['1h', '24h', '7d']);
			assert.deepStrictEqual(killTags.windows(86400).map(w => w.text), ['1h', '24h']);
			assert.deepStrictEqual(killTags.windows(30 * 3600).map(w => w.text), ['1h', '24h', '30h']);
			assert.deepStrictEqual(killTags.windows(3600).map(w => w.text), ['1h']);
			assert.deepStrictEqual(killTags.windows(120 * 3600).map(w => w.text), ['1h', '24h', '5d']);
			assert.deepStrictEqual(killTags.windows(null).map(w => w.text), ['1h', '24h', '7d']);
			const clamped = killTags.windows(172800)[2];
			assert.deepStrictEqual([clamped.key, clamped.seconds], ['7d', 172800]);
			assert.match(clamped.tip, /48h \(all this server keeps\)/);
		});
		it('marks the clamped button when the picked window is longer than the retention', () => {
			const html = killTags.windowHtml('7d', 172800);
			assert.match(html, /class='kill-window active' data-killwindow='7d'[^>]*>48h<\/a>/);
			assert.strictEqual((html.match(/kill-window active/g) || []).length, 1);
			assert.ok(html.indexOf('>7d<') < 0);
			assert.match(killTags.windowHtml('24h', 172800), /class='kill-window active' data-killwindow='24h'/);
		});
		it('window buttons mark the selected one', () => {
			const html = killTags.windowHtml('1h');
			assert.match(html, /class='kill-window active' data-killwindow='1h'/);
			assert.strictEqual((html.match(/kill-window active/g) || []).length, 1);
		});
	});

	describe('in the kill feeds', () => {
		const response = { pastSeconds: 86400, feed: { enabled: true, caughtUp: true }, complete: true,
			kills: fixtures.cases.slice(0, 4).map(c => c.kill), names: { '92000001': 'Kaela <b>Voss</b>' } };

		it('rows carry their tags; chips are escaped text with tooltips', () => {
			const rows = systemKillFeed.buildRows(response);
			assert.deepStrictEqual(rows[0].tags.slice(0, 2), ['gatecamp', 'bubble']);
			const html = systemKillFeed.rowHtml(rows[0], Date.parse('2026-11-15T10:05:00Z'));
			assert.match(html, /<span class='skf-nameline'><span class='skf-name'>Kaela &lt;b&gt;Voss&lt;\/b&gt;<\/span><span class='kill-tags'>/);
			assert.match(html, /class='kill-tag kill-tag-gatecamp' data-tooltip='Gate camp: killed next to a stargate'>Gate<\/span>/);
		});

		it('no tags while they are off: rows as before', () => {
			global.options = { killTags: { enabled: false } };
			try {
				const rows = systemKillFeed.buildRows(response);
				assert.strictEqual(rows[0].tags, null);
				assert.ok(systemKillFeed.rowHtml(rows[0], 0).indexOf('kill-tag') < 0);
				assert.ok(systemKillFeed.rowHtml(rows[0], 0).indexOf('skf-nameline') < 0);
			} finally { delete global.options; }
		});

		it('body: filter bar and the rows of the selected tag', () => {
			const model = systemKillFeed.viewModel(response);
			const html = systemKillFeed.bodyHtml(model, 0, '', 'solo');
			assert.ok(html.indexOf("<div class='kill-filters'>") === 0);
			assert.strictEqual((html.match(/class='skf-row/g) || []).length, 1);
			assert.strictEqual((systemKillFeed.bodyHtml(model, 0, '', '').match(/class='skf-row/g) || []).length, 4);
			assert.ok(systemKillFeed.bodyHtml(model, 0, '').indexOf('kill-filters') < 0, 'no bar without a filter');
		});

		it('body: a selected tag with no kills says so', () => {
			const html = systemKillFeed.bodyHtml(systemKillFeed.viewModel(response), 0, '', 'awox');
			assert.match(html, /No Awox kills among these\./);
		});
	});
});

describe('Fight now', () => {
	it('is on unless explicitly false', () => {
		assert.strictEqual(fightNow.enabled(undefined), true);
		assert.strictEqual(fightNow.enabled({ fightNow: { enabled: false } }), false);
	});

	it('never marks high-sec (the Chain kill feed rule): J-space, low, null and Pochven yes', () => {
		assert.strictEqual(fightNow.isHighsec({ class: null, security: 0.946 }), true);
		assert.strictEqual(fightNow.isHighsec({ class: null, baseSecurity: 0.45 }), true);
		assert.strictEqual(fightNow.isHighsec({ class: null, security: 0.44 }), false);
		assert.strictEqual(fightNow.isHighsec({ class: 5, security: -0.99 }), false);
		assert.strictEqual(fightNow.isHighsec({ class: null, factionID: 500026, security: 0.6 }), false);
		assert.strictEqual(fightNow.isHighsec(null), false);
	});

	it('links to zKillboard related kills for the system and hour (UTC)', () => {
		assert.strictEqual(fightNow.relatedURL(30001161, '2026-11-05T09:41:57Z'), 'https://zkillboard.com/related/30001161/202611050900/');
		assert.strictEqual(fightNow.relatedURL('31002479', '2026-12-31T23:59:59Z'), 'https://zkillboard.com/related/31002479/202612312300/');
		assert.strictEqual(fightNow.relatedURL(0, '2026-11-05T09:41:57Z'), null);
		assert.strictEqual(fightNow.relatedURL(30001161, 'nope'), null);
	});

	it('marks systems with 2 or more player kills', () => {
		const marks = fightNow.marks({ systems: {
			30001161: { kills: 4, lastKill: '2026-11-15T10:12:00Z' },
			31002479: { kills: 2, lastKill: '2026-11-15T09:59:00Z' },
			30002813: { kills: 1, lastKill: '2026-11-15T10:00:00Z' },
			30000142: { kills: 5, lastKill: null }
		} });
		assert.deepStrictEqual(Object.keys(marks).sort(), ['30001161', '31002479']);
		assert.strictEqual(marks[31002479].url, 'https://zkillboard.com/related/31002479/202611150900/');
		assert.deepStrictEqual(fightNow.marks(null), {});
		assert.deepStrictEqual(fightNow.marks({ systems: [] }), {});
		assert.deepStrictEqual(Object.keys(fightNow.marks({ systems: { 30002813: { kills: 1, lastKill: '2026-11-15T10:00:00Z' } } }, 1)), ['30002813']);
	});

	it('marker: a new-tab link with the count and a tooltip, nothing without a mark', () => {
		const html = fightNow.markerHtml({ kills: 4, lastKill: '2026-11-15T10:00:00Z', url: 'https://zkillboard.com/related/30001161/202611151000/' },
			Date.parse('2026-11-15T10:12:00Z'));
		assert.match(html, /^<a class='fight-now' href='https:\/\/zkillboard.com\/related\/30001161\/202611151000\/' target='_blank' rel='noopener noreferrer'/);
		assert.match(html, /4 player kills here in the last hour \(last one 12 min ago\)/);
		assert.match(html, /4<\/a>$/);
		assert.strictEqual(fightNow.markerHtml(null, 0), '');
		assert.strictEqual(fightNow.markerHtml({ kills: 2 }, 0), '');
	});
});
