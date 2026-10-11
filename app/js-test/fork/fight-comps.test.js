const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/fight-comps');
include('app/js/fork/rally');

const ARMOR = { id: 'c0123456789', name: 'Armor HACs', colour: 'red', note: 'Zealots + Sacrileges' };
const SHIELD = { id: 'cabcdefabcd', name: 'Shield BS', colour: 'blue', note: '' };
const names = { 31001882: 'J122515', 31000702: 'J150627' };
const nameOf = function(id) { return names[id] || String(id); };

describe('Fight here: fleet comps', () => {
	describe('normaliseComps', () => {
		it('keeps valid comps in order, without the mention', () => {
			assert.deepStrictEqual(fightComps.normaliseComps([Object.assign({ mention: '<@&123456789012345678>' }, ARMOR), SHIELD]), [ARMOR, SHIELD]);
		});
		it('drops entries without an id or name, bad ids and duplicates', () => {
			const list = [null, 'x', { id: 'c0123456789', name: '  ' }, { id: 'nope', name: 'X', colour: 'red' }, ARMOR, Object.assign({}, ARMOR, { name: 'Again' })];
			assert.deepStrictEqual(fightComps.normaliseComps(list), [ARMOR]);
		});
		it('unknown colours become green, text is one trimmed line, lengths capped', () => {
			const c = fightComps.normaliseComps([{ id: 'c0000000001', name: ' A\n\tB ', colour: 'javascript:alert(1)', note: 'x'.repeat(200) }])[0];
			assert.strictEqual(c.name, 'A B');
			assert.strictEqual(c.colour, 'green');
			assert.strictEqual(c.note.length, 140);
		});
		it('at most 20', () => {
			const many = [];
			for (let i = 0; i < 25; i++) { many.push({ id: 'c' + String(i).padStart(10, '0'), name: 'Comp ' + i, colour: 'red' }); }
			assert.strictEqual(fightComps.normaliseComps(many).length, 20);
		});
		it('not a list', () => assert.deepStrictEqual(fightComps.normaliseComps(undefined), []));
	});

	describe('menu', () => {
		it('no fight: no comp, the comps, no clear', () => {
			const entries = fightComps.menuEntries([ARMOR, SHIELD], null, 31001882, nameOf);
			assert.deepStrictEqual(entries.map(e => e === '-' ? '-' : e.cmd + ' ' + e.text), [
				'fightSet: Fight here (no comp)', '-', 'fightSet:c0123456789 Armor HACs', 'fightSet:cabcdefabcd Shield BS']);
			assert.strictEqual(entries[2].colour, 'red');
			assert.strictEqual(entries[2].title, 'Zealots + Sacrileges');
		});
		it('no comps: only "Fight here (no comp)"', () => {
			assert.deepStrictEqual(fightComps.menuEntries([], null, 31001882, nameOf).map(e => e.text), ['Fight here (no comp)']);
		});
		it('fight here with a comp: that comp is current, Clear fight at the end', () => {
			const entries = fightComps.menuEntries([ARMOR, SHIELD], { systemID: 31001882, comp: ARMOR }, 31001882, nameOf);
			assert.deepStrictEqual(entries.filter(e => e.current).map(e => e.text), ['Armor HACs']);
			assert.deepStrictEqual(entries.slice(-2), ['-', { cmd: 'fightClear', text: 'Clear fight' }]);
		});
		it('fight here without a comp: "no comp" is current', () => {
			const entries = fightComps.menuEntries([ARMOR], { systemID: 31001882, comp: null }, 31001882, nameOf);
			assert.deepStrictEqual(entries.filter(e => e.current).map(e => e.text), ['Fight here (no comp)']);
		});
		it('fight elsewhere: nothing current, Clear fight names the system', () => {
			const entries = fightComps.menuEntries([ARMOR], { systemID: 31001882, comp: ARMOR }, 31000702, nameOf);
			assert.deepStrictEqual(entries.filter(e => e.current), []);
			assert.strictEqual(entries[entries.length - 1].text, 'Clear fight (J122515)');
		});
		it('menu HTML escapes comp names and notes', () => {
			const evil = { id: 'c0000000002', name: "<img src=x onerror=alert(1)>'", colour: 'red', note: "' onmouseover='x" };
			const html = fightComps.menuHtml(fightComps.menuEntries([evil], null, 1, nameOf));
			assert.ok(html.indexOf('<img') < 0, html);
			assert.ok(html.indexOf("&lt;img src=x onerror=alert(1)&gt;&#39;") > 0, html);
			assert.ok(html.indexOf("title='&#39; onmouseover=&#39;x'") > 0, html);
			assert.ok(html.indexOf("<li>-</li>") > 0);
		});
		it('menu HTML colours the dot from the palette only and marks the current entry', () => {
			const html = fightComps.menuHtml([{ cmd: 'fightSet:c0123456789', text: 'A', colour: 'red', current: true }]);
			assert.ok(html.indexOf("background-color: #ff4747") > 0, html);
			assert.ok(html.indexOf('fight-current') > 0 && html.indexOf('&#10003;') > 0, html);
		});
		it('no comps: the one-click entry (old rally behaviour)', () => {
			assert.deepStrictEqual(fightComps.flatEntry(null, 31001882), { text: 'Fight here', clear: false });
			assert.deepStrictEqual(fightComps.flatEntry({ systemID: 31001882 }, 31001882), { text: 'Clear fight', clear: true });
			assert.deepStrictEqual(fightComps.flatEntry({ systemID: 31001882 }, 31000702), { text: 'Fight here', clear: false });
		});
		it('commands', () => {
			assert.strictEqual(fightComps.compOfCommand('fightSet:'), '');
			assert.strictEqual(fightComps.compOfCommand('fightSet:c0123456789'), 'c0123456789');
			assert.strictEqual(fightComps.compOfCommand("fightSet:c01'><x"), null);
			assert.strictEqual(fightComps.compOfCommand('fightClear'), null);
			assert.strictEqual(fightComps.compOfCommand(undefined), null);
		});
	});

	describe('banner', () => {
		it('age', () => {
			assert.strictEqual(fightComps.ageText(0), 'just now');
			assert.strictEqual(fightComps.ageText(59), 'just now');
			assert.strictEqual(fightComps.ageText(60), '1 min ago');
			assert.strictEqual(fightComps.ageText(4 * 60 + 59), '4 min ago');
			assert.strictEqual(fightComps.ageText(3 * 3600 + 5), '3 h ago');
			assert.strictEqual(fightComps.ageText(2 * 86400), '2 d ago');
			assert.strictEqual(fightComps.ageText(-5), 'just now');
		});
		it('system classes as the Discord message shows them', () => {
			assert.strictEqual(fightComps.systemClass({ class: 5 }), 'C5');
			assert.strictEqual(fightComps.systemClass({ class: 12 }), 'Thera');
			assert.strictEqual(fightComps.systemClass({ class: 14 }), 'Drifter');
			assert.strictEqual(fightComps.systemClass({ security: 0.9 }), 'HS');
			assert.strictEqual(fightComps.systemClass({ security: 0.45 }), 'HS');
			assert.strictEqual(fightComps.systemClass({ security: 0.2 }), 'LS');
			assert.strictEqual(fightComps.systemClass({ security: -0.3 }), 'NS');
			assert.strictEqual(fightComps.systemClass({ security: -1, regionID: 10000070 }), 'Pochven');
			assert.strictEqual(fightComps.systemClass(null), '');
		});
		it('the approved line: label, class, route, comp, who, age', () => {
			const parts = fightComps.bannerParts({ systemID: 31001882, label: 'AB', setBy: 'Chribba', comp: ARMOR }, { name: 'J163701', class: 5 }, '2 jumps', 4 * 60 + 10);
			assert.strictEqual(parts.text, 'Fight here: AB · J163701 (C5, 2 jumps) · Armor HACs · set by Chribba · 4 min ago');
			assert.strictEqual(parts.where, 'AB · J163701');
			assert.strictEqual(parts.comp.colour, 'red');
			assert.strictEqual(fightComps.bannerTitle(parts), parts.text + '\nArmor HACs: Zealots + Sacrileges');
		});
		it('without label, comp, who or age', () => {
			const parts = fightComps.bannerParts({ systemID: 30000142, label: '', comp: null }, { name: 'Jita', security: 0.95 }, '', null);
			assert.strictEqual(parts.text, 'Fight here: Jita (HS)');
			assert.strictEqual(fightComps.bannerTitle(parts), 'Fight here: Jita (HS)');
		});
		it('unknown system: its ID', () => {
			assert.strictEqual(fightComps.bannerParts({ systemID: 31000001 }, null, 'not on this map', 0).text, 'Fight here: 31000001 (not on this map) · just now');
		});
	});

	describe('Mask Admin form', () => {
		it('a valid new comp', () => {
			const r = fightComps.formComp({ name: '  Armor  HACs ', colour: 'red', note: ' doctrine ', mention: ' <@&123456789012345678>  @here ' }, [], null);
			assert.deepStrictEqual(r, { comp: { name: 'Armor HACs', colour: 'red', note: 'doctrine', mention: '<@&123456789012345678> @here' }, errors: [] });
		});
		it('edits keep the id; the same name is fine for the comp itself', () => {
			const r = fightComps.formComp({ name: 'armor hacs', colour: 'blue', note: '', mention: '' }, [ARMOR], ARMOR.id);
			assert.deepStrictEqual(r.errors, []);
			assert.strictEqual(r.comp.id, ARMOR.id);
		});
		it('errors: name, length, colour, mention, duplicate, limit', () => {
			assert.deepStrictEqual(fightComps.formComp({ name: '', colour: 'red' }, [], null).errors, ['Give the comp a name']);
			assert.deepStrictEqual(fightComps.formComp({ name: 'x'.repeat(41), colour: 'red' }, [], null).errors, ['The name can be at most 40 characters']);
			assert.deepStrictEqual(fightComps.formComp({ name: 'A', colour: '#ff0000' }, [], null).errors, ['Pick one of the colours']);
			assert.deepStrictEqual(fightComps.formComp({ name: 'A', colour: 'red', note: 'x'.repeat(141) }, [], null).errors, ['The note can be at most 140 characters']);
			assert.deepStrictEqual(fightComps.formComp({ name: 'A', colour: 'red', mention: '@armor' }, [], null).errors,
				['The Discord mention may only contain <@&roleID>, <@userID>, @here or @everyone']);
			assert.deepStrictEqual(fightComps.formComp({ name: 'ARMOR HACS', colour: 'red' }, [ARMOR], null).errors, ['There is already a comp called "Armor HACs"']);
			const many = [];
			for (let i = 0; i < 20; i++) { many.push({ id: 'c' + String(i).padStart(10, '0'), name: 'C' + i }); }
			assert.deepStrictEqual(fightComps.formComp({ name: 'New', colour: 'red' }, many, null).errors, ['At most 20 fleet comps per mask']);
		});
		it('reorder', () => {
			assert.deepStrictEqual(fightComps.moved(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
			assert.deepStrictEqual(fightComps.moved(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
			assert.deepStrictEqual(fightComps.moved(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
			assert.deepStrictEqual(fightComps.moved(['a', 'b', 'c'], 'x', 1), ['a', 'b', 'c']);
		});
		it('page escapes names, notes and mentions', () => {
			const html = fightComps.pageHtml({ mask: { name: '<b>Corp</b>' }, comps: [{ id: 'c0000000003', name: '<script>x</script>', colour: 'red', note: '"><img>', mention: '<@&123456789012345678>' }] }, null);
			assert.ok(html.indexOf('<script>') < 0 && html.indexOf('<img>') < 0 && html.indexOf('<b>Corp') < 0, html);
			assert.ok(html.indexOf('&lt;@&amp;123456789012345678&gt;') > 0, html);
			assert.ok(html.indexOf('1 of 20') > 0);
		});
		it('page form holds the comp being edited', () => {
			const html = fightComps.pageHtml({ comps: [ARMOR] }, ARMOR);
			assert.ok(html.indexOf("value='Armor HACs'") > 0 && html.indexOf("value='red' checked") > 0 && html.indexOf('Save comp') > 0, html);
		});
	});
});

describe('Fight here: chain map', () => {
	const map = () => ({
		map: { rows: [
			{ c: [{ v: 1, systemID: 31002238, f: "<div class='node top-level'></div>" }, { v: null }] },
			{ c: [{ v: 2, systemID: 31001882, f: "<div class='node '></div>" }, { v: 1 }] }
		] },
		lines: [[2, 1, ['fight-c-blue'], 77]]
	});
	it('the node and route get the comp colour', () => {
		const result = map();
		const info = rally.decorate(result, 31001882, { tracked: 31002238 }, rally.colourClass(ARMOR));
		assert.strictEqual(info.jumps, 1);
		assert.ok(result.map.rows[1].c[0].f.indexOf("class='node rally-node fight-c-red ") > 0, result.map.rows[1].c[0].f);
		assert.deepStrictEqual(result.lines[0][2], ['rally-route', 'fight-c-red']);
	});
	it('no comp: the plain rally style', () => {
		const result = map();
		rally.decorate(result, 31001882, { tracked: 31002238 }, rally.colourClass(null));
		assert.ok(result.map.rows[1].c[0].f.indexOf("class='node rally-node '") > 0);
		assert.deepStrictEqual(result.lines[0][2], ['rally-route']);
	});
	it('colour classes only from the palette', () => {
		assert.strictEqual(rally.colourClass({ colour: "red' onload='x" }), 'fight-c-green');
		assert.strictEqual(rally.colourClass({ colour: 'cyan' }), 'fight-c-cyan');
		assert.strictEqual(rally.colourClass(null), '');
	});
	it('state from the server and what counts as a change', () => {
		const a = rally.normaliseState({ systemID: 31001882, setBy: 'C', comp: ARMOR, label: 'AB', age: 30 }, 1000);
		assert.deepStrictEqual(a, { systemID: 31001882, setBy: 'C', setAt: null, comp: ARMOR, label: 'AB', age: 30, receivedAt: 1000 });
		assert.strictEqual(rally.ageNow(a, 61000), 90);
		const b = rally.normaliseState({ systemID: 31001882, setBy: 'C', comp: SHIELD, age: 0 }, 1000);
		assert.ok(rally.differs(a, b), 'comp change');
		assert.ok(!rally.differs(a, rally.normaliseState({ systemID: 31001882, comp: ARMOR }, 5)), 'same system and comp');
		assert.ok(rally.differs(a, rally.normaliseState(null)), 'cleared');
		assert.deepStrictEqual(rally.normaliseState({ systemID: 'x' }).systemID, null);
	});
	it('banner toggle: on unless turned off', () => {
		assert.ok(rally.bannerEnabled(undefined));
		assert.ok(rally.bannerEnabled({}));
		assert.ok(rally.bannerEnabled({ fightBanner: { enabled: true } }));
		assert.ok(!rally.bannerEnabled({ fightBanner: { enabled: false } }));
	});
	it('notification text is escaped', () => {
		assert.strictEqual(rally.notifyText('AB · J1', { comp: { name: '<b>x</b>' }, setBy: '<i>' }), 'Fight here: AB · J1 &middot; &lt;b&gt;x&lt;/b&gt; (set by &lt;i&gt;)');
	});
});
