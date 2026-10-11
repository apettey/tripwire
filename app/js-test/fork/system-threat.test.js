const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/system-threat');

describe('System threat', () => {
	const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);	// 2026-10-10 12:00 UTC
	const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
	const ctx = { nowMs: NOW, retentionSeconds: 172800, localSinceMs: NOW - 3 * 86400000 };	// stream complete for the retention
	const months = [
		{ year: 2026, month: 10, kills: 100 },	// 9.5 days so far
		{ year: 2026, month: 9, kills: 300 },
		{ year: 2026, month: 8, kills: 310 },
		{ year: 2026, month: 7, kills: 620 }
	];

	describe('levelForRate', () => {
		it('no kills is 0', () => { assert.equal(systemThreat.levelForRate(0), 0); assert.equal(systemThreat.levelForRate(NaN), 0); });
		it('a kill or three a week is low', () => { assert.equal(systemThreat.levelForRate(1 / 7), 1); assert.equal(systemThreat.levelForRate(3 / 7), 1); });
		it('one a day is moderate', () => assert.equal(systemThreat.levelForRate(1), 2));
		it('a few a day is high', () => assert.equal(systemThreat.levelForRate(5), 3));
		it('dozens a day is extreme', () => { assert.equal(systemThreat.levelForRate(6), 4); assert.equal(systemThreat.levelForRate(200), 4); });
	});

	describe('estimateFromMonths', () => {
		it('null without months', () => { assert.strictEqual(systemThreat.estimateFromMonths([], NOW, 30), null); assert.strictEqual(systemThreat.estimateFromMonths(null, NOW, 30), null); });
		it('30 days: the current month so far plus the matching share of the previous one', () => {
			// window starts 2026-09-10 12:00: 20.5 of September's 30 days are inside
			assert.equal(systemThreat.estimateFromMonths(months, NOW, 30), Math.round(100 + 300 * 20.5 / 30));
		});
		it('90 days reaches into July', () => {
			// window starts 2026-07-12 12:00: 19.5 of July's 31 days are inside
			assert.equal(systemThreat.estimateFromMonths(months, NOW, 90), Math.round(100 + 300 + 310 + 620 * 19.5 / 31));
		});
		it('order of months does not matter', () => assert.equal(systemThreat.estimateFromMonths(months.slice().reverse(), NOW, 90), systemThreat.estimateFromMonths(months, NOW, 90)));
	});

	describe('summarize', () => {
		const entry = (stats, local, extra) => Object.assign({ stats: stats, pending: false, fetchedAt: iso(NOW - 3600000),
			local: Object.assign({ kills1h: 0, kills24h: 0, killsWindow: 0, lastKill: null }, local) }, extra);

		it('uses zKillboard\'s 7-day count when there are stats', () => {
			const s = systemThreat.summarize(entry({ kills7d: 21, months: months }, { kills24h: 2, killsWindow: 4 }), ctx);
			assert.equal(s.source, 'zkillboard');
			assert.equal(s.count, 21);
			assert.equal(s.basis, '7 days');
			assert.equal(s.level, 3);	// 3 a day
			assert.equal(s.levelName, 'High');
			assert.equal(s.kills30d, systemThreat.estimateFromMonths(months, NOW, 30));
			assert.equal(s.kills24hPartial, false);
		});
		it('a busy last day raises the level over stale stats', () => {
			const s = systemThreat.summarize(entry({ kills7d: 0, months: [] }, { kills24h: 9, killsWindow: 9, kills1h: 1 }), ctx);
			assert.equal(s.level, 3);	// 9 in the last 24 h, damped to 3 a day (one gang can kill many at once)
			assert.equal(s.hot, true);
		});
		it('falls back to the stored kills of the retention window without stats', () => {
			const s = systemThreat.summarize(entry(null, { killsWindow: 4, kills24h: 3 }, { pending: true }), ctx);
			assert.equal(s.source, 'local');
			assert.equal(s.count, 4);
			assert.equal(s.basis, '48 h');
			assert.equal(s.level, 3);	// 2 a day
			assert.equal(s.pending, true);
		});
		it('only covers as far back as the stream has every kill', () => {
			const s = systemThreat.summarize(entry(null, { killsWindow: 2 }), Object.assign({}, ctx, { localSinceMs: NOW - 6 * 3600000 }));
			assert.equal(s.basis, '6 h');
			assert.equal(s.level, 4);	// 8 a day
			assert.equal(s.kills24hPartial, true);
		});
		it('unknown without stats or local coverage', () => {
			const s = systemThreat.summarize(entry(null, {}, { pending: true }), Object.assign({}, ctx, { localSinceMs: null }));
			assert.strictEqual(s.level, null);
			assert.strictEqual(s.count, null);
			assert.strictEqual(s.kills1h, null);
		});
		it('one kill this week: zKillboard leaves the count out, the stored kills fill it in', () => {
			const s = systemThreat.summarize(entry({ kills7d: 0, months: [] }, { killsWindow: 1, kills24h: 0 }), ctx);
			assert.equal(s.count, 1);
			assert.equal(s.kills7d, 1);
			assert.equal(s.level, 1);
			assert.equal(s.levelName, 'Low');
		});
		it('stale stats: newer stored kills raise the 7-day count', () => {
			const s = systemThreat.summarize(entry({ kills7d: 5, months: [] }, { killsWindow: 12, kills24h: 0 }), ctx);
			assert.equal(s.count, 12);
			assert.equal(s.level, 2);	// 12 / 7 a day
		});
		it('stored kills are not used for the 7-day count when they do not cover the whole window', () => {
			const partial = Object.assign({}, ctx, { localSinceMs: NOW - 6 * 3600000 });
			assert.equal(systemThreat.summarize(entry({ kills7d: 0, months: [] }, { killsWindow: 1 }), partial).count, 0);
			const longRetention = Object.assign({}, ctx, { retentionSeconds: 8 * 86400, localSinceMs: NOW - 9 * 86400000 });
			assert.equal(systemThreat.summarize(entry({ kills7d: 0, months: [] }, { killsWindow: 3 }), longRetention).count, 0);
		});
		it('quiet system is level 0',() => assert.equal(systemThreat.summarize(entry({ kills7d: 0, months: [] }, {}), ctx).level, 0));
	});

	describe('badgeHtml', () => {
		const summary = (over) => Object.assign({ level: 2, levelName: 'Moderate', count: 1234, basis: '7 days', source: 'zkillboard',
			kills1h: 0, kills24h: 1, kills24hPartial: false, kills7d: 1234, kills30d: null, kills90d: null, hot: false, pending: false,
			lastKillMs: NOW - 7200000, fetchedAtMs: NOW - 60000 }, over);
		it('shows the count with the level class and a tooltip', () => {
			const html = systemThreat.badgeHtml(summary(), NOW);
			assert.ok(html.indexOf("class='threat-badge threat-2'") >= 0, html);
			assert.ok(html.indexOf('>1.2k</span>') >= 0, html);
			assert.ok(html.indexOf('Threat: Moderate (1234 kills in 7 days)') >= 0, html);
			assert.ok(html.indexOf('Last kill 2h ago') >= 0, html);
		});
		it('marks a kill in the last hour', () => assert.ok(systemThreat.badgeHtml(summary({ hot: true }), NOW).indexOf('threat-hot') >= 0));
		it('pending placeholder while unknown', () => assert.ok(systemThreat.badgeHtml(summary({ level: null, count: null, pending: true }), NOW).indexOf('threat-pending') >= 0));
		it('nothing when unknown and not pending', () => assert.equal(systemThreat.badgeHtml(summary({ level: null, count: null }), NOW), ''));
		it('escapes the tooltip', () => assert.ok(systemThreat.badgeHtml(summary({ basis: "<b>'x'" }), NOW).indexOf('<b>') < 0));
	});

	describe('formatCount', () => {
		it('formats', () => assert.deepEqual([0, 12, 999, 1000, 1574, 9999, 15000].map(systemThreat.formatCount), ['0', '12', '999', '1k', '1.6k', '10k', '15k']));
	});

	describe('chain nodes', () => {
		const systems = { 31002479: { name: 'J100820' }, 30002537: { name: 'Amamake' } };
		const nodeHtml = id => "<div id='node1' data-nodeid='" + id + "' class='node '><div class='nodeIcons'><div style='float: left;'></div>"
			+ "<div style='float: right;'><i data-icon='user' class='invisible'></i></div></div><h4 class='nodeClass'>C5</h4></div>";
		const result = () => ({ map: { rows: [
			{ c: [{ v: 1, systemID: 31002479, f: nodeHtml(31002479) }, { v: null }] },
			{ c: [{ v: 2, systemID: 30002537, f: nodeHtml(30002537) }, { v: 1 }] },
			{ c: [{ v: 3, systemID: 2, f: nodeHtml(2) }, { v: 1 }] },	// unknown destination (generic system type)
			{ c: [{ v: 4, systemID: 31002479, f: nodeHtml(31002479) }, { v: 2 }] },	// same system twice
			{ c: [{ v: 'dest-5', systemID: 30002537, f: "<div class='destination-node'></div>" }, { v: 2 }] }
		] }, lines: [] });

		it('lists real systems once, in order, without synthetic nodes', () => assert.deepEqual(systemThreat.chainSystems(result(), systems), [31002479, 30002537]));
		it('inserts the badge as the first child of the node', () => {
			const html = systemThreat.insertBadge(nodeHtml(31002479), "<span class='threat-badge'>3</span>");
			assert.ok(html.indexOf("class='node '><span class='threat-badge'>3</span><div class='nodeIcons'>") >= 0, html);
		});
		it('inserts once', () => {
			const once = systemThreat.insertBadge(nodeHtml(1), "<span class='threat-badge'>3</span>");
			assert.equal(systemThreat.insertBadge(once, "<span class='threat-badge'>4</span>"), once);
		});
		it('leaves unexpected markup alone', () => assert.equal(systemThreat.insertBadge('<div>x</div>', "<span class='threat-badge'>3</span>"), '<div>x</div>'));
		it('decorates real system nodes only', () => {
			const r = systemThreat.decorate(result(), systems, id => "<span class='threat-badge'>" + id + "</span>");
			const rows = r.map.rows;
			assert.ok(rows[0].c[0].f.indexOf('>31002479<') >= 0);
			assert.ok(rows[1].c[0].f.indexOf('>30002537<') >= 0);
			assert.ok(rows[2].c[0].f.indexOf('threat-badge') < 0);
			assert.ok(rows[4].c[0].f.indexOf('threat-badge') < 0);
		});
	});

	describe('residents', () => {
		const stats = {
			corporations: [
				{ id: 10, name: 'Roamers', ticker: 'ROAM', kills: 30 },
				{ id: 20, name: 'Home Corp', ticker: 'HOME', kills: 4 }
			],
			alliances: [{ id: 100, name: 'Roam Alliance', ticker: 'RA', kills: 30 }]
		};
		const detail = {
			corporations: [
				{ id: 20, kills: 1, losses: 2, iskLost: 5e8, lastSeen: NOW / 1000 - 600 },
				{ id: 30, kills: 0, losses: 1, iskLost: 1e7, lastSeen: NOW / 1000 - 60 },
				{ id: 40, kills: 0, losses: 4, iskLost: 4e7, lastSeen: NOW / 1000 - 6000 },
				{ id: 50, kills: 0, losses: 1, iskLost: 9e9, lastSeen: NOW / 1000 - 86400 }
			],
			alliances: [{ id: 200, kills: 0, losses: 3, iskLost: 1e9, lastSeen: NOW / 1000 - 600 }],
			structures: [{ killID: 9, typeID: 35832, time: iso(NOW - 3600000), corporationID: 50, allianceID: null, value: 9e9 }],
			names: { 30: 'Visitor Corp', 40: 'Miner Corp', 50: 'Evicted Corp', 200: 'Home Alliance' }
		};

		it('merges zKillboard top lists with stored kills and losses', () => {
			const r = systemThreat.residents(detail, stats, true);
			const home = r.corporations.find(e => e.id === 20);
			assert.equal(home.name, 'Home Corp');
			assert.equal(home.ticker, 'HOME');
			assert.deepEqual([home.kills7d, home.kills, home.losses], [4, 1, 2]);
			assert.equal(r.corporations.find(e => e.id === 30).name, 'Visitor Corp');
		});
		it('wormhole: flags corporations that both kill and lose, lose a lot, or lost a structure', () => {
			const r = systemThreat.residents(detail, stats, true);
			const flag = id => r.corporations.find(e => e.id === id).resident;
			assert.equal(flag(20), true);	// kills and losses
			assert.equal(flag(40), true);	// 4 losses
			assert.equal(flag(50), true);	// structure
			assert.equal(flag(10), false);	// only kills: roamers
			assert.equal(flag(30), false);	// one loss: a visitor
			assert.equal(r.corporations.find(e => e.id === 50).structureLost, true);
			assert.equal(r.alliances.find(e => e.id === 200).resident, true);	// 3 losses
		});
		it('k-space: only a structure loss flags a resident', () => {
			const r = systemThreat.residents(detail, stats, false);
			assert.deepEqual(r.corporations.filter(e => e.resident).map(e => e.id), [50]);
		});
		it('residents first, then by activity', () => {
			const r = systemThreat.residents(detail, stats, true);
			assert.deepEqual(r.corporations.map(e => e.id), [50, 20, 40, 10, 30]);
		});
		describe('NPC corporations', () => {
			const npcDetail = {
				corporations: [
					{ id: 1000182, kills: 2, losses: 4, iskLost: 1, lastSeen: NOW / 1000 },	// Tribal Liberation Force (militia)
					{ id: 1000125, kills: 0, losses: 1, iskLost: 1, lastSeen: NOW / 1000 },	// CONCORD-ish / Interbus customs offices
					{ id: 20, kills: 1, losses: 1, iskLost: 1, lastSeen: NOW / 1000 }
				],
				alliances: [],
				structures: [{ killID: 1, typeID: 2233, time: iso(NOW), corporationID: 1000125, allianceID: null, value: 1 }]
			};
			it('are never flagged as residents in k-space, but stay listed', () => {
				const r = systemThreat.residents(npcDetail, { corporations: [{ id: 1000182, name: 'Tribal Liberation Force', kills: 99 }] }, false);
				assert.deepEqual(r.corporations.map(e => e.id).sort((a, b) => a - b), [20, 1000125, 1000182]);
				assert.deepEqual(r.corporations.filter(e => e.resident).map(e => e.id), []);
			});
			it('are left out in wormholes', () => {
				const r = systemThreat.residents(npcDetail, null, true);
				assert.deepEqual(r.corporations.map(e => e.id), [20]);
				assert.equal(r.corporations[0].resident, true);
			});
			it('isNpcCorporation', () => {
				assert.equal(systemThreat.isNpcCorporation('corporation', 1000125), true);
				assert.equal(systemThreat.isNpcCorporation('corporation', 98000001), false);
				assert.equal(systemThreat.isNpcCorporation('alliance', 1000125), false);
			});
		});
		it('copes with missing data', () => {
			assert.deepEqual(systemThreat.residents(null, null, true), { corporations: [], alliances: [] });
			assert.equal(systemThreat.residents({ corporations: [{ id: 0 }, null] }, { corporations: [null] }, true).corporations.length, 0);
		});
	});

	describe('isLivedIn', () => {
		const systems = { 31002479: { class: 5 }, 31000005: { class: 12 }, 31000006: { class: 18 }, 31000001: { class: 13 }, 30002537: {} };
		it('C1-C6 and C13 wormholes', () => { assert.equal(systemThreat.isLivedIn(31002479, systems), true); assert.equal(systemThreat.isLivedIn(31000001, systems), true); });
		it('not Thera, drifter holes or k-space', () => [31000005, 31000006, 30002537, 12345].forEach(id => assert.equal(systemThreat.isLivedIn(id, systems), false)));
	});

	describe('infoHtml', () => {
		const response = {
			retentionSeconds: 172800, localSince: iso(NOW - 3 * 86400000),
			systems: { 31002479: { stats: { kills7d: 7, months: months, corporations: [{ id: 20, name: 'Home <Corp>', ticker: 'HOME', kills: 4 }], alliances: [] },
				fetchedAt: iso(NOW - 60000), pending: false, local: { kills1h: 0, kills24h: 1, killsWindow: 2, lastKill: iso(NOW - 3600000) } } },
			detail: { systemID: 31002479, corporations: [{ id: 20, kills: 1, losses: 1, iskLost: 1, lastSeen: NOW / 1000 }], alliances: [],
				structures: [{ killID: 9, typeID: 35832, time: iso(NOW - 7200000), corporationID: 20, allianceID: null, value: 1 }],
				names: { 35832: 'Astrahus', 20: 'Home <Corp>' }, namesPending: false }
		};
		const systems = { 31002479: { class: 5 } };

		it('renders the level, residents and structure losses, escaped', () => {
			const model = systemThreat.infoModel(response, NOW, systems);
			const html = systemThreat.infoHtml(model, NOW);
			assert.ok(html.indexOf("threat-level threat-2") >= 0, html);	// 1 a day
			assert.ok(html.indexOf('7 in 7 days') >= 0, html);
			assert.ok(html.indexOf('Home &lt;Corp&gt;') >= 0, html);
			assert.ok(html.indexOf('<Corp>') < 0, html);
			assert.ok(html.indexOf('structure lost') >= 0, html);
			assert.ok(html.indexOf('Structures lost (48 h)') >= 0, html);
			assert.ok(html.indexOf('Astrahus') >= 0 && html.indexOf('2h ago') >= 0, html);
			assert.ok(html.indexOf('https://zkillboard.com/kill/9/') >= 0, html);
		});
		it('loading state', () => assert.ok(systemThreat.infoHtml(null, NOW).indexOf('loading') >= 0));
		it('no model without detail', () => assert.strictEqual(systemThreat.infoModel({ systems: {} }, NOW, systems), null));
		describe('collapsible section', () => {
			const model = () => systemThreat.infoModel(response, NOW, systems);
			const set = { entities: [{ kind: 'corporation', id: 20, name: 'Home <Corp>', ticker: 'H<M' }, { kind: 'alliance', id: 99, name: "All'y", ticker: 'AL' }],
				note: 'Lowsec static <script>x</script>', setBy: 'Pilot <b>', setAt: NOW / 1000 - 3 * 86400 };
			it('collapsed: header with level and count only, no body', () => {
				const html = systemThreat.sectionHtml(model(), NOW, { collapsed: true, canSet: true });
				assert.ok(html.indexOf("aria-expanded='false'") >= 0, html);
				assert.ok(html.indexOf('threat-level threat-2') >= 0 && html.indexOf('7 in 7 days') >= 0, html);
				assert.ok(html.indexOf('threat-body') < 0 && html.indexOf('Active here') < 0, html);
				assert.ok(html.indexOf('Set residents') >= 0, html);
			});
			it('expanded: header and the active list', () => {
				const html = systemThreat.sectionHtml(model(), NOW, { collapsed: false, canSet: true });
				assert.ok(html.indexOf("aria-expanded='true'") >= 0, html);
				assert.ok(html.indexOf('Active here') >= 0 && html.indexOf('threat-body') >= 0, html);
				assert.ok(html.indexOf('show activity') < 0, html);
			});
			it('no Set residents button unless allowed', () => assert.ok(systemThreat.sectionHtml(model(), NOW, {}).indexOf('threat-set-residents') < 0));
			it('loading header without a model', () => assert.ok(systemThreat.sectionHtml(null, NOW, { canSet: true }).indexOf('loading') >= 0));
			it('residents set by hand replace the active list, escaped', () => {
				const html = systemThreat.sectionHtml(model(), NOW, { residents: set, canSet: true });
				assert.ok(html.indexOf('>Residents<') >= 0, html);
				assert.ok(html.indexOf('Active here') < 0, html);
				assert.ok(html.indexOf('Home &lt;Corp&gt;') >= 0 && html.indexOf('[H&lt;M]') >= 0 && html.indexOf('All&#39;y') >= 0, html);
				assert.ok(html.indexOf('<script>') < 0 && html.indexOf('Lowsec static &lt;script&gt;') >= 0, html);
				assert.ok(html.indexOf('set by Pilot &lt;b&gt;, 3d ago') >= 0, html);
				assert.ok(html.indexOf('https://zkillboard.com/alliance/99/') >= 0 && html.indexOf('alliances/99/logo') >= 0, html);
				assert.ok(html.indexOf('show activity') >= 0 && html.indexOf('Edit residents') >= 0, html);
				assert.ok(html.indexOf('threat-level threat-2') >= 0, html);	// the threat level stays
			});
			it('show activity reveals the detected list below the residents', () => {
				const html = systemThreat.sectionHtml(model(), NOW, { residents: set, showActivity: true });
				assert.ok(html.indexOf('hide activity') >= 0 && html.indexOf('Active here') > html.indexOf('>Residents<'), html);
			});
			it('an empty set counts as nothing set', () => {
				const html = systemThreat.sectionHtml(model(), NOW, { residents: { entities: [] }, canSet: true });
				assert.ok(html.indexOf('Active here') >= 0 && html.indexOf('Set residents') >= 0, html);
			});
		});

		describe('Set residents dialog', () => {
			const model = () => systemThreat.infoModel(response, NOW, systems);
			it('quick picks: likely residents are ticked when nothing is set', () => {
				const picks = systemThreat.quickPicks(model(), null);
				assert.deepStrictEqual(picks.map(p => [p.kind, p.id, p.checked]), [['corporation', 20, true]]);
			});
			it('quick picks: what is set is ticked (and listed first), others not', () => {
				const picks = systemThreat.quickPicks(model(), { entities: [{ kind: 'alliance', id: 7, name: 'Far', ticker: 'F' }] });
				assert.deepStrictEqual(picks.map(p => [p.kind, p.id, p.checked]), [['alliance', 7, true], ['corporation', 20, false]]);
			});
			it('quick picks: each once', () => {
				const picks = systemThreat.quickPicks(model(), { entities: [{ kind: 'corporation', id: 20, name: 'Home', ticker: 'HOME' }] });
				assert.deepStrictEqual(picks.map(p => [p.kind, p.id, p.checked]), [['corporation', 20, true]]);
			});
			it('quick picks without data', () => assert.deepStrictEqual(systemThreat.quickPicks(null, null), []));
			it('parses typed names', () => assert.deepStrictEqual(systemThreat.parseNames(' Foo  Corp , bar,,foo corp' + String.fromCharCode(10) + 'Baz '), ['Foo Corp', 'bar', 'Baz']));
			it('dialog markup is escaped', () => {
				const html = systemThreat.dialogHtml([{ kind: 'corporation', id: 5, name: '<i>x</i>', ticker: "'T", checked: true, resident: true }], { note: "<b>'n'" });
				assert.ok(html.indexOf('<i>') < 0 && html.indexOf('&lt;i&gt;x') >= 0, html);
				assert.ok(html.indexOf("value='&lt;b&gt;&#39;n&#39;'") >= 0, html);
				assert.ok(html.indexOf("data-kind='corporation' data-id='5' checked") >= 0, html);
			});
		});
	});

	describe('settings', () => {
		it('on unless switched off', () => {
			assert.equal(systemThreat.enabled(undefined), true);
			assert.equal(systemThreat.enabled({}), true);
			assert.equal(systemThreat.enabled({ systemThreat: { enabled: true } }), true);
			assert.equal(systemThreat.enabled({ systemThreat: { enabled: false } }), false);
			assert.equal(systemThreat.residentsEnabled({}), true);
			assert.equal(systemThreat.residentsEnabled({ systemResidents: { enabled: false } }), false);
			assert.equal(systemThreat.residentsEnabled({ systemThreat: { enabled: false } }), true);
		});
	});
});
