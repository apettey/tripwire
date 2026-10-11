const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/mask-defaults');
// the tests below also use made-up keys (the real list is checked in mask-defaults-allow.test.js)
before(() => { maskDefaults.ALLOWED.push('a', 'b', 'x', 'ok', 'alpha', 'zeta'); });
after(() => { maskDefaults.ALLOWED.length = 24; });

describe('maskDefaults', () => {
	const defaults = { sizeTags: { enabled: false, big: 1 }, soundMute: { enabled: true } };

	describe('resolve: own choice -> mask default -> built-in', () => {
		it('uses the member own value', () => {
			assert.deepStrictEqual(maskDefaults.resolve({ sizeTags: { enabled: true } }, defaults, 'sizeTags'), { enabled: true });
		});
		it('falls back to the mask default when the member has no value', () => {
			assert.deepStrictEqual(maskDefaults.resolve({}, defaults, 'sizeTags'), { enabled: false, big: 1 });
		});
		it('is undefined (= built-in) with neither', () => {
			assert.strictEqual(maskDefaults.resolve({}, defaults, 'other'), undefined);
			assert.strictEqual(maskDefaults.resolve({}, {}, 'sizeTags'), undefined);
		});
		it('treats an explicit false/0 as the member choice, not as missing', () => {
			assert.strictEqual(maskDefaults.resolve({ sizeTags: false }, defaults, 'sizeTags'), false);
			assert.strictEqual(maskDefaults.resolve({ sizeTags: 0 }, defaults, 'sizeTags'), 0);
		});
		it('never resolves a denied key from the defaults', () => {
			assert.strictEqual(maskDefaults.resolve({}, { masks: { active: '1.0' } }, 'masks'), undefined);
		});
		it('ignores inherited prototype properties', () => {
			assert.strictEqual(maskDefaults.resolve({}, {}, 'toString'), undefined);
		});
	});

	describe('overlay', () => {
		it('fills only the keys the member has no value for', () => {
			const opts = { soundMute: { enabled: false } };
			const inherited = {};
			const changed = maskDefaults.overlay(opts, defaults, inherited);
			assert.deepStrictEqual(changed, ['sizeTags']);
			assert.deepStrictEqual(opts.sizeTags, { enabled: false, big: 1 });
			assert.deepStrictEqual(opts.soundMute, { enabled: false });	// own choice kept
			assert.deepStrictEqual(Object.keys(inherited), ['sizeTags']);
		});
		it('copies the default (editing options does not change the defaults)', () => {
			const opts = {};
			maskDefaults.overlay(opts, defaults, {});
			opts.sizeTags.enabled = true;
			assert.strictEqual(defaults.sizeTags.enabled, false);
		});
		it('follows a changed default while the member did not choose', () => {
			const opts = {};
			const inherited = {};
			maskDefaults.overlay(opts, { a: 1 }, inherited);
			maskDefaults.overlay(opts, { a: 2 }, inherited);
			assert.strictEqual(opts.a, 2);
		});
		it('leaves a value the member changed after it was inherited', () => {
			const opts = {};
			const inherited = {};
			maskDefaults.overlay(opts, { a: 1 }, inherited);
			opts.a = 5;
			maskDefaults.overlay(opts, { a: 2 }, inherited);
			assert.strictEqual(opts.a, 5);
			assert.deepStrictEqual(inherited, {});
		});
		it('removes an inherited value when the default is cleared, keeps a chosen one', () => {
			const opts = { b: 9 };
			const inherited = {};
			maskDefaults.overlay(opts, { a: 1, b: 2 }, inherited);
			assert.strictEqual(opts.a, 1);
			opts.a = 3;	// chosen
			maskDefaults.overlay(opts, {}, inherited);
			assert.strictEqual(opts.a, 3);
			assert.strictEqual(opts.b, 9);
			const o2 = {};
			const i2 = {};
			maskDefaults.overlay(o2, { x: 1 }, i2);
			maskDefaults.overlay(o2, {}, i2);
			assert.ok(!('x' in o2));
		});
		it('puts a default back after Settings > Reset deleted the key', () => {
			const opts = {};
			const inherited = {};
			maskDefaults.overlay(opts, { a: 1 }, inherited);
			delete opts.a;
			maskDefaults.overlay(opts, { a: 1 }, inherited);
			assert.strictEqual(opts.a, 1);
		});
		it('ignores denied and malformed keys from a bad server answer', () => {
			const opts = {};
			maskDefaults.overlay(opts, { masks: { active: '9.0' }, '__proto__x': 1, 'a b': 2, ok: 1 }, {});
			assert.deepStrictEqual(opts, { ok: 1 });
			maskDefaults.overlay(opts, [1, 2], {});
			maskDefaults.overlay(opts, null, {});
			assert.deepStrictEqual(opts, { ok: 1 });
		});
	});

	describe('strip (what is saved)', () => {
		it('leaves out inherited values the member did not change', () => {
			const inherited = { a: { x: 1 } };
			assert.deepStrictEqual(maskDefaults.strip({ a: { x: 1 }, b: 2 }, inherited), { b: 2 });
		});
		it('compares objects regardless of key order', () => {
			assert.deepStrictEqual(maskDefaults.strip({ a: { y: 2, x: 1 } }, { a: { x: 1, y: 2 } }), {});
		});
		it('keeps a changed value, so it becomes the member own choice', () => {
			assert.deepStrictEqual(maskDefaults.strip({ a: { x: 2 } }, { a: { x: 1 } }), { a: { x: 2 } });
		});
		it('does not touch data without inherited keys', () => {
			assert.deepStrictEqual(maskDefaults.strip({ a: 1 }, {}), { a: 1 });
		});
	});

	describe('isInherited', () => {
		it('is true while the value is the one applied', () => {
			assert.strictEqual(maskDefaults.isInherited({ a: 1 }, { a: 1 }, 'a'), true);
			assert.strictEqual(maskDefaults.isInherited({ a: 2 }, { a: 1 }, 'a'), false);
			assert.strictEqual(maskDefaults.isInherited({ a: 1 }, {}, 'a'), false);
		});
	});

	describe('pickable / collect', () => {
		it('offers settings that store an allowed options key, once per key, by label', () => {
			const items = [
				{ id: 'z', key: 'zeta', label: 'Zeta:' },
				{ id: 'a1', key: 'alpha', text: 'Alpha thing' },
				{ id: 'a2', key: 'alpha', label: 'Duplicate' },
				{ id: 'm', key: 'masks', label: 'Masks' },
				{ id: 'nokey', label: 'No key' }
			];
			assert.deepStrictEqual(maskDefaults.pickable(items), [{ key: 'alpha', label: 'Alpha thing' }, { key: 'zeta', label: 'Zeta' }]);
		});
		it('collects the current value of the picked keys only', () => {
			const opts = { a: { v: 1 }, b: 2, masks: { active: '1.0' } };
			const out = maskDefaults.collect(opts, ['a', 'missing', 'masks']);
			assert.deepStrictEqual(out, { a: { v: 1 } });
			out.a.v = 9;
			assert.strictEqual(opts.a.v, 1);
		});
	});

	describe('install (options.get / options.apply)', () => {
		it('saves without inherited keys and fills defaults on apply', () => {
			const fake = {
				a: undefined,
				applied: 0,
				get() { const d = {}; for (const k in this) { if (typeof this[k] !== 'function' && this[k] !== undefined && k !== 'maskDefaultsWrapped') d[k] = this[k]; } return d; },
				apply() { this.applied++; }
			};
			maskDefaults.defaults = { a: 7 };
			maskDefaults.inherited = {};
			maskDefaults.install(fake);
			fake.apply();
			assert.strictEqual(fake.a, 7);
			assert.strictEqual(fake.applied, 1);
			assert.ok(!('a' in fake.get()));
			fake.a = 8;
			assert.strictEqual(fake.get().a, 8);
			maskDefaults.defaults = {};
			maskDefaults.inherited = {};
		});
	});
});
