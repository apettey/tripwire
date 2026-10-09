const assert = require('assert');
const { include, fakeAjax } = require('../helpers/helpers');

fakeAjax();
include('app/js/map-data-suppliers/eve-scout');
//include('app/js/map-data-suppliers/old-thera');
//const eveScout = thera;

describe('EvE-Scout data', () => {
	describe('Thera', () => { 
//		fakeAjax('cached_third_party.php?key=thera', 'app/js-test/testdata/old-thera-modified.json');
		fakeAjax('cached_third_party.php?key=eve-scout-signatures', 'app/js-test/testdata/eve-scout-sigs-small.json');
		
		let ids;
		beforeEach(() => {
			options = { chain: { tabs: [ { evescout: true } ], active: 0 } };
			chain = { redraw: () => {} };
			eveScout.refresh();
			
			ids = { parentID: 100, nextChildID: 200 };
		});

		it('Active', () => assert.equal(eveScout.active(), true) );
		it('Links from Thera', () => {			
			const result = eveScout.findLinks(31000005, ids);
			assert.deepEqual( result, [{
			  "id": "ES-135",
			  "life": "critical",
			  "mass": "stable",
			  "parent": {
				"id": 100,
				"signatureID": "TVK-336",
				"systemID": 31000005,
				"type": "K162"
			  },
			  "child": {
				"id": 200,
				"signatureID": "IFN-322",
				"systemID": 30003880,
				"type": "T458",
			  }
			},
			{
			  "id": "ES-136",
			  "life": "stable",
			  "mass": "stable",
			  "parent": {
				"id": 100,
				"signatureID": "CVD-320",
				"systemID": 31000005,
				"type": "V898"
			  },
			  "child": {
				"id": 201,
				"signatureID": "AOX-264",
				"systemID": 30003486,
				"type": "K162",
			  }
			}], 'sigs');
			assert.deepEqual(ids, { parentID: 100, nextChildID: 202 }, 'ids' );
		});
		it('Links from system with hole to Thera', () => {			
			const result = eveScout.findLinks(30003880, ids);
			assert.deepEqual( result, [{
			  "id": "ES-135",
			  "life": "critical",
			  "mass": "stable",
			  "child": {
				"id": 200,
				"signatureID": "TVK-336",
				"systemID": 31000005,
				"type": "K162"
			  },
			  "parent": {
				"id": 100,
				"signatureID": "IFN-322",
				"systemID": 30003880,
				"type": "T458",
			  }
			}], 'sigs');
			assert.deepEqual(ids, { parentID: 100, nextChildID: 201 }, 'ids' );
		});		
		it('Links from system with hole from Thera', () => {			
			const result = eveScout.findLinks(30003486, ids);
			assert.deepEqual( result, [{
			  "id": "ES-136",
			  "life": "stable",
			  "mass": "stable",
			  "child": {
				"id": 200,
				"signatureID": "CVD-320",
				"systemID": 31000005,
				"type": "V898"
			  },
			  "parent": {
				"id": 100,
				"signatureID": "AOX-264",
				"systemID": 30003486,
				"type": "K162",
			  }
			}], 'sigs');
			assert.deepEqual(ids, { parentID: 100, nextChildID: 201 }, 'ids' );
		});	
	});
});
	