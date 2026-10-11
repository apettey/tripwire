const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/command-registry');

describe('Command registry', () => {
	let warnings;
	const realWarn = console.warn, realError = console.error;
	beforeEach(() => {
		forkCommands.commands = [];
		forkCommands.providers = {};
		warnings = [];
		console.warn = (m) => warnings.push(m);
		console.error = () => {};
	});
	afterEach(() => { console.warn = realWarn; console.error = realError; });

	const ok = (extra) => Object.assign({ id: 'x.one', title: 'One', run: () => {} }, extra);

	describe('register', () => {
		it('requires id, title and run', () => {
			assert.throws(() => forkCommands.register(), /definition object/);
			assert.throws(() => forkCommands.register({ title: 'T', run: () => {} }), /id is required/);
			assert.throws(() => forkCommands.register({ id: 'a', run: () => {} }), /title is required/);
			assert.throws(() => forkCommands.register({ id: 'a', title: 'T' }), /run/);
			assert.throws(() => forkCommands.register(ok({ enabled: true })), /enabled must be a function/);
			assert.throws(() => forkCommands.register(ok({ context: 1 })), /context must be a function/);
		});
		it('warns about a duplicate id and ignores it', () => {
			const first = forkCommands.register(ok({ title: 'First' }));
			const second = forkCommands.register(ok({ title: 'Second' }));
			assert.equal(second, first);
			assert.equal(forkCommands.commands.length, 1);
			assert.equal(forkCommands.commands[0].title, 'First');
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /x\.one.*already registered/);
		});
		it('defaults an unknown group to App and keywords to []', () => {
			const c = forkCommands.register(ok({ group: 'Nonsense' }));
			assert.equal(c.group, 'App');
			assert.deepEqual(c.keywords, []);
			assert.equal(forkCommands.register(ok({ id: 'x.two', group: 'Fleet' })).group, 'Fleet');
		});
	});

	describe('items', () => {
		it('passes the ctx to enabled and context', () => {
			let seen;
			forkCommands.register(ok({ enabled: (ctx) => { seen = ctx; return true; }, context: (ctx) => ctx.viewingSystemID === 5 }));
			const items = forkCommands.items({ viewingSystemID: 5 });
			assert.equal(seen.viewingSystemID, 5);
			assert.equal(items[0].inContext, true);
			assert.equal(items[0].ctx, 120);
			assert.equal(items[0].disabled, '');
		});
		it('passes an enabled reason through as the disabled hint', () => {
			forkCommands.register(ok({ group: 'Holes', enabled: () => 'Select a hole first' }));
			const item = forkCommands.items({})[0];
			assert.equal(item.disabled, 'Select a hole first');
			assert.equal(item.subtitle, 'Select a hole first');
			assert.equal(item.ctx, 0);
		});
		it('treats false as disabled with a generic reason, and a throwing enabled as unavailable', () => {
			forkCommands.register(ok({ enabled: () => false }));
			forkCommands.register(ok({ id: 'x.two', enabled: () => { throw new Error('boom'); } }));
			const items = forkCommands.items({});
			assert.equal(items[0].disabled, 'Not available right now');
			assert.equal(items[1].disabled, 'Not available');
		});
		it('uses the group as the subtitle and a keyword', () => {
			forkCommands.register(ok({ group: 'Fleet', keywords: ['rally'] }));
			const item = forkCommands.items({})[0];
			assert.equal(item.subtitle, 'Fleet');
			assert.deepEqual(item.keys, ['rally', 'Fleet']);
			assert.equal(item.key, 'cmd:x.one');
		});
	});

	describe('providers', () => {
		it('caches until invalidated, unless volatile', () => {
			let calls = 0, vcalls = 0;
			forkCommands.provider('a', () => { calls++; return [{ key: 'k' }]; });
			forkCommands.provider('v', () => { vcalls++; return []; }, { volatile: true });
			forkCommands.providerItems('a', {}); forkCommands.providerItems('a', {});
			forkCommands.providerItems('v', {}); forkCommands.providerItems('v', {});
			assert.equal(calls, 1);
			assert.equal(vcalls, 2);
			forkCommands.invalidate('a');
			forkCommands.providerItems('a', {});
			assert.equal(calls, 2);
			forkCommands.invalidate();
			forkCommands.providerItems('a', {});
			assert.equal(calls, 3);
		});
		it('a broken provider gives no items', () => {
			forkCommands.provider('bad', () => { throw new Error('x'); });
			assert.deepEqual(forkCommands.providerItems('bad', {}), []);
			assert.deepEqual(forkCommands.providerItems('missing', {}), []);
		});
		it('requires a name and a function', () => {
			assert.throws(() => forkCommands.provider('', () => []), /required/);
			assert.throws(() => forkCommands.provider('x'), /required/);
		});
	});

	describe('execute', () => {
		it('runs the command with args and ctx', async () => {
			let got;
			const c = forkCommands.register(ok({ run: (args, ctx) => { got = [args, ctx]; } }));
			const r = await forkCommands.execute(c, { a: 1 }, { viewingSystemID: 9 });
			assert.deepEqual(r, { ok: true });
			assert.deepEqual(got, [{ a: 1 }, { viewingSystemID: 9 }]);
		});
		it('catches a synchronous exception', async () => {
			const c = forkCommands.register(ok({ run: () => { throw new Error('nope'); } }));
			const r = await forkCommands.execute(c, {}, {});
			assert.equal(r.ok, false);
			assert.equal(r.error.message, 'nope');
		});
		it('waits for a Promise and catches its rejection', async () => {
			const good = forkCommands.register(ok({ id: 'g', run: () => Promise.resolve() }));
			const bad = forkCommands.register(ok({ id: 'b', run: () => Promise.reject(new Error('later')) }));
			assert.equal((await forkCommands.execute(good, {}, {})).ok, true);
			const r = await forkCommands.execute(bad, {}, {});
			assert.equal(r.ok, false);
			assert.equal(r.error.message, 'later');
		});
	});
});
