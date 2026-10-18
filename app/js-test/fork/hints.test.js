const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/hints');
include('app/js/fork/hints-ui');

const MIN = 60000, HOUR = 3600000, DAY = 86400000;

describe('forkHints', () => {
	const def = (o) => Object.assign({ id: 't.a', feature: 'sigAnomalies', trigger: 'paste.sigs', anchor: '#x', title: 'T', body: 'B' }, o || {});
	const fresh = () => forkHints.stateOf({});
	const ctx = (o) => Object.assign({ used: () => false, featureOff: () => false, hints: {}, isMaskAdmin: false, isNew: false, sectionOf: h => h.section || 'signatures' }, o || {});

	describe('register / normalize', () => {
		it('fills the defaults', () => {
			const h = forkHints.normalize(def());
			assert.deepStrictEqual([h.kind, h.priority, h.maxShows, h.cooldownHours, h.ttlSeconds, h.minCount, h.audience, h.placement], ['callout', 50, 2, 72, 600, 1, 'all', 'bottom']);
			assert.deepStrictEqual(h.triggers, ['paste.sigs']);
			assert.deepStrictEqual(h.after, []);
		});
		it('takes several triggers', () => {
			assert.deepStrictEqual(forkHints.normalize(def({ trigger: ['a', 'b'] })).triggers, ['a', 'b']);
		});
		it('throws on mistakes', () => {
			[{ id: '' }, { id: 'bad id' }, { feature: '' }, { trigger: [] }, { kind: 'idle' }, { audience: 'vets' }, { placement: 'middle' },
				{ anchor: undefined }, { title: '' }, { body: 5 }, { eligible: true }, { action: { label: 'x' } }, { priority: 'high' }]
				.forEach(o => assert.throws(() => forkHints.normalize(def(o)), JSON.stringify(o)));
		});
		it('a toast needs no anchor', () => {
			assert.strictEqual(forkHints.normalize(def({ kind: 'toast', anchor: undefined })).kind, 'toast');
		});
	});

	describe('options', () => {
		it('tips are on unless turned off', () => {
			assert.ok(forkHints.enabled({}));
			assert.ok(forkHints.enabled({ hints: {} }));
			assert.ok(!forkHints.enabled({ hints: { enabled: false } }));
		});
		it('completes broken state in place', () => {
			const o = { hints: { state: 'x', log: { week: 5, lastAt: 'y' } } };
			const st = forkHints.stateOf(o);
			assert.strictEqual(st, o.hints);
			assert.deepStrictEqual(st, { state: {}, disabledSections: [], log: { week: [], lastAt: 0 } });
		});
		it('section and settings key come from the catalog unless the tip names them', () => {
			const index = { features: { sigAnomalies: { entry: { section: 'signatures', settingsKey: 'sigAnomalies' } } } };
			const h = forkHints.normalize(def());
			assert.strictEqual(forkHints.sectionOf(h, index), 'signatures');
			assert.strictEqual(forkHints.sectionOf(forkHints.normalize(def({ section: 'intel' })), index), 'intel');
			assert.strictEqual(forkHints.sectionOf(forkHints.normalize(def({ feature: 'nope' })), index), 'general');
			assert.strictEqual(forkHints.settingsKeyOf(h, index), 'sigAnomalies');
			assert.strictEqual(forkHints.settingsKeyOf(forkHints.normalize(def({ settingsKey: null })), index), null);
		});
	});

	describe('blockedReason', () => {
		const h = forkHints.normalize(def());
		it('nothing blocks a new tip', () => {
			assert.strictEqual(forkHints.blockedReason(h, fresh(), ctx(), 0), '');
		});
		it('retires once the feature is used, or its toggle is off', () => {
			assert.strictEqual(forkHints.blockedReason(h, fresh(), ctx({ used: f => f === 'sigAnomalies' }), 0), 'feature used');
			assert.strictEqual(forkHints.blockedReason(h, fresh(), ctx({ featureOff: x => x === h }), 0), 'feature turned off');
		});
		it('held back while something else teaches the feature (Getting started)', () => {
			assert.strictEqual(forkHints.blockedReason(h, fresh(), ctx({ held: f => f === 'sigAnomalies' ? 'Getting started' : '' }), 0), 'held: Getting started teaches it now');
			assert.strictEqual(forkHints.blockedReason(h, fresh(), ctx({ held: () => '' }), 0), '');
		});
		it('hold / listen', () => {
			forkHints.hold('x', 'Card');
			assert.strictEqual(forkHints.holds.x, 'Card');
			forkHints.hold('x', '');
			assert.ok(!('x' in forkHints.holds));
			const got = [];
			const stop = forkHints.listen((e, d) => got.push([e, d]));
			forkHints.listeners.forEach(fn => fn('paste.sigs', { rows: 2 }));
			stop();
			assert.deepStrictEqual(got, [['paste.sigs', { rows: 2 }]]);
			assert.strictEqual(forkHints.listeners.length, 0);
		});
		it('tips off, section off', () => {
			const st = fresh();
			st.enabled = false;
			assert.strictEqual(forkHints.blockedReason(h, st, ctx(), 0), 'tips turned off');
			const st2 = fresh();
			st2.disabledSections.push('signatures');
			assert.match(forkHints.blockedReason(h, st2, ctx(), 0), /signatures turned off/);
		});
		it('audience', () => {
			const admin = forkHints.normalize(def({ audience: 'maskAdmin' }));
			assert.strictEqual(forkHints.blockedReason(admin, fresh(), ctx(), 0), 'not a mask admin');
			assert.strictEqual(forkHints.blockedReason(admin, fresh(), ctx({ isMaskAdmin: true }), 0), '');
			const newbie = forkHints.normalize(def({ audience: 'new' }));
			assert.strictEqual(forkHints.blockedReason(newbie, fresh(), ctx(), 0), 'not a new account');
			assert.strictEqual(forkHints.blockedReason(newbie, fresh(), ctx({ isNew: true }), 0), '');
		});
		it('done outcomes never come back; closed / ignored come back after the cooldown, up to maxShows', () => {
			['acted', 'got_it', 'section_off'].forEach(outcome => {
				const st = fresh();
				st.state['t.a'] = { shows: 1, last: 0, outcome: outcome };
				assert.match(forkHints.blockedReason(h, st, ctx(), 100 * DAY), /^done/);
			});
			const st = fresh();
			st.state['t.a'] = { shows: 1, last: DAY, outcome: 'closed' };
			assert.strictEqual(forkHints.blockedReason(h, st, ctx(), DAY + 71 * HOUR), 'cooling down');
			assert.strictEqual(forkHints.blockedReason(h, st, ctx(), DAY + 72 * HOUR), '');
			st.state['t.a'].shows = 2;
			assert.match(forkHints.blockedReason(h, st, ctx(), 100 * DAY), /shown 2 times/);
		});
		it('after: waits until the other tip was shown or retired; unknown ones don\'t block', () => {
			const first = forkHints.normalize(def({ id: 'first', feature: 'commandPalette' }));
			const second = forkHints.normalize(def({ id: 'second', after: ['first', 'unknown'] }));
			const c = ctx({ hints: { first: first, second: second } });
			const st = fresh();
			assert.match(forkHints.blockedReason(second, st, c, 0), /waits for first/);
			st.state.first = { shows: 1, last: 0, outcome: 'ignored' };
			assert.strictEqual(forkHints.blockedReason(second, st, c, 0), '');
			assert.strictEqual(forkHints.blockedReason(second, fresh(), ctx({ hints: c.hints, used: f => f === 'commandPalette' }), 0), '');
		});
	});

	describe('eligibleSafe', () => {
		it('a throwing predicate is false', () => {
			const warn = console.warn;
			console.warn = () => {};
			try {
				assert.strictEqual(forkHints.eligibleSafe(forkHints.normalize(def({ eligible: () => { throw new Error('x'); } })), {}, {}), false);
			} finally { console.warn = warn; }
			assert.strictEqual(forkHints.eligibleSafe(forkHints.normalize(def({ eligible: (c, d) => d.n > 1 })), {}, { n: 2 }), true);
			assert.strictEqual(forkHints.eligibleSafe(forkHints.normalize(def()), {}, null), true);
		});
	});

	describe('queue', () => {
		const a = forkHints.normalize(def({ id: 'a', priority: 10, ttlSeconds: 60 }));
		const b = forkHints.normalize(def({ id: 'b', priority: 90 }));
		const c = forkHints.normalize(def({ id: 'c', priority: 10 }));
		it('one entry per tip, refreshed by a new trigger', () => {
			const q = [];
			forkHints.enqueue(q, a, { n: 1 }, 0);
			forkHints.enqueue(q, a, { n: 2 }, 1000);
			assert.deepStrictEqual(q, [{ id: 'a', data: { n: 2 }, at: 1000, expires: 61000 }]);
		});
		it('expires at its ttl', () => {
			const q = [];
			forkHints.enqueue(q, a, null, 0);
			forkHints.enqueue(q, b, null, 0);
			assert.deepStrictEqual(forkHints.expire(q, 59999), []);
			assert.deepStrictEqual(forkHints.expire(q, 60000).map(x => x.id), ['a']);
			assert.deepStrictEqual(q.map(x => x.id), ['b']);
		});
		it('priority first, then the most recent trigger', () => {
			const q = [];
			forkHints.enqueue(q, a, null, 0);
			forkHints.enqueue(q, c, null, 5);
			forkHints.enqueue(q, b, null, 1);
			assert.deepStrictEqual(forkHints.ordered(q, { a: a, b: b, c: c }).map(x => x.id), ['b', 'c', 'a']);
		});
	});

	describe('capsReason', () => {
		const h = forkHints.normalize(def());
		const beacon = forkHints.normalize(def({ id: 'beacon', kind: 'beacon' }));
		const toast = forkHints.normalize(def({ id: 'toast', kind: 'toast', anchor: undefined }));
		const session = (o) => Object.assign({ start: 0, shown: 0, whatsNew: false }, o || {});
		const T = 10 * DAY;
		it('passes after the 2-minute grace', () => {
			assert.strictEqual(forkHints.capsReason(h, fresh(), 'signatures', session({ start: T - 2 * MIN }), T), '');
			assert.match(forkHints.capsReason(h, fresh(), 'signatures', session({ start: T - MIN }), T), /first 2 minutes/);
		});
		it('one pop-up tip a session (toasts count too); none after What\'s New', () => {
			assert.match(forkHints.capsReason(h, fresh(), 's', session({ shown: 1 }), T), /this session/);
			assert.match(forkHints.capsReason(toast, fresh(), 's', session({ shown: 1 }), T), /this session/);
			assert.match(forkHints.capsReason(h, fresh(), 's', session({ whatsNew: true }), T), /What's New/);
		});
		it('30 minutes apart, 3 a week, 1 per section a day', () => {
			const st = fresh();
			forkHints.recordShow(st, h, 'signatures', T - 29 * MIN);
			assert.match(forkHints.capsReason(h, st, 'intel', session(), T), /30 minutes/);
			assert.match(forkHints.capsReason(h, st, 'signatures', session(), T + 31 * MIN), /signatures tip today/);
			assert.strictEqual(forkHints.capsReason(h, st, 'intel', session(), T + 31 * MIN), '');
			assert.strictEqual(forkHints.capsReason(h, st, 'signatures', session(), T + DAY), '');
			forkHints.recordShow(st, h, 'intel', T + DAY);
			forkHints.recordShow(st, h, 'routes', T + 2 * DAY);
			assert.match(forkHints.capsReason(h, st, 'general', session(), T + 3 * DAY), /3 tips this week/);
			assert.strictEqual(forkHints.capsReason(h, st, 'general', session(), T + 7 * DAY), '');
		});
		it('debug skips the grace and the gap, not the session cap', () => {
			const st = fresh();
			forkHints.recordShow(st, h, 'signatures', T - MIN);
			assert.strictEqual(forkHints.capsReason(h, st, 'intel', session({ start: T }), T, { debug: true }), '');
			assert.match(forkHints.capsReason(h, st, 'intel', session({ shown: 1 }), T, { debug: true }), /this session/);
		});
		it('beacons: only the on-screen limit', () => {
			assert.strictEqual(forkHints.capsReason(beacon, fresh(), 's', session({ shown: 5, whatsNew: true }), T, { beacons: 2 }), '');
			assert.match(forkHints.capsReason(beacon, fresh(), 's', session(), T, { beacons: 3 }), /3 beacons/);
		});
	});

	describe('quietReason', () => {
		const ok = { now: 100 * MIN, visible: true, focused: true, lastInput: 100 * MIN - 10000, lastKill: 0, lastPaste: 0,
			dialogOpen: false, inputFocused: false, dragging: false, popupOpen: false, fightHere: false };
		const q = (o) => forkHints.quietReason(Object.assign({}, ok, o));
		it('a quiet moment', () => { assert.strictEqual(q({}), ''); });
		it('refuses when busy, away or in a fight', () => {
			assert.strictEqual(q({ visible: false }), 'tab hidden');
			assert.strictEqual(q({ focused: false }), 'window not focused');
			assert.strictEqual(q({ lastInput: ok.now - 1000 }), 'user busy');
			assert.strictEqual(q({ lastInput: ok.now - 3 * MIN }), 'user away');
			assert.strictEqual(q({ lastInput: 0 }), 'user away');
			assert.strictEqual(q({ lastKill: ok.now - 9 * MIN }), 'kill in the chain');
			assert.strictEqual(q({ lastKill: ok.now - 11 * MIN }), '');
			assert.strictEqual(q({ lastPaste: ok.now - 20000 }), 'just pasted');
			assert.strictEqual(q({ lastPaste: ok.now - 31000 }), '');
			assert.strictEqual(q({ dialogOpen: true }), 'a dialog is open');
			assert.strictEqual(q({ inputFocused: true }), 'typing in a field');
			assert.strictEqual(q({ dragging: true }), 'dragging');
			assert.strictEqual(q({ popupOpen: true }), 'another pop-up is open');
			assert.strictEqual(q({ fightHere: true }), 'Fight here is active');
		});
	});

	describe('state', () => {
		const h = forkHints.normalize(def());
		it('records shows and outcomes; section_off turns the section off once', () => {
			const st = fresh();
			forkHints.recordShow(st, h, 'signatures', 1000);
			assert.deepStrictEqual(st.state['t.a'], { shows: 1, last: 1000, outcome: 'shown' });
			assert.deepStrictEqual(st.log, { lastAt: 1000, week: [[1000, 'signatures']] });
			forkHints.recordOutcome(st, h, 'section_off', 'signatures');
			forkHints.recordOutcome(st, h, 'section_off', 'signatures');
			assert.deepStrictEqual(st.disabledSections, ['signatures']);
			assert.strictEqual(st.state['t.a'].outcome, 'section_off');
		});
		it('beacons and forced shows stay out of the caps log', () => {
			const st = fresh();
			forkHints.recordShow(st, forkHints.normalize(def({ kind: 'beacon' })), 's', 1000);
			forkHints.recordShow(st, h, 's', 2000, true);
			assert.deepStrictEqual(st.log, { lastAt: 0, week: [] });
			assert.strictEqual(st.state['t.a'].shows, 2);
		});
		it('trims the log to 7 days and the state to MAX_STATE tips', () => {
			const st = fresh();
			st.log.week = [[0, 'a'], [DAY, 'b'], 'junk'];
			for (let i = 0; i < forkHints.MAX_STATE + 5; i++) { st.state['h' + i] = { shows: 1, last: i }; }
			forkHints.trim(st, 7.5 * DAY);
			assert.deepStrictEqual(st.log.week, [[DAY, 'b']]);
			assert.strictEqual(Object.keys(st.state).length, forkHints.MAX_STATE);
			assert.ok(!st.state.h0 && st.state['h' + (forkHints.MAX_STATE + 4)]);
		});
		it('minCount counts triggers up to the count (no change, so no save, after that); a show starts it again', () => {
			const st = fresh();
			const five = forkHints.normalize(def({ minCount: 5 }));
			const results = [1, 2, 3, 4, 5, 6, 7].map(() => forkHints.counted(st, five));
			assert.deepStrictEqual(results.map(r => r.reached), [false, false, false, false, true, true, true]);
			assert.deepStrictEqual(results.map(r => r.changed), [true, true, true, true, true, false, false]);
			assert.strictEqual(st.state['t.a'].n, 5);
			forkHints.recordShow(st, five, 's', 1000);
			assert.strictEqual(st.state['t.a'].n, undefined);
			assert.deepStrictEqual(forkHints.counted(st, five), { reached: false, changed: true });
			assert.deepStrictEqual(forkHints.counted(fresh(), h), { reached: true, changed: false });
		});
		it('newKills: one kill counts once, the memory is bounded', () => {
			const seen = { map: {}, order: [] };
			assert.deepStrictEqual(forkHints.newKills(seen, [1, 2]), [1, 2]);
			assert.deepStrictEqual(forkHints.newKills(seen, [2, 3, null]), [3]);
			for (let i = 10; i < 10 + forkHints.MAX_KILLS; i++) { forkHints.newKills(seen, [i]); }
			assert.strictEqual(seen.order.length, forkHints.MAX_KILLS);
			assert.deepStrictEqual(forkHints.newKills(seen, [1]), [1]);
		});
	});

	describe('helpers', () => {
		it('systemKind', () => {
			assert.deepStrictEqual(['wh class-3', 'hisec', 'lowsec', 'nullsec', 'triglavian', 'unknown', undefined].map(forkHints.systemKind),
				['wormhole', 'highsec', 'lowsec', 'nullsec', 'pochven', 'unknown', 'unknown']);
		});
		it('pasteInfo counts sig rows and anomalies', () => {
			const text = ['ABC-123\tCosmic Signature\tWormhole\t\t100.0%\t4 AU', 'GHI-789\tCosmic Anomaly\tCombat Site\tPerimeter Camp\t100.0%\t2 AU',
				'garbage line', ''].join('\n');
			const isAnomaly = g => g === 'Cosmic Anomaly';
			assert.deepStrictEqual(forkHints.pasteInfo(text, isAnomaly), { rows: 2, anomalies: 1 });
			assert.deepStrictEqual(forkHints.pasteInfo(text, null), { rows: 2, anomalies: 0 });
			assert.deepStrictEqual(forkHints.pasteInfo(undefined), { rows: 0, anomalies: 0 });
		});
	});

	// The engine with a fake clock, fake options / usage and a fake UI
	describe('engine (emit, pump, show, reset)', () => {
		let saved, clock, ui, tracked, quiet, anchorOK;
		beforeEach(() => {
			saved = { now: Date.now, ui: global.forkHintsUI, hints: forkHints.hints, queue: forkHints.queue, session: forkHints.session, debugOn: forkHints.debugOn, current: forkHints.current };
			clock = 100 * DAY;
			Date.now = () => clock;
			tracked = [];
			quiet = '';
			anchorOK = true;
			ui = { shown: [], beacons: 0, tip: null,
				busy: () => !!ui.tip, beaconCount: () => ui.beacons,
				quietSignals: () => ({ quiet: true }),
				anchorFor: () => anchorOK,
				render: (hint, view) => { ui.shown.push([hint.id, view.body]); if (hint.kind !== 'beacon') { ui.tip = hint.id; } return true; },
				hide: () => { ui.tip = null; }, removeBeacons: () => {} };
			global.forkHintsUI = ui;
			global.options = { saves: 0, saveDelay: function() { this.saves++; } };
			global.forkUsage = { index: null, used: f => !!(global.options.usage && global.options.usage[f]), track: (f, a) => tracked.push(f + '.' + a) };
			forkHints.hints = {};
			forkHints.queue = [];
			forkHints.debugOn = false;
			forkHints.session = { start: clock - 10 * MIN, shown: 0, whatsNew: false };
			saved.quietReason = forkHints.quietReason;
			forkHints.quietReason = () => quiet;
		});
		afterEach(() => {
			Date.now = saved.now;
			global.forkHintsUI = saved.ui;
			Object.assign(forkHints, { hints: saved.hints, queue: saved.queue, session: saved.session, debugOn: saved.debugOn, current: saved.current, quietReason: saved.quietReason });
			clearTimeout(forkHints.pumpTimer);
			forkHints.pumpTimer = null;
			delete global.options;
			delete global.forkUsage;
		});

		it('shows a matching, eligible tip at a quiet moment, records and tracks it', () => {
			forkHints.register(def({ eligible: (c, d) => d.anomalies > 0, body: (c, d) => d.anomalies + ' anomalies' }));
			forkHints.emit('paste.sigs', { anomalies: 0 });
			assert.deepStrictEqual(ui.shown, []);
			forkHints.emit('other.event', { anomalies: 3 });
			assert.deepStrictEqual(ui.shown, []);
			forkHints.emit('paste.sigs', { anomalies: 3 });
			assert.deepStrictEqual(ui.shown, [['t.a', '3 anomalies']]);
			assert.deepStrictEqual(tracked, ['hints.tip_shown', 'sigAnomalies.hint_shown']);
			assert.strictEqual(options.hints.state['t.a'].shows, 1);
			assert.strictEqual(forkHints.session.shown, 1);
			assert.ok(options.saves > 0);
		});

		it('waits for a quiet moment and drops the tip at its ttl', () => {
			forkHints.register(def({ ttlSeconds: 60 }));
			quiet = 'user busy';
			forkHints.emit('paste.sigs', {});
			assert.strictEqual(forkHints.queue.length, 1);
			clock += 30000;
			quiet = '';
			forkHints.pump();
			assert.strictEqual(ui.shown.length, 1);

			forkHints.register(def({ id: 't.b', ttlSeconds: 60 }));
			ui.tip = null;
			forkHints.session.shown = 0;
			options.hints.log = { lastAt: 0, week: [] };
			quiet = 'kill in the chain';
			forkHints.emit('paste.sigs', {});
			clock += 61000;
			quiet = '';
			forkHints.pump();
			assert.strictEqual(ui.shown.length, 1);
			assert.strictEqual(forkHints.queue.length, 0);
		});

		it('the anchor must be visible', () => {
			forkHints.register(def());
			anchorOK = false;
			forkHints.emit('paste.sigs', {});
			assert.deepStrictEqual(ui.shown, []);
			anchorOK = true;
			forkHints.pump();
			assert.strictEqual(ui.shown.length, 1);
		});

		it('a second tip in the same session waits (the cap holds); the higher priority goes first', () => {
			forkHints.register(def({ id: 'low', priority: 10 }));
			forkHints.register(def({ id: 'high', priority: 90, feature: 'commandPalette' }));
			quiet = 'user busy';
			forkHints.emit('paste.sigs', {});
			quiet = '';
			forkHints.pump();
			assert.deepStrictEqual(ui.shown.map(s => s[0]), ['high']);
			ui.tip = null;
			forkHints.pump();
			assert.deepStrictEqual(ui.shown.map(s => s[0]), ['high']);
			assert.strictEqual(forkHints.queue.length, 1);
		});

		it('retires a queued tip once its feature is used', () => {
			forkHints.register(def());
			quiet = 'user busy';
			forkHints.emit('paste.sigs', {});
			options.usage = { sigAnomalies: { n: 1 } };
			quiet = '';
			forkHints.pump();
			assert.deepStrictEqual(ui.shown, []);
			assert.strictEqual(forkHints.queue.length, 0);
		});

		it('minCount: the 5th trigger; saves stop once counted', () => {
			forkHints.register(def({ minCount: 5, kind: 'toast', anchor: undefined }));
			quiet = 'user busy';
			for (let i = 0; i < 4; i++) { forkHints.emit('paste.sigs', {}); }
			assert.strictEqual(forkHints.queue.length, 0);
			forkHints.emit('paste.sigs', {});
			assert.strictEqual(forkHints.queue.length, 1);
			const saves = options.saves;
			forkHints.emit('paste.sigs', {});
			forkHints.emit('paste.sigs', {});
			assert.strictEqual(options.saves, saves, 'no save per trigger once the count is reached');
			quiet = '';
			forkHints.pump();
			assert.strictEqual(ui.shown.length, 1);
			assert.strictEqual(options.hints.state['t.a'].n, undefined);
		});

		it('kill.chain: the same kill from two sources marks the time once', () => {
			forkHints.signals.lastKill = 0;
			forkHints.seenKills = { map: {}, order: [] };
			forkHints.emit('kill.chain', { killIDs: [7] });
			assert.strictEqual(forkHints.signals.lastKill, clock);
			clock += 5 * MIN;
			forkHints.emit('kill.chain', { killIDs: [7] });
			assert.strictEqual(forkHints.signals.lastKill, clock - 5 * MIN);
			forkHints.emit('kill.chain', { killIDs: [7, 8] });
			assert.strictEqual(forkHints.signals.lastKill, clock);
		});

		it('outcomes: tracked, acted runs the action, section_off turns the section off', () => {
			let ran = null;
			forkHints.register(def({ section: 'signatures', action: { label: 'Do', run: (c, d) => { ran = d; } } }));
			forkHints.outcome('t.a', 'acted', { x: 1 });
			assert.deepStrictEqual(ran, { x: 1 });
			forkHints.outcome('t.a', 'section_off');
			assert.deepStrictEqual(options.hints.disabledSections, ['signatures']);
			assert.deepStrictEqual(tracked, ['hints.acted', 'sigAnomalies.hint_acted', 'hints.section_off']);
			['got_it', 'closed', 'ignored'].forEach(o => forkHints.outcome('t.a', o));
			assert.deepStrictEqual(tracked.slice(3), ['hints.got_it', 'hints.closed', 'hints.ignored']);
		});

		it('show(force) skips caps, quiet and retirement, but needs the anchor; plain show() obeys them', () => {
			forkHints.register(def());
			options.usage = { sigAnomalies: { n: 1 } };
			quiet = 'user busy';
			forkHints.session.shown = 1;
			assert.strictEqual(forkHints.show('t.a'), false);
			assert.strictEqual(forkHints.show('t.a', { force: true }), true);
			assert.strictEqual(forkHints.session.shown, 1, 'a forced show is not a push: no cap used');
			anchorOK = false;
			ui.tip = null;
			assert.strictEqual(forkHints.show('t.a', { force: true }), false);
			assert.strictEqual(forkHints.show('nope', { force: true }), false);
		});

		it('tips turned off: nothing is queued', () => {
			forkHints.register(def());
			options.hints = { enabled: false };
			forkHints.emit('paste.sigs', {});
			assert.strictEqual(forkHints.queue.length, 0);
			assert.deepStrictEqual(ui.shown, []);
		});

		it('the feature\'s Settings toggle off retires the tip (catalog settingsKey)', () => {
			global.forkUsage.index = { features: { sizeTags: { entry: { settingsKey: 'sizeTags', section: 'markers' } } } };
			forkHints.register(def({ feature: 'sizeTags' }));
			options.sizeTags = { enabled: false };
			forkHints.emit('paste.sigs', {});
			assert.deepStrictEqual(ui.shown, []);
			assert.strictEqual(forkHints.list()[0].blocked, 'feature turned off');
		});

		it('reset forgets the state (keeps tips off); Settings > Reset turns them back on', () => {
			forkHints.register(def());
			forkHints.emit('paste.sigs', {});
			options.hints.enabled = false;
			forkHints.reset(options);
			assert.deepStrictEqual(options.hints, { enabled: false });
			forkHints.stateOf(options).state['t.a'] = { shows: 1, last: 1 };
			forkHints.reset(options, true);
			assert.strictEqual(options.hints, undefined);
			assert.strictEqual(forkHints.queue.length, 0);
		});

		it('list() reports each tip', () => {
			forkHints.register(def({ section: 'signatures' }));
			const l = forkHints.list();
			assert.deepStrictEqual([l[0].id, l[0].section, l[0].kind, l[0].blocked, l[0].queued], ['t.a', 'signatures', 'callout', '', false]);
		});
	});
});

describe('forkHintsUI', () => {
	const view = { width: 800, height: 600 };
	const box = { width: 200, height: 100 };
	it('places the box on the preferred side with the arrow at the anchor', () => {
		const p = forkHintsUI.place({ left: 300, top: 100, width: 100, height: 20 }, box, view, 'bottom');
		assert.deepStrictEqual(p, { left: 250, top: 130, placement: 'bottom', arrow: 100 });
		const l = forkHintsUI.place({ left: 400, top: 200, width: 100, height: 20 }, box, view, 'left');
		assert.deepStrictEqual(l, { left: 190, top: 160, placement: 'left', arrow: 50 });
	});
	it('flips to the other side when there is no room, and stays on screen', () => {
		const p = forkHintsUI.place({ left: 300, top: 550, width: 100, height: 20 }, box, view, 'bottom');
		assert.strictEqual(p.placement, 'top');
		assert.strictEqual(p.top, 550 - 10 - 100);
		const edge = forkHintsUI.place({ left: 0, top: 100, width: 20, height: 20 }, box, view, 'bottom');
		assert.strictEqual(edge.left, 8);
		assert.strictEqual(edge.arrow, 14, 'the arrow stays off the corner');
		const r = forkHintsUI.place({ left: 10, top: 300, width: 20, height: 20 }, box, view, 'left');
		assert.strictEqual(r.placement, 'right');
	});
	it('onScreen: sized, in the viewport and in the clip', () => {
		assert.ok(forkHintsUI.onScreen({ left: 10, top: 10, width: 5, height: 5 }, view));
		assert.ok(!forkHintsUI.onScreen({ left: 10, top: 10, width: 0, height: 5 }, view));
		assert.ok(!forkHintsUI.onScreen({ left: 900, top: 10, width: 5, height: 5 }, view));
		assert.ok(!forkHintsUI.onScreen({ left: 10, top: 10, width: 5, height: 5 }, view, { left: 100, top: 100, width: 50, height: 50 }));
	});
	it('html escapes the text and offers the right buttons', () => {
		const h = forkHintsUI.html({ title: '<b>T</b>', body: 'one & two\n\npara 2', actionLabel: 'Show me' }, 'callout');
		assert.ok(h.includes('&lt;b&gt;T&lt;/b&gt;') && !h.includes('<b>T'));
		assert.ok(h.includes("<p class='fh-body'>one &amp; two</p><p class='fh-body'>para 2</p>"));
		assert.ok(h.includes('fh-act') && h.includes('fh-ok') && h.includes('fh-off') && h.includes('fh-close') && h.includes('fh-arrow'));
		const t = forkHintsUI.html({ title: 'T', body: 'B', actionLabel: '' }, 'toast');
		assert.ok(!t.includes('fh-act') && !t.includes('fh-arrow') && t.includes('fh-toast'));
	});
});
