const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/bookmark-template');
include('app/js/fork/hole-naming');
include('app/js/fork/jump-return');

// The same cases as tests/bookmark_template_test.php (the server validates with the same rules)
const VALID = [
	['hole', '={name} {class} {sig} {life}'], ['hole', '{name} {life}'], ['hole', '={life} {name}'], ['hole', '{name}-{sigid} {type}'], ['hole', '{NAME} {Size} {system}'],
	['back', '!{name}'], ['back', '<{name} {dir}'], ['back', '! {name} {system}']
];
const INVALID = [
	['hole', '', 'empty'], ['hole', '   ', 'empty'], ['hole', '={class} {sig}', '{name}'], ['hole', '={name} {nope}', 'Unknown token'],
	['hole', '={name', 'Unbalanced'], ['hole', '={name}}', 'Unbalanced'], ['hole', '={name} "x"', 'allowed'], ['hole', '={name}\n{sig}', 'allowed'],
	['hole', '={name}&{sig}', 'allowed'], ['back', '={name}', 'start with'], ['back', '{name}', 'start with'],
	['hole', '{name} {system} {system} {system} {system}', 'Too long'], ['hole', 'x'.repeat(81) + '{name}', 'at most 80'], ['hole', '!{name}', 'start with'], ['hole', '<{name}', 'start with'], ['hole', '{name} {name} {name} {name}', 'Too long'], ['other', '{name}', 'Unknown template'],
	['hole', '{life} {name}', 'start with'], ['hole', ' {class}{Life} {name}', 'start with']
];

describe('Bookmark templates', () => {
	describe('defaults reproduce the strings Tripwire made before templates', () => {
		const hole = args => holeNaming.bookmarkString(args);
		it('Name only', () => assert.equal(hole({ name: 'A' }), '=A'));
		it('Name, class, sig', () => assert.equal(hole({ name: 'a', classText: 'C5', sigAlpha: 'abc' }), '=A C5 ABC'));
		it('EOL', () => assert.equal(hole({ name: 'AB', classText: 'C5', sigAlpha: 'ABC', eol: true }), '=AB C5 ABC EOL'));
		it('No class', () => assert.equal(hole({ name: 'AB6', sigAlpha: 'XYZ', eol: true }), '=AB6 XYZ EOL'));
		it('Full sig id keeps the three letters', () => assert.equal(hole({ name: 'A', classText: 'HS', sigID: 'abc-123' }), '=A HS ABC'));
		it('Name suffix text is dropped', () => assert.equal(hole({ name: 'ba - drifter', classText: 'Thera' }), '=BA Thera'));
		it('Without a name there is no bookmark', () => assert.equal(hole({ name: '', classText: 'C5' }), null));
		it('Return bookmark', () => assert.equal(jumpReturn.returnString('AB', ''), '!AB'));
		it('The built-in templates are valid', () => {
			assert.equal(bookmarkTemplate.validate('hole', bookmarkTemplate.DEFAULTS.hole), '');
			assert.equal(bookmarkTemplate.validate('back', bookmarkTemplate.DEFAULTS.back), '');
		});
		it('Active before anything is loaded = the defaults', () => {
			assert.equal(bookmarkTemplate.active('hole'), bookmarkTemplate.DEFAULTS.hole);
			assert.equal(bookmarkTemplate.active('back'), bookmarkTemplate.DEFAULTS.back);
		});
	});

	describe('render', () => {
		const values = bookmarkTemplate.values({ name: 'ab', sigID: 'abc-123', type: 'c247', classText: 'C5', size: 'L', eol: true, system: 'J123456', dir: 'out' });
		it('All tokens', () => assert.equal(bookmarkTemplate.render('{name}|{sig}|{sigid}|{type}|{class}|{size}|{life}|{system}|{dir}', values), 'ab|ABC|ABC-123|C247|C5|L|EOL|J123456|out'));
		it('Tokens are case insensitive', () => assert.equal(bookmarkTemplate.render('{NAME} {Class}', values), 'ab C5'));
		it('Empty tokens leave no gap', () => assert.equal(bookmarkTemplate.render('={name}  {class} {sig}   {life}', bookmarkTemplate.values({ name: 'A', sigID: 'xyz' })), '=A XYZ'));
		it('Sig ID with letters only', () => assert.equal(bookmarkTemplate.values({ sigID: 'ABC' }).sigid, 'ABC'));
		it('Sig ID from letters and digits without a dash', () => assert.equal(bookmarkTemplate.values({ sigID: 'abc123' }).sigid, 'ABC-123'));
		it('Unknown type gives nothing', () => assert.equal(bookmarkTemplate.values({ type: '????' }).type, ''));
		it('Unknown tokens render as nothing', () => assert.equal(bookmarkTemplate.render('{name} {zzz}', values), 'ab'));
		it('Unsafe characters in values are dropped', () => assert.equal(bookmarkTemplate.render('{name}', { name: 'A<b>"&' }), 'Ab'));
		it('A long hand-typed name is kept whole while the string fits (legacy output)', () =>
			assert.equal(holeNaming.bookmarkString({ name: 'wormholehome1 - x', classText: 'C5', sigAlpha: 'ABC', eol: true }), '=WORMHOLEHOME1 C5 ABC EOL'));
		it('A name is shortened to 12 only when the string would be over 50', () => {
			const v = bookmarkTemplate.values({ name: 'ABCDEFGHIJKLMNOP' });
			assert.equal(bookmarkTemplate.render('{name} {name} {name} {name}', v), 'ABCDEFGHIJKL ABCDEFGHIJKL ABCDEFGHIJKL ABCDEFGHIJK');
			assert.equal(bookmarkTemplate.render('{name} {name}', v), 'ABCDEFGHIJKLMNOP ABCDEFGHIJKLMNOP');
		});
		it('Output is cut at 50 characters', () => assert.equal(bookmarkTemplate.render('{system}', { system: 'x'.repeat(80) }).length, 50));
		it('Sample values for the preview', () => assert.equal(bookmarkTemplate.render(bookmarkTemplate.DEFAULTS.hole, bookmarkTemplate.sampleValues('hole')), '=AB C5 ABC <1h'));
		it('a hole bookmark never starts with < (an old template that starts with {life})', () => {
			assert.equal(holeNaming.bookmarkString({ name: 'A', sigAlpha: 'ABC', life: '<1h', template: '{life} {name} {sig}' }), '1h A ABC');
			assert.equal(holeNaming.bookmarkString({ name: 'A', sigAlpha: 'ABC', life: 'EOL', template: '{life} {name} {sig}' }), 'EOL A ABC');
		});
		it('{life} is the life state (<4h, <1h, EOL), with < kept; without it eol gives EOL', () => {
			const hole = v => bookmarkTemplate.render(bookmarkTemplate.DEFAULTS.hole, bookmarkTemplate.values(Object.assign({ name: 'A', classText: 'C5', sigAlpha: 'ABC' }, v)));
			assert.equal(hole({ life: '<1h', eol: true }), '=A C5 ABC <1h');
			assert.equal(hole({ life: '<4h' }), '=A C5 ABC <4h');
			assert.equal(hole({ life: 'EOL' }), '=A C5 ABC EOL');
			assert.equal(hole({ life: '', eol: true }), '=A C5 ABC');
			assert.equal(hole({ eol: true }), '=A C5 ABC EOL');
			assert.equal(hole({ life: "<b>'x\"" }), '=A C5 ABC <bx');	// only letters, digits and < survive
		});
		it('Sample return value', () => assert.equal(bookmarkTemplate.render('!{name} {dir}', bookmarkTemplate.sampleValues('back')), '!AB in'));
	});

	describe('validate', () => {
		VALID.forEach(c => it('Accepts ' + c[0] + ' ' + JSON.stringify(c[1]), () => assert.equal(bookmarkTemplate.validate(c[0], c[1]), '')));
		INVALID.forEach(c => it('Rejects ' + c[0] + ' ' + JSON.stringify(c[1].slice(0, 30)), () => {
			const error = bookmarkTemplate.validate(c[0], c[1]);
			assert.ok(error !== '', 'should be rejected');
			assert.ok(error.toLowerCase().indexOf(c[2].toLowerCase()) >= 0, error);
		}));
		it('Longest values of the defaults fit', () => {
			const worst = {};
			bookmarkTemplate.TOKENS.forEach(t => { worst[t.token] = t.worst; });
			assert.ok(bookmarkTemplate.expand(bookmarkTemplate.DEFAULTS.hole, worst).length <= bookmarkTemplate.MAX_OUTPUT);
		});
		it('Not a string', () => assert.notEqual(bookmarkTemplate.validate('hole', null), ''));
	});

	describe('custom templates', () => {
		afterEach(() => bookmarkTemplate.use(null));
		it('use() makes the hole template apply', () => {
			bookmarkTemplate.use({ hole: '{name}-{sig} {class}', back: '<{name}' });
			assert.equal(holeNaming.bookmarkString({ name: 'AB', classText: 'C5', sigAlpha: 'ABC' }), 'AB-ABC C5');
			assert.equal(jumpReturn.returnString('AB', ''), '<AB');
		});
		it('Tokens that need data the caller has', () => {
			bookmarkTemplate.use({ hole: '={name} {type} {size} {system}', back: '!{name} {class}' });
			assert.equal(holeNaming.bookmarkString({ name: 'A', type: 'K162', size: 'XL', system: 'J123456' }), '=A K162 XL J123456');
			assert.equal(jumpReturn.returnString('A', '', { classText: 'HS' }), '!A HS');
		});
		it('An invalid server template falls back to the default', () => {
			bookmarkTemplate.use({ hole: '={class}', back: '{name}' });
			assert.equal(bookmarkTemplate.active('hole'), bookmarkTemplate.DEFAULTS.hole);
			assert.equal(bookmarkTemplate.active('back'), bookmarkTemplate.DEFAULTS.back);
		});
		it('Garbage answers give the defaults', () => {
			bookmarkTemplate.use(undefined);
			assert.deepEqual(bookmarkTemplate.current, bookmarkTemplate.DEFAULTS);
		});
		it('A return template keeps the sig name recognisable as a return bookmark', () => {
			bookmarkTemplate.use({ hole: '={name}', back: '<{name} home' });
			assert.equal(holeNaming.isReturnBookmark(jumpReturn.returnString('AB', '')), true);
		});
	});
});
