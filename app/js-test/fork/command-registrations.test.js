const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/command-registry');
include('app/js/fork/fight-comps');
include('app/js/fork/rally');
include('app/js/fork/preserve-mass');
include('app/js/fork/rolling');
include('app/js/fork/intel-scans');
include('app/js/fork/system-killfeed');
include('app/js/fork/structures');
include('app/js/fork/structure-timers');
include('app/js/fork/sig-inline');
include('app/js/fork/life-states');

// Each fork feature registers its palette commands from its own file; here the real registrations run against the
// real registry (the argument types are validated by register()).
describe('Command registrations of the fork features', () => {
	let confirms;
	let hadWindow, realWindow, hadTripwire, realTripwire;
	before(() => {
		hadWindow = 'window' in global; realWindow = global.window; hadTripwire = 'tripwire' in global; realTripwire = global.tripwire;
		forkCommands.commands = [];
		forkCommands.providers = {};
		rally.registerCommands();
		holeRolling.registerCommands();
		preserveMass.registerCommands();
		intelScans.registerCommands();
		structureTimers.registerCommands();
		sigInline.registerCommands();
	});
	beforeEach(() => {
		confirms = [];
		global.window = { confirm: (t) => { confirms.push(t); return global.confirmAnswer; } };
		global.confirmAnswer = false;
		global.tripwire = { client: { wormholes: {}, signatures: {} } };
	});
	after(() => {
		if (hadWindow) { global.window = realWindow; } else { delete global.window; }
		if (hadTripwire) { global.tripwire = realTripwire; } else { delete global.tripwire; }
		delete global.confirmAnswer;
	});

	const get = (id) => forkCommands.commands.filter(c => c.id === id)[0];
	const types = (id) => get(id).args.map(a => a.type);

	it('registers the fight, rolling, preserve mass, intel, structures and life/mass commands', () => {
		['rally.fightHere', 'rally.clear', 'rolling.mark', 'rolling.stop', 'preserveMass.set', 'preserveMass.clear', 'intel.dscan',
			'structures.show', 'structures.timers', 'hole.setLife', 'hole.setMass', 'panel.intelScans', 'panel.structures'].forEach(id => {
			assert.ok(get(id), id + ' is registered');
		});
	});
	it('argument types', () => {
		assert.deepEqual(types('rally.fightHere'), ['chainSystem', 'choice']);
		assert.deepEqual(types('rolling.mark'), ['hole']);
		assert.deepEqual(types('preserveMass.set'), ['hole']);
		assert.deepEqual(types('hole.setLife'), ['hole', 'choice']);
		assert.deepEqual(types('hole.setMass'), ['hole', 'choice']);
		assert.deepEqual(types('intel.dscan'), ['chainSystem']);
	});
	it('no command deletes anything: every title is a set / mark / open / show verb or an explicit stop', () => {
		forkCommands.commands.forEach(c => assert.ok(!/delete|remove|erase|wipe/i.test(c.title + c.id), c.id));
	});
	it('the comp of "Fight here" is optional, the system defaults to the viewed one', () => {
		const args = get('rally.fightHere').args;
		assert.equal(args[1].optional, true);
		assert.equal(args[0].default({ viewingSystemID: 31000005 }), 31000005);
		assert.equal(args[0].filter(31000005), true);
		assert.equal(args[0].filter(99), false);	// not a real system id
	});
	it('"Fight here" offers the comps of the mask as choices', () => {
		rally.comps = [{ id: 'c0123456789', name: 'Logi fleet', colour: '#fff', note: 'repairs' }];
		assert.deepEqual(get('rally.fightHere').args[1].choices(), [{ value: 'c0123456789', title: 'Logi fleet', hint: 'repairs' }]);
		rally.comps = [];
		assert.deepEqual(get('rally.fightHere').args[1].choices(), []);
	});
	it('"Fight here" runs rally.set with the system and comp', () => {
		const seen = [];
		const set = rally.set;
		rally.set = (s, c) => seen.push([s, c]);
		get('rally.fightHere').run({ system: 31000005, comp: 'cabc' });
		get('rally.fightHere').run({ system: 31000006 });
		rally.set = set;
		assert.deepEqual(seen, [[31000005, 'cabc'], [31000006, '']]);
	});
	it('"Clear fight" asks first and only clears on yes', () => {
		rally.state = { systemID: null };
		assert.equal(get('rally.clear').enabled({}), 'No fight point is set');
		rally.state = { systemID: 30000142 };
		assert.equal(get('rally.clear').enabled({}), true);
		let cleared = 0;
		const clear = rally.clear;
		rally.clear = () => { cleared++; };
		rally.systemName = () => 'Jita';
		get('rally.clear').run({});
		assert.equal(cleared, 0);
		assert.equal(confirms.length, 1);
		global.confirmAnswer = true;
		get('rally.clear').run({});
		assert.equal(cleared, 1);
		rally.clear = clear;
	});
	it('"Mark rolling" lists holes that are not rolling yet, "Stop rolling" the ones that are', () => {
		holeRolling.flags = { 7: { wormholeID: 7 } };
		assert.equal(get('rolling.mark').args[0].filter(7), false);
		assert.equal(get('rolling.mark').args[0].filter(8), true);
		assert.equal(get('rolling.stop').args[0].filter(7), true);
		assert.equal(get('rolling.stop').args[0].filter(8), false);
		holeRolling.flags = {};
		assert.equal(get('rolling.stop').enabled({ holes: () => [1] }), 'No hole is marked as rolling');
	});
	it('"Stop rolling" and "Stop preserving mass" ask first', () => {
		let cleared = [];
		const rc = holeRolling.clear, pc = preserveMass.clear;
		holeRolling.clear = (id) => cleared.push('roll' + id);
		preserveMass.clear = (id) => cleared.push('pm' + id);
		get('rolling.stop').run({ hole: 7 });
		get('preserveMass.clear').run({ hole: 8 });
		assert.deepEqual(cleared, []);
		assert.equal(confirms.length, 2);
		global.confirmAnswer = true;
		get('rolling.stop').run({ hole: 7 });
		get('preserveMass.clear').run({ hole: 8 });
		assert.deepEqual(cleared, ['roll7', 'pm8']);
		holeRolling.clear = rc;
		preserveMass.clear = pc;
	});
	it('"Mark rolling" and "Preserve mass" open the existing dialogs', () => {
		const opened = [];
		const ro = holeRolling.openDialog, po = preserveMass.openDialog;
		holeRolling.openDialog = (id) => opened.push('roll' + id);
		preserveMass.openDialog = (id) => opened.push('pm' + id);
		get('rolling.mark').run({ hole: 3 });
		get('preserveMass.set').run({ hole: 4 });
		holeRolling.openDialog = ro;
		preserveMass.openDialog = po;
		assert.deepEqual(opened, ['roll3', 'pm4']);
	});
	it('life and mass commands call sigInline.setWormhole with only the changed field', () => {
		const calls = [];
		const sw = sigInline.setWormhole;
		sigInline.setWormhole = (id, change) => { calls.push([id, change]); return Promise.resolve('saved'); };
		get('hole.setLife').run({ hole: 14, life: 'critical' });
		get('hole.setMass').run({ hole: 14, mass: 'destab' });
		sigInline.setWormhole = sw;
		assert.deepEqual(calls, [[14, { life: 'critical' }], [14, { mass: 'destab' }]]);
	});
	it('life choices are Stable / EOL (life states off), mass choices Stable / Destab / Critical', () => {
		const on = sigInline.statesOn;
		sigInline.statesOn = () => false;
		assert.deepEqual(get('hole.setLife').args[1].choices().map(c => c.title), ['Stable', 'EOL']);
		assert.deepEqual(get('hole.setLife').args[1].choices().map(c => c.value), ['stable', 'critical']);
		sigInline.statesOn = on;
		assert.deepEqual(get('hole.setMass').args[1].choices().map(c => c.title), ['Stable', 'Destab', 'Critical']);
	});
	it('life choices are Stable / <4h / <1h / Expired with life states, typed as eol / 4h / 1h / expired', () => {
		const on = sigInline.statesOn;
		sigInline.statesOn = () => true;
		const choices = get('hole.setLife').args[1].choices();
		sigInline.statesOn = on;
		assert.deepEqual(choices.map(c => c.title), ['Stable', '<4h', '<1h', 'Expired']);
		assert.deepEqual(choices.map(c => c.value), ['stable', 'lt4h', 'lt1h', 'expired']);
		assert.ok(choices[1].keys.includes('eol') && choices[1].keys.includes('4h'));
		assert.ok(choices[2].keys.includes('1h'));
		assert.ok(choices[3].keys.includes('expired'));
	});
	it('hole commands are disabled with a reason when the chain has no wormholes', () => {
		assert.equal(get('hole.setLife').enabled({ holes: () => [] }), 'No wormholes on the chain map');
		assert.equal(get('hole.setLife').enabled({ holes: () => [1] }), true);
	});
});

describe('Registry: arguments, hints, panel toggles', () => {
	const ok = (extra) => Object.assign({ id: 'x.one', title: 'One', run: () => {} }, extra);
	beforeEach(() => { forkCommands.commands = []; forkCommands.providers = {}; });

	it('validates arguments', () => {
		assert.throws(() => forkCommands.register(ok({ args: 'x' })), /args must be an array/);
		assert.throws(() => forkCommands.register(ok({ args: [{ type: 'hole' }] })), /needs a name/);
		assert.throws(() => forkCommands.register(ok({ args: [{ name: 'a', type: 'nope' }] })), /unknown type/);
		assert.throws(() => forkCommands.register(ok({ args: [{ name: 'a', type: 'choice' }] })), /choices must be a function/);
		assert.throws(() => forkCommands.register(ok({ args: [{ name: 'a', type: 'hole' }, { name: 'a', type: 'hole' }] })), /duplicate argument/);
		assert.throws(() => forkCommands.register(ok({ args: [{ name: 'a', type: 'hole', filter: 1 }] })), /filter must be a function/);
		assert.throws(() => forkCommands.register(ok({ hint: 'x' })), /hint must be a function/);
		assert.doesNotThrow(() => forkCommands.register(ok({ args: [{ name: 'a', type: 'hole' }, { name: 'b', type: 'choice', choices: () => [], optional: true }] })));
	});
	it('items carry args and the hint as subtitle (a failing hint falls back to the group)', () => {
		forkCommands.register(ok({ id: 'a', args: [{ name: 'a', type: 'text' }], hint: () => 'Shown now', group: 'Fleet' }));
		forkCommands.register(ok({ id: 'b', hint: () => { throw new Error('x'); }, group: 'Fleet' }));
		const items = forkCommands.items({});
		assert.equal(items[0].subtitle, 'Shown now');
		assert.equal(items[0].args.length, 1);
		assert.equal(items[1].subtitle, 'Fleet');
	});
	it('a disabled command shows its reason, not the hint', () => {
		forkCommands.register(ok({ hint: () => 'Shown now', enabled: () => 'Nope' }));
		assert.equal(forkCommands.items({})[0].subtitle, 'Nope');
	});
	it('panelToggle flips options[key].enabled, saves and applies', () => {
		const log = [];
		global.options = { structures: { enabled: true, mapMarker: true }, save: () => log.push('save'), apply: () => log.push('apply') };
		forkCommands.panelToggle({ id: 'panel.s', title: 'Toggle S', key: 'structures' });
		const c = forkCommands.commands[0];
		assert.equal(c.group, 'Panels');
		assert.equal(c.hint(), 'Shown now: this hides it');
		c.run({}, {});
		assert.deepEqual(options.structures, { enabled: false, mapMarker: true });	// other fields kept
		assert.equal(c.hint(), 'Hidden now: this shows it');
		c.run({}, {});
		assert.equal(options.structures.enabled, true);
		assert.deepEqual(log, ['save', 'apply', 'save', 'apply']);
		delete global.options;
	});
	it('a missing key means on', () => {
		global.options = { save: () => {}, apply: () => {} };
		forkCommands.panelToggle({ id: 'panel.k', title: 'Toggle K', key: 'kills' });
		const c = forkCommands.commands[0];
		assert.equal(c.hint(), 'Shown now: this hides it');
		c.run({}, {});
		assert.deepEqual(options.kills, { enabled: false });
		delete global.options;
	});
	it('panelToggle with its own isOn (e.g. an option that is off by default)', () => {
		global.options = { save: () => {}, apply: () => {} };
		forkCommands.panelToggle({ id: 'panel.o', title: 'Toggle O', key: 'o', isOn: (o) => !!(o && o.o && o.o.enabled) });
		const c = forkCommands.commands[0];
		assert.equal(c.hint(), 'Hidden now: this shows it');
		c.run({}, {});
		assert.equal(options.o.enabled, true);
		delete global.options;
	});
});

describe('Registry: panel toggles while Settings is open', () => {
	it('are disabled with "Close Settings first"', () => {
		const had = { d: 'document' in global, dv: global.document, s: '$' in global, sv: global.$, o: 'options' in global, ov: global.options };
		global.document = { querySelector: () => ({}) };
		global.$ = () => ({ is: () => true });
		global.options = {};
		forkCommands.commands = [];
		forkCommands.panelToggle({ id: 'panel.z', title: 'Toggle Z', key: 'z' });
		const c = forkCommands.commands[0];
		try {
			assert.equal(c.enabled({}), 'Close Settings first');
			global.$ = () => ({ is: () => false });
			assert.equal(c.enabled({}), true);
		} finally {
			if (had.d) { global.document = had.dv; } else { delete global.document; }
			if (had.s) { global.$ = had.sv; } else { delete global.$; }
			if (had.o) { global.options = had.ov; } else { delete global.options; }
		}
	});
});
