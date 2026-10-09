const assert = require('assert');
const { include, fakeAjax } = require('./helpers/helpers');
include('public/js/lodash');

global.setInterval = () => {};
console.info = () => {};
guidance = { jumpCostModifiers:[] };
tripwire = { systemChange: () => {} };
viewingSystemID = 30000001;
fakeAjax();

include('app/js/fw');

describe('Faction warfare', () => {
	it('System data parsed', () => { 
		fakeAjax('cached_third_party.php?key=fw', 'app/js-test/testdata/fw.json');
		fw.refresh();
		const data = fw.systems[30003842];
		assert.deepEqual(500001, data.occupier_faction_id);
	});
	// Routing is tested in guidance.test.js
	it('Samanuni Gate open when Athounon is Caldari', () => { 
		fakeAjax('cached_third_party.php?key=fw', 'app/js-test/testdata/fw.json');
		fw.refresh();
		assert.deepEqual(true, fw.SamanuniAthounonGateOpen);
		assert.deepEqual(1, fw.adjustJumpCost(3856, 45322, 1));
		assert.deepEqual(1, fw.adjustJumpCost(45322, 3856, 1));
		assert.deepEqual(1, fw.adjustJumpCost(45322, 3840, 1));	// check a different jump isn't blocked
	});	
	it('Samanuni Gate closed when Athounon is Gallente', () => { 
		fakeAjax('cached_third_party.php?key=fw', 'app/js-test/testdata/fw-athounon-gallente.json');
		fw.refresh();
		assert.deepEqual(false, fw.SamanuniAthounonGateOpen);
		assert.deepEqual(-1, fw.adjustJumpCost(3856, 45322));
		assert.deepEqual(-1, fw.adjustJumpCost(45322, 3856));
		assert.deepEqual(1, fw.adjustJumpCost(45322, 3840, 1));	// check a different jump isn't blocked
	});	
	
	describe('Faction text', () => {
		before(() => {
			fakeAjax('cached_third_party.php?key=fw', 'app/js-test/testdata/fw.json');
			fw.refresh();
		});

		it('Faction text for non-FW system', () => assert.deepEqual('Caldari State', fw.factionMarkup( { systemID: 1, factionID: 500001 })));
		it('Faction text for non-faction system', () => assert.deepEqual('&nbsp;', fw.factionMarkup( { systemID: 1 })));
		it('Faction text for uncontested FW system', () => assert.deepEqual('Gallente Federation (FW: uncontested)', fw.factionMarkup( { systemID: 30005298, factionID: 500004 })));
		it('Faction text for contested FW system', () => assert.deepEqual('Gallente Federation (FW: 51% contested)', fw.factionMarkup( { systemID: 30005297, factionID: 500004 })));
	});
});