const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/tripwire/genericSystemTypes');
include('app/js/wormholeAnalysis');
include('app/js/systemAnalysis');
jQuery = { fn: {} };
include('app/js/helpers');

// Drifter holes (scannable since Catalyst, 2026-03-18) lead to a Drifter system class, like every other type
describe('Drifter wormhole types', () => {
	const keys = types => types.from.map(w => w.key);
	const holes = { S877: [14, 31000001], B735: [15, 31000002], V928: [16, 31000003], C414: [17, 31000004], R259: [18, 31000006] };

	Object.keys(holes).forEach(key => {
		const cls = holes[key][0], systemID = holes[key][1];
		it(key + ' leads to Class-' + cls, () => assert.equal(appData.wormholes[key].leadsTo, 'Class-' + cls));
		it(key + ' is offered from null-sec to its Drifter system', () => {
			assert.ok(keys(wormholeAnalysis.eligibleWormholeTypes(appData.genericSystemTypes.indexOf('Null-Sec'), systemID)).indexOf(key) >= 0);
		});
		it(key + ' is not offered to the other Drifter systems', () => {
			Object.keys(holes).filter(k => k !== key).forEach(k => {
				assert.ok(keys(wormholeAnalysis.eligibleWormholeTypes(appData.genericSystemTypes.indexOf('Null-Sec'), holes[k][1])).indexOf(key) < 0, k);
			});
		});
		it(key + ' knows its target from the type alone', () => {
			assert.equal(wormholeAnalysis.targetSystemID(undefined, key), appData.genericSystemTypes.indexOf('Class-' + cls));
		});
	});
});
