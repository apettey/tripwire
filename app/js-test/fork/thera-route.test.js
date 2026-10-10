const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/rally');
include('app/js/fork/favourites-panel');
include('app/js/fork/autopilot-route');
include('app/js/fork/thera-route');

const tr = theraRoute;
const THERA = 31000005, TURNUR = 30002086;
// A line of high-sec systems A - B - C - D - E - F - G - H (7 gate jumps end to end),
// X: 1 jump from A, Y: 1 jump from H, Z: 1 jump from Turnur, J1: a J-space system
const A = 30000001, B = 30000002, C = 30000003, D = 30000004, E = 30000005, F = 30000006, G = 30000007, H = 30000008,
	X = 30000011, Y = 30000012, Z = 30000013, LOW = 30000014, NUL = 30000015, J1 = 31000100;
const hs = name => ({ name: name, security: 0.9, regionID: 10000001 });
const systems = {
	[A]: hs('A'), [B]: hs('B'), [C]: hs('C'), [D]: hs('D'), [E]: hs('E'), [F]: hs('F'), [G]: hs('G'), [H]: hs('H'),
	[X]: hs('X'), [Y]: hs('Y'), [Z]: hs('Z'), [LOW]: { name: 'LOW', security: 0.3, regionID: 10000001 }, [NUL]: { name: 'NUL', security: -0.2, regionID: 10000001 },
	[TURNUR]: { name: 'Turnur', security: 0.39, regionID: 10000042 },
	[THERA]: { name: 'Thera', security: -0.99, regionID: 11000031, class: 12 },
	[J1]: { name: 'J1', security: -0.99, regionID: 11000001, class: 3 }
};
const gateMap = {};
const gate = (a, b) => {
	(gateMap[a - 30000000] = gateMap[a - 30000000] || {})[b - 30000000] = 1;
	(gateMap[b - 30000000] = gateMap[b - 30000000] || {})[a - 30000000] = 1;
};
[[A, B], [B, C], [C, D], [D, E], [E, F], [F, G], [G, H], [A, X], [H, Y], [TURNUR, Z], [Z, H], [A, LOW], [A, NUL]].forEach(p => gate(p[0], p[1]));
const name = id => (systems[id] || {}).name || String(id);

const NOW = Date.parse('2026-10-10T12:00:00Z');
const hoursFromNow = h => new Date(NOW + h * 3600000).toISOString();
function link(id, hub, other, extra) {
	return Object.assign({
		id: String(id), wh_type: 'Q063', wh_exits_outward: true, max_ship_size: 'large', expires_at: hoursFromNow(10), remaining_hours: 10,
		signature_type: 'wormhole', out_system_id: hub, out_system_name: name(hub), out_signature: 'HUB-' + id,
		in_system_id: other, in_system_name: name(other), in_signature: 'OUT-' + id
	}, extra || {});
}
const L1 = link(1, THERA, X), L2 = link(2, THERA, Y), LT = link(3, TURNUR, LOW);

function route(o) {
	const settings = tr.settings({ theraRoute: o.filters || {} });
	const result = tr.search({
		sources: o.sources || [A], gateMap: gateMap, systems: systems, safe: !!o.safe, ignore: o.ignore || null,
		connections: o.connections || [], links: tr.usableLinks(o.links || [L1, L2], settings, NOW)
	});
	return tr.plan(tr.pathTo(result, o.to || H), o.safe ? 'safe' : 'shortest');
}

describe('Thera route', () => {
	describe('settings', () => {
		it('Defaults', () => assert.deepEqual(tr.settings({}), { thera: true, turnur: true, shipSize: 'S', minHours: 4 }));
		it('No options', () => assert.deepEqual(tr.settings(undefined), tr.DEFAULTS));
		it('Saved values', () => assert.deepEqual(tr.settings({ theraRoute: { thera: false, turnur: true, shipSize: 'L', minHours: 0 } }),
			{ thera: false, turnur: true, shipSize: 'L', minHours: 0 }));
		it('Junk falls back to defaults', () => assert.deepEqual(tr.settings({ theraRoute: { shipSize: 'huge', minHours: 3 } }), tr.DEFAULTS));
		it('anyHub', () => assert.ok(!tr.anyHub(tr.settings({ theraRoute: { thera: false, turnur: false } }))));
	});

	describe('EVE-Scout links', () => {
		it('Hub is the out system', () => assert.equal(tr.hubOf(L1), THERA));
		it('Not a hub', () => assert.equal(tr.hubOf(link(9, X, Y)), null));
		it('Sizes map to the size classes', () => assert.deepEqual(['small', 'medium', 'large', 'xlarge', 'capital', 'odd'].map(s => tr.linkSize({ max_ship_size: s })),
			['S', 'M', 'L', 'VL', 'XL', null]));
		it('Battleship fits a large hole', () => assert.ok(tr.fits({ max_ship_size: 'large' }, 'L')));
		it('Freighter does not fit a large hole', () => assert.ok(!tr.fits({ max_ship_size: 'large' }, 'VL')));
		it('Unknown size: only the smallest ships', () => {
			assert.ok(tr.fits({}, 'S'));
			assert.ok(!tr.fits({}, 'M'));
		});
		it('Life from expires_at', () => assert.equal(tr.hoursLeft({ expires_at: hoursFromNow(2.5), remaining_hours: 7 }, NOW), 2.5));
		it('Life from remaining_hours without expires_at', () => assert.equal(tr.hoursLeft({ remaining_hours: 7 }, NOW), 7));
		it('Life unknown', () => assert.equal(tr.hoursLeft({}, NOW), null));
		it('Life text', () => {
			assert.equal(tr.lifeText({ expires_at: hoursFromNow(7.6) }, NOW), '7h left');
			assert.equal(tr.lifeText({ expires_at: hoursFromNow(3.2) }, NOW), '3h left, EOL');
			assert.equal(tr.lifeText({ expires_at: hoursFromNow(0.5) }, NOW), 'under 1h left, EOL');
		});
		const s = tr.settings({});
		it('Usable by default', () => assert.equal(tr.rejectReason(L1, s, NOW), null));
		it('EOL skipped by default', () => assert.equal(tr.rejectReason(link(5, THERA, X, { expires_at: hoursFromNow(3) }), s, NOW), 'too little life left'));
		it('EOL kept with "Use all"', () => assert.equal(tr.rejectReason(link(5, THERA, X, { expires_at: hoursFromNow(3) }), tr.settings({ theraRoute: { minHours: 0 } }), NOW), null));
		it('Expired always skipped', () => assert.equal(tr.rejectReason(link(5, THERA, X, { expires_at: hoursFromNow(-1) }), tr.settings({ theraRoute: { minHours: 0 } }), NOW), 'expired'));
		it('Unknown life skipped while filtering', () => assert.equal(tr.rejectReason(link(5, THERA, X, { expires_at: null, remaining_hours: null }), s, NOW), 'too little life left'));
		it('Thera off', () => assert.equal(tr.rejectReason(L1, tr.settings({ theraRoute: { thera: false } }), NOW), 'Thera off'));
		it('Turnur off', () => assert.equal(tr.rejectReason(LT, tr.settings({ theraRoute: { turnur: false } }), NOW), 'Turnur off'));
		it('Far side unknown', () => assert.equal(tr.rejectReason(link(5, THERA, null), s, NOW), 'far side unknown'));
		it('usableLinks drops junk', () => assert.deepEqual(tr.usableLinks([L1, null, 'x', link(6, X, Y)], s, NOW), [L1]));
	});

	describe('search', () => {
		it('Thera beats gates', () => {
			const p = route({});
			assert.equal(p.total, 4);
			assert.equal(tr.planText(p), '1g → Thera → 1g');
			assert.deepEqual(p.legs.map(l => l.path), [[A, X], [Y, H]]);
			assert.deepEqual(p.scoutLineIDs, ['ES-1', 'ES-2']);
		});
		it('Gate-only routes are not returned', () => assert.equal(route({ links: [] }), null));
		it('Skipped when the hole is too small', () => assert.equal(route({ filters: { shipSize: 'VL' } }), null));
		it('A big enough hole is used', () => assert.equal(route({ filters: { shipSize: 'L' } }).total, 4));
		it('Skipped when a hole is EOL', () => assert.equal(route({ links: [L1, link(2, THERA, Y, { expires_at: hoursFromNow(2) })] }), null));
		it('Skipped when Thera is off', () => assert.equal(route({ filters: { thera: false } }), null));
		it('Never straight back through the same hole', () => assert.equal(route({ links: [L1] }), null));
		it('Thera in the chain: straight through', () => {
			// J1 (start) has a mapped hole into Thera (chain line 0)
			const p = route({ sources: [J1], connections: [[String(J1), String(THERA), [], 0]], links: [L2] });
			assert.equal(tr.planText(p), '1wh → Thera → 1g');
			assert.deepEqual(p.lineIndexes, [0]);
			assert.deepEqual(p.legs.map(l => l.path), [[Y, H]]);
		});
		it('From the chain: wormhole to an exit, gates, Thera, gates', () => {
			const p = route({ sources: [J1], connections: [[String(J1), String(A), [], 3]] });
			assert.equal(tr.planText(p), '1wh → 1g → Thera → 1g');
			assert.equal(p.total, 5);
			assert.equal(p.holes, 3);
			assert.equal(p.gates, 2);
		});
		it('Starting in Thera', () => assert.equal(tr.planText(route({ sources: [THERA] })), 'Thera → 1g'));
		it('Safe: a low-sec Thera system is not gated through', () => {
			const lowX = link(1, THERA, LOW);
			assert.equal(tr.planText(route({ links: [lowX, L2] })), '1g → Thera → 1g');
			assert.equal(route({ links: [lowX, L2], safe: true }), null);
		});
		it('Safe: low-sec start is fine', () => assert.equal(tr.planText(route({ sources: [LOW], links: [link(1, THERA, LOW), L2], safe: true })), 'Thera → 1g'));
		it('Safe: low-sec destination is fine', () => {
			assert.equal(tr.planText(route({ sources: [H], links: [link(2, THERA, Y), link(1, THERA, X)], to: LOW, safe: true })), '1g → Thera → 2g');
		});
		it('Destination rule from the K-space route selection', () => assert.deepEqual(
			['shortest', 'highsec', 'avoid-null', 'avoid-high', 'odd', undefined].map(tr.destinationRule), [false, 'highsec', 'avoid-null', 'avoid-high', false, false]));
		it('Avoid NS: a null-sec Thera system is not gated through', () => {
			const nul = link(1, THERA, NUL);
			assert.equal(tr.planText(route({ links: [nul, L2] })), '1g → Thera → 1g');
			const r = tr.search({ sources: [A], gateMap: gateMap, systems: systems, safe: 'avoid-null', connections: [], links: [nul, L2] });
			assert.equal(tr.pathTo(r, H), null);
		});
		it('Avoid HS: high-sec systems are not gated through', () => {
			const r = tr.search({ sources: [A], gateMap: gateMap, systems: systems, safe: 'avoid-high', connections: [], links: [L1, L2] });
			assert.equal(tr.pathTo(r, H), null);
			const low = tr.search({ sources: [A], gateMap: gateMap, systems: systems, safe: 'avoid-high', connections: [], links: [link(1, THERA, LOW), link(2, THERA, Y)] });
			assert.equal(tr.planText(tr.plan(tr.pathTo(low, Y), 'avoid-high')), '1g → Thera');
		});
		it('Prefer HS is the high-sec rule', () => {
			const r = tr.search({ sources: [A], gateMap: gateMap, systems: systems, safe: 'highsec', connections: [], links: [link(1, THERA, LOW), L2] });
			assert.equal(tr.pathTo(r, H), null);
		});
		it('Avoid list: never gated through', () => assert.equal(route({ ignore: { x: true } }), null));
		it('Turnur: in by its hole, out by gates', () => {
			const p = route({ sources: [LOW], links: [LT], to: H });
			assert.equal(tr.planText(p), 'Turnur → 2g');
			assert.deepEqual(p.legs[0].path, [TURNUR, Z, H]);
		});
		it('Turnur is low-sec: not gated out of in safe mode', () => assert.equal(route({ sources: [LOW], links: [LT], to: H, safe: true }), null));
		it('Ties go to fewer wormholes', () => {
			// Two ways of 4 jumps: A to X by gate, or by a (mapped) wormhole
			const p = route({ sources: [A], connections: [[String(A), String(X), [], 0]] });
			assert.equal(p.total, 4);
			assert.deepEqual(p.lineIndexes, []);
		});
	});

	describe('texts', () => {
		const p = route({});
		it('Detail names the systems, signatures and holes', () => assert.equal(tr.planDetail(p, 'H', name, NOW),
			'1g → Thera → 1g (1 gate jump to X, in X warp to OUT-1 into Thera (Q063, max large, 10h left), '
			+ 'in Thera warp to HUB-2 to Y (Q063, max large, 10h left), 1 gate jump to H)'));
		it('Line names the in and out systems with the signatures', () => assert.equal(tr.lineText(p, name), 'X OUT-1 → Thera HUB-2 → Y'));
		it('Line for a Turnur exit by gates', () => assert.equal(tr.lineText(route({ sources: [LOW], links: [LT] }), name), 'LOW OUT-3 → Turnur'));
		it('better(): fewer jumps wins', () => assert.ok(tr.better({ status: 'ok', total: 7 }, p)));
		it('better(): a tie keeps the other route', () => assert.ok(!tr.better({ status: 'ok', total: 4 }, p)));
		it('better(): no other route', () => assert.ok(tr.better({ status: 'no-route' }, p)));
		it('better(): never instead of "here"', () => assert.ok(!tr.better({ status: 'here' }, p)));
		it('better(): no scout route', () => assert.ok(!tr.better({ status: 'no-route' }, null)));
	});

	describe('gate legs for Set route in game', () => {
		const legs = tr.gateLegs(route({ sources: [J1], connections: [[String(J1), String(A), [], 3]] }));
		it('Two legs, before and after Thera', () => {
			assert.equal(legs.length, 2);
			assert.deepEqual(legs[0].after, { chain: true });
			assert.deepEqual(legs[0].before, { hub: THERA });
			assert.deepEqual(legs[1].after, { hub: THERA });
			assert.equal(legs[1].before, null);
		});
		it('Leg 1 title', () => assert.equal(tr.legTitle(legs[0], name),
			'Set route in game, leg 1 of 2: the gates from A to X (1 jump) as autopilot waypoints. Take the wormholes to A yourself. '
			+ 'Then take the Thera hole in X yourself and send leg 2 after it.'));
		it('Leg 2 title', () => assert.equal(tr.legTitle(legs[1], name),
			'Set route in game, leg 2 of 2: the gates from Y to H (1 jump) as autopilot waypoints. Send it once you are out of Thera in Y: '
			+ 'the autopilot can\'t route through wormholes.'));
		it('Turnur leg starts in Turnur', () => assert.ok(tr.legTitle(tr.gateLegs(route({ sources: [LOW], links: [LT] }))[0], name)
			.indexOf('Send it once you are in Turnur') >= 0));
		it('autopilotRoute.scoutLeg', () => {
			const p = route({});
			assert.deepEqual(autopilotRoute.scoutLeg(p, 1), { path: [Y, H], from: Y, to: H });
			assert.equal(autopilotRoute.scoutLeg(p, 5).error, 'No such leg');
			assert.equal(autopilotRoute.scoutLeg({ status: 'ok', kind: 'chain' }, 0).error, 'No route');
		});
	});

	describe('Favourites panel', () => {
		// Chain: J1 (you) - A (k-space exit); favourite H is 7 gates from A, or 1g + Thera + 1g
		const rows = [
			{ c: [{ v: 1, systemID: J1, f: "<div class='node '></div>" }, { v: null }] },
			{ c: [{ v: 2, systemID: A, f: "<div class='node '></div>" }, { v: 1 }], pathHome: [{ systemID: J1 }, { systemID: A }] },
			{ c: [{ v: 3, systemID: THERA, f: "<div class='node '></div>" }, { v: 1 }], pathHome: [{ systemID: J1 }, { systemID: THERA }] }
		];
		const lines = [[2, 1, [], 10], [3, 1, [], 'ES-77']];
		const distances = (id, safe) => fp.gateDistances(gateMap, systems, id, safe, null);
		const fp = favouritesPanel;
		const scout = (ctx, favID, mode) => tr.plan(tr.pathTo(tr.search({ sources: [ctx.start], gateMap: gateMap, systems: systems, safe: mode === 'safe',
			connections: ctx.connections, links: [L1, L2] }), favID), mode);
		it('EVE-Scout lines on the chain are not chain wormholes', () => {
			const ctx = fp.context({ map: { rows: rows }, lines: lines }, J1, [], distances, systems, null, true);
			assert.deepEqual(ctx.connections.map(c => c[3]), [0]);
		});
		it('Thera/Turnur routes off: EVE-Scout lines stay chain wormholes, as before', () => {
			const ctx = fp.context({ map: { rows: rows }, lines: lines }, J1, [], distances, systems, null);
			assert.deepEqual(ctx.connections.map(c => c[3]), [0, 1]);
		});
		it('Uses the Thera route when shorter, and highlights its chain wormholes', () => {
			const result = { map: { rows: JSON.parse(JSON.stringify(rows)) }, lines: JSON.parse(JSON.stringify(lines)) };
			const routes = fp.decorate(result, [{ systemID: H, mode: 'shortest' }], J1, [{ systemID: A, nodeID: 2 }], distances, systems, null, scout);
			assert.equal(routes[H].shortest.kind, 'scout');
			assert.equal(fp.planText(routes[H].shortest), '1wh → 1g → Thera → 1g');
			assert.ok(result.lines[0][2].indexOf(fp.ROUTE_CLASS) >= 0);
			assert.ok(fp.planDetail(routes[H].shortest, 'H', name).indexOf('warp to OUT-1 into Thera') >= 0);
		});
		it('Keeps the chain route without a scout function', () => {
			const result = { map: { rows: JSON.parse(JSON.stringify(rows)) }, lines: JSON.parse(JSON.stringify(lines)) };
			const routes = fp.decorate(result, [{ systemID: H, mode: 'shortest' }], J1, [{ systemID: A, nodeID: 2 }], distances, systems, null);
			assert.equal(fp.planText(routes[H].shortest), '1wh → 7g');
		});
	});
});
