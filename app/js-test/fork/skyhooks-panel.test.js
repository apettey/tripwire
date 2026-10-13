const assert = require('assert');
const { include } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/guidance');
include('app/js/systemAnalysis');
include('app/js/fork/skyhooks-panel');

const T = Date.UTC(2026, 9, 11, 15, 0, 0) / 1000;   // 2026-10-11 15:00 UTC
const sh = (systemID, startOffset, endOffset, planetID) => ({ planetID: planetID || systemID * 10, systemID, start: T + startOffset, end: T + endOffset });
const systems = { 1: { security: 0.2 }, 2: { security: -0.5 }, 3: { security: 0.9 }, 4: { security: 0.0 }, 5: {} };
const systemFor = id => systems[id] || null;
const S = saved => skyhooksPanel.settings(saved);

describe('Skyhooks panel', () => {
	describe('settings', () => {
		it('defaults (the name click is off)', () => assert.deepEqual(S(undefined), { enabled: true, clickOpen: false, low: true, null: true, lava: true, ice: true, window: 'soon', soonHours: 2, sort: 'jumps' }));
		it('keeps valid values', () => assert.deepEqual(S({ enabled: false, clickOpen: true, low: false, null: true, lava: false, ice: false, window: 'now', soonHours: 4, sort: 'value' }),
			{ enabled: false, clickOpen: true, low: false, null: true, lava: false, ice: false, window: 'now', soonHours: 4, sort: 'value' }));
		it('the retired box keys are ignored', () => assert.deepEqual(S({ maxJumps: 5, position: { col: 1 } }), S({})));
		it('rejects nonsense', () => assert.deepEqual(S({ window: 'x', soonHours: 'abc', sort: 5, clickOpen: 'yes' }), S({})));
		it('garbage options', () => assert.deepEqual(S('x'), S({})));
	});

	describe('time', () => {
		it('duration hours and minutes', () => assert.equal(skyhooksPanel.duration(3600 + 12 * 60), '1h12m'));
		it('duration pads minutes', () => assert.equal(skyhooksPanel.duration(3600 + 5 * 60), '1h05m'));
		it('duration minutes', () => assert.equal(skyhooksPanel.duration(34 * 60 + 59), '34m'));
		it('duration under a minute', () => assert.equal(skyhooksPanel.duration(20), '<1m'));
		it('duration negative', () => assert.equal(skyhooksPanel.duration(-5), '<1m'));
		it('status open', () => assert.deepEqual(skyhooksPanel.status(T - 10, T + 100, T), { state: 'open', opensIn: 0, leftIn: 100 }));
		it('status starts exactly now', () => assert.equal(skyhooksPanel.status(T, T + 100, T).state, 'open'));
		it('status soon', () => assert.deepEqual(skyhooksPanel.status(T + 60, T + 100, T), { state: 'soon', opensIn: 60, leftIn: 0 }));
		it('status ended exactly now', () => assert.equal(skyhooksPanel.status(T - 100, T, T).state, 'closed'));
		it('countdown open', () => assert.equal(skyhooksPanel.countdown(T - 3600, T + 72 * 60, T), 'open now, 1h12m left'));
		it('countdown soon', () => assert.equal(skyhooksPanel.countdown(T + 34 * 60, T + 4000, T), 'opens in 34m'));
		it('countdown closed', () => assert.equal(skyhooksPanel.countdown(T - 200, T - 100, T), 'closed'));
		it('window text, same day, UTC', () => assert.equal(skyhooksPanel.windowText(T + 6 * 60, T + 126 * 60, T), '15:06–17:06'));
		it('window text with the date when not today', () => assert.equal(skyhooksPanel.windowText(T + 10 * 3600, T + 12 * 3600, T), 'Oct 12 01:00–03:00'));
	});

	describe('security', () => {
		it('classes', () => {
			assert.equal(skyhooksPanel.securityClass(systems[1]), 'low');
			assert.equal(skyhooksPanel.securityClass(systems[2]), 'null');
			assert.equal(skyhooksPanel.securityClass(systems[3]), 'high');
			assert.equal(skyhooksPanel.securityClass(systems[4]), 'null');
			assert.equal(skyhooksPanel.securityClass(systems[5]), null);
			assert.equal(skyhooksPanel.securityClass(null), null);
		});
		it('0.45 is high-sec, 0.44 low', () => {
			assert.equal(skyhooksPanel.securityClass({ security: 0.45 }), 'high');
			assert.equal(skyhooksPanel.securityClass({ security: 0.44 }), 'low');
		});
		it('baseSecurity wins', () => assert.equal(skyhooksPanel.securityClass({ baseSecurity: 0.1, security: 0.9 }), 'low'));
		it('checkboxes', () => {
			assert.equal(skyhooksPanel.securityPasses(systems[1], S({ low: false })), false);
			assert.equal(skyhooksPanel.securityPasses(systems[1], S({ null: false })), true);
			assert.equal(skyhooksPanel.securityPasses(systems[2], S({ null: false })), false);
		});
		it('high-sec and unknown are not hidden by the checkboxes', () => {
			assert.equal(skyhooksPanel.securityPasses(systems[3], S({ low: false, null: false })), true);
			assert.equal(skyhooksPanel.securityPasses(systems[5], S({ low: false, null: false })), true);
		});
	});

	describe('window filter', () => {
		const pass = (start, end, saved) => skyhooksPanel.windowPasses(T + start, T + end, T, S(saved));
		it('now: open only', () => {
			assert.equal(pass(-60, 60, { window: 'now' }), true);
			assert.equal(pass(60, 7200, { window: 'now' }), false);
		});
		it('soon: open or opening within the hours', () => {
			assert.equal(pass(-60, 60, { window: 'soon', soonHours: 2 }), true);
			assert.equal(pass(7200, 14400, { window: 'soon', soonHours: 2 }), true);
			assert.equal(pass(7201, 14400, { window: 'soon', soonHours: 2 }), false);
			assert.equal(pass(7201, 14400, { window: 'soon', soonHours: 4 }), true);
		});
		it('all: everything not over', () => {
			assert.equal(pass(86400, 90000, { window: 'all' }), true);
			assert.equal(pass(-100, -1, { window: 'all' }), false);
		});
	});

	describe('prefilter and sort', () => {
		const near = { 1: { jumps: 3 }, 2: { jumps: 4 }, 3: { jumps: 1 }, 4: { jumps: 2 } };
		const list = [sh(1, -60, 3600), sh(2, 600, 7800), sh(4, 100, 7300), sh(3, 0, 100), sh(1, 7200, 14400, 999), sh(2, 9000, 12000, 998)];
		const rows = (saved) => skyhooksPanel.sort(skyhooksPanel.prefilter(list, systemFor, T, S(saved)).map(s => ({ skyhook: s, nearest: near[s.systemID] || null })), S(saved).sort);

		it('filters by window and security, sorted by jumps', () => {
			// system 3 is high-sec but open: shown; planet 999 opens in 2 h: shown; 998 opens in 2.5 h: not
			assert.deepEqual(rows({}).map(x => x.skyhook.systemID), [3, 4, 1, 1, 2]);
		});
		it('security checkboxes', () => assert.deepEqual(rows({ low: false }).map(x => x.skyhook.systemID), [3, 4, 2]));
		it('window now', () => assert.deepEqual(rows({ window: 'now' }).map(x => x.skyhook.systemID), [3, 1]));
		it('sort by window start, then jumps', () => assert.deepEqual(rows({ sort: 'start' }).map(x => x.skyhook.start - T), [-60, 0, 100, 600, 7200]));
		it('unknown jumps sort last', () => {
			const r = skyhooksPanel.sort([{ skyhook: sh(1, 0, 10), nearest: null }, { skyhook: sh(2, 0, 10), nearest: { jumps: 9 } }], 'jumps');
			assert.deepEqual(r.map(x => x.skyhook.systemID), [2, 1]);
		});
		it('garbage input', () => assert.deepEqual(skyhooksPanel.prefilter(null, systemFor, T, S({})), []));
		it('does not mutate its input', () => {
			const copy = JSON.stringify(list);
			rows({ sort: 'start' });
			assert.equal(JSON.stringify(list), copy);
		});
	});

	describe('distances (multi-source search)', () => {
		const O = 30000000;
		// 1-2-3-4 chain, 5-3 branch, 9 isolated
		const g = { 1: { 2: 0 }, 2: { 1: 0, 3: 0 }, 3: { 2: 0, 4: 0, 5: 0 }, 4: { 3: 0 }, 5: { 3: 0 }, 9: {} };
		const unit = () => 1;
		const d = (exits, limit, fn) => skyhooksPanel.distances(g, exits.map(e => e + O), limit, fn || unit);

		it('single exit', () => {
			const r = d([1], 10);
			assert.deepEqual([1, 2, 3, 4, 5].map(i => r[i + O].jumps), [0, 1, 2, 3, 3]);
			assert.equal(r[9 + O], undefined);
		});
		it('nearest of several exits, and which one', () => {
			const r = d([1, 4], 10);
			assert.deepEqual([1, 2, 3, 4, 5].map(i => r[i + O].jumps), [0, 1, 1, 0, 2]);
			assert.equal(r[2 + O].exitID, 1 + O);
			assert.equal(r[3 + O].exitID, 4 + O);
			assert.equal(r[5 + O].exitID, 4 + O);
		});
		it('limit stops the search', () => {
			const r = d([1], 2);
			assert.deepEqual(Object.keys(r).map(k => k - O).sort(), ['1', '2', '3']);
		});
		it('unknown or duplicate exits are ignored', () => {
			assert.deepEqual(Object.keys(d([77, 1, 1], 10)).length, 5);
			assert.deepEqual(d([], 10), {});
			assert.deepEqual(skyhooksPanel.distances(null, [1 + O], 5, unit), {});
		});
		it('closed gates (cost <= 0) are not used', () => {
			const r = d([1], 10, (a, b) => (a === 2 && b === 3) ? 0 : 1);
			assert.deepEqual(Object.keys(r).map(k => k - O).sort(), ['1', '2']);
		});
		it('a penalised hop is avoided when there is another way, jumps still count hops', () => {
			// 1-2-4 (2 hops, 4 is costly) vs 1-3-5-4 ... build a diamond: 1-2-4 and 1-3-5-4
			const m = { 1: { 2: 0, 3: 0 }, 2: { 1: 0, 4: 0 }, 3: { 1: 0, 5: 0 }, 4: { 2: 0, 5: 0 }, 5: { 3: 0, 4: 0 } };
			const r = skyhooksPanel.distances(m, [1 + O], 200, (a, b) => b === 2 ? 101 : 1);
			assert.equal(r[4 + O].jumps, 3);   // via 3 and 5: cost 3, not via 2: cost 102
			assert.equal(r[2 + O].jumps, 1);
		});

		it('map costs count like guidance (1 + map cost)', () => {
			const m = { 1: { 2: 5, 3: 0 }, 2: { 1: 5, 4: 0 }, 3: { 1: 0, 4: 9 }, 4: { 2: 0, 3: 9 } };
			const r = skyhooksPanel.distances(m, [1 + O], 200, (a, b, base) => base);
			// 1-2-4 costs (1+5)+(1+0)=7, 1-3-4 costs 1+(1+9)=11
			assert.equal(r[4 + O].jumps, 2);
			assert.equal(r[4 + O].exitID, 1 + O);
			const seen = [];
			skyhooksPanel.distances(m, [1 + O], 200, (a, b, base) => { seen.push([a, b, base]); return base; });
			assert.deepEqual(seen.filter(x => x[0] === 1), [[1, 2, 6], [1, 3, 1]]);
		});

		describe('same answers as guidance.findShortestPath', () => {
			let savedOptions;
			before(() => { savedOptions = global.options; });
			after(() => { global.options = savedOptions; guidance.clearCache(); });
			const sid = name => Number(Object.keys(appData.systems).find(k => appData.systems[k].name === name));
			const names = ['Perimeter', 'Rens', 'Amarr', 'Dodixie', 'Hek', 'Tama', 'Kedama', 'Aunenen', 'Heydieles'];
			const check = routeSecurity => {
				global.options = { chain: { routeIgnore: { enabled: true, systems: ['Niarja'] }, routeSecurity: routeSecurity } };
				guidance.clearCache();
				const exits = ['Jita', 'Tama'].map(sid);
				const limit = 25;
				const costFn = (from, to, base) => base + skyhooksPanel.entryPenalty(systemAnalysis.analyse(O + to), options.chain);
				const r = skyhooksPanel.distances(appData.map.shortest, exits, limit, costFn);
				names.map(sid).forEach(target => {
					let best = null;
					exits.forEach(e => {
						const p = guidance.findShortestPath(appData.map.shortest, e - O, target - O, limit);
						if (p && p.length && (!best || p.length - 1 < best)) { best = p.length - 1; }
					});
					const got = r[target] ? r[target].jumps : null;
					// the nearest exit by cost can differ from the fewest hops only when a penalty is involved
					if (routeSecurity === 'shortest') { assert.equal(got, best, appData.systems[target].name); }
					else if (got !== null && best !== null) { assert.ok(Math.abs(got - best) <= 3, appData.systems[target].name + ' ' + got + ' vs ' + best); }
				});
				assert.ok(Object.keys(r).length > 100);
			};
			const O = 30000000;
			it('shortest', () => check('shortest'));
			it('high-sec only', () => check('highsec'));
			it('avoid null', () => check('avoid-null'));
		});

		describe('entry penalty', () => {
			const hs = { name: 'A', security: 0.9 }, ls = { name: 'B', security: 0.3 }, ns = { name: 'C', security: -0.2 };
			it('shortest: none', () => assert.equal(skyhooksPanel.entryPenalty(ls, { routeSecurity: 'shortest' }), 0));
			it('high-sec only penalises low and null', () => {
				assert.deepEqual([hs, ls, ns].map(x => skyhooksPanel.entryPenalty(x, { routeSecurity: 'highsec' })), [0, 100, 100]);
			});
			it('avoid high-sec', () => assert.equal(skyhooksPanel.entryPenalty(hs, { routeSecurity: 'avoid-high' }), 100));
			it('avoid null', () => assert.deepEqual([hs, ls, ns].map(x => skyhooksPanel.entryPenalty(x, { routeSecurity: 'avoid-null' })), [0, 0, 100]));
			it('avoid list and Zarzakh', () => {
				assert.equal(skyhooksPanel.entryPenalty(ls, { routeIgnore: { enabled: true, systems: ['B'] } }), 100);
				assert.equal(skyhooksPanel.entryPenalty(ls, { routeIgnore: { enabled: false, systems: ['B'] } }), 0);
				assert.equal(skyhooksPanel.entryPenalty({ name: 'Zarzakh', security: -1 }, {}), 100);
			});
			it('unknown system or options', () => {
				assert.equal(skyhooksPanel.entryPenalty(null, {}), 0);
				assert.equal(skyhooksPanel.entryPenalty(ls, undefined), 0);
			});
		});
	});

	describe('chain map icon', () => {
		const sys = { 10: { name: 'Tama', security: 0.28, regionID: 10000033 }, 11: { name: 'Jita', security: 0.95, regionID: 10000002 },
			12: { name: 'Null', security: -0.4, regionID: 10000012 }, 13: { name: 'J123', security: -0.99, regionID: 11000001, class: [3] },
			14: { name: 'Zarzakh', security: -1, regionID: 10000070 }, 15: { name: 'Pochven', security: -0.4, regionID: 10000070, factionID: 500026 }, 16: {} };
		const row = (v, systemID, f, extra) => Object.assign({ c: [{ v: v, systemID: systemID, f: f || "<div class='node'><div class='nodeIcons'></div></div>" }, { v: null }] }, extra || {});
		it('low-sec and null-sec systems', () => {
			assert.equal(skyhooksPanel.isLowNull(10, sys[10]), true);
			assert.equal(skyhooksPanel.isLowNull(12, sys[12]), true);
		});
		it('not high-sec, w-space, Zarzakh, Pochven or unknown', () => {
			[11, 13, 14, 15, 16].forEach(id => assert.equal(skyhooksPanel.isLowNull(id, sys[id]), false, String(id)));
			assert.equal(skyhooksPanel.isLowNull(99, null), false);
			assert.equal(skyhooksPanel.isLowNull(0, sys[10]), false);
		});
		it('icon carries the system and an escaped title', () => {
			const h = skyhooksPanel.iconHtml(10, "<b>\"x\"</b>");
			assert.ok(h.indexOf("data-sky-system='10'") > 0);
			assert.ok(h.indexOf("<b>") < 0);
		});
		it('inserted before the icon row, once', () => {
			const html = "<div class='node'><div class='nodeIcons'></div></div>";
			const once = skyhooksPanel.insertIcon(html, skyhooksPanel.iconHtml(10, 'Tama'));
			assert.ok(once.indexOf("sky-icon") < once.indexOf("nodeIcons"));
			assert.equal(skyhooksPanel.insertIcon(once, skyhooksPanel.iconHtml(10, 'Tama')), once);
			assert.equal(skyhooksPanel.insertIcon("<div></div>", "x"), "<div></div>");
		});
		it('decorate: only real low/null-sec rows, each id reported once', () => {
			const result = { map: { rows: [row('a', 10), row('b', 11), row('c', 12), row('d', 10), row('dest-1', 12), row('e', 12, null, { destination: {} }),
				row('f', 12, null, { pathHome: [{ path: [1] }] }), row('g', 13)] } };
			const ids = skyhooksPanel.decorate(result, sys);
			assert.deepEqual(ids, [10, 12]);
			assert.deepEqual(result.map.rows.map(r => r.c[0].f.indexOf('sky-icon') >= 0), [true, false, true, true, false, false, false, false]);
		});
		it('decorate survives garbage', () => {
			assert.deepEqual(skyhooksPanel.decorate(null, sys), []);
			assert.deepEqual(skyhooksPanel.decorate({ map: { rows: [null, {}, { c: [] }] } }, sys), []);
		});
	});

	it('escapes', () => assert.equal(skyhooksPanel.escape('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'));

	describe('planet: lava / ice / other and value', () => {
		// [kind (1 lava, 2 ice), reagent units per hour, planet number]
		const planets = {
			reagents: { 1: { name: 'Magmatic Gas', price: 2000 }, 2: { name: 'Superionic Ice', price: 5000 } },
			lavaCuts: [900000, 1100000, 1300000],	// raidable ISK/h quartile cut points
			planets: { 100: [1, 1000, 4], 101: [2, 40, 9], 102: [1, 700, 12] }
		};
		const info = (id, name) => skyhooksPanel.planetInfo(planets, id, name);

		it('roman numerals', () => {
			assert.equal(skyhooksPanel.roman(4), 'IV');
			assert.equal(skyhooksPanel.roman(9), 'IX');
			assert.equal(skyhooksPanel.roman(12), 'XII');
			assert.equal(skyhooksPanel.roman(0), '');
			assert.equal(skyhooksPanel.roman('x'), '');
		});
		it('lava planet: name, reagent, yield and value', () => {
			assert.deepEqual(info(100, 'K4YZ-Y'), { kind: 'lava', name: 'K4YZ-Y IV', number: 'IV', reagent: 'Magmatic Gas', perHour: 1000, isk: 2000000, cuts: [900000, 1100000, 1300000] });
		});
		it('ice planet', () => {
			const i = info(101, 'Tama');
			assert.equal(i.kind, 'ice');
			assert.equal(i.name, 'Tama IX');
			assert.equal(i.isk, 200000);
		});
		it('no system name: no planet name', () => assert.equal(info(100).name, ''));
		it('a planet that is not in the list is unknown', () => assert.deepEqual(info(999, 'X'), { kind: 'unknown', name: '', number: '', reagent: '', perHour: 0, isk: 0, cuts: null }));
		it('data not loaded: unknown', () => {
			assert.equal(skyhooksPanel.planetInfo(null, 100, 'X').kind, 'unknown');
			assert.equal(skyhooksPanel.planetInfo({}, 100, 'X').kind, 'unknown');
		});
		it('damaged entries are unknown', () => assert.equal(skyhooksPanel.planetInfo({ reagents: {}, planets: { 5: [1, 3, 1] } }, 5, 'X').kind, 'unknown'));
		it('checkboxes: lava and ice on by default', () => {
			assert.equal(skyhooksPanel.planetPasses('lava', S({})), true);
			assert.equal(skyhooksPanel.planetPasses('ice', S({})), true);
			assert.equal(skyhooksPanel.planetPasses('lava', S({ lava: false })), false);
			assert.equal(skyhooksPanel.planetPasses('ice', S({ ice: false })), false);
		});
		it('unknown planet kind is never hidden (list not loaded yet)', () => assert.equal(skyhooksPanel.planetPasses('unknown', S({ lava: false, ice: false })), true));
		describe('value rating', () => {
			// raidable ISK/h = perHour x price / 2: 1000 -> 1,000,000 ; cuts 900k / 1.1M / 1.3M
			const lava = perHour => skyhooksPanel.planetInfo({ reagents: planets.reagents, lavaCuts: planets.lavaCuts, planets: { 1: [1, perHour, 1] } }, 1, 'X');
			it('ice is always 1', () => assert.equal(skyhooksPanel.valueRating(info(101, 'X')), 1));
			it('lava 2 to 5 by the cut points (not below a cut = next rating)', () => {
				assert.equal(skyhooksPanel.valueRating(lava(800)), 2);
				assert.equal(skyhooksPanel.valueRating(lava(1000)), 3);
				assert.equal(skyhooksPanel.valueRating(lava(1200)), 4);
				assert.equal(skyhooksPanel.valueRating(lava(1400)), 5);
			});
			it('exactly on a cut point rounds up', () => assert.equal(skyhooksPanel.valueRating(lava(900)), 3));
			it('unknown planet: no rating', () => {
				assert.equal(skyhooksPanel.valueRating(info(999, 'X')), 0);
				assert.equal(skyhooksPanel.valueRating(null), 0);
			});
			it('lava without cut points: no rating', () => assert.equal(skyhooksPanel.valueRating({ kind: 'lava', isk: 1e6, cuts: null }), 0));
			it('same rating whichever hooks are live (depends on the planet only)', () => assert.equal(skyhooksPanel.valueRating(info(100, 'A')), skyhooksPanel.valueRating(info(100, 'B'))));
			it('rating text: earned and dimmed dollar signs, always 5', () => {
				assert.equal(skyhooksPanel.ratingHtml(4), "<b class='sky-dollar-on'>$$$$</b><b class='sky-dollar-off'>$</b>");
				assert.equal(skyhooksPanel.ratingHtml(5), "<b class='sky-dollar-on'>$$$$$</b><b class='sky-dollar-off'></b>");
				assert.equal(skyhooksPanel.ratingHtml(1), "<b class='sky-dollar-on'>$</b><b class='sky-dollar-off'>$$$$</b>");
				assert.equal(skyhooksPanel.ratingHtml(0), '');
				assert.equal(skyhooksPanel.ratingHtml(9), skyhooksPanel.ratingHtml(5));
			});
		});
		it('formatIsk', () => {
			assert.equal(skyhooksPanel.formatIsk(2100000), '2.1M');
			assert.equal(skyhooksPanel.formatIsk(177000), '177k');
			assert.equal(skyhooksPanel.formatIsk(950), '950');
			assert.equal(skyhooksPanel.formatIsk(1.5e9), '1.5B');
			assert.equal(skyhooksPanel.formatIsk('x'), '0');
		});

		describe('prefilter by planet, sort by value', () => {
			const near = { 1: { jumps: 3 }, 2: { jumps: 1 }, 4: { jumps: 2 } };
			const list = [sh(1, 0, 3600, 100), sh(2, 0, 3600, 101), sh(4, 0, 3600, 102), sh(1, 0, 3600, 999)];
			const sys = id => Object.assign({ name: 'S' + id }, systems[id]);
			const rows = (saved, p) => skyhooksPanel.sort(skyhooksPanel.prefilter(list, sys, T, S(saved), p === undefined ? planets : p).map(s => ({
				skyhook: s, nearest: near[s.systemID], planet: skyhooksPanel.planetInfo(p === undefined ? planets : p, s.planetID, sys(s.systemID).name)
			})), S(saved).sort);

			it('default: lava, ice and planets the list does not know', () => {
				assert.deepEqual(rows({}).map(r => r.skyhook.planetID), [101, 102, 100, 999]);
			});
			it('lava off (unknown planets stay)', () => assert.deepEqual(rows({ lava: false }).map(r => r.skyhook.planetID), [101, 999]));
			it('ice off', () => assert.deepEqual(rows({ ice: false }).map(r => r.skyhook.planetID), [102, 100, 999]));
			it('both off: only unknown planets are left', () => assert.deepEqual(rows({ lava: false, ice: false }).map(r => r.skyhook.planetID), [999]));
			it('planet data not loaded: no planet filter', () => assert.equal(rows({ lava: false, ice: false }, null).length, 4));
			it('sort by value: highest ISK first, then jumps', () => {
				assert.deepEqual(rows({ sort: 'value' }).map(r => r.skyhook.planetID), [100, 102, 101, 999]);
			});
			it('value sort needs no planet data (ties by jumps)', () => {
				assert.deepEqual(rows({ sort: 'value' }, null).map(r => r.skyhook.planetID), [101, 102, 100, 999]);
			});
		});
	});
});
