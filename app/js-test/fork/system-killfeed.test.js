const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/system-killfeed');

describe('System kill feed', () => {
	const skf = () => systemKillFeed;

	const response = (over) => Object.assign({
		pastSeconds: 172800,
		feed: { enabled: true, live: true, coveredSince: '2026-10-10T09:00:00Z' },
		pending: false,
		namesPending: false,
		kills: [{
			killID: 139046138, systemID: 30000142, killTime: '2026-10-10T09:41:57Z',
			victim: { characterID: 2116087385, corporationID: 98754582, allianceID: 1900696668, shipTypeID: 22444 },
			finalBlow: { characterID: 2115904532, corporationID: 98585301, allianceID: 99013481, shipTypeID: 29988 },
			attackerCount: 11, attackerTotal: 11, totalValue: 547378185.22, npc: false, solo: false, awox: false
		}],
		names: { '2116087385': 'Nevxy Kawan', '98754582': 'Baba Yagas', '1900696668': 'The Initiative.', '22444': 'Sleipnir',
			'2115904532': 'kimchi Ham', '98585301': 'Guerrilla Gardening', '99013481': 'Honkai Star Rail.', '29988': 'Proteus' }
	}, over || {});

	describe('enabled', () => {
		it('is on unless explicitly false', () => {
			assert.equal(skf().enabled(undefined), true);
			assert.equal(skf().enabled({}), true);
			assert.equal(skf().enabled({ systemKillFeed: {} }), true);
			assert.equal(skf().enabled({ systemKillFeed: { enabled: true } }), true);
			assert.equal(skf().enabled({ systemKillFeed: { enabled: false } }), false);
		});
	});

	describe('formatting', () => {
		it('formats ISK', () => {
			assert.equal(skf().formatISK(547378185.22), '547.4M');
			assert.equal(skf().formatISK(1.44e9), '1.44B');
			assert.equal(skf().formatISK(15101), '15K');
			assert.equal(skf().formatISK(900), '900');
			assert.equal(skf().formatISK(0), '');
			assert.equal(skf().formatISK('x'), '');
		});
		it('formats time ago', () => {
			const now = Date.parse('2026-10-10T10:00:00Z');
			assert.equal(skf().timeAgo(now - 5000, now), 'now');
			assert.equal(skf().timeAgo(now - 45000, now), '45s');
			assert.equal(skf().timeAgo(now - 12 * 60000, now), '12m');
			assert.equal(skf().timeAgo(now - 3 * 3600000, now), '3h');
			assert.equal(skf().timeAgo(now - 2 * 86400000, now), '2d');
			assert.equal(skf().timeAgo(now + 60000, now), 'now');
			assert.equal(skf().timeAgo(NaN, now), '');
		});
		it('formats EVE time', () => {
			assert.equal(skf().eveTime(Date.parse('2026-10-10T09:41:57Z')), '2026-10-10 09:41:57');
		});
		it('formats the window', () => {
			assert.equal(skf().formatWindow(172800), '48 hours');
			assert.equal(skf().formatWindow(3600), '1 hour');
			assert.equal(skf().formatWindow(259200), '3 days');
			assert.equal(skf().formatWindow(1800), '30 minutes');
		});
		it('builds image URLs only for valid IDs', () => {
			assert.equal(skf().imageURL('type', 22444, 64), 'https://images.evetech.net/types/22444/icon?size=64');
			assert.equal(skf().imageURL('corporations', 98754582, 64), 'https://images.evetech.net/corporations/98754582/logo?size=64');
			assert.equal(skf().imageURL('corporations', null, 64), '');
			assert.equal(skf().imageURL('type', 'x', 64), '');
		});
	});

	describe('buildRows', () => {
		it('maps a kill with names', () => {
			const [row] = skf().buildRows(response());
			assert.equal(row.killID, 139046138);
			assert.equal(row.url, 'https://zkillboard.com/kill/139046138/');
			assert.equal(row.victimName, 'Nevxy Kawan');
			assert.equal(row.shipName, 'Sleipnir');
			assert.equal(row.victimCorporationName, 'Baba Yagas');
			assert.equal(row.victimAllianceName, 'The Initiative.');
			assert.equal(row.finalBlowCorporationID, 98585301);
			assert.equal(row.finalBlowCorporationName, 'Guerrilla Gardening');
			assert.equal(row.finalBlowName, 'kimchi Ham');
			assert.equal(row.pilots, 11);
			assert.equal(row.npc, false);
			assert.equal(row.value, '547.4M');
			assert.equal(row.time, Date.parse('2026-10-10T09:41:57Z'));
		});
		it('names losses without a pilot (structures) by their type', () => {
			const r = response();
			r.kills[0].victim.characterID = null;
			r.names['22444'] = 'Astrahus';
			const [row] = skf().buildRows(r);
			assert.equal(row.victimName, 'Astrahus');
			assert.equal(row.victimIsPilot, false);
		});
		it('shows a placeholder, not the ship, while the pilot name is pending', () => {
			const [row] = skf().buildRows(response({ names: { '22444': 'Sleipnir' }, namesPending: true }));
			assert.equal(row.victimName, '…');
			const [row2] = skf().buildRows(response({ names: {}, namesPending: false }));
			assert.equal(row2.victimName, 'Unknown pilot');
		});
		it('treats kills without pilots as NPC kills', () => {
			const r = response();
			r.kills[0].attackerCount = 0;
			r.kills[0].npc = true;
			assert.equal(skf().buildRows(r)[0].npc, true);
		});
		it('copes with junk', () => {
			assert.deepEqual(skf().buildRows(null), []);
			assert.deepEqual(skf().buildRows({ kills: 'x' }), []);
			assert.deepEqual(skf().buildRows({ kills: [null, {}] }), []);
		});
		it('does not look up names on the prototype', () => {
			const r = response({ names: {} });
			r.kills[0].victim.characterID = 'constructor';
			assert.equal(skf().buildRows(r)[0].victimName, 'Unknown pilot');
		});
	});

	describe('viewModel', () => {
		it('lists kills', () => {
			const m = skf().viewModel(response());
			assert.equal(m.state, 'list');
			assert.equal(m.rows.length, 1);
			assert.equal(m.note, '');
		});
		it('notes a pending back-fill under the list', () => {
			assert.match(skf().viewModel(response({ pending: true })).note, /older kills/);
		});
		it('is loading while empty and pending', () => {
			assert.equal(skf().viewModel(response({ kills: [], pending: true })).state, 'loading');
		});
		it('is empty with the window in the message', () => {
			const m = skf().viewModel(response({ kills: [], pastSeconds: 86400 }));
			assert.equal(m.state, 'empty');
			assert.equal(m.note, 'No kills in the last 24 hours.');
		});
		it('says when the feed is off', () => {
			assert.equal(skf().viewModel(response({ kills: [], feed: { enabled: false } })).state, 'disabled');
		});
		it('warns when the feed is behind', () => {
			assert.match(skf().viewModel(response({ feed: { enabled: true, live: false } })).note, /behind/);
		});
	});

	describe('HTML', () => {
		it('escapes names everywhere', () => {
			const r = response();
			r.names['2116087385'] = '<img src=x onerror=alert(1)>';
			r.names['98754582'] = "Corp' onmouseover='x";
			const html = skf().rowHtml(skf().buildRows(r)[0], Date.parse('2026-10-10T10:00:00Z'));
			assert.ok(!html.includes('<img src=x'));
			assert.ok(!html.includes("Corp' onmouseover"));
			assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
		});
		it('double-escapes tooltip content (the tooltip renders HTML)', () => {
			assert.equal(skf().tooltip('<b>'), '&amp;lt;b&amp;gt;');
			assert.equal(skf().tooltip(['a', '', null, 'b']), 'a&lt;br/&gt;b');
		});
		it('links to zKillboard in a new tab and shows the parts', () => {
			const html = skf().rowHtml(skf().buildRows(response())[0], Date.parse('2026-10-10T10:00:00Z'));
			assert.ok(html.includes("href='https://zkillboard.com/kill/139046138/'"));
			assert.ok(html.includes("target='_blank'"));
			assert.ok(html.includes('types/22444/icon'));
			assert.ok(html.includes('corporations/98754582/logo'));
			assert.ok(html.includes('corporations/98585301/logo'));
			assert.ok(html.includes('>18m<'));
			assert.ok(html.includes('11 pilots involved'));
		});
		it('renders states', () => {
			assert.match(skf().bodyHtml(null, 0, ''), /Loading kills/);
			assert.match(skf().bodyHtml(null, 0, 'Could not <load>'), /Could not &lt;load&gt;/);
			assert.match(skf().bodyHtml(skf().viewModel(response({ kills: [] })), 0, ''), /No kills in the last 48 hours/);
			const list = skf().bodyHtml(skf().viewModel(response()), 0, 'Could not load kills');
			assert.match(list, /skf-row/);
			assert.match(list, /skf-note skf-error/);
		});
	});

	describe('layout', () => {
		it('reads a saved position from the serialized grid', () => {
			const grid = [{ id: 'infoWidget', col: 1, row: 1, size_x: 7, size_y: 6 },
				{ id: 'systemKillFeedWidget', col: '22', row: '1', size_x: '5', size_y: '8' }];
			assert.deepEqual(skf().savedPosition(grid, 'systemKillFeedWidget'), { col: 22, row: 1, size_x: 5, size_y: 8 });
			assert.deepEqual(skf().savedPosition({ 0: grid[1] }, 'systemKillFeedWidget'), { col: 22, row: 1, size_x: 5, size_y: 8 });
		});
		it('has no saved position in layouts that predate the panel', () => {
			assert.equal(skf().savedPosition([{ id: 'infoWidget', col: 1, row: 1, size_x: 7, size_y: 6 }], 'systemKillFeedWidget'), null);
			assert.equal(skf().savedPosition({}, 'systemKillFeedWidget'), null);
			assert.equal(skf().savedPosition(null, 'systemKillFeedWidget'), null);
			assert.equal(skf().savedPosition([{ id: 'systemKillFeedWidget', col: 0, row: 1, size_x: 7, size_y: 6 }], 'systemKillFeedWidget'), null);
		});
		const defaults = [{ col: 1, row: 1, size_x: 7, size_y: 6 }, { col: 8, row: 1, size_x: 7, size_y: 6 },
			{ col: 15, row: 1, size_x: 7, size_y: 6 }, { col: 1, row: 7, size_x: 21, size_y: 8 }];
		it('goes right of the top row on wide windows', () => {
			assert.deepEqual(skf().defaultPosition(defaults, 1920), { col: 22, row: 1, size_x: 7, size_y: 6 });
		});
		it('goes under everything on narrow windows', () => {
			assert.deepEqual(skf().defaultPosition(defaults, 1280), { col: 1, row: 15, size_x: 7, size_y: 6 });
			assert.deepEqual(skf().defaultPosition([], 0), { col: 1, row: 1, size_x: 7, size_y: 6 });
		});
		it('drops secondary information as the panel narrows', () => {
			assert.deepEqual(skf().widthClasses(400), []);
			assert.deepEqual(skf().widthClasses(300), ['skf-lt340']);
			assert.deepEqual(skf().widthClasses(250), ['skf-lt340', 'skf-lt280']);
			assert.deepEqual(skf().widthClasses(200), ['skf-lt340', 'skf-lt280', 'skf-lt230']);
			assert.deepEqual(skf().widthClasses(600), ['skf-wide']);
		});
	});
});
