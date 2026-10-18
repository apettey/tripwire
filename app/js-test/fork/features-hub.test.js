const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/features-hub');

describe('featuresHub', () => {
	const catalog = { features: [
		{ id: 'whatsNew', title: "What's New", section: 'general', prs: [1], stage: 'first', audience: 'all' },
		{ id: 'gettingStarted', title: 'Getting started', section: 'general', prs: [], stage: 'first', audience: 'all' },
		{ id: 'featuresHub', title: 'Features', section: 'general', prs: [], stage: 'first', audience: 'all' },
		{ id: 'sizeTags', title: 'Hole size tags', section: 'markers', prs: [3, 9], settingsKey: 'sizeTags', stage: 'core', audience: 'all' },
		{ id: 'preserveMass', title: 'Preserve mass', section: 'markers', prs: [4], stage: 'intermediate', audience: 'all' },
		{ id: 'rolling', title: 'Rolling', section: 'jumps', prs: [5], stage: 'core', audience: 'all' },
		{ id: 'autoMass', title: 'Jump mass', section: 'jumps', prs: [6], stage: 'first', audience: 'all' },
		{ id: 'killFeed', title: 'Kill feed', section: 'intel', prs: [7], stage: 'core', audience: 'all' },
		{ id: 'discord', title: 'Discord', section: 'maskAdmin', prs: [8], stage: 'admin', audience: 'maskAdmin' },
		{ id: 'analyticsDashboard', title: 'Usage analytics', section: 'general', prs: [], stage: 'admin', audience: 'operator' }
	] };
	const wn = [
		{ pr: 3, description: 'Old text. More.' },
		{ pr: 9, description: 'Size tags now show on K162s too. Turn them off in Settings > Map Markers.' },
		{ pr: 4, description: 'Right-click a hole and pick Preserve mass, e.g. Jita side.\n\nSecond paragraph.' }
	];
	const ids = rows => rows.map(r => r.id);

	describe('visible (audience)', () => {
		it('everyone sees audience all', () => assert.strictEqual(featuresHub.visible({ id: 'x', audience: 'all' }, {}), true));
		it('mask admin features only for mask admins', () => {
			assert.strictEqual(featuresHub.visible({ id: 'x', audience: 'maskAdmin' }, {}), false);
			assert.strictEqual(featuresHub.visible({ id: 'x', audience: 'maskAdmin' }, { maskAdmin: true }), true);
		});
		it('operator features only for analytics admins', () => {
			assert.strictEqual(featuresHub.visible({ id: 'x', audience: 'operator' }, { maskAdmin: true }), false);
			assert.strictEqual(featuresHub.visible({ id: 'x', audience: 'operator' }, { operator: true }), true);
		});
		it('unknown audience, the hub itself and Getting started are hidden', () => {
			assert.strictEqual(featuresHub.visible({ id: 'x', audience: 'other' }, { maskAdmin: true, operator: true }), false);
			assert.strictEqual(featuresHub.visible({ id: 'featuresHub', audience: 'all' }, {}), false);
			assert.strictEqual(featuresHub.visible({ id: 'gettingStarted', audience: 'all' }, {}), false);
			assert.strictEqual(featuresHub.visible(null, {}), false);
		});
		it('rows() applies it', () => {
			assert.deepStrictEqual(ids(featuresHub.rows(catalog, { who: {} })), ['whatsNew', 'sizeTags', 'preserveMass', 'rolling', 'autoMass', 'killFeed']);
			assert.ok(ids(featuresHub.rows(catalog, { who: { maskAdmin: true } })).includes('discord'));
			assert.ok(!ids(featuresHub.rows(catalog, { who: { maskAdmin: true } })).includes('analyticsDashboard'));
			assert.ok(ids(featuresHub.rows(catalog, { who: { operator: true } })).includes('analyticsDashboard'));
		});
	});

	describe('description', () => {
		it('first sentence', () => assert.strictEqual(featuresHub.firstSentence('One thing. Two things.'), 'One thing.'));
		it('first paragraph only, whitespace folded', () => assert.strictEqual(featuresHub.firstSentence('  A\n b  c\n\nNext para.'), 'A b c'));
		it('does not split at e.g. or inside names', () => {
			assert.strictEqual(featuresHub.firstSentence('Pick a hole, e.g. Jita side. Then go.'), 'Pick a hole, e.g. Jita side.');
			assert.strictEqual(featuresHub.firstSentence('Press Ctrl+K.then x. Done.'), 'Press Ctrl+K.then x.');
		});
		it('question and exclamation marks end a sentence', () => assert.strictEqual(featuresHub.firstSentence('Lost? Press Home.'), 'Lost?'));
		it('long text is cut at a word with an ellipsis', () => {
			const s = featuresHub.firstSentence('word '.repeat(80) + 'end.');
			assert.ok(s.length <= featuresHub.MAX_DESC + 1, String(s.length));
			assert.ok(/word…$/.test(s), s);
		});
		it('empty and missing text', () => {
			assert.strictEqual(featuresHub.firstSentence(''), '');
			assert.strictEqual(featuresHub.firstSentence(null), '');
		});
		it('uses the newest What\'s New entry of the feature\'s PRs', () => {
			assert.strictEqual(featuresHub.describe(catalog.features[3], wn), 'Size tags now show on K162s too.');
			assert.strictEqual(featuresHub.describe(catalog.features[4], wn), 'Right-click a hole and pick Preserve mass, e.g. Jita side.');
			assert.strictEqual(featuresHub.describe(catalog.features[5], wn), '');
			assert.strictEqual(featuresHub.describe(catalog.features[3], null), '');
		});
		it('is escaped when rendered', () => {
			const html = featuresHub.rowHtml({ id: 'x', title: '<b>T</b>', sectionTitle: 'S&S', description: '<img src=x onerror=alert(1)>', status: 'new' }, {});
			assert.ok(!/<img|<b>/.test(html), html);
			assert.ok(html.includes('&lt;img') && html.includes('S&amp;S'));
		});
	});

	describe('rows and status', () => {
		it('takes status, section title and description', () => {
			const rows = featuresHub.rows(catalog, { who: {}, wn: wn, status: id => id === 'sizeTags' ? 'used' : id === 'rolling' ? 'off' : 'new',
				sectionTitle: k => k === 'markers' ? 'Markers!' : null });
			const tags = rows.filter(r => r.id === 'sizeTags')[0];
			assert.strictEqual(tags.status, 'used');
			assert.strictEqual(tags.sectionTitle, 'Markers!');
			assert.strictEqual(tags.description, 'Size tags now show on K162s too.');
			assert.strictEqual(rows.filter(r => r.id === 'rolling')[0].sectionTitle, 'Wormhole Jumps & Mass');
			assert.strictEqual(rows.filter(r => r.id === 'rolling')[0].status, 'off');
		});
		it('an unknown status counts as not tried', () => {
			assert.strictEqual(featuresHub.rows(catalog, { status: () => 'weird' })[0].status, 'new');
		});
		it('no catalog: no rows', () => assert.deepStrictEqual(featuresHub.rows(null, {}), []));
		it('summary', () => {
			const rows = featuresHub.rows(catalog, { status: id => id === 'sizeTags' || id === 'whatsNew' ? 'used' : 'new' });
			assert.strictEqual(featuresHub.summary(rows), "You've used 2 of 6 features");
			assert.strictEqual(featuresHub.summary([]), "You've used 0 of 0 features");
		});
	});

	describe('sort (near what you already use)', () => {
		it('not tried first, sections used most first, then stage, then catalog order; then used, then off', () => {
			// Markers: 1 used (sizeTags); jumps: 0 used; general: whatsNew used too, so markers and general tie at 1
			const status = { sizeTags: 'used', whatsNew: 'used', killFeed: 'off' };
			const rows = featuresHub.rows(catalog, { status: id => status[id] || 'new' });
			assert.deepStrictEqual(featuresHub.sectionUse(rows), { markers: 1, general: 1 });
			assert.deepStrictEqual(ids(featuresHub.sort(rows)), [
				'preserveMass',			// not tried, in a section used once
				'autoMass', 'rolling',	// not tried, section never used: first before core
				'whatsNew', 'sizeTags',	// used: first stage, then core
				'killFeed'				// turned off
			]);
		});
		it('a section with more used features comes first', () => {
			const cat = { features: [
				{ id: 'a', section: 'intel', stage: 'core', audience: 'all' },
				{ id: 'b', section: 'routes', stage: 'core', audience: 'all' },
				{ id: 'c', section: 'routes', stage: 'core', audience: 'all' },
				{ id: 'd', section: 'routes', stage: 'core', audience: 'all' },
				{ id: 'e', section: 'intel', stage: 'core', audience: 'all' }
			] };
			const used = { c: 1, d: 1, e: 1 };
			const rows = featuresHub.rows(cat, { status: id => used[id] ? 'used' : 'new' });
			assert.deepStrictEqual(ids(featuresHub.sort(rows)), ['b', 'a', 'c', 'd', 'e']);
		});
		it('does not change its input', () => {
			const rows = featuresHub.rows(catalog, { status: () => 'new' });
			const before = ids(rows);
			featuresHub.sort(rows);
			assert.deepStrictEqual(ids(rows), before);
		});
	});

	describe('filter', () => {
		const rows = featuresHub.rows(catalog, { who: { maskAdmin: true }, wn: wn, status: id => id === 'sizeTags' ? 'used' : 'new' });
		it('no filter: everything', () => assert.strictEqual(featuresHub.filter(rows, {}).length, rows.length));
		it('by section', () => assert.deepStrictEqual(ids(featuresHub.filter(rows, { section: 'markers' })), ['sizeTags', 'preserveMass']));
		it('by stage', () => assert.deepStrictEqual(ids(featuresHub.filter(rows, { stage: 'admin' })), ['discord']));
		it('by status', () => assert.deepStrictEqual(ids(featuresHub.filter(rows, { status: 'used' })), ['sizeTags']));
		it('by text in title, description or section, every word, any case', () => {
			assert.deepStrictEqual(ids(featuresHub.filter(rows, { text: 'K162' })), ['sizeTags']);
			assert.deepStrictEqual(ids(featuresHub.filter(rows, { text: 'mass jumps' })), ['rolling', 'autoMass']);
			assert.deepStrictEqual(ids(featuresHub.filter(rows, { text: 'mask admin' })), ['discord']);
			assert.deepStrictEqual(ids(featuresHub.filter(rows, { text: 'nothing like this' })), []);
		});
		it('filters combine', () => assert.deepStrictEqual(ids(featuresHub.filter(rows, { section: 'markers', status: 'new' })), ['preserveMass']));
		it('section list: sections with rows, by title', () => {
			assert.deepStrictEqual(featuresHub.sections(rows).map(s => s.key), ['general', 'intel', 'markers', 'maskAdmin', 'jumps']);
		});
	});

	describe('rowHtml', () => {
		it('Show me is disabled when there is nothing to show; Settings only with a row', () => {
			const r = { id: 'a', title: 'A', sectionTitle: 'S', description: '', status: 'new' };
			assert.ok(/fhub-try' disabled/.test(featuresHub.rowHtml(r, { canTry: false })));
			assert.ok(!/disabled/.test(featuresHub.rowHtml(r, { canTry: true })));
			assert.ok(!/fhub-settings/.test(featuresHub.rowHtml(r, {})));
			assert.ok(/fhub-settings/.test(featuresHub.rowHtml(r, { hasSetting: true })));
		});
		it('only a toast left (nothing on screen): an enabled "How?" button', () => {
			const r = { id: 'a', title: 'A', sectionTitle: 'S', description: '', status: 'new' };
			const html = featuresHub.rowHtml(r, { canTry: false, canTell: true });
			assert.ok(html.includes('>How?<') && !/disabled/.test(html), html);
			assert.strictEqual(featuresHub.tryLabel('off', { canTry: false, canTell: true }), 'How?');
			assert.strictEqual(featuresHub.tryLabel('off', { canTry: true, canTell: true }), 'Turn on');
			assert.strictEqual(featuresHub.tryLabel('new', { canTry: true }), 'Show me');
		});
		it('badges and the turned-off button text', () => {
			assert.ok(featuresHub.rowHtml({ id: 'a', title: 'A', status: 'used' }, {}).includes('>Used<'));
			assert.ok(featuresHub.rowHtml({ id: 'a', title: 'A', status: 'new' }, {}).includes('>Not tried<'));
			const off = featuresHub.rowHtml({ id: 'a', title: 'A', status: 'off' }, { canTry: true });
			assert.ok(off.includes('>Turned off<') && off.includes('>Turn on<'));
		});
	});
});
