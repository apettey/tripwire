const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/favourites-route-strip');

const rs = favouritesRouteStrip;
const JITA = 30000142, PERIMETER = 30000144, NIYABAINEN = 30000143, HEK = 30002053, AMAMAKE = 30002537, J1 = 31000001, J2 = 31000002;
const systems = {
	30000142: { name: 'Jita', security: 0.945913, regionID: 10000002 },
	30000144: { name: 'Perimeter', security: 0.950000, regionID: 10000002 },
	30000143: { name: 'Niyabainen', security: 0.95, regionID: 10000002 },
	30002053: { name: 'Hek', security: 0.5, regionID: 10000042 },
	30002537: { name: 'Amamake', security: 0.37, regionID: 10000042 },
	31000001: { name: 'J100001', class: 5, regionID: 11000001 },
	31000002: { name: 'J100002', class: '3', regionID: 11000002 },
	31000005: { name: 'Thera', class: 12, regionID: 11000031 },
	30000001: { name: 'Tanoo', security: -0.4, regionID: 10000001 },
	30045328: { name: 'Ahtila', security: -1, regionID: 10000070, factionID: 500026 },
	30100000: { name: 'Zarzakh', security: -1, regionID: 10001000 },
	30002086: { name: 'Turnur', security: 0.3, regionID: 10000042 }
};
const lookup = id => systems[id] || null;
const regions = { 10000002: 'The Forge', 10000042: 'Metropolis', 11000001: 'A-R00001' };
const regionName = id => regions[id] || '';

describe('Favourites route strip', () => {
	describe('enabled', () => {
		it('Missing key: on', () => assert.ok(rs.enabled({})));
		it('No options: on', () => assert.ok(rs.enabled(undefined)));
		it('Explicit false: off', () => assert.ok(!rs.enabled({ favouritesRouteStrip: { enabled: false } })));
		it('Anything else: on', () => assert.ok(rs.enabled({ favouritesRouteStrip: { enabled: 0 } })));
	});

	describe('security', () => {
		it('Rounds to one decimal', () => assert.equal(rs.displaySecurity(0.945913), 0.9));
		it('0.45 is 0.5 (high-sec)', () => assert.equal(rs.displaySecurity(0.45), 0.5));
		it('0.449 is 0.4', () => assert.equal(rs.displaySecurity(0.449), 0.4));
		it('Tiny positive shows 0.1', () => assert.equal(rs.displaySecurity(0.02), 0.1));
		it('-0.04 is 0.0, not -0', () => assert.ok(Object.is(rs.displaySecurity(-0.04), 0)));
		it('Missing: null', () => assert.equal(rs.displaySecurity(undefined), null));
		it('Negative rounds half away from zero (-0.85 is -0.9)', () => assert.equal(rs.displaySecurity(-0.85), -0.9));
		it('-0.84 is -0.8', () => assert.equal(rs.displaySecurity(-0.84), -0.8));
		it('-0.05 is -0.1', () => assert.equal(rs.displaySecurity(-0.05), -0.1));
		it('Each step has its colour', () => {
			assert.equal(rs.securityColour(1.0), '#2C75E1');
			assert.equal(rs.securityColour(0.9), '#399AEB');
			assert.equal(rs.securityColour(0.5), '#F5FF83');
			assert.equal(rs.securityColour(0.4), '#DC6C06');
			assert.equal(rs.securityColour(0.1), '#731F1F');
			assert.equal(rs.securityColour(0.0), '#8D3163');
		});
		it('Null-sec all share one colour', () => assert.equal(rs.securityColour(-0.9), rs.securityColour(0)));
		it('Eleven steps', () => assert.equal(Object.keys(rs.SECURITY_COLOURS).length, 11));
	});

	describe('systemStyle', () => {
		it('High-sec', () => assert.deepEqual(rs.systemStyle(systems[JITA]), { kind: 'hisec', colour: '#399AEB', label: '0.9' }));
		it('Low-sec', () => assert.deepEqual(rs.systemStyle(systems[AMAMAKE]), { kind: 'lowsec', colour: '#DC6C06', label: '0.4' }));
		it('Null-sec', () => assert.equal(rs.systemStyle(systems[30000001]).kind, 'nullsec'));
		it('C5 uses Tripwire class colour', () => assert.deepEqual(rs.systemStyle(systems[J1]), { kind: 'wh', colour: '#9060f0', label: 'C5' }));
		it('String class', () => assert.equal(rs.systemStyle(systems[J2]).label, 'C3'));
		it('Array class (systemAnalysis)', () => assert.equal(rs.systemStyle({ class: [6] }).colour, '#f06090'));
		it('Thera', () => assert.deepEqual(rs.systemStyle(systems[31000005]), { kind: 'wh', colour: '#ffc800', label: 'Thera' }));
		it('Pochven', () => assert.equal(rs.systemStyle(systems[30045328]).kind, 'pochven'));
		it('Zarzakh', () => assert.equal(rs.systemStyle(systems[30100000]).kind, 'zarzakh'));
		it('Unknown system', () => assert.equal(rs.systemStyle(null).kind, 'unknown'));
		it('No security, no class', () => assert.equal(rs.systemStyle({ name: 'x' }).kind, 'unknown'));
	});

	describe('holeLabel', () => {
		const wh = { type: 'H296', parent: 'initial' };
		it('From the typed side', () => assert.equal(rs.holeLabel(wh, 1, 2, 1), 'H296'));
		it('From the other side: K162', () => assert.equal(rs.holeLabel(wh, 1, 2, '2'), 'K162'));
		it('Parent secondary', () => assert.equal(rs.holeLabel({ type: 'N110', parent: 'secondary' }, 1, 2, 2), 'N110'));
		it('Unknown type', () => assert.equal(rs.holeLabel({ type: '', parent: 'initial' }, 1, 2, 1), ''));
		it('No wormhole', () => assert.equal(rs.holeLabel(null, 1, 2, 1), ''));
	});

	describe('steps', () => {
		const paths = {
			[HEK + '>' + JITA]: [HEK, AMAMAKE, PERIMETER, JITA],
			[PERIMETER + '>' + JITA]: [PERIMETER, JITA],
			[HEK + '>' + PERIMETER]: [HEK, NIYABAINEN, PERIMETER]
		};
		const gatePath = (a, b) => paths[a + '>' + b] || null;
		// [systemA, systemB, classes, lineIndex]
		const connections = [[String(J1), String(J2), [], 4], [String(PERIMETER), String(J2), [], 7]];

		it('Direct gate route', () => {
			const s = rs.steps({ status: 'ok', kind: 'direct', gatesIn: 3, mode: 'shortest' }, HEK, JITA, gatePath, []);
			assert.deepEqual(s.map(x => [x.to, x.kind]), [[String(AMAMAKE), 'gate'], [String(PERIMETER), 'gate'], [String(JITA), 'gate']]);
		});
		it('Through the chain: holes walked in order, either line direction', () => {
			const plan = { status: 'ok', kind: 'chain', gatesIn: 0, holes: 2, gatesOut: 1, entrySystemID: J1, exitSystemID: PERIMETER, lineIndexes: [4, 7], mode: 'shortest' };
			const s = rs.steps(plan, J1, JITA, gatePath, connections);
			assert.deepEqual(s.map(x => [x.from, x.to, x.kind, x.lineIndex]), [
				[String(J1), String(J2), 'wormhole', 4], [String(J2), String(PERIMETER), 'wormhole', 7], [String(PERIMETER), String(JITA), 'gate', undefined]]);
		});
		it('Gates in, then holes', () => {
			const plan = { status: 'ok', kind: 'chain', gatesIn: 2, holes: 2, gatesOut: 0, entrySystemID: PERIMETER, exitSystemID: J1, lineIndexes: [7, 4], mode: 'shortest' };
			const s = rs.steps(plan, HEK, J1, gatePath, connections);
			assert.deepEqual(s.map(x => x.kind), ['gate', 'gate', 'wormhole', 'wormhole']);
			assert.equal(s[3].to, String(J1));
		});
		it('Safe flag passed to the gate search', () => {
			let safeSeen = null;
			rs.steps({ status: 'ok', kind: 'direct', gatesIn: 1, mode: 'safe' }, PERIMETER, JITA, (a, b, safe) => { safeSeen = safe; return [a, b]; }, []);
			assert.equal(safeSeen, true);
		});
		it('Unknown plan kind: null, not the chain branch', () =>
			assert.equal(rs.steps({ status: 'ok', kind: 'thera', gatesIn: 0, holes: 1, gatesOut: 0, entrySystemID: J1, exitSystemID: J2, lineIndexes: [4], mode: 'shortest' }, J1, J2, gatePath, connections), null));
		it('No route: null', () => assert.equal(rs.steps({ status: 'no-route' }, HEK, JITA, gatePath, []), null));
		it('Here: null', () => assert.equal(rs.steps({ status: 'here' }, JITA, JITA, gatePath, []), null));
		it('Gate path length differs from the plan: null', () =>
			assert.equal(rs.steps({ status: 'ok', kind: 'direct', gatesIn: 5, mode: 'shortest' }, HEK, JITA, gatePath, []), null));
		it('Connection missing (chain changed): null', () => {
			const plan = { status: 'ok', kind: 'chain', gatesIn: 0, holes: 1, gatesOut: 0, entrySystemID: J1, exitSystemID: J2, lineIndexes: [9], mode: 'shortest' };
			assert.equal(rs.steps(plan, J1, J2, gatePath, connections), null);
		});
		it('Connection not touching the current system: null', () => {
			const plan = { status: 'ok', kind: 'chain', gatesIn: 0, holes: 1, gatesOut: 0, entrySystemID: J1, exitSystemID: PERIMETER, lineIndexes: [7], mode: 'shortest' };
			assert.equal(rs.steps(plan, J1, PERIMETER, gatePath, connections), null);
		});
	});

	describe('EVE-Scout connections', () => {
		const n = (v, cls) => ({ c: [{ v: v, f: "<div id='node" + v + "' class='node " + cls + "'></div>" }] });
		it('Class token', () => assert.ok(rs.isThirdPartyNode("<div class='node third-party third-party-evescout'>")));
		it('Not a substring elsewhere', () => assert.ok(!rs.isThirdPartyNode("<div class='node' title='third-party'>")));
		it('Not a longer class', () => assert.ok(!rs.isThirdPartyNode("<div class='node third-party-evescout'>")));
		it('No markup', () => assert.ok(!rs.isThirdPartyNode(undefined)));
		const rows = [n(1, ''), n(2, 'third-party third-party-evescout'), n(3, '')];
		// lines are [child, parent, classes, id]: 2 is the EVE-Scout node off 1, 3 is your own hole off 2
		const lines = [[2, 1, [], 'es1'], [3, 2, [], 77]];
		it('Only the line whose child is the EVE-Scout node', () => assert.deepEqual(rs.thirdPartyLines(rows, lines), { 0: true }));
		it('Nothing', () => assert.deepEqual(rs.thirdPartyLines(null, null), {}));
	});

	describe('genericSystem', () => {
		it('Drops the placeholder security', () =>
			assert.deepEqual(rs.genericSystem({ security: 0.8, class: undefined, factionID: undefined }), { name: 'unknown system', class: undefined, factionID: undefined }));
		it('Shows as unknown security', () => assert.equal(rs.systemStyle(rs.genericSystem({ security: -0.1 })).kind, 'unknown'));
		it('Keeps class', () => assert.equal(rs.systemStyle(rs.genericSystem({ security: undefined, class: [5] })).label, 'C5'));
		it('Keeps Pochven', () => assert.equal(rs.systemStyle(rs.genericSystem({ factionID: 500026 })).kind, 'pochven'));
		it('Nothing', () => assert.equal(rs.genericSystem(null), null));
	});

	describe('stripTitle', () => {
		it('Adds the breakdown', () => assert.equal(rs.stripTitle('Route (safe): direct: 19 gate jumps', 'direct 19g'), 'Route (safe): direct: 19 gate jumps · direct 19g'));
		it('Not twice', () => assert.equal(rs.stripTitle('Route (shortest): 3wh → 1g (3 wormhole jumps)', '3wh → 1g'), 'Route (shortest): 3wh → 1g (3 wormhole jumps)'));
		it('No breakdown', () => assert.equal(rs.stripTitle('Route', ''), 'Route'));
		it('No summary', () => assert.equal(rs.stripTitle('', ' 2g '), '2g'));
	});

	describe('markers', () => {
		const steps = [
			{ from: String(HEK), to: String(AMAMAKE), kind: 'gate' },
			{ from: String(AMAMAKE), to: String(J1), kind: 'wormhole', lineIndex: 3 },
			{ from: String(J1), to: '31000005', kind: 'wormhole', lineIndex: 5 },
			{ from: '31000005', to: '30002086', kind: 'wormhole', lineIndex: 6 }
		];
		const hole = s => ({ 3: { label: 'H296', thirdParty: false }, 5: { label: 'K162' }, 6: { label: '', thirdParty: true } })[s.lineIndex];
		const m = rs.markers(steps, lookup, regionName, hole);
		it('One marker per jump', () => assert.equal(m.length, 4));
		it('Gate marker title', () => assert.equal(m[0].title, 'Jump 1 of 4: Gate → Amamake 0.4 · Metropolis'));
		it('Gate kind and colour', () => assert.deepEqual([m[0].kind, m[0].colour, m[0].systemKind], ['gate', '#DC6C06', 'lowsec']));
		it('Wormhole marker title with type and class', () => assert.equal(m[1].title, 'Jump 2 of 4: Wormhole H296 → J100001 C5 · A-R00001'));
		it('Wormhole kind', () => assert.equal(m[1].kind, 'wormhole'));
		it('Into Thera: hub', () => assert.equal(m[2].kind, 'hub'));
		it('Thera label not repeated', () => assert.equal(m[2].title, 'Jump 3 of 4: Wormhole K162 → Thera'));
		it('EVE-Scout connection: hub, says so', () => {
			assert.equal(m[3].kind, 'hub');
			assert.equal(m[3].title, 'Jump 4 of 4: Wormhole (EVE-Scout) → Turnur 0.3 · Metropolis');
		});
		it('Unknown system', () => {
			const u = rs.markers([{ from: '1', to: 'x|5', kind: 'wormhole' }], () => null, regionName, () => null);
			assert.equal(u[0].title, 'Jump 1 of 1: Wormhole → unknown system');
			assert.equal(u[0].systemKind, 'unknown');
		});
		it('No steps', () => assert.deepEqual(rs.markers(null, lookup, regionName), []));
		it('Thera and Turnur hops: circles in the hub colour', () => {
			assert.deepEqual([m[2].colour, m[2].systemKind], ['#ffc800', 'hub-thera']);
			assert.deepEqual([m[3].colour, m[3].systemKind], ['#FF4DFF', 'hub-turnur']);
		});
		it('Out of Thera through a mapped hole: a Thera hop, whatever it enters', () => {
			const out = rs.markers([{ from: '31000005', to: String(HEK), kind: 'wormhole', lineIndex: 1 }], lookup, regionName, () => ({ label: 'K162' }));
			assert.deepEqual([out[0].kind, out[0].colour], ['hub', '#ffc800']);
		});
		it('EVE-Scout step: hub name, sig and hole in the title', () => {
			const s = rs.markers([{ from: String(HEK), to: '31000005', kind: 'scout', hubName: 'Thera', sig: 'ABC-123', sigSystemID: String(HEK), hole: 'Q063, max large, 10h left' }], lookup, regionName);
			assert.equal(s[0].title, 'Jump 1 of 1: Thera hole (EVE-Scout) → Thera · warp to ABC-123 in Hek · Q063, max large, 10h left');
			assert.deepEqual([s[0].kind, s[0].colour], ['hub', '#ffc800']);
		});
	});

	describe('pathSteps, chips and stripHtml', () => {
		it('Gate steps from real or offset IDs', () => assert.deepEqual(rs.pathSteps([2053, 2537]).map(s => [s.from, s.to, s.kind]),
			[['30002053', '30002537', 'gate']]));
		it('No path', () => assert.deepEqual(rs.pathSteps(null), []));
		it('Chips escape everything', () => {
			const html = rs.sigChipsHtml([{ sig: "AB<'>", where: 'Hek', to: 'Thera', hubName: 'Thera', into: true, hole: 'x' }]);
			assert.ok(html.indexOf("<'>") < 0);
			assert.ok(html.indexOf('AB&lt;&#39;&gt;') >= 0);
			assert.ok(html.indexOf('fav-sig-thera') >= 0);
		});
		it('stripHtml: markers plus chips', () => {
			const html = rs.stripHtml(rs.pathSteps([HEK, AMAMAKE]), lookup, regionName, 200, [{ sig: 'ABC-123', where: 'Hek', to: 'Thera', hubName: 'Thera', into: true }]);
			assert.ok(/fav-mk fav-mk-gate fav-mk-lowsec/.test(html));
			assert.ok(html.indexOf("data-sig='ABC-123'") >= 0);
		});
		it('stripHtml compresses to the width', () => assert.ok(rs.stripHtml(rs.pathSteps(Array.from({ length: 41 }, (_, i) => 30000001 + i)), lookup, regionName, 110).indexOf('…+') >= 0));
	});

	describe('fit and compress', () => {
		const list = n => Array.from({ length: n }, (_, i) => ({ title: 'm' + i }));
		it('All fit', () => assert.equal(rs.fit(10, 110, 11, 34), 10));
		it('Too many: room for the gap', () => assert.equal(rs.fit(20, 110, 11, 34), 6));
		it('Never fewer than 2', () => assert.equal(rs.fit(20, 10, 11, 34), 2));
		it('Never more than the count', () => assert.equal(rs.fit(3, 1000), 3));
		it('Zero width', () => assert.equal(rs.fit(5, 0, 11, 34), 2));
		it('Compress keeps start and end', () => {
			const c = rs.compress(list(20), 6);
			assert.deepEqual(c.map(x => x.gap ? '+' + x.gap : x.title), ['m0', 'm1', 'm2', '+14', 'm17', 'm18', 'm19']);
			assert.equal(c[3].hidden.length, 14);
		});
		it('Compress with 2: first and last', () =>
			assert.deepEqual(rs.compress(list(5), 2).map(x => x.gap ? '+' + x.gap : x.title), ['m0', '+3', 'm4']));
		it('Fits: unchanged copy', () => {
			const l = list(4);
			const c = rs.compress(l, 4);
			assert.deepEqual(c, l);
			assert.notStrictEqual(c, l);
		});
		it('Only 1-2 would be hidden: all shown (the strip wraps)', () => {
			assert.equal(rs.compress(list(3), 2).length, 3);
			assert.equal(rs.compress(list(4), 2).length, 4);
			assert.equal(rs.compress(list(5), 2).length, 3);
		});
		it('Odd max', () => assert.deepEqual(rs.compress(list(10), 5).map(x => x.gap ? '+' + x.gap : x.title), ['m0', 'm1', 'm2', '+5', 'm8', 'm9']));
	});

	describe('markersHtml', () => {
		it('Escapes titles and uses kind classes', () => {
			const html = rs.markersHtml([{ kind: 'gate', systemKind: 'hisec', colour: '#399AEB', title: "<b>Jita's</b>" }]);
			assert.equal(html, "<i class='fav-mk fav-mk-gate fav-mk-hisec' style='--fav-mk:#399AEB' title='&lt;b&gt;Jita&#39;s&lt;/b&gt;'></i>");
		});
		it('Gap lists the hidden jumps', () => {
			const html = rs.markersHtml([{ gap: 2, hidden: [{ title: 'a' }, { title: '<b>' }] }]);
			assert.equal(html, "<span class='fav-mk-gap' title='2 more jumps:\na\n&lt;b&gt;'>…+2</span>");
		});
		it('Long gap tooltip is shortened', () => {
			const hidden = Array.from({ length: 20 }, (_, i) => ({ title: 't' + i }));
			const html = rs.markersHtml([{ gap: 20, hidden: hidden }]);
			assert.ok(html.indexOf('t5\n…\nt14') >= 0);
			assert.ok(html.indexOf('t6\n') < 0);
		});
	});
});
