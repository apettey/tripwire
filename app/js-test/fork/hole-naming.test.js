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
