const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/command-palette-index');
include('app/js/fork/command-args');
include('app/js/fork/command-registry');
include('app/js/fork/command-palette');

// Same chain as command-args.test.js: R(J111111) -[A]-> J222222 -[AA]-> J333333, J222222 -[AB]-> J444444, R -[B2]-> Rens
const systems = {
	1: { name: 'J111111', class: 3, regionID: 9 }, 2: { name: 'J222222', class: 4, regionID: 9 }, 3: { name: 'J333333', class: 2, regionID: 9 },
	4: { name: 'J444444', class: 1, regionID: 9 }, 5: { name: 'Rens', security: 0.9, regionID: 10 }, 6: { name: 'Hed', security: 0.2, regionID: 10 }
};
const node = (v, systemID, whId) => ({ v: v, systemID: systemID, f: whId ? "<div data-nodeid='" + systemID + "' data-sigid='" + whId + "'></div>" : "<div></div>" });
const rows = [
	{ c: [node(100, 1), { v: null }] },
	{ c: [node(101, 2, 11), { v: 100 }], pathHome: [{ systemID: 2, name: 'A', type: 'H296', signatureID: 'abc123' }] },
	{ c: [node(102, 3, 12), { v: 101 }], pathHome: [{ name: 'A' }, { systemID: 3, name: 'AA', type: 'K162', signatureID: 'def456' }] },
	{ c: [node(103, 4, 13), { v: 101 }], pathHome: [{ name: 'A' }, { systemID: 4, name: 'AB', signatureID: 'ghi789' }] },
	{ c: [node(104, 5, 14), { v: 100 }], pathHome: [{ systemID: 5, name: 'B2', signatureID: 'jkl012' }] }
];
const wormholes = { 11: { id: 11, initialID: 21, secondaryID: 22, type: 'H296' }, 12: { id: 12, initialID: 23, secondaryID: 24 }, 13: { id: 13, initialID: 25, secondaryID: 26 }, 14: { id: 14, initialID: 27, secondaryID: 28 } };
const signatures = { 21: { id: 21, signatureID: 'abc123', systemID: 1, type: 'wormhole' }, 22: { id: 22, signatureID: 'xyz789', systemID: 2, type: 'wormhole' }, 30: { id: 30, signatureID: 'qqq111', systemID: 2, type: 'combat' } };

describe('Command palette: actions on a result, history, screen-reader text, timing', () => {
	const saved = {};
	const names = ['chain', 'tripwire', 'appData'];
	let ran;
	before(() => {
		names.forEach(n => { saved[n] = { had: n in global, value: global[n] }; });
		global.chain = { data: { map: { rows: rows } } };
		global.tripwire = { client: { wormholes: wormholes, signatures: signatures }, systemChange: (id) => ran.push('goto' + id) };
		global.appData = { systems: systems, regions: { 9: { name: 'Wormhole Space' }, 10: { name: 'Heimatar' } } };
	});
	after(() => { names.forEach(n => { if (saved[n].had) { global[n] = saved[n].value; } else { delete global[n]; } }); });

	const setup = (extra) => {
		ran = [];
		forkCommands.commands = [];
		forkCommands.providers = {};
		const def = (id, title, args, more) => forkCommands.register(Object.assign({ id: id, title: title, group: 'Holes', args: args, run: () => ran.push(id) }, more || {}));
		def('rally.fightHere', 'Fight here', [{ name: 'system', type: 'chainSystem', default: (ctx) => ctx.viewingSystemID }, { name: 'comp', type: 'choice', optional: true, choices: () => [] }]);
		def('rolling.mark', 'Mark rolling', [{ name: 'hole', type: 'hole' }]);
		def('hole.setLife', 'Set life', [{ name: 'hole', type: 'hole' }, { name: 'life', type: 'choice', choices: () => [{ value: 'stable', title: 'Stable' }, { value: 'critical', title: 'EOL' }] }]);
		def('favourites.add', 'Add favourite', [{ name: 'system', type: 'system' }]);
		def('intel.dscan', 'Paste d-scan', [{ name: 'system', type: 'chainSystem' }]);
		def('rolling.stop', 'Stop rolling', [{ name: 'hole', type: 'hole' }], { enabled: () => 'No hole is marked as rolling' });
		def('nav.copy', 'Copy system name', undefined);
		if (extra) { extra(def); }
		const ctx = { viewingSystemID: 2, selectedSigIDs: () => [], chainSystems: () => ['1', '2', '3', '4', '5'] };
		const st = commandPalette.state;
		st.ctx = ctx;
		st.argCache = {};
		const items = forkCommands.items(ctx).concat(commandPalette.chainItems({ rows: rows, systems: systems, regions: {}, viewingID: 2 }),
			commandPalette.sigItems(signatures, wormholes, 2)).map(paletteIndex.item);
		st.items = items;
		st.argCommands = items.filter(it => it.command && it.command.args && it.command.args.length);
		return items;
	};
	const noun = (items, kind, title) => items.filter(it => it.kind === kind && it.title === title)[0];

	describe('noun, then verb', () => {
		it('a chain system: Go to, then every command whose first argument is a chain system or the hole into it', () => {
			const items = setup();
			const actions = commandPalette.actionsFor(noun(items, 'chain', 'J333333'));
			assert.deepEqual(actions.map(a => a.title), ['Go to J333333', 'Fight here', 'Mark rolling', 'Set life', 'Add favourite', 'Paste d-scan', 'Stop rolling']);
		});
		it('the hole is the one leading into the system (AA for J333333)', () => {
			const items = setup();
			const actions = commandPalette.actionsFor(noun(items, 'chain', 'J333333'));
			const mark = actions.filter(a => a.title === 'Mark rolling')[0];
			assert.equal(mark.inline.filled[0].value, 12);
			assert.equal(mark.inline.complete, true);
			assert.deepEqual(paletteArgs.values(mark.command.args, mark.inline.filled), { hole: 12 });
		});
		it('a command that needs more continues with the steps: Set life asks for the value, Fight here is complete', () => {
			const items = setup();
			const actions = commandPalette.actionsFor(noun(items, 'chain', 'J333333'));
			const life = actions.filter(a => a.title === 'Set life')[0];
			assert.equal(life.inline.complete, false);
			assert.equal(life.inline.next, 1);
			assert.match(life.subtitle, /Asks for the life/);
			const fight = actions.filter(a => a.title === 'Fight here')[0];
			assert.equal(fight.inline.complete, true);
			assert.deepEqual(paletteArgs.values(fight.command.args, fight.inline.filled), { system: 3 });
		});
		it('the root has no hole into it, so no hole actions', () => {
			const items = setup();
			const titles = commandPalette.actionsFor(noun(items, 'chain', 'J111111')).map(a => a.title);
			assert.ok(titles.indexOf('Mark rolling') < 0);
			assert.ok(titles.indexOf('Fight here') >= 0);
		});
		it('a system that is not on the chain: only commands that take any system', () => {
			const items = setup();
			const eve = commandPalette.eveItem(6, systems[6], {});
			const titles = commandPalette.actionsFor(eve).map(a => a.title);
			assert.deepEqual(titles, ['Go to Hed', 'Add favourite']);
		});
		it('a signature of a wormhole: Select, Edit, then the hole commands for its wormhole', () => {
			const items = setup();
			const sig = noun(items, 'sig', 'XYZ-789');
			const titles = commandPalette.actionsFor(sig).map(a => a.title);
			assert.deepEqual(titles, ['Select XYZ-789', 'Edit XYZ-789', 'Mark rolling', 'Set life', 'Stop rolling']);
			const mark = commandPalette.actionsFor(sig).filter(a => a.title === 'Mark rolling')[0];
			assert.equal(mark.inline.filled[0].value, 11);
		});
		it('a signature that is not a wormhole has no hole actions', () => {
			const items = setup();
			const titles = commandPalette.actionsFor(noun(items, 'sig', 'QQQ-111')).map(a => a.title);
			assert.deepEqual(titles, ['Select QQQ-111', 'Edit QQQ-111']);
		});
		it('a disabled command is listed greyed with its reason', () => {
			const items = setup();
			const stop = commandPalette.actionsFor(noun(items, 'chain', 'J333333')).filter(a => a.title === 'Stop rolling')[0];
			assert.equal(stop.disabled, 'No hole is marked as rolling');
			assert.equal(stop.subtitle, 'No hole is marked as rolling');
		});
		it('built-in actions run their own code; command actions carry the descriptor runInline needs', () => {
			const items = setup();
			const actions = commandPalette.actionsFor(noun(items, 'chain', 'J333333'));
			actions[0].run();
			assert.deepEqual(ran, ['goto3']);
			assert.ok(actions[2].inline && actions[2].command && actions[2].kind === 'act');
		});
		it('only systems and signatures have actions', () => {
			assert.deepEqual(Object.keys(commandPalette.NOUN_KINDS).sort(), ['chain', 'eve', 'sig']);
		});
		it('actions are filtered by what is typed', () => {
			const items = setup();
			const st = commandPalette.state;
			st.noun = { item: noun(items, 'chain', 'J333333'), query: '', prepared: commandPalette.actionsFor(noun(items, 'chain', 'J333333')).map(paletteIndex.item) };
			assert.equal(commandPalette.actionRows('')[0].header, 'Actions for J333333');
			assert.equal(commandPalette.actionRows('').length, 8);
			const rowsFor = commandPalette.actionRows('roll');
			assert.ok(rowsFor.slice(1).some(r => r.item.title === 'Mark rolling'));
			assert.ok(!rowsFor.slice(1).some(r => r.item.title === 'Fight here'));
			st.noun = null;
		});
	});

	describe('clear palette history', () => {
		let store;
		const realLS = global.localStorage;
		beforeEach(() => {
			store = { 'tw-palette-frecency': JSON.stringify({ 'cmd:a': { n: 2, t: Date.now() }, 'sys:2': { n: 1, t: Date.now() } }) };
			global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
		});
		after(() => { if (realLS) { global.localStorage = realLS; } else { delete global.localStorage; } });
		it('is a registered command with a count as its hint, disabled when there is nothing to forget', () => {
			forkCommands.commands = [];
			commandPalette.registerCommands();
			const c = forkCommands.commands.filter(x => x.id === 'palette.clearHistory')[0];
			assert.ok(c);
			assert.equal(c.group, 'App');
			assert.equal(c.enabled(), true);
			assert.equal(c.hint(), '2 recent items remembered in this browser');
			delete store['tw-palette-frecency'];
			assert.equal(c.enabled(), 'No palette history yet');
		});
		it('empties the stored history and the open palette\'s copy', () => {
			commandPalette.state.frecency = { 'cmd:a': { n: 2, t: 1 } };
			commandPalette.clearHistory();
			assert.deepEqual(commandPalette.state.frecency, {});
			assert.equal('tw-palette-frecency' in store, false);
			assert.deepEqual(commandPalette.loadFrecency(), {});
		});
		it('survives storage that throws', () => {
			global.localStorage = { getItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
			assert.doesNotThrow(() => commandPalette.clearHistory());
		});
	});

	describe('screen-reader text', () => {
		it('option label: title, kind, detail, shortcut', () => {
			assert.equal(commandPalette.optionLabel({ title: 'Undo', kind: 'cmd', subtitle: 'Signatures', shortcut: 'Ctrl+Z' }), 'Undo, Command, Signatures, shortcut Ctrl+Z');
			assert.equal(commandPalette.optionLabel({ title: 'J111111', kind: 'chain', subtitle: 'C3 · viewing' }), 'J111111, Chain, C3 · viewing');
			assert.equal(commandPalette.optionLabel({ title: 'Stable', kind: 'arg', tag: 'Option' }), 'Stable, Option');
		});
		it('a disabled option says why it is unavailable', () => {
			assert.equal(commandPalette.optionLabel({ title: 'Redo', kind: 'cmd', disabled: 'Nothing to redo', subtitle: 'Nothing to redo' }), 'Redo, Command, unavailable: Nothing to redo');
			assert.equal(commandPalette.optionLabel({ title: 'X', kind: 'cmd', disabled: 'r' }), 'X, Command, unavailable');
		});
		it('input name follows the mode', () => {
			assert.equal(commandPalette.inputLabel({ scope: { label: '' } }), 'Search systems, signatures, settings and commands');
			assert.equal(commandPalette.inputLabel({ scope: { label: 'Signatures' } }), 'Search signatures');
			assert.equal(commandPalette.inputLabel({ cmd: { command: { title: 'Fight here' }, args: [{ name: 'system', label: 'system' }], step: 0 } }), 'Fight here: choose the system');
			assert.equal(commandPalette.inputLabel({ noun: { item: { title: 'J222222' } } }), 'Actions for J222222');
		});
		it('live region text includes the mode and singular / plural', () => {
			assert.equal(commandPalette.liveText({}, 1), '1 result');
			assert.equal(commandPalette.liveText({}, 12), '12 results');
			assert.equal(commandPalette.liveText({}, 0), 'No results');
			assert.equal(commandPalette.liveText({ noun: { item: { title: 'J222222' } } }, 3), 'Actions for J222222. 3 actions');
			assert.equal(commandPalette.liveText({ cmd: { command: { title: 'Set mass' }, args: [{ name: 'hole' }], step: 0 } }, 4), 'Set mass: choose the hole. 4 results');
		});
	});

	describe('timing', () => {
		it('perfReport summarises the samples', () => {
			commandPalette.state.perf = { last: 0, samples: [1, 2, 3, 4, 100], open: 7 };
			const r = commandPalette.perfReport();
			assert.deepEqual(r, { n: 5, median: 3, p95: 100, max: 100, open: 7 });
			commandPalette.state.perf = { last: 0, samples: [], open: 0 };
			assert.deepEqual(commandPalette.perfReport(), { n: 0, median: 0, p95: 0, max: 0, open: 0 });
		});

		// 200 chain systems, ~190 holes, 300 commands (60 with arguments): one-line parsing and action lists per keystroke
		it('one-line commands and action lists at spec scale stay under the 16 ms budget (asserted at 40 ms in CI)', () => {
			const bigSystems = {}, bigRows = [{ c: [node(1000, 100), { v: null }] }];
			for (let i = 0; i < 200; i++) {
				const id = 200 + i;
				bigSystems[id] = { name: 'J' + (100000 + i * 37), class: 1 + (i % 6), regionID: 9 };
				if (i) { bigRows.push({ c: [node(1000 + i, id, 5000 + i), { v: 1000 + Math.floor(i / 2) }], pathHome: [{ systemID: id, name: String.fromCharCode(65 + (i % 26)) + (i % 9 + 1), type: 'H296', signatureID: 'abc' + i }] }); }
			}
			bigSystems[100] = { name: 'J100000', class: 3 };
			bigRows[0].c[0].systemID = 200;
			const bigWh = {};
			for (let i = 1; i < 200; i++) { bigWh[5000 + i] = { id: 5000 + i, type: 'H296' }; }
			const hadChain = global.chain, hadAppData = global.appData, hadTripwire = global.tripwire;
			global.chain = { data: { map: { rows: bigRows } } };
			global.appData = { systems: bigSystems, regions: {} };
			global.tripwire = { client: { wormholes: bigWh, signatures: {} } };
			try {
				forkCommands.commands = [];
				forkCommands.providers = {};
				for (let i = 0; i < 240; i++) { forkCommands.register({ id: 'f.' + i, title: 'Filler command ' + i, group: 'App', run: () => {} }); }
				for (let i = 0; i < 40; i++) { forkCommands.register({ id: 'h.' + i, title: 'Hole command ' + i, group: 'Holes', args: [{ name: 'hole', type: 'hole' }], run: () => {} }); }
				for (let i = 0; i < 20; i++) { forkCommands.register({ id: 's.' + i, title: 'System command ' + i, group: 'Fleet', args: [{ name: 'system', type: 'chainSystem' }, { name: 'c', type: 'choice', optional: true, choices: () => [{ value: 'a', title: 'Alpha' }] }], run: () => {} }); }
				const ctx = { viewingSystemID: 210, selectedSigIDs: () => [], chainSystems: () => [] };
				const st = commandPalette.state;
				st.ctx = ctx;
				st.argCache = {};
				const items = forkCommands.items(ctx).concat(commandPalette.chainItems({ rows: bigRows, systems: bigSystems, regions: {}, viewingID: 210 })).map(paletteIndex.item);
				st.items = items;
				st.argCommands = items.filter(it => it.command && it.command.args && it.command.args.length);
				assert.equal(items.filter(it => it.kind === 'cmd').length, 300);
				const queries = ['hole command a', 'hole command 5 b2', 'system command j100037', 'system command 3 j1', 'hole command 1 a1', 'sys command 12 j100074 alpha', 'filler a', 'hole c', 'system command 7 a'];
				queries.forEach(q => commandPalette.inlineItems(q));	// first run builds the candidate caches (done on open, not per key)
				const times = [];
				for (let r = 0; r < 4; r++) {
					queries.forEach(q => {
						const t0 = process.hrtime.bigint();
						commandPalette.inlineItems(q);
						times.push(Number(process.hrtime.bigint() - t0) / 1e6);
					});
				}
				times.sort((a, b) => a - b);
				const median = times[Math.floor(times.length / 2)];
				const actTimes = [];
				items.filter(it => it.kind === 'chain').slice(0, 20).forEach(n => {
					const t0 = process.hrtime.bigint();
					commandPalette.actionsFor(n);
					actTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
				});
				actTimes.sort((a, b) => a - b);
				console.log('        one-line median ' + median.toFixed(2) + ' ms, worst ' + times[times.length - 1].toFixed(2) + ' ms; action list median ' + actTimes[10].toFixed(2) + ' ms, worst ' + actTimes[19].toFixed(2) + ' ms');
				assert.ok(median < 40, 'median ' + median);
				assert.ok(actTimes[10] < 40, 'actions ' + actTimes[10]);
			} finally {
				global.chain = hadChain; global.appData = hadAppData; global.tripwire = hadTripwire;
			}
		});
	});
});

describe('Command palette: scope prefix with nothing typed', () => {
	const scope = paletteIndex.parseScope('#');
	const items = [
		paletteIndex.item({ key: 'sig:1', kind: 'sig', title: 'ZZZ-111', ctx: 120 }),
		paletteIndex.item({ key: 'sig:2', kind: 'sig', title: 'AAA-111', ctx: 120 }),
		paletteIndex.item({ key: 'cmd:x', kind: 'cmd', title: 'Undo' }),
		paletteIndex.item({ key: 'sys:1', kind: 'chain', title: 'J111111', ctx: 60 })
	];
	it('lists everything of the scope under its name, alphabetical', () => {
		const rows = commandPalette.scopeRows(items, scope);
		assert.equal(rows[0].header, 'Signatures');
		assert.deepEqual(rows.slice(1).map(r => r.item.title), ['AAA-111', 'ZZZ-111']);
	});
	it('the viewed system and its neighbours come first', () => {
		const rows = commandPalette.scopeRows(items, paletteIndex.parseScope('@'));
		assert.deepEqual(rows.slice(1).map(r => r.item.title), ['J111111']);
	});
	it('nothing in the scope: no rows', () => {
		assert.deepEqual(commandPalette.scopeRows([], scope), []);
	});
});
