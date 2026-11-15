const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { include, loadJSON } = require('../helpers/helpers');
include('app/js/fork/rolling-calculator');
include('app/js/fork/fleet-mass');

const root = path.join(__dirname, '..', '..', '..');
const fixture = name => fs.readFileSync(path.join(root, 'app/js-test/testdata/fleet-mass', name), 'utf8');
const MASS = loadJSON(path.join(root, 'tools/mass'));
const TYPES = loadJSON(path.join(root, 'public/intel/types'));	// the d-scan feature's static type data
const kt = n => n * 1e6;
const byName = (fleet, name) => fleet.hulls.filter(h => h.name === name)[0];
// B274: C2 -> high-sec, 2,000,000 t total, 375,000 t per jump
const B274 = { totalKg: kt(2000), jumpKg: kt(375) };

describe('Fleet mass check', () => {
	describe('enabled', () => {
		it('is on by default', () => {
			assert.strictEqual(fleetMass.enabled(undefined), true);
			assert.strictEqual(fleetMass.enabled({}), true);
			assert.strictEqual(fleetMass.enabled({ fleetMass: {} }), true);
		});
		it('is off only when switched off', () => assert.strictEqual(fleetMass.enabled({ fleetMass: { enabled: false } }), false));
	});

	describe('parse: fleet composition (Fleet window > Fleet Composition, copied)', () => {
		const fleet = fleetMass.parse(fixture('fleetcomp.txt'), MASS);
		it('detects the format', () => assert.strictEqual(fleet.format, 'fleet'));
		it('counts hulls from the ship column', () => {
			assert.strictEqual(fleet.ships, 8);
			assert.strictEqual(byName(fleet, 'Guardian').count, 2);
			assert.strictEqual(byName(fleet, 'Paladin').count, 1);
			assert.strictEqual(byName(fleet, 'Capsule').count, 1);
		});
		it('uses hull masses from mass.json (24.01 Marauder mass)', () => {
			assert.strictEqual(byName(fleet, 'Paladin').hullKg, 128000000);
			assert.strictEqual(byName(fleet, 'Sin').hullKg, 106300000);
		});
		it('keeps the pasted ship group', () => {
			assert.strictEqual(byName(fleet, 'Kronos').group, 'Marauder');
			assert.strictEqual(byName(fleet, 'Guardian').group, 'Logistics');
		});
		it('reports hulls it does not know', () => assert.deepStrictEqual(fleet.unknown, [{ name: 'Not A Real Hull', count: 1 }]));
		it('sorts heaviest first', () => assert.strictEqual(fleet.hulls[0].name, 'Paladin'));
		it('reads a row without the wing column and trailing tabs', () => {
			const f = fleetMass.parse('Some Pilot\tJita\tRifter\tFrigate\tSquad Member\t0 - 0 - 0\t\t\r\n', MASS);
			assert.strictEqual(f.format, 'fleet');
			assert.strictEqual(byName(f, 'Rifter').count, 1);
		});
	});

	describe('parse: d-scan', () => {
		const fleet = fleetMass.parse(fixture('dscan.txt'), MASS, TYPES);
		it('detects the format', () => assert.strictEqual(fleet.format, 'dscan'));
		it('counts ships by type id', () => {
			assert.strictEqual(byName(fleet, 'Paladin').count, 2);
			assert.strictEqual(byName(fleet, 'Sin').count, 1);
			assert.strictEqual(byName(fleet, 'Ishtar').count, 1);
			assert.strictEqual(fleet.ships, 4);
		});
		it('groups by the known names when the paste has no group', () => assert.strictEqual(byName(fleet, 'Sin').group, 'Black Ops'));
		it('counts rows that are not ships (structures, drones) as left out, not as unrecognised', () => {
			assert.strictEqual(fleet.skipped, 2);
			assert.deepStrictEqual(fleet.unknown, []);
		});
		it('a normal d-scan (sun, planets, gates, wrecks) reads as ships plus rows left out', () => {
			const f = fleetMass.parse('3796\tJita\tSun G5 (Yellow)\t12 AU\n2015\tJita IV\tPlanet (Temperate)\t2 AU\n' +
				'16\tPerimeter\tStargate (Caldari System)\t5 AU\n26468\tRifter Wreck\tSmall Wreck\t20 km\n587\tBob\'s Rifter\tRifter\t20 km', MASS, TYPES);
			assert.strictEqual(f.ships, 1);
			assert.strictEqual(f.skipped, 4);
			assert.deepStrictEqual(f.unknown, []);
			const h = fleetMass.resultHtml(f, fleetMass.check(f, B274), {});
			assert.ok(h.includes('4 d-scan rows that aren&#39;t ships left out') || h.includes("4 d-scan rows that aren't ships left out"), h);
			assert.ok(!h.includes('Not recognised'));
		});
		it('falls back to the type name when the type id is not in mass.json', () => {
			const f = fleetMass.parse('99999999\tNew Paladin\tPaladin\t-', MASS, TYPES);
			assert.strictEqual(byName(f, 'Paladin').count, 1);
		});
		it('lists a ship type missing from mass.json as not recognised', () => {
			const types = { types: { '99999998': ['Brand New Hull', 25] }, groups: { '25': ['Frigate', 'ship', 'frigate'] } };
			const f = fleetMass.parse('99999998\tSomething\tBrand New Hull\t5 km', MASS, types);
			assert.deepStrictEqual(f.unknown, [{ name: 'Brand New Hull', count: 1 }]);
			assert.strictEqual(f.skipped, 0);
		});
		it('a type nobody knows, or no type data, is left out (not called unrecognised)', () => {
			assert.strictEqual(fleetMass.parse('99999998\tSomething\tBrand New Thing\t5 km', MASS, TYPES).skipped, 1);
			assert.strictEqual(fleetMass.parse('35832\tHome\tAstrahus\t5 km', MASS).skipped, 1);
		});
		it('reads the old three-column d-scan by type name', () => {
			const f = fleetMass.parse('My Paladin\tPaladin\t-\nTower\tCaldari Control Tower\t5 km', MASS, TYPES);
			assert.strictEqual(byName(f, 'Paladin').count, 1);
			assert.strictEqual(f.skipped, 1);
			assert.deepStrictEqual(f.unknown, []);
		});
		it('isShipType', () => {
			assert.strictEqual(fleetMass.isShipType(28659, 'Paladin', TYPES), true);
			assert.strictEqual(fleetMass.isShipType(35832, 'Astrahus', TYPES), false);
			assert.strictEqual(fleetMass.isShipType(null, 'acolyte i', TYPES), false);
			assert.strictEqual(fleetMass.isShipType(1, 'nope', TYPES), null);
			assert.strictEqual(fleetMass.isShipType(28659, 'Paladin', undefined), null);
		});
	});

	describe('parse: ship list', () => {
		const fleet = fleetMass.parse(fixture('list.txt'), MASS);
		it('detects the format', () => assert.strictEqual(fleet.format, 'list'));
		it('reads counts written several ways', () => {
			assert.strictEqual(byName(fleet, 'Paladin').count, 2);		// 2x Paladin
			assert.strictEqual(byName(fleet, 'Kronos').count, 3);		// Kronos x3
			assert.strictEqual(byName(fleet, 'Sin').count, 1);			// - Sin
			assert.strictEqual(byName(fleet, 'Redeemer').count, 1);		// [Redeemer, fit name] (EFT header)
			assert.strictEqual(byName(fleet, 'Guardian').count, 4);		// guardian 4 (any case)
			assert.strictEqual(byName(fleet, 'Marshal').count, 2);		// Marshal<TAB>2
		});
		it('reports lines it cannot read', () => assert.deepStrictEqual(fleet.unknown, [{ name: 'Not a ship', count: 1 }]));
		it('ignores absurd counts', () => {
			const f = fleetMass.parse('5000 Rifter', MASS);
			assert.strictEqual(f.ships, 0);
			assert.strictEqual(f.unknown.length, 1);
		});
		it('empty paste', () => {
			const f = fleetMass.parse('  \n\n', MASS);
			assert.strictEqual(f.format, '');
			assert.strictEqual(f.ships, 0);
			assert.strictEqual(f.lines, 0);
		});
		it('missing mass table', () => assert.strictEqual(fleetMass.parse('Paladin', undefined).ships, 0));
	});

	describe('hullPass', () => {
		it('hot adds the 50,000 t prop mod (the mass log rule)', () => assert.deepStrictEqual(fleetMass.hullPass(kt(128), kt(375), true),
			{ kg: kt(178), hot: true, fits: true, coldOnly: false }));
		it('cold is the hull', () => assert.strictEqual(fleetMass.hullPass(kt(128), kt(375), false).kg, kt(128)));
		it('a hull over the jump limit does not fit', () => assert.strictEqual(fleetMass.hullPass(kt(128), kt(62), true).fits, false));
		it('goes cold when hot would be over the limit', () => assert.deepStrictEqual(fleetMass.hullPass(kt(340), kt(375), true),
			{ kg: kt(340), hot: false, fits: true, coldOnly: true }));
		it('capitals add 500,000 t hot', () => assert.strictEqual(fleetMass.hullPass(kt(1260), kt(2000), true).kg, kt(1760)));
		it('the prop mod follows the hull size', () => {
			assert.strictEqual(fleetMass.propKg(32000), 0);				// capsule
			assert.strictEqual(fleetMass.propKg(kt(1.285)), kt(0.5));		// Sabre: 1MN
			assert.strictEqual(fleetMass.propKg(kt(11.98)), kt(5));		// Guardian: 10/50MN
			assert.strictEqual(fleetMass.propKg(kt(20)), kt(50));			// Nestor: 100/500MN
			assert.strictEqual(fleetMass.propKg(kt(500)), kt(50));
			assert.strictEqual(fleetMass.propKg(kt(800)), kt(500));		// Rorqual
		});
		it('hulls whose mass misleads go by name', () => {
			assert.strictEqual(fleetMass.propKg(kt(4.5), 'Porpoise'), kt(5));		// 10MN/50MN, not a 1MN
			assert.strictEqual(fleetMass.propKg(kt(20), 'Procurer'), kt(5));
			assert.strictEqual(fleetMass.propKg(kt(20), 'Skiff'), kt(5));
			assert.strictEqual(fleetMass.propKg(kt(20), 'Bustard'), kt(5));
			assert.strictEqual(fleetMass.propKg(kt(19.2), 'Mastodon'), kt(5));
			assert.strictEqual(fleetMass.propKg(kt(20), 'Mackinaw ORE Development Edition'), kt(5));
			assert.strictEqual(fleetMass.propKg(kt(20), 'Nestor'), kt(50));
		});
		it('or by the pasted ship group', () => {
			assert.strictEqual(fleetMass.propKg(kt(20), 'Some Barge', 'Mining Barge'), kt(5));
			assert.strictEqual(fleetMass.propKg(kt(21), 'Some Hauler', 'Deep Space Transport'), kt(5));
			assert.strictEqual(fleetMass.propKg(kt(15), 'Some Battleship', 'Battleship'), kt(50));
			assert.strictEqual(fleetMass.propKg(kt(1200), 'Some Capital', 'Mining Barge'), kt(500));	// capitals stay capital
		});
		it('only the full name counts, not a prefix', () => assert.strictEqual(fleetMass.propKg(kt(20), 'Hulking Thing'), kt(50)));
		it('the hull pass uses the name', () => {
			const MASS_PORPOISE = fleetMass.parse('Porpoise', MASS);
			const r = fleetMass.check(MASS_PORPOISE, Object.assign({ usedKg: 0, massState: 'stable' }, B274));
			assert.strictEqual(byName(r, 'Porpoise').pass.kg, kt(9.5));
		});
		it('no jump limit: fits is unknown', () => assert.strictEqual(fleetMass.hullPass(kt(10), null, true).fits, null));
	});

	describe('countIn', () => {
		const fresh = fleetMass.freshRange(kt(2000));	// 1,800,000 - 2,200,000 t
		it('fresh B274: hot Paladins', () => assert.deepStrictEqual(fleetMass.countIn(fresh, kt(178)), { safe: 10, most: 13 }));
		it('fresh B274: hot Redeemers', () => assert.deepStrictEqual(fleetMass.countIn(fresh, kt(162.7)), { safe: 11, most: 14 }));
		it('a pass equal to the remaining mass is not safe', () => assert.deepStrictEqual(fleetMass.countIn(fresh, kt(900)), { safe: 1, most: 3 }));
		it('unknown range or mass', () => {
			assert.strictEqual(fleetMass.countIn({ known: false }, kt(100)), null);
			assert.strictEqual(fleetMass.countIn(fresh, 0), null);
		});
		it('uses the mass state (destab: under half left)', () => {
			const r = rollingCalc.remaining(kt(2000), 0, 'destab');	// 180,000 - 1,100,000 t
			assert.deepStrictEqual(fleetMass.countIn(r, kt(178)), { safe: 1, most: 7 });
		});
	});

	describe('check', () => {
		const fleet = fleetMass.parse(fixture('fleetcomp.txt'), MASS);
		it('a fresh B274 takes this fleet safely', () => {
			const r = fleetMass.check(fleet, Object.assign({ usedKg: 0, massState: 'stable' }, B274));
			assert.strictEqual(r.verdict, 'safe');
			assert.strictEqual(r.passes, 8);
			assert.strictEqual(r.tooHeavy, 0);
			assert.strictEqual(byName(r, 'Paladin').pass.kg, kt(178));
			assert.deepStrictEqual(byName(r, 'Paladin').freshCount, { safe: 10, most: 13 });
		});
		it('out and back doubles the passes', () => {
			const r = fleetMass.check(fleet, Object.assign({ usedKg: 0, massState: 'stable' }, B274), { back: true });
			assert.strictEqual(r.passes, 16);
			assert.strictEqual(r.verdict, 'safe');
		});
		it('a destab hole: counts the safe passes lightest first and when it closes', () => {
			const r = fleetMass.check(fleet, Object.assign({ usedKg: 0, massState: 'destab' }, B274));
			// remaining 180,000 - 1,100,000 t; lightest first, hot: pod 32 t, Sabre 1,785 t, 2 Guardians 16,980 t,
			// Damnation 18,500 t (54,277 t so far), then the Sin 156,300 t takes it to 210,577 t: over the 180,000 t minimum
			assert.strictEqual(r.verdict, 'may');
			assert.strictEqual(r.safePasses, 5);
			assert.strictEqual(r.closedBy, null);
		});
		it('a critical hole closes', () => {
			const r = fleetMass.check(fleet, Object.assign({ usedKg: 0, massState: 'critical' }, B274));
			assert.strictEqual(r.verdict, 'collapse');
			assert.ok(r.closedBy >= 1 && r.closedBy <= r.passes);
		});
		it('logged mass counts against the hole', () => {
			const r = fleetMass.check(fleet, Object.assign({ usedKg: kt(1700), massState: 'stable' }, B274));
			assert.notStrictEqual(r.verdict, 'safe');
		});
		it('cold when prop mods are off', () => {
			const r = fleetMass.check(fleet, Object.assign({ usedKg: 0 }, B274), { hot: false });
			assert.strictEqual(byName(r, 'Paladin').pass.kg, kt(128));
		});
		it('battleships do not fit a 62,000 t hole and are left out of the passes', () => {
			const r = fleetMass.check(fleet, { totalKg: kt(1000), jumpKg: kt(62), usedKg: 0, massState: 'stable' });
			assert.strictEqual(r.tooHeavy, 3);
			assert.strictEqual(r.passes, 5);
			assert.strictEqual(byName(r, 'Paladin').pass.fits, false);
			assert.strictEqual(byName(r, 'Paladin').freshCount, null);
		});
		it('unknown hole mass: no verdict or counts, the jump limit still applies', () => {
			const r = fleetMass.check(fleet, { totalKg: null, jumpKg: kt(62) });
			assert.strictEqual(r.verdict, 'unknown');
			assert.strictEqual(r.safePasses, null);
			assert.strictEqual(byName(r, 'Paladin').pass.fits, false);
		});
		it('empty fleet', () => assert.strictEqual(fleetMass.check(fleetMass.parse('', MASS), B274).verdict, 'unknown'));
	});

	describe('reference', () => {
		it('Marauders and Black Ops per fresh hole, by the heaviest hull', () => {
			const ref = fleetMass.reference(MASS, B274, true);
			assert.deepStrictEqual(ref.map(r => [r.group, r.name, r.count]), [
				['Marauder', 'Paladin', { safe: 10, most: 13 }],
				['Black Ops', 'Widow', fleetMass.countIn(fleetMass.freshRange(kt(2000)), kt(163.3))]
			]);
		});
		it('says when they cannot jump', () => {
			const ref = fleetMass.reference(MASS, { totalKg: kt(1000), jumpKg: kt(62) }, true);
			assert.ok(ref.every(r => r.pass.fits === false && r.count === null));
		});
	});

	describe('resultHtml', () => {
		const fleet = fleetMass.parse(fixture('fleetcomp.txt'), MASS);
		const result = fleetMass.check(fleet, Object.assign({ usedKg: 0, massState: 'destab' }, B274));
		const html = fleetMass.resultHtml(fleet, result, { typeName: 'B274', reference: fleetMass.reference(MASS, B274, true) });
		it('summarises the fleet and the verdict', () => {
			assert.ok(html.includes('8 ships'), html);
			assert.ok(html.includes('fleet composition'));
			assert.ok(html.includes('May collapse'));
			assert.ok(html.includes('the first <b>5</b> of 8 passes are safe'), html);
			assert.ok(html.includes('Fresh B274'));
		});
		it('the jumping total is the sum of the passes (too heavy left out, cold-only cold)', () => {
			const f = fleetMass.parse('Paladin\nRifter\nNaglfar', MASS);
			const r = fleetMass.check(f, { totalKg: kt(3300), jumpKg: kt(300), usedKg: 0, massState: 'stable' });
			// Paladin 178,000 t hot fits 300,000 t; Rifter 1,067 + 500 t; Naglfar too heavy
			assert.strictEqual(r.legKg, 179567000);
			const h = fleetMass.resultHtml(f, r, {});
			assert.ok(h.includes('179,567 t as the ships that fit jump'), h);
			const g = fleetMass.parse('Paladin', MASS);
			const cold = fleetMass.check(g, { totalKg: kt(1000), jumpKg: kt(150), usedKg: 0, massState: 'stable' });
			assert.ok(fleetMass.resultHtml(g, cold, {}).includes('128,000 t as they jump (prop mods on, cold where hot is over the limit)'));
		});
		it('leaves out the reference for a group already in the fleet', () => {
			assert.ok(!/Per fresh B274: .*Marauder/.test(html));
		});
		it('shows the reference for a fleet without them', () => {
			const f = fleetMass.parse('3 Guardian', MASS);
			const h = fleetMass.resultHtml(f, fleetMass.check(f, Object.assign({ usedKg: 0, massState: 'stable' }, B274)),
				{ typeName: 'B274', reference: fleetMass.reference(MASS, B274, true) });
			assert.ok(h.includes('Per fresh B274: Marauder 10 safely, up to 13 (Paladin, 178,000 t hot)'), h);
		});
		it('escapes pasted text', () => {
			const f = fleetMass.parse('<img src=x onerror=alert(1)>\nRifter', MASS);
			const h = fleetMass.resultHtml(f, fleetMass.check(f, B274), {});
			assert.ok(!h.includes('<img'));
			assert.ok(h.includes('&lt;img'));
		});
		it('says what to paste when nothing is recognised', () => {
			const f = fleetMass.parse('hello', MASS);
			assert.ok(fleetMass.resultHtml(f, fleetMass.check(f, B274), {}).includes('No ships recognised'));
		});
		it('nothing pasted: nothing shown', () => assert.strictEqual(fleetMass.resultHtml(fleetMass.parse('', MASS), fleetMass.check(null, B274), {}), ''));
		it('explains an inferred hole type', () => {
			const f = fleetMass.parse('Rifter', MASS);
			assert.ok(fleetMass.resultHtml(f, fleetMass.check(f, { jumpKg: kt(62) }), { inferred: true }).includes('inferred'));
		});
		it('shows the preserve mass flag', () => {
			const f = fleetMass.parse('Rifter', MASS);
			assert.ok(fleetMass.resultHtml(f, fleetMass.check(f, B274), { preserved: 'Marked preserve mass by Bob' }).includes('Marked preserve mass by Bob'));
		});
	});
});
