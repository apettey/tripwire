const assert = require('assert');
const { include } = require('../helpers/helpers');

function loadFiles() {
	include('app/js/fork/feature-usage');
	include('app/js/fork/feature-actions');
	include('app/js/fork/features-hub');
}

// "Try it" / "Show me" (forkFeatureActions.tryIt) is not the user using the feature it shows: forkUsage's real hooks
// (installHooks) must not count what tryIt runs, and must count the user's own use afterwards.
describe('Try it does not count as use (forkUsage hooks + forkFeatureActions)', () => {
	// Loaded here, not at file load: other test files replace or delete these globals while mocha loads them
	before(loadFiles);
	const catalog = { internal: ['app'], features: [
		{ id: 'jumpPlanner', try: 'jumpPlanner.open', settingsKey: null, commands: ['jumpPlanner.open'], panels: ['jumpPlannerWidget'], use: [] },
		{ id: 'featuresHub', try: 'features.open', settingsKey: null, commands: ['features.open'], panels: [], use: ['opened', 'tried'] }
	] };
	// Globals installHooks would wrap or listen on; other test files may have defined some of them
	const NAMES = ['forkCommands', 'commandPalette', 'whatsNew', 'panelHost', 'panelModes', 'forkSettings', 'document', 'window', 'setInterval', 'options', '$'];
	let saved, savedUsage;
	const flush = () => new Promise(r => setImmediate(r));

	beforeEach(() => {
		saved = {};
		NAMES.forEach(n => { saved[n] = global[n]; global[n] = undefined; });
		savedUsage = { pending: forkUsage.pending, index: forkUsage.index, serverKnown: forkUsage.serverKnown, server: forkUsage.server, queue: forkUsage.queue, listeners: forkUsage.listeners, debugOn: forkUsage.debugOn };
		global.document = { addEventListener: () => {} };
		global.window = { addEventListener: () => {} };
		global.setInterval = () => 0;
		global.options = { saveDelay: () => {} };
		forkUsage.pending = {};
		forkUsage.queue = [];
		forkUsage.listeners = [];
		forkUsage.debugOn = false;
		forkUsage.index = forkUsage.buildIndex(catalog);
		forkUsage.serverKnown = true;
		forkUsage.server = { enabled: true, token: 't'.repeat(64) };
		forkFeatureActions.setCatalog(catalog);
		forkFeatureActions.trying = null;
	});
	afterEach(() => {
		NAMES.forEach(n => { global[n] = saved[n]; });
		Object.assign(forkUsage, savedUsage);
		forkFeatureActions.setCatalog(null);
		forkFeatureActions.trying = null;
	});

	it('a command run by tryIt is not counted; the same command run by the user afterwards is', async () => {
		const command = { id: 'jumpPlanner.open', title: 'Jump planner', run: () => {} };
		global.forkCommands = { commands: [command], execute: () => Promise.resolve({ ok: true }) };
		forkUsage.installHooks();
		const env = forkFeatureActions.env;
		forkFeatureActions.env = () => ({ command: () => ({ available: true, hasArgs: false }) });
		try {
			assert.deepStrictEqual(forkFeatureActions.tryIt('jumpPlanner'), { did: 'command', id: 'jumpPlanner.open' });
			await flush();
		} finally { forkFeatureActions.env = env; }
		assert.strictEqual(forkUsage.pending['jumpPlanner.command'], undefined);
		assert.ok(!forkUsage.used('jumpPlanner'));
		assert.strictEqual(forkFeatureActions.trying, null, 'cleared once the result is in');

		await forkCommands.execute(command, {}, {});
		await flush();
		assert.strictEqual(forkUsage.pending['jumpPlanner.command'], 1);
		assert.ok(forkUsage.used('jumpPlanner'));
	});

	it('a panel restored by tryIt (panelModes.setMode) counts neither panelModes.mode nor opened', () => {
		global.panelModes = { setMode: () => {}, opts: () => ({}), defOf: () => ({}), modeFor: () => 'restore' };
		forkUsage.installHooks();
		forkFeatureActions.trying = { id: 'jumpPlanner', until: Date.now() + 1000 };
		panelModes.setMode('jumpPlannerWidget', 'restore');
		assert.deepStrictEqual(forkUsage.pending, {});
		forkFeatureActions.trying = null;
		panelModes.setMode('jumpPlannerWidget', 'restore');
		assert.strictEqual(forkUsage.pending['jumpPlanner.opened'], 1);
	});
});

describe('featuresHub.open counts opened once', () => {
	before(loadFiles);
	let saved;
	beforeEach(() => {
		saved = { $: global.$, forkUsage: global.forkUsage, whatsNew: global.whatsNew, load: forkFeatureActions.load, trying: forkFeatureActions.trying };
		// A chainable jQuery stand-in: every call and property returns itself (no dialog is really made)
		const chain = new Proxy(function() {}, { get: (t, p) => p === 'then' ? undefined : p === 'length' ? 1 : chain, apply: () => chain });
		global.$ = chain;
		global.whatsNew = undefined;
		forkFeatureActions.load = () => new Promise(() => {});
		forkFeatureActions.trying = null;
	});
	afterEach(() => {
		global.$ = saved.$;
		global.forkUsage = saved.forkUsage;
		global.whatsNew = saved.whatsNew;
		forkFeatureActions.load = saved.load;
		forkFeatureActions.trying = saved.trying;
	});
	const calls = () => {
		const list = [];
		global.forkUsage = { track: (f, a) => list.push(f + '.' + a) };
		return list;
	};

	it('from Settings, What\'s New or Getting started: opened', () => {
		const list = calls();
		featuresHub.open();
		assert.deepStrictEqual(list, ['featuresHub.opened']);
	});
	it('from Ctrl+K (open(true)): nothing here, forkUsage counts featuresHub.command', () => {
		const list = calls();
		featuresHub.open(true);
		assert.deepStrictEqual(list, []);
	});
	it('run by What\'s New\'s Try it: nothing', () => {
		const list = calls();
		forkFeatureActions.trying = { id: 'featuresHub', until: Date.now() + 1000 };
		featuresHub.open();
		assert.deepStrictEqual(list, []);
	});
	it('reset the status and text filters on each open', () => {
		calls();
		featuresHub.state = { section: 'intel', stage: 'core', status: 'used', text: 'x' };
		featuresHub.open();
		assert.deepStrictEqual(featuresHub.state, { section: 'intel', stage: 'core', status: '', text: '' });
		featuresHub.state = { section: '', stage: '', status: '', text: '' };
	});
});
