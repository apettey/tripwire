const assert = require('assert');
const { include } = require('./helpers/helpers');
tripwire = {};
include('public/js/combine');
include('app/js/tripwire/automapper');

// Sample well known systems for 'leads to' in sigs
const C1 = 31000083, C2 = 31000537, C3 = 31001053, C4 = 31001477, C5 = 31001916, C6 = 31002464,
	HS = 30000001, LS = 30000162;

describe('Automap - wormhole evaluation', () => {
	describe('J->J', () => {
		it('All sigs have known exit', () => assert.deepEqual(
			wormholesForJump(C1, C2 + 1, {
				'10': { initialID: 11, secondaryID: 12 },
				'20': { initialID: 21, secondaryID: 22 },
				'30': { initialID: 31, secondaryID: 32 }
			}, {
				'11': { systemID: C1 }, 12: { systemID: C2 },
				'21': { systemID: C1 }, 22: { systemID: C3 },
				'31': { systemID: C1 }, 32: { systemID: C4 },
			})
			, []
		));
		it('Sigs have type exit', () => assert.deepEqual(
			wormholesForJump(C1, C2, {
				'10': { initialID: 11, secondaryID: 12 },
				'20': { initialID: 21, secondaryID: 22 },
				'30': { initialID: 31, secondaryID: 32 }
			}, {
				'11': { systemID: C1 }, 12: { systemID: 4 },	// C2
				'21': { systemID: C1 }, 22: { systemID: 5 },	// C3
				'31': { systemID: C1 }, 32: { systemID: 6 }, 	// C4
			})
			, [ { initialID: 11, secondaryID: 12 } ]
		));		
		it('Sigs have multi-type exit', () => assert.deepEqual(
			wormholesForJump(C1, C2, {
				'10': { initialID: 11, secondaryID: 12 },
				'20': { initialID: 21, secondaryID: 22 },
				'30': { initialID: 31, secondaryID: 32 }
			}, {
				'11': { systemID: C1 }, 12: { systemID: 11 },	// C1-3
				'21': { systemID: C1 }, 22: { systemID: 12 },	// C2/3
				'31': { systemID: C1 }, 32: { systemID: 13 }, 	// C4/5
			})
			, [ { initialID: 11, secondaryID: 12 }, { initialID: 21, secondaryID: 22 } ]
		));	
		it('Sigs have wormhole type', () => assert.deepEqual(
			wormholesForJump(C4, C2, {
				'10': { initialID: 11, secondaryID: 12, type: 'P060' },
				'20': { initialID: 21, secondaryID: 22, type: 'N766' },
				'30': { initialID: 31, secondaryID: 32, type: 'X877' }
			}, {
				'11': { systemID: C4 }, 12: { systemID: null },	
				'21': { systemID: C4 }, 22: { systemID: null },	
				'31': { systemID: C4 }, 32: { systemID: null }, 	
			})
			, [ { initialID: 21, secondaryID: 22, type: 'N766' } ]
		));		
		it('Sigs have unknown target', () => assert.deepEqual(
			wormholesForJump(C4, C2, {
				'10': { initialID: 11, secondaryID: 12 }
			}, {
				'11': { systemID: C4 }, 12: { systemID: null }
			})
			, [ { initialID: 11, secondaryID: 12 } ]
		));			
	});
	
	describe('Other types', () => {
		it('J -> K', () => {
			const outHoles = {
				'10': { initialID: 11, secondaryID: 12, type: 'B274' },	// match by type
				'20': { initialID: 21, secondaryID: 22 }, // match by class
				'30': { initialID: 31, secondaryID: 32 } // match by no info
			};
			const allHoles = Object.assign({
				'40': { initialID: 41, secondaryID: 42 },	// target is wrong class
				'50': { initialID: 51, secondaryID: 52, type: 'D382' },	// wrong type
			}, outHoles);
			assert.deepEqual(wormholesForJump(C2, HS, allHoles, {
				'11': { systemID: C2 }, 12: { systemID: null },	
				'21': { systemID: C2 }, 22: { systemID: 2 },	
				'31': { systemID: C2 }, 32: { systemID: null }, 	
				'41': { systemID: C2 }, 42: { systemID: 1 }, 	
				'51': { systemID: C2 }, 52: { systemID: null }, 	
			}), Object.values(outHoles)
			);
		});		
		it('K -> K', () => {
			const outHoles = {
				'10': { initialID: 11, secondaryID: 12, type: 'R051' },	// match by type
				'20': { initialID: 21, secondaryID: 22 }, // match by class
				'30': { initialID: 31, secondaryID: 32 } // match by no info
			};
			const allHoles = Object.assign({
				'40': { initialID: 41, secondaryID: 42 },	// target is wrong class
				'50': { initialID: 51, secondaryID: 52, type: 'M555' },	// wrong type
			}, outHoles);
			assert.deepEqual(wormholesForJump(HS, LS, allHoles, {
				'11': { systemID: HS }, 12: { systemID: null },	
				'21': { systemID: HS }, 22: { systemID: 1 },	
				'31': { systemID: HS }, 32: { systemID: null }, 	
				'41': { systemID: HS }, 42: { systemID: 2 }, 	
				'51': { systemID: HS }, 52: { systemID: null }, 	
			}), Object.values(outHoles)
			);
		});	
		it('Jump into Pochven', () => {
			const outHoles = {
				'10': { initialID: 11, secondaryID: 12, type: 'F216' },	// match by type
				'20': { initialID: 21, secondaryID: 22 }, // match by class
				'30': { initialID: 31, secondaryID: 32 } // match by no info
			};
			const allHoles = Object.assign({
				'40': { initialID: 41, secondaryID: 42 },	// target is wrong class
				'50': { initialID: 51, secondaryID: 52, type: 'N968' },	// wrong type
			}, outHoles);
			assert.deepEqual(wormholesForJump(C3, 30020141, allHoles, {
				'11': { systemID: C3 }, 12: { systemID: null },	
				'21': { systemID: C3 }, 22: { systemID: 10 },	
				'31': { systemID: C3 }, 32: { systemID: null }, 	
				'41': { systemID: C3 }, 42: { systemID: 2 }, 	
				'51': { systemID: C3 }, 52: { systemID: null }, 	
			}), Object.values(outHoles)
			);
		});		
	});
});