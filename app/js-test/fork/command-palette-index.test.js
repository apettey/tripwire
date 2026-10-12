const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/command-palette-index');

const item = (def) => paletteIndex.item(Object.assign({ kind: 'cmd' }, def));
const titles = (res) => res.results.map(r => r.title);

describe('Command palette index', () => {
	describe('normalise', () => {
		it('lower-cases and drops dashes and spaces', () => {
			assert.equal(paletteIndex.normalise('ABC-123'), 'abc123');
			assert.equal(paletteIndex.normalise('Fight  here'), 'fighthere');
			assert.equal(paletteIndex.normalise(undefined), '');
		});
		it('indexes a J-code with and without the J', () => {
			const eve = paletteIndex.buildEve({ 31000001: { name: 'J123456' }, 30000142: { name: 'Jita' } });
			assert.deepEqual(eve.alts, ['', '123456']);	// numeric keys iterate in ascending order
			const idx = paletteIndex.build([], eve);
			assert.deepEqual(titles(paletteIndex.search(idx, '123456')), ['J123456']);
			assert.deepEqual(titles(paletteIndex.search(idx, 'j123456')), ['J123456']);
		});
	});

	describe('match tiers', () => {
		const q = (query, key, fuzzy) => paletteIndex.matchScore(query, paletteIndex.normalise(key), fuzzy);
		it('exact > prefix > substring > fuzzy', () => {
			const exact = q('jita', 'Jita'), prefix = q('jit', 'Jita'), sub = q('ita', 'Jita'), fuzzy = q('jta', 'Jita', true);
			assert.equal(exact, 1000);
			assert.ok(exact > prefix && prefix > sub && sub > fuzzy && fuzzy >= 50, [exact, prefix, sub, fuzzy].join());
		});
		it('a shorter key wins a prefix tie', () => {
			assert.ok(q('ab', 'abc') > q('ab', 'abcdef'));
		});
		it('substring scores fall with the start index', () => {
			assert.ok(q('x', 'axb') > q('x', 'aaaxb'));
		});
		it('fuzzy needs the letters in order and respects the switch', () => {
			assert.equal(q('zq', 'Jita', true), 0);
			assert.equal(q('jta', 'Jita', false), 0);
			assert.ok(q('jta', 'Jita', true) > 0);
		});
		it('fuzzy prefers fewer gaps and a smaller span', () => {
			assert.ok(paletteIndex.fuzzyScore('abc', 'abxc') > paletteIndex.fuzzyScore('abc', 'axbxc'));
			assert.ok(paletteIndex.fuzzyScore('abc', 'axbxcxxxxxxxxxxxxxxxx') >= 50);
		});
	});

	describe('acronym', () => {
		it('first letters of the words', () => {
			assert.equal(paletteIndex.acronym('Fight here'), 'fh');
			assert.equal(paletteIndex.acronym('Preserve mass'), 'pm');
			assert.equal(paletteIndex.acronym('Show/hide panel'), 'shp');
		});
		it('finds "fh" -> "Fight here" and "pm" -> "Preserve mass" above a plain substring', () => {
			const idx = paletteIndex.build([
				item({ key: 'a', title: 'Fight here' }), item({ key: 'b', title: 'Preserve mass' }), item({ key: 'c', title: 'Soft hhh', fuzzy: false })
			]);
			assert.equal(titles(paletteIndex.search(idx, 'fh'))[0], 'Fight here');
			assert.equal(titles(paletteIndex.search(idx, 'pm'))[0], 'Preserve mass');
			assert.equal(paletteIndex.search(idx, 'fh').results[0].score, 650 + 100);
		});
	});

	describe('EVE systems', () => {
		it('match by prefix and substring only, no fuzzy', () => {
			const eve = paletteIndex.buildEve({ 1: { name: 'Jita' }, 2: { name: 'Amarr' } });
			const idx = paletteIndex.build([], eve);
			assert.deepEqual(titles(paletteIndex.search(idx, 'jit')), ['Jita']);
			assert.deepEqual(titles(paletteIndex.search(idx, 'mar')), ['Amarr']);
			assert.deepEqual(titles(paletteIndex.search(idx, 'jta')), []);
		});
		it('skips a system already listed as a chain system', () => {
			const eve = paletteIndex.buildEve({ 1: { name: 'Jita' } });
			const chainItem = item({ key: 'sys:1', kind: 'chain', title: 'Jita', systemID: 1 });
			const idx = paletteIndex.build([chainItem], eve, { 1: true });
			assert.equal(paletteIndex.search(idx, 'jita').results.length, 1);
			assert.equal(paletteIndex.search(idx, 'jita').results[0].kind, 'chain');
		});
		it('builds result rows through make()', () => {
			const eve = paletteIndex.buildEve({ 7: { name: 'Rens' } }, (j) => ({ key: 'eve:7', kind: 'eve', title: 'Rens', subtitle: 'HS' }));
			const res = paletteIndex.search(paletteIndex.build([], eve), 'ren');
			assert.equal(res.results[0].subtitle, 'HS');
			assert.equal(typeof res.results[0].score, 'number');
		});
	});

	describe('pinning', () => {
		it('an exact J-code is first, even over a command with a better kind weight and frecency', () => {
			const eve = paletteIndex.buildEve({ 31000001: { name: 'J123456' } });
			const idx = paletteIndex.build([item({ key: 'cmd:x', title: '123456', keys: [] })], eve);
			const res = paletteIndex.search(idx, '123456', { frecency: { 'cmd:x': { n: 50, t: Date.now() } } });
			assert.equal(res.results[0].title, 'J123456');
		});
		it('an exact chain J-code is pinned', () => {
			const idx = paletteIndex.build([
				item({ key: 'sys:1', kind: 'chain', title: 'J123456', pin: true, keys: ['123456'] }),
				item({ key: 'cmd:x', title: '123456', keys: [] })
			]);
			assert.equal(paletteIndex.search(idx, '123456').results[0].key, 'sys:1');
		});
		it('looksLikeSigId matches abc, abc1 and abc-123', () => {
			['abc', 'abc1', 'abc123'].forEach(s => assert.ok(paletteIndex.looksLikeSigId(s), s));
			['ab', 'abcd', '123', 'abc1234'].forEach(s => assert.ok(!paletteIndex.looksLikeSigId(s), s));
		});
		it('an exact signature ID is first; a sig-like query lifts signatures', () => {
			const idx = paletteIndex.build([
				item({ key: 'sig:1', kind: 'sig', title: 'ABC-123', keys: ['abc123'], pin: true }),
				item({ key: 'cmd:abc', title: 'Abc123 helper', keys: [] }),
				item({ key: 'sig:2', kind: 'sig', title: 'ABD-999', keys: ['abd999'], pin: true })
			]);
			assert.equal(paletteIndex.search(idx, 'abc-123').results[0].key, 'sig:1');
			const prefix = paletteIndex.search(idx, 'abc');
			assert.equal(prefix.results[0].key, 'sig:1');	// 800-6 + 200 vs the command's 800-12 + 100
		});
	});

	describe('frecency', () => {
		const now = 1e12;
		it('boost grows with uses and is capped at 200', () => {
			assert.equal(paletteIndex.frecencyBoost(null, now), 0);
			const one = paletteIndex.frecencyBoost({ n: 1, t: now }, now), seven = paletteIndex.frecencyBoost({ n: 7, t: now }, now);
			assert.ok(one > 0 && seven > one);
			assert.equal(paletteIndex.frecencyBoost({ n: 1e9, t: now }, now), 200);
			assert.ok(Math.abs(one - 60) < 1e-9);
		});
		it('halves every 7 days', () => {
			const fresh = paletteIndex.frecencyBoost({ n: 3, t: now }, now);
			const week = paletteIndex.frecencyBoost({ n: 3, t: now - 7 * paletteIndex.DAY }, now);
			assert.ok(Math.abs(week - fresh / 2) < 1e-9);
		});
		it('reorders results', () => {
			const idx = paletteIndex.build([item({ key: 'a', title: 'Alpha one' }), item({ key: 'b', title: 'Alpha two' })]);
			assert.equal(paletteIndex.search(idx, 'alpha', { now: now }).results[0].key, 'a');
			assert.equal(paletteIndex.search(idx, 'alpha', { now: now, frecency: { b: { n: 3, t: now } } }).results[0].key, 'b');
		});
		it('frecencyTouch counts, stamps and keeps the 200 most recent', () => {
			let map = {};
			paletteIndex.frecencyTouch(map, 'a', 5);
			paletteIndex.frecencyTouch(map, 'a', 6);
			assert.deepEqual(map.a, { n: 2, t: 6 });
			for (let i = 0; i < 250; i++) { paletteIndex.frecencyTouch(map, 'k' + i, 100 + i); }
			assert.equal(Object.keys(map).length, 200);
			assert.ok(map.k249 && !map.a && !map.k0);
		});
		it('recent lists keys most recent first and survives bad input', () => {
			assert.deepEqual(paletteIndex.recent({ a: { n: 1, t: 1 }, b: { n: 1, t: 3 }, c: { n: 1, t: 2 } }, 2), ['b', 'c']);
			assert.deepEqual(paletteIndex.recent(null, 5), []);
			assert.deepEqual(paletteIndex.frecencyTouch(null, 'x', 1), { x: { n: 1, t: 1 } });
		});
	});

	describe('context and disabled', () => {
		it('context items rank above equal matches', () => {
			const idx = paletteIndex.build([item({ key: 'a', title: 'Same one' }), item({ key: 'b', title: 'Same two', ctx: 120 })]);
			assert.equal(paletteIndex.search(idx, 'same').results[0].key, 'b');
		});
		it('a disabled command stays listed but ranks below enabled ones', () => {
			const idx = paletteIndex.build([item({ key: 'a', title: 'Roll hole', disabled: 'No hole' }), item({ key: 'b', title: 'Roll the dice' })]);
			const res = paletteIndex.search(idx, 'roll');
			assert.deepEqual(res.results.map(r => r.key), ['b', 'a']);
			assert.equal(res.results[1].disabled, 'No hole');
		});
		it('ties: shorter title, then alphabetical, then key', () => {
			const idx = paletteIndex.build([
				item({ key: 'k3', title: 'Beta', keys: ['q'] }), item({ key: 'k1', title: 'Alpha', keys: ['q'] }),
				item({ key: 'k2', title: 'Alpha', keys: ['q'] }), item({ key: 'k4', title: 'Ab', keys: ['q'] })
			]);
			assert.deepEqual(paletteIndex.search(idx, 'q').results.map(r => r.key), ['k4', 'k3', 'k1', 'k2']);
		});
	});

	describe('scopes', () => {
		it('parseScope reads the prefix character', () => {
			assert.equal(paletteIndex.parseScope('>undo').rest, 'undo');
			assert.deepEqual(Object.keys(paletteIndex.parseScope('@jita').kinds).sort(), ['chain', 'eve']);
			assert.equal(paletteIndex.parseScope('#abc').label, 'Signatures');
			assert.equal(paletteIndex.parseScope(',mute').label, 'Settings');
			assert.equal(paletteIndex.parseScope('jita').char, '');
		});
		it('search honours a scope', () => {
			const idx = paletteIndex.build([item({ key: 'c', title: 'Mute sounds' }), item({ key: 's', kind: 'setting', title: 'Mute button' })]);
			assert.deepEqual(paletteIndex.search(idx, 'mute', { scope: { setting: true } }).results.map(r => r.key), ['s']);
			assert.deepEqual(paletteIndex.search(idx, 'mute', { scope: { cmd: true } }).results.map(r => r.key), ['c']);
		});
	});

	describe('incremental narrowing', () => {
		const eveSystems = {}, items = [];
		const words = ['alpha', 'alpine', 'amber', 'arrow', 'bravo', 'bridge', 'delta', 'dream', 'ember', 'fox', 'fight', 'flare', 'gamma', 'hotel', 'jump', 'jade'];
		for (let i = 0; i < 400; i++) { eveSystems[30000000 + i] = { name: words[i % words.length] + '-' + (i * 7919 % 1000) }; }
		for (let i = 0; i < 60; i++) { items.push(item({ key: 'c' + i, title: words[(i * 3) % words.length] + ' ' + words[(i * 5) % words.length] })); }
		const idx = paletteIndex.build(items, paletteIndex.buildEve(eveSystems));
		it('gives the same top 50 as a full search for every prefix of a query', () => {
			['alp', 'fight', 'a b', 'j', 'dr'].forEach(full => {
				let prev = null;
				for (let n = 1; n <= full.length; n++) {
					const inc = paletteIndex.search(idx, full.substring(0, n), { prev: prev });
					const ref = paletteIndex.search(idx, full.substring(0, n));
					assert.deepEqual(inc.results.map(r => r.key || r.title), ref.results.map(r => r.key || r.title), full.substring(0, n));
					assert.equal(inc.total, ref.total);
					prev = inc;
				}
			});
		});
		it('rescoring only the previous matches does less work', () => {
			const first = paletteIndex.search(idx, 'al');
			const second = paletteIndex.search(idx, 'alp', { prev: first });
			assert.ok(second.total <= first.total);
		});
		it('a different scope or a shorter query starts again', () => {
			const first = paletteIndex.search(idx, 'alpha');
			const shorter = paletteIndex.search(idx, 'alp', { prev: first });
			assert.deepEqual(shorter.results.map(r => r.title), paletteIndex.search(idx, 'alp').results.map(r => r.title));
		});
		it('limits the results to 50', () => {
			assert.ok(paletteIndex.search(idx, 'a').results.length <= 50);
		});
	});

	describe('highlight', () => {
		it('substring, ignoring dashes and case', () => {
			assert.deepEqual(paletteIndex.highlight('B-2UL0', 'b2'), [0, 2]);
			assert.deepEqual(paletteIndex.highlight('Jita', 'jit'), [0, 1, 2]);
		});
		it('word-start acronym and subsequence', () => {
			assert.deepEqual(paletteIndex.highlight('Fight here', 'fh'), [0, 6]);
			assert.deepEqual(paletteIndex.highlight('Jita', 'jta'), [0, 2, 3]);
			assert.deepEqual(paletteIndex.highlight('Jita', 'zzz'), []);
			assert.deepEqual(paletteIndex.highlight('Jita', ''), []);
		});
	});

	describe('performance (A8: 200 chain systems + 8,500 EVE systems + 300 commands + 150 settings)', () => {
		const eveSystems = {};
		const syll = ['an', 'ko', 'ri', 'ta', 'mo', 'ze', 'vu', 'lo', 'pa', 'qi'];
		for (let i = 0; i < 8500; i++) {
			const a = syll[i % 10] + syll[(i >> 3) % 10] + syll[(i * 7) % 10];
			eveSystems[30000000 + i] = { name: i % 5 === 0 ? 'J' + (100000 + i) : a.charAt(0).toUpperCase() + a.slice(1) + '-' + (i % 97) };
		}
		const dyn = [];
		for (let i = 0; i < 200; i++) { dyn.push(item({ key: 'sys:' + i, kind: 'chain', title: 'J' + (200000 + i * 13), keys: [String(200000 + i * 13), 'B' + (i % 20), 'C' + (i % 6), 'H296'], ctx: i % 40 === 0 ? 60 : 0, pin: true })); }
		for (let i = 0; i < 300; i++) { dyn.push(item({ key: 'cmd:' + i, title: 'Command number ' + i + ' ' + syll[i % 10] + ' action', keys: ['group' + (i % 8)] })); }
		for (let i = 0; i < 150; i++) { dyn.push(item({ key: 'set:' + i, kind: 'setting', title: 'Setting ' + syll[i % 10] + ' option ' + i, keys: ['Section ' + (i % 9)] })); }
		const idx = paletteIndex.build(dyn, paletteIndex.buildEve(eveSystems));
		const frecency = { 'cmd:3': { n: 5, t: Date.now() }, 'sys:7': { n: 2, t: Date.now() } };
		const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

		it('typing 20 queries keystroke by keystroke: median search < 40 ms (spec 16 ms incl. render)', () => {
			const queries = ['ko', 'koa', 'koan', 'j2', 'j20', 'j2000', 'comm', 'command n', 'sett', 'setting ko', 'an', 'ri', 'b3', 'h29', 'c2', 'mo', 'moz', 'moze', 'pa', 'pa-'];
			const times = [];
			let prev = null;
			// warm-up
			paletteIndex.search(idx, 'zz');
			queries.forEach(q => {
				const started = process.hrtime.bigint();
				const res = paletteIndex.search(idx, q, { frecency: frecency, prev: (prev && q.indexOf(prev.query) === 0) ? prev : null });
				times.push(Number(process.hrtime.bigint() - started) / 1e6);
				prev = res;
				assert.ok(res.results.length <= 50);
			});
			const m = median(times);
			console.log('      median ' + m.toFixed(2) + ' ms, max ' + Math.max.apply(null, times).toFixed(2) + ' ms over ' + times.length + ' queries');
			assert.ok(m < 40, 'median ' + m);
		});
		it('a cold one-letter query over everything stays fast', () => {
			const started = process.hrtime.bigint();
			paletteIndex.search(idx, 'a');
			const ms = Number(process.hrtime.bigint() - started) / 1e6;
			console.log('      cold single-letter query ' + ms.toFixed(2) + ' ms');
			assert.ok(ms < 80, 'took ' + ms);
		});
		it('building the 8,500-system EVE index is quick (spec: <= 15 ms)', () => {
			const started = process.hrtime.bigint();
			paletteIndex.buildEve(eveSystems);
			const ms = Number(process.hrtime.bigint() - started) / 1e6;
			console.log('      EVE index ' + ms.toFixed(2) + ' ms');
			assert.ok(ms < 60, 'took ' + ms);
		});
	});
});
