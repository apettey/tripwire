const assert = require('assert');
const { include } = require('../helpers/helpers');
const { createDocument, h } = require('../helpers/mini-dom');
include('app/js/fork/smart-notes');

// A few systems as appData.systems has them
const SYSTEMS = {
	31002012: { name: 'J163701', class: 5 },
	30000142: { name: 'Jita' },
	30004759: { name: '1DQ1-A' },
	31000005: { name: 'Thera' },
	30002187: { name: 'Amarr' },
	30000001: { name: 'Tanoo' },
	30045349: { name: 'New Caldari' },	// two words: never matched in text
	30001000: { name: 'Exit' },	// everyday words: never matched in text
	30001001: { name: 'Jan' }
};
const INFO = {
	31002012: { name: 'J163701', cls: 'wh class-5', type: 'C5' },
	30000142: { name: 'Jita', cls: 'hisec', type: 'HS' },
	30004759: { name: '1DQ1-A', cls: 'nullsec', type: 'NS' },
	30002187: { name: 'Amarr', cls: 'hisec', type: 'HS' }
};
const NOW = Date.parse('2026-10-11T12:00:00Z');

function context(over) {
	const wanted = { kills: [], names: [] };
	const kills = {};
	const ctx = Object.assign({
		systemNames: true,
		systemIndex: smartNotes.systemIndex(SYSTEMS),
		systemInfo: id => INFO[id] || null,
		names: {},
		killEntry: id => kills[id],
		wantKill: id => wanted.kills.push(id),
		wantName: id => wanted.names.push(id),
		plainText: new WeakMap(),
		now: () => NOW
	}, over || {});
	return { ctx, wanted, kills };
}

const KILL = {
	status: 'ok', killID: 131234567, killTime: '2026-10-10T09:41:00Z', systemID: 31002012,
	victim: { characterID: 2119000001, corporationID: 98388312, allianceID: null, shipTypeID: 29990 },
	finalBlow: { characterID: 2, corporationID: 3, allianceID: null, shipTypeID: 17738 },
	attackers: 12, pilots: 11, value: 1234500000, npc: false, solo: false, side: 'loss'
};
const NAMES = { 2119000001: 'Vex Arkady', 98388312: 'Deep Static Holdings', 29990: 'Loki', 17738: 'Machariel' };

describe('Smart notes', () => {
	describe('settings', () => {
		it('is on by default, with system names', () => {
			assert.strictEqual(smartNotes.enabled(undefined), true);
			assert.strictEqual(smartNotes.enabled({}), true);
			assert.strictEqual(smartNotes.enabled({ smartNotes: {} }), true);
			assert.strictEqual(smartNotes.enabled({ smartNotes: { enabled: false } }), false);
			assert.strictEqual(smartNotes.systemNames({}), true);
			assert.strictEqual(smartNotes.systemNames({ smartNotes: { enabled: true } }), true);
			assert.strictEqual(smartNotes.systemNames({ smartNotes: { systemNames: false } }), false);
		});
	});

	describe('recognising links', () => {
		it('zKillboard kill links in every shape, with a canonical URL', () => {
			['https://zkillboard.com/kill/131234567/', 'https://zkillboard.com/kill/131234567', 'https://www.zkillboard.com/kill/131234567/',
				'https://ZKILLBOARD.com/kill/131234567/?foo=1', 'https://zkillboard.com/kill/131234567/#top', ' https://zkillboard.com/kill/131234567/ ']
				.forEach(href => assert.deepStrictEqual(smartNotes.classify(href), { kind: 'kill', id: 131234567, url: 'https://zkillboard.com/kill/131234567/' }, href));
		});
		it('zKillboard entity links', () => {
			assert.deepStrictEqual(smartNotes.classify('https://zkillboard.com/character/2119000001/'),
				{ kind: 'zkill', type: 'character', id: 2119000001, url: 'https://zkillboard.com/character/2119000001/' });
			assert.strictEqual(smartNotes.classify('https://zkillboard.com/corporation/98388312/losses/').type, 'corporation');
			assert.strictEqual(smartNotes.classify('https://zkillboard.com/alliance/99000001').type, 'alliance');
			assert.deepStrictEqual(smartNotes.classify('https://zkillboard.com/system/31002012/'),
				{ kind: 'zkill', type: 'system', id: 31002012, url: 'https://zkillboard.com/system/31002012/' });
		});
		it('only https, only the exact hosts', () => {
			assert.strictEqual(smartNotes.classify('http://zkillboard.com/kill/1/'), null);
			assert.strictEqual(smartNotes.classify('javascript:alert(1)//https://zkillboard.com/kill/1/'), null);
			assert.strictEqual(smartNotes.classify('ftp://zkillboard.com/kill/1/'), null);
			assert.strictEqual(smartNotes.classify('not a url'), null);
			assert.strictEqual(smartNotes.classify(''), null);
			assert.strictEqual(smartNotes.classify(null), null);
			// look-alikes are ordinary links (never cards), credentials and ports are refused
			['https://zkillboard.com.evil.tld/kill/1/', 'https://evilzkillboard.com/kill/1/', 'https://zkillboard.co/kill/1/', 'https://kill.zkillboard.com/kill/1/']
				.forEach(href => assert.strictEqual(smartNotes.classify(href).kind, 'link', href));
			assert.strictEqual(smartNotes.classify('https://zkillboard.com@evil.tld/kill/1/'), null);
			assert.strictEqual(smartNotes.classify('https://user:pw@zkillboard.com/kill/1/'), null);
			assert.strictEqual(smartNotes.classify('https://zkillboard.com:8443/kill/1/'), null);
		});
		it('other zKillboard pages and bad IDs are ordinary links', () => {
			assert.strictEqual(smartNotes.classify('https://zkillboard.com/kill/abc/').kind, 'link');
			assert.strictEqual(smartNotes.classify('https://zkillboard.com/kill/0/').kind, 'link');
			assert.strictEqual(smartNotes.classify('https://zkillboard.com/kill/1234567890123/').kind, 'link');
			assert.strictEqual(smartNotes.classify('https://zkillboard.com/kill/1/extra/').kind, 'link');
			assert.strictEqual(smartNotes.classify('https://zkillboard.com/ship/29990/').kind, 'link');
		});
		it('Dotlan systems, maps and regions (names from the URL)', () => {
			assert.deepStrictEqual(smartNotes.classify('https://evemaps.dotlan.net/system/Jita'),
				{ kind: 'dotlan', label: 'Jita', system: 'Jita', url: 'https://evemaps.dotlan.net/system/Jita' });
			const map = smartNotes.classify('https://evemaps.dotlan.net/map/The_Forge/Jita');
			assert.deepStrictEqual([map.label, map.system], ['The Forge › Jita', 'Jita']);
			const region = smartNotes.classify('https://evemaps.dotlan.net/region/Tribute');
			assert.deepStrictEqual([region.label, region.system], ['Tribute', null]);
			assert.strictEqual(smartNotes.classify('https://evemaps.dotlan.net/map/Cloud%20Ring').label, 'Cloud Ring');
			assert.strictEqual(smartNotes.classify('https://evemaps.dotlan.net/').kind, 'link');
			assert.strictEqual(smartNotes.classify('http://evemaps.dotlan.net/system/Jita'), null);
		});
		it('EveWho', () => {
			assert.deepStrictEqual(smartNotes.classify('https://evewho.com/corporation/98388312'),
				{ kind: 'evewho', type: 'corporation', id: 98388312, url: 'https://evewho.com/corporation/98388312' });
			assert.strictEqual(smartNotes.classify('https://www.evewho.com/character/1/').type, 'character');
			assert.strictEqual(smartNotes.classify('https://evewho.com/pilot/Bob').kind, 'link');
		});
		it('short labels: domain and first path segment', () => {
			assert.strictEqual(smartNotes.classify('https://www.reddit.com/r/Eve/comments/1abcd23/wormhole_eviction/').label, 'reddit.com/r/Eve…');
			assert.strictEqual(smartNotes.classify('https://example.org/wiki/Wormholes').label, 'example.org/wiki…');
			assert.strictEqual(smartNotes.classify('https://example.org/').label, 'example.org');
			assert.strictEqual(smartNotes.classify('https://example.org/page?x=1').label, 'example.org/page…');
			assert.ok(smartNotes.classify('https://example.org/' + 'a'.repeat(200)).label.length <= smartNotes.MAX_LABEL);
		});
		it('link text that is just the URL', () => {
			assert.strictEqual(smartNotes.isURLText('https://zkillboard.com/kill/1/', 'https://zkillboard.com/kill/1/'), true);
			assert.strictEqual(smartNotes.isURLText('zkillboard.com/kill/1', 'https://zkillboard.com/kill/1/'), true);
			assert.strictEqual(smartNotes.isURLText('www.reddit.com/r/Eve', 'https://reddit.com/r/Eve/'), true);
			assert.strictEqual(smartNotes.isURLText('our loss', 'https://zkillboard.com/kill/1/'), false);
			assert.strictEqual(smartNotes.isURLText('', 'https://zkillboard.com/kill/1/'), false);
		});
	});

	describe('bare URLs in text', () => {
		it('finds https URLs and leaves trailing punctuation out', () => {
			const text = 'See https://zkillboard.com/kill/1/. Also (https://example.org/a_(b)) and https://x.org/y, http://old.org/z';
			assert.deepStrictEqual(smartNotes.findURLs(text).map(u => u.url), ['https://zkillboard.com/kill/1/', 'https://example.org/a_(b)', 'https://x.org/y']);
			const first = smartNotes.findURLs(text)[0];
			assert.strictEqual(text.substring(first.start, first.end), first.url);
		});
		it('nothing in plain text', () => {
			assert.deepStrictEqual(smartNotes.findURLs('no links here, https:// alone'), []);
		});
	});

	describe('system names in text', () => {
		const index = smartNotes.systemIndex(SYSTEMS);
		const names = text => smartNotes.findSystems(text, index).map(s => s.name);
		it('indexes single-word names only', () => {
			assert.strictEqual(index.J163701, 31002012);
			assert.strictEqual(index['1DQ1-A'], 30004759);
			assert.strictEqual(index['New Caldari'], undefined);
			assert.strictEqual(index.Exit, undefined);
			assert.deepStrictEqual(names('Exit via Jita on Jan 5'), ['Jita']);
		});
		it('matches whole words', () => {
			assert.deepStrictEqual(names('Home is J163701, staging in Jita. Then 1DQ1-A!'), ['J163701', 'Jita', '1DQ1-A']);
			assert.deepStrictEqual(names('(Thera) and "Amarr"'), ['Thera', 'Amarr']);
			assert.deepStrictEqual(names('Jitaa XJ163701 J1637012 Jita_2 Jita-ish'), []);
		});
		it('J-codes in any case, other names exactly', () => {
			assert.deepStrictEqual(smartNotes.findSystems('j163701 jita JITA', index).map(s => [s.name, s.systemID]), [['J163701', 31002012]]);
		});
		it('not inside paths, domains or addresses', () => {
			assert.deepStrictEqual(names('evemaps.dotlan.net/system/Jita jita.com Jita.com bob@Jita #Jita x/Jita'), []);
			assert.deepStrictEqual(names('Jita. Next'), ['Jita']);
		});
		it('unknown names are left alone', () => {
			assert.deepStrictEqual(names('J999999 Static Home'), []);
		});
	});

	describe('formatting', () => {
		it('ISK', () => {
			assert.strictEqual(smartNotes.formatISK(1234500000), '1.2b');
			assert.strictEqual(smartNotes.formatISK(187300000), '187m');
			assert.strictEqual(smartNotes.formatISK(12340000), '12.3m');
			assert.strictEqual(smartNotes.formatISK(2000000000), '2b');
			assert.strictEqual(smartNotes.formatISK(85400), '85.4k');
			assert.strictEqual(smartNotes.formatISK(1.5e12), '1.5t');
			assert.strictEqual(smartNotes.formatISK(500), '500');
			assert.strictEqual(smartNotes.formatISK(0), '');
			assert.strictEqual(smartNotes.formatISK('x'), '');
		});
		it('ages and EVE time', () => {
			assert.strictEqual(smartNotes.timeAgo(NOW - 20000, NOW), 'just now');
			assert.strictEqual(smartNotes.timeAgo(NOW - 12 * 60000, NOW), '12 min ago');
			assert.strictEqual(smartNotes.timeAgo(NOW - 3 * 3600000, NOW), '3 h ago');
			assert.strictEqual(smartNotes.timeAgo(NOW - 50 * 3600000, NOW), '2 d ago');
			assert.deepStrictEqual(smartNotes.eveTime(Date.parse('2026-09-01T21:13:05Z')), { short: '21:13', full: '2026-09-01 21:13' });
			assert.deepStrictEqual(smartNotes.eveTime(NaN), { short: '', full: '' });
		});
		it('image URLs only from numeric IDs', () => {
			assert.strictEqual(smartNotes.imageURL('type', 29990, 32), 'https://images.evetech.net/types/29990/icon?size=32');
			assert.strictEqual(smartNotes.imageURL('character', '2119000001', 32), 'https://images.evetech.net/characters/2119000001/portrait?size=32');
			assert.strictEqual(smartNotes.imageURL('corporation', 98388312, 32), 'https://images.evetech.net/corporations/98388312/logo?size=32');
			assert.strictEqual(smartNotes.imageURL('alliance', 1, 64), 'https://images.evetech.net/alliances/1/logo?size=64');
			assert.strictEqual(smartNotes.imageURL('type', '1/../../evil', 32), '');
			assert.strictEqual(smartNotes.imageURL('type', '"><script>', 32), '');
			assert.strictEqual(smartNotes.imageURL('type', 0, 32), '');
			assert.strictEqual(smartNotes.imageURL('type', null, 32), '');
			assert.strictEqual(smartNotes.imageURL('system', 1, 32), '');
		});
	});

	describe('kill card model', () => {
		const info = id => INFO[id] || null;
		it('loading, then loaded, else failed', () => {
			assert.deepStrictEqual(smartNotes.cardModel(131234567, undefined, {}, info, NOW),
				{ killID: 131234567, url: 'https://zkillboard.com/kill/131234567/', state: 'loading', label: 'Kill 131234567 · loading…' });
			assert.strictEqual(smartNotes.cardModel(1, { state: 'failed' }, {}, info, NOW).state, 'failed');
			const m = smartNotes.cardModel(131234567, { state: 'ok', data: KILL }, NAMES, info, NOW);
			assert.deepStrictEqual([m.state, m.side, m.shipName, m.victimName, m.victimCorp, m.systemName, m.systemClass, m.value, m.time, m.age, m.attackers],
				['ok', 'loss', 'Loki', 'Vex Arkady', 'Deep Static Holdings', 'J163701', 'wh class-5', '1.2b', '09:41', '1 d ago', 12]);
			assert.strictEqual(m.shipIcon, 'https://images.evetech.net/types/29990/icon?size=32');
			assert.strictEqual(m.finalBlowIcon, 'https://images.evetech.net/types/17738/icon?size=32');
		});
		it('names not resolved yet, structures without a pilot, unknown systems', () => {
			const structure = Object.assign({}, KILL, { victim: { characterID: null, corporationID: 5, shipTypeID: 35832 }, systemID: 30000001, side: 'kill' });
			const m = smartNotes.cardModel(1, { state: 'ok', data: structure }, { 35832: 'Astrahus' }, info, NOW);
			assert.deepStrictEqual([m.victimName, m.shipName, m.victimCorp, m.systemName, m.side], ['Astrahus', 'Astrahus', '', 'System 30000001', 'kill']);
			const bare = smartNotes.cardModel(1, { state: 'ok', data: KILL }, {}, info, NOW);
			assert.deepStrictEqual([bare.victimName, bare.shipName], ['Unknown pilot', 'Unknown ship']);
			assert.strictEqual(smartNotes.cardModel(1, { state: 'ok', data: Object.assign({}, KILL, { side: 'evil' }) }, {}, info, NOW).side, null);
		});
	});

	describe('enhancing a note', () => {
		function note(doc) {
			return h(doc, 'div', { 'class': 'commentBody', id: 'comment0' }, [
				h(doc, 'p', {}, ['Lost a Loki: ', h(doc, 'a', { href: 'https://zkillboard.com/kill/131234567/' }, ['https://zkillboard.com/kill/131234567/'])]),
				h(doc, 'p', {}, ['Residents: ', h(doc, 'a', { href: 'https://zkillboard.com/corporation/98388312/' }, ['https://zkillboard.com/corporation/98388312/']),
					' route ', h(doc, 'a', { href: 'https://evemaps.dotlan.net/map/The_Forge/Jita' }, ['https://evemaps.dotlan.net/map/The_Forge/Jita'])]),
				h(doc, 'p', {}, ['Write-up: ', h(doc, 'a', { href: 'https://www.reddit.com/r/Eve/comments/1abcd23/wormhole_eviction_timers/' }, ['https://www.reddit.com/r/Eve/comments/1abcd23/wormhole_eviction_timers/'])]),
				h(doc, 'p', {}, ['Home is J163701. Last loss: https://zkillboard.com/kill/131234999/ and see https://example.org/x']),
				h(doc, 'p', {}, [h(doc, 'a', { href: 'https://zkillboard.com/kill/5/' }, ['our loss']), ' ', h(doc, 'code', {}, ['Jita https://zkillboard.com/kill/6/'])])
			]);
		}

		it('turns links, bare URLs and system names into cards and chips', () => {
			const doc = createDocument();
			const body = note(doc);
			const { ctx, wanted } = context({ names: { 98388312: 'Deep Static Holdings' } });
			assert.strictEqual(smartNotes.enhance(doc, body, ctx), true);
			const html = body.innerHTML;
			// only nodes created here are re-rendered later (a note's own link with our class names is not)
			assert.strictEqual(smartNotes.ours.has(body.childNodes[0].childNodes[1]), true);
			assert.strictEqual(smartNotes.ours.has(body.childNodes[0]), false);
			// kill cards (loading) for the link and the bare URL; both kills asked for
			assert.deepStrictEqual(wanted.kills, [131234567, 131234999]);
			assert.ok(html.includes('<a class="sn sn-kill sn-loading" href="https://zkillboard.com/kill/131234567/" target="_blank" rel="noopener noreferrer" data-kill-id="131234567" title="Loading kill 131234567 (zKillboard)"><span class="sn-kill-label">Kill 131234567 · loading…</span></a>'), html);
			assert.ok(html.includes('data-kill-id="131234999"'));
			// corporation chip with its logo and cached name (no name asked for)
			assert.ok(html.includes('<img class="sn-icon" src="https://images.evetech.net/corporations/98388312/logo?size=32" alt="" loading="lazy"><span class="sn-name">Deep Static Holdings</span>'), html);
			assert.deepStrictEqual(wanted.names, []);
			// Dotlan chip coloured by the system's class
			assert.ok(html.includes('<span class="sn-site">Dotlan</span><span class="sn-name hisec">The Forge › Jita</span>'), html);
			// long link shortened, full URL in the tooltip
			assert.ok(html.includes('class="sn sn-chip sn-short" href="https://www.reddit.com/r/Eve/comments/1abcd23/wormhole_eviction_timers/"'), html);
			assert.ok(html.includes('<span class="sn-name">reddit.com/r/Eve…</span>'));
			// system name chip links to the system in Tripwire
			assert.ok(html.includes('<a class="sn sn-chip sn-system" href=".?system=J163701" title="J163701 (C5) – view in Tripwire" data-system-id="31002012"><span class="sn-sys-type wh class-5">C5</span><span class="sn-name wh class-5">J163701</span></a>. Last loss: '), html);
			// a short bare URL becomes a plain link
			assert.ok(html.includes('<a class="sn sn-plain" href="https://example.org/x" target="_blank" rel="noopener noreferrer">https://example.org/x</a>'), html);
			// a link with its own words and anything in code stays as it was
			assert.ok(html.includes('<a href="https://zkillboard.com/kill/5/">our loss</a> <code>Jita https://zkillboard.com/kill/6/</code>'), html);
		});

		it('asks for names it does not know', () => {
			const doc = createDocument();
			const body = h(doc, 'div', {}, ['See https://zkillboard.com/character/77/ and https://evewho.com/alliance/88']);
			const { ctx, wanted } = context();
			smartNotes.enhance(doc, body, ctx);
			assert.deepStrictEqual(wanted.names, [77, 88]);
			assert.ok(body.innerHTML.includes('<span class="sn-name">Character 77</span>'));
			assert.ok(body.innerHTML.includes('<span class="sn-site">EveWho</span><span class="sn-name">Alliance 88</span>'));
		});

		it('zKillboard system links become system chips, unknown systems stay links', () => {
			const doc = createDocument();
			const body = h(doc, 'div', {}, [h(doc, 'a', { href: 'https://zkillboard.com/system/30000142/' }, ['https://zkillboard.com/system/30000142/']),
				' ', h(doc, 'a', { href: 'https://zkillboard.com/system/30099999/' }, ['https://zkillboard.com/system/30099999/'])]);
			smartNotes.enhance(doc, body, context().ctx);
			assert.ok(body.innerHTML.startsWith('<a class="sn sn-chip sn-system" href="https://zkillboard.com/system/30000142/" target="_blank" rel="noopener noreferrer" title="Jita (HS) – view in Tripwire if it is on the map, else open on zKillboard" data-system-id="30000142">'), body.innerHTML);
			assert.ok(body.innerHTML.endsWith(' <a href="https://zkillboard.com/system/30099999/">https://zkillboard.com/system/30099999/</a>'), body.innerHTML);
		});

		it('system names only with the sub-toggle', () => {
			const doc = createDocument();
			const body = h(doc, 'p', {}, ['Home is J163701 near Jita']);
			smartNotes.enhance(doc, body, context({ systemNames: false }).ctx);
			assert.strictEqual(body.innerHTML, 'Home is J163701 near Jita');
		});

		it('leaves text inside chips alone and does not enhance twice', () => {
			const doc = createDocument();
			const body = note(doc);
			const { ctx } = context();
			smartNotes.enhance(doc, body, ctx);
			const once = body.innerHTML;
			assert.strictEqual(smartNotes.isEnhanced(body), true);
			assert.strictEqual(smartNotes.enhance(doc, body, ctx), false);
			assert.strictEqual(body.innerHTML, once);
			// "Jita" inside the Dotlan chip and the system chip's own text were not turned into chips
			assert.strictEqual((once.match(/sn-system/g) || []).length, 1);
		});

		it('restores the original nodes (for the editor), and enhances again after upstream replaces the content', () => {
			const doc = createDocument();
			const body = note(doc);
			const original = body.innerHTML;
			const { ctx } = context();
			smartNotes.enhance(doc, body, ctx);
			assert.notStrictEqual(body.innerHTML, original);
			assert.strictEqual(smartNotes.restore(body), true);
			assert.strictEqual(body.innerHTML, original);
			assert.strictEqual(smartNotes.restore(body), false);
			// upstream sets new content (a sync): not enhanced any more, so the next pass does it again
			smartNotes.enhance(doc, body, ctx);
			body.textContent = '';
			body.appendChild(h(doc, 'p', {}, ['Now in Jita']));
			assert.strictEqual(smartNotes.isEnhanced(body), false);
			assert.strictEqual(smartNotes.enhance(doc, body, ctx), true);
			assert.ok(body.innerHTML.includes('data-system-id="30000142"'));
			assert.strictEqual(smartNotes.restore(body), true);
			assert.strictEqual(body.innerHTML, '<p>Now in Jita</p>');
		});

		it('a note without anything to convert is left untouched', () => {
			const doc = createDocument();
			const body = h(doc, 'div', {}, [h(doc, 'p', {}, ['Nothing to see, ', h(doc, 'b', {}, ['bold']), ' text'])]);
			const before = body.innerHTML;
			assert.strictEqual(smartNotes.enhance(doc, body, context().ctx), false);
			assert.strictEqual(body.innerHTML, before);
		});

		it('escapes hostile names and URLs (text and attributes only)', () => {
			const doc = createDocument();
			const evil = '<img src=x onerror=alert(1)>';
			const body = h(doc, 'div', {}, ['https://zkillboard.com/corporation/1/ https://evil.example/"><script>alert(1)</script>']);
			smartNotes.enhance(doc, body, context({ names: { 1: evil } }).ctx);
			const html = body.innerHTML;
			assert.ok(html.includes('<span class="sn-name">&lt;img src=x onerror=alert(1)&gt;</span>'), html);
			assert.ok(!html.includes('<img src=x'), html);
			assert.ok(!html.includes('<script>'), html);
			// the URL stops at the quote; the rest stays text
			assert.ok(html.includes('href="https://evil.example/"'), html);
			assert.ok(html.includes('"&gt;&lt;script&gt;alert(1)&lt;/script&gt;'), html);
		});

		it('renders a loaded kill card safely, and a known failed kill as the plain link', () => {
			const doc = createDocument();
			const { ctx, kills } = context({ names: Object.assign({}, NAMES, { 2119000001: '</span><b>x</b>' }) });
			kills[131234567] = { state: 'ok', data: KILL };
			kills[131234999] = { state: 'failed' };
			const body = h(doc, 'div', {}, [
				h(doc, 'a', { href: 'https://zkillboard.com/kill/131234567/' }, ['https://zkillboard.com/kill/131234567/']),
				h(doc, 'a', { href: 'https://www.zkillboard.com/kill/131234999' }, ['https://www.zkillboard.com/kill/131234999'])
			]);
			smartNotes.enhance(doc, body, ctx);
			const card = body.childNodes[0];
			assert.strictEqual(card.getAttribute('class'), 'sn sn-kill sn-side-loss');
			assert.strictEqual(card.getAttribute('href'), 'https://zkillboard.com/kill/131234567/');
			assert.strictEqual(card.getAttribute('target'), '_blank');
			assert.strictEqual(card.getAttribute('rel'), 'noopener noreferrer');
			assert.deepStrictEqual(card.childNodes.map(c => c.getAttribute('class')),
				['sn-icon sn-ship-icon', 'sn-ship', 'sn-victim', 'sn-corp', 'sn-sys wh class-5', 'sn-isk', 'sn-time', 'sn-att', 'sn-icon sn-fb-icon']);
			assert.deepStrictEqual(card.childNodes.slice(1, 8).map(c => c.textContent),
				['Loki', '</span><b>x</b>', 'Deep Static Holdings', 'J163701', '1.2b', '09:41 · 1 d ago', '12']);
			assert.ok(card.innerHTML.includes('&lt;/span&gt;&lt;b&gt;x&lt;/b&gt;'));
			assert.ok(card.getAttribute('title').includes('Our loss'));
			assert.strictEqual(body.childNodes[1].outerHTML,
				'<a class="sn sn-plain" href="https://zkillboard.com/kill/131234999/" target="_blank" rel="noopener noreferrer">https://www.zkillboard.com/kill/131234999</a>');
		});

		it('a loading card can be re-rendered in place (loading -> loaded)', () => {
			const doc = createDocument();
			const { ctx } = context();
			const body = h(doc, 'div', {}, ['https://zkillboard.com/kill/131234567/']);
			smartNotes.enhance(doc, body, ctx);
			const card = body.childNodes[0];
			assert.strictEqual(card.getAttribute('class'), 'sn sn-kill sn-loading');
			assert.strictEqual(ctx.plainText.get(card), 'https://zkillboard.com/kill/131234567/');
			smartNotes.renderKill(doc, card, smartNotes.cardModel(131234567, { state: 'ok', data: Object.assign({}, KILL, { side: 'kill' }) }, NAMES, ctx.systemInfo, NOW));
			assert.strictEqual(card.getAttribute('class'), 'sn sn-kill sn-side-kill');
			assert.strictEqual(card.childNodes[1].textContent, 'Loki');
			assert.strictEqual(body.childNodes.length, 1);
		});
	});

	describe('loading kills: loading -> loaded / plain link', () => {
		let requests, timers, saved;
		beforeEach(() => {
			requests = [];
			timers = [];
			saved = { $: global.$, setTimeout: global.setTimeout, options: global.options };
			global.$ = { ajax: req => {
				const call = { req, done: null, fail: null };
				requests.push(call);
				const chain = { done: f => { call.done = f; return chain; }, fail: f => { call.fail = f; return chain; } };
				return chain;
			} };
			global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
			global.options = {};
			smartNotes.kills = {};
			smartNotes.names = {};
			smartNotes.pendingKills = {};
			smartNotes.pendingNames = {};
			smartNotes.nameTries = 0;
			smartNotes.flushTimer = null;
		});
		afterEach(() => {
			global.$ = saved.$;
			global.setTimeout = saved.setTimeout;
			global.options = saved.options;
		});
		const runTimers = () => { const due = timers.splice(0); due.forEach(t => t.fn()); return due.map(t => t.ms); };

		it('batches kills and names into one request', () => {
			smartNotes.wantKill(1);
			smartNotes.wantKill(2);
			smartNotes.wantKill(1);
			smartNotes.wantName(77);
			assert.deepStrictEqual(runTimers(), [0]);
			assert.strictEqual(requests.length, 1);
			assert.deepStrictEqual(requests[0].req, { url: 'zkill_kill.php', type: 'GET', dataType: 'json', data: { ids: '1,2', names: '77' } });
			assert.strictEqual(smartNotes.kills[1].state, 'loading');
		});

		it('at most 20 kills per request, the rest follows', () => {
			for (let i = 1; i <= 25; i++) { smartNotes.wantKill(i); }
			runTimers();
			runTimers();
			assert.deepStrictEqual(requests.map(r => r.req.data.ids.split(',').length), [20, 5]);
		});

		it('a stored kill loads', () => {
			smartNotes.wantKill(131234567);
			runTimers();
			requests[0].done({ kills: { 131234567: KILL }, names: NAMES, namesPending: false });
			assert.strictEqual(smartNotes.kills[131234567].state, 'ok');
			assert.strictEqual(smartNotes.names[29990], 'Loki');
			assert.deepStrictEqual(timers, []);
		});

		it('a queued kill is asked for again after 3 s, 10 s and 30 s, then shown as the plain link', () => {
			smartNotes.wantKill(9);
			runTimers();
			const delays = [];
			for (let round = 0; round < 4; round++) {
				requests[requests.length - 1].done({ kills: { 9: { status: 'queued' } }, names: {}, namesPending: false });
				const due = runTimers();
				delays.push(due[0]);
				runTimers();	// the flush it scheduled
			}
			assert.deepStrictEqual(delays, [3000, 10000, 30000, undefined]);
			assert.strictEqual(requests.length, 4);
			assert.strictEqual(smartNotes.kills[9].state, 'failed');
		});

		it('queued, then stored on the second try', () => {
			smartNotes.wantKill(9);
			runTimers();
			requests[0].done({ kills: { 9: { status: 'queued' } }, names: {} });
			runTimers();
			runTimers();
			requests[1].done({ kills: { 9: KILL }, names: NAMES });
			assert.strictEqual(smartNotes.kills[9].state, 'ok');
		});

		it('failed, full or unavailable (feed off): the plain link at once', () => {
			['failed', 'full', 'unavailable'].forEach((status, i) => {
				smartNotes.wantKill(100 + i);
				runTimers();
				requests[requests.length - 1].done({ kills: { [100 + i]: { status } }, names: {} });
				assert.strictEqual(smartNotes.kills[100 + i].state, 'failed', status);
			});
			assert.deepStrictEqual(timers, []);
		});

		it('a failed request counts like queued (retried, then the plain link)', () => {
			smartNotes.wantKill(9);
			runTimers();
			requests[0].fail();
			assert.deepStrictEqual(timers.map(t => t.ms), [3000]);
			assert.strictEqual(smartNotes.kills[9].state, 'loading');
		});

		it('pending names: asked again on the same backoff, kills included', () => {
			smartNotes.wantKill(131234567);
			smartNotes.wantName(77);
			runTimers();
			requests[0].done({ kills: { 131234567: KILL }, names: {}, namesPending: true });
			assert.deepStrictEqual(runTimers(), [3000]);
			runTimers();
			assert.deepStrictEqual(requests[1].req.data, { ids: '131234567', names: '77' });
			requests[1].done({ kills: { 131234567: KILL }, names: { 77: 'Bob' }, namesPending: false });
			assert.strictEqual(smartNotes.names[77], 'Bob');
			assert.deepStrictEqual(timers, []);
		});

		it('switched off: no requests at all', () => {
			global.options = { smartNotes: { enabled: false } };
			smartNotes.wantKill(1);
			smartNotes.wantName(2);
			runTimers();
			assert.strictEqual(requests.length, 0);
		});

		it('switched off while loading, then on again: the kill is asked for again', () => {
			global.options = { smartNotes: { enabled: false } };
			smartNotes.wantKill(1);
			runTimers();
			assert.strictEqual(smartNotes.kills[1], undefined);
			global.options = {};
			smartNotes.wantKill(1);
			runTimers();
			assert.deepStrictEqual(requests.map(r => r.req.data.ids), ['1']);
		});

		it('name retries start over after names arrived', () => {
			smartNotes.nameTries = 3;
			smartNotes.wantName(5);
			runTimers();
			requests[0].done({ kills: {}, names: { 5: 'Five' }, namesPending: false });
			assert.strictEqual(smartNotes.nameTries, 0);
			smartNotes.wantName(6);
			runTimers();
			requests[1].done({ kills: {}, names: {}, namesPending: true });
			assert.deepStrictEqual(timers.map(t => t.ms), [3000]);
		});
	});
});
