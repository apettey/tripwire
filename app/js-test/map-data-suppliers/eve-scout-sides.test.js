// Fork-owned: which end of an EVE-Scout connection each signature ID and hole type belongs to.
//
// EVE-Scout (api.eve-scout.com/v2/public/signatures, OpenAPI schema signature_representation.yaml):
//   out_system_id / out_signature: the hub being scanned (Thera or Turnur) and the signature in it
//   in_system_id / in_signature:   the system on the other side and the signature there
//   wh_exits_outward: true = wh_type is on the hub side and K162 on the other side; false = the reverse
//
// Tripwire's chain map (chain-map.js, own wormholes) puts the signature in the parent system on node.child
// (the child node's label: "what to warp to from here") and the far signature on node.parent. Each side's
// signatureID and type must describe the same physical signature.
const assert = require('assert');
const { include, fakeAjax } = require('../helpers/helpers');

if (typeof eveScout === 'undefined') { fakeAjax(); include('app/js/map-data-suppliers/eve-scout'); }

const THERA = 31000005, TURNUR = 30002086, KHERAM = 30003486, RETEKA = 30003880, RIMBAH = 30002241, J132401 = 31000598;

// Records in the live API's shape
function record(fields) {
	return Object.assign({
		created_at: '2026-10-11T00:10:00.000Z', created_by_id: 1, created_by_name: 'Scout',
		updated_at: '2026-10-11T00:15:00.000Z', updated_by_id: 1, updated_by_name: 'Scout',
		completed_at: '2026-10-11T00:15:00.000Z', completed_by_id: 1, completed_by_name: 'Scout', completed: true,
		expires_at: '2026-10-12T00:10:00.000Z', remaining_hours: 15, signature_type: 'wormhole', max_ship_size: 'xlarge',
	}, fields);
}
const theraKheram = record({ id: '90001', wh_exits_outward: true, wh_type: 'V898',
	out_system_id: THERA, out_system_name: 'Thera', out_signature: 'AOX-264',
	in_system_id: KHERAM, in_system_class: 'ls', in_system_name: 'Kheram', in_region_id: 10000043, in_region_name: 'Domain', in_signature: 'CVD-320' });
const theraReteka = record({ id: '90002', wh_exits_outward: false, wh_type: 'T458', remaining_hours: 3, max_ship_size: 'medium',
	out_system_id: THERA, out_system_name: 'Thera', out_signature: 'IFN-322',
	in_system_id: RETEKA, in_system_class: 'hs', in_system_name: 'Reteka', in_region_id: 10000049, in_region_name: 'Khanid', in_signature: 'TVK-336' });
const turnurRimbah = record({ id: '90003', wh_exits_outward: true, wh_type: 'N944', max_ship_size: 'capital',
	out_system_id: TURNUR, out_system_name: 'Turnur', out_signature: 'KAN-600',
	in_system_id: RIMBAH, in_system_class: 'ls', in_system_name: 'Rimbah', in_region_id: 10000043, in_region_name: 'Domain', in_signature: 'SCG-400' });
const turnurJ132401 = record({ id: '90004', wh_exits_outward: false, wh_type: 'J377', max_ship_size: 'medium',
	out_system_id: TURNUR, out_system_name: 'Turnur', out_signature: 'UPE-312',
	in_system_id: J132401, in_system_class: 'c2', in_system_name: 'J132401', in_region_id: 11000006, in_region_name: 'B-R00006', in_signature: 'KYY-030' });
const all = [theraKheram, theraReteka, turnurRimbah, turnurJ132401];

describe('EVE-Scout connection sides (signature ID and type per end)', () => {
	let ids;
	beforeEach(() => {
		options = { chain: { tabs: [ { evescout: true } ], active: 0 } };
		eveScout.links = all;
		ids = { parentID: 100, nextChildID: 200 };
	});

	/** [our signature, far signature] as { signatureID, type } */
	function sides(systemID) {
		const r = eveScout.findLinks(systemID, ids);
		assert.equal(r.length, 1, 'one connection');
		assert.equal(r[0].parent.systemID, systemID, 'parent is our system');
		return [
			{ signatureID: r[0].child.signatureID, type: r[0].child.type },
			{ signatureID: r[0].parent.signatureID, type: r[0].parent.type },
		];
	}

	it('in Thera, hole type on the Thera side (wh_exits_outward)', () => {
		assert.deepEqual(eveScout.findLinks(THERA, ids).map(l => l.id), ['ES-90001', 'ES-90002']);
		ids = { parentID: 100, nextChildID: 200 };
		eveScout.links = [theraKheram];
		const [ours, far] = sides(THERA);
		assert.deepEqual(ours, { signatureID: 'AOX-264', type: 'V898' });
		assert.deepEqual(far, { signatureID: 'CVD-320', type: 'K162' });
	});

	it('in Thera, K162 on the Thera side', () => {
		eveScout.links = [theraReteka];
		const [ours, far] = sides(THERA);
		assert.deepEqual(ours, { signatureID: 'IFN-322', type: 'K162' });
		assert.deepEqual(far, { signatureID: 'TVK-336', type: 'T458' });
	});

	it('in the system on the far end of a Thera hole', () => {
		const [ours, far] = sides(KHERAM);
		assert.deepEqual(ours, { signatureID: 'CVD-320', type: 'K162' });
		assert.deepEqual(far, { signatureID: 'AOX-264', type: 'V898' });
	});

	it('in Turnur, hole type on the Turnur side', () => {
		eveScout.links = [turnurRimbah];
		const [ours, far] = sides(TURNUR);
		assert.deepEqual(ours, { signatureID: 'KAN-600', type: 'N944' });
		assert.deepEqual(far, { signatureID: 'SCG-400', type: 'K162' });
	});

	it('in the system on the far end of a Turnur hole (hole type on our side)', () => {
		const [ours, far] = sides(J132401);
		assert.deepEqual(ours, { signatureID: 'KYY-030', type: 'J377' });
		assert.deepEqual(far, { signatureID: 'UPE-312', type: 'K162' });
	});

	it('every end pairs each signature ID with that signature\'s own type', () => {
		all.forEach(rec => {
			const typeOf = {};
			typeOf[rec.out_signature] = rec.wh_exits_outward ? rec.wh_type : 'K162';
			typeOf[rec.in_signature] = rec.wh_exits_outward ? 'K162' : rec.wh_type;
			const sigIn = {};
			sigIn[rec.out_system_id] = rec.out_signature;
			sigIn[rec.in_system_id] = rec.in_signature;
			[rec.out_system_id, rec.in_system_id].forEach(systemID => {
				eveScout.links = [rec];
				const link = eveScout.findLinks(systemID, { parentID: 1, nextChildID: 2 })[0];
				const other = systemID == rec.out_system_id ? rec.in_system_id : rec.out_system_id;
				assert.equal(link.child.systemID, other, rec.id + ' child system');
				assert.equal(link.child.signatureID, sigIn[systemID], rec.id + ' child shows the signature in ' + systemID);
				assert.equal(link.parent.signatureID, sigIn[other], rec.id + ' parent carries the far signature');
				assert.equal(link.child.type, typeOf[link.child.signatureID], rec.id + ' child type from ' + systemID);
				assert.equal(link.parent.type, typeOf[link.parent.signatureID], rec.id + ' parent type from ' + systemID);
			});
		});
	});

	it('no connections for an unrelated system', () => {
		assert.deepEqual(eveScout.findLinks(30000142, ids), []);
		assert.deepEqual(ids, { parentID: 100, nextChildID: 200 });
	});
});
