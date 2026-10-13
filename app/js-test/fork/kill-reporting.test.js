const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/kill-reporting');

describe('Kill reporting', () => {
	const kr = () => killReporting;

	describe('settings', () => {
		it('no options gives the defaults', () => {
			assert.deepEqual(kr().settings(undefined), kr().defaults);
			assert.deepEqual(kr().settings({}), kr().defaults);
			assert.deepEqual(kr().settings({ killReporting: null }), kr().defaults);
		});
		it('does not hand out the defaults object itself', () => {
			const s = kr().settings({});
			s.sounds.loss.volume = 1;
			assert.equal(kr().defaults.sounds.loss.volume, 80);
		});
		it('keeps valid stored values', () => {
			const s = kr().settings({ killReporting: { enabled: false, popup: false, threshold: 10,
				sounds: { gank: { sound: 'tone-klaxon', volume: 30 }, loss: { sound: 'speech', volume: 100 } } } });
			assert.equal(s.enabled, false);
			assert.equal(s.popup, false);
			assert.equal(s.threshold, 10);
			assert.deepEqual(s.sounds.gank, { sound: 'tone-klaxon', volume: 30 });
			assert.deepEqual(s.sounds.loss, { sound: 'speech', volume: 100 });
			assert.deepEqual(s.sounds.neutral, { sound: 'neutral-bot', volume: 80 });
		});
		it('missing enabled/popup mean on', () => {
			const s = kr().settings({ killReporting: { threshold: 3 } });
			assert.equal(s.enabled, true);
			assert.equal(s.popup, true);
		});
		it('accepts numeric strings (form values)', () => {
			const s = kr().settings({ killReporting: { threshold: '7', sounds: { kill: { sound: 'kill-alt', volume: '45' } } } });
			assert.equal(s.threshold, 7);
			assert.deepEqual(s.sounds.kill, { sound: 'kill-alt', volume: 45 });
		});
		it('clamps out-of-range numbers', () => {
			const s = kr().settings({ killReporting: { threshold: 500, sounds: { kill: { volume: 150 }, loss: { volume: -5 } } } });
			assert.equal(s.threshold, 50);
			assert.equal(s.sounds.kill.volume, 100);
			assert.equal(s.sounds.loss.volume, 0);
			assert.equal(kr().settings({ killReporting: { threshold: 0 } }).threshold, 1);
		});
		it('tolerates garbage', () => {
			const s = kr().settings({ killReporting: { threshold: 'lots', sounds: { neutral: 'loud', gank: { sound: 'kill-bot', volume: 'x' }, kill: { sound: '../evil' } } } });
			assert.equal(s.threshold, 5);
			assert.deepEqual(s.sounds.neutral, { sound: 'neutral-bot', volume: 80 });
			assert.deepEqual(s.sounds.gank, { sound: 'gank-bot', volume: 80 }, "another category's voice file is not allowed");
			assert.equal(s.sounds.kill.sound, 'kill-bot');
			assert.deepEqual(kr().settings({ killReporting: 'yes' }), kr().defaults);
			assert.deepEqual(kr().settings({ killReporting: { sounds: [1, 2] } }).sounds, kr().defaults.sounds);
		});
	});

	describe('enabled', () => {
		it('is on unless explicitly false', () => {
			assert.equal(kr().enabled(undefined), true);
			assert.equal(kr().enabled({}), true);
			assert.equal(kr().enabled({ killReporting: {} }), true);
			assert.equal(kr().enabled({ killReporting: { enabled: false } }), false);
		});
	});

	describe('classify', () => {
		const kill = (pilots, victim, attacker) => ({ attackerCharacterCount: pilots, friendlyVictim: !!victim, friendlyAttacker: !!attacker });
		it('friendly victim is a loss, even with friendly attackers and many pilots', () => {
			assert.equal(kr().classify(kill(1, true, false), 5), 'loss');
			assert.equal(kr().classify(kill(20, true, true), 5), 'loss');
		});
		it('friendly attacker is a kill, whatever the size', () => {
			assert.equal(kr().classify(kill(1, false, true), 5), 'kill');
			assert.equal(kr().classify(kill(30, false, true), 5), 'kill');
		});
		it('threshold edge: 5 pilots is neutral, 6 is a gank at threshold 5', () => {
			assert.equal(kr().classify(kill(5), 5), 'neutral');
			assert.equal(kr().classify(kill(6), 5), 'gank');
		});
		it('uses the given threshold', () => {
			assert.equal(kr().classify(kill(6), 10), 'neutral');
			assert.equal(kr().classify(kill(2), 1), 'gank');
		});
		it('bad threshold falls back to 5', () => {
			assert.equal(kr().classify(kill(6), undefined), 'gank');
			assert.equal(kr().classify(kill(5), 'x'), 'neutral');
		});
		it('missing data is neutral', () => {
			assert.equal(kr().classify({}, 5), 'neutral');
			assert.equal(kr().classify(null, 5), 'neutral');
			assert.equal(kr().classify({ attackerCharacterCount: 0 }, 5), 'neutral');
		});
		it('only true counts as friendly', () => {
			assert.equal(kr().classify({ friendlyVictim: 'false', friendlyAttacker: 1, attackerCharacterCount: 1 }, 5), 'neutral');
		});
	});

	describe('soundOptions', () => {
		it('lists 6 voices, 5 tones, browser voice and none', () => {
			const list = kr().soundOptions('gank');
			assert.equal(list.length, 13);
			assert.deepEqual(list.map(o => o.id), ['gank-bot', 'gank-bot-deep', 'gank-bot-high', 'gank-radio', 'gank-alert', 'gank-alt',
				'tone-blip', 'tone-double-beep', 'tone-klaxon', 'tone-sonar', 'tone-chime', 'speech', 'none']);
		});
		it('files live under sounds/kill-reporting', () => {
			const list = kr().soundOptions('loss');
			assert.equal(list[0].file, 'sounds/kill-reporting/loss-bot.mp3');
			assert.equal(list.filter(o => o.id === 'tone-chime')[0].file, 'sounds/kill-reporting/tone-chime.mp3');
			assert.equal(list.filter(o => o.id === 'speech')[0].file, undefined);
			assert.equal(list.filter(o => o.id === 'none')[0].file, undefined);
		});
		it('labels the default and the alternative wording', () => {
			const list = kr().soundOptions('neutral');
			assert.equal(list[0].label, 'Robot (default)');
			assert.ok(list[5].label.indexOf('Kill reported in chain') >= 0);
		});
		it('default sound of every category is in its list', () => {
			kr().categories.forEach(c => assert.ok(kr().soundOptions(c).some(o => o.id === kr().defaults.sounds[c].sound), c));
		});
		it('unknown category has no sounds', () => assert.deepEqual(kr().soundOptions('bogus'), []));
	});

	describe('chainSystemIDs', () => {
		const node = (id, systemID, cls) => ({ v: id, systemID: systemID, f: "<div id='node" + id + "' data-nodeid='" + systemID + "' class='node " + (cls || '') + "'></div>" });
		const row = (id, systemID, parent, cls, extra) => Object.assign({ c: [node(id, systemID, cls), { v: parent }] }, extra || {});
		const rows = [
			row(1, 31000001, null, 'top-level'),
			row(2, '31000002', 1),							// systemID as a string (from signatures)
			row(3, 30000142, 1),
			row(4, '31000005|1234', 1),					// unknown system placeholder
			row(5, 3, 1),									// generic system type index
			row(6, 30000144, 3, 'calc'),					// calculated gate route
			row(7, 30000145, 3, '', { pathHome: [{ systemID: 30000145, path: [1, 2] }] }),	// calculated by pathHome
			{ c: [{ v: 'dest-1', systemID: 30002187, f: "<div class='node destination-node'></div>" }, { v: 1 }], destination: true },
			row(9, 31000001, 2, 'loop'),					// loop: same system twice
			row(10, 32000001, 1),							// abyssal / out of range
			{ c: [false, { v: null }] },
			null,
			{}
		];
		it('extracts real, unique system IDs, sorted', () => {
			assert.deepEqual(kr().chainSystemIDs(rows), [30000142, 31000001, 31000002]);
		});
		it('empty / garbage input gives []', () => {
			assert.deepEqual(kr().chainSystemIDs([]), []);
			assert.deepEqual(kr().chainSystemIDs(null), []);
			assert.deepEqual(kr().chainSystemIDs({}), []);
		});
		it('reads the current chain map without arguments', () => {
			const had = Object.prototype.hasOwnProperty.call(global, 'chain'), previous = global.chain;
			global.chain = { data: { map: { rows: [row(1, 31000001, null), row(2, 31000002, 1)] } } };
			try {
				assert.deepEqual(kr().chainSystemIDs(), [31000001, 31000002]);
				global.chain = { data: {} };
				assert.deepEqual(kr().chainSystemIDs(), []);
			} finally {
				if (had) { global.chain = previous; } else { delete global.chain; }
			}
		});
	});

	describe('plan', () => {
		const k = (id, systemID, pilots, victim, attacker) => ({ killID: id, systemID: systemID, attackerCharacterCount: pilots, friendlyVictim: !!victim, friendlyAttacker: !!attacker });
		it('only reports kills in the chain', () => {
			const p = kr().plan([k(1, 31000001, 2), k(2, 30000142, 2)], [31000001], 5);
			assert.deepEqual(p.reports.map(r => r.kill.killID), [1]);
			assert.deepEqual(p.sounds, ['neutral']);
		});
		it('one sound per category, highest priority first', () => {
			const p = kr().plan([k(1, 31000001, 2), k(2, 31000001, 9), k(3, 31000001, 1, true), k(4, 31000001, 3), k(5, 31000001, 1, false, true)], ['31000001'], 5);
			assert.deepEqual(p.sounds, ['loss', 'kill', 'gank', 'neutral']);
			assert.deepEqual(p.reports.map(r => r.category), ['neutral', 'gank', 'loss', 'neutral', 'kill']);
		});
		it('drops duplicate kill IDs and garbage', () => {
			const p = kr().plan([k(1, 31000001, 2), k(1, 31000001, 2), null], [31000001], 5);
			assert.equal(p.reports.length, 1);
			assert.deepEqual(kr().plan(null, [31000001], 5), { reports: [], sounds: [] });
		});
	});

	describe('toastHtml', () => {
		it('escapes the system name and links to zKillboard', () => {
			const html = kr().toastHtml({ killID: 139038661, victimShipTypeID: 672, attackerCharacterCount: 3, totalValue: 12345678 }, 'gank', '<b>J1</b>');
			assert.ok(html.indexOf('&lt;b&gt;J1&lt;/b&gt;') >= 0);
			assert.ok(html.indexOf("https://zkillboard.com/kill/139038661/") >= 0);
			assert.ok(html.indexOf('3 pilots') >= 0);
			assert.ok(html.indexOf('12.3M ISK') >= 0);
			assert.ok(html.indexOf('Large gank') >= 0);
			assert.ok(html.indexOf('kill-toast-gank') >= 0);
		});
		it('ignores non-numeric ids', () => {
			const html = kr().toastHtml({ killID: "1'><script>", victimShipTypeID: 'x', systemID: "31000001'>" }, 'loss', 'J1');
			assert.ok(html.indexOf('<script>') < 0);
			assert.ok(html.indexOf('kill-toast-ship') < 0);
			assert.ok(html.indexOf('data-systemid') < 0);
		});
		it('shows the hole label, system and class as on the chain map', () => {
			const html = kr().toastHtml({ killID: 1, systemID: 31000001 }, 'neutral', { label: 'A6', name: 'J123456', type: 'C3' });
			assert.ok(html.indexOf("<span class='kill-toast-label'>A6</span> J123456 <span class='kill-toast-type'>C3</span>") >= 0);
			assert.ok(html.indexOf("data-systemid='31000001'") >= 0, 'clickable to find the node');
		});
		it('escapes the label and class', () => {
			const html = kr().toastHtml({ killID: 1 }, 'neutral', { label: '<i>A</i>', name: 'J1', type: '<b>' });
			assert.ok(html.indexOf('<i>') < 0 && html.indexOf('<b>') < 0);
			assert.ok(html.indexOf('&lt;i&gt;A&lt;/i&gt;') >= 0);
		});
		it('leaves out a missing label', () => {
			const html = kr().toastHtml({ killID: 1 }, 'neutral', { name: 'Amarr', type: 'HS' });
			assert.ok(html.indexOf('kill-toast-label') < 0);
			assert.ok(html.indexOf("Amarr <span class='kill-toast-type'>HS</span>") >= 0);
		});
	});

	describe('chainLabel', () => {
		const row = (id, pathHome, extra) => Object.assign({ c: [{ v: String(id), systemID: id, f: "<div class='node'></div>" }], pathHome: pathHome }, extra || {});
		it('uses the hole name, else the first 3 letters of the signature', () => {
			const rows = [
				row(30000142, []),
				row(31000001, [{ name: 'A6', signatureID: 'abc123' }]),
				row(31000002, [{ name: '', signatureID: 'xyz789' }])
			];
			assert.equal(kr().chainLabel(rows, 31000001), 'A6');
			assert.equal(kr().chainLabel(rows, '31000002'), 'XYZ');
			assert.equal(kr().chainLabel(rows, 30000142), '', 'home has no hole');
			assert.equal(kr().chainLabel(rows, 31000009), '', 'not on the map');
		});
		it('lists every label of a system on the map twice, once each', () => {
			const rows = [
				row(31000001, [{ name: 'A6' }]),
				row(31000001, [{ name: 'B2' }]),
				row(31000001, [{ name: 'A6' }])
			];
			assert.equal(kr().chainLabel(rows, 31000001), 'A6, B2');
		});
		it('skips route nodes and tolerates garbage', () => {
			assert.equal(kr().chainLabel([row(31000001, [{ name: 'A6', path: [1] }])], 31000001), '');
			assert.equal(kr().chainLabel(null, 31000001), '');
			assert.equal(kr().chainLabel([null, {}, { c: [] }], 31000001), '');
		});
	});

	describe('placeText and notificationText', () => {
		it('formats the place', () => {
			assert.equal(kr().placeText({ label: 'A6', name: 'J123456', type: 'C3' }), 'A6 · J123456 (C3)');
			assert.equal(kr().placeText({ name: 'Amarr', type: 'HS' }), 'Amarr (HS)');
			assert.equal(kr().placeText('Jita'), 'Jita');
			assert.equal(kr().placeText(null), '');
		});
		it('builds a plain-text notification', () => {
			const n = kr().notificationText({ attackerCharacterCount: 1, totalValue: 2500000000 }, 'loss', { label: 'B2', name: 'J1', type: 'C5' });
			assert.equal(n.title, 'Friendly loss in B2 · J1 (C5)');
			assert.equal(n.body, '1 pilot — 2.50B ISK');
			assert.equal(kr().notificationText({}, 'gank', null).title, 'Large gank in the chain');
		});
	});

	describe('mark', () => {
		const MARK = () => kr().MARK_MS;
		it('marks a system and restarts the timer on every kill', () => {
			const marks = {};
			kr().mark(marks, 31000001, 'neutral', 1000);
			assert.deepEqual(marks[31000001], { category: 'neutral', until: 1000 + MARK() });
			kr().mark(marks, 31000001, 'neutral', 5000);
			assert.equal(marks[31000001].until, 5000 + MARK());
		});
		it('keeps the higher-priority category while it lasts', () => {
			const marks = {};
			kr().mark(marks, 31000001, 'loss', 0);
			kr().mark(marks, 31000001, 'neutral', 10);
			assert.equal(marks[31000001].category, 'loss');
			kr().mark(marks, 31000001, 'neutral', MARK() + 11);
			assert.equal(marks[31000001].category, 'neutral', 'expired loss mark is replaced');
			kr().mark(marks, 31000001, 'gank', MARK() + 12);
			assert.equal(marks[31000001].category, 'gank');
		});
		it('expires old marks', () => {
			const marks = {};
			kr().mark(marks, 1, 'kill', 0);
			kr().mark(marks, 2, 'kill', 100);
			kr().expireMarks(marks, MARK() + 50);
			assert.deepEqual(Object.keys(marks), ['2']);
		});
	});

	describe('new settings', () => {
		it('desktop alerts and map markers are on unless switched off', () => {
			assert.equal(kr().settings({}).desktop, true);
			assert.equal(kr().settings({}).marker, true);
			const s = kr().settings({ killReporting: { desktop: false, marker: false } });
			assert.equal(s.desktop, false);
			assert.equal(s.marker, false);
		});
	});

	describe('formatISK', () => {
		it('formats', () => {
			assert.equal(kr().formatISK(15951.5), '16K');
			assert.equal(kr().formatISK(12345678), '12.3M');
			assert.equal(kr().formatISK(1.2e9), '1.20B');
			assert.equal(kr().formatISK(0), '');
			assert.equal(kr().formatISK('x'), '');
		});
	});
});
