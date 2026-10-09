const assert = require('assert');
const { include } = require('./helpers/helpers');
include('public/js/combine');
include('app/js/tripwire/genericSystemTypes');
include('app/js/wormholeAnalysis');
include('app/js/systemAnalysis');

// temp
jQuery = { fn: {} };
include('app/js/helpers');

describe('Wormhole analysis', () => {
	const lowsec = appData.genericSystemTypes.indexOf('Low-Sec');
	describe('Target system ID', () => {
		it('Specific system', () => { assert.equal(wormholeAnalysis.targetSystemID('J123405', undefined), 31001031); });
		it('System type in text', () => { assert.equal(wormholeAnalysis.targetSystemID('Low-Sec', undefined), lowsec); });
		it('System type from wormhole type', () => { assert.equal(wormholeAnalysis.targetSystemID(undefined, 'U210'), lowsec); });
		it('Specific system from wormhole type', () => { assert.equal(wormholeAnalysis.targetSystemID(undefined, 'J377'), 30002086); });	// Turnur
		it('Unknown for K162', () => { assert.equal(wormholeAnalysis.targetSystemID(undefined, 'K162'), null); });
		it('Unknown for no information', () => { assert.equal(wormholeAnalysis.targetSystemID(undefined, undefined), null); });
	});

	describe('Eligible wormhole types', () => {
		const extractNames = types => ({ from: types.from.map(w => w.key), to: types.to.map(w => w.key) });
		
		it('Unknown at both sides', () => assert.deepEqual(wormholeAnalysis.eligibleWormholeTypes(undefined, undefined), null));
		
		it('Specific system at both sides', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(31001031, 30004137)), { from: ['U210', 'J492'], to: ['X702'] }));	// C3 to LS
		it('Specific system to type', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(31001031, lowsec)), { from: ['U210', 'J492'], to: ['X702'] }));
		it('Specific system to type (chain format)', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(31001031, '2|12354')), { from: ['D845'], to: ['X702'] }));	// C3 to HS
		it('Type to specific system', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(lowsec, 31001031)), { from: ['X702'], to: ['U210', 'J492'] }));
		it('Type to type', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(6, 4)), { from: ['N766', 'L005'], to: ['Y683', 'M001'] }));	// C4 to C2
		it('Type to multi-class type', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(6, 13)), { from: ['H900', 'X877', 'C008', 'M001'], to: ['E175', 'X877', 'M001'] }));	// C4 to C4/5
		it('Type to type - C1 doesn\'t show C13', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(6, 3)), { from: ['P060', 'E004'], to: ['M609', 'M001'] }));	// C4 to C1		
		describe('Special systems', () => {
			it('Type to Turnur', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(4, 30002086)), { from: ['A239', 'J377', 'J492'], to: ['R943'] }));	// C2 to Turnur
			it('Type to Vidette', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(4, 31000003)), { from: [], to: ['D382'] }));	// C2 to Vidette
		});
		
		const c3_to_unknown = { 
			from: ['K346', 'U210', 'D845', 'A982', 'N770', 'T405', 'N968', 'I182', 'V301', 'Q003', 'G008', 'C008', 'M001', 'Z006', 'L005', 'E004', 'A009', 'F135', 'F216', 'J377', 'J492'],
			to: ['L477', 'M267', 'C247', 'N968', 'O477', 'O883', 'X702', 'Z006']
		}
		it('Specific system to unknown', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(31001031, undefined)), c3_to_unknown));
		it('Type to unknown', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(5, undefined)), c3_to_unknown));
		it('Unknown to specific system', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(undefined, 31001031)), { from: c3_to_unknown.to, to: c3_to_unknown.from }));
		
		it('Specific system to type, passing system objects', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(systemAnalysis.analyse(31001031), systemAnalysis.analyse(lowsec))), { from: ['U210', 'J492'], to: ['X702'] }));
		
		it('Custom data source', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(31001031, 30004137, Object.assign({
			"X987": {"life": "24 Hours", "from": "Class-3", "leadsTo": "Low-Sec", "mass": 3000000000, "jump": 375000000},			
		}, appData.wormholes))), { from: ['X987', 'U210', 'J492'], to: ['X702'] }));	// C3 to LS
		
		it('Exclusion', () => assert.deepEqual(extractNames(wormholeAnalysis.eligibleWormholeTypes(31001031, 30004137, {
			"X987": {"life": "24 Hours", "notFrom": "Class-4", "leadsTo": "Low-Sec", "mass": 3000000000, "jump": 375000000}, // check not all exclusions remove it - this should still appear
			"X986": {"life": "24 Hours", "notFrom": "Class-3", "leadsTo": "Low-Sec", "mass": 3000000000, "jump": 375000000},			
			"X981": {"life": "24 Hours", "from": "Class-3", "notLeadsTo": "Low-Sec", "mass": 3000000000, "jump": 375000000},			
			"X985": {"life": "24 Hours", "notFrom": "Low-Sec", "leadsTo": "Class-3", "mass": 3000000000, "jump": 375000000},			
		})), { from: ['X987'], to: [] }));	// C3 to LS
				
	});
	
	describe('Wormhole from type pair', () => {
		it('Actual type and K162', () => assert.deepEqual(wormholeAnalysis.wormholeFromTypePair('B274', 'K162'), appData.wormholes.B274));
		it('Dummy type and K162', () => assert.deepEqual(wormholeAnalysis.wormholeFromTypePair('XLG', 'K162'), wormholeAnalysis.dummyWormholes.XLG));
		it('Unknown type and K162', () => assert.deepEqual(wormholeAnalysis.wormholeFromTypePair('???', 'K162'), undefined));
		it('K162 and Actual type', () => assert.deepEqual(wormholeAnalysis.wormholeFromTypePair('K162', 'B274'), appData.wormholes.B274));
		it('K162 and Dummy type', () => assert.deepEqual(wormholeAnalysis.wormholeFromTypePair('K162', 'XLG'), wormholeAnalysis.dummyWormholes.XLG));
		it('K162 and Unknown type', () => assert.deepEqual(wormholeAnalysis.wormholeFromTypePair('K162', '???'), undefined));	
		it('Actual type and unknown', () => assert.deepEqual(wormholeAnalysis.wormholeFromTypePair('B274', '???'), appData.wormholes.B274));		
	});
	
	describe('Likely wormhole from system', () => {
		it('specific C4/C6 should be large', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31001585, 31002439), wormholeAnalysis.dummyWormholes.LRG));		
		it('specific C4/generic C3 should be large', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31001585, '5|1243'), wormholeAnalysis.dummyWormholes.LRG));		
		it('specific C4/generic C5 should be large', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31001585, '7|1243'), wormholeAnalysis.dummyWormholes.LRG));		
		it('specific C6/generic C5 should be xlarge', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31002439, '7|1243'), wormholeAnalysis.dummyWormholes.XLG));		
		it('specific C6/generic NS should be xlarge', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31002439, '0|1243'), wormholeAnalysis.dummyWormholes.XLG));		
		it('specific C1/generic should be medium', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31000071, 'null|1243'), wormholeAnalysis.dummyWormholes.MED));
		it('specific C1/generic LS should be medium', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31000071, '1|1243'), wormholeAnalysis.dummyWormholes.MED));
		it('specific C4/C1 should be medium', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31001585, 31000071), wormholeAnalysis.dummyWormholes.MED));		
		it('specific C4/generic C1 should be medium', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31001585, '3|2345'), wormholeAnalysis.dummyWormholes.MED));		
		it('specific C4/specific C13 should be frig', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31001585, 31002584), wormholeAnalysis.dummyWormholes.SML));		
		it('specific C4/generic C13 should be frig', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31001585, '9|5432'), wormholeAnalysis.dummyWormholes.SML));		
		it('specific C4/generic NS should be large', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31001585, '0|1243'), wormholeAnalysis.dummyWormholes.LRG));		
		it('specific C4/generic Unknown (small) should be frig', () => assert.deepEqual(wormholeAnalysis.likelyWormhole(31001585, '12|5432'), wormholeAnalysis.dummyWormholes.SML));		
	});
		
});