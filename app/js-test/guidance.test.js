const assert = require('assert');
const { include } = require('./helpers/helpers');
include('public/js/combine');
include('app/js/guidance');
include('app/js/guidance_profiles');
include('app/js/systemAnalysis');

beforeEach(() => {
	options = { chain: { routeIgnore: { enabled: false } } };
});

afterEach(() => {
	guidance.jumpCostModifiers = [];
	guidance.clearCache();
});

describe('Pathfinding', () => {
	it('System to itself', () => { assert.deepEqual( [ sid('Amygnon') ], guidance.findShortestPath(appData.map.shortest, sid('Amygnon'), sid('Amygnon'))); });
	it('Unroutable systems', () => { assert.deepEqual( null, guidance.findShortestPath(appData.map.shortest, sid('Amygnon'), sid('J163225'))); });
	it('Routable system to system', () => { assert.deepEqual( [ sid('Amygnon'), sid('Jufvitte'), sid('Ansalle'), sid('Gisleres'), sid('Scolluzer'), sid('Sortet') ], guidance.findShortestPath(appData.map.shortest, sid('Amygnon'), sid('Sortet') )); });
	it('Routable system to system over limit', () => { assert.deepEqual( null, guidance.findShortestPath(appData.map.shortest, sid('Amygnon'), sid('Sortet'), 4 )); });
	it('Routable system to system within limit', () => { assert.deepEqual( [ sid('Amygnon'), sid('Jufvitte'), sid('Ansalle'), sid('Gisleres'), sid('Scolluzer'), sid('Sortet') ], guidance.findShortestPath(appData.map.shortest, sid('Amygnon'), sid('Sortet'), 5 )); });
	it('Routable using normal system IDs (ignoring Zarazkh)', () => { assert.deepEqual( 42, guidance.findShortestPath(appData.map.shortest, 30005003, 30001311 ).length); });
	it('Routable system to multiple options system within limit', () => { assert.deepEqual( [ sid('Amygnon'), sid('Jufvitte'), sid('Ansalle'), sid('Gisleres'), sid('Scolluzer'), sid('Sortet') ], guidance.findShortestPath(appData.map.shortest, sid('Amygnon'), [sid('Sortet'), sid('Amarr')], 5 )); });
	it('Routable many-to-many', () => { assert.deepEqual( [ sid('Arnon'), sid('Aere'), sid('Hulmate') ], guidance.findShortestPath(appData.map.shortest, [sid('Amygnon'), sid('Arnon')], [sid('Sortet'), sid('Hulmate')] )); });
});

describe('Route to profile', () => {
	it('System to blue loot', () => { assert.deepEqual( [ sid('Amygnon'), sid("Intaki"), sid("Agoze"), sid("Ostingele"), sid("Harroule"), sid("MHC-R3"), sid("2X-PQG") ], guidance.findShortestPath(appData.map.shortest, sid('Amygnon'), guidance_profiles.blueLootSystems)); });
});

describe('Conditional gates', () => {
	it('Athounon-Samanuni open', () => {
		include('app/js/fw');
		fw.SamanuniAthounonGateOpen = true;

		assert.deepEqual( [ sid('Uuhulanen'), sid('Samanuni'), sid('Athounon'), sid("Mercomesier")], guidance.findShortestPath(appData.map.shortest, sid('Uuhulanen'), sid("Mercomesier"))); 
		
		assert.deepEqual( [ 
			{ systemID: SID('Mercomesier') }, { systemID: SID('Samanuni') }
		], guidance.connections(appData.map.shortest, sid('Athounon')));
		assert.deepEqual( [
			{ systemID: SID('Athounon') }, { systemID: SID('Uchomida') }, { systemID: SID('Uuhulanen') }, { systemID: SID('Ikoskio') }
		], guidance.connections(appData.map.shortest, sid('Samanuni')));
	});
	it('Athounon-Samanuni closed', () => {
		include('app/js/fw');
		fw.SamanuniAthounonGateOpen = false;
		
		assert.deepEqual( [ sid('Uuhulanen'), sid('Onnamon'), sid('Kinakka'), sid('Innia'), sid('Eha'), sid('Oicx'), sid('Vlillirier'), sid('Aldranette'), sid('Evaulon'), sid('Anchauttes'), sid('Odamia'), sid('Arderonne'), sid('Reschard'), sid("Mercomesier")], guidance.findShortestPath(appData.map.shortest, sid('Uuhulanen'), sid("Mercomesier"))); 
		
		assert.deepEqual( [ 
			{ systemID: SID('Mercomesier') }, { systemID: SID('Samanuni'), closed: true }
		], guidance.connections(appData.map.shortest, sid('Athounon')));
		assert.deepEqual( [
			{ systemID: SID('Athounon'), closed: true }, { systemID: SID('Uchomida') }, { systemID: SID('Uuhulanen') }, { systemID: SID('Ikoskio') }
		], guidance.connections(appData.map.shortest, sid('Samanuni')));
	});
});

function SID(systemName) {
	return Object.entries(appData.systems).filter(s => s[1].name === systemName)[0][0] * 1;
}

function sid(systemName) {
	return SID(systemName) - 30000000;
}