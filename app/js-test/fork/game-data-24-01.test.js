const assert = require('assert');
const fs = require('fs');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/wormholeAnalysis');
include('app/js/systemAnalysis');
include('app/js/fork/rolling-guide');
include('app/js/fork/rolling-calculator');

// Game data from Patch Notes Version 24.01 (releases 2026-09-22.1, 2026-10-06.1, 2026-10-07.1), checked against public
// ESI GET /universe/types/{id}/ on 2026-11-15 (wormholes: dogma 1382 life in minutes, 1383 total mass, 1385 jump mass).
// Pinned so an upstream sync can't bring back older values: upstream Tripwire 2.0 (a9c49177) has the intra-Pochven
// holes at "5 Hours" and F216 at 300,000,000 jump mass.
const tools = f => JSON.parse(fs.readFileSync('tools/' + f + '.json', 'utf8'));

/** Keys that appear more than once in a JSON object literal at the given indent (JSON.parse keeps only the last) */
function duplicateKeys(text, indent) {
	const seen = {}, dupes = [];
	const re = new RegExp('^' + indent + '"([^"]+)"\\s*:', 'gm');
	let m;
	while ((m = re.exec(text))) {
		if (seen[m[1]]) { dupes.push(m[1]); }
		seen[m[1]] = true;
	}
	return dupes;
}

describe('Game data, patch 24.01', () => {
	describe('Pochven wormholes', () => {
		// type: [life, total mass, jump mass, from, leadsTo]
		const holes = {
			// intra-Pochven (2026-09-22.1: 750,000,000 kg, up from 100,000,000; 12 hours, up from 4.5)
			I078: ['12 Hours', 750e6, 62e6, 'Triglavian', 'Triglavian'],
			L687: ['12 Hours', 750e6, 62e6, 'Triglavian', 'Triglavian'],
			O546: ['12 Hours', 750e6, 62e6, 'Triglavian', 'Triglavian'],
			// extra-Pochven
			C729: ['12 Hours', 1e9, 410e6, ['High-Sec', 'Low-Sec', 'Null-Sec', 'Triglavian'], 'Triglavian'],
			F216: ['12 Hours', 1e9, 375e6, ['Class-2', 'Class-3', 'Class-4', 'Class-5', 'Class-6'], 'Triglavian'],
			U372: ['12 Hours', 1e9, 375e6, 'Null-Sec', 'Triglavian'],
			R081: ['12 Hours', 1e9, 375e6, 'Triglavian', 'Class-4'],
			X450: ['12 Hours', 1e9, 375e6, 'Triglavian', 'Null-Sec'],
			// 2026-10-06.1: new Extra-Pochven holes in Blood Raider Delve (null-sec) and Eugidi/Angils/Essin (low-sec)
			O753: ['12 Hours', 1e9, 375e6, ['Low-Sec', 'Null-Sec'], 'Triglavian'],
			R327: ['12 Hours', 1e9, 375e6, ['Low-Sec', 'Null-Sec'], 'Triglavian']
		};
		const expected = v => ({ life: v[0], from: v[3], leadsTo: v[4], mass: v[1], jump: v[2] });
		const json = tools('wormholes');
		const api = JSON.parse(fs.readFileSync('api/wormhole-types.json', 'utf8'));

		Object.keys(holes).forEach(type => {
			const v = holes[type];
			it(type + ' in tools/wormholes.json', () => assert.deepStrictEqual(json[type], expected(v)));
			it(type + ' in combine.js (appData.wormholes)', () => assert.deepStrictEqual(appData.wormholes[type], expected(v)));
			it(type + ' in the REST API copy', () => assert.deepStrictEqual(api[type], { jump: v[2], mass: v[1], life: v[0], leadsTo: v[4] }));
			it(type + ' pre-fills a 12 h signature timer', () => assert.strictEqual(parseFloat(appData.wormholes[type].life) * 60 * 60, 43200));
		});

		it('no wormhole type is listed twice (a merge could add upstream\'s copies after ours)', () => {
			assert.deepStrictEqual(duplicateKeys(fs.readFileSync('tools/wormholes.json', 'utf8'), ''), []);
			assert.deepStrictEqual(duplicateKeys(fs.readFileSync('api/wormhole-types.json', 'utf8'), ' ?'), []);
			const combine = fs.readFileSync('public/js/combine.js', 'latin1');
			const start = combine.indexOf('    "wormholes": {'), end = combine.indexOf('\n    }', start);
			assert.ok(start > 0 && end > start);
			assert.deepStrictEqual(duplicateKeys(combine.slice(start, end), '        '), []);
		});

		it('the mapper offers the intra-Pochven types between two Pochven systems', () => {
			const pochven = Object.keys(appData.systems).filter(id => appData.systems[id].factionID == 500026);
			assert.ok(pochven.length >= 27);
			const offered = wormholeAnalysis.eligibleWormholeTypes(pochven[0], pochven[1]);
			['I078', 'L687', 'O546'].forEach(t => {
				assert.ok(offered.from.some(w => w.key === t), t + ' from');
				assert.ok(offered.to.some(w => w.key === t), t + ' to');
			});
		});

		it('rolling: an untouched intra-Pochven hole has 675,000,000-825,000,000 kg left (750,000,000 +-10 %)', () => {
			const r = rollingCalc.remaining(appData.wormholes.I078.mass, 0);
			assert.ok(Math.abs(r.min - 675e6) < 1 && Math.abs(r.max - 825e6) < 1, r.min + '-' + r.max);
		});

		it('rolling guide: intra-Pochven holes are too small for battleships, extra-Pochven ones take 1b', () => {
			['I078', 'L687', 'O546'].forEach(t => assert.strictEqual(rollingGuide.guideFor(t, appData.wormholes), null, t));
			['C729', 'F216', 'U372', 'R081', 'X450', 'O753', 'R327'].forEach(t => assert.strictEqual(rollingGuide.guideFor(t, appData.wormholes), '1b', t));
		});
	});
});

module.exports = { duplicateKeys };
