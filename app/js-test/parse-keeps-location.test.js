const assert = require('assert');
const { include } = require('./helpers/helpers');

// Runs the real tripwire.parse and tripwire.EVE: a jump seen on the first location poll after a view change has to
// reach the automapper and Follow (changes/2026-10-31-jump-after-view-change/README.md).

const GLOBALS = ['$', 'tripwire', 'options', 'systemAnalysis', 'systemRendering', 'viewingSystemID'];
const J162518 = 31000829, J163533 = 31000253, J112417 = 31002445;

function fake$() {
	const element = { length: 0 };
	['removeClass', 'addClass', 'show', 'hide', 'html', 'text', 'trigger', 'not'].forEach(m => { element[m] = () => element; });
	element.hasClass = () => false;
	const $ = () => element;
	$.extend = (deep, target, source) => Object.assign(target, source);
	$.map = (o, f) => Object.values(o).map(f);
	return $;
}

describe('tripwire.parse keeps the tracked location on a view change', () => {
	let saved, mapped, followed;

	const pilot = systemID => ({ characterID: 1, characterName: 'Pilot', systemID, systemName: 'J' + systemID, shipTypeID: 44993 });
	const server = () => ({ signatures: {}, wormholes: {} });

	before(() => {
		saved = {};
		GLOBALS.forEach(g => { saved[g] = global[g]; });
	});

	after(() => {
		GLOBALS.forEach(g => { if (saved[g] === undefined) delete global[g]; else global[g] = saved[g]; });
	});

	beforeEach(() => {
		mapped = [];
		followed = [];
		global.$ = fake$();
		global.options = { buttons: { follow: true }, chain: { active: null, tabs: [] }, masks: { active: '1.0' } };
		global.systemAnalysis = { analyse: () => ({}) };
		global.systemRendering = { renderSystem: () => '' };
		global.viewingSystemID = J162518;
		global.tripwire = {
			client: { signatures: {}, wormholes: {} },
			signatures: { list: {} },
			autoMapper(from, to) { mapped.push([from, to]); },
			systemChange(systemID) { followed.push(systemID); }
		};
		include('app/js/tripwire/parse');
		include('app/js/tripwire/eve');
		tripwire.EVE(pilot(J162518));
	});

	['change', 'init'].forEach(mode => it(mode + ': client.EVE survives', () => {
		tripwire.parse(server(), mode);
		assert.strictEqual(tripwire.client.EVE.systemID, J162518);
	}));

	it('change: the server data still replaces the rest of the client', () => {
		const data = server();
		tripwire.parse(data, 'change');
		assert.strictEqual(tripwire.client, data);
	});

	it('a jump on the first poll after a view change is automapped', () => {
		tripwire.parse(server(), 'change');
		tripwire.EVE(pilot(J163533));
		assert.deepStrictEqual(mapped, [[J162518, J163533]]);
	});

	it('a jump on the first poll after a view change is followed', () => {
		global.viewingSystemID = J112417;
		tripwire.parse(server(), 'change');
		tripwire.EVE(pilot(J163533));
		assert.deepStrictEqual(followed, [J163533]);
	});

	it('a poll without a jump after a view change maps nothing', () => {
		tripwire.parse(server(), 'change');
		tripwire.EVE(pilot(J162518));
		assert.deepStrictEqual(mapped, []);
		assert.deepStrictEqual(followed, []);
	});

	it('first load: no location yet, nothing to map', () => {
		tripwire.client = { signatures: {}, wormholes: {} };
		tripwire.parse(server(), 'init');
		tripwire.EVE(pilot(J163533));
		assert.deepStrictEqual(mapped, []);
	});
});
