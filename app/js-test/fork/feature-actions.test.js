const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { include } = require('../helpers/helpers');
include('app/js/fork/feature-actions');

describe('forkFeatureActions', () => {
	const catalog = { features: [
		{ id: 'jumpPlanner', prs: [50, 52], settingsKey: 'jumpRange', commands: ['jumpPlanner.open', 'panel.jumpPlanner'], panels: ['jumpPlannerWidget'], try: 'jumpPlanner.open' },
		{ id: 'sizeTags', prs: [3], settingsKey: 'sizeTags', commands: [], panels: [] },
		{ id: 'whatsNew', prs: [1], settingsKey: null, commands: ['app.whatsNew'], panels: [] },
		{ id: 'apiTokens', prs: [7], settingsKey: null, commands: [], panels: [] },
		{ id: 'fightHere', prs: [9], settingsKey: null, commands: ['rally.fightHere'], panels: [], try: 'rally.fightHere' }
	] };

	const saved = {};
	before(() => { saved.options = global.options; saved.forkUsage = global.forkUsage; });
	afterEach(() => { forkFeatureActions.setCatalog(null); global.options = saved.options; global.forkUsage = saved.forkUsage; });

	describe('lookups', () => {
		it('byId / byPR once the catalog is in', () => {
			assert.strictEqual(forkFeatureActions.byId('sizeTags'), null);
			forkFeatureActions.setCatalog(catalog);
			assert.strictEqual(forkFeatureActions.byId('sizeTags').id, 'sizeTags');
			assert.strictEqual(forkFeatureActions.byPR(52).id, 'jumpPlanner');
			assert.strictEqual(forkFeatureActions.byPR('50').id, 'jumpPlanner');
			assert.strictEqual(forkFeatureActions.byPR(999), null);
			assert.strictEqual(forkFeatureActions.byId('toString'), null);
		});
		it('a broken catalog gives empty lookups', () => {
			assert.deepStrictEqual(forkFeatureActions.buildIndex(null), { byId: {}, byPR: {} });
			assert.deepStrictEqual(forkFeatureActions.buildIndex({ features: [null, { title: 'no id' }] }), { byId: {}, byPR: {} });
		});
	});

	describe('status', () => {
		const used = ids => id => ids.includes(id);
		it('new when neither used nor off', () => assert.strictEqual(forkFeatureActions.statusOf(catalog.features[0], {}, used([])), 'new'));
		it('used', () => assert.strictEqual(forkFeatureActions.statusOf(catalog.features[0], {}, used(['jumpPlanner'])), 'used'));
		it('off wins over used (it is not in use now)', () =>
			assert.strictEqual(forkFeatureActions.statusOf(catalog.features[0], { jumpRange: { enabled: false } }, used(['jumpPlanner'])), 'off'));
		it('a missing key or enabled true is on', () => {
			assert.strictEqual(forkFeatureActions.statusOf(catalog.features[0], { jumpRange: { enabled: true } }, used([])), 'new');
			assert.strictEqual(forkFeatureActions.statusOf(catalog.features[1], null, used([])), 'new');
		});
		it('no toggle: never off', () => assert.strictEqual(forkFeatureActions.statusOf(catalog.features[2], { null: { enabled: false } }, used([])), 'new'));
		it('status(id) reads options and forkUsage', () => {
			forkFeatureActions.setCatalog(catalog);
			global.options = { sizeTags: { enabled: false } };
			global.forkUsage = { used: id => id === 'jumpPlanner' };
			assert.deepStrictEqual(['jumpPlanner', 'sizeTags', 'apiTokens'].map(forkFeatureActions.status), ['used', 'off', 'new']);
		});
	});

	describe('candidates (Try it order)', () => {
		const jp = catalog.features[0];
		const cmd = map => id => map[id] || null;
		const full = {
			tips: ['jumpPlanner.lowsec'],
			command: cmd({ 'jumpPlanner.open': { available: true, hasArgs: true }, 'panel.jumpPlanner': { available: true, hasArgs: false } }),
			panel: () => true,
			settingRow: 'jumpRange-enabled',
			howText: 'How to use it'
		};
		const kinds = list => list.map(c => c.kind + ':' + c.id);

		it('tip, then its `try` command, then the panel, then the setting, then the toast', () =>
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(jp, full)),
				['tip:jumpPlanner.lowsec', 'palette:jumpPlanner.open', 'panel:jumpPlannerWidget', 'setting:jumpRange-enabled', 'toast:jumpPlanner']));
		it('a `try` command without arguments runs as it is', () => {
			const env = Object.assign({}, full, { tips: [], command: cmd({ 'jumpPlanner.open': { available: true, hasArgs: false } }) });
			assert.strictEqual(kinds(forkFeatureActions.candidates(jp, env))[0], 'command:jumpPlanner.open');
		});
		it('only `try`: no other command of the feature, even an opener', () => {
			const noTry = Object.assign({}, jp, { try: undefined });
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(noTry, Object.assign({}, full, { tips: [] }))),
				['panel:jumpPlannerWidget', 'setting:jumpRange-enabled', 'toast:jumpPlanner']);
		});
		it('a `try` off the allow-list is never a candidate (Fight here)', () => {
			assert.deepStrictEqual(forkFeatureActions.candidates(catalog.features[4], { command: () => ({ available: true, hasArgs: true }) }), []);
			assert.strictEqual(forkFeatureActions.tryCommand(catalog.features[4]), null);
		});
		it('not registered or not available: skipped', () => {
			assert.deepStrictEqual(forkFeatureActions.candidates(jp, { command: cmd({}) }), []);
			assert.deepStrictEqual(forkFeatureActions.candidates(jp, { command: cmd({ 'jumpPlanner.open': { available: false } }) }), []);
		});
		it('a panel toggle is skipped while its panel is shown (it would hide it)', () => {
			const tog = Object.assign({}, jp, { try: 'panel.jumpPlanner' });
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(tog, { command: cmd({ 'panel.jumpPlanner': { available: true, panelShown: true } }), panel: () => true })),
				['panel:jumpPlannerWidget']);
		});
		it('turned off: its Settings row (to turn it on), then the toast', () =>
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(jp, Object.assign({}, full, { off: true }))), ['setting:jumpRange-enabled', 'toast:jumpPlanner']));
		it('only a setting', () =>
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(catalog.features[1], { settingRow: 'sizeTags-enabled' })), ['setting:sizeTags-enabled']));
		it('nothing to do', () => {
			assert.deepStrictEqual(forkFeatureActions.candidates(catalog.features[3], {}), []);
			assert.deepStrictEqual(forkFeatureActions.candidates(null, full), []);
		});

		it('no command outside the allow-list can ever be a candidate (the real catalog, every command available)', () => {
			const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public/fork/feature-catalog.json'), 'utf8'));
			const everything = { command: () => ({ available: true, hasArgs: true }), panel: () => false };
			const everythingNoArgs = { command: () => ({ available: true, hasArgs: false }), panel: () => false };
			const run = [];
			real.features.forEach(f => {
				// Even with a `try` naming anything at all, only TRY_SAFE commands come out
				[f, Object.assign({}, f, { try: f.commands[0] })].forEach(e => [everything, everythingNoArgs].forEach(env => {
					forkFeatureActions.candidates(e, env).filter(c => c.kind === 'command' || c.kind === 'palette').forEach(c => run.push(c.id));
				}));
			});
			assert.ok(run.length > 0);
			run.forEach(id => assert.ok(forkFeatureActions.TRY_SAFE.test(id), id));
			['rally.fightHere', 'targets.add', 'preserveMass.set', 'rolling.mark', 'hole.set', 'sig.undo', 'chain.ping', 'nav.setDestination']
				.forEach(id => assert.ok(!run.includes(id), id));
		});
	});

	describe('howTextOf (the toast)', () => {
		const wn = [{ pr: 50, description: 'Old text.' }, { pr: 52, description: 'Newest   first\nparagraph.\n\nSecond one.' }, { pr: 99, description: 'Other.' }];
		it('first paragraph of the newest entry of the feature', () => assert.strictEqual(forkFeatureActions.howTextOf(catalog.features[0], wn), 'Newest first paragraph.'));
		it('cut at a word with an ellipsis', () => {
			const t = forkFeatureActions.howTextOf(catalog.features[0], [{ pr: 50, description: 'aaaa bbbb cccc dddd' }], 12);
			assert.strictEqual(t, 'aaaa bbbb…');
		});
		it('nothing without an entry', () => {
			assert.strictEqual(forkFeatureActions.howTextOf(catalog.features[1], wn), '');
			assert.strictEqual(forkFeatureActions.howTextOf(null, wn), '');
		});
	});

	describe('tryIt', () => {
		let ran, orig;
		beforeEach(() => {
			ran = [];
			orig = { env: forkFeatureActions.env, run: forkFeatureActions.run };
			forkFeatureActions.setCatalog(catalog);
		});
		afterEach(() => { forkFeatureActions.env = orig.env; forkFeatureActions.run = orig.run; });
		const stub = (env, ok) => {
			forkFeatureActions.env = () => env;
			forkFeatureActions.run = c => { ran.push(c.kind); return ok.includes(c.kind); };
		};

		it('the first that works: a tip that can\'t show falls back to the next', () => {
			stub({ tips: ['t'], command: () => ({ available: true, hasArgs: false }), panel: () => true, settingRow: 'r' }, ['command', 'setting']);
			assert.deepStrictEqual(forkFeatureActions.tryIt('jumpPlanner'), { did: 'command', id: 'jumpPlanner.open' });
			assert.deepStrictEqual(ran, ['tip', 'command']);
		});
		it('a tip that shows ends it', () => {
			stub({ tips: ['t'], settingRow: 'r' }, ['tip']);
			assert.deepStrictEqual(forkFeatureActions.tryIt('sizeTags'), { did: 'tip', id: 't' });
		});
		it('the toast when nothing else works', () => {
			stub({ settingRow: 'r', howText: 'x' }, ['toast']);
			assert.deepStrictEqual(forkFeatureActions.tryIt('sizeTags'), { did: 'toast', id: 'sizeTags' });
			assert.deepStrictEqual(ran, ['setting', 'toast']);
		});
		it('an error in one way is skipped (and logged)', () => {
			forkFeatureActions.env = () => ({ tips: ['t'], settingRow: 'r' });
			forkFeatureActions.run = c => { ran.push(c.kind); if (c.kind === 'tip') { throw new Error('boom'); } return true; };
			const errs = [];
			const ce = console.error;
			console.error = (...a) => errs.push(a);
			try { assert.deepStrictEqual(forkFeatureActions.tryIt('sizeTags'), { did: 'setting', id: 'r' }); } finally { console.error = ce; }
			assert.strictEqual(errs.length, 1);
		});
		it('null when nothing works or the feature is unknown', () => {
			stub({ settingRow: 'r' }, []);
			assert.strictEqual(forkFeatureActions.tryIt('sizeTags'), null);
			assert.strictEqual(forkFeatureActions.tryIt('nope'), null);
		});
		it('canTry: something that shows the feature itself (the toast alone doesn\'t count)', () => {
			stub({ settingRow: null, howText: 'x' }, []);
			assert.strictEqual(forkFeatureActions.canTry('sizeTags'), false);
			stub({ settingRow: 'r' }, []);
			assert.strictEqual(forkFeatureActions.canTry('sizeTags'), true);
		});
		it('run never executes a command off the allow-list', () => {
			forkFeatureActions.run = orig.run;
			assert.strictEqual(forkFeatureActions.run({ kind: 'command', id: 'rally.fightHere' }), false);
			assert.strictEqual(forkFeatureActions.run({ kind: 'palette', id: 'rolling.mark' }), false);
		});
	});
});
