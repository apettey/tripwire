const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('app/js/fork/feature-usage');

describe('forkUsage', () => {
	const catalog = {
		internal: ['app'],
		features: [
			{ id: 'jumpPlanner', settingsKey: 'jumpRange', commands: ['jumpPlanner.open'], panels: ['jumpPlannerWidget'], use: ['route_planned'] },
			{ id: 'sizeTags', settingsKey: 'sizeTags', commands: [], panels: [], use: [] },
			{ id: 'sigAnomalies', settingsKey: 'sigAnomalies', commands: [], panels: [], use: ['setting_changed'] },
			{ id: 'whatsNew', settingsKey: null, commands: ['app.whatsNew'], panels: [], use: ['opened'] }
		]
	};
	const index = forkUsage.buildIndex(catalog);

	let saved;
	beforeEach(() => {
		saved = { pending: forkUsage.pending, index: forkUsage.index, serverKnown: forkUsage.serverKnown, server: forkUsage.server, queue: forkUsage.queue, listeners: forkUsage.listeners, debugOn: forkUsage.debugOn };
		forkUsage.pending = {};
		forkUsage.queue = [];
		forkUsage.listeners = [];
		forkUsage.debugOn = false;
		global.options = { saves: 0, saveDelay: function() { this.saves++; } };
	});
	afterEach(() => {
		Object.assign(forkUsage, saved);
		delete global.options;
	});

	describe('catalog generic and events', () => {
		const idx = forkUsage.buildIndex({ generic: ['hint_shown', 'Bad!'], features: [
			{ id: 'hints', use: ['acted'], events: ['ignored'] }, { id: 'sizeTags', use: [] }] });
		it('allows the catalog\'s generic actions for every feature and events for their own; neither is use', () => {
			assert.ok(forkUsage.allowed(idx, 'sizeTags', 'hint_shown'));
			assert.ok(forkUsage.allowed(idx, 'hints', 'ignored'));
			assert.ok(!forkUsage.allowed(idx, 'sizeTags', 'ignored'));
			assert.ok(!forkUsage.allowed(idx, 'sizeTags', 'Bad!'));
			assert.ok(!forkUsage.isUse(idx, 'hints', 'ignored') && !forkUsage.isUse(idx, 'sizeTags', 'hint_shown'));
			assert.ok(forkUsage.isUse(idx, 'hints', 'acted'));
		});
	});

	describe('catalog index', () => {
		it('maps commands and panels to features', () => {
			assert.strictEqual(index.commands['jumpPlanner.open'], 'jumpPlanner');
			assert.strictEqual(index.panels.jumpPlannerWidget, 'jumpPlanner');
		});
		it('allows generic actions and the feature\'s own use actions only', () => {
			assert.ok(forkUsage.allowed(index, 'jumpPlanner', 'opened'));
			assert.ok(forkUsage.allowed(index, 'jumpPlanner', 'route_planned'));
			assert.ok(forkUsage.allowed(index, 'sizeTags', 'shown'));
			assert.ok(!forkUsage.allowed(index, 'sizeTags', 'route_planned'));
			assert.ok(!forkUsage.allowed(index, 'nope', 'opened'));
			assert.ok(!forkUsage.allowed(index, 'jumpPlanner', 'Opened'));
			assert.ok(!forkUsage.allowed(index, 'jumpPlanner', 'x'.repeat(25)));
			assert.ok(!forkUsage.allowed(index, '__proto__', 'opened'));
			assert.ok(!forkUsage.allowed(index, 'constructor', 'opened'));
		});
		it('internal ids take only their own actions', () => {
			assert.ok(forkUsage.allowed(index, 'app', 'active'));
			assert.ok(!forkUsage.allowed(index, 'app', 'opened'));
			assert.ok(!forkUsage.isUse(index, 'app', 'active'));
		});
		it('use = command, opened and the feature\'s use list; shown / disabled / settings are not use', () => {
			assert.ok(forkUsage.isUse(index, 'jumpPlanner', 'command'));
			assert.ok(forkUsage.isUse(index, 'jumpPlanner', 'route_planned'));
			assert.ok(forkUsage.isUse(index, 'sigAnomalies', 'setting_changed'));
			['shown', 'disabled', 'setting_on', 'setting_off'].forEach(a => assert.ok(!forkUsage.isUse(index, 'jumpPlanner', a), a));
		});
		it('reads the real catalog', () => {
			const real = forkUsage.buildIndex(loadJSON('public/fork/feature-catalog'));
			assert.strictEqual(real.commands['jumpPlanner.open'], 'jumpPlanner');
			assert.ok(forkUsage.allowed(real, 'app', 'active'));
		});
	});

	describe('aggregation and batches', () => {
		it('counts repeats in one counter, capped', () => {
			const p = {};
			forkUsage.add(p, 'jumpPlanner', 'opened', 1);
			forkUsage.add(p, 'jumpPlanner', 'opened', 1);
			forkUsage.add(p, 'sizeTags', 'shown', 1);
			assert.deepStrictEqual(p, { 'jumpPlanner.opened': 2, 'sizeTags.shown': 1 });
			forkUsage.add(p, 'jumpPlanner', 'opened', 5000);
			assert.strictEqual(p['jumpPlanner.opened'], forkUsage.MAX_COUNT);
		});
		it('drops new keys when the map is full', () => {
			const p = {};
			assert.ok(forkUsage.add(p, 'a', 'x', 1, 2));
			assert.ok(forkUsage.add(p, 'b', 'x', 1, 2));
			assert.ok(!forkUsage.add(p, 'c', 'x', 1, 2));
			assert.ok(forkUsage.add(p, 'a', 'x', 1, 2));
			assert.deepStrictEqual(Object.keys(p).sort(), ['a.x', 'b.x']);
		});
		it('splits into requests of at most 50 entries and 8 KB, each with the token', () => {
			const p = {};
			for (let i = 0; i < 120; i++) { forkUsage.add(p, 'feature' + i, 'opened', 1, 1000); }
			const bodies = forkUsage.batches(p, 'tok');
			assert.strictEqual(bodies.length, 3);
			const parsed = bodies.map(b => JSON.parse(b));
			parsed.forEach(b => { assert.strictEqual(b.t, 'tok'); assert.ok(b.e.length <= 50); });
			assert.strictEqual(parsed.reduce((n, b) => n + b.e.length, 0), 120);
			assert.deepStrictEqual(parsed[0].e[0], { f: 'feature0', a: 'opened', n: 1 });
			const small = forkUsage.batches(p, 'tok', 50, 300);
			small.forEach(b => assert.ok(b.length <= 300, b.length));
			assert.strictEqual(small.reduce((n, b) => n + JSON.parse(b).e.length, 0), 120);
		});
		it('no pending counters, no request', () => {
			assert.deepStrictEqual(forkUsage.batches({}, 'tok'), []);
		});
	});

	describe('used state', () => {
		it('first use is saved at once, repeats at most hourly', () => {
			let r = forkUsage.markUsed(undefined, 'jumpPlanner', 1000);
			assert.ok(r.changed);
			assert.deepStrictEqual(r.usage.jumpPlanner, { first: 1000, last: 1000, n: 1 });
			r = forkUsage.markUsed(r.usage, 'jumpPlanner', 1010);
			assert.ok(!r.changed);
			assert.deepStrictEqual(r.usage.jumpPlanner, { first: 1000, last: 1010, n: 2 });
			r = forkUsage.markUsed(r.usage, 'jumpPlanner', 1070);
			assert.ok(r.changed);
			assert.ok(forkUsage.wasUsed(r.usage, 'jumpPlanner'));
			assert.ok(!forkUsage.wasUsed(r.usage, 'sizeTags'));
			assert.ok(!forkUsage.wasUsed(r.usage, 'constructor'));
		});
		it('track() marks use in options.usage even with statistics turned off, and sends nothing', () => {
			forkUsage.index = index;
			forkUsage.serverKnown = true;
			forkUsage.server = { enabled: true, token: 't'.repeat(64) };
			options.usageStats = { enabled: false };
			forkUsage.track('jumpPlanner', 'opened');
			forkUsage.track('sizeTags', 'shown');
			assert.ok(forkUsage.used('jumpPlanner'));
			assert.ok(!forkUsage.used('sizeTags'));
			assert.deepStrictEqual(forkUsage.pending, {});
			assert.strictEqual(options.saves, 1);
		});
		it('track() counts when statistics are on and the server collects them', () => {
			forkUsage.index = index;
			forkUsage.serverKnown = true;
			forkUsage.server = { enabled: true, token: 't'.repeat(64) };
			forkUsage.track('jumpPlanner', 'opened');
			forkUsage.track('jumpPlanner', 'opened');
			forkUsage.track('nope', 'opened');
			assert.deepStrictEqual(forkUsage.pending, { 'jumpPlanner.opened': 2 });
		});
		it('nothing is counted when the server collects none', () => {
			forkUsage.index = index;
			forkUsage.serverKnown = true;
			forkUsage.server = { enabled: false, token: '' };
			forkUsage.track('jumpPlanner', 'opened');
			assert.deepStrictEqual(forkUsage.pending, {});
			assert.ok(forkUsage.used('jumpPlanner'));
		});
		it('events before the catalog and the server answer wait, then count', () => {
			forkUsage.index = null;
			forkUsage.serverKnown = false;
			forkUsage.track('jumpPlanner', 'command');
			assert.strictEqual(forkUsage.queue.length, 1);
			forkUsage.index = index;
			forkUsage.replay();
			assert.strictEqual(forkUsage.queue.length, 1, 'still waiting for the server');
			forkUsage.serverKnown = true;
			forkUsage.server = { enabled: true, token: 't'.repeat(64) };
			forkUsage.replay();
			assert.deepStrictEqual(forkUsage.pending, { 'jumpPlanner.command': 1 });
			assert.strictEqual(forkUsage.queue.length, 0);
		});
		it('listeners hear every accepted event', () => {
			forkUsage.index = index;
			forkUsage.serverKnown = true;
			const heard = [];
			const off = forkUsage.on((f, a) => heard.push(f + '.' + a));
			forkUsage.track('sizeTags', 'shown');
			forkUsage.track('sizeTags', 'bogus');
			off();
			forkUsage.track('sizeTags', 'shown');
			assert.deepStrictEqual(heard, ['sizeTags.shown']);
		});
	});

	describe('opt-out and settings', () => {
		it('statistics are on unless turned off', () => {
			assert.ok(forkUsage.statsOn(undefined));
			assert.ok(forkUsage.statsOn({}));
			assert.ok(forkUsage.statsOn({ usageStats: { enabled: true } }));
			assert.ok(!forkUsage.statsOn({ usageStats: { enabled: false } }));
		});
		it('Settings Save reports toggles on/off and changed values, not defaults written for a missing key', () => {
			const rows = [
				{ key: 'sizeTags', type: 'checkbox', get: o => !(o.sizeTags && o.sizeTags.enabled === false) },
				{ key: 'sigAnomalies', type: 'select', get: o => (o.sigAnomalies && o.sigAnomalies.mode) || 'show' },
				{ key: 'jumpRange', type: 'custom' },
				{ key: 'sizeTags', type: 'checkbox', get: () => { throw new Error('broken row'); } }
			];
			const state = o => forkUsage.settingState(o, index, rows);
			// Save with nothing touched writes the defaults of missing keys: no change
			assert.deepStrictEqual(forkUsage.settingChanges(state({}), state({ sizeTags: { enabled: true }, sigAnomalies: { mode: 'show' }, jumpRange: { enabled: true, ship: 'x' } })), []);
			const before = state({ sizeTags: { enabled: true }, sigAnomalies: { mode: 'show' } });
			const after = state({ sizeTags: { enabled: false }, sigAnomalies: { mode: 'hide' }, jumpRange: { enabled: false } });
			assert.deepStrictEqual(forkUsage.settingChanges(before, after).sort(), [['jumpPlanner', 'setting_off'], ['sigAnomalies', 'setting_changed'], ['sizeTags', 'setting_off']]);
			const back = state({ sizeTags: { enabled: true }, sigAnomalies: { mode: 'hide' }, jumpRange: { enabled: false } });
			assert.deepStrictEqual(forkUsage.settingChanges(after, back), [['sizeTags', 'setting_on']]);
			assert.deepStrictEqual(forkUsage.settingChanges(back, back), []);
		});
		it('daily snapshot lists the features turned off', () => {
			assert.deepStrictEqual(forkUsage.disabledIds({ sizeTags: { enabled: false }, jumpRange: { enabled: true } }, index), ['sizeTags']);
			assert.deepStrictEqual(forkUsage.disabledIds({}, index), []);
		});
	});

	describe('once a day', () => {
		it('firstToday is true once per key and day, and forgets other days', () => {
			const seen = {};
			assert.ok(forkUsage.firstToday(seen, 'sizeTags.shown', '2026-10-18'));
			assert.ok(!forkUsage.firstToday(seen, 'sizeTags.shown', '2026-10-18'));
			assert.ok(forkUsage.firstToday(seen, '~snapshot', '2026-10-18'));
			assert.ok(forkUsage.firstToday(seen, 'sizeTags.shown', '2026-10-19'));
			assert.deepStrictEqual(seen, { 'sizeTags.shown': '2026-10-19' });
		});
		it('days and minutes are UTC', () => {
			assert.strictEqual(forkUsage.day(Date.UTC(2026, 9, 18, 23, 59)), '2026-10-18');
			assert.strictEqual(forkUsage.minute(Date.UTC(1970, 0, 1, 1, 0)), 60);
		});
	});

	describe('per-account daily marks', () => {
		it('the localStorage key carries the account key from the server', () => {
			forkUsage.server = { enabled: true, token: 't', key: '0123456789abcdef' };
			assert.strictEqual(forkUsage.seenStorageKey(), 'forkUsage.seen.0123456789abcdef');
			forkUsage.server = { enabled: false, token: '', key: '' };
			assert.strictEqual(forkUsage.seenStorageKey(), 'forkUsage.seen.anon');
		});
	});

	describe('data-track', () => {
		it('takes feature.action only', () => {
			assert.deepStrictEqual(forkUsage.parseTrack('jumpPlanner.route_planned'), { feature: 'jumpPlanner', action: 'route_planned' });
			['', 'jumpPlanner', 'jumpPlanner.', '.opened', 'jump planner.opened', 'jumpPlanner.Opened', 'a.b.c'].forEach(v => assert.strictEqual(forkUsage.parseTrack(v), null, v));
		});
	});
});
