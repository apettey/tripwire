const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/command-palette-index');
include('app/js/fork/command-args');

// Chain: root R(J111111) -[AA]-> J222222 -[AB]-> J333333 ; R -[A]-> Rens(k-space) ; R -[B2 - DRIFTER]-> J444444
const systems = {
	1: { name: 'J111111', class: 3 }, 2: { name: 'J222222', class: 4 }, 3: { name: 'J333333', class: 2 },
	4: { name: 'Rens', security: 0.9 }, 5: { name: 'J444444', class: 1 }
};
const node = (v, systemID, whId) => ({ v: v, systemID: systemID, f: whId ? "<div id='node" + v + "' data-nodeid='" + systemID + "' data-sigid='" + whId + "' class='node'></div>" : "<div class='node'></div>" });
const rows = [
	{ c: [node(100, 1), { v: null }] },
	{ c: [node(101, 2, 11), { v: 100 }], pathHome: [{ systemID: 2, name: 'AA', type: 'H296', signatureID: 'abc123' }] },
	{ c: [node(102, 3, 12), { v: 101 }], pathHome: [{ systemID: 2, name: 'AA' }, { systemID: 3, name: 'AB', type: 'K162', signatureID: 'def456' }] },
	{ c: [node(103, 4, 13), { v: 100 }], pathHome: [{ systemID: 4, name: 'A', type: 'B274', signatureID: 'ghi789' }] },
	{ c: [node(104, 5, 14), { v: 100 }], pathHome: [{ systemID: 5, name: 'B2 - DRIFTER', signatureID: 'jkl012' }] },
	{ c: [node(105, 4, 'ES-9'), { v: 100 }], pathHome: [{ systemID: 4, name: 'x' }] }	// EVE-Scout link: no numeric id
];
const wormholes = { 11: { id: 11, type: 'H296', life: 'critical' }, 12: { id: 12, type: 'K162', mass: 'destab' }, 13: { id: 13, type: 'B274' }, 14: { id: 14 } };

const holes = () => paletteArgs.holes({ rows: rows, wormholes: wormholes, systems: systems, viewingID: 2 }).map(paletteIndex.item);
const rankHoles = (q) => paletteArgs.rank(holes(), q).map(h => h.value);

describe('Palette argument candidates', () => {
	describe('holes', () => {
		it('one candidate per numbered wormhole, none for the root or EVE-Scout links', () => {
			assert.deepEqual(holes().map(h => h.value), [11, 12, 13, 14]);
		});
		it('title, system behind and the system it leaves', () => {
			const h = holes()[0];
			assert.equal(h.title, 'AA → J222222 (from J111111)');
			assert.equal(h.systemID, 2);
			assert.equal(h.parentSystemID, 1);
			assert.equal(h.subtitle, 'H296 · ABC-123 · EOL');
			assert.equal(holes()[1].subtitle, 'K162 · DEF-456 · destab');
		});
		it('a hole missing from tripwire.client.wormholes is not offered', () => {
			const some = paletteArgs.holes({ rows: rows, wormholes: { 11: wormholes[11] }, systems: systems, viewingID: 2 });
			assert.deepEqual(some.map(h => h.value), [11]);
		});
		it('without a wormholes table every numbered node counts', () => {
			assert.equal(paletteArgs.holes({ rows: rows, systems: systems, viewingID: 2 }).length, 4);
		});
		it('survives missing data', () => {
			assert.deepEqual(paletteArgs.holes(null), []);
			assert.deepEqual(paletteArgs.holes({ rows: [{ c: [] }, null] }), []);
		});
	});

	describe('hole names as arguments', () => {
		it('"AA" is hole AA, not AB, and "A" is hole A before AA and AB', () => {
			assert.equal(rankHoles('aa')[0], 11);
			assert.equal(rankHoles('a')[0], 13);
			assert.ok(rankHoles('a').indexOf(11) > rankHoles('a').indexOf(13));
		});
		it('the full hole name works too, and its first token', () => {
			assert.equal(rankHoles('b2')[0], 14);
			assert.equal(rankHoles('b2drifter')[0], 14);
		});
		it('J-code of the system behind or the one it leaves, with or without the J', () => {
			assert.equal(rankHoles('j333333')[0], 12);
			assert.equal(rankHoles('333333')[0], 12);
			assert.deepEqual(rankHoles('j111111').sort(), [11, 13, 14]);	// the root is on the other side of AA, A and B2
		});
		it('system name of a k-space neighbour, wormhole type and sig ID', () => {
			assert.equal(rankHoles('rens')[0], 13);
			assert.equal(rankHoles('h296')[0], 11);
			assert.equal(rankHoles('abc123')[0], 11);
			assert.equal(rankHoles('abc-123')[0], 11);
		});
		it('holes of the viewed system rank first when the query is ambiguous', () => {
			// viewing J222222 touches AA (leaves the root into it) and AB (leaves it); "j" matches all four
			const top = rankHoles('j').slice(0, 2).sort();
			assert.deepEqual(top, [11, 12]);
		});
		it('no fuzzy matching of hole names', () => {
			assert.deepEqual(rankHoles('zz'), []);
		});
		it('ambiguous queries keep every match for the pick list', () => {
			assert.deepEqual(rankHoles('a').sort(), [11, 12, 13]);
		});
	});

	describe('choices and listing', () => {
		const cands = () => paletteArgs.choices([{ value: 'stable', title: 'Stable' }, { value: 'critical', title: 'EOL', keys: ['eol', 'critical'] }]).map(paletteIndex.item);
		it('choices become candidates in their declared order', () => {
			assert.deepEqual(paletteArgs.listAll(cands()).map(c => c.value), ['stable', 'critical']);
		});
		it('ranks by title and keywords', () => {
			assert.equal(paletteArgs.rank(cands(), 'eol')[0].value, 'critical');
			assert.equal(paletteArgs.rank(cands(), 'crit')[0].value, 'critical');
			assert.equal(paletteArgs.rank(cands(), 'st')[0].value, 'stable');
		});
		it('listAll puts the default first, then holes next to the viewed system', () => {
			const list = paletteArgs.listAll(holes(), 14);
			assert.equal(list[0].value, 14);
			assert.deepEqual(list.slice(1, 3).map(c => c.value).sort(), [11, 12]);
		});
		it('an empty query ranks nothing (the caller lists everything)', () => {
			assert.deepEqual(paletteArgs.rank(cands(), ''), []);
		});
	});

	describe('chain systems as candidates', () => {
		const items = [
			paletteIndex.item({ key: 'sys:2', kind: 'chain', systemID: 2, title: 'J222222', keys: ['AA'], pin: true }),
			paletteIndex.item({ key: 'sys:4', kind: 'chain', systemID: 4, title: 'Rens', keys: ['A'] }),
			paletteIndex.item({ key: 'sig:1', kind: 'sig', sigID: 1, title: 'ABC-123', keys: ['abc123'] })
		];
		it('keeps chain systems, value is the system id, filter applies', () => {
			assert.deepEqual(paletteArgs.chainSystems(items).map(c => c.value), [2, 4]);
			assert.deepEqual(paletteArgs.chainSystems(items, id => id === 4).map(c => c.value), [4]);
			assert.equal(paletteArgs.chainSystems(items)[0].kind, 'arg');
		});
		it('"aa" is the system behind hole AA', () => {
			assert.equal(paletteArgs.rank(paletteArgs.chainSystems(items), 'aa')[0].value, 2);
		});
		it('signatures as candidates', () => {
			assert.deepEqual(paletteArgs.signatures(items).map(c => c.value), [1]);
		});
	});
});

describe('Palette one-line commands', () => {
	const commands = [
		{ id: 'rally.fightHere', title: 'Fight here', keywords: ['rally'], args: [
			{ name: 'system', type: 'chainSystem', default: () => 1 },
			{ name: 'comp', type: 'choice', optional: true }
		] },
		{ id: 'rolling.mark', title: 'Mark rolling', keywords: ['roll'], args: [{ name: 'hole', type: 'hole' }] },
		{ id: 'rolling.stop', title: 'Stop rolling', args: [{ name: 'hole', type: 'hole' }] },
		{ id: 'pm.set', title: 'Preserve mass', keywords: [], args: [{ name: 'hole', type: 'hole' }] },
		{ id: 'hole.life', title: 'Set life', keywords: ['eol'], args: [{ name: 'hole', type: 'hole' }, { name: 'life', type: 'choice' }] },
		{ id: 'hole.mass', title: 'Set mass', keywords: [], args: [{ name: 'hole', type: 'hole' }, { name: 'mass', type: 'choice' }] },
		{ id: 'nav.copy', title: 'Copy system name', keywords: [] }	// no args: never an inline command
	];
	const chainCands = paletteArgs.chainSystems([
		paletteIndex.item({ key: 'sys:1', kind: 'chain', systemID: 1, title: 'J111111', keys: [] }),
		paletteIndex.item({ key: 'sys:2', kind: 'chain', systemID: 2, title: 'J222222', keys: ['AA'] }),
		paletteIndex.item({ key: 'sys:3', kind: 'chain', systemID: 3, title: 'J333333', keys: ['AB'] })
	]).map(c => Object.assign(c, { fuzzy: false }));
	const lifeChoices = paletteArgs.choices([{ value: 'stable', title: 'Stable' }, { value: 'critical', title: 'EOL', keys: ['eol'] }]).map(paletteIndex.item);
	const massChoices = paletteArgs.choices([{ value: 'stable', title: 'Stable' }, { value: 'destab', title: 'Destab' }, { value: 'critical', title: 'Critical' }]).map(paletteIndex.item);
	const strictHoles = () => holes().map(h => Object.assign(h, { fuzzy: false }));
	const compChoices = paletteArgs.choices([{ value: 'logi', title: 'Logi fleet' }, { value: 'dps', title: 'DPS fleet' }]).map(paletteIndex.item);

	const env = {
		resolve: (arg, text, command) => {
			const pool = arg.type === 'hole' ? strictHoles() : arg.type === 'chainSystem' ? chainCands
				: arg.name === 'life' ? lifeChoices : arg.name === 'mass' ? massChoices : arg.name === 'comp' ? compChoices : [];
			return paletteArgs.rank(pool, text, 8);
		},
		defaultFor: (arg) => arg.default ? chainCands.filter(c => c.value === arg.default())[0] || null : null
	};
	const run = (q) => paletteArgs.inline(commands, q, env);
	const vals = (d) => paletteArgs.values(d.command.args, d.filled);

	describe('splitting the command words from the argument', () => {
		it('"fight j1234" -> Fight here + "j1234"', () => {
			const s = paletteArgs.splitInline(commands, 'fight j1234');
			assert.equal(s[0].command.id, 'rally.fightHere');
			assert.deepEqual(s[0].rest, ['j1234']);
		});
		it('prefix of the title, a later word of the title, the acronym and a keyword all find the command', () => {
			assert.equal(paletteArgs.splitInline(commands, 'mark rolling a')[0].command.id, 'rolling.mark');
			assert.equal(paletteArgs.splitInline(commands, 'mark roll a')[0].command.id, 'rolling.mark');
			assert.equal(paletteArgs.splitInline(commands, 'pre ab').length, 1);
			assert.equal(paletteArgs.splitInline(commands, 'fh aa')[0].command.id, 'rally.fightHere');
			assert.equal(paletteArgs.splitInline(commands, 'rally aa')[0].command.id, 'rally.fightHere');
		});
		it('"roll b2" matches both rolling commands, best first', () => {
			const ids = paletteArgs.splitInline(commands, 'roll b2').map(m => m.command.id);
			assert.deepEqual(ids.sort(), ['rolling.mark', 'rolling.stop']);
		});
		it('the longest run of command words wins: "preserve mass ab" is not "pre" + "serve mass ab"', () => {
			const s = paletteArgs.splitInline(commands, 'preserve mass ab');
			assert.equal(s[0].command.id, 'pm.set');
			assert.deepEqual(s[0].rest, ['ab']);
		});
		it('needs at least one argument word and a command with arguments', () => {
			assert.deepEqual(paletteArgs.splitInline(commands, 'fight'), []);
			assert.deepEqual(paletteArgs.splitInline(commands, 'copy system'), []);
			assert.deepEqual(paletteArgs.splitInline(commands, 'zzz aa'), []);
			assert.deepEqual(paletteArgs.splitInline(commands, 'f aa'), []);	// one letter is too loose
		});
	});

	describe('arguments from one line', () => {
		it('"fight AA": the system behind hole AA, complete (the comp is optional)', () => {
			const d = run('fight AA')[0];
			assert.equal(d.command.id, 'rally.fightHere');
			assert.deepEqual(vals(d), { system: 2 });
			assert.equal(d.complete, true);
		});
		it('"fight j333333 logi": system and optional comp, in that order', () => {
			const d = run('fight j333333 logi')[0];
			assert.deepEqual(vals(d), { system: 3, comp: 'logi' });
		});
		it('"fight logi" (only the comp): the system falls back to the default', () => {
			const d = run('fight logi')[0];
			assert.deepEqual(vals(d), { system: 1, comp: 'logi' });
		});
		it('"mark rolling A": hole A first, then the other holes starting with A', () => {
			const d = run('mark rolling A');
			assert.equal(d[0].command.id, 'rolling.mark');
			assert.deepEqual(d.map(x => vals(x).hole), [13, 11, 12]);	// A, AA, AB
			assert.ok(d.every(x => x.complete));
		});
		it('"preserve mass AB" is hole AB', () => {
			// AB first; hole AA follows only because its sig ID (ABC-123) also starts with "ab"
			assert.deepEqual(run('preserve mass AB').map(vals), [{ hole: 12 }, { hole: 11 }]);
		});
		it('J-codes and system names work for holes: "mark rolling j333333", "mark rolling rens"', () => {
			assert.equal(vals(run('mark rolling j333333')[0]).hole, 12);
			assert.equal(vals(run('mark rolling rens')[0]).hole, 13);
		});
		it('"life eol B2" and "life B2 eol" are the same', () => {
			const a = run('life eol B2')[0], b = run('life B2 eol')[0];
			assert.equal(a.command.id, 'hole.life');
			assert.deepEqual(vals(a), { hole: 14, life: 'critical' });
			assert.deepEqual(vals(b), { hole: 14, life: 'critical' });
			assert.equal(a.complete, true);
		});
		it('"mass crit B2" -> critical, "mass destab ab" -> destab', () => {
			assert.deepEqual(vals(run('mass crit B2')[0]), { hole: 14, mass: 'critical' });
			assert.deepEqual(vals(run('mass destab ab')[0]), { hole: 12, mass: 'destab' });
		});
		it('"life eol" without the hole is incomplete and asks for the hole', () => {
			const d = run('life eol')[0];
			assert.equal(d.complete, false);
			assert.equal(d.next, 0);
			assert.deepEqual(vals(d), { life: 'critical' });
		});
		it('an argument that matches nothing gives no row', () => {
			assert.deepEqual(run('mark rolling zzzz'), []);
			assert.deepEqual(run('fight zzzz'), []);
		});
		it('too many words are ignored beyond the limit and do not throw', () => {
			assert.doesNotThrow(() => run('life eol b2 a b c d e f g h'));
		});
	});

	describe('breadcrumb and values', () => {
		it('lists the command and the titles of the filled arguments', () => {
			const d = run('life eol B2')[0];
			assert.equal(paletteArgs.breadcrumb(d.command, d.command.args, d.filled), 'Set life › B2 → J444444 (from J111111) › EOL');
		});
		it('values are keyed by argument name and leave out unfilled ones', () => {
			assert.deepEqual(paletteArgs.values([{ name: 'a' }, { name: 'b' }], { 1: { value: 7 } }), { b: 7 });
		});
	});

	describe('helpers', () => {
		it('words splits on any whitespace', () => {
			assert.deepEqual(paletteArgs.words('  fight   aa '), ['fight', 'aa']);
			assert.deepEqual(paletteArgs.words(null), []);
		});
		it('cuts: every way to split tokens into k consecutive groups', () => {
			assert.deepEqual(paletteArgs.cuts(['a', 'b', 'c'], 2), [['a', 'b c'], ['a b', 'c']]);
			assert.deepEqual(paletteArgs.cuts(['a', 'b'], 3), []);
			assert.deepEqual(paletteArgs.cuts(['a', 'b'], 1), [['a b']]);
		});
		it('orders: the declared order first, at most three arguments permuted', () => {
			assert.deepEqual(paletteArgs.orders(2), [[0, 1], [1, 0]]);
			assert.equal(paletteArgs.orders(5).length, 6);
			assert.deepEqual(paletteArgs.orders(5)[0], [0, 1, 2]);
		});
		it('holeToken', () => {
			assert.equal(paletteArgs.holeToken('ba - drifter'), 'BA');
			assert.equal(paletteArgs.holeToken('  !ab'), '');
			assert.equal(paletteArgs.holeToken(null), '');
		});
	});
});

describe('Palette: ties and Settings guard', () => {
	// two different holes both named AA, on different parents
	const tsys = { 1: { name: 'J111111' }, 2: { name: 'J222222' }, 3: { name: 'J333333' }, 4: { name: 'J444444' } };
	const n = (v, s, id) => ({ v: v, systemID: s, f: "<div data-sigid='" + id + "'></div>" });
	const trows = [
		{ c: [{ v: 1, systemID: 1, f: '<div></div>' }, { v: null }] },
		{ c: [n(2, 2, 11), { v: 1 }], pathHome: [{ name: 'AA', signatureID: 'abc123' }] },
		{ c: [n(3, 3, 12), { v: 2 }], pathHome: [{ name: 'A' }, { name: 'AA', signatureID: 'def456' }] }
	];
	const hs = () => paletteArgs.holes({ rows: trows, systems: tsys, viewingID: 4 }).map(h => Object.assign(paletteIndex.item(h), { fuzzy: false }));
	const cmds = [{ id: 'm', title: 'Mark rolling', args: [{ name: 'hole', type: 'hole' }] }];
	const env = { resolve: (arg, text) => paletteArgs.rank(hs(), text, 8) };
	it('every hole row shows where it leads and where it comes from', () => {
		assert.deepEqual(hs().map(h => h.title), ['AA → J222222 (from J111111)', 'AA → J333333 (from J222222)']);
	});
	it('two holes named AA tie: the descriptors are marked so nothing is pre-selected', () => {
		const d = paletteArgs.inline(cmds, 'mark rolling aa', env);
		assert.equal(d.length, 2);
		assert.ok(d.every(x => x.tie));
	});
	it('a clear winner is not a tie', () => {
		const d = paletteArgs.inline(cmds, 'mark rolling j333333', env);
		assert.equal(d[0].tie, false);
	});
});
