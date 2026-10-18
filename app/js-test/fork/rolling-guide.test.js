const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/rolling-guide');

describe('Rolling guide', () => {
	const wh = () => appData.wormholes;

	describe('guideFor', () => {
		const cases = {
			R943: '750m', F135: '750m',
			X702: '1b', M267: '1b', C729: '1b',	// C729: 410,000 t max jump
			N968: '2b', B449: '2b', A641: '2b',	// B449 / A641: 1,000,000 t k-space links
			N062: '3b', K346: '3b', B520: '3b', D792: '3b',	// B520 / D792: 1,000,000 t
			H296: '3-3b', Z142: '3-3b', N432: '3-3b',	// 2,000,000 t
			D845: '5b'
		};
		Object.keys(cases).forEach(type => {
			it(type + ' -> ' + cases[type], () => assert.strictEqual(rollingGuide.guideFor(type, wh()), cases[type]));
		});
		it('checks the data the cases rely on', () => {
			assert.strictEqual(wh().C729.jump, 410e6);
			assert.strictEqual(wh().B449.jump, 1e9);
			assert.strictEqual(wh().B520.mass, 3e9);
			assert.strictEqual(wh().H296.jump, 2e9);
		});
		it('ignores case and spaces', () => assert.strictEqual(rollingGuide.guideFor(' h296 ', wh()), '3-3b'));
		it('holes too small for battleships have no guide', () => {
			['Z971', 'Q317', 'I078', 'N110', 'Q003'].forEach(t => assert.strictEqual(rollingGuide.guideFor(t, wh()), null, t));
		});
		it('K162, unknown and empty types have no guide', () => {
			['K162', '????', 'XXXX', '', null, undefined].forEach(t => assert.strictEqual(rollingGuide.guideFor(t, wh()), null, String(t)));
		});
		it('size-only placeholder types have no guide', () => {
			assert.strictEqual(rollingGuide.guideFor('LRG', { LRG: { jump: 375e6, mass: 2e9, dummy: true } }), null);
		});
		it('a battleship-sized hole of a mass without a guide has none', () => {
			assert.strictEqual(rollingGuide.guideFor('ABCD', { ABCD: { jump: 375e6, mass: 4e9 } }), null);
		});
		it('takes masses given as strings', () => {
			assert.strictEqual(rollingGuide.guideFor('ABCD', { ABCD: { jump: '2000000000', mass: '3300000000' } }), '3-3b');
		});
		it('every type in the game data with a battleship-sized jump has a guide', () => {
			Object.keys(wh()).filter(t => wh()[t].jump >= 300e6).forEach(t => assert.ok(rollingGuide.guideFor(t, wh()), t));
		});
	});

	describe('GUIDES', () => {
		it('lists the six sizes with their labels, smallest first', () => {
			assert.deepStrictEqual(rollingGuide.GUIDES.map(g => g.key), ['750m', '1b', '2b', '3b', '3-3b', '5b']);
			assert.deepStrictEqual(rollingGuide.GUIDES.map(g => g.label), ['750M', '1B', '2B', '3B', '3.3B', '5B']);
		});
		it('has an image for each one', () => {
			const fs = require('fs');
			rollingGuide.GUIDES.forEach(g => assert.ok(fs.existsSync('public/images/rolling-guide/' + g.key + '.png'), g.key));
		});
		it('imageUrl: a relative URL with the version, "" for an unknown key', () => {
			assert.strictEqual(rollingGuide.imageUrl('3-3b'), 'images/rolling-guide/3-3b.png?v=' + rollingGuide.IMAGE_VERSION);
			assert.strictEqual(rollingGuide.imageUrl('../x'), '');
		});
	});

	describe('holeType', () => {
		it('is the hole record\'s type', () => assert.strictEqual(rollingGuide.holeType({ type: 'H296', parent: 'secondary' }, wh()), 'H296'));
		it('is null for K162 / unknown / missing', () => {
			assert.strictEqual(rollingGuide.holeType({ type: 'K162' }, wh()), null);
			assert.strictEqual(rollingGuide.holeType({ type: '????' }, wh()), null);
			assert.strictEqual(rollingGuide.holeType({}, wh()), null);
			assert.strictEqual(rollingGuide.holeType(null, wh()), null);
		});
	});

	describe('formatting', () => {
		it('formatMass', () => {
			assert.strictEqual(rollingGuide.formatMass(3.3e9), '3.3B kg');
			assert.strictEqual(rollingGuide.formatMass(5e9), '5B kg');
			assert.strictEqual(rollingGuide.formatMass(750e6), '750M kg');
			assert.strictEqual(rollingGuide.formatMass(100e6), '100M kg');
			assert.strictEqual(rollingGuide.formatMass(undefined), '?');
		});
		it('formatTonnes', () => {
			assert.strictEqual(rollingGuide.formatTonnes(2e9), '2,000,000 t');
			assert.strictEqual(rollingGuide.formatTonnes(410e6), '410,000 t');
			assert.strictEqual(rollingGuide.formatTonnes(5e6), '5,000 t');
		});
		it('caption names the hole', () => {
			assert.strictEqual(rollingGuide.caption('H296', wh()), 'H296 · 3.3B kg · Max jump 2,000,000 t');
			assert.strictEqual(rollingGuide.caption('c729', wh()), 'C729 · 1B kg · Max jump 410,000 t');
			assert.strictEqual(rollingGuide.caption('K162', wh()), '');
		});
	});

	describe('forType', () => {
		it('a battleship hole: its guide and caption, no note', () => {
			assert.deepStrictEqual(rollingGuide.forType('N062', wh()), { guide: '3b', caption: 'N062 · 3B kg · Max jump 375,000 t', note: '' });
		});
		it('K162 / unknown: pick the size', () => {
			assert.deepStrictEqual(rollingGuide.forType('K162', wh()), { guide: null, caption: '', note: "Pick the hole's size" });
			assert.deepStrictEqual(rollingGuide.forType(null, wh()), { guide: null, caption: '', note: "Pick the hole's size" });
		});
		it('too small for battleships: says so, no guide', () => {
			const v = rollingGuide.forType('Z971', wh());
			assert.strictEqual(v.guide, null);
			assert.strictEqual(v.caption, 'Z971 · 100M kg · Max jump 62,000 t');
			assert.strictEqual(v.note, "This hole doesn't take battleships (max jump 62,000 t): the guide covers holes that do.");
		});
	});

	describe('settings', () => {
		it('defaults: closed, no size', () => {
			assert.deepStrictEqual(rollingGuide.settings(undefined), { open: false, size: null });
			assert.deepStrictEqual(rollingGuide.settings({ rollingGuide: 'x' }), { open: false, size: null });
		});
		it('reads open and a known size; drops an unknown size', () => {
			assert.deepStrictEqual(rollingGuide.settings({ rollingGuide: { open: true, size: '5b' } }), { open: true, size: '5b' });
			assert.deepStrictEqual(rollingGuide.settings({ rollingGuide: { open: 'yes', size: '9b' } }), { open: false, size: null });
		});
	});

	describe('bodyHtml', () => {
		it('six size buttons, the current one highlighted, then the image linking to the full size in a new tab', () => {
			const html = rollingGuide.bodyHtml({ size: '3-3b', caption: 'H296 · 3.3B kg · Max jump 2,000,000 t', holeGuide: '3-3b', note: '' });
			assert.strictEqual((html.match(/class='rg-tab[' ]/g) || []).length, 6);
			assert.ok(/class='rg-tab rg-active' data-rg-size='3-3b' aria-pressed='true'>3.3B</.test(html));
			assert.strictEqual((html.match(/rg-active/g) || []).length, 1);
			assert.ok(html.indexOf("<img src='images/rolling-guide/3-3b.png?v=") >= 0);
			assert.strictEqual((html.match(/target='_blank' rel='noopener'/g) || []).length, 2);
			assert.ok(html.indexOf('Open full size') >= 0);
			assert.ok(html.indexOf("<div class='rg-caption'>H296 · 3.3B kg") >= 0);
			assert.ok(html.indexOf('rg-note') < 0);
		});
		it('the caption goes once another size is picked', () => {
			const view = { caption: 'H296 · 3.3B kg · Max jump 2,000,000 t', holeGuide: '3-3b', note: '' };
			assert.ok(rollingGuide.bodyHtml(Object.assign({ size: '1b' }, view)).indexOf('rg-caption') < 0);
			assert.ok(rollingGuide.bodyHtml(Object.assign({ size: null }, view)).indexOf('rg-caption') >= 0);
			// A hole without a guide (too small): its caption shows until a size is picked
			const small = { caption: 'Z971 · 100M kg · Max jump 62,000 t', holeGuide: null, note: 'x' };
			assert.ok(rollingGuide.bodyHtml(Object.assign({ size: null }, small)).indexOf('rg-caption') >= 0);
			assert.ok(rollingGuide.bodyHtml(Object.assign({ size: '1b' }, small)).indexOf('rg-caption') < 0);
		});
		it('no size: the buttons and the note, no image', () => {
			const html = rollingGuide.bodyHtml({ size: null, caption: '', note: "Pick the hole's size" });
			assert.ok(html.indexOf('rg-active') < 0);
			assert.ok(html.indexOf('<img') < 0);
			assert.ok(html.indexOf("Pick the hole&#39;s size") >= 0);
		});
		it('escapes the caption and note', () => {
			const html = rollingGuide.bodyHtml({ size: null, caption: '<b>x</b>', note: '"&' });
			assert.ok(html.indexOf('<b>x</b>') < 0);
			assert.ok(html.indexOf('&lt;b&gt;x&lt;/b&gt;') >= 0);
			assert.ok(html.indexOf('&quot;&amp;') >= 0);
		});
		it('ignores an unknown size', () => {
			const html = rollingGuide.bodyHtml({ size: "x' onerror='alert(1)" });
			assert.ok(html.indexOf('<img') < 0);
			assert.ok(html.indexOf('onerror') < 0);
		});
	});
});
