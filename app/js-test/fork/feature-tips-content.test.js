const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/fork/hints');
include('app/js/fork/sig-inline');
include('app/js/fork/rolling-calculator');
include('app/js/fork/jump-range');
include('app/js/fork/jump-planner');
include('app/js/fork/panel-modes');
include('app/js/fork/size-tags');
include('app/js/fork/watchlist');
include('app/js/fork/bookmark-template');

// The feature tips registered from the features' own files (forkHints.register calls), read from the source: every one
// names a catalog feature, a kind / audience / placement / trigger the engine knows, and says how to turn tips off.
function registrations() {
	const out = [];
	const walk = (dir) => fs.readdirSync(dir).forEach((name) => {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) { walk(p); return; }
		if (!/\.js$/.test(name) || /[\\/]hints(-ui)?\.js$/.test(p)) { return; }	// hints.js: the documentation example
		const src = fs.readFileSync(p, 'utf8');
		let at = src.indexOf('forkHints.register({');
		while (at >= 0) {
			let depth = 0, i = src.indexOf('{', at), end = -1;
			for (; i < src.length; i++) {
				if (src[i] === '{') { depth++; } else if (src[i] === '}' && --depth === 0) { end = i; break; }
			}
			out.push({ file: p, text: src.substring(at, end + 1) });
			at = src.indexOf('forkHints.register({', end);
		}
	});
	walk('app/js');
	return out;
}
const field = (text, name) => { const m = new RegExp('\\b' + name + ':\\s*"([^"]*)"').exec(text); return m ? m[1] : undefined; };

describe('feature tips: content', () => {
	const catalog = JSON.parse(fs.readFileSync('public/fork/feature-catalog.json', 'utf8'));
	const ids = new Set(catalog.features.map(f => f.id));
	const tips = registrations();

	it('there are the pilot tips and the content tips', () => {
		assert.ok(tips.length >= 12, tips.length + ' tips');
	});

	it('every tip names a catalog feature, a valid kind / audience / placement / trigger, and a unique id', () => {
		const seen = new Set();
		tips.forEach(({ file, text }) => {
			const id = field(text, 'id');
			const where = (id || '?') + ' in ' + file;
			assert.ok(id && /^[A-Za-z0-9_.-]{1,60}$/.test(id), where + ': id');
			assert.ok(!seen.has(id), where + ': id used twice');
			seen.add(id);
			assert.ok(ids.has(field(text, 'feature')), where + ': feature ' + field(text, 'feature') + ' is not in the catalog');
			assert.ok(forkHints.KINDS.includes(field(text, 'kind') || 'callout'), where + ': kind');
			assert.ok(forkHints.AUDIENCES.includes(field(text, 'audience') || 'all'), where + ': audience');
			assert.ok(forkHints.PLACEMENTS.includes(field(text, 'placement') || 'bottom'), where + ': placement');
			const trig = /\btrigger:\s*("([^"]+)"|\[([^\]]*)\])/.exec(text);
			assert.ok(trig, where + ': trigger');
			const triggers = trig[2] ? [trig[2]] : trig[3].split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean);
			triggers.forEach(t => assert.ok(forkHints.EVENTS.includes(t), where + ': trigger ' + t + ' is not a core event (hints.js EVENTS)'));
			assert.ok(field(text, 'title'), where + ': title');
		});
	});

	it('the pop-ups a tip waits for are the app\'s real pop-ups (made by some fork file), not Settings fields', () => {
		include('app/js/fork/hints-ui');
		const fork = fs.readdirSync('app/js/fork').filter(n => /\.js$/.test(n) && !/^hints/.test(n))
			.map(n => fs.readFileSync(path.join('app/js/fork', n), 'utf8')).join('\n');
		forkHintsUI.POPUPS.forEach(sel => {
			const m = /^([#.])([A-Za-z0-9_-]+)/.exec(sel);
			assert.ok(m, sel);
			const name = m[2];
			assert.ok(fork.indexOf(name) >= 0, sel + ': no fork file makes it');
			assert.ok(!new RegExp("<input[^>]*id=['\"]" + name + "['\"]").test(fork), sel + ' is a form field, not a pop-up');
		});
		assert.ok(forkHintsUI.POPUPS.includes('.automass-notice'), 'the auto-mass hot/cold prompt (jBox notice)');
	});

	it('every tip says how to turn tips off', () => {
		// In the registration, or in the file's tipBody() (the pilots build their text there)
		tips.forEach(({ file, text }) => assert.ok(/Turn tips off in Settings > General/.test(/tipBody/.test(text) ? fs.readFileSync(file, 'utf8') : text), field(text, 'id') + ' in ' + file));
	});

	it('the Mask Admin tips are for mask admins, in one section, inside the Mask Admin dialog, Discord first', () => {
		const admin = tips.filter(t => field(t.text, 'trigger') === 'maskAdmin.open');
		assert.deepStrictEqual(admin.map(t => field(t.text, 'feature')).sort(), ['bookmarkTemplate', 'discordNotifications', 'watchlist']);
		admin.forEach(t => {
			assert.strictEqual(field(t.text, 'audience'), 'maskAdmin');
			assert.strictEqual(field(t.text, 'section'), 'maskAdmin');
			assert.strictEqual(field(t.text, 'dialog'), '#dialog-admin');
		});
		const prio = (f) => Number(/priority:\s*(\d+)/.exec(admin.find(t => field(t.text, 'feature') === f).text)[1]);
		assert.ok(prio('discordNotifications') > prio('watchlist') && prio('watchlist') > prio('bookmarkTemplate'));
	});

	it('every tip registers through forkHints.normalize without throwing (shape check on a stand-in)', () => {
		tips.forEach(({ text }) => {
			const kind = field(text, 'kind') || 'callout';
			assert.doesNotThrow(() => forkHints.normalize({
				id: field(text, 'id'), feature: field(text, 'feature'), trigger: field(text, 'trigger') || 'idle', kind: kind,
				anchor: kind === 'toast' ? undefined : '#x', title: 'T', body: 'B', dialog: field(text, 'dialog')
			}), field(text, 'id'));
		});
	});
});

describe('feature tips: eligibility', () => {
	it('sigInline: the Edit signature dialog closing after a life / mass change, with the feature on', () => {
		assert.strictEqual(sigInline.tipEligible({ id: 'dialog-signature' }, { sigID: 5 }, {}), true);
		assert.strictEqual(sigInline.tipEligible({ id: 'dialog-signature' }, null, {}), false, 'no change in the dialog');
		assert.strictEqual(sigInline.tipEligible({ id: 'dialog-mass' }, { sigID: 5 }, {}), false, 'another dialog');
		assert.strictEqual(sigInline.tipEligible({ id: 'dialog-signature' }, { sigID: 5 }, { sigInline: { enabled: false } }), false, 'turned off');
		assert.strictEqual(sigInline.tipEligible(undefined, { sigID: 5 }, {}), false);
	});

	it('sigInline.savedAnswer: only a successful save marks the dialog change saved', () => {
		assert.strictEqual(sigInline.savedAnswer({ resultSet: [{ result: true }] }), true);
		assert.strictEqual(sigInline.savedAnswer({ resultSet: [{ result: false }] }), false);
		assert.strictEqual(sigInline.savedAnswer({}), false);
		assert.strictEqual(sigInline.savedAnswer(undefined), false);
	});

	it('rollingCalc.jumpHole: the mapped hole between the two systems, either way', () => {
		const sigs = { 1: { systemID: 30000142 }, 2: { systemID: 31000250 }, 3: { systemID: 31000250 }, 4: { systemID: 31000300 } };
		const holes = { 7: { id: 7, initialID: 1, secondaryID: 2 }, 8: { id: 8, initialID: 3, secondaryID: 4 }, 9: { id: 9, initialID: 99, secondaryID: 2 } };
		assert.strictEqual(rollingCalc.jumpHole(30000142, 31000250, holes, sigs).id, 7);
		assert.strictEqual(rollingCalc.jumpHole(31000300, 31000250, holes, sigs).id, 8);
		assert.strictEqual(rollingCalc.jumpHole(30000142, 31000300, holes, sigs), null, 'gate jump or unmapped');
		assert.strictEqual(rollingCalc.jumpHole(30000142, 30000142, holes, sigs), null);
		assert.strictEqual(rollingCalc.jumpHole(30000142, 31000250, undefined, sigs), null);
	});

	it('jumpPlanner.newExits: exits the chain just got', () => {
		assert.deepStrictEqual(jumpPlanner.newExits([], [30000001, 30000002]), [30000001, 30000002]);
		assert.deepStrictEqual(jumpPlanner.newExits([30000001], [30000001, 30000002]), [30000002]);
		assert.deepStrictEqual(jumpPlanner.newExits([30000001, 30000002], [30000001]), []);
		assert.deepStrictEqual(jumpPlanner.newExits(null, undefined), []);
	});

	it('panelModes.crowded: 5 panels or more on screen', () => {
		assert.strictEqual(panelModes.crowded(4), false);
		assert.strictEqual(panelModes.crowded(5), true);
		assert.strictEqual(panelModes.crowded(undefined), false);
	});

	it('watchlist.tipNoFilters: an editor, the active mask\'s filters loaded and empty', () => {
		const server = (o) => Object.assign({ loaded: true, canEdit: true, filters: [], mask: { id: '1.0' } }, o);
		assert.strictEqual(watchlist.tipNoFilters(server(), '1.0'), true);
		assert.strictEqual(watchlist.tipNoFilters(server({ filters: [{ id: 1 }] }), '1.0'), false, 'has filters');
		assert.strictEqual(watchlist.tipNoFilters(server({ canEdit: false }), '1.0'), false, 'can\'t edit');
		assert.strictEqual(watchlist.tipNoFilters(server({ loaded: false }), '1.0'), false, 'not loaded yet');
		assert.strictEqual(watchlist.tipNoFilters(server(), '2.0'), false, 'another mask\'s');
	});

	it('bookmarkTemplate.isDefault: no template of the mask\'s own', () => {
		assert.strictEqual(bookmarkTemplate.isDefault(undefined), true);
		assert.strictEqual(bookmarkTemplate.isDefault({}), true);
		assert.strictEqual(bookmarkTemplate.isDefault(Object.assign({}, bookmarkTemplate.DEFAULTS)), true);
		assert.strictEqual(bookmarkTemplate.isDefault({ hole: '', back: null }), true);
		assert.strictEqual(bookmarkTemplate.isDefault({ hole: '{name} {class}' }), false);
		assert.strictEqual(bookmarkTemplate.isDefault({ back: '<{name}' }), false);
	});
});
