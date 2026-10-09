const assert = require('assert');
const { include } = require('./helpers/helpers');
include('app/js/systemAnalysis');
include('public/js/combine');

describe('System analysis', () => {
	describe('should match for edge case systems', () => {
		it('Egghelende', () => {
			assert.deepEqual(systemAnalysis.analyse(30002693), {
				 baseSecurity: 0.449268,
				  class: undefined,
				  constellationID: 20000394,
				  effectClass: undefined,
				  factionID: 500004,
				  genericSystemType: [
					'Low-Sec'
				  ],
				  name: 'Egghelende',
				  pathSymbol: '■',
				  regionID: 10000032,
				  security: 0.449268,
				  systemID: 30002693,
				  systemTypeClass: 'lowsec',
				  systemTypeModifiers: [],
				  systemTypeName: 'LS'
			});
		});
		it('Erila', () => {
			assert.deepEqual(systemAnalysis.analyse(30002742), {
				  baseSecurity: 0.448706,
				  class: undefined,
				  constellationID: 20000401,
				  effectClass: undefined,
				  factionID: 500001,
				  genericSystemType: [
					'Low-Sec'
				  ],
				  name: 'Erila',
				  pathSymbol: '■',
				  regionID: 10000033,
				  security: 0.448706,
				  systemID: 30002742,
				  systemTypeClass: 'lowsec',
				  systemTypeModifiers: [],
				  systemTypeName: 'LS'
			});
		});
	});
	
});
