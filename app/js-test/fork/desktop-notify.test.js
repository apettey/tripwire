const assert = require('assert');
const { include } = require('../helpers/helpers');

include('app/js/fork/desktop-notify');

describe('forkDesktopNotify', () => {
	const dn = forkDesktopNotify;
	const note = (type, extra) => Object.assign({ type: type, title: 'A title', body: 'Body' }, extra || {});
	const ctx = (extra) => Object.assign({ opts: {}, hidden: true, permission: 'granted' }, extra || {});

	describe('settings', () => {
		it('has the master switch and every type on by default', () => {
			const s = dn.settings(null);
			assert.strictEqual(s.enabled, true);
			dn.TYPES.forEach(t => assert.strictEqual(s.types[t[0]], true, t[0]));
		});

		it('reads each switch; a missing key means on', () => {
			const s = dn.settings({ desktopNotify: { enabled: false, timer: false, rally: true } });
			assert.strictEqual(s.enabled, false);
			assert.strictEqual(s.types.timer, false);
			assert.strictEqual(s.types.rally, true);
			assert.strictEqual(s.types.watchlist, true);
		});

		it('takes the kill switch from Kill Reporting > Desktop alerts', () => {
			assert.strictEqual(dn.settings({ killReporting: { desktop: false } }).types.kill, false);
			assert.strictEqual(dn.settings({ killReporting: {}, desktopNotify: { kill: false } }).types.kill, true);
		});

		it('covers exactly the alert sources it is called from', () => {
			assert.deepStrictEqual(dn.TYPES.map(t => t[0]), ['kill', 'timer', 'watchlist', 'newHole', 'homeStatic', 'capRange', 'rally']);
		});
	});

	describe('permission', () => {
		const N = (p) => { const f = function() {}; f.permission = p; return f; };
		it('says when the page is not on HTTPS', () => {
			assert.strictEqual(dn.permission({ isSecureContext: false, Notification: N('default') }), 'insecure');
		});
		it('says when the browser has no Notification API', () => {
			assert.strictEqual(dn.permission({ isSecureContext: true }), 'unsupported');
			assert.strictEqual(dn.permission(null), 'unsupported');
		});
		it('passes granted / denied / default through', () => {
			['granted', 'denied', 'default'].forEach(p => assert.strictEqual(dn.permission({ isSecureContext: true, Notification: N(p) }), p));
			assert.strictEqual(dn.permission({ isSecureContext: true, Notification: N('weird') }), 'default');
		});
	});

	describe('decide', () => {
		it('shows only while the tab is hidden', () => {
			assert.deepStrictEqual(dn.decide(note('timer'), ctx()), { show: true, reason: '' });
			assert.deepStrictEqual(dn.decide(note('timer'), ctx({ hidden: false })), { show: false, reason: 'visible' });
		});
		it('needs the permission', () => {
			['default', 'denied', 'unsupported', 'insecure'].forEach(p =>
				assert.strictEqual(dn.decide(note('timer'), ctx({ permission: p })).reason, 'permission'));
		});
		it('honours the master switch and the type switch', () => {
			assert.strictEqual(dn.decide(note('timer'), ctx({ opts: { desktopNotify: { enabled: false } } })).reason, 'off');
			assert.strictEqual(dn.decide(note('timer'), ctx({ opts: { desktopNotify: { timer: false } } })).reason, 'type_off');
			assert.strictEqual(dn.decide(note('watchlist'), ctx({ opts: { desktopNotify: { timer: false } } })).show, true);
			assert.strictEqual(dn.decide(note('kill'), ctx({ opts: { killReporting: { desktop: false } } })).reason, 'type_off');
		});
		it('leaves kills to Kill Reporting alone: the master switch (or its mask default) never turns them off', () => {
			const off = { desktopNotify: { enabled: false } };
			assert.deepStrictEqual(dn.decide(note('kill'), ctx({ opts: off })), { show: true, reason: '' });
			assert.deepStrictEqual(dn.decide(note('kill'), ctx({ opts: { desktopNotify: { enabled: false, kill: false } } })), { show: true, reason: '' });
			assert.strictEqual(dn.decide(note('kill'), ctx({ opts: { desktopNotify: { enabled: false }, killReporting: { desktop: false } } })).reason, 'type_off');
			assert.strictEqual(dn.decide(note('timer'), ctx({ opts: off })).reason, 'off');
		});
		it('ignores unknown types and empty titles', () => {
			assert.strictEqual(dn.decide(note('nope'), ctx()).reason, 'unknown_type');
			assert.strictEqual(dn.decide(null, ctx()).reason, 'unknown_type');
			assert.strictEqual(dn.decide(note('timer', { title: '  ' }), ctx()).reason, 'empty');
		});
	});

	describe('tags and text', () => {
		it('builds one stable tag per event', () => {
			assert.strictEqual(dn.tag('newHole', 42), 'tripwire-newHole-42');
			assert.strictEqual(dn.tag('rally'), 'tripwire-rally');
			assert.strictEqual(dn.tag('watchlist', 'a b<c>'), 'tripwire-watchlist-abc');
			assert.strictEqual(dn.tag('kill', 123), 'tripwire-kill-123');	// the tag Kill Reporting always used
		});
		it('makes plain text and caps it', () => {
			assert.strictEqual(dn.plain('<b>Fight</b> &amp; &lt;go&gt;\n now'), 'Fight & <go> now');
			assert.strictEqual(dn.plain('x'.repeat(10), 5), 'xxxx…');
			assert.strictEqual(dn.plain(null), '');
		});
		it('fills in the tag and the Tripwire icon', () => {
			const p = dn.payload({ type: 'timer', title: 'T', body: 'B' });
			assert.deepStrictEqual(p, { title: 'T', options: { body: 'B', tag: 'tripwire-timer', icon: 'images/favicon.png' } });
			assert.strictEqual(dn.payload({ type: 'kill', title: 'T', icon: 'x.png', tag: 'k' }).options.icon, 'x.png');
		});
	});

	describe('alert sources', () => {
		it('chain alerts: the kind is the type, tagged by hole', () => {
			const n = dn.chainAlertNote('homeStatic', { title: 'Home static EOL', text: 'C247 in J1' }, '77');
			assert.deepStrictEqual(n, { type: 'homeStatic', title: 'Home static EOL', body: 'C247 in J1', tag: 'tripwire-homeStatic-77' });
			assert.strictEqual(dn.chainAlertNote('capRange', {}, 30000142).tag, 'tripwire-capRange-30000142');
		});
		it('structure timers: one tag per timer, whatever the stage', () => {
			const a = dn.timerNote({ key: '5:1000:900', lead: 900, row: { id: 5, timerAt: 1000 } }, 'Hull timer in 15 m');
			const b = dn.timerNote({ key: '5:1000:0', lead: 0, row: { id: 5, timerAt: 1000 } }, 'Hull timer ended');
			assert.strictEqual(a.type, 'timer');
			assert.strictEqual(a.tag, b.tag);
			assert.strictEqual(b.body, 'Hull timer ended');
		});
		it('watchlist: the filter name and up to six systems', () => {
			const analyse = id => ({ name: 'J' + id, systemTypeName: 'C3' });
			const n = dn.watchlistNote({ filterID: 9, filterName: 'Pulsars', systemIDs: [1, 2, 3, 4, 5, 6, 7, 8] }, analyse);
			assert.strictEqual(n.type, 'watchlist');
			assert.strictEqual(n.title, 'Watchlist: Pulsars');
			assert.strictEqual(n.body, 'On the chain: J1 (C3), J2 (C3), J3 (C3), J4 (C3), J5 (C3), J6 (C3) and 2 more');
			assert.strictEqual(n.tag, 'tripwire-watchlist-9');
		});
		it('Fight here: where, comp and who', () => {
			const n = dn.rallyNote('A1 · J123456', { comp: { name: 'Shield' }, setBy: 'Bob' });
			assert.deepStrictEqual(n, { type: 'rally', title: 'Fight here: A1 · J123456', body: 'Shield · set by Bob', tag: 'tripwire-rally' });
			assert.strictEqual(dn.rallyNote('X', {}).body, '');
		});
		it('every source maps to a known type', () => {
			['newHole', 'homeStatic', 'capRange'].forEach(k => assert.ok(dn.isType(dn.chainAlertNote(k, {}, 1).type)));
			assert.ok(dn.isType(dn.timerNote({ row: {} }, '').type));
			assert.ok(dn.isType(dn.watchlistNote({ systemIDs: [] }).type));
			assert.ok(dn.isType(dn.rallyNote('x').type));
		});
	});

	describe('Settings state and tip', () => {
		it('offers the button only while the browser has not been asked', () => {
			assert.strictEqual(dn.stateView('default', true).button, true);
			['granted', 'denied', 'unsupported', 'insecure'].forEach(p => assert.strictEqual(dn.stateView(p, true).button, false, p));
			assert.ok(/site settings/.test(dn.stateView('denied', true).text));
			assert.ok(/HTTPS/.test(dn.stateView('insecure', true).text));
			assert.ok(/switched off/.test(dn.stateView('granted', false).text));
		});
		it('tips only while permission is default and the switches are on', () => {
			assert.strictEqual(dn.tipEligible({}, 'default', 'timer'), true);
			assert.strictEqual(dn.tipEligible({}, 'granted', 'timer'), false);
			assert.strictEqual(dn.tipEligible({}, 'denied'), false);
			assert.strictEqual(dn.tipEligible({ desktopNotify: { enabled: false } }, 'default'), false);
			assert.strictEqual(dn.tipEligible({ desktopNotify: { timer: false } }, 'default', 'timer'), false);
		});
	});

	describe('notify (stubbed Notification API)', () => {
		let made, tracked, emitted, focused;
		function FakeNotification(title, o) { this.title = title; this.options = o; this.closed = false; made.push(this); }
		FakeNotification.prototype.close = function() { this.closed = true; };
		const KEYS = ['window', 'document', 'options', 'forkUsage', 'forkHints'];
		let saved;
		beforeEach(() => {
			saved = {};
			KEYS.forEach(k => { saved[k] = Object.getOwnPropertyDescriptor(global, k); });
			made = []; tracked = []; emitted = []; focused = 0;
			FakeNotification.permission = 'granted';
			global.window = { Notification: FakeNotification, isSecureContext: true, focus: () => { focused++; } };
			global.document = { hidden: true };
			global.options = {};
			global.forkUsage = { track: (f, a) => tracked.push(f + '.' + a) };
			global.forkHints = { emit: (e, d) => emitted.push(e + ':' + d.type) };
		});
		afterEach(() => {
			KEYS.forEach(k => { if (saved[k]) { Object.defineProperty(global, k, saved[k]); } else { delete global[k]; } });
		});

		it('shows one while hidden, and clicking focuses, closes and runs the action', () => {
			let clicked = 0;
			const n = dn.notify(note('timer', { tag: 'tripwire-timer-1' }), () => { clicked++; });
			assert.strictEqual(made.length, 1);
			assert.strictEqual(n.options.tag, 'tripwire-timer-1');
			assert.deepStrictEqual(tracked, ['desktopNotify.shown']);
			assert.deepStrictEqual(emitted, []);	// the tip trigger is for alerts seen on screen
			n.onclick();
			assert.strictEqual(focused, 1);
			assert.strictEqual(n.closed, true);
			assert.strictEqual(clicked, 1);
			assert.deepStrictEqual(tracked, ['desktopNotify.shown', 'desktopNotify.clicked']);
		});

		it('shows none while visible, but tells the tip engine', () => {
			global.document.hidden = false;
			assert.strictEqual(dn.notify(note('watchlist')), null);
			assert.strictEqual(made.length, 0);
			assert.deepStrictEqual(emitted, ['alert.shown:watchlist']);
		});

		it('shows none without permission or with the switch off', () => {
			FakeNotification.permission = 'default';
			assert.strictEqual(dn.notify(note('timer')), null);
			FakeNotification.permission = 'granted';
			global.options = { desktopNotify: { enabled: false } };
			assert.strictEqual(dn.notify(note('timer')), null);
			assert.strictEqual(made.length, 0);
			assert.deepStrictEqual(tracked, []);
		});

		it('survives a browser that throws (Chrome on Android)', () => {
			global.window.Notification = function() { throw new Error('Illegal constructor'); };
			global.window.Notification.permission = 'granted';
			const warn = console.warn; console.warn = () => {};
			try { assert.strictEqual(dn.notify(note('timer')), null); } finally { console.warn = warn; }
		});

		it('wanted() is true only when a hidden tab would get one', () => {
			assert.strictEqual(dn.wanted('homeStatic'), true);
			FakeNotification.permission = 'denied';
			assert.strictEqual(dn.wanted('homeStatic'), false);
		});

		it('records granted / denied after the browser answers', async () => {
			FakeNotification.permission = 'default';
			FakeNotification.requestPermission = () => { FakeNotification.permission = 'granted'; return Promise.resolve('granted'); };
			const got = await new Promise(resolve => dn.request(resolve));
			assert.strictEqual(got, 'granted');
			assert.deepStrictEqual(tracked, ['desktopNotify.granted']);
			FakeNotification.permission = 'default';
			FakeNotification.requestPermission = () => { FakeNotification.permission = 'denied'; return Promise.resolve('denied'); };
			assert.strictEqual(await new Promise(resolve => dn.request(resolve)), 'denied');
			assert.deepStrictEqual(tracked, ['desktopNotify.granted', 'desktopNotify.denied']);
		});

		it('does not ask, or count anything, once the browser has an answer', async () => {
			let asked = 0;
			FakeNotification.permission = 'granted';
			FakeNotification.requestPermission = () => { asked++; return Promise.resolve('granted'); };
			assert.strictEqual(await new Promise(resolve => dn.request(resolve)), 'granted');
			assert.strictEqual(asked, 0);
			assert.deepStrictEqual(tracked, []);
		});

		it('counts one answer when the browser both calls back and resolves', async () => {
			FakeNotification.permission = 'default';
			FakeNotification.requestPermission = (cb) => { FakeNotification.permission = 'granted'; cb('granted'); return Promise.resolve('granted'); };
			await new Promise(resolve => dn.request(resolve));
			await new Promise(r => setTimeout(r, 0));
			assert.deepStrictEqual(tracked, ['desktopNotify.granted']);
		});
	});
});
