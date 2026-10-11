const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/layout-grid');

describe('Layout grid (Settings Save keeps the layout)', () => {
	const w = (id, col, row, x, y) => ({ id, col, row, size_x: x || 7, size_y: y || 6, width: 410, height: 350 });
	const ids = (list) => list.map(e => e.id + ' ' + e.col + ',' + e.row + ' ' + e.size_x + 'x' + e.size_y);

	it('is a var, so options.js can test for it on page load (before this file has run in the bundle)', () => {
		assert.ok(/^var layoutGrid = \{/.test(require('fs').readFileSync('app/js/fork/layout-grid.js', 'utf8')));
	});

	describe('entries', () => {
		it('reads arrays, objects and the old {oog} form', () => {
			assert.deepEqual(ids(layoutGrid.entries([w('a', 1, 1)])), ['a 1,1 7x6']);
			assert.deepEqual(ids(layoutGrid.entries({ 0: w('a', 1, 1), 1: w('b', 8, 1) })), ['a 1,1 7x6', 'b 8,1 7x6']);
			assert.deepEqual(ids(layoutGrid.entries({ oog: { 0: w('c', 2, 3) } })), ['c 2,3 7x6']);
		});
		it('is empty for nothing, an empty layout or junk, and skips entries without an id', () => {
			[undefined, null, {}, [], 'x', 3, { oog: {} }].forEach(v => assert.deepEqual(layoutGrid.entries(v), []));
			assert.deepEqual(ids(layoutGrid.entries([null, 'x', { col: 1 }, { id: '' }, w('a', 1, 1)])), ['a 1,1 7x6']);
		});
	});

	describe('merge', () => {
		it('lets the first layout win per panel and keeps panels only the later ones know', () => {
			const live = [w('chainWidget', 1, 7, 12, 6), w('systemKillFeedWidget', 13, 7, 7, 5)];
			const saved = [w('chainWidget', 1, 7, 21, 8), w('systemKillFeedWidget', 1, 35), w('intelScansWidget', 13, 12, 6, 6)];
			const pageLoad = { 0: w('favouritesWidget', 14, 1, 7, 8), 1: w('intelScansWidget', 1, 29, 6, 6) };
			assert.deepEqual(ids(layoutGrid.merge(live, saved, pageLoad)), [
				'chainWidget 1,7 12x6', 'systemKillFeedWidget 13,7 7x5', 'intelScansWidget 13,12 6x6', 'favouritesWidget 14,1 7x8'
			]);
		});
		it('drops widgets on their way out', () => {
			assert.deepEqual(ids(layoutGrid.merge([w('a', 1, 1)], [w('systemKillFeedWidget-removed', 3, 3), w('b', 2, 2)])), ['a 1,1 7x6', 'b 2,2 7x6']);
		});
		it('returns copies and leaves its arguments alone', () => {
			const live = [w('a', 1, 1)];
			const saved = { oog: { 0: w('b', 2, 2) } };
			const before = JSON.stringify([live, saved]);
			const out = layoutGrid.merge(live, saved);
			out[0].col = 99;
			assert.equal(JSON.stringify([live, saved]), before);
			assert.ok(Array.isArray(out));
		});
	});

	describe('live', () => {
		it('is null until gridster is there (the first apply, on page load)', () => {
			[undefined, null, {}, { serialize: 1 }, { serialize: () => [] }].forEach(api => assert.equal(layoutGrid.live(api, [w('a', 1, 1)]), null));
		});
		it('is the layout on screen plus saved places of panels that are not on the page', () => {
			const api = { $widgets: {}, serialize: () => [w('chainWidget', 1, 7, 12, 6)] };
			assert.deepEqual(ids(layoutGrid.live(api, [w('chainWidget', 1, 7, 21, 8), w('favouritesWidget', 1, 21, 7, 8)])),
				['chainWidget 1,7 12x6', 'favouritesWidget 1,21 7x8']);
		});
	});

	// Upstream's options.js with a stand-in jQuery: what Settings > Save (options.apply(); options.save()) and
	// Settings > Reset (options.reset(); options.apply()) do to the layout
	describe('options.apply() (app/js/options.js)', () => {
		const NAMES = ['window', '$', 'options', 'grid', 'init', 'localStorage', 'tripwire', 'guidance', 'chain', 'viewingSystemID', 'set_tracking_text'];
		let saved, moves, stored, onScreen, posted;

		const fake$ = () => {
			const chainable = (sel) => {
				const c = new Proxy(function() {}, {
					get: (t, p) => {
						if (p === 'length') { return 0; }
						return (...args) => {
							if (p === 'attr' && args[0] && typeof args[0] === 'object' && 'data-col' in args[0]) { moves[sel] = args[0]; }
							return c;
						};
					}
				});
				return c;
			};
			const $ = (sel) => chainable(sel);
			$.each = (obj, fn) => { Object.keys(obj).forEach(k => fn.call(obj[k], k, obj[k])); };
			$.map = (arr, fn) => (arr || []).map(v => fn(v));
			$.inArray = (v, arr) => (arr || []).indexOf(v);
			$.ajax = (o) => { posted = o; return {}; };
			return $;
		};

		before(() => {
			saved = {};
			NAMES.forEach(n => { saved[n] = Object.getOwnPropertyDescriptor(global, n); });
		});
		after(() => {
			NAMES.forEach(n => { if (saved[n]) { Object.defineProperty(global, n, saved[n]); } else { delete global[n]; } });
		});

		/** Load options.js as a page would: the browser's copy of the options holds pageLoadGrid (or is `copy`) */
		const loadPage = (pageLoadGrid, copy, server) => {
			moves = {};
			posted = null;
			stored = copy !== undefined ? JSON.stringify(copy) : pageLoadGrid ? JSON.stringify({ grid: pageLoadGrid }) : null;
			delete global.grid;
			global.window = global;
			global.$ = fake$();
			global.init = { userID: 1, characterID: 2, characterName: 'Dev', corporationID: 3, options: server || null };
			global.localStorage = { getItem: () => stored, setItem: (k, v) => { stored = v; } };
			global.tripwire = undefined;
			if (!global.guidance) { global.guidance = null; }	// the real one when guidance.test.js has loaded it (its afterEach uses it)
			global.viewingSystemID = 30000142;
			global.set_tracking_text = () => {};
			include('app/js/options');
			// layout-grid.js runs after options.js in the bundle and wraps its save, once
			assert.equal(layoutGrid.wrapSave(options, () => global.grid), true);
			assert.equal(layoutGrid.wrapSave(options, () => global.grid), false);
			// layout.js: gridster is up after options.js, with the panels where options.apply() put them
			onScreen = (pageLoadGrid || []).map(e => Object.assign({}, e));
			global.grid = { $widgets: {}, serialize: () => onScreen.map(e => Object.assign({}, e)) };
		};
		const savedLayout = () => ids(JSON.parse(stored).grid);

		const pageLoad = [w('chainWidget', 1, 7, 21, 8), w('systemKillFeedWidget', 1, 35, 7, 6), w('intelScansWidget', 1, 29, 6, 6)];

		it('places the panels from the browser copy on page load (unchanged upstream)', () => {
			loadPage(pageLoad);
			assert.deepEqual(Object.keys(moves).sort(), ['#chainWidget', '#intelScansWidget', '#systemKillFeedWidget']);
			assert.equal(moves['#systemKillFeedWidget']['data-row'], 35);
		});

		it('Settings Save keeps panels moved and resized since the page loaded (and saves that layout)', () => {
			loadPage(pageLoad);
			// Customize layout: chain map narrower, Kills panel up next to it and smaller
			onScreen = [w('chainWidget', 1, 7, 12, 6), w('systemKillFeedWidget', 13, 7, 7, 5), w('intelScansWidget', 13, 12, 6, 6)];
			moves = {};
			options.apply();
			options.save();
			assert.deepEqual(moves['#systemKillFeedWidget'], { 'data-col': 13, 'data-row': 7, 'data-sizex': 7, 'data-sizey': 5 });
			assert.deepEqual(moves['#chainWidget'], { 'data-col': 1, 'data-row': 7, 'data-sizex': 12, 'data-sizey': 6 });
			assert.deepEqual(savedLayout(), ['chainWidget 1,7 12x6', 'systemKillFeedWidget 13,7 7x5', 'intelScansWidget 13,12 6x6']);
			// A second Save in the same page keeps it too
			options.apply();
			assert.deepEqual(ids(options.grid), ['chainWidget 1,7 12x6', 'systemKillFeedWidget 13,7 7x5', 'intelScansWidget 13,12 6x6']);
		});

		it('keeps the place of a panel turned off since (for when it is turned on again)', () => {
			loadPage(pageLoad);
			onScreen = [w('chainWidget', 1, 7, 12, 6), w('systemKillFeedWidget', 13, 7, 7, 5), w('intelScansWidget', 13, 12, 6, 6)];
			options.apply();	// Save with the Kills panel turned off: it is removed after this apply
			onScreen = onScreen.filter(e => e.id !== 'systemKillFeedWidget');
			options.apply();	// a later Save
			assert.deepEqual(ids(options.grid), ['chainWidget 1,7 12x6', 'intelScansWidget 13,12 6x6', 'systemKillFeedWidget 13,7 7x5']);
		});

		it('Settings Reset resets the settings but leaves the layout on screen', () => {
			loadPage(pageLoad);
			options.uiscale = 1.5;
			onScreen = [w('chainWidget', 1, 7, 12, 6), w('systemKillFeedWidget', 13, 7, 7, 5), w('intelScansWidget', 13, 12, 6, 6)];
			options.reset();
			options.apply();
			assert.equal(options.uiscale, 1.0);
			assert.deepEqual(ids(options.grid), ['chainWidget 1,7 12x6', 'systemKillFeedWidget 13,7 7x5', 'intelScansWidget 13,12 6x6']);
		});

		it('saves the layout after panels added by the fork apply hooks pushed their neighbours down', () => {
			// Kills turned off and the page reloaded: Watchlist floated up into its place
			loadPage([w('chainWidget', 1, 7, 21, 8), w('watchlistWidget', 1, 25, 7, 6)]);
			options.grid = [w('chainWidget', 1, 7, 21, 8), w('watchlistWidget', 1, 25, 7, 6), w('systemKillFeedWidget', 1, 25, 7, 6)];
			// Settings Save with Kills on again: like system-killfeed.js, the hook adds the panel after the inner apply,
			// and gridster pushes Watchlist down
			const inner = options.apply;
			options.apply = function() {
				const result = inner.apply(this, arguments);
				onScreen = [w('chainWidget', 1, 7, 21, 8), w('systemKillFeedWidget', 1, 25, 7, 6), w('watchlistWidget', 1, 31, 7, 6)];
				return result;
			};
			options.apply();
			// options.grid was taken before the push
			assert.deepEqual(ids(options.grid), ['chainWidget 1,7 21x8', 'watchlistWidget 1,25 7x6', 'systemKillFeedWidget 1,25 7x6']);
			options.save();
			const want = ['chainWidget 1,7 21x8', 'systemKillFeedWidget 1,25 7x6', 'watchlistWidget 1,31 7x6'];
			assert.deepEqual(savedLayout(), want);
			// The server gets the same, the usual way
			assert.equal(posted.url, 'options.php');
			assert.equal(posted.data.mode, 'set');
			assert.deepEqual(ids(JSON.parse(posted.data.options).grid), want);
		});

		it('saves the rest of the options as before, and keeps the saved place of a panel turned off', () => {
			loadPage(pageLoad);
			options.uiscale = 1.25;
			options.grid = [w('favouritesWidget', 14, 7, 7, 8)];
			options.save();
			const out = JSON.parse(stored);
			assert.equal(out.uiscale, 1.25);
			assert.equal(out.userID, 1);
			assert.deepEqual(ids(out.grid), ['chainWidget 1,7 21x8', 'systemKillFeedWidget 1,35 7x6', 'intelScansWidget 1,29 6x6', 'favouritesWidget 14,7 7x8']);
		});

		it('stores options.grid unchanged before gridster is there', () => {
			loadPage(pageLoad);
			delete global.grid;
			options.grid = [w('chainWidget', 2, 2)];
			options.save();
			assert.deepEqual(savedLayout(), ['chainWidget 2,2 7x6']);
		});

		[['browser copy with an empty object', { grid: {} }], ['browser copy with an empty array', { grid: [] }], ['no browser copy, server options without a grid key', null, { uiscale: 1 }]].forEach(([name, copy, server]) => {
			it('Settings Save stores the layout on screen (' + name + ')', () => {
				loadPage(null, copy, server);
				onScreen = [w('chainWidget', 1, 7, 12, 6), w('systemKillFeedWidget', 13, 7, 7, 5)];
				moves = {};
				options.apply();
				options.save();
				assert.deepEqual(savedLayout(), ['chainWidget 1,7 12x6', 'systemKillFeedWidget 13,7 7x5']);
				assert.deepEqual(moves['#systemKillFeedWidget'], { 'data-col': 13, 'data-row': 7, 'data-sizex': 7, 'data-sizey': 5 });
			});
		});

		it('a browser without a copy of the options keeps the layout on screen too', () => {
			loadPage(null);
			onScreen = [w('chainWidget', 1, 7, 12, 6)];
			options.apply();
			assert.deepEqual(ids(options.grid), ['chainWidget 1,7 12x6']);
		});
	});
});
