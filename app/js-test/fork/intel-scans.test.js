const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('app/js/fork/intel-scans');

const types = loadJSON('public/intel/types');
const AU = 149597870.7;

// A d-scan as copied from a current client (type ID first), with a hostile ship name
const DSCAN = [
	"22456\tBob's Sabre\tSabre\t1,234 km",
	"22456\tSabre 2\tSabre\t8,000 km",
	"12013\tBroadsword\tBroadsword\t2,500 km",
	"11987\tGuardian\tGuardian\t45,000 km",
	"29984\tTengu\tTengu\t12 km",
	"12034\t<img src=x onerror=alert(1)>\tHound\t3.1 AU",
	"11567\tAvatar\tAvatar\t9.8 AU",
	"670\tCapsule\tCapsule\t-",
	"2488\tWarrior II\tWarrior II\t950 m",
	"35832\tJ123456 - <b>Home</b>\tAstrahus\t4.2 AU",
	"12198\tBubble\tMobile Small Warp Disruptor I\t20 km",
	"34\tUnknown future thing\tShiny New Ship\t5 km",
	"broken line"
].join("\r\n");

describe('Intel scans', () => {
	describe('settings', () => {
		it('is on by default', () => {
			assert.equal(intelScans.enabled(undefined), true);
			assert.equal(intelScans.enabled({}), true);
			assert.equal(intelScans.enabled({ intelScans: {} }), true);
			assert.equal(intelScans.enabled({ intelScans: { enabled: false } }), false);
		});
		it('fresh minutes and grid range have defaults and limits', () => {
			assert.equal(intelScans.freshMinutes({}), 15);
			assert.equal(intelScans.freshMinutes({ intelScans: { freshMinutes: 5 } }), 5);
			assert.equal(intelScans.freshMinutes({ intelScans: { freshMinutes: 0 } }), 15);
			assert.equal(intelScans.freshMinutes({ intelScans: { freshMinutes: "abc" } }), 15);
			assert.equal(intelScans.gridKm({}), 10000);
			assert.equal(intelScans.gridKm({ intelScans: { gridKm: 8000 } }), 8000);
			assert.equal(intelScans.gridKm({ intelScans: { gridKm: -1 } }), 10000);
		});
		it('header links are on by default', () => {
			assert.equal(intelScans.showLinks(undefined), true);
			assert.equal(intelScans.showLinks({ intelScans: {} }), true);
			assert.equal(intelScans.showLinks({ intelScans: { links: false } }), false);
		});
	});

	describe('header links', () => {
		it('zKillboard and Anoik.is for a wormhole system', () => {
			assert.deepEqual(intelScans.systemLinks(31002012, 'J123450').map(l => l.url),
				['https://zkillboard.com/system/31002012/', 'https://anoik.is/systems/J123450']);
		});
		it('Anoik.is takes Thera and Drifter names', () => {
			assert.equal(intelScans.systemLinks(31000005, 'Thera')[1].url, 'https://anoik.is/systems/Thera');
			assert.equal(intelScans.systemLinks(31000001, 'Sentinel MZ')[1].url, 'https://anoik.is/systems/Sentinel%20MZ');
		});
		it('only zKillboard for k-space', () => {
			assert.deepEqual(intelScans.systemLinks(30000142, 'Jita').map(l => l.label), ['zKill']);
		});
		it('nothing for no system', () => {
			assert.deepEqual(intelScans.systemLinks(null, ''), []);
			assert.equal(intelScans.linksHtml(undefined, ''), '');
		});
		it('escapes and opens in a new tab', () => {
			const html = intelScans.linksHtml(31002012, "J1'<b>");
			assert.ok(html.indexOf("href='https://anoik.is/systems/J1&#39;%3Cb%3E'") >= 0, html);
			assert.ok(html.indexOf("<b>") < 0);
			assert.equal((html.match(/target='_blank' rel='noopener noreferrer'/g) || []).length, 2);
		});
	});

	describe('parseDistanceKm', () => {
		const d = intelScans.parseDistanceKm;
		it('reads km with any thousands separator', () => {
			assert.equal(d('1,234 km'), 1234);
			assert.equal(d('1.234 km'), 1234);
			assert.equal(d('12 345 km'), 12345);
			assert.equal(d('12 345 km'), 12345);
			assert.equal(d("12'345 km"), 12345);
			assert.equal(d('2 500 км'), 2500);
		});
		it('reads metres and AU', () => {
			assert.equal(d('3,225 m'), 3.2);
			assert.equal(d('4.2 AU'), Math.round(4.2 * AU * 10) / 10);
			assert.equal(d('4,2 AE'), Math.round(4.2 * AU * 10) / 10);
			assert.equal(d('10,4 а.е.'), Math.round(10.4 * AU * 10) / 10);
		});
		it('null for dash, empty, unknown units and garbage', () => {
			[undefined, null, '', '-', '12 parsecs', '<img src=x onerror=alert(1)>', 'km'].forEach(v => assert.strictEqual(d(v), null, String(v)));
		});
		it('null beyond d-scan range (about 14.3 AU)', () => {
			assert.equal(d('14.3 AU'), Math.round(14.3 * AU * 10) / 10);
			assert.strictEqual(d('999999999999999999999 km'), null);
			assert.strictEqual(d('16 AU'), null);
		});
		it('ignores Unicode spaces and bidi controls around the value', () => {
			assert.equal(d(' 1,234 km '), 1234);
			assert.equal(d('‮1,234 km'), 1234);
		});
	});

	describe('parseDscan', () => {
		it('reads the current format with type IDs', () => {
			const p = intelScans.parseDscan(DSCAN);
			assert.equal(p.rows.length, 12);
			assert.equal(p.invalid, 1);
			assert.deepEqual(p.rows[0], [22456, 'Sabre', "Bob's Sabre", 1234]);
			assert.deepEqual(p.rows[7], [670, 'Capsule', 'Capsule', null]);
			assert.equal(p.rows[5][2], '<img src=x onerror=alert(1)>');	// kept as data, escaped when shown
		});
		it('reads the older format without type IDs', () => {
			const p = intelScans.parseDscan("+\tNoctis\t3,225 m\nsome dude's Stabber Fleet Issue\tStabber Fleet Issue\t-\nOtanuomi V - Moon 11\tMoon\t10.4 AU");
			assert.deepEqual(p.rows.map(r => [r[0], r[1]]), [[null, 'Noctis'], [null, 'Stabber Fleet Issue'], [null, 'Moon']]);
		});
		it('rejects type ID 0 and empty types, cuts long names', () => {
			const p = intelScans.parseDscan("0\tZero\tSabre\t5 km\n1\tName\t\t5 km\n11567\t" + 'A'.repeat(300) + "\tAvatar\t-");
			assert.equal(p.invalid, 2);
			assert.equal(p.rows[0][2].length, 100);
		});
		it('strips bidi and other format characters from names', () => {
			const p = intelScans.parseDscan("22456\tEvil‮epyT​\tSabre\t5 km");
			assert.equal(p.rows[0][2], 'EvilepyT');
		});
		it('a type ID with non-breaking spaces is still a type ID', () => {
			assert.equal(intelScans.parseDscan(" 22456 \tSabre\tSabre\t5 km").rows[0][0], 22456);
		});
	});

	describe('parseLocal', () => {
		it('keeps valid, unique character names in order', () => {
			const p = intelScans.parseLocal("Chribba\n  Some Pilot  \nchribba\nO'Neil Smith-Jones\n<script>alert(1)</script>\nab\n" + 'x'.repeat(40) + "\nZoë Mäkinen\r\n");
			assert.deepEqual(p.names, ['Chribba', 'Some Pilot', "O'Neil Smith-Jones", 'Zoë Mäkinen']);
			assert.equal(p.invalid, 3);
		});
		it('<img onerror> is not a character name', () => {
			assert.deepEqual(intelScans.parseLocal('<img src=x onerror=alert(1)>').names, []);
		});
		it('non-breaking spaces count as spaces (same as the server)', () => {
			assert.deepEqual(intelScans.parseLocal(' Some Pilot \n 　\nAnn Example').names, ['Some Pilot', 'Ann Example']);
			assert.equal(intelScans.parseLocal(' Some Pilot \n 　\nAnn Example').invalid, 0);
		});
	});

	describe('parse', () => {
		it('detects the kind', () => {
			assert.equal(intelScans.parse(DSCAN).kind, 'dscan');
			assert.equal(intelScans.parse("Chribba\nSome Pilot").kind, 'local');
		});
		it('reports errors like the server', () => {
			assert.equal(intelScans.parse('   ').error, 'Nothing pasted');
			assert.equal(intelScans.parse(' \n​').error, 'Nothing pasted');
			assert.ok(intelScans.parse('x'.repeat(200001)).error.indexOf('Too much text') === 0);
			assert.ok(intelScans.parse("Pilot Name\n".repeat(2001)).error.indexOf('Too many lines') === 0);
			assert.ok(intelScans.parse("a\tb").error.indexOf('No d-scan lines') === 0);
			assert.ok(intelScans.parse("<b>\n!!").error.indexOf('No character names') === 0);
		});
	});

	describe('typeInfo', () => {
		it('finds types by ID and by English name', () => {
			assert.equal(intelScans.typeInfo(22456, 'Sabre', types).shipClass, 'dictor');
			assert.equal(intelScans.typeInfo(null, 'onyx', types).shipClass, 'hic');
			assert.equal(intelScans.typeInfo(null, 'Tengu', types).cyno, true);
		});
		it('cyno hulls come from the cyno generators\' fitting rules (normal, covert, industrial)', () => {
			const cyno = name => intelScans.typeInfo(null, name, types).cyno;
			['Broadsword', 'Falcon', 'Sin', 'Buzzard', 'Hound', 'Loki', 'Prowler', 'Etana', 'Rabisu', 'Prospect', 'Venture', 'Badger', 'Bustard']
				.forEach(n => assert.equal(cyno(n), true, n));
			['Endurance', 'Guardian', 'Sabre', 'Huginn', 'Avatar', 'Rifter'].forEach(n => assert.equal(cyno(n), false, n));
		});
		it('T3 cruisers and T3 destroyers are separate classes', () => {
			assert.equal(intelScans.typeInfo(null, 'Tengu', types).shipClass, 't3c');
			assert.equal(intelScans.typeInfo(null, 'Svipul', types).shipClass, 't3d');
		});
		it('knows lit cynos, containers and POS force fields', () => {
			assert.equal(intelScans.bucketFor(intelScans.typeInfo(21094, 'Cynosural Field', types)), 'cyno');
			assert.equal(intelScans.bucketFor(intelScans.typeInfo(28650, 'Covert Cynosural Field I', types)), 'cyno');
			assert.equal(intelScans.bucketFor(intelScans.typeInfo(3467, 'Small Secure Container', types)), 'container');
			assert.equal(intelScans.bucketFor(intelScans.typeInfo(16103, 'Force Field', types)), 'structure');
		});
		it('the pasted name does not matter when the ID is known (other client languages)', () => {
			assert.equal(intelScans.typeInfo(22456, 'Сабля', types).name, 'Sabre');
		});
		it('null for unknown types', () => {
			assert.strictEqual(intelScans.typeInfo(34, 'Shiny New Ship', types), null);
			assert.strictEqual(intelScans.typeInfo(null, 'Сабля', types), null);
			assert.strictEqual(intelScans.typeInfo(22456, 'Sabre', null), null);
		});
	});

	describe('summarizeDscan', () => {
		const s = intelScans.summarizeDscan(intelScans.parseDscan(DSCAN), types, 10000);
		const bucket = key => s.buckets.find(b => b.key === key);

		it('counts ships (not pods), on grid and off grid', () => {
			assert.equal(s.total, 12);
			assert.equal(s.ships, 7);	// 2 Sabres, Broadsword, Guardian, Tengu, Hound, Avatar
			assert.equal(s.shipsOnGrid, 4);	// Sabres, Broadsword, Tengu
			assert.equal(s.shipsOffGrid, 3);	// Guardian, Hound, Avatar
			assert.equal(s.onGrid, 7);	// + Warrior II, bubble, unknown ship
			assert.equal(s.noDistance, 1);	// the pod
			assert.equal(s.offGrid, 4);
		});
		it('buckets by class in summary order', () => {
			assert.deepEqual(s.buckets.map(b => b.key),
				['titan', 't3c', 'hic', 'dictor', 'logistics', 'frigate', 'pod', 'drone', 'structure', 'deployable', 'unknown']);
			assert.equal(s.buckets[0].key, 'titan');
			assert.deepEqual(bucket('dictor').types, [{ name: 'Sabre', count: 2 }]);
			assert.equal(bucket('dictor').onGrid, 2);
			assert.equal(bucket('logistics').onGrid, 0);	// 45,000 km is off grid
			assert.deepEqual(bucket('unknown').types, [{ name: 'Shiny New Ship', count: 1 }]);
		});
		it('calls out capitals, HICs, dictors, logistics, bubbles and cyno hulls', () => {
			const notable = {};
			s.notable.forEach(n => { notable[n.key] = n.label + ':' + n.count; });
			assert.equal(notable.titan, 'Titan:1');
			assert.equal(notable.hic, 'HIC:1');
			assert.equal(notable.dictor, 'dictors:2');
			assert.equal(notable.logistics, 'logi:1');
			assert.equal(notable['Mobile Warp Disruptor'], 'bubble:1');
			assert.equal(s.cyno, 3);	// Broadsword (normal), Tengu and Hound (covert)
		});
		it('a lit cyno is the first call-out', () => {
			const c = intelScans.summarizeDscan(intelScans.parseDscan(DSCAN + "\n21094\tCynosural Field\tCynosural Field\t12 km"), types, 10000);
			assert.deepEqual(c.notable[0], { key: 'cyno', label: 'lit cyno', count: 1 });
			assert.equal(c.ships, 7);
		});
		it('lists structures with their names, nearest first', () => {
			assert.deepEqual(s.structures, [{ type: 'Astrahus', name: 'J123456 - <b>Home</b>', km: Math.round(4.2 * AU * 10) / 10 }]);
			assert.equal(s.deployables[0].type, 'Mobile Small Warp Disruptor I');
		});
		it('the grid range is configurable', () => {
			assert.equal(intelScans.summarizeDscan(intelScans.parseDscan(DSCAN), types, 50000).shipsOnGrid, 5);
		});
		it('copes with junk rows and missing data', () => {
			const j = intelScans.summarizeDscan({ rows: [null, 'x', [1]] }, types, 10000);
			assert.equal(j.total, 1);
			assert.equal(intelScans.summarizeDscan(null, types).total, 0);
		});
	});

	describe('chips and detail', () => {
		const scan = { id: 7, kind: 'dscan', age: 130, createdBy: '<i>Evil</i>', mine: true, data: intelScans.parseDscan(DSCAN) };
		const summary = intelScans.summarize(scan, types, 10000);

		it('chip text', () => {
			assert.deepEqual(intelScans.chipParts(scan, summary).slice(0, 5), ['D-scan', '2 min ago', '7 ships (4 on grid)', '1 Titan', '1 HIC']);
			const local = { id: 8, kind: 'local', age: 10, data: { names: ['A Pilot', 'B Pilot'] } };
			assert.deepEqual(intelScans.chipParts(local, intelScans.summarize(local)), ['Local', 'just now', '2 pilots']);
		});
		it('ago', () => {
			assert.equal(intelScans.ago(5), 'just now');
			assert.equal(intelScans.ago(61), '1 min ago');
			assert.equal(intelScans.ago(7300), '2 h ago');
		});
		it('formatDistance', () => {
			assert.equal(intelScans.formatDistance(1234), '1,234 km');
			assert.equal(intelScans.formatDistance(0.5), '500 m');
			assert.equal(intelScans.formatDistance(4.2 * AU), '4.2 AU');
			assert.equal(intelScans.formatDistance(null), '–');
		});
		it('escapes everything pasted', () => {
			const html = intelScans.chipHtml(scan, summary, true, true) + intelScans.detailHtml(scan, summary, 10000);
			assert.equal(html.indexOf('<img'), -1);
			assert.equal(html.indexOf('<b>Home'), -1);
			assert.equal(html.indexOf('<i>Evil'), -1);
			assert.ok(html.indexOf('&lt;img src=x onerror=alert(1)&gt;') < 0, 'ship names are not listed');
			assert.ok(html.indexOf('J123456 - &lt;b&gt;Home&lt;/b&gt;') >= 0);
			assert.ok(html.indexOf('delete') >= 0, 'own scans can be deleted');
		});
		it('escapes local names', () => {
			const local = { id: 9, kind: 'local', age: 0, createdBy: 'x', data: { names: ['<img src=x onerror=alert(1)>', "O'Neil"] } };
			const html = intelScans.detailHtml(local, intelScans.summarize(local), 10000);
			assert.equal(html.indexOf('<img'), -1);
			assert.ok(html.indexOf('O&#39;Neil') >= 0);
		});
		it('detail lists classes and cyno hulls', () => {
			const html = intelScans.detailHtml(scan, summary, 10000);
			assert.ok(html.indexOf('Sabre ×2') >= 0);
			assert.ok(html.indexOf('3 hulls that can fit a cyno') >= 0);
			assert.ok(html.indexOf('1 line not understood') >= 0);
		});
		it('the detail line counts ships on and off grid, and objects separately', () => {
			const html = intelScans.detailHtml(scan, summary, 10000);
			assert.ok(html.indexOf('7 ships: 4 on grid (≤ 10,000 km), 3 off grid · 12 objects in total') >= 0, html);
		});
	});

	describe('Intel panel', () => {
		const dscan = { id: 11, kind: 'dscan', age: 60, createdBy: 'A', data: intelScans.parseDscan(DSCAN) };
		const local = { id: 12, kind: 'local', age: 10, createdBy: '<b>B</b>', mine: true, data: { names: ['A Pilot', '<img src=x onerror=alert(1)>'] } };
		const old = { id: 5, kind: 'local', age: 4000, createdBy: 'C', data: { names: ['Old Pilot'] } };
		const state = (extra) => Object.assign({ systemID: 31000005, scans: [dscan, old, local], types: types, freshSeconds: 900, gridKm: 10000,
			showOlder: false, openScanID: null, error: '' }, extra);
		const chipIDs = (html) => (html.match(/class='intel-chip[^']*' data-scan='(\d+)'/g) || []).map(m => m.match(/(\d+)'$/)[1]);

		it('has the paste button first, then the fresh chips newest first', () => {
			const html = intelScans.panelHtml(state());
			assert.ok(html.indexOf("class='intel-paste'") >= 0 && html.indexOf("class='intel-paste'") < html.indexOf('intel-chip'));
			assert.deepEqual(chipIDs(html), ['12', '11']);
		});
		it('folds older scans', () => {
			const closed = intelScans.panelHtml(state());
			assert.ok(closed.indexOf('older (1)') >= 0);
			assert.deepEqual(chipIDs(intelScans.panelHtml(state({ showOlder: true }))), ['12', '11', '5']);
			assert.ok(intelScans.panelHtml(state({ showOlder: true })).indexOf('hide older') >= 0);
		});
		it('only older scans: says so and keeps the fold', () => {
			const html = intelScans.panelHtml(state({ scans: [old] }));
			assert.ok(html.indexOf('No fresh scans.') >= 0);
			assert.ok(html.indexOf('older (1)') >= 0);
			assert.deepEqual(chipIDs(html), []);
		});
		it('expands one scan to its full summary, with delete for own scans', () => {
			const html = intelScans.panelHtml(state({ openScanID: 12 }));
			assert.equal((html.match(/<div class='intel-detail[' ]/g) || []).length, 1);
			assert.ok(html.indexOf("class='intel-delete' data-scan='12'") >= 0);
			assert.ok(html.indexOf("aria-expanded='true'") >= 0);
			const d = intelScans.panelHtml(state({ openScanID: 11 }));
			assert.ok(d.indexOf('Sabre ×2') >= 0);
			assert.equal(d.indexOf('intel-delete'), -1, 'not own');
		});
		it('empty state and no system', () => {
			const html = intelScans.panelHtml(state({ scans: [] }));
			assert.ok(html.indexOf('No scans for this system. Paste one') >= 0);
			assert.ok(html.indexOf('intel-paste') >= 0);
			const none = intelScans.panelHtml(state({ systemID: null }));
			assert.equal(none.indexOf('intel-paste'), -1);
			assert.ok(none.indexOf('Select a system') >= 0);
		});
		it('d-scan chips wait for the type data', () => {
			const html = intelScans.panelHtml(state({ types: null, openScanID: 11 }));
			assert.ok(html.indexOf('loading…') >= 0);
		});
		it('escapes pasted names and errors', () => {
			const html = intelScans.panelHtml(state({ openScanID: 12, error: '<script>x</script>' }));
			assert.equal(html.indexOf('<img'), -1);
			assert.equal(html.indexOf('<b>B'), -1);
			assert.equal(html.indexOf('<script>'), -1);
			assert.ok(html.indexOf('&lt;script&gt;') >= 0);
		});
		it('widget markup', () => {
			const w = intelScans.widgetHtml();
			assert.ok(w.indexOf("id='intelScansWidget' class='gridWidget'") >= 0);
			assert.ok(w.indexOf("class='content'><div class='intel-body'>") >= 0);
		});
	});

	describe('mergeScans', () => {
		it('keeps the rows of scans the server left out, and forgets scans no longer listed', () => {
			const cache = { 1: { names: ['A Pilot'] }, 9: { names: ['Old'] } };
			const m = intelScans.mergeScans([{ id: 2, kind: 'local', data: { names: ['B Pilot'] } }, { id: 1, kind: 'local' }], cache);
			assert.deepEqual(m.scans.map(s => s.data.names[0]), ['B Pilot', 'A Pilot']);
			assert.deepEqual(Object.keys(m.cache).sort(), ['1', '2']);
			assert.deepEqual(m.missing, []);
		});
		it('reports scans without rows', () => {
			const m = intelScans.mergeScans([{ id: 3, kind: 'dscan' }], {});
			assert.deepEqual(m.missing, [3]);
			assert.strictEqual(m.scans[0].data, undefined);
		});
	});

	describe('chain map marker', () => {
		it('only for fresh scans', () => {
			assert.strictEqual(intelScans.markerFor(undefined, 900), null);
			assert.strictEqual(intelScans.markerFor({ dscan: 901 }, 900), null);
			assert.deepEqual(intelScans.markerFor({ dscan: 30, local: 2000 }, 900), { text: 'D', title: 'D-scan just now' });
			assert.deepEqual(intelScans.markerFor({ dscan: 30, local: 120 }, 900), { text: 'DL', title: 'D-scan just now\nLocal 2 min ago' });
		});
		it('is inserted before the node icons, once', () => {
			const node = "<div id='node1' data-nodeid='31000005' class='node'><div class='nodeIcons'></div></div>";
			const marker = intelScans.markerHtml({ text: 'D', title: '<x>' });
			const once = intelScans.insertMarker(node, marker);
			assert.ok(once.indexOf("<span class='intel-marker intel-marker-d' role='img' title='&lt;x&gt;' aria-label='&lt;x&gt;'></span><div class='nodeIcons'>") > 0, once);
			assert.equal(intelScans.insertMarker(once, marker), once);
			assert.equal(intelScans.insertMarker(node, ''), node);
		});
		it('is a dot coloured by kind', () => {
			assert.ok(intelScans.markerHtml({ text: 'L', title: 'x' }).indexOf('intel-marker-l') > 0);
			assert.ok(intelScans.markerHtml({ text: 'DL', title: 'x' }).indexOf('intel-marker-dl') > 0);
			assert.strictEqual(intelScans.markerHtml(null), '');
		});
	});
	describe('looksLikeDscan (page-wide paste)', () => {
		const SAMPLE = "670\tCapsule\tCapsule\t-\n11182\tCheetah\tCheetah\t2.1 AU\n17738\tMachariel\tMachariel\t1,203 km\n35834\tKeepstar\tKeepstar\t-";
		const SIG = "ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t4.32 AU";
		it('accepts a real d-scan copy', () => {
			assert.strictEqual(intelScans.looksLikeDscan(SAMPLE), true);
		});
		it('accepts CRLF line endings and trailing blank lines', () => {
			assert.strictEqual(intelScans.looksLikeDscan(SAMPLE.replace(/\n/g, "\r\n") + "\r\n\r\n  \r\n"), true);
		});
		it('rejects probe-scanner signature pastes', () => {
			assert.strictEqual(intelScans.looksLikeDscan(SIG), false);
			assert.strictEqual(intelScans.looksLikeDscan(SIG + "\nXYZ-789\tCosmic Anomaly\tCombat Site\tBlood Raider Hideaway\t100.0%\t2.10 AU"), false);
		});
		it('rejects a paste mixing sigs and d-scan rows', () => {
			assert.strictEqual(intelScans.looksLikeDscan(SAMPLE + "\n" + SIG), false);
		});
		it('rejects d-scan text with a stray line', () => {
			assert.strictEqual(intelScans.looksLikeDscan(DSCAN), false);	// ends with "broken line"
		});
		it('rejects local member lists and plain text', () => {
			assert.strictEqual(intelScans.looksLikeDscan("Chribba\nBob Smith\nAlice"), false);
			assert.strictEqual(intelScans.looksLikeDscan("hello world"), false);
		});
		it('rejects legacy 3-column rows', () => {
			assert.strictEqual(intelScans.looksLikeDscan("Capsule\tCapsule\t-\nCheetah\tCheetah\t2.1 AU"), false);
		});
		it('rejects type ID 0 and empty types', () => {
			assert.strictEqual(intelScans.looksLikeDscan("0\tThing\tThing\t5 km"), false);
			assert.strictEqual(intelScans.looksLikeDscan("670\tCapsule\t\t-"), false);
		});
		it('rejects empty and non-string text', () => {
			assert.strictEqual(intelScans.looksLikeDscan(""), false);
			assert.strictEqual(intelScans.looksLikeDscan("\n \n"), false);
			assert.strictEqual(intelScans.looksLikeDscan(undefined), false);
			assert.strictEqual(intelScans.looksLikeDscan(null), false);
		});
		it('accepts a d-scan too big to share (decided on shape, the dialog shows the size error)', () => {
			const row = "670\tCapsule\tCapsule\t-\n";
			const tooManyLines = row.repeat(intelScans.MAX_LINES + 1);
			assert.strictEqual(intelScans.looksLikeDscan(tooManyLines), true);
			assert.ok(/Too many lines/.test(intelScans.parse(tooManyLines).error));
			const tooBig = "11182\tCheetah " + "x".repeat(90) + "\tCheetah\t2.1 AU\n";
			const tooManyBytes = tooBig.repeat(Math.ceil(intelScans.MAX_BYTES / tooBig.length) + 1);
			assert.ok(tooManyBytes.split("\n").length - 1 < intelScans.MAX_LINES);
			assert.strictEqual(intelScans.looksLikeDscan(tooManyBytes), true);
			assert.ok(/Too much text/.test(intelScans.parse(tooManyBytes).error));
		});
		it('rejects sig or plain lines within the sampled lines', () => {
			const rows = "670\tCapsule\tCapsule\t-\n".repeat(intelScans.DETECT_SAMPLE_LINES - 1);
			assert.strictEqual(intelScans.looksLikeDscan(rows + SIG), false);
			assert.strictEqual(intelScans.looksLikeDscan(SIG + "\n" + rows), false);
			assert.strictEqual(intelScans.looksLikeDscan(rows + "Chribba"), false);
		});
		it('paste detection is on by default', () => {
			assert.strictEqual(intelScans.pasteDetect(undefined), true);
			assert.strictEqual(intelScans.pasteDetect({}), true);
			assert.strictEqual(intelScans.pasteDetect({ intelScans: {} }), true);
			assert.strictEqual(intelScans.pasteDetect({ intelScans: { pasteDetect: true } }), true);
			assert.strictEqual(intelScans.pasteDetect({ intelScans: { pasteDetect: false } }), false);
		});
	});

	describe('page-wide paste handler', () => {
		const SAMPLE = "670\tCapsule\tCapsule\t-\r\n11182\tCheetah\tCheetah\t2.1 AU\r\n";
		let log, vals, htmls, saved;

		// Minimal jQuery stand-in: every selector gives a chainable object; val/html/trigger calls are logged in order
		const stub$ = function(x) {
			const name = typeof x === "string" ? x : "<" + (x && x.id) + ">";
			const o = {
				length: 1,
				find: (sel) => stub$(name + " " + sel),
				parent: () => stub$(name + " <parent>"),
				val: function(v) {
					if (v === undefined) { return vals[name] || ""; }
					vals[name] = v; log.push(["val", name, v]); return o;
				},
				html: function(h) { htmls[name] = h; log.push(["html", name]); return o; },
				trigger: function(ev) { log.push(["trigger", name, ev]); return o; },
				prop: () => o, toggleClass: () => o, addClass: () => o
			};
			return o;
		};
		const event = (text, id) => {
			const e = { target: { id: id === undefined ? "clipboard" : id }, calls: [],
				clipboardData: { getData: (type) => { e.calls.push("getData:" + type); return text; } } };
			["preventDefault", "stopImmediatePropagation", "stopPropagation"].forEach((m) => { e[m] = () => e.calls.push(m); });
			return e;
		};

		beforeEach(() => {
			log = []; vals = {}; htmls = {};
			saved = { $: global.$, options: global.options, viewingSystemID: global.viewingSystemID,
				openDialog: intelScans.openDialog, renderPreview: intelScans.renderPreview };
			global.$ = stub$;
			global.options = {};
			global.viewingSystemID = 30000142;
			intelScans.openDialog = (id) => log.push(["open", id]);
			intelScans.renderPreview = () => log.push(["preview"]);
		});
		afterEach(() => {
			["$", "options", "viewingSystemID"].forEach((k) => { if (saved[k] === undefined) { delete global[k]; } else { global[k] = saved[k]; } });
			intelScans.openDialog = saved.openDialog;
			intelScans.renderPreview = saved.renderPreview;
		});

		it('opens the dialog for the viewed system and fills it after opening', () => {
			const e = event(SAMPLE);
			assert.strictEqual(intelScans.onPaste(e), true);
			assert.ok(e.calls.indexOf("preventDefault") >= 0);
			assert.ok(e.calls.indexOf("stopImmediatePropagation") >= 0);
			assert.deepStrictEqual(log, [
				["val", "<clipboard>", ""],
				["trigger", "<clipboard>", "blur"],
				["open", 30000142],
				["val", "#dialog-intelScan .intel-text", SAMPLE],
				["preview"]
			]);
		});
		it('ignores pastes that are not on the hidden #clipboard box', () => {
			const e = event(SAMPLE, "intel-text");
			assert.strictEqual(intelScans.onPaste(e), false);
			assert.deepStrictEqual(e.calls, []);
			assert.deepStrictEqual(log, []);
			assert.strictEqual(intelScans.onPaste({}), false);
		});
		const untouched = (setup, text) => {
			setup();
			const e = event(text === undefined ? SAMPLE : text);
			assert.strictEqual(intelScans.onPaste(e), false);
			assert.deepStrictEqual(e.calls.filter((c) => c.indexOf("getData") !== 0), []);
			assert.deepStrictEqual(log, []);
		};
		it('does nothing when the Intel feature is off', () => {
			untouched(() => { global.options = { intelScans: { enabled: false } }; });
		});
		it('does nothing when paste detection is off', () => {
			untouched(() => { global.options = { intelScans: { pasteDetect: false } }; });
		});
		it('does nothing without a valid viewed system', () => {
			untouched(() => { global.viewingSystemID = 0; });
			untouched(() => { delete global.viewingSystemID; });
		});
		it('leaves non-d-scan pastes to upstream', () => {
			untouched(() => {}, "ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t4.32 AU");
			untouched(() => {}, "Chribba\nBob");
			untouched(() => {}, "");
		});
		it('the dialog preview shows the size error for a d-scan too big to share', () => {
			intelScans.renderPreview = saved.renderPreview;
			vals["#dialog-intelScan .intel-text"] = "670\tCapsule\tCapsule\t-\n".repeat(intelScans.MAX_LINES + 1);
			intelScans.renderPreview();
			assert.ok(/intel-warn/.test(htmls["#dialog-intelScan .intel-preview"]));
			assert.ok(/Too many lines/.test(htmls["#dialog-intelScan .intel-preview"]));
		});
	});
});
