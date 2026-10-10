const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/tripwire/genericSystemTypes');
include('app/js/wormholeAnalysis');
include('app/js/systemAnalysis');
include('app/js/fork/hole-naming');

describe('Hole naming', () => {
	describe('leadingToken', () => {
		it('Plain name', () => assert.equal(holeNaming.leadingToken('ab6'), 'AB6'));
		it('Name with suffix text', () => assert.equal(holeNaming.leadingToken('BA - DRIFTER'), 'BA'));
		it('Empty', () => assert.equal(holeNaming.leadingToken(''), ''));
		it('Missing', () => assert.equal(holeNaming.leadingToken(undefined), ''));
		it('No token', () => assert.equal(holeNaming.leadingToken('- foo'), ''));
	});

	describe('sizeClass', () => {
		it('H296 (2000kt) is large', () => assert.equal(holeNaming.sizeClass('H296'), 'large'));
		it('Z006 (5kt) is small', () => assert.equal(holeNaming.sizeClass('Z006'), 'small'));
		it('Lower case type', () => assert.equal(holeNaming.sizeClass('z006'), 'small'));
		it('O883 (20kt) is medium', () => assert.equal(holeNaming.sizeClass('O883'), 'medium'));
		it('Q317 (62kt) is medium', () => assert.equal(holeNaming.sizeClass('Q317'), 'medium'));
		it('K162 is large', () => assert.equal(holeNaming.sizeClass('K162'), 'large'));
		it('Unknown type is large', () => assert.equal(holeNaming.sizeClass('XXXX'), 'large'));
		it('No type is large', () => assert.equal(holeNaming.sizeClass(undefined), 'large'));
		it('Type without jump mass is large', () => assert.equal(holeNaming.sizeClass('T1', { T1: {} }), 'large'));
	});

	describe('nextName', () => {
		it('First hole from root', () => assert.equal(holeNaming.nextName('', [], 'large'), 'A'));
		it('Letters in order', () => assert.equal(holeNaming.nextName('', ['A', 'B'], 'large'), 'C'));
		it('Fills gaps', () => assert.equal(holeNaming.nextName('', ['A', 'C'], 'large'), 'B'));
		it('Unordered used names', () => assert.equal(holeNaming.nextName('', ['C', 'A', 'B', 'E'], 'large'), 'D'));
		it('Ignores names with other prefixes / lengths', () => assert.equal(holeNaming.nextName('', ['AB', 'B1'], 'large'), 'A'));
		it('Counts names with suffix text', () => assert.equal(holeNaming.nextName('', ['A - DRIFTER', 'b'], 'large'), 'C'));
		it('Child of A', () => assert.equal(holeNaming.nextName('A', [], 'large'), 'AA'));
		it('Child of AA', () => assert.equal(holeNaming.nextName('AA', ['AAB'], 'large'), 'AAA'));
		it('Small digits', () => assert.equal(holeNaming.nextName('AAA', [], 'small'), 'AAA1'));
		it('Medium digits', () => assert.equal(holeNaming.nextName('AAA1', [], 'medium'), 'AAA16'));
		it('Medium child of AB', () => assert.equal(holeNaming.nextName('AB', [], 'medium'), 'AB6'));
		it('Small child of AB6', () => assert.equal(holeNaming.nextName('AB6', [], 'small'), 'AB61'));
		it('Small skips used digits', () => assert.equal(holeNaming.nextName('', ['1', '2', '4'], 'small'), '3'));
		it('Medium skips used digits', () => assert.equal(holeNaming.nextName('', ['6', '7'], 'medium'), '8'));
		it('Medium does not use small digits', () => assert.equal(holeNaming.nextName('', [], 'medium'), '6'));
		it('Small exhausted falls back to letters', () => assert.equal(holeNaming.nextName('B', ['B1', 'B2', 'B3', 'B4', 'B5', 'BA'], 'small'), 'BB'));
		it('Medium exhausted falls back to letters', () => assert.equal(holeNaming.nextName('', ['6', '7', '8', '9'], 'medium'), 'A'));
		it('Letters exhausted gives null', () => assert.equal(holeNaming.nextName('', holeNaming.LETTERS.split(''), 'large'), null));
		it('Lower case prefix', () => assert.equal(holeNaming.nextName('ba', ['BAA'], 'large'), 'BAB'));
		it('Null prefix gives null', () => assert.equal(holeNaming.nextName(null, [], 'large'), null));
	});

	describe('prefixFor', () => {
		it('Root', () => assert.equal(holeNaming.prefixFor(undefined, true), ''));
		it('Root even with incoming name (loop)', () => assert.equal(holeNaming.prefixFor('C', true), ''));
		it('Not in chain', () => assert.equal(holeNaming.prefixFor(undefined, false), ''));
		it('Incoming hole name', () => assert.equal(holeNaming.prefixFor('AB', false), 'AB'));
		it('Incoming hole name with suffix text', () => assert.equal(holeNaming.prefixFor('BA - DRIFTER', false), 'BA'));
		it('Unnamed incoming hole gives no suggestion', () => assert.equal(holeNaming.prefixFor('', false), null));
		it('Incoming name without token gives no suggestion', () => assert.equal(holeNaming.prefixFor('- foo', false), null));
		it('Prefix leads to next name', () => assert.equal(holeNaming.nextName(holeNaming.prefixFor('AB', false), [], holeNaming.sizeClass('O883')), 'AB6'));
	});

	describe('chainContext', () => {
		const chainData = {
			map: { rows: [
				{ c: [{ v: 1, systemID: 31000001 }, { v: null }] },
				{ c: [{ v: 2, systemID: 31000002 }, { v: 1 }] },
				{ c: [{ v: 3, systemID: 31000003 }, { v: 2 }] },
			] },
			systemsInChainMap: {
				31000002: { pathHome: [{ name: 'A' }] },
				31000003: { pathHome: [{ name: 'A' }, { name: '' }] },
			}
		};
		it('Root', () => assert.deepEqual(holeNaming.chainContext(31000001, chainData), { isRoot: true, incomingName: undefined }));
		it('Child', () => assert.deepEqual(holeNaming.chainContext('31000002', chainData), { isRoot: false, incomingName: 'A' }));
		it('Unnamed incoming', () => assert.deepEqual(holeNaming.chainContext(31000003, chainData), { isRoot: false, incomingName: '' }));
		it('Not in chain', () => assert.deepEqual(holeNaming.chainContext(31000009, chainData), { isRoot: false, incomingName: undefined }));
		it('No chain data', () => assert.deepEqual(holeNaming.chainContext(31000001, undefined), { isRoot: false, incomingName: undefined }));
	});

	describe('tabRoots', () => {
		it('No active tab', () => assert.equal(holeNaming.tabRoots(undefined), null));
		it('All k-space tab (number)', () => assert.equal(holeNaming.tabRoots(0), null));
		it('All k-space tab (string)', () => assert.equal(holeNaming.tabRoots('0'), null));
		it('Single system (number)', () => assert.deepEqual(holeNaming.tabRoots(31000001), ['31000001']));
		it('Several systems', () => assert.deepEqual(holeNaming.tabRoots('31000001,30000142'), ['31000001', '30000142']));
	});

	// Home J152820 (31000001) -> sig ABC "C" -> J135100 (31000002); J135100 has outbound "CA" -> 31000003
	const HOME = 31000001, J135100 = 31000002, CA_SYS = 31000003;
	const whSigs = (nearName) => ({
		10: { id: 10, systemID: String(HOME), type: 'wormhole', name: 'C' },
		11: { id: 11, systemID: String(J135100), type: 'wormhole', name: nearName },
		12: { id: 12, systemID: String(J135100), type: 'wormhole', name: 'CA' },
		13: { id: 13, systemID: String(CA_SYS), type: 'wormhole', name: '' },
	});
	const whs = {
		100: { id: '100', initialID: '10', secondaryID: '11', type: 'H296' },
		101: { id: '101', initialID: '12', secondaryID: '13', type: 'K162' },
	};

	describe('incomingFromWormholes', () => {
		it('Far side named, near side unnamed', () => assert.equal(holeNaming.incomingFromWormholes(J135100, whs, whSigs('')), 'C'));
		it('Near side missing name', () => assert.equal(holeNaming.incomingFromWormholes(String(J135100), whs, whSigs(undefined)), 'C'));
		it('Near side return bookmark', () => assert.equal(holeNaming.incomingFromWormholes(J135100, whs, whSigs('<C')), 'C'));
		it('Reversed initial/secondary', () => assert.equal(holeNaming.incomingFromWormholes(J135100,
			{ 100: { id: 100, initialID: 11, secondaryID: 10 } }, whSigs('')), 'C'));
		it('Deeper system', () => assert.equal(holeNaming.incomingFromWormholes(CA_SYS, whs, whSigs('')), 'CA'));
		it('Named near side is an outbound hole, ignored', () => assert.equal(holeNaming.incomingFromWormholes(J135100,
			{ 101: whs[101] }, whSigs('')), undefined));
		it('Home has no incoming hole', () => assert.equal(holeNaming.incomingFromWormholes(HOME, whs, whSigs('')), undefined));
		it('Near side named with another name, ignored', () => assert.equal(holeNaming.incomingFromWormholes(J135100, whs, whSigs('X')), undefined));
		it('Far side unnamed, ignored', () => assert.equal(holeNaming.incomingFromWormholes(J135100,
			{ 100: whs[100] }, Object.assign(whSigs(''), { 10: { id: 10, systemID: String(HOME), name: '' } })), undefined));
		it('Missing far sig, ignored', () => assert.equal(holeNaming.incomingFromWormholes(J135100,
			{ 100: { id: 100, initialID: 99, secondaryID: 11 } }, whSigs('')), undefined));
		it('Several candidates: shortest token wins', () => {
			const sigs = Object.assign(whSigs(''), {
				20: { id: 20, systemID: '31000009', name: 'BA6' },
				21: { id: 21, systemID: String(J135100), name: '' },
			});
			const both = Object.assign({ 50: { id: '50', initialID: '20', secondaryID: '21' } }, whs);
			assert.equal(holeNaming.incomingFromWormholes(J135100, both, sigs), 'C');
		});
		it('Several candidates of equal length: lowest wormhole id wins', () => {
			const sigs = Object.assign(whSigs(''), {
				20: { id: 20, systemID: '31000009', name: 'D' },
				21: { id: 21, systemID: String(J135100), name: '<D' },
			});
			assert.equal(holeNaming.incomingFromWormholes(J135100,
				Object.assign({ 900: { id: '900', initialID: '20', secondaryID: '21' } }, whs), sigs), 'C');
			assert.equal(holeNaming.incomingFromWormholes(J135100,
				Object.assign({ 99: { id: '99', initialID: '20', secondaryID: '21' } }, whs), sigs), 'D');
		});
		it('None gives undefined', () => assert.equal(holeNaming.incomingFromWormholes(J135100, {}, whSigs('')), undefined));
		it('No data', () => assert.equal(holeNaming.incomingFromWormholes(J135100, undefined, undefined), undefined));
	});

	describe('resolvePrefix', () => {
		// chain.data when the chain map is rooted at the viewed system J135100 (no chain tab)
		const viewedRooted = {
			map: { rows: [{ c: [{ v: 1, systemID: J135100 }, { v: null }] }, { c: [{ v: 2, systemID: HOME }, { v: 1 }] }] },
			systemsInChainMap: { [HOME]: { pathHome: [{ name: '' }] } }
		};
		// chain.data with a chain tab on home
		const homeRooted = {
			map: { rows: [{ c: [{ v: 1, systemID: HOME }, { v: null }] }, { c: [{ v: 2, systemID: J135100 }, { v: 1 }] }] },
			systemsInChainMap: { [J135100]: { pathHome: [{ name: 'C' }] }, [CA_SYS]: { pathHome: [{ name: 'C' }, { name: 'CA' }] } }
		};
		const sizes = (prefix, used) => ['large', 'small', 'medium'].map(s => holeNaming.nextName(prefix, used || [], s));

		it('No tab: J135100 continues from C, not from A', () => {
			const prefix = holeNaming.resolvePrefix(J135100, null, viewedRooted, whs, whSigs(''));
			assert.equal(prefix, 'C');
			assert.deepEqual(sizes(prefix), ['CA', 'C1', 'C6']);
		});
		it('No tab: return bookmark near side', () => assert.equal(holeNaming.resolvePrefix(J135100, null, viewedRooted, whs, whSigs('<C')), 'C'));
		it('No tab: siblings skip used CA and ignore the incoming sig', () => {
			const sigs = whSigs('<C');
			const prefix = holeNaming.resolvePrefix(J135100, null, viewedRooted, whs, sigs);
			assert.equal(holeNaming.nextName(prefix, holeNaming.siblingNames(sigs, J135100), 'large'), 'CB');
		});
		it('No tab: home is a root', () => assert.equal(holeNaming.resolvePrefix(HOME, null, undefined, whs, whSigs('')), ''));
		it('No tab, no wormhole data: root', () => assert.equal(holeNaming.resolvePrefix(J135100, null, viewedRooted, {}, {}), ''));
		it('Tab on home: chain data used', () => assert.equal(holeNaming.resolvePrefix(J135100, ['' + HOME], homeRooted, {}, {}), 'C'));
		it('Tab on home: deeper system', () => assert.equal(holeNaming.resolvePrefix(CA_SYS, ['' + HOME], homeRooted, {}, {}), 'CA'));
		it('Tab on home: home is root', () => assert.equal(holeNaming.resolvePrefix(HOME, ['' + HOME], homeRooted, whs, whSigs('')), ''));
		it('Tab root even before chain data catches up', () => assert.equal(holeNaming.resolvePrefix(HOME, ['' + HOME], undefined, whs, whSigs('')), ''));
		it('Tab on home: unnamed incoming hole gives no suggestion', () => assert.equal(holeNaming.resolvePrefix(J135100, ['' + HOME],
			{ map: homeRooted.map, systemsInChainMap: { [J135100]: { pathHome: [{ name: '' }] } } }, whs, whSigs('')), null));
		it('Tab on home: off-chain system falls back to wormholes', () => assert.equal(holeNaming.resolvePrefix(J135100, ['' + HOME],
			{ map: { rows: [{ c: [{ v: 1, systemID: HOME }, { v: null }] }] }, systemsInChainMap: {} }, whs, whSigs('')), 'C'));
	});

	describe('siblingNames', () => {
		const sigs = {
			1: { id: 1, systemID: '31000001', type: 'wormhole', name: 'A' },
			2: { id: 2, systemID: '31000001', type: 'wormhole', name: 'B - DRIFTER' },
			3: { id: 3, systemID: '31000001', type: 'data', name: 'C' },
			4: { id: 4, systemID: '31000002', type: 'wormhole', name: 'D' },
			5: { id: 5, systemID: '31000001', type: 'wormhole', name: '' },
		};
		it('Wormholes in the system', () => assert.deepEqual(holeNaming.siblingNames(sigs, 31000001), ['A', 'B - DRIFTER']));
		it('Excludes the edited sig', () => assert.deepEqual(holeNaming.siblingNames(sigs, 31000001, 1), ['B - DRIFTER']));
	});

	describe('classText', () => {
		const forLeadsTo = (text, type) => holeNaming.classText(systemAnalysis.analyse(wormholeAnalysis.targetSystemID(text, type)).systemTypeName);
		it('Wormhole class', () => assert.equal(holeNaming.classText('C5'), 'C5'));
		it('Thera', () => assert.equal(holeNaming.classText('C12'), 'Thera'));
		it('Pochven', () => assert.equal(holeNaming.classText('Trig'), 'Pochven'));
		it('Ambiguous', () => assert.equal(holeNaming.classText('C2/3'), ''));
		it('Unknown', () => assert.equal(holeNaming.classText(' '), ''));
		it('Leads to Class-5', () => assert.equal(forLeadsTo('Class-5', undefined), 'C5'));
		it('Leads to from type H296', () => assert.equal(forLeadsTo('', 'H296'), 'C5'));
		it('Leads to High-Sec', () => assert.equal(forLeadsTo('High-Sec', undefined), 'HS'));
		it('Leads to Low-Sec', () => assert.equal(forLeadsTo('Low-Sec', undefined), 'LS'));
		it('Leads to Null-Sec', () => assert.equal(forLeadsTo('Null-Sec', undefined), 'NS'));
		it('Leads to Class-13', () => assert.equal(forLeadsTo('Class-13', undefined), 'C13'));
		it('Leads to Triglavian', () => assert.equal(forLeadsTo('Triglavian', undefined), 'Pochven'));
		it('Leads to Thera', () => assert.equal(forLeadsTo('Thera', undefined), 'Thera'));
		it('Leads to specific system', () => assert.equal(forLeadsTo('J123405', undefined), 'C3'));
	});

	describe('bookmarkString', () => {
		it('Full', () => assert.equal(holeNaming.bookmarkString({ name: 'A', classText: 'C5', sigAlpha: 'abc', eol: false }), '=A C5 ABC'));
		it('EOL', () => assert.equal(holeNaming.bookmarkString({ name: 'A', classText: 'C5', sigAlpha: 'ABC', eol: true }), '=A C5 ABC EOL'));
		it('Name with suffix text', () => assert.equal(holeNaming.bookmarkString({ name: 'ba - drifter', classText: 'HS', sigAlpha: 'STU' }), '=BA HS STU'));
		it('No class', () => assert.equal(holeNaming.bookmarkString({ name: 'AB6', classText: '', sigAlpha: 'DEF', eol: true }), '=AB6 DEF EOL'));
		it('No sig', () => assert.equal(holeNaming.bookmarkString({ name: 'A', classText: 'LS', sigAlpha: '' }), '=A LS'));
		it('Unknown sig ???', () => assert.equal(holeNaming.bookmarkString({ name: 'A', classText: 'LS', sigAlpha: '???' }), '=A LS'));
		it('Name only', () => assert.equal(holeNaming.bookmarkString({ name: 'A' }), '=A'));
		it('No name gives null', () => assert.equal(holeNaming.bookmarkString({ name: '', classText: 'C5', sigAlpha: 'ABC' }), null));
	});
});
