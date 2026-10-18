const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/feature-actions');

describe('forkFeatureActions', () => {
	const catalog = { features: [
		{ id: 'jumpPlanner', prs: [50, 52], settingsKey: 'jumpRange', commands: ['jumpPlanner.open', 'panel.jumpPlanner'], panels: ['jumpPlannerWidget'] },
		{ id: 'sizeTags', prs: [3], settingsKey: 'sizeTags', commands: [], panels: [] },
		{ id: 'whatsNew', prs: [1], settingsKey: null, commands: ['app.whatsNew'], panels: [] },
		{ id: 'apiTokens', prs: [7], settingsKey: null, commands: [], panels: [] }
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
			settingRow: 'jumpRange-enabled'
		};
		const kinds = list => list.map(c => c.kind + ':' + c.id);

		it('tip, then one command (one that runs as it is first), then the panel, then the setting', () =>
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(jp, full)),
				['tip:jumpPlanner.lowsec', 'command:panel.jumpPlanner', 'panel:jumpPlannerWidget', 'setting:jumpRange-enabled']));
		it('a command with arguments opens the palette at it when it is the only one', () => {
			const env = Object.assign({}, full, { tips: [], command: cmd({ 'jumpPlanner.open': { available: true, hasArgs: true } }) });
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(jp, env)), ['palette:jumpPlanner.open', 'panel:jumpPlannerWidget', 'setting:jumpRange-enabled']);
		});
		it('a command that acts at once (no arguments, not an opener) is never run', () => {
			const pal = { id: 'commandPalette', commands: ['nav.toggleFollow', 'sig.undo', 'chain.ping', 'nav.setDestination'], panels: [] };
			const env = { command: cmd({ 'nav.toggleFollow': { available: true }, 'sig.undo': { available: true }, 'chain.ping': { available: true },
				'nav.setDestination': { available: true, hasArgs: false } }) };
			assert.deepStrictEqual(forkFeatureActions.candidates(pal, env), []);
			const env2 = { command: cmd({ 'nav.toggleFollow': { available: true }, 'nav.setDestination': { available: true, hasArgs: true } }) };
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(pal, env2)), ['palette:nav.setDestination'], 'with arguments: the palette asks first');
		});
		it('only one command: the first that is registered and available', () => {
			const env = Object.assign({}, full, { tips: [], command: cmd({ 'jumpPlanner.open': { available: false, hasArgs: true }, 'panel.jumpPlanner': { available: true, hasArgs: false } }) });
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(jp, env)), ['command:panel.jumpPlanner', 'panel:jumpPlannerWidget', 'setting:jumpRange-enabled']);
		});
		it('unregistered commands are skipped', () => {
			const env = { command: cmd({}), panel: () => false, settingRow: null };
			assert.deepStrictEqual(forkFeatureActions.candidates(jp, env), []);
		});
		it('a panel toggle is skipped while its panel is shown (it would hide it)', () => {
			const env = { command: cmd({ 'jumpPlanner.open': { available: false }, 'panel.jumpPlanner': { available: true, panelShown: true } }), panel: () => true };
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(jp, env)), ['panel:jumpPlannerWidget']);
		});
		it('turned off: only its Settings row (to turn it on)', () =>
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(jp, Object.assign({}, full, { off: true }))), ['setting:jumpRange-enabled']));
		it('only a setting', () =>
			assert.deepStrictEqual(kinds(forkFeatureActions.candidates(catalog.features[1], { settingRow: 'sizeTags-enabled' })), ['setting:sizeTags-enabled']));
		it('never runs the commands that are not a way to try a feature (What\'s New itself)', () =>
			assert.deepStrictEqual(forkFeatureActions.candidates(catalog.features[2], { command: () => ({ available: true }) }), []));
		it('nothing to do', () => {
			assert.deepStrictEqual(forkFeatureActions.candidates(catalog.features[3], {}), []);
			assert.deepStrictEqual(forkFeatureActions.candidates(null, full), []);
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
			forkFeatureActions.run = c => { ran.push(c.kind); if (c.kind === 'boom') { throw new Error('x'); } return ok.includes(c.kind); };
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
		it('canTry says whether there is anything to try', () => {
			stub({ settingRow: null }, []);
			assert.strictEqual(forkFeatureActions.canTry('sizeTags'), false);
			stub({ settingRow: 'r' }, []);
			assert.strictEqual(forkFeatureActions.canTry('sizeTags'), true);
		});
	});
});
