const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/tripwire/genericSystemTypes');
include('app/js/wormholeAnalysis');
include('app/js/systemAnalysis');
include('app/js/fork/bookmark-template');
include('app/js/fork/hole-naming');

describe('Hole naming', () => {
	describe('leadingToken', () => {
		it('Plain name', () => assert.equal(holeNaming.leadingToken('ab6'), 'AB6'));
		it('Name with suffix text', () => assert.equal(holeNaming.leadingToken('BA - DRIFTER'), 'BA'));
		it('Empty', () => assert.equal(holeNaming.leadingToken(''), ''));
		it('Missing', () => assert.equal(holeNaming.leadingToken(undefined), ''));
		it('No token', () => assert.equal(holeNaming.leadingToken('- foo'), ''));
		it('Return bookmarks have no token', () => assert.deepEqual([holeNaming.leadingToken('!AB'), holeNaming.leadingToken('<AB')], ['', '']));
	});

	describe('isReturnBookmark', () => {
		it('"!" prefix', () => assert.equal(holeNaming.isReturnBookmark('!AB'), true));
		it('Older "<" prefix', () => assert.equal(holeNaming.isReturnBookmark(' <C '), true));
		it('Hole names, empty and missing are not', () => assert.deepEqual(['AB', 'C - frig', '', undefined, null, '?'].map(holeNaming.isReturnBookmark), [false, false, false, false, false, false]));
		it('New ones use "!"', () => assert.equal(holeNaming.RETURN_PREFIX, '!'));
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
		it('Medium past a small hole uses letters', () => assert.equal(holeNaming.nextName('AAA1', [], 'medium'), 'AAA1A'));
		it('Medium past a medium hole uses letters', () => assert.equal(holeNaming.nextName('A6', [], 'medium'), 'A6A'));
		it('Medium past a medium hole skips used letters', () => assert.equal(holeNaming.nextName('A6', ['A6A'], 'medium'), 'A6B'));
		it('Medium deeper past a medium hole uses letters', () => assert.equal(holeNaming.nextName('A6B', [], 'medium'), 'A6BA'));
		it('Small past a small hole uses letters', () => assert.equal(holeNaming.nextName('A1', [], 'small'), 'A1A'));
		it('Small deeper past medium then small uses letters', () => assert.equal(holeNaming.nextName('A61', [], 'small'), 'A61A'));
		it('Small digits exhausted at the root gives a letter', () => assert.equal(holeNaming.nextName('', ['1', '2', '3', '4', '5'], 'small'), 'A'));
		it('Small below that letter hole gets a digit again (size is read from the name)', () => assert.equal(holeNaming.nextName('A', [], 'small'), 'A1'));
		it('Small deeper past a medium hole gets a digit', () => assert.equal(holeNaming.nextName('A6B', [], 'small'), 'A6B1'));
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

	describe('pathSize', () => {
		it('Letters only is large', () => assert.equal(holeNaming.pathSize('AB'), 'large'));
		it('Empty is large', () => assert.equal(holeNaming.pathSize(''), 'large'));
		it('Medium digit', () => assert.equal(holeNaming.pathSize('A6B'), 'medium'));
		it('Small digit', () => assert.equal(holeNaming.pathSize('A1'), 'small'));
		it('Small wins over medium', () => assert.equal(holeNaming.pathSize('A61'), 'small'));
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
		it('Near side return bookmark', () => assert.equal(holeNaming.incomingFromWormholes(J135100, whs, whSigs('!C')), 'C'));
		it('Near side older "<" return bookmark', () => assert.equal(holeNaming.incomingFromWormholes(J135100, whs, whSigs('<C')), 'C'));
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
		it('No tab: return bookmark near side', () => assert.equal(holeNaming.resolvePrefix(J135100, null, viewedRooted, whs, whSigs('!C')), 'C'));
		it('No tab: older "<" return bookmark near side', () => assert.equal(holeNaming.resolvePrefix(J135100, null, viewedRooted, whs, whSigs('<C')), 'C'));
		it('No tab: siblings skip used CA and ignore the incoming sig', () => {
			const sigs = whSigs('!C');
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

	describe('resolveConflict', () => {
		it('Taken letter gets the next free one', () => assert.equal(holeNaming.resolveConflict('C', '', ['A', 'B', 'C']), 'D'));
		it('Lowest free letter, not just the next', () => assert.equal(holeNaming.resolveConflict('B', '', ['A', 'B', 'D']), 'C'));
		it('Text after the token is kept', () => assert.equal(holeNaming.resolveConflict('C - frig', '', ['C']), 'A - frig'));
		it('Deeper prefix', () => assert.equal(holeNaming.resolveConflict('AB', 'A', ['AA', 'AB - C5']), 'AC'));
		it('Lower-case name', () => assert.equal(holeNaming.resolveConflict('ab', 'a', ['AB']), 'AA'));
		it('Small digit stays a small digit', () => assert.equal(holeNaming.resolveConflict('A1', 'A', ['A1']), 'A2'));
		it('Medium digit stays a medium digit', () => assert.equal(holeNaming.resolveConflict('6', '', ['6', '7']), '8'));
		it('No clash', () => assert.equal(holeNaming.resolveConflict('C', '', ['A', 'B']), null));
		it('Return bookmark with the same letter is no clash', () => assert.equal(holeNaming.resolveConflict('C', '', ['!C']), null));
		it('Name outside the scheme is left alone', () => assert.equal(holeNaming.resolveConflict('FRIG', '', ['FRIG']), null));
		it('Name of another level is left alone', () => assert.equal(holeNaming.resolveConflict('AB', '', ['AB']), null));
		it('No prefix (incoming hole unnamed)', () => assert.equal(holeNaming.resolveConflict('A', null, ['A']), null));
		it('Nothing free', () => assert.equal(holeNaming.resolveConflict('A', '', holeNaming.LETTERS.split('')), null));
	});

	describe('raceRenames', () => {
		const sig = (id, name, time, systemID) => ({ id: id, type: 'wormhole', systemID: systemID || 1, name: name, modifiedTime: time });
		it('Later save of the same name is renamed', () => {
			const sigs = { 10: sig(10, 'C', '2026-11-03 10:00:01'), 11: sig(11, 'C', '2026-11-03 10:00:02'), 12: sig(12, 'A', '2026-11-03 09:00:00') };
			assert.deepEqual(holeNaming.raceRenames(sigs, 1, '', 'C').map(r => [r.sig.id, r.name]), [[11, 'B']]);
		});
		it('Editing the older hole afterwards does not move the name', () => {
			const sigs = { 30: sig(30, 'C', '2026-11-03 10:05:00'), 31: sig(31, 'C', '2026-11-03 10:00:02') };
			assert.deepEqual(holeNaming.raceRenames(sigs, 1, '', 'C').map(r => [r.sig.id, r.name]), [[31, 'A']]);
		});
		it('The higher id is renamed', () => {
			const sigs = { 21: sig(21, 'B', '2026-11-03 10:00:01'), 20: sig(20, 'B', '2026-11-03 10:00:01') };
			assert.deepEqual(holeNaming.raceRenames(sigs, 1, '', 'B').map(r => [r.sig.id, r.name]), [[21, 'A']]);
		});
		it('Three at once get different names', () => {
			const sigs = { 1: sig(1, 'A', 't1'), 2: sig(2, 'A', 't2'), 3: sig(3, 'A', 't3') };
			assert.deepEqual(holeNaming.raceRenames(sigs, 1, '', 'A').map(r => [r.sig.id, r.name]), [[2, 'B'], [3, 'C']]);
		});
		it('Other systems and non-wormholes are ignored', () => {
			const sigs = { 1: sig(1, 'A', 't1'), 2: sig(2, 'A', 't2', 2), 3: { id: 3, type: 'data', systemID: 1, name: 'A', modifiedTime: 't3' } };
			assert.deepEqual(holeNaming.raceRenames(sigs, 1, '', 'A'), []);
		});
		it('No clash', () => assert.deepEqual(holeNaming.raceRenames({ 1: sig(1, 'A', 't1') }, 1, '', 'A'), []));
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

	describe('enabled', () => {
		it('Missing options mean on', () => assert.deepEqual([holeNaming.enabled(undefined), holeNaming.enabled({}), holeNaming.enabled({ holeNaming: {} })], [true, true, true]));
		it('On', () => assert.equal(holeNaming.enabled({ holeNaming: { enabled: true } }), true));
		it('Off', () => assert.equal(holeNaming.enabled({ holeNaming: { enabled: false } }), false));
	});

	describe('suggestOnEdit', () => {
		it('Pasted hole, both sides unnamed', () => assert.equal(holeNaming.suggestOnEdit(null, null), true));
		it('Blank name', () => assert.equal(holeNaming.suggestOnEdit('  ', ''), true));
		it('Already named', () => assert.equal(holeNaming.suggestOnEdit('AB', ''), false));
		it('Return bookmark is a name', () => assert.equal(holeNaming.suggestOnEdit('!A', 'A'), false));
		it('Far side is a named hole: this is the way back', () => assert.equal(holeNaming.suggestOnEdit('', 'A - frig'), false));
		it('Far side is only a return bookmark', () => assert.equal(holeNaming.suggestOnEdit('', '!B'), true));
	});

	describe('namingStatics (which statics reserve letters)', () => {
		it('Thera reserves nothing', () => assert.deepEqual(holeNaming.namingStatics(['F135', 'T458', 'M164'], 12), []));
		it('Drifter systems (C14-C18) reserve nothing', () => [14, 15, 16, 17, 18].forEach(c =>
			assert.deepEqual(holeNaming.namingStatics(['Z647', 'D382', 'O477', 'Y683', 'N062', 'R474'], c), [], 'C' + c)));
		it('shattered C2 with three statics keeps all three', () => assert.deepEqual(holeNaming.namingStatics(['A239', 'B274', 'O477'], 2), ['A239', 'B274', 'O477']));
		it('at most three statics', () => assert.deepEqual(holeNaming.namingStatics(['A', 'B', 'C', 'D'], 3), ['A', 'B', 'C']));
		it('one or two statics unchanged', () => { assert.deepEqual(holeNaming.namingStatics(['H296'], 5), ['H296']); assert.deepEqual(holeNaming.namingStatics(['B274', 'O477'], '2'), ['B274', 'O477']); });
		it('no statics', () => { assert.deepEqual(holeNaming.namingStatics(undefined, 5), []); assert.deepEqual(holeNaming.namingStatics([], undefined), []); });
	});

	describe('statics get the first letters', () => {
		// Wormhole sizes for the tests (jump mass): large, medium (C1-style 62kt) and small (frigate 5kt)
		const WH = { H296: { jump: 2000000000 }, B274: { jump: 375000000 }, O477: { jump: 375000000 },
			U210: { jump: 375000000 }, M1: { jump: 62000000 }, S1: { jump: 5000000 } };
		const name = (prefix, used, type, statics, size) =>
			holeNaming.nextName(prefix, used, size || holeNaming.sizeClass(type, WH), holeNaming.reservation(type, statics, prefix, WH));

		it('Single static: the static gets A', () => assert.equal(name('', [], 'H296', ['H296']), 'A'));
		it('Single static: a K162 skips A', () => assert.equal(name('', [], 'K162', ['H296']), 'B'));
		it('Single static: an unknown hole skips A', () => assert.deepEqual([name('', [], '????', ['H296']), name('', [], '', ['H296']), name('', [], undefined, ['H296'])], ['B', 'B', 'B']));
		it('Single static: other types skip A', () => assert.equal(name('', ['B'], 'U210', ['H296']), 'C'));
		it('Static named after other holes still gets A', () => assert.equal(name('', ['B', 'C'], 'H296', ['H296']), 'A'));
		it('Two statics: A and B in data order', () => assert.deepEqual([name('', [], 'B274', ['B274', 'O477']), name('', [], 'O477', ['B274', 'O477'])], ['A', 'B']));
		it('Two statics: other holes start at C', () => assert.equal(name('', ['A'], 'K162', ['B274', 'O477']), 'C'));
		it('Three statics (shattered): A, B and C, other holes start at D', () => {
			const st = ['A239', 'B274', 'O477'];
			assert.deepEqual([name('', [], 'A239', st), name('', [], 'B274', st), name('', [], 'O477', st)], ['A', 'B', 'C']);
			assert.equal(name('', [], 'K162', st), 'D');
		});
		it('Duplicate static type: the second is named like any other hole', () => assert.equal(name('', ['A'], 'H296', ['H296']), 'B'));
		it('Duplicate static type with more holes: next free after the reserved range', () => assert.equal(name('', ['A', 'B', 'D'], 'H296', ['H296']), 'C'));
		it('Reserved letter taken by an old non-static: the static gets the next free other name', () => assert.equal(name('', ['A', 'B'], 'H296', ['H296']), 'C'));
		it('Pool exhausted: a non-static falls back to the reserved letter', () => assert.equal(name('', holeNaming.LETTERS.substring(1).split(''), 'K162', ['H296']), 'A'));
		it('Pool exhausted: fallback to the second reserved letter when the first is taken', () => assert.equal(name('', ['A'].concat(holeNaming.LETTERS.substring(2).split('')), 'K162', ['B274', 'O477']), 'B'));
		it('Everything used gives null', () => assert.equal(name('', holeNaming.LETTERS.split(''), 'K162', ['H296']), null));
		it('Deeper prefix: the static behind hole A gets AA', () => assert.equal(name('A', [], 'U210', ['U210']), 'AA'));
		it('Deeper prefix: other holes there start at AB', () => assert.equal(name('A', ['AA'], 'K162', ['U210']), 'AB'));
		it('Medium static reserves the first medium digit, not a letter', () => {
			assert.equal(name('', [], 'M1', ['M1']), '6');
			assert.equal(name('', [], 'O477', ['M1']), 'A');
			assert.equal(name('', [], 'K162', ['M1'], 'medium'), '7');
		});
		it('Small static reserves the first small digit', () => {
			assert.equal(name('', [], 'S1', ['S1', 'H296']), '1');
			assert.equal(name('', [], 'H296', ['S1', 'H296']), 'A');
			assert.equal(name('', [], 'K162', ['S1', 'H296'], 'small'), '2');
		});
		it('Medium static past a medium hole reserves a letter (path rule)', () => assert.deepEqual(holeNaming.staticSlots(['M1'], 'A6', WH), [{ type: 'M1', ch: 'A' }]));
		it('Two statics of one size pool get consecutive characters', () => assert.deepEqual(holeNaming.staticSlots(['M1', 'H296', 'M2'], '', Object.assign({ M2: { jump: 62000000 } }, WH)),
			[{ type: 'M1', ch: '6' }, { type: 'H296', ch: 'A' }, { type: 'M2', ch: '7' }]));
		it('A static we came in through reserves nothing: X reached via "B" on its U210 static, holes start at BA', () => {
			// Home sig 1 "B" -> X (31000880) sig 2 (unnamed); the hole's type U210 is on X's side (parent secondary)
			const sigs = { 1: { id: 1, systemID: 31001880, name: 'B' }, 2: { id: 2, systemID: 31000880, name: '' } };
			const holes = { 9: { id: 9, initialID: 1, secondaryID: 2, type: 'U210', parent: 'secondary' } };
			const incoming = holeNaming.incomingType(31000880, 'B', holes, sigs);
			assert.equal(incoming, 'U210');
			assert.equal(holeNaming.nextName('B', [], 'large', holeNaming.reservation('K162', ['U210'], 'B', WH, incoming)), 'BA');
			assert.equal(holeNaming.nextName('B', [], 'large', holeNaming.reservation('K162', ['U210'], 'B', WH, '')), 'BB', 'without the incoming type');
		});
		it('incomingType: K162 on our side (we came in on their static) keeps our static reserved', () => {
			const sigs = { 1: { id: 1, systemID: 31001880, name: 'B' }, 2: { id: 2, systemID: 31000880, name: '!B' } };
			const holes = { 9: { id: 9, initialID: 1, secondaryID: 2, type: 'H296', parent: 'initial' } };
			const incoming = holeNaming.incomingType(31000880, 'B', holes, sigs);
			assert.equal(incoming, 'K162');
			assert.deepEqual(holeNaming.staticSlots(['U210'], 'B', WH, incoming), [{ type: 'U210', ch: 'A' }]);
		});
		it('incomingType: none at home, or no matching hole', () => {
			assert.equal(holeNaming.incomingType(31001880, '', {}, {}), '');
			assert.equal(holeNaming.incomingType(31000880, 'C', { 9: { initialID: 1, secondaryID: 2, type: 'U210', parent: 'secondary' } },
				{ 1: { id: 1, systemID: 31001880, name: 'B' }, 2: { id: 2, systemID: 31000880, name: '' } }), '');
		});
		it('Two statics, came in through the first: the second takes the first letter', () =>
			assert.deepEqual(holeNaming.staticSlots(['B274', 'O477'], 'A', WH, 'B274'), [{ type: 'O477', ch: 'A' }]));
		it('sideType', () => {
			const wh = { initialID: 1, secondaryID: 2, type: 'H296', parent: 'initial' };
			assert.deepEqual([holeNaming.sideType(1, wh), holeNaming.sideType(2, wh)], ['H296', 'K162']);
			assert.equal(holeNaming.sideType(1, { initialID: 1, secondaryID: 2, type: '????', parent: 'secondary' }), 'K162');
			assert.equal(holeNaming.sideType(1, { initialID: 1, secondaryID: 2, type: null, parent: 'initial' }), '');
			assert.equal(holeNaming.sideType(1, null), '');
		});
		it('A K162 is never a static', () => assert.deepEqual(holeNaming.reservation('K162', ['K162'], '', WH).own, null));
		it('No statics (k-space): nothing reserved', () => assert.deepEqual(holeNaming.reservation('H296', [], '', WH), { reserved: [], own: null }));
		it('Null prefix: nothing reserved', () => assert.deepEqual(holeNaming.staticSlots(['H296'], null, WH), []));
		it('Toggle off (no reservation) = the old behaviour', () => {
			assert.equal(holeNaming.nextName('', [], 'large', null), 'A');
			assert.equal(holeNaming.nextName('', [], 'large'), 'A');
		});
		it('staticFirst: missing means on', () => {
			assert.equal(holeNaming.staticFirst(undefined), true);
			assert.equal(holeNaming.staticFirst({ holeNaming: { enabled: true } }), true);
			assert.equal(holeNaming.staticFirst({ holeNaming: { staticFirst: false } }), false);
		});
		it('resolveConflict skips the reserved letter for a non-static', () =>
			assert.equal(holeNaming.resolveConflict('B', '', ['B'], holeNaming.reservation('K162', ['H296'], '', WH)), 'C'));
		it('resolveConflict gives a static its free reserved letter', () =>
			assert.equal(holeNaming.resolveConflict('B', '', ['B'], holeNaming.reservation('H296', ['H296'], '', WH)), 'A'));
		it('resolveConflict falls back to the reserved letter when nothing else is free', () =>
			assert.equal(holeNaming.resolveConflict('B', '', holeNaming.LETTERS.substring(1).split(''), { reserved: ['A'], own: null }), 'A'));
		it('raceRenames: the newer clashing hole skips the reserved letter', () => {
			const sigs = {
				1: { id: 1, systemID: 5, type: 'wormhole', name: 'B' },
				2: { id: 2, systemID: 5, type: 'wormhole', name: 'B' }
			};
			assert.deepEqual(holeNaming.raceRenames(sigs, 5, '', 'B', ['A']).map(r => [r.sig.id, r.name]), [[2, 'C']]);
			assert.deepEqual(holeNaming.raceRenames(sigs, 5, '', 'B').map(r => [r.sig.id, r.name]), [[2, 'A']], 'without reservation as before');
		});
	});
});
