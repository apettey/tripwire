const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/panel-modes');

describe('Panel display modes', () => {
	const pm = () => panelModes;
	const plain = { id: 'notesWidget', title: 'Notes' };
	const kills = { id: 'systemKillFeedWidget', title: 'System kills', small: true };
	const planner = { id: 'jumpPlannerWidget', title: 'Jump planner', defaultMode: 'floating' };

	describe('modes', () => {
		it('every panel can be docked, popped out and minimized; small view only with def.small', () => {
			assert.deepEqual(pm().allowed(plain), ['fixed', 'floating', 'minimized']);
			assert.deepEqual(pm().allowed(kills), ['fixed', 'floating', 'small', 'minimized']);
			assert.deepEqual(pm().allowed(undefined), ['fixed', 'floating', 'minimized']);
		});
		it('normalize: unknown = the default (fixed), small without a small view = floating', () => {
			assert.equal(pm().normalize('floating', plain), 'floating');
			assert.equal(pm().normalize('minimized', plain), 'minimized');
			assert.equal(pm().normalize('small', plain), 'floating');
			assert.equal(pm().normalize('small', kills), 'small');
			assert.equal(pm().normalize(undefined, plain), 'fixed');
			assert.equal(pm().normalize('FLOATING', plain), 'fixed');
			assert.equal(pm().normalize(null, kills), 'fixed');
			assert.equal(pm().normalize('restore', kills), 'fixed');
		});
		it('a panel may have another default (the Jump planner opens popped out); an invalid default is fixed', () => {
			assert.equal(pm().normalize(undefined, planner), 'floating');
			assert.equal(pm().normalize('fixed', planner), 'fixed');
			assert.equal(pm().defaultMode({ id: 'x', defaultMode: 'small' }), 'fixed');
			assert.equal(pm().defaultMode({ id: 'x', defaultMode: 'bogus' }), 'fixed');
		});
		it('modeOf reads options.panels.<id>.mode (missing, junk = default)', () => {
			assert.equal(pm().modeOf(undefined, plain), 'fixed');
			assert.equal(pm().modeOf({}, plain), 'fixed');
			assert.equal(pm().modeOf({ panels: [] }, plain), 'fixed');
			assert.equal(pm().modeOf({ panels: { notesWidget: 'floating' } }, plain), 'fixed');
			assert.equal(pm().modeOf({ panels: { notesWidget: { mode: 'minimized' } } }, plain), 'minimized');
			assert.equal(pm().modeOf({ panels: { notesWidget: { mode: 'small' } } }, plain), 'floating');
			assert.equal(pm().modeOf({ panels: { other: { mode: 'floating' } } }, plain), 'fixed');
			assert.equal(pm().modeOf({}, planner), 'floating');
		});
		it('withMode sets one panel, keeps the rest and never mutates', () => {
			const opts = { panels: { a: { mode: 'floating', x: 1 }, b: { mode: 'small' } } };
			const out = pm().withMode(opts, 'a', 'fixed');
			assert.deepEqual(out, { a: { mode: 'fixed', x: 1 }, b: { mode: 'small' } });
			assert.deepEqual(opts.panels.a, { mode: 'floating', x: 1 });
			assert.deepEqual(pm().withMode({}, 'c', 'minimized'), { c: { mode: 'minimized' } });
		});
	});

	describe('places', () => {
		it('place reads options.panelPlaces.<id>, {} for missing or junk', () => {
			assert.deepEqual(pm().place({ panelPlaces: { a: { float: { left: 1 } } } }, 'a'), { float: { left: 1 } });
			assert.deepEqual(pm().place({ panelPlaces: { a: [1] } }, 'a'), {});
			assert.deepEqual(pm().place({ panelPlaces: 'x' }, 'a'), {});
			assert.deepEqual(pm().place(null, 'a'), {});
		});
		it('withPlace merges into the panel\'s entry without mutating', () => {
			const opts = { panelPlaces: { a: { float: { left: 1 } }, b: { small: { top: 2 } } } };
			const out = pm().withPlace(opts, 'a', { restore: 'small' });
			assert.deepEqual(out, { a: { float: { left: 1 }, restore: 'small' }, b: { small: { top: 2 } } });
			assert.deepEqual(opts.panelPlaces.a, { float: { left: 1 } });
		});
		it('a minimized panel comes back popped out, small only when it was and has a small view', () => {
			assert.equal(pm().restoreMode({}, kills), 'floating');
			assert.equal(pm().restoreMode({ panelPlaces: { systemKillFeedWidget: { restore: 'small' } } }, kills), 'small');
			assert.equal(pm().restoreMode({ panelPlaces: { systemKillFeedWidget: { restore: 'floating' } } }, kills), 'floating');
			assert.equal(pm().restoreMode({ panelPlaces: { notesWidget: { restore: 'small' } } }, plain), 'floating');
			assert.equal(pm().restoreMode({ panelPlaces: { notesWidget: { restore: 'fixed' } } }, plain), 'floating');
		});
	});

	describe('header buttons', () => {
		const tos = (mode, def) => pm().buttons(mode, def).map(b => b.to);
		it('docked: Pop out, Small view (if any), Minimize', () => {
			assert.deepEqual(tos('fixed', plain), ['floating', 'minimized']);
			assert.deepEqual(tos('fixed', kills), ['floating', 'small', 'minimized']);
		});
		it('popped out: Small view (if any), Minimize, Dock', () => {
			assert.deepEqual(tos('floating', plain), ['minimized', 'fixed']);
			assert.deepEqual(tos('floating', kills), ['small', 'minimized', 'fixed']);
		});
		it('small view: Normal size, Minimize, Dock', () => {
			assert.deepEqual(tos('small', kills), ['floating', 'minimized', 'fixed']);
			// a panel without one is never shown small: its buttons are the popped-out ones
			assert.deepEqual(tos('small', plain), ['minimized', 'fixed']);
		});
		it('minimized (Panels menu): Restore, Dock', () => {
			assert.deepEqual(tos('minimized', kills), ['restore', 'fixed']);
		});
		it('the same icon for the same action everywhere; Minimize before Dock, Dock last', () => {
			const icon = {};
			['fixed', 'floating', 'small'].forEach(m => pm().buttons(m, kills).forEach(b => {
				if (b.to !== 'floating') {
					assert.ok(!icon[b.to] || icon[b.to] === b.icon, b.to);
					icon[b.to] = b.icon;
				}
			}));
			assert.deepEqual(icon, { small: 'fullscreen-exit', minimized: 'minus', fixed: 'pin' });
			['floating', 'small'].forEach(m => assert.equal(tos(m, kills).slice(-2).join(), 'minimized,fixed'));
		});
		it('buttonsHtml carries the panel id and target mode; tooltips for every button', () => {
			const html = pm().buttonsHtml('fixed', kills);
			assert.equal((html.match(/class='ph-btn'/g) || []).length, 3);
			assert.ok(html.indexOf("data-ph-id='systemKillFeedWidget' data-ph-to='small'") > 0);
			pm().buttons('fixed', kills).forEach(b => assert.ok(b.tooltip && b.icon));
		});
	});

	describe('Panels menu', () => {
		const defs = [{ id: 'infoWidget', title: 'System info' }, plain, kills, planner];
		it('lists the panels that are on, in order, with their mode and actions; badge = minimized ones', () => {
			const opts = { panels: { notesWidget: { mode: 'minimized' }, systemKillFeedWidget: { mode: 'small' } } };
			const shown = id => id !== 'jumpPlannerWidget';
			const m = pm().menuModel(defs, opts, shown);
			assert.deepEqual(m.rows.map(r => r.id), ['infoWidget', 'notesWidget', 'systemKillFeedWidget']);
			assert.deepEqual(m.rows.map(r => r.mode), ['fixed', 'minimized', 'small']);
			assert.deepEqual(m.rows.map(r => r.label), ['Docked', 'Minimized', 'Small view']);
			assert.equal(m.badge, 1);
			assert.deepEqual(m.rows[1].actions.map(a => a.to), ['restore', 'fixed']);
		});
		it('a minimized panel that is off is not counted', () => {
			const opts = { panels: { notesWidget: { mode: 'minimized' }, jumpPlannerWidget: { mode: 'minimized' } } };
			assert.equal(pm().menuModel(defs, opts, id => id !== 'jumpPlannerWidget').badge, 1);
			assert.equal(pm().menuModel(defs, opts, () => false).badge, 0);
			assert.equal(pm().menuModel(defs, opts).badge, 2);	// no shown(): every panel
			assert.deepEqual(pm().menuModel([], opts, () => true), { rows: [], badge: 0 });
		});
		it('actions per mode: never the current mode; small only with a small view', () => {
			const tos = (mode, def) => pm().actions(mode, def).map(a => a.to);
			assert.deepEqual(tos('fixed', plain), ['floating', 'minimized']);
			assert.deepEqual(tos('fixed', kills), ['floating', 'small', 'minimized']);
			assert.deepEqual(tos('floating', kills), ['fixed', 'small', 'minimized']);
			assert.deepEqual(tos('small', kills), ['fixed', 'floating', 'minimized']);
			assert.equal(pm().actions('small', kills)[1].label, 'Normal size');
			assert.deepEqual(tos('minimized', plain), ['restore', 'fixed']);
		});
	});

	describe('commands', () => {
		it('Pop out, Dock, Minimize, Restore for every panel; Small view only with one', () => {
			assert.deepEqual(pm().commandList(plain).map(c => c.verb), ['Pop out', 'Dock', 'Minimize', 'Restore']);
			assert.deepEqual(pm().commandList(kills).map(c => c.verb), ['Pop out', 'Dock', 'Minimize', 'Restore', 'Small view']);
		});
		it('a command is available unless the panel is off, already in that mode, or (Restore) not minimized', () => {
			assert.equal(pm().commandState(plain, 'fixed', 'floating', true), true);
			assert.equal(pm().commandState(plain, 'fixed', 'fixed', true), 'It is docked now');
			assert.equal(pm().commandState(plain, 'floating', 'floating', true), 'It is popped out now');
			assert.equal(pm().commandState(plain, 'fixed', 'restore', true), "It isn't minimized");
			assert.equal(pm().commandState(plain, 'minimized', 'restore', true), true);
			assert.equal(pm().commandState(plain, 'fixed', 'small', true), 'It has no small view');
			assert.equal(pm().commandState(kills, 'fixed', 'small', true), true);
			assert.equal(pm().commandState(plain, 'fixed', 'floating', false), 'The panel is turned off');
			assert.equal(pm().commandState({ id: 'p', offReason: 'Not open' }, 'fixed', 'floating', false), 'Not open');
		});
	});

	describe('migration from the kill panel modes (#115)', () => {
		const run = (opts) => {
			const before = JSON.stringify(opts);
			const m = pm().migrate(opts);
			assert.equal(JSON.stringify(opts), before, 'migrate never mutates');
			return m;
		};
		const apply = (opts, m) => {
			const out = Object.assign({}, opts);
			Object.keys(m.set).forEach(k => { out[k] = m.set[k]; });
			m.remove.forEach(k => { delete out[k]; });
			return out;
		};
		it('floating stays floating, minimized becomes the small view, fixed is the default', () => {
			const opts = { systemKillFeed: { enabled: true, mode: 'floating' }, chainKillFeed: { mode: 'minimized' } };
			const out = apply(opts, run(opts));
			assert.deepEqual(out.panels, { systemKillFeedWidget: { mode: 'floating' }, chainKillFeedWidget: { mode: 'small' } });
			assert.deepEqual(out.systemKillFeed, { enabled: true });
			assert.deepEqual(out.chainKillFeed, {});
		});
		it('fixed and unknown modes leave no panels entry, but the old field goes', () => {
			['fixed', 'bogus', null].forEach(mode => {
				const opts = { systemKillFeed: { enabled: false, mode: mode } };
				const m = run(opts);
				assert.equal(m.changed, true);
				const out = apply(opts, m);
				assert.equal(out.panels, undefined);
				assert.deepEqual(out.systemKillFeed, { enabled: false });
			});
		});
		it('moves the floating window place; drops killPanelPlaces (also the minimized height)', () => {
			const opts = { killPanelPlaces: { systemKillFeed: { float: { left: 1, top: 2, width: 300, height: 200 }, fullSizeY: 7 }, chainKillFeed: { fullSizeY: 9 } } };
			const m = run(opts);
			const out = apply(opts, m);
			assert.deepEqual(out.panelPlaces, { systemKillFeedWidget: { float: { left: 1, top: 2, width: 300, height: 200 } } });
			assert.equal(out.killPanelPlaces, undefined);
			assert.deepEqual(m.remove, ['killPanelPlaces']);
		});
		it('a mode or place already in the new keys wins; other panels are kept', () => {
			const opts = {
				systemKillFeed: { mode: 'floating' }, chainKillFeed: { mode: 'floating' },
				panels: { systemKillFeedWidget: { mode: 'fixed' }, notesWidget: { mode: 'minimized' } },
				panelPlaces: { systemKillFeedWidget: { float: { left: 5 } }, notesWidget: { restore: 'floating' } },
				killPanelPlaces: { systemKillFeed: { float: { left: 1 } }, chainKillFeed: { float: { left: 2 } } }
			};
			const out = apply(opts, run(opts));
			assert.deepEqual(out.panels, { systemKillFeedWidget: { mode: 'fixed' }, notesWidget: { mode: 'minimized' }, chainKillFeedWidget: { mode: 'floating' } });
			assert.deepEqual(out.panelPlaces, { systemKillFeedWidget: { float: { left: 5 } }, notesWidget: { restore: 'floating' }, chainKillFeedWidget: { float: { left: 2 } } });
		});
		it('every combination of old modes and places migrates; running it again changes nothing', () => {
			const modes = [undefined, 'fixed', 'minimized', 'floating', 'junk'];
			const expected = { fixed: undefined, minimized: 'small', floating: 'floating', junk: undefined, undefined: undefined };
			modes.forEach(sm => modes.forEach(cm => [false, true].forEach(withPlaces => {
				const opts = {};
				if (sm !== undefined) { opts.systemKillFeed = { enabled: true, mode: sm }; }
				if (cm !== undefined) { opts.chainKillFeed = { mode: cm }; }
				if (withPlaces) { opts.killPanelPlaces = { chainKillFeed: { float: { left: 3 } } }; }
				const once = apply(opts, run(opts));
				const mode = (id) => once.panels && once.panels[id] ? once.panels[id].mode : undefined;
				assert.equal(mode('systemKillFeedWidget'), expected[sm], 'system ' + sm);
				assert.equal(mode('chainKillFeedWidget'), expected[cm], 'chain ' + cm);
				assert.ok(!once.systemKillFeed || once.systemKillFeed.mode === undefined);
				assert.ok(!once.chainKillFeed || once.chainKillFeed.mode === undefined);
				assert.equal(once.killPanelPlaces, undefined);
				if (withPlaces) { assert.deepEqual(once.panelPlaces.chainKillFeedWidget, { float: { left: 3 } }); }
				const again = run(once);
				assert.deepEqual(again, { changed: false, set: {}, remove: [] });
			})));
		});
		it('nothing to do: unchanged; junk options are ignored', () => {
			assert.deepEqual(run({ panels: { a: { mode: 'floating' } }, systemKillFeed: { enabled: true } }), { changed: false, set: {}, remove: [] });
			assert.deepEqual(pm().migrate(null), { changed: false, set: {}, remove: [] });
			assert.deepEqual(run({ systemKillFeed: 'floating', killPanelPlaces: undefined }), { changed: false, set: {}, remove: [] });
		});
	});

	describe('options keys', () => {
		it('options.panels and options.panelPlaces are not Settings rows: never mask defaults', () => {
			include('app/js/fork/mask-defaults');
			assert.equal(maskDefaults.allowedKey(pm().OPTIONS_KEY), false);
			assert.equal(maskDefaults.allowedKey(pm().PLACES_KEY), false);
			assert.equal(maskDefaults.allowedKey(pm().LEGACY_PLACES_KEY), false);
		});
		it('the upstream panels it adds; never the chain map', () => {
			assert.deepEqual(pm().UPSTREAM.map(u => u.id), ['infoWidget', 'signaturesWidget', 'notesWidget']);
			pm().UPSTREAM.forEach(u => assert.ok(u.size.minX <= u.size.x && u.size.minY <= u.size.y));
		});
	});
});
