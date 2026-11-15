const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('public/js/combine');
include('app/js/wormholeAnalysis');
include('app/js/systemAnalysis');
include('app/js/fork/life-states');
include('app/js/fork/jump-range');
include('app/js/fork/chain-alerts');

const S = appData.systems;
const sid = name => Number(Object.keys(S).find(k => S[k].name === name));
const COORDS = jumpRange.decode(loadJSON('public/jumprange/systems'));

describe('Chain alerts', () => {
	const ca = chainAlerts;
	const H = 3600000;
	const now = Date.UTC(2026, 10, 15, 12, 0, 0);
	const at = ms => lifeStates.formatTime(ms);
	const HOME = Number(Object.keys(S).find(k => S[k].class && Array.isArray(S[k].statics) && S[k].statics.length === 1));
	const STATIC = S[HOME].statics[0];
	const C5 = sid('J152820'), C3 = sid('J163701'), LS = sid('Amamake'), NS = sid('EC-P8R'), HS = sid('Jita');
	const sig = (id, systemID, extra) => Object.assign({ id: id, signatureID: 'abc' + String(id).padStart(3, '0').slice(-3), systemID: String(systemID),
		lifeTime: at(now - 2 * H), lifeLength: '57600', lifeLeft: at(now + 14 * H), modifiedByID: '100', modifiedByName: 'Other Pilot', maskID: '98000001.2' }, extra);
	// A hole from systemA to systemB: the real type on the initial side (a) unless parent is 'secondary'
	const hole = (id, a, b, extra, sigExtra) => {
		const h = Object.assign({ id: String(id), type: 'H296', parent: 'initial', life: 'stable' }, extra);
		h.sigA = sig(id * 10 + 1, a, sigExtra);
		h.sigB = sig(id * 10 + 2, b, sigExtra);
		h.a = Number(a); h.b = Number(b);
		return h;
	};

	describe('settings', () => {
		it('everything on by default, new holes anywhere in the chain', () => {
			assert.deepStrictEqual(ca.settings(undefined), { newHole: true, scope: 'chain', homeStatic: true, capRange: true });
			assert.deepStrictEqual(ca.settings({ chainAlerts: {} }), { newHole: true, scope: 'chain', homeStatic: true, capRange: true });
		});
		it('each alert can be turned off; enabled false turns all off', () => {
			assert.deepStrictEqual(ca.settings({ chainAlerts: { newHole: false, scope: 'home', capRange: false } }), { newHole: false, scope: 'home', homeStatic: true, capRange: false });
			assert.strictEqual(ca.anyOn(ca.settings({ chainAlerts: { enabled: false } })), false);
			assert.strictEqual(ca.settings({ chainAlerts: { scope: 'nonsense' } }).scope, 'chain');
		});
	});

	describe('chain data', () => {
		it('builds holes from the client wormholes and signatures, skipping holes with a missing signature', () => {
			const sigs = { 1: sig(1, HOME), 2: sig(2, C5), 3: sig(3, C3) };
			const list = ca.holes({ 7: { id: '7', initialID: '1', secondaryID: '2', type: 'H296', parent: 'initial', life: 'stable' },
				8: { id: '8', initialID: '3', secondaryID: '99', type: '????' } }, sigs);
			assert.strictEqual(list.length, 1);
			assert.deepStrictEqual([list[0].id, list[0].a, list[0].b, list[0].type], ['7', HOME, C5, 'H296']);
			assert.strictEqual(ca.maskOf(list), '98000001.2');
			assert.strictEqual(ca.maskOf([]), '');
		});
		it('reads the systems the chain map drew', () => {
			const result = { map: { rows: [{ c: [{ v: 1, systemID: HOME }, { v: null }] }, { c: [{ v: 2, systemID: String(C5) }, { v: 1 }] }, { c: [] }] } };
			assert.deepStrictEqual(ca.chainSystems(result), { [HOME]: true, [C5]: true });
			assert.deepStrictEqual(ca.chainSystems(null), {});
		});
		it('the type seen from each side: the scanned type, K162 on the far side, empty when unknown', () => {
			const h = hole(1, HOME, C5);
			assert.deepStrictEqual([ca.typeFrom(h, 'a'), ca.typeFrom(h, 'b')], ['H296', 'K162']);
			const s = hole(2, HOME, C5, { parent: 'secondary', type: '????' });
			assert.deepStrictEqual([ca.typeFrom(s, 'a'), ca.typeFrom(s, 'b')], ['K162', '']);
		});
		it('neither side known (no parent): no K162 on either side', () => {
			[null, undefined, ''].forEach(p => {
				const n = hole(3, HOME, C5, { parent: p, type: '????' });
				assert.deepStrictEqual([ca.typeFrom(n, 'a'), ca.typeFrom(n, 'b')], ['', ''], String(p));
			});
			const t = ca.holeText({ hole: hole(3, HOME, C5, { parent: null, type: null }), near: 'b', home: false }, S, appData.genericSystemTypes);
			assert.ok(/^ABC-032 in J152820 \(C5\) to /.test(t.text), t.text);
		});
	});

	describe('new holes', () => {
		it('nothing is new on the first look (primed), then only holes not seen before', () => {
			const a = hole(1, HOME, C5), b = hole(2, C5, C3);
			const first = ca.diff(null, [a]);
			assert.deepStrictEqual(first.fresh, []);
			const second = ca.diff(first.seen, [a, b]);
			assert.deepStrictEqual(second.fresh.map(h => h.id), ['2']);
			assert.deepStrictEqual(ca.diff(second.seen, [a, b]).fresh, [], 'one alert per hole, not per refresh');
		});
		it('a mask seen loaded and empty gets an empty baseline, so its first hole alerts', () => {
			const M = '98000001.2', t0 = 1000000;
			assert.deepStrictEqual(ca.baselineFor(M, { mask: M, since: t0 }, t0 + ca.EMPTY_MS, t0 - 5), {});
			assert.strictEqual(ca.baselineFor(M, { mask: M, since: t0 }, t0 + 2000, t0 - 5), null, 'seen empty only just now: maybe still loading');
			assert.strictEqual(ca.baselineFor(M, { mask: M, since: t0 }, t0 + ca.EMPTY_MS, t0 + 1), null, 'the mask was switched since');
			assert.strictEqual(ca.baselineFor('98000002.2', { mask: M, since: t0 }, t0 + ca.EMPTY_MS, t0), null, 'another mask: prime');
			assert.strictEqual(ca.baselineFor(M, null, t0, 0), null);
			const first = ca.diff(ca.baselineFor(M, { mask: M, since: t0 }, t0 + ca.EMPTY_MS, t0), [hole(1, HOME, C5)]);
			assert.deepStrictEqual(first.fresh.map(h => h.id), ['1']);
		});
		it('only signatures of the active mask count as its data', () => {
			assert.strictEqual(ca.sigsOfMask({}, '98000001.2'), true);
			assert.strictEqual(ca.sigsOfMask({ 1: sig(1, HOME) }, '98000001.2'), true);
			assert.strictEqual(ca.sigsOfMask({ 1: sig(1, HOME, { maskID: '98000002.2' }) }, '98000001.2'), false);
		});
		it('a hole in home is a home alert, one elsewhere on the chain a chain alert; scope home skips the latter', () => {
			const chain = { [HOME]: true, [C5]: true, [C3]: true };
			const fresh = [hole(1, HOME, C5), hole(2, C3, C5, { parent: 'secondary' }), hole(3, LS, HS)];
			const all = ca.newHoleAlerts(fresh, { homeID: HOME, chain: chain, scope: 'chain', meID: 1 });
			assert.deepStrictEqual(all.map(x => [x.hole.id, x.near, x.home]), [['1', 'a', true], ['2', 'a', false]]);
			const home = ca.newHoleAlerts(fresh, { homeID: HOME, chain: chain, scope: 'home', meID: 1 });
			assert.deepStrictEqual(home.map(x => x.hole.id), ['1']);
		});
		it('home is preferred as the near end, even when it is the secondary side', () => {
			const a = ca.newHoleAlerts([hole(1, C5, HOME)], { homeID: HOME, chain: { [HOME]: true, [C5]: true }, scope: 'chain' });
			assert.deepStrictEqual([a[0].near, a[0].home], ['b', true]);
		});
		it('no home (no chain tab): only the chain counts', () => {
			const a = ca.newHoleAlerts([hole(1, C5, C3)], { homeID: null, chain: { [C5]: true }, scope: 'chain' });
			assert.deepStrictEqual(a.map(x => x.near), ['a']);
			assert.deepStrictEqual(ca.newHoleAlerts([hole(1, C5, C3)], { homeID: null, chain: { [C5]: true }, scope: 'home' }), []);
		});
		it('holes you mapped yourself are skipped', () => {
			const mine = hole(1, HOME, C5, {}, { modifiedByID: '42' });
			assert.deepStrictEqual(ca.newHoleAlerts([mine], { homeID: HOME, chain: {}, scope: 'chain', meID: 42 }), []);
			assert.strictEqual(ca.newHoleAlerts([mine], { homeID: HOME, chain: {}, scope: 'chain', meID: 7 }).length, 1);
		});
		it('describes the hole: signature, type, where it leads and who mapped it (plain text)', () => {
			const a = { hole: hole(1, HOME, C5, { parent: 'secondary' }), near: 'a', home: true };
			const t = ca.holeText(a, S, appData.genericSystemTypes);
			assert.strictEqual(t.title, 'New hole in home');
			assert.ok(t.text.indexOf('ABC-011 K162 in ' + S[HOME].name + ' (') === 0, t.text);
			assert.ok(/^ABC-011 K162 in .+ to J152820 \(C5\), mapped by Other Pilot$/.test(t.text), t.text);
		});
		it('an unknown far side says what kind of system it is when known', () => {
			const idx = appData.genericSystemTypes.indexOf('Class-5');
			const a = { hole: hole(1, HOME, idx), near: 'a', home: true };
			assert.ok(/to an unknown Class-5 system/.test(ca.holeText(a, S, appData.genericSystemTypes).text));
			assert.strictEqual(ca.systemText(appData.genericSystemTypes.indexOf('Unknown'), S, appData.genericSystemTypes), 'an unknown system');
		});
		it('the pop-up HTML escapes everything', () => {
			const html = ca.noticeHtml('newHole', '<b>', 'x & "y"', 1, "J<1>");
			assert.ok(html.indexOf('&lt;b&gt;') > 0 && html.indexOf('x &amp; &quot;y&quot;') > 0 && html.indexOf('Show J&lt;1&gt;') > 0);
			assert.ok(html.indexOf('<b>') < 0);
		});
	});

	describe('home static', () => {
		const crit = (left) => hole(5, HOME, C5, { type: STATIC, life: 'critical' }, { lifeLeft: at(now + left) });
		it('alerts at <1h and at EOL, once per stage', () => {
			assert.deepStrictEqual(ca.staticAlerts([crit(2 * H)], HOME, [STATIC], now, {}), [], '<4h is not alerted');
			const lt1h = ca.staticAlerts([crit(40 * 60000)], HOME, [STATIC], now, {});
			assert.deepStrictEqual(lt1h.map(a => [a.key, a.stage]), [['5:lt1h', 'lt1h']]);
			assert.deepStrictEqual(ca.staticAlerts([crit(40 * 60000)], HOME, [STATIC], now, { '5:lt1h': true }), []);
			const eol = ca.staticAlerts([crit(-60000)], HOME, [STATIC], now, { '5:lt1h': true });
			assert.deepStrictEqual(eol.map(a => a.stage), ['expired']);
		});
		it('a stable hole is never alerted, nor one that is not home\'s static', () => {
			assert.deepStrictEqual(ca.staticAlerts([hole(5, HOME, C5, { type: STATIC }, { lifeLeft: at(now + 1000) })], HOME, [STATIC], now, {}), []);
			assert.deepStrictEqual(ca.staticAlerts([hole(5, HOME, C5, { type: 'K162', life: 'critical' }, { lifeLeft: at(now + 1000) })], HOME, [STATIC], now, {}), []);
			// The static's type scanned on the other side is the other system's static, not home's
			assert.deepStrictEqual(ca.staticAlerts([hole(5, HOME, C5, { type: STATIC, life: 'critical', parent: 'secondary' }, { lifeLeft: at(now + 1000) })], HOME, [STATIC], now, {}), []);
			assert.deepStrictEqual(ca.staticAlerts([crit(1000)], null, [STATIC], now, {}), []);
			assert.deepStrictEqual(ca.staticAlerts([hole(5, HOME, C5, { type: STATIC, life: 'critical', parent: null }, { lifeLeft: at(now + 1000) })], HOME, [STATIC], now, {}), [],
				'no parent: not known to be scanned in home');
		});
		it('says how long is left', () => {
			const a = ca.staticAlerts([crit(40 * 60000)], HOME, [STATIC], now, {})[0];
			const t = ca.staticText(a, S, appData.genericSystemTypes);
			assert.strictEqual(t.title, 'Home static <1h');
			assert.ok(new RegExp('^' + STATIC + ' \\(ABC-051\\) to J152820 \\(C5\\): about 40 minutes left$').test(t.text), t.text);
			assert.strictEqual(ca.whenText('expired', -5), 'past its lifetime, it can collapse any time');
			assert.strictEqual(ca.whenText('lt1h', 60000), 'about 1 minute left');
		});
	});

	describe('capital range', () => {
		const planner = { lowsec: true, nullsec: true };
		it('candidates are new low-sec / null-sec exits on the chain, not high-sec, not yours', () => {
			const chain = { [C5]: true, [LS]: true, [HS]: true, [NS]: true };
			const fresh = [hole(1, C5, LS), hole(2, C5, HS), hole(3, C5, NS, {}, { modifiedByID: '42' }), hole(4, C5, NS)];
			assert.deepStrictEqual(ca.capCandidates(fresh, { chain: chain, meID: 42 }, S, planner).map(c => c.exitID), [LS, NS]);
			assert.deepStrictEqual(ca.capCandidates(fresh, { chain: chain, meID: 42 }, S, { lowsec: false, nullsec: true }).map(c => c.exitID), [NS]);
			assert.deepStrictEqual(ca.capCandidates(fresh, { chain: {}, meID: 42 }, S, planner), [], 'only exits on the chain');
		});
		it('jumps from your Get home start when set, else from the other exits of the chain', () => {
			assert.deepStrictEqual(ca.capRefs(LS, sid('Floseswin'), {}, S, 'group-547'), [{ id: sid('Floseswin'), start: true }]);
			const chain = { [LS]: true, [C5]: true, [HS]: true, [NS]: true };
			assert.deepStrictEqual(ca.capRefs(LS, sid('Floseswin'), chain, S, 'group-547'), [{ id: sid('Floseswin'), start: true }], 'the start wins over the chain');
			assert.deepStrictEqual(ca.capRefs(LS, sid('Jita'), chain, S, 'group-902'), [{ id: sid('Jita'), start: true }], 'a JF with a high-sec start: honoured');
			assert.deepStrictEqual(ca.capRefs(LS, sid('Jita'), chain, S, 'group-547'), [{ id: sid('Jita'), start: true }], 'any explicit start canJumpFrom accepts');
			assert.deepStrictEqual(ca.capRefs(LS, sid('Thera'), chain, S, 'group-547').map(r => r.id), [NS], 'a start no jump drive works in: the chain instead');
		});
		it('the fallback uses high-sec exits only for ships that can be in high-sec', () => {
			const chain = { [LS]: true, [C5]: true, [HS]: true, [NS]: true };
			assert.deepStrictEqual(ca.capRefs(LS, null, chain, S, 'group-547').map(r => r.id), [NS], 'a Carrier gets no high-sec fallback start');
			assert.deepStrictEqual(ca.capRefs(LS, null, chain, S, 'group-485').map(r => r.id), [NS], 'nor a Dreadnought');
			assert.deepStrictEqual(ca.capRefs(LS, null, chain, S, 'group-902').map(r => r.id).sort(), [HS, NS].sort(), 'a Jump Freighter does');
			assert.deepStrictEqual(ca.capRefs(LS, null, chain, S, 'group-898').map(r => r.id).sort(), [HS, NS].sort(), 'so do Black Ops');
			assert.deepStrictEqual(ca.capRefs(LS, null, chain, S, 'group-902-12.5').map(r => r.id).sort(), [HS, NS].sort(), 'a hull of the group');
		});
		it('hits are the refs within range, nearest first', () => {
			const hek = sid('Hek'), rens = sid('Rens'), jita = sid('Jita');
			const d = id => jumpRange.distanceLy(COORDS.pos[LS], COORDS.pos[id]);
			const refs = [{ id: jita, start: false }, { id: rens, start: false }, { id: hek, start: false }];
			const range = Math.max(d(hek), d(rens)) + 0.01;
			assert.ok(d(jita) > range, 'Jita is further than Hek and Rens');
			const hits = ca.capHits(LS, refs, COORDS.pos, range);
			assert.deepStrictEqual(hits.map(h => h.id), [hek, rens].sort((x, y) => d(x) - d(y)));
			assert.ok(Math.abs(hits[0].ly - Math.min(d(hek), d(rens))) < 1e-9);
			assert.deepStrictEqual(ca.capHits(LS, refs, COORDS.pos, 0), []);
			assert.deepStrictEqual(ca.capHits(C5, refs, COORDS.pos, 10), [], 'no position for wormhole space');
		});
		it('says how far and with which ship', () => {
			const t = ca.capText(LS, [{ id: sid('Hek'), start: true, ly: 4.23 }, { id: 1, start: false, ly: 5 }], 'Carrier', 5, 7, S);
			assert.strictEqual(t.title, 'Exit in jump range');
			assert.strictEqual(t.text, 'Amamake (0.4) is ' + jumpRange.formatLy(4.23) + ' from your start Hek and 1 more: a Carrier (JDC V, ' + jumpRange.formatLy(7) + ') can jump there');
			assert.ok(/from Hek \(another exit of the chain\)/.test(ca.capText(LS, [{ id: sid('Hek'), start: false, ly: 4 }], 'Carrier', 5, 7, S).text));
		});
	});

	it('keeps the last shown static stages', () => {
		assert.deepStrictEqual(ca.trim({ a: true, b: true, c: true }, 2), { b: true, c: true });
	});
});
