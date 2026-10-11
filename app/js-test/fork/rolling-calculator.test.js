const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/rolling-calculator');

const kt = n => n * 1e6;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1, actual + ' != ' + expected);

describe('Rolling calculator', () => {
	describe('passMass', () => {
		it('cold hull is the hull mass', () => assert.equal(rollingCalc.passMass(kt(100)), kt(100)));
		it('hot adds 50kt for subcaps', () => assert.equal(rollingCalc.passMass(kt(100), { prop: true }), kt(150)));
		it('hot adds 500kt for capitals', () => assert.equal(rollingCalc.passMass(kt(1200), { prop: true }), kt(1700)));
		it('500kt exactly is not a capital', () => assert.equal(rollingCalc.passMass(kt(500), { prop: true }), kt(550)));
		it('Higgs doubles', () => assert.equal(rollingCalc.passMass(kt(100), { higgs: true }), kt(200)));
		it('Higgs doubles the hot mass too', () => assert.equal(rollingCalc.passMass(kt(100), { prop: true, higgs: true }), kt(300)));
		it('matches the mass log for a hot Paladin', () => assert.equal(rollingCalc.passMass(128000000, { prop: true }), 178000000));
		it('a fitted prop module replaces the 50kt rule', () => {
			assert.equal(rollingCalc.passMass(kt(15.4), { prop: true, propKg: kt(5) }), kt(20.4));
			assert.equal(rollingCalc.passMass(kt(100), { prop: true, propKg: 0 }), kt(100));
			assert.equal(rollingCalc.passMass(kt(100), { prop: false, propKg: kt(50) }), kt(100));
			assert.equal(rollingCalc.passMass(kt(105.9), { prop: true, propKg: kt(50), higgs: true }), kt(311.8));
		});
		it('unknown hull is null', () => {
			assert.equal(rollingCalc.passMass(undefined), null);
			assert.equal(rollingCalc.passMass(0), null);
			assert.equal(rollingCalc.passMass('abc'), null);
		});
	});

	describe('remaining', () => {
		it('unknown total mass is unknown', () => {
			assert.deepEqual(rollingCalc.remaining(undefined, kt(100)), { known: false });
			assert.deepEqual(rollingCalc.remaining(0, 0), { known: false });
			assert.deepEqual(rollingCalc.remaining('?', 0), { known: false });
		});
		it('fresh hole is 90%-110% of nominal', () => {
			const r = rollingCalc.remaining(kt(2000), 0);
			near(r.min, kt(1800)); near(r.max, kt(2200));
			assert.equal(r.state, null); assert.equal(r.inconsistent, false);
		});
		it('subtracts used mass', () => {
			const r = rollingCalc.remaining(kt(2000), kt(1000));
			near(r.min, kt(800)); near(r.max, kt(1200));
		});
		it('missing or negative used mass counts as 0', () => {
			near(rollingCalc.remaining(kt(2000)).min, kt(1800));
			near(rollingCalc.remaining(kt(2000), -5).min, kt(1800));
		});
		it('minimum never goes below 0', () => {
			const r = rollingCalc.remaining(kt(2000), kt(2100));
			assert.equal(r.min, 0); near(r.max, kt(100)); assert.equal(r.overLogged, false);
		});
		it('more logged than the heaviest hole: log ignored, flagged', () => {
			const r = rollingCalc.remaining(kt(2000), kt(2500));
			assert.equal(r.min, 0); near(r.max, kt(2200));
			assert.equal(r.overLogged, true); assert.equal(r.inconsistent, true);
			assert.ok(rollingCalc.planHtml(rollingCalc.plan({ totalKg: kt(2000), usedKg: kt(2500) }), 'A', 'B').indexOf('More mass is logged') >= 0);
		});
		it('exactly the heaviest hole logged counts as over-logged', () => assert.equal(rollingCalc.remaining(kt(2000), kt(2200)).overLogged, true));
		it('over-logged with a mass state takes the widest bounds', () => {
			const r = rollingCalc.remaining(kt(2000), kt(2500), 'destab');
			near(r.min, 0); near(r.max, kt(2200)); assert.equal(r.inconsistent, true);
		});
		it('unknown mass state is ignored', () => {
			const r = rollingCalc.remaining(kt(2000), kt(1000), 'whatever');
			near(r.min, kt(800)); near(r.max, kt(1200)); assert.equal(r.state, null);
		});

		describe('combined with the mass state (through the real total mass)', () => {
			it('stable: total must be at least 2x used', () => {
				// T >= 2000 within 1800-2200 -> 1000-1200 left
				const r = rollingCalc.remaining(kt(2000), kt(1000), 'stable');
				near(r.min, kt(1000)); near(r.max, kt(1200)); assert.equal(r.state, 'stable'); assert.equal(r.inconsistent, false);
			});
			it('stable with little logged keeps the log bounds', () => {
				const r = rollingCalc.remaining(kt(2000), kt(100), 'stable');
				near(r.min, kt(1700)); near(r.max, kt(2100));
			});
			it('stable with nothing logged is a fresh hole', () => {
				const r = rollingCalc.remaining(kt(2000), 0, 'stable');
				near(r.min, kt(1800)); near(r.max, kt(2200)); assert.equal(r.inconsistent, false);
			});
			it('stable but 1500kt logged on a 2000kt hole (stale state): widest bounds', () => {
				// stable needs T >= 3000 > 2200: impossible. log 300-700, state 900-2200
				const r = rollingCalc.remaining(kt(2000), kt(1500), 'stable');
				assert.equal(r.inconsistent, true);
				near(r.min, kt(300)); near(r.max, kt(2200));
			});
			it('destab with 840kt logged on a 2000kt hole (missing jumps): widest bounds', () => {
				// destab needs T <= 1680 < 1800: impossible. log 960-1360, state 180-1100
				const r = rollingCalc.remaining(kt(2000), kt(840), 'destab');
				assert.equal(r.inconsistent, true);
				near(r.min, kt(180)); near(r.max, kt(1360));
				const p = rollingCalc.plan({ totalKg: kt(2000), usedKg: kt(840), massState: 'destab', outKg: kt(300), backKg: kt(300) });
				assert.equal(p.out.verdict, 'may'); assert.equal(p.stranded, 'possible');
			});
			it('destab with too little logged: widest bounds', () => {
				// destab needs T <= 1000: impossible. log 1300-1700, state 180-1100
				const r = rollingCalc.remaining(kt(2000), kt(500), 'destab');
				assert.equal(r.inconsistent, true);
				near(r.min, kt(180)); near(r.max, kt(1700));
			});
			it('destab consistent with the log keeps the log bounds', () => {
				// T in 1444-2600 -> 1800-2200
				const r = rollingCalc.remaining(kt(2000), kt(1300), 'destab');
				near(r.min, kt(500)); near(r.max, kt(900)); assert.equal(r.inconsistent, false);
			});
			it('destab raises the minimum through the total', () => {
				// destab needs T >= 1700 / 0.9 = 1888.9 -> 188.9-500 left
				const r = rollingCalc.remaining(kt(2000), kt(1700), 'destab');
				near(r.min, kt(1700) / 0.9 - kt(1700)); near(r.max, kt(500)); assert.equal(r.inconsistent, false);
			});
			it('critical caps the total at used / 0.9', () => {
				// T in 1900-2111.1 -> 0-211.1 left
				const r = rollingCalc.remaining(kt(2000), kt(1900), 'critical');
				near(r.min, 0); near(r.max, kt(1900) / 0.9 - kt(1900)); assert.equal(r.inconsistent, false);
			});
			it('critical with nothing logged trusts the state', () => {
				const r = rollingCalc.remaining(kt(2000), 0, 'critical');
				assert.equal(r.inconsistent, false);
				near(r.min, 0); near(r.max, kt(220));
			});
			it('destab with nothing logged trusts the state', () => {
				const r = rollingCalc.remaining(kt(2000), 0, 'destab');
				near(r.min, kt(180)); near(r.max, kt(1100));
			});
			it('keeps the log-only bounds for reference', () => {
				const r = rollingCalc.remaining(kt(2000), kt(1900), 'critical');
				near(r.logMin, 0); near(r.logMax, kt(300));
			});
		});
	});

	describe('classify', () => {
		const range = { known: true, min: kt(300), max: kt(500) };
		it('below the minimum is safe', () => assert.equal(rollingCalc.classify(range, kt(299)), 'safe'));
		it('exactly the minimum may collapse', () => assert.equal(rollingCalc.classify(range, kt(300)), 'may'));
		it('inside the range may collapse', () => assert.equal(rollingCalc.classify(range, kt(400)), 'may'));
		it('exactly the maximum will collapse', () => assert.equal(rollingCalc.classify(range, kt(500)), 'collapse'));
		it('above the maximum will collapse', () => assert.equal(rollingCalc.classify(range, kt(800)), 'collapse'));
		it('empty hole: anything collapses', () => assert.equal(rollingCalc.classify({ known: true, min: 0, max: 0 }, 1), 'collapse'));
		it('unknown range is unknown', () => {
			assert.equal(rollingCalc.classify({ known: false }, kt(100)), 'unknown');
			assert.equal(rollingCalc.classify(undefined, kt(100)), 'unknown');
		});
		it('unknown ship mass is unknown', () => {
			assert.equal(rollingCalc.classify(range, null), 'unknown');
			assert.equal(rollingCalc.classify(range, 0), 'unknown');
		});
	});

	describe('afterPass', () => {
		it('shifts both ends', () => {
			const r = rollingCalc.afterPass({ known: true, min: kt(300), max: kt(500) }, kt(200));
			assert.equal(r.min, kt(100)); assert.equal(r.max, kt(300));
		});
		it('clamps at 0', () => {
			const r = rollingCalc.afterPass({ known: true, min: kt(100), max: kt(500) }, kt(200));
			assert.equal(r.min, 0); assert.equal(r.max, kt(300));
		});
		it('unknown stays unknown', () => assert.equal(rollingCalc.afterPass({ known: false }, kt(1)).known, false));
	});

	describe('plan (out and back)', () => {
		// 2000kt hole, 375kt jump limit
		const base = { totalKg: kt(2000), jumpKg: kt(375) };

		it('fresh hole, battleship: both passes safe, no warning', () => {
			const p = rollingCalc.plan(Object.assign({ usedKg: 0, outKg: kt(150), backKg: kt(150) }, base));
			assert.equal(p.out.verdict, 'safe'); assert.equal(p.back.verdict, 'safe');
			assert.equal(p.stranded, null); assert.equal(p.rearGuard, false);
		});
		it('out may collapse: possibly stranded', () => {
			// remaining 100-500
			const p = rollingCalc.plan(Object.assign({ usedKg: kt(1700), outKg: kt(300), backKg: kt(300) }, base));
			assert.equal(p.out.verdict, 'may'); assert.equal(p.stranded, 'possible');
			assert.equal(p.back.verdict, 'collapse');	// if it survived, 0-200 left
		});
		it('out will collapse: stranded, no return pass', () => {
			const p = rollingCalc.plan(Object.assign({ usedKg: kt(1900), outKg: kt(300), backKg: kt(300) }, base));
			assert.equal(p.out.verdict, 'collapse'); assert.equal(p.stranded, 'certain');
			assert.equal(p.back.verdict, 'none');
		});
		it('out safe, back may collapse: rear guard warning, not stranded', () => {
			// remaining 500-900; out 300 -> 200-600; back 300 may
			const p = rollingCalc.plan(Object.assign({ usedKg: kt(1300), outKg: kt(300), backKg: kt(300) }, base));
			assert.equal(p.out.verdict, 'safe'); assert.equal(p.back.verdict, 'may');
			assert.equal(p.stranded, null); assert.equal(p.rearGuard, true);
			near(p.afterOut.min, kt(200)); near(p.afterOut.max, kt(600));
		});
		it('cold out, hot back: back will collapse', () => {
			// remaining 300-700; out 250 -> 50-450 left; back 600 >= 450
			const p = rollingCalc.plan({ totalKg: kt(2000), jumpKg: kt(1000), usedKg: kt(1500), outKg: kt(250), backKg: kt(600) });
			assert.equal(p.out.verdict, 'safe'); assert.equal(p.back.verdict, 'collapse'); assert.equal(p.rearGuard, true);
		});
		it('ship over the jump limit is too heavy', () => {
			const p = rollingCalc.plan(Object.assign({ usedKg: 0, outKg: kt(400), backKg: kt(400) }, base));
			assert.equal(p.out.verdict, 'too-heavy'); assert.equal(p.back.verdict, 'none'); assert.equal(p.stranded, null);
		});
		it('back pass over the jump limit (hot + Higgs) blocks the way home', () => {
			const p = rollingCalc.plan(Object.assign({ usedKg: 0, outKg: kt(320), backKg: kt(420) }, base));
			assert.equal(p.out.verdict, 'safe'); assert.equal(p.back.verdict, 'too-heavy'); assert.equal(p.stranded, 'blocked');
			assert.ok(rollingCalc.planHtml(p, 'J1', 'Jita').indexOf('stranded in J1') >= 0);
		});
		it('jump limit unknown: no too-heavy check', () => {
			const p = rollingCalc.plan({ totalKg: kt(2000), usedKg: 0, outKg: kt(400), backKg: kt(400) });
			assert.equal(p.out.verdict, 'safe');
		});
		it('uses the mass state', () => {
			// crit: remaining 0-220 regardless of a short log
			const p = rollingCalc.plan(Object.assign({ usedKg: 0, massState: 'critical', outKg: kt(150), backKg: kt(150) }, base));
			assert.equal(p.out.verdict, 'may'); assert.equal(p.stranded, 'possible');
		});
		it('unknown hole type: everything unknown, no warnings, no crash', () => {
			const p = rollingCalc.plan({ usedKg: kt(100), outKg: kt(150), backKg: kt(150) });
			assert.equal(p.range.known, false);
			assert.equal(p.out.verdict, 'unknown'); assert.equal(p.back.verdict, 'unknown');
			assert.equal(p.stranded, null); assert.equal(p.rearGuard, false);
		});
		it('unknown ship: unknown verdicts', () => {
			const p = rollingCalc.plan(Object.assign({ usedKg: 0, outKg: null, backKg: null }, base));
			assert.equal(p.out.verdict, 'unknown'); assert.equal(p.back.verdict, 'unknown'); assert.equal(p.stranded, null);
		});
		it('no arguments does not crash', () => assert.equal(rollingCalc.plan().range.known, false));
	});

	describe('planHtml', () => {
		it('hint for an unknown hole type', () => {
			const html = rollingCalc.planHtml(rollingCalc.plan({}), 'A', 'B');
			assert.ok(html.indexOf('rolling-hint') >= 0);
		});
		it('stranding warning names the far side', () => {
			const html = rollingCalc.planHtml(rollingCalc.plan({ totalKg: kt(2000), usedKg: kt(1700), outKg: kt(300), backKg: kt(300) }), 'J123456', 'Jita');
			assert.ok(html.indexOf('could be stranded in J123456') >= 0, html);
			assert.ok(html.indexOf('rolling-may') >= 0);
		});
		it('escapes system names', () => {
			const html = rollingCalc.planHtml(rollingCalc.plan({ totalKg: kt(2000), usedKg: 0, outKg: kt(100), backKg: kt(100) }), '<x>', 'B');
			assert.ok(html.indexOf('<x>') < 0);
		});
		it('shows the remaining range in kt', () => {
			const html = rollingCalc.planHtml(rollingCalc.plan({ totalKg: kt(2000), usedKg: kt(1000), outKg: kt(100), backKg: kt(100) }), 'A', 'B');
			assert.ok(html.indexOf('800kt') >= 0 && html.indexOf('1,200kt') >= 0, html);
		});
	});

	describe('formatKt', () => {
		it('floors a minimum and ceils a maximum', () => {
			assert.equal(rollingCalc.formatKt(499.6e6, 'floor'), '499kt');
			assert.equal(rollingCalc.formatKt(500.2e6, 'ceil'), '501kt');
		});
		it('rounds otherwise, with separators', () => assert.equal(rollingCalc.formatKt(1520.6e6), '1,521kt'));
		it('range shown is never on the wrong side of a ship mass', () => {
			const html = rollingCalc.planHtml(rollingCalc.plan({ totalKg: 1e9, usedKg: 1e9 * 0.9 - 499.6e6, outKg: 500e6, backKg: 500e6 }), 'A', 'B');
			assert.ok(html.indexOf('499kt') >= 0, html);
		});
	});

	describe('sides', () => {
		const a = { systemID: 31000001 }, b = { systemID: 30000142 };
		it('far side is the clicked chain node', () => {
			assert.deepEqual(rollingCalc.sides(a, b, 31000001, 30000142), { home: b, far: a });
			assert.deepEqual(rollingCalc.sides(a, b, 30000142, 99), { home: a, far: b });
		});
		it('clicked node wins over the viewed system (initial sig on the far side, deeper in the chain)', () => {
			// chain Jita -> J135250 -> J111707, initial sig in J111707, Mass opened on the J111707 node
			const j111707 = { systemID: 31000002 }, j135250 = { systemID: 31000003 };
			assert.deepEqual(rollingCalc.sides(j111707, j135250, 31000002, 30000142), { home: j135250, far: j111707 });
		});
		it('falls back to away from the viewed system', () => {
			assert.deepEqual(rollingCalc.sides(a, b, undefined, 30000142), { home: b, far: a });
			assert.deepEqual(rollingCalc.sides(a, b, 12345, 31000001), { home: a, far: b });
		});
		it('falls back to the first signature', () => assert.deepEqual(rollingCalc.sides(a, b), { home: a, far: b }));
	});

	describe('shipChoices', () => {
		it('current ship first, then unique logged ships', () => {
			const list = rollingCalc.shipChoices({ typeName: 'Raven', mass: kt(99) }, [
				{ shipName: 'Paladin', originalMass: kt(128) }, { shipName: 'Raven', originalMass: kt(99) }, { shipName: 'Paladin', originalMass: kt(128) }
			]);
			assert.deepEqual(list.map(s => s.name), ['Raven', 'Paladin']);
			assert.equal(list[0].current, true); assert.equal(list[1].current, false);
		});
		it('logged fits are separate choices with their prop module and Higgs', () => {
			const list = rollingCalc.shipChoices({ typeName: 'Onyx (fitted)', mass: kt(15.4), propKg: kt(5), higgs: false }, [
				{ shipName: 'Megathron', characterName: 'Roller', originalMass: kt(98.4), fit: { source: 'assets', base: kt(105.9), propMass: kt(50), multiplier: 2 } },
				{ shipName: 'Megathron', originalMass: kt(98.4), fit: { source: 'hull' } }
			]);
			assert.deepEqual(list, [
				{ name: 'Onyx (fitted)', mass: kt(15.4), current: true, propKg: kt(5), higgs: false },
				{ name: "Megathron (Roller's fit)", mass: kt(105.9), current: false, propKg: kt(50), higgs: true },
				{ name: 'Megathron', mass: kt(98.4), current: false }
			]);
		});
		it('leaves out the current pilot\'s logged fits when their current fit is known', () => {
			const jumps = [{ shipName: 'Megathron', characterName: 'Me', characterID: '91', originalMass: kt(98.4), fit: { source: 'assets', base: kt(105.9), propMass: kt(50), multiplier: 2 } }];
			const current = { typeName: 'Megathron, fitted', mass: kt(105.9), propKg: kt(50), higgs: true };
			assert.deepEqual(rollingCalc.shipChoices(current, jumps, 91).map(s => s.name), ['Megathron, fitted']);
			assert.deepEqual(rollingCalc.shipChoices({ typeName: 'Megathron', mass: kt(98.4) }, jumps, 91).map(s => s.name), ['Megathron', "Megathron (Me's fit)"]);
		});
		it('skips ships without a mass and copes with nothing', () => {
			assert.deepEqual(rollingCalc.shipChoices(null, [{ shipName: 'X' }]), []);
			assert.deepEqual(rollingCalc.shipChoices(null, undefined), []);
		});
	});

	describe('enabled', () => {
		it('on by default', () => { assert.equal(rollingCalc.enabled(undefined), true); assert.equal(rollingCalc.enabled({}), true); });
		it('off when switched off', () => assert.equal(rollingCalc.enabled({ rollingCalc: { enabled: false } }), false));
		it('on when switched on', () => assert.equal(rollingCalc.enabled({ rollingCalc: { enabled: true } }), true));
	});

	describe('planEnabled', () => {
		it('on by default', () => { assert.equal(rollingCalc.planEnabled(undefined), true); assert.equal(rollingCalc.planEnabled({}), true); });
		it('off by its own switch', () => assert.equal(rollingCalc.planEnabled({ rollPlan: { enabled: false } }), false));
		it('off with the whole feature', () => assert.equal(rollingCalc.planEnabled({ rollingCalc: { enabled: false } }), false));
	});

	describe('rollerProfile', () => {
		it('battleships for a hole that passes them', () => {
			const p = rollingCalc.rollerProfile(kt(1000));
			assert.deepEqual([p.name, p.cold, p.hot], ['battleship', kt(200), kt(300)]);
		});
		it('the hot battleship is clamped to the hole limit', () => {
			const p = rollingCalc.rollerProfile(kt(300), { bsCold: 200, bsHot: 400 });
			assert.equal(p.hot, kt(300));
		});
		it('medium holes get the medium roller', () => {
			const p = rollingCalc.rollerProfile(kt(62));
			assert.deepEqual([p.name, p.cold, p.hot], ['medium', kt(15), kt(60)]);
		});
		it('small holes clamp the medium roller to the limit', () => {
			const p = rollingCalc.rollerProfile(kt(20));
			assert.deepEqual([p.name, p.cold, p.hot], ['medium', kt(15), kt(20)]);
		});
		it('settings override the defaults, invalid values do not', () => {
			assert.equal(rollingCalc.rollerProfile(kt(1000), { bsCold: 150, bsHot: 'x' }).cold, kt(150));
			assert.equal(rollingCalc.rollerProfile(kt(1000), { bsCold: 150, bsHot: 'x' }).hot, kt(300));
			assert.equal(rollingCalc.rollerProfile(kt(62), { medHot: 40 }).hot, kt(40));
		});
		it('cold never exceeds hot', () => assert.equal(rollingCalc.rollerProfile(kt(1000), { bsCold: 500, bsHot: 300 }).cold, kt(300)));
	});

	describe('recommend', () => {
		const rec = (lo, hi, extra) => rollingCalc.recommend(Object.assign({ lo: kt(lo), hi: kt(hi), cold: kt(200), hot: kt(300), maxJump: kt(1000) }, extra));
		const text = r => r.steps.map(s => s.dir + ':' + s.kind + ':' + s.mass / 1e6 + ':' + s.status).join(' ');

		it('hot round trips while a whole one is safe, then a cold out and a hot return that may close it', () => {
			const r = rec(1000, 1200);
			assert.equal(text(r), 'out:hot:300:safe back:hot:300:safe out:cold:200:safe back:hot:300:may');
			assert.equal(r.outcome, 'may-close');
			assert.equal(r.repeatFrom, 3);
		});
		it('a return pass heavier than the most the hole can hold will close it', () => {
			const r = rec(400, 480);
			assert.equal(text(r), 'out:cold:200:safe back:hot:300:will');
			assert.equal(r.outcome, 'closes');
		});
		it('tracks the range after every step', () => {
			const r = rec(1000, 1200);
			assert.deepEqual(r.steps[1].after, { lo: kt(400), hi: kt(600) });
			assert.deepEqual(r.steps[2].after, { lo: kt(200), hi: kt(400) });
		});
		it('never recommends an outbound jump that may collapse the hole', () => {
			[[50, 100], [150, 200], [250, 300], [301, 310], [650, 700], [1300, 1500], [5000, 5200]].forEach(([lo, hi]) => {
				const r = rec(lo, hi);
				let low = kt(lo);
				r.steps.forEach(s => {
					if (s.dir === 'out') { assert.ok(s.mass < low, 'out ' + s.mass + ' vs lo ' + low); }
					low = s.after.lo;
				});
			});
		});
		it('warns when even a cold outbound pass may collapse it', () => {
			const r = rec(150, 200);
			assert.equal(r.outcome, 'too-light');
			assert.equal(r.steps.length, 0);
			assert.ok(/Too little mass left for a battleship to go out safely: use a lighter ship out \(under 150kt\)/.test(r.warning), r.warning);
		});
		it('an empty or crit hole: no ship can go out, no "under 0kt"', () => {
			[rec(0, 50), rec(0.4, 30)].forEach(r => {
				assert.equal(r.outcome, 'too-light');
				assert.equal(r.warning, 'No ship can safely go out: the hole may close on any jump.');
			});
			assert.ok(/under 5kt/.test(rec(5, 30, { cold: kt(6), hot: kt(9) }).warning));
		});
		it('names the roller in the warning', () => assert.ok(/for a medium to go/.test(rec(10, 12, { cold: kt(15), hot: kt(60), rollerName: 'medium' }).warning)));
		it('goes out cold when the cold pass is safe', () => {
			const r = rec(250, 400, { cold: kt(100), hot: kt(200) });
			assert.equal(r.steps[0].kind, 'cold');
		});
		it('a safe return goes round again until the hole is too light', () => {
			const r = rec(550, 650);
			assert.equal(text(r), 'out:cold:200:safe back:hot:300:safe');
			assert.equal(r.outcome, 'too-light');
			assert.ok(/under 50kt/.test(r.warning), r.warning);
		});
		it('caps at 12 steps and counts the remaining hot round trips', () => {
			const r = rec(10000, 10200);
			assert.equal(r.steps.length, 12);
			assert.equal(r.more, 11);
			assert.equal(r.moreAt, 10);
			assert.equal(r.outcome, 'may-close');
			assert.deepEqual(r.steps[9].after, { lo: kt(10000 - 5 * 600), hi: kt(10200 - 5 * 600) });
			assert.deepEqual(r.steps[10].after, { lo: kt(10000 - 16 * 600 - 200), hi: kt(10200 - 16 * 600 - 200) });
		});
		it('clamps the hot mass to the hole limit', () => {
			const r = rec(1000, 1200, { maxJump: kt(250) });
			assert.ok(r.steps.every(s => s.mass <= kt(250)));
		});
		it('unknown without a range or a roller', () => {
			assert.equal(rollingCalc.recommend({}).outcome, 'unknown');
			assert.equal(rollingCalc.recommend({ lo: 0, hi: 0, hot: 1 }).outcome, 'unknown');
			assert.equal(rollingCalc.recommend({ lo: 5, hi: 9, hot: 0 }).steps.length, 0);
		});
		it('renders numbered, coloured, labelled steps and the outcome', () => {
			const profile = { name: 'battleship', cold: kt(200), hot: kt(300) };
			const html = rollingCalc.recommendHtml(rec(400, 480), profile, { farName: 'J1<b>', homeName: 'Home', startedText: 'Rolling started by Kytus at 19:08 EVE' });
			assert.ok(html.includes('Assuming battleship rollers: 200kt cold / 300kt hot'));
			assert.ok(html.includes('Rolling started by Kytus at 19:08 EVE'));
			assert.ok(html.includes('rolling-step-safe') && html.includes('rolling-step-will'));
			assert.ok(html.includes('Out to J1&lt;b&gt; (cold, 200kt)') && html.includes('Back to Home (hot, 300kt)'));
			assert.ok(html.includes('Will collapse') && html.includes('closes on the way back'));
		});
		it('puts the preserve mass warning first and tells how to repeat', () => {
			const profile = { name: 'battleship', cold: kt(200), hot: kt(300) };
			const html = rollingCalc.recommendHtml(rec(1000, 1200), profile, { farName: 'F', homeName: 'H', preserved: 'Marked preserve mass' });
			assert.ok(html.indexOf('Marked preserve mass') < html.indexOf('rolling-steps'));
			assert.ok(html.includes('repeat steps 3&ndash;4'));
			assert.ok(html.includes('rolling-more') === false);
		});
		it('says how many round trips were left out', () => {
			const profile = { name: 'battleship', cold: kt(200), hot: kt(300) };
			const html = rollingCalc.recommendHtml(rec(10000, 10200), profile, { farName: 'F', homeName: 'H' });
			assert.ok(html.includes('11 more hot round trips'));
		});
	});

	describe('worstVerdict', () => {
		const plan = (out, back) => ({ out: { verdict: out }, back: { verdict: back } });
		it('is the worse of the two passes', () => {
			assert.equal(rollingCalc.worstVerdict(plan('safe', 'safe')), 'safe');
			assert.equal(rollingCalc.worstVerdict(plan('safe', 'may')), 'may');
			assert.equal(rollingCalc.worstVerdict(plan('may', 'safe')), 'may');
			assert.equal(rollingCalc.worstVerdict(plan('collapse', 'none')), 'collapse');
			assert.equal(rollingCalc.worstVerdict(plan('too-heavy', 'none')), 'too-heavy');
			assert.equal(rollingCalc.worstVerdict(plan('unknown', 'unknown')), 'unknown');
		});
		it('every verdict has an icon', () => {
			['safe', 'may', 'collapse', 'too-heavy', 'unknown'].forEach(v => assert.ok(rollingCalc.ICONS[v]));
		});
	});

	describe('passLog', () => {
		it('running total and lightest-case mass left, newest first', () => {
			const log = rollingCalc.passLog([{ mass: kt(100) }, { mass: kt(50) }], kt(1000));
			assert.deepEqual(log, [{ total: kt(150), left: kt(750) }, { total: kt(50), left: kt(850) }]);
		});
		it('never negative, null without a total mass', () => {
			assert.equal(rollingCalc.passLog([{ mass: kt(5000) }], kt(1000))[0].left, 0);
			assert.equal(rollingCalc.passLog([{ mass: kt(5) }], 0)[0].left, null);
			assert.deepEqual(rollingCalc.passLog([], kt(1)), []);
		});
	});

	describe('jumpRowFlags', () => {
		it('jump rows first, then the summary and total rows', () => {
			const ids = ['', '', '', 'small-mass', 'medium-mass', 'large-mass', ''];
			assert.deepEqual(rollingCalc.jumpRowFlags(ids, 3), [true, true, true, false, false, false, false]);
		});
		it('no jumps: nothing is a jump row, even the unnamed total row', () => {
			assert.deepEqual(rollingCalc.jumpRowFlags(['small-mass', 'medium-mass', 'large-mass', ''], 0), [false, false, false, false]);
		});
		it('never counts a summary row, whatever the count says', () => {
			assert.deepEqual(rollingCalc.jumpRowFlags(['', 'small-mass'], 5), [true, false]);
			assert.deepEqual(rollingCalc.jumpRowFlags(undefined, 2), []);
		});
	});

	describe('summarisePasses', () => {
		it('counts the passes it can weigh and adds their mass', () => {
			const r = rollingCalc.summarisePasses([{ m: 5 }, { m: 0 }, { m: 7 }, {}], row => row.m || null);
			assert.deepEqual(r, { passes: 2, massKg: 12 });
		});
		it('copes with nothing', () => assert.deepEqual(rollingCalc.summarisePasses(null, () => 1), { passes: 0, massKg: 0 }));
	});
});
