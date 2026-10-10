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
			assert.ok(once.indexOf("<span class='intel-marker' title='&lt;x&gt;'>D</span><div class='nodeIcons'>") > 0);
			assert.equal(intelScans.insertMarker(once, marker), once);
			assert.equal(intelScans.insertMarker(node, ''), node);
		});
	});
});
