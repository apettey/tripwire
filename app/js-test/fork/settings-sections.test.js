const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/settings-sections');

function fresh() {
	forkSettings.items = [];
	forkSettings.extraSections = [];
	forkSettings.seq = 0;
}

/** Fake controls: values by id, every item present */
function fakeIO(values) {
	return {
		values: values || {},
		present: () => true,
		read(item) { return this.values[item.id]; },
		write(item, value) { this.values[item.id] = value; }
	};
}

function checkbox(id, key, extra) {
	return Object.assign({
		section: 'markers', id: id, type: 'checkbox', label: id + ':', text: 'Show ' + id, key: key,
		get: o => !(o[key] && o[key].enabled === false),
		set: (o, v) => { o[key] = { enabled: v }; }
	}, extra || {});
}

describe('forkSettings', () => {
	beforeEach(fresh);

	describe('register', () => {
		it('rejects incomplete definitions', () => {
			assert.throws(() => forkSettings.register({ id: 'x', type: 'checkbox' }), /section and id/);
			assert.throws(() => forkSettings.register({ section: 'markers', id: 'x', type: 'radio' }), /type must be/);
			assert.throws(() => forkSettings.register({ section: 'markers', id: 'x', type: 'checkbox' }), /get\(options\)/);
			assert.throws(() => forkSettings.register({ section: 'markers', id: 'x', type: 'select', get: () => 1, set: () => {} }), /choices/);
			assert.throws(() => forkSettings.register({ section: 'markers', id: 'x', type: 'custom' }), /html/);
			assert.throws(() => forkSettings.register(checkbox('x', 'x', { reset: 'no' })), /reset must be/);
		});
		it('keeps registrations without a page (registration never needs the DOM)', () => {
			forkSettings.register(checkbox('a', 'a'));
			assert.strictEqual(forkSettings.items.length, 1);
			assert.strictEqual(forkSettings.items[0].rendered, false);
		});
		it('sorts by order, then registration', () => {
			const late = forkSettings.register(checkbox('late', 'late', { order: 30 }));
			const first = forkSettings.register(checkbox('first', 'first', { order: 10 }));
			const plain = forkSettings.register(checkbox('plain', 'plain'));
			const tie = forkSettings.register(checkbox('tie', 'tie', { order: 10 }));
			assert.deepStrictEqual(forkSettings.sorted(forkSettings.items).map(i => i.id), ['first', 'tie', 'late', 'plain']);
			assert.ok(late && first && plain && tie);
		});
	});

	describe('save, open and reset', () => {
		it('Save writes each control into options; open fills it back (missing key = on)', () => {
			forkSettings.register(checkbox('sizeTags-enabled', 'sizeTags'));
			forkSettings.register({
				section: 'jumps', id: 'mode', type: 'select', label: 'Mode:', choices: [['first', 'First'], ['off', 'Off']], key: 'mode',
				get: o => (o.mode && o.mode.value) || 'first', set: (o, v) => { o.mode = { value: v }; }
			});
			const io = fakeIO();
			const options = {};
			forkSettings.fillAll(options, io);
			assert.deepStrictEqual(io.values, { 'sizeTags-enabled': true, mode: 'first' });
			io.values = { 'sizeTags-enabled': false, mode: 'off' };
			forkSettings.saveAll(options, io);
			assert.deepStrictEqual(options, { sizeTags: { enabled: false }, mode: { value: 'off' } });
		});
		it('custom settings load and save themselves', () => {
			const calls = [];
			forkSettings.register({
				section: 'intel', id: 'custom', type: 'custom', label: 'Custom:', html: '<input id="c" />', key: 'custom',
				load: o => calls.push(['load', o.x]), save: o => { o.custom = { saved: true }; calls.push(['save']); }
			});
			const options = { x: 1 };
			forkSettings.fillAll(options, fakeIO());
			forkSettings.saveAll(options, fakeIO());
			assert.deepStrictEqual(calls, [['load', 1], ['save']]);
			assert.deepStrictEqual(options.custom, { saved: true });
		});
		it('skips rows that are not on the page', () => {
			forkSettings.register(checkbox('a', 'a'));
			const options = {};
			forkSettings.saveAll(options, Object.assign(fakeIO({ a: false }), { present: () => false }));
			assert.deepStrictEqual(options, {});
		});
		it('one failing feature does not stop the others', () => {
			const error = console.error;
			console.error = () => {};
			try {
				forkSettings.register(checkbox('bad', 'bad', { set: () => { throw new Error('boom'); } }));
				forkSettings.register(checkbox('good', 'good'));
				const options = {};
				forkSettings.saveAll(options, fakeIO({ bad: true, good: false }));
				assert.deepStrictEqual(options, { good: { enabled: false } });
			} finally {
				console.error = error;
			}
		});
		it('Reset deletes each key, or runs the feature\'s own reset', () => {
			let ownReset = 0;
			forkSettings.register(checkbox('a', 'a'));
			forkSettings.register(checkbox('b', 'b', { reset: o => { delete o.b; ownReset++; } }));
			forkSettings.register({ section: 'general', id: 'button', type: 'custom', label: 'Button:', html: '<input type="button" />' });
			const options = { a: { enabled: false }, b: { enabled: false }, keep: 1 };
			forkSettings.resetAll(options);
			assert.deepStrictEqual(options, { keep: 1 });
			assert.strictEqual(ownReset, 1);
		});
	});

	describe('register guards', () => {
		function capture(fn) {
			const warn = console.warn, seen = [];
			console.warn = m => seen.push(String(m));
			try { fn(); } finally { console.warn = warn; }
			return seen;
		}
		it('the same id twice is ignored (first one kept)', () => {
			let second;
			const first = forkSettings.register(checkbox('a', 'a'));
			const seen = capture(() => { second = forkSettings.register(checkbox('a', 'other', { order: 1 })); });
			assert.strictEqual(second, first);
			assert.strictEqual(forkSettings.items.length, 1);
			assert.ok(/already registered/.test(seen[0]));
		});
		it('warns when a stored setting would survive Reset (no key, no reset)', () => {
			const seen = capture(() => {
				forkSettings.register(checkbox('noKey', undefined));
				forkSettings.register({ section: 'x', id: 'save', type: 'custom', html: '<i></i>', save: () => {} });
				forkSettings.register({ section: 'x', id: 'button', type: 'custom', html: '<input type="button" />' });
				forkSettings.register(checkbox('own', undefined, { reset: () => {} }));
			});
			assert.deepStrictEqual(seen.map(m => /no key or reset/.test(m) && m.match(/\((\w+)\)/)[1]), ['noKey', 'save']);
		});
	});

	describe('Settings > Reset with What\'s New\'s wrapper', () => {
		// options.js's reset (throws on keys without a default) and whats-new.js's wrapper (keeps those keys)
		function makeOptions() {
			const opts = {
				chain: { renderer: 'orgChart' }, whatsNew: { lastSeenPR: 50 },
				sizeTags: { enabled: false }, jumpRange: { ship: 'x' },
				reset: function() {
					for (const x in this) {
						if (typeof this[x] !== 'function') { this[x] = JSON.parse(JSON.stringify(this.reset.defaults[x])); }
					}
				}
			};
			opts.reset.defaults = { chain: { renderer: 'radial' } };
			return opts;
		}
		function whatsNewWrap(opts) {
			const reset = opts.reset;
			opts.reset = function() {
				const kept = {};
				for (const key of Object.keys(this)) {
					if (typeof this[key] !== 'function' && !(key in reset.defaults)) { kept[key] = this[key]; delete this[key]; }
				}
				const result = reset.apply(this, arguments);
				Object.assign(this, kept);
				return result;
			};
			opts.reset.defaults = reset.defaults;
		}
		beforeEach(() => {
			forkSettings.register(checkbox('sizeTags-enabled', 'sizeTags'));
			forkSettings.register({ section: 'jumpPlanner', id: 'jp', type: 'custom', rows: '<tr></tr>', save: () => {}, reset: o => { delete o.jumpRange; } });
		});
		const expected = { chain: { renderer: 'radial' }, whatsNew: { lastSeenPR: 50 } };
		it('What\'s New wrapped first (the bundle order): fork keys go, What\'s New\'s state stays', () => {
			const opts = makeOptions();
			whatsNewWrap(opts);
			forkSettings.wrapReset(opts);
			opts.reset();
			assert.deepStrictEqual(JSON.parse(JSON.stringify(opts)), expected);
		});
		it('What\'s New wrapped after us: the wrap on the Reset click puts ours outside again', () => {
			const opts = makeOptions();
			forkSettings.wrapReset(opts);
			whatsNewWrap(opts);
			forkSettings.wrapReset(opts);	// what the Reset click does
			opts.reset();
			assert.deepStrictEqual(JSON.parse(JSON.stringify(opts)), expected);
		});
		it('without that, a later wrapper would put the fork keys back (why the click re-wraps)', () => {
			const opts = makeOptions();
			forkSettings.wrapReset(opts);
			whatsNewWrap(opts);
			opts.reset();
			assert.deepStrictEqual(opts.sizeTags, { enabled: false });
		});
		it('wrapping twice in a row is a no-op and keeps reset.defaults', () => {
			const opts = makeOptions();
			forkSettings.wrapReset(opts);
			const once = opts.reset;
			forkSettings.wrapReset(opts);
			assert.strictEqual(opts.reset, once);
			assert.deepStrictEqual(opts.reset.defaults, { chain: { renderer: 'radial' } });
		});
	});

	describe('placement', () => {
		it('a row goes before the first higher order (footnotes sort last), else at the end', () => {
			assert.strictEqual(forkSettings.insertIndex([10, 20, forkSettings.FOOTNOTE_ORDER], 15), 1);
			assert.strictEqual(forkSettings.insertIndex([10, 20, forkSettings.FOOTNOTE_ORDER], 1000), 2);
			assert.strictEqual(forkSettings.insertIndex([10, 20], 20), -1);
			assert.strictEqual(forkSettings.insertIndex([], 5), -1);
		});
		it('a new section goes after the nearest earlier section on the page', () => {
			forkSettings.section('jumpPlanner', 'Jump Planner', { after: 'routes' });
			const keys = forkSettings.order();
			const onPage = k => ['account', 'chain', 'general', 'stats'].indexOf(k) >= 0;
			assert.strictEqual(forkSettings.previousSection(keys, 'jumpPlanner', onPage), 'chain');
			assert.strictEqual(forkSettings.previousSection(keys, 'jumpPlanner', k => k === 'routes' || onPage(k)), 'routes');
			assert.strictEqual(forkSettings.previousSection(keys, 'account', onPage), null);
		});
	});

	describe('filter plan', () => {
		const sections = [
			{ title: 'Account Settings', rows: ['Username: dev', 'Characters:'], extra: 'Change Username Change Password' },
			{ title: 'Map Markers', rows: ['Hole size tags: Show max ship size', 'Preserve mass: Show preserve-mass markers'], extra: '' },
			{ title: 'Wormhole Jumps & Mass', rows: ['Jump mass:', 'Return bookmark pop-up:'], extra: '' }
		];
		it('shows matching rows and their sections', () => {
			const p = forkSettings.filterPlan(sections, 'mass');
			assert.deepStrictEqual(p.sections.map(s => s.show), [false, true, true]);
			assert.deepStrictEqual(p.sections[1].rows, [false, true]);
			assert.deepStrictEqual(p.sections[2].rows, [true, true]);	// title match: the whole section
			assert.ok(p.found);
		});
		it('text outside the rows (buttons) shows the section', () => {
			const p = forkSettings.filterPlan(sections, 'password');
			assert.deepStrictEqual(p.sections.map(s => s.show), [true, false, false]);
			assert.deepStrictEqual(p.sections[0].rows, [false, false]);
		});
		it('nothing found', () => {
			const p = forkSettings.filterPlan(sections, 'zzz');
			assert.ok(!p.found && p.sections.every(s => !s.show));
		});
	});

	describe('sections', () => {
		it('built-in order', () => {
			assert.deepStrictEqual(forkSettings.order(),
				['account', 'chain', 'markers', 'jumps', 'signatures', 'routes', 'intel', 'general', 'stats']);
		});
		it('a feature section goes after its `after` section, later ones after earlier ones there', () => {
			forkSettings.section('jumpPlanner', 'Jump Planner', { after: 'routes' });
			forkSettings.section('killReporting', 'Kill Reporting', { after: 'intel' });
			forkSettings.section('second', 'Second', { after: 'routes' });
			forkSettings.section('loose', 'Loose');
			assert.deepStrictEqual(forkSettings.order(),
				['account', 'chain', 'markers', 'jumps', 'signatures', 'routes', 'jumpPlanner', 'second', 'intel', 'killReporting', 'loose', 'general', 'stats']);
		});
		it('is declared once', () => {
			forkSettings.section('x', 'X', { after: 'chain' });
			forkSettings.section('x', 'Other', { after: 'intel' });
			assert.strictEqual(forkSettings.extraSections.length, 1);
			assert.strictEqual(forkSettings.sectionDef('x').title, 'X');
		});
		it('needs a key and a title', () => {
			assert.throws(() => forkSettings.section('x'), /required/);
		});
	});

	describe('row markup', () => {
		it('escapes plain-text labels and choices', () => {
			const html = forkSettings.rowHtml(forkSettings.normalize({
				section: 'markers', id: 'x', type: 'select', label: '<b>L</b>', hint: 'a & b', choices: [['v"', '<i>']],
				get: () => 1, set: () => {}, key: 'x', order: 5, keywords: 'k<'
			}));
			assert.ok(!/<b>|<i>/.test(html), html);
			assert.ok(/&lt;b&gt;L/.test(html) && /a &amp; b/.test(html) && /v&quot;/.test(html) && /data-fs-keywords='k&lt;'/.test(html));
			assert.ok(/^<tbody class='fs-item' data-fs-id='x' data-fs-order='5'/.test(html));
		});
		it('checkbox row', () => {
			const html = forkSettings.rowHtml(forkSettings.normalize(checkbox('sizeTags-enabled', 'sizeTags')));
			assert.ok(/<th>sizeTags-enabled:<\/th>/.test(html) && /<input type='checkbox' id='sizeTags-enabled' \/> Show sizeTags-enabled/.test(html));
		});
		it('custom rows are used as given', () => {
			const html = forkSettings.rowHtml(forkSettings.normalize({ section: 'x', id: 'r', type: 'custom', rows: '<tr><td>1</td></tr><tr><td>2</td></tr>' }));
			assert.ok(html.indexOf('<tr><td>1</td></tr><tr><td>2</td></tr>') > 0);
		});
	});

	describe('filter matching', () => {
		it('every word, any case, in any order', () => {
			assert.ok(forkSettings.matches('Hole size tags: Show max ship size on connections', 'SIZE hole'));
			assert.ok(!forkSettings.matches('Hole size tags', 'size mass'));
			assert.ok(forkSettings.matches('anything', '  '));
		});
	});
});
