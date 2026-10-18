const assert = require('assert');
const fs = require('fs');
const path = require('path');

// public/fork/feature-catalog.json is the one list of the fork's features (usage statistics, later tips and the features
// hub). These checks keep it in step with What's New, the Settings rows and the command palette. Static source scanning,
// like mask-defaults-allow.test.js: the fork files register at DOM ready, which doesn't run under mocha.
describe('feature catalog', () => {
	const root = path.join(__dirname, '..', '..', '..');
	const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public/fork/feature-catalog.json'), 'utf8'));
	const features = catalog.features;
	const whatsNew = JSON.parse(fs.readFileSync(path.join(root, 'public/whats-new/features.json'), 'utf8')).features;
	const sources = fs.readdirSync(path.join(root, 'app/js/fork')).filter(f => f.endsWith('.js'))
		.map(f => 'app/js/fork/' + f).concat(['app/js/whats-new.js'])
		.map(f => ({ file: f, text: fs.readFileSync(path.join(root, f), 'utf8') }));

	// Keys Settings rows store: `key: "x"`, or what their reset(options) deletes (custom rows such as the jump planner's)
	const settingsKeys = new Set();
	sources.forEach(s => s.text.split('forkSettings.register(').slice(1).forEach(chunk => {
		const head = chunk.slice(0, 1500);
		const m = head.match(/\bkey:\s*"([A-Za-z0-9_]+)"/);
		if (m) { settingsKeys.add(m[1]); }
		[...head.matchAll(/delete\s+o\.([A-Za-z0-9_]+)/g)].forEach(d => settingsKeys.add(d[1]));
	}));

	// Ids of forkCommands.register / panelToggle calls (and the palette's own add(), a wrapper of register): the first
	// `id: "..."` after the call
	const commandIds = new Set();
	sources.forEach(s => s.text.split(s.file.endsWith('command-palette.js') ? /forkCommands\.(?:register|panelToggle)\(|[^.\w]add\(\{/ : /forkCommands\.(?:register|panelToggle)\(/).slice(1).forEach(chunk => {
		const m = chunk.slice(0, 600).match(/\bid:\s*"([A-Za-z0-9_.]+)"/);
		if (m) { commandIds.add(m[1]); }
	}));

	const sectionKeys = new Set(['maskAdmin']);	// Mask Admin features: not a Settings section
	sources.forEach(s => {
		[...s.text.matchAll(/\{\s*key:\s*"([A-Za-z]+)"/g)].filter(() => s.file.endsWith('settings-sections.js')).forEach(m => sectionKeys.add(m[1]));
		[...s.text.matchAll(/forkSettings\.section\(\s*"([A-Za-z]+)"/g)].forEach(m => sectionKeys.add(m[1]));
	});

	const panelIds = new Set();
	sources.forEach(s => {
		[...s.text.matchAll(/WIDGET_ID:\s*"([A-Za-z]+)"/g)].forEach(m => panelIds.add(m[1]));
	});

	it('scans found the registries (guards the scanning itself)', () => {
		assert.ok(settingsKeys.has('sizeTags') && settingsKeys.has('jumpRange'), [...settingsKeys].join(','));
		assert.ok(commandIds.has('rally.fightHere') && commandIds.has('panel.chainKills') && commandIds.has('app.whatsNew'));
		assert.ok(sectionKeys.has('markers') && sectionKeys.has('jumpPlanner') && sectionKeys.has('killReporting'));
		assert.ok(panelIds.has('chainKillFeedWidget'));
	});

	it('has unique lowerCamel ids and every field', () => {
		const ids = features.map(f => f.id).concat(catalog.internal);
		assert.strictEqual(new Set(ids).size, ids.length, 'duplicate id');
		const STAGES = ['first', 'core', 'intermediate', 'admin'];
		features.forEach(f => {
			assert.ok(/^[a-z][A-Za-z0-9]{1,39}$/.test(f.id), f.id);
			assert.ok(typeof f.title === 'string' && f.title, f.id + ' title');
			assert.ok(sectionKeys.has(f.section), f.id + ': unknown section ' + f.section);
			assert.ok(Array.isArray(f.prs) && f.prs.every(Number.isInteger), f.id + ' prs');
			assert.ok(f.settingsKey === null || typeof f.settingsKey === 'string', f.id + ' settingsKey');
			assert.ok(STAGES.includes(f.stage), f.id + ' stage');
			assert.ok(['all', 'maskAdmin'].includes(f.audience), f.id + ' audience');
			assert.ok(['active', 'passive'].includes(f.kind), f.id + ' kind');
			['commands', 'panels', 'use'].forEach(k => assert.ok(Array.isArray(f[k]), f.id + ' ' + k));
			f.use.forEach(a => assert.ok(/^[a-z_]{1,24}$/.test(a), f.id + ': action ' + a));
			if (f.exposed !== undefined) { assert.ok(typeof f.exposed === 'string' && f.exposed, f.id + ' exposed'); }
			if (f.success !== undefined) { assert.ok(typeof f.success === 'string' && f.success, f.id + ' success'); }
		});
	});

	it('every settingsKey is a key a Settings row stores', () => {
		features.filter(f => f.settingsKey).forEach(f => assert.ok(settingsKeys.has(f.settingsKey), f.id + ': no Settings row stores ' + f.settingsKey));
	});

	it('covers every What\'s New entry exactly once (or skips it)', () => {
		const prs = whatsNew.map(e => e.pr);
		const owner = {};
		features.forEach(f => f.prs.forEach(pr => {
			assert.ok(prs.includes(pr), f.id + ': PR ' + pr + ' is not in features.json');
			assert.ok(!owner[pr], 'PR ' + pr + ' in both ' + owner[pr] + ' and ' + f.id);
			owner[pr] = f.id;
		}));
		(catalog.skip || []).forEach(s => {
			assert.ok(prs.includes(s.pr), 'skipped PR ' + s.pr + ' is not in features.json');
			assert.ok(!owner[s.pr], 'PR ' + s.pr + ' skipped and in ' + owner[s.pr]);
			owner[s.pr] = 'skip';
		});
		const missing = prs.filter(pr => !owner[pr]);
		assert.deepStrictEqual(missing, [], 'What\'s New PRs with no catalog entry: add them to a feature (or to "skip")');
	});

	it('every command is registered and belongs to one feature', () => {
		const seen = {};
		features.forEach(f => f.commands.forEach(c => {
			assert.ok(commandIds.has(c), f.id + ': command ' + c + ' is not registered');
			assert.ok(!seen[c], c + ' in both ' + seen[c] + ' and ' + f.id);
			seen[c] = f.id;
		}));
	});

	it('every panel is a panel id and belongs to one feature', () => {
		const seen = {};
		features.forEach(f => f.panels.forEach(p => {
			assert.ok(panelIds.has(p), f.id + ': panel ' + p + ' is unknown');
			assert.ok(!seen[p], p + ' in both ' + seen[p] + ' and ' + f.id);
			seen[p] = f.id;
		}));
	});

	// Explicit emitters: forkUsage.track("id", "action") calls and data-track="id.action" attributes in the app's JS
	const emitted = new Set();
	sources.forEach(s => {
		[...s.text.matchAll(/forkUsage\.track\(\s*"([A-Za-z0-9]+)"\s*,\s*"([a-z_]+)"\s*\)/g)].forEach(m => emitted.add(m[1] + '.' + m[2]));
		[...s.text.matchAll(/data-track=\\?['"]([A-Za-z0-9]+)\.([a-z_]+)\\?['"]/g)].forEach(m => emitted.add(m[1] + '.' + m[2]));
	});

	it('every use action has something that sends it (or is counted automatically)', () => {
		const missing = [];
		features.forEach(f => f.use.forEach(a => {
			if (a === 'command' && f.commands.length) { return; }			// forkCommands.execute hook
			if (a === 'opened' && f.panels.length) { return; }			// panelHost / panelModes hooks
			if (/^setting_/.test(a) && f.settingsKey) { return; }			// Settings Save diff
			if (!emitted.has(f.id + '.' + a)) { missing.push(f.id + '.' + a); }
		}));
		assert.deepStrictEqual(missing, [], 'add forkUsage.track("<id>", "<action>") (or data-track) where the feature is used');
	});

	it('every active feature can record a use', () => {
		features.filter(f => f.kind === 'active').forEach(f => assert.ok(f.commands.length || f.panels.length || f.use.length, f.id));
	});

	it('every explicit track call names a catalog feature and an action it accepts', () => {
		const byId = {};
		features.forEach(f => { byId[f.id] = f; });
		const GENERIC = ['command', 'opened', 'shown', 'disabled', 'setting_on', 'setting_off', 'setting_changed'];
		[...emitted].forEach(e => {
			const [id, a] = e.split('.');
			if (catalog.internal.includes(id)) { return; }
			assert.ok(byId[id], e + ': unknown feature');
			assert.ok(byId[id].use.includes(a) || GENERIC.includes(a), e + ': action not in the feature\'s use list');
		});
	});

	it('the server whitelist reads the same file', () => {
		const php = fs.readFileSync(path.join(root, 'analytics/analytics.inc.php'), 'utf8');
		assert.ok(php.includes('public/fork/feature-catalog.json'));
	});
});
