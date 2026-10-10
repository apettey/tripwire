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
		it('matches the mass log for a hot Paladin', () => assert.equal(rollingCalc.passMass(160000000, { prop: true }), 210000000));
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
		it('over-logged with a mass state uses the state', () => {
			const r = rollingCalc.remaining(kt(2000), kt(2500), 'destab');
			near(r.min, kt(180)); near(r.max, kt(1100));
		});
		it('unknown mass state is ignored', () => {
			const r = rollingCalc.remaining(kt(2000), kt(1000), 'whatever');
			near(r.min, kt(800)); near(r.max, kt(1200)); assert.equal(r.state, null);
		});

		describe('narrowed by mass state', () => {
			it('stable raises the minimum to 50% of the lightest hole', () => {
				const r = rollingCalc.remaining(kt(2000), kt(1000), 'stable');
				near(r.min, kt(900)); near(r.max, kt(1200)); assert.equal(r.state, 'stable');
			});
			it('stable with little logged keeps the log bounds', () => {
				const r = rollingCalc.remaining(kt(2000), kt(100), 'stable');
				near(r.min, kt(1700)); near(r.max, kt(2100));
			});
			it('destab caps the maximum at 50% of the heaviest hole', () => {
				const r = rollingCalc.remaining(kt(2000), kt(500), 'destab');
				// log says 1300-1700, state says 180-1100: contradiction, the state wins
				assert.equal(r.inconsistent, true);
				near(r.min, kt(180)); near(r.max, kt(1100));
			});
			it('destab narrows both ends when consistent', () => {
				const r = rollingCalc.remaining(kt(2000), kt(1300), 'destab');
				// log 500-900, state 180-1100
				near(r.min, kt(500)); near(r.max, kt(900)); assert.equal(r.inconsistent, false);
			});
			it('destab with a large log keeps the state minimum', () => {
				const r = rollingCalc.remaining(kt(2000), kt(1700), 'destab');
				// log 100-500, state 180-1100
				near(r.min, kt(180)); near(r.max, kt(500));
			});
			it('critical caps at 10% of the heaviest hole', () => {
				const r = rollingCalc.remaining(kt(2000), kt(1900), 'critical');
				// log 0-300, state 0-220
				near(r.min, 0); near(r.max, kt(220)); assert.equal(r.inconsistent, false);
			});
			it('critical with nothing logged trusts the state', () => {
				const r = rollingCalc.remaining(kt(2000), 0, 'critical');
				assert.equal(r.inconsistent, true);
				near(r.min, 0); near(r.max, kt(220));
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

	describe('shipChoices', () => {
		it('current ship first, then unique logged ships', () => {
			const list = rollingCalc.shipChoices({ typeName: 'Raven', mass: kt(99) }, [
				{ shipName: 'Paladin', originalMass: kt(160) }, { shipName: 'Raven', originalMass: kt(99) }, { shipName: 'Paladin', originalMass: kt(160) }
			]);
			assert.deepEqual(list.map(s => s.name), ['Raven', 'Paladin']);
			assert.equal(list[0].current, true); assert.equal(list[1].current, false);
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
});
