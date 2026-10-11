const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { include } = require('../helpers/helpers');
include('app/js/fork/mask-defaults');

describe('maskDefaults allow-list', () => {
	const root = path.join(__dirname, '..', '..', '..');

	it('is the same list as the server and as the keys the Settings rows store', () => {
		const php = fs.readFileSync(path.join(root, 'maskadmin/maskadmin.inc.php'), 'utf8');
		const body = php.match(/const MASKADMIN_DEFAULTS_ALLOW = \[([^\]]*)\]/)[1];
		const server = [...body.matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1]).sort();
		const keys = new Set();
		const dir = path.join(root, 'app/js/fork');
		fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'settings-sections.js').forEach(f => {
			fs.readFileSync(path.join(dir, f), 'utf8').split('forkSettings.register(').slice(1).forEach(chunk => {
				const m = chunk.slice(0, 900).match(/\bkey:\s*"([A-Za-z0-9_]+)"/);
				if (m) { keys.add(m[1]); }
			});
		});
		assert.deepStrictEqual(maskDefaults.ALLOWED.slice(0, 27).sort(), server);
		assert.deepStrictEqual([...keys].sort(), server);
	});

	it('rejects keys that are not Settings keys, including prototype names', () => {
		['other', 'masks', 'chain', '__proto__', 'constructor', 'prototype', 'hasOwnProperty', ''].forEach(k => {
			assert.strictEqual(maskDefaults.allowedKey(k), false, k);
		});
		const polluted = JSON.parse('{"__proto__": {"x": 1}, "constructor": {"y": 1}, "sizeTags": {"enabled": true}}');
		const opts = {};
		maskDefaults.overlay(opts, polluted, {});
		assert.deepStrictEqual(Object.keys(opts), ['sizeTags']);
		assert.strictEqual({}.x, undefined);
	});
});
